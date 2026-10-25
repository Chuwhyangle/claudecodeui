import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;
/**
 * Thin space above the trigger does not collapse the menu to a sliver: below this
 * the box stops rising and overlaps the trigger instead. It is a floor on what is
 * *shown*, never on what fits — the box is still capped by the visible viewport,
 * so the floor can never push an edge back off screen the way the old 160px floor
 * did.
 */
const MIN_MENU_HEIGHT = 96;

/**
 * Positions a composer popover above its trigger and right-aligned to it when
 * there is room, clamping every edge into the visual viewport.
 *
 * Both axes are clamped, not merely measured. The menu is anchored with
 * `right`/`bottom` so it can grow upward and leftward without measuring itself
 * first, but the amount it may grow is the *available* box: on a 320px phone the
 * trigger sits mid-row, so there is less than a desktop menu's width to the left
 * of it, and the soft keyboard makes the visible height shorter than
 * `window.innerHeight`. A minimum width or height that ignores those bounds wins
 * over the clamp and paints the menu off the edge — which is exactly the bug this
 * hook used to have. Deriving `maxWidth`/`maxHeight` from the free space keeps
 * the menu on screen instead; the surface itself no longer declares a minimum
 * width that could override the cap.
 */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // The soft keyboard shrinks the *visual* viewport without changing
    // `innerHeight`, and a keyboard pan (or pinch zoom) moves its origin. The menu
    // must fit what the user can actually see, so the vertical clamp reads these
    // when the browser offers them and falls back to the layout window otherwise.
    const visualViewport = window.visualViewport;
    const visualTop = visualViewport?.offsetTop ?? 0;
    const visualHeight = visualViewport?.height ?? viewportHeight;
    const visualBottom = visualTop + visualHeight;

    // The whole menu, including its margins, has to fit the window. No floor:
    // a floor larger than the free space is what used to win the clamp.
    const maxWidth = Math.max(0, Math.min(preferredWidth, viewportWidth - 2 * VIEWPORT_MARGIN));
    // Right-align to the trigger, then slide the box left far enough that its left
    // edge clears the margin. The upper bound is the same as saying
    // `left <= innerWidth - margin - maxWidth`.
    const right = Math.min(
      Math.max(viewportWidth - rect.right, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - maxWidth),
    );

    // The menu's home is the space above the trigger; `MIN_MENU_HEIGHT` lets a
    // trigger pinned near the top still show usable rows, and `bottomBound` is the
    // visible viewport, so the menu never reaches below what the keyboard left.
    const topBound = visualTop + VIEWPORT_MARGIN;
    const bottomBound = Math.max(topBound, visualBottom - VIEWPORT_MARGIN);
    const minHeight = Math.min(MIN_MENU_HEIGHT, bottomBound - topBound);
    const bottomEdge = Math.min(Math.max(rect.top - MENU_GAP, topBound + minHeight), bottomBound);
    const maxHeight = Math.max(0, bottomEdge - topBound);

    setAnchor({
      right,
      bottom: viewportHeight - bottomEdge,
      maxHeight,
      maxWidth,
    });
  }, [preferredWidth]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };

    // A keyboard sliding up resizes the *visual* viewport and pans it; neither
    // fires `window`'s resize, and its scroll event does not bubble, so the anchor
    // would keep the old bottom edge until the menu was reopened without these.
    const visualViewport = window.visualViewport;

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    visualViewport?.addEventListener('resize', updateAnchor);
    visualViewport?.addEventListener('scroll', updateAnchor);
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      visualViewport?.removeEventListener('resize', updateAnchor);
      visualViewport?.removeEventListener('scroll', updateAnchor);
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
