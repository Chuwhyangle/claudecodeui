import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  ARCHITECTURE_SCOPE_MAX,
  ARCHITECTURE_SCOPE_MIN,
  clampArchitectureScope,
  rankArchitectureDetail,
  type ArchitectureDetailTier,
} from '@/modules/architecture/detailRanking';
import {
  applyFilter,
  ARCHITECTURE_DEFAULT_FILTER,
} from '@/modules/architecture/elementRelationFilter';
import type {
  ArchitectureRendererEdge,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';

/**
 * The detail knob's pure core: given one scope's graph and a tier, which nodes
 * survive, which edges survive with them, and is the answer deterministic. The
 * panel renders the result verbatim, so everything the reader sees about
 * "how much is kept" is decided here.
 */

const node = (id: string, distance: number): ArchitectureRendererNode => ({
  id,
  label: id,
  distance,
});

const edge = (from: string, to: string): ArchitectureRendererEdge => ({
  from,
  to,
  relationType: 'dependency',
});

/** Ids of a set, sorted, so two runs can be compared exactly. */
const sortedIds = (ids: ReadonlySet<string>): string[] => [...ids].sort();

describe('rankArchitectureDetail', () => {
  /**
   * One seed plus four reachable nodes. The ordering inputs are deliberately
   * crossed: `near-light` is nearer than `far-heavy`, so distance must win
   * before in-degree.
   */
  const nodes: ArchitectureRendererNode[] = [
    node('seed', 0),
    node('near-heavy', 1),
    node('near-light', 1),
    node('far-heavy', 2),
    node('far-light', 3),
  ];
  const edges: ArchitectureRendererEdge[] = [
    edge('far-heavy', 'near-heavy'),
    edge('far-light', 'near-heavy'),
    edge('near-light', 'far-heavy'),
    edge('seed', 'near-light'),
  ];

  it('always keeps every seed, in every tier', () => {
    for (const tier of ['core', 'common', 'all'] as const) {
      const ranking = rankArchitectureDetail(nodes, edges, tier);
      assert.ok(ranking.retainedNodeIds.has('seed'), `the distance-0 node must survive ${tier}`);
    }
  });

  it('orders by distance, then in-degree, and takes the tier prefix', () => {
    // Four non-seed nodes: core keeps ceil(4 * 0.15) = 1, common ceil(4 * 0.5) = 2.
    const core = rankArchitectureDetail(nodes, edges, 'core');
    assert.deepEqual(sortedIds(core.retainedNodeIds), ['near-heavy', 'seed']);
    const common = rankArchitectureDetail(nodes, edges, 'common');
    assert.deepEqual(sortedIds(common.retainedNodeIds), ['near-heavy', 'near-light', 'seed']);
  });

  it('nests the tiers: core ⊆ common ⊆ all', () => {
    const core = rankArchitectureDetail(nodes, edges, 'core');
    const common = rankArchitectureDetail(nodes, edges, 'common');
    const all = rankArchitectureDetail(nodes, edges, 'all');

    for (const id of core.retainedNodeIds) {
      assert.ok(common.retainedNodeIds.has(id), `${id} kept by core must be kept by common`);
      assert.ok(all.retainedNodeIds.has(id), `${id} kept by core must be kept by all`);
    }
    for (const id of common.retainedNodeIds) {
      assert.ok(all.retainedNodeIds.has(id), `${id} kept by common must be kept by all`);
    }
    assert.ok(core.retainedNodeIds.size < common.retainedNodeIds.size);
    assert.ok(common.retainedNodeIds.size < all.retainedNodeIds.size);
  });

  it('is deterministic for the same input', () => {
    const first = rankArchitectureDetail(nodes, edges, 'common');
    const second = rankArchitectureDetail(nodes, edges, 'common');
    assert.deepEqual(sortedIds(first.retainedNodeIds), sortedIds(second.retainedNodeIds));
    assert.equal(first.foldedCount, second.foldedCount);
    assert.deepEqual(
      first.graph.nodes.map((entry) => entry.id),
      second.graph.nodes.map((entry) => entry.id),
    );
  });

  it('keeps the edges between retained nodes and drops every edge touching a folded one', () => {
    const core = rankArchitectureDetail(nodes, edges, 'core');
    // `seed` and `near-heavy` are the retained pair; the only edge that can
    // survive is one with both ends in that set, and this fixture has none.
    assert.ok(core.retainedNodeIds.has('seed'));
    assert.ok(core.retainedNodeIds.has('near-heavy'));
    assert.deepEqual(core.graph.edges, []);

    const common = rankArchitectureDetail(nodes, edges, 'common');
    // seed → near-light survives (both kept); every near-heavy edge points from
    // an unkept source, and near-light → far-light loses its target.
    assert.deepEqual(common.graph.edges, [edge('seed', 'near-light')]);
    for (const surviving of common.graph.edges) {
      assert.ok(common.retainedNodeIds.has(surviving.from));
      assert.ok(common.retainedNodeIds.has(surviving.to));
    }
    assert.equal(
      common.foldedCount,
      nodes.length - common.retainedNodeIds.size,
      'the folded count is exactly the nodes the tier removed',
    );
  });

  it('is the identity in the all tier', () => {
    const all = rankArchitectureDetail(nodes, edges, 'all');
    assert.equal(all.graph.nodes, nodes, 'all hands the input nodes back by reference');
    assert.equal(all.graph.edges, edges, 'all hands the input edges back by reference');
    assert.equal(all.foldedCount, 0);
    assert.equal(all.retainedNodeIds.size, nodes.length);
  });

  it('handles an empty graph and a seeds-only graph without folding anything', () => {
    const empty = rankArchitectureDetail([], [], 'core');
    assert.deepEqual(empty.graph, { nodes: [], edges: [] });
    assert.equal(empty.foldedCount, 0);

    const seedsOnly = rankArchitectureDetail([node('one', 0), node('two', 0)], [], 'core');
    assert.deepEqual(sortedIds(seedsOnly.retainedNodeIds), ['one', 'two']);
    assert.equal(seedsOnly.foldedCount, 0);
  });
});

describe('clampArchitectureScope', () => {
  it('holds the stepper inside 0..3', () => {
    assert.equal(ARCHITECTURE_SCOPE_MIN, 0);
    assert.equal(ARCHITECTURE_SCOPE_MAX, 3);
    assert.equal(clampArchitectureScope(-4), 0);
    assert.equal(clampArchitectureScope(0), 0);
    assert.equal(clampArchitectureScope(2), 2);
    assert.equal(clampArchitectureScope(3), 3);
    assert.equal(clampArchitectureScope(9), 3);
  });

  it('truncates fractions and falls back to the minimum for non-finite input', () => {
    assert.equal(clampArchitectureScope(2.9), 2);
    assert.equal(clampArchitectureScope(Number.NaN), 0);
    assert.equal(clampArchitectureScope(Number.POSITIVE_INFINITY), ARCHITECTURE_SCOPE_MAX);
  });
});

/** Compile-time guard: the tiers the panel offers are exactly these three. */
const TIERS: readonly ArchitectureDetailTier[] = ['core', 'common', 'all'];
void TIERS;

describe('the element/relation filter feeding the detail ranking', () => {
  /**
   * The SAME nodes and edges read two ways: the unfiltered graph gives `a` its
   * only in-edge through a `call`, so importance puts `a` first; the filtered
   * graph drops that call, so the edge into `b` (a dependency) decides instead.
   * Nothing but the in-degree over the FILTERED edges can flip the answer.
   */
  const filterNodes: ArchitectureRendererNode[] = [
    { id: 'seed', label: 'seed', distance: 0, kind: 'class' },
    { id: 'a', label: 'a', distance: 1, kind: 'class' },
    { id: 'b', label: 'b', distance: 1, kind: 'class' },
    { id: 'c', label: 'c', distance: 2, kind: 'class' },
  ];
  const filterEdges: ArchitectureRendererEdge[] = [
    { from: 'c', to: 'a', relationType: 'call' },
    { from: 'c', to: 'b', relationType: 'dependency' },
  ];

  it('ranks by in-degree over the filtered edges, so the filter changes which node survives', () => {
    // `core` keeps the seed plus ceil(3 × 0.15) = 1 non-seed node.
    const unfiltered = rankArchitectureDetail(filterNodes, filterEdges, 'core');
    assert.deepEqual(sortedIds(unfiltered.retainedNodeIds), ['a', 'seed'], 'the call gives a the higher in-degree');

    const filtered = applyFilter(
      { nodes: filterNodes, edges: filterEdges },
      { ...ARCHITECTURE_DEFAULT_FILTER, hideIsolated: false },
    );
    assert.deepEqual(
      filtered.edges.map((entry) => `${entry.from}->${entry.to}:${entry.relationType}`),
      ['c->b:dependency'],
      'the call edge was dropped before the ranking saw the graph',
    );

    const ranked = rankArchitectureDetail(filtered.nodes, filtered.edges, 'core');
    assert.deepEqual(sortedIds(ranked.retainedNodeIds), ['b', 'seed'], 'b now carries the only in-edge');
    assert.notDeepEqual(sortedIds(ranked.retainedNodeIds), sortedIds(unfiltered.retainedNodeIds));
    console.log(
      `detail-filter reading: unfiltered=${JSON.stringify(sortedIds(unfiltered.retainedNodeIds))} ` +
        `filtered=${JSON.stringify(sortedIds(ranked.retainedNodeIds))}`,
    );
  });
});
