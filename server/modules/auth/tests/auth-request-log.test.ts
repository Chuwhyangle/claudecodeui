/**
 * Criterion: the `/api/auth/*` request line, and the user-not-found warn.
 *
 * The auth surface used to leave no server-side trace of a refused request, so
 * "the server refused it" and "it never arrived" were indistinguishable from the
 * log. This file drives the production pieces over real HTTP:
 *
 *  · `createAuthRequestLogger` mounted at the same `/api/auth` prefix
 *    `server/index.ts` mounts it on, in front of the REAL `authenticateToken`;
 *  · the five outcomes AC2 names — no token, a valid token (200), an expired
 *    token, a forged signature, and a valid signature whose `userId` no longer
 *    exists — each of which must leave exactly one line carrying the method, the
 *    query-stripped path, the status, the refusal reason, the ip and the ua;
 *  · the user-not-found branch's own warn (AC4), which used to be silent.
 *
 * The other half is the invariant: no credential a request carries — a bearer
 * token in a header, the same token in the SSE `token` query parameter, a
 * password in a JSON body — may appear in any line. The tokens are really signed
 * and really sent, so the assertion is against the credential material actually
 * used, not against a string someone invented.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

const TEST_JWT_SECRET = 'auth-request-log-criterion-secret';

// `auth.middleware.ts` resolves `JWT_SECRET` at module-load time and would fall
// back to `appConfigDb.getOrCreateJwtSecret()` (the developer's real database);
// `shared/utils.ts` freezes `IS_PLATFORM`, which would replace token checks with
// "the first database user". Both are evaluated on first import and static
// imports are hoisted above this code, so the environment is set first and the
// aliased modules come in dynamically.
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase } = await import('@/modules/database/index.js');
const { createAuthRequestLogger } = await import('../auth-request-log.service.js');
const { authenticateToken } = await import('../auth.middleware.js');

const USER_ID = 1;

/** A password planted in the login stub's body; a leaked body would carry it. */
const PASSWORD_SENTINEL = 'sentinel-password-must-not-be-logged';

/**
 * Mints an HS256 JWT with the secret `auth.middleware.ts` was loaded with.
 *
 * Built here rather than with the `jsonwebtoken` package, which ships no type
 * declarations — the middleware that consumes it imports it under `@ts-nocheck`,
 * and a criterion file is not the place to start doing the same. A wrong secret
 * yields the forged-signature case; a negative lifetime yields the expired case.
 */
function signToken(
  payload: { userId: number; username: string },
  options: { secret?: string; lifetimeSeconds?: number } = {},
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + (options.lifetimeSeconds ?? 3600) });
  const signature = createHmac('sha256', options.secret ?? TEST_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

type Harness = { base: string; lines: string[]; warnings: string[] };

/**
 * An isolated database, one throwaway user, and the production logger + auth
 * middleware on a real socket. `console.warn` is captured for the duration so
 * AC4 can assert the middleware's own line, not a re-implementation of it.
 */
async function withAuthApp(run: (harness: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'auth-request-log-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash, is_active) VALUES (?, ?, ?, 1)')
    .run(USER_ID, 'criterion-user', 'hash');

  const lines: string[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRequestLogger({ log: (line) => lines.push(line) }));
  app.get('/api/auth/user', authenticateToken, (req, res) => {
    res.json({ user: (req as { user?: unknown }).user });
  });
  // Stand-ins for two real routes. The login stub receives a password in its
  // body and answers the middleware's flat `{ code }` shape; the register stub
  // refuses with the server's AppError envelope `{ error:{ code } }` and NO
  // `X-Auth-Error` header, so the reader can see the reason fall back to each
  // body shape.
  app.post('/api/auth/login', (_req, res) => res.status(401).json({ code: 'AUTH_INVALID_CREDENTIALS' }));
  app.post('/api/auth/register', (_req, res) =>
    res.status(403).json({ success: false, error: { code: 'AUTH_USER_ALREADY_CONFIGURED', message: 'User already exists.' } }));
  app.get('/api/other', (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ base, lines, warnings });
  } finally {
    console.warn = originalWarn;
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

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const LINE = (method: string, path_: string, status: number, reason: string): RegExp =>
  new RegExp(`^\\[AuthReq\\] ${method} ${path_.replace(/\//g, '\\/')} -> ${status} reason=${reason} \\d+ms ip=203\\.0\\.113\\.7 ua="criterion\\/1\\.0"$`);

test('AC2: the five auth outcomes each leave one line with path, status, reason, ip and ua', async () => {
  await withAuthApp(async ({ base, lines }) => {
    const valid = signToken({ userId: USER_ID, username: 'criterion-user' });
    const expired = signToken({ userId: USER_ID, username: 'criterion-user' }, { lifetimeSeconds: -60 });
    const forged = signToken({ userId: USER_ID, username: 'criterion-user' }, { secret: 'not-the-server-secret' });
    const ghost = signToken({ userId: 999999, username: 'ghost' });

    const call = (token?: string) =>
      fetch(`${base}/api/auth/user`, {
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'user-agent': 'criterion/1.0',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

    const statuses = [
      (await call()).status,          // (a) no token
      (await call(valid)).status,     // (b) valid
      (await call(expired)).status,   // (c) expired
      (await call(forged)).status,    // (d) forged signature
      (await call(ghost)).status,     // (e) user not found
    ];
    assert.deepEqual(statuses, [401, 200, 401, 401, 401]);

    await settle();
    assert.equal(lines.length, 5, lines.join('\n'));
    assert.match(lines[0], LINE('GET', '/api/auth/user', 401, 'invalid-token'));
    assert.match(lines[1], LINE('GET', '/api/auth/user', 200, '-'));
    assert.match(lines[2], LINE('GET', '/api/auth/user', 401, 'session-expired'));
    assert.match(lines[3], LINE('GET', '/api/auth/user', 401, 'invalid-token'));
    assert.match(lines[4], LINE('GET', '/api/auth/user', 401, 'invalid-token'));
  });
});

test('AC2: the reason falls back to the body code in both envelopes when no X-Auth-Error is set', async () => {
  await withAuthApp(async ({ base, lines }) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'criterion/1.0' };
    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'criterion-user', password: PASSWORD_SENTINEL }),
    });
    assert.equal(register.status, 403);
    assert.equal(register.headers.get('x-auth-error'), null, 'this route sets no X-Auth-Error header');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'criterion-user', password: PASSWORD_SENTINEL }),
    });
    assert.equal(login.status, 401);
    assert.equal(login.headers.get('x-auth-error'), null, 'this route sets no X-Auth-Error header');

    await settle();
    assert.equal(lines.length, 2, lines.join('\n'));
    // The server's AppError envelope nests the code under `error`; the middleware's
    // flat refusal is top-level. Both must surface as the reason.
    assert.match(lines[0], LINE('POST', '/api/auth/register', 403, 'AUTH_USER_ALREADY_CONFIGURED'));
    assert.match(lines[1], LINE('POST', '/api/auth/login', 401, 'AUTH_INVALID_CREDENTIALS'));
  });
});

test('AC3: no credential a request carries appears in any line', async () => {
  await withAuthApp(async ({ base, lines }) => {
    const valid = signToken({ userId: USER_ID, username: 'criterion-user' });
    const expired = signToken({ userId: USER_ID, username: 'criterion-user' }, { lifetimeSeconds: -60 });
    const forged = signToken({ userId: USER_ID, username: 'criterion-user' }, { secret: 'not-the-server-secret' });
    const ghost = signToken({ userId: 999999, username: 'ghost' });

    await fetch(`${base}/api/auth/user`, { headers: { authorization: `Bearer ${valid}` } });
    // The SSE fallback: the same token in the query string, which the path must drop.
    await fetch(`${base}/api/auth/user?token=${encodeURIComponent(valid)}`);
    await fetch(`${base}/api/auth/user`, { headers: { authorization: `Bearer ${expired}` } });
    await fetch(`${base}/api/auth/user`, { headers: { authorization: `Bearer ${forged}` } });
    await fetch(`${base}/api/auth/user`, { headers: { authorization: `Bearer ${ghost}` } });
    await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'criterion-user', password: PASSWORD_SENTINEL }),
    });

    await settle();
    assert.equal(lines.length, 6, lines.join('\n'));
    const everything = lines.join('\n');
    for (const [name, token] of Object.entries({ valid, expired, forged, ghost })) {
      const [header, payload, signature] = token.split('.');
      assert.ok(!everything.includes(token), `${name}: the whole token must never be logged`);
      assert.ok(!everything.includes(payload), `${name}: the payload segment must never be logged`);
      assert.ok(!everything.includes(signature), `${name}: the signature segment must never be logged`);
      assert.ok(!everything.includes(`${header}.${payload}`), `${name}: no token prefix may be logged`);
    }
    assert.ok(!everything.includes(PASSWORD_SENTINEL), 'the password in the login body must never be logged');
    assert.ok(!lines.some((line) => line.includes('token=')), 'the query string must be dropped from the path');
  });
});

test('AC4: a user-not-found refusal writes a warn with the reason, the path, the ip and the ua', async () => {
  await withAuthApp(async ({ base, warnings }) => {
    const ghost = signToken({ userId: 999999, username: 'ghost' });
    await fetch(`${base}/api/auth/user`, {
      headers: { authorization: `Bearer ${ghost}`, 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'criterion/1.0' },
    });
    await settle();

    const rejected = warnings.filter((warning) => warning.includes('reason=user-not-found'));
    assert.equal(rejected.length, 1, warnings.join('\n'));
    assert.match(rejected[0], /reason=user-not-found path=\/api\/auth\/user /);
    assert.match(rejected[0], / ip=203\.0\.113\.7 /);
    assert.match(rejected[0], / ua="criterion\/1\.0"$/);
    assert.ok(!rejected[0].includes(ghost), 'the warn must not carry the token');
  });
});

test('only the /api/auth prefix is logged, and an unmatched /api/auth path still logs its 404', async () => {
  await withAuthApp(async ({ base, lines }) => {
    await fetch(`${base}/api/other`);
    await fetch(`${base}/api/auth/status`, {
      headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'criterion/1.0' },
    });
    await settle();

    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], LINE('GET', '/api/auth/status', 404, '-'));
  });
});
