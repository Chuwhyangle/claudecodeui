/**
 * The API-latency module's composition root.
 *
 * One probe, one store, one router. Hydration is fired here rather than awaited
 * so `server/index.ts` keeps its synchronous assembly; a missing or empty JSONL
 * simply leaves the page with no history until the first probe runs.
 *
 * The module is a LEAF: it imports `server/shared/**` and itself only, and the
 * composition root injects nothing feature-specific — the gateway it measures is
 * read from the deployment's own configuration. That is what keeps it off the
 * import-cycle manifest's non-leaf list.
 *
 * Consumers: `server/index.ts`, which mounts the returned router under
 * `/api/api-latency` behind `authenticateToken`, and the module criterion, which
 * assembles it over a temp store and a fake probe.
 */
import type { Router } from 'express';

import { createApiLatencyProbe, type ApiLatencyProbe } from './api-latency-probe.service.js';
import { createApiLatencyRoutes, type ApiLatencyGatewayResolver } from './api-latency.routes.js';
import { createApiLatencyStore, type ApiLatencyStore } from './api-latency-store.service.js';

/**
 * The seams a caller may replace.
 *
 * `resolveTarget` exists for criteria: without it the routes would read the
 * developer's own `~/.claude/settings.json`, which a test must never depend on.
 */
export type ApiLatencyModuleOptions = {
  probe?: ApiLatencyProbe;
  store?: ApiLatencyStore;
  resolveTarget?: ApiLatencyGatewayResolver;
};

/**
 * Build the module.
 *
 * Consumers: `server/index.ts` only.
 */
export function createApiLatencyModule(options: ApiLatencyModuleOptions = {}) {
  const store = options.store ?? createApiLatencyStore();
  const probe = options.probe ?? createApiLatencyProbe();
  // Fire-and-forget: the store answers an empty list until the file is read, and
  // `hydrate` never rejects (a torn line is skipped, a missing file is []).
  void store.hydrate();

  return {
    router: createApiLatencyRoutes({
      probe,
      store,
      ...(options.resolveTarget === undefined ? {} : { resolveTarget: options.resolveTarget }),
    }),
  };
}
