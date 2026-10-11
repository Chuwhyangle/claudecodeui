import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import {
  fileAudioSource,
  pacedFileAudioSource,
  type PacedAudioSourceOptions,
  type VoiceRealtimeAudioFrame,
} from '@/modules/chat/voice-realtime/audioSource';

/**
 * The real-time paced audio source, and the negative control on the microtask source beside it.
 *
 * `fileAudioSource` produces its whole fixture inside one macrotask (a microtask yield between
 * chunks), which is what AC-315's handshake-race guard depends on and what makes it impossible
 * to interrupt playback: nothing else runs until the fixture is done. `pacedFileAudioSource`
 * is the sibling that plays on the REAL timeline and can be paused, resumed or stopped
 * part-way — and this file is where both of those claims are pinned.
 *
 * WHY A CONTROLLED CLOCK. The point of AC1 is that frame arrival equals SCRIPT time, which is
 * only readable if time is ours: the source's `schedule` seam is given a virtual clock, the
 * clock is stepped, and each `onFrame` records the clock reading. A real `setTimeout` would
 * make the reading a wall-clock race instead of an equality.
 *
 * WHY THE HOOK IS REAL TOO (AC4b/AC5). The source is not judged in isolation: the hook that
 * consumes it is the shipped `useVoiceRealtimeSession`, driven through the same
 * `startWithFile` test seam AC-315 uses, so a claim about "the wire frame count" is read off
 * the real socket-framing path rather than a stand-in for it.
 */

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

/** The fixture this file decodes: 16 kHz, exactly ten 20 ms frames of a strictly positive ramp. */
const SAMPLE_RATE = 16_000;
const FRAME_SIZE = SAMPLE_RATE * 0.02;
const FRAME_MS = 20;
const FRAME_COUNT = 10;
const SAMPLE_COUNT = FRAME_SIZE * FRAME_COUNT;
/**
 * A ramp, and deliberately never zero: a pause frame is digital silence (all zeros), so a
 * non-zero fixture makes "this frame is the pause's silence" and "this frame is the fixture's
 * audio" distinguishable by value alone.
 */
const FIXTURE_SAMPLES = Float32Array.from({ length: SAMPLE_COUNT }, (_, index) => (index + 1) / SAMPLE_COUNT);

/** What a stubbed `AudioContext.decodeAudioData` hands back, set per case by the fixture hooks. */
let decodedSamples = FIXTURE_SAMPLES;
let decodedRate = SAMPLE_RATE;

/**
 * The `AudioContext` jsdom does not have. It defines no Web Audio graph — only the decode the
 * two file sources actually call — so the sources run unchanged against a real class shape.
 */
class FakeAudioContext {
  decodeAudioData(_buffer: ArrayBuffer): Promise<AudioBuffer> {
    const samples = decodedSamples;
    return Promise.resolve({
      numberOfChannels: 1,
      length: samples.length,
      sampleRate: decodedRate,
      getChannelData: () => samples,
    } as unknown as AudioBuffer);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A file whose bytes are irrelevant (decode is stubbed); the sources only call `arrayBuffer()`.
 * jsdom's `File` does not implement `arrayBuffer()`, so it is supplied on the instance — this is
 * the one gap between jsdom's File and the browser's, and the sources never read the bytes.
 */
const audioFile = (): File =>
  Object.assign(new File([new Uint8Array([1, 2, 3, 4])], 'fixture.wav', { type: 'audio/wav' }), {
    arrayBuffer: async () => new ArrayBuffer(8),
  });

/** A controlled clock: the `schedule` seam's virtual time, stepped by hand. */
type Clock = {
  schedule: (delayMs: number, run: () => void) => unknown;
  now: () => number;
  advance: (ms: number) => void;
  pending: () => number;
};

function createClock(): Clock {
  let now = 0;
  let order = 0;
  const tasks: { at: number; order: number; run: () => void }[] = [];
  return {
    schedule(delayMs, run) {
      tasks.push({ at: now + delayMs, order: order++, run });
      return undefined;
    },
    now: () => now,
    // Runs every task due strictly inside the interval [now, now + ms), earliest first and ties
    // by schedule order, then moves the clock to the interval's end. Strictly-inside keeps one
    // frame per `advance(FRAME_MS)` step: a task due at exactly the new `now` belongs to the
    // NEXT step.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = -1;
        for (let index = 0; index < tasks.length; index += 1) {
          const candidate = tasks[index]!;
          if (candidate.at >= target) continue;
          if (pick === -1 || candidate.at < tasks[pick]!.at || (candidate.at === tasks[pick]!.at && candidate.order < tasks[pick]!.order)) {
            pick = index;
          }
        }
        if (pick === -1) break;
        const [task] = tasks.splice(pick, 1);
        now = task!.at;
        task!.run();
      }
      now = target;
    },
    pending: () => tasks.length,
  };
}

/** Lets the sources' own async decode (and any microtask emission) settle before time is stepped. */
const settle = async (turns = 3): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

/** One recorded frame: the clock reading at arrival, plus the samples themselves. */
type Arrival = { at: number; samples: Float32Array };

const isSilent = (samples: Float32Array): boolean => samples.every((sample) => sample === 0);

beforeEach(() => {
  auth.token = 'jwt-token';
  decodedSamples = FIXTURE_SAMPLES;
  decodedRate = SAMPLE_RATE;
  vi.stubGlobal('AudioContext', FakeAudioContext);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// AC1 — arrival time equals script time, and the microtask source cannot satisfy the same reading.
// ---------------------------------------------------------------------------------------------
describe('AC1: the paced source arrives on the script timeline', () => {
  test('frame k arrives at k frame-times under a controlled clock, and the microtask source does not', async () => {
    const clock = createClock();
    const pacedArrivals: Arrival[] = [];
    const paced = pacedFileAudioSource(audioFile(), { schedule: clock.schedule });
    const running = paced.start((frame) => pacedArrivals.push({ at: clock.now(), samples: frame.samples }));
    await settle();
    // Step script time past the whole fixture in one go: frame k is due at k × FRAME_MS.
    clock.advance(FRAME_COUNT * FRAME_MS);
    await running;

    const pacedTimes = pacedArrivals.map((arrival) => arrival.at);
    const scriptTimes = Array.from({ length: FRAME_COUNT }, (_, index) => index * FRAME_MS);
    expect(pacedTimes).toEqual(scriptTimes);

    // The same reading against the microtask source: it never consults the clock, so every one of
    // its frames is recorded at script time 0 — it emitted the fixture "in 0 ms". That is the
    // falsification form of this AC: the equality above is false for that source.
    const fileClock = createClock();
    const fileTimes: number[] = [];
    await fileAudioSource(audioFile()).start(() => fileTimes.push(fileClock.now()));
    expect(fileTimes).toEqual(Array.from({ length: FRAME_COUNT }, () => 0));
    expect(fileTimes).not.toEqual(scriptTimes);
  });
});

// ---------------------------------------------------------------------------------------------
// AC2 — pause holds the fixture and emits silence; resume continues with a continuous atSample.
// ---------------------------------------------------------------------------------------------
describe('AC2: pause/resume keep atSample continuous and the fixture content unbroken', () => {
  test('pause emits silence without advancing the fixture, resume continues where it stopped', async () => {
    const clock = createClock();
    const arrivals: Arrival[] = [];
    const paced = pacedFileAudioSource(audioFile(), { schedule: clock.schedule });
    void paced.start((frame) => arrivals.push({ at: clock.now(), samples: frame.samples }));
    await settle();

    clock.advance(FRAME_MS); // frame 0 (fixture[0..320))
    clock.advance(FRAME_MS); // frame 1 (fixture[320..640))
    paced.pause();
    clock.advance(FRAME_MS); // silence
    clock.advance(FRAME_MS); // silence
    paced.resume();
    clock.advance(FRAME_MS); // fixture[640..960) — continuous, no sample skipped
    clock.advance(FRAME_MS); // fixture[960..1280)
    paced.stop();
    await settle();

    // The reading: six frames, one per step, and an `atSample` trajectory that advances by exactly
    // one frame each time — no gap, which is the invariant `LiveSegmenter.push` throws on.
    expect(arrivals.map((arrival) => arrival.at)).toEqual([0, 20, 40, 60, 80, 100]);
    const atSample: number[] = [];
    let cursor = 0;
    for (const arrival of arrivals) {
      cursor += arrival.samples.length;
      atSample.push(cursor);
    }
    expect(atSample).toEqual(Array.from({ length: 6 }, (_, index) => (index + 1) * FRAME_SIZE));
    for (let index = 1; index < atSample.length; index += 1) {
      expect(atSample[index]! - atSample[index - 1]!).toBe(FRAME_SIZE);
    }

    // The two paused frames carry no fixture audio at all — the fixture's own samples produce no
    // frames while paused (the declared semantics: pause emits silence, it does not advance).
    expect(isSilent(arrivals[2]!.samples)).toBe(true);
    expect(isSilent(arrivals[3]!.samples)).toBe(true);

    // Content continuity across the pause: the frame after `resume()` is the fixture's NEXT
    // sample, so nothing was skipped and nothing repeated.
    expect(Array.from(arrivals[4]!.samples)).toEqual(Array.from(FIXTURE_SAMPLES.subarray(640, 960)));
    expect(Array.from(arrivals[5]!.samples)).toEqual(Array.from(FIXTURE_SAMPLES.subarray(960, 1280)));
    // And the pre-pause frames are the fixture's own opening samples.
    expect(Array.from(arrivals[0]!.samples)).toEqual(Array.from(FIXTURE_SAMPLES.subarray(0, 320)));
    expect(Array.from(arrivals[1]!.samples)).toEqual(Array.from(FIXTURE_SAMPLES.subarray(320, 640)));
  });
});

// ---------------------------------------------------------------------------------------------
// AC3 — stop() interrupts a fixture mid-playback; the microtask source cannot be interrupted.
// ---------------------------------------------------------------------------------------------
describe('AC3: stop() ends playback mid-fixture', () => {
  test('stopping halfway freezes the frame count below the fixture total', async () => {
    const clock = createClock();
    let frames = 0;
    const paced = pacedFileAudioSource(audioFile(), { schedule: clock.schedule });
    void paced.start(() => {
      frames += 1;
    });
    await settle();

    for (let step = 0; step < 5; step += 1) clock.advance(FRAME_MS);
    const atStop = frames;
    paced.stop();
    // Time keeps moving, but a stopped source emits nothing more.
    for (let step = 0; step < 5; step += 1) clock.advance(FRAME_MS);

    expect(atStop).toBe(5);
    expect(frames).toBe(atStop);
    expect(frames).toBeLessThan(FRAME_COUNT);
  });
});

// ---------------------------------------------------------------------------------------------
// AC4 — the negative control: fileAudioSource is untouched, still one macrotask, and the
// AC-315 handshake-race guard stays falsifiable on the real hook.
// ---------------------------------------------------------------------------------------------
describe('AC4: fileAudioSource is unchanged (frame sequence, count, single-macrotask timing)', () => {
  test('the microtask source yields no macrotask and reaches the same frames', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const firstSamples: number[] = [];
    const frames: VoiceRealtimeAudioFrame[] = [];
    await fileAudioSource(audioFile()).start((frame) => {
      frames.push(frame);
      firstSamples.push(frame.samples[0]!);
    });
    // "One macrotask" read mechanically: the source issued no timer at all, so every frame was
    // produced inside the single call that started it.
    expect(timerSpy).not.toHaveBeenCalled();

    expect(frames).toHaveLength(FRAME_COUNT);
    // The frame sequence is the fixture chunked at 20 ms — one frame per FRAME_SIZE samples, in order.
    expect(frames.map((frame) => frame.samples.length)).toEqual(Array.from({ length: FRAME_COUNT }, () => FRAME_SIZE));
    expect(firstSamples).toEqual(Array.from({ length: FRAME_COUNT }, (_, index) => FIXTURE_SAMPLES[index * FRAME_SIZE]!));
    expect(frames[0]!.sourceRate).toBe(SAMPLE_RATE);
  });

  test('on the real hook, the whole fixture is produced before `open` and replayed from the handshake queue', async () => {
    const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
    act(() => hook.result.current.startWithFile(audioFile()));
    // Decode + the fixture's entire microtask emission, with NO macrotask of the source's own
    // (the settle timers are the test's, not the source's) — exactly the timing AC-315's guard
    // depends on.
    await settle();
    // Every frame was produced BEFORE the socket reported the upstream open, so nothing was sent:
    // all of them are sitting in the handshake-gap queue. That is the guard's falsifiable form —
    // a source that yielded to a macrotask would have produced fewer frames here, and the replay
    // assertion below would come up short.
    expect(socket().audio()).toEqual([]);
    act(() => socket().receive({ type: 'state', state: 'open' }));
    // Replayed in order, all ten, at the synchronous moment `open` arrives.
    expect(socket().audio()).toHaveLength(FRAME_COUNT);
  });
});

// ---------------------------------------------------------------------------------------------
// AC5 — the Mute criterion, on the real hook with the paced source: mid-fixture Mute freezes the
// wire frame count, and unmute resumes it.
// ---------------------------------------------------------------------------------------------
describe('AC5: mid-fixture Mute freezes the wire frame count on the real hook', () => {
  test('mute stops the count growing and unmute resumes it', async () => {
    const clock = createClock();
    const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
    act(() => hook.result.current.startWithFile(audioFile(), { schedule: clock.schedule } as PacedAudioSourceOptions));
    await settle();
    act(() => socket().receive({ type: 'state', state: 'open' }));

    clock.advance(3 * FRAME_MS);
    const flowing = socket().audio().length;
    expect(flowing).toBeGreaterThan(0);

    act(() => hook.result.current.mute());
    clock.advance(3 * FRAME_MS);
    const muted = socket().audio().length;
    // The source keeps emitting; the hook drops every frame.
    expect(muted).toBe(flowing);

    act(() => hook.result.current.unmute());
    clock.advance(3 * FRAME_MS);
    const resumed = socket().audio().length;
    expect(resumed).toBeGreaterThan(muted);
  });
});

// ---------------------------------------------------------------------------------------------
// The wire is faked; the source and the hook are the shipped ones.
// ---------------------------------------------------------------------------------------------

/** The slice of WebSocket the hook uses, with a hand to deliver server frames. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
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
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
  /** The audio payloads sent so far (the `close` control frame is excluded). */
  audio(): string[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type: string; audio?: string })
      .filter((frame) => frame.type === 'audio')
      .map((frame) => frame.audio!);
  }
}

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
