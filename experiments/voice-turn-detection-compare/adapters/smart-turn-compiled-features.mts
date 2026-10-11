/**
 * The COMPILED Whisper log-mel front-end for group B (P0.6 / AC3).
 *
 * P0 measured group B's end-to-end p90 at 167.4 ms and located 128.5 ms of it in this harness's OWN
 * JavaScript log-mel front-end — a naive O(N²) DFT. The SPEC's remedy was "a production build
 * replaces it with a compiled/wasm mel front-end". This module IS that path: it loads
 * `native/smart-turn-mel.node`, a C implementation of the identical recipe (see native/*.c), built
 * from source on demand.
 *
 * It exposes the same call shape as the JS front-end (`compiledWhisperLogMel(samples)` -> Float32
 * [80,800] row-major) so the harness can diff the two AND time them on the same input. The numeric
 * comparison is not optional: `run.mts` diffs this output against both the JS front-end and the
 * numpy oracle before quoting any latency number.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ADDON = path.join(DIR, 'native', 'smart-turn-mel.node');
const BUILD = path.join(DIR, 'native', 'build.mjs');
const require = createRequire(import.meta.url);

export const COMPILED_N_MELS = 80;
export const COMPILED_N_FRAMES = 800;

type Addon = {
  melFeatures(samples: Float32Array): Float32Array;
  shape: number[];
};

let CACHED: { addon: Addon; buildNote: string } | null = null;

/**
 * Load the addon, building it from source first if the .node is missing or stale. Returns
 * `{ addon: null, error }` instead of throwing when no toolchain is present, so the harness can
 * record `available:false` with the reason rather than fail the whole run.
 */
export function loadCompiledFeatures(): { addon: Addon | null; buildNote: string; error?: string } {
  if (CACHED) return { ...CACHED, addon: CACHED.addon };
  if (!existsSync(BUILD)) return { addon: null, buildNote: 'build.mjs missing', error: `no build script at ${BUILD}` };
  let buildNote = 'addon already built';
  if (!existsSync(ADDON)) {
    try {
      execFileSync('node', [BUILD], { stdio: 'pipe' });
      buildNote = 'built from source (gcc, N-API)';
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      return { addon: null, buildNote: 'build failed', error: (e.stderr?.toString() || e.message).trim().slice(0, 400) };
    }
  }
  if (!existsSync(ADDON)) return { addon: null, buildNote, error: `build reported success but ${ADDON} is absent` };
  try {
    const addon = require(ADDON) as Addon;
    CACHED = { addon, buildNote };
    return { addon, buildNote };
  } catch (err) {
    return { addon: null, buildNote, error: `require(${ADDON}) failed: ${(err as Error).message}` };
  }
}

/** Compiled Whisper log-mel: Float32 [-1,1] mono -> Float32 [80,800] row-major (mel-major). */
export function compiledWhisperLogMel(addon: Addon, samples: Float32Array): Float32Array {
  return addon.melFeatures(samples);
}

/** max |a-b| and mean |a-b| between two same-length feature vectors. */
export function featureDiff(a: Float32Array, b: Float32Array): { n: number; maxAbsDiff: number; meanAbsDiff: number } {
  const n = Math.min(a.length, b.length);
  let maxAbsDiff = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbsDiff) maxAbsDiff = d;
    sum += d;
  }
  return { n, maxAbsDiff, meanAbsDiff: n ? sum / n : 0 };
}

/**
 * Warm/cold timing of the compiled featurisation alone. The FIRST call is the cold one (it builds
 * the slaney mel bank and the Bluestein chirp); the rest are warm. Returns the cold wall time and
 * the warm p50/p90.
 */
export function measureCompiledWarmCold(
  addon: Addon,
  samples: Float32Array,
  iterations = 8,
): { coldMs: number; warmP50Ms: number; warmP90Ms: number; perCallMs: number[] } {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    addon.melFeatures(samples);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  const pick = (p: number) => (warm.length ? warm[Math.min(warm.length - 1, Math.max(0, Math.ceil(p * warm.length) - 1))] : 0);
  return { coldMs: times[0], warmP50Ms: pick(0.5), warmP90Ms: pick(0.9), perCallMs: times.map((t) => Number(t.toFixed(3))) };
}
