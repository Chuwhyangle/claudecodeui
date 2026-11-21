import { randomUUID } from 'node:crypto';

import type {
  RealtimeClientConnection,
  UiClientDevice,
  UiClientTab,
  UiStateRequestTarget,
} from '@/shared/types.js';

/**
 * Which browsers are connected, keyed by the identity they announced.
 *
 * This is the server's answer to "which device is this", which a websocket
 * connection cannot give: the transport id is fresh on every reconnect, while a
 * device keeps one `deviceId` for as long as its site data lives. The registry
 * therefore holds identity *about* a connection rather than deriving it from
 * one, and it holds it in memory only — a device table would be a second source
 * of truth that outlives every reason to have one, and a restart is exactly when
 * that stale copy would be wrong.
 *
 * The lifecycle is the connection's, deliberately:
 *
 *  - a client announces itself once per connection with a `ui.hello` frame, which
 *    is the only thing that creates an entry (`register`);
 *  - the entry is dropped when that connection closes (`unregister`), because
 *    "this device is connected" is only ever a statement about a live socket;
 *  - nothing is polled and nothing is reported on a schedule — the announcement
 *    is the whole input, matching the lazy protocol the MCP tools are built on.
 *
 * Reconnects are the ordinary case, not an error: the browser re-announces the
 * same `deviceId`, so its tabs simply leave and come back.
 */

/**
 * Longest accepted `deviceId` / `tabId`.
 *
 * Both are opaque client-generated strings (a UUID in practice). The bound is
 * not a format check — the server has no business parsing a browser's id — it is
 * a ceiling on how much client text one connection can make the server retain.
 */
export const UI_CLIENT_ID_MAX_LENGTH = 128;

/** Longest retained device name, measured after trimming. */
export const UI_CLIENT_NAME_MAX_LENGTH = 64;

/** One connection's announced identity, as the registry stores it. */
type RegisteredUiClient = {
  /**
   * The server's own handle for this connection, generated here and never
   * published: a caller addresses a device or a tab, and a socket id would be
   * stale the moment the browser reconnects. It stays stable across a repeated
   * `ui.hello` on the same socket, so it names a *connection* rather than a
   * frame.
   */
  connectionId: string;
  deviceId: string;
  tabId: string;
  deviceName: string;
  /** Epoch ms of the first announcement on this connection. */
  connectedAt: number;
};

/** The registry's read port plus the two lifecycle calls the gateway drives. */
export type UiClientRegistry = {
  /**
   * Records the browser identity carried by one `ui.hello` frame.
   *
   * Returns false when the frame is not a usable announcement (`deviceId` /
   * `tabId` missing, not strings, empty, or longer than their bound); the
   * caller drops the frame and the connection is otherwise untouched, because a
   * malformed announcement must not cost a client its socket.
   *
   * A repeated announcement on the same connection updates the name and tab
   * without resetting `connectedAt`, so a tab that re-sends its hello is still
   * the same tab that connected.
   */
  register(connection: RealtimeClientConnection, frame: unknown): boolean;
  /** Forgets whatever `connection` announced; a no-op for a connection that never did. */
  unregister(connection: RealtimeClientConnection): void;
  /**
   * Every connected device, each with its identified tabs.
   *
   * A read-only projection: the caller cannot reach a live socket through it.
   * Order is deterministic (devices by id, tabs oldest connection first) so two
   * calls against an unchanged registry return the same listing.
   */
  listUiClients(): UiClientDevice[];
  /**
   * The live connections behind one device's (or every device's) announced
   * identity, for the UI-state round trip to write to.
   *
   * This is the one port that hands out a SOCKET, and it exists because asking
   * a browser what it is showing is a question only its own connection can
   * carry: `listUiClients` deliberately cannot be used for it. The socket never
   * leaves the server side — the round trip's service writes a frame and
   * discards it — so a caller still addresses a device or a tab, never a
   * connection. Order is deterministic (device id, then oldest connection
   * first) so two reads of an unchanged registry are the same list.
   */
  listUiClientTargets(deviceId?: string): UiStateRequestTarget[];
};

/** A trimmed identifier within its bound, or null when the value is not one. */
function readBoundedIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > UI_CLIENT_ID_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * The device name a frame carries, trimmed and truncated to its bound.
 *
 * An absent or non-string name becomes the empty string rather than dropping the
 * frame: the two ids are what make the announcement addressable, and refusing a
 * connection over a display detail would cost more than a nameless device does.
 */
function readBoundedDeviceName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > UI_CLIENT_NAME_MAX_LENGTH
    ? trimmed.slice(0, UI_CLIENT_NAME_MAX_LENGTH)
    : trimmed;
}

/** Oldest connection first; `tabId` breaks a same-millisecond tie deterministically. */
function compareTabs(left: UiClientTab, right: UiClientTab): number {
  if (left.connectedAt !== right.connectedAt) {
    return left.connectedAt - right.connectedAt;
  }
  return left.tabId < right.tabId ? -1 : left.tabId > right.tabId ? 1 : 0;
}

/**
 * Builds an isolated registry.
 *
 * Production uses the process-wide {@link uiClientRegistry}; the factory exists so
 * a criterion can drive registrations and closes without the previous case's
 * devices still being listed.
 */
export function createUiClientRegistry(): UiClientRegistry {
  // Keyed by the connection object, which is what makes "the socket closed" and
  // "forget this identity" the same operation. A connection that never announces
  // itself is never a key, so the map holds exactly the identified sockets.
  const entries = new Map<RealtimeClientConnection, RegisteredUiClient>();

  return {
    register(connection, frame) {
      if (frame === null || typeof frame !== 'object') {
        return false;
      }

      const announcement = frame as Record<string, unknown>;
      const deviceId = readBoundedIdentifier(announcement.deviceId);
      const tabId = readBoundedIdentifier(announcement.tabId);
      if (deviceId === null || tabId === null) {
        return false;
      }

      const previous = entries.get(connection);
      entries.set(connection, {
        connectionId: previous?.connectionId ?? randomUUID(),
        deviceId,
        tabId,
        deviceName: readBoundedDeviceName(announcement.deviceName),
        connectedAt: previous?.connectedAt ?? Date.now(),
      });
      return true;
    },

    unregister(connection) {
      entries.delete(connection);
    },

    listUiClients() {
      const tabsByDevice = new Map<string, UiClientTab[]>();

      for (const entry of entries.values()) {
        const tab: UiClientTab = {
          tabId: entry.tabId,
          deviceName: entry.deviceName,
          connectedAt: entry.connectedAt,
        };
        const tabs = tabsByDevice.get(entry.deviceId);
        if (tabs) {
          tabs.push(tab);
        } else {
          tabsByDevice.set(entry.deviceId, [tab]);
        }
      }

      return [...tabsByDevice.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([deviceId, tabs]) => {
          const ordered = tabs.slice().sort(compareTabs);
          return {
            deviceId,
            // The newest announcement names the device: a tab that renamed it
            // should be the one the listing reflects, whatever order the other
            // tabs of the same browser were opened in.
            deviceName: ordered[ordered.length - 1].deviceName,
            tabs: ordered,
          };
        });
    },

    listUiClientTargets(deviceId) {
      const wanted = deviceId === undefined ? null : deviceId;
      return [...entries.entries()]
        .filter(([, entry]) => wanted === null || entry.deviceId === wanted)
        .map(([connection, entry]) => ({
          connection,
          deviceId: entry.deviceId,
          tabId: entry.tabId,
          deviceName: entry.deviceName,
          connectedAt: entry.connectedAt,
        }))
        .sort((left, right) =>
          left.deviceId !== right.deviceId
            ? left.deviceId < right.deviceId
              ? -1
              : 1
            : compareTabs(left, right),
        );
    },
  };
}

/** The process-wide registry: one per server run, the one the chat gateway drives. */
export const uiClientRegistry: UiClientRegistry = createUiClientRegistry();

/**
 * Every connected device, from the process-wide registry.
 *
 * This is the read port the MCP tools (`ui_clients_list`, and the `client`
 * parameter of `ui_visible_context` / `ui_open_session`) call.
 */
export const listUiClients = (): UiClientDevice[] => uiClientRegistry.listUiClients();
