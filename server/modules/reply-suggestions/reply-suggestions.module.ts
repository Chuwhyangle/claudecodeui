/**
 * Reply-suggestions module composition root.
 *
 * The module imports no sibling feature module: the transcript reader is
 * injected, and `server/index.ts` — the process's composition root — binds it to
 * the providers module's full-history read. That keeps
 * `modules/reply-suggestions` a leaf in the server import graph (AC-394's
 * ratchet: it may reach `server/shared/**` and itself, nothing else), which is
 * why the new directory needs no entry in the cycle budget's manifest.
 *
 * Consumers: `server/index.ts`, which mounts the returned router under
 * `/api/reply-suggestions` behind `authenticateToken`, and the route criterion
 * in `tests/reply-suggestions-routes.test.ts` (which assembles the module over
 * a fake reader and a fake upstream).
 */
import type { Router } from 'express';

import type { LlmCompletion, LlmCompletionRequest } from '@/modules/llm-gateway/index.js';

import { createReplySuggestionsRoutes } from './reply-suggestions.routes.js';
import type { ReplySuggestionsFailureState } from './reply-suggestions-failure-state.js';
import {
  createReplySuggestionsService,
  type LastAssistantMessage,
} from './reply-suggestions.service.js';
import {
  createReplySuggestionsSettingsSource,
  type ReplySuggestionsSettingsSource,
} from './reply-suggestions-settings.js';
import { createReplySuggestionsUsageLog } from './reply-suggestions-usage-log.js';
import { createReplySuggestionsDebugLog, type ReplySuggestionsDebugLog } from './reply-suggestions-debug-log.js';

/**
 * The seams the process composition root binds.
 *
 * `readLastAssistantMessage` is the providers module's full-history read reduced
 * to the last text-bearing assistant row (or null). Everything else is an
 * override for criteria and for deployments whose local data directory is not
 * the default; production passes only the reader.
 *
 * Consumers: `server/index.ts` (through the barrel) and the route criterion in
 * `tests/reply-suggestions-routes.test.ts`.
 */
export type ReplySuggestionsModuleDeps = {
  readLastAssistantMessage: (sessionId: string) => Promise<LastAssistantMessage | null>;
  settingsPath?: string | null;
  homeDir?: string;
  now?: () => number;
  logger?: (line: string) => void;
  complete?: (request: LlmCompletionRequest) => Promise<LlmCompletion>;
  usageLogPath?: string;
  usageLogMaxBytes?: number;
  /** Overrides for criteria: the opt-in debug ledger's file and size cap. */
  debugLogPath?: string;
  debugLogMaxBytes?: number;
  /** A criterion's recording sink; production uses the writer built from `debugLogPath`. */
  debugLog?: ReplySuggestionsDebugLog;
  /**
   * The settings reader and the failure tracker to share with the diagnostics
   * reader. `server/index.ts` builds one of each and hands the same instances to
   * `createReplySuggestionsDiagnostics`, so the Settings page observes exactly
   * the draws the composer made. Criteria leave them out and get private ones.
   */
  settingsSource?: ReplySuggestionsSettingsSource;
  failureState?: ReplySuggestionsFailureState;
};

/**
 * Build the module's router over the injected reader.
 *
 * The usage ledger's construction (path, size cap, home directory) belongs
 * here, not in the service: the service receives a ready writer.
 *
 * Consumers: `server/index.ts` only.
 */
export function createReplySuggestionsModule(deps: ReplySuggestionsModuleDeps): Router {
  const settings = deps.settingsSource ?? createReplySuggestionsSettingsSource({
    ...(deps.settingsPath === undefined ? {} : { settingsPath: deps.settingsPath }),
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
  });
  const usageLog = createReplySuggestionsUsageLog({
    ...(deps.usageLogPath === undefined ? {} : { filePath: deps.usageLogPath }),
    ...(deps.usageLogMaxBytes === undefined ? {} : { maxBytes: deps.usageLogMaxBytes }),
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
  });
  const debugLog = deps.debugLog ?? createReplySuggestionsDebugLog({
    ...(deps.debugLogPath === undefined ? {} : { filePath: deps.debugLogPath }),
    ...(deps.debugLogMaxBytes === undefined ? {} : { maxBytes: deps.debugLogMaxBytes }),
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  return createReplySuggestionsRoutes(
    createReplySuggestionsService({
      readSettings: () => settings.read(),
      readLastAssistantMessage: deps.readLastAssistantMessage,
      usageLog,
      debugLog,
      writeDebugLog: (enabled) => settings.writeDebugLog(enabled),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.complete === undefined ? {} : { complete: deps.complete }),
      ...(deps.failureState === undefined ? {} : { failureState: deps.failureState }),
    }),
  );
}
