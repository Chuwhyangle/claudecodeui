/**
 * The architecture canvas's zoom, viewport and auto-fit owner.
 *
 * WHY AN OWNER. Zoom used to be a `useState` plus a mirrored `useRef`, the SVG
 * viewport controller lived in another ref, and the auto-fit timer was started
 * in one effect and cleared in another. The rules about WHEN the drawing
 * follows the canvas were spread across the draw path, the resize observer, the
 * fullscreen-insets effect and the Fit-token effect. Here there is one mutable
 * reading plus one cached snapshot, one debounce timer, and one write path per
 * command; `PlantUmlGraph` only renders `getSnapshot()` and forwards the host's
 * measurements.
 *
 * The rules, unchanged from the component this replaced:
 *
 * - `auto` is the sticky fit state: a canvas size change (or a changed
 *   fullscreen inset) re-solves the scale after a debounce.
 * - Any explicit zoom flips the state to `manual` and cancels a pending
 *   auto-fit; a manual scale is never overwritten by a later resize.
 * - A Fit request token is answered at most once, and only while the drawing is
 *   in `auto` mode unless the request is forced (a fresh analysis).
 * - The zoom step is clamped to the viewport's supported range.
 * - `dispose` clears the debounce timer; it is idempotent and leaves the
 *   controller able to be re-armed, because React's dev StrictMode runs an
 *   effect cleanup and re-runs the effect on the same instance.
 *
 * The clock, the "control arm disabled auto-fit" reading and the two DOM-bound
 * actions (semantic/CSS fit and the CSS re-solve) are injected, so the rules are
 * testable without React and without a laid-out browser.
 *
 * Consumers: `PlantUmlGraph` and `tests/graphViewportController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';
import {
  clampZoomScale,
  type SvgFitAreaInsets,
  type SvgViewportAnchor,
  type SvgViewportController,
  type SvgViewportSize,
} from '@/modules/architecture/layout/engine/svgViewport';

/** Whether the drawing follows the canvas (`auto`) or keeps a reader-chosen scale. */
export type GraphZoomMode = 'auto' | 'manual';

/** The drawing's presentation scale and its sticky-fit state. */
export type GraphZoom = {
  readonly scale: number;
  readonly fit: GraphZoomMode;
};

/** The vocabulary the panel already reads for `data-architecture-zoom-mode`. */
export type GraphZoomModeReading = 'fit' | 'custom';

/** The host padding that realises the overlay's measured Fit area. */
export type GraphViewportInsets = SvgFitAreaInsets;

/** A width/height reading of the canvas or of a Fit area. */
export type GraphViewportBox = SvgViewportSize;

/** Everything `PlantUmlGraph` renders from; replaced only when a reading changes. */
export type GraphViewportSnapshot = {
  readonly zoom: GraphZoom;
  readonly packageFocus: string | null;
  readonly fullscreenInsets: GraphViewportInsets | null;
  readonly fitViewport: GraphViewportBox | null;
};

/**
 * The DOM-bound work the owner cannot do itself. `PlantUmlGraph` supplies all
 * three; the owner decides WHEN they run.
 */
export type GraphViewportActions = {
  /** Solve and apply the whole-graph Fit for the drawing on screen. */
  fit(): void;
  /** Re-solve the `auto` fit after the debounce (semantic or CSS path). */
  autoFit(): void;
  /** Publish the panel-facing mode whenever it changes. */
  onZoomModeChange?: (mode: GraphZoomModeReading) => void;
};

/** A panel Fit request: one token may be answered at most once. */
export type GraphViewportFitRequest = {
  readonly token: number;
  /** A fresh drawing replaced the one the reader had zoomed, so Fit wins. */
  readonly force?: boolean;
};

/** The injected seams; production uses the defaults. */
export type GraphViewportControllerDeps = {
  /** The timer seam, so the debounce is testable without sleeping. */
  readonly clock?: Clock;
  /** How long a canvas size change settles before an `auto` fit re-solves. */
  readonly debounceMs?: number;
  /** The DEV control arm's "auto refit off" reading, read at fire time. */
  readonly autoFitDisabled?: () => boolean;
  /** The first drawing's scale before any Fit has run. */
  readonly initialZoom?: Partial<GraphZoom>;
};

/** The owner's full surface: a snapshot to subscribe to, commands, and lifecycle. */
export type GraphViewportController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => GraphViewportSnapshot;
  /** Replace the DOM-bound actions. Called on every render; safe to repeat. */
  setActions(actions: GraphViewportActions): void;
  /** Record a scale solved elsewhere (Fit, the semantic engine, plain CSS). */
  setZoom(next: GraphZoom): boolean;
  /** Apply an explicit scale (clamped) and leave `auto` mode. Returns what was applied. */
  zoomTo(scale: number): number;
  /** Multiply the current scale (clamped) and leave `auto` mode. */
  zoomBy(factor: number, anchor?: SvgViewportAnchor): number;
  /** Answer a panel Fit request at most once. Returns whether `fit` ran. */
  requestFit(request: GraphViewportFitRequest | null): boolean;
  setPackageFocus(packageId: string | null): void;
  /** Store the overlay's insets; a change re-schedules the `auto` fit. */
  setFullscreenInsets(insets: GraphViewportInsets | null): void;
  /** Publish the box the last Fit solved against (`data-architecture-fit-viewport`). */
  reportFitViewport(box: GraphViewportBox | null): void;
  /** Remember the last non-fullscreen canvas box (the control arm reads it). */
  reportFlowViewport(box: GraphViewportBox | null): void;
  lastFlowViewport(): GraphViewportBox | null;
  /** Restart the debounce; inert unless the drawing is in `auto` mode. */
  scheduleAutoFit(): void;
  /** Point the owner at the SVG viewport controller, or `null` on unmount. */
  attachViewport(viewport: SvgViewportController | null): void;
  viewport(): SvgViewportController | null;
  /** Clear the debounce timer. The owner can be re-armed afterwards. */
  dispose(): void;
};

/** The shipped debounce: long enough to coalesce a resize burst, short enough to feel live. */
const DEFAULT_AUTO_FIT_DEBOUNCE_MS = 150;

/** Whether two length readings differ by less than half a CSS pixel. */
function sameLength(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

function sameInsets(a: GraphViewportInsets | null, b: GraphViewportInsets | null): boolean {
  if (a === null || b === null) return a === b;
  return sameLength(a.top, b.top)
    && sameLength(a.right, b.right)
    && sameLength(a.bottom, b.bottom)
    && sameLength(a.left, b.left);
}

function sameBox(a: GraphViewportBox | null, b: GraphViewportBox | null): boolean {
  if (a === null || b === null) return a === b;
  return sameLength(a.width, b.width) && sameLength(a.height, b.height);
}

/**
 * Create the zoom/viewport owner. One instance per mounted canvas: the reading
 * outlives a single drawing (the renderer replaces the `<svg>` wholesale) but
 * not the mount.
 */
export function createGraphViewportController(
  deps: GraphViewportControllerDeps = {},
): GraphViewportController {
  const clock = deps.clock ?? defaultClock;
  const debounceMs = deps.debounceMs ?? DEFAULT_AUTO_FIT_DEBOUNCE_MS;
  const autoFitDisabled = deps.autoFitDisabled ?? ((): boolean => false);

  const store = createExternalStore<GraphViewportSnapshot>({
    zoom: { scale: deps.initialZoom?.scale ?? 1, fit: deps.initialZoom?.fit ?? 'auto' },
    packageFocus: null,
    fullscreenInsets: null,
    fitViewport: null,
  });

  let viewport: SvgViewportController | null = null;
  let lastFlowViewport: GraphViewportBox | null = null;
  let answeredFitToken: number | null = null;
  let timer: unknown = null;
  let actions: GraphViewportActions | null = null;
  // `null` means "not reported yet", so the first `setActions` always states the mode.
  let lastReportedMode: GraphZoomModeReading | null = null;

  const current = (): GraphViewportSnapshot => store.getSnapshot();

  const publish = (changes: Partial<GraphViewportSnapshot>): void => {
    store.update((snapshot) => ({ ...snapshot, ...changes }));
  };

  const reportMode = (): void => {
    const reading: GraphZoomModeReading = current().zoom.fit === 'auto' ? 'fit' : 'custom';
    if (reading === lastReportedMode) return;
    lastReportedMode = reading;
    actions?.onZoomModeChange?.(reading);
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };

  const setZoom = (next: GraphZoom): boolean => {
    const zoom = current().zoom;
    if (next.scale === zoom.scale && next.fit === zoom.fit) return false;
    publish({ zoom: { scale: next.scale, fit: next.fit } });
    reportMode();
    return true;
  };

  const scheduleAutoFit = (): void => {
    if (current().zoom.fit !== 'auto') return;
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      // Read the mode at FIRE time: an explicit zoom after the schedule cancels
      // the pending refit even though the timer was already armed.
      if (current().zoom.fit !== 'auto') return;
      if (autoFitDisabled()) return;
      actions?.autoFit();
    }, debounceMs);
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setActions(next: GraphViewportActions): void {
      actions = next;
      reportMode();
    },

    setZoom,

    zoomTo(scale: number): number {
      const clamped = clampZoomScale(scale);
      const applied = viewport === null ? clamped : viewport.zoomTo(clamped);
      setZoom({ scale: applied, fit: 'manual' });
      return applied;
    },

    zoomBy(factor: number, anchor?: SvgViewportAnchor): number {
      // The viewport keeps its own anchored-zoom reading; without one, the
      // owner's snapshot is the only scale it has.
      const applied = viewport === null
        ? clampZoomScale(current().zoom.scale * factor)
        : viewport.zoomBy(factor, anchor);
      setZoom({ scale: applied, fit: 'manual' });
      return applied;
    },

    requestFit(request: GraphViewportFitRequest | null): boolean {
      if (request === null) return false;
      // Recorded BEFORE the mode check: a request the manual mode declines is
      // still this token's one answer, so a re-render cannot fit later.
      if (answeredFitToken === request.token) return false;
      answeredFitToken = request.token;
      if (current().zoom.fit !== 'auto' && request.force !== true) return false;
      if (actions === null) return false;
      actions.fit();
      return true;
    },

    setPackageFocus(packageId: string | null): void {
      if (current().packageFocus === packageId) return;
      publish({ packageFocus: packageId });
    },

    setFullscreenInsets(insets: GraphViewportInsets | null): void {
      if (sameInsets(current().fullscreenInsets, insets)) return;
      publish({ fullscreenInsets: insets });
      // Entering the overlay changes the Fit area without necessarily changing
      // the host's box, so the inset change is its own re-fit trigger.
      if (insets !== null) scheduleAutoFit();
    },

    reportFitViewport(box: GraphViewportBox | null): void {
      if (box === null || !(box.width > 0) || !(box.height > 0)) return;
      if (sameBox(current().fitViewport, box)) return;
      publish({ fitViewport: { width: box.width, height: box.height } });
    },

    reportFlowViewport(box: GraphViewportBox | null): void {
      lastFlowViewport = box === null ? null : { width: box.width, height: box.height };
    },

    lastFlowViewport(): GraphViewportBox | null {
      return lastFlowViewport === null ? null : { ...lastFlowViewport };
    },

    scheduleAutoFit,

    attachViewport(next: SvgViewportController | null): void {
      viewport = next;
    },

    viewport(): SvgViewportController | null {
      return viewport;
    },

    dispose(): void {
      clearTimer();
    },
  };
}
