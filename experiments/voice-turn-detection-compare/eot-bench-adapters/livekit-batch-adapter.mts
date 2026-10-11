/**
 * Group C as an eot-bench BATCH adapter: LiveKit Turn Detector v1-mini, run for real INSIDE
 * `livekit.agents` in the isolated Python sandbox.
 *
 * WHY THE READINGS GO THROUGH A SUBPROCESS. The LiveKit Model License (Section 3.b(i)) permits the
 * model only "together with the LiveKit Agents framework". Nothing LiveKit may therefore be imported
 * into this Node process; the sandbox venv (`livekit-sandbox/`) drives the model through the
 * framework, and this adapter speaks to it over a JSON file contract. The licence reasoning and the
 * sandbox-isolation evidence are P0.6's (`run.mts` → `runLiveKitGroupC`) and are NOT re-derived here.
 *
 * WHY A WAV PER SPAN. The sandbox runner (`run_livekit_eot.py`) takes `{id, wav, atMs}` and reads the
 * audio from disk, cutting at `atMs`. The unified grid needs a score at every cell, so this adapter
 * writes each span's PCM — closing tail included — to a temporary 16-bit WAV once, and then asks the
 * runner for every cell of that span with a different `atMs`. The item's own `audio` is IGNORED
 * because the runner cannot receive PCM inline; that is the one place where this adapter is not a
 * pure function of its `BatchItem`, so it VERIFIES the item against the span it claims instead of
 * trusting it: the id must resolve to a known span and `timestampMs - silenceDurMs` must equal that
 * span's onset. A mismatch throws rather than silently scoring the wrong point.
 *
 * WHAT THE MODEL SEES, AND ITS HONEST LIMIT. The framework's local transport keeps a 1.2 s ring
 * buffer; pushing a prefix longer than that discards the front, so the model's receptive field is the
 * last 1.2 s ending at `atMs` — the same horizon a live pipeline has. A cell whose `d` exceeds 1.2 s
 * therefore asks the same question as the 1.2 s cell for the audio content, and only the reported
 * `silence_dur` differs. The run records this (`outerWindowSeconds`) rather than presenting a flat
 * score curve as if the model had read the extra silence.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BatchAdapter, BatchItem } from './protocol.mts';
import type { ReplaySpan } from './corpus.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const COMPARE_DIR = path.resolve(DIR, '..');

const SANDBOX_DIR = path.join(COMPARE_DIR, 'livekit-sandbox');
const VENV_PY = path.join(SANDBOX_DIR, '.venv', 'bin', 'python');
const RUNNER = path.join(SANDBOX_DIR, 'run_livekit_eot.py');

/** The framework's local transport ring buffer — the model's receptive field. */
export const LIVEKIT_OUTER_WINDOW_SECONDS = 1.2;

/** Write a 16-bit mono PCM RIFF WAVE — the shape `run_livekit_eot.py::decode_wav16` accepts. */
export function writeWav16(pathname: string, samples: Float32Array, sampleRate: number): void {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  writeFileSync(pathname, buf);
}

/** Whether the sandbox is present at all — reported by the runner rather than crashing the sweep. */
export function livekitSandboxStatus(): { available: boolean; reason: string | null } {
  if (!existsSync(VENV_PY)) return { available: false, reason: `${path.relative(COMPARE_DIR, VENV_PY)} missing — run the sandbox setup` };
  if (!existsSync(RUNNER)) return { available: false, reason: `${path.relative(COMPARE_DIR, RUNNER)} missing` };
  return { available: true, reason: null };
}

export type LivekitBatchAdapter = BatchAdapter & {
  /** Every raw runner reading, kept so the report can quote per-point probabilities and latencies. */
  readings: Array<Record<string, unknown>>;
  /** The sandbox's own resource readings. */
  resource: Record<string, unknown>;
  /** Per-cell wall-clock latency, in item order. */
  latencyMs: number[];
  cleanup(): void;
};

export type LivekitAdapterOptions = {
  spans: ReplaySpan[];
  /** Directory for the temporary WAVs; created if absent and removed by `cleanup()`. */
  workDir: string;
  /** The decision threshold the runner reports `predicted` against; the sweep re-thresholds anyway. */
  threshold?: number;
};

/**
 * Build the group-C batch adapter: write each span to a WAV, then expose one `predict_batch` that
 * runs the sandbox over whatever items it is handed.
 */
export function createLivekitBatchAdapter(opts: LivekitAdapterOptions): LivekitBatchAdapter {
  const status = livekitSandboxStatus();
  if (!status.available) throw new Error(`LiveKit sandbox unavailable: ${status.reason}`);
  mkdirSync(opts.workDir, { recursive: true });

  // spanKey → { wav path, onsetMs, truth } — the runner records `truth`/`pauseMs` per item purely for
  // its own report; the unified sweep re-thresholds the returned probability, so those two fields are
  // carried through for the sandbox's bookkeeping and never read as a decision here.
  const byKey = new Map<string, { wav: string; onsetMs: number; truth: string; pauseMs: number | null }>();
  for (const span of opts.spans) {
    const key = `${span.sampleId}#${span.spanIndex}`;
    const wav = path.join(opts.workDir, `${sanitize(key)}.wav`);
    writeWav16(wav, span.audio, span.sampleRate);
    byKey.set(key, { wav, onsetMs: span.onsetMs, truth: span.truth, pauseMs: span.label === 'hold' ? span.silenceMs : null });
  }

  const readings: Array<Record<string, unknown>> = [];
  const resource: Record<string, unknown> = {};
  const latencyMs: number[] = [];
  const itemsFile = path.join(opts.workDir, '_items.json');
  const outFile = path.join(opts.workDir, '_out.json');

  return {
    adapterId: 'livekit-turn-detector-v1-mini-batch',
    scorePoint: 0.2,
    readings,
    resource,
    latencyMs,
    async predictBatch(items: BatchItem[]): Promise<number[]> {
      const payload = items.map((item) => {
        const key = item.id.split('@')[0];
        const entry = byKey.get(key);
        if (entry === undefined) throw new Error(`livekit adapter: unknown span key ${key} (item ${item.id})`);
        const onsetMs = item.timestampMs - item.silenceDurMs;
        if (Math.abs(onsetMs - entry.onsetMs) > 1e-6) {
          throw new Error(
            `livekit adapter: item ${item.id} claims onset ${onsetMs} ms but span ${key} starts at ${entry.onsetMs} ms — refusing to score the wrong point`,
          );
        }
        return { id: item.id, wav: entry.wav, atMs: item.timestampMs, truth: entry.truth, pauseMs: entry.pauseMs, silenceDurMs: item.silenceDurMs };
      });
      writeFileSync(itemsFile, JSON.stringify(payload, null, 2));
      execFileSync(VENV_PY, ['-I', RUNNER, '--items', itemsFile, '--out', outFile, '--threshold', String(opts.threshold ?? 0.5)], {
        stdio: 'pipe',
        cwd: COMPARE_DIR,
      });
      const raw = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
      const rows = raw.readings as Array<Record<string, unknown>>;
      for (const row of rows) {
        readings.push(row);
        latencyMs.push(Number(row.latencyMs ?? 0));
      }
      for (const key of ['outerWindowSeconds', 'coldLatencyMs', 'warmLatencyP50Ms', 'warmLatencyP90Ms', 'cpuMsTotal', 'cpuMsPerDecision', 'rssPeakMb', 'rssDeltaMb']) {
        if (key in raw) resource[key] = raw[key];
      }
      // Rows come back in the item order the runner was given.
      const byId = new Map(rows.map((row) => [String(row.id), Number(row.endOfTurnProbability ?? 0)]));
      return items.map((item) => {
        const score = byId.get(item.id);
        if (score === undefined) throw new Error(`livekit adapter: runner returned no row for ${item.id}`);
        return score;
      });
    },
    cleanup(): void {
      try {
        rmSync(opts.workDir, { recursive: true, force: true });
      } catch {
        /* a temp dir that will not delete is not a measurement failure */
      }
    },
  };
}

function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}
