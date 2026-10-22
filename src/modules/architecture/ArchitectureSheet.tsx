import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

import { TOUCH_CONTROL_GAP_PX, TOUCH_TARGET_STYLE } from '@/modules/architecture/hooks/useTouchLayout';

/** How far the sheet must be dragged down before releasing it closes it. */
const DRAG_CLOSE_THRESHOLD_PX = 48;

/** What the focus trap treats as reachable inside the dialog, in DOM order. */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

type ArchitectureSheetProps = {
  /** Whether the sheet is on screen. The panel owns the state. */
  readonly open: boolean;
  /** The dialog's accessible name, also drawn in its header. */
  readonly title: string;
  /** The close control's accessible name. */
  readonly closeLabel: string;
  /** The drag handle's accessible name. */
  readonly handleLabel: string;
  /** Closes the sheet. Called by Escape, the backdrop, the close button and a completed drag. */
  readonly onClose: () => void;
  /**
   * The control that opened the sheet. Focus returns here when the dialog
   * closes, which is the standard modal-dialog contract.
   */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
};

/**
 * The phone architecture bottom sheet. Used by `ArchitecturePanel` only.
 *
 * On a coarse pointer the panel's whole chrome is one header row (the view
 * switch and `Adjust`); everything else lives in this sheet, which slides up
 * from the bottom of the tab and covers at most 45% of the viewport height so
 * the drawing stays visible while a knob is moved.
 *
 * It is a real modal dialog rather than a popover: `role="dialog"` +
 * `aria-modal`, a Tab trap that wraps at both ends, Escape and the backdrop
 * close it, and focus returns to the trigger on close. The drag handle closes
 * it too when the reader pulls it down past {@link DRAG_CLOSE_THRESHOLD_PX}.
 */
export function ArchitectureSheet({
  open,
  title,
  closeLabel,
  handleLabel,
  onClose,
  returnFocusRef,
  children,
}: ArchitectureSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The listener effect is installed once per opening; keeping the latest
  // callback in a ref stops a parent re-render from re-running it (and thus
  // re-focusing the panel on every keystroke inside the form).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // A drag in progress: which pointer, and where it started. `offset` is the
  // live translation, so the sheet follows the finger.
  const dragRef = useRef<{ pointerId: number; startY: number; lastY: number } | null>(null);
  // The live downward translation while the reader drags the handle. It is
  // state (not a ref) because the panel's transform must follow the finger.
  const [dragOffset, setDragOffset] = useState(0);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Capture the trigger now: the cleanup must restore focus to the element
    // that opened THIS dialog, not to whatever the ref happens to hold later.
    const returnTarget = returnFocusRef?.current ?? previouslyFocused;
    // Focus the dialog itself, not its first control: a screen reader then
    // announces the dialog name before the form, and the first Tab lands on
    // the close button.
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // The sheet owns Escape while it is open. Stopping propagation keeps
        // the chat page's document-level abort from also firing.
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (active === null || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to the trigger (or whatever was focused before the sheet
      // mounted) when the dialog leaves the screen.
      returnTarget?.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const distance = Math.max(0, drag.lastY - drag.startY);
    setDragOffset(0);
    if (distance >= DRAG_CLOSE_THRESHOLD_PX) onCloseRef.current();
  };

  return (
    <div data-architecture-sheet-root="true" className="absolute inset-0 z-40">
      <div
        data-architecture-sheet-backdrop="true"
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
        className="absolute inset-0 bg-black/30"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-architecture-sheet="true"
        // The 45vh ceiling is the contract that keeps the drawing's lower
        // 55% visible while a knob is moved. Inline so the reading does not
        // depend on a stylesheet (and a test can read the number).
        style={{
          maxHeight: '45vh',
          transform: dragOffset === 0 ? undefined : `translateY(${dragOffset}px)`,
          transition: dragOffset === 0 ? 'transform 150ms ease' : undefined,
        }}
        className="absolute bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-xl border-t border-border bg-popover shadow-xl outline-none"
      >
        <div className="flex shrink-0 items-center gap-2 px-2 pt-1" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <button
            type="button"
            aria-label={handleLabel}
            data-architecture-sheet-drag-handle="true"
            style={{ ...TOUCH_TARGET_STYLE, touchAction: 'none' }}
            className="flex flex-1 cursor-grab items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            onPointerDown={(event) => {
              dragRef.current = {
                pointerId: event.pointerId,
                startY: event.clientY,
                lastY: event.clientY,
              };
              // Keep receiving moves after the finger leaves the handle. The
              // guard keeps a jsdom / partial-pointer implementation from
              // throwing; the drag itself still works without capture.
              try {
                event.currentTarget.setPointerCapture?.(event.pointerId);
              } catch {
                // No pointer capture: a short drag inside the handle still works.
              }
              setDragOffset(0);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (drag === null || drag.pointerId !== event.pointerId) return;
              drag.lastY = event.clientY;
              setDragOffset(Math.max(0, event.clientY - drag.startY));
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span aria-hidden="true" className="h-1 w-10 rounded-full bg-muted-foreground/40" />
          </button>
          <span className="text-sm font-semibold text-foreground" data-architecture-sheet-title="true">
            {title}
          </span>
          <button
            type="button"
            aria-label={closeLabel}
            data-architecture-sheet-close="true"
            onClick={() => onCloseRef.current()}
            style={TOUCH_TARGET_STYLE}
            className="rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            ×
          </button>
        </div>
        <div
          data-architecture-sheet-body="true"
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2"
          style={{ display: 'flex', flexDirection: 'column', gap: TOUCH_CONTROL_GAP_PX }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
