import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { suggestionOptionId } from '@/modules/chat/utils/inputSuggestions';
import type { SuggestionChip } from '@/shared/types';

type InputSuggestionChipsProps = {
  /** The listbox id, from `useInputSuggestions`; also prefixes each option's id. */
  listId: string;
  /** The merged strip (quoted > model > habit) from `useInputSuggestions`. */
  chips: readonly SuggestionChip[];
  selectedIndex: number | null;
  /** The one acceptance entry. What the chip does is its source's data, not this component's. */
  onAccept: (chip: SuggestionChip) => void;
  /**
   * Called when the strip's own background — the gaps between chips or the
   * space past the last one — is pressed. The composer focuses its textarea
   * here so a click aimed at the input is never swallowed by the listbox.
   */
  onBackgroundPress?: () => void;
};

/**
 * Composer suggestion chips, rendered by ChatComposer as a flow row under the
 * (empty) textarea.
 *
 * The row is part of the layout, not an overlay: every chip occupies real space,
 * so a strip that grows to a second or third line pushes the composer's box (and
 * therefore shrinks the transcript) instead of covering the box's own text. The
 * listbox wraps (`flex-wrap`) rather than scrolling horizontally, which is what
 * makes every chip reachable with a pointer at any width — there is no hidden
 * track to drag, and touch and desktop use the same layout.
 *
 * A chip shows as much of its text as two lines hold (`line-clamp-2`); the
 * complete text stays in `title`. There is deliberately no second-line preview:
 * hovering or keyboard-selecting a chip only highlights that chip. A press on
 * the listbox's own background is cancelled and handed to `onBackgroundPress`
 * so focus still reaches the textarea; a press on a chip is cancelled too, so
 * clicking a chip neither moves the caret nor steals focus from the textarea.
 * Selection itself is owned by the composer's keydown and mirrored through
 * `aria-activedescendant`.
 *
 * Three sources share the strip in a fixed order — quoted selection, model
 * replies, then habits. Clicking any of them calls the same `onAccept(chip)`:
 * what differs per source is described by its accept descriptor, not here, so a
 * new source needs no new prop.
 */
export function InputSuggestionChips({
  listId,
  chips,
  selectedIndex,
  onAccept,
  onBackgroundPress,
}: InputSuggestionChipsProps) {
  const { t } = useTranslation('chat');

  if (chips.length === 0) {
    return null;
  }

  return (
    <div
      data-slot="input-suggestion-chips"
      className="relative z-10 w-full"
    >
      <div
        id={listId}
        role="listbox"
        aria-label={t('input.suggestions.listLabel', { defaultValue: 'Frequent inputs' })}
        // `flex-wrap` is the layout: a chip wider than the remaining space moves
        // to the next line, so nothing is silently clipped and no horizontal
        // scroll gesture is needed. The row's height is content-driven, which is
        // how the box above it grows with it.
        className="pointer-events-auto flex min-w-0 flex-wrap items-start gap-1 px-4 py-2"
        onMouseDown={(event) => {
          // Chips and their gaps bubble here; only a press on the listbox
          // itself is background. Never let it swallow the click: cancel the
          // default and let the composer put focus back in the textarea.
          if (event.target !== event.currentTarget) {
            return;
          }
          event.preventDefault();
          onBackgroundPress?.();
        }}
      >
        {chips.map((chip, index) => (
          <button
            key={chip.id}
            id={suggestionOptionId(listId, index)}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            data-chip-source={chip.source}
            title={chip.text}
            // The chips are not in the tab order: keyboard selection runs through
            // the textarea's Tab handling, which keeps focus in one place.
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAccept(chip)}
            className={cn(
              // Two lines, then a clamp — the full text is still in `title`.
              // `min-w-0` + `max-w-full` let a long chip shrink to the row and
              // wrap instead of forcing the listbox wider than the composer.
              'line-clamp-2 min-w-0 max-w-full break-words rounded-full border border-dashed border-border/70 px-2 py-0.5 text-left text-xs leading-5 text-muted-foreground transition-colors',
              'hover:border-primary/60 hover:text-foreground',
              chip.source === 'model' && 'border-solid',
              chip.source === 'quoted' && 'border-solid border-primary/50 bg-primary/5',
              selectedIndex === index && 'border-primary bg-primary/10 text-foreground',
            )}
          >
            {chip.source === 'quoted'
              ? t('input.suggestions.quoteChip', {
                defaultValue: 'Quote: {{text}}',
                text: chip.text,
              })
              : chip.text}
          </button>
        ))}
      </div>
    </div>
  );
}
