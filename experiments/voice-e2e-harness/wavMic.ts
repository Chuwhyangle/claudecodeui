/**
 * A fake microphone that plays a REAL corpus WAV into the Live Voice capture chain.
 *
 * WHY THIS EXISTS (E0 / voice-output-e2e-harness). The repository already has two ways to put
 * audio in front of the product:
 *
 *   · `e2e/voiceRealtimeFakeMic.ts` — a synthetic timeline (sine/noise) pushed on the same
 *     worklet message port the real capture uses. It is the deterministic harness every
 *     continuous-wire criterion is written against, but it can only play an envelope it
 *     generates; it cannot replay a frozen recording.
 *   · Chromium's `--use-file-for-fake-audio-capture` — a real device stand-in, used by the
 *     dictation/ASR specs. It is a real `getUserMedia` capture path, but it needs the audio file
 *     at browser launch and cannot be driven frame-by-frame from the spec.
 *
 * This module is the missing middle: it accepts the PCM samples of a real recording and pushes
 * them through the SAME fake Web Audio graph the continuous-wire harness installs — 100 ms frames
 * on a real timer, into the app's own worklet port. Everything downstream (the client's encoder,
 * the `/voice-realtime` socket, the proxy, the relay) is the shipped code, so a pass here is a
 * reading of the product's capture-to-socket path, not of a fixture's private convention.
 *
 * IT IS DELIBERATELY A SIBLING OF `e2e/voiceRealtimeFakeMic.ts`, NOT A REWRITE OF IT. The two
 * differ in one input: that one synthesises the timeline, this one is handed samples. The graph
 * shape — `AudioContext`, `AudioWorkletNode`, `navigator.mediaDevices` — is kept identical
 * because it is what the app's `acquireMicrophone()` drives; changing it here would make this
 * harness measure a capture graph the rest of the suite never exercises.
 *
 * THE FRAME LEDGER IS LOAD-BEARING. `atSample` advances by one frame's worth of samples per push,
 * exactly as the real worklet does. A player that pushed samples without moving the ledger would
 * trip the client's own `LiveSegmenter.push` ("chunk arrived after …") on its first frame.
 */
import type { BrowserContext, Page } from '@playwright/test';

/** What the runner derives for one sample: the PCM16 window, base64-encoded, and its rate. */
export type WavMicPlan = {
  /** Mono 16-bit PCM, little-endian, base64 — the exact window to play. */
  pcm16Base64: string;
  /** Sample rate of the PCM above. The corpus is 16 kHz. */
  sampleRate: number;
  /** Frame cadence, in ms. 100 ms is the cadence the sibling fake mic uses. */
  frameMs?: number;
};

/** What the page-side player exposes on `window.__voiceWavMic`. */
export type WavMicHandle = {
  /** Plays the window from the beginning, resolving when its last frame has been pushed. */
  play(): Promise<void>;
  /** Frames actually pushed — the non-vacuity reading. */
  frames(): number;
  /** Samples actually pushed. */
  samplesPushed(): number;
  /** Whether the player is mid-window. */
  playing(): boolean;
};

/**
 * Installs the fake capture graph and the WAV player into every page of `context`.
 *
 * `addInitScript`, not `page.evaluate`: the app acquires the microphone while it boots (the warm
 * path), so the globals have to exist before the app's first script runs.
 */
export async function installWavMic(context: BrowserContext, plan: WavMicPlan): Promise<void> {
  await context.addInitScript(
    ({ pcm16Base64, rate, frameMs }: { pcm16Base64: string; rate: number; frameMs: number }) => {
      // ── decode the window once, up front ────────────────────────────────────────────────────
      // The exact quantization the client's encoder will apply is `Math.trunc(v * 0x7fff)` for
      // non-negative and `Math.trunc(v * 0x8000)` for negative; here we only have to get back to
      // the float the real worklet would have delivered, which is `int16 / 32768`.
      const binary = atob(pcm16Base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const view = new DataView(bytes.buffer);
      const samples = new Float32Array(bytes.length / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = view.getInt16(index * 2, true) / 32768;
      }

      type Port = { port: { onmessage: ((message: unknown) => void) | null; postMessage: () => void } };
      const state: {
        node: Port | null;
        atSample: number;
        cursor: number;
        frames: number;
        playing: boolean;
        timer: ReturnType<typeof setInterval> | null;
      } = { node: null, atSample: 0, cursor: 0, frames: 0, playing: false, timer: null };

      const frameSamples = Math.max(1, Math.round((rate * frameMs) / 1000));

      /** Pushes the next frame. Answers `false` when the window is exhausted. */
      const pushFrame = (): boolean => {
        const node = state.node;
        if (node === null) return true; // the capture is not connected YET — keep waiting
        const end = Math.min(state.cursor + frameSamples, samples.length);
        if (end <= state.cursor) return false;
        const frame = samples.slice(state.cursor, end);
        node.port.onmessage?.({ data: { type: 'pcm', samples: frame, atSample: state.atSample } });
        state.atSample += frame.length;
        state.frames += 1;
        state.cursor = end;
        return true;
      };

      const totalMs = (samples.length / rate) * 1000;
      const player = {
        play(): Promise<void> {
          if (state.playing) throw new Error('the WAV microphone is already playing');
          state.playing = true;
          return new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => {
              if (state.timer !== null) clearInterval(state.timer);
              state.timer = null;
              state.playing = false;
              reject(
                new Error(
                  `the WAV microphone pushed ${state.frames} frames and never finished within ${totalMs + 20_000} ms`,
                ),
              );
            }, totalMs + 20_000);
            const tick = (): void => {
              if (pushFrame()) return;
              clearTimeout(deadline);
              if (state.timer !== null) clearInterval(state.timer);
              state.timer = null;
              state.playing = false;
              resolve();
            };
            state.timer = setInterval(tick, frameMs);
            tick();
          });
        },
        frames: () => state.frames,
        samplesPushed: () => state.atSample,
        playing: () => state.playing,
      };

      (window as unknown as { __voiceWavMic: typeof player }).__voiceWavMic = player;

      class FakeWorkletNode {
        port: { onmessage: ((message: unknown) => void) | null; postMessage: () => void };
        constructor() {
          this.port = { onmessage: null, postMessage: () => undefined };
          state.node = this as unknown as Port;
        }

        connect() {
          /* the graph is inert; the player drives the port directly */
        }
      }

      // The capture `AudioContext`. `audioSource.ts` subscribes with `addEventListener('statechange')`
      // and calls `resume()`, so both must exist or the mic source throws inside its own async body.
      class FakeAudioContext {
        sampleRate = rate;
        destination = {};
        state = 'running';
        audioWorklet = { addModule: async () => undefined };

        createGain() {
          return { gain: { value: 0 }, connect: () => undefined };
        }

        createMediaStreamSource() {
          return { connect: () => undefined };
        }

        close() {
          return Promise.resolve();
        }

        addEventListener() {
          /* no statechange is driven: the capture stays running for the whole window */
        }

        resume() {
          return Promise.resolve();
        }
      }

      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
      (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
      });
    },
    { pcm16Base64: plan.pcm16Base64, rate: plan.sampleRate, frameMs: plan.frameMs ?? 100 },
  );
}

/** Plays the window on `page`, resolving when its last frame has been pushed. */
export async function playWavMic(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __voiceWavMic: WavMicHandle }).__voiceWavMic.play(),
  );
}

/** How many frames the page pushed — the non-vacuity reading. */
export async function wavMicFrames(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __voiceWavMic: WavMicHandle }).__voiceWavMic.frames(),
  );
}

/** How many samples the page pushed, and whether the player is still mid-window. */
export async function wavMicReading(page: Page): Promise<{ frames: number; samples: number; playing: boolean }> {
  return page.evaluate(() => {
    const handle = (window as unknown as { __voiceWavMic: WavMicHandle }).__voiceWavMic;
    return { frames: handle.frames(), samples: handle.samplesPushed(), playing: handle.playing() };
  });
}
