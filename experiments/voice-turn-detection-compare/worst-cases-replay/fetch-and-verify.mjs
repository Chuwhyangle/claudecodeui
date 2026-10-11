#!/usr/bin/env node
/**
 * P0.15 — RE-FETCH and VERIFY the exact bytes behind the P0.13 worst-case replay.
 *
 * WHY THIS FILE EXISTS. P0.13's per-sample evidence was never written down: its `RESULT.json` holds
 * aggregate rates only, and the audio (parquet + per-turn WAVs), the LibriSpeech clips and the score
 * caches all lived under gitignored `data/`, `_cache/` and `datasets/real/` paths inside a worktree
 * that fan-in reclaimed. Nothing about that was a licence problem — both corpora are CC-BY-4.0 and
 * permit redistribution — it was build hygiene. So this task re-fetches the SAME bytes from the SAME
 * pinned revisions and PROVES they are the same bytes by recomputing sha256 on every artifact it
 * hands to the scorer.
 *
 * WHAT IT GUARANTEES. Every artifact the replay consumes is either
 *   · produced here from a pinned revision, with its sha256 recomputed and compared to the pin, or
 *   · the pin itself, recorded verbatim in `data/reproduction.json` so the reading is auditable
 *     rather than asserted.
 * A mismatch throws. It never "assumes" equality.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not touch `english-smart-turn-vs-turn1mini/**` (P0.13's
 * landed artifacts) or `chinese-zeroshot-and-ft-readiness/**` (the P0.14 worker's in-flight tree).
 * The two P0.13 python scripts are used as BYTE-IDENTICAL COPIES in this directory (see COPIES
 * below) rather than invoked in place, so nothing under the P0.13 path is written — and the copies
 * are sha256-compared against their originals on every run, so "identical copy, pins unchanged" is a
 * re-checked fact, not a claim.
 *
 * Usage:
 *   node .../fetch-and-verify.mjs --corpus-a     # LibriSpeech rows (16 clips) + sha256 verification
 *   node .../fetch-and-verify.mjs --corpus-b     # eot-bench parquet -> 400 per-turn WAVs (python)
 *   node .../fetch-and-verify.mjs --models       # Smart Turn + turn-1-mini ONNX resolution + sha256
 *   node .../fetch-and-verify.mjs --licences     # first-hand licence/attribution text, hashed
 *   node .../fetch-and-verify.mjs --all          # all of the above, then write data/reproduction.json
 *   node .../fetch-and-verify.mjs --report       # re-emit data/reproduction.json from what is on disk
 *
 * Egress: huggingface.co (model + dataset + cards), datasets-server.huggingface.co (LibriSpeech rows
 * API), openslr.org (LibriSpeech licence page). All public and non-billed; no paid endpoint, no API
 * key, and no credential is read from the environment.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPARE_DIR = path.resolve(DIR, '..');
const P13_DIR = path.join(COMPARE_DIR, 'english-smart-turn-vs-turn1mini');
const P06_MANIFEST = path.join(COMPARE_DIR, 'manifest.json');
const DATA = path.join(DIR, 'data');
const VENV_PY = path.join(DIR, '.venv', 'bin', 'python');
const REPRODUCTION_PATH = path.join(DATA, 'reproduction.json');
const CORPUS_A_DIR = path.join(DATA, 'corpus-a');
const CORPUS_A_SAMPLES = path.join(DATA, 'corpus-a-samples.json');

// ── pins (verbatim from P0.13; this file never re-selects a revision) ────────────────────────────
const PINS = {
  eotBench: {
    dataset: 'livekit/eot-bench-data',
    splitFile: 'data/en/validation-00000-of-00001.parquet',
    revision: 'ca9d98a9686b920a2d8c9eb984224ba9be74e4dd',
    parquetSha256: 'e475d435c8e693912243e8a810bf7e34a59e01e208551ce5b362c9c778b0fdc4',
    parquetBytes: 162406142,
    licenseSpdx: 'CC-BY-4.0',
    turns: 400,
    spans: 1250,
    holdsInDenominator: 705,
    eotSpans: 400,
    groups: 96,
  },
  librispeech: {
    dataset: 'openslr/librispeech_asr',
    config: 'clean',
    split: 'test',
    licenseSpdx: 'CC-BY-4.0',
    licenseUrl: 'https://www.openslr.org/12/',
    attribution: 'LibriSpeech (c) 2014 by Vassil Panayotov, CC BY 4.0',
    // The P0.6 annotation of these clips is the committed manifest; the audio is re-fetched and
    // pinned by the sha256 the manifest recorded.
    annotationSource: 'experiments/voice-turn-detection-compare/manifest.json',
  },
  smartTurn: {
    repo: 'pipecat-ai/smart-turn-v3',
    revision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93',
    file: 'smart-turn-v3.2-cpu.onnx',
    sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
    bytes: 8679182,
    licenseSpdx: 'BSD-2-Clause',
  },
  turn1Mini: {
    repo: 'p99lab/turn-1-mini',
    revision: '076c86d1744a231d3a4cce31f3bbbd1211b4c281',
    onnxFile: 'onnx/turn-1-mini.step.onnx',
    onnxSha256: 'e747b182d685c7db489a3ea2e12bdcd65bac506fcddec00ed3cd0bf9f209fd11',
    safetensorsSha256: 'd03ccff872eb0ae2ed0366b1ea94d860328daa0122bf9003fb32b7a34b14acb9',
    p99turnVersion: '1.2.3',
    p99turnWheelSha256: '4cb4802e04ae8b013f14499d858024a59ec40cc9d36db8b8c49155d623b7e273',
    licenseSpdx: 'Apache-2.0',
  },
};

/** The P0.13 scripts this task REUSES. Copied here byte-for-byte; the copy is re-verified each run. */
const COPIES = ['fetch-eot-bench-english.py', 'run-turn1mini.py', 'requirements.txt'];

const SMART_TURN_MODEL =
  process.env.SMART_TURN_MODEL ?? path.join(os.homedir(), '.cache', 'voice-turn-detection-compare', 'smart-turn-v3.2-cpu.onnx');

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
const nowIso = () => new Date().toISOString();
const rel = (p) => path.relative(path.resolve(DIR, '..', '..', '..'), p);

// ── copy verification: the reused P0.13 scripts must be byte-identical to their originals ────────
function copies() {
  return COPIES.map((name) => {
    const mine = path.join(DIR, name);
    const theirs = path.join(P13_DIR, name);
    const mineSha = existsSync(mine) ? sha256File(mine) : null;
    const theirSha = existsSync(theirs) ? sha256File(theirs) : null;
    return {
      file: name,
      copy: rel(mine),
      original: rel(theirs),
      copySha256: mineSha,
      originalSha256: theirSha,
      byteIdentical: mineSha !== null && mineSha === theirSha,
    };
  });
}

// ── corpus A: the 16 LibriSpeech clips, pinned by the sha256 the P0.6 manifest recorded ──────────
/** The LibriSpeech records the committed P0.6 manifest annotates (English, real). */
function librispeechRecords() {
  const m = JSON.parse(readFileSync(P06_MANIFEST, 'utf8'));
  return m.samples
    .filter((s) => s.source === 'real' && s.language === 'en')
    .map((s) => ({
      id: s.id,
      rowIndex: s.provenance.rowIndex,
      speakerId: s.provenance.speakerId,
      chapterId: s.provenance.chapterId,
      corpusId: s.provenance.corpusId,
      reference: s.reference,
      sha256: s.sha256,
      durationSeconds: s.durationSeconds,
      licenseSpdx: s.provenance.licenseSpdx,
      licenseUrl: s.provenance.licenseUrl,
      licenseInDistribution: s.provenance.licenseInDistribution,
      attribution: s.provenance.attribution,
      fetchScript: s.provenance.fetchScript,
      candidatePoints: s.candidatePoints,
    }));
}

async function fetchCorpusA() {
  const wanted = librispeechRecords();
  mkdirSync(CORPUS_A_DIR, { recursive: true });
  // One rows-API call covers every row index the manifest references (0..16 inclusive; row 12 was
  // dropped by P0.6 for being under 2 s, so it is absent from the manifest and from this set).
  const maxRow = Math.max(...wanted.map((r) => r.rowIndex));
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(PINS.librispeech.dataset)}&config=${PINS.librispeech.config}&split=${PINS.librispeech.split}&offset=0&length=${maxRow + 1}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rows API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { rows } = await res.json();
  const byRow = new Map(rows.map((r) => [r.row_idx, r.row]));

  const out = [];
  const verdicts = [];
  for (const rec of wanted) {
    const row = byRow.get(rec.rowIndex);
    if (!row) throw new Error(`rows API returned no row ${rec.rowIndex} for ${rec.id}`);
    const audio = Array.isArray(row.audio) ? row.audio[0] : row.audio;
    const srcUrl = audio?.src;
    if (!srcUrl) throw new Error(`row ${rec.rowIndex}: no audio src`);
    const flac = path.join(CORPUS_A_DIR, `.tmp-${rec.id}.flac`);
    const wav = path.join(CORPUS_A_DIR, `${rec.id}.wav`);
    const wavResponse = await fetch(srcUrl);
    if (!wavResponse.ok) throw new Error(`audio fetch ${wavResponse.status} for ${rec.id}`);
    writeFileSync(flac, Buffer.from(await wavResponse.arrayBuffer()));
    // Same transcode P0.6's fetch-real-samples.mjs used: 16 kHz mono PCM s16le.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', flac, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    execFileSync('rm', ['-f', flac]);
    const digest = sha256File(wav);
    const duration = Number(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', wav], { encoding: 'utf8' }).trim(),
    );
    const ok = digest === rec.sha256;
    verdicts.push({ id: rec.id, rowIndex: rec.rowIndex, committedSha256: rec.sha256, refetchedSha256: digest, matches: ok, bytes: statSync(wav).size, durationSeconds: Number(duration.toFixed(3)) });
    if (!ok) throw new Error(`${rec.id}: re-fetched sha256 ${digest} != committed ${rec.sha256}`);
    out.push({ ...rec, refetchedSha256: digest, refetchedBytes: statSync(wav).size, refetchedDurationSeconds: Number(duration.toFixed(3)), wav: `${rel(wav)}`, verifiedAt: nowIso() });
  }
  writeFileSync(
    CORPUS_A_SAMPLES,
    `${JSON.stringify(
      {
        schema: 'voice-turn-detection-compare/worst-cases-replay/corpus-a@1',
        generatedBy: 'fetch-and-verify.mjs',
        generatedAt: nowIso(),
        provenance: PINS.librispeech,
        sourceManifest: rel(P06_MANIFEST),
        how: 'HF datasets-server rows API (row_index -> per-row FLAC url) + ffmpeg -ac 1 -ar 16000 -c:a pcm_s16le, the same recipe P0.6 used; each clip then sha256-compared against the sha256 the committed P0.6 manifest recorded',
        verification: verdicts,
        sampleCount: out.length,
        candidatePointCount: out.reduce((a, r) => a + r.candidatePoints.length, 0),
        samples: out,
      },
      null,
      2,
    )}\n`,
  );
  return {
    records: out.length,
    candidatePoints: out.reduce((a, r) => a + r.candidatePoints.length, 0),
    eotPoints: out.reduce((a, r) => a + r.candidatePoints.filter((c) => c.truth === 'END').length, 0),
    holdPoints: out.reduce((a, r) => a + r.candidatePoints.filter((c) => c.truth === 'CONTINUE').length, 0),
    allSha256Match: verdicts.every((v) => v.matches),
    perClip: verdicts,
    samplesJson: rel(CORPUS_A_SAMPLES),
  };
}

// ── corpus B: the eot-bench English validation split, via the pinned P0.13 fetcher ───────────────
function fetchCorpusB() {
  if (!existsSync(VENV_PY)) throw new Error(`venv python missing at ${VENV_PY} — run: python3 -m venv --without-pip .venv && python3 -m pip --python .venv/bin/python install ...`);
  const out = execFileSync(VENV_PY, ['-I', path.join(DIR, 'fetch-eot-bench-english.py')], { cwd: DIR, encoding: 'utf8' });
  const manifestPath = path.join(DATA, 'eot-bench-en-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const parquetPath = path.join(DATA, 'eot-bench-en-validation.parquet');
  const parquetSha = sha256File(parquetPath);
  const parquetBytes = statSync(parquetPath).size;
  if (parquetSha !== PINS.eotBench.parquetSha256) throw new Error(`parquet sha256 ${parquetSha} != pinned ${PINS.eotBench.parquetSha256}`);
  if (parquetBytes !== PINS.eotBench.parquetBytes) throw new Error(`parquet bytes ${parquetBytes} != pinned ${PINS.eotBench.parquetBytes}`);

  // Every extracted WAV is hashed here as well (the fetcher's own manifest does not carry per-WAV
  // hashes): it is the bytes-identity record the worst-case rows quote.
  const audioDir = path.join(DATA, 'eot-bench-audio');
  const wavs = readdirSync(audioDir).filter((f) => f.endsWith('.wav')).sort();
  const wavSha = {};
  let wavBytes = 0;
  for (const f of wavs) {
    wavSha[f] = sha256File(path.join(audioDir, f));
    wavBytes += statSync(path.join(audioDir, f)).size;
  }
  const c = manifest.counts;
  const checks = {
    spans: c.spans === PINS.eotBench.spans,
    eotSpans: c.eotSpans === PINS.eotBench.eotSpans,
    holdsInDenominator: c.holdSpansInDenominator === PINS.eotBench.holdsInDenominator,
    groups: c.groups === PINS.eotBench.groups,
    turns: manifest.provenance.turns === PINS.eotBench.turns,
    wavFiles: wavs.length === PINS.eotBench.turns,
    parquetSha256: parquetSha === PINS.eotBench.parquetSha256,
    parquetBytes: parquetBytes === PINS.eotBench.parquetBytes,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`corpus B verification failed: ${JSON.stringify(checks)}`);
  return {
    fetcher: 'fetch-eot-bench-english.py (byte-identical copy of the P0.13 fetcher; pins unchanged)',
    fetcherStdoutTail: out.trim().split('\n').slice(-16),
    counts: c,
    checks,
    parquet: { file: rel(parquetPath), sha256: parquetSha, bytes: parquetBytes, matchesPin: true },
    wavFiles: wavs.length,
    wavTotalBytes: wavBytes,
    wavSha256: wavSha,
    manifest: rel(manifestPath),
  };
}

// ── models: both ONNX weight files, resolved at the pinned revisions and re-hashed ───────────────
function resolveModels() {
  // Smart Turn: the checkpoint P0.13 used, cached outside the repo. Re-hashed every run.
  if (!existsSync(SMART_TURN_MODEL)) throw new Error(`Smart Turn ONNX missing at ${SMART_TURN_MODEL} (set SMART_TURN_MODEL)`);
  const stSha = sha256File(SMART_TURN_MODEL);
  const stBytes = statSync(SMART_TURN_MODEL).size;
  if (stSha !== PINS.smartTurn.sha256) throw new Error(`Smart Turn onnx sha256 ${stSha} != pinned ${PINS.smartTurn.sha256}`);
  if (stBytes !== PINS.smartTurn.bytes) throw new Error(`Smart Turn onnx bytes ${stBytes} != pinned ${PINS.smartTurn.bytes}`);

  // turn-1-mini: resolved through the pinned p99turn runtime's own hub client at the pinned revision.
  // Done in the venv (huggingface_hub is already a dependency of the official runtime) so the model
  // resolution uses the same client the runtime does, not a second downloader.
  const py = `
import hashlib, json, os
from huggingface_hub import hf_hub_download
os.environ.setdefault("HF_HOME", ${JSON.stringify(path.join(DATA, 'hf'))})
p = hf_hub_download(repo_id="p99lab/turn-1-mini", filename="onnx/turn-1-mini.step.onnx", revision=${JSON.stringify(PINS.turn1Mini.revision)})
h = hashlib.sha256()
with open(p, "rb") as fh:
    for b in iter(lambda: fh.read(1 << 20), b""):
        h.update(b)
print(json.dumps({"path": p, "sha256": h.hexdigest(), "bytes": os.path.getsize(p)}))
`;
  const raw = execFileSync(VENV_PY, ['-I', '-c', py], { encoding: 'utf8' }).trim();
  const t1m = JSON.parse(raw.split('\n').pop());
  if (t1m.sha256 !== PINS.turn1Mini.onnxSha256) throw new Error(`turn-1-mini onnx sha256 ${t1m.sha256} != pinned ${PINS.turn1Mini.onnxSha256}`);

  const pipList = execFileSync(VENV_PY, ['-I', '-m', 'pip', 'list', '--format=json'], { encoding: 'utf8' });
  const installed = Object.fromEntries(JSON.parse(pipList).map((p) => [p.name, p.version]));
  const want = { p99turn: PINS.turn1Mini.p99turnVersion, onnxruntime: '1.31.0', numpy: '2.5.4', pyarrow: '26.0.0', huggingface_hub: '2.2.0' };
  const envChecks = Object.fromEntries(Object.entries(want).map(([k, v]) => [`${k}==${v}`, installed[k] === v]));
  if (!Object.values(envChecks).every(Boolean)) throw new Error(`venv version mismatch: ${JSON.stringify({ envChecks, installed })}`);

  return {
    smartTurn: { ...PINS.smartTurn, modelPath: SMART_TURN_MODEL, observedSha256: stSha, observedBytes: stBytes, matchesPin: true },
    turn1Mini: { ...PINS.turn1Mini, resolvedPath: t1m.path, observedSha256: t1m.sha256, observedBytes: t1m.bytes, matchesPin: true },
    pythonEnv: { installed: want, checks: envChecks, python: execFileSync(VENV_PY, ['-I', '--version'], { encoding: 'utf8' }).trim() },
    note: 'torch/scipy/safetensors/pandas/soundfile from the P0.13 requirements are NOT installed here: they exist only for P0.13\'s AC3 torch cross-runtime self-check, which this task does not re-run (run-turn1mini.py reports torchAvailable:false rather than faking a pass). The pins that matter — the ONNX weights and p99turn — are identical.',
  };
}

// ── licences: first-hand text, hashed, with the retrieval timestamp ───────────────────────────────
async function fetchLicences() {
  const grabs = [
    {
      what: 'livekit/eot-bench-data dataset card (carries the CC-BY-4.0 declaration + citation)',
      url: `https://huggingface.co/datasets/${PINS.eotBench.dataset}/raw/${PINS.eotBench.revision}/README.md`,
    },
    { what: 'CC-BY-4.0 legal code (the corpus licence both corpora are distributed under)', url: 'https://creativecommons.org/licenses/by/4.0/legalcode.txt' },
    { what: 'LibriSpeech corpus page (OpenSLR SLR12; licence + attribution statement)', url: PINS.librispeech.licenseUrl },
    {
      what: 'p99lab/turn-1-mini LICENSE at the pinned revision',
      url: `https://huggingface.co/${PINS.turn1Mini.repo}/raw/${PINS.turn1Mini.revision}/LICENSE`,
    },
  ];
  const out = [];
  for (const g of grabs) {
    try {
      const res = await fetch(g.url, { redirect: 'follow' });
      const body = await res.text();
      out.push({ what: g.what, url: g.url, status: res.status, retrievedAt: nowIso(), bytes: Buffer.byteLength(body), sha256: sha256Buf(body), excerpt: body.slice(0, 1200) });
    } catch (err) {
      out.push({ what: g.what, url: g.url, status: null, retrievedAt: nowIso(), error: String(err) });
    }
  }
  const captured = readFileSync(path.join(COMPARE_DIR, 'dataset-sources.json'), 'utf8');
  return {
    grabs: out,
    corpusAttribution: {
      eotBench: 'livekit/eot-bench-data (CC-BY-4.0), revision ca9d98a9686b920a2d8c9eb984224ba9be74e4dd — attribution as stated in the dataset card grab above',
      librispeech: 'LibriSpeech (c) 2014 by Vassil Panayotov, CC BY 4.0 — audio decoded from the corpus-native FLAC; source openslr/librispeech_asr clean/test',
    },
    p06FirstHandRecord: {
      file: rel(path.join(COMPARE_DIR, 'dataset-sources.json')),
      sha256: sha256Buf(captured),
      note: 'P0.6 read the licences FIRST-HAND (LibriSpeech/LICENSE.TXT inside dev-clean.tar.gz; the OpenSLR pages) and recorded the text in this committed file; re-captured here by hash so the P0.15 deliverable quotes a text that is still the committed one.',
    },
  };
}

// ── report assembly ──────────────────────────────────────────────────────────────────────────────
function buildReport(parts) {
  const disk = (p) => (existsSync(p) ? { path: rel(p), bytes: statSync(p).size, sha256: sha256File(p) } : null);
  return {
    schema: 'voice-turn-detection-compare/worst-cases-replay/reproduction@1',
    generatedBy: 'fetch-and-verify.mjs',
    generatedAt: nowIso(),
    task: 'gap-voice-turn-detection-p0-15-worst-cases-replay',
    pins: PINS,
    copiedP013Scripts: copies(),
    corpusA: parts.corpusA ?? null,
    corpusB: parts.corpusB ?? null,
    models: parts.models ?? null,
    licences: parts.licences ?? null,
    artifacts: {
      thisScript: disk(fileURLToPath(import.meta.url)),
      scorer: disk(path.join(DIR, 'extract-worst-cases.mts')),
      worstCases: disk(path.join(DIR, 'worst-cases.jsonl')),
      errorReport: disk(path.join(DIR, 'ERROR-REPORT.md')),
      readme: disk(path.join(DIR, 'README.md')),
      result: disk(path.join(DIR, 'RESULT.json')),
    },
    egress: {
      hosts: ['huggingface.co', 'datasets-server.huggingface.co', 'creativecommons.org', 'openslr.org'],
      kind: 'public corpus/model/card pulls only — no paid endpoint, no API key read',
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const ALL = has('--all') || argv.length === 0;
  mkdirSync(DATA, { recursive: true });
  const prev = existsSync(REPRODUCTION_PATH) ? JSON.parse(readFileSync(REPRODUCTION_PATH, 'utf8')) : {};
  const parts = { corpusA: prev.corpusA ?? null, corpusB: prev.corpusB ?? null, models: prev.models ?? null, licences: prev.licences ?? null };

  if (ALL || has('--corpus-a')) {
    console.log('— corpus A: LibriSpeech clips (rows API + ffmpeg) —');
    parts.corpusA = await fetchCorpusA();
    console.log(`  ${parts.corpusA.records} clips, ${parts.corpusA.candidatePoints} candidate points, all sha256 match: ${parts.corpusA.allSha256Match}`);
  }
  if (ALL || has('--corpus-b')) {
    console.log('— corpus B: eot-bench English validation (pinned parquet -> 400 WAVs) —');
    parts.corpusB = fetchCorpusB();
    console.log(`  ${JSON.stringify(parts.corpusB.counts)}`);
  }
  if (ALL || has('--models')) {
    console.log('— models: Smart Turn + turn-1-mini ONNX —');
    parts.models = resolveModels();
    console.log(`  smart-turn ${parts.models.smartTurn.observedSha256.slice(0, 16)}…  turn-1-mini ${parts.models.turn1Mini.observedSha256.slice(0, 16)}…`);
  }
  if (ALL || has('--licences')) {
    console.log('— licences: first-hand text —');
    parts.licences = await fetchLicences();
    console.log(`  ${parts.licences.grabs.filter((g) => g.status === 200).length}/${parts.licences.grabs.length} fetched`);
  }

  const report = buildReport(parts);
  writeFileSync(REPRODUCTION_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${rel(REPRODUCTION_PATH)}`);
  const bad = report.copiedP013Scripts.filter((c) => !c.byteIdentical);
  if (bad.length) throw new Error(`reused P0.13 scripts are NOT byte-identical: ${JSON.stringify(bad)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
