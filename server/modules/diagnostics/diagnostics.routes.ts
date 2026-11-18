/**
 * The diagnostics module's HTTP face.
 *
 * Five read-only routes live under `/api/diagnostics`, mounted behind the same
 * `authenticateToken` as every other API surface by `server/index.ts`:
 *
 *   · `GET /features`                 → `{ features: [...] }` (JSON, redacted)
 *   · `GET /recent-failures?limit=50` → `{ failures: [...] }` (JSON, redacted, newest first)
 *   · `GET /bundle`                   → `text/plain; charset=utf-8` (redacted)
 *   · `GET /logs/sources`             → `{ sources: [{id,label,count,lastAt}] }` (JSON)
 *   · `GET /logs?source=&level=&since=&limit=` → `{ lines, truncated, window }` (JSON)
 *
 * THERE IS NO PATH OR FILENAME PARAMETER. The failure list's only input is
 * `limit`, which is clamped to `[1, 200]` here (and again in the service, which
 * may be driven directly). A non-numeric value takes the default; a negative or
 * zero value is raised to one. The log routes accept only `source`, `level`,
 * `since` and `limit`; a malformed `level`/`since` is a 400 and an unknown
 * source matches nothing.
 *
 * Consumers: `diagnostics.module.ts` only; the barrel exposes the composed
 * module, not this factory.
 */
import express, { type Router } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { DiagnosticsLogsReader } from './diagnostics-logs.js';
import { readLogsQuery } from './diagnostics-logs.js';
import { clampRecentFailuresLimit, DEFAULT_RECENT_FAILURES_LIMIT } from './diagnostics.service.js';
import type { DiagnosticsFailure, DiagnosticsFeature } from './diagnostics.service.js';

/** The reads the route factory drives; `bundle` already renders the document. */
export type DiagnosticsRoutesService = {
  features: () => DiagnosticsFeature[];
  recentFailures: (limit: number) => DiagnosticsFailure[];
  bundle: () => string;
  logs: DiagnosticsLogsReader;
};

/**
 * Reads `?limit=` into the service's bounded range. Exported so the route
 * criterion can pin the clamping without an HTTP round trip.
 *
 * Consumers: this file's route and the route criterion.
 */
export function readRecentFailuresLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_RECENT_FAILURES_LIMIT;
  return clampRecentFailuresLimit(parsed);
}

/**
 * Build the router over one assembled service.
 *
 * Consumers: `diagnostics.module.ts` only.
 */
export function createDiagnosticsRoutes(service: DiagnosticsRoutesService): Router {
  const router = express.Router();

  // Every answer is a live reading; a cached page would report a stale failure.
  router.get(
    '/features',
    asyncHandler(async (_request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.json({ features: service.features() });
    }),
  );

  router.get(
    '/recent-failures',
    asyncHandler(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.json({ failures: service.recentFailures(readRecentFailuresLimit(request.query.limit)) });
    }),
  );

  router.get(
    '/bundle',
    asyncHandler(async (_request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.send(service.bundle());
    }),
  );

  // The source roster: every known tab, its live count and newest line. The
  // roster is stable even when a source has produced nothing yet.
  router.get(
    '/logs/sources',
    asyncHandler(async (_request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.json({ sources: service.logs.sources() });
    }),
  );

  // The bounded window. `readLogsQuery` parses and validates the four supported
  // parameters; it throws an `AppError(400)` for a malformed level/since.
  router.get(
    '/logs',
    asyncHandler(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.json(service.logs.read(readLogsQuery(request.query as Record<string, unknown>)));
    }),
  );

  return router;
}
