/**
 * AC-386 criterion — `run_get`'s DUAL-ID reading (SPEC §4.1, §4.2, §5.2, §5.3,
 * §8.2, §8.3, §15).
 *
 * The claim: `run_get` is addressed by a `runId` OR a `deliveryId` — mutually
 * exclusive, the two uuid spaces do not intersect — and read by delivery, a
 * `waitSeconds` waits for the DELIVERY's terminal (`completed` | `cancelled`),
 * not the run's. It returns the bound turn's closing assistant message and the
 * activity store's `phase` / `pendingTool`; a folded turn's two deliveries each
 * state their OWN terminal while sharing one closing message; a `cancelled`
 * delivery states `outcome: 'cancelled'` and the ledger's own `reason`; an
 * unknown id in either space is a `RUN_NOT_FOUND` envelope whose `details`
 * carries the `idKind` it was read in; and the wait is capped at
 * {@link MCP_RUN_GET_MAX_WAIT_SECONDS} and moves ONLY through the injected
 * `now` / `sleep`.
 *
 * The reading is taken over the REAL control service, the REAL run registry and
 * the REAL resident host driver with the PROCESS injected — a scripted fake
 * `claude` host whose stream this criterion drives by hand — plus the REAL
 * activity store (its turn reader injected, the same seam `mcp-run-get.test.ts`
 * uses). `run_get`'s own deps are those real services with the clock and the
 * sleeper injected, and the delivery seam is the REAL
 * `lookupResidentDeliveryById` over the driver's own ledger, so "the delivery
 * the API resolved" is a projection of the host's account rather than a fixture.
 * `sessions.fetchHistory` is a fixed fake whose last row is an assistant message.
 *
 * The legs, each a reading taken before anything is asserted:
 *
 *   (a) dual-id resolution     ⇒ `{ runId }` resolves in the run space and
 *                                `{ deliveryId }` in the delivery space, the two
 *                                spaces disjoint (the same string cannot hit both),
 *                                and both ids together is a PARAMETER error — not
 *                                a `RUN_NOT_FOUND` envelope;
 *   (b) waiting on a delivery  ⇒ (b1) a delivery that ends at the fake 3rd second
 *                                returns THEN (not after the full budget) with its
 *                                turn's closing message and the snapshot's phase /
 *                                pending tool; (b2) two deliveries folded into ONE
 *                                turn each state their own terminal and share the
 *                                same closing message; (b3) a `cancelled` delivery
 *                                answers `outcome: 'cancelled'` with its `reason`;
 *   (c) unknown ids            ⇒ one per space, each `RUN_NOT_FOUND` with
 *                                `details.idKind` naming the space it missed in;
 *   (d) the cap and the clock  ⇒ a 60-second request on a delivery that never ends
 *                                waits at most `MCP_RUN_GET_MAX_WAIT_SECONDS`,
 *                                counted as fake-clock milliseconds, with real
 *                                wall time untouched.
 *
 * Red lines, as in the sibling criteria:
 * - the process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, so a lifecycle that hangs is a budget kill with its own
 *   reading;
 * - every reading is taken before it is asserted, so a red lands on the reading
 *   that is wrong rather than on a timeout or on an earlier leg;
 * - the wait's clock is the injected fake one, so "returned before the full
 *   budget" is a NUMBER rather than a wall-clock race.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeResidentHostDriver, lookupResidentDeliveryById } from '@/modules/providers/index.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  TurnPhase,
} from '@/modules/providers/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import { McpToolError } from '@/modules/mcp-gateway/mcp-error-envelope.js';
import type { McpPrincipal } from '@/modules/mcp-gateway/mcp-gateway.auth.js';
import { MCP_RUN_GET_MAX_WAIT_SECONDS, handleRunGet } from '@/modules/mcp-gateway/mcp-run-get.js';
import type { McpRunGetDeps } from '@/modules/mcp-gateway/mcp-run-get.js';
import { buildSessionSend } from '@/modules/mcp-gateway/mcp-session-send.js';
import type { McpSessionSendDeps } from '@/modules/mcp-gateway/mcp-session-send.js';
// The websocket module's public face — the control plane, the run registry and
// its flag predicate, the activity store, and the runtime-writer contract.
// `$backend-module-standards` requires a cross-module edge to take the barrel.
import {
  chatRunRegistry,
  createActivityStore,
  createChatControlService,
  residentRunIsTurn,
} from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type {
  AnyRecord,
  LLMProvider,
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/** The session leg (a)/(b1) drives: one delivery, one run, one turn. */
const WAIT_SESSION = 'ac386-run-get-wait';
/** The session leg (b2)/(b3)/(d) drives: three deliveries folded into one turn. */
const FOLD_SESSION = 'ac386-run-get-fold';
/** The provider-native id the scripted stream keys its frames by. */
const PROVIDER_SESSION_ID = 'ac386f00-0000-4000-8000-000000000001';
/** The boot the criterion's `run_get` deps state, aligned with the registry's own. */
const FALLBACK_BOOT = 'ac386-boot';

/** The authenticated owner every builder call is made as. */
const PRINCIPAL: McpPrincipal = {
  userId: 1,
  tokenId: 11,
  clientId: 'ac386-client',
  scopes: ['send'],
};

/** The closing message every session's fake history ends with. */
const LAST_ANSWER = '最后一条助手消息：这条 delivery 已经结束。';

/** The fake history `run_get` reads on a terminal delivery; the last row is an assistant message. */
const FIXTURE_MESSAGES: NormalizedMessage[] = [
  {
    id: 'ac386-msg-user-1',
    sessionId: WAIT_SESSION,
    timestamp: '2026-09-01T11:58:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: '我那句处理完了吗？',
  },
  {
    id: 'ac386-msg-assistant-last',
    sessionId: WAIT_SESSION,
    timestamp: '2026-09-01T11:59:30.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: LAST_ANSWER,
  },
];

/** The phase the injected activity store reports for every fixture session. */
const FIXTURE_PHASE: TurnPhase = 'tool';
/** The pending tool the injected activity store reports for every fixture session. */
const FIXTURE_TOOL = 'Bash';

/** The bound this criterion reports itself against (SPEC §11: the gate's 60 s, minus margin). */
const ELAPSED_LIMIT_MS = 45_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the run_get/delivery criterion did not ` +
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
  console.log(`run-get-delivery ${line}`);
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
 * another's — two resident sessions are started by this criterion, and a
 * `command_lifecycle` that landed on the wrong host's ledger is recorded as
 * foreign (the uuid is unknown there) rather than as the state transition it was.
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
      const sessionId = coldStarts.shift() ?? `ac386-anonymous-${streams.size}`;
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

/** Fails unless `value` is a non-empty string, narrowing it for the assertions below. */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    assert.fail(`${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A terminal the criterion has scripted for one delivery, at one fake instant. */
type ScheduledTerminal = {
  sessionId: string;
  deliveryId: string;
  at: number;
  state: 'completed' | 'cancelled';
  fired: boolean;
};

type Harness = {
  driver: ClaudeResidentHostDriver;
  runGetDeps: McpRunGetDeps;
  emit(sessionId: string, frame: AnyRecord): void;
  /** Sends one message through the REAL control/builders path and answers its delivery id. */
  send(sessionId: string, message: string): Promise<string>;
  /** Scripts a delivery's terminal at `afterMs` fake-clock milliseconds from now. */
  scheduleTerminal(sessionId: string, deliveryId: string, afterMs: number, state: 'completed' | 'cancelled'): void;
  /** The fake clock's current value. */
  clock(): number;
  /** How many `sleep` calls have been made — one per wait iteration. */
  sleepCalls(): number;
  /** Points the deps' `bootId` at the boot the registry recorded for a run. */
  alignBootWith(runId: string): void;
  /** The driver's own ledger for one session. */
  ledger(sessionId: string): ReturnType<ClaudeResidentHostDriver['ledgerReading']>;
};

function createHarness(): Harness {
  let clock = 1_700_000_000_000;
  let sleepCount = 0;
  let bootIdValue = FALLBACK_BOOT;
  const scheduled: ScheduledTerminal[] = [];

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
    now: () => clock,
    connectedClientCount: () => 0,
  });

  /** The uuids this arm has already handed back through `queuedInputUuid`, per session. */
  const handedOut = new Map<string, string>();

  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    acceptsBusyInput: (provider: string) => provider === 'claude',
    run: async (provider: string, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) => {
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
      streams.noteDispatch(sessionId);
      return driver.run(sessionId, { command, options }, writer, CONTEXT);
    },
    abort: async () => false,
    // The uuid the provider stamped the just-queued message with, polled for the
    // same reason the sibling resident criteria poll: the control service asks
    // for it before the driver has armed the round, so the read waits for a uuid
    // it has not handed out yet.
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

  const control = createChatControlService({ runtime, now: () => clock });
  const seam = {
    send: (caller: Parameters<typeof control.send>[0], input: Parameters<typeof control.send>[1]) =>
      control.send(caller, input),
  };

  const activity = createActivityStore({
    now: () => clock,
    bootId: FALLBACK_BOOT,
    readTurn: () => ({ phase: FIXTURE_PHASE, toolName: FIXTURE_TOOL, toolDurationMs: null }),
  });
  // The store answers `null` for a session it was never told about; subscribing
  // once (then unsubscribing) is what makes a fixture session "known", the
  // precondition for reading a phase rather than the null note.
  for (const sessionId of [WAIT_SESSION, FOLD_SESSION]) {
    activity.subscribe(sessionId, () => {})();
  }

  /**
   * The wait loop's ONLY clock advance: it moves the fake clock, fires any
   * scripted terminal whose instant has arrived, and drains the driver's read
   * loop so the delivery's new state is readable before the loop's next read.
   */
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    sleepCount += 1;
    let fired = false;
    for (const entry of scheduled) {
      if (!entry.fired && clock >= entry.at) {
        entry.fired = true;
        fired = true;
        streams.emitTo(entry.sessionId, {
          type: 'command_lifecycle',
          command_uuid: entry.deliveryId,
          state: entry.state,
        });
      }
    }
    if (fired) {
      await settle();
    }
  };

  const runGetDeps: McpRunGetDeps = {
    runs: chatRunRegistry,
    activity,
    sessions: { fetchHistory: async () => ({ messages: [...FIXTURE_MESSAGES] }) },
    // The REAL by-id ledger reading: `run_get`'s delivery arm resolves through
    // the host's own account, not a fixture.
    deliveries: { lookupById: lookupResidentDeliveryById },
    now: () => clock,
    sleep,
    bootId: () => bootIdValue,
  };

  const sendDeps: McpSessionSendDeps = {
    control: seam,
    runs: chatRunRegistry,
    runGet: { deps: runGetDeps, build: (input, deps) => handleRunGet(input as AnyRecord, deps) },
  };

  return {
    driver,
    runGetDeps,
    emit: streams.emitTo,
    send: async (sessionId: string, message: string) => {
      const payload = await buildSessionSend(
        { session: sessionId, message },
        { principal: PRINCIPAL },
        sendDeps,
      );
      await settle();
      assertNonEmptyString(payload.deliveryId, `the send to ${sessionId} must name its delivery`);
      return payload.deliveryId;
    },
    scheduleTerminal: (sessionId, deliveryId, afterMs, state) => {
      scheduled.push({ sessionId, deliveryId, at: clock + afterMs, state, fired: false });
    },
    clock: () => clock,
    sleepCalls: () => sleepCount,
    alignBootWith: (runId: string) => {
      bootIdValue = chatRunRegistry.getRunBootId(runId) ?? bootIdValue;
    },
    ledger: (sessionId: string) => driver.ledgerReading(sessionId),
  };
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

test('AC-386 run_get resolves a runId or a deliveryId, waits the delivery terminal, and names the space it missed in', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-run-get-delivery-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(WAIT_SESSION, 'claude', tempDirectory, 'AC-386 wait', now, now, null);
    sessionsDb.createSession(FOLD_SESSION, 'claude', tempDirectory, 'AC-386 fold', now, now, null);

    chatRunRegistry.clearAll();
    const harness = createHarness();
    const { emit, runGetDeps } = harness;

    /** The turn's opening, as the CLI states it. */
    const init = (uuid: string): AnyRecord =>
      ({ type: 'system', subtype: 'init', uuid, session_id: PROVIDER_SESSION_ID });
    /** One command's lifecycle, as the CLI states it. */
    const lifecycle = (commandUuid: string, state: string): AnyRecord =>
      ({ type: 'command_lifecycle', command_uuid: commandUuid, state });

    /** One wait's whole reading: the payload (or the thrown envelope) plus the clock it moved. */
    const read = async (
      args: AnyRecord,
    ): Promise<{ payload: Awaited<ReturnType<typeof handleRunGet>> | null; error: unknown; sleptMs: number; sleeps: number }> => {
      const clockBefore = harness.clock();
      const sleepsBefore = harness.sleepCalls();
      try {
        const payload = await handleRunGet(args, runGetDeps);
        return { payload, error: null, sleptMs: harness.clock() - clockBefore, sleeps: harness.sleepCalls() - sleepsBefore };
      } catch (error: unknown) {
        return { payload: null, error, sleptMs: harness.clock() - clockBefore, sleeps: harness.sleepCalls() - sleepsBefore };
      }
    };

    try {
      say(
        `(flags) residentRunIsTurn=${residentRunIsTurn()} cap=${MCP_RUN_GET_MAX_WAIT_SECONDS}s pid=${process.pid}`,
      );

      // -------------------------------------------------------------------
      // Session A: one delivery, one turn, one run — legs (a) and (b1).
      // -------------------------------------------------------------------
      const deliveryA = await harness.send(WAIT_SESSION, 'AC386 wait');
      emit(WAIT_SESSION, lifecycle(deliveryA, 'queued'));
      emit(WAIT_SESSION, lifecycle(deliveryA, 'started'));
      emit(WAIT_SESSION, init('ac386-init-wait'));
      await settle();

      const runA = chatRunRegistry.getRun(WAIT_SESSION)?.runId ?? null;
      assertNonEmptyString(runA, 'the delivered turn must have minted a run');
      // The run's own boot is what the restart check must compare against.
      harness.alignBootWith(runA);

      const boundA = harness.ledger(WAIT_SESSION)?.deliveries.find((entry) => entry.deliveryId === deliveryA) ?? null;

      // -- (a) dual-id resolution --
      const byRunA = await handleRunGet({ runId: runA }, runGetDeps);
      const byDeliveryA = await handleRunGet({ deliveryId: deliveryA }, runGetDeps);
      const runIdMissesDeliverySpace = chatRunRegistry.getRunById(deliveryA).status === 'unknown';
      const deliveryIdMissesRunSpace = lookupResidentDeliveryById(runA) === null;

      let bothError: unknown = null;
      try {
        await handleRunGet({ runId: runA, deliveryId: deliveryA }, runGetDeps);
      } catch (error: unknown) {
        bothError = error;
      }
      const bothErrorKind = bothError instanceof McpToolError ? bothError.code : String(bothError);

      const idKindRun = byRunA.idKind === 'run' && byRunA.runId === runA;
      const idKindDelivery =
        byDeliveryA.idKind === 'delivery' && byDeliveryA.deliveryId === deliveryA
        && byDeliveryA.sessionId === WAIT_SESSION && byDeliveryA.runId === runA;
      const spacesDisjoint = runIdMissesDeliverySpace && deliveryIdMissesRunSpace;
      const bothRejected = bothErrorKind === 'INVALID_ARGUMENT';

      say(
        `(a) runA=${JSON.stringify(runA)} deliveryA=${JSON.stringify(deliveryA)} ` +
          `boundTurnId=${JSON.stringify(boundA?.turnId ?? null)} ` +
          `byRun.idKind=${JSON.stringify(byRunA.idKind)} byRun.runId=${JSON.stringify(byRunA.runId)} ` +
          `byDelivery.idKind=${JSON.stringify(byDeliveryA.idKind)} byDelivery.deliveryId=${JSON.stringify(byDeliveryA.deliveryId)} ` +
          `byDelivery.runId=${JSON.stringify(byDeliveryA.runId)} ` +
          `runIdMissesDeliverySpace=${runIdMissesDeliverySpace} deliveryIdMissesRunSpace=${deliveryIdMissesRunSpace} ` +
          `idKindRun=${idKindRun} idKindDelivery=${idKindDelivery} spacesDisjoint=${spacesDisjoint} ` +
          `bothRejected=${bothRejected} bothErrorKind=${bothErrorKind}`,
      );

      assert.equal(idKindRun, true, 'run_get { runId } must resolve in the run space');
      assert.equal(idKindDelivery, true, 'run_get { deliveryId } must resolve in the delivery space');
      assert.equal(spacesDisjoint, true, 'the two uuid spaces must not intersect');
      assert.equal(bothRejected, true, 'naming both ids must be a parameter error');
      assert.notEqual(bothErrorKind, 'RUN_NOT_FOUND', 'both ids is a parameter error, not a miss');
      assert.ok(boundA?.turnId != null, 'the delivery must be bound to a turn');

      // -- (b1) the wait returns when the DELIVERY ends, not at the budget --
      harness.scheduleTerminal(WAIT_SESSION, deliveryA, 3_000, 'completed');
      const waited = await read({ deliveryId: deliveryA, waitSeconds: 40 });
      const payloadB1 = waited.payload;
      const budgetMs = MCP_RUN_GET_MAX_WAIT_SECONDS * 1000;

      const deliveryWaitReturns = waited.error === null && waited.sleptMs >= 3_000 && waited.sleptMs < budgetMs;
      const finalMessagePresent = payloadB1?.lastAssistantMessage?.content === LAST_ANSWER;
      const phaseFromSnapshot = payloadB1?.phase === FIXTURE_PHASE;
      const pendingToolFromSnapshot = payloadB1?.toolName === FIXTURE_TOOL;

      say(
        `(b1) sleptMs=${waited.sleptMs} budgetMs=${budgetMs} outcome=${JSON.stringify(payloadB1?.outcome ?? null)} ` +
          `status=${JSON.stringify(payloadB1?.status ?? null)} phase=${JSON.stringify(payloadB1?.phase ?? null)} ` +
          `toolName=${JSON.stringify(payloadB1?.toolName ?? null)} ` +
          `finalMessage=${JSON.stringify(payloadB1?.lastAssistantMessage?.content ?? null)} ` +
          `deliveryWaitReturns=${deliveryWaitReturns} finalMessagePresent=${finalMessagePresent} ` +
          `phaseFromSnapshot=${phaseFromSnapshot} pendingToolFromSnapshot=${pendingToolFromSnapshot}`,
      );

      assert.equal(waited.error, null, `the wait must not throw (${(waited.error as Error)?.message ?? ''})`);
      assert.equal(deliveryWaitReturns, true, 'a delivery that ends early must return then, not at the budget');
      assert.equal(payloadB1?.outcome, 'settled', 'a terminal completed delivery reports the settled outcome');
      assert.equal(payloadB1?.status, 'completed', 'the reading must carry the delivery\'s own terminal');
      assert.equal(finalMessagePresent, true, 'the reading must carry the turn\'s closing assistant message');
      assert.equal(phaseFromSnapshot, true, 'phase must come from the activity store verbatim');
      assert.equal(pendingToolFromSnapshot, true, 'the pending tool must come from the activity store verbatim');

      // -------------------------------------------------------------------
      // Session B: three deliveries folded into ONE turn — (b2), (b3), (d).
      // -------------------------------------------------------------------
      const deliveryB1 = await harness.send(FOLD_SESSION, 'AC386 fold opener');
      emit(FOLD_SESSION, init('ac386-init-fold'));
      await settle();
      const deliveryB2 = await harness.send(FOLD_SESSION, 'AC386 fold second');
      emit(FOLD_SESSION, lifecycle(deliveryB2, 'started'));
      await settle();
      const deliveryB3 = await harness.send(FOLD_SESSION, 'AC386 fold third never ends');
      emit(FOLD_SESSION, lifecycle(deliveryB3, 'started'));
      await settle();

      const runB = chatRunRegistry.getRun(FOLD_SESSION)?.runId ?? null;
      assertNonEmptyString(runB, 'the folded turn must have minted a run');
      const ledgerB = harness.ledger(FOLD_SESSION);
      const boundB1 = ledgerB?.deliveries.find((entry) => entry.deliveryId === deliveryB1) ?? null;
      const boundB2 = ledgerB?.deliveries.find((entry) => entry.deliveryId === deliveryB2) ?? null;
      const boundB3 = ledgerB?.deliveries.find((entry) => entry.deliveryId === deliveryB3) ?? null;
      const oneTurn = boundB1?.turnId != null && boundB1.turnId === boundB2?.turnId && boundB1.turnId === boundB3?.turnId;

      // (b2) the two folded deliveries end differently, one turn between them.
      emit(FOLD_SESSION, lifecycle(deliveryB1, 'completed'));
      emit(FOLD_SESSION, lifecycle(deliveryB2, 'cancelled'));
      await settle();

      const folded1 = await read({ deliveryId: deliveryB1, waitSeconds: 0 });
      const folded2 = await read({ deliveryId: deliveryB2, waitSeconds: 0 });
      const foldedOwnTerminal =
        folded1.payload?.status === 'completed' && folded2.payload?.status === 'cancelled';
      const foldedShareFinalMessage =
        folded1.payload?.lastAssistantMessage?.content === LAST_ANSWER
        && folded2.payload?.lastAssistantMessage?.content === LAST_ANSWER;

      say(
        `(b2) turnIds=[${JSON.stringify(boundB1?.turnId ?? null)},${JSON.stringify(boundB2?.turnId ?? null)},` +
          `${JSON.stringify(boundB3?.turnId ?? null)}] oneTurn=${oneTurn} ` +
          `statuses=[${JSON.stringify(folded1.payload?.status ?? null)},${JSON.stringify(folded2.payload?.status ?? null)}] ` +
          `messages=[${JSON.stringify(folded1.payload?.lastAssistantMessage?.content ?? null)},` +
          `${JSON.stringify(folded2.payload?.lastAssistantMessage?.content ?? null)}] ` +
          `foldedOwnTerminal=${foldedOwnTerminal} foldedShareFinalMessage=${foldedShareFinalMessage}`,
      );

      assert.equal(oneTurn, true, 'the folded deliveries must share one turn (C-2)');
      assert.equal(foldedOwnTerminal, true, 'each folded delivery must state its own terminal');
      assert.equal(foldedShareFinalMessage, true, 'the folded deliveries must share the turn\'s closing message');

      // (b3) a cancelled delivery answers the cancelled outcome and its reason.
      const cancelledWait = await read({ deliveryId: deliveryB2, waitSeconds: 30 });
      const cancelledOutcome = cancelledWait.payload?.outcome === 'cancelled';
      const cancelledReason = cancelledWait.payload?.reason ?? null;

      say(
        `(b3) outcome=${JSON.stringify(cancelledWait.payload?.outcome ?? null)} ` +
          `reason=${JSON.stringify(cancelledReason)} status=${JSON.stringify(cancelledWait.payload?.status ?? null)} ` +
          `sleptMs=${cancelledWait.sleptMs} cancelledOutcome=${cancelledOutcome}`,
      );

      assert.equal(cancelledOutcome, true, 'a cancelled delivery must report the cancelled outcome');
      assert.ok(
        cancelledReason === 'withdrawn'
          || cancelledReason === 'interrupt'
          || cancelledReason === 'process-exit'
          || cancelledReason === 'owed-terminal-missing'
          || cancelledReason === 'cli',
        `a cancelled delivery must carry one of the five reasons (got ${JSON.stringify(cancelledReason)})`,
      );

      // -------------------------------------------------------------------
      // (c) an unknown id in each space is a RUN_NOT_FOUND naming its space.
      // -------------------------------------------------------------------
      const missRun = await read({ runId: 'ac386-run-never-issued' });
      const missDelivery = await read({ deliveryId: 'ac386-delivery-never-issued' });
      const missRunError = missRun.error instanceof McpToolError ? missRun.error : null;
      const missDeliveryError = missDelivery.error instanceof McpToolError ? missDelivery.error : null;
      const missRunIdKind = (missRunError?.details as { idKind?: string } | undefined)?.idKind ?? null;
      const missDeliveryIdKind = (missDeliveryError?.details as { idKind?: string } | undefined)?.idKind ?? null;
      const missRunIsEnvelope = missRunError?.code === 'RUN_NOT_FOUND';
      const missDeliveryIsEnvelope = missDeliveryError?.code === 'RUN_NOT_FOUND';

      say(
        `(c) missRunCode=${JSON.stringify(missRunError?.code ?? String(missRun.error))} missRunIdKind=${JSON.stringify(missRunIdKind)} ` +
          `missDeliveryCode=${JSON.stringify(missDeliveryError?.code ?? String(missDelivery.error))} ` +
          `missDeliveryIdKind=${JSON.stringify(missDeliveryIdKind)} isError=${missRunIsEnvelope && missDeliveryIsEnvelope}`,
      );

      assert.equal(missRunIsEnvelope, true, 'an unknown run id must answer the RUN_NOT_FOUND envelope');
      assert.equal(missDeliveryIsEnvelope, true, 'an unknown delivery id must answer the RUN_NOT_FOUND envelope');
      assert.equal(missRunIdKind, 'run', 'a run-space miss must name the run space');
      assert.equal(missDeliveryIdKind, 'delivery', 'a delivery-space miss must name the delivery space');

      // -------------------------------------------------------------------
      // (d) the cap and the clock: a delivery that never ends waits at most
      //     MCP_RUN_GET_MAX_WAIT_SECONDS of FAKE time, with wall time untouched.
      // -------------------------------------------------------------------
      const wallBefore = Date.now();
      const capped = await read({ deliveryId: deliveryB3, waitSeconds: 60 });
      const wallElapsed = Date.now() - wallBefore;

      say(
        `(d) requested=60s waitedSleptMs=${capped.sleptMs} capMs=${budgetMs} outcome=${JSON.stringify(capped.payload?.outcome ?? null)} ` +
          `status=${JSON.stringify(capped.payload?.status ?? null)} sleepCalls=${capped.sleeps} wallElapsedMs=${wallElapsed} ` +
          `withinCap=${capped.sleptMs <= budgetMs} sleptPositive=${capped.sleptMs > 0} ` +
          `wallNeverReachedBudget=${wallElapsed < 60_000}`,
      );

      assert.equal(capped.error, null, 'a capped wait must return rather than throw');
      assert.ok(capped.sleptMs <= budgetMs, `the wait must be capped, got ${String(capped.sleptMs)}ms`);
      assert.ok(capped.sleptMs > 0, 'a capped wait must have slept — the clock advanced only through sleep');
      assert.ok(capped.sleeps > 0, 'the wait loop must have gone through the injected sleeper');
      assert.equal(capped.payload?.outcome, 'timeout', 'an unending delivery must report a timeout');
      assert.equal(capped.payload?.status, 'running', 'the timeout reading returns the delivery\'s live state');
      assert.ok(wallElapsed < 60_000, 'no wall clock may have passed for the 60 s request');

      say(`(summary) elapsedMs=${Date.now() - STARTED_AT}`);
    } finally {
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
