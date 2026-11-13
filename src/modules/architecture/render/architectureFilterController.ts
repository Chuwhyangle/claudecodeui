/**
 * The architecture tab's filter/display-settings owner: the file/class
 * granularity, the BFS scope and detail-tier knobs, the element/relation
 * filter, the debounced SERVER-request selection, the filter popover's
 * disclosure and position, and the inspector's "search tool output" switch.
 *
 * WHY A CONTROLLER. These readings share one rule that a component must not
 * own: a change is shown immediately, but only WIDENING (or a view switch) may
 * become a request, and a walk through the relation presets must collapse into
 * one request. That rule is a timer plus a "what the last request used" pair —
 * the exact shape the frontend standards say belongs to a React-free owner.
 * The storage seam and the clock are injected, so the debounce is asserted in
 * a test without waiting.
 *
 * Consumers: `ArchitecturePanel.tsx` (subscribes with `useSyncExternalStore`)
 * and `tests/architectureFilterController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';

import {
  filtersEqual,
  type ArchitectureElementRelationFilter,
} from '@/modules/architecture/dom/elementRelationFilter';
import {
  clampArchitectureScope,
  type ArchitectureDetailTier,
} from '@/modules/architecture/dom/detailRanking';
import {
  filterStorageKey,
  readStoredFilter,
  writeStoredFilter,
  type ArchitectureGranularity,
} from '@/modules/architecture/layout/panelFilters';
import {
  detailStorageKey,
  readStoredDetail,
  readStoredScope,
  scopeStorageKey,
  writeStoredDetail,
  writeStoredScope,
  type PanelStorageLike,
} from '@/modules/architecture/layout/panelPersistence';

/** How long a filter/view change waits before it becomes a request. */
export const FILTER_REQUEST_DEBOUNCE_MS = 250;

/** Everything the panel reads through `useSyncExternalStore`. */
export type ArchitectureFilterSnapshot = {
  /** The subgraph on screen; switching it is local. */
  readonly granularity: ArchitectureGranularity;
  /** The requested BFS depth — a server generation parameter. */
  readonly scope: number;
  /** The detail tier; it only ranks the arrived payload, never refetches. */
  readonly detail: ArchitectureDetailTier;
  /** The selection the reader made and the drawing obeys. */
  readonly filter: ArchitectureElementRelationFilter;
  /** The selection the last SERVER request was made with. */
  readonly requestFilter: ArchitectureElementRelationFilter;
  /** The granularity the last SERVER request was made for. */
  readonly requestGranularity: ArchitectureGranularity;
  /** Whether the filter popover is open. */
  readonly filterMenuOpen: boolean;
  /** The fixed-position anchor the desktop popover is drawn at. */
  readonly filterPosition: { readonly left: number; readonly top: number } | null;
  /** Whether the sessions page's inspector searches tool output too. */
  readonly includeToolResults: boolean;
};

/** The commands and subscription surface the panel drives. */
export type ArchitectureFilterController = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ArchitectureFilterSnapshot;
  /** Changes the requested BFS depth and remembers it for this project. */
  readonly changeScope: (next: number) => void;
  /** Changes the detail tier and remembers it for this project. */
  readonly changeDetail: (next: ArchitectureDetailTier) => void;
  /**
   * Applies a new element/relation selection: shown now, persisted now, and
   * requested later (debounced) unless it already is the request's selection.
   */
  readonly changeFilter: (next: ArchitectureElementRelationFilter) => void;
  /** Switches the subgraph now; a view switch also becomes a server request. */
  readonly changeGranularity: (next: ArchitectureGranularity) => void;
  /** Opens the filter popover (optionally anchored at a measured position). */
  readonly openFilterMenu: (position: { readonly left: number; readonly top: number } | null) => void;
  readonly closeFilterMenu: () => void;
  readonly setIncludeToolResults: (include: boolean) => void;
  /** Adopts another tab's write: `null` is `localStorage.clear()`. */
  readonly handleStorageChange: (key: string | null) => void;
  /** Clears the pending debounce; commands stay usable (StrictMode remounts re-use it). */
  readonly dispose: () => void;
};

/** Build one filter/display owner for one project. */
export function createArchitectureFilterController(options: {
  storage: PanelStorageLike;
  projectId: string | null;
  /** A deep link's view wins over the remembered granularity for this mount. */
  initialGranularity?: ArchitectureGranularity;
  /** A deep link's scope wins over the remembered scope for this mount. */
  initialScope?: number;
  /** A deep link's detail tier wins over the remembered tier for this mount. */
  initialDetail?: ArchitectureDetailTier;
  /** A test may shorten the debounce. */
  debounceMs?: number;
  clock?: Clock;
}): ArchitectureFilterController {
  const { storage, projectId } = options;
  const clock = options.clock ?? defaultClock;
  const debounceMs = options.debounceMs ?? FILTER_REQUEST_DEBOUNCE_MS;

  // The initial selection is the remembered one unless a deep link overrode it
  // for this mount. `filter` and `requestFilter` start equal: the payload the
  // first request brings IS this selection.
  const storedFilter = readStoredFilter(storage, projectId);
  let granularity: ArchitectureGranularity = options.initialGranularity ?? 'entity';
  let scope = options.initialScope ?? readStoredScope(storage, projectId);
  let detail = options.initialDetail ?? readStoredDetail(storage, projectId);
  let filter: ArchitectureElementRelationFilter = storedFilter;
  let requestFilter: ArchitectureElementRelationFilter = storedFilter;
  let requestGranularity: ArchitectureGranularity = granularity;
  let filterMenuOpen = false;
  let filterPosition: { readonly left: number; readonly top: number } | null = null;
  let includeToolResults = false;

  // The ONE pending request collapse: a new change replaces the previous one,
  // so a walk through the presets produces one round trip.
  let debounceTimer: unknown = null;

  const buildSnapshot = (): ArchitectureFilterSnapshot => ({
    granularity,
    scope,
    detail,
    filter,
    requestFilter,
    requestGranularity,
    filterMenuOpen,
    filterPosition,
    includeToolResults,
  });

  const store = createExternalStore<ArchitectureFilterSnapshot>(buildSnapshot());

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.granularity === next.granularity
      && previous.scope === next.scope
      && previous.detail === next.detail
      && previous.filter === next.filter
      && previous.requestFilter === next.requestFilter
      && previous.requestGranularity === next.requestGranularity
      && previous.filterMenuOpen === next.filterMenuOpen
      && previous.filterPosition === next.filterPosition
      && previous.includeToolResults === next.includeToolResults
    ) {
      return;
    }
    store.set(next);
  };

  const cancelScheduledRequest = (): void => {
    if (debounceTimer === null) return;
    clock.clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  /**
   * Queue a request for a filter/view change, collapsing a walk through the
   * presets into one round-trip.
   */
  const scheduleRequest = (
    nextFilter: ArchitectureElementRelationFilter,
    nextGranularity: ArchitectureGranularity,
  ): void => {
    cancelScheduledRequest();
    debounceTimer = clock.setTimeout(() => {
      debounceTimer = null;
      requestFilter = nextFilter;
      requestGranularity = nextGranularity;
      publish();
    }, debounceMs);
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    changeScope(next) {
      scope = clampArchitectureScope(next);
      writeStoredScope(storage, projectId, scope);
      publish();
    },

    changeDetail(next) {
      detail = next;
      writeStoredDetail(storage, projectId, detail);
      publish();
    },

    changeFilter(next) {
      filter = next;
      writeStoredFilter(storage, projectId, next);
      if (filtersEqual(next, requestFilter)) {
        // Already the request's own selection: the payload in hand IS this state.
        cancelScheduledRequest();
        publish();
        return;
      }
      scheduleRequest(next, requestGranularity);
      publish();
    },

    changeGranularity(next) {
      granularity = next;
      // Both subgraphs are in hand, so the drawing switches now; the request
      // only follows because the element axis does not apply to the file graph.
      if (next !== requestGranularity) scheduleRequest(requestFilter, next);
      publish();
    },

    openFilterMenu(position) {
      filterPosition = position;
      filterMenuOpen = true;
      publish();
    },

    closeFilterMenu() {
      if (!filterMenuOpen) return;
      filterMenuOpen = false;
      publish();
    },

    setIncludeToolResults(include) {
      if (includeToolResults === include) return;
      includeToolResults = include;
      publish();
    },

    handleStorageChange(key) {
      // `key === null` is `localStorage.clear()`: every knob is gone, so every
      // reading has to be re-adopted rather than left describing deleted state.
      const cleared = key === null;
      if (!cleared && key !== filterStorageKey(projectId)
        && key !== scopeStorageKey(projectId) && key !== detailStorageKey(projectId)) {
        return;
      }
      if (cleared || key === filterStorageKey(projectId)) {
        const stored = readStoredFilter(storage, projectId);
        filter = stored;
        requestFilter = stored;
        // The filter is a generation knob for the view on screen, so the next
        // read asks for the newly stored selection instead of the old one.
        requestGranularity = granularity;
      }
      if (cleared || key === scopeStorageKey(projectId)) {
        scope = readStoredScope(storage, projectId);
      }
      if (cleared || key === detailStorageKey(projectId)) {
        detail = readStoredDetail(storage, projectId);
      }
      publish();
    },

    dispose() {
      cancelScheduledRequest();
    },
  };
}
