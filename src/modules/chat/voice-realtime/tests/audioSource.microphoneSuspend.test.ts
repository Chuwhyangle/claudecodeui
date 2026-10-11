import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { microphoneAudioSource, type VoiceRealtimeMicSuspension } from '@/modules/chat/voice-realtime/audioSource';

/**
 * (this task) AC1 — the microphone source answers a browser-forced `AudioContext` suspension with a
 * `resume()`, and reports each suspension/resume outcome to its caller.
 *
 * WHY A SEPARATE FILE FROM `pacedAudioSource.test.tsx`. That file's `FakeAudioContext` models only
 * the DECODE the two file sources call. `microphoneAudioSource()` is the one source that builds a
 * real capture graph (`getUserMedia` → `AudioWorkletNode` → destination) and reacts to the
 * context's own `state`, so its fake has to carry `state` / `addEventListener('statechange')` /
 * `resume()`. The shipped `microphoneAudioSource()` runs against it unchanged — nothing here stubs
 * the source itself, only the browser APIs it drives.
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/audioSource.microphoneSuspend.test.ts
 */

// The one import that reaches the bundler's `?worker&url` transform; the capture path only reads the
// URL string, so a plain stub is what the source needs. Everything else is the real module.
vi.mock('@/modules/chat/audio/voiceFrameProcessorUrl', () => ({
  voiceFrameProcessorUrl: () => 'blob:voice-frame-processor',
}));

/** Every context the source constructed, so a case can suspend the live one and read its resume calls. */
const contexts: FakeAudioContext[] = [];

/**
 * The `AudioContext` jsdom does not have, carrying the pieces the microphone capture path touches.
 * `resume()` really brings the context back — it moves the state to `'running'` and fires the
 * `statechange` listeners — because that is what a browser does, and it is what the source's
 * `.then` reads as "capture is live again".
 */
class FakeAudioContext {
  state: AudioContextState = 'running';
  sampleRate = 16_000;
  destination: object = {};
  audioWorklet = { addModule: async (): Promise<void> => undefined };
  private readonly stateChangeListeners: Array<() => void> = [];

  constructor() {
    contexts.push(this);
  }

  createGain(): { gain: { value: number }; connect: () => void } {
    return { gain: { value: 0 }, connect: () => undefined };
  }

  createMediaStreamSource(): { connect: () => void } {
    return { connect: () => undefined };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async resume(): Promise<void> {
    this.emitState('running');
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.stateChangeListeners.push(listener);
  }

  /** Test-only: move the context to `state` and fire the `statechange` listeners a browser would. */
  emitState(state: AudioContextState): void {
    this.state = state;
    for (const listener of this.stateChangeListeners) listener();
  }
}

/** The minimal `AudioWorkletNode`: the source only attaches a `port.onmessage` handler to it. */
class FakeAudioWorkletNode {
  port = { onmessage: null as ((message: unknown) => void) | null };
  connect(): void {
    /* inert */
  }
}

beforeEach(() => {
  contexts.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AC1: the microphone source resumes a suspended capture context', () => {
  test('a suspended context has resume() called and is reported as suspended then live again', async () => {
    const reports: VoiceRealtimeMicSuspension[] = [];
    const source = microphoneAudioSource();
    await source.start(
      () => undefined,
      (event) => reports.push(event),
    );

    const context = contexts[0]!;
    expect(context.state).toBe('running');
    const resumeSpy = vi.spyOn(context, 'resume');

    // The browser suspends the context on its own, with no page navigation: exactly the state the
    // operator's evidence shows (frames stop, nothing on screen to say so).
    context.emitState('suspended');
    // `resume()` resolves in a microtask — let the `.then` that reports "live again" run.
    await Promise.resolve();
    await Promise.resolve();

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ suspended: true });
    expect(reports[reports.length - 1]).toMatchObject({ suspended: false });
    // The context really came back, so the worklet will deliver frames again.
    expect(context.state).toBe('running');

    source.stop();
  });

  test('a statechange that is not a suspension reports nothing and never resumes', async () => {
    const reports: VoiceRealtimeMicSuspension[] = [];
    const source = microphoneAudioSource();
    await source.start(
      () => undefined,
      (event) => reports.push(event),
    );

    const context = contexts[0]!;
    const resumeSpy = vi.spyOn(context, 'resume');
    // A `running` statechange is not a suspension: the source must not report or resume on it.
    context.emitState('running');
    await Promise.resolve();

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(reports).toEqual([]);

    source.stop();
  });

  test('a failed resume is reported as still-suspended and does not reject the capture', async () => {
    const reports: VoiceRealtimeMicSuspension[] = [];
    const source = microphoneAudioSource();
    await source.start(
      () => undefined,
      (event) => reports.push(event),
    );

    const context = contexts[0]!;
    vi.spyOn(context, 'resume').mockRejectedValueOnce(new Error('NotAllowedError'));
    context.emitState('suspended');
    await Promise.resolve();
    await Promise.resolve();

    // The failure detail reaches the caller (which logs it) as a still-suspended state; nothing is
    // thrown back into the capture promise.
    expect(reports[0]).toMatchObject({ suspended: true });
    expect(reports[reports.length - 1]!.suspended).toBe(true);
    expect(reports[reports.length - 1]!.detail).toContain('NotAllowedError');

    source.stop();
  });
});
