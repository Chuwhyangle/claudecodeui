import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import { SEGMENTED_RELAY_PROTOCOL } from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';

/**
 * P1c — the browser's segmented relay, with the wire and the audio source faked.
 *
 * The behaviour under test is what the page SENDS, not what the proxy does with it: a
 * session that has negotiated `segmented-v1` must upload the sentences and nothing else,
 * and a session that has not must upload exactly the frames the pre-P1c client uploaded,
 * one for one. Both halves matter together — the segmented path is only correct if it is
 * reachable, and the fallback is only correct if it is byte-for-byte what shipped.
 *
 * The synthetic 200-second input is four sentences separated by 40-second silences over a
 * 1e-4 noise floor, which is what `StreamingVad` needs to see: its noise floor is a sliding
 * percentile, so a constant-amplitude fixture reads as silence and no sentence would ever be
 * segmented. The energies here are the fixture's, not the detector's.
 */

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

/** A controllable audio source: the test pushes frames, and can see whether it was released. */
type FakeSource = VoiceRealtimeAudioSource & { push(frame: VoiceRealtimeAudioFrame): void; stopped: number };
const sources: FakeSource[] = [];
vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = (): FakeSource => {
    let onFrame: ((frame: VoiceRealtimeAudioFrame) => void) | null = null;
    const source: FakeSource = {
      stopped: 0,
      async start(handler) {
        onFrame = handler;
      },
      stop() {
        source.stopped += 1;
      },
      push(frame) {
        onFrame?.(frame);
      },
    };
    sources.push(source);
    return source;
  };
  return { microphoneAudioSource: make, fileAudioSource: make };
});

/** One frame the page put on the wire. */
type SentFrame = {
  type: string;
  seq?: number;
  audio?: string;
  reason?: string;
  durationMs?: number;
  protocol?: string;
  startedAtMs?: number;
};

/** The slice of WebSocket the hook uses, with both hands: it opens when the test says so. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
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
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** The socket becomes usable — the moment the client's protocol offer goes out. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  /** Delivers one server frame to the page. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
  frames(): SentFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as SentFrame);
  }
  of(type: string): SentFrame[] {
    return this.frames().filter((entry) => entry.type === type);
  }
}

const SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = SAMPLE_RATE;
/** The segmented path's audio is 16 kHz mono PCM16, so its duration is its byte length. */
const audioSeconds = (audio: string): number => Buffer.from(audio, 'base64').length / 2 / SAMPLE_RATE;
const decode = (audio: string): number[] => {
  const bytes = Buffer.from(audio, 'base64');
  return Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readInt16LE(index * 2));
};

/** One second of speech: a 220 Hz tone under a moving envelope, so its energy is not a flat line. */
function speechChunk(offsetSeconds: number): Float32Array {
  const samples = new Float32Array(CHUNK_SAMPLES);
  for (let index = 0; index < samples.length; index += 1) {
    const seconds = offsetSeconds + index / SAMPLE_RATE;
    const envelope = 0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * seconds);
    samples[index] = 0.3 * envelope * Math.sin(2 * Math.PI * 220 * seconds);
  }
  return samples;
}

/** One second of room tone, three orders of magnitude below speech: the noise floor. */
function silenceChunk(): Float32Array {
  const samples = new Float32Array(CHUNK_SAMPLES);
  samples.fill(1e-4);
  return samples;
}

/** The synthetic input: four sentences (3 s each) behind 40-second silences, 200 s in all. */
const TIMELINE: { speech: boolean; seconds: number }[] = [
  { speech: false, seconds: 2 },
  { speech: true, seconds: 3 },
  { speech: false, seconds: 40 },
  { speech: true, seconds: 3 },
  { speech: false, seconds: 40 },
  { speech: true, seconds: 3 },
  { speech: false, seconds: 40 },
  { speech: true, seconds: 3 },
  { speech: false, seconds: 66 },
];

const frame = (samples: number[], sourceRate = SAMPLE_RATE): VoiceRealtimeAudioFrame => ({
  samples: Float32Array.from(samples),
  sourceRate,
});

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

/** Starts a session whose server declares the segmented relay before the upstream opens. */
const openSegmented = (declaration: unknown = { type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL }) => {
  const hook = mount();
  act(() => hook.result.current.start());
  const ws = socket();
  act(() => ws.open());
  act(() => ws.receive(declaration));
  act(() => ws.receive({ type: 'state', state: 'open' }));
  return { ...hook, ws };
};

/** Pushes the whole synthetic input, one second at a time, through the active source. */
const pushTimeline = (): void => {
  const source = sources[0]!;
  let offsetSeconds = 0;
  act(() => {
    for (const part of TIMELINE) {
      for (let second = 0; second < part.seconds; second += 1) {
        source.push({
          samples: part.speech ? speechChunk(offsetSeconds) : silenceChunk(),
          sourceRate: SAMPLE_RATE,
        });
        offsetSeconds += 1;
      }
    }
  });
};

describe('the protocol handshake', () => {
  test('the client offers segmented-v1 the moment the socket opens, before any audio', () => {
    const { result } = mount();
    act(() => result.current.start());
    const ws = socket();
    expect(ws.of('hello')).toEqual([]);
    act(() => ws.open());
    expect(ws.of('hello')).toEqual([{ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL }]);
    // Nothing else goes out on the offer alone: the server has not answered yet.
    expect(ws.frames().filter((entry) => entry.type !== 'hello')).toEqual([]);
  });
});

describe('the segmented path', () => {
  test('200 seconds of input carrying four sentences upload at most 25 seconds of audio, in four segments', () => {
    const { ws } = openSegmented();

    pushTimeline();

    // The criterion's own reading, first: how many seconds of audio went upstream.
    const uploaded = ws.of('audio').reduce((total, entry) => total + audioSeconds(entry.audio!), 0);
    // The input was 200 seconds; the sentences in it were 4 × 3 s of them.
    expect(TIMELINE.reduce((total, part) => total + part.seconds, 0)).toBe(200);
    expect(uploaded).toBeLessThanOrEqual(25);

    // Every frame on the wire after the handshake carries a seq: nothing is sent continuously.
    const wire = ws.frames().filter((entry) => entry.type !== 'hello');
    expect(wire.every((entry) => typeof entry.seq === 'number')).toBe(true);

    // Exactly one pair of boundaries per segment, and the segment's audio between them.
    expect(wire.map((entry) => `${entry.type}#${entry.seq}`)).toEqual(
      [0, 1, 2, 3].flatMap((seq) => [`segment_start#${seq}`, `audio#${seq}`, `segment_end#${seq}`]),
    );
    // Four sentences, four segments, each committed by the 40-second pause that follows it.
    expect(ws.of('segment_end').map((entry) => entry.reason)).toEqual(['gap', 'gap', 'gap', 'gap']);
    // And each segment really does carry its sentence: about 3 s of speech plus the 0.3 s pre-roll.
    for (const entry of ws.of('audio')) {
      expect(audioSeconds(entry.audio!)).toBeGreaterThan(2.5);
      expect(audioSeconds(entry.audio!)).toBeLessThan(4);
    }
  });

  test('a declaration carried on the state frame switches the connection too', () => {
    const { ws } = openSegmented({ type: 'state', state: 'open', protocol: SEGMENTED_RELAY_PROTOCOL });
    pushTimeline();
    expect(ws.of('segment_start')).toHaveLength(4);
  });
});

describe('the continuous fallback', () => {
  test('a server that never declares receives the pre-P1c frames, one per captured frame', () => {
    const { result } = mount();
    act(() => result.current.start());
    const ws = socket();
    act(() => ws.open());
    // The offer still went out; this server simply has no answer for it.
    expect(ws.of('hello')).toHaveLength(1);
    act(() => ws.receive({ type: 'state', state: 'open' }));
    act(() => {
      sources[0]!.push(frame([0.1]));
      sources[0]!.push(frame([0.2]));
      sources[0]!.push(frame([0.3]));
    });
    const audio = ws.of('audio');
    expect(audio.map((entry) => entry.seq)).toEqual([undefined, undefined, undefined]);
    // Byte-for-byte the encoding the client shipped: 0.1/0.2/0.3 of full scale, and a
    // clamped/decimated frame is unchanged too.
    expect(audio.map((entry) => decode(entry.audio!)[0])).toEqual([3276, 6553, 9830]);
    act(() => sources[0]!.push(frame([0, 0.5, -0.5, 2, -2])));
    expect(decode(ws.of('audio')[3]!.audio!)).toEqual([0, 16383, -16384, 32767, -32768]);
    // And no segment framing of any kind appears on this connection.
    expect(ws.of('segment_start')).toEqual([]);
    expect(ws.of('segment_end')).toEqual([]);
  });

  test('a server that declares a DIFFERENT protocol keeps the connection continuous', () => {
    const { result } = mount();
    act(() => result.current.start());
    const ws = socket();
    act(() => ws.open());
    act(() => ws.receive({ type: 'ready', protocol: 'segmented-v2' }));
    act(() => ws.receive({ type: 'state', state: 'open' }));
    act(() => sources[0]!.push(frame([0.1])));
    expect(ws.of('segment_start')).toEqual([]);
    expect(ws.of('audio')[0]!.seq).toBeUndefined();
  });

  test('frames captured before the declaration still reach the server, replayed in order', () => {
    const { result } = mount();
    act(() => result.current.start());
    act(() => {
      sources[0]!.push(frame([0.1]));
      sources[0]!.push(frame([0.2]));
    });
    const ws = socket();
    act(() => ws.open());
    expect(ws.of('audio')).toEqual([]);
    act(() => ws.receive({ type: 'state', state: 'open' }));
    expect(ws.of('audio').map((entry) => decode(entry.audio!)[0])).toEqual([3276, 6553]);
  });
});

describe('mute and end mid-sentence', () => {
  test('Mute delivers the open sentence as a segment_end before it stops sending', () => {
    const { result, ws } = openSegmented();
    act(() => {
      sources[0]!.push({ samples: silenceChunk(), sourceRate: SAMPLE_RATE });
      sources[0]!.push({ samples: speechChunk(1), sourceRate: SAMPLE_RATE });
    });
    // A sentence with no committing pause behind it is still open — nothing sent yet.
    expect(ws.of('segment_end')).toEqual([]);

    act(() => result.current.mute());

    expect(ws.of('segment_end').map((entry) => entry.seq)).toEqual([0]);
    expect(result.current.phase).toBe('muted');
    // The flush happened BEFORE the mute: its own segment, not a later frame of some other one.
    const types = ws.frames().map((entry) => entry.type);
    expect(types.slice(-3)).toEqual(['segment_start', 'audio', 'segment_end']);
    expect(types.indexOf('segment_start')).toBeLessThan(types.indexOf('segment_end'));
  });

  test('End delivers the open sentence and only then closes the connection', () => {
    const { result, ws } = openSegmented();
    act(() => {
      sources[0]!.push({ samples: silenceChunk(), sourceRate: SAMPLE_RATE });
      sources[0]!.push({ samples: speechChunk(1), sourceRate: SAMPLE_RATE });
    });
    act(() => result.current.end());
    const types = ws.frames().map((entry) => entry.type);
    expect(types.indexOf('segment_end')).toBeGreaterThan(-1);
    expect(types.indexOf('close')).toBeGreaterThan(types.lastIndexOf('segment_end'));
    expect(ws.closed).toBe(true);
    expect(result.current.phase).toBe('idle');
  });

  test('speech after an unmute is its own segment, not swallowed by the one Mute flushed', () => {
    const { result, ws } = openSegmented();
    const speak = (offset: number) => {
      act(() => {
        sources[0]!.push({ samples: silenceChunk(), sourceRate: SAMPLE_RATE });
        sources[0]!.push({ samples: speechChunk(offset), sourceRate: SAMPLE_RATE });
      });
    };
    speak(0);
    act(() => result.current.mute());
    act(() => result.current.unmute());
    speak(10);
    act(() => result.current.end());
    // One segment per spoken burst: the second is not folded into the first.
    expect(ws.of('segment_end').map((entry) => entry.seq)).toEqual([0, 1]);
  });
});

describe('segment acknowledgements', () => {
  test('the proxy verdict is taken without touching the session', () => {
    const { result, ws } = openSegmented();
    pushTimeline();
    act(() => ws.receive({ type: 'segment_ack', seq: 0, state: 'committed' }));
    act(() => ws.receive({ type: 'segment_ack', seq: 1, state: 'dropped', reason: 'unknown-segment' }));
    expect(result.current.phase).toBe('listening');
    expect(result.current.error).toBeNull();
    expect(result.current.disconnected).toBe(false);
  });
});
