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
