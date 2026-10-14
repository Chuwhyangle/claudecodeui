/**
 * The uplink VAD's PRODUCTION ARM POINT — the environment switch, the connection-level state machine, the
 * fail-safe bypass, the metering line and the model's lifecycle, read end to end.
 *
 * WHAT THIS FILE PINS, and why it is not the seam suite (`voice-realtime-uplink-vad-seam.test.ts`). That
 * suite proves the GATE works and that a connection with no seam is the byte-identical relay. This one
 * proves the thing that suite deliberately left out: that there is a real, ENVIRONMENT-DRIVEN path from
 * `server/index.ts` to that gate, that the classifier it hands over carries a five-state connection
 * machine, that a backend failure fails OPEN (forward, never drop), that one line summarizes what the
 * connection sent and withheld, and that the model session is released exactly once on every exit path.
 *
 * THE STATE MACHINE IS DRIVEN THROUGH ITS TEST SEAM. `createUplinkVadArmPoint` takes a `createClassifier`
 * so these legs can reach `loading`, `ready`, `bypassed` and `failed` deterministically — no model, no
 * weights, no `node-gyp` package. The classifies it wraps are the same inner shape a backend has, so the
 * rebasing the arm point does (its verdict indices are its OWN frame count, not the backend's) is
 * exercised for real. AC9 is the one leg that uses the REAL WebRTC backend, because the point there is
 * that a real one reaches `ready` and judges frames — the reading the isolation probe recorded.
 *
 * Consumers: the quay worker's AC state for `gap-live-voice-uplink-vad-production-arm-point`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  UPLINK_VAD_FRAME_BYTES,
  readUplinkVadBackend,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from '../voice-realtime-uplink-vad.js';
import {
  UPLINK_VAD_OFF,
  VOICE_REALTIME_UPLINK_VAD_ENV,
  VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH_ENV,
  createUplinkVadArmPoint,
  describeUplinkVad,
  markUplinkVadFailed,
  readUplinkVadArmPoint,
  readUplinkVadState,
  resolveUplinkVad,
  type UplinkVadArmPoint,
} from '../voice-realtime-uplink-vad-arm-point.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { DEFAULT_TURN_DETECTION, resolveTurnDetection } from '../voice-realtime-turn-detection.js';
import { resolveVoiceRealtimeMode } from '../voice-realtime-mode.js';
import { SILENCE_TAIL_ENV, resolveSilenceTail } from '../voice-realtime-silence-tail.js';
import type { RealtimeToolExecutor, UpstreamPoolRotation } from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── the corpus ────────────────────────────────────────────────────────────────────────────────────

/** Room tone: silent to any VAD, and above digital silence so it is real (unreadable) audio. */
const SILENCE_RMS = 12;
/** Speech for the SCRIPTED inner classifiers: their verdicts come from the pattern, not the level. */
const SPEECH_RMS = 500;
/** Speech for the REAL WebRTC backend (AC9): a fast square wave it actually reads as speech. */
const REAL_SPEECH_RMS = 8_000;

/** One PCM16 square wave of exactly one grid frame, with `index` written into its head. */
function pcmFrame(amplitude: number, index: number): string {
  const samples = UPLINK_VAD_FRAME_BYTES / 2;
  const pcm = Buffer.alloc(UPLINK_VAD_FRAME_BYTES);
  for (let sample = 0; sample < samples; sample += 1) {
    pcm.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  // A four-sample marker makes every frame's payload unique, so a leg can ask whether THE frame that was
  // spoken crossed the wire, not whether some frame of the right length did.
  for (let slot = 0; slot < 4; slot += 1) {
    const step = (Math.floor(index / 8 ** slot) % 8) + 1;
    pcm.writeInt16LE((slot % 2 === 0 ? 1 : -1) * (amplitude + step), slot * 2);
  }
  return pcm.toString('base64');
}

/** One built frame: its unique identity and the truth the scripted classifier will report about it. */
type Frame = { index: number; audio: string; speech: boolean };

/** Builds a corpus from a compact spec, assigning stable indices and unique payloads. */
function build(specs: readonly { speech: boolean; count: number }[], amplitude = SPEECH_RMS): Frame[] {
  const frames: Frame[] = [];
  for (const spec of specs) {
    for (let n = 0; n < spec.count; n += 1) {
      const index = frames.length;
      frames.push({
        index,
        audio: pcmFrame(spec.speech ? amplitude : SILENCE_RMS, index),
        speech: spec.speech,
      });
    }
  }
  return frames;
}

/** The head-keep window the shipped default resolves to, DERIVED rather than written down. */
const A_DEFAULT = Math.round(DEFAULT_TURN_DETECTION.silence_duration_ms / 20) + 1;

// ── the inner classifiers (what a backend looks like to the arm point) ─────────────────────────────

type Inner = UplinkVadClassifier & {
  /** Every grid frame the arm point handed down, in order. */
  readonly fed: Buffer[];
  /** How many times the arm point released it — the AC5 lifecycle reading. */
  readonly closes: number;
};

/**
 * A backend-shaped classifier: verdicts from `speech` (index-aligned), optionally `unavailable`, and
 * optionally THROWING a non-grid error from `failAt` on. `fed` counts CLASSIFY CALLS, so the frame that
 * threw is recorded — that is what lets AC3 read "and no further frame was ever classified".
 */
function createInner(
  options: { speech?: readonly boolean[]; unavailable?: string; failAt?: number } = {},
): Inner {
  const fed: Buffer[] = [];
  let next = 0;
  let closes = 0;
  return {
    backend: 'webrtc',
    status: options.unavailable === undefined ? 'available' : 'unavailable',
    reason: options.unavailable ?? null,
    get fed(): Buffer[] {
      return fed;
    },
    get closes(): number {
      return closes;
    },
    async classify(frame: Buffer): Promise<UplinkVadFrameVerdict | null> {
      const index = next;
      next += 1;
      fed.push(frame);
      if (options.failAt !== undefined && index >= options.failAt) {
        // A NON-grid error: the proxy owns the fail-safe policy, and only this shape reaches it (a
        // `UplinkVadGridError` is the gate's own, handled before the arm point sees it).
        throw new Error('backend exploded mid-stream');
      }
      const speech = options.speech?.[index] ?? true;
      return { frameIndex: index, speech, probability: speech ? 0.9 : 0.05, bypassed: false, reason: null };
    },
    async flush(): Promise<UplinkVadFrameVerdict[]> {
      return [];
    },
    async close(): Promise<void> {
      closes += 1;
    },
  };
}

/** A promise a leg resolves by hand, so a backend load can be held open across a frame. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── the relay: the proxy's continuous branch over a fake socket and fake upstreams ────────────────

/** The slice of the browser socket the proxy touches. */
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
};

/** Builds a fake socket + fake upstreams and drives one continuous connection through the proxy. */
function wire(
  options: {
    uplinkVad?: { classifier: UplinkVadClassifier; silenceDurationMs?: number; exitWaitMs?: number };
    silenceTail?: { tailMs?: number };
    stallMs?: number;
    idleRotateMs?: number;
  } = {},
  proxy: { handleVoiceRealtimeConnection: typeof handleVoiceRealtimeConnection } = {
    handleVoiceRealtimeConnection,
  },
): Wired {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const rotations: UpstreamPoolRotation[] = [];
  const executor: RealtimeToolExecutor = { session_send: async () => ({ runId: 'run-1', queued: false }) };
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
  proxy.handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs, rotations };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

/** Every audio payload the ACTIVE upstream was handed, in order — what `sendAudioFrame` put on the wire. */
const appends = (wired: Wired): string[] =>
  (wired.transports[0]?.sent ?? [])
    .filter((message) => message.type === 'input_audio_buffer.append')
    .map((message) => (message as { audio: string }).audio);

const turnUnanswered = (wired: Wired): number =>
  wired.socket.outbound.filter((frame) => frame.type === 'turn_unanswered').length;

const summaryLine = (wired: Wired): string | undefined =>
  wired.logs.find((line) => line.startsWith('uplink_vad summary:'));

/** Feeds one corpus, yielding to the event loop between chunks. */
async function feed(wired: Wired, frames: readonly Frame[], chunk = 50, betweenMs = 0): Promise<void> {
  for (let sent = 0; sent < frames.length; sent += 1) {
    wired.socket.receive({ type: 'audio', audio: frames[sent]!.audio });
    if ((sent + 1) % chunk === 0) {
      await new Promise((resolve) => setTimeout(resolve, betweenMs));
    }
  }
}

/** Lets the gate's async chain (and any arming timer) settle. */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── the false forms (a textual mutation of the shipping source) ────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(HERE, '..');
const PROXY_SOURCE = readFileSync(path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts'), 'utf8');
const INDEX_SOURCE = readFileSync(path.join(MODULE_DIR, '..', '..', 'index.ts'), 'utf8');

type FalseForm = { file: string; label: string; anchor: string; replacement: string; why: string };

/**
 * Loads a shipping module with `form` applied, as a transient copy BESIDE it — beside it so its relative
 * imports keep resolving, and named with the `__criterion-falsify-` prefix `server/tsconfig.json` excludes
 * by name. The anchor must occur exactly once, so a mutation that stopped matching is a red here.
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

type ArmModule = {
  resolveUplinkVad: typeof resolveUplinkVad;
  describeUplinkVad: typeof describeUplinkVad;
};
type ProxyModule = { handleVoiceRealtimeConnection: typeof handleVoiceRealtimeConnection };

// ── AC1: default OFF, and OFF is byte-for-byte the relay it was ────────────────────────────────────

test('AC1 — unset and `off` resolve to the SAME shipped state, and that state says nothing', () => {
  const shipped = { enabled: false, backend: null, weightsPath: '', invalid: null };
  assert.deepEqual(resolveUplinkVad({}), shipped, 'an unset environment is the shipped OFF state');
  assert.deepEqual(
    resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: UPLINK_VAD_OFF }),
    shipped,
    '`off`, spelled out, is the SAME state as unset — not a second configuration',
  );
  assert.equal(
    describeUplinkVad(resolveUplinkVad({})),
    null,
    'a deployment that named nothing must not read a line about a gate it never asked for',
  );
  assert.equal(describeUplinkVad(resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: UPLINK_VAD_OFF })), null);
});

test('AC1 — a connection wired with no uplink seam is the identity relay, and logs no uplink-vad line', async () => {
  const wired = wire();
  await waitFor(() => opened(wired.socket));
  const frames = build([
    { speech: false, count: 40 },
    { speech: true, count: 20 },
    { speech: false, count: 60 },
  ]);
  await feed(wired, frames);
  await settle();

  assert.deepEqual(
    appends(wired),
    frames.map((frame) => frame.audio),
    'a gate-off connection must relay the browser frames byte for byte, in order',
  );
  assert.equal(
    wired.logs.filter((line) => line.startsWith('uplink_vad:')).length,
    0,
    'a gate-off connection must not report a gate it never built',
  );
  assert.equal(summaryLine(wired), undefined, 'and it must log no per-connection summary');
});

test('AC1 — the assembly point hands the seam over ONLY when the environment asked for a backend', () => {
  // The one construction of the arm point in the composition root is guarded by `enabled`, and the seam
  // is spread in only when an arm point was built — so `undefined` (the default) is a real code path, not
  // a `.?.` that happens to be reached.
  assert.match(
    INDEX_SOURCE,
    /const uplinkVadArmPoint =\s*\n\s*uplinkVadResolution\.enabled && uplinkVadResolution\.backend !== null/,
    'the arm point is built only from an ENABLED resolution',
  );
  assert.match(
    INDEX_SOURCE,
    /\.\.\.\(uplinkVadArmPoint === null \? \{\} : \{ uplinkVad: \{ classifier: uplinkVadArmPoint \} \}\),/,
    'the seam is spread in only when an arm point exists — absent is the shipped default',
  );
});

test('AC1 false form — a default that resolves to a non-off backend turns the identity reading red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-uplink-vad-arm-point.ts',
    label: 'default-on',
    anchor: [
      "  if (value === '' || value === UPLINK_VAD_OFF) {",
      '    return { enabled: false, backend: null, weightsPath, invalid: null };',
      '  }',
    ].join('\n'),
    replacement: [
      "  if (value === '' || value === UPLINK_VAD_OFF) {",
      "    return { enabled: true, backend: 'webrtc', weightsPath, invalid: null };",
      '  }',
    ].join('\n'),
    why: 'the default value was changed to a non-off backend, so an unset environment is no longer OFF',
  };
  const mutated = await loadFalseForm<ArmModule>(form);
  assert.notDeepEqual(
    mutated.resolveUplinkVad({}),
    { enabled: false, backend: null, weightsPath: '', invalid: null },
    `under "${form.why}" the shipped-OFF reading above must go RED`,
  );
  assert.notEqual(mutated.describeUplinkVad(mutated.resolveUplinkVad({})), null, 'and it now speaks');
});

// ── AC2: the five states, each reached by a real path, each observable ─────────────────────────────

test('AC2 — disabled is the seam’s absence, with no arm point to be in a state at all', () => {
  assert.equal(readUplinkVadState(null), 'disabled');
  assert.equal(readUplinkVadArmPoint(createInner()), null, 'a plain backend is not an arm point');
  assert.equal(
    readUplinkVadState(createInner()),
    'ready',
    'a hand-injected backend has no state machine, so it reads ready — it judges every frame',
  );
});

test('AC2 — loading → ready: frames during the load are BYPASSED on the spot, never buffered', async () => {
  const load = deferred<UplinkVadClassifier>();
  const inner = createInner({ speech: [false, true] });
  const logs: string[] = [];
  const arm = createUplinkVadArmPoint({
    backend: 'webrtc',
    log: (line) => logs.push(line),
    createClassifier: () => load.promise,
  });

  assert.equal(arm.state, 'loading', 'a connection that asked for the gate is loading from frame zero');
  // A frame arriving while the backend loads: answered NOW, as a bypassed verdict on this frame's index.
  const duringLoad = await arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES));
  assert.equal(duringLoad?.bypassed, true, 'a loading frame must cross UNJUDGED, not wait for a model');
  assert.equal(duringLoad?.frameIndex, 0, 'and it lands in the arm point’s own index space');
  assert.equal(inner.fed.length, 0, 'the backend was never consulted — it did not exist yet');

  load.resolve(inner);
  await waitFor(() => arm.state === 'ready');
  assert.equal(arm.status, 'available');
  assert.equal(arm.stateReason, null, 'a ready arm point has no reason to be anything else');

  const afterReady = await arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES));
  assert.equal(afterReady?.bypassed, false, 'once ready, the frame is judged for real');
  assert.equal(afterReady?.frameIndex, 1, 'the backend’s index is REBASED onto the arm point’s own');
  assert.equal(inner.fed.length, 1, 'the backend saw exactly the one frame that arrived after it loaded');

  assert.ok(logs.some((line) => line.includes('state=loading')), 'the loading birth is announced');
  assert.ok(logs.some((line) => line.includes('state=ready')), 'and so is the arrival at ready');
  await arm.close();
});

test('AC2 — loading → bypassed: an unloadable backend is a CONNECTION-level fact, said out loud', async () => {
  const inner = createInner({ unavailable: 'no weights at /nonexistent/webrtc' });
  const logs: string[] = [];
  const arm = createUplinkVadArmPoint({
    backend: 'silero',
    log: (line) => logs.push(line),
    createClassifier: async () => inner,
  });
  await waitFor(() => arm.state === 'bypassed');

  assert.equal(arm.status, 'unavailable', 'an unavailable backend reads unavailable, not a silent ready');
  assert.match(arm.stateReason ?? '', /no weights/, 'the reason travels with the state');
  const verdict = await arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES));
  assert.equal(verdict?.bypassed, true, 'every frame crosses unjudged');
  assert.equal(inner.fed.length, 0, 'and the unloadable backend is never asked to classify');
  assert.ok(logs.some((line) => line.includes('state=bypassed')), 'the bypass is announced');
  await arm.close();
});

test('AC2 — ready → failed: a backend that throws once degrades the connection for good', async () => {
  const inner = createInner({ failAt: 1 });
  const logs: string[] = [];
  const arm = createUplinkVadArmPoint({
    backend: 'webrtc',
    log: (line) => logs.push(line),
    createClassifier: async () => inner,
  });
  await waitFor(() => arm.state === 'ready');

  await arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES)); // frame 0 — judged
  await assert.rejects(
    arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES)), // frame 1 — the backend throws
    /backend exploded/,
    'the arm point does NOT swallow the error: the proxy owns the fail-safe policy',
  );
  markUplinkVadFailed(arm, 'backend exploded mid-stream');
  assert.equal(arm.state, 'failed');
  // One-way: from here the frame is bypassed and the backend is never consulted again.
  const afterFailure = await arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES));
  assert.equal(afterFailure?.bypassed, true);
  assert.equal(inner.fed.length, 2, 'the backend was consulted for exactly the two pre-failure frames');
  await arm.close();
});

test('AC2 — a load that REJECTS degrades to failed rather than leaving the connection without a backend', async () => {
  const arm = createUplinkVadArmPoint({
    backend: 'ten',
    createClassifier: async () => {
      throw new Error('the onnx session could not be created');
    },
  });
  await waitFor(() => arm.state === 'failed');
  assert.match(arm.stateReason ?? '', /could not be created/);
  assert.equal((await arm.classify(Buffer.alloc(UPLINK_VAD_FRAME_BYTES)))?.bypassed, true);
  await arm.close();
});

// ── AC3: the fail-safe bypass — a backend error NEVER costs a frame ────────────────────────────────

test('AC3 — the frame whose classification threw is FORWARDED, and every later frame passes unjudged', async () => {
  const inner = createInner({ failAt: 3 });
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: async () => inner });
  await waitFor(() => arm.state === 'ready');

  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  const frames = build([{ speech: true, count: 8 }]);
  await feed(wired, frames);
  await settle();

  assert.equal(readUplinkVadState(arm), 'failed', 'the backend failure degraded the connection');
  assert.ok(
    appends(wired).includes(frames[3]!.audio),
    'the very frame that failed must still cross the wire — a fail-safe bypass forwards, it never drops',
  );
  for (let index = 4; index < frames.length; index += 1) {
    assert.ok(
      appends(wired).includes(frames[index]!.audio),
      `frame ${index}, after the failure, must pass through unjudged`,
    );
  }
  assert.equal(inner.fed.length, 4, 'frames 0..3 were classified; nothing after the failure ever was');
});

test('AC3 — the same corpus with an unavailable backend forwards everything (the control)', async () => {
  const inner = createInner({ unavailable: 'no weights' });
  const arm = createUplinkVadArmPoint({ backend: 'silero', createClassifier: async () => inner });
  await waitFor(() => arm.state === 'bypassed');

  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  const frames = build([{ speech: false, count: 6 }]);
  await feed(wired, frames);
  await settle();
  assert.deepEqual(appends(wired), frames.map((f) => f.audio), 'a bypassed backend withholds nothing');
});

test('AC3 false form — a catch that consumes the error without a flush LOSES the frame, so the reading goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'lost-failing-frame',
    anchor: ['        try {', '          const tail = await gate.flush();'].join('\n'),
    replacement: ['        try {', '          const tail = { frames: [] as string[], sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };'].join(
      '\n',
    ),
    why: 'the post-failure flush was removed, so the frame whose classification threw is never released',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);
  const inner = createInner({ failAt: 3 });
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: async () => inner });
  await waitFor(() => arm.state === 'ready');

  const wired = wire({ uplinkVad: { classifier: arm } }, mutated);
  await waitFor(() => opened(wired.socket));
  const frames = build([{ speech: true, count: 8 }]);
  await feed(wired, frames);
  await settle();

  assert.ok(
    !appends(wired).includes(frames[3]!.audio),
    `under "${form.why}" the failing frame must be missing, so the forward above can only be the flush`,
  );
});

// ── AC4: one summary line per connection, on the way out ───────────────────────────────────────────

test('AC4 — a closing connection logs ONE line with sent/headKept/dropped/bypassed and the browser total', async () => {
  const frames = build([
    { speech: false, count: 5 },
    { speech: true, count: 4 },
    { speech: false, count: 30 },
  ]);
  const arm = createUplinkVadArmPoint({
    backend: 'webrtc',
    createClassifier: async () => createInner({ speech: frames.map((f) => f.speech) }),
  });
  await waitFor(() => arm.state === 'ready');

  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  await feed(wired, frames);
  await settle();
  wired.socket.close(); // a raw close: the teardown is immediate.
  await waitFor(() => summaryLine(wired) !== undefined);

  const line = summaryLine(wired)!;
  assert.match(line, new RegExp(`browserFrames=${frames.length}\\b`), 'the browser’s own frame count');
  // The first 5 frames are the first segment; the pre-roll (P = 10 ≥ 5) replays ALL of them at the onset,
  // so they are counted in `sent`/`preRoll`, not in `dropped` (see the uplink-gate-once-preroll task).
  assert.match(
    line,
    new RegExp(`sent=${4 + A_DEFAULT + 5}\\b`),
    'four speech frames, plus the head window, plus the five the pre-roll replayed',
  );
  assert.match(line, new RegExp(`headKept=${A_DEFAULT}\\b`));
  assert.match(line, new RegExp(`dropped=${30 - A_DEFAULT}\\b`), 'only the run past `a`: the first segment replayed');
  assert.match(line, /\bbypassed=0\b/, 'no verdict came from a bypass — every frame was really judged');
  assert.match(line, /forwardedBytes=\d+/, 'and the byte accounting is on the same line');
  assert.match(line, new RegExp(`preRoll=${5}\\b`), 'the replayed first-segment frames are on the same line');
  assert.equal(
    wired.logs.filter((l) => l.startsWith('uplink_vad summary:')).length,
    1,
    'exactly ONE summary line — teardown runs once',
  );
});

test('AC4 false form — deleting the summary line leaves the connection with no reading, so it goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-ws-proxy.service.ts',
    label: 'no-summary-line',
    anchor: ['    if (uplinkVad !== null) {', '      const stats = uplinkVadStats ?? { sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };'].join(
      '\n',
    ),
    replacement: ['    if (false) {', '      const stats = uplinkVadStats ?? { sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };'].join('\n'),
    why: 'the per-connection summary was deleted, so a closing connection reports nothing',
  };
  const mutated = await loadFalseForm<ProxyModule>(form);
  const frames = build([{ speech: true, count: 6 }]);
  const arm = createUplinkVadArmPoint({
    backend: 'webrtc',
    createClassifier: async () => createInner({ speech: frames.map((f) => f.speech) }),
  });
  await waitFor(() => arm.state === 'ready');

  const wired = wire({ uplinkVad: { classifier: arm } }, mutated);
  await waitFor(() => opened(wired.socket));
  await feed(wired, frames);
  await settle();
  wired.socket.close();
  await settle();

  assert.equal(summaryLine(wired), undefined, `under "${form.why}" the summary above must go RED`);
});

// ── AC5: the model session is released exactly once on every exit path ─────────────────────────────

test('AC5 — a ready arm point releases its backend close() exactly once, and close() is idempotent', async () => {
  const inner = createInner();
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: async () => inner });
  await waitFor(() => arm.state === 'ready');
  await arm.close();
  await arm.close();
  assert.equal(inner.closes, 1, 'close() must reach the backend exactly once, no matter how often it is called');
});

test('AC5 — a connection closed while its backend was STILL LOADING releases the backend the load opened', async () => {
  const load = deferred<UplinkVadClassifier>();
  const inner = createInner();
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: () => load.promise });
  assert.equal(arm.state, 'loading');
  await arm.close(); // the connection ended before the model arrived.
  load.resolve(inner); // the load finishes anyway — the session it opened must not outlive the connection.
  await waitFor(() => inner.closes === 1);
  assert.equal(inner.closes, 1, 'the late-arriving classifier is released exactly once, by the load continuation');
});

test('AC5 — the proxy releases the model exactly once on the NORMAL exit path', async () => {
  const inner = createInner();
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: async () => inner });
  await waitFor(() => arm.state === 'ready');
  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  await feed(wired, build([{ speech: true, count: 4 }]));
  await settle();
  wired.socket.close();
  await waitFor(() => inner.closes === 1);
  assert.equal(inner.closes, 1, 'teardown releases the connection’s model exactly once');
});

test('AC5 — the proxy releases the model exactly once on the FAILED path', async () => {
  const inner = createInner({ failAt: 2 });
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: async () => inner });
  await waitFor(() => arm.state === 'ready');
  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  await feed(wired, build([{ speech: true, count: 5 }]));
  await waitFor(() => readUplinkVadState(arm) === 'failed');
  assert.equal(inner.closes, 0, 'a failed backend is not released until the connection ends');
  wired.socket.close();
  await waitFor(() => inner.closes === 1);
  assert.equal(inner.closes, 1, 'the failed path releases the model exactly once, like the normal one');
});

// ── AC6: env parsing — a typo falls back to OFF and SAYS SO ────────────────────────────────────────

test('AC6 — each backend name resolves on, and a mis-spelling falls back to `off` with a visible report', () => {
  for (const backend of ['silero', 'ten', 'webrtc'] as const) {
    const on = resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: backend });
    assert.deepEqual(on, { enabled: true, backend, weightsPath: '', invalid: null });
  }
  // Case- and whitespace-insensitive, like `resolveVoiceRealtimeMode`.
  assert.equal(resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: '  WebRTC ' }).backend, 'webrtc');
  // The weights path is carried through as spelled.
  assert.equal(
    resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: 'silero', [VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH_ENV]: '/w/s.onnx' })
      .weightsPath,
    '/w/s.onnx',
  );

  const typo = resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: 'webrtk' });
  assert.deepEqual(typo, { enabled: false, backend: null, weightsPath: '', invalid: 'webrtk' }, 'a typo is OFF');
  const note = describeUplinkVad(typo);
  assert.ok(note !== null, 'a typo must be REPORTED, never silently read as a working switch');
  assert.match(note!, /webrtk/, 'the offending value is named');
  assert.match(note!, new RegExp(UPLINK_VAD_OFF), 'and the fallback is named');
  // Isomorphic to the mode resolver’s `invalid`: the same shape, so the two switches are read the same way.
  assert.equal(resolveVoiceRealtimeMode({ VOICE_REALTIME_MODE: 'segmentedd' }).invalid, 'segmentedd');
});

test('AC6 false form — dropping the `invalid` report turns a typo into a silent OFF, so it goes red', async () => {
  const form: FalseForm = {
    file: 'voice-realtime-uplink-vad-arm-point.ts',
    label: 'typo-silent',
    anchor: '  return { enabled: false, backend: null, weightsPath, invalid: raw as string };',
    replacement: '  return { enabled: false, backend: null, weightsPath, invalid: null };',
    why: 'the mis-spelling is no longer reported, so a typo reads the same as the shipped OFF default',
  };
  const mutated = await loadFalseForm<ArmModule>(form);
  const typo = mutated.resolveUplinkVad({ [VOICE_REALTIME_UPLINK_VAD_ENV]: 'webrtk' });
  assert.equal(mutated.describeUplinkVad(typo), null, `under "${form.why}" the typo report above must go RED`);
});

// ── AC7: the uplink VAD does not compound with the retired STS gate ────────────────────────────────

test('AC7 — with the DEPRECATED STS switch set, the uplink VAD still runs and nothing claims STS won', async () => {
  const previous = process.env[SILENCE_TAIL_ENV];
  process.env[SILENCE_TAIL_ENV] = '1';
  try {
    // The deployment’s STS switch really is on — this leg is not vacuous.
    assert.equal(resolveSilenceTail(process.env).enabled, true, 'the retired switch is named in the environment');

    const frames = build([
      { speech: false, count: 5 },
      { speech: true, count: 4 },
      { speech: false, count: 30 },
    ]);
    const arm = createUplinkVadArmPoint({
      backend: 'webrtc',
      createClassifier: async () => createInner({ speech: frames.map((f) => f.speech) }),
    });
    await waitFor(() => arm.state === 'ready');

    // Wired as PRODUCTION wires it: the uplink VAD seam present, and NO silence-tail seam at all — the
    // assembly point never hands one over (see the source assertion below).
    const wired = wire({ uplinkVad: { classifier: arm } });
    await waitFor(() => opened(wired.socket));
    await feed(wired, frames);
    await settle();

    assert.ok(
      !wired.logs.some((line) => line.includes('uplink_vad refused')),
      'the STS-wins refusal must never fire: no silence-tail seam reaches the proxy',
    );
    assert.ok(
      !wired.logs.some((line) => line.startsWith('silence_tail')),
      'and no silence-tail gate ran — the two gates cannot compound',
    );
    assert.ok(
      appends(wired).length < frames.length,
      'the uplink VAD really filtered (the first non-speech segment was dropped), so the reading is not vacuous',
    );
  } finally {
    if (previous === undefined) {
      delete process.env[SILENCE_TAIL_ENV];
    } else {
      process.env[SILENCE_TAIL_ENV] = previous;
    }
  }
});

test('AC7 — the assembly point returns NO silence-tail seam, so the refusal branch is unreachable in production', () => {
  // The proxy returns `{ ... }` from `buildVoiceRealtimeSeams`; it must carry no `silenceTail:` key.
  const returns = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf('return {', INDEX_SOURCE.indexOf('const buildVoiceRealtimeSeams')));
  const body = returns.slice(0, returns.indexOf('\n};'));
  assert.ok(!/^\s*silenceTail:/m.test(body), 'no `silenceTail:` key may appear in the assembled seams');
  assert.match(body, /uplinkVad: \{ classifier: uplinkVadArmPoint \}/, 'while the uplink VAD seam IS assembled');
});

// ── AC8: the existing observation chain is untouched by any VAD state ──────────────────────────────

test('AC8 — the turn-detection resolution the window derives from is byte-identical', () => {
  assert.deepEqual(
    resolveTurnDetection({}),
    { turnDetection: DEFAULT_TURN_DETECTION, invalid: null },
    'the uplink arm point must not move the turn-detector resolution',
  );
});

test('AC8 — the construction line derives `silenceMs` from the resolved turn detection, not a literal', async () => {
  // Wired while the backend is still LOADING, exactly as production wires it: the arm point is returned
  // synchronously and the model arrives later, so the connection's first log line is `state=loading`.
  const load = deferred<UplinkVadClassifier>();
  const arm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: () => load.promise });
  assert.equal(arm.state, 'loading');
  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  const line = wired.logs.find((l) => l.startsWith('uplink_vad:') && l.includes('aFrames='));
  assert.ok(line !== undefined, 'the gate’s construction is logged');
  assert.match(line!, new RegExp(`silenceMs=${DEFAULT_TURN_DETECTION.silence_duration_ms}\\b`));
  assert.match(line!, new RegExp(`aFrames=${A_DEFAULT}\\b`));
  assert.match(line!, /state=loading\b/, 'a production arm point is loading at construction — observable');
  load.resolve(createInner());
  wired.socket.close();
});

test('AC8 — the local speech gate is fed on ARRIVAL in EVERY state: the watchdog arms for loading and failed alike', async () => {
  // A corpus whose local utterance closes only because the local gate saw ALL 55 frames — a gate fed the
  // VAD’s surviving subset would have lost the boundary. `a = 21` < the local gate’s 25-frame run.
  const corpus = build([
    { speech: false, count: 10 },
    { speech: true, count: 5 },
    { speech: false, count: 40 },
  ]);

  // 1. The `failed` state: the backend threw, so every frame crosses unjudged — but the local gate is
  //    still fed the BROWSER’s frames, so the watchdog arms exactly as it would with the gate off.
  const failing = createInner({ failAt: 0 });
  const failedArm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: async () => failing });
  await waitFor(() => failedArm.state === 'ready');
  const failedWire = wire({ uplinkVad: { classifier: failedArm }, stallMs: 120 });
  await waitFor(() => opened(failedWire.socket));
  await feed(failedWire, corpus, 10);
  await waitFor(() => turnUnanswered(failedWire) >= 1, 2_000);

  // 2. The `loading` state: the backend is still loading, so again every frame crosses unjudged.
  const load = deferred<UplinkVadClassifier>();
  const loadingArm = createUplinkVadArmPoint({ backend: 'webrtc', createClassifier: () => load.promise });
  const loadingWire = wire({ uplinkVad: { classifier: loadingArm }, stallMs: 120 });
  await waitFor(() => opened(loadingWire.socket));
  await feed(loadingWire, corpus, 10);
  await waitFor(() => turnUnanswered(loadingWire) >= 1, 2_000);

  // The control: the SAME corpus with no VAD at all.
  const control = wire({ stallMs: 120 });
  await waitFor(() => opened(control.socket));
  await feed(control, corpus, 10);
  await waitFor(() => turnUnanswered(control) >= 1, 2_000);

  // The COUNT comparison AC8 asks for: the watchdog reading is the same number in every state.
  assert.equal(turnUnanswered(failedWire), turnUnanswered(control), 'failed state arms the watchdog like no gate');
  assert.equal(turnUnanswered(loadingWire), turnUnanswered(control), 'loading state arms it identically too');
});

test('AC8 — noteLocalActivity is called per BROWSER frame: a VAD-dropped stretch holds the pool’s clock', async () => {
  const idleRotateMs = 300;
  // Every frame non-speech: the gate drops the first segment whole, so the wire stays silent while the
  // browser streams. If the activity clock followed the WIRE, this stretch would read as idle and rotate.
  const frames = build([{ speech: false, count: 120 }]);
  const arm = createUplinkVadArmPoint({
    backend: 'webrtc',
    createClassifier: async () => createInner({ speech: frames.map((f) => f.speech) }),
  });
  await waitFor(() => arm.state === 'ready');
  const wired = wire({ uplinkVad: { classifier: arm }, idleRotateMs });
  await waitFor(() => opened(wired.socket));

  await feed(wired, frames, 20, Math.ceil(idleRotateMs / 6));
  assert.equal(appends(wired).length, 0, 'every frame is non-speech before any speech: the wire is silent');
  assert.equal(wired.rotations.length, 0, 'a VAD-dropped stretch must not read as an idle connection');
  // Non-vacuity: THIS pool does rotate once the connection is genuinely idle.
  await waitFor(() => wired.rotations.length >= 1, 4_000);
});

// ── AC9: a REAL WebRTC backend, driven to ready, over a real connection ────────────────────────────

test('AC9 — the real WebRTC backend reaches ready and judges frames over a connection (not a mock)', async () => {
  // NO `createClassifier` seam: this is the production builder, loading the real `webrtcvad` package.
  const arm: UplinkVadArmPoint = createUplinkVadArmPoint({ backend: 'webrtc' });
  await waitFor(() => arm.state === 'ready' || arm.state === 'bypassed', 10_000);
  assert.equal(arm.state, 'ready', 'the probe recorded WebRTC `available`; the arm point must reach ready');
  const reading = readUplinkVadBackend(arm);
  assert.equal(reading.status, 'available', 'a real, loadable backend — not the isolation probe’s unavailable');
  assert.equal(reading.bypassed, false);

  // A real verdict from a real model, on a frame the real VAD reads as speech.
  const speech = await arm.classify(Buffer.from(pcmFrame(REAL_SPEECH_RMS, 0), 'base64'));
  assert.equal(speech?.bypassed, false, 'the real backend judged the frame — it did not bypass it');

  // And one whole connection through it: the summary must show ZERO bypasses, i.e. every frame reached
  // the model rather than falling back.
  const wired = wire({ uplinkVad: { classifier: arm } });
  await waitFor(() => opened(wired.socket));
  const frames = build([{ speech: true, count: 6 }, { speech: false, count: 4 }]);
  await feed(wired, frames);
  await settle(120);
  wired.socket.close();
  await waitFor(() => summaryLine(wired) !== undefined);
  assert.match(summaryLine(wired)!, /\bbypassed=0\b/, 'a real backend bypasses nothing: all frames were judged');
  assert.match(summaryLine(wired)!, new RegExp(`browserFrames=${frames.length}\\b`));
});

// ── the arm-point module keeps the pure classifier’s contract intact ───────────────────────────────

test('the arm point lives in its OWN file: the pure classifier still names no production seam', () => {
  // The classifier’s criterion greps it for allocation primitives and for the proxy; this file must not
  // reintroduce either, which is why the arm point is a sibling rather than an addition to it.
  const pure = readFileSync(path.join(MODULE_DIR, 'voice-realtime-uplink-vad.ts'), 'utf8');
  assert.equal(pure.split('voice-realtime-ws-proxy').length - 1, 0, 'the classifier must not name the proxy');
  assert.equal(
    (pure.match(/Buffer\.(alloc|allocUnsafe|concat|from)\(/g) ?? []).length,
    0,
    'the classifier allocates nothing — the arm point is where base64 and frames live',
  );
});
