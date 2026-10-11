/**
 * P0.8 — the minimal PAIRED pilot. Two full chains, one voice, per-example readable.
 *
 * THE QUESTION THIS ANSWERS. P0-P0.7 compared turn DETECTORS (which endpoint rule is best) on one
 * manifest. This pilot asks a different, more end-to-end question the user explicitly redirected
 * to: can the LOW-COST chain — VAD + silence-wait + NON-realtime `qwen3.8-omni-flash` — replace the
 * incumbent `qwen3.8-omni-flash-realtime` Live Voice Agent, end to end? It is 6-7 samples, read
 * per-example, with a Go/No-Go whose thresholds are fixed before the run — NOT a corpus expansion
 * and NOT a new detector.
 *
 * CHAIN A (incumbent) runs the SHIPPING transport: `predictTurnStreaming` opens one real Realtime
 * session per sample through `server/modules/voice-realtime`, streams the audio at real time, and —
 * because this pilot needs the ACTION arm, not only the endpoint — asks for a response
 * (`createResponse:true`) so the model's tool call is observable. The tool executor is a DRY-RUN
 * SINK (`{queued:true}`) that records the call and NEVER delivers it.
 *
 * CHAIN B (candidate) runs the SHIPPING VAD — `StreamingVad` from `src/shared/voiceEndpoint.ts`,
 * the same module the relay runs — fed the audio at real time so the endpoint's wall clock is a
 * real one, plus the chain's DECLARED extra silence-wait (preregistration.chainBSilenceWaitMs): the
 * utterance ends at the first VAD speech_stopped whose following quiet is not interrupted by a
 * speech_start inside the wait. The accumulated speech is then sent in ONE non-realtime
 * `qwen3.8-omni-flash` request with `tool_choice: 'auto'`. Same dry-run sink.
 *
 * NOTHING IS DELIVERED. Neither chain constructs a real `session_send` executor: Chain A passes a
 * plain mock executor object (the shipping `createVoiceRealtimeLiveExecutor` is never imported) and
 * Chain B never calls a tool at all — it only parses what the model emitted from the HTTP response.
 *
 * Run (one sample, to measure real cost before committing the batch):
 *   ONLY=s1-single-command npx tsx --tsconfig server/tsconfig.json \
 *     experiments/voice-turn-detection-compare/paired-pilot/run-paired-pilot.mts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { FRAME_MS as VAD_FRAME_MS, StreamingVad } from '../../../src/shared/voiceEndpoint.ts';
import { predictTurnStreaming } from '../eot-bench-adapters/qwen-realtime-streaming-adapter.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TC = '/data/home/yale/work/tc-verify';

const OMNI_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const OMNI_MODEL = 'qwen3.8-omni-flash';
const REALTIME_SILENCE_MS = 400; // the shipping endpoint default (vad-batch-adapter VAD_ENDPOINT_MS)
const SAMPLE_RATE = 16_000;

const { encodeWav, readWav } = (await import(`${TC}/tools/wav.mjs`)) as {
  encodeWav: (samples: Float32Array, rate?: number) => Buffer;
  readWav: (p: string) => { sampleRate: number; samples: Float32Array };
};

// ── the preregistered gate is READ, never rewritten ──────────────────────────────────────────────

type Sample = {
  id: string;
  scenario: string;
  synthetic: boolean;
  scriptId: string;
  text: string;
  occupancy: string;
  expectAction: boolean;
  intentGroups: string[][];
  forbiddenTokens: string[];
  intent: string;
};

type ManifestEntry = { id: string; totalMs: number; speechEndMs: number; appendedTailMs: number; sha256: string; wav: string };

const samplesDoc = JSON.parse(readFileSync(join(HERE, 'samples.json'), 'utf8')) as {
  samples: Sample[];
  preregistration: {
    costCapCny: number;
    latencyP50MsMax: number;
    latencyP95MsMax: number;
    spuriousTriggerRateMax: number;
    missedTriggerRateMax: number;
    chainBSilenceWaitMs: number;
    keyCaseRequirement: { scenarios: string[] };
  };
  tool: { name: string; description: string; parameters: unknown };
  audioProvenance: { voice: string };
};
if (!samplesDoc.preregistration) throw new Error('samples.json carries no preregistration — refusing to run.');
const manifest = JSON.parse(readFileSync(join(HERE, 'audio', 'manifest.json'), 'utf8')) as ManifestEntry[];
const byId = new Map(manifest.map((m) => [m.id, m]));

const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
const selected = samplesDoc.samples.filter((s) => (ONLY && ONLY.length > 0 ? ONLY.includes(s.id) : true));
const CAP_CNY = samplesDoc.preregistration.costCapCny;
const RESUME_GRACE_MS = samplesDoc.preregistration.chainBSilenceWaitMs; // chain B's declared silence-wait
// A conservative pre-call bound on any ONE upstream call. Observed calls cost ≈¥0.0016 (A) / ≈¥0.0025
// (B), so 0.008 is ~3× the observed max; two calls per sample keeps the batch inside a ¥0.05 cap.
const P_EST_CALL_CNY = 0.008;

// ── the dry-run sink: records calls, delivers nothing ────────────────────────────────────────────

type RecordedCall = { name: string; message: string | null; rawArguments: string | null; delivery: 'dry-run-sink' };

function parseCall(rawName: unknown, rawArguments: unknown): RecordedCall {
  const raw = typeof rawArguments === 'string' ? rawArguments : rawArguments == null ? null : JSON.stringify(rawArguments);
  let message: string | null = null;
  try {
    const parsed = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
    if (parsed && typeof parsed === 'object' && 'message' in (parsed as Record<string, unknown>)) {
      const m = (parsed as Record<string, unknown>).message;
      if (typeof m === 'string') message = m;
    }
  } catch {
    /* keep raw only */
  }
  return { name: typeof rawName === 'string' ? rawName : '(unnamed)', message, rawArguments: raw, delivery: 'dry-run-sink' };
}

// ── Chain A: the incumbent Realtime chain, one real session per sample ───────────────────────────

type ChainA = {
  status: 'ok' | 'timeout' | 'error';
  sessionId: string | null;
  endpointWaitMs: number | null;
  modelOverheadMs: number | null;
  commitToFirstTokenMs: number | null;
  endToCallMs: number | null;
  transcript: string | null;
  calls: RecordedCall[];
  spendCny: number;
  wallClockMs: number;
  eventTypeCounts: Record<string, number>;
  /** How many times the upstream's own VAD declared speech_stopped — the incumbent commits per stop. */
  rawSpeechStops: number;
  error: string | null;
};

async function runChainA(sample: Sample, entry: ManifestEntry, wav: Float32Array, apiKey: string): Promise<ChainA> {
  const span = {
    sampleId: sample.id,
    spanIndex: 0,
    onsetMs: entry.speechEndMs,
    silenceMs: entry.appendedTailMs,
    truth: 'END' as const,
    label: 'eot' as const,
    scenario: sample.scenario,
    audio: wav,
    appendedTailMs: entry.appendedTailMs,
  };
  const prediction = await predictTurnStreaming(span as never, {
    apiKey,
    silenceDurationMs: REALTIME_SILENCE_MS,
    detectorType: 'server_vad',
    createResponse: true,
    timeoutMs: 45_000,
    tool: { name: samplesDoc.tool.name, description: samplesDoc.tool.description, inputSchema: { message: z.string() }, outputSchema: {} },
  });

  const eventTypeCounts: Record<string, number> = {};
  for (const e of prediction.events) if (e.direction === 'received') eventTypeCounts[e.type] = (eventTypeCounts[e.type] ?? 0) + 1;
  const rawSpeechStops = prediction.events.filter(
    (e) => e.direction === 'received' && e.type === 'input_audio_buffer.speech_stopped',
  ).length;

  const calls = prediction.response.toolCalls.map((c) => parseCall(c.name, c.arguments));
  const firstMs = prediction.response.toolCalls[0]?.msSinceCommit ?? null;
  const endToCallMs = prediction.userWaitEndpointMs !== null && firstMs !== null ? prediction.userWaitEndpointMs + firstMs : null;

  return {
    status: prediction.status,
    sessionId: prediction.sessionId,
    endpointWaitMs: prediction.userWaitEndpointMs,
    modelOverheadMs: prediction.modelOverheadMs,
    commitToFirstTokenMs: prediction.response.commitToFirstTokenMs,
    endToCallMs,
    transcript: prediction.transcript,
    calls,
    spendCny: prediction.spendCny,
    wallClockMs: prediction.wallClockMs,
    eventTypeCounts,
    rawSpeechStops,
    error: prediction.error,
  };
}

// ── Chain B: VAD endpoint (paced, shipping rule) → ONE non-realtime Omni request ─────────────────

type ChainB = {
  status: 'ok' | 'error';
  /** speech_stopped events the shipping VAD produced at its own 400 ms rule — its raw fragmentation. */
  vadRawEndEvents: number;
  /** the declared silence-wait; the chain's effective end-of-turn silence is 400 + this. */
  silenceWaitMs: number;
  /** wall ms from the last speech frame to the committed endpoint (400 ms + the un-resumed wait). */
  vadEndpointMs: number | null;
  inferenceMs: number | null;
  endToCallMs: number | null;
  httpStatus: number;
  text: string | null;
  calls: RecordedCall[];
  finishReason: string | null;
  usage: unknown;
  spendCny: number;
  error: string | null;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function omniCost(usage: unknown): number {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(u.input_tokens ?? u.prompt_tokens);
  const output = num(u.output_tokens ?? u.completion_tokens);
  const details = (u.input_tokens_details ?? (u as { prompt_tokens_details?: unknown }).prompt_tokens_details) as
    | { audio_tokens?: unknown; text_tokens?: unknown }
    | undefined;
  const audio = num(details?.audio_tokens);
  const text = num(details?.text_tokens) || Math.max(0, input - audio);
  // Priced with the qwen3.8-omni-flash-realtime table as a PROXY; the non-realtime price is not
  // published in this repo, so the invoice is the authority (the same basis P0.6 recorded).
  return (text * 0.0015 + audio * 0.006 + output * 0.0045) / 1000;
}

const SYSTEM_PROMPT = [
  '你是 CloudCLI 编程助手的语音前端。一个开发者正在对着麦克风口述一个任务。',
  '如果这句话是在对助手发出请求（无论中英混杂，含自我纠正、补充限定、多个动作），就调用 session_send，把开发者最终想要的那条指令写进 message 参数（自我纠正时用更正后的目标，不要用被否掉的那个）。',
  '如果这句话不是在跟助手说话（例如自言自语、念屏幕、思考出声），就不要调用任何工具。',
  '这是一个 dry-run 试点：工具调用只会被记录，不会真正投递。',
].join('\n');

/** One frame of the shipping VAD costs this many samples; the paced feed advances one frame per FRAME_MS. */
function chainBPcm(wav: Float32Array): { pcm: Float32Array; frame: number } {
  const frame = Math.max(1, Math.round((VAD_FRAME_MS / 1000) * SAMPLE_RATE));
  return { pcm: wav.subarray(0, Math.floor(wav.length / frame) * frame), frame };
}

async function runChainB(sample: Sample, entry: ManifestEntry, wav: Float32Array, apiKey: string): Promise<ChainB> {
  const { pcm, frame } = chainBPcm(wav);
  const graceSamples = Math.round((RESUME_GRACE_MS / 1000) * SAMPLE_RATE);
  const vad = new StreamingVad({ sampleRate: SAMPLE_RATE });
  const t0 = Date.now();
  const frameWall: number[] = [];
  // Paced at real time so the endpoint's wall clock is a REAL one, not derivable-from-nothing.
  const events: Array<{ type: string; atSample: number }> = [];
  for (let off = 0, i = 0; off < pcm.length; off += frame, i++) {
    const wait = t0 + i * VAD_FRAME_MS - Date.now();
    if (wait > 1) await sleep(wait);
    frameWall.push(Date.now());
    for (const e of vad.push(pcm.subarray(off, off + frame))) events.push({ type: e.type, atSample: e.atSample });
  }

  // ── the "VAD + 静音等待" commit rule ─────────────────────────────────────────────────────────────
  // The shipping VAD declares speech_stopped after its own 400 ms of quiet. The chain then waits its
  // DECLARED extra `RESUME_GRACE_MS`; a speech_start inside that window means the utterance was a
  // hesitation, so the pending commit is cancelled and the accumulated audio keeps growing. The
  // utterance ends at the FIRST speech_stopped that is followed by the full wait of quiet.
  const rawEnds = events.filter((e) => e.type === 'speechEnd');
  let pendingCommit: number | null = null; // sample at which the pending wait would elapse
  let commitSample: number | null = null;
  for (const e of events) {
    if (e.type === 'speechStart') {
      pendingCommit = null; // speech resumed → the previous end was a hesitation, not a turn end
    } else if (e.type === 'speechEnd') {
      pendingCommit = e.atSample + graceSamples;
    }
  }
  // The LAST speechEnd's wait is only satisfied if the clip's tail (the appended silence) is long
  // enough — which gen-samples.mts guarantees (APPEND_TAIL_MS > 400 + grace).
  if (pendingCommit !== null && pendingCommit <= pcm.length) commitSample = pendingCommit;

  const commitFrame = commitSample === null ? frameWall.length : Math.min(frameWall.length, Math.ceil(commitSample / frame));
  const commitWallMs = frameWall[Math.max(0, commitFrame - 1)] ?? frameWall[frameWall.length - 1] ?? t0;
  const speechEndWallMs = t0 + entry.speechEndMs; // exact by construction: the feed is frame-paced
  const endpointWaitMs = commitSample === null ? null : Math.max(0, commitWallMs - speechEndWallMs);

  // "累积的完整语音": the audio up to and including the committed endpoint frame.
  const spoken = pcm.subarray(0, Math.min(commitFrame * frame, pcm.length));
  const body = {
    model: OMNI_MODEL,
    modalities: ['text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${encodeWav(spoken, SAMPLE_RATE).toString('base64')}`, format: 'wav' } },
          { type: 'text', text: SYSTEM_PROMPT },
        ],
      },
    ],
    tools: [{ type: 'function', function: { name: samplesDoc.tool.name, description: samplesDoc.tool.description, parameters: samplesDoc.tool.parameters } }],
    tool_choice: 'auto',
    max_tokens: 256,
    temperature: 0,
  };

  const tReq = Date.now();
  let httpStatus = 0;
  let json: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(OMNI_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    httpStatus = res.status;
    json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      error = `${httpStatus} ${err?.code ?? ''} ${String(err?.message ?? '').slice(0, 200)}`;
    }
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const inferenceMs = Date.now() - tReq;

  const choice = (json as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> } | null)?.choices?.[0];
  const calls = (choice?.message?.tool_calls ?? []).map((c) => parseCall(c.function?.name, c.function?.arguments));
  const usage = (json as { usage?: unknown } | null)?.usage ?? null;

  return {
    status: error === null ? 'ok' : 'error',
    vadRawEndEvents: rawEnds.length,
    silenceWaitMs: RESUME_GRACE_MS,
    vadEndpointMs: endpointWaitMs,
    inferenceMs,
    // A latency only exists once there IS a call; the control sample (no call) must not contribute.
    endToCallMs: calls.length > 0 && endpointWaitMs !== null ? endpointWaitMs + inferenceMs : null,
    httpStatus,
    text: typeof choice?.message?.content === 'string' ? choice.message.content : null,
    calls,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage,
    spendCny: omniCost(usage),
    error,
  };
}

// ── judgement (mechanical proxy) ─────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/\s+/g, '');
}

/**
 * Identifier-normalised form: `norm` with the separators a model may legitimately vary
 * (`.`/`-`/`_`) removed, so `voice.service.ts`, `voice-service.ts`, `voiceService.ts` and
 * `voice_service.ts` all collapse to one token. The pilot's question is whether the chain named
 * the RIGHT TARGET, not whether it preserved the file's punctuation — an ASR transcript routinely
 * writes `voice-service.ts` where the source says `voice.service.ts`, and scoring that as a
 * mis-understanding would be a matcher artifact, not a chain failure. Both normalisations are used
 * (a group matches under EITHER), and the raw argument is always recorded so a reader can re-judge.
 */
function normId(s: string): string {
  return norm(s).replace(/[.\-_]/g, '');
}

const matches = (haystack: string, token: string): boolean => haystack.includes(norm(token)) || normId(haystack).includes(normId(token));

type Judgement = { called: boolean; correct: boolean; spurious: boolean; missed: boolean; reason: string };

function judge(sample: Sample, calls: RecordedCall[]): Judgement {
  const called = calls.length > 0;
  if (!sample.expectAction) {
    return { called, correct: !called, spurious: called, missed: false, reason: called ? 'control sample triggered an action' : 'control sample correctly silent' };
  }
  const anyForbidden = calls.some((c) => sample.forbiddenTokens.some((f) => matches(norm(c.message ?? ''), f)));
  const matched = calls.some((c) => {
    const m = norm(c.message ?? '');
    return sample.intentGroups.every((g) => g.some((tok) => matches(m, tok))) && !sample.forbiddenTokens.some((f) => matches(m, f));
  });
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

function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
if (apiKey === '') throw new Error('DASHSCOPE_API_KEY is not set.');

let cumulativeCny = 0;
let aborted = false;

type Row = {
  sample: string;
  scenario: string;
  synthetic: boolean;
  text: string;
  intent: string;
  expectAction: boolean;
  audio: { sha256: string; totalMs: number; speechEndMs: number; appendedTailMs: number; wav: string };
  chainA: ChainA;
  chainB: ChainB | null;
  judgement: { chainA: Judgement; chainB: Judgement | null } | null;
  wallClockMs: number;
};
const rows: Row[] = [];

for (const sample of selected) {
  const entry = byId.get(sample.id);
  if (!entry) throw new Error(`no manifest entry for ${sample.id} — run gen-samples.mts first`);
  const wavPath = join(HERE, entry.wav);
  if (!existsSync(wavPath)) throw new Error(`missing audio ${wavPath} — run gen-samples.mts first`);
  const wav = (readWav(wavPath) as { samples: Float32Array }).samples;

  if (cumulativeCny + P_EST_CALL_CNY > CAP_CNY) {
    aborted = true;
    console.log(`BUDGET-STOP before ${sample.id}: cumulative ¥${cumulativeCny.toFixed(4)} + est ¥${P_EST_CALL_CNY} > cap ¥${CAP_CNY}`);
    break;
  }

  process.stdout.write(`\n== ${sample.id} (${sample.scenario}) sha=${entry.sha256.slice(0, 12)} ==\n`);
  const tStart = Date.now();
  const a = await runChainA(sample, entry, wav, apiKey);
  cumulativeCny += a.spendCny;
  console.log(`  A realtime: status=${a.status} session=${a.sessionId ?? '-'} endpointWait=${a.endpointWaitMs}ms rawStops=${a.rawSpeechStops} calls=${a.calls.length} spend=¥${a.spendCny.toFixed(5)}`);
  if (a.error) console.log(`  A error: ${a.error}`);

  const row: Row = {
    sample: sample.id,
    scenario: sample.scenario,
    synthetic: sample.synthetic,
    text: sample.text,
    intent: sample.intent,
    expectAction: sample.expectAction,
    audio: { sha256: entry.sha256, totalMs: entry.totalMs, speechEndMs: entry.speechEndMs, appendedTailMs: entry.appendedTailMs, wav: entry.wav },
    chainA: a,
    chainB: null,
    judgement: null,
    wallClockMs: 0,
  };

  if (cumulativeCny + P_EST_CALL_CNY > CAP_CNY) {
    aborted = true;
    console.log(`BUDGET-STOP after chain A of ${sample.id}: cumulative ¥${cumulativeCny.toFixed(4)}`);
    row.wallClockMs = Date.now() - tStart;
    rows.push(row);
    break;
  }

  const b = await runChainB(sample, entry, wav, apiKey);
  cumulativeCny += b.spendCny;
  console.log(`  B omni:     status=${b.status} http=${b.httpStatus} vadRawEnds=${b.vadRawEndEvents} endpointWait=${b.vadEndpointMs}ms inference=${b.inferenceMs}ms calls=${b.calls.length} spend=¥${b.spendCny.toFixed(5)}`);
  if (b.error) console.log(`  B error: ${b.error}`);

  row.chainB = b;
  row.judgement = { chainA: judge(sample, a.calls), chainB: judge(sample, b.calls) };
  row.wallClockMs = Date.now() - tStart;
  rows.push(row);
  console.log(`  judge A=${row.judgement.chainA.reason} | B=${row.judgement.chainB.reason}`);
}

// ── summary + Go/No-Go (thresholds from the prereg, never adjusted) ──────────────────────────────
const pr = samplesDoc.preregistration;
const completed = rows.filter((r) => r.chainA && r.chainB && r.judgement) as Array<Row & { chainB: ChainB; judgement: { chainA: Judgement; chainB: Judgement } }>;

function rates(key: 'chainA' | 'chainB') {
  const actionSamples = completed.filter((r) => r.expectAction);
  const spurious = completed.filter((r) => r.judgement[key].spurious).length;
  const missed = completed.filter((r) => r.judgement[key].missed).length;
  const correct = completed.filter((r) => r.judgement[key].correct).length;
  return {
    n: completed.length,
    nAction: actionSamples.length,
    correct,
    correctRate: completed.length ? Number((correct / completed.length).toFixed(4)) : null,
    spuriousCount: spurious,
    missedCount: missed,
    spuriousRate: completed.length ? Number((spurious / completed.length).toFixed(4)) : null,
    missedRate: actionSamples.length ? Number((missed / actionSamples.length).toFixed(4)) : null,
  };
}

const latencies = {
  chainA: completed.map((r) => r.chainA.endToCallMs).filter((v): v is number => typeof v === 'number'),
  chainB: completed.map((r) => r.chainB.endToCallMs).filter((v): v is number => typeof v === 'number'),
};

const summary = {
  chainA: { ...rates('chainA'), p50EndToCallMs: percentile(latencies.chainA, 50), p95EndToCallMs: percentile(latencies.chainA, 95) },
  chainB: { ...rates('chainB'), p50EndToCallMs: percentile(latencies.chainB, 50), p95EndToCallMs: percentile(latencies.chainB, 95) },
};

const keyScenarios = pr.keyCaseRequirement.scenarios;
const keyFailures: Array<{ sample: string; scenario: string; chain: string; reason: string }> = [];
for (const r of completed) {
  if (!keyScenarios.includes(r.scenario)) continue;
  for (const chain of ['chainA', 'chainB'] as const) {
    if (!r.judgement[chain].correct) keyFailures.push({ sample: r.sample, scenario: r.scenario, chain, reason: r.judgement[chain].reason });
  }
}

const gateChecks = {
  keyCasesPassBothChains: keyFailures.length === 0,
  chainASpuriousUnderCap: (summary.chainA.spuriousRate ?? 1) <= pr.spuriousTriggerRateMax,
  chainBSpuriousUnderCap: (summary.chainB.spuriousRate ?? 1) <= pr.spuriousTriggerRateMax,
  chainAMissedUnderCap: (summary.chainA.missedRate ?? 1) <= pr.missedTriggerRateMax,
  chainBMissedUnderCap: (summary.chainB.missedRate ?? 1) <= pr.missedTriggerRateMax,
  chainALatencyP50: (summary.chainA.p50EndToCallMs ?? Infinity) <= pr.latencyP50MsMax,
  chainBLatencyP50: (summary.chainB.p50EndToCallMs ?? Infinity) <= pr.latencyP50MsMax,
  chainALatencyP95: (summary.chainA.p95EndToCallMs ?? Infinity) <= pr.latencyP95MsMax,
  chainBLatencyP95: (summary.chainB.p95EndToCallMs ?? Infinity) <= pr.latencyP95MsMax,
  budgetWithinCap: cumulativeCny <= CAP_CNY,
  allPlannedRan: completed.length === samplesDoc.samples.length,
};
const goNoGo = Object.values(gateChecks).every(Boolean) ? 'GO' : 'NO-GO';

const result = {
  schema: 'voice-turn-detection-paired-pilot/result@1',
  task: 'gap-voice-turn-detection-p0-8-paired-realtime-vs-nonrealtime-pilot',
  ranAt: new Date().toISOString(),
  preregistration: pr,
  samplesSource: 'samples.json',
  chains: {
    A: 'qwen3.8-omni-flash-realtime (server_vad, via the shipping DashScope transport), create_response=true, dry-run sink',
    B: `StreamingVad (shipping, endpointMs=400) + declared silence-wait ${RESUME_GRACE_MS}ms (effective end-of-turn silence 400+${RESUME_GRACE_MS}=${400 + RESUME_GRACE_MS}ms) -> ONE non-realtime qwen3.8-omni-flash request (compatible-mode chat/completions, tool_choice=auto), dry-run sink`,
    BWaitRule:
      'after the VAD declares speech_stopped, wait the extra silence-wait; a speech_start inside that window cancels the pending commit (the utterance was a hesitation and keeps accumulating). The utterance ends at the first un-resumed wait.',
  },
  dryRun: {
    statement:
      'Neither chain constructs a real session_send executor. Chain A passes a plain mock executor object to the shipping bridge (the shipping createVoiceRealtimeLiveExecutor is never imported); Chain B never calls a tool at all — it only parses what the model emitted in the HTTP response JSON. No live MCP gateway or session id is reachable from this process.',
    chainAExecutor: 'plain object; createVoiceRealtimeLiveExecutor NOT imported anywhere in this file',
    chainBDelivery: 'none — no executor exists on chain B',
  },
  budget: {
    capCny: CAP_CNY,
    spentCny: Number(cumulativeCny.toFixed(6)),
    abortedEarly: aborted,
    accounting:
      'NEW real upstream calls (Realtime + non-realtime Omni), priced with the qwen3.8-omni-flash-realtime table as a proxy (the non-realtime price is not published in this repo; the invoice is the authority).',
    note: aborted ? `run stopped at the cap; ${completed.length}/${samplesDoc.samples.length} samples completed both chains` : 'all planned samples completed within the cap',
  },
  summary,
  sampleSizeCaveat: true,
  sampleSizeCaveatReason:
    'N=7 synthetic samples (single TTS voice, zh-CN-XiaoxiaoNeural). The per-example rows are the reading; the summary percentages are auxiliary and do NOT support a generalizable conclusion. Read FINDINGS.md for the per-example judgement.',
  gateChecks,
  goNoGo,
  keyFailures,
  rows,
};
writeFileSync(join(HERE, 'RESULT.json'), JSON.stringify(result, null, 2));
console.log(`\nWRITE RESULT.json — goNoGo=${goNoGo} spent=¥${cumulativeCny.toFixed(5)} completed=${completed.length}/${samplesDoc.samples.length}`);
if (keyFailures.length) console.log('keyFailures:', JSON.stringify(keyFailures));
