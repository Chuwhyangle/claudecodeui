import { useTranslation } from 'react-i18next';
import { useState } from 'react';

import { cn } from '@/shared/utils';
import {
  suggestionOptionId,
  truncateSuggestionLabel,
} from '@/modules/chat/utils/inputSuggestions';
import type { SuggestionChip } from '@/modules/chat/utils/inputSuggestions';

type InputSuggestionChipsProps = {
  /** The listbox id, from `useInputSuggestions`; also prefixes each option's id. */
  listId: string;
  /**
   * Plain habit labels, the pre-LLM shape. Ignored when `chips` is supplied; kept so
   * standalone renders and older tests keep working.
   */
  suggestions?: string[];
  /** The merged strip (quoted > model > habit) from `useInputSuggestions`. */
  chips?: SuggestionChip[];
  selectedIndex: number | null;
  /** Accepts a habit chip by its index in the strip. Also the fallback for absent source callbacks. */
  onAccept?: (index: number) => void;
  /** Accepts a model chip: fills the draft and sends it. */
  onAcceptModel?: (index: number) => void;
  /** Accepts the quoted chip: fills `> text` and focuses, without sending. */
  onAcceptQuoted?: (text: string) => void;
  /**
   * Called when the strip's own background — the gaps between chips or the
   * space past the last one — is pressed. The composer focuses its textarea
   * here so a click aimed at the input is never swallowed by the listbox.
   */
  onBackgroundPress?: () => void;
  /**
   * Whether the second-line preview may be drawn. Absent means "yes unless the
   * pointer is coarse and cannot hover" — the same rule the proposal states.
   */
  showPreview?: boolean;
};

/**
 * The second line's reading for one chip.
 *
 * A quoted chip fills a `> …` block, so its preview shows that block's first
 * line rather than the raw passage: the marker and the line break are part of
 * what a click actually writes, and the preview's own `truncate` class shortens
 * a long line. Model and habit chips fill their own text, so their preview is
 * that complete text.
 */
function previewTextFor(chip: SuggestionChip): string {
  if (chip.source !== 'quoted') {
    return chip.text;
  }
  const firstLine = chip.text.split(/\r?\n/u)[0] ?? '';
  return `> ${firstLine}`;
}

/** Touch devices have no hover, so a preview would only be a flash before the fill. */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
  } catch {
    return false;
  }
}

/**
 * Composer suggestion chips, rendered by ChatComposer inside PromptInputBody on
 * top of the (empty) textarea.
 *
 * Absolutely positioned against the body so it adds no row: the body measures
 * the same height whether or not a chip is showing. The listbox hugs its chips
 * (`flex: 0 1 auto`) rather than filling the row, so it only covers the chips
 * and their gaps; a press on its own background is cancelled and handed to
 * `onBackgroundPress` so focus still reaches the textarea underneath. A press
 * on a chip is cancelled too, so clicking a chip neither moves the caret nor
 * steals focus from the textarea. Selection itself is owned by the composer's
 * keydown and mirrored through `aria-activedescendant`.
 *
 * Three sources share the strip in a fixed order — quoted selection, model
 * replies, then habits. Their click semantics differ (a model reply is sent, a
 * quotation is only pasted and focused), so each source gets its own callback.
 * The label is shortened to one line; the complete text lives in `title` and in
 * the second-line preview the keyboard selection and the mouse hover reveal.
 *
 * Below 480px the chips stay one line and scroll horizontally, and the key
 * hint is not shown (there is no keyboard to name keys for).
 */
export function InputSuggestionChips({
  listId,
  suggestions = [],
  chips,
  selectedIndex,
  onAccept,
  onAcceptModel,
  onAcceptQuoted,
  onBackgroundPress,
  showPreview,
}: InputSuggestionChipsProps) {
  const { t } = useTranslation('chat');
  // Which chip the pointer is over. Null means "no hover"; the preview then falls
  // back to the keyboard selection, then to the first model chip.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const resolved: SuggestionChip[] = chips ?? suggestions.map((text, index) => ({
    id: `habit-${index}`,
    text,
    source: 'habit' as const,
    index,
  }));

  if (resolved.length === 0) {
    return null;
  }

  const previewEnabled = showPreview ?? !isCoarsePointer();
  // The chip the pointer is over wins, then the keyboard selection. Only when
  // neither exists does the preview fall back to the first model chip; the
  // quoted chip is never a fallback because it is not a reply to send.
  const activeIndex = hoveredIndex ?? selectedIndex;
  const previewChip = previewEnabled
    ? (activeIndex === null
      ? resolved.find((chip) => chip.source === 'model') ?? null
      : resolved[activeIndex] ?? null)
    : null;

  const accept = (chip: SuggestionChip, index: number) => {
    if (chip.source === 'quoted' && onAcceptQuoted) {
      onAcceptQuoted(chip.text);
      return;
    }
    if (chip.source === 'model' && onAcceptModel) {
      onAcceptModel(chip.index);
      return;
    }
    onAccept?.(index);
  };

  return (
    <div
      data-slot="input-suggestion-chips"
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-4 py-2"
    >
      <div
        id={listId}
        role="listbox"
        aria-label={t('input.suggestions.listLabel', { defaultValue: 'Frequent inputs' })}
        // `flex-[0_1_auto]` instead of `flex-1`: the listbox may shrink below
        // its content (so a long row scrolls) but never grows past the chips,
        // so it does not lay a transparent full-row hit target over the
        // textarea. `mousedown` on that background is handed to the composer.
        className="pointer-events-auto flex min-w-0 flex-[0_1_auto] items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]"
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
        {resolved.map((chip, index) => (
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
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex((current) => (current === index ? null : current))}
            onClick={() => accept(chip, index)}
            className={cn(
              'h-6 shrink-0 rounded-full border border-dashed border-border/70 px-2 text-xs text-muted-foreground transition-colors',
              'hover:border-primary/60 hover:text-foreground',
              chip.source === 'model' && 'border-solid',
              chip.source === 'quoted' && 'border-solid border-primary/50 bg-primary/5',
              selectedIndex === index && 'border-primary bg-primary/10 text-foreground',
            )}
          >
            {chip.source === 'quoted'
              ? t('input.suggestions.quoteChip', {
                defaultValue: 'Quote: {{text}}',
                text: truncateSuggestionLabel(chip.text),
              })
              : truncateSuggestionLabel(chip.text)}
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
      {previewChip && (
        // The textarea's second line: the complete text of the hovered or
        // keyboard-selected chip, or the first model chip when neither exists.
        // A quoted chip previews the first line it will fill (`> …`). Never a
        // hit target — the chips above keep the pointer.
        <span
          data-suggestion-preview={previewChip.source}
          aria-label={t('input.suggestions.previewHint', { defaultValue: 'Full suggestion' })}
          className="pointer-events-none absolute left-4 right-4 top-7 truncate text-xs text-muted-foreground/70"
        >
          {previewTextFor(previewChip)}
        </span>
      )}
    </div>
  );
}
