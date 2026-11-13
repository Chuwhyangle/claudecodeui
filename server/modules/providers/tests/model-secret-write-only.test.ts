import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
// The routes resolve providers through the shared registry port; booting the router
// outside the composition root needs the registry module (which installs the port).
import '@/modules/providers/provider.registry.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { AppError } from '@/shared/utils.js';

const SECRET = 'sk-SENTINEL-write-only-1234';
const NEW_SECRET = 'sk-SENTINEL-rotated-5678';
const KEY = 'ANTHROPIC_AUTH_TOKEN';

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-secret-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const send = (url: string, method: string, body?: unknown) => fetch(url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const models = `/api/providers/claude/models`;
const patchBody = (env: unknown) => ({ id: 'gw-1', model: 'gw-1', config: { env } });

async function createModel(base: string): Promise<number> {
  const res = await send(`${base}${models}`, 'POST', patchBody([
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
    { key: KEY, kind: 'secret', value: SECRET },
  ]));
  assert.equal(res.status, 201);
  const text = await res.text();
  assert.ok(!text.includes(SECRET), 'create response must not echo the secret');
  return JSON.parse(text).data.model.recordId as number;
}

test('list and create responses expose only isSet for secret rows', async () => {
  await withServer(async (base) => {
    await createModel(base);
    const text = await (await send(`${base}${models}`, 'GET')).text();
    assert.ok(!text.includes(SECRET), 'list must not contain the secret value');
    const option = JSON.parse(text).data.models.OPTIONS.find((o: { isCustom: boolean }) => o.isCustom);
    assert.deepEqual(option.config.env, [
      { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
      { key: KEY, kind: 'secret', isSet: true },
    ]);
  });
});

test('PATCH: secret row without value keeps, empty string clears, non-empty replaces', async () => {
  await withServer(async (base) => {
    const recordId = await createModel(base);
    const url = `${base}${models}/${recordId}`;

    const kept = await send(url, 'PATCH', patchBody([{ key: KEY, kind: 'secret' }]));
    assert.equal(kept.status, 200);
    assert.ok(!(await kept.text()).includes(SECRET));
    assert.equal(providerModelsService.getCustomModelConfigForRuntime('claude', 'gw-1')?.env[0]?.value, SECRET);

    const replaced = await send(url, 'PATCH', patchBody([{ key: KEY, kind: 'secret', value: NEW_SECRET }]));
    assert.equal(replaced.status, 200);
    const replacedText = await replaced.text();
    assert.ok(!replacedText.includes(NEW_SECRET) && !replacedText.includes(SECRET));
    assert.equal(providerModelsService.getCustomModelConfigForRuntime('claude', 'gw-1')?.env[0]?.value, NEW_SECRET);

    const cleared = await send(url, 'PATCH', patchBody([{ key: KEY, kind: 'secret', value: '' }]));
    assert.equal(cleared.status, 200);
    assert.deepEqual(providerModelsService.getCustomModelConfigForRuntime('claude', 'gw-1')?.env, []);
  });
});

test('a duplicate really copies the secret and never echoes it', async () => {
  await withServer(async (base) => {
    const recordId = await createModel(base);

    // Both halves have to hold at once: an implementation that dropped the
    // secret would still pass the "no leak" assertions, and one that leaked it
    // would still pass the "really copied" one.
    const blankSecretRow = await send(`${base}${models}/${recordId}/duplicate`, 'POST', {
      id: 'gw-1-copy',
      model: 'gw-1-copy',
      config: { env: [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
        { key: KEY, kind: 'secret' },
      ] },
    });
    assert.equal(blankSecretRow.status, 201);
    const blankSecretText = await blankSecretRow.text();
    assert.ok(!blankSecretText.includes(SECRET), 'duplicate response must not echo the secret');
    // The launch compiler's own read is what "the copy carries the value" means.
    assert.equal(
      providerModelsService.getCustomModelConfigForRuntime('claude', 'gw-1-copy')?.env[1]?.value,
      SECRET,
    );

    // No config at all: the whole source config is copied, secret included.
    const wholeConfig = await send(`${base}${models}/${recordId}/duplicate`, 'POST', {
      id: 'gw-1-copy-2',
      model: 'gw-1-copy-2',
    });
    assert.equal(wholeConfig.status, 201);
    const wholeConfigText = await wholeConfig.text();
    assert.ok(!wholeConfigText.includes(SECRET), 'duplicate response must not echo the secret');
    assert.equal(
      providerModelsService.getCustomModelConfigForRuntime('claude', 'gw-1-copy-2')?.env[1]?.value,
      SECRET,
    );

    const listText = await (await send(`${base}${models}`, 'GET')).text();
    assert.ok(!listText.includes(SECRET), 'list must not contain the secret value');
    for (const id of ['gw-1-copy', 'gw-1-copy-2']) {
      const option = JSON.parse(listText).data.models.OPTIONS.find((o: { value: string }) => o.value === id);
      assert.deepEqual(option.config.env, [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
        { key: KEY, kind: 'secret', isSet: true },
      ]);
    }
  });
});

test('error responses never echo a submitted secret value', async () => {
  await withServer(async (base) => {
    const recordId = await createModel(base);
    const responses = [
      // disallowed key alongside a secret value
      await send(`${base}${models}`, 'POST', patchBody([{ key: 'LD_PRELOAD', kind: 'secret', value: NEW_SECRET }])),
      // duplicate key
      await send(`${base}${models}`, 'POST', patchBody([
        { key: KEY, kind: 'secret', value: NEW_SECRET },
        { key: KEY, kind: 'secret', value: NEW_SECRET },
      ])),
      // 404 on an unknown record
      await send(`${base}${models}/9999`, 'PATCH', patchBody([{ key: KEY, kind: 'secret', value: NEW_SECRET }])),
      // keep with nothing stored to keep
      await send(`${base}${models}`, 'POST', patchBody([{ key: KEY, kind: 'secret' }])),
      // duplicate model id conflict
      await send(`${base}${models}`, 'POST', patchBody([{ key: KEY, kind: 'secret', value: NEW_SECRET }])),
    ];
    assert.deepEqual(responses.map((r) => r.status), [400, 400, 404, 400, 409]);
    for (const res of responses) {
      const text = await res.text();
      assert.ok(!text.includes(NEW_SECRET) && !text.includes(SECRET), text);
    }
    assert.ok(recordId > 0);
  });
});
