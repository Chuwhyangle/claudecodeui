/**
 * The `ui_last_opened_session` criterion (gap-mcp-ui-last-opened-session).
 *
 * Readings, one leg each:
 *   (a) with nothing opened, the tool answers the existing NOT_FOUND-class code
 *       (`SESSION_NOT_FOUND`) and its envelope carries NO session — in
 *       particular nothing derived from `lastActivity`, the fallback this tool
 *       exists to refuse;
 *   (b) once the BROWSER has opened a session (the real provider session-read
 *       route, on the same store the mount reads), the tool answers that
 *       session's `session_get` reading — same `session`, `host`, `hostNote` and
 *       `run` — plus `openedAt` as a relative + ISO pair;
 *   (c) an MCP token's `session_read` does NOT move the pointer: the routes that
 *       write it are not on the gateway's call path, so the table is unchanged
 *       across a token reading a different session;
 *   (d) re-opening the same session only updates `opened_at` (one row), and
 *       opening another session makes the tool answer the latter.
 *
 * The browser path is driven through the REAL route (`GET
 * /api/providers/sessions/:id/messages`) mounted on the same Express app as the
 * gateway, not through the service directly — otherwise leg (c) would prove
 * nothing, because the whole claim is that the two call graphs are disjoint.
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

import type { LLMProvider } from '@/shared/types.js';

// The environment is set before any aliased module is pulled in (the order the
// provider criteria established: `auth.middleware.ts` resolves the JWT secret at
// module-load time). Every application module below therefore comes in
// dynamically.
process.env.JWT_SECRET = 'mcp-ui-last-opened-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { providerRoutes, sessionsService, uiLastOpenedSessionService } = await import('@/modules/providers/index.js');
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { chatRunRegistry } = await import('@/modules/websocket/index.js');
const { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } = await import(
  '@/modules/projects/index.js'
);
const { MCP_GATEWAY_PATH, createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixtures ---------------------------

const NOW_ISO = '2026-10-07T09:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

const USER_ONE = 1;
const PROJECT_DIRECTORY_NAME = 'ui-last-opened-workspace';
/** Two session ids, both legal `parseSessionId` values. */
const SESSION_ALPHA = 'ui-open-alpha';
const SESSION_BETA = 'ui-open-beta';
/** Alpha is seeded OLDER than beta on purpose — see leg (b)'s fallback control. */
const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const SEEDED_LATER = '2026-10-05T08:00:00.000Z';

/** The two-line transcript one seeded session needs for the route to answer 200. */
function transcriptRows(sessionId: string): AnyRecord[] {
  return [
    {
      type: 'user',
      uuid: `${sessionId}-u1`,
      parentUuid: null,
      timestamp: '2026-10-01T08:00:00.000Z',
      sessionId,
      message: { role: 'user', content: [{ type: 'text', text: `open ${sessionId}` }] },
    },
    {
      type: 'assistant',
      uuid: `${sessionId}-a1`,
      parentUuid: `${sessionId}-u1`,
      timestamp: '2026-10-01T08:00:01.000Z',
      sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'opened' }] },
    },
  ];
}

// --------------------------- the node fetch the SDK transport needs ---------------------------

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
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              headers: response.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

// --------------------------- reading a tool call ---------------------------

type ToolCall = { isError: boolean; text: string; structured: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  return {
    isError: call.isError === true,
    text,
    structured: (call.structuredContent as AnyRecord | undefined) ?? null,
  };
}

/** The one row the browser pointer holds, read straight from the table. */
function pointerRows(): Array<{ session_id: string; opened_at: number }> {
  return getConnection()
    .prepare('SELECT session_id, opened_at FROM ui_last_opened ORDER BY session_id')
    .all() as Array<{ session_id: string; opened_at: number }>;
}

// --------------------------- harness ---------------------------

type Harness = {
  /** A `tools/list`-warmed read client (success calls carry output validation). */
  readClient: Client;
  /** A cold client that never listed (error envelopes fail the warmed output validator). */
  probeClient: Client;
  /** `GET` on the provider route the browser hits to load a session's transcript. */
  openInBrowser: (sessionId: string) => Promise<{ status: number; body: AnyRecord | null }>;
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  callWith: (client: Client, name: string, args?: AnyRecord) => Promise<ToolCall>;
};

/**
 * Runs `run` against a fresh temp database, the real providers/session/host
 * services, the real provider router (the browser path) and the production
 * `/mcp` mount with the last-opened pointer wired exactly as `server/index.ts`
 * wires it.
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-ui-last-opened-'));
  const projectDirectory = path.join(tempDirectory, PROJECT_DIRECTORY_NAME);
  await mkdir(projectDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'ui-last-opened.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  for (const [sessionId, seededAt] of [
    [SESSION_ALPHA, SEEDED_AT],
    [SESSION_BETA, SEEDED_LATER],
  ] as const) {
    const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      `${transcriptRows(sessionId).map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );
    sessionsDb.createSession(
      sessionId, 'claude', projectDirectory, `Session ${sessionId}`, seededAt, seededAt, transcriptPath,
    );
  }

  const hostManager = createSessionHostManager({ now, scheduler: { schedule: () => () => {} } });

  // A live run on the alpha session, so the run summary the tool reports is a
  // real non-null reading rather than a fixture typed onto the response.
  const started = chatRunRegistry.startRun({
    appSessionId: SESSION_ALPHA,
    provider: 'claude' as LLMProvider,
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(started, 'the alpha fixture must open a run');

  const tokens = createAccessTokensService({ now: () => new Date(NOW_MS) });
  const readToken = tokens.issueToken({
    userId: USER_ONE, name: 'mcp-read', scopes: ['cloudcli:read'], expiresInDays: 30,
  });
  if (!readToken.ok) {
    throw new Error('the harness must mint the read token');
  }

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // The browser's path, mounted first so nothing about /mcp can shadow it.
  app.use('/api/providers', providerRoutes);
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
      hosts: hostManager,
      runs: chatRunRegistry,
      // The production binding: the same service the browser routes write through.
      uiLastOpened: { read: () => uiLastOpenedSessionService.readLastOpened() },
      now,
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = new URL(`${origin}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ui-last-opened-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect(readToken.token.token);
  const probe = await connect(readToken.token.token);

  const callWith = async (client: Client, name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  try {
    await run({
      readClient: read.client,
      probeClient: probe.client,
      openInBrowser: async (sessionId) => {
        const response = await fetch(`${origin}/api/providers/sessions/${sessionId}/messages`);
        const body = (await response.json().catch(() => null)) as AnyRecord | null;
        return { status: response.status, body };
      },
      call: (name, args = {}) => callWith(read.client, name, args),
      callWith,
    });
  } finally {
    chatRunRegistry.completeRun(SESSION_ALPHA, { exitCode: 0 });
    await read.transport.close().catch(() => undefined);
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

// --------------------------- (a) nothing opened ---------------------------

test('(a) with nothing opened the tool answers SESSION_NOT_FOUND and no lastActivity fallback', async () => {
  await withHarness(async ({ probeClient, callWith }) => {
    // Nothing has hit the browser route, so the pointer table is empty.
    assert.deepEqual(pointerRows(), [], 'the fixture must start with no opened session');

    const reading = await callWith(probeClient, 'ui_last_opened_session');
    assert.equal(reading.isError, true, 'no opened session must be a failure, not an empty success');
    assert.ok(reading.structured, 'the failure must carry structuredContent');

    const envelope = reading.structured as AnyRecord;
    assert.equal(envelope.code, 'SESSION_NOT_FOUND', 'the NOT_FOUND-class code this surface already uses');

    // The load-bearing negative control: the answer must NOT be a session
    // derived from `lastActivity`. Neither the envelope's structured content nor
    // its text slot may carry a session reading at all.
    for (const forbidden of ['session', 'openedAt', 'lastActivity']) {
      assert.equal(forbidden in envelope, false, `the refusal must not carry "${forbidden}"`);
    }
    assert.equal(
      /lastActivity/.test(reading.text),
      false,
      `the refusal text must not mention lastActivity, saw ${JSON.stringify(reading.text)}`,
    );

    // And the sessions that DO exist (with a `lastActivity`) are not being
    // substituted for the missing answer: the pointer is still empty.
    assert.deepEqual(pointerRows(), [], 'a refusal must not write the pointer');
  });
});

// --------------------------- (b) the browser opened a session ---------------------------

test('(b) after the browser opens a session the tool answers its session_get reading plus openedAt', async () => {
  await withHarness(async ({ call, openInBrowser }) => {
    const opened = await openInBrowser(SESSION_ALPHA);
    assert.equal(opened.status, 200, 'the browser session-read route must answer');

    const rows = pointerRows();
    assert.equal(rows.length, 1, 'the browser path must record exactly one row');
    assert.equal(rows[0].session_id, SESSION_ALPHA, 'the recorded session must be the one the browser read');

    const reading = await call('ui_last_opened_session');
    assert.equal(reading.isError, false, reading.text);
    const payload = reading.structured as AnyRecord;
    assert.ok(payload, 'the success must carry structuredContent');

    // "Same shape as session_get": compare against the real session_get reading
    // for the same session, field for field.
    const fromGet = await call('session_get', { session: SESSION_ALPHA });
    assert.equal(fromGet.isError, false, fromGet.text);
    const getPayload = fromGet.structured as AnyRecord;
    assert.deepEqual(payload.session, getPayload.session, 'the session summary must be session_get’s own');
    assert.deepEqual(payload.host, getPayload.host, 'the host reading must be session_get’s own');
    assert.deepEqual(payload.hostNote, getPayload.hostNote, 'the host note must be session_get’s own');
    assert.deepEqual(payload.run, getPayload.run, 'the run summary must be session_get’s own');
    assert.notEqual(payload.run, null, 'the alpha fixture must report its live run');

    // `openedAt` carries both readings of one instant.
    const openedAt = payload.openedAt as { relative?: unknown; iso?: unknown };
    assert.ok(typeof openedAt.relative === 'string', 'openedAt must carry a relative reading');
    assert.ok(typeof openedAt.iso === 'string', 'openedAt must carry an ISO reading');
    assert.ok(
      new Date(openedAt.iso).getTime() >= Date.parse(SEEDED_AT),
      'the ISO reading must be a real instant at or after the session was seeded',
    );

    // The fallback this tool exists to refuse, falsified head-on: beta is the
    // most-recently-active session in the store, so an implementation that
    // answered `max(lastActivity)` would answer beta. It must answer alpha —
    // the one the browser opened.
    const beta = await call('session_get', { session: SESSION_BETA });
    assert.equal(beta.isError, false, beta.text);
    const alphaActivity = (payload.session as AnyRecord).lastActivity as { iso: string };
    const betaActivity = (beta.structured as AnyRecord).session as unknown as { lastActivity: { iso: string } };
    assert.ok(
      Date.parse(betaActivity.lastActivity.iso) > Date.parse(alphaActivity.iso),
      'the fixture must make beta strictly more recently active than alpha',
    );
    assert.equal(
      (payload.session as AnyRecord).id,
      SESSION_ALPHA,
      'the tool must answer the opened session, not the most recently active one',
    );
  });
});

// --------------------------- (c) an MCP read must not write ---------------------------

test('(c) an MCP token reading a transcript leaves the pointer unchanged', async () => {
  await withHarness(async ({ call, openInBrowser }) => {
    const opened = await openInBrowser(SESSION_ALPHA);
    assert.equal(opened.status, 200);
    const before = pointerRows();
    assert.equal(before.length, 1, 'the browser must have recorded the alpha session');

    // The token reads a DIFFERENT session's transcript through the gateway. If
    // the gateway (or the sessions service behind it) wrote the pointer, this
    // would move it to beta.
    const read = await call('session_read', { session: SESSION_BETA });
    assert.equal(read.isError, false, read.text);

    assert.deepEqual(
      pointerRows(),
      before,
      'an MCP session_read must not move the browser’s last-opened pointer',
    );

    const reading = await call('ui_last_opened_session');
    assert.equal(reading.isError, false, reading.text);
    assert.deepEqual(
      (reading.structured as AnyRecord).session,
      (await call('session_get', { session: SESSION_ALPHA })).structured?.session,
      'the tool must still answer the session the browser opened',
    );
  });
});

// --------------------------- (d) re-open and switch ---------------------------

test('(d) re-opening the same session only moves opened_at; opening another answers the latter', async () => {
  await withHarness(async ({ call, openInBrowser }) => {
    const first = await openInBrowser(SESSION_ALPHA);
    assert.equal(first.status, 200);
    const firstRow = pointerRows()[0];
    assert.equal(firstRow.session_id, SESSION_ALPHA);

    // A later open of the SAME session: one row, a later `opened_at`.
    await new Promise((resolve) => setTimeout(resolve, 8));
    const again = await openInBrowser(SESSION_ALPHA);
    assert.equal(again.status, 200);
    const secondRows = pointerRows();
    assert.equal(secondRows.length, 1, 're-opening must not add a row');
    assert.equal(secondRows[0].session_id, SESSION_ALPHA);
    assert.ok(
      secondRows[0].opened_at > firstRow.opened_at,
      `re-opening must move opened_at forward, saw ${firstRow.opened_at} then ${secondRows[0].opened_at}`,
    );

    // Opening ANOTHER session replaces the pointer, and the tool answers it.
    const switched = await openInBrowser(SESSION_BETA);
    assert.equal(switched.status, 200);
    const switchedRows = pointerRows();
    assert.equal(switchedRows.length, 1, 'the pointer holds one session at a time');
    assert.equal(switchedRows[0].session_id, SESSION_BETA);

    const reading = await call('ui_last_opened_session');
    assert.equal(reading.isError, false, reading.text);
    const payload = reading.structured as AnyRecord;
    assert.equal((payload.session as AnyRecord).id, SESSION_BETA, 'the tool must answer the last-opened session');
    assert.equal(
      (payload.openedAt as AnyRecord).iso,
      new Date(switchedRows[0].opened_at).toISOString(),
      'openedAt must render the stored instant',
    );
  });
});
