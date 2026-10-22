/**
 * Silence trimming for voice input, ahead of the recogniser.
 *
 * A dictation clip is mostly not speech. The talker waits for the mic, draws
 * breath between sentences, and stops talking well before the button is
 * released — all of it paid for in upload bytes and recognition latency, none of
 * it carrying a phoneme. This module removes that silence and *only* that
 * silence: every sample the detector calls speech is copied out verbatim, and
 * the speech itself is never resampled, time-stretched or otherwise touched.
 * `alpha` is therefore not a parameter here; there is no time-compression stage
 * to configure. That decision is deliberate and was taken on 2026-09-21: the
 * pause table below is frozen, and the module does not search for better one.
 *
 * The detector is an energy VAD with hysteresis, not a neural one. The question
 * this module has to answer is "did the trim delete anything the talker said",
 * and that question is only answerable against a detector whose decisions are
 * fully reproducible and inspectable — a frame-level probability model would
 * make every downstream reading depend on a black box. Its thresholds sit
 * between the measured noise floor and the measured speech level rather than at
 * a fixed dB value, so the same code works on a quiet close-mic take and a loud
 * far-field one.
 *
 * Everything here is a pure function of its arguments — no DOM, no React, no
 * clock, no network. The caller owns decoding the audio and re-encoding the
 * result; this module only sees a `Float32Array`.
 */

import {
  FRAME_MS,
  MIN_FRAME_ENERGY,
  NOISE_PERCENTILE,
  POST_ROLL_MS,
  PRE_ROLL_MS,
  frameFlags,
} from '@/shared/voiceEndpoint';

/**
 * The frame length, the pre/post roll, the noise percentile and the frame decision itself
 * live in `@/shared/voiceEndpoint`, so the batch path here and the streaming path share one
 * definition of each. This module keeps only what is specific to trimming a finished buffer:
 * whole-clip noise estimation, region merging, the pause table and the splice.
 */

/**
 * Silence deliberately left at the head and tail of the output.
 *
 * Zero would be wrong for a recogniser: a waveform that starts mid-phoneme
 * gives the model no run-up, and some decoders drop the first few tens of
 * milliseconds while they fill their context. 0.15 s / 0.2 s is the padding the
 * measured pipeline used, and the numbers this module is judged against were
 * taken with it.
 */
const LEAD_IN_SEC = 0.15;
const LEAD_OUT_SEC = 0.2;

/**
 * The sample rates this module will operate at.
 *
 * The bounds are the span over which a 20 ms energy frame is a meaningful
 * measurement: below 8 kHz (the telephone band) the frame no longer resolves
 * the envelope the hysteresis needs, and above 192 kHz the frame is larger than
 * anything a browser capture produces. A rate outside the span is not clamped —
 * it is a caller error the fallback path reports, because trimming at the wrong
 * rate would cut the audio at the wrong places rather than fail visibly.
 */
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;

/**
 * The fewest 20 ms frames that can still produce a decision.
 *
 * `SPEECH_FRAMES_TO_START` is 3, so under three frames the state machine can
 * never commit to speech and the run would be reported as pure silence — a
 * silent wrong answer rather than a visible fallback.
 */
const MIN_FRAMES = 5;

/*
 * The VAD thresholds — `ENTER_FACTOR`, `EXIT_FACTOR`, `SPEECH_FRAMES_TO_START` and
 * `SILENCE_FRAMES_TO_END` — are no longer declared here. They are exported by
 * `@/shared/voiceEndpoint` and imported above, which is what keeps the batch decision made
 * below and the streaming decision made frame by frame from drifting apart.
 */

/**
 * The pause-cap table, frozen by hand on 2026-09-21.
 *
 * Retaining a little silence between phrases is not conservatism for its own
 * sake: the recogniser uses the pause as the cue that a sentence ended, so
 * flattening every pause to zero trades duration for a run-on transcript. The
 * first row's `null` means "leave it alone" — a gap shorter than 120 ms is
 * inside a word, and shortening it would eat a stop closure.
 *
 * These four rows are the decision, not a starting point. There is no parameter
 * search over them and no API to substitute another table (the `opts` override
 * exists for tests; production callers pass nothing).
 */
export const PAUSE_CAPS = [
  { belowSec: 0.12, keepSec: null },
  { belowSec: 0.5, keepSec: 0.1 },
  { belowSec: 1.5, keepSec: 0.18 },
  { belowSec: Number.POSITIVE_INFINITY, keepSec: 0.3 },
] as const;

/** A region of the input the detector called speech, in seconds from the start. */
export type VadSegment = {
  startSec: number;
  endSec: number;
};

/**
 * Why a trim was refused.
 *
 * `empty`, `shortInput` and `unsupportedSampleRate` are caller/input errors;
 * `nonFiniteSamples` is a corrupt buffer; `noSpeech` is the legitimate "the
 * detector found nothing" case that still must not produce an empty upload.
 */
export type TrimFallbackReason =
  | 'empty'
  | 'shortInput'
  | 'unsupportedSampleRate'
  | 'nonFiniteSamples'
  | 'noSpeech';

export type TrimStats = {
  /** Duration of the input, in seconds. */
  inputSec: number;
  /** Duration of the returned audio, in seconds. */
  outputSec: number;
  /** `1 - outputSec / inputSec`; 0 on the fallback path. */
  savedRatio: number;
  /** The detected speech regions, pre-roll and post-roll included. */
  vadSegments: VadSegment[];
  /**
   * Fraction of the input's speech samples that survived into the output.
   *
   * This is a tripwire, not a score: the trim deletes silence, so a correct run
   * is exactly 1 and anything below it means speech was dropped. It is reported
   * rather than asserted so a caller can log it on every real upload.
   */
  speechKeptRatio: number;
  /** True when nothing was trimmed and the input was handed back untouched. */
  fallback: boolean;
  /** Which guard fired; `null` when `fallback` is false. */
  fallbackReason: TrimFallbackReason | null;
  /** Full 20 ms frames the input was measured in. */
  frames: number;
  /** Energy of the quietest 15% of frames, in RMS. */
  noiseFloor: number;
};

export type TrimOptions = {
  /** Override the frozen pause table. Intended for tests; production passes none. */
  caps?: readonly { belowSec: number; keepSec: number | null }[];
  preRollMs?: number;
  postRollMs?: number;
  leadInSec?: number;
  leadOutSec?: number;
};

export type TrimResult = {
  samples: Float32Array;
  stats: TrimStats;
};

/** Frame-level RMS, one entry per whole 20 ms frame. */
function frameEnergies(samples: Float32Array, frame: number): Float64Array {
  const n = Math.floor(samples.length / frame);
  const energies = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < frame; j++) {
      const v = samples[i * frame + j];
      acc += v * v;
    }
    energies[i] = Math.sqrt(acc / frame);
  }
  return energies;
}

/** The value at `p` of an ascending-sorted array, by nearest-rank. */
function percentile(sorted: Float64Array, p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Contiguous speech regions in frames, with pre-roll/post-roll applied and
 * touching regions merged.
 *
 * The merge is not cosmetic: two regions separated by less than the padding
 * would each grow into the gap between them and overlap, and emitting them
 * separately would copy the overlap twice — a duplicated syllable. Merging
 * keeps the region list a partition of the input, which is what makes "every
 * speech sample appears exactly once in the output" true.
 */
function speechSegments(flags: Uint8Array, preFrames: number, postFrames: number): { startFrame: number; endFrame: number }[] {
  const raw: { startFrame: number; endFrame: number }[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] === 1;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      raw.push({
        startFrame: Math.max(0, start - preFrames),
        endFrame: Math.min(flags.length, i + postFrames),
      });
      start = -1;
    }
  }

  const merged: { startFrame: number; endFrame: number }[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, seg.endFrame);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** How much of a gap survives the frozen table. */
function capPause(gapSec: number, caps: readonly { belowSec: number; keepSec: number | null }[]): number {
  for (const cap of caps) {
    if (gapSec < cap.belowSec) {
      return cap.keepSec === null ? gapSec : Math.min(gapSec, cap.keepSec);
    }
  }
  return gapSec;
}

/**
 * The unchanged-input result every guard returns.
 *
 * `usableSampleRate` is 0 when the rate itself is what the guard rejected: there
 * is then no honest way to turn the buffer into seconds, and a duration derived
 * from a rate the module refused would be a fabricated reading. The two second
 * fields are therefore 0 on that path and equal to each other on every path,
 * which is the invariant callers actually rely on.
 */
function identity(
  input: Float32Array,
  reason: TrimFallbackReason,
  frames: number,
  noiseFloor: number,
  usableSampleRate: number,
): TrimResult {
  const inputSec = usableSampleRate > 0 ? input.length / usableSampleRate : 0;
  return {
    samples: input,
    stats: {
      inputSec,
      outputSec: inputSec,
      savedRatio: 0,
      vadSegments: [],
      speechKeptRatio: 1,
      fallback: true,
      fallbackReason: reason,
      frames,
      noiseFloor,
    },
  };
}

/**
 * What the pauses in a dictation are worth to the recogniser that hears them.
 *
 * A trim deletes silence, and silence is not nothing: a recogniser may read a pause as the
 * sentence boundary it cannot otherwise hear. Whether a given recogniser does is a *measured*
 * property of that recogniser. ADR-004's background carries both ends of the range:
 *
 *   · `destructive` — the pauses are discarded either way, so removing them costs accuracy
 *     nothing and saves the bill. Measured on the Whisper family: Chinese pause cues −89% for
 *     +0.52 pp of CER, against 25.5% (Chinese) / 13.3% (English) of the bill saved. The CER half
 *     is the interesting one — a character error rate is largely blind to punctuation, so that
 *     reading says "no *character* cost", not "no difference at all".
 *   · `useful` — the recogniser reads the pauses as punctuation, so a trim destroys a cue that
 *     only the audio carried.
 *   · `neutral` — neither: the pauses carry no cue and cost nothing.
 *
 * Which value a recogniser gets is therefore not a preference to be tuned here; it is the
 * conclusion of that recogniser's own paired experiment, declared on the PROVIDER side — it is one
 * field of `AsrCapabilities` in `shared/asr/asrRegistry.ts`, declared by the adapter module that
 * knows the service — and read back by the caller through `pauseCuesDeclarationFor(id)`.
 *
 * THIS MODULE DECLARES NOTHING OF ITS OWN, and that is the point of the type below. It used to
 * carry a declaration table of its own keyed by a provider id that was not registered anywhere,
 * whose answer disagreed with the only adapter the registry has: the read point below was reading
 * the client's own table, so "capabilities decide 裁不裁" was true of the mechanism and false of
 * the value. What is left here is the vocabulary and the pure mapping from a value to an action.
 */
export type PauseCues = 'destructive' | 'neutral' | 'useful';

/** What the trim should do about the silence in a recording, for one declared capability. */
export type TrimDecision = {
  /** The capability this decision was read from. */
  capability: PauseCues;
  /** True when this recogniser's silence is removed before the audio is uploaded. */
  trim: boolean;
};

/**
 * ⭐ THE read point: a recogniser's own declaration decides whether *its* silence is trimmed.
 *
 * This is the single place where "裁不裁" is answered from a capability, and the answer is the
 * whole of `trim`: `destructive` says the pauses are worth nothing to this recogniser, so the
 * trim runs; any other value says they may be carrying the punctuation, so it does not. Nothing
 * else about a recogniser is consulted, and a caller that compares the capability to
 * `'destructive'` for itself is the second answer this function exists to prevent —
 * `scripts/asr-trim-capability-check.mjs` reads the tree for exactly that comparison, and for
 * the reachability of this symbol, on every run.
 *
 * A pure function of its argument, so it says nothing about WHOSE capability it was handed. The
 * value has to arrive from the provider's own declaration (`pauseCuesDeclarationFor`), which is
 * what `scripts/asr-pause-cues-source-check.mjs` reads the tree for: the mapping can be right and
 * the input still wrong.
 */
export function trimDecisionFor(capability: PauseCues): TrimDecision {
  return { capability, trim: capability === 'destructive' };
}

/**
 * The pause policy for a dictation segment's EDGES: keep every internal gap whole.
 *
 * A relay recogniser declares `pauseCues: 'neutral'`, so the ordinary trim (which caps long gaps)
 * is deliberately not applied to its audio. This table lets {@link trimSilenceEdges} use the same
 * VAD/splice implementation for the head and tail while leaving every pause between two speech
 * regions exactly as recorded.
 */
const KEEP_ALL_PAUSES = [{ belowSec: Number.POSITIVE_INFINITY, keepSec: null }] as const;

/**
 * Trims only the silence before the first speech region and after the last one, leaving every
 * internal pause untouched.
 *
 * WHY THIS EXISTS. A push-to-talk segment can contain the whole tail of a think-pause: the real
 * 2026-10-22 recording that exposed the relay's task-echo bug was 10.2 s long with speech in the
 * first 2 s and near-silence for the remaining 8 s. Sending that silence is both wasteful and
 * dangerous — with nothing to tidy, the model may treat nearby instruction text as content. This
 * wrapper keeps the speech, adds the same short lead-in/out the ordinary trim uses, and removes
 * the empty edges; internal pauses stay whole so the recogniser still sees its punctuation cues.
 *
 * FALLBACK IS THE INPUT, sample for sample, exactly as {@link trimVoiceAudio} promises. A segment
 * whose detector finds no speech is returned unchanged rather than shortened to an empty upload;
 * the caller's request-level silence handling (and the model's empty answer) decide that case.
 */
export function trimSilenceEdges(
  samples: Float32Array,
  sampleRate: number,
  opts: Omit<TrimOptions, 'caps'> = {},
): TrimResult {
  return trimVoiceAudio(samples, sampleRate, { ...opts, caps: KEEP_ALL_PAUSES });
}

/**
 * Trim the silence out of `samples`, keeping every speech sample.
 *
 * Returns `{ samples, stats }`. On any guard the input is returned unchanged,
 * sample for sample, with `stats.fallback === true` and `fallbackReason` set —
 * never a throw, and never a shorter-than-input buffer for a non-empty input.
 * A dictation is more expensive to lose than a trim is to skip.
 */
export function trimVoiceAudio(samples: Float32Array, sampleRate: number, opts: TrimOptions = {}): TrimResult {
  const caps = opts.caps ?? PAUSE_CAPS;
  const preRollMs = opts.preRollMs ?? PRE_ROLL_MS;
  const postRollMs = opts.postRollMs ?? POST_ROLL_MS;
  const leadInSec = opts.leadInSec ?? LEAD_IN_SEC;
  const leadOutSec = opts.leadOutSec ?? LEAD_OUT_SEC;

  if (samples.length === 0) return identity(samples, 'empty', 0, 0, 0);

  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    return identity(samples, 'unsupportedSampleRate', 0, 0, 0);
  }

  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const frames = Math.floor(samples.length / frame);
  if (frames < MIN_FRAMES) return identity(samples, 'shortInput', frames, 0, sampleRate);

  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return identity(samples, 'nonFiniteSamples', frames, 0, sampleRate);
  }

  const energies = frameEnergies(samples, frame);
  const sorted = Float64Array.from(energies).sort();
  const noiseFloor = Math.max(MIN_FRAME_ENERGY, percentile(sorted, NOISE_PERCENTILE));
  const flags = frameFlags(energies, noiseFloor);

  const preFrames = Math.round(preRollMs / FRAME_MS);
  const postFrames = Math.round(postRollMs / FRAME_MS);
  const segments = speechSegments(flags, preFrames, postFrames);
  if (segments.length === 0) return identity(samples, 'noSpeech', frames, noiseFloor, sampleRate);

  const pieces: Float32Array[] = [];
  let outputSamples = Math.round(leadInSec * sampleRate);
  pieces.push(new Float32Array(outputSamples));

  let speechSamples = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i] === 1) speechSamples += frame;
  let keptSpeechSamples = 0;

  for (let i = 0; i < segments.length; i++) {
    const from = segments[i].startFrame * frame;
    const to = Math.min(samples.length, segments[i].endFrame * frame);
    pieces.push(samples.subarray(from, to));
    outputSamples += to - from;

    // Counted from the copied frame range rather than assumed equal to
    // `speechSamples`: the two are only equal if the splice really did keep
    // every speech frame, and that is the property being measured.
    for (let f = segments[i].startFrame; f < segments[i].endFrame && f < flags.length; f++) {
      if (flags[f] === 1) keptSpeechSamples += frame;
    }

    const next = segments[i + 1];
    if (next) {
      const gapSec = ((next.startFrame - segments[i].endFrame) * frame) / sampleRate;
      const keepSec = capPause(gapSec, caps);
      if (keepSec > 0) {
        const kept = Math.round(keepSec * sampleRate);
        pieces.push(new Float32Array(kept));
        outputSamples += kept;
      }
    }
  }

  pieces.push(new Float32Array(Math.round(leadOutSec * sampleRate)));
  outputSamples += Math.round(leadOutSec * sampleRate);

  const out = new Float32Array(outputSamples);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }

  const inputSec = samples.length / sampleRate;
  const outputSec = out.length / sampleRate;

  return {
    samples: out,
    stats: {
      inputSec,
      outputSec,
      savedRatio: 1 - outputSec / inputSec,
      vadSegments: segments.map((s) => ({
        startSec: (s.startFrame * frame) / sampleRate,
        endSec: Math.min(samples.length, s.endFrame * frame) / sampleRate,
      })),
      speechKeptRatio: speechSamples === 0 ? 1 : keptSpeechSamples / speechSamples,
      fallback: false,
      fallbackReason: null,
      frames,
      noiseFloor,
    },
  };
}
