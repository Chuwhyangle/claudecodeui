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
import { createBoundedLru } from '@/shared/utils';

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
  /** A DEV-only control arm forced the turned (rightward) layout. */
  forcedRight: 'forced-right',
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
  /**
   * A DEV-only control arm that forces the TURNED drawing. It exists so the
   * criterion can measure the direction the policy declined — with the drawing
   * actually laid out RIGHT, not simulated — after `forceDown` stopped being
   * the losing side.
   */
  readonly forceRight?: boolean;
  /**
   * The semantic fit scale each direction is really PAINTED at, measured on
   * the drawing AFTER the semantic layout reclaims the blank body of frames
   * whose member rows are not drawn.
   *
   * `down`/`right` are the renderer's natural sizes — the geometry BEFORE that
   * reclaim. A tall frame that drops to a compact strip is still counted at its
   * full height there, so two directions compared on those sizes can pick the
   * one the canvas shows SMALLER (the defect this policy fixes). A caller that
   * solved the semantic layout for a direction supplies the solved scale and
   * the comparison uses it. Omitted ⇒ the pre-reclaim sizes are compared, which
   * is correct for a caller that has no semantic pass (and for the pure-arithmetic
   * cases of `tests/layoutAspect.test.tsx`).
   */
  readonly downDrawnFitScale?: number;
  readonly rightDrawnFitScale?: number;
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
 * A caller-supplied drawn fit, or `null` when it did not solve the direction.
 * A non-positive reading is the same as no reading: it cannot be compared.
 */
function usableDrawnFit(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Choose the layout direction. Same input → same output: no clocks, no globals.
 *
 * The comparison uses the DRAWN fit — the semantic layout's post-reclaim scale
 * when the caller supplies it (see {@link OrientationDecisionInput.downDrawnFitScale}),
 * the renderer's natural size otherwise. That is the whole point of the policy:
 * "which direction the canvas can show larger" is a statement about the
 * drawing the reader sees, not about the renderer's pre-semantic geometry.
 *
 * Ties — and gaps inside {@link ORIENTATION_FIT_HYSTERESIS} — keep `DOWN`, the
 * direction the graph was drawn with first. That is what makes the choice
 * stable: turning the drawing must win by a margin a reader could notice.
 */
export function chooseLayoutOrientation(input: OrientationDecisionInput): OrientationDecision {
  const drawnDownFit = usableDrawnFit(input.downDrawnFitScale);
  const downFitScale = drawnDownFit ?? fitScaleFor(input.down, input.canvas);

  if (input.forceDown === true) {
    return { direction: 'DOWN', reason: ORIENTATION_REASON.forcedDown, downFitScale, rightFitScale: null };
  }
  // The turned control arm measures the drawing the policy declined. It has no
  // comparison reading of its own (only one direction was laid out), so the
  // forced drawing's fit is reported on both sides.
  if (input.forceRight === true) {
    return { direction: 'RIGHT', reason: ORIENTATION_REASON.forcedRight, downFitScale, rightFitScale: downFitScale };
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

  const rightFitScale = usableDrawnFit(input.rightDrawnFitScale) ?? fitScaleFor(input.right, input.canvas);
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
 * Create a bounded decision cache. Least-recently-used keys are evicted first,
 * which is enough for a per-canvas cache: a decision read or written most
 * recently belongs to the drawing currently on screen.
 */
export function createOrientationCache(limit = ORIENTATION_CACHE_LIMIT): OrientationCache {
  const entries = createBoundedLru<string, OrientationDecision>(limit);
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, decision) => {
      entries.set(key, decision);
    },
    resolve(key, compute) {
      const cached = entries.get(key);
      if (cached !== undefined) return cached;
      const decision = compute();
      entries.set(key, decision);
      return decision;
    },
    get size() {
      return entries.size;
    },
  };
}
