/**
 * The architecture canvas's selection and keyboard-navigation owner.
 *
 * WHY A CONTROLLER. `PlantUmlGraph` keeps selection and keyboard navigation
 * alive across DOM listeners that are registered once per mount, an async draw
 * that replaces the SVG, and renders that produce `aria-activedescendant` and
 * the polite announcement. Those readers used to be served by a cluster of
 * `useState` declarations, each mirrored into a `useRef` so a callback could
 * see the latest value: `selectedId`/`selectedRef`, the four panel-selection
 * mirrors, `navigationActive`/`navigationCursorId`/`navigationAnnouncement`
 * and their refs, the focus modality, the context menu, the last pointer type
 * and the last tap. Every new rule added another pair.
 *
 * Here there is one owner. It holds the readings in private closure state, every
 * command writes them through one `publish` path, and `PlantUmlGraph` renders
 * `getSnapshot()` through `useSyncExternalStore` and forwards its events. The
 * component no longer decides when the navigation state changes or which
 * selection the pinned highlight follows.
 *
 * The rules, unchanged from the refs this replaced:
 *
 * - The panel's selection is mirrored for the delegated listeners and the async
 *   draw. `selectedNodeId` is the primary reading the highlight, Delete and the
 *   keyboard cursor follow; the multi-member set is read for membership tests.
 * - The primary selection and the "Drill in" reading are separate on purpose.
 *   A plain click sets both; an additive click only moves the primary, because
 *   a multi-select gesture is not a request to drill. A relation click clears
 *   the primary but leaves the relation mirror for Delete/Escape (the panel's
 *   next prop write is what clears it).
 * - Keyboard navigation is a state, not a scroll: entering sets the cursor and
 *   the landing announcement, moving rewrites both, leaving clears the cursor
 *   and the announcement but remembers the last entity for the next entry.
 * - The focus modality records what produced the canvas focus. Only keyboard
 *   focus enters navigation; a pointer press focuses the host for click-then-
 *   arrow panning and must not paint a ring.
 * - The pointer type of the last press decides whether the trailing click keeps
 *   touch semantics (select only); it is consumed by that click.
 * - The double-tap drill window is measured on the injected clock, so the rule
 *   is testable without sleeping.
 *
 * Consumers: `PlantUmlGraph.tsx` (the canvas) and
 * `tests/graphSelectionController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';
import { DOUBLE_TAP_MS } from '@/modules/architecture/dom/graphConstants';

/** One relation, in the shape the renderer's callbacks and menus use. */
export type GraphSelectionRelation = {
  readonly from: string;
  readonly to: string;
  readonly relationType: string;
};

/**
 * The panel's current selection, as handed down through props. The renderer
 * mirrors it because its listeners and its async draw run outside the render
 * that produced the props.
 */
export type GraphPanelSelection = {
  /** The primary node the panel selected, or null. */
  readonly nodeId: string | null;
  /** The primary relation the panel selected, or null. */
  readonly relation: GraphSelectionRelation | null;
  /** The multi-select member set the panel holds (entities). */
  readonly nodeIds: readonly string[];
  /** The multi-select member set the panel holds (relations). */
  readonly relations: readonly GraphSelectionRelation[];
};

/** The pin/remove menu: right-click on a node or a relation, position in canvas space. */
export type GraphContextMenu =
  | { readonly x: number; readonly y: number; readonly nodeId: string }
  | { readonly x: number; readonly y: number; readonly edge: GraphSelectionRelation }
  | null;

/** What produced the focus the canvas is about to receive. */
export type GraphFocusModality = 'keyboard' | 'pointer';

/** Everything `PlantUmlGraph` renders (and its delegated listeners re-read). */
export type GraphSelectionSnapshot = {
  /** The panel's selection mirrors; see {@link GraphPanelSelection}. */
  readonly panel: GraphPanelSelection;
  /** The primary node the highlight, Delete and the keyboard cursor follow. */
  readonly primaryNodeId: string | null;
  /** The node the "Drill in" action reads; an additive click leaves it alone. */
  readonly drillNodeId: string | null;
  /** Whether the drillable selection came from a touch tap. */
  readonly selectedByTouch: boolean;
  /** The last entity the keyboard cursor stood on, used as the next entry point. */
  readonly keyboardFocusId: string | null;
  /** Whether the canvas is in its entity-navigation state. */
  readonly navigationActive: boolean;
  /** The entity or `package::<path>` item the keyboard cursor stands on. */
  readonly navigationCursorId: string | null;
  /** The polite live-region sentence for the cursor / last selection action. */
  readonly navigationAnnouncement: string;
  /** Which input modality is about to focus the canvas. */
  readonly focusModality: GraphFocusModality;
  /** The open pin/remove menu, or null while it is shut. */
  readonly contextMenu: GraphContextMenu;
};

/** The commands and subscription surface `PlantUmlGraph` drives. */
export type GraphSelectionController = {
  /** Registers a listener; the returned function unsubscribes it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The stable snapshot; its identity changes only when a reading changed. */
  readonly getSnapshot: () => GraphSelectionSnapshot;
  /** Takes the panel's prop selection as the new mirror and primary reading. */
  readonly syncPanelSelection: (panel: GraphPanelSelection) => void;
  /** A plain click/selection: primary and drillable reading, with its modality. */
  readonly selectNode: (nodeId: string, byTouch: boolean) => void;
  /** An additive click or Shift+Enter: moves the primary, leaves drilling alone. */
  readonly addToSelection: (nodeId: string) => void;
  /** A relation click: clears the primary and mirrors the relation. */
  readonly selectRelation: (relation: GraphSelectionRelation) => void;
  /** A background click or a graph swap that dropped the selected entity. */
  readonly clearSelection: () => void;
  /** A sibling panel's focus request: selects the node without touch semantics. */
  readonly focusNode: (nodeId: string) => void;
  /** Enters entity navigation on `cursorId` with its announcement. */
  readonly enterNavigation: (cursorId: string, announcement: string) => void;
  /** Leaves entity navigation; the last entity stays remembered. */
  readonly exitNavigation: () => void;
  /** Moves the navigation cursor; `remember` keeps it as the next entry point. */
  readonly moveNavigationCursor: (
    cursorId: string,
    announcement: string,
    remember: boolean,
  ) => void;
  /** Replaces the live-region sentence without moving the cursor. */
  readonly announce: (announcement: string) => void;
  /** Records what produced the focus the canvas is about to receive. */
  readonly setFocusModality: (modality: GraphFocusModality) => void;
  /** Opens the pin/remove menu at a canvas position. */
  readonly openContextMenu: (menu: Exclude<GraphContextMenu, null>) => void;
  /** Shuts the pin/remove menu. */
  readonly closeContextMenu: () => void;
  /** Records the pointer type of the press that precedes the next click. */
  readonly recordPointerType: (pointerType: string | null) => void;
  /** Reads and clears the recorded pointer type (the click consumes it). */
  readonly consumePointerType: () => string | null;
  /** Records a tap; true when it completes a double tap on the same node. */
  readonly registerTap: (nodeId: string) => boolean;
  /** Stops every notification; a disposed controller is not reusable. */
  readonly dispose: () => void;
};

const EMPTY_PANEL_SELECTION: GraphPanelSelection = {
  nodeId: null,
  relation: null,
  nodeIds: [],
  relations: [],
};

function panelsEqual(left: GraphPanelSelection, right: GraphPanelSelection): boolean {
  return left.nodeId === right.nodeId
    && left.relation === right.relation
    && left.nodeIds === right.nodeIds
    && left.relations === right.relations;
}

/** Builds the one owner for one mounted canvas. */
export function createGraphSelectionController(options: {
  /**
   * The double-tap reading's only time source; a test injects a fake one. A
   * narrowed {@link Clock} so a fake never has to implement timers it does not
   * use.
   */
  clock?: Pick<Clock, 'now'>;
} = {}): GraphSelectionController {
  const clock = options.clock ?? defaultClock;

  let disposed = false;
  let panel: GraphPanelSelection = EMPTY_PANEL_SELECTION;
  let primaryNodeId: string | null = null;
  let drillNodeId: string | null = null;
  let selectedByTouch = false;
  let keyboardFocusId: string | null = null;
  let navigationActive = false;
  let navigationCursorId: string | null = null;
  let navigationAnnouncement = '';
  let focusModality: GraphFocusModality = 'keyboard';
  let contextMenu: GraphContextMenu = null;
  // Not part of the rendered snapshot: the press/click pair that reads them is
  // synchronous, so they only have to survive between the two listeners.
  let lastPointerType: string | null = null;
  let lastTap: { readonly id: string; readonly at: number } | null = null;

  const buildSnapshot = (): GraphSelectionSnapshot => ({
    panel,
    primaryNodeId,
    drillNodeId,
    selectedByTouch,
    keyboardFocusId,
    navigationActive,
    navigationCursorId,
    navigationAnnouncement,
    focusModality,
    contextMenu,
  });

  // The one write path. A command that changes nothing does not notify, so a
  // pointer move or a repeated Escape never re-renders the canvas.
  const store = createExternalStore<GraphSelectionSnapshot>(buildSnapshot());
  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      panelsEqual(previous.panel, next.panel)
      && previous.primaryNodeId === next.primaryNodeId
      && previous.drillNodeId === next.drillNodeId
      && previous.selectedByTouch === next.selectedByTouch
      && previous.keyboardFocusId === next.keyboardFocusId
      && previous.navigationActive === next.navigationActive
      && previous.navigationCursorId === next.navigationCursorId
      && previous.navigationAnnouncement === next.navigationAnnouncement
      && previous.focusModality === next.focusModality
      && previous.contextMenu === next.contextMenu
    ) {
      return;
    }
    store.set(next);
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    syncPanelSelection: (next) => {
      panel = next;
      primaryNodeId = next.nodeId;
      publish();
    },

    selectNode: (nodeId, byTouch) => {
      primaryNodeId = nodeId;
      drillNodeId = nodeId;
      selectedByTouch = byTouch;
      publish();
    },

    addToSelection: (nodeId) => {
      // The multi-select gesture joins the panel's set; it is not a drill
      // request, so the drillable reading and its modality stay untouched.
      primaryNodeId = nodeId;
      publish();
    },

    selectRelation: (relation) => {
      panel = { ...panel, relation };
      primaryNodeId = null;
      drillNodeId = null;
      selectedByTouch = false;
      publish();
    },

    clearSelection: () => {
      primaryNodeId = null;
      drillNodeId = null;
      selectedByTouch = false;
      publish();
    },

    focusNode: (nodeId) => {
      primaryNodeId = nodeId;
      drillNodeId = nodeId;
      selectedByTouch = false;
      publish();
    },

    enterNavigation: (cursorId, announcement) => {
      navigationActive = true;
      navigationCursorId = cursorId;
      navigationAnnouncement = announcement;
      keyboardFocusId = cursorId;
      publish();
    },

    exitNavigation: () => {
      navigationActive = false;
      navigationCursorId = null;
      navigationAnnouncement = '';
      publish();
    },

    moveNavigationCursor: (cursorId, announcement, remember) => {
      navigationCursorId = cursorId;
      navigationAnnouncement = announcement;
      // A package frame is a place, not an entity: re-entering navigation must
      // not start on a frame whose entity set the next drawing may not contain.
      if (remember) keyboardFocusId = cursorId;
      publish();
    },

    announce: (announcement) => {
      navigationAnnouncement = announcement;
      publish();
    },

    setFocusModality: (modality) => {
      focusModality = modality;
      publish();
    },

    openContextMenu: (menu) => {
      contextMenu = menu;
      publish();
    },

    closeContextMenu: () => {
      contextMenu = null;
      publish();
    },

    recordPointerType: (pointerType) => {
      lastPointerType = pointerType;
    },

    consumePointerType: () => {
      const pointerType = lastPointerType;
      lastPointerType = null;
      return pointerType;
    },

    registerTap: (nodeId) => {
      const now = clock.now();
      const previous = lastTap;
      lastTap = { id: nodeId, at: now };
      if (previous !== null && previous.id === nodeId && now - previous.at <= DOUBLE_TAP_MS) {
        lastTap = null;
        return true;
      }
      return false;
    },

    dispose: () => {
      disposed = true;
    },
  };
}
