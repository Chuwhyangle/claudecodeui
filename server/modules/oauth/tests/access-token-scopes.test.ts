/**
 * AC-243 scope-vocabulary criterion.
 *
 * Drives the production settings route factory (`createSettingsRouter`) over a
 * real express 4 server and real HTTP (`app.listen(0)` + `node:http` — not
 * `fetch`, whose undici layer rejects some `listen(0)` ports), assembled with
 * the real OAuth token service and a real better-sqlite3 database built in a
 * temp directory. Covers:
 *   (a) any non-empty subset of the vocabulary issues 201, the response scopes
 *       equal the requested set with no duplicates, and the stored scopes match;
 *   (b) a mistyped scope, an unprefixed `read`, `cloudcli:admin`, an empty list
 *       and a non-string element are all 400 with the same `INVALID_SCOPE` code
 *       and write no row;
 *   (c) an omitted scope list still defaults to `cloudcli:read`;
 *   (d) the service's own `issueToken` rejects the same illegal scopes and still
 *       issues a valid one — bypassing the route cannot mint a bad scope.
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

import { accessTokensDb, closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { ACCESS_TOKEN_SCOPES, createAccessTokensService } from '@/modules/oauth/index.js';
import type { AccessTokensService } from '@/modules/oauth/index.js';
import { createSettingsRouter, createSettingsService } from '@/modules/settings/index.js';
import { AppError } from '@/shared/utils.js';

const OWNER_ID = 1;

/**
 * The seven issuable scopes written out literally, so a source change that adds
 * `cloudcli:admin` (or drops a scope) is caught here rather than silently
 * changing what the criterion expects.
 */
const VOCABULARY = [
  'cloudcli:read',
  'cloudcli:session:send',
  'cloudcli:session:create',
  'cloudcli:session:control',
  'cloudcli:approve',
  // gap-mcp-ui-open-session: appended last, so the five positional reads in the
  // gateway's write-tool table keep their index.
  'cloudcli:navigate',
  // gap-ui-visible-context-extended-fields: appended after navigate for the same
  // reason — every positional read in the gateway keeps its index.
  'cloudcli:selection',
] as const;

/** A non-empty subset request and the unique scopes it must resolve to. */
const SUBSET_REQUESTS: { requested: string[]; expectedUnique: string[] }[] = [
  { requested: ['cloudcli:read'], expectedUnique: ['cloudcli:read'] },
  { requested: ['cloudcli:session:send'], expectedUnique: ['cloudcli:session:send'] },
  { requested: ['cloudcli:session:create'], expectedUnique: ['cloudcli:session:create'] },
  { requested: ['cloudcli:session:control'], expectedUnique: ['cloudcli:session:control'] },
  { requested: ['cloudcli:approve'], expectedUnique: ['cloudcli:approve'] },
  { requested: ['cloudcli:read', 'cloudcli:approve'], expectedUnique: ['cloudcli:read', 'cloudcli:approve'] },
  { requested: [...VOCABULARY], expectedUnique: [...VOCABULARY] },
  {
    // First-occurrence order is preserved: read then approve.
    requested: ['cloudcli:read', 'cloudcli:read', 'cloudcli:approve'],
    expectedUnique: ['cloudcli:read', 'cloudcli:approve'],
  },
];

/** The five illegal scope payloads that must all share one 400 code. */
const ILLEGAL_SCOPES: unknown[] = [
  ['cloudcli:reed'],
  ['read'],
  ['cloudcli:admin'],
  [],
  ['cloudcli:read', 42],
];

type HttpResponse = { status: number; body: Record<string, unknown>; text: string };

type Harness = {
  /** Port of the mounted settings router on 127.0.0.1. */
  port: number;
  /** The real OAuth token service the settings routes delegate to. */
  tokens: AccessTokensService;
  /** The current row count of `access_tokens`, read straight from the database. */
  countRows: () => number;
  /** The stored `scopes` for a token id, parsed from the real row; null when absent. */
  storedScopes: (tokenId: number) => string[] | null;
  /** Switches the id the injected auth middleware stamps onto `req.user`. */
  setUser: (userId: number) => void;
};

/** POSTs a JSON body over `node:http` and returns the raw status/body/text. */
function postJson(harness: Harness, pathname: string, payload: unknown): Promise<HttpResponse> {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise<HttpResponse>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: harness.port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(data.length) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
          resolve({ status: response.statusCode ?? 0, body, text });
        });
      },
    );
    request.on('error', reject);
    request.write(data);
    request.end();
  });
}

/** Reads the `token.scopes` array out of a create response. */
function responseScopes(body: Record<string, unknown>): string[] {
  const token = body.token as { id: number; scopes: string[] } | undefined;
  assert.notEqual(token, undefined);
  assert.equal(Array.isArray(token!.scopes), true);
  return token!.scopes;
}

/** Reads the `error.code` out of an error response. */
function errorCode(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

/**
 * Runs `run` against a fresh temp database, a real token service, and an express
 * server hosting the production settings router. Cleans everything up afterwards.
 */
async function withSettingsServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'access-token-scopes-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const connection = getConnection();
  connection
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(OWNER_ID, 'owner', 'hash');

  const clock = { current: new Date('2026-01-01T00:00:00.000Z') };
  const tokens = createAccessTokensService({ now: () => new Date(clock.current.getTime()) });

  // Real service + real repositories; only credential/notification/push effects are stubs.
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
  });
  const router = createSettingsRouter(service);

  let currentUserId = OWNER_ID;
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

  try {
    await run({
      port: address.port,
      tokens,
      countRows: () =>
        (connection.prepare('SELECT COUNT(*) AS count FROM access_tokens').get() as { count: number }).count,
      storedScopes: (tokenId) => {
        const row = accessTokensDb.findById(tokenId);
        if (row === undefined) return null;
        return JSON.parse(row.scopes) as string[];
      },
      setUser: (userId) => { currentUserId = userId; },
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

test('(vocabulary) ACCESS_TOKEN_SCOPES is exactly the seven issuable scopes, admin absent', () => {
  assert.deepEqual([...ACCESS_TOKEN_SCOPES], [...VOCABULARY]);
  assert.equal((ACCESS_TOKEN_SCOPES as readonly string[]).includes('cloudcli:admin'), false);
  console.log(`(vocabulary) ACCESS_TOKEN_SCOPES = ${JSON.stringify(ACCESS_TOKEN_SCOPES)}`);
});

test('(a) any non-empty vocabulary subset issues 201 with set-equal, deduplicated, stored scopes', async () => {
  await withSettingsServer(async (harness) => {
    for (const { requested, expectedUnique } of SUBSET_REQUESTS) {
      const response = await postJson(harness, '/api/settings/access-tokens', {
        name: `subset-${requested.join('+')}`,
        expiresInDays: 30,
        scopes: requested,
      });
      const scopes = responseScopes(response.body);
      const token = response.body.token as { id: number };

      assert.equal(response.status, 201);
      // Deduplicated, first-occurrence order preserved.
      assert.deepEqual(scopes, expectedUnique);
      assert.equal(new Set(scopes).size, scopes.length);
      assert.equal(scopes.length, new Set(requested).size);
      // Set equality with the request, independent of order.
      assert.deepEqual([...scopes].sort(), [...new Set(requested)].sort());

      const stored = harness.storedScopes(token.id);
      assert.deepEqual(stored, scopes);

      console.log(
        `(a) request=${JSON.stringify(requested)} status=${response.status} `
        + `response=${JSON.stringify(scopes)} stored=${JSON.stringify(stored)}`,
      );
    }
  });
});

test('(b) the five illegal scope payloads are all 400 INVALID_SCOPE and write no row', async () => {
  await withSettingsServer(async (harness) => {
    const codes: (string | undefined)[] = [];
    for (const scopes of ILLEGAL_SCOPES) {
      const beforeCount = harness.countRows();
      const response = await postJson(harness, '/api/settings/access-tokens', {
        name: 'illegal',
        expiresInDays: 30,
        scopes,
      });
      const afterCount = harness.countRows();
      const code = errorCode(response.body);
      codes.push(code);

      assert.equal(response.status, 400);
      assert.equal(code, 'INVALID_SCOPE');
      assert.equal(afterCount, beforeCount);

      console.log(
        `(b) scopes=${JSON.stringify(scopes)} status=${response.status} code=${code} `
        + `rows ${beforeCount}->${afterCount} body=${response.text}`,
      );
    }
    // The five forms must share one code, not merely each be a 400.
    assert.equal(codes.length, 5);
    assert.equal(new Set(codes).size, 1);
    assert.equal(codes[0], 'INVALID_SCOPE');
  });
});

test('(c) an omitted scope list still defaults to cloudcli:read', async () => {
  await withSettingsServer(async (harness) => {
    const response = await postJson(harness, '/api/settings/access-tokens', {
      name: 'default-scope',
      expiresInDays: 30,
    });
    const scopes = responseScopes(response.body);
    assert.equal(response.status, 201);
    assert.deepEqual(scopes, ['cloudcli:read']);

    const stored = harness.storedScopes((response.body.token as { id: number }).id);
    assert.deepEqual(stored, ['cloudcli:read']);

    console.log(`(c) status=${response.status} token.scopes=${JSON.stringify(scopes)} stored=${JSON.stringify(stored)}`);
  });
});

test('(d) service-level issueToken rejects illegal scopes and still issues a valid one', async () => {
  await withSettingsServer(async (harness) => {
    const beforeCount = harness.countRows();

    const illegal = [
      { scopes: ['cloudcli:reed'] },
      { scopes: ['cloudcli:admin'] },
      { scopes: [] },
    ];
    for (const { scopes } of illegal) {
      const result = harness.tokens.issueToken({ userId: OWNER_ID, scopes });
      assert.deepEqual(result, { ok: false, reason: 'invalid_scope' });
      console.log(`(d) issueToken(${JSON.stringify(scopes)}) = ${JSON.stringify(result)} rows=${harness.countRows()}`);
    }
    assert.equal(harness.countRows(), beforeCount);

    const valid = harness.tokens.issueToken({ userId: OWNER_ID, scopes: ['cloudcli:read'] });
    assert.equal(valid.ok, true);
    assert.equal(harness.countRows(), beforeCount + 1);
    console.log(
      `(d) issueToken(['cloudcli:read']) = ok=${valid.ok} id=${valid.ok ? valid.token.id : '-'} `
      + `rows ${beforeCount}->${harness.countRows()}`,
    );
  });
});
