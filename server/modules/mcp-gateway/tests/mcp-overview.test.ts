/**
 * AC-247 criterion: `overview` answers the whole workspace from the quay CACHE
 * (zero quay CLI calls on a cold cache, however many projects), and the only way
 * to load a snapshot is `quay_snapshot`, one project at a time.
 *
 * Everything driving the reading is real except the two seams the task names:
 * a real express 4 application carries the production `/mcp` mount behind the
 * production token middleware; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`; the database is a real better-sqlite3 file in
 * a temp directory; the projects and sessions are real rows; the resident session
 * is bound to a real `SessionHostManager` through the real `IProviderHostDriver`
 * contract; the running/aborted/completed runs live in the real process
 * `chatRunRegistry`. The two INJECTED fakes are the activity store (which forces
 * one session to `awaitingPermission`) and the quay runner (which counts every
 * `refresh` call — the "runner call count" this criterion asserts).
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240's criterion documents the same hazard), and the SDK's
 * `StreamableHTTPClientTransportOptions.fetch` is the seam that avoids it.
 *
 * Readings, one leg each:
 *   (a) `overview` carries the running session (project/title/phase/elapsedMs),
 *       the `awaitingPermission` session, the aborted run inside retention (and
 *       NOT the completed one), and the resident host (state + lease kinds);
 *   (b) a cache-hit project carries task counts / driver / suite state; a
 *       miss reads `unknown`; a cold cache costs ZERO runner calls;
 *   (c) `quay_snapshot` reads the cache by default (no runner call), refreshes
 *       exactly once for exactly the named project when asked, and refuses an
 *       array `project`;
 *   (d) a project without `.quay/config.yml` is a SUCCESS (`status:
 *       'no_quay_config'`, explained in words), while a project id nothing
 *       matches is an error `PROJECT_NOT_FOUND` (AC-287; see the leg's note on
 *       why not the prose `TARGET_NOT_FOUND`) — the two no longer collapse;
 *   (e) twenty projects still cost zero runner calls.
 *   (f) `quay_snapshot` carries the in-flight reading (taskId/phase/startedAt/
 *       lastHeartbeat/workerPid) end to end, while `overview`'s compact quay entry
 *       deliberately does NOT grow an `inFlight` key (gap-cloudcli-quay-snapshot-
 *       inflight-tasks: the field is added to `quay_snapshot` only).
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import type { HostLease, LLMProvider, ProcessHost, SessionBinding } from '@/shared/types.js';
import type { QuaySnapshot } from '@/modules/quay/index.js';

import type { McpResolveDeps } from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically (the order the provider criteria
// established).
process.env.JWT_SECRET = 'mcp-overview-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { sessionsService } = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/index.js');
const { getProjectsWithSessions } = await import('@/modules/projects/index.js');
const { MCP_GATEWAY_PATH, NO_QUAY_NOTE, UNKNOWN_QUAY_NOTE, createMcpAuthMiddleware, mountMcpGateway, overviewOutputSchema } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;

// --------------------------- clocks ---------------------------

/** The instant every host/lease reading is measured against. */
const HOST_NOW_MS = Date.parse('2026-09-01T12:00:00.000Z');

/** How far past the busy run's start the overview's clock is set, so `elapsedMs` is exact. */
const ELAPSED_MS = 12_345;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;

/** The two named project directories; basenames become the project display names. */
const MAIN_DIR = 'overview-main';
const OTHER_DIR = 'overview-other';

/** Eighteen further project directories, so the fixture holds twenty projects. */
const EXTRA_DIRS = Array.from({ length: 18 }, (_, index) => `overview-extra-${String(index).padStart(2, '0')}`);
const ALL_PROJECT_DIRS = [MAIN_DIR, OTHER_DIR, ...EXTRA_DIRS];

const SESSION_BUSY = 'overview-fixture-busy';
const SESSION_COMPLETED = 'overview-fixture-completed';
const SESSION_ABORTED = 'overview-fixture-aborted';
const SESSION_RESIDENT = 'overview-fixture-resident';

/** The name the scripted host driver reports for the resident binding. */
const PEER_NAME = 'overview-fixture-peer';

const HOST_PID = process.pid;

const TITLE_BUSY = 'Busy overview session';
const TITLE_RESIDENT = 'Resident overview session';

const UPDATED_AT = '2026-09-01T11:00:00.000Z';

/** The injected task count / driver / suite a cached project reports. */
const CACHED_TASKS_TOTAL = 7;
const CACHED_DRIVER_STATE = 'running';
const CACHED_SUITE_STATE = 'passed';

/**
 * The in-flight reading the main project's cached snapshot carries — the same shape and
 * values AC2 pins for the quay service, so leg (f) can assert the MCP round trip is
 * verbatim.
 */
const IN_FLIGHT_READING = [
  {
    taskId: 'gap-example-task',
    phase: 'implementing' as const,
    startedAt: '2026-10-06T23:50:00.000Z',
    lastHeartbeat: '2026-10-07T00:00:00.000Z',
    workerPid: 4242,
  },
];

// --------------------------- the injected quay fake ---------------------------

/** A complete `QuaySnapshot` for the fake cache, overridable per project. */
function makeSnapshot(projectId: string, overrides: Partial<QuaySnapshot> = {}): QuaySnapshot {
  return {
    projectId,
    projectPath: `/tmp/${projectId}`,
    generatedAt: new Date(HOST_NOW_MS).toISOString(),
    cached: true,
    driver: { state: CACHED_DRIVER_STATE, alive: true, running: true, lastRecordAt: null },
    tasks: {
      total: CACHED_TASKS_TOTAL,
      byStatus: { ready: CACHED_TASKS_TOTAL },
      ready: CACHED_TASKS_TOTAL,
      needsHuman: 0,
      done: 0,
      recent: [],
    },
    goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
    adrs: { total: 0, recent: [] },
    configIssues: { total: 0, errors: 0 },
    tests: {
      current: {
        state: CACHED_SUITE_STATE,
        runner: 'vitest',
        scope: 'full',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        laneCount: null,
        commit: null,
        taskId: null,
        runId: null,
      },
      recentRounds: [],
    },
    fanIn: { recent: [] },
    inFlight: null,
    dashboardUrl: null,
    warnings: [],
    ...overrides,
  };
}

/** The counting quay runner the criterion injects in place of the real service. */
type QuayFake = {
  runner: {
    hasQuayConfig(projectId: string): boolean;
    readCached(projectId: string): QuaySnapshot | null;
    refresh(projectId: string): Promise<QuaySnapshot | null>;
  };
  /** refresh calls for one project (the "runner call count" of that project). */
  refreshCount(projectId: string): number;
  /** refresh calls across every project. */
  totalRefreshCount(): number;
  hasQuayConfig(projectId: string): boolean;
};

// --------------------------- host driver ---------------------------

/**
 * The scripted resident driver the host manager binds.
 *
 * It reports the peer name once through the documented identity sink and leaves
 * the host fields to the manager — the debug agent's driver cannot be used here
 * because `provider.registry.ts` reads its gate at import time (see AC-245's
 * criterion), so this is the same manager/binding/lease objects with a stub.
 */
function scriptedResidentDriver(appSessionId: string, peerName: string) {
  let reported = false;
  return {
    async startHost(host: ProcessHost, sink: { identity: (id: string, name: string | null) => void }) {
      if (!reported) {
        reported = true;
        sink.identity(appSessionId, peerName);
      }
      return host;
    },
    async bind(_host: ProcessHost, _binding: SessionBinding): Promise<void> {},
    async submit(): Promise<void> {},
    async interrupt(): Promise<boolean> {
      return false;
    },
    async reconfigure(): Promise<'next-turn'> {
      return 'next-turn';
    },
    async unbind(): Promise<void> {},
    async closeHost(): Promise<void> {},
  };
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

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

// --------------------------- harness ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  // AC-284: a FAILURE now carries its machine fields in `structuredContent`
  // (`{ code, message, retryable, details? }`) instead of a JSON string stuffed
  // into the text. Read that first; a SUCCESS payload is still the text body.
  if (call.isError === true && typeof call.structuredContent === 'object' && call.structuredContent !== null) {
    payload = call.structuredContent as AnyRecord;
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
    } catch {
      payload = null;
    }
  }
  return { isError: call.isError === true, text, payload };
}

type Harness = {
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  /**
   * Calls `tools/list` first, then the tool — the WARM path
   * (gap-mcp-outputschema-drift-overview-and-error-envelope). The SDK caches an
   * output validator per tool only once `tools/list` has run, so this client
   * validates BOTH a success result and an `isError` result against the
   * advertised `outputSchema`; `call` above never lists and so validates
   * nothing, which is why the two bugs stayed latent for the AC-247 criterion.
   */
  warmCall: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  /** The raw `tools/list` entries, so a leg can validate against the ADVERTISED schema. */
  listTools: () => Promise<Array<{ name: string; outputSchema?: unknown }>>;
  quay: QuayFake;
};

type Fixture = {
  mainId: string;
  otherId: string;
  /** A project the fixture declares to have no `.quay/config.yml`. */
  noQuayId: string;
  projectCount: number;
  /** The aborted run's id, so leg (a) can assert it is present. */
  abortedRunId: string;
  /** The completed run's id, so leg (a) can assert it is absent. */
  completedRunId: string;
  elapsedMs: number;
};

/**
 * Runs `run` against a fresh temp database, twenty real projects, the real
 * project/session/host services, the real chat run registry, and the production
 * `/mcp` mount carrying AC-247's real overview handlers over the injected quay
 * and activity fakes.
 *
 * `options.resolveDeps` mounts AC-246's target gate (`mcp-resolve-target.js`),
 * which is otherwise absent: the overview criteria drive `overview`'s OWN
 * project resolution (`buildOverview`'s refusal), so wiring the gate in every leg
 * would pre-empt it. The one leg that proves the DoD's `sessions_list` refusal
 * opts in, because that refusal is the GATE's, not the handler's.
 */
async function withOverviewHarness(
  run: (harness: Harness, fixture: Fixture) => Promise<void>,
  options: { resolveDeps?: McpResolveDeps } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-overview-'));

  const dirByProject = new Map<string, string>();
  for (const name of ALL_PROJECT_DIRS) {
    const dir = path.join(tempDirectory, name);
    await mkdir(dir, { recursive: true });
    dirByProject.set(name, dir);
  }

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'overview.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  // ---- sessions: the named four plus one per extra project (twenty projects) ----
  const namedSessions: Array<[string, string, string, string]> = [
    [SESSION_BUSY, MAIN_DIR, TITLE_BUSY, UPDATED_AT],
    [SESSION_COMPLETED, MAIN_DIR, 'Completed overview session', UPDATED_AT],
    [SESSION_ABORTED, OTHER_DIR, 'Aborted overview session', UPDATED_AT],
    [SESSION_RESIDENT, OTHER_DIR, TITLE_RESIDENT, UPDATED_AT],
  ];
  for (const [id, projectDir, title, updatedAt] of namedSessions) {
    sessionsDb.createSession(id, 'claude', dirByProject.get(projectDir) as string, title, updatedAt, updatedAt, null);
  }
  EXTRA_DIRS.forEach((projectDir, index) => {
    sessionsDb.createSession(
      `overview-extra-session-${String(index).padStart(2, '0')}`,
      'claude',
      dirByProject.get(projectDir) as string,
      `Extra session ${index}`,
      UPDATED_AT,
      UPDATED_AT,
      null,
    );
  });
  sessionsDb.setSessionLifecycleMode(SESSION_RESIDENT, 'resident');

  // ---- the resident host: a real manager, a real binding, real leases ----
  const hostManager = createSessionHostManager({ now: () => HOST_NOW_MS, scheduler: { schedule: () => () => {} } });
  const bound = await hostManager.bindSession({
    provider: 'claude',
    appSessionId: SESSION_RESIDENT,
    driver: scriptedResidentDriver(SESSION_RESIDENT, PEER_NAME),
    mode: 'resident',
    pid: HOST_PID,
  });
  assert.ok(bound.ok, 'the resident fixture must land on a host');
  const cronLease: HostLease = { kind: 'cron', id: 'overview-fixture-cron', recurring: true, expiresAt: HOST_NOW_MS + 3_600_000 };
  const backgroundLease: HostLease = { kind: 'background-task', id: 'overview-fixture-bg' };
  assert.ok(hostManager.addLease(SESSION_RESIDENT, cronLease), 'the cron lease must be recorded');
  assert.ok(hostManager.addLease(SESSION_RESIDENT, backgroundLease), 'the background-task lease must be recorded');

  // ---- runs: one running, one completed, one aborted (all in the real registry) ----
  const busy = chatRunRegistry.startRun({
    appSessionId: SESSION_BUSY,
    provider: 'claude' as LLMProvider,
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  const completed = chatRunRegistry.startRun({
    appSessionId: SESSION_COMPLETED,
    provider: 'claude' as LLMProvider,
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  const aborted = chatRunRegistry.startRun({
    appSessionId: SESSION_ABORTED,
    provider: 'claude' as LLMProvider,
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(busy && completed && aborted, 'the fixture must open all three runs');
  chatRunRegistry.completeRun(SESSION_COMPLETED, { exitCode: 0 });
  chatRunRegistry.completeRun(SESSION_ABORTED, { exitCode: 1, aborted: true });

  // ---- the injected clock: pinned past the busy run so `elapsedMs` is exact ----
  let overviewNow = HOST_NOW_MS;
  const now = (): number => overviewNow;
  overviewNow = busy.startedAt + ELAPSED_MS;

  // ---- resolve project ids, then wire the quay + activity fakes ----
  const projects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
  const idByDir = new Map(projects.map((project) => [project.path, project.projectId]));
  const mainId = idByDir.get(dirByProject.get(MAIN_DIR) as string);
  const otherId = idByDir.get(dirByProject.get(OTHER_DIR) as string);
  const noQuayDir = dirByProject.get(EXTRA_DIRS[0]) as string;
  const noQuayId = idByDir.get(noQuayDir);
  assert.ok(mainId && otherId && noQuayId, 'the fixture projects must be registered');

  // Only the main project's snapshot is cached; every other project (including
  // the other named one) is a cache MISS, which `overview` must mark `unknown`.
  const cachedSnapshots = new Map<string, QuaySnapshot>([
    [mainId, makeSnapshot(mainId, { inFlight: IN_FLIGHT_READING })],
  ]);
  // Every extra project is "has quay config" on ODD indices — index 0 (the
  // no-quay fixture) is deliberately config-less — and its snapshot is never
  // cached, so the listing is a mix of unknown and no_quay_config entries.
  const configProjects = new Set<string>([mainId, otherId]);
  EXTRA_DIRS.forEach((projectDir, index) => {
    const id = idByDir.get(dirByProject.get(projectDir) as string);
    if (id !== undefined && index % 2 === 1) {
      configProjects.add(id);
    }
  });
  assert.ok(!configProjects.has(noQuayId), 'the no-quay fixture must report no config');

  const refreshByProject = new Map<string, number>();
  const quay: QuayFake = {
    runner: {
      hasQuayConfig: (projectId) => configProjects.has(projectId),
      readCached: (projectId) => cachedSnapshots.get(projectId) ?? null,
      refresh: async (projectId) => {
        refreshByProject.set(projectId, (refreshByProject.get(projectId) ?? 0) + 1);
        return cachedSnapshots.get(projectId) ?? null;
      },
    },
    refreshCount: (projectId) => refreshByProject.get(projectId) ?? 0,
    totalRefreshCount: () => [...refreshByProject.values()].reduce((sum, count) => sum + count, 0),
    hasQuayConfig: (projectId) => configProjects.has(projectId),
  };

  const activity = {
    snapshot: (sessionId: string) =>
      sessionId === SESSION_BUSY ? { turn: { phase: 'awaitingPermission' } } : { turn: { phase: 'idle' } },
  };

  // ---- the tokens ----
  const tokens = createAccessTokensService({ now: () => new Date(HOST_NOW_MS) });
  const readToken = tokens.issueToken({ userId: USER_ONE, name: 'mcp-overview', scopes: ['cloudcli:read'], expiresInDays: 30 });
  if (!readToken.ok) {
    throw new Error('the harness must mint a read token');
  }

  // ---- the app and the real mount ----
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    ...(options.resolveDeps === undefined ? {} : { resolveDeps: options.resolveDeps }),
    readTools: {
      projects: {
        getProjectsWithSessions,
        getArchivedProjectsWithSessions: async () => [],
        getProjectSessionsPage: async (projectId: string) => ({ projectId, sessions: [] }),
      },
      sessions: sessionsService,
      hosts: hostManager,
      runs: chatRunRegistry,
      activity,
      quay: quay.runner,
      now,
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${readToken.token.token}` } },
    fetch: nodeFetch,
  });
  const client = new Client({ name: 'ac247-criterion', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  // Warm the client's per-tool output validators (the SDK builds them from
  // `tools/list`), then call — so the result is validated against the advertised
  // `outputSchema` exactly as a real MCP client would after discovery.
  const warmCall = async (name: string, args: AnyRecord = {}): Promise<ToolCall> => {
    await client.listTools();
    return call(name, args);
  };

  const listTools = async (): Promise<Array<{ name: string; outputSchema?: unknown }>> => {
    const listed = await client.listTools();
    return listed.tools as Array<{ name: string; outputSchema?: unknown }>;
  };

  try {
    await run(
      { call, warmCall, listTools, quay },
      {
        mainId,
        otherId,
        noQuayId,
        projectCount: ALL_PROJECT_DIRS.length,
        abortedRunId: aborted.runId,
        completedRunId: completed.runId,
        elapsedMs: ELAPSED_MS,
      },
    );
  } finally {
    // The run registry is the process singleton; drop this fixture's runs so a
    // later case (or a sibling criterion in this process) starts clean.
    chatRunRegistry.clearAll();
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --------------------------- (a) sessions + hosts ---------------------------

test('(a) overview carries the running, awaiting-permission, aborted and resident readings', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    const overview = await harness.call('overview');
    assert.equal(overview.isError, false, 'overview must not error');
    const payload = overview.payload as AnyRecord;

    const running = payload.running as AnyRecord[];
    console.log(`[a] running = ${JSON.stringify(running)}`);
    assert.ok(running.length > 0, 'at least one running session must be reported');
    const busy = running.find((entry) => entry.sessionId === SESSION_BUSY);
    assert.ok(busy, 'the busy fixture session must be in the running list');
    assert.equal(busy.title, TITLE_BUSY, 'the running reading must carry the session title');
    assert.equal(busy.project, MAIN_DIR, 'the running reading must resolve the project display name');
    assert.equal(busy.phase, 'awaitingPermission', 'the running reading must carry the injected turn phase');
    assert.equal(busy.elapsedMs, fixture.elapsedMs, 'elapsedMs must be now() - startedAt');

    const awaiting = payload.awaitingPermission as AnyRecord[];
    console.log(`[a] awaitingPermission = ${JSON.stringify(awaiting)}`);
    assert.deepEqual(
      awaiting.map((entry) => entry.sessionId),
      [SESSION_BUSY],
      'the awaitingPermission list must contain exactly the injected session',
    );
    assert.equal(awaiting[0].phase, 'awaitingPermission', 'the awaiting reading must state the phase');

    const aborted = payload.aborted as AnyRecord[];
    console.log(`[a] aborted = ${JSON.stringify(aborted)}`);
    assert.deepEqual(
      aborted.map((entry) => entry.runId),
      [fixture.abortedRunId],
      'the aborted list must contain exactly the aborted run, not the completed one',
    );
    assert.equal(aborted[0].status, 'aborted', 'the aborted reading must state its status');
    assert.ok(
      !aborted.some((entry) => entry.runId === fixture.completedRunId),
      'a completed run must not be reported as aborted',
    );

    const hosts = payload.hosts as AnyRecord[];
    console.log(`[a] hosts = ${JSON.stringify(hosts)}`);
    const resident = hosts.find((entry) => entry.sessionId === SESSION_RESIDENT);
    assert.ok(resident, 'the resident host binding must be listed');
    console.log(`[a] resident host state=${JSON.stringify(resident.state)} peerName=${JSON.stringify(resident.peerName)}`);
    assert.ok(
      ['starting', 'idle', 'busy', 'lingering', 'closing', 'closed'].includes(String(resident.state)),
      `the resident host must report a HostState, got ${JSON.stringify(resident.state)}`,
    );
    assert.equal(resident.peerName, PEER_NAME, 'the resident host must report its peer name');
    const leaseKinds = (resident.leases as AnyRecord[]).map((lease) => lease.kind);
    console.log(`[a] resident lease kinds = ${JSON.stringify(leaseKinds)}`);
    assert.ok(leaseKinds.includes('cron'), 'the resident host must carry the cron lease verbatim');
    assert.ok(leaseKinds.includes('background-task'), 'the resident host must carry the background-task lease verbatim');
  });
});

// --------------------------- (b) cache hit / miss / cold-cache zero CLI ---------------------------

test('(b) overview reads quay from the cache only, marking misses unknown', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    assert.equal(harness.quay.totalRefreshCount(), 0, 'the cache must start cold');

    const overview = await harness.call('overview');
    assert.equal(overview.isError, false, 'overview must not error');
    const quay = (overview.payload as AnyRecord).quay as AnyRecord[];
    console.log(`[b] quay = ${JSON.stringify(quay)}`);

    const hit = quay.find((entry) => entry.projectId === fixture.mainId);
    assert.ok(hit, 'the cached project must appear');
    assert.equal(hit.status, 'cached', 'the cached project must be marked cached');
    assert.equal((hit.tasks as AnyRecord).total, CACHED_TASKS_TOTAL, 'the cached project must carry its task count');
    assert.equal((hit.driver as AnyRecord).state, CACHED_DRIVER_STATE, 'the cached project must carry its driver state');
    assert.equal((hit.suite as AnyRecord).state, CACHED_SUITE_STATE, 'the cached project must carry its suite state');

    const miss = quay.find((entry) => entry.projectId === fixture.otherId);
    assert.ok(miss, 'the uncached project must appear');
    assert.equal(miss.status, 'unknown', 'the uncached project must be marked unknown');
    assert.equal(miss.note, UNKNOWN_QUAY_NOTE, 'the uncached project must say it has no cached snapshot');

    console.log(`[b] refreshCount after overview = ${harness.quay.totalRefreshCount()}`);
    assert.equal(harness.quay.totalRefreshCount(), 0, 'overview must not call the quay runner');
  });
});

// --------------------------- (c) quay_snapshot: cache by default, refresh once ---------------------------

test('(c) quay_snapshot reads cache by default and refreshes exactly one project when asked', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    const cached = await harness.call('quay_snapshot', { project: fixture.mainId });
    assert.equal(cached.isError, false, 'quay_snapshot must not error');
    const cachedPayload = cached.payload as AnyRecord;
    console.log(`[c] quay_snapshot(cached) = ${JSON.stringify(cachedPayload)}`);
    assert.equal(cachedPayload.status, 'cached', 'the default read must come from the cache');
    assert.ok(cachedPayload.snapshot, 'the cached read must carry the snapshot');
    assert.equal(harness.quay.refreshCount(fixture.mainId), 0, 'the default read must not refresh');
    assert.equal(harness.quay.totalRefreshCount(), 0, 'the default read must not call the runner');

    const refreshed = await harness.call('quay_snapshot', { project: fixture.mainId, refresh: true });
    assert.equal(refreshed.isError, false, 'the refreshing read must not error');
    console.log(`[c] quay_snapshot(refresh) = ${JSON.stringify(refreshed.payload)}`);
    assert.equal((refreshed.payload as AnyRecord).status, 'refreshed', 'the refresh read must report a refresh');
    const mainCount = harness.quay.refreshCount(fixture.mainId);
    const otherCount = harness.quay.refreshCount(fixture.otherId);
    console.log(`[c] refreshCounts: ${fixture.mainId}=${mainCount} ${fixture.otherId}=${otherCount}`);
    assert.equal(mainCount, 1, 'refresh: true must call the runner exactly once for the named project');
    assert.equal(otherCount, 0, 'refresh on one project must not touch another');

    // `project` is a single string: an array is refused by the input schema before the handler runs.
    const arrayCall = await harness.call('quay_snapshot', { project: [fixture.mainId, fixture.otherId] });
    console.log(`[c] quay_snapshot(array project) -> isError=${arrayCall.isError} text=${JSON.stringify(arrayCall.text)}`);
    assert.equal(arrayCall.isError, true, 'an array `project` must be refused by the input schema');
    assert.equal(
      harness.quay.refreshCount(fixture.mainId),
      1,
      'a refused call must not reach the handler or change the refresh count',
    );
  });
});

// --------------------------- (d) no quay config is a reading, not an error ---------------------------

test('(d) a project without quay config is a success, a project that does not exist is an error', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    const overview = await harness.call('overview');
    const quay = (overview.payload as AnyRecord).quay as AnyRecord[];
    const absent = quay.find((entry) => entry.projectId === fixture.noQuayId);
    console.log(`[d] overview no-quay entry = ${JSON.stringify(absent)}`);
    assert.ok(absent, 'the no-quay project must appear');
    assert.equal(absent.note, NO_QUAY_NOTE, 'overview must explain the missing quay config');

    // Positive control: a project WITH config must not carry that note.
    const withConfig = quay.find((entry) => entry.projectId === fixture.mainId);
    assert.notEqual(withConfig?.note, NO_QUAY_NOTE, 'a project with quay config must not say it has none');

    const snapshot = await harness.call('quay_snapshot', { project: fixture.noQuayId });
    console.log(`[d] quay_snapshot no-quay = ${JSON.stringify({ isError: snapshot.isError, payload: snapshot.payload })}`);
    assert.equal(snapshot.isError, false, 'a no-quay project must not be an error');
    assert.equal((snapshot.payload as AnyRecord).status, 'no_quay_config', 'the AC-287 status literal is no_quay_config');
    assert.equal((snapshot.payload as AnyRecord).note, NO_QUAY_NOTE, 'quay_snapshot must explain the missing quay config');
    assert.equal((snapshot.payload as AnyRecord).hasQuayConfig, false, 'the reading must state there is no config');

    // AC-287: a project id NOTHING matches is a DIFFERENT case — a reference to
    // nothing, which is an error. Before this task the two collapsed onto the
    // same `hasQuayConfig: false` branch, so this probe is what separates them.
    //
    // The code asserted here is `PROJECT_NOT_FOUND`, not AC-287's prose
    // `TARGET_NOT_FOUND`: AC-284's achieved vocabulary has no such literal and
    // its criterion reds if the string appears in this module, and AC-285's
    // criterion pins the vocabulary key set in both directions. `PROJECT_NOT_FOUND`
    // is that vocabulary's project-side code for exactly this fact; the task
    // record carries the conflict and its resolution (AC5 left unticked).
    const missingId = 'overview-no-such-project';
    const missing = await harness.call('quay_snapshot', { project: missingId });
    console.log(`[d] quay_snapshot missing = ${JSON.stringify({ isError: missing.isError, payload: missing.payload })}`);
    assert.equal(missing.isError, true, 'a project that does not exist must be an error');
    assert.equal(missing.payload?.code, 'PROJECT_NOT_FOUND', 'the missing project error carries PROJECT_NOT_FOUND');
    assert.equal(
      (missing.payload?.details as AnyRecord | undefined)?.project,
      missingId,
      'the error names the project that was asked for',
    );

    // Positive control: an EXISTING project with config is still a success, so
    // the existence gate did not turn every read into an error.
    const withConfig2 = await harness.call('quay_snapshot', { project: fixture.mainId });
    assert.equal(withConfig2.isError, false, 'an existing project with config must still succeed');
  });
});

// --------------------------- (e) twenty projects still zero runner calls ---------------------------

test('(e) twenty projects cost zero runner calls', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    const overview = await harness.call('overview');
    const quay = (overview.payload as AnyRecord).quay as AnyRecord[];
    const projectCount = fixture.projectCount;
    const refreshCount = harness.quay.totalRefreshCount();
    console.log(`[e] projects=${projectCount} entries=${quay.length} refreshCount=${refreshCount}`);
    assert.equal(quay.length, projectCount, 'every project must be represented');
    assert.equal(refreshCount, 0, 'no project count may cause a runner call');
  });
});

// --------------------------- (f) quay_snapshot carries in-flight; overview does not ---------------------------

test('(f) quay_snapshot carries the in-flight reading and overview deliberately omits it', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    const refreshed = await harness.call('quay_snapshot', { project: fixture.mainId, refresh: true });
    assert.equal(refreshed.isError, false, 'the refreshing read must not error');
    const snapshot = (refreshed.payload as AnyRecord).snapshot as AnyRecord;
    console.log(`[f] quay_snapshot.inFlight = ${JSON.stringify(snapshot.inFlight)}`);
    // The in-flight task reaches the CloudCLI client verbatim, through the real mount.
    assert.deepEqual(snapshot.inFlight, IN_FLIGHT_READING, 'the in-flight reading must round-trip verbatim');

    // Scope guard: `overview`'s per-project summary is AC-247's and this task must not
    // widen it — the cached snapshot HAS an in-flight reading, yet the overview entry
    // carries no `inFlight` key at all.
    const overview = await harness.call('overview');
    assert.equal(overview.isError, false, 'overview must not error');
    const entry = ((overview.payload as AnyRecord).quay as AnyRecord[]).find(
      (row) => row.projectId === fixture.mainId,
    );
    console.log(`[f] overview main entry = ${JSON.stringify(entry)}`);
    assert.ok(entry, 'the cached project must appear in overview');
    assert.equal('inFlight' in entry, false, 'overview must not grow an inFlight key (scope stayed on quay_snapshot)');
  });
});

// --------------------------- (g) the `project` argument scopes the reading ---------------------------

test('(g) overview reads its `project` argument: it scopes every list to that project and refuses an unknown id', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    // The whole-workspace reading (no argument) is the default and must be unchanged.
    const whole = await harness.call('overview');
    assert.equal(whole.isError, false, 'the unscoped overview must not error');
    assert.equal(
      ((whole.payload as AnyRecord).quay as AnyRecord[]).length,
      fixture.projectCount,
      'the unscoped overview still reads every project',
    );

    // Scoped: `project` names the one project the reading is restricted to. This
    // is the declared argument that used to be ignored; a caller passing it now
    // gets that project's overview instead of the whole workspace.
    const scoped = await harness.call('overview', { project: fixture.mainId });
    assert.equal(scoped.isError, false, 'a scoped overview of a real project must not error');
    const scopedPayload = scoped.payload as AnyRecord;
    console.log(`[g] scoped(main) payload = ${JSON.stringify(scopedPayload)}`);

    const quay = scopedPayload.quay as AnyRecord[];
    assert.deepEqual(
      quay.map((entry) => entry.projectId),
      [fixture.mainId],
      'the scoped quay list is exactly the named project',
    );

    // MAIN_DIR holds the busy session; OTHER_DIR holds the aborted run and the
    // resident host. Scoping to MAIN must keep the first and drop the others —
    // so this separates "the filter ran" from "the list was empty anyway".
    const running = scopedPayload.running as AnyRecord[];
    assert.deepEqual(
      running.map((entry) => entry.sessionId),
      [SESSION_BUSY],
      'the scoped running list is exactly the named project\'s running session',
    );
    assert.ok(
      (scopedPayload.awaitingPermission as AnyRecord[]).every((entry) => entry.projectId === fixture.mainId),
      'the scoped awaiting list carries only the named project',
    );
    const aborted = scopedPayload.aborted as AnyRecord[];
    console.log(`[g] scoped aborted = ${JSON.stringify(aborted)}`);
    assert.deepEqual(aborted, [], 'the aborted run belongs to the other project and must be out of scope');
    assert.equal(
      (scopedPayload.hosts as AnyRecord[]).some((entry) => entry.sessionId === SESSION_RESIDENT),
      false,
      'the resident host belongs to the other project and must be out of scope',
    );

    // A positive control: scoping to the OTHER project keeps ITS aborted run and
    // resident host, so the two readings discriminate rather than both being empty.
    const other = await harness.call('overview', { project: fixture.otherId });
    assert.equal(other.isError, false, 'a scoped overview of the other real project must not error');
    const otherPayload = other.payload as AnyRecord;
    assert.deepEqual(
      (otherPayload.aborted as AnyRecord[]).map((entry) => entry.runId),
      [fixture.abortedRunId],
      'the other project\'s scoped reading carries its aborted run',
    );
    assert.ok(
      (otherPayload.hosts as AnyRecord[]).some((entry) => entry.sessionId === SESSION_RESIDENT),
      'the other project\'s scoped reading carries its resident host',
    );
    assert.deepEqual(
      (otherPayload.running as AnyRecord[]).map((entry) => entry.sessionId),
      [],
      'the busy session belongs to the main project and must be out of the other project\'s scope',
    );

    // An id nothing matches is a reference to nothing: it is refused, not
    // answered with an empty-but-successful reading that would read as "quiet".
    const missing = await harness.call('overview', { project: 'overview-no-such-project' });
    console.log(`[g] scoped(missing) -> isError=${missing.isError} payload=${JSON.stringify(missing.payload)}`);
    assert.equal(missing.isError, true, 'an unknown project must be an error, not an empty overview');
    assert.equal(missing.payload?.code, 'PROJECT_NOT_FOUND', 'the unknown project error carries PROJECT_NOT_FOUND');
    assert.equal(
      (missing.payload?.details as AnyRecord | undefined)?.project,
      'overview-no-such-project',
      'the error names the project that was asked for',
    );
  });
});

// --------------------------- (h) array project -> attributed union ---------------------------

test('(h) a project ARRAY unions those projects, attributing every row to its owner', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness, fixture) => {
    // The unscoped reading is the control: twenty projects, so scoping to two is
    // a real narrowing and not a list that was empty anyway.
    const whole = await harness.call('overview');
    assert.equal(whole.isError, false, 'the unscoped overview must not error');
    assert.equal(
      ((whole.payload as AnyRecord).quay as AnyRecord[]).length,
      fixture.projectCount,
      'the control reading must cover every project',
    );

    const both = await harness.call('overview', { project: [fixture.mainId, fixture.otherId] });
    console.log(`[h] project=[main,other] -> isError=${both.isError} payload=${JSON.stringify(both.payload)}`);
    assert.equal(both.isError, false, 'a two-project array must be a reading, not an error');
    const payload = both.payload as AnyRecord;
    const allowed = new Set([fixture.mainId, fixture.otherId]);

    // The quay listing is exactly the two named projects, each labelled with its
    // own display name — the array restricts rather than returning everything.
    const quay = payload.quay as AnyRecord[];
    assert.equal(quay.length, 2, 'the union names exactly the two projects asked for');
    assert.deepEqual([...quay.map((entry) => entry.projectId)].sort(), [...allowed].sort());
    assert.equal(quay.find((entry) => entry.projectId === fixture.mainId)?.project, MAIN_DIR);
    assert.equal(quay.find((entry) => entry.projectId === fixture.otherId)?.project, OTHER_DIR);

    // Each session/run/host row is attributed to the project that owns it.
    const running = payload.running as AnyRecord[];
    assert.deepEqual(running.map((entry) => entry.sessionId), [SESSION_BUSY]);
    assert.equal(running[0].projectId, fixture.mainId, 'the busy session must name its owner');
    assert.equal(running[0].project, MAIN_DIR, 'the busy session must carry its owner\'s display name');

    const aborted = payload.aborted as AnyRecord[];
    assert.deepEqual(aborted.map((entry) => entry.runId), [fixture.abortedRunId]);
    assert.equal(aborted[0].projectId, fixture.otherId, 'the aborted run must name its owner');
    assert.equal(aborted[0].project, OTHER_DIR, 'the aborted run must carry its owner\'s display name');

    const hosts = payload.hosts as AnyRecord[];
    assert.ok(
      hosts.some((entry) => entry.sessionId === SESSION_RESIDENT && entry.projectId === fixture.otherId),
      'the resident host must be present and attributed to the other project',
    );

    // No row may name a project outside the two that were asked for.
    for (const field of ['running', 'awaitingPermission', 'aborted', 'hosts'] as const) {
      for (const row of (payload[field] as AnyRecord[]) ?? []) {
        assert.ok(
          row.projectId === null || allowed.has(String(row.projectId)),
          `a ${field} row named a project outside the asked-for set: ${JSON.stringify(row)}`,
        );
      }
    }

    // The extension is a superset of the old surface: a ONE-element array reads
    // exactly like the single string it wraps, so an existing single-project
    // caller sees no change at all.
    const oneElement = await harness.call('overview', { project: [fixture.mainId] });
    const singleString = await harness.call('overview', { project: fixture.mainId });
    assert.equal(oneElement.isError, false);
    assert.deepEqual(
      oneElement.payload,
      singleString.payload,
      'a one-element array must read byte-for-byte like the single string',
    );

    // An array naming a project that does not exist refuses the WHOLE call: the
    // good element does not survive as a partial reading.
    const missing = await harness.call('overview', { project: [fixture.mainId, 'overview-no-such-project'] });
    console.log(`[h] array with unknown element -> isError=${missing.isError} payload=${JSON.stringify(missing.payload)}`);
    assert.equal(missing.isError, true, 'an array naming an unknown project must refuse');
    assert.equal(missing.payload?.code, 'PROJECT_NOT_FOUND');
    assert.equal(
      (missing.payload?.details as AnyRecord | undefined)?.project,
      'overview-no-such-project',
      'the refusal must name the offending element',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(missing.payload ?? {}, 'quay'),
      false,
      'the good element must not be returned as a partial overview',
    );
  });
});

// --------------------------- (i)/(j) the WARM client (outputSchema drift) ---------------------------

/**
 * gap-mcp-outputschema-drift-overview-and-error-envelope: the two bugs only
 * surface on a client that has run `tools/list` — the SDK builds its per-tool
 * output validator from that response, and validates EVERY result (success and
 * `isError` alike) against it. `harness.warmCall` is that client. Leg (i) is
 * Bug 1 (`overview`'s placeholder shape rejected the real reading); leg (j) is
 * Bug 2 (an `isError` envelope rejected against a success-only shape, so the
 * caller read `-32602` instead of the gateway's own code).
 */
test('(i) a WARM client validates the real overview reading — all three quay arms — against the advertised shape', { concurrency: false }, async () => {
  await withOverviewHarness(async (harness) => {
    const overview = await harness.warmCall('overview');
    console.log(`[i] warm overview isError=${overview.isError} text=${overview.text.slice(0, 160)}`);
    assert.equal(overview.isError, false, `a warm client must accept the overview reading (text=${overview.text})`);
    const payload = overview.payload as AnyRecord;
    for (const key of ['running', 'awaitingPermission', 'aborted', 'hosts', 'quay'] as const) {
      assert.ok(key in payload, `an overview reading must carry "${key}"`);
    }

    // AC: the REAL reading must exercise all three `quay` arms ...
    const statuses = [...new Set((payload.quay as AnyRecord[]).map((entry) => entry.status))].sort();
    console.log(`[i] quay statuses=${JSON.stringify(statuses)}`);
    assert.deepEqual(statuses, ['cached', 'no_quay_config', 'unknown'], 'the fixture must exercise all three quay arms');

    // ... and the declared shape (the real one, not the placeholder) must accept it.
    const parsed = z.object(overviewOutputSchema).strict().safeParse(payload);
    assert.equal(
      parsed.success,
      true,
      `the real reading must match the declared shape${parsed.success ? '' : `: ${JSON.stringify(parsed.error?.issues?.slice(0, 5))}`}`,
    );
  });
});

test('(j) a WARM client reads the real PROJECT_NOT_FOUND / TARGET_AMBIGUOUS code — and the envelope validates against the ADVERTISED schema', { concurrency: false }, async () => {
  // The gate's own refusal needs `resolveDeps` mounted; the two titles share
  // "shared", which is what makes the ambiguity class reachable.
  const gated: McpResolveDeps = {
    listProjects: () => [
      { id: 'proj-a', title: 'shared project alpha' },
      { id: 'proj-b', title: 'shared project beta' },
    ],
    listSessions: () => [],
  };
  await withOverviewHarness(async (harness) => {
    // Both tools, both refusal classes. THE bug: on a warm client each of these
    // used to be swallowed by a `-32602 Structured content does not match the
    // tool's output schema` before the caller saw the code.
    const probes: Array<{ tool: 'sessions_list' | 'overview'; project: string; code: string }> = [
      { tool: 'sessions_list', project: 'zzz-no-such-project', code: 'PROJECT_NOT_FOUND' },
      { tool: 'sessions_list', project: 'shared', code: 'TARGET_AMBIGUOUS' },
      { tool: 'overview', project: 'zzz-no-such-project', code: 'PROJECT_NOT_FOUND' },
      { tool: 'overview', project: 'shared', code: 'TARGET_AMBIGUOUS' },
    ];
    const results: Array<{ tool: string; call: ToolCall }> = [];
    for (const probe of probes) {
      const call = await harness.warmCall(probe.tool, { project: probe.project });
      console.log(`[j] ${probe.tool}(${probe.project}) isError=${call.isError} code=${String(call.payload?.code)} text=${call.text}`);
      assert.equal(call.isError, true, `${probe.tool} must refuse (text=${call.text})`);
      assert.equal(
        call.payload?.code,
        probe.code,
        `${probe.tool} on a warm client must read the gateway's own code, not a -32602 validation failure`,
      );
      results.push({ tool: probe.tool, call });
    }

    // The ambiguity envelope still carries its candidate list.
    for (const { tool, call } of results.filter((entry) => entry.call.payload?.code === 'TARGET_AMBIGUOUS')) {
      assert.ok(
        Array.isArray((call.payload?.details as AnyRecord | undefined)?.candidates),
        `${tool}'s ambiguity envelope must still carry its candidate list`,
      );
    }

    // AC: the returned `{code,message,retryable,details}` validates against the
    // MERGED output schema — the one the wrapper handed to the SDK, read back
    // verbatim off `tools/list`, validated with the same ajv family the SDK uses.
    const listed = await harness.listTools();
    // The SDK's OWN validator (the same ajv 8 the client compiles from
    // `tools/list`), so the check below cannot drift from what a real client does.
    const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv');
    const validator = new AjvJsonSchemaValidator();
    for (const { tool, call } of results) {
      const advertised = listed.find((entry) => entry.name === tool)?.outputSchema;
      assert.ok(advertised, `${tool} must advertise an outputSchema`);
      const check = validator.getValidator(advertised as Record<string, unknown>)(call.payload);
      assert.equal(
        check.valid,
        true,
        `${tool}'s error envelope must match its advertised outputSchema: ${check.errorMessage ?? ''}`,
      );
    }
  }, { resolveDeps: gated });
});
