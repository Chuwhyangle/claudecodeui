/**
 * Diagnostics module composition root.
 *
 * The module is a LEAF: it imports `server/shared/**` and itself, never a
 * sibling feature module. Every collaborator is injected here by
 * `server/index.ts`:
 *   · `providers` — one adapter per feature (today reply-suggestions), so this
 *     module never deep-imports a feature's internals;
 *   · `meta` — the process facts the bundle states (version, install form,
 *     platform, settings source/path), read from closures the composition root
 *     already owns.
 *
 * Consumers: `server/index.ts`, which mounts the returned router under
 * `/api/diagnostics` behind `authenticateToken`, and the module criterion in
 * `tests/diagnostics-routes.test.ts` (which assembles it over fake providers).
 */
import type { Router } from 'express';

import { renderDiagnosticsBundle } from './diagnostics-bundle.js';
import { createDiagnosticsRoutes } from './diagnostics.routes.js';
import {
  createDiagnosticsService,
  DEFAULT_RECENT_FAILURES_LIMIT,
  type DiagnosticsFeatureProvider,
  type DiagnosticsMeta,
} from './diagnostics.service.js';

/**
 * The seams the process composition root binds.
 *
 * `providers` and `meta` are required: a diagnostics page with no provider
 * cannot report anything, and the process facts have no safe default. `now` and
 * `recentFailuresLimit` exist for criteria.
 *
 * Consumers: `server/index.ts` (through the barrel) and the route criterion.
 */
export type DiagnosticsModuleDeps = {
  providers: DiagnosticsFeatureProvider[];
  meta: () => DiagnosticsMeta;
  recentFailuresLimit?: number;
  now?: () => number;
};

/**
 * Build the module's router over the injected providers.
 *
 * Consumers: `server/index.ts` only.
 */
export function createDiagnosticsModule(deps: DiagnosticsModuleDeps): Router {
  const service = createDiagnosticsService({
    providers: deps.providers,
    meta: deps.meta,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const bundleLimit = deps.recentFailuresLimit ?? DEFAULT_RECENT_FAILURES_LIMIT;

  return createDiagnosticsRoutes({
    features: service.features,
    recentFailures: service.recentFailures,
    bundle: () => renderDiagnosticsBundle(service.bundleInput(bundleLimit)),
  });
}
