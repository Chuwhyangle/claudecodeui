import { useSyncExternalStore } from 'react';

/**
 * The app's single reading of "is this tab in the background?".
 *
 * A hidden tab keeps every timer and every poller alive unless the code that owns
 * them asks, so each hidden-aware hook should branch on this one reading rather
 * than attach its own `visibilitychange` listener. The plain functions are for
 * module-level stores (which cannot call hooks); `usePageVisible` is the React
 * binding and re-renders exactly when the value flips.
 */

/** True while the tab is hidden; false during SSR and wherever `document` is absent. */
export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

/** Subscribes a plain callback to the browser's visibility changes; no listener during SSR. */
export function subscribeToPageVisibility(onChange: () => void): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/**
 * React binding for the same reading. `true` is the server/pre-hydration answer:
 * a page that has not reported itself hidden is treated as visible.
 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeToPageVisibility,
    () => !isPageHidden(),
    () => true,
  );
}
