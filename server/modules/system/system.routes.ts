import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type {
  DeployExecutionResult,
  DeployReadinessReading,
} from './deploy-readiness.service.js';
import type { createSystemUpdateService } from './system.service.js';

/** The two reads/writes the deploy strip drives. Structural so a criterion can drive stubs. */
export type DeployReadinessPort = {
  readReadiness(): Promise<DeployReadinessReading>;
  deploy(): Promise<DeployExecutionResult>;
};

/**
 * Creates thin system routes that delegate update and deployment work to their services.
 * Authentication is mounted by the composition root (`server/index.ts`), the same as the other
 * protected `/api/system` routes.
 */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  deployService?: DeployReadinessPort,
): express.Router {
  const router = express.Router();

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  if (deployService !== undefined) {
    router.get(
      '/deploy-readiness',
      asyncHandler(async (_request, response) => {
        response.json(await deployService.readReadiness());
      }),
    );

    // Build first, restart only on success. `busy` is the one conflict: a second click while a
    // build/restart is already in flight must not start a second one.
    router.post(
      '/deploy',
      asyncHandler(async (_request, response) => {
        const result = await deployService.deploy();
        const status = result.ok ? 200 : result.step === 'busy' ? 409 : 500;
        response.status(status).json({
          ...result,
          readiness: await deployService.readReadiness(),
        });
      }),
    );
  }

  return router;
}
