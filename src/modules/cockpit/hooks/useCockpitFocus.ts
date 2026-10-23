import { useCallback, useMemo, useState } from 'react';

import type { QuayFocusableObject, QuayObjectUri } from '@/shared/types';

/**
 * The cockpit's focus seam. Direction keys, the on-screen click target and (in the next task)
 * the gamepad all call the same `move(direction)` / `focus(uri)` pair, so every input method
 * lands on the same spatial order the view contract declares.
 *
 * Focus is always one of the DECLARED objects or nothing: the derived `focusObject` snaps to
 * the set's first object when the current one disappears (a view switch, or a board whose
 * snapshot failed), and `focus(uri)` ignores an address the view never declared. That is what
 * keeps focus from ever pointing outside the page.
 */

export type CockpitFocusDirection = 'up' | 'down' | 'left' | 'right';

export type CockpitFocusState = {
  /** The focused object's `quay://` address, or `null` when the view declares nothing. */
  focusUri: QuayObjectUri | null;
  /** The focused object itself, or `null` when the view declares nothing. */
  focusObject: QuayFocusableObject | null;
  /** Moves focus to a declared address; an undeclared address is ignored. */
  focus: (uri: string) => void;
  /** Snaps focus to the nearest object in one direction; never wraps or leaves the set. */
  move: (direction: CockpitFocusDirection) => void;
};

/** Spatial (reading) order: top-left first, then row by row, column by column. */
function spatialOrder(objects: readonly QuayFocusableObject[]): QuayFocusableObject[] {
  return [...objects].sort(
    (left, right) =>
      left.display.pos.row - right.display.pos.row ||
      left.display.pos.column - right.display.pos.column,
  );
}

/**
 * The next object in one direction, or `null` at the edge.
 *
 * Rows are the vertical axis and columns the horizontal one — a vertical list puts every row
 * in column 1, so `down`/`up` walk it while `left`/`right` stay put. "Snapping" means: for
 * `down` take the nearest greater row (then the leftmost cell in it), never wrapping around,
 * so holding the key at the last object simply stays there.
 */
function nextInDirection(
  ordered: readonly QuayFocusableObject[],
  current: QuayFocusableObject,
  direction: CockpitFocusDirection,
): QuayFocusableObject | null {
  const { row, column } = current.display.pos;

  switch (direction) {
    case 'down': {
      const candidates = ordered.filter((object) => object.display.pos.row > row);
      return (
        candidates.sort(
          (left, right) =>
            left.display.pos.row - right.display.pos.row ||
            left.display.pos.column - right.display.pos.column,
        )[0] ?? null
      );
    }
    case 'up': {
      const candidates = ordered.filter((object) => object.display.pos.row < row);
      return (
        candidates.sort(
          (left, right) =>
            right.display.pos.row - left.display.pos.row ||
            right.display.pos.column - left.display.pos.column,
        )[0] ?? null
      );
    }
    case 'right': {
      const candidates = ordered.filter(
        (object) => object.display.pos.row === row && object.display.pos.column > column,
      );
      return (
        candidates.sort(
          (left, right) => left.display.pos.column - right.display.pos.column,
        )[0] ?? null
      );
    }
    case 'left': {
      const candidates = ordered.filter(
        (object) => object.display.pos.row === row && object.display.pos.column < column,
      );
      return (
        candidates.sort(
          (left, right) => right.display.pos.column - left.display.pos.column,
        )[0] ?? null
      );
    }
  }
}

/**
 * Tracks focus over one view contract. The list is expected to be memoized by the caller
 * (`CockpitPage` builds it per view); the hook only memoizes the spatial sort.
 */
export function useCockpitFocus(focusables: readonly QuayFocusableObject[]): CockpitFocusState {
  // The focused address, or `null` for "no explicit focus yet". Kept as an address rather than
  // an index so a re-ordered or re-read contract keeps focus on the same OBJECT, and derived
  // through the declared set so focus can never survive outside it.
  const [focusedUri, setFocusedUri] = useState<QuayObjectUri | null>(null);

  const ordered = useMemo(() => spatialOrder(focusables), [focusables]);
  const focusObject =
    ordered.find((object) => object.uri === focusedUri) ?? ordered[0] ?? null;

  const focus = useCallback(
    (uri: string) => {
      if (focusables.some((object) => object.uri === uri)) {
        setFocusedUri(uri as QuayObjectUri);
      }
    },
    [focusables],
  );

  const move = useCallback(
    (direction: CockpitFocusDirection) => {
      if (focusObject === null) {
        return;
      }
      const next = nextInDirection(ordered, focusObject, direction);
      if (next !== null) {
        setFocusedUri(next.uri);
      }
    },
    [focusObject, ordered],
  );

  return { focusUri: focusObject?.uri ?? null, focusObject, focus, move };
}
