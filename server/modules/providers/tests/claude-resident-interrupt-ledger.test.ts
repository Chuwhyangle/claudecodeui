/**
 * Criterion for an interrupt leaving NO RESIDUE on the resident host's
 * delivery/turn ledger (AC-380, SPEC §2 C-5, §5.2, §6.3, §10).
 *
 * `interrupt()` used to ask the CLI to stop and then write the ledger itself:
 * it marked the round interrupted and dropped the `turn` lease by hand, while
 * the round stayed in the FIFO. When the CLI had already moved on — so no
 * `RESULT` was coming — that left a reading that cannot be closed by any later
 * frame: `turnLeasesOpen=0` while `roundsOpen>0`. The manager's registry still
 * had the run `running`, no lease said the host was busy, and nothing was left
 * that could reconcile the two. That is the residue this criterion is about,
 * and it is what the `Working…` at the bottom of the UI outlived its turn as.
 *
 * §6.3 makes the interrupt a REQUEST and nothing else. It asks the CLI once and
 * sets `turn.interruptRequested`; the ledger is otherwise untouched. Everything
 * after that is the CLI's own statement, arriving as frames: the in-flight
 * command's `command_lifecycle cancelled` reads `reason=interrupt` (C-5 — an
 * interrupt stops the command in flight and nothing else), the turn's
 * `RESULT(is_error)` reads `aborted` (§5.2), and a command that was queued
 * behind it runs a turn of its own. The lease is a projection of the ledger
 * (§5.4), so an interrupt that changes no state changes no lease either. An
 * interrupt the CLI never answers within `T_int` is not silently left as
 * residue: it is stated as the `interrupt-no-result` anomaly (§10).
 *
 * This criterion drives all four readings through the REAL
 * `ClaudeResidentHostDriver` over the injected scripted-process seam (the
 * `createProcess` factory) and a REAL session-host manager — the same shape the
 * sibling resident criteria use, so what is measured is the driver's own path
 * rather than a copy of it. No real `claude` binary is started.
 *
 * The false form (AC (d)), and why leg (b) is the leg that carries it:
 *
 *   Put the old `leaseRemoved(appSessionId, 'turn')` back into `interrupt()`,
 *   leaving the ledger alone. Leg (b) — a turn in flight, an interrupt, and a
 *   CLI that never answers — then reads `turnLeasesOpen=0` with
 *   `roundsOpen=1`, which is the known-defect signature, and reds on exactly
 *   that reading rather than on a later assertion: every reading is collected
 *   and printed before anything is asserted, and the split reading is the first
 *   thing asserted. The other legs stay green under that mutant for the
 *   readings they do not share with it, so a run of leg (b) alone is what names
 *   the defect.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a resident lifecycle that hangs is a budget kill
 *   with its own reading, as in the sibling resident criteria.
 * - Every reading is taken before anything is asserted, so a red lands on the
 *   reading that is wrong rather than on a timeout or on an earlier leg.
 * - `T_int` is injected (250 ms), so the deadline is reached without paying the
 *   production five seconds of wall clock; the reading taken across it is the
 *   anomaly line, never the wait.
 * - Nothing here reads a private field: every reading comes from
 *   `ledgerReading` / `busyInputReading`, from the manager's own lease
 *   projection, or from the scripted seam's own count of the requests written
 *   to it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import util from 'node:util';

import { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentLedgerReading,
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/** The wall-clock bound this criterion reports the whole run against (AC (e): < 45s). */
const RUN_BUDGET_MS = 40_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the interrupt-ledger criterion did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, RUN_BUDGET_MS - 1_000);
budgetGuard.unref();

/** The pid the scripted seam reports; it is read and never acted on. */
const PROCESS_PID = 4242;

/**
 * `T_int` for every leg here: short enough that the deadline costs no meaningful
 * wall clock, long enough that no amount of draining can reach it, so a leg that
 * waits past it is waiting on the timer and not on a microtask.
 */
const T_INT_MS = 250;

/** How long a leg waits past `T_int` before reading whether the line appeared. */
const PAST_T_INT_MS = T_INT_MS * 3;

// ---------------------------------------------------------------------------
// The scripted process
// ---------------------------------------------------------------------------

type FakeProcess = {
  factory: ClaudeResidentProcessFactory;
  emit(frame: AnyRecord): void;
  /** Every frame the driver wrote into the process, in write order. */
  pushed(): AnyRecord[];
  /** How many times the driver asked the CLI to stop the turn in flight. */
  interrupts(): number;
};

/**
 * A resident process the arm owns: a stream it pushes into, in order, plus the
 * driver's own write side read back off the queue it seeds and writes.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every reading
 * into a reading of a dead process — and its `interrupt` counts the requests,
 * because "exactly one request went out" is a reading this criterion states
 * rather than assumes.
 */
function createFakeProcess(): FakeProcess {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  const pushed: AnyRecord[] = [];
  let interrupts = 0;

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
    interrupt: async () => {
      interrupts += 1;
    },
    close: () => undefined,
  };

  const factory: ClaudeResidentProcessFactory = (input) => {
    // One reader for the process's whole life: every frame the driver writes is
    // recorded in write order, which is the order a send's uuid is read in.
    void (async () => {
      for await (const frame of input.prompt) {
        pushed.push(frame);
      }
    })();
    return { query, pid: PROCESS_PID } satisfies ClaudeResidentProcess;
  };

  return { factory, emit: push, pushed: () => pushed, interrupts: () => interrupts };
}

/** The runtime's own turn inputs, stubbed to the facts this arm's driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // The frame pipeline has its own criteria: this arm measures the LEDGER, and
  // an empty normalizer keeps the recording writers free of forwarded frames.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

/** A writer that records every frame it is handed, so a run's `complete` is countable. */
type RecordingWriter = {
  writer: ProviderRuntimeWriter;
  frames: AnyRecord[];
  completeCount(): number;
};

function createRecordingWriter(): RecordingWriter {
  const frames: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (message) => {
      frames.push(message as AnyRecord);
    },
    setSessionId: () => undefined,
    userId: 1,
  };
  return { writer, frames, completeCount: () => frames.filter((frame) => frame.kind === 'complete').length };
}

/** A scheduler whose deadlines never fire: this arm is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

// ---------------------------------------------------------------------------
// The arm
// ---------------------------------------------------------------------------

type Harness = {
  sessionId: string;
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: FakeProcess;
  /** The `turn` leases the driver reported through its sink, by the runId it used. */
  leases: Set<string>;
  /** How many times the driver asked the manager to drop the `turn` lease. */
  leaseRemovals: number;
  writers: RecordingWriter[];
  runs: Promise<void>[];
};

/**
 * Builds one arm: a real driver over a scripted process and a real manager, with
 * the sink captured so the two lease readings can be taken exactly — what the
 * manager was asked to add, and what it was asked to remove.
 *
 * Capture is by wrapping `startHost`, the one moment the manager hands the driver
 * its sink. Every other member is bound to the real sink, so the manager's own
 * behaviour is untouched; only the lease verbs are also counted.
 */
function createHarness(sessionId: string): Harness {
  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => 1_700_000_000_000,
    interruptResultTimeoutMs: T_INT_MS,
  });

  const harness: Harness = {
    sessionId,
    manager,
    driver,
    process,
    leases: new Set<string>(),
    leaseRemovals: 0,
    writers: [],
    runs: [],
  };

  const startHost = driver.startHost.bind(driver);
  driver.startHost = async (host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> => {
    const wrapped = new Proxy(sink as unknown as Record<string, unknown>, {
      get(target, property) {
        if (property === 'leaseAdded') {
          return (appSessionId: string, lease: { kind: string; runId?: string }) => {
            if (lease.kind === 'turn' && typeof lease.runId === 'string') {
              harness.leases.add(lease.runId);
            }
            return (target.leaseAdded as (id: string, value: unknown) => void)(appSessionId, lease);
          };
        }
        if (property === 'leaseRemoved') {
          return (appSessionId: string, kind: string) => {
            if (kind === 'turn') {
              harness.leaseRemovals += 1;
              harness.leases.clear();
            }
            return (target.leaseRemoved as (id: string, value: string) => void)(appSessionId, kind);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as IProviderHostDriverSink;
    return startHost(host, wrapped);
  };

  return harness;
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function drain(): Promise<void> {
  for (let hop = 0; hop < 48; hop += 1) {
    await Promise.resolve();
  }
}

/** Waits for a condition, yielding microtasks and (rarely) a macrotask. */
async function until(condition: () => boolean, label: string, budget = 6_000): Promise<void> {
  for (let attempt = 0; attempt < budget; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
    if (attempt % 24 === 23) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  throw new Error(`harness: ${label} never became true`);
}

/** Lets real time pass, so a watchdog's deadline can be reached. */
async function past(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Reads the ledger, insisting the host is live (a violation if it is not). */
function ledgerOf(harness: Harness): ClaudeResidentLedgerReading {
  const reading = harness.driver.ledgerReading(harness.sessionId);
  if (!reading) {
    throw new Error('harness: the ledger must be readable while the host is live');
  }
  return reading;
}

/** The host as the manager sees it, for the interrupt verb. */
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

/** Writes one frame into the process and lets the driver read it. */
async function emit(harness: Harness, frame: AnyRecord): Promise<void> {
  harness.process.emit(frame);
  await drain();
}

/** One send, and the uuid its own frame was written under — the CLI's name for it. */
type Send = { uuid: string; writer: RecordingWriter };

/**
 * Dispatches one send and answers when the host has taken it: the round armed,
 * the frame written to the process.
 *
 * `run` is not awaited — a round settles only once this arm has fed the frames
 * that end it, so awaiting it here would deadlock. The promise is kept so the
 * caller can drain what settles.
 */
async function send(harness: Harness, command: string): Promise<Send> {
  const recording = createRecordingWriter();
  const before = harness.process.pushed().length;
  harness.writers.push(recording);
  const run = harness.driver.run(harness.sessionId, { command, options: {} }, recording.writer, CONTEXT);
  // A run this arm deliberately never settles has nothing to reject; one the
  // driver fails would reject where nobody awaits it.
  run.catch(() => undefined);
  harness.runs.push(run);

  const expected = harness.writers.length;
  await until(
    () =>
      (harness.driver.ledgerReading(harness.sessionId)?.deliveries.length ?? 0) >= expected &&
      harness.process.pushed().length > before,
    `the resident host to accept send #${expected}`,
  );

  const written = harness.process.pushed().slice(before);
  // The ledger names a delivery by the LAST uuid on its frames — the prompt —
  // and that is the id the CLI reports its lifecycle under.
  const uuid = typeof written.at(-1)?.uuid === 'string' ? (written.at(-1)?.uuid as string) : null;
  if (!uuid) {
    throw new Error(`harness: the driver accepted send #${expected} without writing a frame for it`);
  }
  return { uuid, writer: recording };
}

/** The CLI's own statement that a turn is beginning. */
function initFrame(uuid: string): AnyRecord {
  return { type: 'system', subtype: 'init', uuid };
}

/** A command's lifecycle, as the CLI reports it back. */
function lifecycleFrame(commandUuid: string, state: string): AnyRecord {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state };
}

/** A turn's terminal frame; `is_error` is the half §5.2 reads `aborted` from. */
function resultFrame(isError: boolean): AnyRecord {
  return { type: 'result', subtype: isError ? 'error' : 'success', is_error: isError };
}

// ---------------------------------------------------------------------------
// The reconciler's own lines
// ---------------------------------------------------------------------------

/** Every line the driver under test logged, teed out of stdout. */
const logged: string[] = [];

/** Tees `console.log` into {@link logged}, keeping its original behaviour. */
function captureConsoleLog(): () => void {
  const original = console.log.bind(console) as (...data: unknown[]) => void;
  const tee = (...data: unknown[]): void => {
    logged.push(util.format(...data));
    original(...data);
  };
  console.log = tee as typeof console.log;
  return () => {
    console.log = original as typeof console.log;
  };
}

/**
 * The `[reconcile]` lines one session got for one anomaly code.
 *
 * Read per session rather than per window because the line carries `session=`
 * (§10.2), which is exactly what makes the two legs of (b) separable without
 * either of them knowing when the other ran.
 */
function reconcileLines(sessionId: string, code: string): string[] {
  const prefix = `[reconcile] session=${sessionId} `;
  return logged.filter((line) => line.startsWith(prefix) && line.includes(` anomaly=${code} `));
}

// ---------------------------------------------------------------------------
// (a) the interrupt is a request: the frames end the turn, not the call
// ---------------------------------------------------------------------------

test('AC380 (a) an interrupt requests only, and the CLI\'s own frames end the turn and start the queued one', async () => {
  const harness = createHarness('ac380-interrupt-request-only');

  // A turn in flight, with one command queued behind it.
  const inFlight = await send(harness, 'A in flight');
  await emit(harness, initFrame('ac380-init-a'));
  const queued = await send(harness, 'B queued');

  const beforeInterrupt = ledgerOf(harness);
  const turnId = beforeInterrupt.turn?.id ?? null;
  const stopped = await harness.driver.interrupt(hostOf(harness), harness.sessionId);
  await drain();

  // Read straight after the call returns, before any frame is fed: this is the
  // moment the defect left its split reading at.
  const afterInterrupt = ledgerOf(harness);
  const inFlightLeaseAtInterrupt =
    afterInterrupt.turn === null
      ? -1
      : afterInterrupt.deliveries.filter(
          (delivery) => delivery.runOpen && delivery.turnId === afterInterrupt.turn?.id,
        ).length;
  const inFlightTurnInterruptRequested = afterInterrupt.turn?.interruptRequested === true;

  // The CLI's answer, in the order the CLI itself states it: the command in
  // flight is cancelled, the turn ends with an `is_error` RESULT, and the queued
  // command is then dequeued into a turn of its own.
  await emit(harness, lifecycleFrame(inFlight.uuid, 'cancelled'));
  await emit(harness, resultFrame(true));
  await emit(harness, lifecycleFrame(queued.uuid, 'started'));
  await emit(harness, initFrame('ac380-init-b'));
  await emit(harness, resultFrame(false));
  await drain();

  const atRest = ledgerOf(harness);
  const busyAtRest = harness.driver.busyInputReading(harness.sessionId);
  const inFlightDelivery = atRest.deliveries.find((delivery) => delivery.deliveryId === inFlight.uuid);
  const closedInFlightTurn = atRest.closedTurns.find((turn) => turn.id === turnId);
  const inFlightCompletes = inFlight.writer.completeCount();
  const queuedCompletes = queued.writer.completeCount();
  const roundsPushed = harness.writers.length;
  const roundsOpenAtRest = busyAtRest?.roundsOpen ?? -1;
  const turnLeasesOpenAtRest = turnLeaseCount(harness.manager, harness.sessionId);

  console.log(
    `inFlightLeaseAtInterrupt=${inFlightLeaseAtInterrupt} ` +
      `inFlightTurnInterruptRequested=${inFlightTurnInterruptRequested} ` +
      `inFlightDelivery=${inFlightDelivery?.state ?? 'null'} reason=${inFlightDelivery?.reason ?? 'null'} ` +
      `inFlightTurn=${closedInFlightTurn?.outcome ?? 'null'} ` +
      `completes=inFlight:${inFlightCompletes} queued:${queuedCompletes}`,
  );
  console.log(`roundsPushed=${roundsPushed} roundsOpen=${roundsOpenAtRest} turnLeasesOpen=${turnLeasesOpenAtRest}`);

  assert.strictEqual(stopped, true, 'the interrupt must be placed on the turn in flight');
  assert.strictEqual(
    inFlightLeaseAtInterrupt,
    1,
    `the interrupt must leave the in-flight run open — its lease is projected from exactly that ` +
      `(read ${inFlightLeaseAtInterrupt})`,
  );
  assert.strictEqual(
    inFlightTurnInterruptRequested,
    true,
    'the request must be recorded on the turn, which is what its RESULT reads `aborted` from',
  );
  assert.strictEqual(inFlightDelivery?.state, 'cancelled', 'the in-flight command is the one the CLI cancels');
  assert.strictEqual(
    inFlightDelivery?.reason,
    'interrupt',
    'the cancelled command\'s reason is this side\'s own record of the request (C-5)',
  );
  assert.strictEqual(closedInFlightTurn?.outcome, 'aborted', 'the interrupted turn reads `aborted` (§5.2)');
  assert.strictEqual(inFlightCompletes, 1, `the in-flight run got exactly one terminal complete (read ${inFlightCompletes})`);
  assert.strictEqual(queuedCompletes, 1, `the queued run got exactly one terminal complete (read ${queuedCompletes})`);
  assert.strictEqual(roundsOpenAtRest, 0, `the round FIFO must be empty at rest (read ${roundsOpenAtRest})`);
  assert.strictEqual(turnLeasesOpenAtRest, 0, `no turn lease may be left behind (read ${turnLeasesOpenAtRest})`);
});

// ---------------------------------------------------------------------------
// (b) an interrupt the CLI never answers
// ---------------------------------------------------------------------------

test('AC380 (b) an unanswered interrupt leaves no split reading and is stated as an anomaly', async () => {
  const restoreConsole = captureConsoleLog();
  let idleSession = '';
  let controlSession = '';
  let stopped = false;
  let idleAfterInterruptRoundsOpen = -1;
  let idleAfterInterruptTurnLeasesOpen = -1;
  let idleAnomalies = 0;
  let controlAnomalies = 0;
  let controlTurnOutcome: string | null = null;
  let controlRoundsOpen = -1;
  let controlTurnLeasesOpen = -1;

  try {
    // The defect's own scenario: a turn is in flight, the interrupt goes out,
    // and the CLI never answers it — the readout the old code left behind could
    // never be closed by a later frame.
    const idle = createHarness('ac380-idle-after-interrupt');
    idleSession = idle.sessionId;
    await send(idle, 'A in flight');
    await emit(idle, initFrame('ac380-init-idle'));
    stopped = await idle.driver.interrupt(hostOf(idle), idle.sessionId);
    await drain();

    idleAfterInterruptRoundsOpen = idle.driver.busyInputReading(idle.sessionId)?.roundsOpen ?? -1;
    idleAfterInterruptTurnLeasesOpen = turnLeaseCount(idle.manager, idle.sessionId);

    await past(PAST_T_INT_MS);
    idleAnomalies = reconcileLines(idleSession, 'interrupt-no-result').length;

    // The control: the same request, answered by a `RESULT` inside `T_int`. The
    // deadline it was measured against is what the answer cancels, so the line
    // that names an unanswered interrupt must not appear for it.
    const control = createHarness('ac380-result-inside-tint');
    controlSession = control.sessionId;
    await send(control, 'A in flight');
    await emit(control, initFrame('ac380-init-control'));
    await control.driver.interrupt(hostOf(control), control.sessionId);
    await drain();
    await emit(control, resultFrame(true));

    await past(PAST_T_INT_MS);
    controlAnomalies = reconcileLines(controlSession, 'interrupt-no-result').length;
    const controlLedger = ledgerOf(control);
    controlTurnOutcome = controlLedger.closedTurns.at(-1)?.outcome ?? null;
    controlRoundsOpen = control.driver.busyInputReading(control.sessionId)?.roundsOpen ?? -1;
    controlTurnLeasesOpen = turnLeaseCount(control.manager, control.sessionId);
  } finally {
    restoreConsole();
  }

  console.log(
    `idleAfterInterruptRoundsOpen=${idleAfterInterruptRoundsOpen} ` +
      `idleAfterInterruptTurnLeasesOpen=${idleAfterInterruptTurnLeasesOpen}`,
  );
  console.log(`interruptNoResultLines=${idleAnomalies} interruptNoResultLinesControl=${controlAnomalies}`);

  // Asserted first, and by name: this is the reading the old implementation got
  // wrong, so the false form has to red here rather than on anything after it.
  assert.ok(
    !(idleAfterInterruptTurnLeasesOpen === 0 && idleAfterInterruptRoundsOpen > 0),
    `the interrupt must not take the turn lease away while its round stays open — that split reading is the ` +
      `residue this criterion is about (idleAfterInterruptRoundsOpen=${idleAfterInterruptRoundsOpen} ` +
      `idleAfterInterruptTurnLeasesOpen=${idleAfterInterruptTurnLeasesOpen})`,
  );
  assert.strictEqual(stopped, true, 'the interrupt must be placed on the turn in flight');
  assert.strictEqual(idleAfterInterruptRoundsOpen, 1, 'the in-flight round is still open until a frame ends it');
  assert.strictEqual(idleAfterInterruptTurnLeasesOpen, 1, 'and its lease is still reported');
  assert.strictEqual(
    idleAnomalies,
    1,
    `an interrupt with no RESULT past T_int must be stated once as interrupt-no-result (read ${idleAnomalies})`,
  );
  assert.match(
    reconcileLines(idleSession, 'interrupt-no-result')[0] ?? '',
    new RegExp(`^\\[reconcile\\] session=${idleSession} mode=log anomaly=interrupt-no-result detail=`),
    'the line must be §10.2\'s shape, at this stage\'s mode=log',
  );
  assert.strictEqual(
    controlAnomalies,
    0,
    `a RESULT inside T_int answers the request, so no anomaly line may be written (read ${controlAnomalies})`,
  );
  assert.strictEqual(controlTurnOutcome, 'aborted', 'the answered interrupt still reads `aborted` on its turn');
  assert.strictEqual(controlRoundsOpen, 0, 'and the answered turn settles its run, leaving no round open');
  assert.strictEqual(controlTurnLeasesOpen, 0, 'and no lease behind it');
});

// ---------------------------------------------------------------------------
// (c) one request, no ledger write of its own
// ---------------------------------------------------------------------------

test('AC380 (c) one interrupt writes one CLI request and changes no lease by itself', async () => {
  const harness = createHarness('ac380-interrupt-writes');
  await send(harness, 'A in flight');
  await emit(harness, initFrame('ac380-init-writes'));

  const cliWritesBefore = harness.process.interrupts();
  const leaseRemovalsBefore = harness.leaseRemovals;
  const turnLeasesBefore = turnLeaseCount(harness.manager, harness.sessionId);

  const stopped = await harness.driver.interrupt(hostOf(harness), harness.sessionId);
  await drain();

  const cliInterruptWrites = harness.process.interrupts() - cliWritesBefore;
  const leaseRemovedDuringInterrupt = harness.leaseRemovals - leaseRemovalsBefore;
  const turnLeasesAfter = turnLeaseCount(harness.manager, harness.sessionId);
  const leasesReported = harness.leases.size;

  console.log(
    `cliInterruptWrites=${cliInterruptWrites} leaseRemovedDuringInterrupt=${leaseRemovedDuringInterrupt} ` +
      `turnLeasesBefore=${turnLeasesBefore} turnLeasesAfter=${turnLeasesAfter} leasesReported=${leasesReported}`,
  );

  assert.strictEqual(stopped, true, 'the interrupt must be placed on the turn in flight');
  assert.strictEqual(cliInterruptWrites, 1, `one interrupt is one request to the CLI (read ${cliInterruptWrites})`);
  assert.strictEqual(
    leaseRemovedDuringInterrupt,
    0,
    `the interrupt path must not take the turn lease away itself (read ${leaseRemovedDuringInterrupt})`,
  );
  assert.strictEqual(turnLeasesBefore, 1, 'the turn in flight holds its lease before the request');
  assert.strictEqual(
    turnLeasesAfter,
    turnLeasesBefore,
    `the request itself must not change that reading (before ${turnLeasesBefore}, after ${turnLeasesAfter})`,
  );

  // Leaves the arm quiet: the answer arrives inside T_int, so this leg's own
  // watchdog is cancelled rather than left to fire into the next leg's window.
  await emit(harness, resultFrame(true));
});

test('the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < RUN_BUDGET_MS, `the criterion finished in ${elapsed}ms, under its ${RUN_BUDGET_MS}ms budget`);
});
