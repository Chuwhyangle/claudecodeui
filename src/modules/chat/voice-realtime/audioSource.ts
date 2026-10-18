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

/**
 * A browser-forced change to the microphone's capture `AudioContext`, reported by
 * {@link microphoneAudioSource}.
 *
 * A mobile browser suspends the capture context on its own — a notification sound, a Bluetooth
 * route change, a power policy — with no page navigation and no user action, and a suspended
 * context stops the worklet delivering frames: a microphone that goes dead silently. `suspended:
 * true` is that state (the source is attempting a resume); `suspended: false` is capture live
 * again. `detail` is the console-only explanation — the consumer logs it, and it is never
 * rendered as an error (see `useVoiceRealtimeSession`'s `micSuspended`).
 */
export type VoiceRealtimeMicSuspension = {
  suspended: boolean;
  detail: string;
};

/** Where `useVoiceRealtimeSession` pulls frames from — abstracts mic vs. upload. */
export type VoiceRealtimeAudioSource = {
  /**
   * Starts producing frames, invoking `onFrame` for each one until `stop()`.
   *
   * `onMicSuspension` is optional and only the microphone ever calls it: an uploaded file decodes
   * through an `AudioContext` the browser does not run a capture graph on, so the file sources
   * ignore the parameter entirely.
   */
  start(
    onFrame: (frame: VoiceRealtimeAudioFrame) => void,
    onMicSuspension?: (event: VoiceRealtimeMicSuspension) => void,
  ): Promise<void>;
  /** Releases whatever the source holds (a microphone stream, a decode context). Safe to call twice. */
  stop(): void;
};

/** The window a file source chunks into, matching the real worklet's own frame size. */
const FILE_FRAME_SECONDS = 0.02;

/** The same window as {@link FILE_FRAME_SECONDS}, in the milliseconds the paced source schedules on. */
const FILE_FRAME_MS = FILE_FRAME_SECONDS * 1000;

/**
 * The slow half of microphone capture, collected once: the permissioned stream, its capture
 * `AudioContext`, and the worklet node built on that context.
 *
 * It is a separate value from {@link VoiceRealtimeAudioSource} because the work is identical
 * whether it happens inside `start()` (the pre-warm-less path) or ahead of it
 * ({@link warmMicrophoneSource}, called on the Live Voice tap). Only the graph wiring and the
 * frame callback belong to a start; the permission prompt, the context construction and the
 * worklet bundle load — the legs that make the first "Connecting voice…" window long — are here.
 */
type MicrophoneAcquisition = {
  stream: MediaStream;
  context: AudioContext;
  worklet: AudioWorkletNode;
};

/** Releases everything {@link acquireMicrophone} opened. Safe on an acquisition that was never started. */
function releaseMicrophoneAcquisition(acquisition: MicrophoneAcquisition): void {
  acquisition.worklet.port.onmessage = null;
  try {
    void acquisition.context.close();
  } catch {
    /* a context already closed */
  }
  for (const track of acquisition.stream.getTracks()) {
    track.stop();
  }
}

/**
 * `getUserMedia` → capture `AudioContext` → worklet module load → `AudioWorkletNode`.
 *
 * Any failure after the stream opened releases that stream and the context before throwing:
 * a denied or unloadable worklet must not leave the microphone indicator on behind an error.
 */
async function acquireMicrophone(): Promise<MicrophoneAcquisition> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  const processorUrl = voiceFrameProcessorUrl();
  if (!processorUrl) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    try {
      void context.close();
    } catch {
      /* a context already closed */
    }
    throw new Error('AudioWorklet is unavailable in this browser.');
  }
  try {
    await context.audioWorklet.addModule(processorUrl);
    const worklet = new AudioWorkletNode(context, VOICE_FRAME_PROCESSOR_NAME, {
      processorOptions: { sampleRate: context.sampleRate },
    });
    return { stream, context, worklet };
  } catch (failure) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    try {
      void context.close();
    } catch {
      /* a context already closed */
    }
    throw failure;
  }
}

/**
 * The acquisition {@link warmMicrophoneSource} prepared, waiting for the first `start()` to take
 * ownership of it. Owned by no source until then: nothing can deliver frames from it, because the
 * node has no graph wired until a start connects one.
 */
let warmAcquisition: MicrophoneAcquisition | null = null;

/**
 * The warm-up still in flight, with the epoch it began under. Two taps while permission is being
 * answered share this one promise rather than opening the microphone twice. {@link warmEpoch}
 * tells a late result whether the cache it was preparing for has been released meanwhile.
 */
let warmInFlight: { promise: Promise<MicrophoneAcquisition>; epoch: number } | null = null;

/** Bumped by {@link releaseWarmMicrophoneSource}; an acquisition landing after a release is let go. */
let warmEpoch = 0;

/**
 * Begins the slow legs of microphone capture NOW, so a Live Voice connection opened moments later
 * finds the microphone already permissioned and its worklet already loaded.
 *
 * This is the fix for the first `Connecting voice…` window: before it, the permission, context and
 * worklet work all started inside `start()`, which the pane only reaches after the session
 * allocation (and after the socket begins dialing), so speech from those first seconds had no
 * capture to enter the hook's pending-frame buffer. Warming on the tap puts that work in parallel
 * with the allocation; `start()` then adopts the result and only wires the graph.
 *
 * Best-effort: a failed warm rejects nothing here — `start()` runs the same acquisition again and
 * reports the failure to the person through the hook's normal error path. Safe to call repeatedly;
 * a warm already cached or in flight is reused.
 */
export function warmMicrophoneSource(): Promise<void> {
  if (warmAcquisition) {
    return Promise.resolve();
  }
  const inFlight = warmInFlight;
  if (inFlight) {
    return inFlight.promise.then(
      () => undefined,
      () => undefined,
    );
  }
  const epoch = warmEpoch;
  const promise = acquireMicrophone();
  warmInFlight = { promise, epoch };
  void promise
    .then(
      (acquisition) => {
        if (warmEpoch !== epoch) {
          // Released while the permission/worklet legs were still running: this acquisition has
          // no owner left to hand it to, so close it rather than leave the microphone on.
          releaseMicrophoneAcquisition(acquisition);
          return;
        }
        warmAcquisition = acquisition;
      },
      () => undefined,
    )
    .finally(() => {
      if (warmInFlight?.promise === promise) {
        warmInFlight = null;
      }
    });
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Drops a warm-up the page will not use — the Live Voice allocation failed, or the pane unmounted
 * between the tap and the start. Releases a settled acquisition and makes sure one still in flight
 * is released when it lands. Never touches an acquisition a source has already taken.
 */
export function releaseWarmMicrophoneSource(): void {
  warmEpoch += 1;
  warmInFlight = null;
  const acquisition = warmAcquisition;
  warmAcquisition = null;
  if (acquisition) {
    releaseMicrophoneAcquisition(acquisition);
  }
}

/**
 * The acquisition a starting source should use: the warmed one if present, otherwise a fresh
 * acquisition on this call (the unchanged path for a caller that never warmed). Taking a warmed
 * acquisition removes it from the cache — each acquisition backs exactly one capture.
 */
async function takeMicrophoneAcquisition(): Promise<MicrophoneAcquisition> {
  const inFlight = warmInFlight;
  if (inFlight) {
    try {
      const acquisition = await inFlight.promise;
      if (inFlight.epoch !== warmEpoch) {
        // Released while the warm-up was running: the acquisition was let go with the cache, so
        // this start performs its own rather than claiming a released stream.
        return acquireMicrophone();
      }
      if (warmAcquisition === acquisition) {
        warmAcquisition = null;
        return acquisition;
      }
      // Another taker already claimed the warmed acquisition; this one acquires its own.
      return acquireMicrophone();
    } catch {
      // The warm-up failed (permission denied, worklet unavailable). Retry here so the CALLER
      // receives the failure it reports to the person, instead of a stale prewarm rejection.
    }
  }
  const cached = warmAcquisition;
  if (cached) {
    warmAcquisition = null;
    return cached;
  }
  return acquireMicrophone();
}

/**
 * The real microphone, via `getUserMedia` and the same `AudioWorklet` the
 * dictation composer loads. Exercised by a human in AC-312's manual smoke test;
 * CI never drives a real browser microphone.
 *
 * Alone among the sources it reports {@link VoiceRealtimeMicSuspension}: the browser can suspend
 * its capture `AudioContext` on its own, and this source answers that with a `resume()` rather
 * than letting the microphone stall silently.
 *
 * `start()` adopts an acquisition prepared by {@link warmMicrophoneSource} when there is one, and
 * otherwise performs the acquisition itself. Either way the graph wiring below runs exactly once
 * per start, so a warmed microphone begins delivering frames as soon as the node is connected.
 */
export function microphoneAudioSource(): VoiceRealtimeAudioSource {
  let acquisition: MicrophoneAcquisition | null = null;
  /** A `stop()` that arrives while `start()` is still acquiring must release what it gets. */
  let stopped = false;

  return {
    async start(onFrame, onMicSuspension) {
      const acquired = await takeMicrophoneAcquisition();
      if (stopped) {
        releaseMicrophoneAcquisition(acquired);
        return;
      }
      acquisition = acquired;
      const { stream, context, worklet } = acquired;
      worklet.port.onmessage = (message: MessageEvent<VoiceFrameMessage>) => {
        const data = message.data;
        if (!data || data.type !== 'pcm') {
          return;
        }
        onFrame({ samples: data.samples, sourceRate: context.sampleRate });
      };
      // A browser can suspend the capture context on its own — a notification sound, a Bluetooth
      // route change, a power policy — with no page navigation. A suspended context stops the
      // worklet delivering frames, so the microphone goes silent while the page shows no sign of
      // it; that silent stall (not the later socket close) is what the operator's evidence reads.
      // Listen for the change and try to bring capture back, reporting each outcome so the
      // consumer can surface the state and keep the detail on the console (never an error, never
      // Mute — see `VoiceRealtimeMicSuspension`).
      context.addEventListener('statechange', () => {
        if (context.state !== 'suspended') {
          return;
        }
        onMicSuspension?.({ suspended: true, detail: 'AudioContext suspended, attempting resume' });
        void context
          .resume()
          .then(() => {
            onMicSuspension?.({ suspended: false, detail: 'AudioContext resumed after suspension' });
          })
          .catch((failure: unknown) => {
            onMicSuspension?.({
              suspended: true,
              detail: `AudioContext resume failed: ${failure instanceof Error ? failure.message : String(failure)}`,
            });
          });
      });
      // A zero-gain sink pulls the graph without the microphone reaching the speakers.
      const silent = context.createGain();
      silent.gain.value = 0;
      context.createMediaStreamSource(stream).connect(worklet);
      worklet.connect(silent);
      silent.connect(context.destination);
    },
    stop() {
      stopped = true;
      if (acquisition) {
        releaseMicrophoneAcquisition(acquisition);
        acquisition = null;
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
