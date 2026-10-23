import { useCallback, useEffect, useMemo, useState } from 'react';

import { useWebSocketOptional } from '@/shared/context/WebSocketContext';
import type {
  CockpitEventSource,
  CockpitHubEvent,
  CockpitHubState,
  CockpitVisibleSet,
} from '@/shared/types';
import { readDeviceName } from '@/shared/userSettings';
import { getDeviceId, getTabId } from '@/shared/utils/deviceIdentity';

/**
 * The cockpit's subscription to the server-side hub.
 *
 * WHY A HOOK AND NOT PAGE STATE. The cockpit is driven from more than one device: the desktop
 * showing the stage cannot receive global keys or background-window input, so a phone (and
 * later a desktop background process) supplies the input. Focus, view, tray and the
 * confirmation card therefore live in ONE server-side state that every device subscribes to.
 * This hook announces both roles on the shared socket, sends events, and renders whatever
 * state the server last broadcast — it never keeps a second copy of the transitions.
 *
 * WHAT IT DOES NOT DO. It does not apply events locally. A key press sends a `move` event and
 * the stage waits for the hub's `cockpit.state` back; that is what makes the two devices agree
 * by construction, and it is why this hook holds no reducer.
 */

/** What a page sees: the hub's state plus the two outbound verbs. */
export type CockpitHubConnection = {
  /** The last state the server broadcast (or the initial empty stage before the first frame). */
  state: CockpitHubState;
  /** True while the shared websocket reports itself connected. */
  connected: boolean;
  /** Sends one action event; the hub stamps the source identity. */
  dispatch: (event: CockpitHubEvent) => void;
  /**
   * Reports what this page is showing — the view address, its declared focusable objects and
   * the project roster. Only a display's report feeds the hub's visible set.
   */
  reportVisible: (visible: CockpitVisibleSet) => void;
};

/**
 * The state a page draws before the hub has answered: the fleet view, nothing focused, nothing
 * waiting. Kept as a factory so a caller cannot accidentally share one mutable object.
 */
export function initialCockpitHubState(): CockpitHubState {
  return {
    rev: 0,
    view: { type: 'fleet' },
    viewStack: [],
    focusUri: null,
    tray: [],
    history: [],
    visible: { viewUri: null, focusables: [], projects: [] },
    pendingSend: null,
    lastEventSource: null,
  };
}

/** The hub frame's state, or null when the frame is not one. */
function readStateFrame(frame: unknown): CockpitHubState | null {
  if (frame === null || typeof frame !== 'object') return null;
  const record = frame as { kind?: unknown; state?: unknown };
  if (record.kind !== 'cockpit.state') return null;
  const state = record.state;
  if (state === null || typeof state !== 'object') return null;
  return state as CockpitHubState;
}

/** Used by `CockpitPage` (the `/cockpit` route) to share one cockpit state across devices. */
export function useCockpitHub(): CockpitHubConnection {
  const socket = useWebSocketOptional();
  // The hub's broadcast state. Replaced wholesale on every frame: it is the server's value,
  // not a locally-derived one, which is what keeps two displays from drifting apart.
  const [state, setState] = useState<CockpitHubState>(initialCockpitHubState);

  const deviceId = useMemo(() => getDeviceId(), []);
  const tabId = useMemo(() => getTabId(), []);
  const deviceName = useMemo(() => readDeviceName(), []);
  const connected = socket?.isConnected ?? false;

  useEffect(() => {
    if (socket === null) return undefined;
    const unsubscribe = socket.subscribe((frame) => {
      const next = readStateFrame(frame);
      if (next !== null) setState(next);
    });
    return unsubscribe;
  }, [socket]);

  useEffect(() => {
    if (socket === null || !connected) return;
    // Both roles on one connection: this page renders the stage AND accepts input. The hello
    // lives only as long as the socket, so every reconnect announces again.
    const hello = (role: 'display' | 'input') => ({
      type: 'cockpit.hello',
      role,
      deviceId,
      tabId,
      deviceName,
    });
    socket.sendMessage(hello('display'));
    socket.sendMessage(hello('input'));
  }, [connected, deviceId, deviceName, socket, tabId]);

  const source = useMemo<CockpitEventSource>(
    () => ({ deviceId, deviceName, role: 'input' }),
    [deviceId, deviceName],
  );

  const dispatch = useCallback(
    (event: CockpitHubEvent) => {
      socket?.sendMessage({ type: 'cockpit.event', event: { ...event, source } });
    },
    [socket, source],
  );

  const reportVisible = useCallback(
    (visible: CockpitVisibleSet) => {
      socket?.sendMessage({
        type: 'cockpit.event',
        event: {
          type: 'visible',
          viewUri: visible.viewUri,
          focusables: visible.focusables,
          projects: visible.projects,
          source: { deviceId, deviceName, role: 'display' },
        },
      });
    },
    [deviceId, deviceName, socket],
  );

  return { state, connected, dispatch, reportVisible };
}
