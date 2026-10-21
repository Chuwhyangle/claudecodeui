/**
 * The SPEAKER TRACKING ARM POINT: the environment switch that decides whether this deployment observes
 * speakers at all, and the calibrated thresholds that observation runs at.
 *
 * PHASE 1 IS SHADOW-ONLY. `VOICE_SPEAKER_TRACKING=shadow` turns the observer on and NOTHING ELSE: the
 * seam writes `speaker_shadow` readings, and no frame, no client message, no commit and no audio
 * behaviour changes (see `voice-realtime-ws-proxy.service.ts`). `gate` and `tse` are deliberately NOT
 * accepted here — those are later phases with their own acceptance criteria — so naming one is reported
 * as an unknown value rather than quietly running shadow.
 *
 * The thresholds are the frozen values from `experiments/voice-tse-eval/thresholds.v1.json` (state
 * `provisional`): `track=0.30`, `matchFast=0.35`, `promote=0.40`, `consistencyMin=0.60`,
 * `maxStepSessionDeg=15`, `maxStepBankDeg=8`, `bankSize=4`, selector `windowSeconds=2`,
 * `sampleSeconds=3.5`, `speechRatioMin=0.6`. They live in ONE exported constant so every consumer and
 * the criterion read the same numbers.
 *
 * Consumers: `server/index.ts` (resolves at the composition root and logs the one line),
 * `voice-realtime-speaker-seam.ts` (reads the thresholds) and the criterion.
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

/** What the environment asked for, and what it actually gets. */
export type SpeakerTrackingResolution = {
  /** The effective mode. `off` whenever anything about the request is unusable. */
  readonly mode: 'off' | 'shadow';
  /** The model path as the environment spelled it; `''` when unset. */
  readonly modelPath: string;
  /** The frozen thresholds this deployment would run at. */
  readonly thresholds: SpeakerTrackingThresholds;
  /** The offending `VOICE_SPEAKER_TRACKING` value, or `null`. Non-null implies `mode === 'off'`. */
  readonly invalid: string | null;
  /** Why a `shadow` request was degraded to `off`, or `null` when it was not. */
  readonly degraded: 'model-path-missing' | null;
};

/**
 * Resolves the switch.
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

  let resolution: SpeakerTrackingResolution;
  if (value === '' || value === VOICE_SPEAKER_OFF) {
    resolution = {
      mode: 'off',
      modelPath,
      thresholds: SPEAKER_TRACKING_THRESHOLDS,
      invalid: null,
      degraded: null,
    };
  } else if (value === VOICE_SPEAKER_SHADOW) {
    resolution =
      modelPath === ''
        ? {
            mode: 'off',
            modelPath,
            thresholds: SPEAKER_TRACKING_THRESHOLDS,
            invalid: null,
            degraded: 'model-path-missing',
          }
        : {
            mode: 'shadow',
            modelPath,
            thresholds: SPEAKER_TRACKING_THRESHOLDS,
            invalid: null,
            degraded: null,
          };
  } else {
    resolution = {
      mode: 'off',
      modelPath,
      thresholds: SPEAKER_TRACKING_THRESHOLDS,
      invalid: raw as string,
      degraded: null,
    };
  }
  if (log !== undefined) {
    log(describeSpeakerTracking(resolution, value === ''));
  }
  return resolution;
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
