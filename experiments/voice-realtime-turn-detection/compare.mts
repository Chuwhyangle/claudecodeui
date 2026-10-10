/**
 * GOAL-037 / AC-325 — the turn-detection comparison, run against the REAL endpoint.
 *
 * THE QUESTION. `gap-voice-realtime-turn-detection-configurable-comparison` turned the hard-coded
 * `turn_detection` in the DashScope transport into a parsed value, and AC-325 requires the shipping
 * default to be chosen from MEASUREMENTS rather than from the platform's documentation. The symptom
 * that motivated the task is real and recorded (`server.log`, connection `d88c6722`, 2026-10-10): a
 * four-sentence utterance was cut by the UPSTREAM detector into ELEVEN commits, one of which
 * transcribed to the empty string — and every extra commit is another conversation item that every
 * later response re-reads and re-bills.
 *
 * WHAT IS MEASURED, AND WHY EACH READING. One continuous clip per arm — the clip is streamed the way
 * a browser streams it, so the SERVER's detector is the only thing deciding where utterances end
 * (the segmented relay's `turn_detection: null` never fires here, because that seam is lazy and tied
 * to a `segment_start` this run never sends). Per arm:
 *
 *   · commits                — the utterances the upstream closed. This IS the symptom.
 *   · emptyTranscriptions    — commits that came back as the empty string (the recorded defect).
 *   · responses / failed     — one response per commit is the upstream's default; the count is what
 *                              the bill is denominated in.
 *   · inputTokens, split     — total, plus the audio/text split from `input_tokens_details`, so a
 *                              reader can see the re-read cost rather than a single number.
 *   · relay coverage         — the reference's pause-separated fragments against the union of what
 *                              the upstream transcribed, and the messages the model actually
 *                              forwarded. A low silence window that cuts a thought in half shows up
 *                              HERE, not in the token count.
 *   · speech-end → send      — per forwarded call, from the upstream's own end-of-speech signal to
 *                              the call that carried it. The slower window has to pay for its fewer
 *                              commits somewhere, and this is where.
 *
 * EACH ARM IS A REAL SESSION. The session id is the endpoint's own (`sess_…`), read off the
 * `session.created` frame, and recorded — a trace of fixture-shaped ids would be visible as such.
 *
 * WHY THE RELAXED `session_send` DESCRIPTOR. The shipping descriptor declares `session` as REQUIRED
 * while the shipping instructions ("The session is fixed by the connection; never name one") tell the
 * model to send `{ message }` alone, and the transport WITHHOLDS a call that violates the shape it
 * advertised. This probe measures turn detection, not tool schemas, so it advertises the shape the
 * relay's own instructions describe — the same choice, for the same reason, as
 * `experiments/voice-realtime-segmented/p0/probe-lib.mts`. Tool name unchanged: the trace is read by
 * name.
 *
 * BUDGET. A realtime session bills per response. Every `response.done` is priced on arrival with the
 * SHIPPING `estimateRealtimeCostCny`, accumulated, and the first crossing of either the per-arm or
 * the run budget closes the socket and records `guardTriggered` — the run reports what it spent
 * rather than promising to be careful. The cap is the task's own (≤ ¥0.05, DoD).
 *
 * CREDENTIAL HYGIENE. The key travels in the `Authorization` header only. The artifact is scrubbed
 * before it is written and `writeArtifact` REFUSES to write one that still carries a `sk-…`-shaped
 * string or an `Authorization` header.
 *
 * Run (from the repo root, on a machine with egress and a live key):
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-turn-detection/compare.mts
 *
 * One arm at a time (the arms already recorded in RESULT.json are preserved):
 *
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-turn-detection/compare.mts \
 *       --arms=server_vad@800
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';
import { z } from 'zod';

import {
  connect,
  createDashscopeTransport,
  DEFAULT_SESSION_DEFAULTS,
  DASHSCOPE_REALTIME_ENDPOINT,
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
} from '../../server/modules/voice-realtime/index.js';

// ── paths, constants ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const OUT_FILE = path.join(HERE, 'RESULT.json');

/** The clip: a hesitation-rich four-pause utterance, the same shape as the recorded symptom. */
const CLIP_REL = 'experiments/voice-trim/fixtures/zh-d13-o45.wav';
/** The authored reference the clip was spoken from — the ground truth relay coverage is read against. */
const CLIP_REFERENCE = '呃…我想想…就是在那个设置页面…嗯…加一个开关';
/** The pause-separated fragments of the reference. A low silence window cuts between these. */
const REFERENCE_FRAGMENTS = CLIP_REFERENCE.split(/[…，。！？、,.]/).filter((piece) => piece.trim() !== '');

const MODEL = 'qwen3.8-omni-flash-realtime';
const VOICE = 'Tina';
const SAMPLE_RATE = 16_000;
/** 100 ms of 16-bit mono PCM — the frame size a browser sends. */
const FRAME_MS = 100;
const FRAME_BYTES = ((SAMPLE_RATE * FRAME_MS) / 1000) * 2;
/** The frame pacing: one frame per frame-duration of wall clock, i.e. real time. */
const PACE_MS = FRAME_MS;
/** Digital silence appended so the upstream's detector can close the LAST utterance. */
const TRAILING_SILENCE_MS = 1_500;
/** How long the endpoint must go quiet before the run is called finished. */
const QUIET_WINDOW_MS = 3_000;
/** The hard stop on the wait after the audio ends. */
const MAX_WAIT_MS = 30_000;

const DEFAULT_RUN_BUDGET_CNY = 0.045;
const DEFAULT_ARM_BUDGET_CNY = 0.012;

/** The three arms AC-325 names. */
const ARMS: Array<{ label: string; override: TurnDetectionOverride; note: string }> = [
  {
    label: 'server_vad@400',
    override: { type: 'server_vad', silenceMs: 400 },
    note: 'today`s shipped default — the most aggressive of the three',
  },
  {
    label: 'server_vad@800',
    override: { type: 'server_vad', silenceMs: 800 },
    note: 'the platform-documented default for silence_duration_ms',
  },
  {
    label: 'semantic_vad',
    override: { type: 'semantic_vad' },
    note: 'the semantic detector; the control-plane echo cannot discriminate it (P0-S4), so only behaviour is a reading',
  },
];

/**
 * THE DECISION, and why it is the one the recorded numbers support.
 *
 * The readings are directional — `server_vad@800` closed the clip in fewer commits and lost less
 * than `server_vad@400` on every axis measured — and `suggestedDefault` says so. The SHIPPED default
 * stays 400 anyway, and this is the record of why, so a later reader can disagree with it by pointing
 * at the numbers rather than by re-running the arms:
 *
 *   1. ONE OBSERVATION PER ARM. One clip, one connection each. The SAME 400 ms setting produced 11
 *      commits for four sentences on 2026-10-10 (the recorded symptom) and 5 today — the detector is
 *      not repeatable at this sample size, so a 5-vs-3 difference is a single draw, not a rate.
 *   2. THE COVERAGE METRIC CANNOT TELL FILLER FROM CONTENT. `fragmentCoverage` is contiguous
 *      containment, so losing 呃/嗯 — the two hesitation fillers — costs the same as losing a content
 *      fragment. `semantic_vad` scores 3/5 while dropping ONLY fillers; `server_vad@400` scores 3/5
 *      while also breaking 就是在那个设置页面 apart. Equal scores, unequal losses.
 *   3. THE TASK'S OWN LINE-NEUTRALITY GUARD FIXES THE SHIPPED DEFAULT. AC5 requires an unconfigured
 *      deployment's frames to be byte-identical to what the pre-switch literal produced — that is the
 *      whole point of shipping the knob as a pure refactor. Changing the default would make AC5
 *      false by construction, so the default and the guard cannot both move.
 *   4. THE KNOB IS THE DELIVERABLE. Adopting 800 is now a deployment edit, not a code change:
 *      `VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=800` (or `turnDetection: { silenceMs: 800 }` on one
 *      diagnosis run). Nothing here argues 400 is better — it records that the evidence does not
 *      settle a deployment-wide default, and names the one-line way to take 800 if a deployment wants
 *      it. A future comparison has to beat these numbers: 3 commits / 4-of-5 fragments at 800
 *      against 5 / 3-of-5 at 400.
 */
const DECISION = {
  shippedDefault: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
  kept: true,
  mechanicalSuggestion: 'server_vad@800',
  why:
    'not enough evidence to move a deployment-wide default: one clip and one connection per arm, a ' +
    'detector that produced 11 commits on the same 400 ms setting on 2026-10-10 and 5 today, and a ' +
    'coverage metric that scores a dropped filler the same as dropped content',
  howToAdopt800:
    'VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=800 (deployment), or turnDetection:{silenceMs:800} on one diagnose run',
  revisitWhen: 'a repeated comparison (>=3 connections per arm, >=2 clips) reproduces the commit difference',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

// ── credentials, scrubbing ───────────────────────────────────────────────────────────────────────

const SECRET_SHAPE = /sk-[A-Za-z0-9_-]{16,}/g;

function readApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY ?? '';
  if (key === '') throw new Error('DASHSCOPE_API_KEY is not set — run `set -a; . ./.env.test; set +a` first.');
  return key;
}

/** Replaces the live key and every `sk-…`-shaped token with `<redacted>`. */
function scrubSecrets(text: string, apiKey: string): { text: string; scrubbed: number } {
  let out = text;
  let scrubbed = 0;
  if (apiKey !== '') {
    scrubbed += out.split(apiKey).length - 1;
    out = out.split(apiKey).join('<redacted>');
  }
  out = out.replace(SECRET_SHAPE, () => {
    scrubbed += 1;
    return '<redacted>';
  });
  return { text: out, scrubbed };
}

/** Writes the artifact, scrubbed, and refuses to write one that still carries a credential. */
function writeArtifact(payload: Record<string, unknown>, apiKey: string): { bytes: number; scrubbed: number } {
  const { text, scrubbed } = scrubSecrets(JSON.stringify(payload, null, 2), apiKey);
  SECRET_SHAPE.lastIndex = 0;
  if (SECRET_SHAPE.test(text)) {
    SECRET_SHAPE.lastIndex = 0;
    throw new Error('refusing to write RESULT.json: a sk-…-shaped string survived scrubbing');
  }
  SECRET_SHAPE.lastIndex = 0;
  if (/Authorization/i.test(text)) {
    throw new Error('refusing to write RESULT.json: the artifact carries an Authorization header');
  }
  const body = `${text}\n`;
  writeFileSync(OUT_FILE, body, 'utf8');
  return { bytes: Buffer.byteLength(body, 'utf8'), scrubbed };
}

// ── the clip ─────────────────────────────────────────────────────────────────────────────────────

/** The WAV's PCM payload (canonical 44-byte header stripped) plus its identity and duration. */
function readClip(rel: string): { pcm: Buffer; sha256: string; seconds: number } {
  const wav = readFileSync(path.join(REPO_ROOT, rel));
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${rel} is not a RIFF/WAVE file`);
  }
  const pcm = wav.subarray(44);
  return {
    pcm,
    sha256: createHash('sha256').update(wav).digest('hex'),
    seconds: Number((pcm.length / 2 / SAMPLE_RATE).toFixed(3)),
  };
}

function silence(ms: number): Buffer {
  return Buffer.alloc(((SAMPLE_RATE * ms) / 1000) * 2);
}

// ── text comparison ──────────────────────────────────────────────────────────────────────────────

/** Case-, space- and punctuation-insensitive, so coverage measures content rather than typing. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？、,.!?;；:：'"“”‘’()（）《》〈〉【】\[\]{}—\-…~`*#>|]/g, '');
}

// ── one frame as the observer saw it ─────────────────────────────────────────────────────────────

type ProbeEvent = { direction: 'sent' | 'received'; atMs: number; wire: Record<string, unknown> };

/** The base64 payload is ~320 kB and reproducible from the fixture, so it is elided by byte count. */
function elideAudio(events: ProbeEvent[]): ProbeEvent[] {
  return events.map((event) => {
    const audio = event.wire.audio;
    if (event.wire.type !== 'input_audio_buffer.append' || typeof audio !== 'string') return event;
    return { ...event, wire: { ...event.wire, audioBytes: Math.floor(audio.length * 0.75), audio: '<elided>' } };
  });
}

function countFrames(events: ProbeEvent[], direction: 'sent' | 'received', type: string): number {
  return events.filter((event) => event.direction === direction && event.wire.type === type).length;
}

/**
 * The `session_send` calls the frames carry, in arrival order — one entry per call, not per delivery.
 * Both dialects the endpoint uses are understood and de-duplicated by `call_id`, because the live
 * endpoint delivers one call in BOTH and counting deliveries would report two forwards per forward.
 */
function sessionSendCalls(events: ProbeEvent[]): Array<{ atMs: number; message: string | null }> {
  const found: Array<{ atMs: number; message: string | null }> = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.direction !== 'received') continue;
    const wire = event.wire;
    let raw: string | null = null;
    let callId: string | null = null;
    if (wire.type === 'response.function_call_arguments.done' && wire.name === 'session_send') {
      raw = typeof wire.arguments === 'string' ? wire.arguments : null;
      callId = typeof wire.call_id === 'string' ? wire.call_id : null;
    } else if (wire.type === 'response.output_item.done') {
      const item = (wire.item ?? {}) as Record<string, unknown>;
      if (item.type !== 'function_call' || item.name !== 'session_send') continue;
      raw = typeof item.arguments === 'string' ? item.arguments : null;
      callId = typeof item.call_id === 'string' ? item.call_id : null;
    } else {
      continue;
    }
    if (callId !== null) {
      if (seen.has(callId)) continue;
      seen.add(callId);
    }
    let message: string | null = null;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { message?: unknown };
        message = typeof parsed.message === 'string' ? parsed.message : null;
      } catch {
        message = null;
      }
    }
    found.push({ atMs: event.atMs, message });
  }
  return found;
}

// ── the budget guard ─────────────────────────────────────────────────────────────────────────────

type Budget = { runCap: number; armCap: number; runSpent: number; armSpent: number };
const budget: Budget = { runCap: DEFAULT_RUN_BUDGET_CNY, armCap: DEFAULT_ARM_BUDGET_CNY, runSpent: 0, armSpent: 0 };

// ── one arm ──────────────────────────────────────────────────────────────────────────────────────

type ArmRecord = Record<string, unknown>;

async function runArm(
  arm: { label: string; override: TurnDetectionOverride; note: string },
  clip: ReturnType<typeof readClip>,
  apiKey: string,
): Promise<ArmRecord> {
  const resolution = resolveTurnDetection({}, arm.override);
  const events: ProbeEvent[] = [];
  const transportErrors: Array<Record<string, unknown>> = [];
  const executed: Array<{ message: string | null; atMs: number }> = [];
  const responses: Array<{ atMs: number; status: string | null; usage: unknown; spendCny: number }> = [];
  let sessionId: string | null = null;
  let lastReceivedAtMs = 0;
  let openedSocket: DashscopeSocket | null = null;
  let guardTriggered = false;
  const startedAt = Date.now();

  const observer: DashscopeWireObserver = (observation) => {
    const wire = (observation.wire ?? {}) as Record<string, unknown>;
    events.push({ direction: observation.direction, atMs: observation.atMs, wire });
    if (observation.direction !== 'received') return;
    lastReceivedAtMs = observation.atMs;
    if (wire.type === 'session.created' || wire.type === 'session.updated') {
      const session = wire.session as Record<string, unknown> | undefined;
      if (typeof session?.id === 'string') sessionId = session.id;
    }
    if (wire.type === 'response.done') {
      const response = (wire.response ?? {}) as Record<string, unknown>;
      const usage = response.usage ?? null;
      const rawCost = estimateRealtimeCostCny(usage);
      const cost = Number.isFinite(rawCost) ? rawCost : 0;
      budget.armSpent += cost;
      budget.runSpent += cost;
      responses.push({
        atMs: observation.atMs,
        status: typeof response.status === 'string' ? response.status : null,
        usage,
        spendCny: Number(cost.toFixed(6)),
      });
      if (budget.armSpent > budget.armCap || budget.runSpent > budget.runCap) guardTriggered = true;
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

  const tool: RealtimeToolDescriptor = {
    name: 'session_send',
    description: 'Send a message to the Claude Code session.',
    inputSchema: { message: z.string() },
    outputSchema: {},
  };
  const executor: RealtimeToolExecutor = {
    session_send: (args: Record<string, unknown>) => {
      executed.push({ message: typeof args.message === 'string' ? args.message : null, atMs: Date.now() });
      return { queued: true, message: args.message ?? null };
    },
  };

  const transport = createDashscopeTransport({
    apiKey,
    model: MODEL,
    voice: VOICE,
    // The composition the assembly point performs: the transport's own defaults with only the
    // resolved detector spliced in. `resolveTurnDetection({})` — an EMPTY environment — is what the
    // arm's override resolves against, so the reading is of the override and not of this shell.
    sessionDefaults: { ...DEFAULT_SESSION_DEFAULTS, turn_detection: resolution.turnDetection },
    // The voice connection turns the tool-result resume OFF (measured: the endpoint's default loop
    // made 4 of 8 responses in a recorded session nothing but the model remarking "sent", each one
    // re-reading the whole context). Leaving it on would have each arm pay ~2.5x for a relay that has
    // nothing to say about the result, and would put re-forwarded duplicates in the relay reading.
    respondToToolOutputs: false,
    socketFactory: (url, headers) => {
      const created = realFactory(url, headers);
      openedSocket = created;
      return created;
    },
    observer,
    onError: (error) => transportErrors.push({ ...error } as Record<string, unknown>),
  });
  const bridge: RealtimeBridge = connect(transport, [tool], executor, { maxConnectAttempts: 1 });

  await bridge.whenConnected();
  bridge.sendSessionUpdate(VOICE_REALTIME_INSTRUCTIONS);
  const warm = await waitUntil(() => sessionId !== null, 20_000);

  // ── stream the clip the way a browser does, then the trailing silence ──────────────────────────
  let audioFramesSent = 0;
  let audioStartAtMs: number | null = null;
  let audioEndAtMs: number | null = null;
  if (warm && !guardTriggered) {
    for (let offset = 0; offset < clip.pcm.length; offset += FRAME_BYTES) {
      if (guardTriggered || bridge.state !== 'open') break;
      if (audioStartAtMs === null) audioStartAtMs = Date.now();
      bridge.sendAudioFrame(clip.pcm.subarray(offset, Math.min(offset + FRAME_BYTES, clip.pcm.length)).toString('base64'));
      audioFramesSent += 1;
      await sleep(PACE_MS);
    }
    if (!guardTriggered && bridge.state === 'open') {
      const tail = silence(TRAILING_SILENCE_MS);
      for (let offset = 0; offset < tail.length; offset += FRAME_BYTES) {
        if (guardTriggered || bridge.state !== 'open') break;
        bridge.sendAudioFrame(tail.subarray(offset, Math.min(offset + FRAME_BYTES, tail.length)).toString('base64'));
        audioFramesSent += 1;
        await sleep(PACE_MS);
      }
      audioEndAtMs = Date.now();
    }
  }

  // ── wait for the endpoint to go quiet ──────────────────────────────────────────────────────────
  if (audioEndAtMs !== null && !guardTriggered) {
    await waitUntil(
      () =>
        guardTriggered ||
        (lastReceivedAtMs > 0 &&
          Date.now() - lastReceivedAtMs >= QUIET_WINDOW_MS &&
          Date.now() - (audioEndAtMs as number) >= QUIET_WINDOW_MS),
      MAX_WAIT_MS,
    );
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

  // ── readings, all derived from the frames ──────────────────────────────────────────────────────
  const transcribed = events.filter(
    (event) => event.direction === 'received' && event.wire.type === 'conversation.item.input_audio_transcription.completed',
  );
  const transcripts = transcribed.map((event) => (typeof event.wire.transcript === 'string' ? event.wire.transcript : ''));
  const emptyTranscriptions = transcripts.filter((text) => text.trim() === '').length;
  const joinedTranscript = transcripts.join(' ').trim();
  const normalizedJoined = normalize(joinedTranscript);
  const fragmentCoverage = REFERENCE_FRAGMENTS.map((fragment) => ({
    fragment,
    covered: normalizedJoined.includes(normalize(fragment)),
  }));

  const calls = sessionSendCalls(events);
  // The upstream's own "the user stopped speaking" signal, when it sends one.
  const speechEnds = events
    .filter(
      (event) =>
        event.direction === 'received' &&
        (event.wire.type === 'input_audio_buffer.speech_stopped' ||
          event.wire.type === 'input_audio_buffer.committed' ||
          event.wire.type === 'conversation.item.input_audio_transcription.completed'),
    )
    .map((event) => event.atMs);
  const latencies = calls.map((call) => {
    const anchors = speechEnds.filter((atMs) => atMs <= call.atMs);
    const anchor = anchors.length > 0 ? (anchors[anchors.length - 1] as number) : audioEndAtMs;
    return { ms: anchor === null ? null : call.atMs - anchor, anchor: anchors.length > 0 ? 'upstream end-of-speech' : 'last audio frame' };
  });

  const inputTokens = responses.reduce((sum, r) => sum + Number((r.usage as { input_tokens?: number } | null)?.input_tokens ?? 0), 0);
  const outputTokens = responses.reduce((sum, r) => sum + Number((r.usage as { output_tokens?: number } | null)?.output_tokens ?? 0), 0);
  const audioInputTokens = responses.reduce(
    (sum, r) =>
      sum + Number(((r.usage as { input_tokens_details?: { audio_tokens?: number } } | null)?.input_tokens_details?.audio_tokens ?? 0)),
    0,
  );
  const textInputTokens = responses.reduce(
    (sum, r) =>
      sum + Number(((r.usage as { input_tokens_details?: { text_tokens?: number } } | null)?.input_tokens_details?.text_tokens ?? 0)),
    0,
  );
  const finiteLatencies = latencies.map((entry) => entry.ms).filter((ms): ms is number => ms !== null);

  return {
    label: arm.label,
    note: arm.note,
    override: arm.override,
    resolved: resolution.turnDetection,
    invalid: resolution.invalid,
    sessionId,
    warm,
    guardTriggered,
    wallClockMs: Date.now() - startedAt,
    audio: {
      framesSent: audioFramesSent,
      clipSeconds: clip.seconds,
      trailingSilenceMs: TRAILING_SILENCE_MS,
      pacedMs: PACE_MS,
    },
    commits: transcribed.length,
    speechStopped: countFrames(events, 'received', 'input_audio_buffer.speech_stopped'),
    committed: countFrames(events, 'received', 'input_audio_buffer.committed'),
    transcripts,
    emptyTranscriptions,
    joinedTranscript,
    fragmentCoverage,
    fragmentsCovered: fragmentCoverage.filter((entry) => entry.covered).length,
    fragmentsTotal: fragmentCoverage.length,
    responses: responses.length,
    responsesFailed: responses.filter((r) => r.status !== null && r.status !== 'completed').length,
    errorFrames: countFrames(events, 'received', 'error'),
    transportErrors,
    inputTokens,
    outputTokens,
    audioInputTokens,
    textInputTokens,
    usagePerResponse: responses.map((r) => ({ status: r.status, usage: r.usage, spendCny: r.spendCny })),
    sessionSendCalls: calls.length,
    sessionSendMessages: calls.map((call) => call.message),
    sessionSendExecuted: executed.length,
    sessionSendLatencies: latencies,
    latencyMs: {
      min: finiteLatencies.length > 0 ? Math.min(...finiteLatencies) : null,
      max: finiteLatencies.length > 0 ? Math.max(...finiteLatencies) : null,
    },
    spendCny: Number(budget.armSpent.toFixed(6)),
    frames: { sent: {}, received: {} } as { sent: Record<string, number>; received: Record<string, number> },
    events: elideAudio(events),
  };
}

/** Counts frames by direction and wire type — the reading half of the trace, with no verdict in it. */
function summarizeExchange(events: ProbeEvent[]): { sent: Record<string, number>; received: Record<string, number> } {
  const sent: Record<string, number> = {};
  const received: Record<string, number> = {};
  for (const event of events) {
    const type = String(event.wire.type ?? '<none>');
    const bucket = event.direction === 'sent' ? sent : received;
    bucket[type] = (bucket[type] ?? 0) + 1;
  }
  return { sent, received };
}

// ── the artifact ─────────────────────────────────────────────────────────────────────────────────

/**
 * The shipping default's SOURCE LINE — `path:line` plus the literal, read from the file rather than
 * typed in here, so AC4's "the artifact carries the default's source line" cannot drift from the code.
 */
function defaultSource(): { file: string; line: number; text: string } {
  const rel = 'server/modules/voice-realtime/voice-realtime-turn-detection.ts';
  const lines = readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes('export const DEFAULT_TURN_DETECTION'));
  if (index < 0) throw new Error(`${rel} no longer declares DEFAULT_TURN_DETECTION`);
  return { file: rel, line: index + 1, text: lines[index]?.trim() ?? '' };
}

/** The mechanically-derived suggestion, so the decision is reproducible from the numbers alone. */
function suggestDefault(records: ArmRecord[]): Record<string, unknown> {
  const byLabel = new Map(records.map((record) => [String(record.label), record]));
  const base = byLabel.get('server_vad@400');
  const longer = byLabel.get('server_vad@800');
  const semantic = byLabel.get('semantic_vad');
  const commits = (record: ArmRecord | undefined): number | null =>
    record === undefined ? null : Number(record.commits);
  const full = (record: ArmRecord | undefined): boolean =>
    record !== undefined && Number(record.fragmentsTotal) > 0 && Number(record.fragmentsCovered) === Number(record.fragmentsTotal);
  const why: string[] = [];
  let suggestion: string = 'server_vad@400 (unchanged)';

  if (base !== undefined && semantic !== undefined && commits(semantic)! < commits(base)! && full(semantic) && !full(base)) {
    suggestion = 'semantic_vad';
    why.push(`semantic_vad cut the clip into ${commits(semantic)} commits against ${commits(base)} and covered every fragment, which the 400 window did not`);
  } else if (base !== undefined && longer !== undefined && commits(longer)! < commits(base)!) {
    suggestion = 'server_vad@800';
    why.push(`the 800 ms window cut the clip into ${commits(longer)} commits against ${commits(base)}`);
  } else {
    why.push('no arm produced fewer commits than the shipped 400 ms window (or the arms are indistinguishable at one repetition each)');
  }
  return { suggested: suggestion, basis: why };
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const armArg = process.argv.find((arg) => arg.startsWith('--arms='));
  const wanted = armArg ? armArg.slice('--arms='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const budgetArg = process.argv.find((arg) => arg.startsWith('--budget='));
  if (budgetArg) budget.runCap = Number(budgetArg.slice('--budget='.length));
  const armBudgetArg = process.argv.find((arg) => arg.startsWith('--arm-budget='));
  if (armBudgetArg) budget.armCap = Number(armBudgetArg.slice('--arm-budget='.length));

  const selected = wanted === null ? ARMS : ARMS.filter((arm) => wanted.includes(arm.label));
  if (selected.length === 0) throw new Error(`no arm matched --arms=${wanted?.join(',')}`);
  const clip = readClip(CLIP_REL);
  const ranAt = new Date().toISOString();

  const existing: Record<string, unknown> =
    existsSync(OUT_FILE) ? (JSON.parse(readFileSync(OUT_FILE, 'utf8')) as Record<string, unknown>) : {};
  const artifactOnly = process.argv.includes('--artifact-only');
  const previous = Array.isArray(existing.arms) ? (existing.arms as ArmRecord[]) : [];
  const fresh: ArmRecord[] = [];
  for (const arm of artifactOnly ? [] : selected) {
    budget.armSpent = 0;
    console.log(`▶ arm ${arm.label} — ${arm.note}`);
    const record = await runArm(arm, clip, apiKey);
    (record.frames as { sent: Record<string, number>; received: Record<string, number> }) = summarizeExchange(
      record.events as ProbeEvent[],
    );
    fresh.push(record);
    console.log(
      `  session=${String(record.sessionId)} commits=${record.commits} empty=${record.emptyTranscriptions} ` +
        `responses=${record.responses} in=${record.inputTokens}(a=${record.audioInputTokens},t=${record.textInputTokens}) ` +
        `relay=${record.fragmentsCovered}/${record.fragmentsTotal} send=${record.sessionSendCalls} ` +
        `spend=¥${record.spendCny} guard=${record.guardTriggered}`,
    );
  }

  // Merge: a fresh arm REPLACES the same label; every other recorded arm is preserved.
  const order = ARMS.map((arm) => arm.label);
  const merged = [...previous.filter((old) => !fresh.some((record) => record.label === old.label)), ...fresh].sort(
    (a, b) => order.indexOf(String(a.label)) - order.indexOf(String(b.label)),
  );

  const artifact: Record<string, unknown> = {
    schema: 'voice-realtime-turn-detection-comparison/1',
    goal: 'GOAL-037',
    ac: 'AC-325',
    task: 'gap-voice-realtime-turn-detection-configurable-comparison',
    /** The wall clock of the upstream run; preserved when only the artifact is regenerated. */
    ranAt: artifactOnly && typeof existing.ranAt === 'string' ? existing.ranAt : ranAt,
    artifactRegeneratedAt: artifactOnly ? ranAt : null,
    endpoint: DASHSCOPE_REALTIME_ENDPOINT,
    model: MODEL,
    voice: VOICE,
    clip: {
      file: CLIP_REL,
      sha256: clip.sha256,
      durationSeconds: clip.seconds,
      reference: CLIP_REFERENCE,
      referenceFragments: REFERENCE_FRAGMENTS,
    },
    protocol: {
      turnDetectionSource:
        'resolveTurnDetection({}, override) — an EMPTY environment, so each arm measures its own override and not this shell',
      sessionDefaults: 'DEFAULT_SESSION_DEFAULTS with only turn_detection replaced (the assembly point`s composition)',
      audio: 'whole clip streamed as 100 ms frames at real time, then 1500 ms of digital silence',
      commitOwner: 'the UPSTREAM server VAD — the segmented relay`s turn_detection:null seam is lazy and never fires here',
      respondToToolOutputs: 'false — the shipping voice connection`s own setting (a relay has nothing to say about a tool result)',
      tool: 'session_send advertised as { message } (the shape the shipping instructions describe)',
      arms: ARMS,
    },
    arms: merged,
    budget: {
      capCny: budget.runCap,
      perArmCapCny: budget.armCap,
      /** The sum over EVERY recorded arm, so a run split across invocations still adds up. */
      spentCny: Number(merged.reduce((sum, record) => sum + Number(record.spendCny ?? 0), 0).toFixed(6)),
      thisRunCny: Number(budget.runSpent.toFixed(6)),
      dodCapCny: 0.05,
      guardTriggered: fresh.some((record) => record.guardTriggered === true),
    },
    suggestedDefault: suggestDefault(merged),
    decision: {
      ...DECISION,
      defaultSource: defaultSource(),
      /** The decision object above is fixed in this script's source, so the artifact stays reproducible. */
      recordedIn: 'experiments/voice-realtime-turn-detection/compare.mts (const DECISION)',
    },
    methodology: [
      'fragmentCoverage is contiguous containment against the authored reference; it cannot tell a dropped filler (呃/嗯) from dropped content, so the transcripts are recorded verbatim beside it.',
      'commits and speechStopped come from the upstream`s own frames (`input_audio_buffer.speech_stopped` / `…transcription.completed`), one per utterance the server VAD closed.',
      'speech-end → send latency anchors each forwarded call to the latest upstream end-of-speech signal before it.',
      'one connection per arm, one repetition each: the differences are single observations, not rates.',
      'semantic_vad`s control-plane echo cannot discriminate it (P0-S4), so its arm is read from behaviour alone.',
    ],
    notes: artifactOnly
      ? 'artifact regenerated from the recorded arms (--artifact-only): no new upstream connection was opened'
      : previous.length > 0 && fresh.length < ARMS.length
        ? 'partial run: only the named arms were re-measured'
        : '',
  };

  const written = writeArtifact(artifact, apiKey);
  console.log(`wrote ${OUT_FILE} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  console.log(`spent ¥${budget.runSpent.toFixed(6)} of ¥${budget.runCap}`);
}

main().catch((error) => {
  console.error('comparison failed:', error);
  process.exit(1);
});
