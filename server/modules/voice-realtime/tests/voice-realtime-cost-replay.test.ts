/**
 * The segmented relay's cost line — SPEC `docs/proposals/voice-realtime-segmented-relay-SPEC.md`
 * §成本模型 (the formula) and §测试用异常线（D2）, GOAL-034 / AC-322.
 *
 * WHAT THIS FILE IS FOR. The relay's whole justification is that it stops paying for silence: the
 * upstream hears one short utterance per sentence instead of a continuous stream. This file replays the
 * SPEC's own model — 60 sentences, a pack of a given size, `r = 2` responses each — through the SHIPPING
 * estimator and asserts the D2 abnormal line, so a change that silently makes the relay expensive is a
 * red rather than a rising bill.
 *
 * WHY IT IS ANCHORED TO THE SPEC'S FORMULA, NOT TO A NUMBER. The D2 line is a FIXED plateau: `≤ ¥0.006`
 * per sentence and `≤ ¥0.45` for 69 sentences, both at the default 2,000-char pack. Asserting only those
 * two numbers would pass for any replay cheap enough, including one that stopped producing audio tokens
 * at all. So each case asserts THREE things:
 *
 *   1. the replay's total EQUALS the SPEC formula evaluated at that pack size (a real number, so the
 *      replay cannot drift away from the model it claims to replay);
 *   2. the replay's total is under the D2 ceiling, scaled by pack size — the SPEC's "阈值按上表线性
 *      缩放", written as a function of the pack rather than as two more literals that could go stale;
 *   3. at the DEFAULT pack the scaled ceiling IS the SPEC's `¥0.006` / `¥0.45` — so the scaling has not
 *      quietly moved the line at the one size the D2 table pins.
 *
 * WHAT THE REPLAY IS. `estimateRealtimeCostCny` is reached through the module barrel and fed the usage
 * SHAPE the endpoint returns (P0-S6 measured it): `input_tokens`, `output_tokens` and
 * `input_tokens_details.{text_tokens,audio_tokens}`. The replay is the sequence of those readings, not a
 * hand-totaled cost — which is the point: the number under the line is the estimator's own output.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-cost-replay.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateRealtimeCostCny } from '../index.js';

// ── the SPEC's model, as constants that name where each number comes from ─────────────────────

/** The instruction-and-tools text every response reads in, before the pack (SPEC §变量: ≈ 450). */
const BASE_INSTRUCTION_TOKENS = 450;
/** Characters per token for the pack (SPEC: 2,000 chars ≈ 1,000 tokens). */
const CHARS_PER_TOKEN = 2;
/** Responses per sentence: the relay, then the closing `OK` (SPEC §变量: r = 2). */
const RESPONSES_PER_SENTENCE = 2;
/** Spoken seconds per sentence, floored at 1 by the model's `max(1, a)` (SPEC: a = 3.0). */
const AUDIO_SECONDS_PER_SENTENCE = 3.0;
/** Audio tokens per spoken second (SPEC's formula carries `max(1,a)·7`). */
const AUDIO_TOKENS_PER_SECOND = 7;
/** Output tokens per sentence, split across its responses (SPEC: o = 36). */
const OUTPUT_TOKENS_PER_SENTENCE = 36;
/** Sentences in one replay. The D2 table's 69-per-hour line is this per-sentence cost × 69. */
const SENTENCES = 60;
/** The per-hour conversion the D2 table's last row uses. */
const SENTENCES_PER_HOUR = 69;
/** The pack size the D2 ceilings are quoted at, and the only size they are literals for. */
const DEFAULT_PACK_CHARS = 2000;

/** `PRICE_CNY_PER_1K` as the SPEC quotes it; asserted against the estimator below, not trusted. */
const PRICE_CNY_PER_1K = { textInput: 0.0015, audioInput: 0.006, textOutput: 0.0045 } as const;

/** The D2 abnormal line at the default pack — the plateau the scaled ceiling must meet there. */
const D2_LINE = { perSentenceCny: 0.006, perHourCny: 0.45 } as const;

/** The text tokens one response reads in: the instructions plus the pack (SPEC: T = 450 + pack). */
const textTokens = (packChars: number): number => BASE_INSTRUCTION_TOKENS + Math.round(packChars / CHARS_PER_TOKEN);

/** The audio tokens one response reads in: `max(1, a) · 7` (SPEC's middle term). */
const audioTokens = (): number => Math.max(1, AUDIO_SECONDS_PER_SENTENCE) * AUDIO_TOKENS_PER_SECOND;

/**
 * The SPEC's per-sentence cost, evaluated at `packChars` — the formula read literally:
 *
 *     r·T·0.0015/1000 + r·max(1,a)·7·0.006/1000 + o·0.0045/1000
 */
function specPerSentenceCny(packChars: number): number {
  const t = textTokens(packChars);
  return (
    (RESPONSES_PER_SENTENCE * t * PRICE_CNY_PER_1K.textInput) / 1000 +
    (RESPONSES_PER_SENTENCE * audioTokens() * PRICE_CNY_PER_1K.audioInput) / 1000 +
    (OUTPUT_TOKENS_PER_SENTENCE * PRICE_CNY_PER_1K.textOutput) / 1000
  );
}

/** One `response.done`'s usage for a sentence's response, as the endpoint shapes it. */
function responseUsage(packChars: number): {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { text_tokens: number; audio_tokens: number };
} {
  const text = textTokens(packChars);
  const audio = audioTokens();
  return {
    // The endpoint reports input as ONE number plus its split; a reader that only summed
    // `input_tokens` could not tell text from audio, which is why the split is carried.
    input_tokens: text + audio,
    output_tokens: OUTPUT_TOKENS_PER_SENTENCE / RESPONSES_PER_SENTENCE,
    input_tokens_details: { text_tokens: text, audio_tokens: audio },
  };
}

/**
 * Replays `sentences` sentences through the SHIPPING estimator and returns the total.
 *
 * The number is the estimator's own output over the endpoint's own usage shape — nothing here totals
 * the model by hand, so a divergence between the two would show up as a failure of the equality below.
 */
function replayCny(packChars: number, sentences = SENTENCES): number {
  let total = 0;
  for (let sentence = 0; sentence < sentences; sentence += 1) {
    for (let response = 0; response < RESPONSES_PER_SENTENCE; response += 1) {
      total += estimateRealtimeCostCny(responseUsage(packChars));
    }
  }
  return total;
}

/**
 * The D2 ceiling for one sentence at `packChars`, scaled linearly off the default pack.
 *
 * The SPEC's dependency on the pack is entirely through `T`, so the ceiling scales by `T(pack)/T(2000)`
 * — a function, as the D2 table requires ("夹具里写成函数，不写死").
 */
const perSentenceCeilingCny = (packChars: number): number =>
  D2_LINE.perSentenceCny * (textTokens(packChars) / textTokens(DEFAULT_PACK_CHARS));

/** The D2 ceiling for a full hour of speech at `packChars`, the same scaling applied to `≤ ¥0.45`. */
const perHourCeilingCny = (packChars: number): number =>
  D2_LINE.perHourCny * (textTokens(packChars) / textTokens(DEFAULT_PACK_CHARS));

// ── AC3: the D2 line, at the default pack and scaled off it ───────────────────────────────────

test('AC3: 60 sentences at the default 2,000-char pack stay under the D2 per-sentence and per-hour lines', () => {
  const total = replayCny(DEFAULT_PACK_CHARS);
  const perSentence = total / SENTENCES;

  // (1) The replay equals the SPEC's formula at this pack size.
  assert.ok(
    Math.abs(perSentence - specPerSentenceCny(DEFAULT_PACK_CHARS)) < 1e-12,
    `replay per-sentence ¥${perSentence.toFixed(6)} must equal the SPEC formula ¥${specPerSentenceCny(DEFAULT_PACK_CHARS).toFixed(6)}`,
  );
  // (2) The D2 ceiling, scaled (a no-op at the default size).
  assert.ok(perSentence <= perSentenceCeilingCny(DEFAULT_PACK_CHARS), `per-sentence ¥${perSentence.toFixed(6)} > ¥0.006`);
  assert.ok(
    perSentence * SENTENCES_PER_HOUR <= perHourCeilingCny(DEFAULT_PACK_CHARS),
    `69 sentences/hour ¥${(perSentence * SENTENCES_PER_HOUR).toFixed(4)} > ¥0.45`,
  );
  // (3) The scaled ceiling IS the SPEC's literal at the default size — the scaling has not moved the line.
  assert.equal(perSentenceCeilingCny(DEFAULT_PACK_CHARS), D2_LINE.perSentenceCny);
  assert.equal(perHourCeilingCny(DEFAULT_PACK_CHARS), D2_LINE.perHourCny);
  // And the value the SPEC's table prints for the default pack, to four decimals.
  assert.equal(Number(perSentence.toFixed(4)), 0.0048);
});

test('AC3: the ceilings scale with the pack, and every pack size in the SPEC table stays under its own line', () => {
  // The four sizes the SPEC's §按包字符数 table prices, plus the default.
  const packSizes = [1000, DEFAULT_PACK_CHARS, 4000, 8000];
  for (const packChars of packSizes) {
    const perSentence = replayCny(packChars) / SENTENCES;
    assert.ok(
      Math.abs(perSentence - specPerSentenceCny(packChars)) < 1e-12,
      `pack ${packChars}: replay must equal the formula`,
    );
    assert.ok(
      perSentence <= perSentenceCeilingCny(packChars),
      `pack ${packChars}: ¥${perSentence.toFixed(6)} > ceiling ¥${perSentenceCeilingCny(packChars).toFixed(6)}`,
    );
    assert.ok(
      perSentence * SENTENCES_PER_HOUR <= perHourCeilingCny(packChars),
      `pack ${packChars}: hourly ¥${(perSentence * SENTENCES_PER_HOUR).toFixed(4)} > ceiling`,
    );
  }
  // A bigger pack costs strictly more, so the scaling is a real dependency and not a constant in disguise.
  assert.ok(replayCny(8000) > replayCny(1000), 'a larger pack must cost more per sentence');
  assert.ok(perSentenceCeilingCny(8000) > perSentenceCeilingCny(1000), 'the ceiling must move with the pack');
});

test('AC3: the estimator reads the SPEC prices and only the endpoint usage shape', () => {
  // The prices are the estimator's, not this file's: one response of known token counts pins them.
  const text = textTokens(DEFAULT_PACK_CHARS);
  const audio = audioTokens();
  const expected =
    (text * PRICE_CNY_PER_1K.textInput + audio * PRICE_CNY_PER_1K.audioInput + 18 * PRICE_CNY_PER_1K.textOutput) / 1000;
  assert.ok(Math.abs(estimateRealtimeCostCny(responseUsage(DEFAULT_PACK_CHARS)) - expected) < 1e-12);

  // `text_tokens` defaulting to `input - audio` must land on the same number when the split is absent…
  assert.equal(
    estimateRealtimeCostCny({ input_tokens: text + audio, output_tokens: 18, input_tokens_details: { audio_tokens: audio } }),
    estimateRealtimeCostCny(responseUsage(DEFAULT_PACK_CHARS)),
  );
  // …and an unreadable usage must cost 0, so a blank frame can never read as a cheap run.
  assert.equal(estimateRealtimeCostCny(undefined), 0);
  assert.equal(estimateRealtimeCostCny({ input_tokens: 'x' }), 0);
  assert.equal(estimateRealtimeCostCny({}), 0);
});
