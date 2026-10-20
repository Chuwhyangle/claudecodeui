/**
 * The neutral accessor for "how many browsers are connected right now".
 *
 * WHY THIS FILE EXISTS. `modules/providers/list/claude/claude.provider.ts`
 * supplied the resident driver's `connectedClientCount` callback directly from
 * the websocket module's `connectedClients` set. That is a
 * `providers/list/claude -> websocket/services` edge, and the websocket services
 * import the providers module — the loop this task breaks. The driver's own
 * contract already takes the count as a PORT (`connectedClientCount`), and its
 * default is "nobody is watching"; only the production wiring needs the real
 * set. Installing the reader here lets the production composition root supply
 * it without the providers module importing websocket code.
 *
 * The count is read at CALL time, not captured: a resident turn can outlive the
 * page that opened it, and the whole point of the reading is that nobody is
 * watching *now*. An uninstalled port therefore answers 0 — the same
 * conservative reading the driver's own default takes, which means a criterion
 * that imports the provider graph without the websocket module keeps the
 * "nobody is watching" arm rather than failing.
 *
 * Consumers: `modules/providers/list/claude/claude.provider.ts` (the driver's
 * callback) and `modules/websocket/services/websocket-state.service.ts` (the
 * owner of the set, which installs the reader). This file imports nothing.
 */

/**
 * The one verb consumers need: the current browser connection count.
 *
 * Deliberately not the `Set` itself. Exposing the mutable set across modules
 * would let a caller add or delete connections it does not own; a read-only
 * count is the whole requirement.
 */
export type ConnectedClientsPort = {
  count(): number;
};

/** The installed reader, or null before the websocket state module evaluates. */
let installedConnectedClients: ConnectedClientsPort | null = null;

/**
 * Installs the process's connected-client reader.
 *
 * Called by `websocket-state.service.ts` next to the `connectedClients` set it
 * reads, and by `server/index.ts`. Re-installing the same object is a no-op.
 */
export function installConnectedClientsPort(port: ConnectedClientsPort): void {
  installedConnectedClients = port;
}

/**
 * Reads the current browser connection count.
 *
 * Zero when no websocket state module has been loaded in this process — the
 * driver's own default, and the honest reading of a process with no browser
 * connections registered.
 */
export function readConnectedClientCount(): number {
  return installedConnectedClients?.count() ?? 0;
}
