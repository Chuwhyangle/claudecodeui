export { initializeDatabase } from '@/modules/database/init-db.js';
// runMigrations: the chain behind initializeDatabase, exported so a criterion in
// another module can drive migrations against a database it built by hand. The
// module boundary rule is why it is here rather than imported by file path.
export { runMigrations } from '@/modules/database/migrations.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/core/index.js';
// accessTokensDb: used by the OAuth module to persist personal access tokens
// (hash + prefix only) and their expiry/revocation state.
export { accessTokensDb } from '@/modules/database/repositories/auth/access-tokens.js';
export type { AccessTokenRow, InsertAccessTokenInput } from '@/modules/database/repositories/auth/access-tokens.js';
// mcpAuditLogDb: used by the MCP gateway to persist one row per tool invocation
// (outcome + argument digest) and to sweep rows past the retention window.
export { mcpAuditLogDb } from '@/modules/database/repositories/observation/mcp-audit-log.db.js';
export type { InsertMcpAuditLogInput, McpAuditLogRow } from '@/modules/database/repositories/observation/mcp-audit-log.db.js';
export { appConfigDb } from '@/modules/database/repositories/providers/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/auth/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/auth/github-tokens.js';
// oauthAuthorizationCodesDb: used by the OAuth module to persist PKCE authorization codes (hash only).
export { oauthAuthorizationCodesDb } from '@/modules/database/repositories/auth/oauth-authorization-codes.db.js';
export type {
  InsertOAuthAuthorizationCodeInput,
  OAuthAuthorizationCodeRow,
} from '@/modules/database/repositories/auth/oauth-authorization-codes.db.js';
// oauthClientsDb: used by the OAuth module to persist RFC 7591 client registrations (secret hash only).
export { oauthClientsDb } from '@/modules/database/repositories/auth/oauth-clients.db.js';
export type { InsertOAuthClientInput, OAuthClientRow } from '@/modules/database/repositories/auth/oauth-clients.db.js';
// oauthCodeRedemptionsDb: used by the OAuth module to keep the code→grant mapping
// that survives a code's deletion, so a replayed code can revoke its authorization.
export { oauthCodeRedemptionsDb } from '@/modules/database/repositories/auth/oauth-code-redemptions.db.js';
export type {
  InsertOAuthCodeRedemptionInput,
  OAuthCodeRedemptionRow,
} from '@/modules/database/repositories/auth/oauth-code-redemptions.db.js';
// oauthGrantsDb: used by the OAuth module to persist user consent grants, their
// revocation, the throttle-gated `last_used` stamp behind the settings page's
// connected-apps row, and (via `listByUser`) the per-user read there.
export { oauthGrantsDb } from '@/modules/database/repositories/auth/oauth-grants.db.js';
export type { InsertOAuthGrantInput, OAuthGrantRow } from '@/modules/database/repositories/auth/oauth-grants.db.js';
// observationDb: used by the observation module to persist observed objects, their revision
// log, per-user seen cursors and watch entries, and producer heartbeats.
export { observationDb } from '@/modules/database/repositories/observation/observation.repository.js';
export type {
  AppendObservedRevisionInput,
  ObservationProducerHeartbeatRow,
  ObservationSeenCursorRow,
  ObservationWatchEntryRow,
  ObservedObjectRow,
  ObservedRevisionRow,
} from '@/modules/database/repositories/observation/observation.repository.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notifications/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notifications/notification-preferences.js';
// noticeDismissalsDb: used by the notices registry to persist which revision of a notice each
// user dismissed, so the same dismissal holds on every device (N5).
export { noticeDismissalsDb } from '@/modules/database/repositories/notifications/notice-dismissals.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/providers/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/sessions/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/notifications/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/observation/scan-state.db.js';
// sessionDraftsDb: used by User for drafts and Scheduled Messages for server-owned queued turns.
export { sessionDraftsDb } from '@/modules/database/repositories/sessions/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/sessions/session-drafts.db.js';
export {
  isSelfAssignedSessionName,
  sessionsDb,
  stripSelfAssignedSuffix,
} from '@/modules/database/repositories/sessions/sessions.db.js';
export type {
  SessionNameHiddenByFilterJson,
  SessionNameSource,
  SessionNameVisibility,
} from '@/modules/database/repositories/sessions/sessions.db.js';
// providerSessionBindingDb: the provider-session binding writes, split out of
// sessions.db.ts. Consumed by the session-binding service below (the run
// discovery guard and the Codex edit fork/restart); no other module writes the
// binding pair directly.
export { providerSessionBindingDb } from '@/modules/database/repositories/sessions/session-binding.db.js';
export type {
  ProviderSessionBindingOutcome,
  ProviderSessionBindingRecovery,
} from '@/modules/database/repositories/sessions/session-binding.db.js';
// sessionBindingService: the single application entry for a session's
// provider-native binding. Used by the websocket module's chat run registry to
// record what an ordinary run announced (without letting a late run overwrite
// an edit's new binding) and by the Codex sessions provider for edit
// fork/restart, which are the only writes allowed to replace it.
export {
  createSessionBindingService,
  sessionBindingService,
} from '@/modules/database/session-binding.service.js';
export type {
  SessionBindingService,
  SessionBindingServiceDeps,
} from '@/modules/database/session-binding.service.js';
// uiLastOpenedDb: used by the providers module to record the session the browser
// last opened, and by the MCP gateway (through that service) to answer
// `ui_last_opened_session`.
export { uiLastOpenedDb } from '@/modules/database/repositories/sessions/ui-last-opened.db.js';
export type { UiLastOpenedRecord } from '@/modules/database/repositories/sessions/ui-last-opened.db.js';
export { userDb } from '@/modules/database/repositories/auth/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/auth/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/notifications/vapid-keys.js';
// voiceSettingsDb: used by the Voice module to serve the per-user voice backend settings that used to live in browser localStorage.
export { voiceSettingsDb } from '@/modules/database/repositories/providers/voice-settings.db.js';
// voiceUserIdentifiersDb: used by the Voice module's U-source lexicon to persist the identifier-shaped tokens the user has sent, with their frequencies.
export { voiceUserIdentifiersDb } from '@/modules/database/repositories/providers/voice-user-identifiers.db.js';
export { scheduledMessagesDb } from './repositories/sessions/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/sessions/scheduled-messages.db.js';
// goalsDb: the goals module's store — a goal, its acceptance criteria, one row
// per loop round and one row per criterion run. It lives in its own `goals`
// subpackage because a goal belongs to the project domain, not to sessions.
export { goalsDb } from './repositories/goals/goals.db.js';
export type {
  GoalAcRow,
  GoalEvidenceRow,
  GoalRow,
  GoalRoundRow,
} from './repositories/goals/goals.db.js';
