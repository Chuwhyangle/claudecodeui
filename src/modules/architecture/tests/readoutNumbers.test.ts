import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildReadout, drawnKindCounts, relatedScopeTotal } from '@/modules/architecture/readoutNumbers';

/**
 * The readout contract, as a pure function:
 *  · N is the entity count the layout was handed (group boxes count every
 *    member, so N is never a box count);
 *  · M is the server's pre-budget total, falling back to the returned count on
 *    older payloads, minus whatever the CURRENT element selection removed from
 *    the payload in hand — so the same selection reads the same number whatever
 *    route (a fresh request or a local narrowing) produced that payload;
 *  · each budget layer that cut gets exactly one explanation line, with its own
 *    number; the detail line is also stated when the other two budgets both
 *    cut (the retained → drawn → omitted chain is what reconciles N with M);
 *  · an untroubled graph states no budget at all;
 *  · counts carry the locale's thousands separators.
 */

/** A plain entity box: one entity, not a group. */
const box = {};

test('the measured reading: N is drawn, M is every related, the three layers each get a line', () => {
  const readout = buildReadout({
    // The detail tier ranked the 2000 that arrived and kept all of them.
    detailRetained: 2000,
    // The layout budget drew 556 of those.
    drawnBoxes: Array.from({ length: 556 }, () => box),
    returnedCount: 2000,
    // The server's budget omitted 449 of the 2449 related entities.
    relatedTotal: 2449,
    locale: 'en',
  });

  assert.equal(readout.shown, 556, 'N is what the layout drew');
  assert.equal(readout.related, 2449, 'M is the pre-budget total, not the returned count');
  assert.equal(readout.shownText, '556');
  assert.equal(readout.relatedText, '2,449', 'M carries thousands separators');

  assert.equal(readout.limited, true);
  assert.deepEqual(readout.limitedLayers, ['layout', 'server']);
  assert.deepEqual(
    readout.lines.map((line) => line.layer),
    ['detail', 'layout', 'server'],
    'the full chain is stated when both later budgets cut',
  );
  assert.deepEqual(
    readout.lines.map((line) => line.count),
    [2000, 556, 449],
    'each line carries its own number: retained, drawn, omitted',
  );
  assert.deepEqual(
    readout.lines.map((line) => line.countText),
    ['2,000', '556', '449'],
    'every line carries the count in the locale format',
  );
});

test('an untroubled graph states no budget marker and no explanation lines', () => {
  const readout = buildReadout({
    detailRetained: 12,
    drawnBoxes: Array.from({ length: 12 }, () => box),
    returnedCount: 12,
    relatedTotal: 12,
  });

  assert.equal(readout.shown, 12);
  assert.equal(readout.related, 12);
  assert.equal(readout.limited, false);
  assert.deepEqual(readout.limitedLayers, []);
  assert.deepEqual(readout.lines, []);
});

test('only the server budget cutting states only the server line', () => {
  const readout = buildReadout({
    detailRetained: 100,
    drawnBoxes: Array.from({ length: 100 }, () => box),
    returnedCount: 100,
    relatedTotal: 250,
  });

  assert.deepEqual(readout.limitedLayers, ['server']);
  assert.deepEqual(
    readout.lines.map((line) => [line.layer, line.count]),
    [['server', 150]],
    'the omitted count is total minus returned, stated once',
  );
});

test('only the layout budget cutting states only the layout line', () => {
  const readout = buildReadout({
    detailRetained: 100,
    drawnBoxes: Array.from({ length: 40 }, () => box),
    returnedCount: 100,
    relatedTotal: 100,
  });

  assert.deepEqual(readout.limitedLayers, ['layout']);
  assert.deepEqual(
    readout.lines.map((line) => [line.layer, line.count]),
    [['layout', 40]],
  );
});

test('only the detail tier cutting states the detail line', () => {
  const readout = buildReadout({
    detailRetained: 15,
    drawnBoxes: Array.from({ length: 15 }, () => box),
    returnedCount: 100,
    relatedTotal: 100,
  });

  assert.deepEqual(readout.limitedLayers, ['detail']);
  assert.deepEqual(
    readout.lines.map((line) => [line.layer, line.count]),
    [['detail', 15]],
  );
});

test('a node a display filter hid is not a budget cut (the live voice 19 → 18 reading)', () => {
  // The server returned 19 related entities; the "hide isolated nodes" display
  // filter removed one, so the detail tier ranked 18 and kept all of them, and
  // the layout drew all 18. No budget cut anything, and the removed node is
  // already stated on the readout's own filter line ("1 isolated nodes"). The
  // isolated axis is a DRAWING filter: it must not move M (the panel passes the
  // element-scoped count, which this removal does not touch).
  const readout = buildReadout({
    detailRetained: 18,
    detailInScope: 18,
    drawnBoxes: Array.from({ length: 18 }, () => box),
    returnedCount: 19,
    relatedTotal: 19,
  });

  assert.equal(readout.shown, 18);
  assert.equal(readout.related, 19);
  assert.equal(readout.limited, false, 'a filtered-out node must not light the budget marker');
  assert.deepEqual(readout.limitedLayers, []);
  assert.deepEqual(readout.lines, []);
});

test('M is decided by the response set through the current filter, not by the path that reached it', () => {
  const drawn = Array.from({ length: 5 }, () => box);
  // The reader's same filter, reached directly: the server answered the narrow
  // request with 5 entities (5 related).
  const direct = buildReadout({
    detailRetained: 5,
    detailInScope: 5,
    drawnBoxes: drawn,
    returnedCount: 5,
    relatedTotal: 5,
    filteredCount: 5,
  });
  // The same filter after a widening detour: the payload in hand is the WIDER
  // one (40 arrived, 40 in the server's total), and the local narrowing leaves 5.
  const afterDetour = buildReadout({
    detailRetained: 5,
    detailInScope: 5,
    drawnBoxes: drawn,
    returnedCount: 40,
    relatedTotal: 40,
    filteredCount: 5,
  });

  assert.equal(direct.related, 5);
  assert.equal(afterDetour.related, 5, 'the same filter must read the same related count');
  assert.equal(afterDetour.relatedText, direct.relatedText, 'including its formatted text');
  assert.deepEqual(afterDetour.limitedLayers, direct.limitedLayers);
  assert.deepEqual(afterDetour.lines, direct.lines);
});

test('relatedScopeTotal takes local element removals off M but keeps a server omission', () => {
  // 40 of 100 in scope arrived; the element selection removed 35 of them:
  // M = 100 − 35 = 65. The 60 the server's budget never served stay counted.
  assert.equal(relatedScopeTotal(40, 5, 100), 65);
  // No display removals ⇒ the server's pre-budget total stands.
  assert.equal(relatedScopeTotal(40, 40, 100), 100);
  // An older payload with no pre-budget total reads what arrived.
  assert.equal(relatedScopeTotal(5, 5), 5);
  // A filtered reading above the arrived set cannot invent entities.
  assert.equal(relatedScopeTotal(5, 9, 5), 5);
});

test('the detail tier is still read as cutting against the set it actually ranked', () => {
  // Same 19 → 18 filter removal, but this time the detail tier folded ten of
  // the 18 it ranked: that IS a detail cut and must keep its line.
  const readout = buildReadout({
    detailRetained: 8,
    detailInScope: 18,
    drawnBoxes: Array.from({ length: 8 }, () => box),
    returnedCount: 19,
    relatedTotal: 19,
  });

  assert.deepEqual(readout.limitedLayers, ['detail']);
  assert.deepEqual(
    readout.lines.map((line) => [line.layer, line.count]),
    [['detail', 8]],
    'the line states what the tier kept, not the server total',
  );
});

test('group boxes count their members, so N stays an entity count', () => {
  const readout = buildReadout({
    detailRetained: 10,
    // Two group boxes (3 + 4 entities) and three plain entities = 10 entities
    // in five boxes: N must be 10, never 5.
    drawnBoxes: [
      { memberCount: 3 },
      { memberCount: 4 },
      box,
      box,
      box,
    ],
    returnedCount: 10,
    relatedTotal: 10,
  });

  assert.equal(readout.shown, 10, 'group members are counted, not the group boxes');
  assert.equal(readout.lines.length, 0, 'nothing was cut, so there is nothing to explain');
});

test('a group box still counts its members when the layout budget cut the graph', () => {
  const readout = buildReadout({
    detailRetained: 1000,
    drawnBoxes: [{ memberCount: 300 }, { memberCount: 256 }],
    returnedCount: 1000,
    relatedTotal: 2449,
  });

  assert.equal(readout.shown, 556, 'two group boxes stand for 556 entities');
  assert.deepEqual(
    readout.lines.map((line) => [line.layer, line.count]),
    [['detail', 1000], ['layout', 556], ['server', 1449]],
  );
});

test('a payload without the pre-budget total falls back to the returned count', () => {
  const readout = buildReadout({
    detailRetained: 30,
    drawnBoxes: Array.from({ length: 30 }, () => box),
    returnedCount: 30,
  });

  assert.equal(readout.related, 30, 'M falls back to what the server returned');
  assert.equal(readout.limited, false, 'without a total there is no server omission');
  assert.deepEqual(readout.lines, []);
});

test('a pre-budget total smaller than the returned count cannot fabricate an omission', () => {
  const readout = buildReadout({
    detailRetained: 30,
    drawnBoxes: Array.from({ length: 30 }, () => box),
    returnedCount: 30,
    relatedTotal: 10,
  });

  assert.equal(readout.related, 30);
  assert.deepEqual(readout.limitedLayers, []);
});

test('the retained count is clamped to the graph that actually arrived', () => {
  const readout = buildReadout({
    detailRetained: 5000,
    drawnBoxes: Array.from({ length: 100 }, () => box),
    returnedCount: 100,
    relatedTotal: 100,
  });

  assert.deepEqual(
    readout.lines,
    [],
    'a detail reading above the returned count is clamped, not read as a cut',
  );
});

test('every emitted count is rendered with the requested locale separators', () => {
  const readout = buildReadout({
    detailRetained: 10000,
    drawnBoxes: Array.from({ length: 9000 }, () => box),
    returnedCount: 10000,
    relatedTotal: 12500,
    locale: 'en',
  });

  assert.equal(readout.shownText, '9,000');
  assert.equal(readout.relatedText, '12,500');
  assert.deepEqual(
    readout.lines.map((line) => line.countText),
    ['10,000', '9,000', '2,500'],
  );
});

test('the drawn kinds are counted from the boxes, so a function is never called a class', () => {
  const counts = drawnKindCounts([
    { id: 'a', label: 'a', distance: 0, kind: 'function' },
    { id: 'b', label: 'b', distance: 1, kind: 'function' },
    { id: 'c', label: 'c', distance: 2, kind: 'class' },
    { id: 'd', label: 'd', distance: 3, kind: 'abstract' },
    { id: 'e', label: 'e', distance: 4, kind: 'enum' },
    { id: 'f', label: 'f', distance: 5, kind: 'interface' },
    { id: 'g', label: 'g', distance: 6, kind: 'other' },
  ]);

  assert.deepEqual(counts, [
    { kind: 'function', count: 2 },
    { kind: 'interface', count: 1 },
    { kind: 'class', count: 3 },
    { kind: 'other', count: 1 },
  ], 'abstract and enum fold into class; functions keep their own bucket');
});

test('a box with no known kind contributes no bucket instead of inventing one', () => {
  // A legacy entity payload and an overview group box both carry no kind.
  assert.deepEqual(drawnKindCounts([box, { memberCount: 4 }]), []);
  // A group box counts members for N, but the kind reading must not guess them.
  assert.deepEqual(
    drawnKindCounts([
      { memberCount: 4 },
      { id: 'x', label: 'x', distance: 0, kind: 'function' },
    ]),
    [{ kind: 'function', count: 1 }],
  );
});
