/**
 * AC-249 criterion: `session_send` opens a run through the SAME control service
 * the WebSocket gateway uses and returns its id at once, and the run it opens is
 * the same KIND of run a UI send opens.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are debug-agent
 * fixtures (`armDebugAgentScenario`) whose resident / per-run turns walk a real
 * scenario; the control service is the real `createChatControlService` over a
 * real `createProviderRuntimeService`, shared — as one object — by the MCP
 * gateway and the WebSocket chat handler.
 *
 * The debug agent's gate is read ONCE per process and cached, and
 * `provider.registry.ts` builds its debug provider at module load. This file
 * therefore has NO static application imports: it opens `DEBUG_AGENT` (and
 * redirects `HOME` into a scratch directory) BEFORE any aliased module is
 * pulled in, and every application module below comes in dynamically. A child
 * process per arm is not needed because the gate is read at the right instant
 * here.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) `session_send` returns WHILE the run is still running; the returned
 *       runId equals the registry's current run, whose source is `mcp`, and the
 *       session appears in `listRunningRuns()` and in the REST running list;
 *   (b) the control service's caller is the token's owner (non-null);
 *   (c) a resident session that is busy queues, handing over the driver's own
 *       queue-tail uuid;
 *   (d) a per-run session that is busy is refused with the gateway's one
 *       "session busy" code, `SESSION_BUSY` (the control service's own word for
 *       it, `RUN_IN_PROGRESS`, is normalized at the envelope boundary so every
 *       tool naming "the session is busy" says the same thing), carrying the
 *       in-flight runId and a hint naming `run_get`;
 *   (e) `waitSeconds: 40` returns at the 3rd second with the closing assistant
 *       message, NOT after the budget;
 *   (f) a token lacking `cloudcli:session:send` is denied, one `denied` audit
 *       row is written, and the control service is never called;
 *   (g) the WebSocket `chat.send` and the MCP `session_send` reach the same
 *       control-service instance (both bump one spy).
 *   (h) a QUEUED `session_send` names the pending request it is parked behind:
 *       with a real `AskUserQuestion` parked on the busy session, `blockedBy` is
 *       non-null and byte-identical to the `approvals_list({session})` entry
 *       minus its `session` and to `session_get(session).pendingInteraction`,
 *       and the named park is answerable through `approval_answer`. The positive
 *       control is split: a send that OPENS a run (`queued:false`) reads
 *       `blockedBy: null` here, and (c) reads the same `queued: true` busy path
 *       with nothing pending, which also reads `blockedBy: null` — so `blockedBy`
 *       is a reading of the pending set, not a constant the queued path fills.
 *
 * The false forms (AC10) mutate the implementation after this criterion is
 * green; they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

// --------------------------------------------------------------------------
// The environment is set BEFORE any aliased module is imported: the debug
// agent's gate is cached on first read, `provider.registry.ts` reads it at
// module load, and `shared/utils.ts` freezes IS_PLATFORM on first import.
//
// The gate variable is spelled through constants, exactly as the debug agent's
// own criteria do: `server/modules/debug-agent/tests/debug-agent-gate.test.ts`
// asserts that, outside the gate module, `server/` contains no direct read of
// it. The gate module stays the only parser; this file only sets the fixture
// before the first parse happens.
// --------------------------------------------------------------------------
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-send-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
process.env.JWT_SECRET = 'mcp-session-send-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const {
  createProviderRuntimeService,
  describeApprovalPolicy,
  providerRegistry,
  requestClientToolDecision,
} = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const {
  BOOT_ID,
  chatRunRegistry,
  connectedClients,
  createChatControlService,
  handleChatConnection,
} = await import('@/modules/websocket/index.js');
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario } = await import('@/modules/debug-agent/index.js');
const { MCP_GATEWAY_PATH, MCP_STAGE4_WRITE_TOOLS, buildRunGet, createMcpAuthMiddleware, mountMcpGateway } = await import(
  '../index.js'
);

type AnyRecord = Record<string, unknown>;
type ChatControlService = ReturnType<typeof createChatControlService>;
type RuntimeService = ReturnType<typeof createProviderRuntimeService>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const DEBUG_PROVIDER = DEBUG_AGENT_PROVIDER_ID as LLMProvider;
const SESSION_SEND_SCOPE = 'cloudcli:session:send';
const READ_SCOPE = 'cloudcli:read';
const APPROVE_SCOPE = 'cloudcli:approve';

/** How long the fixture walk keeps a round running, so a reading can land mid-turn. */
const RUN_ALIVE_MS = 1_200;
/** The instant (ms into the run) the injected sleeper settles the (e) run. */
const SETTLE_AFTER_MS = 3_000;

const LAST_ANSWER = '最后一条助手消息：运行已结束。';

/** The fixed history `run_get` reads on settle; the last row is an assistant message. */
const FIXTURE_MESSAGES: NormalizedMessage[] = [
  {
    id: 'ac249-msg-user',
    sessionId: 'ignored',
    timestamp: '2026-09-01T11:59:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: '运行结束了吗？',
  },
  {
    id: 'ac249-msg-assistant-last',
    sessionId: 'ignored',
    timestamp: '2026-09-01T11:59:30.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: LAST_ANSWER,
  },
];
const LAST_ASSISTANT = FIXTURE_MESSAGES[FIXTURE_MESSAGES.length - 1];

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`session-send ${line}`);
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

// --------------------------- tool result parsing ---------------------------

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

// --------------------------- the fake WebSocket ---------------------------

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRecord[];
  send(data: string): void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    try {
      socket.frames.push(JSON.parse(data) as AnyRecord);
    } catch {
      socket.frames.push({ raw: data });
    }
  };
  return socket;
}

// --------------------------- the control-service spy ---------------------------

type SpyCaller = { userId: string | number | null; via: string };

type SpyControl = {
  counts: { send: number };
  callers: SpyCaller[];
  control: ChatControlService;
};

/**
 * Wraps the real control service so every `send` records the caller and bumps a
 * counter, then delegates. The SAME object is handed to the MCP gateway and to
 * `handleChatConnection`, so "one instance, two front ends" is a count on one
 * object rather than two that merely look alike.
 */
function wrapControl(real: ChatControlService): SpyControl {
  const counts = { send: 0 };
  const callers: SpyCaller[] = [];
  const control = {
    ...real,
    send: async (...args: Parameters<ChatControlService['send']>) => {
      counts.send += 1;
      callers.push({ userId: args[0].userId, via: args[0].via });
      return real.send(...args);
    },
  };
  return { counts, callers, control };
}

// --------------------------- scenario building ---------------------------

type LifecycleMode = 'resident' | 'per-run';

/**
 * A scenario whose walk keeps the round running for `runAliveMs`, so a reading
 * can be taken mid-turn. The typed turn row is written before the walk (and is
 * part of the engine's `before`), so `rows.delta` counts the walk's own rows
 * only: one `row` step, hence delta 1.
 */
function aliveScenario(label: string, mode: LifecycleMode, runAliveMs: number) {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: `ac249 ${label}`, userText: `first round for ${label}`, lifecycleMode: mode },
    steps: [{ at: runAliveMs, op: 'row', role: 'assistant', text: `${label} round finished` }],
    expect: { rows: { delta: 1 }, content: { mustContain: [`${label} round finished`] } },
  };
}

// --------------------------- harness ---------------------------

type Harness = {
  sessionId: string;
  userId: number;
  spy: SpyControl;
  runtime: RuntimeService;
  /** The HTTP port the app is listening on (for the REST running-list read). */
  port: number;
  /** The fake clock the injected `run_get` deps read. */
  clock: { value: number };
  /**
   * Arms a REAL pending approval for this arm's session through the production
   * `requestClientToolDecision`, with `requiresInteraction` taken from the same
   * `describeApprovalPolicy` the tools report. Resolves immediately (the wait
   * continues in the background); `settled` is the wait's own promise.
   */
  arm: (spec: { requestId: string; toolName: string; input: unknown }) => {
    requestId: string;
    settled: Promise<void>;
  };
  call: (name: string, args?: AnyRecord, which?: 'main' | 'readonly') => Promise<ToolCall>;
};

type HarnessOptions = {
  label: string;
  mode: LifecycleMode;
  /** The instant (ms into the run) the injected sleeper settles the run. 0 means never. */
  settleAfterMs?: number;
  /** How long this arm's fixture walk keeps a round running (default `RUN_ALIVE_MS`). */
  runAliveMs?: number;
};

/**
 * Boots one arm: a fresh temp database + fixture home, one armed debug scenario,
 * the real runtime gateway over the debug provider, the real control service
 * wrapped by the spy, and the production `/mcp` mount carrying the write tools.
 */
async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const fixtureProject = path.join(tempDirectory, options.label);
  const runAliveMs = options.runAliveMs ?? RUN_ALIVE_MS;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-send.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const debugProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
  const hostDriver = debugProvider.hostDriver;
  assert.ok(hostDriver, 'the debug provider must carry a host driver (the gate is open)');

  const armed = await armDebugAgentScenario({
    projectPath: fixtureProject,
    scenario: aliveScenario(options.label, options.mode, runAliveMs),
    synchronizeTranscript: (filePath) => debugProvider.sessionSynchronizer.synchronizeFile(filePath),
    setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
  });

  const manager = createSessionHostManager({ scheduler: { schedule: () => () => {} } });
  if (options.mode === 'resident') {
    const bound = await manager.bindSession({
      provider: DEBUG_PROVIDER,
      appSessionId: armed.sessionId,
      driver: hostDriver,
      mode: 'resident',
    });
    assert.ok(bound.ok, `the resident arm must land on a host (got ${JSON.stringify(bound)})`);
  }

  const runtime = createProviderRuntimeService({
    sessionHostManager: manager,
    resolveProvider: (name) =>
      name === DEBUG_AGENT_PROVIDER_ID ? debugProvider : providerRegistry.resolveProvider(name),
  });

  // The approval verbs' candidate set is named explicitly, exactly as every
  // sibling approval criterion does (`mcp-approvals.test.ts`,
  // `mcp-pending-interaction.test.ts`): a RESIDENT session's turn runs inside
  // its persistent host process, so it is not necessarily in
  // `chatRunRegistry.listRunningRuns()` at the instant a leg answers a park, and
  // the documented seam exists to name the one candidate this arm has. Only the
  // answer path's lookup uses it — `blockedBy` is still read from the runtime's
  // own pending set through `getPendingApprovalsForSession`.
  const realControl = createChatControlService({ runtime, listApprovalSessionIds: () => [armed.sessionId] });
  const spy = wrapControl(realControl);

  const clock = { value: Date.now() };

  const tokens = createAccessTokensService({ now: () => new Date() });
  const mainToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac249-main',
    scopes: [READ_SCOPE, SESSION_SEND_SCOPE, APPROVE_SCOPE],
    expiresInDays: 30,
  });
  const readToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac249-read',
    scopes: [READ_SCOPE],
    expiresInDays: 30,
  });
  if (!mainToken.ok || !readToken.ok) {
    throw new Error('the harness must mint both tokens');
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    // The stage-3 read tools (so `session_get` answers) and the stage-6 resident
    // tools (so `approvals_list` / `approval_answer` register), both over the
    // SAME pending set the write tools read: the runtime service's own lookup.
    // Leg (h) reads all three surfaces at one instant, so a divergence would be
    // a red rather than a coincidence the fixture arranged.
    readTools: {
      projects: {
        getProjectsWithSessions: async () => [],
        getArchivedProjectsWithSessions: async () => [],
        getProjectSessionsPage: async () => ({ projectId: '', sessions: [] }),
      },
      sessions: {
        listRecentSessions: () => ({
          conversations: [
            {
              sessionId: armed.sessionId,
              provider: DEBUG_AGENT_PROVIDER_ID,
              projectId: null,
              sessionTitle: `ac249 ${options.label}`,
              lastActivity: null,
            },
          ],
          total: 1,
        }),
        readSessionLifecycle: () => null,
        fetchHistory: async () => ({ messages: [], total: 0 }),
        fetchOutline: async () => ({ total: 0, turns: [] }),
        fetchWindowAround: async () => ({ messages: [], startIndex: 0, total: 0 }),
      },
      hosts: { snapshot: () => [], liveHostForSession: () => null },
      runs: { listRunningRuns: () => [], listRecentRuns: () => [] },
      approvals: {
        pendingForSession: (sessionId: string) =>
          runtime.getPendingApprovalsForSession(sessionId) as never,
      },
      now: () => clock.value,
    },
    residentTools: {
      control: spy.control,
      approvals: { control: spy.control, now: () => clock.value },
    },
    writeTools: {
      control: spy.control,
      runs: { getRun: (sessionId: string) => chatRunRegistry.getRun(sessionId) },
      // The SAME pending set the read tools and the approval tools read.
      approvals: {
        pendingForSession: (sessionId: string) =>
          runtime.getPendingApprovalsForSession(sessionId) as never,
        now: () => clock.value,
      },
      runGet: {
        deps: {
          runs: chatRunRegistry,
          activity: { snapshot: () => null },
          sessions: { fetchHistory: async () => ({ messages: FIXTURE_MESSAGES }) },
          now: () => clock.value,
          sleep: async (ms: number) => {
            clock.value += ms;
            if (options.settleAfterMs && options.settleAfterMs > 0) {
              const startedAt = chatRunRegistry.getRun(armed.sessionId)?.startedAt ?? clock.value;
              if (clock.value - startedAt >= options.settleAfterMs) {
                chatRunRegistry.completeRun(armed.sessionId, { exitCode: 0 });
              }
            }
          },
          bootId: () => BOOT_ID,
        },
        build: buildRunGet,
      },
    },
  });

  // The REST "running list" reader. In production this is
  // `GET /api/providers/sessions/running`, whose data source IS
  // `chatRunRegistry.listRunningRuns()`; here it is mounted on the same app and
  // reads the registry live at request time, so leg (a) reads the real source
  // rather than a snapshot the fixture typed.
  app.get('/api/providers/sessions/running', (_req, res) => {
    res.json({ sessions: chatRunRegistry.listRunningRuns().map((entry) => ({ sessionId: entry.sessionId })) });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac249-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const main = await connect(mainToken.token.token);
  const readonly = await connect(readToken.token.token);

  const callWith = async (client: Client, name: string, args: AnyRecord): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  // When the fixture's first `session_send` ran, so teardown can let its walk
  // finish before the transcript directory is removed. A walk still writing
  // after `rm` would recreate a one-row artifact and make the scenario report a
  // spurious row-delta failure.
  let firstSendAt = 0;

  try {
    await run({
      sessionId: armed.sessionId,
      userId: USER_ONE,
      spy,
      runtime,
      port: address.port,
      clock,
      arm(spec) {
        const settled = requestClientToolDecision({
          toolName: spec.toolName,
          input: spec.input,
          requiresInteraction: describeApprovalPolicy(spec.toolName).interactive,
          requestId: spec.requestId,
          ws: { send: () => undefined } as never,
          emitNotification: () => undefined,
          sessionId: armed.sessionId,
          sessionSummary: null,
        });
        // The wait continues in the background; the leg answers it. The settled
        // promise is surfaced so a leg can await the park's own resolution.
        return { requestId: spec.requestId, settled: settled.then(() => undefined, () => undefined) };
      },
      call: (name, args = {}, which = 'main') => {
        if (name === 'session_send' && firstSendAt === 0) {
          firstSendAt = Date.now();
        }
        return callWith(which === 'readonly' ? readonly.client : main.client, name, args);
      },
    });
  } finally {
    if (firstSendAt > 0) {
      const settleBy = firstSendAt + runAliveMs + 500;
      while (Date.now() < settleBy) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await main.transport.close().catch(() => undefined);
    await readonly.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connectedClients.clear();
    chatRunRegistry.clearAll();
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
 * The debug host driver's own queue for a session, read through the registry's
 * provider so the fixture never invents the uuid it compares against.
 */
function hostDriverQueue(sessionId: string): { list: string[]; tail: string | null } {
  const driver = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID).hostDriver as unknown as {
    readCommandQueue(sessionId: string): { queued: string[] };
  };
  const list = driver.readCommandQueue(sessionId).queued;
  return { list, tail: list.length > 0 ? list[list.length - 1] : null };
}

// --------------------------- (a)/(b) immediate + same kind of run ---------------------------

test('(a)/(b) session_send returns while running, with source mcp and the token owner as caller', { concurrency: false }, async () => {
  await withHarness({ label: 'immediate', mode: 'resident' }, async (harness) => {
    const sessionId = harness.sessionId;
    const call = await harness.call('session_send', { session: sessionId, message: 'hello from mcp' });
    assert.equal(call.isError, false, `session_send must not error (text=${call.text})`);
    const payload = call.payload as AnyRecord;

    const current = chatRunRegistry.getRun(sessionId);
    const byId = chatRunRegistry.getRunById(String(payload.runId));
    const running = chatRunRegistry.listRunningRuns().filter((entry) => entry.sessionId === sessionId);

    say(`(a) payload=${JSON.stringify(payload)}`);
    say(
      `(a) registry.current=${JSON.stringify({ runId: current?.runId, source: current?.source, status: current?.status })}`,
    );
    say(`(a) registry.byId=${JSON.stringify(byId)}`);
    say(`(a) listRunningRuns(for session)=${JSON.stringify(running)}`);

    // The tool returned WHILE the run is still running — the immediacy reading.
    assert.equal(current?.status, 'running', 'the run must still be running when the tool returns');
    assert.ok(typeof payload.runId === 'string' && payload.runId.length > 0, 'the payload must carry a non-empty runId');
    assert.equal(payload.runId, current?.runId, 'the returned runId must be the registry current run verbatim');
    assert.equal(payload.source, 'mcp', 'the run source must read mcp');
    assert.ok(byId && 'source' in byId, 'a positive control: the run must be reachable by id');
    assert.equal((byId as { source?: string }).source, 'mcp', 'getRunById(runId).source must be mcp');
    assert.equal((byId as { status?: string }).status, 'running', 'getRunById(runId).status must be running');
    assert.equal(running.length, 1, 'listRunningRuns must contain the session');
    assert.equal(running[0].sessionId, sessionId);

    // The REST "running list" — a real GET against the real app.
    const restResponse = await nodeFetch(new URL(`http://127.0.0.1:${harness.port}/api/providers/sessions/running`), {});
    const restBody = (await restResponse.json()) as { sessions: Array<{ sessionId: string }> };
    const restIds = restBody.sessions.map((entry) => entry.sessionId);
    say(`(a) GET /api/providers/sessions/running sessions=${JSON.stringify(restIds)}`);
    assert.ok(restIds.includes(sessionId), 'the REST running list must contain the session');

    // (b) the caller the control service received is the token owner.
    const caller = harness.spy.callers.at(-1);
    const runWriterUserId = current?.writer?.userId ?? null;
    say(
      `(b) spy.callers=${JSON.stringify(harness.spy.callers)} tokenOwner=${USER_ONE} runWriterUserId=${JSON.stringify(runWriterUserId)}`,
    );
    assert.equal(caller?.userId, USER_ONE, 'the control service caller must be the token owner');
    assert.notEqual(caller?.userId, null, 'the caller must not be null');
    assert.equal(caller?.via, 'mcp', 'the caller must identify as mcp');
    assert.equal(runWriterUserId, USER_ONE, 'the run registry run must record the owner as its user');
  });
});

// --------------------------- (c) resident busy queue ---------------------------

test('(c) a busy resident session queues and hands over the driver queue-tail uuid', { concurrency: false }, async () => {
  await withHarness({ label: 'queued', mode: 'resident' }, async (harness) => {
    const sessionId = harness.sessionId;

    const first = await harness.call('session_send', { session: sessionId, message: 'first' });
    assert.equal(first.isError, false, `the first send must register (text=${first.text})`);
    assert.equal(first.payload?.queued, false, 'an unbusy send is not queued');

    const second = await harness.call('session_send', { session: sessionId, message: 'second' });
    assert.equal(second.isError, false, `the busy send must queue, not throw (text=${second.text})`);
    const payload = second.payload as AnyRecord;

    const queue = hostDriverQueue(sessionId);
    say(`(c) first=${JSON.stringify(first.payload)} second=${JSON.stringify(payload)} queue=${JSON.stringify(queue)}`);

    assert.equal(payload.queued, true, 'a resident busy send reports queued');
    assert.ok(
      typeof payload.queuedMessageUuid === 'string' && payload.queuedMessageUuid.length > 0,
      'the busy send must hand over a non-empty queuedMessageUuid',
    );
    assert.equal(
      payload.queuedMessageUuid,
      queue.tail,
      'the handed-over uuid must be the driver queue tail, not a value the adapter minted',
    );
    // (AC4, busy half) Nothing is parked on this session, so the queued send is
    // NOT blocked — the positive control that `blockedBy` reads the pending set
    // rather than always naming something on the queued path. (Leg (h) reads the
    // same field non-null with a real park present.)
    assert.equal(payload.blockedBy, null, 'a busy session with no pending request is not blocked');
    say(`(c) busy-no-pending blockedBy=${JSON.stringify(payload.blockedBy ?? null)}`);
  });
});

// --------------------------- (d) per-run busy refusal ---------------------------

test('(d) a busy per-run session is refused with the in-flight runId and a run_get hint', { concurrency: false }, async () => {
  await withHarness({ label: 'perrun-busy', mode: 'per-run' }, async (harness) => {
    const sessionId = harness.sessionId;

    const first = await harness.call('session_send', { session: sessionId, message: 'first' });
    assert.equal(first.isError, false, `the first send must register (text=${first.text})`);
    const firstRunId = String(first.payload?.runId);

    const second = await harness.call('session_send', { session: sessionId, message: 'second' });
    const body = second.payload as AnyRecord;
    say(`(d) firstRunId=${firstRunId} errorBody=${JSON.stringify(body)} isError=${second.isError}`);

    assert.equal(second.isError, true, 'a per-run busy session must be refused');
    assert.equal(
      body.code,
      'SESSION_BUSY',
      'the refusal must use the gateway-wide "session busy" code (the control service says RUN_IN_PROGRESS)',
    );
    const details = body.details as AnyRecord;
    assert.equal(details.runId, firstRunId, 'the refusal must carry the in-flight run id');
    assert.match(String(details.hint), /run_get/, 'the hint must name run_get');
    assert.match(String(details.hint), /retry later/, 'the hint must say the call may be retried later');
  });
});

// --------------------------- (e) bounded wait ---------------------------

test('(e) waitSeconds returns early with the closing assistant message', { concurrency: false }, async () => {
  await withHarness({ label: 'waiting', mode: 'per-run', settleAfterMs: SETTLE_AFTER_MS }, async (harness) => {
    const sessionId = harness.sessionId;
    const startedReal = Date.now();
    const call = await harness.call('session_send', {
      session: sessionId,
      message: 'wait for me',
      waitSeconds: 40,
    });
    const realElapsedMs = Date.now() - startedReal;
    assert.equal(call.isError, false, `the waiting send must not error (text=${call.text})`);
    const payload = call.payload as AnyRecord;
    const run = payload.run as AnyRecord | undefined;
    say(`(e) payload=${JSON.stringify(payload)} realElapsedMs=${realElapsedMs}`);

    assert.ok(run, 'a waiting send must attach the run reading');
    assert.ok(
      (run.elapsedMs as number) < 40_000,
      `the wait must be bounded, got elapsedMs=${String(run.elapsedMs)}`,
    );
    assert.ok(realElapsedMs < 40_000, `the call must return well inside the budget, got realElapsedMs=${realElapsedMs}`);
    assert.equal(run.status, 'completed', 'the run settled');
    assert.equal(run.outcome, 'settled', 'the wait returned because the run settled');
    assert.deepEqual(
      run.lastAssistantMessage,
      LAST_ASSISTANT,
      'the settled reading must attach the fixture last assistant message verbatim',
    );
  });
});

// --------------------------- (f) scope denied + audit ---------------------------

test('(f) a token lacking the write scope is denied, audits one denied row, and never calls the control service', { concurrency: false }, async () => {
  await withHarness({ label: 'denied', mode: 'per-run' }, async (harness) => {
    const before = mcpAuditLogDb.count();
    const sendCallsBefore = harness.spy.counts.send;

    const call = await harness.call('session_send', { session: harness.sessionId, message: 'denied' }, 'readonly');
    const sendCallsAfter = harness.spy.counts.send;
    const newRows = mcpAuditLogDb.allRows().filter((row) => row.id > before);

    say(
      `(f) isError=${call.isError} text=${JSON.stringify(call.text)} sendCallsBefore=${sendCallsBefore} sendCallsAfter=${sendCallsAfter}`,
    );
    say(`(f) newAuditRows=${JSON.stringify(newRows)}`);

    assert.equal(call.isError, true, 'a token lacking the write scope must be denied');
    assert.equal(newRows.length, 1, 'exactly one audit row must be written');
    assert.equal(newRows[0].tool, 'session_send', 'the audit row must name session_send');
    assert.equal(newRows[0].outcome, 'denied', 'the audit row must read denied');
    // AC-286: the denied row carries the scope the caller was missing.
    assert.deepEqual(
      JSON.parse(newRows[0].denied_scopes ?? 'null'),
      [SESSION_SEND_SCOPE],
      'the denied row must carry the missing send scope',
    );
    assert.equal(sendCallsBefore, 0, 'the control service was not called before the denied call');
    assert.equal(sendCallsAfter, 0, 'the control service must NOT be called for a denied tool');
  });
});

// --------------------------- (g) one control service instance ---------------------------

test('(g) the WebSocket chat.send and the MCP session_send reach the same control service', { concurrency: false }, async () => {
  await withHarness({ label: 'same-instance', mode: 'per-run' }, async (harness) => {
    const sessionId = harness.sessionId;
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: USER_ONE } } as never, {
      runtime: harness.runtime,
      control: harness.spy.control,
    } as never);

    const before = harness.spy.counts.send;
    const handler = socket.listeners('message')[0] as unknown as (raw: unknown) => Promise<void>;
    void handler(JSON.stringify({ type: 'chat.send', sessionId, content: 'from ws' }));
    await waitFor(() => harness.spy.counts.send === before + 1, 5_000, 'the WebSocket send to reach the spy');
    const wsCount = harness.spy.counts.send;

    const call = await harness.call('session_send', { session: sessionId, message: 'from mcp' });
    void call;
    const mcpCount = harness.spy.counts.send;

    say(
      `(g) before=${before} wsCount=${wsCount} mcpCount=${mcpCount} ` +
        `callers=${JSON.stringify(harness.spy.callers)}`,
    );

    assert.equal(wsCount, before + 1, 'the WebSocket chat.send must bump the one spy by one');
    assert.equal(mcpCount, wsCount + 1, 'the MCP session_send must bump the SAME spy by one more');
    assert.deepEqual(
      harness.spy.callers.slice(-2).map((caller) => caller.via),
      ['websocket', 'mcp'],
      'the two front ends must reach the one control service',
    );
  });
});

// --------------------------- (h) a queued send names its blocker ---------------------------

/** The `AskUserQuestion` input leg (h) parks and compares across the three surfaces. */
function askInput(): AnyRecord {
  return {
    questions: [
      {
        question: 'Which route should the run take?',
        header: 'Route',
        options: [
          { label: 'A', description: 'the direct route' },
          { label: 'B', description: 'the scenic route' },
        ],
      },
    ],
  };
}

test('(h) a queued send reports the pending request blocking it, byte-identical to approvals_list and session_get', { concurrency: false }, async () => {
  // The walk is kept alive well past the leg's own work so the AC4 "busy, but
  // nothing pending" reading is taken while the run is still going — answering
  // the park must clear the BLOCKER, not the busy state.
  await withHarness({ label: 'blocked', mode: 'resident' }, async (harness) => {
    const sessionId = harness.sessionId;
    const BLOCKER = 'ac-h-blocker';

    // (AC4, idle half) A send that OPENS a run is neither queued nor blocked.
    const opened = await harness.call('session_send', { session: sessionId, message: 'open the run' });
    assert.equal(opened.isError, false, `the opening send must register (text=${opened.text})`);
    assert.equal(opened.payload?.queued, false, 'an unbusy send is not queued');
    assert.equal(opened.payload?.blockedBy, null, 'a send that is not queued is never blocked');
    say(`(h) idle-open queued=${String(opened.payload?.queued)} blockedBy=${JSON.stringify(opened.payload?.blockedBy ?? null)}`);

    // Park a REAL `AskUserQuestion` on the now-busy session, through the ONE seam
    // both the resident and per-run paths ask a client through, and move the
    // injected clock so the wait this leg reads is non-trivial.
    const armed = harness.arm({ requestId: BLOCKER, toolName: 'AskUserQuestion', input: askInput() });
    harness.clock.value = Date.now() + 50;

    // (AC3) The busy send queues and names the park it is behind.
    const queued = await harness.call('session_send', { session: sessionId, message: 'queued behind the question' });
    assert.equal(queued.isError, false, `the busy send must queue, not throw (text=${queued.text})`);
    const payload = queued.payload as AnyRecord;
    const blockedBy = (payload.blockedBy ?? null) as AnyRecord | null;

    // The two tools a client already calls must agree, at the same instant.
    const list = await harness.call('approvals_list', { session: sessionId });
    const entry = (list.payload?.approvals as AnyRecord[] | undefined)?.find((row) => row.requestId === BLOCKER) ?? null;
    const detail = await harness.call('session_get', { session: sessionId });
    const interaction = (detail.payload?.pendingInteraction ?? null) as AnyRecord | null;

    say(`(h) blockedBy=${JSON.stringify(blockedBy)}`);
    say(`(h) approvals_list entry=${JSON.stringify(entry)}`);
    say(`(h) session_get pendingInteraction=${JSON.stringify(interaction)}`);

    assert.equal(payload.queued, true, 'a busy resident send reports queued');
    assert.ok(blockedBy, 'a queued send must name the pending request it is parked behind');
    assert.equal(blockedBy.requestId, BLOCKER, 'the blocker is the parked request id');
    assert.equal(blockedBy.toolName, 'AskUserQuestion', 'the blocker names the parked tool');
    assert.equal(blockedBy.interactive, true, 'an AskUserQuestion is an interactive park');
    assert.equal(blockedBy.autoTimeoutMs, null, 'an interactive park has no auto-deny deadline');

    // The three-way byte identity: one request, one projection, one instant.
    assert.ok(entry, `approvals_list must carry ${BLOCKER} (payload=${JSON.stringify(list.payload)})`);
    assert.ok(interaction, 'session_get must read the park');
    assert.deepEqual(blockedBy, interaction, 'session_send.blockedBy must BE session_get.pendingInteraction');
    const { session: _session, ...entryWithoutSession } = entry;
    assert.deepEqual(interaction, entryWithoutSession, 'session_get.pendingInteraction is the approvals_list entry minus its session');

    // The park is a REAL, answerable request, not a fixture object the adapter
    // could have echoed back: `approval_answer` resolves it through the runtime's
    // own resolver, and the call reports success. (The send SEMANTICS are
    // unchanged — the gateway never answers a park; a caller does.)
    const answered = await harness.call('approval_answer', { requestId: BLOCKER, allow: true });
    assert.equal(answered.isError, false, `the park named by blockedBy must be answerable (text=${answered.text})`);
    say(`(h) approval_answer requestId=${String(answered.payload?.requestId)} ok=${String(!answered.isError)}`);
    await armed.settled;
  });
});

// --------------------------- the stage-4 table ---------------------------

test('the stage-4 write table is exactly the five SPEC tools', () => {
  const names = MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name).sort();
  say(`(table) ${JSON.stringify(names)}`);
  assert.deepEqual(names, ['session_close', 'session_create', 'session_interrupt', 'session_send', 'session_start']);
  const send = MCP_STAGE4_WRITE_TOOLS.find((tool) => tool.name === 'session_send');
  assert.equal(send?.requiredScope, SESSION_SEND_SCOPE);
});

/** Awaits `predicate`, failing with a named line after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
