import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/core/index.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/index.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

/**
 * The shape `PRAGMA table_info` reported after a full migration run on the code
 * that predates `ensureColumns` — captured from that tree, not re-derived here.
 *
 * Each row is `[name, type, notnull, dflt_value, pk]`. The fixture is the
 * oracle for both legs below: the refactor changed how a column is added, never
 * which columns exist or what they are declared as. Rows are compared by column
 * name (see `tableShape`): an upgraded table gets a re-added column appended by
 * `ALTER TABLE`, so the physical order legitimately differs from a freshly
 * created table while the column set, types and defaults must not.
 */
type ColumnShape = readonly [
  name: string,
  type: string,
  notnull: number,
  dflt: string | null,
  pk: number,
];

const EXPECTED_SHAPE: Record<string, ColumnShape[]> = {
  users: [
    ['id', 'INTEGER', 0, null, 1],
    ['username', 'TEXT', 1, null, 0],
    ['password_hash', 'TEXT', 1, null, 0],
    ['created_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
    ['last_login', 'DATETIME', 0, null, 0],
    ['is_active', 'BOOLEAN', 0, '1', 0],
    ['git_name', 'TEXT', 0, null, 0],
    ['git_email', 'TEXT', 0, null, 0],
    ['has_completed_onboarding', 'BOOLEAN', 0, '0', 0],
  ],
  projects: [
    ['project_id', 'TEXT', 1, null, 1],
    ['project_path', 'TEXT', 1, null, 0],
    ['custom_project_name', 'TEXT', 0, 'NULL', 0],
    ['isStarred', 'BOOLEAN', 0, '0', 0],
    ['isArchived', 'BOOLEAN', 0, '0', 0],
    ['session_filter', 'TEXT', 0, 'NULL', 0],
  ],
  sessions: [
    ['session_id', 'TEXT', 1, null, 1],
    ['provider', 'TEXT', 1, "'claude'", 0],
    ['provider_session_id', 'TEXT', 0, null, 0],
    ['custom_name', 'TEXT', 0, null, 0],
    ['name_source', 'TEXT', 0, "'derived'", 0],
    ['transcript_name', 'TEXT', 0, null, 0],
    ['transcript_name_source', 'TEXT', 0, null, 0],
    ['project_path', 'TEXT', 0, null, 0],
    ['jsonl_path', 'TEXT', 0, null, 0],
    ['model', 'TEXT', 0, null, 0],
    ['effort', 'TEXT', 0, null, 0],
    ['model_provider_id', 'TEXT', 0, null, 0],
    ['permission_mode', 'TEXT', 0, null, 0],
    ['lifecycle_mode', 'TEXT', 0, "'per-run'", 0],
    ['forked_from_session_id', 'TEXT', 0, null, 0],
    ['awaiting_reply_at', 'TEXT', 0, null, 0],
    ['awaiting_reply_reason', 'TEXT', 0, null, 0],
    ['isArchived', 'BOOLEAN', 0, '0', 0],
    ['created_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
    ['updated_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
  ],
  superseded_provider_sessions: [
    ['provider_session_id', 'TEXT', 1, null, 1],
    ['provider', 'TEXT', 1, null, 2],
    ['session_id', 'TEXT', 1, null, 0],
    ['jsonl_path', 'TEXT', 0, null, 0],
    ['created_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
  ],
  provider_models: [
    ['id', 'INTEGER', 0, null, 1],
    ['provider', 'TEXT', 1, null, 0],
    ['model_id', 'TEXT', 1, null, 0],
    ['model_name', 'TEXT', 1, null, 0],
    ['sort_order', 'INTEGER', 1, '0', 0],
    ['config_json', 'TEXT', 0, null, 0],
    ['created_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
    ['updated_at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
  ],
  access_tokens: [
    ['id', 'INTEGER', 0, null, 1],
    ['user_id', 'INTEGER', 1, null, 0],
    ['kind', 'TEXT', 1, "'pat'", 0],
    ['token_hash', 'TEXT', 1, null, 0],
    ['token_prefix', 'TEXT', 1, null, 0],
    ['name', 'TEXT', 0, null, 0],
    ['grant_id', 'INTEGER', 0, null, 0],
    ['scopes', 'TEXT', 1, null, 0],
    ['resource', 'TEXT', 1, "''", 0],
    ['expires_at', 'DATETIME', 1, null, 0],
    ['created_at', 'DATETIME', 0, null, 0],
    ['last_used', 'DATETIME', 0, null, 0],
    ['revoked_at', 'DATETIME', 0, null, 0],
  ],
  mcp_audit_log: [
    ['id', 'INTEGER', 0, null, 1],
    ['at', 'DATETIME', 0, 'CURRENT_TIMESTAMP', 0],
    ['token_id', 'INTEGER', 0, null, 0],
    ['client_id', 'TEXT', 0, null, 0],
    ['tool', 'TEXT', 1, null, 0],
    ['args_digest', 'TEXT', 0, null, 0],
    ['outcome', 'TEXT', 1, null, 0],
    ['duration_ms', 'INTEGER', 0, null, 0],
    ['denied_scopes', 'TEXT', 0, null, 0],
    ['error_code', 'TEXT', 0, null, 0],
    ['response_bytes', 'INTEGER', 0, null, 0],
    ['correlation_id', 'TEXT', 0, null, 0],
  ],
};

/**
 * The columns the widened migrations own, removed from tables `INIT_SCHEMA_SQL`
 * creates, to build a database that predates them. Every one is unindexed, so
 * SQLite’s `DROP COLUMN` can take it out of the current schema.
 */
const DROPPED_COLUMNS: Record<string, string[]> = {
  users: ['git_name', 'git_email', 'has_completed_onboarding'],
  projects: ['session_filter'],
  sessions: [
    'name_source',
    'transcript_name',
    'transcript_name_source',
    'jsonl_path',
    'model',
    'effort',
    'model_provider_id',
    'permission_mode',
    'lifecycle_mode',
    'awaiting_reply_at',
    'awaiting_reply_reason',
  ],
  superseded_provider_sessions: ['jsonl_path'],
  provider_models: ['config_json'],
};

/**
 * The two tables `runMigrations` itself creates, at the shapes an install from
 * before these features carries. They are built by hand rather than by dropping
 * from the current schema because `ACCESS_TOKENS_TABLE_SCHEMA_SQL` and
 * `MCP_AUDIT_LOG_TABLE_SCHEMA_SQL` are `CREATE TABLE IF NOT EXISTS`: an existing
 * old table is exactly the case `ensureColumns` exists to widen.
 */
const LEGACY_ACCESS_TOKENS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS access_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    name TEXT,
    scopes TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME,
    last_used DATETIME,
    revoked_at DATETIME
);
`;

const LEGACY_MCP_AUDIT_LOG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at DATETIME DEFAULT CURRENT_TIMESTAMP,
  token_id INTEGER,
  client_id TEXT,
  tool TEXT NOT NULL,
  args_digest TEXT,
  outcome TEXT NOT NULL,
  duration_ms INTEGER
);
`;

/** Columns the hand-built legacy tables must lack before migration. */
const LEGACY_ONLY_COLUMNS: Record<string, string[]> = {
  access_tokens: ['kind', 'resource', 'grant_id'],
  mcp_audit_log: ['denied_scopes', 'error_code', 'response_bytes', 'correlation_id'],
};

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

/** A table's columns by name, so a re-added (appended) column still compares equal. */
const tableShape = (table: string): ColumnShape[] =>
  (
    getConnection()
      .prepare(`PRAGMA table_info(${table})`)
      .all() as TableInfoRow[]
  )
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk] as const)
    .sort(([left], [right]) => left.localeCompare(right));

const sortedExpected = (table: string): ColumnShape[] =>
  [...EXPECTED_SHAPE[table]].sort(([left], [right]) => left.localeCompare(right));

const assertMigratedShape = (label: string): void => {
  for (const table of Object.keys(EXPECTED_SHAPE)) {
    assert.deepEqual(
      tableShape(table),
      sortedExpected(table),
      `${label}: ${table} must carry the pre-ensureColumns column set, types and defaults`
    );
  }
};

const columnNames = (table: string): string[] =>
  (
    getConnection()
      .prepare(`PRAGMA table_info(${table})`)
      .all() as TableInfoRow[]
  ).map((row) => row.name);

/** A node:test console.log mock, read back as whole log lines. */
type ConsoleLogMock = { mock: { calls: Array<{ arguments: unknown[] }> } };

const loggedLines = (logMock: ConsoleLogMock): string[] =>
  logMock.mock.calls.map((call) => call.arguments.map((arg) => String(arg)).join(' '));

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'migrations-ensure-columns-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;

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

test('a fresh database ends with the shape the pre-ensureColumns code produced, and migrates once', async (t) => {
  await withIsolatedDatabase(async () => {
    await initializeDatabase();
    assertMigratedShape('fresh database');

    const logMock = t.mock.method(console, 'log');
    runMigrations(getConnection());

    assertMigratedShape('fresh database, second run');
    assert.deepEqual(
      loggedLines(logMock).filter((line) => line.startsWith('Running migration: Adding ')),
      [],
      'a second run over a fully-shaped database must add no column'
    );
  });
});

test('a database missing migrated columns gains the fresh shape, and repeated migration neither throws nor duplicates', async (t) => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    db.exec(INIT_SCHEMA_SQL);
    db.exec(LEGACY_ACCESS_TOKENS_TABLE_SQL);
    db.exec(LEGACY_MCP_AUDIT_LOG_TABLE_SQL);

    // Build the "old" database first and prove the removal took effect, so the
    // post-migration equality below cannot pass against a table that never lost
    // the column.
    for (const [table, dropped] of Object.entries(DROPPED_COLUMNS)) {
      for (const column of dropped) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
      const remaining = columnNames(table);
      for (const column of dropped) {
        assert.ok(
          !remaining.includes(column),
          `fixture setup: ${table}.${column} must be absent before migrations run`
        );
      }
    }
    for (const [table, columns] of Object.entries(LEGACY_ONLY_COLUMNS)) {
      const names = columnNames(table);
      for (const column of columns) {
        assert.ok(
          !names.includes(column),
          `fixture setup: ${table}.${column} must be absent before migrations run`
        );
      }
    }

    runMigrations(db);
    assertMigratedShape('old database after migration');

    const logMock = t.mock.method(console, 'log');
    runMigrations(db);

    assertMigratedShape('old database after a second migration');
    assert.deepEqual(
      loggedLines(logMock).filter((line) => line.startsWith('Running migration: Adding ')),
      [],
      'the second migration must not repeat an ALTER TABLE'
    );
    const requiredColumns = { ...DROPPED_COLUMNS, ...LEGACY_ONLY_COLUMNS };
    for (const [table, columns] of Object.entries(requiredColumns)) {
      const names = columnNames(table);
      for (const column of columns) {
        assert.equal(
          names.filter((name) => name === column).length,
          1,
          `${table}.${column} must exist exactly once`
        );
      }
    }
  });
});
