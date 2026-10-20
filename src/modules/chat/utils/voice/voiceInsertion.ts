/**
 * The tracked insertion range continuous dictation commits text into.
 *
 * WHY A RANGE AND NOT "APPEND TO THE BOX". The single-press path ended with one transcript and the
 * composer put it at the end of the draft. Continuous capture commits *while the user is still
 * talking*, which means the user can keep editing the box between two committed segments. Appending
 * to the end each time would then interleave the user's edits with the dictation and reorder speech
 * — the second segment would land after text the user typed after the first. What the feature
 * promises is: the committed words stay contiguous, in the order they were spoken, and nothing the
 * user typed elsewhere is lost.
 *
 * The state is therefore the whole draft plus the half-open interval `[start, end)` that holds the
 * committed voice text. The interval begins at the caret that was in the box when listening started
 * (`beginVoiceInsertion`), each committed segment is inserted at `end` and extends it
 * (`appendVoiceSegment`), and every edit the user makes is remapped through the interval
 * (`applyVoiceEdit`) so the committed text keeps its identity while the text around it changes.
 *
 * IT IS A PURE MODULE. No React, no DOM, no clock: plain string/interval arithmetic, which is what
 * lets the properties below be measured with a seeded generator over hundreds of random edit
 * sequences rather than through a browser.
 */

/**
 * The composer's draft and the interval voice text has been committed into.
 *
 * `text.slice(start, end)` is the committed voice text, always — that is the module's whole
 * invariant, and the reason the state is one object rather than three values a caller could update
 * out of step.
 */
export type VoiceInsertion = {
  /** The composer's whole draft. */
  text: string;
  /** Inclusive offset where the committed voice text begins. */
  start: number;
  /** Exclusive offset where it ends. Appends are inserted at `end`. */
  end: number;
};

/** Clamp `value` into `[0, limit]`; a caret can arrive out of range from a stale DOM reading. */
function clamp(value: number, limit: number): number {
  if (value < 0) return 0;
  if (value > limit) return limit;
  return value;
}

/**
 * Opens an insertion range at `cursor` in `text`.
 *
 * The caret is clamped to the draft rather than trusted: it is read off the textarea at the moment
 * the mic is pressed, and a stale or missing reading (a standalone render with no real textarea)
 * must resolve to a usable position instead of an out-of-range interval.
 */
export function beginVoiceInsertion(text: string, cursor: number): VoiceInsertion {
  const at = clamp(cursor, text.length);
  return { text, start: at, end: at };
}

/** The committed voice text: the slice of the draft the interval holds. */
export function voiceCommittedText(state: VoiceInsertion): string {
  return state.text.slice(state.start, state.end);
}

/**
 * Inserts one committed segment at the interval's end and advances it.
 *
 * The segment is taken verbatim — the seam deduplication that decides *what* to insert happens where
 * the previous segment's text is in hand (see `reassembleText` in `voiceSegments.ts`), not here. An
 * empty segment is a no-op rather than an empty insertion, so a segment that produced no words
 * cannot move the interval and split a later append from an earlier one.
 */
export function appendVoiceSegment(state: VoiceInsertion, segment: string): VoiceInsertion {
  if (segment === '') return state;
  const text = state.text.slice(0, state.end) + segment + state.text.slice(state.end);
  return { text, start: state.start, end: state.end + segment.length };
}

/**
 * Remaps the interval through an edit of the draft: `[from, to)` replaced by `inserted`.
 *
 * The edit is described the way a textarea's change really is — a replaced span and its replacement
 * — and the interval is carried through it by transforming its two endpoints:
 *
 *   · an offset before the edit is unchanged; an offset inside the replaced span lands after the
 *     inserted text (the characters it pointed at are gone); an offset after it shifts by the
 *     length the edit added or removed.
 *   · a plain insertion (`from === to`) at exactly an endpoint belongs to the text *outside* the
 *     range: typing at the caret that opened the range inserts before the committed words, and
 *     typing at the range's end inserts after them. That is why the two endpoints are remapped
 *     with different boundary rules rather than one — otherwise a keystroke at the caret would be
 *     swallowed into the committed slice and reorder the speech around it.
 *
 * The two endpoints are clamped together at the end (`start <= end`), which is what keeps the
 * interval well-formed when an edit deletes across the whole committed region.
 */
export function applyVoiceEdit(
  state: VoiceInsertion,
  from: number,
  to: number,
  inserted: string,
): VoiceInsertion {
  const length = state.text.length;
  const editFrom = clamp(Math.min(from, to), length);
  const editTo = clamp(Math.max(from, to), length);
  const removed = editTo - editFrom;
  const delta = inserted.length - removed;
  const text = state.text.slice(0, editFrom) + inserted + state.text.slice(editTo);

  // Where one old offset lands. `isStart` selects the boundary rule for a zero-width insertion
  // landing exactly on an endpoint: the start follows the inserted text (the words go before the
  // committed run), the end does not (they go after it).
  const remap = (offset: number, isStart: boolean): number => {
    if (offset < editFrom) return offset;
    if (offset > editTo) return offset + delta;
    // editFrom <= offset <= editTo here.
    if (editFrom === editTo) return isStart ? offset + inserted.length : offset;
    if (offset === editFrom) return isStart ? editFrom + inserted.length : offset;
    return editFrom + inserted.length;
  };

  const start = remap(state.start, true);
  const end = remap(state.end, false);
  return { text, start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * The single-span edit that turns `before` into `after`, via the longest common prefix and suffix.
 *
 * A textarea's change event hands over the whole new value rather than the replaced span, so the
 * span has to be recovered. The longest common ends are the conventional choice and the right one
 * here: typing a character mid-word, deleting a selection, and pasting all appear as one replaced
 * span, and anything a single insertion could also explain is resolved to the shortest edit.
 */
function editBetween(before: string, after: string): { from: number; to: number; inserted: string } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Remaps the interval through a textarea change that replaced part of the draft.
 *
 * The composer is handed the whole new value by the DOM rather than the replaced span, so the span
 * is recovered from the two strings and then applied by `applyVoiceEdit`. This is the entry a
 * controlled textarea's `onChange` calls; `applyVoiceEdit` is the arithmetic underneath it.
 */
export function applyVoiceChange(state: VoiceInsertion, nextText: string): VoiceInsertion {
  const { from, to, inserted } = editBetween(state.text, nextText);
  return applyVoiceEdit(state, from, to, inserted);
}
