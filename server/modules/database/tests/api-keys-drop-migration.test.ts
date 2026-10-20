import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/core/index.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/index.js';

/**
 * The DDL the retired plaintext API-key feature created, verbatim.
 *
 * Reproducing it rather than a stand-in is the point: an install that ran that
 * release has exactly this table (and its `idx_api_keys_*` indexes) on disk,
 * and the upgrade has to clean them out and report how many rows it discarded.
 */
const LEGACY_API_KEYS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/** The three indexes the same release declared on top of that table. */
const LEGACY_API_KEYS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key)',
  'CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)',
];

const LEGACY_API_KEYS_INDEX_NAMES = [
  'idx_api_keys_key',
  'idx_api_keys_user_id',
  'idx_api_keys_active',
];

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'api-keys-drop-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
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

const tableNames = (): string[] =>
  (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((row) => row.name);

const indexNames = (): string[] =>
  (
    getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[]
  ).map((row) => row.name);

/** Row count per application table, so "the upgrade lost no row" is checkable. */
const rowCounts = (): Record<string, number> =>
  Object.fromEntries(
    tableNames()
      .filter((name) => !name.startsWith('sqlite_'))
      .map((name) => [
        name,
        (
          getConnection().prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {
            count: number;
          }
        ).count,
      ])
  );

const userRows = (): unknown[] =>
  getConnection().prepare('SELECT * FROM users ORDER BY id').all();

/** A node:test console.log mock, read back as whole log lines. */
type ConsoleLogMock = { mock: { calls: Array<{ arguments: unknown[] }> } };

const loggedLines = (logMock: ConsoleLogMock): string[] =>
  logMock.mock.calls.map((call) => call.arguments.map((arg) => String(arg)).join(' '));

test('a freshly created database carries no api_keys structure and never reports a drop', async (t) => {
  await withIsolatedDatabase(async () => {
    const logMock = t.mock.method(console, 'log');
    closeConnection();
    await initializeDatabase();

    assert.ok(
      !tableNames().includes('api_keys'),
      'a fresh database must not create the legacy api_keys table'
    );
    assert.deepEqual(
      indexNames().filter((name) => LEGACY_API_KEYS_INDEX_NAMES.includes(name)),
      [],
      'a fresh database must not create any idx_api_keys_* index'
    );
    assert.deepEqual(
      loggedLines(logMock).filter((line) => line.includes('api_keys')),
      [],
      'a database that never had api_keys must log no drop'
    );
  });
});

test('opening a database that still has the legacy api_keys table drops it, reports the row count, and keeps every row', async (t) => {
  await withIsolatedDatabase(async () => {
    const logMock = t.mock.method(console, 'log');

    // The user the two keys belong to — the row the upgrade must not touch.
    getConnection()
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('legacy-user', 'hash');

    // The shape the previous release left behind: its table, its indexes, and
    // two keys actually issued to the user.
    const legacy = getConnection();
    legacy.exec(LEGACY_API_KEYS_TABLE_SQL);
    for (const statement of LEGACY_API_KEYS_INDEX_SQL) {
      legacy.exec(statement);
    }
    const insertKey = legacy.prepare(
      'INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)'
    );
    insertKey.run(1, 'first-key', 'ck_first');
    insertKey.run(1, 'second-key', 'ck_second');

    const usersBefore = userRows();
    const countsBefore = rowCounts();

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    // (a) the legacy table and its three indexes are gone.
    assert.ok(!tableNames().includes('api_keys'), 'the upgrade must drop the api_keys table');
    assert.deepEqual(
      indexNames().filter((name) => LEGACY_API_KEYS_INDEX_NAMES.includes(name)),
      [],
      'the upgrade must drop every idx_api_keys_* index'
    );

    // (b) the hashed replacement store is in place.
    assert.ok(
      tableNames().includes('access_tokens'),
      'the upgrade must leave the access_tokens table in place'
    );

    // (c) the user row survives verbatim and no other table's count moves.
    assert.deepEqual(userRows(), usersBefore, 'the users row must survive the upgrade verbatim');
    const { api_keys: legacyRowCount, ...survivingCounts } = countsBefore;
    assert.equal(legacyRowCount, 2, 'the legacy table really held two rows before the upgrade');
    assert.deepEqual(
      rowCounts(),
      survivingCounts,
      'no other table may gain or lose a row across the upgrade'
    );

    // (d) the discarded row count is reported in the migration log.
    assert.ok(
      loggedLines(logMock).some((line) =>
        line.includes('Dropping the legacy api_keys table (2 rows removed)')
      ),
      'the migration must log the number of dropped rows'
    );

    // (e) reopening the upgraded database is a no-op: it does not throw and it
    // reports no further drop.
    const callsBeforeSecondOpen = logMock.mock.calls.length;
    closeConnection();
    await initializeDatabase();

    const secondOpenLines = loggedLines(logMock).slice(callsBeforeSecondOpen);
    assert.deepEqual(
      secondOpenLines.filter((line) => line.includes('api_keys')),
      [],
      'a second open must not report dropping api_keys again'
    );
    assert.ok(!tableNames().includes('api_keys'), 'a second open must leave the table absent');
  });
});

/**
 * The `last_used` backfill (gap-mcp-token-last-used-never-stamped-for-oauth).
 *
 * This criterion lives here, not in a new file, because the repository pins its
 * test-file count; this is the migration-focused file in the database module's
 * test directory, and the table it backfills (`access_tokens`) is the one the
 * api_keys drop handed over to. The migration reads three tables the seeded rows
 * below populate by hand, then is run twice: the first run fills every NULL
 * column it can, and the second must change nothing.
 */
test('the last_used backfill fills only NULL rows from the audit log and is idempotent', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();

    const userId = Number(
      db
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run('backfill-owner', 'hash').lastInsertRowid
    );

    const insertClient = (clientId: string): void => {
      db.prepare(
        'INSERT INTO oauth_clients (client_id, redirect_uris, metadata, created_via) VALUES (?, ?, ?, ?)'
      ).run(clientId, '["https://app.example/cb"]', '{}', 'manual');
    };
    const insertGrant = (clientId: string, lastUsed: string | null): number =>
      Number(
        db
          .prepare(
            `INSERT INTO oauth_grants (user_id, client_id, scopes, resource, created_at, last_used)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(userId, clientId, '["cloudcli:read"]', 'https://cli.example/mcp', '2026-01-01T00:00:00.000Z', lastUsed)
          .lastInsertRowid
      );
    const insertToken = (hash: string, grantId: number | null, lastUsed: string | null): number =>
      Number(
        db
          .prepare(
            `INSERT INTO access_tokens
               (user_id, kind, token_hash, token_prefix, name, grant_id, scopes, resource,
                expires_at, created_at, last_used)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            userId,
            grantId === null ? 'pat' : 'oauth_access',
            hash,
            hash.slice(0, 8),
            null,
            grantId,
            '["cloudcli:read"]',
            grantId === null ? '' : 'https://cli.example/mcp',
            '2027-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            lastUsed
          ).lastInsertRowid
      );
    const insertAudit = (tokenId: number, at: string): void => {
      db.prepare(
        `INSERT INTO mcp_audit_log (at, token_id, client_id, tool, args_digest, outcome, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(at, tokenId, null, 'tools/list', '{}', 'ok', 1);
    };
    const tokenLastUsed = (id: number): string | null =>
      (db.prepare('SELECT last_used FROM access_tokens WHERE id = ?').get(id) as {
        last_used: string | null;
      }).last_used;
    const grantLastUsed = (id: number): string | null =>
      (db.prepare('SELECT last_used FROM oauth_grants WHERE id = ?').get(id) as {
        last_used: string | null;
      }).last_used;

    // grantA: one token that was used but never stamped, one never used at all.
    insertClient('client-a');
    const grantA = insertGrant('client-a', null);
    const usedToken = insertToken('a'.repeat(64), grantA, null);
    const unusedToken = insertToken('b'.repeat(64), grantA, null);
    // Deliberately out of insertion order: the reading is the newest instant, not
    // the last row written. `at` is in production's SQLite CURRENT_TIMESTAMP form.
    insertAudit(usedToken, '2026-01-01 00:00:05');
    insertAudit(usedToken, '2026-01-03 00:00:07');
    insertAudit(usedToken, '2026-01-02 00:00:06');

    // grantB: its only token has no audit rows, so there is nothing to read.
    insertClient('client-b');
    const grantB = insertGrant('client-b', null);
    const neverSeenToken = insertToken('c'.repeat(64), grantB, null);

    // grantC: already stamped, with an already-stamped token — neither may move,
    // even though the token has audit rows that predate its stamp.
    insertClient('client-c');
    const standingGrantStamp = '2026-04-01T00:00:00.000Z';
    const grantC = insertGrant('client-c', standingGrantStamp);
    const standingTokenStamp = '2026-03-01T00:00:00.000Z';
    const alreadyStampedToken = insertToken('d'.repeat(64), grantC, standingTokenStamp);
    insertAudit(alreadyStampedToken, '2026-01-05 00:00:00');

    // A personal access token — no grant to cascade to — in use before the stamp.
    const patToken = insertToken('e'.repeat(64), null, null);
    insertAudit(patToken, '2026-02-01 12:00:00');

    // Nothing is filled before the migration runs.
    assert.equal(tokenLastUsed(usedToken), null);
    assert.equal(grantLastUsed(grantA), null);

    runMigrations(db);

    // The newest audit instant wins, normalized to the ISO-8601 UTC form every
    // other `last_used` writer produces.
    assert.equal(tokenLastUsed(usedToken), '2026-01-03T00:00:07.000Z');
    assert.equal(tokenLastUsed(patToken), '2026-02-01T12:00:00.000Z');
    // A token with no audit rows stays unknown rather than being guessed at.
    assert.equal(tokenLastUsed(unusedToken), null);
    assert.equal(tokenLastUsed(neverSeenToken), null);
    // A token that already carried a stamp keeps it.
    assert.equal(tokenLastUsed(alreadyStampedToken), standingTokenStamp);
    // A grant reads the newest instant among its own tokens.
    assert.equal(grantLastUsed(grantA), '2026-01-03T00:00:07.000Z');
    // No usable token means the grant stays unknown.
    assert.equal(grantLastUsed(grantB), null);
    // A stamped grant keeps its stamp.
    assert.equal(grantLastUsed(grantC), standingGrantStamp);

    // The second run is a no-op: an already-filled column is not recomputed and a
    // NULL with no source stays NULL.
    const afterFirstRun = {
      usedToken: tokenLastUsed(usedToken),
      patToken: tokenLastUsed(patToken),
      unusedToken: tokenLastUsed(unusedToken),
      neverSeenToken: tokenLastUsed(neverSeenToken),
      alreadyStampedToken: tokenLastUsed(alreadyStampedToken),
      grantA: grantLastUsed(grantA),
      grantB: grantLastUsed(grantB),
      grantC: grantLastUsed(grantC),
    };
    runMigrations(db);
    assert.deepEqual(
      {
        usedToken: tokenLastUsed(usedToken),
        patToken: tokenLastUsed(patToken),
        unusedToken: tokenLastUsed(unusedToken),
        neverSeenToken: tokenLastUsed(neverSeenToken),
        alreadyStampedToken: tokenLastUsed(alreadyStampedToken),
        grantA: grantLastUsed(grantA),
        grantB: grantLastUsed(grantB),
        grantC: grantLastUsed(grantC),
      },
      afterFirstRun
    );
  });
});
