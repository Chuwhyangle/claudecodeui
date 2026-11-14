/**
 * The curation Toast: one sentence about what just changed, plus a focusable
 * 撤销 action. Its lifetime is owned by `architectureCurationController` (which
 * also knows the clock a test injects); this component only reports the
 * pointer/focus that should PAUSE that timer, so a keyboard user can reach the
 * undo button without racing it.
 *
 * Used by `ArchitecturePanel` only.
 */
export function CurationToast({
  toast,
  undoLabel,
  onUndo,
  onPause,
  onResume,
}: {
  readonly toast: { readonly id: number; readonly message: string; readonly undoable: boolean };
  readonly undoLabel: string;
  readonly onUndo: () => void;
  /** The pointer/focus entered the Toast; its auto-dismiss waits. */
  readonly onPause: () => void;
  /** The pointer/focus left the Toast; the auto-dismiss resumes. */
  readonly onResume: () => void;
}) {
  return (
    <div
      role="status"
      data-architecture-curation-toast="true"
      // The toast floats above the drawing, bottom-centre so it never covers
      // the toolbar or the dock.
      style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 60 }}
      className="flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-[11px] text-foreground shadow-lg"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onResume();
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
