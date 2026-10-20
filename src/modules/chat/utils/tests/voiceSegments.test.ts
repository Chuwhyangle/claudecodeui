/**
 * The segment pipeline judged by a CONTROLLABLE FAKE PROVIDER. Every reading in this file is
 * taken against a transport this file owns, so a case can put a segment out of order, make one
 * segment refuse, or overlap two segments' texts — and then assert what the pipeline made of it.
 *
 * ONE KIND OF CASE LIVES HERE: the pipeline's own properties. A fixed seed drives ≥200 randomized
 * inputs per property, because the failure this module exists to prevent — a wrong order, a
 * swallowed segment, a deduplicated word that was never duplicated — is exactly the kind that a
 * hand-written two-segment example can miss. The seed is fixed and the generator is re-derivable:
 * a red says which iteration and which input produced it.
 *
 * The single-keypress regression this file used to carry is gone with the path it pinned: there is
 * no batch upload beside the pipeline any more (see `useVoiceInput`), and the file entry now runs
 * through this same pipeline. `voiceTrimCapabilityWiring.test.tsx` owns the reading that a chosen
 * file leaves as WAV segments.
 *
 * WHY THE PREFIX-OVERLAP CASES USE SPACE-SEPARATED TOKENS. The audio overlap the segmenter
 * leaves is a few words; the text dedup is word-aligned, so the constructed texts are built
 * from distinct tokens whose only shared run is the intended one. That makes the expected
 * reassembly computable by hand (it is the concatenation of the cores) rather than by a second
 * copy of the dedup rule, so a wrong dedup cannot hide behind an identically-wrong oracle.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { test } from 'vitest';

import { PIPELINE_DEFAULTS, planSegments, reassembleText, runSegmentPipeline, segmentPlaceholder } from '@/modules/chat/utils/voice/voiceSegments';
import type { SegmentJob, SegmentTranscribe } from '@/modules/chat/utils/voice/voiceSegments';
import { StreamingVad, type VoiceSegment } from '@/shared/voiceEndpoint';

// ── Shared generators ───────────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so every "randomized" case in this file is re-derivable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded permutation of `0..n-1`, used to make completion order differ from ordinal order. */
function permutation(rng: () => number, n: number): number[] {
  const values = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

type FakeProvider = {
  transcribe: SegmentTranscribe;
  /** How many times the recogniser was called for each ordinal. */
  calls: number[];
  /** The ordinals in the order their answers came back — the positive control for shuffling. */
  completionOrder: number[];
  /** The most calls in flight at any instant. */
  peak: number;
};

/**
 * A recogniser the case drives completely: it answers with `text(index)`, refuses when
 * `fail(index)`, and takes `delayTicks(index)` microtask turns before answering.
 *
 * The delay is counted in microtask turns rather than milliseconds so a case can dictate the
 * completion ORDER without paying wall-clock time for it: distinct tick counts finish in
 * ascending tick order, deterministically and fast.
 */
function fakeProvider(options: {
  text: (index: number) => string;
  fail?: (index: number) => boolean;
  delayTicks?: (index: number) => number;
}): FakeProvider {
  const calls: number[] = [];
  const completionOrder: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const transcribe: SegmentTranscribe = async (job) => {
    const index = job.index;
    calls[index] = (calls[index] ?? 0) + 1;
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      const ticks = options.delayTicks?.(index) ?? 0;
      for (let t = 0; t < ticks; t++) await Promise.resolve();
      if (options.fail?.(index)) throw new Error(`segment ${index} refused`);
      completionOrder.push(index);
      return options.text(index);
    } finally {
      inFlight--;
    }
  };
  // `peak` is read through a getter, not copied: a number returned in the object literal would
  // freeze at its initial 0 and the concurrency case would assert against a value no run moved.
  return { transcribe, calls, completionOrder, get peak() { return peak; } };
}

/** `n` jobs at ordinal `i`, spanning `[i, i+1)` seconds, each with a distinct byte payload. */
function jobsFor(n: number): SegmentJob[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    startSec: i,
    endSec: i + 1,
    blob: new Blob([new Uint8Array([i, i, i])], { type: 'audio/wav' }),
  }));
}

/** Options that keep the randomized loops fast: no real backoff, no real clock. */
const FAST = { concurrency: 3, maxRetries: 2, sleep: async () => {} } as const;

// ── AC: out-of-order answers reassemble in ordinal order ─────────────────────────────────────

const SHUFFLE_SEEDS = 200;

test('shuffled answers reassemble in ordinal order (≥200 seeded return orders)', async () => {
  let nonIdentityOrders = 0;
  let falsified = false;

  for (let seed = 1; seed <= SHUFFLE_SEEDS; seed++) {
    const rng = mulberry32(seed);
    const ticks = permutation(rng, 6);
    const fake = fakeProvider({ text: (i) => `w${i}a w${i}b`, delayTicks: (i) => ticks[i] });
    const { text, segments } = await runSegmentPipeline(jobsFor(6), fake.transcribe, FAST);

    const expected = Array.from({ length: 6 }, (_, i) => `w${i}a w${i}b`).join(' ');
    assert.equal(text, expected, `seed ${seed}: reassembled text is not in ordinal order`);
    assert.deepEqual(
      segments.map((s) => s.index),
      [0, 1, 2, 3, 4, 5],
      `seed ${seed}: the outcomes are not in ordinal order`,
    );

    if (fake.completionOrder.join(',') !== '0,1,2,3,4,5') {
      nonIdentityOrders++;
      // THE FALSE FORM, INSIDE THE CASE THAT WOULD HIDE IT: if the pipeline reassembled by
      // completion order, THIS run's text would be the completion order's concatenation. Assert
      // the two differ, so a case that only ever saw ordered completions cannot be mistaken for
      // a passing one.
      if (!falsified) {
        const byCompletion = fake.completionOrder.map((i) => `w${i}a w${i}b`).join(' ');
        assert.notEqual(text, byCompletion, `seed ${seed}: result looks reassembled by completion order`);
        falsified = true;
      }
    }
  }

  assert.ok(nonIdentityOrders > 0, 'no seed produced a shuffled completion order: the case is vacuous');
});

// ── AC: a failed segment is retried a bounded number of times and leaves a placeholder ───────

test('a segment that always fails is retried the configured times and leaves a placeholder', async () => {
  const n = 6;
  const maxRetries = 2;
  for (let failing = 0; failing < n; failing++) {
    const fake = fakeProvider({
      text: (i) => `w${i}a w${i}b`,
      fail: (i) => i === failing,
    });
    const { text, segments } = await runSegmentPipeline(jobsFor(n), fake.transcribe, {
      ...FAST,
      maxRetries,
    });

    // The rest of the sentence survives, in order, with its own ordinals.
    segments.forEach((outcome, i) => {
      assert.equal(outcome.index, i);
      if (i === failing) {
        assert.equal(outcome.ok, false, `failing=${failing}: segment ${i} should have failed`);
      } else {
        assert.equal(outcome.ok, true, `failing=${failing}: segment ${i} should have survived`);
        assert.equal(text.includes(`w${i}a w${i}b`), true, `failing=${failing}: segment ${i} text missing`);
      }
    });

    // The placeholder carries the ordinal and the span, and is not silently absent.
    const placeholder = segmentPlaceholder({ index: failing, startSec: failing, endSec: failing + 1 });
    assert.equal(text.includes(placeholder), true, `failing=${failing}: no placeholder for segment ${failing}`);
    assert.equal(
      placeholder,
      `[segment ${failing} failed: ${failing.toFixed(2)}-${(failing + 1).toFixed(2)}s]`,
      `failing=${failing}: the placeholder does not name the ordinal and the span`,
    );

    // The failure was retried EXACTLY the configured number of times — not more, not fewer.
    assert.equal(fake.calls[failing], maxRetries + 1, `failing=${failing}: wrong retry count`);
    for (let i = 0; i < n; i++) {
      if (i !== failing) assert.equal(fake.calls[i], 1, `failing=${failing}: segment ${i} was retried`);
    }
  }
});

// ── AC: randomized combinations of shuffle × failure × overlap ────────────────────────────────

const COMBINATION_SEEDS = 220;

test('shuffle × failure × overlap combinations reassemble to the ordinal-ordered expectation', async () => {
  for (let seed = 1000; seed < 1000 + COMBINATION_SEEDS; seed++) {
    const rng = mulberry32(seed);
    const n = 2 + Math.floor(rng() * 5); // 2..6

    // Distinct tokens per core, so the only shared run at a seam is the intended overlap. A
    // global counter keeps tokens unique across the whole case (and across cores).
    let token = 0;
    const cores: string[][] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < n; i++) {
      const len = 1 + Math.floor(rng() * 3);
      cores.push(Array.from({ length: len }, () => `w${seed}_${token++}`));
      starts.push(i * 2);
      ends.push(i * 2 + 1.5);
    }
    const overlap: boolean[] = Array.from({ length: n }, () => false);
    for (let i = 1; i < n; i++) overlap[i] = rng() < 0.5;

    const submitted = cores.map((core, i) =>
      overlap[i] ? [cores[i - 1][cores[i - 1].length - 1], ...core] : [...core],
    );
    const failed = new Set<number>();
    for (let i = 0; i < n; i++) if (rng() < 0.25) failed.add(i);

    const ticks = permutation(rng, n);
    const fake = fakeProvider({
      text: (i) => submitted[i].join(' '),
      fail: (i) => failed.has(i),
      delayTicks: (i) => ticks[i],
    });

    const jobs: SegmentJob[] = Array.from({ length: n }, (_, i) => ({
      index: i,
      startSec: starts[i],
      endSec: ends[i],
      blob: new Blob([new Uint8Array([i])], { type: 'audio/wav' }),
    }));
    const { text } = await runSegmentPipeline(jobs, fake.transcribe, { ...FAST, concurrency: 2 });

    // The expectation: each kept segment contributes its submitted tokens, minus the duplicated
    // head ONLY when the previous segment was kept (a failed predecessor leaves this segment's
    // copy as the only copy of those words). Failed segments contribute their placeholder.
    const expectedTokens: string[] = [];
    let previousKept = false;
    for (let i = 0; i < n; i++) {
      if (failed.has(i)) {
        expectedTokens.push(segmentPlaceholder({ index: i, startSec: starts[i], endSec: ends[i] }));
        previousKept = false;
        continue;
      }
      const tokens = previousKept && overlap[i] ? submitted[i].slice(1) : submitted[i];
      expectedTokens.push(...tokens);
      previousKept = true;
    }
    const expected = expectedTokens.join(' ');

    assert.equal(text, expected, `seed ${seed}: reassembled text diverged (n=${n}, failed=[${[...failed]}])`);
  }
});

// ── AC: overlap deduplicated once, and nothing deleted when there is no repeat ────────────────

test('a phrase repeated at a seam appears once; texts that do not repeat lose nothing', () => {
  const stitched = reassembleText(
    [
      { index: 0, text: 'the quick brown fox', failed: false },
      { index: 1, text: 'brown fox jumps over', failed: false },
    ],
    PIPELINE_DEFAULTS.maxOverlapChars,
  );
  assert.equal(stitched, 'the quick brown fox jumps over');
  assert.equal(stitched.match(/brown fox/g)?.length, 1, 'the overlap phrase was not deduplicated exactly once');

  const disjoint = reassembleText(
    [
      { index: 0, text: 'hello world', failed: false },
      { index: 1, text: 'goodbye moon', failed: false },
    ],
    PIPELINE_DEFAULTS.maxOverlapChars,
  );
  assert.equal(disjoint, 'hello world goodbye moon', 'characters were deleted from non-repeating texts');
});

test('deduplication is confined to the seam, not applied globally', () => {
  // The same phrase twice, but not adjacent: it is content, and must survive both times.
  const result = reassembleText(
    [
      { index: 0, text: 'alpha beta gamma', failed: false },
      { index: 1, text: 'delta epsilon', failed: false },
      { index: 2, text: 'alpha beta gamma', failed: false },
    ],
    PIPELINE_DEFAULTS.maxOverlapChars,
  );
  assert.equal(result, 'alpha beta gamma delta epsilon alpha beta gamma');
  assert.equal(result.match(/alpha beta gamma/g)?.length, 2);
});

// ── AC: concurrency is capped ─────────────────────────────────────────────────────────────────

test('the in-flight request count never exceeds the configured concurrency', async () => {
  const fake = fakeProvider({ text: (i) => `w${i}`, delayTicks: () => 2 });
  await runSegmentPipeline(jobsFor(6), fake.transcribe, { concurrency: 2, sleep: async () => {} });
  assert.ok(fake.peak <= 2, `peak in-flight ${fake.peak} exceeded the cap of 2`);
  // Positive control: the cap is a ceiling, but the pool must actually reach it, or "≤ 2" would
  // also be satisfied by a pipeline that serialized everything.
  assert.equal(fake.peak, 2, 'the pool never ran two requests at once: the cap is not load-bearing');
});

// ── AC: short segments merge before submission ────────────────────────────────────────────────

test('segments below the floor merge into a neighbour; the merged spans are continuous', async () => {
  // Contiguous spans, as the segmenter emits them: [0,3], [3,3.5], [3.5,4], [4,7].
  const raw: VoiceSegment[] = [
    { startSec: 0, endSec: 3, forced: false },
    { startSec: 3, endSec: 3.5, forced: true },
    { startSec: 3.5, endSec: 4, forced: true },
    { startSec: 4, endSec: 7, forced: false },
  ];
  const plans = planSegments(raw, 1.5);

  assert.ok(plans.length < raw.length, 'nothing was merged: the floor did not drop a short segment');
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((p) => [p.index, p.startSec, p.endSec]),
    [
      [0, 0, 3],
      [1, 3, 7],
    ],
  );

  // Continuous and gapless: each plan ends exactly where the next begins.
  for (let i = 0; i + 1 < plans.length; i++) {
    assert.equal(plans[i].endSec, plans[i + 1].startSec, `gap between plan ${i} and ${i + 1}`);
  }

  // And the pipeline submits the merged count, not the raw count.
  const fake = fakeProvider({ text: (i) => `w${i}` });
  const jobs: SegmentJob[] = plans.map((plan) => ({
    ...plan,
    blob: new Blob([new Uint8Array([plan.index])], { type: 'audio/wav' }),
  }));
  const { segments } = await runSegmentPipeline(jobs, fake.transcribe, { sleep: async () => {} });
  assert.equal(segments.length, plans.length, 'the merged plans were not what was submitted');
  assert.ok(segments.length < raw.length);
});

test('a short segment with no neighbour to merge into is left alone', () => {
  const plans = planSegments([{ startSec: 0, endSec: 0.4, forced: false }], 1.5);
  assert.deepEqual(plans, [{ index: 0, startSec: 0, endSec: 0.4 }]);
});

// ── DoD smoke: one real dashscope-omni call over the long corpus sample ───────────────────────
//
// OPT-IN, AND ON PURPOSE: this is the DoD's real-provider smoke, not one of the mechanical ACs.
// It is skipped unless VOICE_SEGMENT_SMOKE=1 so the scoped gate never needs a credential, and
// when it IS asked to run it FAILS LOUDLY if a credential is missing rather than falling back to
// a fake provider and reporting green — a smoke that silently swaps in a double proves nothing.

const SMOKE = process.env.VOICE_SEGMENT_SMOKE === '1';
const smokeTest = SMOKE ? test : test.skip;

/** Decodes a 16-bit PCM RIFF/WAVE file to channel-0 samples. Local, so the smoke has no ffmpeg. */
function decodeWav16Pcm(bytes: Buffer): { samples: Float32Array; sampleRate: number } {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') throw new Error('smoke: not a RIFF file');
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = 0;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }
  if (!channels || bits !== 16 || !dataStart) throw new Error('smoke: expected 16-bit PCM WAVE');
  const frameBytes = channels * 2;
  const frames = Math.floor(dataLength / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = bytes.readInt16LE(dataStart + i * frameBytes) / 32768;
  return { samples, sampleRate };
}

/** Encodes channel-0 samples as a 16-bit PCM WAVE the recogniser can take. */
function encodeWav16Pcm(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  // A plain ArrayBuffer the Buffer only views, so the returned Uint8Array is backed by an
  // ArrayBuffer and is a valid `BlobPart` under the typed-array-aware lib types.
  const backing = new ArrayBuffer(44 + dataBytes);
  const buffer = Buffer.from(backing);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return new Uint8Array(backing);
}

/** Wraps encoded samples in a Blob. `TypedArray.buffer` is widened to `ArrayBufferLike` by the
 * lib types, so the plain ArrayBuffer the encoder allocates is narrowed here, where a BlobPart
 * has to be an ArrayBuffer. */
function wavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav16Pcm(samples, sampleRate).buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** Sentence marks, for the DoD's "reassembled sentence count equals the truth" reading. */
function sentenceCount(text: string): number {
  const marks = text.match(/[。！？!?]+/g);
  if (marks) return marks.length;
  return text.trim() ? 1 : 0;
}

smokeTest('smoke: real dashscope-omni over L2-mixed.wav — segments, order, telemetry, sentence count', async () => {
  const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? '';
  if (!apiKey) {
    throw new Error(
      'voice segment smoke: DASHSCOPE_API_KEY is not set — the real dashscope-omni smoke cannot run, ' +
        'and it must NOT be downgraded to a fake provider that reports green',
    );
  }
  if (!baseUrl) {
    throw new Error('voice segment smoke: DASHSCOPE_BASE_URL is not set (the workspace endpoint, e.g. https://dashscope.aliyuncs.com)');
  }

  const corpusDir = process.env.VOICE_SMOKE_CORPUS ?? '/data/home/yale/work/tc-verify/corpus/long';
  const audioPath = `${corpusDir}/L2-mixed.wav`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(audioPath);
  } catch {
    throw new Error(`voice segment smoke: corpus sample not found at ${audioPath}`);
  }
  const manifest = JSON.parse(readFileSync(`${corpusDir}/manifest.json`, 'utf8')) as {
    id: string;
    segments: unknown[];
  }[];
  const sample = manifest.find((entry) => entry.id === 'L2-mixed');
  if (!sample) throw new Error(`voice segment smoke: manifest has no L2-mixed entry under ${corpusDir}`);

  const { samples, sampleRate } = decodeWav16Pcm(bytes);
  const vad = new StreamingVad({ sampleRate, overlapSec: 0.4 });
  vad.push(samples);
  const rawSegments = vad.flush();
  const plans = planSegments(rawSegments, PIPELINE_DEFAULTS.minSegmentSec);

  const { tryResolve } = await import('@shared/asr/asrRegistry');
  const adapter = tryResolve('dashscope-omni');
  if (!adapter) throw new Error('voice segment smoke: no dashscope-omni adapter is registered');
  const model = adapter.credentials?.defaultModel ?? 'qwen3.8-omni-flash';

  const usages = new Map<number, Record<string, number> | undefined>();
  const transcribe: SegmentTranscribe = async (job) => {
    const slice = samples.subarray(
      Math.max(0, Math.round(job.startSec * sampleRate)),
      Math.min(samples.length, Math.round(job.endSec * sampleRate)),
    );
    const result = await adapter.transcribe(
      {
        audio: {
          bytes: encodeWav16Pcm(slice, sampleRate),
          mimeType: 'audio/wav',
          fileName: `segment-${job.index}.wav`,
          durationSec: job.endSec - job.startSec,
        },
      },
      { baseUrl, apiKey, model, timeoutMs: 180_000, fetchImpl: fetch },
    );
    if (!result.ok) throw new Error(`segment ${job.index}: ${result.code}`);
    usages.set(job.index, result.meta?.usage);
    return result.text;
  };

  const jobs: SegmentJob[] = plans.map((plan) => ({
    ...plan,
    blob: wavBlob(
      samples.subarray(
        Math.max(0, Math.round(plan.startSec * sampleRate)),
        Math.min(samples.length, Math.round(plan.endSec * sampleRate)),
      ),
      sampleRate,
    ),
  }));

  const result = await runSegmentPipeline(jobs, transcribe, { concurrency: 2, maxRetries: 1, retryBackoffMs: 500 });

  for (const outcome of result.segments) {
    const usage = usages.get(outcome.index);
    // The per-segment reading the proposal asks to be able to reconstruct: ordinal, duration,
    // bytes, end-to-end latency, and the service's own usage beside them.
    console.info(
      `[voice:segments] index=${outcome.index} startSec=${outcome.startSec.toFixed(2)} endSec=${outcome.endSec.toFixed(2)} ` +
        `durationSec=${outcome.durationSec.toFixed(2)} bytes=${outcome.bytes} latencyMs=${outcome.latencyMs} attempts=${outcome.attempts} ` +
        `ok=${outcome.ok} usage=${usage ? Object.entries(usage).map(([k, v]) => `${k}:${v}`).join(',') : 'none'}`,
    );
  }

  const expectedSentences = sample.segments.length;
  const got = sentenceCount(result.text);
  assert.equal(
    got,
    expectedSentences,
    `voice segment smoke: reassembled ${got} sentences, truth has ${expectedSentences} (manifest.json)`,
  );
});

