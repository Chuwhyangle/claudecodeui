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

/**
 * The width, in CSS pixels, of the empty space BEFORE the strip's first chip.
 *
 * The strip is drawn over the empty textarea (they share one grid cell), so a
 * press on the strip would otherwise be eaten instead of reaching the box
 * underneath. The space is the strip's first flow item and belongs to no
 * pointer target: a press there falls through to the textarea, which is what
 * opens the soft keyboard and the long-press paste menu on a phone, and the
 * textarea's 16px left padding puts its caret inside the space as the feedback
 * that the box has focus.
 *
 * It is an item of the row, not a margin of it. On the wide wrapping row only the
 * first line is indented and the second starts flush left; on the narrow row it
 * is the head of the scroll content, so a swipe slides it away with the chips
 * rather than leaving a blank strip beside them.
 *
 * One constant for both arrangements, so a window drag never changes how much of
 * the strip the pointer can reach.
 */
export const SUGGESTION_CHIP_PASS_THROUGH_PX = 44;

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
 * Composer suggestion chips, rendered by ChatComposer over the (empty)
 * textarea's own grid cell.
 *
 * The strip occupies the SAME cell as the textarea, not a row under it: the cell
 * is as tall as the taller of the two, so an empty box with chips shows the chip
 * row directly at the top of the box instead of one blank textarea line above it.
 * When a desktop row wraps to a second line the cell grows with it, and the
 * one-line textarea stays underneath.
 *
 * Because the strip lies over the box, it may not swallow presses aimed at the
 * box: the wrapper AND the listbox are `pointer-events-none`, and only a chip turns
 * the pointer back on. The leading spacer, the gaps between chips and the space
 * past the last one therefore all fall through to the textarea.
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
 * chip only highlights that chip, in either arrangement. A press on a chip
 * is cancelled, so clicking a chip neither moves the caret nor steals focus from
 * the textarea. Selection itself is
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
}: InputSuggestionChipsProps) {
  const { t } = useTranslation('chat');
  const isNarrowRow = useNarrowChipRow();

  if (chips.length === 0) {
    return null;
  }

  return (
    <div
      data-slot="input-suggestion-chips"
      // The second occupant of the textarea's cell: `gridArea: 1 / 1` is the same
      // cell the textarea names (the composer switches its body to a grid and writes
      // the identical `gridArea` on the textarea). Both are placed explicitly —
      // an auto-placed item would be pushed to the next free row under the strip.
      // `pointer-events-none` on the wrapper and on the listbox is what lets a press
      // anywhere but on a chip reach the box below.
      className="pointer-events-none relative z-10 w-full"
      style={{ gridArea: '1 / 1' }}
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
        // is content-driven, which is how the shared cell grows with it.
        // `pointer-events-none`: only a chip takes the pointer, so the leading spacer,
        // the gaps and the row end are all presses on the textarea underneath. On the
        // narrow row the chips' own touch pan still scrolls this container — the pan
        // follows the touched element's ancestors, not their `pointer-events`.
        className={cn(
          'pointer-events-none flex min-w-0 items-start gap-1 px-4 py-2',
          isNarrowRow
            ? 'scrollbar-hide flex-nowrap overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]'
            : 'flex-wrap',
        )}
      >
        {/* The pass-through spacer: the first flow item of the row (see the constant). */}
        <span
          data-slot="input-suggestion-chips-pass-through"
          aria-hidden="true"
          className="shrink-0 self-stretch"
          style={{ width: SUGGESTION_CHIP_PASS_THROUGH_PX }}
        />
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
              'pointer-events-auto rounded-full border border-dashed border-border/70 px-2 py-0.5 text-left text-xs leading-5 text-muted-foreground transition-colors',
              // Wide: two lines, then a clamp — the full text is still in `title`.
              // `min-w-0` + the cap let a long chip shrink and wrap instead of forcing
              // the listbox wider than the composer. The cap is the row minus the
              // spacer (44px) and one gap (4px): a chip allowed the whole row would not
              // fit beside the spacer, wrap to line two, and leave line one empty.
              // Narrow: one line per chip, truncated at 85% of the row so the next
              // chip peeks and the horizontal swipe is discoverable; the chip never
              // shrinks, so the track overflows and actually scrolls.
              isNarrowRow
                ? 'max-w-[85%] shrink-0 truncate whitespace-nowrap'
                : 'line-clamp-2 min-w-0 max-w-[calc(100%-48px)] break-words',
              'hover:border-primary/60 hover:text-foreground',
              // Every source draws the same dashed frame: the row has no legend,
              // and all three chips accept the same way, so a solid-vs-dashed
              // split would only read as a difference that does not exist. The
              // quoted chip keeps its own theme-coloured frame and tint, which
              // mark what it inserts rather than which mechanism made it.
              chip.source === 'quoted' && 'border-primary/50 bg-primary/5',
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
