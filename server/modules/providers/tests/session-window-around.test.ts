/**
 * Criterion for AC-210: the messages read surface must be readable *around* a
 * message id (`GET /api/providers/sessions/:sessionId/messages?around=<id>&before=B&after=A`),
 * returning the window plus its absolute `startIndex`, the pagination `total`,
 * and both `hasMoreBefore`/`hasMoreAfter` — while leaving every existing
 * `limit`/`offset` reading byte-identical.
 *
 * Everything below runs against a real Claude JSONL transcript fixture of more
 * than 1200 rows and the real provider/cache/service/route — nothing mocks the
 * filesystem or the pagination cache. A large fixture is load-bearing: a window
 * around a front-of-conversation id and a tail offset differ by hundreds of
 * positions, so a false form that reports a tail-relative `startIndex` cannot
 * pass by coincidence, and "the window did not move on append" is only a real
 * claim when there is plenty of conversation after the window.
 *
 * ## False forms this criterion must make red
 *
 * (a) A window whose `startIndex` is a *tail offset* (`total - something`) rather
 *     than an absolute subscript: the stability arm re-reads the same window
 *     after appending to the end and asserts `startIndex` is UNCHANGED; a
 *     tail-relative index moves by the appended count and fails.
 *
 * (b) An unknown id silently falling back to the newest page: the not-found arm
 *     asserts `fetchWindowAround` rejects with `MESSAGE_NOT_FOUND` (and the route
 *     answers 404); any resolved value — newest page included — fails.
 *
 * ## Recorded mutation probes (AC2)
 *
 * Both false forms were applied to the committed green tree, run, and reverted.
 *
 * (a) `sliceAroundIndex` sliced the newest stretch instead of the located index
 *     (`start = total - (before + after + 1)`, `startIndex = start`) and did not
 *     recompute an absolute position. `--test-name-pattern="stable across an
 *     append"` failed on the assertion at line 347
 *     (`assert.equal(readAfter.startIndex, readBefore.startIndex)`) with
 *     `actual: 1309, expected: 1229` — the 80 appended messages moved the
 *     tail-relative index. Restore: `git checkout -- server/shared/utils.ts`.
 *
 * (b) `fetchWindowAround` returned the newest `before + after + 1` messages in
 *     place of throwing. `--test-name-pattern="unknown id is an explicit"` failed
 *     with `AssertionError [ERR_ASSERTION]: Missing expected rejection.` at the
 *     `assert.rejects` call (line 365). Restore:
 *     `git checkout -- server/modules/providers/services/sessions.service.ts`.
 *
 * ## How the untouched-path claim is compared (AC3)
 *
 * The pre-change tail contract is `sliceTailPage`, and this task does not touch
 * its body (`git diff server/shared/utils.ts` leaves it byte-identical; only a
 * new `sliceAroundIndex` is added beside it). The three pages are therefore
 * compared field-by-field with `assert.deepEqual` against
 * `sliceTailPage(full.messages, limit, offset)` on the *same* fixture: offset 0
 * (newest), a mid-conversation offset, and the oldest offset. Any change in the
 * route's default handling, the service's slice arithmetic, or the response
 * envelope makes the deep-equal red.
 *
 * `fetchHistory` later grew one field, `startIndex` — the page's absolute origin
 * in the same oldest-first array — which a tail page needs to place itself in
 * the full history (`gap-edit-replacement-absolute-floor`). It is pinned here
 * from the *same* slice arithmetic (`max(0, total - offset - page.length)`)
 * rather than copied from the response, so a page that reports a tail-relative
 * or otherwise wrong origin still reds this arm; every pre-existing tail field
 * remains byte-identical.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes `IS_PLATFORM` on first import, so the environment is
// set before any aliased module is pulled in. Static imports are hoisted above
// this code, so every application module below comes in dynamically — the order
// `session-turn-outline.test.ts` established.
const TEST_JWT_SECRET = 'session-window-around-test-secret';
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');
const { providerRoutes, sessionsService } = await import('@/modules/providers/index.js');
const { AppError, sliceTailPage } = await import('@/shared/utils.js');

const SESSION_ID = 'window-around-session-1';

/**
 * The fixture is `PAIR_COUNT` user/assistant text pairs, so the raw transcript
 * holds more than 1200 rows. Both prompt and reply are plain text, so each row
 * normalizes to exactly one message and the transcript's ordering is exactly the
 * fixture's ordering.
 */
const PAIR_COUNT = 620;
const TARGET_PAIR = 3;
const TARGET_USER_ID = `u-${TARGET_PAIR}`;
const FIRST_ID = 'u-0';
/**
 * The raw transcript uuid of the last assistant row, used to chain appended rows
 * onto the fixture. It is *not* a normalized message id: an assistant row whose
 * text is one block normalizes to a block-suffixed id (`<uuid>_0`), so the
 * message ids the window locates are always read from the full history, never
 * assumed from the row uuid.
 */
const LAST_ROW_UUID = `a-${PAIR_COUNT - 1}`;

type ClaudeRow = Record<string, unknown>;

function userPromptRow(uuid: string, parentUuid: string | null, timestamp: string, text: string): ClaudeRow {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantTextRow(uuid: string, parentUuid: string, timestamp: string, text: string): ClaudeRow {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** Rows in append order; the uuid chain and timestamps both walk forward. */
function buildRows(pairCount = PAIR_COUNT, startPair = 0, startParent: string | null = null): ClaudeRow[] {
  const rows: ClaudeRow[] = [];
  const base = Date.UTC(2026, 8, 1, 10, 0, 0);
  let parent: string | null = startParent;

  for (let i = 0; i < pairCount; i += 1) {
    const pair = startPair + i;
    const userUuid = `u-${pair}`;
    const assistantUuid = `a-${pair}`;
    const userTime = new Date(base + pair * 2000).toISOString();
    const assistantTime = new Date(base + pair * 2000 + 1000).toISOString();
    rows.push(userPromptRow(userUuid, parent, userTime, `Question number ${pair} of the window fixture`));
    rows.push(assistantTextRow(assistantUuid, userUuid, assistantTime, `Answer number ${pair} of the window fixture`));
    parent = assistantUuid;
  }

  return rows;
}

async function writeTranscript(projectDirectory: string, rows: ClaudeRow[]): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

/** A throwaway database, as the outline criterion isolates its own. */
async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

/** Seeds one session over a fresh transcript and hands back the full read. */
async function seedAndReadFull(projectDirectory: string, pairCount = PAIR_COUNT) {
  const transcriptPath = await writeTranscript(projectDirectory, buildRows(pairCount));
  sessionsDb.createSession(SESSION_ID, 'claude', projectDirectory, 'Window session', undefined, undefined, transcriptPath);
  const full = await sessionsService.fetchHistory(SESSION_ID, { limit: null, offset: 0 });
  return { transcriptPath, full };
}

const idsOf = (messages: Array<{ id: string; transcriptAnchorId?: string }>): string[] =>
  messages.map((message) => message.transcriptAnchorId ?? message.id);

test('a window around a mid id returns the neighborhood, the absolute startIndex and both hasMore flags', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-'));

  try {
    await withIsolatedDatabase(async () => {
      const { full } = await seedAndReadFull(projectDirectory);

      // The fixture is what makes a tail offset wrong by hundreds of positions.
      assert.ok(full.messages.length >= 1200, `fixture must hold ≥1200 normalized messages (got ${full.messages.length})`);
      assert.equal(full.total, full.messages.length);

      const targetIndex = idsOf(full.messages).indexOf(TARGET_USER_ID);
      assert.ok(targetIndex >= 0, 'the target id must exist in the full history');
      assert.ok(targetIndex < 50, 'the target must sit near the front so a tail offset cannot coincide');
      // The neighbour of a user prompt is its reply (a block-suffixed assistant
      // id); the neighbouring prompt walks in fixture order.
      assert.ok(idsOf(full.messages)[targetIndex + 1].startsWith(`a-${TARGET_PAIR}`));
      assert.ok(idsOf(full.messages)[targetIndex - 1].startsWith(`a-${TARGET_PAIR - 1}`));

      const before = 4;
      const after = 6;
      const expectedStart = Math.max(0, targetIndex - before);
      const expectedEnd = Math.min(full.messages.length, targetIndex + after + 1);

      const window = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: TARGET_USER_ID,
        before,
        after,
      });

      assert.equal(window.startIndex, expectedStart);
      assert.equal(window.total, full.total);
      assert.equal(window.hasMoreBefore, expectedStart > 0);
      assert.equal(window.hasMoreAfter, expectedEnd < full.messages.length);
      // Both edges are cut off, so this window really is interior.
      assert.equal(window.hasMoreBefore, true);
      assert.equal(window.hasMoreAfter, true);

      // The window is the same slice of the same array pagination reads.
      assert.deepEqual(idsOf(window.messages), idsOf(full.messages).slice(expectedStart, expectedEnd));
      assert.deepEqual(window.messages, full.messages.slice(expectedStart, expectedEnd));
      // Every returned message is stamped with the app session id, as the
      // paginated route stamps its page.
      assert.ok(window.messages.every((message) => message.sessionId === SESSION_ID));
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('a window can be anchored on a non-user message id and on an exact single message', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-anchor-'));

  try {
    await withIsolatedDatabase(async () => {
      const { full } = await seedAndReadFull(projectDirectory);
      const ids = idsOf(full.messages);
      const assistantId = ids[ids.indexOf(TARGET_USER_ID) + 1];
      const assistantIndex = ids.indexOf(assistantId);
      assert.ok(assistantIndex >= 0);
      assert.ok(assistantId.startsWith(`a-${TARGET_PAIR}`), 'the anchor must be the reply, a non-user message');

      // A client loading forward from a window edge addresses the *last* message
      // of the previous window, which is usually an assistant row — so a
      // non-user id must locate.
      const aroundAssistant = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: assistantId,
        before: 1,
        after: 1,
      });
      assert.equal(aroundAssistant.startIndex, assistantIndex - 1);
      assert.deepEqual(idsOf(aroundAssistant.messages), ids.slice(assistantIndex - 1, assistantIndex + 2));

      // before=0, after=0 is exactly the located message.
      const single = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: assistantId,
        before: 0,
        after: 0,
      });
      assert.equal(single.startIndex, assistantIndex);
      assert.equal(single.messages.length, 1);
      assert.equal(idsOf(single.messages)[0], assistantId);
      assert.equal(single.hasMoreBefore, true);
      assert.equal(single.hasMoreAfter, true);
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('the window edges clamp at the ends of the conversation', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-edges-'));

  try {
    await withIsolatedDatabase(async () => {
      const { full } = await seedAndReadFull(projectDirectory);
      const ids = idsOf(full.messages);
      const lastId = ids[ids.length - 1];

      const atStart = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: FIRST_ID,
        before: 5,
        after: 3,
      });
      assert.equal(atStart.startIndex, 0);
      assert.equal(atStart.hasMoreBefore, false);
      assert.deepEqual(idsOf(atStart.messages), ids.slice(0, 4));

      const atEnd = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: lastId,
        before: 2,
        after: 5,
      });
      assert.equal(atEnd.startIndex, full.total - 3);
      assert.equal(atEnd.hasMoreBefore, true);
      assert.equal(atEnd.hasMoreAfter, false);
      assert.deepEqual(idsOf(atEnd.messages), ids.slice(full.total - 3));
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('an interior window is stable across an append: same startIndex, same messages', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-append-'));

  try {
    await withIsolatedDatabase(async () => {
      const { transcriptPath, full } = await seedAndReadFull(projectDirectory);
      const before = 5;
      const after = 5;

      const readBefore = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: TARGET_USER_ID,
        before,
        after,
      });
      assert.equal(readBefore.total, full.total);

      // Append a whole new stretch at the far end; the window's after-edge is
      // nowhere near it.
      const appended = buildRows(40, PAIR_COUNT, LAST_ROW_UUID);
      await appendFile(
        transcriptPath,
        `${appended.map((row) => JSON.stringify(row)).join('\n')}\n`,
        'utf8',
      );

      const fullAfter = await sessionsService.fetchHistory(SESSION_ID, { limit: null, offset: 0 });
      assert.ok(fullAfter.total > full.total, 'the append must be visible to the same reader');

      const readAfter = await sessionsService.fetchWindowAround(SESSION_ID, {
        aroundId: TARGET_USER_ID,
        before,
        after,
      });

      // A tail-relative startIndex would have moved by the appended count; an
      // absolute subscript does not.
      assert.equal(readAfter.startIndex, readBefore.startIndex);
      assert.deepEqual(readAfter.messages, readBefore.messages);
      assert.equal(readAfter.hasMoreBefore, readBefore.hasMoreBefore);
      assert.equal(readAfter.hasMoreAfter, readBefore.hasMoreAfter);
      assert.equal(readAfter.total, fullAfter.total);
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('an unknown id is an explicit MESSAGE_NOT_FOUND, never a fall back to the newest page', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-missing-'));

  try {
    await withIsolatedDatabase(async () => {
      await seedAndReadFull(projectDirectory);

      await assert.rejects(
        () => sessionsService.fetchWindowAround(SESSION_ID, { aroundId: 'no-such-message', before: 5, after: 5 }),
        (error: unknown) => {
          assert.ok(error instanceof AppError, 'an unknown id must be an AppError, never a resolved page');
          return error.code === 'MESSAGE_NOT_FOUND' && error.statusCode === 404;
        },
      );
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('the existing limit/offset pages are byte-identical to the unchanged sliceTailPage contract', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-tail-'));

  try {
    await withIsolatedDatabase(async () => {
      const { full } = await seedAndReadFull(projectDirectory);
      const limit = 10;
      // Newest, middle, and oldest pages; the oldest offset is past the end so
      // the empty/clamped read is pinned too.
      const offsets = [0, Math.floor(full.total / 2), full.total - 10, full.total + 25];

      for (const offset of offsets) {
        const actual = await sessionsService.fetchHistory(SESSION_ID, { limit, offset });
        const { page, hasMore } = sliceTailPage(full.messages, limit, offset);
        // The absolute origin of this page, derived from the same arithmetic
        // `sliceTailPage` applied (`start = max(0, end - limit)`).
        const startIndex = Math.max(0, full.total - offset - page.length);
        const expected = { ...full, messages: page, hasMore, offset, limit, startIndex };
        assert.deepEqual(actual, expected, `limit=${limit} offset=${offset} diverged from the tail contract`);
      }

      // The default read (no limit) still returns everything, newest-first order
      // preserved — the exact pre-change reading.
      const all = await sessionsService.fetchHistory(SESSION_ID);
      assert.deepEqual(all, { ...full, messages: full.messages, hasMore: false, offset: 0, limit: null });
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

type AuthHarness = {
  baseUrl: string;
  token: string;
};

function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = createHmac('sha256', TEST_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function addUser(id: number, username: string): string {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
  return signToken({ userId: id, username });
}

/**
 * The provider router mounted exactly as `server/index.ts` mounts it — the real
 * token middleware in front, the production error middleware after — so the
 * `around` route's parsing and its not-found mapping are read from the same
 * wiring that ships.
 */
async function withAuthServer(run: (harness: AuthHarness) => Promise<void>, seed: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-auth-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  const token = addUser(1, 'window-tester');
  await seed();

  const app = express();
  app.use(express.json());
  app.use('/api/providers', authenticateToken, providerRoutes);
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

test('the around route returns the window envelope and maps an unknown id to 404', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-window-around-route-'));

  try {
    const transcriptPath = await writeTranscript(projectDirectory, buildRows(PAIR_COUNT));

    await withAuthServer(
      async ({ baseUrl, token }) => {
        // Read inside the seeded database so `full` is the same full history the
        // route serves.
        const full = await sessionsService.fetchHistory(SESSION_ID, { limit: null, offset: 0 });
        const targetIndex = idsOf(full.messages).indexOf(TARGET_USER_ID);
        assert.ok(targetIndex >= 0);
        assert.ok(full.total >= 1200);

        const response = await fetch(
          `${baseUrl}/api/providers/sessions/${SESSION_ID}/messages?around=${TARGET_USER_ID}&before=4&after=6`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const payload = await response.json() as {
          success: boolean;
          data: {
            messages: Array<{ id: string; transcriptAnchorId?: string }>;
            startIndex: number;
            total: number;
            hasMoreBefore: boolean;
            hasMoreAfter: boolean;
          };
        };
        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.startIndex, targetIndex - 4);
        assert.equal(payload.data.total, full.total);
        assert.equal(payload.data.hasMoreBefore, true);
        assert.equal(payload.data.hasMoreAfter, true);
        assert.deepEqual(
          idsOf(payload.data.messages),
          idsOf(full.messages).slice(targetIndex - 4, targetIndex + 7),
        );

        // An unknown id is an explicit refusal over HTTP too — never a 200 with
        // the newest page.
        const missing = await fetch(
          `${baseUrl}/api/providers/sessions/${SESSION_ID}/messages?around=no-such-message&before=4&after=6`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const missingPayload = await missing.json() as { success: boolean; error: { code: string } };
        assert.equal(missing.status, 404);
        assert.equal(missingPayload.success, false);
        assert.equal(missingPayload.error.code, 'MESSAGE_NOT_FOUND');

        // The unchanged tail page still answers on the same route.
        const tail = await fetch(
          `${baseUrl}/api/providers/sessions/${SESSION_ID}/messages?limit=10&offset=0`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const tailPayload = await tail.json() as {
          data: { messages: Array<{ id: string }>; hasMore: boolean; offset: number; limit: number; total: number };
        };
        assert.equal(tail.status, 200);
        assert.equal(tailPayload.data.limit, 10);
        assert.equal(tailPayload.data.offset, 0);
        assert.equal(tailPayload.data.total, full.total);
        assert.deepEqual(idsOf(tailPayload.data.messages), idsOf(full.messages).slice(-10));
      },
      async () => {
        sessionsDb.createSession(SESSION_ID, 'claude', projectDirectory, 'Window route session', undefined, undefined, transcriptPath);
      },
    );
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
