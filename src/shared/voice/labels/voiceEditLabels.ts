/**
 * The weak labels a dictated sentence leaves behind when the user edits it before sending.
 *
 * WHY THIS EXISTS. A user who corrects the recogniser's words in the composer has already told us
 * both halves of a training pair — what was heard, and what they meant — and they told us for free,
 * without being shown an interface for it. This module turns that edit into `heard → final` pairs:
 * for each segment of speech the listen committed, it finds the region of the final text that
 * segment became and reports what changed between them.
 *
 * IT IS A PURE MODULE, and that is what lets the rule below be judged without a browser, a
 * microphone or a clock: `labelsFor` takes the segments and the final text and returns the labels.
 * Nothing here reads a store, a config or a socket.
 *
 * THE TWO SIDES OF AN EDIT. A `replace`/`merge`/`split`/`delete` is a CORRECTION — a small, local
 * repair of what was heard. Anything past the budget below is a `rewrite`: the user did not correct
 * the recogniser, they said something else, and a `heard → final` pair built from it would teach the
 * wrong thing. Rewrites are still EMITTED — a reader can see that the region was touched — but they
 * are marked, and a consumer that learns from corrections must skip them. The boundary between the
 * two is the one judgement in this file, and `src/shared/tests/voiceEditLabels.test.ts` runs a
 * falsifying variant of this module with that boundary deleted, case ⑥ of the acceptance criteria
 * going red on it, so "rewrite" is a claim the test can lose rather than a word in a comment.
 *
 * THE SHAPE RULE IS SHARED WITH THE OFFLINE EXPERIMENT. `isIdentifierShaped` is a port of `is_id`
 * from `experiments/voice-index-loop/sim/extract.py`, and it is exported because the two must agree:
 * a token the offline index calls an identifier and one this module calls an identifier have to be
 * the same token, or a label collected here would be scored against a vocabulary that was built from
 * a different reading of the same text. The acceptance criteria pin a known-answer table over the
 * two implementations precisely so a drift between them is a red test and not a silent one.
 *
 * THE ALIGNMENT IS A PORT OF `experiments/voice-index-loop/sim/lib.mjs`. `alignRegion` and
 * `widenToWords` are the same algorithms the offline loop uses to map a gold span onto recognised
 * text, kept here so that "which part of the final text did this segment become" has one answer.
 */

/**
 * The five things an edited region can be.
 *
 * The first four are corrections — the user repaired what was heard, and the pair is worth keeping.
 * `rewrite` is the odd one out: it records that the region was touched, but says the pair is NOT a
 * correction and must not be read as one.
 */
export type VoiceEditOp = 'replace' | 'merge' | 'split' | 'delete' | 'rewrite';

/**
 * One segment of speech as it reached the composer.
 *
 * `text` is the piece of the box this segment contributed — the text the listen committed, not the
 * segment's raw recogniser output, so a seam that was deduplicated between two segments is
 * deduplicated here too. `index` is the segment's ordinal in the listen, which is what ties a label
 * back to the audio in the voice-data record.
 */
export type VoiceSourceSegment = {
  index: number;
  text: string;
};

/**
 * One `heard → final` pair, and the kind of change that produced it.
 *
 * `heard` is the recogniser's words and `final` is what the user left in the box, both taken to
 * whole tokens: a change in the middle of a word is reported as the whole word on each side, because
 * the pair is meant to be read by a person and replayed by an index, and neither wants a fragment.
 */
export type VoiceEditLabel = {
  /** The ordinal of the segment this pair came from, as given in `VoiceSourceSegment.index`. */
  segmentIndex: number;
  /** What was heard, spanning one or more whole tokens. */
  heard: string;
  /** What the user left in the box, spanning one or more whole tokens. Empty for a deletion. */
  final: string;
  op: VoiceEditOp;
};

/**
 * The most LATIN tokens a change may touch on EITHER side and still read as a correction.
 *
 * Three, because a correction is a repair of what was heard and repairs are short: a recogniser
 * mangles a word, drops a word, or runs two together. A change that reaches past three tokens is
 * not a repair of the same words, it is a different sentence.
 */
const MAX_CORRECTION_TOKENS = 3;

/**
 * The most HAN characters a change may touch on EITHER side and still read as a correction.
 *
 * A SEPARATE budget, because a Han character is not a word. A sentence of Han carries no spaces, so
 * cutting it per character (see `tokenize`) turns one mistaken character into one token — but it
 * also turns `AC 零零二` into four. The Latin budget of three would call that a rewrite, and it is
 * the canonical correction this module exists to keep. Six characters is room for a small repair
 * (`了功启` → `重启`, four characters heard) while a whole rewritten sentence is far past it and
 * lands on `rewrite`, which is the judgement the acceptance criteria pin from both sides.
 */
const MAX_CORRECTION_HAN_TOKENS = 6;

/**
 * The most tokens a short change may touch on either side and still be read WITH context.
 *
 * A one-or-two character Han repair is unreadable on its own (`功` → `重`), so its label carries one
 * neighbouring token on each side (`查了功启` → `查重启`) — see `withHanContext`. Only SHORT changes
 * are widened: a longer change is already readable, and widening it would push a near-budget
 * correction over `MAX_CORRECTION_HAN_TOKENS` and mislabel it a rewrite.
 */
const MAX_CONTEXT_TOKENS = 2;

/**
 * The largest character edit ratio a correction may carry, over the joined comparable forms.
 *
 * A token-count budget alone lets three words become three unrelated ones; a character budget alone
 * lets a long word become a long unrelated one. Both are applied. The ratio is the Levenshtein
 * distance over the COMBINED length of the two forms — normalising by the longer side alone would
 * call `key` → `quay` (three substitutions over four characters) a rewrite, when it is the
 * canonical correction this whole module exists to capture.
 */
const MAX_CORRECTION_EDIT_RATIO = 0.5;

/**
 * The characters that separate tokens for COMPARISON while never being part of a token.
 *
 * This is `heardKey`'s class from the offline simulation: whitespace and the punctuation a
 * recogniser or a keyboard emits, including the hyphen and the underscore. It is what makes
 * `quay fleet` and `quay-fleet` the same thing when the question is "did the words change" —
 * the difference between them is a joiner, not a word, which is exactly the `merge` case.
 */
const JOINING_PUNCTUATION = /[\s，。、：；！？（）“”‘’,.;:!?()"'`\-_]/g;

/** A trailing `.ext` — the mark that makes a token a FILE NAME rather than an identifier. */
const FILE_SUFFIX = /\.\w{1,4}$/;

/** The marks that make a token identifier-shaped: a camel boundary, a joiner, or a digit. */
const IDENTIFIER_MARK = /[a-z][A-Z]|[-_]|\d/;

/** A character a Latin word is made of. */
const WORD_CHAR = /[A-Za-z0-9]/;

/** A character that joins two Latin runs into ONE token when the result is an identifier. */
const IDENTIFIER_JOINER = /[-_]/;

/**
 * A Han character — a CJK unified ideograph, its extension A, or its compatibility block.
 *
 * Han is cut PER CHARACTER (see `tokenize`): a sentence of Han has no spaces, so the whitespace-only
 * rule made it one token and every Han edit a whole-sentence `replace`. `Intl.Segmenter('zh')` is
 * NOT used: measured against this very fixture it cuts a mistaken `功启` the same way it cuts a
 * correct `重启`, so it cannot tell a mended word from a mangled one — the characters are tokens and
 * the alignment is what decides.
 */
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

/** Whether a single character is Han. */
function isHanChar(char: string): boolean {
  return HAN.test(char);
}

/**
 * Whether a token is Han — made only of Han characters, with joining punctuation around it ignored.
 *
 * Punctuation is not a script, so a Han run that carries a full stop (`记录。`) is still Han; a token
 * with any Latin word character in it is not.
 */
function isHanToken(token: string): boolean {
  const core = token.replace(JOINING_PUNCTUATION, '');
  return core.length > 0 && [...core].every(isHanChar);
}

/**
 * Whether a token has the shape of an identifier rather than of an ordinary word.
 *
 * A port of `is_id` in `experiments/voice-index-loop/sim/extract.py`, kept character-for-character
 * in behaviour so the two agree on every token: a token is identifier-shaped when it is at least two
 * characters, is neither a path (it contains `/`) nor a file name (it ends in a `.ext`), and carries
 * a camel/Pascal boundary, a `-`/`_`, a digit, or is an all-caps run.
 *
 * EXPORTED FOR THE OFFLINE INDEX. `experiments/voice-index-loop/sim/` derives its entity vocabulary
 * from identifier-shaped tokens; a label written by this module is compared against that vocabulary,
 * so the two readers have to be one rule. `src/shared/tests/voiceEditLabels.test.ts` pins the
 * agreement with a known-answer table over both implementations.
 */
export function isIdentifierShaped(token: string): boolean {
  if (token.length < 2 || token.includes('/') || FILE_SUFFIX.test(token)) {
    return false;
  }
  if (IDENTIFIER_MARK.test(token)) {
    return true;
  }
  // `str.isupper()`: at least one cased character, and none of them lowercase. Written as the two
  // character tests rather than a code-point loop because that is the whole of the predicate here.
  return /[A-Z]/.test(token) && !/[a-z]/.test(token);
}

/** A half-open `[start, end)` range of a string. */
type Span = { start: number; end: number };

/**
 * `text` with its whitespace removed, lowercased, and each kept character's coordinate retained.
 *
 * The coordinates are the point: the alignment runs over the stripped strings — a recogniser's
 * spacing is not what is being compared — and every answer has to be translated back into offsets
 * of the ORIGINAL string, because that is what a slice of the final text needs.
 */
function stripped(text: string): { value: string; at: number[] } {
  let value = '';
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    // Whitespace AND joining punctuation are dropped, so the alignment is over the COMPARABLE forms:
    // `？` → `?` and a sentence-final `。` are not characters a span can be mapped to, which keeps
    // them from stretching a region past the last word the segment actually became.
    if (text[index].replace(JOINING_PUNCTUATION, '') === '') {
      continue;
    }
    value += text[index].toLowerCase();
    at.push(index);
  }
  return { value, at };
}

/**
 * Maps the span `[from, to)` of `gold` onto `text` through a character-level alignment.
 *
 * A port of `alignRegion` in `experiments/voice-index-loop/sim/lib.mjs`. The two strings are
 * stripped, aligned by Levenshtein distance, and the gold span's characters are carried across by
 * the alignment's own gold-index-to-text-index map: the span becomes the smallest region of `text`
 * covering every character the span's characters were matched to or substituted with. A character
 * with no counterpart (deleted) contributes nothing, and a span whose characters ALL vanished still
 * yields the gap they left — the position between the neighbours that survived — unless there were
 * no neighbours to bound it, in which case there is no region and the answer is `null`.
 *
 * The region is then widened to the gap between the nearest surviving characters on either side, so
 * a span that maps to nothing does not collapse to a zero-width region in the middle of a word.
 *
 * IT DOES NOT REACH FOR THE ENDS OF THE TEXT. The nearest surviving characters bound the region only
 * when they EXIST; with no neighbour on a side, the region stops at the characters this span itself
 * was aligned to. The earlier rule took a sentinel there (`-1` / `textLength`) and widened to it,
 * which dragged the region to the start or the end of the whole box and swallowed the user's own
 * typing, or another dictation, into this segment's `final`. A span whose characters all vanished is
 * bounded by the gap between the neighbours that DID survive, and when there is no such pair there
 * is no region to speak of — the caller records a deletion instead.
 */
function alignRegion(gold: string, text: string, from: number, to: number): Span | null {
  const goldStripped = stripped(gold);
  const textStripped = stripped(text);
  const goldLength = goldStripped.value.length;
  const textLength = textStripped.value.length;

  const distance: number[][] = [];
  for (let row = 0; row <= goldLength; row += 1) {
    distance.push(new Array<number>(textLength + 1).fill(0));
    distance[row][0] = row;
  }
  for (let column = 0; column <= textLength; column += 1) {
    distance[0][column] = column;
  }
  for (let row = 1; row <= goldLength; row += 1) {
    for (let column = 1; column <= textLength; column += 1) {
      const substitution = goldStripped.value[row - 1] === textStripped.value[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitution,
      );
    }
  }

  // The backtrace, as a gold-index-to-text-index map with -1 wherever a gold character was deleted.
  const mapping = new Array<number>(goldLength).fill(-1);
  let row = goldLength;
  let column = textLength;
  while (row > 0 && column > 0) {
    const substitution = goldStripped.value[row - 1] === textStripped.value[column - 1] ? 0 : 1;
    if (distance[row][column] === distance[row - 1][column - 1] + substitution) {
      mapping[row - 1] = column - 1;
      row -= 1;
      column -= 1;
    } else if (distance[row][column] === distance[row - 1][column] + 1) {
      mapping[row - 1] = -1;
      row -= 1;
    } else {
      column -= 1;
    }
  }

  const first = goldStripped.at.findIndex((coordinate) => coordinate >= from);
  let last = -1;
  goldStripped.at.forEach((coordinate, index) => {
    if (coordinate < to) {
      last = index;
    }
  });
  if (first < 0 || last < first) {
    return null;
  }

  // ---- REGION SHRINK (the negative control behind the test file swaps this block for the
  // endpoint-expanding one, so the two live as one source and cannot drift) ----
  const mapped = mapping.slice(first, last + 1).filter((index) => index >= 0);
  let low: number;
  let high: number;
  if (mapped.length > 0) {
    // The smallest region covering every character of the span that survived. It stops here: the
    // unmatched characters around it belong to whatever came before or after, not to this span.
    low = Math.min(...mapped);
    high = Math.max(...mapped);
  } else {
    // Every character of the span is gone. The region is the gap the surviving neighbours leave —
    // and only when there IS a neighbour on BOTH sides, so the gap cannot run off to the text ends.
    const survivingBefore = mapping.slice(0, first).reverse().find((index) => index >= 0);
    const survivingAfter = mapping.slice(last + 1).find((index) => index >= 0);
    if (survivingBefore === undefined || survivingAfter === undefined) {
      return null;
    }
    low = survivingBefore + 1;
    high = survivingAfter - 1;
  }
  if (high < low) {
    return null;
  }
  return { start: textStripped.at[low], end: textStripped.at[high] + 1 };
  // ---- end region shrink ----
}

/**
 * Widens a region to the whole tokens it sits inside.
 *
 * A port of `widenToWords` in `experiments/voice-index-loop/sim/lib.mjs`, with the identifier rule
 * applied to the joining. A Latin word is grown across word characters on both sides; a `-` or `_`
 * is crossed only when the run it would join is IDENTIFIER-SHAPED (see `isIdentifierShaped`), so
 * `quay-fleet` stays one token while a region that stopped inside a file name such as
 * `voice-routes.ts` is not glued to the name it merely looks like part of.
 */
function widenToWords(text: string, span: Span): Span {
  const isWord = (at: number): boolean => at >= 0 && at < text.length && WORD_CHAR.test(text[at]);
  const isJoiner = (at: number): boolean => at >= 0 && at < text.length && IDENTIFIER_JOINER.test(text[at]);

  const grow = (crossJoiners: boolean): Span => {
    let { start, end } = span;
    for (;;) {
      if (isWord(end) && isWord(end - 1)) {
        end += 1;
        continue;
      }
      if (crossJoiners && isJoiner(end) && isWord(end - 1) && isWord(end + 1)) {
        end += 2;
        continue;
      }
      break;
    }
    for (;;) {
      if (isWord(start - 1) && isWord(start)) {
        start -= 1;
        continue;
      }
      if (crossJoiners && isJoiner(start - 1) && isWord(start - 2) && isWord(start)) {
        start -= 2;
        continue;
      }
      break;
    }
    return { start, end };
  };

  const joined = grow(true);
  return isIdentifierShaped(text.slice(joined.start, joined.end)) ? joined : grow(false);
}

/** The comparable form of a token run: joined punctuation gone, lowercased. See `JOINING_PUNCTUATION`. */
function comparable(text: string): string {
  return text.replace(JOINING_PUNCTUATION, '').toLowerCase();
}

/** Whether two tokens are the SAME token for the purpose of the diff. */
function sameToken(left: string, right: string): boolean {
  const comparableLeft = comparable(left);
  return comparableLeft !== '' && comparableLeft === comparable(right);
}

/**
 * The character edit ratio between two comparable forms: Levenshtein distance over their combined
 * length. Used only as the correction budget's second gate (see `MAX_CORRECTION_EDIT_RATIO`).
 */
function editRatio(left: string, right: string): number {
  const span = left.length + right.length;
  if (span === 0) {
    return 0;
  }
  const distance: number[][] = [];
  for (let row = 0; row <= left.length; row += 1) {
    distance.push(new Array<number>(right.length + 1).fill(0));
    distance[row][0] = row;
  }
  for (let column = 0; column <= right.length; column += 1) {
    distance[0][column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitution,
      );
    }
  }
  return distance[left.length][right.length] / span;
}

/** One token of a text, with the half-open range it occupies in that text. */
type Token = { text: string; start: number; end: number };

/**
 * One changed run: the tokens that were heard and the tokens that replaced them, and where each run
 * sits in its own token list (the indices are what `withHanContext` reaches past for context).
 */
type Hunk = {
  heard: Token[];
  final: Token[];
  heardFrom: number;
  heardTo: number;
  finalFrom: number;
  finalTo: number;
};

/**
 * The maximal runs of changed tokens between two token lists, via a token-level alignment.
 *
 * UNCHANGED TOKENS ARE THE FENCES. Two tokens are the same token when their comparable forms are
 * equal (`sameToken`), and every step of the alignment that pairs two of those closes the run before
 * it and opens the next one after it. What is left between the fences is exactly what changed, which
 * is what makes one label per edit rather than one label per sentence: the pinned case ⑦ (two
 * separate segments, each with its own edit) and case ① (`key` → `quay` inside an otherwise
 * untouched sentence) are the same rule answering twice.
 *
 * THE REGION IS WHAT EXCLUDES THE USER'S OTHER TEXT. A run that heard nothing is text with no
 * counterpart in the segment — typing before or after the dictation (case ⑤) or another dictation in
 * the same box (case ②) — and it cannot reach this function at all, because the text diffed against
 * is only the characters THIS segment was aligned to (see `alignRegion`). So a run that heard nothing
 * is not filtered out here; it is never produced. The control that widens the region back to the text
 * ends is what makes case ② red, which is why the two are one mechanism and not two.
 */
function changedHunks(heardTokens: readonly Token[], finalTokens: readonly Token[]): Hunk[] {
  const heardLength = heardTokens.length;
  const finalLength = finalTokens.length;

  const distance: number[][] = [];
  for (let row = 0; row <= heardLength; row += 1) {
    distance.push(new Array<number>(finalLength + 1).fill(0));
    distance[row][0] = row;
  }
  for (let column = 0; column <= finalLength; column += 1) {
    distance[0][column] = column;
  }
  for (let row = 1; row <= heardLength; row += 1) {
    for (let column = 1; column <= finalLength; column += 1) {
      const substitution = sameToken(heardTokens[row - 1].text, finalTokens[column - 1].text) ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitution,
      );
    }
  }

  // Walked back from the end, so the steps come out reversed and are flipped before grouping.
  const steps: {
    heard: Token | null;
    final: Token | null;
    heardAt: number | null;
    finalAt: number | null;
  }[] = [];
  let row = heardLength;
  let column = finalLength;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0) {
      const substitution = sameToken(heardTokens[row - 1].text, finalTokens[column - 1].text) ? 0 : 1;
      if (distance[row][column] === distance[row - 1][column - 1] + substitution) {
        steps.push({
          heard: heardTokens[row - 1],
          final: finalTokens[column - 1],
          heardAt: row - 1,
          finalAt: column - 1,
        });
        row -= 1;
        column -= 1;
        continue;
      }
    }
    if (row > 0 && distance[row][column] === distance[row - 1][column] + 1) {
      steps.push({ heard: heardTokens[row - 1], final: null, heardAt: row - 1, finalAt: null });
      row -= 1;
      continue;
    }
    steps.push({ heard: null, final: finalTokens[column - 1], heardAt: null, finalAt: column - 1 });
    column -= 1;
  }
  steps.reverse();

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const step of steps) {
    const unchanged = step.heard !== null && step.final !== null
      && sameToken(step.heard.text, step.final.text);
    if (unchanged) {
      current = null;
      continue;
    }
    // A run is opened at its first changed step and closed by the fence above; the object is pushed
    // ONCE and then grown in place, so consecutive changed tokens stay one hunk rather than one each.
    if (current === null) {
      current = { heard: [], final: [], heardFrom: -1, heardTo: -1, finalFrom: -1, finalTo: -1 };
      hunks.push(current);
    }
    if (step.heard !== null) {
      current.heard.push(step.heard);
      if (current.heardFrom < 0) {
        current.heardFrom = step.heardAt as number;
      }
      current.heardTo = step.heardAt as number;
    }
    if (step.final !== null) {
      current.final.push(step.final);
      if (current.finalFrom < 0) {
        current.finalFrom = step.finalAt as number;
      }
      current.finalTo = step.finalAt as number;
    }
  }
  // No filter: a run that heard nothing is not a correction, but it is only ever produced when the
  // region itself is wrong (see the function comment), so the region is where that is enforced.
  return hunks;
}

/**
 * Grows a SHORT all-Han hunk by one neighbouring token on each side.
 *
 * A one- or two-character Han repair does not read on its own: `功` → `重` says nothing about the
 * word it sits in. The neighbours are the context — `查了功启` → `查重启` — and they are the SAME
 * tokens on both sides (a fence the hunk was cut at), so including them cannot invent a difference.
 * Only Han hunks are widened, and only short ones: a Latin `key` → `quay` is a whole word already,
 * and widening a longer Han change could push a near-budget correction past
 * `MAX_CORRECTION_HAN_TOKENS`. The widened tokens are what the label reports AND what its op is
 * judged on, so the pair a reader sees is the pair the budget weighed.
 */
function withHanContext(
  hunk: Hunk,
  heardTokens: readonly Token[],
  finalTokens: readonly Token[],
): { heard: Token[]; final: Token[] } {
  const allHan = [...hunk.heard, ...hunk.final].every((token) => isHanToken(token.text));
  const shortChange = hunk.heard.length <= MAX_CONTEXT_TOKENS
    && hunk.final.length <= MAX_CONTEXT_TOKENS;
  if (!allHan || !shortChange) {
    return { heard: hunk.heard, final: hunk.final };
  }
  const heardLow = Math.max(0, hunk.heardFrom - 1);
  const heardHigh = Math.min(heardTokens.length, hunk.heardTo + 2);
  const finalLow = Math.max(0, hunk.finalFrom - 1);
  const finalHigh = Math.min(finalTokens.length, hunk.finalTo + 2);
  return {
    heard: heardTokens.slice(heardLow, heardHigh),
    final: finalTokens.slice(finalLow, finalHigh),
  };
}

/** The source text a run of tokens spans, taken whole from the first token's start to the last's end. */
function textOf(source: string, tokens: readonly Token[]): string {
  if (tokens.length === 0) {
    return '';
  }
  return source.slice(tokens[0].start, tokens[tokens.length - 1].end);
}

/**
 * The shape of a change, read off how the token counts moved.
 *
 * This is the "everything is a correction" reading of an edit — the answer to "WHAT KIND of change
 * is this", with no opinion about whether it is small enough to believe. `opFor` is what adds that
 * opinion, and the two are separate functions so the boundary between them is one removable call
 * rather than a condition woven through the shape rule.
 *
 * A changed token count is NOT on its own a merge or a split. `AC 零零二` → `AC-002` goes from two
 * tokens to one, and it is a `replace`: the words themselves changed, and the breathing room the
 * recogniser put between them is incidental. What makes `quay fleet` → `quay-fleet` a `merge` is
 * that the comparable forms are EQUAL — the same characters, re-joined — so the change is a
 * regrouping of the words and not a change of them. A count difference with unequal forms is a
 * replacement that happened to move the count, and it is reported as one.
 */
function correctionShape(heardWords: readonly string[], finalWords: readonly string[]): VoiceEditOp {
  if (finalWords.length === 0) {
    return 'delete';
  }
  if (heardWords.length === finalWords.length) {
    return 'replace';
  }
  if (comparable(heardWords.join(' ')) === comparable(finalWords.join(' '))) {
    return heardWords.length > finalWords.length ? 'merge' : 'split';
  }
  return 'replace';
}

/**
 * Whether a change is small enough to be a correction rather than a rewrite.
 *
 * THE ONE JUDGEMENT IN THIS FILE. The budget is SPLIT BY SCRIPT, because a token is a different size
 * in each: a Latin token is a whole word (`restart`), a Han token is a single character (`重`), and
 * one number for both would either forbid a two-character Han repair or admit a four-word rewrite.
 * So each side gets `MAX_CORRECTION_TOKENS` Latin tokens and `MAX_CORRECTION_HAN_TOKENS` Han
 * characters, and the character budget (`MAX_CORRECTION_EDIT_RATIO`) is the second, script-blind
 * gate. A deletion is exempt from the character budget because it has no counterpart to compare —
 * the ratio against an empty string is 1.0 for any word, which would call every deletion a rewrite.
 *
 * The falsifying variant behind `src/shared/tests/voiceEditLabels.test.ts` deletes the call to this
 * function and its guard from `opFor`, and case ⑥ — a whole-sentence rewrite — goes red on it.
 */
function withinCorrectionBudget(
  heardTokens: readonly Token[],
  finalTokens: readonly Token[],
): boolean {
  const hanTokens = (tokens: readonly Token[]): number =>
    tokens.filter((token) => isHanToken(token.text)).length;
  const heardHan = hanTokens(heardTokens);
  const finalHan = hanTokens(finalTokens);
  const heardLatin = heardTokens.length - heardHan;
  const finalLatin = finalTokens.length - finalHan;
  if (heardLatin > MAX_CORRECTION_TOKENS || finalLatin > MAX_CORRECTION_TOKENS) {
    return false;
  }
  if (heardHan > MAX_CORRECTION_HAN_TOKENS || finalHan > MAX_CORRECTION_HAN_TOKENS) {
    return false;
  }
  if (finalTokens.length === 0) {
    return true;
  }
  // A change whose two sides are BOTH Han is already measured in characters — one Han token is one
  // character — so the Han budget above IS its character budget, and the ratio gate (which exists to
  // catch what a per-WORD budget hides) has nothing left to add. The gate still applies the moment a
  // Latin token is on either side, which is where it earns its place.
  if (heardHan === heardTokens.length && finalHan === finalTokens.length) {
    return true;
  }
  return editRatio(comparable(runText(heardTokens)), comparable(runText(finalTokens)))
    <= MAX_CORRECTION_EDIT_RATIO;
}

/** The op one hunk carries: its shape, unless the change is too large to be a correction at all. */
function opFor(heardTokens: readonly Token[], finalTokens: readonly Token[]): VoiceEditOp {
  const shape = correctionShape(
    heardTokens.map((token) => token.text),
    finalTokens.map((token) => token.text),
  );
  // ---- THE CORRECTION / REWRITE BOUNDARY (the falsifying variant removes this block) ----
  if (!withinCorrectionBudget(heardTokens, finalTokens)) {
    return 'rewrite';
  }
  // ---- end boundary ----
  return shape;
}

/** The text a token run covers, in the box's own spacing — not a re-join, so `AC 零零二` keeps its space. */
function runText(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join(' ');
}

const LATIN_TOKEN = /[A-Za-z0-9]/;
const LATIN_JOINER = /[-_./]/;

/**
 * Splits a text into tokens, each carrying where it sits in the text.
 *
 * A HAN CHARACTER IS ITS OWN TOKEN. Han is written without spaces, so a word is one or more
 * characters and there is no whitespace to cut on; the per-character reading is what lets a
 * one-character repair be a correction of that character rather than of the whole run it sits in.
 * Latin runs stay whole, and an internal `-`, `_`, `.` or `/` stays inside the run
 * (`quay-fleet` and `voice-routes.ts` are one token each — the same reading `widenToWords` gives
 * them). A run of punctuation is a token of its own so the diff can see it move, but a token whose
 * comparable form is empty is dropped: punctuation on its own is never the thing a user corrected,
 * so `？` → `?` is not an edit anybody made.
 */
function tokenize(text: string): Token[] {
  // ---- HAN TOKENIZATION (the negative control behind the test file swaps this block for a
  // whitespace split, so the two live as one source and cannot drift) ----
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (isHanChar(char)) {
      tokens.push({ text: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (LATIN_TOKEN.test(char)) {
      let end = index + 1;
      while (
        end < text.length
        && (LATIN_TOKEN.test(text[end])
          || (LATIN_JOINER.test(text[end]) && LATIN_TOKEN.test(text[end + 1] ?? '')))
      ) {
        end += 1;
      }
      tokens.push({ text: text.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    let end = index + 1;
    while (end < text.length && !isHanChar(text[end]) && !LATIN_TOKEN.test(text[end])) {
      end += 1;
    }
    const run = text.slice(index, end);
    if (!/^\s*$/.test(run)) {
      tokens.push({ text: run, start: index, end });
    }
    index = end;
  }
  return tokens.filter((token) => comparable(token.text) !== '');
  // ---- end Han tokenization ----
}

/**
 * The weak labels one send leaves behind: what each committed voice segment was heard as, and what
 * the user left in its place.
 *
 * The voice text is reassembled from the segments the way the composer assembled it — trimmed,
 * single-spaced, in index order — so that a span of the reassembly is a span of the box. Each
 * segment's span is then aligned onto `finalText`, widened to whole tokens, and diffed token by
 * token; every changed run becomes one label.
 *
 * A segment that was emptied, or whose region has no counterpart at all in the final text because
 * the user cleared the box, is reported as a `delete` against an empty `final` — the pair is still
 * worth recording, and it is the one place a label is emitted without an alignment to justify it.
 *
 * Returns `[]` when nothing changed, when there are no segments, and when a segment contributed no
 * words; the caller treats the empty list as "nothing to write back".
 */
export function labelsFor(
  segments: readonly VoiceSourceSegment[],
  finalText: string,
): VoiceEditLabel[] {
  // The voice text as it sits in the box, and where each contributing segment's span falls in it.
  const pieces: string[] = [];
  const spans: { segmentIndex: number; from: number; to: number }[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (text === '') {
      continue;
    }
    if (cursor > 0) {
      // The single space the composer puts between two segments. Counted before the span is taken
      // so the span indexes the reassembly rather than the piece.
      cursor += 1;
    }
    spans.push({ segmentIndex: segment.index, from: cursor, to: cursor + text.length });
    pieces.push(text);
    cursor += text.length;
  }
  if (spans.length === 0) {
    return [];
  }
  const heard = pieces.join(' ');

  const labels: VoiceEditLabel[] = [];
  for (const span of spans) {
    const heardText = heard.slice(span.from, span.to);
    if (finalText.trim() === '') {
      labels.push({ segmentIndex: span.segmentIndex, heard: heardText, final: '', op: 'delete' });
      continue;
    }
    const region = alignRegion(heard, finalText, span.from, span.to);
    if (region === null) {
      labels.push({ segmentIndex: span.segmentIndex, heard: heardText, final: '', op: 'delete' });
      continue;
    }
    const widened = widenToWords(finalText, region);
    const finalRegion = finalText.slice(widened.start, widened.end);
    const heardTokens = tokenize(heardText);
    const finalTokens = tokenize(finalRegion);
    for (const hunk of changedHunks(heardTokens, finalTokens)) {
      // The label reports the tokens AFTER Han context widening, and the op is judged on the same
      // pair — so a repair the reader can see is a repair the budget weighed (see `withHanContext`).
      const context = withHanContext(hunk, heardTokens, finalTokens);
      labels.push({
        segmentIndex: span.segmentIndex,
        heard: textOf(heardText, context.heard),
        final: textOf(finalRegion, context.final),
        op: opFor(context.heard, context.final),
      });
    }
  }
  return labels;
}
