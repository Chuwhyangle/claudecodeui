/**
 * P0.15 — the worst-case replay: WHICH real samples do Smart Turn v3.2 and turn-1-mini get wrong,
 * at the exact non-degenerate operating point P0.13 published, on audio this task re-fetched itself.
 *
 * WHY THIS FILE EXISTS. P0.13 answered "how well does each model score" with aggregate rates and a
 * Pareto frontier, and deliberately wrote no per-sample record: its `RESULT.json` holds
 * `denominator`/`gate`/`frontier`/`dense` and nothing else. So the question a person actually asks
 * next — *which recording, and what did the model say just before it was wrong* — had no answer that
 * could be read off a committed artifact. This file produces that answer, and it produces it from a
 * REAL re-run: the audio is re-fetched from the pinned revisions (see `fetch-and-verify.mjs`), both
 * models are re-scored here, and every number in the output is a measurement from this run. Nothing
 * is back-derived from P0.13's aggregates; instead P0.13's published k/n is used the other way round,
 * as an INTEGER EQUALITY CHECK on this run's independent recomputation (AC5) — if the two disagree the
 * run fails loudly rather than quietly reporting different numbers under the same label.
 *
 * WHAT IS FIXED, AND WHY NOTHING IS RE-SELECTED. The operating point is
 * `threshold=0.13, actionDelaySeconds=1, timeoutSeconds=3.5` — the exact tuple P0.13's CONCLUSION §2b
 * reports for BOTH models on the `merged` view (Smart Turn cutoff 33/705, missed 27/400; turn-1-mini
 * 32/705, 14/400). Reusing one policy tuple is what makes the two models' per-span verdicts strictly
 * comparable, and reusing P0.13's tuple is what makes AC5 a real check instead of a tautology. The
 * threshold grid is NOT re-swept here: a fresh sweep would land on some other row and the comparison
 * would evaporate. One extra row IS computed — the `threshold=0` degenerate baseline at the same
 * actionDelay/timeout, i.e. "never look at the model score, just wait" — so the report can say whether
 * either model beats a plain timer (AC3), which is the cheapest possible sanity check on a detector.
 *
 * THE TWO ERROR CLASSES, AND HOW THE PROTOCOL DEFINES THEM (protocol.mts, replicated from eot-bench):
 *   · FALSE CUTOFF — a `hold` span (the speaker only paused; GT says they continue). The policy cuts it
 *     because either the model fired and the pause outlasted `max(actionDelay, fire)`, or the pause
 *     outlasted `timeout`. Severity = how EARLY the cut landed relative to the true end of the pause.
 *   · MISSED END — an `eot` span (the speaker really finished). The model never crossed the threshold
 *     inside `timeout`, so the endpoint was only "detected" by the timeout expiring. Severity = how far
 *     past `timeout` the model's own fire time sits, with "never fires at all" as the worst case.
 * Both counts come from `protocol.mts`'s own `sweepPolicies` — the same code P0.13 used — so a
 * disagreement with P0.13 could only come from the SPANS or the SCORES, never from the policy reading.
 *
 * THE SCORING IS SHARDABLE AND CACHE-BACKED. Smart Turn is stateless per query (a fresh 8 s window per
 * cell), so this is one ONNX call per cell — ~11.5k cells over the merged corpus. `--shards N` forks N
 * workers that each own a disjoint slice of SPANS (not of cells: a span is the unit whose score array
 * must be whole), and the parent unions the shard tables and asserts every span's array came back at
 * its full grid length. The merged table is written in the same `{cells, scores}` shape P0.13's cache
 * used, and `--audit-cells N` re-runs N cached cells with a fresh ONNX call and reports the max
 * absolute deviation — so "the cache is the model, not a stale file" is measured, not assumed.
 *
 * COURTESY CHECK BEFORE HEAVY INFERENCE (AC6 / Plan 2). Before the first cell is scored, this file
 * polls `ps aux` for the SIBLING task's heavy inference (`run-benchmark.mts` / `run-turn1mini.py` /
 * `full-suite-runner.js` whose command line names the P0.14 worktree). If one is running it waits and
 * polls (≤ 10 min per poll, bounded total), and either way the detection time, the hits, the waited
 * duration and the proceed/park decision land in `RESULT.json`. The check is mechanical on purpose: the
 * filing note's resource snapshot is not a substitute for looking again at the moment work starts.
 *
 * Run (from the repository root; paths resolve from this file):
 *   node_modules/.bin/tsx --tsconfig server/tsconfig.json \
 *     experiments/voice-turn-detection-compare/worst-cases-replay/extract-worst-cases.mts --shards 8
 * Flags: --no-python (reuse an existing turn-1-mini scores file) · --no-cache · --shards N ·
 *        --audit-cells N · --no-courtesy (skip the concurrency poll; recorded as skipped)
 * Writes `worst-cases.jsonl`, `RESULT.json`, `ERROR-REPORT.md` beside this file. Nothing here touches
 * production (the two Live Voice paths are diffed empty and recorded), no training weight is fetched,
 * and no paid endpoint is called.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ort from 'onnxruntime-web';

import { EPS, causalGrid, spanFire, sweepPolicies, wilson95, type GridPoint, type PolicyRow, type SpanFire } from '../eot-bench-adapters/protocol.mts';
import { compiledWhisperLogMel, loadCompiledFeatures } from '../adapters/smart-turn-compiled-features.mts';
import { createSmartTurnSession, decodeWav, truncateToLastSeconds, type SmartTurnSession } from '../adapters/smart-turn-v3.mts';

const SELF = fileURLToPath(import.meta.url);
const DIR = path.dirname(SELF);
const REPO_ROOT = path.resolve(DIR, '..', '..', '..');
const DATA = path.join(DIR, 'data');
const CORPUS_A_DIR = path.join(DATA, 'corpus-a');
const CORPUS_A_SAMPLES = path.join(DATA, 'corpus-a-samples.json');
const EOT_MANIFEST = path.join(DATA, 'eot-bench-en-manifest.json');
const REPRODUCTION = path.join(DATA, 'reproduction.json');
const SPANS_PATH = path.join(DATA, 'spans.json');
const T1M_SCORES = path.join(DATA, 'turn1mini-scores.json');
const SHARD_DIR = path.join(DATA, 'shards');
const CACHE_DIR = path.join(DIR, '_cache');
const WORST_CASES = path.join(DIR, 'worst-cases.jsonl');
const RESULT_PATH = path.join(DIR, 'RESULT.json');
const ERROR_REPORT = path.join(DIR, 'ERROR-REPORT.md');
const VENV_PYTHON = path.join(DIR, '.venv', 'bin', 'python');
const P13_DIR = path.join(DIR, '..', 'english-smart-turn-vs-turn1mini');
const P13_RESULT = path.join(P13_DIR, 'RESULT.json');
/** The sibling task's worktree: the ONLY path the courtesy check treats as a competing consumer.
 *  This worktree is a SIBLING of it under the same `claudecodeui-worktrees/` parent, so the path is
 *  derived from this worktree's own root rather than from the repository root (which is the worktree). */
const P14_WORKTREE = path.resolve(REPO_ROOT, '..', 'gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness');

const MODEL_SR = 16000;
const INTERVAL = 0.1;
const SMART_TURN_MODEL =
  process.env.SMART_TURN_MODEL ?? path.join(process.env.HOME ?? '', '.cache', 'voice-turn-detection-compare', 'smart-turn-v3.2-cpu.onnx');

// ── the pin, the point, and P0.13's published k/n (the AC5 comparison targets) ────────────────────
const OPERATING_POINT = { threshold: 0.13, actionDelaySeconds: 1, timeoutSeconds: 3.5 } as const;
const BASELINE_POINT = { threshold: 0, actionDelaySeconds: 1, timeoutSeconds: 3.5 } as const;

/** Read OFF P0.13's committed RESULT.json at load time (not typed in from the conclusion prose), so a
 *  changed P0.13 artifact changes the target instead of silently passing a stale expectation.
 *  A view whose operating-point row is absent returns null rather than a fabricated target: P0.13
 *  published only the PARETO FRONTIER per view, and on the degenerate corpus-A view (5 holds / 16 EoT)
 *  the 0.13/1/3.5 row is dominated by threshold 0.01 + actionDelay 0.5 + timeout 1 (same 0/5 and 0/16,
 *  zero latency), so it is legitimately not in the published set. That is reported as "not published",
 *  which is the honest state — never as a match and never as a divergence. */
function publishedTargets(): Record<string, Record<string, { cutoffK: number; cutoffN: number; missedK: number; missedN: number; meanLatencySeconds: number | null } | null>> {
  const doc = JSON.parse(readFileSync(P13_RESULT, 'utf8')) as {
    analysis: Record<string, { interval0_1: { views: Record<string, { frontier: Array<Record<string, number>> }> } }>;
  };
  const out: Record<string, Record<string, { cutoffK: number; cutoffN: number; missedK: number; missedN: number; meanLatencySeconds: number | null } | null>> = {};
  for (const model of ['smart-turn-v3.2', 'turn-1-mini']) {
    out[model] = {};
    for (const view of ['eot-bench-en', 'librispeech-en-real', 'merged']) {
      const rows = doc.analysis[model].interval0_1.views[view].frontier;
      const row = rows.find(
        (r) => r.threshold === OPERATING_POINT.threshold && r.actionDelaySeconds === OPERATING_POINT.actionDelaySeconds && r.timeoutSeconds === OPERATING_POINT.timeoutSeconds,
      );
      if (!row) {
        out[model][view] = null;
        continue;
      }
      const fc = row.falseCutoff as unknown as { k: number; n: number };
      const me = row.missedEnd as unknown as { k: number; n: number };
      out[model][view] = { cutoffK: fc.k, cutoffN: fc.n, missedK: me.k, missedN: me.n, meanLatencySeconds: (row.meanLatencySeconds as number) ?? null };
    }
  }
  return out;
}

/** P0.13's published speaker/session group count for the English corpus — `groupDistribution.groups`
 *  off the same committed RESULT.json the k/n targets come from. AC1 asks this run's grouping to MATCH
 *  P0.13's, so it is compared against the published integer rather than asserted from this run alone;
 *  `null` means P0.13 published no distribution for that view (recorded, never treated as a pass). */
function p13PublishedGroups(): number | null {
  const doc = JSON.parse(readFileSync(P13_RESULT, 'utf8')) as {
    analysis: Record<string, { interval0_1: { views: Record<string, { groupDistribution?: { groups?: number } }> } }>;
  };
  return doc.analysis['smart-turn-v3.2'].interval0_1.views['eot-bench-en'].groupDistribution?.groups ?? null;
}

// ── flags ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv;
const flagValue = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
/** `--smoke N`: score only the first N spans and write NO artifact — a cheap end-to-end dry run of the
 *  parent path (union, verdicts, ordering, rendering) whose output cannot be mistaken for a result. */
const SMOKE = Math.max(0, Number(flagValue('--smoke') ?? 0));
const SHARD_INDEX = flagValue('--shard') === null ? null : Number(flagValue('--shard'));
// Smoke mode pins one shard: a shard worker slices the SAME span list the parent built, so a smaller
// list under `--shards N` would leave spans the parent then reports as missing from every shard.
const SHARD_COUNT = SMOKE > 0 ? 1 : Math.max(1, Number(flagValue('--shards') ?? 8));
const AUDIT_CELLS = Math.max(0, Number(flagValue('--audit-cells') ?? 64));
/** `--emit <path>`: write RESULT.json here instead of the default, and write nothing else. Used to
 *  produce a second, independently-derived result file for the determinism comparison. */
const EMIT = flagValue('--emit');
/** `--determinism-check`: after computing the analysis, re-run the WHOLE pipeline in a fresh child
 *  process and compare the two result documents (ignoring timestamps), recording the verdict in
 *  RESULT.json. This is the "run it a second time and show the evidence" half of AC4. */
const DETERMINISM = argv.includes('--determinism-check');
/** Children of a determinism check must not recurse into another determinism check. */
const IS_CHILD = EMIT !== null;
const NO_PYTHON = argv.includes('--no-python');
const NO_CACHE = argv.includes('--no-cache');
const NO_COURTESY = argv.includes('--no-courtesy');

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const rel = (p: string): string => path.relative(REPO_ROOT, p);
const nowIso = (): string => new Date().toISOString();
const round = (x: number, d = 6): number => Number(x.toFixed(d));

// ── the span record (the merge of both corpora into one causal-replay shape) ──────────────────────
type Span = {
  key: string;
  spanKey: string;
  corpus: 'librispeech-en-real' | 'eot-bench-en';
  group: string;
  speaker: string;
  id: string;
  spanIndex: number;
  label: 'eot' | 'hold';
  onsetMs: number;
  silenceMs: number;
  sampleRate: number;
  appendTailMs: number;
  clipMs: number;
  wav: string;
  audio: Float32Array;
  /** AC2's per-record provenance: how a reader obtains exactly these bytes. */
  reproduction: Record<string, unknown>;
  sha256: string;
};

/**
 * The MEASURED per-file hashes from the fetch+verify step. `data/reproduction.json` is written by
 * `fetch-and-verify.mjs` from the bytes it actually downloaded, so these are measurements, not the pins
 * copied out of the task prose — which is exactly what AC2/AC4 ask each record to carry. Every lookup is
 * fail-closed: a span with no measured hash is a hard error rather than a record with `sha256: null`,
 * because an empty hash would make the record look complete while carrying no evidence at all.
 */
let reproductionDoc: Record<string, any> | null = null;
function reproduction(): Record<string, any> {
  return (reproductionDoc ??= JSON.parse(readFileSync(REPRODUCTION, 'utf8')) as Record<string, any>);
}
const SHA256_RE = /^[0-9a-f]{64}$/;
function assertSha256(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new Error(`no MEASURED sha256 for ${what} (got ${JSON.stringify(value)}) — run fetch-and-verify.mjs --all first`);
  return value;
}
/** Corpus B's measured WAV hashes are keyed by file basename (the manifest names turns, the fetcher hashes files). */
function measuredCorpusBHash(wavRelPath: string): string {
  const map = reproduction().corpusB?.wavSha256 ?? {};
  return assertSha256(map[path.basename(wavRelPath)], `${wavRelPath} (${rel(REPRODUCTION)}.corpusB.wavSha256)`);
}

/**
 * Corpus A — the 16 English LibriSpeech clips, rebuilt with `corpus.mts`'s exact rule so the span set
 * is the one P0.13 scored: every END candidate gets the 1500 ms digital closing tail and walks
 * `max(0, clipMs - onsetMs) + 1500`; every within-turn pause walks its real `pauseMs` and gets no tail.
 * `clipMs` is read from the DECODED PCM length, not from the manifest's `durationSeconds`, because that
 * is what `corpus.mts` does (`pcm.length / sampleRate * 1000`) and the two must agree to the sample.
 */
function buildCorpusA(): Span[] {
  const doc = JSON.parse(readFileSync(CORPUS_A_SAMPLES, 'utf8')) as {
    samples: Array<{
      id: string;
      rowIndex: number;
      speakerId: number;
      corpusId: string;
      reference: string;
      sha256: string;
      refetchedSha256: string;
      candidatePoints: Array<{ onsetMs: number; pauseMs: number | null; truth: string; kind: string; scenario: string; note: string }>;
    }>;
  };
  const out: Span[] = [];
  for (const s of doc.samples) {
    const wavAbs = path.join(CORPUS_A_DIR, `${s.id}.wav`);
    const { sampleRate, samples: pcm } = decodeWav(wavAbs);
    if (sampleRate !== MODEL_SR) throw new Error(`corpus A ${s.id} is ${sampleRate} Hz, expected ${MODEL_SR}`);
    const clipMs = (pcm.length / sampleRate) * 1000;
    for (let spanIndex = 0; spanIndex < s.candidatePoints.length; spanIndex++) {
      const c = s.candidatePoints[spanIndex];
      if (c.truth !== 'END' && c.truth !== 'CONTINUE') continue; // CORRECTION scores as neither
      const isEnd = c.truth === 'END';
      const appendTailMs = isEnd ? 1500 : 0;
      const audio = new Float32Array(pcm.length + Math.round((appendTailMs / 1000) * sampleRate));
      audio.set(pcm, 0);
      const silenceMs = isEnd ? Math.max(0, clipMs - c.onsetMs) + appendTailMs : Math.max(0, c.pauseMs ?? 0);
      out.push({
        key: `librispeech-en-real|${s.id}#${spanIndex}`,
        spanKey: `${s.id}#${spanIndex}`,
        corpus: 'librispeech-en-real',
        group: `speaker:${s.speakerId}`,
        speaker: String(s.speakerId),
        id: s.id,
        spanIndex,
        label: isEnd ? 'eot' : 'hold',
        onsetMs: c.onsetMs,
        silenceMs,
        sampleRate,
        appendTailMs,
        clipMs,
        wav: rel(wavAbs),
        audio,
        sha256: assertSha256(s.refetchedSha256, `${s.id} (${rel(CORPUS_A_SAMPLES)}.samples[].refetchedSha256)`),
        reproduction: {
          fetchCommand: 'node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-a',
          dataset: 'openslr/librispeech_asr',
          config: 'clean',
          split: 'test',
          rowIndex: s.rowIndex,
          corpusId: s.corpusId,
          candidatePointIndex: spanIndex,
          gtRule: 'LibriSpeech has no word timings for this fetch path: the candidate points are the P0.6 annotation (the committed manifest), whose truth/kind/onsetMs/pauseMs this run re-reads; no transcript is invented and no audio is re-transcribed',
          reference: s.reference,
          pinnedBy: 'sha256 equal to the committed P0.6 manifest value (librispeech-en-real/' + s.id + ')',
        },
      });
    }
  }
  return out;
}

/** Corpus B — the fetched eot-bench English validation manifest. The span's GT is the corpus's own
 *  `silence_spans` labelling (`last span = eot`, the rest `hold`), read from the manifest; the silence
 *  the grid walks is the span's own `silenceMs` with no appended tail (nothing is invented). */
function buildCorpusB(): Span[] {
  const doc = JSON.parse(readFileSync(EOT_MANIFEST, 'utf8')) as {
    provenance: { revision: string; dataset: string; splitFile: string; parquetSha256: string };
    spans: Array<{ id: string; spanIndex: number; group: string; label: 'eot' | 'hold'; startMs: number; endMs: number; silenceMs: number; wav: string; sampleRate: number; clipMs: number; turnId?: string }>;
  };
  const audioCache = new Map<string, { sampleRate: number; samples: Float32Array }>();
  const out: Span[] = [];
  for (const s of doc.spans) {
    const wavAbs = path.join(DATA, s.wav.replace(/^data\//, ''));
    let decoded = audioCache.get(wavAbs);
    if (!decoded) {
      decoded = decodeWav(wavAbs);
      audioCache.set(wavAbs, decoded);
    }
    if (decoded.sampleRate !== MODEL_SR) throw new Error(`corpus B ${s.id} is ${decoded.sampleRate} Hz, expected ${MODEL_SR}`);
    const turnId = s.turnId ?? s.id;
    out.push({
      key: `eot-bench-en|${s.id}#${s.spanIndex}`,
      spanKey: `${s.id}#${s.spanIndex}`,
      corpus: 'eot-bench-en',
      group: s.group,
      speaker: turnId.split('__')[1] ?? s.group,
      id: s.id,
      spanIndex: s.spanIndex,
      label: s.label,
      onsetMs: s.startMs,
      silenceMs: s.silenceMs,
      sampleRate: decoded.sampleRate,
      appendTailMs: 0,
      clipMs: s.clipMs,
      wav: rel(wavAbs),
      audio: decoded.samples,
      sha256: measuredCorpusBHash(rel(wavAbs)),
      reproduction: {
        fetchCommand: 'node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-b',
        dataset: doc.provenance.dataset,
        revision: doc.provenance.revision,
        splitFile: doc.provenance.splitFile,
        parquetSha256: doc.provenance.parquetSha256,
        turnId,
        spanIndex: s.spanIndex,
        gtRule: 'eot-bench `silence_spans`: the last span of a turn is `eot`, every earlier span `hold`; GT taken verbatim from the corpus, never from a new transcript',
      },
    });
  }
  return out;
}

// ── cell geometry & the deterministic grid (identical to P0.13's replay) ──────────────────────────
const prefixSamples = (timestampMs: number, sampleRate: number): number => Math.floor((timestampMs * sampleRate) / 1000);
const t1mFrameIndex = (E: number): number => Math.floor(E / 320) - 1;

function spanGrid(span: Span): GridPoint[] {
  return causalGrid(
    { sampleId: span.id, spanIndex: span.spanIndex, onsetMs: span.onsetMs, silenceMs: span.silenceMs, truth: span.label === 'eot' ? 'END' : 'CONTINUE', label: span.label, scenario: '' },
    { inferenceIntervalSeconds: INTERVAL, maxSilenceSeconds: Number.POSITIVE_INFINITY },
  );
}

// ── courtesy check (AC6 / Plan 2) ────────────────────────────────────────────────────────────────
type CourtesyRecord = {
  policy: string;
  startedAt: string;
  finishedAt: string;
  patterns: string[];
  scope: string;
  polls: Array<{ at: string; hits: string[] }>;
  hits: string[];
  totalWaitSeconds: number;
  maxWaitSeconds: number;
  decision: string;
  proceedReason: string;
};

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function competingProcesses(): string[] {
  let psOut = '';
  try {
    psOut = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const heavy = /(run-benchmark\.mts|run-turn1mini\.py|full-suite-runner\.js)/;
  const selfPid = String(process.pid);
  return psOut
    .split('\n')
    .filter((line) => {
      const [pid] = line.trim().split(/\s+/, 1);
      if (pid === selfPid) return false;
      if (!heavy.test(line)) return false;
      // The competing consumer is the SIBLING task, identified by its own worktree path in argv.
      return line.includes(P14_WORKTREE);
    })
    .map((line) => line.trim());
}

async function courtesyCheck(): Promise<CourtesyRecord> {
  const record: CourtesyRecord = {
    policy: 'poll `ps -eo pid,args` for run-benchmark.mts|run-turn1mini.py|full-suite-runner.js whose argv names the P0.14 worktree; if hit, wait and re-poll (≤600 s per wait, ≤1800 s total) before proceeding',
    startedAt: nowIso(),
    finishedAt: '',
    patterns: ['run-benchmark.mts', 'run-turn1mini.py', 'full-suite-runner.js'],
    scope: P14_WORKTREE,
    polls: [],
    hits: [],
    totalWaitSeconds: 0,
    maxWaitSeconds: 1800,
    decision: 'proceed',
    proceedReason: '',
  };
  if (NO_COURTESY) {
    record.finishedAt = nowIso();
    record.decision = 'skipped';
    record.proceedReason = '--no-courtesy was passed: the concurrency poll was NOT executed (recorded as skipped rather than reported as a pass)';
    return record;
  }
  const t0 = Date.now();
  for (;;) {
    const hits = competingProcesses();
    record.polls.push({ at: nowIso(), hits });
    if (hits.length === 0) {
      record.finishedAt = nowIso();
      record.totalWaitSeconds = round((Date.now() - t0) / 1000, 3);
      record.proceedReason = 'no competing heavy-inference process naming the P0.14 worktree was visible at any poll';
      return record;
    }
    record.hits.push(...hits);
    if ((Date.now() - t0) / 1000 >= record.maxWaitSeconds) {
      record.finishedAt = nowIso();
      record.totalWaitSeconds = round((Date.now() - t0) / 1000, 3);
      record.decision = 'proceed-despite-hit';
      record.proceedReason = `still detected a competing process after the ${record.maxWaitSeconds}s cap — proceeding and recording it, per Plan 2 ("仍检测到但继续执行"及理由): the contender is a single-task agent process and this host reports 128 cores / 246 GiB, so the check's purpose (do not silently race a second full inference) is satisfied by the record itself`;
      return record;
    }
    await sleepMs(600_000);
  }
}

// ── Smart Turn scoring: shardable, cache-backed, with a self-audit ───────────────────────────────
type CellTable = { grid: GridPoint[]; scores: number[] };
type ScoreTables = Map<string, CellTable>;
type CompiledAddon = NonNullable<ReturnType<typeof loadCompiledFeatures>['addon']>;

const cacheFile = (tag: string): string => path.join(CACHE_DIR, `scores-${tag}.json`);

/** One cell: exactly `predictEndpoint`'s window rule — keep the last 8 s, front-pad with zeros. */
async function scoreCell(session: SmartTurnSession, addon: CompiledAddon, prefix: Float32Array): Promise<number> {
  const windowed = truncateToLastSeconds(prefix, 8, MODEL_SR);
  const feats = compiledWhisperLogMel(addon, windowed);
  const out = await session.run({ input_features: new ort.Tensor('float32', feats, [1, 80, 800]) });
  return (Object.values(out)[0] as { data: Float32Array }).data[0];
}

/** Worker mode: score the spans whose index ≡ `shard` (mod `shards`) and write one partial table. The
 *  split is by SPAN, not by cell: slicing by span is what lets a shard write whole per-span score
 *  arrays that the parent unions without reassembly, and a span is exactly the unit whose array length
 *  must equal its grid length. */
async function runShardWorker(spans: Span[], shard: number, of: number): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const { addon, buildNote, error } = loadCompiledFeatures();
  if (!addon) throw new Error(`compiled mel front-end unavailable: ${buildNote} ${error ?? ''}`);
  const session = await createSmartTurnSession(SMART_TURN_MODEL, 1);
  const scores: Record<string, number[]> = {};
  let firstCell: Float32Array | null = null;
  for (let k = 0; k < spans.length; k++) {
    if (k % of !== shard) continue;
    const s = spans[k];
    const grid = spanGrid(s);
    const acc: number[] = [];
    for (const cell of grid) {
      const prefix = s.audio.subarray(0, prefixSamples(cell.timestampMs, s.sampleRate));
      if (!firstCell) {
        firstCell = prefix;
        await scoreCell(session, addon, prefix); // warm the ORT kernels off the first real cell
      }
      acc.push(await scoreCell(session, addon, prefix));
    }
    scores[s.key] = acc;
  }
  mkdirSync(SHARD_DIR, { recursive: true });
  writeFileSync(cacheFile(`smart-turn-${INTERVAL}-shard${shard}of${of}`), JSON.stringify({ cells: spans.reduce((a, s) => a + spanGrid(s).length, 0), shard, of, scores }));
  writeFileSync(path.join(SHARD_DIR, `${shard}-of-${of}.json`), JSON.stringify({ shard, of, done: Object.keys(scores).length, at: nowIso() }));
}

/** Parent: fork the shard workers, union their tables, and assert every span came back whole. */
async function scoreSmartTurnSharded(spans: Span[], grids: Map<string, GridPoint[]>): Promise<{ tables: ScoreTables; cells: number; shards: number; shardMs: number; fromCache: boolean }> {
  const file = cacheFile(`smart-turn-${INTERVAL}-full`);
  const cells = spans.reduce((a, s) => a + (grids.get(s.key)?.length ?? 0), 0);
  if (!NO_CACHE && existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cells: number; scores: Record<string, number[]> };
    if (raw.cells === cells && spans.every((s) => (raw.scores[s.key] ?? []).length === (grids.get(s.key)?.length ?? 0))) {
      const tables: ScoreTables = new Map();
      for (const s of spans) tables.set(s.key, { grid: grids.get(s.key) ?? [], scores: raw.scores[s.key] });
      return { tables, cells, shards: 0, shardMs: 0, fromCache: true };
    }
  }
  const t0 = Date.now();
  if (SHARD_COUNT === 1) {
    await runShardWorker(spans, 0, 1);
  } else {
    const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const children = Array.from({ length: SHARD_COUNT }, (_, i) =>
      spawn(tsx, ['--tsconfig', path.join(REPO_ROOT, 'server', 'tsconfig.json'), SELF, '--shard', String(i), '--shards', String(SHARD_COUNT)], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
      }),
    );
    const codes = await Promise.all(children.map((c) => new Promise<number>((resolve) => c.on('exit', (code) => resolve(code ?? 1)))));
    const failed = codes.map((c, i) => ({ i, c })).filter((x) => x.c !== 0);
    if (failed.length) throw new Error(`Smart Turn shard workers failed: ${JSON.stringify(failed)}`);
  }
  const union: Record<string, number[]> = {};
  for (let i = 0; i < SHARD_COUNT; i++) {
    const part = cacheFile(`smart-turn-${INTERVAL}-shard${i}of${SHARD_COUNT}`);
    if (!existsSync(part)) throw new Error(`shard ${i}/${SHARD_COUNT} wrote no table — refusing to score on a partial union`);
    const raw = JSON.parse(readFileSync(part, 'utf8')) as { scores: Record<string, number[]> };
    for (const [k, v] of Object.entries(raw.scores)) {
      if (union[k]) throw new Error(`span ${k} present in two shards — the shard split is not disjoint`);
      union[k] = v;
    }
  }
  const tables: ScoreTables = new Map();
  const problems: string[] = [];
  for (const s of spans) {
    const grid = grids.get(s.key) ?? [];
    const scores = union[s.key];
    if (!scores) problems.push(`${s.key}: absent from every shard`);
    else if (scores.length !== grid.length) problems.push(`${s.key}: ${scores.length} scores for ${grid.length} cells`);
    else tables.set(s.key, { grid, scores });
  }
  if (problems.length) throw new Error(`merged Smart Turn table is incomplete: ${problems.slice(0, 5).join('; ')} (${problems.length} spans)`);
  // Self-audit: re-run N cached cells with a fresh ONNX call and report the deviation. This is what
  // separates "the cache holds model output" from "the cache holds something".
  const audit = AUDIT_CELLS > 0 ? await auditCachedCells(tables, spans) : null;
  writeFileSync(file, JSON.stringify({ cells, scores: union }));
  return { tables, cells, shards: SHARD_COUNT, shardMs: Date.now() - t0, fromCache: false, ...(audit ? { audit } : {}) } as never;
}

async function auditCachedCells(tables: ScoreTables, spans: Span[]): Promise<Record<string, unknown>> {
  const { addon, buildNote, error } = loadCompiledFeatures();
  if (!addon) throw new Error(`compiled mel front-end unavailable: ${buildNote} ${error ?? ''}`);
  const session = await createSmartTurnSession(SMART_TURN_MODEL, 1);
  const byKey = new Map(spans.map((s) => [s.key, s]));
  const keys = spans.map((s) => s.key).filter((k) => (tables.get(k)?.grid.length ?? 0) > 0);
  const step = Math.max(1, Math.floor(keys.length / AUDIT_CELLS));
  let checked = 0;
  let maxAbsDiff = 0;
  for (let i = 0; i < keys.length && checked < AUDIT_CELLS; i += step) {
    const key = keys[i];
    const span = byKey.get(key)!;
    const table = tables.get(key)!;
    const cellIndex = Math.min(table.grid.length - 1, Math.floor(table.grid.length / 2));
    const cell = table.grid[cellIndex];
    const prefix = span.audio.subarray(0, prefixSamples(cell.timestampMs, span.sampleRate));
    const fresh = await scoreCell(session, addon, prefix);
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(fresh - table.scores[cellIndex]));
    checked += 1;
  }
  return { cellsReRun: checked, maxAbsDiff, note: 'cached cells re-scored with a fresh ONNX call after the shard union; a nonzero maxAbsDiff would mean the cache is not the model output' };
}

// ── turn-1-mini: the official ONNX streaming pass, one clip at a time ────────────────────────────
function writeSpansJson(spans: Span[]): void {
  writeFileSync(
    SPANS_PATH,
    JSON.stringify({
      corpora: [
        { id: 'librispeech-en-real', label: 'LibriSpeech (English, real)', groupKey: 'speakerId', licence: 'CC-BY-4.0' },
        { id: 'eot-bench-en', label: 'eot-bench English validation', groupKey: 'speaker_session', licence: 'CC-BY-4.0' },
      ],
      rule: 'cell prefix ends at sample E=floor(tsMs*sr/1000); turn-1-mini frame index j=floor(E/320)-1',
      spans: spans.map((s) => ({
        key: s.key,
        corpus: s.corpus,
        group: s.group,
        id: s.id,
        spanIndex: s.spanIndex,
        label: s.label,
        onsetMs: s.onsetMs,
        silenceMs: s.silenceMs,
        // `run-turn1mini.py` joins this path onto its OWN directory (`here`), so the spans file this
        // task hands it must carry script-dir-relative paths — the same convention P0.13's writer used.
        wav: path.relative(DIR, path.join(REPO_ROOT, s.wav)),
        sampleRate: s.sampleRate,
        appendTailMs: s.appendTailMs,
        clipMs: s.clipMs,
      })),
    }),
  );
}

function runTurn1Mini(spans: Span[]): { frames: Map<string, number[]>; report: Record<string, unknown> } {
  if (!existsSync(VENV_PYTHON)) throw new Error(`venv python missing at ${VENV_PYTHON}`);
  if (NO_PYTHON) {
    if (!existsSync(T1M_SCORES)) throw new Error(`--no-python was passed but ${T1M_SCORES} does not exist`);
  } else {
    writeSpansJson(spans);
    const selfcheck = path.join(REPO_ROOT, spans[0].wav);
    // stdout is dropped on purpose: run-turn1mini.py reports its self-check inside the score file it
    // writes (`selfCheck`), which is read back and embedded in RESULT.json.turn1MiniRun.
    execFileSync(VENV_PYTHON, ['-I', path.join(DIR, 'run-turn1mini.py'), '--spans', SPANS_PATH, '--out', T1M_SCORES, '--selfcheck-wav', selfcheck], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HF_HOME: path.join(DATA, 'hf') },
    });
    if (!existsSync(T1M_SCORES)) throw new Error(`run-turn1mini.py exited without writing ${T1M_SCORES}`);
  }
  const report = JSON.parse(readFileSync(T1M_SCORES, 'utf8')) as { spans: Array<{ key: string; frameProbs: number[] }> };
  const got = new Set(report.spans.map((s) => s.key));
  const missing = spans.filter((s) => !got.has(s.key)).map((s) => s.key);
  if (missing.length) throw new Error(`turn-1-mini scores are stale: ${missing.length}/${spans.length} current span keys absent (first: ${missing[0]})`);
  // The raw per-span frame probabilities are SCRATCH (16 MB, gitignored, regenerated byte-identically by
  // the python step) and are deliberately NOT embedded in RESULT.json: that would make the committed
  // artifact ~30 MB, against ~0.4 MB for its P0.13 sibling, for data no reader needs — the worst-case
  // records carry the trajectory points, and `analysis` carries every error at every view. What IS kept
  // is the provenance and the python run's own self-check.
  const { spans: rawSpans, ...summary } = report as unknown as { spans: unknown[] } & Record<string, unknown>;
  return {
    frames: new Map(report.spans.map((s) => [s.key, s.frameProbs])),
    report: { ...summary, spanCount: rawSpans.length, rawSpansLocation: `${rel(T1M_SCORES)} (gitignored scratch — not embedded here)` },
  };
}

const sliceTurn1Mini = (span: Span, grid: GridPoint[], frameProbs: number[]): number[] =>
  grid.map((cell) => {
    const j = t1mFrameIndex(prefixSamples(cell.timestampMs, span.sampleRate));
    return j >= 0 && j < frameProbs.length ? frameProbs[j] : 0;
  });

// ── the fixed-point policy reading, per span ─────────────────────────────────────────────────────
type Point = { threshold: number; actionDelaySeconds: number; timeoutSeconds: number };

type SpanVerdict = {
  span: Span;
  fired: boolean;
  fireSeconds: number | null;
  /** The decision event the policy produces, in seconds after the silence onset. */
  decisionSeconds: number | null;
  decision: 'detect' | 'cutoff-model' | 'cutoff-timeout' | 'miss' | 'clean';
  /** False-cutoff (a hold that was cut) / missed end (an eot the model never crossed in time). */
  isCutoff: boolean;
  isMiss: boolean;
  /** Severity: seconds of pause the speaker still had left (cutoff), or seconds past `timeout` the
   *  model's fire sits (miss; Infinity when it never fired). */
  gapSeconds: number;
  /** Index of the cell the decision was taken at (first fire for a fire-driven reading). */
  triggerIndex: number;
};

/**
 * One span's verdict at `point`, written to mirror `protocol.mts`'s `_policy_sweep_rows` EXACTLY:
 *   hold:  modelCutoff = fired & silence > max(actionDelay, fire);  timeoutCutoff = silence > timeout
 *   eot:   modelDetect = fired & fire <= timeout
 * What this adds is the DECISION TIME and WHY — the protocol only accumulates booleans, and the report
 * needs to name the moment. When a hold trips both clauses the cut time is the earlier of the two
 * (the model's fire or the timer), which is the honest reading of an OR.
 */
function verdictAt(span: Span, grid: GridPoint[], scores: number[], point: Point): SpanVerdict {
  const { fireSeconds: fire } = spanFire(grid, scores, point.threshold);
  const fired = fire < Number.POSITIVE_INFINITY;
  const silence = span.silenceMs / 1000;
  let trigger = grid.findIndex((_, i) => scores[i] >= point.threshold);
  if (trigger < 0) {
    // Not fired: the "closest the model came" cell is the most informative trajectory anchor.
    let best = -1;
    for (let i = 0; i < scores.length; i++) if (best < 0 || scores[i] > scores[best]) best = i;
    trigger = best;
  }
  if (span.label === 'hold') {
    const modelFireTime = Math.max(point.actionDelaySeconds, fire);
    const modelCutoff = fired && silence > modelFireTime + EPS;
    const timeoutCutoff = silence > point.timeoutSeconds + EPS;
    const isCutoff = modelCutoff || timeoutCutoff;
    const candidates: Array<{ kind: 'cutoff-model' | 'cutoff-timeout'; at: number }> = [];
    if (modelCutoff) candidates.push({ kind: 'cutoff-model', at: modelFireTime });
    if (timeoutCutoff) candidates.push({ kind: 'cutoff-timeout', at: point.timeoutSeconds });
    const first = candidates.sort((a, b) => a.at - b.at)[0] ?? null;
    return {
      span,
      fired,
      fireSeconds: fired ? fire : null,
      decisionSeconds: first ? first.at : null,
      decision: first ? first.kind : 'clean',
      isCutoff,
      isMiss: false,
      gapSeconds: first ? silence - first.at : 0,
      triggerIndex: trigger,
    };
  }
  const modelDetect = fired && fire <= point.timeoutSeconds + EPS;
  return {
    span,
    fired,
    fireSeconds: fired ? fire : null,
    decisionSeconds: modelDetect ? fire : point.timeoutSeconds,
    decision: modelDetect ? 'detect' : 'miss',
    isCutoff: false,
    isMiss: !modelDetect,
    gapSeconds: modelDetect ? 0 : fired ? fire - point.timeoutSeconds : Number.POSITIVE_INFINITY,
    triggerIndex: trigger,
  };
}

/** The protocol's own sweep, called with a single-element threshold list (its correct usage), so the
 *  reported rates are produced by the SAME code path P0.13 used rather than by a parallel reading. */
function protocolRow(spans: Span[], tables: ScoreTables, point: Point): PolicyRow {
  const fires: SpanFire[] = spans.map((s) => {
    const t = tables.get(s.key);
    const { fireSeconds } = spanFire(t?.grid ?? [], t?.scores ?? [], point.threshold);
    return { key: s.key, label: s.label, silenceSeconds: s.silenceMs / 1000, fireSeconds };
  });
  return sweepPolicies(fires, { thresholds: [point.threshold], actionDelays: [point.actionDelaySeconds], timeouts: [point.timeoutSeconds] })[0];
}

// ── verdicts, ordering, and the worst-case records ───────────────────────────────────────────────
const ORDER_RULES = {
  falseCutoff:
    'by severity descending: gapSeconds = (true pause length) − (time the cut landed), i.e. how much of the pause the speaker still had left; ties broken by longer true pause, then earlier cut, then span key',
  missedEnd:
    'by severity descending: gapSeconds = (model fire time) − timeout, with "never crossed the threshold at all" = Infinity ranked first (the model gave no signal, so the endpoint came only from the timer); ties broken by span key',
  gapDefinition: {
    falseCutoff: 'gtEndMs − decisionEventMs, in seconds: how early the cut landed relative to when the speaker actually resumed',
    missedEnd: 'modelFireMs − timeoutDeadlineMs, in seconds (Infinity when the model never fired)',
  },
};

function worstCaseRecord(v: SpanVerdict, model: string, view: string, errorType: 'false-cutoff' | 'missed-end', rank: number, point: Point, table: CellTable): Record<string, unknown> {
  const s = v.span;
  const grid = table.grid;
  const lo = Math.max(0, v.triggerIndex - 3);
  const hi = Math.min(grid.length - 1, v.triggerIndex + 3);
  const window: Array<{ silenceSeconds: number; pEot: number }> = [];
  for (let i = lo; i <= hi && i >= 0; i++) window.push({ silenceSeconds: round(grid[i].silenceDurMs / 1000, 3), pEot: table.scores[i] });
  let maxP = 0;
  let maxAt = 0;
  for (let i = 0; i < table.scores.length; i++) {
    if (table.scores[i] > maxP) {
      maxP = table.scores[i];
      maxAt = grid[i].silenceDurMs / 1000;
    }
  }
  const gtTimeMs = s.label === 'eot' ? s.onsetMs : s.onsetMs + s.silenceMs;
  return {
    kind: 'worst-case',
    model,
    view,
    errorType,
    rank,
    sampleId: s.id,
    corpus: s.corpus,
    speaker: s.speaker,
    group: s.group,
    label: s.label,
    gtLabel: s.label === 'eot' ? 'END (the speaker really finished)' : 'CONTINUE (the speaker only paused)',
    wav: { path: s.wav, sha256: s.sha256 || null, bytes: existsSync(path.join(REPO_ROOT, s.wav)) ? statSync(path.join(REPO_ROOT, s.wav)).size : null, reproduction: s.reproduction, materialize: `node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-${s.corpus === 'eot-bench-en' ? 'b' : 'a'}` },
    audio: {
      onsetMs: s.onsetMs,
      silenceSeconds: round(s.silenceMs / 1000, 3),
      clipMs: round(s.clipMs, 3),
      appendedTailMs: s.appendTailMs,
      sampleRate: s.sampleRate,
      cellsWalked: grid.length,
    },
    operatingPoint: point,
    observed: {
      decision: v.decision,
      modelFireSeconds: v.fireSeconds,
      decisionEventMs: v.decisionSeconds === null ? null : s.onsetMs + Math.round(v.decisionSeconds * 1000),
      gtTimeMs,
      gapSeconds: v.gapSeconds === Number.POSITIVE_INFINITY ? 'Infinity' : round(v.gapSeconds, 6),
      gapMeaning: errorType === 'false-cutoff' ? ORDER_RULES.gapDefinition.falseCutoff : ORDER_RULES.gapDefinition.missedEnd,
    },
    probabilityTrajectory: {
      threshold: point.threshold,
      triggerCell: { index: v.triggerIndex, silenceSeconds: round((grid[v.triggerIndex]?.silenceDurMs ?? 0) / 1000, 3), pEot: table.scores[v.triggerIndex] ?? null },
      windowAroundTrigger: window,
      maxPEot: maxP,
      maxPEotAtSilenceSeconds: round(maxAt, 3),
      readAt: 'one fresh 8 s window per cell (Smart Turn) / the 20 ms frame covering the cell (turn-1-mini)',
    },
    gtSource: s.corpus === 'eot-bench-en' ? 'the corpus\'s own `silence_spans` labelling (eot = last span of the turn)' : 'the committed P0.6 annotation of this LibriSpeech clip (no new transcript)',
  };
}

// ── AC3: cross-model and baseline (never-look-at-the-score) comparison ────────────────────────────
function crossTable(perModel: Array<{ model: string; verdicts: Map<string, SpanVerdict> }>, baseline: Map<string, SpanVerdict>, spans: Span[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const errorType of ['cutoff', 'miss'] as const) {
    const flag = (v: SpanVerdict | undefined): boolean => (errorType === 'cutoff' ? !!v?.isCutoff : !!v?.isMiss);
    const [a, b] = perModel;
    const rows = { bothModels: [] as string[], smartTurnOnly: [] as string[], turn1MiniOnly: [] as string[], baselineOnly: [] as string[], baselineAlsoWithAModel: [] as string[], nobody: 0 };
    for (const s of spans) {
      const va = flag(a.verdicts.get(s.key));
      const vb = flag(b.verdicts.get(s.key));
      const vbase = flag(baseline.get(s.key));
      if (va && vb) rows.bothModels.push(s.key);
      else if (va) rows.smartTurnOnly.push(s.key);
      else if (vb) rows.turn1MiniOnly.push(s.key);
      if (vbase && (va || vb)) rows.baselineAlsoWithAModel.push(s.key);
      else if (vbase) rows.baselineOnly.push(s.key);
      if (!va && !vb && !vbase) rows.nobody += 1;
    }
    out[errorType] = {
      ...rows,
      counts: {
        bothModels: rows.bothModels.length,
        smartTurnOnly: rows.smartTurnOnly.length,
        turn1MiniOnly: rows.turn1MiniOnly.length,
        eitherModel: rows.bothModels.length + rows.smartTurnOnly.length + rows.turn1MiniOnly.length,
        baseline: rows.baselineAlsoWithAModel.length + rows.baselineOnly.length,
        baselineOnly: rows.baselineOnly.length,
        neitherModelNorBaseline: rows.nobody,
      },
      agreement: 'bothModels = the two models fail on the SAME span; the one-model columns are the errors a model owns alone; baselineAlsoWithAModel = the timer already failed there too, so it is not evidence about the model',
    };
  }
  return out;
}

// ── evidence (AC7) ───────────────────────────────────────────────────────────────────────────────
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (err) {
    return `__git-error__ ${String(err).slice(0, 200)}`;
  }
}

function evidence(extra: Record<string, unknown>): Record<string, unknown> {
  const mergeBase = git(['merge-base', 'HEAD', 'develop']);
  const productionPaths = ['server/modules/voice-realtime/', 'src/modules/chat/voice-realtime/'];
  const prodDiff = git(['diff', '--stat', mergeBase, '--', ...productionPaths]);
  const p14Path = 'experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/';
  const p13Path = 'experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/';
  const envReads = ['fetch-and-verify.mjs', 'extract-worst-cases.mts']
    .map((f) => ({ file: f, envReads: (readFileSync(path.join(DIR, f), 'utf8').match(/process\.env\.[A-Z_]+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i) }))
    .filter((x) => x.envReads.length > 0);
  return {
    independentWorktree: {
      toplevel: REPO_ROOT,
      isP13Worktree: REPO_ROOT.includes('p0-13'),
      isP14Worktree: REPO_ROOT.includes('p0-14'),
      thisTaskWorktree: REPO_ROOT.endsWith('gap-voice-turn-detection-p0-15-worst-cases-replay'),
      headAtStart: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    },
    productionDiff: {
      command: `git diff --stat ${mergeBase} -- ${productionPaths.join(' ')}`,
      mergeBase,
      whyMergeBase: 'the worktree branched from develop; diffing the moving develop ref would show develop\'s OWN advance as if it were this task\'s change, so the merge-base is the honest baseline',
      diff: prodDiff,
      empty: prodDiff === '',
    },
    untouchedPaths: {
      p14Worktree: P14_WORKTREE,
      p14WorktreeExists: existsSync(P14_WORKTREE),
      p14TouchesDiff: { command: `git diff --stat ${mergeBase} -- ${p14Path}`, diff: git(['diff', '--stat', mergeBase, '--', p14Path]), empty: git(['diff', '--stat', mergeBase, '--', p14Path]) === '' },
      p13LandedDiff: { command: `git diff --stat ${mergeBase} -- ${p13Path}`, diff: git(['diff', '--stat', mergeBase, '--', p13Path]), empty: git(['diff', '--stat', mergeBase, '--', p13Path]) === '' },
      note: 'the P0.13 python scripts were reused as BYTE-IDENTICAL COPIES in this directory (sha256-compared in reproduction.copiedP013Scripts) precisely so the P0.13 paths are never written to',
    },
    noTrainingWeights: {
      trainingFrameworksInstalled: (extra.pythonInstalled as string[] | undefined) ?? [],
      claim: 'no training/fine-tuning step exists in this task and no training-only weight was downloaded; the two ONNX files are inference graphs whose sha256 match the P0.13 pins, and the turn-1-mini repo\'s `.safetensors` (the torch/training-side artifact, pin recorded for reference) was deliberately NOT fetched — hf_hub_download was called for the ONNX file only',
      trainingOnlyArtifactsFetched: [],
      venvPackages: extra.venvPackages ?? null,
    },
    noPaidCalls: {
      httpHosts: ['huggingface.co', 'datasets-server.huggingface.co', 'creativecommons.org', 'openslr.org'],
      kind: 'public corpus/model/card fetches only; the two models run LOCALLY on CPU via onnxruntime',
      apiKeysReadByThisTasksCode: envReads,
      note: 'the only environment reads in this task\'s own scripts are SMART_TURN_MODEL (an optional local file path), HOME and HF_HOME (a cache dir) — no credential, token or API-key variable is read',
    },
  };
}

// ── markdown rendering for ERROR-REPORT.md ───────────────────────────────────────────────────────
function mdTable(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function renderErrorReport(doc: Record<string, any>): string {
  const op = OPERATING_POINT;
  const L: string[] = [];
  L.push('# P0.15 — worst-case replay: which real samples the two English turn detectors get wrong');
  L.push('');
  L.push(`Generated ${doc.generatedAt} by \`extract-worst-cases.mts\` from a real re-fetch and a real re-run of both models in an independent worktree.`);
  L.push('');
  L.push('## Why this report exists');
  L.push('');
  L.push('P0.13 published aggregate rates and a Pareto frontier, and deliberately wrote no per-sample row: its `RESULT.json` holds `denominator`/`gate`/`frontier`/`dense` only, and its audio, span manifest and score caches were gitignored scratch that fan-in reclaimed with the worktree. So the follow-up question — *which recording, and what did the model say right before it was wrong* — had no readable answer. This report is that answer, computed from audio this task re-fetched itself and from model output this task produced itself.');
  L.push('');
  L.push('## The fixed operating point (not re-selected)');
  L.push('');
  L.push(`\`threshold=${op.threshold}\`, \`actionDelaySeconds=${op.actionDelaySeconds}\`, \`timeoutSeconds=${op.timeoutSeconds}\` — the exact tuple P0.13's CONCLUSION §2b reports for BOTH models, so the two models' per-span verdicts are strictly comparable and the AC5 comparison is a real check rather than a restatement. The baseline row is the same actionDelay/timeout with \`threshold=0\` — the degenerate "never look at the score, just wait" policy (equivalent to a plain VAD/timer).`);
  L.push('');
  L.push('## Ranking rules (AC2 asks for an explainable severity order)');
  L.push('');
  L.push(`- **False cutoff** — ${ORDER_RULES.falseCutoff}`);
  L.push(`- **Missed end** — ${ORDER_RULES.missedEnd}`);
  L.push('');
  L.push('## Rates at the fixed point (this run, independently recomputed)');
  L.push('');
  const rateRows: string[][] = [];
  for (const view of ['eot-bench-en', 'librispeech-en-real', 'merged']) {
    for (const model of doc.models) {
      const m = doc.analysis[model].views[view];
      const b = doc.baseline[model]?.views?.[view] ?? null;
      rateRows.push([
        view,
        model,
        `${m.rates.falseCutoff.k}/${m.rates.falseCutoff.n} = ${(m.rates.falseCutoff.rate * 100).toFixed(2)}%`,
        `${m.rates.missedEnd.k}/${m.rates.missedEnd.n} = ${(m.rates.missedEnd.rate * 100).toFixed(2)}%`,
        m.rates.meanLatencySeconds === null ? '—' : m.rates.meanLatencySeconds.toFixed(4),
        b ? `${(b.rates.falseCutoff.rate * 100).toFixed(2)}% / ${(b.rates.missedEnd.rate * 100).toFixed(2)}%` : '—',
      ]);
    }
  }
  L.push(mdTable(['view', 'model', 'false cutoff (hold→cut)', 'missed end (eot→timeout)', 'mean EoT latency (s)', 'baseline cutoff/missed'], rateRows));
  L.push('');
  L.push('`mean EoT latency` is eot-bench\'s "conversational dead air, not compute": over EoT spans, the model\'s own fire time when it detected, else the full timeout.');
  L.push('');
  L.push('## AC5 — does this run reproduce P0.13\'s published k/n?');
  L.push('');
  L.push(mdTable(
    ['model', 'view', 'P0.13 cutoff', 'this run', 'P0.13 missed', 'this run', 'P0.13 mean lat', 'this run', 'verdict'],
    doc.consistency.items.map((i: any) => [
      i.model,
      i.view,
      i.expected ? `${i.expected.cutoffK}/${i.expected.cutoffN}` : '—',
      `${i.observed.cutoffK}/${i.observed.cutoffN}`,
      i.expected ? `${i.expected.missedK}/${i.expected.missedN}` : '—',
      `${i.observed.missedK}/${i.observed.missedN}`,
      i.expected && i.expected.meanLatencySeconds !== null ? String(i.expected.meanLatencySeconds) : '—',
      i.observed.meanLatencySeconds === null ? '—' : String(i.observed.meanLatencySeconds),
      i.status === 'not-published' ? 'not published by P0.13' : i.matches ? 'match' : 'DIVERGES',
    ]),
  ));
  L.push('');
  L.push(`**Verdict: ${doc.consistency.verdict}** — ${doc.consistency.note}`);
  L.push('');
  if (doc.consistency.grouping) {
    const g = doc.consistency.grouping;
    L.push(
      `**Grouping (AC1):** this run re-derived **${g.observedGroups}** speaker/session groups from its own fetch of the pinned parquet; P0.13 published **${g.publishedGroups ?? '—'}** (\`groupDistribution.groups\`). ${
        g.matches === true ? 'Equal — the same turns fold into the same groups.' : g.matches === false ? '**DIVERGES** — the corpora are not grouped alike; the k/n match above would then be a coincidence.' : 'No published value to compare, so no match is claimed.'
      }`
    );
    L.push('');
  }
  L.push('AC5 asks for the **eot-bench-en** and **merged** views specifically, and those four model/view pairs are the compared rows above. The `librispeech-en-real` row is included for completeness but is NOT a comparison: P0.13 published only each view\'s Pareto frontier, and on that degenerate 5-hold/16-EoT view the operating point is dominated, so no target exists to compare against. Recording it as "not published" is deliberate — treating an unavailable target as a match would be the failure mode this check exists to prevent.');
  L.push('');
  if (doc.determinism) {
    L.push('## Determinism — a second, independent process derived the same document (AC4)');
    L.push('');
    L.push(`Verdict: **${doc.determinism.identical ? 'byte-identical' : 'DIVERGES'}** (second-run exit code ${doc.determinism.secondRunExitCode}). Fields allowed to differ: \`${doc.determinism.ignoredFields.join('`, `')}\`.`);
    L.push('');
    L.push(doc.determinism.identical ? doc.determinism.note : `Differing paths: ${JSON.stringify(doc.determinism.differingPaths)}`);
    L.push('');
    if (doc.determinism.scope) {
      L.push(`**Scope of that claim:** ${doc.determinism.scope}.`);
      L.push('');
    }
    const audit = doc.smartTurnRun?.audit;
    L.push(`Two things are being established separately and each matters: this check re-runs the whole pipeline in a fresh process on the same inputs and compares the two documents; the audit recorded in \`smartTurnRun.audit\` independently shows that the Smart Turn table holds fresh model output rather than a stale file${audit ? ` (${audit.cellsReRun} cells re-scored with a fresh ONNX call, max absolute deviation ${audit.maxAbsDiff})` : ''}. turn-1-mini's model output has its own check, \`turn1MiniRun.selfCheck\`, which re-runs prefixes through a fresh python session. No one of them implies another.`);
    L.push('');
  }
  L.push('## AC3 — are the models actually better than not looking at the score?');
  L.push('');
  L.push(`\`${doc.crossComparison.conclusion}\``);
  L.push('');
  L.push(mdTable(
    ['error type', 'both models', 'Smart Turn only', 'turn-1-mini only', 'either model', 'baseline', 'baseline only', 'neither'],
    (['cutoff', 'miss'] as const).map((k) => {
      const c = doc.crossComparison.table[k].counts;
      return [k === 'cutoff' ? 'false cutoff' : 'missed end', String(c.bothModels), String(c.smartTurnOnly), String(c.turn1MiniOnly), String(c.eitherModel), String(c.baseline), String(c.baselineOnly), String(c.neitherModelNorBaseline)];
    }),
  ));
  L.push('');
  for (const model of doc.models) {
    for (const errorType of ['false-cutoff', 'missed-end'] as const) {
      const rows: Array<Record<string, any>> = doc.top10[model][errorType];
      L.push(`## Top ${rows.length} ${errorType === 'false-cutoff' ? 'false cutoffs' : 'missed endpoints'} — ${model} (merged view)`);
      L.push('');
      if (rows.length === 0) {
        L.push('_None at this operating point._');
        L.push('');
        continue;
      }
      L.push(
        mdTable(
          ['#', 'sampleId', 'speaker', 'GT', 'model said', 'p_eot at trigger', 'max p_eot', 'decision at', 'GT at', 'gap (s)', 'wav sha256 (first 12)'],
          rows.map((r) => [
            String(r.rank),
            `\`${r.sampleId}\``,
            r.speaker,
            r.label,
            r.observed.decision,
            r.probabilityTrajectory.triggerCell.pEot === null ? '—' : Number(r.probabilityTrajectory.triggerCell.pEot).toFixed(4),
            Number(r.probabilityTrajectory.maxPEot).toFixed(4),
            r.observed.decisionEventMs === null ? '—' : `${r.observed.decisionEventMs} ms`,
            `${r.observed.gtTimeMs} ms`,
            String(r.observed.gapSeconds),
            String(r.wav.sha256 ?? '—').slice(0, 12),
          ]),
        ),
      );
      L.push('');
      const first = rows[0];
      L.push(`Most severe: \`${first.sampleId}\` (${first.corpus}, ${first.wav.path}). ${first.gtLabel}; the model's reading was \`${first.observed.decision}\` at ${first.observed.decisionEventMs} ms against a GT time of ${first.observed.gtTimeMs} ms (gap ${first.observed.gapSeconds} s). Its probability trajectory around the decision cell: ${first.probabilityTrajectory.windowAroundTrigger.map((w: any) => `${w.silenceSeconds}s→${Number(w.pEot).toFixed(3)}`).join(', ')}.`);
      L.push('');
      L.push(`To materialize the bytes of any row above in one command: \`${first.wav.materialize}\` (writes the pinned audio into \`data/\` and re-verifies every sha256 against the pins recorded in \`RESULT.json\`).`);
      L.push('');
    }
  }
  L.push('## The baseline (threshold=0) is not a strawman');
  L.push('');
  L.push('The degenerate policy fires on the first cell of every span — it never consults the model, so it detects every EoT instantly (latency 0, missed 0) and cuts every hold whose pause outlasts `actionDelay`. That is exactly the trade a real VAD/timer makes, and it is the row the models must beat to be worth their cost. The numbers above are the comparison.');
  L.push('');
  L.push('## Reproduction');
  L.push('');
  L.push('See `README.md`. Short version: `node fetch-and-verify.mjs --all` re-fetches and re-verifies every byte, then `node_modules/.bin/tsx --tsconfig server/tsconfig.json extract-worst-cases.mts --shards 8` re-scores both models and rewrites every file in this directory.');
  L.push('');
  L.push('## Reproduction evidence — MEASURED hashes, not assumed agreement (AC1/AC4)');
  L.push('');
  L.push('Every row below is a hash this task computed from bytes it fetched, compared against the pin P0.13 locked. `RESULT.json.reproduction` carries the complete machine-readable record (including all 400 corpus-B WAV hashes) — this is the readable digest.');
  L.push('');
  const rep = doc.reproduction;
  L.push('### LibriSpeech corpus A — 16/16 clips, refetched sha256 vs the committed P0.6 manifest value');
  L.push('');
  L.push(
    mdTable(
      ['sampleId', 'LibriSpeech row', 'refetched sha256', 'manifest sha256', 'bytes', 'match'],
      rep.corpusA.perClip.map((c: any) => [
        `\`${c.id}\``,
        `${c.rowIndex} (${c.durationSeconds}s)`,
        `\`${c.refetchedSha256.slice(0, 16)}…\``,
        `\`${c.committedSha256.slice(0, 16)}…\``,
        String(c.bytes),
        c.matches ? 'yes' : 'NO',
      ]),
    ),
  );
  L.push('');
  L.push(`All 16 match: **${rep.corpusA.allSha256Match}**. ${rep.corpusA.candidatePoints} candidate points came back with them (${rep.corpusA.eotPoints} END + ${rep.corpusA.holdPoints} CONTINUE), which is the span set P0.13 scored.`);
  L.push('');
  L.push('### eot-bench corpus B — the pinned parquet and its 400 extracted turns');
  L.push('');
  L.push(
    mdTable(
      ['artifact', 'pin', 'measured', 'match'],
      [
        ['parquet sha256', `\`${String(rep.pins.eotBench.parquetSha256).slice(0, 16)}…\``, `\`${rep.corpusB.parquet.sha256.slice(0, 16)}…\``, rep.corpusB.parquet.matchesPin ? 'yes' : 'NO'],
        ['parquet bytes', String(rep.pins.eotBench.parquetBytes), String(rep.corpusB.parquet.bytes), rep.corpusB.parquet.bytes === rep.pins.eotBench.parquetBytes ? 'yes' : 'NO'],
        ['WAV files extracted', '—', `${rep.corpusB.wavFiles} (${rep.corpusB.wavTotalBytes} bytes, all hashed)`, '—'],
      ],
    ),
  );
  L.push('');
  L.push(`Group/session counts from the fetched manifest, all re-checked in this run: \`${JSON.stringify(rep.corpusB.counts)}\` — the \`groups\` count is AC1's speaker/session grouping and is compared against P0.13's published value in the AC5 section above (not merely asserted here), and the denominator split (705 holds in, 145 dropped by duration, 400 EoT) is the one P0.13 published.`);
  L.push('');
  L.push('### Models — local CPU ONNX, hashes re-verified at run time');
  L.push('');
  L.push(
    mdTable(
      ['model', 'repo @ revision', 'file', 'pin sha256', 'measured sha256', 'bytes', 'match'],
      [
        ['Smart Turn v3.2', `\`${rep.models.smartTurn.repo}\`@\`${rep.models.smartTurn.revision.slice(0, 8)}\``, rep.models.smartTurn.file, `\`${rep.models.smartTurn.sha256.slice(0, 16)}…\``, `\`${rep.models.smartTurn.observedSha256.slice(0, 16)}…\``, String(rep.models.smartTurn.observedBytes), rep.models.smartTurn.matchesPin ? 'yes' : 'NO'],
        ['turn-1-mini', `\`${rep.models.turn1Mini.repo}\`@\`${rep.models.turn1Mini.revision.slice(0, 8)}\``, rep.models.turn1Mini.onnxFile, `\`${rep.models.turn1Mini.onnxSha256.slice(0, 16)}…\``, `\`${rep.models.turn1Mini.observedSha256.slice(0, 16)}…\``, String(rep.models.turn1Mini.observedBytes), rep.models.turn1Mini.matchesPin ? 'yes' : 'NO'],
      ],
    ),
  );
  L.push('');
  L.push(`Python env pinned and checked: \`${JSON.stringify(rep.models.pythonEnv.installed)}\` on ${rep.models.pythonEnv.python} — all version checks true.`);
  L.push('');
  L.push(`**Training weights: none fetched.** The turn-1-mini repo also holds a \`.safetensors\` (the torch/training-side artifact, sha256 \`${rep.models.turn1Mini.safetensorsSha256.slice(0, 16)}…\`) — it is recorded here for reference and was deliberately NOT downloaded: \`hf_hub_download\` was called for \`${rep.models.turn1Mini.onnxFile}\` only. Both files actually fetched are inference graphs loaded by onnxruntime on CPU.`);
  L.push('');
  L.push('### Licences — fetched first-hand, quoted from the source, not paraphrased');
  L.push('');
  L.push(
    mdTable(
      ['what', 'status', 'bytes', 'sha256'],
      rep.licences.grabs.map((g: any) => [g.what, String(g.status), String(g.bytes), `\`${g.sha256.slice(0, 16)}…\``]),
    ),
  );
  L.push('');
  L.push(`Attribution as recorded in the deliverable: **${rep.licences.corpusAttribution.eotBench}** · **${rep.licences.corpusAttribution.librispeech}**.`);
  L.push('');
  L.push('### Reused P0.13 scripts — byte-identical copies, so the landed P0.13 paths are never written to');
  L.push('');
  L.push(
    mdTable(
      ['file', 'this task (copy)', 'P0.13 original', 'byte-identical'],
      rep.copiedP013Scripts.map((c: any) => [c.file, `\`${c.copySha256.slice(0, 16)}…\``, `\`${c.originalSha256.slice(0, 16)}…\``, c.byteIdentical ? 'yes' : 'NO']),
    ),
  );
  L.push('');
  L.push(`Egress for the whole task: **${rep.egress.hosts.join('`, `')}** — ${rep.egress.kind}.`);
  L.push('');
  return `${L.join('\n')}\n`;
}

// ── determinism: a second, independent process deriving the same document ─────────────────────────
const VOLATILE_FIELDS = ['generatedAt', 'runtimeSeconds', 'courtesyCheck', 'determinism', 'smartTurnRun.shardMs'];

/** Everything a rerun is allowed to change: wall-clock stamps and the shard wall time. If two runs
 *  differ anywhere ELSE, the pipeline is not reproducible and that must be visible. */
function stripVolatile(doc: Record<string, any>): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(doc));
  delete clone.generatedAt;
  delete clone.runtimeSeconds;
  delete clone.courtesyCheck;
  delete clone.determinism;
  if (clone.smartTurnRun) delete clone.smartTurnRun.shardMs;
  return clone;
}

function diffPaths(a: unknown, b: unknown, at = '', out: string[] = []): string[] {
  if (out.length >= 25) return out;
  const both = (x: unknown): boolean => x !== null && typeof x === 'object';
  if (both(a) && both(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diffPaths((a as any)[k], (b as any)[k], at ? `${at}.${k}` : k, out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${at}: ${JSON.stringify(a)?.slice(0, 60)} ≠ ${JSON.stringify(b)?.slice(0, 60)}`);
  return out;
}

function determinismCheck(doc: Record<string, any>): Record<string, unknown> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const second = path.join(CACHE_DIR, 'RESULT.second.json');
  const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  // The child must take the SAME Smart Turn scoring path the parent took, whichever that was. The three
  // fields that record the path (`smartTurnRun.fromCache`, `.shards`, `.audit`) are not results, but they
  // are part of the compared document, so a parent/child path mismatch would report DIVERGES on every tree
  // for a reason that has nothing to do with reproducibility: a cold cache makes the FIRST process score
  // and the SECOND read the table it just wrote, and a warm cache makes the first process read and the
  // second re-score. Mirroring the parent's `fromCache` removes the asymmetry instead of trading it for
  // its mirror image. Re-scoring is safe to demand when the parent scored, because the session is
  // `executionMode: 'sequential'` with one intra-op and one inter-op thread (see `createSmartTurnSession`)
  // — deterministic by construction — and `smartTurnRun.audit` measures exactly that agreement between a
  // fresh ONNX call and the table on every scoring run.
  // `--no-python`: the child reuses the SAME turn-1-mini score file rather than re-inferring it. The score
  // file carries the python run's wall-clock timing and its own `generatedAt`, so a re-inference here
  // would make the child differ on fields that say nothing about reproducibility. turn-1-mini's model
  // output is covered instead by `turn1MiniRun.selfCheck`, which re-runs prefixes through a fresh python
  // session inside the parent's pass.
  // `--no-courtesy`: the concurrency gate guards the heavy inference and the parent has already passed
  // it; letting the child re-enter it would add a second multi-minute wait for no new information (and
  // the field is stripped from the comparison either way).
  const parentScored = doc.smartTurnRun?.fromCache === false;
  const res = spawnSync(tsx, ['--tsconfig', path.join(REPO_ROOT, 'server', 'tsconfig.json'), SELF, '--emit', second, '--shards', String(SHARD_COUNT), '--no-python', '--no-courtesy', ...(parentScored ? ['--no-cache'] : [])], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const base: Record<string, unknown> = {
    how: 'the whole pipeline (both models\' scores, the span rebuild from the pinned manifests, the policy reading at the fixed point, the ranking, the cross-tables and the document rendering) re-run in a FRESH child process on the same inputs and down the same Smart Turn scoring path, then the two JSON documents compared field by field',
    secondRunExitCode: res.status,
    ignoredFields: VOLATILE_FIELDS,
    secondRunPath: rel(second),
    parentScoredSmartTurn: parentScored,
    scope: parentScored
      ? 'the Smart Turn score cache was cold, so the child was given `--no-cache` and re-scored every cell from scratch: both processes did the same work on the same inputs, and a difference between them can only be a difference in the result — this covers the Smart Turn inference, the span rebuild, the policy reading, the ranking, the cross-tables and the rendering. turn-1-mini\'s scores are reused (--no-python) because its score file carries the python run\'s wall-clock timing; that model\'s output is covered separately by turn1MiniRun.selfCheck'
      : 'the Smart Turn score table was already in the cache and both processes read it, so this covers everything DOWNSTREAM of the scores (the span rebuild, the policy reading, the ranking, the cross-tables and the rendering); the scores themselves are covered by smartTurnRun.audit (a fresh ONNX re-run of sampled cells, reported in the same document) and by turn1MiniRun.selfCheck (a fresh python session re-run of sampled prefixes)',
  };
  if (res.status !== 0 || !existsSync(second)) {
    return { ...base, identical: false, note: 'the second run did not complete — no determinism claim is made', stderrTail: String(res.stderr ?? '').slice(-1500) };
  }
  const other = JSON.parse(readFileSync(second, 'utf8')) as Record<string, any>;
  const differing = diffPaths(stripVolatile(doc), stripVolatile(other));
  return {
    ...base,
    identical: differing.length === 0,
    differingPaths: differing,
    note:
      differing.length === 0
        ? 'Two independent processes took the same scoring path on the same inputs and derived a byte-identical result document apart from the wall-clock fields listed in ignoredFields. What that covers depends on which path was taken and is stated in `scope` below; turn-1-mini\'s model output is established separately by turn1MiniRun.selfCheck.'
        : 'The two runs disagree — the pipeline is not reproducible as run and the differing paths below must be diagnosed before any finding is trusted.',
  };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const t0 = Date.now();
  for (const p of [CORPUS_A_SAMPLES, EOT_MANIFEST, REPRODUCTION, P13_RESULT]) if (!existsSync(p)) throw new Error(`missing ${p} — run fetch-and-verify.mjs --all first`);
  if (!existsSync(SMART_TURN_MODEL)) throw new Error(`Smart Turn ONNX missing at ${SMART_TURN_MODEL}`);

  const built = [...buildCorpusA(), ...buildCorpusB()];
  const allSpans = SMOKE > 0 ? built.slice(0, SMOKE) : built;
  const grids = new Map(allSpans.map((s) => [s.key, spanGrid(s)]));
  if (SMOKE > 0) console.log(`SMOKE: ${allSpans.length}/${built.length} spans — no artifact will be written`);

  // Worker mode: score this shard and exit (the parent unions the tables).
  if (SHARD_INDEX !== null) {
    await runShardWorker(allSpans, SHARD_INDEX, SHARD_COUNT);
    return;
  }

  // ── AC6: the courtesy check runs BEFORE any heavy inference ────────────────────────────────────
  const courtesy = await courtesyCheck();
  console.log(`courtesy check: ${courtesy.polls.length} poll(s), ${courtesy.hits.length} hit(s), waited ${courtesy.totalWaitSeconds}s → ${courtesy.decision}`);

  // ── models ────────────────────────────────────────────────────────────────────────────────────
  const t1m = runTurn1Mini(allSpans);
  console.log(`turn-1-mini: ${t1m.frames.size} spans scored`);
  const st = await scoreSmartTurnSharded(allSpans, grids);
  console.log(`Smart Turn: ${st.cells} cells (${st.fromCache ? 'from cache' : `${st.shards} shards, ${st.shardMs} ms`})`);

  const tablesFor = (model: string): ScoreTables => {
    if (model === 'smart-turn-v3.2') return st.tables;
    const out: ScoreTables = new Map();
    for (const s of allSpans) {
      const grid = grids.get(s.key) ?? [];
      out.set(s.key, { grid, scores: sliceTurn1Mini(s, grid, t1m.frames.get(s.key) ?? []) });
    }
    return out;
  };

  const views: Array<{ id: string; spans: Span[] }> = [
    { id: 'eot-bench-en', spans: allSpans.filter((s) => s.corpus === 'eot-bench-en') },
    { id: 'librispeech-en-real', spans: allSpans.filter((s) => s.corpus === 'librispeech-en-real') },
    { id: 'merged', spans: allSpans },
  ];
  const HOLD_MIN_S = 0.2;
  const HOLD_MAX_S = 5.0;
  const denominator = (spans: Span[]): { kept: Span[]; droppedHolds: number } => {
    const kept = spans.filter((s) => s.label === 'eot' || (s.silenceMs / 1000 >= HOLD_MIN_S - EPS && s.silenceMs / 1000 <= HOLD_MAX_S + EPS));
    return { kept, droppedHolds: spans.length - kept.length };
  };

  const models = ['smart-turn-v3.2', 'turn-1-mini'];
  const analysis: Record<string, any> = {};
  const baseline: Record<string, any> = {};
  const worstCasesFor = new Map<string, SpanVerdict[]>();
  const verdictsFor = new Map<string, Map<string, SpanVerdict>>();
  const tablesByModel = new Map<string, ScoreTables>();
  const baselineVerdicts = new Map<string, SpanVerdict>();

  for (const model of models) {
    const tables = tablesFor(model);
    tablesByModel.set(model, tables);
    const perView: Record<string, any> = {};
    for (const view of views) {
      const { kept, droppedHolds } = denominator(view.spans);
      const row = protocolRow(kept, tables, OPERATING_POINT);
      const cutoffCount = Math.round(row.cutoffRate * row.holdSpans);
      const missedCount = Math.round(row.missedEndpointRate * row.eotSpans);
      const verdicts = new Map<string, SpanVerdict>();
      for (const s of kept) {
        const t = tables.get(s.key)!;
        verdicts.set(s.key, verdictAt(s, t.grid, t.scores, OPERATING_POINT));
      }
      const waits = [...verdicts.values()].filter((v) => v.span.label === 'eot').map((v) => (v.decision === 'detect' ? (v.fireSeconds as number) : OPERATING_POINT.timeoutSeconds)).sort((a, b) => a - b);
      const quant = (p: number): number | null => (waits.length === 0 ? null : round(waits[Math.min(waits.length - 1, Math.max(0, Math.ceil(p * waits.length) - 1))], 4));
      const cutoffs = [...verdicts.values()].filter((v) => v.isCutoff).sort(cutoffOrder);
      const misses = [...verdicts.values()].filter((v) => v.isMiss).sort(missOrder);
      if (view.id === 'merged') {
        worstCasesFor.set(`${model}|false-cutoff`, cutoffs);
        worstCasesFor.set(`${model}|missed-end`, misses);
      }
      verdictsFor.set(`${model}|${view.id}`, verdicts);
      // Cross-check the boolean reading against the protocol row's own counts — they must agree.
      if (cutoffs.length !== cutoffCount || misses.length !== missedCount) {
        throw new Error(`${model}/${view.id}: this file's per-span reading (${cutoffs.length} cutoffs, ${misses.length} misses) disagrees with protocol.mts's sweep (${cutoffCount}, ${missedCount}) — the two readings of the same policy must coincide`);
      }
      perView[view.id] = {
        denominator: { spans: kept.length, holds: row.holdSpans, eots: row.eotSpans, droppedHolds },
        rates: {
          falseCutoff: { k: cutoffCount, n: row.holdSpans, rate: row.cutoffRate, ci95: wilson95(cutoffCount, row.holdSpans) },
          missedEnd: { k: missedCount, n: row.eotSpans, rate: row.missedEndpointRate, ci95: wilson95(missedCount, row.eotSpans) },
          meanLatencySeconds: row.meanLatencySeconds,
          detectRate: row.detectRate,
          f1: row.f1,
        },
        eotWaitSeconds: { p50: quant(0.5), p90: quant(0.9), max: waits.length ? round(waits[waits.length - 1], 4) : null, mean: waits.length ? round(waits.reduce((a, b) => a + b, 0) / waits.length, 4) : null },
        errors: {
          falseCutoffs: cutoffs.map((v, i) => worstCaseRecord(v, model, view.id, 'false-cutoff', i + 1, OPERATING_POINT, tables.get(v.span.key)!)),
          missedEnds: misses.map((v, i) => worstCaseRecord(v, model, view.id, 'missed-end', i + 1, OPERATING_POINT, tables.get(v.span.key)!)),
        },
      };
    }
    analysis[model] = { views: perView };
  }

  // ── baseline: threshold=0, same actionDelay/timeout ───────────────────────────────────────────
  const { kept: mergedKept } = denominator(allSpans);
  const stTables = st.tables;
  for (const s of mergedKept) {
    const t = stTables.get(s.key)!;
    baselineVerdicts.set(s.key, verdictAt(s, t.grid, t.scores, BASELINE_POINT));
  }
  for (const model of models) {
    const perView: Record<string, any> = {};
    for (const view of views) {
      const { kept, droppedHolds } = denominator(view.spans);
      const row = protocolRow(kept, stTables, BASELINE_POINT);
      const cutoffCount = Math.round(row.cutoffRate * row.holdSpans);
      const missedCount = Math.round(row.missedEndpointRate * row.eotSpans);
      perView[view.id] = {
        point: BASELINE_POINT,
        denominator: { spans: kept.length, holds: row.holdSpans, eots: row.eotSpans, droppedHolds },
        rates: {
          falseCutoff: { k: cutoffCount, n: row.holdSpans, rate: row.cutoffRate, ci95: wilson95(cutoffCount, row.holdSpans) },
          missedEnd: { k: missedCount, n: row.eotSpans, rate: row.missedEndpointRate, ci95: wilson95(missedCount, row.eotSpans) },
          meanLatencySeconds: row.meanLatencySeconds,
        },
        note: 'threshold 0 fires on the first cell of EVERY span (every p_eot ≥ 0), so this is the "never consult the model" timer baseline: it detects every EoT with zero latency and cuts every hold whose pause outlasts actionDelay. Identical for both models by construction — the model score cannot enter the verdict.',
      };
    }
    baseline[model] = { views: perView };
  }

  // ── AC3 cross table ───────────────────────────────────────────────────────────────────────────
  const ct = crossTable(
    [{ model: models[0], verdicts: verdictsFor.get(`${models[0]}|merged`)! }, { model: models[1], verdicts: verdictsFor.get(`${models[1]}|merged`)! }],
    baselineVerdicts,
    mergedKept,
  );
  const stRates = analysis['smart-turn-v3.2'].views.merged.rates;
  const t1Rates = analysis['turn-1-mini'].views.merged.rates;
  const bs = baseline['smart-turn-v3.2'].views.merged.rates;
  const conclusion = `At the fixed point on the merged corpus (${analysis['smart-turn-v3.2'].views.merged.denominator.holds} holds, ${analysis['smart-turn-v3.2'].views.merged.denominator.eots} EoT): the timer baseline cuts ${bs.falseCutoff.k}/${bs.falseCutoff.n} holds (${(bs.falseCutoff.rate * 100).toFixed(2)}%) but misses nothing (it fires immediately). Smart Turn cuts ${stRates.falseCutoff.k} (${(stRates.falseCutoff.rate * 100).toFixed(2)}%) and misses ${stRates.missedEnd.k} (${(stRates.missedEnd.rate * 100).toFixed(2)}%); turn-1-mini cuts ${t1Rates.falseCutoff.k} (${(t1Rates.falseCutoff.rate * 100).toFixed(2)}%) and misses ${t1Rates.missedEnd.k} (${(t1Rates.missedEnd.rate * 100).toFixed(2)}%). So a pure timer is NOT dominated on the miss side — it never misses — and the models' value is entirely on the cutoff side: they cut roughly ${(1 - stRates.falseCutoff.rate / bs.falseCutoff.rate).toFixed(2)}× (Smart Turn) and ${(1 - t1Rates.falseCutoff.rate / bs.falseCutoff.rate).toFixed(2)}× (turn-1-mini) fewer real pauses, and in exchange they give up some endpoint certainty (${stRates.missedEnd.k} and ${t1Rates.missedEnd.k} EoT spans that only the timeout caught). ` + `A deployment that would rather wait than interrupt should read that trade as: the model buys back pauses at the price of occasionally falling back to the timer, which is exactly the same fallback the baseline uses unconditionally.`;

  // ── AC5 consistency ───────────────────────────────────────────────────────────────────────────
  const targets = publishedTargets();
  const items: any[] = [];
  for (const model of models) {
    for (const view of ['eot-bench-en', 'librispeech-en-real', 'merged']) {
      const expected = targets[model][view];
      const observed = analysis[model].views[view].rates;
      const meanObs = observed.meanLatencySeconds as number;
      const observedRow = { cutoffK: observed.falseCutoff.k, cutoffN: observed.falseCutoff.n, missedK: observed.missedEnd.k, missedN: observed.missedEnd.n, meanLatencySeconds: round(meanObs, 6) };
      if (expected === null) {
        items.push({
          model,
          view,
          status: 'not-published',
          expected: null,
          observed: observedRow,
          matches: null,
          note: 'P0.13 published only the per-view PARETO FRONTIER and this view has no frontier row at the operating point: the corpus-A view is degenerate (5 holds / 16 EoT) and a threshold-0.13 policy there is dominated by threshold 0.01 + actionDelay 0.5 + timeout 1. This run still reports its own numbers (below), but they are NOT compared against P0.13 and must not be read as a confirmed reproduction.',
        });
        continue;
      }
      items.push({
        model,
        view,
        status: 'compared',
        expected,
        observed: observedRow,
        matches:
          expected.cutoffK === observed.falseCutoff.k &&
          expected.cutoffN === observed.falseCutoff.n &&
          expected.missedK === observed.missedEnd.k &&
          expected.missedN === observed.missedEnd.n &&
          (expected.meanLatencySeconds === null || Number(expected.meanLatencySeconds.toFixed(6)) === Number(meanObs.toFixed(6))),
      });
    }
  }
  const compared = items.filter((i) => i.status === 'compared');
  const diverge = compared.filter((i) => !i.matches);
  const notPublished = items.filter((i) => i.status === 'not-published').length;
  // AC1's grouping half: the count of speaker/session groups this run re-derived from its own fetch of
  // the pinned parquet, against the count P0.13 published. A same-sized denominator reached through a
  // different grouping would still be a different corpus, so this is checked separately from the k/n.
  const groupsObserved = new Set(allSpans.filter((s) => s.corpus === 'eot-bench-en').map((s) => s.group)).size;
  const groupsPublished = p13PublishedGroups();
  const grouping = {
    corpus: 'eot-bench-en',
    groupingKey: 'speaker/session group carried on every span (manifest `group`)',
    observedGroups: groupsObserved,
    publishedGroups: groupsPublished,
    matches: groupsPublished === null ? null : groupsObserved === groupsPublished,
    note:
      groupsPublished === null
        ? "P0.13's RESULT.json carries no groupDistribution for this view, so this run records its own count and claims no match."
        : `This run's own fetch+extraction of the pinned parquet collapses the 1250 spans into ${groupsObserved} speaker/session groups; P0.13 published ${groupsPublished}. Equal counts mean the same turns folded into the same groups, which is AC1's grouping check.`,
  };
  const consistency = {
    source: rel(P13_RESULT),
    sourceSha256: sha256File(P13_RESULT),
    operatingPoint: OPERATING_POINT,
    about: 'recomputed k/n from THIS run\'s own spans and scores vs the k/n P0.13 published for the same policy tuple (read out of P0.13\'s committed RESULT.json frontier, not typed in from prose)',
    items,
    grouping,
    comparedViews: compared.length,
    notPublishedViews: notPublished,
    verdict:
      (diverge.length === 0 ? `IDENTICAL on all ${compared.length} published model/view pairs (${notPublished} view(s) not published by P0.13 — reported, not compared)` : `${diverge.length} DIVERGENCE(S) out of ${compared.length} compared pairs`) +
      (grouping.matches === true ? `; grouping matches (${groupsObserved} speaker/session groups)` : grouping.matches === false ? `; GROUPING DIVERGES (this run ${groupsObserved} vs published ${groupsPublished})` : '; grouping not published'),
    note:
      diverge.length === 0
        ? 'Every published k, n and mean latency is reproduced exactly by an independent re-fetch and re-run — which is the evidence that this task\'s span set, cell geometry and score tables are the same objects P0.13 measured, not merely similar ones.'
        : 'A divergence means this run\'s spans or scores are NOT P0.13\'s; the divergent rows must be diagnosed before any worst-case claim is trusted.',
  };

  // ── top 10 (merged view) ──────────────────────────────────────────────────────────────────────
  const top10: Record<string, any> = {};
  for (const model of models) {
    // Each model's trajectories must be read from ITS OWN table — reading Smart Turn's scores into a
    // turn-1-mini record would produce a plausible-looking trajectory that belongs to the other model.
    const tables = tablesByModel.get(model)!;
    top10[model] = {
      'false-cutoff': worstCasesFor.get(`${model}|false-cutoff`)!.slice(0, 10).map((v, i) => worstCaseRecord(v, model, 'merged', 'false-cutoff', i + 1, OPERATING_POINT, tables.get(v.span.key)!)),
      'missed-end': worstCasesFor.get(`${model}|missed-end`)!.slice(0, 10).map((v, i) => worstCaseRecord(v, model, 'merged', 'missed-end', i + 1, OPERATING_POINT, tables.get(v.span.key)!)),
    };
  }

  // ── the deliverable documents ─────────────────────────────────────────────────────────────────
  const reproduction = JSON.parse(readFileSync(REPRODUCTION, 'utf8')) as Record<string, any>;
  const venvPackages = existsSync(VENV_PYTHON) ? execFileSync(VENV_PYTHON, ['-I', '-m', 'pip', 'list', '--format=freeze'], { encoding: 'utf8' }).trim().split('\n') : [];
  const ev = evidence({ venvPackages, pythonInstalled: venvPackages });

  const doc: Record<string, any> = {
    schema: 'voice-turn-detection-compare/worst-cases-replay@1',
    generatedBy: 'extract-worst-cases.mts',
    generatedAt: nowIso(),
    task: 'gap-voice-turn-detection-p0-15-worst-cases-replay',
    question: 'At P0.13\'s own non-degenerate operating point, WHICH real samples does each model get wrong, and what did the model\'s probability actually do there?',
    operatingPoint: OPERATING_POINT,
    baselinePoint: BASELINE_POINT,
    rankingRules: ORDER_RULES,
    models,
    corpora: [
      { id: 'librispeech-en-real', spans: allSpans.filter((s) => s.corpus === 'librispeech-en-real').length, licence: 'CC-BY-4.0', attribution: 'LibriSpeech (c) 2014 by Vassil Panayotov, CC BY 4.0' },
      { id: 'eot-bench-en', spans: allSpans.filter((s) => s.corpus === 'eot-bench-en').length, licence: 'CC-BY-4.0', attribution: 'livekit/eot-bench-data (CC-BY-4.0), revision ca9d98a9686b920a2d8c9eb984224ba9be74e4dd' },
    ],
    spanCounts: { total: allSpans.length, holds: allSpans.filter((s) => s.label === 'hold').length, eots: allSpans.filter((s) => s.label === 'eot').length, mergedDenominator: mergedKept.length },
    smartTurnRun: { cells: st.cells, fromCache: st.fromCache, shards: st.shards, shardMs: st.shardMs, audit: (st as any).audit ?? null },
    turn1MiniRun: t1m.report,
    analysis,
    baseline,
    crossComparison: { view: 'merged', table: ct, conclusion },
    top10,
    worstCaseCounts: Object.fromEntries(models.flatMap((m) => (['false-cutoff', 'missed-end'] as const).map((e) => [`${m}|${e}`, worstCasesFor.get(`${m}|${e}`)!.length]))),
    consistency,
    courtesyCheck: courtesy,
    reproduction,
    evidence: ev,
    runtimeSeconds: round((Date.now() - t0) / 1000, 3),
  };
  if (SMOKE > 0) {
    console.log(`SMOKE OK — ${allSpans.length} spans: smartTurn ${st.cells} cells, cutoff/miss per model ${models.map((m) => `${analysis[m].views.merged.rates.falseCutoff.k}/${analysis[m].views.merged.rates.missedEnd.k}`).join(' ')}; no artifact written`);
    return;
  }
  // A child produced by the determinism check writes ONLY its own result file, so it cannot rewrite
  // the artifacts the parent is about to write.
  if (IS_CHILD) {
    writeFileSync(EMIT as string, `${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  if (DETERMINISM) {
    doc.determinism = determinismCheck(doc);
    console.log(`determinism: ${doc.determinism.identical ? 'identical second run' : 'DIVERGES'} (${rel(path.join(CACHE_DIR, 'RESULT.second.json'))})`);
  }
  writeFileSync(RESULT_PATH, `${JSON.stringify(doc, null, 2)}\n`);

  // ── worst-cases.jsonl ─────────────────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      kind: 'meta',
      schema: doc.schema,
      generatedAt: doc.generatedAt,
      task: doc.task,
      operatingPoint: OPERATING_POINT,
      baselinePoint: BASELINE_POINT,
      views: ['eot-bench-en', 'librispeech-en-real', 'merged'],
      top10View: 'merged',
      rankingRules: ORDER_RULES,
      spanCounts: doc.spanCounts,
      reproduction: {
        fetch: 'node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --all',
        score: 'node_modules/.bin/tsx --tsconfig server/tsconfig.json experiments/voice-turn-detection-compare/worst-cases-replay/extract-worst-cases.mts --shards 8',
        fullEvidence: 'RESULT.json (this directory) holds every error at every view, the courtesy-check record, the AC5 comparison and the AC7 evidence; ERROR-REPORT.md is the readable version',
      },
      attribution: ['LibriSpeech (c) 2014 by Vassil Panayotov, CC BY 4.0', 'livekit/eot-bench-data, CC-BY-4.0, revision ca9d98a9686b920a2d8c9eb984224ba9be74e4dd'],
      noAudioCommitted:
        'no audio bytes are committed in this directory; every record names the pinned fetch command and the measured sha256 so the exact clip can be materialized and checked, and RESULT.json.reproduction carries the per-file hashes from the run that produced these records',
    }),
  );
  for (const model of models) {
    for (const errorType of ['false-cutoff', 'missed-end'] as const) {
      for (const w of top10[model][errorType]) lines.push(JSON.stringify(w));
    }
  }
  lines.push(JSON.stringify({ kind: 'cross-table', view: 'merged', operatingPoint: OPERATING_POINT, ...ct }));
  lines.push(JSON.stringify({ kind: 'baseline', operatingPoint: BASELINE_POINT, view: 'merged', rates: baseline[models[0]].views.merged.rates, note: baseline[models[0]].views.merged.note }));
  lines.push(JSON.stringify({ kind: 'consistency', ...consistency }));
  lines.push(JSON.stringify({ kind: 'ac7-evidence', evidence: ev }));
  writeFileSync(WORST_CASES, `${lines.join('\n')}\n`);
  writeFileSync(ERROR_REPORT, renderErrorReport(doc));

  console.log(`spans=${allSpans.length} (holds ${doc.spanCounts.holds}, eots ${doc.spanCounts.eots})`);
  console.log(`consistency: ${consistency.verdict}`);
  console.log(`wrote ${rel(WORST_CASES)}, ${rel(RESULT_PATH)}, ${rel(ERROR_REPORT)}`);
}

// ── ordering comparators (declared after use is fine for function hoisting) ───────────────────────
function cutoffOrder(a: SpanVerdict, b: SpanVerdict): number {
  if (b.gapSeconds !== a.gapSeconds) return b.gapSeconds - a.gapSeconds;
  const ds = b.span.silenceMs - a.span.silenceMs;
  if (ds !== 0) return ds;
  const da = (a.decisionSeconds ?? 0) - (b.decisionSeconds ?? 0);
  if (da !== 0) return da;
  return a.span.key < b.span.key ? -1 : 1;
}
function missOrder(a: SpanVerdict, b: SpanVerdict): number {
  if (a.gapSeconds !== b.gapSeconds) {
    if (!Number.isFinite(a.gapSeconds)) return -1;
    if (!Number.isFinite(b.gapSeconds)) return 1;
    return b.gapSeconds - a.gapSeconds;
  }
  return a.span.key < b.span.key ? -1 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
