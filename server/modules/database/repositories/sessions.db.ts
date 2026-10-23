import { getConnection } from '@/modules/database/core/index.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import type { HostMode, SessionLaunchSelection } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Every session lifecycle mode, as a runtime value.
 *
 * The union (`HostMode`, in `@/shared/types.js`) is the definition; this is the
 * same list in a form a program can iterate, which is what lets the write gate
 * in `setSessionLifecycleMode` reject an unknown mode instead of storing it.
 * The `satisfies` makes a member that is not a `HostMode` a compile error, so
 * the array cannot invent a mode the rest of the app does not understand.
 */
const SESSION_LIFECYCLE_MODES: readonly string[] = ['per-run', 'resident'] satisfies readonly HostMode[];

/**
 * Where a session's name came from, ordered lowest to highest.
 *
 * `derived` is a name the app or an indexer inferred — the first visible
 * message of an app-created session, a transcript's first prompt, or the
 * history lookup; `ai` is the title Claude itself wrote into the transcript;
 * `manual` is the user's own word — a rename through this app, or a CLI
 * `/rename` recorded as the transcript's `custom-title`; `agent` is the
 * `agent-name` entry a Claude session carries for the agent that owns it, the
 * head of the CLI's own title ladder, which outranks even the user's rename
 * because that is the order the CLI itself displays.
 *
 * The order *is* the precedence every upsert respects (see `createSession`):
 * a name never moves down it, so nothing a provider rescans can undo a rename.
 * It orders the two kinds of name the same way: the `transcript_name_source`
 * of a reading and the `name_source` of an override are drawn from this same
 * scale, so `agent` on a reading outranks `ai` on another reading, and a
 * reading never displaces an override — see `writeTranscriptName`.
 *
 * `self-assigned` sits *between* `ai` and `derived`: it is the address this app
 * itself handed the CLI as a launch flag, which the CLI writes back as the
 * session's `agent-name` and `custom-title`. It is a name the app invented, not
 * one the session earned, so it never outranks a real title — see
 * {@link isSelfAssignedSessionName} for how one is told apart from an
 * `agent-name` an *agent* chose.
 */
export type SessionNameSource = 'derived' | 'self-assigned' | 'ai' | 'manual' | 'agent';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  /**
   * The name this session is displayed under: the user's override when there
   * is one, the transcript's reading otherwise. Every reader gets the same
   * answer because {@link SESSION_ROW_COLUMNS} projects it, so no consumer has
   * to know the two live in separate columns.
   */
  custom_name: string | null;
  /** Where `custom_name` came from; see `SessionNameSource`. */
  name_source: string | null;
  /**
   * The name the session's own transcript gives it, or NULL if it has none.
   *
   * Optional only because a caller may hand-build a row — a test stub or a
   * lookup that answers from memory — and such a row predates the split. Every
   * row read out of the database carries both fields.
   */
  transcript_name?: string | null;
  /** Which rung of the provider's title ladder `transcript_name` came from. */
  transcript_name_source?: string | null;
  /** Model this session runs with; NULL until the app records one for it. */
  model: string | null;
  /** Reasoning effort this session runs with; NULL until the app records one. */
  effort: string | null;
  /**
   * Permission mode the session last sent a message with; NULL until a send
   * records one. NULL is a real answer, not "unknown": it means no message has
   * carried a mode for this session yet.
   */
  permission_mode: string | null;
  /**
   * How long this session's process is meant to live; see `HostMode`.
   *
   * Never NULL on a row read from the database: the column carries
   * `DEFAULT 'per-run'`, so a row that predates it reads back as the mode it has
   * in fact been running, and there is no "unset" state to fall back from.
   *
   * Optional in the type the way `transcript_name` is — a shape written against
   * this row before the column existed stays a valid `SessionRow` — but never
   * absent from one this repository produced. Readers that need the mode rather
   * than the row go through `getSessionLifecycleMode`, which is where the
   * database value is checked against the modes the app knows.
   */
  lifecycle_mode?: string;
  /** The app session this one was branched from; NULL unless it is a fork. */
  forked_from_session_id: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

/**
 * One session a start-up restore pass may bring back, as the store reports it.
 *
 * The four facts the pass decides on and nothing else: which application
 * session, which provider would launch it, the provider's own id for the
 * conversation (never NULL — the query excludes rows without one), and the last
 * activity instant as epoch milliseconds. Left unexported because the shape is
 * the contract: `server/index.ts` maps the value structurally onto the
 * session-hosts module's `RestorableResidentSession`, and a named export would
 * only invite a second spelling of those four fields.
 */
type RestorableResidentSessionRow = {
  appSessionId: string;
  provider: string;
  providerSessionId: string;
  lastActiveAt: number;
};

/**
 * Formats an instant as SQLite's own UTC timestamp form, to the second.
 *
 * `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS`, and every date function in
 * the restore query reads a value in that form as UTC; an ISO string with a `T`
 * and a `Z` would parse too on modern SQLite but only because of a lenient
 * accepted-format list, so the cutoff is written in the same shape the column
 * already holds rather than in one the comparison merely tolerates.
 */
function toSqliteUtcTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Name-based visibility rule for a project's session list. `isHidden` is the
 * compiled matcher from the projects module; sessions listed in
 * `keepSessionIds` (running / attention / selected) are never excluded.
 */
export type SessionNameVisibility = {
  isHidden: (sessionName: string) => boolean;
  keepSessionIds: string[];
};

/** Per-project matcher for aggregate lists: receives the session name and the project's raw filter JSON. */
export type SessionNameHiddenByFilterJson = (sessionName: string, filterJson: string) => boolean;

/**
 * Builds the SQL fragment + params that exclude name-filtered sessions, and
 * registers the `session_name_hidden` SQL function backing it. better-sqlite3
 * is synchronous, so re-registering per call cannot race with other queries.
 */
function buildNameVisibilityClause(
  db: ReturnType<typeof getConnection>,
  visibility: SessionNameVisibility | undefined,
  invert = false,
): { clause: string; params: string[] } {
  if (!visibility) {
    return { clause: invert ? 'AND 0' : '', params: [] };
  }

  db.function('session_name_hidden', { deterministic: true }, (name: unknown) =>
    visibility.isHidden(typeof name === 'string' ? name : '') ? 1 : 0,
  );
  const hiddenExpression = `(session_name_hidden(COALESCE(custom_name, transcript_name, '')) = 1
      AND session_id NOT IN (SELECT value FROM json_each(?)))`;
  return {
    clause: invert ? `AND ${hiddenExpression}` : `AND NOT ${hiddenExpression}`,
    params: [JSON.stringify(visibility.keepSessionIds)],
  };
}

/**
 * The columns of one session row, with `custom_name` and `name_source`
 * projected to the session's *displayed* name and that name's provenance.
 *
 * A session's name lives in two columns — `custom_name` is the user's override
 * and `transcript_name` the transcript's reading — and every consumer wants
 * "what is this session called", not "which of the two is set". Projecting the
 * answer here rather than in each of them keeps the two-column split invisible:
 * a reader that asked for `custom_name` before the split still gets the name it
 * would have got, whichever column now holds it.
 */
/**
 * SQL expression for the name a session is shown under: the user's override if
 * they made one, the transcript's reading otherwise.
 *
 * The precedence that decides which *claim* wins (see `incomingNameWinsSql`) has
 * to compare against the same expression, or it compares against a column that
 * is empty on every row that has no override and hands the row to an incoming
 * name it should have kept.
 */
function displayNameSql(prefix = ''): string {
  return `COALESCE(${prefix}custom_name, ${prefix}transcript_name)`;
}

/**
 * SQL expression for where the displayed name came from.
 *
 * An override carries its own provenance, a reading carries its own, and a row
 * from before the split may have nothing but the single old column — hence the
 * last fallback.
 */
function displayNameSourceSql(prefix = ''): string {
  return `COALESCE(
    CASE WHEN ${prefix}custom_name IS NOT NULL THEN ${prefix}name_source END,
    ${prefix}transcript_name_source,
    ${prefix}name_source
  )`;
}

function sessionRowColumns(prefix = ''): string {
  return `
  ${prefix}session_id, ${prefix}provider, ${prefix}provider_session_id, ${prefix}project_path, ${prefix}jsonl_path,
  ${displayNameSql(prefix)} AS custom_name,
  ${displayNameSourceSql(prefix)} AS name_source,
  ${prefix}transcript_name, ${prefix}transcript_name_source,
  ${prefix}model, ${prefix}effort, ${prefix}permission_mode, ${prefix}lifecycle_mode,
  ${prefix}forked_from_session_id, ${prefix}isArchived, ${prefix}created_at, ${prefix}updated_at`;
}

const SESSION_ROW_COLUMNS = sessionRowColumns();
/** The same projection over a `sessions` alias, for queries that join. */
const SESSION_ROW_COLUMNS_QUALIFIED = sessionRowColumns('sessions.');

/**
 * The same columns *without* the display projection.
 *
 * Needed by the one caller that merges two rows into one: it has to move the
 * columns as they are stored, and a projected name would be adopted as an
 * override, freezing the other row's reading into `custom_name`.
 */
const SESSION_ROW_RAW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, name_source, transcript_name, transcript_name_source, model, effort, permission_mode, lifecycle_mode, forked_from_session_id, isArchived, created_at, updated_at';

/**
 * Whether `name` is one of the addresses this app assigned to a session.
 *
 * History: the resident host driver used to build a launch address as
 * `slug(title) + '-' + appSessionId.slice(0, 6)` and hand it to the CLI as
 * `--name`. The app no longer names anything — the CLI derives the name of the
 * process itself and the app only reads it — but the shape is still on disk in
 * every transcript an older build wrote, and the CLI wrote it back twice: as
 * the session's `agent-name` *and* as its `custom-title`. The title it slugged
 * was the session's own display name, so a relaunch folded the previous address
 * into the next one and a transcript can hold the same `-<id6>` two, three or
 * four times over.
 *
 * Two readings, strongest first:
 *
 * - With the app session id in hand (the steady state — the row exists and the
 *   transcript is already linked to it) the test is exact: the name ends in the
 *   id of the very row it is stored on. An `agent-name` a real agent picked
 *   cannot end in that id, so it is never mistaken for one of ours.
 * - Without it (a transcript that has not been linked to an app row yet) the
 *   fallback is the minted shape: a trailing `-` and exactly six lowercase hex
 *   characters. App session ids are UUIDs, so every address this app ever minted
 *   has that shape, and the cost of the fallback being wrong is bounded — a
 *   genuine `agent-name` that happens to end that way ranks below an `ai-title`
 *   instead of above it, which is the same side of the line the guard wants.
 *
 * Consumers: the Claude session synchronizer uses it to keep such a reading off
 * the top rung of the title ladder, and the session-name migration uses it to
 * reclassify rows an older build polluted. Both import it through
 * `@/modules/database/index.js`.
 */
export function isSelfAssignedSessionName(
  name: string | null | undefined,
  appSessionId?: string | null
): boolean {
  if (!name) {
    return false;
  }
  const lowered = name.toLowerCase();
  if (appSessionId) {
    const suffix = `-${appSessionId.slice(0, 6)}`.toLowerCase();
    if (suffix.length > 1 && lowered.endsWith(suffix)) {
      return true;
    }
  }
  return /-[0-9a-f]{6}$/.test(lowered);
}

/**
 * `name` with any trailing copies of this app's address suffix removed.
 *
 * A display name that went through the old launch-address builder more than once
 * carries the session's `-<id6>` two, three or four times over
 * (`a-b-edb5ea-edb5ea`). Peeling them is what lets the session-name migration
 * recover the name a row had before an older build wrote its address over it. A
 * name that does not end in *this* session's own suffix is returned unchanged,
 * so a title that merely ends in six hex-looking letters (`facade`, `decade`) is
 * left alone.
 *
 * Consumers: the session-name migration (`reclassifySelfAssignedSessionNames`).
 * It imports this through `@/modules/database/index.js`.
 */
export function stripSelfAssignedSuffix(name: string, appSessionId: string): string {
  const suffix = `-${appSessionId.slice(0, 6)}`;
  let base = name;
  while (base.length > suffix.length && base.toLowerCase().endsWith(suffix.toLowerCase())) {
    base = base.slice(0, -suffix.length);
  }
  return base;
}

/**
 * SQL expression ranking one name-source expression, for the precedence CASE.
 *
 * Anything unrecognized — including the NULL a row can still carry — ranks as
 * `derived`: a name with no recorded provenance has no better claim than one an
 * indexer inferred.
 */
function nameSourceRankSql(sourceSql: string): string {
  return `(CASE ${sourceSql} WHEN 'agent' THEN 4 WHEN 'manual' THEN 3 WHEN 'ai' THEN 2 WHEN 'self-assigned' THEN 1 ELSE 0 END)`;
}

/**
 * SQL predicate: the incoming name wins over the name already on the row.
 *
 * This is the one place the precedence `manual` > `ai` > `derived` is written
 * down; both upsert branches of `createSession` splice it into their
 * `custom_name` *and* `name_source` assignments, so a row can never take one
 * without the other (the name and its provenance are only meaningful together).
 * It is emitted as an expression rather than as a CASE returning the name
 * because the caller needs to know *that* the incoming name won, not just what
 * it is.
 *
 * Ties go to the incoming name — a later `ai` title or a later rename replaces
 * an earlier one — with a single exception: two `derived` names on an
 * app-created row keep the name the app derived from the first visible
 * message. The indexer's re-derivation (a `last-prompt`, or the history
 * fallback) is never a better name for an app session than the message the
 * user actually typed, and that is what the sidebar has always shown.
 */
function incomingNameWinsSql(parts: {
  existingNameSql: string;
  existingSourceSql: string;
  incomingNameSql: string;
  incomingSourceSql: string;
  /** `1` when the row's id was minted by the app rather than by the provider. */
  appOwnedRowSql: string;
}): string {
  const sameRank = `${nameSourceRankSql(parts.incomingSourceSql)} = ${nameSourceRankSql(parts.existingSourceSql)}`;
  return `(
    ${parts.incomingNameSql} IS NOT NULL
    AND (
      ${parts.existingNameSql} IS NULL
      OR ${nameSourceRankSql(parts.incomingSourceSql)} > ${nameSourceRankSql(parts.existingSourceSql)}
      OR (${sameRank} AND NOT (${parts.incomingSourceSql} = 'derived' AND ${parts.appOwnedRowSql}))
    )
  )`;
}

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row.
   *
   * A name only ever moves *up* the `SessionNameSource` order here: the
   * incoming name replaces the stored one when its source outranks it (or
   * ties, outside the app-session case below), and a `manual` name is never
   * replaced by an `ai` or `derived` one. So an indexer can upgrade a session
   * from the first message to the transcript's own `ai-title`, while a name
   * the user chose survives every later rescan.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    nameSource: SessionNameSource = 'derived'
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      // `session_id <> provider_session_id` is NULL for a row whose provider
      // id is not recorded yet; COALESCE keeps that meaning "not app-owned",
      // which is how this branch has always read it.
      const nameWins = incomingNameWinsSql({
        existingNameSql: displayNameSql(),
        existingSourceSql: displayNameSourceSql(),
        incomingNameSql: '@incomingName',
        incomingSourceSql: '@incomingSource',
        appOwnedRowSql: 'COALESCE(session_id <> provider_session_id, 0)',
      });

      db.prepare(
        `UPDATE sessions SET
           provider = @provider,
           updated_at = COALESCE(@updatedAt, CURRENT_TIMESTAMP),
           project_path = @projectPath,
           jsonl_path = @jsonlPath,
           isArchived = CASE WHEN @updatedAt IS NULL OR julianday(@updatedAt) > julianday(updated_at) THEN 0 ELSE isArchived END,
           custom_name = CASE WHEN ${nameWins} THEN @incomingName ELSE custom_name END,
           name_source = CASE WHEN ${nameWins} THEN @incomingSource ELSE name_source END
         WHERE session_id = @sessionId`
      ).run({
        provider,
        updatedAt: updatedAtValue,
        projectPath: normalizedProjectPath,
        jsonlPath: jsonlPath ?? null,
        incomingName: customName ?? null,
        incomingSource: nameSource,
        sessionId: existing.session_id,
      });

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    const conflictNameWins = incomingNameWinsSql({
      existingNameSql: displayNameSql('sessions.'),
      existingSourceSql: displayNameSourceSql('sessions.'),
      incomingNameSql: 'excluded.custom_name',
      incomingSourceSql: 'excluded.name_source',
      appOwnedRowSql: 'COALESCE(sessions.session_id <> sessions.provider_session_id, 0)',
    });

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (@sessionId, @provider, @providerSessionId, @incomingName, @incomingSource, @projectPath, @jsonlPath, 0, COALESCE(@createdAt, CURRENT_TIMESTAMP), COALESCE(@updatedAt, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = CASE WHEN @updatedAt IS NULL OR julianday(excluded.updated_at) > julianday(sessions.updated_at) THEN 0 ELSE sessions.isArchived END,
         custom_name = CASE WHEN ${conflictNameWins} THEN excluded.custom_name ELSE sessions.custom_name END,
         name_source = CASE WHEN ${conflictNameWins} THEN excluded.name_source ELSE sessions.name_source END`
    ).run({
      sessionId: providerSessionId,
      provider,
      providerSessionId,
      incomingName: customName ?? null,
      incomingSource: nameSource,
      projectPath: normalizedProjectPath,
      jsonlPath: jsonlPath ?? null,
      createdAt: createdAtValue,
      updatedAt: updatedAtValue,
    });

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping. `customName` is derived
   * from the first visible CloudCLI message by the sessions service.
   *
   * `selection` is the model/effort/permission-mode the session is being created
   * WITH, written in the same statement that mints the row. It is a parameter
   * rather than a later `setSessionModel` call because the window between the two
   * is reachable: the Live Voice entry opens a voice connection on the returned id
   * immediately, and the relayed first utterance — which carries no model of its
   * own — would then run before the selection landed. Absent fields stay NULL,
   * which is what a session with nothing stated has always been.
   *
   * `customName` — the first message the user typed — is recorded as a
   * *reading*, not as an override: it is the app's guess at what the session is
   * about, so the transcript's own title has to be able to replace it as soon
   * as the session has one. Written into `custom_name` it could not: from here
   * on that column means the user typed the name, and a sync would have to
   * treat it as a rename and leave the first message in place forever.
   */
  createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    selection?: SessionLaunchSelection,
  ): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    // Every selection field defaults to NULL (SQLite's own default for the ones
    // not named here was NULL too): a caller that states nothing leaves every
    // reader falling back exactly as it did before this parameter existed.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, transcript_name, transcript_name_source, project_path, jsonl_path, model, effort, permission_mode, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'derived', ?, NULL, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
      sessionId,
      provider,
      customName ?? null,
      normalizedProjectPath,
      selection?.model ?? null,
      selection?.effort ?? null,
      selection?.permissionMode ?? null,
    );

    return sessionId;
  },

  /**
   * Inserts a session that already has its provider artifact on disk.
   *
   * Unlike `createAppSession` this writes `provider_session_id` and
   * `jsonl_path` immediately, because a fork's transcript file exists before
   * the row does — and the filesystem watcher would otherwise index it as an
   * unrelated session under its own id.
   *
   * `lifecycleMode` is copied from the source by the caller. It is a stored
   * *preference*, not a running process: this row is written with no host, and
   * the process (if the mode is `resident`) is started by the first send, not
   * here. That is why writing the column never has to consult the host manager
   * and why a fork cannot leave a process behind.
   */
  createForkedSession(input: {
    sessionId: string;
    provider: string;
    projectPath: string;
    customName: string | null;
    providerSessionId: string;
    jsonlPath: string;
    forkedFromSessionId: string;
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
    lifecycleMode: HostMode;
  }): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(input.provider, input.projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    // The watcher may already have created a row for the new transcript. Its
    // id is the provider-native one, which is what this row claims, so replace
    // it rather than leaving two sidebar entries for one conversation.
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, input.sessionId);
      db.prepare(
        `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, model, effort, permission_mode, lifecycle_mode, forked_from_session_id, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(
        input.sessionId,
        input.provider,
        input.providerSessionId,
        input.customName,
        normalizedProjectPath,
        input.jsonlPath,
        input.model,
        input.effort,
        input.permissionMode,
        input.lifecycleMode,
        input.forkedFromSessionId,
      );
    })();

    return input.sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      // Read raw rather than through the display projection: what is adopted
      // below is the duplicate's stored columns, and a projected name would be
      // written back as an override, freezing its transcript reading into
      // `custom_name` where nothing could ever revise it again.
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_RAW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = @providerSessionId,
             jsonl_path = COALESCE(jsonl_path, @jsonlPath),
             custom_name = COALESCE(custom_name, @customName),
             name_source = CASE
               WHEN custom_name IS NULL AND @customName IS NOT NULL THEN @nameSource
               ELSE name_source
             END,
             transcript_name = COALESCE(transcript_name, @transcriptName),
             transcript_name_source = CASE
               WHEN transcript_name IS NULL AND @transcriptName IS NOT NULL THEN @transcriptNameSource
               ELSE transcript_name_source
             END,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = @sessionId`
        ).run({
          providerSessionId,
          jsonlPath: duplicate.jsonl_path,
          customName: duplicate.custom_name,
          // A name and its provenance move together: adopting the duplicate's
          // name without its source would let the next provider scan overwrite
          // a name the user had chosen on the other row.
          nameSource: duplicate.name_source ?? 'derived',
          transcriptName: duplicate.transcript_name,
          transcriptNameSource: duplicate.transcript_name_source ?? 'derived',
          sessionId,
        });
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  /**
   * Moves one session onto a different provider session and transcript.
   *
   * Only editing a message on a provider that has to branch to rewind (Codex)
   * does this — an ordinary run keeps the same provider session for its whole
   * life. `assignProviderSessionId` cannot be used for it: that one keeps the
   * existing `jsonl_path` on purpose, so a session repointed with it would
   * claim the new thread while still reading the old transcript.
   *
   * The watcher may already have indexed the new transcript under its own id.
   * That row is the same conversation this one is about to become, so it is
   * replaced rather than left behind as a second sidebar entry.
   */
  repointSessionToProviderSession(
    sessionId: string,
    input: { providerSessionId: string; jsonlPath: string },
  ): void {
    const db = getConnection();

    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, sessionId);
      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           jsonl_path = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(input.providerSessionId, input.jsonlPath, sessionId);
    })();
  },

  /**
   * Detaches a session from its provider session so the next run starts a new
   * one.
   *
   * Used when an edit replaces the very first prompt: there is no conversation
   * left to branch from, so the session starts over instead.
   */
  detachProviderSession(sessionId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions SET
         provider_session_id = NULL,
         jsonl_path = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`
    ).run(sessionId);
  },

  /**
   * Records that a session has left a provider session behind for good.
   *
   * The transcript stays on disk, which is deliberate — the abandoned attempt
   * is recoverable — but the indexer must not offer it back, and on a session
   * discovered from disk (whose app id *is* the provider id) rediscovering it
   * would repoint the row at the conversation the user edited away from.
   */
  markProviderSessionSuperseded(input: {
    providerSessionId: string;
    provider: string;
    sessionId: string;
    jsonlPath: string | null;
  }): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO superseded_provider_sessions (provider_session_id, provider, session_id, jsonl_path)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_session_id, provider) DO UPDATE SET
         session_id = excluded.session_id,
         jsonl_path = excluded.jsonl_path,
         created_at = CURRENT_TIMESTAMP`
    ).run(input.providerSessionId, input.provider, input.sessionId, input.jsonlPath);
  },

  isProviderSessionSuperseded(providerSessionId: string, provider: string): boolean {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT 1 AS found FROM superseded_provider_sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { found: number } | undefined;

    return Boolean(row);
  },

  /**
   * Transcripts one session has left behind, for the caller that deletes a
   * conversation from disk.
   *
   * A conversation edited more than once has lived in more than one file, and
   * the session row only ever points at the newest.
   */
  getSupersededTranscriptPaths(sessionId: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT jsonl_path FROM superseded_provider_sessions
         WHERE session_id = ? AND jsonl_path IS NOT NULL`
      )
      .all(sessionId) as Array<{ jsonl_path: string }>;

    return rows.map((row) => row.jsonl_path);
  },

  /**
   * Forgets what a session left behind, once the session itself is gone.
   *
   * Without this the record outlives the row it was written for and keeps the
   * indexer refusing a transcript that no longer belongs to anything — a
   * conversation invisible to the app and impossible to delete through it.
   */
  clearSupersededProviderSessions(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM superseded_provider_sessions WHERE session_id = ?').run(sessionId);
  },

  /**
   * Records the model one session runs with.
   *
   * Called both when the user picks a model for the session and on every send,
   * so the row always reflects what the session last ran with and reopening it
   * restores that model instead of a catalog default.
   */
  setSessionModel(sessionId: string, model: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?
       WHERE session_id = ?`
    ).run(model, sessionId);
  },

  /**
   * Records the reasoning effort one session runs with.
   *
   * `default` is stored as an explicit choice rather than NULL so reopening
   * the session does not inherit a later per-provider effort preference.
   */
  setSessionEffort(sessionId: string, effort: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET effort = ?
       WHERE session_id = ?`
    ).run(effort, sessionId);
  },

  /**
   * Records the permission mode one session last sent a message with.
   *
   * Only a send calls this — unlike model and effort there is no picker route
   * that persists a mode on click, so an UPDATE is the whole write.
   *
   * Returns whether a row was actually updated. The send path resolves the
   * session row before it writes, so `false` means the row is not there
   * (yet), which the caller has to handle rather than lose the mode to a
   * silent no-op UPDATE.
   */
  setSessionPermissionMode(sessionId: string, permissionMode: string): boolean {
    const db = getConnection();
    return db.prepare(
      `UPDATE sessions
       SET permission_mode = ?
       WHERE session_id = ?`
    ).run(permissionMode, sessionId).changes > 0;
  },

  /**
   * Records the lifecycle mode one session runs under.
   *
   * `mode` is checked against {@link SESSION_LIFECYCLE_MODES} before the write,
   * because the column is `TEXT` and SQLite would happily store a typo that no
   * reader would ever match — a session silently falling back to `per-run`
   * while the app believes the user chose `resident`. A mode outside the
   * vocabulary is a caller bug, so it throws; that is a different failure from
   * "the row is not there", which is the boolean.
   *
   * The capability check — whether the session's *provider* offers this mode at
   * all — is deliberately not here. The capability matrix belongs to the
   * providers module and this repository may not import it; the caller that
   * knows the provider narrows the value first, and this is the last gate.
   *
   * Returns whether a row was actually updated, mirroring
   * {@link setSessionPermissionMode}: the caller has already resolved the
   * session, so `false` means the row went away rather than that the mode was
   * rejected.
   */
  setSessionLifecycleMode(sessionId: string, mode: string): boolean {
    if (!SESSION_LIFECYCLE_MODES.includes(mode)) {
      throw new Error(
        `Unknown session lifecycle mode "${mode}"; expected one of ${SESSION_LIFECYCLE_MODES.join(', ')}.`,
      );
    }

    const db = getConnection();
    return db.prepare(
      `UPDATE sessions
       SET lifecycle_mode = ?
       WHERE session_id = ?`
    ).run(mode, sessionId).changes > 0;
  },

  /**
   * Reads the lifecycle mode one session runs under.
   *
   * The read side of {@link setSessionLifecycleMode}, and the reason callers do
   * not have to remember that `lifecycle_mode` is optional on `SessionRow`: the
   * answer is always a mode, never a string. A row that is not there, and a
   * stored value this build does not recognize (a database written by a newer
   * one), both read as `per-run` — the behavior every session had before the
   * column existed, and the mode whose process lifetime the app can always
   * honour. Reporting an unknown mode as a distinct value would only move the
   * fallback decision to every caller.
   */
  getSessionLifecycleMode(sessionId: string): HostMode {
    const row = getConnection()
      .prepare(`SELECT lifecycle_mode FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { lifecycle_mode?: string | null } | undefined;

    const mode = row?.lifecycle_mode;
    return mode && SESSION_LIFECYCLE_MODES.includes(mode) ? (mode as HostMode) : 'per-run';
  },

  /**
   * Records a name the user typed for one session.
   *
   * The row is marked `manual` in the same statement: that is what tells every
   * later provider rescan the name is not its to replace, so the two writes
   * must stay together — a name without its source is a name that can be
   * silently re-derived away.
   */
  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?, name_source = 'manual'
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * Records the name a session's transcript gives it, and which rung of the
   * provider's title ladder that name came from.
   *
   * Rewritten on every sync rather than guarded by precedence, because a
   * reading is not a claim to defend but an observation: Claude revises the
   * `ai-title` as a conversation goes on and appends a `custom-title` when the
   * user renames in the CLI, so the newest reading is the only correct one —
   * even when it sits *lower* on the ladder than the one already stored. An
   * `ai-title` replaced by a `custom-title` is exactly that case, and keeping
   * the earlier, higher-ranked name would ignore the rename.
   *
   * The user's override is never touched: `custom_name` is their word, taken in
   * this app, and no transcript can revise it. A row that has one also keeps its
   * own `name_source`, so "what the user called it" and "where that came from"
   * stay a pair. The pair is written together in the other direction too: where
   * this statement clears a non-override `custom_name` it clears `name_source`
   * with it, so a provenance is never left describing a name that is no longer
   * on the row. The reading's own provenance is `transcript_name_source`, and
   * that is where the displayed name's source comes from when there is no
   * override to read.
   *
   * A name in `custom_name` whose provenance is *not* `manual` is not an
   * override, and it is cleared rather than left to shadow the reading. Such a
   * name is one an indexer wrote — the placeholder an early scan fell back to,
   * or a name written before the two columns were split — and it sits in the
   * override column only because that is where indexer-supplied names used to
   * go. Leaving it there would freeze it: the projection reads the override
   * first, so a session discovered before it had a title would show the
   * placeholder for as long as it existed, with the transcript's own name
   * sitting unread beside it. Clearing it here is not a loss — the reading
   * taking its place is the newer name for the same thing, and the row's own
   * provenance column records where that one came from.
   *
   * Returns whether a row was there to write. The caller has already created or
   * updated it, so `false` means it was removed underneath the scan.
   */
  writeTranscriptName(sessionId: string, transcriptName: string, source: SessionNameSource): boolean {
    const db = getConnection();
    // Both CASEs read the row as it was before this statement: SQLite evaluates
    // every assignment against the pre-update values, so `custom_name` below is
    // the one the previous scan left, not the one this statement is writing.
    return db.prepare(
      `UPDATE sessions SET
         transcript_name = @transcriptName,
         transcript_name_source = @source,
         custom_name = CASE
           WHEN custom_name IS NOT NULL AND COALESCE(name_source, 'derived') <> 'manual' THEN NULL
           ELSE custom_name
         END,
         name_source = CASE
           WHEN custom_name IS NOT NULL AND COALESCE(name_source, 'derived') = 'manual' THEN name_source
           ELSE NULL
         END
       WHERE session_id = @sessionId`
    ).run({ transcriptName, source, sessionId }).changes > 0;
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * The stored sessions a start-up restore pass may bring back, most recent first.
   *
   * A session is restorable when it is visible (`isArchived = 0`), was stored as
   * resident (`lifecycle_mode = 'resident'` — the only persisted statement that
   * the session is meant to sit between turns), carries the provider's own id
   * for the conversation (a process cannot be launched without one), and last
   * carried activity inside the caller's window. The window and the ceiling are
   * pushed down rather than filtered by the caller so one ordered query answers
   * the whole question; `lastActiveAt` travels back as epoch milliseconds, which
   * the SQLite `julianday` arithmetic makes a plain number rather than a
   * timestamp format the caller would have to parse.
   *
   * Ordering is `getRecentSessionsPage`'s own — `COALESCE(updated_at,
   * created_at)` descending, `session_id` descending as the tiebreak — because
   * `updated_at` here is the last activity the transcript re-derivation
   * produced, which is exactly "how recently was this session alive". Archived
   * project rows are not excluded the way the page query excludes them: the
   * mode is a property of the session, and a resident session whose project was
   * archived is still a process the user asked to keep.
   *
   * Consumed by `server/index.ts`'s restore wiring and by the session-hosts
   * module's restore criterion, which drives it on a temporary database.
   */
  listRestorableResidentSessions(options: { maxAgeMs: number; limit: number }): RestorableResidentSessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT session_id, provider, provider_session_id,
                CAST((julianday(COALESCE(updated_at, created_at)) - 2440587.5) * 86400000.0 AS INTEGER) AS last_active_ms
         FROM sessions
         WHERE isArchived = 0
           AND lifecycle_mode = 'resident'
           AND provider_session_id IS NOT NULL
           AND julianday(COALESCE(updated_at, created_at)) >= julianday(?)
         ORDER BY julianday(COALESCE(updated_at, created_at)) DESC,
                  session_id DESC
         LIMIT ?`
      )
      .all(toSqliteUtcTimestamp(Date.now() - options.maxAgeMs), options.limit) as {
        session_id: string;
        provider: string;
        provider_session_id: string;
        last_active_ms: number;
      }[];

    return rows.map((row) => ({
      appSessionId: row.session_id,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      lastActiveAt: Number(row.last_active_ms),
    }));
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  getRecentSessionsPage(
    limit: number,
    offset: number,
    isHiddenByProjectFilter?: SessionNameHiddenByFilterJson,
  ): RecentSessionsPage {
    const db = getConnection();
    if (isHiddenByProjectFilter) {
      db.function('session_hidden_by_project_filter', { deterministic: true }, (name: unknown, filterJson: unknown) =>
        typeof filterJson === 'string' && isHiddenByProjectFilter(typeof name === 'string' ? name : '', filterJson) ? 1 : 0,
      );
    }
    // Sessions matching their own project's hide rules are excluded, so total stays consistent with the page.
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
      ${isHiddenByProjectFilter
        ? "AND session_hidden_by_project_filter(COALESCE(sessions.custom_name, sessions.transcript_name, ''), projects.session_filter) = 0"
        : ''}
    `;
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS_QUALIFIED}
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as SessionRow[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`
      )
      .get() as { count: number } | undefined;

    return {
      sessions: normalizeSessionRows(rows),
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * One ascending keyset page of sessions whose last activity is newer than
   * `after`, oldest first, plus whether the source has more rows past the page.
   *
   * The incremental reader the MCP `changes` tool (AC-335 / AC-347) pulls from:
   * instead of re-listing the whole feed between two calls, it asks only for the
   * rows the watcher has touched since the position a previous call returned.
   *
   * This is a KEYSET page, not a `DESC … LIMIT` page. The old shape returned the
   * NEWEST `limit` rows, so a window holding more than `limit` rows silently
   * dropped its OLDEST ones — and when the window held exactly `limit` rows the
   * caller could not even tell it had been cut. Ascending order plus the
   * `(instant, session_id)` tie-break makes the position a total order the next
   * call can resume from, so no row is unreachable:
   *
   *  - `after.sessionId === null` — every row strictly newer than `after.atIso`
   *    (the shape a cursor that carries only a watermark, i.e. a v1 cursor, or a
   *    plain `since`, expresses).
   *  - `after.sessionId !== null` — every row strictly after the pair
   *    `(after.atIso, after.sessionId)` in ascending order, so rows sharing one
   *    `updated_at` continue across the boundary by id instead of by time.
   *
   * `hasMore` is read from the row past the page (the query asks for `limit + 1`
   * and reports whether it came back), so "the source has more" is a fact about
   * the database, never a guess from `rows.length === limit`.
   *
   * `projectPaths` is applied in the SQL `WHERE` (or `null` for the whole
   * workspace), never after the LIMIT: a single project's page must be built
   * from that project's rows, not from whatever rows happened to be newest.
   *
   * `updated_at` is written in two shapes — SQLite's `CURRENT_TIMESTAMP` (a
   * space separator, UTC) and an explicit ISO string — so a plain string compare
   * would order and filter them wrongly. Both the predicate and the ORDER BY go
   * through `julianday`, exactly as the previous reader and `getRecentSessionsPage`
   * do, so the two formats are compared as instants. Rows come back through
   * {@link normalizeSessionRows}, so a caller that needs epoch milliseconds
   * parses the canonical ISO it gets.
   */
  getSessionsUpdatedSinceKeyset(
    after: { atIso: string; sessionId: string | null },
    projectPaths: string[] | null,
    limit: number,
  ): { rows: SessionRow[]; hasMore: boolean } {
    const db = getConnection();
    const instant = 'julianday(COALESCE(updated_at, created_at))';
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (projectPaths !== null) {
      // A scope that names no project matches no row; `IN ()` is not valid SQL.
      if (projectPaths.length === 0) {
        return { rows: [], hasMore: false };
      }
      conditions.push(`project_path IN (${projectPaths.map(() => '?').join(', ')})`);
      params.push(...projectPaths);
    }

    if (after.sessionId === null) {
      conditions.push(`${instant} > julianday(?)`);
      params.push(after.atIso);
    } else {
      conditions.push(`(${instant} > julianday(?) OR (${instant} = julianday(?) AND session_id > ?))`);
      params.push(after.atIso, after.atIso, after.sessionId);
    }

    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${instant} ASC, session_id ASC
         LIMIT ?`
      )
      .all(...params, limit + 1) as SessionRow[];

    const hasMore = rows.length > limit;
    return { rows: normalizeSessionRows(hasMore ? rows.slice(0, limit) : rows), hasMore };
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(
    projectPath: string,
    limit: number,
    offset: number,
    visibility?: SessionNameVisibility,
  ): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const nameClause = buildNameVisibilityClause(db, visibility);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           ${nameClause.clause}
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, ...nameClause.params, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  countSessionsByProjectPath(projectPath: string, visibility?: SessionNameVisibility): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const nameClause = buildNameVisibilityClause(db, visibility);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           ${nameClause.clause}`
      )
      .get(normalizedProjectPath, ...nameClause.params) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  /** Counts the non-archived sessions the given visibility rule actually excludes (matched and not kept). */
  countHiddenSessionsByProjectPath(projectPath: string, visibility: SessionNameVisibility): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const nameClause = buildNameVisibilityClause(db, visibility, true);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           ${nameClause.clause}`
      )
      .get(normalizedProjectPath, ...nameClause.params) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /** Used by the OpenCode synchronizer to remove indexed child sessions by their native id. */
  deleteSessionByProviderSessionId(providerSessionId: string, provider: string): boolean {
    const db = getConnection();
    return db
      .prepare('DELETE FROM sessions WHERE provider_session_id = ? AND provider = ?')
      .run(providerSessionId, provider).changes > 0;
  },

  /**
   * Lists every indexed session that claims a transcript file on disk.
   *
   * Only rows with a `jsonl_path` are returned, which deliberately excludes
   * app-created sessions still waiting for their first provider write and
   * OpenCode rows (whose transcripts all live inside one shared sqlite file).
   * Used by the session synchronizer to find rows whose transcript has been
   * deleted underneath the index, and by a provider's one-time activity
   * backfill to find the rows it must re-derive. Pass `provider` to restrict
   * the result to one provider's transcripts.
   */
  getSessionsWithTranscriptPath(provider?: string): Array<{ session_id: string; jsonl_path: string }> {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, jsonl_path
         FROM sessions
         WHERE jsonl_path IS NOT NULL AND jsonl_path <> ''
           AND (@provider IS NULL OR provider = @provider)`
      )
      .all({ provider: provider ?? null }) as Array<{ session_id: string; jsonl_path: string }>;
  },

  /**
   * Rewrites one session's `updated_at`, leaving every other column alone.
   *
   * `createSession` is the wrong tool for a correction that changes only the
   * timestamp: it re-runs project registration and the name-precedence rules,
   * which is work — and risk — a timestamp fix does not need. Callers that
   * re-derive activity from a transcript's content use this so a stale
   * `updated_at` can be repaired without touching the row's name, archive flag,
   * or transcript path.
   *
   * Returns true only when a row was actually changed, so a caller reporting
   * how many rows it repaired reports real corrections rather than rows
   * visited. Returns false without writing when the value is not a parseable
   * timestamp: a NULL `updated_at` would silently reorder the sidebar, which is
   * worse than leaving the stale reading in place.
   */
  updateSessionUpdatedAt(sessionId: string, updatedAt: string): boolean {
    const normalized = normalizeTimestamp(updatedAt);
    if (!normalized) {
      return false;
    }

    const db = getConnection();
    return db.prepare(
      `UPDATE sessions
       SET updated_at = @updatedAt
       WHERE session_id = @sessionId AND updated_at IS NOT @updatedAt`
    ).run({ updatedAt: normalized, sessionId }).changes > 0;
  },
};
