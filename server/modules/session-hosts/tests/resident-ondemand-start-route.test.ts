/**
 * Criterion for the on-demand start route (AC2), and for the close route's lease
 * gate (AC3/AC4) — the same mounted router, read through its other verb.
 *
 * The subject is one HTTP verb — `POST /api/session-hosts/:sessionId/start` —
 * reached over the real express app, the real token middleware, the real
 * session rows and the real host manager, and asked to start a resident session
 * that has never run. The claim: it answers **200** and the session then reads
 * `running: true` in `GET /api/session-hosts`, where the old entry answered 409
 * or 500 and left nothing running.
 *
 * What is *not* real, and why — two substitutions, both of them forced by where
 * this file is allowed to live:
 *
 *  - **The driver.** The on-demand verb belongs to the providers module, and a
 *    criterion in `session-hosts` may not reach into it: `boundaries/dependencies`
 *    reports every import of `list/claude/claude-host-driver.provider.ts` from
 *    outside `server/modules/providers` as an error, and the providers barrel does
 *    not re-export the driver. The production driver's own verb, its two old
 *    refusals and its launch gate are therefore measured where they live, by
 *    `server/modules/providers/tests/claude-resident-ondemand-start.test.ts`. What
 *    the stand-in below keeps is the one property the route's correctness *and*
 *    this criterion's falsification rest on: a resident host is started by a
 *    launch, not by a record. Its `startHost` adopts a host only when its own
 *    `startResidentSession` asked for one, and refuses any other way — which is
 *    the rule `claude-host-driver.provider.ts` enforces by throwing "was opened
 *    without a process", measured verbatim in AC1's criterion.
 *  - **The process.** Nothing is spawned at all: the stand-in's verb opens a host
 *    in the real manager with a literal pid. A criterion about an HTTP status has
 *    no business needing a model.
 *
 * Everything above those two is production: the mounted router, the real token
 * middleware, `providerRuntimeService.startResidentSession` (the seam the route is
 * wired to, exactly as `server/index.ts` wires it), the provider registry that
 * seam resolves the driver through, the real host manager whose record the listing
 * projection reads, and the option bag the providers layer assembles from the
 * seeded session row — the last of which this criterion *reads back* rather than
 * assumes, by capturing the launch the stand-in is handed.
 *
 * What is proven, in the order the criterion reads it:
 *
 *   (1) the start: 200, the session's own row in the listing projection reading
 *       `running: true` with no `reason`, and a live host in the manager holding
 *       the session with the injected pid.
 *   (2) the launch really was assembled by the providers layer: the driver was
 *       handed a bag whose `cwd` is the session row's project path. Without this
 *       the 200 would also be satisfied by a route that started *something*, and
 *       a process opened in the wrong directory is a worse outcome than none.
 *   (3) the positive control on the route's own idempotence: a second POST is a
 *       200 answering with the same host, and the seam is *not* asked again —
 *       read as a call count and a spawn count, so "already running is a
 *       success" is measured rather than inferred from the first 200.
 *   (4) the three refusals, each re-run beside the 200 with mutually distinct
 *       codes: a session stored `per-run` ⇒ 409 `LIFECYCLE_MODE_NOT_RESIDENT`, a
 *       resident session whose provider mounts no driver ⇒ 409
 *       `LIFECYCLE_MODE_HOST_UNAVAILABLE`, an unknown session ⇒ 404
 *       `SESSION_NOT_FOUND`.
 *
 * The close route is read on the same harness (AC3/AC4). It shares the MCP
 * gateway's lease judgement, so what is measured is not that a second predicate
 * exists but that this transport applies the one: a resident host given a real
 * `cron` lease through the manager's own port refuses a bodiless close with 409
 * `SESSION_HAS_ACTIVE_LEASES` and stays running, refuses `force: false` and the
 * string `"true"` the same way (the `!== true` reading), and closes — listing
 * `running: false` — only under a literal `force: true`. A host holding only the
 * resident policy closes with no force, the positive control on the gate's
 * subject.
 *
 * Out of scope, deliberately: the fallback for a driver that declares no
 * on-demand verb. That path belongs to the lifecycle criterion (AC-169), whose
 * fake driver has no such verb and whose `/start` arm asserts 200 through
 * `bindSession`; restating it here would be a second copy of one reading, and
 * the copy would be the one that could drift.
 *
 * Falsification (run and recorded in the completion record): with the route's
 * on-demand branch removed — the entry back to `bindSession`, which is what the
 * route did before — arm (1) reds on the status. `bindSession` reaches `openHost`,
 * which asks the driver to start a host nobody launched; the stand-in refuses
 * exactly as the production driver does, the manager reports the host exited, and
 * the throw surfaces as 500 rather than 200. With any other claude host already
 * alive the same entry refuses `host-not-multiplexed` instead — the other reading
 * the fix exists to remove, measured end-to-end in AC1.
 *
 * `JWT_SECRET` must be set before the aliased modules are evaluated, because
 * `auth.middleware.ts` resolves the secret at module-load time; static imports
 * are hoisted above that, so the environment is set first and the rest arrives
 * dynamically — the order `lifecycle-mode.test.ts` established.
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

import type { IProviderHostDriver } from '@/shared/interfaces.js';
import type {
  HostMode,
  HostResidentLaunch,
  HostResidentStartResult,
  LLMProvider,
  ProcessHost,
} from '@/shared/types.js';

const TEST_JWT_SECRET = 'ondemand-start-route-test-secret';
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');
const { providerRegistry, providerRuntimeService, sessionsService } = await import('@/modules/providers/index.js');
const {
  LIFECYCLE_MODE_ERROR_CODES,
  createSessionHostsRouter,
  sessionHostManager,
} = await import('@/modules/session-hosts/index.js');
const { AppError } = await import('@/shared/utils.js');

const USER_ID = 1;
/** The pid the injected process factory reports. */
const FAKE_PID = 4242;
/** A claude session stored `resident`: the arm that must start. */
const SESSION_RESIDENT = 'ondemand-route-resident';
/** A claude session left at the default mode: the arm that must be refused. */
const SESSION_PER_RUN = 'ondemand-route-per-run';
/** A resident session under a provider that mounts no driver. */
const SESSION_NO_DRIVER = 'ondemand-route-no-driver';
/** A session id with no row at all. */
const SESSION_UNKNOWN = 'ondemand-route-unknown';
/** A resident claude session whose host is given a blocking (`cron`) lease. */
const SESSION_LEASED = 'ondemand-route-leased';
/** A resident claude session holding only the resident policy: the close control. */
const SESSION_PLAIN = 'ondemand-route-plain';

type OnDemandDriver = IProviderHostDriver & {
  /** Every launch bag this driver's on-demand verb was handed, in order. */
  launches: HostResidentLaunch[];
  /** How many hosts it has actually started. */
  spawns: () => number;
};

/**
 * One line of this criterion's readings, prefixed so a reader can find them.
 *
 * `console.log` rather than a diagnostic because the readings *are* the
 * evidence: an arm that asserts without printing what it saw leaves a reader
 * unable to tell a passing assertion from a vacuous one.
 */
function say(line: string): void {
  console.log(`ondemand-route ${line}`);
}

// ---------------------------
//----------------- THE STAND-IN DRIVER ------------
/**
 * The claude provider's on-demand driver, as this module is allowed to write it.
 *
 * See the header for why the production class cannot be imported here. What makes
 * this a stand-in for the *process* rather than for the manager's bookkeeping is
 * the pair of rules below:
 *
 *  - the verb opens a host in the real manager, so the host the listing reads is a
 *    real record with a real binding and a real pid;
 *  - `startHost` adopts a host only while a launch is pending — the launch its own
 *    verb set. Any other route to `startHost` is refused, which is what the
 *    production driver does and what makes the falsification arm below red.
 *
 * The remaining members are the no-op shape `lifecycle-mode.test.ts` mounts for
 * the same reason: from the manager's side, a driver that starts nothing and a
 * driver that starts a process are the same.
 */
function createOnDemandDriver(manager: typeof sessionHostManager): OnDemandDriver {
  let pendingLaunch = false;
  let spawns = 0;

  const driver: OnDemandDriver = {
    launches: [],
    spawns: () => spawns,
    multiplexedHost: false,

    async startResidentSession(
      appSessionId: string,
      launch: HostResidentLaunch,
    ): Promise<HostResidentStartResult> {
      driver.launches.push(launch);
      pendingLaunch = true;
      try {
        const host = await manager.openHost({
          provider: 'claude',
          mode: 'resident',
          appSessionId,
          driver,
          pid: FAKE_PID,
        });
        return { hostId: host.hostId, pid: host.pid };
      } finally {
        pendingLaunch = false;
      }
    },

    async startHost(host: ProcessHost): Promise<ProcessHost> {
      if (!pendingLaunch) {
        throw new Error(
          `Resident host ${host.hostId} was opened without a process; ` +
          'a resident host is started by the driver\'s run entry.',
        );
      }
      spawns += 1;
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
    async closeHost(): Promise<void> {},
  };

  return driver;
}

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
  /** The driver mounted on the claude provider, whose readings the arms read. */
  driver: OnDemandDriver;
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

/** One session row, seeded the way the gateway seeds one. */
function seedSession(sessionId: string, provider: LLMProvider, directory: string, mode: HostMode): void {
  const now = new Date().toISOString();
  sessionsDb.createSession(sessionId, provider, directory, `On-demand ${sessionId}`, now, now, null);
  sessionsDb.setSessionLifecycleMode(sessionId, mode);
}

/**
 * Serves the router over a throwaway database, mounted as `server/index.ts`
 * mounts it: the real token middleware in front, the production error
 * middleware after, the real session readers behind, and the seam wired to the
 * real `providerRuntimeService`.
 *
 * The one substitution is the provider's `hostDriver`, swapped for this
 * criterion's instance so the resolved provider is the production one and the
 * process is not. Everything else about the wiring — including the fact that the
 * driver lookup goes through the registry rather than a literal — is the
 * composition root's own.
 */
async function withHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ondemand-start-route-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const token = addUser(USER_ID, 'tester');
  const driver = createOnDemandDriver(sessionHostManager);

  const claude = providerRegistry.resolveProvider('claude') as unknown as { hostDriver: unknown };
  const realHostDriver = claude.hostDriver;
  Object.defineProperty(claude, 'hostDriver', {
    configurable: true,
    writable: true,
    value: driver,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({
    sessionHostManager,
    readSession: (sessionId) => sessionsService.readSessionLifecycle(sessionId),
    resolveHostDriver: (provider) => (provider === 'claude' ? driver : null),
    startResidentSession: (provider, sessionId) =>
      providerRuntimeService.startResidentSession(provider, sessionId),
    // The listing's second half, wired the way the composition root wires it:
    // every stored session, with its own row's mode.
    listSessions: () => sessionsDb.getAllSessions().map((session) => ({
      appSessionId: session.session_id,
      provider: session.provider as LLMProvider,
      mode: (session.lifecycle_mode ?? 'per-run') as HostMode,
    })),
  }));
  // The composition root's error middleware, mirrored answer for answer
  // (`server/index.ts`): a typed refusal keeps its code and sentence, and
  // anything else is a 500 whose cause is logged rather than published. The
  // `console.error` matters here: an untyped throw is exactly what the
  // falsification arm produces, and the logged cause is what makes that red
  // attributable instead of a bare number.
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }

    console.error(error);

    response.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
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
    // Every host this case opened is closed here: the manager is a process-wide
    // singleton, so a host left behind would be state the next case reads.
    await sessionHostManager.shutdown({ timeoutMs: 0 });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    Object.defineProperty(claude, 'hostDriver', {
      configurable: true,
      writable: true,
      value: realHostDriver,
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

function authHeaders(context: Harness): Record<string, string> {
  return { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' };
}

async function startHost(context: Harness, sessionId: string): Promise<ApiReading> {
  return readApi(await fetch(`${context.baseUrl}/api/session-hosts/${sessionId}/start`, {
    method: 'POST',
    headers: authHeaders(context),
  }));
}

/**
 * Asks the close route to close one session, optionally with a JSON body.
 *
 * A body is attached only when the arm supplies one, so the "no `force` field at
 * all" reading (AC3, and AC4's *absent* form) is a request that literally carries
 * no body — not one carrying `{"force":false}`, which the route's `!== true`
 * reading would refuse for the same reason but which would not be the reading the
 * criterion claims to take.
 */
async function closeHost(
  context: Harness,
  sessionId: string,
  body?: unknown,
): Promise<ApiReading> {
  return readApi(await fetch(`${context.baseUrl}/api/session-hosts/${sessionId}/close`, {
    method: 'POST',
    headers: authHeaders(context),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

/**
 * Puts one `cron` lease on a session's live binding — the `force` gate's subject.
 *
 * Real, through the manager's own public lease port, so the host the gate reads is
 * the one the manager derives its state from, not a value stuffed into a fake.
 */
function addCronLease(sessionId: string): void {
  const added = sessionHostManager.addLease(sessionId, {
    kind: 'cron',
    id: 'cron-nightly',
    recurring: true,
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(added, 'premise: the cron lease landed on a live binding');
}

/** The listing's own state row for one session, or null when it is absent. */
async function sessionStateRow(
  context: Harness,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const reading = await readApi(await fetch(`${context.baseUrl}/api/session-hosts`, {
    headers: authHeaders(context),
  }));
  const sessions = (reading.data?.sessions ?? []) as Array<Record<string, unknown>>;
  return sessions.find((row) => row.appSessionId === sessionId) ?? null;
}

/** The live host serving one session, as the manager's own read port reports it. */
function liveHost(sessionId: string) {
  return sessionHostManager
    .snapshot()
    .find((host) => host.state !== 'closed' && host.bindings.has(sessionId)) ?? null;
}

// ---------------------------
//----------------- (1)+(2)+(3) THE START, THE LAUNCH, THE IDEMPOTENCE ------------
test('AC2: start answers 200 and the session reads running beside its own launch', async () => {
  await withHarness(async (context) => {
    seedSession(SESSION_RESIDENT, 'claude', context.directory, 'resident');
    assert.equal(liveHost(SESSION_RESIDENT), null, 'the premise: nothing is running for it yet');

    const started = await startHost(context, SESSION_RESIDENT);
    // Printed before the assertion, so a failing run still shows what came back:
    // the falsification arm's whole evidence is this line's status and message.
    say(`start status=${started.status} data=${JSON.stringify(started.data)} message="${started.message}"`);
    assert.equal(started.status, 200, 'a resident session with a driver that can be asked starts');

    // (1) the listing's own projection, which is what the client renders from.
    const row = await sessionStateRow(context, SESSION_RESIDENT);
    say(`listing row ${JSON.stringify(row)}`);
    assert.ok(row, 'the session appears in the listing');
    assert.equal(row.running, true, 'and reads as running');
    assert.equal(row.reason, null, 'with no "nothing is running" reason beside it');

    const host = liveHost(SESSION_RESIDENT);
    assert.ok(host, 'a live host holds the session in the manager');
    assert.equal(host.pid, FAKE_PID, 'carrying the injected process pid');
    assert.equal(host.state, 'idle', 'up and holding nothing but the resident policy');
    say(`host hostId=${host.hostId} pid=${host.pid} state=${host.state} mode=${host.mode}`);

    // (2) the launch the providers layer assembled, read where it arrives.
    assert.equal(context.driver.launches.length, 1, 'the driver was asked exactly once');
    const bag = context.driver.launches[0].options;
    assert.equal(bag.cwd, context.directory, 'launched in the session row\'s own project path');
    assert.equal(bag.sessionId, SESSION_RESIDENT);
    say(`launch cwd=${String(bag.cwd)} model=${String(bag.model)} keys=[${Object.keys(bag).join(',')}]`);

    // (3) the positive control: a second start is a success that starts nothing.
    const again = await startHost(context, SESSION_RESIDENT);
    assert.equal(again.status, 200, 'a repeated start is still a success');
    assert.equal(again.data?.hostId, started.data?.hostId, 'answering with the host already serving');
    assert.equal(context.driver.launches.length, 1, 'the seam was not asked a second time');
    assert.equal(context.driver.spawns(), 1, 'and no second process came up');
    say(
      `idempotent status=${again.status} hostId=${String(again.data?.hostId)} ` +
      `launches=${context.driver.launches.length} spawns=${context.driver.spawns()}`,
    );
  });
});

// ---------------------------
//----------------- (4) THE THREE REFUSALS, BESIDE THE 200 ------------
test('AC2: the three refusals keep their own codes beside the start', async () => {
  await withHarness(async (context) => {
    seedSession(SESSION_PER_RUN, 'claude', context.directory, 'per-run');
    seedSession(SESSION_NO_DRIVER, 'codex', context.directory, 'resident');

    const perRun = await startHost(context, SESSION_PER_RUN);
    assert.equal(perRun.status, 409, 'a session stored per-run is refused');
    assert.equal(perRun.code, 'LIFECYCLE_MODE_NOT_RESIDENT');

    const noDriver = await startHost(context, SESSION_NO_DRIVER);
    assert.equal(noDriver.status, 409, 'a resident session under a driverless provider is refused');
    assert.equal(noDriver.code, 'LIFECYCLE_MODE_HOST_UNAVAILABLE');

    const unknown = await startHost(context, SESSION_UNKNOWN);

    say(
      `refusals perRun=${perRun.status}/${perRun.code} ` +
      `noDriver=${noDriver.status}/${noDriver.code} unknown=${unknown.status}/${unknown.code}`,
    );
    say(`messages "${perRun.message}" | "${noDriver.message}" | "${unknown.message}"`);

    assert.equal(perRun.status, 409, 'a session stored per-run is refused');
    assert.equal(perRun.code, 'LIFECYCLE_MODE_NOT_RESIDENT');
    assert.equal(noDriver.status, 409, 'a resident session under a driverless provider is refused');
    assert.equal(noDriver.code, 'LIFECYCLE_MODE_HOST_UNAVAILABLE');
    assert.equal(unknown.status, 404, 'a session that does not exist is not found');
    assert.equal(unknown.code, 'SESSION_NOT_FOUND');

    // Distinct as a property of the answer, not of the three calls that happened
    // to produce it, and all three members of the vocabulary a client branches
    // on rather than strings typed a second time here.
    const codes = [perRun.code, noDriver.code, unknown.code];
    assert.equal(new Set(codes).size, 3, 'the three refusals are mutually distinct');
    for (const code of codes) {
      assert.ok(
        (LIFECYCLE_MODE_ERROR_CODES as readonly string[]).includes(code ?? ''),
        `${String(code)} is a member of the lifecycle refusal vocabulary`,
      );
    }

    assert.equal(context.driver.launches.length, 0, 'no refusal reached the launch seam');
    assert.equal(context.driver.spawns(), 0, 'and nothing was spawned');
  });
});

// ---------------------------
//----------------- AC3 THE LEASE GATE REFUSES A PLAIN CLOSE, HOST UNSHUT ------------
test('AC3: a resident host holding a blocking lease refuses a plain close and stays running', async () => {
  await withHarness(async (context) => {
    seedSession(SESSION_LEASED, 'claude', context.directory, 'resident');
    const started = await startHost(context, SESSION_LEASED);
    assert.equal(started.status, 200, 'premise: the resident host started');
    addCronLease(SESSION_LEASED);

    // The request carries no body at all — no `force` field, which is the reading
    // the gate's default refuses on.
    const refused = await closeHost(context, SESSION_LEASED);
    say(`close(no force) status=${refused.status} code=${refused.code} message="${refused.message}"`);
    assert.equal(refused.status, 409, 'a close with no force is refused while a cron lease is held');
    assert.equal(refused.code, 'SESSION_HAS_ACTIVE_LEASES', 'with the shared lease-refusal code');
    assert.match(refused.message, /cron×1/, 'and the sentence names what blocks it');

    // The host, read straight away from the manager's own snapshot, is still there
    // and not closed: the refusal is a refusal, not a close that happened to 409.
    const host = liveHost(SESSION_LEASED);
    assert.ok(host, 'the refused close left the host in the manager');
    assert.notEqual(host.state, 'closed', 'and did not close it');
    say(`host after refusal hostId=${host.hostId} state=${host.state} mode=${host.mode}`);

    const row = await sessionStateRow(context, SESSION_LEASED);
    assert.equal(row?.running, true, 'the listing still reads the session as running');
  });
});

// ---------------------------
//----------------- AC4 FORCE PASSES; ONLY A LITERAL true DOES ------------
test('AC4: only a literal force:true passes the gate; absent/false/"true" all refuse', async () => {
  await withHarness(async (context) => {
    seedSession(SESSION_LEASED, 'claude', context.directory, 'resident');
    const started = await startHost(context, SESSION_LEASED);
    assert.equal(started.status, 200, 'premise: the resident host started');
    addCronLease(SESSION_LEASED);

    // The three non-authorising forms, each taken beside the others on the same
    // still-running host. `"true"` is the one a truthiness test would let through,
    // so it is the reading that proves the judgement is `!== true` and not `if
    // (body.force)` — the same spelling the MCP reader uses.
    const absent = await closeHost(context, SESSION_LEASED);
    const falsy = await closeHost(context, SESSION_LEASED, { force: false });
    const stringy = await closeHost(context, SESSION_LEASED, { force: 'true' });
    say(
      `force forms absent=${absent.status}/${absent.code} ` +
      `false=${falsy.status}/${falsy.code} "true"=${stringy.status}/${stringy.code}`,
    );
    const forms: Array<[string, ApiReading]> = [['absent', absent], ['false', falsy], ['"true"', stringy]];
    for (const [name, reading] of forms) {
      assert.equal(reading.status, 409, `force ${name} must not authorise the close`);
      assert.equal(reading.code, 'SESSION_HAS_ACTIVE_LEASES', `force ${name} keeps the refusal code`);
    }
    const stillLive = liveHost(SESSION_LEASED);
    assert.ok(stillLive, 'none of the three forms closed the host');
    assert.notEqual(stillLive.state, 'closed', 'all three left it running');

    // The authorising form: a literal boolean true.
    const forced = await closeHost(context, SESSION_LEASED, { force: true });
    say(`close(force:true) status=${forced.status} data=${JSON.stringify(forced.data)}`);
    assert.equal(forced.status, 200, 'a literal force:true closes the host');
    assert.equal(liveHost(SESSION_LEASED), null, 'and no live host serves the session any more');
    const row = await sessionStateRow(context, SESSION_LEASED);
    assert.equal(row?.running, false, 'the listing reads it as no longer running');

    // Positive control on the gate's subject: a host holding only the resident
    // policy — no blocking kind — closes with no force. Without this the 409s above
    // would also be satisfied by a route that refused every close.
    seedSession(SESSION_PLAIN, 'claude', context.directory, 'resident');
    const plainStarted = await startHost(context, SESSION_PLAIN);
    assert.equal(plainStarted.status, 200, 'premise: the second resident host started');
    const plainClosed = await closeHost(context, SESSION_PLAIN);
    say(`close(resident-policy only) status=${plainClosed.status} code=${plainClosed.code}`);
    assert.equal(plainClosed.status, 200, 'a host with no blocking lease closes with no force');
  });
});
