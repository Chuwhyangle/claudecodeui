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

import type { ReplySuggestionsCompletion, ReplySuggestionsCompletionRequest } from './reply-suggestions-client.js';
import { createReplySuggestionsRoutes } from './reply-suggestions.routes.js';
import {
  createReplySuggestionsService,
  type LastAssistantMessage,
} from './reply-suggestions.service.js';
import { createReplySuggestionsSettingsSource } from './reply-suggestions-settings.js';
import { createReplySuggestionsUsageLog } from './reply-suggestions-usage-log.js';

/**
 * The seams the process composition root binds.
 *
 * `readLastAssistantMessage` is the providers module's full-history read reduced
 * to the last text-bearing assistant row (or null). Everything else is an
 * override for criteria and for deployments whose local data directory is not
 * the default; production passes only the reader.
 */
export type ReplySuggestionsModuleDeps = {
  readLastAssistantMessage: (sessionId: string) => Promise<LastAssistantMessage | null>;
  settingsPath?: string | null;
  homeDir?: string;
  now?: () => number;
  logger?: (line: string) => void;
  complete?: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  usageLogPath?: string;
  usageLogMaxBytes?: number;
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
  const settings = createReplySuggestionsSettingsSource({
    ...(deps.settingsPath === undefined ? {} : { settingsPath: deps.settingsPath }),
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
  });
  const usageLog = createReplySuggestionsUsageLog({
    ...(deps.usageLogPath === undefined ? {} : { filePath: deps.usageLogPath }),
    ...(deps.usageLogMaxBytes === undefined ? {} : { maxBytes: deps.usageLogMaxBytes }),
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
  });

  return createReplySuggestionsRoutes(
    createReplySuggestionsService({
      readSettings: () => settings.read(),
      readLastAssistantMessage: deps.readLastAssistantMessage,
      usageLog,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.complete === undefined ? {} : { complete: deps.complete }),
    }),
  );
}
