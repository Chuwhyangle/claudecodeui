/**
 * Criterion for the resident host's reconcile loop and its §10.2 log lines
 * (AC-390, SPEC §10.1, §10.2, §12 S5).
 *
 * WHAT THIS FILE IS FOR. The ledger (S1) made a resident session's state
 * derivable, and the run registry holds the runs. Neither reads the other, and
 * the 2026-10-14 defect (`fdd3e920`) sat exactly in the gap: a run the registry
 * still held as `running` for a session whose ledger had stopped moving, with no
 * later frame able to close either. §10.1's answer is a reconcile check over the
 * two readings, and this criterion is that check's reading.
 *
 * THREE LINE FAMILIES, ONE READING EACH (§10.2), all of them with `session=`:
 *
 *   · `[reconcile] … mode=<log|enforce> anomaly=<code>` — the anomaly, written
 *     wherever the ledger records one (four codes reach it that way) or by the
 *     reconcile check itself (`phantom-run`).
 *   · `[ledger] … delivery=<8> state=<s> turn=<8|-> source=<…>` — one per
 *     DELIVERY whose state moved.
 *   · `[turn] … turn=<id> kind=<…> open|close …` — one per turn that opened and
 *     one per turn that closed.
 *
 * HOW IT IS DRIVEN. A REAL `ClaudeResidentHostDriver` over a REAL session-host
 * manager and a scripted process (the injected `createProcess` seam), with the
 * three things a reconcile reading needs injected: the clock, the run registry
 * PORT (`connectedClientCount` is the precedent — the registry lives in the
 * websocket module, which imports this one, so the edge cannot be an import),
 * and the log sink. No real `claude` binary is started and no service is
 * restarted.
 *
 * THE FALSE FORM (AC (f)), and why leg (c) is the leg that carries it:
 *
 *   Remove ONE condition from the reconcile check — the "a turn is open, so
 *   nothing here is phantom" guard — leaving "the registry says a run is going
 *   and the ledger has stood still past `T_q`". Leg (c) then closes a REAL turn
 *   that is in flight: `longTurnClosed=true` where it must read `false`, and its
 *   `turn` lease disappears. That is over-settlement, the thing §10.1 forbids
 *   ("不用 lease 定时过期来「修」：那会结算真正在跑的 turn"). No other leg reds
 *   under that mutant — (a) and (b) inject a divergence with NO turn open, and
 *   (d)/(e) inject no registry run at all — so the red names the defect rather
 *   than a neighbour. Every reading is collected and printed before anything is
 *   asserted, so a red lands on the wrong reading and not on a timeout.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, as in the sibling resident criteria.
 * - `T_q` and `T_int` are injected (200 ms / 50 ms), so no leg pays the shipped
 *   ten seconds of wall clock; every reading taken across a deadline is the line
 *   it produced, never the wait.
 * - Nothing here reads a private field: the readings come from the driver's own
 *   `reconcileTick` / `ledgerReading`, from the manager's lease projection, from
 *   the injected registry port, and from the lines the driver handed the sink.
 *
 * Run with this repo's TS-ESM test entrypoint:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/providers/tests/claude-resident-reconcile.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import util from 'node:util';

import { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeResidentReconcileMode,
  ClaudeResidentReconcileReading,
  ClaudeResidentRunRegistryPort,
  ClaudeResidentRunningRun,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type {
  AnyRecord,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/**
 * The wall-clock bound this criterion reports the whole run against (AC (g): < 50s).
 *
 * Every leg drives an injected clock, so nothing here waits ten seconds for a
 * deadline that the production configuration would take ten seconds to reach.
 */
const RUN_BUDGET_MS = 50_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the reconcile criterion did not finish ` +
      `inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, RUN_BUDGET_MS - 1_000);
budgetGuard.unref();

/** The pid the scripted seam reports; it is read and never acted on. */
const PROCESS_PID = 4242;

/** The whole clock these legs drive: `T_q` and the lease readings both read it. */
const CLOCK_START = 1_700_000_000_000;

/** `T_q`, injected small: the deadline is reached by a number, not by a wait. */
const T_Q_MS = 200;

/** `T_int`, injected small: the unanswered-interrupt deadline costs no wall clock. */
const T_INT_MS = 50;

/** How long a leg waits past `T_int` before reading the line the deadline writes. */
const PAST_T_INT_MS = T_INT_MS * 4;

// ---------------------------------------------------------------------------
// stdout, teed
// ---------------------------------------------------------------------------

/**
 * Every line written to stdout, teed out of `console.log`.
 *
 * A tee rather than a redirect, because stdout IS the reconcile line's channel:
 * §10.2 is the operator's reading of an anomaly, and the `[reconcile]` family has
 * been on stdout since S1 (`claude-resident-interrupt-ledger.test.ts` reads it
 * there). Reading it from the tee is therefore a reading of the SHIPPED channel
 * rather than of the sink the criterion also installs.
 */
const stdoutLines: string[] = [];
{
  const original = console.log.bind(console) as (...data: unknown[]) => void;
  const tee = (...data: unknown[]): void => {
    stdoutLines.push(util.format(...data));
    original(...data);
  };
  console.log = tee as typeof console.log;
}

/** The `[reconcile]` stdout lines one session got for one anomaly code. */
function reconcileLines(sessionId: string, code: string): string[] {
  const prefix = `[reconcile] session=${sessionId} `;
  return stdoutLines.filter((line) => line.startsWith(prefix) && line.includes(` anomaly=${code} `));
}

/** The same reading, taken from the injected sink instead of stdout. */
function reconcileSinkLines(lines: readonly string[], sessionId: string, code: string): string[] {
  const prefix = `[reconcile] session=${sessionId} `;
  return lines.filter((line) => line.startsWith(prefix) && line.includes(` anomaly=${code} `));
}

/** The `[ledger]` / `[turn]` lines one session's sink collected, by family. */
function familyLines(lines: readonly string[], sessionId: string, family: 'ledger' | 'turn'): string[] {
  const prefix = `[${family}] session=${sessionId} `;
  return lines.filter((line) => line.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// The scripted process
// ---------------------------------------------------------------------------

/**
 * A resident process the criterion owns: a stream it pushes into, in order.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every reading
 * into a reading of a dead process.
 */
function createFakeProcess(): { factory: ClaudeResidentProcessFactory; emit(frame: AnyRecord): void } {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];

  const push = (frame: AnyRecord): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    pending.push(frame);
  };

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
      });
    },
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  return {
    factory: () => ({ query, pid: PROCESS_PID }) satisfies ClaudeResidentProcess,
    emit: push,
  };
}

/** A scheduler whose deadlines never fire: these legs are not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/** The runtime's own turn inputs, stubbed to the facts these legs' driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

/** A writer that records every frame it is handed, so a run's `complete` is countable. */
function createRecordingWriter(): { writer: ProviderRuntimeWriter; frames: AnyRecord[] } {
  const frames: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (message) => {
      frames.push(message as AnyRecord);
    },
    setSessionId: () => undefined,
    userId: 1,
  };
  return { writer, frames };
}

/** The turn's `system/init`, as the CLI announces it. */
function initFrame(uuid: string): AnyRecord {
  return { type: 'system', subtype: 'init', uuid };
}

/** The turn's terminal `result`. */
function resultFrame(isError = false): AnyRecord {
  return { type: 'result', subtype: 'success', is_error: isError };
}

/** The CLI's own account of one command's lifecycle. */
function lifecycleFrame(commandUuid: string, state: string): AnyRecord {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state };
}

/** The turn-bearing frame §5.2 names, arriving when no turn is open. */
function assistantFrame(uuid: string): AnyRecord {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 200; hop += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// The injected run registry
// ---------------------------------------------------------------------------

type FakeRegistry = {
  port: ClaudeResidentRunRegistryPort;
  /** The runs it currently holds as `running` — §10.1's left-hand reading. */
  runs(): readonly ClaudeResidentRunningRun[];
  /** Every close it was asked for, in order. */
  closes(): ReadonlyArray<{ runId: string; outcome: 'aborted'; reason: string }>;
  add(sessionId: string, runId: string): void;
};

/**
 * The registry, as the driver may read and act on it.
 *
 * A stand-in rather than the real registry because the real one lives in the
 * websocket module and cannot be imported from here by the driver — that is the
 * whole reason the reading is a port. What the stand-in has to be faithful about
 * is the two verbs' contract: `runningRuns` answers what is still `running`, and
 * `closeRun` is the ONLY thing that changes that answer, which is what makes the
 * `runsBefore`/`runsAfter` reading a reading of `mode` rather than of the fake.
 */
function createFakeRegistry(): FakeRegistry {
  const running = new Map<string, ClaudeResidentRunningRun>();
  const closes: Array<{ runId: string; outcome: 'aborted'; reason: string }> = [];
  return {
    port: {
      runningRuns: () => [...running.values()],
      closeRun: (input) => {
        closes.push({ runId: input.runId, outcome: input.outcome, reason: input.reason });
        running.delete(input.runId);
      },
    },
    runs: () => [...running.values()],
    closes: () => closes,
    add: (sessionId, runId) => {
      running.set(runId, { sessionId, runId });
    },
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  sessionId: string;
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: { emit(frame: AnyRecord): void };
  registry: FakeRegistry;
  /** Every line the driver handed the injected sink, in order. */
  lines: string[];
  /** Moves the injected clock every reader in this leg shares. */
  advance(ms: number): void;
  /** The `run` promises armed so far, for the settle at the end of a leg. */
  rounds: Promise<void>[];
};

type HarnessOptions = {
  sessionId: string;
  mode?: ClaudeResidentReconcileMode;
  reconcile?: boolean;
};

/**
 * Builds one leg: a real driver over a scripted process, a real manager, and the
 * three injected readings the reconcile check is built around.
 *
 * `reconcile: false` leaves the run registry un-injected — the shipped default
 * for a process that never bound the seam — which is the negative reading the
 * §10.2 legs take: lines must appear with no registry involved at all.
 */
function createHarness(options: HarnessOptions): Harness {
  // One clock per leg, shared by the manager and the driver, so "the ledger has
  // stood still past T_q" is one statement rather than two clocks' agreement.
  let nowMs = CLOCK_START;
  const manager = createSessionHostManager({ now: () => nowMs, scheduler: inertScheduler() });
  const process = createFakeProcess();
  const registry = createFakeRegistry();
  const lines: string[] = [];
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => nowMs,
    interruptResultTimeoutMs: T_INT_MS,
    reconcileMode: options.mode ?? 'log',
    quiesceMs: T_Q_MS,
    ...(options.reconcile === false ? {} : { runRegistry: registry.port }),
    logSink: (line) => lines.push(line),
  });

  return {
    sessionId: options.sessionId,
    manager,
    driver,
    process,
    registry,
    lines,
    advance: (ms: number) => {
      nowMs += ms;
    },
    rounds: [],
  };
}

/** The host record the manager opened for this leg's session. */
function hostOf(harness: Harness): ProcessHost {
  const host = harness.manager.snapshot().find((candidate) => candidate.bindings.has(harness.sessionId));
  if (!host) {
    throw new Error('harness: the resident host must be open');
  }
  return host;
}

/** How many `turn` leases the manager is holding for one session's binding. */
function turnLeaseCount(manager: SessionHostManager, sessionId: string): number {
  for (const host of manager.snapshot()) {
    const binding = host.bindings.get(sessionId);
    if (binding) {
      return binding.leases.filter((lease) => lease.kind === 'turn').length;
    }
  }
  return 0;
}

/** Polls the manager's lease reading, letting the async `run` entry make progress. */
async function waitForTurnLeases(
  manager: SessionHostManager,
  sessionId: string,
  count: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (turnLeaseCount(manager, sessionId) >= count) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  return false;
}

/**
 * Arms one cold round and waits for its `turn` lease.
 *
 * The round is NOT awaited: a round settles only once this leg pushes the CLI's
 * frames, so awaiting it here would deadlock. The promise is kept on the harness
 * for the settle at the end.
 */
async function armRound(harness: Harness, command: string, expectedLeases = 1): Promise<void> {
  const writer = createRecordingWriter();
  harness.rounds.push(harness.driver.run(harness.sessionId, { command, options: {} }, writer.writer, CONTEXT));
  assert.ok(
    await waitForTurnLeases(harness.manager, harness.sessionId, expectedLeases, 5_000),
    `the round "${command}" must arm its turn lease (expected ${expectedLeases})`,
  );
}

/**
 * The delivery id of the newest send, read from the driver's own ledger reading.
 *
 * Read rather than remembered from the send: the driver stamps the uuid on the
 * frames it writes to the CLI's stdin, and this side never sees it otherwise —
 * the stream does not echo a pushed uuid. The ledger is where the driver's own
 * account of it lives, and reading it there is what keeps this a reading of the
 * driver rather than a copy of what the criterion hoped it wrote.
 */
function latestDeliveryUuid(harness: Harness): string {
  const deliveries = harness.driver.ledgerReading(harness.sessionId)?.deliveries ?? [];
  const last = deliveries.at(-1);
  assert.ok(last, 'the send must have a ledger record to take its id from');
  return last.deliveryId;
}

/**
 * Ends one leg: closes the host the manager opened, then settles its rounds.
 *
 * Every reading a leg takes is taken and asserted BEFORE this runs — they are
 * readings of the standing state, not of the teardown — and the close is what
 * makes a round that is still in flight (an interrupt nobody answered, a turn
 * that never got its `RESULT`) settle, instead of leaving a promise behind.
 */
async function dispose(harness: Harness): Promise<void> {
  for (const host of harness.manager.snapshot()) {
    if (host.state !== 'closed') {
      harness.manager.closeHost(host.hostId, 'server-shutdown');
    }
  }
  await Promise.allSettled(harness.rounds);
}

// ---------------------------------------------------------------------------
// (a) mode=log names the phantom run and changes nothing
// ---------------------------------------------------------------------------

test('AC390 (a) mode=log: one [reconcile] line for a phantom run, and no state changes', async () => {
  const sessionId = 'ac390-a-log';
  const harness = createHarness({ sessionId, mode: 'log' });

  // The divergence §10.1 is about: a send this host accepted and the CLI never
  // spoke about, so the ledger holds an open run and NO open turn — and the
  // registry (injected) still reports a run for the session.
  await armRound(harness, 'A in flight');
  harness.registry.add(sessionId, 'run-phantom-log');

  const runsBefore = harness.registry.runs().length;
  const leasesBefore = turnLeaseCount(harness.manager, sessionId);

  harness.advance(T_Q_MS * 3);
  const readings: Array<ClaudeResidentReconcileReading | null> = [
    harness.driver.reconcileTick(sessionId),
    harness.driver.reconcileTick(sessionId),
    harness.driver.reconcileTick(sessionId),
  ];

  const runsAfter = harness.registry.runs().length;
  const leasesAfter = turnLeaseCount(harness.manager, sessionId);
  const reconcileLineCount = reconcileLines(sessionId, 'phantom-run').length;
  const sinkLineCount = reconcileSinkLines(harness.lines, sessionId, 'phantom-run').length;
  const firstLine = reconcileLines(sessionId, 'phantom-run')[0] ?? '';
  const firstReading = readings[0];

  console.log(`runsBefore=${runsBefore} runsAfter=${runsAfter} leasesBefore=${leasesBefore} leasesAfter=${leasesAfter}`);
  console.log(
    `reconcileLineCount=${reconcileLineCount} reconcileSinkLineCount=${sinkLineCount} ` +
      `readingMode=${String(firstReading?.mode)} readingAnomaly=${String(firstReading?.anomaly)} ` +
      `closedRuns=${firstReading?.closedRuns.length ?? -1} quiescentMs=${firstReading?.quiescentMs ?? -1} ` +
      `turnOpen=${String(firstReading?.turnOpen)}`,
  );
  console.log(`reconcileLine=${firstLine}`);

  // Readings first, assertions after: a red must land on the wrong reading.
  assert.strictEqual(leasesBefore, 1, `the accepted send must hold its turn lease (read ${leasesBefore})`);
  assert.strictEqual(firstReading?.mode, 'log', 'the shipped arm is the one under test');
  assert.strictEqual(firstReading?.turnOpen, false, 'the ledger has no open turn — that is the divergence');
  assert.strictEqual(firstReading?.quiescentMs, T_Q_MS * 3, 'the ledger stood still past T_q');
  assert.strictEqual(firstReading?.anomaly, 'phantom-run', 'the divergence is named');
  assert.strictEqual(firstReading?.closedRuns.length, 0, 'log mode closes nothing');
  assert.strictEqual(sinkLineCount, 1, `exactly one line reaches the sink (read ${sinkLineCount})`);
  assert.strictEqual(reconcileLineCount, 1, `exactly one line reaches stdout (read ${reconcileLineCount})`);
  assert.match(
    firstLine,
    new RegExp(`^\\[reconcile\\] session=${sessionId} mode=log anomaly=phantom-run( |$)`),
    'the line is §10.2\'s shape at this arm',
  );
  assert.strictEqual(runsBefore, 1, 'the registry reported one running run before the check');
  assert.strictEqual(runsAfter, 1, 'log mode must not change the registry reading');
  assert.strictEqual(leasesAfter, 1, 'log mode must not change the lease reading');

  await dispose(harness);
});

// ---------------------------------------------------------------------------
// (b) mode=enforce closes the phantom run
// ---------------------------------------------------------------------------

test('AC390 (b) mode=enforce: the phantom run is closed aborted/reason=reconciled', async () => {
  const sessionId = 'ac390-b-enforce';
  const harness = createHarness({ sessionId, mode: 'enforce' });

  await armRound(harness, 'A in flight');
  harness.registry.add(sessionId, 'run-phantom-enforce');
  const runsBefore = harness.registry.runs().length;

  harness.advance(T_Q_MS * 3);
  const readings: Array<ClaudeResidentReconcileReading | null> = [
    harness.driver.reconcileTick(sessionId),
    harness.driver.reconcileTick(sessionId),
    harness.driver.reconcileTick(sessionId),
  ];
  const runsAfter = harness.registry.runs().length;
  const close = harness.registry.closes()[0] ?? null;
  const reconcileLineCount = reconcileLines(sessionId, 'phantom-run').length;
  const firstLine = reconcileLines(sessionId, 'phantom-run')[0] ?? '';

  console.log(
    `runsBefore=${runsBefore} runsAfter=${runsAfter} phantomRunOutcome=${String(close?.outcome)} ` +
      `reason=${String(close?.reason)} closes=${harness.registry.closes().length} ` +
      `reconcileLineCount=${reconcileLineCount} readingAnomaly=${String(readings[0]?.anomaly)}`,
  );
  console.log(`reconcileLine=${firstLine}`);

  assert.strictEqual(runsBefore, 1, 'the registry reported one running run before the check');
  assert.strictEqual(readings[0]?.anomaly, 'phantom-run', 'the same divergence is named in enforce mode');
  assert.deepStrictEqual(readings[0]?.closedRuns, ['run-phantom-enforce'], 'the check closed the run it named');
  assert.strictEqual(close?.outcome, 'aborted', 'a reconciled run is closed as aborted');
  assert.strictEqual(close?.reason, 'reconciled', 'and the reason says why (§10.1)');
  assert.strictEqual(harness.registry.closes().length, 1, 'one divergence, one close');
  assert.strictEqual(reconcileLineCount, 1, `exactly one line reaches stdout (read ${reconcileLineCount})`);
  assert.match(
    firstLine,
    new RegExp(`^\\[reconcile\\] session=${sessionId} mode=enforce anomaly=phantom-run( |$)`),
    'the line carries this arm in its mode= field',
  );
  assert.strictEqual(runsAfter, 0, 'the closed run is gone from the registry reading');

  await dispose(harness);
});

// ---------------------------------------------------------------------------
// (c) a real long turn is never closed — the guard §10.1 requires
// ---------------------------------------------------------------------------

test('AC390 (c) a turn in flight is not closed, in either mode, across several beats', async () => {
  type Arm = {
    mode: ClaudeResidentReconcileMode;
    leasesAtOpen: number;
    turnOpen: boolean;
    leasesPerBeat: number[];
    anomalies: Array<string | null>;
    longTurnClosed: boolean;
    phantomLines: number;
  };
  const arms: Arm[] = [];

  for (const mode of ['log', 'enforce'] as const) {
    const sessionId = `ac390-c-${mode}`;
    const harness = createHarness({ sessionId, mode });
    await armRound(harness, 'A long turn');
    harness.process.emit(initFrame(`ac390-init-${mode}`));
    await settle();

    const leasesAtOpen = turnLeaseCount(harness.manager, sessionId);
    const turnOpen = harness.driver.ledgerReading(sessionId)?.turn?.open === true;
    // The divergence's OTHER half, injected: the registry says a run is going for
    // this session. That is what makes the false form bite here — without it the
    // mutant would have nothing to close and this leg would prove nothing.
    harness.registry.add(sessionId, `run-long-${mode}`);

    const leasesPerBeat: number[] = [];
    const anomalies: Array<string | null> = [];
    let longTurnClosed = false;
    for (let beat = 0; beat < 3; beat += 1) {
      harness.advance(T_Q_MS * 2);
      const reading = harness.driver.reconcileTick(sessionId);
      anomalies.push(reading?.anomaly ?? null);
      longTurnClosed = longTurnClosed || (reading?.closedRuns.length ?? 0) > 0;
      leasesPerBeat.push(turnLeaseCount(harness.manager, sessionId));
    }

    arms.push({
      mode,
      leasesAtOpen,
      turnOpen,
      leasesPerBeat,
      anomalies,
      longTurnClosed,
      phantomLines: reconcileLines(sessionId, 'phantom-run').length,
    });

    await dispose(harness);
  }

  console.log(
    `longTurnClosed=${arms[0]?.longTurnClosed} longTurnClosed=${arms[1]?.longTurnClosed} ` +
      `leasesPerBeat=${JSON.stringify(arms.map((arm) => arm.leasesPerBeat))}`,
  );
  for (const arm of arms) {
    console.log(
      `mode=${arm.mode} turnOpen=${arm.turnOpen} leasesAtOpen=${arm.leasesAtOpen} ` +
        `anomalies=${JSON.stringify(arm.anomalies)} phantomLines=${arm.phantomLines} ` +
        `longTurnClosed=${arm.longTurnClosed}`,
    );
  }

  for (const arm of arms) {
    assert.strictEqual(arm.turnOpen, true, `${arm.mode}: the ledger must have a turn open — a turn is running`);
    assert.strictEqual(arm.leasesAtOpen, 1, `${arm.mode}: the running turn holds its lease (read ${arm.leasesAtOpen})`);
    assert.deepStrictEqual(
      arm.anomalies,
      [null, null, null],
      `${arm.mode}: a long turn is not a divergence, on any beat (read ${JSON.stringify(arm.anomalies)})`,
    );
    assert.strictEqual(arm.phantomLines, 0, `${arm.mode}: no beat may name a phantom run (read ${arm.phantomLines})`);
    assert.deepStrictEqual(
      arm.leasesPerBeat,
      [1, 1, 1],
      `${arm.mode}: the lease must survive every beat (read ${JSON.stringify(arm.leasesPerBeat)})`,
    );
    assert.strictEqual(
      arm.longTurnClosed,
      false,
      `${arm.mode}: over-settlement — a turn that is running must never be closed by the reconciler`,
    );
  }
});

// ---------------------------------------------------------------------------
// (d) the other four codes, one line each
// ---------------------------------------------------------------------------

/** The reading one code's leg took. */
type CodeReading = { code: string; lineCount: number; sinkLineCount: number; firstLine: string };

function readCode(sessionId: string, lines: readonly string[], code: string): CodeReading {
  const inSink = reconcileSinkLines(lines, sessionId, code);
  return {
    code,
    lineCount: reconcileLines(sessionId, code).length,
    sinkLineCount: inSink.length,
    firstLine: inSink[0] ?? reconcileLines(sessionId, code)[0] ?? '',
  };
}

test('AC390 (d) owed-terminal-missing: a delivery that reached the next boundary with no terminal', async () => {
  const sessionId = 'ac390-d-owed';
  const harness = createHarness({ sessionId });
  await armRound(harness, 'A owed');
  harness.process.emit(initFrame('ac390-owed-init'));
  await settle();
  // A second send while the first turn is in flight: its `started` is the next
  // BOUNDARY (I4), which is where an owed delivery is reconciled.
  await armRound(harness, 'B boundary', 2);
  const bUuid = latestDeliveryUuid(harness);
  harness.process.emit(resultFrame());
  await settle();
  harness.process.emit(lifecycleFrame(bUuid, 'started'));
  await settle();

  const reading = readCode(sessionId, harness.lines, 'owed-terminal-missing');
  console.log(`code=${reading.code} lineCount=${reading.lineCount} sinkLineCount=${reading.sinkLineCount}`);
  console.log(`codeLine=${reading.firstLine}`);

  assert.strictEqual(reading.lineCount, 1, `exactly one line for owed-terminal-missing (read ${reading.lineCount})`);
  assert.strictEqual(reading.sinkLineCount, 1, 'and the sink saw the same one');
  assert.match(
    reading.firstLine,
    new RegExp(`^\\[reconcile\\] session=${sessionId} .* anomaly=owed-terminal-missing( |$)`),
    'the code is §10.1\'s, verbatim, on a §10.2 line',
  );

  await dispose(harness);
});

test('AC390 (d) double-init: a second init before the first turn ended', async () => {
  const sessionId = 'ac390-d-double-init';
  const harness = createHarness({ sessionId });
  await armRound(harness, 'A double init');
  harness.process.emit(initFrame('ac390-double-init-1'));
  await settle();
  harness.process.emit(initFrame('ac390-double-init-2'));
  await settle();

  const reading = readCode(sessionId, harness.lines, 'double-init');
  console.log(`code=${reading.code} lineCount=${reading.lineCount} sinkLineCount=${reading.sinkLineCount}`);
  console.log(`codeLine=${reading.firstLine}`);

  assert.strictEqual(reading.lineCount, 1, `exactly one line for double-init (read ${reading.lineCount})`);
  assert.match(
    reading.firstLine,
    new RegExp(`^\\[reconcile\\] session=${sessionId} .* anomaly=double-init( |$)`),
    'the code is §10.1\'s, verbatim',
  );

  await dispose(harness);
});

test('AC390 (d) interrupt-no-result: an interrupt the CLI never answers inside T_int', async () => {
  const sessionId = 'ac390-d-interrupt';
  const harness = createHarness({ sessionId });
  await armRound(harness, 'A interrupted');
  harness.process.emit(initFrame('ac390-interrupt-init'));
  await settle();
  const stopped = await harness.driver.interrupt(hostOf(harness), sessionId);
  await settle();
  await new Promise((resolve) => { setTimeout(resolve, PAST_T_INT_MS); });

  const reading = readCode(sessionId, harness.lines, 'interrupt-no-result');
  console.log(
    `code=${reading.code} lineCount=${reading.lineCount} sinkLineCount=${reading.sinkLineCount} ` +
      `interruptPlaced=${stopped} tIntMs=${T_INT_MS}`,
  );
  console.log(`codeLine=${reading.firstLine}`);

  assert.strictEqual(stopped, true, 'the interrupt must have been placed on the turn in flight');
  assert.strictEqual(reading.lineCount, 1, `exactly one line for interrupt-no-result (read ${reading.lineCount})`);
  assert.match(
    reading.firstLine,
    new RegExp(`^\\[reconcile\\] session=${sessionId} .* anomaly=interrupt-no-result( |$)`),
    'the code is §6.3\'s, verbatim',
  );

  await dispose(harness);
});

test('AC390 (d) frame-without-turn: a turn-bearing frame that belongs to no turn', async () => {
  const sessionId = 'ac390-d-frame';
  const harness = createHarness({ sessionId });
  await armRound(harness, 'A frame');
  harness.process.emit(initFrame('ac390-frame-init'));
  await settle();
  harness.process.emit(resultFrame());
  await settle();
  // §5.2's case: the assistant's own frame arriving with no turn open.
  harness.process.emit(assistantFrame('ac390-frame-assistant'));
  await settle();

  const reading = readCode(sessionId, harness.lines, 'frame-without-turn');
  const turnOpenAfter = harness.driver.ledgerReading(sessionId)?.turn?.open ?? true;
  console.log(
    `code=${reading.code} lineCount=${reading.lineCount} sinkLineCount=${reading.sinkLineCount} ` +
      `turnOpenWhenRead=${String(turnOpenAfter)}`,
  );
  console.log(`codeLine=${reading.firstLine}`);

  assert.strictEqual(turnOpenAfter, false, 'the frame really arrived with no turn open');
  assert.strictEqual(reading.lineCount, 1, `exactly one line for frame-without-turn (read ${reading.lineCount})`);
  assert.match(
    reading.firstLine,
    new RegExp(`^\\[reconcile\\] session=${sessionId} .* anomaly=frame-without-turn( |$)`),
    'the code is §5.2\'s, verbatim',
  );

  await dispose(harness);
});

// ---------------------------------------------------------------------------
// (e1) the registry's forwarded line carries session=
// ---------------------------------------------------------------------------

test('AC390 (e1) command_lifecycle forwarded carries session=', async () => {
  const { createChatRunRegistry } = await import('@/modules/websocket/index.js');
  const sessionId = 'ac390-e1-registry-session';
  const collected: Array<{
    commandUuid: string;
    commandState: string;
    runId: string;
    connections: number;
    appSessionId: string;
  }> = [];
  const registry = createChatRunRegistry({ lifecycleLog: (line) => collected.push(line) });
  const run = registry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(run, 'the registry must open a run for the forwarded frame');

  // One `command_lifecycle` frame through the run's writer: the same path the
  // production registry logs.
  run.writer.send({ kind: 'command_lifecycle', commandUuid: 'e1-command', commandState: 'queued', sessionId });

  const entry = collected[0] ?? null;
  const line = entry
    ? `[ChatRunRegistry] command_lifecycle forwarded uuid=${entry.commandUuid} state=${entry.commandState} ` +
      `runId=${entry.runId} connections=${entry.connections} session=${entry.appSessionId}`
    : '';
  console.log(`forwardedLines=${collected.length} line=${line}`);

  assert.strictEqual(collected.length, 1, `one frame, one line (read ${collected.length})`);
  assert.strictEqual(entry?.appSessionId, sessionId, 'the line record carries the app session id');
  assert.match(line, new RegExp(`session=${sessionId}( |$)`), 'and the line states it as session=');
  assert.match(
    line,
    /^\[ChatRunRegistry\] command_lifecycle forwarded uuid=\S+ state=\S+ runId=\S+ connections=\d+ session=\S+$/,
    'the production line shape is unchanged apart from the added field',
  );
});

// ---------------------------------------------------------------------------
// (e2) [ledger] / [turn]: exactly one line per transition
// ---------------------------------------------------------------------------

test('AC390 (e2) [ledger] and [turn]: one line per transition, each carrying session=', async () => {
  const sessionId = 'ac390-e2-lines';
  const harness = createHarness({ sessionId, reconcile: false });
  await armRound(harness, 'A one turn');
  const aUuid = latestDeliveryUuid(harness);
  harness.process.emit(initFrame('ac390-e2-init'));
  await settle();
  const leasesAfterOpen = turnLeaseCount(harness.manager, sessionId);
  harness.process.emit(lifecycleFrame(aUuid, 'started'));
  await settle();
  harness.process.emit(lifecycleFrame(aUuid, 'completed'));
  await settle();
  const leasesBeforeResult = turnLeaseCount(harness.manager, sessionId);
  harness.process.emit(resultFrame());
  await settle();
  const leasesAfterResult = turnLeaseCount(harness.manager, sessionId);

  const ledger = familyLines(harness.lines, sessionId, 'ledger');
  const turnLines = familyLines(harness.lines, sessionId, 'turn');
  const turnOpenLines = turnLines.filter((line) => line.includes(' open ')).length;
  const turnCloseLines = turnLines.filter((line) => line.includes(' close ')).length;
  const terminalLedgerLines = ledger.filter((line) => line.includes('state=completed')).length;
  const sessionsInEveryLine = [...ledger, ...turnLines].every((line) => line.includes(`session=${sessionId}`));

  console.log(
    `ledgerLines=${ledger.length} turnOpenLines=${turnOpenLines} turnCloseLines=${turnCloseLines} ` +
      `terminalLedgerLines=${terminalLedgerLines} sessionsInEveryLine=${sessionsInEveryLine}`,
  );
  console.log(`leasesAfterOpen=${leasesAfterOpen} leasesBeforeResult=${leasesBeforeResult} leasesAfterResult=${leasesAfterResult}`);
  for (const line of [...ledger, ...turnLines]) {
    console.log(`line=${line}`);
  }

  assert.strictEqual(leasesAfterOpen, 1, 'the open turn holds one lease');
  assert.strictEqual(leasesBeforeResult, 1, 'and still holds it while its command runs');
  assert.strictEqual(leasesAfterResult, 0, 'the RESULT is the lease change (read from the manager)');
  assert.strictEqual(turnOpenLines, 1, `exactly one [turn] open line (read ${turnOpenLines})`);
  assert.strictEqual(turnCloseLines, 1, `exactly one [turn] close line (read ${turnCloseLines})`);
  assert.strictEqual(terminalLedgerLines, 1, `exactly one [ledger] line states the terminal (read ${terminalLedgerLines})`);
  assert.strictEqual(
    ledger.length,
    3,
    `one [ledger] line per delivery state the send passed through — pushed, started, completed (read ${ledger.length})`,
  );
  assert.strictEqual(sessionsInEveryLine, true, 'every §10.2 line states the session');
  assert.match(
    turnLines.find((line) => line.includes(' open ')) ?? '',
    new RegExp(`^\\[turn\\] session=${sessionId} turn=\\S+ kind=delivered open`),
    'the open line is §10.2\'s shape',
  );
  assert.match(
    turnLines.find((line) => line.includes(' close ')) ?? '',
    new RegExp(`^\\[turn\\] session=${sessionId} turn=\\S+ kind=delivered close outcome=completed`),
    'the close line is §10.2\'s shape',
  );

  await dispose(harness);
});

// ---------------------------------------------------------------------------
// The criterion's own budget
// ---------------------------------------------------------------------------

test('the criterion finished inside its wall-clock budget', () => {
  const measured = Date.now() - STARTED_AT;
  console.log(`[readings] elapsed=${measured}ms budget=${RUN_BUDGET_MS}ms`);
  assert.ok(measured < RUN_BUDGET_MS, `the whole criterion must finish inside ${RUN_BUDGET_MS}ms (read ${measured}ms)`);
});
