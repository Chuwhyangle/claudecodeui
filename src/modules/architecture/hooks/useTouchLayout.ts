import { createContext, useContext, useEffect, useState } from 'react';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';

/**
 * The query that means "the primary pointer is a finger". Deliberately not the
 * `(pointer: coarse) and (hover: none)` pair `useDeviceSettings` uses for its
 * short tier: a phone is tall enough to miss that tier, yet every tap on it
 * still needs the touch target size and the touch click semantics.
 */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * The hit area every toolbar control gets on a coarse pointer. WCAG 2.5.5 asks
 * for 44×44 CSS pixels; the inline style (rather than a Tailwind class) makes
 * the reading explicit for a test and independent of the stylesheet.
 *
 * It lives here, beside the tier reading that turns it on, because BOTH toolbar
 * owners use it: the panel's compact row (granularity, the "…" toggle, hops,
 * export) and the graph's own controls that the panel hosts in its menu.
 */
export const TOUCH_TARGET_STYLE = { minHeight: '44px', minWidth: '44px' } as const;

/**
 * The minimum space between two adjacent hit areas on a coarse pointer.
 *
 * WCAG 2.5.5 fixes the target SIZE; packing 44px boxes shoulder to shoulder
 * still lets a thumb land on the neighbour. The mobile layout therefore states
 * its inter-control gap as a number here, so the header, the bottom sheet and
 * the on-canvas clusters all use the same reading instead of three arbitrary
 * `gap-1`/`gap-2` utilities.
 */
export const TOUCH_CONTROL_GAP_PX = 8;

/**
 * The hit area of the on-canvas zoom cluster on a FINE pointer: 32×32 CSS
 * pixels. The cluster floats over the drawing, so its controls must stay small
 * enough not to hide the diagram, yet WCAG 2.5.8's minimum is 24px and 32 keeps
 * a mouse comfortably on target. Expressed as an inline style for the same
 * reason as {@link TOUCH_TARGET_STYLE}: the reading must not depend on the
 * stylesheet, and a test can assert the number directly. A coarse pointer still
 * uses the 44px {@link TOUCH_TARGET_STYLE}.
 */
export const ZOOM_CLUSTER_TARGET_STYLE = { minHeight: '32px', minWidth: '32px' } as const;

/**
 * The widest viewport, in CSS pixels, that the portrait-phone tier covers.
 *
 * Width, not height, because the portrait phone's scarcity is breadth: the
 * toolbar has to fold the view switch, the Text door and the Adjust door into
 * one 390px line. 480px covers 320–430px phones while staying below every
 * tablet width, and it is the same ceiling the short tier uses on its own axis
 * (`SHORT_VIEWPORT_MAX_HEIGHT_PX`).
 */
export const PORTRAIT_PHONE_MAX_WIDTH_PX = 480;

/**
 * The bottom band, in CSS pixels, a portrait phone keeps clear of the drawing
 * for its collapsible zoom controls.
 *
 * The band is written as HOST PADDING, not as a chrome row: `clientHeight` (the
 * canvas-share reading) includes padding, so reserving the controls' footprint
 * costs the drawing no canvas height at all — it only moves the flex-centred
 * drawing above the band. 80px covers the widest form the corner chrome takes
 * (a 52px target row, the 12px edge inset, and the minimap's 64px expanded
 * panel), so neither the zoom cluster nor the map can cover a package tab.
 */
export const PORTRAIT_CONTROL_BAND_PX = 80;

/**
 * Where the compact toolbar's renderer-owned controls are drawn.
 *
 * `ArchitecturePanel` draws ONE compact toolbar row (title, granularity, "…")
 * and offers the opened overflow menu as a DOM slot; `PlantUmlGraph` portals its
 * own control cluster (view navigation, readable mode, zoom, drill, readouts)
 * into that slot. That is what keeps a phone's chrome to a single row instead
 * of the panel row plus a second diagram row.
 *
 * `null` means no slot is on screen (the menu is closed, or this is the desktop
 * tier). A renderer that does not read this context — every substituted
 * renderer — is unaffected, which is why the channel lives here rather than in
 * the renderer contract.
 */
export const CompactToolbarSlotContext = createContext<HTMLElement | null>(null);

/** The renderer's read of {@link CompactToolbarSlotContext}; null when it must draw nothing. */
export function useCompactToolbarSlot(): HTMLElement | null {
  return useContext(CompactToolbarSlotContext);
}

/**
 * Where the in-flow chrome row ABOVE the canvas keeps its right-hand cell.
 *
 * `ArchitecturePanel` draws that row (the one-line readout is its left cell)
 * and offers the right cell as a DOM slot; `PlantUmlGraph` portals the zoom
 * tier strip and its scale reading into it. That is what keeps the tier in
 * normal flow instead of floating it over the drawing's first row.
 *
 * `null` means the renderer is not inside a panel (or the panel has not mounted
 * the row), so the renderer draws the same strip itself in an in-flow row above
 * its own canvas — the standalone form stays honest.
 */
export const CanvasHeaderSlotContext = createContext<HTMLElement | null>(null);

/** The renderer's read of {@link CanvasHeaderSlotContext}. */
export function useCanvasHeaderSlot(): HTMLElement | null {
  return useContext(CanvasHeaderSlotContext);
}

const getIsCoarsePointer = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
};

/**
 * The DEV-only lever the landscape criterion's control arms pull: setting
 * `architecture-short-touch-layout = "off"` restores the pre-task chrome on a
 * short touch viewport, so the SAME reading function can measure what the
 * canvas looks like without the compact tier.
 *
 * DEV-gated exactly like the renderer's member-limit and orientation levers: a
 * production build does not contain this branch, so no reader can turn the
 * feature off.
 */
const SHORT_TOUCH_LAYOUT_STORAGE_KEY = 'architecture-short-touch-layout';

const shortTouchLayoutForcedOff = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return window.localStorage.getItem(SHORT_TOUCH_LAYOUT_STORAGE_KEY) === 'off';
  } catch {
    // Private mode: the store is unreadable, so the shipped tier applies.
    return false;
  }
};

/**
 * Which form the dock takes on a short touch viewport.
 *
 * `side` is the shipped landscape form: an in-flow column on the canvas's right
 * edge, so it cannot cover the selected entity. The DEV-only `drawer` value is
 * the control arm's restoration of the old bottom drawer — the overlay that
 * DOES cover the drawing — so one reading can compare both forms.
 */
const SHORT_TOUCH_DOCK_STORAGE_KEY = 'architecture-short-touch-dock';

/**
 * The DEV-only lever the portrait criterion's first control arm pulls: setting
 * `architecture-portrait-chrome = "off"` restores the pre-task compact chrome on
 * a portrait touch viewport — the five-entry toolbar that wraps into two rows —
 * so the same reading can measure the canvas share and the one-row contract on
 * their failing side.
 *
 * DEV-gated exactly like the short-touch lever above: a production build does
 * not contain this branch, so no reader can turn the shipped tier off.
 */
const PORTRAIT_CHROME_STORAGE_KEY = 'architecture-portrait-chrome';

const portraitChromeForcedOff = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return window.localStorage.getItem(PORTRAIT_CHROME_STORAGE_KEY) === 'off';
  } catch {
    // Private mode: the shipped portrait tier applies.
    return false;
  }
};

/**
 * The DEV-only lever the portrait criterion's second control arm pulls:
 * `architecture-portrait-controls = "overlay"` restores the pre-task floating
 * corner controls — no bottom band and the cluster drawn expanded over the
 * drawing — so the intersection reading can be shown landing on its failing
 * side while the one-row toolbar stays green.
 */
const PORTRAIT_CONTROLS_STORAGE_KEY = 'architecture-portrait-controls';

const portraitControlsForcedOverlay = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return window.localStorage.getItem(PORTRAIT_CONTROLS_STORAGE_KEY) === 'overlay';
  } catch {
    // Private mode: the shipped reserved band applies.
    return false;
  }
};

export function shortTouchDockForm(): 'side' | 'drawer' {
  if (import.meta.env.DEV) {
    try {
      if (window.localStorage.getItem(SHORT_TOUCH_DOCK_STORAGE_KEY) === 'drawer') return 'drawer';
    } catch {
      // Private mode: the shipped side column applies.
    }
  }
  return 'side';
}

/**
 * The architecture tab's pointer/size tier, used by `PlantUmlGraph` and
 * `ArchitecturePanel`.
 *
 * `touchUi` turns on the ≥44px hit areas and the touch wording; `compactToolbar`
 * collects the graph toolbar's entries into one overflow menu. They are kept
 * separate because a narrow desktop window still needs the compact toolbar,
 * while a large touchscreen still needs the large targets.
 *
 * The coarse-pointer reading is followed at runtime (a mouse paired to a tablet,
 * a keyboard docked to a tablet) rather than taken once: the tier changes what
 * the same tap means, so it must not go stale mid-session.
 *
 * `shortTouch` is the landscape-phone tier: the pointer is a finger AND the
 * viewport is short (≤ 480 CSS px — see `SHORT_VIEWPORT_MAX_HEIGHT_PX`). It is a
 * subset of `compactToolbar`, and it changes the panel's STRUCTURE rather than
 * only its control sizes: the toolbar folds the readout into its one row, the
 * provenance footer moves into that row's expansion, and the inspector becomes
 * an in-flow side column instead of the bottom drawer. Width alone cannot see
 * this state — 844px clears every width breakpoint — so height is the axis.
 *
 * `portraitPhone` is the OTHER phone tier: a finger AND a viewport no wider
 * than `PORTRAIT_PHONE_MAX_WIDTH_PX`, and not the short tier. Its scarcity is
 * width, so the same one-row contract is stated at 480px: the toolbar keeps the
 * view switch, the Text page and Adjust, while fullscreen and "Open in new tab"
 * move into the Adjust sheet, and the on-canvas zoom cluster starts collapsed
 * to one 44px button above a bottom band the drawing is fitted clear of.
 *
 * `portraitControlsOverlay` is true only when the DEV lever restores the
 * pre-task floating controls; it never changes the shipped layout.
 */
export function useTouchLayout(): {
  coarsePointer: boolean;
  isMobile: boolean;
  isShortTouchViewport: boolean;
  portraitControlsOverlay: boolean;
  portraitPhone: boolean;
  shortTouch: boolean;
  touchUi: boolean;
  compactToolbar: boolean;
} {
  const { isMobile, isShortTouchViewport } = useDeviceSettings({ trackPWA: false });
  const [coarsePointer, setCoarsePointer] = useState<boolean>(getIsCoarsePointer);
  // Why: the portrait tier's boundary is a WIDTH, and a rotation/resize must
  // turn it on or off without any other value changing; the reading is state
  // rather than a render-time `window.innerWidth` so the toolbar restructures on
  // the same commit the viewport changes.
  const [viewportWidth, setViewportWidth] = useState<number>(() => (
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = (): void => setCoarsePointer(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = (): void => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const shortTouch = isShortTouchViewport && !shortTouchLayoutForcedOff();
  const portraitPhone = coarsePointer
    && !shortTouch
    && viewportWidth <= PORTRAIT_PHONE_MAX_WIDTH_PX
    && !portraitChromeForcedOff();

  return {
    coarsePointer,
    isMobile,
    isShortTouchViewport,
    portraitControlsOverlay: portraitPhone && portraitControlsForcedOverlay(),
    portraitPhone,
    shortTouch,
    touchUi: coarsePointer || isShortTouchViewport,
    compactToolbar: coarsePointer || isMobile,
  };
}
