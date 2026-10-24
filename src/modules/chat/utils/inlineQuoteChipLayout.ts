/**
 * Layout rules for the inline quote chip — the quoted-selection chip drawn AT the
 * draft's caret while the box holds text and the caret cannot be seen (the
 * composer is blurred while the person selects transcript text).
 *
 * Pure arithmetic only: where the caret splits the draft, how tall the textarea
 * may be while the chip participates in the text flow, and how much width the
 * textarea's scrollbar takes from the mirror layer. The DOM reads and writes live
 * in `useInlineQuoteChip`; keeping the numbers here lets them be tested without a
 * browser layout engine.
 */

/** Where the real chip button is drawn, relative to the composer body's box. */
export type InlineQuoteChipPosition = {
  left: number;
  top: number;
};

/** The draft cut at the insertion point: the chip sits between the two halves. */
export type InlineQuoteChipSegments = {
  before: string;
  after: string;
  caret: number;
};

/**
 * The caret the inline chip is drawn at.
 *
 * A blurred textarea keeps the `selectionEnd` the person left behind, which is
 * the insertion point the accept entry reads. A missing or non-finite reading
 * falls back to the end of the draft — the same place the accept entry inserts
 * when the box has never held focus — so the chip can never be drawn somewhere
 * the click would not write.
 */
export function resolveInlineQuoteChipCaret(
  input: string,
  selectionEnd: number | null | undefined,
): number {
  if (typeof selectionEnd !== 'number' || !Number.isFinite(selectionEnd)) {
    return input.length;
  }
  return Math.min(Math.max(selectionEnd, 0), input.length);
}

/**
 * Splits the draft around the chip. UTF-16 indices, the same units the textarea
 * reports and `String.prototype.slice` uses, so a surrogate pair is never cut:
 * the two halves are exactly the text before and after the caret.
 */
export function splitInlineQuoteChipInput(
  input: string,
  selectionEnd: number | null | undefined,
): InlineQuoteChipSegments {
  const caret = resolveInlineQuoteChipCaret(input, selectionEnd);
  return {
    before: input.slice(0, caret),
    after: input.slice(caret),
    caret,
  };
}

/**
 * The textarea's height while the chip is in the flow: the mirror layer's content
 * height, capped by the box's existing maximum. Height follows CONTENT, not the
 * textarea's own `scrollHeight` — the latter cannot see the inline chip because
 * the chip is drawn in the mirror layer.
 *
 * A null/non-positive cap means "no cap" (the environment reports none), in which
 * case the content height is used as it is.
 */
export function inlineChipTextareaHeight(
  contentHeight: number,
  maxHeight: number | null,
): number {
  const content = Number.isFinite(contentHeight) ? Math.max(0, contentHeight) : 0;
  if (maxHeight === null || !Number.isFinite(maxHeight) || maxHeight <= 0) {
    return content;
  }
  return Math.min(content, maxHeight);
}

/**
 * The width a classic vertical scrollbar takes inside the textarea, in CSS pixels.
 * The mirror layer is not a scroll container, so this width has to be added to its
 * right padding for the two layers to wrap text at the same points. Overlay
 * scrollbars report no difference and therefore no compensation.
 */
export function scrollbarCompensation(offsetWidth: number, clientWidth: number): number {
  if (!Number.isFinite(offsetWidth) || !Number.isFinite(clientWidth)) {
    return 0;
  }
  return Math.max(0, offsetWidth - clientWidth);
}
