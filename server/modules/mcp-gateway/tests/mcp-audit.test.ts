/**
 * `mcp_audit_log` criterion (AC-244).
 *
 * Drives the PRODUCTION assembly — `mountMcpGateway` with the real token auth
 * middleware, the real audit wrapper and a real better-sqlite3 database in a
 * temp directory — over real HTTP (`node:http`, never `fetch`: undici refuses a
 * fixed list of ports that `listen(0)` lands on, reddening runs at random; see
 * the AC-240/241/242/243 criteria).
 *
 * Legs, one reading each:
 *   (a) every tool call writes EXACTLY one row, on all three outcomes: ok, ok,
 *       error then denied all bump the row count by one, and each row names the
 *       token that made the call (`token_id`), a null `client_id` (PAT), and a
 *       non-negative integer `duration_ms`; gap-mcp-usage-stats (AC-334) adds
 *       that each row also carries the telemetry tail — `error_code` (null on
 *       ok, the envelope code on a failure), `response_bytes` (the serialized
 *       success payload's byte count, null on a failure) and a null
 *       `correlation_id`;
 *   (b) the argument digest keeps session/project ids verbatim and reduces free
 *       text to its length and first 40 characters — the full 500-character
 *       message appears in NONE of the row's columns;
 *   (c) three unauthenticated calls answer 401, write no row, and leave the
 *       process able to serve a later valid call;
 *   (d) retention deletes a 91-day-old row, keeps an 89-day-old one, runs a pass
 *       immediately at start, and registers a 24-hour callback;
 *   (e) re-running `initializeDatabase` over a populated database is a no-op:
 *       no throw, row count unchanged, columns identical to the SPEC DDL.
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

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  mcpAuditLogDb,
} from '@/modules/database/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';

import {
  createMcpAuthMiddleware,
  MCP_GATEWAY_PATH,
  mountMcpGateway,
  startMcpAuditRetention,
  withMcpAudit,
} from '../index.js';
import type { McpToolHandler, McpToolRegistrar } from '../index.js';

const USER_ONE = 1;
const START = new Date('2026-01-01T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The columns the SPEC DDL declares, in order — the idempotency leg compares against these. */
const SPEC_AUDIT_COLUMNS = [
  'id',
  'at',
  'token_id',
  'client_id',
  'tool',
  'args_digest',
  'outcome',
  'duration_ms',
  // AC-286: the missing scopes a denied row names, appended after AC-244's set.
  'denied_scopes',
  // gap-mcp-usage-stats (AC-334): the telemetry tail, appended after
  // `denied_scopes` so every earlier column keeps its position.
  'error_code',
  'response_bytes',
  'correlation_id',
];

// --------------------------- fake tools ---------------------------

/**
 * Three audited tools registered through the SAME wrapper AC-245+ will use:
 * `echo_ok` needs no scope, `needs_send` needs `cloudcli:session:send`, and
 * `boom` throws — the positive control that an erroring handler is not recorded
 * as `ok`.
 */
const AUDITED_TOOLS: McpToolHandler[] = [
  withMcpAudit({ name: 'echo_ok', requiredScopes: [], handler: () => ({ echoed: true }) }),
  withMcpAudit({
    name: 'needs_send',
    requiredScopes: ['cloudcli:session:send'],
    handler: () => ({ sent: true }),
  }),
  withMcpAudit({
    name: 'boom',
    requiredScopes: [],
    handler: () => {
      throw new Error('boom handler failed');
    },
  }),
];

const registerTools: McpToolRegistrar = (server, principal) => {
  for (const tool of AUDITED_TOOLS) {
    tool(server, principal);
  }
};

// --------------------------- HTTP ---------------------------

type Exchange = { status: number; contentType: string | null; body: string; json: Record<string, unknown> | null };

/** A single real-HTTP exchange over `node:http` (never `fetch`). */
function request(
  baseUrl: string,
  body: unknown,
  authorization?: string,
): Promise<Exchange> {
  const url = new URL(MCP_GATEWAY_PATH, baseUrl);
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    accept: MCP_ACCEPT,
  };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }

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
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            body: responseBody,
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

/** Whether an exchange's JSON-RPC `result` carries `isError: true`. */
function resultIsError(exchange: Exchange): boolean {
  const result = exchange.json?.result as { isError?: boolean } | undefined;
  return result?.isError === true;
}

function toolsCall(
  baseUrl: string,
  name: string,
  args: unknown,
  authorization?: string,
): Promise<Exchange> {
  return request(
    baseUrl,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    authorization,
  );
}

// --------------------------- harnesses ---------------------------

/** Runs `run` against a fresh temp database only (no HTTP server). */
async function withAuditDb(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'audit.db');
  await initializeDatabase();

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type AuditServer = {
  baseUrl: string;
  tokens: ReturnType<typeof createAccessTokensService>;
  /** Issues a live token with the given scopes and returns its id and plaintext. */
  issue: (scopes: string[]) => { id: number; token: string };
};

/** Runs `run` against a fresh temp database, a real token service and the mounted gateway. */
async function withAuditServer(run: (server: AuditServer) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-server-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'audit.db');
  await initializeDatabase();
  // `access_tokens.user_id` references `users(id)`, so the owner row has to exist.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const tokens = createAccessTokensService({ now: () => new Date(START.getTime()) });

  const app = express();
  app.use(express.json());
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    registerTools,
  });

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const port = (httpServer.address() as AddressInfo).port;

  const issue = (scopes: string[]): { id: number; token: string } => {
    const issued = tokens.issueToken({ userId: USER_ONE, name: 'self-check', scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error('the harness issued a token with a lifetime the service rejects');
    }
    return { id: issued.token.id, token: issued.token.token };
  };

  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, tokens, issue });
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

/** The most recently written audit row, or a failed assertion when the log is empty. */
function lastRow(): ReturnType<typeof mcpAuditLogDb.allRows>[number] {
  const rows = mcpAuditLogDb.allRows();
  assert.ok(rows.length > 0, 'expected at least one audit row');
  return rows[rows.length - 1];
}

/** Asserts a row's identity columns name the invoking token and carry a valid duration. */
function assertIdentity(row: ReturnType<typeof lastRow>, tokenId: number): void {
  assert.equal(row.token_id, tokenId, 'token_id must be the invoking token');
  assert.equal(row.client_id, null, 'a PAT has no client id');
  assert.ok(
    typeof row.duration_ms === 'number' && Number.isInteger(row.duration_ms) && row.duration_ms >= 0,
    `duration_ms must be a non-negative integer, got ${String(row.duration_ms)}`,
  );
}

// --------------------------- (a) one row, three outcomes ---------------------------

test('(a) every tool call writes exactly one row, for ok, denied and error', async () => {
  await withAuditServer(async (server) => {
    const full = server.issue(['cloudcli:read', 'cloudcli:session:send']);
    const readOnly = server.issue(['cloudcli:read']);
    const authorization = `Bearer ${full.token}`;

    const readings: string[] = [];

    const beforeOk = mcpAuditLogDb.count();
    const echo = await toolsCall(server.baseUrl, 'echo_ok', {}, authorization);
    assert.equal(echo.status, 200);
    assert.equal(mcpAuditLogDb.count(), beforeOk + 1, 'echo_ok must add exactly one row');
    const echoRow = lastRow();
    assert.equal(echoRow.tool, 'echo_ok');
    assert.equal(echoRow.outcome, 'ok');
    assertIdentity(echoRow, full.id);
    readings.push(`echo_ok count ${beforeOk}->${mcpAuditLogDb.count()} row=${JSON.stringify(echoRow)}`);

    const beforeSend = mcpAuditLogDb.count();
    const send = await toolsCall(server.baseUrl, 'needs_send', {}, authorization);
    assert.equal(send.status, 200);
    assert.equal(mcpAuditLogDb.count(), beforeSend + 1, 'needs_send must add exactly one row');
    const sendRow = lastRow();
    assert.equal(sendRow.tool, 'needs_send');
    assert.equal(sendRow.outcome, 'ok');
    assertIdentity(sendRow, full.id);
    readings.push(`needs_send count ${beforeSend}->${mcpAuditLogDb.count()} row=${JSON.stringify(sendRow)}`);

    const beforeBoom = mcpAuditLogDb.count();
    const boom = await toolsCall(server.baseUrl, 'boom', {}, authorization);
    assert.equal(boom.status, 200);
    assert.equal(resultIsError(boom), true, 'the erroring handler must answer with isError');
    assert.equal(mcpAuditLogDb.count(), beforeBoom + 1, 'boom must add exactly one row');
    const boomRow = lastRow();
    assert.equal(boomRow.tool, 'boom');
    // Positive control: an erroring handler records `error`, not `ok`.
    assert.equal(boomRow.outcome, 'error');
    assertIdentity(boomRow, full.id);
    readings.push(`boom count ${beforeBoom}->${mcpAuditLogDb.count()} row=${JSON.stringify(boomRow)}`);

    const beforeDenied = mcpAuditLogDb.count();
    const denied = await toolsCall(server.baseUrl, 'needs_send', {}, `Bearer ${readOnly.token}`);
    assert.equal(denied.status, 200);
    assert.equal(resultIsError(denied), true, 'a missing scope must answer with isError');
    assert.equal(mcpAuditLogDb.count(), beforeDenied + 1, 'a denied call must add exactly one row');
    const deniedRow = lastRow();
    assert.equal(deniedRow.tool, 'needs_send');
    assert.equal(deniedRow.outcome, 'denied');
    assertIdentity(deniedRow, readOnly.id);
    // AC-286: a denied row names the scope the caller was missing, and only a
    // denied row carries one — the ok/error rows above recorded none.
    assert.deepEqual(
      JSON.parse(deniedRow.denied_scopes ?? 'null'),
      ['cloudcli:session:send'],
      'the denied row must carry the missing scope',
    );
    assert.equal(echoRow.denied_scopes, null, 'an ok row carries no denied scopes');
    assert.equal(sendRow.denied_scopes, null, 'an ok row carries no denied scopes');
    assert.equal(boomRow.denied_scopes, null, 'an error row carries no denied scopes');
    readings.push(`denied count ${beforeDenied}->${mcpAuditLogDb.count()} row=${JSON.stringify(deniedRow)}`);

    // gap-mcp-usage-stats (AC-334 (a)): every row carries the telemetry tail.
    // An `ok` row records no error code and the serialized payload's byte count
    // (the SAME bytes the client received — here the text `{"echoed":true}`);
    // a failure records the code its envelope named and no payload size; and
    // `correlation_id` stays null until a later task fills it.
    assert.equal(echoRow.error_code, null, 'an ok row carries no error code');
    assert.equal(sendRow.error_code, null, 'an ok row carries no error code');
    assert.equal(
      echoRow.response_bytes,
      Buffer.byteLength(JSON.stringify('{"echoed":true}'), 'utf8'),
      'response_bytes must be the serialized success payload the client received',
    );
    assert.equal(boomRow.error_code, 'INTERNAL_ERROR', 'a thrown handler records the envelope code');
    assert.equal(boomRow.response_bytes, null, 'a failure records no response byte count');
    assert.equal(deniedRow.error_code, 'INSUFFICIENT_SCOPE', 'a scope denial records INSUFFICIENT_SCOPE');
    assert.equal(deniedRow.response_bytes, null, 'a denial records no response byte count');
    for (const row of [echoRow, sendRow, boomRow, deniedRow]) {
      assert.equal(row.correlation_id, null, 'correlation_id stays null until a later task fills it');
    }
    readings.push(
      `telemetry echo.error_code=${String(echoRow.error_code)} echo.response_bytes=${String(echoRow.response_bytes)} boom.error_code=${String(boomRow.error_code)} denied.error_code=${String(deniedRow.error_code)}`,
    );

    console.log(`(a) ${readings.join(' | ')}`);
  });
});

// --------------------------- (b) argument digest ---------------------------

test('(b) the digest keeps ids verbatim and reduces free text to length + 40 chars', async () => {
  await withAuditServer(async (server) => {
    const full = server.issue(['cloudcli:session:send']);
    const message = 'A'.repeat(500);
    const sessionId = 'sess-id-123';
    const projectId = 'proj-id-456';

    const response = await toolsCall(
      server.baseUrl,
      'needs_send',
      { session: sessionId, project: projectId, message },
      `Bearer ${full.token}`,
    );
    assert.equal(response.status, 200);

    const row = lastRow();
    const digest = row.args_digest ?? '';
    // Positive control: the ids really are in the digest.
    assert.ok(digest.includes(sessionId), 'session id must be kept verbatim');
    assert.ok(digest.includes(projectId), 'project id must be kept verbatim');
    assert.ok(digest.includes('"length":500'), 'the free text length must be recorded');
    assert.ok(digest.includes('A'.repeat(40)), 'the first 40 characters must be recorded');

    // The full text, and any run of two or more characters past the preview, must
    // appear in NO column of the row.
    const wholeRow = JSON.stringify(row);
    assert.ok(!digest.includes(message), 'the full message must not be in the digest');
    assert.ok(!digest.includes('A'.repeat(60)), 'nothing past the 40-char preview may appear');
    assert.ok(!wholeRow.includes(message), 'the full message must not appear in any column');
    assert.ok(!wholeRow.includes('A'.repeat(60)), 'no run past the preview may appear in any column');

    console.log(`(b) args_digest=${digest}`);
    console.log(`(b) whole-row=${wholeRow}`);
  });
});

// --------------------------- (c) 401 writes no row ---------------------------

test('(c) unauthenticated calls answer 401, write no row, and leave the server alive', async () => {
  await withAuditServer(async (server) => {
    const valid = server.issue(['cloudcli:read']);
    const before = mcpAuditLogDb.count();

    const cases: { label: string; authorization?: string }[] = [
      { label: 'no header' },
      { label: 'empty bearer', authorization: 'Bearer ' },
      { label: 'unknown token', authorization: `Bearer ccp_${'f'.repeat(64)}` },
    ];
    const readings: string[] = [];
    for (const testCase of cases) {
      const response = await toolsCall(server.baseUrl, 'echo_ok', {}, testCase.authorization);
      assert.equal(response.status, 401, `${testCase.label} must be rejected`);
      readings.push(`${testCase.label}=${response.status}`);
      assert.equal(mcpAuditLogDb.count(), before, `${testCase.label} must not write an audit row`);
    }

    // The process survived: a later valid call still succeeds and is audited.
    const after = await toolsCall(server.baseUrl, 'echo_ok', {}, `Bearer ${valid.token}`);
    assert.equal(after.status, 200);
    assert.equal(mcpAuditLogDb.count(), before + 1);

    console.log(`(c) ${readings.join(', ')}; count ${before}->${before} (unauth) then ->${mcpAuditLogDb.count()} (valid)`);
  });
});

// --------------------------- (d) retention and its schedule seam ---------------------------

test('(d) retention deletes only rows past 90 days, runs at start, and schedules daily', async () => {
  await withAuditDb(async () => {
    const t0 = new Date('2026-06-01T00:00:00.000Z');
    const oldAt = new Date(t0.getTime() - 91 * MS_PER_DAY).toISOString();
    const freshAt = new Date(t0.getTime() - 89 * MS_PER_DAY).toISOString();

    mcpAuditLogDb.insert({ at: oldAt, tokenId: 1, clientId: null, tool: 'old', argsDigest: '{}', outcome: 'ok', durationMs: 1 });
    mcpAuditLogDb.insert({ at: freshAt, tokenId: 1, clientId: null, tool: 'fresh', argsDigest: '{}', outcome: 'ok', durationMs: 1 });
    const before = mcpAuditLogDb.count();

    const scheduled: { fn: () => void; ms: number }[] = [];
    const fakeSetInterval = (fn: () => void, ms: number): number => {
      scheduled.push({ fn, ms });
      return 0;
    };

    const retention = startMcpAuditRetention({ now: () => t0, retentionDays: 90, setInterval: fakeSetInterval });
    const afterStartup = mcpAuditLogDb.count();
    const remainingTools = mcpAuditLogDb.allRows().map((row) => row.tool);

    // The immediate (startup) pass removed exactly the 91-day-old row.
    assert.equal(afterStartup, before - 1, 'exactly the expired row must be deleted at startup');
    assert.deepEqual(remainingTools, ['fresh'], 'the unexpired row must be retained');
    assert.equal(scheduled.length, 1, 'one daily callback must be registered');
    assert.equal(scheduled[0].ms, MS_PER_DAY, 'the daily interval must be 24 hours');
    // The registered callback IS the sweep — not a different function.
    assert.equal(scheduled[0].fn, retention.prune, 'the scheduled callback must be the prune sweep');

    // A manual call returns the number of rows it deleted: an old row inserted
    // afterwards is swept, and the return value names the count.
    mcpAuditLogDb.insert({
      at: new Date(t0.getTime() - 95 * MS_PER_DAY).toISOString(),
      tokenId: 1,
      clientId: null,
      tool: 'older',
      argsDigest: '{}',
      outcome: 'ok',
      durationMs: 1,
    });
    const prunedByCall = retention.prune();
    assert.equal(prunedByCall, 1, 'prune() must return the number of rows it removed');
    assert.equal(mcpAuditLogDb.count(), 1, 'the unexpired row survives the second sweep');

    console.log(
      `(d) before=${before} afterStartup=${afterStartup} remaining=${remainingTools.join(',')} scheduledMs=${scheduled[0].ms} prune()=${prunedByCall}`,
    );
  });
});

// --------------------------- (e) migration idempotency ---------------------------

test('(e) re-running initializeDatabase over a populated database changes nothing', async () => {
  await withAuditDb(async () => {
    getConnection()
      .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(USER_ONE, 'owner', 'hash');
    mcpAuditLogDb.insert({ at: START.toISOString(), tokenId: 1, clientId: null, tool: 'one', argsDigest: '{}', outcome: 'ok', durationMs: 1 });
    mcpAuditLogDb.insert({ at: START.toISOString(), tokenId: 1, clientId: null, tool: 'two', argsDigest: '{}', outcome: 'denied', durationMs: 2 });

    const before = mcpAuditLogDb.count();
    const columns = (getConnection().prepare('PRAGMA table_info(mcp_audit_log)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    assert.deepEqual(columns, SPEC_AUDIT_COLUMNS, 'a fresh database already matches the SPEC DDL');

    // The idempotency under test: a second initialize over a table that already
    // exists with data must not throw, drop, or alter anything.
    await initializeDatabase();

    const after = mcpAuditLogDb.count();
    const columnsAfter = (getConnection().prepare('PRAGMA table_info(mcp_audit_log)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    assert.equal(after, before, 'row count must be unchanged by the second initialize');
    assert.deepEqual(columnsAfter, SPEC_AUDIT_COLUMNS, 'columns must be unchanged by the second initialize');

    console.log(`(e) rows ${before}->${after}; columns=[${columnsAfter.join(',')}]`);
  });
});
