/**
 * The SPEAKER TRACKING ARM POINT: the settings-file switch that decides whether this deployment
 * observes speakers at all, the calibrated thresholds observation runs at, and the environment
 * escape hatch that overrides both for a test or an operator.
 *
 * THE SETTINGS FILE IS THE NORMAL ENTRY (2026-10-21 ruling). The `speakerTracking` block of
 * `voice-realtime.settings.json` names the mode, the model directory/file (or an explicit path),
 * the score thresholds and the selector's quality gate. `VOICE_SPEAKER_TRACKING` /
 * `VOICE_SPEAKER_MODEL_PATH` still work, but only as escape hatches: precedence is
 * `environment > settings file > default`, the same rule `summaryModel` and `runEndAck` follow.
 *
 * PHASE 1 IS SHADOW-ONLY. `mode: "shadow"` turns the observer on and NOTHING ELSE: the seam writes
 * `speaker_shadow` readings, and no frame, no client message, no commit and no audio behaviour
 * changes (see `voice-realtime-ws-proxy.service.ts`). `gate` and `tse` are deliberately NOT
 * accepted here — those are later phases with their own acceptance criteria — so naming one is
 * reported as an unknown value rather than quietly running shadow.
 *
 * The thresholds are the frozen values from `experiments/voice-tse-eval/thresholds.v1.json` (state
 * `provisional`): `track=0.30`, `matchFast=0.35`, `promote=0.40`, `consistencyMin=0.60`,
 * `maxStepSessionDeg=15`, `maxStepBankDeg=8`, `bankSize=4`, selector `windowSeconds=2`,
 * `sampleSeconds=3.5`, `speechRatioMin=0.6`, `minCoreSeconds=2`. They live in ONE exported set of
 * defaults so the settings loader, every consumer and the criterion read the same numbers.
 *
 * Consumers: `server/index.ts` (resolves per connection and logs one source line per effective
 * value), `voice-realtime-settings.ts` (validates the `speakerTracking` block against the defaults
 * below), `voice-realtime-speaker-seam.ts` (reads the merged thresholds) and the criterion.
 */

/** The switch. Unset/empty/`off` are all the shipped state. */
export const VOICE_SPEAKER_TRACKING_ENV = 'VOICE_SPEAKER_TRACKING';

/** The CAM++ ONNX weights. Shadow mode without this path degrades to `off`, out loud. */
export const VOICE_SPEAKER_MODEL_PATH_ENV = 'VOICE_SPEAKER_MODEL_PATH';

/** The only spelling that turns observation on in Phase 1. */
export const VOICE_SPEAKER_SHADOW = 'shadow';

/** The spelling that keeps everything off. */
export const VOICE_SPEAKER_OFF = 'off';

/** The `speaker-profile-v1` thresholds, frozen from the offline calibration. */
export type SpeakerTrackingThresholds = {
  /** `accept_tracking` floor. */
  readonly track: number;
  /** Core-confirmation floor; also the `authorize_tse` floor. */
  readonly matchFast: number;
  /** How strongly a candidate must match before it is promoted outside the two-session rule. */
  readonly promote: number;
  /** Two candidates at or above this cosine are mergeable. */
  readonly consistencyMin: number;
  /** The score margin the experiment reports alongside the two floors. */
  readonly margin: number;
  /** Max rotation of the session attractor per turn, in degrees. */
  readonly maxStepSessionDeg: number;
  /** Max rotation of a bank cluster per matched turn, in degrees. */
  readonly maxStepBankDeg: number;
  /** Cap on the learned part of the bank. */
  readonly bankSize: number;
  /** Selector analysis window, seconds. */
  readonly windowSeconds: number;
  /** Selector sample length, seconds. */
  readonly sampleSeconds: number;
  /** Selector's minimum voiced fraction of a window. */
  readonly speechRatioMin: number;
};

/** `thresholds.v1.json`'s values, verbatim. */
export const SPEAKER_TRACKING_THRESHOLDS: SpeakerTrackingThresholds = {
  track: 0.3,
  matchFast: 0.35,
  promote: 0.4,
  consistencyMin: 0.6,
  margin: 0.08,
  maxStepSessionDeg: 15,
  maxStepBankDeg: 8,
  bankSize: 4,
  windowSeconds: 2,
  sampleSeconds: 3.5,
  speechRatioMin: 0.6,
};

/**
 * The eight score/threshold values a settings file's `speakerTracking.thresholds` may set.
 *
 * Deliberately separate from {@link SpeakerTrackingThresholds}: that type is what the SEAM consumes
 * at run time (it also carries the selector's three values), while this one is the settings-file
 * surface an operator edits. The two are merged in {@link resolveSpeakerTrackingSettings}.
 */
export type SpeakerTrackingThresholdSettings = {
  /** `accept_tracking` floor. */
  readonly track: number;
  /** Core-confirmation floor; also the `authorize_tse` floor. */
  readonly matchFast: number;
  /** How strongly a candidate must match before it is promoted outside the two-session rule. */
  readonly promote: number;
  /** Two candidates at or above this cosine are mergeable. */
  readonly consistencyMin: number;
  /** The score margin the experiment reports alongside the two floors. */
  readonly margin: number;
  /** Max rotation of the session attractor per turn, in degrees. */
  readonly maxStepSessionDeg: number;
  /** Max rotation of a bank cluster per matched turn, in degrees. */
  readonly maxStepBankDeg: number;
  /** Cap on the learned part of the bank. */
  readonly bankSize: number;
};

/**
 * The four selector/quality values a settings file's `speakerTracking.quality` may set.
 *
 * `minCoreSeconds` is the frozen enrolment rule ("do not update the core with clips shorter than
 * 2 s", `thresholds.v1.json` `quality`); Phase 1 ships no profile store, so it is validated and
 * carried for the later phases, not read by the shadow seam.
 */
export type SpeakerTrackingQualitySettings = {
  /** Selector analysis window, seconds. */
  readonly windowSeconds: number;
  /** Selector sample length, seconds. */
  readonly sampleSeconds: number;
  /** Selector's minimum voiced fraction of a window. */
  readonly speechRatioMin: number;
  /** Minimum enrolled-clip length before the core may be updated, seconds. */
  readonly minCoreSeconds: number;
};

/** The shipped `speakerTracking.thresholds` block, derived from the frozen constant above. */
export const SPEAKER_TRACKING_THRESHOLD_DEFAULTS: SpeakerTrackingThresholdSettings = {
  track: SPEAKER_TRACKING_THRESHOLDS.track,
  matchFast: SPEAKER_TRACKING_THRESHOLDS.matchFast,
  promote: SPEAKER_TRACKING_THRESHOLDS.promote,
  consistencyMin: SPEAKER_TRACKING_THRESHOLDS.consistencyMin,
  margin: SPEAKER_TRACKING_THRESHOLDS.margin,
  maxStepSessionDeg: SPEAKER_TRACKING_THRESHOLDS.maxStepSessionDeg,
  maxStepBankDeg: SPEAKER_TRACKING_THRESHOLDS.maxStepBankDeg,
  bankSize: SPEAKER_TRACKING_THRESHOLDS.bankSize,
};

/** The shipped `speakerTracking.quality` block (`thresholds.v1.json` selector + quality). */
export const SPEAKER_TRACKING_QUALITY_DEFAULTS: SpeakerTrackingQualitySettings = {
  windowSeconds: 2,
  sampleSeconds: 3.5,
  speechRatioMin: 0.6,
  minCoreSeconds: 2,
};

/** The directory the default model path is built from, relative to the repository root. */
export const SPEAKER_TRACKING_MODEL_DIR_DEFAULT = 'models/speaker';

/** The CAM++ weights file the frozen calibration used. */
export const SPEAKER_TRACKING_MODEL_FILE_DEFAULT =
  '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

/**
 * A settings file's `speakerTracking` block, VALIDATED and default-filled by
 * `voice-realtime-settings.ts`.
 *
 * `modelPath` is already resolved: an explicit `modelPath` when the file named a non-empty one,
 * otherwise `join(modelDir, modelFile)` (relative to the process's working directory, which
 * `npm run server` sets to the repository root). `named` records which sub-keys the file actually
 * spelled, so the resolver can log `settings file` versus `default` per effective value.
 */
export type SpeakerTrackingSettingsBlock = {
  readonly mode: 'off' | 'shadow';
  readonly modelDir: string;
  readonly modelFile: string;
  /** The resolved model path (explicit, or `join(modelDir, modelFile)`). */
  readonly modelPath: string;
  readonly thresholds: SpeakerTrackingThresholdSettings;
  readonly quality: SpeakerTrackingQualitySettings;
  readonly named: {
    readonly mode: boolean;
    /** True when the file named any of `modelPath` / `modelDir` / `modelFile`. */
    readonly modelPath: boolean;
    readonly thresholds: readonly (keyof SpeakerTrackingThresholdSettings)[];
    readonly quality: readonly (keyof SpeakerTrackingQualitySettings)[];
  };
};

/** Where one effective speaker-tracking value came from. */
export type SpeakerTrackingValueSource = 'environment' | 'settings file' | 'default';

/** What the environment and the settings file asked for, and what actually takes effect. */
export type SpeakerTrackingResolution = {
  /** The effective mode. `off` whenever anything about the request is unusable. */
  readonly mode: 'off' | 'shadow';
  /** The model path as the winning source spelled it; `''` when nothing named one. */
  readonly modelPath: string;
  /** The frozen thresholds this deployment would run at, merged with the selector's three values. */
  readonly thresholds: SpeakerTrackingThresholds;
  /** The selector/quality values this deployment would run at. */
  readonly quality: SpeakerTrackingQualitySettings;
  /** Per-value provenance, for the `source=` log lines the deployment reads. */
  readonly sources: {
    readonly mode: SpeakerTrackingValueSource;
    readonly modelPath: SpeakerTrackingValueSource;
    readonly thresholds: Readonly<
      Record<keyof SpeakerTrackingThresholdSettings, SpeakerTrackingValueSource>
    >;
    readonly quality: Readonly<Record<keyof SpeakerTrackingQualitySettings, SpeakerTrackingValueSource>>;
  };
  /** The offending `VOICE_SPEAKER_TRACKING` value, or `null`. Non-null implies `mode === 'off'`. */
  readonly invalid: string | null;
  /** Why a `shadow` request was degraded to `off`, or `null` when it was not. */
  readonly degraded: 'model-path-missing' | null;
  /** Shape problems the settings loader refused, oldest first. Empty on a clean reading. */
  readonly problems: string[];
};

/**
 * The environment-only resolution, kept for callers and criteria written before the settings file
 * grew a `speakerTracking` block.
 *
 * `server/index.ts` now calls {@link resolveSpeakerTrackingSettings}, which reads the same
 * environment variables as the ESCAPE HATCH over the file. This function remains exported because
 * the env-only arm is still a supported deployment shape (AC8) and its four states are pinned by
 * `voice-realtime-speaker-tracker.test.ts`; it is exactly "environment > default", the tail of the
 * full precedence chain.
 *
 * EVERY outcome is reportable: when `log` is supplied, exactly one line is written — including the
 * unset case — because the review checklist for this phase asks for an attributable line in each of
 * the four states (unset, unknown, shadow-without-path, shadow-with-path). Silent-off is the usual
 * convention for a deployment switch, but here "was it even considered?" is a question an operator has
 * to be able to answer from the log alone.
 */
export function resolveSpeakerTracking(
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): SpeakerTrackingResolution {
  const modelPath = (env[VOICE_SPEAKER_MODEL_PATH_ENV] ?? '').trim();
  const raw = env[VOICE_SPEAKER_TRACKING_ENV];
  const value = raw === undefined ? '' : raw.trim().toLowerCase();
  const sources = {
    mode: value === '' ? ('default' as const) : ('environment' as const),
    modelPath: modelPath === '' ? ('default' as const) : ('environment' as const),
    thresholds: sourcesForDefaults(SPEAKER_TRACKING_THRESHOLD_DEFAULTS),
    quality: sourcesForDefaults(SPEAKER_TRACKING_QUALITY_DEFAULTS),
  };

  let resolution: SpeakerTrackingResolution;
  if (value === '' || value === VOICE_SPEAKER_OFF) {
    resolution = {
      mode: 'off',
      modelPath,
      thresholds: SPEAKER_TRACKING_THRESHOLDS,
      quality: SPEAKER_TRACKING_QUALITY_DEFAULTS,
      sources,
      invalid: null,
      degraded: null,
      problems: [],
    };
  } else if (value === VOICE_SPEAKER_SHADOW) {
    resolution =
      modelPath === ''
        ? {
            mode: 'off',
            modelPath,
            thresholds: SPEAKER_TRACKING_THRESHOLDS,
            quality: SPEAKER_TRACKING_QUALITY_DEFAULTS,
            sources,
            invalid: null,
            degraded: 'model-path-missing',
            problems: [],
          }
        : {
            mode: 'shadow',
            modelPath,
            thresholds: SPEAKER_TRACKING_THRESHOLDS,
            quality: SPEAKER_TRACKING_QUALITY_DEFAULTS,
            sources,
            invalid: null,
            degraded: null,
            problems: [],
          };
  } else {
    resolution = {
      mode: 'off',
      modelPath,
      thresholds: SPEAKER_TRACKING_THRESHOLDS,
      quality: SPEAKER_TRACKING_QUALITY_DEFAULTS,
      sources,
      invalid: raw as string,
      degraded: null,
      problems: [],
    };
  }
  if (log !== undefined) {
    log(describeSpeakerTracking(resolution, value === ''));
  }
  return resolution;
}

/**
 * Resolves speaker tracking for ONE connection from the settings file with the environment as the
 * escape hatch: `environment > settings file > default`.
 *
 * The file block arrives already VALIDATED and default-filled from
 * `voice-realtime-settings.ts`; `null` means "the file said nothing". The two environment variables
 * override only the mode and the model path — the thresholds and the quality gate have no
 * environment spelling, so their per-field provenance is `settings file` when the file named the
 * field and `default` otherwise.
 *
 * LOGGING. When `log` is supplied, one line per EFFECTIVE value is written in shadow mode, each
 * naming its source (`environment` / `settings file` / `default`). The off and degraded states say
 * why in one line each, so a reader can always answer "what ran, and where was it configured?".
 *
 * Consumers: `server/index.ts` (per connection, before the seam is built) and the criterion.
 */
export function resolveSpeakerTrackingSettings(options: {
  env: NodeJS.ProcessEnv;
  settings: SpeakerTrackingSettingsBlock | null;
  log?: (line: string) => void;
}): SpeakerTrackingResolution {
  const file = options.settings;
  const rawMode = options.env[VOICE_SPEAKER_TRACKING_ENV];
  const envMode = rawMode === undefined ? '' : rawMode.trim().toLowerCase();
  const envModelPath = (options.env[VOICE_SPEAKER_MODEL_PATH_ENV] ?? '').trim();

  let mode: 'off' | 'shadow' = 'off';
  let modeSource: SpeakerTrackingValueSource = 'default';
  let invalid: string | null = null;
  if (envMode !== '') {
    modeSource = 'environment';
    if (envMode === VOICE_SPEAKER_SHADOW) {
      mode = 'shadow';
    } else if (envMode === VOICE_SPEAKER_OFF) {
      mode = 'off';
    } else {
      mode = 'off';
      invalid = rawMode as string;
    }
  } else if (file !== null) {
    mode = file.mode;
    modeSource = file.named.mode ? 'settings file' : 'default';
  }

  let modelPath = '';
  let modelPathSource: SpeakerTrackingValueSource = 'default';
  if (envModelPath !== '') {
    modelPath = envModelPath;
    modelPathSource = 'environment';
  } else if (file !== null && file.modelPath !== '') {
    modelPath = file.modelPath;
    modelPathSource = file.named.modelPath ? 'settings file' : 'default';
  }

  // The file block is default-filled, so when it exists these merges are already complete; the
  // spread keeps the function correct for a hand-built block in a criterion.
  const thresholds = { ...SPEAKER_TRACKING_THRESHOLD_DEFAULTS, ...(file?.thresholds ?? {}) };
  const quality = { ...SPEAKER_TRACKING_QUALITY_DEFAULTS, ...(file?.quality ?? {}) };
  const thresholdSources = sourcesForBlock(
    SPEAKER_TRACKING_THRESHOLD_DEFAULTS,
    file?.named.thresholds ?? [],
  );
  const qualitySources = sourcesForBlock(SPEAKER_TRACKING_QUALITY_DEFAULTS, file?.named.quality ?? []);

  // The seam consumes the eleven-value shape (the eight thresholds plus the selector's three).
  const seamThresholds: SpeakerTrackingThresholds = {
    ...thresholds,
    windowSeconds: quality.windowSeconds,
    sampleSeconds: quality.sampleSeconds,
    speechRatioMin: quality.speechRatioMin,
  };

  let degraded: 'model-path-missing' | null = null;
  if (mode === 'shadow' && modelPath.trim() === '') {
    mode = 'off';
    degraded = 'model-path-missing';
  }

  const resolution: SpeakerTrackingResolution = {
    mode,
    modelPath,
    thresholds: seamThresholds,
    quality,
    sources: {
      mode: modeSource,
      modelPath: modelPathSource,
      thresholds: thresholdSources,
      quality: qualitySources,
    },
    invalid,
    degraded,
    problems: [],
  };

  if (options.log !== undefined) {
    for (const line of describeSpeakerTrackingSources(resolution)) {
      options.log(line);
    }
  }
  return resolution;
}

/** One `source=` line per effective value — the reading AC2 asks the log to carry. */
function describeSpeakerTrackingSources(resolution: SpeakerTrackingResolution): string[] {
  if (resolution.invalid !== null) {
    return [describeSpeakerTracking(resolution)];
  }
  if (resolution.degraded === 'model-path-missing') {
    return [describeSpeakerTracking(resolution)];
  }
  if (resolution.mode !== 'shadow') {
    return [`speaker_tracking: off source=${resolution.sources.mode}`];
  }
  const lines = [
    `speaker_tracking: mode=shadow source=${resolution.sources.mode}`,
    `speaker_tracking: modelPath=${resolution.modelPath} source=${resolution.sources.modelPath}`,
  ];
  for (const key of speakerTrackingThresholdKeys()) {
    lines.push(
      `speaker_tracking: thresholds.${key}=${resolution.thresholds[key]} ` +
        `source=${resolution.sources.thresholds[key]}`,
    );
  }
  for (const key of speakerTrackingQualityKeys()) {
    lines.push(
      `speaker_tracking: quality.${key}=${resolution.quality[key]} ` +
        `source=${resolution.sources.quality[key]}`,
    );
  }
  // The human-readable summary follows the values, so an operator sees both the provenance and what
  // it adds up to. It is the line the Phase 1 review checklist already knows.
  lines.push(describeSpeakerTracking(resolution));
  return lines;
}

/** The settings-file threshold keys, in the order a log reader expects (thresholds.v1.json's). */
function speakerTrackingThresholdKeys(): readonly (keyof SpeakerTrackingThresholdSettings)[] {
  return [
    'track',
    'matchFast',
    'promote',
    'consistencyMin',
    'margin',
    'maxStepSessionDeg',
    'maxStepBankDeg',
    'bankSize',
  ];
}

/** The settings-file quality keys, in `thresholds.v1.json`'s selector/quality order. */
function speakerTrackingQualityKeys(): readonly (keyof SpeakerTrackingQualitySettings)[] {
  return ['windowSeconds', 'sampleSeconds', 'speechRatioMin', 'minCoreSeconds'];
}

/** Every field of a defaults block came from the compiled-in default. */
function sourcesForDefaults<T extends Record<string, unknown>>(
  defaults: T,
): Readonly<Record<keyof T, SpeakerTrackingValueSource>> {
  const sources = {} as Record<keyof T, SpeakerTrackingValueSource>;
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    sources[key] = 'default';
  }
  return sources;
}

/** `settings file` for a field the file named, `default` for one it left alone. */
function sourcesForBlock<T extends Record<string, unknown>>(
  defaults: T,
  named: readonly (keyof T)[],
): Readonly<Record<keyof T, SpeakerTrackingValueSource>> {
  const sources = {} as Record<keyof T, SpeakerTrackingValueSource>;
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    sources[key] = named.includes(key) ? 'settings file' : 'default';
  }
  return sources;
}

/**
 * The one line to log for a resolution.
 *
 * `unset` distinguishes "the variable was never named" (or was named empty) from "it was named `off`":
 * both are the shipped state, and the line says which one this deployment chose.
 */
export function describeSpeakerTracking(
  resolution: SpeakerTrackingResolution,
  unset = false,
): string {
  if (resolution.invalid !== null) {
    return (
      `speaker_tracking: off — ${VOICE_SPEAKER_TRACKING_ENV}="${resolution.invalid}" is not one of ` +
      `${VOICE_SPEAKER_OFF}/${VOICE_SPEAKER_SHADOW} (Phase 1 is shadow-only), so nothing is observed`
    );
  }
  if (resolution.degraded === 'model-path-missing') {
    return (
      `speaker_tracking: off — ${VOICE_SPEAKER_TRACKING_ENV}=${VOICE_SPEAKER_SHADOW} needs ` +
      `${VOICE_SPEAKER_MODEL_PATH_ENV} (the CAM++ ONNX file), which is unset; nothing is observed`
    );
  }
  if (resolution.mode === 'shadow') {
    return (
      `speaker_tracking: shadow requested model=${resolution.modelPath} ` +
      `track=${resolution.thresholds.track} matchFast=${resolution.thresholds.matchFast} ` +
      `bankSize=${resolution.thresholds.bankSize} (read-only: no frame, client message or audio change)`
    );
  }
  return unset
    ? `speaker_tracking: off (${VOICE_SPEAKER_TRACKING_ENV} is unset; set it to ${VOICE_SPEAKER_SHADOW} to observe)`
    : `speaker_tracking: off (${VOICE_SPEAKER_TRACKING_ENV}=${VOICE_SPEAKER_OFF})`;
}
