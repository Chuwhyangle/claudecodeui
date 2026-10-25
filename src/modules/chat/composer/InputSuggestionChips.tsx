import { useEffect, useState } from 'react';
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
 * The layout switch for the chip strip: either a narrow viewport (the same 480px
 * boundary a phone sits under) or a coarse pointer (a finger, whatever the width).
 *
 * Both, because each signal alone misses a real case. A phone in portrait reports
 * both, but a narrow desktop window has a fine pointer and the same height
 * problem, while a tablet or a landscape phone can be wider than 480px and still
 * be driven by touch. Either one therefore takes the single-line, swipeable row;
 * only a wide viewport with a fine pointer keeps the wrapping row.
 */
const NARROW_CHIP_ROW_QUERY = '(max-width: 480px), (pointer: coarse)';

const readNarrowChipRow = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(NARROW_CHIP_ROW_QUERY).matches;
};

/**
 * Follows the layout switch while the strip is mounted. Used only by
 * `InputSuggestionChips`: the strip is the one surface whose row layout has to
 * change between the phone arrangement and the desktop one.
 *
 * Read as state, and followed, because a rotation or a window drag can cross the
 * boundary while the composer is open; a value read only at render would leave
 * the other arrangement's row in place until something else re-rendered.
 */
function useNarrowChipRow(): boolean {
  const [isNarrow, setIsNarrow] = useState<boolean>(readNarrowChipRow);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const query = window.matchMedia(NARROW_CHIP_ROW_QUERY);
    const onChange = () => setIsNarrow(query.matches);
    // The viewport can already have crossed the boundary between the first render
    // and this effect; read once rather than waiting for the next change event.
    onChange();

    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  return isNarrow;
}

/**
 * Composer suggestion chips, rendered by ChatComposer as a flow row under the
 * (empty) textarea.
 *
 * The row is part of the layout, not an overlay: every chip occupies real space,
 * so a strip that grows to a second or third line pushes the composer's box (and
 * therefore shrinks the transcript) instead of covering the box's own text.
 *
 * The row has two arrangements, chosen from the viewport (see
 * `NARROW_CHIP_ROW_QUERY`):
 *
 * - Wide (a desktop window with a fine pointer) wraps (`flex-wrap`). Every chip is
 *   reachable with a pointer without any hidden track, and a chip shows as much of
 *   its text as two lines hold (`line-clamp-2`); the complete text stays in `title`.
 * - Narrow or touch-only is ONE line that scrolls sideways (`flex-nowrap
 *   overflow-x-auto`): a phone there has ~400-450px of visible height once its
 *   keyboard is up, so a second chip line costs more of the transcript than it is
 *   worth. Each chip is `shrink-0 whitespace-nowrap` and clamps to `max-w-[85%]`,
 *   which leaves the next chip peeking and so advertises the swipe; the strip's own
 *   scrollbar is hidden and the native touch pan does the moving. The complete text
 *   is still in `title`.
 *
 * There is deliberately no second-line preview: hovering or keyboard-selecting a
 * chip only highlights that chip, in either arrangement. A press on the listbox's
 * own background is cancelled and handed to `onBackgroundPress` so focus still
 * reaches the textarea; a press on a chip is cancelled too, so clicking a chip
 * neither moves the caret nor steals focus from the textarea. Selection itself is
 * owned by the composer's keydown and mirrored through `aria-activedescendant`.
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
  const isNarrowRow = useNarrowChipRow();

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
        data-suggestion-layout={isNarrowRow ? 'single-row' : 'wrap'}
        // Wide: `flex-wrap` is the layout — a chip wider than the remaining space
        // moves to the next line, so nothing is silently clipped and no horizontal
        // scroll gesture is needed. Narrow: one line with the strip's own horizontal
        // scroll, so the row's height stays one chip tall. In both, the row's height
        // is content-driven, which is how the box above it grows with it.
        className={cn(
          'pointer-events-auto flex min-w-0 items-start gap-1 px-4 py-2',
          isNarrowRow
            ? 'scrollbar-hide flex-nowrap overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]'
            : 'flex-wrap',
        )}
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
              'rounded-full border border-dashed border-border/70 px-2 py-0.5 text-left text-xs leading-5 text-muted-foreground transition-colors',
              // Wide: two lines, then a clamp — the full text is still in `title`.
              // `min-w-0` + `max-w-full` let a long chip shrink to the row and
              // wrap instead of forcing the listbox wider than the composer.
              // Narrow: one line per chip, truncated at 85% of the row so the next
              // chip peeks and the horizontal swipe is discoverable; the chip never
              // shrinks, so the track overflows and actually scrolls.
              isNarrowRow
                ? 'max-w-[85%] shrink-0 truncate whitespace-nowrap'
                : 'line-clamp-2 min-w-0 max-w-full break-words',
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
