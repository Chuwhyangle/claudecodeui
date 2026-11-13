import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import type { CodexModelDescriptor } from '@/modules/providers/list/codex/app-server/codex-app-server.client.js';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';
// The routes resolve providers through the shared registry port; booting the router
// outside the composition root needs the registry module (which installs the port).
import '@/modules/providers/provider.registry.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import {
  installCodexProviderRegistryPort,
  type CodexProviderRegistryReading,
  type CodexUpstreamProviderResolution,
} from '@/shared/ports/codex-provider-registry.port.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * A picker row's identity is `(model, provider id)` (AC-468).
 *
 * Legs:
 * 1. the Codex catalog expands every built-in model into one bare row (inherit
 *    Codex's global default) plus one row per registered project provider, while
 *    a custom entry stays a single row carrying its `codexProviderId`;
 * 2. a model write accepts an explicit provider id, so a built-in model can be
 *    routed to a non-default provider and the id lands on `model_provider_id`;
 * 3. an explicit id wins over the one a custom entry declares, and is validated;
 * 4. moving a bound session to another provider is still refused
 *    (`SESSION_PROVIDER_MISMATCH`), and an id the registry does not define is
 *    still refused (`SESSION_PROVIDER_UNKNOWN`);
 * 5. the active-model route carries the explicit id through, which is how the
 *    picker's selection reaches the row;
 * 6. the FALSE FORMS the criterion must catch: a catalog that leaves built-ins
 *    bare, and a write path that ignores the explicit id, both red the SAME
 *    readings the main cases use.
 *
 * The catalog reading is taken from the real `CodexProviderModels` adapter with
 * an injected `model/list` reply, so the expansion is exercised where it ships
 * rather than through a re-implementation in the test.
 */

const PROVIDER_ALICE = 'alice';
const PROVIDER_BOB = 'bob';
const RESERVED_IDS = ['openai', 'ollama', 'lmstudio'];

const BUILTIN_DEFAULT = 'gpt-6-sol';
const BUILTIN_SECOND = 'gpt-6-luna';
const CUSTOM_BOUND = 'custom-bound';
const CUSTOM_BOUND_PROVIDER = PROVIDER_BOB;

/** Two visible models, the first marked `isDefault` by the CLI's own reply. */
const DESCRIPTORS: CodexModelDescriptor[] = [
  {
    id: BUILTIN_DEFAULT,
    displayName: 'GPT-6-Sol',
    description: 'The default live model.',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  },
  {
    id: BUILTIN_SECOND,
    displayName: 'GPT-6-Luna',
    description: 'A fast live model.',
    hidden: false,
    isDefault: false,
  },
];

/** One fake registry reading; the project half is mutable so a deletion can be modelled. */
const createRegistry = (initialIds: string[] = [PROVIDER_ALICE, PROVIDER_BOB]) => {
  const providerIds = new Set(initialIds);
  const read = (): CodexProviderRegistryReading => ({
    providers: [...providerIds].map((id) => ({ id })),
    reservedIds: RESERVED_IDS,
  });
  return { providerIds, read };
};

/**
 * Models each fake provider actually serves. Deliberately DIFFERENT from the
 * Codex built-ins: a custom provider's own catalog is what its variant rows
 * must name, never the OpenAI built-in list (the bug this file now pins).
 */
const PROVIDER_ALICE_MODELS = ['gpt-5.6-terra', 'v4.1flash'];
const PROVIDER_BOB_MODELS = ['gpt-6.1-sol'];

/** Resolves a fake provider id to an endpoint + secret for the model-list read. */
const createResolveProvider = () => (id: string): CodexUpstreamProviderResolution | null => {
  if (id !== PROVIDER_ALICE && id !== PROVIDER_BOB) {
    return { ok: false, problem: `unknown provider ${id}` };
  }
  return {
    ok: true,
    provider: {
      id,
      name: id === PROVIDER_ALICE ? 'Alice' : 'Bob',
      baseUrl: `https://${id}.test/v1`,
      envKey: `${id.toUpperCase()}_API_KEY`,
      wireApi: 'responses',
      secret: `secret-${id}`,
    },
  };
};

/** Fetch stub: answers each fake provider's model list by its base URL. */
const createProviderFetch = () => (async (url: string | URL | Request) => {
  const target = String(url);
  const id = target.includes('alice.test') ? PROVIDER_ALICE : target.includes('bob.test') ? PROVIDER_BOB : null;
  const models = id === PROVIDER_ALICE ? PROVIDER_ALICE_MODELS : id === PROVIDER_BOB ? PROVIDER_BOB_MODELS : null;
  return {
    ok: models !== null,
    status: models !== null ? 200 : 404,
    json: async () => (models === null ? {} : { data: models.map((model) => ({ id: model })) }),
  };
}) as unknown as typeof fetch;

/** In-memory stand-in for the `provider_models` table the service reads. */
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
      const updated = { ...existing, modelId: input.id, model: input.model };
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

/** In-memory stand-in for the session-row access the write path needs. */
const createSessionStore = () => {
  type Row = {
    model: string | null;
    effort: string | null;
    permission_mode: string | null;
    model_provider_id: string | null;
  };
  const rows = new Map<string, Row>();
  return {
    rows,
    seed(sessionId: string) {
      rows.set(sessionId, {
        model: null,
        effort: null,
        permission_mode: null,
        model_provider_id: null,
      });
    },
    getSessionById: (sessionId: string) => rows.get(sessionId) ?? null,
    setSessionModel: (sessionId: string, model: string) => {
      const row = rows.get(sessionId);
      if (row) {
        row.model = model;
      }
    },
    // Write-once, exactly like the column.
    setSessionModelProviderId: (sessionId: string, providerId: string) => {
      const row = rows.get(sessionId);
      if (!row || row.model_provider_id) {
        return false;
      }
      row.model_provider_id = providerId;
      return true;
    },
    setSessionEffort: (sessionId: string, effort: string) => {
      const row = rows.get(sessionId);
      if (row) {
        row.effort = effort;
      }
    },
    setSessionPermissionMode: (sessionId: string, permissionMode: string) => {
      const row = rows.get(sessionId);
      if (!row) {
        return false;
      }
      row.permission_mode = permissionMode;
      return true;
    },
  };
};

/**
 * The service under test, wired to the REAL Codex catalog adapter over an
 * injected `model/list` reply and to a fake registry / catalog / session store.
 */
const createHarness = (options: { providerIds?: string[] } = {}) => {
  const registry = createRegistry(options.providerIds);
  const catalog = createCatalogStore();
  const sessions = createSessionStore();
  const adapter = new CodexProviderModels({
    listModels: async () => DESCRIPTORS,
    now: () => 0,
    readProviders: registry.read,
    resolveProvider: createResolveProvider(),
    fetchFn: createProviderFetch(),
  });
  const service = createProviderModelsService({
    catalog,
    sessions,
    resolveProvider: () => ({ models: adapter }),
    codexProviders: { read: registry.read },
  });
  return { service, catalog, sessions, registry, adapter };
};

const seedCustomModel = (catalog: ReturnType<typeof createCatalogStore>): void => {
  catalog.createCustomProviderModel('codex', {
    id: CUSTOM_BOUND,
    model: 'Custom Bound',
    config: { env: [], codexProviderId: CUSTOM_BOUND_PROVIDER },
  });
};

// ---------------------------------------------------------------------------
// The shared readings — the main cases pass, the false forms must red.
// ---------------------------------------------------------------------------

const rowsForValue = (
  models: ProviderModelsDefinition,
  value: string,
): ProviderModelsDefinition['OPTIONS'] => models.OPTIONS.filter((option) => option.value === value);

/**
 * The expansion reading: each provider's OWN models become `(provider)`
 * variant rows, the Codex built-ins stay bare, and DEFAULT is untouched.
 */
function assertExpandedCatalog(models: ProviderModelsDefinition): void {
  assert.equal(models.DEFAULT, BUILTIN_DEFAULT, 'DEFAULT must stay the bare Codex default');

  for (const builtin of [BUILTIN_DEFAULT, BUILTIN_SECOND]) {
    const rows = rowsForValue(models, builtin);
    assert.equal(rows.length, 1, `${builtin}: exactly one bare row — a built-in is never re-offered as a provider variant`);
    assert.equal(rows[0].modelProviderId, undefined, `${builtin}: the bare row inherits the Codex default`);
    assert.equal(rows[0].isCustom, false);
  }

  const variantRowsFor = (providerId: string, expected: string[]): void => {
    const rows = expected.flatMap((modelId) => rowsForValue(models, modelId));
    assert.deepEqual(
      rows.map((option) => option.modelProviderId),
      expected.map(() => providerId),
      `${providerId}: its own models appear as its variants`,
    );
    for (const row of rows) {
      assert.match(row.label, new RegExp(`· ${providerId}$`), 'variant labels name their provider');
    }
  };
  variantRowsFor(PROVIDER_ALICE, PROVIDER_ALICE_MODELS);
  variantRowsFor(PROVIDER_BOB, PROVIDER_BOB_MODELS);

  // A Codex built-in model id must never be re-labelled as a provider variant.
  assert.equal(
    models.OPTIONS.some((option) => option.modelProviderId !== undefined
      && [BUILTIN_DEFAULT, BUILTIN_SECOND].includes(option.value)),
    false,
    'a Codex built-in is never re-labelled as a provider variant',
  );

  const customRows = rowsForValue(models, CUSTOM_BOUND);
  assert.equal(customRows.length, 1, 'a custom model is a single row, never expanded');
  assert.equal(customRows[0].modelProviderId, CUSTOM_BOUND_PROVIDER);
  assert.equal(customRows[0].config?.codexProviderId, CUSTOM_BOUND_PROVIDER);
}

/** The write reading: the session row records the provider the selection ran under. */
function assertBindingRecorded(
  sessions: ReturnType<typeof createSessionStore>,
  sessionId: string,
  expectedProviderId: string,
): void {
  const row = sessions.getSessionById(sessionId);
  assert.ok(row, `${sessionId}: the session row must exist`);
  assert.equal(
    row.model_provider_id,
    expectedProviderId,
    `${sessionId}: model_provider_id must record ${expectedProviderId}`,
  );
}

// ---------------------------------------------------------------------------
// Positive arms
// ---------------------------------------------------------------------------

test('the catalog keeps built-ins bare and adds each provider\'s own models as variants', async () => {
  const { service, catalog } = createHarness();
  seedCustomModel(catalog);

  const models = await service.getProviderModels('codex');

  assertExpandedCatalog(models);
  // Reserved Codex built-ins are NOT expanded: the bare row already selects the
  // default one, and the project cannot configure the others.
  assert.equal(
    models.OPTIONS.some((option) => option.modelProviderId !== undefined
      && RESERVED_IDS.includes(option.modelProviderId)),
    false,
    'reserved ids must not become variant rows',
  );
});

test('an explicit provider id routes a built-in model and lands on the session row', () => {
  const { service, sessions } = createHarness();
  sessions.seed('routed');

  const stored = service.setSessionModel('codex', 'routed', BUILTIN_DEFAULT, PROVIDER_ALICE);

  assert.equal(stored?.model, BUILTIN_DEFAULT);
  assert.equal(stored?.modelProviderId, PROVIDER_ALICE);
  assert.equal(stored?.modelProviderProblem, null);
  assert.equal(sessions.getSessionById('routed')?.model, BUILTIN_DEFAULT, 'the bare model value is what is sent');
  assertBindingRecorded(sessions, 'routed', PROVIDER_ALICE);
});

test('an explicit id wins over the binding a custom entry declares, and is validated', () => {
  const { service, catalog, sessions } = createHarness();
  seedCustomModel(catalog);
  sessions.seed('conflict');

  // The entry declares bob; the picker sent the same model under alice.
  const stored = service.setSessionModel('codex', 'conflict', CUSTOM_BOUND, PROVIDER_ALICE);

  assert.equal(stored?.modelProviderId, PROVIDER_ALICE);
  assertBindingRecorded(sessions, 'conflict', PROVIDER_ALICE);
});

test('the existing catalog-derived binding still applies when no explicit id is sent', () => {
  const { service, catalog, sessions } = createHarness();
  seedCustomModel(catalog);
  sessions.seed('derived');

  const stored = service.setSessionModel('codex', 'derived', CUSTOM_BOUND);

  assert.equal(stored?.modelProviderId, CUSTOM_BOUND_PROVIDER);
  assertBindingRecorded(sessions, 'derived', CUSTOM_BOUND_PROVIDER);
});

// ---------------------------------------------------------------------------
// Negative arms
// ---------------------------------------------------------------------------

test('moving a bound session to another provider is still refused', () => {
  const { service, sessions } = createHarness();
  sessions.seed('bound');
  service.setSessionModel('codex', 'bound', BUILTIN_DEFAULT, PROVIDER_ALICE);

  assert.throws(
    () => service.setSessionModel('codex', 'bound', BUILTIN_SECOND, PROVIDER_BOB),
    (error: unknown) => error instanceof AppError
      && error.code === 'SESSION_PROVIDER_MISMATCH'
      && error.statusCode === 409
      && /"alice"/.test(error.message)
      && /"bob"/.test(error.message)
      && /fork this session/i.test(error.message)
      && /start a new one/i.test(error.message),
    'an explicit id under another provider is a switch, not a model change',
  );

  // Nothing was written by the refusal.
  const unchanged = sessions.getSessionById('bound');
  assert.equal(unchanged?.model, BUILTIN_DEFAULT);
  assert.equal(unchanged?.model_provider_id, PROVIDER_ALICE);
});

test('an explicit id conflicting with the recorded binding is the same refusal', () => {
  const { service, catalog, sessions } = createHarness();
  seedCustomModel(catalog);
  sessions.seed('custom-bound');
  service.setSessionModel('codex', 'custom-bound', BUILTIN_DEFAULT, PROVIDER_ALICE);

  // The custom entry derives bob, which conflicts with the recorded alice.
  assert.throws(
    () => service.setSessionModel('codex', 'custom-bound', CUSTOM_BOUND),
    (error: unknown) => error instanceof AppError && error.code === 'SESSION_PROVIDER_MISMATCH',
  );
});

test('an unknown explicit provider id is refused and writes nothing', () => {
  const { service, sessions } = createHarness();
  sessions.seed('fresh');

  assert.throws(
    () => service.setSessionModel('codex', 'fresh', BUILTIN_DEFAULT, 'ghost'),
    (error: unknown) => error instanceof AppError
      && error.code === 'SESSION_PROVIDER_UNKNOWN'
      && error.statusCode === 409
      && /"ghost"/.test(error.message)
      && /no longer exists/i.test(error.message),
  );

  const row = sessions.getSessionById('fresh');
  assert.equal(row?.model, null, 'the model must not be written by a refused selection');
  assert.equal(row?.model_provider_id, null);
});

// ---------------------------------------------------------------------------
// False forms — same readings, red
// ---------------------------------------------------------------------------

test('false form: a bare-only catalog and an explicit-id-ignoring write red the shared readings', async () => {
  // (a) "the catalog does not expand (bare names only)": a registry with no
  // registered provider. This is the pre-change catalog shape, reached through
  // shipped code — the expansion reading must red on it.
  const bareHarness = createHarness({ providerIds: [] });
  seedCustomModel(bareHarness.catalog);
  const bareModels = await bareHarness.service.getProviderModels('codex');
  assert.throws(
    () => assertExpandedCatalog(bareModels),
    /its own models appear as its variants/,
    'a bare-only catalog must red the expansion reading',
  );

  // (b) "the write path ignores the explicit id": the same call without the id
  // derives nothing for a built-in model, so the binding reading must red.
  const explicitHarness = createHarness();
  explicitHarness.sessions.seed('routed');
  explicitHarness.service.setSessionModel('codex', 'routed', BUILTIN_DEFAULT);
  assert.throws(
    () => assertBindingRecorded(explicitHarness.sessions, 'routed', PROVIDER_ALICE),
    /model_provider_id must record alice/,
    'a write that ignores the explicit id must red the binding reading',
  );

  // And the same session shape passes the reading when the id is passed, so the
  // false form is a difference in the write, not in the fixture.
  const mainHarness = createHarness();
  mainHarness.sessions.seed('routed');
  mainHarness.service.setSessionModel('codex', 'routed', BUILTIN_DEFAULT, PROVIDER_ALICE);
  assertBindingRecorded(mainHarness.sessions, 'routed', PROVIDER_ALICE);
});

// ---------------------------------------------------------------------------
// Route leg — the picker's selection reaches the row through HTTP
// ---------------------------------------------------------------------------

/**
 * Boots the providers router over an isolated database, with the process-wide
 * registry port installed as a fake. The route uses the shared
 * `providerModelsService` singleton, so this is the production wiring path.
 */
async function withProviderServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-model-provider-option-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const registry = createRegistry();
  installCodexProviderRegistryPort({ read: registry.read });

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('the active-model route carries the explicit provider id through to the row', async () => {
  await withProviderServer(async (baseUrl) => {
    sessionsDb.createAppSession('route-session', 'codex', '/tmp/workspace', 'Route session');

    const response = await fetch(
      `${baseUrl}/api/providers/codex/sessions/route-session/active-model`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: BUILTIN_DEFAULT, modelProviderId: PROVIDER_ALICE }),
      },
    );
    const payload = await response.json() as {
      data: { model: string; modelProviderId: string | null; modelProviderProblem: string | null };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.data.model, BUILTIN_DEFAULT);
    assert.equal(payload.data.modelProviderId, PROVIDER_ALICE);
    assert.equal(payload.data.modelProviderProblem, null);

    const row = sessionsDb.getSessionById('route-session');
    assert.equal(row?.model, BUILTIN_DEFAULT);
    assert.equal(row?.model_provider_id, PROVIDER_ALICE);

    // The providerModelsService singleton and this route agree on the guard: a
    // second request naming another provider is refused, and the row is intact.
    const refused = await fetch(
      `${baseUrl}/api/providers/codex/sessions/route-session/active-model`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: BUILTIN_SECOND, modelProviderId: PROVIDER_BOB }),
      },
    );
    const refusedBody = await refused.json() as { error?: { code?: string } };
    assert.equal(refused.status, 409);
    assert.equal(refusedBody.error?.code, 'SESSION_PROVIDER_MISMATCH');
    assert.equal(sessionsDb.getSessionById('route-session')?.model_provider_id, PROVIDER_ALICE);
  });
});
