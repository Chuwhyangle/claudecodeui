/**
 * AC — the notice registry's dismissal semantics (N1, N2, N5) over the REAL dismissal table.
 *
 *   N1  a dismissal is bound to a revision: ignoring rev-1 hides it; rev-2 re-raises it, and the
 *       old row does not suppress the new revision;
 *   N2  a `blocking` notice cannot be dismissed — the service refuses with 403 and writes NO row;
 *       a stale revision is 409; an unknown id is 404;
 *   N5  dismissals are per user: one user's dismissal does not hide another user's notice, and a
 *       user's own repeated reads agree.
 *
 * The last case drives the REAL router over a REAL express server, so the status codes the
 * criterion names are the HTTP statuses a client sees — not only the service's internal ones.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/notices/tests/notice-registry.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  noticeDismissalsDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import {
  createNoticeRegistry,
  type Notice,
  type NoticeProvider,
} from '../notice-registry.service.js';
import { createNoticesRouter } from '../notices.routes.js';

const USER_ONE = 1;
const USER_TWO = 2;
const NOTICE_ID = 'deploy:pending-build';

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;

/** The provider's current answer; each case may replace it to change the world between reads. */
let providerNotices: Notice[] = [];

const provider: NoticeProvider = {
  source: 'deploy',
  read: async () => providerNotices,
};

/** One condition notice; the deploy mapping is the provider test's job, this file needs a shape. */
function makeNotice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: NOTICE_ID,
    source: 'deploy',
    lifecycle: 'condition',
    severity: 'attention',
    revision: 'rev-1',
    scope: 'global',
    title: 'notices.deploy.pendingBuild.title',
    params: { count: 1, headSha: 'rev-1' },
    primaryAction: { id: 'deploy.build-and-restart', labelKey: 'notices.deploy.pendingBuild.action' },
    raisedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function registry() {
  return createNoticeRegistry({ providers: [provider], dismissals: noticeDismissalsDb });
}

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'notice-registry-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
  // The dismissal table carries a users FK, so both users the criterion dismisses for must exist.
  const db = getConnection();
  for (const id of [USER_ONE, USER_TWO]) {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
      id,
      `user-${id}`,
      'not-a-real-hash',
    );
  }
});

test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test.beforeEach(() => {
  getConnection().exec('DELETE FROM user_notice_dismissals');
  providerNotices = [makeNotice()];
});

test('N1: no dismissal → active; dismiss the current revision → dismissed; a NEW revision re-raises it', async () => {
  const notices = registry();

  const before = await notices.list(USER_ONE);
  assert.deepEqual(before.active.map((notice) => notice.id), [NOTICE_ID]);
  assert.deepEqual(before.dismissed, []);

  await notices.dismiss(USER_ONE, NOTICE_ID, 'rev-1');

  const afterDismiss = await notices.list(USER_ONE);
  assert.deepEqual(afterDismiss.active, [], 'the dismissed revision must leave the active list');
  assert.deepEqual(
    afterDismiss.dismissed.map((notice) => notice.revision),
    ['rev-1'],
    'the dismissed entry stays findable in the inbox (N6)',
  );

  // The condition moves on: same notice id, new revision. The stored rev-1 row must not hide it.
  providerNotices = [makeNotice({ revision: 'rev-2', params: { count: 2, headSha: 'rev-2' } })];

  const afterRevisionChange = await notices.list(USER_ONE);
  assert.deepEqual(
    afterRevisionChange.active.map((notice) => notice.revision),
    ['rev-2'],
    'a new revision is a new message: the old dismissal must not suppress it',
  );
  assert.deepEqual(afterRevisionChange.dismissed, []);
});

test('N2: a blocking notice refuses dismissal with 403 and writes no row', async () => {
  providerNotices = [makeNotice({ id: 'deploy:failed', severity: 'blocking', revision: 'fail-at' })];

  await assert.rejects(registry().dismiss(USER_ONE, 'deploy:failed', 'fail-at'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'NOTICE_NOT_DISMISSIBLE');
    return true;
  });
  assert.equal(
    noticeDismissalsDb.getDismissedRevision(USER_ONE, 'deploy:failed'),
    null,
    'a refused dismiss must not leave a row behind',
  );
});

test('N2: a stale revision is 409 and an unknown id is 404 — neither writes a row', async () => {
  await assert.rejects(registry().dismiss(USER_ONE, NOTICE_ID, 'rev-0'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'NOTICE_REVISION_CONFLICT');
    return true;
  });
  assert.equal(noticeDismissalsDb.getDismissedRevision(USER_ONE, NOTICE_ID), null);

  await assert.rejects(registry().dismiss(USER_ONE, 'deploy:missing', 'rev-1'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'NOTICE_NOT_FOUND');
    return true;
  });
  assert.equal(noticeDismissalsDb.getDismissedRevision(USER_ONE, 'deploy:missing'), null);
});

test('N5: dismissals are per user, and one user’s repeated reads agree', async () => {
  const notices = registry();

  await notices.dismiss(USER_ONE, NOTICE_ID, 'rev-1');

  const userOne = await notices.list(USER_ONE);
  const userTwo = await notices.list(USER_TWO);
  assert.deepEqual(userOne.active, [], 'user one dismissed it');
  assert.deepEqual(
    userTwo.active.map((notice) => notice.id),
    [NOTICE_ID],
    'user two never dismissed it — one user’s row must not hide another user’s notice',
  );

  const userOneAgain = await notices.list(USER_ONE);
  assert.deepEqual(userOneAgain, userOne, 'the same user reading twice must see the same result');

  await notices.dismiss(USER_TWO, NOTICE_ID, 'rev-1');
  assert.deepEqual((await notices.list(USER_TWO)).active, []);
});

/** The process error middleware, reduced to what the notices router's `AppError`s need. */
function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const status = error instanceof AppError ? error.statusCode : 500;
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  response.status(status).json({ error: error instanceof Error ? error.message : 'error', code });
}

/** One express app around the real router; `userId` null means 「no authenticated user」. */
function createApp(userId: number | null): Express {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    if (userId !== null) {
      (request as Request & { user?: { id: number } }).user = { id: userId };
    }
    next();
  });
  app.use('/api/notices', createNoticesRouter(registry()));
  app.use(errorHandler);
  return app;
}

/** Starts one app on an ephemeral port and returns its base URL plus a stop function. */
async function listen(app: Express): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

test('the router answers the four outcomes with the HTTP statuses the contract names', async () => {
  const { baseUrl, stop } = await listen(createApp(USER_ONE));
  try {
    const listBefore = await fetch(`${baseUrl}/api/notices`);
    assert.equal(listBefore.status, 200);
    const beforeBody = (await listBefore.json()) as { active: Notice[]; dismissed: Notice[] };
    assert.deepEqual(beforeBody.active.map((notice) => notice.id), [NOTICE_ID]);

    const dismissed = await fetch(`${baseUrl}/api/notices/${encodeURIComponent(NOTICE_ID)}/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 'rev-1' }),
    });
    assert.equal(dismissed.status, 200);
    assert.deepEqual(await dismissed.json(), { ok: true });

    const listAfter = (await (await fetch(`${baseUrl}/api/notices`)).json()) as {
      active: Notice[];
      dismissed: Notice[];
    };
    assert.deepEqual(listAfter.active, []);
    assert.deepEqual(listAfter.dismissed.map((notice) => notice.revision), ['rev-1']);

    const stale = await fetch(`${baseUrl}/api/notices/${encodeURIComponent(NOTICE_ID)}/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 'rev-0' }),
    });
    assert.equal(stale.status, 409);

    const unknown = await fetch(`${baseUrl}/api/notices/deploy%3Amissing/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 'rev-1' }),
    });
    assert.equal(unknown.status, 404);

    providerNotices = [makeNotice({ id: 'deploy:failed', severity: 'blocking', revision: 'fail-at' })];
    const blocked = await fetch(`${baseUrl}/api/notices/deploy%3Afailed/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 'fail-at' }),
    });
    assert.equal(blocked.status, 403);

    const anonymous = await listen(createApp(null));
    try {
      assert.equal((await fetch(`${anonymous.baseUrl}/api/notices`)).status, 401);
    } finally {
      await anonymous.stop();
    }
  } finally {
    await stop();
  }
});
