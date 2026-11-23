import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionAwaitingReplyService } from '@/modules/providers/services/session-awaiting-reply.service.js';
import { installSessionBroadcastPort } from '@/shared/ports/session-broadcast.port.js';
import type { SessionBroadcastPort } from '@/shared/ports/session-broadcast.port.js';
import type { AwaitingReplyListItem } from '@/shared/types.js';

/** Name the installed broadcast contract for the fixture below. */
type InstallableSessionBroadcastPort = SessionBroadcastPort;

/**
 * Builds a throwaway database and points the connection at it, so the store and
 * the migration that adds its columns are exercised for real rather than against
 * a stub. Mirrors the sessions repository's own integration test.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'awaiting-reply-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  // A mark is exactly the event that spawns the off-browser desktop alert, and a
  // developer machine may export the notify command. Clear both spellings for the
  // test body so a unit test never raises a toast on somebody's workstation; the
  // alert channel has its own tests.
  const savedNotifyCommand = {
    canonical: process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD,
    legacy: process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD,
  };
  delete process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD;
  delete process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD;

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (savedNotifyCommand.canonical !== undefined) {
      process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD = savedNotifyCommand.canonical;
    }
    if (savedNotifyCommand.legacy !== undefined) {
      process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD = savedNotifyCommand.legacy;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A broadcast port that does nothing: what a process without the websocket module has. */
function silentBroadcastPort(): InstallableSessionBroadcastPort {
  return {
    broadcastSessionUpserted: async () => undefined,
    broadcastSessionUpsertedBatch: async () => undefined,
    broadcastAwaitingReplyChanged: () => undefined,
  };
}

/**
 * Captures every snapshot the service announces.
 *
 * The service reads the broadcast port at call time, so installing a recording
 * port here is exactly the seam production uses — no module has to be mocked.
 */
function captureSnapshots(): { snapshots: AwaitingReplyListItem[][]; restore: () => void } {
  const snapshots: AwaitingReplyListItem[][] = [];
  const previous = silentBroadcastPort();
  installSessionBroadcastPort({
    ...previous,
    broadcastAwaitingReplyChanged: (sessions) => {
      snapshots.push(sessions);
    },
  });
  return { snapshots, restore: () => installSessionBroadcastPort(previous) };
}

/** Creates one session row (and its project) and returns the app session id. */
function createSession(providerSessionId: string, projectPath: string, customName: string): string {
  return sessionsDb.createSession(providerSessionId, 'claude', projectPath, customName);
}

test('a mark starts a wait, keeps the first instant across reason changes, and a clear ends it', async () => {
  await withIsolatedDatabase(() => {
    const capture = captureSnapshots();
    try {
      const sessionId = createSession('provider-a', '/workspace/alpha', 'Alpha 会话');

      assert.equal(sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'permission'), true);
      const firstAt = sessionsDb.getSessionById(sessionId)?.awaiting_reply_at;
      assert.ok(firstAt, 'the mark must record when the wait began');
      assert.equal(sessionsDb.getSessionById(sessionId)?.awaiting_reply_reason, 'permission');

      // A new reason while already waiting is a change of reason only, and the
      // instant of the original wait survives so "waiting since" stays true.
      assert.equal(sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'completed'), true);
      assert.equal(sessionsDb.getSessionById(sessionId)?.awaiting_reply_reason, 'completed');
      assert.equal(sessionsDb.getSessionById(sessionId)?.awaiting_reply_at, firstAt);

      // The same reason again changes nothing and announces nothing.
      const announced = capture.snapshots.length;
      assert.equal(sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'completed'), false);
      assert.equal(capture.snapshots.length, announced);

      assert.equal(sessionAwaitingReplyService.clearSessionAwaitingReply(sessionId), true);
      assert.equal(sessionsDb.getSessionById(sessionId)?.awaiting_reply_at, null);
      assert.equal(sessionsDb.getSessionById(sessionId)?.awaiting_reply_reason, null);
      // Clearing a session that is not waiting is a silent no-op.
      assert.equal(sessionAwaitingReplyService.clearSessionAwaitingReply(sessionId), false);
      // A null/undefined id (a frame that named no session) never throws.
      assert.equal(sessionAwaitingReplyService.markSessionAwaitingReply(undefined, 'failed'), false);
      assert.equal(sessionAwaitingReplyService.clearSessionAwaitingReply(null), false);
    } finally {
      capture.restore();
    }
  });
});

test('the list carries project and session naming, oldest wait first, and omits archived rows', async () => {
  await withIsolatedDatabase(() => {
    const firstProject = '/workspace/beta';
    projectsDb.createProjectPath(firstProject, 'Beta 项目');
    const newer = createSession('provider-newer', firstProject, '新会话');
    const older = createSession('provider-older', '/workspace/gamma', '');
    const archived = createSession('provider-archived', firstProject, '归档会话');

    sessionsDb.updateSessionIsArchived(archived, true);

    sessionAwaitingReplyService.markSessionAwaitingReply(newer, 'completed');
    sessionAwaitingReplyService.markSessionAwaitingReply(older, 'failed');
    // Archived rows are left alone by the store, so this stays unrecorded.
    assert.equal(sessionAwaitingReplyService.markSessionAwaitingReply(archived, 'completed'), false);

    // Force a deterministic order: the older wait was written last, so rewrite
    // its instant to be earlier than the newer one.
    getConnection()
      .prepare('UPDATE sessions SET awaiting_reply_at = ? WHERE session_id = ?')
      .run('2020-01-01T00:00:00.000Z', older);

    const list = sessionAwaitingReplyService.listAwaitingReplySessions();
    assert.deepEqual(
      list.map((item) => item.sessionId),
      [older, newer],
      'the longest wait sorts first',
    );

    const olderRow = list[0];
    assert.equal(olderRow.reason, 'failed');
    assert.equal(olderRow.projectDisplayName, 'gamma', 'no project row => path basename');
    assert.equal(olderRow.sessionTitle, older, 'no name => the session id');
    assert.equal(olderRow.provider, 'claude');

    const newerRow = list[1];
    assert.equal(newerRow.reason, 'completed');
    assert.equal(newerRow.projectDisplayName, 'Beta 项目');
    assert.equal(newerRow.sessionTitle, '新会话');
    assert.ok(newerRow.projectId, 'a known project contributes its id');
    assert.equal(newerRow.projectPath, firstProject);
  });
});

test('marking and clearing announce the whole list, and only the changed cases announce', async () => {
  await withIsolatedDatabase(() => {
    const capture = captureSnapshots();
    try {
      const sessionId = createSession('provider-announce', '/workspace/delta', 'Delta');

      sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'completed');
      assert.equal(capture.snapshots.length, 1);
      assert.equal(capture.snapshots[0].length, 1);
      assert.equal(capture.snapshots[0][0].sessionId, sessionId);

      // A reason change still announces (the row's label changed) ...
      sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'permission');
      assert.equal(capture.snapshots.length, 2);

      // ... and a clear announces the now-empty list.
      sessionAwaitingReplyService.clearSessionAwaitingReply(sessionId);
      assert.equal(capture.snapshots.length, 3);
      assert.deepEqual(capture.snapshots[2], []);
    } finally {
      capture.restore();
    }
  });
});
