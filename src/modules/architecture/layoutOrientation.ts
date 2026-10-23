/**
 * The architecture diagram's layout-orientation policy.
 *
 * `elkAspectEngine` hands ELK the container's width/height as an `aspectRatio`,
 * which folds a flat overview into a portrait canvas. It cannot turn a
 * CONNECTED chain around: a layered layout always stacks dependents vertically,
 * so a wide desktop canvas gets a tall drawing and the fit is limited by height
 * (measured 2026-10-23: a 1151×578 canvas drew a 658×537 picture at 72%, using
 * 57% of the width and 93% of the height).
 *
 * This module is the missing second half: lay the SAME graph out twice — once
 * downward (the renderer's default) and, for a small graph on a canvas clearly
 * wider than the drawing, once to the RIGHT — and keep whichever direction the
 * canvas can show larger. The direction is a LAYOUT INPUT (an ELK option), so
 * the chosen picture is drawn for the canvas rather than scaled into it
 * afterwards.
 *
 * Everything here is pure arithmetic: the caller owns the two renders, the
 * cache and the DOM. Consumers: `PlantUmlGraph.tsx` (the render pipeline and
 * the readout) and `tests/layoutAspect.test.tsx`.
 */

/** The two layered-layout directions this policy chooses between. */
export type LayoutOrientation = 'DOWN' | 'RIGHT';

/** A drawn (or available) rectangle, in the same units. */
export type OrientationSize = {
  readonly width: number;
  readonly height: number;
};

/**
 * The canvas-to-drawing aspect ratio beyond which the second layout is worth
 * its cost. Below it the downward drawing is already as wide relative to its
 * height as the canvas, so turning it would not free a binding axis.
 */
export const ORIENTATION_RATIO_THRESHOLD = 1.5;

/**
 * The entity count above which the second layout is skipped. The policy is for
 * the small graphs whose whole shape is one dependency chain; a large drawing's
 * layout is already expensive, and a second pass would double a cost the reader
 * feels (the driver task's DoD watches a >150-entity graph for exactly this).
 */
export const ORIENTATION_DUAL_MAX_ENTITIES = 150;

/**
 * The first layout's measured duration above which the second is skipped. A
 * layout that already took most of a second cannot be repeated on the main
 * thread without turning the first paint into a stall.
 */
export const ORIENTATION_DUAL_MAX_MS = 600;

/**
 * How much better the horizontal fit must be before the drawing is turned.
 * Two directions within this band keep the downward layout, so a graph sitting
 * on the threshold cannot flip back and forth between equivalent shapes.
 */
export const ORIENTATION_FIT_HYSTERESIS = 0.05;

/**
 * The width the canvas-ratio cache band covers. A container that changes shape
 * by less than half this band reuses the last direction decision instead of
 * laying the graph out twice again; the band is coarser than
 * `ASPECT_RELAYOUT_THRESHOLD` so a resize that DOES earn a re-layout can still
 * hit the cache.
 */
export const ORIENTATION_RATIO_BAND = 0.5;

/** The stable reasons a direction was chosen; recorded in the readout and pinned by tests. */
export const ORIENTATION_REASON = {
  /** The canvas/drawing aspect ratio is below the threshold: no second layout. */
  canvasNotWide: 'canvas-not-wide',
  /** The graph has more entities than the dual-layout budget allows. */
  entityBudget: 'entity-budget-exceeded',
  /** The first layout took longer than the dual-layout budget allows. */
  layoutBudget: 'layout-time-budget-exceeded',
  /** The rightward drawing is the larger fit by more than the hysteresis band. */
  horizontalLarger: 'horizontal-fit-larger',
  /** The downward drawing is the larger fit (or the rightward one is smaller). */
  verticalLarger: 'vertical-fit-larger',
  /** The two fits are within the hysteresis band, so the original direction stays. */
  withinHysteresis: 'fit-within-hysteresis',
  /** A DEV-only control arm forced the downward layout. */
  forcedDown: 'forced-down',
} as const;

export type OrientationReason = (typeof ORIENTATION_REASON)[keyof typeof ORIENTATION_REASON];

/** What the caller must know before it may run the second layout. */
export type OrientationEligibilityInput = {
  /** The measured canvas content box. */
  readonly canvas: OrientationSize;
  /** The first (downward) drawing's natural size. */
  readonly down: OrientationSize;
  /** Entities the drawing contains. */
  readonly entities: number;
  /** The first layout's measured duration. */
  readonly firstLayoutMs: number;
};

/** Whether the second layout may run, with the reason either way. */
export type OrientationEligibility = {
  readonly attempt: boolean;
  /** `null` only when `attempt` is true (there is nothing to explain). */
  readonly reason: OrientationReason | null;
};

/** A usable positive dimension. */
function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The uniform scale that fits a drawing into a canvas: `min(canvas ÷ drawing)`
 * over the two axes. Deliberately NOT capped at 1 here: the decision compares
 * two drawings against the same canvas, and the client's own fit cap applies
 * when the chosen drawing is painted. A degenerate size has no fit (0).
 */
export function fitScaleFor(size: OrientationSize, canvas: OrientationSize): number {
  if (!positive(size.width) || !positive(size.height)) return 0;
  if (!positive(canvas.width) || !positive(canvas.height)) return 0;
  return Math.min(canvas.width / size.width, canvas.height / size.height);
}

/**
 * Whether the canvas is clearly wider than the drawing: the quotient of their
 * aspect ratios is at least {@link ORIENTATION_RATIO_THRESHOLD}.
 *
 * Written as a quotient, not a width comparison, so it is independent of the
 * canvas being landscape or portrait: a 2:1 drawing on a 4:1 canvas qualifies,
 * and so does a 0.5:1 drawing on a 1:1 canvas.
 */
export function canvasIsWiderThanDrawing(canvas: OrientationSize, drawn: OrientationSize): boolean {
  if (!positive(canvas.width) || !positive(canvas.height)) return false;
  if (!positive(drawn.width) || !positive(drawn.height)) return false;
  const canvasAspect = canvas.width / canvas.height;
  const drawnAspect = drawn.width / drawn.height;
  return canvasAspect / drawnAspect >= ORIENTATION_RATIO_THRESHOLD;
}

/**
 * Whether the dual layout may run. Entity and duration budgets are checked
 * FIRST: they are affordability limits, and a graph over budget keeps the
 * direction it already has whatever its shape.
 */
export function shouldAttemptDualLayout(input: OrientationEligibilityInput): OrientationEligibility {
  if (input.entities > ORIENTATION_DUAL_MAX_ENTITIES) {
    return { attempt: false, reason: ORIENTATION_REASON.entityBudget };
  }
  if (!Number.isFinite(input.firstLayoutMs) || input.firstLayoutMs > ORIENTATION_DUAL_MAX_MS) {
    return { attempt: false, reason: ORIENTATION_REASON.layoutBudget };
  }
  if (!canvasIsWiderThanDrawing(input.canvas, input.down)) {
    return { attempt: false, reason: ORIENTATION_REASON.canvasNotWide };
  }
  return { attempt: true, reason: null };
}

/** Everything the direction decision reads after both layouts have run. */
export type OrientationDecisionInput = {
  readonly canvas: OrientationSize;
  /** The downward drawing's natural size (the original direction). */
  readonly down: OrientationSize;
  /**
   * The rightward drawing's natural size, or `null` when the second layout did
   * not run (budget, or the canvas was not wide enough).
   */
  readonly right: OrientationSize | null;
  readonly entities: number;
  readonly firstLayoutMs: number;
  /** A DEV-only control arm: never turn the drawing, whatever the numbers say. */
  readonly forceDown?: boolean;
};

/** The chosen direction, why, and the two fits it was chosen from. */
export type OrientationDecision = {
  readonly direction: LayoutOrientation;
  readonly reason: OrientationReason;
  /** Fit scale of the downward drawing (0 when no usable size was supplied). */
  readonly downFitScale: number;
  /** Fit scale of the rightward drawing; `null` when it was not attempted. */
  readonly rightFitScale: number | null;
};

/**
 * Choose the layout direction. Same input → same output: no clocks, no globals.
 *
 * Ties — and gaps inside {@link ORIENTATION_FIT_HYSTERESIS} — keep `DOWN`, the
 * direction the graph was drawn with first. That is what makes the choice
 * stable: turning the drawing must win by a margin a reader could notice.
 */
export function chooseLayoutOrientation(input: OrientationDecisionInput): OrientationDecision {
  const downFitScale = fitScaleFor(input.down, input.canvas);

  if (input.forceDown === true) {
    return { direction: 'DOWN', reason: ORIENTATION_REASON.forcedDown, downFitScale, rightFitScale: null };
  }

  const eligibility = shouldAttemptDualLayout({
    canvas: input.canvas,
    down: input.down,
    entities: input.entities,
    firstLayoutMs: input.firstLayoutMs,
  });
  if (!eligibility.attempt) {
    return {
      direction: 'DOWN',
      reason: eligibility.reason ?? ORIENTATION_REASON.canvasNotWide,
      downFitScale,
      rightFitScale: null,
    };
  }
  // Eligible but no rightward size: the caller supplied an incomplete reading.
  // Keeping the direction it already has is the only safe answer.
  if (input.right === null) {
    return {
      direction: 'DOWN',
      reason: ORIENTATION_REASON.canvasNotWide,
      downFitScale,
      rightFitScale: null,
    };
  }

  const rightFitScale = fitScaleFor(input.right, input.canvas);
  if (downFitScale <= 0 || rightFitScale <= 0) {
    return { direction: 'DOWN', reason: ORIENTATION_REASON.verticalLarger, downFitScale, rightFitScale };
  }
  // `right > down × (1 + band)` is a strict margin: exactly at the band edge the
  // downward drawing stays, so floating-point equality cannot flip the choice.
  if (rightFitScale > downFitScale * (1 + ORIENTATION_FIT_HYSTERESIS)) {
    return { direction: 'RIGHT', reason: ORIENTATION_REASON.horizontalLarger, downFitScale, rightFitScale };
  }
  if (downFitScale > rightFitScale * (1 + ORIENTATION_FIT_HYSTERESIS)) {
    return { direction: 'DOWN', reason: ORIENTATION_REASON.verticalLarger, downFitScale, rightFitScale };
  }
  return { direction: 'DOWN', reason: ORIENTATION_REASON.withinHysteresis, downFitScale, rightFitScale };
}

/**
 * The canvas ratio bucketed into {@link ORIENTATION_RATIO_BAND}-wide bands. A
 * re-layout inside one band reuses the cached direction, so a container that
 * keeps its shape family does not pay for a second layout every time the
 * debounced re-layout fires.
 */
export function canvasRatioBand(canvas: OrientationSize): string {
  if (!positive(canvas.width) || !positive(canvas.height)) return 'unmeasured';
  const aspect = Math.min(3, Math.max(0.4, canvas.width / canvas.height));
  return (Math.round(aspect / ORIENTATION_RATIO_BAND) * ORIENTATION_RATIO_BAND).toFixed(2);
}

/**
 * A cheap, stable fingerprint of the drawing. Node ids are what make two
 * drawings different; the count and the ends catch a changed graph without
 * hashing every id of a large one. `viewKey` and `idShape` are the caller's
 * (the same nodes drawn as a neighbourhood are a different drawing).
 *
 * This is a cache key, never a correctness boundary: a collision can only make
 * two similar canvases share a direction they both qualified for.
 */
export function graphFingerprint(
  graph: { readonly nodes: readonly { readonly id: string }[] },
  viewKey: string,
  idShape: string,
): string {
  const ids = graph.nodes.map((node) => node.id);
  return `${idShape}|${viewKey}|${String(ids.length)}|${ids[0] ?? ''}|${ids[ids.length - 1] ?? ''}`;
}

/** The key one drawing's direction decision is cached under. */
export function orientationCacheKey(fingerprint: string, canvas: OrientationSize): string {
  return `${fingerprint}|${canvasRatioBand(canvas)}`;
}

/**
 * The cache the renderer keeps for the lifetime of one canvas element. A hit
 * means "this drawing was already evaluated for this canvas shape": the caller
 * renders only the cached direction and skips the comparison layout entirely.
 */
export type OrientationCache = {
  get(key: string): OrientationDecision | null;
  set(key: string, decision: OrientationDecision): void;
  /**
   * Answer from the cache, or run `compute` (the two-layout comparison) once
   * and remember it. A hit never runs `compute` again — the count a test reads
   * is this callback's, so "a cached decision does not lay the graph out twice"
   * is measured rather than asserted.
   */
  resolve(key: string, compute: () => OrientationDecision): OrientationDecision;
  readonly size: number;
};

/** Bound the cache: a session can walk many neighbourhood views without one growing forever. */
const ORIENTATION_CACHE_LIMIT = 32;

/**
 * Create a bounded decision cache. Insertion order is eviction order (the
 * oldest key goes first), which is enough for a per-canvas cache: the drawing
 * on screen is always the most recently inserted.
 */
export function createOrientationCache(limit = ORIENTATION_CACHE_LIMIT): OrientationCache {
  const entries = new Map<string, OrientationDecision>();
  const store = (key: string, decision: OrientationDecision): void => {
    entries.delete(key);
    entries.set(key, decision);
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return {
    get(key) {
      const cached = entries.get(key);
      return cached ?? null;
    },
    set(key, decision) {
      store(key, decision);
    },
    resolve(key, compute) {
      const cached = entries.get(key);
      if (cached !== undefined) return cached;
      const decision = compute();
      store(key, decision);
      return decision;
    },
    get size() {
      return entries.size;
    },
  };
}
