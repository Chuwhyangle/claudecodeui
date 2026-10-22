/**
 * THE SPEAKER TRACKING SEAM (Phase 1, SHADOW): the runtime glue between the proxy's audio frames and
 * the three pure logic modules, plus the one process-wide CAM++ embedder.
 *
 * WHAT THE PROXY SEES. Exactly two members:
 *
 *  - `observe(window, atMs)` — one completed 2 s analysis window in, one reading out
 *    (`{score, track, authorizeTse, …}`). The seam embeds the window, updates the session attractor and
 *    the long-term bank, applies the dual key, and returns the reading the proxy logs.
 *  - `summary()` — the connection-end totals.
 *
 * Nothing in this file forwards, drops, commits or sends anything: it is fed a COPY of audio that the
 * proxy has already decided to forward. That is what makes "shadow changes no behaviour" structural
 * rather than a promise.
 *
 * WHY THE EMBEDDER IS SHARED AND THE STATE IS NOT. One CAM++ ONNX session is expensive (hundreds of MB
 * of weights), so `createSpeakerTrackerModel` loads it ONCE per process; the session attractor and the
 * bank are per CONNECTION because they describe one person's connection. `server/index.ts` builds the
 * model at the composition root and one seam per browser connection from it.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the two seam members and the two line formatters),
 * `server/index.ts` (the model and the per-connection seam) and the criterion.
 */

import { createRequire } from 'node:module';

import {
  createSessionAttractor,
  normalizeSpeakerVector,
  rejectSpeakerEmbedding,
  speakerCosine,
  type SessionAttractor,
} from './voice-speaker-attractor.js';
import {
  createSpeakerBank,
  observeSpeakerBank,
  type SpeakerBank,
} from './voice-speaker-bank.js';
import {
  decideSpeakerTracking,
  selectSpeakerSample,
  type SpeakerSampleSelection,
  type SpeakerTrackingDecision,
  type SpeakerWindowReading,
} from './voice-speaker-selector.js';
import {
  SPEAKER_TRACKING_THRESHOLDS,
  type SpeakerTrackingThresholds,
} from './voice-speaker-tracking-arm.js';

// ── the analysis window ──────────────────────────────────────────────────────────────────────────

/** The browser's PCM rate (mono PCM16) for Live Voice. */
export const SPEAKER_WINDOW_SAMPLE_RATE = 16_000;
/** The analysis window the selector was calibrated on (`windowSeconds`). */
export const SPEAKER_WINDOW_MS = 2_000;
/** The voiced/quiet judgement granularity inside a window. */
export const SPEAKER_SPEECH_SUBFRAME_MS = 20;
/**
 * The RMS floor for a 20 ms subframe to count as voiced, on the SAME PCM16 scale and with the same
 * absolute value as `voice-realtime-local-speech.ts`'s `LOCAL_SPEECH_RMS_THRESHOLD`: the 2026-10-12
 * measurement put silence at 1–26 and speech at 400–640. It is a coarse QUALITY gate for the selector
 * (is this window mostly speech?) — not a VAD, and never consulted by anything that forwards audio.
 */
export const SPEAKER_SPEECH_RMS = 250;

/** One completed analysis window, decoded from the browser's PCM16 frames. */
export type SpeakerWindow = {
  readonly samples: Int16Array;
  /** The window's start on the connection's clock (the frame's arrival minus the window length). */
  readonly startMs: number;
  readonly durationMs: number;
  /** The fraction of 20 ms subframes whose RMS clears {@link SPEAKER_SPEECH_RMS}. */
  readonly speechRatio: number;
};

/** The accumulating buffer the proxy feeds one frame at a time. */
export type SpeakerWindowAccumulator = {
  /**
   * Appends PCM16 and returns every window the append completed (normally zero or one).
   *
   * `sourceRate`, when declared, must be {@link SPEAKER_WINDOW_SAMPLE_RATE}: a browser that declares a
   * different rate is SKIPPED rather than resampled here, because a shadow reader that resampled
   * silently would be inventing the audio it is supposed to observe.
   */
  push(pcm: Buffer, options: { sourceRate?: number; atMs: number }): SpeakerWindow[];
  /** Samples buffered toward the next window. */
  readonly pendingSamples: number;
  /** Frames refused because their declared rate was not the analysis rate. */
  readonly skippedFrames: number;
  /** Windows completed so far. */
  readonly windows: number;
};

/**
 * Builds one connection's window accumulator.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (one per shadow connection) and the criterion, which
 * drives it with synthetic PCM to pin the window boundary and the rate refusal.
 */
export function createSpeakerWindowAccumulator(
  options: { sampleRate?: number; windowMs?: number; subframeMs?: number; speechRms?: number } = {},
): SpeakerWindowAccumulator {
  const sampleRate = options.sampleRate ?? SPEAKER_WINDOW_SAMPLE_RATE;
  const windowMs = options.windowMs ?? SPEAKER_WINDOW_MS;
  const subframeMs = options.subframeMs ?? SPEAKER_SPEECH_SUBFRAME_MS;
  const speechRms = options.speechRms ?? SPEAKER_SPEECH_RMS;
  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const subframeSamples = Math.max(1, Math.round((subframeMs / 1000) * sampleRate));

  let buffer = new Int16Array(windowSamples);
  let filled = 0;
  let windows = 0;
  let skippedFrames = 0;

  return {
    get pendingSamples() {
      return filled;
    },
    get skippedFrames() {
      return skippedFrames;
    },
    get windows() {
      return windows;
    },

    push(pcm: Buffer, pushOptions: { sourceRate?: number; atMs: number }): SpeakerWindow[] {
      const declaredRate = pushOptions.sourceRate;
      if (declaredRate !== undefined && declaredRate !== sampleRate) {
        skippedFrames += 1;
        return [];
      }
      const completed: SpeakerWindow[] = [];
      const sampleCount = Math.floor(pcm.length / 2);
      // The frame's own first sample, on the connection clock. A 20 ms frame puts it 20 ms back from
      // `atMs`; a multi-second SEGMENT frame (the segmented wire sends one frame per segment) puts it
      // as far back as the frame is long, which is what keeps the windows' `startMs` honest and
      // strictly increasing instead of all naming the same instant.
      const frameStartMs = pushOptions.atMs - (sampleCount / sampleRate) * 1000;
      const filledAtFrameStart = filled;
      for (let index = 0; index < sampleCount; index += 1) {
        buffer[filled] = pcm.readInt16LE(index * 2);
        filled += 1;
        if (filled === windowSamples) {
          // The window began `filledAtFrameStart` samples before this frame did; each further window
          // completed inside the SAME frame begins one window-length after the previous one.
          const startMs = Math.max(
            0,
            frameStartMs - (filledAtFrameStart / sampleRate) * 1000 + completed.length * windowMs,
          );
          completed.push({
            samples: buffer,
            startMs,
            durationMs: windowMs,
            speechRatio: voicedFraction(buffer, subframeSamples, speechRms),
          });
          windows += 1;
          buffer = new Int16Array(windowSamples);
          filled = 0;
        }
      }
      return completed;
    },
  };
}

/** The fraction of equal subframes whose RMS clears `speechRms`. */
function voicedFraction(samples: Int16Array, subframeSamples: number, speechRms: number): number {
  let voiced = 0;
  let subframes = 0;
  for (let start = 0; start + subframeSamples <= samples.length; start += subframeSamples) {
    let squares = 0;
    for (let index = start; index < start + subframeSamples; index += 1) {
      squares += samples[index] * samples[index];
    }
    if (Math.sqrt(squares / subframeSamples) >= speechRms) {
      voiced += 1;
    }
    subframes += 1;
  }
  return subframes === 0 ? 0 : voiced / subframes;
}

// ── the embedder and its one model ───────────────────────────────────────────────────────────────

/** Turns one window's PCM16 into a speaker embedding, or `null` when the model refuses it. */
export type SpeakerEmbedder = {
  readonly dim: number;
  embed(samples: Int16Array): Float32Array | null;
};

/** The process-wide CAM++ model: loaded once, read by every connection. */
export type SpeakerTrackerModel = {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly reason: string | null;
  /** The embedder once the load succeeded, else `null`. */
  embedder(): SpeakerEmbedder | null;
  close(): void;
};

/** The slice of `sherpa-onnx-node`'s speaker identification surface this file uses. */
type SherpaStream = {
  acceptWaveform(payload: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
};
type SherpaSpeakerExtractor = {
  readonly dim: number;
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  compute(stream: SherpaStream): Float32Array;
};
type SherpaSpeakerRuntime = {
  SpeakerEmbeddingExtractor: new (config: Record<string, unknown>) => SherpaSpeakerExtractor;
};

/** The dependency loader, overridable so the criterion never touches the native addon. */
export type SpeakerDependencyLoader = () => Promise<unknown>;

/**
 * Loads the CAM++ model ONCE and starts its load in the background.
 *
 * The composition root calls this only when `resolveSpeakerTracking` returned `shadow` AND a model
 * path — that condition is the switch. A load that FAILS writes exactly one line and leaves
 * `embedder()` at `null`, which is what makes the proxy's seam absent for every connection: a broken
 * speaker model must never take a voice connection down with it.
 */
export function createSpeakerTrackerModel(options: {
  modelPath: string;
  log?: (line: string) => void;
  loadDependency?: SpeakerDependencyLoader;
  sampleRate?: number;
}): SpeakerTrackerModel {
  const sampleRate = options.sampleRate ?? SPEAKER_WINDOW_SAMPLE_RATE;
  // LOADED THROUGH `createRequire`, deliberately. `sherpa-onnx-node` ships no type declarations, and a
  // literal `import('sherpa-onnx-node')` would be a TS7016 under this tsconfig; a non-literal one would
  // spend AC-394's non-literal-dynamic-import budget on a module that has no such need. A CommonJS
  // require of a fixed package name does neither, and the optional dependency stays optional.
  const load =
    options.loadDependency ??
    (() => Promise.resolve(createRequire(import.meta.url)('sherpa-onnx-node') as unknown));
  let status: 'loading' | 'ready' | 'failed' = 'loading';
  let reason: string | null = null;
  let embedder: SpeakerEmbedder | null = null;
  let closed = false;

  void load()
    .then((loaded) => {
      if (closed) {
        return;
      }
      const runtime = unwrapCommonJs(loaded) as unknown as SherpaSpeakerRuntime;
      if (typeof runtime.SpeakerEmbeddingExtractor !== 'function') {
        throw new Error('sherpa-onnx-node exposes no SpeakerEmbeddingExtractor constructor');
      }
      embedder = createSherpaSpeakerEmbedder(runtime, options.modelPath, sampleRate);
      status = 'ready';
      options.log?.(
        `speaker_tracking: CAM++ model loaded path=${options.modelPath} dim=${embedder.dim} (shadow: read-only)`,
      );
    })
    .catch((error: unknown) => {
      if (closed) {
        return;
      }
      status = 'failed';
      reason = describeError(error);
      options.log?.(
        `speaker_tracking: CAM++ model FAILED to load path=${options.modelPath} reason=${reason} — ` +
          'shadow stays off for every connection, voice is unaffected',
      );
    });

  return {
    get status() {
      return status;
    },
    get reason() {
      return reason;
    },
    embedder() {
      return embedder;
    },
    close() {
      closed = true;
      embedder = null;
    },
  };
}

/**
 * THE PROCESS-WIDE MODEL CACHE, owned here rather than by the composition root.
 *
 * Consumed by `server/index.ts`: a CAM++ ONNX session is expensive, so `modelFor` starts one path's
 * load on first use and returns that SAME model to every later connection that resolves to the
 * path. The map is the registry's private state — the composition root assembles one registry and
 * never holds the cache itself.
 *
 * A failed load is memoized inside the model, so a broken model is cached too: it must never take a
 * voice connection down, and it must not be retried on every connection.
 */
export class SpeakerTrackerRegistry {
  private readonly speakerTrackerModels = new Map<string, SpeakerTrackerModel>();

  /** Where the single load/failure line goes. */
  private readonly log: (line: string) => void;

  constructor(options: { log?: (line: string) => void } = {}) {
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The process-wide model for `modelPath`, loading it once on first use. */
  modelFor(modelPath: string): SpeakerTrackerModel {
    const existing = this.speakerTrackerModels.get(modelPath);
    if (existing !== undefined) {
      return existing;
    }
    const model = createSpeakerTrackerModel({ modelPath, log: this.log });
    this.speakerTrackerModels.set(modelPath, model);
    return model;
  }
}

/** Wraps the native extractor. One stream per window, released with it. */
function createSherpaSpeakerEmbedder(
  runtime: SherpaSpeakerRuntime,
  modelPath: string,
  sampleRate: number,
): SpeakerEmbedder {
  const extractor = new runtime.SpeakerEmbeddingExtractor({
    model: modelPath,
    numThreads: 1,
    debug: false,
    provider: 'cpu',
  });
  return {
    dim: extractor.dim,
    embed(samples: Int16Array): Float32Array | null {
      if (samples.length === 0) {
        return null;
      }
      const waveform = new Float32Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        waveform[index] = samples[index] / 32768;
      }
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples: waveform, sampleRate });
      stream.inputFinished();
      if (!extractor.isReady(stream)) {
        return null;
      }
      const raw: unknown = extractor.compute(stream);
      if (raw instanceof Float32Array) {
        return raw;
      }
      if (Array.isArray(raw)) {
        return Float32Array.from(raw as number[]);
      }
      return null;
    },
  };
}

// ── the seam ─────────────────────────────────────────────────────────────────────────────────────

/** One window's reading, exactly what the proxy logs. */
export type SpeakerShadowObservation = {
  /** 1-based window index on this connection. */
  readonly window: number;
  readonly atMs: number;
  /** Whether the window produced an embedding at all. */
  readonly embedded: boolean;
  /** Cosine to the session attractor. */
  readonly score: number;
  /** Cosine to the enrollment core, or `0` when this connection has none. */
  readonly coreScore: number;
  /** The dual-key verdict: `none` / `track` / `authorize`. */
  readonly decision: SpeakerTrackingDecision['decision'];
  /** `accept_tracking`. */
  readonly track: boolean;
  /** `authorize_tse`. */
  readonly authorizeTse: boolean;
  /** Cumulative accepted windows (the coverage numerator). */
  readonly accepted: number;
  /** Cosine of the connection's FIRST embedding to the core, or `null` with no core. */
  readonly firstVsCore: number | null;
  /** Whether the session cluster is still unconfirmed by the core. */
  readonly provisional: boolean;
  /** Whether this window re-anchored the session attractor on a core-confirmed cluster. */
  readonly reanchored: boolean;
  /** Where a 3–3.5 s sample would start, when a core-confirmed window has been selected. */
  readonly sampleStartMs: number | null;
  readonly sampleMs: number | null;
};

/** The connection-end totals. No audio, no per-sample PCM — readings only. */
export type SpeakerShadowSummary = {
  readonly windows: number;
  readonly accepted: number;
  /** `accepted / windows`; `0` before the first window. */
  readonly coverage: number;
  readonly firstVsCore: number | null;
  readonly reanchors: number;
  /** Windows observed while the session cluster was still provisional. */
  readonly provisional: number;
};

/** What the proxy is handed: two members, one per window and one per connection. */
export type VoiceSpeakerTrackerSeam = {
  /**
   * Observes one completed 2 s window. NEVER throws: an embedding failure is a reading with
   * `embedded: false`, because the caller is mid-frame and must not be taken down by a shadow reader.
   */
  observe(window: SpeakerWindow, atMs: number): SpeakerShadowObservation;
  summary(): SpeakerShadowSummary;
};

/**
 * Builds one connection's shadow seam.
 *
 * `core` is the enrollment centroid(s) this deployment has. Phase 1 ships no profile store, so the
 * composition root passes none: every session cluster is then `candidate`/provisional and
 * `authorizeTse` is always false — the SAFE posture (CONFIRMED-LABELS §6.5: a new cluster tracks and
 * is never authorized until the user or a second session confirms it). The mechanism is complete and
 * the criterion drives it with a core so the authorized path is proven.
 *
 * Consumers: `server/index.ts` (one per browser connection) and the criterion.
 */
export function createSpeakerTrackerSeam(options: {
  embed: (samples: Int16Array) => Float32Array | null;
  thresholds?: SpeakerTrackingThresholds;
  core?: readonly ArrayLike<number>[];
  /** The session key recorded in the bank. One connection is one session. */
  sessionKey?: string;
}): VoiceSpeakerTrackerSeam {
  const thresholds = options.thresholds ?? SPEAKER_TRACKING_THRESHOLDS;
  const sessionKey = options.sessionKey ?? 'connection';
  const cores = (options.core ?? [])
    .map((core) => normalizeSpeakerVector(core))
    .filter((core): core is Float32Array => core !== null);
  const coreCentroid = centroidOf(cores);
  const attractor: SessionAttractor = createSessionAttractor({
    core: coreCentroid,
    maxStepDegrees: thresholds.maxStepSessionDeg,
    trackThreshold: thresholds.track,
    matchFastThreshold: thresholds.matchFast,
  });
  let bank: SpeakerBank = createSpeakerBank({
    cores,
    k: thresholds.bankSize,
    track: thresholds.track,
    matchFast: thresholds.matchFast,
    consistencyMin: thresholds.consistencyMin,
  });

  let windows = 0;
  let accepted = 0;
  let provisionalWindows = 0;
  let reanchors = 0;
  let firstEmbedding: Float32Array | null = null;
  const history: SpeakerWindowReading[] = [];
  /** Keep the selection window bounded: only the most recent windows can be the user's start. */
  const HISTORY_LIMIT = 16;

  const selectorOptions = {
    windowSeconds: thresholds.windowSeconds,
    sampleSeconds: thresholds.sampleSeconds,
    speechRatioMin: thresholds.speechRatioMin,
    track: thresholds.track,
    matchFast: thresholds.matchFast,
  };

  return {
    observe(window: SpeakerWindow, atMs: number): SpeakerShadowObservation {
      windows += 1;
      let embedding: Float32Array | null = null;
      try {
        embedding = options.embed(window.samples);
      } catch {
        // Fail-OPEN on the same rule the model load follows: a shadow reader must never take the
        // connection down. The window still counts, with `embedded: false`.
        embedding = null;
      }
      const usable = embedding !== null && rejectSpeakerEmbedding(embedding) === null;
      const reading = attractor.observe(usable ? (embedding as Float32Array) : []);
      const coreScore = reading.coreScore ?? 0;

      let clusterConfirmedByCore = coreCentroid !== null && coreScore >= thresholds.matchFast;
      if (usable && embedding !== null) {
        const observed = observeSpeakerBank(bank, embedding, sessionKey, {
          track: thresholds.track,
          matchFast: thresholds.matchFast,
          consistencyMin: thresholds.consistencyMin,
          maxStepDegrees: thresholds.maxStepBankDeg,
        });
        bank = observed.bank;
        if (observed.action === 'matched-core') {
          clusterConfirmedByCore = true;
        }
        if (firstEmbedding === null) {
          firstEmbedding = normalizeSpeakerVector(embedding);
        }
      }

      const decision = decideSpeakerTracking(
        { sessionScore: reading.score, coreScore, clusterConfirmedByCore },
        selectorOptions,
      );
      if (decision.acceptTracking && usable) {
        accepted += 1;
      }
      if (reading.provisional) {
        provisionalWindows += 1;
      }
      if (reading.reanchored) {
        reanchors += 1;
      }

      history.push({
        startMs: window.startMs,
        durationMs: window.durationMs,
        speechRatio: window.speechRatio,
        scoreSession: reading.score,
        scoreCore: coreScore,
      });
      if (history.length > HISTORY_LIMIT) {
        history.shift();
      }
      const sample: SpeakerSampleSelection | null = selectSpeakerSample(history, selectorOptions);
      const firstVsCore =
        firstEmbedding === null || coreCentroid === null ? null : speakerCosine(firstEmbedding, coreCentroid);

      return {
        window: windows,
        atMs,
        embedded: usable,
        score: reading.score,
        coreScore,
        decision: decision.decision,
        track: decision.acceptTracking,
        authorizeTse: decision.authorizeTse,
        accepted,
        firstVsCore,
        provisional: reading.provisional,
        reanchored: reading.reanchored,
        sampleStartMs: sample === null ? null : sample.startMs,
        sampleMs: sample === null ? null : sample.durationMs,
      };
    },

    summary(): SpeakerShadowSummary {
      return {
        windows,
        accepted,
        coverage: windows === 0 ? 0 : accepted / windows,
        firstVsCore:
          firstEmbedding === null || coreCentroid === null
            ? null
            : speakerCosine(firstEmbedding, coreCentroid),
        reanchors,
        provisional: provisionalWindows,
      };
    },
  };
}

// ── the two log lines ────────────────────────────────────────────────────────────────────────────

/**
 * One `speaker_shadow` line: the readings AC7 names (score, decision, accepted count, first-vs-core,
 * provisional) and nothing that could reconstruct audio. It carries no samples, no bytes and no text.
 */
export function describeSpeakerShadowObservation(observation: SpeakerShadowObservation): string {
  return (
    `speaker_shadow window=${observation.window} atMs=${observation.atMs} ` +
    `score=${formatScore(observation.score)} core=${formatScore(observation.coreScore)} ` +
    `decision=${observation.decision} accepted=${observation.accepted} ` +
    `first_vs_core=${formatSigned(observation.firstVsCore)} provisional=${observation.provisional} ` +
    `reanchor=${observation.reanchored} embedded=${observation.embedded}` +
    (observation.sampleStartMs === null
      ? ''
      : ` sample=${observation.sampleStartMs}ms/${observation.sampleMs ?? 0}ms`)
  );
}

/** The connection-end summary line: totals only, on the same reading vocabulary as the per-window lines. */
export function describeSpeakerShadowSummary(summary: SpeakerShadowSummary): string {
  return (
    `speaker_shadow summary: windows=${summary.windows} accepted=${summary.accepted} ` +
    `coverage=${summary.coverage.toFixed(3)} first_vs_core=${formatSigned(summary.firstVsCore)} ` +
    `reanchors=${summary.reanchors} provisional=${summary.provisional}`
  );
}

/** Three decimals is the resolution the calibration is read at; extra digits are noise in a log. */
function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000';
}

/** `+0.090` / `-0.031` / `n/a` — the sign is the reading (is the session above or below the core?). */
function formatSigned(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

/** The normalized mean of the enrollment embeddings, or `null` when there are none. */
function centroidOf(cores: readonly Float32Array[]): Float32Array | null {
  if (cores.length === 0) {
    return null;
  }
  const mean = new Float32Array(cores[0].length);
  for (const core of cores) {
    if (core.length !== mean.length) {
      continue;
    }
    for (let index = 0; index < mean.length; index += 1) {
      mean[index] += core[index] / cores.length;
    }
  }
  return normalizeSpeakerVector(mean);
}

/** Unwraps a CommonJS default export (the addon ships as `module.exports`). */
function unwrapCommonJs(loaded: unknown): Record<string, unknown> {
  let value = loaded as Record<string, unknown> | undefined;
  for (let depth = 0; depth < 2 && value && typeof value === 'object' && 'default' in value; depth += 1) {
    const inner = value.default;
    if (inner === undefined || typeof inner !== 'object') {
      break;
    }
    value = inner as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

/** A short, log-safe rendering of a thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
