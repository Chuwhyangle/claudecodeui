import { useEffect, useState } from 'react';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';

/**
 * The query that means "the primary pointer is a finger". Deliberately not the
 * `(pointer: coarse) and (hover: none)` pair `useDeviceSettings` uses for its
 * short tier: a phone is tall enough to miss that tier, yet every tap on it
 * still needs the touch target size and the touch click semantics.
 */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

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
