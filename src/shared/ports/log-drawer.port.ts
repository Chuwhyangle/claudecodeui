/**
 * The shared seam that lets a diagnostic surface open the log drawer.
 *
 * WHY A PORT. `settings` (the health list) needs to open a drawer owned by
 * `diagnostics`. Importing the diagnostics module from it would couple two
 * feature modules. The composition root mounts ONE `LogDrawerHost` and installs
 * its opener here; every producer reads this neutral accessor instead.
 *
 * FAIL CLOSED. Before the host mounts (a focused criterion, a page that does not
 * render the root) `openLogDrawer` returns false and `isLogDrawerAvailable` is
 * false, so a caller hides the entry instead of rendering a dead button.
 *
 * Consumers: `DiagnosticsHealthList` (the entry point),
 * `DiagnosticsSettingsTab` (the Settings action), `LogDrawerHost` (the
 * installer) and the port criterion. This file imports nothing.
 */

/** The pre-filter a producer asks the drawer to open with. */
export type LogDrawerOpenFilter = {
  /** A source id (`reply-suggestions`, `server`, …); omit for every source. */
  source?: string;
  /** A severity floor is not a concept here: the filter is exact. */
  level?: 'info' | 'warn' | 'error';
  /** Oldest instant to include, ISO-8601. */
  since?: string;
  /** Text that must appear in a line; the drawer pre-fills its search input. */
  requestId?: string;
  /** The feature that opened the drawer, for the header's title. */
  feature?: string;
};

/** The installed opener: returns whether the drawer accepted the request. */
export type OpenLogDrawer = (filter: LogDrawerOpenFilter) => boolean;

/** The lifecycle owner; its state lives in this closure, not at module scope. */
type LogDrawerPortOwner = {
  install: (open: OpenLogDrawer) => () => void;
  open: (filter: LogDrawerOpenFilter) => boolean;
  available: () => boolean;
};

/** Builds a fresh, independent port owner — one per module instance in a criterion. */
function createLogDrawerPortOwner(): LogDrawerPortOwner {
  let installed: OpenLogDrawer | null = null;
  return {
    install(open) {
      installed = open;
      // Uninstalling is identity-guarded: disposing a superseded installer must
      // not clear the replacement that took its place.
      return () => {
        if (installed === open) installed = null;
      };
    },
    open(filter) {
      if (installed === null) return false;
      return installed(filter) !== false;
    },
    available: () => installed !== null,
  };
}

/** The one process (page) port. */
const logDrawerPort = createLogDrawerPortOwner();

/**
 * Installs the page's drawer opener and returns its disposer.
 *
 * Consumers: `LogDrawerHost` on mount; the port criterion installs its own. The
 * last installation wins, so a remount replaces the previous opener.
 */
export function installLogDrawerPort(open: OpenLogDrawer): () => void {
  return logDrawerPort.install(open);
}

/**
 * Asks the drawer to open with `filter`. Returns false when no host is mounted —
 * the caller must hide its entry in that case.
 *
 * Consumers: the failure notice, the health list and the Settings tab.
 */
export function openLogDrawer(filter: LogDrawerOpenFilter): boolean {
  return logDrawerPort.open(filter);
}

/** Whether a host is mounted; a renderer uses this to hide its entry. */
export function isLogDrawerAvailable(): boolean {
  return logDrawerPort.available();
}
