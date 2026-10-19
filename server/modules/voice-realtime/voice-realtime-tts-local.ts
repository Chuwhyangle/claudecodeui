/**
 * The LOCAL CPU TTS leaf: the same narrator text, synthesized by a bundled Kokoro model through
 * `sherpa-onnx-node` instead of the DashScope cloud.
 *
 * WHY THIS EXISTS. The cloud leaf (`voice-realtime-tts.ts`) bills a 0.66–3.53 s round trip for every
 * sentence, which is pure waste for the announce's 1–3 character interjections. `sherpa-onnx-node`
 * is already a repository dependency (the uplink VAD drives it), and it ships `OfflineTts` with a
 * Kokoro `multi-lang v1.1` model that reads Chinese AND English as one language unit — the one thing
 * the announce phrases and a model text reply actually need. Synthesis here is a local CPU call with
 * no network and no credential.
 *
 * DELIBERATELY A SIBLING, NOT A REWRITE. This module produces the SAME `VoiceRealtimeTtsSynthesis`
 * shape the cloud leaf produces, and reuses {@link emitVoiceRealtimeSynthesisFrames} for framing, so
 * the narrator queue, the browser and every criterion downstream see an identical wire. It is the
 * composition root's job (see `server/index.ts`) to pick one seam or the other; nothing here reads
 * the environment.
 *
 * THE WIRE IS A WAV. sherpa returns float32 samples plus a sample rate; this module encodes them as a
 * mono 16-bit PCM RIFF/WAVE blob (the container the browser playback already reads its duration and
 * format from). `format: 'wav'` is the honest label and `durationMs` is computed from the samples,
 * exactly as the cloud leaf reports it.
 *
 * NOTHING HERE IS SILENT. An unreadable model directory, a missing dependency or an empty synthesis
 * all resolve to a named `tts_error` code rather than an `ok` with zero bytes.
 */
import { join } from 'node:path';
import { statSync } from 'node:fs';

import {
  emitVoiceRealtimeSynthesisFrames,
  type VoiceRealtimeTtsSynthesis,
} from './voice-realtime-tts.js';
import type { VoiceRealtimeNarratorTtsSeam } from './voice-realtime-ws-proxy.service.js';

/**
 * The sherpa runtime's smallest useful surface. Declared by shape, not by import, so this leaf stays
 * free of a hard dependency on a package the deployer may not have built for their platform.
 */
type SherpaOfflineTts = {
  generate(request: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number };
};

type SherpaRuntime = {
  OfflineTts: {
    createAsync(config: unknown): Promise<SherpaOfflineTts>;
  };
};

/** Everything one local synthesis call needs, resolved by the composition root. */
export type LocalVoiceRealtimeTtsOptions = {
  /** Directory holding model.onnx / voices.bin / tokens.txt / espeak-ng-data / lexicon. */
  modelDir: string;
  /** The Kokoro speaker id. Kokoro multi-lang v1.1 carries 8 Chinese voices; 0 is the first female. */
  sid?: number;
  /** Playback speed (1.0 = the model's own pace). */
  speed?: number;
  /** ONNX runtime threads. */
  numThreads?: number;
  /** Test seam for the optional package; defaults to a dynamic `import`. */
  loadDependency?: (specifier: string) => Promise<unknown>;
};

/**
 * The environment variable that switches the narrator's TTS to the LOCAL Kokoro leaf.
 *
 * Read by `server/index.ts` at its assembly point. Unset or blank means the cloud leaf (the shipped
 * state); any non-blank value installs the local seam. Presence is the switch, exactly like
 * `VOICE_REALTIME_TTS_ENDPOINT` is the criterion-only override.
 */
export const VOICE_REALTIME_TTS_LOCAL_ENV = 'VOICE_REALTIME_TTS_LOCAL';

/** The environment variable that names the Kokoro model directory. Read by `server/index.ts`. */
export const VOICE_REALTIME_TTS_LOCAL_DIR_ENV = 'VOICE_REALTIME_TTS_LOCAL_DIR';

/** The environment variable that names the Kokoro speaker id. Read by `server/index.ts`. */
export const VOICE_REALTIME_TTS_LOCAL_SID_ENV = 'VOICE_REALTIME_TTS_LOCAL_SID';

/** The speaker id used when the deployment names none. 0 is the first Chinese female voice. */
export const VOICE_REALTIME_TTS_LOCAL_DEFAULT_SID = 0;

/**
 * The Kokoro lexicon files, comma-joined the way the sherpa Kokoro config spells them. The two
 * English lexicons plus the Chinese one are what give multi-lang v1.1 its CN/EN-as-one-unit reading.
 */
const KOKORO_LEXICON = ['lexicon-us-en.txt', 'lexicon-zh.txt'];

/** One loaded model, kept for the process lifetime — the ONNX graph is ~325 MB and loads once. */
let cachedTts: { key: string; tts: SherpaOfflineTts } | null = null;

/** The cache key: the model directory and thread count. A different directory must reload. */
function cacheKey(options: LocalVoiceRealtimeTtsOptions): string {
  return `${options.modelDir}:${options.numThreads ?? 2}`;
}

/** A CJS package loaded through `import()` hands back a namespace whose `default` is `module.exports`. */
function unwrapCommonJs(loaded: unknown): Record<string, unknown> {
  let value = loaded as Record<string, unknown> | undefined;
  for (let depth = 0; depth < 2 && value && typeof value === 'object' && 'default' in value; depth += 1) {
    const inner = (value as { default?: unknown }).default;
    if (inner === undefined || typeof inner !== 'object') break;
    value = inner as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

/** The default dependency resolver: a dynamic import through a VARIABLE specifier, so it stays optional. */
async function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

/** A short, log-safe rendering of a thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a path exists AND is a regular file — a directory where a model belongs is not a model. */
function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Loads the Kokoro model once, resolving the sherpa runtime on first use. */
async function ensureTts(options: LocalVoiceRealtimeTtsOptions): Promise<SherpaOfflineTts> {
  const key = cacheKey(options);
  if (cachedTts !== null && cachedTts.key === key) return cachedTts.tts;
  const modelPath = join(options.modelDir, 'model.onnx');
  if (!fileExists(modelPath)) {
    throw new Error(`Kokoro model.onnx not found under ${options.modelDir}`);
  }
  const loaded = options.loadDependency
    ? await options.loadDependency('sherpa-onnx-node')
    : await importOptional('sherpa-onnx-node');
  const runtime = unwrapCommonJs(loaded) as unknown as SherpaRuntime;
  if (typeof runtime.OfflineTts?.createAsync !== 'function') {
    throw new Error('sherpa-onnx-node loaded but exposes no OfflineTts.createAsync');
  }
  const tts = await runtime.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: modelPath,
        voices: join(options.modelDir, 'voices.bin'),
        tokens: join(options.modelDir, 'tokens.txt'),
        dataDir: join(options.modelDir, 'espeak-ng-data'),
        lexicon: KOKORO_LEXICON.map((name) => join(options.modelDir, name)).join(','),
      },
    },
    numThreads: options.numThreads ?? 2,
  });
  cachedTts = { key, tts };
  return tts;
}

/**
 * Encodes float32 samples in [-1, 1] as a mono 16-bit PCM RIFF/WAVE blob.
 *
 * The quantization matches the repository's own PCM16 convention (`Math.trunc(v * 0x7fff)` for
 * non-negative, `Math.trunc(v * 0x8000)` for negative), so a criterion that reassembles the frames
 * reads back the same bytes a real capture would have produced.
 */
function pcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const channels = 1;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    buffer.writeInt16LE(clamped < 0 ? Math.trunc(clamped * 0x8000) : Math.trunc(clamped * 0x7fff), 44 + index * 2);
  }
  return new Uint8Array(buffer);
}

/**
 * Builds the narrator's TTS seam backed by the local Kokoro model.
 *
 * Consumed by `server/index.ts`, which switches to this seam when `VOICE_REALTIME_TTS_LOCAL` is set.
 * The returned `speak` synthesizes on the spot (a local sentence is ~0.1 s, so no pre-synthesis
 * cache is warranted) and frames the WAV through the same emitter the cloud leaf uses.
 */
export function createLocalVoiceRealtimeTtsSeam(options: LocalVoiceRealtimeTtsOptions): VoiceRealtimeNarratorTtsSeam {
  return {
    speak: async (input, downlink) => {
      const trimmed = input.text.trim();
      if (trimmed === '') {
        return { ok: false, code: 'TTS_EMPTY_TEXT', message: 'there is no text to speak' };
      }
      let tts: SherpaOfflineTts;
      try {
        tts = await ensureTts(options);
      } catch (error) {
        return {
          ok: false,
          code: 'TTS_NOT_CONFIGURED',
          message: describeError(error),
        };
      }
      let generated: { samples: Float32Array; sampleRate: number };
      try {
        generated = tts.generate({ text: trimmed, sid: options.sid ?? 0, speed: options.speed ?? 1.0 });
      } catch (error) {
        return {
          ok: false,
          code: 'TTS_UNREACHABLE',
          message: `the local TTS synthesis failed: ${describeError(error)}`,
        };
      }
      if (generated.samples.length === 0) {
        return {
          ok: false,
          code: 'TTS_EMPTY_AUDIO',
          message: 'the local TTS completed the request without producing any audio',
        };
      }
      const bytes = pcm16Wav(generated.samples, generated.sampleRate);
      const synthesis: VoiceRealtimeTtsSynthesis = {
        ok: true,
        bytes,
        format: 'wav',
        sampleRate: generated.sampleRate,
        durationMs: (generated.samples.length / generated.sampleRate) * 1000,
        characters: trimmed.length,
      };
      // The credential is irrelevant to the local path; the shared emitter only reads frameBytes.
      return emitVoiceRealtimeSynthesisFrames(input, { apiKey: '', voice: '' }, synthesis, downlink);
    },
  };
}
