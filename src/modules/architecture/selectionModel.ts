/**
 * The architecture canvas's selection model.
 *
 * ONE selection at a time — an entity, a relation, or nothing — plus the scope
 * it belongs to. The scope is part of the state, not an afterthought: switching
 * the view (file/class) or the session must discard a selection that named
 * something the new graph does not draw, and keeping the scope in the state is
 * what makes that a pure reading instead of an effect that races a render.
 *
 * The module is deliberately stateless. Every function takes the state it
 * reads and returns a new one, so two mounted panels (or a panel and a test)
 * can never observe each other's selection. The panel holds the one state
 * instance in React; the renderer reads it through props.
 *
 * Consumers: `ArchitecturePanel.tsx` (the owner of the state),
 * `ArchitectureInspector.tsx` (renders the selected entity/relation),
 * `PlantUmlGraph.tsx` (keyboard cycling reads `cycleNodeFocus`), and
 * `tests/selectionModel.test.ts`.
 */

/** One selectable thing on the canvas: an entity node or a relation edge. */
export type ArchitectureSelection =
  | { readonly kind: 'entity'; readonly nodeId: string }
  | {
    readonly kind: 'relation';
    readonly from: string;
    readonly to: string;
    readonly relationType: string;
  };

/**
 * What a selection is valid for. A selection is cleared when any field changes:
 * the view key covers the file/class subgraph AND the renderer's own view, and
 * the session/project identify the transcript the graph was generated from.
 */
export type ArchitectureSelectionScope = {
  readonly projectId: string | null;
  readonly sessionId: string | null;
  /** The subgraph/view the drawing shows (e.g. `entity` or `file:overview`). */
  readonly view: string;
};

/** The selection plus the scope it was made in. */
export type ArchitectureSelectionState = {
  readonly scope: ArchitectureSelectionScope;
  readonly selection: ArchitectureSelection | null;
};

/** The transitions the panel performs. */
export type ArchitectureSelectionAction =
  | { readonly type: 'select-entity'; readonly nodeId: string }
  | {
    readonly type: 'select-relation';
    readonly from: string;
    readonly to: string;
    readonly relationType: string;
  }
  | { readonly type: 'clear' }
  | { readonly type: 'sync-scope'; readonly scope: ArchitectureSelectionScope };

/** True when two scopes name the same view/session, field by field. */
export function selectionScopesEqual(
  left: ArchitectureSelectionScope,
  right: ArchitectureSelectionScope,
): boolean {
  return left.projectId === right.projectId
    && left.sessionId === right.sessionId
    && left.view === right.view;
}

/** An empty selection for `scope`. */
export function createSelectionState(scope: ArchitectureSelectionScope): ArchitectureSelectionState {
  return { scope, selection: null };
}

/**
 * Apply one action. A scope change CLEARS the selection in the same transition,
 * so a render can never show an entity from the previous view.
 */
export function reduceSelection(
  state: ArchitectureSelectionState,
  action: ArchitectureSelectionAction,
): ArchitectureSelectionState {
  if (action.type === 'sync-scope') {
    return selectionScopesEqual(state.scope, action.scope)
      ? state
      : { scope: action.scope, selection: null };
  }
  if (action.type === 'clear') {
    return state.selection === null ? state : { scope: state.scope, selection: null };
  }
  if (action.type === 'select-entity') {
    return { scope: state.scope, selection: { kind: 'entity', nodeId: action.nodeId } };
  }
  return {
    scope: state.scope,
    selection: {
      kind: 'relation',
      from: action.from,
      to: action.to,
      relationType: action.relationType,
    },
  };
}

/**
 * The selection to draw, or `null` when the state belongs to another scope.
 *
 * The panel re-syncs its state through the reducer whenever the scope moves,
 * but this reading keeps even a single render between the prop change and the
 * effect from drawing a stale inspector.
 */
export function selectionInScope(
  state: ArchitectureSelectionState,
  scope: ArchitectureSelectionScope,
): ArchitectureSelection | null {
  return selectionScopesEqual(state.scope, scope) ? state.selection : null;
}

/**
 * Move the keyboard focus cursor through `ids` (the drawing's node order),
 * wrapping at both ends. `null` enters the list at its first (forward) or last
 * (backward) entry; an id no longer in the list re-enters the same way.
 *
 * Kept here, beside the selection, because the cursor and the selection are the
 * two keyboard readings of the same list and must not disagree about order.
 */
export function cycleNodeFocus(
  ids: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const currentIndex = currentId === null ? -1 : ids.indexOf(currentId);
  if (currentIndex === -1) return direction === 1 ? ids[0] : ids[ids.length - 1];
  const nextIndex = (currentIndex + direction + ids.length) % ids.length;
  return ids[nextIndex];
}
