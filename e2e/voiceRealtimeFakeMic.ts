/**
 * The deterministic fake microphone, and the timeline the continuous-experience spec plays through it.
 *
 * WHY THIS FILE EXISTS. The existing Live Voice specs each inline their own capture shim and drive it
 * with `window.__voiceFake.speak(seconds)` — ONE burst per call, with no notion of a pause, a gap or a
 * background floor. A continuous-experience reading needs all three: the endpoint's own detector is
 * what ends an utterance under `server_vad`, so the SHAPE of the sound between sentences is the
 * independent variable. A timeline that cannot say "1.5 s of silence here" cannot ask whether a
 * mid-thought pause splits a sentence, and one that cannot say "the hum continues, quietly" cannot ask
 * whether a noise floor opens an utterance nobody spoke.
 *
 * WHAT IT PLAYS. {@link CONTINUOUS_EXPERIENCE_TIMELINE}: five spoken runs, the gaps between them
 * (0.6–2.2 s), a 1.5 s mid-thought pause, a 「嗯」 fragment that carries no request, a correction, and
 * a background hum under the gate. Each segment is labelled with what it means, and the labels are
 * carried into the spec's reading table.
 *
 * IT PLAYS IN REAL TIME, ONE FRAME AT A TIME. The whole timeline is rendered to samples up front and
 * then pushed on a `setInterval` at {@link FAKE_MIC_FRAME_MS} — the capture cadence the real worklet
 * delivers at. That is deliberate and it is what makes the reading a reading of the PRODUCT: the app
 * receives audio while it is streaming, exactly as a microphone gives it, instead of one synchronous
 * burst that no capture path could ever produce. It is also what a `wall-clock` detector needs — a
 * clock can only be read while the wire is quiet if the wire is quiet for a while.
 *
 * THE AMPLITUDES ARE THE CONTRACT. Speech peaks near 0.9 and the hum near 0.35, so the shipped
 * `session.turn_detection.threshold` of 0.5 separates them: what the endpoint hears as speech is
 * decided by the same gate the product configures, not by a stand-in's private convention. The
 * syllable-shaped envelope stays strictly above the gate, so a VAD can never hear a word as a pause.
 *
 * NOTHING HERE READS A CLOCK OR A NETWORK. It is an `AudioContext`, an `AudioWorkletNode` and a
 * `getUserMedia` that never touch a device, installed as an init script the same way the sibling
 * specs install theirs.
 */
import type { BrowserContext, Page } from '@playwright/test';

/** What one stretch of the timeline is. */
export type FakeMicSegmentKind =
  /** A spoken run: syllable-shaped tone above the gate. */
  | 'speech'
  /** Digital zero. */
  | 'silence'
  /** A background floor strictly BELOW the gate — present sound that must not read as speech. */
  | 'noise';

/** One stretch of the timeline: how long it lasts, and what it is there to ask. */
export type FakeMicSegment = {
  kind: FakeMicSegmentKind;
  /** How long it lasts, in seconds of audio. */
  seconds: number;
  /** What this segment is for — carried into the reading table, never sent anywhere. */
  label: string;
};

/** The rate the whole timeline is rendered at, and the rate the fake capture context claims. */
const FAKE_MIC_SAMPLE_RATE = 16_000;

/**
 * How much audio one pushed frame carries. 100 ms — a tenth of the real worklet's 20 ms window, and
 * still far shorter than the 400 ms silence the endpoint is configured to wait for, so the detector's
 * resolution is never the frame size.
 */
const FAKE_MIC_FRAME_MS = 100;

/** Speech peaks here, times the envelope's own 0.7–1.0 swing: 0.63–0.9, always over the 0.5 gate. */
const SPEECH_AMPLITUDE = 0.9;
/** The background floor: 0.35, comfortably UNDER the 0.5 gate, so it is never heard as speech. */
const NOISE_AMPLITUDE = 0.35;

/**
 * THE TIMELINE. Five spoken runs, and between them the shapes the experience criteria ask about.
 *
 *  · five sentences — 把 server 的日志贴出来 / 嗯…那个… / 我想想 / 然后跑一下测试 / 不对，改成跑 lint;
 *  · gaps of 0.9, 1.2, 1.5, 2.2 and 0.6 seconds, every one inside the 0.3–3 s band;
 *  · a 「嗯…那个…」 run that carries no request at all (X-2: heard, and not delivered);
 *  · a 1.5 s pause in the MIDDLE of one thought, then the rest of it — so whether Claude receives one
 *    message or two is a fact about the product, not about the script (X-4);
 *  · a correction after it (X-5);
 *  · a hum between two runs, below the gate, that must not open an utterance.
 *
 * The gap lengths are load-bearing, not decorative: a gap shorter than the endpoint's
 * `silence_duration_ms` would leave an utterance open across it, and the utterance count the reading
 * table is indexed by would no longer be what the labels say.
 */
export const CONTINUOUS_EXPERIENCE_TIMELINE: readonly FakeMicSegment[] = [
  { kind: 'speech', seconds: 1.2, label: '第一句：把 server 的日志贴出来' },
  { kind: 'silence', seconds: 0.9, label: '句间停顿 0.9 s' },
  { kind: 'speech', seconds: 1.0, label: '「嗯…那个…」——没有请求的一句' },
  { kind: 'noise', seconds: 1.2, label: '句间 1.2 s，背景噪声在门限之下' },
  { kind: 'speech', seconds: 0.8, label: '第三句前半：我想想' },
  { kind: 'silence', seconds: 1.5, label: '句中停顿 1.5 s' },
  { kind: 'speech', seconds: 1.2, label: '第三句后半：然后跑一下测试' },
  { kind: 'silence', seconds: 2.2, label: '句间停顿 2.2 s' },
  { kind: 'speech', seconds: 1.0, label: '修正：不对，改成跑 lint' },
  { kind: 'silence', seconds: 0.6, label: '句间停顿 0.6 s' },
  { kind: 'noise', seconds: 0.5, label: '收尾的背景噪声' },
];

/** What the page-side timeline player exposes on `window`. */
export type FakeMicTimelineHandle = {
  /**
   * Plays the timeline from the beginning, resolving when its last frame has been pushed.
   *
   * It WAITS for the capture graph to exist: the worklet node is constructed when the app's
   * microphone source starts, so a `play()` racing the button click must not push into nothing. It
   * REJECTS on a deadline rather than resolving quietly, so a run where the mic never came up fails
   * as a run where the mic never came up.
   */
  play(): Promise<void>;
  /** Every segment actually pushed, in order, as the page recorded it. */
  pushed(): Array<{ kind: FakeMicSegmentKind; seconds: number; label: string }>;
  /** How many frames have been pushed so far. */
  frames(): number;
};

/**
 * Installs the fake capture graph and the timeline player into every page of `context`.
 *
 * Two init scripts run per page when a spec installs this beside its own; order between them does not
 * matter, because this one touches only the audio globals.
 */
export async function installFakeMic(
  context: BrowserContext,
  timeline: readonly FakeMicSegment[] = CONTINUOUS_EXPERIENCE_TIMELINE,
): Promise<void> {
  await context.addInitScript(
    ({ segments, rate, frameMs, speechAmplitude, noiseAmplitude }) => {
      // ── the whole timeline, rendered to samples up front ─────────────────────────────────────
      // Rendered once, then sliced by the player: a timeline whose samples were generated during
      // playback would depend on how the scheduler interleaved the ticks, and the same seed would
      // not give the same audio.
      const samples: number[] = [];
      type Span = { kind: string; seconds: number; label: string; from: number; to: number };
      const spans: Span[] = [];
      for (const segment of segments) {
        const count = Math.max(1, Math.round(segment.seconds * rate));
        const from = samples.length;
        for (let index = 0; index < count; index += 1) {
          if (segment.kind === 'silence') {
            samples.push(0);
            continue;
          }
          if (segment.kind === 'noise') {
            samples.push(noiseAmplitude * Math.sin((2 * Math.PI * 97 * index) / rate));
            continue;
          }
          // A syllable-shaped envelope over a 180 Hz carrier. The envelope swings between 0.7 and 1.0
          // — NEVER through zero — so no window of a spoken run can fall under the gate and be heard
          // as a pause. (The sibling specs' 0.5±0.5 envelope does cross zero; that shape exists to
          // defeat the SEGMENTED relay's percentile noise floor, which is not the detector in play
          // here, and under this one it would insert a sub-gate window every 333 ms.)
          const envelope = 0.85 + 0.15 * Math.sin((2 * Math.PI * 3 * index) / rate);
          samples.push(speechAmplitude * envelope * Math.sin((2 * Math.PI * 180 * index) / rate));
        }
        spans.push({
          kind: segment.kind,
          seconds: segment.seconds,
          label: segment.label,
          from,
          to: samples.length,
        });
      }

      type Port = { port: { onmessage: ((message: unknown) => void) | null; postMessage: () => void } };
      const state: {
        node: Port | null;
        atSample: number;
        cursor: number;
        frames: number;
        pushed: Array<{ kind: string; seconds: number; label: string }>;
        playing: boolean;
        timer: ReturnType<typeof setInterval> | null;
      } = { node: null, atSample: 0, cursor: 0, frames: 0, pushed: [], playing: false, timer: null };

      /** Pushes the next frame. Answers `false` when the timeline is exhausted. */
      const pushFrame = (): boolean => {
        const node = state.node;
        if (node === null) return true; // the capture is not connected YET — keep waiting
        const end = Math.min(state.cursor + Math.round((rate * frameMs) / 1000), samples.length);
        if (end <= state.cursor) return false;
        const frame = new Float32Array(end - state.cursor);
        for (let index = state.cursor; index < end; index += 1) {
          frame[index - state.cursor] = samples[index] as number;
        }
        node.port.onmessage?.({ data: { type: 'pcm', samples: frame, atSample: state.atSample } });
        state.atSample += frame.length;
        state.frames += 1;
        // Which segment this frame belongs to, by its midpoint — so `pushed()` says what the page
        // actually played and not what the caller hoped it played.
        const middle = (state.cursor + end) / 2;
        const span = spans.find((candidate) => middle >= candidate.from && middle < candidate.to);
        if (span !== undefined && state.pushed[state.pushed.length - 1]?.label !== span.label) {
          state.pushed.push({ kind: span.kind, seconds: span.seconds, label: span.label });
        }
        state.cursor = end;
        return true;
      };

      const totalMs = (samples.length / rate) * 1000;
      const player = {
        play(): Promise<void> {
          if (state.playing) throw new Error('the fake timeline is already playing');
          state.playing = true;
          return new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => {
              if (state.timer !== null) clearInterval(state.timer);
              state.timer = null;
              reject(new Error(`the fake timeline pushed ${state.frames} frames and never finished within ${totalMs + 15000} ms`));
            }, totalMs + 15_000);
            const tick = (): void => {
              if (pushFrame()) return;
              clearTimeout(deadline);
              if (state.timer !== null) clearInterval(state.timer);
              state.timer = null;
              resolve();
            };
            state.timer = setInterval(tick, frameMs);
            tick();
          });
        },
        pushed: () => state.pushed.slice(),
        frames: () => state.frames,
      };

      (window as unknown as { __voiceFakeTimeline: typeof player }).__voiceFakeTimeline = player;

      class FakeWorkletNode {
        port: { onmessage: ((message: unknown) => void) | null; postMessage: () => void };
        constructor() {
          this.port = { onmessage: null, postMessage: () => undefined };
          state.node = this as unknown as Port;
        }

        connect() {
          /* the graph is inert; the timeline player drives the port directly */
        }
      }

      // The capture `AudioContext`. `audioSource.ts` subscribes with `addEventListener('statechange')`
      // and calls `resume()`, so both must exist or the mic source throws inside its own async body —
      // the failure that turns a capture bug into a silent "no audio" reading.
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
          /* no statechange is driven: the capture stays running for the whole timeline */
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
    {
      segments: timeline.map((segment) => ({ ...segment })),
      rate: FAKE_MIC_SAMPLE_RATE,
      frameMs: FAKE_MIC_FRAME_MS,
      speechAmplitude: SPEECH_AMPLITUDE,
      noiseAmplitude: NOISE_AMPLITUDE,
    },
  );
}

/** Plays the timeline on `page`, resolving when its last frame has been pushed. */
export async function playFakeMic(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __voiceFakeTimeline: FakeMicTimelineHandle }).__voiceFakeTimeline.play(),
  );
}

/** Every segment the page actually pushed, in order. */
export async function fakeMicPushed(
  page: Page,
): Promise<Array<{ kind: FakeMicSegmentKind; seconds: number; label: string }>> {
  return page.evaluate(() =>
    (window as unknown as { __voiceFakeTimeline: FakeMicTimelineHandle }).__voiceFakeTimeline.pushed(),
  );
}

/** How many frames the page pushed — the non-vacuity reading: a timeline that pushed nothing proves nothing. */
export async function fakeMicFrames(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __voiceFakeTimeline: FakeMicTimelineHandle }).__voiceFakeTimeline.frames(),
  );
}
