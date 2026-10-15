/**
 * The prompt-side half of SPEC C-2: no keyword table, no "the user said X ⇒ abort".
 *
 * WHAT WAS WRONG. `VOICE_REALTIME_INSTRUCTIONS` told the model that a stop is a set of words —
 * it quoted four of them and made the abort a MATCH. That is the conditional mapping C-2 forbids
 * (SPEC §18.1 F-5), and it is not a hypothetical: on 2026-10-12 the user asked for the in-flight
 * work to be cancelled in words that were not on the list, so the model relayed the request as
 * ordinary speech and nothing was interrupted (journal `99df08d8`, 01:26:39–01:26:53). The
 * browser-side fallback was removed earlier (`bbca2901` / `d03702bb`); this file is the
 * mechanical reading that keeps the PROMPT side from growing one back.
 *
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT. The scan is about the FORM of a keyword table,
 * never about the TOPIC of stopping: a sentence may say "stop" as often as it likes, it just may
 * not present a word as the thing to match on (quoted, or written as a bare array element in the
 * source) nor condition the abort on what the user said. So the negative controls below are as
 * load-bearing as the positives — a detector that reddened on the word "stop" would forbid the
 * feature it exists to describe, and the false forms prove this one does not.
 *
 * WHERE IT READS FROM. Both halves of the shipped surface: the instruction string the proxy puts
 * in `session.update` (imported as the constant, and re-read from the SOURCE FILE region that
 * builds it, so a list re-added to the array is caught even if the runtime value were ever
 * assembled some other way), and the descriptions of the two tools the voice plane advertises
 * (`VOICE_REALTIME_TOOLS`) — a trigger list is no less a trigger list for living in a tool
 * description.
 *
 * Consumers: the quay worker's AC state for `gap-live-voice-prompt-drop-stop-word-trigger`; the
 * mirror invariant in `voice-realtime-bridge.test.ts` keeps the change from drifting AC-2.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS, voiceRealtimeInstructionsFor } from '../index.js';

// ── the detector ────────────────────────────────────────────────────────────────────────────

/**
 * The words the removed table listed — the four that shipped (SPEC §18.1 F-5) plus the two the
 * criterion names so a future table is caught in the language the user actually speaks.
 */
const STOP_WORDS = ['stop', '停', '停下', '别做了', 'cancel', '取消'];

/**
 * The quoting styles a keyword table uses in PROSE: the ASCII double quote the prompt shipped
 * with, and the typographic pair a rendered string would carry.
 *
 * A lone word in single quotes is deliberately NOT read as a table here — that is how a person
 * mentions a word ("the word 'cancel' is not required"), and the source-level reading below covers
 * the one place a single quote does mean a table: a JS string that IS the word.
 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
];

/** The stop words this text presents as MATCH TARGETS — i.e. quoted — rather than merely mentions. */
function quotedStopWords(text: string): string[] {
  return STOP_WORDS.filter((word) => QUOTE_PAIRS.some(([open, close]) => text.includes(`${open}${word}${close}`)));
}

/**
 * A conditional from what the user said to what the model must do. The two forms the shipped
 * prompt used are the ones SPEC C-2 names; a trigger list is a trigger list whether the sentence
 * opens with "if" or not, so this is deliberately a narrow reading of the exact defect rather
 * than an attempt to enumerate every phrasing of a bad prompt.
 */
const CONDITIONAL_TRIGGER = /\bif the user\s+(says|tells you to)\b/i;

/** Every quoted stop word and every conditional trigger in one reading, named so a red says which. */
function triggerHits(text: string): string[] {
  const hits = quotedStopWords(text).map((word) => `quoted stop word: ${word}`);
  const conditional = CONDITIONAL_TRIGGER.exec(text);
  if (conditional) hits.push(`conditional trigger: ${conditional[0]}`);
  return hits;
}

/**
 * A JS string literal that is nothing but a stop word — how a table reads in the SOURCE file,
 * where the double quotes of the prose form are the enclosing delimiter's neighbours rather than
 * the words' own quotes. Both spellings are the same defect; only the file-level reading sees this
 * one.
 */
const SOURCE_ELEMENT = new RegExp(`'\\s*(${STOP_WORDS.join('|')})\\s*'`);

/** The same reading as {@link triggerHits}, plus the source-only single-quoted element form. */
function sourceTriggerHits(region: string): string[] {
  const hits = triggerHits(region);
  const element = SOURCE_ELEMENT.exec(region);
  if (element) hits.push(`quoted stop word: ${element[1]}`);
  return hits;
}

// ── the shipped surface ─────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The module that builds the instructions — the file a reviewer greps for a keyword table. */
const INSTRUCTIONS_SOURCE = path.resolve(HERE, '..', 'voice-realtime-ws-proxy.service.ts');

/**
 * The literal text of the instructions array as it is WRITTEN in the source file — now the body of
 * `voiceRealtimeInstructionsFor`, which both `VOICE_REALTIME_INSTRUCTIONS` (`respond`) and the
 * `silent` prompt are built from.
 *
 * Read from the file rather than re-derived from the constant so the assertion covers the
 * artifact a person edits, and asserted non-empty so a rename or a reflow can never let the scan
 * pass by reading nothing.
 */
function instructionsSourceRegion(): string {
  const source = readFileSync(INSTRUCTIONS_SOURCE, 'utf8');
  const match = /export function voiceRealtimeInstructionsFor\([^)]*\): string \{\s*return \[([\s\S]*?)\]\.join\(' '\);/.exec(source);
  assert.ok(match, `the instructions array must be findable in ${INSTRUCTIONS_SOURCE}`);
  const region = match[1]!;
  assert.match(region, /session_send/, 'the extracted region must be the instructions, not an empty slice');
  return region;
}

/** A tool description, keyed by the tool it belongs to so a red names the tool. */
const TOOL_DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = VOICE_REALTIME_TOOLS.map((tool) => [
  tool.name,
  tool.description,
]);

// ── AC1: no keyword table anywhere on the voice surface ─────────────────────────────────────

test('AC1: the shipped instructions present no stop word as a match target and no conditional trigger', () => {
  const fromConstant = triggerHits(VOICE_REALTIME_INSTRUCTIONS);
  assert.deepEqual(fromConstant, [], `the instructions still name triggers: ${fromConstant.join('; ')}`);
  // The silent closing turn swaps one sentence; it is a shipped prompt too and gets the same reading.
  const fromSilent = triggerHits(voiceRealtimeInstructionsFor('silent'));
  assert.deepEqual(fromSilent, [], `the silent instructions still name triggers: ${fromSilent.join('; ')}`);

  const fromSource = sourceTriggerHits(instructionsSourceRegion());
  assert.deepEqual(fromSource, [], `the instructions source still names triggers: ${fromSource.join('; ')}`);
});

test('AC1: the two advertised tool descriptions carry no stop word table and no conditional trigger', () => {
  assert.equal(TOOL_DESCRIPTIONS.length, 2, 'the voice plane advertises exactly two tools');
  for (const [name, description] of TOOL_DESCRIPTIONS) {
    const hits = triggerHits(description);
    assert.deepEqual(hits, [], `${name}'s description still names triggers: ${hits.join('; ')}`);
  }
});

test('AC1: the false form — the pre-change prompt, and a table per word, both go RED', () => {
  // The prompt as it shipped, verbatim: the mutation a future edit would restore. The reading
  // above is only load-bearing if THIS reds.
  const LEGACY_INSTRUCTIONS = [
    'You are a voice relay for one Claude Code session.',
    'The ONE exception is a stop: if the user tells you to stop — "stop", "停", "停下",',
    '"别做了" — call the `session_interrupt` function instead of `session_send`, then reply',
    'with the single word OK and say nothing else.',
  ].join(' ');
  const legacyHits = triggerHits(LEGACY_INSTRUCTIONS);
  for (const word of ['stop', '停', '停下', '别做了']) {
    assert.ok(legacyHits.includes(`quoted stop word: ${word}`), `the legacy prompt must red on ${word}`);
  }
  assert.ok(
    legacyHits.some((hit) => hit.startsWith('conditional trigger:')),
    'the legacy prompt must red on its "if the user tells you to" clause',
  );

  // A table with only the word swapped in — each of the six is caught, so a table narrowed to
  // one language or to one verb does not slip through.
  const TEMPLATE = 'When they say "WORD", call `session_interrupt`.';
  for (const word of STOP_WORDS) {
    const hits = triggerHits(TEMPLATE.replace('WORD', word));
    assert.deepEqual(hits, [`quoted stop word: ${word}`], `a table listing ${word} must red`);
  }

  // The source-level reading: the same six words as JS array elements, which the prose reading
  // alone would miss.
  for (const word of STOP_WORDS) {
    const hits = sourceTriggerHits(`  '${word}',\n  'and the rest of the prompt',`);
    assert.deepEqual(hits, [`quoted stop word: ${word}`], `a source table listing ${word} must red`);
  }

  // …and the kill-switch on the kill-switch: the detector must NOT red on stopping spoken about
  // plainly, or it would forbid the very sentence it exists to protect. The third sample is the
  // one that keeps the source-level reading honest — a single quote in PROSE is a mention, and
  // only a string that is nothing but the word is a table entry.
  for (const benign of [
    'judge for yourself whether the user wants the work that is running right now to stop',
    'if they want it stopped, call `session_interrupt` and put the reason in `intent`',
    "Read what they meant; the word 'cancel' is not required, and no word is.",
    'a stop is a judgement, so it is never a list of words to match',
  ]) {
    assert.deepEqual(triggerHits(benign), [], `a benign sentence must not red: ${benign}`);
  }
  assert.deepEqual(
    sourceTriggerHits("  'judge for yourself whether the user wants it to stop',\n"),
    [],
    'a source line that only MENTIONS stopping must not red',
  );
});

test('AC1: the stop exception survives as a JUDGEMENT, not as an absence', () => {
  // Removing the table must not remove the exception itself: the model still has to be told that
  // a stop is real and that it is the model's call.
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /session_interrupt/, 'the stop tool must still be named');
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /judge/i, 'the stop must be framed as the model’s judgement');
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /no list of words to match/i, 'the prompt must say there is no table');
});

// ── AC2: the relay contract the instructions still have to carry ────────────────────────────

test('AC2: the stop judgement calls session_interrupt, everything else calls session_send, nothing is answered in text', () => {
  // (1) a judged stop routes to session_interrupt …
  assert.match(
    VOICE_REALTIME_INSTRUCTIONS,
    /judge for yourself whether the user wants the work that is running right now to stop/i,
    'the stop must be stated as a judgement over what the user meant',
  );
  assert.match(
    VOICE_REALTIME_INSTRUCTIONS,
    /call the `session_interrupt` function instead of `session_send`/,
    'a judged stop must route to session_interrupt and not to session_send',
  );

  // (2) … and EVERYTHING else routes to session_send.
  assert.match(
    VOICE_REALTIME_INSTRUCTIONS,
    /EVERYTHING the user says[\s\S]*must be passed on by calling the `session_send` function/,
    'everything but a stop must be relayed through session_send',
  );

  // (3) the model never answers the user itself, in text or otherwise.
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /never produce a text reply/i, 'a text reply must stay forbidden');
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /you never reply in text/i, 'the relay must never reply in text');
});
