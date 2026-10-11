/**
 * B1 — corrected re-scoring of P0.8's paired pilot (zero cost, no upstream call).
 *
 * WHY THIS EXISTS. P0.8's mechanical proxy judged a tool call wrong when its `message` carried a
 * "forbidden" (uncorrected / unqualified) target token. For the `self-correction` sample that rule
 * is in direct conflict with the design the SPEC already fixed
 * (`docs/proposals/voice-realtime-segmented-relay-SPEC.md`, D4): the SEGMENTED RELAY does not parse
 * and does not decide — it forwards the speaker's own words verbatim, and the parsing happens
 * downstream. A relay that faithfully forwards 「改一下 voice.service.ts，嗯不对，应该是 voice.routes.ts」
 * MUST carry the pre-correction name: that name is part of what the human said. Judging the relay
 * wrong for it scores the relay on a job it is not supposed to do.
 *
 * WHAT IT CHANGES, AND WHAT IT DOES NOT.
 *   • The forbidden-token rule is narrowed to the case it was meant for: a call whose EFFECTIVE
 *     target is the uncorrected one (forbidden present AND the corrected target ABSENT). A call that
 *     names the corrected target and also carries the pre-correction words is not spurious.
 *   • s6's missing second action (`限制改成二十次每分钟` never forwarded) is NOT touched — it is a
 *     real miss and stays a real miss.
 *   • s7 (the non-address control) is NOT touched — a control that triggers an action is spurious.
 *   • s1's truncated `rawArguments` is not re-labelled by hand; it is re-classified from the CODE
 *     EVIDENCE (see `s1RootCause`): there is no local truncation site, so the string the adapter
 *     recorded is what the endpoint's `done` frame delivered. It is therefore marked UNSCORABLE
 *     (a wire/harness defect), not counted as a model miss.
 *
 * This file WRITES NOTHING into P0.8. `paired-pilot/RESULT.json` and `samples.json` are read-only
 * inputs; the corrected reading lands in THIS directory's `RESULT.json` under the `b1` key.
 *
 * Run:  npx tsx --tsconfig server/tsconfig.json \
 *         experiments/voice-turn-detection-compare/closing-safety-b0-b4/rescore-p0.8.mts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPARE_DIR = path.resolve(DIR, '..');
const P08_DIR = path.join(COMPARE_DIR, 'paired-pilot');
const P08_RESULT = path.join(P08_DIR, 'RESULT.json');
const P08_SAMPLES = path.join(P08_DIR, 'samples.json');
const OUT = path.join(DIR, 'RESULT.json');

// ── the P0.8 shapes we read (structural, so a drift in the source shows up as a loud error) ──────

type Call = { name: string; message: string | null; rawArguments: string | null; delivery?: string };
// P0.8's RESULT.json rows carry the chain outputs + its own judgement; the intent groups and
// forbidden tokens live in samples.json, so they are looked up by id (below), not read off the row.
type P08Row = {
  sample: string;
  scenario: string;
  expectAction: boolean;
  text: string;
  intent: string;
  chainA: { status: string; calls: Call[]; transcript: string | null; eventTypeCounts?: Record<string, number>; error?: string | null };
  chainB: { status: string; calls: Call[]; text: string | null; error?: string | null };
  judgement: { chainA: P08Judgement; chainB: P08Judgement };
};
type P08Judgement = { called: boolean; correct: boolean; spurious: boolean; missed: boolean; reason: string };
type SampleDef = { id: string; intentGroups: string[][]; forbiddenTokens: string[]; expectAction: boolean; intent: string; scenario: string };

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

// ── normalisation — IDENTICAL to P0.8's scorer (run-paired-pilot.mts:339–356), so the original
//    column this file reproduces is a real reproduction, not a second opinion ────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/\s+/g, '');
}
function normId(s: string): string {
  return norm(s).replace(/[.\-_]/g, '');
}
const matches = (haystack: string, token: string): boolean =>
  haystack.includes(norm(token)) || normId(haystack).includes(normId(token));

const allGroupsMatch = (msg: string, groups: string[][]): boolean =>
  groups.every((g) => g.some((tok) => matches(msg, tok)));
const hasForbidden = (msg: string, forbidden: string[]): boolean => forbidden.some((f) => matches(msg, f));

// ── the two scorers ─────────────────────────────────────────────────────────────────────────────

/** P0.8's rule, reproduced verbatim so the "before" column is the pilot's own number. */
function originalJudge(expectAction: boolean, calls: Call[], groups: string[][], forbidden: string[]): P08Judgement {
  const called = calls.length > 0;
  if (!expectAction) {
    return { called, correct: !called, spurious: called, missed: false, reason: called ? 'control sample triggered an action' : 'control sample correctly silent' };
  }
  const anyForbidden = calls.some((c) => hasForbidden(norm(c.message ?? ''), forbidden));
  const matched = calls.some((c) => allGroupsMatch(norm(c.message ?? ''), groups) && !hasForbidden(norm(c.message ?? ''), forbidden));
  const missed = !called;
  const reason = matched
    ? 'message matched every intent group, no forbidden token'
    : missed
      ? 'no tool call produced'
      : anyForbidden
        ? 'message carried a forbidden (uncorrected/unqualified) token'
        : 'message did not match all intent groups';
  return { called, correct: matched, spurious: anyForbidden, missed, reason };
}

/**
 * The corrected rule. Three readings, each a different question:
 *   `complete`      — did ONE call capture the whole intent? (a call naming every intent group)
 *   `completeUnion` — did the turn capture the whole intent AT ALL, across all its calls? A chain
 *                     that over-segments a single instruction into several calls has still said all
 *                     the words; `completeUnion` credits the captured intent, `complete` does not.
 *                     The gap between them IS the over-segmentation cost.
 *   `safe`          — is the payload SAFE to act on? (no call whose effective target is the uncorrected one)
 * A relay forwarding a self-correction is `complete` AND `safe` — it captured the intent and the
 * pre-correction words are the speaker's own, not an instruction to the old target.
 */
type Corrected = {
  called: boolean;
  complete: boolean;
  completeUnion: boolean;
  safe: boolean;
  spurious: boolean;
  missed: boolean;
  unscorable: boolean;
  reason: string;
};

function correctedJudge(expectAction: boolean, calls: Call[], groups: string[][], forbidden: string[]): Corrected {
  const called = calls.length > 0;
  if (!expectAction) {
    return {
      called,
      complete: !called,
      completeUnion: !called,
      safe: !called,
      spurious: called,
      missed: false,
      unscorable: false,
      reason: called ? 'control sample triggered an action (unchanged — a control that acts is spurious)' : 'control sample correctly silent',
    };
  }
  // UNSCORABLE: every produced call has no usable `message` (the argument string never parsed), so
  // there is no semantic payload to judge. This is a wire/harness defect, not a model failure.
  const usable = calls.filter((c) => typeof c.message === 'string' && c.message.length > 0);
  if (called && usable.length === 0) {
    return { called, complete: false, completeUnion: false, safe: true, spurious: false, missed: false, unscorable: true, reason: 'call payload unusable (unparsed/truncated argument string) — wire/harness defect, excluded from both readings' };
  }
  // COMPLETE: some single call names every intent group.
  const complete = usable.some((c) => allGroupsMatch(norm(c.message as string), groups));
  // COMPLETE-UNION: the concatenation of every call's message names every intent group.
  const union = usable.map((c) => norm(c.message as string)).join(' ');
  const completeUnion = allGroupsMatch(union, groups);
  // SAFE: no call delivers the uncorrected target as its EFFECTIVE payload (forbidden present and the
  // corrected target absent). A call carrying both is verbatim forwarding / a clarifying negation.
  const unsafeCall = usable.some((c) => {
    const m = norm(c.message as string);
    return hasForbidden(m, forbidden) && !allGroupsMatch(m, groups);
  });
  const safe = !unsafeCall;
  const missed = !called;
  const reason = completeUnion
    ? unsafeCall
      ? 'captured the intent across calls but a call also targeted the uncorrected token without naming the corrected one'
      : forbidden.length > 0 && calls.some((c) => hasForbidden(norm(c.message ?? ''), forbidden))
        ? 'captured the intent; the pre-correction words are verbatim forwarded speech (D4: the relay does not parse) — NOT spurious'
        : complete
          ? 'captured every intent group in one call'
          : 'captured every intent group but ACROSS several calls (over-segmented — the gap to `complete`)'
    : missed
      ? 'no tool call produced'
      : 'did not name every intent group even across calls (real semantic miss)';
  return { called, complete, completeUnion, safe, spurious: unsafeCall, missed, unscorable: false, reason };
}

// ── s1 root cause: CODE evidence, not a JSON-shape guess ─────────────────────────────────────────

/**
 * The claim is read off the code, not inferred from the artifact's shape. Every site that touches a
 * function-call argument string was read:
 *
 *  1. `experiments/voice-turn-detection-compare/eot-bench-adapters/qwen-realtime-streaming-adapter.mts`
 *     lines 231–238: the wire observer's ONLY function-call case is
 *     `response.function_call_arguments.done`, and it stores `arguments: wire.arguments ?? null`
 *     VERBATIM. There is no `case 'response.function_call_arguments.delta'` — the delta frames hit
 *     `default: break` (249–250) and are never concatenated. So the adapter cannot have truncated the
 *     string; it copies whatever the `done` frame carried.
 *
 *  2. `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts` `toBridgeEvent`
 *     lines 486–491: the `.done` path passes `frame.arguments` straight through (and drops the frame
 *     only when `arguments` is not a string). `functionCallFromItem` (422–433) reads the OTHER
 *     carrier — `response.output_item.done`'s `item.arguments` — and is NOT on the adapter's path.
 *
 *  3. `server/modules/voice-realtime/voice-realtime-bridge.service.ts` line 121 lists
 *     `response.function_call_arguments.delta` in `TOLERATED_ENDPOINT_EVENTS`: production explicitly
 *     IGNORES the incremental half and relies on the completed call arriving whole.
 *
 *  Conclusion: there is NO local truncation site. The prefix `{"message": "把 server 里的 voice service`
 *  is what the endpoint's `done` frame delivered — i.e. the truncation ORIGINATED upstream, in the
 *  argument stream of a response racing the `create_response` (P0.8's own FINDINGS.md classifies it
 *  as the `create_response` streaming race; s1's eventTypeCounts shows 2 `response.created` but only
 *  1 `function_call_arguments.done`).
 *
 *  BUT the defect was PRESERVED unrecoverably by the harness: s1's OWN eventTypeCounts record 5
 *  `response.function_call_arguments.delta` frames and 1 `response.output_item.done` — two redundant
 *  carriers of the same arguments — and neither is consumed. A protocol-faithful harness that
 *  concatenated the delta chunks (or fell back to the item carrier) had the material to reconstruct
 *  the call; this one throws both away BY DESIGN. So: upstream-originated truncation, harness-preserved.
 *
 *  LIMIT OF THE EVIDENCE, STATED: the raw delta PAYLOADS were not persisted (only their counts), so
 *  this file cannot prove the 5 chunks concatenate back to the full string. It proves the mechanism
 *  (no local truncation; deltas discarded), which is what the "harness bug vs upstream" question turns
 *  on. This is a code-level conclusion, not an inference from the JSON's shape.
 */
const S1_ROOT_CAUSE = {
  verdict: 'upstream-originated truncation of the `done` frame, preserved unrecoverably by a harness that discards the delta stream',
  codeSites: [
    { file: 'experiments/voice-turn-detection-compare/eot-bench-adapters/qwen-realtime-streaming-adapter.mts', lines: '231-238', fact: 'only function-call case is `.done`; stores wire.arguments VERBATIM' },
    { file: 'experiments/voice-turn-detection-compare/eot-bench-adapters/qwen-realtime-streaming-adapter.mts', lines: '249-250', fact: '`response.function_call_arguments.delta` falls through to default — never concatenated' },
    { file: 'server/modules/voice-realtime/voice-realtime-dashscope-transport.ts', lines: '486-491', fact: 'toBridgeEvent passes `.done.arguments` straight through; no local mutation' },
    { file: 'server/modules/voice-realtime/voice-realtime-dashscope-transport.ts', lines: '422-433', fact: '`functionCallFromItem` reads the output_item carrier — NOT on the adapter path' },
    { file: 'server/modules/voice-realtime/voice-realtime-bridge.service.ts', lines: '121', fact: 'production tolerates/ignores the delta events by design' },
  ],
  artifactEvidence: {
    observed: 'chainA s1: response.function_call_arguments.delta = 5, response.function_call_arguments.done = 1, response.output_item.done = 1, response.created = 2',
    reading: '5 argument chunks and a completed item arrived and were discarded; a single racing `.done` carried the truncated prefix',
  },
  notProven: 'the delta payloads were not persisted, so a full-string reconstruction from the 5 chunks is not demonstrated — only the mechanism is',
} as const;

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(P08_RESULT)) throw new Error(`P0.8 RESULT.json not found at ${P08_RESULT}`);
  const p08 = readJson<{ rows: P08Row[] }>(P08_RESULT);
  const samplesDoc = readJson<{ samples: SampleDef[] }>(P08_SAMPLES);
  const byId = new Map(samplesDoc.samples.map((s) => [s.id, s]));

  const rows = p08.rows.map((row) => {
    const def = byId.get(row.sample);
    if (!def) throw new Error(`sample ${row.sample} missing from samples.json`);
    const groups = def.intentGroups;
    const forbidden = def.forbiddenTokens;

    const repro = (calls: Call[]): P08Judgement => originalJudge(def.expectAction, calls, groups, forbidden);
    const origA = repro(row.chainA.calls);
    const origB = repro(row.chainB.calls);
    // Self-check: our reproduction of P0.8's rule must match P0.8's own recorded judgement.
    const reproduces = (a: P08Judgement, b: P08Judgement): boolean =>
      a.correct === b.correct && a.spurious === b.spurious && a.missed === b.missed;

    const corrA = correctedJudge(def.expectAction, row.chainA.calls, groups, forbidden);
    const corrB = correctedJudge(def.expectAction, row.chainB.calls, groups, forbidden);

    return {
      sample: row.sample,
      scenario: row.scenario,
      expectAction: def.expectAction,
      intent: def.intent,
      intentGroups: groups,
      forbiddenTokens: forbidden,
      chainA: {
        original: origA,
        corrected: corrA,
        changed: origA.correct !== corrA.complete || origA.spurious !== corrA.spurious,
        messages: row.chainA.calls.map((c) => c.message),
      },
      chainB: {
        original: origB,
        corrected: corrB,
        changed: origB.correct !== corrB.complete || origB.spurious !== corrB.spurious,
        messages: row.chainB.calls.map((c) => c.message),
      },
      reproducesP08Scorer: reproduces(origA, row.judgement.chainA) && reproduces(origB, row.judgement.chainB),
    };
  });

  const rate = (xs: boolean[]): number => (xs.length ? Number((xs.filter(Boolean).length / xs.length).toFixed(4)) : 0);
  const summaryFor = (chain: 'chainA' | 'chainB') => {
    const scorable = rows.filter((r) => !r[chain].corrected.unscorable);
    const complete = scorable.map((r) => r[chain].corrected.complete);
    const completeUnion = scorable.map((r) => r[chain].corrected.completeUnion);
    const safe = scorable.map((r) => r[chain].corrected.safe);
    const spurious = scorable.map((r) => r[chain].corrected.spurious);
    const missed = scorable.map((r) => r[chain].corrected.missed);
    const original = rows.map((r) => r[chain].original.correct);
    return {
      n: rows.length,
      nScorable: scorable.length,
      nUnscorable: rows.length - scorable.length,
      originalCorrectRate: rate(original),
      correctedCompleteRate: rate(complete),
      correctedCompleteUnionRate: rate(completeUnion),
      correctedSafeRate: rate(safe),
      correctedCompleteK: complete.filter(Boolean).length,
      correctedCompleteUnionK: completeUnion.filter(Boolean).length,
      correctedSafeK: safe.filter(Boolean).length,
      spuriousRate: rate(spurious),
      missedRate: rate(missed),
      nChanged: rows.filter((r) => r[chain].changed).length,
    };
  };

  const section = {
    schema: 'voice-turn-detection-closing-safety/b1-rescore@1',
    task: 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4',
    kind: 'B1 — corrected re-scoring of P0.8 (zero cost, read-only on P0.8)',
    sourceOfTruth: { p08Result: path.relative(COMPARE_DIR, P08_RESULT), p08Samples: path.relative(COMPARE_DIR, P08_SAMPLES), readOnly: true, overwritten: false },
    ruleChange: {
      from: "correct iff a call matches all intent groups AND carries no forbidden token; spurious := any forbidden token present",
      to: "complete iff a call matches all intent groups (forbidden no longer blocks); safe iff no call targets the uncorrected token WITHOUT also naming the corrected one; spurious := unsafe call; unscorable := called but no usable message",
      rationale: 'D4 of docs/proposals/voice-realtime-segmented-relay-SPEC.md: the segmented relay does not parse/decide, it forwards the speaker verbatim; parsing happens downstream. Penalising the relay for forwarding the pre-correction words scores it on a job it must not do.',
      untouched: [
        's6 missing second action — a real miss, stays a real miss',
        's7 non-address control that triggered an action — stays spurious',
      ],
    },
    scorerReproduction: {
      note: 'our reproduction of P0.8\'s original rule vs P0.8\'s own recorded judgement',
      allRowsReproduce: rows.every((r) => r.reproducesP08Scorer),
      mismatches: rows.filter((r) => !r.reproducesP08Scorer).map((r) => r.sample),
    },
    summary: { chainA: summaryFor('chainA'), chainB: summaryFor('chainB') },
    perSample: rows,
    s1RootCause: S1_ROOT_CAUSE,
    budget: { newUpstreamCalls: 0, spendCny: 0, note: 'B1 makes no upstream call' },
  };

  const existing = existsSync(OUT) ? readJson<Record<string, unknown>>(OUT) : {};
  existing.schema = existing.schema ?? 'voice-turn-detection-closing-safety/result@1';
  existing.task = 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4';
  existing.b1 = section;
  writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');

  // Console reading (the artifact is the deliverable; this is the same numbers, human-sized).
  console.log('B1 re-scoring complete');
  console.log('  all rows reproduce P0.8 scorer:', section.scorerReproduction.allRowsReproduce);
  for (const chain of ['chainA', 'chainB'] as const) {
    const s = section.summary[chain];
    console.log(`  ${chain}: original ${s.originalCorrectRate} -> complete ${s.correctedCompleteRate} (${s.correctedCompleteK}/${s.nScorable}), completeUnion ${s.correctedCompleteUnionRate} (${s.correctedCompleteUnionK}/${s.nScorable}), safe ${s.correctedSafeRate} (${s.correctedSafeK}/${s.nScorable}), spurious ${s.spuriousRate}, missed ${s.missedRate}, unscorable ${s.nUnscorable}`);
  }
  for (const r of rows) {
    if (r.chainA.changed) console.log(`  changed A: ${r.sample}  [${r.chainA.original.reason}] => [${r.chainA.corrected.reason}]`);
    if (r.chainB.changed) console.log(`  changed B: ${r.sample}  [${r.chainB.original.reason}] => [${r.chainB.corrected.reason}]`);
  }
}

main();
