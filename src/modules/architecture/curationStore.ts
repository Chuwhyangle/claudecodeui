import type { ArchitectureEntityKind } from '@/modules/architecture/rendererContract';

/**
 * The architecture tab's manual-curation model: pins, removals and hidden
 * relations, persisted per `(project, session)` in `localStorage`.
 *
 * The store is the pure core of "能加就要能删": every adjustment is one of
 * three list operations, every operation is undoable, and the whole thing is
 * scoped to ONE session because the graph itself is (its seeds are the
 * session's transcript). A project has no curation of its own — the key is
 * `architecture.curation.v1:<projectId>:<sessionId>`.
 *
 * Items carry `(file, name)` beside the id on purpose: a re-analysis can change
 * every entity id, while the file/name pair stays stable. {@link reconcile}
 * re-anchors saved items onto the CURRENT ids and marks what it could not find
 * as `stale` — never silently dropping the reader's choice.
 */

/** The `localStorage` key prefix; the full key adds `:<projectId>:<sessionId>`. */
export const CURATION_STORAGE_PREFIX = 'architecture.curation.v1';

/** The three hard caps the task states, one per list. */
export const CURATION_LIMITS = {
  pins: 200,
  excluded: 500,
  hiddenEdges: 500,
} as const;

/** How many adjustments can be undone (`Ctrl/Cmd+Z`). */
export const CURATION_UNDO_DEPTH = 20;

/** One pinned or removed entity, saved with the identity that survives re-analysis. */
export type ArchitectureCurationItem = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly kind?: ArchitectureEntityKind;
  /** Set by {@link reconcile} when `(file, name)` no longer resolves. */
  readonly stale?: boolean;
};

/** One hidden relation — display only; the code is untouched. */
export type ArchitectureCurationHiddenEdge = {
  readonly from: string;
  readonly to: string;
  readonly type: string;
};

/** The persisted value shape. */
export type ArchitectureCurationState = {
  readonly pins: readonly ArchitectureCurationItem[];
  readonly excluded: readonly ArchitectureCurationItem[];
  readonly hiddenEdges: readonly ArchitectureCurationHiddenEdge[];
};

/** Why an adjustment was refused. */
export type CurationFailureCode =
  /** No session: the storage key is session-scoped, so curation cannot exist. */
  | 'NO_SESSION'
  /** The list already holds its cap of items. */
  | 'LIMIT_REACHED';

export type CurationActionResult =
  | { readonly ok: true; readonly state: ArchitectureCurationState }
  | { readonly ok: false; readonly code: CurationFailureCode; readonly limit?: number };

/** The `(file, name)` pair a reconcile answers for, with its current id or null. */
export type ArchitectureCurationResolveEntry = {
  readonly name: string;
  readonly file: string;
  readonly id: string | null;
};

/** The narrow storage seam (real `localStorage`, or a test double). */
export type CurationStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type CurationStore = {
  /** True when a session exists; false disables the whole feature. */
  readonly canEdit: boolean;
  getState(): ArchitectureCurationState;
  /** Adds/updates a pin; a previous removal of the same id is undone by it. */
  pin(item: ArchitectureCurationItem): CurationActionResult;
  /** Removes a pin (the entity may still be connected, which the UI explains). */
  unpin(id: string): CurationActionResult;
  /** Removes an entity from the graph; a previous pin of the same id is undone. */
  exclude(item: ArchitectureCurationItem): CurationActionResult;
  /** Brings a removed entity back. */
  restore(id: string): CurationActionResult;
  hideEdge(edge: ArchitectureCurationHiddenEdge): CurationActionResult;
  showEdge(edge: ArchitectureCurationHiddenEdge): CurationActionResult;
  /** Restores one whole page (`pins`/`excluded`/`hiddenEdges`). */
  restoreGroup(group: keyof ArchitectureCurationState): CurationActionResult;
  /** Restores every page at once (the manager's "全部还原"). */
  restoreAll(): CurationActionResult;
  /** Drops one stale item the reader chose to forget. */
  clearItem(group: 'pins' | 'excluded', id: string): CurationActionResult;
  /** Re-anchors saved items onto current ids; unresolved items become stale. */
  reconcile(entries: readonly ArchitectureCurationResolveEntry[]): void;
  /** Undoes the most recent adjustment. */
  undo(): CurationActionResult;
  canUndo(): boolean;
  /** Notifies on every state change (including reconcile). */
  subscribe(listener: () => void): () => void;
};

/** The empty value every corrupt/absent key falls back to. */
export function emptyCurationState(): ArchitectureCurationState {
  return { pins: [], excluded: [], hiddenEdges: [] };
}

/**
 * The storage key for one `(project, session)` pair, or `null` when either half
 * is missing. A missing session is the documented "feature disabled" state.
 */
export function curationStorageKey(
  projectId: string | null,
  sessionId: string | null,
): string | null {
  if (projectId === null || projectId.length === 0) return null;
  if (sessionId === null || sessionId.length === 0) return null;
  return `${CURATION_STORAGE_PREFIX}:${projectId}:${sessionId}`;
}

const KNOWN_KINDS: readonly ArchitectureEntityKind[] = [
  'class',
  'interface',
  'enum',
  'abstract',
  'function',
  'other',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseItem(value: unknown): ArchitectureCurationItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.name !== 'string' || value.name.length === 0) return null;
  if (typeof value.file !== 'string' || value.file.length === 0) return null;
  const kind = typeof value.kind === 'string' && (KNOWN_KINDS as readonly string[]).includes(value.kind)
    ? (value.kind as ArchitectureEntityKind)
    : undefined;
  return {
    id: value.id,
    name: value.name,
    file: value.file,
    ...(kind === undefined ? {} : { kind }),
    ...(value.stale === true ? { stale: true } : {}),
  };
}

function parseEdge(value: unknown): ArchitectureCurationHiddenEdge | null {
  if (!isRecord(value)) return null;
  if (typeof value.from !== 'string' || value.from.length === 0) return null;
  if (typeof value.to !== 'string' || value.to.length === 0) return null;
  if (typeof value.type !== 'string') return null;
  return { from: value.from, to: value.to, type: value.type };
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | null, cap: number): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((entry): entry is T => entry !== null).slice(0, cap);
}

/**
 * Parse one stored value. A corrupt document is an EMPTY state, not an error:
 * a broken write must not take the architecture tab down with it.
 */
export function parseCurationState(raw: string | null): ArchitectureCurationState {
  if (raw === null) return emptyCurationState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyCurationState();
  }
  if (!isRecord(parsed)) return emptyCurationState();
  return {
    pins: parseList(parsed.pins, parseItem, CURATION_LIMITS.pins),
    excluded: parseList(parsed.excluded, parseItem, CURATION_LIMITS.excluded),
    hiddenEdges: parseList(parsed.hiddenEdges, parseEdge, CURATION_LIMITS.hiddenEdges),
  };
}

/** Read one session's curation; absent/corrupt/no-session all read empty. */
export function readCurationState(
  storage: CurationStorageLike,
  projectId: string | null,
  sessionId: string | null,
): ArchitectureCurationState {
  const key = curationStorageKey(projectId, sessionId);
  if (key === null) return emptyCurationState();
  try {
    return parseCurationState(storage.getItem(key));
  } catch {
    return emptyCurationState();
  }
}

function writeCurationState(
  storage: CurationStorageLike,
  projectId: string | null,
  sessionId: string | null,
  state: ArchitectureCurationState,
): boolean {
  const key = curationStorageKey(projectId, sessionId);
  if (key === null) return false;
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    // A full/blocked storage must not break the drawing; the in-memory state
    // still works for this page's lifetime.
    return false;
  }
}

function sameItem(left: ArchitectureCurationItem, right: ArchitectureCurationItem): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.file === right.file
    && left.kind === right.kind
    && left.stale === right.stale;
}

function sameEdge(left: ArchitectureCurationHiddenEdge, right: ArchitectureCurationHiddenEdge): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

/**
 * Create one session's curation store.
 *
 * Every mutating action follows the same three steps: check the session/cap,
 * push the previous state onto the bounded undo stack, then commit + persist.
 * The undo stack lives in memory only — a reload starts a fresh history while
 * the persisted state survives.
 */
export function createCurationStore(options: {
  readonly storage: CurationStorageLike;
  readonly projectId: string | null;
  readonly sessionId: string | null;
}): CurationStore {
  const { storage, projectId, sessionId } = options;
  const key = curationStorageKey(projectId, sessionId);
  const canEdit = key !== null;

  let state = readCurationState(storage, projectId, sessionId);
  const history: ArchitectureCurationState[] = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const commit = (next: ArchitectureCurationState, keepHistory = true): CurationActionResult => {
    if (keepHistory) {
      history.push(state);
      if (history.length > CURATION_UNDO_DEPTH) history.shift();
    }
    state = next;
    writeCurationState(storage, projectId, sessionId, state);
    notify();
    return { ok: true, state };
  };

  const refusal = (code: CurationFailureCode, limit?: number): CurationActionResult => ({
    ok: false,
    code,
    ...(limit === undefined ? {} : { limit }),
  });

  /** Removes a pin (and reports whether anything changed). */
  const withoutPin = (current: ArchitectureCurationState, id: string): ArchitectureCurationState => ({
    ...current,
    pins: current.pins.filter((item) => item.id !== id),
  });
  const withoutExcluded = (current: ArchitectureCurationState, id: string): ArchitectureCurationState => ({
    ...current,
    excluded: current.excluded.filter((item) => item.id !== id),
  });

  return {
    canEdit,
    getState: () => state,

    pin(item) {
      if (!canEdit) return refusal('NO_SESSION');
      const existing = state.pins.find((entry) => entry.id === item.id);
      if (existing !== undefined && sameItem(existing, item)) return { ok: true, state };
      if (existing === undefined && state.pins.length >= CURATION_LIMITS.pins) {
        return refusal('LIMIT_REACHED', CURATION_LIMITS.pins);
      }
      const base = withoutExcluded(state, item.id);
      const pins = existing === undefined
        ? [...base.pins, item]
        : base.pins.map((entry) => (entry.id === item.id ? item : entry));
      return commit({ ...base, pins });
    },

    unpin(id) {
      if (!canEdit) return refusal('NO_SESSION');
      if (!state.pins.some((entry) => entry.id === id)) return { ok: true, state };
      return commit(withoutPin(state, id));
    },

    exclude(item) {
      if (!canEdit) return refusal('NO_SESSION');
      const existing = state.excluded.find((entry) => entry.id === item.id);
      if (existing !== undefined && sameItem(existing, item)) return { ok: true, state };
      if (existing === undefined && state.excluded.length >= CURATION_LIMITS.excluded) {
        return refusal('LIMIT_REACHED', CURATION_LIMITS.excluded);
      }
      // "后做的覆盖先做的": a removal supersedes a pin of the same entity.
      const base = withoutPin(state, item.id);
      const excluded = existing === undefined
        ? [...base.excluded, item]
        : base.excluded.map((entry) => (entry.id === item.id ? item : entry));
      return commit({ ...base, excluded });
    },

    restore(id) {
      if (!canEdit) return refusal('NO_SESSION');
      if (!state.excluded.some((entry) => entry.id === id)) return { ok: true, state };
      return commit(withoutExcluded(state, id));
    },

    hideEdge(edge) {
      if (!canEdit) return refusal('NO_SESSION');
      if (state.hiddenEdges.some((entry) => sameEdge(entry, edge))) return { ok: true, state };
      if (state.hiddenEdges.length >= CURATION_LIMITS.hiddenEdges) {
        return refusal('LIMIT_REACHED', CURATION_LIMITS.hiddenEdges);
      }
      return commit({ ...state, hiddenEdges: [...state.hiddenEdges, edge] });
    },

    showEdge(edge) {
      if (!canEdit) return refusal('NO_SESSION');
      if (!state.hiddenEdges.some((entry) => sameEdge(entry, edge))) return { ok: true, state };
      return commit({
        ...state,
        hiddenEdges: state.hiddenEdges.filter((entry) => !sameEdge(entry, edge)),
      });
    },

    restoreGroup(group) {
      if (!canEdit) return refusal('NO_SESSION');
      if (state[group].length === 0) return { ok: true, state };
      return commit({ ...state, [group]: [] });
    },

    restoreAll() {
      if (!canEdit) return refusal('NO_SESSION');
      const total = state.pins.length + state.excluded.length + state.hiddenEdges.length;
      if (total === 0) return { ok: true, state };
      return commit(emptyCurationState());
    },

    clearItem(group, id) {
      if (!canEdit) return refusal('NO_SESSION');
      const list = group === 'pins' ? state.pins : state.excluded;
      if (!list.some((entry) => entry.id === id)) return { ok: true, state };
      return commit(group === 'pins' ? withoutPin(state, id) : withoutExcluded(state, id));
    },

    reconcile(entries) {
      const byIdentity = new Map<string, string | null>();
      for (const entry of entries) byIdentity.set(`${entry.file}\u0000${entry.name}`, entry.id);
      const reanchor = (item: ArchitectureCurationItem): ArchitectureCurationItem => {
        const identity = `${item.file}\u0000${item.name}`;
        if (!byIdentity.has(identity)) {
          return item.stale === true ? item : { ...item, stale: true };
        }
        const id = byIdentity.get(identity) ?? null;
        if (id === null) {
          return item.stale === true ? item : { ...item, stale: true };
        }
        const { stale: _stale, ...rest } = item;
        const next = { ...rest, id };
        if (item.stale !== true && item.id === id) return item;
        return next;
      };
      const pins = state.pins.map(reanchor);
      const excluded = state.excluded.map(reanchor);
      const changed = pins.some((entry, index) => entry !== state.pins[index])
        || excluded.some((entry, index) => entry !== state.excluded[index]);
      if (!changed) return;
      // Re-anchoring is a system correction, not a reader gesture: it does not
      // push an undo entry (undoing it would merely restore an id that no
      // longer exists).
      state = { ...state, pins, excluded };
      writeCurationState(storage, projectId, sessionId, state);
      notify();
    },

    undo() {
      if (!canEdit) return refusal('NO_SESSION');
      const previous = history.pop();
      if (previous === undefined) return { ok: true, state };
      state = previous;
      writeCurationState(storage, projectId, sessionId, state);
      notify();
      return { ok: true, state };
    },

    canUndo: () => history.length > 0,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
