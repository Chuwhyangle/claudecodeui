import { useEffect, useState } from 'react';

/**
 * How long a curation Toast lives before dismissing itself.
 *
 * 12 s, not the original 6 s: the review found the window too short to read the
 * sentence, decide, and reach the button. Undo is additionally reachable from
 * the Adjusted popover's header after the Toast is gone.
 */
const CURATION_TOAST_MS = 12000;

/**
 * The curation Toast: one sentence about what just changed, plus a focusable
 * 撤销 action. It auto-dismisses after {@link CURATION_TOAST_MS}, and hovering
 * or focusing inside it pauses that timer (so a keyboard user can reach the
 * undo button without racing it).
 *
 * Used by `ArchitecturePanel` only.
 */
export function CurationToast({
  toast,
  undoLabel,
  onUndo,
  onDismiss,
}: {
  readonly toast: { readonly id: number; readonly message: string; readonly undoable: boolean };
  readonly undoLabel: string;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  // Whether the pointer/focus currently holds the Toast open; it pauses the
  // auto-dismiss so the undo action cannot disappear under the reader's hands.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, CURATION_TOAST_MS);
    return () => clearTimeout(timer);
  }, [paused, onDismiss, toast.id]);

  return (
    <div
      role="status"
      data-architecture-curation-toast="true"
      // The toast floats above the drawing, bottom-centre so it never covers
      // the toolbar or the dock.
      style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 60 }}
      className="flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-[11px] text-foreground shadow-lg"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span data-architecture-curation-toast-message="true">{toast.message}</span>
      {toast.undoable && (
        <button
          type="button"
          data-architecture-curation-undo="true"
          onClick={onUndo}
          className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {undoLabel}
        </button>
      )}
    </div>
  );
}
