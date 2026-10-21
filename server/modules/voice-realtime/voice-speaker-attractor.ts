/**
 * The SESSION SPEAKER ATTRACTOR: what one Live Voice connection's own speech has sounded like so far.
 *
 * WHY A SESSION ATTRACTOR EXISTS AT ALL, AND WHY IT IS NOT AN AUTHORIZATION. The offline experiment
 * (`experiments/voice-tse-eval/CONFIRMED-LABELS.md` §3) measured both directions of the same failure:
 *
 *  - a non-target who speaks first forms a SELF-CONSISTENT cluster (7 of 13 splittable negatives did),
 *    and a session attractor alone then rejects 15/15 of the real user's turns — so the attractor
 *    cannot be the SOLE authority for "this is the user";
 *  - feeding the confirmed enrollment centroid (the CORE) alongside it accepts 15/15 of those same
 *    turns.
 *
 * Hence the dual-key rule this module is the first half of:
 *
 * ```
 * accept_tracking = max(score_session, score_core) >= TRACK
 * authorize_tse   = the cluster is confirmed by the core (score_core >= MATCH_FAST)
 * ```
 *
 * The attractor answers the TRACKING half — "does this turn sound like the person this connection has
 * been listening to?" — and reports its own drift and provisional state so a caller can re-anchor on
 * the core without ever learning a bystander as the user (CONFIRMED-LABELS §6.5).
 *
 * WHAT IT IS. A unit-normalized EMA centroid over successive turn embeddings, with a hard angular
 * ceiling on any SINGLE turn: one very different turn (a bystander handing the microphone over, a
 * device switch) can move the attractor by at most `maxStepDegrees`, and only a turn the CORE confirms
 * re-anchors it outright. Everything here is arithmetic over plain arrays — no I/O, no environment,
 * no clock — so the criterion drives every branch deterministically.
 *
 * Consumers: `voice-realtime-speaker-seam.ts` (the runtime glue) and its criterion
 * `server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts`.
 */

/** The smallest usable embedding. Anything shorter is a shape error, not a speaker. */
export const SPEAKER_MIN_DIMENSION = 2;

/** How much of each accepted turn's direction a default EMA update absorbs. */
export const SPEAKER_DEFAULT_EMA_ALPHA = 0.3;

/** Why an embedding was refused. `null` in a reading means the turn was usable. */
export type SpeakerEmbeddingRejection =
  | 'empty-embedding'
  | 'short-embedding'
  | 'non-finite-embedding'
  | 'zero-embedding'
  | 'mismatched-dimension';

/**
 * Classifies an embedding before it reaches the arithmetic. Kept separate from
 * {@link normalizeSpeakerVector} so a reading can say WHICH shape error it refused, rather than
 * collapsing every rejection into "null".
 */
export function rejectSpeakerEmbedding(vector: ArrayLike<number>): SpeakerEmbeddingRejection | null {
  if (vector.length === 0) {
    return 'empty-embedding';
  }
  if (vector.length < SPEAKER_MIN_DIMENSION) {
    return 'short-embedding';
  }
  let squares = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value)) {
      return 'non-finite-embedding';
    }
    squares += value * value;
  }
  return Number.isFinite(squares) && squares > 1e-12 ? null : 'zero-embedding';
}

/**
 * Unit-normalizes an embedding, or returns `null` for anything the speaker machinery cannot use.
 *
 * The returned vector is ALWAYS unit length, which is what lets every downstream score be a plain dot
 * product. Empty, too-short, non-finite and all-zero inputs are refused — a zero vector has no
 * direction and normalizing it would invent one.
 */
export function normalizeSpeakerVector(vector: ArrayLike<number>): Float32Array | null {
  if (rejectSpeakerEmbedding(vector) !== null) {
    return null;
  }
  let squares = 0;
  for (let index = 0; index < vector.length; index += 1) {
    squares += vector[index] * vector[index];
  }
  const scale = 1 / Math.sqrt(squares);
  const unit = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    unit[index] = vector[index] * scale;
  }
  return unit;
}

/**
 * The cosine similarity of two embeddings, in `[-1, 1]`.
 *
 * `0` — not an error, not a throw — whenever either side cannot be used or the dimensions differ: a
 * mismatched pair is two different models' vectors, and "no opinion" is the only honest score.
 */
export function speakerCosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const a = normalizeSpeakerVector(left);
  const b = normalizeSpeakerVector(right);
  if (a === null || b === null || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }
  return Math.max(-1, Math.min(1, dot));
}

/** The angle between two embeddings, in degrees (`0`…`180`). */
export function speakerAngleDegrees(left: ArrayLike<number>, right: ArrayLike<number>): number {
  return (Math.acos(speakerCosine(left, right)) * 180) / Math.PI;
}

/**
 * Rotates `from` toward `target` by at most `maxDegrees`, both taken as directions.
 *
 * THE CEILING IS THE POINT. A single turn may be a different person, so it may not drag the attractor
 * arbitrarily far in one step; it moves it at most this far, and the next turn has to earn the rest.
 * The rotation is on the unit sphere (a clamped slerp): `cos(max)·from + sin(max)·tangent`, where the
 * tangent is the component of `target` orthogonal to `from`.
 */
export function clampSpeakerStep(
  from: ArrayLike<number>,
  target: ArrayLike<number>,
  maxDegrees: number,
): Float32Array | null {
  const origin = normalizeSpeakerVector(from);
  const destination = normalizeSpeakerVector(target);
  if (origin === null || destination === null || origin.length !== destination.length) {
    return null;
  }
  const cosine = speakerCosine(origin, destination);
  const angleDegrees = (Math.acos(cosine) * 180) / Math.PI;
  if (angleDegrees <= maxDegrees) {
    return destination;
  }
  // Nearly antipodal: there is no unique shortest arc, so the attractor stays put rather than
  // spinning. (A score this low is far below TRACK and would not have reached this helper.)
  const sine = Math.sin((angleDegrees * Math.PI) / 180);
  if (sine <= 1e-9) {
    return origin;
  }
  const tangentRaw = new Float32Array(origin.length);
  for (let index = 0; index < origin.length; index += 1) {
    tangentRaw[index] = destination[index] - cosine * origin[index];
  }
  const tangent = normalizeSpeakerVector(tangentRaw);
  if (tangent === null) {
    return origin;
  }
  const radians = (maxDegrees * Math.PI) / 180;
  const rotated = new Float32Array(origin.length);
  for (let index = 0; index < origin.length; index += 1) {
    rotated[index] = origin[index] * Math.cos(radians) + tangent[index] * Math.sin(radians);
  }
  return normalizeSpeakerVector(rotated);
}

/** One turn's reading. Every field is derived from that turn and the attractor's state BEFORE it. */
export type SessionAttractorReading = {
  /** Turns observed so far, usable ones only. The first usable turn is turn 1. */
  readonly turns: number;
  /** Cosine to the session attractor BEFORE this turn (the first turn reads `1`). */
  readonly score: number;
  /** Cosine to the first accepted turn — how far the connection has moved from where it started. */
  readonly firstScore: number;
  /** Cosine to the enrollment core, or `null` when this connection has no core. */
  readonly coreScore: number | null;
  /** Whether the SESSION attractor accepted this turn (`score >= track`, or a core re-anchor). */
  readonly accepted: boolean;
  /** Whether the CORE accepted this turn (`coreScore >= matchFast`). */
  readonly acceptedByCore: boolean;
  /** Whether this turn RE-ANCHORED the attractor because the core confirmed a cluster the session had lost. */
  readonly reanchored: boolean;
  /** `true` until a core-confirmed turn is seen; a connection with no core never leaves it. */
  readonly provisional: boolean;
  /** Cumulative rotation applied to the attractor, in degrees. */
  readonly driftDegrees: number;
  /** Accepted turns so far. */
  readonly acceptedCount: number;
  /** Why this turn was refused, or `null` when it was usable. */
  readonly rejection: SpeakerEmbeddingRejection | null;
};

/** How to build a session attractor. */
export type SessionAttractorOptions = {
  /** The enrollment centroid this connection is measured against, or `null` when there is none. */
  core?: ArrayLike<number> | null;
  /** EMA weight of the newest turn. Defaults to {@link SPEAKER_DEFAULT_EMA_ALPHA}. */
  emaAlpha?: number;
  /** The per-turn angular ceiling, in degrees. The plan's `maxStepSessionDeg` is 15. */
  maxStepDegrees?: number;
  /** `accept_tracking`'s threshold. The calibrated value is 0.30. */
  trackThreshold?: number;
  /** The core's confirmation threshold. The calibrated value is 0.35. */
  matchFastThreshold?: number;
};

/** One connection's session attractor. */
export type SessionAttractor = {
  /** Observes one turn embedding and returns the reading for it. Refuses nothing silently. */
  observe(embedding: ArrayLike<number>): SessionAttractorReading;
  /** The current centroid, or `null` before the first usable turn. */
  readonly centroid: Float32Array | null;
  readonly first: Float32Array | null;
  readonly turns: number;
  readonly acceptedCount: number;
  readonly reanchors: number;
  readonly driftDegrees: number;
  readonly provisional: boolean;
};

/**
 * Builds the session attractor.
 *
 * Consumers: `voice-realtime-speaker-seam.ts`, which owns one per connection; the criterion reads the
 * same object to pin the angle ceiling, the EMA direction and the refusal cases.
 */
export function createSessionAttractor(options: SessionAttractorOptions = {}): SessionAttractor {
  const alpha = clampUnit(options.emaAlpha ?? SPEAKER_DEFAULT_EMA_ALPHA);
  const maxStep = Math.max(0, options.maxStepDegrees ?? 15);
  const track = options.trackThreshold ?? 0.3;
  const matchFast = options.matchFastThreshold ?? 0.35;
  const core = options.core == null ? null : normalizeSpeakerVector(options.core);

  let centroid: Float32Array | null = null;
  let first: Float32Array | null = null;
  let turns = 0;
  let acceptedCount = 0;
  let reanchors = 0;
  let driftDegrees = 0;
  let provisional = true;

  const reading = (
    score: number,
    firstScore: number,
    coreScore: number | null,
    accepted: boolean,
    acceptedByCore: boolean,
    reanchored: boolean,
    rejection: SpeakerEmbeddingRejection | null,
  ): SessionAttractorReading => ({
    turns,
    score,
    firstScore,
    coreScore,
    accepted,
    acceptedByCore,
    reanchored,
    provisional,
    driftDegrees,
    acceptedCount,
    rejection,
  });

  return {
    get centroid() {
      return centroid;
    },
    get first() {
      return first;
    },
    get turns() {
      return turns;
    },
    get acceptedCount() {
      return acceptedCount;
    },
    get reanchors() {
      return reanchors;
    },
    get driftDegrees() {
      return driftDegrees;
    },
    get provisional() {
      return provisional;
    },

    observe(embedding: ArrayLike<number>): SessionAttractorReading {
      const rejection = rejectSpeakerEmbedding(embedding);
      const unit = rejection === null ? normalizeSpeakerVector(embedding) : null;
      if (rejection !== null || unit === null) {
        // A refused turn changes NOTHING: it is not a speaker's direction, so it must not become the
        // anchor, move the attractor, or count toward coverage.
        return reading(0, first === null ? 0 : speakerCosine(embedding, first), core === null ? null : 0, false, false, false, rejection ?? 'zero-embedding');
      }
      const coreScore = core === null ? null : speakerCosine(unit, core);
      const acceptedByCore = coreScore !== null && coreScore >= matchFast;
      if (coreScore !== null && acceptedByCore) {
        // A core-confirmed turn is the ONE thing that may re-anchor: the cluster the connection is
        // hearing is the enrolled user, so any drift toward someone else is corrected here rather than
        // waited out — CONFIRMED-LABELS §3's "core 继续接受目标 turn，并在目标出现后 re-anchor".
        provisional = false;
      }

      if (centroid === null) {
        centroid = unit;
        first = unit;
        turns = 1;
        acceptedCount = 1;
        return reading(1, 1, coreScore, true, acceptedByCore, false, null);
      }

      turns += 1;
      const score = speakerCosine(unit, centroid);
      const firstScore = first === null ? 0 : speakerCosine(unit, first);

      if (acceptedByCore && score < track) {
        centroid = unit;
        acceptedCount += 1;
        reanchors += 1;
        return reading(score, firstScore, coreScore, true, true, true, null);
      }
      if (score < track) {
        // Below TRACK and not core-confirmed: the session attractor does not accept this turn and,
        // crucially, does not move toward it. A bystander is observed, never learned.
        return reading(score, firstScore, coreScore, false, acceptedByCore, false, null);
      }

      const blended = new Float32Array(centroid.length);
      for (let index = 0; index < centroid.length; index += 1) {
        blended[index] = (1 - alpha) * centroid[index] + alpha * unit[index];
      }
      const target = normalizeSpeakerVector(blended);
      const next = target === null ? centroid : (clampSpeakerStep(centroid, target, maxStep) ?? centroid);
      driftDegrees += speakerAngleDegrees(centroid, next);
      centroid = next;
      acceptedCount += 1;
      return reading(score, firstScore, coreScore, true, acceptedByCore, false, null);
    },
  };
}

/** Clamps a fractional knob into `[0, 1]`; a non-finite value falls back to the default behaviour. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return SPEAKER_DEFAULT_EMA_ALPHA;
  }
  return Math.max(0, Math.min(1, value));
}
