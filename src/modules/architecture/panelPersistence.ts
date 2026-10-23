import {
  ARCHITECTURE_DETAIL_TIERS,
  clampArchitectureScope,
  DEFAULT_ARCHITECTURE_SCOPE,
  type ArchitectureDetailTier,
} from '@/modules/architecture/detailRanking';
import type { CurationStorageLike } from '@/modules/architecture/curationStore';

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
export function readStoredScope(projectId: string | null): number {
  if (projectId === null || typeof window === 'undefined') return DEFAULT_SCOPE;
  try {
    const stored = window.localStorage.getItem(`${SCOPE_STORAGE_PREFIX}${projectId}`);
    if (stored === null) return DEFAULT_SCOPE;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampArchitectureScope(parsed) : DEFAULT_SCOPE;
  } catch {
    // Storage can be unavailable (private mode, embedded webview); the knob
    // still works for this visit, it just is not remembered.
    return DEFAULT_SCOPE;
  }
}

/** Read one project's remembered detail tier, falling back to the identity tier. */
export function readStoredDetail(projectId: string | null): ArchitectureDetailTier {
  if (projectId === null || typeof window === 'undefined') return 'all';
  try {
    const stored = window.localStorage.getItem(`${DETAIL_STORAGE_PREFIX}${projectId}`);
    return stored !== null && (ARCHITECTURE_DETAIL_TIERS as readonly string[]).includes(stored)
      ? (stored as ArchitectureDetailTier)
      : 'all';
  } catch {
    return 'all';
  }
}

/** Remember one project's scope choice; a failed write must not break the knob. */
export function writeStoredScope(projectId: string | null, scope: number): void {
  if (projectId === null) return;
  try {
    window.localStorage.setItem(`${SCOPE_STORAGE_PREFIX}${projectId}`, String(scope));
  } catch {
    // See readStoredScope: remembering is best-effort, the knob is not.
  }
}

/** Remember one project's detail choice; a failed write must not break the knob. */
export function writeStoredDetail(projectId: string | null, detail: ArchitectureDetailTier): void {
  if (projectId === null) return;
  try {
    window.localStorage.setItem(`${DETAIL_STORAGE_PREFIX}${projectId}`, detail);
  } catch {
    // See readStoredScope: remembering is best-effort, the knob is not.
  }
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
