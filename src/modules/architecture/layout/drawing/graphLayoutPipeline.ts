/**
 * The architecture canvas's layout pipeline owner: WHICH detail tier is drawn,
 * whether the drawing is re-laid out for a new container shape, and which
 * direction that layout is drawn in.
 *
 * WHY AN OWNER. The semantic-zoom tier, the folded depth, the applied layout,
 * the aspect debounce timer, the orientation cache and the relayout lock used
 * to be a cluster of `useState`/`useRef` fields spread through
 * `PlantUmlGraph.tsx` (about 25 declarations), with the rules about when a
 * re-layout may run living in four different effects. Here every reading and
 * every timer has one home and one write path per command; the component
 * renders `getSnapshot()` and supplies the DOM-bound work (solving and writing
 * a layout onto the SVG) through injected actions.
 *
 * The rules, unchanged from the component this replaced:
 *
 * - A new drawing drops the previous semantic layout; its semantic pass runs
 *   synchronously so it never flashes at the wrong detail.
 * - A manual zoom is coalesced by the LOD debouncer: a wheel burst produces
 *   ONE semantic application, reading the settled scale at fire time.
 * - A container shape change earns a new layout only past
 *   `ASPECT_RELAYOUT_THRESHOLD`, and only after the container has settled for
 *   `ASPECT_RELAYOUT_DEBOUNCE_MS`; a smaller resize only re-fits.
 * - `lockRelayout` freezes that decision during a dock transition. Lifting the
 *   lock reconciles the container's ratio ONCE by making it the new comparison
 *   base, so the transition itself is never counted as a shape change (pinned
 *   by `layoutAspect.test.tsx`); a genuine later change still earns one layout.
 * - The orientation decision is cached per graph + canvas band, so a
 *   shape-driven re-layout of the same drawing renders only the chosen
 *   direction instead of laying the graph out twice again.
 * - `dispose` clears the debounce timer and any pending LOD application; it is
 *   idempotent and leaves the owner re-armable, because React's dev StrictMode
 *   runs an effect cleanup and re-runs the effect on the same instance.
 *
 * The clock, the two layout solvers (`solveFitScale` / `solveSemanticZoom`), the
 * LOD scheduler and the DOM-bound actions are injected, so every rule above is
 * testable without React and without a laid-out browser.
 *
 * Consumers: `PlantUmlGraph.tsx` and `tests/graphLayoutPipeline.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';
import {
  ASPECT_RELAYOUT_DEBOUNCE_MS,
  shouldRelayoutForAspect,
} from '@/modules/architecture/layout/engine/elkAspectEngine';
import {
  createExplosionLodScheduler,
  type ExplosionLodScheduler,
} from '@/modules/architecture/dom/planning/explosionLod';
import type { SemanticCapture } from '@/modules/architecture/layout/drawing/graphDom';
import {
  chooseLayoutOrientation,
  createOrientationCache,
  orientationCacheKey,
  shouldAttemptDualLayout,
  ORIENTATION_REASON,
  type LayoutOrientation,
  type OrientationDecision,
  type OrientationSize,
} from '@/modules/architecture/dom/planning/layoutOrientation';
import { READABLE_ZOOM_SCALE } from '@/modules/architecture/layout/engine/readableZoom';
import {
  lodDepthForTier,
  solveFitScale,
  solveSemanticZoom,
  type SemanticTier,
  type SemanticZoomLayout,
} from '@/modules/architecture/layout/engine/semanticZoomLayout';
import { SEMANTIC_MIN_FONT_PX } from '@/modules/architecture/dom/planning/semanticZoomPlan';
import type { SvgViewportSize } from '@/modules/architecture/layout/engine/svgViewport';

/** One measured layout of a drawing kind: how many entities, and how long ELK took. */
export type LayoutSample = { readonly nodes: number; readonly ms: number };

/**
 * The layout cost, per entity, a drawing with NO measured sample is assumed to
 * pay. Calibrated on the reported project (573 functions in 17.6 s ≈ 31 ms per
 * entity on this machine), rounded DOWN on purpose: the estimate only decides
 * whether to say "laying out", and a false positive costs the reader a status
 * line for the length of a fast layout, while a false negative leaves a
 * 17-second blank canvas unexplained.
 */
const LAYOUT_MS_PER_ENTITY_FALLBACK = 4;

/**
 * How long a layout is expected to take before the canvas says so. Below this
 * the status would flash and be noise; above it the reader has time to wonder
 * whether the click did anything.
 *
 * Consumers: `PlantUmlGraph.tsx` (the draw pipeline) and
 * `tests/graphLayoutPipeline.test.ts`.
 */
export const LAYOUT_STATUS_THRESHOLD_MS = 1000;

/**
 * The expected duration of a layout of `nodes` entities, from the entity count
 * and the LAST layout of the same drawing kind (`sample`).
 *
 * Both inputs matter: a project whose drawings are consistently slow shows the
 * status earlier than its entity count alone would suggest, and a fast one
 * never hides a genuinely slow layout behind a low sample. The measured
 * per-entity cost is therefore used only when it is ABOVE the shipped floor — a
 * sample from a small, fast drawing must not talk the canvas out of announcing
 * a large one.
 */
export function estimateLayoutMs(nodes: number, sample: LayoutSample | null): number {
  if (!Number.isFinite(nodes) || nodes <= 0) return 0;
  const measured = sample !== null && sample.nodes > 0 && Number.isFinite(sample.ms)
    ? sample.ms / sample.nodes
    : 0;
  return nodes * Math.max(measured, LAYOUT_MS_PER_ENTITY_FALLBACK);
}

/** A semantic application: `fit` asks for the largest scale that fits, else the requested scale. */
export type GraphSemanticRequest = {
  readonly fit: boolean;
  readonly scale: number;
};

/** What one semantic solve produced; the action writes it onto the drawing. */
export type GraphLayoutCommit = {
  readonly capture: SemanticCapture;
  readonly layout: SemanticZoomLayout;
  readonly fontPx: number;
  /** The scale the drawing is shown at (already mapped into the geometry). */
  readonly scale: number;
  /** Whether the scale was solved by Fit (`auto`) or requested (`manual`). */
  readonly fit: boolean;
  /** A package the reader asked to centre, consumed by this application. */
  readonly centerPackage: string | null;
};

/**
 * The DOM-bound work the owner cannot do itself. `PlantUmlGraph` supplies all
 * of it on every render; the owner decides WHEN each runs.
 */
export type GraphLayoutActions = {
  /** The box the semantic solve measures against (host less its chrome). */
  fitViewport(): SvgViewportSize | null;
  /** Publish that box as the last Fit reading. */
  recordFitViewport(box: SvgViewportSize | null): void;
  /** The minimum font size for the current pointer tier. */
  semanticFontPx(): number;
  /** Write a solved layout onto the drawing and re-pin its DOM readings. */
  commitSemantic(commit: GraphLayoutCommit): void;
  /** Measure the container ratio at the moment a relayout lock lifts. */
  measureAspect(): number | null;
  /** The DEV control arm's retired "unreadable fit opens focused" rule. */
  forcedDefaultFocus(): boolean;
};

/** The two pure layout engines; production uses the real modules. */
export type GraphLayoutSolvers = {
  readonly solveFitScale: typeof solveFitScale;
  readonly solveSemanticZoom: typeof solveSemanticZoom;
};

/** The injected seams; production uses the defaults. */
export type GraphLayoutPipelineDeps = {
  /** The timer seam, so both debounces are testable without sleeping. */
  readonly clock?: Clock;
  /** How long a container shape change settles before a re-layout runs. */
  readonly aspectDebounceMs?: number;
  /** The semantics engine seam. Omitted entries fall back to the real solvers. */
  readonly solvers?: Partial<GraphLayoutSolvers>;
  /** The zoom-burst debouncer factory (a fake drives it from the test's clock). */
  readonly createLodScheduler?: () => ExplosionLodScheduler;
};

/** Everything `PlantUmlGraph` renders from; replaced only when a reading changes. */
export type GraphLayoutSnapshot = {
  readonly semanticCapture: SemanticCapture | null;
  readonly semanticTier: SemanticTier | null;
  readonly appliedLayout: SemanticZoomLayout | null;
  readonly appliedFontPx: number;
  readonly foldDepth: number | null;
  readonly lodDepth: 0 | 1 | 2 | null;
  readonly drawnRevision: number;
  readonly layoutStatusNodes: number | null;
  /** The container ratio the NEXT drawing is laid out for (`null` = measure). */
  readonly layoutAspect: number | null;
  /** The ratio the drawing on screen was laid out with. */
  readonly drawnAspect: number | null;
  readonly layoutDirection: LayoutOrientation | null;
  readonly layoutDirectionReason: string | null;
  readonly clusterExpanded: boolean;
  readonly neighborCenter: string | null;
  readonly relayoutLocked: boolean;
};

/** One rendered candidate for the orientation comparison. */
export type GraphLayoutCandidate<T> = {
  /** The drawing's natural size, or `null` when it is unusable. */
  readonly size: OrientationSize | null;
  /**
   * The semantic fit scale the drawing would earn (a getter: the comparison
   * pays its cost only when a second candidate exists).
   */
  readonly drawnFitScale: () => number | null;
  readonly elapsedMs: number;
  /** The caller's drawing payload; returned verbatim for the chosen side. */
  readonly drawn: T;
};

/** One orientation-policy run: the renderer is the caller's. */
export type GraphOrientationRequest<T> = {
  /** The graph + view identity the cache is keyed by. */
  readonly fingerprint: string;
  /** The measured canvas box, or `null` when it has not been laid out. */
  readonly canvas: OrientationSize | null;
  readonly entities: number;
  /** A DEV-only control arm, or `null` for the shipped policy. */
  readonly forced: LayoutOrientation | null;
  readonly render: (direction: LayoutOrientation) => Promise<GraphLayoutCandidate<T>>;
};

/** What the policy chose, and what it cost. */
export type GraphOrientationOutcome<T> = {
  readonly decision: OrientationDecision;
  readonly drawn: T;
  readonly elapsedMs: number;
  /** Whether the direction came from the cache (one render, no comparison). */
  readonly cacheHit: boolean;
  readonly renders: number;
};

/** The owner's surface: a snapshot to subscribe to, commands, and lifecycle. */
export type GraphLayoutPipeline = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => GraphLayoutSnapshot;
  /** Replace the DOM-bound actions. Called on every render; safe to repeat. */
  setActions(actions: GraphLayoutActions): void;
  /** Report the drawing identity; `true` when it differs from the previous one. */
  observeIdShape(idShape: string): boolean;
  /** A new drawing replaced the previous one: drop its pending application. */
  beginDrawing(): void;
  /** Run the direction policy (cache → forced → dual layout) for one drawing. */
  orientLayout<T>(request: GraphOrientationRequest<T>): Promise<GraphOrientationOutcome<T>>;
  /** Record the drawing that is now in the DOM, and reset the readings it invalidates. */
  markDrawn(input: {
    readonly viewKey: string;
    readonly capture: SemanticCapture | null;
    readonly aspect: number | null;
  }): void;
  /** Solve and apply one semantic layout now. Returns whether it ran. */
  applySemantic(request: GraphSemanticRequest): boolean;
  /** Coalesce a zoom burst into one semantic application; the scale is read at fire time. */
  scheduleSemanticApply(readRequest: () => GraphSemanticRequest): void;
  /** Feed the ResizeObserver's container ratio; a real shape change is debounced. */
  reportAspect(measured: number | null): void;
  /** Freeze aspect-driven re-layout during a dock/split transition. */
  lockRelayout(): void;
  /** Lift the lock, making the container's ratio the new comparison base ONCE. */
  unlockRelayout(): void;
  /** Announce (or clear) the "laying out N entities" status. */
  setLayoutStatus(nodes: number | null): void;
  /** Remember the last layout cost of a drawing kind. */
  recordLayoutSample(idShape: string, sample: LayoutSample): void;
  /** The expected cost of laying out `nodes` of that kind. */
  estimateLayoutMs(idShape: string, nodes: number): number;
  /** Which package the next application should centre, consumed by that application. */
  requestPackageCenter(packageId: string): void;
  /** The neighbourhood's centre entity, re-marked after every rewrite. */
  setNeighborCenter(nodeId: string | null): void;
  /** Open the portrait phone's zoom cluster (the only expansion it has). */
  expandCluster(): void;
  /** Fold the portrait phone's zoom cluster back to its single button. */
  collapseCluster(): void;
  /** Clear the readings a failed render invalidates. */
  failDrawing(): void;
  /** Clear the timers and the pending application; idempotent. */
  dispose(): void;
};

/** A snapshot value's equality, so a publish that changed nothing never notifies. */
function sameSnapshot(a: GraphLayoutSnapshot, b: GraphLayoutSnapshot): boolean {
  return a.semanticCapture === b.semanticCapture
    && a.semanticTier === b.semanticTier
    && a.appliedLayout === b.appliedLayout
    && a.appliedFontPx === b.appliedFontPx
    && a.foldDepth === b.foldDepth
    && a.lodDepth === b.lodDepth
    && a.drawnRevision === b.drawnRevision
    && a.layoutStatusNodes === b.layoutStatusNodes
    && a.layoutAspect === b.layoutAspect
    && a.drawnAspect === b.drawnAspect
    && a.layoutDirection === b.layoutDirection
    && a.layoutDirectionReason === b.layoutDirectionReason
    && a.clusterExpanded === b.clusterExpanded
    && a.neighborCenter === b.neighborCenter
    && a.relayoutLocked === b.relayoutLocked;
}

/**
 * Create the layout pipeline owner.
 *
 * One instance belongs to one mounted renderer (created in a `useMemo`), so the
 * orientation cache and the LOD scheduler live exactly as long as the canvas.
 */
export function createGraphLayoutPipeline(deps: GraphLayoutPipelineDeps = {}): GraphLayoutPipeline {
  const clock = deps.clock ?? defaultClock;
  const aspectDebounceMs = deps.aspectDebounceMs ?? ASPECT_RELAYOUT_DEBOUNCE_MS;
  const solvers: GraphLayoutSolvers = {
    solveFitScale: deps.solvers?.solveFitScale ?? solveFitScale,
    solveSemanticZoom: deps.solvers?.solveSemanticZoom ?? solveSemanticZoom,
  };
  const lodScheduler = deps.createLodScheduler?.() ?? createExplosionLodScheduler();

  let actions: GraphLayoutActions | null = null;
  let idShape: string | null = null;
  let semanticCapture: SemanticCapture | null = null;
  let semanticTier: SemanticTier | null = null;
  let appliedLayout: SemanticZoomLayout | null = null;
  let appliedFontPx = SEMANTIC_MIN_FONT_PX;
  let foldDepth: number | null = null;
  let lodDepth: 0 | 1 | 2 | null = null;
  let drawnRevision = 0;
  let layoutStatusNodes: number | null = null;
  let layoutAspect: number | null = null;
  let drawnAspect: number | null = null;
  let layoutDirection: LayoutOrientation | null = null;
  let layoutDirectionReason: string | null = null;
  let clusterExpanded = false;
  let neighborCenter: string | null = null;
  let relayoutLocked = false;
  let lastMeasuredAspect: number | null = null;
  let aspectTimer: unknown = null;
  let pendingSemantic: (() => GraphSemanticRequest) | null = null;
  let centerPackageOnApply: string | null = null;
  const layoutSamples = new Map<string, LayoutSample>();
  const orientationCache = createOrientationCache();

  const snapshot = (): GraphLayoutSnapshot => ({
    semanticCapture,
    semanticTier,
    appliedLayout,
    appliedFontPx,
    foldDepth,
    lodDepth,
    drawnRevision,
    layoutStatusNodes,
    layoutAspect,
    drawnAspect,
    layoutDirection,
    layoutDirectionReason,
    clusterExpanded,
    neighborCenter,
    relayoutLocked,
  });
  const store = createExternalStore<GraphLayoutSnapshot>(snapshot());

  /** The one write path: every command mutates its fields and publishes here. */
  const publish = (): void => {
    const next = snapshot();
    if (!sameSnapshot(next, store.getSnapshot())) store.set(next);
  };

  const clearAspectTimer = (): void => {
    if (aspectTimer === null) return;
    clock.clearTimeout(aspectTimer);
    aspectTimer = null;
  };

  /** One timer: the latest reading wins, as a window drag emits a stream of sizes. */
  const scheduleAspectRelayout = (aspect: number): void => {
    clearAspectTimer();
    aspectTimer = clock.setTimeout(() => {
      aspectTimer = null;
      layoutAspect = aspect;
      publish();
    }, aspectDebounceMs);
  };

  const recordDirection = (decision: OrientationDecision): void => {
    layoutDirection = decision.direction;
    layoutDirectionReason = decision.reason;
    publish();
  };

  const applySemantic = (request: GraphSemanticRequest): boolean => {
    if (actions === null || semanticCapture === null) return false;
    const capture = semanticCapture;
    const box = actions.fitViewport();
    actions.recordFitViewport(box);
    const fontPx = actions.semanticFontPx();
    let layout: SemanticZoomLayout;
    let solvedScale: number;
    if (request.fit) {
      const fit = solvers.solveFitScale(capture.geometry, { viewport: box, minFontPx: fontPx });
      if (actions.forcedDefaultFocus() && fit.fits) {
        // The DEV control arm's retired rule: the "unreadable fit" opened at the
        // readable floor instead of the solved scale, overflowing the canvas.
        layout = solvers.solveSemanticZoom(capture.geometry, {
          scale: Math.max(fit.scale, READABLE_ZOOM_SCALE),
          viewport: box,
          previousTier: null,
          minFontPx: fontPx,
        });
        solvedScale = layout.scale;
      } else {
        layout = fit.layout;
        solvedScale = fit.scale;
      }
    } else {
      layout = solvers.solveSemanticZoom(capture.geometry, {
        scale: request.scale,
        viewport: box,
        previousTier: semanticTier,
        minFontPx: fontPx,
      });
      solvedScale = layout.scale;
    }
    semanticTier = layout.tier;
    appliedLayout = layout;
    appliedFontPx = fontPx;
    foldDepth = layout.foldDepth;
    lodDepth = lodDepthForTier(layout.tier);
    drawnRevision += 1;
    const centerPackage = centerPackageOnApply;
    centerPackageOnApply = null;
    publish();
    actions.commitSemantic({
      capture,
      layout,
      fontPx,
      scale: solvedScale,
      fit: request.fit,
      centerPackage,
    });
    return true;
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    setActions(next) {
      actions = next;
    },

    observeIdShape(next) {
      if (idShape === next) return false;
      const first = idShape === null;
      idShape = next;
      return !first;
    },

    beginDrawing() {
      pendingSemantic = null;
      lodScheduler.cancel();
      if (layoutStatusNodes !== null) {
        layoutStatusNodes = null;
        publish();
      }
    },

    async orientLayout<T>(request: GraphOrientationRequest<T>): Promise<GraphOrientationOutcome<T>> {
      const cacheKey = request.canvas === null
        ? null
        : orientationCacheKey(request.fingerprint, request.canvas);
      const forced = request.forced;
      // A forced reading is a control arm, not a cached result: it must not be
      // shadowed by a RIGHT decision the same canvas earned a moment ago.
      const cached = forced === null && cacheKey !== null
        ? orientationCache.get(cacheKey)
        : null;

      if (cached !== null) {
        // Cache hit: this drawing was already evaluated for this canvas band, so
        // only its chosen direction is drawn — no comparison layout.
        const candidate = await request.render(cached.direction);
        recordDirection(cached);
        return {
          decision: cached,
          drawn: candidate.drawn,
          elapsedMs: candidate.elapsedMs,
          cacheHit: true,
          renders: 1,
        };
      }

      const canvas = request.canvas;
      if (forced !== null) {
        const candidate = await request.render(forced);
        // A forced arm measures ONE direction, so its fit is the raw geometry of
        // that drawing: there is no second candidate to compare against.
        const decision = chooseLayoutOrientation({
          canvas: canvas ?? { width: 0, height: 0 },
          down: candidate.size ?? { width: 0, height: 0 },
          right: null,
          entities: request.entities,
          firstLayoutMs: candidate.elapsedMs,
          forceDown: forced === 'DOWN',
          forceRight: forced === 'RIGHT',
        });
        recordDirection(decision);
        return { decision, drawn: candidate.drawn, elapsedMs: candidate.elapsedMs, cacheHit: false, renders: 1 };
      }

      const down = await request.render('DOWN');
      const downSize = down.size;
      const eligibility = canvas === null || downSize === null
        ? { attempt: false as const, reason: ORIENTATION_REASON.canvasNotWide }
        : shouldAttemptDualLayout({
            canvas,
            down: downSize,
            entities: request.entities,
            firstLayoutMs: down.elapsedMs,
          });
      if (eligibility.attempt && canvas !== null && downSize !== null) {
        const right = await request.render('RIGHT');
        // Compare the DRAWN fit, not the renderer's pre-reclaim size: the
        // semantic pass reclaims the blank body of frames whose member rows are
        // not drawn, and that is the size the reader sees. Both candidates are
        // solved against the SAME box — the one eligibility just judged — so the
        // comparison is like-for-like.
        const decision = chooseLayoutOrientation({
          canvas,
          down: downSize,
          right: right.size,
          downDrawnFitScale: down.drawnFitScale() ?? undefined,
          rightDrawnFitScale: right.drawnFitScale() ?? undefined,
          entities: request.entities,
          firstLayoutMs: down.elapsedMs,
        });
        const turned = decision.direction === 'RIGHT';
        const chosen = turned ? right : down;
        if (cacheKey !== null) orientationCache.set(cacheKey, decision);
        recordDirection(decision);
        return {
          decision,
          drawn: chosen.drawn,
          elapsedMs: chosen.elapsedMs,
          cacheHit: false,
          renders: 2,
        };
      }
      const decision = chooseLayoutOrientation({
        canvas: canvas ?? { width: 0, height: 0 },
        down: downSize ?? { width: 0, height: 0 },
        right: null,
        entities: request.entities,
        firstLayoutMs: down.elapsedMs,
      });
      recordDirection(decision);
      return { decision, drawn: down.drawn, elapsedMs: down.elapsedMs, cacheHit: false, renders: 1 };
    },

    markDrawn(input) {
      semanticCapture = input.capture;
      appliedLayout = null;
      // A fresh drawing is never carried over from the previous one: its own
      // semantic pass derives the tier from the new geometry.
      semanticTier = null;
      drawnAspect = input.aspect;
      layoutStatusNodes = null;
      neighborCenter = null;
      if (input.capture === null) {
        lodDepth = null;
        foldDepth = null;
      }
      publish();
    },

    applySemantic,

    scheduleSemanticApply(readRequest) {
      pendingSemantic = readRequest;
      lodScheduler.request(() => {
        const read = pendingSemantic;
        pendingSemantic = null;
        if (read === null) return;
        applySemantic(read());
      });
    },

    reportAspect(measured) {
      lastMeasuredAspect = measured;
      if (measured === null) return;
      if (shouldRelayoutForAspect(drawnAspect, measured, { locked: relayoutLocked })) {
        scheduleAspectRelayout(measured);
      }
    },

    lockRelayout() {
      if (relayoutLocked) return;
      relayoutLocked = true;
      publish();
    },

    unlockRelayout() {
      if (!relayoutLocked) return;
      relayoutLocked = false;
      // The lock existed so a transition's intermediate shapes never earn a
      // layout. Lifting it therefore reconciles ONCE by re-basing the drawing's
      // ratio to the container as it now stands, so the transition itself is
      // never counted as a shape change; a genuine later change still does.
      const measured = actions?.measureAspect() ?? lastMeasuredAspect;
      if (measured !== null) drawnAspect = measured;
      lastMeasuredAspect = measured;
      publish();
    },

    setLayoutStatus(nodes) {
      if (layoutStatusNodes === nodes) return;
      layoutStatusNodes = nodes;
      publish();
    },

    recordLayoutSample(kind, sample) {
      layoutSamples.set(kind, sample);
    },

    estimateLayoutMs(kind, nodes) {
      return estimateLayoutMs(nodes, layoutSamples.get(kind) ?? null);
    },

    requestPackageCenter(packageId) {
      centerPackageOnApply = packageId;
    },

    setNeighborCenter(nodeId) {
      if (neighborCenter === nodeId) return;
      neighborCenter = nodeId;
      publish();
    },

    expandCluster() {
      if (clusterExpanded) return;
      clusterExpanded = true;
      publish();
    },

    collapseCluster() {
      if (!clusterExpanded) return;
      clusterExpanded = false;
      publish();
    },

    failDrawing() {
      layoutDirection = null;
      layoutDirectionReason = null;
      layoutStatusNodes = null;
      foldDepth = null;
      publish();
    },

    dispose() {
      pendingSemantic = null;
      lodScheduler.cancel();
      clearAspectTimer();
    },
  };
}
