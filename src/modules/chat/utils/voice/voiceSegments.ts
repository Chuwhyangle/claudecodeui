/**
 * The voice segment pipeline: many upload-sized recordings of ONE utterance, transcribed
 * concurrently, returned out of order, and reassembled in the order they were spoken.
 *
 * WHY THIS IS A MODULE OF ITS OWN AND NOT A CHANGE TO THE EXISTING PATH. The single-keypress
 * capture is one press, one recording, one request — `useVoiceInput` owns that path and this
 * module is deliberately not on it. This one is the other shape: continuous capture cuts a
 * stream into segments (the boundaries come from `voiceEndpoint.ts`'s streaming VAD), each
 * segment becomes a request of its own, and the answers arrive in whatever order the network
 * finishes them. Grafting that onto the single-request path would put the pipeline's retries,
 * merges and dedup in front of a capture that has none of those needs.
 *
 * THE FIVE THINGS IT OWNS, AND NOTHING ELSE:
 *
 *   · a stable ordinal per segment — the answer's order is not the request's order, so the
 *     ordinal, not the completion time, is what the reassembly sorts on;
 *   · a bounded retry per segment — one flaky segment loses itself, not the sentence around it;
 *   · an explicit placeholder where a segment was lost — a failure is on the page, never a
 *     silent gap a reader would take for a swallowed word;
 *   · an overlap deduplicated once, at the seam between two segments — never a global dedup,
 *     because the same words said twice in different places are content, not duplication;
 *   · concurrency bounded to a provider's rate limit, and a short segment merged into a
 *     neighbour before it is submitted at all.
 *
 * IT IS A PURE MODULE. Its only reach into the outside world is the `transcribe` function it is
 * handed, which is what lets the whole of it be judged by a controllable fake provider under a
 * fixed seed before a real one is ever called. No DOM, no React, no `fetch`, no clock of its
 * own: the clock and the sleep are injected, and the defaults are the only places `Date.now`
 * and `setTimeout` appear.
 */

import type { VoiceSegment } from '@/shared/voiceEndpoint';

/**
 * Defaults for every knob the pipeline reads. They are named here rather than inlined so a
 * caller and a criterion can quote the same value instead of keeping two copies that drift.
 */
export const PIPELINE_DEFAULTS = {
  /**
   * Requests allowed in flight at once. A recogniser's rate limit is why this is bounded at all:
   * cutting a long recording into many short segments is exactly what would trip a
   * requests-per-minute cap, so the pool is what keeps the cut from being self-defeating.
   */
  concurrency: 3,
  /**
   * Retries AFTER the first attempt, per segment. Two retries means three attempts: enough to
   * ride out a transient refusal, few enough that a segment which is genuinely rejected does
   * not hold its worker (and, through it, the tail of the queue) for long.
   */
  maxRetries: 2,
  /** Base of the per-segment backoff in ms, doubled on each retry (250 → 500 → …). */
  retryBackoffMs: 250,
  /**
   * A segment this short is merged into the neighbouring segment before anything is submitted.
   * A sub-second "segment" is almost always the tail of a word caught by a forced cut, and a
   * request for it costs a full round trip for a syllable.
   */
  minSegmentSec: 1.5,
  /**
   * The most characters a seam may deduplicate. The audio overlap the segmenter leaves is
   * 0.3–0.5 s; this bounds the text side of that window so a coincidental long match at a seam
   * cannot delete a paragraph. It is a ceiling, not a target — a seam with no repeat deletes
   * nothing.
   */
  maxOverlapChars: 80,
} as const;

/** One segment as it goes on the wire: an ordinal, its span, and its own audio. */
export type SegmentPlan = {
  /** 0-based position in the sentence. The reassembly sorts on this and only this. */
  index: number;
  startSec: number;
  endSec: number;
};

/** A plan that carries the bytes to upload for it. */
export type SegmentJob = SegmentPlan & { blob: Blob };

/** The per-segment measurement the log line and the smoke read. */
export type SegmentTelemetry = {
  durationSec: number;
  bytes: number;
  /** End-to-end time for this segment, from first attempt to last answer. */
  latencyMs: number;
  /** How many times the recogniser was actually called for this segment. */
  attempts: number;
};

type SegmentMeasurement = SegmentPlan & SegmentTelemetry;

/**
 * What became of one segment. A discriminated pair rather than one shape with an optional
 * `text`, so "this segment produced nothing and that is a failure" cannot be read off `text`
 * being empty: a recogniser that legitimately answers with an empty string is not a failure,
 * and the placeholder is only owed to the one that is.
 */
export type SegmentOutcome =
  | (SegmentMeasurement & { ok: true; text: string })
  | (SegmentMeasurement & { ok: false });

/** The recogniser call the pipeline is driven with. It throws (or rejects) to signal failure. */
export type SegmentTranscribe = (job: SegmentJob) => Promise<string>;

export type SegmentPipelineOptions = {
  concurrency?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  /** The merge floor; also read by `planSegments`' own caller. */
  minSegmentSec?: number;
  maxOverlapChars?: number;
  /** The clock, injected so latency is measurable without touching a wall in a test. */
  now?: () => number;
  /** The backoff sleep, injected so a criterion does not pay two real waits per failed segment. */
  sleep?: (ms: number) => Promise<void>;
  /** Aborts the queue; the in-flight attempts finish, no new one starts. */
  signal?: AbortSignal;
};

/** The reassembled text plus the per-segment record it was assembled from. */
export type PipelineResult = {
  text: string;
  segments: SegmentOutcome[];
};

/**
 * Turns the segmenter's spans into the spans that will actually be submitted.
 *
 * A segment shorter than `minSegmentSec` is merged with the next ones until the group is long
 * enough to stand on its own (or the input runs out). A group's span is the convex hull of its
 * members — one continuous interval from the first member's start to the last member's end —
 * so "merged with a neighbour" never leaves a hole where the discarded short segment was.
 *
 * THE ORDINAL IS ASSIGNED HERE, once, and never again: it is the group's position in the
 * submitted sequence, which is what the reassembly and the placeholder both key off.
 *
 * The returned spans are contiguous whenever the input is (a merged group's start is its first
 * member's start, its end its last member's end, and a contiguous input's group boundaries abut).
 */
export function planSegments(
  raw: readonly VoiceSegment[],
  minSegmentSec: number = PIPELINE_DEFAULTS.minSegmentSec,
): SegmentPlan[] {
  const groups: [number, number][] = [];
  let i = 0;
  while (i < raw.length) {
    const first = i;
    let last = i;
    // Extend while the group is still too short to be a request worth making. `last + 1` keeps
    // the last segment in the input as its own group even when it is short: there is no
    // neighbour left to merge it into.
    while (last + 1 < raw.length && raw[last].endSec - raw[first].startSec < minSegmentSec) {
      last++;
    }
    groups.push([first, last]);
    i = last + 1;
  }

  return groups.map(([first, last], index) => ({
    index,
    startSec: raw[first].startSec,
    endSec: raw[last].endSec,
  }));
}

/** Two decimal places: enough to name a span in a placeholder, stable enough to compare. */
function formatSec(value: number): string {
  return value.toFixed(2);
}

/**
 * The explicit placeholder a lost segment leaves in the reassembled text.
 *
 * It carries the ordinal and the time range because those are the two facts a reader (or a
 * later retry) needs to know WHICH part of the sentence is missing — a bare "…" would be
 * indistinguishable from a pause the recogniser itself produced.
 */
export function segmentPlaceholder(plan: Pick<SegmentPlan, 'index' | 'startSec' | 'endSec'>): string {
  return `[segment ${plan.index} failed: ${formatSec(plan.startSec)}-${formatSec(plan.endSec)}s]`;
}

/**
 * A CJK character. Scripts written without spaces need a different boundary rule: the seam in
 * "你好世界" / "世界真大" is inside a run of characters that has no space to align on.
 */
const CJK = /[㐀-鿿豈-﫿]/;

function isSeparator(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return /\s/.test(text[index]);
}

/**
 * How many leading characters of `next` duplicate the tail of `acc`, or 0 when they do not.
 *
 * THE LONGEST MATCH WINS, AND IT HAS TO FALL ON A BOUNDARY. A segmenter's overlap puts a few
 * words in the tail of one segment and the head of the next; the longest suffix/prefix common
 * to the two is those words. But a match that ends or starts in the middle of a token is not
 * an overlap — it is two different words that happen to share letters — so a candidate is only
 * accepted when it ends at a space (or the end of the string), starts after a space (or the
 * start), or lies inside a run of CJK characters, where "a token" is not delimited by spaces.
 *
 * `minChars` is 2: a single character repeating at a seam is coincidence far more often than it
 * is the overlap, and a wrong dedup loses a character the speaker really said.
 */
export function overlapSuffixLength(
  acc: string,
  next: string,
  maxChars: number = PIPELINE_DEFAULTS.maxOverlapChars,
  minChars = 2,
): number {
  const limit = Math.min(maxChars, acc.length, next.length);
  for (let k = limit; k >= minChars; k--) {
    const head = next.slice(0, k);
    if (!acc.endsWith(head)) continue;
    const cjk = CJK.test(head);
    const nextBoundary = k === next.length || isSeparator(next, k) || cjk;
    const start = acc.length - k;
    const accBoundary = start === 0 || isSeparator(acc, start - 1) || cjk;
    if (nextBoundary && accBoundary) return k;
  }
  return 0;
}

/** One segment as the reassembly sees it: its ordinal, its text (or placeholder), and how it fared. */
export type ReassemblyPart = {
  index: number;
  text: string;
  /** Failed parts are placeholders: they are emitted, but nothing dedupes across them. */
  failed: boolean;
};

/**
 * Joins the parts in ordinal order, deduplicating the overlap at each seam exactly once.
 *
 * THE SEAM IS ONLY OPEN AFTER A KEPT SEGMENT. If the previous segment failed — or succeeded
 * with no text — its words are not in the output, so this segment's copy of the overlap is the
 * only copy of those words there is; deduplicating it away against nothing would delete speech
 * the recogniser did recover. The seam is the boundary between the two texts, not a search of
 * the whole document: the same phrase said twice far apart is content, and a global dedup would
 * silently drop the second one.
 *
 * Whitespace is normalized to single spaces between parts. A part with no overlap is appended
 * whole; a part whose head duplicates the tail of the accumulated text loses exactly that head.
 */
export function reassembleText(
  parts: readonly ReassemblyPart[],
  maxOverlapChars: number = PIPELINE_DEFAULTS.maxOverlapChars,
): string {
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  let acc = '';
  let seamOpen = false;
  for (const part of ordered) {
    const text = part.text.trim();
    if (part.failed) {
      acc = acc ? `${acc} ${text}` : text;
      seamOpen = false;
      continue;
    }
    if (!text) {
      seamOpen = false;
      continue;
    }
    const drop = seamOpen ? overlapSuffixLength(acc, text, maxOverlapChars) : 0;
    if (!acc) acc = text;
    else if (drop > 0) acc += text.slice(drop);
    else acc += ` ${text}`;
    seamOpen = true;
  }
  return acc;
}

/** The reassembled text for a set of outcomes. Failed segments become their placeholder. */
export function reassemble(
  outcomes: readonly SegmentOutcome[],
  maxOverlapChars: number = PIPELINE_DEFAULTS.maxOverlapChars,
): string {
  return reassembleText(
    outcomes.map((outcome) => ({
      index: outcome.index,
      text: outcome.ok ? outcome.text : segmentPlaceholder(outcome),
      failed: !outcome.ok,
    })),
    maxOverlapChars,
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs the queue: every segment submitted at most `concurrency` at a time, each retried up to
 * `maxRetries` times, the answers reassembled by ordinal.
 *
 * THE POOL IS A SHARED CURSOR, NOT A PARTITION. A worker that finishes takes the next unclaimed
 * segment; a fast segment does not leave a slow worker's neighbour waiting behind it. `cursor++`
 * is the whole synchronisation, and it is safe because JavaScript runs this line to completion —
 * no two workers can read the same value.
 *
 * THE RESULT IS ORDERED BY CONSTRUCTION. `outcomes[index]` is written by the worker that ran
 * that index, whatever order the workers finish in, so the returned array is already in ordinal
 * order and the reassembly does not have to trust the completion order at all.
 */
export async function runSegmentPipeline(
  jobs: readonly SegmentJob[],
  transcribe: SegmentTranscribe,
  options: SegmentPipelineOptions = {},
): Promise<PipelineResult> {
  const concurrency = Math.max(1, options.concurrency ?? PIPELINE_DEFAULTS.concurrency);
  const maxRetries = Math.max(0, options.maxRetries ?? PIPELINE_DEFAULTS.maxRetries);
  const retryBackoffMs = options.retryBackoffMs ?? PIPELINE_DEFAULTS.retryBackoffMs;
  const maxOverlapChars = options.maxOverlapChars ?? PIPELINE_DEFAULTS.maxOverlapChars;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  const measure = (job: SegmentJob, startedAt: number, attempts: number): SegmentMeasurement => ({
    index: job.index,
    startSec: job.startSec,
    endSec: job.endSec,
    durationSec: job.endSec - job.startSec,
    bytes: job.blob.size,
    latencyMs: now() - startedAt,
    attempts,
  });

  const attempt = async (job: SegmentJob): Promise<SegmentOutcome> => {
    const startedAt = now();
    let attemptsMade = 0;
    while (attemptsMade < maxRetries + 1 && !signal?.aborted) {
      attemptsMade++;
      try {
        const text = await transcribe(job);
        return { ...measure(job, startedAt, attemptsMade), ok: true, text };
      } catch {
        // The failure's own message is not this module's to keep: the placeholder names the
        // segment, and the reason was already logged where it happened. A retry is the only
        // response the pipeline has, and past the budget it stops having one.
        if (attemptsMade <= maxRetries && !signal?.aborted) {
          await sleep(retryBackoffMs * 2 ** (attemptsMade - 1));
        }
      }
    }
    return { ...measure(job, startedAt, attemptsMade), ok: false };
  };

  const outcomes: SegmentOutcome[] = new Array<SegmentOutcome>(jobs.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      outcomes[index] = await attempt(jobs[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

  return { text: reassemble(outcomes, maxOverlapChars), segments: outcomes };
}
