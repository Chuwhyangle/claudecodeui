import { CheckIcon, Loader2, RotateCcwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui';
import type { UseDraftRewriteResult } from '@/modules/chat-composer/hooks/useDraftRewrite';

/**
 * The composer's ✦ draft-rewrite surface: a text chip below the textarea (above the footer) and
 * the one-candidate panel it expands into.
 *
 * WHAT IT DRAWS. Collapsed: a single labelled chip. Expanded: ONLY the candidate body plus two
 * icon buttons (✓ apply, ↻ retry); a loading line or a one-sentence error is the only other copy.
 * There is deliberately no heading and no “not applied yet” status — the textarea above is the
 * source of the original and the panel exists only to show the answer.
 *
 * WHAT A PRESS DOES. Anywhere in the panel that is not a button folds it back to the chip; a
 * non-empty text selection does not, so dragging across the candidate to read it cannot dismiss
 * it, and scrolling never does. The icon buttons stop propagation, so apply/retry never also
 * collapse. Applying writes the draft (the caller's writer) and never sends.
 *
 * SCROLL IS BOUNDED. The candidate area is height-capped and scrolls internally, so a short
 * viewport (a phone with the soft keyboard up) cannot push the footer/send control off screen.
 *
 * Consumers: `ChatComposer` and the view criterion.
 */
type DraftRewriteCandidateProps = {
  draftRewrite: UseDraftRewriteResult;
  className?: string;
};

/**
 * Whether the current document selection should keep the panel open. A click that ends a
 * drag-selection over the candidate carries a non-empty selection; folding there would make the
 * text impossible to select.
 */
function hasNonEmptySelection(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const selection = window.getSelection();
  return selection !== null && selection.toString().trim() !== '';
}

export default function DraftRewriteCandidate({ draftRewrite, className }: DraftRewriteCandidateProps) {
  const { t } = useTranslation('chat');
  const {
    available,
    expanded,
    loading,
    candidate,
    failure,
    openOrRequest,
    collapse,
    retry,
    apply,
  } = draftRewrite;

  if (!available && !expanded) {
    return null;
  }

  const chipLabel = t('input.draftRewrite.chip', { defaultValue: '✦ Polish' });

  if (!expanded) {
    return (
      <div
        data-slot="draft-rewrite"
        data-draft-rewrite-state="chip"
        data-draft-rewrite-available={available ? 'true' : 'false'}
        data-draft-rewrite-candidate=""
        className={cn('flex px-4 pb-2', className)}
      >
        <button
          type="button"
          data-slot="draft-rewrite-chip"
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
          title={chipLabel}
          aria-label={chipLabel}
          onClick={openOrRequest}
        >
          {chipLabel}
        </button>
      </div>
    );
  }

  const handlePanelClick = (): void => {
    if (hasNonEmptySelection()) {
      return;
    }
    collapse();
  };

  const panelState = candidate !== null
    ? 'candidate'
    : loading
      ? 'loading'
      : failure !== null
        ? 'error'
        : 'candidate';

  return (
    <div
      data-slot="draft-rewrite"
      data-draft-rewrite-state={panelState}
      data-draft-rewrite-available={available ? 'true' : 'false'}
      data-draft-rewrite-candidate={candidate ?? ''}
      className={cn('px-4 pb-2', className)}
    >
      <div
        data-slot="draft-rewrite-panel"
        role="group"
        aria-label={t('input.draftRewrite.panelLabel', { defaultValue: 'Draft polish candidate' })}
        className="flex max-h-[30vh] flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-xs"
        onClick={handlePanelClick}
      >
        <div
          data-slot="draft-rewrite-candidate"
          className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm text-foreground"
        >
          {candidate !== null ? candidate : null}
          {candidate === null && loading && (
            <span
              data-slot="draft-rewrite-loading"
              className="inline-flex items-center gap-1.5 text-muted-foreground"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('input.draftRewrite.loading', { defaultValue: 'Polishing…' })}
            </span>
          )}
          {candidate === null && !loading && failure !== null && (
            <span data-slot="draft-rewrite-error" className="text-destructive">
              {t('input.draftRewrite.failed', { defaultValue: 'Polish failed; the draft is unchanged.' })}
            </span>
          )}
        </div>
        <div className="flex items-center justify-end gap-1 border-t border-border/40 px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="draft-rewrite-retry"
            className="h-7 w-7 [&_svg]:size-3.5"
            title={t('input.draftRewrite.retry', { defaultValue: 'Polish again' })}
            aria-label={t('input.draftRewrite.retry', { defaultValue: 'Polish again' })}
            disabled={loading}
            onClick={(event) => {
              event.stopPropagation();
              retry();
            }}
          >
            <RotateCcwIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="draft-rewrite-apply"
            className="h-7 w-7 text-primary [&_svg]:size-4"
            title={t('input.draftRewrite.apply', { defaultValue: 'Apply to draft' })}
            aria-label={t('input.draftRewrite.apply', { defaultValue: 'Apply to draft' })}
            disabled={candidate === null || loading}
            onClick={(event) => {
              event.stopPropagation();
              apply();
            }}
          >
            <CheckIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
