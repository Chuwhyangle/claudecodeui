import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';

/**
 * The page half of the narrator's first-frame playback (GOAL-047 follow-up).
 *
 * WHAT THIS FILE PINS:
 *
 *   · PLAYBACK STARTS BEFORE THE UTTERANCE IS COMPLETE. The `tts_audio` frames are delivered one
 *     at a time with an event log; the first `AudioBufferSourceNode.start()` must be recorded while
 *     `tts_done` has NOT been delivered. The pre-fix page only ever called `play()` on `tts_done`,
 *     so the "start before done" ordering is the criterion (a recording fake AudioContext makes it
 *     readable without a real audio device).
 *
 *   · `narrator_done` WAITS FOR THE LAST SCHEDULED SOURCE. `tts_done` means "no more slices"; the
 *     pacing ack is emitted once, after the last source's `ended` — never on `tts_done` itself and
 *     never twice.
 *
 *   · THE FALLBACK IS THE OLD PATH, UNCHANGED. With no `AudioContext` the slices are assembled into
 *     a Blob at `tts_done` and acked when the element finishes.
 *
 *   · `narrator_stop` SILENCES EVERY SCHEDULED SOURCE AND DOES NOT ACK. The server has already
 *     cleared the utterance; an ack here would claim a completion that never happened.
 */

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = () => ({
    async start() {},
    stop() {},
  });
  return { microphoneAudioSource: make, fileAudioSource: make, pacedFileAudioSource: make };
});

/** The slice of WebSocket the hook uses, with a hand to deliver server frames. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
  /** The frames the hook sent, parsed and filtered by type. */
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((raw) => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((frame): frame is Record<string, unknown> => frame !== null && frame.type === type);
  }
}

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

// ── a recording AudioContext ────────────────────────────────────────────────────────────────────

/** Every `start()`/`stop()` the page made, in order, plus the test's own markers. */
const playbackLog: string[] = [];

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(channels: number, length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel]!;
  }
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect(): void {}
  start(when = 0): void {
    this.startedAt = when;
    playbackLog.push('start');
  }
  stop(): void {
    this.stopped = true;
    playbackLog.push('stop');
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = {};
  sources: FakeBufferSource[] = [];
  closed = false;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** The `<audio>` element stand-in for the Blob path. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  played = 0;
  constructor() {
    FakeAudio.instances.push(this);
  }
  load(): void {}
  play(): Promise<void> {
    this.played += 1;
    return Promise.resolve();
  }
  pause(): void {}
  removeAttribute(): void {
    this.src = '';
  }
}

// ── a real WAV payload the frames carry ─────────────────────────────────────────────────────────

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

const SAMPLE_RATE = 24_000;
const SAMPLE_COUNT = 2_400; // 100 ms

function makeWav(): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = SAMPLE_COUNT * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);
  writeAscii(bytes, 0, 'RIFF');
  writeUint32(bytes, 4, 36 + dataSize);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  writeUint32(bytes, 16, 16);
  writeUint16(bytes, 20, 1);
  writeUint16(bytes, 22, 1);
  writeUint32(bytes, 24, SAMPLE_RATE);
  writeUint32(bytes, 28, SAMPLE_RATE * bytesPerSample);
  writeUint16(bytes, 32, bytesPerSample);
  writeUint16(bytes, 34, 16);
  writeAscii(bytes, 36, 'data');
  writeUint32(bytes, 40, dataSize);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const sample = Math.round(Math.sin(index / 8) * 10_000);
    writeUint16(bytes, 44 + index * 2, sample < 0 ? sample + 0x1_0000 : sample);
  }
  return bytes;
}

const WAV = makeWav();
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Feeds one complete utterance as header + two PCM slices, without `tts_done`. */
const feedAudio = (utteranceId: string): void => {
  act(() =>
    socket().receive({
      type: 'tts_audio',
      utteranceId,
      seq: 0,
      audio: base64(WAV.subarray(0, 44)),
      format: 'wav',
      sampleRate: SAMPLE_RATE,
    }),
  );
  act(() =>
    socket().receive({
      type: 'tts_audio',
      utteranceId,
      seq: 1,
      audio: base64(WAV.subarray(44, 44 + 1_024)),
      format: 'wav',
      sampleRate: SAMPLE_RATE,
    }),
  );
  act(() =>
    socket().receive({
      type: 'tts_audio',
      utteranceId,
      seq: 2,
      audio: base64(WAV.subarray(44 + 1_024)),
      format: 'wav',
      sampleRate: SAMPLE_RATE,
    }),
  );
};

const doneFrame = (utteranceId: string) => ({
  type: 'tts_done',
  utteranceId,
  frames: 3,
  bytes: WAV.length,
  durationMs: (SAMPLE_COUNT / SAMPLE_RATE) * 1000,
  characters: 3,
});

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  FakeAudio.instances = [];
  playbackLog.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('Audio', FakeAudio);
  // jsdom has no object-URL implementation; the Blob path only needs a stable string.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:narrator';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));

const open = () => {
  const hook = mount();
  act(() => hook.result.current.start());
  act(() => socket().receive({ type: 'state', state: 'open' }));
  return hook;
};

// ── the streaming criterion ─────────────────────────────────────────────────────────────────────

test('the first scheduled source starts before tts_done, and narrator_done fires once after the last source ends', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  const { result } = open();

  act(() => socket().receive({ type: 'narrator_speak', utteranceId: 'narr-1', text: '好的' }));
  feedAudio('narr-1');

  const context = FakeAudioContext.instances[0];
  expect(context).toBeDefined();
  expect(context!.sources.length).toBeGreaterThanOrEqual(1);
  // THE CRITERION: playback has begun while the utterance is still incomplete.
  expect(playbackLog.filter((entry) => entry === 'start').length).toBeGreaterThanOrEqual(1);
  expect(playbackLog).not.toContain('tts_done');
  expect(socket().frames('narrator_done')).toHaveLength(0);

  // The last scheduled source is the one whose `ended` closes the utterance.
  playbackLog.push('tts_done');
  act(() => socket().receive(doneFrame('narr-1')));
  expect(playbackLog.indexOf('start')).toBeLessThan(playbackLog.indexOf('tts_done'));
  // `tts_done` alone must NOT ack: the audio is still playing.
  expect(socket().frames('narrator_done')).toHaveLength(0);

  const last = context!.sources[context!.sources.length - 1]!;
  act(() => last.onended?.());
  const acks = socket().frames('narrator_done');
  expect(acks).toHaveLength(1);
  expect(acks[0]!.utteranceId).toBe('narr-1');

  // A second `ended` (or a late `tts_done`) cannot ack twice.
  act(() => last.onended?.());
  expect(socket().frames('narrator_done')).toHaveLength(1);
  expect(result.current.phase).not.toBe('failed');
});

// ── the fallback leg (no AudioContext) + the stop rule ──────────────────────────────────────────

test('fallback without AudioContext plays the assembled Blob and acks on ended; narrator_stop silences scheduled sources without acking', () => {
  // PART 1 — no AudioContext at all: the old Blob path.
  vi.stubGlobal('AudioContext', undefined);

  const first = open();
  act(() => socket().receive({ type: 'narrator_speak', utteranceId: 'narr-blob', text: '好的' }));
  feedAudio('narr-blob');
  expect(FakeAudio.instances).toHaveLength(0);
  expect(playbackLog).toHaveLength(0);

  act(() => socket().receive(doneFrame('narr-blob')));
  expect(FakeAudio.instances).toHaveLength(1);
  const element = FakeAudio.instances[0]!;
  expect(element.played).toBe(1);
  expect(element.src).toBe('blob:narrator');
  // The element is playing; the ack waits for it.
  expect(socket().frames('narrator_done')).toHaveLength(0);
  act(() => element.onended?.());
  expect(socket().frames('narrator_done')).toHaveLength(1);
  expect(socket().frames('narrator_done')[0]!.utteranceId).toBe('narr-blob');
  act(() => first.unmount());

  // PART 2 — streaming, then the person speaks: every scheduled source is stopped, no ack.
  FakeWebSocket.instances = [];
  FakeAudio.instances = [];
  playbackLog.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);

  open();
  act(() => socket().receive({ type: 'narrator_speak', utteranceId: 'narr-stop', text: '好的' }));
  feedAudio('narr-stop');
  const context = FakeAudioContext.instances[0]!;
  expect(context.sources.length).toBeGreaterThanOrEqual(1);

  act(() => socket().receive({ type: 'narrator_stop', utteranceId: 'narr-stop', reason: 'user-spoke' }));
  expect(context.sources.every((source) => source.stopped)).toBe(true);
  expect(context.closed).toBe(true);
  expect(socket().frames('narrator_done')).toHaveLength(0);
});
