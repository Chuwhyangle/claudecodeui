import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { Database } from 'better-sqlite3';

import { isSelfAssignedSessionName, stripSelfAssignedSuffix } from '@/modules/database/repositories/sessions.db.js';
import {
  ACCESS_TOKENS_TABLE_SCHEMA_SQL,
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  MCP_AUDIT_LOG_TABLE_SCHEMA_SQL,
  NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL,
  OAUTH_AUTHORIZATION_CODES_TABLE_SCHEMA_SQL,
  OAUTH_CLIENTS_TABLE_SCHEMA_SQL,
  OAUTH_CODE_REDEMPTIONS_TABLE_SCHEMA_SQL,
  OAUTH_GRANTS_TABLE_SCHEMA_SQL,
  OBSERVED_OBJECTS_TABLE_SCHEMA_SQL,
  OBSERVED_REVISIONS_TABLE_SCHEMA_SQL,
  OBSERVATION_PRODUCER_HEARTBEATS_TABLE_SCHEMA_SQL,
  OBSERVATION_SEEN_CURSORS_TABLE_SCHEMA_SQL,
  OBSERVATION_WATCH_ENTRIES_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PROVIDER_MODELS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSION_DRAFTS_TABLE_SCHEMA_SQL,
  SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL,
  SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_PREFERENCES_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
  UI_LAST_OPENED_TABLE_SCHEMA_SQL,
  VOICE_USER_IDENTIFIERS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

/**
 * Widens a pre-stage-5 `access_tokens` table with its OAuth columns
 * (mcp-gateway-SPEC stage 5, AC-258).
 *
 * A database created at stage 0 has `access_tokens` without `kind`, `resource`
 * or `grant_id`; the updated `ACCESS_TOKENS_TABLE_SCHEMA_SQL` only shapes a
 * fresh table (`IF NOT EXISTS` leaves an existing one alone), so an existing
 * install needs the columns added. Each addition is guarded by the live
 * `PRAGMA table_info`, which is what makes a second `runMigrations` a no-op
 * rather than a duplicate-column error. `kind`/`resource` carry the same
 * non-null defaults as the fresh schema so existing PAT rows and the untouched
 * PAT insert path keep their meaning; `grant_id` is nullable and so is
 * addable with a foreign key (SQLite refuses a non-NULL default here).
 */
const addAccessTokenOAuthColumns = (db: Database): void => {
  const columnNames = getTableInfo(db, 'access_tokens').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'access_tokens', columnNames, 'kind', "TEXT NOT NULL DEFAULT 'pat'");
  addColumnToTableIfNotExists(db, 'access_tokens', columnNames, 'resource', "TEXT NOT NULL DEFAULT ''");
  addColumnToTableIfNotExists(
    db,
    'access_tokens',
    columnNames,
    'grant_id',
    'INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE'
  );
};

/**
 * Widens a pre-AC-286 `mcp_audit_log` with its `denied_scopes` column.
 *
 * A database created before AC-286 has `mcp_audit_log` without `denied_scopes`;
 * the updated `MCP_AUDIT_LOG_TABLE_SCHEMA_SQL` only shapes a fresh table
 * (`IF NOT EXISTS` leaves an existing one alone), so an existing install needs
 * the column added. The guard reads the live `PRAGMA table_info`, which is what
 * makes a second `runMigrations` a no-op rather than a duplicate-column error.
 * The column is nullable with no default: a pre-AC-286 row simply has no scope
 * reading, which is the honest state for a row written before the column existed.
 */
const addMcpAuditLogDeniedScopesColumn = (db: Database): void => {
  const columnNames = getTableInfo(db, 'mcp_audit_log').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'mcp_audit_log', columnNames, 'denied_scopes', 'TEXT');
};

/**
 * Widens a `mcp_audit_log` that predates the usage-stats telemetry with its
 * `error_code` / `response_bytes` / `correlation_id` columns
 * (gap-mcp-usage-stats).
 *
 * The same widening the `denied_scopes` migration above performs, for the same
 * reason: `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so an
 * install created before this task keeps the old column set until a migration
 * adds the tail. Each column is added only when `PRAGMA table_info` does not
 * already list it, so a second `runMigrations` over a fresh table (which the
 * updated schema already shaped) is a no-op. All three are nullable with no
 * default — a row written before this column existed simply has no telemetry
 * reading, which is its honest state.
 */
const addMcpAuditLogTelemetryColumns = (db: Database): void => {
  const columnNames = getTableInfo(db, 'mcp_audit_log').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'mcp_audit_log', columnNames, 'error_code', 'TEXT');
  addColumnToTableIfNotExists(db, 'mcp_audit_log', columnNames, 'response_bytes', 'INTEGER');
  addColumnToTableIfNotExists(db, 'mcp_audit_log', columnNames, 'correlation_id', 'TEXT');
};

/**
 * Backfills `last_used` from the MCP audit log for rows that were never stamped
 * (gap-mcp-token-last-used-never-stamped-for-oauth).
 *
 * Before the throttled stamp existed, only the personal-access-token
 * `verifyToken` path wrote `access_tokens.last_used`; OAuth access tokens and
 * every `oauth_grants` row stayed NULL even while the token was in constant use.
 * The audit log already recorded one row per tool call against the calling
 * `token_id`, so the newest such instant is the honest "last used" for that
 * token. A grant has no audit rows of its own, so its reading is the newest
 * instant among the tokens issued under it.
 *
 * Both statements are idempotent and non-destructive: each writes only where
 * `last_used IS NULL` and only where a source row actually exists, so a row that
 * already carries a stamp — or that has genuinely never been used — keeps its
 * value, and a second run changes nothing. The token pass runs first because the
 * grant pass reads `access_tokens.last_used`.
 *
 * The `mcp_audit_log.at` column is written in SQLite's `CURRENT_TIMESTAMP` format
 * (`YYYY-MM-DD HH:MM:SS`, UTC) by production and in ISO-8601 by tests, so the max
 * is taken with `ORDER BY datetime(at)` rather than a lexicographic `MAX`, and
 * the stored result is normalized to the ISO-8601 UTC form every other
 * `last_used` writer produces — a mixed format would be read back by the
 * throttle's `new Date(...)` as local time.
 */
const backfillLastUsedFromAuditLog = (db: Database): number => {
  const tokens = db
    .prepare(
      `UPDATE access_tokens
          SET last_used = (
                SELECT strftime('%Y-%m-%dT%H:%M:%fZ', mcp_audit_log.at)
                  FROM mcp_audit_log
                 WHERE mcp_audit_log.token_id = access_tokens.id
                 ORDER BY datetime(mcp_audit_log.at) DESC
                 LIMIT 1
              )
        WHERE last_used IS NULL
          AND EXISTS (SELECT 1 FROM mcp_audit_log WHERE mcp_audit_log.token_id = access_tokens.id)`
    )
    .run().changes;

  const grants = db
    .prepare(
      `UPDATE oauth_grants
          SET last_used = (
                SELECT access_tokens.last_used
                  FROM access_tokens
                 WHERE access_tokens.grant_id = oauth_grants.id
                   AND access_tokens.last_used IS NOT NULL
                 ORDER BY datetime(access_tokens.last_used) DESC
                 LIMIT 1
              )
        WHERE last_used IS NULL
          AND EXISTS (
                SELECT 1 FROM access_tokens
                 WHERE access_tokens.grant_id = oauth_grants.id
                   AND access_tokens.last_used IS NOT NULL
              )`
    )
    .run().changes;

  return tokens + grants;
};

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
  `);
};

/**
 * Adds the `forked_from_session_id` column recording where a branched session
 * came from.
 *
 * Nothing is backfilled: a session that predates forking was not forked.
 */
/**
 * Adds the transcript path to the superseded-session record.
 *
 * Only rows written before this column existed lack it, and there is nothing
 * to backfill from — the session stopped pointing at that file when the row
 * was created — so they keep a NULL and the delete path skips them.
 */
const addSupersededTranscriptPathColumn = (db: Database): void => {
  const columnNames = getTableInfo(db, 'superseded_provider_sessions').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'superseded_provider_sessions', columnNames, 'jsonl_path', 'TEXT');
};

/** Adds `session_filter`, the per-project JSON `{"hide": string[]}` of hidden session-name regexes (NULL = none). */
const addProjectSessionFilterColumn = (db: Database): void => {
  const columnNames = getTableInfo(db, 'projects').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'session_filter', 'TEXT DEFAULT NULL');
};

const addForkedFromSessionIdColumn = (db: Database): void => {
  const columnNames = getTableInfo(db, 'sessions').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'forked_from_session_id', 'TEXT');
};

/**
 * Adds `name_source` — where each session's name came from — and backfills it
 * exactly once, on the upgrade that adds the column.
 *
 * The backfill is deliberately conservative. Until this column existed nothing
 * recorded who chose a name, so every row that already carries one is marked
 * `manual`: a name the user typed and a name an indexer inferred are
 * indistinguishable in an old database, and guessing `derived` for a name
 * someone chose would hand it straight back to the next provider scan. Rows
 * with no name keep the column default, `derived`.
 *
 * Re-running must change nothing: by then an `ai` name may legitimately sit on
 * a row (an indexer upgraded it), and re-marking that `manual` would freeze a
 * title the transcript still owns. Hence the `includes` guard — the UPDATE is
 * tied to the ALTER, not repeated on every startup.
 */
const addSessionNameSourceColumn = (db: Database): void => {
  const columnNames = getTableInfo(db, 'sessions').map((column) => column.name);
  if (columnNames.includes('name_source')) {
    return;
  }

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'name_source', "TEXT DEFAULT 'derived'");
  db.exec(`UPDATE sessions SET name_source = 'manual' WHERE custom_name IS NOT NULL`);
};

/**
 * Adds `transcript_name` / `transcript_name_source` — the name a session's
 * transcript gives it, held apart from the name the user chose — and splits the
 * rows an earlier version stored in `custom_name` alone.
 *
 * Before this, one column held whichever name won the precedence order, so a
 * session that Claude had titled and the user had not touched carried that
 * title in `custom_name`. From now on `custom_name` is the user's own word and
 * `transcript_name` is the reading, so those rows have to move: every
 * non-`manual` row hands its name and its provenance to `transcript_name` and
 * leaves `custom_name` empty. A `manual` row keeps its name exactly where it
 * is — that is the user's override, and it is the one thing the new writer must
 * never touch.
 *
 * The move is deliberately NOT re-run. It is tied to the ALTER, so the guard on
 * `transcript_name` both makes a second startup a no-op and protects whatever
 * the synchronizer has since written: a row whose transcript name is now
 * `agent` (or `ai`) would otherwise be dragged back to the name it held on the
 * upgrade, and `custom_name` would be re-emptied under a rename the user made
 * in between.
 *
 * Deliberately last of the sessions-shape migrations, after every one that
 * rebuilds the table: those copy an explicit column list, so a column added
 * before one of them would be dropped with the old table and this backfill
 * would be written into a table that no longer exists.
 */
const splitSessionTranscriptNameColumns = (db: Database): void => {
  const columnNames = getTableInfo(db, 'sessions').map((column) => column.name);
  if (columnNames.includes('transcript_name')) {
    return;
  }

  console.log('Running migration: Splitting session names into override and transcript reading');
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'transcript_name', 'TEXT');
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'transcript_name_source', 'TEXT');

  db.exec(`
    UPDATE sessions
       SET transcript_name = custom_name,
           transcript_name_source = COALESCE(name_source, 'derived'),
           custom_name = NULL,
           name_source = NULL
     WHERE custom_name IS NOT NULL
       AND (name_source IS NULL OR name_source <> 'manual')
  `);
};

/**
 * Bytes of a transcript's tail the reclassification reads when it asks whether
 * the session still holds an `ai-title`.
 */
const RECLASSIFY_AI_TITLE_TAIL_BYTES = 512 * 1024;

/**
 * Whether the transcript at `jsonlPath` still holds an `ai-title` entry.
 *
 * Only the tail is read, and only for a substring. The question the migration
 * asks is which side of the title ladder a polluted row belonged on, and the CLI
 * rewrites its title entries at the end of the file — so a title that survived
 * is a title in the tail window. A transcript that cannot be read answers
 * `false`: the caller then falls back to `derived`, which is the rung a name
 * with nothing behind it deserves.
 */
const transcriptHoldsAiTitle = (jsonlPath: string | null): boolean => {
  if (!jsonlPath) {
    return false;
  }
  let handle: number;
  try {
    handle = openSync(jsonlPath, 'r');
  } catch {
    return false;
  }
  try {
    const size = fstatSync(handle).size;
    const length = Math.min(size, RECLASSIFY_AI_TITLE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, size - length);
    return buffer.toString('utf8').includes('"type":"ai-title"');
  } catch {
    return false;
  } finally {
    closeSync(handle);
  }
};

/**
 * Re-files the rows an older build named after this app's own resident address.
 *
 * Until `self-assigned` existed, the address the host driver handed the CLI as
 * `--name` was read back out of the transcript on the `agent` rung — the top of
 * the ladder, above any `ai-title` the session had earned — and stored as the
 * session's name. This migration files those rows back where they belong: a row
 * whose transcript still holds an `ai-title` goes to `ai`, one whose transcript
 * holds none goes to `derived`. The accumulated `-<id6>` repeats an older build
 * folded into the name are peeled off as it moves, so the next launch derives
 * its address from the name underneath rather than from its own last output.
 *
 * Idempotent by its predicate rather than by a version marker: it selects only
 * rows still sitting on `agent` with a self-assigned name, and the update takes
 * every one of them off that combination, so a second run selects nothing. That
 * is also what makes it safe to run on every startup — a row an old build wrote
 * after this shipped is repaired by the next startup rather than left behind.
 */
const reclassifySelfAssignedSessionNames = (db: Database): void => {
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId,
              transcript_name AS transcriptName,
              custom_name AS customName,
              name_source AS nameSource,
              transcript_name_source AS transcriptNameSource,
              jsonl_path AS jsonlPath
         FROM sessions
        WHERE name_source = 'agent' OR transcript_name_source = 'agent'`
    )
    .all() as Array<{
    sessionId: string;
    transcriptName: string | null;
    customName: string | null;
    nameSource: string | null;
    transcriptNameSource: string | null;
    jsonlPath: string | null;
  }>;

  const readings: Array<{ sessionId: string; name: string; source: string }> = [];
  const overrides: Array<{ sessionId: string; name: string; source: string }> = [];

  for (const row of rows) {
    const candidate =
      row.transcriptNameSource === 'agent'
        ? { name: row.transcriptName, into: readings }
        : row.nameSource === 'agent'
          ? { name: row.customName, into: overrides }
          : null;
    if (!candidate?.name || !isSelfAssignedSessionName(candidate.name, row.sessionId)) {
      continue;
    }
    candidate.into.push({
      sessionId: row.sessionId,
      name: stripSelfAssignedSuffix(candidate.name, row.sessionId),
      // A title the transcript still carries is what the session was called; a
      // transcript that carries none leaves only the first prompt, which the
      // next scan derives for itself.
      source: transcriptHoldsAiTitle(row.jsonlPath) ? 'ai' : 'derived',
    });
  }

  const writeReading = db.prepare(
    `UPDATE sessions SET transcript_name = @name, transcript_name_source = @source WHERE session_id = @sessionId`
  );
  const writeOverride = db.prepare(
    `UPDATE sessions SET custom_name = @name, name_source = @source WHERE session_id = @sessionId`
  );
  for (const row of readings) {
    writeReading.run(row);
  }
  for (const row of overrides) {
    writeOverride.run(row);
  }
  if (readings.length + overrides.length > 0) {
    console.log(
      `Running migration: Re-filing ${readings.length + overrides.length} session(s) named after a CloudCLI resident address`
    );
  }
};

/**
 * Adds the `model` column that records which model each session runs with.
 *
 * Left NULL for pre-existing rows on purpose: the model resolver falls back to
 * the provider-native lookup for sessions the app has never sent on, so a
 * backfilled guess would only mask the real value.
 */
const addSessionModelColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'model', 'TEXT');
};

/**
 * Adds the `effort` column that records a session's reasoning-effort choice.
 *
 * Existing rows stay NULL so clients can continue falling back to their
 * per-provider preference until the user selects an effort or sends a turn.
 */
const addSessionEffortColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'effort', 'TEXT');
};

/**
 * Adds the `permission_mode` column that records the mode a session last sent
 * a message with.
 *
 * Existing rows stay NULL: NULL means "no message has recorded a mode yet",
 * which is a real answer the client acts on (fall back to the provider
 * default). Backfilling a guess would make an old session claim a mode the
 * user never sent with.
 */
const addSessionPermissionModeColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'permission_mode', 'TEXT');
};

/**
 * Adds the `lifecycle_mode` column: how long a session's process is meant to
 * live ('per-run' or 'resident').
 *
 * The `DEFAULT 'per-run'` is the whole migration. An existing row has been
 * running one process per turn for its entire life, so that is the true value
 * for it rather than a placeholder — and it is also what makes the column safe
 * to read unconditionally: a reader never has to tell "no preference recorded"
 * from "the default preference", because for this column they are the same
 * answer.
 *
 * Called after `dropLaunchProfileStructures`, whose table rebuild copies an
 * explicit column list and would otherwise drop the new column along with the
 * old table.
 */
const addSessionLifecycleModeColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'lifecycle_mode', "TEXT DEFAULT 'per-run'");
};

/**
 * Adds the `isPinned` column: whether the user pinned a session to the top of
 * its project's list.
 *
 * `DEFAULT 0` is the truthful value for every existing row — nothing was
 * pinnable before this column existed — and it is also what makes the column
 * safe to read unconditionally: an unpinned row and a row from before the
 * feature are the same answer.
 *
 * Called after the sessions-table rebuilds for the same reason as
 * `addSessionLifecycleModeColumn`: their copies use an explicit column list, so
 * a column added earlier would be dropped again.
 */
const addSessionPinnedColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isPinned', 'BOOLEAN DEFAULT 0');
};

/**
 * Adds `session_order`: the position the user dragged this session to inside
 * its project's list, NULL until the list has been arranged by hand.
 *
 * The column is deliberately nullable rather than defaulted to a number: NULL
 * is what a fresh session carries, and the listing sorts those above the
 * arranged block, so a new session shows up at the top of the list instead of
 * inheriting a position the user never chose for it.
 *
 * Added after every sessions-table rebuild for the same reason as the columns
 * above — their copies use an explicit column list.
 */
const addSessionOrderColumn = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'session_order', 'INTEGER');
};

/**
 * Adds the two columns behind the sidebar's "awaiting reply" list: when a
 * session started waiting on the user, and why.
 *
 * Both are nullable and default to NULL, which is the truthful value for every
 * existing row — no session was listable before the feature existed — and what
 * makes the column safe to read unconditionally: a NULL is simply "not waiting".
 *
 * Added after every sessions-table rebuild for the same reason as the columns
 * above: their copies use an explicit column list, so a column added earlier
 * would be dropped again.
 */
const addSessionAwaitingReplyColumns = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'awaiting_reply_at', 'TEXT');
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'awaiting_reply_reason', 'TEXT');
};

/**
 * Drops the two structures the removed launch-profile feature left in the
 * database: the `launch_profiles` table and the `sessions.launch_profile_id`
 * column.
 *
 * Named launch profiles were replaced by per-model config entries (ADR-002), so
 * a database created while the feature existed keeps both forever unless they
 * are dropped here — an upgraded install has to end up with the structure a
 * freshly created one has, and `schema.ts` no longer declares either.
 *
 * The column is removed by the same create/copy/rename rebuild the other
 * sessions migrations use; SQLite's own DROP COLUMN support is too limited to
 * rely on here. The rows are the user's sessions and are copied across
 * unchanged — only the profile id itself goes, because the feature it referred
 * to no longer exists (the delete path for sessions is untouched).
 */
const dropLaunchProfileStructures = (db: Database): void => {
  if (tableExists(db, 'launch_profiles')) {
    console.log('Running migration: Dropping the legacy launch_profiles table');
    db.exec('DROP TABLE launch_profiles');
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  if (!columnNames.includes('launch_profile_id')) {
    return;
  }

  console.log('Running migration: Dropping the legacy launch_profile_id column from sessions');

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        model TEXT,
        effort TEXT,
        permission_mode TEXT,
        forked_from_session_id TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO sessions__new (
        session_id,
        provider,
        provider_session_id,
        custom_name,
        project_path,
        jsonl_path,
        model,
        effort,
        permission_mode,
        forked_from_session_id,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        provider_session_id,
        custom_name,
        project_path,
        jsonl_path,
        model,
        effort,
        permission_mode,
        forked_from_session_id,
        COALESCE(isArchived, 0),
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM sessions
      WHERE session_id IS NOT NULL AND trim(session_id) <> ''
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds `config_json` to `provider_models`: the JSON-serialised per-model
 * config (`{ env: [...] }`); NULL means no override. Databases created before
 * the column existed get it here, new databases get it from the table schema.
 */
const addProviderModelConfigColumn = (db: Database): void => {
  const columnNames = getTableInfo(db, 'provider_models').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'provider_models', columnNames, 'config_json', 'TEXT');
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

/**
 * The indexes the removed plaintext `api_keys` feature created, verbatim.
 *
 * `DROP TABLE` removes a table's indexes with it, so these are only a fallback
 * for a database whose table is already gone while an index lingers.
 */
const LEGACY_API_KEYS_INDEX_STATEMENTS = [
  'DROP INDEX IF EXISTS idx_api_keys_key',
  'DROP INDEX IF EXISTS idx_api_keys_user_id',
  'DROP INDEX IF EXISTS idx_api_keys_active',
];

/**
 * Drops the plaintext `api_keys` table its indexes, left behind by the
 * retired API-key feature (superseded by hashed `access_tokens`, AC-224).
 *
 * A database created while the feature existed keeps the table forever unless
 * it is dropped here, and an upgraded install has to end up with the structure
 * a freshly created one has — `schema.ts` no longer declares either. The old
 * keys are deliberately NOT migrated into fresh tokens: they are plaintext
 * credentials with no hash on disk, and inventing tokens for them would hand
 * out access nobody asked for. Only the count of discarded rows is reported.
 *
 * Idempotent and fresh-database safe: when the table is absent nothing is
 * logged and nothing throws, so a second startup is a no-op.
 */
const dropLegacyApiKeysStructures = (db: Database): void => {
  if (tableExists(db, 'api_keys')) {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as {
      count: number;
    };
    console.log(`Running migration: Dropping the legacy api_keys table (${count} rows removed)`);
    db.exec('DROP TABLE api_keys');
  }

  for (const statement of LEGACY_API_KEYS_INDEX_STATEMENTS) {
    db.exec(statement);
  }
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');
    db.exec(NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled)');
    db.exec(PROVIDER_MODELS_TABLE_SCHEMA_SQL);
    addProviderModelConfigColumn(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_models_provider_order
      ON provider_models(provider, sort_order, id)
    `);
    db.exec(USER_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(SESSION_DRAFTS_TABLE_SCHEMA_SQL);
    db.exec(SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL);
    addSupersededTranscriptPathColumn(db);

    // The U-source lexicon (gap-voice-user-identifier-index-import). Owned by no
    // other table — it keys off a project path, not a `projects` row — so it has
    // no place among the ordered rebuilds below and is created here beside the
    // other standalone feature tables.
    db.exec(VOICE_USER_IDENTIFIERS_TABLE_SCHEMA_SQL);

    // The observation layer (observation-object-model-seen-cursor-and-delta): the unified
    // observed-object model, the append-only revision log, the cross-device seen cursor, the
    // per-user watch list, and the producer heartbeats the wall's own liveness reading uses.
    // Each is `CREATE TABLE IF NOT EXISTS`, so a second startup is a no-op and an install that
    // predates the layer gains the tables in place.
    db.exec(OBSERVED_OBJECTS_TABLE_SCHEMA_SQL);
    db.exec(OBSERVED_REVISIONS_TABLE_SCHEMA_SQL);
    db.exec(OBSERVATION_SEEN_CURSORS_TABLE_SCHEMA_SQL);
    db.exec(OBSERVATION_WATCH_ENTRIES_TABLE_SCHEMA_SQL);
    db.exec(OBSERVATION_PRODUCER_HEARTBEATS_TABLE_SCHEMA_SQL);

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);
    addProjectSessionFilterColumn(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    addProviderSessionIdMapping(db);
    addSessionModelColumn(db);
    addSessionEffortColumn(db);
    addSessionPermissionModeColumn(db);
    addForkedFromSessionIdColumn(db);
    // Last of the sessions-shape migrations: it rebuilds the table, so every
    // column the copy reads has to exist by now.
    dropLaunchProfileStructures(db);
    // After that rebuild, never before it: the rebuild copies an explicit
    // column list, so a name_source added earlier would be dropped with the
    // old table and its backfill lost.
    addSessionNameSourceColumn(db);
    // Likewise after the rebuild, and after the name_source column it reads.
    splitSessionTranscriptNameColumns(db);
    // After the split, because it files a reading back onto the rungs the split
    // created — and after every rebuild, because it reads the name columns.
    reclassifySelfAssignedSessionNames(db);
    // And again after that rebuild: it copies an explicit column list, so a
    // lifecycle_mode added before it would be dropped along with the old table
    // and every existing session would come back with the column missing.
    addSessionLifecycleModeColumn(db);
    // And once more for the same reason: another sessions-table rebuild would
    // drop an isPinned added before it.
    addSessionPinnedColumn(db);
    // The column that replaced the pin; same placement rule.
    addSessionOrderColumn(db);
    // The sidebar's awaiting-reply pair; same placement rule.
    addSessionAwaitingReplyColumns(db);
    ensureProjectsForSessionPaths(db);
    db.exec(SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL);
    // OAuth storage (mcp-gateway-SPEC stage 5, AC-258). Order matters: the
    // access_tokens.grant_id foreign key points at oauth_grants, so the grant
    // (and the client it references) must exist before the token table.
    db.exec(OAUTH_CLIENTS_TABLE_SCHEMA_SQL);
    db.exec(OAUTH_GRANTS_TABLE_SCHEMA_SQL);
    // Access-token storage, PAT + OAuth. Fresh databases get the full column set
    // from the schema; an older database is widened by addAccessTokenOAuthColumns.
    db.exec(ACCESS_TOKENS_TABLE_SCHEMA_SQL);
    addAccessTokenOAuthColumns(db);
    db.exec(OAUTH_AUTHORIZATION_CODES_TABLE_SCHEMA_SQL);
    // The code→grant redemption ledger (AC-259) — after the codes and grants
    // tables it keys off, so its grant_id foreign key always resolves.
    db.exec(OAUTH_CODE_REDEMPTIONS_TABLE_SCHEMA_SQL);
    // The MCP tool-call audit log (AC-244). `CREATE TABLE IF NOT EXISTS` makes a
    // second startup a no-op over an existing table; the index backs the
    // retention sweep, which scans by `at`. An existing table is widened with
    // `denied_scopes` (AC-286) and then the usage-stats telemetry tail
    // (gap-mcp-usage-stats) by the guarded migrations that follow.
    db.exec(MCP_AUDIT_LOG_TABLE_SCHEMA_SQL);
    addMcpAuditLogDeniedScopesColumn(db);
    addMcpAuditLogTelemetryColumns(db);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_at ON mcp_audit_log(at)');
    // The browser's last-opened session (gap-mcp-ui-last-opened-session). One row,
    // no index beyond the primary key: the table is read whole and written whole.
    // `CREATE TABLE IF NOT EXISTS` makes a second startup a no-op.
    db.exec(UI_LAST_OPENED_TABLE_SCHEMA_SQL);
    // The revocation cascades scan by grant, so without these the cascade and
    // the per-client listing table-scan access_tokens.
    db.exec('CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants(client_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_access_tokens_grant ON access_tokens(grant_id)');

    // A token that was in use before the throttled stamp existed still reads as
    // never used; the audit log already holds the honest answer. Runs after the
    // audit table and the grant index exist. Idempotent — it writes only NULL
    // columns and only where a source row exists — so it logs solely when it
    // actually changed something.
    const backfilledLastUsedRows = backfillLastUsedFromAuditLog(db);
    if (backfilledLastUsedRows > 0) {
      console.log(
        `Running migration: Backfilled last_used for ${backfilledLastUsedRows} token/grant row(s)`
      );
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_forked_from ON sessions(forked_from_session_id)');
    // gap-mcp-session-search-time-pruning-and-stable-cursor: the conversation
    // search prunes by `updated_at` (since/until) and orders the scan by it, so
    // the column it reads is indexed alongside the other five sessions indexes.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)');
    // The due-message poll runs on a timer; without this it table-scans.
    db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(status, scheduled_for)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_messages_session ON scheduled_messages(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    // Alongside the other legacy-structure drops: it touches only `api_keys`,
    // so it is independent of the sessions rebuilds above.
    dropLegacyApiKeysStructures(db);

    db.exec(LAST_SCANNED_AT_SQL);
    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};
