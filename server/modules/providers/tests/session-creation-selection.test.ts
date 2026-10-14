import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { buildSessionCreate } from '@/modules/mcp-gateway/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * A brand-new session's launch selection is stated BY THE GATEWAY CALL.
 *
 * THE CLAIM. The model/effort/permission-mode a person picked travels only on a
 * `chat.send` frame's options, and the row is written as a side effect of that
 * send. A session whose first turn is NOT a composer send — Live Voice's relayed
 * utterance, an MCP `session_send` — therefore had no recorded model at all, and
 * the Claude runtime's fresh-start fallback (`options.model || 'default'`) ran
 * the child with the CLI's own account default. Measured on 2026-10-15: a
 * Live-Voice-allocated session (app row 76af747d, CLI session 19d68b54) was
 * spawned with `--model default` while the page showed `v4.1flash`, and — because
 * `--model default` also skipped that custom model's launch-spec env — the child
 * carried no ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY at all and spent the host
 * account instead of the model entry's gateway.
 *
 * WHAT THIS FILE PINS. The gateway call (`POST /api/providers/sessions`) records
 * the selection on the row it mints, so "the row exists" and "the session has a
 * selection" are one statement; and a model the app does not know is REFUSED
 * rather than silently recorded (a typo would otherwise degrade to `default`,
 * which is the same incident by another route).
 *
 * WHY THE FIRST CASE IS THE FALSIFYING ONE. The criterion that names this file
 * runs it as the ONLY filter, so a green run is a reading of THIS file. Before
 * the fix the route accepted no selection at all, so the row it wrote has
 * `model = NULL` and the first assertion fails on the first line the run reports.
 */

const UNKNOWN_MODEL = 'v4.1flashh';
const CUSTOM_MODEL = 'selection-custom-model';
const CUSTOM_MODEL_ENV = [{ key: 'ANTHROPIC_BASE_URL', kind: 'value' as const, value: 'http://127.0.0.1:9' }];

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-creation-selection-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** One gateway call, returning both the HTTP answer and the row it minted. */
async function createSession(
  baseUrl: string,
  projectPath: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown>; row: ReturnType<typeof sessionsDb.getSessionById> }> {
  const response = await fetch(`${baseUrl}/api/providers/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', projectPath, ...body }),
  });
  const payload = await response.json() as { data?: Record<string, unknown> };
  const sessionId = typeof payload.data?.sessionId === 'string' ? payload.data.sessionId : '';
  return {
    status: response.status,
    data: payload.data ?? {},
    row: sessionId ? sessionsDb.getSessionById(sessionId) : null,
  };
}

test('a new session records the selection the gateway call carried', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    providerModelsDb.createCustomProviderModel('claude', {
      id: CUSTOM_MODEL,
      model: CUSTOM_MODEL,
      config: { env: CUSTOM_MODEL_ENV },
    });

    const created = await createSession(baseUrl, workspacePath, {
      initialMessage: 'spoken first turn',
      model: CUSTOM_MODEL,
      effort: 'high',
      permissionMode: 'acceptEdits',
    });

    // The falsifying assertion, first: before the fix the route had no selection
    // to write, so the row it minted carried `model: null`.
    assert.equal(
      created.row?.model,
      CUSTOM_MODEL,
      `the row a brand-new session is minted with must carry the selection the caller stated; got model=${JSON.stringify(created.row?.model)}`,
    );
    assert.equal(created.row?.effort, 'high');
    assert.equal(created.row?.permission_mode, 'acceptEdits');
  });
});

test('an unknown model is refused and mints no row', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    providerModelsDb.createCustomProviderModel('claude', {
      id: CUSTOM_MODEL,
      model: CUSTOM_MODEL,
      config: { env: CUSTOM_MODEL_ENV },
    });
    const before = sessionsDb.getAllSessions().length;
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', projectPath: workspacePath, model: UNKNOWN_MODEL }),
    });
    const payload = await response.json() as { error?: { code?: string; message?: string } };

    // Fail closed BEFORE the row exists: a session that ran a model the app does
    // not know is the incident this file is about, so it must not be creatable.
    assert.equal(response.status, 400, `expected a refusal, got ${response.status}`);
    assert.equal(payload.error?.code, 'MODEL_UNKNOWN');
    assert.match(String(payload.error?.message), /v4\.1flashh/);
    assert.ok(
      String(payload.error?.message).includes(CUSTOM_MODEL),
      'the refusal names the values the caller may use, custom models included',
    );
    assert.equal(sessionsDb.getAllSessions().length, before, 'no row is minted for a refused model');
  });
});

test('a gateway call without a selection still mints an empty-selection row', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const created = await createSession(baseUrl, workspacePath, { initialMessage: 'typed first turn' });

    // Backward compatibility: the field is optional, and absent means exactly what
    // it meant before — nothing recorded, every reader falls back as it did.
    assert.equal(created.status, 201);
    assert.equal(created.row?.model, null);
    assert.equal(created.row?.effort, null);
    assert.equal(created.row?.permission_mode, null);
  });
});

test('the selection the create call states is the one the session readers report', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const created = await createSession(baseUrl, workspacePath, { model: 'opus', effort: 'max' });

    const reading = await providerModelsService.resolveSessionModel('claude', {
      sessionId: String(created.data.sessionId),
    });

    assert.deepEqual(
      { model: reading.model, effort: reading.effort, source: reading.source },
      { model: 'opus', effort: 'max', source: 'session' },
    );
  });
});

// --------------------------- the MCP session_create adapter ---------------------------
/**
 * The same statement, made through the MCP write tool.
 *
 * `session_create` has declared a `model` argument since it was written, read it
 * out of the arguments, and then dropped it: the sessions it created ran the
 * CLI's account default while the caller believed it had asked for `sonnet` or
 * `opus` (29 such calls are in this workspace's own audit log). The adapter now
 * states the model on the creation itself — through the same `sessions.create`
 * seam the HTTP gateway's row writer sits behind — and refuses a model the app
 * cannot select with the MCP envelope's own code rather than INTERNAL_ERROR.
 */
function createSessionCreateHarness() {
  const created: Array<Record<string, unknown>> = [];
  const lifecycle: Array<Record<string, unknown>> = [];

  return {
    created,
    lifecycle,
    deps: {
      projects: { list: () => [{ id: 'project-mcp', path: '/tmp/mcp-selection-project' }] },
      sessions: {
        create: (provider: string, projectPath: string, initialMessage: string, selection?: unknown) => {
          created.push({ provider, projectPath, initialMessage, selection });
          return { sessionId: 'mcp-created-session' };
        },
        switchLifecycle: (provider: string, sessionId: string, mode: string) => {
          lifecycle.push({ provider, sessionId, mode });
        },
      },
      control: { send: async () => ({ ok: true, runId: 'run-1' }) },
      models: providerModelsService,
    },
  };
}

test('session_create records the model its caller asked for', async () => {
  const harness = createSessionCreateHarness();

  const payload = await buildSessionCreate(
    { project: 'project-mcp', model: 'opus' },
    { principal: { userId: 1 } } as never,
    harness.deps as never,
  );

  assert.equal(payload.sessionId, 'mcp-created-session');
  // The falsifying assertion, first: the pre-fix adapter called
  // `create(provider, path, message)` and this `selection` was undefined.
  assert.deepEqual(
    harness.created[0].selection,
    { model: 'opus' },
    `the created row must state the model the caller asked for; got ${JSON.stringify(harness.created[0].selection)}`,
  );
});

test('session_create refuses a model the catalog does not list, before creating anything', async () => {
  const harness = createSessionCreateHarness();

  await assert.rejects(
    () => buildSessionCreate(
      { project: 'project-mcp', model: UNKNOWN_MODEL },
      { principal: { userId: 1 } } as never,
      harness.deps as never,
    ),
    (error: unknown) => {
      // The transport's own envelope, not INTERNAL_ERROR: this is an argument
      // mistake, and the caller is told which values would have worked.
      assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENT');
      assert.match(String((error as Error).message), new RegExp(UNKNOWN_MODEL));
      return true;
    },
  );
  assert.equal(harness.created.length, 0, 'a refused model mints no session');
});
