/**
 * AC-337 criterion: the optional opaque `correlationId` label on the write
 * tools, and the two read filters that consume it.
 *
 * Drives the PRODUCTION assembly — `mountMcpGateway` with the real token auth
 * middleware, the real audited wrapper and the real read/write registration — so
 * every advertised schema, the scope check and the argument validation come off
 * the production tables, not a test-local restatement. The wire is real HTTP
 * (`node:http`, never `fetch`: undici refuses a fixed list of ports `listen(0)`
 * lands on, reddening runs at random; the sibling criteria use the same seam).
 * The backing store is a real better-sqlite3 database in a temp directory, and
 * the run registry is a REAL `createChatRunRegistry()` instance — not a stub —
 * so "the label landed on the run" is read from the same in-memory store
 * `sessions_list` filters over and `server/index.ts` wires into production.
 *
 * What is injected, and why each is a stub rather than the production
 * singleton: the CONTROL service is a stub that opens a real run in the real
 * registry (a `send` is the one verb these tools read, and the run it opens is
 * the reading under test — the provider runtime behind a production control
 * service is not); the read bag is a three-row session fixture; the
 * `session_create` bag is a two-method stub. Every SCHEMA, the audit wrapper,
 * the scope check and the registration are the production ones.
 *
 * The target gate (AC-246) is deliberately NOT wired (`resolveDeps` omitted), so
 * a `session` / `project` argument reaches the tools verbatim — exactly as the
 * AC-249/288 criteria mount it. That is orthogonal to this criterion: the
 * argument validation the (e) leg reads happens in the audit wrapper BEFORE the
 * gate would run.
 *
 * Legs, one reading each:
 *   (a) every write tool that declares the label advertises it on `tools/list`
 *       (`session_send`, `session_create`, `approval_answer`, the four `ui_*`
 *       navigation tools) and so do the two read filters (`sessions_list`,
 *       `mcp_usage_stats`) — the advertised set IS the declared set, read off one
 *       schema per tool;
 *   (b) a labelled `session_send`/`session_create` stamps the run it opened (read
 *       back from the real registry by session) AND its own audit row's
 *       `correlation_id`; a label-less call does neither, and its payload is
 *       byte-for-byte the pre-AC-337 shape;
 *   (c) `sessions_list { correlationId }` returns exactly the sessions whose live
 *       run carries that label (in memory, no table and no join), and
 *       `mcp_usage_stats { correlationId }` aggregates exactly the audit rows
 *       carrying it (one equality on AC-334's column, inside the same WHERE the
 *       user boundary lives in);
 *   (d) the label ADVANCES NOTHING: a labelled send opens exactly one run and
 *       writes exactly one row (its own), the run is still `running` with the
 *       same `lastSeq`, and two reads of `sessions_list` over an unchanged
 *       fixture answer identically. (The static "no timer / no loop in the diff"
 *       grep is this criterion's written companion, recorded in the task's change
 *       notes, together with the falsifying mutation: dropping the
 *       `correlationId` wiring from `recordMcpToolCall` must red the (b)-audit and
 *       (c)-usage legs.)
 *   (e) a label longer than 128 characters, empty, or carrying a character
 *       outside `[A-Za-z0-9_.:-]` is an `INVALID_ARGUMENT` whose
 *       `details.fields[].path` is `correlationId`, on every tool that declares
 *       it; the boundary values (1 and 128 characters) are accepted.
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

import { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb } from '@/modules/database/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';
import { chatRunRegistry, createChatRunRegistry } from '@/modules/websocket/index.js';

import { createMcpAuthMiddleware, createMcpGatewayModule, MCP_GATEWAY_PATH, mountMcpGateway } from '../index.js';
import type { McpReadToolDeps, McpResidentToolDeps, McpWriteToolDeps } from '../index.js';
import { MCP_CORRELATION_ID_MAX_LENGTH } from '../mcp-correlation-id.js';

const ALICE = 1;
/** The two labels the readings use. Both fit the declared charset and length. */
const LABEL = 'fleet-7f3a';
const OTHER_LABEL = 'fleet-9c11';
/** The clock the registry and the read fixture share, so nothing drifts by wall time. */
const FIXED_NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const LAST_ACTIVITY = '2026-01-01T00:00:00.000Z';

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The three session rows the read fixture serves, in the order it serves them. */
const SESSION_ROWS = [
  { sessionId: 'sess-a', sessionTitle: 'Alpha', provider: 'claude', projectId: 'proj-1', lastActivity: LAST_ACTIVITY },
  { sessionId: 'sess-b', sessionTitle: 'Bravo', provider: 'claude', projectId: 'proj-1', lastActivity: LAST_ACTIVITY },
  { sessionId: 'sess-c', sessionTitle: 'Charlie', provider: 'claude', projectId: 'proj-1', lastActivity: LAST_ACTIVITY },
];

/** The scope each probed tool requires, from the one `ACCESS_TOKEN_SCOPES` vocabulary. */
const SEND_SCOPES = ['cloudcli:session:send'];
const CREATE_SCOPES = ['cloudcli:session:create'];
const READ_SCOPES = ['cloudcli:read'];
const APPROVE_SCOPES = ['cloudcli:approve'];
const NAVIGATE_SCOPES = ['cloudcli:navigate'];

type Registry = ReturnType<typeof createChatRunRegistry>;

// --------------------------- HTTP ---------------------------

type Exchange = { status: number; json: Record<string, unknown> | null };

/** A single real-HTTP exchange over `node:http` (never `fetch`). */
function request(baseUrl: string, body: unknown, authorization: string): Promise<Exchange> {
  const url = new URL(MCP_GATEWAY_PATH, baseUrl);
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    accept: MCP_ACCEPT,
    authorization,
  };

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            json: parseJsonRpc(responseBody, (res.headers['content-type'] as string | undefined) ?? null),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** A JSON-RPC envelope from either wire shape: a JSON body or an SSE `data:` frame. */
function parseJsonRpc(body: string, contentType: string | null): Record<string, unknown> | null {
  let text = body;
  if ((contentType ?? '').includes('text/event-stream')) {
    const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      return null;
    }
    text = dataLine.slice('data:'.length).trim();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function callTool(baseUrl: string, name: string, args: unknown, token: string): Promise<Exchange> {
  return request(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    `Bearer ${token}`,
  );
}

/** The `tools/list` reading: name -> the `inputSchema.properties` keys it advertises. */
async function advertisedKeys(baseUrl: string, token: string): Promise<Map<string, string[]>> {
  const exchange = await request(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, `Bearer ${token}`);
  const result = exchange.json?.result as
    | { tools?: Array<{ name: string; inputSchema?: { properties?: object } }> }
    | undefined;
  const tools = result?.tools ?? [];
  assert.ok(tools.length > 0, `tools/list must advertise the mounted tools (raw=${JSON.stringify(exchange.json)})`);
  return new Map(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {})]));
}

/** The `structuredContent` of a NON-error tool result (a success omits `isError`). */
function structuredOf(exchange: Exchange): Record<string, unknown> {
  const result = exchange.json?.result as
    | { isError?: boolean; structuredContent?: Record<string, unknown> }
    | undefined;
  assert.notEqual(result?.isError, true, `expected a success result, got ${JSON.stringify(exchange.json?.result)}`);
  return result?.structuredContent ?? {};
}

/** One failure envelope as the wire carries it: `{ code, message, retryable, details? }`. */
type Envelope = {
  code?: unknown;
  message?: unknown;
  details?: { fields?: Array<{ path?: unknown; problem?: unknown }> };
};

/** The one failure envelope of an `isError` tool result. */
function envelopeOf(exchange: Exchange): Envelope {
  const result = exchange.json?.result as
    | { isError?: boolean; structuredContent?: Record<string, unknown> }
    | undefined;
  assert.equal(result?.isError, true, `expected an isError result, got ${JSON.stringify(exchange.json?.result)}`);
  return (result?.structuredContent ?? {}) as Envelope;
}

/** The `details.fields` array of an envelope, asserted non-empty with `{ path, problem }` entries. */
function fieldsOf(envelope: Envelope, label: string): Array<{ path: string; problem: string }> {
  const fields = envelope.details?.fields;
  assert.ok(Array.isArray(fields), `${label}: an INVALID_ARGUMENT envelope must carry details.fields`);
  assert.ok(fields.length > 0, `${label}: details.fields must not be empty`);
  for (const field of fields) {
    assert.equal(typeof field.path, 'string', `${label}: field.path must be a string`);
    assert.ok(String(field.problem).trim().length > 0, `${label}: field.problem must not be empty`);
  }
  return fields as Array<{ path: string; problem: string }>;
}

/** The most recently written audit row, or a failed assertion when the log is empty. */
function lastRow(): ReturnType<typeof mcpAuditLogDb.allRows>[number] {
  const rows = mcpAuditLogDb.allRows();
  assert.ok(rows.length > 0, 'expected at least one audit row');
  return rows[rows.length - 1];
}

// --------------------------- harness ---------------------------

/** One live-run reading, as the real registry reports it. */
type LiveRun = ReturnType<Registry['listRunningRuns']>[number];

type Harness = {
  baseUrl: string;
  registry: Registry;
  /** Issues a live token owned by `ALICE` carrying `scopes`. */
  issue: (scopes: string[]) => { id: number; token: string };
  /** The live run for one session, or undefined when none is running. */
  liveRunFor: (sessionId: string) => LiveRun | undefined;
};

/**
 * Runs `run` against a fresh temp database, a real token service, a real run
 * registry and the mounted gateway.
 *
 * The control stub is the ONLY thing standing in for production: it opens a real
 * run through the real registry (so `sessions_list` and the (b) run reading both
 * look at the same store) and answers `ok`. No refusal path is exercised here —
 * the control service's refusals are AC-249's and AC-250's readings, not this
 * criterion's.
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-correlation-id-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'correlation.db');
  await initializeDatabase();
  // `access_tokens.user_id` references `users(id)`, so the owner has to exist.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(ALICE, 'alice', 'hash');

  const tokens = createAccessTokensService({ now: () => new Date(FIXED_NOW) });
  const registry = createChatRunRegistry({ now: () => FIXED_NOW });

  /** The control seam: open a real run for the target session, answer its id. */
  const control = {
    send: async (
      _caller: unknown,
      input: { sessionId: string; content: string; options?: Record<string, unknown> },
    ) => {
      const opened = registry.startRun({
        appSessionId: input.sessionId,
        provider: 'claude' as const,
        providerSessionId: null,
        connection: null,
        userId: ALICE,
        supersedeRunning: true,
      });
      assert.ok(opened !== null, 'the stub control must always be able to open a run');
      return { ok: true as const, runId: opened.runId, queued: false, queuedMessageUuid: null };
    },
  };

  /**
   * The run seam the write tools read/stamp through: the REAL registry, by-id
   * stamping. The members are named as the registry names them, so this object
   * is the registry's own shape — the same shape production hands over (see leg
   * (a2)) — rather than an adapter that could hide a name mismatch.
   */
  const runs = {
    getRun: (sessionId: string) => registry.getRun(sessionId),
    setRunCorrelationId: (runId: string, correlationId: string) => {
      registry.setRunCorrelationId(runId, correlationId);
    },
  };

  const readTools = {
    sessions: {
      listRecentSessions: () => ({ conversations: SESSION_ROWS, total: SESSION_ROWS.length }),
      readSessionLifecycle: () => ({ provider: 'claude', mode: 'per-run' }),
    },
    hosts: { liveHostForSession: () => null },
    runs: { listRunningRuns: () => registry.listRunningRuns() },
    now: () => FIXED_NOW,
  } as unknown as McpReadToolDeps;

  const writeTools = {
    control,
    runs,
    // Never entered: every send in this criterion asks for no bounded wait. A
    // loud throw rather than a silent `{}` so a future leg that does wait fails
    // visibly instead of hanging on an absent builder.
    runGet: {
      deps: {},
      build: async () => {
        throw new Error('this criterion never asks for a bounded wait');
      },
    },
    // `buildSessionCreate` reads `control` off THIS bag (the registration site
    // spreads `{ ...sessionCreate, runs: deps.runs }`), the same seam
    // `session_send` gets from the top level.
    sessionCreate: {
      projects: { list: () => [{ id: 'proj-1', title: 'Proj', path: '/tmp/proj-1' }] },
      sessions: { create: () => ({ sessionId: 'sess-created' }), switchLifecycle: () => ({}) },
      control,
    },
  } as unknown as McpWriteToolDeps;

  // `approval_answer` registers only when the resident bag carries its services;
  // the stub is never entered — it is what puts the tool (and its schema) on
  // `tools/list` for legs (a) and (e).
  const residentTools = {
    approvals: { control: {}, now: () => FIXED_NOW },
  } as unknown as McpResidentToolDeps;

  const app = express();
  app.use(express.json());
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools,
    writeTools,
    residentTools,
  });

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const port = (httpServer.address() as AddressInfo).port;

  const issue = (scopes: string[]): { id: number; token: string } => {
    const issued = tokens.issueToken({ userId: ALICE, name: 'ac337', scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error('the harness issued a token with a lifetime the service rejects');
    }
    return { id: issued.token.id, token: issued.token.token };
  };

  try {
    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      registry,
      issue,
      liveRunFor: (sessionId) => registry.listRunningRuns().find((entry) => entry.sessionId === sessionId),
    });
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Opens a run for `session` carrying `correlationId` through the real `session_send`. */
async function labelSession(harness: Harness, token: string, session: string, correlationId: string): Promise<string> {
  const sent = await callTool(harness.baseUrl, 'session_send', { session, message: 'hi', correlationId }, token);
  const payload = structuredOf(sent);
  assert.equal(typeof payload.runId, 'string', `the send to ${session} must answer a run id`);
  return String(payload.runId);
}

// --------------------------- (a) the declared label is advertised ---------------------------

test('(a) every declaring tool advertises correlationId on tools/list', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const keys = await advertisedKeys(harness.baseUrl, harness.issue(READ_SCOPES).token);

    // The two write tools that OPEN a run, the two that only label their own
    // audit row, and the four `ui_*` reveals. Plus the two READ filters: their
    // identically named argument is a filter rather than a label (the audit
    // wrapper's write/read split), which is exactly why they belong in the same
    // evidence list — the name is declared in both places, and means the two
    // different things in the two places.
    const declaring = [
      'session_send',
      'session_create',
      'approval_answer',
      'ui_open_session',
      'ui_focus_turn',
      'ui_show_diff',
      'ui_open_task',
      'sessions_list',
      'mcp_usage_stats',
    ];
    for (const name of declaring) {
      const advertised = keys.get(name);
      assert.ok(advertised !== undefined, `tools/list must advertise ${name}`);
      assert.ok(
        advertised.includes('correlationId'),
        `${name} must advertise correlationId; saw ${JSON.stringify(advertised)}`,
      );
    }

    // Non-vacuity: the advertisement is a per-tool reading, not a property of
    // every schema. `session_get` declares exactly one key and is not declaring.
    assert.deepEqual(keys.get('session_get'), ['session'], 'session_get must be unchanged by AC-337');

    console.log(`(a) correlationId advertised on ${declaring.length} tools`);
  });
});

// --------------------------- (a2) the production assembly hands the registry over ---------------------------

test('(a2) the production write assembly hands the run registry over whole, so a send can stamp it', { concurrency: false }, async () => {
  // The DoD on a REAL service instance found this, and nothing in this file could:
  // `createMcpGatewayModule` projected the write bag's run seam down to a literal
  // `{ getRun }`, so the stamp was a silent no-op — the label never reached the
  // registry, and `sessions_list { correlationId }` answered an empty page on the
  // real service while this file's harness, which hand-wrote an adapter carrying
  // the seam's member name, stayed green.
  //
  // The pin is the assembly's OWN output, so a future overlay cannot narrow the
  // seam back without reddening here: the assembled seam IS the process registry,
  // and it can stamp it — through the member named EXACTLY as the registry names
  // it. That second half is not decoration: handing the registry over while the
  // seam called the member `setCorrelationId` left `typeof
  // seam.setRunCorrelationId` at `undefined`, which is how the mismatch read once
  // the identity half was already satisfied.
  const assembled = createMcpGatewayModule({
    control: {} as never,
    writeTools: {
      // Never entered — this leg reads the assembled bag, it drives no tool.
      runGet: {
        deps: {},
        build: async () => {
          throw new Error('this leg never asks for a bounded wait');
        },
      },
    } as never,
  });
  const seam = assembled.writeTools?.runs as
    | {
        getRun: (sessionId: string) => unknown;
        setRunCorrelationId?: (runId: string, correlationId: string) => void;
      }
    | undefined;
  assert.ok(seam !== undefined, 'the assembled write bag must carry a run seam');
  assert.equal(seam, chatRunRegistry, 'the write bag must be handed the process registry, not a `{ getRun }` projection');
  assert.equal(
    typeof seam.setRunCorrelationId,
    'function',
    'the assembled seam must stamp through the member the registry actually exposes',
  );

  // The behavioural half: a stamp through the assembled seam lands on the run
  // the registry holds, read back from the SAME object `sessions_list` filters
  // over. Presence of a method would not be enough — it is the write landing in
  // the reader's store that AC-337 (b)/(c) require.
  const opened = chatRunRegistry.startRun({
    appSessionId: 'prod-seam-session',
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: ALICE,
    supersedeRunning: true,
  });
  assert.ok(opened !== null, 'the process registry must be able to open a run');
  seam.setRunCorrelationId(opened.runId, 'prod-seam-label');
  assert.equal(
    chatRunRegistry.getRun('prod-seam-session')?.correlationId,
    'prod-seam-label',
    'a stamp through the assembled seam must land on the run the registry holds',
  );
  console.log('(a2) the assembled write seam is the process registry, and a stamp through it lands in it');
});

// --------------------------- (b) the run and the audit row ---------------------------

test('(b) a labelled send stamps the run it opened and its own audit row; a label-less send does neither', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const token = harness.issue(SEND_SCOPES).token;

    const runId = await labelSession(harness, token, 'sess-a', LABEL);

    // The RUN reading: the real registry's live reading carries the label, and
    // the session slot holds the run the send opened.
    const liveRun = harness.liveRunFor('sess-a');
    assert.ok(liveRun !== undefined, 'the send must have opened a run for sess-a');
    assert.equal(liveRun.correlationId, LABEL, 'the run the send opened must carry the label');
    assert.equal(harness.registry.getRun('sess-a')?.runId, runId, 'the session slot holds the run the send opened');

    // The AUDIT reading: the call's own row carries the label.
    const labelledRow = lastRow();
    assert.equal(labelledRow.tool, 'session_send');
    assert.equal(labelledRow.correlation_id, LABEL, "the send's own audit row must carry the label");

    // The label-less control: same call, no label.
    const plain = await callTool(harness.baseUrl, 'session_send', { session: 'sess-b', message: 'hi' }, token);
    const plainPayload = structuredOf(plain);
    // S3 (SPEC §8.1) adds `deliveryId` to this payload for every accepted send,
    // labelled or not — it is the delivery handle, not part of the label, so the
    // label-less send still answers exactly the pre-AC-337 fields PLUS that one.
    assert.deepEqual(
      Object.keys(plainPayload).sort(),
      ['blockedBy', 'deliveryId', 'queued', 'queuedMessageUuid', 'runId', 'source'],
      'a label-less send must answer the pre-AC-337 payload shape plus S3s deliveryId',
    );
    assert.equal(plainPayload.deliveryId, null, 'the flag-off world names no delivery');
    const plainRun = harness.liveRunFor('sess-b');
    assert.ok(plainRun !== undefined);
    assert.equal(plainRun.correlationId, null, 'a label-less send must leave the run unlabelled');
    assert.equal(lastRow().correlation_id, null, 'a label-less send must leave its audit row null');

    console.log(
      `(b) run=${runId} label=${String(liveRun.correlationId)}; audit labels: ${String(labelledRow.correlation_id)}/${String(lastRow().correlation_id)}`,
    );
  });
});

test('(b2) a labelled session_create stamps the run its first message opened', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const token = harness.issue(CREATE_SCOPES).token;

    const created = await callTool(
      harness.baseUrl,
      'session_create',
      { project: 'proj-1', message: 'first turn', correlationId: LABEL },
      token,
    );
    const payload = structuredOf(created);
    assert.equal(payload.sessionId, 'sess-created');
    assert.equal(typeof payload.runId, 'string', 'a create with a message opens a run');

    const liveRun = harness.liveRunFor('sess-created');
    assert.ok(liveRun !== undefined, 'the create must have opened a run for the new session');
    assert.equal(liveRun.correlationId, LABEL, 'the create must stamp the run its first message opened');
    assert.equal(lastRow().correlation_id, LABEL, "the create's own audit row must carry the label");

    // A create with NO message opens no run — the label still rides the audit
    // row, because the audit row is per CALL, not per run.
    const bare = await callTool(
      harness.baseUrl,
      'session_create',
      { project: 'proj-1', correlationId: OTHER_LABEL },
      token,
    );
    const barePayload = structuredOf(bare);
    assert.equal(barePayload.sessionId, 'sess-created');
    assert.equal('runId' in barePayload, false, 'a message-less create must open no run');
    assert.equal(lastRow().correlation_id, OTHER_LABEL, 'a label reaches the audit row even when no run opens');

    console.log(`(b2) create run=${String(payload.runId)} label=${String(liveRun.correlationId)}`);
  });
});

// --------------------------- (c) the two read filters ---------------------------

test('(c) sessions_list narrows to the sessions whose live run carries the label', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const token = harness.issue(['cloudcli:read', 'cloudcli:session:send']).token;
    await labelSession(harness, token, 'sess-a', LABEL);
    await labelSession(harness, token, 'sess-b', LABEL);
    // A third running session under the OTHER label proves the filter is an
    // equality on the value rather than "some label is set".
    await labelSession(harness, token, 'sess-c', OTHER_LABEL);

    const all = structuredOf(await callTool(harness.baseUrl, 'sessions_list', {}, token));
    assert.equal(all.total, 3, 'unfiltered sessions_list must still report the whole fixture');
    assert.equal((all.sessions as unknown[]).length, 3);

    const filtered = structuredOf(await callTool(harness.baseUrl, 'sessions_list', { correlationId: LABEL }, token));
    assert.equal(filtered.total, 2, 'the filter must narrow total to the labelled sessions');
    assert.deepEqual(
      (filtered.sessions as Array<{ id: string }>).map((session) => session.id).sort(),
      ['sess-a', 'sess-b'],
      'exactly the sessions whose live run carries the label',
    );
    // Non-vacuity: every returned row IS running — the narrowing is the label,
    // not a state filter that happened to coincide.
    assert.ok(
      (filtered.sessions as Array<{ running: boolean }>).every((session) => session.running),
      'each filtered row must be a running session',
    );

    const otherFilter = structuredOf(
      await callTool(harness.baseUrl, 'sessions_list', { correlationId: OTHER_LABEL }, token),
    );
    assert.deepEqual(
      (otherFilter.sessions as Array<{ id: string }>).map((session) => session.id),
      ['sess-c'],
    );

    const none = structuredOf(await callTool(harness.baseUrl, 'sessions_list', { correlationId: 'no-such-label' }, token));
    assert.deepEqual(none, { sessions: [], total: 0 }, 'an unknown label is an empty list, not an error');

    console.log(
      `(c) all=${String(all.total)} ${LABEL}=${String(filtered.total)} ${OTHER_LABEL}=${String(otherFilter.total)} none=${String(none.total)}`,
    );
  });
});

test('(c2) mcp_usage_stats aggregates exactly the audit rows carrying the label', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const token = harness.issue(['cloudcli:read', 'cloudcli:session:send']).token;
    await labelSession(harness, token, 'sess-a', LABEL);
    await labelSession(harness, token, 'sess-b', LABEL);
    await labelSession(harness, token, 'sess-c', OTHER_LABEL);

    const filtered = structuredOf(
      await callTool(harness.baseUrl, 'mcp_usage_stats', { groupBy: 'tool', correlationId: LABEL }, token),
    ) as { correlationId: string | null; total: number; groups: Array<{ key: string | null; n: number }> };
    assert.equal(filtered.correlationId, LABEL, 'the reading must echo the label it narrowed by');
    assert.equal(filtered.total, 2, 'exactly the two rows carrying the label');
    assert.deepEqual(filtered.groups.map((group) => [group.key, group.n]), [['session_send', 2]]);

    const all = structuredOf(await callTool(harness.baseUrl, 'mcp_usage_stats', { groupBy: 'tool' }, token)) as {
      total: number;
      correlationId: string | null;
    };
    assert.equal(all.correlationId, null, 'no filter reads back as null, never an empty string');
    // Three sends plus at least the stats call just made.
    assert.ok(all.total >= 3, `the unfiltered read must see every row (saw ${all.total})`);
    assert.ok(all.total > filtered.total, 'the filter must genuinely narrow the row set');

    const none = structuredOf(
      await callTool(harness.baseUrl, 'mcp_usage_stats', { groupBy: 'tool', correlationId: 'no-such-label' }, token),
    ) as { total: number; groups: unknown[] };
    assert.equal(none.total, 0, 'an unknown label matches no row');
    assert.deepEqual(none.groups, []);

    console.log(`(c2) all=${String(all.total)} ${LABEL}=${String(filtered.total)} none=${String(none.total)}`);
  });
});

// --------------------------- (d) the label advances nothing ---------------------------

test('(d) a labelled call opens no extra run, writes only its own row and changes no state', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    const token = harness.issue(['cloudcli:read', 'cloudcli:session:send']).token;

    const runsBefore = harness.registry.listRecentRuns().length;
    const rowsBefore = mcpAuditLogDb.count();

    const sent = await callTool(
      harness.baseUrl,
      'session_send',
      { session: 'sess-a', message: 'hi', correlationId: LABEL },
      token,
    );
    const payload = structuredOf(sent);
    assert.equal(typeof payload.runId, 'string');

    // The label is metadata on the ONE run the send opened: it opens no second
    // run and no other entity, and it writes exactly one row — the call it
    // labelled.
    assert.equal(
      harness.registry.listRecentRuns().length,
      runsBefore + 1,
      'the send opens exactly one run and the label opens none',
    );
    assert.equal(mcpAuditLogDb.count(), rowsBefore + 1, 'the label writes exactly one row — the call it labelled');

    const run = harness.registry.getRun('sess-a');
    assert.ok(run !== undefined, 'the labelled run must still be addressable');
    assert.equal(run.status, 'running', 'the label must not advance the run out of running');
    assert.equal(run.lastSeq, 0, 'the label must not advance the run sequencer');
    assert.equal(run.correlationId, LABEL, 'the label is stored verbatim and never rewritten');

    // Two reads over an unchanged fixture answer identically: nothing the label
    // did keeps moving in the background. (The registry's clock is fixed, so a
    // retention/expiry timer cannot fire within this process either.)
    const first = structuredOf(await callTool(harness.baseUrl, 'sessions_list', { correlationId: LABEL }, token));
    const second = structuredOf(await callTool(harness.baseUrl, 'sessions_list', { correlationId: LABEL }, token));
    assert.deepEqual(second, first, 'a labelled call leaves no moving state behind');
    assert.equal(harness.registry.getRun('sess-a')?.status, 'running', 'the run is still running after the reads');

    console.log(`(d) run=${String(payload.runId)} status=${run.status} lastSeq=${run.lastSeq}`);
  });
});

// --------------------------- (e) the contract's refusals ---------------------------

/** The illegal forms the declared charset and length must refuse. */
const ILLEGAL_LABELS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'over the length bound', value: 'x'.repeat(MCP_CORRELATION_ID_MAX_LENGTH + 1) },
  { label: 'empty', value: '' },
  { label: 'a space', value: 'has space' },
  { label: 'a slash', value: 'a/b' },
  { label: 'a non-ASCII letter', value: '标签' },
];

/** One probe per (tool, arguments) pair that declares the label. */
const REFUSAL_PROBES: ReadonlyArray<{ tool: string; scopes: string[]; args: Record<string, unknown> }> = [
  { tool: 'session_send', scopes: SEND_SCOPES, args: { session: 'sess-a', message: 'hi' } },
  { tool: 'session_create', scopes: CREATE_SCOPES, args: { project: 'proj-1' } },
  { tool: 'approval_answer', scopes: APPROVE_SCOPES, args: { requestId: 'req-1', allow: true } },
  { tool: 'sessions_list', scopes: READ_SCOPES, args: {} },
  { tool: 'mcp_usage_stats', scopes: READ_SCOPES, args: { groupBy: 'tool' } },
  { tool: 'ui_open_session', scopes: NAVIGATE_SCOPES, args: { session: 'sess-a' } },
  { tool: 'ui_focus_turn', scopes: NAVIGATE_SCOPES, args: { session: 'sess-a', turnId: 'turn-1' } },
  { tool: 'ui_show_diff', scopes: NAVIGATE_SCOPES, args: { session: 'sess-a', filePath: 'a.ts' } },
  { tool: 'ui_open_task', scopes: NAVIGATE_SCOPES, args: { session: 'sess-a', taskId: 't-1' } },
];

test('(e) an illegal correlationId is refused INVALID_ARGUMENT naming correlationId, on every declaring tool', { concurrency: false }, async () => {
  await withHarness(async (harness) => {
    // Distinct `{ path, problem }` phrases -> the tools that produced them, so
    // every refusal CLASS is recorded — the reading is visible without this
    // criterion depending on Zod's exact wording.
    const phrases = new Map<string, Set<string>>();
    for (const probe of REFUSAL_PROBES) {
      const token = harness.issue(probe.scopes).token;
      for (const illegal of ILLEGAL_LABELS) {
        const reading = await callTool(harness.baseUrl, probe.tool, { ...probe.args, correlationId: illegal.value }, token);
        const envelope = envelopeOf(reading);
        const label = `${probe.tool} + ${illegal.label}`;
        assert.equal(envelope.code, 'INVALID_ARGUMENT', `${label}: must be INVALID_ARGUMENT`);
        const fields = fieldsOf(envelope, label);
        assert.equal(fields[0].path, 'correlationId', `${label}: must name the offending field`);
        const phrase = `${JSON.stringify(fields[0])} for ${illegal.label}`;
        const tools = phrases.get(phrase) ?? new Set<string>();
        tools.add(probe.tool);
        phrases.set(phrase, tools);
      }
    }
    for (const [phrase, tools] of phrases) {
      console.log(`(e) ${phrase} on ${tools.size} tools`);
    }

    // The boundary values are ACCEPTED, so the refusals above are the bound
    // rather than a rule that rejects everything: a real call with each legal
    // label succeeds end to end and the label lands verbatim.
    const token = harness.issue(SEND_SCOPES).token;
    for (const legal of ['y', 'z'.repeat(MCP_CORRELATION_ID_MAX_LENGTH), 'fleet-7f3a.1:2_3']) {
      const payload = structuredOf(
        await callTool(harness.baseUrl, 'session_send', { session: 'sess-a', message: 'hi', correlationId: legal }, token),
      );
      assert.equal(typeof payload.runId, 'string', `the legal label ${JSON.stringify(legal)} must be accepted`);
      assert.equal(harness.liveRunFor('sess-a')?.correlationId, legal, 'a legal label is stored verbatim');
    }
    console.log(`(e) legal boundaries accepted: 1, ${MCP_CORRELATION_ID_MAX_LENGTH} and every declared punctuation character`);
  });
});
