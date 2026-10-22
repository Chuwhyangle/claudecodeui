import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  createSelectionState,
  cycleNodeFocus,
  reduceSelection,
  selectionInScope,
  selectionScopesEqual,
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
