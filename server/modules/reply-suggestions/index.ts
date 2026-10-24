/**
 * Reply-suggestions module — barrel.
 *
 * The only production consumer is `server/index.ts`, which builds the module over
 * the providers module's transcript reader and mounts it under
 * `/api/reply-suggestions`. Nothing else may deep-import this directory.
 */
// consumer: server/index.ts (mounts the router under /api/reply-suggestions)
export { createReplySuggestionsModule } from './reply-suggestions.module.js';
export type { ReplySuggestionsModuleDeps } from './reply-suggestions.module.js';
// consumer: server/index.ts (types the injected reader's return value)
export type { LastAssistantMessage } from './reply-suggestions.service.js';
