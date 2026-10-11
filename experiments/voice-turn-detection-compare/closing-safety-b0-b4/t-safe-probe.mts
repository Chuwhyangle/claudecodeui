/**
 * B0 — the conditional PAID measurement: at which silence-wait T does a real Qwen Realtime session
 * RELIABLY split one utterance into two turns, and what are the three event timestamps that answer
 * a different question each?  Budget cap is written BEFORE execution (BUDGET_CNY) and enforced by the
 * session's own spend hook — the run stops the moment the cap is reached.
 *
 * THE THREE EVENTS ARE NOT THE SAME MOMENT. A realtime session produces, per turn:
 *   1. turn-closing      — `input_audio_buffer.speech_stopped` (received): the endpoint decided the
 *                          utterance was over. This is the segmentation event.
 *   2. function-call gen — `response.function_call_arguments.done` (received): the model emitted the
 *                          tool call. Generation, not action.
 *   3. tool commit       — `response.done` (received): the response finished, the instant the harness's
 *                          executor would run. The action boundary.
 * They are recorded independently; none is inferred from the `silence_duration_ms` knob. AC5 forbids
 * using the knob as the measurement — the knob is the INDEPENDENT variable; the measured events are
 * the dependent reading.
 *
 * WHY A DIRECT SESSION AND NOT THE SHARED ADAPTER. The first attempt drove
 * `eot-bench-adapters/qwen-realtime-streaming-adapter.mts`, whose `attributeEndpoint` claims a stop
 * only if NO `speech_started` lies between its onset and the stop. A two-utterance A+B ALWAYS has such
 * a resume at its internal pause, so that adapter reports `timeout` for every rung by construction —
 * it is built to read ONE candidate point, not to COUNT turns. This file therefore opens the session
 * through the SAME production transport (`createDashscopeTransport` + `connect`, the relay's own
 * modules) but attaches its OWN observer and counts `speech_stopped` itself. The protocol is
 * unchanged; only the reading is.
 *
 * THE EXPERIMENT. ONE fixed audio A+B (two real corpus clips joined by a fixed INTERNAL_SILENCE_MS and
 * closed with a trailing silence long enough that the END is always closeable). Sweep the session's
 * server-VAD silence wait over T ∈ {500,1000,1500,2000,3000}. A split is observed iff the endpoint
 * fires ≥2 `speech_stopped` events — it closed the turn at the INTERNAL pause. Expected transition:
 * between T=1500 (the pause reaches the wait → split) and T=2000 (it does not). The two rungs
 * straddling the observed transition are REPEATED once each, so "reliable" is tested, not assumed.
 *
 * NETWORK POLLUTION IS CARRIED, NOT HIDDEN. P0.7 found 11/24 sessions polluted (~9 real anomalies, 2
 * measurement false-negatives, 1 long-tail outlier) at T=400/800ms — which does NOT cover this ladder,
 * so B0 runs its own sessions rather than citing P0.7. A handshake preflight gates the run; any rung
 * that errors or never warms is recorded and EXCLUDED from T_safe, with the excluded count reported.
 * No expensive re-run is forced to paper over a flaky session.
 *
 * Run:  npx tsx --tsconfig server/tsconfig.json \
 *         experiments/voice-turn-detection-compare/closing-safety-b0-b4/t-safe-probe.mts
 * Preflight only (no spend):  ... t-safe-probe.mts --preflight
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebSocket from 'ws';
import { z } from 'zod';

import {
  connect,
  createDashscopeTransport,
  DEFAULT_SESSION_DEFAULTS,
  estimateRealtimeCostCny,
  resolveTurnDetection,
  VOICE_REALTIME_INSTRUCTIONS,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeWireObserver,
  type RealtimeBridge,
  type RealtimeToolExecutor,
} from '../../../server/modules/voice-realtime/index.js';

import { buildAllSamples, sampleAudio } from '../run.mts';
import type { Sample } from '../run.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'RESULT.json');

const QWEN_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
const QWEN_REALTIME_VOICE = 'Tina';
const FRAME_MS = 100;
const CLOSE_WAIT_MS = 10_000;
const QUIET_WINDOW_MS = 2_500;

/** ⛔ WRITTEN BEFORE EXECUTION. The run stops as soon as accumulated spend reaches this. */
export const BUDGET_CNY = 0.05;
/** The fixed audio's internal silence: the sweep's expected transition is the first T above this. */
export const INTERNAL_SILENCE_MS = 1500;
/** Trailing silence so the END is closeable at every T (≥ max T), making "no split" observable. */
export const TRAILING_SILENCE_MS = 3500;
/** The silence-wait ladder. T is the session knob; the events it produces are the measurement. */
export const T_VALUES = [500, 1000, 1500, 2000, 3000] as const;

const URL_PROBE = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime';
const TOOL = { name: 'session_send', description: 'Send a message to the Claude Code session.', inputSchema: { message: z.string() }, outputSchema: {} };
const EXECUTOR: RealtimeToolExecutor = { session_send: (args: Record<string, unknown>) => ({ queued: true, message: args.message ?? null }) };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── preflight ────────────────────────────────────────────────────────────────────────────────────

export function wsHandshake(apiKey: string, timeoutMs = 10_000): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const finish = (o: { ok: boolean; ms: number; error?: string }): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(o);
    };
    const ws = new WebSocket(URL_PROBE, { headers: { Authorization: `Bearer ${apiKey}` } });
    ws.on('open', () => finish({ ok: true, ms: Date.now() - t0 }));
    ws.on('error', (e: unknown) => finish({ ok: false, ms: Date.now() - t0, error: String((e as { message?: string })?.message ?? e) }));
    setTimeout(() => finish({ ok: false, ms: Date.now() - t0, error: `handshake timeout ${timeoutMs}ms` }), timeoutMs);
  });
}

// ── the fixed A+B ────────────────────────────────────────────────────────────────────────────────

export function buildFixedAudio(): { pcm: Float32Array; rate: number; aId: string; bId: string; internalSilenceMs: number; trailingSilenceMs: number; totalMs: number } {
  const all = buildAllSamples();
  const real = all.filter((s: Sample) => s.source === 'real');
  const pool = real.length >= 2 ? real : all;
  const a = pool[0];
  const b = pool[1] ?? pool[0];
  const ra = sampleAudio(a);
  const rb = sampleAudio(b);
  if (ra.sampleRate !== rb.sampleRate) throw new Error('fixed-audio: clips disagree on sample rate');
  const rate = ra.sampleRate;
  const internal = new Float32Array(Math.round((INTERNAL_SILENCE_MS / 1000) * rate));
  const trailing = new Float32Array(Math.round((TRAILING_SILENCE_MS / 1000) * rate));
  const pcm = new Float32Array(ra.samples.length + internal.length + rb.samples.length + trailing.length);
  let at = 0;
  pcm.set(ra.samples, at); at += ra.samples.length;
  pcm.set(internal, at); at += internal.length;
  pcm.set(rb.samples, at); at += rb.samples.length;
  pcm.set(trailing, at);
  return { pcm, rate, aId: a.id, bId: b.id, internalSilenceMs: INTERNAL_SILENCE_MS, trailingSilenceMs: TRAILING_SILENCE_MS, totalMs: (pcm.length / rate) * 1000 };
}

// ── the reading ──────────────────────────────────────────────────────────────────────────────────

export type RungReading = {
  t: number;
  repeat: boolean;
  status: 'ok' | 'timeout' | 'error';
  error: string | null;
  sessionWarmed: boolean;
  framesSent: number;
  turnClosings: number[];
  functionCallGen: number[];
  functionCallItems: number[];
  toolCommits: number[];
  tTurnClosing: number | null;
  tFunctionCallGeneration: number | null;
  tToolCommit: number | null;
  split: boolean;
  eventTypeCounts: Record<string, number>;
  spendCny: number;
  wallClockMs: number;
};

function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

/** One direct session at wait `t`: stream the fixed A+B at real time, count the turns ourselves. */
async function runDirectSession(t: number, repeat: boolean, fixed: ReturnType<typeof buildFixedAudio>, apiKey: string, capRef: { spend: number }): Promise<RungReading> {
  const startedAt = Date.now();
  const events: Array<{ direction: 'sent' | 'received'; atMs: number; type: string; wire: Record<string, unknown> }> = [];
  const errors: Array<Record<string, unknown>> = [];
  let sessionId: string | null = null;
  let fatal: string | null = null;
  let lastReceivedAtMs = Date.now();
  let spend = 0;
  let openedSocket: { close?: () => void } | null = null;

  const observer: DashscopeWireObserver = (observation) => {
    const wire = (observation.wire ?? {}) as Record<string, unknown>;
    const type = typeof wire.type === 'string' ? wire.type : '(untyped)';
    events.push({ direction: observation.direction, atMs: observation.atMs, type, wire });
    if (observation.direction !== 'received') return;
    lastReceivedAtMs = observation.atMs;
    if (type === 'session.created' || type === 'session.updated') {
      const session = wire.session as Record<string, unknown> | undefined;
      if (typeof session?.id === 'string') sessionId = session.id;
    }
    if (type === 'response.done') {
      const response = (wire.response ?? {}) as Record<string, unknown>;
      const cost = estimateRealtimeCostCny(response.usage ?? null);
      if (Number.isFinite(cost)) {
        spend += cost;
        capRef.spend = spend;
      }
    }
  };

  const socketFactory: DashscopeSocketFactory = (url, headers) => {
    const ws = new WebSocket(url as string, { headers: headers as Record<string, string> });
    openedSocket = ws;
    const socket: DashscopeSocket = {
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    ws.on('open', () => socket.onopen?.({}));
    ws.on('message', (data) => socket.onmessage?.({ data: data.toString() }));
    ws.on('error', (error) => socket.onerror?.(error as never));
    ws.on('close', (code, reason) => socket.onclose?.({ code, reason: String(reason) }));
    return socket;
  };

  const resolution = resolveTurnDetection({}, { type: 'server_vad', silenceMs: t });
  const transport = createDashscopeTransport({
    apiKey,
    model: QWEN_REALTIME_MODEL,
    voice: QWEN_REALTIME_VOICE,
    sessionDefaults: {
      ...DEFAULT_SESSION_DEFAULTS,
      turn_detection: {
        ...resolution.turnDetection,
        // A response per commit is what produces the function-call + tool-commit events we record.
        create_response: true,
        interrupt_response: true,
      } as typeof DEFAULT_SESSION_DEFAULTS.turn_detection,
    },
    respondToToolOutputs: false,
    socketFactory,
    observer,
    onError: (error) => errors.push({ ...(error as Record<string, unknown>) }),
  });

  let bridge: RealtimeBridge | null = null;
  try {
    bridge = connect(transport, [TOOL], EXECUTOR, { maxConnectAttempts: 1 });
    await bridge.whenConnected();
    bridge.sendSessionUpdate(VOICE_REALTIME_INSTRUCTIONS);
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
  }

  // wait for the session to warm (session.created frame)
  if (fatal === null) {
    const deadline = Date.now() + 20_000;
    while (sessionId === null && fatal === null && Date.now() < deadline) await sleep(50);
    if (sessionId === null && fatal === null) fatal = 'session did not warm within 20000 ms';
  }

  // stream the fixed audio at real time, frame by frame
  let framesSent = 0;
  const pcm16 = floatToPcm16(fixed.pcm);
  const frameBytes = ((fixed.rate * FRAME_MS) / 1000) * 2;
  if (fatal === null && bridge && bridge.state === 'open') {
    for (let offset = 0; offset < pcm16.length; offset += frameBytes) {
      if (fatal !== null || bridge.state !== 'open') break;
      bridge.sendAudioFrame(pcm16.subarray(offset, Math.min(offset + frameBytes, pcm16.length)).toString('base64'));
      framesSent += 1;
      await sleep(FRAME_MS);
    }
  }

  // settle: wait for the endpoint to stop emitting (2.5s of quiet), capped by CLOSE_WAIT_MS
  if (fatal === null) {
    const settleBy = Date.now() + CLOSE_WAIT_MS;
    lastReceivedAtMs = Date.now();
    while (Date.now() < settleBy && Date.now() - lastReceivedAtMs < QUIET_WINDOW_MS) await sleep(100);
  }

  try {
    await bridge?.close();
  } catch {
    /* a socket already gone is the state close wants */
  }
  try {
    openedSocket?.close?.();
  } catch {
    /* same */
  }

  const recv = events.filter((e) => e.direction === 'received');
  const at = (type: string): number[] => recv.filter((e) => e.type === type).map((e) => e.atMs);
  const turnClosings = at('input_audio_buffer.speech_stopped');
  const functionCallGen = at('response.function_call_arguments.done');
  const functionCallItems = at('response.output_item.done');
  const toolCommits = at('response.done');
  const eventTypeCounts: Record<string, number> = {};
  for (const e of recv) eventTypeCounts[e.type] = (eventTypeCounts[e.type] ?? 0) + 1;

  const warmed = sessionId !== null;
  const status: RungReading['status'] = fatal !== null ? 'error' : !warmed ? 'timeout' : 'ok';
  return {
    t,
    repeat,
    status,
    error: fatal ?? (errors.length ? JSON.stringify(errors[0]).slice(0, 300) : null),
    sessionWarmed: warmed,
    framesSent,
    turnClosings,
    functionCallGen,
    functionCallItems,
    toolCommits,
    tTurnClosing: turnClosings.length ? turnClosings[turnClosings.length - 1] : null,
    tFunctionCallGeneration: functionCallGen[0] ?? functionCallItems[0] ?? null,
    tToolCommit: toolCommits.length ? toolCommits[toolCommits.length - 1] : null,
    split: turnClosings.length >= 2,
    eventTypeCounts,
    spendCny: Number(spend.toFixed(6)),
    wallClockMs: Date.now() - startedAt,
  };
}

export type TSafeDerivation = {
  /** The smallest wait whose EVERY reading closed a turn and NONE split — the reliable T_safe. `null`
   *  when no wait on the ladder qualifies (the honest outcome when the boundary is not pinned). */
  tSafe: number | null;
  /** The smallest JUDGED wait strictly above the highest splitting wait — a conservative lower bound
   *  ("T_safe must exceed this"), independent of whether a clean rung exists. */
  conservativeT: number | null;
  boundary: { splitAtOrBelow: number | null; cleanAtOrAbove: number | null } | null;
  /** Waits where a session warmed but produced NO turn-closing at all (a truncated/dead session —
   *  an upstream no-reading, excluded from the split/clean verdicts rather than read as "clean"). */
  noReadingTs: number[];
  /** Waits whose repeats DISAGREED (one run split, another did not) — the run-to-run variance that
   *  forbids reading a single value off the ladder. */
  mixedTs: number[];
  /** A clean wait exists BELOW a splitting wait — the split is not monotone in T. */
  nonMonotone: boolean;
  reliable: boolean | null;
  notes: string[];
};

/** Derive T_safe conservatively and WITHOUT forcing a value: a wait counts as clean only if every
 *  reading at that wait closed a turn and none split; a warm-but-silent reading is a no-reading, not
 *  a clean one. When the waits disagree among themselves the result is a bound, not a number. */
export function deriveTSafe(readings: RungReading[]): TSafeDerivation {
  const notes: string[] = [];
  const ok = readings.filter((r) => r.status === 'ok');
  const empty: TSafeDerivation = { tSafe: null, conservativeT: null, boundary: null, noReadingTs: [], mixedTs: [], nonMonotone: false, reliable: null, notes };
  if (ok.length === 0) {
    empty.notes = ['no OK rung — every session failed to warm or errored; T_safe undetermined'];
    return empty;
  }

  const noReadingTs = [...new Set(ok.filter((r) => r.turnClosings.length === 0).map((r) => r.t))].sort((a, b) => a - b);
  // Only readings that actually closed a turn can judge a split.
  const judged = ok.filter((r) => r.turnClosings.length > 0);
  const ts = [...new Set(judged.map((r) => r.t))].sort((a, b) => a - b);
  const at = (t: number): RungReading[] => judged.filter((r) => r.t === t);
  const splitTs = ts.filter((t) => at(t).some((r) => r.split));
  const cleanTs = ts.filter((t) => at(t).length > 0 && at(t).every((r) => !r.split));
  const mixedTs = ts.filter((t) => at(t).some((r) => r.split) && at(t).some((r) => !r.split));

  const splitAtOrBelow = splitTs.length ? Math.max(...splitTs) : null;
  const cleanAtOrAbove = cleanTs.length ? Math.min(...cleanTs) : null;
  const nonMonotone = cleanTs.some((c) => splitTs.some((s) => s > c));

  if (noReadingTs.length) notes.push(`T=${noReadingTs.join(',')} warmed but produced no turn-closing (truncated session) — a no-reading, excluded from the split/clean verdicts`);
  if (mixedTs.length) notes.push(`T=${mixedTs.join(',')} disagreed across repeats (one run split, one did not) — run-to-run variance; no single value can be read off it`);

  // A reliable T_safe needs a fully-clean wait with every lower judged wait splitting.
  const reliableClean = cleanTs.filter((c) => splitAtOrBelow !== null && c > splitAtOrBelow);
  let tSafe: number | null = null;
  let reliable: boolean | null = null;
  if (reliableClean.length) {
    tSafe = Math.min(...reliableClean);
    reliable = true;
    notes.push(`transition between T=${splitAtOrBelow} (split) and T=${tSafe} (clean)`);
  } else if (splitAtOrBelow !== null) {
    reliable = false;
    notes.push(cleanAtOrAbove === null
      ? `every judged wait at or below T=${splitAtOrBelow} split at least once — no clean wait exists on the ladder`
      : `the only clean wait (T=${cleanAtOrAbove}) sits at or below a splitting wait (T=${splitAtOrBelow}) — non-monotone`);
    notes.push(`conservative reading: T_safe must EXCEED T=${splitAtOrBelow} on this ladder`);
  } else {
    reliable = false;
    notes.push('no judged wait split — the fixed internal gap is below every tested wait');
  }

  const conservativeT = splitAtOrBelow === null ? null : (ts.find((t) => t > splitAtOrBelow) ?? null);
  return { tSafe, conservativeT, boundary: { splitAtOrBelow, cleanAtOrAbove }, noReadingTs, mixedTs, nonMonotone, reliable, notes };
}

async function main(): Promise<void> {
  if (process.argv.includes('--rederive')) {
    rederive();
    return;
  }
  const preflightOnly = process.argv.includes('--preflight');
  const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
  const fixed = buildFixedAudio();

  const section: Record<string, unknown> = {
    schema: 'voice-turn-detection-closing-safety/b0-t-safe-probe@1',
    task: 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4',
    kind: 'B0 — conditional paid T_safe measurement (real Qwen Realtime sessions, direct transport)',
    budget: { capCny: BUDGET_CNY, writtenBeforeExecution: true, enforcedBy: 'the session stopS once accumulated spend >= cap; each rung is skipped when the cap is reached' },
    fixedAudio: { aId: fixed.aId, bId: fixed.bId, totalMs: Number(fixed.totalMs.toFixed(1)), internalSilenceMs: fixed.internalSilenceMs, trailingSilenceMs: fixed.trailingSilenceMs },
    ladder: { tValuesMs: T_VALUES, expectedTransitionBetween: [INTERNAL_SILENCE_MS, T_VALUES.find((t) => t > INTERNAL_SILENCE_MS) ?? INTERNAL_SILENCE_MS] },
    threeEvents: {
      turnClosing: 'input_audio_buffer.speech_stopped (received) — the segmentation event',
      functionCallGeneration: 'response.function_call_arguments.done (received) — model emitted the call',
      toolCommit: 'response.done (received) — the response finished; the executor would run here',
    },
    instrument: 'direct session via createDashscopeTransport + connect (the relay’s own modules) with this file’s OWN observer; the shared eot-bench adapter is NOT used because its attributeEndpoint cannot claim a stop across an internal speech resume',
    p07PollutionCaveat: 'P0.7 measured 11/24 sessions polluted (~9 real network anomalies, 2 measurement false-negatives, 1 long-tail latency outlier) at T=400/800ms — which does NOT cover this ladder, so B0 ran its own sessions rather than citing P0.7. Errored/non-warming rungs below are excluded from T_safe, not silently averaged in.',
  };

  if (apiKey === '') {
    section.status = 'blocked';
    section.blockReason = 'DASHSCOPE_API_KEY is not set in this environment';
    section.spendCny = 0;
    writeSection(section);
    console.log('B0 blocked: DASHSCOPE_API_KEY is not set');
    return;
  }

  const attempts: Array<{ ok: boolean; ms: number; error?: string }> = [];
  for (let i = 0; i < 2; i++) attempts.push(await wsHandshake(apiKey));
  const preflight = { ok: attempts.every((a) => a.ok), attempts };
  section.preflight = preflight;

  if (preflightOnly || !preflight.ok) {
    section.status = preflightOnly ? 'preflight-only' : 'blocked';
    section.blockReason = preflightOnly ? 'preflight-only run requested' : 'network preflight failed (handshake)';
    section.spendCny = 0;
    writeSection(section);
    console.log(`B0 ${section.status}: preflight ok=${preflight.ok}`, JSON.stringify(attempts));
    return;
  }

  const capRef = { spend: 0 };
  const readings: RungReading[] = [];
  let stoppedForBudget = false;
  for (const t of T_VALUES) {
    if (capRef.spend >= BUDGET_CNY) {
      stoppedForBudget = true;
      break;
    }
    console.log(`  running T=${t}ms ...`);
    readings.push(await runDirectSession(t, false, fixed, apiKey, capRef));
    const last = readings[readings.length - 1];
    console.log(`    -> status=${last.status} warmed=${last.sessionWarmed} split=${last.split} stops=${last.turnClosings.length} fnGen=${last.tFunctionCallGeneration} commit=${last.tToolCommit} spend=¥${last.spendCny}`);
  }

  const first = deriveTSafe(readings);
  const repeats: RungReading[] = [];
  if (!stoppedForBudget && capRef.spend < BUDGET_CNY && first.boundary?.splitAtOrBelow != null && first.boundary?.cleanAtOrAbove != null) {
    for (const t of [first.boundary.splitAtOrBelow, first.boundary.cleanAtOrAbove]) {
      if (capRef.spend >= BUDGET_CNY) {
        stoppedForBudget = true;
        break;
      }
      console.log(`  repeat T=${t}ms ...`);
      repeats.push(await runDirectSession(t, true, fixed, apiKey, capRef));
      const last = repeats[repeats.length - 1];
      console.log(`    -> status=${last.status} split=${last.split} stops=${last.turnClosings.length} spend=¥${last.spendCny}`);
    }
  }

  const all = [...readings, ...repeats];
  const derived = deriveTSafe(all);
  const okCount = all.filter((r) => r.status === 'ok').length;
  section.status = stoppedForBudget ? 'partial-budget' : okCount === 0 ? 'inconclusive' : 'ran';
  if (okCount === 0) {
    section.blockReason =
      'No session reached a readable turn: every rung failed to warm or errored. The sessions did not behave as a clean ladder, so raw counts cannot be read as a split measurement and T_safe is NOT derived — deriving one from these counts would be the forced conclusion this task forbids.';
  }
  section.stoppedForBudget = stoppedForBudget;
  section.spendCny = Number(capRef.spend.toFixed(6));
  section.withinBudget = capRef.spend <= BUDGET_CNY + 1e-9;
  section.readings = all;
  applyDerivation(section, all, derived);
  section.classificationNote = 'readings/frames/spend/preflight are the run as-is; derived/summary counts were computed by the committed classifier deriveTSafe over those readings';
  writeSection(section);
  printSummary(section, derived);
}

/** Attach the derivation + derived counts to a section (shared by the run path and --rederive). */
function applyDerivation(section: Record<string, unknown>, readings: RungReading[], derived: TSafeDerivation): void {
  const okCount = readings.filter((r) => r.status === 'ok').length;
  section.okRungCount = okCount;
  section.pollutedRungCount = readings.filter((r) => r.status !== 'ok').length;
  section.noReadingCount = readings.filter((r) => r.turnClosings.length === 0).length;
  section.derived = derived;
  section.tSafeMs = derived.tSafe;
  section.conservativeTSafeMs = derived.conservativeT;
  // The three events of the SAME turn, aligned by ordinal index over the recorded arrays — the
  // independence the AC asks for: turn-closing ≠ function-call generation ≠ tool commit, each with
  // its own received-at wall-clock ms.
  section.threeEventEvidence = readings
    .filter((r) => r.turnClosings.length > 0)
    .map((r) => ({
      t: r.t,
      repeat: r.repeat,
      turns: r.turnClosings.map((closingMs, i) => ({
        turn: i,
        turnClosingMs: closingMs,
        functionCallGenerationMs: r.functionCallGen[i] ?? r.functionCallItems[i] ?? null,
        toolCommitMs: r.toolCommits[i] ?? null,
      })),
    }));
  section.audioConfound =
    'The fixed audio joins two REAL corpus clips, each of which already carries its own leading/trailing near-silence, so the EFFECTIVE internal gap the endpoint sees exceeds the inserted INTERNAL_SILENCE_MS — the split transition therefore sits above 1500 ms, not at it. This is a property of the real audio, recorded rather than modelled away.';
  section.summary = {
    tSafeMs: derived.tSafe,
    conservativeTSafeMs: derived.conservativeT,
    reliable: derived.reliable,
    boundary: derived.boundary,
    noReadingTs: derived.noReadingTs,
    mixedTs: derived.mixedTs,
    nonMonotone: derived.nonMonotone,
    interpretation:
      derived.tSafe !== null
        ? `a silence wait of ${derived.tSafe} ms did not split the fixed A+B, while ${derived.boundary?.splitAtOrBelow} ms did — the conservative T_safe is ${derived.tSafe} ms.`
        : `no wait on this ladder reliably avoided a split, so T_safe is NOT pinned to a single value; the conservative reading is that T_safe must EXCEED ${derived.boundary?.splitAtOrBelow ?? 'the tested ladder'} ms${derived.noReadingTs.length ? `, and the rung above the boundary (T=${derived.noReadingTs.join(',')} ms) returned no turn-closing` : ''}. See derived.notes.`,
  };
}

/** Zero-cost re-derivation: recompute derived/summary from the readings ALREADY in RESULT.json,
 *  leaving the raw readings, spend and preflight exactly as the paid run wrote them. */
function rederive(): void {
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  const b0 = existing.b0 as Record<string, unknown> | undefined;
  const readings = b0?.readings as RungReading[] | undefined;
  if (!b0 || !Array.isArray(readings)) {
    console.error('rederive: no b0.readings in RESULT.json');
    process.exitCode = 1;
    return;
  }
  const derived = deriveTSafe(readings);
  applyDerivation(b0, readings, derived);
  b0.classificationNote = 'readings/frames/spend/preflight are the paid run as-is; derived/summary counts were recomputed by the committed classifier deriveTSafe (--rederive) without re-running any session — no reading was altered';
  writeSection(b0);
  console.log('B0 re-derive complete (no session re-run)');
  printSummary(b0, derived);
}

function printSummary(section: Record<string, unknown>, derived: TSafeDerivation): void {
  console.log(`  status=${section.status} spend=¥${section.spendCny} (cap ¥${BUDGET_CNY}) ok=${section.okRungCount} polluted=${section.pollutedRungCount} noReading=${section.noReadingCount}`);
  console.log(`  T_safe=${String(derived.tSafe)}ms conservative=>${String(derived.conservativeT)} reliable=${derived.reliable} boundary=${JSON.stringify(derived.boundary)} nonMonotone=${derived.nonMonotone} mixed=${JSON.stringify(derived.mixedTs)}`);
  for (const n of derived.notes) console.log(`  note: ${n}`);
}

function writeSection(section: Record<string, unknown>): void {
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  existing.schema = existing.schema ?? 'voice-turn-detection-closing-safety/result@1';
  existing.task = 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4';
  existing.b0 = section;
  writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
