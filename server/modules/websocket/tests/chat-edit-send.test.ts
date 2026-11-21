import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { handleChatConnection } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'edit-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/** Two turns and an edit of the second, which is the transcript the gateway reads. */
const TRANSCRIPT_ROWS = [
  {
    type: 'user', uuid: 'e-u1', parentUuid: null, sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
  },
  {
    type: 'assistant', uuid: 'e-a1', parentUuid: 'e-u1', sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:01.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'reply' }] },
  },
  {
    type: 'user', uuid: 'e-u2', parentUuid: 'e-a1', sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
  },
];

/**
 * The same two turns as a Codex rollout. Codex rows carry no id of their own,
 * so the edit anchor is the enclosing turn — which is also the unit its fork
 * endpoint cuts at.
 */
const CODEX_TRANSCRIPT_ROWS = [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } },
];

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

/**
 * The host-manager seam the resident rebuild goes through, plus the ordering
 * log its criterion needs.
 *
 * `closeHostForEditAndWait` yields a microtask before it answers, so the log
 * says more than "it was called": the run only appears after `close-done`. That
 * is exactly what a fire-and-forget close cannot produce, and what makes the
 * "closed *before* the replacement starts" half of the criterion observable
 * rather than asserted by construction.
 *
 * `truncatedBeforeClose` is read at entry, mirroring the Codex case: the
 * clients have to be told to drop the superseded turns before a rebuild that
 * can be slow begins.
 */
function createFakeHostManager(socket: ReturnType<typeof createFakeSocket>, events: string[]) {
  const rewinds: string[] = [];
  const manager = {
    rewinds,
    failNextClose: null as Error | null,
    truncatedBeforeClose: false,
    async closeHostForEditAndWait(sessionId: string): Promise<{ found: boolean }> {
      events.push('close-start');
      manager.truncatedBeforeClose = socket.frames.some(
        (frame) => frame.kind === 'history_truncated',
      );
      await Promise.resolve();
      if (manager.failNextClose) {
        const error = manager.failNextClose;
        manager.failNextClose = null;
        throw error;
      }
      rewinds.push(sessionId);
      events.push('close-done');
      return { found: true };
    },
    attachViewer(): void {
      // The subscription path's verb. Nothing in this file subscribes, so a
      // no-op is the whole of it.
    },
  };
  return manager;
}

/**
 * Set by a test that needs a run to still be in flight when the next frame
 * arrives; the stub runtime returns immediately otherwise. Released when the
 * test ends, so no stub run is left pending for the rest of the file.
 */
let holdRun: Promise<void> | null = null;
let releaseHeldRun: (() => void) | null = null;

function holdTheNextRun(): void {
  holdRun = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
}

async function withGateway(
  provider: string,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
    hosts: ReturnType<typeof createFakeHostManager>;
    events: string[];
    sendFrame: (frame: Record<string, unknown>) => Promise<void>;
  }) => Promise<void>,
  rows: unknown[] = TRANSCRIPT_ROWS,
  options: { resident?: boolean; failRun?: Error } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-edit-send-'));
  const transcriptPath = path.join(tempDirectory, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const events: string[] = [];
  const socket = createFakeSocket();
  // Installed for every case, not only the resident ones: a per-run edit that
  // never reaches the rewind has to prove it did not, and it can only prove
  // that against a seam that would have answered.
  const hosts = createFakeHostManager(socket, events);

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, provider, tempDirectory, 'Edit session', now, now, transcriptPath);
    if (options.resident) {
      sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident');
    }

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (runProvider: string, command: string, runtimeOptions: Record<string, unknown>) => {
            events.push('run');
            runs.push({ provider: runProvider, command, options: runtimeOptions });
            if (options.failRun) {
              throw options.failRun;
            }
            if (holdRun) {
              await holdRun;
            }
          },
        } as never,
        sessionHostManager: hosts as never,
      },
    );

    // `emit` discards the listener's promise, so the fixture reaches for the
    // listener `handleChatConnection` just registered and awaits the turn
    // itself. Awaiting that promise is the signal the assertions need: it
    // settles exactly when the turn is over, rather than after a guess at how
    // long it takes.
    const handleMessage = socket.listeners('message')[0] as MessageHandler;
    const sendFrame = async (frame: Record<string, unknown>): Promise<void> => {
      await handleMessage(JSON.stringify(frame));
    };

    await runTest({ socket, runs, hosts, events, sendFrame });
  } finally {
    releaseHeldRun?.();
    releaseHeldRun = null;
    holdRun = null;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * The async listener `handleChatConnection` registers, and the promise it
 * returns for one frame. `emit` throws that promise away, so the fixture takes
 * the listener itself and awaits the turn.
 */
type MessageHandler = (rawMessage: unknown) => Promise<void>;

/**
 * Resolves only once `condition` holds, yielding to the event loop between
 * checks.
 *
 * Waiting on the condition — a run that has been registered, a frame that has
 * arrived — is the point: the wait then lasts exactly as long as the turn
 * does. A fixed sleep cannot, and this file's was the whole defect. Under load
 * the handler's own async work (reading the provider transcript, opening the
 * database) outlives any constant the fixture picks, so the assertions read the
 * state from before the turn; the still-running handler then outlives the
 * teardown and re-reads a database that no longer holds the session, which is
 * the `SESSION_NOT_FOUND` the driver's log reported.
 *
 * The deadline is a failure bound, not the synchronisation: it turns a signal
 * that never arrives into a named assertion failure instead of a hang.
 */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('an edit resumes through the turn before the one being replaced', async () => {
  await withGateway('claude', async ({ runs, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'a better second prompt',
    });

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'a better second prompt');
    // Inclusive of the row it names, so this is the last turn KEPT.
    assert.equal(runs[0].options.resumeAnchorId, 'e-a1');
    assert.equal(runs[0].options.resumeFromScratch, false);
  });
});

test('editing the first prompt starts the conversation over', async () => {
  await withGateway('claude', async ({ runs, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u1',
      content: 'a better first prompt',
    });

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.resumeAnchorId, undefined);
    assert.equal(runs[0].options.resumeFromScratch, true);
  });
});

test('every subscribed client is told to drop the superseded turns', async () => {
  await withGateway('claude', async ({ socket, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'replacement',
    });

    const truncation = socket.frames.find((frame) => frame.kind === 'history_truncated');
    assert.ok(truncation, 'a history_truncated frame is emitted');
    assert.equal(truncation?.anchorId, 'e-u2');
    assert.equal(truncation?.sessionId, SESSION_ID);
    // Sequenced like every other run event, so a reconnecting tab replays it.
    assert.equal(typeof truncation?.seq, 'number');
  });
});

test('an edit without an anchor is refused', async () => {
  await withGateway('claude', async ({ socket, runs, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      content: 'no anchor',
    });

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'ANCHOR_REQUIRED');
  });
});

test('an anchor the transcript does not hold is refused', async () => {
  await withGateway('claude', async ({ socket, runs, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'not-in-transcript',
      content: 'replacement',
    });

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'ANCHOR_NOT_FOUND');
  });
});

test('a provider that cannot re-run from a point is refused rather than sending a new message', async () => {
  await withGateway('cursor', async ({ socket, runs, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'replacement',
    });

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'EDIT_NOT_SUPPORTED');
  });
});

test('a refused send never rewinds the conversation', async () => {
  await withGateway('codex', async ({ socket, runs, sendFrame }) => {
    // The rewind moves the session onto a different provider transcript and
    // cannot be undone, so a send the gateway is about to refuse must not
    // reach it. A run already in flight is the realistic way that happens: a
    // scheduled message, or another device.
    const realRewind = sessionsService.rewindSessionForEdit;
    let rewound = false;
    sessionsService.rewindSessionForEdit = async () => { rewound = true; };
    holdTheNextRun();

    try {
      socket.emit('message', JSON.stringify({
        type: 'chat.send',
        sessionId: SESSION_ID,
        content: 'a turn that is already running',
      }));
      // This turn is deliberately left in flight, so its handler's promise is
      // not available to await — the real signal is the run having been
      // registered, which is also what the assertion below reads.
      await waitFor(() => runs.length === 1, 'the in-flight run to be registered');
      assert.equal(runs.length, 1);

      await sendFrame({
        type: 'chat.edit-send',
        sessionId: SESSION_ID,
        anchorId: 'turn-b',
        content: 'an edit that arrives too late',
      });
    } finally {
      sessionsService.rewindSessionForEdit = realRewind;
    }

    assert.equal(rewound, false);
    assert.equal(runs.length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'RUN_IN_PROGRESS');
  }, CODEX_TRANSCRIPT_ROWS);
});

test('a provider that has to branch to rewind is rewound before the run, not during it', async () => {
  await withGateway('codex', async ({ socket, runs, sendFrame }) => {
    // The rewind itself belongs to the provider and is covered there; what
    // this asserts is the gateway's half — that a provider which reports it
    // rewound gets an ordinary run instead of one carrying a resume anchor its
    // runtime would not know what to do with.
    const realRewind = sessionsService.rewindSessionForEdit;
    const rewindCalls: unknown[] = [];
    let truncatedBeforeRewind = false;
    sessionsService.rewindSessionForEdit = async (sessionId: string, keepThroughId: string | null) => {
      truncatedBeforeRewind = socket.frames.some((frame) => frame.kind === 'history_truncated');
      rewindCalls.push({ sessionId, keepThroughId });
    };

    try {
      await sendFrame({
        type: 'chat.edit-send',
        sessionId: SESSION_ID,
        anchorId: 'turn-b',
        content: 'a better second prompt',
      });
    } finally {
      sessionsService.rewindSessionForEdit = realRewind;
    }

    // Resolved from the real Codex rollout: the turn before the edited one.
    assert.deepEqual(rewindCalls, [{ sessionId: SESSION_ID, keepThroughId: 'turn-a' }]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'a better second prompt');
    assert.equal(runs[0].options.resumeAnchorId, undefined);
    assert.equal(runs[0].options.resumeFromScratch, undefined);

    // Clients still hear about the cut; how it was made is the server's
    // business. And they hear about it first: a rewind that branches waits on
    // a spawned process, and holding the frame until it returned left the
    // replaced message on screen for about a second.
    assert.ok(socket.frames.some((frame) => frame.kind === 'history_truncated'));
    assert.equal(truncatedBeforeRewind, true);
  }, CODEX_TRANSCRIPT_ROWS);
});

// --- The resident rebuild -------------------------------------------------
//
// A resident session holds one process across turns, and that process already
// carries the conversation. Appending the replacement into it would leave the
// replaced turn and everything it produced in context and in the transcript,
// which is the defect these cases are about. The edit therefore closes the
// host and cold-starts a replacement from the same truncation point.

test('an edit on a resident session restarts the host from the truncation point', async () => {
  await withGateway('claude', async ({ socket, runs, hosts, events, sendFrame }) => {
    const before = sessionsDb.getSessionById(SESSION_ID);
    const rowsBefore = sessionsDb.getAllSessions().length;

    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'a better second prompt',
    });

    // Closed first, started after: `run` is only logged once `close-done` is.
    // A rewind that was merely fired off would log `run` in between.
    assert.deepEqual(hosts.rewinds, [SESSION_ID]);
    assert.deepEqual(events, ['close-start', 'close-done', 'run']);

    // The replacement carries the same anchor a per-run edit does — the turn
    // before the edited one — instead of being appended to the live process.
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'a better second prompt');
    assert.equal(runs[0].options.resumeAnchorId, 'e-a1');
    assert.equal(runs[0].options.resumeFromScratch, false);

    // Clients are told to drop the superseded turns before the rebuild, not
    // after it: a rebuild is slower than an append, and the edited-away
    // message must not sit on screen for that time.
    assert.ok(socket.frames.some((frame) => frame.kind === 'history_truncated'));
    assert.equal(hosts.truncatedBeforeClose, true);

    // The same conversation, not a new one: the row is the row it was, column
    // for column, and nothing was inserted beside it.
    const after = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(after?.session_id, SESSION_ID);
    assert.equal(after?.provider_session_id, SESSION_ID);
    assert.equal(after?.lifecycle_mode, 'resident');
    assert.deepEqual(after, before);
    assert.equal(sessionsDb.getAllSessions().length, rowsBefore);
  }, TRANSCRIPT_ROWS, { resident: true });
});

test('editing the first prompt of a resident session still restarts the host', async () => {
  await withGateway('claude', async ({ runs, hosts, events, sendFrame }) => {
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u1',
      content: 'a better first prompt',
    });

    // Nothing precedes the edited turn, so the replacement starts the
    // conversation over — but the process holding the old one still has to go,
    // or the replacement would be appended into it.
    assert.deepEqual(hosts.rewinds, [SESSION_ID]);
    assert.deepEqual(events, ['close-start', 'close-done', 'run']);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.resumeAnchorId, undefined);
    assert.equal(runs[0].options.resumeFromScratch, true);
  }, TRANSCRIPT_ROWS, { resident: true });
});

test('an edit on a per-run session hands the anchor over and never rewinds a host', async () => {
  await withGateway('claude', async ({ runs, hosts, sendFrame }) => {
    // The seam is installed and would have answered, so an empty `rewinds`
    // says the per-run path did not take it — not that it had none to take.
    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'a better second prompt',
    });

    assert.deepEqual(hosts.rewinds, []);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.resumeAnchorId, 'e-a1');
    assert.equal(runs[0].options.resumeFromScratch, false);
  });
});

test('a resident rebuild whose host will not close ends the run and reports it once', async () => {
  await withGateway('claude', async ({ socket, runs, hosts, sendFrame }) => {
    hosts.failNextClose = new Error('the host refused to close');
    const before = sessionsDb.getSessionById(SESSION_ID);

    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'replacement',
    });

    // The provider was never asked to continue a conversation whose host was
    // not rebuilt: appending into a half-closed process is the defect itself.
    assert.equal(runs.length, 0);

    // The run ended. A rebuild that failed and left the session processing
    // would block every later turn.
    const completions = socket.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].exitCode, 1);

    // Reported exactly once — the old host failing and the replacement failing
    // are the same thing to the person who pressed edit.
    const failures = socket.frames.filter((frame) => frame.code === 'EDIT_REWIND_FAILED');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].sessionId, SESSION_ID);

    assert.deepEqual(sessionsDb.getSessionById(SESSION_ID), before);
  }, TRANSCRIPT_ROWS, { resident: true });
});

test('a resident rebuild whose replacement will not start ends the run and reports it once', async () => {
  await withGateway('claude', async ({ socket, runs, hosts, sendFrame }) => {
    const before = sessionsDb.getSessionById(SESSION_ID);

    await sendFrame({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'replacement',
    });

    // The other half of the rebuild: the old host closed, but the replacement
    // never came up. The edit still did not take.
    assert.deepEqual(hosts.rewinds, [SESSION_ID]);
    assert.equal(runs.length, 1);

    const completions = socket.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].exitCode, 1);

    const failures = socket.frames.filter((frame) => frame.code === 'EDIT_REWIND_FAILED');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].sessionId, SESSION_ID);

    assert.deepEqual(sessionsDb.getSessionById(SESSION_ID), before);
  }, TRANSCRIPT_ROWS, { resident: true, failRun: new Error('the CLI would not come back up') });
});
