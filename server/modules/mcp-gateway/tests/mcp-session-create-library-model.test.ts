/**
 * gap-mcp-session-create-drops-library-model — an MCP `session_create` that names
 * a MODEL-LIBRARY entry records that model on the session row and launches the
 * first run under it, with the entry's own env.
 *
 * The live incident this criterion exists for: a Fleet caller passed
 * `model: 'v4.1flash'` (a custom row of the provider model library), the
 * gateway's own audit log recorded the argument, and the session row came out
 * `model = NULL` — so the resident host launched with `--model default` and
 * spent the host account instead of the model's own gateway. `permissionMode`
 * and `lifecycleMode` landed normally, which is what made the drop look like a
 * model-specific fault rather than a dropped argument.
 *
 * The drop was in the PRODUCTION ADAPTER, not in the tool: `session_create`
 * already reads and validates `model` and hands it to `sessions.create` as
 * `SessionLaunchSelection`; `buildSessionCreateDeps`' `create` wrapper named
 * only the first three parameters and discarded the fourth. A criterion that
 * assembles its own deps bag cannot see that — it would build a bag with the
 * correct arity and pass whatever the adapter does. So this file drives the
 * SAME exported builder `server/index.ts` calls, over the REAL
 * `sessionsService`, the REAL `providerModelsService` and a real SQLite
 * database, and reads the outcome where the incident read it: the row, the
 * launch options production builds for the first run, and the spawn options the
 * Claude runtime compiles from them.
 *
 * Four readings, in one file:
 *
 *   (1) the library entry — row `model = 'v4.1flash'`, and the first run's
 *       resolved launch options carry `model: 'v4.1flash'`, and the SDK options
 *       compiled from them carry that model AND the entry's env KEYS (key names
 *       only; no secret value is asserted, printed or compared).
 *   (2) a built-in model — `sonnet` lands unchanged, and the entry's env keys
 *       are ABSENT, which is what proves the keys read in (1) came from the
 *       library entry rather than from the host environment.
 *   (3) an unknown model — still refused `INVALID_ARGUMENT` before any row
 *       exists.
 *   (4) the anti-false-green negative control — the SAME probe over the
 *       pre-fix adapter shape (three named parameters) records `model = NULL`
 *       and reports no selection reached the row writer, so reading (1) is
 *       discriminating power rather than an assertion that always holds.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-create-library-model-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-session-create-library-model-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, projectsDb, providerModelsDb, sessionsDb } =
  await import('@/modules/database/index.js');
const { mapCliOptionsToSDK, providerCapabilitiesService, providerModelsService, sessionsService } = await import(
  '@/modules/providers/index.js'
);
const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const { buildRunGet, buildSessionCreateDeps, createMcpGatewayModule, MCP_GATEWAY_PATH, mountMcpGateway } =
  await import('../index.js');
import type { SessionLaunchSelection } from '@/shared/types.js';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`session-create-library-model ${line}`);
}

// =====================================================================
// the library entry the incident named, and the env keys it carries
// =====================================================================

/** The custom (library) model id the defect report used verbatim. */
const LIBRARY_MODEL_ID = 'v4.1flash';
/**
 * The entry's env keys. They are deliberately names the HOST environment cannot
 * be carrying: the built-in-model leg asserts their ABSENCE, which is what makes
 * "the keys came from the entry" a reading rather than a coincidence of the
 * process the criterion happens to run in. `ANTHROPIC_` is the launch env
 * allowlist's own prefix.
 */
const LIBRARY_ENV_KEYS = ['ANTHROPIC_LIBRARY_PROBE_BASE_URL', 'ANTHROPIC_LIBRARY_PROBE_TOKEN'] as const;
/** A built-in, catalog-native model: the control for "the library path changed nothing else". */
const BUILTIN_MODEL_ID = 'sonnet';
/** A model in neither the catalog nor the library: the control for the refusal. */
const UNKNOWN_MODEL_ID = 'v4.1flash-typo-not-a-model';

/**
 * Creates the library row through the REAL repository, so "this is a library
 * entry" is the same statement the picker and `assertSelectableModel` read.
 *
 * One row is `value` and one is `secret`, matching the two kinds the library
 * actually stores on the endpoint-routing path. Neither value is asserted
 * anywhere: the criterion compares key NAMES only, which is exactly the line the
 * Definition of Done draws.
 */
function seedLibraryEntry(): void {
  providerModelsDb.createCustomProviderModel('claude', {
    id: LIBRARY_MODEL_ID,
    model: 'v4.1flash (library)',
    config: {
      env: [
        { key: LIBRARY_ENV_KEYS[0], kind: 'value', value: 'https://v41.example.invalid/v1' },
        { key: LIBRARY_ENV_KEYS[1], kind: 'secret', value: 'placeholder-not-asserted' },
      ],
    },
  });
}

// =====================================================================
// the shared runtime harness (real express + real MCP SDK client)
// =====================================================================

const USER_ONE = 1;
const ALL_SCOPES = [...ACCESS_TOKEN_SCOPES];

const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

/** What one `session_create` did, read from the wire and from the process. */
type CreateReading = {
  isError: boolean;
  code: string | null;
  sessionId: string | null;
  runId: string | null;
  raw: string;
};

/**
 * The control seam the gateway is handed. It records every `send` it is asked
 * for — the first run's session id and content — and answers `ok` with a run id
 * so the create completes exactly as it would with the real control service.
 *
 * It is a seam, not a substitution for the code under test: the value this
 * criterion reads (the model) never passes through it, which is why a spy here
 * cannot mask the drop.
 */
function makeControl(): {
  sends: Array<{ caller: unknown; input: { sessionId: string; content: string; options?: Record<string, unknown> } }>;
  seam: { send: (caller: unknown, input: { sessionId: string; content: string; options?: Record<string, unknown> }) => Promise<{ ok: true; runId: string; queued: boolean; queuedMessageUuid: string | null }> };
} {
  const sends: Array<{ caller: unknown; input: { sessionId: string; content: string; options?: Record<string, unknown> } }> = [];
  return {
    sends,
    seam: {
      send: async (caller, input) => {
        sends.push({ caller, input });
        return { ok: true, runId: `run-${sends.length}`, queued: false, queuedMessageUuid: null };
      },
    },
  };
}

/**
 * The `run_get` member the write-tools bag must carry for registration (the
 * module merges its own run registry into `runGet.deps` unconditionally).
 * Minimal but real-shaped, and never called by this criterion.
 */
function runGetSeam() {
  return {
    deps: {
      activity: { snapshot: () => null },
      sessions: { fetchHistory: async () => ({ messages: [] }) },
      now: () => Date.now(),
      sleep: async () => undefined,
      bootId: () => 'session-create-library-model-boot',
    },
    build: buildRunGet,
  };
}

async function startGateway(
  writeTools: Parameters<typeof createMcpGatewayModule>[0]['writeTools'],
  control: Parameters<typeof createMcpGatewayModule>[0]['control'],
): Promise<{ client: Client; close: () => Promise<void> }> {
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = { userId: USER_ONE, tokenId: 1, clientId: null, scopes: ALL_SCOPES };
    next();
  };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, createMcpGatewayModule({ env: { MCP_ENABLED: 'true' }, authorize, control, writeTools }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: nodeFetch });
  const client = new Client({ name: 'session-create-library-model', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Calls `session_create` over the real transport and reads its whole body. */
async function callSessionCreate(
  client: Client,
  args: Record<string, unknown>,
): Promise<CreateReading> {
  const result = (await client.callTool({ name: 'session_create', arguments: args } as Parameters<
    Client['callTool']
  >[0])) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    structuredContent?: unknown;
  };
  const raw = result.content?.[0]?.text ?? '';
  const envelope =
    typeof result.structuredContent === 'object' && result.structuredContent !== null
      ? (result.structuredContent as { code?: unknown })
      : null;
  if (typeof envelope?.code === 'string') {
    return { isError: true, code: envelope.code, sessionId: null, runId: null, raw };
  }
  let code: string | null = null;
  let payload: { sessionId?: unknown; runId?: unknown } = {};
  try {
    payload = JSON.parse(raw) as { sessionId?: unknown; runId?: unknown };
  } catch {
    code = null;
  }
  if (result.isError === true) {
    return { isError: true, code, sessionId: null, runId: null, raw };
  }
  return {
    isError: false,
    code: null,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
    runId: typeof payload.runId === 'string' ? payload.runId : null,
    raw,
  };
}

/** One `createAppSession` call as the row writer received it. */
type RowWriteArgs = {
  provider: unknown;
  projectPath: unknown;
  initialMessage: unknown;
  selection: SessionLaunchSelection | undefined;
};

type RecordingWiring = {
  /** Every row write the adapter performed, in order — the selection as it arrived. */
  args: RowWriteArgs[];
  /** The `McpSessionCreateWiring` `buildSessionCreateDeps` is handed. */
  wiring: Parameters<typeof buildSessionCreateDeps>[0];
};

/**
 * The SAME wiring `server/index.ts` builds, with one recording tap on the row
 * writer. Everything else — the real project repository, the real
 * `providerModelsService` (catalog reader included), the real capability matrix,
 * the real `sessionsService` methods — is unchanged, and the tap delegates with
 * every argument it received, so the row the database ends up with is the row
 * the production write would have produced.
 *
 * The tap is what makes "the adapter forwarded the model" readable independently
 * of the database, and it is what the negative control reads to show the pre-fix
 * adapter forwarded nothing.
 */
function recordingWiring(control: Parameters<typeof buildSessionCreateDeps>[0]['control']): RecordingWiring {
  const args: RowWriteArgs[] = [];
  return {
    args,
    wiring: {
      projects: projectsDb,
      // Spreading the real service keeps `switchSessionLifecycleMode` (and every
      // other member) the production method; only the row writer is wrapped.
      sessions: {
        ...sessionsService,
        createAppSession: (provider, projectPath, initialMessage, selection) => {
          args.push({ provider, projectPath, initialMessage, selection });
          return sessionsService.createAppSession(provider, projectPath, initialMessage, selection);
        },
      },
      control,
      capabilities: providerCapabilitiesService,
      models: providerModelsService,
    },
  };
}

/**
 * The pre-fix adapter shape: the same bag, with the row-writing member replaced
 * by a wrapper that names only the first three parameters — byte-for-byte what
 * `buildSessionCreateDeps` compiled to before the fix. This is the negative
 * control; reading (1) must fail over it.
 */
function withDroppedSelection(
  built: ReturnType<typeof buildSessionCreateDeps>,
  wiring: RecordingWiring['wiring'],
): ReturnType<typeof buildSessionCreateDeps> {
  return {
    ...built,
    sessions: {
      ...built.sessions,
      create: (provider, projectPath, initialMessage) =>
        wiring.sessions.createAppSession(provider, projectPath, initialMessage),
    },
  };
}

/**
 * The first run's launch options and the child's spawn options.
 *
 * Read with the SAME production functions the resident path uses, in the same
 * order: the runtime service's first-run options builder
 * (`defaultResidentLaunchOptions`, wired as the runtime's
 * `resolveResidentLaunchOptions` dependency) reads the session row and resolves
 * the model through `providerModelsService.resolveSessionModel` — that resolved
 * model IS the launch option's `model` — and the Claude runtime compiles those
 * options into the child's spawn options with `mapCliOptionsToSDK`, which sets
 * `model` and overlays the model entry's env. The builder itself is
 * module-private, so the criterion composes its two public halves rather than
 * reach into this module's internals: the row read is the database, the model
 * read is the production service, and the compile is the exported runtime
 * function.
 */
async function readFirstRunSpawnOptions(sessionId: string): Promise<{
  launchModel: unknown;
  spawnModel: unknown;
  spawnEnv: Record<string, string>;
}> {
  const resolved = await providerModelsService.resolveSessionModel('claude', { sessionId });
  const sdkOptions = mapCliOptionsToSDK({ sessionId, model: resolved.model }) as {
    model?: unknown;
    env?: Record<string, string>;
  };
  return {
    launchModel: resolved.model,
    spawnModel: sdkOptions.model,
    spawnEnv: sdkOptions.env ?? {},
  };
}

// =====================================================================
// the criterion
// =====================================================================

test('session_create records a library entry model on the row and launches the first run under it', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  const directory = await mkdtemp(path.join(SCRATCH, 'db-'));
  process.env.DATABASE_PATH = path.join(directory, 'library-model.db');
  await initializeDatabase();

  const projectDir = path.join(SCRATCH, 'project');
  mkdirSync(projectDir, { recursive: true });
  const projectId = projectsDb.createProjectPath(projectDir).project?.project_id;
  assert.equal(typeof projectId, 'string', 'the fixture project must be registered before any create');
  seedLibraryEntry();

  const control = makeControl();
  const productionTap = recordingWiring(control.seam);
  // The SAME exported builder `server/index.ts` calls, handed the SAME members it
  // hands over: the real project repository, the real provider services, and the
  // real sessionsService behind a recording tap on the row writer.
  const productionDeps = buildSessionCreateDeps(productionTap.wiring);

  const droppingControl = makeControl();
  const droppingTap = recordingWiring(droppingControl.seam);
  const droppingProductionDeps = buildSessionCreateDeps(droppingTap.wiring);
  // Only the adapter under test differs: the pre-fix three-parameter shape.
  const droppingDeps = withDroppedSelection(droppingProductionDeps, droppingTap.wiring);

  const gateway = await startGateway({ runGet: runGetSeam(), sessionCreate: productionDeps }, control.seam);
  const droppingGateway = await startGateway(
    { runGet: runGetSeam(), sessionCreate: droppingDeps },
    droppingControl.seam,
  );
  const sessionsBefore = sessionsDb.getAllSessions().length;

  try {
    // ------------------------------------------------------------------
    // (1) the library entry
    // ------------------------------------------------------------------
    const library = await callSessionCreate(gateway.client, {
      project: projectId,
      provider: 'claude',
      model: LIBRARY_MODEL_ID,
      lifecycleMode: 'resident',
      permissionMode: 'bypassPermissions',
      message: 'first turn under the library model',
    });
    say(`(1) create=${JSON.stringify(library)}`);

    assert.equal(library.isError, false, `a library-model create must succeed (got ${library.raw})`);
    assert.equal(typeof library.sessionId, 'string', 'the create must answer the minted session id');
    const sessionId = library.sessionId as string;

    // The selection the adapter handed the row writer, read at the seam.
    say(`(1) adapterArgs=${JSON.stringify(productionTap.args.map((entry) => entry.selection))}`);
    assert.equal(productionTap.args.length, 1, 'exactly one row write per create');
    assert.deepEqual(
      productionTap.args[0]?.selection,
      { model: LIBRARY_MODEL_ID },
      'the validated model must reach createAppSession as its selection',
    );

    // The row, read from the database.
    const row = sessionsDb.getSessionById(sessionId);
    say(
      `(1) row model=${row?.model ?? null} effort=${row?.effort ?? null} permissionMode=${row?.permission_mode ?? null}`,
    );
    assert.equal(row?.model, LIBRARY_MODEL_ID, "the row's model must be the library entry, not NULL");
    assert.equal(row?.permission_mode, 'bypassPermissions', 'the permission mode must land beside the model');

    // The first run's launch options and the child's spawn options.
    const spawn = await readFirstRunSpawnOptions(sessionId);
    say(
      `(1) launchModel=${JSON.stringify(spawn.launchModel)} spawnModel=${JSON.stringify(spawn.spawnModel)} envKeys=${JSON.stringify(
        Object.keys(spawn.spawnEnv).filter((key) => key.startsWith('ANTHROPIC_LIBRARY_PROBE_')),
      )}`,
    );
    assert.equal(spawn.launchModel, LIBRARY_MODEL_ID, "the first run's launch options must name the library model");
    assert.equal(spawn.spawnModel, LIBRARY_MODEL_ID, "the child's spawn options must name the library model");
    for (const key of LIBRARY_ENV_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(spawn.spawnEnv, key),
        `the child's spawn env must carry the entry's key ${key} (keys only; no value is read)`,
      );
    }
    assert.equal(control.sends.length, 1, 'the message must have opened exactly one run');
    assert.equal(control.sends[0].input.sessionId, sessionId, 'the opening run must be the created session');

    // ------------------------------------------------------------------
    // (2) a built-in model is untouched by the library path
    // ------------------------------------------------------------------
    const builtin = await callSessionCreate(gateway.client, {
      project: projectId,
      provider: 'claude',
      model: BUILTIN_MODEL_ID,
      message: 'first turn under a built-in model',
    });
    say(`(2) create=${JSON.stringify(builtin)}`);
    assert.equal(builtin.isError, false, `a built-in-model create must succeed (got ${builtin.raw})`);
    const builtinId = builtin.sessionId as string;

    const builtinRow = sessionsDb.getSessionById(builtinId);
    const builtinSpawn = await readFirstRunSpawnOptions(builtinId);
    say(
      `(2) row model=${builtinRow?.model ?? null} launchModel=${JSON.stringify(builtinSpawn.launchModel)} spawnModel=${JSON.stringify(
        builtinSpawn.spawnModel,
      )} libraryKeysPresent=${JSON.stringify(
        LIBRARY_ENV_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(builtinSpawn.spawnEnv, key)),
      )}`,
    );
    assert.equal(builtinRow?.model, BUILTIN_MODEL_ID, 'a built-in model must land on the row unchanged');
    assert.equal(builtinSpawn.spawnModel, BUILTIN_MODEL_ID, 'a built-in model must reach the spawn options unchanged');
    for (const key of LIBRARY_ENV_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(builtinSpawn.spawnEnv, key),
        false,
        `the library entry's ${key} must NOT appear for a built-in model — the keys in (1) came from the entry`,
      );
    }

    // ------------------------------------------------------------------
    // (3) an unknown model is still refused, and mints nothing
    // ------------------------------------------------------------------
    const unknown = await callSessionCreate(gateway.client, {
      project: projectId,
      provider: 'claude',
      model: UNKNOWN_MODEL_ID,
      message: 'must never open a run',
    });
    say(`(3) create=${JSON.stringify(unknown)}`);
    assert.equal(unknown.isError, true, 'an unknown model must be refused');
    assert.equal(unknown.code, 'INVALID_ARGUMENT', `an unknown model must be INVALID_ARGUMENT (got ${unknown.raw})`);
    assert.equal(
      sessionsDb.getAllSessions().length,
      sessionsBefore + 2,
      'the refused create must mint no row (only the library and built-in creates may)',
    );
    assert.equal(control.sends.length, 2, 'the refused create must not open a run');

    // ------------------------------------------------------------------
    // (4) the negative control: the pre-fix adapter shape drops the model
    // ------------------------------------------------------------------
    const dropped = await callSessionCreate(droppingGateway.client, {
      project: projectId,
      provider: 'claude',
      model: LIBRARY_MODEL_ID,
      message: 'first turn the old wiring would run without a model',
    });
    say(`(4) create=${JSON.stringify(dropped)}`);
    assert.equal(dropped.isError, false, 'the negative control still creates a session');
    const droppedId = dropped.sessionId as string;

    const droppedRow = sessionsDb.getSessionById(droppedId);
    say(
      `(4) adapterArgs=${JSON.stringify(droppingTap.args.map((entry) => entry.selection))} row model=${droppedRow?.model ?? null}`,
    );
    assert.deepEqual(
      droppingTap.args[0]?.selection,
      undefined,
      'the pre-fix adapter must drop the selection (the reading this criterion exists to discriminate)',
    );
    assert.equal(
      droppedRow?.model ?? null,
      null,
      'the pre-fix adapter must leave the row model NULL — exactly the incident',
    );
  } finally {
    await gateway.close();
    await droppingGateway.close();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
    rmSync(SCRATCH, { recursive: true, force: true });
  }
});

// The database connection is closed by the criterion; this guard keeps a
// failure inside the test body from leaving a handle that makes the runner hang.
process.on('exit', () => {
  try {
    closeConnection();
  } catch {
    // Already closed, or never opened: nothing to release.
  }
});
