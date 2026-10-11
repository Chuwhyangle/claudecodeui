/**
 * AC-248 criterion: `run_get` reads one run by id and waits a BOUNDED time for
 * it to settle.
 *
 * Everything driving the reading is real except the seams the task names: a real
 * express 4 application carries the production `/mcp` mount behind the
 * production token middleware; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`; the database is a real better-sqlite3 file in
 * a temp directory. The fake runtime is a REAL `createChatRunRegistry` (injected
 * clock + boot) and a REAL `createActivityStore` (injected clock, boot and turn
 * reader), with the wait loop's sleeper injected so it advances the fake clock
 * and, at scripted instants, completes a run or parks its turn on
 * `awaitingPermission`. `sessions.fetchHistory` is a fixed fake whose last row
 * is an assistant message.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/247's criteria document the same hazard), and the SDK's
 * `StreamableHTTPClientTransportOptions.fetch` is the seam that avoids it.
 *
 * Readings, one leg each:
 *   (a) a running run's summary carries runId/sessionId/source/status/phase/
 *       toolName/elapsedMs/bootId, phase+toolName verbatim from the injected
 *       activity store, elapsedMs from the fake clock;
 *   (b) `waitSeconds` absent and `0` both return immediately with the CURRENT
 *       (running) status and ZERO sleep calls;
 *   (c) `waitSeconds: 40` on a run that ends at the 3rd second returns then,
 *       with the closing assistant message — NOT after the full budget;
 *   (d) a turn that parks on `awaitingPermission` at the 2nd second returns
 *       early; a run that never parks does not carry that outcome;
 *   (e) `waitSeconds: 60` waits at most `MCP_RUN_GET_MAX_WAIT_SECONDS` seconds;
 *   (f) `expired` and never-issued are RUN_NOT_FOUND ERRORS (AC-287) explained
 *       in DIFFERENT words, with `details.reason` `'expired'` / `'never_issued'`,
 *       and both carry a fallback read of the session's recent messages;
 *   (g) a run whose boot differs from the current process is a RUN_NOT_FOUND
 *       error reporting the coarse reason `'expired'` while its sentence says
 *       the service restarted, with a fallback read of its own session's recent
 *       messages.
 *
 * The false forms (AC10) mutate the implementation after this criterion is
 * green; they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';
import type { TurnPhase } from '@/modules/providers/index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically (the order the provider criteria
// established).
process.env.JWT_SECRET = 'mcp-run-get-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { sessionsService } = await import('@/modules/providers/index.js');
const { createActivityStore, createChatRunRegistry } = await import('@/modules/websocket/index.js');
const { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } = await import(
  '@/modules/projects/index.js'
);
const {
  MCP_GATEWAY_PATH,
  MCP_RUN_GET_MAX_WAIT_SECONDS,
  createMcpAuthMiddleware,
  mountMcpGateway,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;

/** The instant every relative reading is measured against. */
const BASE_MS = Date.parse('2026-09-01T12:00:00.000Z');

/** The two session fixtures the activity store is told about. */
const SESSION = 'run-get-fixture';
const SESSION_QUIET = 'run-get-fixture-quiet';

/** The boot the fake process starts as. Flipping it simulates a restart. */
const BOOT_ONE = 'run-get-boot-0001';
const BOOT_TWO = 'run-get-boot-0002';

/** How far the fake clock is moved past a running run's start for leg (a). */
const SUMMARY_ELAPSED_MS = 1_234;

/** The instants, relative to a run's start, at which the fake runtime acts. */
const SETTLE_AFTER_MS = 3_000;
const AWAIT_AFTER_MS = 2_000;

const LAST_ANSWER = '最后一条助手消息：运行已结束。';

/** The fixture history leg (c) and (f) read.
 *  The last row is an assistant message — the one a settled run must attach. */
const FIXTURE_MESSAGES: NormalizedMessage[] = [
  {
    id: 'run-get-msg-user-1',
    sessionId: SESSION,
    timestamp: '2026-09-01T11:58:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: '运行是什么样的？',
  },
  {
    id: 'run-get-msg-assistant-1',
    sessionId: SESSION,
    timestamp: '2026-09-01T11:58:30.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: '还在运行。',
  },
  {
    id: 'run-get-msg-user-2',
    sessionId: SESSION,
    timestamp: '2026-09-01T11:59:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: '现在呢？',
  },
  {
    id: 'run-get-msg-assistant-last',
    sessionId: SESSION,
    timestamp: '2026-09-01T11:59:30.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: LAST_ANSWER,
  },
];

/** The last fixture row — what a settled run's `lastAssistantMessage` must equal. */
const LAST_ASSISTANT = FIXTURE_MESSAGES[FIXTURE_MESSAGES.length - 1];

// --------------------------- the fake runtime ---------------------------

type RuntimeState = {
  clock: number;
  currentBoot: string;
  phaseBySession: Map<string, TurnPhase>;
  toolBySession: Map<string, string | null>;
  /** Absolute clock instants at which a session's run should complete. */
  settleAt: Map<string, number>;
  /** Absolute clock instants at which a session's turn should park. */
  awaitAt: Map<string, number>;
  settled: Set<string>;
  awaited: Set<string>;
  sleepCount: number;
  messagesBySession: Map<string, NormalizedMessage[]>;
};

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
  registry: ReturnType<typeof createChatRunRegistry>;
  runtime: RuntimeState;
  /** Opens a running run for `session` and returns its id and start instant. */
  startRun: (session: string) => { runId: string; startedAt: number };
  sleepCalls: () => number;
};

/**
 * Runs `run` against a fresh temp database, the production `/mcp` mount, and the
 * real run registry + activity store over the injected fake runtime.
 */
async function withRunGetHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-run-get-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'run-get.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const runtime: RuntimeState = {
    clock: BASE_MS,
    currentBoot: BOOT_ONE,
    phaseBySession: new Map<string, TurnPhase>([
      [SESSION, 'tool'],
      [SESSION_QUIET, 'idle'],
    ]),
    toolBySession: new Map<string, string | null>([
      [SESSION, 'Bash'],
      [SESSION_QUIET, null],
    ]),
    settleAt: new Map<string, number>(),
    awaitAt: new Map<string, number>(),
    settled: new Set<string>(),
    awaited: new Set<string>(),
    sleepCount: 0,
    messagesBySession: new Map<string, NormalizedMessage[]>([[SESSION, FIXTURE_MESSAGES]]),
  };

  const registry = createChatRunRegistry({
    now: () => runtime.clock,
    bootId: () => runtime.currentBoot,
  });

  // The injected sleeper: the wait loop's only way to move time. It advances the
  // fake clock, counts itself, then fires the scripted transitions — a run
  // completing, a turn parking — at their instants.
  const sleep = async (ms: number): Promise<void> => {
    runtime.clock += ms;
    runtime.sleepCount += 1;
    for (const [session, at] of runtime.settleAt) {
      if (!runtime.settled.has(session) && runtime.clock >= at) {
        runtime.settled.add(session);
        registry.completeRun(session, { exitCode: 0 });
      }
    }
    for (const [session, at] of runtime.awaitAt) {
      if (!runtime.awaited.has(session) && runtime.clock >= at) {
        runtime.awaited.add(session);
        runtime.phaseBySession.set(session, 'awaitingPermission');
      }
    }
  };

  const activity = createActivityStore({
    now: () => runtime.clock,
    bootId: runtime.currentBoot,
    readTurn: (sessionId) => ({
      phase: runtime.phaseBySession.get(sessionId) ?? 'idle',
      toolName: runtime.toolBySession.get(sessionId) ?? null,
      toolDurationMs: null,
    }),
  });
  // The store returns `null` for a session it was never told about; subscribing
  // once (then unsubscribing) is what makes the fixture sessions "known", the
  // precondition for leg (a) reading a phase rather than the null note.
  for (const sessionId of [SESSION, SESSION_QUIET]) {
    activity.subscribe(sessionId, () => {})();
  }

  const tokens = createAccessTokensService({ now: () => new Date(BASE_MS) });
  const readToken = tokens.issueToken({ userId: USER_ONE, name: 'mcp-run-get', scopes: ['cloudcli:read'], expiresInDays: 30 });
  if (!readToken.ok) {
    throw new Error('the harness must mint a read token');
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools: {
      projects: {
        getProjectsWithSessions,
        getArchivedProjectsWithSessions,
        getProjectSessionsPage,
        // Required by `McpReadToolDeps.projects`; this mount wires no by-id reader.
        getProjectIdByPath: () => null,
      },
      sessions: sessionsService,
      hosts: { snapshot: () => [], liveHostForSession: () => null },
      runs: registry,
      activity,
      runGet: {
        runs: registry,
        activity,
        sessions: {
          fetchHistory: async (sessionId: string, options: { limit: number }) => ({
            messages: (runtime.messagesBySession.get(sessionId) ?? []).slice(-options.limit),
          }),
        },
        now: () => runtime.clock,
        sleep,
        bootId: () => runtime.currentBoot,
      },
      now: () => runtime.clock,
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
  const client = new Client({ name: 'ac248-criterion', version: '0.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  const harness: Harness = {
    call,
    registry,
    runtime,
    startRun: (session: string) => {
      const opened = registry.startRun({
        appSessionId: session,
        provider: 'claude' as LLMProvider,
        providerSessionId: null,
        connection: null,
        userId: null,
      });
      assert.ok(opened, `the fixture must open a run for ${session}`);
      return { runId: opened.runId, startedAt: opened.startedAt };
    },
    sleepCalls: () => runtime.sleepCount,
  };

  try {
    await run(harness);
  } finally {
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

// --------------------------- (a) summary fields ---------------------------

test('(a) a running summary carries the eight named fields verbatim', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId, startedAt } = harness.startRun(SESSION);
    harness.runtime.clock = startedAt + SUMMARY_ELAPSED_MS;

    const call = await harness.call('run_get', { runId, waitSeconds: 0 });
    assert.equal(call.isError, false, 'run_get must not error');
    const payload = call.payload as AnyRecord;
    console.log(`[a] summary = ${JSON.stringify(payload)}`);

    assert.equal(payload.runId, runId, 'the summary must carry the run id verbatim');
    assert.equal(payload.sessionId, SESSION, 'the summary must carry the session id');
    assert.equal(payload.source, 'scheduled', 'a connection-less run is a scheduled run');
    assert.equal(payload.status, 'running', 'the run is still running');
    assert.equal(payload.phase, 'tool', 'phase must come from the injected activity store verbatim');
    assert.equal(payload.toolName, 'Bash', 'toolName must come from the injected activity store verbatim');
    assert.equal(payload.elapsedMs, SUMMARY_ELAPSED_MS, 'elapsedMs must be the fake clock minus startedAt');
    assert.equal(payload.bootId, BOOT_ONE, 'the summary must carry the boot the run was created under');
    assert.equal((payload.startedAt as AnyRecord).iso, new Date(startedAt).toISOString(), 'startedAt must render the start instant');

    // Positive control: no field is silently undefined.
    for (const field of ['runId', 'sessionId', 'source', 'status', 'phase', 'toolName', 'elapsedMs', 'bootId']) {
      const value = payload[field];
      assert.ok(value !== undefined && value !== null && value !== '', `${field} must be present and non-empty`);
    }
  });
});

// --------------------------- (b) no waiting without a request ---------------------------

test('(b) waitSeconds absent and 0 both return immediately with zero sleep calls', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId, startedAt } = harness.startRun(SESSION);
    harness.runtime.clock = startedAt + 500;

    const byDefault = await harness.call('run_get', { runId });
    const byZero = await harness.call('run_get', { runId, waitSeconds: 0 });
    console.log(`[b] default sleepCalls=${harness.sleepCalls()} status=${JSON.stringify(byDefault.payload?.status)}`);
    console.log(`[b] explicit-0 sleepCalls=${harness.sleepCalls()} status=${JSON.stringify(byZero.payload?.status)} elapsedMs=${JSON.stringify(byZero.payload?.elapsedMs)}`);

    assert.equal(harness.sleepCalls(), 0, 'an immediate read must never sleep');
    assert.equal(byDefault.payload?.status, 'running', 'the default read returns the CURRENT status, not a terminal one');
    assert.equal(byZero.payload?.status, 'running', 'the explicit-0 read returns the CURRENT status');
    assert.equal(byZero.payload?.outcome, undefined, 'an immediate read carries no wait outcome');
  });
});

// --------------------------- (c) settle inside the budget ---------------------------

test('(c) a run that ends at the 3rd second returns then, with its last assistant message', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId, startedAt } = harness.startRun(SESSION);
    harness.runtime.settleAt.set(SESSION, startedAt + SETTLE_AFTER_MS);

    const call = await harness.call('run_get', { runId, waitSeconds: 40 });
    assert.equal(call.isError, false, 'run_get must not error');
    const payload = call.payload as AnyRecord;
    console.log(`[c] elapsedMs=${JSON.stringify(payload.elapsedMs)} status=${JSON.stringify(payload.status)} outcome=${JSON.stringify(payload.outcome)}`);
    console.log(`[c] lastAssistantMessage=${JSON.stringify((payload.lastAssistantMessage as AnyRecord | null)?.content)} fixture=${JSON.stringify(LAST_ANSWER)}`);

    assert.ok(
      (payload.elapsedMs as number) < 40_000,
      `a run that settles early must return early, got elapsedMs=${String(payload.elapsedMs)}`,
    );
    assert.ok(
      (payload.elapsedMs as number) <= SETTLE_AFTER_MS + 250,
      `it must return at the settle instant, got elapsedMs=${String(payload.elapsedMs)}`,
    );
    assert.equal(payload.status, 'completed', 'the run settled');
    assert.equal(payload.outcome, 'settled', 'the wait returned because the run settled');
    assert.deepEqual(payload.lastAssistantMessage, LAST_ASSISTANT, 'the settled reading must attach the last assistant message verbatim');
  });
});

// --------------------------- (d) awaitingPermission returns early ---------------------------

test('(d) a turn parking on awaitingPermission returns early; a run that never parks does not', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId, startedAt } = harness.startRun(SESSION);
    harness.runtime.awaitAt.set(SESSION, startedAt + AWAIT_AFTER_MS);

    const call = await harness.call('run_get', { runId, waitSeconds: 40 });
    const payload = call.payload as AnyRecord;
    console.log(`[d] parked elapsedMs=${JSON.stringify(payload.elapsedMs)} phase=${JSON.stringify(payload.phase)} outcome=${JSON.stringify(payload.outcome)} status=${JSON.stringify(payload.status)}`);

    assert.equal(call.isError, false, 'run_get must not error');
    assert.ok((payload.elapsedMs as number) < 40_000, `parking must return early, got elapsedMs=${String(payload.elapsedMs)}`);
    assert.equal(payload.outcome, 'awaitingPermission', 'the wait must name the parking reason');
    assert.equal(payload.phase, 'awaitingPermission', 'the payload must carry the parked phase verbatim');
    assert.equal(payload.status, 'running', 'the run itself has not settled');

    // Positive control: a running run that never parks carries no such outcome.
    const quiet = harness.startRun(SESSION_QUIET);
    const quietCall = await harness.call('run_get', { runId: quiet.runId, waitSeconds: 0 });
    console.log(`[d] quiet phase=${JSON.stringify(quietCall.payload?.phase)} outcome=${JSON.stringify(quietCall.payload?.outcome)}`);
    assert.equal(quietCall.payload?.phase, 'idle', 'the quiet run reads its own (non-parked) phase');
    assert.notEqual(quietCall.payload?.outcome, 'awaitingPermission', 'a run that never parked must not report that outcome');
  });
});

// --------------------------- (e) the cap ---------------------------

test('(e) a 60-second request waits at most MCP_RUN_GET_MAX_WAIT_SECONDS', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId } = harness.startRun(SESSION);

    const call = await harness.call('run_get', { runId, waitSeconds: 60 });
    const payload = call.payload as AnyRecord;
    console.log(`[e] requested=60s elapsedMs=${JSON.stringify(payload.elapsedMs)} capMs=${MCP_RUN_GET_MAX_WAIT_SECONDS * 1000} outcome=${JSON.stringify(payload.outcome)} status=${JSON.stringify(payload.status)}`);

    assert.equal(call.isError, false, 'run_get must not error');
    assert.ok(
      (payload.elapsedMs as number) <= MCP_RUN_GET_MAX_WAIT_SECONDS * 1000,
      `the wait must be capped, got elapsedMs=${String(payload.elapsedMs)}`,
    );
    assert.equal(payload.outcome, 'timeout', 'an unending run must report a timeout');
    assert.equal(payload.status, 'running', 'the timeout reading returns the current summary');
  });
});

// --------------------------- (f) expired vs unknown ---------------------------

test('(f) expired and never-issued are RUN_NOT_FOUND errors, explained differently, both carrying a fallback read', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId } = harness.startRun(SESSION);
    harness.registry.completeRun(SESSION, { exitCode: 0 });
    // Push the fake clock past the registry's retention window so the terminal
    // run is no longer returned by `getRunById` (its record is still held).
    harness.runtime.clock += 5 * 60 * 1000 + 1;

    const expired = await harness.call('run_get', { runId, session: SESSION });
    const expiredPayload = (expired.payload?.details ?? {}) as AnyRecord;
    const unknownId = 'run-get-never-issued';
    const unknown = await harness.call('run_get', { runId: unknownId, session: SESSION });
    const unknownPayload = (unknown.payload?.details ?? {}) as AnyRecord;

    console.log(`[f] expired code=${JSON.stringify(expired.payload?.code)} reason=${JSON.stringify(expiredPayload.reason)} message=${JSON.stringify(expired.payload?.message)}`);
    console.log(`[f] unknown code=${JSON.stringify(unknown.payload?.code)} reason=${JSON.stringify(unknownPayload.reason)} message=${JSON.stringify(unknown.payload?.message)}`);
    console.log(`[f] expired fallback=${JSON.stringify(expiredPayload.fallback)}`);

    // AC-287: a run id naming nothing this process has is an ERROR, not a
    // `status:'unknown'` success reading. The replacements are stronger: they
    // name the code, the cause and its discrimination, and read the fallback out
    // of `details`, which is where the context now rides.
    assert.equal(expired.isError, true, 'an expired run is an error');
    assert.equal(expired.payload?.code, 'RUN_NOT_FOUND', 'the expired error carries RUN_NOT_FOUND');
    assert.equal(unknown.isError, true, 'a never-issued run is an error');
    assert.equal(unknown.payload?.code, 'RUN_NOT_FOUND', 'the never-issued error carries RUN_NOT_FOUND');
    assert.equal(expiredPayload.reason, 'expired', 'a run past its retention window reads expired');
    assert.equal(unknownPayload.reason, 'never_issued', 'an id never handed out reads never_issued');
    assert.notEqual(expiredPayload.reason, unknownPayload.reason, 'the two causes are distinguished, not collapsed');
    assert.notEqual(expired.payload?.message, unknown.payload?.message, 'the two explanations must be different text');
    assert.match(String(expired.payload?.message), /retention/, 'the expired explanation must say the run aged out');
    assert.match(String(unknown.payload?.message), /never issued/, 'the never-issued explanation must say the id was never issued');

    assert.deepEqual(
      (expiredPayload.fallback as AnyRecord).messages,
      FIXTURE_MESSAGES,
      'the expired fallback must read the session\'s recent messages verbatim',
    );
    assert.deepEqual(
      (unknownPayload.fallback as AnyRecord).messages,
      FIXTURE_MESSAGES,
      'the never-issued fallback must read the session\'s recent messages verbatim',
    );

    // Positive control: the expired fallback is really populated.
    assert.ok(((expiredPayload.fallback as AnyRecord).messages as unknown[]).length > 0, 'the expired fallback must not be empty');
  });
});

// --------------------------- (g) restarted ---------------------------

test('(g) a run from a previous boot is RUN_NOT_FOUND (reason expired) saying restarted, with its session fallback', { concurrency: false }, async () => {
  await withRunGetHarness(async (harness) => {
    const { runId } = harness.startRun(SESSION);

    const first = await harness.call('run_get', { runId, waitSeconds: 0 });
    const firstBoot = (first.payload as AnyRecord).bootId;

    // The process "restarts": the current boot changes while the run's record
    // (which belongs to the old boot) is still held.
    harness.runtime.currentBoot = BOOT_TWO;
    const second = await harness.call('run_get', { runId, waitSeconds: 0 });
    const secondPayload = (second.payload?.details ?? {}) as AnyRecord;

    console.log(`[g] first bootId=${JSON.stringify(firstBoot)}`);
    console.log(`[g] second code=${JSON.stringify(second.payload?.code)} bootId=${JSON.stringify(secondPayload.bootId)} reason=${JSON.stringify(secondPayload.reason)} message=${JSON.stringify(second.payload?.message)}`);

    // AC-287: a previous boot's run is an error too — the id no longer names
    // anything THIS process has. Its reportable reason is the coarse `'expired'`
    // (AC-287 names only two), while its SENTENCE still says the service
    // restarted; the stronger assertions below pin both halves separately.
    assert.equal(second.isError, true, 'a restarted run is an error');
    assert.equal(second.payload?.code, 'RUN_NOT_FOUND', 'the restarted error carries RUN_NOT_FOUND');
    assert.equal(secondPayload.reason, 'expired', 'a previous boot\'s run reports the coarse expired reason');
    assert.match(String(second.payload?.message), /restarted/i, 'the explanation must say the service restarted');
    assert.doesNotMatch(
      String(second.payload?.message),
      /retention/,
      'the restarted sentence is its own text, not the plain retention-expired one',
    );
    assert.equal(secondPayload.bootId, BOOT_TWO, 'the details name the boot that answered');
    assert.notEqual(secondPayload.bootId, firstBoot, 'the two readings must expose the two different boots');
    assert.deepEqual(
      (secondPayload.fallback as AnyRecord).messages,
      FIXTURE_MESSAGES,
      'the restarted fallback must read the run\'s own session messages verbatim',
    );
  });
});
