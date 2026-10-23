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
 */
export function useTouchLayout(): {
  coarsePointer: boolean;
  isMobile: boolean;
  isShortTouchViewport: boolean;
  shortTouch: boolean;
  touchUi: boolean;
  compactToolbar: boolean;
} {
  const { isMobile, isShortTouchViewport } = useDeviceSettings({ trackPWA: false });
  const [coarsePointer, setCoarsePointer] = useState<boolean>(getIsCoarsePointer);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = (): void => setCoarsePointer(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return {
    coarsePointer,
    isMobile,
    isShortTouchViewport,
    shortTouch: isShortTouchViewport && !shortTouchLayoutForcedOff(),
    touchUi: coarsePointer || isShortTouchViewport,
    compactToolbar: coarsePointer || isMobile,
  };
}
