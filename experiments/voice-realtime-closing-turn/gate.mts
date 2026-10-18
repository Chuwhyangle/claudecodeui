/**
 * The mechanical gate between replay stages — the human read, made fast enough to sit inside a
 * 10-minute wall clock. Pure: it takes run records (the `traces/*.json` shape) and returns a verdict.
 *
 * WHY RELATIVE TO K, NOT TO THE ASR. The endpoint's transcript is not the ground truth of what the
 * model should deliver (the model's relay can be more faithful than the ASR — see the prefix-history
 * experiment). So a unit counts as LOST only when K, on the SAME audio, delivered it and the candidate
 * did not. Whatever K itself drops (noise fragments, a truncated call) is shared and not charged.
 *
 * Verdicts: PASS (proceed) · REVIEW (a human reads the timeline before the next stage) · FAIL.
 */

export type TimelineEntry = {
  at: number;
  kind: string;
  text?: unknown;
  tool?: string;
  message?: unknown;
  trigger?: string;
};

export type RunRecord = {
  window: string;
  arm: string;
  spendCny?: number;
  driftMs?: number;
  abortedAt?: string | null;
  error?: string;
  timeline?: TimelineEntry[];
};

export type GateVerdict = {
  window: string;
  arm: string;
  verdict: 'PASS' | 'REVIEW' | 'FAIL';
  lostUnits: string[];
  textRepliesCandidate: number;
  textRepliesK: number;
  interruptsK: number;
  interruptsCandidate: number;
  costRatio: number | null;
  reasons: string[];
};

/** The cost ceiling per candidate arm, as a fraction of K on the same audio (yesterday: N1 0.50–0.63). */
export const COST_RATIO_LIMIT: Readonly<Record<string, number>> = { N1: 0.7, NS: 0.65 };
export const DRIFT_WARN_MS = 400;
export const DRIFT_FAIL_MS = 800;
const COVERED = 0.5;

const normalize = (value: unknown): string => String(value ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();

const bigrams = (text: string): string[] => {
  if (text.length < 2) return text === '' ? [] : [text];
  const out: string[] = [];
  for (let i = 0; i + 1 < text.length; i++) out.push(text.slice(i, i + 2));
  return out;
};

/** Fraction of the unit's character bigrams that appear in what was delivered. */
export function coverage(unit: string, delivered: string): number {
  const grams = bigrams(normalize(unit));
  if (grams.length === 0) return 1;
  const haystack = normalize(delivered);
  return grams.filter((g) => haystack.includes(g)).length / grams.length;
}

const timelineOf = (r: RunRecord): TimelineEntry[] => r.timeline ?? [];

/** What reached the session: every session_send / session_interrupt message, in order. */
export function deliveredText(r: RunRecord): string {
  return timelineOf(r)
    .filter((e) => e.kind === 'CALL')
    .map((e) => String(e.message ?? ''))
    .join('\n');
}

/** ASR finals with words in them. */
export function units(r: RunRecord): string[] {
  return timelineOf(r)
    .filter((e) => e.kind === 'ASR')
    .map((e) => String(e.text ?? ''))
    .filter((t) => normalize(t) !== '');
}

/**
 * Text replies to the person's OWN speech: a non-empty `response.text.done` on a response the endpoint's
 * VAD started. The closing turn K asks for is excluded (it is an expected "OK", not a reply).
 */
export function textReplies(r: RunRecord): number {
  let trigger = 'vad';
  let count = 0;
  for (const e of timelineOf(r)) {
    if (e.kind === 'RESP') trigger = String(e.trigger ?? 'vad');
    else if (e.kind === 'TEXT' && trigger === 'vad' && normalize(e.text) !== '') count += 1;
  }
  return count;
}

export const interrupts = (r: RunRecord): number =>
  timelineOf(r).filter((e) => e.kind === 'CALL' && e.tool === 'session_interrupt').length;

export function evaluate(k: RunRecord, candidate: RunRecord): GateVerdict {
  const reasons: string[] = [];
  let verdict: GateVerdict['verdict'] = 'PASS';
  const rank = { PASS: 0, REVIEW: 1, FAIL: 2 } as const;
  const worsen = (to: GateVerdict['verdict'], why: string): void => {
    reasons.push(why);
    if (rank[to] > rank[verdict]) verdict = to;
  };

  const kDelivered = deliveredText(k);
  const cDelivered = deliveredText(candidate);
  const seen = new Set<string>();
  const lostUnits: string[] = [];
  for (const unit of [...units(k), ...units(candidate)]) {
    const key = normalize(unit);
    if (seen.has(key)) continue;
    seen.add(key);
    if (coverage(unit, kDelivered) >= COVERED && coverage(unit, cDelivered) < COVERED) lostUnits.push(unit);
  }
  if (lostUnits.length > 0) worsen('FAIL', `lost ${lostUnits.length} unit(s) K delivered: ${JSON.stringify(lostUnits)}`);

  const ik = interrupts(k);
  const ic = interrupts(candidate);
  if (ic < ik) worsen('FAIL', `missed a stop: ${ic} interrupt call(s) vs K's ${ik}`);
  else if (ic > ik) worsen('REVIEW', `${ic - ik} extra interrupt call(s) vs K — a human reads whether any was a false stop`);

  const tk = textReplies(k);
  const tc = textReplies(candidate);
  // A text reply is information, not a verdict: whether it cost the person a sentence is already
  // decided by `lostUnits` (a reply that swallowed a unit is lost there), and the production proxy
  // relays the unanswered words verbatim after one. 2026-10-15 W2/N1 read by hand: one reply, to a
  // noise fragment, harmless. It FAILS only when it is a pattern (> K + 2) — the N0 failure's shape.
  if (tc > tk + 2) worsen('FAIL', `${tc} text replies vs K's ${tk}`);
  else if (tc > tk) reasons.push(`info: ${tc} text replies vs K's ${tk}`);

  let costRatio: number | null = null;
  if (typeof k.spendCny === 'number' && k.spendCny > 0 && typeof candidate.spendCny === 'number') {
    costRatio = candidate.spendCny / k.spendCny;
    const limit = COST_RATIO_LIMIT[candidate.arm];
    if (limit !== undefined && costRatio > limit) worsen('REVIEW', `cost ${(costRatio * 100).toFixed(0)}% of K, limit ${(limit * 100).toFixed(0)}%`);
  } else {
    worsen('REVIEW', 'no spend reading on one side — cost not judged');
  }

  for (const r of [k, candidate]) {
    if (r.error !== undefined) worsen('FAIL', `${r.arm} run has no record: ${r.error.slice(0, 80)}`);
    if (typeof r.abortedAt === 'string') worsen('FAIL', `${r.arm} was cut at ${r.abortedAt.slice(0, 60)}`);
    if ((r.driftMs ?? 0) > DRIFT_FAIL_MS) worsen('FAIL', `${r.arm} drifted ${r.driftMs} ms — not real time`);
    else if ((r.driftMs ?? 0) > DRIFT_WARN_MS) reasons.push(`${r.arm} drifted ${r.driftMs} ms (> ${DRIFT_WARN_MS})`);
  }

  return {
    window: candidate.window,
    arm: candidate.arm,
    verdict,
    lostUnits,
    textRepliesCandidate: tc,
    textRepliesK: tk,
    interruptsK: ik,
    interruptsCandidate: ic,
    costRatio,
    reasons,
  };
}
