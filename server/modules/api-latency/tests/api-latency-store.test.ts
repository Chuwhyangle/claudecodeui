/**
 * The sample store: where it writes, and how it survives a restart.
 *
 *   ① the shipped default is `<home>/.cloudpit/api-latency.jsonl` — the Cloudpit
 *      data root, NOT the pre-3.0 `~/.cloudcli` layout, and the legacy directory
 *      is never created by a write;
 *   ② an append reaches disk and a fresh store hydrates it back;
 *   ③ a torn last line (process killed mid-append) is skipped, not fatal;
 *   ④ `list` is bounded by the store's own cap, newest last.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/api-latency/tests/api-latency-store.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ApiLatencyProbeResult } from '@/shared/types.js';

import { API_LATENCY_FILE_NAME, createApiLatencyStore } from '../api-latency-store.service.js';

function sample(overrides: Partial<ApiLatencyProbeResult> = {}): ApiLatencyProbeResult {
  return {
    id: `probe-${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    ok: true,
    mode: 'ping',
    stream: true,
    model: 'test-model',
    transport: 'fresh',
    status: 200,
    requestBytes: 100,
    responseBytes: 20,
    timings: { dnsMs: 4, tcpMs: 6, tlsMs: 20, uploadMs: 1, firstByteMs: 300, downloadMs: 2, totalMs: 333 },
    firstTokenMs: 310,
    error: null,
    ...overrides,
  };
}

test('the shipped default file lives under the Cloudpit data root, never the legacy one', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'api-latency-home-'));
  try {
    const store = createApiLatencyStore({ homeDir: home });
    await store.append(sample());

    const expected = path.join(home, '.cloudpit', API_LATENCY_FILE_NAME);
    assert.ok(existsSync(expected), `the store must write ${expected}`);
    assert.equal(
      existsSync(path.join(home, '.cloudcli')),
      false,
      'a write must not create the pre-3.0 data root',
    );

    const written = await readFile(expected, 'utf8');
    assert.equal(written.trim().split('\n').length, 1, 'one append writes exactly one line');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an append reaches disk and a fresh store hydrates it back', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-latency-store-'));
  const filePath = path.join(directory, 'probes.jsonl');
  try {
    const first = createApiLatencyStore({ filePath });
    const one = sample({ at: '2026-11-01T00:00:01.000Z' });
    const two = sample({ at: '2026-11-01T00:00:02.000Z' });
    await first.append(one);
    await first.append(two);

    const second = createApiLatencyStore({ filePath });
    await second.hydrate();
    assert.deepEqual(second.list().map((entry) => entry.id), [one.id, two.id]);
    // The in-memory reading answered before hydration is empty, not stale.
    assert.deepEqual(createApiLatencyStore({ filePath }).list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a torn last line is skipped rather than failing the whole hydration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-latency-store-'));
  const filePath = path.join(directory, 'probes.jsonl');
  try {
    const good = sample({ at: '2026-11-02T00:00:01.000Z' });
    await writeFile(filePath, `${JSON.stringify(good)}\n{"id":"truncated","at"`, 'utf8');

    const store = createApiLatencyStore({ filePath });
    await store.hydrate();
    assert.deepEqual(store.list().map((entry) => entry.id), [good.id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('list is bounded by the store cap and by the caller, newest last', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-latency-store-'));
  const filePath = path.join(directory, 'probes.jsonl');
  try {
    const store = createApiLatencyStore({ filePath, limit: 3 });
    for (let index = 0; index < 5; index += 1) {
      await store.append(sample({ at: `2026-11-03T00:00:0${index}.000Z` }));
    }

    assert.deepEqual(store.list().map((entry) => entry.at), [
      '2026-11-03T00:00:02.000Z',
      '2026-11-03T00:00:03.000Z',
      '2026-11-03T00:00:04.000Z',
    ], 'the store cap keeps the newest three');
    assert.equal(store.list(1).length, 1);
    // A caller asking for more than the cap gets the cap, never the whole history.
    assert.equal(store.list(50).length, 3);
    // A non-positive count still answers one sample rather than none.
    assert.equal(store.list(0).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
