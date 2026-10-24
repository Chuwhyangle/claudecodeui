/**
 * Candidate rules for the composer's suggestion chips.
 *
 * Tier 1 is the habit chips ranked from `readAllInputHistory()`; the LLM tier adds model chips
 * (from `useReplySuggestions`) and the quoted-selection chip (from `useTranscriptSelection`). All
 * three merge into one ordered strip here, and the label/preview rules live beside the ranking so
 * they can be tested without a React tree, a storage mock or a network — and there is deliberately
 * no seed phrase anywhere: no history, no chips.
 *
 * The accept-descriptor record at the bottom of this file is the one place a source's acceptance
 * behaviour is described. The accept entry in `useSuggestionChips` reads that record and contains
 * no per-source branch, so adding a source is a data change, not a code change.
 */

import type { SuggestionChip } from '@/shared/types';

/** At most this many habit chips are shown. */
const MAX_SUGGESTIONS = 3;

/**
 * A chip's label on screen. Roughly one short line; the complete text goes in `title` and the
 * second-line preview, so nothing is lost by shortening it here.
 */
export const SUGGESTION_LABEL_MAX_CHARS = 18;

type BuildSuggestionChipsInput = {
  /** Transcript selection, already capped by `useTranscriptSelection`. */
  quotedText?: string | null;
  /** Model-generated complete replies, in the server's order. */
  modelChips?: readonly string[];
  /** Ranked habit chips from {@link buildInputSuggestions}. */
  habitChips?: readonly string[];
};

/**
 * The comparison form used across sources: trimmed, case-folded, internal whitespace collapsed.
 * Deliberately not `normalizeSuggestionKey`, whose trailing-punctuation rule exists to merge
 * habits — a model chip ending in a different mark is still a different reply.
 */
function normalizeChipText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Merges the three chip sources into the strip's fixed order: quoted selection first, then model
 * chips, then habit chips. A later chip whose normalized text duplicates an earlier one is
 * dropped, so the same reply is never offered twice (a model chip that happens to equal a habit
 * is the common case). The quoted chip is never truncated or dropped: the person selected it.
 */
export function buildSuggestionChips({
  quotedText,
  modelChips = [],
  habitChips = [],
}: BuildSuggestionChipsInput): SuggestionChip[] {
  const chips: SuggestionChip[] = [];
  const seen = new Set<string>();

  const quoted = quotedText?.trim() ?? '';
  if (quoted) {
    chips.push({ id: 'quoted-0', text: quoted, source: 'quoted', index: 0 });
    seen.add(normalizeChipText(quoted));
  }

  const append = (source: 'model' | 'habit', texts: readonly string[]) => {
    let index = 0;
    texts.forEach((text) => {
      const trimmed = text.trim();
      const key = normalizeChipText(trimmed);
      if (!trimmed || seen.has(key)) {
        return;
      }
      seen.add(key);
      chips.push({ id: `${source}-${index}`, text: trimmed, source, index });
      index += 1;
    });
  };
  append('model', modelChips);
  append('habit', habitChips);

  return chips;
}

/**
 * The label drawn inside a chip: line breaks become spaces, and anything past
 * {@link SUGGESTION_LABEL_MAX_CHARS} code points is replaced by an ellipsis. Code points rather
 * than UTF-16 units so an emoji is never split in half.
 */
export function truncateSuggestionLabel(text: string, max = SUGGESTION_LABEL_MAX_CHARS): string {
  const singleLine = text.replace(/\s+/gu, ' ').trim();
  const points = Array.from(singleLine);
  if (points.length <= max) {
    return singleLine;
  }
  return `${points.slice(0, max).join('')}…`;
}

/** Every non-input condition the chips' visibility shares. `useInputSuggestions` and the reply
 * hook both read this one predicate, so the extraction trigger and the drawn strip cannot drift. */
export type SuggestionDisplayConditions = {
  isLoading: boolean;
  /** The activity dock's server-backed turn reading; defaults to false for callers without one. */
  isDockTurnShown?: boolean;
  isOccupied: boolean;
  isCommandMenuOpen: boolean;
  isFileMenuOpen: boolean;
  hasQueuedDraft: boolean;
  hasAttachments: boolean;
};

/**
 * True when the assistant is idle and nothing else (a menu, a queued draft, an attachment, a
 * background job) is holding the composer. The input-empty rule is applied by each caller: model
 * and habit chips need it, the quoted chip deliberately does not.
 */
export function suggestionConditionsHold(conditions: SuggestionDisplayConditions): boolean {
  return !conditions.isLoading
    && !(conditions.isDockTurnShown ?? false)
    && !conditions.isOccupied
    && !conditions.isCommandMenuOpen
    && !conditions.isFileMenuOpen
    && !conditions.hasQueuedDraft
    && !conditions.hasAttachments;
}
/** A candidate must be short enough to read as a suggestion rather than a draft. */
const MAX_TEXT_LENGTH = 60;
/** One occurrence may be a typo or a one-off; a repeat is what makes it a habit. */
const MIN_OCCURRENCES = 2;
/**
 * Trailing punctuation is dropped before counting so `继续`, `继续。` and
 * `继续！` are one habit. Only the trailing run is touched — punctuation inside
 * the sentence is part of the writing.
 */
const TRAILING_PUNCTUATION = /[\s。．.!！?？,，;；:：、…~～]+$/u;
/** Any line break means the entry was a paragraph, not a quick repeat. */
const LINE_BREAK = /[\r\n]/;

/**
 * The id of one chip. The textarea's `aria-activedescendant` and the option's
 * own id are derived here so they cannot drift apart.
 */
export function suggestionOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * The counting form of one history entry: trimmed, case-folded, trailing
 * punctuation removed. Two entries with the same key are the same habit; the
 * newest of them supplies the text that is actually displayed.
 */
export function normalizeSuggestionKey(text: string): string {
  return text.trim().toLowerCase().replace(TRAILING_PUNCTUATION, '');
}

type Candidate = {
  /** The most recent original spelling of the habit, shown as the chip label. */
  text: string;
  /** How many entries normalize to the same key. */
  count: number;
  /** Index in the newest-first input; lower means more recently used. */
  recency: number;
};

/**
 * Ranks past inputs into at most three suggestion labels.
 *
 * `entriesNewestFirst` is the order `readAllInputHistory()` returns. Rules, in
 * the order they reject:
 * - blank entries never qualify;
 * - multi-line entries are excluded (a chip must fit on the input's one line);
 * - longer than 60 characters is excluded;
 * - entries starting with `/` are commands, not message text, and are excluded;
 * - fewer than two occurrences of the normalized key is excluded;
 * - frequency descending, ties broken by most recent use, top three.
 */
/** One live textarea selection: the draft and where the person's caret or selection sits. */
export type SuggestionFillSelection = {
  /** The draft exactly as the textarea shows it. */
  input: string;
  /** Where the selection starts; equal to `selectionEnd` when the caret is collapsed. */
  selectionStart: number;
  /** Where the selection ends — the insertion point (`selectionStart` when nothing is selected). */
  selectionEnd: number;
};

/** What an accepted chip writes into the composer: the whole new draft and where the caret lands. */
export type SuggestionFill = {
  /** The complete draft after the fill. */
  text: string;
  /** The caret after the fill, in UTF-16 units. */
  caret: number;
};

/** A line break is not text: a caret next to one never adds a padding space. */
function isLineBreak(character: string): boolean {
  return character === '\n' || character === '\r';
}

/**
 * Whether a character counts as text for the spacing rules: anything that
 * exists and is neither a space nor a line break. Punctuation is text.
 */
function isTextCharacter(character: string | undefined): boolean {
  return character !== undefined && character !== ' ' && !isLineBreak(character);
}

/** Whether the line the caret sits on holds no character at all (spaces are characters). */
function isCaretOnEmptyLine(input: string, caret: number): boolean {
  const lineStart = input.lastIndexOf('\n', caret - 1) + 1;
  const nextBreak = input.indexOf('\n', caret);
  const lineEnd = nextBreak === -1 ? input.length : nextBreak;
  return lineEnd <= lineStart;
}

/**
 * Insert a quoted passage at the live selection — the composer's acceptance
 * rules, as one pure function.
 *
 * The passage is inserted verbatim (its own line breaks included) at
 * `selectionEnd`; a selection is appended to rather than replaced. A padding
 * space is added before and/or after only when the adjacent character is text:
 * a space or a line break is not, so a quotation on a fresh line starts flush.
 * At the end of an empty line the passage opens a new paragraph with two line
 * breaks under it. The returned caret is the end of everything that was added.
 */
export function insertQuotedText(selection: SuggestionFillSelection, quoted: string): SuggestionFill {
  const { input } = selection;
  // Defensive: a textarea can report offsets from a value that has since been replaced.
  const insertAt = Math.min(Math.max(selection.selectionEnd, 0), input.length);
  const leadingSpace = isTextCharacter(input[insertAt - 1]) ? ' ' : '';
  const trailingSpace = isTextCharacter(input[insertAt]) ? ' ' : '';
  const endsOnEmptyLine = insertAt === input.length && isCaretOnEmptyLine(input, insertAt);
  const trailingBreaks = endsOnEmptyLine ? '\n\n' : '';
  const inserted = `${leadingSpace}${quoted}${trailingSpace}${trailingBreaks}`;
  return {
    text: `${input.slice(0, insertAt)}${inserted}${input.slice(insertAt)}`,
    caret: insertAt + inserted.length,
  };
}

/**
 * Everything that distinguishes one chip source's acceptance, as data.
 *
 * The accept entry (`useSuggestionChips.acceptChip`) reads one of these records
 * and applies it uniformly, so it never tests `chip.source`: a new source is
 * added by registering one more record, not by editing the entry. The three
 * built-in sources fill the same way the strip always did — the behavioural
 * notes on each field below are the old per-source branches, now data.
 */
export type SuggestionChipAcceptDescriptor = {
  /** The draft an acceptance writes, from the chip and the live selection. */
  buildFill: (chip: SuggestionChip, selection: SuggestionFillSelection) => SuggestionFill;
  /**
   * Whether the accepted text becomes the anchor the Suggest button re-draws
   * with. Only a quotation does: taking the composer's focus collapses the
   * transcript selection, and the button should still answer that passage.
   */
  anchorsSuggestionFocus: boolean;
  /** Whether the acceptance reports the ledger's `picked` event for this source. */
  reportsPicked: boolean;
  /**
   * Whether the fill arms the `sent` attribution, so a later send of exactly the
   * filled text is reported as this chip's text going out.
   */
  attributesSent: boolean;
  /**
   * The expansion seed an accepted chip asks for when the experiment is on, or
   * null for a source that never asks: only a picked model reply is a seed.
   */
  expansionSeed: ((chip: SuggestionChip) => string) | null;
  /**
   * Whether the acceptance sends the draft itself. Every built-in source is
   * false — accepting a chip always leaves the text in the box for the person to
   * send. The field exists because it is read from data: the accept contract
   * registers a synthetic source with it true to prove the entry honours a
   * descriptor without any code change (and that the "never send" assertion is
   * not vacuous).
   */
  submitsAfterFill: boolean;
};

/**
 * The fill a quotation writes: the passage itself, placed at the caret by
 * {@link insertQuotedText}. The chip's text is inserted verbatim — no quote
 * marker, no forced line break — because the passage is now ordinary draft text
 * the person edits and sends like anything else they typed.
 */
function buildInsertedQuotedFill(chip: SuggestionChip, selection: SuggestionFillSelection): SuggestionFill {
  return insertQuotedText(selection, chip.text);
}

/** The fill every non-quoted source writes: the chip's own complete text, caret after it. */
function buildVerbatimFill(chip: SuggestionChip): SuggestionFill {
  return { text: chip.text, caret: chip.text.length };
}

/**
 * The accept descriptors, keyed by source id.
 *
 * Exported (and mutable) so a source can be registered from data — the accept
 * contract's synthetic source does exactly that — and read by the one accept
 * entry in `useSuggestionChips`.
 */
export const SUGGESTION_CHIP_ACCEPT_SOURCES: Record<string, SuggestionChipAcceptDescriptor> = {
  quoted: {
    buildFill: buildInsertedQuotedFill,
    anchorsSuggestionFocus: true,
    reportsPicked: false,
    attributesSent: false,
    expansionSeed: null,
    submitsAfterFill: false,
  },
  model: {
    buildFill: buildVerbatimFill,
    anchorsSuggestionFocus: false,
    reportsPicked: true,
    attributesSent: true,
    expansionSeed: (chip) => chip.text,
    submitsAfterFill: false,
  },
  habit: {
    buildFill: buildVerbatimFill,
    anchorsSuggestionFocus: false,
    reportsPicked: false,
    attributesSent: false,
    expansionSeed: null,
    submitsAfterFill: false,
  },
};

export function buildInputSuggestions(entriesNewestFirst: readonly string[]): string[] {
  const candidates = new Map<string, Candidate>();

  entriesNewestFirst.forEach((entry, recency) => {
    if (typeof entry !== 'string') {
      return;
    }
    const text = entry.trim();
    if (!text || LINE_BREAK.test(text) || text.length > MAX_TEXT_LENGTH || text.startsWith('/')) {
      return;
    }
    const key = normalizeSuggestionKey(text);
    if (!key) {
      return;
    }
    const existing = candidates.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    // First encounter in a newest-first walk is the most recent spelling, which
    // is the one shown, and its index is this habit's recency rank.
    candidates.set(key, { text, count: 1, recency });
  });

  return [...candidates.values()]
    .filter((candidate) => candidate.count >= MIN_OCCURRENCES)
    .sort((left, right) => right.count - left.count || left.recency - right.recency)
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => candidate.text);
}
