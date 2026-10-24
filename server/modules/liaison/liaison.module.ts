/**
 * The liaison module's composition entry and HTTP face.
 *
 * `server/index.ts` builds this ONCE per process and mounts the returned router under
 * `/api/liaison`. Everything the module needs from its neighbours is injected — the fleet CLI
 * runner, the host registry's liveness read, and the existing chat control service — so
 * `modules/liaison` imports no sibling feature module and stays a registered leaf in AC-394's
 * directory manifest.
 *
 * The HTTP face is the delivery entry point a session uses:
 *
 *   POST /api/liaison/deliver     { initiative, project, from, message, deliveryId? }
 *   GET  /api/liaison/deliveries  every attempt, oldest first (who / when / which initiative / result)
 *   GET  /api/liaison/inbox       messages still queued for a liaison session that is not live
 *
 * The routes only parse transport input and map the service's outcome onto a status; every
 * decision (resolved / dead / ambiguous / unavailable) is the service's.
 *
 * Consumers: `server/index.ts` (mounts the router and forwards host-registry recoveries),
 * and `tests/liaison-deliver.test.ts`.
 */

import { execFile } from 'node:child_process';

import express, { type Request, type Response, type Router } from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import {
  createLiaisonDeliveryService,
  type LiaisonDeliverDeps,
  type LiaisonDeliveryOutcome,
  type LiaisonDeliveryRecord,
  type LiaisonDeliveryService,
  type LiaisonFleetResult,
  type LiaisonFleetRun,
  type LiaisonInboxEntry,
  type LiaisonRecoveryOutcome,
} from './liaison-deliver.service.js';

/** Bound on one fleet CLI read. The registry document is small; this only bounds a runaway child. */
export const LIAISON_FLEET_TIMEOUT_MS = 10_000;

/** Cap on captured stdout — same reason as the timeout. */
export const LIAISON_FLEET_MAX_OUTPUT_BYTES = 1024 * 1024;

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** The authenticated user's id, or null when the request carries none. */
function callerUserId(req: Request): string | number | null {
  const id = (req as AuthenticatedRequest).user?.id;
  return id === undefined || id === null ? null : id;
}

/** Reads a required non-empty string field from a JSON body. */
function requireString(body: unknown, field: string): string {
  const value = body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[field]
    : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(`\`${field}\` must be a non-empty string`, {
      code: 'INVALID_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

/** The status one delivery outcome answers with. */
function statusFor(outcome: LiaisonDeliveryOutcome): number {
  if (outcome.ok) return 200;
  switch (outcome.code) {
    case 'invalid-request':
      return 400;
    case 'ambiguous-liaison':
      return 409;
    case 'registry-unavailable':
      return 503;
    case 'send-refused':
      return 502;
  }
}

/** The operations the composition root keeps a handle on beside the router. */
export type LiaisonModule = {
  deliver(input: Parameters<LiaisonDeliveryService['deliver']>[0]): Promise<LiaisonDeliveryOutcome>;
  handleSessionRecovered(sessionId: string): Promise<LiaisonRecoveryOutcome>;
  listDeliveries(): LiaisonDeliveryRecord[];
  readInbox(): LiaisonInboxEntry[];
  router: Router;
};

/**
 * The real `quay-fleet` runner.
 *
 * The binary is looked up per call rather than captured at boot, so an operator can install
 * (or re-point `QUAY_FLEET_BIN` at) a fleet without restarting CloudCLI. A missing binary is
 * the ordinary unavailable answer; the caller turns it into the explicit registry error AC2
 * requires rather than a silent drop.
 */
export function createQuayFleetRunner(options: {
  locateBin: () => string | null;
}): LiaisonFleetRun {
  return (args) =>
    new Promise<LiaisonFleetResult>((resolve) => {
      const binPath = options.locateBin();
      if (binPath === null) {
        resolve({
          ok: false,
          reason:
            'quay-fleet was not found (checked QUAY_FLEET_BIN, PATH and ~/.quay-fleet/bin/quay-fleet)',
        });
        return;
      }
      execFile(
        binPath,
        [...args],
        { timeout: LIAISON_FLEET_TIMEOUT_MS, maxBuffer: LIAISON_FLEET_MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true },
        (error, stdout) => {
          if (error !== null) {
            const reason = error.killed === true
              ? `quay-fleet timed out: ${error.message}`
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? `quay-fleet was not found: ${binPath}`
                : `quay-fleet failed: ${error.message}`;
            resolve({ ok: false, reason });
            return;
          }
          resolve({ ok: true, stdout: stdout ?? '' });
        },
      );
    });
}

export type LiaisonModuleDeps = LiaisonDeliverDeps;

/**
 * Builds the module. Consumed by `server/index.ts`, and by the criterion over stubbed seams.
 */
export function createLiaisonModule(deps: LiaisonModuleDeps): LiaisonModule {
  const service = createLiaisonDeliveryService(deps);
  const router = express.Router();

  router.post(
    '/deliver',
    asyncHandler(async (req: Request, res: Response) => {
      const input = {
        initiative: requireString(req.body, 'initiative'),
        project: requireString(req.body, 'project'),
        from: requireString(req.body, 'from'),
        message: requireString(req.body, 'message'),
        userId: callerUserId(req),
      };
      const outcome = await service.deliver(input);
      res.status(statusFor(outcome)).json(outcome);
    }),
  );

  router.get('/deliveries', (_req: Request, res: Response) => {
    res.json({ ok: true, deliveries: service.listDeliveries() });
  });

  router.get('/inbox', (_req: Request, res: Response) => {
    res.json({ ok: true, entries: service.readInbox() });
  });

  return {
    deliver: (input) => service.deliver(input),
    handleSessionRecovered: (sessionId) => service.handleSessionRecovered(sessionId),
    listDeliveries: () => service.listDeliveries(),
    readInbox: () => service.readInbox(),
    router,
  };
}
