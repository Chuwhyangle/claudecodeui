import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  microphoneAudioSource,
  releaseWarmMicrophoneSource,
  warmMicrophoneSource,
  type VoiceRealtimeAudioFrame,
} from '@/modules/chat/voice-realtime/audioSource';

/**
 * (this task) AC1 — the Live Voice microphone can be PRE-WARMED, and a start after a warm does not
 * repeat the permission prompt, the context construction or the worklet bundle load.
 *
 * WHY THIS FILE AND THIS HARNESS. The claim is about `microphoneAudioSource()` itself, so the
 * shipped source runs here unchanged; only the browser APIs it drives are fakes. The capture graph
 * needs `getUserMedia`, `AudioContext.audioWorklet.addModule`, and an `AudioWorkletNode` whose port
 * can deliver one frame — the same FakeAudioContext shape `audioSource.microphoneSuspend.test.ts`
 * established, extended with a call counter and a node that keeps its `port` reachable.
 *
 * The pre-warm is module-level state (one tap's acquisition is adopted by the hook's later start),
 * so every case releases it first: cases must not read a cache a previous one left behind.
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/audioSource.warm.test.ts
 */

// The one import that reaches the bundler's `?worker&url` transform; the capture path only reads
// the URL string, so a plain stub is what the source needs. Everything else is the real module.
vi.mock('@/modules/chat/audio/voiceFrameProcessorUrl', () => ({
  voiceFrameProcessorUrl: () => 'blob:voice-frame-processor',
}));

/** How many times each slow leg ran, across the whole file. */
const calls = { getUserMedia: 0, addModule: 0, nodes: 0 };

/** Every worklet node constructed, so a case can make the live one deliver a frame. */
const nodes: FakeAudioWorkletNode[] = [];

/** The minimal capture `AudioContext`: only the members `microphoneAudioSource` touches. */
class FakeAudioContext {
  state: AudioContextState = 'running';
  sampleRate = 16_000;
  destination: object = {};
  audioWorklet = {
    addModule: async (): Promise<void> => {
      calls.addModule += 1;
    },
  };

  createGain(): { gain: { value: number }; connect: () => void } {
    return { gain: { value: 0 }, connect: () => undefined };
  }

  createMediaStreamSource(): { connect: () => void } {
    return { connect: () => undefined };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  addEventListener(): void {
    /* the suspension path is covered by audioSource.microphoneSuspend.test.ts */
  }
}

/** The minimal `AudioWorkletNode`: a countable constructor and a port the source attaches to. */
class FakeAudioWorkletNode {
  port = { onmessage: null as ((message: { data: unknown }) => void) | null };

  constructor() {
    calls.nodes += 1;
    nodes.push(this);
  }

  connect(): void {
    /* inert */
  }
}

beforeEach(() => {
  releaseWarmMicrophoneSource();
  calls.getUserMedia = 0;
  calls.addModule = 0;
  calls.nodes = 0;
  nodes.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        calls.getUserMedia += 1;
        return { getTracks: () => [{ stop: () => undefined }] };
      },
    },
  });
});

afterEach(() => {
  releaseWarmMicrophoneSource();
  vi.unstubAllGlobals();
});

describe('AC1: the microphone warm-up and its reuse', () => {
  test('warming performs getUserMedia, addModule and node construction exactly once', async () => {
    await warmMicrophoneSource();

    expect(calls).toEqual({ getUserMedia: 1, addModule: 1, nodes: 1 });
  });

  test('a start after a warm reuses the acquisition and delivers its first frame', async () => {
    await warmMicrophoneSource();
    const source = microphoneAudioSource();
    const frames: VoiceRealtimeAudioFrame[] = [];
    await source.start((frame) => frames.push(frame));

    // The legs that used to run inside `start()` already ran during the warm: start only wired
    // the graph onto the acquired stream/context/node.
    expect(calls).toEqual({ getUserMedia: 1, addModule: 1, nodes: 1 });

    // The node the graph was wired to is the warmed one, and its first frame reaches `onFrame`
    // directly — no second node, no re-acquisition between the two.
    const worklet = nodes[0]!;
    worklet.port.onmessage?.({ data: { type: 'pcm', samples: new Float32Array([0.5]) } });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.samples).toEqual(new Float32Array([0.5]));
    expect(frames[0]!.sourceRate).toBe(16_000);

    source.stop();
  });

  test('a start without a warm still acquires and delivers frames on its own', async () => {
    const source = microphoneAudioSource();
    const frames: VoiceRealtimeAudioFrame[] = [];
    await source.start((frame) => frames.push(frame));

    expect(calls).toEqual({ getUserMedia: 1, addModule: 1, nodes: 1 });

    nodes[0]!.port.onmessage?.({ data: { type: 'pcm', samples: new Float32Array([0.25]) } });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.samples).toEqual(new Float32Array([0.25]));

    source.stop();
  });
});
