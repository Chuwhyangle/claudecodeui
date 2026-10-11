/**
 * Criterion for the host-listing endpoint (AC-156): `GET /api/session-hosts`.
 *
 * The endpoint is a read port over the host layer, and the two things that make
 * it worth a criterion are the two things a listing built from the run registry
 * would get wrong:
 *
 *   - a host exists *after* its run has ended. A Claude turn whose terminal
 *     `complete` frame has landed while the run's promise is still pending is
 *     `lingering` on the host layer and `isProcessing === false` in the run
 *     registry — so a listing that maps the registry cannot contain it, and the
 *     case below fails rather than passing by omission.
 *   - a closed host is readable for a while and then is not. The window is a
 *     read-time comparison against an injected clock, so both sides of it are
 *     reachable without waiting anything out.
 *
 * Everything below is driven through production seams: the runs are dispatched
 * through `createProviderRuntimeService` (the same entry point the chat handler
 * uses) and registered in the real `chatRunRegistry`, the app mounts the real
 * `authenticateToken`, and the listing is fetched over HTTP. Only the provider
 * runtimes are forged, because the criterion is about the host layer rather than
 * about any provider's CLI — the four runtime files are untouched.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
// Type-only, so these are erased before the module is evaluated: the manager's
// own call shapes, taken from this module's barrel rather than from its service
// file, which is the same contract every other consumer of the host layer uses.
import type {
  HostScheduler,
  SessionHostManager,
  SessionHostManagerOptions,
} from '@/modules/session-hosts/index.js';

/**
 * `auth.middleware.ts` resolves `JWT_SECRET` at module-load time and falls back
 * to `appConfigDb.getOrCreateJwtSecret()`, which would read and create the
 * developer's real `~/.cloudcli/auth.db`; `shared/utils.ts` likewise freezes
 * `IS_PLATFORM` (which would replace token checks with "the first database
 * user"). Both are evaluated on first import and static imports are hoisted
 * above this code, so the environment is set first and the aliased modules come
 * in dynamically — the same order `voice-config.routes.test.ts` established.
 */
const TEST_JWT_SECRET = 'session-hosts-routes-test-secret';
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase } = await import('@/modules/database/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/index.js');
const { createProviderRuntimeService, readClaudeSessionOccupancy } = await import('@/modules/providers/index.js');
const {
  CLOSED_HOST_RETENTION_MS,
  createSessionHostManager,
  createSessionHostsRouter,
} = await import('@/modules/session-hosts/index.js');
const { AppError, createCompleteMessage } = await import('@/shared/utils.js');

type ProviderRuntimeService = ReturnType<typeof createProviderRuntimeService>;

const USER_ID = 1;

/**
 * The keys one host element must carry, and nothing else.
 *
 * Sorted, and compared with `deepEqual` rather than checked one by one: a
 * projection that quietly grew an internal field (or dropped `closeReason`)
 * would still satisfy "the fields I asked for are there", and the client's
 * contract is the whole element, not a subset of it.
 *
 * `closeDetail` is part of the element for the same reason `peerName` is part of
 * the binding below: it is the half of "the process ended by itself" that says
 * WHICH ending (`oom` / `signal` / `error`), the manager holds it on a field a
 * client cannot reach, and the status bar's exited banner is the consumer. It is
 * null whenever `closeReason` is null or carries no detail, so the key is always
 * present and the element shape does not vary by state.
 */
const HOST_VIEW_KEYS = [
  'bindings',
  'closeDetail',
  'closeReason',
  'hostId',
  'mode',
  'pid',
  'provider',
  'startedAt',
  'state',
];

/**
 * The same contract one level down, for the sessions on a host.
 *
 * `peerName` is part of the element because it is the address the process
 * registered inside itself, and the listing is the only place a reader can
 * find it — the client's "copy the SendMessage address" affordance reads
 * nothing else. It is `null` for a binding that has no address, but the key
 * is always present, so the element shape does not vary by state.
 */
const BINDING_VIEW_KEYS = [
  'appSessionId',
  'lastActivityAt',
  'leases',
  'peerName',
  'providerSessionId',
  'state',
];

// ---------------------------
//----------------- FORGED RUNTIMES ------------
/**
 * A runtime the test owns: `run` never reaches a CLI, so the criterion controls
 * exactly when a turn ends and when its promise settles.
 */
function createRuntime(
  run: (
    command: string,
    options: Record<string, unknown>,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ) => Promise<unknown>,
): IProviderRuntime {
  return {
    run,
    abort() {
      return false;
    },
  };
}

/** The minimum `createProviderRuntimeService` needs; modelled on its own test. */
function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return { provider: id, installed: true, authenticated: true, method: 'test', details: {} };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

/**
 * Builds the dispatch side over a manager the test owns.
 *
 * The manager is passed in rather than left at the process-wide singleton for
 * one reason: the listing route has to be mounted over *this* manager, so that
 * "the host the dispatcher wrote" and "the host the endpoint reads" are the
 * same record. That seam is the manager dependency on
 * `provider-runtime.service.ts`.
 */
function createHostLayer(
  providers: IProvider[],
  options: SessionHostManagerOptions = {},
): { service: ProviderRuntimeService; sessionHostManager: SessionHostManager } {
  const sessionHostManager = createSessionHostManager(options);
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));

  const service = createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: () => null,
    async resolveResumeModel() {
      return undefined;
    },
    async getProviderModels() {
      return { OPTIONS: [], DEFAULT: 'fake-model' };
    },
    sessionHostManager,
  });

  return { service, sessionHostManager };
}

/** A runtime whose turn never ends and whose promise never settles. */
function inFlightRuntime(): IProviderRuntime {
  return createRuntime(async () => new Promise<never>(() => {}));
}

/**
 * A runtime that ends its turn immediately and then holds its promise open.
 *
 * That is Claude's held-stdin window in miniature: the `complete` frame has
 * gone through the writer (so the run registry — which flips the run to
 * `completed` on that frame — no longer considers the session busy), while the
 * host is still `lingering` because the run it is holding has not settled.
 */
function completedButHeldRuntime(provider: LLMProvider): IProviderRuntime {
  return createRuntime(async (_command, _options, writer) => {
    writer.send(createCompleteMessage({ provider, exitCode: 0 }));
    return new Promise<never>(() => {});
  });
}

/** A runtime whose turn ends and whose promise settles, closing the host. */
function settlingRuntime(provider: LLMProvider): IProviderRuntime {
  return createRuntime(async (_command, _options, writer) => {
    writer.send(createCompleteMessage({ provider, exitCode: 0 }));
    return undefined;
  });
}

// ---------------------------
//----------------- DISPATCH ------------
/**
 * Runs one turn the way the chat handler does: register the run, then dispatch
 * the runtime with the registry's writer.
 *
 * The registry is the production one, and it is what makes `isProcessing` a
 * real reading rather than a fixture's opinion.
 */
function dispatchTurn(
  service: ProviderRuntimeService,
  provider: LLMProvider,
  appSessionId: string,
): void {
  const run = chatRunRegistry.startRun({
    appSessionId,
    provider,
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(run, `the run registry refused to start a run for ${appSessionId}`);
  void service.run(provider, 'criterion turn', { sessionId: appSessionId }, run.writer);
}

/**
 * Lets every pending macrotask run.
 *
 * The manager decides `lingering` on a `setImmediate` gate, deliberately: the
 * state only exists when the gap between the terminal frame and the run's own
 * promise outlives the macrotask they were observed in. Two turns of the queue
 * put the reading past that gate without waiting on a clock.
 */
async function flushMacrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------
//----------------- HTTP HARNESS ------------
type HostViewReading = {
  hostId: string;
  provider: string;
  mode: string;
  state: string;
  pid: number | null;
  startedAt: number;
  closeReason: string | null;
  bindings: Array<{
    appSessionId: string;
    providerSessionId: string | null;
    state: string;
    leases: Array<{ kind: string }>;
    lastActivityAt: number;
  }>;
};

type ServerContext = {
  baseUrl: string;
  token: string;
};

/**
 * One row of the listing's `sessions` half, as it arrives on the wire.
 *
 * `occupiedBy` is written out as required — not `?` — because the contract this
 * criterion reads is that the key is on every row: a client branching on
 * "is this session occupied" has no third state to handle, and an omitted key
 * would make it read `undefined` where the server meant "nobody holds it".
 */
type SessionViewReading = {
  appSessionId: string;
  provider: string;
  lifecycleMode: string;
  running: boolean;
  reason: string | null;
  occupiedBy: { jobId: string; pid: number } | null;
};

type ListingReading = {
  status: number;
  contentType: string;
  body: Record<string, unknown>;
  hosts: HostViewReading[];
  sessions: SessionViewReading[];
};

/**
 * Mints the artifact the login endpoint hands the browser: an HS256 JWT signed
 * with the secret `auth.middleware.ts` was loaded with. Built by hand for the
 * reason the voice criterion gives — `jsonwebtoken` ships no type declarations.
 */
function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = createHmac('sha256', TEST_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function addUser(id: number, username: string): string {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
  return signToken({ userId: id, username });
}

/**
 * Serves the listing router over a throwaway database, exactly as
 * `server/index.ts` mounts it: behind the production `authenticateToken`, with
 * the production error middleware, and with the SPA fall-through after it.
 *
 * The fall-through is not scenery. A path with no API route above it answers
 * `200 text/html` in production, which is why the 401 assertion below is about
 * the mount and not about the status code — without a neighbour path that is
 * *not* mounted, "401" and "200" would both be readings of an app that answers
 * something to everything.
 */
async function withServer(
  sessionHostManager: SessionHostManager,
  run: (context: ServerContext) => Promise<void>,
  /**
   * The router's other seams, mounted the way `server/index.ts` mounts them.
   *
   * A parameter rather than a constant so the occupancy cases can wire the real
   * registry reader (pointed at a registry the criterion owns) into the real
   * route: the property under test is that the *route* asks it once per request,
   * which is not observable from a reader the criterion drives by hand.
   */
  routerOptions: Partial<Parameters<typeof createSessionHostsRouter>[0]> = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const token = addUser(USER_ID, 'tester');

  const app = express();
  app.use(express.json());
  app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({ sessionHostManager, ...routerOptions }));
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    response.status(500).json({ success: false });
  });
  app.use((_request: ExpressRequest, response: ExpressResponse) => {
    response.type('html').send('<!doctype html><html><body>spa</body></html>');
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Fetches a path and reads it as the listing endpoint's answer.
 *
 * `token: null` sends no Authorization header at all, which is what an
 * unauthenticated browser does; omitting the option uses the legitimate token.
 */
async function getListing(
  context: ServerContext,
  route = '/api/session-hosts',
  token: string | null | undefined = undefined,
): Promise<ListingReading> {
  const headers: Record<string, string> = {};
  const effectiveToken = token === undefined ? context.token : token;
  if (effectiveToken !== null) {
    headers.authorization = `Bearer ${effectiveToken}`;
  }

  const response = await fetch(`${context.baseUrl}${route}`, { headers });
  const body = (await response.json()) as Record<string, unknown>;
  const data = body.data as { hosts?: HostViewReading[]; sessions?: SessionViewReading[] } | undefined;

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body,
    hosts: data?.hosts ?? [],
    sessions: data?.sessions ?? [],
  };
}

/** The lease kinds on one binding, as one printable string. */
function leaseKinds(binding: HostViewReading['bindings'][number]): string {
  return binding.leases.map((lease) => lease.kind).join('+') || 'none';
}

/** One line per host, in the vocabulary the criterion asks to be printed. */
function describeHosts(hosts: HostViewReading[]): string[] {
  return hosts.flatMap((host) =>
    host.bindings.map(
      (binding) =>
        `provider=${host.provider} mode=${host.mode} state=${host.state} pid=${host.pid} ` +
        `closeReason=${host.closeReason} appSessionId=${binding.appSessionId} leases=${leaseKinds(binding)}`,
    ),
  );
}

function hostFor(hosts: HostViewReading[], provider: string): HostViewReading | undefined {
  return hosts.find((host) => host.provider === provider);
}

// ---------------------------
//----------------- (1) THE LISTING IS BEHIND AUTH ------------
test('AC2: the listing needs a token, and the harness can also answer 200 html', async () => {
  const { sessionHostManager } = createHostLayer([]);

  await withServer(sessionHostManager, async (context) => {
    const anonymous = await getListing(context, '/api/session-hosts', null);
    const code = (anonymous.body as { code?: unknown }).code;
    console.log(
      `no-credential=${anonymous.status} content-type=${anonymous.contentType} code=${String(code)}`,
    );
    assert.equal(anonymous.status, 401);
    assert.ok(anonymous.contentType.includes('application/json'));
    assert.equal(code, 'AUTH_TOKEN_INVALID');

    // The positive control: nothing is mounted at the neighbour path, so the
    // SPA fall-through answers — the same 200 a *mounted* listing would give if
    // the criterion trusted status codes.
    const unmounted = await fetch(`${context.baseUrl}/api/session-hosts-does-not-exist`);
    const unmountedType = unmounted.headers.get('content-type') ?? '';
    console.log(`unmounted-neighbour=${unmounted.status} content-type=${unmountedType}`);
    assert.equal(unmounted.status, 200);
    assert.ok(unmountedType.includes('text/html'));
  });
});

// ---------------------------
//----------------- (2) THE LISTING IS THE HOST LAYER ------------
test('AC3/AC4: two hosts — one run in flight and one whose turn ended while its run is still held', async () => {
  const codexSession = 'ac156-two-codex';
  const claudeSession = 'ac156-two-claude';
  const { service, sessionHostManager } = createHostLayer([
    createProvider('codex', inFlightRuntime()),
    createProvider('claude', completedButHeldRuntime('claude')),
  ]);

  dispatchTurn(service, 'codex', codexSession);
  dispatchTurn(service, 'claude', claudeSession);
  await flushMacrotasks();

  const codexProcessing = chatRunRegistry.isProcessing(codexSession);
  const claudeProcessing = chatRunRegistry.isProcessing(claudeSession);

  await withServer(sessionHostManager, async (context) => {
    const listing = await getListing(context);
    for (const line of describeHosts(listing.hosts)) {
      console.log(`host ${line}`);
    }
    console.log(
      `isProcessing codex=${codexProcessing} claude=${claudeProcessing} hosts=${listing.hosts.length}`,
    );

    // The lingering host is asserted first, on purpose: it is the entry a
    // listing built from the run registry cannot produce, so under that
    // implementation the failure has to land here and say which host is missing
    // rather than on a field that is absent because the entry is.
    const claudeHost = hostFor(listing.hosts, 'claude');
    assert.ok(
      claudeHost,
      `the listing is missing the Claude host: its turn wrote the terminal complete frame while its run promise is still pending, so the host layer holds it as lingering and the run registry no longer reports it (isProcessing=${claudeProcessing}) — hosts=${JSON.stringify(listing.hosts)}`,
    );
    assert.equal(claudeProcessing, false);
    assert.equal(claudeHost.state, 'lingering');
    assert.equal(claudeHost.mode, 'per-run');
    assert.equal(claudeHost.closeReason, null);
    assert.equal(claudeHost.pid, null);
    assert.deepEqual(
      claudeHost.bindings.map((binding) => binding.appSessionId),
      [claudeSession],
    );
    assert.deepEqual(leaseKinds(claudeHost.bindings[0]), 'none');

    const codexHost = hostFor(listing.hosts, 'codex');
    assert.ok(codexHost, 'the listing is missing the codex host whose run is in flight');
    assert.equal(codexProcessing, true);
    assert.equal(codexHost.state, 'busy');
    assert.equal(codexHost.mode, 'per-run');
    assert.equal(codexHost.pid, null);

    const codexBinding = codexHost.bindings.find(
      (binding) => binding.appSessionId === codexSession,
    );
    assert.ok(codexBinding, 'the codex host is missing its binding');
    assert.equal(codexBinding.state, 'busy');
    assert.deepEqual(leaseKinds(codexBinding), 'turn');

    // Two hosts, not three and not one: both dispatches registered exactly one
    // host each, and nothing was opened for a session that never ran.
    assert.equal(listing.hosts.length, 2);
  });
});

// ---------------------------
//----------------- (3) THE RETENTION WINDOW ------------
test('AC5: a closed host is readable inside the retention window and gone after it', async () => {
  const appSessionId = 'ac156-window';
  // The clock and the deadline seam are both injected: the window is reached by
  // moving the clock, never by waiting, and the quiet ceiling is stubbed out so
  // the only close in this case is the turn's own.
  let current = 1_700_000_000_000;
  const scheduler: HostScheduler = { schedule: () => () => {} };
  const { service, sessionHostManager } = createHostLayer(
    [createProvider('claude', settlingRuntime('claude'))],
    { now: () => current, scheduler },
  );

  dispatchTurn(service, 'claude', appSessionId);
  await flushMacrotasks();

  await withServer(sessionHostManager, async (context) => {
    const inWindow = await getListing(context);
    const closedHost = hostFor(inWindow.hosts, 'claude');
    const inWindowReading = `in-window=${closedHost ? 1 : 0} closeReason=${String(closedHost?.closeReason)} ` +
      `hosts=${inWindow.hosts.length}`;
    console.log(inWindowReading);
    assert.ok(
      closedHost,
      `the just-closed host is missing from the listing inside its retention window (hosts=${inWindow.hosts.length})`,
    );
    assert.equal(closedHost.state, 'closed');
    assert.equal(closedHost.closeReason, 'turn-complete');

    // The far edge of the window. The clock moves by exactly the retention
    // period, and since the window is half-open the host is gone at it — so
    // this reading distinguishes "expired" from "still there by a millisecond".
    current += CLOSED_HOST_RETENTION_MS;
    const afterWindow = await getListing(context);
    console.log(`after-window=${afterWindow.hosts.length} advance=${CLOSED_HOST_RETENTION_MS}`);
    assert.equal(afterWindow.hosts.length, 0);

    // Positive control for the disappearance: the *same route* was still
    // answering a moment earlier, so the empty list is the window closing and
    // not a listing that never worked.
    assert.equal(inWindow.status, 200);
    assert.equal(afterWindow.status, 200);
  });
});

// ---------------------------
//----------------- (4) THE SHAPE ON THE WIRE ------------
test('AC6: the listing is JSON, enveloped, and every host carries exactly the declared keys', async () => {
  const appSessionId = 'ac156-shape';
  const { service, sessionHostManager } = createHostLayer([
    createProvider('codex', inFlightRuntime()),
  ]);

  dispatchTurn(service, 'codex', appSessionId);
  await flushMacrotasks();

  await withServer(sessionHostManager, async (context) => {
    const listing = await getListing(context);
    console.log(
      `content-type=${listing.contentType} status=${listing.status} success=${String(listing.body.success)} ` +
        `hosts-is-array=${Array.isArray((listing.body.data as { hosts?: unknown }).hosts)} hosts=${listing.hosts.length}`,
    );

    assert.ok(listing.contentType.includes('application/json'));
    assert.equal(listing.body.success, true);
    assert.ok(Array.isArray((listing.body.data as { hosts?: unknown }).hosts));

    assert.ok(listing.hosts.length > 0, 'the shape is read off an empty list otherwise');
    for (const host of listing.hosts) {
      console.log(`keys=${Object.keys(host).sort().join(',')}`);
      assert.deepEqual(Object.keys(host).sort(), HOST_VIEW_KEYS);
      for (const binding of host.bindings) {
        assert.deepEqual(Object.keys(binding).sort(), BINDING_VIEW_KEYS);
      }
    }
  });
});

// ---------------------------
//----------------- (5) THE NEGATIVE CONTROL ------------
test('AC7: a manager that never dispatched a turn lists nothing', async () => {
  const { sessionHostManager } = createHostLayer([]);

  await withServer(sessionHostManager, async (context) => {
    const listing = await getListing(context);
    console.log(`empty-hosts=${listing.hosts.length}`);
    assert.equal(listing.status, 200);
    assert.equal(listing.body.success, true);
    assert.equal(listing.hosts.length, 0);
  });
});

// ---------------------------
//----------------- (6) OCCUPANCY ------------
/**
 * The session row's own contract on the wire.
 *
 * Sorted and compared as a whole, like `HOST_VIEW_KEYS`: the reading this
 * criterion has to make is "every row carries `occupiedBy`", and a subset check
 * would be satisfied by a projection that carried it on the occupied rows only.
 */
const SESSION_VIEW_KEYS = [
  'appSessionId',
  'lifecycleMode',
  'occupiedBy',
  'provider',
  'reason',
  'running',
];

/** The app session ids the occupancy cases list, and what each one is there to prove. */
const OCCUPIED_APP_SESSION = 'occupancy-held';
const FREE_APP_SESSION = 'occupancy-free';
const CODEX_APP_SESSION = 'occupancy-codex';
const UNNAMED_APP_SESSION = 'occupancy-unnamed';

/** The provider's own ids, which is the only key the CLI's registry knows a conversation by. */
const OCCUPIED_PROVIDER_SESSION = '11111111-2222-3333-4444-555555555555';
const FREE_PROVIDER_SESSION = '99999999-8888-7777-6666-555555555555';

/**
 * A registry directory this criterion owns, plus a live process for its rows to
 * name.
 *
 * The reader under test is the shipping one — `readClaudeSessionOccupancy` —
 * with two things swapped: the directory it reads (the developer's real
 * `~/.claude` is nobody's fixture) and the directory lister, wrapped so the
 * criterion can count the scans. Everything between those two — the row
 * judgement, the liveness probe, the projection to `{jobId, pid}` — is the code
 * the server runs.
 */
async function withRegistry(
  run: (input: {
    configDir: string;
    livePid: number;
    write: (name: string, row: unknown) => Promise<void>;
    /** How many times the route has listed the registry directory so far. */
    scans: () => number;
    /** The reader the route is mounted over: the real one, counting its scans. */
    readOccupancy: () => Map<string, { jobId: string; pid: number }>;
  }) => Promise<void>,
): Promise<void> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-occupancy-'));
  await mkdir(path.join(configDir, 'sessions'));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  let scans = 0;
  try {
    const livePid = child.pid as number;
    await run({
      configDir,
      livePid,
      scans: () => scans,
      write: (name, row) =>
        writeFile(
          path.join(configDir, 'sessions', name),
          typeof row === 'string' ? row : JSON.stringify(row),
        ),
      readOccupancy: () =>
        readClaudeSessionOccupancy(configDir, (directory: string) => {
          scans += 1;
          return readdirSync(directory);
        }),
    });
  } finally {
    child.kill('SIGKILL');
    await rm(configDir, { recursive: true, force: true });
  }
}

/** The `procStart` of a live process, which is what tells its pid from a recycled one. */
async function procStartOf(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  // The command name is parenthesised and may contain spaces, so the fields are
  // counted from the last `)` — the same rule the reader itself uses.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/**
 * The four rows the occupancy cases list, as the composition root would build
 * them: an app session id for the client, a provider id for the registry.
 *
 * The codex row deliberately carries the *occupied* provider session id. Session
 * ids are UUIDs and a collision is not plausible in production, but the gate that
 * keeps a codex row out of a Claude registry read is a rule, and a rule with no
 * case it can fail is not being tested: this is the row that goes non-null if the
 * projection ever drops its `provider === 'claude'` guard.
 */
const occupancySessions = () => [
  {
    appSessionId: OCCUPIED_APP_SESSION,
    provider: 'claude' as const,
    mode: 'resident' as const,
    providerSessionId: OCCUPIED_PROVIDER_SESSION,
  },
  {
    appSessionId: FREE_APP_SESSION,
    provider: 'claude' as const,
    mode: 'per-run' as const,
    providerSessionId: FREE_PROVIDER_SESSION,
  },
  {
    appSessionId: CODEX_APP_SESSION,
    provider: 'codex' as const,
    mode: 'per-run' as const,
    providerSessionId: OCCUPIED_PROVIDER_SESSION,
  },
  {
    appSessionId: UNNAMED_APP_SESSION,
    provider: 'claude' as const,
    mode: 'per-run' as const,
    providerSessionId: null,
  },
];

const sessionRow = (listing: ListingReading, appSessionId: string): SessionViewReading => {
  const row = listing.sessions.find((session) => session.appSessionId === appSessionId);
  assert.ok(row, `the listing must report ${appSessionId}`);
  return row;
};

test('AC1/AC2: every session row carries occupiedBy, and it is the holder or null', async () => {
  const { sessionHostManager } = createHostLayer([]);

  await withRegistry(async ({ livePid, write, readOccupancy }) => {
    const procStart = await procStartOf(livePid);
    // The holder, and the negative control beside it: the free conversation has a
    // row too, but the pid in it is not the process that wrote it.
    await write('held.json', {
      pid: livePid,
      sessionId: OCCUPIED_PROVIDER_SESSION,
      kind: 'bg',
      jobId: '04fda72d',
      procStart,
      name: 'nightly sweep',
    });
    await write('free.json', {
      pid: livePid,
      sessionId: FREE_PROVIDER_SESSION,
      kind: 'bg',
      jobId: 'ffffffff',
      procStart: `${procStart}0`,
    });

    await withServer(
      sessionHostManager,
      async (context) => {
        const listing = await getListing(context);
        assert.equal(listing.status, 200);
        assert.equal(
          listing.sessions.length,
          4,
          'the four rows below are the whole reading; an empty list would make every '
            + 'occupancy assertion below vacuous',
        );

        for (const row of listing.sessions) {
          assert.deepEqual(
            Object.keys(row).sort(),
            SESSION_VIEW_KEYS,
            `${row.appSessionId}: occupiedBy is on every row, whatever the row is`,
          );
        }

        const held = sessionRow(listing, OCCUPIED_APP_SESSION);
        const free = sessionRow(listing, FREE_APP_SESSION);
        console.log(
          `held=${JSON.stringify(held.occupiedBy)} free=${JSON.stringify(free.occupiedBy)} `
            + `codex=${JSON.stringify(sessionRow(listing, CODEX_APP_SESSION).occupiedBy)} `
            + `unnamed=${JSON.stringify(sessionRow(listing, UNNAMED_APP_SESSION).occupiedBy)}`,
        );

        assert.deepEqual(
          held.occupiedBy,
          { jobId: '04fda72d', pid: livePid },
          'the held conversation names the live background job, and nothing else',
        );
        // The pair in the same response, so "occupied" cannot be a constant: one
        // row answers with a holder and the row beside it answers null.
        assert.equal(
          free.occupiedBy,
          null,
          'a registry row whose pid is no longer the process that wrote it is not a holder',
        );
        assert.equal(
          sessionRow(listing, CODEX_APP_SESSION).occupiedBy,
          null,
          'the registry is Claude\'s: a codex session is not occupied by a Claude job, even when the '
            + 'provider id it happens to carry is the one a job holds',
        );
        assert.equal(
          sessionRow(listing, UNNAMED_APP_SESSION).occupiedBy,
          null,
          'a session the provider has not named yet has no conversation for a job to hold',
        );
      },
      { listSessions: occupancySessions, readSessionOccupancy: readOccupancy },
    );
  });
});

test('AC3: one GET scans the registry directory once, and the next GET re-reads it', async () => {
  const { sessionHostManager } = createHostLayer([]);

  await withRegistry(async ({ livePid, write, scans, readOccupancy }) => {
    const procStart = await procStartOf(livePid);
    const held = {
      pid: livePid,
      sessionId: OCCUPIED_PROVIDER_SESSION,
      kind: 'bg',
      jobId: '04fda72d',
      procStart,
    };
    await write('held.json', held);

    // Filler rows, so a per-session scan would have to show up: the listing below
    // reports four sessions and the registry holds five rows.
    for (const suffix of ['a', 'b', 'c', 'd']) {
      await write(`filler-${suffix}.json`, { ...held, sessionId: `filler-${suffix}`, jobId: `job-${suffix}` });
    }

    await withServer(
      sessionHostManager,
      async (context) => {
        const before = scans();
        const first = await getListing(context);
        const afterFirst = scans();
        console.log(
          `first-scans=${afterFirst - before} sessions=${first.sessions.length} `
            + `occupied=${JSON.stringify(sessionRow(first, OCCUPIED_APP_SESSION).occupiedBy)}`,
        );

        assert.equal(
          afterFirst - before,
          1,
          'one request lists the registry directory exactly once, however many sessions it reports',
        );
        assert.deepEqual(
          sessionRow(first, OCCUPIED_APP_SESSION).occupiedBy,
          { jobId: '04fda72d', pid: livePid },
          'the scan that was counted is the scan that produced this row',
        );

        // A second request scans again rather than answering from a cache: the
        // count moves by exactly one, never by zero.
        const second = await getListing(context);
        const afterSecond = scans();
        assert.equal(afterSecond - afterFirst, 1, 'every request re-reads; nothing is memoised');
        assert.deepEqual(sessionRow(second, OCCUPIED_APP_SESSION).occupiedBy, { jobId: '04fda72d', pid: livePid });

        // The holder lets go — `claude stop <jobId>` is the real version of this
        // edit, and what the layer above sees is the same: the row stops being a
        // live background job holding this conversation.
        await write('held.json', { ...held, pid: 2 ** 22 + 12345 });
        const third = await getListing(context);
        const afterThird = scans();
        console.log(
          `after-release-scans=${afterThird - afterSecond} `
            + `occupied=${JSON.stringify(sessionRow(third, OCCUPIED_APP_SESSION).occupiedBy)}`,
        );

        assert.equal(afterThird - afterSecond, 1, 'the release is read by a fresh scan, not by a cache');
        assert.equal(
          sessionRow(third, OCCUPIED_APP_SESSION).occupiedBy,
          null,
          'the next poll after the holder went away reports the conversation as free again',
        );
      },
      { listSessions: occupancySessions, readSessionOccupancy: readOccupancy },
    );
  });
});

// ---------------------------
//----------------- (5) THE LISTING'S TWO NARROWER READS ------------
/**
 * The full listing carries one row per stored session — thousands on a long-lived
 * install, ~1MB of JSON — and every open browser re-reads it on every
 * `hosts_changed` frame. Two narrower reads exist so a client asks for what it
 * uses:
 *
 *   - `GET /api/session-hosts?scope=active` keeps the listing's shape and drops
 *     the rows that say nothing a client does not already default to: a per-run
 *     session with no live host and no occupant. A missing row IS that reading
 *     (the client's own default), so nothing is lost.
 *   - `GET /api/session-hosts/:sessionId` answers one session: its row and the
 *     hosts holding it, so a caller that wants one fact never receives 7000.
 *
 * The unscoped listing is unchanged, which AC1/AC2 above keep pinned.
 */
const sessionByAppId = (appSessionId: string) =>
  occupancySessions().find((row) => row.appSessionId === appSessionId) ?? null;

test('SCOPE1: scope=active drops idle per-run rows and keeps resident, occupied and live-hosted ones', async () => {
  const { service, sessionHostManager } = createHostLayer([createProvider('claude', inFlightRuntime())]);
  // FREE is a per-run session with nothing to report — until a host holds it.
  dispatchTurn(service, 'claude', FREE_APP_SESSION);
  await flushMacrotasks();

  await withRegistry(async ({ livePid, write, readOccupancy }) => {
    const procStart = await procStartOf(livePid);
    await write('held.json', {
      pid: livePid,
      sessionId: OCCUPIED_PROVIDER_SESSION,
      kind: 'bg',
      jobId: '04fda72d',
      procStart,
    });

    await withServer(
      sessionHostManager,
      async (context) => {
        const full = await getListing(context);
        const scoped = await getListing(context, '/api/session-hosts?scope=active');
        console.log(
          `full=${full.sessions.length} scoped=${scoped.sessions.length} `
            + `kept=${scoped.sessions.map((row) => row.appSessionId).sort().join(',')}`,
        );

        assert.equal(full.sessions.length, 4, 'the unscoped listing still reports every stored session');
        assert.equal(scoped.status, 200);
        assert.deepEqual(
          scoped.sessions.map((row) => row.appSessionId).sort(),
          [FREE_APP_SESSION, OCCUPIED_APP_SESSION].sort(),
          'kept: the occupied (resident) row and the per-run row a live host holds; '
            + 'dropped: the idle codex row and the unnamed per-run row',
        );
        assert.equal(sessionRow(scoped, FREE_APP_SESSION).running, true);
        assert.deepEqual(sessionRow(scoped, OCCUPIED_APP_SESSION).occupiedBy, { jobId: '04fda72d', pid: livePid });
        for (const row of scoped.sessions) {
          assert.deepEqual(Object.keys(row).sort(), SESSION_VIEW_KEYS, 'a kept row has the same shape as in the full listing');
          assert.deepEqual(row, sessionRow(full, row.appSessionId), 'a kept row is byte-for-byte the full listing\'s row');
        }
        assert.deepEqual(scoped.hosts, full.hosts, 'the hosts half is untouched by the scope');

        // An unknown scope fails open to the complete listing rather than hiding rows.
        const unknown = await getListing(context, '/api/session-hosts?scope=everything-else');
        assert.equal(unknown.sessions.length, 4);
      },
      { listSessions: occupancySessions, readSessionOccupancy: readOccupancy },
    );
  });
});

test('SCOPE2: scope=active keeps a resident session nobody has started — "should be running and is not"', async () => {
  const { sessionHostManager } = createHostLayer([]);
  await withServer(
    sessionHostManager,
    async (context) => {
      const scoped = await getListing(context, '/api/session-hosts?scope=active');
      assert.deepEqual(scoped.sessions.map((row) => row.appSessionId), [OCCUPIED_APP_SESSION]);
      const row = sessionRow(scoped, OCCUPIED_APP_SESSION);
      assert.equal(row.lifecycleMode, 'resident');
      assert.equal(row.running, false);
      assert.ok(row.reason, 'the restart-dropped reason is the finding this row exists to carry');
    },
    { listSessions: occupancySessions, readSessionOccupancy: () => new Map() },
  );
});

test('SCOPE3: GET /:sessionId answers one row and the hosts holding it, in the listing\'s own shape', async () => {
  const { service, sessionHostManager } = createHostLayer([createProvider('codex', inFlightRuntime())]);
  // A row SCOPE1 does not use: the run registry is process-wide and an in-flight run
  // keeps its session id until the process ends.
  dispatchTurn(service, 'codex', CODEX_APP_SESSION);
  await flushMacrotasks();

  await withRegistry(async ({ livePid, write, scans, readOccupancy }) => {
    const procStart = await procStartOf(livePid);
    await write('held.json', {
      pid: livePid,
      sessionId: OCCUPIED_PROVIDER_SESSION,
      kind: 'bg',
      jobId: '04fda72d',
      procStart,
    });

    await withServer(
      sessionHostManager,
      async (context) => {
        const live = await getListing(context, `/api/session-hosts/${CODEX_APP_SESSION}`);
        assert.equal(live.status, 200);
        assert.equal(live.contentType.includes('application/json'), true);
        assert.equal(live.body.success, true);
        assert.deepEqual(live.sessions.map((row) => row.appSessionId), [CODEX_APP_SESSION]);
        assert.equal(live.sessions[0].running, true);
        assert.deepEqual(Object.keys(live.sessions[0]).sort(), SESSION_VIEW_KEYS);
        assert.equal(live.hosts.length, 1, 'the host holding this session is in the answer');
        assert.deepEqual(
          live.hosts[0].bindings.map((binding) => binding.appSessionId),
          [CODEX_APP_SESSION],
        );
        assert.deepEqual(Object.keys(live.hosts[0]).sort(), HOST_VIEW_KEYS);

        const before = scans();
        const held = await getListing(context, `/api/session-hosts/${OCCUPIED_APP_SESSION}`);
        assert.equal(scans() - before, 1, 'one single-row read scans the registry directory once');
        assert.deepEqual(held.sessions.map((row) => row.appSessionId), [OCCUPIED_APP_SESSION]);
        assert.deepEqual(held.sessions[0].occupiedBy, { jobId: '04fda72d', pid: livePid });
        assert.deepEqual(held.hosts, [], 'no host holds this session, so none is reported');

        // An idle per-run row is returned when it is asked for by id: the caller named it.
        const idle = await getListing(context, `/api/session-hosts/${UNNAMED_APP_SESSION}`);
        assert.deepEqual(idle.sessions.map((row) => row.appSessionId), [UNNAMED_APP_SESSION]);
        assert.equal(idle.sessions[0].lifecycleMode, 'per-run');
        assert.equal(idle.sessions[0].running, false);
      },
      { readSessionState: sessionByAppId, readSessionOccupancy: readOccupancy },
    );
  });
});

test('SCOPE4: GET /:sessionId for a session no row knows is an empty answer, not a 404; and it is authenticated', async () => {
  const { sessionHostManager } = createHostLayer([]);
  await withServer(
    sessionHostManager,
    async (context) => {
      const unknown = await getListing(context, '/api/session-hosts/no-such-session');
      // The list reports a brand-new session as absent and the client defaults it to
      // per-run; the single read keeps that reading rather than inventing a failure.
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.sessions, []);
      assert.deepEqual(unknown.hosts, []);

      const anonymous = await getListing(context, `/api/session-hosts/${OCCUPIED_APP_SESSION}`, null);
      assert.equal(anonymous.status, 401);
    },
    { readSessionState: sessionByAppId, readSessionOccupancy: () => new Map() },
  );
});
