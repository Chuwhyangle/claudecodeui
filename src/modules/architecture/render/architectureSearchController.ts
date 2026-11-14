/**
 * The architecture tab's search / hover-hint / deep-link owner, React-free.
 *
 * WHY A CONTROLLER. This cluster used to be a set of `useState`/`useRef`
 * declarations and effects inside `ArchitecturePanel`: the query mirrored into
 * the match list, the transient active option, the hover reading discarded by a
 * key comparison during render, the measured hint position, and two
 * "only once" flags (the `?entity=` deep link and the per-analysis re-align).
 * Every one of those is a rule with more than one writer or a lifecycle of its
 * own, so they belong to one owner with a single write path per command. The
 * panel only subscribes and renders.
 *
 * The clock is an injected seam, so the input debounce, the hover dwell and
 * `dispose` are exercised without React, `window` or a wall clock by
 * `tests/architectureSearchController.test.ts`.
 *
 * Consumers: `ArchitecturePanel.tsx` (subscribes with `useSyncExternalStore`)
 * and `tests/architectureSearchController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';
import { orderArchitectureNodesByImportance } from '@/modules/architecture/dom/readout/detailRanking';
import {
  placeHoverHint,
  type ArchitectureHintRect,
  type ArchitectureHintSize,
} from '@/modules/architecture/dom/readout/hoverHintPlacement';
import type {
  ArchitectureRendererEdge,
  ArchitectureRendererHover,
  ArchitectureRendererNode,
} from '@/modules/architecture/dom/rendererContract';

/**
 * How long the query may keep changing before the candidate list is rebuilt.
 * Typing fans out no per-keystroke ranking; the list settles one tick after the
 * reader stops. The project-wide search has its own (longer) transport debounce
 * in `useProjectSearch`.
 */
export const SEARCH_QUERY_DEBOUNCE_MS = 120;

/**
 * How long the pointer must rest on a node before the relation hint is painted.
 * A pointer crossing the drawing never flashes a reading; leaving the node
 * hides it immediately, so only the appearance waits.
 */
export const HOVER_HINT_DWELL_MS = 180;

/** The most in-graph matches the combobox offers (the rest are project hits). */
export const SEARCH_MATCH_LIMIT = 8;

/** One in-graph search result: the node plus why it may not be drawn. */
export type ArchitectureSearchCandidate = {
  readonly node: ArchitectureRendererNode;
  /** True when the element/relation filter still draws the node. */
  readonly inGraph: boolean;
  /** True when the detail tier still draws it (`inGraph` is required too). */
  readonly inRange: boolean;
};

/** The graph facts candidate ranking reads; the panel reports them per reading. */
export type ArchitectureSearchReading = {
  /** Names the graph the reading came from (`session:granularity:scope`). */
  readonly key: string;
  /** The payload BEFORE the element/relation filter. */
  readonly nodes: readonly ArchitectureRendererNode[];
  readonly edges: readonly ArchitectureRendererEdge[];
  /** Node ids the element/relation filter kept. */
  readonly activeNodeIds: ReadonlySet<string>;
  /** Node ids the detail tier kept, or null before a ranking exists. */
  readonly retainedNodeIds: ReadonlySet<string> | null;
};

/** Everything the panel reads through `useSyncExternalStore`. */
export type ArchitectureSearchSnapshot = {
  /** The input's text, published immediately so the field never lags a keypress. */
  readonly query: string;
  /** True while the query debounce is armed (the list waits, it is not empty). */
  readonly pending: boolean;
  /** Whether the result list is open. */
  readonly open: boolean;
  /** The option the arrow keys moved onto, or -1 for "no active option". */
  readonly activeIndex: number;
  /** The ranked in-graph matches for the committed query. */
  readonly candidates: readonly ArchitectureSearchCandidate[];
  /** The node under the pointer, or null. */
  readonly hover: ArchitectureRendererHover | null;
  /** True once the pointer has rested on the node for the dwell threshold. */
  readonly hoverVisible: boolean;
  /** Identifies what the measured hint position belongs to (text + relations). */
  readonly hoverSignature: string | null;
  /** The settled, measured hint position in the canvas region's coordinates. */
  readonly hoverHintPosition: { readonly left: number; readonly top: number } | null;
};

/** A reveal instruction the panel turns into its own selection/centring call. */
export type ArchitectureSearchReveal = {
  readonly nodeId: string;
  /** True when the detail tier folded the node away (raise the tier first). */
  readonly outOfRange: boolean;
  /** True for the explicit "view neighbourhood" command only. */
  readonly drill: boolean;
};

/** What Enter chose: an in-graph candidate, or a project-wide hit by index. */
export type ArchitectureSearchCommit =
  | {
    readonly kind: 'candidate';
    readonly candidate: ArchitectureSearchCandidate;
    readonly drill: boolean;
  }
  | { readonly kind: 'project'; readonly projectIndex: number };

/** The deep link's first-open instruction, as the panel reads it from the URL. */
export type ArchitectureSearchDeepLinkInput = {
  readonly entity: string | null;
  readonly mode: 'neighbourhood' | null;
  /** False until the containing reading has actually arrived. */
  readonly loaded: boolean;
  /** Identifies the analysis, so the first apply also marks it reconciled. */
  readonly analysisKey: string;
  readonly nodeIds: readonly string[];
  readonly retainedNodeIds: ReadonlySet<string> | null;
};

/** One analysis's facts, for the once-per-analysis re-align after a refresh. */
export type ArchitectureSearchAnalysisInput = {
  readonly analysisKey: string;
  readonly nodeIds: readonly string[];
  readonly retainedNodeIds: ReadonlySet<string> | null;
};

/** The commands and subscription surface the panel drives. */
export type ArchitectureSearchController = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ArchitectureSearchSnapshot;

  /**
   * The canvas region element, as a ref the panel can also hand to the Text
   * page and the dock. The owner holds the live element (React writes it)
   * instead of the ref living in the component.
   */
  readonly canvasRegionRef: { current: HTMLDivElement | null };
  /** The combobox root, for the outside-press test. */
  readonly searchWidgetRef: { current: HTMLDivElement | null };
  /** Whether a press target lives inside the combobox widget. */
  readonly isInsideSearchWidget: (target: Node | null) => boolean;
  /** The hint element whose size the placement measures. */
  readonly hoverHintRef: { current: HTMLSpanElement | null };

  /** Reports the current reading; a new key discards a hover from the old one. */
  readonly setReading: (reading: ArchitectureSearchReading | null) => void;

  /** A change of the input text: opens the list and arms the ranking debounce. */
  readonly setQuery: (query: string) => void;
  /** Focus opens the list and drops any stale active option. */
  readonly openList: () => void;
  /** Escape, a press outside, or a chosen result closes the list. */
  readonly closeList: () => void;
  /** Empties the query and the list (after pinning, for example). */
  readonly clear: () => void;
  /** Arrow keys move the active option; `optionCount` includes project hits. */
  readonly moveActive: (delta: number, optionCount?: number) => void;
  /**
   * Enter chooses the active option (or the first in-graph match when none is
   * active), closes the list and clears the active option.
   */
  readonly commit: (options?: {
    readonly optionCount?: number;
    readonly drill?: boolean;
  }) => ArchitectureSearchCommit | null;

  /** Reports the node under the pointer; the dwell timer gates the hint. */
  readonly setHover: (graphKey: string, hover: ArchitectureRendererHover | null) => void;

  /** The `?entity=` instruction: applied at most once per entity. */
  readonly applyDeepLink: (input: ArchitectureSearchDeepLinkInput) => ArchitectureSearchReveal | null;
  /** Re-aligns the deep-linked entity at most once per analysis. */
  readonly reconcileAnalysis: (input: ArchitectureSearchAnalysisInput) => ArchitectureSearchReveal | null;
  /** Forgets the reconciled analysis (the panel calls it on a manual refresh). */
  readonly resetReconcile: () => void;
  /** Builds the reveal instruction; the panel performs it. */
  readonly reveal: (
    nodeId: string,
    options?: { readonly outOfRange?: boolean; readonly drill?: boolean },
  ) => ArchitectureSearchReveal;

  /** Stores the placement `placeHoverHint` chose for the live rectangles. */
  readonly layoutHoverHint: (input: {
    readonly container: ArchitectureHintRect;
    readonly hint: ArchitectureHintSize;
    readonly obstacles: readonly ArchitectureHintRect[];
    readonly margin?: number;
  }) => void;
  /** Drops the measured position (no hover, or no measured hint). */
  readonly clearHoverHint: () => void;

  /** Releases the debounce and dwell timers; commands stay usable afterwards. */
  readonly dispose: () => void;
};

/** Rank the in-graph matches for `query` from the current reading. */
function rankCandidates(
  reading: ArchitectureSearchReading | null,
  query: string,
): ArchitectureSearchCandidate[] {
  if (reading === null) return [];
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  // The importance order is the documented one (`detailRanking`): hop distance,
  // then in-degree, then id. Ranking the MATCHES with it keeps the most
  // connected hit first instead of inheriting payload order.
  const order = new Map<string, number>();
  orderArchitectureNodesByImportance(reading.nodes, reading.edges)
    .forEach((node, index) => order.set(node.id, index));
  return reading.nodes
    .filter((node) => (
      node.id.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle)
    ))
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
    .slice(0, SEARCH_MATCH_LIMIT)
    .map((node) => {
      const inGraph = reading.activeNodeIds.has(node.id);
      return {
        node,
        inGraph,
        // A node the detail tier folded away is "out of range"; a node the
        // filter removed is not even in the drawing.
        inRange: inGraph && (reading.retainedNodeIds?.has(node.id) ?? false),
      };
    });
}

/** Build one search/hover/deep-link owner for one panel mount. */
export function createArchitectureSearchController(options: {
  clock?: Clock;
} = {}): ArchitectureSearchController {
  const clock = options.clock ?? defaultClock;

  let reading: ArchitectureSearchReading | null = null;
  let readingKey: string | null = null;

  let query = '';
  let committedQuery = '';
  let pending = false;
  let debounceTimer: unknown = null;
  let debounceArmed = false;
  let open = false;
  let activeIndex = -1;
  let candidates: ArchitectureSearchCandidate[] = [];

  let hover: ArchitectureRendererHover | null = null;
  let hoverVisible = false;
  let dwellTimer: unknown = null;
  let dwellArmed = false;
  let hoverHintPosition: { readonly left: number; readonly top: number } | null = null;

  let deepLinkAppliedEntity: string | null = null;
  let anchorEntity: string | null = null;
  let anchorMode: 'neighbourhood' | null = null;
  let reconciledAnalysisKey: string | null = null;

  let searchWidgetElement: HTMLDivElement | null = null;
  let hoverHintElement: HTMLSpanElement | null = null;
  let canvasRegionElement: HTMLDivElement | null = null;

  const cancelDebounce = (): void => {
    if (debounceArmed) {
      clock.clearTimeout(debounceTimer);
      debounceArmed = false;
      debounceTimer = null;
    }
    pending = false;
  };

  const cancelDwell = (): void => {
    if (dwellArmed) {
      clock.clearTimeout(dwellTimer);
      dwellArmed = false;
      dwellTimer = null;
    }
  };

  const hoverSignature = (): string | null => (
    hover === null ? null : `${hover.node.id}\u0000${hover.relations.join(',')}`
  );

  const buildSnapshot = (): ArchitectureSearchSnapshot => ({
    query,
    pending,
    open,
    activeIndex,
    candidates,
    hover,
    hoverVisible,
    hoverSignature: hoverSignature(),
    hoverHintPosition,
  });

  const store = createExternalStore<ArchitectureSearchSnapshot>(buildSnapshot());

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.query === next.query
      && previous.pending === next.pending
      && previous.open === next.open
      && previous.activeIndex === next.activeIndex
      && previous.candidates === next.candidates
      && previous.hover === next.hover
      && previous.hoverVisible === next.hoverVisible
      && previous.hoverSignature === next.hoverSignature
      && previous.hoverHintPosition === next.hoverHintPosition
    ) {
      return;
    }
    store.set(next);
  };

  const reveal = (
    nodeId: string,
    revealOptions: { readonly outOfRange?: boolean; readonly drill?: boolean } = {},
  ): ArchitectureSearchReveal => ({
    nodeId,
    outOfRange: revealOptions.outOfRange ?? false,
    drill: revealOptions.drill ?? false,
  });

  const folded = (
    nodeId: string,
    retainedNodeIds: ReadonlySet<string> | null,
  ): boolean => retainedNodeIds !== null && !retainedNodeIds.has(nodeId);

  /** Rebuilds the candidate list from the CURRENT reading and committed query. */
  const rebuildCandidates = (): void => {
    candidates = rankCandidates(reading, committedQuery);
    activeIndex = -1;
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    canvasRegionRef: {
      get current() {
        return canvasRegionElement;
      },
      set current(element) {
        canvasRegionElement = element;
      },
    },

    searchWidgetRef: {
      get current() {
        return searchWidgetElement;
      },
      set current(element) {
        searchWidgetElement = element;
      },
    },

    isInsideSearchWidget(target) {
      return target !== null && searchWidgetElement?.contains(target) === true;
    },

    hoverHintRef: {
      get current() {
        return hoverHintElement;
      },
      set current(element) {
        hoverHintElement = element;
      },
    },

    setReading(next) {
      // A different graph is a different reading: a hover (and its measured
      // hint) from the previous one must not survive the switch.
      if (next === null || next.key !== readingKey) {
        cancelDwell();
        hover = null;
        hoverVisible = false;
        hoverHintPosition = null;
      }
      readingKey = next?.key ?? null;
      reading = next;
      // While the debounce is armed the query that will be ranked is not yet
      // decided; the timer rebuilds from the reading that is current THEN.
      if (!debounceArmed) rebuildCandidates();
      publish();
    },

    setQuery(value) {
      query = value;
      open = true;
      activeIndex = -1;
      cancelDebounce();
      // Stale rows for a different query are never shown as its matches.
      candidates = [];
      if (query.trim() === '') {
        committedQuery = '';
        publish();
        return;
      }
      pending = true;
      debounceArmed = true;
      debounceTimer = clock.setTimeout(() => {
        debounceArmed = false;
        debounceTimer = null;
        committedQuery = query;
        pending = false;
        rebuildCandidates();
        publish();
      }, SEARCH_QUERY_DEBOUNCE_MS);
      publish();
    },

    openList() {
      open = true;
      activeIndex = -1;
      publish();
    },

    closeList() {
      if (!open && activeIndex === -1) return;
      open = false;
      activeIndex = -1;
      publish();
    },

    clear() {
      cancelDebounce();
      query = '';
      committedQuery = '';
      candidates = [];
      open = false;
      activeIndex = -1;
      publish();
    },

    moveActive(delta, optionCount) {
      const count = optionCount ?? candidates.length;
      if (count <= 0) return;
      activeIndex = activeIndex < 0
        ? (delta > 0 ? 0 : count - 1)
        : (activeIndex + delta + count) % count;
      publish();
    },

    commit(commitOptions = {}) {
      const count = commitOptions.optionCount ?? candidates.length;
      const index = activeIndex >= 0 ? activeIndex : (candidates.length > 0 ? 0 : -1);
      if (index < 0 || index >= count) return null;
      open = false;
      activeIndex = -1;
      if (index < candidates.length) {
        publish();
        return { kind: 'candidate', candidate: candidates[index], drill: commitOptions.drill ?? false };
      }
      publish();
      return { kind: 'project', projectIndex: index - candidates.length };
    },

    setHover(graphKey, next) {
      if (next === null) {
        cancelDwell();
        if (hover === null && !hoverVisible && hoverHintPosition === null) return;
        hover = null;
        hoverVisible = false;
        hoverHintPosition = null;
        publish();
        return;
      }
      // A report from a graph other than the one on screen is not a reading.
      if (readingKey !== null && graphKey !== readingKey) return;
      const nextSignature = `${next.node.id}\u0000${next.relations.join(',')}`;
      // The renderer reports the same node on every pointer move; that must not
      // restart the dwell (which would postpone the hint forever).
      if (hover !== null && hoverSignature() === nextSignature) return;
      cancelDwell();
      hover = next;
      hoverVisible = false;
      hoverHintPosition = null;
      dwellArmed = true;
      dwellTimer = clock.setTimeout(() => {
        dwellArmed = false;
        dwellTimer = null;
        hoverVisible = true;
        publish();
      }, HOVER_HINT_DWELL_MS);
      publish();
    },

    applyDeepLink(input) {
      if (input.entity === null) return null;
      // The link is a FIRST-OPEN instruction: a reader who later selects
      // another node must not be dragged back by the URL.
      if (deepLinkAppliedEntity === input.entity) return null;
      if (!input.loaded) return null;
      // An id the current subgraph does not carry is ignored rather than focused
      // blindly; a later reading that DOES carry it may still apply.
      if (!input.nodeIds.includes(input.entity)) return null;
      deepLinkAppliedEntity = input.entity;
      anchorEntity = input.entity;
      anchorMode = input.mode;
      // The first apply IS this analysis's alignment; the reconcile pass must
      // not reveal the same node a second time in the same analysis.
      reconciledAnalysisKey = input.analysisKey;
      return reveal(input.entity, {
        outOfRange: folded(input.entity, input.retainedNodeIds),
        drill: input.mode === 'neighbourhood',
      });
    },

    reconcileAnalysis(input) {
      // One alignment per analysis: the same reading arriving again (another
      // render, another knob change) must not re-centre the drawing.
      if (reconciledAnalysisKey === input.analysisKey) return null;
      reconciledAnalysisKey = input.analysisKey;
      if (anchorEntity === null || !input.nodeIds.includes(anchorEntity)) return null;
      return reveal(anchorEntity, {
        outOfRange: folded(anchorEntity, input.retainedNodeIds),
        drill: anchorMode === 'neighbourhood',
      });
    },

    resetReconcile() {
      reconciledAnalysisKey = null;
    },

    reveal,

    layoutHoverHint(input) {
      const placement = placeHoverHint({
        container: input.container,
        hint: input.hint,
        obstacles: input.obstacles,
        ...(input.margin === undefined ? {} : { margin: input.margin }),
      });
      const next = { left: placement.left, top: placement.top };
      if (
        hoverHintPosition !== null
        && hoverHintPosition.left === next.left
        && hoverHintPosition.top === next.top
      ) {
        return;
      }
      hoverHintPosition = next;
      publish();
    },

    clearHoverHint() {
      if (hoverHintPosition === null) return;
      hoverHintPosition = null;
      publish();
    },

    dispose() {
      cancelDebounce();
      cancelDwell();
    },
  };
}
