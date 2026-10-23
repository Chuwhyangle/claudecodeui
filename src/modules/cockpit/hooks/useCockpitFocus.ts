import type { QuayFocusableObject, QuayObjectUri } from '@/shared/types';

/**
 * Focus over one view's declared objects — as pure functions, not a state hook.
 *
 * WHY PURE. Focus is part of the cockpit's shared state: it is moved by a phone and rendered
 * by a desktop, so the transition belongs to the server-side reducer and this module only
 * derives readings from the state the hub sent. Keeping a `useState` here would be the second
 * implementation the hub replaced: the page would move focus locally, the hub would move it
 * too, and the two could disagree about which object is focused.
 *
 * The rules are the ones the stage shipped with: spatial (reading) order, a declared address
 * or nothing, and movement that clamps at the edge instead of wrapping.
 */

export type CockpitFocusDirection = 'up' | 'down' | 'left' | 'right';

/** Spatial (reading) order: top-left first, then row by row, column by column. */
export function orderCockpitFocusables(
  objects: readonly QuayFocusableObject[],
): QuayFocusableObject[] {
  return [...objects].sort(
    (left, right) =>
      left.display.pos.row - right.display.pos.row ||
      left.display.pos.column - right.display.pos.column,
  );
}

/**
 * The focused object, or the first declared one when the hub's address is not in this set
 * (a re-ordered or re-read contract keeps focus on the same OBJECT by address, and an address
 * that disappeared falls back to the head of the set). `null` when nothing is declared.
 */
export function resolveCockpitFocus(
  objects: readonly QuayFocusableObject[],
  focusUri: QuayObjectUri | null,
): QuayFocusableObject | null {
  const ordered = orderCockpitFocusables(objects);
  return ordered.find((object) => object.uri === focusUri) ?? ordered[0] ?? null;
}

/**
 * The next object in one direction, or null at the edge.
 *
 * Rows are the vertical axis and columns the horizontal one — a vertical list puts every row
 * in column 1, so `down`/`up` walk it while `left`/`right` stay put. "Snapping" means the
 * nearest greater row (then the leftmost cell in it) for `down`, the mirror for `up`, and a
 * same-row neighbour for left/right; nothing wraps around.
 */
export function nextCockpitFocus(
  objects: readonly QuayFocusableObject[],
  current: QuayFocusableObject,
  direction: CockpitFocusDirection,
): QuayFocusableObject | null {
  const ordered = orderCockpitFocusables(objects);
  const { row, column } = current.display.pos;

  switch (direction) {
    case 'down':
      return (
        ordered
          .filter((object) => object.display.pos.row > row)
          .sort(
            (left, right) =>
              left.display.pos.row - right.display.pos.row ||
              left.display.pos.column - right.display.pos.column,
          )[0] ?? null
      );
    case 'up':
      return (
        ordered
          .filter((object) => object.display.pos.row < row)
          .sort(
            (left, right) =>
              right.display.pos.row - left.display.pos.row ||
              right.display.pos.column - left.display.pos.column,
          )[0] ?? null
      );
    case 'right':
      return (
        ordered
          .filter(
            (object) => object.display.pos.row === row && object.display.pos.column > column,
          )
          .sort((left, right) => left.display.pos.column - right.display.pos.column)[0] ?? null
      );
    case 'left':
      return (
        ordered
          .filter(
            (object) => object.display.pos.row === row && object.display.pos.column < column,
          )
          .sort((left, right) => right.display.pos.column - left.display.pos.column)[0] ?? null
      );
  }
}
