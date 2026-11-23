/**
 * The API-latency routes: input bounds and what a browser is allowed to see.
 *
 *   ① an unknown `mode` is refused with 400 and stores nothing;
 *   ② a probe result is answered and then appears in `GET /series`;
 *   ③ `GET /target` reports the gateway but never the credential;
 *   ④ `limit` bounds the number of samples returned;
 *   ⑤ `uploadBytes` is clamped rather than trusted;
 *   ⑥ the whole module composes over its seams (the composition-root contract).
 *
 * Every case uses a TEMP file for the store and injected gateway resolution, so
 * neither the deployment's `~/.cloudpit/api-latency.jsonl` nor the developer's
 * own settings are read or written.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/api-latency/tests/api-latency.routes.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type Express } from 'express';

import type { ApiLatencyProbeResult, ApiLatencySeries } from '@/shared/types.js';

import { createApiLatencyModule } from '../index.js';
import type { ApiLatencyProbe, ApiLatencyProbeInput } from '../api-latency-probe.service.js';
import { createApiLatencyRoutes, parseProbeRequest, toGatewayTarget } from '../api-latency.routes.js';
import { createApiLatencyStore } from '../api-latency-store.service.js';

function sample(overrides: Partial<ApiLatencyProbeResult> = {}): ApiLatencyProbeResult {
  return {
    id: `probe-${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    ok: true,
    mode: 'ping',
    stream: false,
    model: 'test-model',
    transport: 'reused',
    status: 200,
    requestBytes: 120,
    responseBytes: 40,
    timings: { dnsMs: null, tcpMs: null, tlsMs: null, uploadMs: 0, firstByteMs: 410, downloadMs: 3, totalMs: 415 },
    firstTokenMs: null,
    error: null,
    ...overrides,
  };
}

/** Records what the routes handed the probe, so the parse layer can be observed. */
function recordingProbe(): { probe: ApiLatencyProbe; inputs: ApiLatencyProbeInput[] } {
  const inputs: ApiLatencyProbeInput[] = [];
  return {
    inputs,
    probe: async (input) => {
      inputs.push(input);
      return sample({ mode: input.mode, stream: input.stream, model: input.model ?? 'test-model' });
    },
  };
}

async function withServer(
  run: (baseUrl: string, inputs: ApiLatencyProbeInput[]) => Promise<void>,
  options: { samples?: ApiLatencyProbeResult[] } = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-latency-routes-'));
  const store = createApiLatencyStore({ limit: 200, filePath: path.join(directory, 'probes.jsonl') });
  for (const result of options.samples ?? []) await store.append(result);
  const { probe, inputs } = recordingProbe();

  const app: Express = express();
  app.use(express.json());
  app.use('/api/api-latency', createApiLatencyRoutes({
    probe,
    store,
    resolveTarget: async () => ({
      baseUrl: 'https://gateway.example.test',
      host: 'gateway.example.test',
      model: 'test-model',
      hasCredential: true,
      credentialSource: 'settings.json',
      token: 'super-secret-token',
    }),
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/api/api-latency`, inputs);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('an unknown mode is refused and stores nothing', async () => {
  await withServer(async (baseUrl, inputs) => {
    const response = await fetch(`${baseUrl}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'turbo' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? '', /mode/);

    const series = await fetch(`${baseUrl}/series`).then((r) => r.json() as Promise<ApiLatencySeries>);
    assert.equal(series.probes.length, 0);
    assert.deepEqual(inputs, [], 'a refused request must not reach the probe');
  });
});

test('a probe is answered and then shows up in the series', async () => {
  await withServer(async (baseUrl) => {
    const result = await fetch(`${baseUrl}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'upload', stream: true, model: 'some-model' }),
    }).then((r) => r.json() as Promise<ApiLatencyProbeResult>);

    assert.equal(result.mode, 'upload');
    assert.equal(result.stream, true);
    assert.equal(result.model, 'some-model');

    const series = await fetch(`${baseUrl}/series`).then((r) => r.json() as Promise<ApiLatencySeries>);
    assert.equal(series.probes.length, 1);
    assert.equal(series.probes[0]?.id, result.id);
    assert.equal(series.target.host, 'gateway.example.test');
  });
});

test('the target never carries the credential', async () => {
  await withServer(async (baseUrl) => {
    const raw = await fetch(`${baseUrl}/target`).then((r) => r.text());
    assert.ok(!raw.includes('super-secret-token'), 'the token must not reach the browser');
    assert.ok(!raw.includes('"token"'), 'no token field may be serialized');
    const target = JSON.parse(raw) as { host: string; hasCredential: boolean; credentialSource: string };
    assert.equal(target.host, 'gateway.example.test');
    assert.equal(target.hasCredential, true);
    assert.equal(target.credentialSource, 'settings.json');
  });
});

test('limit bounds the samples returned, newest last', async () => {
  const samples = Array.from({ length: 5 }, (_, index) => sample({ at: `2026-10-29T00:00:0${index}.000Z` }));
  await withServer(
    async (baseUrl) => {
      const series = await fetch(`${baseUrl}/series?limit=2`).then((r) => r.json() as Promise<ApiLatencySeries>);
      assert.equal(series.probes.length, 2);
      assert.deepEqual(series.probes.map((entry) => entry.at), [
        '2026-10-29T00:00:03.000Z',
        '2026-10-29T00:00:04.000Z',
      ]);

      // A malformed limit falls back to the store's own cap instead of failing.
      const unset = await fetch(`${baseUrl}/series?limit=abc`).then((r) => r.json() as Promise<ApiLatencySeries>);
      assert.equal(unset.probes.length, 5);
    },
    { samples },
  );
});

test('the probe body is parsed and bounded before it reaches the probe', () => {
  assert.deepEqual(parseProbeRequest({}), {
    input: { mode: 'ping', stream: true },
  });
  assert.deepEqual(parseProbeRequest({ mode: 'upload', stream: false, uploadBytes: 10 * 1024 * 1024 }), {
    // Clamped to the probe's own ceiling, never honoured as sent.
    input: { mode: 'upload', stream: false, uploadBytes: 1024 * 1024 },
  });
  assert.deepEqual(parseProbeRequest({ model: '  spaced  ' }), {
    input: { mode: 'ping', stream: true, model: 'spaced' },
  });
  assert.deepEqual(parseProbeRequest({ uploadBytes: 0 }), { error: 'uploadBytes must be a positive number' });
  assert.deepEqual(parseProbeRequest({ model: 42 }), { error: 'model must be a string' });
});

test('the browser-safe projection drops the token and nothing else', () => {
  const target = toGatewayTarget({
    baseUrl: 'https://gateway.example.test',
    host: 'gateway.example.test',
    model: 'test-model',
    hasCredential: true,
    credentialSource: 'env',
    token: 'super-secret-token',
  });
  assert.deepEqual(Object.keys(target).sort(), [
    'baseUrl',
    'credentialSource',
    'hasCredential',
    'host',
    'model',
  ]);
});

test('the module composes over its seams and mounts the same contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-latency-module-'));
  try {
    // Hydration is fired inside the module; the store it reads must be the temp one.
    const module = createApiLatencyModule({
      store: createApiLatencyStore({ filePath: path.join(directory, 'probes.jsonl') }),
      probe: async (input) => sample({ mode: input.mode }),
      resolveTarget: async () => ({
        baseUrl: 'https://module.example.test',
        host: 'module.example.test',
        model: 'test-model',
        hasCredential: false,
        credentialSource: null,
        token: null,
      }),
    });

    const app: Express = express();
    app.use(express.json());
    app.use('/api/api-latency', module.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const target = await fetch(`http://127.0.0.1:${port}/api/api-latency/target`)
        .then((r) => r.json() as Promise<{ host: string; hasCredential: boolean }>);
      assert.equal(target.host, 'module.example.test');
      assert.equal(target.hasCredential, false);

      const result = await fetch(`http://127.0.0.1:${port}/api/api-latency/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'ping' }),
      }).then((r) => r.json() as Promise<ApiLatencyProbeResult>);
      assert.equal(result.mode, 'ping');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
