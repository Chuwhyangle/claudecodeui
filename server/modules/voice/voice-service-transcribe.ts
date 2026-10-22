/**
 * The transcription-assets half of the voice service: the model and runtime files the BROWSER
 * recogniser is served from.
 *
 * WHY IT IS A SIBLING MODULE RATHER THAN THE TAIL OF `voice.service.ts`. What lives here is not the
 * transcription path — that path asks the registry for an adapter and never stats a file. It is the
 * static-asset surface around the browser recogniser: which directory supplies the pinned ONNX
 * checkpoint, which three `onnxruntime-web` files may be downloaded, and the readiness reading the
 * client shows before it starts one. Nothing here is reached from `createVoiceService`, so keeping
 * it in that file only made a reader cross a transcription path to find a `statSync`.
 *
 * IT IS A PURE MOVE. Every declaration and body below is the shipping text, unchanged; only the
 * imports and the section banner moved with them.
 *
 * Consumed by `server/modules/voice/voice.module.ts` (it builds the service at composition time),
 * `server/modules/voice/voice.routes.ts` (the readiness fallback), and
 * `server/modules/voice/tests/voice-sensevoice-health.routes.test.ts`. `voice.service.ts` re-exports
 * this module's public symbols so those consumers keep the import they have always had.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import type {
  VoiceClientAssetFile,
  VoiceClientAssetFileRef,
  VoiceClientAssetsReading,
  VoiceClientAssetsService,
} from '@/shared/types.js';

/**
 * The variable naming the directory the browser-side recogniser's model files live in.
 *
 * IT IS THE ONE A DEPLOYMENT SETS FOR THIS FEATURE. `SENSEVOICE_MODEL_DIR` is the fallback (see
 * `resolveVoiceClientModelDir`), because a deployment that already runs the on-host recogniser
 * already holds the same two files in a directory it has already configured. Read at composition
 * time and handed in as a value — this module reads no environment itself, so a test can ask what a
 * given pair of values means without mutating the process.
 */
export const VOICE_CLIENT_MODEL_DIR_ENV = 'VOICE_CLIENT_MODEL_DIR';

/** The on-host recogniser's directory, reused as this feature's fallback. See `VOICE_CLIENT_MODEL_DIR_ENV`. */
export const SENSEVOICE_MODEL_DIR_ENV = 'SENSEVOICE_MODEL_DIR';

/** The checkpoint's file name inside the model directory. */
export const VOICE_CLIENT_MODEL_FILE_NAME = 'model.int8.onnx';

/** The token list's file name inside the model directory. */
export const VOICE_CLIENT_TOKENS_FILE_NAME = 'tokens.txt';

/**
 * The checkpoint's pinned length, in bytes.
 *
 * THE SAME FIGURE THE CLIENT PINS (`VOICE_CLIENT_MODEL_BYTES` in `voiceClientAsrWorker.ts`), and it
 * has to be: the reading exists to tell a browser that the file it would download is not the file
 * this front end implements. A truncated or wrong checkpoint is refused HERE, before any download.
 */
export const VOICE_CLIENT_MODEL_BYTES = 239_233_841;

/**
 * The three files of the pinned onnxruntime-web distribution.
 *
 * A WHITELIST, and the only names `/voice-client/ort/:file` will serve. The runtime is a dependency
 * of this repo (`package.json` pins `onnxruntime-web@1.30.0`), so these are read out of
 * `node_modules` rather than hosted by the deployment — see `createVoiceClientAssetsService`.
 */
export const VOICE_CLIENT_ORT_FILE_NAMES: readonly string[] = [
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

/**
 * The reading owed a deployment that configured no model directory at all.
 *
 * DECLARED ONCE AND EXPORTED because two callers need the same shape: the service below, and the
 * readiness route's fallback for a router built without one (a leaf test, or a caller that composes
 * the voice router itself). A second literal in the route would be a second definition of "no
 * directory", and the client's sentence is built from this reading.
 */
export function unconfiguredVoiceClientAssetsReading(): VoiceClientAssetsReading {
  return {
    configured: false,
    directory: null,
    source: null,
    model: {
      name: VOICE_CLIENT_MODEL_FILE_NAME,
      present: false,
      bytes: null,
      expectedBytes: VOICE_CLIENT_MODEL_BYTES,
    },
    tokens: { name: VOICE_CLIENT_TOKENS_FILE_NAME, present: false, bytes: null, expectedBytes: null },
    ready: false,
  };
}

/**
 * Which directory supplies the model files, and which variable named it.
 *
 * `VOICE_CLIENT_MODEL_DIR` WINS WHEN BOTH ARE SET, and the fallback is the whole reason the two are
 * read together: `SENSEVOICE_MODEL_DIR` already holds these two files on a deployment that runs the
 * on-host recogniser, so an operator who has configured that one has configured this one. Both
 * values are trimmed; an all-blank value is the same as an unset one.
 */
export function resolveVoiceClientModelDir(
  voiceClientModelDir: string | undefined,
  sensevoiceModelDir: string | undefined,
): { directory: string | null; source: 'VOICE_CLIENT_MODEL_DIR' | 'SENSEVOICE_MODEL_DIR' | null } {
  const preferred = (voiceClientModelDir ?? '').trim();
  if (preferred !== '') return { directory: preferred, source: 'VOICE_CLIENT_MODEL_DIR' };
  const fallback = (sensevoiceModelDir ?? '').trim();
  if (fallback !== '') return { directory: fallback, source: 'SENSEVOICE_MODEL_DIR' };
  return { directory: null, source: null };
}

/** One file's reading: a regular file of this name's length, or the absent form. */
function readClientAssetFile(directory: string, name: string, expectedBytes: number | null): VoiceClientAssetFile {
  try {
    const stats = statSync(join(directory, name));
    if (!stats.isFile()) {
      return { name, present: false, bytes: null, expectedBytes };
    }
    return { name, present: true, bytes: stats.size, expectedBytes };
  } catch {
    // A missing file and a directory that cannot be read are the same reading to the operator: the
    // artifact named is not there. Distinguishing an EACCES here would name a filesystem detail the
    // caller cannot act on differently, and the remedy — put the file in this directory — is one.
    return { name, present: false, bytes: null, expectedBytes };
  }
}

/** The whitelisted file's reference, or `null` when the name is not in `names` or is not a regular file. */
function resolveWhitelistedFile(
  directory: string,
  names: readonly string[],
  name: string,
): VoiceClientAssetFileRef | null {
  // The membership test IS the path-safety rule: only an exact pinned name survives it, so a
  // `../` or `%2e%2e` argument can never reach `join`.
  if (!names.includes(name)) return null;
  const path = join(directory, name);
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    return { path, size: stats.size };
  } catch {
    return null;
  }
}

/**
 * Creates the service behind the client-asset routes.
 *
 * THE DIRECTORY IS RESOLVED ONCE, at composition time, for the same reason the recording mode is:
 * "where are the browser recogniser's files" is a property of the DEPLOYMENT, not of a request, and
 * a value re-resolved per request could change under a download already in flight. The resolvers
 * stat on demand — a file an operator drops in after start-up becomes servable without a restart —
 * but the directory they stat within never moves.
 *
 * THE RUNTIME FILES ARE READ OUT OF `node_modules` rather than from a configurable directory: this
 * repo pins `onnxruntime-web@1.30.0`, so the exact distribution the front end was validated against
 * is the one an `npm install` produces. A deployment that vendored its own copy would be serving a
 * runtime this front end was not tested with, which is the thing the pin exists to prevent.
 */
export function createVoiceClientAssetsService(options: {
  voiceClientModelDir?: string;
  sensevoiceModelDir?: string;
  ortDistDir: string;
}): VoiceClientAssetsService {
  const resolved = resolveVoiceClientModelDir(options.voiceClientModelDir, options.sensevoiceModelDir);

  return {
    readiness(): VoiceClientAssetsReading {
      if (resolved.directory === null) return unconfiguredVoiceClientAssetsReading();

      const model = readClientAssetFile(resolved.directory, VOICE_CLIENT_MODEL_FILE_NAME, VOICE_CLIENT_MODEL_BYTES);
      const tokens = readClientAssetFile(resolved.directory, VOICE_CLIENT_TOKENS_FILE_NAME, null);
      // The byte check is part of readiness rather than a separate reading: a checkpoint of the wrong
      // length cannot be the model this front end implements, so "ready" without it would promise a
      // download guaranteed to fail verification.
      const ready = model.present && model.bytes === VOICE_CLIENT_MODEL_BYTES && tokens.present;
      return {
        configured: true,
        directory: resolved.directory,
        source: resolved.source,
        model,
        tokens,
        ready,
      };
    },

    resolveModelFile(name: string): VoiceClientAssetFileRef | null {
      if (resolved.directory === null) return null;
      return resolveWhitelistedFile(
        resolved.directory,
        [VOICE_CLIENT_MODEL_FILE_NAME, VOICE_CLIENT_TOKENS_FILE_NAME],
        name,
      );
    },

    resolveOrtFile(name: string): VoiceClientAssetFileRef | null {
      return resolveWhitelistedFile(options.ortDistDir, VOICE_CLIENT_ORT_FILE_NAMES, name);
    },
  };
}
