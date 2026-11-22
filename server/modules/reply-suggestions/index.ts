/**
 * Reply-suggestions module — barrel.
 *
 * TWO production consumers, both through this barrel:
 *   · `server/index.ts`, which builds the module over the providers module's transcript
 *     reader and mounts it under `/api/reply-suggestions`;
 *   · `server/modules/observation/session-digest-llm.ts`, which borrows the same direct-HTTP
 *     client, the same gateway settings reading and the same local usage ledger for the
 *     observation wall's LLM digest tier — one upstream path, not a second copy of it.
 * Nothing else may deep-import this directory.
 */
// consumer: server/index.ts (mounts the router under /api/reply-suggestions)
export { createReplySuggestionsModule } from './reply-suggestions.module.js';
export type { ReplySuggestionsModuleDeps } from './reply-suggestions.module.js';
// consumer: server/index.ts (adapts the shared reading into the diagnostics module's
// feature provider) and the diagnostics service criterion. The reader observes the
// SAME settings source and failure tracker the mounted module uses.
export { createReplySuggestionsDiagnostics } from './reply-suggestions-diagnostics.js';
export type {
  ReplySuggestionsDiagnostics,
  ReplySuggestionsDiagnosticsReading,
} from './reply-suggestions-diagnostics.js';
// consumer: server/index.ts (the one shared failure tracker the mounted module and the
// diagnostics reader both use) and the failure-reading criterion.
export { createReplySuggestionsFailureState } from './reply-suggestions-failure-state.js';
export type { ReplySuggestionsFailureState } from './reply-suggestions-failure-state.js';
// consumer: server/index.ts (types the injected reader's return value)
export type { LastAssistantMessage, RecentConversationMessage } from './reply-suggestions.service.js';
// consumer: tests and features that borrow the completion vocabulary — the
// direct-HTTP client itself now lives on the `modules/llm-gateway` leaf, so these
// names are re-exported from there (through the feature's compatibility shim) and
// this barrel no longer owns an HTTP client of its own.
export { completeReplySuggestions } from './reply-suggestions-client.js';
export type { ReplySuggestionsCompletion, ReplySuggestionsCompletionRequest } from './reply-suggestions-client.js';
// consumer: server/modules/observation/session-digest-llm-settings.ts and
// server/modules/quay/counter-voice-settings.ts (the shared gateway reading they
// merge under their own blocks). The protocol/auth-scheme names now come from the
// gateway leaf, not this barrel.
export { createReplySuggestionsSettingsSource } from './reply-suggestions-settings.js';
export type { ReplySuggestionsSettingsSource } from './reply-suggestions-settings.js';
// consumer: the settings criterion and the observation tier criterion; the class
// itself is the gateway leaf's opaque credential, re-exported from the settings file.
export { ApiCredential } from './reply-suggestions-settings.js';
// consumer: server/index.ts (installs the context-event tap on the usage ledger); the
// observation digest tier and the context-events wiring criterion share the same ledger.
export {
  createReplySuggestionsUsageLog,
  setReplySuggestionsUsageObserver,
} from './reply-suggestions-usage-log.js';
export type {
  ReplySuggestionsUsageLog,
  ReplySuggestionsUsageRecord,
} from './reply-suggestions-usage-log.js';
// consumer: the debug-log criterion and any composition that wants the opt-in ledger. The
// writer's path/rotation policy and the row vocabulary have ONE owner (this leaf).
export {
  createReplySuggestionsDebugLog,
  REPLY_SUGGESTIONS_DEBUG_LOG_FILE_NAME,
  REPLY_SUGGESTIONS_DEBUG_LOG_MAX_BYTES,
  REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS,
} from './reply-suggestions-debug-log.js';
export type {
  ReplySuggestionsDebugAttempt,
  ReplySuggestionsDebugLog,
  ReplySuggestionsDebugOutcome,
  ReplySuggestionsDebugRow,
} from './reply-suggestions-debug-log.js';
