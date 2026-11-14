/**
 * The architecture drawing's keyboard cursor: where `Up`/`Down`/`Left`/`Right`
 * move from the entity the reader is standing on.
 *
 * The drawing itself knows only geometry — the PlantUML/ELK layout gives every
 * box a rectangle, and the package frames are rectangles too. This module is
 * the pure half of the keyboard reading: given those rectangles, the current
 * item and a direction, it answers with the next item's id (or the current one
 * when there is nowhere to go). It never touches the DOM, so the rule can be
 * tested on a hand-written grid as well as on the real drawing.
 *
 * Items are the two things the drawing offers the keyboard: entities
 * (`kind: 'entity'`, id = the graph node id) and package frames
 * (`kind: 'package'`, id = {@link PACKAGE_NAV_PREFIX} + the package path). The
 * package id is its own `packageId`, which is what lets `[` walk from an entity
 * to the frame that contains it and `]` walk back to the frame's first entity.
 *
 * Consumers: `PlantUmlGraph.tsx` (its canvas key handler and focus ring).
 */

/**
 * The id prefix a package frame's navigation item carries. Package paths are
 * drawn from the same string space as entity ids (`modules/alpha` vs
 * `modules/alpha/A.ts.Alpha`), so the frame's cursor id is namespaced to keep
 * the two kinds distinguishable.
 */
export const PACKAGE_NAV_PREFIX = 'package::';

/** One focusable rectangle in the drawing. `x`/`y` are its top-left corner. */
export type EntityNavigationItem = {
  readonly id: string;
  readonly kind: 'entity' | 'package';
  /** Innermost package the item belongs to; a package item names itself. */
  readonly packageId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Every movement the canvas's entity-navigation state answers to. */
export type EntityNavigationDirection =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'parent'
  | 'child';

/** The four spatial directions, in the order the arrow keys name them. */
const SPATIAL_DIRECTIONS: ReadonlySet<EntityNavigationDirection> = new Set([
  'up',
  'down',
  'left',
  'right',
]);

/** Angles differing by less than this are treated as the same alignment. */
const ANGLE_EPSILON = 1e-9;

type Centre = { readonly x: number; readonly y: number };

function centreOf(item: EntityNavigationItem): Centre {
  return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
}

/**
 * The drawing's reading order: top to bottom, then left to right, with the id
 * as the final tie-break. A LAYOUT can change between frames, so the order is
 * derived from the rectangles actually on screen rather than from graph order;
 * the id tie-break is what makes two runs over the same input identical.
 */
function readingOrder(items: readonly EntityNavigationItem[]): EntityNavigationItem[] {
  return [...items].sort(
    (left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id),
  );
}

function firstEntity(items: readonly EntityNavigationItem[]): EntityNavigationItem | null {
  return readingOrder(items).find((item) => item.kind === 'entity') ?? null;
}

/** The parent path of a package id, or `null` for `''` (the root). */
function parentPackageOf(packageId: string): string | null {
  if (packageId === '') return null;
  const slash = packageId.lastIndexOf('/');
  return slash === -1 ? '' : packageId.slice(0, slash);
}

function findItem(
  items: readonly EntityNavigationItem[],
  id: string,
): EntityNavigationItem | null {
  return items.find((item) => item.id === id) ?? null;
}

/**
 * The closest item in `direction`, by the rule the task states: the smallest
 * angle from the direction's axis wins, and distance only breaks an angular
 * tie. Only items whose centre is strictly on that side of the current centre
 * are candidates — a box level with the cursor is neither "up" nor "down".
 */
function spatialNeighbour(
  items: readonly EntityNavigationItem[],
  current: EntityNavigationItem,
  direction: EntityNavigationDirection,
): string {
  const from = centreOf(current);
  let best: { id: string; angle: number; distance: number } | null = null;
  for (const item of items) {
    if (item.id === current.id) continue;
    const to = centreOf(item);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let along: number;
    let across: number;
    switch (direction) {
      case 'up':
        along = -dy;
        across = Math.abs(dx);
        break;
      case 'down':
        along = dy;
        across = Math.abs(dx);
        break;
      case 'left':
        along = -dx;
        across = Math.abs(dy);
        break;
      default:
        along = dx;
        across = Math.abs(dy);
        break;
    }
    if (along <= 0) continue;
    const angle = Math.atan2(across, along);
    const distance = Math.hypot(dx, dy);
    const better = best === null
      || angle < best.angle - ANGLE_EPSILON
      || (Math.abs(angle - best.angle) <= ANGLE_EPSILON
        && (distance < best.distance
          || (Math.abs(distance - best.distance) <= ANGLE_EPSILON && item.id < best.id)));
    if (better) best = { id: item.id, angle, distance };
  }
  return best?.id ?? current.id;
}

/** The first entity inside `packageId` (direct children first, then descendants). */
function firstChildOf(
  items: readonly EntityNavigationItem[],
  packageId: string,
): EntityNavigationItem | null {
  const entities = readingOrder(items).filter((item) => item.kind === 'entity');
  const direct = entities.find((item) => item.packageId === packageId);
  if (direct !== undefined) return direct;
  const prefix = packageId === '' ? '' : `${packageId}/`;
  return entities.find((item) => item.packageId.startsWith(prefix)) ?? null;
}

/**
 * Walk up from a package to the nearest enclosing frame the drawing contains.
 * `null` means every enclosing frame is outside the drawing (the root frame is
 * not drawn as a box), so there is nowhere for `[` to go.
 */
function nearestDrawnAncestor(
  items: readonly EntityNavigationItem[],
  packageId: string,
): EntityNavigationItem | null {
  let candidate: string | null = packageId;
  while (candidate !== null) {
    const frame = items.find((item) => item.kind === 'package' && item.packageId === candidate);
    if (frame !== undefined) return frame;
    candidate = parentPackageOf(candidate);
  }
  return null;
}

/**
 * Where the keyboard cursor lands when it moves from `currentId` in
 * `direction`.
 *
 * Contract:
 *  · an empty drawing answers `null` (there is nothing to stand on);
 *  · an unknown/no current id enters at the first entity in reading order;
 *  · a direction with no candidate leaves the cursor where it is — the caller
 *    still announces, so "nothing that way" is heard rather than silent;
 *  · the result depends only on the arguments: the same rectangles and the same
 *    current id always produce the same next id.
 */
export function moveEntityFocus(
  items: readonly EntityNavigationItem[],
  currentId: string | null,
  direction: EntityNavigationDirection,
): string | null {
  if (items.length === 0) return null;
  const current = currentId === null ? null : findItem(items, currentId);
  if (current === null) return firstEntity(items)?.id ?? null;

  if (SPATIAL_DIRECTIONS.has(direction)) {
    return spatialNeighbour(items, current, direction);
  }

  switch (direction) {
    case 'home':
      return firstEntity(items)?.id ?? current.id;
    case 'end': {
      const entities = readingOrder(items).filter((item) => item.kind === 'entity');
      return entities.length === 0 ? current.id : entities[entities.length - 1].id;
    }
    case 'pageUp':
    case 'pageDown': {
      if (current.kind !== 'entity') return current.id;
      const siblings = readingOrder(items).filter(
        (item) => item.kind === 'entity' && item.packageId === current.packageId,
      );
      const index = siblings.findIndex((item) => item.id === current.id);
      if (index === -1) return current.id;
      const next = siblings[direction === 'pageDown' ? index + 1 : index - 1];
      return next?.id ?? current.id;
    }
    case 'parent': {
      // An entity walks to its innermost frame; a frame walks to the frame that
      // encloses it, one level per press.
      const start = current.kind === 'package'
        ? parentPackageOf(current.packageId)
        : current.packageId;
      if (start === null) return current.id;
      const frame = nearestDrawnAncestor(items, start);
      return frame?.id ?? current.id;
    }
    case 'child': {
      // A package frame's own package is the set `]` walks into; from an entity
      // it is the sibling group the entity belongs to.
      const child = firstChildOf(items, current.packageId);
      return child?.id ?? current.id;
    }
    default:
      return current.id;
  }
}
