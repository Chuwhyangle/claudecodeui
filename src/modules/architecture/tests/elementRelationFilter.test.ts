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
 * an isolated-node toggle and the per-kind "keep mentioned" switches. The panel
 * and the server test this same function's readings through their own criteria;
 * this file pins the function itself: which nodes survive, which edges survive
 * with them, the counts that say so, and the exemption the whole model turns on
 * (a PIN, which is unconditional; a mention, which is per kind).
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
 *  · `DF` is a function that IS a direct mention — hidden by default, kept only
 *    by a `function` switch;
 *  · `NF`/`FF` are functions at distance 0 that are only same-name / file
 *    expansions, which are ordinary nodes whatever the switches say;
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

const filterWith = (
  overrides: Partial<ArchitectureElementRelationFilter> = {},
): ArchitectureElementRelationFilter => ({ ...ARCHITECTURE_DEFAULT_FILTER, ...overrides });

describe('applyFilter — the shipped default', () => {
  it('hides functions/others and call edges, including the function the session mentioned', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);

    // `L` is a class (so the element axis keeps it) but it has no surviving
    // edge and its "keep mentioned" switch is OFF, so the isolated cut removes
    // it like any other node — a mention is no longer an isolation exemption by
    // itself.
    assert.deepEqual(idsOf(result.nodes), ['A', 'B', 'C']);
    assert.deepEqual(edgeKeys(result.edges), ['B->A:dependency', 'C->B:dependency'].sort());
    console.log(
      `element-filter reading: default nodes=${JSON.stringify(idsOf(result.nodes))} ` +
        `edges=${JSON.stringify(edgeKeys(result.edges))} hidden=${JSON.stringify(result.hidden)}`,
    );
  });

  it('hides a mentioned function when its kind has no switch on, and names it in the count', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    const present = new Set(idsOf(result.nodes));
    assert.equal(present.has('DF'), false, 'a direct function mention is hidden like any other function');
    assert.equal(result.hidden.byKind.function, 4, 'all four functions are hidden');
    assert.deepEqual(
      result.hidden.mentionedByKind,
      { function: 1 },
      'exactly one of the hidden functions was DIRECTLY mentioned (NF/FF are name/file tiers)',
    );
  });

  it('keeps the mentioned functions of a kind whose switch is on, and only those', () => {
    const result = applyFilter(GRAPH, filterWith({ keepMentionedKinds: ['function'] }));
    const present = new Set(idsOf(result.nodes));
    assert.equal(present.has('DF'), true, 'the switch brings back the mentioned function');
    assert.equal(present.has('F'), false, 'a function nobody mentioned stays hidden');
    assert.equal(present.has('NF'), false, 'a same-name candidate is not a mention');
    assert.equal(present.has('FF'), false, 'a file-expansion node is not a mention');
    assert.equal(result.hidden.byKind.function, 3, 'only the non-mentioned functions are still hidden');
    assert.equal(result.hidden.mentionedByKind, undefined, 'nothing mentioned is hidden, so no subset count');
    // The dependency edge to the restored function comes back with it.
    assert.ok(edgeKeys(result.edges).includes('B->DF:dependency'));
  });

  it('never hides a pinned entity, whatever the switches say', () => {
    const pinnedGraph: ArchitectureRendererGraph = {
      nodes: [
        node('P', 0, { kind: 'function', mentionTier: 'pinned' }),
        node('S', 1, { kind: 'class' }),
      ],
      edges: [],
    };
    // Every kind hidden AND no switch on: the pin still survives the element
    // axis and the isolated cut, while the ordinary class goes.
    const result = applyFilter(pinnedGraph, filterWith({ kinds: [] }));
    assert.deepEqual(idsOf(result.nodes), ['P'], 'a pin is exempt from every axis');
    assert.equal(result.hidden.isolated, 0, 'the pin is not counted as an isolated removal');
    assert.deepEqual(result.hidden.byKind, { class: 1 });
  });

  it('hides the name/file tiers exactly like ordinary nodes', () => {
    const result = applyFilter(GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    const present = new Set(idsOf(result.nodes));
    assert.equal(present.has('NF'), false, 'a same-name candidate is an ordinary node');
    assert.equal(present.has('FF'), false, 'a file-expansion node is an ordinary node');
  });

  it('reads a legacy distance-0 node without mentionTier as a direct mention (per-kind switch)', () => {
    // With the class switch on, the legacy node `L` is a held-open mention and
    // survives the isolated cut; with the switch off it is removed like any
    // other isolated node (see the default case above).
    const kept = applyFilter(GRAPH, filterWith({ keepMentionedKinds: ['class'] }));
    assert.ok(idsOf(kept.nodes).includes('L'), 'the legacy payload keeps its old direct reading');
    assert.equal(kept.hidden.isolated, 0);
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
    assert.equal(result.hidden.isolated, 1, 'the switch-less legacy mention is an isolated casualty');
    assert.equal(
      hiddenTotal(result.hidden),
      5 + 1 + 1,
      'five entities and one call edge are hidden, plus one isolated node',
    );

    // The relation count is of edges BETWEEN KEPT nodes; an edge that dropped
    // with its endpoint is the element axis' doing, not a relation removal.
    assert.deepEqual(result.hidden.byRelation, { call: 1 });
    assert.deepEqual(result.hidden.byKind, { function: 4, other: 1 });
    // Every dropped edge is accounted for: 1 relation-hidden + 5 lost endpoints.
    assert.equal(removedEdges.length, 6);
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
    applyFilter(PRESET_GRAPH, filterWith({ relations, hideIsolated: false }));

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
    assert.deepEqual(idsOf(result.nodes), [], 'the direct seed loses its only edges and is not switch-exempt');
    assert.equal(result.hidden.isolated, 3);
    assert.deepEqual(result.hidden.byRelation, { call: 2 });
  });

  it('keeps a mentioned entity out of the isolated cut only when its kind’s switch is on', () => {
    const result = applyFilter(ISOLATED_GRAPH, filterWith({ keepMentionedKinds: ['class'] }));
    assert.deepEqual(idsOf(result.nodes), ['S']);
    assert.equal(result.hidden.isolated, 2, 'the exempt seed is not counted as a removable isolated node');
  });

  it('keeps everything when the toggle is off', () => {
    const result = applyFilter(ISOLATED_GRAPH, filterWith({ hideIsolated: false }));
    assert.deepEqual(idsOf(result.nodes), ['S', 'X', 'Z']);
    assert.equal(result.hidden.isolated, 0);
    assert.deepEqual(result.edges, []);
  });

  /**
   * One mentioned entity per axis case, no edges at all: whether it survives is
   * decided purely by its kind's switch.
   */
  const MENTIONED_ONLY_GRAPH: ArchitectureRendererGraph = {
    nodes: [
      node('S', 0, { kind: 'class', mentionTier: 'direct' }),
      node('M', 0, { kind: 'function', mentionTier: 'direct' }),
    ],
    edges: [],
  };

  it('removes a switch-off mentioned entity as an ordinary isolated node', () => {
    const result = applyFilter(MENTIONED_ONLY_GRAPH, ARCHITECTURE_DEFAULT_FILTER);
    assert.deepEqual(idsOf(result.nodes), [], 'neither kind has a switch on');
    assert.deepEqual(result.hidden.byKind, { function: 1 }, 'M is hidden by the element axis');
    assert.deepEqual(result.hidden.mentionedByKind, { function: 1 });
    assert.equal(result.hidden.isolated, 1, 'S is visible but isolated, so the toggle removes it');
  });

  it('keeps a switch-on mentioned entity even when it is isolated', () => {
    const result = applyFilter(MENTIONED_ONLY_GRAPH, filterWith({ keepMentionedKinds: ['function'] }));
    assert.deepEqual(idsOf(result.nodes), ['M'], 'the switch keeps M out of both cuts; S is still isolated');
    assert.equal(result.hidden.isolated, 1, 'S has no switch, so it is an ordinary isolated node');
    assert.equal(result.hidden.byKind.class, undefined, 'S is removed by the isolated cut, not the element axis');
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
    const result = applyFilter(graph, filterWith({ kinds: [], relations: 'structural' }));
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
    const result = applyFilter(graph, filterWith({ hideIsolated: false }));
    assert.deepEqual(idsOf(result.nodes), ['NoKind'], 'missing detail is not `other`');
    assert.deepEqual(result.hidden.byKind, { other: 1 });
  });
});

describe('the filter model’s own helpers', () => {
  it('compares narrowing on every axis', () => {
    const full: ArchitectureElementRelationFilter = {
      kinds: [...ARCHITECTURE_ELEMENT_KINDS],
      relations: 'call',
      hideIsolated: false,
      keepMentionedKinds: [],
    };
    assert.equal(isFilterNarrower(ARCHITECTURE_DEFAULT_FILTER, full), true);
    assert.equal(isFilterNarrower(full, ARCHITECTURE_DEFAULT_FILTER), false);
    assert.equal(isFilterNarrower(full, full), true, 'equality is the no-op narrowing');
    // Fewer kinds is narrower; turning the isolated toggle ON is narrower.
    assert.equal(
      isFilterNarrower(
        { kinds: ['class'], relations: 'call', hideIsolated: false, keepMentionedKinds: [] },
        { kinds: ['class', 'interface'], relations: 'call', hideIsolated: false, keepMentionedKinds: [] },
      ),
      true,
    );
    assert.equal(
      isFilterNarrower(
        { kinds: ['class'], relations: 'call', hideIsolated: true, keepMentionedKinds: [] },
        { kinds: ['class'], relations: 'call', hideIsolated: false, keepMentionedKinds: [] },
      ),
      true,
    );
    // A different kind SET (neither subset) is not a narrowing.
    assert.equal(
      isFilterNarrower(
        { kinds: ['function'], relations: 'call', hideIsolated: false, keepMentionedKinds: [] },
        { kinds: ['class'], relations: 'call', hideIsolated: false, keepMentionedKinds: [] },
      ),
      false,
    );
  });

  it('treats the keep-mentioned list as an axis: dropping a kind narrows, adding one widens', () => {
    const both = filterWith({ keepMentionedKinds: ['class', 'function'] });
    const one = filterWith({ keepMentionedKinds: ['function'] });
    const none = filterWith({ keepMentionedKinds: [] });

    assert.equal(isFilterNarrower(one, both), true, 'removing a switch hides more, so it is a narrowing');
    assert.equal(isFilterNarrower(both, one), false, 'adding a switch can only reveal, so it must re-request');
    assert.equal(isFilterNarrower(none, both), true);
    assert.equal(isFilterNarrower(both, none), false);
    assert.equal(filtersEqual(one, filterWith({ keepMentionedKinds: ['function'] })), true);
    assert.equal(filtersEqual(one, none), false);
  });

  it('compares selections by content, not by array order', () => {
    assert.equal(
      filtersEqual(
        { kinds: ['class', 'interface'], relations: 'dependency', hideIsolated: true, keepMentionedKinds: [] },
        { kinds: ['interface', 'class'], relations: 'dependency', hideIsolated: true, keepMentionedKinds: [] },
      ),
      true,
    );
    assert.equal(
      filtersEqual(
        filterWith({ keepMentionedKinds: ['class', 'function'] }),
        filterWith({ keepMentionedKinds: ['function', 'class'] }),
      ),
      true,
      'the switch list is a set too',
    );
    assert.equal(filtersEqual(ARCHITECTURE_DEFAULT_FILTER, ARCHITECTURE_SHOW_ALL_FILTER), false);
  });

  it('counts the badge’s active decisions', () => {
    // Two hidden kinds + one non-call preset + the isolated toggle.
    assert.equal(activeFilterCount(ARCHITECTURE_DEFAULT_FILTER), 4);
    assert.equal(activeFilterCount(ARCHITECTURE_SHOW_ALL_FILTER), 0);
    // Every switch the reader opens is one more decision the tab is making.
    assert.equal(activeFilterCount(filterWith({ keepMentionedKinds: ['function'] })), 5);
    assert.equal(activeFilterCount(filterWith({ keepMentionedKinds: ['class', 'function'] })), 6);
  });
});
