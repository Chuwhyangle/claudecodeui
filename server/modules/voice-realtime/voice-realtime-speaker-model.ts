/**
 * THE SPEAKER MODEL'S PROVISIONING SERVICE: the CAM++ weights the shadow tracker needs, installed
 * on demand from ONE fixed source instead of travelling with the repository or the release.
 *
 * WHY THIS IS A SERVICE RATHER THAN A CHECKOUT STEP. The checkpoint is 28 MB of ONNX weights, and
 * the delivery shapes this project ships (an npm package, an Electron bundle, a Docker image) must
 * not carry it — the release is source, the model is a runtime artifact. So the file lives under a
 * git-ignored directory the settings file names (`speakerTracking.modelDir`, default
 * `models/speaker/`), and the settings page asks the SERVER to fetch it. The browser never chooses a
 * URL, a directory or a file name: this module owns all three, and the two route verbs take no
 * input at all.
 *
 * THE PATH COMES FROM THE SETTINGS FILE, resolved once by the composition root and handed in here.
 * `modelPath`, when non-empty, wins; otherwise `join(modelDir, modelFile)` — the same precedence
 * `voice-realtime-settings.ts` applies. Relative values resolve against the repository root (the
 * server's working directory), so the state the settings page shows is the path the tracker will
 * actually load. `modelFile` must be a bare file name, and neither half may step outside with `..`:
 * the file is fetched, verified and renamed within that directory and nowhere else.
 *
 * WHAT "INSTALLED" MEANS. The bytes on disk are hashed again on every reading — a file of the right
 * LENGTH is not the model, and only the pinned digest proves it. `invalid` is that mismatch (or a
 * settings path this module refuses); `failed` carries the readable reason the last download gave.
 *
 * ONE DOWNLOAD PER PATH AT A TIME. The in-flight job lives in a map keyed by the resolved path, so a
 * second click — or a second operator on the same deployment — joins the running download and reads
 * its progress instead of opening a second connection. The bytes stream into `<path>.part` while the
 * digest is computed, and only a matching digest is renamed onto the final name; every failure
 * removes the partial file, which is what keeps a half-written checkpoint from ever looking
 * installed.
 *
 * Consumed by `voice-realtime.routes.ts` (the two verbs) and `server/index.ts` (the composition
 * root, which resolves the settings and passes them in).
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

import {
  SPEAKER_TRACKING_MODEL_DIR_DEFAULT,
  SPEAKER_TRACKING_MODEL_FILE_DEFAULT,
  type SpeakerTrackingSettingsBlock,
} from './voice-speaker-tracking-arm.js';

/** The pinned download source. Fixed on purpose: no request field reaches this constant. */
export const VOICE_SPEAKER_MODEL_SOURCE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

/** The checkpoint's file name. */
export const VOICE_SPEAKER_MODEL_FILE_NAME = SPEAKER_TRACKING_MODEL_FILE_DEFAULT;

/** The checkpoint's pinned length, in bytes. Used as the progress total when the server sends none. */
export const VOICE_SPEAKER_MODEL_BYTES = 28_281_164;

/** The checkpoint's pinned digest (`thresholds.v1.json`). Only bytes hashing to this are installed. */
export const VOICE_SPEAKER_MODEL_SHA256 =
  'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2';

/** The weights' licence, shown beside the status so the operator knows what they are installing. */
export const VOICE_SPEAKER_MODEL_LICENSE = 'Apache-2.0';

/** Who the weights are, for the settings page's attribution line. */
export const VOICE_SPEAKER_MODEL_ATTRIBUTION = '3D-Speaker CAM++ (sherpa-onnx release)';

/** How long a download may stay silent before it is aborted. */
export const VOICE_SPEAKER_MODEL_DOWNLOAD_TIMEOUT_MS = 120_000;

/** The largest response this service will accept, whatever the upstream claims. */
export const VOICE_SPEAKER_MODEL_MAX_BYTES = 64 * 1024 * 1024;

/** The five states the settings page and the routes read. */
export type VoiceSpeakerModelState = 'missing' | 'downloading' | 'installed' | 'invalid' | 'failed';

/** One reading of the model's location and state, as `GET /api/voice-realtime/speaker-model` returns it. */
export type VoiceSpeakerModelStatus = {
  /** What the file on disk is, per the definitions in this file's header. */
  readonly state: VoiceSpeakerModelState;
  /** The resolved checkpoint path; `null` when the settings named an unusable one. */
  readonly path: string | null;
  /** The file name the path ends in (or would end in). */
  readonly fileName: string;
  /** The pinned length. The client renders progress against it. */
  readonly expectedBytes: number;
  /** The pinned digest, so an operator can check the download independently. */
  readonly sha256: string;
  /** The fixed source, displayed by the settings page. */
  readonly sourceUrl: string;
  /** The weights' licence. */
  readonly license: string;
  /** Who the weights are. */
  readonly attribution: string;
  /** The file's size on disk when one exists; `null` otherwise. */
  readonly bytes: number | null;
  /** Bytes received by the running download (joins included); `null` when none is running. */
  readonly receivedBytes: number | null;
  /** The running download's total (content length or the pinned length); `null` when none is running. */
  readonly totalBytes: number | null;
  /** The running download's average rate, bytes per second; `null` when none is running. */
  readonly bytesPerSec: number | null;
  /** When the running download started (ms since epoch); `null` when none is running. */
  readonly startedAt: number | null;
  /** The readable reason a reading is `invalid`/`failed`; `null` otherwise. */
  readonly error: string | null;
};

/** What `POST /api/voice-realtime/speaker-model/download` answers, and why. */
export type VoiceSpeakerModelDownloadResult = {
  /** True when THIS call opened the connection. */
  readonly started: boolean;
  /** True when the call joined a download that was already running. */
  readonly joined: boolean;
  /** The reading after the call: `downloading`, or `installed` when nothing needed fetching. */
  readonly status: VoiceSpeakerModelStatus;
};

/** The service the routes and the composition root hold. */
export type VoiceSpeakerModelService = {
  /** Recomputes the reading from disk — including a fresh sha256 of an existing file. */
  status(): Promise<VoiceSpeakerModelStatus>;
  /** Starts a download, or joins the one already in flight for the same resolved path. */
  download(): Promise<VoiceSpeakerModelDownloadResult>;
};

/** One in-flight download, read by every `status()` while it runs. */
type DownloadJob = {
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  readonly controller: AbortController;
};

/** A target path this module is willing to write to, and the directory to create first. */
type ResolvedTarget = {
  readonly path: string;
  readonly directory: string;
  readonly fileName: string;
};

/** A refused path, carrying the sentence the settings page shows. */
type RefusedTarget = {
  readonly problem: string;
};

/**
 * Whether a settings value is a bare file name.
 *
 * `modelFile` is joined onto `modelDir`, so a separator — or a `.`/`..` segment — would move the
 * target outside the directory the settings file named. Refusing it here is the path-safety rule.
 */
function isBareFileName(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return !/^[A-Za-z]:/.test(value);
}

/** Whether any segment of a path is a parent step (`..`). */
function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * Resolves the checkpoint path from the settings block.
 *
 * `modelPath` wins when non-empty; otherwise the default model directory/file are joined exactly
 * the way the settings loader joins them. The result is what the tracker will try to load, so the
 * settings page and the shadow session cannot disagree about where the file goes.
 */
export function resolveVoiceSpeakerModelTarget(
  settings: Pick<SpeakerTrackingSettingsBlock, 'modelDir' | 'modelFile' | 'modelPath'> | null,
  options: { rootDir?: string } = {},
): ResolvedTarget | RefusedTarget {
  const rootDir = options.rootDir ?? process.cwd();
  const modelDir = (settings?.modelDir ?? '').trim() || SPEAKER_TRACKING_MODEL_DIR_DEFAULT;
  const modelFile = (settings?.modelFile ?? '').trim() || SPEAKER_TRACKING_MODEL_FILE_DEFAULT;
  const explicit = (settings?.modelPath ?? '').trim();

  if (explicit !== '') {
    if (hasParentSegment(explicit)) {
      return { problem: '`speakerTracking.modelPath` must not step outside with ".."' };
    }
    const path = isAbsolute(explicit) ? normalize(explicit) : resolve(rootDir, explicit);
    return { path, directory: dirname(path), fileName: path.split(/[\\/]/).pop() ?? modelFile };
  }

  if (!isBareFileName(modelFile)) {
    return {
      problem: `\`speakerTracking.modelFile\` must be a bare file name, got ${JSON.stringify(modelFile)}`,
    };
  }
  const directory = isAbsolute(modelDir) ? normalize(modelDir) : resolve(rootDir, modelDir);
  return { path: join(directory, modelFile), directory, fileName: modelFile };
}

/** The sentence shown when a settings path was refused, or `error.message` for anything else. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

/**
 * Creates the provisioning service.
 *
 * Every dependency is an option so the criterion can drive the service without a network and
 * without touching the process's working directory: `fetchImpl` is the stream source, `rootDir`
 * anchors relative settings paths, `now` is the progress clock, and the two limits are the
 * download's own time and size caps.
 */
export function createVoiceSpeakerModelService(options: {
  settings: Pick<SpeakerTrackingSettingsBlock, 'modelDir' | 'modelFile' | 'modelPath'> | null;
  rootDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * The pinned digest and length, overridable so a criterion can exercise the verification with a
   * few bytes instead of the 28 MB checkpoint. Production passes neither and gets the constants
   * above; the DOWNLOAD SOURCE is deliberately not overridable, because "the URL is fixed" is the
   * property these routes exist to keep.
   */
  expectedSha256?: string;
  expectedBytes?: number;
}): VoiceSpeakerModelService {
  const rootDir = options.rootDir ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? VOICE_SPEAKER_MODEL_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? VOICE_SPEAKER_MODEL_MAX_BYTES;
  const expectedSha256 = options.expectedSha256 ?? VOICE_SPEAKER_MODEL_SHA256;
  const expectedBytes = options.expectedBytes ?? VOICE_SPEAKER_MODEL_BYTES;

  /** The one running download per resolved path. A second request joins this entry. */
  const jobs = new Map<string, DownloadJob>();
  /** The last failure per resolved path, cleared by the next successful rename. */
  const failures = new Map<string, string>();

  const baseStatus = {
    expectedBytes,
    sha256: expectedSha256,
    sourceUrl: VOICE_SPEAKER_MODEL_SOURCE_URL,
    license: VOICE_SPEAKER_MODEL_LICENSE,
    attribution: VOICE_SPEAKER_MODEL_ATTRIBUTION,
  } as const;

  /** The reading for a job's progress right now. */
  const downloadingStatus = (job: DownloadJob, path: string, fileName: string): VoiceSpeakerModelStatus => {
    const elapsedSeconds = Math.max(0.001, (now() - job.startedAt) / 1_000);
    return {
      ...baseStatus,
      state: 'downloading',
      path,
      fileName,
      bytes: null,
      receivedBytes: job.receivedBytes,
      totalBytes: job.totalBytes,
      bytesPerSec: Math.round(job.receivedBytes / elapsedSeconds),
      startedAt: job.startedAt,
      error: null,
    };
  };

  /** The reading for a refused path: no download can ever start, and the reason is the sentence. */
  const refusedStatus = (problem: string, fileName: string): VoiceSpeakerModelStatus => ({
    ...baseStatus,
    state: 'invalid',
    path: null,
    fileName,
    bytes: null,
    receivedBytes: null,
    totalBytes: null,
    bytesPerSec: null,
    startedAt: null,
    error: problem,
  });

  /** Reads the file's state: absent, installed (digest matches), or invalid (anything else). */
  const readFileStatus = async (target: ResolvedTarget): Promise<VoiceSpeakerModelStatus> => {
    let size: number;
    try {
      const stats = await stat(target.path);
      if (!stats.isFile()) {
        const failure = failures.get(target.path);
        return {
          ...baseStatus,
          state: failure === undefined ? 'missing' : 'failed',
          path: target.path,
          fileName: target.fileName,
          bytes: null,
          receivedBytes: null,
          totalBytes: null,
          bytesPerSec: null,
          startedAt: null,
          error: failure ?? null,
        };
      }
      size = stats.size;
    } catch {
      // A missing file and a file the process cannot read are the same reading to the operator:
      // the checkpoint is not usable. The remedy — download it, or fix the directory — is one.
      const failure = failures.get(target.path);
      return {
        ...baseStatus,
        state: failure === undefined ? 'missing' : 'failed',
        path: target.path,
        fileName: target.fileName,
        bytes: null,
        receivedBytes: null,
        totalBytes: null,
        bytesPerSec: null,
        startedAt: null,
        error: failure ?? null,
      };
    }

    // THE DIGEST IS THE READING. A checkpoint of the right length is still not this model, so the
    // bytes are hashed again on every status call rather than trusted from the size.
    let digest: string;
    try {
      digest = createHash('sha256').update(await readFile(target.path)).digest('hex');
    } catch (error) {
      return {
        ...baseStatus,
        state: 'invalid',
        path: target.path,
        fileName: target.fileName,
        bytes: size,
        receivedBytes: null,
        totalBytes: null,
        bytesPerSec: null,
        startedAt: null,
        error: `cannot read the model file: ${describeFailure(error)}`,
      };
    }
    if (digest === expectedSha256) {
      failures.delete(target.path);
      return {
        ...baseStatus,
        state: 'installed',
        path: target.path,
        fileName: target.fileName,
        bytes: size,
        receivedBytes: null,
        totalBytes: null,
        bytesPerSec: null,
        startedAt: null,
        error: null,
      };
    }
    return {
      ...baseStatus,
      state: 'invalid',
      path: target.path,
      fileName: target.fileName,
      bytes: size,
      receivedBytes: null,
      totalBytes: null,
      bytesPerSec: null,
      startedAt: null,
      error: `sha256 mismatch: expected ${expectedSha256}, got ${digest}`,
    };
  };

  /** Runs one download to completion, recording its failure and always removing the `.part` file. */
  const runDownload = async (target: ResolvedTarget, job: DownloadJob): Promise<void> => {
    const partPath = `${target.path}.part`;
    const timer = setTimeout(() => {
      job.controller.abort(new Error(`the download timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    try {
      await mkdir(target.directory, { recursive: true });
      const response = await fetchImpl(VOICE_SPEAKER_MODEL_SOURCE_URL, {
        redirect: 'follow',
        signal: job.controller.signal,
      });
      if (!response.ok) {
        throw new Error(`the model source answered HTTP ${response.status}`);
      }
      if (response.body === null) {
        throw new Error('the model source answered without a body');
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`the model source declared ${declared} bytes, above the ${maxBytes}-byte limit`);
      }
      if (Number.isFinite(declared) && declared > 0) {
        job.totalBytes = declared;
      }

      const hash = createHash('sha256');
      const handle = await open(partPath, 'w');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bytes = chunk.value;
          job.receivedBytes += bytes.byteLength;
          if (job.receivedBytes > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`the download exceeded the ${maxBytes}-byte limit`);
          }
          hash.update(bytes);
          await handle.write(bytes);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }

      const digest = hash.digest('hex');
      if (job.receivedBytes !== expectedBytes) {
        throw new Error(
          `size mismatch: expected ${expectedBytes} bytes, got ${job.receivedBytes}`,
        );
      }
      if (digest !== expectedSha256) {
        throw new Error(
          `sha256 mismatch: expected ${expectedSha256}, got ${digest}`,
        );
      }
      // ONLY A VERIFIED FILE GETS THE FINAL NAME, and the rename is what makes the install atomic:
      // a reader never sees a partially written checkpoint under the name the tracker loads.
      await rename(partPath, target.path);
      failures.delete(target.path);
    } catch (error) {
      await unlink(partPath).catch(() => undefined);
      failures.set(target.path, describeFailure(error));
    } finally {
      clearTimeout(timer);
      jobs.delete(target.path);
    }
  };

  return {
    async status(): Promise<VoiceSpeakerModelStatus> {
      const target = resolveVoiceSpeakerModelTarget(options.settings, { rootDir });
      if ('problem' in target) {
        return refusedStatus(target.problem, options.settings?.modelFile ?? VOICE_SPEAKER_MODEL_FILE_NAME);
      }
      const job = jobs.get(target.path);
      if (job !== undefined) {
        return downloadingStatus(job, target.path, target.fileName);
      }
      return readFileStatus(target);
    },

    async download(): Promise<VoiceSpeakerModelDownloadResult> {
      const target = resolveVoiceSpeakerModelTarget(options.settings, { rootDir });
      if ('problem' in target) {
        return {
          started: false,
          joined: false,
          status: refusedStatus(target.problem, options.settings?.modelFile ?? VOICE_SPEAKER_MODEL_FILE_NAME),
        };
      }

      const running = jobs.get(target.path);
      if (running !== undefined) {
        return {
          started: false,
          joined: true,
          status: downloadingStatus(running, target.path, target.fileName),
        };
      }

      const current = await readFileStatus(target);
      if (current.state === 'installed') {
        return { started: false, joined: false, status: current };
      }

      const job: DownloadJob = {
        receivedBytes: 0,
        totalBytes: expectedBytes,
        startedAt: now(),
        controller: new AbortController(),
      };
      jobs.set(target.path, job);
      // The job runs in the background: the route answers with the progress it just started, and
      // the settings page polls `status()` for the outcome.
      void runDownload(target, job);
      return { started: true, joined: false, status: downloadingStatus(job, target.path, target.fileName) };
    },
  };
}
