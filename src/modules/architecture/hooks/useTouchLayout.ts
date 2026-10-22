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
 */
export function useTouchLayout(): {
  coarsePointer: boolean;
  isMobile: boolean;
  isShortTouchViewport: boolean;
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
    touchUi: coarsePointer || isShortTouchViewport,
    compactToolbar: coarsePointer || isMobile,
  };
}
