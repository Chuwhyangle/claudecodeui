import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { ReplySuggestionsFailure, ReplySuggestionsFailureCategory } from '@/shared/types';

/**
 * The composer's inline failure notice and its detail popover.
 *
 * WHAT IS ALWAYS SHOWN. One status line inside the empty input box naming WHY the
 * reply chips are missing — a settings file that cannot draw, an upstream 5xx, a
 * spent call budget, the open circuit, or a network failure. It is the visible
 * half of the defect this surface was filed for: before it, "feature off",
 * "misconfigured" and "the gateway is down" all looked like "nothing happened".
 *
 * WHAT IS NOT SHOWN UNTIL ASKED. The detail popover (code, upstream status, time,
 * model, request id, consecutive failures and the retry/dismiss actions) is
 * mounted only while `open`; it never appears by itself. The trigger toggles it,
 * and Escape closes it. `open` is this component's own presentation state — no
 * business rule lives here: the episode, its count and its dismissal all come from
 * the controller through props.
 *
 * MOBILE is a bottom sheet rather than a floating popover: at ≤480px or on a
 * coarse pointer the panel is pinned to the bottom edge and its actions stack
 * vertically, so it cannot be clipped by the on-screen keyboard.
 *
 * Consumers: `ChatComposer` (the only renderer) and the failure-notice criterion.
 */

type SuggestionFailureNoticeProps = {
  /** The failed episode the controller is showing; never null when rendered. */
  failure: ReplySuggestionsFailure;
  /** How many consecutive failures this episode has counted. */
  failureCount: number;
  /** The existing draw command; the button does not define a second retry path. */
  onRetry: () => void;
  /** Hides the notice for this session (the episode stays in the controller). */
  onDismiss: () => void;
};

/** The notice copy family, chosen from the server's coarse category. */
type FailureCopyKey = 'misconfigured' | 'upstream' | 'rateLimited' | 'circuitOpen' | 'network' | 'unknown';

/** Maps one failure to the copy key that describes it. */
function copyKeyOf(category: ReplySuggestionsFailureCategory): FailureCopyKey {
  switch (category) {
    case 'misconfigured':
      return 'misconfigured';
    case 'rate-limit':
      return 'rateLimited';
    case 'circuit-open':
      return 'circuitOpen';
    case 'network':
    case 'timeout':
      return 'network';
    case 'http':
      return 'upstream';
    default:
      return 'unknown';
  }
}

/** The bottom-sheet arrangement: the same 480px / coarse-pointer boundary the chip row uses. */

export function SuggestionFailureNotice({
  failure,
  failureCount,
  onRetry,
  onDismiss,
}: SuggestionFailureNoticeProps) {
  const { t } = useTranslation('chat');
  // Whether the detail popover is mounted. Presentation state only: it starts
  // closed on every failure render, which is what keeps the popover from popping
  // up without a click.
  const [open, setOpen] = useState(false);

  const copyKey = copyKeyOf(failure.category);
  const line = t(`input.suggestions.failure.${copyKey}`, {
    defaultValue: failure.message,
    status: failure.httpStatus ?? '',
  });

  return (
    <div
      data-slot="reply-suggestions-failure-notice"
      role="status"
      aria-live="polite"
      // It shares the textarea's grid cell, like the chip strip, so the empty box
      // grows by one line instead of pushing the transcript away. The high z-index
      // keeps the popover above the transcript's own scroll/markdown layer, which
      // otherwise intercepts presses on its actions.
      className="relative z-30 w-full"
      style={{ gridArea: '1 / 1' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          // The page-level Escape is the abort key; closing the popover must not
          // reach it.
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <div className="px-4 py-2">
        <button
          type="button"
          data-slot="reply-suggestions-failure-trigger"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
          className="max-w-full truncate rounded-md border border-dashed border-destructive/60 bg-destructive/5 px-2 py-0.5 text-left text-xs leading-5 text-destructive transition-colors hover:bg-destructive/10"
        >
          {line}
        </button>

        {open && createPortal(
          <div
            data-slot="reply-suggestions-failure-popover"
            role="dialog"
            aria-label={t('input.suggestions.failure.title', {
              defaultValue: 'Reply suggestions unavailable',
            })}
            className={cn(
              // Portalled to <body> and fixed: the transcript's own scroll/markdown
              // layer paints above the composer's stacking context, so an anchored
              // panel would have its actions intercepted. Wide: a floating panel
              // above the box. Narrow or touch-only: a bottom sheet.
              'fixed bottom-24 left-4 z-[100] w-72 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg',
              'max-[480px]:inset-x-0 max-[480px]:bottom-0 max-[480px]:left-0 max-[480px]:w-full max-[480px]:rounded-b-none',
              'pointer-coarse:inset-x-0 pointer-coarse:bottom-0 pointer-coarse:left-0 pointer-coarse:w-full pointer-coarse:rounded-b-none',
            )}
          >
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
              <dt>{t('input.suggestions.failure.fieldCode', { defaultValue: 'Code' })}</dt>
              <dd data-field="code" className="truncate font-mono">{failure.code}</dd>
              <dt>{t('input.suggestions.failure.fieldStatus', { defaultValue: 'Upstream status' })}</dt>
              <dd data-field="httpStatus" className="font-mono">{failure.httpStatus ?? '—'}</dd>
              <dt>{t('input.suggestions.failure.fieldTime', { defaultValue: 'Time' })}</dt>
              <dd data-field="at" className="font-mono">{failure.at}</dd>
              <dt>{t('input.suggestions.failure.fieldModel', { defaultValue: 'Model' })}</dt>
              <dd data-field="model" className="truncate font-mono">{failure.model ?? '—'}</dd>
              <dt>{t('input.suggestions.failure.fieldRequestId', { defaultValue: 'Request ID' })}</dt>
              <dd data-field="requestId" className="truncate font-mono">{failure.requestId ?? '—'}</dd>
              <dt>{t('input.suggestions.failure.fieldAttempts', { defaultValue: 'Consecutive failures' })}</dt>
              <dd data-field="failureCount" className="font-mono">{failureCount}</dd>
            </dl>
            <div className={cn('mt-3 flex gap-2', 'max-[480px]:flex-col pointer-coarse:flex-col')}>
              <button
                type="button"
                data-action="retry"
                onClick={onRetry}
                className="rounded-md border px-2 py-1 transition-colors hover:bg-accent"
              >
                {t('input.suggestions.failure.retry', { defaultValue: 'Retry' })}
              </button>
              <button
                type="button"
                data-action="dismiss"
                onClick={onDismiss}
                className="rounded-md border px-2 py-1 transition-colors hover:bg-accent"
              >
                {t('input.suggestions.failure.dismiss', { defaultValue: 'Ignore for now' })}
              </button>
              <button
                type="button"
                data-action="close"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent"
              >
                {t('input.suggestions.failure.close', { defaultValue: 'Close' })}
              </button>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}
