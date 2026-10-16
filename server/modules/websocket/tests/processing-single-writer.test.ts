/**
 * AC-384 criterion —「处理中」单写者 (SPEC §3.1 第 4 条, §4.3, §4.4 I6, §12 S2).
 *
 * The claim: the ledger is the ONE writer of "处理中". `processing(session) :=
 * turn.open ∨ ∃ delivery ∈ {pushed, queued, started}` is computed inside the
 * resident driver's ledger and published per session; the six readers of the
 * old six-judgement world are all its projections — the run registry's own
 * `isProcessing` and `listRunningRuns`, the `/api/providers/sessions/running`
 * route, the host's `turn` lease, the heartbeat frame's `isProcessing`, and the
 * MCP `overview` running set — with the scheduled-message dispatcher's gate
 * read through the same bit.
 *
 * The readings are taken through the REAL chat control service, the REAL run
 * registry (the process-wide singleton the production dispatch uses), the REAL
 * session-host manager's lease reading, the REAL heartbeat frame assembly, the
 * REAL `buildOverview` and the REAL `dispatchQueuedMessages`, over a scripted
 * fake `claude` process driven through the real `ClaudeResidentHostDriver` (its
 * real `run` entry, its real message-fold loop, its real ledger). Nothing is a
 * double of a reader: a leg that read a copy would be reading its own copy of
 * the rule, which is exactly the defect this task removes.
 *
 * The legs, each read before anything is asserted:
 *
 *   (a) 活动中: every scenario reads all six TRUE — `activeDivergence=0`;
 *   (b) 静止后: every scenario reads all six FALSE / empty (I1) —
 *       `restDivergence=0`, `restSamples>=7`, and no two readers disagree at any
 *       checkpoint;
 *   (c) 空档腿: a send the CLI has been handed but whose `system/init` is held
 *       back is ALREADY processing on all six — `preInitActiveSamples>0`,
 *       `gapSamples=0`;
 *   (d) 调度器腿: a persisted queued message is claimed and sent exactly once at
 *       rest, not twice, and not while the session is processing;
 *   (e) 同源腿: the six read the same predicate at every checkpoint, and the
 *       host's `turn` leases are the ledger's own open set (zero at rest);
 *   (f) the two false forms are documented in the completion record — reverting
 *       `isProcessing` to a run's own `status` reds (c)'s `preInitActiveSamples`,
 *       and latching one reader reds (b)'s `restDivergence`.
 *
 * Red lines, as in the sibling resident criteria:
 * - the process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, so a lifecycle that hangs is a budget kill with its own
 *   reading;
 * - every reading is collected before it is asserted, so a red lands on the
 *   reading that is wrong rather than on a timeout or on an earlier leg.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { buildOverview } from '@/modules/mcp-gateway/index.js';
import type { McpOverviewReadDeps } from '@/modules/mcp-gateway/index.js';
import { ClaudeResidentHostDriver } from '@/modules/providers/index.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  getArchivedProjectsWithSessions,
  getProjectSessionsPage,
  getProjectsWithSessions,
} from '@/modules/projects/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import { attachActivityHeartbeat } from '@/modules/websocket/services/activity-heartbeat.service.js';
import {
  chatRunRegistry,
  residentRunIsTurn,
} from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION_ID = 'processing-single-writer-resident';
/** The provider-native id the scripted stream keys its frames by. */
const PROVIDER_SESSION_ID = 'ac384f00-0000-4000-8000-000000000001';

/** The caller shape `send` takes: an authenticated WebSocket front end. */
const CALLER = { userId: 1, via: 'websocket' as const };

/** The bound this criterion reports itself against (SPEC §11: the gate's 60 s, minus margin). */
const ELAPSED_LIMIT_MS = 45_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the single-writer criterion did not ` +
      'finish inside its process budget (a process-level kill, not a node:test case failure).',
  );
  process.exit(3);
}, ELAPSED_LIMIT_MS - 1_000);
budgetGuard.unref();

// Stated in the module body, which runs after every import above has been
// evaluated — the same reason the implementation reads the variable at CALL
// time rather than caching it at load.
process.env.RESIDENT_RUN_IS_TURN = '1';

/** One line of readings. The readings are the evidence; the assertions follow them. */
function say(line: string): void {
  console.log(`single-writer ${line}`);
}

// ---------------------------------------------------------------------------
// Scripted resident process
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this criterion is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * The process the arm owns: a stream it pushes into, in order, and can end.
 *
 * `finish()` resolves the pending read with `done`, which is what makes a
 * process exit something this criterion performs rather than waits for.
 */
function createFakeProcess(): {
  factory: ClaudeResidentProcessFactory;
  emit(frame: AnyRecord): void;
  finish(): void;
} {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  let ended = false;
  let endWaiter: (() => void) | null = null;

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
      if (ended) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
        endWaiter = () => resolve({ value: undefined, done: true });
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
    factory: () => ({ query, pid: 4384 }) satisfies ClaudeResidentProcess,
    emit: push,
    finish: () => {
      ended = true;
      endWaiter?.();
    },
  };
}

/**
 * The runtime's turn inputs, stubbed to the facts this arm's driver asks for.
 *
 * `normalizeMessage` is the one non-empty stub: a scripted frame carrying a
 * `marker` string becomes exactly one client-facing frame. It exists because the
 * driver's forward path calls it for every frame, and an empty normalizer would
 * make the frame forwarding a no-op this criterion does not mean to measure.
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
// The six readers
// ---------------------------------------------------------------------------

/** One reading of the six, plus the ledger's own answer at that same instant. */
type Readers = {
  registry: boolean;
  listRunning: boolean;
  runningApi: boolean;
  lease: boolean;
  heartbeat: boolean;
  overview: boolean;
};

type Sample = {
  label: string;
  phase: 'active' | 'rest' | 'gap';
  readers: Readers;
  ledger: boolean;
  /** How many `turn` leases the manager holds — the reading (e) projects. */
  turnLeases: number;
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  control: ReturnType<typeof createChatControlService>;
  emit(frame: AnyRecord): void;
  finish(): void;
  /** Reads the six readers, in the order the AC names them. */
  readReaders(): Promise<Readers>;
  /** The ledger's own `processing`, re-derived from the driver's reading. */
  ledgerProcessing(): boolean;
  /** How many `turn` leases the manager currently holds for the session. */
  turnLeases(): number;
  /** The delivery id of the most recent accepted send. */
  lastDeliveryId(): string;
  samples: Sample[];
  /** Collects a reading of the six and the ledger, and records it for the legs. */
  sample(label: string, phase: Sample['phase']): Promise<void>;
};

function createHarness(): Harness {
  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  // Both turn seams, wired exactly as the composition root wires them
  // (`server/index.ts`): the manager owns the call, the run registry answers it.
  manager.setTurnOpener((input) => chatRunRegistry.openTurn(input));
  manager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

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

  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    acceptsBusyInput: () => true,
    run: async (_provider: string, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) => {
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
      return driver.run(sessionId, { command, options }, writer, CONTEXT);
    },
    abort: async (_provider: LLMProvider, sessionId: string) => {
      // The resident abort path, exactly as the runtime takes it: the turn's
      // process is held, only the turn in flight is asked to stop.
      const host = manager.liveHostForSession(sessionId);
      if (!host) {
        return false;
      }
      return driver.interrupt(host, sessionId);
    },
    queuedInputUuid: async (_provider: LLMProvider, sessionId: string) => {
      const queued = driver.busyInputReading(sessionId)?.queuedInputs ?? [];
      return queued.at(-1)?.uuid ?? null;
    },
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };

  const control = createChatControlService({ runtime });

  /**
   * The heartbeat reader: the REAL frame assembly, read synchronously.
   *
   * `attachActivityHeartbeat` is handed a fake socket and the SAME injected
   * predicate the production gateway injects
   * (`() => chatRunRegistry.isProcessing(sessionId)`), and `setInterval` is
   * captured rather than scheduled so each sample can take exactly one beat
   * without waiting on a clock.
   */
  const heartbeatFrames: AnyRecord[] = [];
  const fakeSocket = {
    readyState: 1,
    send: (raw: string) => {
      heartbeatFrames.push(JSON.parse(raw) as AnyRecord);
    },
    on: () => undefined,
    off: () => undefined,
  };
  let beat: (() => void) | null = null;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((handler: () => void) => {
    beat = handler;
    return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  try {
    attachActivityHeartbeat(
      fakeSocket as never,
      SESSION_ID,
      () => chatRunRegistry.isProcessing(SESSION_ID),
    );
  } finally {
    globalThis.setInterval = realSetInterval;
  }

  const overviewDeps: McpOverviewReadDeps = {
    now: () => Date.now(),
    sessions: sessionsService,
    hosts: manager,
    projects: {
      getProjectsWithSessions,
      getArchivedProjectsWithSessions,
      getProjectSessionsPage,
      getProjectIdByPath: (projectPath: string) => projectsDb.getProjectPath(projectPath)?.project_id ?? null,
    } as McpOverviewReadDeps['projects'],
    activity: { snapshot: () => null },
    quay: { hasQuayConfig: () => false, readCached: () => null },
    runs: {
      listRunningRuns: () => chatRunRegistry.listRunningRuns(),
      listRecentRuns: () => chatRunRegistry.listRecentRuns(),
    },
  };

  const samples: Sample[] = [];

  const turnLeases = (): number => {
    for (const host of manager.snapshot()) {
      const binding = host.bindings.get(SESSION_ID);
      if (binding) {
        return binding.leases.filter((lease) => lease.kind === 'turn').length;
      }
    }
    return 0;
  };

  const ledgerProcessing = (): boolean => {
    const ledger = driver.ledgerReading(SESSION_ID);
    if (!ledger) {
      // A host that is gone still answers: what it left open is nothing.
      return false;
    }
    return ledger.turn?.open === true
      || ledger.deliveries.some((delivery) => delivery.state !== 'completed' && delivery.state !== 'cancelled');
  };

  const readReaders = async (): Promise<Readers> => {
    const running = chatRunRegistry.listRunningRuns();
    // One beat, read off the frame the production assembly would have sent.
    heartbeatFrames.length = 0;
    beat?.();
    const heartbeatFrame = heartbeatFrames.at(-1);
    const overview = await buildOverview(overviewDeps);
    return {
      registry: chatRunRegistry.isProcessing(SESSION_ID),
      listRunning: running.some((run) => run.sessionId === SESSION_ID),
      runningApi: sessionsService.listRunningSessions().some((run) => run.sessionId === SESSION_ID),
      lease: turnLeases() > 0,
      heartbeat: heartbeatFrame?.isProcessing === true,
      overview: overview.running.some((row) => row.sessionId === SESSION_ID),
    };
  };

  /** The six readings as the AC names them, one line per checkpoint. */
  const describe = (readers: Readers): string =>
    '{registry:' + Number(readers.registry)
    + ',listRunning:' + Number(readers.listRunning)
    + ',runningApi:' + Number(readers.runningApi)
    + ',lease:' + Number(readers.lease)
    + ',heartbeat:' + Number(readers.heartbeat)
    + ',overview:' + Number(readers.overview) + '}';

  const sample = async (label: string, phase: Sample['phase']): Promise<void> => {
    const readers = await readReaders();
    const row: Sample = { label, phase, readers, ledger: ledgerProcessing(), turnLeases: turnLeases() };
    samples.push(row);
    const family = phase === 'active' ? 'activeReaders' : phase === 'rest' ? 'restReaders' : 'gapReaders';
    say(`${family}[${label}]=${describe(readers)} ledger=${Number(row.ledger)} turnLeases=${row.turnLeases}`);
  };

  return {
    manager,
    driver,
    control,
    emit: process.emit,
    finish: process.finish,
    readReaders,
    ledgerProcessing,
    turnLeases,
    lastDeliveryId: () => {
      const ledger = driver.ledgerReading(SESSION_ID);
      assert.ok(ledger, 'the resident host must be live and readable');
      const delivery = ledger.deliveries.at(-1);
      assert.ok(delivery, 'the ledger must hold the delivery of the send just made');
      return delivery.deliveryId;
    },
    samples,
    sample,
  };
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

test('AC-384 the ledger is the single writer of 「处理中」: six readers, one predicate', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'processing-single-writer-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const now = new Date().toISOString();
  sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Single-writer resident session', now, now, null);
  const user = userDb.createUser('single-writer', 'hash');
  const userId = Number(user.id);

  chatRunRegistry.clearAll();
  const harness = createHarness();
  const { driver, control, emit } = harness;

  /** The lifecycle frame the CLI emits for one command's state. */
  const lifecycle = (commandUuid: string, state: string): AnyRecord =>
    ({ type: 'command_lifecycle', command_uuid: commandUuid, state });
  /** The turn's opening, as the CLI states it. */
  const init = (uuid: string): AnyRecord =>
    ({ type: 'system', subtype: 'init', uuid, session_id: PROVIDER_SESSION_ID });
  /** The turn's ending, as the CLI states it. */
  const result = (isError = false): AnyRecord =>
    ({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, session_id: PROVIDER_SESSION_ID });
  const assistant = (marker: string): AnyRecord =>
    ({ type: 'assistant', session_id: PROVIDER_SESSION_ID, marker });

  /** Sends one turn and walks its lifecycle to a clean terminal. */
  const runTurn = async (command: string, label: string): Promise<void> => {
    const send = await control.send(CALLER, { sessionId: SESSION_ID, content: command });
    assert.ok(send.ok, `the send must be accepted (got ${JSON.stringify(send)})`);
    await settle();
    const deliveryId = harness.lastDeliveryId();
    emit(lifecycle(deliveryId, 'queued'));
    emit(lifecycle(deliveryId, 'started'));
    emit(init(`ac384-init-${label}`));
    emit(assistant(`m-${label}`));
    await settle();
    await harness.sample(label, 'active');
    emit(result());
    await settle();
    emit(lifecycle(deliveryId, 'completed'));
    await settle();
    await harness.sample(label, 'rest');
  };

  try {
    say(`(flags) residentRunIsTurn=${residentRunIsTurn()} pid=${process.pid}`);

    // ---------------------------------------------------------------------
    // (a)/(b) 场景矩阵: idle cold, idle warm, merge, fold.
    // ---------------------------------------------------------------------
    await runTurn('AC384 idle cold send', 'idleCold');
    await runTurn('AC384 idle warm send', 'idleWarm');

    // 忙时两条 `later` 排空合并: the opener's turn ends, the CLI drains the two
    // queued commands into a turn of its own — and the window between those two
    // events is leg (c)'s subject.
    const opener = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC384 merge opener' });
    assert.ok(opener.ok, `the merge opener must be accepted (got ${JSON.stringify(opener)})`);
    await settle();
    const openerDelivery = harness.lastDeliveryId();
    emit(lifecycle(openerDelivery, 'queued'));
    emit(lifecycle(openerDelivery, 'started'));
    emit(init('ac384-init-merge-opener'));
    emit(assistant('m-merge-opener'));
    await settle();
    await harness.sample('mergeOpener', 'active');

    const laterB = await control.send(CALLER, {
      sessionId: SESSION_ID,
      content: 'AC384 later B',
      options: { priority: 'later' },
    });
    const laterC = await control.send(CALLER, {
      sessionId: SESSION_ID,
      content: 'AC384 later C',
      options: { priority: 'later' },
    });
    assert.ok(laterB.ok && laterC.ok, 'both busy later sends must be accepted');
    await settle();
    const deliveryB = laterB.ok ? laterB.queuedMessageUuid : null;
    const deliveryC = laterC.ok ? laterC.queuedMessageUuid : null;
    assert.ok(deliveryB && deliveryC, 'both busy sends must answer with the uuid they were queued under');
    emit(lifecycle(deliveryB, 'queued'));
    emit(lifecycle(deliveryC, 'queued'));
    await settle();

    // The opener's turn ends. Its run completes; B and C are still owed.
    emit(result());
    await settle();
    emit(lifecycle(openerDelivery, 'completed'));
    await settle();

    // ---------------------------------------------------------------------
    // (c) 空档腿: the CLI has been handed B and C; their `system/init` is held
    //     back until this criterion releases it. The session must read
    //     processing on ALL SIX for the whole window.
    // ---------------------------------------------------------------------
    const gapSamplesBefore = harness.samples.length;
    await harness.sample('gap#1', 'gap');
    await harness.sample('gap#2', 'gap');
    say(
      `(c) gapWindowSamplesTaken=${harness.samples.length - gapSamplesBefore} ` +
        `ledgerAtGap=${Number(harness.ledgerProcessing())}`,
    );
    assert.strictEqual(harness.ledgerProcessing(), true, 'the ledger must call the drained window processing');

    // 放闸: the merged turn opens, runs, and ends.
    emit(lifecycle(deliveryB, 'started'));
    emit(lifecycle(deliveryC, 'started'));
    emit(init('ac384-init-merged'));
    emit(assistant('m-merged'));
    await settle();
    await harness.sample('merged', 'active');
    emit(result());
    await settle();
    emit(lifecycle(deliveryB, 'completed'));
    emit(lifecycle(deliveryC, 'completed'));
    await settle();
    await harness.sample('mergedRest', 'rest');

    // `next` 忙时折叠: the command runs inside the open turn, sharing its run.
    const foldOpener = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC384 fold opener' });
    assert.ok(foldOpener.ok, 'the fold opener must be accepted');
    await settle();
    const foldOpenerDelivery = harness.lastDeliveryId();
    emit(lifecycle(foldOpenerDelivery, 'queued'));
    emit(lifecycle(foldOpenerDelivery, 'started'));
    emit(init('ac384-init-fold'));
    emit(assistant('m-fold'));
    await settle();
    const nextSend = await control.send(CALLER, {
      sessionId: SESSION_ID,
      content: 'AC384 next fold',
      options: { priority: 'next' },
    });
    assert.ok(nextSend.ok, 'the next send must be accepted');
    await settle();
    const foldedDelivery = nextSend.ok ? nextSend.queuedMessageUuid : null;
    assert.ok(foldedDelivery, 'the next send must answer with its delivery id');
    emit(lifecycle(foldedDelivery, 'started'));
    emit(assistant('m-fold-2'));
    await settle();
    await harness.sample('fold', 'active');
    emit(result());
    await settle();
    emit(lifecycle(foldedDelivery, 'completed'));
    emit(lifecycle(foldOpenerDelivery, 'completed'));
    await settle();
    await harness.sample('foldRest', 'rest');

    // ---------------------------------------------------------------------
    // interrupt: the request does not本身 clear anything; the CLI's own
    // `RESULT` and terminal do (§6.3).
    // ---------------------------------------------------------------------
    const interruptSend = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC384 interrupt me' });
    assert.ok(interruptSend.ok, 'the interrupt turn\'s send must be accepted');
    await settle();
    const interruptDelivery = harness.lastDeliveryId();
    emit(lifecycle(interruptDelivery, 'queued'));
    emit(lifecycle(interruptDelivery, 'started'));
    emit(init('ac384-init-interrupt'));
    emit(assistant('m-interrupt'));
    await settle();
    await harness.sample('interrupt', 'active');
    const abortVerdict = await control.abort(CALLER, { sessionId: SESSION_ID });
    say(`(scenario) interrupt abortVerdict=${JSON.stringify(abortVerdict)}`);
    emit(result(true));
    await settle();
    emit(lifecycle(interruptDelivery, 'cancelled'));
    await settle();
    await harness.sample('interruptRest', 'rest');

    // ---------------------------------------------------------------------
    // 无人 turn: a turn nobody pushed is processing too.
    // ---------------------------------------------------------------------
    emit(init('ac384-init-unattended'));
    emit(assistant('m-unattended'));
    await settle();
    await harness.sample('unattended', 'active');
    emit(result());
    await settle();
    await harness.sample('unattendedRest', 'rest');

    // ---------------------------------------------------------------------
    // (d) 调度器腿.
    // ---------------------------------------------------------------------
    let sendCalls = 0;
    const spyControl = {
      send: (caller: Parameters<typeof control.send>[0], input: Parameters<typeof control.send>[1]) => {
        sendCalls += 1;
        return control.send(caller, input);
      },
    };

    // (d3) first, while a turn is in flight: the ledger says processing, so the
    // dispatcher must not steal the queued message.
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'AC384 queued while active', options: {}, attachments: [] },
    });
    const activeTurn = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC384 active holder' });
    assert.ok(activeTurn.ok, 'the holder send must be accepted');
    await settle();
    const holderDelivery = harness.lastDeliveryId();
    emit(lifecycle(holderDelivery, 'queued'));
    emit(lifecycle(holderDelivery, 'started'));
    emit(init('ac384-init-holder'));
    await settle();
    const claimedWhileActive = await dispatchQueuedMessages(spyControl);
    const sendCallsWhileActive = sendCalls;
    await harness.sample('dispatcherActive', 'active');
    emit(result());
    await settle();
    emit(lifecycle(holderDelivery, 'completed'));
    await settle();
    await harness.sample('dispatcherActiveRest', 'rest');

    // (d1) at rest: claimed once, sent once. (d2): a second pass claims nothing.
    const firstPass = dispatchQueuedMessages(spyControl);
    await settle();
    const queuedDelivery = harness.lastDeliveryId();
    emit(lifecycle(queuedDelivery, 'queued'));
    emit(lifecycle(queuedDelivery, 'started'));
    emit(init('ac384-init-queued'));
    emit(assistant('m-queued'));
    await settle();
    emit(result());
    await settle();
    emit(lifecycle(queuedDelivery, 'completed'));
    const claimedAtRest = await firstPass;
    await settle();
    const secondPass = await dispatchQueuedMessages(spyControl);
    const sendCallsAfterSecond = sendCalls;
    await harness.sample('dispatcherRest', 'rest');

    // ---------------------------------------------------------------------
    // (e) 同源腿: leases are the ledger's own open set.
    // ---------------------------------------------------------------------
    // §5.4: a `turn` lease is held exactly while the ledger says processing —
    // the projection, sampled at EVERY checkpoint rather than at the endpoints.
    const leaseProjectionMismatches = harness.samples.filter(
      (row) => (row.turnLeases > 0) !== row.ledger,
    ).length;
    const leaseSamples = harness.samples.map((row) => `${row.label}:${row.turnLeases}${row.ledger ? '(p)' : ''}`);
    say(`(e) leaseSamples=${JSON.stringify(leaseSamples)} leaseProjectionMismatches=${leaseProjectionMismatches}`);

    // ---------------------------------------------------------------------
    // 进程退出: everything the ledger is carrying ends, and nothing is left.
    // ---------------------------------------------------------------------
    harness.finish();
    await settle();
    await harness.sample('processExitRest', 'rest');

    // =====================================================================
    // Readings, summarised before anything is asserted.
    // =====================================================================
    const readerKeys: Array<keyof Readers> = [
      'registry',
      'listRunning',
      'runningApi',
      'lease',
      'heartbeat',
      'overview',
    ];

    /** Whether the six agree with one another. */
    const agree = (row: Sample): boolean =>
      readerKeys.every((key) => row.readers[key] === row.readers[readerKeys[0]]);

    const activeSamples = harness.samples.filter((row) => row.phase === 'active');
    const restSamples = harness.samples.filter((row) => row.phase === 'rest');
    const gapWindowSamples = harness.samples.filter((row) => row.phase === 'gap');

    const activeDivergence = activeSamples.filter((row) => !agree(row)).length;
    const activeAllTrue = activeSamples.filter((row) => readerKeys.every((key) => row.readers[key])).length;
    const restDivergence = restSamples.filter(
      (row) => !agree(row) || readerKeys.some((key) => row.readers[key]),
    ).length;
    const restAllFalse = restSamples.filter((row) => readerKeys.every((key) => !row.readers[key])).length;
    const disagreementSamples = harness.samples.filter((row) => row.phase !== 'gap' && !agree(row)).length;
    const preInitActiveSamples = gapWindowSamples.filter((row) => readerKeys.every((key) => row.readers[key])).length;
    // The AC's `gapSamples`: a checkpoint in the window that read IDLE anywhere.
    const gapSamples = gapWindowSamples.filter((row) => readerKeys.some((key) => !row.readers[key])).length;
    const leaseHeldAtRest = restSamples.reduce((max, row) => Math.max(max, row.turnLeases), 0);

    say(
      `(a) activeSamples=${activeSamples.length} activeAllTrue=${activeAllTrue} activeDivergence=${activeDivergence}`,
    );
    say(
      `(b) restSamples=${restSamples.length} restAllFalse=${restAllFalse} restDivergence=${restDivergence} ` +
        `disagreementSamples=${disagreementSamples}`,
    );
    say(
      `(c) gapWindowSamples=${gapWindowSamples.length} preInitActiveSamples=${preInitActiveSamples} ` +
        `gapSamples=${gapSamples}`,
    );
    say(
      `(d) claimedWhileActive=${claimedWhileActive} sendCallsWhileActive=${sendCallsWhileActive} ` +
        `claimedAtRest=${claimedAtRest} claimedSecondRun=${secondPass} sendCalls=${sendCallsAfterSecond}`,
    );
    say(`(e) leaseHeldAtRest=${leaseHeldAtRest}`);

    // =====================================================================
    // Assertions — (c) first, then (b), then (a), (d), (e): a red lands on
    // the reading that is wrong, in the order the legs are numbered.
    // =====================================================================

    // (c)
    assert.ok(gapWindowSamples.length > 0, 'the gap window must have been sampled');
    assert.strictEqual(
      gapSamples,
      0,
      `no reader may read idle while a send is accepted and its init is held back (read ${gapSamples})`,
    );
    assert.ok(
      preInitActiveSamples > 0,
      `all six must read processing in the pre-init window (read ${preInitActiveSamples} of ${gapWindowSamples.length})`,
    );

    // (b)
    assert.ok(restSamples.length >= 7, `at least seven rest samples are required (read ${restSamples.length})`);
    assert.strictEqual(
      restDivergence,
      0,
      `every rest sample must read all six false/empty (divergences ${restDivergence})`,
    );
    assert.strictEqual(
      restAllFalse,
      restSamples.length,
      `every rest sample must read all six false (read ${restAllFalse} of ${restSamples.length})`,
    );
    assert.strictEqual(
      disagreementSamples,
      0,
      `no two readers may disagree at any checkpoint (read ${disagreementSamples})`,
    );

    // (a)
    assert.ok(activeSamples.length >= 3, `the scenario matrix must sample activity (read ${activeSamples.length})`);
    assert.strictEqual(
      activeDivergence,
      0,
      `every active sample must read all six true (divergences ${activeDivergence})`,
    );
    assert.strictEqual(
      activeAllTrue,
      activeSamples.length,
      `every active sample must read all six true (read ${activeAllTrue} of ${activeSamples.length})`,
    );

    // (d)
    assert.strictEqual(claimedWhileActive, 0, 'a processing session must not have its queued message stolen');
    assert.strictEqual(sendCallsWhileActive, 0, 'the dispatcher must not send while the session is processing');
    assert.strictEqual(claimedAtRest, 1, `the queued message must be claimed once at rest (read ${claimedAtRest})`);
    assert.strictEqual(secondPass, 0, `a second pass must claim nothing (read ${secondPass})`);
    assert.strictEqual(sendCallsAfterSecond, 1, `the queued message must be sent exactly once (read ${sendCallsAfterSecond})`);

    // (e)
    assert.strictEqual(leaseHeldAtRest, 0, `no turn lease may be held at rest (read ${leaseHeldAtRest})`);
    assert.strictEqual(
      leaseProjectionMismatches,
      0,
      `the turn lease must be held exactly while the ledger says processing (mismatches ${leaseProjectionMismatches})`,
    );

    say(`[readings] elapsed=${Date.now() - STARTED_AT}ms`);
  } finally {
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
