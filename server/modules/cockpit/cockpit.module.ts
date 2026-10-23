/**
 * The cockpit module's composition entry: the hub wired to the two seams it cannot own.
 *
 * `server/index.ts` builds this ONCE and hands the returned hub to the websocket gateway; the
 * hub is then the process-wide cockpit state, the same way the UI-client registry is the
 * process-wide device listing. The seams live at the composition root because the hub is a
 * leaf: it must not import the session-send or fleet-registry modules (AC-394 keeps new
 * feature directories as leaves), so those are injected instead of reached.
 */

import { createCockpitHub } from '@/modules/cockpit/cockpit-hub.service.js';
import type { CockpitHub, CockpitHubDeps } from '@/modules/cockpit/cockpit-hub.service.js';

/** Everything the composition root can supply to the cockpit hub. */
export type CockpitModuleDeps = CockpitHubDeps;

/**
 * Builds the process-wide cockpit hub. Consumed by `server/index.ts`, which binds the target
 * lookup to the fleet registry + last-opened pointer and the send to the shared chat control
 * service, then hands the hub to `createWebSocketServer`.
 */
export function createCockpitModule(deps: CockpitModuleDeps = {}): CockpitHub {
  return createCockpitHub(deps);
}
