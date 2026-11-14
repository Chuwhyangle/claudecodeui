/**
 * The DEV-only control-arm levers for the architecture canvas.
 *
 * Each lever re-creates one RETIRED behaviour so an e2e criterion can measure
 * the failing side; every one is `import.meta.env.DEV`-gated, so a production
 * build does not contain the branch. They live here (rather than inline in
 * `PlantUmlGraph.tsx`) because the fit/zoom and drawing halves both consult
 * them after the residual-oversize split.
 */
/**
 * The pixel the overlay's Fit leaves for the semantic writer's `Math.ceil`.
 * See `fullscreenFitBox` — it is rounding allowance, not a reserved margin.
 */
export const FULLSCREEN_FIT_ROUNDING_ALLOWANCE_PX = 1;

/**
 * The DEV-only lever the e2e control arm pulls to re-create the retired
 * fit-time CSS factor. It makes every semantic Fit multiply the semantic scale
 * by a factor the same way the shipped defect did, so the arm can prove its
 * min-font reading lands on the failing side. DEV-gated like the other levers:
 * a production build does not contain this branch.
 */
const FIT_CSS_FACTOR_STORAGE_KEY = 'architecture-fit-css-factor';

/** The control-arm CSS factor, or `null` when the shipped path runs. */
export function forcedFitCssFactor(): number | null {
  if (import.meta.env.DEV) {
    try {
      const stored = window.localStorage.getItem(FIT_CSS_FACTOR_STORAGE_KEY);
      if (stored === null) return null;
      const value = Number.parseFloat(stored);
      return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
    } catch {
      // Private mode: the shipped path applies.
    }
  }
  return null;
}

/**
 * The DEV-only lever that restores the retired "unreadable fit opens focused"
 * rule: the drawing opens at the readable floor instead of the solved fit, the
 * state the control arm measures as overflow on the Quay fixture.
 */
const DEFAULT_FOCUS_STORAGE_KEY = 'architecture-default-focus';

/** Whether this build's control arm asked for the retired focus default. */
export function forcedDefaultFocus(): boolean {
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem(DEFAULT_FOCUS_STORAGE_KEY) === 'on';
    } catch {
      // Private mode: the shipped path applies.
    }
  }
  return false;
}

/**
 * The DEV-only lever that suppresses the `auto` re-solve, so the control arm can
 * prove the resize criterion goes red when the ResizeObserver path is off.
 */
const AUTO_FIT_STORAGE_KEY = 'architecture-auto-fit';

/** Whether this build's control arm disabled auto refit. */
export function autoFitDisabled(): boolean {
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem(AUTO_FIT_STORAGE_KEY) === 'off';
    } catch {
      // Private mode: auto refit stays on.
    }
  }
  return false;
}

/**
 * The DEV-only lever the fullscreen-fit criterion's control arm pulls: it
 * restores the retired rule that Fit kept using the NON-fullscreen canvas
 * (the `flex-1` region it came from) after the overlay made the host the whole
 * viewport. That is the defect the fullscreen fit exists to remove — the L
 * drawing was measured at 788×480 in a 1440×765 overlay. DEV-gated like the
 * other levers: a production build does not contain this branch.
 */
const FULLSCREEN_FIT_MARGIN_STORAGE_KEY = 'architecture-fullscreen-fit-margins';

/** Whether this build's control arm asked for the retired reserved margins. */
export function forcedFullscreenReservedMargins(): boolean {
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem(FULLSCREEN_FIT_MARGIN_STORAGE_KEY) === 'reserved';
    } catch {
      // Private mode: the measured overlay area applies.
    }
  }
  return false;
}
