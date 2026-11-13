import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { sessionsDb } from '@/modules/database/index.js';
import {
  ClaudeTokenUsageProvider,
  summarizeClaudeTokenUsage,
} from '@/modules/providers/list/claude/claude-token-usage.provider.js';
import { readProviderRegistryPort } from '@/shared/ports/provider-registry.port.js';
import { resolveModelContextWindowRow } from '@/modules/providers/services/runtime/model-launch-spec.service.js';
import { readTextFileTail } from '@/shared/fs-bytes.js';
import type {
  IProviderTokenUsage,
  ProviderTokenUsageDependencies,
  ProviderTokenUsageReading,
} from '@/shared/interfaces.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';

export { summarizeClaudeTokenUsage };

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/**
 * The service's own dependencies: the facet's injected I/O plus the two
 * lookups only the dispatch performs.
 */
type ProviderTokenUsageServiceDependencies = ProviderTokenUsageDependencies & {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  isProviderSessionSuperseded: (providerSessionId: string, provider: string) => boolean;
};

/**
 * The reader used for a provider that mounts no `tokenUsage` facet.
 *
 * Every `LLMProvider` mounts one; this covers a runtime-registered id (the
 * debug agent) whose transcript reader has always been Claude's.
 */
const defaultTokenUsageReader: IProviderTokenUsage = new ClaudeTokenUsageProvider();

/**
 * The I/O every facet reads through, with the service's production defaults.
 */
const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  readTextFileTail,
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
  getClaudeModelContextWindow: (modelId) => resolveModelContextWindowRow('claude', modelId),
  isProviderSessionSuperseded: (providerSessionId, provider) =>
    sessionsDb.isProviderSessionSuperseded(providerSessionId, provider),
};

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 *
 * The service itself only resolves the session, reports the provider's own
 * "no usage" answer for a superseded session, and hands the read to the
 * provider's `tokenUsage` facet — where the storage actually lives.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<ProviderTokenUsageReading> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The fallback covers rows whose provider id was never recorded, and for
      // a session discovered from disk the app id *is* its provider id. That
      // stops being true the moment an edit rewinds the conversation off a
      // thread: until the replacement run announces its own id, the fallback
      // would resolve the retired transcript and report the discarded
      // conversation's usage against an empty one.
      if (
        !session.provider_session_id
        && dependencies.isProviderSessionSuperseded(sessionId, session.provider)
      ) {
        // A retired transcript's spend is a real zero, so it carries the
        // first-class session shape the `/cost` view reads; no window or
        // occupancy is claimed because no replacement run has announced one.
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          sessionSpend: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          breakdown: { input: 0, output: 0 },
        };
      }

      const reader = readProviderRegistryPort().resolveProvider(session.provider).tokenUsage
        ?? defaultTokenUsageReader;
      return reader.readSessionUsage(session, dependencies);
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
