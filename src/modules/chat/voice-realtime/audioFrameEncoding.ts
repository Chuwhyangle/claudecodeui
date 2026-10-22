/**
 * The captured-frame readings and the base64 PCM16 wire shape `useVoiceRealtimeSession` sends.
 *
 * The Realtime session's `input_audio_format` is `pcm16` at 16 kHz while the audio graph runs at
 * whatever the capture device picked, so every frame goes through the same decimate-then-quantise
 * encoding here regardless of whether it came from the microphone or an uploaded fixture (see
 * `audioSource.ts`). Keeping the encoding out of the hook means the continuous and segmented paths
 * cannot drift into two copies of it.
 *
 * Used by `useVoiceRealtimeSession`, this module's only consumer.
 */
import type { VoiceRealtimeAudioFrame } from '@/modules/chat/voice-realtime/audioSource';

/** Peak-ish loudness of one frame, 0..1: RMS scaled so ordinary speech fills most of the range. */
export function frameLevel(samples: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
}

/** The rate the Realtime transport's `pcm16` input expects. */
const TARGET_SAMPLE_RATE = 16_000;

/**
 * Encodes one captured Float32 frame as base64 little-endian PCM16.
 *
 * The Realtime session's `input_audio_format` is `pcm16` at 16 kHz, while the
 * audio graph runs at whatever the capture device picked (48 kHz in most
 * browsers), so the frame is decimated by nearest-neighbour before it is
 * quantised. Nearest-neighbour is enough here: this is speech headed for an
 * ASR-grade model, and the alternative — a windowed resampler — buys nothing
 * the recogniser can hear.
 */
function encodePcm16Base64(samples: Float32Array, sourceRate: number): string {
  const step = sourceRate > TARGET_SAMPLE_RATE ? sourceRate / TARGET_SAMPLE_RATE : 1;
  const count = step > 1 ? Math.floor(samples.length / step) : samples.length;
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    const sample = step > 1 ? samples[Math.floor(index * step)] : samples[index];
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

/**
 * One `audio` frame on the CONTINUOUS path — the shipped behaviour, and the fallback for
 * every connection whose server never declares the segmented relay. Its bytes are the
 * pre-P1c client's exactly: the segmented path must be additive, so a connection that
 * negotiates nothing (or negotiates against an older proxy) still sends what it always did.
 */
export function continuousAudioFrame(frame: VoiceRealtimeAudioFrame): string {
  return JSON.stringify({ type: 'audio', audio: encodePcm16Base64(frame.samples, frame.sourceRate) });
}
