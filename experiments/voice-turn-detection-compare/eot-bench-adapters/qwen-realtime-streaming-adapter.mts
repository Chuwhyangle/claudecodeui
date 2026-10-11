/**
 * The Qwen Realtime STREAMING adapter — `qwen3.8-omni-flash-realtime` measured on the SAME manifest,
 * the SAME candidate points and the SAME policy sweep as the three local batch groups.
 *
 * WHY THIS IS THE POINT OF P0.7. Every prior reading of Qwen realtime in this repository is on a
 * DIFFERENT clip: P0.6's `qwenProbe` was a non-realtime text probe, `qwenProbeRealAudio` was one
 * real clip, and the sibling experiment (`experiments/voice-realtime-turn-detection/`) measured one
 * four-pause utterance per arm. None of those can be placed on group A/B/C's operating-point plane,
 * because an operating point is a property of a (detector, CORPUS, policy) triple and the corpus was
 * different. This adapter removes the splice: the endpoint answers the SAME 44-turn-end/29-pause
 * interrogation points, through the SAME `causalGrid`, and its readings feed the SAME
 * `sweepPolicies`. That is what AC1's "no new/old data splicing" means here.
 *
 * ONE SESSION PER CANDIDATE POINT. eot-bench's streaming contract opens a session per ROW and so does
 * this adapter, for a reason that is not stylistic: the server VAD's state is per-session, and a
 * second candidate point inside one session would inherit the first point's already-committed
 * utterance. Each point therefore gets a fresh socket, a fresh `session.update`, and its own
 * `speech_stopped` to read.
 *
 * IT DRIVES THE SHIPPING TRANSPORT. `createDashscopeTransport` / `connect` / `resolveTurnDetection`
 * are imported from `server/modules/voice-realtime` — the same module the product uses — so the
 * reading is of the endpoint as this codebase reaches it, not of a bespoke client that might differ
 * in frame shape. Nothing in `server/**` is modified (AC10).
 *
 * THE BINARY p_eot, AND WHY. eot-bench's `openai_realtime_adapter.py` maps the provider's
 * `input_audio_buffer.speech_stopped` to `p_eot = 0` before the event and `1` from the silence
 * duration at which it arrived. A server VAD is not a probability model — it fires or it does not —
 * so a binary row is the faithful encoding, and the policy sweep's threshold axis is then
 * degenerate for this group (any threshold in (0, 1] reads the same fire time). The run reports that
 * degeneracy rather than pretending to a threshold sweep the endpoint does not expose.
 *
 * THE TWO LATENCIES AC4 SEPARATES.
 *   · `userWaitEndpointMs` — silence onset (in the paced audio timeline) to the client RECEIVING
 *     `speech_stopped`. This is the dead air a person experiences. It is what the Pareto plots.
 *   · `modelOverheadMs`    — `userWaitEndpointMs` minus the configured `silence_duration_ms`. The
 *     window itself is a POLICY choice, not a model cost; subtracting it leaves the detector's own
 *     inference+network share. When the split is not observable (a timeout) both are null.
 *
 * A MISSED END IS A TIMEOUT; A BROKEN SOCKET IS AN ERROR. AC4 forbids inferring a model error from a
 * missing frame, so the two are recorded in different fields (`status: 'timeout'` vs `'error'`) and
 * only a timeout may be read as "the detector did not fire".
 */

import { WebSocket } from 'ws';
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
  type RealtimeToolDescriptor,
  type RealtimeToolExecutor,
  type TurnDetectionOverride,
} from '../../../server/modules/voice-realtime/index.js';

import { causalGrid, type PredictionRow, type ReplaySpanLike } from './protocol.mts';

export const QWEN_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
export const QWEN_REALTIME_VOICE = 'Tina';
export const SAMPLE_RATE = 16_000;
/** 100 ms of 16-bit mono PCM — the frame size the browser sends and this adapter replays. */
export const FRAME_MS = 100;
export const FRAME_BYTES = ((SAMPLE_RATE * FRAME_MS) / 1000) * 2;

/** One wire frame as the observer saw it, with the wall clock the client stamped on it. */
export type StreamEvent = {
  direction: 'sent' | 'received';
  atMs: number;
  type: string;
  wire: Record<string, unknown>;
};

/** What one real call produced. Every latency is nullable because "not observed" ≠ "zero". */
export type TurnPrediction = {
  spanId: string;
  sampleId: string;
  spanIndex: number;
  /** The `silence_duration_ms` this session was opened with — the rung of the level ladder. */
  silenceDurationMs: number;
  threshold: number;
  detectorType: 'server_vad' | 'semantic_vad';
  sessionId: string | null;
  status: 'ok' | 'timeout' | 'error';
  error: string | null;
  audio: {
    framesSent: number;
    audioMs: number;
    /** Wall clock at which frame 0 went out; the origin of the audio timeline. */
    startedAtMs: number | null;
    endedAtMs: number | null;
    pacedMs: number;
    trailingSilenceMs: number;
  };
  events: StreamEvent[];
  speechStartedAtMs: number | null;
  speechStoppedAtMs: number | null;
  committedAtMs: number | null;
  transcriptAtMs: number | null;
  transcript: string | null;
  /** Silence onset in the AUDIO timeline: where this candidate point sits. */
  onsetAudioMs: number;
  /** AC4 latencies. */
  userWaitEndpointMs: number | null;
  modelOverheadMs: number | null;
  response: {
    created: boolean;
    firstTokenAtMs: number | null;
    commitToFirstTokenMs: number | null;
    toolCalls: Array<{ name: string; atMs: number; msSinceCommit: number | null; arguments: unknown }>;
  };
  spendCny: number;
  usage: unknown;
  predictionRows: PredictionRow[];
  wallClockMs: number;
};

/** How long to wait for the endpoint to close an utterance once the audio has ended. */
export const CLOSE_WAIT_MS = 8_000;
/** How long to wait after the last received frame before declaring the session quiet. */
export const QUIET_WINDOW_MS = 2_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

export type StreamingRunOptions = {
  apiKey: string;
  /** The rung: `silence_duration_ms` for this session. */
  silenceDurationMs: number;
  threshold?: number;
  detectorType?: 'server_vad' | 'semantic_vad';
  /** Ask the endpoint for a response as well as the VAD timeline (AC6's action-commit arm). */
  createResponse?: boolean;
  /** Hard stop on the whole call. */
  timeoutMs?: number;
  /** Called with each accumulated cost so a caller can enforce a run budget between calls. */
  onSpend?: (deltaCny: number, cumulativeCny: number) => void;
  /** A fake-socket factory for a dry run with no egress and no spend. */
  socketFactory?: DashscopeSocketFactory;
  /** The tool the response arm advertises; defaults to the relay's own `session_send` shape. */
  tool?: RealtimeToolDescriptor;
};

/**
 * One real session against one candidate point.
 *
 * Returns the full event timeline and the derived p_eot rows. Never throws for an endpoint-side
 * failure: a socket that died, a session that never warmed and an endpoint that never fired are all
 * RECORDED (`status`), because a thrown exception would lose the timeline that explains them.
 */
export async function predictTurnStreaming(span: ReplaySpanLike, opts: StreamingRunOptions): Promise<TurnPrediction> {
  const startedAt = Date.now();
  const events: StreamEvent[] = [];
  const responses: Array<{ atMs: number; usage: unknown }> = [];
  const toolCalls: Array<{ name: string; atMs: number; arguments: unknown }> = [];
  const errors: Array<Record<string, unknown>> = [];
  const silenceDurationMs = opts.silenceDurationMs;
  const threshold = opts.threshold ?? 0.5;
  const detectorType = opts.detectorType ?? 'server_vad';
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let sessionId: string | null = null;
  let openedSocket: DashscopeSocket | null = null;
  let lastReceivedAtMs = 0;
  let speechStartedAtMs: number | null = null;
  let speechStoppedAtMs: number | null = null;
  let committedAtMs: number | null = null;
  let transcriptAtMs: number | null = null;
  let transcript: string | null = null;
  let responseCreatedAtMs: number | null = null;
  let firstTokenAtMs: number | null = null;
  let spendCny = 0;
  let fatal: string | null = null;

  // The VAD's OWN segmentation, in arrival order. A span's prefix can contain earlier pauses from
  // the same clip, so the FIRST `speech_stopped` is very often an earlier candidate point's — see
  // `attributeEndpoint` below for why the candidate's own event has to be picked out of this list
  // instead of read off the first arrival.
  const speechStartsMs: number[] = [];
  const speechStopsMs: number[] = [];
  const committedMs: number[] = [];
  const transcriptions: Array<{ atMs: number; text: string | null }> = [];

  const observer: DashscopeWireObserver = (observation) => {
    const wire = (observation.wire ?? {}) as Record<string, unknown>;
    const type = typeof wire.type === 'string' ? wire.type : '(untyped)';
    events.push({ direction: observation.direction, atMs: observation.atMs, type, wire });
    if (observation.direction !== 'received') return;
    lastReceivedAtMs = observation.atMs;
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
      case 'response.created':
        if (responseCreatedAtMs === null) responseCreatedAtMs = observation.atMs;
        break;
      case 'response.output_audio.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.text.delta':
        if (firstTokenAtMs === null) firstTokenAtMs = observation.atMs;
        break;
      case 'response.function_call_arguments.done': {
        toolCalls.push({
          name: typeof wire.name === 'string' ? wire.name : '(unnamed)',
          atMs: observation.atMs,
          arguments: wire.arguments ?? null,
        });
        break;
      }
      case 'response.done': {
        const response = (wire.response ?? {}) as Record<string, unknown>;
        const usage = response.usage ?? null;
        const raw = estimateRealtimeCostCny(usage);
        const cost = Number.isFinite(raw) ? raw : 0;
        spendCny += cost;
        responses.push({ atMs: observation.atMs, usage });
        opts.onSpend?.(cost, spendCny);
        break;
      }
      default:
        break;
    }
  };

  const realFactory: DashscopeSocketFactory = (url, headers) => {
    const ws = new WebSocket(url, { headers });
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
    ws.on('error', (error) => socket.onerror?.(error));
    ws.on('close', (code, reason) => socket.onclose?.({ code, reason: String(reason) }));
    return socket;
  };

  // The override is the rung. `resolveTurnDetection({})` — an EMPTY environment — is the baseline it
  // resolves against, so the reading is of THIS rung and not of whatever the shell exported.
  const override: TurnDetectionOverride = { type: detectorType, silenceMs: silenceDurationMs };
  const resolution = resolveTurnDetection({}, override);

  const tool: RealtimeToolDescriptor =
    opts.tool ?? {
      name: 'session_send',
      description: 'Send a message to the Claude Code session.',
      inputSchema: { message: z.string() },
      outputSchema: {},
    };
  const executor: RealtimeToolExecutor = {
    session_send: (args: Record<string, unknown>) => ({ queued: true, message: args.message ?? null }),
  };

  const transport = createDashscopeTransport({
    apiKey: opts.apiKey,
    model: QWEN_REALTIME_MODEL,
    voice: QWEN_REALTIME_VOICE,
    sessionDefaults: {
      ...DEFAULT_SESSION_DEFAULTS,
      turn_detection: {
        ...resolution.turnDetection,
        // DashScope mirrors the OpenAI realtime session schema, where `turn_detection` carries
        // `create_response` / `interrupt_response` alongside the detector parameters:
        //   · AC4: the VAD TIMELINE is the reading. The endpoint's default is to start a response per
        //     commit, which bills every point's whole accumulated context; the bulk pass turns that
        //     off so the timeline can be read on all points instead of a handful. The action-commit
        //     arm (AC6) turns it back on explicitly.
        //   · `interrupt_response: false` keeps the response from being cancelled if the endpoint's
        //     own VAD re-opens on the tail — the arm measures the FIRST response, not a preempted one.
        ...(opts.createResponse === true ? {} : { create_response: false, interrupt_response: false }),
      } as typeof DEFAULT_SESSION_DEFAULTS.turn_detection,
    },
    respondToToolOutputs: false,
    socketFactory:
      opts.socketFactory ??
      ((url, headers) => {
        const created = realFactory(url, headers);
        openedSocket = created;
        return created;
      }),
    observer,
    onError: (error) => errors.push({ ...error } as Record<string, unknown>),
  });

  let bridge: RealtimeBridge;
  try {
    bridge = connect(transport, [tool], executor, { maxConnectAttempts: 1 });
    await bridge.whenConnected();
    bridge.sendSessionUpdate(VOICE_REALTIME_INSTRUCTIONS);
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
    const prediction = emptyPrediction(span, { silenceDurationMs, threshold, detectorType, startedAt, fatal: `connect failed: ${fatal}`, events, errors });
    return prediction;
  }

  const warm = await waitUntil(() => sessionId !== null || fatal !== null, 20_000);
  if (!warm && fatal === null) fatal = 'session did not warm within 20000 ms (no session.created frame)';

  // ── stream the span's PCM at real time, so the endpoint sees the pace a browser sends -----------
  let framesSent = 0;
  let audioStartedAtMs: number | null = null;
  let audioEndedAtMs: number | null = null;
  const pcm16 = floatToPcm16(span.audio);
  for (let offset = 0; offset < pcm16.length; offset += FRAME_BYTES) {
    if (fatal !== null || bridge.state !== 'open' || Date.now() - startedAt > timeoutMs) break;
    if (audioStartedAtMs === null) audioStartedAtMs = Date.now();
    bridge.sendAudioFrame(pcm16.subarray(offset, Math.min(offset + FRAME_BYTES, pcm16.length)).toString('base64'));
    framesSent += 1;
    if (audioEndedAtMs === null && offset + FRAME_BYTES >= pcm16.length) audioEndedAtMs = Date.now();
    await sleep(FRAME_MS);
  }

  const audioMs = (framesSent * FRAME_MS);
  // The silence onset in the audio timeline: this candidate point's own offset, clamped into what
  // was actually streamed.
  const onsetAudioMs = Math.max(0, Math.min(span.onsetMs, audioMs));
  const onsetWallMs = audioStartedAtMs === null ? null : audioStartedAtMs + onsetAudioMs;

  // ── wait for the endpoint to close THIS candidate's utterance (or to run out of patience) ──────
  // The wait has to be a real one and not the first arrival: the frame that matters is the one the
  // endpoint fires AFTER the onset, which can only land once its own `silence_duration_ms` has
  // elapsed from that onset.
  const earliestPossibleMs = onsetWallMs === null ? Number.POSITIVE_INFINITY : onsetWallMs + silenceDurationMs * 0.9;
  const attributionCtx = { onsetWallMs, earliestPossibleMs, speechStartsMs, speechStopsMs, committedMs, transcriptions };
  let status: TurnPrediction['status'] = 'ok';
  if (fatal === null && framesSent > 0) {
    // Wait for a stop this candidate can actually claim — not merely any stop past the earliest
    // instant, which a later pause's fire would otherwise satisfy and then get rejected.
    await waitUntil(
      () => attributeEndpoint(attributionCtx).stoppedAtMs !== null || fatal !== null,
      Math.min(CLOSE_WAIT_MS, timeoutMs),
    );
    const stop = attributeEndpoint(attributionCtx);
    speechStoppedAtMs = stop.stoppedAtMs;
    committedAtMs = stop.committedAtMs;
    transcriptAtMs = stop.transcriptAtMs;
    transcript = stop.transcript;
    // The endpoint's speech that this candidate ends: the last resume at or before the onset.
    const starts = speechStartsMs.filter((t) => onsetWallMs !== null && t <= onsetWallMs);
    speechStartedAtMs = starts.length > 0 ? starts[starts.length - 1] : null;
    if (speechStoppedAtMs === null) status = 'timeout';
  } else if (fatal !== null) {
    status = 'error';
  }

  if (status === 'ok' && opts.createResponse === true && fatal === null) {
    await waitUntil(() => firstTokenAtMs !== null || toolCalls.length > 0 || fatal !== null, Math.min(8_000, timeoutMs));
    // let a trailing tool call land
    await sleep(300);
  }

  try {
    await bridge.close();
  } catch {
    /* a socket already gone is the state close wants */
  }
  try {
    openedSocket?.close();
  } catch {
    /* same */
  }

  // ── the two latencies AC4 separates ------------------------------------------------------------
  const userWaitEndpointMs =
    speechStoppedAtMs !== null && audioStartedAtMs !== null ? Math.max(0, speechStoppedAtMs - audioStartedAtMs - onsetAudioMs) : null;
  const modelOverheadMs = userWaitEndpointMs !== null ? Number((userWaitEndpointMs - silenceDurationMs).toFixed(3)) : null;

  // ── the binary p_eot rows, eot-bench `build_event_prediction_rows` ------------------------------
  const grid = causalGrid(span, {});
  const fireSilenceMs = userWaitEndpointMs !== null ? Number((userWaitEndpointMs - silenceDurationMs).toFixed(3)) + silenceDurationMs : null;
  const predictionRows: PredictionRow[] = grid.map((cell) => ({
    id: spanKeyOf(span),
    spanIndex: span.spanIndex,
    timestamp: cell.timestampMs,
    silence_dur: cell.silenceDurMs,
    // 0 before the event, 1 from the silence duration at which `speech_stopped` arrived — the same
    // encoding eot-bench's OpenAI Realtime adapter uses for a server VAD.
    p_eot: fireSilenceMs === null ? 0 : cell.silenceDurMs >= fireSilenceMs ? 1 : 0,
    label: cell.label,
  }));

  return {
    spanId: spanKeyOf(span),
    sampleId: span.sampleId,
    spanIndex: span.spanIndex,
    silenceDurationMs,
    threshold,
    detectorType,
    sessionId,
    status: fatal !== null ? 'error' : status,
    error: fatal ?? (errors.length > 0 ? JSON.stringify(errors[0]).slice(0, 400) : null),
    audio: {
      framesSent,
      audioMs,
      startedAtMs: audioStartedAtMs,
      endedAtMs: audioEndedAtMs,
      pacedMs: FRAME_MS,
      trailingSilenceMs: span.appendedTailMs,
    },
    events,
    speechStartedAtMs,
    speechStoppedAtMs,
    committedAtMs,
    transcriptAtMs,
    transcript,
    onsetAudioMs,
    userWaitEndpointMs,
    modelOverheadMs,
    /**
     * The raw attribution inputs, kept so a timeout can be told apart from a mis-attribution without
     * re-running a paid session: `onsetWallMs` is where this candidate's silence begins in wall time,
     * `earliestPossibleMs` is the first instant a fire could belong to it, and the two event lists are
     * offsets from the first sent frame so they can be compared against `onsetWallMs` directly.
     */
    attribution: {
      onsetWallMs,
      earliestPossibleMs,
      audioStartedAtMs,
      speechStartsRelMs: speechStartsMs.map((t) => (audioStartedAtMs === null ? null : t - audioStartedAtMs)),
      speechStopsRelMs: speechStopsMs.map((t) => (audioStartedAtMs === null ? null : t - audioStartedAtMs)),
      committedRelMs: committedMs.map((t) => (audioStartedAtMs === null ? null : t - audioStartedAtMs)),
      attributedStoppedRelMs: speechStoppedAtMs === null || audioStartedAtMs === null ? null : speechStoppedAtMs - audioStartedAtMs,
    },
    response: {
      created: responseCreatedAtMs !== null,
      firstTokenAtMs,
      commitToFirstTokenMs:
        firstTokenAtMs !== null && committedAtMs !== null ? Math.max(0, firstTokenAtMs - committedAtMs) : null,
      toolCalls: toolCalls.map((call) => ({
        ...call,
        msSinceCommit: committedAtMs === null ? null : Math.max(0, call.atMs - committedAtMs),
      })),
    },
    spendCny: Number(spendCny.toFixed(6)),
    usage: responses.length > 0 ? responses[responses.length - 1].usage : null,
    predictionRows,
    wallClockMs: Date.now() - startedAt,
  };
}

/**
 * Pick the endpoint event that belongs to THIS candidate point out of the session's event stream.
 *
 * WHY THE FIRST `speech_stopped` IS THE WRONG ONE. A span's PCM is a prefix of a whole clip, and a
 * clip's prefix can contain earlier within-turn pauses (that is what a second candidate point IS).
 * The endpoint's VAD has no idea which pause we are asking about, so it fires at each of them, and
 * the earliest `speech_stopped` generally belongs to whichever pause came first — measured on
 * `zh-d01-o85+inject700ms#1`, where the first arrival was the injected pause at ~0.8 s and the
 * candidate's own turn end fired ~1.2 s later. Reading the first arrival therefore scores one
 * candidate point with another one's event.
 *
 * THE RULE, AND WHY IT IS CAUSAL. The candidate's silence starts at the onset, so its fire cannot
 * arrive before `silence_duration_ms` has elapsed from the onset (`earliestPossibleMs`, with 10%
 * slack for pacing jitter); and a resume arriving between the onset and the fire means the silence
 * was interrupted, so that fire belongs to a LATER run — this is what keeps a short within-turn
 * pause (long enough to resume but too short to fire) from being credited with the CLIP's trailing
 * silence. A later fire is therefore correctly read as "this candidate never fired", i.e. a timeout,
 * rather than as a detection.
 */
function attributeEndpoint(ctx: {
  onsetWallMs: number | null;
  earliestPossibleMs: number;
  speechStartsMs: number[];
  speechStopsMs: number[];
  committedMs: number[];
  transcriptions: Array<{ atMs: number; text: string | null }>;
}): { stoppedAtMs: number | null; committedAtMs: number | null; transcriptAtMs: number | null; transcript: string | null } {
  const { onsetWallMs } = ctx;
  if (onsetWallMs === null) return { stoppedAtMs: null, committedAtMs: null, transcriptAtMs: null, transcript: null };
  const stoppedAtMs =
    ctx.speechStopsMs.find(
      (t) => t >= ctx.earliestPossibleMs && !ctx.speechStartsMs.some((s) => s > onsetWallMs && s < t),
    ) ?? null;
  if (stoppedAtMs === null) return { stoppedAtMs: null, committedAtMs: null, transcriptAtMs: null, transcript: null };
  // The commit and the transcript belong to THIS stop, so they are looked up at or AFTER it — an
  // earlier pause in the same prefix already produced its own commit/transcript, and matching on the
  // onset would hand this candidate the previous pause's response.
  const committedAtMs = ctx.committedMs.find((t) => t >= stoppedAtMs) ?? null;
  const transcription = ctx.transcriptions.find((e) => e.atMs >= stoppedAtMs) ?? null;
  return {
    stoppedAtMs,
    committedAtMs,
    transcriptAtMs: transcription?.atMs ?? null,
    transcript: transcription?.text ?? null,
  };
}

function spanKeyOf(span: ReplaySpanLike): string {
  return `${span.sampleId}#${span.spanIndex}`;
}

/** The `p_eot` score table a prediction's rows carry, in the protocol's cell order. */
export function scoresFromPrediction(prediction: TurnPrediction): number[] {
  return prediction.predictionRows.map((row) => row.p_eot);
}

function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

function emptyPrediction(
  span: ReplaySpanLike,
  ctx: { silenceDurationMs: number; threshold: number; detectorType: 'server_vad' | 'semantic_vad'; startedAt: number; fatal: string; events: StreamEvent[]; errors: Array<Record<string, unknown>> },
): TurnPrediction {
  return {
    spanId: spanKeyOf(span),
    sampleId: span.sampleId,
    spanIndex: span.spanIndex,
    silenceDurationMs: ctx.silenceDurationMs,
    threshold: ctx.threshold,
    detectorType: ctx.detectorType,
    sessionId: null,
    status: 'error',
    error: ctx.fatal,
    audio: { framesSent: 0, audioMs: 0, startedAtMs: null, endedAtMs: null, pacedMs: FRAME_MS, trailingSilenceMs: span.appendedTailMs },
    events: ctx.events,
    speechStartedAtMs: null,
    speechStoppedAtMs: null,
    committedAtMs: null,
    transcriptAtMs: null,
    transcript: null,
    onsetAudioMs: span.onsetMs,
    userWaitEndpointMs: null,
    modelOverheadMs: null,
    response: { created: false, firstTokenAtMs: null, commitToFirstTokenMs: null, toolCalls: [] },
    spendCny: 0,
    usage: null,
    predictionRows: [],
    wallClockMs: Date.now() - ctx.startedAt,
  };
}
