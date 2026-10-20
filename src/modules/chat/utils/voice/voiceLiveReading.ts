/**
 * The continuous voice path's own reading: what the VAD did, in numbers, per input.
 *
 * WHY IT EXISTS. Once the single continuous path shipped (`gap-voice-single-continuous-input-path`),
 * nothing answered "what did the VAD actually do?" — how much audio the cut saved, how many pieces
 * it went out as, whether the ceiling forced a cut, how long the speech sat in the buffer, how long
 * the first words took to appear. This module is that answer, and it is a PURE FUNCTION on purpose:
 * every number is derived from measurements the segmenter and the pipeline ALREADY take
 * (`SegmentTelemetry`, the segment's own WAV length, the segmenter's `forced` flag), so there is no
 * second timing implementation that could drift from the one the audio really travelled.
 *
 * THE COUNTERFACTUAL IS BUILT IN. "Before" is not a second run: `baseline` says what a path with no
 * VAD would have sent for the SAME recording — the whole thing, in one request — so every reading
 * carries its own A/B and a reader never has to reconstruct the no-VAD half from constants. The
 * `voiceVad=off` switch (see `@/shared/voiceDebug`) is the other half of the A/B: it makes the
 * counterfactual actually run, so a criterion can compare two real readings rather than trust one.
 *
 * WHAT IT IS NOT. Not a user-facing panel, not a running total, not an upload. The reading is
 * printed to the console and parked on a page global only while `voiceDebug` is on; nothing here
 * is ever shown to a user who did not ask for it.
 */

/**
 * Audio tokens the cost model charges per second of uploaded audio.
 *
 * `dashscope-omni` prices audio at about 7 tokens per second (see `voiceLiveSegmenter`'s min-length
 * note), against a fixed ~407-token prompt per request. The `est` prefix on every field this feeds
 * is deliberate: it is the same model, not a reading off a bill.
 */
export const AUDIO_TOKENS_PER_SEC = 7;

/** Token usage the recogniser reported for one answer, when it reported any. */
export type VoiceUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

/** One submitted segment, as the pipeline and the segmenter measured it. */
export type VoiceSegmentMetric = {
  /** Duration of THIS segment's uploaded audio, in seconds (the WAV that went on the wire). */
  sentSec: number;
  /** How many times the recogniser was actually called for it (retries included, so `>= 1`). */
  requests: number;
  /** End-to-end time from its first attempt to its last answer, in ms. */
  latencyMs: number;
  /** How long this segment's speech sat in the buffer before it was sent, in seconds. */
  waitSec: number;
  /** True when the ceiling closed it rather than a pause. */
  forced: boolean;
};

/** Everything the reading is built from — all of it already measured by the path itself. */
export type VoiceLiveMetrics = {
  /** Duration of the raw input: the whole recording, before any cut or filter. */
  recordedSec: number;
  /** The segments submitted for this input, in spoken order. */
  segments: readonly VoiceSegmentMetric[];
  /** From the first segment being cut to its text reaching the composer, in ms; null if none did. */
  firstTextLatencyMs: number | null;
  /** Cumulative usage the recogniser returned over this input, if it returned any. */
  usage?: VoiceUsage | null;
};

/**
 * One input's reading: the "after" (what the VAD sent) beside the "before" (`baseline`).
 */
export type VoiceLiveReading = {
  /** Raw input duration, in seconds. */
  recordedSec: number;
  /** Total uploaded duration, in seconds — the sum of the segments' own audio. */
  sentSec: number;
  /** The fraction of the recording the VAD kept OFF the wire: `1 - sentSec / recordedSec`. */
  savedRatio: number;
  /** How many segments the input was cut into. */
  segments: number;
  /** How many recogniser calls it cost, retries included. */
  requests: number;
  /** How many segments the ceiling (not a pause) closed. */
  forcedCuts: number;
  /** The longest single uploaded segment, in seconds. */
  longestSegmentSec: number;
  /** The longest any speech waited in the buffer before being sent, in seconds. */
  longestWaitSec: number;
  /** From the first cut to the first text in the composer, in ms; null when no text arrived. */
  firstTextLatencyMs: number | null;
  /** Each segment's request latency, in spoken order, in ms. */
  latencyMs: number[];
  /** `sentSec` under the audio-token model — an estimate, hence the name. */
  estAudioTokens: number;
  /** Cumulative usage the recogniser returned, or null when it returned none. */
  usage: VoiceUsage | null;
  /** What a path with no VAD would have sent for the same recording. */
  baseline: {
    /** The whole recording, in seconds. */
    sec: number;
    /** One request, always: no VAD means no cut. */
    requests: number;
    /** The whole recording under the audio-token model. */
    estAudioTokens: number;
  };
};

/**
 * Builds one input's reading out of the measurements the path already took.
 *
 * The arithmetic here is the whole product, so its shape is the contract: `savedRatio` is measured
 * against the recording (a fraction SAVED, so a VAD that cut nothing reads 0), `estAudioTokens` is
 * `sentSec × 7`, and `baseline` is the same recording with no cut at all. Every field is a pure
 * function of the metrics — no clock, no DOM, no network — which is what lets a criterion hand it
 * constructed metrics and read the arithmetic back.
 */
export function buildVoiceLiveReading(metrics: VoiceLiveMetrics): VoiceLiveReading {
  const { recordedSec, segments } = metrics;

  let sentSec = 0;
  let requests = 0;
  let forcedCuts = 0;
  let longestSegmentSec = 0;
  let longestWaitSec = 0;
  const latencyMs: number[] = [];

  for (const segment of segments) {
    sentSec += segment.sentSec;
    requests += segment.requests;
    if (segment.forced) forcedCuts += 1;
    if (segment.sentSec > longestSegmentSec) longestSegmentSec = segment.sentSec;
    if (segment.waitSec > longestWaitSec) longestWaitSec = segment.waitSec;
    latencyMs.push(segment.latencyMs);
  }

  // A recording of zero length saves nothing rather than dividing by it: an empty input is the one
  // case where the ratio has no meaning, and 0 (nothing saved) is the honest answer to "how much".
  const savedRatio = recordedSec > 0 ? 1 - sentSec / recordedSec : 0;

  return {
    recordedSec,
    sentSec,
    savedRatio,
    segments: segments.length,
    requests,
    forcedCuts,
    longestSegmentSec,
    longestWaitSec,
    firstTextLatencyMs: metrics.firstTextLatencyMs,
    latencyMs,
    estAudioTokens: sentSec * AUDIO_TOKENS_PER_SEC,
    usage: metrics.usage ?? null,
    baseline: {
      sec: recordedSec,
      requests: 1,
      estAudioTokens: recordedSec * AUDIO_TOKENS_PER_SEC,
    },
  };
}
