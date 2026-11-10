#!/usr/bin/env node
/**
 * The stage-0 readout: turn the voice data this machine has collected into the exit-criterion
 * numbers, and answer whether stage 0 is met.
 *
 * WHY THIS EXISTS. Stage 0 collects a transcription (what was heard), the confidence shadow's marks
 * and — when the user corrects the box before sending — the `heard → final` pairs of the edit. That
 * corpus is only worth anything once it can be read, and the exit criterion the proposal names
 * (`docs/proposals/voice-correction-feedback-loop.md` §6 阶段 0) is a fixed set of aggregate numbers:
 * how many segments carry an identifier, how many carry a correction label, the manual-edit share,
 * the error-form taxonomy, the confidence AUROC against real errors, the mark rate and recall per
 * threshold, and the auto-repair revert rate. This script is that reader.
 *
 * IT IS A READER AND NOTHING ELSE. It opens the voice data directory, reads the record documents
 * (never the `.wav` audio), and prints aggregates. It does not network, does not write, does not
 * re-run the recogniser, and — this is the load-bearing property, checked by the criterion's own
 * negative control — it NEVER PRINTS A WORD THE USER OR THE RECOGNISER PRODUCED. The `heard`, the
 * `final`, the recognised text and the audio all stay on disk; only counts, ratios and thresholds
 * leave. A readout that quoted a transcript would leak exactly the content D1 promised stays local.
 *
 * THE CALIBRE IS BORROWED, NOT INVENTED. The identifier rule is `isIdentifierShaped`'s (a port of
 * `src/shared/voice/labels/voiceEditLabels.ts`, itself a port of `experiments/voice-index-loop/sim/extract.py`'s
 * `is_id`); the token character intervals and the maximal-run definition of a confidence mark are
 * `shared/asr/confidenceFlags.ts`'s (a port of the offline experiment's `tokSpans`/flag sweep); the
 * AUROC is `experiments/voice-index-loop/sim/sv-eval2.mjs`'s rank-sum, re-derived for the same
 * orientation (`1 - confidence`, low confidence ⇒ error). The criterion pins the AUROC against the
 * experiment's own function, so the two are one algorithm and not two readings of one word.
 *
 *   node scripts/voice-phase0-report.mjs [--dir <path>] [--json]
 *
 * EXIT CODES, the same three the proposal names: `0` the stage-0 gate is met (≥ 100 segments with an
 * identifier AND ≥ 30 segments with a correction label); `2` the gate is not met, the numbers printed;
 * `1` the readout could not be made at all (no such directory, an unreadable record) — an
 * unmeasurable corpus is not a failing corpus.
 *
 * THE ONLY IMPORTS ARE NODE BUILTINS, so the script runs under bare `node` with no loader and no
 * TypeScript build. The alternative — importing the shared predicates — would make a report about a
 * local directory depend on the server's module graph, and the criterion runs it as `node scripts/…`.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One recognised token, of the many fields the wire carries only these two are read. */
/** @typedef {{ text: string, confidence?: number }} ConfidenceToken */

/** One stored segment: the recognised text and, when the recogniser declared it, its tokens. */
/** @typedef {{ index: number, text: string, tokens?: ConfidenceToken[] }} StoredSegment */

/** One `heard → final` pair the edit left behind, as the store persists it. */
/** @typedef {{ segmentIndex: number, heard: string, final: string, op: string }} StoredLabel */

/** One row of the confidence shadow: the marks at one threshold and their per-100-char rate. */
/** @typedef {{ theta: number, flags: number, flagsPer100Chars: number }} StoredThetaRow */

/** The confidence shadow's document, as `voice.service.ts` wrote it beside a record. */
/** @typedef {{ chars: number, byTheta: StoredThetaRow[] }} StoredFlagStats */

/** One transcription as the store persists it — the fields this reader actually reads. */
/**
 * @typedef {{
 *   recordId: string,
 *   ts: number,
 *   providerId: string,
 *   segments: StoredSegment[],
 *   finalText?: string,
 *   labels?: StoredLabel[],
 *   flagStats?: StoredFlagStats,
 *   repairedText?: string,
 * }} StoredRecord
 */

/** A half-open `[start, end)` range of a string. */
/** @typedef {{ start: number, end: number }} Span */

/** One token's interval in its text, with the confidence the AUROC is taken over. */
/** @typedef {{ start: number, end: number, confidence: number | undefined }} TokenSpan */

/** The four error shapes and the two label totals, all counts. */
/**
 * @typedef {{
 *   form: number,
 *   'spoken-form': number,
 *   'cjk-rendering': number,
 *   misheard: number,
 *   corrections: number,
 *   rewrites: number,
 * }} FormCounts
 */

/** The thresholds the report sweeps when a record carries no `flagStats` to supply its own. */
const DEFAULT_THETAS = [0.5, 0.6, 0.7, 0.8];

/** The token alphabet `experiments/voice-index-loop/sim/lib.mjs` scans identifier candidates with. */
const TOKEN_SOURCE = '[A-Za-z][A-Za-z0-9_./\\-]*[A-Za-z0-9]|[A-Za-z]';

/** A trailing `.ext`, which makes a token a file name rather than an identifier. */
const FILE_SUFFIX = /\.\w{1,4}$/;
/** The marks that make a token identifier-shaped: a camel boundary, a joiner, or a digit. */
const IDENTIFIER_MARK = /[a-z][A-Z]|[-_]|\d/;
/** The Han numerals that read a spoken number out (`AC 零零二`) rather than a Latin one. */
const HAN_NUMERAL = /[零〇一二三四五六七八九十百千万亿两]/;
/** A final form of the `AC-数字` class — a Latin stem, a hyphen, a decimal number. */
const AC_NUMBERED = /^[A-Za-z]{1,10}-\d+$/;

/**
 * The stem of a path — only for naming a file in an error, never record content.
 *
 * @param {string} value
 * @returns {string}
 */
const FILE_NAME = (value) => path.basename(value);

/**
 * Whether a token has the shape of an identifier rather than of an ordinary word.
 *
 * A port of `isIdentifierShaped` in `src/shared/voice/labels/voiceEditLabels.ts`, which is itself a port of
 * `is_id` in `experiments/voice-index-loop/sim/extract.py`: at least two characters, neither a path
 * (contains `/`) nor a file name (ends in a `.ext`), and carrying a camel/Pascal boundary, a `-`/`_`,
 * a digit, or an all-caps run. Kept character-for-character so a segment this reader calls
 * "identifier-bearing" is the same segment the offline index would.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isIdentifierShaped(token) {
  if (token.length < 2 || token.includes('/') || FILE_SUFFIX.test(token)) {
    return false;
  }
  if (IDENTIFIER_MARK.test(token)) {
    return true;
  }
  return /[A-Z]/.test(token) && !/[a-z]/.test(token);
}

/**
 * Every identifier-shaped token in `text`, with its span.
 *
 * @param {string} text
 * @returns {{ token: string, start: number, end: number }[]}
 */
export function identifierTokens(text) {
  const found = [];
  const pattern = new RegExp(TOKEN_SOURCE, 'g');
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (isIdentifierShaped(match[0])) {
      found.push({ token: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  return found;
}

/**
 * The comparable key of a token: lowercased, letters and digits only.
 *
 * The offline index's `normKey` (`experiments/voice-index-loop/sim/lib.mjs`). Two forms share a key
 * exactly when they differ only in spacing, joining punctuation or case — which is what makes the
 * `form` error class ("the recogniser got the shape, not the word") decidable from the key alone.
 *
 * @param {string} value
 * @returns {string}
 */
export function normKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Each token's character interval in its text, by the offline experiment's rule.
 *
 * A port of `tokenSpans` in `shared/asr/confidenceFlags.ts`: the intervals are the running
 * concatenation of the token texts with `▁` (the local engine's word-boundary mark) read as a space,
 * minus the leading whitespace the whole string starts with, each bound clamped at zero. The `▁`
 * stays on the following token's span (only the string-leading whitespace is trimmed), which is the
 * experiment's own choice and the reason the same interval is read on both sides.
 *
 * @param {readonly ConfidenceToken[]} tokens
 * @returns {TokenSpan[]}
 */
export function tokenSpans(tokens) {
  let raw = '';
  /** @type {number[]} */
  const positions = [];
  for (const token of tokens) {
    positions.push(raw.length);
    raw += token.text.replace('▁', ' ');
  }
  const lead = raw.length - raw.trimStart().length;
  return tokens.map((token, index) => {
    const length = token.text.replace('▁', ' ').length;
    return {
      start: Math.max(0, positions[index] - lead),
      end: Math.max(0, positions[index] + length - lead),
      confidence: token.confidence,
    };
  });
}

/** A token's confidence is low when it is a number below `theta`; a missing confidence never is. */
/**
 * @param {TokenSpan[]} spans
 * @param {number} theta
 * @returns {Span[]}
 */
export function flagSpans(spans, theta) {
  const flags = [];
  let index = 0;
  while (index < spans.length) {
    const confidence = spans[index].confidence;
    if (typeof confidence === 'number' && confidence < theta) {
      let last = index;
      while (last + 1 < spans.length) {
        const next = spans[last + 1].confidence;
        if (typeof next !== 'number' || next >= theta) break;
        last += 1;
      }
      flags.push({ start: spans[index].start, end: spans[last].end });
      index = last + 1;
    } else {
      index += 1;
    }
  }
  return flags;
}

/**
 * The AUROC of low confidence against real errors: `1 - confidence` scored over error regions
 * versus uncorrected regions, by the rank-sum (Mann–Whitney U) statistic.
 *
 * BIT-FOR-BIT `auroc` FROM `experiments/voice-index-loop/sim/sv-eval2.mjs`, so a number read here and
 * a number read in the offline experiment are the same number. `null` when either class is empty:
 * with one class there is nothing to separate, and a division by zero would print `NaN` where the
 * honest reading is "not measurable". The proposal's "either class < 10" insufficiency rule is
 * applied by the caller, not here — this function measures whatever it is handed.
 *
 * @param {number[]} pos
 * @param {number[]} neg
 * @returns {number | null}
 */
export function auroc(pos, neg) {
  if (pos.length === 0 || neg.length === 0) return null;
  /** @type {[number, number][]} */
  const all = [
    ...pos.map((value) => /** @type {[number, number]} */ ([value, 1])),
    ...neg.map((value) => /** @type {[number, number]} */ ([value, 0])),
  ];
  all.sort((a, b) => a[0] - b[0]);
  let rs = 0;
  let index = 0;
  while (index < all.length) {
    let last = index;
    while (last + 1 < all.length && all[last + 1][0] === all[index][0]) last += 1;
    const average = (index + last) / 2 + 1;
    for (let at = index; at <= last; at += 1) if (all[at][1] === 1) rs += average;
    index = last + 1;
  }
  const positives = pos.length;
  const negatives = neg.length;
  return (rs - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Which of the four error shapes one `heard → final` pair is.
 *
 * ORDER IS THE WHOLE RULE, and it is the proposal's:
 *   1. the same key on both sides — the recogniser got the joining/case wrong, not the word ⇒ `form`;
 *   2. the final is an `AC-数字` and the heard reads a Han numeral ⇒ `spoken-form` ("AC 零零二");
 *   3. the heard carries no Latin letter at all ⇒ `cjk-rendering` (a Han homophone of a Latin term);
 *   4. anything else ⇒ `misheard` (the word itself was heard as another word).
 *
 * A `form` pair with both sides empty is deliberately not `form` (there is no key to share); it
 * falls through to `cjk-rendering`, which is what "a deletion of Han-only text" reads as. A deletion
 * of Latin text reads as `misheard` for the same reason — the classifier describes the *heard* side.
 *
 * @param {string} heard
 * @param {string} final
 * @returns {'form' | 'spoken-form' | 'cjk-rendering' | 'misheard'}
 */
export function classifyForm(heard, final) {
  const heardKey = normKey(heard);
  if (heardKey !== '' && heardKey === normKey(final)) return 'form';
  if (AC_NUMBERED.test(final) && HAN_NUMERAL.test(heard)) return 'spoken-form';
  if (!/[A-Za-z]/.test(heard)) return 'cjk-rendering';
  return 'misheard';
}

/**
 * The Levenshtein distance between two strings, for the changed-character count.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function editDistance(left, right) {
  const previous = new Array(right.length + 1);
  const current = new Array(right.length + 1);
  for (let column = 0; column <= right.length; column += 1) previous[column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitution,
      );
    }
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column];
  }
  return previous[right.length];
}

/**
 * Where the default directory is, from the two values the server's composition root reads.
 *
 * A port of `resolveVoiceDataDir` in `server/modules/voice/voice-data.ts`: an explicit
 * `VOICE_DATA_DIR` wins, otherwise the store sits beside the database (`DATABASE_PATH`, else
 * `~/.cloudcli/auth.db`) as `<parent>/voice-data`. The criterion passes `--dir`, so this path is
 * only the one a person running the script by hand gets when they have configured nothing.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function defaultVoiceDataDir(env) {
  const explicit = (env.VOICE_DATA_DIR ?? '').trim();
  if (explicit !== '') return explicit;
  const database = (env.DATABASE_PATH ?? '').trim();
  const databasePath = database === '' ? path.join(os.homedir(), '.cloudcli', 'auth.db') : database;
  return path.join(path.dirname(databasePath), 'voice-data');
}

/**
 * Every record document directly under `directory`, oldest first.
 *
 * Only `.json` files are read; the `.wav` segments beside them are ignored, because this reader
 * never touches audio. An unreadable or non-object record throws — a corpus with a corrupt file is
 * one whose aggregates would silently be wrong, and the proposal's contract is that an unmeasurable
 * readout exits 1 rather than printing a plausible-but-short number.
 *
 * @param {string} directory
 * @returns {StoredRecord[]}
 */
function readRecords(directory) {
  const records = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(directory, name);
    if (!statSync(full).isFile()) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'));
    } catch {
      throw new Error(`unreadable record document: ${FILE_NAME(full)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.segments)) {
      throw new Error(`not a voice data record: ${FILE_NAME(full)}`);
    }
    const record = /** @type {StoredRecord} */ (parsed);
    if (typeof record.recordId !== 'string' || typeof record.providerId !== 'string') {
      throw new Error(`not a voice data record: ${FILE_NAME(full)}`);
    }
    records.push(record);
  }
  return records;
}

/**
 * Whether one segment's text carries at least one identifier-shaped token.
 *
 * @param {StoredSegment} segment
 * @returns {boolean}
 */
function segmentHasIdentifier(segment) {
  return typeof segment.text === 'string' && identifierTokens(segment.text).length > 0;
}

/**
 * Whether one pair is a correction. `rewrite` is not: `voiceEditLabels.ts` marks a change that
 * reached past the correction budget as a different sentence, and learning from it would teach the
 * wrong thing. It is still counted (`forms.rewrites`), it is just not a correction.
 *
 * @param {StoredLabel} label
 * @returns {boolean}
 */
function isCorrection(label) {
  return label.op !== 'rewrite';
}

/**
 * The first span of `needle` in `haystack` at or after `from`, or `null`.
 *
 * @param {string} haystack
 * @param {string} needle
 * @param {number} from
 * @returns {Span | null}
 */
function findSpan(haystack, needle, from) {
  if (needle === '') return null;
  const at = haystack.indexOf(needle, from);
  return at < 0 ? null : { start: at, end: at + needle.length };
}

/** @param {Span} a @param {Span} b @returns {boolean} */
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Every aggregate the stage-0 readout prints, read off the records in `directory`.
 *
 * Everything returned is a count, a ratio, a threshold or a class name: no recognised text, no
 * `heard`, no `final`, no audio. That property is not incidental — the criterion's negative control
 * plants a sentinel string in all three of those fields and asserts the printed output never carries
 * it, so a future field added here that echoed its input would red that control.
 *
 * @param {string} directory
 * @returns {Record<string, unknown>}
 */
export function analyseDirectory(directory) {
  const records = readRecords(directory);

  let segmentCount = 0;
  let identifierSegmentCount = 0;
  let labelledSegmentCount = 0;
  let speechChars = 0;
  let changedChars = 0;
  /** @type {FormCounts} */
  const forms = { form: 0, 'spoken-form': 0, 'cjk-rendering': 0, misheard: 0, corrections: 0, rewrites: 0 };

  /** @type {number[]} */
  const errorScores = [];
  /** @type {number[]} */
  const okScores = [];
  /** Label regions on token-bearing segments, so the recall sweep reads them off the segment. */
  /** @type {{ tokens: ConfidenceToken[], regions: Span[] }[]} */
  const labelledTokenSegments = [];

  /** Per-record `flagStats`, aggregated as the proposal asks (the mean of the stored rates). */
  /** @type {Map<number, { flags: number, rows: number, per100: number, chars: number }>} */
  const marksByTheta = new Map();

  /** Records whose `repairedText` differs from the recognised text — the revert rate's denominator. */
  let repairChanged = 0;
  let repairReverted = 0;
  let sawRepairedText = false;

  for (const record of records) {
    const labels = Array.isArray(record.labels) ? record.labels : [];
    const corrections = labels.filter(isCorrection);
    const segments = Array.isArray(record.segments) ? record.segments : [];

    if (record.flagStats && Array.isArray(record.flagStats.byTheta)) {
      for (const row of record.flagStats.byTheta) {
        const existing = marksByTheta.get(row.theta) ?? { flags: 0, rows: 0, per100: 0, chars: 0 };
        existing.flags += row.flags;
        existing.rows += 1;
        existing.per100 += row.flagsPer100Chars;
        existing.chars += record.flagStats.chars;
        marksByTheta.set(row.theta, existing);
      }
    }

    if (typeof record.repairedText === 'string') {
      sawRepairedText = true;
      const recognised = segments.map((segment) => segment.text).join('');
      if (record.repairedText !== recognised) {
        repairChanged += 1;
        if (typeof record.finalText === 'string' && record.finalText === recognised) {
          repairReverted += 1;
        }
      }
    }

    // Every segment's own contribution: the identifier reading, the char counts, and the label
    // regions (resolved once, then reused by the AUROC and the mark recall below).
    /** @type {Map<number, Span[]>} */
    const regionsBySegment = new Map();
    for (const segment of segments) {
      segmentCount += 1;
      if (typeof segment.text === 'string') speechChars += segment.text.length;
      if (segmentHasIdentifier(segment)) identifierSegmentCount += 1;

      const matches = corrections.filter((label) => label.segmentIndex === segment.index);
      if (matches.length > 0) labelledSegmentCount += 1;

      /** @type {Span[]} */
      const regions = [];
      let cursor = 0;
      for (const label of matches) {
        const span = findSpan(segment.text ?? '', label.heard, cursor);
        if (span) {
          regions.push(span);
          cursor = span.end;
        }
        changedChars += editDistance(label.heard, label.final);
      }
      regionsBySegment.set(segment.index, regions);
      if (Array.isArray(segment.tokens) && segment.tokens.length > 0) {
        labelledTokenSegments.push({ tokens: segment.tokens, regions });
      }
    }

    for (const label of labels) {
      if (!isCorrection(label)) {
        forms.rewrites += 1;
        continue;
      }
      forms.corrections += 1;
      forms[classifyForm(label.heard, label.final)] += 1;
    }

    // The confidence AUROC: error regions are the correction labels' spans, uncorrected regions are
    // identifier-shaped tokens no label touched. Only a segment that declared tokens contributes.
    for (const segment of segments) {
      if (!Array.isArray(segment.tokens) || segment.tokens.length === 0) continue;
      const spans = tokenSpans(segment.tokens);
      const regions = regionsBySegment.get(segment.index) ?? [];

      for (const region of regions) {
        const covered = spans.filter((span) => overlaps(span, region));
        const confidences = covered.map((span) => span.confidence).filter((value) => typeof value === 'number');
        if (confidences.length > 0) errorScores.push(1 - Math.min(...confidences));
      }

      spans.forEach((span, at) => {
        if (typeof span.confidence !== 'number') return;
        if (regions.some((region) => overlaps(span, region))) return;
        const text = (segment.tokens?.[at]?.text ?? '').replace('▁', '');
        if (!isIdentifierShaped(text)) return;
        okScores.push(1 - span.confidence);
      });
    }
  }

  const thetas = marksByTheta.size > 0 ? [...marksByTheta.keys()].sort((a, b) => a - b) : DEFAULT_THETAS;

  // The mark recall: for each threshold, the share of correction regions a mark covers. Read off the
  // records' own tokens (the same run rule the shadow counts with), so it is measured even where a
  // record carries no `flagStats`.
  /** @type {Map<number, { covered: number, total: number }>} */
  const recallByTheta = new Map();
  for (const theta of thetas) {
    let covered = 0;
    let total = 0;
    for (const entry of labelledTokenSegments) {
      const flags = flagSpans(tokenSpans(entry.tokens), theta);
      for (const region of entry.regions) {
        total += 1;
        if (flags.some((flag) => overlaps(flag, region))) covered += 1;
      }
    }
    recallByTheta.set(theta, { covered, total });
  }

  const identifierMet = identifierSegmentCount >= 100;
  const labelledMet = labelledSegmentCount >= 30;

  const enoughForAuroc = errorScores.length >= 10 && okScores.length >= 10;
  const aurocValue = enoughForAuroc ? auroc(errorScores, okScores) : null;

  const marks = thetas.map((theta) => {
    const aggregate = marksByTheta.get(theta);
    const recall = recallByTheta.get(theta) ?? { covered: 0, total: 0 };
    return {
      theta,
      flags: aggregate ? aggregate.flags : null,
      flagsPer100Chars: aggregate && aggregate.rows > 0 ? aggregate.per100 / aggregate.rows : null,
      chars: aggregate ? aggregate.chars : null,
      recall: recall.total > 0 ? recall.covered / recall.total : null,
      recallCovered: recall.covered,
      recallTotal: recall.total,
    };
  });

  return {
    directory,
    records: records.length,
    segments: segmentCount,
    identifierSegments: identifierSegmentCount,
    labelledSegments: labelledSegmentCount,
    gate: {
      identifierThreshold: 100,
      labelThreshold: 30,
      identifierMet,
      labelledMet,
      met: identifierMet && labelledMet,
    },
    manualEdit: {
      labelledSegmentRatio: segmentCount > 0 ? labelledSegmentCount / segmentCount : 0,
      changedChars,
      speechChars,
      charRatio: speechChars > 0 ? changedChars / speechChars : 0,
    },
    forms,
    confidence: {
      auroc: aurocValue,
      errorRegions: errorScores.length,
      uncorrectedIdentifierRegions: okScores.length,
      insufficient: !enoughForAuroc,
    },
    marks,
    repairRevertRate: (() => {
      if (!sawRepairedText) return null;
      return repairChanged > 0 ? repairReverted / repairChanged : null;
    })(),
    acousticAliasGain: {
      status: 'offline-experiment-required',
      pointer: 'experiments/voice-index-loop/RESULT-v6.md',
    },
  };
}

/**
 * The report as a person reads it. Counts, ratios and class names only — see `analyseDirectory`.
 *
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function formatReport(report) {
  const gate = /** @type {Record<string, any>} */ (report.gate);
  const manual = /** @type {Record<string, any>} */ (report.manualEdit);
  const forms = /** @type {FormCounts} */ (report.forms);
  const confidence = /** @type {Record<string, any>} */ (report.confidence);
  const marks = /** @type {Record<string, any>[]} */ (report.marks);
  const lines = [];
  lines.push(`voice phase 0 readout — ${report.directory}`);
  lines.push(`records: ${report.records}`);
  lines.push(`segments: ${report.segments}`);
  lines.push(
    `  with identifier-shaped tokens: ${report.identifierSegments} (need >= ${gate.identifierThreshold}: ${gate.identifierMet ? 'PASS' : 'FAIL'})`,
  );
  lines.push(
    `  with correction labels:       ${report.labelledSegments} (need >= ${gate.labelThreshold}: ${gate.labelledMet ? 'PASS' : 'FAIL'})`,
  );
  lines.push(
    `manual edit: labelled/segments = ${rate(manual.labelledSegmentRatio)}; changed/speech chars = ${manual.changedChars}/${manual.speechChars} = ${rate(manual.charRatio)}`,
  );
  lines.push(
    `error forms: form=${forms.form} spoken-form=${forms['spoken-form']} cjk-rendering=${forms['cjk-rendering']} misheard=${forms.misheard} (corrections=${forms.corrections} rewrites=${forms.rewrites})`,
  );
  lines.push(
    `confidence AUROC (low confidence => error): ${confidence.auroc === null ? 'n/a' : confidence.auroc.toFixed(3)} (error regions=${confidence.errorRegions}, uncorrected identifier regions=${confidence.uncorrectedIdentifierRegions})`,
  );
  lines.push('marks (from flagStats):');
  for (const row of marks) {
    const recall = row.recall === null ? 'n/a' : rate(row.recall);
    lines.push(
      `  theta=${row.theta}  flags=${row.flags ?? 'n/a'}  flags/100chars=${row.flagsPer100Chars === null ? 'n/a' : row.flagsPer100Chars.toFixed(2)}  recall=${recall}`,
    );
  }
  lines.push(
    `auto-repair revert rate: ${report.repairRevertRate === null ? 'n/a' : rate(/** @type {number} */ (report.repairRevertRate))}${report.repairRevertRate === null ? ' (no record carries repairedText)' : ''}`,
  );
  lines.push('acoustic alias gain: offline experiment required — see experiments/voice-index-loop/RESULT-v6.md');
  lines.push(`phase 0 gate: ${gate.met ? 'MET' : 'NOT MET'}`);
  return lines.join('\n');
}

/**
 * One ratio, printed without inventing precision.
 *
 * @param {number} value
 * @returns {string}
 */
function rate(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

/**
 * The argv this run was handed, or a thrown error naming the bad argument.
 *
 * @param {string[]} argv
 * @returns {{ directory: string, json: boolean }}
 */
export function parseArgs(argv) {
  let directory;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      index += 1;
      if (argv[index] === undefined) throw new Error('--dir needs a path');
      directory = argv[index];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/voice-phase0-report.mjs [--dir <path>] [--json]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { directory: directory ?? defaultVoiceDataDir(process.env), json };
}

/**
 * The entry point: read the directory, print the report, and exit with the gate's code.
 *
 * @param {string[]} argv
 * @returns {number} the process exit code: 0 met, 2 not met, 1 unmeasurable.
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`voice-phase0-report: ${/** @type {Error} */ (error).message}`);
    return 1;
  }

  if (!statSync(options.directory, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(
      `voice-phase0-report: no voice data directory at ${options.directory}\n` +
        '  set VOICE_DATA_DIR (or pass --dir <path>) to the directory the server writes records to;\n' +
        '  the default is <database dir>/voice-data (e.g. ~/.cloudcli/voice-data).',
    );
    return 1;
  }

  /** @type {Record<string, unknown>} */
  let report;
  try {
    report = analyseDirectory(options.directory);
  } catch (error) {
    console.error(`voice-phase0-report: ${/** @type {Error} */ (error).message}`);
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  return /** @type {Record<string, any>} */ (report.gate).met ? 0 : 2;
}

// RUN ONLY WHEN INVOKED, NOT WHEN IMPORTED: the criterion imports `auroc` (and the other pure
// helpers) to pin them against the experiment, and an import that immediately read a directory and
// exited would make that impossible. The comparison is by realpath, because a symlinked entry —
// which a worktree's `node_modules` layout produces — would otherwise fail the naive equality.
const entry = (() => {
  if (process.argv[1] === undefined) return '';
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return '';
  }
})();
if (entry !== '' && fileURLToPath(import.meta.url) === entry) {
  process.exit(main(process.argv.slice(2)));
}

