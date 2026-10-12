/**
 * AC-347 criterion: `changes`' session source is an ASCENDING keyset page over
 * `(updatedAt, sessionId)`, with the project filter pushed into the SQL `WHERE`,
 * so that ANY truncation — including a page that happens to hold exactly
 * `limit` rows — leaves the unread rows reachable from the returned cursor
 * instead of advancing the watermark past them.
 *
 * The three defects this criterion is built to red (see
 * docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11b D3) are all
 * LOSS, not shape drift, so none of them is legible from a fake reader:
 *
 *  - a `DESC … LIMIT` reader hands back the NEWEST page and drops the older
 *    rows; when the window happens to hold exactly `limit` rows `truncated`
 *    reads false and the watermark jumps to `now()` — the dropped rows are gone
 *    for good;
 *  - the project filter ran in JS AFTER the LIMIT, so one project's sessions
 *    could fill the page and leave the queried project with an empty (but
 *    "complete") reading;
 *  - a truncated page's next watermark was `lastEmittedAt - 1`, which is still
 *    ahead of every unread (older) row.
 *
 * So the fixture here is a REAL `sessions` table (a temp better-sqlite3 file,
 * migrated by the real `initializeDatabase`), the sessions are REAL rows written
 * through `sessionsDb.createSession`, and the reader under test is the REAL
 * `sessionsDb.getSessionsUpdatedSinceKeyset` — the same statement production's
 * `server/index.ts` wires into `changes`. Only the run/approval/Quay sources are
 * empty, because this task deliberately does not touch them.
 *
 * Readings, one leg each:
 *   (a) 60 sessions in the window, `limit` 50: paging the returned cursor
 *       reaches all 60, each exactly once, ascending by `updatedAt` within a
 *       page;
 *   (b) the first page holds exactly `limit` session events and is NOT complete
 *       (the source has more), and the next page carries the remainder;
 *   (c) scoping to project A, whose window holds 60 sessions while project B's
 *       holds 200 NEWER ones, still returns A's 60 — because the filter is in
 *       the SQL, not a post-LIMIT JS pass;
 *   (d) 60 sessions sharing one `updatedAt` page across the boundary by
 *       `sessionId` with nothing skipped and nothing repeated;
 *   (e) a v1 cursor (byte 1, no `sessionKey`) is still accepted, is read from
 *       its watermark, and the cursor it returns is v2.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — every application module below
// therefore comes in dynamically (the order mcp-changes.test.ts established).
process.env.JWT_SECRET = 'mcp-changes-session-paging-test-secret';
delete process.env.VITE_IS_PLATFORM;

import type { McpChangesDeps, McpChangesPayload } from '../mcp-changes.js';

const { buildChanges, decodeChangesCursor, readChangesInput } = await import('../mcp-changes.js');
const { closeConnection, initializeDatabase, projectsDb, sessionsDb } = await import('@/modules/database/index.js');

// --------------------------- fixture ---------------------------

/** Every seeded session's instant is this instant plus a whole number of seconds. */
const BASE_MS = Date.parse('2026-03-01T00:00:00.000Z');
/** The observation instant, well after every seeded row. */
const NOW_MS = Date.parse('2026-03-01T12:00:00.000Z');
/** The one version byte this build issues — a v2 cursor. */
const CURSOR_VERSION_V2 = 2;

const PROJECT_A_DIR = 'ac347-project-a';
const PROJECT_B_DIR = 'ac347-project-b';

type SeededSession = { id: string; dir: string; atMs: number };

/**
 * Runs `run` against a fresh, fully-migrated database in a temp directory, then
 * closes the connection and removes the directory. The sessions written by `run`
 * are read back through the REAL repository, so the reader's SQL — not a
 * hand-rolled filter — is what the criterion exercises.
 */
async function withRealSessionsTable(run: (dirs: Map<string, string>) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-changes-paging-'));
  const dirs = new Map([
    [PROJECT_A_DIR, path.join(tempDirectory, PROJECT_A_DIR)],
    [PROJECT_B_DIR, path.join(tempDirectory, PROJECT_B_DIR)],
  ]);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'paging.db');

  try {
    await initializeDatabase();
    await run(dirs);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Writes one real session row with an explicit `updated_at`. */
function seedSession(session: SeededSession): void {
  const iso = new Date(session.atMs).toISOString();
  sessionsDb.createSession(session.id, 'claude', session.dir, `Session ${session.id}`, iso, iso, null);
}

/** The project id the repository assigned to a seeded project directory. */
function projectIdOf(dir: string): string {
  const row = projectsDb.getProjectPath(dir);
  assert.ok(row, `no project row was created for ${dir}`);
  return row.project_id;
}

/**
 * The `changes` deps bag with its session reader wired to the REAL repository —
 * the same three lines `server/index.ts` uses (id → path through `projectsDb`,
 * `getSessionsUpdatedSinceKeyset` for the page, the row projection on the way
 * out). Runs, approvals and Quay are empty: this criterion is the session
 * source alone.
 */
function changesDeps(): McpChangesDeps {
  return {
    sessions: {
      listChangedSince: (after, projectIds, limit) => {
        const projectPaths =
          projectIds === null
            ? null
            : projectIds
                .map((projectId) => projectsDb.getProjectPathById(projectId))
                .filter((projectPath): projectPath is string => projectPath !== null);
        const { rows, hasMore } = sessionsDb.getSessionsUpdatedSinceKeyset(
          { atIso: new Date(after.atMs).toISOString(), sessionId: after.sessionId },
          projectPaths,
          limit,
        );
        return {
          hasMore,
          rows: rows.map((row) => ({
            sessionId: row.session_id,
            projectId: row.project_path
              ? projectsDb.getProjectPath(row.project_path)?.project_id ?? null
              : null,
            title: row.custom_name ?? row.session_id,
            updatedAtMs: Date.parse(row.updated_at),
          })),
        };
      },
      projectForSession: (sessionId: string) => {
        const row = sessionsDb.getSessionById(sessionId);
        return row?.project_path ? projectsDb.getProjectPath(row.project_path)?.project_id ?? null : null;
      },
    },
    runs: { listRecentRuns: () => [] },
    approvals: { listPending: () => [] },
    // No project here carries a `.quay/config.yml`, so the Quay source is absent
    // from every reading: the index reader is never consulted and the (void) load
    // request never lands a row.
    quay: {
      hasQuayConfig: () => false,
      readTaskIndex: () => ({
        state: 'cold' as const,
        coverage: 'full' as const,
        taskCount: 0,
        observedAtMs: null,
        tasks: new Map(),
      }),
      requestTaskIndexLoad: () => {},
    },
    projects: {
      list: () =>
        projectsDb.getProjectPaths().map((project) => ({
          id: project.project_id,
          title: project.custom_project_name ?? path.basename(project.project_path),
        })),
    },
    now: () => NOW_MS,
    bootId: () => 'boot-paging',
  };
}

/** Follows the returned cursor to the end, guarding against a non-advancing one. */
async function collectPages(
  deps: McpChangesDeps,
  input: { cursor?: string; projects?: string[]; kinds?: ('session' | 'run' | 'interaction' | 'quay_task' | 'quay_gate' | 'commit')[]; limit?: number },
): Promise<McpChangesPayload[]> {
  const pages: McpChangesPayload[] = [];
  let cursor = input.cursor;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await buildChanges(readChangesInput({ ...input, cursor }), undefined, deps);
    pages.push(page);
    if (page.complete) {
      return pages;
    }
    assert.notEqual(page.cursor, cursor, 'an incomplete page must advance its cursor');
    cursor = page.cursor;
  }
  throw new Error('paging did not terminate within 100 pages');
}

const sessionIds = (page: McpChangesPayload): string[] =>
  page.events.filter((event) => event.kind === 'session').map((event) => String(event.ref.sessionId));

/** Distinct ids, in first-seen order, plus how many times each appeared. */
function counts(ids: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const id of ids) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return seen;
}

// --------------------------- (a) ascending keyset paging ---------------------------

test('(a) 60 sessions in the window page to exactly 60, each once, ascending', async () => {
  await withRealSessionsTable(async (dirs) => {
    const expected: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = `sess-a-${String(index).padStart(2, '0')}`;
      expected.push(id);
      seedSession({ id, dir: dirs.get(PROJECT_A_DIR) as string, atMs: BASE_MS + index * 1000 });
    }

    const pages = await collectPages(changesDeps(), { kinds: ['session'], limit: 50 });
    assert.equal(pages.length, 2, '60 sessions at limit 50 must take exactly two pages');

    const ids = pages.flatMap(sessionIds);
    const seen = counts(ids);
    assert.equal(seen.size, 60, 'paging must expose all 60 distinct sessions');
    assert.deepEqual([...seen.keys()].sort(), [...expected].sort(), 'no session may be missing');
    for (const [id, times] of seen) {
      assert.equal(times, 1, `session ${id} must appear exactly once across the pages`);
    }

    // In-page ascending by `updatedAt` — the keyset's own order.
    for (const page of pages) {
      const instants = page.events
        .filter((event) => event.kind === 'session')
        .map((event) => Date.parse(event.at.iso));
      const ascending = [...instants].sort((left, right) => left - right);
      assert.deepEqual(instants, ascending, 'a page must be ascending by updatedAt');
    }

    // The oldest session (the one a DESC LIMIT 50 reader would have dropped
    // first) is present, and it is on the FIRST page.
    assert.ok(sessionIds(pages[0]).includes('sess-a-00'), 'the oldest session must be on the first page');
  });
});

// --------------------------- (b) a full page is not complete ---------------------------

test('(b) a page holding exactly `limit` sessions is incomplete when the source has more', async () => {
  await withRealSessionsTable(async (dirs) => {
    for (let index = 0; index < 60; index += 1) {
      seedSession({
        id: `sess-b-${String(index).padStart(2, '0')}`,
        dir: dirs.get(PROJECT_A_DIR) as string,
        atMs: BASE_MS + index * 1000,
      });
    }

    const deps = changesDeps();
    const first = await buildChanges(readChangesInput({ kinds: ['session'], limit: 50 }), undefined, deps);
    assert.equal(first.events.length, 50, 'the first page holds exactly `limit` session events');
    assert.equal(first.complete, false, 'a page that holds `limit` rows while more exist must NOT be complete');
    assert.deepEqual(first.gaps, [], 'a paging cut is not a gap');
    // The cursor must carry the session keyset position, not just a watermark.
    const decoded = decodeChangesCursor(first.cursor);
    assert.equal(decoded.v, CURSOR_VERSION_V2, 'this build issues v2 cursors');
    assert.ok(decoded.sessionKey, 'a truncated session page must carry a sessionKey position');
    assert.equal(typeof decoded.sessionKey?.sessionId, 'string');

    const second = await buildChanges(readChangesInput({ kinds: ['session'], limit: 50, cursor: first.cursor }), undefined, deps);
    assert.equal(second.events.length, 10, 'the remainder follows on the next page');
    assert.equal(second.complete, true, 'the last page is complete');

    const all = [...sessionIds(first), ...sessionIds(second)];
    assert.equal(new Set(all).size, 60, 'both pages together are the whole 60');
  });
});

// --------------------------- (c) project filter in SQL ---------------------------

test('(c) the project filter is applied in SQL, not after the LIMIT', async () => {
  await withRealSessionsTable(async (dirs) => {
    const aIds: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = `sess-c-a-${String(index).padStart(2, '0')}`;
      aIds.push(id);
      seedSession({ id, dir: dirs.get(PROJECT_A_DIR) as string, atMs: BASE_MS + index * 1000 });
    }
    // Project B is NEWER and far larger: a global DESC/LIMIT reader would return
    // B's rows, filter them out in JS, and answer A with zero events.
    for (let index = 0; index < 200; index += 1) {
      seedSession({
        id: `sess-c-b-${String(index).padStart(3, '0')}`,
        dir: dirs.get(PROJECT_B_DIR) as string,
        atMs: BASE_MS + 10_000 + index * 1000,
      });
    }

    const projectA = projectIdOf(dirs.get(PROJECT_A_DIR) as string);
    const pages = await collectPages(changesDeps(), { kinds: ['session'], projects: [projectA], limit: 50 });
    const ids = pages.flatMap(sessionIds);

    assert.equal(pages[0].events.length, 50, 'the scoped page must be full of A sessions, not emptied by B');
    assert.equal(new Set(ids).size, 60, 'every one of A’s 60 sessions must be returned');
    assert.deepEqual([...new Set(ids)].sort(), [...aIds].sort(), 'exactly A’s sessions, no B session leaked in');
    assert.ok(
      ids.every((id) => id.startsWith('sess-c-a-')),
      'a project-scoped read must not admit another project’s session',
    );
  });
});

// --------------------------- (d) identical updatedAt ---------------------------

test('(d) identical updatedAt values page across the boundary by sessionId', async () => {
  await withRealSessionsTable(async (dirs) => {
    const expected: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = `sess-d-tie-${String(index).padStart(2, '0')}`;
      expected.push(id);
      // One instant for all 60: the tie-break must be `sessionId`, or the page
      // boundary loses or repeats rows.
      seedSession({ id, dir: dirs.get(PROJECT_A_DIR) as string, atMs: BASE_MS });
    }

    const pages = await collectPages(changesDeps(), { kinds: ['session'], limit: 50 });
    const ids = pages.flatMap(sessionIds);
    const seen = counts(ids);
    assert.equal(seen.size, 60, 'all 60 same-instant sessions must be reachable');
    assert.deepEqual([...seen.keys()].sort(), [...expected].sort(), 'the same-instant set is exact');
    for (const [id, times] of seen) {
      assert.equal(times, 1, `session ${id} must not be repeated across the tie boundary`);
    }
    assert.equal(pages.length, 2, 'the tie boundary must still take exactly two pages');
  });
});

// --------------------------- (e) v1 cursor compatibility ---------------------------

test('(e) a v1 cursor is accepted, read from its watermark, and upgraded to v2', async () => {
  await withRealSessionsTable(async (dirs) => {
    const expected: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = `sess-e-${String(index).padStart(2, '0')}`;
      expected.push(id);
      seedSession({ id, dir: dirs.get(PROJECT_A_DIR) as string, atMs: BASE_MS + index * 1000 });
    }

    // A cursor the PREVIOUS build issued: version byte 1, a watermark, a bootId,
    // a per-project Quay head — and no `sessionKey` at all.
    const watermark = BASE_MS - 60_000;
    // A session strictly BEFORE the watermark, so "read from the watermark" is
    // legible as a difference rather than a claim.
    seedSession({ id: 'sess-e-too-old', dir: dirs.get(PROJECT_A_DIR) as string, atMs: BASE_MS - 120_000 });
    const v1Body = { v: 1, watermark, bootId: 'boot-paging', perProjectHead: {} };
    const v1Cursor = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(v1Body), 'utf8')]).toString('base64url');

    const pages = await collectPages(changesDeps(), { kinds: ['session'], limit: 50, cursor: v1Cursor });
    const ids = pages.flatMap(sessionIds);
    assert.equal(new Set(ids).size, 60, 'a v1 cursor must still reach every session after its watermark');
    assert.deepEqual([...new Set(ids)].sort(), [...expected].sort(), 'the v1 read is lossless');

    // It is read from its watermark: the session before it is not re-read.
    assert.ok(!ids.includes('sess-e-too-old'), 'a v1 cursor must not re-read a session at or before its watermark');
    // The cursor handed back is the current (v2) format.
    assert.equal(decodeChangesCursor(pages[0].cursor).v, CURSOR_VERSION_V2, 'the upgraded cursor is v2');

    // Negative control: a v1 cursor whose watermark is AFTER every session reads
    // an empty, complete page — so the 60 above are the watermark's doing.
    const pastBody = { v: 1, watermark: NOW_MS + 60_000, bootId: 'boot-paging', perProjectHead: {} };
    const pastCursor = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(pastBody), 'utf8')]).toString('base64url');
    const past = await buildChanges(readChangesInput({ kinds: ['session'], limit: 50, cursor: pastCursor }), undefined, changesDeps());
    assert.equal(past.events.length, 0, 'the same reader with a future watermark sees nothing');
    assert.equal(past.complete, true);
  });
});
