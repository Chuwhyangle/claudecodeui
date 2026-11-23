/**
 * The API-speed page's HTTP face.
 *
 *   GET  /api/api-latency/series?limit=N — the recent probes plus the resolved gateway
 *   GET  /api/api-latency/target        — only the gateway the probe would use
 *   POST /api/api-latency/probe         — take one measurement now, store it, answer it
 *
 * The routes parse and bound the caller's input and hand it to the probe; the
 * socket work, the stage arithmetic and the disk mirror all live in the services.
 * `POST /probe` deliberately has no session or project scope: it measures THIS
 * MACHINE's link to the gateway, not one conversation.
 *
 * THE ANSWERS ARE BARE JSON, not a `{ success, data }` envelope: the browser's
 * hook reads the object directly, and a probe result is a reading rather than a
 * command result. The only envelope is the 400 a malformed request gets, which
 * carries `{ error }` for the client to surface.
 *
 * THE CREDENTIAL NEVER CROSSES THIS BOUNDARY. `readTarget` drops the token from
 * the resolved gateway before it is serialized, so neither `series` nor `target`
 * can leak it however the resolver is injected.
 *
 * Consumers: `api-latency.module.ts` and the routes criterion.
 */
import express, { type Router } from 'express';

import { asyncHandler } from '@/shared/utils.js';
import type {
  ApiLatencyGatewayTarget,
  ApiLatencyProbeMode,
  ApiLatencySeries,
  ResolvedApiLatencyGateway,
} from '@/shared/types.js';

import type { ApiLatencyProbe, ApiLatencyProbeInput } from './api-latency-probe.service.js';
import { MAX_UPLOAD_BYTES } from './api-latency-probe-stages.js';
import { resolveApiLatencyGateway } from './api-latency-settings.service.js';
import type { ApiLatencyStore } from './api-latency-store.service.js';

/** The gateway resolver the routes drive; injectable so a criterion reads no real home. */
export type ApiLatencyGatewayResolver = () => Promise<ResolvedApiLatencyGateway>;

/** What the router is built over. */
export type ApiLatencyRoutesDeps = {
  probe: ApiLatencyProbe;
  store: ApiLatencyStore;
  /** Injected by criteria so the routes never read the developer's own settings. */
  resolveTarget?: ApiLatencyGatewayResolver;
};

/** `?limit=` → a positive integer count, or `undefined` when absent/malformed. */
export function readSeriesLimit(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = typeof value === 'string' || typeof value === 'number'
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseMode(value: unknown): ApiLatencyProbeMode | null {
  if (value === undefined || value === null) return 'ping';
  return value === 'ping' || value === 'upload' ? value : null;
}

/** `stream` defaults to true; only an explicit `false` turns it off. */
function parseStream(value: unknown): boolean {
  return value !== false;
}

/** `uploadBytes` is clamped to the probe's own ceiling, never trusted as sent. */
function parseUploadBytes(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.floor(value), MAX_UPLOAD_BYTES);
}

/**
 * The browser-safe half of the resolved gateway. Exported so the criterion can
 * pin the removal without an HTTP round trip.
 */
export function toGatewayTarget(resolved: ResolvedApiLatencyGateway): ApiLatencyGatewayTarget {
  const { token: _token, ...target } = resolved;
  return target;
}

/**
 * Turn a request body into the probe's typed input, or the reason it is refused.
 *
 * Exported alongside the router so a criterion can pin the bound (`mode`,
 * `uploadBytes`, `model`) without standing up HTTP.
 */
export function parseProbeRequest(
  body: unknown,
): { input: ApiLatencyProbeInput } | { error: string } {
  const record = (body ?? {}) as Record<string, unknown>;
  const mode = parseMode(record.mode);
  if (mode === null) return { error: "mode must be 'ping' or 'upload'" };

  const uploadBytes = parseUploadBytes(record.uploadBytes);
  if (uploadBytes === null) return { error: 'uploadBytes must be a positive number' };

  if (record.model !== undefined && typeof record.model !== 'string') {
    return { error: 'model must be a string' };
  }

  const model = typeof record.model === 'string' ? record.model.trim() : '';
  return {
    input: {
      mode,
      stream: parseStream(record.stream),
      ...(model === '' ? {} : { model }),
      ...(uploadBytes === undefined ? {} : { uploadBytes }),
    },
  };
}

/**
 * Build the router over one probe and one store.
 *
 * Consumers: `api-latency.module.ts` only.
 */
export function createApiLatencyRoutes(deps: ApiLatencyRoutesDeps): Router {
  const resolveTarget = deps.resolveTarget ?? (() => resolveApiLatencyGateway());
  const router = express.Router();

  // A live reading on every request: a cached series would describe a gateway the
  // operator already switched away from.
  router.get(
    '/series',
    asyncHandler(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const target = toGatewayTarget(await resolveTarget());
      const series: ApiLatencySeries = {
        target,
        probes: deps.store.list(readSeriesLimit(request.query.limit)),
      };
      response.json(series);
    }),
  );

  router.get(
    '/target',
    asyncHandler(async (_request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.json(toGatewayTarget(await resolveTarget()));
    }),
  );

  router.post(
    '/probe',
    asyncHandler(async (request, response) => {
      const parsed = parseProbeRequest(request.body);
      if ('error' in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const result = await deps.probe(parsed.input);
      await deps.store.append(result);
      response.json(result);
    }),
  );

  return router;
}
