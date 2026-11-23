/**
 * The API-latency sample history: recent probes in memory, mirrored to JSONL.
 *
 * THE FILE LIVES UNDER THE CLOUDPIT DATA ROOT, not the pre-3.0 `~/.cloudcli`
 * layout. `defaultCloudpitDataRoot` is the same resolver the reply-suggestions
 * usage ledger and the view-events log use, so this feature adds no third
 * opinion about where the server's local state lives. The directory is created
 * on the first write, so a server that never probes does no filesystem work.
 *
 * WHY A FILE AT ALL. The page exists to show a trend, and an in-memory-only ring
 * would erase it on every restart — the one moment a latency reading is most
 * interesting.
 *
 * Consumers: `api-latency.module.ts` (one store per mounted module) and the
 * routes, which only ever call `list` / `append`.
 */
import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defaultCloudpitDataRoot } from '@/shared/data-root.js';
import type { ApiLatencyProbeResult } from '@/shared/types.js';

/** How many samples the page can page through; older ones stay in the JSONL. */
const DEFAULT_LIMIT = 200;

/** Read this much of the tail on startup — enough for a few hundred samples. */
const HYDRATE_TAIL_BYTES = 256 * 1024;

/** Rewrite the file once it passes this size so it cannot grow without bound. */
const ROTATE_BYTES = 4 * 1024 * 1024;

/** The file's name inside the Cloudpit data root. */
export const API_LATENCY_FILE_NAME = 'api-latency.jsonl';

/** What the routes and the composition root drive. */
export type ApiLatencyStore = {
  list(limit?: number): ApiLatencyProbeResult[];
  append(result: ApiLatencyProbeResult): Promise<void>;
  hydrate(): Promise<void>;
};

/**
 * The store's seams. `filePath` defaults to
 * `<homeDir>/.cloudpit/api-latency.jsonl`; criteria point it at a temp file, and
 * `homeDir` lets one assert the shipped default without touching the real home.
 */
export type ApiLatencyStoreDeps = {
  filePath?: string;
  homeDir?: string;
  limit?: number;
};

function isProbeResult(value: unknown): value is ApiLatencyProbeResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ApiLatencyProbeResult>;
  return typeof candidate.id === 'string'
    && typeof candidate.at === 'string'
    && typeof candidate.timings === 'object'
    && candidate.timings !== null;
}

async function readTailLines(filePath: string, maxBytes: number): Promise<string[]> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // A tail slice can start mid-line; the first fragment is dropped unless the
    // whole file was read.
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * Build the store over one file.
 *
 * Writes are serialized through one promise chain: two browser tabs can probe at
 * once, and an interleaved append of multi-byte content would corrupt a line the
 * next hydrate then silently drops. A failed mirror is swallowed after the
 * sample is already in memory — a successful measurement must not become an
 * error for the caller because the disk is full.
 *
 * Consumers: `api-latency.module.ts` (production) and the routes/store criteria
 * (temp files).
 */
export function createApiLatencyStore(deps: ApiLatencyStoreDeps = {}): ApiLatencyStore {
  const homeDir = deps.homeDir ?? os.homedir();
  const filePath = deps.filePath
    ?? path.join(defaultCloudpitDataRoot(homeDir), API_LATENCY_FILE_NAME);
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const samples: ApiLatencyProbeResult[] = [];
  let writeChain: Promise<void> = Promise.resolve();

  const push = (result: ApiLatencyProbeResult) => {
    samples.push(result);
    if (samples.length > limit) samples.splice(0, samples.length - limit);
  };

  return {
    /** The newest `count` samples, oldest first. Bounded by the store's own cap. */
    list(count = limit) {
      const bounded = Math.min(Math.max(count, 1), limit);
      return samples.slice(-bounded);
    },

    async append(result) {
      push(result);
      writeChain = writeChain.then(async () => {
        try {
          await mkdir(path.dirname(filePath), { recursive: true });
          const info = await stat(filePath).catch(() => null);
          if (info && info.size > ROTATE_BYTES) {
            const kept = samples.map((sample) => JSON.stringify(sample)).join('\n');
            await rename(filePath, `${filePath}.1`).catch(() => undefined);
            await appendFile(filePath, `${kept}\n`, 'utf8');
            return;
          }
          await appendFile(filePath, `${JSON.stringify(result)}\n`, 'utf8');
        } catch {
          // The measurement already happened and is in memory; a failed mirror
          // must not turn a successful probe into an error for the caller.
        }
      });
      await writeChain;
    },

    async hydrate() {
      const lines = await readTailLines(filePath, HYDRATE_TAIL_BYTES).catch(() => []);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isProbeResult(parsed)) push(parsed);
        } catch {
          // A torn last line (process killed mid-append) is skipped, not fatal.
        }
      }
    },
  };
}
