import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * The element the overlay is drawn on. The same node is handed to the
 * Fullscreen API when the platform supports it, so the overlay and the native
 * fullscreen session describe the same rectangle.
 */
type ArchitectureFullscreenOptions = {
  readonly overlayRef: RefObject<HTMLElement | null>;
  /**
   * Whether entering also asks the browser for real fullscreen. The panel sets
   * this for fine pointers (desktop); a coarse pointer keeps the page-internal
   * overlay only, which is the whole mechanism iOS Safari offers.
   */
  readonly allowNativeFullscreen: boolean;
};

export type ArchitectureFullscreenState = {
  /** Whether the page-internal overlay is covering the viewport. */
  readonly active: boolean;
  readonly enter: () => void;
  readonly exit: () => void;
  readonly toggle: () => void;
};

/**
 * The architecture tab's page-internal fullscreen overlay.
 *
 * Used by `ArchitecturePanel` only. It owns four things the panel should not
 * have to keep straight:
 *
 *  - the overlay flag;
 *  - the OPTIONAL native Fullscreen API call (desktop). A browser without
 *    `requestFullscreen`, or one that rejects the request (iOS Safari), is not
 *    an error: the overlay alone is the fallback the task specifies;
 *  - keeping the overlay in step with `fullscreenchange`, so leaving fullscreen
 *    through the browser's own affordance closes the overlay too;
 *  - `inert` on the rest of the app shell while the overlay is open, so focus
 *    (Tab, a screen reader's cursor) cannot leave the overlay for the covered
 *    sidebar or header.
 *
 * Escape is claimed at the WINDOW's capture phase while the overlay is open.
 * The chat page listens for Escape on `document`'s capture phase to abort a
 * running turn; a handler at the overlay's own root would run far too late. The
 * window listener exits the overlay, calls `stopPropagation` and thereby keeps
 * the key away from both the chat page and any other document listener.
 */
export function useArchitectureFullscreen({
  overlayRef,
  allowNativeFullscreen,
}: ArchitectureFullscreenOptions): ArchitectureFullscreenState {
  // Whether the overlay is covering the viewport. Mirrored in a ref because the
  // native `fullscreenchange` listener runs outside React's render cycle.
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  // Whether THIS hook asked for native fullscreen and it actually started. A
  // `fullscreenchange` with no element is only an external exit when this is
  // true; without it, a browser that never entered fullscreen (the iOS
  // fallback) would look like an immediate external exit.
  const nativeActiveRef = useRef(false);

  const enter = useCallback((): void => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    if (!allowNativeFullscreen) return;
    const element = overlayRef.current;
    if (element === null) return;
    const request = element.requestFullscreen;
    if (typeof request !== 'function') return;
    try {
      const started: unknown = request.call(element);
      // The promise form rejects when the browser declines (no user gesture,
      // permissions policy, an embedded frame). The overlay is already on
      // screen, so the only correct handling is to ignore the refusal.
      if (started !== null && typeof started === 'object' && 'then' in started) {
        (started as Promise<void>).then(
          () => {
            nativeActiveRef.current = true;
          },
          () => {
            nativeActiveRef.current = false;
          },
        );
      } else {
        nativeActiveRef.current = true;
      }
    } catch {
      // A synchronous throw (older engines) is the same fallback: overlay only.
      nativeActiveRef.current = false;
    }
  }, [allowNativeFullscreen, overlayRef]);

  const exit = useCallback((): void => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    if (!nativeActiveRef.current) return;
    nativeActiveRef.current = false;
    if (typeof document.exitFullscreen === 'function' && document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => {
        // The browser owns the session by now; a refused exit changes nothing
        // the overlay renders.
      });
    }
  }, []);

  const toggle = useCallback((): void => {
    if (activeRef.current) exit();
    else enter();
  }, [enter, exit]);

  // The browser's own affordance (Esc handled natively, the window chrome's
  // exit) changes `fullscreenElement` without asking this component. Follow it,
  // so the overlay can never outlive the native session it entered with.
  useEffect(() => {
    const onChange = (): void => {
      if (document.fullscreenElement !== null) return;
      if (!nativeActiveRef.current) return;
      nativeActiveRef.current = false;
      if (!activeRef.current) return;
      activeRef.current = false;
      setActive(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Escape exits the overlay before any document listener sees it. Capture on
  // `window` is what outranks the chat page's `document` capture handler.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      exit();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [active, exit]);

  // The covered shell is inert, not merely painted over: Tab and assistive
  // technology must not reach the sidebar or the header behind the overlay.
  // Every sibling on the path from the overlay up to `[data-app-shell]` is
  // marked, which leaves the overlay itself (an ancestor-path member, never a
  // sibling) fully interactive.
  useEffect(() => {
    if (!active) return;
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const boundary = overlay.closest('[data-app-shell]');
    const inerted: HTMLElement[] = [];
    let node: Element | null = overlay;
    while (node !== null && node.parentElement !== null) {
      const parent: Element = node.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) continue;
        if (!(sibling instanceof HTMLElement)) continue;
        // An element the app already marked inert stays that way on exit.
        if (sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        inerted.push(sibling);
      }
      node = parent;
      if (boundary !== null && node === boundary) break;
      if (node === document.body) break;
    }
    return () => {
      for (const element of inerted) element.removeAttribute('inert');
    };
  }, [active, overlayRef]);

  // Unmounting (leaving the Architecture tab, switching views) must not leave
  // the browser in fullscreen.
  useEffect(() => () => {
    if (!nativeActiveRef.current) return;
    nativeActiveRef.current = false;
    if (typeof document.exitFullscreen === 'function' && document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);

  return { active, enter, exit, toggle };
}
