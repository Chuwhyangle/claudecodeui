/**
 * The architecture tab's manual-curation owner: pins, removals, hidden
 * relations, their undo history, the "Adjusted" manager disclosure, the
 * one-node solo view and the curation Toast — every rule, React-free.
 *
 * WHY A CONTROLLER. The persisted lists themselves already live in
 * `curationStore`; what used to live in the panel was a cluster of
 * `useState`/`useRef`/effects around it: the store instance (rebuilt when
 * another tab writes), the `(file, name)` re-anchoring bookkeeping, the Toast
 * with its pause-aware timer, and two disclosure flags. Those are rules with
 * more than one writer and a lifecycle, so they belong to one owner with one
 * write path per command. The panel only subscribes and renders.
 *
 * The store, the clock and the resolve call are injected seams: the whole
 * controller is exercised without React, `localStorage` or a wall clock by
 * `tests/architectureCurationController.test.ts`.
 *
 * Consumers: `ArchitecturePanel.tsx` (subscribes with `useSyncExternalStore`)
 * and `tests/architectureCurationController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';

import {
  createCurationStore,
  curationStorageKey,
  type ArchitectureCurationHiddenEdge,
  type ArchitectureCurationItem,
  type ArchitectureCurationResolveEntry,
  type ArchitectureCurationState,
  type CurationActionResult,
  type CurationStorageLike,
  type CurationStore,
} from '@/modules/architecture/dom/curationStore';

/** How long a curation Toast lives before dismissing itself. */
export const CURATION_TOAST_MS = 12_000;

/** One Toast: `undoable` renders the focusable 撤销 action. */
export type ArchitectureCurationToast = {
  readonly id: number;
  readonly message: string;
  readonly undoable: boolean;
};

/** Everything the panel reads through `useSyncExternalStore`. */
export type ArchitectureCurationSnapshot = {
  /** True when a session exists; false disables the whole feature. */
  readonly canEdit: boolean;
  /** The persisted lists as they are now (the store's reading). */
  readonly state: ArchitectureCurationState;
  /** Whether the "Adjusted N" manager popover is open. */
  readonly managerOpen: boolean;
  /** The one-node "only show this" display filter, or null. */
  readonly soloNodeId: string | null;
  /** The current Toast, or null when none is showing. */
  readonly toast: ArchitectureCurationToast | null;
  /** Whether there is an adjustment to undo right now. */
  readonly canUndo: boolean;
};

/**
 * Resolves saved `(file, name)` identities onto the current analysis' ids.
 * `null` means the request failed (keep the saved ids and retry later).
 */
export type ArchitectureCurationResolveApi = (
  projectId: string,
  items: readonly { readonly name: string; readonly file: string }[],
) => Promise<readonly ArchitectureCurationResolveEntry[] | null>;

/** The commands and subscription surface the panel drives. */
export type ArchitectureCurationController = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ArchitectureCurationSnapshot;
  /** Adds/updates a pin; a previous removal of the same id is undone by it. */
  readonly pin: (item: ArchitectureCurationItem) => CurationActionResult;
  /** Removes a pin (the entity may still be connected, which the UI explains). */
  readonly unpin: (id: string) => CurationActionResult;
  /** Removes an entity from the graph; a previous pin of the same id is undone. */
  readonly exclude: (item: ArchitectureCurationItem) => CurationActionResult;
  /** Brings a removed entity back. */
  readonly restore: (id: string) => CurationActionResult;
  readonly hideEdge: (edge: ArchitectureCurationHiddenEdge) => CurationActionResult;
  readonly showEdge: (edge: ArchitectureCurationHiddenEdge) => CurationActionResult;
  /** Restores one whole page (`pins`/`excluded`/`hiddenEdges`). */
  readonly restoreGroup: (group: keyof ArchitectureCurationState) => CurationActionResult;
  /** Restores every page at once (the manager's "全部还原"). */
  readonly restoreAll: () => CurationActionResult;
  /** Drops one stale item the reader chose to forget. */
  readonly clearItem: (group: 'pins' | 'excluded', id: string) => CurationActionResult;
  /** Undoes the most recent adjustment. */
  readonly undo: () => CurationActionResult;
  /** Opens/closes the "Adjusted N" manager. */
  readonly setManagerOpen: (open: boolean) => void;
  /** Chooses the one-node display filter (`null` shows the whole graph). */
  readonly setSoloNodeId: (nodeId: string | null) => void;
  /** Shows one Toast; replaces any Toast already on screen. */
  readonly showToast: (message: string, undoable?: boolean) => void;
  /** Dismisses the Toast now (the 撤销 action or its own timeout both land here). */
  readonly dismissToast: () => void;
  /** Pauses the Toast's auto-dismiss while the pointer/focus holds it. */
  readonly pauseToast: () => void;
  /** Resumes the Toast's auto-dismiss (restarting the full duration). */
  readonly resumeToast: () => void;
  /** Re-anchors saved items onto current ids; unresolved items become stale. */
  readonly reconcile: (entries: readonly ArchitectureCurationResolveEntry[]) => void;
  /**
   * Runs the re-anchoring for one loaded analysis key, at most once per key.
   * A failed resolve clears the key so the next load retries.
   */
  readonly reconcileForAnalysis: (
    analysisKey: string,
    items: readonly { readonly name: string; readonly file: string }[],
  ) => void;
  /** Forgets the analysis a re-anchoring already ran for (a refresh changed ids). */
  readonly resetReconcile: () => void;
  /** Adopts another tab's write: `null` is `localStorage.clear()`. */
  readonly handleStorageChange: (key: string | null) => void;
  /** Releases timers; commands stay usable (React's StrictMode remounts re-use it). */
  readonly dispose: () => void;
};

/** Build one curation owner for one `(project, session)` pair. */
export function createArchitectureCurationController(options: {
  storage: CurationStorageLike;
  projectId: string | null;
  sessionId: string | null;
  /** Resolve seam for {@link ArchitectureCurationController.reconcileForAnalysis}. */
  resolveItems?: ArchitectureCurationResolveApi;
  clock?: Clock;
  toastDurationMs?: number;
}): ArchitectureCurationController {
  const { storage, projectId, sessionId, resolveItems } = options;
  const clock = options.clock ?? defaultClock;
  const toastDurationMs = options.toastDurationMs ?? CURATION_TOAST_MS;

  // The store is per `(project, session)` and is REPLACED (not mutated) when
  // another tab writes: a fresh instance reads localStorage once, so a new
  // instance IS the adopted state, and this tab's undo history starts over.
  let curationStore: CurationStore = createCurationStore({ storage, projectId, sessionId });

  // The panel-owned readings beside the persisted lists.
  let managerOpen = false;
  let soloNodeId: string | null = null;
  let toast: ArchitectureCurationToast | null = null;
  let toastPaused = false;
  let toastSeq = 0;
  let toastTimer: unknown = null;

  // The analysis key whose saved items were already re-anchored. A refresh
  // resets it, because a new analysis can change every entity id.
  let reconciledAnalysisKey: string | null = null;

  const canEdit = (): boolean => curationStore.canEdit;

  const buildSnapshot = (): ArchitectureCurationSnapshot => ({
    canEdit: canEdit(),
    state: curationStore.getState(),
    managerOpen,
    soloNodeId,
    toast,
    canUndo: curationStore.canUndo(),
  });

  const store = createExternalStore<ArchitectureCurationSnapshot>(buildSnapshot());

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.canEdit === next.canEdit
      && previous.state === next.state
      && previous.managerOpen === next.managerOpen
      && previous.soloNodeId === next.soloNodeId
      && previous.toast === next.toast
      && previous.canUndo === next.canUndo
    ) {
      return;
    }
    store.set(next);
  };

  // ---- Toast ---------------------------------------------------------------
  // The timer belongs to the owner, not the presentational component: pausing
  // on hover/focus is a command (`pauseToast`) rather than a second local
  // timer that could disagree with the Toast's own lifetime.
  const clearToastTimer = (): void => {
    if (toastTimer === null) return;
    clock.clearTimeout(toastTimer);
    toastTimer = null;
  };

  const armToastTimer = (): void => {
    clearToastTimer();
    if (toast === null || toastPaused) return;
    toastTimer = clock.setTimeout(() => {
      toastTimer = null;
      toast = null;
      publish();
    }, toastDurationMs);
  };

  // ---- Re-anchoring --------------------------------------------------------
  /** Commits a resolved re-anchoring; the store already knows which ids moved. */
  const applyReconcile = (entries: readonly ArchitectureCurationResolveEntry[]): void => {
    curationStore.reconcile(entries);
    publish();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    pin(item) {
      const result = curationStore.pin(item);
      publish();
      return result;
    },
    unpin(id) {
      const result = curationStore.unpin(id);
      publish();
      return result;
    },
    exclude(item) {
      const result = curationStore.exclude(item);
      publish();
      return result;
    },
    restore(id) {
      const result = curationStore.restore(id);
      publish();
      return result;
    },
    hideEdge(edge) {
      const result = curationStore.hideEdge(edge);
      publish();
      return result;
    },
    showEdge(edge) {
      const result = curationStore.showEdge(edge);
      publish();
      return result;
    },
    restoreGroup(group) {
      const result = curationStore.restoreGroup(group);
      publish();
      return result;
    },
    restoreAll() {
      const result = curationStore.restoreAll();
      publish();
      return result;
    },
    clearItem(group, id) {
      const result = curationStore.clearItem(group, id);
      publish();
      return result;
    },
    undo() {
      const result = curationStore.undo();
      publish();
      return result;
    },

    setManagerOpen(open) {
      if (managerOpen === open) return;
      managerOpen = open;
      publish();
    },

    setSoloNodeId(nodeId) {
      if (soloNodeId === nodeId) return;
      soloNodeId = nodeId;
      publish();
    },

    showToast(message, undoable = true) {
      toastSeq += 1;
      toast = { id: toastSeq, message, undoable };
      toastPaused = false;
      armToastTimer();
      publish();
    },

    dismissToast() {
      clearToastTimer();
      toastPaused = false;
      if (toast === null) return;
      toast = null;
      publish();
    },

    pauseToast() {
      if (toast === null || toastPaused) return;
      toastPaused = true;
      clearToastTimer();
    },

    resumeToast() {
      if (toast === null || !toastPaused) return;
      toastPaused = false;
      armToastTimer();
    },

    reconcile(entries) {
      applyReconcile(entries);
    },

    reconcileForAnalysis(analysisKey, items) {
      if (resolveItems === undefined || projectId === null) return;
      if (items.length === 0) return;
      if (reconciledAnalysisKey === analysisKey) return;
      reconciledAnalysisKey = analysisKey;
      void (async () => {
        const resolved = await resolveItems(projectId, items);
        // A failed request is not a re-analysis: keep the saved ids and let the
        // next load try again.
        if (resolved === null) {
          if (reconciledAnalysisKey === analysisKey) reconciledAnalysisKey = null;
          return;
        }
        applyReconcile(resolved);
      })();
    },

    resetReconcile() {
      reconciledAnalysisKey = null;
    },

    handleStorageChange(key) {
      const curationKey = curationStorageKey(projectId, sessionId);
      const cleared = key === null;
      if (!cleared && (curationKey === null || key !== curationKey)) return;
      // A fresh instance reads the other tab's write; the undo history is
      // deliberately per tab and starts over.
      curationStore = createCurationStore({ storage, projectId, sessionId });
      publish();
    },

    dispose() {
      clearToastTimer();
    },
  };
}
