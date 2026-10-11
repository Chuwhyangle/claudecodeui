/**
 * P0.12 — the full-event instrument for one Qwen Realtime session, and the diagnosis it produces.
 *
 * WHY THIS FILE. P0.7 recorded a real session's RECEIVED frames only: `run-replay.mts` trimmed the
 * sent frames before writing the artifact (it dropped the base64 audio on purpose) and nothing ever
 * recorded the WebSocket lifecycle. So when P0.7 saw 11 timeouts and one 14 s wait, a "the endpoint
 * never fired" reading could not be told apart from "our sender stalled", "the socket died", or
 * "the fire arrived and the attribution window rejected it" — none of the evidence that separates
 * those existed. This file re-drives the SAME production transport (`createDashscopeTransport` +
 * `connect`, imported from `server/modules/voice-realtime`) with its OWN observer and its OWN socket
 * wrapper and records ALL of it: every sent frame with its wall clock and byte count, every received
 * frame, the WS open/error/close with the close code, the harness deadline and when it fired, and the
 * attribution decision with each candidate stop's accept/reject reason. It classifies every timeout
 * into one of four causes that are NOT the model missing an endpoint.
 *
 * IT DOES NOT MODIFY THE SHARED ADAPTER. `eot-bench-adapters/qwen-realtime-streaming-adapter.mts` is
 * P0.7's committed code and is left untouched; this file is a separate instrument that reproduces the
 * same session parameters (resolved from the same `resolveTurnDetection` / `DEFAULT_SESSION_DEFAULTS`)
 * so a re-test is comparable to P0.7 without changing what P0.7 measured.
 *
 * ZERO SPEND UNTIL WARMED, AND THE GATE IS EXPLICIT. `--paid` is required to open a socket to the
 * real endpoint; the default invocation replays the P0.7 artifact only. The budget cap is written
 * before the first paid session and enforced between sessions.
 *
 * Run (no spend — recompute the report from the committed raw log):
 *   node_modules/.bin/tsx experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/diagnose.mts --report
 * Run the paid paired replay (requires `--paid`, spends ≤ ¥0.05):
 *   node_modules/.bin/tsx experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/diagnose.mts --paid --runs 2
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebSocket from 'ws';
import { z } from 'zod';

// ⛔ NOT THE BARREL, ON PURPOSE. `server/modules/voice-realtime/index.ts` also re-exports
// `createVoiceRealtimeLiveExecutor`, whose module imports `@/modules/mcp-gateway/index.js`. That `@/`
// alias resolves only under `server/tsconfig.json`, so a barrel import forces every caller to run
// with `--tsconfig server/tsconfig.json` — which AC1's command does not pass. This instrument needs
// four leaf modules, all of which are `@/`-free, so it imports them directly and the AC's bare
// `tsx …/loopback.test.mts` resolves without a flag. The four are the SAME files the barrel points
// at, so nothing about the code under test changes.
import {
  createDashscopeTransport,
  DEFAULT_SESSION_DEFAULTS,
  estimateRealtimeCostCny,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeWireObserver,
} from '../../../server/modules/voice-realtime/voice-realtime-dashscope-transport.js';
import {
  connect,
  type RealtimeBridge,
  type RealtimeToolExecutor,
} from '../../../server/modules/voice-realtime/voice-realtime-bridge.service.js';
import type { RealtimeToolDescriptor } from '../../../server/modules/voice-realtime/voice-realtime-tools.js';
import { resolveTurnDetection } from '../../../server/modules/voice-realtime/voice-realtime-turn-detection.js';
import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/voice-realtime-ws-proxy.service.js';

import { loadCorpus, type ReplaySpan } from '../eot-bench-adapters/corpus.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'RESULT.json');
const P07_RESULT = path.resolve(DIR, '..', 'RESULT.json');

const QWEN_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
const QWEN_REALTIME_VOICE = 'Tina';
const FRAME_MS = 100;
/** The shipping adapter's wait for the endpoint to close the utterance, and its quiet threshold. */
export const DEFAULT_CLOSE_WAIT_MS = 8_000;
/**
 * How long past the harness deadline this instrument keeps the socket open to observe a fire that
 * arrived too late. P0.7 CLOSED the socket at its deadline, so a fire later than that was invisible
 * there; here it is caught and named `late-beyond-deadline`.
 */
export const DEFAULT_LATE_GRACE_MS = 6_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** ⛔ WRITTEN BEFORE ANY PAID EXECUTION. The replay aborts the moment the estimate reaches it. */
export const BUDGET_CNY = 0.05;

/** The four non-model timeout causes AC5 requires, plus `ok` and a hard `error`. */
export type SessionClassification =
  | 'ok'
  | 'network-ws-failure'
  | 'upstream-no-event'
  | 'late-beyond-deadline'
  | 'attribution-window-rejected'
  | 'error';

/** The span shape this instrument needs — structurally a `ReplaySpan`, so the corpus feeds it directly. */
export type DiagnosedSpan = {
  sampleId: string;
  spanIndex: number;
  onsetMs: number;
  audio: Float32Array;
  sampleRate: number;
  appendedTailMs: number;
};

export type SentFrame = {
  seq: number;
  /** Wall clock at which the frame crossed the socket. */
  atMs: number;
  /** ms since the first sent frame (frame 0 is the `session.update`). */
  relMs: number;
  type: string;
  bytes: number;
  isAudio: boolean;
};

export type ReceivedFrame = { atMs: number; relMs: number; type: string; wire: Record<string, unknown> };

export type WsLifecycle = {
  openAtMs: number | null;
  handshakeMs: number | null;
  errors: Array<{ atMs: number; message: string }>;
  close: { atMs: number; code: number | null; reason: string | null; deliberate: boolean } | null;
};

export type StopCandidate = {
  /** Wall clock of the `speech_stopped` (or `speech_started`) arrival. */
  atMs: number;
  relMs: number;
  accepted: boolean;
  reason: string;
};

export type AttributionTrace = {
  onsetWallMs: number | null;
  earliestPossibleMs: number | null;
  stops: StopCandidate[];
  acceptedStopWallMs: number | null;
  committedWallMs: number | null;
  transcript: string | null;
};

export type SessionDiagnosis = {
  spanId: string;
  sampleId: string;
  spanIndex: number;
  silenceDurationMs: number;
  threshold: number;
  detectorType: 'server_vad' | 'semantic_vad';
  sessionParams: Record<string, unknown>;
  sampleSha256: string;
  spanSha256: string;
  sessionId: string | null;
  status: 'ok' | 'timeout' | 'error';
  classification: SessionClassification;
  classificationDetail: string;
  error: string | null;
  ws: WsLifecycle;
  audio: {
    framesSent: number;
    audioMs: number;
    frameBytes: number;
    sentBytesTotal: number;
    startedAtMs: number | null;
    endedAtMs: number | null;
    /** Inter-frame intervals of the APPEND frames, ms — the actual send cadence. */
    appendIntervalsMs: number[];
    intervalP50Ms: number | null;
    intervalP90Ms: number | null;
    intervalMaxMs: number | null;
    firstFrameType: string | null;
    lastFrameType: string | null;
    scheduledAudioMs: number;
    trailingSilenceMs: number;
  };
  deadline: {
    anchorAtMs: number | null;
    deadlineAtMs: number | null;
    closeWaitMs: number;
    lateGraceMs: number;
    gaveUpAtMs: number | null;
    acceptedStopBeforeDeadline: boolean;
  };
  attribution: AttributionTrace;
  sent: SentFrame[];
  received: ReceivedFrame[];
  usage: unknown;
  spendCny: number;
  spendBasis: 'measured' | 'unknown';
  wallClockMs: number;
  /** The three sub-attribution facts AC6 needs, precomputed for the report. */
  facts: {
    framesSentBeforeFailure: number | null;
    stopCount: number;
    earliestStopRelMs: number | null;
    latestStopRelMs: number | null;
  };
};

export type DiagnoseOptions = {
  apiKey: string;
  /** Real endpoint by default; the loopback test points this at its fake server. */
  endpoint?: string;
  silenceDurationMs: number;
  threshold?: number;
  detectorType?: 'server_vad' | 'semantic_vad';
  closeWaitMs?: number;
  lateGraceMs?: number;
  timeoutMs?: number;
  /** Test seam: opens the socket. Never used by the paid path (which dials the real endpoint). */
  socketFactory?: DashscopeSocketFactory;
  tool?: RealtimeToolDescriptor;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

function sha256OfFloat32(a: Float32Array): string {
  return createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
}

/** Strip the bulky base64 blobs from a frame before it goes into the log; keep everything else. */
function sanitizeWire(wire: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wire)) {
    if (typeof v === 'string' && v.length > 256) out[k] = `<${v.length} chars>`;
    else out[k] = v;
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/**
 * The shipping P0.7 attribution rule, reproduced with its per-stop reason exposed.
 *
 * `speech_stopped` at `t` is THIS candidate's iff it arrives no earlier than `earliestPossibleMs`
 * (the onset plus the configured silence, minus 10 % pacing slack) AND no `speech_started` landed
 * between the onset and `t` (a resume means the silence was interrupted, so the fire belongs to a
 * later run). Both rejection reasons are recorded, not collapsed into "no fire".
 */
export function traceAttribution(ctx: {
  onsetWallMs: number | null;
  earliestPossibleMs: number | null;
  audioStartedAtMs: number | null;
  speechStartsMs: number[];
  speechStopsMs: number[];
  committedMs: number[];
  transcriptions: Array<{ atMs: number; text: string | null }>;
}): AttributionTrace {
  const { onsetWallMs, earliestPossibleMs, audioStartedAtMs } = ctx;
  const rel = (t: number): number => (audioStartedAtMs === null ? t : t - audioStartedAtMs);
  const stops: StopCandidate[] = [];
  let acceptedStopWallMs: number | null = null;
  if (onsetWallMs !== null && earliestPossibleMs !== null) {
    for (const t of ctx.speechStopsMs) {
      if (acceptedStopWallMs !== null) {
        stops.push({ atMs: t, relMs: rel(t), accepted: false, reason: 'a later stop was already accepted' });
        continue;
      }
      if (t < earliestPossibleMs) {
        stops.push({
          atMs: t,
          relMs: rel(t),
          accepted: false,
          reason: `before-earliest-possible (+${(earliestPossibleMs - t).toFixed(0)} ms short of onset+silence)`,
        });
        continue;
      }
      const resume = ctx.speechStartsMs.find((s) => s > onsetWallMs && s < t);
      if (resume !== undefined) {
        stops.push({
          atMs: t,
          relMs: rel(t),
          accepted: false,
          reason: `interrupted-by-resume (a speech_started at rel ${rel(resume).toFixed(0)} ms lies between onset and this stop)`,
        });
        continue;
      }
      stops.push({ atMs: t, relMs: rel(t), accepted: true, reason: 'accepted: >= onset+silence with no resume in between' });
      acceptedStopWallMs = t;
    }
  } else {
    for (const t of ctx.speechStopsMs) stops.push({ atMs: t, relMs: rel(t), accepted: false, reason: 'no onset in the audio timeline (nothing to attribute)' });
  }
  const committedWallMs = acceptedStopWallMs === null ? null : ctx.committedMs.find((t) => t >= acceptedStopWallMs) ?? null;
  const transcript = acceptedStopWallMs === null ? null : ctx.transcriptions.find((e) => e.atMs >= acceptedStopWallMs)?.text ?? null;
  return { onsetWallMs, earliestPossibleMs, stops, acceptedStopWallMs, committedWallMs, transcript };
}

/**
 * Drive ONE session through the shipping transport, recording the complete event log. Never throws
 * for an endpoint-side failure — a dead socket, an unwarmed session and a silent endpoint are all
 * RECORDED, because the timeline is the thing that explains them.
 */
export async function runDiagnosedSession(span: DiagnosedSpan, opts: DiagnoseOptions): Promise<SessionDiagnosis> {
  const startedAt = Date.now();
  const silenceDurationMs = opts.silenceDurationMs;
  const threshold = opts.threshold ?? 0.5;
  const detectorType = opts.detectorType ?? 'server_vad';
  const closeWaitMs = opts.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS;
  const lateGraceMs = opts.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sent: SentFrame[] = [];
  const received: ReceivedFrame[] = [];
  const errors: string[] = [];
  let firstSendAtMs: number | null = null;
  let openedSocket: { close?: (code?: number, reason?: string) => void } | null = null;
  let sessionId: string | null = null;
  let fatal: string | null = null;
  let usage: unknown = null;
  let spendCny = 0;
  let deliberateClose = false;

  const ws: WsLifecycle = { openAtMs: null, handshakeMs: null, errors: [], close: null };
  const dialAtMs = Date.now();

  const speechStartsMs: number[] = [];
  const speechStopsMs: number[] = [];
  const committedMs: number[] = [];
  const transcriptions: Array<{ atMs: number; text: string | null }> = [];

  const observer: DashscopeWireObserver = (observation) => {
    const wire = (observation.wire ?? {}) as Record<string, unknown>;
    const type = typeof wire.type === 'string' ? wire.type : '(untyped)';
    if (observation.direction === 'sent') {
      if (firstSendAtMs === null) firstSendAtMs = observation.atMs;
      const audio = wire.type === 'input_audio_buffer.append' ? wire.audio : undefined;
      sent.push({
        seq: sent.length,
        atMs: observation.atMs,
        relMs: observation.atMs - firstSendAtMs,
        type,
        bytes: typeof audio === 'string' ? Buffer.from(audio, 'base64').length : JSON.stringify(wire).length,
        isAudio: type === 'input_audio_buffer.append',
      });
      return;
    }
    received.push({ atMs: observation.atMs, relMs: firstSendAtMs === null ? 0 : observation.atMs - firstSendAtMs, type, wire: sanitizeWire(wire) });
    switch (type) {
      case 'session.created':
      case 'session.updated': {
        const session = wire.session as Record<string, unknown> | undefined;
        if (typeof session?.id === 'string') sessionId = session.id;
        break;
      }
      case 'input_audio_buffer.speech_started':
        speechStartsMs.push(observation.atMs);
        break;
      case 'input_audio_buffer.speech_stopped':
        speechStopsMs.push(observation.atMs);
        break;
      case 'input_audio_buffer.committed':
        committedMs.push(observation.atMs);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        transcriptions.push({ atMs: observation.atMs, text: typeof wire.transcript === 'string' ? wire.transcript : null });
        break;
      case 'response.done': {
        const response = (wire.response ?? {}) as Record<string, unknown>;
        usage = response.usage ?? null;
        const cost = estimateRealtimeCostCny(usage);
        if (Number.isFinite(cost)) spendCny += cost;
        break;
      }
      default:
        break;
    }
  };

  const dial: DashscopeSocketFactory =
    opts.socketFactory ??
    ((url, headers) => {
      const socket = new WebSocket(url as string, { headers: headers as Record<string, string> });
      const wrapped: DashscopeSocket = {
        send: (data: string) => socket.send(data),
        close: (code?: number, reason?: string) => socket.close(code, reason),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      socket.on('open', () => {
        ws.openAtMs = Date.now();
        ws.handshakeMs = ws.openAtMs - dialAtMs;
        wrapped.onopen?.({});
      });
      socket.on('message', (data) => wrapped.onmessage?.({ data: data.toString() }));
      socket.on('error', (error: unknown) => {
        ws.errors.push({ atMs: Date.now(), message: String((error as { message?: string })?.message ?? error) });
        wrapped.onerror?.(error as never);
      });
      socket.on('close', (code: number, reason: Buffer) => {
        ws.close = { atMs: Date.now(), code, reason: String(reason), deliberate: deliberateClose };
        wrapped.onclose?.({ code, reason: String(reason) });
      });
      openedSocket = socket as unknown as { close?: (code?: number, reason?: string) => void };
      return wrapped;
    });

  const resolution = resolveTurnDetection({}, { type: detectorType, silenceMs: silenceDurationMs });
  const sessionParams = {
    model: QWEN_REALTIME_MODEL,
    voice: QWEN_REALTIME_VOICE,
    turn_detection: { ...resolution.turnDetection, create_response: false, interrupt_response: false },
    respondToToolOutputs: false,
  } as Record<string, unknown>;

  const tool: RealtimeToolDescriptor =
    opts.tool ?? {
      name: 'session_send',
      description: 'Send a message to the Claude Code session.',
      inputSchema: { message: z.string() },
      outputSchema: {},
    };
  const executor: RealtimeToolExecutor = { session_send: (args: Record<string, unknown>) => ({ queued: true, message: args.message ?? null }) };

  const transport = createDashscopeTransport({
    apiKey: opts.apiKey,
    endpoint: opts.endpoint,
    model: QWEN_REALTIME_MODEL,
    voice: QWEN_REALTIME_VOICE,
    sessionDefaults: {
      ...DEFAULT_SESSION_DEFAULTS,
      turn_detection: { ...resolution.turnDetection, create_response: false, interrupt_response: false } as typeof DEFAULT_SESSION_DEFAULTS.turn_detection,
    },
    respondToToolOutputs: false,
    socketFactory: dial,
    observer,
    onError: (error) => errors.push(JSON.stringify(error).slice(0, 300)),
  });

  let bridge: RealtimeBridge | null = null;
  try {
    bridge = connect(transport, [tool], executor, { maxConnectAttempts: 1 });
    await bridge.whenConnected();
    bridge.sendSessionUpdate(VOICE_REALTIME_INSTRUCTIONS);
  } catch (error) {
    fatal = `connect failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (fatal === null) {
    const deadline = Date.now() + 20_000;
    while (sessionId === null && Date.now() < deadline && fatal === null) await sleep(50);
    if (sessionId === null) fatal = 'session did not warm within 20000 ms (no session.created frame)';
  }

  // ── stream the PCM at the real 100 ms cadence, recording every append ─────────────────────────
  let framesSent = 0;
  let audioStartedAtMs: number | null = null;
  let audioEndedAtMs: number | null = null;
  let sentBytesTotal = 0;
  const pcm16 = floatToPcm16(span.audio);
  const frameBytes = ((span.sampleRate * FRAME_MS) / 1000) * 2;
  if (fatal === null && bridge !== null && bridge.state === 'open') {
    for (let offset = 0; offset < pcm16.length; offset += frameBytes) {
      if (fatal !== null || ws.close !== null || Date.now() - startedAt > timeoutMs) break;
      const chunk = pcm16.subarray(offset, Math.min(offset + frameBytes, pcm16.length));
      if (audioStartedAtMs === null) audioStartedAtMs = Date.now();
      bridge.sendAudioFrame(chunk.toString('base64'));
      sentBytesTotal += chunk.length;
      framesSent += 1;
      if (offset + frameBytes >= pcm16.length) audioEndedAtMs = Date.now();
      await sleep(FRAME_MS);
    }
  }
  const audioMs = framesSent * FRAME_MS;
  const onsetAudioMs = Math.max(0, Math.min(span.onsetMs, audioMs));
  const onsetWallMs = audioStartedAtMs === null ? null : audioStartedAtMs + onsetAudioMs;
  const earliestPossibleMs = onsetWallMs === null ? null : onsetWallMs + silenceDurationMs * 0.9;

  const attrCtx = { onsetWallMs, earliestPossibleMs, audioStartedAtMs, speechStartsMs, speechStopsMs, committedMs, transcriptions };

  // ── wait for THIS candidate's fire, up to the deadline, then a grace window for a late one ────
  const anchorAtMs = audioEndedAtMs ?? Date.now();
  const deadlineAtMs = anchorAtMs + closeWaitMs;
  let gaveUpAtMs: number | null = null;
  let attribution = traceAttribution(attrCtx);
  if (fatal === null && framesSent > 0) {
    while (Date.now() < deadlineAtMs && Date.now() - startedAt < timeoutMs) {
      attribution = traceAttribution(attrCtx);
      if (attribution.acceptedStopWallMs !== null || ws.close !== null || ws.errors.length > 0) break;
      await sleep(50);
    }
    gaveUpAtMs = Date.now();
    if (attribution.acceptedStopWallMs === null && ws.close === null && ws.errors.length === 0) {
      const lateEnd = deadlineAtMs + lateGraceMs;
      while (Date.now() < lateEnd && Date.now() - startedAt < timeoutMs) {
        attribution = traceAttribution(attrCtx);
        if (attribution.acceptedStopWallMs !== null || ws.close !== null || ws.errors.length > 0) break;
        await sleep(50);
      }
      gaveUpAtMs = Date.now();
    }
  }

  deliberateClose = true;
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
  // Give the socket a beat to record our own close (code 1000) if it has not already closed.
  await sleep(50);

  const appendIntervals: number[] = [];
  const appends = sent.filter((f) => f.isAudio);
  for (let i = 1; i < appends.length; i++) appendIntervals.push(appends[i].atMs - appends[i - 1].atMs);
  const sortedIntervals = [...appendIntervals].sort((a, b) => a - b);

  const wsFailed = ws.errors.length > 0 || (ws.close !== null && !ws.close.deliberate && ws.close.code !== 1000);
  const lateStop = attribution.stops.find((s) => s.atMs > deadlineAtMs);
  let classification: SessionClassification;
  let detail: string;
  if (fatal !== null) {
    classification = wsFailed ? 'network-ws-failure' : 'error';
    detail = fatal;
  } else if (wsFailed) {
    classification = 'network-ws-failure';
    detail = `socket failed: ${ws.errors.map((e) => e.message).join('; ') || `close code ${ws.close?.code} (${ws.close?.reason})`}`;
  } else if (attribution.acceptedStopWallMs !== null && attribution.acceptedStopWallMs <= deadlineAtMs) {
    classification = 'ok';
    detail = `accepted speech_stopped at rel ${(attribution.acceptedStopWallMs - (audioStartedAtMs ?? 0)).toFixed(0)} ms (deadline was rel ${(deadlineAtMs - (audioStartedAtMs ?? 0)).toFixed(0)} ms)`;
  } else if (attribution.acceptedStopWallMs !== null) {
    // The endpoint DID fire, and the fire IS this candidate's — it just landed after the harness
    // stopped listening. P0.7 closed at its deadline and recorded this as a bare timeout.
    classification = 'late-beyond-deadline';
    detail = `an accepted speech_stopped arrived at rel ${(attribution.acceptedStopWallMs - (audioStartedAtMs ?? 0)).toFixed(0)} ms, ${(attribution.acceptedStopWallMs - deadlineAtMs).toFixed(0)} ms AFTER the ${closeWaitMs} ms deadline`;
  } else if (lateStop !== undefined) {
    classification = 'late-beyond-deadline';
    detail = `speech_stopped arrived at rel ${lateStop.relMs.toFixed(0)} ms, ${(lateStop.atMs - deadlineAtMs).toFixed(0)} ms AFTER the ${closeWaitMs} ms deadline`;
  } else if (attribution.stops.length > 0) {
    classification = 'attribution-window-rejected';
    detail = attribution.stops.map((s) => `${s.relMs.toFixed(0)}ms: ${s.reason}`).join(' | ');
  } else {
    classification = 'upstream-no-event';
    detail = `connected and sent ${framesSent} frames (${audioMs} ms); the endpoint emitted no speech_stopped before the socket was closed`;
  }

  const status: SessionDiagnosis['status'] = classification === 'ok' ? 'ok' : classification === 'error' || classification === 'network-ws-failure' ? 'error' : 'timeout';

  return {
    spanId: `${span.sampleId}#${span.spanIndex}`,
    sampleId: span.sampleId,
    spanIndex: span.spanIndex,
    silenceDurationMs,
    threshold,
    detectorType,
    sessionParams,
    sampleSha256: '',
    spanSha256: sha256OfFloat32(span.audio),
    sessionId,
    status,
    classification,
    classificationDetail: detail,
    error: fatal ?? (errors.length > 0 ? errors[0] : null),
    ws,
    audio: {
      framesSent,
      audioMs,
      frameBytes,
      sentBytesTotal,
      startedAtMs: audioStartedAtMs,
      endedAtMs: audioEndedAtMs,
      appendIntervalsMs: appendIntervals,
      intervalP50Ms: percentile(sortedIntervals, 0.5),
      intervalP90Ms: percentile(sortedIntervals, 0.9),
      intervalMaxMs: sortedIntervals.length ? sortedIntervals[sortedIntervals.length - 1] : null,
      firstFrameType: sent.length ? sent[0].type : null,
      lastFrameType: sent.length ? sent[sent.length - 1].type : null,
      scheduledAudioMs: Math.round((pcm16.length / 2 / span.sampleRate) * 1000),
      trailingSilenceMs: span.appendedTailMs,
    },
    deadline: {
      anchorAtMs,
      deadlineAtMs,
      closeWaitMs,
      lateGraceMs,
      gaveUpAtMs,
      acceptedStopBeforeDeadline: attribution.acceptedStopWallMs !== null && attribution.acceptedStopWallMs <= deadlineAtMs,
    },
    attribution,
    sent,
    received,
    usage,
    spendCny: Number(spendCny.toFixed(6)),
    spendBasis: usage === null ? 'unknown' : 'measured',
    wallClockMs: Date.now() - startedAt,
    facts: {
      framesSentBeforeFailure: wsFailed ? framesSent : null,
      stopCount: speechStopsMs.length,
      earliestStopRelMs: attribution.stops.length ? attribution.stops[0].relMs : null,
      latestStopRelMs: attribution.stops.length ? attribution.stops[attribution.stops.length - 1].relMs : null,
    },
  };
}

// ── the paid paired replay + the report ──────────────────────────────────────────────────────────

/** The configs this task re-tests, first-priority first (Plan step 3). */
export const REPLAY_CONFIGS: Array<{ span: string; level: number; why: string }> = [
  { span: 'zh-d01-o85#0', level: 400, why: 'the P0.7 14 s anomaly (ok but endpoint waited 14012 ms)' },
  { span: 'librispeech-002#0', level: 800, why: 'P0.7 timeout with ZERO received speech_stopped' },
  { span: 'librispeech-005#0', level: 400, why: 'P0.7 timeout with ZERO received speech_stopped' },
  { span: 'librispeech-000#0', level: 400, why: 'P0.7 timeout whose one stop was rejected (measurement false-negative control)' },
];

const P07_ALL_TIMEOUTS = [
  'librispeech-000#0@400',
  'librispeech-000#0@800',
  'librispeech-002#0@800',
  'librispeech-003#0@400',
  'librispeech-003#0@800',
  'librispeech-005#0@400',
  'librispeech-005#0@800',
  'librispeech-005#1@800',
  'zh-d01-o85#0@800',
  'zh-d01-o85#1@400',
  'zh-d01-o85#1@800',
];

type P07Prediction = {
  spanId: string;
  silenceDurationMs: number;
  status: string;
  audio: { framesSent: number; audioMs: number; startedAtMs: number | null; endedAtMs: number | null; trailingSilenceMs: number };
  attribution: {
    onsetWallMs: number | null;
    earliestPossibleMs: number | null;
    audioStartedAtMs: number | null;
    speechStartsRelMs: number[];
    speechStopsRelMs: number[];
    committedRelMs: number[];
    attributedStoppedRelMs: number | null;
  };
  userWaitEndpointMs: number | null;
  modelOverheadMs: number | null;
  spendCny: number;
  usage: unknown;
  /** The paced prediction rows P0.7 recorded; `label` is the span's ground-truth class (`eot`/`hold`). */
  predictionRows: Array<{ id: string; spanIndex: number; timestamp: number; silence_dur: number; p_eot: number; label: string }>;
  events: Array<{ direction: string; atMs: number; type: string; wire: Record<string, unknown> }>;
};

function readP07(): { predictions: P07Prediction[]; byLevel: Record<string, unknown>; actualSpend: unknown; plan: { subset: Array<{ span: string; level: number }> }; sampleSha: Map<string, string>; sessionUpdatedTurnDetection: Map<string, unknown> } {
  const doc = JSON.parse(readFileSync(P07_RESULT, 'utf8')) as {
    unifiedReplay: {
      qwenStreaming: { predictions: P07Prediction[]; byLevel: Record<string, unknown>; actualSpend: unknown; plan: { subset: Array<{ span: string; level: number }> } };
      corpus: { eligibility: { samples: Array<{ sampleId: string; acquisition: { sha256: string | null } }> } };
    };
  };
  const q = doc.unifiedReplay.qwenStreaming;
  const sampleSha = new Map<string, string>();
  for (const s of doc.unifiedReplay.corpus.eligibility.samples) if (s.acquisition.sha256) sampleSha.set(s.sampleId, s.acquisition.sha256);
  const sessionUpdatedTurnDetection = new Map<string, unknown>();
  for (const p of q.predictions) {
    const upd = p.events.find((e) => e.type === 'session.updated');
    const td = (upd?.wire.session as { turn_detection?: unknown } | undefined)?.turn_detection;
    if (td !== undefined) sessionUpdatedTurnDetection.set(`${p.spanId}@${p.silenceDurationMs}`, td);
  }
  return { predictions: q.predictions, byLevel: q.byLevel, actualSpend: q.actualSpend, plan: q.plan, sampleSha, sessionUpdatedTurnDetection };
}

/** Wilson 95 % interval for a binomial rate — the same estimator P0.7's sweep already reports. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p90(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(0.9 * (s.length - 1))];
}

/** Key-sorted JSON, so two objects with the same fields compare equal regardless of insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

type Checks = {
  p07: ReturnType<typeof readP07>;
  byKey: Map<string, ReplaySpan>;
  audioChecks: Array<Record<string, unknown>>;
  allAudioMatches: boolean;
  paramChecks: Array<Record<string, unknown>>;
  allParamsMatch: boolean;
  budget: Record<string, unknown>;
  perSessionWorst: Array<{ config: string; audioSeconds: number; cny: number }>;
  guardPassed: boolean;
};

/**
 * AC3 + AC4 as pure checks over the frozen P0.7 artifact, run BEFORE any socket opens. Returns the
 * per-config audio-hash comparison, the session-parameter comparison read off each P0.7
 * `session.updated` frame, and the pre-written budget. No network, no spend.
 */
function buildChecks(runs: number): Checks {
  const p07 = readP07();
  const corpus = loadCorpus();
  const byKey = new Map(corpus.spans.map((s) => [`${s.sampleId}#${s.spanIndex}`, s]));

  // ── AC3 (audio): the re-test audio must be the SAME bytes P0.7 measured. P0.7's artifact pins each
  //    sample with the loader's own `acquisition.sha256`; re-deriving that hash from the source file
  //    on disk reproduces it only if the underlying audio is unchanged, so this is a real check and
  //    not the loader agreeing with itself. The PCM actually fed to the endpoint is recorded too.
  const audioChecks = REPLAY_CONFIGS.map((c) => {
    const span = byKey.get(c.span);
    if (span === undefined) throw new Error(`config names an unknown span ${c.span}`);
    const expected = p07.sampleSha.get(span.sampleId) ?? null;
    const now = span.acquisition.sha256;
    return {
      span: c.span,
      sampleId: span.sampleId,
      derivation: span.acquisition.derivation,
      acquisitionHow: span.acquisition.how,
      licenceSpdx: span.acquisition.licenceSpdx,
      audioSha256P07: expected,
      audioSha256Now: now,
      audioMatches: expected !== null && expected === now,
      fedPcmSha256: sha256OfFloat32(span.audio),
      fedPcmBytes: span.audio.length * 4,
      onsetMs: span.onsetMs,
      appendedTailMs: span.appendedTailMs,
      sampleRate: span.sampleRate,
      label: span.label,
    };
  });
  const allAudioMatches = audioChecks.every((a) => a.audioMatches);

  // ── AC3 (session params): read P0.7's from its own `session.updated` frame, not re-typed here ──
  //    The comparison is over the fields the CLIENT controls. P0.7's `session.updated` is the
  //    endpoint's echo, and the endpoint adds its own `prefix_padding_ms` default (300) that no client
  //    sends — `resolveTurnDetection` returns only {type, threshold, silence_duration_ms}. Comparing
  //    the raw objects would therefore fail on a server-side default, not a parameter difference, so
  //    the echoed-only keys are reported separately rather than being allowed to red the check.
  const paramChecks = REPLAY_CONFIGS.map((c) => {
    const expected = p07.sessionUpdatedTurnDetection.get(`${c.span}@${c.level}`) ?? null;
    const resolution = resolveTurnDetection({}, { type: 'server_vad', silenceMs: c.level });
    const mine = { ...resolution.turnDetection, create_response: false, interrupt_response: false } as Record<string, unknown>;
    const echoedOnly = expected === null ? [] : Object.keys(expected as Record<string, unknown>).filter((k) => !(k in mine));
    const expectedClientFields = expected === null ? null : Object.fromEntries(Object.keys(mine).map((k) => [k, (expected as Record<string, unknown>)[k]]));
    return {
      config: `${c.span}@${c.level}`,
      p07TurnDetectionEcho: expected,
      p07ClientControlled: expectedClientFields,
      oursTurnDetection: mine,
      echoedOnlyKeys: echoedOnly,
      paramsMatch: expectedClientFields !== null && stableStringify(expectedClientFields) === stableStringify(mine),
    };
  });
  const allParamsMatch = paramChecks.every((p) => p.paramsMatch);

  // ── the budget, computed and written BEFORE the first paid connection ─────────────────────────
  const perSessionWorst = REPLAY_CONFIGS.map((c) => {
    const span = byKey.get(c.span) as ReplaySpan;
    const audioSeconds = span.audio.length / span.sampleRate;
    // Pessimistic upper bound: every audio second at 8 audio-input tokens/s + the whole relay
    // instruction payload as text input + one 120-token output turn that create_response:false forbids.
    const cny = ((audioSeconds * 8) / 1000) * 0.006 + (645 / 3 / 1000) * 0.0015 + (120 / 1000) * 0.0045;
    return { config: `${c.span}@${c.level}`, audioSeconds: Number(audioSeconds.toFixed(3)), cny: Number(cny.toFixed(6)) };
  });
  const budget: Record<string, unknown> = {
    capCny: BUDGET_CNY,
    writtenBeforeExecution: true,
    runsPerConfig: runs,
    configs: REPLAY_CONFIGS.length,
    sessionsPlanned: REPLAY_CONFIGS.length * runs,
    perSessionWorst,
    worstCaseTotalCny: Number((perSessionWorst.reduce((s, x) => s + x.cny, 0) * runs).toFixed(6)),
    method: 'every streamed audio second at 8 audio-input tokens/s + the 645-char relay payload at the text-input rate + a 120-token output turn create_response:false forbids — deliberately pessimistic so the arm cannot understate the bill',
  };
  const guardPassed = (budget.worstCaseTotalCny as number) <= BUDGET_CNY;

  return { p07, byKey, audioChecks, allAudioMatches, paramChecks, allParamsMatch, budget, perSessionWorst, guardPassed };
}

/** The committed loopback record, if `--loopback-passed` has been run. */
function readLoopback(): { passedAt: string } | null {
  if (!existsSync(OUT)) return null;
  const doc = JSON.parse(readFileSync(OUT, 'utf8')) as { loopback?: { passedAt?: string } };
  return doc.loopback?.passedAt ? { passedAt: doc.loopback.passedAt } : null;
}

/**
 * AC1 — stamp the loopback pass into the artifact. Run this IMMEDIATELY after the loopback test exits
 * 0 and BEFORE any `--paid` run, so the artifact carries the fact that the gate passed first (and,
 * with `paidRunAt`, the ordering).
 */
function recordLoopbackPass(): void {
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  existing.schema = existing.schema ?? 'voice-turn-detection-compare/realtime-timeout-diagnosis@1';
  existing.task = 'gap-voice-turn-detection-p0-12-realtime-timeout-diagnosis';
  existing.loopback = {
    passedAt: new Date().toISOString(),
    command: 'node_modules/.bin/tsx experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/loopback.test.mts',
    exitCode: 0,
    scenarios: ['normal', 'late', 'zero-event', 'abnormal-close (close code 1011)', 'attribution-window-rejected'],
    note: 'the same runner and attribution rule a paid session uses, driven against known-outcome ground truth; no socket left 127.0.0.1',
  };
  const record = existing.loopback as { passedAt: string };
  writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');
  console.log(`loopback pass recorded at ${record.passedAt}`);
}

/** `--verify`: run every pre-paid check and print it. Opens no socket; costs nothing. */
function dryVerify(): void {
  const checks = buildChecks(2);
  console.log('── AC3 audio identity (re-test vs the frozen P0.7 artifact) ──');
  for (const a of checks.audioChecks) {
    console.log(`  ${a.span}  ${a.audioMatches ? 'MATCH' : 'MISMATCH'}  ${a.derivation}  p07=${String(a.audioSha256P07).slice(0, 16)}…  now=${String(a.audioSha256Now).slice(0, 16)}…`);
  }
  console.log(`  allAudioMatches=${checks.allAudioMatches}`);
  console.log('── AC3 session params (re-test vs each P0.7 session.updated frame) ──');
  for (const p of checks.paramChecks) {
    console.log(`  ${p.config}  ${p.paramsMatch ? 'MATCH' : 'MISMATCH'}  p07=${stableStringify(p.p07ClientControlled)}  ours=${stableStringify(p.oursTurnDetection)}${(p.echoedOnlyKeys as string[]).length ? `  (echo-only: ${(p.echoedOnlyKeys as string[]).join(', ')})` : ''}`);
  }
  console.log(`  allParamsMatch=${checks.allParamsMatch}`);
  console.log('── AC4 budget (written before execution) ──');
  console.log(`  cap=¥${checks.budget.capCny}  worstCase=¥${checks.budget.worstCaseTotalCny}  guardPassed=${checks.guardPassed}`);
  console.log(`  sessionsPlanned=${checks.budget.sessionsPlanned} (${checks.budget.configs} configs × ${checks.budget.runsPerConfig} runs)`);
  if (!checks.allAudioMatches) {
    console.error('VERIFY FAILED: audio identity is not proven — a paid run would be blocked.');
    process.exitCode = 1;
  } else {
    console.log('verify ok — safe to run --paid (spends ≤ ¥0.05).');
  }
}

async function paidReplay(runs: number): Promise<Record<string, unknown>> {
  const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
  if (apiKey === '') throw new Error('DASHSCOPE_API_KEY is not set — run `set -a; . ./.env.test; set +a` first.');
  const checks = buildChecks(runs);
  const { p07, byKey, audioChecks, allAudioMatches, paramChecks, allParamsMatch, budget, perSessionWorst, guardPassed } = checks;
  const loopback = readLoopback();

  const section: Record<string, unknown> = {
    schema: 'voice-turn-detection-compare/realtime-timeout-diagnosis@1',
    task: 'gap-voice-turn-detection-p0-12-realtime-timeout-diagnosis',
    ranAt: new Date().toISOString(),
    instrument: 'direct session via createDashscopeTransport + connect with this task’s own observer and socket wrapper; the shared eot-bench adapter is NOT modified',
    budget,
    guardPassed,
    audioChecks,
    allAudioMatches,
    paramChecks,
    allParamsMatch,
    // AC1: the loopback gate passed BEFORE this paid run — both timestamps are in this file.
    loopbackPassedAt: loopback?.passedAt ?? null,
    paidRunAt: new Date().toISOString(),
    loopbackPrecedesPaid: loopback !== null && Date.parse(loopback.passedAt) <= Date.now(),
    loopbackRecord: loopback,
  };

  // ── AC3 is a GATE for the paid sessions, not just a report line ──────────────────────────────
  if (!allAudioMatches) {
    section.status = 'blocked';
    section.blockReason = 'the re-test audio does not hash to the sha256 P0.7 recorded — refusing to open a paid socket against audio that is not proven identical';
    section.spend = { cny: null, basis: 'unknown', note: 'no session ran' };
    writeSection(section);
    console.log(`blocked: ${section.blockReason}`);
    return section;
  }

  if (!guardPassed) {
    section.status = 'blocked';
    section.blockReason = `worst-case ¥${budget.worstCaseTotalCny} exceeds the ¥${BUDGET_CNY} cap — no session opened`;
    section.spend = { cny: null, basis: 'unknown', note: 'no session ran' };
    writeSection(section);
    console.log(`blocked: ${section.blockReason}`);
    return section;
  }

  const sessions: SessionDiagnosis[] = [];
  let cumulativeEstimate = 0;
  let aborted = false;
  // Persist after EVERY session. A paid run that is killed must not leave zero output — the earlier
  // version wrote only at the end, and a crash on the first session lost the spend and the log with it.
  const persist = (status: string): void => {
    section.status = status;
    section.abortedOverBudget = aborted;
    section.sessions = sessions;
    section.spend = {
      cny: null,
      basis: 'unknown',
      upperBoundEstimateCny: Number(cumulativeEstimate.toFixed(6)),
      sessionsCompleted: sessions.length,
      note: 'create_response:false means the endpoint returns no usage (no response.done), so the true charge is UNKNOWN, not zero. upperBoundEstimateCny is a deliberately pessimistic bound, labelled an ESTIMATE.',
    };
    if (sessions.length > 0) section.pairedReplay = summarizePaired(sessions, p07);
    writeSection(section);
  };
  persist('running');
  for (const c of REPLAY_CONFIGS) {
    const span = byKey.get(c.span) as ReplaySpan;
    for (let r = 0; r < runs; r++) {
      if (cumulativeEstimate >= BUDGET_CNY) {
        aborted = true;
        break;
      }
      console.log(`  running ${c.span}@${c.level} (run ${r + 1}/${runs}) ...`);
      const diag = await runDiagnosedSession(span, { apiKey, silenceDurationMs: c.level, closeWaitMs: DEFAULT_CLOSE_WAIT_MS, lateGraceMs: DEFAULT_LATE_GRACE_MS });
      diag.sampleSha256 = p07.sampleSha.get(span.sampleId) ?? '';
      sessions.push(diag);
      cumulativeEstimate += perSessionWorst.find((p) => p.config === `${c.span}@${c.level}`)?.cny ?? 0;
      console.log(`    -> ${diag.status}/${diag.classification} frames=${diag.audio.framesSent} stops=${diag.facts.stopCount} wsClose=${JSON.stringify(diag.ws.close)} wall=${diag.wallClockMs}ms`);
      persist('running');
    }
    if (aborted) break;
  }

  // The invocation that crashed on the first session (a scope bug, now fixed) had already opened and
  // billed ONE real socket. It is recorded here rather than hidden: the spend below does not cover it.
  section.priorFailedAttempt = {
    when: '2026-10-11T08:56Z (approx)',
    command: 'diagnose.mts --paid --runs 2',
    sessionsBilledBeforeCrash: 1,
    configAttempted: 'zh-d01-o85#0@400',
    why: 'a ReferenceError on `perSessionWorst` aborted the loop AFTER the first session returned',
    accountedInSpendBelow: false,
  };
  persist(aborted ? 'partial-budget' : 'completed');
  return section;
}

/** The P0.7-vs-retest side-by-side AC5 asks for, computed rather than asserted. */
function summarizePaired(sessions: SessionDiagnosis[], p07: ReturnType<typeof readP07>): Record<string, unknown> {
  const byConfig = new Map<string, SessionDiagnosis[]>();
  for (const s of sessions) {
    const key = `${s.spanId}@${s.silenceDurationMs}`;
    byConfig.set(key, [...(byConfig.get(key) ?? []), s]);
  }
  const rows = [...byConfig.entries()].map(([key, group]) => {
    const [span, lvlRaw] = key.split('@');
    const level = Number(lvlRaw);
    const p = p07.predictions.find((x) => x.spanId === span && x.silenceDurationMs === level);
    const p07AtLevel = p07.predictions.filter((x) => x.silenceDurationMs === level);
    const timeouts = group.filter((s) => s.status === 'timeout').length;
    // The dead air a person experiences, measured the SAME way P0.7 measured it: from the candidate's
    // onset in the paced timeline to the client RECEIVING an accepted `speech_stopped`. Null when no
    // stop was accepted (a timeout, or a fire the attribution window rejected).
    const userWaits = group
      .filter((s) => s.attribution.acceptedStopWallMs !== null && s.attribution.onsetWallMs !== null)
      .map((s) => s.attribution.acceptedStopWallMs! - s.attribution.onsetWallMs!);
    const p07Waits = p07AtLevel.map((x) => x.userWaitEndpointMs).filter((x): x is number => x !== null);
    return {
      config: key,
      p07: p
        ? {
            status: p.status,
            framesSent: p.audio.framesSent,
            audioMs: p.audio.audioMs,
            speechStopsRelMs: p.attribution.speechStopsRelMs,
            attributedStoppedRelMs: p.attribution.attributedStoppedRelMs,
            userWaitEndpointMs: p.userWaitEndpointMs,
            classificationInferred: inferP07(p),
          }
        : null,
      // The P0.7 batch aggregates its 12 sessions per level (`byLevel.level400` / `level800`): its own
      // p50/p90/max user-wait, its own ok/timeout split, and the sweep's cutoff/missed-END rates with
      // Wilson CIs. Carried verbatim so the side-by-side can quote P0.7's numbers, not re-derive them.
      p07LevelAggregate: (p07.byLevel[`level${level}`] as Record<string, unknown> | undefined) ?? null,
      p07UserWaitMaxMs: p07Waits.length ? Math.max(...p07Waits) : null,
      retest: {
        runs: group.length,
        classifications: group.map((s) => s.classification),
        timeoutCount: timeouts,
        timeoutRate: group.length ? timeouts / group.length : null,
        timeoutRate95Ci: wilson(timeouts, group.length),
        framesSent: group.map((s) => s.audio.framesSent),
        userWaitEndpointMs: userWaits,
        userWaitP50Ms: median(userWaits),
        userWaitP90Ms: p90(userWaits),
        userWaitMaxMs: userWaits.length ? Math.max(...userWaits) : null,
        wsClose: group.map((s) => s.ws.close),
      },
    };
  });
  const all = sessions;
  const allTimeouts = all.filter((s) => s.status === 'timeout');
  const allWaits = all
    .filter((s) => s.attribution.acceptedStopWallMs !== null && s.attribution.onsetWallMs !== null)
    .map((s) => s.attribution.acceptedStopWallMs! - s.attribution.onsetWallMs!);
  const classes = {
    networkWsFailure: allTimeouts.filter((s) => s.classification === 'network-ws-failure').length,
    upstreamNoEvent: allTimeouts.filter((s) => s.classification === 'upstream-no-event').length,
    lateBeyondDeadline: allTimeouts.filter((s) => s.classification === 'late-beyond-deadline').length,
    attributionWindowRejected: allTimeouts.filter((s) => s.classification === 'attribution-window-rejected').length,
  };
  return {
    rows,
    totals: {
      sessionsRun: all.length,
      ok: all.filter((s) => s.status === 'ok').length,
      timeout: allTimeouts.length,
      error: all.filter((s) => s.status === 'error').length,
      timeoutRate: all.length ? allTimeouts.length / all.length : null,
      timeoutRate95Ci: wilson(allTimeouts.length, all.length),
    },
    timeoutClassification: classes,
    labelRates: buildLabelRates(sessions, p07),
    // The retest's endpoint-wait roll-up across ALL accepted sessions, measured exactly as P0.7's
    // `byLevel` measured it (onset → accepted stop). Denominator is the accepted sessions, NOT the
    // sessions run — a rejected/no-stop session has no wait to average, and folding a 0 in would fake
    // a latency the endpoint never produced.
    retestEndpointWait: {
      n: allWaits.length,
      userWaitP50Ms: median(allWaits),
      userWaitP90Ms: p90(allWaits),
      userWaitMaxMs: allWaits.length ? Math.max(...allWaits) : null,
      values: allWaits,
    },
    noteOnDenominators:
      'the P0.7 side is the 24-session batch (12 configs × 400/800 ms); the retest side is 4 configs × N runs, NOT the same n — the two columns are a paired re-check of the SAME configs, not a rate comparison over one denominator.',
  };
}

/**
 * AC5's `false cutoff` / `missed END` columns, on the re-test side. A span is labelled `hold` when the
 * utterance continues past the injected pause, so an ACCEPTED stop on it is the endpoint cutting the
 * user off (a false cutoff); a span labelled `eot` ends there, so the ABSENCE of an accepted stop is a
 * missed END. Network/WS failures are counted separately and are NOT folded into missed END — a socket
 * that died tells you nothing about whether the model would have fired (AC5's explicit exclusion).
 *
 * The denominators are small (the 4-config re-test has 2 hold + 2 eot configs, ×N runs) — which is
 * exactly why every rate is reported with its denominator and a Wilson 95 % interval rather than a bare
 * number. P0.7's own cutoff/missed-END rows ride along in `pairedReplay.rows[].p07LevelAggregate`.
 */
function buildLabelRates(sessions: SessionDiagnosis[], p07: ReturnType<typeof readP07>): Record<string, unknown> {
  const labelBySpan = new Map<string, string>();
  for (const p of p07.predictions) {
    const labels = new Set(p.predictionRows.map((r) => r.label));
    if (labels.size === 1) labelBySpan.set(p.spanId, [...labels][0]);
  }
  const withLabel = sessions.map((s) => ({ s, label: labelBySpan.get(s.spanId) ?? 'unknown' }));
  const hold = withLabel.filter((x) => x.label === 'hold');
  const eot = withLabel.filter((x) => x.label === 'eot');
  const cutoffSessions = hold.filter((x) => x.s.attribution.acceptedStopWallMs !== null);
  const cutoffs = cutoffSessions.length;
  const eotNoStop = eot.filter((x) => x.s.attribution.acceptedStopWallMs === null);
  const missedSessions = eotNoStop.filter((x) => x.s.classification !== 'network-ws-failure');
  const missedEnd = missedSessions.length;
  const networkInEot = eotNoStop.length - missedEnd;
  const configOf = (x: { s: SessionDiagnosis }): string => `${x.s.spanId}@${x.s.silenceDurationMs}`;
  return {
    falseCutoff: {
      count: cutoffs,
      denominator: hold.length,
      rate: hold.length ? cutoffs / hold.length : null,
      rate95Ci: wilson(cutoffs, hold.length),
      configs: [...new Set(cutoffSessions.map(configOf))],
      note: 'an accepted stop on a `hold` span is the endpoint deciding the turn ended where the utterance had not — a false cutoff',
    },
    missedEnd: {
      count: missedEnd,
      denominator: eot.length,
      rate: eot.length ? missedEnd / eot.length : null,
      rate95Ci: wilson(missedEnd, eot.length),
      configs: [...new Set(missedSessions.map(configOf))],
      excludedNetworkFailures: networkInEot,
      note: 'an `eot` span with no ACCEPTED stop; a socket failure is excluded from the numerator and reported in `excludedNetworkFailures` instead',
    },
  };
}

/** Reconstruct P0.7's own classification from its recorded fields — used only for the side-by-side. */
function inferP07(p: P07Prediction): string {
  if (p.status === 'ok') return 'ok';
  if (p.status === 'error') return 'error';
  if (p.attribution.speechStopsRelMs.length === 0) return 'upstream-no-event (no stop frame recorded)';
  return 'attribution-window-rejected (a stop was recorded but not attributed)';
}

function writeSection(section: Record<string, unknown>): void {
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  existing.schema = existing.schema ?? 'voice-turn-detection-compare/realtime-timeout-diagnosis@1';
  existing.task = 'gap-voice-turn-detection-p0-12-realtime-timeout-diagnosis';
  existing.diagnosis = section;
  writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');
  writeRawJsonl(section);
}

/**
 * The Plan's "逐会话 JSONL 原始日志": one line per session, appended verbatim from the same records
 * that sit in RESULT.json. It is a sidecar so the raw log is greppable/streamable without parsing the
 * 100 KB nested artifact, and it is rewritten (not appended) on every persist so a killed run leaves a
 * consistent log rather than a half-written tail.
 */
function writeRawJsonl(section: Record<string, unknown>): void {
  const sessions = (section.sessions as SessionDiagnosis[] | undefined) ?? [];
  if (sessions.length === 0) return;
  const lines = sessions.map(
    (s) =>
      JSON.stringify({
        spanId: s.spanId,
        silenceDurationMs: s.silenceDurationMs,
        status: s.status,
        classification: s.classification,
        classificationDetail: s.classificationDetail,
        sessionId: s.sessionId,
        sampleSha256: s.sampleSha256,
        ws: s.ws,
        audio: s.audio,
        deadline: s.deadline,
        attribution: s.attribution,
        facts: s.facts,
        sent: s.sent,
        received: s.received,
        spendCny: s.spendCny,
        spendBasis: s.spendBasis,
        wallClockMs: s.wallClockMs,
      }),
  );
  writeFileSync(path.join(DIR, 'sessions.jsonl'), lines.join('\n') + '\n');
}

/** Zero-spend: rebuild the report from the committed raw log (pairedReplay/summary) only. */
function reportOnly(): void {
  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as { diagnosis?: { sessions?: SessionDiagnosis[] } }) : {};
  const sessions = existing.diagnosis?.sessions ?? [];
  if (sessions.length === 0) {
    console.error('report: no committed sessions in RESULT.json — run --paid first');
    process.exitCode = 1;
    return;
  }
  const p07 = readP07();
  const section = existing.diagnosis as Record<string, unknown>;
  section.pairedReplay = summarizePaired(sessions, p07);
  section.gapAttribution = buildGapAttribution(sessions, p07);
  writeSection(section);
  console.log(`report rebuilt from ${sessions.length} committed sessions (no spend)`);
}

/**
 * AC6 — every P0.7 timeout and the 14 s anomaly, each with a re-test verdict or an explicit
 * "evidence missing" naming which log class was absent in P0.7.
 */
function buildGapAttribution(sessions: SessionDiagnosis[], p07: ReturnType<typeof readP07>): Record<string, unknown> {
  const retested = new Map<string, SessionDiagnosis[]>();
  for (const s of sessions) {
    const key = `${s.spanId}@${s.silenceDurationMs}`;
    retested.set(key, [...(retested.get(key) ?? []), s]);
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const p of p07.predictions) {
    const key = `${p.spanId}@${p.silenceDurationMs}`;
    const isAnomaly = p.spanId === 'zh-d01-o85#0' && p.silenceDurationMs === 400;
    if (p.status !== 'timeout' && !isAnomaly) continue;
    const group = retested.get(key);
    if (group === undefined) {
      entries.push({
        config: key,
        p07Status: p.status,
        p07Note: isAnomaly ? 'ok but the endpoint waited 14012 ms (onsetAudioMs=4000, speechStopsRelMs=[18012])' : 'timeout',
        verdict: 'evidence-missing',
        retestResult: null,
        missingEvidence: [
          'P0.7 recorded no sent frames, so the sending cadence and byte counts cannot be checked',
          'P0.7 recorded no WS open/error/close, so a socket failure cannot be told from a silent endpoint',
          'P0.7 trimmed nothing else — the received frames ARE complete',
          group === undefined ? 'this config was not part of the 4-config re-test (budget/priority list)' : '',
        ].filter(Boolean),
        cannotAttribute: 'without the sent-frame and WS-lifecycle logs, "upstream never fired" cannot be told from "our sender stalled" or "the socket died" — the diagnosis is therefore NOT inferred from the absent evidence',
      });
      continue;
    }
    entries.push({
      config: key,
      p07Status: p.status,
      p07Note: isAnomaly ? 'ok but the endpoint waited 14012 ms' : 'timeout',
      verdict: 'retested',
      p07InferredClass: inferP07(p),
      retestResult: group.map((s) => ({
        status: s.status,
        classification: s.classification,
        detail: s.classificationDetail,
        framesSent: s.audio.framesSent,
        framesSentBeforeFailure: s.facts.framesSentBeforeFailure,
        stopCount: s.facts.stopCount,
        stops: s.attribution.stops,
        ws: s.ws,
        userWaitEndpointMs:
          s.attribution.acceptedStopWallMs !== null && s.audio.startedAtMs !== null
            ? s.attribution.acceptedStopWallMs - s.audio.startedAtMs
            : null,
      })),
    });
  }
  return {
    why: 'AC6 — the 11 P0.7 timeouts plus the 14 s anomaly, each with a re-test verdict or an explicit statement of the missing evidence; no attribution is inferred from evidence that does not exist',
    entries,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--report')) {
    reportOnly();
    return;
  }
  if (args.includes('--verify')) {
    dryVerify();
    return;
  }
  if (args.includes('--loopback-passed')) {
    recordLoopbackPass();
    return;
  }
  if (!args.includes('--paid')) {
    console.log('diagnose: no --paid flag — nothing was run. Pass --report to rebuild from the committed log, or --paid to run the paired replay (spends ≤ ¥0.05).');
    return;
  }
  const runsIdx = args.indexOf('--runs');
  const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 2;
  const section = await paidReplay(runs);
  writeSection(section);
  console.log(`paid replay: status=${section.status} spend(basis)=${JSON.stringify(section.spend)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
