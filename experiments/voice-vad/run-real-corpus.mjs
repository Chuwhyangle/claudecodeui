#!/usr/bin/env node
/**
 * Five-scheme offline VAD comparison on the third real 372.66 s continuous uplink.
 *
 * The engines are TEN VAD, Silero VAD, WebRTC VAD, FunASR FSMN-VAD and the shipped STS
 * silence-tail gate. Every one of them is the real thing:
 *
 *   · silero / ten / fsmn  -- the official ONNX weights, run by `engines/*.py`;
 *   · webrtc               -- the compiled WebRTC C extension (webrtcvad-wheels);
 *   · sts                  -- `server/modules/voice-realtime/voice-realtime-silence-tail.ts`,
 *                             imported and driven in THIS process, not reimplemented.
 *
 * Everything is put on one grid (16 kHz mono, 20 ms frames = 320 samples), one input pipeline
 * and one postfilter, so the columns of the tables are comparable:
 *
 *   raw frame decision  ->  shared postfilter (preroll/hangover, parameterizable)  ->  segments
 *                       ->  `metrics.mjs`'s exact-truth metrics
 *
 * Two references are reported and never conflated:
 *
 *   · `proxy`    -- the real capture's 18 upstream `speech_started/stopped` pairs. That is an
 *                   upstream MODEL's boundary, not truth; it is what the previous round used.
 *   · `exact`    -- `timeline.mjs`'s synthetic timelines and the frozen `corpus/long` manifest,
 *                   whose speech intervals are the samples the builder placed. Those are truth.
 *
 * This harness only classifies frames. It never drives turn detection, `commit` or
 * `response.create`; it changes no production config, restarts nothing and sends no audio out.
 *
 * Usage:
 *   node experiments/voice-vad/run-real-corpus.mjs [--out results.json] [--quick] [--datasets real,exact]
 *
 * Env: VAD_PY (python with the engines' deps), VAD_REAL_WAV, VAD_CORPUS, VAD_LONG.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeMetrics } from './metrics.mjs';
import {
  DEFAULT_RATE,
  buildTimeline,
  decodeWavFile,
  loadCorpus,
  loadLongCorpus,
} from './timeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, 'engines');
const PYTHON = process.env.VAD_PY ?? '/data/home/yale/work/voice-vad-engines/venv/bin/python';
const REAL_WAV =
  process.env.VAD_REAL_WAV ??
  join(
    homedir(),
    '.cloudcli/voice-realtime-capture/af5559c0-d347-41f3-a6f0-f02a597af1e9.wav',
  );
const REAL_TIMELINE = REAL_WAV.replace(/\.wav$/, '.timeline.jsonl');
const CORPUS_ROOT =
  process.env.VAD_CORPUS ?? '/data/home/yale/work/tc-verify/corpus/public/LibriSpeech/dev-clean';
const LONG_ROOT = process.env.VAD_LONG ?? '/data/home/yale/work/tc-verify/corpus/long';

const SR = DEFAULT_RATE;
const HOP_SAMPLES = 320; // 20 ms, the shipped STS gate's own frame
const HOP_SEC = HOP_SAMPLES / SR;
/** The shipped gate's constants are the "shipped" preset; a second, looser preset is the control. */
const PRESETS = {
  shipped: { prerollMs: 500, hangoverMs: 320 },
  loose: { prerollMs: 200, hangoverMs: 100 },
};
const SYNTHETIC_SEED = 7;
const SYNTHETIC_FAMILY = 'mixed';
const SYNTHETIC_NOISE = 'clean';
const SYNTHETIC_MAX_SEC = 90;

const ENGINE_SPECS = [
  { name: 'silero', levels: ['0.2', '0.35', '0.5', '0.65', '0.8'], primary: '0.5' },
  { name: 'ten', levels: ['0.2', '0.35', '0.5', '0.65', '0.8'], primary: '0.5' },
  { name: 'webrtc', levels: ['0', '1', '2', '3'], primary: '1' },
  { name: 'fsmn', levels: ['0.3', '0.45', '0.6', '0.75', '0.9'], primary: '0.6' },
];

// ---------------------------------------------------------------------------------------------
// grid helpers
// ---------------------------------------------------------------------------------------------

/** `"0110..."` -> speech segments on the 20 ms grid. */
function framesToSegments(bits) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= bits.length; i += 1) {
    const on = i < bits.length && bits[i] === '1';
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push({ startSec: start * HOP_SEC, endSec: i * HOP_SEC });
      start = -1;
    }
  }
  return out;
}

/** The one postfilter every engine gets: extend each speech run left by preroll, right by hangover. */
function postfilterBits(bits, preset) {
  const pre = Math.round(preset.prerollMs / 1000 / HOP_SEC);
  const hang = Math.round(preset.hangoverMs / 1000 / HOP_SEC);
  const n = bits.length;
  const out = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    if (bits[i] !== '1') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && bits[j] === '1') j += 1;
    for (let k = Math.max(0, i - pre); k < Math.min(n, j + hang); k += 1) out[k] = 1;
    i = j;
  }
  let bitsOut = '';
  for (let k = 0; k < n; k += 1) bitsOut += out[k] ? '1' : '0';
  return bitsOut;
}

function speechSeconds(bits) {
  let n = 0;
  for (let i = 0; i < bits.length; i += 1) if (bits[i] === '1') n += 1;
  return n * HOP_SEC;
}

/** Union length of the truth intervals, clipped to `durationSec`. */
function truthSeconds(truth, durationSec) {
  const spans = truth
    .map((t) => [Math.max(0, t.startSec), Math.min(durationSec, t.endSec)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -1;
  for (const [a, b] of spans) {
    if (a >= cursor) {
      total += b - a;
      cursor = b;
    } else if (b > cursor) {
      total += b - cursor;
      cursor = b;
    }
  }
  return total;
}

/** 16 kHz mono PCM16 WAV, so the python engines read exactly the bytes the harness synthesized. */
function writeWav16(path, samples) {
  const header = Buffer.alloc(44);
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------------------------
// datasets
// ---------------------------------------------------------------------------------------------

/** The real capture's own upstream boundaries. A model's opinion, not truth -- labelled `proxy`. */
function readProxyTruth(path) {
  const starts = [];
  const stops = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.kind === 'speech_started') starts.push(entry.offsetMs);
    else if (entry.kind === 'speech_stopped') stops.push(entry.offsetMs);
  }
  const truth = [];
  for (let i = 0; i < Math.min(starts.length, stops.length); i += 1) {
    if (stops[i] > starts[i]) {
      truth.push({ startSec: starts[i] / 1000, endSec: stops[i] / 1000, source: 'capture-timeline' });
    }
  }
  return truth;
}

function buildDatasets(workdir, only) {
  const want = (id) => !only || only.includes(id);
  const datasets = [];

  if (want('real')) {
    const decoded = decodeWavFile(REAL_WAV);
    datasets.push({
      id: 'real',
      reference: 'proxy',
      wav: REAL_WAV,
      samples: decoded.samples,
      truth: readProxyTruth(REAL_TIMELINE),
      note: '372.66 s third real uplink; reference = the capture timeline’s 18 upstream speech pairs (PROXY, not truth)',
    });
  }

  if (want('synthetic') || want('exact')) {
    const corpus = loadCorpus(CORPUS_ROOT, { pool: 200, rate: SR });
    const timeline = buildTimeline({
      sources: corpus.sources,
      seed: SYNTHETIC_SEED,
      family: SYNTHETIC_FAMILY,
      noise: SYNTHETIC_NOISE,
      sampleRate: SR,
      maxDurationSec: SYNTHETIC_MAX_SEC,
    });
    const wav = join(workdir, 'synthetic-mixed-clean.wav');
    writeWav16(wav, timeline.samples);
    datasets.push({
      id: 'synthetic',
      reference: 'exact',
      wav,
      samples: timeline.samples,
      truth: timeline.truth,
      note: `synthetic ${SYNTHETIC_FAMILY}/${SYNTHETIC_NOISE} seed=${SYNTHETIC_SEED} (LibriSpeech dev-clean pool ${corpus.pool}); truth = the samples the builder placed`,
    });
  }

  if (want('long') || want('exact')) {
    for (const sample of loadLongCorpus(LONG_ROOT)) {
      const wav = join(workdir, `long-${sample.id}.wav`);
      writeWav16(wav, sample.samples);
      datasets.push({
        id: `long:${sample.id}`,
        reference: 'exact',
        wav,
        samples: sample.samples,
        truth: sample.truth,
        note: `frozen T3 sample ${sample.id}; truth = the manifest written when the corpus was constructed`,
      });
    }
  }

  return datasets;
}

// ---------------------------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------------------------

function runPythonEngine(spec, wavPath, outPath) {
  const args = [
    join(ENGINE_DIR, `${spec.name}.py`),
    '--wav',
    wavPath,
    '--out',
    outPath,
    '--levels',
    spec.levels.join(','),
  ];
  const started = Date.now();
  const run = spawnSync(PYTHON, args, { encoding: 'utf8', timeout: 900_000 });
  if (run.status !== 0) {
    return {
      engine: spec.name,
      failed: true,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      status: run.status,
      signal: run.signal,
    };
  }
  const dump = JSON.parse(readFileSync(outPath, 'utf8'));
  dump.wallSecIncludingSpawn = (Date.now() - started) / 1000;
  dump.stdout = (run.stdout ?? '').trim();
  return dump;
}

/**
 * The shipped STS gate, driven in-process on the same 20 ms grid. This is the production
 * module, not a copy: it is imported here and fed one base64 PCM16 frame at a time, exactly as
 * the ws proxy feeds it.
 *
 * Its own preroll/hangover ARE the baseline's filter, so two readings are produced: `native`
 * (what the gate actually forwards) and `unified` (the shared postfilter applied on top, which
 * is the form the tradeoff table needs to compare like with like).
 */
async function runShippedSts(samples) {
  const mod = await import('../../server/modules/voice-realtime/voice-realtime-silence-tail.ts');
  const gate = mod.createSilenceTailGate();
  const n = Math.floor(samples.length / HOP_SAMPLES);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const bits = [];
  const transitions = [];
  const startedAt = process.hrtime.bigint();
  for (let k = 0; k < n; k += 1) {
    const audio = pcm.subarray(k * HOP_SAMPLES * 2, (k + 1) * HOP_SAMPLES * 2).toString('base64');
    const decision = gate.observe(audio, k * HOP_SEC * 1000);
    if (decision.transition) transitions.push({ frame: k, transition: decision.transition });
    // The frame crossed the wire iff the gate returned it. A keepalive frame is digital silence,
    // not this frame, so identity -- not non-emptiness -- decides.
    bits.push(decision.frames.includes(audio) ? '1' : '0');
  }
  const wallSec = Number(process.hrtime.bigint() - startedAt) / 1e9;
  return {
    engine: 'sts',
    label: 'Shipped STS silence-tail gate',
    wav: null,
    sampleRate: SR,
    hopSamples: HOP_SAMPLES,
    frameCount: n,
    durationSec: n * HOP_SEC,
    levels: { native: bits.join('') },
    levelKind: 'shipped-detector',
    transitions,
    cost: {
      wallSec,
      cpuSec: null,
      // Not isolated: STS runs in this Node process, so this is the harness's RSS, an upper
      // bound rather than a per-engine figure. The python engines each get their own process.
      rssPeakKb: Math.round(process.memoryUsage().rss / 1024),
      rtf: wallSec / (n * HOP_SEC),
      sharedProcess: true,
    },
    weights: [
      {
        path: 'server/modules/voice-realtime/voice-realtime-silence-tail.ts',
        sha256_16: null,
        sourceUrl: 'in-repo (shipping module)',
        note: 'a detector, not a trained model: no weights file',
      },
    ],
    notes:
      'Production module driven in-process on 20 ms base64 PCM16 frames. `native` is the gate’s own output (its preroll/hangover is the filter); the unified-postfilter row is derived from it.',
  };
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: null, quick: false, datasets: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--quick') out.quick = true;
    else if (argv[i] === '--datasets') out.datasets = argv[++i].split(',');
  }
  return out;
}

function listeningPid(port) {
  const run = spawnSync('bash', ['-lc', `ss -ltnpH 'sport = :${port}' 2>/dev/null | head -1`], {
    encoding: 'utf8',
  });
  const m = /pid=(\d+)/.exec(run.stdout ?? '');
  return m ? Number(m[1]) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workdir = join(tmpdir(), `vad5-engines-${process.pid}`);
  mkdirSync(workdir, { recursive: true });

  const checks = {
    stsEnv: process.env.VOICE_REALTIME_SILENCE_TAIL ?? null,
    stsEnvReadsAsDisabled: !/^(1|true|on|yes)$/i.test(process.env.VOICE_REALTIME_SILENCE_TAIL ?? ''),
    serverPidBefore: listeningPid(3001),
    egress: 'no audio leaves the process; only model weights were fetched inbound',
  };

  const datasets = buildDatasets(workdir, args.quick ? ['real'] : args.datasets);
  if (!datasets.length) throw new Error('no datasets selected');

  const tradeoff = [];
  const truthRows = [];
  const cost = [];
  const weights = [];
  const failures = [];

  for (const dataset of datasets) {
    const nFrames = Math.floor(dataset.samples.length / HOP_SAMPLES);
    const durationSec = nFrames * HOP_SEC;
    const silenceSec = durationSec - truthSeconds(dataset.truth, durationSec);

    const dumps = [];
    for (const spec of ENGINE_SPECS) {
      const outPath = join(workdir, `${spec.name}-${dataset.id.replace(/[:]/g, '_')}.json`);
      const dump = runPythonEngine(spec, dataset.wav, outPath);
      if (dump.failed) {
        failures.push({ engine: spec.name, dataset: dataset.id, ...dump });
        console.log(`!! ${spec.name} on ${dataset.id} FAILED: ${dump.stderr.trim().split('\n').pop()}`);
        continue;
      }
      console.log(`   ${spec.name} on ${dataset.id}: ${dump.stdout}`);
      dumps.push(dump);
    }
    const sts = await runShippedSts(dataset.samples);
    dumps.push(sts);

    for (const dump of dumps) {
      if (dump.weights && dump.weights.length) {
        for (const w of dump.weights) {
          if (!weights.some((x) => x.engine === dump.engine && x.path === w.path)) {
            weights.push({ engine: dump.engine, ...w });
          }
        }
      }
      for (const [level, bits] of Object.entries(dump.levels)) {
        for (const [presetName, preset] of Object.entries(PRESETS)) {
          const filteredBits = postfilterBits(bits, preset);
          const row = {
            engine: dump.engine,
            label: dump.label,
            level,
            dataset: dataset.id,
            reference: dataset.reference,
            preset: presetName,
            prerollMs: preset.prerollMs,
            hangoverMs: preset.hangoverMs,
            // What the postfilter let through -- the reading the report's "filtered %" column is.
            speechFrames: filteredBits.split('').filter((c) => c === '1').length,
            prefilterSpeechFrames: bits.split('').filter((c) => c === '1').length,
            frameCount: nFrames,
            durationSec,
            ...computeMetrics({
              truth: dataset.truth,
              segments: framesToSegments(filteredBits),
              durationSec,
              silenceSec,
            }),
          };
          row.filteredPct = 100 * (1 - row.speechFrames / nFrames);
          tradeoff.push(row);
          if (dataset.reference === 'exact') truthRows.push(row);
        }
      }

      // The STS gate's own filter is its preroll/hangover, so its row also carries the reading
      // that does not depend on this harness's postfilter at all: what the module itself kept.
      if (dump.levels.native) {
        const nativeBits = dump.levels.native;
        const native = tradeoff[tradeoff.length - 1];
        tradeoff.push({
          ...native,
          preset: 'none',
          prerollMs: 0,
          hangoverMs: 0,
          speechFrames: nativeBits.split('').filter((c) => c === '1').length,
          filteredPct: 100 * (1 - speechSeconds(nativeBits) / durationSec),
          ...computeMetrics({
            truth: dataset.truth,
            segments: framesToSegments(nativeBits),
            durationSec,
            silenceSec,
          }),
        });
      }
    }

    for (const dump of dumps) {
      cost.push({
        engine: dump.engine,
        dataset: dataset.id,
        primaryLevel: ENGINE_SPECS.find((s) => s.name === dump.engine)?.primary ?? 'native',
        cpuSec: dump.cost.cpuSec,
        wallSec: dump.cost.wallSec,
        rtf: dump.cost.rtf,
        rssPeakKb: dump.cost.rssPeakKb,
        frameCount: dump.frameCount,
        durationSec: dump.durationSec,
        perLevel: dump.cost.perLevel ?? null,
      });
    }
  }

  checks.serverPidAfter = listeningPid(3001);
  checks.serverNotRestarted =
    checks.serverPidBefore === null || checks.serverPidBefore === checks.serverPidAfter;

  const report = {
    generatedAt: new Date().toISOString(),
    grid: { sampleRate: SR, hopSamples: HOP_SAMPLES, hopSec: HOP_SEC },
    presets: PRESETS,
    inputs: {
      realWav: REAL_WAV,
      realTimeline: REAL_TIMELINE,
      corpusRoot: CORPUS_ROOT,
      longRoot: LONG_ROOT,
      python: PYTHON,
    },
    datasets: datasets.map((d) => ({
      id: d.id,
      reference: d.reference,
      frames: Math.floor(d.samples.length / HOP_SAMPLES),
      durationSec: (Math.floor(d.samples.length / HOP_SAMPLES) * HOP_SEC).toFixed(2),
      truthCount: d.truth.length,
      note: d.note,
    })),
    checks,
    cost,
    tradeoff,
    truth: truthRows,
    weights,
    failures,
  };

  // ---- console summary -----------------------------------------------------------------------
  console.log('\n=== A. tradeoff on the real 372.66 s corpus (proxy reference, shipped postfilter) ===');
  console.log(
    'engine     level  filtered%  speech%   miss%   overseg%  midcut%  startP50(s)  endP50(s)',
  );
  for (const row of tradeoff.filter((r) => r.dataset === 'real' && r.preset === 'shipped')) {
    console.log(
      `${row.engine.padEnd(10)} ${String(row.level).padEnd(6)} ${row.filteredPct.toFixed(2).padStart(9)} ${(100 - row.filteredPct).toFixed(2).padStart(8)} ` +
        `${(row.missRate * 100).toFixed(2).padStart(7)} ${(row.oversegRate * 100).toFixed(2).padStart(9)} ${(row.midCutRate * 100).toFixed(2).padStart(8)} ` +
        `${(row.startDeviationP50 ?? 0).toFixed(3).padStart(11)} ${(row.endDeviationP50 ?? 0).toFixed(3).padStart(10)}`,
    );
  }

  // Rows B read each engine at its PRIMARY operating point (the level its own docs/practice
  // pick), not its most permissive one: the permissive end of every engine keeps almost
  // everything, so at that end miss% is trivially 0 and overseg% saturates -- degenerate rows
  // that say nothing about the engine. A is where the whole curve lives; B is the single point.
  const primaryOf = (engine) => String(ENGINE_SPECS.find((s) => s.name === engine)?.primary ?? 'native');
  // The four families the AC names -- boundary / miss / over-segmentation / mid-cut -- are all
  // here: the boundary reading is the start/end deviation pair, which is why those two are
  // printed next to the three rate columns.
  console.log('\n=== B. exact-truth metrics (per engine, PRIMARY level, shipped postfilter) ===');
  console.log(
    'dataset        engine     level  miss%  overseg%  midcut%  falseAlarm/h  ' +
      'startP50(s)  endP50(s)  startP95(s)  maxSegViol',
  );
  for (const row of truthRows.filter(
    (r) => r.preset === 'shipped' && r.level === primaryOf(r.engine),
  )) {
    console.log(
      `${row.dataset.padEnd(14)} ${row.engine.padEnd(10)} ${String(row.level).padEnd(6)} ` +
        `${(row.missRate * 100).toFixed(2).padStart(6)} ${(row.oversegRate * 100).toFixed(2).padStart(9)} ${(row.midCutRate * 100).toFixed(2).padStart(8)} ` +
        `${(row.falseAlarmSecPerHour ?? 0).toFixed(1).padStart(12)} ` +
        `${(row.startDeviationP50 ?? 0).toFixed(3).padStart(11)} ${(row.endDeviationP50 ?? 0).toFixed(3).padStart(10)} ` +
        `${(row.startDeviationP95 ?? 0).toFixed(3).padStart(12)} ${String(row.maxSegmentViolations).padStart(10)}`,
    );
  }

  // B2. AC4: the postfilter is the same object for every engine, so what it costs must be read
  // off by holding the engine fixed and moving the preset. Only the real corpus (proxy
  // reference) has the graded speech/silence timeline this needs.
  const presetOrder = ['shipped', 'loose', 'none'];
  const enginesHere = [...new Set(tradeoff.filter((r) => r.dataset === 'real').map((r) => r.engine))];
  console.log('\n=== B2. AC4 postfilter effect, primary level, real corpus (proxy reference) ===');
  console.log('engine     level   preroll/hangover  filtered%   speech%   midcut%');
  for (const engine of enginesHere) {
    for (const preset of presetOrder) {
      const row = tradeoff.find(
        (r) =>
          r.dataset === 'real' && r.engine === engine && r.preset === preset && r.level === primaryOf(engine),
      );
      if (!row) continue;
      console.log(
        `${row.engine.padEnd(10)} ${String(row.level).padEnd(7)} ` +
          `${`${row.prerollMs}/${row.hangoverMs}`.padEnd(17)} ${row.filteredPct.toFixed(2).padStart(9)} ` +
          `${(100 - row.filteredPct).toFixed(2).padStart(9)} ${(row.midCutRate * 100).toFixed(2).padStart(9)}`,
      );
    }
  }

  console.log('\n=== C. cost (real corpus, one process per engine) ===');
  console.log('engine     wall(s)   cpu(s)     rtf    rssPeak(MB)');
  for (const row of cost.filter((r) => r.dataset === 'real')) {
    console.log(
      `${row.engine.padEnd(10)} ${row.wallSec.toFixed(2).padStart(7)} ${(row.cpuSec ?? 0).toFixed(2).padStart(8)} ` +
        `${row.rtf.toFixed(5).padStart(8)} ${((row.rssPeakKb ?? 0) / 1024).toFixed(1).padStart(11)}`,
    );
  }

  console.log('\n=== D. weights provenance ===');
  for (const w of weights) {
    console.log(`${w.engine.padEnd(8)} sha256[0:16]=${String(w.sha256_16).padEnd(18)} ${w.sourceUrl}  ${w.path}`);
  }

  console.log('\n=== checks ===');
  console.log(JSON.stringify(checks, null, 2));
  if (failures.length) console.log(`\n!! failures: ${failures.length}`);

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${args.out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
