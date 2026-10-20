import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/core/index.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

/**
 * The DDL the removed launch-profile feature created, verbatim.
 *
 * Reproducing it rather than a stand-in is the point: an install that ran that
 * release has exactly this table (and `sessions.launch_profile_id`) on disk,
 * and the upgrade has to clean both out.
 */
const LEGACY_LAUNCH_PROFILES_TABLE_SQL = `
CREATE TABLE launch_profiles (
    id TEXT NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    deployment TEXT NOT NULL DEFAULT 'gateway',
    is_default BOOLEAN NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE (provider, name)
);
`;

/** Every column the sessions table is expected to carry, in a fixed order. */
const SESSION_COLUMNS_SQL = `
  session_id,
  provider,
  provider_session_id,
  custom_name,
  project_path,
  jsonl_path,
  model,
  effort,
  forked_from_session_id,
  isArchived,
  created_at,
  updated_at
`;

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'launch-profiles-drop-'));
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

const sessionColumnNames = (): string[] =>
  (
    getConnection().prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
  ).map((row) => row.name);

/** Row count per application table, so "the rebuild did not lose a row" is checkable. */
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

const sessionRows = (): unknown[] =>
  getConnection()
    .prepare(`SELECT ${SESSION_COLUMNS_SQL} FROM sessions ORDER BY session_id`)
    .all();

test('a freshly created database carries no launch-profile structure', async () => {
  await withIsolatedDatabase(() => {
    assert.ok(
      !tableNames().includes('launch_profiles'),
      'a fresh database must not create the launch_profiles table'
    );
    assert.ok(
      !sessionColumnNames().includes('launch_profile_id'),
      'a fresh sessions table must not carry the launch_profile_id column'
    );
  });
});

test('opening a database that still has the profile structures drops both and keeps every row', async () => {
  await withIsolatedDatabase(async () => {
    const lockedSessionId = sessionsDb.createSession(
      'session-locked',
      'claude',
      '/workspace/demo-project',
      'Locked Session',
      '2026-07-18T09:00:00.000Z',
      '2026-07-18T10:00:00.000Z',
      '/transcripts/session-locked.jsonl'
    );
    sessionsDb.createAppSession('session-plain', 'codex', '/workspace/demo-project', 'Plain Session');
    sessionsDb.updateSessionIsArchived('session-plain', true);

    // Settle everything the *other* startup migrations do (the
    // provider_session_id backfill among them) before taking the baseline, so
    // the rows compared below move only if this migration moves them.
    closeConnection();
    await initializeDatabase();

    // The shape the previous release left behind: its column, its table, and a
    // session actually locked to a profile.
    const legacy = getConnection();
    legacy.exec('ALTER TABLE sessions ADD COLUMN launch_profile_id TEXT');
    legacy.exec(LEGACY_LAUNCH_PROFILES_TABLE_SQL);
    legacy
      .prepare('INSERT INTO launch_profiles (id, provider, name) VALUES (?, ?, ?)')
      .run('profile-gateway', 'claude', 'Gateway');
    legacy
      .prepare('UPDATE sessions SET launch_profile_id = ? WHERE session_id = ?')
      .run('profile-gateway', lockedSessionId);

    const countsBefore = rowCounts();
    const rowsBefore = sessionRows();

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    assert.ok(
      !tableNames().includes('launch_profiles'),
      'the upgrade must drop the launch_profiles table'
    );
    assert.ok(
      !sessionColumnNames().includes('launch_profile_id'),
      'the upgrade must drop the launch_profile_id column'
    );
    assert.deepEqual(
      getConnection().prepare('PRAGMA foreign_key_check').all(),
      [],
      'the sessions rebuild must leave every foreign key resolvable'
    );
    assert.deepEqual(sessionRows(), rowsBefore, 'the rebuild must copy every session row verbatim');

    const { launch_profiles: legacyTableRows, ...survivingCounts } = countsBefore;
    assert.equal(legacyTableRows, 1, 'the legacy table really held a row before the upgrade');
    assert.deepEqual(
      rowCounts(),
      survivingCounts,
      'no other table may gain or lose a row across the upgrade'
    );

    // Reopening the upgraded database is a no-op, not a second rewrite.
    closeConnection();
    await initializeDatabase();

    assert.deepEqual(rowCounts(), survivingCounts, 'a second open must change nothing');
    assert.deepEqual(sessionRows(), rowsBefore, 'a second open must leave the rows alone');
    assert.ok(!tableNames().includes('launch_profiles'));
    assert.ok(!sessionColumnNames().includes('launch_profile_id'));
  });
});
