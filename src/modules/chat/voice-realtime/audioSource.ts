/**
 * One shared audio-frame source for `useVoiceRealtimeSession` (GOAL-031 / AC-315):
 * the live microphone and an uploaded fixture file both end up producing the same
 * {@link VoiceRealtimeAudioFrame} shape, so the socket-framing and PCM16 encoding
 * in the hook runs identically regardless of where the audio came from. CI drives
 * {@link fileAudioSource} against a fixed corpus; a real microphone is only
 * exercised by AC-312's own human-only manual smoke test.
 *
 * `VoiceRealtimeAudioSource` is deliberately the same shape `VoiceCaptureEngine`
 * already uses in `src/modules/chat/hooks/useVoiceInput.ts` for that module's own
 * mic/test-injection split — this module reuses the pattern rather than inventing
 * a second one for the same problem.
 *
 * Used by `useVoiceRealtimeSession`, this module's only consumer of either source.
 */
import { VOICE_FRAME_PROCESSOR_NAME, type VoiceFrameMessage } from '@/modules/chat/audio/voiceFrameProcessor';
import { voiceFrameProcessorUrl } from '@/modules/chat/audio/voiceFrameProcessorUrl';

/** One captured frame: raw samples at the rate they were produced. */
export type VoiceRealtimeAudioFrame = { samples: Float32Array; sourceRate: number };

/** Where `useVoiceRealtimeSession` pulls frames from — abstracts mic vs. upload. */
export type VoiceRealtimeAudioSource = {
  /** Starts producing frames, invoking `onFrame` for each one until `stop()`. */
  start(onFrame: (frame: VoiceRealtimeAudioFrame) => void): Promise<void>;
  /** Releases whatever the source holds (a microphone stream, a decode context). Safe to call twice. */
  stop(): void;
};

/** The window a file source chunks into, matching the real worklet's own frame size. */
const FILE_FRAME_SECONDS = 0.02;

/** The same window as {@link FILE_FRAME_SECONDS}, in the milliseconds the paced source schedules on. */
const FILE_FRAME_MS = FILE_FRAME_SECONDS * 1000;

/**
 * The real microphone, via `getUserMedia` and the same `AudioWorklet` the
 * dictation composer loads. Exercised by a human in AC-312's manual smoke test;
 * CI never calls `start()` on this source.
 */
export function microphoneAudioSource(): VoiceRealtimeAudioSource {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let worklet: AudioWorkletNode | null = null;

  return {
    async start(onFrame) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      context = new AudioContext();
      const processorUrl = voiceFrameProcessorUrl();
      if (!processorUrl) {
        throw new Error('AudioWorklet is unavailable in this browser.');
      }
      await context.audioWorklet.addModule(processorUrl);
      worklet = new AudioWorkletNode(context, VOICE_FRAME_PROCESSOR_NAME, {
        processorOptions: { sampleRate: context.sampleRate },
      });
      const activeContext = context;
      worklet.port.onmessage = (message: MessageEvent<VoiceFrameMessage>) => {
        const data = message.data;
        if (!data || data.type !== 'pcm') {
          return;
        }
        onFrame({ samples: data.samples, sourceRate: activeContext.sampleRate });
      };
      // A zero-gain sink pulls the graph without the microphone reaching the speakers.
      const silent = context.createGain();
      silent.gain.value = 0;
      context.createMediaStreamSource(stream).connect(worklet);
      worklet.connect(silent);
      silent.connect(context.destination);
    },
    stop() {
      if (worklet) {
        worklet.port.onmessage = null;
        worklet = null;
      }
      if (context) {
        try {
          void context.close();
        } catch {
          /* a context already closed */
        }
        context = null;
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        stream = null;
      }
    },
  };
}

/** Averages every channel down to one, for a decoded file that is not already mono. */
function mixToMono(decoded: AudioBuffer): Float32Array {
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const mono = new Float32Array(decoded.length);
  for (let sample = 0; sample < decoded.length; sample += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[sample] ?? 0;
    }
    mono[sample] = sum / channels.length;
  }
  return mono;
}

/**
 * An uploaded audio file, decoded and replayed as the same frame shape the
 * microphone produces. This is AC-315's fixed-corpus path: a Playwright e2e test
 * uploads a known fixture file and reads the proxy's reaction, with no browser
 * microphone permission and no live `getUserMedia` call involved anywhere in the
 * run.
 *
 * Frames are chunked at {@link FILE_FRAME_SECONDS} (the worklet's own window) and
 * dispatched with a microtask yield between chunks, so `stop()` can interrupt a
 * long fixture mid-playback instead of the whole file reaching `onFrame`
 * synchronously in one burst.
 */
export function fileAudioSource(file: File): VoiceRealtimeAudioSource {
  let cancelled = false;
  let decodeContext: AudioContext | null = null;

  return {
    async start(onFrame) {
      const buffer = await file.arrayBuffer();
      const context = new AudioContext();
      decodeContext = context;
      const decoded = await context.decodeAudioData(buffer);
      const samples = decoded.numberOfChannels === 1 ? decoded.getChannelData(0) : mixToMono(decoded);
      const sourceRate = decoded.sampleRate;
      const frameSize = Math.max(1, Math.round(sourceRate * FILE_FRAME_SECONDS));

      for (let offset = 0; offset < samples.length && !cancelled; offset += frameSize) {
        const chunk = samples.subarray(offset, Math.min(offset + frameSize, samples.length));
        onFrame({ samples: chunk, sourceRate });
        await Promise.resolve();
      }

      if (decodeContext === context) {
        decodeContext = null;
        void context.close().catch(() => undefined);
      }
    },
    stop() {
      cancelled = true;
      if (decodeContext) {
        const context = decodeContext;
        decodeContext = null;
        void context.close().catch(() => undefined);
      }
    },
  };
}

/**
 * How {@link pacedFileAudioSource} schedules its frames: `schedule(delayMs, run)` must arrange
 * for `run` to be called `delayMs` from now. The default is `setTimeout`, so playback runs in
 * real wall-clock time; a test injects a controlled clock and steps it to read the arrival
 * times deterministically instead of waiting on the wall clock.
 */
export type PacedAudioSourceOptions = {
  schedule?: (delayMs: number, run: () => void) => unknown;
};

/**
 * The default {@link PacedAudioSourceOptions.schedule}: one `setTimeout` per frame.
 *
 * A separate binding (not an inline `??`) so the source has exactly one place that names the
 * production scheduler, keeping it readably distinct from the injected test clock.
 */
const defaultSchedule = (delayMs: number, run: () => void): unknown => setTimeout(run, delayMs);

/**
 * A file source that replays on the REAL timeline and can be driven while it plays.
 *
 * The two controls {@link fileAudioSource} cannot offer, because it produces the whole fixture
 * in one microtask burst:
 *  · `pause()` / `resume()` — hold the fixture and emit SILENCE frames in its place. This is NOT
 *    the hook's Mute: Mute is the CONSUMER dropping frames it still receives
 *    (`useVoiceRealtimeSession`'s `mutedRef`), while `pause()` is the SOURCE having no sound to
 *    give. They are not interchangeable — a paused source keeps its sample timeline moving
 *    (`atSample` advances by one frame each tick, so a downstream `LiveSegmenter.push` never sees
 *    the gap it throws on), which a "stop sending" Mute cannot express.
 *  · `stop()` — end playback immediately, mid-fixture.
 */
export type PacedAudioSource = VoiceRealtimeAudioSource & {
  pause(): void;
  resume(): void;
};

/**
 * An uploaded fixture replayed one frame at a time on the REAL timeline, with playback that can
 * be paused, resumed or stopped part-way through.
 *
 * WHY THIS IS A SECOND SOURCE AND NOT A CHANGE TO {@link fileAudioSource}. That source yields
 * between chunks with a MICROTASK (`await Promise.resolve()`), so the whole fixture lands inside
 * a single macrotask — and that is exactly what AC-315's handshake-race guard depends on: the
 * fixture reaches the still-connecting socket's `pendingFramesRef` before `state:open`, which is
 * what makes the guard falsifiable. Replacing that yield with a macrotask would let the socket
 * open first and turn the guard green against nothing (measured 2026-10-09). So the real-time
 * cadence lives here, beside it, and `fileAudioSource`'s timing is deliberately left untouched.
 *
 * Frame k is emitted at script time `k × FILE_FRAME_MS` — one frame of audio every one frame's
 * worth of wall time, the fixture's own 20 ms cadence. The optional `schedule` is the seam a
 * test uses to read those arrival times off a controlled clock; production gets `setTimeout`.
 *
 * Selected only by `useVoiceRealtimeSession.startWithFile` when its caller passes `options`; no
 * production UI does, so the default upload path is unchanged.
 */
export function pacedFileAudioSource(file: File, options: PacedAudioSourceOptions = {}): PacedAudioSource {
  const schedule = options.schedule ?? defaultSchedule;
  let cancelled = false;
  let paused = false;
  let decodeContext: AudioContext | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  return {
    async start(onFrame) {
      const buffer = await file.arrayBuffer();
      const context = new AudioContext();
      decodeContext = context;
      const decoded = await context.decodeAudioData(buffer);
      if (cancelled) {
        void context.close().catch(() => undefined);
        return;
      }
      const samples = decoded.numberOfChannels === 1 ? decoded.getChannelData(0) : mixToMono(decoded);
      const sourceRate = decoded.sampleRate;
      const frameSize = Math.max(1, Math.round(sourceRate * FILE_FRAME_SECONDS));
      // One frame of digital silence, reused for every pause frame: pausing holds the fixture
      // (its cursor does not advance) but keeps the sample timeline moving, so `atSample` stays
      // continuous and no gap is ever presented to the segmenter.
      const silence = new Float32Array(frameSize);
      // The fixture cursor. It advances only while playing, so a resume continues from the exact
      // sample `pause()` held it at — the decoded audio is continuous across a pause.
      let offset = 0;
      const finish = () => {
        if (decodeContext === context) {
          decodeContext = null;
          void context.close().catch(() => undefined);
        }
        resolveDone();
      };
      const tick = () => {
        if (cancelled) {
          return;
        }
        if (paused) {
          onFrame({ samples: silence, sourceRate });
        } else {
          if (offset >= samples.length) {
            finish();
            return;
          }
          const chunk = samples.subarray(offset, Math.min(offset + frameSize, samples.length));
          onFrame({ samples: chunk, sourceRate });
          offset += chunk.length;
          if (offset >= samples.length) {
            finish();
            return;
          }
        }
        schedule(FILE_FRAME_MS, tick);
      };
      // Frame 0 is due now; every later frame one frame-time after it, so frame k arrives at k
      // frame-times and the fixture plays at its own real-time pace.
      schedule(0, tick);
      await done;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    stop() {
      cancelled = true;
      if (decodeContext) {
        const context = decodeContext;
        decodeContext = null;
        void context.close().catch(() => undefined);
      }
      resolveDone();
    },
  };
}
