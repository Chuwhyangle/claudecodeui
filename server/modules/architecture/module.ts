/**
 * Architecture module composition root (AC-418).
 *
 * The module deliberately imports no sibling feature module: the project-path
 * lookup and the transcript reader are injected. `server/index.ts` — the
 * process's composition root — binds them to the projects repository and the
 * providers module's full-history reader, which keeps
 * `modules/architecture` a leaf in the server import graph (AC-394's ratchet:
 * it may reach `server/shared/**` and itself, nothing else).
 *
 * Consumers: `server/index.ts`, which mounts the returned router under
 * `/api/architecture` behind `authenticateToken`.
 */
import type { Router } from 'express';

import type { NormalizedMessage } from '@/shared/types.js';

import { createArchitectureRoutes } from './routes.js';
import { createArchitectureService } from './service.js';

/**
 * The two injected readers the module needs.
 *
 * `resolveProjectPath` is a synchronous lookup (the projects repository's
 * indexed SELECT); `readSessionHistory` is the providers module's FULL history
 * read, so the seed extractor sees the whole transcript rather than one page.
 */
export type ArchitectureModuleDeps = {
  readonly resolveProjectPath: (projectId: string) => string | null;
  readonly readSessionHistory: (sessionId: string) => Promise<readonly NormalizedMessage[]>;
};

/**
 * Build the module's router over the injected readers.
 *
 * Consumers: `server/index.ts` only.
 */
export function createArchitectureModule(deps: ArchitectureModuleDeps): Router {
  return createArchitectureRoutes(
    createArchitectureService({
      resolveProjectPath: deps.resolveProjectPath,
      readSessionHistory: deps.readSessionHistory,
    }),
  );
}
