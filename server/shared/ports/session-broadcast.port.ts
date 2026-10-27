/**
 * The neutral accessor for the websocket module's session-upsert broadcasts.
 *
 * WHY THIS FILE EXISTS. `modules/providers/services/sessions.service.ts` and
 * `modules/providers/services/sessions-watcher.service.ts` imported
 * `broadcastSessionUpserted` / `broadcastSessionUpsertedBatch` from the
 * websocket barrel. Those two imports were the providers group's ONLY outgoing
 * edges into the five-member providers/websocket import cycle, so the group sat
 * IN the cycle even though its other edges — database, shared, projects,
 * session-hosts — point one way. Both capabilities are needed only at CALL time
 * (a fork or rename completed, a debounced watcher flush), so the composition
 * root can install them rather than the services importing them.
 *
 * `session-upsert-broadcast.service.ts` installs the real broadcaster at the
 * bottom of its own module body, and `server/index.ts` names the installation
 * explicitly in the composition root. The services read the port lazily through
 * {@link readSessionBroadcastPort}.
 *
 * An uninstalled port is read as a wiring fact, not as an empty result: a
 * process that never assembled the websocket module has no OPEN connections to
 * announce to, so the broadcast is a no-op — the same reading
 * `connected-clients.port.ts` and the broadcast half of
 * `projects-session-fetch.port.ts` take. Production always installs the real
 * broadcaster, so the fallback never speaks for the product.
 *
 * Consumers: `modules/providers/services/sessions.service.ts` (upserts, renames,
 * forks, and the awaiting-reply snapshot) and
 * `modules/providers/services/sessions-watcher.service.ts` (readers), and
 * `server/index.ts` (the assembly that installs it). Its only import is a type.
 */

import type { AwaitingReplyListItem } from '@/shared/types.js';

/**
 * The two broadcast verbs the providers services need and nothing more.
 *
 * Declared structurally rather than as `typeof broadcastSessionUpserted` so the
 * shared layer does not name a module-local implementation. Their signatures are
 * the websocket services' own, which is what makes the real implementation
 * structurally satisfy this contract with no adapter.
 */
export type SessionBroadcastPort = {
  /** Announces one session's upsert to every currently OPEN connection. */
  broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void>;
  /** Announces a batch of session upserts, walking the client set once for the whole batch. */
  broadcastSessionUpsertedBatch(sessionIds: Iterable<string>): Promise<void>;
  /**
   * Announces the sidebar's full "awaiting reply" snapshot.
   *
   * A snapshot rather than a delta for the reason the event type states: the
   * list is short, and a client that missed a frame simply gets corrected by the
   * next one. Synchronous because the payload is already assembled by the
   * providers service that owns the rows; there is nothing for the broadcaster
   * to read.
   */
  broadcastAwaitingReplyChanged(sessions: AwaitingReplyListItem[]): void;
};

/**
 * The installed broadcaster, or null before composition.
 *
 * A process-wide singleton because the connection set is one:
 * `session-upsert-broadcast.service.ts` reads the same `connectedClients` set the
 * rest of the websocket module writes to.
 */
let installedSessionBroadcast: SessionBroadcastPort | null = null;

/**
 * Installs the process's session-upsert broadcaster.
 *
 * Called by `session-upsert-broadcast.service.ts` at the bottom of its own
 * module body and by `server/index.ts`. Re-installing the same object is a no-op;
 * the last installation wins, which is what a focused criterion that swaps in a
 * fixture wants.
 */
export function installSessionBroadcastPort(port: SessionBroadcastPort): void {
  installedSessionBroadcast = port;
}

/**
 * Reads the installed broadcaster, or null when the composition root has not
 * installed one.
 *
 * Null is left to the caller to interpret. Both readers treat it as "nobody is
 * connected": they are announcing a change, and a process without the websocket
 * module has no client to announce it to. Throwing instead would make merely
 * calling the providers service depend on having loaded the websocket module,
 * which is the ordering coupling this port removes.
 */
export function readSessionBroadcastPort(): SessionBroadcastPort | null {
  return installedSessionBroadcast;
}
