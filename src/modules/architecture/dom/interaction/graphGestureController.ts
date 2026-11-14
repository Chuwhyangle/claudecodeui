/**
 * The architecture canvas's gesture owner.
 *
 * WHY A CONTROLLER. `PlantUmlGraph` registers its native pointer/key listeners
 * once per mount, while the callbacks and readings those listeners need change
 * on every parent render. That used to be served by ten `useRef` callback slots
 * (`hoverCallbackRef`, `clickCallbackRef`, `edgeClickCallbackRef`,
 * `selectionClearCallbackRef`, `escapeSelectionCallbackRef`,
 * `toggleNodeCallbackRef`, `toggleEdgeCallbackRef`,
 * `multiSelectStartCallbackRef`, `boxSelectCallbackRef`, `drawnCallbackRef`)
 * plus the gesture readings around them: the touch multi-select mode, whether
 * Shift is held, the one-click suppression, the marquee rectangle, its copy in
 * client pixels, the pointer tier and the last drawn layout. Every new gesture
 * added another pair of declarations.
 *
 * Here one owner keeps the readings in closure state, and one `setHandlers`
 * write path replaces all ten slots: the listeners read `getHandlers()` at fire
 * time, which is what the mirrored refs used to provide. The rules it owns:
 *
 * - A Shift+drag on a fine pointer is a marquee: a rectangle in canvas space
 *   that follows the pointer and, on release, reports the drawn items it hit
 *   (through the injected box hit test). A drag that never travelled stays an
 *   ordinary additive click.
 * - A gesture that already acted on release — the marquee, or the touch
 *   long-press that starts multi-select — suppresses exactly ONE trailing
 *   click, because the browser still sends one after the pointer sequence.
 * - Shift/Ctrl/Cmd, or any press while the touch multi-select mode is on, make
 *   a click additive (toggle a member) rather than replace the selection.
 * - A coarse pointer resolves a press through the enlarged 44px node targets
 *   instead of the small drawn shape.
 * - Every event is ignored after `dispose()`.
 *
 * The DOM measurements the rules need (the canvas origin, the marquee hit test,
 * the coarse node hit test) are injected, so the controller is testable without
 * React or a live drawing.
 *
 * Consumers: `PlantUmlGraph.tsx` (the canvas) and
 * `tests/graphGestureController.test.ts`.
 */
import { createExternalStore } from '@/shared/utils';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureRendererEdge,
  ArchitectureRendererHover,
  ArchitectureRendererNode,
} from '@/modules/architecture/dom/rendererContract';
import type { ArchitectureSelection, ArchitectureSelectionRect } from '@/modules/architecture/dom/interaction/selectionModel';

/** The marquee rectangle in the canvas's coordinates; null while no drag runs. */
export type GraphGestureMarquee = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/** Everything the canvas renders from the gesture owner. */
export type GraphGestureSnapshot = {
  /** The marquee rectangle, in canvas coordinates; null when not dragging. */
  readonly marquee: GraphGestureMarquee | null;
};

/**
 * The panel's gesture callbacks, handed over in one write. A slot is optional:
 * a renderer embedded without a tray or a curation store keeps the gesture it
 * had, and the gesture owner falls back to the next rule.
 */
export type GraphGestureHandlers = {
  readonly onNodeHover?: (hover: ArchitectureRendererHover | null) => void;
  readonly onNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onEdgeClick?: (edge: ArchitectureRendererEdge) => void;
  readonly onSelectionClear?: () => void;
  readonly onEscapeSelection?: () => void;
  readonly onToggleNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onToggleEdgeClick?: (edge: ArchitectureRendererEdge) => void;
  readonly onMultiSelectStart?: (node: ArchitectureRendererNode) => void;
  readonly onBoxSelect?: (selections: readonly ArchitectureSelection[]) => void;
  readonly onDrawnChange?: (drawn: ArchitectureDrawnPlantUml | null) => void;
};

/** A pointer press, in the shape a DOM PointerEvent provides. */
export type GraphGesturePress = {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly clientX: number;
  readonly clientY: number;
};

/** A pointer move, narrowed to what the marquee reads. */
export type GraphGestureMove = {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
};

/** The modifier keys a click reads; multi-select mode is added by the owner. */
export type GraphGestureClickModifiers = {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
};

/** The commands and subscription surface `PlantUmlGraph` drives. */
export type GraphGestureController = {
  /** Registers a listener; the returned function unsubscribes it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The stable snapshot; its identity changes only when the marquee changed. */
  readonly getSnapshot: () => GraphGestureSnapshot;
  /** The ONE write path for the callback slots. */
  readonly setHandlers: (handlers: GraphGestureHandlers) => void;
  /** The current callbacks; listeners read this at fire time, never at registration. */
  readonly getHandlers: () => GraphGestureHandlers;
  /** Whether taps are toggles (the touch multi-select mode is on). */
  readonly setMultiSelectMode: (on: boolean) => void;
  /** Records the pointer tier the drawing was laid out for. */
  readonly setCoarsePointer: (coarse: boolean) => void;
  /** Whether the current tier is a coarse (touch) pointer. */
  readonly isCoarsePointer: () => boolean;
  /** Records whether Shift is held, from a window CAPTURE listener. */
  readonly recordModifier: (shiftKey: boolean) => void;
  /** Whether Shift is held (the drag-pan predicate reads this). */
  readonly isShiftHeld: () => boolean;
  /** Additive means Shift/Ctrl/Cmd, or any press while multi-select is on. */
  readonly isAdditiveClick: (event: GraphGestureClickModifiers) => boolean;
  /** Forgets the next click (a gesture already acted on release). */
  readonly suppressNextClick: () => void;
  /** Reads and clears the suppression; true once per suppressed click. */
  readonly consumeSuppressedClick: () => boolean;
  /**
   * Starts the touch multi-select gesture on `node`: suppresses the trailing
   * click and calls the handler. False when no handler is installed, so the
   * canvas can keep its curation menu path.
   */
  readonly startMultiSelect: (node: ArchitectureRendererNode) => boolean;
  /** Starts the marquee; true when this press IS a marquee drag. */
  readonly pointerDown: (event: GraphGesturePress) => boolean;
  /** Moves the marquee; true when the event belonged to the active drag. */
  readonly pointerMove: (event: GraphGestureMove) => boolean;
  /** Releases the marquee and reports the hit set; true when the drag existed. */
  readonly pointerUp: (event: GraphGestureMove) => boolean;
  /** Drops an interrupted drag (pointercancel) without reporting a selection. */
  readonly pointerCancel: (pointerId: number) => void;
  /** The coarse-pointer node hit, or null on a fine pointer / outside every target. */
  readonly resolveCoarseNodeHit: (clientX: number, clientY: number) => string | null;
  /** Stops every notification and callback; a disposed controller is not reusable. */
  readonly dispose: () => void;
};

/** Below this travel a Shift+press is a click, not a marquee. */
const MARQUEE_MIN_TRAVEL_PX = 2;

function marqueeOf(box: ArchitectureSelectionRect, origin: { readonly left: number; readonly top: number }): GraphGestureMarquee {
  return {
    left: box.left - origin.left,
    top: box.top - origin.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
  };
}

function sameMarquee(left: GraphGestureMarquee | null, right: GraphGestureMarquee | null): boolean {
  if (left === null || right === null) return left === right;
  return left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height;
}

/** Builds the one gesture owner for one mounted canvas. */
export function createGraphGestureController(options: {
  /** The positioned parent's client-space origin, for the overlay rectangle. */
  readonly canvasOrigin?: () => { readonly left: number; readonly top: number };
  /** The drawn items a client-space rectangle hits (injected: DOM-free rule). */
  readonly boxHitTest?: (box: ArchitectureSelectionRect) => readonly ArchitectureSelection[];
  /** The 44px target a coarse press resolves to (injected: DOM-free rule). */
  readonly nodeHitTest?: (clientX: number, clientY: number) => string | null;
} = {}): GraphGestureController {
  const canvasOrigin = options.canvasOrigin ?? ((): { left: number; top: number } => ({ left: 0, top: 0 }));
  const boxHitTest = options.boxHitTest ?? ((): readonly ArchitectureSelection[] => []);
  const nodeHitTest = options.nodeHitTest ?? ((): string | null => null);

  let disposed = false;
  let handlers: GraphGestureHandlers = {};
  let multiSelectMode = false;
  let coarsePointer = false;
  let shiftHeld = false;
  // A click the browser sends AFTER a gesture that already acted must not
  // toggle/clear again. Consumed by the very next click.
  let suppressClick = false;
  // The active marquee drag, if any, and the same rectangle in client pixels
  // (the snapshot carries canvas coordinates; the hit test needs client ones).
  let drag: { readonly pointerId: number; readonly startX: number; readonly startY: number } | null = null;
  let clientBox: ArchitectureSelectionRect | null = null;

  const store = createExternalStore<GraphGestureSnapshot>({ marquee: null });

  // The one write path for the rendered reading. A move that lands on the same
  // pixel does not notify, so the canvas does not re-render for it.
  const publishMarquee = (box: ArchitectureSelectionRect | null): void => {
    if (disposed) return;
    const next = box === null ? null : marqueeOf(box, canvasOrigin());
    if (sameMarquee(store.getSnapshot().marquee, next)) return;
    store.set({ marquee: next });
  };

  const boxAt = (startX: number, startY: number, clientX: number, clientY: number): ArchitectureSelectionRect => ({
    left: Math.min(startX, clientX),
    top: Math.min(startY, clientY),
    right: Math.max(startX, clientX),
    bottom: Math.max(startY, clientY),
  });

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setHandlers: (next) => {
      handlers = next;
    },

    getHandlers: () => handlers,

    setMultiSelectMode: (on) => {
      multiSelectMode = on;
    },

    setCoarsePointer: (coarse) => {
      coarsePointer = coarse;
    },

    isCoarsePointer: () => coarsePointer,

    recordModifier: (shiftKey) => {
      shiftHeld = shiftKey;
    },

    isShiftHeld: () => shiftHeld,

    isAdditiveClick: (event) => event.shiftKey || event.ctrlKey || event.metaKey || multiSelectMode,

    suppressNextClick: () => {
      if (disposed) return;
      suppressClick = true;
    },

    consumeSuppressedClick: () => {
      const consumed = suppressClick;
      suppressClick = false;
      return consumed;
    },

    startMultiSelect: (node) => {
      if (disposed) return false;
      const handler = handlers.onMultiSelectStart;
      if (handler === undefined) return false;
      // The click that follows the finger's release is not a second command.
      suppressClick = true;
      handler(node);
      return true;
    },

    pointerDown: (event) => {
      if (disposed) return false;
      // A plain drag is the pan and fingers are the touch gesture controller's:
      // only Shift + the primary button on a fine pointer starts a marquee.
      if (event.pointerType === 'touch' || event.button !== 0 || !event.shiftKey) return false;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
      clientBox = boxAt(event.clientX, event.clientY, event.clientX, event.clientY);
      publishMarquee(clientBox);
      return true;
    },

    pointerMove: (event) => {
      if (disposed || drag === null || drag.pointerId !== event.pointerId) return false;
      clientBox = boxAt(drag.startX, drag.startY, event.clientX, event.clientY);
      publishMarquee(clientBox);
      return true;
    },

    pointerUp: (event) => {
      if (disposed || drag === null || drag.pointerId !== event.pointerId) return false;
      const box = clientBox ?? boxAt(drag.startX, drag.startY, event.clientX, event.clientY);
      drag = null;
      clientBox = null;
      publishMarquee(null);
      // A Shift+press that never travelled is not a marquee; the click listener
      // still owns it as an ordinary additive click.
      if (box.right - box.left < MARQUEE_MIN_TRAVEL_PX && box.bottom - box.top < MARQUEE_MIN_TRAVEL_PX) {
        return true;
      }
      suppressClick = true;
      handlers.onBoxSelect?.(boxHitTest(box));
      return true;
    },

    pointerCancel: (pointerId) => {
      if (disposed || drag === null || drag.pointerId !== pointerId) return;
      drag = null;
      clientBox = null;
      publishMarquee(null);
    },

    resolveCoarseNodeHit: (clientX, clientY) => {
      if (disposed || !coarsePointer) return null;
      return nodeHitTest(clientX, clientY);
    },

    dispose: () => {
      disposed = true;
      drag = null;
      clientBox = null;
      suppressClick = false;
      handlers = {};
    },
  };
}
