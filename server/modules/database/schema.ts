import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/core/index.js';

const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTICE_DISMISSALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notice_dismissals (
    user_id INTEGER NOT NULL,
    notice_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    dismissed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, notice_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    -- JSON {"hide": string[]} of session-name regexes hidden from the sidebar; NULL = no rules.
    session_filter TEXT DEFAULT NULL
);
`;

export const SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    -- Composer preferences (model, effort, permission mode, attachments) as
    -- they were when the message was scheduled, so it runs the way the user
    -- set it up rather than however the session is configured hours later.
    options TEXT NOT NULL DEFAULT '{}',
    -- UTC. The client sends an absolute instant so the schedule does not move
    -- when the user changes time zone between scheduling and firing.
    scheduled_for DATETIME NOT NULL,
    -- pending | sent | failed | cancelled
    status TEXT NOT NULL DEFAULT 'pending',
    -- Why a failed one failed, shown next to it in the composer.
    failure_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    -- The name the user explicitly chose for this session: a rename through
    -- the app. NULL means the user has not named it and the session's name is
    -- whatever \`transcript_name\` holds; readers that show a session's name
    -- project \`COALESCE(custom_name, transcript_name)\`, so this column is
    -- the override and \`transcript_name\` the reading.
    custom_name TEXT,
    -- Where \`custom_name\` came from: 'derived' (the first visible message or
    -- the history fallback), 'self-assigned' (an address this app handed the
    -- CLI as \`--name\` and an older build left in the override column), 'ai'
    -- (the title Claude writes into the transcript itself) or 'manual' (a
    -- rename through the app). Upserts only ever move a name up that order, so
    -- the column is what keeps a provider rescan from undoing a rename.
    name_source TEXT DEFAULT 'derived',

    -- The name this session's provider transcript gives it, kept apart from
    -- \`custom_name\` because the two answer different questions: this one is
    -- re-read on every sync (Claude revises its own title, and a CLI \`/rename\`
    -- can append one at any time), while \`custom_name\` only ever changes when
    -- the user does. One column could hold only one of them, and whichever lost
    -- would be silently rolled back by the next sync — a user's rename by the
    -- transcript, or a transcript's newer title by a rename that was recorded
    -- before it.
    transcript_name TEXT,
    -- Which rung of the provider's own title ladder \`transcript_name\` came
    -- from: 'agent' (the \`agent-name\` entry, the top rung), 'manual' (a
    -- \`custom-title\` entry, i.e. a CLI \`/rename\`), 'ai' (\`ai-title\`) or
    -- 'derived' (the session's first prompt). Unused for providers that do not
    -- publish such a ladder, which is also why it stays separate from
    -- \`name_source\`: 'manual' there means the user renamed it *in this app*,
    -- a claim the transcript cannot make.
    --
    -- 'self-assigned' is the app's own rung: the address CloudCLI handed the CLI
    -- as \`--name\`, which the CLI writes back into the transcript as both
    -- \`agent-name\` and \`custom-title\`. It is a name the app invented rather
    -- than one the session earned, so it ranks below 'ai' and above 'derived' —
    -- see \`SessionNameSource\`.
    transcript_name_source TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    -- Model and reasoning effort this session runs with. Written when the user
    -- changes either selection and on every send, so reopening a session
    -- restores its exact runtime configuration instead of provider defaults.
    model TEXT,
    effort TEXT,
    -- Permission mode this session last sent a message with (one of the
    -- modes the provider's capabilities declare: default, auto, acceptEdits,
    -- bypassPermissions, plan). Unlike model and effort there is no picker
    -- route that writes it: only an actual send records it, so NULL (never
    -- sent with one) is what makes every client fall back to the provider
    -- default instead of inventing a choice the user never made.
    permission_mode TEXT,
    -- How long this session's process is meant to live: 'per-run' (the
    -- default for every provider, and the only value a provider without the
    -- capability can hold) or 'resident' (one process serving many turns).
    -- A preference, not a fact: it says what the user asked for, not whether
    -- a process is up right now — hosts and leases live in memory and are
    -- never persisted. Written only through a check against the provider's
    -- declared modes; the default is why every pre-existing row keeps the
    -- behavior it had.
    lifecycle_mode TEXT DEFAULT 'per-run',
    -- The app session this one was branched from, NULL for sessions created
    -- normally. Informational only: a fork is a fully independent provider
    -- session, and deleting the source does not affect it.
    forked_from_session_id TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

// Defined by the connection package, which creates this table eagerly before
// the full schema runs; re-exported here so migrations keep their import site.
export { APP_CONFIG_TABLE_SCHEMA_SQL };

/**
 * Persistent custom-model library used by the Providers module.
 *
 * Only user-created models are stored here. Predefined models remain source-
 * controlled in each provider's `-models.provider.ts` adapter so they can be
 * updated without migrating application data. `model_id` is unique only within
 * a provider because different CLIs can accept the same identifier.
 */
export const PROVIDER_MODELS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode')),
    model_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, model_id)
);
`;

/**
 * Per-user application preferences that used to live in browser localStorage.
 *
 * One row per (user, key); `preference_value` is always a JSON document so a
 * key can hold a scalar (`"dark"`), a flag (`false`) or a whole settings blob
 * without the schema having to know which. Keeping them server-side is what
 * makes a preference follow the user from one device to another.
 */
export const USER_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER NOT NULL,
    preference_key TEXT NOT NULL,
    preference_value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, preference_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Unsent composer text and queued messages, per user and per chat scope.
 *
 * `draft_scope` is a session id, or `project:<projectId>` for a chat that has
 * not been sent yet and therefore has no session. Storing this server-side is
 * what lets a message typed on a laptop be finished on a phone.
 */
export const SESSION_DRAFTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_drafts (
    user_id INTEGER NOT NULL,
    draft_scope TEXT NOT NULL,
    draft_text TEXT NOT NULL DEFAULT '',
    queued_message TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, draft_scope),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Per-user Voice backend settings, which used to live in browser localStorage.
 *
 * Kept out of `user_preferences` on purpose: that table is downloaded to the
 * client wholesale on start-up, so a secret stored there would be rebroadcast on
 * every page load and would also be readable by any code path that merely wants
 * the theme. One row per user, holding the same six fields the settings tab
 * edits — `settings_json` rather than six columns because they are always read
 * and written as one document (the same reason `user_notification_preferences`
 * is shaped this way), so adding a field later needs no migration.
 *
 * The API key is stored in plaintext, exactly as `user_credentials` and
 * `api_keys` already store their credentials. Introducing encryption for this
 * one column would protect nothing while the neighbouring stores stayed
 * readable; that is a separate, repo-wide job.
 */
export const USER_VOICE_SETTINGS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_voice_settings (
    user_id INTEGER PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * The U-source: identifier-shaped tokens the user has *sent*, and how often.
 *
 * WHY IT IS A TABLE OF COUNTS AND NOT OF MESSAGES. The whole point of this store
 * is that a token's frequency is the signal — a word the user genuinely uses
 * shows up repeatedly, while a one-off appears once — and the signal is readable
 * from a count. Keeping the sentences would keep a second copy of the user's own
 * text next to the transcript that already holds it, for no reading this store
 * serves, so nothing but the token, its counts and its timestamps is stored.
 *
 * `(token_lower, project_key)` is the key: the same spelling in two projects is
 * two rows, which is what lets a future per-project view exist without a
 * migration, while `listTop` sums across them for the one global list the API
 * returns today. `token_lower` is the lookup key and `canonical` keeps the
 * spelling first seen, so `CloudCLI` and `cloudcli` count as one token and the
 * listing still shows a real casing.
 *
 * `first_seen_at` / `last_seen_at` are epoch milliseconds written by the
 * service's injected clock rather than `CURRENT_TIMESTAMP`, so a criterion can
 * pin them. No foreign key: the lexicon is scoped by `project_key` (a path), not
 * by a `projects` row, so a project removed from the sidebar leaves its word
 * frequencies readable rather than cascading them away.
 */
export const VOICE_USER_IDENTIFIERS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS voice_user_identifiers (
    token_lower TEXT NOT NULL,
    canonical TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    project_key TEXT NOT NULL,
    PRIMARY KEY (token_lower, project_key)
);
`;

/**
 * Provider sessions an app session has moved off, and must never move back to.
 *
 * Editing a message on a provider that cannot resume a transcript partway
 * (Codex) is done by branching: the conversation is copied up to the edited
 * turn and the app session follows the copy. The original transcript is left
 * on disk untouched — nothing is deleted — but it is no longer the session's,
 * and the indexer would otherwise rediscover it on its next full scan and hand
 * the session back to the version the user edited away from.
 */
export const SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS superseded_provider_sessions (
    provider_session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    -- The transcript the session left behind. Recorded because the session row
    -- stops pointing at it, and "delete this conversation from disk" has to
    -- reach every file the conversation ever lived in.
    jsonl_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_session_id, provider)
);
`;

/**
 * Access tokens issued by the OAuth module — both personal access tokens (PAT)
 * and OAuth access/refresh tokens.
 *
 * Only the SHA-256 hash of a token is ever stored; `token_prefix` keeps the
 * first eight characters (`ccp_`/`cca_`/`ccr_` + five hex digits) so a listing
 * can show which token a row is without the hash being reversible. `scopes` is a
 * JSON array of granted scope strings, and every timestamp column is written
 * from the service's injected clock rather than `CURRENT_TIMESTAMP` so expiry is
 * testable.
 *
 * `kind` tells a `pat` apart from an `oauth_access` / `oauth_refresh` token;
 * `grant_id` links an OAuth token to the `oauth_grants` row that authorized it
 * and cascades when that grant is deleted; `resource` is the RFC 8707 audience,
 * empty for PATs. The `pat`/`''` defaults are load-bearing: they are what let the
 * pre-existing PAT insert path (access-tokens.service.ts) keep working against
 * the widened table without writing either column (mcp-gateway-SPEC stage 5,
 * AC-258).
 *
 * A database created before stage 5 already has this table without the three
 * columns; `addAccessTokenOAuthColumns` in migrations.ts adds them under a
 * column-existence guard, so re-running migrations is a no-op.
 */
export const ACCESS_TOKENS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS access_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'pat',
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    name TEXT,
    grant_id INTEGER REFERENCES oauth_grants(id) ON DELETE CASCADE,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL DEFAULT '',
    expires_at DATETIME NOT NULL,
    created_at DATETIME,
    last_used DATETIME,
    revoked_at DATETIME
);
`;

/**
 * One row per MCP tool invocation (mcp-gateway-SPEC §389, AC-244).
 *
 * The DDL follows the SPEC with the AC-286 addition: `denied_scopes` holds the
 * JSON array of scopes a `denied` row's caller was missing (NULL on every other
 * outcome), so an operator can read WHICH scope a refusal was about. It is the
 * last column so the pre-AC-286 column prefix (and every reading written against
 * it) is unchanged. `at` defaults to the insert instant but a caller may pass it
 * explicitly, which is what lets the retention criterion plant rows 91 and 89
 * days old without waiting on wall time. `outcome` is always one of `ok` /
 * `denied` / `error`; `args_digest` holds only a summary (session/project ids
 * verbatim, free text reduced to its length and first 40 characters), never the
 * full arguments. `token_id` is the invoking token's row id and `client_id` is
 * NULL for a personal access token (an OAuth client id, GOAL-021, is not
 * recorded yet).
 *
 * The telemetry tail (gap-mcp-usage-stats) is appended AFTER `denied_scopes`, so
 * every earlier column keeps its position and every reading written against the
 * prefix is unchanged. `error_code` is the machine code an
 * `INVALID_ARGUMENT` / thrown-handler row carried (NULL on `ok`, and on a denial
 * whose code was not stamped); `response_bytes` is the UTF-8 byte length of the
 * serialized success payload (NULL on every failure, which carries no tool
 * payload); `correlation_id` is a nullable seam a later task (AC-337) fills — it
 * exists so a request can be traced without a second migration.
 * `CREATE TABLE IF NOT EXISTS` makes re-running migrations a no-op over an
 * existing table.
 */
export const MCP_AUDIT_LOG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at DATETIME DEFAULT CURRENT_TIMESTAMP,
  token_id INTEGER,
  client_id TEXT,
  tool TEXT NOT NULL,
  args_digest TEXT,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  denied_scopes TEXT,
  error_code TEXT,
  response_bytes INTEGER,
  correlation_id TEXT
);
`;

/**
 * Registered OAuth clients (mcp-gateway-SPEC stage 5, AC-258).
 *
 * `client_secret_hash` holds only the SHA-256 of a confidential client's secret
 * and is NULL for a public (PKCE-only) client, so a leaked database cannot be
 * replayed against the token endpoint. `redirect_uris` is a JSON array matched
 * exactly; `metadata` is the RFC 7591 registration document verbatim;
 * `created_via` is `'dcr'` or `'manual'`. `disabled_at` is set when an operator
 * disables the client, and the store then rejects every token under it.
 */
export const OAUTH_CLIENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_via TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  disabled_at DATETIME
);
`;

/**
 * User consent grants (mcp-gateway-SPEC stage 5, AC-258).
 *
 * One row per (user, client, scopes, resource) authorization a user approved.
 * `scopes` is a JSON array and `resource` the RFC 8707 audience the tokens are
 * bound to. `revoked_at` is the per-grant kill switch: setting it makes every
 * access/refresh token under the grant verify as revoked. The client and user
 * foreign keys cascade, so deleting either removes the grant and (through
 * `access_tokens.grant_id`) its tokens.
 */
export const OAUTH_GRANTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  revoked_at DATETIME
);
`;

/**
 * Short-lived authorization codes (mcp-gateway-SPEC stage 5, AC-258).
 *
 * `code_hash` is the SHA-256 of the code the client receives, so the plaintext
 * exists only in the redirect. `code_challenge` is the PKCE S256 challenge the
 * code was issued against. The single-use / 60-second admission rules over this
 * row belong to AC-259; this table and its repository are the storage only.
 */
export const OAUTH_AUTHORIZATION_CODES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);
`;

/**
 * The code→grant redemption ledger (mcp-gateway-SPEC stage 5, AC-259).
 *
 * `oauth_authorization_codes` is built verbatim from the SPEC DDL, which carries
 * no `grant_id`, yet AC-259's reuse rule must revoke the whole authorization a
 * consumed code already issued. This ledger supplies that persistent mapping
 * without widening the codes table: one row per issued code, written when the
 * code is issued (`redeemed_at` NULL) and stamped when it is exchanged. The codes
 * row is deleted on exchange, so a replayed code finds no codes row and is
 * resolved as reuse through this ledger's surviving `grant_id`.
 *
 * Only the code's SHA-256 hash is stored, consistent with every other OAuth
 * secret. The `grant_id` foreign key cascades, so deleting a grant clears its
 * ledger rows too.
 */
export const OAUTH_CODE_REDEMPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_code_redemptions (
  code_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redeemed_at DATETIME
);
`;

/**
 * The browser's last-opened session (gap-mcp-ui-last-opened-session).
 *
 * One row at a time: the table holds the SINGLE session the UI last opened, so a
 * new open replaces the previous row rather than accumulating a history. That
 * invariant is what makes "the last-opened session" a reading rather than a
 * query — a row that is written only by the browser's own session-read path
 * (never by an MCP token, which reaches the transcript through the service and
 * not through these routes).
 *
 * `opened_at` is epoch milliseconds (not `CURRENT_TIMESTAMP`): the tool renders
 * it as a relative + ISO pair from an injected clock, which needs the same
 * numeric instant every other read tool's time field is built from.
 */
export const UI_LAST_OPENED_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ui_last_opened (
  session_id TEXT PRIMARY KEY NOT NULL,
  opened_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Observation layer (tasks/observation-object-model-seen-cursor-and-delta).
//
// The wall's persisted material: the unified observed-object model (`observed_objects`), the
// append-only revision log the delta reader walks (`observed_revisions`), the cross-device
// "seen" cursor, the per-user watch list, and the producer heartbeats the wall's own liveness
// reading is computed from. `digest_json` and `delta_items_json` carry kind-specific structured
// readings as JSON text; the store validates their shape before writing. Timestamps are epoch
// milliseconds, like `ui_last_opened.opened_at`, so the injected clock is the only clock.
// ---------------------------------------------------------------------------

export const OBSERVED_OBJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observed_objects (
    uri TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status_state TEXT NOT NULL,
    status_reason TEXT,
    digest_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    provenance_producer TEXT NOT NULL,
    provenance_tier TEXT NOT NULL,
    provenance_evaluated_at INTEGER NOT NULL
);
`;

export const OBSERVED_REVISIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observed_revisions (
    uri TEXT NOT NULL,
    revision INTEGER NOT NULL,
    at INTEGER NOT NULL,
    delta_items_json TEXT NOT NULL,
    PRIMARY KEY (uri, revision),
    FOREIGN KEY (uri) REFERENCES observed_objects(uri) ON DELETE CASCADE
);
`;

export const OBSERVATION_SEEN_CURSORS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observation_seen_cursors (
    user_id TEXT NOT NULL,
    uri TEXT NOT NULL,
    revision INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, uri)
);
`;

export const OBSERVATION_WATCH_ENTRIES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observation_watch_entries (
    user_id TEXT NOT NULL,
    uri TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, uri)
);
`;

export const OBSERVATION_PRODUCER_HEARTBEATS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observation_producer_heartbeats (
    producer TEXT PRIMARY KEY NOT NULL,
    last_attempt_at INTEGER,
    last_write_at INTEGER,
    last_error TEXT,
    expected_interval_ms INTEGER NOT NULL
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- The legacy plaintext api_keys table and its idx_api_keys_* indexes are
-- deliberately NOT declared here: the feature was retired in favour of hashed
-- access_tokens, and a fresh database must not carry the dead structure. A
-- database that still has them is cleaned up by dropLegacyApiKeysStructures
-- in migrations.ts.

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${USER_NOTICE_DISMISSALS_TABLE_SCHEMA_SQL}

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- gap-mcp-session-search-time-pruning-and-stable-cursor: the conversation search
-- prunes by updated_at before scanning and orders the scan by it, so the column
-- this query reads gets an index. updated_at has been on sessions since the
-- first shape, so creating it here is safe even on a legacy install.
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${PROVIDER_MODELS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_provider_models_provider_order
ON provider_models(provider, sort_order, id);

${USER_PREFERENCES_TABLE_SCHEMA_SQL}

${SESSION_DRAFTS_TABLE_SCHEMA_SQL}

${SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL}

${USER_VOICE_SETTINGS_TABLE_SCHEMA_SQL}

${VOICE_USER_IDENTIFIERS_TABLE_SCHEMA_SQL}

${OBSERVED_OBJECTS_TABLE_SCHEMA_SQL}

${OBSERVED_REVISIONS_TABLE_SCHEMA_SQL}

${OBSERVATION_SEEN_CURSORS_TABLE_SCHEMA_SQL}

${OBSERVATION_WATCH_ENTRIES_TABLE_SCHEMA_SQL}

${OBSERVATION_PRODUCER_HEARTBEATS_TABLE_SCHEMA_SQL}
`;
