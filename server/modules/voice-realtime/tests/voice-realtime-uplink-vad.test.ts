/**
 * Uplink VAD, node side — the grid contract, three backends on a known input, and the bypass reading.
 *
 * WHAT THIS FILE PINS. `voice-realtime-uplink-vad.ts` is the relay's speech / non-speech layer: three
 * interchangeable engines behind ONE frame contract, plus an honest reading for an engine that cannot
 * run. A VAD has two failure modes it is not allowed to have, and each gets its own group below rather
 * than a sentence in a comment: a frame that is not on the grid must be REFUSED rather than
 * reinterpreted (AC4), and an engine that cannot run must say so on every frame rather than quietly
 * passing everything through (AC3). A third group pins the property the experiments' numbers were taken
 * under — nothing is synthesized, so a gated frame is the caller's own byte at the caller's own offset
 * (AC5) — and a fourth reads the two absent-fixture states back as readings rather than as skips.
 *
 * THE TWO FIXTURES, AND WHY AN ABSENT ONE FAILS RATHER THAN SKIPS. There are no ONNX weights in this
 * repository; the models the experiments measured are probe copies under `~/work/voice-vad-engines/`.
 * The corpus is ONE real 16 kHz recording, because the synthetic candidates were tried and rejected — a
 * 300 Hz sine, its half-amplitude twin, a harmonic buzz and seeded broadband noise each read 1/60 frames
 * (Silero) and 0/60 (TEN), which is a reading about the fixtures, not about the engines. Both paths are
 * overridable (`VOICE_VAD_ENGINES_DIR`, `VOICE_VAD_CORPUS`) and a missing one FAILS the group that needs
 * it, with the path in the message: an absent fixture reported as a pass is the vacuous green these ACs
 * are written to exclude. AC3's group is deliberately the one group that needs neither fixture, so the
 * bypass reading is verified on any machine.
 *
 * THE EXPECTED VERDICTS ARE THE PYTHON ADAPTERS' OWN. The three bit strings below are
 * `experiments/voice-vad/engines/{silero,ten,webrtc}.py`'s `levels` rows, copied digit for digit from
 * their recorded output on this corpus, so AC2's per-backend reading is read against the PUBLISHED
 * measurement and not against a snapshot of this module. Silero's leading probabilities are copied the
 * same way, which is what makes the windowing comparable rather than merely self-consistent.
 *
 * ONE DELIBERATE DIVERGENCE, PINNED RATHER THAN HIDDEN. The Python adapters zero-pad a trailing partial
 * window; this module refuses to synthesize and leaves that window unrun. On this corpus the divergence
 * costs exactly ONE FRAME'S PROBABILITY — frame 225 keeps the last full window's 0.00137 where Python's
 * padded window writes 0.00132 — and no verdict at all. That is why the bit strings still match digit
 * for digit, why the probability comparison is scoped to the head, and why the tail is asserted
 * STRUCTURALLY (frame 225 carries its predecessor's reading) instead of against a copied number.
 *
 * Consumers: the quay worker's AC state for `gap-voice-uplink-vad-node-backends`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  UPLINK_VAD_BACKENDS,
  UPLINK_VAD_DEFAULT_AGGRESSIVENESS,
  UPLINK_VAD_DEFAULT_THRESHOLD,
  UPLINK_VAD_FRAME_BYTES,
  UPLINK_VAD_GRID,
  UplinkVadGridError,
  applyUplinkVadMask,
  classifyUplinkVadStream,
  createUplinkVadClassifier,
  describeUplinkVadBackend,
  readUplinkVadBackend,
  validateUplinkVadFrame,
  type UplinkVadBackendId,
  type UplinkVadClassifierOptions,
  type UplinkVadFrameVerdict,
} from '../voice-realtime-uplink-vad.js';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The module under audit, as a PATH, because AC5 and AC7 read it with a grep and not from a claim. */
const MODULE_FILE = path.join(HERE, '..', 'voice-realtime-uplink-vad.ts');

const ENGINES_DIR = process.env.VOICE_VAD_ENGINES_DIR ?? '/data/home/yale/work/voice-vad-engines';
const CORPUS_PATH =
  process.env.VOICE_VAD_CORPUS ??
  '/data/home/yale/work/vrc-dod-capture/2214a759-3c67-4425-b3df-57d3374971e8.wav';
const SILERO_WEIGHTS = path.join(ENGINES_DIR, 'silero', 'silero_vad.onnx');
const TEN_WEIGHTS = path.join(ENGINES_DIR, 'ten-vad', 'ten-vad.onnx');

/** The corpus's frame count, as the Python adapters report it. */
const PY_FRAME_COUNT = 226;

/** `engines/silero.py` — `levels['0.5']`. */
const PY_BITS: Record<UplinkVadBackendId, string> =
  {
    silero:
      '0000000000000000000000000000000000011111111111111111111111111111' +
      '1111111111111111111111111111111111111111111111111111111111110000' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000',
    // `engines/ten.py` — `levels['0.5']`.
    ten:
      '0000000000000000000000000000000000000000000000011111111111111111' +
      '1111111111111111111111111111111111111111111111111111111111111111' +
      '1111111111111111111111100000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000',
    // `engines/webrtc.py` — `levels['3']`, the mode this module defaults to.
    webrtc:
      '0000000000000000000000000000000000111111111111111111111111111111' +
      '1111111111111111111111111111111111111111111111111111111111111100' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000',
  };

/** `engines/silero.py`'s `probabilityPerFrame[0:8]`, to the five places it was recorded to. */
const PY_SILERO_PROB_HEAD = [0.00167, 0.00688, 0.00688, 0.00891, 0.00786, 0.00786, 0.00591, 0.00591];

/**
 * The experiment side's own cost row, from `docs/operations/voice-realtime-uplink-vad-scheme.md` §3 —
 * a 372.66 s corpus, every engine in ONE process. Quoted so the readings below have something to be
 * compared WITH; the comparable quantity across two different corpora is the RTF, not the wall time.
 */
const EXPERIMENT_ROWS: Record<UplinkVadBackendId, { rtf: number; wallSec: number; note: string }> = {
  silero: { rtf: 0.0027, wallSec: 1.008, note: 'threshold 0.5; the scheme doc’s recommended engine' },
  ten: { rtf: 0.0031, wallSec: 1.168, note: 'sherpa-onnx wrapper, threshold 0.5' },
  webrtc: { rtf: 0.0002, wallSec: 0.061, note: 'aggressiveness 1 in that row; this module defaults to 3' },
};

/** The scheme doc's process-RSS ceiling for all three engines loaded together (`rss_max_kb 137688`). */
const EXPERIMENT_RSS_CEILING_MB = 134.5;

/** Fails with the path in the message — an absent fixture must never read as a pass. */
function requireFile(file: string, why: string): string {
  try {
    readFileSync(file);
  } catch (error) {
    throw new Error(
      `${why}: ${file} could not be read (${(error as Error).message}). These are probe copies this ` +
        `repository does not check in; point VOICE_VAD_ENGINES_DIR / VOICE_VAD_CORPUS at them.`,
    );
  }
  return file;
}

/** The WAV's `data` chunk — the PCM16 bytes, with no decoder and no resampling. */
function readWavPcm16(file: string): Buffer {
  const raw = readFileSync(file);
  let offset = 12;
  while (offset + 8 <= raw.length) {
    const id = raw.toString('ascii', offset, offset + 4);
    const size = raw.readUInt32LE(offset + 4);
    if (id === 'data') return raw.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

let corpusCache: Buffer | null = null;

/** The corpus, ONCE — the mask legs compare against the very Buffer the backends were fed. */
function corpus(): Buffer {
  if (corpusCache === null) {
    const pcm = readWavPcm16(requireFile(CORPUS_PATH, 'AC2/AC5/AC6 need the known-input corpus'));
    if (pcm.length % UPLINK_VAD_FRAME_BYTES !== 0) {
      throw new Error(`the corpus is ${pcm.length} bytes, not a whole number of grid frames`);
    }
    corpusCache = pcm;
  }
  return corpusCache;
}

/** A frame with no zero byte in it, so a synthesized silence frame can never pass for one of these. */
function markedFrame(fill: number): Buffer {
  return Buffer.alloc(UPLINK_VAD_FRAME_BYTES, fill);
}

/** `grep -cE`, as the ACs spell it, with grep's own "exit 1 means zero matches" folded into the count. */
function grepCount(pattern: string, file: string): number {
  try {
    return Number(execFileSync('grep', ['-cE', pattern, file], { encoding: 'utf8' }).trim());
  } catch (error) {
    if ((error as { status?: number }).status === 1) return 0;
    throw error;
  }
}

const rssMb = (): number => process.memoryUsage().rss / 1048576;
const cpuMs = (usage: NodeJS.CpuUsage): number => (usage.user + usage.system) / 1000;
const round5 = (value: number): number => Number(value.toFixed(5));

/**
 * This process's RSS before ANY backend is created — the tsx test runner's own footprint, which is what
 * makes the AC6 total comparable with the scheme doc's bare-Python ceiling instead of looking like a
 * regression caused by the module. Read at import time, when nothing has been loaded yet.
 */
const RSS_BASELINE_MB = rssMb();

// ── the per-backend run, executed once and read by three groups ──────────────────────────────────

type BackendRun = {
  backend: UplinkVadBackendId;
  loadMs: number;
  rssBeforeMb: number;
  rssAfterLoadMb: number;
  coldWallMs: number;
  coldCpuMs: number;
  warmWallMs: number;
  warmCpuMs: number;
  frameCount: number;
  durationSec: number;
  verdicts: UplinkVadFrameVerdict[];
};

async function measureBackend(backend: UplinkVadBackendId): Promise<BackendRun> {
  const pcm = corpus();
  const weightsPath = backend === 'silero' ? SILERO_WEIGHTS : backend === 'ten' ? TEN_WEIGHTS : undefined;
  const frameCount = pcm.length / UPLINK_VAD_FRAME_BYTES;
  const durationSec = (frameCount * UPLINK_VAD_GRID.frameSamples) / UPLINK_VAD_GRID.sampleRate;

  const rssBeforeMb = rssMb();
  const loadStart = performance.now();
  const classifier = await createUplinkVadClassifier({ backend, weightsPath });
  const loadMs = performance.now() - loadStart;
  const rssAfterLoadMb = rssMb();

  // AC2 is unreachable without a live backend, so an unavailable one FAILS here with its own reason in
  // the message rather than skipping the group.
  const reading = readUplinkVadBackend(classifier);
  assert.equal(
    reading.status,
    'available',
    `${backend} is not available on this machine: ${reading.reason}. ` +
      `Tried weights ${weightsPath ?? '(none)'} under ${ENGINES_DIR}.`,
  );

  const coldCpu0 = process.cpuUsage();
  const coldWall0 = performance.now();
  const verdicts = await classifyUplinkVadStream(classifier, pcm);
  const coldWallMs = performance.now() - coldWall0;
  const cold = process.cpuUsage(coldCpu0);
  await classifier.close();

  // A SECOND, WARMED pass on a fresh classifier. The first pays the engine's own warm-up, and the
  // experiment side's RTF row is a warmed reading, so both are reported rather than one being picked.
  const warm = await createUplinkVadClassifier({ backend, weightsPath });
  const warmCpu0 = process.cpuUsage();
  const warmWall0 = performance.now();
  await classifyUplinkVadStream(warm, pcm);
  const warmWallMs = performance.now() - warmWall0;
  const warmUsage = process.cpuUsage(warmCpu0);
  await warm.close();

  return {
    backend,
    loadMs,
    rssBeforeMb,
    rssAfterLoadMb,
    coldWallMs,
    coldCpuMs: cpuMs(cold),
    warmWallMs,
    warmCpuMs: cpuMs(warmUsage),
    frameCount,
    durationSec,
    verdicts,
  };
}

const runCache = new Map<UplinkVadBackendId, Promise<BackendRun>>();

/** The run for one backend, executed at most once per file. */
function runFor(backend: UplinkVadBackendId): Promise<BackendRun> {
  let run = runCache.get(backend);
  if (run === undefined) {
    run = measureBackend(backend);
    runCache.set(backend, run);
  }
  return run;
}

const bitsOf = (verdicts: readonly UplinkVadFrameVerdict[]): string =>
  verdicts.map((verdict) => (verdict.speech ? '1' : '0')).join('');

// ── AC4: the grid contract ───────────────────────────────────────────────────────────────────────

test('AC4 — an off-grid frame is refused with a reason, never reinterpreted as though it were', async () => {
  const onGrid = markedFrame(3);
  assert.deepEqual(validateUplinkVadFrame(onGrid), { ok: true });

  const refusals: { label: string; frame: unknown; declared?: Parameters<typeof validateUplinkVadFrame>[1]; expect: RegExp }[] = [
    {
      // 48 kHz, 20 ms: the SAME duration, five times the bytes. This is the misread the contract exists
      // to stop, and it is refused on the byte length alone — a caller that forgot to declare it still
      // cannot get a reading taken at the wrong rate.
      label: 'a 20 ms frame of a 48 kHz stream, undeclared',
      frame: Buffer.alloc(1920, 1),
      expect: /1920 bytes is not the 320-sample 20 ms grid frame/,
    },
    {
      label: 'a 20 ms frame of a 48 kHz stream, declared as such',
      frame: Buffer.alloc(1920, 1),
      declared: { sampleRate: 48_000 },
      expect: /declared sample rate 48000 Hz is not the 16000 Hz grid/,
    },
    {
      // The other direction: 640 bytes is right for 16 kHz/20 ms and wrong at 8 kHz, where it is 40 ms.
      // Byte length alone is therefore NOT sufficient, which is why the declaration is checked too.
      label: 'a 640-byte frame of an 8 kHz stream, declared as such',
      frame: onGrid,
      declared: { sampleRate: 8_000 },
      expect: /declared sample rate 8000 Hz is not the 16000 Hz grid/,
    },
    {
      label: 'a stereo stream',
      frame: onGrid,
      declared: { channels: 2 },
      expect: /declared channel count 2 is not the 1-channel \(mono\) grid/,
    },
    {
      label: 'a non-PCM16 sample format',
      frame: onGrid,
      declared: { sampleFormat: 'float32' as never },
      expect: /is not the pcm16 grid/,
    },
    {
      label: 'a 10 ms frame (320 bytes)',
      frame: Buffer.alloc(320, 1),
      expect: /320 bytes is not the 320-sample 20 ms grid frame \(640 bytes\)/,
    },
    {
      label: 'a 641-byte frame — one byte off',
      frame: Buffer.alloc(641, 1),
      expect: /641 bytes is not the 320-sample 20 ms grid frame/,
    },
    {
      label: 'a Uint8Array that is not a Buffer',
      frame: new Uint8Array(UPLINK_VAD_FRAME_BYTES),
      expect: /not a Buffer of PCM16 bytes/,
    },
  ];

  console.log('AC4 — grid refusals (the reason string is the reading):');
  for (const refusal of refusals) {
    const verdict = validateUplinkVadFrame(refusal.frame, refusal.declared);
    assert.equal(verdict.ok, false, `${refusal.label} was ACCEPTED`);
    if (verdict.ok) throw new Error('unreachable');
    assert.match(verdict.reason, refusal.expect, refusal.label);
    console.log(`  refuse ${refusal.label.padEnd(46)} :: ${verdict.reason}`);
  }

  // The same validator on the LIVE path. A refusal that only exists in the pure function would let an
  // off-grid frame flow through `classify` looking like a judgement.
  const live = await createUplinkVadClassifier({ backend: 'silero', weightsPath: SILERO_WEIGHTS });
  const unavailable = await createUplinkVadClassifier({
    backend: 'silero',
    weightsPath: path.join(ENGINES_DIR, 'silero', 'not-here.onnx'),
  });
  assert.equal(readUplinkVadBackend(unavailable).status, 'unavailable');
  for (const classifier of [live, unavailable]) {
    await assert.rejects(
      () => classifier.classify(Buffer.alloc(1920, 1)),
      (error: unknown) => error instanceof UplinkVadGridError && /1920 bytes/.test(error.message),
      'classify accepted a frame it should have refused',
    );
    await assert.rejects(
      () => classifier.classify(onGrid, { sampleRate: 44_100 }),
      (error: unknown) => error instanceof UplinkVadGridError && /44100/.test(error.message),
    );
  }
  // The UNAVAILABLE classifier is included above on purpose: the grid must not be enforced only when a
  // model happens to be present, or a machine with no weights would be the one place it is not.
  await live.close();
  await unavailable.close();

  // A ragged clip is refused too — a batch read taken over whole frames while silently dropping the
  // remainder would report a reading for a stream that is not the one that was handed in.
  await assert.rejects(
    () => classifyUplinkVadStream(unavailable, Buffer.alloc(UPLINK_VAD_FRAME_BYTES * 3 + 17, 1)),
    UplinkVadGridError,
  );
});

// ── AC3: a missing weight or a missing package ───────────────────────────────────────────────────

test('AC3 — a backend that cannot run bypasses every frame and says so; it never looks active', async () => {
  const missing = (): Promise<unknown> => Promise.reject(new Error('Cannot find module (ENOENT)'));
  const empty = (): Promise<unknown> => Promise.resolve({});

  const cases: {
    label: string;
    options: UplinkVadClassifierOptions;
    expect: RegExp;
  }[] = [
    {
      label: 'silero, no weights path configured',
      options: { backend: 'silero' },
      expect: /no weights path was configured for the silero backend/,
    },
    {
      label: 'silero, weights path that is not there',
      options: { backend: 'silero', weightsPath: '/nonexistent/silero_vad.onnx' },
      expect: /silero weights not found at \/nonexistent\/silero_vad\.onnx/,
    },
    {
      // The package legs below pin `weightsExist` true so they read the DEPENDENCY state and not this
      // host's copy of the models: AC3's group is the one group that needs no fixture at all.
      label: 'silero, weights present, onnxruntime-node not installed',
      options: { backend: 'silero', weightsPath: SILERO_WEIGHTS, weightsExist: () => true, loadDependency: missing },
      expect: /onnxruntime-node could not be loaded/,
    },
    {
      label: 'silero, package loaded but exposing no InferenceSession',
      options: { backend: 'silero', weightsPath: SILERO_WEIGHTS, weightsExist: () => true, loadDependency: empty },
      expect: /exposes no InferenceSession\/Tensor/,
    },
    {
      label: 'ten, no weights path configured',
      options: { backend: 'ten' },
      expect: /no weights path was configured for the ten backend/,
    },
    {
      label: 'ten, weights path that is not there',
      options: { backend: 'ten', weightsPath: '/nonexistent/ten-vad.onnx' },
      expect: /ten weights not found at \/nonexistent\/ten-vad\.onnx/,
    },
    {
      label: 'ten, weights present, sherpa-onnx-node not installed',
      options: { backend: 'ten', weightsPath: TEN_WEIGHTS, weightsExist: () => true, loadDependency: missing },
      expect: /sherpa-onnx-node could not be loaded/,
    },
    {
      label: 'ten, package loaded but exposing no Vad constructor',
      options: { backend: 'ten', weightsPath: TEN_WEIGHTS, weightsExist: () => true, loadDependency: empty },
      expect: /exposes no Vad constructor/,
    },
    {
      label: 'webrtc, webrtcvad not installed',
      options: { backend: 'webrtc', loadDependency: missing },
      expect: /webrtcvad could not be loaded/,
    },
    {
      label: 'webrtc, package loaded but exposing no VAD constructor',
      options: { backend: 'webrtc', loadDependency: empty },
      expect: /exposes no VAD constructor/,
    },
  ];

  console.log('AC3 — the bypass reading for every way a backend can fail to load:');
  for (const { label, options, expect } of cases) {
    const classifier = await createUplinkVadClassifier(options);
    const reading = readUplinkVadBackend(classifier);

    // THE FALSE FORM, refused: a deployment that believes it is filtering while the backend returns
    // "speech" for everything, with no bypass marker in its reading. Every clause below is a clause
    // that false form would fail.
    assert.equal(reading.status, 'unavailable', label);
    assert.equal(reading.bypassed, true, `${label}: unavailable but the reading does not say bypassed`);
    assert.ok(
      typeof reading.reason === 'string' && reading.reason.length > 0,
      `${label}: unavailable with no reason string`,
    );
    assert.match(reading.reason ?? '', expect, label);
    assert.match(describeUplinkVadBackend(reading), /bypassed=true \(every frame passes through unfiltered\)/, label);

    const verdicts = await classifyUplinkVadStream(classifier, Buffer.concat([markedFrame(1), markedFrame(2), markedFrame(3)]));
    assert.equal(verdicts.length, 3, `${label}: a bypassed stream must still report one verdict per frame`);
    for (const verdict of verdicts) {
      assert.equal(verdict.bypassed, true, label);
      assert.equal(verdict.speech, true, `${label}: a bypassed frame must be KEPT, so speech is true`);
      assert.equal(verdict.probability, null, `${label}: a bypassed frame has no probability`);
      assert.ok(
        typeof verdict.reason === 'string' && verdict.reason.length > 0,
        `${label}: a bypassed verdict must carry its own reason`,
      );
      assert.match(verdict.reason ?? '', new RegExp(`^${options.backend} backend is unavailable: `), label);
    }
    assert.deepEqual(verdicts.map((verdict) => verdict.frameIndex), [0, 1, 2], label);

    // …and the fail-open direction: every frame survives the mask, so a broken deployment degrades to
    // "no filtering" and never to "audio silently dropped".
    const pcm = Buffer.concat([markedFrame(1), markedFrame(2), markedFrame(3)]);
    assert.deepEqual(applyUplinkVadMask(pcm, verdicts).map((kept) => kept.index), [0, 1, 2], label);

    console.log(`  bypass ${label.padEnd(52)} :: ${readUplinkVadBackend(classifier).reason}`);
    await classifier.close();
  }

  // The OTHER direction, so the reading cannot be satisfied by reporting `bypassed` always: a backend
  // that IS live must say so, with a null reason and no bypass marker.
  const live = await createUplinkVadClassifier({ backend: 'webrtc' });
  const liveReading = readUplinkVadBackend(live);
  assert.equal(liveReading.status, 'available');
  assert.equal(liveReading.bypassed, false);
  assert.equal(liveReading.reason, null);
  assert.match(describeUplinkVadBackend(liveReading), /active \(bypassed=false\)/);
  await live.close();
});

test('AC3 — the defaults this module ships are the ones it documents', () => {
  assert.equal(UPLINK_VAD_DEFAULT_THRESHOLD, 0.5);
  assert.equal(UPLINK_VAD_DEFAULT_AGGRESSIVENESS, 3);
  assert.deepEqual([...UPLINK_VAD_BACKENDS], ['silero', 'ten', 'webrtc']);
  assert.deepEqual(
    { ...UPLINK_VAD_GRID },
    { sampleRate: 16_000, channels: 1, sampleFormat: 'pcm16', frameMs: 20, frameSamples: 320, frameBytes: 640 },
  );
  assert.equal(UPLINK_VAD_FRAME_BYTES, 640);
});

// ── AC2: the three backends on a known input ─────────────────────────────────────────────────────

test('AC2 — each backend reproduces the Python adapter’s verdicts on the known corpus', async () => {
  console.log('AC2 — verdicts on the known corpus (compared against the experiment adapters, digit for digit):');
  for (const backend of UPLINK_VAD_BACKENDS) {
    const run = await runFor(backend);
    const bits = bitsOf(run.verdicts);
    const expected = PY_BITS[backend];
    assert.equal(expected.length, PY_FRAME_COUNT, 'the copied ground truth is the wrong length');

    assert.equal(run.frameCount, PY_FRAME_COUNT, `${backend}: corpus frame count`);
    assert.equal(run.verdicts.length, PY_FRAME_COUNT, `${backend}: one verdict per grid frame`);
    // Frame order, and the lag made visible: a verdict names its own frame, so a caller can never zip
    // two arrays positionally and shift a judgement onto the wrong audio.
    assert.deepEqual(
      run.verdicts.map((verdict) => verdict.frameIndex),
      Array.from({ length: PY_FRAME_COUNT }, (_unused, index) => index),
      `${backend}: verdicts must be in frame order`,
    );
    assert.equal(
      run.verdicts.filter((verdict) => verdict.bypassed).length,
      0,
      `${backend}: no frame of a full stream may be left unjudged`,
    );
    assert.equal(
      run.verdicts.filter((verdict) => verdict.reason !== null).length,
      0,
      `${backend}: a judged verdict carries no reason`,
    );

    const differing: number[] = [];
    for (let index = 0; index < expected.length; index += 1) {
      if (bits[index] !== expected[index]) differing.push(index);
    }
    assert.deepEqual(
      differing,
      [],
      `${backend}: ${differing.length} frame(s) differ from the Python adapter's own reading`,
    );

    const speech = bits.split('').filter((character) => character === '1').length;
    console.log(
      `  ${backend.padEnd(7)} speech ${String(speech).padStart(3)}/${PY_FRAME_COUNT}` +
        `  matches engines/${backend}.py: yes  (${bits.slice(0, 48)}…)`,
    );
  }

  // Silero's PROBABILITIES, not just its thresholded bits: a windowing mistake that still lands on the
  // same side of 0.5 would hide in the strings above and cannot hide here.
  const silero = await runFor('silero');
  const probabilities = silero.verdicts.map((verdict) => verdict.probability);
  assert.ok(probabilities.every((probability) => probability !== null));
  for (let index = 0; index < PY_SILERO_PROB_HEAD.length; index += 1) {
    assert.equal(
      round5(probabilities[index] as number),
      PY_SILERO_PROB_HEAD[index],
      `silero probability at frame ${index} is not the adapter's`,
    );
  }
  // …and the DELIBERATE divergence, asserted structurally. Python zero-pads the trailing partial window
  // and overwrites frame 225 with 0.00132; this module refuses to synthesize, so frame 225 keeps the
  // last FULL window's reading — the very number frame 224 carries. That is the whole cost of the
  // divergence, and it changes no verdict, which is why the bit strings above still match.
  assert.equal(
    round5(probabilities[PY_FRAME_COUNT - 1] as number),
    round5(probabilities[PY_FRAME_COUNT - 2] as number),
    'frame 225 must keep the last full window’s probability, not a zero-padded window’s',
  );
  console.log(
    `  silero probabilities [0:8]   ${PY_SILERO_PROB_HEAD.map((value) => value.toFixed(5)).join(', ')}` +
      `  (== engines/silero.py)`,
  );
  console.log(
    `  silero probabilities [222:226] ` +
      `${probabilities.slice(222, 226).map((value) => (value as number).toFixed(5)).join(', ')}` +
      `  (python’s frame 225 is 0.00132: the zero-padded partial window this module declines to fabricate)`,
  );

  // A live backend must NOT report itself bypassed — the complementary half of AC3's false form.
  for (const backend of UPLINK_VAD_BACKENDS) {
    const run = await runFor(backend);
    assert.ok(run.verdicts.length > 0, `${backend}: a live backend judged nothing`);
  }
});

// ── AC5: nothing is synthesized ──────────────────────────────────────────────────────────────────

test('AC5 — the module allocates no buffer, and every kept frame is the caller’s own bytes', async () => {
  console.log('AC5 — the allocation audit, run as a grep over the module and not read from a comment:');
  // The AC's own literal form, then the neighbouring shapes that would synthesize a frame just as well.
  // All four are zero; the module's only `Buffer` uses are `isBuffer` and type annotations.
  for (const pattern of [
    'Buffer\\.alloc\\(',
    'Buffer\\.allocUnsafe\\(',
    'Buffer\\.concat\\(',
    'Buffer\\.from\\(',
  ]) {
    const count = grepCount(pattern, MODULE_FILE);
    console.log(`  grep -cE '${pattern.replace(/\\\\/g, '\\')}' ${path.relative(process.cwd(), MODULE_FILE)}  =>  ${count}`);
    assert.equal(count, 0, `the module contains a ${pattern} call site`);
  }

  // The byte-identity legs, on the REAL backends: a kept frame is the caller's own byte at the caller's
  // own offset, and it is a VIEW rather than a copy of it.
  const pcm = corpus();
  for (const backend of UPLINK_VAD_BACKENDS) {
    const run = await runFor(backend);
    const dropped = run.verdicts
      .filter((verdict) => !verdict.bypassed && !verdict.speech)
      .map((verdict) => verdict.frameIndex);
    const droppedSet = new Set(dropped);
    const kept = applyUplinkVadMask(pcm, run.verdicts);

    assert.equal(
      kept.length,
      run.frameCount - dropped.length,
      `${backend}: the mask dropped a number of frames it was not told to drop`,
    );
    assert.deepEqual(
      kept.map((entry) => entry.index),
      Array.from({ length: run.frameCount }, (_unused, index) => index).filter((index) => !droppedSet.has(index)),
      `${backend}: kept frames must be exactly the undropped ones, in order`,
    );
    for (const entry of kept) {
      assert.equal(
        entry.frame.length,
        UPLINK_VAD_FRAME_BYTES,
        `${backend}: a kept frame is not a whole grid frame`,
      );
      assert.ok(
        entry.frame.equals(pcm.subarray(entry.index * UPLINK_VAD_FRAME_BYTES, (entry.index + 1) * UPLINK_VAD_FRAME_BYTES)),
        `${backend}: kept frame ${entry.index} is not byte-equal to the input`,
      );
      assert.equal(
        entry.frame.buffer,
        pcm.buffer,
        `${backend}: kept frame ${entry.index} is a COPY; the mask must return views of the caller's PCM`,
      );
    }
    console.log(
      `  ${backend.padEnd(7)} kept ${kept.length}/${run.frameCount} frames, all byte-equal to the input: yes; ` +
        `all views of the caller's buffer: yes`,
    );
  }

  // The fabricated-silence leg. The input's frames carry a distinct nonzero marker and NO frame of it is
  // digital silence, so a gate that filled a dropped frame's place with zeros would be visible in the
  // output — which is the one thing "zero synthesis" has to mean.
  const frames = 12;
  const marked = Buffer.alloc(frames * UPLINK_VAD_FRAME_BYTES, 9);
  for (let index = 0; index < frames; index += 1) marked[index * UPLINK_VAD_FRAME_BYTES] = index + 1;
  const gated: UplinkVadFrameVerdict[] = [];
  for (let index = 0; index < frames; index += 1) {
    if (index >= 3 && index <= 5) {
      // JUDGED non-speech: the one case the mask may drop.
      gated.push({ frameIndex: index, speech: false, probability: 0.01, bypassed: false, reason: null });
      continue;
    }
    // No verdict at all — kept by the fail-open rule, and the two cases are deliberately adjacent here
    // so that a mask which dropped the unjudged ones would show up as three extra holes.
    if (index >= 8 && index <= 9) continue;
    gated.push({ frameIndex: index, speech: true, probability: 0.9, bypassed: false, reason: null });
  }
  const masked = applyUplinkVadMask(marked, gated);
  assert.deepEqual(masked.map((entry) => entry.index), [0, 1, 2, 6, 7, 8, 9, 10, 11]);
  assert.ok(
    masked.every((entry) => entry.frame.some((byte) => byte !== 0)),
    'the mask fabricated a silence frame',
  );
  assert.ok(
    masked.every((entry) => marked.includes(entry.frame)),
    'a kept frame is not a byte run of the input',
  );
  const joined = Buffer.concat(masked.map((entry) => entry.frame));
  assert.equal(joined.length, 9 * UPLINK_VAD_FRAME_BYTES);
  for (let offset = 0; offset < joined.length; offset += UPLINK_VAD_FRAME_BYTES) {
    assert.ok(
      joined.subarray(offset, offset + UPLINK_VAD_FRAME_BYTES).some((byte) => byte !== 0),
      `a 640-byte all-zero run appears at offset ${offset} — that is a synthesized frame`,
    );
  }
  console.log(
    `  gated  12 frames → ${masked.length} kept, no zero-filled run anywhere in the output: yes ` +
      `(an unjudged frame is kept, a dropped frame is absent and is NOT replaced)`,
  );
});

// ── AC6: resource readings ───────────────────────────────────────────────────────────────────────

test('AC6 — per-frame cost, RTF and RSS delta, against the experiment side', async () => {
  const header =
    'AC6 — module end-to-end, in-process, on ' +
    `${PY_FRAME_COUNT} frames / ${((PY_FRAME_COUNT * 320) / 16_000).toFixed(2)} s of the same recording:`;
  console.log(header);
  console.log(
    '  backend   load ms   RSS Δ MB   per-frame wall ms   per-frame cpu ms   RTF cold   RTF warm   ' +
      'RTF (scheme doc, 372.66 s)',
  );
  for (const backend of UPLINK_VAD_BACKENDS) {
    const run = await runFor(backend);
    const perFrameWall = run.coldWallMs / run.frameCount;
    const perFrameCpu = run.coldCpuMs / run.frameCount;
    const rtfCold = run.coldWallMs / 1000 / run.durationSec;
    const rtfWarm = run.warmWallMs / 1000 / run.durationSec;
    // The one thing worth failing on: a classifier that cannot keep up with real time is not a
    // classifier. The bound is deliberately loose — this host's load is not a property of the module —
    // so it reds on a catastrophe and not on a busy machine.
    assert.ok(rtfWarm > 0 && rtfWarm < 0.5, `${backend}: warmed RTF ${rtfWarm.toFixed(5)} cannot keep up`);
    assert.ok(perFrameWall > 0 && perFrameCpu > 0, `${backend}: a per-frame cost of zero is not a reading`);
    console.log(
      `  ${backend.padEnd(8)}  ${run.loadMs.toFixed(1).padStart(6)}  ` +
        `${(run.rssAfterLoadMb - run.rssBeforeMb).toFixed(1).padStart(7)}  ` +
        `${perFrameWall.toFixed(4).padStart(17)}  ${perFrameCpu.toFixed(4).padStart(17)}  ` +
        `${rtfCold.toFixed(5).padStart(8)}  ${rtfWarm.toFixed(5).padStart(8)}  ` +
        `${EXPERIMENT_ROWS[backend].rtf.toFixed(4).padStart(24)}`,
    );
  }
  const processRss = rssMb();
  console.log(
    `  experiment side (docs/operations/voice-realtime-uplink-vad-scheme.md §3, all three engines in ONE ` +
      `process): silero RTF ${EXPERIMENT_ROWS.silero.rtf} / wall ${EXPERIMENT_ROWS.silero.wallSec} s; ` +
      `ten RTF ${EXPERIMENT_ROWS.ten.rtf} / wall ${EXPERIMENT_ROWS.ten.wallSec} s; ` +
      `webrtc RTF ${EXPERIMENT_ROWS.webrtc.rtf} / wall ${EXPERIMENT_ROWS.webrtc.wallSec} s.`,
  );
  console.log(
    `  process RSS ceiling quoted there: ${EXPERIMENT_RSS_CEILING_MB} MB (rss_max_kb 137688, three engines ` +
      `loaded together, bare python). This process: ${RSS_BASELINE_MB.toFixed(1)} MB at import (the tsx ` +
      `runner alone, nothing loaded) → ${processRss.toFixed(1)} MB with all three backends live, i.e. ` +
      `+${(processRss - RSS_BASELINE_MB).toFixed(1)} MB for three engines at once.`,
  );
  console.log(
    `  notes: ${UPLINK_VAD_BACKENDS.map((backend) => `${backend} — ${EXPERIMENT_ROWS[backend].note}`).join('; ')}`,
  );
});

// ── the mask's own contract ──────────────────────────────────────────────────────────────────────

test('the mask refuses a mis-aligned index space and matches verdicts by frame, not by position', () => {
  const frames = 4;
  const pcm = Buffer.alloc(frames * UPLINK_VAD_FRAME_BYTES, 5);
  const verdict = (frameIndex: number, speech: boolean): UplinkVadFrameVerdict => ({
    frameIndex,
    speech,
    probability: null,
    bypassed: false,
    reason: null,
  });

  assert.throws(() => applyUplinkVadMask(Buffer.alloc(UPLINK_VAD_FRAME_BYTES + 1), []), UplinkVadGridError);
  for (const bad of [-1, frames, 1.5, Number.NaN]) {
    assert.throws(
      () => applyUplinkVadMask(pcm, [verdict(bad, true)]),
      (error: unknown) => error instanceof UplinkVadGridError && /outside the 4 frames/.test(error.message),
      `a verdict naming frame ${bad} was accepted`,
    );
  }

  // Frame 1 dropped, frames 0 and 2 kept, frame 3 never judged (kept). Handed in a DIFFERENT order, to
  // pin that the mask keys on `frameIndex`: a positional zip would drop frame 0 here instead.
  const shuffled = [verdict(2, true), verdict(0, true), verdict(1, false)];
  assert.deepEqual(applyUplinkVadMask(pcm, shuffled).map((entry) => entry.index), [0, 2, 3]);
  assert.deepEqual(
    applyUplinkVadMask(pcm, [...shuffled].reverse()).map((entry) => entry.index),
    [0, 2, 3],
  );

  // A later verdict for the same frame wins, so a caller that re-considers a frame is not stuck with
  // its first answer — and a bypassed verdict always keeps its frame.
  assert.deepEqual(applyUplinkVadMask(pcm, [verdict(1, false), verdict(1, true)]).map((entry) => entry.index), [0, 1, 2, 3]);
  assert.deepEqual(
    applyUplinkVadMask(pcm, [verdict(1, true), verdict(1, false)]).map((entry) => entry.index),
    [0, 2, 3],
  );
  assert.deepEqual(
    applyUplinkVadMask(pcm, [
      { frameIndex: 1, speech: false, probability: null, bypassed: true, reason: 'unavailable' },
    ]).map((entry) => entry.index),
    [0, 1, 2, 3],
  );
});

// ── AC7: no egress ───────────────────────────────────────────────────────────────────────────────

test('AC7 — the module has no network reference point and reaches for no package at load time', () => {
  const source = readFileSync(MODULE_FILE, 'utf8');
  const forbidden = [
    'http://',
    'https://',
    'fetch(',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'XMLHttpRequest',
    'WebSocket',
    'require(',
    'process.env',
    'voice-realtime-ws-proxy',
    'VOICE_REALTIME_SILENCE_TAIL',
  ];
  console.log('AC7 — network / deployment reference points in the module (every one must be 0):');
  for (const needle of forbidden) {
    const count = source.split(needle).length - 1;
    console.log(`  ${needle.padEnd(28)} ${count}`);
    assert.equal(count, 0, `the module references ${needle}`);
  }

  const staticImports = [...source.matchAll(/^import[^;]*?from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(staticImports, ['node:fs'], 'the module’s only static import must be the filesystem');

  const dynamicSpecs = [...source.matchAll(/loadDependency\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(dynamicSpecs, ['onnxruntime-node', 'sherpa-onnx-node', 'webrtcvad']);
  for (const specifier of dynamicSpecs) {
    assert.ok(!specifier.includes('://'), `${specifier} is a URL, not a package`);
  }
  // The one dynamic import that is not a literal specifier — `import(specifier)` — is what keeps these
  // three OPTIONAL: neither tsc nor a bundler resolves it, so a machine without them still builds.
  assert.match(source, /return import\(specifier\);/, 'the optional-import seam is gone');
  console.log(
    `  static imports: ${JSON.stringify(staticImports)}; dynamic specifiers: ${JSON.stringify(dynamicSpecs)} ` +
      `(all local package names, no URLs) — the models are read from disk by path and nothing dials out.`,
  );
});

// ── the lag, and the tail that is left unjudged rather than padded ───────────────────────────────

test('the windowed backends lag by design, and an unjudged tail is bypassed rather than guessed', async () => {
  const silero = await createUplinkVadClassifier({ backend: 'silero', weightsPath: requireFile(SILERO_WEIGHTS, 'the lag leg needs the silero weights') });
  const read = readUplinkVadBackend(silero);
  assert.equal(read.status, 'available', `silero is not available: ${read.reason}`);

  // ONE grid frame is 320 samples; Silero's window is 512, so nothing can be settled yet — and `null`
  // must mean exactly that, not a placeholder verdict for a frame whose answer has not arrived.
  assert.equal(await silero.classify(markedFrame(4)), null, 'a frame cannot be judged before its window ran');
  // Frame two completes the first window, which settles frame 0.
  const settled = await silero.classify(markedFrame(4));
  assert.ok(settled !== null, 'the second push completes a window and must settle frame 0');
  assert.equal(settled.frameIndex, 0);
  assert.equal(settled.bypassed, false);

  // A stream that ends inside a window: the tail comes back BYPASSED with its reason, never guessed.
  const short = await createUplinkVadClassifier({ backend: 'silero', weightsPath: SILERO_WEIGHTS });
  assert.equal(await short.classify(markedFrame(4)), null);
  const tail = await short.flush();
  assert.equal(tail.length, 1, 'the one pending frame must be reported by flush');
  assert.equal(tail[0].frameIndex, 0);
  assert.equal(tail[0].bypassed, true, 'a frame the stream ended before judging must be bypassed');
  assert.equal(tail[0].speech, true, 'a bypassed frame is kept');
  assert.match(tail[0].reason ?? '', /left\s+unjudged rather than zero-padded/);
  // Idempotent: flushing twice must not invent a second verdict.
  assert.deepEqual(await short.flush(), []);

  const pcm = Buffer.concat([markedFrame(4), markedFrame(6)]);
  assert.deepEqual(applyUplinkVadMask(pcm, tail).map((entry) => entry.index), [0, 1]);
  console.log(
    `  lag: silero push #1 → null, push #2 → frame ${settled.frameIndex}; ` +
      `a 1-frame stream flushes frame 0 as bypassed=${tail[0].bypassed} (kept) — "${tail[0].reason}"`,
  );

  await silero.close();
  await short.close();
});

// ── AC8: the module touches no production default ────────────────────────────────────────────────

test('AC8 — this module reaches into no production default and no relay path', () => {
  const source = readFileSync(MODULE_FILE, 'utf8');
  // The production defaults live in the modules this task must not change; the new module must not even
  // name them, which is the machine-checkable half of "不改生产默认值与链路".
  for (const needle of ['VOICE_REALTIME_SILENCE_TAIL', 'silence-tail', 'ws-proxy', 'sendAudioFrame', 'segment_end']) {
    assert.equal(source.split(needle).length - 1, 0, `the module names ${needle}`);
  }
  assert.deepEqual(
    [...source.matchAll(/^import[^;]*?from '([^']+)';$/gm)].map((match) => match[1]),
    ['node:fs'],
    'the module must import nothing but the filesystem',
  );
  console.log(
    'AC8 — the module names no relay default (VOICE_REALTIME_SILENCE_TAIL / silence-tail / ws-proxy / ' +
      'sendAudioFrame / segment_end: 0 occurrences) and imports only node:fs.',
  );
});
