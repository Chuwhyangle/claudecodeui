import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWebSocketOptional } from '@/shared/context/WebSocketContext';
import type {
  CockpitEventSource,
  CockpitHubEvent,
  CockpitHubState,
  CockpitRole,
  CockpitVisibleSet,
} from '@/shared/types';
import { MCP_DEVICE_NAME_STORAGE_KEY } from '@/shared/userSettings';
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

/** The roles a page announces when it does not choose: the `/cockpit` wall both shows and drives. */
const BOTH_ROLES: readonly CockpitRole[] = ['display', 'input'];

/**
 * The viewport width below which the cockpit calls a device a phone. It matches the fleet
 * grid's own `sm` breakpoint, so "this is the phone window" and "this is the one-column
 * stage" are the same boundary.
 */
const PHONE_MAX_WIDTH_PX = 639;

/**
 * The name this page announces for the hub's 「来自手机/桌面」 echo.
 *
 * A name the person chose in settings (the same value the ui-client registry stores) is
 * theirs and is kept verbatim. With no chosen name, the User-Agent default ("Chrome · Linux")
 * describes a browser rather than a device, and reads IDENTICALLY on a phone and a desktop —
 * which is exactly why the echo could not tell the two windows apart. So the fallback is the
 * device class the viewport actually is, plus a short `deviceId` so two desktops still differ.
 */
function cockpitDeviceName(deviceId: string, phoneLabel: string, desktopLabel: string): string {
  let stored = '';
  try {
    stored = localStorage.getItem(MCP_DEVICE_NAME_STORAGE_KEY)?.trim() ?? '';
  } catch {
    // A storage-disabled browser still gets a readable name from the viewport.
    stored = '';
  }
  if (stored !== '') return stored;
  const phone =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH_PX}px)`).matches;
  return `${phone ? phoneLabel : desktopLabel} · ${deviceId.slice(0, 6)}`;
}

export type CockpitHubOptions = {
  /**
   * Which roles this page announces. The default (both) is the desktop wall; the phone remote
   * announces `input` only, because a report from a page that is not displaying the stage would
   * overwrite the visible set the confirmation card is built from.
   */
  roles?: readonly CockpitRole[];
};

/**
 * Used by `CockpitPage` (the `/cockpit` route) and `CockpitRemote` (the `/cockpit/remote`
 * route) to share one cockpit state across devices.
 */
export function useCockpitHub(options: CockpitHubOptions = {}): CockpitHubConnection {
  const { t } = useTranslation();
  // A serialized key rather than the array: a caller may pass a fresh literal on every render,
  // and re-announcing (or re-subscribing) on that identity would be a loop.
  const rolesKey = (options.roles ?? BOTH_ROLES).join(',');
  const socket = useWebSocketOptional();
  // The hub's broadcast state. Replaced wholesale on every frame: it is the server's value,
  // not a locally-derived one, which is what keeps two displays from drifting apart.
  const [state, setState] = useState<CockpitHubState>(initialCockpitHubState);

  const deviceId = useMemo(() => getDeviceId(), []);
  const tabId = useMemo(() => getTabId(), []);
  // The device class comes from the viewport, not the User-Agent (see `cockpitDeviceName`).
  const deviceName = useMemo(
    () => cockpitDeviceName(deviceId, t('cockpit.deviceMobile'), t('cockpit.deviceDesktop')),
    [deviceId, t],
  );
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
    // Every announced role on one connection. The hello lives only as long as the socket, so
    // every reconnect announces again.
    const hello = (role: CockpitRole) => ({
      type: 'cockpit.hello',
      role,
      deviceId,
      tabId,
      deviceName,
    });
    for (const role of rolesKey.split(',') as CockpitRole[]) {
      socket.sendMessage(hello(role));
    }
  }, [connected, deviceId, deviceName, rolesKey, socket, tabId]);

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
