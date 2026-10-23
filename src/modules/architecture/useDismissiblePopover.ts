import { useEffect } from 'react';

/**
 * Dismiss a disclosure popover the way every menu in this panel must behave:
 * a press outside it closes it WITHOUT swallowing that press (the listener is
 * a plain `mousedown` observer, so the click still reaches its target), and
 * Escape closes it before the chat page's document-level Escape can abort the
 * running turn, returning focus to the disclosure that opened it.
 *
 * Used by `ArchitecturePanel` for the filter, legend and "Adjusted" popovers.
 */
export function useDismissiblePopover(
  open: boolean,
  close: () => void,
  triggerRef: { readonly current: HTMLElement | null },
  panelSelector: string,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (triggerRef.current?.contains(target) === true) return;
      if (document.querySelector(panelSelector)?.contains(target) === true) return;
      // No preventDefault: the press that closed the popover still lands.
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Capture phase: this runs before the chat page's document-level abort.
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close, triggerRef, panelSelector]);
}
