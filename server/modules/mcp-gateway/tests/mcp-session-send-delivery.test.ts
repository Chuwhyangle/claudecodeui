/**
 * AC-385 criterion — the S3 API flip (SPEC §4.1, §4.2, §5.2, §6.1, §8.1–§8.3, §13.1).
 *
 * The claim: every ACCEPTED send answers with a `deliveryId` — the `commandUuid`
 * the host minted for the frame it wrote and the CLI echoes back in
 * `command_lifecycle` — and with a `runId` that is the turn's while the turn is
 * bound, the delivery id while it is not (the compatibility window), and `null`
 * once that window closes. A refused send produces no delivery at all, and the
 * optional `correlationId` label belongs to the delivery rather than to a run.
 *
 * The reading is taken through the REAL control service, the REAL run registry
 * and the REAL resident host driver, with the PROCESS injected: a scripted fake
 * `claude` host whose stream this criterion drives by hand. No `WebSocket` is
 * built anywhere — `chatControlService.send` is called directly and the three MCP
 * builders (`buildSessionSend` / `buildSessionCreate` / `buildDraftSubmit`) are
 * mounted on that same seam, exactly as `write-tools.ts` mounts them on the
 * process singletons.
 *
 * WHERE THE COMMAND IDENTITY IS READ FROM. The host's own ledger
 * (`driver.ledgerReading`) is the authority on which `commandUuid` a send was
 * written under, and `driver.busyInputReading().queuedInputs` is the host's
 * separate record of a BUSY write's uuid. Both are read here — the API's
 * `deliveryId` must be a projection of one of them, never an id minted by the
 * adapter, which is what makes the equality a reading rather than a tautology.
 * The `command_lifecycle` frames this criterion emits are written under the id
 * read from the host, and the ledger entry's resulting state is read back, so
 * "the frame the CLI would send for this command" is shown to land on the same
 * delivery the API named.
 *
 * The legs, each a state observation taken before anything is asserted:
 *
 *   (a) the three entries         ⇒ each accepted send answers a `deliveryId`
 *                                   equal to the host's own command uuid, and a
 *                                   queued send answers `queuedMessageUuid ===
 *                                   deliveryId`;
 *   (b) a per-run provider        ⇒ `runId` is the registered run's, and the
 *                                   `deliveryId` is the uuid minted with it;
 *   (c) resident busy, and the window ⇒ (c1) while the window is open an unbound
 *                                   send's `runId` is never null and equals its
 *                                   `deliveryId`; (c2) past the window it is
 *                                   `null`, until the delivery binds a turn —
 *                                   which the EXISTING `run_get(runId)` then
 *                                   reads; (c3) the window's deadline constant is
 *                                   still in the future;
 *   (d) a refused send            ⇒ a `SESSION_BUSY` envelope naming no delivery,
 *                                   and the ledger's live delivery count
 *                                   unchanged;
 *   (e) `correlationId`           ⇒ the label is on the DELIVERY and the session
 *                                   is retrievable by it through the one reading
 *                                   `sessions/running` / `sessions_list` use.
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
import { buildDraftSubmit } from '@/modules/mcp-gateway/mcp-draft.js';
import type { McpDraftStore } from '@/modules/mcp-gateway/mcp-draft.js';
import { McpToolError } from '@/modules/mcp-gateway/mcp-error-envelope.js';
import type { McpPrincipal } from '@/modules/mcp-gateway/mcp-gateway.auth.js';
import { buildRunGet } from '@/modules/mcp-gateway/mcp-run-get.js';
import type { McpRunGetDeps } from '@/modules/mcp-gateway/mcp-run-get.js';
import { buildSessionCreate } from '@/modules/mcp-gateway/mcp-session-lifecycle.js';
import type { McpSessionCreateDeps } from '@/modules/mcp-gateway/mcp-session-lifecycle.js';
import { buildSessionSend } from '@/modules/mcp-gateway/mcp-session-send.js';
import type { McpSessionSendDeps } from '@/modules/mcp-gateway/mcp-session-send.js';
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import {
  chatRunRegistry,
  residentRunIsTurn,
} from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { RUN_ID_COMPAT_WINDOW_END_MS } from '@/shared/types.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const RESIDENT_SESSION_ID = 'ac385-send-delivery-resident';
/** The session the labelled send owns, so the run's OWNER delivery carries it. */
const LABEL_SESSION_ID = 'ac385-send-delivery-label';
/** The session the window-closed send opens, read back through `run_get`. */
const WINDOW_SESSION_ID = 'ac385-send-delivery-window';
/** The provider whose turns are a process each, never a queue (SPEC §6.1). */
const PER_RUN_SESSION_ID = 'ac385-send-delivery-per-run';
const PER_RUN_PROVIDER = 'debug-agent';
/** The provider-native id the scripted stream keys its frames by. */
const PROVIDER_SESSION_ID = 'ac385f00-0000-4000-8000-000000000001';
/** The project id `session_create` resolves through `deps.projects.list()`. */
const PROJECT_ID = 'ac385-project';
/** The one correlation label this criterion attaches. */
const LABEL = 'ac385-delivery-label';

/** The authenticated owner every builder call is made as. */
const PRINCIPAL: McpPrincipal = {
  userId: 1,
  tokenId: 11,
  clientId: 'ac385-client',
  scopes: ['send', 'create', 'draft'],
};

/** The bound this criterion reports itself against (SPEC §11: the gate's 60 s, minus margin). */
const ELAPSED_LIMIT_MS = 45_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the send/delivery criterion did not ` +
      'finish inside its process budget (a process-level kill, not a node:test case failure).',
  );
  process.exit(3);
}, ELAPSED_LIMIT_MS - 1_000);
budgetGuard.unref();

// Stated in the module body, which runs after every import above has been
// evaluated — the same reason the sibling criteria state it: a module-level
// constant on either side would answer the flag-off value here, and this
// criterion would measure the old path while believing it measured the new one.
process.env.RESIDENT_RUN_IS_TURN = '1';

/** One line of readings. The readings are the evidence; the assertions follow them. */
function say(line: string): void {
  console.log(`send-delivery ${line}`);
}

// ---------------------------------------------------------------------------
// Scripted resident process
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this criterion is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/** One host's stream, plus the `emit` that pushes a frame into it. */
type FakeStream = { query: ClaudeResidentQuery; emit(frame: AnyRecord): void };

/**
 * A stream the criterion pushes frames into, in order.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every reading
 * into a reading of a dead process.
 */
function makeStream(): FakeStream {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];

  const emit = (frame: AnyRecord): void => {
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

  return { query, emit };
}

/**
 * One stream PER HOST, addressed by the session the host serves.
 *
 * A single shared stream would let one host's read loop steal a frame meant for
 * another's — four resident sessions are started by this criterion, and a
 * `command_lifecycle` that landed on the wrong host's ledger is recorded as
 * foreign (the uuid is unknown there) rather than as the state transition it
 * was. The factory takes no argument, so the mapping is taken from the order the
 * dispatches reach the driver: a session the wrapper has not dispatched to before
 * is about to cold-start, and the next factory call is its process.
 */
function createStreamRegistry(): {
  factory: ClaudeResidentProcessFactory;
  noteDispatch(sessionId: string): void;
  emitTo(sessionId: string, frame: AnyRecord): void;
} {
  const streams = new Map<string, FakeStream>();
  const coldStarts: string[] = [];
  const dispatched = new Set<string>();

  return {
    factory: () => {
      const sessionId = coldStarts.shift() ?? `ac385-anonymous-${streams.size}`;
      const stream = makeStream();
      streams.set(sessionId, stream);
      return { query: stream.query, pid: 4242 } satisfies ClaudeResidentProcess;
    },
    noteDispatch: (sessionId: string) => {
      if (dispatched.has(sessionId)) {
        return;
      }
      dispatched.add(sessionId);
      coldStarts.push(sessionId);
    },
    emitTo: (sessionId: string, frame: AnyRecord) => {
      const stream = streams.get(sessionId);
      assert.ok(stream, `no scripted stream was opened for ${sessionId}`);
      stream.emit(frame);
    },
  };
}

/**
 * The runtime's turn inputs, stubbed to the facts this arm's driver asks for.
 *
 * `normalizeMessage` turns a scripted `marker` frame into one client-facing
 * frame and drops everything else: this criterion measures identity and binding,
 * not frame routing, and the real normalizer is AC-379's sentinel business.
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

/** A minimal in-memory `McpDraftStore`: this criterion is about the submit, not the store. */
function createDraftStore(): McpDraftStore {
  const rows = new Map<number, Map<string, { text: string; queuedMessage: unknown | null }>>();
  return {
    getDrafts(userId: number) {
      const byUser = rows.get(userId);
      if (!byUser) {
        return [];
      }
      return [...byUser.entries()].map(([scope, draft]) => ({
        scope,
        text: draft.text,
        queuedMessage: draft.queuedMessage,
      }));
    },
    saveDraft(userId, scope, draft) {
      const byUser = rows.get(userId) ?? new Map();
      byUser.set(scope, draft);
      rows.set(userId, byUser);
    },
  };
}

type Harness = {
  driver: ClaudeResidentHostDriver;
  /** The three MCP builders, all mounted on the one control seam. */
  deps: { send: McpSessionSendDeps; create: McpSessionCreateDeps; draft: McpDraftStore };
  emit(sessionId: string, frame: AnyRecord): void;
  /** The clock the compatibility window is judged against, movable past the deadline. */
  setNow(value: number): void;
  /** Whether a busy write is taken by the process, flippable for leg (d). */
  setBusyInputAllowed(value: boolean): void;
  perRunParked(): number;
  releaseParked(): void;
  /** The driver's own ledger for one session. */
  ledger(sessionId: string): ReturnType<ClaudeResidentHostDriver['ledgerReading']>;
};

function createHarness(projectPath: string): Harness {
  const manager: SessionHostManager = createSessionHostManager({
    now: () => 1_700_000_000_000,
    scheduler: inertScheduler(),
  });
  // The turn seam, wired exactly as the composition root wires it
  // (`server/index.ts`): the manager owns the call, the run registry answers it.
  manager.setTurnOpener((input) => chatRunRegistry.openTurn(input));

  const streams = createStreamRegistry();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: streams.factory,
    now: () => 1_700_000_000_000,
    connectedClientCount: () => 0,
  });

  /** The uuids this arm has already handed back through `queuedInputUuid`, per session. */
  const handedOut = new Map<string, string>();
  let busyInputAllowed = true;
  let currentNow = Date.now();
  let perRunParked = 0;
  const parked: Array<(value?: unknown) => void> = [];

  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    acceptsBusyInput: (provider: string) => busyInputAllowed && provider !== PER_RUN_PROVIDER,
    run: async (provider: string, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) => {
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
      if (provider === PER_RUN_PROVIDER) {
        perRunParked += 1;
        // Parked, so "a run is in flight" is a fact this arm holds rather than a
        // race it hopes for: the second send must meet a busy session.
        return new Promise<unknown>((resolve) => {
          parked.push(resolve);
        });
      }
      streams.noteDispatch(sessionId);
      return driver.run(sessionId, { command, options }, writer, CONTEXT);
    },
    abort: async () => false,
    // The uuid the provider stamped the just-queued message with. Polled rather
    // than read once because `send` asks for it BEFORE the driver has armed the
    // round — the control service resolves the send at `beforeRun`, and the write
    // into the process happens on the dispatch's own continuation — so the
    // reading waits for a uuid it has not handed out yet, bounded by the control
    // service's own handover timeout (the sibling resident criteria's shape).
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

  const control = createChatControlService({ runtime, now: () => currentNow });
  const seam = {
    send: (caller: Parameters<typeof control.send>[0], input: Parameters<typeof control.send>[1]) =>
      control.send(caller, input),
  };

  const runGetDeps: McpRunGetDeps = runGetDepsFor();

  return {
    driver,
    deps: {
      send: { control: seam, runs: chatRunRegistry, runGet: { deps: runGetDeps, build: buildRunGet } },
      create: {
        projects: { list: () => [{ id: PROJECT_ID, title: 'ac385', path: projectPath }] },
        sessions: {
          create: (provider, projectPathArg, initialMessage) => {
            const sessionId = `ac385-created-${sessionsDb.getAllSessions().length}`;
            const now = new Date().toISOString();
            sessionsDb.createSession(sessionId, provider, projectPathArg, initialMessage, now, now, null);
            return { sessionId };
          },
          switchLifecycle: () => undefined,
        },
        control: seam,
        runs: chatRunRegistry,
      },
      draft: createDraftStore(),
    },
    emit: streams.emitTo,
    setNow: (value: number) => {
      currentNow = value;
    },
    setBusyInputAllowed: (value: boolean) => {
      busyInputAllowed = value;
    },
    perRunParked: () => perRunParked,
    releaseParked: () => {
      for (const resolve of parked.splice(0)) {
        resolve();
      }
    },
    ledger: (sessionId: string) => driver.ledgerReading(sessionId),
  };
}

/**
 * The `run_get` deps the criterion reads the bound turn back through (leg c2).
 *
 * `bootId` answers the boot the REGISTRY recorded for the run being read, so the
 * restart check compares like with like and a run this process just minted is not
 * reported as one a restart swept past.
 */
function runGetDepsFor(runId?: string): McpRunGetDeps {
  const boot = runId === undefined ? null : chatRunRegistry.getRunBootId(runId);
  return {
    runs: chatRunRegistry,
    activity: { snapshot: () => null },
    sessions: { fetchHistory: async () => ({ messages: [] }) },
    now: () => 0,
    sleep: async () => undefined,
    bootId: () => boot ?? 'ac385-boot',
  };
}

/** Fails unless `value` is a non-empty string, narrowing it for the assertions below. */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    assert.fail(`${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

test('AC-385 every accepted send names its delivery; runId is the turn, the delivery, or null', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-session-send-delivery-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(RESIDENT_SESSION_ID, 'claude', tempDirectory, 'AC-385 resident', now, now, null);
    sessionsDb.createSession(LABEL_SESSION_ID, 'claude', tempDirectory, 'AC-385 labelled', now, now, null);
    sessionsDb.createSession(WINDOW_SESSION_ID, 'claude', tempDirectory, 'AC-385 window', now, now, null);
    sessionsDb.createSession(PER_RUN_SESSION_ID, PER_RUN_PROVIDER, tempDirectory, 'AC-385 per-run', now, now, null);

    chatRunRegistry.clearAll();
    const harness = createHarness(tempDirectory);
    const { deps, emit } = harness;

    /** The lifecycle frame the CLI emits for one command's state. */
    const lifecycle = (commandUuid: string, state: string): AnyRecord =>
      ({ type: 'command_lifecycle', command_uuid: commandUuid, state });

    /** The turn's ending, as the CLI states it. */
    const result = (): AnyRecord =>
      ({ type: 'result', subtype: 'success', is_error: false, session_id: PROVIDER_SESSION_ID });

    /** The turn's opening, as the CLI states it. */
    const init = (uuid: string): AnyRecord =>
      ({ type: 'system', subtype: 'init', uuid, session_id: PROVIDER_SESSION_ID });

    /** The delivery ids the driver's ledger holds for a session, in send order. */
    const ledgerDeliveryIds = (sessionId: string): string[] => {
      const reading = harness.ledger(sessionId);
      assert.ok(reading, `the ledger for ${sessionId} must be live and readable`);
      return reading.deliveries.map((delivery) => delivery.deliveryId);
    };

    /**
     * The `commandUuid` the HOST wrote the newest send for a session under.
     *
     * Read from the host's own ledger — the authority on which uuid a frame was
     * written under — and from its separate `queuedInputs` record when the write
     * was a busy one, so the two host-side accounts have to agree before the API
     * answer is compared against either.
     */
    const hostCommandUuid = (sessionId: string): string => {
      const ids = ledgerDeliveryIds(sessionId);
      const newest = ids.at(-1);
      assert.ok(newest !== undefined, `the host must have recorded the send for ${sessionId}`);
      return newest;
    };

    /** Every delivery the ledger still owes a terminal — leg (d)'s count. */
    const liveDeliveryCount = (sessionId: string): number => {
      const reading = harness.ledger(sessionId);
      assert.ok(reading, 'the ledger must be live');
      return reading.deliveries.filter(
        (delivery) => delivery.state !== 'completed' && delivery.state !== 'cancelled',
      ).length;
    };

    /** Whether the ledger's entry for one delivery reads `queued` — the frame landed on it. */
    const ledgerStateOf = (sessionId: string, deliveryId: string): string | null => {
      const entry = harness.ledger(sessionId)?.deliveries.find(
        (delivery) => delivery.deliveryId === deliveryId,
      );
      return entry?.state ?? null;
    };

    try {
      say(
        `(flags) residentRunIsTurn=${residentRunIsTurn()} deadline=${RUN_ID_COMPAT_WINDOW_END_MS} pid=${process.pid}`,
      );

      // -------------------------------------------------------------------
      // (a) The three entries: session_send, session_create (with a message)
      //     and draft_submit each answer the host's own command uuid.
      // -------------------------------------------------------------------
      // A warm-up send first, so the resident host is up and the session is
      // BUSY by the time the three entries below answer: the `queuedMessageUuid
      // === deliveryId` alias only exists on a queued send, and a criterion that
      // never queued anything would be reading it off a vacuous branch.
      const warmupPayload = await buildSessionSend(
        { session: RESIDENT_SESSION_ID, message: 'AC385 warmup' },
        { principal: PRINCIPAL },
        deps.send,
      );
      await settle();
      assertNonEmptyString(warmupPayload.deliveryId, 'the warm-up send must name its delivery');

      const sendPayload = await buildSessionSend(
        { session: RESIDENT_SESSION_ID, message: 'AC385 send' },
        { principal: PRINCIPAL },
        deps.send,
      );
      await settle();
      const sendUuid = hostCommandUuid(RESIDENT_SESSION_ID);
      emit(RESIDENT_SESSION_ID, lifecycle(sendUuid, 'queued'));
      await settle();
      const sendState = ledgerStateOf(RESIDENT_SESSION_ID, sendUuid);

      const createPayload = await buildSessionCreate(
        { project: PROJECT_ID, message: 'AC385 create' },
        { principal: PRINCIPAL },
        deps.create,
      );
      await settle();
      const createdSessionId = createPayload.sessionId;
      const createUuid = hostCommandUuid(createdSessionId);
      emit(createdSessionId, lifecycle(createUuid, 'queued'));
      await settle();
      const createState = ledgerStateOf(createdSessionId, createUuid);

      // The draft is seeded on the RESIDENT session, which the sends above have
      // made busy — so this third entry is the QUEUED one, and the alias reading
      // is taken on a send that really is queued.
      deps.draft.saveDraft(PRINCIPAL.userId, RESIDENT_SESSION_ID, { text: 'AC385 draft', queuedMessage: null });
      const draftPayload = await buildDraftSubmit(
        { session: RESIDENT_SESSION_ID },
        { principal: PRINCIPAL },
        { drafts: deps.draft, control: deps.send.control, runs: deps.send.runs },
      );
      await settle();
      const draftUuid = hostCommandUuid(RESIDENT_SESSION_ID);
      emit(RESIDENT_SESSION_ID, lifecycle(draftUuid, 'queued'));
      await settle();
      const draftState = ledgerStateOf(RESIDENT_SESSION_ID, draftUuid);

      const sendDeliveryId =
        typeof sendPayload.deliveryId === 'string' && sendPayload.deliveryId.length > 0;
      const createDeliveryId =
        typeof createPayload.deliveryId === 'string' && createPayload.deliveryId.length > 0;
      const draftDeliveryId =
        typeof draftPayload.deliveryId === 'string' && draftPayload.deliveryId.length > 0;
      const lifecycleCommandUuidMatch =
        sendPayload.deliveryId === sendUuid
        && createPayload.deliveryId === createUuid
        && draftPayload.deliveryId === draftUuid
        && sendState === 'queued'
        && createState === 'queued'
        && draftState === 'queued';
      // `session_create` and `draft_submit` state no queued-message uuid (SPEC
      // §8.1: the former answers `{ sessionId, deliveryId, runId }`, the latter
      // `{ session, deliveryId, runId, queued, source }`), so the alias is read
      // on the ONE entry that names it — and that entry is a queued send here.
      const queuedAliasHolds = sendPayload.queuedMessageUuid === sendPayload.deliveryId;

      say(
        `(a) send=${JSON.stringify(sendPayload.deliveryId)}/${JSON.stringify(sendPayload.queuedMessageUuid)} ` +
          `create=${JSON.stringify(createPayload.deliveryId)} draft=${JSON.stringify(draftPayload.deliveryId)} ` +
          `hostUuids=[${sendUuid},${createUuid},${draftUuid}] ` +
          `ledgerStates=[${String(sendState)},${String(createState)},${String(draftState)}] ` +
          `sendDeliveryId=${sendDeliveryId} createDeliveryId=${createDeliveryId} ` +
          `draftDeliveryId=${draftDeliveryId} lifecycleCommandUuidMatch=${lifecycleCommandUuidMatch} ` +
          `queuedAliasHolds=${queuedAliasHolds} draftQueued=${draftPayload.queued}`,
      );

      assertNonEmptyString(sendPayload.deliveryId, 'session_send.deliveryId');
      assertNonEmptyString(createPayload.deliveryId, 'session_create.deliveryId');
      assertNonEmptyString(draftPayload.deliveryId, 'draft_submit.deliveryId');
      assert.equal(lifecycleCommandUuidMatch, true, 'each returned deliveryId must be the host command uuid');
      assert.equal(queuedAliasHolds, true, 'a queued send must alias queuedMessageUuid to the deliveryId');
      assert.equal(sendPayload.queued, true, 'the alias reading must come off a send that really was queued');
      assert.equal(draftPayload.queued, true, 'the draft was submitted into a busy session');

      // -------------------------------------------------------------------
      // (b) A per-run provider: the run is minted with the delivery.
      // -------------------------------------------------------------------
      const perRunPayload = await buildSessionSend(
        { session: PER_RUN_SESSION_ID, message: 'AC385 per-run' },
        { principal: PRINCIPAL },
        deps.send,
      );
      await settle();
      const perRunRun = chatRunRegistry.getRun(PER_RUN_SESSION_ID);
      const perRunRunIdMatches = perRunPayload.runId === perRunRun?.runId;
      const perRunRunIdNonNull = typeof perRunPayload.runId === 'string' && perRunPayload.runId.length > 0;
      const perRunDeliveryIdNonNull =
        typeof perRunPayload.deliveryId === 'string' && perRunPayload.deliveryId.length > 0;

      say(
        `(b) returnedRunId=${JSON.stringify(perRunPayload.runId)} registryRunId=${JSON.stringify(perRunRun?.runId)} ` +
          `deliveryId=${JSON.stringify(perRunPayload.deliveryId)} perRunRunIdMatches=${perRunRunIdMatches} ` +
          `perRunRunIdNonNull=${perRunRunIdNonNull} perRunDeliveryIdNonNull=${perRunDeliveryIdNonNull}`,
      );

      assert.equal(perRunRunIdMatches, true, 'a per-run send must return the registered run id verbatim');
      assert.equal(perRunRunIdNonNull, true, 'a per-run send always has its run');
      assert.equal(perRunDeliveryIdNonNull, true, 'a per-run send must name its delivery');

      // -------------------------------------------------------------------
      // (c1) Resident, busy, window OPEN: runId is never null; unbound means
      //      runId === deliveryId.
      // -------------------------------------------------------------------
      const windowOpenSends: Array<{ deliveryId: string | null; runId: string | null }> = [];
      for (let index = 0; index < 3; index += 1) {
        const payload = await buildSessionSend(
          { session: RESIDENT_SESSION_ID, message: `AC385 window open ${index}` },
          { principal: PRINCIPAL },
          deps.send,
        );
        windowOpenSends.push({ deliveryId: payload.deliveryId, runId: payload.runId });
      }
      await settle();
      const windowOpenRunIdNonNull = windowOpenSends.every(
        (entry) => typeof entry.runId === 'string' && entry.runId.length > 0,
      );
      const unboundRunIdEqualsDeliveryId = windowOpenSends.every(
        (entry) => entry.deliveryId !== null && entry.runId === entry.deliveryId,
      );

      say(
        `(c1) sends=${JSON.stringify(windowOpenSends)} windowOpenRunIdNonNull=${windowOpenRunIdNonNull} ` +
          `unboundRunIdEqualsDeliveryId=${unboundRunIdEqualsDeliveryId}`,
      );

      assert.equal(windowOpenRunIdNonNull, true, 'inside the window an unbound send must still state a runId');
      assert.equal(
        unboundRunIdEqualsDeliveryId,
        true,
        'inside the window an unbound send states the delivery id as its runId',
      );

      // -------------------------------------------------------------------
      // (c2) Past the deadline: runId is null until the delivery binds a turn,
      //      which the EXISTING run_get(runId) then reads.
      // -------------------------------------------------------------------
      harness.setNow(RUN_ID_COMPAT_WINDOW_END_MS + 1);
      const closedPayload = await buildSessionSend(
        { session: WINDOW_SESSION_ID, message: 'AC385 window closed' },
        { principal: PRINCIPAL },
        deps.send,
      );
      await settle();
      const closedUuid = hostCommandUuid(WINDOW_SESSION_ID);
      const windowClosedRunIdNull = closedPayload.runId === null;
      const closedDeliveryIdNonNull =
        typeof closedPayload.deliveryId === 'string' && closedPayload.deliveryId.length > 0;

      // The delivery binds a turn: the CLI dequeues it and announces the turn,
      // which is what opens the run (SPEC §5.2, §6.1).
      emit(WINDOW_SESSION_ID, lifecycle(closedUuid, 'queued'));
      emit(WINDOW_SESSION_ID, lifecycle(closedUuid, 'started'));
      emit(WINDOW_SESSION_ID, init('ac385-init-window'));
      await settle();
      const boundRunId = chatRunRegistry.getRun(WINDOW_SESSION_ID)?.runId ?? null;
      const boundRunGetPayload = boundRunId === null
        ? null
        : await buildRunGet({ runId: boundRunId, waitSeconds: 0 }, runGetDepsFor(boundRunId));
      const boundRunIdReadableViaRunGet =
        boundRunGetPayload !== null && boundRunGetPayload.runId === boundRunId;
      emit(WINDOW_SESSION_ID, result());
      await settle();

      // (c3) The fuse: the deadline the implementation reads is still ahead of the
      // real now. It is the SAME exported constant the send judged the window by,
      // and it is never retyped here.
      const windowDeadlineInFuture = RUN_ID_COMPAT_WINDOW_END_MS > Date.now();

      say(
        `(c2) closedRunId=${JSON.stringify(closedPayload.runId)} closedDeliveryId=${JSON.stringify(closedPayload.deliveryId)} ` +
          `hostUuid=${closedUuid} boundRunId=${JSON.stringify(boundRunId)} ` +
          `runGet=${JSON.stringify(boundRunGetPayload?.runId ?? null)} ` +
          `windowClosedRunIdNull=${windowClosedRunIdNull} closedDeliveryIdNonNull=${closedDeliveryIdNonNull} ` +
          `boundRunIdReadableViaRunGet=${boundRunIdReadableViaRunGet}`,
      );
      say(`(c3) deadline=${RUN_ID_COMPAT_WINDOW_END_MS} windowDeadlineInFuture=${windowDeadlineInFuture}`);

      assert.equal(windowClosedRunIdNull, true, 'past the window an unbound send states runId as null');
      assert.equal(closedDeliveryIdNonNull, true, 'a closed-window send still names its delivery');
      assert.equal(
        boundRunIdReadableViaRunGet,
        true,
        'once the delivery binds a turn, the existing run_get(runId) reads that turn',
      );
      assert.equal(windowDeadlineInFuture, true, 'the compatibility window must still be open today');

      // -------------------------------------------------------------------
      // (d) A refused send produces no delivery.
      // -------------------------------------------------------------------
      harness.setBusyInputAllowed(false);
      const beforeLive = liveDeliveryCount(RESIDENT_SESSION_ID);
      let refusal: unknown = null;
      try {
        await buildSessionSend(
          { session: RESIDENT_SESSION_ID, message: 'AC385 refused' },
          { principal: PRINCIPAL },
          deps.send,
        );
      } catch (error: unknown) {
        refusal = error;
      }
      await settle();
      const afterLive = liveDeliveryCount(RESIDENT_SESSION_ID);
      harness.setBusyInputAllowed(true);

      const refusedIsEnvelope =
        refusal instanceof McpToolError && refusal.code === 'SESSION_BUSY';
      const refusedDetails = refusal instanceof McpToolError ? refusal.details : undefined;
      const rejectedEnvelopeHasNoDeliveryId =
        refusedDetails === undefined || !('deliveryId' in refusedDetails);
      const rejectedNoDelivery = afterLive === beforeLive;

      say(
        `(d) code=${refusal instanceof McpToolError ? refusal.code : String(refusal)} ` +
          `details=${JSON.stringify(refusedDetails ?? null)} liveBefore=${beforeLive} liveAfter=${afterLive} ` +
          `rejectedNoDelivery=${rejectedNoDelivery} rejectedEnvelopeHasNoDeliveryId=${rejectedEnvelopeHasNoDeliveryId}`,
      );

      assert.equal(refusedIsEnvelope, true, 'a refused send must answer the SESSION_BUSY envelope');
      assert.equal(rejectedEnvelopeHasNoDeliveryId, true, 'the refusal must name no delivery');
      assert.equal(rejectedNoDelivery, true, 'a refused send must leave the ledger delivery set unchanged');

      // -------------------------------------------------------------------
      // (e) correlationId belongs to the DELIVERY and is retrievable by it.
      // -------------------------------------------------------------------
      const labelledPayload = await buildSessionSend(
        { session: LABEL_SESSION_ID, message: 'AC385 labelled', correlationId: LABEL },
        { principal: PRINCIPAL },
        deps.send,
      );
      await settle();
      const labelledUuid = hostCommandUuid(LABEL_SESSION_ID);
      emit(LABEL_SESSION_ID, lifecycle(labelledUuid, 'queued'));
      emit(LABEL_SESSION_ID, lifecycle(labelledUuid, 'started'));
      emit(LABEL_SESSION_ID, init('ac385-init-label'));
      await settle();

      const labelledDeliveryId = labelledPayload.deliveryId;
      const correlationOnDelivery =
        labelledDeliveryId !== null
        && chatRunRegistry.getDeliveryCorrelationId(labelledDeliveryId) === LABEL;
      // The one reading `sessions/running` and `sessions_list` both consume: a
      // session is retrievable by the label its CURRENT run's owner delivery
      // carries. `sessions_list { correlationId }` narrows on exactly this field.
      const retrievableByCorrelationId =
        chatRunRegistry
          .listRunningRuns()
          .some((run) => run.sessionId === LABEL_SESSION_ID && run.correlationId === LABEL);

      say(
        `(e) deliveryId=${JSON.stringify(labelledDeliveryId)} stored=${JSON.stringify(
          labelledDeliveryId === null
            ? null
            : chatRunRegistry.getDeliveryCorrelationId(labelledDeliveryId),
        )} correlationOnDelivery=${correlationOnDelivery} retrievableByCorrelationId=${retrievableByCorrelationId}`,
      );

      assertNonEmptyString(labelledPayload.deliveryId, 'the labelled send must name its delivery');
      assert.equal(correlationOnDelivery, true, 'the label must be recorded on the delivery');
      assert.equal(retrievableByCorrelationId, true, 'the session must be retrievable by the label');

      say(`(summary) perRunParked=${harness.perRunParked()} elapsedMs=${Date.now() - STARTED_AT}`);
    } finally {
      harness.releaseParked();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
  }
});
