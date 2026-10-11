/**
 * `mcp_usage_stats` criterion (gap-mcp-usage-stats / AC-334).
 *
 * Drives the PRODUCTION assembly — `mountMcpGateway` with the real token auth
 * middleware, the real audited wrapper and the real read-tool registration (so
 * the tool's `cloudcli:read` scope, its annotations and its `_meta` error-code
 * set all come off `MCP_STAGE3_READ_TOOLS`, not a test-local restatement) — over
 * real HTTP (`node:http`, never `fetch`: undici refuses a fixed list of ports
 * that `listen(0)` lands on, reddening runs at random; the sibling criteria use
 * the same seam). The backing store is a real better-sqlite3 database in a temp
 * directory.
 *
 * The read-tool deps bag is deliberately empty: `registerMcpReadTools` installs
 * all thirteen names, and the twelve whose services are unwired keep their
 * body-table refusal — `mcp_usage_stats` alone is ALWAYS real (it needs no
 * injected service, only the request principal), which is exactly what this
 * criterion drives.
 *
 * Legs, one reading each:
 *   (a) the audit row an `mcp_usage_stats` call leaves carries the telemetry
 *       tail — a success row records no error code and the serialized payload's
 *       byte count, and a declared-argument failure records `INVALID_ARGUMENT`
 *       with no payload size (AC-334 (a));
 *   (b) the tool groups by `tool` / `error_code` / `client`, and every group's
 *       counters and nearest-rank quantiles (`a[ceil(p*n)-1]`) match the rows
 *       that produced them, byte quantiles over the `ok` rows' `response_bytes`
 *       alone;
 *   (c) only the CALLING TOKEN OWNER's rows are counted: a second user's call
 *       to a tool name the caller never used is absent from the result, and a
 *       user's SECOND token aggregates into the same group as its first (AC-334
 *       (c) — its own assertion, not folded into a combined reading);
 *   (d) a marker string planted past the digest preview in a `session_send`
 *       message appears in NEITHER the stats output (any grouping) NOR any
 *       `mcp_audit_log` row (AC-334 (d) — its own assertion);
 *   (e) a token without `cloudcli:read` is refused `INSUFFICIENT_SCOPE`
 *       (AC-334 (e)).
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
} from '../index.js';
import type { McpReadToolDeps, McpWriteToolDeps } from '../index.js';

const ALICE = 1;
const BOB = 2;
const START = new Date('2026-01-01T00:00:00.000Z');

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The client-facing groups the tool returns, as the wire carries them. */
type StatsGroup = {
  key: string | null;
  n: number;
  ok: number;
  error: number;
  denied: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  bytesP50: number | null;
  bytesP95: number | null;
};

type StatsResult = {
  groupBy: string;
  since: string | null;
  until: string | null;
  total: number;
  groups: StatsGroup[];
};

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

/** The `structuredContent` of a NON-error tool result (a success omits `isError`). */
function structuredOf(exchange: Exchange): Record<string, unknown> {
  const result = exchange.json?.result as
    | { isError?: boolean; structuredContent?: Record<string, unknown> }
    | undefined;
  assert.notEqual(result?.isError, true, `expected a success result, got ${JSON.stringify(exchange.json?.result)}`);
  return result?.structuredContent ?? {};
}

/** The error envelope of an `isError` tool result. */
function envelopeOf(exchange: Exchange): { code?: unknown; message?: unknown } {
  const result = exchange.json?.result as
    | { isError?: boolean; structuredContent?: { code?: unknown; message?: unknown } }
    | undefined;
  assert.equal(result?.isError, true, 'expected an isError result');
  return result?.structuredContent ?? {};
}

// --------------------------- harness ---------------------------

type StatsServer = {
  baseUrl: string;
  /** Issues a live token owned by `userId` and returns its row id and plaintext. */
  issue: (userId: number, scopes: string[]) => { id: number; token: string };
  /** Inserts one audit row directly, so the aggregation has an exactly-known input. */
  seedAudit: (row: {
    tokenId: number | null;
    tool: string;
    outcome: string;
    durationMs: number | null;
    responseBytes?: number | null;
    errorCode?: string | null;
    clientId?: string | null;
  }) => void;
};

/** Runs `run` against a fresh temp database, a real token service and the mounted gateway. */
async function withStatsServer(run: (server: StatsServer) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-usage-stats-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'stats.db');
  await initializeDatabase();
  // `access_tokens.user_id` references `users(id)`, so both owners have to exist.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(ALICE, 'alice', 'hash');
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(BOB, 'bob', 'hash');

  const tokens = createAccessTokensService({ now: () => new Date(START.getTime()) });

  const app = express();
  app.use(express.json());
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    // Empty bags: every table still registers its full name set, so the read
    // seam comes up exactly as production mounts it. Only `mcp_usage_stats` has
    // no service to be unwired from, so only it runs its real handler.
    readTools: {} as unknown as McpReadToolDeps,
    writeTools: {} as unknown as McpWriteToolDeps,
  });

  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const port = (httpServer.address() as AddressInfo).port;

  const issue = (userId: number, scopes: string[]): { id: number; token: string } => {
    const issued = tokens.issueToken({ userId, name: 'self-check', scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error('the harness issued a token with a lifetime the service rejects');
    }
    return { id: issued.token.id, token: issued.token.token };
  };

  const seedAudit: StatsServer['seedAudit'] = (row) =>
    void mcpAuditLogDb.insert({
      tokenId: row.tokenId,
      clientId: row.clientId ?? null,
      tool: row.tool,
      argsDigest: null,
      outcome: row.outcome,
      durationMs: row.durationMs,
      errorCode: row.errorCode ?? null,
      responseBytes: row.responseBytes ?? null,
    });

  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, issue, seedAudit });
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

// --------------------------- (b)(c) shape, quantiles and the user boundary ---------------------------

/**
 * Seeds the exactly-known input every reading below is checked against: Alice
 * owns TWO tokens (a group must span both), and Bob's row names a tool Alice
 * never used. Each reading runs against its own fresh server, so the
 * `mcp_usage_stats` row an earlier reading leaves cannot perturb a later one's
 * quantiles.
 */
function seedFixture(server: StatsServer): { aliceRead: { id: number; token: string }; bobRead: { id: number; token: string } } {
  const aliceRead = server.issue(ALICE, ['cloudcli:read']);
  const aliceRead2 = server.issue(ALICE, ['cloudcli:read']);
  const bobRead = server.issue(BOB, ['cloudcli:read']);

  // Alice's rows: sessions_list succeeds 3x on token 1 and once on token 2, so
  // the group has 4 ok + 1 error across BOTH of her tokens.
  server.seedAudit({ tokenId: aliceRead.id, tool: 'sessions_list', outcome: 'ok', durationMs: 10, responseBytes: 100 });
  server.seedAudit({ tokenId: aliceRead.id, tool: 'sessions_list', outcome: 'ok', durationMs: 20, responseBytes: 200 });
  server.seedAudit({ tokenId: aliceRead.id, tool: 'sessions_list', outcome: 'ok', durationMs: 30, responseBytes: 300 });
  server.seedAudit({
    tokenId: aliceRead.id,
    tool: 'sessions_list',
    outcome: 'error',
    durationMs: 40,
    responseBytes: null,
    errorCode: 'INVALID_ARGUMENT',
  });
  server.seedAudit({ tokenId: aliceRead2.id, tool: 'sessions_list', outcome: 'ok', durationMs: 50, responseBytes: 500 });
  server.seedAudit({
    tokenId: aliceRead2.id,
    tool: 'session_search',
    outcome: 'denied',
    durationMs: 5,
    errorCode: 'INSUFFICIENT_SCOPE',
  });
  // Bob's row names a tool Alice NEVER used: its absence from her reading is
  // the non-mixing assertion (c).
  server.seedAudit({ tokenId: bobRead.id, tool: 'bob_private_tool', outcome: 'ok', durationMs: 999, responseBytes: 9999 });

  return { aliceRead, bobRead };
}

test('(b)(c) groups, counters and nearest-rank quantiles match; a second user never mixes in', async () => {
  // -- groupBy=tool: the core quantile reading ---------------------------------
  await withStatsServer(async (server) => {
    const { aliceRead } = seedFixture(server);
    const byTool = structuredOf(await callTool(server.baseUrl, 'mcp_usage_stats', { groupBy: 'tool' }, aliceRead.token)) as unknown as StatsResult;

    const sessionsList = byTool.groups.find((group) => group.key === 'sessions_list');
    assert.deepEqual(
      sessionsList,
      {
        key: 'sessions_list',
        n: 5,
        ok: 4,
        error: 1,
        denied: 0,
        // durations ascending [10,20,30,40,50]: p50 = a[ceil(0.5*5)-1] = a[2] = 30,
        // p95 = a[ceil(0.95*5)-1] = a[4] = 50, max = 50.
        p50: 30,
        p95: 50,
        max: 50,
        // bytes over the four ok rows [100,200,300,500]: p50 = a[ceil(2)-1] = 200,
        // p95 = a[ceil(3.8)-1] = a[3] = 500. The error row's null byte count is skipped.
        bytesP50: 200,
        bytesP95: 500,
      },
      "the sessions_list group must aggregate both of Alice's tokens and use nearest-rank quantiles",
    );

    const sessionSearch = byTool.groups.find((group) => group.key === 'session_search');
    assert.deepEqual(
      sessionSearch,
      { key: 'session_search', n: 1, ok: 0, error: 0, denied: 1, p50: 5, p95: 5, max: 5, bytesP50: null, bytesP95: null },
      'a group with no successful call reports null byte quantiles, never 0',
    );

    // (c) its own assertion: Bob's private tool is nowhere in Alice's reading, and
    // the grand total is exactly Alice's six rows.
    assert.ok(
      !byTool.groups.some((group) => group.key === 'bob_private_tool'),
      "(c) another user's call must never appear in this caller's aggregation",
    );
    assert.equal(byTool.total, 6, "(c) the total must count only the caller owner's rows");
    assert.deepEqual(
      byTool.groups.map((group) => group.key).sort(),
      ['session_search', 'sessions_list'],
      "(c) exactly the caller owner's tools are grouped",
    );
    console.log(`(b) byTool=${JSON.stringify(byTool.groups)}`);
  });

  // -- groupBy=error_code ------------------------------------------------------
  await withStatsServer(async (server) => {
    const { aliceRead } = seedFixture(server);
    const byError = structuredOf(await callTool(server.baseUrl, 'mcp_usage_stats', { groupBy: 'error_code' }, aliceRead.token)) as unknown as StatsResult;
    const keyed = Object.fromEntries(byError.groups.map((group) => [String(group.key), group]));
    assert.equal(keyed['INVALID_ARGUMENT'].error, 1, 'the error_code grouping counts the INVALID_ARGUMENT row');
    assert.equal(keyed['INSUFFICIENT_SCOPE'].denied, 1, 'the error_code grouping counts the denied row');
    assert.deepEqual(
      { n: keyed['null'].n, ok: keyed['null'].ok, error: keyed['null'].error, denied: keyed['null'].denied },
      { n: 4, ok: 4, error: 0, denied: 0 },
      'the ok rows group under a null error_code',
    );
    console.log(`(b) byError=${JSON.stringify(byError.groups)}`);
  });

  // -- groupBy=client ----------------------------------------------------------
  await withStatsServer(async (server) => {
    const { aliceRead } = seedFixture(server);
    const byClient = structuredOf(await callTool(server.baseUrl, 'mcp_usage_stats', { groupBy: 'client' }, aliceRead.token)) as unknown as StatsResult;
    // Every seeded row is a PAT (no client id), so all of Alice's rows are one group.
    assert.equal(byClient.groups.length, 1, 'every PAT shares the null client key');
    assert.deepEqual(
      { key: byClient.groups[0].key, n: byClient.groups[0].n },
      { key: null, n: 6 },
      "a PAT has no client id, so the key is null and all six of Alice's rows group together",
    );
    console.log(`(b) byClient=${JSON.stringify(byClient.groups)}`);
  });
});

// --------------------------- (a) telemetry columns on the stats rows ---------------------------

test('(a) the stats call records error_code/response_bytes/correlation_id like any tool', async () => {
  await withStatsServer(async (server) => {
    const alice = server.issue(ALICE, ['cloudcli:read']);

    // A declared-argument failure: `groupBy` is required, so an empty object is
    // an INVALID_ARGUMENT — recorded with the envelope's code and no payload.
    const bad = await callTool(server.baseUrl, 'mcp_usage_stats', {}, alice.token);
    assert.equal(envelopeOf(bad).code, 'INVALID_ARGUMENT', 'an empty object must fail the groupBy requirement');
    const badRow = lastRow();
    assert.equal(badRow.tool, 'mcp_usage_stats');
    assert.equal(badRow.outcome, 'error');
    assert.equal(badRow.error_code, 'INVALID_ARGUMENT', 'a schema failure records the envelope code');
    assert.equal(badRow.response_bytes, null, 'a failure records no response byte count');

    // A success: no error code, and the byte count is the serialized payload the
    // client received (the same structuredContent, independent of key order).
    const ok = await callTool(server.baseUrl, 'mcp_usage_stats', { groupBy: 'tool' }, alice.token);
    const structured = structuredOf(ok);
    const okRow = lastRow();
    assert.equal(okRow.tool, 'mcp_usage_stats');
    assert.equal(okRow.outcome, 'ok');
    assert.equal(okRow.error_code, null, 'a success records no error code');
    assert.equal(
      okRow.response_bytes,
      Buffer.byteLength(JSON.stringify(structured), 'utf8'),
      'response_bytes must be the serialized success payload the client received',
    );
    assert.equal(okRow.correlation_id, null, 'correlation_id stays null until a later task fills it');

    console.log(`(a) badRow=${JSON.stringify(badRow)} okRow=${JSON.stringify(okRow)}`);
  });
});

// --------------------------- (d) no bodies, ever ---------------------------

test('(d) a marker planted in a session_send body appears in neither the stats nor the audit rows', async () => {
  await withStatsServer(async (server) => {
    const alice = server.issue(ALICE, ['cloudcli:read', 'cloudcli:session:send']);
    const MARKER = 'ZZ_LEAKCANARY_9f3c';
    // The digest keeps the first 40 characters of free text; the marker sits
    // PAST that preview, so its absence is a real reading about the body, not a
    // property of a short string.
    const message = `${'x'.repeat(64)}${MARKER}`;
    const seeded = await callTool(
      server.baseUrl,
      'session_send',
      { session: 'sess-marker', message },
      alice.token,
    );
    assert.equal(seeded.status, 200);

    for (const groupBy of ['tool', 'error_code', 'client'] as const) {
      const stats = await callTool(server.baseUrl, 'mcp_usage_stats', { groupBy }, alice.token);
      assert.ok(
        !JSON.stringify(stats.json?.result ?? null).includes(MARKER),
        `(d) the ${groupBy} stats output must never carry an argument body`,
      );
    }

    const allRows = JSON.stringify(mcpAuditLogDb.allRows());
    assert.ok(!allRows.includes(MARKER), '(d) no audit row may carry an argument body');
    assert.ok(!allRows.includes(message), '(d) the full message must appear in no audit row');

    // Positive control: the send DID reach the audit log — its digest carries the
    // reduced preview, so "found nothing" is not "wrote nothing".
    const sendRow = mcpAuditLogDb.allRows().find((row) => row.tool === 'session_send');
    assert.ok(sendRow !== undefined, 'the session_send call must have written an audit row');
    assert.ok((sendRow.args_digest ?? '').includes('x'.repeat(40)), 'the digest must carry the reduced preview');

    console.log(`(d) marker absent from stats output and ${mcpAuditLogDb.allRows().length} audit rows; send digest=${sendRow.args_digest}`);
  });
});

// --------------------------- (e) scope gate ---------------------------

test('(e) a token without cloudcli:read is refused INSUFFICIENT_SCOPE', async () => {
  await withStatsServer(async (server) => {
    // A token with SOME scope but not the read scope this tool requires.
    const wrongScope = server.issue(ALICE, ['cloudcli:session:send']);

    const refused = await callTool(server.baseUrl, 'mcp_usage_stats', { groupBy: 'tool' }, wrongScope.token);
    assert.equal(refused.status, 200, 'a missing scope is a tool-result refusal, not an HTTP error');
    const envelope = envelopeOf(refused);
    assert.equal(envelope.code, 'INSUFFICIENT_SCOPE', 'the refusal must name the missing scope class');
    assert.match(String(envelope.message), /cloudcli:read/, 'the sentence must name the scope the caller lacks');

    // The refusal is audited like any other call.
    const row = lastRow();
    assert.equal(row.tool, 'mcp_usage_stats');
    assert.equal(row.outcome, 'denied');
    assert.equal(row.error_code, 'INSUFFICIENT_SCOPE');

    console.log(`(e) envelope=${JSON.stringify(envelope)} row=${JSON.stringify(row)}`);
  });
});
