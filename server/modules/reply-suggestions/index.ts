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
// consumer: server/index.ts (types the injected reader's return value)
export type { LastAssistantMessage } from './reply-suggestions.service.js';
// consumer: server/modules/observation/session-digest-llm.ts (the completion call and its
// request/answer types; the client keeps the key out of every error it throws)
export { completeReplySuggestions, replySuggestionsEndpoint, ReplySuggestionsClientError } from './reply-suggestions-client.js';
export type {
  ReplySuggestionsClientConfig,
  ReplySuggestionsClientErrorCategory,
  ReplySuggestionsCompletion,
  ReplySuggestionsCompletionRequest,
} from './reply-suggestions-client.js';
// consumer: server/modules/observation/session-digest-llm-settings.ts (the gateway reading it
// merges under its own `observation.sessionDigest` block)
export { createReplySuggestionsSettingsSource, REPLY_SUGGESTIONS_SETTINGS_PATH_ENV } from './reply-suggestions-settings.js';
export type {
  ReplySuggestionsAuthScheme,
  ReplySuggestionsProtocol,
  ReplySuggestionsSettings,
  ReplySuggestionsSettingsSource,
} from './reply-suggestions-settings.js';
// consumer: server/modules/observation/session-digest-llm.ts (one usage record per digest
// call, written to the same locally-owned JSONL ledger the chips use)
export {
  createReplySuggestionsUsageLog,
  REPLY_SUGGESTIONS_USAGE_LOG_MAX_BYTES,
} from './reply-suggestions-usage-log.js';
export type {
  ReplySuggestionsUsageLog,
  ReplySuggestionsUsageRecord,
} from './reply-suggestions-usage-log.js';
