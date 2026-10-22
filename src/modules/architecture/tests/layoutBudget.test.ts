import assert from 'node:assert/strict';

import { test } from 'vitest';

import { fitToLayoutBudget, LAYOUT_NODE_BUDGET } from '@/modules/architecture/layoutBudget';
import type {
  ArchitectureRendererEdge,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';

/**
 * The layout budget's contract, as a pure function:
 *  · a graph the detail tier already fits is returned unchanged (the identity
 *    tier's own arrays, so nothing is copied or reordered);
 *  · over budget, the highest detail tier that fits is applied before any
 *    importance truncation;
 *  · when even the lowest tier is over budget, important nodes win — seeds,
 *    direct mentions and pinned nodes first, then distance/in-degree/id;
 *  · edges follow their endpoints at every cut, and the same input always
 *    produces the same output.
 */

function node(
  id: string,
  distance: number,
  extra: Partial<ArchitectureRendererNode> = {},
): ArchitectureRendererNode {
  return { id, label: id, distance, ...extra };
}

function edge(from: string, to: string): ArchitectureRendererEdge {
  return { from, to, relationType: 'dependency' };
}

/** `count` non-seed nodes at increasing hop distances. */
function ladder(count: number, prefix = 'node'): ArchitectureRendererNode[] {
  return Array.from({ length: count }, (_unused, index) => node(`${prefix}-${String(index)}`, index + 1));
}

test('LAYOUT_NODE_BUDGET is the documented starting point', () => {
  assert.equal(LAYOUT_NODE_BUDGET, 600);
});

test('a graph the identity tier already fits is returned as the same arrays', () => {
  const nodes = [node('a', 0), node('b', 1), node('c', 2)];
  const edges = [edge('b', 'a'), edge('c', 'b')];

  const fit = fitToLayoutBudget(nodes, edges, 'all', 3);

  assert.equal(fit.limited, false, 'the budget did not change the drawing');
  assert.equal(fit.tier, 'all');
  assert.equal(fit.droppedCount, 0);
  assert.equal(fit.graph.nodes, nodes, 'the input nodes array is returned, not a copy');
  assert.equal(fit.graph.edges, edges, 'the input edges array is returned, not a copy');
});

test('the requested detail tier still applies when it already fits', () => {
  // 20 non-seeds: `core` keeps ceil(20 × 0.15) = 3. A budget of 100 must not
  // undo that cut — the budget is a ceiling on top of the tier, not a replacement.
  const fit = fitToLayoutBudget(ladder(20), [], 'core', 100);

  assert.equal(fit.limited, false, 'the budget itself cut nothing');
  assert.equal(fit.tier, 'core');
  assert.equal(fit.graph.nodes.length, 3);
});

test('over budget, the highest LOWER detail tier that fits is applied first', () => {
  // 40 non-seeds, identity tier: `common` keeps ceil(40 × 0.5) = 20.
  const nodes = ladder(40);

  const common = fitToLayoutBudget(nodes, [], 'all', 20);
  assert.equal(common.tier, 'common', 'the identity tier fell back one step');
  assert.equal(common.graph.nodes.length, 20);
  assert.equal(common.limited, true);
  assert.equal(common.droppedCount, 20);

  // One node tighter and `common` no longer fits: `core` (6) is the fallback.
  const core = fitToLayoutBudget(nodes, [], 'all', 19);
  assert.equal(core.tier, 'core');
  assert.equal(core.graph.nodes.length, 6);
  assert.equal(core.droppedCount, 34);
});

test('when even the lowest tier is over budget, the important nodes are truncated', () => {
  // 100 non-seeds at distances 1..100: `core` keeps 15, still over a budget of 5.
  const nodes = ladder(100);
  const fit = fitToLayoutBudget(nodes, [], 'all', 5);

  assert.equal(fit.tier, 'core', 'the fallback goes as low as it can before truncating');
  assert.equal(fit.graph.nodes.length, 5);
  assert.equal(fit.droppedCount, 95);
  assert.deepEqual(
    fit.graph.nodes.map((retained) => retained.id),
    ['node-0', 'node-1', 'node-2', 'node-3', 'node-4'],
    'the nearest nodes survive the importance cut',
  );
});

test('seeds, direct mentions and pinned nodes outrank nearer ordinary nodes', () => {
  // The ordinary nodes fill the lower tiers past the budget, so this case
  // reaches the importance truncation rather than stopping at a tier fallback.
  const nodes = [
    ...ladder(40, 'near'),
    node('seed', 0),
    // A direct mention and a pinned node can sit far out and still be kept:
    // both are things the reader explicitly asked to see.
    node('direct-mention', 9, { mentionTier: 'direct' }),
    node('pinned', 10),
  ];

  const fit = fitToLayoutBudget(nodes, [], 'all', 3, ['pinned']);

  assert.equal(fit.graph.nodes.length, 3);
  assert.deepEqual(
    fit.graph.nodes.map((retained) => retained.id),
    ['seed', 'direct-mention', 'pinned'],
    'the priority nodes are hoisted above the distance order',
  );
  assert.ok(!fit.graph.nodes.some((retained) => retained.id.startsWith('near-')), 'closer non-priority nodes are cut');
});

test('a dropped node takes its edges with it, while edges between survivors stay', () => {
  const nodes = [node('a', 1), node('b', 1), node('c', 1), node('d', 1)];
  // b and c have higher in-degree than a and d, so the importance cut keeps them.
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];

  const fit = fitToLayoutBudget(nodes, edges, 'all', 2);

  assert.deepEqual(fit.graph.nodes.map((retained) => retained.id), ['b', 'c']);
  assert.deepEqual(
    fit.graph.edges.map((kept) => [kept.from, kept.to]),
    [['b', 'c']],
    'the surviving edge is kept and both dangling edges are dropped',
  );
});

test('the same input always produces the same output', () => {
  const nodes = ladder(30);
  const edges = nodes.slice(0, -1).map((candidate, index) => edge(nodes[index + 1].id, candidate.id));

  const first = fitToLayoutBudget(nodes, edges, 'all', 4);
  const second = fitToLayoutBudget(nodes, edges, 'all', 4);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.graph.nodes.map((retained) => retained.id),
    second.graph.nodes.map((retained) => retained.id),
    'the retained order is deterministic too',
  );
});

test('empty input does not throw', () => {
  const fit = fitToLayoutBudget([], [], 'all');

  assert.equal(fit.limited, false);
  assert.equal(fit.tier, 'all');
  assert.equal(fit.droppedCount, 0);
  assert.deepEqual(fit.graph, { nodes: [], edges: [] });
});
