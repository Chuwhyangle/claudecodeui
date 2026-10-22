import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  activeFilterCount,
  applyFilter,
  ARCHITECTURE_DEFAULT_FILTER,
  ARCHITECTURE_ELEMENT_KINDS,
  ARCHITECTURE_SHOW_ALL_FILTER,
  filtersEqual,
  hiddenTotal,
  isFilterNarrower,
  isRelationAllowed,
  relationsForPreset,
  type ArchitectureElementRelationFilter,
} from '@/modules/architecture/elementRelationFilter';
import type {
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';

/**
 * The element/relation filter's pure core.
 *
 * Two independent axes — the entity KINDS to keep and the relation PRESET — plus
 * an isolated-node toggle. The panel and the server test this same function's
 * readings through their own criteria; this file pins the function itself:
 * which nodes survive, which edges survive with them, the counts that say so,
 * and the one exemption (`direct` mentions) the whole model turns on.
 */

const node = (
  id: string,
  distance: number,
  extra: Partial<ArchitectureRendererNode> = {},
): ArchitectureRendererNode => ({ id, label: id, distance, ...extra });

const edge = (from: string, to: string, relationType: string): ArchitectureRendererEdge => ({
  from,
  to,
  relationType,
});

/**
 * One graph that exercises every element-axis case at once:
 *  · `A`/`B`/`C` are structural entities (class/interface/class);
 *  · `F`/`O` are the default-hidden kinds;
 *  · `DF` is a function that IS a direct mention — the exemption;
 *  · `NF`/`FF` are functions at distance 0 that are only same-name / file
 *    expansions, which must be treated as ordinary nodes;
 *  · `L` is a legacy distance-0 node with no `mentionTier` at all.
 */
const GRAPH: ArchitectureRendererGraph = {
  nodes: [
    node('A', 0, { kind: 'class' }),
    node('B', 1, { kind: 'interface' }),
    node('C', 2, { kind: 'class' }),
    node('F', 1, { kind: 'function' }),
    node('O', 2, { kind: 'other' }),
    node('DF', 0, { kind: 'function', mentionTier: 'direct' }),
    node('NF', 0, { kind: 'function', mentionTier: 'name' }),
    node('FF', 0, { kind: 'function', mentionTier: 'file' }),
    node('L', 0, { kind: 'class' }),
  ],
  edges: [
    edge('B', 'A', 'dependency'),
    edge('C', 'B', 'dependency'),
    edge('C', 'A', 'call'),
    edge('F', 'A', 'call'),
    edge('O', 'A', 'dependency'),
    edge('B', 'DF', 'dependency'),
    edge('NF', 'A', 'dependency'),
    edge('FF', 'A', 'dependency'),
  ],
};

const idsOf = (nodes: readonly ArchitectureRendererNode[]): string[] => nodes.map((entry) => entry.id);

const edgeKeys = (edges: readonly ArchitectureRendererEdge[]): string[] =>
  edges.map((entry) => `${entry.from}->${entry.to}:${entry.relationType}`).sort();

describe('applyFilter — the shipped default', () => {
  it('hides functions/others and call edges, and keeps every structural entity', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);

    assert.deepEqual(idsOf(result.nodes), ['A', 'B', 'C', 'DF', 'L']);
    assert.deepEqual(edgeKeys(result.edges), ['B->A:dependency', 'B->DF:dependency', 'C->B:dependency'].sort());
    console.log(
      `element-filter reading: default nodes=${JSON.stringify(idsOf(result.nodes))} ` +
        `edges=${JSON.stringify(edgeKeys(result.edges))} hidden=${JSON.stringify(result.hidden)}`,
    );
  });

  it('keeps a direct mention even when its kind is hidden', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    assert.ok(result.nodes.some((entry) => entry.id === 'DF'), 'a direct function mention is never hidden');
    assert.equal(result.hidden.byKind.function, 3, 'the three non-direct functions are hidden; DF is not counted');
  });

  it('hides name/file tier distance-0 nodes exactly like ordinary nodes', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    const present = new Set(idsOf(result.nodes));
    assert.equal(present.has('NF'), false, 'a same-name candidate is an ordinary node');
    assert.equal(present.has('FF'), false, 'a file-expansion node is an ordinary node');
    // …and the edges they alone anchored are gone with them.
    assert.equal(
      result.edges.some((entry) => entry.from === 'NF' || entry.from === 'FF'),
      false,
    );
  });

  it('treats a legacy distance-0 node with no mentionTier as a direct mention', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    assert.ok(result.nodes.some((entry) => entry.id === 'L'), 'the legacy payload keeps its old direct reading');
  });

  it('reports byKind/byRelation/isolated counts that match the removals', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    const removedNodes = GRAPH.nodes.filter((entry) => !result.nodes.some((kept) => kept.id === entry.id));
    const removedEdges = GRAPH.edges.filter(
      (entry) => !result.edges.some(
        (kept) => kept.from === entry.from && kept.to === entry.to && kept.relationType === entry.relationType,
      ),
    );

    const byKindTotal = Object.values(result.hidden.byKind).reduce<number>((sum, count) => sum + (count ?? 0), 0);
    // Every node removed BY THE ELEMENT AXIS: the relation axis never removes a node.
    assert.equal(byKindTotal, removedNodes.length - result.hidden.isolated);
    assert.equal(result.hidden.isolated, 0, 'no kept node was left isolated in this fixture');
    assert.equal(
      hiddenTotal(result.hidden),
      4 + 1,
      'four entities and one call edge are hidden: 3 functions + 1 other, and the structural call',
    );

    // The relation count is of edges BETWEEN KEPT nodes; an edge that dropped
    // with its endpoint is the element axis' doing, not a relation removal.
    assert.deepEqual(result.hidden.byRelation, { call: 1 });
    assert.deepEqual(result.hidden.byKind, { function: 3, other: 1 });
    // Every dropped edge is accounted for: 1 relation-hidden + 4 lost endpoints.
    assert.equal(removedEdges.length, 5);
    assert.equal(Object.values(result.hidden.byRelation).reduce((sum, count) => sum + count, 0), 1);
  });
});

describe('applyFilter — the relation presets are nested', () => {
  /** Structural nodes only, so the element axis is a no-op and presets are isolated. */
  const PRESET_GRAPH: ArchitectureRendererGraph = {
    nodes: [node('A', 0, { kind: 'class' }), node('B', 1, { kind: 'class' }), node('C', 2, { kind: 'class' })],
    edges: [
      edge('A', 'B', 'inheritance'),
      edge('B', 'C', 'implementation'),
      edge('C', 'A', 'composition'),
      edge('A', 'C', 'aggregation'),
      edge('B', 'A', 'dependency'),
      edge('C', 'B', 'call'),
      edge('A', 'A', 'unknown-future-kind'),
    ],
  };

  const withPreset = (relations: ArchitectureElementRelationFilter['relations']) =>
    applyFilter(PRESET_GRAPH, { ...ARCHITECTURE_DEFAULT_FILTER, relations, hideIsolated: false });

  it('structural ⊂ dependency ⊂ call, on the edge set', () => {
    const structural = new Set(edgeKeys(withPreset('structural').edges));
    const dependency = new Set(edgeKeys(withPreset('dependency').edges));
    const call = new Set(edgeKeys(withPreset('call').edges));

    for (const key of structural) assert.ok(dependency.has(key), `${key} kept by structural must be kept by +deps`);
    for (const key of dependency) assert.ok(call.has(key), `${key} kept by +deps must be kept by +calls`);
    assert.ok(dependency.size > structural.size);
    assert.ok(call.size > dependency.size);
  });

  it('names every structural relation kind, including aggregation', () => {
    assert.deepEqual(
      edgeKeys(withPreset('structural').edges),
      ['A->B:inheritance', 'A->C:aggregation', 'B->C:implementation', 'C->A:composition'].sort(),
    );
  });

  it('treats an unknown relation kind as the dependency tier', () => {
    const structural = withPreset('structural');
    const dependency = withPreset('dependency');
    const call = withPreset('call');
    assert.equal(structural.edges.some((entry) => entry.relationType === 'unknown-future-kind'), false);
    assert.ok(dependency.edges.some((entry) => entry.relationType === 'unknown-future-kind'));
    assert.ok(call.edges.some((entry) => entry.relationType === 'unknown-future-kind'));
    assert.equal(isRelationAllowed('structural', 'aggregation'), true);
    assert.equal(isRelationAllowed('dependency', 'call'), false);
    assert.equal(isRelationAllowed('call', 'call'), true);
    assert.equal(isRelationAllowed('dependency', 'unknown-future-kind'), true);
  });

  it('sends the server only vocabulary it accepts', () => {
    // The route rejects an unknown value with 400, so the request list must not
    // carry `aggregation` (the server's RelationType has no such member) even
    // though the client honours it on an arrived payload.
    assert.deepEqual(relationsForPreset('structural'), ['inheritance', 'implementation', 'composition']);
    assert.equal(relationsForPreset('dependency').includes('dependency'), true);
    assert.equal(relationsForPreset('dependency').includes('call'), false);
    assert.deepEqual(relationsForPreset('call'), [
      'inheritance',
      'implementation',
      'composition',
      'dependency',
      'call',
    ]);
  });
});

describe('applyFilter — isolated nodes', () => {
  /** Two structural nodes reachable ONLY through a call edge, plus a direct seed. */
  const ISOLATED_GRAPH: ArchitectureRendererGraph = {
    nodes: [node('S', 0, { kind: 'class' }), node('X', 1, { kind: 'class' }), node('Z', 1, { kind: 'class' })],
    edges: [edge('X', 'S', 'call'), edge('Z', 'S', 'call')],
  };

  it('removes the nodes the narrowed relation set leaves isolated', () => {
    const result = applyFilter(ISOLATED_GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    assert.deepEqual(idsOf(result.nodes), ['S'], 'only the direct seed survives');
    assert.equal(result.hidden.isolated, 2);
    assert.deepEqual(result.hidden.byRelation, { call: 2 });
  });

  it('never removes a direct seed, even when it is isolated', () => {
    const result = applyFilter(ISOLATED_GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    assert.ok(result.nodes.some((entry) => entry.id === 'S'));
    assert.equal(result.hidden.isolated, 2, 'the exempt seed is not counted as a removable isolated node');
  });

  it('keeps everything when the toggle is off', () => {
    const result = applyFilter(ISOLATED_GRAPH, { ...ARCHITECTURE_DEFAULT_FILTER, hideIsolated: false });
    assert.deepEqual(idsOf(result.nodes), ['S', 'X', 'Z']);
    assert.equal(result.hidden.isolated, 0);
    assert.deepEqual(result.edges, []);
  });
});

describe('applyFilter — degenerate inputs', () => {
  it('answers an empty graph without throwing', () => {
    const result = applyFilter({ nodes: [], edges: [] }, ARCHITECTURE_DEFAULT_FILTER);
    assert.deepEqual(result, { nodes: [], edges: [], hidden: { byKind: {}, byRelation: {}, isolated: 0 } });
    assert.equal(hiddenTotal(result.hidden), 0);
  });

  it('answers a fully-hidden graph without throwing and counts every removal', () => {
    const graph: ArchitectureRendererGraph = {
      nodes: [node('f1', 1, { kind: 'function' }), node('f2', 2, { kind: 'function' })],
      edges: [edge('f1', 'f2', 'call')],
    };
    const result = applyFilter(graph, { ...ARCHITECTURE_DEFAULT_FILTER, kinds: [], relations: 'structural' });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.hidden.byKind, { function: 2 });
    assert.equal(result.hidden.byRelation.call, undefined, 'the edge left with its endpoints');
  });

  it('never removes a node whose kind is unknown (no arch.json detail)', () => {
    const graph: ArchitectureRendererGraph = {
      nodes: [node('NoKind', 1), node('Other', 1, { kind: 'other' })],
      edges: [edge('NoKind', 'Other', 'dependency')],
    };
    const result = applyFilter(graph, { ...ARCHITECTURE_DEFAULT_FILTER, hideIsolated: false });
    assert.deepEqual(idsOf(result.nodes), ['NoKind'], 'missing detail is not `other`');
    assert.deepEqual(result.hidden.byKind, { other: 1 });
  });
});

describe('the filter model’s own helpers', () => {
  it('compares narrowing on both axes', () => {
    const full: ArchitectureElementRelationFilter = {
      kinds: [...ARCHITECTURE_ELEMENT_KINDS],
      relations: 'call',
      hideIsolated: false,
    };
    assert.equal(isFilterNarrower(ARCHITECTURE_DEFAULT_FILTER, full), true);
    assert.equal(isFilterNarrower(full, ARCHITECTURE_DEFAULT_FILTER), false);
    assert.equal(isFilterNarrower(full, full), true, 'equality is the no-op narrowing');
    // Fewer kinds is narrower; turning the isolated toggle ON is narrower.
    assert.equal(
      isFilterNarrower(
        { kinds: ['class'], relations: 'call', hideIsolated: false },
        { kinds: ['class', 'interface'], relations: 'call', hideIsolated: false },
      ),
      true,
    );
    assert.equal(
      isFilterNarrower(
        { kinds: ['class'], relations: 'call', hideIsolated: true },
        { kinds: ['class'], relations: 'call', hideIsolated: false },
      ),
      true,
    );
    // A different kind SET (neither subset) is not a narrowing.
    assert.equal(
      isFilterNarrower(
        { kinds: ['function'], relations: 'call', hideIsolated: false },
        { kinds: ['class'], relations: 'call', hideIsolated: false },
      ),
      false,
    );
  });

  it('compares selections by content, not by array order', () => {
    assert.equal(
      filtersEqual(
        { kinds: ['class', 'interface'], relations: 'dependency', hideIsolated: true },
        { kinds: ['interface', 'class'], relations: 'dependency', hideIsolated: true },
      ),
      true,
    );
    assert.equal(filtersEqual(ARCHITECTURE_DEFAULT_FILTER, ARCHITECTURE_SHOW_ALL_FILTER), false);
  });

  it('counts the badge’s active decisions', () => {
    // Two hidden kinds + one non-call preset + the isolated toggle.
    assert.equal(activeFilterCount(ARCHITECTURE_DEFAULT_FILTER), 4);
    assert.equal(activeFilterCount(ARCHITECTURE_SHOW_ALL_FILTER), 0);
  });
});
