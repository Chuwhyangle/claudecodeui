import { useTranslation } from 'react-i18next';
import type { RefObject } from 'react';

import { cn } from '@/shared/utils';
import { truncateSuggestionLabel } from '@/modules/chat/utils/inputSuggestions';
import type { InlineQuoteChipPosition } from '@/modules/chat/utils/inlineQuoteChipLayout';
import type { SuggestionChip } from '@/shared/types';

/**
 * The quoted chip drawn in the text flow, over the mirror layer's inline-block
 * placeholder.
 *
 * Deliberately NOT inside the mirror: that layer is `aria-hidden`, so anything
 * drawn there is invisible to assistive technology. This is a real button,
 * absolutely positioned over the placeholder's box, with the same wording as the
 * chip-row option (the existing `input.suggestions.quoteChip` key — no new i18n
 * key) and the complete passage in `title`.
 *
 * A press must not collapse the transcript selection before the click lands:
 * taking focus would collapse the page selection, which is the live selection
 * that keeps this chip on screen and supplies the accepted passage. So both the
 * pointer and the compatibility mouse event cancel their default action; the
 * click still arrives. There is no keyboard path — the chip only exists while
 * the box is blurred for a transcript selection, so it serves pointer and touch.
 */
type InlineQuoteChipProps = {
  chip: SuggestionChip;
  /** Measured by the hook so the placeholder can reserve exactly this width. */
  chipRef: RefObject<HTMLButtonElement>;
  /** Over the placeholder; null before the first measurement. */
  position: InlineQuoteChipPosition | null;
  /** The composer's one acceptance entry. */
  onAccept: (chip: SuggestionChip) => void;
};

export function InlineQuoteChip({ chip, chipRef, position, onAccept }: InlineQuoteChipProps) {
  const { t } = useTranslation('chat');

  return (
    <button
      ref={chipRef}
      type="button"
      data-slot="inline-quote-chip"
      data-chip-source="quoted"
      title={chip.text}
      // The chips are not in the tab order: this surface has no keyboard path.
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onAccept(chip)}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
      className={cn(
        'pointer-events-auto absolute z-20 inline-flex h-6 max-w-[calc(100%-2rem)] items-center truncate rounded-full border border-solid border-primary/50 bg-primary/5 px-2 text-xs text-muted-foreground transition-colors',
        'hover:border-primary/60 hover:text-foreground',
        position === null && 'opacity-0',
      )}
    >
      {t('input.suggestions.quoteChip', {
        defaultValue: 'Quote: {{text}}',
        text: truncateSuggestionLabel(chip.text, 20),
      })}
    </button>
  );
}
