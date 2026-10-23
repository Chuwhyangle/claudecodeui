/**
 * Candidate rules for the empty-composer suggestion chips (proposal tier 1).
 *
 * Pure and browser-free on purpose: the data source is `readAllInputHistory()`
 * in `useInputHistory.ts`, which the state hook feeds in. Keeping the ranking
 * here means the rules can be tested without a React tree, a storage mock or a
 * network — and there is deliberately no seed phrase anywhere: no history, no
 * chips.
 */

/** At most this many chips are shown. */
const MAX_SUGGESTIONS = 3;
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
