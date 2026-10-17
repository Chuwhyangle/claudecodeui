/**
 * Uplink VAD in the PRODUCTION SEAM — the continuous wire's per-frame speech gate, read end to end.
 *
 * WHAT THIS FILE PINS. `voice-realtime-uplink-vad.ts` derives, per frame, whether a browser frame is
 * speech and (for a non-speech run) whether it is inside the opening `a` window; the proxy
 * (`voice-realtime-ws-proxy.service.ts`) feeds it the continuous wire's frames and forwards whatever it
 * lets through. The whole point of this task is that the feature is DEFAULT OFF and, off, the relay is
 * the SAME relay it was — byte for byte — so most of what follows is written against that identity, and
 * against the three couplings the seam is easiest to break: the local speech gate (the watchdog's
 * boundary reading), the pool's activity clock, and the send-decision frame set.
 *
 * WHY THE RELAY-LEVEL LEGS READ `turn_unanswered` AND `rotations`. Neither `localSpeechGate.observe` nor
 * `bridge.noteLocalActivity` has a seam to count through, and adding one just to be counted would be a
 * production change made for a test. Both DO have a consequence the browser already sees: a local
 * utterance that ends with no upstream answer arms the stall watchdog (`turn_unanswered`), and a pool
 * that is never told the connection is active rotates (`onRotate`). So the two couplings are read at the
 * relay, off the same signals the shipping code already emits — the pattern the sibling STS suite uses.
 *
 * WHY THE `a` WINDOW IS LOAD-BEARING FOR AC3, AND WHY THAT LEG PINS ITS OWN WINDOW. The local speech gate
 * needs `DEFAULT_EXIT_FRAMES = 25` consecutive quiet frames to close an utterance, so for the AC3 leg to
 * show anything at all the VAD's head-keep window `a` must be SMALLER than that run — otherwise the quiet
 * frames that close the utterance sit inside the window, every one of them is forwarded, and the leg
 * would pass while proving nothing. `a` is `(silence + 200 ms margin)/20 + 1`, so that needs a silence
 * window under 280 ms: neither the 400 ms the gate once shipped (a = 31, and this doc's long-standing
 * `a = 21` was the same intent written against a window the leg never actually drove) nor the 800 ms it
 * ships today (a = 51) qualifies. The leg therefore names its own `silenceDurationMs` on the seam instead
 * of riding on the shipped default: the property it tests — the local gate is fed on ARRIVAL,
 * unconditionally — is a property of the proxy's WIRING and must hold at every window. If the local gate
 * were fed only what crossed the wire, its utterance would never close and the watchdog would never arm —
 * which is exactly what the AC3 false form reproduces, and why the AC3 reading is not vacuous.
 *
 * WHY THE FIXED-SIZE CORPORA ARE WRITTEN AS `A_DEFAULT + N` WHERE THEY WERE `30`. A corpus of 30 quiet
 * frames used to be longer than `a` and now is not, so those legs would stop dropping anything and quietly
 * become vacuous at the new default. Sizing them off `A_DEFAULT` keeps the drop — and the reading — real
 * at whichever window the shipped default resolves to.
 *
 * Consumers: the quay worker's AC state for `gap-voice-uplink-vad-production-seam`, and — from the
 * VERIFICATION task's own section at the foot of this file — `gap-voice-uplink-vad-real-ab-and-e2e-verification`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  UPLINK_VAD_FRAME_BYTES,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from '../voice-realtime-uplink-vad.js';
import {
  createUplinkVadGate,
  uplinkHeadKeepFrames,
  UPLINK_VAD_EXIT_STEPS,
  UPLINK_VAD_HOLD_OPEN_MAX_MS,
  uplinkVadExitHasCommitAndResponse,
  uplinkVadExitIsWellFormed,
  UPLINK_VAD_FRAME_MS,
  type UplinkVadGate,
} from '../voice-realtime-uplink-vad-gate.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { type SilenceTailOptions } from '../voice-realtime-silence-tail.js';
import { DEFAULT_TURN_DETECTION } from '../voice-realtime-turn-detection.js';
import type { RealtimeToolExecutor, UpstreamPoolRotation } from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── the corpus ────────────────────────────────────────────────────────────────────────────────────

/** One audio frame — the browser's relay cadence, and what the gate's index space counts in. */
const FRAME_MS = UPLINK_VAD_FRAME_MS;
/** Room tone: silent to any VAD, and above digital silence so it is real (unreadable) audio. */
const SILENCE_RMS = 12;
/** Speech: well above the classifier's own threshold — the classifier here is scripted, not level-based. */
const SPEECH_RMS = 500;

/** One PCM16 square wave of exactly one grid frame, with `index` written into its head. */
function pcmFrame(amplitude: number, index: number): string {
  const samples = UPLINK_VAD_FRAME_BYTES / 2;
  const pcm = Buffer.alloc(UPLINK_VAD_FRAME_BYTES);
  for (let sample = 0; sample < samples; sample += 1) {
    pcm.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  // A four-sample marker makes every frame's payload unique, so a leg can ask whether THE frame that was
  // spoken crossed the wire, not whether some frame of the right length did. The step is +1..+8 on the
  // head, far too small to change any level the relay reads.
  for (let slot = 0; slot < 4; slot += 1) {
    const step = (Math.floor(index / 8 ** slot) % 8) + 1;
    pcm.writeInt16LE((slot % 2 === 0 ? 1 : -1) * (amplitude + step), slot * 2);
  }
  return pcm.toString('base64');
}

/** One built frame: its payload, its unique identity, and the truth about whether it is speech. */
type Frame = { index: number; audio: string; speech: boolean };

/** Builds a corpus from a compact spec, assigning stable indices and unique payloads. */
function build(specs: readonly { speech: boolean; count: number }[], startIndex = 0): Frame[] {
  const frames: Frame[] = [];
  for (const spec of specs) {
    for (let n = 0; n < spec.count; n += 1) {
      const index = startIndex + frames.length;
      frames.push({ index, audio: pcmFrame(spec.speech ? SPEECH_RMS : SILENCE_RMS, index), speech: spec.speech });
    }
  }
  return frames;
}

/** The head-keep window the shipped default resolves to, DERIVED rather than written down. */
const A_DEFAULT = uplinkHeadKeepFrames(DEFAULT_TURN_DETECTION.silence_duration_ms);
/** The local speech gate's own closing run (`voice-realtime-local-speech.ts`, `DEFAULT_EXIT_FRAMES`). */
const LOCAL_EXIT_FRAMES = 25;

// ── the scripted classifier ───────────────────────────────────────────────────────────────────────

type FakeClassifier = UplinkVadClassifier & {
  /** Every grid frame the classifier was handed, in order. */
  readonly fed: Buffer[];
  readonly flushes: number;
  readonly closes: number;
};

/**
 * A classifier whose verdicts are scripted by `pattern` (index-aligned with the corpus), with an
 * optional `lag` in frames.
 *
 * `lag` is why the gate is a BUFFERING gate rather than a pass-through: the two windowed backends cannot
 * answer a frame until one or two later frames have arrived, so a leg that never lags would not exercise
 * the ordering the gate exists to preserve.
 */
function createFakeClassifier(pattern: readonly boolean[], options: { lag?: number } = {}): FakeClassifier {
  const lag = options.lag ?? 0;
  const fed: Buffer[] = [];
  const queue: UplinkVadFrameVerdict[] = [];
  let next = 0;
  let flushes = 0;
  let closes = 0;
  const verdictFor = (index: number): UplinkVadFrameVerdict => {
    // Out of pattern ⇒ speech, because fail-open is the one direction a VAD must never get wrong.
    const speech = pattern[index] ?? true;
    return { frameIndex: index, speech, probability: speech ? 0.9 : 0.05, bypassed: false, reason: null };
  };
  return {
    backend: 'webrtc',
    status: 'available',
    reason: null,
    fed,
    get flushes(): number {
      return flushes;
    },
    get closes(): number {
      return closes;
    },
    async classify(frame: Buffer): Promise<UplinkVadFrameVerdict | null> {
      fed.push(frame);
      const index = next;
      next += 1;
      queue.push(verdictFor(index));
      if (queue.length <= lag) {
        return null;
      }
      return queue.shift() as UplinkVadFrameVerdict;
    },
    async flush(): Promise<UplinkVadFrameVerdict[]> {
      flushes += 1;
      return queue.splice(0);
    },
    async close(): Promise<void> {
      closes += 1;
    },
  };
}

/** A classifier that calls itself unavailable: every frame must come back BYPASSED, i.e. forwarded. */
function createUnavailableClassifier(): FakeClassifier {
  const fed: Buffer[] = [];
  let next = 0;
  let flushes = 0;
  let closes = 0;
  return {
    backend: 'silero',
    status: 'unavailable',
    reason: 'no weights at /nonexistent/silero.onnx',
    fed,
    get flushes(): number {
      return flushes;
    },
    get closes(): number {
      return closes;
    },
    async classify(frame: Buffer): Promise<UplinkVadFrameVerdict | null> {
      fed.push(frame);
      const index = next;
      next += 1;
      return { frameIndex: index, speech: true, probability: null, bypassed: true, reason: 'backend unavailable' };
    },
    async flush(): Promise<UplinkVadFrameVerdict[]> {
      flushes += 1;
      return [];
    },
    async close(): Promise<void> {
      closes += 1;
    },
  };
}

/** Collects a whole corpus through a gate, so a leg can read the wire it produced and its final stats. */
async function runGate(
  gate: UplinkVadGate,
  frames: readonly Frame[],
): Promise<{
  wired: string[];
  sawSpeech: boolean;
  aFrames: number;
  preRollFrames: number;
  stats: { sent: number; headKept: number; dropped: number; bypassed: number; preRoll: number };
}> {
  const wired: string[] = [];
  let stats = { sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };
  for (const frame of frames) {
    const decision = await gate.observe(frame.audio);
    wired.push(...decision.frames);
    stats = {
      sent: decision.sent,
      headKept: decision.headKept,
      dropped: decision.dropped,
      bypassed: decision.bypassed,
      preRoll: decision.preRoll,
    };
  }
  const tail = await gate.flush();
  wired.push(...tail.frames);
  stats = { sent: tail.sent, headKept: tail.headKept, dropped: tail.dropped, bypassed: tail.bypassed, preRoll: tail.preRoll };
  return { wired, sawSpeech: gate.seenSpeech, aFrames: gate.aFrames, preRollFrames: gate.preRollFrames, stats };
}

/** The wire indices of a run of frames, by their unique payloads — the order/duplication readings use it. */
function wireIndices(wired: readonly string[], frames: readonly Frame[]): number[] {
  return wired.map((audio) => frames.find((frame) => frame.audio === audio)?.index ?? -1);
}

// ── the relay: the proxy's continuous branch over a fake socket and fake upstreams ────────────────

/** The slice of the browser socket the proxy touches — the same shape the sibling suites use. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type Wired = {
  socket: FakeBrowserSocket;
  transports: FakeTransport[];
  logs: string[];
  rotations: UpstreamPoolRotation[];
  /** Every `session_send` message the executor was handed, in order (the recovery leg reads the text). */
  delivered: string[];
};

/**
 * One continuous-mode proxy connection over a fake browser socket and fake upstreams.
 *
 * `uplinkVad`/`silenceTail` are passed only when the arm wants that gate on: the seam's PRESENCE is the
 * switch, exactly as `resolveUplinkVad` leaves it, so the gate-off arms are wired the way a deployment
 * that named no environment variable is wired.
 */
function wire(
  options: {
    uplinkVad?: { classifier: UplinkVadClassifier; silenceDurationMs?: number; exitWaitMs?: number };
    silenceTail?: SilenceTailOptions;
    stallMs?: number;
    idleRotateMs?: number;
    /** Overrides the pinned continuous default, so a leg can read the segmented wire's behaviour. */
    segmentedRelay?: boolean;
  } = {},
): Wired {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const rotations: UpstreamPoolRotation[] = [];
  const delivered: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      delivered.push(String(args.message ?? ''));
      return { runId: 'run-1', queued: false };
    },
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => executor,
    instructions: 'test instructions',
    // Pinned rather than inherited: `VOICE_REALTIME_MODE` in the ambient environment could make this a
    // segmented connection, and the segmented wire carries no bare `audio` frames at all.
    segmentedRelay: options.segmentedRelay ?? false,
    log: (line) => logs.push(line),
    ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
    ...(options.idleRotateMs === undefined
      ? {}
      : {
          upstreamPool: {
            idleRotateMs: options.idleRotateMs,
            onRotate: (rotation) => rotations.push(rotation),
          },
        }),
    ...(options.silenceTail === undefined ? {} : { silenceTail: options.silenceTail }),
    ...(options.uplinkVad === undefined ? {} : { uplinkVad: options.uplinkVad }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs, rotations, delivered };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

/** Every audio payload the ACTIVE upstream was handed, in order — what `sendAudioFrame` put on the wire. */
const appends = (wired: Wired): string[] =>
  (wired.transports[0]?.sent ?? [])
    .filter((message) => message.type === 'input_audio_buffer.append')
    .map((message) => (message as { audio: string }).audio);

/** Every client→server message type the active upstream was handed, in order (the frame-type audit). */
const sentTypes = (wired: Wired): string[] => (wired.transports[0]?.sent ?? []).map((message) => message.type);

const turnUnanswered = (wired: Wired): number =>
  wired.socket.outbound.filter((frame) => frame.type === 'turn_unanswered').length;

/** Feeds one corpus, yielding to the event loop every `chunk` frames and between chunks. */
async function feed(wired: Wired, frames: readonly Frame[], chunk = 50, betweenMs = 0): Promise<void> {
  for (let sent = 0; sent < frames.length; sent += 1) {
    wired.socket.receive({ type: 'audio', audio: frames[sent]!.audio });
    if ((sent + 1) % chunk === 0) {
      // A macrotask boundary, so a timer the pool or the watchdog armed can actually fire while frames
      // are still arriving. Without it a synchronous feed would hide the very false trigger a leg names.
      await new Promise((resolve) => setTimeout(resolve, betweenMs));
    }
  }
}

/** Lets the gate's async chain (and any arming timer) settle. */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── the false forms (a textual mutation of the shipping source) ────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(HERE, '..');

type FalseForm = { file: string; label: string; anchor: string; replacement: string; why: string };

/**
 * Loads a shipping module with `form` applied, as a transient copy BESIDE it.
 *
 * Beside it because the module's own imports are relative and must keep resolving, and NAMED with the
 * `__criterion-falsify-` prefix `server/tsconfig.json` excludes by name — a `npm run typecheck`
 * overlapping this suite must never collect a file that is about to be removed. The copy goes as soon as
 * the import resolves. The anchor is asserted to occur exactly once, so a mutation that silently stopped
 * matching is a red here rather than a form that quietly exercises the shipping code twice.
 */
async function loadFalseForm<T>(form: FalseForm): Promise<T> {
  const shipping = path.join(MODULE_DIR, form.file);
  const source = readFileSync(shipping, 'utf8');
  const occurrences = source.split(form.anchor).length - 1;
  assert.equal(occurrences, 1, `the "${form.label}" false form's anchor is not in ${form.file} exactly once`);
  const target = path.join(MODULE_DIR, `__criterion-falsify-${form.label}-${process.pid}.ts`);
  writeFileSync(target, source.replace(form.anchor, form.replacement), 'utf8');
  try {
    return (await import(pathToFileURL(target).href)) as T;
  } finally {
    rmSync(target, { force: true });
  }
}

type ProxyModule = { handleVoiceRealtimeConnection: typeof handleVoiceRealtimeConnection };
type VadModule = { uplinkHeadKeepFrames: typeof uplinkHeadKeepFrames };

/** Wires a connection through the MUTATED proxy, so a false form can be driven at the relay too. */
function wireWith(module: ProxyModule, options: Parameters<typeof wire>[0] = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const rotations: UpstreamPoolRotation[] = [];
  const delivered: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      delivered.push(String(args.message ?? ''));
      return { runId: 'run-1', queued: false };
    },
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => executor,
    instructions: 'test instructions',
    segmentedRelay: false,
    log: (line) => logs.push(line),
    ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
    ...(options.idleRotateMs === undefined
      ? {}
      : { upstreamPool: { idleRotateMs: options.idleRotateMs, onRotate: (r) => rotations.push(r) } }),
    ...(options.silenceTail === undefined ? {} : { silenceTail: options.silenceTail }),
    ...(options.uplinkVad === undefined ? {} : { uplinkVad: options.uplinkVad }),
  };
  module.handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs, rotations, delivered };
}

// ── the source, read for the code-path evidence AC2 asks for ───────────────────────────────────────

const PROXY_SOURCE = readFileSync(path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts'), 'utf8');

// ── the gate, read over a timeline (AC9's four classes) ────────────────────────────────────────────

test('AC9 — the first non-speech segment is dropped whole BUT FOR the pre-roll tail before the onset', async () => {
  // 30 quiet frames lead the stream, then speech, then 3 quiet: the leading 30 are the "first segment
  // before any speech". §5.1 drops them whole — the pre-roll (AC1) then reaches back for the last P of
  // them, because those are exactly the frames the lagging classifier had not called speech yet.
  const frames = build([
    { speech: false, count: 30 },
    { speech: true, count: 4 },
    { speech: false, count: 3 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);

  // Everything of the first segment EXCEPT its pre-roll tail is dropped outright.
  const droppedWhole = frames.slice(0, 30 - PRE_ROLL_FRAMES).map((f) => f.audio);
  assert.deepEqual(
    droppedWhole.filter((audio) => run.wired.includes(audio)),
    [],
    'the first segment is dropped whole, save the P frames the pre-roll reaches back for',
  );
  // From the pre-roll tail on, every frame crosses: the P replayed frames, the speech, and the trailing 3
  // quiet frames (inside `a`), each exactly once, in browser order.
  assert.deepEqual(
    run.wired,
    frames.slice(30 - PRE_ROLL_FRAMES).map((f) => f.audio),
    'the pre-roll tail plus every frame from the first speech frame on',
  );
  assert.equal(run.aFrames, A_DEFAULT, 'a is the resolved default divided by the frame, plus the boundary frame');
  assert.equal(run.preRollFrames, PRE_ROLL_FRAMES, 'P is the shipped 200 ms budget at 20 ms/frame');
});

test('AC9 — a non-speech run keeps its opening `a` frames and drops only what is past them', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: A_DEFAULT + 10 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);

  const speech = frames.slice(0, 5).map((f) => f.audio);
  const quiet = frames.slice(5).map((f) => f.audio);
  assert.deepEqual(run.wired, [...speech, ...quiet.slice(0, A_DEFAULT)], `exactly a=${A_DEFAULT} quiet frames cross`);
  assert.deepEqual(
    quiet.slice(A_DEFAULT).filter((audio) => run.wired.includes(audio)),
    [],
    'no quiet frame past the head window crosses',
  );
});

test('AC9 — a pause SHORTER than `a` is kept whole, and a quiet-but-audible frame is not special-cased', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: A_DEFAULT - 1 },
    { speech: true, count: 5 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);
  assert.deepEqual(
    run.wired,
    frames.map((f) => f.audio),
    'a pause shorter than a is kept whole — every frame, in order, byte for byte',
  );
});

test('AC9 — zero synthesis: every frame on the wire is a browser frame, byte for byte, in browser order', async () => {
  const frames = build([
    { speech: false, count: 6 },
    { speech: true, count: 4 },
    { speech: false, count: 12 },
    { speech: true, count: 3 },
    // Sized off `A_DEFAULT` so the gate genuinely drops a tail and the leg keeps proving something at
    // whichever window the shipped default resolves to (see the file header).
    { speech: false, count: A_DEFAULT + 10 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);

  // Zero synthesis is a property of the bytes, not a promise: every output frame IS an input frame.
  const allowed = new Set(frames.map((f) => f.audio));
  assert.ok(
    run.wired.every((audio) => allowed.has(audio)),
    'the gate put a frame on the wire that no browser frame produced',
  );
  // And the order is the browser's own: indices strictly increase, no reordering, no replay.
  const order = run.wired.map((audio) => frames.find((f) => f.audio === audio)?.index ?? -1);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'the surviving frames must cross in the browser order they arrived',
  );
  assert.ok(run.wired.length < frames.length, 'a gate that forwarded everything did not gate anything');
});

test('AC9 — a LAGGING classifier preserves the order: the gate buffers rather than guesses', async () => {
  const frames = build([
    { speech: false, count: 4 },
    { speech: true, count: 4 },
    { speech: false, count: A_DEFAULT + 6 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(
      frames.map((f) => f.speech),
      { lag: 2 },
    ),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);
  // The leading 4 are the first segment (dropped whole, then replayed by the pre-roll — P ≥ 4, so all of
  // it), then the speech frames and the non-speech run's opening `a`.
  const expected = [
    ...frames.slice(0, 4).map((f) => f.audio),
    ...frames.slice(4, 8).map((f) => f.audio),
    ...frames.slice(8, 8 + A_DEFAULT).map((f) => f.audio),
  ];
  assert.deepEqual(run.wired, expected, 'a two-frame lag must change WHEN frames cross, never WHICH or the order');
});

test('AC9 — an unavailable backend is fail-open: every frame crosses BYPASSED, unjudged', async () => {
  const frames = build([
    { speech: false, count: 20 },
    { speech: true, count: 5 },
  ]);
  const classifier = createUnavailableClassifier();
  const gate = createUplinkVadGate({
    classifier,
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);
  assert.deepEqual(
    run.wired,
    frames.map((f) => f.audio),
    'a classifier that judges nothing must withhold NOTHING — the one direction a VAD must never get wrong',
  );
});

// ── AC1 / AC2 (onset pre-roll): the last P dropped frames are replayed before an onset ─────────────
//
// THE DEFECT THESE PIN. The classifier answers late, so a syllable's first frames come back non-speech
// and §5 drops them; the onset is clipped by however many frames the classifier was behind (the
// 2026-10-14 evening measurement found 80–100 ms). The repair is the pre-roll: on an onset that follows
// dropped frames, the gate replays the last P of them, in order, first. The matrix below is written
// against the WIRE (what crossed, in what order, how many times) and the `preRoll` reading.

/**
 * The pre-roll window the spec ships: 200 ms at 20 ms/frame.
 *
 * A LITERAL, deliberately, so that the false form (AC3 — turning the module's own `P` to 0) cannot move
 * this expectation with it: if the test derived `P` from the module, setting the module to 0 would leave
 * the reading vacuously green. Pinned here, the false form reds exactly as the criterion requires
 * (`uplinkPreRollFrames(UPLINK_VAD_PRE_ROLL_MS)` is asserted to be this literal in the AC9 leg above).
 */
const PRE_ROLL_FRAMES = 10;

test('AC1 — an onset replays the last P dropped frames, byte for byte and in order, and never twice', async () => {
  const frames = build([
    { speech: false, count: 30 },
    { speech: true, count: 5 },
    { speech: false, count: A_DEFAULT + PRE_ROLL_FRAMES + 5 },
    { speech: true, count: 3 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);

  assert.equal(run.preRollFrames, PRE_ROLL_FRAMES, 'the default P is the 200 ms budget at 20 ms/frame');

  // (1) FIRST onset (frame 30): exactly P frames cross BEFORE it, and they are the LAST P the gate
  // dropped (indices 20..29), in the browser's order, byte for byte — nothing synthesized.
  const speechAt = run.wired.indexOf(frames[30]!.audio);
  assert.equal(speechAt, PRE_ROLL_FRAMES, 'exactly P frames cross before the first speech frame');
  assert.deepEqual(
    run.wired.slice(0, PRE_ROLL_FRAMES),
    frames.slice(30 - PRE_ROLL_FRAMES, 30).map((f) => f.audio),
    'and they are the last P dropped frames, in order, byte for byte',
  );

  // (2) SECOND onset: the run tail past `a` is (a+P+5) − a = P+5 frames, so its last P replay too.
  const secondOnset = 30 + 5 + A_DEFAULT + PRE_ROLL_FRAMES + 5;
  const secondAt = run.wired.indexOf(frames[secondOnset]!.audio);
  assert.deepEqual(
    run.wired.slice(secondAt - PRE_ROLL_FRAMES, secondAt),
    frames.slice(secondOnset - PRE_ROLL_FRAMES, secondOnset).map((f) => f.audio),
    'the second onset replays its own last P dropped frames',
  );

  // (3) No frame crossed twice, and the wire is a strictly increasing subsequence of the browser order.
  const seen = new Set<string>();
  for (const audio of run.wired) {
    assert.ok(!seen.has(audio), 'no frame may be replayed twice');
    seen.add(audio);
  }
  const order = wireIndices(run.wired, frames);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the wire keeps the browser order');

  // (4) The cumulative reading: two onsets × P.
  assert.equal(run.stats.preRoll, 2 * PRE_ROLL_FRAMES, 'preRoll counts both onsets');
});

test('AC2 — a gap shorter than `a + P` replays only what was actually dropped, never a head-kept frame', async () => {
  const gap = A_DEFAULT + 4; // > a (so something is dropped) and < a + P (so fewer than P are)
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: gap },
    { speech: true, count: 3 },
  ]);
  const gate = createUplinkVadGate({
    classifier: createFakeClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
  });
  const run = await runGate(gate, frames);

  const droppedTail = gap - A_DEFAULT; // the frames past the head window that this gap really dropped
  assert.ok(droppedTail > 0 && droppedTail < PRE_ROLL_FRAMES, 'the gap must drop a positive number below P');
  const onset = 5 + gap;
  const at = run.wired.indexOf(frames[onset]!.audio);
  assert.deepEqual(
    run.wired.slice(at - droppedTail, at),
    frames.slice(onset - droppedTail, onset).map((f) => f.audio),
    'exactly the frames this gap dropped are replayed, no more',
  );
  assert.equal(run.stats.preRoll, droppedTail, 'preRoll is the dropped count for the one short gap');

  // No duplicates anywhere: a head-kept frame was never buffered, so it can never be replayed.
  const seen = new Set<string>();
  for (const audio of run.wired) {
    assert.ok(!seen.has(audio), 'no frame — head-kept included — may cross twice');
    seen.add(audio);
  }
  const order = wireIndices(run.wired, frames);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'indices strictly increase, no replay out of order');
});

// ── AC8: `a` is derived from the RESOLVED silence window, never hard-coded ────────────────────────

test('AC8 — the head-keep window follows the resolved silence duration', () => {
  assert.equal(
    uplinkHeadKeepFrames(400),
    Math.round((400 + 200) / FRAME_MS) + 1,
    'the shipped window is (silence + the 200 ms tail margin)/frame + the boundary frame',
  );
  assert.equal(
    uplinkHeadKeepFrames(800),
    Math.round((800 + 200) / FRAME_MS) + 1,
    'a deployment that widens the silence window widens `a` by the same amount',
  );
});

// 2026-10-14 real-upstream replay (experiments/voice-realtime-stop-latency): with 420 ms of kept tail the
// upstream closed only 28/37 recorded utterances within 8 s; with 200 ms more of the recorded tail, 36/37.
test('the shipped default keeps 51 frames (1020 ms) of tail, enough for the upstream to close the turn', () => {
  assert.equal(A_DEFAULT, 51, 'the default head-keep window is 51 frames at the shipped 800 ms');
  assert.equal(A_DEFAULT * FRAME_MS, 1_020, 'the kept tail is 1020 ms — the silence window plus the 200 ms margin, and the boundary frame');
});

// AC5 of `gap-live-voice-turn-detection-silence-in-settings-file-default-800`: the window is DERIVED, and
// its two readings are pinned so that anyone who wants to give the tail a knob of its own has to delete
// these lines first (see the rationale on `uplinkHeadKeepFrames`).
test('AC5 — the head-keep window is derived: 400 → 31 frames, 800 → 51, off the same 200 ms margin and boundary frame', () => {
  assert.equal(uplinkHeadKeepFrames(400), 31, 'the window the gate shipped with: (400 + 200)/20 + 1');
  assert.equal(uplinkHeadKeepFrames(800), 51, 'the shipped window today: (800 + 200)/20 + 1');
  assert.equal(uplinkHeadKeepFrames(800) - uplinkHeadKeepFrames(400), 20, 'the 400 ms of extra silence is 20 frames of kept tail');
  assert.equal(A_DEFAULT, uplinkHeadKeepFrames(DEFAULT_TURN_DETECTION.silence_duration_ms), 'and the shipped default resolves to that same window');
});

test('AC8 — the connection logs the window it DERIVED from the environment, not a literal', async () => {
  const previous = process.env.VOICE_REALTIME_TURN_DETECTION_SILENCE_MS;
  process.env.VOICE_REALTIME_TURN_DETECTION_SILENCE_MS = '800';
  try {
    const frames = build([{ speech: true, count: 2 }]);
    const wired = wire({ uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)) } });
    await waitFor(() => opened(wired.socket));

    const line = wired.logs.find((entry) => entry.startsWith('uplink_vad:'));
    assert.ok(line !== undefined, `the connection must log its uplink VAD state, saw ${JSON.stringify(wired.logs)}`);
    assert.match(line, /silenceMs=800/, 'the resolved window must be the 800 the environment asked for');
    assert.match(
      line,
      new RegExp(`aFrames=${uplinkHeadKeepFrames(800)}`),
      'a must follow the resolved window (51 frames at 800 ms), not the shipped 400',
    );
  } finally {
    if (previous === undefined) {
      delete process.env.VOICE_REALTIME_TURN_DETECTION_SILENCE_MS;
    } else {
      process.env.VOICE_REALTIME_TURN_DETECTION_SILENCE_MS = previous;
    }
  }
});

test('AC8 false form — writing the 400 literal makes `a` stop following the resolved window, so the reading goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-uplink-vad-gate.ts',
    label: 'hardcoded-400',
    anchor: '  return Math.round((silenceDurationMs + UPLINK_VAD_TAIL_MARGIN_MS) / frameMs) + UPLINK_VAD_HEAD_BOUNDARY_FRAMES;',
    replacement: '  return Math.round((400 + UPLINK_VAD_TAIL_MARGIN_MS) / frameMs) + UPLINK_VAD_HEAD_BOUNDARY_FRAMES;',
    why: 'the head window is hard-coded to the shipped 400 instead of following the resolved silence window',
  };
  const mutated = await loadFalseForm<VadModule>(form);
  assert.equal(
    mutated.uplinkHeadKeepFrames(800),
    uplinkHeadKeepFrames(400),
    `under "${form.why}" the 800ms deployment keeps the 400ms window — the AC8 reading above must go red`,
  );
  assert.notEqual(mutated.uplinkHeadKeepFrames(800), uplinkHeadKeepFrames(800), 'the false form is not the shipping code');
});

// ── AC1 / AC2: default OFF, the identity relay, and no gate built ─────────────────────────────────

test('AC1 — with the switch off the continuous wire is the identity relay it was before this seam existed', async () => {
  const wired = wire();
  await waitFor(() => opened(wired.socket));

  const frames = build([
    { speech: false, count: 40 },
    { speech: true, count: 20 },
    { speech: false, count: 60 },
  ]);
  await feed(wired, frames);
  await settle();

  // Byte for byte, in order: nothing withheld, nothing replayed, nothing substituted. This IS the
  // "before" reading — the same frames the browser sent, which is what the relay put on the wire before
  // the seam existed, because the gate-off path is the same call it always was.
  assert.deepEqual(
    appends(wired),
    frames.map((frame) => frame.audio),
    'an uplink-VAD-off connection must relay the browser frames byte for byte, in order',
  );
  assert.equal(
    wired.logs.filter((line) => line.startsWith('uplink_vad:')).length,
    0,
    'a gate-off connection must not report a gate it never built',
  );
});

test('AC2 — with the switch off NO gate is built and NO classifier is consulted (the `=== null` fast path)', () => {
  // The code-path evidence: the fast path is keyed on BOTH gates being null, so a connection with no
  // seam never reaches the gate construction or the per-frame enqueue. Exactly one such line exists.
  const fastPath = 'if (silenceTail === null && uplinkVad === null) {';
  assert.equal(PROXY_SOURCE.split(fastPath).length - 1, 1, 'the gate-neutral fast path must exist exactly once');
  assert.match(
    PROXY_SOURCE,
    /const uplinkVadRequested = seams\.uplinkVad !== undefined && !segmentedRelay;/,
    'the gate is built only from a PRESENT seam — absent means no gate',
  );
  assert.match(
    PROXY_SOURCE,
    /uplinkVad = createUplinkVadGate\(\{/,
    'the only construction of a gate is inside the seam-present branch',
  );

  // The relay reading that backs it: a gate-off connection logs no uplink-vad state (AC1) and, being the
  // identity relay, has nothing to consult a classifier about — there is no classifier on the seam.
});

test('AC1 false form — a default connection that stops relaying byte-for-byte goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'fast-path-withholds',
    anchor: [
      '        if (silenceTail === null && uplinkVad === null) {',
      '          bridge.sendAudioFrame(frame.audio);',
      '          return;',
      '        }',
    ].join('\n'),
    replacement: ['        if (silenceTail === null && uplinkVad === null) {', '          return;', '        }'].join('\n'),
    why: 'the gate-neutral fast path stops forwarding, so the DEFAULT connection is no longer the identity relay',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);
  const wired = wireWith(mutated);
  await waitFor(() => opened(wired.socket));

  const frames = build([{ speech: true, count: 12 }]);
  await feed(wired, frames);
  await settle();

  assert.notDeepEqual(
    appends(wired),
    frames.map((frame) => frame.audio),
    `under "${form.why}" the byte-identity reading above must go RED`,
  );
});

// ── AC4: `noteLocalActivity` on every browser frame, forwarded or not ─────────────────────────────

test('AC4 — a stretch the VAD drops still holds the pool’s activity clock (no rotation)', async () => {
  // The pool rotates after `idleRotateMs` with no activity. The classifier here judges EVERY frame
  // non-speech, so the VAD withholds all of them — the browser streams, the wire stays silent. If the
  // activity clock were driven by what crossed the wire, this stretch would read as idle and rotate.
  const idleRotateMs = 300;
  const frames = build([{ speech: false, count: 120 }]);
  const wired = wire({
    uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)) },
    idleRotateMs,
  });
  await waitFor(() => opened(wired.socket));

  // Feed SLOWER than the rotation threshold, so a clock that was not held would fire mid-feed.
  await feed(wired, frames, 20, Math.ceil(idleRotateMs / 6));

  assert.equal(appends(wired).length, 0, 'every frame is non-speech before any speech: the wire must be silent');
  assert.equal(
    wired.rotations.length,
    0,
    'a VAD-dropped stretch must not be read as an idle connection — noteLocalActivity is on every frame',
  );

  // Non-vacuity: THIS pool does rotate once the connection is genuinely idle.
  await waitFor(() => wired.rotations.length >= 1, 4_000);
});

test('AC4 false form — dropping the per-frame activity call makes the same stretch rotate the pool, so the reading goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'no-activity-clock',
    anchor: '        bridge.noteLocalActivity?.();',
    replacement: '        void 0;',
    why: 'the per-frame activity clock is not fed, so a VAD-dropped stretch reads as an idle connection',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);
  const idleRotateMs = 300;
  const frames = build([{ speech: false, count: 120 }]);
  const wired = wireWith(mutated, {
    uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)) },
    idleRotateMs,
  });
  await waitFor(() => opened(wired.socket));
  await feed(wired, frames, 20, Math.ceil(idleRotateMs / 6));

  assert.ok(
    wired.rotations.length >= 1,
    `under "${form.why}" the pool must rotate mid-feed, so the zero above can only be a held clock`,
  );
});

// ── AC3: the local speech gate is fed on ARRIVAL, unconditionally ─────────────────────────────────

/**
 * A corpus whose utterance can only CLOSE on a frame the VAD withholds.
 *
 * The window is PINNED here rather than taken from the shipped default, and the reason is the whole point
 * of the leg: the local gate closes after 25 consecutive quiet frames, so `a` must be BELOW 25 for the
 * frame that closes the utterance to be one the VAD drops. `a` is `(silence + 200 ms margin)/20 + 1`, so
 * that needs a silence window under 280 ms — neither the 400 ms the gate once shipped (a = 31) nor the
 * 800 ms it ships now (a = 51) qualifies. (The module header's long-standing `a = 21` was this same
 * intent written against a window the leg never actually drove.) The property under test — the local gate
 * is fed on ARRIVAL, unconditionally — belongs to the proxy's WIRING and must hold at every window, so
 * the leg pins the smallest legal one and asserts that its `a` really is below 25.
 */
const AC3_SILENCE_MS = 200;
/** The head-keep window this leg's pinned window resolves to (`(200 + 200)/20 + 1 = 21`), and it is < 25. */
const AC3_A = uplinkHeadKeepFrames(AC3_SILENCE_MS);
const AC3_CORPUS = build([
  { speech: false, count: 10 },
  { speech: true, count: 5 },
  { speech: false, count: 40 },
]);

test('AC3 — a frame the VAD drops still closes the local utterance (the watchdog is armed by withheld audio)', async () => {
  const wired = wire({
    uplinkVad: { classifier: createFakeClassifier(AC3_CORPUS.map((f) => f.speech)), silenceDurationMs: AC3_SILENCE_MS },
    stallMs: 120,
  });
  await waitFor(() => opened(wired.socket));
  await feed(wired, AC3_CORPUS, 10);
  await waitFor(() => turnUnanswered(wired) >= 1, 2_000);

  // The reading is non-vacuous: the frames the local gate needed to reach its 25-frame closing run are
  // past `a`, so the VAD withheld them — yet the boundary fired, because the gate was fed on arrival.
  assert.ok(AC3_A < 25, `this leg only proves anything while a (${AC3_A}) is below the local gate's 25-frame closing run`);
  const withheld = AC3_CORPUS.slice(10 + 5 + AC3_A).map((f) => f.audio);
  assert.ok(withheld.length > 0, 'this corpus must include frames past the head window, or the leg proves nothing');
  assert.ok(
    withheld.every((audio) => !appends(wired).includes(audio)),
    'the frames that closed the local utterance must be exactly the ones the VAD withheld',
  );
});

test('AC3 — the same corpus with the gate OFF produces the same watchdog reading (the control)', async () => {
  const wired = wire({ stallMs: 120 });
  await waitFor(() => opened(wired.socket));
  await feed(wired, AC3_CORPUS, 10);
  await waitFor(() => turnUnanswered(wired) >= 1, 2_000);
  assert.ok(
    appends(wired).length >= AC3_CORPUS.length,
    'with the gate off the whole corpus crosses — the control is the identity relay',
  );
});

test('AC3 false form — feeding the local gate only on the gate-neutral fast path loses the boundary, so the reading goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'local-gate-only-when-forwarded',
    anchor: '        reportLocalSpeechBoundary(localSpeechGate.observe(frame.audio));',
    replacement: [
      '        if (silenceTail === null && uplinkVad === null) {',
      '          reportLocalSpeechBoundary(localSpeechGate.observe(frame.audio));',
      '        }',
    ].join('\n'),
    why: 'the local speech gate is fed only on the no-gate fast path, so a withheld frame never reaches it',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);
  const wired = wireWith(mutated, {
    uplinkVad: { classifier: createFakeClassifier(AC3_CORPUS.map((f) => f.speech)), silenceDurationMs: AC3_SILENCE_MS },
    stallMs: 120,
  });
  await waitFor(() => opened(wired.socket));
  await feed(wired, AC3_CORPUS, 10);
  // Give any watchdog that COULD have been armed the same budget the positive leg waited.
  await settle(250);

  assert.equal(
    turnUnanswered(wired),
    0,
    `under "${form.why}" the local utterance never closes, so the watchdog above must go RED`,
  );
});

// ── AC5: only append frames change — the normal-flow frame-type set is unchanged ──────────────────

test('AC5 — the frame types the relay sends are unchanged, and no decision frame is introduced', async () => {
  const frames = build([
    { speech: false, count: 30 },
    { speech: true, count: 20 },
    { speech: false, count: 30 },
    { speech: true, count: 10 },
    { speech: false, count: 50 },
  ]);

  const off = wire();
  await waitFor(() => opened(off.socket));
  await feed(off, frames);
  await settle();

  const on = wire({ uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)) } });
  await waitFor(() => opened(on.socket));
  await feed(on, frames);
  await settle();

  const offTypes = new Set(sentTypes(off));
  const onTypes = new Set(sentTypes(on));
  assert.deepEqual(
    [...onTypes].sort(),
    [...offTypes].sort(),
    `the VAD must introduce NO frame type: off=${JSON.stringify([...offTypes])} on=${JSON.stringify([...onTypes])}`,
  );
  for (const forbidden of ['response.create', 'input_audio_buffer.commit']) {
    assert.ok(!onTypes.has(forbidden), `the normal flow must never send ${forbidden} (it is the exit path's, alone)`);
  }
  // Non-vacuity: the VAD-on run withheld frames, so the equal type SETS are a reading, not two identical runs.
  assert.ok(appends(on).length < appends(off).length, 'the VAD-on run must have put fewer appends on the wire');
});

// ── AC6: the STS relationship is decided, not undefined ───────────────────────────────────────────

test('AC6 — with BOTH uplink gates enabled the incumbent STS wins, and the refusal is said out loud', async () => {
  const frames = build([
    { speech: false, count: 30 },
    { speech: true, count: 20 },
    { speech: false, count: 200 },
  ]);
  const classifier = createFakeClassifier(frames.map((f) => f.speech));
  const wired = wire({
    uplinkVad: { classifier },
    // STS at its shipping tail/preroll, keepalive off — the same shape the sibling STS suite uses.
    silenceTail: { tailMs: 200, prerollMs: 100, keepaliveMs: 0 },
  });
  await waitFor(() => opened(wired.socket));
  await feed(wired, frames, 50);
  await settle();

  assert.ok(
    wired.logs.some((line) => line.startsWith('uplink_vad refused:')),
    `the connection must say which gate ran, saw ${JSON.stringify(wired.logs)}`,
  );
  assert.equal(classifier.fed.length, 0, 'the refused uplink VAD must never consult its classifier — the STS gate is the one running');
  assert.ok(
    wired.logs.some((line) => line.startsWith('silence_tail event=')),
    'the incumbent STS gate is the one that actually ran',
  );
});

// ── AC7: the exit path — user action triggers commit → response.create → bounded wait → close ──────

test('AC7 — a user exit sends commit then response.create, in order, before the socket closes', async () => {
  const frames = build([
    { speech: false, count: 10 },
    { speech: true, count: 20 },
  ]);
  const wired = wire({
    uplinkVad: {
      classifier: createFakeClassifier(frames.map((f) => f.speech)),
      exitWaitMs: 20,
    },
    stallMs: 10_000,
  });
  await waitFor(() => opened(wired.socket));
  await feed(wired, frames);
  await settle();

  // The browser's own exit: the close FRAME, then the socket close (see `useVoiceRealtimeSession.ts`).
  wired.socket.receive({ type: 'close' });
  wired.socket.close();
  await waitFor(() => (wired.transports[0]?.sent ?? []).some((m) => m.type === 'response.create'), 2_000);
  await settle();

  const types = sentTypes(wired);
  // The observed EXIT steps, read off the wire. Filtered to the steps §6.3 names, so the session's own
  // `session.update` (on connect) and the audio appends are not mistaken for exit steps.
  const observed = types.filter((type) => (UPLINK_VAD_EXIT_STEPS as readonly string[]).includes(type));
  assert.ok(
    uplinkVadExitIsWellFormed(observed),
    `the exit steps must be in §6.3's order, saw ${JSON.stringify(observed)}`,
  );
  assert.ok(
    uplinkVadExitHasCommitAndResponse([...observed, 'socket-close']),
    `the exit must be commit → response.create → close, saw ${JSON.stringify(observed)}`,
  );
  // In the wire's own order, and with NOTHING between them.
  const commitAt = types.indexOf('input_audio_buffer.commit');
  const responseAt = types.indexOf('response.create');
  assert.ok(commitAt !== -1, 'the user exit must send the commit');
  assert.equal(responseAt, commitAt + 1, 'response.create must follow the commit immediately');
  assert.equal(
    types.slice(responseAt + 1).length,
    0,
    'nothing may cross the wire after response.create on the exit path',
  );

  // And the connection closed the socket, so the bounded wait did not strand it.
  await waitFor(() => wired.socket.readyState === WS.CLOSED, 2_000);
});

test('AC7 — the exit steps are the ones §6.3 names, and the false form (a bare close) fails the predicate', () => {
  assert.deepEqual([...UPLINK_VAD_EXIT_STEPS], [
    'input_audio_buffer.commit',
    'response.create',
    'bounded-wait',
    'socket-close',
  ]);
  // The false form: closing without the commit pair must read as NOT the well-formed exit.
  assert.equal(uplinkVadExitHasCommitAndResponse(['socket-close']), false, 'a bare close is not the exit');
  assert.equal(
    uplinkVadExitHasCommitAndResponse(['response.create', 'input_audio_buffer.commit', 'socket-close']),
    false,
    'the pair in the wrong order is not the exit',
  );
  assert.equal(
    uplinkVadExitIsWellFormed(['socket-close', 'response.create']),
    false,
    'a step after the close is out of order',
  );
});

test('AC7 false form — a close frame that tears down directly skips the commit pair, so the wire order goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'exit-no-commit-pair',
    anchor: '    void exitUplinkVad();',
    replacement: '    teardown();',
    why: 'the close frame tears the connection down directly, dropping the commit + response.create pair',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);
  const frames = build([
    { speech: false, count: 10 },
    { speech: true, count: 20 },
  ]);
  const wired = wireWith(mutated, {
    uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)), exitWaitMs: 20 },
    stallMs: 10_000,
  });
  await waitFor(() => opened(wired.socket));
  await feed(wired, frames);
  await settle();

  wired.socket.receive({ type: 'close' });
  wired.socket.close();
  await settle(200);

  const types = sentTypes(wired);
  assert.ok(
    !types.includes('input_audio_buffer.commit') && !types.includes('response.create'),
    `under "${form.why}" neither the commit nor response.create may reach the wire`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// THE VERIFICATION TASK — `gap-voice-uplink-vad-real-ab-and-e2e-verification`
//
// The legs above are the SEAM task's AC1–AC9. The three below re-read the same seam as the
// VERIFICATION task's own AC2 (reconnect across `idleRotateMs`), AC3 (long silence) and AC6 (default
// byte-identity, before/after). They are labelled `VERIFY ACn` so a reader never confuses them with the
// seam task's AC2 (`=== null` fast path) or AC6 (STS refusal).
//
// WHAT THE REAL-UPSTREAM LEGS OWN, AND WHAT STAYS HERE. The task's AC1/AC3/AC4/AC7 readings come from
// a real DashScope connection (`experiments/voice-realtime-vad-three-arm/probe.mts --vad-filtered`) and
// AC5 from the Playwright spec; those cannot be driven from a unit test. What CAN be pinned
// deterministically — and what the fan-in's `extra.acceptance` actually runs — is the two couplings a
// fake upstream can hold exactly: the pool's activity clock (AC2) and the pre-seam byte-identity (AC6).
// The AC3 leg here is deliberately the RELAY-side invariant only (30 s of audio-time suppression with
// no close); the endpoint's own ~304 s no-receive bound is a property of the real upstream and is read
// from the probe, never claimed here.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const PROXY_REL = 'server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts';

/**
 * The proxy revision as it was BEFORE the seam existed — `git show <rev>:<file>` for the commit just
 * before `uplinkVad` first appears in the file's history.
 *
 * DERIVED rather than hard-coded: `git log --reverse -S uplinkVad` returns every commit whose diff
 * changed the occurrence count of `uplinkVad` in this file, oldest first, and the oldest is the wiring
 * commit (`c9faefddb`); its parent is the last state with no seam. Deriving it keeps the criterion from
 * pinning a SHA that a rebase would move, and the `!includes('uplinkVad')` guard below fails loud if
 * the derivation ever lands on a revision that does have the seam.
 */
function preSeamRevision(): string {
  const oldest = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'log', '--format=%H', '--reverse', '-S', 'uplinkVad', '--', PROXY_REL],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')[0];
  if (!oldest) {
    throw new Error(`no commit in ${PROXY_REL}'s history introduced \`uplinkVad\``);
  }
  return `${oldest}~1`;
}

/**
 * Loads the PRE-SEAM proxy the way {@link loadFalseForm} loads a mutated one — a copy beside the
 * module (so its relative imports still resolve), named with the `__criterion-falsify-` prefix the
 * server tsconfig excludes by name, removed once the import resolves.
 *
 * The copy runs against TODAY's sibling modules. That is the correct对照 for AC6: the question is
 * whether the AUDIO the relay puts on the wire changed, and the only file that decides that is the
 * proxy. A sibling module that moved a control frame since would show up as a `sentTypes` difference a
 * leg does not assert on — AC6 is read off the appended AUDIO, byte for byte.
 */
async function loadPreSeamProxy(): Promise<ProxyModule> {
  const rev = preSeamRevision();
  const source = execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:${PROXY_REL}`], { encoding: 'utf8' });
  assert.ok(
    !source.includes('uplinkVad'),
    `the derived pre-seam revision ${rev} must not mention \`uplinkVad\` (the derivation is stale)`,
  );
  const target = path.join(MODULE_DIR, `__criterion-falsify-preseam-${process.pid}.ts`);
  writeFileSync(target, source, 'utf8');
  try {
    return (await import(pathToFileURL(target).href)) as ProxyModule;
  } finally {
    rmSync(target, { force: true });
  }
}

// ── the forced-commit recovery (2026-10-17): a `committed` with no `speech_stopped` ───────────────
//
// LIVE DEFECT. The gate's hold-open cap force-commits a turn the endpoint left open. The endpoint then
// answers `committed` (+ transcription) but never `speech_stopped`: its server_vad only fires on a
// speech→silence transition inside ONE uncommitted buffer, and the commit froze the buffer — so no
// response is opened and the sentence waits for the next utterance (measured 22.5 s / 49.6 s late,
// `experiments/livevoice-discussion-transcripts-20261017/DROPPED-INPUT-AUDIT-2026-10-17.md`).
//
// The recovery is state-driven (no timer): the relay records where its turn-close count stood when it
// sent the forced commit, and a `committed` that is the ONLY close since then proves no
// `speech_stopped` preceded it. These legs pin the three shapes the experiment verified — no close,
// fast close, and same-batch close — plus the segmented scoping and the false form.

/** The hold-open cap in frames — the corpus that makes the RELAY send the forced commit. */
const HOLD_CAP_FRAMES = Math.round(UPLINK_VAD_HOLD_OPEN_MAX_MS / UPLINK_VAD_FRAME_MS);
/** The sentence the model relays once the recovery response has been asked for. */
const RECOVERED_SENTENCE = '明天下午三点提醒我开会。';

const countSent = (wired: Wired, type: string): number =>
  (wired.transports[0]?.sent ?? []).filter((message) => message.type === type).length;

/**
 * Drives one continuous-uplink-VAD connection to the relay's OWN forced commit.
 *
 * There is no seam that says "send the commit now" — and there must not be one: the cap is the
 * production door this defect travels through. Speech, then enough quiet to cross the cap, makes the
 * gate request the close; the returned transport is the upstream the relay wrote it to.
 */
async function forcedCommitConnection(options: { segmentedRelay?: boolean } = {}): Promise<{
  wired: Wired;
  upstream: FakeTransport;
}> {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: HOLD_CAP_FRAMES + 40 },
  ]);
  const wired = wire({
    uplinkVad: { classifier: createFakeClassifier(frames.map((frame) => frame.speech)) },
    ...(options.segmentedRelay === undefined ? {} : { segmentedRelay: options.segmentedRelay }),
  });
  await waitFor(() => opened(wired.socket));
  const upstream = wired.transports[0]!;
  upstream.peerSend({ type: 'input_audio_buffer.speech_started' });
  for (const frame of frames) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }
  await settle();
  return { wired, upstream };
}

test('AC1 — a forced commit answered with no speech_stopped asks for exactly one response, and the sentence follows', async () => {
  const { wired, upstream } = await forcedCommitConnection();
  assert.equal(countSent(wired, 'input_audio_buffer.commit'), 1, 'the relay itself committed the held turn');

  upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_forced' });
  await settle();

  assert.equal(
    countSent(wired, 'response.create'),
    1,
    'exactly one response.create — the recovery, not a pair and not a duplicate',
  );
  assert.ok(
    wired.logs.some((line) => /forced commit answered with no speech_stopped/.test(line)),
    'the recovery is recorded in the journal',
  );

  // What the endpoint then does with the response it was asked for: the model relays the sentence.
  upstream.peerSend({
    type: 'function_call',
    callId: 'call-recovered',
    name: 'session_send',
    arguments: JSON.stringify({ message: RECOVERED_SENTENCE }),
  });
  await waitFor(() => wired.delivered.length === 1);
  assert.deepEqual(wired.delivered, [RECOVERED_SENTENCE], 'the recovered response relays the whole sentence');
});

test('AC2 — a speech_stopped before the committed leaves the answer to the endpoint (zero response.create)', async () => {
  const { wired, upstream } = await forcedCommitConnection();
  upstream.peerSend({ type: 'input_audio_buffer.speech_stopped' });
  await settle();
  upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_closed' });
  await settle();

  assert.equal(
    countSent(wired, 'response.create'),
    0,
    'the endpoint closed the turn itself, so its server_vad answers — the relay must not send a second response',
  );
});

test('AC3 — a speech_stopped in the same batch, 1 ms before the committed, also sends nothing', async () => {
  const { wired, upstream } = await forcedCommitConnection();
  upstream.peerSend({ type: 'input_audio_buffer.speech_stopped' });
  await new Promise((resolve) => setTimeout(resolve, 1));
  upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_closed' });
  await settle();

  assert.equal(
    countSent(wired, 'response.create'),
    0,
    'a same-batch close is still a close: the close count is two, not one',
  );
});

test('AC4 — a segmented connection never engages the recovery, the same scenario included', async () => {
  const { wired, upstream } = await forcedCommitConnection({ segmentedRelay: true });
  assert.equal(
    countSent(wired, 'input_audio_buffer.commit'),
    0,
    'segmented connections build no uplink-VAD gate, so no forced commit exists to answer',
  );

  upstream.peerSend({ type: 'input_audio_buffer.speech_started' });
  upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_segmented' });
  await settle();
  assert.equal(
    countSent(wired, 'response.create'),
    0,
    'the criterion is scoped to `!segmentedRelay`; the segmented wire is answered by its own protocol',
  );
});

test('AC5 — short-circuiting the criterion makes AC1`s "exactly one" reading red, and the false form leaves the tree clean', async () => {
  // The false form is the criterion itself, short-circuited: the rest of the proxy is untouched, so the
  // ONLY difference the leg reads is the missing recovery. The same forced-commit fixture as AC1 is
  // driven through the mutated module; `0` is exactly what AC1`s `1` asserts.
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'forced-commit-recovery-short-circuit',
    anchor:
      '        if (!segmentedRelay && forcedCommit !== null && upstreamTurnCloseCount === forcedCommit + 1) {',
    replacement:
      '        if (false && !segmentedRelay && forcedCommit !== null && upstreamTurnCloseCount === forcedCommit + 1) {',
    why: 'the recovery is short-circuited, so a forced commit answered with no speech_stopped draws no response',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);

  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: HOLD_CAP_FRAMES + 40 },
  ]);
  const wired = wireWith(mutated, {
    uplinkVad: { classifier: createFakeClassifier(frames.map((frame) => frame.speech)) },
  });
  await waitFor(() => opened(wired.socket));
  const upstream = wired.transports[0]!;
  upstream.peerSend({ type: 'input_audio_buffer.speech_started' });
  for (const frame of frames) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }
  await settle();
  assert.equal(
    wired.transports[0]!.sent.filter((message) => message.type === 'input_audio_buffer.commit').length,
    1,
    'the forced commit still happens — only the recovery is removed',
  );

  upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_forced' });
  await settle();
  assert.equal(
    wired.transports[0]!.sent.filter((message) => message.type === 'response.create').length,
    0,
    'without the criterion AC1`s "exactly one" reading is red',
  );

  // The transient copy is removed by `loadFalseForm`'s own `finally`. The reading is taken from disk
  // rather than assumed: no `__criterion-falsify-` module may remain beside the shipping source.
  const status = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'server/modules/voice-realtime'], {
    encoding: 'utf8',
  });
  assert.equal(status.includes('__criterion-falsify'), false, 'the false form was restored — no transient module remains');
});

// ── VERIFY AC2: the reconnect leg — a filtered stretch crossing `idleRotateMs` ─────────────────────

test('VERIFY AC2 — a filtered stretch crossing two idle windows keeps the pool on session 1 (zero rotations)', async () => {
  // AC2's two readings are the ROTATION COUNT and the `noteLocalActivity` COUNT. `noteLocalActivity`
  // has no counter seam (see the file header, and the proxy's own comment "its count is the BROWSER's
  // frame count, never the forwarded one (AC4)"), so its count is the browser frame count by
  // construction and the MEASURABLE consequence of that count being every frame is the pool's rotation
  // ledger. This leg reads both: it states the frame count and proves the ledger stayed empty.
  const idleRotateMs = 300;
  // ONE speech frame first, so `seenSpeech` is true and the head-keep rule — not the first-segment drop
  // — is what withholds the non-speech run's tail. The run then crosses two idle windows on its own.
  const frames = build([
    { speech: true, count: 1 },
    { speech: false, count: 240 },
  ]);
  const wired = wire({
    uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)) },
    idleRotateMs,
  });
  await waitFor(() => opened(wired.socket));

  // Feed SLOWER than the rotation threshold and long enough to cross it twice, so a clock driven by
  // what crossed the wire (a kept frame is ~1 per 12 fed here) would have rotated more than once.
  const chunk = 10;
  const betweenMs = 60;
  await feed(wired, frames, chunk, betweenMs);
  const feedSpanMs = Math.floor(frames.length / chunk) * betweenMs;
  assert.ok(
    feedSpanMs > 2 * idleRotateMs,
    `the feed must cross two idle windows for the reading to mean anything; span=${feedSpanMs}ms, idleRotateMs=${idleRotateMs}`,
  );

  // The readings.
  const kept = appends(wired).length;
  assert.equal(kept, 1 + A_DEFAULT, 'exactly the one speech frame + the non-speech run’s opening `a` frames cross');
  assert.ok(
    frames.length > kept,
    `the noteLocalActivity count is the BROWSER frame count (${frames.length}), never the forwarded one (${kept})`,
  );
  assert.equal(
    wired.rotations.length,
    0,
    `noteLocalActivity covered all ${frames.length} browser frames across ${feedSpanMs}ms (>2×${idleRotateMs}ms), so the pool must not rotate`,
  );
  assert.equal(wired.socket.readyState, WS.OPEN, 'the connection survives the whole filtered stretch');

  // Non-vacuity: THIS pool does rotate once the browser genuinely stops (the AC4 false form proves the
  // zero above is the held clock, not a pool that never rotates — `AC4 false form — dropping the
  // per-frame activity call`).
  await waitFor(() => wired.rotations.length >= 1, 4_000);
});

// ── VERIFY AC3: the long-silence leg — the RELAY-side invariant ───────────────────────────────────

test('VERIFY AC3 — 30 s of continuous non-speech crosses the relay with nothing sent and no close', async () => {
  // 1500 × 20 ms = 30.0 s of AUDIO time. The fake upstream has no no-receive timer, so this leg pins
  // the RELAY's half of AC3 — that suppression never closes its own connection and never synthesizes a
  // frame to keep it — not the endpoint's ~304 s bound (that is the probe's reading, AC3's Evidence).
  const frames = build([{ speech: false, count: 1_500 }]);
  assert.equal(frames.length * FRAME_MS, 30_000, 'the corpus must be exactly 30.0 s of audio');
  const wired = wire({ uplinkVad: { classifier: createFakeClassifier(frames.map((f) => f.speech)) } });
  await waitFor(() => opened(wired.socket));

  await feed(wired, frames, 50);
  await settle();

  assert.equal(
    appends(wired).length,
    0,
    'the first non-speech segment is dropped whole: 30 s of non-speech puts NOTHING on the wire',
  );
  assert.equal(wired.socket.readyState, WS.OPEN, 'the relay must not close on a 30 s silence');
  assert.equal(
    wired.socket.outbound.filter((frame) => frame.type === 'error').length,
    0,
    'no error frame is synthesized to keep the connection',
  );
});

// ── VERIFY AC6: default byte-identity, before/after ───────────────────────────────────────────────

test('VERIFY AC6 — default off, the same frame string crosses byte-for-byte, unchanged since before the seam', async () => {
  const frames = build([
    { speech: false, count: 20 },
    { speech: true, count: 15 },
    { speech: false, count: 30 },
  ]);
  const expected = frames.map((f) => f.audio);

  // AFTER: the shipping proxy, wired the way a deployment that named no gate is wired (no `uplinkVad`).
  const after = wire({});
  await waitFor(() => opened(after.socket));
  await feed(after, frames);
  await settle();

  // BEFORE: the proxy as it was before the seam existed, over the SAME corpus and the SAME seams.
  const before = wireWith(await loadPreSeamProxy(), {});
  await waitFor(() => opened(before.socket));
  await feed(before, frames);
  await settle();

  assert.deepEqual(appends(after), expected, 'default off is the identity relay: every frame, in order, byte for byte');
  // The before/after对照 AC6 asks for: the identical frame string, through the pre-seam proxy and
  // through today's default-off proxy, produces the identical appended bytes in the identical order.
  assert.deepEqual(appends(after), appends(before), 'the default wire must be byte-identical to the pre-seam wire');
  assert.deepEqual(appends(before), expected, 'and the pre-seam wire is itself the identity relay');
});
