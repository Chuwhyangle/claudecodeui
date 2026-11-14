import {
  ARCHITECTURE_DETAIL_TIERS,
  clampArchitectureScope,
  DEFAULT_ARCHITECTURE_SCOPE,
  type ArchitectureDetailTier,
} from '@/modules/architecture/dom/readout/detailRanking';
import type { CurationStorageLike } from '@/modules/architecture/dom/interaction/curationStore';

// The panel's localStorage seam: every remembered knob (scope, detail tier,
// the one-off touch hint, the curation store's backing store) lives here, so
// the panel component itself never touches `window.localStorage`.

/**
 * The server-side BFS depth the panel asks for on its first activation when the
 * project has no remembered scope. Two hops is the server's loose default
 * (`DEFAULT_HOPS` in `architecture/service.ts`); the scope stepper below is a
 * REQUEST parameter, so unlike the granularity toggle it re-enters the fetch.
 */
const DEFAULT_SCOPE = DEFAULT_ARCHITECTURE_SCOPE;

/**
 * Where one project's two display knobs are remembered. They are deliberately
 * separate keys: the sibling element/relation-filter task reuses this storage,
 * and a reader changing only the scope must not rewrite the detail choice.
 */
const SCOPE_STORAGE_PREFIX = 'architecture.scope.';
const DETAIL_STORAGE_PREFIX = 'architecture.detail.';

/**
 * The narrow storage seam every remembered knob reads and writes through.
 *
 * It is deliberately the same two-method shape as the curation store's seam, so
 * the controllers that own these knobs can be exercised with a plain object in
 * a test — no `window`, no jsdom. `BROWSER_PANEL_STORAGE` is the production
 * implementation.
 */
export type PanelStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * The browser storage the panel's remembered knobs persist through.
 *
 * Every failure (private mode, storage quota, no `window`) degrades to "this
 * visit only" instead of throwing into the render path.
 */
export const BROWSER_PANEL_STORAGE: PanelStorageLike = {
  getItem: (key) => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    } catch {
      // Best-effort: the knob keeps working for this visit.
    }
  },
};

/** The storage key one project's scope choice lives under. */
export function scopeStorageKey(projectId: string | null): string {
  return `${SCOPE_STORAGE_PREFIX}${projectId ?? ''}`;
}

/** The storage key one project's detail-tier choice lives under. */
export function detailStorageKey(projectId: string | null): string {
  return `${DETAIL_STORAGE_PREFIX}${projectId ?? ''}`;
}

/** Whether the one-off touch instruction has been dismissed in this browser. */
const TOUCH_HINT_STORAGE_KEY = 'architecture.touchHint.dismissed';


/** The touch instruction is a one-off: a remembered dismissal keeps it off screen. */
export function readStoredTouchHintDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TOUCH_HINT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the dismissal; storage being unavailable must not resurrect the bubble. */
export function writeStoredTouchHintDismissed(): void {
  try {
    window.localStorage.setItem(TOUCH_HINT_STORAGE_KEY, 'true');
  } catch {
    // Private mode: the dismissal still holds for this session.
  }
}

/** Read one project's remembered scope, clamped into the stepper's range. */
export function readStoredScope(storage: PanelStorageLike, projectId: string | null): number {
  if (projectId === null) return DEFAULT_SCOPE;
  const stored = storage.getItem(scopeStorageKey(projectId));
  if (stored === null) return DEFAULT_SCOPE;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clampArchitectureScope(parsed) : DEFAULT_SCOPE;
}

/** Read one project's remembered detail tier, falling back to the identity tier. */
export function readStoredDetail(storage: PanelStorageLike, projectId: string | null): ArchitectureDetailTier {
  if (projectId === null) return 'all';
  const stored = storage.getItem(detailStorageKey(projectId));
  return stored !== null && (ARCHITECTURE_DETAIL_TIERS as readonly string[]).includes(stored)
    ? (stored as ArchitectureDetailTier)
    : 'all';
}

/** Remember one project's scope choice; a failed write must not break the knob. */
export function writeStoredScope(storage: PanelStorageLike, projectId: string | null, scope: number): void {
  if (projectId === null) return;
  storage.setItem(scopeStorageKey(projectId), String(scope));
}

/** Remember one project's detail choice; a failed write must not break the knob. */
export function writeStoredDetail(
  storage: PanelStorageLike,
  projectId: string | null,
  detail: ArchitectureDetailTier,
): void {
  if (projectId === null) return;
  storage.setItem(detailStorageKey(projectId), detail);
}

/**
 * The browser storage the curation store persists through.
 *
 * The store's own seam is the two methods it needs, so a blocked/unavailable
 * `localStorage` (private mode, storage quota) degrades to "this page's state
 * only" instead of throwing during render.
 */
export const BROWSER_CURATION_STORAGE: CurationStorageLike = {
  getItem: (key) => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    } catch {
      // Best-effort: the in-memory store keeps working for this page.
    }
  },
};
