/**
 * AC-382 criterion — run 即 turn (SPEC §6, behind `RESIDENT_RUN_IS_TURN`).
 *
 * The claim: a resident session's run IS its turn. The run is minted for the turn
 * the CLI announces, every delivery the CLI folds into that turn (`next`) or
 * drains into it (`later`) SHARES the one run, a turn nobody pushed is a run of
 * its own kind with no deliveries at all, no superseding run is ever opened
 * behind a running turn, and every frame a run holds is a frame of that run.
 *
 * The reading is taken through the REAL chat control service and the REAL run
 * registry, with the process injected — a scripted fake `claude` host, driven
 * through the real `ClaudeResidentHostDriver` (its real `run` entry, its real
 * message-fold loop, its real ledger), so what is measured is the driver's own
 * frame routing and run binding rather than a copy of it. No `WebSocket` is
 * built anywhere: the transport-agnostic `chatControlService.send` is called
 * directly, exactly as `chat-control-busy.test.ts` does, and the run registry is
 * the process-wide singleton the production dispatch uses.
 *
 * The legs, each a state observation taken before anything is asserted:
 *
 *   (a) idle send            ⇒ one turn, one run, `kind=delivered`, and that
 *                              run's `deliveryIds` is exactly the send's delivery;
 *   (b) two `later` sends behind a running turn, drained by the CLI into ONE turn
 *                            ⇒ one run minted on that path, its `deliveryIds`
 *                              exactly those two (set, not order), each delivery
 *                              terminal on its own;
 *   (c) a `next` send in a running turn ⇒ no run minted, and the delivery is bound
 *                              to the OPEN TURN's run (ids equal);
 *   (d) a turn nobody pushed ⇒ `source=unattended` and no deliveries;
 *   (e) frame attribution    ⇒ every frame in a run belongs to a turn that run
 *                              covers, and each run's `seq` runs 1..n with no gap;
 *   (f) `startRun` spy       ⇒ zero `supersedeRunning` calls for the resident
 *                              session, and every `startRun` call minted a run;
 *   (g) a per-run provider   ⇒ still one delivery to one run, and a busy second
 *                              send is refused `RUN_IN_PROGRESS`.
 *
 * The false form this is graded against is documented in the criterion's
 * completion record: frame routing reverted to `state.rounds[0].writer` (the S1
 * behaviour) must red leg (e)'s `framesWithForeignRunId` reading and nothing
 * earlier, and restoring the line must turn it green again.
 *
 * Red lines, as in the sibling resident criteria:
 * - the process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, so a lifecycle that hangs is a budget kill with its own
 *   reading;
 * - every reading is taken before it is asserted, so a red lands on the reading
 *   that is wrong rather than on a timeout or on an earlier leg.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeResidentHostDriver } from '@/modules/providers/index.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { residentRunIsTurn } from '@/shared/utils.js';

const SESSION_ID = 'chat-run-turn-semantics-resident';
/** The second session: a provider whose turns are a process each, never a queue. */
const PER_RUN_SESSION_ID = 'chat-run-turn-semantics-per-run';
/** The per-turn provider's id — the debug agent's shape (SPEC §6.1's "per-run"). */
const PER_RUN_PROVIDER = 'debug-agent';
/** The provider-native id the scripted stream keys its frames by. */
const PROVIDER_SESSION_ID = 'ac382f00-0000-4000-8000-000000000001';

/** The caller shape `send` takes: an authenticated WebSocket front end. */
const CALLER = { userId: 1, via: 'websocket' as const };

/**
 * The option key the resident host reads a busy write's tier from.
 *
 * Written out rather than imported: the constant that names it
 * (`CLAUDE_TURN_PRIORITY_OPTION`) lives in a providers leaf module the session
 * module's criteria may not reach into (the module boundary is only crossed
 * through `modules/providers/index.ts`, which does not export it). The literal is
 * not left to drift: the criterion asserts the driver's OWN reading of the tier
 * (`busyInputReading().queuedInputs[].priority`), so a renamed key makes the
 * scenario degrade to the default tier and REDS that reading rather than
 * silently turning the `next` leg into another `later` one.
 */
const TURN_PRIORITY_OPTION = 'priority';

/** The bound this criterion reports itself against (SPEC §11: the gate's 60 s, minus margin). */
const ELAPSED_LIMIT_MS = 45_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the run=turn criterion did not finish ` +
      'inside its process budget (a process-level kill, not a node:test case failure).',
  );
  process.exit(3);
}, ELAPSED_LIMIT_MS - 1_000);
budgetGuard.unref();

// Stated in the module body, which runs after every import above has been
// evaluated — the same reason the implementation reads the variable at CALL time
// rather than caching it at load: a module-level constant on either side would
// answer the flag-off value here, and the criterion would measure the old path
// while believing it measured the new one.
process.env.RESIDENT_RUN_IS_TURN = '1';

/** One line of readings. The readings are the evidence; the assertions follow them. */
function say(line: string): void {
  console.log(`run-turn ${line}`);
}

// ---------------------------------------------------------------------------
// Scripted resident process
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this criterion is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * The process the arm owns: a stream it pushes into, in order.
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
    factory: () => ({ query, pid: 4343 }) satisfies ClaudeResidentProcess,
    emit: push,
  };
}

/**
 * The runtime's turn inputs, stubbed to the facts this arm's driver asks for.
 *
 * `normalizeMessage` is the one non-empty stub: a scripted frame carrying a
 * `marker` string is turned into exactly one client-facing frame whose `text` is
 * that marker, and every other frame normalizes to nothing. That is what makes
 * frame attribution readable: each marker names the turn it was emitted inside,
 * so a frame recorded in a run that does not cover that turn is visibly foreign.
 * The real normalizer is the AC-379 sentinel's business; this arm measures
 * routing, and the routing is reached through the real forwarder either way.
 */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: (raw: unknown) => {
    const frame = raw as AnyRecord;
    const marker = typeof frame?.marker === 'string' ? frame.marker : null;
    if (!marker) {
      return [];
    }
    return [{
      id: marker,
      kind: 'text',
      provider: 'claude',
      text: marker,
      sessionId: PROVIDER_SESSION_ID,
      timestamp: new Date(0).toISOString(),
    }];
  },
  isProviderInstalled: async () => true,
};

/** Yields the event loop enough times for the driver's read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 60; hop += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  control: ReturnType<typeof createChatControlService>;
  emit(frame: AnyRecord): void;
  /** The driver's own ledger for the resident session. */
  ledger(): ReturnType<ClaudeResidentHostDriver['ledgerReading']>;
  /** How many times the injected per-turn provider's `run` was entered. */
  perRunRunCalls(): number;
};

function createHarness(): Harness {
  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  // The turn seam, wired exactly as the composition root wires it
  // (`server/index.ts`): the manager owns the call, the run registry answers it.
  manager.setTurnOpener((input) => chatRunRegistry.openTurn(input));

  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => 1_700_000_000_000,
    connectedClientCount: () => 0,
  });

  /** The uuids this arm has already handed back through `queuedInputUuid`, per session. */
  const handedOut = new Map<string, string>();
  let perRunRunCalls = 0;
  /** Resolvers for the parked per-turn runs, released at teardown. */
  const parked: Array<(value?: unknown) => void> = [];

  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    // The per-turn provider's process is one per turn and never queues: that is
    // the whole of "this session cannot take busy input" (SPEC §6.1's per-run
    // half), and it is read off the PROVIDER, not off the session.
    acceptsBusyInput: (provider: string) => provider !== PER_RUN_PROVIDER,
    run: async (provider: string, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) => {
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
      if (provider === PER_RUN_PROVIDER) {
        perRunRunCalls += 1;
        // Parked, so "a run is in flight" is a fact this arm holds rather than a
        // race it hopes for — the second send must meet a busy session.
        return new Promise<unknown>((resolve) => {
          parked.push(resolve);
        });
      }
      return driver.run(sessionId, { command, options }, writer, CONTEXT);
    },
    abort: async () => false,
    // The uuid the provider stamped the just-queued message with. Polled rather
    // than read once because `send` asks for it BEFORE the driver has armed the
    // round (the control service resolves the send at `beforeRun`, and the write
    // into the process happens on the dispatch's own continuation) — so the
    // reading waits for a uuid it has not handed out yet, bounded by the control
    // service's own handover timeout.
    queuedInputUuid: async (_provider: LLMProvider, sessionId: string) => {
      const deadline = Date.now() + 1_500;
      const previous = handedOut.get(sessionId);
      while (Date.now() < deadline) {
        const queued = driver.busyInputReading(sessionId)?.queuedInputs ?? [];
        const last = queued.at(-1);
        if (last && last.uuid !== previous) {
          handedOut.set(sessionId, last.uuid);
          return last.uuid;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return null;
    },
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };

  return {
    manager,
    driver,
    control: createChatControlService({ runtime }),
    emit: process.emit,
    ledger: () => driver.ledgerReading(SESSION_ID),
    perRunRunCalls: () => perRunRunCalls,
  };
}

/** Fails unless `value` is a non-empty string, narrowing it for the assertions below. */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    assert.fail(`${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

/** The sorted copy of a list, so an assertion can compare two sets without an order claim. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

test('AC-382 a resident run is its turn: deliveries share it, frames stay in it, no supersede run', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-run-turn-semantics-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  // The scripted scenario's own bookkeeping: which markers were emitted inside
  // which turn.
  const markerTurn = new Map<string, string>();
  const markersByTurn = new Map<string, string[]>();

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const now = new Date().toISOString();
  sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Run-turn resident session', now, now, null);
  sessionsDb.createSession(PER_RUN_SESSION_ID, PER_RUN_PROVIDER, tempDirectory, 'Run-turn per-run session', now, now, null);

  chatRunRegistry.clearAll();
  const harness = createHarness();
  const { driver, control, emit } = harness;

  // The `startRun` spy (leg f). Installed before any send, so every mint this
  // scenario makes is counted — and counted by whether it MINTED, so the reading
  // "no call was wasted on a turn that could not open a run" is a measurement
  // rather than a restatement of the call count.
  const realStartRun = chatRunRegistry.startRun;
  const mintedRuns: string[] = [];
  let startRunCalls = 0;
  let supersedeRunningCalls = 0;
  chatRunRegistry.startRun = ((input: Parameters<typeof realStartRun>[0]) => {
    startRunCalls += 1;
    if (input.supersedeRunning === true) {
      supersedeRunningCalls += 1;
    }
    const run = realStartRun(input);
    if (run) {
      mintedRuns.push(run.runId);
    }
    return run;
  }) as typeof chatRunRegistry.startRun;

  /** Emits one scripted frame, tagging it with the turn it was emitted inside. */
  const emitIn = (turn: string, frame: AnyRecord, marker?: string): void => {
    if (marker === undefined) {
      emit(frame);
      return;
    }
    markerTurn.set(marker, turn);
    const list = markersByTurn.get(turn);
    if (list) {
      list.push(marker);
    } else {
      markersByTurn.set(turn, [marker]);
    }
    emit({ ...frame, marker });
  };

  /** The lifecycle frame the CLI emits for one command's state. */
  const lifecycle = (commandUuid: string, state: string): AnyRecord =>
    ({ type: 'command_lifecycle', command_uuid: commandUuid, state });

  /** The turn's ending, as the CLI states it. */
  const result = (): AnyRecord =>
    ({ type: 'result', subtype: 'success', is_error: false, session_id: PROVIDER_SESSION_ID });

  /** The run registry's record for one run id, with its own deliveries and frames. */
  const readRun = (runId: string) => {
    const run = chatRunRegistry.readRun(runId);
    assert.ok(run, `the registry must still hold run ${runId}`);
    return run;
  };

  const runsForSession = (sessionId: string): string[] =>
    chatRunRegistry
      .listRecentRuns()
      .filter((run) => run.sessionId === sessionId)
      .map((run) => run.runId);

  /** Every delivery the driver's ledger has recorded for the resident session, in order. */
  const ledgerDeliveries = (): NonNullable<ReturnType<Harness['ledger']>>['deliveries'] => {
    const reading = harness.ledger();
    assert.ok(reading, 'the resident host must be live and readable');
    return reading.deliveries;
  };

  /** The delivery id the driver minted for the most recent accepted send. */
  const lastDeliveryId = (): string => {
    const delivery = ledgerDeliveries().at(-1);
    assert.ok(delivery, 'the ledger must hold the delivery of the send just made');
    return delivery.deliveryId;
  };

  try {
    say(`(flags) residentRunIsTurn=${residentRunIsTurn()} pid=${process.pid}`);

    // ---------------------------------------------------------------------
    // (a) An idle send: one turn, one run, kind=delivered, that delivery.
    // ---------------------------------------------------------------------
    const idleSend = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC382 idle send' });
    assert.ok(idleSend.ok, `the idle send must be accepted (got ${JSON.stringify(idleSend)})`);
    // The dispatch is not awaited by `send` (it resolves at `beforeRun`), so the
    // host and its ledger exist one turn of the loop later.
    await settle();
    const idleDeliveryId = lastDeliveryId();
    say(`(a) idleSend=${JSON.stringify(idleSend)} idleDeliveryId=${idleDeliveryId}`);

    emitIn('idle', lifecycle(idleDeliveryId, 'queued'));
    emitIn('idle', lifecycle(idleDeliveryId, 'started'));
    emitIn('idle', { type: 'system', subtype: 'init', uuid: 'ac382-init-idle', session_id: PROVIDER_SESSION_ID }, 'm-idle-1');
    emitIn('idle', { type: 'assistant', session_id: PROVIDER_SESSION_ID }, 'm-idle-2');
    await settle();
    emitIn('idle', result());
    await settle();
    emitIn('idle', lifecycle(idleDeliveryId, 'completed'));
    await settle();

    const idleRun = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(idleRun, 'the idle send must leave a run on the session');
    const idleTurnCount = (harness.ledger()?.closedTurns.length ?? 0) + (harness.ledger()?.turn?.open ? 1 : 0);
    const idleRuns = runsForSession(SESSION_ID).length;
    say(
      `(a) idleTurns=${idleTurnCount} idleRuns=${idleRuns} kind=${idleRun.kind} ` +
        `deliveryIds=${JSON.stringify(idleRun.deliveryIds)} status=${idleRun.status}`,
    );

    // ---------------------------------------------------------------------
    // (b) Two `later` sends behind a running turn, drained by the CLI into ONE
    //     turn: one run for that path, holding exactly those two deliveries.
    // ---------------------------------------------------------------------
    const openerSend = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC382 turn two opener' });
    assert.ok(openerSend.ok, `the opener send must be accepted (got ${JSON.stringify(openerSend)})`);
    await settle();
    const openerDeliveryId = lastDeliveryId();
    emitIn('t2', lifecycle(openerDeliveryId, 'queued'));
    emitIn('t2', lifecycle(openerDeliveryId, 'started'));
    emitIn('t2', { type: 'system', subtype: 'init', uuid: 'ac382-init-t2', session_id: PROVIDER_SESSION_ID }, 'm-t2-1');
    await settle();
    const t2RunId = chatRunRegistry.getRun(SESSION_ID)?.runId;

    const mintsBeforeBusy = mintedRuns.length;
    const busyB = await control.send(CALLER, {
      sessionId: SESSION_ID,
      content: 'AC382 B later',
      options: { [TURN_PRIORITY_OPTION]: 'later' },
    });
    const busyC = await control.send(CALLER, {
      sessionId: SESSION_ID,
      content: 'AC382 C later',
      options: { [TURN_PRIORITY_OPTION]: 'later' },
    });
    assert.ok(busyB.ok, `the first later send must be accepted (got ${JSON.stringify(busyB)})`);
    assert.ok(busyC.ok, `the second later send must be accepted (got ${JSON.stringify(busyC)})`);
    assertNonEmptyString(busyB.queuedMessageUuid, 'busyB.queuedMessageUuid');
    assertNonEmptyString(busyC.queuedMessageUuid, 'busyC.queuedMessageUuid');
    const deliveryB = busyB.queuedMessageUuid;
    const deliveryC = busyC.queuedMessageUuid;
    const queuedTiers = (driver.busyInputReading(SESSION_ID)?.queuedInputs ?? []).map((input) => input.priority);
    say(
      `(b) deliveryB=${deliveryB} deliveryC=${deliveryC} queuedTiers=${JSON.stringify(queuedTiers)} ` +
        `t2RunId=${t2RunId ?? 'none'}`,
    );

    emitIn('t2', lifecycle(deliveryB, 'queued'));
    emitIn('t2', lifecycle(deliveryC, 'queued'));
    await settle();
    // The opener's turn ends, and the CLI drains the two queued commands into ONE
    // turn of its own (SPEC §2 C-4): one `init`, one `RESULT`.
    emitIn('t2', result());
    await settle();
    emitIn('t2-merged', lifecycle(deliveryB, 'started'));
    emitIn('t2-merged', lifecycle(deliveryC, 'started'));
    emitIn('t2-merged', { type: 'system', subtype: 'init', uuid: 'ac382-init-merged', session_id: PROVIDER_SESSION_ID }, 'm-merged-1');
    emitIn('t2-merged', { type: 'assistant', session_id: PROVIDER_SESSION_ID }, 'm-merged-2');
    await settle();
    const mergedRunId = chatRunRegistry.getRun(SESSION_ID)?.runId;
    emitIn('t2-merged', result());
    await settle();
    emitIn('t2-merged', lifecycle(deliveryB, 'completed'));
    emitIn('t2-merged', lifecycle(deliveryC, 'completed'));
    await settle();

    const mergedRun = mergedRunId ? readRun(mergedRunId) : null;
    // Everything minted after the two busy sends went in: the merged turn's own
    // run, and nothing else. (The openers of (a) and (b) minted before this
    // starting point and are not part of "the merged path".)
    const mergedRuns = mintedRuns.length - mintsBeforeBusy;
    say(
      `(b) mergedRuns=${mergedRuns} mergedRunId=${mergedRunId ?? 'none'} ` +
        `mergedDeliveryIds=${JSON.stringify(mergedRun?.deliveryIds ?? [])} ` +
        `mergedOrderIrrelevant=true`,
    );
    {
      const states = ledgerDeliveries()
        .filter((delivery) => delivery.deliveryId === deliveryB || delivery.deliveryId === deliveryC)
        .map((delivery) => `${delivery.deliveryId}:${delivery.state}`);
      say(`(b) mergedDeliveryStates=${JSON.stringify(states)}`);
    }

    // ---------------------------------------------------------------------
    // (c) A `next` send inside a running turn folds into it: no new run, and the
    //     delivery is bound to the open turn's run.
    // ---------------------------------------------------------------------
    const t3Send = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC382 turn three opener' });
    assert.ok(t3Send.ok, `the third opener must be accepted (got ${JSON.stringify(t3Send)})`);
    await settle();
    const t3DeliveryId = lastDeliveryId();
    emitIn('t3', lifecycle(t3DeliveryId, 'queued'));
    emitIn('t3', lifecycle(t3DeliveryId, 'started'));
    emitIn('t3', { type: 'system', subtype: 'init', uuid: 'ac382-init-t3', session_id: PROVIDER_SESSION_ID }, 'm-t3-1');
    emitIn('t3', { type: 'assistant', session_id: PROVIDER_SESSION_ID }, 'm-t3-2');
    await settle();
    const openTurnRunId = chatRunRegistry.getRun(SESSION_ID)?.runId;
    assertNonEmptyString(openTurnRunId, 'the open turn must have a run');

    const mintsBeforeNext = mintedRuns.length;
    const nextSend = await control.send(CALLER, {
      sessionId: SESSION_ID,
      content: 'AC382 D next',
      options: { [TURN_PRIORITY_OPTION]: 'next' },
    });
    assert.ok(nextSend.ok, `the next send must be accepted (got ${JSON.stringify(nextSend)})`);
    assertNonEmptyString(nextSend.queuedMessageUuid, 'nextSend.queuedMessageUuid');
    const deliveryD = nextSend.queuedMessageUuid;
    emitIn('t3', lifecycle(deliveryD, 'started'));
    emitIn('t3', { type: 'assistant', session_id: PROVIDER_SESSION_ID }, 'm-t3-3');
    await settle();

    const nextRunsAdded = mintedRuns.length - mintsBeforeNext;
    const nextDeliveryRunId = chatRunRegistry.getRun(SESSION_ID)?.runId;
    say(
      `(c) nextRunsAdded=${nextRunsAdded} nextDeliveryRunId=${nextDeliveryRunId ?? 'none'} ` +
        `openTurnRunId=${openTurnRunId}`,
    );

    emitIn('t3', result());
    await settle();
    emitIn('t3', lifecycle(deliveryD, 'completed'));
    emitIn('t3', lifecycle(t3DeliveryId, 'completed'));
    await settle();

    // ---------------------------------------------------------------------
    // (d) A turn nobody pushed: unattended, and bound to no delivery.
    // ---------------------------------------------------------------------
    emitIn('unattended', { type: 'system', subtype: 'init', uuid: 'ac382-init-unattended', session_id: PROVIDER_SESSION_ID }, 'm-un-1');
    emitIn('unattended', { type: 'assistant', session_id: PROVIDER_SESSION_ID }, 'm-un-2');
    await settle();
    const unattendedRunId = chatRunRegistry.getRun(SESSION_ID)?.runId;
    const unattendedRun = unattendedRunId ? readRun(unattendedRunId) : null;
    emitIn('unattended', result());
    await settle();

    say(
      `(d) unattendedRunId=${unattendedRunId ?? 'none'} unattendedRunSource=${unattendedRun?.source ?? 'none'} ` +
        `kind=${unattendedRun?.kind ?? 'none'} unattendedDeliveryIds=${unattendedRun?.deliveryIds.length ?? -1}`,
    );

    // ---------------------------------------------------------------------
    // (g) The per-run provider: one delivery to one run, busy refused.
    // ---------------------------------------------------------------------
    const perRunFirst = await control.send(CALLER, { sessionId: PER_RUN_SESSION_ID, content: 'AC382 per-run first' });
    assert.ok(perRunFirst.ok, `the per-run send must be accepted (got ${JSON.stringify(perRunFirst)})`);
    const perRunRunIds = runsForSession(PER_RUN_SESSION_ID);
    const perRunRunId = perRunRunIds[0];
    const perRunRun = perRunRunId ? readRun(perRunRunId) : null;
    const runCallsBeforePerRunSecond = harness.perRunRunCalls();
    const perRunSecond = await control.send(CALLER, { sessionId: PER_RUN_SESSION_ID, content: 'AC382 per-run second' });
    const runCallsAfterPerRunSecond = harness.perRunRunCalls();
    const perRunDeliveries = perRunRun?.deliveryIds.length ?? -1;
    const perRunRuns = perRunRunIds.length;
    say(
      `(g) perRunFirst=${JSON.stringify(perRunFirst)} perRunSecond=${JSON.stringify(perRunSecond)} ` +
        `perRunDeliveries=${perRunDeliveries} perRunRuns=${perRunRuns} ` +
        `runCalls=${runCallsBeforePerRunSecond}->${runCallsAfterPerRunSecond}`,
    );

    // ---------------------------------------------------------------------
    // (e) Frame attribution, over every run this scenario produced.
    // ---------------------------------------------------------------------
    // A run's own turns: its deliveries, joined through the DRIVER's ledger to the
    // ledger's turn ids, mapped onto the scenario's turn names. An unattended run
    // owns no delivery, so its turn is the one the ledger read as unattended.
    const ledgerNow = harness.ledger();
    assert.ok(ledgerNow, 'the resident host must still be live when the attribution is read');
    const turnIdByDelivery = new Map(
      ledgerNow.deliveries.map((delivery) => [delivery.deliveryId, delivery.turnId]),
    );
    // Which ledger turn id answered to which scenario turn: the closed turns, in
    // order, are the scenario's turns in order — the scenario emits them serially.
    const closedByKind = ledgerNow.closedTurns;
    const unattendedTurnIds = new Set(
      closedByKind.filter((turn) => turn.kind === 'unattended').map((turn) => turn.id),
    );
    const turnIdByScenarioOrder: string[] = [];
    for (const delivery of ledgerNow.deliveries) {
      if (delivery.turnId && !turnIdByScenarioOrder.includes(delivery.turnId)) {
        turnIdByScenarioOrder.push(delivery.turnId);
      }
    }
    const scenarioTurnOf = (turnId: string | null): string | null => {
      if (turnId === null) {
        return null;
      }
      if (unattendedTurnIds.has(turnId)) {
        return 'unattended';
      }
      const index = turnIdByScenarioOrder.indexOf(turnId);
      // The delivered turns this scenario scripted, in the order their first
      // deliveries were sent — the scenario emits them serially, so the ledger's
      // own order is the script's order.
      return index < 0 ? null : (['idle', 't2', 't2-merged', 't3'] as const)[index] ?? null;
    };

    let framesWithForeignRunId = 0;
    let seqGaps = 0;
    let markersInRuns = 0;
    let runsWithFrames = 0;
    let lastSeqMismatches = 0;
    // The AC's literal half as well: every frame in a run carries that run's own
    // id, as the registry stamps it when it records the event. This one holds by
    // construction (the stamp is written by the recorder), so it is the weaker of
    // the two readings and is kept as the pair's positive half — the discriminating
    // one is the turn mapping above, which is what the false form reds.
    let framesWithWrongRunIdField = 0;
    const allRuns = [...runsForSession(SESSION_ID), ...runsForSession(PER_RUN_SESSION_ID)];
    for (const runId of allRuns) {
      const run = readRun(runId);
      // The AC-235 projection and the run's own record must agree about the run's
      // extent: `lastSeq` is what a reconnecting client's cursor is judged
      // against, so a reader that disagreed with it would be reporting frames the
      // replay path cannot see. (The events themselves come from `readRun`, which
      // is the run's own log: `getRunById` is pinned to its seven-field summary by
      // its own criterion and carries no events.)
      const summary = chatRunRegistry.getRunById(runId);
      const summaryLastSeq = summary && 'lastSeq' in summary ? summary.lastSeq : -1;
      if (summaryLastSeq !== run.lastSeq) {
        lastSeqMismatches += 1;
      }
      const scenarios = new Set<string>();
      if (run.deliveryIds.length === 0) {
        if (run.kind === 'unattended') {
          scenarios.add('unattended');
        }
      } else {
        for (const deliveryId of run.deliveryIds) {
          const scenario = scenarioTurnOf(turnIdByDelivery.get(deliveryId) ?? null);
          if (scenario) {
            scenarios.add(scenario);
          }
        }
      }
      const seqs: number[] = [];
      for (const event of run.events) {
        if (typeof event.seq === 'number') {
          seqs.push(event.seq);
        }
        if (event.runId !== run.runId) {
          framesWithWrongRunIdField += 1;
        }
        const text = typeof event.text === 'string' ? event.text : null;
        const turn = text ? markerTurn.get(text) : undefined;
        if (!turn) {
          // A terminal `complete` carries no marker; it is attributed by the run
          // it was written through, which the registry stamped itself.
          continue;
        }
        markersInRuns += 1;
        if (!scenarios.has(turn)) {
          framesWithForeignRunId += 1;
        }
      }
      if (seqs.length > 0) {
        runsWithFrames += 1;
        if (!seqs.every((seq, index) => seq === index + 1)) {
          seqGaps += 1;
        }
      }
      say(
        `(e) run=${runId.slice(0, 8)} session=${run.sessionId} kind=${run.kind} ` +
          `deliveries=${run.deliveryIds.length} scenarios=${JSON.stringify([...scenarios])} ` +
          `frames=${run.events.length} lastSeq=${run.lastSeq}`,
      );
    }
    const markersEmitted = [...markersByTurn.values()].reduce((total, list) => total + list.length, 0);
    say(
      `(e) framesWithForeignRunId=${framesWithForeignRunId} seqGaps=${seqGaps} ` +
        `markersInRuns=${markersInRuns} markersEmitted=${markersEmitted} runsWithFrames=${runsWithFrames} ` +
        `lastSeqMismatches=${lastSeqMismatches} framesWithWrongRunIdField=${framesWithWrongRunIdField}`,
    );

    // ---------------------------------------------------------------------
    // (f) The `startRun` spy.
    // ---------------------------------------------------------------------
    const residentStartRunCalls = startRunCalls;
    const runsMinted = mintedRuns.length;
    say(
      `(f) supersedeRunningCalls=${supersedeRunningCalls} startRunCalls=${residentStartRunCalls} ` +
        `runsMinted=${runsMinted} registryRuns=${chatRunRegistry.listRecentRuns().length}`,
    );

    // =====================================================================
    // Assertions — readings first, so a red lands on the reading that is wrong.
    // =====================================================================

    // (a)
    assert.strictEqual(idleTurnCount, 1, `the idle send must be one turn (read ${idleTurnCount})`);
    assert.strictEqual(idleRuns, 1, `the idle send must leave exactly one run (read ${idleRuns})`);
    assert.strictEqual(idleRun.kind, 'delivered', 'an idle send\'s turn is a delivered one');
    assert.deepStrictEqual(
      sorted(idleRun.deliveryIds),
      sorted([idleDeliveryId]),
      'the idle run\'s deliveries must be exactly that send',
    );

    // (b)
    assert.strictEqual(mergedRuns, 1, `the drained-and-merged path must mint exactly one run (read ${mergedRuns})`);
    assert.ok(mergedRun, 'the merged turn must have a run of its own');
    assert.deepStrictEqual(
      sorted(mergedRun.deliveryIds),
      sorted([deliveryB, deliveryC]),
      'the merged run\'s deliveries must be exactly the two busy sends, in any order',
    );
    assert.deepStrictEqual(
      queuedTiers,
      ['later', 'later'],
      'both busy writes must have carried the `later` tier the scenario named',
    );
    for (const deliveryId of [deliveryB, deliveryC]) {
      const delivery = ledgerDeliveries().find((candidate) => candidate.deliveryId === deliveryId);
      assert.ok(delivery, `delivery ${deliveryId} must be in the ledger`);
      assert.strictEqual(delivery.state, 'completed', `delivery ${deliveryId} must reach its own terminal`);
    }
    // Both deliveries were drained into the SAME turn, so they share one turn
    // binding — which is the binding the merged run's `deliveryIds` was taken from.
    const turnOfB = ledgerDeliveries().find((d) => d.deliveryId === deliveryB)?.turnId ?? null;
    const turnOfC = ledgerDeliveries().find((d) => d.deliveryId === deliveryC)?.turnId ?? null;
    assert.ok(turnOfB, 'delivery B must carry a turn binding');
    assert.strictEqual(turnOfC, turnOfB, 'the two drained deliveries must share one turn binding');

    // (c)
    assert.strictEqual(nextRunsAdded, 0, `a next fold must not mint a run (read ${nextRunsAdded})`);
    assert.strictEqual(
      nextDeliveryRunId,
      openTurnRunId,
      'the folded delivery must be bound to the OPEN TURN\'s run',
    );
    const nextTier = (driver.busyInputReading(SESSION_ID)?.queuedInputs ?? []).at(-1)?.priority;
    assert.strictEqual(nextTier, 'next', 'the `next` send must have carried the `next` tier');

    // (d)
    assert.ok(unattendedRun, 'a turn nobody pushed must open a run');
    assert.strictEqual(unattendedRun.source, 'unattended', 'that run\'s source must say it was the host\'s turn');
    assert.strictEqual(unattendedRun.kind, 'unattended', 'and its kind must say the same');
    assert.deepStrictEqual(unattendedRun.deliveryIds, [], 'an unattended turn is bound to no delivery');

    // (g)
    assert.strictEqual(runCallsAfterPerRunSecond, runCallsBeforePerRunSecond, 'a refused busy send must not enter the provider');
    assert.strictEqual(perRunSecond.ok, false, 'a per-run session refuses the second send');
    if (!perRunSecond.ok) {
      assert.strictEqual(perRunSecond.code, 'RUN_IN_PROGRESS');
    }
    assert.strictEqual(perRunDeliveries, 1, `one per-run send must hold exactly one delivery (read ${perRunDeliveries})`);
    assert.strictEqual(perRunRuns, 1, `one per-run send must mint exactly one run (read ${perRunRuns})`);

    // (e)
    assert.strictEqual(
      framesWithForeignRunId,
      0,
      `no frame may be recorded in a run that does not cover its turn (read ${framesWithForeignRunId})`,
    );
    assert.strictEqual(seqGaps, 0, `every run's seq must run 1..n with no gap (gaps read ${seqGaps})`);
    assert.strictEqual(
      lastSeqMismatches,
      0,
      `the by-id projection and the run's own log must agree on lastSeq (mismatches ${lastSeqMismatches})`,
    );
    assert.strictEqual(
      framesWithWrongRunIdField,
      0,
      `every frame must carry its own run's id (read ${framesWithWrongRunIdField})`,
    );
    assert.strictEqual(
      markersInRuns,
      markersEmitted,
      `every emitted frame must be recorded in a run (recorded ${markersInRuns} of ${markersEmitted})`,
    );
    assert.ok(markersEmitted > 0, 'the scenario must have emitted frames for the attribution to be about anything');

    // (f)
    assert.strictEqual(
      supersedeRunningCalls,
      0,
      `no superseding run may be opened for a resident session (read ${supersedeRunningCalls})`,
    );
    assert.strictEqual(
      startRunCalls,
      runsMinted,
      `every startRun call must have minted a run (${startRunCalls} calls, ${runsMinted} mints)`,
    );
    assert.strictEqual(
      runsMinted,
      chatRunRegistry.listRecentRuns().length,
      'the runs this scenario minted must be exactly the runs the registry holds',
    );

    say(`[readings] elapsed=${Date.now() - STARTED_AT}ms`);
  } finally {
    chatRunRegistry.startRun = realStartRun;
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < ELAPSED_LIMIT_MS, `the criterion finished in ${elapsed}ms, under its ${ELAPSED_LIMIT_MS}ms budget`);
});
