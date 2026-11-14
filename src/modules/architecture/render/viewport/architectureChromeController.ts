/**
 * The architecture tab's chrome owner: which panel surfaces are open, how tall
 * the coarse drawer is, when the layout is locked, and what the top chrome
 * covers — every rule, React-free.
 *
 * WHY A CONTROLLER. These readings used to be a cluster of `useState`/`useRef`
 * declarations and effects in `ArchitecturePanel`: `dockOpen` mirrored into
 * `dockOpenRef` so an effect could read the latest value without re-running,
 * `dockLayoutLocked` armed and released by a timer declared beside it, the
 * "explicit open" licence that distinguishes the Text door from a selection,
 * the touch hint's remembered dismissal, the dock tab, the tray/sheet/legend
 * disclosures and the measured top-chrome band. Every one of them is a rule
 * with more than one writer, so they belong to one owner with one write path
 * per command. The panel only subscribes and renders.
 *
 * The clock, the viewport readings and the two remembered choices are injected
 * seams: the whole controller is exercised without React, `window` or a wall
 * clock by `tests/architectureChromeController.test.ts`.
 *
 * Consumers: `ArchitecturePanel.tsx` (subscribes with `useSyncExternalStore`)
 * and `tests/architectureChromeController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';

/**
 * How long the dock's open/close animation lasts (matching the 160ms
 * `transform` transition in `ArchitectureDock`). Aspect-driven re-layout stays
 * frozen for the duration, plus a frame of slack, so the width change caused by
 * the dock itself is never read as a container shape change.
 */
export const DOCK_LAYOUT_LOCK_MS = 200;

/**
 * The dock's pages. `inspector` is the selection reading; `text` is the
 * PlantUML page registered by the text-page task on the same shell.
 */
export type ArchitectureDockTabId = 'inspector' | 'text';

/** A node the reader asked the graph to reveal (search hit or out-of-range jump). */
export type ArchitectureChromeFocusTarget = {
  readonly id: string;
  /** Bumped on every request so choosing the same node twice re-centres it. */
  readonly token: number;
  /**
   * Whether the request also opens the node's neighbourhood. A plain search
   * Enter only centres and selects IN the current drawing; only Shift+Enter or
   * the result row's "view neighbourhood" action drills.
   */
  readonly drill: boolean;
};

/** Everything the panel reads through `useSyncExternalStore`. */
export type ArchitectureChromeSnapshot = {
  /** Whether the compact tier's one-menu bottom sheet is open. */
  readonly sheetOpen: boolean;
  /** The sheet body's DOM node while it is open (renderer portal target). */
  readonly sheetControlsHost: HTMLElement | null;
  /** The in-flow row above the canvas (renderer portal target). */
  readonly canvasHeaderHost: HTMLElement | null;
  /** The one-off touch instruction's remembered dismissal. */
  readonly touchHintDismissed: boolean;
  /** The node the reader asked to see, or null. */
  readonly focusTarget: ArchitectureChromeFocusTarget | null;
  /** Whether the selection tray is expanded. */
  readonly trayExpanded: boolean;
  /** Whether the dock is on screen. */
  readonly dockOpen: boolean;
  /** True when the READER opened the dock (the Text door), not a selection. */
  readonly dockExplicitlyOpened: boolean;
  /** Which dock page is on screen. */
  readonly dockTab: ArchitectureDockTabId;
  /** True while the dock's open/close transition freezes aspect re-layout. */
  readonly dockLayoutLocked: boolean;
  /** The coarse drawer's painted height, 0 when closed or on another tier. */
  readonly touchDrawerHeight: number;
  /** Whether the one-line readout's explanation is expanded. */
  readonly readoutOpen: boolean;
  /** Whether the `?` legend popover is open. */
  readonly legendOpen: boolean;
  /** Whether the source line's unresolved-names list is expanded. */
  readonly unresolvedOpen: boolean;
  /** Whether the scope-cleanup row is expanded. */
  readonly scopeHygieneOpen: boolean;
  /** How much of the viewport-sized canvas the floating chrome covers. */
  readonly topChromePx: number;
  /** Whether the touch multi-select mode is on. */
  readonly multiSelectMode: boolean;
};

/** The viewport readings the owner consumes, as callables (they change per event). */
export type ArchitectureChromeViewport = {
  /** Whether the portrait phone tier is in force (the readout's start state). */
  readonly portraitPhone: () => boolean;
  /** The height `vh` is measured against, for the drawer's pixel reading. */
  readonly height: () => number;
};

/** The two choices the browser remembers, as seams. */
export type ArchitectureChromePersistence = {
  readonly readTouchHintDismissed: () => boolean;
  readonly persistTouchHintDismissed: () => void;
  readonly readReadoutExpanded: () => boolean;
  readonly persistReadoutExpanded: (open: boolean) => void;
};

/** What one Escape press consumed (the panel clears the selection on the last two). */
export type ArchitectureChromeEscapeStep = 'tray' | 'dock' | 'selection';

/** The commands and subscription surface the panel drives. */
export type ArchitectureChromeController = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ArchitectureChromeSnapshot;

  /**
   * Opens the dock (a no-op when it is already open). `explicit` records that
   * the READER asked for it while nothing was selected (the Text door), which
   * lets an empty inspector page stay; `tab` lands on that page.
   */
  readonly openDock: (options?: {
    readonly explicit?: boolean;
    readonly tab?: ArchitectureDockTabId;
  }) => void;
  /**
   * The reader's close gesture: drops the explicit-open licence, so a later
   * empty selection cannot keep the column. The selection clear stays with the
   * panel (it owns the reducer).
   */
  readonly closeDock: () => void;
  /** Switches the dock page without opening or closing the dock. */
  readonly setDockTab: (tab: ArchitectureDockTabId) => void;
  /** Reports the coarse drawer's painted height; clamped into the viewport. */
  readonly setDrawerHeight: (heightPx: number) => void;

  /** A new selection opens the dock on the inspector; an emptied one closes it. */
  readonly selectionChanged: (hasSelection: boolean) => void;
  /** A different session/project is a different reading: the dock must not travel. */
  readonly readingChanged: () => void;
  /** An empty selection set collapses the tray and leaves multi-select. */
  readonly selectionsEmptied: () => void;
  /** A press on the empty canvas: leaves multi-select and shuts the dock. */
  readonly clearSelection: () => void;
  /** Escape consumes the tray first, then the dock, then the selection. */
  readonly escapeSelection: () => ArchitectureChromeEscapeStep;

  readonly setSheetOpen: (open: boolean) => void;
  readonly toggleSheet: () => void;
  readonly setSheetControlsHost: (host: HTMLElement | null) => void;
  readonly setCanvasHeaderHost: (host: HTMLElement | null) => void;

  /** Dismisses the one-off touch instruction and remembers the choice. */
  readonly dismissTouchHint: () => void;
  readonly setTrayExpanded: (expanded: boolean) => void;
  readonly toggleTray: () => void;
  readonly setMultiSelectMode: (enabled: boolean) => void;
  /** A search/inspector jump: selects, centres and bumps the reveal token. */
  readonly focusNode: (nodeId: string, drill?: boolean) => void;

  readonly toggleReadout: () => void;
  readonly setLegendOpen: (open: boolean) => void;
  readonly closeLegend: () => void;
  readonly toggleLegend: () => void;
  readonly toggleUnresolved: () => void;
  readonly toggleScopeHygiene: () => void;
  /** Reports the covered band above the drawing (0 when the chrome is in flow). */
  readonly reportTopChrome: (pixels: number) => void;

  /** Releases the layout-lock timer; commands stay usable after it. */
  readonly dispose: () => void;
};

/** Safe defaults: no browser globals, no remembered choices. */
const DEFAULT_VIEWPORT: ArchitectureChromeViewport = {
  portraitPhone: () => false,
  height: () => 0,
};

const DEFAULT_PERSISTENCE: ArchitectureChromePersistence = {
  readTouchHintDismissed: () => false,
  persistTouchHintDismissed: () => {},
  readReadoutExpanded: () => false,
  persistReadoutExpanded: () => {},
};

/** Build one chrome owner for one panel mount. */
export function createArchitectureChromeController(options: {
  clock?: Clock;
  viewport?: ArchitectureChromeViewport;
  persistence?: ArchitectureChromePersistence;
} = {}): ArchitectureChromeController {
  const clock = options.clock ?? defaultClock;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const persistence = options.persistence ?? DEFAULT_PERSISTENCE;

  // A missing or non-finite viewport reading must not turn a height into NaN.
  const viewportHeight = (): number => {
    const height = viewport.height();
    return Number.isFinite(height) && height > 0 ? height : 0;
  };

  let sheetOpen = false;
  let sheetControlsHost: HTMLElement | null = null;
  let canvasHeaderHost: HTMLElement | null = null;
  let touchHintDismissed = persistence.readTouchHintDismissed();
  let focusTarget: ArchitectureChromeFocusTarget | null = null;
  let trayExpanded = false;
  let multiSelectMode = false;

  // The dock ALWAYS starts closed: the previous browser-remembered value opened
  // a fresh entry onto a 320px empty inspector and squeezed the canvas. Only a
  // gesture opens it — a fresh selection, or the toolbar's explicit Text door.
  let dockOpen = false;
  // True when the reader opened the dock THEMSELVES while nothing was selected
  // (the Text door). Only that kind of open may show an empty inspector page.
  let dockExplicitlyOpened = false;
  let dockTab: ArchitectureDockTabId = 'inspector';
  let dockLayoutLocked = false;
  let dockLockTimer: unknown = null;
  let touchDrawerHeight = 0;

  // The portrait tier must start collapsed (its height budget) yet keep the
  // reader's expansion across a tab round trip, so the initial value reads the
  // session store and each change writes it back.
  let readoutOpen = viewport.portraitPhone() && persistence.readReadoutExpanded();
  let legendOpen = false;
  let unresolvedOpen = false;
  let scopeHygieneOpen = false;
  let topChromePx = 0;

  const buildSnapshot = (): ArchitectureChromeSnapshot => ({
    sheetOpen,
    sheetControlsHost,
    canvasHeaderHost,
    touchHintDismissed,
    focusTarget,
    trayExpanded,
    dockOpen,
    dockExplicitlyOpened,
    dockTab,
    dockLayoutLocked,
    touchDrawerHeight,
    readoutOpen,
    legendOpen,
    unresolvedOpen,
    scopeHygieneOpen,
    topChromePx,
    multiSelectMode,
  });

  const store = createExternalStore<ArchitectureChromeSnapshot>(buildSnapshot());

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.sheetOpen === next.sheetOpen
      && previous.sheetControlsHost === next.sheetControlsHost
      && previous.canvasHeaderHost === next.canvasHeaderHost
      && previous.touchHintDismissed === next.touchHintDismissed
      && previous.focusTarget === next.focusTarget
      && previous.trayExpanded === next.trayExpanded
      && previous.dockOpen === next.dockOpen
      && previous.dockExplicitlyOpened === next.dockExplicitlyOpened
      && previous.dockTab === next.dockTab
      && previous.dockLayoutLocked === next.dockLayoutLocked
      && previous.touchDrawerHeight === next.touchDrawerHeight
      && previous.readoutOpen === next.readoutOpen
      && previous.legendOpen === next.legendOpen
      && previous.unresolvedOpen === next.unresolvedOpen
      && previous.scopeHygieneOpen === next.scopeHygieneOpen
      && previous.topChromePx === next.topChromePx
      && previous.multiSelectMode === next.multiSelectMode
    ) {
      return;
    }
    store.set(next);
  };

  // ---- Layout lock ---------------------------------------------------------
  // The lock is a plain boolean handed to the renderer; the owner keeps it
  // alive. Repeated opens/closes inside one window are MERGED: the existing
  // timer is replaced, so there is always exactly one deadline — the last
  // gesture plus the transition — instead of two timers that could release the
  // lock early for the newer change.
  const clearDockLock = (): void => {
    if (dockLockTimer === null) return;
    clock.clearTimeout(dockLockTimer);
    dockLockTimer = null;
  };

  const armDockLock = (): void => {
    dockLayoutLocked = true;
    clearDockLock();
    dockLockTimer = clock.setTimeout(() => {
      dockLockTimer = null;
      dockLayoutLocked = false;
      publish();
    }, DOCK_LAYOUT_LOCK_MS);
  };

  const changeDockOpen = (next: boolean): void => {
    dockOpen = next;
    // Closing drops the explicit-open licence; the next open has to earn it
    // again (a fresh selection, or another press on the Text door).
    if (!next) dockExplicitlyOpened = false;
    armDockLock();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    openDock(options = {}) {
      if (options.tab !== undefined) dockTab = options.tab;
      if (options.explicit === true) dockExplicitlyOpened = true;
      if (!dockOpen) changeDockOpen(true);
      publish();
    },

    closeDock() {
      multiSelectMode = false;
      if (dockOpen) changeDockOpen(false);
      publish();
    },

    setDockTab(tab) {
      dockTab = tab;
      publish();
    },

    setDrawerHeight(heightPx) {
      // The drawer reports a snap height derived from `vh`; clamp it to the
      // viewport so a stale reading (orientation change, a hidden document's
      // 0/Infinity) can never lift the tray above the screen.
      const clamped = Number.isFinite(heightPx)
        ? Math.max(0, Math.min(viewportHeight(), Math.round(heightPx)))
        : 0;
      if (clamped === touchDrawerHeight) return;
      touchDrawerHeight = clamped;
      publish();
    },

    selectionChanged(hasSelection) {
      if (hasSelection) {
        // Selecting anything is a request to inspect it: a NEW selection opens
        // the dock AND lands on the Inspector page, whatever page was last used.
        dockTab = 'inspector';
        if (!dockOpen) changeDockOpen(true);
        publish();
        return;
      }
      // An open dock whose selection emptied is an empty column — unless the
      // READER opened it themselves while nothing was selected (the Text door),
      // where the empty inspector page is a page they asked to see.
      if (!dockExplicitlyOpened && dockOpen) changeDockOpen(false);
      publish();
    },

    readingChanged() {
      dockExplicitlyOpened = false;
      if (dockOpen) changeDockOpen(false);
      publish();
    },

    selectionsEmptied() {
      trayExpanded = false;
      multiSelectMode = false;
      publish();
    },

    clearSelection() {
      multiSelectMode = false;
      if (dockOpen) changeDockOpen(false);
      publish();
    },

    escapeSelection() {
      if (trayExpanded) {
        trayExpanded = false;
        publish();
        return 'tray';
      }
      if (dockOpen) {
        multiSelectMode = false;
        changeDockOpen(false);
        publish();
        return 'dock';
      }
      multiSelectMode = false;
      publish();
      return 'selection';
    },

    setSheetOpen(open) {
      sheetOpen = open;
      publish();
    },

    toggleSheet() {
      sheetOpen = !sheetOpen;
      publish();
    },

    setSheetControlsHost(host) {
      sheetControlsHost = host;
      publish();
    },

    setCanvasHeaderHost(host) {
      canvasHeaderHost = host;
      publish();
    },

    dismissTouchHint() {
      if (touchHintDismissed) return;
      touchHintDismissed = true;
      // Storage being unavailable must not resurrect the bubble.
      persistence.persistTouchHintDismissed();
      publish();
    },

    setTrayExpanded(expanded) {
      trayExpanded = expanded;
      publish();
    },

    toggleTray() {
      trayExpanded = !trayExpanded;
      publish();
    },

    setMultiSelectMode(enabled) {
      multiSelectMode = enabled;
      publish();
    },

    focusNode(nodeId, drill = false) {
      focusTarget = { id: nodeId, token: (focusTarget?.token ?? 0) + 1, drill };
      publish();
    },

    toggleReadout() {
      readoutOpen = !readoutOpen;
      // Only the portrait tier's height budget remembers the choice.
      if (viewport.portraitPhone()) persistence.persistReadoutExpanded(readoutOpen);
      publish();
    },

    setLegendOpen(open) {
      legendOpen = open;
      publish();
    },

    closeLegend() {
      legendOpen = false;
      publish();
    },

    toggleLegend() {
      legendOpen = !legendOpen;
      publish();
    },

    toggleUnresolved() {
      unresolvedOpen = !unresolvedOpen;
      publish();
    },

    toggleScopeHygiene() {
      scopeHygieneOpen = !scopeHygieneOpen;
      publish();
    },

    reportTopChrome(pixels) {
      const next = Number.isFinite(pixels) ? Math.max(0, Math.round(pixels)) : 0;
      if (next === topChromePx) return;
      topChromePx = next;
      publish();
    },

    dispose() {
      clearDockLock();
    },
  };
}
