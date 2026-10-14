/**
 * Criterion: a Live Voice delivery the CLI QUEUES and then RUNS must have its
 * `command_lifecycle` frames reach the browser, so the voice bar's row
 * ("Waiting in the queue") can disappear.
 *
 * WHAT THIS FILE IS FOR. Measured 2026-10-13: during Live Voice the withdraw
 * rows on the voice bar accumulated (1 → 3) and never went away. Two layers
 * were already excluded — the client contract is green
 * (`voicePendingWithdraw.test.tsx`, "a completed command drops the row
 * entirely") and the uuid contract is right by design (the CLI's
 * `command_lifecycle` reports back the host-stamped `command_uuid`, see
 * `docs/proposals/claude-resident-sessions-experiments.md` §9). What was
 * missing was the frame: the `completed` row the client's tombstone waits for
 * never reached the browser.
 *
 * WHERE IT WENT. A resident session accepts a spoken sentence while a turn is
 * running and opens a SUPERSEDING run for it (`dispatchRun` →
 * `startRun({ supersedeRunning: true })`). The CLI queues the command and the
 * driver routes the command's frames through the round that owns it — the
 * superseding run's writer. That writer was created with `connection: null`
 * (an MCP/voice send binds no socket) and nothing ever attached the socket that
 * was already watching the session to it, so the queued turn's frames — its
 * `command_lifecycle` `started`/`completed` above all — were written to a
 * writer with an empty audience. The row appears (its `queued` frame is emitted
 * while the run that DID have the browser in its audience is still the front
 * round) and never resolves: exactly the accumulation that was reported.
 *
 * HOW IT IS PROVEN. Three readings, all against the registry that decides who
 * a run's frames are written to:
 *
 *   · FALSE FORM (the file's FIRST test): a registry built with the audience
 *     carry off — the pre-fix shape — where the queued turn's `started` /
 *     `completed` never reach the socket watching the session.
 *   · TRUE FORM: the same drive on a default registry, where all three
 *     lifecycle rows arrive on that socket, in order, under the app session id.
 *   · END TO END: the real control service's busy `session_send` (the voice
 *     path: `queued: true` + a `queuedMessageUuid`), then the CLI's own
 *     `command_lifecycle` rows normalized by the real `ClaudeSessionsProvider`
 *     and forwarded through the real driver seam — the frame the browser needs
 *     arrives for the exact uuid the send handed back.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider, forwardNormalizedFrames } from '@/modules/providers/index.js';
import {
  WS_OPEN_STATE,
  chatRunRegistry,
  createChatControlService,
  createChatRunRegistry,
} from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider, RealtimeClientConnection } from '@/shared/types.js';

const SESSION_ID = 'voice-queue-lifecycle-session';
const PROVIDER = 'claude';
/** The CLI's own id for the transcript; the registry remaps it to the app id on the way out. */
const NATIVE_SESSION_ID = 'native-voice-queue-lifecycle';

/** The voice path reaches the control service as the MCP gateway (`via: 'mcp'`). */
const CALLER = { userId: 1, via: 'mcp' as const };

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`voice-queue-lifecycle ${line}`);
}

/**
 * A stand-in for the browser's socket: records every frame the server writes to
 * it, and is `OPEN` so the writer does not collect it as dead.
 */
type RecordingSocket = {
  readyState: number;
  readonly frames: AnyRecord[];
  send(data: string): void;
};

function createRecordingSocket(): RecordingSocket {
  const frames: AnyRecord[] = [];
  return {
    readyState: WS_OPEN_STATE,
    frames,
    send(data: string): void {
      frames.push(JSON.parse(data) as AnyRecord);
    },
  };
}

const connection = (socket: RecordingSocket): RealtimeClientConnection =>
  socket as unknown as RealtimeClientConnection;

/** The `command_lifecycle` frames a socket received, in order. */
function lifecycleFrames(socket: RecordingSocket): AnyRecord[] {
  return socket.frames.filter((frame) => frame.kind === 'command_lifecycle');
}

/** The states of the `command_lifecycle` frames a socket received, in order. */
function lifecycleStates(socket: RecordingSocket): unknown[] {
  return lifecycleFrames(socket).map((frame) => frame.commandState);
}

/**
 * Drives one raw CLI row through the driver's real normalize-and-forward seam —
 * the same call `ClaudeResidentHostDriver.observe` makes — into `writer`.
 */
const provider = new ClaudeSessionsProvider();

function pushCliRow(writer: unknown, commandUuid: string, state: string): void {
  forwardNormalizedFrames({
    transformedMessage: { type: 'command_lifecycle', command_uuid: commandUuid, state },
    sessionId: NATIVE_SESSION_ID,
    normalizeMessage: (message, sessionId) => provider.normalizeMessage(message, sessionId),
    writer: writer as Parameters<typeof forwardNormalizedFrames>[0]['writer'],
  });
}

// ---------------------------------------------------------------------------------------------
// FALSE FORM — the file's first test. The pre-fix shape: the superseding run's writer has no
// audience, so the command's `started`/`completed` rows reach nobody.
// ---------------------------------------------------------------------------------------------

test('false form: without the audience carry the queued turn never reports `completed`', () => {
  const registry = createChatRunRegistry({ carryAudience: false });
  const socket = createRecordingSocket();

  // A turn is running for the session and the browser is watching it.
  const first = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
  });
  assert.ok(first);
  assert.equal(registry.attachConnection(SESSION_ID, connection(socket)), true);

  // A spoken sentence arrives while the process is busy: the CLI queues it and a
  // superseding run owns its frames.
  const queued = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
    supersedeRunning: true,
  });
  assert.ok(queued);
  assert.notEqual(queued.runId, first.runId);

  // `queued` is emitted while the FIRST turn is still the front round; `started`
  // and `completed` land after it, when the superseding round owns the stream.
  pushCliRow(first.writer, 'queued-1', 'queued');
  pushCliRow(queued.writer, 'queued-1', 'started');
  pushCliRow(queued.writer, 'queued-1', 'completed');

  const states = lifecycleStates(socket);
  say(`false form: lifecycleStates=${JSON.stringify(states)}`);
  assert.deepEqual(
    states,
    ['queued'],
    'the pre-fix chain breaks after `queued`: the row appears and never resolves',
  );
});

// ---------------------------------------------------------------------------------------------
// TRUE FORM — the same drive on a default registry: the audience survives the run change.
// ---------------------------------------------------------------------------------------------

test('true form: the session audience carries onto the superseding run, so all three rows arrive', () => {
  const registry = createChatRunRegistry();
  const socket = createRecordingSocket();

  const first = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
  });
  assert.ok(first);
  assert.equal(registry.attachConnection(SESSION_ID, connection(socket)), true);

  const queued = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
    supersedeRunning: true,
  });
  assert.ok(queued);

  pushCliRow(first.writer, 'queued-2', 'queued');
  pushCliRow(queued.writer, 'queued-2', 'started');
  pushCliRow(queued.writer, 'queued-2', 'completed');

  const frames = lifecycleFrames(socket);
  const states = frames.map((frame) => frame.commandState);
  say(`true form: lifecycleStates=${JSON.stringify(states)}`);
  assert.deepEqual(states, ['queued', 'started', 'completed'], 'the whole lifecycle must reach the browser');
  // The terminal row — the one the client's tombstone waits for — is the
  // superseding run's, remapped from the CLI's native id to the app session id
  // the voice bar subscribes under.
  assert.equal(frames[frames.length - 1]!.commandUuid, 'queued-2');
  assert.equal(frames[frames.length - 1]!.sessionId, SESSION_ID);
});

// ---------------------------------------------------------------------------------------------
// THE FOUR OPENING EDGES (2026-10-14). The carry above only covered a socket that was ALREADY
// watching when the run changed. The next defect happened at the edges of that window: a page
// opened while the session was idle, an interrupt between queue and completion, a refresh
// mid-run, and two sentences that coalesced into one command. Each is its own test below so a
// regression names which edge broke.
// ---------------------------------------------------------------------------------------------

/**
 * A socket the server has already collected: the writer must not write to it, and the registry's
 * connection count must not count it. The value is `WebSocket.CLOSED`; only `WS_OPEN_STATE` is
 * exported by the state module, so the closed state is spelled here.
 */
const WS_CLOSED_STATE = 3;

test('idle subscribe: a socket watching an IDLE session receives the next run\'s `completed`', () => {
  const log: Array<{ commandUuid: string; commandState: string; runId: string; connections: number }> = [];
  const registry = createChatRunRegistry({ lifecycleLog: (line) => log.push(line) });
  const socket = createRecordingSocket();

  // The page opens while the session is IDLE — no run in flight. The subscribe must still leave
  // the socket watching, or the very next run opens with nobody to write the queue rows to.
  assert.equal(registry.isProcessing(SESSION_ID), false, 'the session starts idle');
  assert.equal(
    registry.attachConnection(SESSION_ID, connection(socket)),
    false,
    'an idle subscribe registers no current run — and must still register the watcher',
  );

  // A voice `session_send` arrives with `connection: null`: the run it opens binds no socket of
  // its own. Without the session-level watcher this run's frames go to nobody.
  const run = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
  });
  assert.ok(run);

  for (const state of ['queued', 'started', 'completed']) {
    pushCliRow(run.writer, 'idle-1', state);
  }

  const states = lifecycleStates(socket);
  say(`idle subscribe: lifecycleStates=${JSON.stringify(states)}`);
  assert.deepEqual(
    states,
    ['queued', 'started', 'completed'],
    'a page opened while idle must still see the queued command run to its end',
  );

  // The forwarding log: one line per frame, carrying the four readings a live test needs — which
  // command, what state, which run it went to, and how many OPEN sockets that run's writer held.
  say(`idle subscribe: forwardLog=${JSON.stringify(log)}`);
  assert.equal(log.length, 3, 'one line per forwarded command_lifecycle');
  assert.deepEqual(
    log.map((line) => [line.commandUuid, line.commandState]),
    [['idle-1', 'queued'], ['idle-1', 'started'], ['idle-1', 'completed']],
    'each line names the frame it recorded',
  );
  for (const line of log) {
    assert.equal(line.runId, run.runId, 'the line names the run the frame was written through');
    assert.equal(line.connections, 1, 'the idle-subscribed socket is the run writer\'s one audience');
  }
});

test('interrupt: an aborted turn does not strand the queued command\'s terminal frame', () => {
  const registry = createChatRunRegistry();
  const socket = createRecordingSocket();

  const first = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
  });
  assert.ok(first);
  registry.attachConnection(SESSION_ID, connection(socket));

  // A spoken sentence arrives mid-turn: the CLI queues it and a superseding run owns its frames.
  const queued = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
    supersedeRunning: true,
  });
  assert.ok(queued);
  pushCliRow(queued.writer, 'int-1', 'queued');

  // The person interrupts the turn that was running: it ends ABORTED, through its own writer.
  first.writer.sendComplete({ exitCode: 0, aborted: true });

  // The queued command still runs and reports itself over.
  pushCliRow(queued.writer, 'int-1', 'started');
  pushCliRow(queued.writer, 'int-1', 'completed');

  const states = lifecycleStates(socket);
  say(`interrupt: lifecycleStates=${JSON.stringify(states)}`);
  assert.deepEqual(
    states,
    ['queued', 'started', 'completed'],
    'the interrupt of the previous turn must not leave the queued row without its `completed`',
  );
  assert.equal(lifecycleFrames(socket).at(-1)!.commandUuid, 'int-1', 'the terminal row is the queued command');
});

test('reconnect: a socket that subscribes mid-run receives the queued command\'s later frames', () => {
  const registry = createChatRunRegistry();
  const oldSocket = createRecordingSocket();

  const first = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
  });
  assert.ok(first);
  registry.attachConnection(SESSION_ID, connection(oldSocket));

  const queued = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
    supersedeRunning: true,
  });
  assert.ok(queued);
  pushCliRow(queued.writer, 'rec-1', 'queued');

  // The page refreshes mid-run: the old socket is gone, a fresh one subscribes to the same session.
  oldSocket.readyState = WS_CLOSED_STATE;
  const fresh = createRecordingSocket();
  assert.equal(registry.attachConnection(SESSION_ID, connection(fresh)), true, 'a run is in flight');

  pushCliRow(queued.writer, 'rec-1', 'started');
  pushCliRow(queued.writer, 'rec-1', 'completed');

  say(`reconnect: fresh=${JSON.stringify(lifecycleStates(fresh))} old=${JSON.stringify(lifecycleStates(oldSocket))}`);
  assert.deepEqual(
    lifecycleStates(fresh),
    ['started', 'completed'],
    'the socket that subscribed mid-run must receive the frames that follow it',
  );
  assert.deepEqual(
    lifecycleStates(oldSocket),
    ['queued'],
    'the collected socket receives nothing after it closed',
  );
});

test('coalesced sentences: one command in the merge window still reports its `completed`', () => {
  const registry = createChatRunRegistry();
  const socket = createRecordingSocket();

  const first = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
  });
  assert.ok(first);
  registry.attachConnection(SESSION_ID, connection(socket));

  // Two spoken sentences coalesce in the merge window into ONE queued command: both deliveries
  // carry the same queue id, so one terminal frame has to clear the row they share.
  const merged = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: NATIVE_SESSION_ID,
    connection: null,
    userId: null,
    supersedeRunning: true,
  });
  assert.ok(merged);
  pushCliRow(merged.writer, 'merge-1', 'queued');
  pushCliRow(merged.writer, 'merge-1', 'started');
  pushCliRow(merged.writer, 'merge-1', 'completed');

  const frames = lifecycleFrames(socket);
  say(`coalesced sentences: lifecycleStates=${JSON.stringify(frames.map((frame) => frame.commandState))}`);
  assert.deepEqual(
    frames.map((frame) => frame.commandState),
    ['queued', 'started', 'completed'],
    'the single merged command must run to its end so the row it backs clears',
  );
  assert.equal(frames.at(-1)!.commandUuid, 'merge-1', 'the terminal frame carries the shared queue id');
});

// ---------------------------------------------------------------------------------------------
// END TO END — a real busy voice `session_send` hands back a `queuedMessageUuid`, and the CLI's
// own lifecycle rows for that uuid reach the browser.
// ---------------------------------------------------------------------------------------------

/** A runtime gateway whose `run` parks, whose queue mints uuids, and whose busy input is accepted. */
function createParkedRuntime(): {
  queue: string[];
  releaseAll(): void;
  runtime: ProviderRuntimeGateway;
} {
  const queue: string[] = [];
  const parked: Array<(value?: unknown) => void> = [];
  let minted = 0;
  const state = {
    queue,
    releaseAll: (): void => {
      while (parked.length > 0) {
        parked.shift()?.();
      }
    },
    runtime: {
      hasRuntime: () => true,
      acceptsBusyInput: () => true,
      run: () => {
        minted += 1;
        queue.push(`spoken-command-${minted}`);
        return new Promise<unknown>((resolve) => {
          parked.push(resolve);
        });
      },
      abort: async () => false,
      cancelQueuedInput: async () => 'cancelled',
      queuedInputUuid: async () => {
        // A macrotask, so the busy turn's `run` has recorded its uuid before the
        // reading is taken, whatever the interleaving.
        await new Promise((resolve) => setImmediate(resolve));
        return queue.length > 0 ? queue[queue.length - 1]! : null;
      },
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    } as unknown as ProviderRuntimeGateway,
  };
  return state;
}

test('end to end: a queued voice send hands back a uuid whose `completed` row reaches the browser', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-queue-lifecycle-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const runtime = createParkedRuntime();
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, PROVIDER, tempDirectory, 'Voice queue lifecycle', now, now, null);

    const control = createChatControlService({ runtime: runtime.runtime });
    const socket = createRecordingSocket();

    // A turn is running and the browser is watching the session.
    const first = await control.send(CALLER, { sessionId: SESSION_ID, content: 'first spoken sentence' });
    assert.ok(first.ok, `the first voice send must register (got ${JSON.stringify(first)})`);
    assert.equal(chatRunRegistry.attachConnection(SESSION_ID, connection(socket)), true);

    // A second spoken sentence lands while the process is busy: the CLI queues it
    // and the control plane hands back the command's own queue id.
    const second = await control.send(CALLER, { sessionId: SESSION_ID, content: 'second spoken sentence' });
    assert.ok(second.ok, `the busy voice send must be queued (got ${JSON.stringify(second)})`);
    assert.equal(second.queued, true, 'a resident busy send reports queued');
    const uuid = second.queuedMessageUuid;
    assert.ok(typeof uuid === 'string' && uuid.length > 0, `queuedMessageUuid must be handed back (got ${uuid})`);
    assert.notEqual(second.runId, first.runId, 'the queued turn is a run of its own');

    // The CLI runs the queued command and reports it, as raw rows.
    const current = chatRunRegistry.getRun(SESSION_ID);
    assert.ok(current);
    for (const state of ['queued', 'started', 'completed']) {
      pushCliRow(current.writer, uuid, state);
    }

    const frames = lifecycleFrames(socket);
    const states = frames.map((frame) => frame.commandState);
    say(`end to end: uuid=${uuid} lifecycleStates=${JSON.stringify(states)}`);
    assert.deepEqual(
      states,
      ['queued', 'started', 'completed'],
      'the browser must see the queued command run to its end — this is what drops the withdraw row',
    );
    assert.equal(frames[frames.length - 1]!.commandUuid, uuid, 'the terminal row is the command the send queued');
    assert.equal(frames[frames.length - 1]!.sessionId, SESSION_ID, 'frames leave under the app session id');
  } finally {
    runtime.releaseAll();
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

void ((): LLMProvider => 'claude');
