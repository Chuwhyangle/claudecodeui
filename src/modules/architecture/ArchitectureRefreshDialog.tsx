/**
 * The confirmation dialog for the architecture tab's manual re-analysis.
 *
 * Used by `ArchitecturePanel.tsx` only. It is a real modal dialog (`role="dialog"`
 * + `aria-modal`): Tab is trapped and wraps at both ends, Escape closes it without
 * cancelling the job, and focus returns to the control that opened it.
 *
 * ESCAPE IS LOAD-BEARING HERE. The chat page owns a document-level Escape that
 * aborts the running turn; this dialog installs its keydown listener in the
 * CAPTURE phase and stops the event, so Escape can only close the dialog. The
 * criterion asserts that `chat.abort` is never sent while it is open.
 *
 * The three phases are presentational: the panel computes them from the job's
 * status and owns the start request, so the dialog itself never talks to the
 * network.
 */
import {
  type RefObject,
  useEffect,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';

import { formatRefreshElapsed } from '@/modules/architecture/useArchitectureRefresh';

/** What the dialog is showing: the confirmation, a live run, or a failed run. */
export type ArchitectureRefreshDialogPhase = 'confirm' | 'running' | 'failed';

/** What the focus trap treats as reachable inside the dialog, in DOM order. */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

type ArchitectureRefreshDialogProps = {
  /** Whether the dialog is on screen. The panel owns it. */
  readonly open: boolean;
  /** Which face to draw. */
  readonly phase: ArchitectureRefreshDialogPhase;
  /** Live elapsed milliseconds of the running job (ticked by the hook). */
  readonly elapsedMs: number;
  /** The failure reason (`phase: 'failed'`), or a transport error from the start POST. */
  readonly error: string | null;
  /** Closes without starting anything (confirm) or without cancelling (running). */
  readonly onClose: () => void;
  /**
   * Starts the analysis (confirm) or retries a failed one. Never called with the
   * button disabled while a run is in flight.
   */
  readonly onStart: () => void;
  /** The control that opened the dialog; focus returns here on close. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * The architecture tab's refresh confirmation / running / failure dialog.
 *
 * Consumers: `ArchitecturePanel.tsx` and `tests/architectureRefreshDialog.test.tsx`.
 */
export function ArchitectureRefreshDialog({
  open,
  phase,
  elapsedMs,
  error,
  onClose,
  onStart,
  returnFocusRef,
}: ArchitectureRefreshDialogProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The listener is installed once per opening; the latest callbacks are read
  // through refs so a parent re-render does not re-focus the dialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTarget = returnFocusRef?.current ?? previouslyFocused;
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Capture phase + stopPropagation: the chat page's document-level abort
        // must not also fire.
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
        first?.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last?.focus();
      } else if (active === null || !panel.contains(active)) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      returnTarget?.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  const running = phase === 'running';

  return (
    <div data-architecture-refresh-dialog-root="true" className="absolute inset-0 z-50">
      <div
        data-architecture-refresh-dialog-backdrop="true"
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
        className="absolute inset-0 bg-black/30"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('architecture.refresh.title', { defaultValue: 'Refresh the project analysis?' })}
        tabIndex={-1}
        data-architecture-refresh-dialog="true"
        data-architecture-refresh-phase={phase}
        className="absolute left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 shadow-xl outline-none"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {phase === 'failed'
            ? t('architecture.refresh.failedTitle', { defaultValue: 'The analysis could not be refreshed' })
            : t('architecture.refresh.title', { defaultValue: 'Refresh the project analysis?' })}
        </h2>

        {phase === 'confirm' && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t('architecture.refresh.description', {
              defaultValue:
                'ArchGuard will re-analyse the whole project. This can take several minutes, '
                + 'and other tabs or sessions will see it running. The current analysis stays '
                + 'in place until the new one succeeds.',
            })}
          </p>
        )}

        {running && (
          <p
            data-architecture-refresh-elapsed="true"
            className="mt-2 text-xs tabular-nums text-muted-foreground"
          >
            {t('architecture.refresh.running', { defaultValue: 'Refreshing analysis…' })}
            {' '}
            {t('architecture.refresh.elapsed', { defaultValue: '{{elapsed}} elapsed', elapsed: formatRefreshElapsed(elapsedMs) })}
          </p>
        )}

        {phase === 'failed' && (
          <p
            data-architecture-refresh-error="true"
            role="alert"
            className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive"
          >
            {error ?? t('architecture.refresh.failedUnknown', { defaultValue: 'The analysis failed.' })}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-architecture-refresh-cancel="true"
            onClick={() => onCloseRef.current()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {running
              ? t('architecture.refresh.close', { defaultValue: 'Close' })
              : t('architecture.refresh.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            data-architecture-refresh-confirm="true"
            disabled={running}
            onClick={onStart}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running
              ? t('architecture.refresh.runningShort', { defaultValue: 'Refreshing…' })
              : phase === 'failed'
                ? t('architecture.refresh.retry', { defaultValue: 'Retry' })
                : t('architecture.refresh.confirm', { defaultValue: 'Refresh' })}
          </button>
        </div>
      </div>
    </div>
  );
}
