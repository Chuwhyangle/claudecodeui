/**
 * Criterion for the lifecycle-mode preference column and the host-lifecycle API
 * (AC-169).
 *
 * The subject is one stored preference and the two verbs that read it: how a
 * session's `lifecycle_mode` is chosen, who is allowed to move it, and what
 * happens to the process already serving the session when it moves. Everything
 * below runs through production seams — the real express app, the real
 * `authenticateToken`, the real `initializeDatabase` (including its migration,
 * driven against a table that really lacks the column), the real
 * `createSessionHostManager`, and the real routers. The only stand-ins are the
 * provider run and the host driver, which is what keeps a criterion about
 * *policy* from needing a CLI: the fake driver counts the `startHost` calls it
 * receives and holds the sink the manager hands it, so "a turn is in flight"
 * and "the process was closed" are readings the criterion can produce and
 * observe rather than infer.
 *
 * `JWT_SECRET` and `IS_PLATFORM` must be set before the aliased modules are
 * evaluated: `auth.middleware.ts` resolves the secret at module-load time and
 * would otherwise read the developer's real `~/.cloudcli/auth.db`, and
 * `shared/utils.ts` freezes `IS_PLATFORM` on first import. Static imports are
 * hoisted above this code, so the environment is set first and everything else
 * comes in dynamically — the order `session-hosts-routes.test.ts` established.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import type { IProviderFork, IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type { HostCloseReason, HostMode, LLMProvider, ProcessHost } from '@/shared/types.js';

const TEST_JWT_SECRET = 'lifecycle-mode-test-secret';
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');
const {
  providerCapabilitiesService,
  providerRegistry,
  providerRoutes,
  sessionsService,
} = await import('@/modules/providers/index.js');
const {
  LIFECYCLE_MODE_ERROR_CODES,
  createSessionHostsRouter,
  sessionHostManager,
} = await import('@/modules/session-hosts/index.js');
const { AppError } = await import('@/shared/utils.js');

const USER_ID = 1;

/** The providers whose declared lifecycle modes do not include `resident`. */
const PER_RUN_ONLY_PROVIDERS: LLMProvider[] = ['codex', 'cursor', 'opencode'];

// ---------------------------
//----------------- THE FAKE HOST DRIVER ------------
/**
 * The injected host driver: it starts nothing, and reports what it was asked
 * to do.
 *
 * `startHostCalls` is the reading the start arm turns on. `closeReasons` is the
 * record of every close the manager relayed — and `mode-change` in it is what
 * "the old host was retired because the mode moved" means at this seam. `sink`
 * is captured here because it is the only way the criterion can make a host
 * `busy`: leases are reported by the driver, never written by the manager.
 */
type FakeHostDriver = IProviderHostDriver & {
  startHostCalls: number;
  closeReasons: HostCloseReason[];
  sink: IProviderHostDriverSink | null;
};

function createFakeHostDriver(): FakeHostDriver {
  const driver: FakeHostDriver = {
    startHostCalls: 0,
    closeReasons: [],
    sink: null,
    multiplexedHost: false,
    // The host the manager already registered is handed back unchanged: from
    // the manager's side a driver that starts nothing and a driver that starts
    // a process are the same, which is what makes this a stand-in for the
    // process rather than for the manager's bookkeeping.
    async startHost(host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> {
      driver.startHostCalls += 1;
      driver.sink = sink;
      return host;
    },
    async bind(): Promise<void> {},
    async submit(): Promise<void> {},
    async interrupt(): Promise<boolean> {
      return false;
    },
    async reconfigure(): Promise<'live' | 'next-turn'> {
      return 'live';
    },
    async unbind(): Promise<void> {},
    async closeHost(_host: ProcessHost, reason: HostCloseReason): Promise<void> {
      driver.closeReasons.push(reason);
    },
  };

  return driver;
}

// ---------------------------
//----------------- HTTP HARNESS ------------
/** One JSON answer, reduced to the parts the arms read. */
type ApiReading = {
  status: number;
  /** The machine-readable code: the object form both routers answer with. */
  code: string | null;
  message: string;
  data: Record<string, unknown> | null;
};

type Harness = {
  baseUrl: string;
  token: string;
  directory: string;
  driver: FakeHostDriver;
};

async function readApi(response: {
  status: number;
  json: () => Promise<unknown>;
}): Promise<ApiReading> {
  const body = (await response.json()) as { error?: unknown; data?: unknown };
  const error = body.error;
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;

  return {
    status: response.status,
    code: typeof record?.code === 'string' ? record.code : null,
    message: typeof record?.message === 'string' ? record.message : '',
    data: (body.data ?? null) as Record<string, unknown> | null,
  };
}

function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = createHmac('sha256', TEST_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function addUser(id: number, username: string): string {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
  return signToken({ userId: id, username });
}

/**
 * Creates one session row the way the gateway does, under the given provider.
 *
 * `jsonlPath` is passed only for the fork arm: `forkSessionById` refuses a
 * source that has never run, so a source without a transcript would make the
 * fork arm report a refusal instead of the datastore behaviour it is about.
 */
function seedSession(
  sessionId: string,
  provider: LLMProvider,
  directory: string,
  jsonlPath: string | null = null,
): void {
  const now = new Date().toISOString();
  sessionsDb.createSession(sessionId, provider, directory, `Lifecycle ${sessionId}`, now, now, jsonlPath);
}

/**
 * Serves both routers over a throwaway database, mounted exactly as
 * `server/index.ts` mounts them: the real token middleware in front, the
 * production error middleware after, and the two reader seams wired to the
 * same implementations the composition root uses — `sessionsService.readSessionLifecycle`
 * for the session row, and a driver lookup for the provider.
 *
 * The driver lookup is the single deliberate difference: the real one returns
 * claude's driver, which spawns a CLI, and this criterion is about the host
 * layer's policy rather than about any provider's process. Everything else —
 * including the fact that no provider other than claude has a driver at all —
 * is read from the real registry in the arms below.
 */
async function withHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-mode-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const token = addUser(USER_ID, 'tester');
  const driver = createFakeHostDriver();

  const app = express();
  app.use(express.json());
  app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({
    sessionHostManager,
    readSession: (sessionId) => sessionsService.readSessionLifecycle(sessionId),
    resolveHostDriver: (provider) => (provider === 'claude' ? driver : null),
  }));
  app.use('/api/providers', authenticateToken, providerRoutes);
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token,
      directory,
      driver,
    });
  } finally {
    // Every host this case opened is closed here: the manager is a
    // process-wide singleton, so a host left behind would be state the next
    // case in this file reads.
    await sessionHostManager.shutdown({ timeoutMs: 0 });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function authHeaders(context: Harness): Record<string, string> {
  return { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' };
}

async function startHost(context: Harness, sessionId: string): Promise<ApiReading> {
  return readApi(await fetch(`${context.baseUrl}/api/session-hosts/${sessionId}/start`, {
    method: 'POST',
    headers: authHeaders(context),
  }));
}

async function closeHost(context: Harness, sessionId: string): Promise<ApiReading> {
  return readApi(await fetch(`${context.baseUrl}/api/session-hosts/${sessionId}/close`, {
    method: 'POST',
    headers: authHeaders(context),
  }));
}

async function putLifecycleMode(
  context: Harness,
  provider: LLMProvider,
  sessionId: string,
  mode: string,
): Promise<ApiReading> {
  return readApi(await fetch(
    `${context.baseUrl}/api/providers/${provider}/sessions/${sessionId}/lifecycle-mode`,
    { method: 'PUT', headers: authHeaders(context), body: JSON.stringify({ mode }) },
  ));
}

/** The listing's own projection of one session's host, or null when absent. */
async function projectedHost(context: Harness, sessionId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${context.baseUrl}/api/session-hosts`, { headers: authHeaders(context) });
  const reading = await readApi(response);
  const hosts = (reading.data?.hosts ?? []) as Array<Record<string, unknown>>;
  return hosts.find((host) => {
    const bindings = (host.bindings ?? []) as Array<{ appSessionId?: string }>;
    return bindings.some((binding) => binding.appSessionId === sessionId);
  }) ?? null;
}

/** The live host serving one session, as the manager's own read port reports it. */
function liveHost(sessionId: string): ProcessHost | null {
  return sessionHostManager
    .snapshot()
    .find((host) => host.state !== 'closed' && host.bindings.has(sessionId)) ?? null;
}

/**
 * Runs one fork against a stand-in for the provider's own fork implementation.
 *
 * The substitution is the same one `session-fork.test.ts` makes: copying a
 * Claude transcript is the SDK's business and needs a real transcript on disk,
 * while the subject here is what the *datastore* does with the new row once the
 * provider has answered. The service, the repository and the row it writes are
 * all real.
 */
async function withStubFork<T>(run: () => Promise<T>): Promise<T> {
  const claude = providerRegistry.resolveProvider('claude') as { fork?: IProviderFork };
  const realFork = claude.fork;
  Object.defineProperty(claude, 'fork', {
    configurable: true,
    writable: true,
    value: {
      forkSession: async () => ({
        providerSessionId: 'native-fork',
        jsonlPath: path.join(os.tmpdir(), 'lifecycle-mode-native-fork.jsonl'),
      }),
    } satisfies IProviderFork,
  });

  try {
    return await run();
  } finally {
    Object.defineProperty(claude, 'fork', { configurable: true, writable: true, value: realFork });
  }
}

// ---------------------------
//----------------- NAMED ASSERTIONS ------------
/**
 * The readings the five fake forms are aimed at, each as a named function.
 *
 * Factoring them out is what makes a fake form load-bearing rather than
 * decorative: the mutant drives the *same* assertion the real arm does, so a
 * mutation that the arm could not see would pass the assertion and the case
 * would report a hole rather than a pass.
 */
function assertModeRefusedForProvider(reading: ApiReading, provider: string): void {
  assert.ok(reading.status >= 400, `${provider} must be refused, got status ${reading.status}`);
  assert.equal(
    reading.code,
    'LIFECYCLE_MODE_NOT_SUPPORTED',
    `${provider}'s refusal must name the missing capability, got ${String(reading.code)}`,
  );
}

function assertForkInherits(
  sourceMode: HostMode,
  forkedMode: HostMode,
  forkedFrom: string | null,
  sourceId: string,
): void {
  assert.equal(sourceMode, 'resident', 'the source must really be resident for this to be a test');
  // AC-169's "(3) a fork does not inherit" was overturned by the human ruling of
  // 2026-10-07: a resident source produces a resident fork. The reading is
  // `resident`, so a branch that silently fell back to the column default reds
  // here.
  assert.equal(forkedMode, 'resident', 'a fork must inherit the source lifecycle mode');
  assert.equal(forkedFrom, sourceId, 'the fork must point back at its source');
}

function assertCloseRefusedForPerRun(reading: ApiReading): void {
  assert.ok(reading.status >= 400, `a per-run close must be refused, got status ${reading.status}`);
  assert.equal(
    reading.code,
    'LIFECYCLE_MODE_NOT_RESIDENT',
    `a per-run close must name the mode, got ${String(reading.code)}`,
  );
}

function assertStartReallyStartedHost(
  startHostCalls: number,
  hostInProjection: boolean,
  mode: string | null,
): void {
  assert.ok(
    startHostCalls >= 1,
    `the injected driver must have been asked to start a host (startHostCalls=${startHostCalls})`,
  );
  assert.ok(hostInProjection, 'the started host must appear in the listing projection');
  assert.equal(mode, 'resident', 'the started host must be the resident one');
}

function assertBusySwitchStayedOffTurn(storedModeDuringTurn: string, modeChangeDuringTurn: boolean): void {
  assert.equal(storedModeDuringTurn, 'resident', 'the stored mode must not move while a turn is in flight');
  assert.equal(modeChangeDuringTurn, false, 'the host must not be retired while a turn is in flight');
}

// ---------------------------
//----------------- ARMS ------------
test('(1) a legacy row reads back per-run once the real migration adds the column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lifecycle-mode-legacy-'));

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(directory, 'auth.db');
    await initializeDatabase();

    // Build the legacy shape by *removing* the column again: a table that never
    // had it and a table whose column was dropped are the same thing to the
    // migration, and dropping is the only way to reach that state from the
    // schema this build ships. The assertion below is what keeps the fixture
    // honest — a migration that silently did nothing must not be able to pass
    // this case by finding the column it was supposed to add.
    closeConnection();
    getConnection().exec('ALTER TABLE sessions DROP COLUMN lifecycle_mode');
    const columnsBefore = tableColumns('sessions');
    assert.ok(
      !columnsBefore.includes('lifecycle_mode'),
      `the fixture must really be missing the column, saw ${columnsBefore.join(',')}`,
    );

    // The row that will have to survive the migration. Nothing is asserted
    // about it while the column is missing: a table without the column has no
    // answer to give, and the point of the fixture is the state *after* the
    // migration runs over it.
    getConnection()
      .prepare('INSERT INTO sessions (session_id, provider) VALUES (?, ?)')
      .run('legacy-mode-row', 'claude');

    closeConnection();
    await initializeDatabase();

    const columnsAfter = tableColumns('sessions');
    assert.ok(columnsAfter.includes('lifecycle_mode'), 'the migration must add the column');

    const legacyRowMode = sessionsDb.getSessionLifecycleMode('legacy-mode-row');
    assert.equal(legacyRowMode, 'per-run', 'the pre-existing row must read back per-run');

    // The other half: a session created in a fresh database is per-run too, so
    // "per-run" is the column's answer for a new row and not only for an old one.
    seedSession('fresh-mode-row', 'claude', directory);
    const freshRowMode = sessionsDb.getSessionLifecycleMode('fresh-mode-row');
    assert.equal(freshRowMode, 'per-run', 'a fresh row must read back per-run');

    console.log(
      `[lifecycle] migration: legacyRowMode=${legacyRowMode} column=${columnsAfter.includes('lifecycle_mode') ? 'lifecycle_mode' : 'missing'} ` +
        `freshRowMode=${freshRowMode}`,
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

/** The column names of one table, as the database itself reports them. */
function tableColumns(table: string): string[] {
  const rows = getConnection().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

test('(2) a mode the provider never declared is refused with its own code, and a declared one is stored', async () => {
  await withHarness(async (context) => {
    // One session per provider, so the refusal is a statement about the
    // provider the session runs under and not an artifact of the path.
    for (const provider of PER_RUN_ONLY_PROVIDERS) {
      const sessionId = `ac169-mode-write-${provider}`;
      seedSession(sessionId, provider, context.directory);

      const reading = await putLifecycleMode(context, provider, sessionId, 'resident');
      assertModeRefusedForProvider(reading, provider);
      assert.equal(
        sessionsDb.getSessionLifecycleMode(sessionId),
        'per-run',
        'a refused write must not have stored anything',
      );
      console.log(`[lifecycle] unsupported: provider=${provider} code=${reading.code} status=${reading.status}`);
    }

    // The refusal follows the session, not the path: the same codex session,
    // written through a provider whose matrix *does* list resident, must still
    // be refused. Otherwise the matrix would be a property of the URL — and a
    // caller could pick whichever provider it liked.
    const codexSessionId = `ac169-mode-write-${PER_RUN_ONLY_PROVIDERS[0]}`;
    const disguised = await putLifecycleMode(context, 'claude', codexSessionId, 'resident');
    assertModeRefusedForProvider(disguised, 'codex named as claude in the path');
    assert.equal(
      sessionsDb.getSessionLifecycleMode(codexSessionId),
      'per-run',
      'naming another provider must not move the mode either',
    );
    console.log(`[lifecycle] path-vs-session: code=${disguised.code} status=${disguised.status}`);

    const claudeSessionId = 'ac169-mode-write-claude';
    seedSession(claudeSessionId, 'claude', context.directory);

    const unknownMode = await putLifecycleMode(context, 'claude', claudeSessionId, 'sometimes');
    assert.equal(unknownMode.status, 400, 'an unknown mode value is a transport error');
    assert.equal(unknownMode.code, 'LIFECYCLE_MODE_UNKNOWN', 'a typo has its own code');
    assert.notEqual(
      unknownMode.code,
      'LIFECYCLE_MODE_NOT_SUPPORTED',
      'a typo and an unsupported mode are different mistakes',
    );
    console.log(
      `[lifecycle] distinct codes: supported=${'LIFECYCLE_MODE_NOT_SUPPORTED'} unknown=${unknownMode.code} status=${unknownMode.status}`,
    );

    // Positive control: the same write, for a provider that *does* declare
    // resident, must succeed and be readable back — otherwise the refusal above
    // could be "this route always refuses" rather than a capability decision.
    const accepted = await putLifecycleMode(context, 'claude', claudeSessionId, 'resident');
    assert.equal(accepted.status, 200, `the declared mode must be accepted, got ${accepted.status}`);
    assert.equal(sessionsDb.getSessionLifecycleMode(claudeSessionId), 'resident', 'the stored mode must move');
    console.log(`[lifecycle] positive control: claudeMode=${sessionsDb.getSessionLifecycleMode(claudeSessionId)}`);
  });
});

test('(3) a fork of a resident session inherits its mode and points at its source', async () => {
  await withHarness(async (context) => {
    const sourceId = 'ac169-fork-source';
    seedSession(sourceId, 'claude', context.directory, path.join(context.directory, 'native-source.jsonl'));
    sessionsDb.assignProviderSessionId(sourceId, 'native-source');

    const accepted = await putLifecycleMode(context, 'claude', sourceId, 'resident');
    assert.equal(accepted.status, 200, 'the source must really be resident before it is forked');

    await withStubFork(async () => {
      const fork = await sessionsService.forkSessionById(sourceId);
      const sourceMode = sessionsDb.getSessionLifecycleMode(sourceId);
      const forkedRow = sessionsDb.getSessionById(fork.sessionId);
      const forkedMode = sessionsDb.getSessionLifecycleMode(fork.sessionId);

      assertForkInherits(sourceMode, forkedMode, forkedRow?.forked_from_session_id ?? null, sourceId);

      console.log(`[lifecycle] fork: sourceMode=${sourceMode} forkedMode=${forkedMode}`);
    });
  });
});

test('(4a) start really starts the injected driver and the host appears in the listing', async () => {
  await withHarness(async (context) => {
    const sessionId = 'ac169-start-resident';
    seedSession(sessionId, 'claude', context.directory);
    assert.equal((await putLifecycleMode(context, 'claude', sessionId, 'resident')).status, 200);

    const reading = await startHost(context, sessionId);
    assert.equal(reading.status, 200, `start must succeed, got ${reading.status}`);
    assert.equal(reading.data?.mode, 'resident', 'the started host must report the resident mode');

    const projected = await projectedHost(context, sessionId);
    assert.ok(projected, 'the started session must appear in the listing projection');

    assertStartReallyStartedHost(context.driver.startHostCalls, projected !== null, String(projected?.mode ?? ''));
    console.log(
      `[lifecycle] start: startHostCalls=${context.driver.startHostCalls} ` +
        `projected={mode=${String(projected?.mode)} state=${String(projected?.state)} pid=${String(projected?.pid)}}`,
    );
  });
});

test('(4b) close ends a resident host with user, and refuses a per-run session with a code of its own', async () => {
  await withHarness(async (context) => {
    const residentId = 'ac169-close-resident';
    seedSession(residentId, 'claude', context.directory);
    assert.equal((await putLifecycleMode(context, 'claude', residentId, 'resident')).status, 200);
    assert.equal((await startHost(context, residentId)).status, 200);

    const closed = await closeHost(context, residentId);
    assert.equal(closed.status, 200, `closing a resident host must succeed, got ${closed.status}`);
    assert.equal(closed.data?.closeReason, 'user', 'the close must record the reason it used');
    assert.ok(context.driver.closeReasons.includes('user'), 'the driver must have been told');
    console.log(`[lifecycle] close resident: closeReason=${String(closed.data?.closeReason)}`);

    // A per-run session: the verb is resident-only, so this is a refusal about
    // the mode — and it must be a *different* refusal from the two that follow.
    const perRunId = 'ac169-close-per-run';
    seedSession(perRunId, 'claude', context.directory);
    const perRun = await closeHost(context, perRunId);
    assertCloseRefusedForPerRun(perRun);

    const unknown = await closeHost(context, 'ac169-no-such-session');
    assert.equal(unknown.status, 404, 'an unknown id has nothing to close');
    assert.equal(unknown.code, 'SESSION_NOT_FOUND', 'an unknown id is its own refusal');

    const residentWithoutHost = 'ac169-close-no-host';
    seedSession(residentWithoutHost, 'claude', context.directory);
    assert.equal((await putLifecycleMode(context, 'claude', residentWithoutHost, 'resident')).status, 200);
    const noHost = await closeHost(context, residentWithoutHost);
    assert.equal(noHost.status, 404, 'a resident session with no host has nothing to close');
    assert.equal(noHost.code, 'SESSION_HOST_NOT_FOUND', 'a missing host is its own refusal');

    const codes = [perRun.code, unknown.code, noHost.code];
    assert.equal(new Set(codes).size, 3, `the three refusals must be mutually distinct, got ${codes.join(', ')}`);
    for (const code of codes) {
      assert.ok(
        code !== null && (LIFECYCLE_MODE_ERROR_CODES as readonly string[]).includes(code),
        `${String(code)} must be part of the lifecycle vocabulary`,
      );
    }

    console.log(
      `[lifecycle] close refusals: perRunCloseCode=${perRun.code} status=${perRun.status} ` +
        `sessionMissing=${unknown.code}/${unknown.status} hostMissing=${noHost.code}/${noHost.status}`,
    );
  });
});

test('(4c) start is refused when the provider mounts no driver, distinctly from the other refusals', async () => {
  await withHarness(async (context) => {
    // The real registry is the evidence that this arm is not a coincidence of
    // the injected lookup: no provider but claude has a host driver at all.
    for (const provider of PER_RUN_ONLY_PROVIDERS) {
      assert.equal(
        providerRegistry.resolveProvider(provider).hostDriver,
        undefined,
        `${provider} must really mount no host driver`,
      );
    }

    const sessionId = 'ac169-start-no-driver';
    seedSession(sessionId, 'codex', context.directory);
    sessionsDb.setSessionLifecycleMode(sessionId, 'resident');

    const reading = await startHost(context, sessionId);
    assert.equal(reading.status, 409, `a provider with no driver cannot be started, got ${reading.status}`);
    assert.equal(reading.code, 'LIFECYCLE_MODE_HOST_UNAVAILABLE', 'the refusal must name the missing driver');
    assert.equal(context.driver.startHostCalls, 0, 'no driver was resolved, so nothing was started');

    // Both neighbours are produced here rather than restated: the per-run
    // refusal on a session that is really per-run, and the success on a
    // session that is really resident. The three readings then sit side by
    // side in the log, which is what makes "distinct" checkable by eye as well
    // as by assertion.
    const perRunId = 'ac169-close-per-run-control';
    seedSession(perRunId, 'claude', context.directory);
    const perRunRefusal = await closeHost(context, perRunId);
    assertCloseRefusedForPerRun(perRunRefusal);

    const startedId = 'ac169-start-control';
    seedSession(startedId, 'claude', context.directory);
    assert.equal((await putLifecycleMode(context, 'claude', startedId, 'resident')).status, 200);
    const successfulStart = await startHost(context, startedId);
    assert.equal(successfulStart.status, 200, 'the control start must really succeed');

    assert.notEqual(reading.code, perRunRefusal.code, 'the two 409s must not be the same refusal');
    assert.equal(successfulStart.code, null, 'a success carries no refusal code at all');
    assert.notEqual(reading.status, successfulStart.status, 'a refusal must not read like a success');

    console.log(
      `[lifecycle] no driver: code=${reading.code} status=${reading.status} ` +
        `perRunClose=${perRunRefusal.code}/${perRunRefusal.status} ` +
        `successfulStart=${successfulStart.status} (code=${String(successfulStart.code)})`,
    );
  });
});

test('(5) a switch during a turn does not take effect, and the same switch on an idle host does', async () => {
  await withHarness(async (context) => {
    const sessionId = 'ac169-busy-window';
    seedSession(sessionId, 'claude', context.directory);
    assert.equal((await putLifecycleMode(context, 'claude', sessionId, 'resident')).status, 200);
    assert.equal((await startHost(context, sessionId)).status, 200);

    const sink = context.driver.sink;
    assert.ok(sink, 'the driver must have received the manager sink');
    sink.leaseAdded(sessionId, { kind: 'turn', runId: 'turn-1' });
    assert.equal(liveHost(sessionId)?.state, 'busy', 'the host must really be mid-turn');

    const duringTurn = await putLifecycleMode(context, 'claude', sessionId, 'per-run');
    assert.equal(duringTurn.status, 409, `a switch under a turn must be refused, got ${duringTurn.status}`);
    assert.equal(duringTurn.code, 'LIFECYCLE_MODE_HOST_BUSY', 'the refusal must name the busy window');

    const storedModeDuringTurn = sessionsDb.getSessionLifecycleMode(sessionId);
    const modeChangeDuringTurn = context.driver.closeReasons.includes('mode-change');
    assertBusySwitchStayedOffTurn(storedModeDuringTurn, modeChangeDuringTurn);
    assert.equal(liveHost(sessionId)?.state, 'busy', 'the host must still be the same live host');
    console.log(
      `[lifecycle] busy switch: busySwitch=refused storedModeDuringTurn=${storedModeDuringTurn} ` +
        `modeChangeDuringTurn=${modeChangeDuringTurn}`,
    );

    // Positive control: the same switch, on the same session, with no turn in
    // flight, must take effect — storage *and* the process.
    sink.leaseRemoved(sessionId, 'turn');
    assert.equal(liveHost(sessionId)?.state, 'idle', 'the host must be idle once the turn ends');

    const whenIdle = await putLifecycleMode(context, 'claude', sessionId, 'per-run');
    assert.equal(whenIdle.status, 200, `an idle switch must be accepted, got ${whenIdle.status}`);
    assert.equal(whenIdle.data?.closedHostReason, 'mode-change', 'the old host must be retired by the mode change');
    assert.equal(sessionsDb.getSessionLifecycleMode(sessionId), 'per-run', 'the stored mode must move');
    assert.equal(liveHost(sessionId), null, 'the old host must no longer be live');
    console.log(`[lifecycle] idle switch: idleSwitch=applied closeReason=${String(whenIdle.data?.closedHostReason)}`);

    // (5b) The deferred half of the busy rule: this implementation *refuses*,
    // so the deferred reading is not asserted — an AC that allows either form
    // must not turn the unnamed one into a failure.
    console.log('[lifecycle] busy switch deferral: deferredNotImplemented');
  });
});

test('the five fake forms each red the reading they are aimed at', async () => {
  await withHarness(async (context) => {
    const codexId = 'ac169-fake-codex';
    seedSession(codexId, 'codex', context.directory);

    // (a) The write path stores the mode without consulting the capability
    // matrix; the repository's value check is then the last gate, and `resident`
    // is a valid *value*, so codex ends up holding one.
    const withoutMatrixCheck: ApiReading = {
      status: sessionsDb.setSessionLifecycleMode(codexId, 'resident') ? 200 : 404,
      code: null,
      message: '',
      data: null,
    };
    assert.throws(
      () => assertModeRefusedForProvider(withoutMatrixCheck, 'codex'),
      /refused/,
      'fake (a) must red the capability refusal',
    );
    assert.equal(sessionsDb.getSessionLifecycleMode(codexId), 'resident', 'the mutation really did store it');
    console.log('[lifecycle] fake (a): red');

    // (b) The fork path drops the mode: the branch is really forked (it points
    // back at its source), but its row reads back per-run — the regression AC-169
    // used to require, and the one the inheritance reading now exists to catch.
    const sourceId = 'ac169-fake-fork-source';
    seedSession(sourceId, 'claude', context.directory, path.join(context.directory, 'native-fake-source.jsonl'));
    sessionsDb.assignProviderSessionId(sourceId, 'native-source');
    sessionsDb.setSessionLifecycleMode(sourceId, 'resident');

    await withStubFork(async () => {
      const fork = await sessionsService.forkSessionById(sourceId);
      // The mutation: the branch loses the mode the real path copies onto it.
      sessionsDb.setSessionLifecycleMode(fork.sessionId, 'per-run');
      const forkedRow = sessionsDb.getSessionById(fork.sessionId);
      assert.throws(
        () => assertForkInherits(
          sessionsDb.getSessionLifecycleMode(sourceId),
          sessionsDb.getSessionLifecycleMode(fork.sessionId),
          forkedRow?.forked_from_session_id ?? null,
          sourceId,
        ),
        /must inherit/,
        'fake (b) must red the inheritance reading',
      );
      console.log('[lifecycle] fake (b): red');
    });

    // (c) A per-run session's close is answered as a success instead of a refusal.
    const permissiveClose: ApiReading = { status: 200, code: null, message: '', data: null };
    assert.throws(
      () => assertCloseRefusedForPerRun(permissiveClose),
      /must be refused/,
      'fake (c) must red the per-run close refusal',
    );
    console.log('[lifecycle] fake (c): red');

    // (d) The switch runs under a turn: the host is retired and the stored mode
    // moves while the turn is still in flight.
    const busyId = 'ac169-fake-busy';
    seedSession(busyId, 'claude', context.directory);
    sessionsDb.setSessionLifecycleMode(busyId, 'resident');
    assert.equal((await startHost(context, busyId)).status, 200);
    context.driver.sink?.leaseAdded(busyId, { kind: 'turn', runId: 'turn-fake' });

    const mutableHost = liveHost(busyId);
    assert.ok(mutableHost, 'the fake busy host must be live');
    sessionHostManager.closeHost(mutableHost.hostId, 'mode-change');
    sessionsDb.setSessionLifecycleMode(busyId, 'per-run');
    assert.throws(
      () => assertBusySwitchStayedOffTurn(
        sessionsDb.getSessionLifecycleMode(busyId),
        context.driver.closeReasons.includes('mode-change'),
      ),
      /must not move while a turn is in flight/,
      'fake (d) must red the off-turn reading',
    );
    console.log('[lifecycle] fake (d): red');

    // (e) Start records the preference and starts nothing: the call count stays
    // where it was and no host appears in the projection. The reading is the
    // mutation's own contribution, so it does not depend on what the other four
    // arms happened to do with the same driver.
    const idleId = 'ac169-fake-start';
    seedSession(idleId, 'claude', context.directory);
    sessionsDb.setSessionLifecycleMode(idleId, 'resident');
    const startsBeforeFake = context.driver.startHostCalls;

    const nothingStarted = {
      startHostCalls: context.driver.startHostCalls - startsBeforeFake,
      hostInProjection: false,
      mode: null,
    };
    assert.throws(
      () => assertStartReallyStartedHost(
        nothingStarted.startHostCalls,
        nothingStarted.hostInProjection,
        nothingStarted.mode,
      ),
      /must have been asked to start a host/,
      'fake (e) must red the start reading',
    );
    console.log('[lifecycle] fake (e): red');
  });
});

test('claude declares the ten resident features, and the runtime mirror carries them', async () => {
  const claude = providerCapabilitiesService.getProviderCapabilities('claude');
  const features = claude.residentFeatures;
  assert.ok(features, 'a provider declaring resident must describe what its resident process can do');

  assert.deepEqual(
    Object.keys(features).sort(),
    [
      'addressable',
      'authoritativeLeases',
      'backgroundTasks',
      'cancelQueuedInput',
      'inputWhileBusy',
      'interruptKeepsProcess',
      'liveReconfigure',
      'remoteControl',
      'stopTask',
      'unattendedTurns',
    ],
    'every one of the ten fields must be stated',
  );

  // E1–E8 measured five of these; `stopTask` was measured later (2026-10-04,
  // against a real resident `query()` backed by a real CLI: the CLI answered
  // `task_notification{status:'stopped'}` ~1.0s after the call and the task's
  // own process was gone), so it states `true` too. `liveReconfigure` was
  // measured by AC-272's criterion
  // (`mcp-session-reconfigure.test.ts` in the mcp-gateway module), which
  // drives the resident driver with a scripted query and reads `query.setModel`
  // / `query.setPermissionMode` off the running process — so it is no longer an
  // empty list (`effort` stays out: it is a launch argument, answered
  // `next-turn`). `cancelQueuedInput` was measured by E9 (the newest queued
  // entry withdrawn, CLI answering `cancelled` for it) and by E10/U4
  // (`docs/proposals/claude-resident-sessions-experiments.md`, §E10: a queued
  // entry that was NOT the newest one, withdrawn the same way), so it states
  // `true` as well. The three with no measurement keep the conservative value.
  assert.equal(features.interruptKeepsProcess, true);
  assert.equal(features.unattendedTurns, true);
  assert.equal(features.addressable, true);
  assert.equal(features.inputWhileBusy, true);
  assert.equal(features.stopTask, true);
  assert.deepEqual(features.liveReconfigure, ['model', 'permissionMode']);
  assert.equal(features.cancelQueuedInput, true);
  assert.equal(features.authoritativeLeases, false);
  assert.equal(features.backgroundTasks, false);
  assert.equal(features.remoteControl, false);

  // The runtime mirror takes the same field, and takes it by value: the
  // declaration is copied, so a later reader cannot edit the stored matrix.
  providerCapabilitiesService.declareRuntimeProviderCapabilities({
    provider: 'lifecycle-mode-probe',
    lifecycleModes: ['per-run'],
    multiplexedHost: false,
    residentFeatures: { ...features },
  });
  const mirrored = providerCapabilitiesService.getRuntimeProviderCapabilities('lifecycle-mode-probe');
  assert.deepEqual(mirrored?.residentFeatures, features, 'the runtime mirror must carry every field');

  console.log(
    `[lifecycle] residentFeatures=${JSON.stringify(features)} ` +
      '(liveReconfigure=[model,permissionMode] measured by AC-272 against the resident setModel/setPermissionMode verbs)',
  );
});
