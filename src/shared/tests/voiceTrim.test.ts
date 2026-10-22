import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { test } from 'vitest';

import { trimSilenceEdges, trimVoiceAudio } from '@/shared/voiceTrim';

/*
 * The fixtures are synthesised, not recorded, and that is the point: each one
 * carries its own ground truth. A burst is placed at a known offset with a
 * known duration, so "this speech survived" is checked against where the speech
 * actually is rather than against what the detector reported — a detector that
 * returned no regions at all would otherwise make every survival assertion
 * vacuous, and a trim that deleted a whole utterance would still "agree with
 * itself".
 *
 * The gaps are laid out so that one fixture walks the whole pause table: 0.36 s
 * lands in the "keep as-is" row, 0.60 s, 1.20 s and 2.60 s in the three capping
 * rows. Each row's answer is asserted where the audio is, so a table that had
 * silently been re-tuned would red here rather than in a benchmark months later.
 */

const RATE = 16000;

/** The pause table exactly as it was frozen by hand — the reading, not the code. */
const TABLE = [
  { belowSec: 0.12, keepSec: null },
  { belowSec: 0.5, keepSec: 0.1 },
  { belowSec: 1.5, keepSec: 0.18 },
  { belowSec: Number.POSITIVE_INFINITY, keepSec: 0.3 },
] as const;

function expectedKeep(gapSec: number): number {
  for (const row of TABLE) {
    if (gapSec < row.belowSec) return row.keepSec === null ? gapSec : Math.min(gapSec, row.keepSec);
  }
  return gapSec;
}

type Burst = { atSec: number; durSec: number };

/**
 * A deterministic pseudo-random source.
 *
 * `Math.random()` would make the noise floor — and therefore every threshold
 * derived from it — different on each run, and a fixture whose detector
 * decisions move between runs cannot be used to assert an invariant.
 */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0x100000000) * 2 - 1;
  };
}

/** Silence at a known floor, with voiced bursts of a known length at known offsets. */
function synthesise(durationSec: number, bursts: readonly Burst[], noiseAmp = 0.0006): Float32Array {
  const total = Math.round(durationSec * RATE);
  const out = new Float32Array(total);
  const noise = noiseSource(0x5eed);
  for (let i = 0; i < total; i++) out[i] = noise() * noiseAmp;

  const ramp = Math.round(0.01 * RATE);
  for (const burst of bursts) {
    const from = Math.round(burst.atSec * RATE);
    const len = Math.round(burst.durSec * RATE);
    for (let i = 0; i < len && from + i < total; i++) {
      // A three-harmonic tone with raised edges: flat enough in energy for the
      // frame RMS to read it as speech, and without a click at either end that
      // a detector could mistake for a transient.
      const envelope = Math.max(0, Math.min(1, i / ramp, (len - 1 - i) / ramp));
      const phase = (2 * Math.PI * 140 * i) / RATE;
      const tone = Math.sin(phase) * 0.6 + Math.sin(2 * phase) * 0.3 + Math.sin(3 * phase) * 0.15;
      out[from + i] += tone * envelope * 0.25;
    }
  }
  return out;
}

/** First index at or after `from` where `needle` occurs sample-for-sample, or -1. */
function findExact(haystack: Float32Array, needle: Float32Array, from = 0): number {
  if (needle.length === 0) return -1;
  let at = haystack.indexOf(needle[0], from);
  while (at !== -1 && at + needle.length <= haystack.length) {
    let matches = true;
    for (let i = 1; i < needle.length; i++) {
      if (haystack[at + i] !== needle[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return at;
    at = haystack.indexOf(needle[0], at + 1);
  }
  return -1;
}

type Fixture = {
  name: string;
  durationSec: number;
  bursts: readonly Burst[];
  /** How many separate utterances the detector must find. Ground truth, counted by hand. */
  regions: number;
};

const FIXTURES: readonly Fixture[] = [
  {
    name: 'two utterances around a two-second pause',
    durationSec: 5.0,
    bursts: [
      { atSec: 0.6, durSec: 0.8 },
      { atSec: 3.4, durSec: 1.0 },
    ],
    regions: 2,
  },
  {
    name: 'five utterances walking the whole pause table',
    durationSec: 7.96,
    bursts: [
      { atSec: 0.6, durSec: 0.4 },
      { atSec: 1.36, durSec: 0.4 },
      { atSec: 2.36, durSec: 0.4 },
      { atSec: 3.96, durSec: 0.4 },
      { atSec: 6.96, durSec: 0.4 },
    ],
    regions: 5,
  },
  {
    name: 'one utterance split by a stop closure',
    durationSec: 2.3,
    bursts: [
      { atSec: 0.6, durSec: 0.5 },
      { atSec: 1.2, durSec: 0.5 },
    ],
    regions: 1,
  },
  {
    name: 'speech with lead-in and lead-out silence only',
    durationSec: 3.2,
    bursts: [{ atSec: 1.2, durSec: 0.8 }],
    regions: 1,
  },
];

/** Assert every region the detector reported is present in the output, in order. */
function assertSpeechSurvives(input: Float32Array, output: Float32Array, regions: readonly { startSec: number; endSec: number }[]): void {
  let cursor = 0;
  for (const [index, region] of regions.entries()) {
    const slice = input.subarray(Math.round(region.startSec * RATE), Math.round(region.endSec * RATE));
    const at = findExact(output, slice, cursor);
    assert.notEqual(at, -1, `region ${index} (${region.startSec.toFixed(3)}s) is missing from the output`);
    assert.ok(
      at >= cursor,
      `region ${index} was found at ${at}, before the previous region ended at ${cursor} — it was duplicated or reordered`,
    );
    cursor = at + slice.length;
  }
}

test('every speech region survives the trim sample for sample', () => {
  for (const fixture of FIXTURES) {
    const input = synthesise(fixture.durationSec, fixture.bursts);
    const { samples, stats } = trimVoiceAudio(input, RATE);

    // The premise first: the detector has to have found the utterances that are
    // really there, otherwise "they all survived" is a statement about nothing.
    assert.equal(
      stats.vadSegments.length,
      fixture.regions,
      `${fixture.name}: expected ${fixture.regions} regions, detector reported ${stats.vadSegments.length}`,
    );
    assert.equal(stats.fallback, false, `${fixture.name} must not fall back`);

    // Then the ground truth: each synthesised burst is still in the output.
    for (const burst of fixture.bursts) {
      const from = Math.round(burst.atSec * RATE);
      const len = Math.round(burst.durSec * RATE);
      const core = input.subarray(from + Math.round(len * 0.2), from + Math.round(len * 0.8));
      assert.notEqual(
        findExact(samples, core),
        -1,
        `${fixture.name}: the burst at ${burst.atSec}s was cut — its samples are not in the output`,
      );
    }

    // And the module's own account of what it kept, checked against the audio.
    assertSpeechSurvives(input, samples, stats.vadSegments);
    assert.equal(stats.speechKeptRatio, 1, `${fixture.name}: speech was dropped (speechKeptRatio ${stats.speechKeptRatio})`);
  }
});

test('every fixture comes back shorter than it went in', () => {
  for (const fixture of FIXTURES) {
    const input = synthesise(fixture.durationSec, fixture.bursts);
    const { samples, stats } = trimVoiceAudio(input, RATE);

    // Measured on the returned buffer, not on `stats.outputSec`: a module that
    // reported a saving while handing back the original audio would pass a
    // check that trusted its own arithmetic.
    assert.ok(
      samples.length < input.length,
      `${fixture.name}: ${input.length} samples in, ${samples.length} out — nothing was trimmed`,
    );
    assert.ok(stats.savedRatio > 0, `${fixture.name}: savedRatio is ${stats.savedRatio}`);
    assert.equal(stats.inputSec, input.length / RATE);
    assert.equal(stats.outputSec, samples.length / RATE);
  }
});

test('the pause table is applied row by row', () => {
  const fixture = FIXTURES[1];
  const input = synthesise(fixture.durationSec, fixture.bursts);
  const { samples, stats } = trimVoiceAudio(input, RATE);

  assert.equal(stats.vadSegments.length, fixture.bursts.length);

  // Where each region's copy starts, so the silence left between two of them is
  // the distance between them in the output — which is the table's answer.
  const starts: number[] = [];
  for (const [index, region] of stats.vadSegments.entries()) {
    const slice = input.subarray(Math.round(region.startSec * RATE), Math.round(region.endSec * RATE));
    const at = findExact(samples, slice, starts[index - 1] ?? 0);
    assert.notEqual(at, -1, `region ${index} is missing from the output`);
    starts.push(at);
  }

  const rowsUsed = new Set<number>();
  for (let i = 0; i + 1 < stats.vadSegments.length; i++) {
    const gapSec = stats.vadSegments[i + 1].startSec - stats.vadSegments[i].endSec;
    const keptSec = expectedKeep(gapSec);
    const keptSamples = starts[i + 1] - (starts[i] + Math.round((stats.vadSegments[i].endSec - stats.vadSegments[i].startSec) * RATE));

    assert.ok(
      Math.abs(keptSamples - Math.round(keptSec * RATE)) <= 1,
      `gap ${i} of ${gapSec.toFixed(3)}s kept ${keptSamples} samples, the table says ${Math.round(keptSec * RATE)}`,
    );

    const row = TABLE.findIndex((entry) => gapSec < entry.belowSec);
    rowsUsed.add(row);
  }

  // A table with three capping rows is only tested if all three fire, so the
  // coverage is asserted rather than assumed: four distinct rows, counted.
  console.log(`voiceTrim pause-table controls=${rowsUsed.size}/4 rows=[${[...rowsUsed].sort().join(',')}]`);
  assert.equal(rowsUsed.size, TABLE.length, `only rows [${[...rowsUsed].sort().join(',')}] were reached`);
});

test('a clip with no speech is handed back untouched instead of emptied', () => {
  const input = synthesise(2.0, []);
  const result = trimVoiceAudio(input, RATE);

  assert.equal(result.stats.fallback, true);
  assert.equal(result.stats.fallbackReason, 'noSpeech');
  assert.equal(result.samples.length, input.length, 'a silent clip must not become an empty upload');
  assert.equal(result.stats.vadSegments.length, 0);
  assert.equal(result.stats.outputSec, result.stats.inputSec);
  assert.equal(result.stats.savedRatio, 0);
});

test('an empty buffer, a stub of a buffer and a bad sample rate all fall back', () => {
  const cases: { name: string; samples: Float32Array; rate: number; reason: string }[] = [
    { name: 'empty', samples: new Float32Array(0), rate: RATE, reason: 'empty' },
    { name: 'one frame', samples: new Float32Array(320), rate: RATE, reason: 'shortInput' },
    { name: 'two frames', samples: new Float32Array(640), rate: RATE, reason: 'shortInput' },
    {
      name: 'four frames at 8 kHz',
      samples: new Float32Array(640),
      rate: 8000,
      reason: 'shortInput',
    },
    { name: 'rate 0', samples: new Float32Array(32000), rate: 0, reason: 'unsupportedSampleRate' },
    { name: 'rate -16000', samples: new Float32Array(32000), rate: -16000, reason: 'unsupportedSampleRate' },
    { name: 'rate NaN', samples: new Float32Array(32000), rate: Number.NaN, reason: 'unsupportedSampleRate' },
    { name: 'rate Infinity', samples: new Float32Array(32000), rate: Number.POSITIVE_INFINITY, reason: 'unsupportedSampleRate' },
    { name: 'rate 4000', samples: new Float32Array(32000), rate: 4000, reason: 'unsupportedSampleRate' },
    { name: 'rate 400000', samples: new Float32Array(32000), rate: 400000, reason: 'unsupportedSampleRate' },
  ];

  for (const item of cases) {
    const result = trimVoiceAudio(item.samples, item.rate);

    assert.equal(result.stats.fallback, true, `${item.name} did not fall back`);
    assert.equal(result.stats.fallbackReason, item.reason, `${item.name} reported the wrong reason`);
    // "As-is" means the identical buffer, not merely an equal-length one: the
    // caller may hold the original for the un-trimmed upload path.
    assert.equal(result.samples, item.samples, `${item.name} did not return the input buffer`);
    assert.equal(result.stats.savedRatio, 0, `${item.name} claimed a saving`);
    assert.equal(result.stats.outputSec, result.stats.inputSec, `${item.name} changed the duration`);
    assert.equal(result.stats.speechKeptRatio, 1, `${item.name} dropped speech`);
  }
});

test('a buffer with a non-finite sample falls back rather than propagating NaN', () => {
  const input = synthesise(2.0, [{ atSec: 0.6, durSec: 0.8 }]);
  input[1000] = Number.NaN;

  const result = trimVoiceAudio(input, RATE);
  assert.equal(result.stats.fallback, true);
  assert.equal(result.stats.fallbackReason, 'nonFiniteSamples');
  assert.equal(result.samples, input);
});

test('the module is a pure DSP function with no React and no DOM', () => {
  const modulePath = resolve(process.cwd(), 'src', 'shared', 'voiceTrim.ts');
  const source = readFileSync(modulePath, 'utf8');

  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1]);
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:|@\/|\.)/, `unexpected dependency: ${specifier}`);
  }

  for (const global of ['document', 'window', 'HTMLElement', 'localStorage', 'navigator', 'AudioContext']) {
    assert.equal(
      new RegExp(`\\b${global}\\b`).test(source),
      false,
      `the module must not touch ${global}`,
    );
  }
});

/*
 * `trimSilenceEdges` is the dictation-segment policy: edges only, every internal pause whole.
 *
 * The fixture says why this is a separate policy rather than a second table: two bursts separated
 * by a 0.4 s pause sit inside 4 s of audio. The ordinary trim would cap the pause; this one must
 * keep it, while still removing the >2 s of silence after the last burst. The survival ratio is
 * read as the tripwire — a trim that touched speech would take it below 1.
 */
test('trimSilenceEdges removes the empty edges and keeps every internal pause', () => {
  const speech = 0.8;
  const gap = 0.4;
  const samples = new Float32Array(RATE * 5);
  const burst = (fromSec: number, toSec: number) => {
    for (let i = Math.round(fromSec * RATE); i < Math.round(toSec * RATE); i += 1) {
      samples[i] = 0.3 * Math.sin((i / RATE) * 2 * Math.PI * 220);
    }
  };
  burst(0, speech);
  burst(speech + gap, speech + gap + speech);

  const result = trimSilenceEdges(samples, RATE);

  assert.equal(result.stats.fallback, false, 'the edges are a trim, not a fallback');
  assert.ok(result.stats.outputSec < 3, `the 3 s silent tail must be gone, got ${result.stats.outputSec}s`);
  assert.ok(result.stats.outputSec > speech * 2 + gap, `the internal ${gap}s pause must survive, got ${result.stats.outputSec}s`);
  assert.equal(result.stats.speechKeptRatio, 1, 'every detected speech sample must survive');
});

test('trimSilenceEdges returns a speechless buffer unchanged', () => {
  const samples = new Float32Array(RATE * 2);
  const result = trimSilenceEdges(samples, RATE);

  assert.equal(result.stats.fallback, true);
  assert.equal(result.stats.fallbackReason, 'noSpeech');
  assert.equal(result.samples.length, samples.length, 'a speechless segment is not shortened to an empty upload');
});

/*
 * The harness must not grow a second copy of the algorithm.
 *
 * This has already been paid for once: the AC-113 criterion measured a copy,
 * and that copy and the shipped module disagreed on 6 of 16 entries — the
 * criterion was reporting a survival rate the app could not produce. So the
 * shipped module is the only implementation, and this is the grep that says so,
 * in the place that runs on every commit rather than once by hand.
 */
const ALGORITHM_SYMBOLS = ['frameEnergies', 'frameFlags', 'speechSegments', 'capPause', 'trimVoiceAudio'];

/** Names of the algorithm's internals that `source` declares for itself. */
function algorithmCopies(source: string): string[] {
  return ALGORITHM_SYMBOLS.filter((name) =>
    new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(source),
  );
}

test('the trim harness holds no second copy of the algorithm', () => {
  const harnessDir = resolve(process.cwd(), 'experiments', 'voice-trim');

  // The absence is only worth asserting together with a presence: a detector
  // that matched nothing at all would pass the loop below and measure nothing.
  // The shipped module is a file that certainly does declare the algorithm, so
  // running the same detector over it is the positive control — and it is read
  // through the module's own path, so the control fails if the file moves.
  const shipped = readFileSync(resolve(process.cwd(), 'src', 'shared', 'voiceTrim.ts'), 'utf8');
  const control = algorithmCopies(shipped);
  assert.ok(
    control.length >= 4,
    `the copy detector is inert: it found only ${control.length} of ${ALGORITHM_SYMBOLS.length} symbols in the module itself`,
  );

  if (!existsSync(harnessDir)) return;

  const files = readdirSync(harnessDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  for (const file of files) {
    const copies = algorithmCopies(readFileSync(join(harnessDir, file), 'utf8'));
    assert.deepEqual(copies, [], `experiments/voice-trim/${file} re-declares ${copies.join(', ')}`);
  }

  console.log(`voiceTrim harness-uniqueness controls=${control.length}/${ALGORITHM_SYMBOLS.length} files=${files.length}`);
});

test('an algorithm copy in the harness would be caught by the detector above', () => {
  // The falsifier for the previous test: if the harness rule is satisfied only
  // because nothing was ever put there, this shows the same rule reds the
  // moment the copy appears.
  const copy = `import { trimVoiceAudio } from '@/shared/voiceTrim';\nfunction capPause(gap) { return gap; }\nconst frameEnergies = () => [];\n`;
  assert.deepEqual(algorithmCopies(copy), ['frameEnergies', 'capPause']);
});
