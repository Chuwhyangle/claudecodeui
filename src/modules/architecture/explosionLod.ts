/**
 * Zoom-transition plumbing for the architecture canvas.
 *
 * The old level-of-detail mechanism (hide whole layers at scale thresholds,
 * re-draw package titles and aggregated package edges in an overlay) is retired
 * by `architecture-semantic-zoom-layout`: the canvas now rewrites the drawn
 * geometry itself (see `semanticZoomLayout.ts`). What remains here is the part
 * that was never about the thresholds — the debounce that coalesces a wheel
 * burst into one application, and the 8 % dead band that keeps a scale resting
 * on a tier boundary from flapping between two drawings.
 *
 * Consumers: `PlantUmlGraph.tsx` (schedules one semantic application per settled
 * zoom) and `tests/explosionLod.test.tsx` (debounce + dead band).
 */

/**
 * The dead band around a tier's stretch budget, as a fraction of the budget.
 * A tier already on screen is kept until the budget is exceeded by this much.
 * 5 %–10 % was chosen to be wider than wheel-delta noise but narrower than the
 * visual jump between tiers; 8 % is the value the previous mechanism measured.
 */
export const LOD_DEADZONE_RATIO = 0.08;

/**
 * How long the zoom must settle before the drawing is re-laid semantically.
 * The proposal fixes the 150–250 ms window; 200 ms absorbs a wheel burst
 * without making the transition feel laggy.
 */
export const LOD_DEBOUNCE_MS = 200;

/** Coalesces a burst of zoom readings into one application. */
export type ExplosionLodScheduler = {
  /** Replace any pending application with `apply`, to run after the delay. */
  request(apply: () => void): void;
  /** Drop the pending application (a new drawing replaces it). */
  cancel(): void;
};

/**
 * Create the debouncer the diagram drives from its zoom state. Kept separate
 * from the DOM so the timing contract can be tested without a laid-out SVG.
 */
export function createExplosionLodScheduler(
  delayMs: number = LOD_DEBOUNCE_MS,
): ExplosionLodScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    request(apply: () => void): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        apply();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Whether a stretch ratio still fits the budget for the tier already on screen.
 *
 * The dead band is one-sided: it can KEEP a tier that is slightly over budget,
 * never admit a tier that is far over. `ratio <= limit` is always inside.
 */
export function tierWithinDeadzone(
  ratio: number,
  limit: number,
  deadzone: number = LOD_DEADZONE_RATIO,
): boolean {
  if (!Number.isFinite(ratio) || !Number.isFinite(limit)) return false;
  return ratio <= limit * (1 + deadzone / 2);
}
