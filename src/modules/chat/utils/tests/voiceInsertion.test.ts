import assert from 'node:assert/strict';

import { test } from 'vitest';

import { appendVoiceSegment, applyVoiceEdit, beginVoiceInsertion, voiceCommittedText } from '@/modules/chat/utils/voice/voiceInsertion';
import type { VoiceInsertion } from '@/modules/chat/utils/voice/voiceInsertion';

/**
 * The insertion range's properties, measured on a seeded generator rather than on hand-picked
 * examples.
 *
 * The feature's promise is a statement about *every* interleaving of dictation and editing, not
 * about a handful of them: committed voice text stays contiguous and in the order it was spoken,
 * and the text the user typed around it survives. The oracle below therefore keeps the draft split
 * into `prefix | committed | suffix` and re-derives it operation by operation; after each step the
 * module's state must match the oracle exactly — text, both endpoints, and the committed slice.
 *
 * A generator rather than a table because the interesting inputs are the ones nobody writes down:
 * deleting the character just before the range, typing at the caret, appending two segments with an
 * edit between them. Two hundred and forty seeded sequences cover those interleavings deterministically.
 */

/** mulberry32: a small, seedable PRNG, so a failing sequence can be replayed from its seed. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz ';

/** A word-shaped string, so committed text reads like speech rather than a random glyph run. */
function randomText(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

/** A non-empty segment: an empty one is specified as a no-op and exercises nothing here. */
function randomSegment(rng: () => number): string {
  return randomText(rng, 6) || 'x';
}

/** The oracle: the draft's three parts, kept apart so the committed text can be read directly. */
type Oracle = { prefix: string; committed: string; suffix: string };

function oracleText(o: Oracle): string {
  return o.prefix + o.committed + o.suffix;
}

/** Applies one edit inside `part` and returns the updated part. */
function editPart(part: string, rng: () => number): string {
  const from = Math.floor(rng() * (part.length + 1));
  const to = from + Math.floor(rng() * (part.length - from + 1));
  const inserted = randomText(rng, 4);
  return part.slice(0, from) + inserted + part.slice(to);
}

function assertMatches(state: VoiceInsertion, oracle: Oracle, note: string): void {
  const expectedText = oracleText(oracle);
  const expectedStart = oracle.prefix.length;
  const expectedEnd = oracle.prefix.length + oracle.committed.length;
  assert.equal(state.text, expectedText, `${note}: the draft drifted from the oracle`);
  assert.equal(state.start, expectedStart, `${note}: the range's start drifted`);
  assert.equal(state.end, expectedEnd, `${note}: the range's end drifted`);
  assert.equal(
    voiceCommittedText(state),
    oracle.committed,
    `${note}: the committed voice text is not the segments in spoken order`,
  );
  assert.ok(state.start >= 0 && state.end <= state.text.length, `${note}: the range left the draft`);
}

test('committed voice text stays contiguous and in order across 240 random edit sequences', () => {
  const SEQUENCES = 240;
  const STEPS = 10;

  for (let seed = 1; seed <= SEQUENCES; seed += 1) {
    const rng = makeRng(seed * 2654435761);

    // Open a range at a caret somewhere inside a non-empty starting draft.
    const seedText = randomText(rng, 24) || 'draft';
    const cursor = Math.floor(rng() * (seedText.length + 1));
    const oracle: Oracle = { prefix: seedText.slice(0, cursor), committed: '', suffix: seedText.slice(cursor) };
    let state = beginVoiceInsertion(seedText, cursor);
    assertMatches(state, oracle, `seed ${seed} open`);

    // Commit a first segment before the random loop, so the range is never empty again: with a
    // zero-width range there is no fact of the matter about whether a keystroke at the caret went
    // before or after it, and every step below would then be testing a convention rather than the
    // feature. Every real listen commits at least this one segment before anything else can happen.
    const seedSegment = randomSegment(rng);
    oracle.committed += seedSegment;
    state = appendVoiceSegment(state, seedSegment);
    assertMatches(state, oracle, `seed ${seed} first segment`);

    for (let step = 0; step < STEPS; step += 1) {
      const roll = rng();
      if (roll < 0.45) {
        // Commit another segment while listening.
        const segment = randomSegment(rng);
        oracle.committed += segment;
        state = appendVoiceSegment(state, segment);
        assertMatches(state, oracle, `seed ${seed} step ${step} append`);
      } else if (roll < 0.72) {
        // The user edits *before* the committed range: the range shifts to follow the text.
        const before = oracle.prefix;
        oracle.prefix = editPart(before, rng);
        state = mirrorPrefixEdit(state, before, oracle.prefix);
        assertMatches(state, oracle, `seed ${seed} step ${step} prefix edit`);
      } else {
        // The user edits *after* the committed range: it must not move.
        const before = oracle.suffix;
        oracle.suffix = editPart(before, rng);
        state = mirrorSuffixEdit(state, oracle, before);
        assertMatches(state, oracle, `seed ${seed} step ${step} suffix edit`);
      }
    }
  }
});

test('edits the user makes outside the range are preserved verbatim', () => {
  let state = beginVoiceInsertion('hello world', 5); // caret after "hello"
  const committed: string[] = [];
  for (const segment of ['one', 'two', 'three']) {
    committed.push(segment);
    state = appendVoiceSegment(state, segment);
  }
  const beforeEdit = state.text;
  assert.equal(voiceCommittedText(state), committed.join(''), 'the segments are contiguous, in order');

  // Type two characters into the leading "hello".
  const from = 1;
  const to = 3;
  const inserted = 'XY';
  const afterPrefix = `${beforeEdit.slice(0, from)}${inserted}${beforeEdit.slice(to)}`;
  state = applyVoiceEdit(state, from, to, inserted);
  assert.equal(state.text, afterPrefix, 'the prefix edit landed in the draft');
  assert.equal(voiceCommittedText(state), committed.join(''), 'a prefix edit must not disturb the committed text');

  // Append into the trailing " world" and check the committed text still does not move.
  const suffixAt = state.text.length;
  state = applyVoiceEdit(state, suffixAt, suffixAt, '!');
  assert.equal(voiceCommittedText(state), committed.join(''), 'a suffix edit must not disturb the committed text');
  assert.ok(state.text.endsWith('!'), 'the suffix edit is preserved');
});

test('an edit that deletes across the committed range leaves a well-formed interval', () => {
  let state = beginVoiceInsertion('abcdef', 1);
  state = appendVoiceSegment(state, 'XYZ'); // "aXYZbcdef", range [1,4)
  state = applyVoiceEdit(state, 0, 5, 'Q'); // replaces "aXYZb" with "Q"
  assert.ok(state.start >= 0 && state.end <= state.text.length && state.start <= state.end);
  assert.equal(state.text, 'Qcdef');
  // The surviving "cdef" keeps its place: the range now begins at the replacement.
  assert.equal(state.start, 1);
});

/**
 * Applies to the module the same replaced span that turned `before` into `after`, for an edit that
 * happened inside the range's prefix.
 *
 * The span is recovered from the two strings the oracle already holds (the longest common prefix and
 * suffix), which keeps the generator from having to thread the raw edit back out of `editPart`.
 */
function mirrorPrefixEdit(state: VoiceInsertion, before: string, after: string): VoiceInsertion {
  const { from, to, inserted } = diff(before, after);
  return applyVoiceEdit(state, from, to, inserted);
}

/** The same, for an edit inside the suffix: its absolute span is offset by the range's end. */
function mirrorSuffixEdit(state: VoiceInsertion, oracle: Oracle, before: string): VoiceInsertion {
  const { from, to, inserted } = diff(before, oracle.suffix);
  const base = oracle.prefix.length + oracle.committed.length;
  return applyVoiceEdit(state, base + from, base + to, inserted);
}

/** The single-span edit that turns `before` into `after`, via the longest common prefix and suffix. */
function diff(before: string, after: string): { from: number; to: number; inserted: string } {
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
