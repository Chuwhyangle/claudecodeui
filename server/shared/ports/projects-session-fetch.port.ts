/**
 * The neutral accessor for the two collaborators the projects listing service
 * reaches outside its own group for.
 *
 * WHY THIS FILE EXISTS. `modules/projects/services/projects-with-sessions-fetch.service.ts`
 * imported `sessionSynchronizerService` from `modules/providers` and
 * `WS_OPEN_STATE` / `connectedClients` from `modules/websocket`. Those two
 * imports were the projects group's ONLY outgoing edges into the seven-member
 * provider/websocket import cycle: providers/services and websocket/services
 * already import `generateDisplayName` back from `modules/projects`, so the two
 * direct imports made the projects group a member of that cycle instead of the
 * sink its other edges (database, shared, architecture, quay) make it. The
 * listing service needs both capabilities only at CALL time — a request handler
 * asked for a refreshed listing, or a progress tick during a listing — so they
 * can be installed by the composition root rather than imported.
 *
 * The port carries exactly the two verbs the service needs and nothing more:
 *
 *   · `synchronizeSessions` — the provider-wide transcript scan. The service
 *     awaits it before reading the project rows; the real implementation is the
 *     providers module's coalesced synchronizer.
 *   · `broadcast` — send one already-serialised websocket frame to every OPEN
 *     connection. The service keeps building the `loading_progress` frame; the
 *     port owns the iteration and the `readyState` test, because the set and the
 *     open-state constant belong to the websocket module.
 *
 * An uninstalled port is read as a wiring fact, not as an empty result: the
 * broadcast side is a no-op (a process that never assembled the websocket
 * module has no connections to send to — the same reading
 * `connected-clients.port.ts` takes), while the synchronize side raises,
 * because a caller explicitly asked for a refresh and silently serving a stale
 * listing would hide the missing installation. Focused criteria that import the
 * service without the composition root call it with `skipSynchronization: true`,
 * which never reaches that read.
 *
 * Consumers: `modules/projects/services/projects-with-sessions-fetch.service.ts`
 * (reads the port) and `server/index.ts` (the assembly that installs it). This
 * file imports nothing.
 */

/**
 * The one capability pair the projects listing service needs from the provider
 * and websocket modules.
 *
 * Declared structurally rather than as `typeof sessionSynchronizerService` so
 * the shared layer does not name a module-local implementation. `broadcast`
 * takes an already-serialised frame so the service keeps sole ownership of the
 * frame shape (the `kind: 'loading_progress'` envelope).
 */
export type ProjectsSessionFetchPort = {
  /** Runs the provider-wide session scan the listing refresh waits on. */
  synchronizeSessions(): Promise<void>;
  /** Sends one serialised frame to every currently OPEN websocket connection. */
  broadcast(message: string): void;
};

/** The installed port, or null before `server/index.ts` assembles the process. */
let installedProjectsSessionFetch: ProjectsSessionFetchPort | null = null;

/**
 * Installs the process's synchronizer + websocket broadcaster.
 *
 * Called by `server/index.ts` next to the other port installations. Installing
 * the same object twice is a no-op; the last installation wins, which is what a
 * focused criterion that swaps in a fixture wants.
 */
export function installProjectsSessionFetchPort(port: ProjectsSessionFetchPort): void {
  installedProjectsSessionFetch = port;
}

/**
 * Reads the installed port, or null when the composition root has not installed
 * one.
 *
 * Null is left to the caller to interpret: the listing service treats it as
 * "nobody is watching" for the broadcast and as a wiring error for a requested
 * synchronization.
 */
export function readProjectsSessionFetchPort(): ProjectsSessionFetchPort | null {
  return installedProjectsSessionFetch;
}
