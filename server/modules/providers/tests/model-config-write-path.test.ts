import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
// The routes resolve providers through the shared registry port; booting the router
// outside the composition root needs the registry module (which installs the port).
import '@/modules/providers/provider.registry.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withServer(
  run: (baseUrl: string, dbPath: string) => Promise<void>,
  seed?: (dbPath: string) => void,
): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-config-'));
  const dbPath = path.join(dir, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await writeFile(dbPath, '');
  seed?.(dbPath);
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code } });
      return;
    }
    res.status(500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, dbPath);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const send = (url: string, method: string, body: unknown) => fetch(url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const post = (base: string, id: string, env: unknown) =>
  send(`${base}/api/providers/claude/models`, 'POST', { id, model: id, config: { env } });

test('disallowed env keys are rejected 400 and never persisted', async () => {
  await withServer(async (base, dbPath) => {
    for (const key of ['LD_PRELOAD', 'PATH', 'NODE_OPTIONS', 'CLAUDE_CLI_PATH', 'CLAUDE_CONFIG_DIR']) {
      const res = await post(base, `m-${key}`, [{ key, kind: 'value', value: 'x' }]);
      assert.equal(res.status, 400, key);
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT model_id, config_json FROM provider_models').all();
    db.close();
    assert.deepEqual(rows, []);
    const raw = (await readFile(dbPath)).toString('latin1');
    for (const key of ['LD_PRELOAD', 'NODE_OPTIONS', 'CLAUDE_CLI_PATH']) {
      assert.ok(!raw.includes(key), `${key} must not appear in the database`);
    }
  });
});

test('legal rows persist; unset of allowlisted key is valid; duplicates rejected', async () => {
  await withServer(async (base, dbPath) => {
    const ok = await post(base, 'gw-1', [
      { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
      { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'envref', value: 'GW_TOKEN' },
      { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
    ]);
    assert.equal(ok.status, 201);

    const db = new Database(dbPath, { readonly: true });
    const stored = db.prepare('SELECT config_json FROM provider_models WHERE model_id = ?').get('gw-1') as { config_json: string };
    db.close();
    assert.deepEqual(JSON.parse(stored.config_json).env.map((r: { key: string }) => r.key), [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
    ]);

    const dupKey = await post(base, 'gw-2', [
      { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'a' },
      { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'b' },
    ]);
    assert.equal(dupKey.status, 400);

    const badUnset = await post(base, 'gw-3', [{ key: 'ANTHROPIC_API_KEY', kind: 'unset', value: 'x' }]);
    assert.equal(badUnset.status, 400);

    // ADR-002 decision 5: the same (provider, model_id) cannot be registered twice.
    const dupModel = await post(base, 'gw-1', [{ key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'z' }]);
    assert.equal(dupModel.status, 409);
  });
});

test('PATCH validates config, keeps it when omitted, and clears it with null', async () => {
  await withServer(async (base, dbPath) => {
    const created = await post(base, 'gw-p', [{ key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'a' }]);
    const recordId = (await created.json() as { data: { model: { recordId: number } } }).data.model.recordId;
    const url = `${base}/api/providers/claude/models/${recordId}`;
    const readConfig = () => {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT config_json FROM provider_models WHERE id = ?').get(recordId) as { config_json: string | null };
      db.close();
      return row.config_json;
    };

    const bad = await send(url, 'PATCH', { id: 'gw-p', model: 'gw-p', config: { env: [{ key: 'PATH', kind: 'value', value: '/x' }] } });
    assert.equal(bad.status, 400);
    assert.match(readConfig() ?? '', /ANTHROPIC_BASE_URL/);

    assert.equal((await send(url, 'PATCH', { id: 'gw-p', model: 'renamed' })).status, 200);
    assert.match(readConfig() ?? '', /ANTHROPIC_BASE_URL/);

    assert.equal((await send(url, 'PATCH', { id: 'gw-p', model: 'renamed', config: null })).status, 200);
    assert.equal(readConfig(), null);
  });
});

test('built-in model ids cannot be created with config', async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/api/providers/claude/models`)).json() as { data: { models: { OPTIONS: { value: string }[] } } };
    const builtin = list.data.models.OPTIONS[0].value;
    const res = await post(base, builtin, [{ key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'a' }]);
    assert.equal(res.status, 409);
  });
});

test('legacy database without config_json gains the column via migration', async () => {
  await withServer(async (base, dbPath) => {
    const db = new Database(dbPath, { readonly: true });
    const columns = (db.prepare('PRAGMA table_info(provider_models)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    assert.ok(columns.includes('config_json'));
    assert.equal((await post(base, 'legacy-ok', [{ key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'a' }])).status, 201);
  }, (dbPath) => {
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE provider_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode')),
      model_id TEXT NOT NULL, model_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, model_id));
      INSERT INTO provider_models (provider, model_id, model_name) VALUES ('claude', 'old', 'old');`);
    legacy.close();
  });
});
