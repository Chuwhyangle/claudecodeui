import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import { suggestionOptionId } from '@/modules/chat/utils/inputSuggestions';

type InputSuggestionChipsProps = {
  /** The listbox id, from `useInputSuggestions`; also prefixes each option's id. */
  listId: string;
  /** The labels to draw. Callers render this only while the chips are visible. */
  suggestions: string[];
  selectedIndex: number | null;
  /** Fills the draft with the chip's text. Never sends. */
  onAccept: (index: number) => void;
};

/**
 * Empty-composer suggestion chips, rendered by ChatComposer inside
 * PromptInputBody on top of the (empty) textarea.
 *
 * Absolutely positioned against the body so it adds no row: the body measures
 * the same height whether or not a chip is showing. Only the chips themselves
 * take pointer events — the rest of the strip stays transparent to clicks aimed
 * at the textarea — and `mousedown` is cancelled so clicking a chip neither
 * moves the caret nor steals focus from the textarea. Selection itself is owned
 * by the composer's keydown and mirrored through `aria-activedescendant`.
 *
 * Below 480px the chips stay one line and scroll horizontally, and the key
 * hint is not shown (there is no keyboard to name keys for).
 */
export function InputSuggestionChips({
  listId,
  suggestions,
  selectedIndex,
  onAccept,
}: InputSuggestionChipsProps) {
  const { t } = useTranslation('chat');

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div
      data-slot="input-suggestion-chips"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-4 py-2"
    >
      <div
        id={listId}
        role="listbox"
        aria-label={t('input.suggestions.listLabel', { defaultValue: 'Frequent inputs' })}
        className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]"
      >
        {suggestions.map((text, index) => (
          <button
            key={text}
            id={suggestionOptionId(listId, index)}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            // The chips are not in the tab order: keyboard selection runs through
            // the textarea's Tab handling, which keeps focus in one place.
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAccept(index)}
            className={cn(
              'h-6 shrink-0 rounded-full border border-dashed border-border/70 px-2 text-xs text-muted-foreground transition-colors',
              'hover:border-primary/60 hover:text-foreground',
              selectedIndex === index && 'border-primary bg-primary/10 text-foreground',
            )}
          >
            {text}
          </button>
        ))}
      </div>
      <span
        aria-hidden="true"
        className="hidden shrink-0 text-[11px] text-muted-foreground/70 min-[481px]:inline"
      >
        {[
          t('input.suggestions.hintSelect', { defaultValue: 'Tab to select' }),
          t('input.suggestions.hintAccept', { defaultValue: 'Enter to accept' }),
          t('input.suggestions.hintHide', { defaultValue: 'Esc to hide' }),
        ].join(' · ')}
      </span>
    </div>
  );
}
