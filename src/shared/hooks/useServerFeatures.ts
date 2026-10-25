import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type { ServerFeatures } from '@/shared/types';

/**
 * The browser's reading of the server-level feature switches.
 *
 * WHY AN EXTERNAL STORE. The sidebar's mode switch, the project/session rows, the command
 * palette and the cockpit route guard all need the same answer, and they mount in different
 * parts of the tree. One module-level reading means one request and one answer, so two
 * surfaces can never disagree about whether the cockpit is on.
 *
 * FAIL CLOSED. The cockpit ships off, so the initial reading and every failure ("the server
 * did not answer", "it answered something that is not JSON", "it predates this endpoint")
 * leave `cockpitEnabled` false. That is what keeps a release from exposing the cockpit because
 * a request failed, not because an operator enabled it. The value is boot-static; there is no
 * polling and no retry that could flip it later in the session.
 *
 * THE LOAD IS LAZY. The first mounted consumer starts the one request. A page with no cockpit
 * entry point (the standalone architecture view) never asks.
 *
 * Consumers: `SidebarModeSwitch`, `SidebarProjectItem`, `SidebarSessionItem`,
 * `CommandPalette`, `CockpitRoute` and `ViewEventInstrumentation`.
 */

/** The reading a consumer branches on. `loading` is deliberately indistinguishable from off. */
export type ServerFeaturesReading = {
  /** `loading` only before the first answer; `error` means the answer was absent or unreadable. */
  status: 'loading' | 'loaded' | 'error';
  /** The cockpit switch. False while loading and after any failure. */
  cockpitEnabled: boolean;
};

const INITIAL_READING: ServerFeaturesReading = { status: 'loading', cockpitEnabled: false };

let reading: ServerFeaturesReading = INITIAL_READING;
/** The components subscribed through `useSyncExternalStore`. */
const listeners = new Set<() => void>();
/** The one in-flight request, shared by every consumer that mounts concurrently. */
let inFlight: Promise<void> | null = null;
/** True once the request has settled; the value cannot change afterwards, so no retry is wanted. */
let settled = false;

function publish(next: ServerFeaturesReading): void {
  reading = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ServerFeaturesReading {
  return reading;
}

/** Reads the switches once and publishes the outcome; every later call is a no-op. */
function loadServerFeatures(): Promise<void> {
  if (settled) {
    return Promise.resolve();
  }
  if (inFlight !== null) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const response = await api.settings.serverFeatures();
      if (!response.ok) {
        publish({ status: 'error', cockpitEnabled: false });
        return;
      }
      const features = (await response.json()) as Partial<ServerFeatures> | null;
      // Exactly `true` enables the feature: a missing block, a string or any other value is
      // "off", the same reading the server applies to a malformed `cockpit.enabled`.
      const cockpitEnabled = features?.cockpit?.enabled === true;
      publish({ status: 'loaded', cockpitEnabled });
    } catch {
      // An unreachable or unparsable answer is the same product answer as "off".
      publish({ status: 'error', cockpitEnabled: false });
    } finally {
      settled = true;
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Used by the surfaces named above to decide whether a cockpit entry point may render.
 *
 * A consumer must treat `loading` as off: rendering the switch and removing it a moment later
 * is exactly the flash a disabled release must not show.
 */
export function useServerFeatures(): ServerFeaturesReading {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void loadServerFeatures();
  }, []);
  return snapshot;
}
