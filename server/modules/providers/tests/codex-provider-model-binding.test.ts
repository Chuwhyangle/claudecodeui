import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import {
  installCodexProviderRegistryPort,
  type CodexProviderRegistryReading,
} from '@/shared/ports/codex-provider-registry.port.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * The model-entry → Codex provider binding (AC-461).
 *
 * Legs:
 * 1. a declared `codexProviderId` is normalized, persisted, and shown as
 *    `model · provider` in the merged catalog;
 * 2. an id that no provider defines (never existed, or was deleted) is refused
 *    with a readable 409 that names it, and nothing is written;
 * 3. an entry that declares no provider keeps the pre-existing behaviour —
 *    bare display name, no stored binding, "inherit the Codex global default";
 * 4. a reserved Codex built-in id is bindable even though the project file may
 *    not define it;
 * 5. duplicating an entry copies its binding;
 * 6. the HTTP route carries `codexProviderId` through to storage.
 *
 * The registry itself is a shared port (the settings module installs the real
 * reading at boot); these legs install a fake reading so the model service is
 * driven without touching a settings file, and the route leg installs the same
 * fake for the process-wide singleton the router uses.
 */

const PREDEFINED: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'codex-default', label: 'Codex default' }],
  DEFAULT: 'codex-default',
};

/** In-memory stand-in for the `provider_models` table; update persists the config like the DB. */
const createCatalogStore = () => {
  const rows = new Map<LLMProvider, CustomProviderModelRecord[]>();
  let nextRecordId = 1;
  const readRows = (provider: LLMProvider) => rows.get(provider) ?? [];

  return {
    rows,
    listCustomProviderModels(provider: LLMProvider) {
      return [...readRows(provider)];
    },
    getCustomProviderModel(provider: LLMProvider, recordId: number) {
      return readRows(provider).find((record) => record.recordId === recordId) ?? null;
    },
    findCustomProviderModelByModelId(provider: LLMProvider, modelId: string) {
      return readRows(provider).find((record) => record.modelId === modelId) ?? null;
    },
    createCustomProviderModel(provider: LLMProvider, input: CustomProviderModelInput) {
      const record: CustomProviderModelRecord = {
        recordId: nextRecordId++,
        provider,
        modelId: input.id,
        model: input.model,
        config: input.config ?? null,
        sortOrder: readRows(provider).length,
      };
      rows.set(provider, [...readRows(provider), record]);
      return record;
    },
    updateCustomProviderModel(
      provider: LLMProvider,
      recordId: number,
      input: CustomProviderModelInput,
    ) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      const updated: CustomProviderModelRecord = {
        ...existing,
        modelId: input.id,
        model: input.model,
        config: input.config === undefined ? existing.config : input.config,
      };
      rows.set(provider, readRows(provider).map((record) => (
        record.recordId === recordId ? updated : record
      )));
      return updated;
    },
    deleteCustomProviderModel(provider: LLMProvider, recordId: number, _fallbackModelId: string) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      rows.set(provider, readRows(provider).filter((record) => record.recordId !== recordId));
      return existing;
    },
  };
};

const createService = (read: () => CodexProviderRegistryReading | null) => {
  const catalog = createCatalogStore();
  const service = createProviderModelsService({
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => PREDEFINED,
        getCurrentActiveModel: async () => ({ model: PREDEFINED.DEFAULT }),
      },
    }),
    catalog,
    sessions: {
      getSessionById: () => null,
      setSessionModel: () => undefined,
      // No row in this file's fixture, so no session-binding write can land;
      // the method exists to satisfy the service's narrowed store seam.
      setSessionModelProviderId: () => false,
      setSessionEffort: () => undefined,
      setSessionPermissionMode: () => false,
    },
    codexProviders: { read },
  });
  return { catalog, service };
};

/** One fake registry reading; `providers` is the mutable project half, reserved ids are fixed. */
const createRegistry = (
  initialIds: string[] = [],
  reservedIds: string[] = ['openai', 'ollama', 'lmstudio'],
) => {
  const ids = new Set(initialIds);
  const reading = (): CodexProviderRegistryReading => ({
    providers: [...ids].map((id) => ({ id })),
    reservedIds,
  });
  return { ids, reading };
};

const modelInput = (codexProviderId?: string): CustomProviderModelInput => ({
  id: 'bound-model',
  model: 'Bound Model',
  config: codexProviderId === undefined ? { env: [] } : { env: [], codexProviderId },
});

const assertRefused = (error: unknown, providerId: string): boolean => {
  assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, 'CODEX_PROVIDER_UNKNOWN');
  assert.match(error.message, new RegExp(providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(error.message, /omit codexProviderId/);
  return true;
};

test('a declared provider is persisted and the merged catalog row shows model · provider', async () => {
  const registry = createRegistry(['bob']);
  const { catalog, service } = createService(registry.reading);

  const created = await service.createCustomModel('codex', modelInput('bob'));

  assert.equal(created.model.label, 'Bound Model · bob');
  assert.equal(created.model.config?.codexProviderId, 'bob');
  assert.deepEqual(created.model.config?.env, []);
  const stored = catalog.rows.get('codex')?.[0];
  assert.ok(stored, 'the row must be written');
  assert.deepEqual(stored.config, { codexProviderId: 'bob', env: [] });

  const merged = await service.getProviderModels('codex');
  const option = merged.OPTIONS.find((entry) => entry.value === 'bound-model');
  assert.equal(option?.label, 'Bound Model · bob');
  assert.equal(option?.config?.codexProviderId, 'bob');
});

test('an unknown provider is refused with a readable 409 naming it, and nothing is written', async () => {
  const { catalog, service } = createService(createRegistry([]).reading);

  await assert.rejects(
    service.createCustomModel('codex', modelInput('nobody')),
    (error) => assertRefused(error, 'nobody'),
  );
  assert.deepEqual(catalog.rows.get('codex'), undefined, 'no row may be persisted');

  const merged = await service.getProviderModels('codex');
  assert.deepEqual(
    merged.OPTIONS.map((entry) => entry.value),
    ['codex-default'],
    'a refused entry must not appear in the catalog',
  );
});

test('a provider deleted since the entry was written is refused on update, and the row is untouched', async () => {
  const registry = createRegistry(['bob']);
  const { catalog, service } = createService(registry.reading);
  const created = await service.createCustomModel('codex', modelInput('bob'));
  const recordId = created.model.recordId;
  assert.ok(recordId);

  registry.ids.delete('bob');

  await assert.rejects(
    service.updateCustomModel('codex', recordId, {
      id: 'bound-model',
      model: 'Renamed',
      config: { env: [], codexProviderId: 'bob' },
    }),
    (error) => assertRefused(error, 'bob'),
  );
  const stored = catalog.rows.get('codex')?.[0];
  assert.equal(stored?.model, 'Bound Model', 'the refused update must not rename the row');
  assert.equal(stored?.config?.codexProviderId, 'bob');

  // A create that binds the same deleted id is refused too: no dangling reference may be added.
  await assert.rejects(
    service.createCustomModel('codex', { ...modelInput('bob'), id: 'second-model' }),
    (error) => assertRefused(error, 'bob'),
  );
  assert.equal(catalog.rows.get('codex')?.length, 1);
});

test('an entry that declares no provider keeps the passthrough baseline', async () => {
  const { catalog, service } = createService(createRegistry(['bob']).reading);

  const withoutBinding = await service.createCustomModel('codex', modelInput());
  assert.equal(withoutBinding.model.label, 'Bound Model');
  assert.deepEqual(withoutBinding.model.config, { env: [] });

  // No config at all: the stored config is null, exactly as before this field existed.
  const withoutConfig = await service.createCustomModel('codex', { id: 'bare', model: 'Bare' });
  assert.equal(withoutConfig.model.label, 'Bare');
  assert.equal(withoutConfig.model.config, null);

  assert.deepEqual(
    catalog.rows.get('codex')?.map((record) => record.config),
    [{ env: [] }, null],
  );
});

test('a reserved Codex built-in id is bindable without a project registry entry', async () => {
  const registry = createRegistry([]);
  const { service } = createService(registry.reading);

  const created = await service.createCustomModel('codex', modelInput('openai'));
  assert.equal(created.model.label, 'Bound Model · openai');
  assert.equal(created.model.config?.codexProviderId, 'openai');
});

test('duplicating an entry copies its provider binding', async () => {
  const { service } = createService(createRegistry(['bob']).reading);
  const source = await service.createCustomModel('codex', modelInput('bob'));
  assert.ok(source.model.recordId);

  const copy = await service.duplicateCustomModel('codex', source.model.recordId, {
    id: 'copy-model',
    model: 'Copy',
  });
  assert.equal(copy.model.label, 'Copy · bob');
  assert.equal(copy.model.config?.codexProviderId, 'bob');
});

/** Mounts the production router over a temp SQLite database, like `model-config-write-path`. */
async function withServer(run: (baseUrl: string, dbPath: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-binding-'));
  const dbPath = path.join(dir, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await writeFile(dbPath, '');
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
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, dbPath);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const postModel = (base: string, provider: string, body: unknown) => fetch(
  `${base}/api/providers/${provider}/models`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
);

test('the HTTP route carries codexProviderId through to storage and refuses an unknown id', async () => {
  const registry = createRegistry(['bob']);
  installCodexProviderRegistryPort({ read: registry.reading });

  await withServer(async (base, dbPath) => {
    const accepted = await postModel(base, 'claude', {
      id: 'route-bound',
      model: 'Route Bound',
      config: { env: [], codexProviderId: 'bob' },
    });
    assert.equal(accepted.status, 201);
    const acceptedBody = (await accepted.json()) as {
      data: { model: { label: string; config?: { codexProviderId?: string } } };
    };
    assert.equal(acceptedBody.data.model.label, 'Route Bound · bob');
    assert.equal(acceptedBody.data.model.config?.codexProviderId, 'bob');

    const refused = await postModel(base, 'claude', {
      id: 'route-unknown',
      model: 'Route Unknown',
      config: { env: [], codexProviderId: 'nobody' },
    });
    assert.equal(refused.status, 409);
    const refusedBody = (await refused.json()) as { error?: { code?: string; message?: string } };
    assert.equal(refusedBody.error?.code, 'CODEX_PROVIDER_UNKNOWN');
    assert.match(refusedBody.error?.message ?? '', /nobody/);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT model_id, config_json FROM provider_models ORDER BY id').all() as Array<{
      model_id: string;
      config_json: string | null;
    }>;
    db.close();
    assert.deepEqual(rows.map((row) => row.model_id), ['route-bound']);
    assert.deepEqual(JSON.parse(rows[0].config_json ?? 'null'), {
      codexProviderId: 'bob',
      env: [],
    });
  });
});
