/**
 * Omission-fill rule v2 (GOAL-046): the speech the model's rewrite did not carry, planned as a PURE
 * function of what the relay already has in memory.
 *
 * WHAT THIS FILE IS. `docs/proposals/voice-realtime-omission-fill-SPEC.md` §「规则 v2」 defines a
 * language-neutral test for "the model's messages do not contain this final transcription". The
 * experiments side has had a reference implementation since the rule was measured
 * (`experiments/voice-relay-qb/replay_rule.py`, `_plan_R2`); this file is that implementation on the
 * server side, with no I/O, no timers, no logging and no defaults of its own. The caller owns the
 * clock, the transcripts, the executed messages and the parameters.
 *
 * PARAMETERS ARE THE LOCKED FILE'S, NOT THIS FILE'S. Every value comes from the caller's
 * `OmissionFillParams`, which the relay derives from
 * `experiments/voice-relay-qb/omission-fill-params.json`'s `chosen` block. This module deliberately
 * declares NO fallback values: a second copy of H/G/SCORE_T here would be a second source of truth
 * that silently disagrees with the replay gate.
 *
 * EXECUTED MEANS EXECUTED. `executed` is the model messages that actually ran: `session_send` /
 * `session_interrupt` calls whose response finished `completed`. Calls inside a response the endpoint
 * CANCELLED did not run and must be filtered by the caller before they reach this function — the
 * planner cannot tell them apart, and counting them would mark speech as covered when nothing was
 * delivered. `voice-realtime-omission-fill.test.ts` pins that input contract.
 *
 * PARITY IS A TEST, NOT A PROMISE. `--emit-fixture` on the replay tool freezes 47 real connections
 * plus 16 branch-targeted synthetic cases, each with this rule's own answer (fill indices, due times,
 * coverage and skip reasons). The criterion replays all of them through this file. A rule change on
 * either side without the other turns that test red.
 *
 * Consumers: a later task wires it into `voice-realtime-ws-proxy.service.ts` (register on a new final,
 * evaluate at `dueAt`); the criterion drives it directly. Exported through the module's barrel only.
 */

// ── input and output vocabulary ────────────────────────────────────────────────────────────────────

/** One final transcription: `F_i = (t_i, x_i)`. `t` is an epoch-millisecond arrival time. */
export type OmissionFillFinal = {
  readonly t: number;
  readonly text: string;
};

/** One EXECUTED relay message: `M_k = (τ_k, m_k)`. Cancelled responses' calls must not be passed. */
export type OmissionFillExecuted = {
  readonly t: number;
  readonly text: string;
};

/**
 * Which numeral-stripping variant `analyse` uses. `runs2` is the locked choice; `all` and
 * `quantifier` exist because the replay tool measured them and the fixture generator can emit cases
 * under any of the three. The behaviour is identical to `strip_numerals()` in `replay_rule.py`.
 */
export type OmissionFillNumeralMode = 'runs2' | 'all' | 'quantifier';

/**
 * The locked rule-v2 parameters. Field names mirror `chosen` in
 * `experiments/voice-relay-qb/omission-fill-params.json`:
 * `h_ms → hMs`, `g_ms → gMs`, `score_t → scoreT`, `w_min → wMin`, `w_hallu → wHallu`,
 * `dom_n → domN`, `lookback_ms → lookbackMs`, `silence_ms → silenceMs`, `numeral_mode → numeralMode`.
 *
 * `silenceMs: null` turns the silence-confirmation branch off (the reference implementation's
 * `SILENCE_MS is not None`); the locked value is 3000.
 */
export type OmissionFillParams = {
  readonly hMs: number;
  readonly gMs: number;
  readonly scoreT: number;
  readonly wMin: number;
  readonly wHallu: number;
  readonly domN: number;
  readonly lookbackMs: number;
  readonly silenceMs: number | null;
  readonly numeralMode: OmissionFillNumeralMode;
};

/**
 * Why an otherwise plausible transcription was NOT filled. Every reason the SPEC names is here, so
 * the relay's log line can say why a candidate was skipped instead of leaving a silent gap:
 *  - `weight`        — `w(x_i) < wMin` (too short to be worth a fill)
 *  - `empty-grams`   — no comparable units at all (e.g. a digits-only line after stripping)
 *  - `wrong-script`  — a short line in a different script than the recent past (hallucination)
 *  - `incomparable`  — the covering window's messages are in another script (translation)
 *  - `covered`       — the model's same-script messages carry ≥ `scoreT` of the utterance
 */
export type OmissionFillSkipReason = 'weight' | 'empty-grams' | 'wrong-script' | 'incomparable' | 'covered';

/** One planned fill: deliver `finals[index]` verbatim at `dueAt`. */
export type OmissionFill = {
  readonly index: number;
  /**
   * The decision time `T_i`: `min(τ_first + G, t_i + H)` when an executed message is in reach, else
   * `t_i + S` when the model stayed silent and the user did not speak again, else `t_i + H`.
   */
  readonly dueAt: number;
  /** Same-script coverage of the utterance at `dueAt`; `0` when the covering window is empty. */
  readonly coverage: number;
};

/** One passed-over transcription, for the relay's candidate-level log line. */
export type OmissionFillSkip = {
  readonly index: number;
  readonly reason: OmissionFillSkipReason;
};

/** The plan. `fills` and `skipped` partition the input indices, both in ascending index order. */
export type OmissionFillPlan = {
  readonly fills: readonly OmissionFill[];
  readonly skipped: readonly OmissionFillSkip[];
};

// ── normalisation and the unit model (§1) ──────────────────────────────────────────────────────────

/** The CJK numerals the rule treats as numbers (`零〇一二三四五六七八九十百`). */
const CJK_NUMERALS = '零〇一二三四五六七八九十百';

/** The measure words `quantifier` mode looks ahead for. Kept byte-identical to the Python reference. */
const MEASURE_WORDS = '个条次天日月年点分秒岁块元页行字句位名遍倍号层楼件张只双对';

/**
 * NFKC + casefold, as the reference does it. JS has no `casefold()`, so the two mappings that matter
 * after NFKC are applied by hand: `ß → ss` and final sigma `ς → σ`. `toLowerCase()` supplies the rest
 * (including `İ → i̇`); NFKC has already decomposed compatibility forms such as `ﬀ → ff`.
 */
function caseFold(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

/** `\p{Nd}` as the SPEC defines a digit character (Python's `str.isdigit()` on this corpus agrees). */
const DECIMAL_DIGIT = /^\p{Nd}$/u;

function isNumeralChar(ch: string): boolean {
  return CJK_NUMERALS.includes(ch) || DECIMAL_DIGIT.test(ch);
}

/**
 * Numbers carry no coverage signal; how much to strip is a measured trade-off (see the params file's
 * `numeral_mode` reason). Ported line for line from `strip_numerals()`:
 *  - `all`        — every digit run and every CJK numeral (`一些/一下` lose their `一`)
 *  - `runs2`      — only runs of ≥2 numeral characters (a lone `一/二/3` survives as a word)
 *  - `quantifier` — only numerals after `第/每/几` or directly before a Chinese measure word
 */
function stripNumerals(text: string, mode: OmissionFillNumeralMode): string {
  if (mode === 'all') {
    return text.replace(/\p{Nd}+/gu, ' ').replace(/[零〇一二三四五六七八九十百]+/g, ' ');
  }
  if (mode === 'quantifier') {
    const afterOrdinal = text.replace(/(?<=[第每几])[0-9零〇一二三四五六七八九十百]+/g, ' ');
    return afterOrdinal.replace(new RegExp(`[0-9零〇一二三四五六七八九十百]+(?=[${MEASURE_WORDS}])`, 'g'), ' ');
  }
  const chars = [...text];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (isNumeralChar(chars[i])) {
      let j = i;
      while (j < chars.length && isNumeralChar(chars[j])) j += 1;
      out.push(j - i >= 2 ? ' ' : chars.slice(i, j).join(''));
      i = j;
    } else {
      out.push(chars[i]);
      i += 1;
    }
  }
  return out.join('');
}

// The Python reference classifies a letter by the first word of its Unicode NAME
// (`unicodedata.name(ch).split(' ')[0]`), then treats names starting with CJK/HIRAGANA/KATAKANA as one
// `cjk` script. JS has no name database; the script properties reproduce the same partition for the
// scripts the rule admits. The two places where the NAME and the Script property disagree are called
// out explicitly:
//   · U+3005 IDEOGRAPHIC ITERATION MARK — name starts `IDEOGRAPHIC`, Script=Han ⇒ must NOT be cjk;
//   · U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK — name starts `KATAKANA`, Script=Common ⇒ IS cjk.
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NAMED_SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['LATIN', /\p{Script=Latin}/u],
  ['CYRILLIC', /\p{Script=Cyrillic}/u],
  ['GREEK', /\p{Script=Greek}/u],
  ['ARABIC', /\p{Script=Arabic}/u],
  ['HEBREW', /\p{Script=Hebrew}/u],
  ['DEVANAGARI', /\p{Script=Devanagari}/u],
  ['HANGUL', /\p{Script=Hangul}/u],
  ['THAI', /\p{Script=Thai}/u],
  ['ARMENIAN', /\p{Script=Armenian}/u],
  ['GEORGIAN', /\p{Script=Georgian}/u],
];

/** The first-name-word equivalent for one letter character (`'cjk'` for Han/kana). */
function scriptOf(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x3005) return 'IDEOGRAPHIC';
  if (cp === 0x30fc) return 'cjk';
  if (CJK_SCRIPT.test(ch)) return 'cjk';
  for (const [script, pattern] of NAMED_SCRIPTS) if (pattern.test(ch)) return script;
  return 'OTHER';
}

const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const LETTER = /^\p{L}$/u;
const NON_SPACING_MARK = /\p{Mn}/gu;

/** One transcription (or message) after normalisation: its gram set, weight and dominant script. */
type Analysis = {
  readonly grams: ReadonlySet<string>;
  readonly weight: number;
  readonly dominant: string | null;
};

/**
 * `analyse(s)` of the SPEC: NFKC + casefold, strip numerals, split into cjk characters and words,
 * take CJK character bigrams and word-internal character trigrams, and report
 * `w = cjkChars + 2 × words` and the dominant script (compared in UNITS, chars vs words).
 *
 * Deliberately reproduces two reference-implementation quirks rather than "fixing" them, because the
 * fixture compares both sides: a one-character CJK line has NO bigram, and a word shorter than three
 * characters becomes one whole-word gram. The dominant-script tie-break is first-seen order, as
 * Python's `max(dict, key=dict.get)` is.
 */
function analyse(text: string, mode: OmissionFillNumeralMode): Analysis {
  const normalised = stripNumerals(caseFold(text), mode);
  const cjk: string[] = [];
  const words: string[] = [];
  let currentWord: string[] = [];
  const counts = new Map<string, number>(); // insertion order == first occurrence, for the tie-break

  const flushWord = (): void => {
    if (currentWord.length > 0) {
      words.push(currentWord.join(''));
      currentWord = [];
    }
  };

  for (const ch of normalised) {
    if (LETTER_OR_MARK.test(ch)) {
      const script = LETTER.test(ch) ? scriptOf(ch) : null;
      if (script === 'cjk') {
        cjk.push(ch);
        counts.set('cjk', (counts.get('cjk') ?? 0) + 1);
        flushWord();
      } else {
        if (script !== null) counts.set(script, (counts.get(script) ?? 0) + 1);
        currentWord.push(ch);
      }
    } else {
      flushWord();
    }
  }
  flushWord();

  // The reference strips combining marks from EVERY word as soon as the string contains any letter of
  // a Latin / Cyrillic / Greek script — a string-global condition, not a per-word one. Mirror it.
  const stripMarks = counts.has('LATIN') || counts.has('CYRILLIC') || counts.has('GREEK');
  const wordsForGrams = stripMarks
    ? words.map((word) => word.normalize('NFD').replace(NON_SPACING_MARK, ''))
    : words;

  const grams = new Set<string>();
  for (let i = 0; i < Math.max(0, cjk.length - 1); i += 1) {
    grams.add(`c:${cjk[i]}${cjk[i + 1]}`);
  }
  for (const word of wordsForGrams) {
    const chars = [...word];
    for (let i = 0; i < Math.max(1, chars.length - 2); i += 1) {
      grams.add(`w:${chars.slice(i, i + 3).join('')}`);
    }
  }

  let dominant: string | null = null;
  if (counts.size > 0) {
    if ((counts.get('cjk') ?? 0) >= words.length) {
      dominant = 'cjk';
    } else {
      // max() over the non-cjk counts, first-seen wins ties (Python dict insertion order).
      let bestScript: string | null = null;
      let bestCount = -1;
      for (const [script, count] of counts) {
        if (script === 'cjk') continue;
        if (count > bestCount) {
          bestScript = script;
          bestCount = count;
        }
      }
      dominant = bestScript;
    }
  }

  return { grams, weight: cjk.length + 2 * words.length, dominant };
}

/** `max(dict, key=dict.get)` with insertion-order tie-breaking. */
function modeOf(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

// ── the rule (§2–§4) ──────────────────────────────────────────────────────────────────────────────

/**
 * `planOmissionFills(finals, executed, params, speechStarts)` — rule v2's single implementation.
 *
 * For each final `x_i`:
 *  1. eligibility — `w(x_i) ≥ wMin`, non-empty grams;
 *  2. hallucination guard — a short line (`w < wHallu`) whose script differs from the mode of the
 *     previous ≤ `domN` transcriptions is not filled;
 *  3. decision time `T_i` — see {@link OmissionFill.dueAt};
 *  4. the covering window `[t_i − lookbackMs, T_i]` — messages in another script make the item
 *     incomparable (never fill); same-script coverage `≥ scoreT` means the model carried it.
 *
 * @param finals       final transcriptions in arrival order (empty transcripts may be included; they
 *                     are skipped by the weight rule).
 * @param executed     EXECUTED relay messages in arrival order — calls from cancelled responses must
 *                     have been filtered out by the caller.
 * @param params       the locked parameters; this module supplies no defaults.
 * @param speechStarts `input_audio_buffer.speech_started` arrival times, used ONLY by the silence
 *                     branch of `T_i`. Omitted/empty means "the user did not speak again".
 */
export function planOmissionFills(
  finals: readonly OmissionFillFinal[],
  executed: readonly OmissionFillExecuted[],
  params: OmissionFillParams,
  speechStarts: readonly number[] = [],
): OmissionFillPlan {
  const finalAnalyses = finals.map((final) => analyse(final.text, params.numeralMode));
  const executedAnalyses = executed.map((message) => analyse(message.text, params.numeralMode));

  const fills: OmissionFill[] = [];
  const skipped: OmissionFillSkip[] = [];

  for (let index = 0; index < finals.length; index += 1) {
    const { t } = finals[index];
    const { grams, weight, dominant } = finalAnalyses[index];

    if (weight < params.wMin) {
      skipped.push({ index, reason: 'weight' });
      continue;
    }
    if (grams.size === 0) {
      skipped.push({ index, reason: 'empty-grams' });
      continue;
    }

    // §2.3 — wrong-script short line: compare against the mode of the previous ≤ domN transcriptions.
    const prior = new Map<string, number>();
    for (let j = Math.max(0, index - params.domN); j < index; j += 1) {
      const priorDominant = finalAnalyses[j].dominant;
      if (priorDominant !== null) prior.set(priorDominant, (prior.get(priorDominant) ?? 0) + 1);
    }
    const priorMode = modeOf(prior);
    if (priorMode !== null && dominant !== priorMode && weight < params.wHallu) {
      skipped.push({ index, reason: 'wrong-script' });
      continue;
    }

    // §3 — the decision time.
    const firstExecuted = executed.find((message) => message.t >= t - params.lookbackMs);
    let dueAt: number;
    if (firstExecuted !== undefined && firstExecuted.t <= t + params.hMs) {
      dueAt = Math.min(firstExecuted.t + params.gMs, t + params.hMs);
    } else if (
      params.silenceMs !== null &&
      !speechStarts.some((startedAt) => startedAt > t && startedAt <= t + (params.silenceMs as number))
    ) {
      dueAt = t + params.silenceMs;
    } else {
      dueAt = t + params.hMs;
    }

    // §4 — the covering window, the cross-script refusal, and coverage.
    const window: number[] = [];
    for (let k = 0; k < executed.length; k += 1) {
      const at = executed[k].t;
      if (at >= t - params.lookbackMs && at <= dueAt) window.push(k);
    }

    let coverage = 0;
    if (window.length > 0) {
      const messageScripts = new Map<string, number>();
      for (const k of window) {
        const messageDominant = executedAnalyses[k].dominant;
        if (messageDominant !== null) {
          messageScripts.set(messageDominant, (messageScripts.get(messageDominant) ?? 0) + 1);
        }
      }
      const messageMode = modeOf(messageScripts);
      if (messageMode !== null && messageMode !== dominant) {
        skipped.push({ index, reason: 'incomparable' });
        continue;
      }
      const union = new Set<string>();
      for (const k of window) for (const gram of executedAnalyses[k].grams) union.add(gram);
      let hits = 0;
      for (const gram of grams) if (union.has(gram)) hits += 1;
      coverage = hits / grams.size;
      if (coverage >= params.scoreT) {
        skipped.push({ index, reason: 'covered' });
        continue;
      }
    }

    fills.push({ index, dueAt, coverage });
  }

  return { fills, skipped };
}
