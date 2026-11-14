/**
 * The architecture canvas's selection model.
 *
 * A SET of selected things — entities and relations — plus the scope it belongs
 * to. The scope is part of the state, not an afterthought: switching the view
 * (file/class) or the session must discard a selection that named something the
 * new graph does not draw, and keeping the scope in the state is what makes that
 * a pure reading instead of an effect that races a render.
 *
 * `selection` (the primary one, i.e. the most recently added member) is kept
 * beside the ordered set because the inspector and the renderer's pinned
 * highlight predate multi-select and read a single thing. Every transition
 * derives it from `selections`, so the two can never disagree.
 *
 * The module is deliberately stateless. Every function takes the state it
 * reads and returns a new one, so two mounted panels (or a panel and a test)
 * can never observe each other's selection. The panel holds the one state
 * instance in React; the renderer reads it through props.
 *
 * Consumers: `ArchitecturePanel.tsx` (the owner of the state),
 * `ArchitectureInspector.tsx` (renders the selected entity/relation),
 * `ArchitectureSelectionTray.tsx` (labels the set and writes the chat text),
 * `PlantUmlGraph.tsx` (keyboard cycling and the marquee hit test), and
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
 * How a click joins the selection: `additive` is Shift/Ctrl/Cmd, or any tap
 * while the touch multi-select mode is on. A plain click replaces the set.
 */
export type ArchitectureSelectionModifiers = {
  readonly additive: boolean;
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

/** The selection set plus the scope it was made in. */
export type ArchitectureSelectionState = {
  readonly scope: ArchitectureSelectionScope;
  /** The ordered set; the last entry is the primary selection. */
  readonly selections: readonly ArchitectureSelection[];
  /** The primary (most recently added) selection, for single-selection readers. */
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
  | { readonly type: 'toggle-entity'; readonly nodeId: string }
  | {
    readonly type: 'toggle-relation';
    readonly from: string;
    readonly to: string;
    readonly relationType: string;
  }
  /** Adds every member of a marquee selection that is not already selected. */
  | { readonly type: 'add-selections'; readonly selections: readonly ArchitectureSelection[] }
  | { readonly type: 'remove-selection'; readonly key: string }
  | { readonly type: 'clear' }
  | { readonly type: 'sync-scope'; readonly scope: ArchitectureSelectionScope };

/** A stable identity for one selection, used for membership tests and keys. */
export function selectionKey(selection: ArchitectureSelection): string {
  return selection.kind === 'entity'
    ? `entity:${selection.nodeId}`
    : `relation:${selection.from}\u0000${selection.to}\u0000${selection.relationType}`;
}

/** True when two selections name the same entity/relation. */
export function selectionsEqual(left: ArchitectureSelection, right: ArchitectureSelection): boolean {
  return selectionKey(left) === selectionKey(right);
}

/** The single selected thing a menu/inspector action refers to, or null. */
export function entitySelectionOf(nodeId: string): ArchitectureSelection {
  return { kind: 'entity', nodeId };
}

/** The single selected relation. */
export function relationSelectionOf(
  from: string,
  to: string,
  relationType: string,
): ArchitectureSelection {
  return { kind: 'relation', from, to, relationType };
}

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
  return { scope, selections: [], selection: null };
}

/** Build a state whose primary selection is the last member of `selections`. */
function withSelections(
  scope: ArchitectureSelectionScope,
  selections: readonly ArchitectureSelection[],
): ArchitectureSelectionState {
  return {
    scope,
    selections,
    selection: selections.length === 0 ? null : selections[selections.length - 1],
  };
}

/** Append `next` unless its identity is already in `current`. */
function appended(
  current: readonly ArchitectureSelection[],
  next: ArchitectureSelection,
): readonly ArchitectureSelection[] {
  const key = selectionKey(next);
  return current.some((entry) => selectionKey(entry) === key) ? current : [...current, next];
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
      : createSelectionState(action.scope);
  }
  if (action.type === 'clear') {
    return state.selections.length === 0 ? state : withSelections(state.scope, []);
  }
  if (action.type === 'select-entity') {
    return withSelections(state.scope, [entitySelectionOf(action.nodeId)]);
  }
  if (action.type === 'select-relation') {
    return withSelections(state.scope, [
      relationSelectionOf(action.from, action.to, action.relationType),
    ]);
  }
  if (action.type === 'add-selections') {
    let selections = state.selections;
    for (const entry of action.selections) selections = appended(selections, entry);
    return selections === state.selections ? state : withSelections(state.scope, selections);
  }
  if (action.type === 'remove-selection') {
    const selections = state.selections.filter((entry) => selectionKey(entry) !== action.key);
    return selections.length === state.selections.length
      ? state
      : withSelections(state.scope, selections);
  }

  const toggled = action.type === 'toggle-entity'
    ? entitySelectionOf(action.nodeId)
    : relationSelectionOf(action.from, action.to, action.relationType);
  const key = selectionKey(toggled);
  const exists = state.selections.some((entry) => selectionKey(entry) === key);
  return withSelections(
    state.scope,
    exists
      ? state.selections.filter((entry) => selectionKey(entry) !== key)
      : [...state.selections, toggled],
  );
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

/** The whole set for `scope`; empty when the state belongs to another scope. */
export function selectionsInScope(
  state: ArchitectureSelectionState,
  scope: ArchitectureSelectionScope,
): readonly ArchitectureSelection[] {
  return selectionScopesEqual(state.scope, scope) ? state.selections : [];
}

/** A rectangle in one coordinate space (client pixels for the marquee). */
export type ArchitectureSelectionRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** One drawn thing and the rectangle it occupies. */
export type ArchitectureBoxCandidate = {
  readonly selection: ArchitectureSelection;
  readonly rect: ArchitectureSelectionRect;
};

/**
 * The candidates a marquee rectangle hits. The comparison is half-open, the
 * same rule the text page's viewport scope uses: a zero-area box (jsdom, a
 * hidden canvas) intersects nothing, so a missing measurement can never read as
 * "everything is selected". Nodes and relations are both candidates; the
 * caller decides which drawn elements supply their rectangles.
 */
export function selectionsIntersectingBox(
  candidates: readonly ArchitectureBoxCandidate[],
  box: ArchitectureSelectionRect,
): ArchitectureSelection[] {
  return candidates
    .filter(({ rect }) => (
      rect.right > box.left
      && rect.left < box.right
      && rect.bottom > box.top
      && rect.top < box.bottom
    ))
    .map(({ selection }) => selection);
}

/**
 * The chat-draft scope the architecture tray writes to. It mirrors the
 * composer's own rule exactly (`useChatComposerState.ts`): the open session,
 * or `project:<projectId>` for a chat that has not been sent yet. `null` means
 * there is nowhere to write (no session and no project), which is what disables
 * the tray's compose action.
 */
export function resolveDraftScope(
  projectId: string | null,
  sessionId: string | null,
): string | null {
  if (sessionId !== null && sessionId.length > 0) return sessionId;
  if (projectId !== null && projectId.length > 0) return `project:${projectId}`;
  return null;
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
