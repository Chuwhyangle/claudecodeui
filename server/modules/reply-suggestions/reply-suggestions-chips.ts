/**
 * Chip text handling: the pure functions that turn a model's answer into the
 * chips a person may see.
 *
 * There are three steps, kept separate on purpose: `parseSuggestionChips` reads
 * the answer shape, `selectChips` clips/de-duplicates/filters it against what was
 * already shown, and the truncation helpers bound the assistant tail and the
 * caller's focus/seed. Nothing here touches settings files, the network, the
 * ledger or any mutable module state, so every function is safe to call twice and
 * easy to drive from a criterion.
 *
 * Consumers: `reply-suggestions.service.ts` (the draw path) and the service
 * criterion in `tests/reply-suggestions-service.test.ts`.
 */
import { ReplySuggestionsClientError } from './reply-suggestions-client.js';

/** The character-set overlap at or above which a chip is "the same suggestion, reworded". */
const REPLY_SUGGESTIONS_NEAR_DUPLICATE_OVERLAP = 0.7;

/**
 * Separator marks the prompt asks the model to put between answers to several
 * points. At the END of a chip they are noise: a chip is a complete reply, and a
 * trailing `；` reads as an unfinished sentence. Only these marks are stripped —
 * sentence endings (`。？！`) and closing brackets/quotes are part of the text.
 */
const TRAILING_SEPARATOR_MARKS = /[；;，,、]+$/u;

/** Truncate by code point, so a surrogate pair is never cut in half. */
export function truncateCodePoints(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : characters.slice(0, maximum).join('');
}

/** The last `maximum` code points of `text`. */
export function tailCodePoints(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : characters.slice(-maximum).join('');
}

/** Drops separator marks at the very end of a chip; idempotent and safe on empty strings. */
function stripTrailingSeparatorMarks(text: string): string {
  return text.replace(TRAILING_SEPARATOR_MARKS, '').trimEnd();
}

/** The comparison form used by exact de-duplication. */
function normalizeForCompare(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** The character set (whitespace removed) used by the near-duplicate filter. */
function characterSet(text: string): Set<string> {
  return new Set([...text.replace(/\s+/g, '').toLocaleLowerCase()]);
}

/**
 * Jaccard overlap of two strings' character sets, in [0, 1].
 *
 * Consumers: `selectChips` below and the service criterion, which pins the
 * threshold's boundary with two hand-built strings.
 */
export function characterSetOverlap(left: string, right: string): number {
  const a = characterSet(left);
  const b = characterSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const character of a) {
    if (b.has(character)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Parse the model's answer into a raw chip list.
 *
 * Accepts `{"chips": [...]}`, a bare array and either wrapped in a ``` fence.
 * Every element must be a string; anything else refuses the WHOLE answer (it is
 * an upstream-shape failure, mapped to 502 by the caller). Trailing separator
 * marks are stripped here, before exact de-duplication in `selectChips`, so
 * `甲；` and `甲` are the same chip. A chip that was only separator marks becomes
 * empty and is dropped, never passed on as an empty string.
 */
export function parseSuggestionChips(text: string): string[] {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = fenced ? [fenced[1].trim(), trimmed] : [trimmed];

  let parsed: unknown;
  let parsedAt = -1;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parsedAt = candidates.indexOf(candidate);
      break;
    } catch {
      // Try the next spelling (raw text after a failed fenced parse, or vice versa).
    }
  }
  if (parsedAt === -1) {
    throw new ReplySuggestionsClientError('parse', 'the model did not answer with JSON');
  }

  let chips: unknown;
  if (Array.isArray(parsed)) {
    chips = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && 'chips' in parsed) {
    chips = (parsed as Record<string, unknown>).chips;
  } else {
    throw new ReplySuggestionsClientError('shape', 'the model answer was not an array or a {"chips": [...]} object');
  }

  if (!Array.isArray(chips)) {
    throw new ReplySuggestionsClientError('shape', 'the model answer\'s "chips" was not an array');
  }
  if (chips.some((chip) => typeof chip !== 'string')) {
    throw new ReplySuggestionsClientError('shape', 'the model answer contained a non-string chip');
  }
  return (chips as string[])
    .map((chip) => stripTrailingSeparatorMarks(chip.trim()))
    .filter((chip) => chip !== '');
}

/**
 * Clip, exact-deduplicate (after normalisation), filter near-duplicates against
 * the already-shown chips, and cap at `options.maxChips`.
 *
 * Consumers: `reply-suggestions.service.ts` only.
 */
export function selectChips(
  raw: readonly string[],
  shown: readonly string[],
  options: { maxChips: number; maxChipChars: number },
): string[] {
  const shownNormalized = shown.map(normalizeForCompare);
  const seen = new Set(shownNormalized);
  const selected: string[] = [];
  for (const chip of raw) {
    const clipped = truncateCodePoints(chip.trim(), options.maxChipChars).trim();
    if (clipped === '') continue;
    const normalized = normalizeForCompare(clipped);
    if (seen.has(normalized)) continue;
    const nearDuplicate = shownNormalized.some(
      (prior) => characterSetOverlap(normalized, prior) >= REPLY_SUGGESTIONS_NEAR_DUPLICATE_OVERLAP,
    );
    if (nearDuplicate) continue;
    selected.push(clipped);
    seen.add(normalized);
    if (selected.length >= options.maxChips) break;
  }
  return selected;
}
