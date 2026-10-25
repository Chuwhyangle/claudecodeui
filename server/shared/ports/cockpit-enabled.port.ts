/**
 * The neutral accessor for the cockpit feature switch.
 *
 * WHY THIS FILE EXISTS. The cockpit's dedicated HTTP surfaces live in `modules/quay` and
 * `modules/observation`, and both are composed before `server/index.ts` has read the settings
 * file (`quayRoutes` at module-import time). Importing `modules/settings` from either module
 * would close the `quay -> settings -> mcp-gateway -> quay` loop AC-394 pins. The switch is a
 * boot-time scalar the ONE composition root already holds, so it is installed here and read
 * lazily; every request therefore sees the same value the WebSocket gate and the client's
 * `/api/settings/features` reading see.
 *
 * FAIL CLOSED. An uninstalled port answers `false`: a process that never assembled the
 * composition root (a focused criterion, a display-only mount) is not allowed to expose the
 * experimental feature. A criterion that means to exercise the enabled arm installs a reader
 * of its own.
 *
 * Consumers: `modules/quay/quay.routes.ts` and `modules/observation/observation.routes.ts`
 * (the request-time gates) and `server/index.ts` (the assembly that installs it). This file
 * imports nothing.
 */

/** The installed reader shape: a call-time getter, never a captured value. */
export type CockpitEnabledPort = {
  /** Whether the cockpit is enabled for this process's whole lifetime. */
  readEnabled(): boolean;
};

/** The installed reader, or null before `server/index.ts` assembles the process. */
let installedCockpitEnabled: CockpitEnabledPort | null = null;

/**
 * Installs the process's cockpit switch.
 *
 * Called by `server/index.ts` next to the other port installations, immediately after the
 * settings file is read and before any route can serve a request. The last installation wins
 * so a focused criterion can swap in its own fixture.
 */
export function installCockpitEnabledPort(port: CockpitEnabledPort): void {
  installedCockpitEnabled = port;
}

/**
 * Reads the cockpit switch. `false` before the composition root installs a reader — the safe
 * answer for a release, and the reason no route can expose the cockpit by omission.
 */
export function readCockpitEnabled(): boolean {
  return installedCockpitEnabled?.readEnabled() ?? false;
}
