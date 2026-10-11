/**
 * `GET /api/settings/mcp-audit` criterion (AC-304).
 *
 * Drives the PRODUCTION settings route factory (`createSettingsRouter`) over real
 * HTTP (`app.listen(0)` + `node:http`, never `fetch`: undici refuses a fixed list
 * of ports that `listen(0)` lands on, reddening runs at random), assembled with
 * the real settings service and a real MCP-audit reader over a real
 * better-sqlite3 database built in a temp directory.
 *
 * The `mcpAudit` port is wired exactly as `settings.module.ts` wires it (real
 * `createMcpAuditReader` + real `mcpAuditLogDb` / `accessTokensDb` /
 * `oauthClientsDb`), so this is the production read path, not a test-only one.
 *
 * Legs, one reading each:
 *   (a) the current user's rows come back with at/clientName/tool/outcome/summary;
 *       the default view is WRITES ONLY (a read-only tool's row is absent) and
 *       `?includeReads=true` adds it; a PAT's `clientName` is the token's name;
 *   (b) `summary` is the stored audit digest — ids verbatim, free text reduced to
 *       `{ length, preview }` — and the full text is nowhere in the response;
 *   (c) rows are newest-first and `limit` is clamped into `[MIN, MAX]`;
 *   (d) no plaintext token / hash / prefix and no token_id / client_id key leaks;
 *   (e) another user's rows never appear in this user's read;
 *   (f) every row carries the numeric `durationMs` of its stored row
 *       (gap-mcp-session-get-past-recents-page-and-small-envelope-defects).
 *
 * Every test gets its own fresh temp database, so one leg's fixtures cannot leak
 * into another's readings.
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
  accessTokensDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  mcpAuditLogDb,
  oauthClientsDb,
} from '@/modules/database/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';
import { createSettingsRouter, createSettingsService } from '@/modules/settings/index.js';
import { AppError } from '@/shared/utils.js';

import {
  createMcpAuditReader,
  MCP_AUDIT_ROUTE_DEFAULT_LIMIT,
  MCP_AUDIT_ROUTE_MAX_LIMIT,
  MCP_AUDIT_ROUTE_MIN_LIMIT,
  MCP_TOOL_ANNOTATIONS,
  readMcpAuditLimit,
  recordMcpToolCall,
  summarizeToolArgs,
} from '../index.js';
import type { McpAuditRouteEntry } from '../index.js';

const USER_ONE = 1;
const USER_TWO = 2;
const START = new Date('2026-01-01T00:00:00.000Z');

/** The first annotated tool with the requested `readOnlyHint`, derived — never hard-coded. */
function deriveToolName(readOnly: boolean): string {
  const entry = Object.entries(MCP_TOOL_ANNOTATIONS).find(
    ([, annotations]) => (annotations.readOnlyHint === true) === readOnly,
  );
  assert.ok(entry, `expected an annotated tool with readOnlyHint=${readOnly}`);
  return entry![0];
}

const READ_TOOL = deriveToolName(true);
const WRITE_TOOL = deriveToolName(false);

/** A strictly increasing `YYYY-MM-DD HH:MM:SS` timestamp — the format `CURRENT_TIMESTAMP` produces. */
function stampAt(index: number): string {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  return new Date(base + index * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** A single real-HTTP GET over `node:http` (never `fetch`). */
function getJson(urlString: string): Promise<{ status: number; body: string; json: unknown }> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(body) as unknown;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

type Harness = {
  /** Base URL of the mounted settings router, e.g. `http://127.0.0.1:PORT/api/settings`. */
  baseUrl: string;
  /** Switches the id the injected auth middleware stamps onto `req.user`. */
  setUser: (userId: number) => void;
  /** Issues a live PAT for a user and returns its id and plaintext. */
  issue: (userId: number, name: string) => { id: number; token: string };
  /** The stored `token_hash` for a token id, read straight from the database. */
  tokenHashOf: (tokenId: number) => string;
  /** The stored `token_prefix` for a token id, read straight from the database. */
  tokenPrefixOf: (tokenId: number) => string;
};

/** The rows of a successful read, or a failed assertion with the raw body. */
function rowsOf(read: { status: number; body: string; json: unknown }): McpAuditRouteEntry[] {
  assert.equal(read.status, 200, `expected 200, got ${read.status}: ${read.body}`);
  const json = read.json as { rows?: McpAuditRouteEntry[] } | null;
  assert.ok(json && Array.isArray(json.rows), `response must carry a rows array: ${read.body}`);
  return json!.rows!;
}

/**
 * Runs `run` against a fresh temp database, a real token service, and an express
 * server hosting the production settings router wired to the real audit reader.
 */
async function withAuditServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-route-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'audit-route.db');
  await initializeDatabase();

  const connection = getConnection();
  const insertUser = connection.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
  insertUser.run(USER_ONE, 'owner', 'hash');
  insertUser.run(USER_TWO, 'other', 'hash');

  const clock = { current: new Date(START.getTime()) };
  const tokens = createAccessTokensService({ now: () => new Date(clock.current.getTime()) });

  // Real service + real repositories; only credential/notification/push effects are stubs.
  // The mcpAudit port is the production assembly (settings.module.ts), over the real DBs.
  const service = createSettingsService({
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    accessTokens: {
      list: (userId) => accessTokensDb.listByUser(userId),
      findById: (tokenId) => accessTokensDb.findById(tokenId),
      issue: (input) => tokens.issueToken(input),
      revoke: (tokenId) => tokens.revokeToken(tokenId),
    },
    mcpAudit: createMcpAuditReader({
      listTokenIdsForUser: (userId) => accessTokensDb.listByUser(userId).map((token) => token.id),
      listRowsForTokens: (tokenIds, limit, excludeTools) =>
        mcpAuditLogDb.listForTokens(tokenIds, { limit, excludeTools }),
      resolveClientName: (row) =>
        row.client_id !== null
          ? (oauthClientsDb.findById(row.client_id)?.client_name ?? 'mcp client')
          : row.token_id !== null
            ? (accessTokensDb.findById(row.token_id)?.name ?? 'personal access token')
            : null,
    }),
  });
  const router = createSettingsRouter(service);

  let currentUserId = USER_ONE;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/settings',
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { user?: { id: number } }).user = { id: currentUserId };
      next();
    },
    router,
  );
  // Mirrors the production AppError translation in server/index.ts.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  const issue = (userId: number, name: string): { id: number; token: string } => {
    const issued = tokens.issueToken({ userId, name, scopes: ['cloudcli:read'], expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error('the harness issued a token with a lifetime the service rejects');
    }
    return { id: issued.token.id, token: issued.token.token };
  };

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/api/settings`,
      setUser: (userId) => { currentUserId = userId; },
      issue,
      tokenHashOf: (tokenId) => {
        const row = connection
          .prepare('SELECT token_hash FROM access_tokens WHERE id = ?')
          .get(tokenId) as { token_hash: string } | undefined;
        assert.notEqual(row, undefined);
        return row!.token_hash;
      },
      tokenPrefixOf: (tokenId) => {
        const row = connection
          .prepare('SELECT token_prefix FROM access_tokens WHERE id = ?')
          .get(tokenId) as { token_prefix: string } | undefined;
        assert.notEqual(row, undefined);
        return row!.token_prefix;
      },
    });
  } finally {
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

// --------------------------- (a) write-only default, includeReads ---------------------------

test('(a) the read returns the user rows; writes only by default, reads with includeReads', async () => {
  await withAuditServer(async (harness) => {
    const pat = harness.issue(USER_ONE, 'audit-pat');
    recordMcpToolCall({ tokenId: pat.id, clientId: null, tool: WRITE_TOOL, outcome: 'ok', durationMs: 1, args: { session: 's1' } });
    recordMcpToolCall({ tokenId: pat.id, clientId: null, tool: READ_TOOL, outcome: 'ok', durationMs: 2, args: {} });

    harness.setUser(USER_ONE);
    const defaultRows = rowsOf(await getJson(`${harness.baseUrl}/mcp-audit`));
    assert.equal(defaultRows.length, 1, 'the default view is writes only');
    assert.equal(defaultRows[0].tool, WRITE_TOOL);
    assert.equal(defaultRows.some((row) => row.tool === READ_TOOL), false, 'the read-only row must be absent');
    for (const row of defaultRows) {
      assert.equal(typeof row.at, 'string');
      assert.equal('clientName' in row, true);
      assert.equal(typeof row.tool, 'string');
      assert.equal(typeof row.outcome, 'string');
      assert.equal('summary' in row, true);
    }
    assert.equal(defaultRows[0].clientName, 'audit-pat', 'a PAT (client_id=null) reports its token name');

    const included = rowsOf(await getJson(`${harness.baseUrl}/mcp-audit?includeReads=true`));
    assert.equal(included.length, 2);
    assert.deepEqual(
      [...included].map((row) => row.tool).sort(),
      [READ_TOOL, WRITE_TOOL].sort(),
      'includeReads must add the read-only row',
    );

    console.log(`(a) derived tools: write=${WRITE_TOOL} read=${READ_TOOL}`);
    console.log(`(a) default rows = ${JSON.stringify(defaultRows)}`);
    console.log(`(a) includeReads rows = ${JSON.stringify(included)}`);
  });
});

// --------------------------- (b) summary follows the audit rule ---------------------------

test('(b) summary is the stored audit digest — ids verbatim, free text reduced — with no full text', async () => {
  await withAuditServer(async (harness) => {
    const pat = harness.issue(USER_ONE, 'summary-pat');
    const message = 'x'.repeat(45) + 'SECRET_TAIL';
    recordMcpToolCall({
      tokenId: pat.id,
      clientId: null,
      tool: WRITE_TOOL,
      outcome: 'ok',
      durationMs: 1,
      args: { session: 's1', message },
    });

    harness.setUser(USER_ONE);
    const read = await getJson(`${harness.baseUrl}/mcp-audit`);
    const rows = rowsOf(read);
    assert.equal(rows.length, 1);
    const summary = rows[0].summary as { session?: unknown; message?: unknown };
    assert.equal(summary.session, 's1', 'an id argument is kept verbatim');
    // LITERAL expectation — deliberately NOT derived from summarizeToolArgs.
    assert.deepEqual(summary.message, { length: 56, preview: 'x'.repeat(40) });

    const text = JSON.stringify(read.json);
    const containsRunOf41 = text.includes('x'.repeat(41));
    const containsTail = text.includes('SECRET_TAIL');
    assert.equal(containsRunOf41, false, 'no run past the 40-char preview may appear');
    assert.equal(containsTail, false, 'the secret tail may not appear');

    console.log(`(b) summary = ${JSON.stringify(summary)}`);
    console.log(`(b) response contains 41 x's = ${containsRunOf41}; contains SECRET_TAIL = ${containsTail}`);
  });
});

// --------------------------- (c) newest-first and bounded limit ---------------------------

test('(c) rows are newest-first and limit is clamped into [MIN, MAX]', async () => {
  await withAuditServer(async (harness) => {
    const pat = harness.issue(USER_ONE, 'page-pat');
    const total = MCP_AUDIT_ROUTE_MAX_LIMIT + 1;
    for (let index = 0; index < total; index += 1) {
      mcpAuditLogDb.insert({
        at: stampAt(index),
        tokenId: pat.id,
        clientId: null,
        tool: WRITE_TOOL,
        argsDigest: summarizeToolArgs({ index }),
        outcome: 'ok',
        durationMs: 1,
      });
    }
    harness.setUser(USER_ONE);

    const capped = rowsOf(await getJson(`${harness.baseUrl}/mcp-audit?limit=999999`));
    assert.equal(capped.length, MCP_AUDIT_ROUTE_MAX_LIMIT, 'limit above MAX clamps to MAX');
    for (let index = 1; index < capped.length; index += 1) {
      assert.ok(capped[index - 1].at > capped[index].at, `at must strictly decrease at position ${index}`);
    }
    assert.equal(capped[0].at, stampAt(total - 1), 'the first row must be the newest');

    const single = rowsOf(await getJson(`${harness.baseUrl}/mcp-audit?limit=1`));
    assert.equal(single.length, 1, 'limit=1 returns exactly one row');
    assert.equal(single[0].at, stampAt(total - 1), 'limit=1 returns the newest row');

    const zero = await getJson(`${harness.baseUrl}/mcp-audit?limit=0`);
    const zeroRows = rowsOf(zero);
    assert.equal(zero.status, 200, 'limit=0 must not be a server error');
    assert.ok(zeroRows.length >= 1, 'limit=0 clamps up to the floor');

    const negative = await getJson(`${harness.baseUrl}/mcp-audit?limit=-5`);
    const negativeRows = rowsOf(negative);
    assert.equal(negative.status, 200, 'limit=-5 must not be a server error');
    assert.ok(negativeRows.length >= 1, 'limit=-5 clamps up to the floor');

    console.log(`(c) inserted ${total} rows`);
    console.log(`(c) limit=999999 rows=${capped.length} first at=${capped[0].at}`);
    console.log(`(c) limit=1 rows=${single.length} first at=${single[0].at}`);
    console.log(`(c) limit=0 status=${zero.status} rows=${zeroRows.length}; limit=-5 status=${negative.status} rows=${negativeRows.length}`);
  });
});

// --------------------------- (d) no token material or identity keys ---------------------------

test('(d) the response carries no plaintext token, hash, prefix, or token/client id key', async () => {
  await withAuditServer(async (harness) => {
    const pat = harness.issue(USER_ONE, 'secret-pat');
    recordMcpToolCall({ tokenId: pat.id, clientId: null, tool: WRITE_TOOL, outcome: 'ok', durationMs: 1, args: {} });

    harness.setUser(USER_ONE);
    const read = await getJson(`${harness.baseUrl}/mcp-audit?includeReads=true&limit=999999`);
    const rows = rowsOf(read);
    assert.equal(rows.length, 1);

    const text = JSON.stringify(read.json);
    const hash = harness.tokenHashOf(pat.id);
    const prefix = harness.tokenPrefixOf(pat.id);
    const containsPlaintext = text.includes(pat.token);
    const containsHash = text.includes(hash);
    const containsPrefix = text.includes(prefix);
    assert.equal(containsPlaintext, false, 'the plaintext token must not appear');
    assert.equal(containsHash, false, 'the stored hash must not appear');
    assert.equal(containsPrefix, false, 'the stored prefix must not appear');

    const keys = Object.keys(rows[0]).sort();
    for (const forbidden of ['token_id', 'client_id', 'token_hash', 'token_prefix']) {
      assert.equal(forbidden in rows[0], false, `the row must not carry a ${forbidden} key`);
    }

    console.log(`(d) row keys = [${keys.join(', ')}]`);
    console.log(`(d) contains plaintext=${containsPlaintext}; hash=${containsHash}; prefix=${containsPrefix}`);
  });
});

// --------------------------- (e) ownership filter ---------------------------

test('(e) another user\'s audit rows never appear in this user\'s read', async () => {
  await withAuditServer(async (harness) => {
    const user1Token = harness.issue(USER_ONE, 'user1-pat');
    const user2Token = harness.issue(USER_TWO, 'user2-pat');
    recordMcpToolCall({ tokenId: user1Token.id, clientId: null, tool: WRITE_TOOL, outcome: 'ok', durationMs: 1, args: {} });
    const marker = 'zzz-user2-only-tool';
    recordMcpToolCall({ tokenId: user2Token.id, clientId: null, tool: marker, outcome: 'ok', durationMs: 1, args: { owner: 'user2' } });

    harness.setUser(USER_ONE);
    const read = await getJson(`${harness.baseUrl}/mcp-audit?includeReads=true&limit=999999`);
    const rows = rowsOf(read);
    assert.equal(rows.length, 1, 'only the caller\'s own rows are counted');
    assert.equal(rows[0].tool, WRITE_TOOL);
    const text = JSON.stringify(read.json);
    const markerPresent = text.includes(marker);
    assert.equal(markerPresent, false, 'the other user\'s row must not appear');

    console.log(`(e) user ${USER_ONE} rows = ${JSON.stringify(rows)}`);
    console.log(`(e) user ${USER_TWO} marker "${marker}" present = ${markerPresent}`);
  });
});

// --------------------------- (f) durationMs is the stored duration_ms ---------------------------

test('(f) every row carries the numeric durationMs of its stored row', async () => {
  await withAuditServer(async (harness) => {
    const pat = harness.issue(USER_ONE, 'duration-pat');
    // Distinct durations so an all-zero or all-equal column cannot pass: each
    // row's reading is the row's own value, not a constant.
    const durations = [7, 13, 29];
    for (const [index, durationMs] of durations.entries()) {
      recordMcpToolCall({
        tokenId: pat.id,
        clientId: null,
        tool: WRITE_TOOL,
        outcome: 'ok',
        durationMs,
        args: { index },
      });
    }
    harness.setUser(USER_ONE);

    const rows = rowsOf(await getJson(`${harness.baseUrl}/mcp-audit?limit=999999`));
    assert.equal(rows.length, durations.length, 'every written row comes back');

    // The stored rows, read straight from the same audit repository the route
    // reads — the authority `durationMs` must equal, not the values this test
    // just passed in.
    const stored = mcpAuditLogDb.listForTokens([pat.id], { limit: 10, excludeTools: [] });
    assert.equal(stored.length, durations.length, 'the fixture wrote every row');

    for (const [index, row] of rows.entries()) {
      const storedRow = stored[index];
      console.log(`(f) row ${index} durationMs=${JSON.stringify(row.durationMs)} stored.duration_ms=${JSON.stringify(storedRow.duration_ms)}`);
      assert.equal(typeof row.durationMs, 'number', 'durationMs must be a number');
      assert.equal(row.durationMs, storedRow.duration_ms, 'durationMs must equal the stored duration_ms');
    }
    // Positive control: the readings are exactly the three distinct values
    // written — a constant (0 or otherwise) could not match this multiset.
    assert.deepEqual(
      [...rowDurations(rows)].sort((left, right) => left - right),
      [...durations].sort((left, right) => left - right),
    );
  });
});

/** The rows' `durationMs` readings (typed for the assertion above). */
function rowDurations(rows: McpAuditRouteEntry[]): number[] {
  return rows.map((row) => row.durationMs as number);
}

// --------------------------- limit normalization (pure) ---------------------------

test('limit normalization: default for a non-integer, clamp otherwise', () => {
  assert.equal(readMcpAuditLimit(undefined), MCP_AUDIT_ROUTE_DEFAULT_LIMIT);
  assert.equal(readMcpAuditLimit(''), MCP_AUDIT_ROUTE_DEFAULT_LIMIT);
  assert.equal(readMcpAuditLimit('abc'), MCP_AUDIT_ROUTE_DEFAULT_LIMIT);
  assert.equal(readMcpAuditLimit('1.5'), MCP_AUDIT_ROUTE_DEFAULT_LIMIT);
  assert.equal(readMcpAuditLimit('1'), 1);
  assert.equal(readMcpAuditLimit('0'), MCP_AUDIT_ROUTE_MIN_LIMIT);
  assert.equal(readMcpAuditLimit('-5'), MCP_AUDIT_ROUTE_MIN_LIMIT);
  assert.equal(readMcpAuditLimit('999999'), MCP_AUDIT_ROUTE_MAX_LIMIT);
  console.log(
    `(limit) default=${MCP_AUDIT_ROUTE_DEFAULT_LIMIT} min=${MCP_AUDIT_ROUTE_MIN_LIMIT} max=${MCP_AUDIT_ROUTE_MAX_LIMIT}`,
  );
});
