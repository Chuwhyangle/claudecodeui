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
