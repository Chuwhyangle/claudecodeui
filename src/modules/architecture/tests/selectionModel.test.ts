import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  createSelectionState,
  cycleNodeFocus,
  reduceSelection,
  resolveDraftScope,
  selectionInScope,
  selectionKey,
  selectionScopesEqual,
  selectionsIntersectingBox,
  selectionsInScope,
  type ArchitectureSelectionRect,
  type ArchitectureSelectionScope,
} from '@/modules/architecture/selectionModel';

/**
 * The selection model's contract:
 *  · one entity or one relation, or nothing;
 *  · a view or session change clears the selection in the same transition;
 *  · `]`/`[` walk the drawing's node order and wrap at both ends;
 *  · the module keeps no state of its own — two callers never share a
 *    selection, and a reducer call never mutates the state it was handed.
 */

const SCOPE: ArchitectureSelectionScope = {
  projectId: 'project-1',
  sessionId: 'session-1',
  view: 'entity',
};

test('selects an entity, replaces it with a relation, and clears', () => {
  const empty = createSelectionState(SCOPE);
  assert.equal(empty.selection, null, 'a fresh state selects nothing');

  const entity = reduceSelection(empty, { type: 'select-entity', nodeId: 'src/a.ts.Alpha' });
  assert.deepEqual(entity.selection, { kind: 'entity', nodeId: 'src/a.ts.Alpha' });

  const relation = reduceSelection(entity, {
    type: 'select-relation',
    from: 'src/a.ts.Alpha',
    to: 'src/b.ts.Beta',
    relationType: 'dependency',
  });
  assert.deepEqual(
    relation.selection,
    { kind: 'relation', from: 'src/a.ts.Alpha', to: 'src/b.ts.Beta', relationType: 'dependency' },
    'the model is single-select: the relation replaces the entity',
  );

  assert.equal(reduceSelection(relation, { type: 'clear' }).selection, null);
});

test('a view change or a session change clears the selection', () => {
  const selected = reduceSelection(createSelectionState(SCOPE), {
    type: 'select-entity',
    nodeId: 'src/a.ts.Alpha',
  });

  // Same scope is a no-op that keeps the selection.
  assert.equal(
    reduceSelection(selected, { type: 'sync-scope', scope: { ...SCOPE } }).selection?.kind,
    'entity',
  );

  // A view switch (file/class, or the renderer's own view) clears.
  const otherView = reduceSelection(selected, {
    type: 'sync-scope',
    scope: { ...SCOPE, view: 'file' },
  });
  assert.equal(otherView.selection, null, 'changing the view must clear the selection');
  assert.equal(otherView.scope.view, 'file');

  // A session switch clears too.
  const otherSession = reduceSelection(selected, {
    type: 'sync-scope',
    scope: { ...SCOPE, sessionId: 'session-2' },
  });
  assert.equal(otherSession.selection, null, 'changing the session must clear the selection');

  // The guard also refuses to READ a selection made for another scope, which is
  // what protects the one render between a prop change and the reducer call.
  assert.equal(selectionInScope(selected, SCOPE)?.kind, 'entity');
  assert.equal(selectionInScope(selected, { ...SCOPE, sessionId: 'session-2' }), null);
  assert.equal(selectionScopesEqual(SCOPE, { ...SCOPE }), true);
  assert.equal(selectionScopesEqual(SCOPE, { ...SCOPE, view: 'file' }), false);
});

test('`]` and `[` cycle the node order and wrap at both ends', () => {
  const ids = ['a', 'b', 'c'];

  assert.equal(cycleNodeFocus(ids, null, 1), 'a', 'forward enters at the first node');
  assert.equal(cycleNodeFocus(ids, null, -1), 'c', 'backward enters at the last node');
  assert.equal(cycleNodeFocus(ids, 'a', 1), 'b');
  assert.equal(cycleNodeFocus(ids, 'b', 1), 'c');
  assert.equal(cycleNodeFocus(ids, 'c', 1), 'a', 'forward wraps to the start');
  assert.equal(cycleNodeFocus(ids, 'a', -1), 'c', 'backward wraps to the end');
  assert.equal(cycleNodeFocus(ids, 'b', -1), 'a');
  assert.equal(cycleNodeFocus(ids, 'missing', 1), 'a', 'an id that left the drawing re-enters');
  assert.equal(cycleNodeFocus([], null, 1), null, 'an empty drawing has nowhere to move');
});

test('the module holds no selection of its own', () => {
  // Two independently created states must not observe each other.
  const first = createSelectionState(SCOPE);
  const second = createSelectionState(SCOPE);
  const selected = reduceSelection(first, { type: 'select-entity', nodeId: 'src/a.ts.Alpha' });

  assert.equal(first.selection, null, 'the input state must not be mutated');
  assert.equal(second.selection, null, 'a second caller must not see the first caller’s selection');
  assert.notEqual(selected, first, 'a transition returns a new state object');
  assert.equal(selected.selection?.kind, 'entity');

  const cleared = reduceSelection(selected, { type: 'clear' });
  assert.equal(cleared.selection, null);
  assert.equal(selected.selection?.kind, 'entity', 'clearing must not mutate the previous state');
});

test('the selection is a set: additive toggles, marquee adds, remove and clear', () => {
  let state = createSelectionState(SCOPE);
  state = reduceSelection(state, { type: 'toggle-entity', nodeId: 'src/a.ts.Alpha' });
  state = reduceSelection(state, { type: 'toggle-entity', nodeId: 'src/b.ts.Beta' });
  const relation = {
    type: 'toggle-relation',
    from: 'src/a.ts.Alpha',
    to: 'src/b.ts.Beta',
    relationType: 'inheritance',
  } as const;
  state = reduceSelection(state, relation);

  assert.deepEqual(
    state.selections.map(selectionKey),
    [
      'entity:src/a.ts.Alpha',
      'entity:src/b.ts.Beta',
      'relation:src/a.ts.Alpha\u0000src/b.ts.Beta\u0000inheritance',
    ],
    'additive toggles append in order',
  );
  assert.deepEqual(
    state.selection,
    { kind: 'relation', from: 'src/a.ts.Alpha', to: 'src/b.ts.Beta', relationType: 'inheritance' },
    'the primary selection is the last member added',
  );
  assert.deepEqual(
    selectionsInScope(state, SCOPE).map(selectionKey),
    state.selections.map(selectionKey),
    'the scope reading returns the whole set',
  );

  // Toggling an existing member removes it and re-derives the primary.
  const removed = reduceSelection(state, { type: 'toggle-entity', nodeId: 'src/b.ts.Beta' });
  assert.deepEqual(removed.selections.map(selectionKey), [
    'entity:src/a.ts.Alpha',
    'relation:src/a.ts.Alpha\u0000src/b.ts.Beta\u0000inheritance',
  ]);
  assert.equal(removed.selection?.kind, 'relation', 'the remaining last member becomes primary');

  // A marquee adds every hit, and never duplicates one already selected.
  const boxed = reduceSelection(removed, {
    type: 'add-selections',
    selections: [
      { kind: 'entity', nodeId: 'src/c.ts.Gamma' },
      { kind: 'entity', nodeId: 'src/a.ts.Alpha' },
    ],
  });
  assert.deepEqual(boxed.selections.map(selectionKey), [
    'entity:src/a.ts.Alpha',
    'relation:src/a.ts.Alpha\u0000src/b.ts.Beta\u0000inheritance',
    'entity:src/c.ts.Gamma',
  ]);

  // A remove-by-key is the tag's × action.
  const untagged = reduceSelection(boxed, {
    type: 'remove-selection',
    key: 'entity:src/c.ts.Gamma',
  });
  assert.equal(untagged.selections.length, 2);

  // A plain click keeps the single-selection contract: it REPLACES the set.
  const replaced = reduceSelection(untagged, { type: 'select-entity', nodeId: 'src/d.ts.Delta' });
  assert.deepEqual(replaced.selections.map(selectionKey), ['entity:src/d.ts.Delta']);

  assert.equal(reduceSelection(replaced, { type: 'clear' }).selections.length, 0);
});

test('the marquee hit rule covers nodes and relations and rejects zero-area boxes', () => {
  const candidates = [
    {
      selection: { kind: 'entity', nodeId: 'inside' } as const,
      rect: { left: 10, top: 10, right: 40, bottom: 40 },
    },
    {
      selection: { kind: 'entity', nodeId: 'outside' } as const,
      rect: { left: 200, top: 200, right: 260, bottom: 260 },
    },
    {
      // A relation's enlarged hit band is a thin rectangle; it is a first-class
      // marquee candidate, not only a click target.
      selection: { kind: 'relation', from: 'a', to: 'b', relationType: 'call' } as const,
      rect: { left: 60, top: 20, right: 120, bottom: 22 },
    },
    {
      // jsdom / a hidden canvas reports no box: it must never be "hit".
      selection: { kind: 'entity', nodeId: 'unmeasured' } as const,
      rect: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  ];
  const box: ArchitectureSelectionRect = { left: 0, top: 0, right: 100, bottom: 100 };
  assert.deepEqual(
    selectionsIntersectingBox(candidates, box).map(selectionKey),
    ['entity:inside', 'relation:a\u0000b\u0000call'],
    'both a node and an edge rectangle are hit; a zero-area box is not',
  );
  // An edge band that only touches the marquee at an edge is not a hit
  // (half-open comparison), so a degenerate rectangle cannot select a crowd.
  assert.deepEqual(
    selectionsIntersectingBox(candidates, { left: 120, top: 10, right: 150, bottom: 40 }),
    [],
    'touching the right edge of a rectangle is not an intersection',
  );
});

test('a scope change clears the WHOLE set, not only the primary member', () => {
  let state = createSelectionState(SCOPE);
  state = reduceSelection(state, { type: 'toggle-entity', nodeId: 'a' });
  state = reduceSelection(state, { type: 'toggle-entity', nodeId: 'b' });
  assert.equal(state.selections.length, 2);

  const otherSession = reduceSelection(state, {
    type: 'sync-scope',
    scope: { ...SCOPE, sessionId: 'session-2' },
  });
  assert.equal(otherSession.selections.length, 0, 'a session change empties the set');
  assert.equal(selectionsInScope(state, { ...SCOPE, view: 'file' }).length, 0);
  assert.equal(
    reduceSelection(state, { type: 'sync-scope', scope: { ...SCOPE } }).selections.length,
    2,
    'the same scope keeps the set',
  );
});

test('the draft scope mirrors the composer: the session, else the project', () => {
  assert.equal(resolveDraftScope('project-1', 'session-1'), 'session-1');
  assert.equal(resolveDraftScope('project-1', null), 'project:project-1');
  assert.equal(resolveDraftScope(null, null), null, 'nothing to write to disables composing');
});
