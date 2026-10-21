/**
 * The SPEAKER SELECTOR: which 3–3.5 s window of a connection's audio belongs to the user, and the
 * dual-key decision that says whether that window may be tracked and whether it may authorize TSE.
 *
 * WHY A SELECTOR AND NOT "THE FIRST SPEECH". `run_selector_matrix.py` (CONFIRMED-LABELS §4) built the
 * four bystander-first sequences that decide this task's shape: when someone else speaks first,
 * VoxLock's `live()` locked onto the BYSTANDER in 3 of 4 sequences (median SI-SDRi(target) −2.26),
 * while scanning windows and keeping the first one the confirmed core accepts locked onto the TARGET
 * in 4 of 4 (median +15.56). So the sample is not "where speech started"; it is the earliest window
 * that is long enough, speech-dense enough, and — the load-bearing key — CONFIRMED BY THE CORE.
 *
 * THE DUAL KEY, WRITTEN OUT. The experiment's two keys answer different questions and must not be
 * conflated (§3):
 *
 * ```
 * accept_tracking = max(score_session, score_core) >= TRACK
 * authorize_tse   = the cluster is confirmed by the core (score_core >= MATCH_FAST)
 * ```
 *
 * A bystander who speaks first forms a perfectly good session cluster, so `accept_tracking` is TRUE
 * for them — and `authorize_tse` is FALSE, because the core does not recognize them. That asymmetry is
 * the whole safety property: tracking may follow whoever is speaking, authorization may not.
 *
 * Everything here is pure and takes pre-scored window readings, so the criterion can express the
 * bystander-first and gray-zone cases exactly. Consumers: `voice-realtime-speaker-seam.ts` and its
 * criterion.
 */

/** The 2 s analysis window the experiment swept (`windowSeconds`). */
export const SPEAKER_WINDOW_SECONDS = 2;
/** The sample length the experiment selected (`sampleSeconds`). */
export const SPEAKER_SAMPLE_SECONDS = 3.5;
/** The minimum voiced fraction of a window (`speechRatioMin`). */
export const SPEAKER_SPEECH_RATIO_MIN = 0.6;
/** The minimum length a window must span before it can be used at all. */
export const SPEAKER_MIN_WINDOW_MS = SPEAKER_WINDOW_SECONDS * 1000;
/** `TRACK`: the tracking floor. */
export const SPEAKER_TRACK_THRESHOLD = 0.3;
/** `MATCH_FAST`: the core-confirmation floor. */
export const SPEAKER_MATCH_FAST_THRESHOLD = 0.35;
/** The gray band between the two floors, where tracking is allowed and authorization is not. */
export const SPEAKER_GRAY_ZONE: readonly [number, number] = [
  SPEAKER_TRACK_THRESHOLD,
  SPEAKER_MATCH_FAST_THRESHOLD,
];

/** One scored analysis window. `scoreCore` is the embedding's max cosine to any enrolled core. */
export type SpeakerWindowReading = {
  readonly startMs: number;
  readonly durationMs: number;
  /** Voiced fraction of the window, `0`…`1`. */
  readonly speechRatio: number;
  /** Cosine to the session attractor at the time the window was scored. */
  readonly scoreSession: number;
  /** Cosine to the enrollment core, or `0` when this deployment has no core. */
  readonly scoreCore: number;
};

/** How to judge windows. Every knob is overridable so the criterion pins one dial at a time. */
export type SpeakerSelectorOptions = {
  windowSeconds?: number;
  sampleSeconds?: number;
  speechRatioMin?: number;
  track?: number;
  matchFast?: number;
};

/** The selected sample: where a TSE extractor would take its 3–3.5 s from. */
export type SpeakerSampleSelection = {
  /** The sample's start, on the connection's clock. */
  readonly startMs: number;
  /** The sample's length — `sampleSeconds`, clipped to the audio the windows actually cover. */
  readonly durationMs: number;
  /** The analysis window that selected it. */
  readonly windowStartMs: number;
  readonly scoreCore: number;
  readonly scoreSession: number;
};

/**
 * Whether one window clears the quality gate: long enough, and dense enough in speech.
 *
 * A window that is mostly silence is not a speaker sample — padding it would embed room tone. The
 * ratio floor is the experiment's `speechRatioMin = 0.6`.
 */
export function speakerWindowPassesQuality(
  window: SpeakerWindowReading,
  options: SpeakerSelectorOptions = {},
): boolean {
  const windowMs = (options.windowSeconds ?? SPEAKER_WINDOW_SECONDS) * 1000;
  const ratioMin = options.speechRatioMin ?? SPEAKER_SPEECH_RATIO_MIN;
  return window.durationMs >= Math.max(windowMs, SPEAKER_MIN_WINDOW_MS) && window.speechRatio >= ratioMin;
}

/**
 * Scans the windows in order and returns the EARLIEST quality-passing window the core confirms.
 *
 * Earliest, not best: the point of the selector is to find where the user started speaking, and a
 * later window with a marginally higher score buys nothing — it only delays the sample. A window whose
 * core score is below `matchFast` never selects, which is exactly the bystander-first case.
 */
export function selectSpeakerSample(
  windows: readonly SpeakerWindowReading[],
  options: SpeakerSelectorOptions = {},
): SpeakerSampleSelection | null {
  const sampleMs = (options.sampleSeconds ?? SPEAKER_SAMPLE_SECONDS) * 1000;
  const matchFast = options.matchFast ?? SPEAKER_MATCH_FAST_THRESHOLD;
  let lastEndMs = 0;
  for (const window of windows) {
    lastEndMs = Math.max(lastEndMs, window.startMs + window.durationMs);
  }
  for (const window of windows) {
    if (!speakerWindowPassesQuality(window, options) || window.scoreCore < matchFast) {
      continue;
    }
    // The sample may extend past the selecting window (2 s → 3.5 s) but never past the audio that was
    // actually observed: the last window's end is the end of the evidence. A window that is already
    // longer than the nominal sample keeps its own length rather than being truncated.
    const available = Math.max(window.durationMs, lastEndMs - window.startMs);
    return {
      startMs: window.startMs,
      durationMs: Math.max(window.durationMs, Math.min(sampleMs, available)),
      windowStartMs: window.startMs,
      scoreCore: window.scoreCore,
      scoreSession: window.scoreSession,
    };
  }
  return null;
}

/** What the dual key decided for one turn. */
export type SpeakerTrackingDecision = {
  /** `accept_tracking`: may the connection follow this cluster? */
  readonly acceptTracking: boolean;
  /** `authorize_tse`: may this cluster be used for target speech extraction? */
  readonly authorizeTse: boolean;
  /** A compact reading for the log line. */
  readonly decision: 'none' | 'track' | 'authorize';
  readonly reason:
    | 'below-track'
    | 'not-core-confirmed'
    | 'core-confirmed'
    | 'core-confirmation-inconsistent';
};

/**
 * Applies the dual key.
 *
 * `clusterConfirmedByCore` is the caller's reading of the CLUSTER (from the bank: a core cluster, or a
 * learned cluster whose centroid the core accepts). When omitted it is derived from `scoreCore`, which
 * is the same rule applied to this turn's embedding. Authorization is deliberately the conjunction of
 * all three — tracking accepted, the cluster confirmed, and this turn's own core score above
 * `matchFast` — so a caller cannot authorize on one reading alone.
 */
export function decideSpeakerTracking(
  input: {
    sessionScore: number;
    coreScore: number;
    clusterConfirmedByCore?: boolean;
  },
  options: SpeakerSelectorOptions = {},
): SpeakerTrackingDecision {
  const track = options.track ?? SPEAKER_TRACK_THRESHOLD;
  const matchFast = options.matchFast ?? SPEAKER_MATCH_FAST_THRESHOLD;
  const best = Math.max(input.sessionScore, input.coreScore);
  if (best < track) {
    // The GRAY ZONE's lower half: nothing is close enough to follow, so nothing is done at all.
    return { acceptTracking: false, authorizeTse: false, decision: 'none', reason: 'below-track' };
  }
  const confirmed = input.clusterConfirmedByCore ?? input.coreScore >= matchFast;
  if (!confirmed) {
    // The bystander-first case: the session tracks, the core does not authorize.
    return { acceptTracking: true, authorizeTse: false, decision: 'track', reason: 'not-core-confirmed' };
  }
  if (input.coreScore < matchFast) {
    // A caller said the cluster is confirmed while this turn's own core score is not: refuse the
    // authorization rather than allowing two readings of the same key to disagree.
    return {
      acceptTracking: true,
      authorizeTse: false,
      decision: 'track',
      reason: 'core-confirmation-inconsistent',
    };
  }
  return { acceptTracking: true, authorizeTse: true, decision: 'authorize', reason: 'core-confirmed' };
}
