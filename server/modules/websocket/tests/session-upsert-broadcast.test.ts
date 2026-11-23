import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer, sessionsService } from '@/modules/providers/index.js';
import {
  broadcastAwaitingReplyChanged,
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
  connectedClients,
} from '@/modules/websocket/index.js';

/** The session id the watcher fixture's transcript carries. */
const SESSION_ID = 'watched-session-1';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-upsert-broadcast-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an upsert always carries the provider session id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-1');

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_upserted');
    assert.equal(connection.frames[0].sessionId, 'app-1');
    assert.equal(connection.frames[0].providerSessionId, 'native-1');
  });
});

test('the watcher path resolves a provider-native id to the same canonical event', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-2', 'native-2');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The sessions watcher only ever knows the id written in the transcript.
    await broadcastSessionUpsertedBatch(['native-2']);

    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'app-2');
    assert.equal(connection.frames[0].providerSessionId, 'native-2');
  });
});

test('a session with no provider id yet reports null rather than omitting the field', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('app-3');

    assert.equal(connection.frames.length, 1);
    assert.ok('providerSessionId' in connection.frames[0]);
    assert.equal(connection.frames[0].providerSessionId, null);
  });
});

test('an unresolvable id broadcasts nothing', async () => {
  await withIsolatedDatabase(async () => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpserted('does-not-exist');
    await broadcastSessionUpsertedBatch(['also-missing']);

    assert.deepEqual(connection.frames, []);
  });
});

test('a batch delivers every resolvable session and skips the rest', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-4', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-5', 'claude', '/workspace/demo');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch(['app-4', 'missing', 'app-5']);

    assert.deepEqual(
      connection.frames.map((frame) => frame.sessionId),
      ['app-4', 'app-5'],
    );
  });
});

test('a rename made through the service reaches other clients as one upsert', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('cli-1', 'claude', '/workspace/demo', 'first prompt');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await sessionsService.renameSessionById('cli-1', 'Renamed By The User');

    assert.equal(connection.frames.length, 1, 'one rename must announce exactly one session');
    assert.equal(connection.frames[0].kind, 'session_upserted');
    assert.equal(connection.frames[0].sessionId, 'cli-1');
    assert.equal(
      (connection.frames[0].session as { summary: string }).summary,
      'Renamed By The User',
    );
  });
});

test('an ai-title the watcher picks up reaches other clients carrying the new name', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'session-upsert-home-'));
  const workspacePath = path.join(temporaryRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const claudeHome = path.join(temporaryRoot, '.claude');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');
  const transcriptPath = path.join(workspacePath, `${SESSION_ID}.jsonl`);
  const line = (event: Record<string, unknown>) =>
    JSON.stringify({ sessionId: SESSION_ID, cwd: workspacePath, ...event });
  await writeFile(
    transcriptPath,
    [
      line({ type: 'mode', mode: 'normal' }),
      line({ type: 'user', message: { role: 'user', content: 'the first thing I typed' }, uuid: 'msg-1' }),
      // A titleless session is named after the first prompt, as the CLI names
      // it, and the `last-prompt` beside it is the entry that used to be read
      // instead — kept here so the assertion below says which of the two named
      // the row rather than only that it was named.
      line({ type: 'last-prompt', lastPrompt: 'the last thing I typed' }),
      '',
    ].join('\n'),
    'utf8',
  );

  const originalHomeDir = os.homedir;
  (os as any).homedir = () => temporaryRoot;

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();

      // Indexed first under the name derived from the transcript itself.
      await synchronizer.synchronizeFile(transcriptPath);
      assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'the first thing I typed');

      const connection = new FakeConnection();
      connectedClients.add(connection as never);

      // Claude names the session; the watcher re-indexes the file and flushes
      // the batch below, which is all the socket ever sees.
      await appendFile(
        transcriptPath,
        line({ type: 'ai-title', aiTitle: 'Generated From The Chat' }) + '\n',
        'utf8',
      );
      await synchronizer.synchronizeFile(transcriptPath);
      await broadcastSessionUpsertedBatch([SESSION_ID]);

      assert.equal(connection.frames.length, 1, 'one re-index must announce exactly one session');
      assert.equal(connection.frames[0].kind, 'session_upserted');
      assert.equal(connection.frames[0].sessionId, SESSION_ID);
      assert.equal(
        (connection.frames[0].session as { summary: string }).summary,
        'Generated From The Chat',
      );
    });
  } finally {
    (os as any).homedir = originalHomeDir;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('a closed socket is skipped', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-6', 'claude', '/workspace/demo');

    const open = new FakeConnection();
    const closing = new FakeConnection();
    closing.readyState = 3;
    connectedClients.add(open as never);
    connectedClients.add(closing as never);

    await broadcastSessionUpserted('app-6');

    assert.equal(open.frames.length, 1);
    assert.deepEqual(closing.frames, []);
  });
});

test('the awaiting-reply snapshot reaches only OPEN clients, as one whole-list frame', async () => {
  await withIsolatedDatabase(async () => {
    const open = new FakeConnection();
    const closing = new FakeConnection();
    closing.readyState = 2; // WS_CLOSING
    connectedClients.add(open as never);
    connectedClients.add(closing as never);

    const snapshot = [
      {
        sessionId: 'await-1',
        provider: 'claude' as const,
        projectId: null,
        projectPath: '/workspace/demo',
        projectDisplayName: 'demo',
        sessionTitle: 'demo 会话',
        awaitingSince: '2026-11-23T00:00:00.000Z',
        reason: 'completed' as const,
      },
    ];

    broadcastAwaitingReplyChanged(snapshot);

    assert.equal(closing.frames.length, 0, 'a closing client must not be written to');
    assert.equal(open.frames.length, 1);

    const frame = open.frames[0] as {
      kind: string;
      sessions: unknown[];
      timestamp: string;
    };
    assert.equal(frame.kind, 'awaiting_reply_changed');
    assert.deepEqual(frame.sessions, snapshot, 'the whole list travels as sent, not a delta');
    assert.ok(!Number.isNaN(Date.parse(frame.timestamp)));
  });
});
