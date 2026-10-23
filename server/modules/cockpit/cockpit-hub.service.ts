/**
 * The cockpit hub: one in-memory cockpit state per signed-in user, shared by every device
 * that has announced itself for that user.
 *
 * WHY THE SERVER HOLDS IT. A desktop browser cannot be the input device: global hotkeys and
 * keys pressed while its window is in the background never reach the page. So the input moves
 * to a device that is always in hand (a phone first), and the desktop becomes a display. That
 * split only works if neither device owns the state — the hub does, and both are subscribers.
 *
 * LIFETIME. Exactly the connection set's, like the UI-client registry: the state table is
 * in-memory and disappears with the process. A cockpit about a fleet that has restarted is
 * not worth restoring from a file, and a stale copy would be worse than an empty one.
 *
 * PROTOCOL (all on the existing `/ws` socket):
 *
 *   cockpit.hello  { role: 'display' | 'input', deviceId, deviceName? }
 *   cockpit.event  { event }
 *   cockpit.state  { state }                     — broadcast to every connection of the user
 *
 * A connection may announce both roles (the `/cockpit` page does): the roles accumulate, and a
 * single connection then counts as both a display and an input. Inbound `visible` frames are
 * accepted only from display connections and every other event only from input connections —
 * that is what makes "the input pack is built from the display's set" a structural fact rather
 * than a convention.
 */

import type { AnyRecord, RealtimeClientConnection } from '@/shared/types.js';
import {
  buildCockpitMessageBody,
  classifyCockpitUtterance,
  createCockpitState,
  reduceCockpit,
} from '@/modules/cockpit/cockpit.reducer.js';
import type {
  CockpitEvent,
  CockpitEventSource,
  CockpitFocusable,
  CockpitPendingSend,
  CockpitRole,
  CockpitSendTarget,
  CockpitState,
  CockpitVisibleProject,
} from '@/modules/cockpit/cockpit.reducer.js';

/** The transport's OPEN state; the websocket module's constant is not importable from a leaf. */
const WS_OPEN_STATE = 1;

/**
 * What the hub can do outside itself. Both are injected by the composition root, so this
 * module stays a leaf: it never imports the session-send or fleet-registry modules.
 */
export type CockpitHubDeps = {
  /**
   * Resolves where an unmatched phrase would go: the project's pinned interface session
   * first, then the browser's last-opened session, otherwise none. `null` is an answer —
   * the pending card says nothing will be sent — never an error to propagate.
   */
  resolveTarget?: (
    state: CockpitState,
  ) => Promise<{ target: CockpitSendTarget | null; reason: CockpitPendingSend['reason'] }>;
  /** Sends a confirmed message through the existing session-send service. */
  send?: (userId: string, message: { sessionId: string; content: string }) => void | Promise<void>;
};

/** One connection's announced identity for the cockpit. */
type HubParticipant = {
  userId: string;
  deviceId: string;
  deviceName: string;
  roles: Set<CockpitRole>;
};

/** The hub's surface: the two inbound frame handlers, the close hook, and a test read port. */
export type CockpitHub = {
  /** Records one `cockpit.hello`; false when the announcement is unusable. */
  hello(connection: RealtimeClientConnection, userId: string | number | null, frame: unknown): boolean;
  /**
   * Applies one `cockpit.event` and broadcasts the new state to the user's connections.
   * Returns false when the frame is unusable or the connection never announced itself.
   */
  handleEvent(
    connection: RealtimeClientConnection,
    userId: string | number | null,
    frame: unknown,
  ): Promise<boolean>;
  /** Forgets a connection; a user's state survives until the process ends. */
  disconnect(connection: RealtimeClientConnection): void;
  /** The current state for one user, or null before anything has connected. */
  getState(userId: string | number | null): CockpitState | null;
};

/** A bounded identifier: the same ceiling the UI-client registry applies to client text. */
const CLIENT_ID_MAX_LENGTH = 128;
/** Longest retained device name, measured after trimming. */
const DEVICE_NAME_MAX_LENGTH = 64;

function readIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > CLIENT_ID_MAX_LENGTH ? null : trimmed;
}

function readDeviceName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > DEVICE_NAME_MAX_LENGTH
    ? trimmed.slice(0, DEVICE_NAME_MAX_LENGTH)
    : trimmed;
}

/** The user key, or null when the socket was never authenticated. */
function userKey(userId: string | number | null): string | null {
  if (userId === null || userId === undefined) return null;
  const key = `${userId}`.trim();
  return key === '' ? null : key;
}

/** Reads the roles an event-typed value may use; anything else is not an event. */
function readEvent(frame: unknown): CockpitEvent | null {
  if (frame === null || typeof frame !== 'object') return null;
  const record = frame as AnyRecord;
  if (record.type !== 'cockpit.event') return null;
  const event = record.event;
  if (event === null || typeof event !== 'object') return null;
  const candidate = event as AnyRecord;
  return typeof candidate.type === 'string' ? (candidate as CockpitEvent) : null;
}

/** Builds a hub over the injected seams. Production uses {@link createCockpitModule}. */
export function createCockpitHub(deps: CockpitHubDeps = {}): CockpitHub {
  const participants = new Map<RealtimeClientConnection, HubParticipant>();
  const states = new Map<string, CockpitState>();

  const stateFor = (key: string): CockpitState => {
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const created = createCockpitState();
    states.set(key, created);
    return created;
  };

  const write = (connection: RealtimeClientConnection, frame: unknown): void => {
    if (connection.readyState !== WS_OPEN_STATE) return;
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      // A socket that fails here is one the close path is already handling.
    }
  };

  const broadcast = (key: string, state: CockpitState): void => {
    for (const [connection, participant] of participants) {
      if (participant.userId === key) {
        write(connection, { kind: 'cockpit.state', state });
      }
    }
  };

  return {
    hello(connection, userId, frame) {
      const key = userKey(userId);
      if (key === null || frame === null || typeof frame !== 'object') return false;
      const record = frame as AnyRecord;
      if (record.type !== 'cockpit.hello') return false;
      const role = record.role === 'display' ? 'display' : record.role === 'input' ? 'input' : null;
      const deviceId = readIdentifier(record.deviceId);
      if (role === null || deviceId === null) return false;

      const previous = participants.get(connection);
      const roles = new Set<CockpitRole>(previous?.roles ?? []);
      roles.add(role);
      participants.set(connection, {
        userId: key,
        deviceId,
        deviceName: readDeviceName(record.deviceName) || previous?.deviceName || deviceId,
        roles,
      });
      // The joiner starts from the current state rather than an empty stage.
      write(connection, { kind: 'cockpit.state', state: stateFor(key) });
      return true;
    },

    async handleEvent(connection, userId, frame) {
      const key = userKey(userId);
      const participant = participants.get(connection);
      const event = readEvent(frame);
      if (key === null || participant === undefined || participant.userId !== key || event === null) {
        return false;
      }
      // Role discipline: only a display may report visibility; only an input may act.
      if (event.type === 'visible' ? !participant.roles.has('display') : !participant.roles.has('input')) {
        return false;
      }

      const source: CockpitEventSource = {
        deviceId: participant.deviceId,
        deviceName: participant.deviceName,
        role: event.type === 'visible' ? 'display' : 'input',
      };
      let sourced = { ...event, source } as CockpitEvent;
      if (sourced.type === 'visible') {
        // A report crosses a trust boundary: only the fields the stage declares are copied.
        const raw = sourced as unknown as AnyRecord;
        sourced = {
          ...sourced,
          focusables: readFocusables(raw.focusables),
          projects: readVisibleProjects(raw.projects),
        };
      }
      let state = stateFor(key);

      if (sourced.type === 'utterance') {
        // The target lookup is the only I/O; it is awaited BEFORE reducing, so the pending
        // card is born with its destination (or with an honest reason it has none).
        let target: CockpitSendTarget | null = null;
        let reason: CockpitPendingSend['reason'] = state.focusUri === null ? 'no-focus' : 'no-session';
        if (classifyCockpitUtterance(state, sourced.text).kind === 'unmatched' && deps.resolveTarget) {
          try {
            const resolved = await deps.resolveTarget(state);
            target = resolved.target;
            reason = resolved.target === null ? resolved.reason : null;
          } catch {
            target = null;
            reason = 'no-session';
          }
        }
        // Re-read after the await: another event may have landed while the lookup ran.
        state = stateFor(key);
        const next = reduceCockpit(state, { ...sourced, target, reason });
        states.set(key, next);
        broadcast(key, next);
        return true;
      }

      if (sourced.type === 'confirm') {
        // Capture the card, then close it BEFORE any await: a duplicate confirm reaches a
        // reducer with `pendingSend === null` and sends nothing. That is "exactly once".
        const pending = state.pendingSend;
        const next = reduceCockpit(state, sourced);
        states.set(key, next);
        broadcast(key, next);
        if (pending?.target != null && deps.send) {
          try {
            await deps.send(key, {
              sessionId: pending.target.sessionId,
              content: buildCockpitMessageBody(pending),
            });
          } catch (error) {
            console.error('[Cockpit] Confirmed send failed', {
              sessionId: pending.target.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return true;
      }

      state = stateFor(key);
      const next = reduceCockpit(state, sourced);
      states.set(key, next);
      broadcast(key, next);
      return true;
    },

    disconnect(connection) {
      participants.delete(connection);
    },

    getState(userId) {
      const key = userKey(userId);
      return key === null ? null : states.get(key) ?? null;
    },
  };
}

/** Reads a display's focusable declaration, dropping anything that is not the declared triple. */
function readFocusables(value: unknown): CockpitFocusable[] {
  if (!Array.isArray(value)) return [];
  const objects: CockpitFocusable[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as AnyRecord;
    const display = record.display;
    if (typeof record.uri !== 'string' || typeof record.label !== 'string') continue;
    if (display === null || typeof display !== 'object') continue;
    const displayRecord = display as AnyRecord;
    const pos = displayRecord.pos;
    if (pos === null || typeof pos !== 'object') continue;
    const posRecord = pos as AnyRecord;
    const row = typeof posRecord.row === 'number' ? posRecord.row : Number.NaN;
    const column = typeof posRecord.column === 'number' ? posRecord.column : Number.NaN;
    if (!Number.isFinite(row) || !Number.isFinite(column)) continue;
    objects.push({
      uri: record.uri,
      label: record.label,
      display: {
        status: typeof displayRecord.status === 'string' ? displayRecord.status : '',
        color: typeof displayRecord.color === 'string' ? displayRecord.color : '',
        ordinal:
          typeof displayRecord.ordinal === 'number' && Number.isFinite(displayRecord.ordinal)
            ? displayRecord.ordinal
            : objects.length + 1,
        pos: { row, column },
      },
    });
  }
  return objects;
}

/** Reads the projects a `visible` frame carried, dropping anything malformed. */
function readVisibleProjects(value: unknown): CockpitVisibleProject[] {
  if (!Array.isArray(value)) return [];
  const projects: CockpitVisibleProject[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as AnyRecord;
    if (typeof record.projectId !== 'string' || record.projectId === '') continue;
    projects.push({
      projectId: record.projectId,
      fleetProjectId: typeof record.fleetProjectId === 'string' ? record.fleetProjectId : null,
      name: typeof record.name === 'string' ? record.name : record.projectId,
      projectPath: typeof record.projectPath === 'string' ? record.projectPath : '',
    });
  }
  return projects;
}
