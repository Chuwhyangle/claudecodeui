/**
 * AC-383 criterion — the delivery state channel (SPEC §7).
 *
 * The claim: an accepted delivery reaches the browser as part of the SESSION's
 * activity snapshot. The activity protocol already carries a monotonic `rev`, a
 * whole snapshot on every change, and a snapshot-first greet for a late joiner;
 * what it never carried is what the session is *holding* — so "the terminal
 * projection of an accepted delivery must reach the socket that is watching"
 * (`id-relations` B-7) was a writer's-audience promise, and a reconnect dropped it.
 *
 * This criterion drives the whole path with real objects and one forged process:
 *
 *  - the REAL `chatControlService`, dispatching into the REAL resident host driver
 *    through the REAL `chatRunRegistry`, over a scripted fake CLI whose frames the
 *    arm emits itself;
 *  - the REAL `createActivityStore`, built with a pinned clock and injected
 *    turn/task/schedule readings, whose `readDeliveries` is the production
 *    projection (`readSessionDeliveries`) over the driver's live ledger;
 *  - the REAL `createActivityRouter` on a real express app over a real socket, so
 *    the late-joiner leg is an actual HTTP GET rather than a call into the store.
 *
 * No `WebSocket` is built anywhere. The one socket-shaped object is a plain
 * `{readyState, send}` literal, the same shape `activity-protocol.test.ts` uses for
 * its `hosts_changed` reading, and it exists only so the degraded legacy frame can
 * be read off the wire instead of inferred from the registry.
 *
 * The legs, each a reading taken before anything is asserted:
 *
 *   (a) shape       — one delivery driven `queued → started` ⇒ every entry in
 *                     `snapshot.deliveries` carries exactly the ten fields of
 *                     SPEC §7.1, `text` is present and bounded while live and
 *                     `null` once the delivery ends;
 *   (b) rev         — K delivery changes ⇒ exactly K `activity.upsert` frames
 *                     after the greet, `rev` stepping by exactly one, every frame
 *                     body equal to the snapshot at the same instant, and the
 *                     announced revision equal to the store's;
 *   (c) late/reconnect/retention/cap — a late joiner's first frame is a snapshot
 *                     carrying the live queue; a reconnect restores the queued and
 *                     the still-retained terminal rows; past the retention window
 *                     the terminals go and the live rows stay; and a session keeps
 *                     exactly `DELIVERY_TERMINAL_LIMIT` terminal rows;
 *   (d) legacy       — the old `command_lifecycle` frame still goes out, but with no
 *                     `runId`, no `seq`, and into no run's event buffer.
 *
 * The two false forms this is graded against (`## Evidence` in the task): masking
 * the `started` state out of the change signature must red (b)'s counts and nothing
 * earlier, and removing the greet must red (c)'s late-joiner reading.
 *
 * Red lines, as in the sibling resident criteria: the process budget guard kills
 * the whole process with `exit 3` so a hanging lifecycle is a budget kill with its
 * own reading, and every reading is taken before it is asserted so a red lands on
 * the reading that is wrong.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  ClaudeResidentHostDriver,
  DEFAULT_DELIVERY_RETENTION_MS,
  DELIVERY_TERMINAL_LIMIT,
  readSessionDeliveries,
  setActivityChangeNotifier,
} from '@/modules/providers/index.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  TurnState,
} from '@/modules/providers/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler } from '@/modules/session-hosts/index.js';
import { activityAnnouncement } from '@/modules/websocket/services/activity-heartbeat.service.js';
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import {
  DEFAULT_RUN_RETENTION_MS,
  chatRunRegistry,
  residentRunIsTurn,
} from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import {
  WS_OPEN_STATE,
  activityStore as activityStoreForAnnouncement,
  createActivityRouter,
  createActivityStore,
} from '@/modules/websocket/index.js';
import type {
  ActivityProtocolFrame,
  ActivityProtocolSnapshot,
} from '@/modules/websocket/index.js';
import {
  DELIVERY_TEXT_MAX_CHARS,
  type AnyRecord,
  type DeliveryEntry,
  type LLMProvider,
  type ProviderRuntimeContext,
  type ProviderRuntimeWriter,
  type RealtimeClientConnection,
} from '@/shared/types.js';

const SESSION_ID = 'activity-deliveries-session';
/** The provider-native id the scripted stream keys its frames by. */
const PROVIDER_SESSION_ID = 'ac383f00-0000-4000-8000-000000000001';

/** The caller shape `send` takes: an authenticated WebSocket front end. */
const CALLER = { userId: 1, via: 'websocket' as const };

/** The bound this criterion reports itself against (SPEC §11: the gate's 60 s, minus margin). */
const ELAPSED_LIMIT_MS = 45_000;
const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the delivery-state-channel ` +
      'criterion did not finish inside its process budget (a process-level kill, not a node:test case failure).',
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
  console.log(`deliveries ${line}`);
}

/** The ten fields SPEC §7.1 states every delivery entry carries. */
const DELIVERY_ENTRY_KEYS = [
  'deliveryId',
  'state',
  'source',
  'priority',
  'enqueuedAt',
  'startedAt',
  'endedAt',
  'turnId',
  'reason',
  'text',
] as const;

// ---------------------------------------------------------------------------
// Scripted resident process (the shape AC-382's arm uses)
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
    factory: () => ({ query, pid: 4383 }) satisfies ClaudeResidentProcess,
    emit: push,
  };
}

/**
 * The runtime's turn inputs, stubbed to the facts this arm's driver asks for.
 *
 * Two shapes matter. A scripted frame carrying a `marker` becomes one client frame
 * naming that marker, which is how "the host forwarded this" is observable. A
 * frame spelled like the dialect's lifecycle row becomes the `command_lifecycle`
 * frame the REAL normalizer would produce — same `kind`, same `commandUuid`, same
 * `commandState` — because the legacy leg measures what the REGISTRY does with such
 * a frame (no `seq`, no `runId`, no buffer) and that reading must not depend on the
 * real normalizer's transcript reading.
 */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  normalizeMessage: (raw: unknown) => {
    const frame = raw as AnyRecord;
    const lifecycleState =
      frame?.type === 'command_lifecycle'
      || (frame?.type === 'system' && frame?.subtype === 'command_lifecycle')
        ? readLifecycleState(frame.state)
        : null;
    const commandUuid = typeof frame?.command_uuid === 'string' && frame.command_uuid ? frame.command_uuid : null;
    if (lifecycleState && commandUuid) {
      return [{
        id: `lifecycle:${commandUuid}:${lifecycleState}`,
        kind: 'command_lifecycle',
        commandUuid,
        commandState: lifecycleState,
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        timestamp: new Date(0).toISOString(),
      }];
    }
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

/** The CLI's four lifecycle words, as this arm's normalizer accepts them. */
function readLifecycleState(value: unknown): 'queued' | 'started' | 'completed' | 'cancelled' | null {
  return value === 'queued' || value === 'started' || value === 'completed' || value === 'cancelled'
    ? value
    : null;
}

/** Yields the event loop enough times for the driver's read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 60; hop += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Store + wire
// ---------------------------------------------------------------------------

/** The frame without its `kind`: the snapshot body the frame carries. */
function frameBody(frame: ActivityProtocolFrame): ActivityProtocolSnapshot {
  const { kind: _kind, ...body } = frame;
  return body;
}

/** The turn reading the criterion pins, so AC-191/192 need not have landed. */
function fakeTurn(phase: TurnState['phase'], toolName: string | null): TurnState {
  return { phase, toolName, toolDurationMs: null };
}

type Wire = {
  /** The real REST route over a real socket, for the late-joiner reading. */
  getSnapshot(sessionId: string): Promise<ActivityProtocolSnapshot | null>;
  close(): Promise<void>;
};

/** Mounts the real activity router on a real express app listening on a real port. */
async function startWire(store: ReturnType<typeof createActivityStore>): Promise<Wire> {
  const app = express();
  app.use('/api/sessions', createActivityRouter({ activityStore: store }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    getSnapshot: async (sessionId) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/activity`);
      if (response.status !== 200) {
        return null;
      }
      return (await response.json()) as ActivityProtocolSnapshot;
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

// ---------------------------------------------------------------------------
// The readings
// ---------------------------------------------------------------------------

/** Every entry the snapshot carries, or none when the snapshot itself is absent. */
function entriesOf(snapshot: ActivityProtocolSnapshot | null): DeliveryEntry[] {
  return snapshot?.deliveries ?? [];
}

/** Whether every entry carries exactly the ten SPEC §7.1 fields — no more, no less. */
function deliveryKeysExact(entries: DeliveryEntry[]): boolean {
  const expected = [...DELIVERY_ENTRY_KEYS].sort().join(',');
  return entries.length > 0 && entries.every((entry) => Object.keys(entry).sort().join(',') === expected);
}

/** The ids of the entries that are still queued or running. */
function liveIds(entries: DeliveryEntry[]): string[] {
  return entries
    .filter((entry) => entry.state === 'queued' || entry.state === 'started')
    .map((entry) => entry.deliveryId)
    .sort();
}

/** The ids of the entries that reached a terminal. */
function terminalIds(entries: DeliveryEntry[]): string[] {
  return entries
    .filter((entry) => entry.state === 'completed' || entry.state === 'cancelled')
    .map((entry) => entry.deliveryId)
    .sort();
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

test('AC-383 a delivery reaches the browser through the activity snapshot, and every change steps rev by one', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'activity-deliveries-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  // ONE clock for the driver and the store, so "advance time past the retention
  // window" is a single assignment rather than two clocks that could disagree.
  let clock = 1_700_000_000_000;
  const now = (): number => clock;

  const store = createActivityStore({
    now,
    bootId: 'boot-ac383',
    readTurn: () => fakeTurn('idle', null),
    readTasks: () => [],
    readSchedules: () => [],
    // The PRODUCTION projection, over the driver's live ledger: the criterion
    // measures the reader the server ships, not a copy of it.
    readDeliveries: readSessionDeliveries,
  });

  /** Every frame a subscribed connection received, with the snapshot read at that instant. */
  type Received = { frame: ActivityProtocolFrame; snapshotAtDelivery: ActivityProtocolSnapshot | null };
  const received: Received[] = [];

  /** How many times the installed tick fired — the driver's own count of delivery changes. */
  let tickCount = 0;

  let wire: Wire | null = null;
  let unsubscribe: (() => void) | null = null;
  let harness: ReturnType<typeof createHarness> | null = null;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const stamp = new Date().toISOString();
  sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Delivery channel session', stamp, stamp, null);
  chatRunRegistry.clearAll();

  try {
    say(`(flags) residentRunIsTurn=${residentRunIsTurn()} pid=${process.pid}`);
    say(
      `(constants) textCap=${DELIVERY_TEXT_MAX_CHARS} terminalLimit=${DELIVERY_TERMINAL_LIMIT} ` +
        `deliveryRetention=${DEFAULT_DELIVERY_RETENTION_MS} runRetention=${DEFAULT_RUN_RETENTION_MS}`,
    );

    // The composition root's own wiring: one tick per change, and it is the tick
    // that moves the revision. The process-wide store is advanced by the same
    // callback because `activityAnnouncement` reads THAT store by construction —
    // the heartbeat has one revision source, and this is how the criterion reads
    // back the number it announces.
    setActivityChangeNotifier((sessionId) => {
      tickCount += 1;
      store.recordChange(sessionId);
      activityStoreForAnnouncement.recordChange(sessionId);
    });

    wire = await startWire(store);

    // The client's hello, taken before anything changes: this is what seeds the
    // process-wide store's session, so every later tick reaches it too.
    const hello = activityAnnouncement(SESSION_ID);
    say(`(hello) bootId=${hello.bootId} rev=${hello.rev}`);

    unsubscribe = store.subscribe(SESSION_ID, (frame) => {
      received.push({ frame, snapshotAtDelivery: store.snapshot(SESSION_ID) });
    });

    harness = createHarness({ now });
    const { driver, control, emit, outbound } = harness;
    // The run's audience: a plain literal, never a socket. Attached before the
    // first send so the first run's writer carries it (the registry hands a new
    // run whatever audience the session already has).
    chatRunRegistry.attachConnection(SESSION_ID, harness.connection);

    const emitLifecycle = (commandUuid: string, state: string): void => {
      emit({ type: 'command_lifecycle', command_uuid: commandUuid, state });
    };

    const deliveries = (): DeliveryEntry[] => entriesOf(store.snapshot(SESSION_ID));
    const ledgerDeliveries = (): NonNullable<ReturnType<typeof driver.ledgerReading>>['deliveries'] => {
      const reading = driver.ledgerReading(SESSION_ID);
      assert.ok(reading, 'the resident host must be live and readable');
      return reading.deliveries;
    };

    // -------------------------------------------------------------------
    // (a) The shape leg: one delivery driven `queued → started`.
    // -------------------------------------------------------------------
    const first = await control.send(CALLER, { sessionId: SESSION_ID, content: 'AC383 first delivery' });
    assert.ok(first.ok, `the first send must be accepted (got ${JSON.stringify(first)})`);
    await settle();
    const firstDeliveryId = ledgerDeliveries().at(-1)?.deliveryId ?? '';
    assert.ok(firstDeliveryId, 'the ledger must hold the delivery of the send just made');
    emitLifecycle(firstDeliveryId, 'queued');
    await settle();
    emitLifecycle(firstDeliveryId, 'started');
    await settle();

    const atStart = deliveries();
    const shapeKeysExact = deliveryKeysExact(atStart);
    const textOnQueued = atStart.filter(
      (entry) => (entry.state === 'queued' || entry.state === 'started') && typeof entry.text === 'string',
    ).length;
    const maxTextLen = Math.max(0, ...atStart.map((entry) => (entry.text ?? '').length));
    const startedState = atStart.find((entry) => entry.deliveryId === firstDeliveryId)?.state;
    say(
      `(a) deliveryKeysExact=${shapeKeysExact} entries=${atStart.length} states=${JSON.stringify(atStart.map((e) => e.state))} ` +
        `startedState=${String(startedState)} textOnQueued=${textOnQueued} maxTextLen<=cap=${maxTextLen <= DELIVERY_TEXT_MAX_CHARS}`,
    );
    say(`(a) entry0=${JSON.stringify(atStart[0])}`);

    // -------------------------------------------------------------------
    // (b) The rev leg: each change is one whole-snapshot upsert, rev +1.
    // -------------------------------------------------------------------
    emit({ type: 'system', subtype: 'init', uuid: 'ac383-init-1', session_id: PROVIDER_SESSION_ID });
    await settle();
    const ticksAfterInit = tickCount;
    // A frame that changes nothing about a delivery must announce nothing: the
    // reading that makes "exactly once per change" a measurement rather than a
    // restatement of the call count.
    emit({ type: 'assistant', session_id: PROVIDER_SESSION_ID, marker: 'm-1' });
    await settle();
    const ticksAfterPassiveFrame = tickCount;

    // K, stated rather than inferred: the scenario drives exactly three changes to
    // the delivery projection before the passive frame — the send that creates the
    // row (1), the CLI's `started` (2), and the `init` that binds the row to its
    // turn (3). The `queued` frame between them is deliberately NOT a change: an
    // accepted command the CLI has not spoken about yet already reads `queued`, so
    // the CLI restating it moves nothing. Without a stated K the reading would be
    // unfalsifiable — a producer that announced only half the changes would have
    // its own count agree with itself.
    const expectedChanges = 3;
    const upserts = received.filter((entry) => entry.frame.kind === 'activity.upsert');
    const revSequence = upserts.map((entry) => entry.frame.rev);
    const bodiesMatch = upserts.every((entry) => isDeepStrictEqual(frameBody(entry.frame), entry.snapshotAtDelivery));
    const storeRev = store.snapshot(SESSION_ID)?.rev ?? -1;
    const heartbeatRev = activityAnnouncement(SESSION_ID).rev;
    say(
      `(b) upsertCount=${upserts.length} expectedChanges=${expectedChanges} revSequence=${JSON.stringify(revSequence)} ` +
        `ticks=${ticksAfterInit} ticksAfterPassiveFrame=${ticksAfterPassiveFrame}`,
    );
    say(
      `(b) greet=${received[0]?.frame.kind} everyFrameBodyEqualsSnapshot=${bodiesMatch} ` +
        `heartbeatRev=${heartbeatRev} storeRev=${storeRev}`,
    );

    // -------------------------------------------------------------------
    // (d) The legacy leg: the same change still writes the old frame, degraded.
    // -------------------------------------------------------------------
    const legacyRunId = chatRunRegistry.getRun(SESSION_ID)?.runId ?? '';
    assert.ok(legacyRunId, 'the delivered turn must have a run by the time its terminal is written');
    const lastSeqBefore = chatRunRegistry.readRun(legacyRunId)?.lastSeq ?? -1;
    const outboundBefore = outbound.length;
    emitLifecycle(firstDeliveryId, 'completed');
    await settle();
    const outboundSince = outbound.slice(outboundBefore);
    const legacyFrame = outboundSince.find((frame) => frame.kind === 'command_lifecycle') ?? null;
    const legacyRun = chatRunRegistry.readRun(legacyRunId);
    const legacyInRunEvents = legacyRun?.events.filter((event) => event.kind === 'command_lifecycle').length ?? -1;
    const legacyLastSeqDelta = (legacyRun?.lastSeq ?? -1) - lastSeqBefore;
    say(
      `(d) legacyFrameSent=${legacyFrame !== null} legacyRunId=${String(legacyFrame?.runId)} ` +
        `legacySeq=${String(legacyFrame?.seq)} legacyInRunEvents=${legacyInRunEvents} ` +
        `legacyLastSeqDelta=${legacyLastSeqDelta} legacyCommandState=${String(legacyFrame?.commandState)}`,
    );

    // -------------------------------------------------------------------
    // (c) The late-joiner / reconnect / retention / cap legs.
    // -------------------------------------------------------------------
    // (c1) A second, long delivery stays LIVE, so "the queue is non-empty" is a
    // real reading rather than a snapshot that happened to include a terminal.
    const longText = 'x'.repeat(DELIVERY_TEXT_MAX_CHARS + 100);
    const second = await control.send(CALLER, { sessionId: SESSION_ID, content: longText });
    assert.ok(second.ok, `the busy send must be accepted (got ${JSON.stringify(second)})`);
    assert.ok(second.queued, 'a send behind an open turn is queued');
    const secondDeliveryId = second.queuedMessageUuid ?? '';
    assert.ok(secondDeliveryId, 'the queued send must name the uuid its delivery is addressed by');
    await settle();

    const lateFrames: ActivityProtocolFrame[] = [];
    const unsubscribeLate = store.subscribe(SESSION_ID, (frame) => lateFrames.push(frame));
    const lateFirst = lateFrames[0] ?? null;
    const lateJoinedEntries = entriesOf(lateFirst);
    const lateJoinerQueued = liveIds(lateJoinedEntries).length;
    const restLate = await wire.getSnapshot(SESSION_ID);
    const restLateJoinerQueued = liveIds(entriesOf(restLate)).length;
    const secondText = entriesOf(lateFirst).find((entry) => entry.deliveryId === secondDeliveryId)?.text ?? '';
    say(
      `(c1) lateJoinerFirst=${String(lateFirst?.kind)} lateJoinerQueued=${lateJoinerQueued} ` +
        `restLateJoinerQueued=${restLateJoinerQueued} lateJoinerRev=${String(lateFirst?.rev)} ` +
        `boundedTextLen=${secondText.length} boundedTextIsCap=${secondText.length === DELIVERY_TEXT_MAX_CHARS}`,
    );
    unsubscribeLate();

    // (c2) Reconnect: unsubscribing and subscribing again restores the queue AND
    // the terminals still inside the retention window.
    const beforeUnsubscribe = deliveries();
    const queuedBefore = liveIds(beforeUnsubscribe);
    const terminalBefore = terminalIds(beforeUnsubscribe);
    unsubscribe();
    unsubscribe = store.subscribe(SESSION_ID, (frame) => {
      received.push({ frame, snapshotAtDelivery: store.snapshot(SESSION_ID) });
    });
    const reconnected = received[received.length - 1];
    const restored = entriesOf(reconnected?.snapshotAtDelivery ?? null);
    const restoredQueuedIds = liveIds(restored);
    const restoredTerminalIds = terminalIds(restored);
    say(
      `(c2) queuedBefore=${JSON.stringify(queuedBefore)} restoredQueuedIds=${JSON.stringify(restoredQueuedIds)} ` +
        `terminalBefore=${JSON.stringify(terminalBefore)} restoredTerminalIds=${JSON.stringify(restoredTerminalIds)}`,
    );

    // (c4) The cap: more terminals than the limit ⇒ exactly the limit is kept, the
    // oldest first to go.
    const flooded: string[] = [];
    const floodTarget = DELIVERY_TERMINAL_LIMIT + 1;
    for (let index = 0; index < floodTarget; index += 1) {
      const sent = await control.send(CALLER, { sessionId: SESSION_ID, content: `AC383 flood ${index}` });
      if (!sent.ok) {
        break;
      }
      const deliveryId = sent.queuedMessageUuid ?? ledgerDeliveries().at(-1)?.deliveryId ?? '';
      if (!deliveryId) {
        break;
      }
      flooded.push(deliveryId);
      emitLifecycle(deliveryId, 'completed');
      await settle();
    }
    const capped = deliveries();
    const cappedTerminalIds = terminalIds(capped);
    const oldestKept = cappedTerminalIds.includes(firstDeliveryId);
    const newestKept = cappedTerminalIds.includes(flooded[flooded.length - 1] ?? '');
    // The order the ledger holds the deliveries in — the order they were accepted
    // — is what "the oldest go first" is read against.
    const allTerminalIds = ledgerDeliveries()
      .filter((delivery) => delivery.state === 'completed' || delivery.state === 'cancelled')
      .map((delivery) => delivery.deliveryId);
    const expectedKept = allTerminalIds.slice(-DELIVERY_TERMINAL_LIMIT).sort();
    const cappedExactly = isDeepStrictEqual(cappedTerminalIds, expectedKept);
    say(
      `(c4) flooded=${flooded.length} allTerminals=${allTerminalIds.length} terminalCap=${cappedTerminalIds.length} ` +
        `droppedOldest=${!oldestKept} keptNewest=${newestKept} cappedExactly=${cappedExactly}`,
    );

    // (c3) Retention: past the window the terminals go and the live rows stay.
    //
    // The driver's injected clock is what the window is judged against, and the
    // ledger's own stamps are a mix of that clock (a send's `enqueuedAt`) and the
    // CLI's arrival moment (`startedAt` / `endedAt`, which S1 reads off the frame
    // loop's wall clock). So the push is stated against wall-now: the criterion
    // moves its clock to a point one full window *past* the moment the terminals
    // were stamped, which is the same fact as "the window elapsed" for every
    // delivery in the session, and it is the reading — terminals gone, live rows
    // kept — that the assertion is about.
    clock = Date.now() + DEFAULT_DELIVERY_RETENTION_MS + 60_000;
    const afterWindow = deliveries();
    const keptLive = liveIds(afterWindow).length;
    const droppedTerminal = allTerminalIds.length - terminalIds(afterWindow).length;
    say(
      `(c3) pushedPastWindowBy=${DEFAULT_DELIVERY_RETENTION_MS + 60_000} droppedTerminal=${droppedTerminal} ` +
        `ofTerminals=${allTerminalIds.length} keptLive=${keptLive}`,
    );

    // -------------------------------------------------------------------
    // Assertions — readings first, so a red lands on the reading that is wrong.
    // -------------------------------------------------------------------

    // (a)
    assert.ok(shapeKeysExact, 'every delivery entry must carry exactly the ten SPEC §7.1 fields');
    assert.ok(startedState === 'started', `the driven delivery must read started (read ${String(startedState)})`);
    assert.ok(textOnQueued > 0, `a live delivery must carry its text (read ${textOnQueued})`);
    assert.ok(
      maxTextLen <= DELIVERY_TEXT_MAX_CHARS,
      `live text must be bounded to ${DELIVERY_TEXT_MAX_CHARS} (read ${maxTextLen})`,
    );
    const terminalEntries = deliveries().filter(
      (entry) => (entry.state === 'completed' || entry.state === 'cancelled') && entry.text !== null,
    );
    assert.equal(terminalEntries.length, 0, 'a terminal delivery must carry no text');

    // (b)
    assert.equal(
      upserts.length,
      expectedChanges,
      `every delivery change must produce exactly one frame (${upserts.length} frames, ${expectedChanges} changes)`,
    );
    assert.equal(
      ticksAfterInit,
      expectedChanges,
      `the driver must announce exactly the changes the scenario drove (announced ${ticksAfterInit})`,
    );
    assert.deepEqual(
      revSequence,
      upserts.map((_entry, index) => index + 1),
      `rev must step by exactly one per change (read ${JSON.stringify(revSequence)})`,
    );
    assert.ok(bodiesMatch, 'every upsert body must equal the store snapshot at the same instant');
    assert.equal(ticksAfterPassiveFrame, ticksAfterInit, 'a frame that changes no delivery must announce nothing');
    assert.equal(heartbeatRev, storeRev, `the announced revision must equal the store's (${heartbeatRev} vs ${storeRev})`);

    // (d)
    assert.ok(legacyFrame !== null, 'the legacy command_lifecycle frame must still be sent');
    assert.equal(legacyFrame?.runId, undefined, 'the degraded legacy frame must carry no runId');
    assert.equal(legacyFrame?.seq, undefined, 'the degraded legacy frame must carry no seq');
    assert.equal(legacyInRunEvents, 0, 'the degraded legacy frame must not enter any run event buffer');
    assert.equal(legacyLastSeqDelta, 0, 'the degraded legacy frame must not advance a run lastSeq');

    // (c)
    // The late-joiner reading comes first, and deliberately so: it is the one the
    // "no snapshot at subscribe" false form reds, and a red that landed on a
    // neighbouring assertion in the same leg would not be the reading under test.
    assert.ok(lateJoinerQueued > 0, `a late joiner must read the live queue (read ${lateJoinerQueued})`);
    assert.equal(lateFirst?.kind, 'activity.snapshot', 'a late joiner must be handed a snapshot first');
    assert.equal(
      restLateJoinerQueued,
      lateJoinerQueued,
      'the REST snapshot and the greet must agree about the queue',
    );
    // And the same greet, for the connection that joined before any change.
    assert.equal(received[0]?.frame.kind, 'activity.snapshot', 'a joiner must be greeted with a snapshot first');
    assert.equal(
      secondText.length,
      DELIVERY_TEXT_MAX_CHARS,
      `the queued row's text must be cut to the cap (read ${secondText.length})`,
    );
    assert.deepEqual(restoredQueuedIds, queuedBefore, 'a reconnect must restore the queued rows');
    assert.deepEqual(restoredTerminalIds, terminalBefore, 'a reconnect must restore the retained terminals');
    assert.ok(flooded.length > 0, 'the cap leg must have flooded real deliveries');
    assert.equal(
      cappedTerminalIds.length,
      DELIVERY_TERMINAL_LIMIT,
      `a session must keep exactly ${DELIVERY_TERMINAL_LIMIT} terminal rows (read ${cappedTerminalIds.length})`,
    );
    assert.ok(cappedExactly, 'the rows kept must be the newest ones, in ledger order');
    assert.ok(!oldestKept, 'the oldest terminal row must be the first dropped');
    assert.ok(newestKept, 'the newest terminal row must be kept');
    assert.equal(
      droppedTerminal,
      allTerminalIds.length,
      `every terminal must be dropped past the window (dropped ${droppedTerminal} of ${allTerminalIds.length})`,
    );
    assert.ok(keptLive > 0, `past the window live rows must stay (kept ${keptLive})`);

    say(`[readings] elapsed=${Date.now() - STARTED_AT}ms`);
  } finally {
    unsubscribe?.();
    setActivityChangeNotifier(null);
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (wire) {
      await wire.close();
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < ELAPSED_LIMIT_MS, `the criterion finished in ${elapsed}ms, under its ${ELAPSED_LIMIT_MS}ms budget`);
});

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Harness = {
  driver: ClaudeResidentHostDriver;
  control: ReturnType<typeof createChatControlService>;
  emit(frame: AnyRecord): void;
  /** Every frame written to the run's audience, parsed off the wire. */
  outbound: AnyRecord[];
  /** The audience: a plain `{readyState, send}` literal, never a socket. */
  connection: RealtimeClientConnection;
};

/**
 * Boots the real control service over the real resident driver with a scripted
 * process and one wire-level audience, exactly as AC-382's criterion does.
 */
function createHarness(options: { now: () => number }): Harness {
  const manager = createSessionHostManager({ now: options.now, scheduler: inertScheduler() });
  manager.setTurnOpener((input) => chatRunRegistry.openTurn(input));

  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: options.now,
    connectedClientCount: () => 0,
  });

  const outbound: AnyRecord[] = [];
  const connection = {
    readyState: WS_OPEN_STATE,
    send(payload: string) {
      outbound.push(JSON.parse(payload) as AnyRecord);
    },
  } as unknown as RealtimeClientConnection;

  /** The uuids this arm has already handed back through `queuedInputUuid`. */
  const handedOut = new Map<string, string>();

  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    acceptsBusyInput: () => true,
    run: async (provider: string, command: string, runOptions: AnyRecord, writer: ProviderRuntimeWriter) =>
      driver.run(SESSION_ID, { command, options: runOptions }, writer, CONTEXT),
    abort: async () => false,
    // The uuid the provider stamped the just-queued message with. Polled rather
    // than read once because `send` asks for it BEFORE the driver has armed the
    // round: the control service resolves the send at `beforeRun`, and the write
    // into the process happens on the dispatch's own continuation.
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
    driver,
    control: createChatControlService({ runtime }),
    emit: process.emit,
    outbound,
    connection,
  };
}
