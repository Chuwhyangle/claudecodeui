export { initializeDatabase } from '@/modules/database/init-db.js';
// runMigrations: the chain behind initializeDatabase, exported so a criterion in
// another module can drive migrations against a database it built by hand. The
// module boundary rule is why it is here rather than imported by file path.
export { runMigrations } from '@/modules/database/migrations.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/core/index.js';
// accessTokensDb: used by the OAuth module to persist personal access tokens
// (hash + prefix only) and their expiry/revocation state.
export { accessTokensDb } from '@/modules/database/repositories/access-tokens.js';
export type { AccessTokenRow, InsertAccessTokenInput } from '@/modules/database/repositories/access-tokens.js';
// mcpAuditLogDb: used by the MCP gateway to persist one row per tool invocation
// (outcome + argument digest) and to sweep rows past the retention window.
export { mcpAuditLogDb } from '@/modules/database/repositories/mcp-audit-log.db.js';
export type { InsertMcpAuditLogInput, McpAuditLogRow } from '@/modules/database/repositories/mcp-audit-log.db.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
// oauthAuthorizationCodesDb: used by the OAuth module to persist PKCE authorization codes (hash only).
export { oauthAuthorizationCodesDb } from '@/modules/database/repositories/oauth-authorization-codes.db.js';
export type {
  InsertOAuthAuthorizationCodeInput,
  OAuthAuthorizationCodeRow,
} from '@/modules/database/repositories/oauth-authorization-codes.db.js';
// oauthClientsDb: used by the OAuth module to persist RFC 7591 client registrations (secret hash only).
export { oauthClientsDb } from '@/modules/database/repositories/oauth-clients.db.js';
export type { InsertOAuthClientInput, OAuthClientRow } from '@/modules/database/repositories/oauth-clients.db.js';
// oauthCodeRedemptionsDb: used by the OAuth module to keep the code→grant mapping
// that survives a code's deletion, so a replayed code can revoke its authorization.
export { oauthCodeRedemptionsDb } from '@/modules/database/repositories/oauth-code-redemptions.db.js';
export type {
  InsertOAuthCodeRedemptionInput,
  OAuthCodeRedemptionRow,
} from '@/modules/database/repositories/oauth-code-redemptions.db.js';
// oauthGrantsDb: used by the OAuth module to persist user consent grants, their
// revocation, the throttle-gated `last_used` stamp behind the settings page's
// connected-apps row, and (via `listByUser`) the per-user read there.
export { oauthGrantsDb } from '@/modules/database/repositories/oauth-grants.db.js';
export type { InsertOAuthGrantInput, OAuthGrantRow } from '@/modules/database/repositories/oauth-grants.db.js';
// observationDb: used by the observation module to persist observed objects, their revision
// log, per-user seen cursors and watch entries, and producer heartbeats.
export { observationDb } from '@/modules/database/repositories/observation.repository.js';
export type {
  AppendObservedRevisionInput,
  ObservationProducerHeartbeatRow,
  ObservationSeenCursorRow,
  ObservationWatchEntryRow,
  ObservedObjectRow,
  ObservedRevisionRow,
} from '@/modules/database/repositories/observation.repository.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// sessionDraftsDb: used by User for drafts and Scheduled Messages for server-owned queued turns.
export { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/session-drafts.db.js';
export {
  isSelfAssignedSessionName,
  sessionsDb,
  stripSelfAssignedSuffix,
} from '@/modules/database/repositories/sessions.db.js';
export type { SessionNameHiddenByFilterJson, SessionNameSource, SessionNameVisibility } from '@/modules/database/repositories/sessions.db.js';
// uiLastOpenedDb: used by the providers module to record the session the browser
// last opened, and by the MCP gateway (through that service) to answer
// `ui_last_opened_session`.
export { uiLastOpenedDb } from '@/modules/database/repositories/ui-last-opened.db.js';
export type { UiLastOpenedRecord } from '@/modules/database/repositories/ui-last-opened.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
// voiceSettingsDb: used by the Voice module to serve the per-user voice backend settings that used to live in browser localStorage.
export { voiceSettingsDb } from '@/modules/database/repositories/voice-settings.db.js';
// voiceUserIdentifiersDb: used by the Voice module's U-source lexicon to persist the identifier-shaped tokens the user has sent, with their frequencies.
export { voiceUserIdentifiersDb } from '@/modules/database/repositories/voice-user-identifiers.db.js';
export { scheduledMessagesDb } from './repositories/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/scheduled-messages.db.js';
