/**
 * AC-245 criterion: the stage-3 read tools answer correctly on fixture data.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are real rows whose
 * transcripts are real Claude JSONL files on disk; the resident session is bound
 * to a real `SessionHostManager` through the real `IProviderHostDriver`
 * contract, and its leases and peer name are read back out of `snapshot()`.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240's criterion documents the same hazard), and the SDK's
 * `StreamableHTTPClientTransportOptions.fetch` is the seam that avoids it
 * without giving up the SDK client.
 *
 * The resident session is driven by a scripted host driver rather than the debug
 * agent's. The debug agent's gate is read ONCE per process and cached, and
 * `provider.registry.ts` constructs its debug provider at module load — which
 * this file's own static-ish imports trigger before any environment could be
 * set, so the gate is closed for good in this process and
 * `createDebugAgentHostDriver` returns null. The manager, the binding, the lease
 * ledger and the identity sink are the SAME objects either way; only the driver
 * stub differs, and it reports through the documented sink rather than writing
 * host fields itself.
 *
 * Readings, one leg each:
 *   (a) `tools/list` is exactly the twelve stage-3 read tools, no write tool
 *       among them, every one requiring `cloudcli:read` — enforced, not just
 *       declared; this mount wires no `sessionSearch` deps, so `session_search`
 *       is registered in its body-table refusal form and is probed alongside the
 *       other owners' placeholders;
 *   (b) `projects_list`/`sessions_list` return the whole fixture, and the three
 *       `state` predicates partition it (an empty result is not an error);
 *   (c) `session_get` carries the resident session's host (state, pid, leases,
 *       peer name) and says in words that a cold session has none;
 *   (c2) `session_get` reads by id a session the 200-row recents page cannot
 *       hold, with the fields of its full-list projection (B1);
 *   (d) `session_read`'s three modes, with the tool call folded onto one line;
 *   (e) the 4000-character cursor protocol, reassembled byte for byte;
 *   (f) every time field carries the relative and ISO readings of one instant.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { HostLease, LLMProvider, ProcessHost, SessionBinding } from '@/shared/types.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically (the order the provider criteria
// established).
process.env.JWT_SECRET = 'mcp-read-tools-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { sessionsService } = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/index.js');
const { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } = await import(
  '@/modules/projects/index.js'
);
const {
  MCP_GATEWAY_PATH,
  MCP_STAGE3_READ_TOOLS,
  MCP_TEXT_CHUNK_CHARS,
  MCP_TOOL_NOT_IMPLEMENTED_CODE,
  createMcpAuthMiddleware,
  mountMcpGateway,
  paginateMcpText,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- the clock ---------------------------

/** The injected instant every relative reading is measured against. */
const NOW_ISO = '2026-09-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const PROJECT_ALPHA = 'alpha-workspace';
const PROJECT_BETA = 'beta-workspace';

const SESSION_BUSY = 'read-fixture-busy';
const SESSION_QUIET = 'read-fixture-quiet';
const SESSION_RESIDENT = 'read-fixture-resident';
const SESSION_BIG = 'read-fixture-big';

/** The name the scripted host driver reports for the resident binding. */
const PEER_NAME = 'read-fixture-peer';

/** Closed with `pid: process.pid`, so the reading is a real, live, positive pid. */
const HOST_PID = process.pid;

const BUSY_UPDATED_AT = '2026-09-01T11:05:00.000Z';
const QUIET_UPDATED_AT = '2026-09-01T11:04:00.000Z';
const RESIDENT_UPDATED_AT = '2026-09-01T11:03:00.000Z';
const BIG_UPDATED_AT = '2026-09-01T11:02:00.000Z';

// --------------------------- B1 fixture: sessions past the recents page ---------------------------

/**
 * The B1 leg seeds `DISTANT_SESSION_COUNT` sessions whose oldest sits outside
 * the 200-row page `sessions_list` reads (gap-mcp-session-get-past-recents-page-
 * and-small-envelope-defects). They all live BEFORE every named fixture session,
 * so the page is the four named rows plus the newest 196 of these.
 */
const DISTANT_SESSION_PREFIX = 'read-fixture-past-page-';
/** The globally OLDEST fixture session — the one the page cannot hold. */
const SESSION_PAST_PAGE = `${DISTANT_SESSION_PREFIX}000`;
/** One more than the page bound, so at least one seeded row is guaranteed off-page. */
const DISTANT_SESSION_COUNT = 200;
/** The instant the seeded sessions count up from — older than every named session. */
const DISTANT_BASE_MS = Date.parse('2026-08-01T00:00:00.000Z');

// --------------------------- transcript fixture ---------------------------

const FIRST_PROMPT = 'First question: what does the read tool return?';
const SECOND_PROMPT = 'Second question: does the tool call fold onto one line?';
const TOOL_CALL_ID = 'toolu_read_fixture_bash';
const TOOL_COMMAND = 'echo read-fixture-hello';
const TOOL_OUTPUT = 'read-fixture-hello';

/** The one message that must not fit in a chunk. */
const BIG_TEXT = `BIGSTART-${'汉'.repeat(1)}${'a'.repeat(5000)}-BIGEND`;

/**
 * The two raw JSONL rows that must collapse into ONE drawn line: the assistant's
 * `tool_use` and the user's `tool_result` for the same tool call.
 */
const TOOL_CALL_ROW_UUID = 'a-read-tool';
const TOOL_RESULT_ROW_UUID = 'u-read-tool-result';

function userRow(uuid: string, parentUuid: string | null, timestamp: string, text: string): AnyRecord {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_BUSY,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantRow(uuid: string, parentUuid: string, timestamp: string, text: string): AnyRecord {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_BUSY,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** The busy session's five messages, in append order. */
function buildBusyRows(): AnyRecord[] {
  return [
    userRow('u-read-1', null, '2026-09-01T11:00:00.000Z', FIRST_PROMPT),
    assistantRow('a-read-1', 'u-read-1', '2026-09-01T11:00:01.000Z', 'It reads the normalized history.'),
    {
      type: 'assistant',
      uuid: TOOL_CALL_ROW_UUID,
      parentUuid: 'a-read-1',
      timestamp: '2026-09-01T11:00:02.000Z',
      sessionId: SESSION_BUSY,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: TOOL_CALL_ID, name: 'Bash', input: { command: TOOL_COMMAND } }],
      },
    },
    {
      type: 'user',
      uuid: TOOL_RESULT_ROW_UUID,
      parentUuid: TOOL_CALL_ROW_UUID,
      timestamp: '2026-09-01T11:00:03.000Z',
      sessionId: SESSION_BUSY,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: TOOL_CALL_ID, content: `${TOOL_OUTPUT}\n` }],
      },
    },
    userRow('u-read-2', TOOL_RESULT_ROW_UUID, '2026-09-01T11:00:04.000Z', SECOND_PROMPT),
    assistantRow('a-read-2', 'u-read-2', '2026-09-01T11:00:05.000Z', 'Yes, one line.'),
  ];
}

/** The big session's two messages: a short prompt, then the over-long reply. */
function buildBigRows(): AnyRecord[] {
  return [
    userRow('u-big-1', null, '2026-09-01T11:01:00.000Z', 'Give me a very long answer.'),
    {
      type: 'assistant',
      uuid: 'a-big-1',
      parentUuid: 'u-big-1',
      timestamp: '2026-09-01T11:01:01.000Z',
      sessionId: SESSION_BIG,
      message: { role: 'assistant', content: [{ type: 'text', text: BIG_TEXT }] },
    },
  ];
}

async function writeTranscript(projectDirectory: string, sessionId: string, rows: AnyRecord[]): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

// --------------------------- the scripted host driver ---------------------------

/**
 * The smallest object that satisfies `IProviderHostDriver`.
 *
 * It reports the peer name through the sink the manager hands it — the
 * documented path — rather than writing the binding itself, so `peerName` in
 * the reading below is a value the manager recorded, not one the fixture typed
 * onto a host object. Everything the read tools do not exercise is a no-op.
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

/**
 * The SDK client's `fetch`, implemented over `node:http`.
 *
 * The server still binds `127.0.0.1:0`, but nothing is asked of undici: the
 * request and the `Response` handed back are built here, so a port undici
 * happens to refuse cannot red this criterion.
 */
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

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null; structured: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks
    .map((block) => (block as { type?: string; text?: string }).text ?? '')
    .join('');
  let payload: AnyRecord | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
  } catch {
    payload = null;
  }
  return {
    isError: call.isError === true,
    text,
    payload,
    structured: (call.structuredContent as AnyRecord | undefined) ?? null,
  };
}

type Harness = {
  readClient: Client;
  scopedClient: Client;
  /**
   * A second `cloudcli:read` connection that never calls `tools/list`. The SDK
   * Client caches each tool's output validator from `tools/list` and then
   * validates a call's `structuredContent` against it — including an `isError`
   * failure (AC-284's envelope). This cold client reads every error envelope
   * verbatim, with no dependency on how the advertised schema was assembled;
   * `readClient` stays the list-warmed client for the `tools/list` assertions
   * and success calls. (The envelope now validates on a warm client too — the
   * audited wrapper splices it into every declared output schema,
   * gap-mcp-outputschema-drift-overview-and-error-envelope — but this file keeps
   * the cold path so its probes stay independent of that assembly.)
   */
  probeClient: Client;
  transport: StreamableHTTPClientTransport;
  scopedTransport: StreamableHTTPClientTransport;
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  callWith: (client: Client, name: string, args?: AnyRecord) => Promise<ToolCall>;
};

type Fixture = {
  projectAlphaId: string | null;
  projectBetaId: string | null;
};

/**
 * Runs `run` against a fresh temp database, the real project/session/host
 * services and the production `/mcp` mount carrying AC-245's read tools.
 *
 * `options.distantSessions` seeds that many extra sessions into the alpha
 * project, all older than the four named ones, so the OLDEST of them sits past
 * the 200-row page the recents read takes — the B1 fixture. Only the leg that
 * needs it passes it, so the leg (b)/(b2) counts of the four named sessions stay
 * the counts those legs assert.
 */
async function withMcpReadTools(
  run: (harness: Harness, fixture: Fixture) => Promise<void>,
  options: { distantSessions?: number } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-read-tools-'));
  const alphaDirectory = path.join(tempDirectory, PROJECT_ALPHA);
  const betaDirectory = path.join(tempDirectory, PROJECT_BETA);
  await mkdir(alphaDirectory, { recursive: true });
  await mkdir(betaDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'read-tools.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  // ---- sessions and their transcripts ----
  const busyTranscript = await writeTranscript(alphaDirectory, SESSION_BUSY, buildBusyRows());
  const bigTranscript = await writeTranscript(alphaDirectory, SESSION_BIG, buildBigRows());
  sessionsDb.createSession(
    SESSION_BUSY, 'claude', alphaDirectory, 'Busy session', BUSY_UPDATED_AT, BUSY_UPDATED_AT, busyTranscript,
  );
  sessionsDb.createSession(
    SESSION_BIG, 'claude', alphaDirectory, 'Big session', BIG_UPDATED_AT, BIG_UPDATED_AT, bigTranscript,
  );
  sessionsDb.createSession(SESSION_QUIET, 'claude', betaDirectory, 'Quiet session', QUIET_UPDATED_AT, QUIET_UPDATED_AT);
  sessionsDb.createSession(
    SESSION_RESIDENT, 'claude', betaDirectory, 'Resident session',
    RESIDENT_UPDATED_AT, RESIDENT_UPDATED_AT, null,
  );
  sessionsDb.setSessionLifecycleMode(SESSION_RESIDENT, 'resident');
  assert.equal(sessionsDb.getSessionLifecycleMode(SESSION_RESIDENT), 'resident', 'the resident fixture must store its mode');

  // ---- the B1 fixture: sessions past the recents page ----
  // Seeded only for the leg that asks for them. They are dated forward from
  // 2026-08-01 — OLDER than every named session — so the 200-row page the recents
  // read takes holds the four named rows plus the newest (count - 4) of these,
  // and `${DISTANT_SESSION_PREFIX}000` (the globally oldest) cannot fit.
  const distantSessions = options.distantSessions ?? 0;
  for (let index = 0; index < distantSessions; index += 1) {
    const stamp = new Date(DISTANT_BASE_MS + index * 60_000).toISOString();
    sessionsDb.createSession(
      `${DISTANT_SESSION_PREFIX}${String(index).padStart(3, '0')}`,
      'claude',
      alphaDirectory,
      `Past-page session ${index}`,
      stamp,
      stamp,
    );
  }

  // ---- the resident host: a real manager, a real binding, real leases ----
  const hostManager = createSessionHostManager({ now, scheduler: { schedule: () => () => {} } });
  const bound = await hostManager.bindSession({
    provider: 'claude',
    appSessionId: SESSION_RESIDENT,
    driver: scriptedResidentDriver(SESSION_RESIDENT, PEER_NAME),
    mode: 'resident',
    pid: HOST_PID,
  });
  assert.ok(bound.ok, 'the resident fixture must land on a host');
  const cronLease: HostLease = { kind: 'cron', id: 'read-fixture-cron', recurring: true, expiresAt: NOW_MS + 3_600_000 };
  const backgroundLease: HostLease = { kind: 'background-task', id: 'read-fixture-bg' };
  assert.ok(hostManager.addLease(SESSION_RESIDENT, cronLease), 'the cron lease must be recorded');
  assert.ok(hostManager.addLease(SESSION_RESIDENT, backgroundLease), 'the background-task lease must be recorded');

  // ---- the running session: a real run in the real registry ----
  const started = chatRunRegistry.startRun({
    appSessionId: SESSION_BUSY,
    provider: 'claude' as LLMProvider,
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(started, 'the busy fixture must open a run');

  // ---- the tokens ----
  const tokens = createAccessTokensService({ now: () => new Date(NOW_MS) });
  const readToken = tokens.issueToken({ userId: USER_ONE, name: 'mcp-read', scopes: ['cloudcli:read'], expiresInDays: 30 });
  const scopedToken = tokens.issueToken({
    userId: USER_ONE, name: 'mcp-other', scopes: ['cloudcli:session:send'], expiresInDays: 30,
  });
  if (!readToken.ok || !scopedToken.ok) {
    throw new Error('the harness must mint both tokens');
  }

  // ---- the app and the real mount ----
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
        // The same lookup the full-list projection uses, so `session_get` by id
        // reports the same `projectId` a list row carries.
        getProjectIdByPath: (projectPath: string) => projectsDb.getProjectPath(projectPath)?.project_id ?? null,
      },
      sessions: {
        ...sessionsService,
        // The page-independent by-id read the fix adds (B1).
        readSessionById: (sessionId: string) => sessionsDb.getSessionById(sessionId),
      },
      hosts: hostManager,
      runs: chatRunRegistry,
      now,
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac245-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect(readToken.token.token);
  const scoped = await connect(scopedToken.token.token);
  const probe = await connect(readToken.token.token);

  const callWith = async (client: Client, name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(
      await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]),
    );

  try {
    const projects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
    const fixture: Fixture = {
      projectAlphaId: projects.find((project) => project.path === alphaDirectory)?.projectId ?? null,
      projectBetaId: projects.find((project) => project.path === betaDirectory)?.projectId ?? null,
    };
    assert.ok(fixture.projectAlphaId && fixture.projectBetaId, 'both fixture projects must be registered');

    await run(
      {
        readClient: read.client,
        scopedClient: scoped.client,
        probeClient: probe.client,
        transport: read.transport,
        scopedTransport: scoped.transport,
        call: (name, args = {}) => callWith(read.client, name, args),
        callWith,
      },
      fixture,
    );
  } finally {
    // `chatRunRegistry` is the process singleton, so the run this fixture opened
    // outlives the temp database unless it is terminated here — and a run left
    // running would make the NEXT case's `startRun` answer null.
    chatRunRegistry.completeRun(SESSION_BUSY, { exitCode: 0 });
    await read.transport.close().catch(() => undefined);
    await scoped.transport.close().catch(() => undefined);
    await probe.transport.close().catch(() => undefined);
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

// --------------------------- (a) tools/list ---------------------------

test('(a) tools/list is exactly the stage-3 read tools, none of them a write tool', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness) => {
    const listed = await harness.readClient.listTools();
    const registered: string[] = listed.tools.map((tool) => tool.name).sort();
    const declared: string[] = MCP_STAGE3_READ_TOOLS.map((tool) => tool.name).sort();

    console.log(`[a] tools/list names = ${JSON.stringify(registered)}`);
    console.log(`[a] MCP_STAGE3_READ_TOOLS names = ${JSON.stringify(declared)}`);
    for (const tool of MCP_STAGE3_READ_TOOLS) {
      console.log(`[a] declared ${tool.name} requiredScope=${tool.requiredScope}`);
    }
    for (const tool of listed.tools) {
      console.log(`[a] registered ${tool.name} description=${JSON.stringify(tool.description ?? null)}`);
    }

    assert.deepEqual(registered, declared, 'tools/list must be exactly the declared stage-3 read tools');
    assert.equal(registered.length, 13, 'the stage-3 read set is thirteen tools');

    const WRITE_TOOLS = ['session_send', 'session_create', 'session_interrupt', 'session_start', 'session_close'];
    for (const writeTool of WRITE_TOOLS) {
      assert.ok(!registered.includes(writeTool), `write tool ${writeTool} must not be registered`);
    }
    console.log(`[a] write tools absent = ${JSON.stringify(WRITE_TOOLS)}`);

    // Positive control: a non-empty set carrying the four tools this task
    // implements — an empty list would otherwise satisfy "no write tool".
    for (const name of ['projects_list', 'sessions_list', 'session_get', 'session_read']) {
      assert.ok(registered.includes(name), `${name} must be registered`);
    }

    for (const tool of MCP_STAGE3_READ_TOOLS) {
      assert.equal(tool.requiredScope, 'cloudcli:read', `${tool.name} must require cloudcli:read`);
    }
    for (const tool of listed.tools) {
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} must carry a description`);
      assert.equal((tool.inputSchema as { type?: string }).type, 'object', `${tool.name} must declare an object input schema`);
    }

    // The declared scope is ENFORCED, not merely printed: a token that carries a
    // different scope is refused, and refused by the audited wrapper rather than
    // by the handler (the message is the wrapper's own).
    const denied = await harness.callWith(harness.scopedClient, 'projects_list');
    console.log(`[a] projects_list with a token lacking cloudcli:read -> isError=${denied.isError} text=${JSON.stringify(denied.text)}`);
    assert.equal(denied.isError, true, 'a token without cloudcli:read must be refused');

    // The tools owned by later tasks are registered but refuse by name; this
    // mount passes no `sessionSearch` deps, so `session_search` joins them in its
    // body-table refusal form (a legal `query`, so the refusal is the handler's
    // placeholder rather than the wrapper's own declared-input `INVALID_ARGUMENT`).
    for (const [name, args] of [
      ['overview', {}],
      ['run_get', { run: 'anything' }],
      ['quay_snapshot', {}],
      ['session_search', { query: 'anything' }],
    ] as Array<[string, AnyRecord]>) {
      const refusal = await harness.callWith(harness.probeClient, name, args);
      console.log(`[a] ${name} -> isError=${refusal.isError} text=${JSON.stringify(refusal.text)}`);
      assert.equal(refusal.isError, true, `${name} must refuse while unwired`);
      assert.equal(
        refusal.structured?.code,
        MCP_TOOL_NOT_IMPLEMENTED_CODE,
        `${name} must carry ${MCP_TOOL_NOT_IMPLEMENTED_CODE} in its refusal envelope`,
      );
    }
  });
});

// --------------------------- (b) projects_list / sessions_list ---------------------------

test('(b) projects_list and sessions_list return the whole fixture and partition it by state', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness, fixture) => {
    const projects = await harness.call('projects_list');
    assert.equal(projects.isError, false, 'projects_list must not error');
    const projectReadings = projects.payload?.projects as AnyRecord[];
    console.log(`[b] projects_list = ${JSON.stringify(projectReadings)}`);
    assert.equal(projectReadings.length, 2, 'both fixture projects must be listed');
    const alpha = projectReadings.find((project) => project.id === fixture.projectAlphaId);
    const beta = projectReadings.find((project) => project.id === fixture.projectBetaId);
    assert.ok(alpha && beta, 'both fixture projects must appear by id');
    assert.ok(String(alpha.path).endsWith(PROJECT_ALPHA), `alpha path ${String(alpha.path)} must be the alpha fixture directory`);
    assert.ok(String(beta.path).endsWith(PROJECT_BETA), `beta path ${String(beta.path)} must be the beta fixture directory`);
    assert.notEqual(alpha.path, beta.path, 'the two fixture projects must be distinct paths');
    assert.equal(alpha.sessionCount, 2, 'alpha holds the busy and big sessions');
    assert.equal(beta.sessionCount, 2, 'beta holds the quiet and resident sessions');

    const all = await harness.call('sessions_list');
    const allSessions = all.payload?.sessions as AnyRecord[];
    console.log(`[b] sessions_list(all) = ${JSON.stringify(allSessions)}`);
    assert.equal(allSessions.length, 4, 'every fixture session must be listed');
    assert.ok(allSessions.every((session) => typeof session.lifecycleMode === 'string'));

    const idsOf = (call: ToolCall): string[] =>
      ((call.payload?.sessions as AnyRecord[] | undefined) ?? []).map((s) => String(s.id)).sort();

    const running = await harness.call('sessions_list', { state: 'running' });
    const resident = await harness.call('sessions_list', { state: 'resident' });
    const idle = await harness.call('sessions_list', { state: 'idle' });
    console.log(`[b] state=running -> ${JSON.stringify(idsOf(running))}`);
    console.log(`[b] state=resident -> ${JSON.stringify(idsOf(resident))}`);
    console.log(`[b] state=idle -> ${JSON.stringify(idsOf(idle))}`);

    assert.deepEqual(idsOf(running), [SESSION_BUSY]);
    assert.deepEqual(idsOf(resident), [SESSION_RESIDENT]);
    assert.deepEqual(idsOf(idle), [SESSION_BIG, SESSION_QUIET]);
    assert.equal(running.isError, false);
    assert.equal(resident.isError, false);
    assert.equal(idle.isError, false);

    // Positive control against "nothing is ever returned": the unfiltered read
    // is at least as large as every filtered one, and every filtered read is
    // non-empty.
    assert.ok(allSessions.length >= idsOf(running).length);
    assert.ok(idsOf(running).length > 0 && idsOf(resident).length > 0 && idsOf(idle).length > 0);

    // An empty result is an answer, not a failure.
    const noneInBeta = await harness.call('sessions_list', { project: fixture.projectBetaId, state: 'running' });
    console.log(`[b] project=beta state=running -> ${JSON.stringify(noneInBeta.payload)} isError=${noneInBeta.isError}`);
    assert.equal(noneInBeta.isError, false, 'an empty filter result must not be an error');
    assert.deepEqual(idsOf(noneInBeta), []);

    const betaOnly = await harness.call('sessions_list', { project: fixture.projectBetaId });
    assert.deepEqual(idsOf(betaOnly), [SESSION_QUIET, SESSION_RESIDENT].sort());
  });
});

// --------------------------- (b2) sessions_list limit ---------------------------

test('(b2) sessions_list declares and honours limit, and refuses an out-of-range one', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness, fixture) => {
    const all = await harness.call('sessions_list');
    const allIds = ((all.payload?.sessions as AnyRecord[] | undefined) ?? []).map((session) => String(session.id));
    assert.equal(allIds.length, 4, 'the no-limit control must see the whole fixture (non-vacuity for the cut below)');
    console.log(`[b2] no limit -> ${JSON.stringify(allIds)} total=${String(all.payload?.total)}`);

    // `limit: 3` cuts the tail but keeps the page's own order, so the returned
    // ids are exactly the first three of the unfiltered read — and `total` still
    // reports the filtered count (4), which is how a caller learns it was cut.
    const limited = await harness.call('sessions_list', { limit: 3 });
    const limitedIds = ((limited.payload?.sessions as AnyRecord[] | undefined) ?? []).map((session) => String(session.id));
    console.log(`[b2] limit=3 -> ${JSON.stringify(limitedIds)} total=${String(limited.payload?.total)}`);
    assert.equal(limited.isError, false, 'a legal limit must not error');
    assert.equal(limitedIds.length, 3, 'limit: 3 must return exactly three sessions');
    assert.deepEqual(limitedIds, allIds.slice(0, 3), 'limit must keep the existing order and drop the tail');
    assert.equal(limited.payload?.total, 4, 'total must be the filtered count BEFORE the limit cut');

    // The three returned ARE the three most recently active: ordering is by
    // activity, not by whatever order the rows happened to arrive in.
    const isoOf = (session: AnyRecord): string => String((session.lastActivity as AnyRecord | null)?.iso ?? '');
    const newestThree = ((all.payload?.sessions as AnyRecord[] | undefined) ?? [])
      .slice()
      .sort((left, right) => isoOf(right).localeCompare(isoOf(left)))
      .slice(0, 3)
      .map((session) => String(session.id))
      .sort();
    assert.deepEqual([...limitedIds].sort(), newestThree, 'limit must return the most recently active sessions');

    // The limit applies AFTER the project/state filters: beta holds two idle
    // sessions, so limit 1 returns one of them and `total` says two.
    const betaLimited = await harness.call('sessions_list', { project: fixture.projectBetaId, limit: 1 });
    const betaLimitedIds = ((betaLimited.payload?.sessions as AnyRecord[] | undefined) ?? []).map((s) => String(s.id));
    console.log(`[b2] project=beta limit=1 -> ${JSON.stringify(betaLimitedIds)} total=${String(betaLimited.payload?.total)}`);
    assert.equal(betaLimitedIds.length, 1, 'limit must cut after the project filter');
    assert.equal(betaLimited.payload?.total, 2, 'total must count the filtered set, not the page');

    const idleLimited = await harness.call('sessions_list', { state: 'idle', limit: 1 });
    const idleLimitedIds = ((idleLimited.payload?.sessions as AnyRecord[] | undefined) ?? []).map((s) => String(s.id));
    assert.equal(idleLimitedIds.length, 1, 'limit must cut after the state filter');
    assert.equal(idleLimited.payload?.total, 2, 'two fixture sessions are idle');

    // Out-of-range limits are the one INVALID_ARGUMENT envelope (AC-288), each
    // naming `limit` — never a silently clamped page. Probed through the cold
    // client, which does not validate `structuredContent` against the advertised
    // success schema.
    const OUT_OF_RANGE: ReadonlyArray<{ args: AnyRecord; problem: string }> = [
      { args: { limit: 0 }, problem: 'must be >= 1' },
      { args: { limit: -1 }, problem: 'must be >= 1' },
      { args: { limit: 1.5 }, problem: 'expected int' },
      { args: { limit: 201 }, problem: 'must be <= 200' },
    ];
    for (const probe of OUT_OF_RANGE) {
      const refusal = await harness.callWith(harness.probeClient, 'sessions_list', probe.args);
      const fields = (refusal.structured?.details as AnyRecord | undefined)?.fields as AnyRecord[] | undefined;
      console.log(`[b2] limit=${JSON.stringify(probe.args.limit)} -> isError=${refusal.isError} code=${String(refusal.structured?.code)} fields=${JSON.stringify(fields)}`);
      assert.equal(refusal.isError, true, `limit ${JSON.stringify(probe.args.limit)} must be refused`);
      assert.equal(refusal.structured?.code, 'INVALID_ARGUMENT', 'the refusal must be INVALID_ARGUMENT');
      assert.ok(
        Array.isArray(fields) && fields.some((field) => field.path === 'limit' && field.problem === probe.problem),
        `limit ${JSON.stringify(probe.args.limit)} must name limit with problem ${JSON.stringify(probe.problem)}, saw ${JSON.stringify(fields)}`,
      );
    }
  });
});

// --------------------------- (c) session_get ---------------------------

test('(c) session_get carries the resident host and says a cold session has none', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness) => {
    const resident = await harness.call('session_get', { session: SESSION_RESIDENT });
    console.log(`[c] session_get(${SESSION_RESIDENT}) = ${JSON.stringify(resident.payload)}`);
    assert.equal(resident.isError, false);
    const host = resident.payload?.host as AnyRecord | null;
    assert.ok(host, 'the resident session must carry a host — a positive control against "never a host"');

    const VALID_HOST_STATES = ['starting', 'idle', 'busy', 'lingering', 'closing', 'closed'];
    console.log(`[c] host.state=${JSON.stringify(host.state)} pid=${JSON.stringify(host.pid)}`);
    assert.ok(VALID_HOST_STATES.includes(String(host.state)), `host.state ${String(host.state)} must be a HostState`);
    assert.ok(Number.isInteger(host.pid) && (host.pid as number) > 0, 'host.pid must be a positive integer');
    assert.equal(host.pid, HOST_PID);

    const leases = host.leases as AnyRecord[];
    console.log(`[c] host.leases = ${JSON.stringify(leases)}`);
    assert.ok(leases.length > 0, 'the resident binding must carry leases');
    assert.ok(
      leases.some((lease) => ['turn', 'cron', 'background-task'].includes(String(lease.kind))),
      'at least one held-work lease must be reported',
    );
    assert.ok(leases.some((lease) => lease.kind === 'cron' && lease.id === 'read-fixture-cron'), 'the cron lease must survive verbatim');
    assert.ok(leases.some((lease) => lease.kind === 'background-task' && lease.id === 'read-fixture-bg'));

    console.log(`[c] host.peerName=${JSON.stringify(host.peerName)}`);
    assert.equal(host.peerName, PEER_NAME, 'the peer name must be the one the driver reported');
    assert.ok(host.startedAt && typeof (host.startedAt as AnyRecord).iso === 'string');

    const cold = await harness.call('session_get', { session: SESSION_QUIET });
    console.log(`[c] session_get(${SESSION_QUIET}) host=${JSON.stringify(cold.payload?.host)} hostNote=${JSON.stringify(cold.payload?.hostNote)}`);
    assert.equal(cold.isError, false, 'a cold session must be a reading, not a failure');
    assert.equal(cold.payload?.host, null, 'a per-run session with no host must report no host');
    assert.equal(typeof cold.payload?.hostNote, 'string');
    assert.ok(String(cold.payload?.hostNote).length > 0, 'a cold session must say in words that it has no host');
  });
});

// --------------------------- (c2) session_get past the recents page ---------------------------

test('(c2) session_get reads by id a session older than the whole recents page', { concurrency: false }, async () => {
  await withMcpReadTools(
    async (harness) => {
      // The tool's own listing takes a 200-row page. The target is the OLDEST
      // fixture session, so it cannot be on that page — the defect this leg
      // pins: `session_get` used to scan that page and answer SESSION_NOT_FOUND
      // for a session that plainly exists.
      const listed = await harness.call('sessions_list', { limit: 200 });
      const pageIds = ((listed.payload?.sessions as AnyRecord[] | undefined) ?? []).map((s) => String(s.id));
      console.log(
        `[c2] sessions_list(limit=200) count=${pageIds.length} containsTarget=${String(pageIds.includes(SESSION_PAST_PAGE))}`,
      );
      assert.equal(listed.isError, false, 'the page read must not error');
      assert.equal(pageIds.length, 200, 'the page must be full — the target is squeezed off it by count, not an empty fixture');
      assert.ok(!pageIds.includes(SESSION_PAST_PAGE), 'the target must be OFF the page this listing reads');

      // The same fixture read through the UNPAGED projection: the target IS
      // there, and its fields are exactly what `session_get` must reproduce.
      // (The MCP listing caps at 200, so the "full list" is the projection
      // function itself, unpaged.)
      const fullList = sessionsService.listRecentSessions(1000, 0).conversations;
      const projected = fullList.find((conversation) => conversation.sessionId === SESSION_PAST_PAGE);
      console.log(`[c2] full list (${fullList.length}) target projection = ${JSON.stringify(projected)}`);
      assert.ok(projected, 'the target must be in the full projection — non-vacuity for the negative control above');

      const detail = await harness.call('session_get', { session: SESSION_PAST_PAGE });
      console.log(
        `[c2] session_get(${SESSION_PAST_PAGE}) = ${JSON.stringify(detail.payload)} isError=${detail.isError} code=${String(detail.structured?.code)} text=${JSON.stringify(detail.text)}`,
      );
      assert.equal(detail.isError, false, 'a session past the page must be a reading, not SESSION_NOT_FOUND');

      const session = detail.payload?.session as AnyRecord;
      assert.equal(session.id, projected.sessionId, 'id must match the full-list projection');
      assert.equal(session.provider, projected.provider, 'provider must match the full-list projection');
      assert.equal(session.title, projected.sessionTitle, 'title must match the full-list projection');
      assert.equal(session.projectId, projected.projectId, 'projectId must match the full-list projection');
      assert.equal(
        (session.lastActivity as AnyRecord | null)?.iso,
        projected.lastActivity,
        'lastActivity.iso must match the full-list projection',
      );
      // Positive control: the time reading is a real instant, so the equality
      // above is not a null-vs-null accident.
      assert.equal(typeof (session.lastActivity as AnyRecord | null)?.iso, 'string');
    },
    { distantSessions: DISTANT_SESSION_COUNT },
  );
});

// --------------------------- (d) session_read ---------------------------

test('(d) session_read: latest folds the tool call, outline lists every user turn, around centres a window', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness) => {
    // The normalized history the window id is read from — the same read the tool
    // performs, so the criterion names a message by the id the provider gives it
    // rather than by a raw JSONL uuid it guessed.
    const history = await sessionsService.fetchHistory(SESSION_BUSY, { limit: null, offset: 0 });
    const toolMessage = history.messages.find((message) => message.kind === 'tool_use');
    assert.ok(toolMessage, 'the fixture transcript must normalize to a tool_use message');
    const toolMessageId = toolMessage.transcriptAnchorId ?? toolMessage.id;

    const latest = await harness.call('session_read', { session: SESSION_BUSY });
    assert.equal(latest.isError, false);
    const latestText = String(latest.payload?.content ?? '');
    const lines = latestText.split('\n');
    console.log(`[d] latest lines (${lines.length}) = ${JSON.stringify(lines)}`);
    assert.equal(lines.length, 5, 'latest defaults to the last five messages');

    // TWO raw JSONL rows (the tool_use and its tool_result) draw as ONE line.
    const toolLines = lines.filter((line) => line.includes('Bash'));
    console.log(`[d] folded tool lines = ${JSON.stringify(toolLines)}`);
    assert.equal(toolLines.length, 1, 'the tool call and its result must be one line, not two');
    assert.ok(toolLines[0].includes(TOOL_COMMAND), 'the folded line must carry the call');
    assert.ok(toolLines[0].includes(TOOL_OUTPUT), 'the folded line must carry the result');
    assert.ok(
      !lines.some((line) => line.startsWith('[', 0) && line.includes('tool_result')),
      'the tool result must not draw as its own row',
    );

    const outline = await harness.call('session_read', { session: SESSION_BUSY, mode: 'outline' });
    const outlineLines = String(outline.payload?.content ?? '').split('\n');
    console.log(`[d] outline lines = ${JSON.stringify(outlineLines)}`);
    assert.equal(outlineLines.length, 2, 'the fixture holds two user turns');
    assert.ok(outlineLines[0].includes(FIRST_PROMPT));
    assert.ok(outlineLines[1].includes(SECOND_PROMPT));

    const around = await harness.call('session_read', {
      session: SESSION_BUSY,
      mode: 'around',
      aroundId: toolMessageId,
      before: 1,
      after: 1,
    });
    const aroundLines = String(around.payload?.content ?? '').split('\n');
    console.log(`[d] around(${toolMessageId}) lines = ${JSON.stringify(aroundLines)}`);
    assert.equal(aroundLines.length, 3, 'before=1/after=1 must return three messages');
    assert.ok(aroundLines[1].includes('Bash'), 'the target must sit in the middle of the window');
    assert.ok(aroundLines[0].includes(FIRST_PROMPT) || aroundLines[0].includes('normalized history'));

    // Positive control: all three modes answer with messages.
    assert.ok(latestText.length > 0 && outlineLines.join('').length > 0 && aroundLines.join('').length > 0);
  });
});

// --------------------------- (e) truncation and cursor ---------------------------

test('(e) text over the chunk ceiling is paginated by cursor and reassembles byte for byte', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness) => {
    // ---- the helper, against an original the criterion owns ----
    const original = `HEADER-LINE\n${BIG_TEXT}\nFOOTER-LINE`;
    const first = paginateMcpText(original);
    const chunks: string[] = [first.content];
    let cursor = first.cursor;
    const lengths = [first.content.length];
    while (cursor !== undefined) {
      const next = paginateMcpText(original, cursor);
      chunks.push(next.content);
      lengths.push(next.content.length);
      cursor = next.cursor;
    }
    const reassembled = chunks.join('');
    console.log(`[e] paginateMcpText: original=${original.length} chunks=${JSON.stringify(lengths)} reassembled=${reassembled.length} equal=${String(reassembled === original)}`);
    assert.ok(lengths.every((length) => length <= MCP_TEXT_CHUNK_CHARS), 'no chunk may exceed the ceiling');
    assert.ok(lengths.length > 1, 'the over-long original must need more than one chunk');
    assert.ok(first.cursor !== undefined, 'the first chunk of an over-long text must carry a cursor');
    assert.equal(reassembled === original, true, 'concatenating the chunks must reproduce the original exactly');

    // ---- the tool, over the fixture's over-long message ----
    const bigFirst = await harness.call('session_read', { session: SESSION_BIG });
    const bigContent = String(bigFirst.payload?.content ?? '');
    const bigCursor = bigFirst.payload?.cursor;
    console.log(`[e] session_read(big) first chunk length=${bigContent.length} cursor=${JSON.stringify(bigCursor)}`);
    assert.ok(bigContent.length <= MCP_TEXT_CHUNK_CHARS, 'the first chunk must respect the ceiling');
    assert.equal(typeof bigCursor, 'string', 'the first chunk of the over-long session must carry a cursor');

    const pieces: string[] = [bigContent];
    const pieceLengths: number[] = [bigContent.length];
    let nextCursor: string | undefined = String(bigCursor);
    while (nextCursor !== undefined) {
      const page = await harness.call('session_read', { session: SESSION_BIG, cursor: nextCursor });
      assert.equal(page.isError, false, 'a cursor continuation must not be an error');
      pieces.push(String(page.payload?.content ?? ''));
      pieceLengths.push(String(page.payload?.content ?? '').length);
      nextCursor = typeof page.payload?.cursor === 'string' ? String(page.payload.cursor) : undefined;
    }
    const toolText = pieces.join('');
    console.log(`[e] session_read(big) chunk lengths=${JSON.stringify(pieceLengths)} reassembled=${toolText.length} containsFixtureText=${String(toolText.includes(BIG_TEXT))}`);
    assert.ok(pieceLengths.every((length) => length <= MCP_TEXT_CHUNK_CHARS));
    assert.equal(
      toolText.includes(BIG_TEXT),
      true,
      'the over-long message must survive the chunk boundary verbatim',
    );

    // ---- negative control: a text that fits returns no cursor at all ----
    const short = await harness.call('session_read', { session: SESSION_BUSY });
    console.log(`[e] short session_read payload keys = ${JSON.stringify(Object.keys(short.payload ?? {}))}`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(short.payload ?? {}, 'cursor'),
      false,
      'a text that fits must not carry a cursor',
    );
  });
});

// --------------------------- (f) time ---------------------------

test('(f) every time field carries both the relative and the ISO reading', { concurrency: false }, async () => {
  await withMcpReadTools(async (harness, fixture) => {
    const expectedRelative = (iso: string): string => `${Math.floor((NOW_MS - Date.parse(iso)) / 60_000)} minutes ago`;

    const projects = await harness.call('projects_list');
    const projectReadings = projects.payload?.projects as AnyRecord[];
    for (const project of projectReadings) {
      const time = project.lastActivity as AnyRecord;
      console.log(`[f] projects_list ${String(project.name)} lastActivity=${JSON.stringify(time)}`);
      assert.equal(typeof time.relative, 'string');
      assert.equal(typeof time.iso, 'string');
      assert.equal(time.relative, expectedRelative(String(time.iso)), 'the relative half must match the ISO half under the injected clock');
    }
    const alpha = projectReadings.find((project) => project.id === fixture.projectAlphaId);
    const alphaTime = alpha?.lastActivity as AnyRecord;
    assert.equal(alphaTime.iso, BUSY_UPDATED_AT);
    assert.equal(alphaTime.relative, '55 minutes ago');

    const sessions = await harness.call('sessions_list');
    const sessionRows = (sessions.payload?.sessions as AnyRecord[] | undefined) ?? [];
    for (const session of sessionRows) {
      const time = session.lastActivity as AnyRecord;
      console.log(`[f] sessions_list ${String(session.id)} lastActivity=${JSON.stringify(time)}`);
      assert.equal(time.relative, expectedRelative(String(time.iso)));
    }

    const quiet = await harness.call('session_get', { session: SESSION_QUIET });
    const quietSession = (quiet.payload?.session ?? null) as AnyRecord | null;
    assert.ok(quietSession, 'session_get must carry the session reading');
    const quietTime = quietSession.lastActivity as AnyRecord;
    console.log(`[f] session_get ${SESSION_QUIET} lastActivity=${JSON.stringify(quietTime)}`);
    assert.equal(quietTime.iso, QUIET_UPDATED_AT);
    assert.equal(quietTime.relative, '56 minutes ago');
  });
});
