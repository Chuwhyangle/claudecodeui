import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  moveEntityFocus,
  PACKAGE_NAV_PREFIX,
  type EntityNavigationItem,
} from '@/modules/architecture/entityNavigation';

/**
 * The entity-navigation cursor's contract:
 *  · arrows pick the most aligned box on that side, distance only breaking ties;
 *  · PageUp/PageDown walk one package's entities and never cross a frame;
 *  · `[` walks to the nearest enclosing frame, `]` to the frame's first entity;
 *  · a direction with nothing in it leaves the cursor on the current item;
 *  · the answer depends only on the arguments (order-independent, deterministic).
 */

const BOX = 40;
const GAP = 60;

/** A regular 3×3 grid: ids name their row and column. */
function gridItems(): EntityNavigationItem[] {
  const items: EntityNavigationItem[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      items.push({
        id: `r${row}c${column}`,
        kind: 'entity',
        packageId: 'pkg/grid',
        x: column * (BOX + GAP),
        y: row * (BOX + GAP),
        width: BOX,
        height: BOX,
      });
    }
  }
  return items;
}

function entity(
  id: string,
  x: number,
  y: number,
  packageId: string,
  width = BOX,
  height = BOX,
): EntityNavigationItem {
  return { id, kind: 'entity', packageId, x, y, width, height };
}

function frame(id: string, x: number, y: number, width: number, height: number): EntityNavigationItem {
  return {
    id: `${PACKAGE_NAV_PREFIX}${id}`,
    kind: 'package',
    packageId: id,
    x,
    y,
    width,
    height,
  };
}

test('arrows pick the aligned neighbour on a regular grid, and stay put at the edge', () => {
  const items = gridItems();
  assert.equal(moveEntityFocus(items, 'r1c1', 'right'), 'r1c2');
  assert.equal(moveEntityFocus(items, 'r1c1', 'left'), 'r1c0');
  assert.equal(moveEntityFocus(items, 'r1c1', 'up'), 'r0c1');
  assert.equal(moveEntityFocus(items, 'r1c1', 'down'), 'r2c1');

  // The outer edge has no candidate on that side: the cursor does not wrap and
  // does not jump to a diagonal.
  assert.equal(moveEntityFocus(items, 'r0c0', 'up'), 'r0c0');
  assert.equal(moveEntityFocus(items, 'r0c0', 'left'), 'r0c0');
  assert.equal(moveEntityFocus(items, 'r2c2', 'down'), 'r2c2');
  assert.equal(moveEntityFocus(items, 'r2c2', 'right'), 'r2c2');
});

test('an irregular layout prefers alignment over distance', () => {
  const items: EntityNavigationItem[] = [
    entity('origin', 200, 200, 'pkg/a'),
    // Far but exactly level with the origin's centre (y = 220).
    entity('level-far', 700, 220, 'pkg/a'),
    // Near but 30° off the horizontal axis.
    entity('near-angled', 300, 300, 'pkg/a'),
    // On the other side: never a "right" candidate.
    entity('behind', 100, 210, 'pkg/a'),
  ];
  assert.equal(
    moveEntityFocus(items, 'origin', 'right'),
    'level-far',
    'the smallest angle wins even when a nearer box is available',
  );

  // Same rule vertically: the box directly above (small horizontal offset) wins
  // over one that is closer but well off the vertical axis.
  const vertical: EntityNavigationItem[] = [
    entity('origin', 200, 200, 'pkg/a'),
    entity('above-aligned', 220, 0, 'pkg/a'),
    entity('above-angled', 120, 120, 'pkg/a'),
  ];
  assert.equal(moveEntityFocus(vertical, 'origin', 'up'), 'above-aligned');

  // Equal angles fall back to the nearer box, then to the id.
  const tie: EntityNavigationItem[] = [
    entity('origin', 0, 0, 'pkg/a'),
    entity('tie-b', 100, 100, 'pkg/a'),
    entity('tie-a', 100, 100, 'pkg/b'),
  ];
  assert.equal(moveEntityFocus(tie, 'origin', 'right'), 'tie-a', 'an exact tie breaks by id');
});

test('PageUp / PageDown stay inside the current package, in reading order', () => {
  const items: EntityNavigationItem[] = [
    entity('a/first', 0, 0, 'pkg/a'),
    entity('a/second', 100, 0, 'pkg/a'),
    entity('a/third', 200, 0, 'pkg/a'),
    entity('b/other', 0, 200, 'pkg/b'),
  ];
  assert.equal(moveEntityFocus(items, 'a/first', 'pageDown'), 'a/second');
  assert.equal(moveEntityFocus(items, 'a/second', 'pageDown'), 'a/third');
  assert.equal(moveEntityFocus(items, 'a/third', 'pageDown'), 'a/third', 'the last entity does not wrap');
  assert.equal(moveEntityFocus(items, 'a/second', 'pageUp'), 'a/first');
  assert.equal(moveEntityFocus(items, 'a/first', 'pageUp'), 'a/first');
});

test('[ walks to the nearest enclosing drawn frame, ] back to its first entity', () => {
  const items: EntityNavigationItem[] = [
    frame('pkg', 0, 0, 400, 400),
    frame('pkg/alpha', 10, 10, 180, 180),
    frame('pkg/alpha/inner', 20, 20, 80, 80),
    entity('deep', 30, 30, 'pkg/alpha/inner'),
    entity('alpha-first', 120, 30, 'pkg/alpha'),
    entity('root-entity', 300, 30, 'pkg'),
  ];
  // An entity in a nested package walks to its innermost frame...
  assert.equal(moveEntityFocus(items, 'deep', 'parent'), `${PACKAGE_NAV_PREFIX}pkg/alpha/inner`);
  // ...then one frame up per press.
  assert.equal(
    moveEntityFocus(items, `${PACKAGE_NAV_PREFIX}pkg/alpha/inner`, 'parent'),
    `${PACKAGE_NAV_PREFIX}pkg/alpha`,
  );
  // `]` from a frame goes to the first entity directly inside it, in reading
  // order (not to a nested frame's entity).
  assert.equal(
    moveEntityFocus(items, `${PACKAGE_NAV_PREFIX}pkg/alpha`, 'child'),
    'alpha-first',
  );
  // A frame whose direct entities are all outside the drawing still reaches
  // the first descendant entity.
  assert.equal(
    moveEntityFocus(items, `${PACKAGE_NAV_PREFIX}pkg/alpha/inner`, 'child'),
    'deep',
  );
  // `]` from an entity stays in its package's sibling group.
  assert.equal(moveEntityFocus(items, 'deep', 'child'), 'deep', 'no sibling precedes it');
  assert.equal(moveEntityFocus(items, 'alpha-first', 'child'), 'alpha-first');
});

test('Home / End land on the top-left and bottom-right entities', () => {
  const items: EntityNavigationItem[] = [
    entity('middle', 200, 200, 'pkg'),
    entity('bottom-right', 500, 500, 'pkg'),
    entity('top-left', 0, 0, 'pkg'),
  ];
  assert.equal(moveEntityFocus(items, 'middle', 'home'), 'top-left');
  assert.equal(moveEntityFocus(items, 'middle', 'end'), 'bottom-right');
});

test('the same input produces the same output, whatever order the items arrive in', () => {
  const items = gridItems();
  const shuffled = [...items].reverse();
  for (const direction of ['up', 'down', 'left', 'right', 'pageUp', 'pageDown', 'home', 'end'] as const) {
    const first = moveEntityFocus(items, 'r1c1', direction);
    assert.equal(moveEntityFocus(items, 'r1c1', direction), first, `${direction} is stable`);
    assert.equal(
      moveEntityFocus(shuffled, 'r1c1', direction),
      first,
      `${direction} does not depend on the input order`,
    );
  }
});

test('an empty drawing has nowhere to move, and an unknown cursor enters at the first entity', () => {
  assert.equal(moveEntityFocus([], null, 'right'), null, 'an empty drawing answers empty');
  assert.equal(moveEntityFocus([], 'gone', 'down'), null);

  const items = gridItems();
  assert.equal(moveEntityFocus(items, null, 'down'), 'r0c0', 'no cursor enters at the top-left entity');
  assert.equal(moveEntityFocus(items, 'missing', 'right'), 'r0c0', 'a stale id re-enters the same way');
});
