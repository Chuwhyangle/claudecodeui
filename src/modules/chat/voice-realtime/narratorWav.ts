/**
 * The narrator WAV container as `useVoiceRealtimeSession` reads it: the RIFF/WAVE header the
 * streaming TTS path schedules from, the byte helpers that read it, and the release of the
 * `AudioContext` sources built from it.
 *
 * Streaming playback starts before `tts_done`, so the page has to read the container itself: the
 * `fmt ` chunk says how to turn PCM bytes into samples, and `dataStart` is where the first PCM byte
 * lives (everything before it is the header frame a media element would need to decode the file).
 * This module is the container half of that path; scheduling the decoded samples stays in the hook.
 *
 * Used by `useVoiceRealtimeSession`, this module's only consumer.
 */

/**
 * The fields of a RIFF/WAVE header streaming playback needs.
 *
 * Streaming playback starts before `tts_done`, so the page has to read the container itself: the
 * `fmt ` chunk says how to turn PCM bytes into samples, and `dataStart` is where the first PCM byte
 * lives (everything before it is the header frame a media element would need to decode the file).
 */
export type NarratorWavHeader = {
  sampleRate: number;
  channels: number;
  /** Always 16 for the streaming path; any other depth falls back to the element path. */
  bitsPerSample: number;
  dataStart: number;
};

/**
 * One narrator utterance being scheduled through an `AudioContext`.
 *
 * `fallback` is the whole safety valve: no `AudioContext`, a non-WAV container, an unreadable
 * header, or a `resume()` rejected by the autoplay policy all set it, and `tts_done` then plays the
 * assembled Blob exactly as the pre-streaming page did. The slices keep being collected in
 * {@link NarratorTtsBuffer} while streaming, so that fallback is always possible.
 */
export type NarratorStream = {
  utteranceId: string;
  format: string;
  header: NarratorWavHeader | null;
  context: AudioContext | null;
  fallback: boolean;
  /** Decoded PCM bytes that do not yet complete a sample frame. */
  pending: Uint8Array;
  /** The context time the next scheduled source starts at, keeping slices contiguous. */
  nextStartTime: number;
  sources: AudioBufferSourceNode[];
  lastSource: AudioBufferSourceNode | null;
  lastEnded: boolean;
  /** `tts_done` has arrived; the last source's `ended` is what acks. */
  done: boolean;
  stopped: boolean;
  acked: boolean;
};

/** Decodes one base64 slice, or `null` when it is not base64 at all. */
export function narratorBase64Bytes(payload: string): Uint8Array | null {
  try {
    const raw = atob(payload);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Four ASCII bytes as a chunk id, or `null` when the range is short. */
function narratorAscii(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null;
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function narratorUint16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function narratorUint32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}

/** Joins two byte slices without mutating either. */
export function concatNarratorBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

/**
 * Reads the PCM format out of a WAV header, or `null` when it is not a shape this page can schedule.
 *
 * `seq: 0` carries the header (the new producer sends exactly the header bytes; the pre-streaming
 * producer's first frame was 16 KiB, so the header may sit at the front of a slice that also
 * contains PCM — `dataStart` is what lets both shapes work).
 */
export function parseNarratorWavHeader(bytes: Uint8Array): NarratorWavHeader | null {
  if (bytes.length < 12) return null;
  if (narratorAscii(bytes, 0) !== 'RIFF' || narratorAscii(bytes, 8) !== 'WAVE') return null;

  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = narratorAscii(bytes, offset);
    const size = narratorUint32LE(bytes, offset + 4);
    if (id === null || size === null) return null;
    const bodyStart = offset + 8;
    if (id === 'data') {
      if (
        audioFormat !== 1 ||
        channels === null ||
        channels < 1 ||
        sampleRate === null ||
        sampleRate <= 0 ||
        bitsPerSample !== 16
      ) {
        return null;
      }
      return { sampleRate, channels, bitsPerSample, dataStart: bodyStart };
    }
    if (size === 0xffff_ffff || bodyStart + size > bytes.length) return null;
    if (id === 'fmt ' && size >= 16) {
      audioFormat = narratorUint16LE(bytes, bodyStart);
      channels = narratorUint16LE(bytes, bodyStart + 2);
      sampleRate = narratorUint32LE(bytes, bodyStart + 4);
      bitsPerSample = narratorUint16LE(bytes, bodyStart + 14);
    }
    offset = bodyStart + size + (size % 2);
  }
  return null;
}

/**
 * Stops every source this stream scheduled and closes its context.
 *
 * Used by `narrator_stop`, by a replaced connection and by `end()`: none of those may ack, because
 * the server has already cleared the utterance and is not waiting for this id.
 */
export function releaseNarratorStream(stream: NarratorStream): void {
  stream.stopped = true;
  for (const source of stream.sources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* a source that already ended cannot be stopped again */
    }
  }
  stream.sources.length = 0;
  stream.lastSource = null;
  const context = stream.context;
  stream.context = null;
  if (context !== null) {
    try {
      void context.close();
    } catch {
      /* an already-closed context */
    }
  }
}
