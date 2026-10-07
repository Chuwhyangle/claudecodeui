/**
 * AC-268 criterion (re-based on the SPA consent hand-off,
 * gap-oauth-consent-spa-backend-contract): the OAuth authorization-code flow, end
 * to end, over real HTTP against a REAL `server/index.ts` process (GOAL-021 exit
 * condition 7; mcp-gateway-SPEC v3.1 §403–§421, §148–§156, §451).
 *
 * The instance is a real child process on a temporary port, with a temporary
 * `HOME` and an EXPLICITLY overridden `DATABASE_PATH` (the ambient shell exports
 * the operator's real database path, so a child that inherited it would write
 * the real library). `MCP_ENABLED=1`, `MCP_OAUTH_ENABLED=1`, `MCP_DCR=open`,
 * `PUBLIC_BASE_URL=http://127.0.0.1:<port>` (127.0.0.1 is the SPEC's localhost
 * https exemption). Every request goes over `node:http`, never `fetch`: this
 * criterion runs without the suite's undici preload and undici refuses a fixed
 * set of ports `listen(0)` can land on.
 *
 * One run reads:
 *   (a) discovery (both `/.well-known/*` answer JSON) -> DCR registration ->
 *       `GET /oauth/authorize` 302s to the relative SPA route -> the JWT-guarded
 *       `/api/oauth/authorize/context` and `/decision` round trip — a READ-ONLY
 *       grant needs no password (the session alone), while a WRITE grant
 *       re-confirms the seeded account's password, which AC-261 restored (both
 *       modes are exercised, AC7) — -> the `redirectTo` carries a code ->
 *       `/oauth/token` exchanges it for access+refresh;
 *   (b) `/mcp` `tools/list` and `overview` with the access token;
 *   (c) refresh rotation (new pair) and the OLD refresh token's rejection;
 *   (d) the SAME access token: 200 before the settings revoke, 401 after;
 *   (e) five counterexamples in the same run: a consent decision with NO bearer
 *       JWT gets 401 (the session gate), a WRITE decision that carries a valid
 *       session but the WRONG confirmation password gets 401 `invalid_credentials`
 *       and no `redirectTo`, a WRITE decision with NO password is likewise 401
 *       (an absent confirmation is a failed one, not a bypass), a wrong
 *       `code_verifier` gets no token, a replayed code is refused;
 *   (R) `/oauth/revoke` genuinely revokes a token (its next `/mcp` is 401).
 *
 * The mount under test is the production one: `/oauth/authorize`, the
 * `/api/oauth/authorize` JSON API, `/oauth/token` and `/oauth/revoke` are
 * attached by `mountOAuthServer`, and the SPA document-header middleware is
 * mounted at `/oauth/consent` — both in `server/index.ts` BEFORE
 * `createStaticAssetsMiddleware` (AC8 scans the source for that order).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// server/modules/mcp-gateway/tests -> repo root is four directories up.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SERVER_ENTRY = 'server/index.ts';
/** The exact line the product prints once it is accepting connections. */
const READY_LINE = 'CloudCLI Server - Ready';

const TEST_JWT_SECRET = 'oauth-flow-e2e-secret';
const USERNAME = 'oauth-e2e-user';
/**
 * The seeded account's real password: since AC-261 the consent `allow` branch
 * re-verifies the signed-in user's credentials, so the seed below must carry a
 * hash the server's own bcrypt check accepts — and every decision posts it.
 */
const ACCOUNT_PASSWORD = 'oauth-e2e-password';
const REDIRECT_URI = 'https://app.example/cb';
const READ_SCOPE = 'cloudcli:read';
/**
 * A state-changing scope. Since gap-oauth-consent-flow-ux-hardening the consent
 * `allow` branch asks for the password ONLY when the grant reaches past
 * `cloudcli:read`, so the wrong-password counterexample and the password-carrying
 * mode below must submit this alongside the read scope.
 */
const WRITE_SCOPE = 'cloudcli:session:send';

/**
 * The same native module the auth module hashes with (`bcrypt.hash(pw, 12)` in
 * `auth.module.ts`), loaded directly because the hash is minted on the criterion
 * side, before any server process exists. Only `hashSync` is consumed.
 */
const bcrypt = createRequire(import.meta.url)('bcrypt') as {
  hashSync(data: string, saltRounds: number): string;
};
/** The route the authorization endpoint hands the browser to (mirrors `shared/oauthConsent.ts`). */
const SPA_CONSENT_PATH = '/oauth/consent';
/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';
const BOOT_TIMEOUT_MS = 120_000;

// --------------------------- HTTP (node:http, never fetch) ---------------------------

type HttpReading = {
  status: number;
  headers: http.IncomingHttpHeaders;
  contentType: string | null;
  text: string;
  json: Record<string, unknown> | null;
};

/** Parses a body that may be plain JSON or one SSE `data:` frame (the `/mcp` wire shapes). */
function parseBody(text: string, contentType: string | null): Record<string, unknown> | null {
  let payload = text;
  if ((contentType ?? '').includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      return null;
    }
    payload = dataLine.slice('data:'.length).trim();
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One HTTP request over `node:http`; the body is a pre-encoded string when present. */
function httpCall(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<HttpReading> {
  const headers: Record<string, string | number> = { ...(options.headers ?? {}) };
  const payload = options.body === undefined ? null : Buffer.from(options.body, 'utf8');
  if (payload !== null) {
    headers['content-length'] = payload.length;
  }

  return new Promise<HttpReading>((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: options.path, method: options.method, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          const contentType = (res.headers['content-type'] as string | undefined) ?? null;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            contentType,
            text,
            json: parseBody(text, contentType),
          });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/** Encodes form fields as `application/x-www-form-urlencoded`. */
function formEncode(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** A single JSON-RPC POST to `/mcp`, with an optional bearer token. */
function mcpCall(
  port: number,
  message: Record<string, unknown>,
  token?: string
): Promise<HttpReading> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: MCP_ACCEPT,
  };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return httpCall(port, { method: 'POST', path: '/mcp', headers, body: JSON.stringify(message) });
}

/** The JSON-RPC `result` of an exchange, or null when the envelope carried an `error`. */
function rpcResult(reading: HttpReading): Record<string, unknown> | null {
  const result = reading.json?.result;
  return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
}

/** A fresh PKCE pair: a random verifier and its S256 (base64url) challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** The `code`/`state` a decision's `redirectTo` carries, or nulls when it did not redirect. */
function codeFromRedirectTo(redirectTo: string | undefined): { code: string | null; state: string | null } {
  if (redirectTo === undefined) {
    return { code: null, state: null };
  }
  const url = new URL(redirectTo);
  return { code: url.searchParams.get('code'), state: url.searchParams.get('state') };
}

/** The `redirectTo` a decision response's JSON body carries, or undefined. */
function redirectToOf(reading: HttpReading): string | undefined {
  const value = reading.json?.redirectTo;
  return typeof value === 'string' ? value : undefined;
}

// --------------------------- seeding + spawning ---------------------------

/** A socket bound to port 0, closed, whose number is handed to the server. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Mints the HS256 JWT `authenticateToken` verifies, with the secret the server was handed. */
function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = crypto.createHmac('sha256', TEST_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

type ServerContext = {
  port: number;
  baseUrl: string;
  tempRoot: string;
  dbPath: string;
  homeDir: string;
  leaderPid: number;
  userId: number;
  jwt: string;
  logText: () => string;
  environment: () => string;
};

/**
 * Seeds a temp database with ONE CloudCLI user, boots a real `server/index.ts`
 * process against it on a temp port, waits for the ready line, and hands the
 * context to `run`. The user row is what `oauth_grants.user_id` references and
 * what `authenticateToken` loads for the minted JWT; since AC-261 it is also what
 * the consent `allow` branch re-verifies against, so the seeded hash is a real
 * bcrypt hash of a known password (the placeholder the SPA migration left is no
 * longer usable). The process group is SIGKILLed and the temp tree removed on
 * every exit path.
 */
async function withRealServer(run: (context: ServerContext) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oauth-flow-e2e-'));
  const dbPath = path.join(tempRoot, 'auth.db');
  const homeDir = path.join(tempRoot, 'home');
  fs.mkdirSync(homeDir, { recursive: true });

  // Seed BEFORE spawning: the database module reads DATABASE_PATH when it
  // connects, so the temp path is in place first. `initializeDatabase` builds the
  // production schema; `userDb.createUser` writes the one user the consent API's
  // JWT belongs to.
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;
  const { closeConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');
  await initializeDatabase();
  const created = userDb.createUser(USERNAME, bcrypt.hashSync(ACCOUNT_PASSWORD, 10));
  const userId = Number(created.id);
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }

  const port = await freePort();
  const logPath = path.join(tempRoot, 'server.log');
  const logFd = fs.openSync(logPath, 'a');

  // The ambient shell exports a real database path, host and port; every one is
  // dropped so the child can only see the values this criterion hands it.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', 'PUBLIC_BASE_URL', 'MCP_ENABLED', 'MCP_OAUTH_ENABLED', 'MCP_DCR']) {
    delete env[name];
  }
  Object.assign(env, {
    DATABASE_PATH: dbPath,
    HOME: homeDir,
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    JWT_SECRET: TEST_JWT_SECRET,
    MCP_ENABLED: '1',
    MCP_OAUTH_ENABLED: '1',
    MCP_DCR: 'open',
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    FORCE_COLOR: '0',
  });

  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  const leaderPid = child.pid;
  assert.ok(leaderPid !== undefined, 'the server child has no pid; the boot never happened');

  const logText = (): string => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  const environment = (): string => {
    try {
      return fs.readFileSync(`/proc/${leaderPid}/environ`, 'utf8').split('\0').join('\n');
    } catch {
      return '';
    }
  };

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let ready = false;
    for (;;) {
      try {
        const health = await httpCall(port, { method: 'GET', path: '/health' });
        if (health.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }
    assert.ok(
      ready,
      `the server on port ${port} never answered /health within ${BOOT_TIMEOUT_MS}ms\n--- log ---\n${logText().slice(-4000)}`
    );

    await run({
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      tempRoot,
      dbPath,
      homeDir,
      leaderPid,
      userId,
      jwt: signToken({ userId, username: USERNAME }),
      logText,
      environment,
    });
  } finally {
    try {
      process.kill(-leaderPid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    // Wait for the group leader to disappear so the temp tree is not removed out
    // from under a process still writing to it.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(leaderPid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    fs.closeSync(logFd);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// --------------------------- AC-268 ---------------------------

test('AC-268: the OAuth flow completes end to end on a real server process', { concurrency: false }, async () => {
  await withRealServer(async (ctx) => {
    const publicBaseUrl = `http://127.0.0.1:${ctx.port}`;

    // ---- (AC9) instance isolation readings ----------------------------------
    console.log(`[AC9] tempRoot=${ctx.tempRoot}`);
    console.log(`[AC9] DATABASE_PATH=${ctx.dbPath} HOME=${ctx.homeDir} SERVER_PORT=${ctx.port} HOST=127.0.0.1`);
    const envText = ctx.environment();
    assert.ok(
      envText.includes(`DATABASE_PATH=${ctx.dbPath}`),
      `/proc/<leader>/environ must carry the temp DATABASE_PATH, got:\n${envText}`
    );
    assert.ok(envText.includes(`HOME=${ctx.homeDir}`), 'the child HOME must be the temp directory');
    assert.ok(envText.includes(`SERVER_PORT=${ctx.port}`), 'the child port must be the temp port');
    assert.ok(fs.existsSync(ctx.dbPath), 'the temp database file must exist');
    console.log(`[AC9] /proc environ proof: DATABASE_PATH=${ctx.dbPath} HOME=${ctx.homeDir} SERVER_PORT=${ctx.port}`);

    // ---- (AC8) it is the production assembly --------------------------------
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, SERVER_ENTRY), 'utf8');
    // Match the CALL sites, not the import statements (the import list sits at the
    // top of the file and would make the comparison vacuous).
    const mountAt = indexSource.indexOf('mountOAuthServer(app');
    const staticAt = indexSource.indexOf('createStaticAssetsMiddleware({');
    const docHeadersAt = indexSource.indexOf('createOAuthConsentDocumentHeadersMiddleware()');
    assert.ok(mountAt >= 0, 'server/index.ts must call mountOAuthServer');
    assert.ok(staticAt >= 0, 'server/index.ts must mount createStaticAssetsMiddleware');
    assert.ok(
      mountAt < staticAt,
      `mountOAuthServer (offset ${mountAt}) must precede createStaticAssetsMiddleware (offset ${staticAt})`
    );
    assert.ok(docHeadersAt >= 0, 'server/index.ts must mount createOAuthConsentDocumentHeadersMiddleware()');
    assert.ok(
      docHeadersAt < staticAt,
      `the SPA document-header middleware (offset ${docHeadersAt}) must precede createStaticAssetsMiddleware (offset ${staticAt})`
    );
    const cmdline = fs.readFileSync(`/proc/${ctx.leaderPid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    console.log(`[AC8] server/index.ts: mountOAuthServer@${mountAt} < consentDocHeaders@${docHeadersAt} < createStaticAssetsMiddleware@${staticAt}`);
    console.log(`[AC8] process cmdline: ${cmdline.join(' ')}`);
    assert.ok(cmdline.some((part) => part.includes(SERVER_ENTRY)), 'the live process must be server/index.ts');
    assert.ok(ctx.logText().includes('oauth server mounted'), `the mount must be logged, got:\n${ctx.logText().slice(-3000)}`);
    assert.ok(ctx.logText().includes(READY_LINE), `the ready line must appear, got:\n${ctx.logText().slice(-3000)}`);

    // ---- (AC3 / (a)) discovery -> DCR -> consent -> token --------------------
    const asMetadata = await httpCall(ctx.port, { method: 'GET', path: '/.well-known/oauth-authorization-server' });
    console.log(`[a] GET /.well-known/oauth-authorization-server -> ${asMetadata.status} ${asMetadata.contentType} ${asMetadata.text}`);
    assert.equal(asMetadata.status, 200, 'authorization-server metadata must answer 200');
    assert.ok((asMetadata.contentType ?? '').includes('application/json'), 'AS metadata must be JSON, not the SPA');
    assert.equal(asMetadata.json?.issuer, publicBaseUrl, 'issuer must be the public base URL');
    assert.equal(asMetadata.json?.authorization_endpoint, `${publicBaseUrl}/oauth/authorize`);
    assert.equal(asMetadata.json?.token_endpoint, `${publicBaseUrl}/oauth/token`);
    assert.equal(asMetadata.json?.revocation_endpoint, `${publicBaseUrl}/oauth/revoke`);
    assert.equal(asMetadata.json?.registration_endpoint, `${publicBaseUrl}/oauth/register`);

    const prm = await httpCall(ctx.port, { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' });
    console.log(`[a] GET /.well-known/oauth-protected-resource/mcp -> ${prm.status} ${prm.contentType} ${prm.text}`);
    assert.equal(prm.status, 200, 'protected-resource metadata must answer 200');
    assert.ok((prm.contentType ?? '').includes('application/json'), 'PRM metadata must be JSON, not the SPA');
    assert.equal(prm.json?.resource, `${publicBaseUrl}/mcp`, 'the protected resource must be this gateway');

    const registration = await httpCall(ctx.port, {
      method: 'POST',
      path: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'oauth-flow-criterion', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
    });
    console.log(`[a] POST /oauth/register -> ${registration.status} ${registration.text}`);
    assert.equal(registration.status, 201, 'DCR must register the client');
    const clientId = registration.json?.client_id;
    assert.equal(typeof clientId, 'string', 'registration must return a client_id');
    assert.ok(typeof clientId === 'string' && clientId.length > 0, 'client_id must be non-empty');
    // A public client (token_endpoint_auth_method none) carries no secret.
    assert.equal(registration.json?.client_secret, undefined, 'a public DCR client must carry no secret');

    // ---- (AC8) the consent surface's headers on the live server --------------
    const spaProbe = await httpCall(ctx.port, {
      method: 'GET',
      path: `${SPA_CONSENT_PATH}?client_id=${clientId as string}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`,
    });
    console.log(
      `[AC8] GET ${SPA_CONSENT_PATH} -> ${spaProbe.status} location=${String(spaProbe.headers.location)} `
      + `x-frame-options=${String(spaProbe.headers['x-frame-options'])} `
      + `csp="${String(spaProbe.headers['content-security-policy'])}" `
      + `cache-control="${String(spaProbe.headers['cache-control'])}"`
    );
    assert.equal(spaProbe.headers['x-frame-options'], 'DENY', 'the SPA consent route must refuse framing');
    assert.ok(
      String(spaProbe.headers['content-security-policy']).includes("frame-ancestors 'none'"),
      'the SPA consent route must carry frame-ancestors none'
    );
    assert.ok(
      String(spaProbe.headers['cache-control']).includes('no-store'),
      'the SPA consent route must not be cached'
    );

    // The full consent + code + exchange path, factored so each grant reuses it:
    // `GET /oauth/authorize` validates and hands off to the SPA route; the SPA's
    // two JWT-guarded JSON round trips mint the code; the token endpoint exchanges it.
    //
    // Two modes, per gap-oauth-consent-flow-ux-hardening's narrowed password rule:
    //   'read-only' — a grant of nothing but `cloudcli:read` needs NO password; the
    //                 decision posts none.
    //   'write'     — a grant that reaches past the read scope needs the password;
    //                 the decision posts the seeded account's real one.
    // AC7: both modes must be green over the REAL server.
    async function obtainCode(
      mode: 'read-only' | 'write' = 'read-only'
    ): Promise<{ verifier: string; challenge: string; state: string; code: string; redirectTo: string }> {
      const scopes = mode === 'write' ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE];
      const password = mode === 'write' ? ACCOUNT_PASSWORD : '';
      const { verifier, challenge } = pkcePair();
      const state = crypto.randomBytes(8).toString('hex');
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId as string,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: scopes.join(' '),
        state,
      });

      const authorize = await httpCall(ctx.port, { method: 'GET', path: `/oauth/authorize?${query.toString()}` });
      const location = (authorize.headers.location as string | undefined) ?? '';
      console.log(`[a] GET /oauth/authorize -> ${authorize.status} location=${location}`);
      assert.equal(authorize.status, 302, 'a valid authorization request must redirect to the SPA route');
      assert.ok(
        location.startsWith(`${SPA_CONSENT_PATH}?`),
        `the redirect must be the relative SPA route carrying the query: ${location}`
      );

      const context = await httpCall(ctx.port, {
        method: 'GET',
        path: `/api/oauth/authorize/context?${query.toString()}`,
        headers: { authorization: `Bearer ${ctx.jwt}` },
      });
      console.log(`[a] GET /api/oauth/authorize/context -> ${context.status} ${context.text}`);
      assert.equal(context.status, 200, 'the context API must answer with the bearer JWT');
      assert.equal(context.json?.state, state, 'the context must echo the state');
      assert.equal(context.json?.redirectUri, REDIRECT_URI, 'the context must echo the redirect_uri');

      const decision = await httpCall(ctx.port, {
        method: 'POST',
        path: '/api/oauth/authorize/decision',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.jwt}` },
        body: JSON.stringify({
          client_id: clientId as string,
          redirect_uri: REDIRECT_URI,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scopes,
          action: 'allow',
          // AC-261 (narrowed): the password is required only for the write mode;
          // the read-only mode posts none and is authorized by the session alone.
          password,
        }),
      });
      const redirectTo = redirectToOf(decision);
      console.log(`[a] POST /api/oauth/authorize/decision (${mode}) -> ${decision.status} redirectTo=${String(redirectTo)}`);
      assert.equal(decision.status, 200, `an allow decision must answer 200 in the ${mode} mode`);
      const parsed = codeFromRedirectTo(redirectTo);
      assert.equal(parsed.state, state, 'the redirectTo must echo the state');
      assert.ok(parsed.code, 'the redirectTo must carry an authorization code');
      return { verifier, challenge, state, code: parsed.code as string, redirectTo: redirectTo as string };
    }

    async function exchangeCode(params: {
      code: string;
      verifier: string;
    }): Promise<HttpReading> {
      return httpCall(ctx.port, {
        method: 'POST',
        path: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formEncode({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId as string,
          code_verifier: params.verifier,
        }),
      });
    }

    // (a) mode 1: a read-only grant needs no password — the session alone
    // authorizes it — and the chain still ends in a token pair.
    const grantA = await obtainCode('read-only');
    const tokenA = await exchangeCode({ code: grantA.code, verifier: grantA.verifier });
    console.log(`[a] POST /oauth/token (authorization_code) -> ${tokenA.status} ${tokenA.text}`);
    assert.equal(tokenA.status, 200, 'the code exchange must succeed');
    assert.equal(tokenA.json?.token_type, 'Bearer', 'the token response must be a Bearer token');
    assert.equal(typeof tokenA.json?.access_token, 'string', 'an access token must be issued');
    assert.equal(typeof tokenA.json?.refresh_token, 'string', 'a refresh token must be issued');
    assert.equal(typeof tokenA.json?.expires_in, 'number', 'expires_in must be present');
    const accessA = tokenA.json?.access_token as string;
    const refreshA = tokenA.json?.refresh_token as string;

    // ---- (AC4 / (b)) /mcp read calls with the access token -------------------
    const list = await mcpCall(ctx.port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, accessA);
    const listResult = rpcResult(list);
    const tools = (listResult?.tools as { name?: string }[] | undefined) ?? [];
    console.log(`[b] POST /mcp tools/list -> ${list.status}; tools=${JSON.stringify(tools.map((tool) => tool.name))}`);
    assert.equal(list.status, 200, 'an OAuth access token must be admitted to /mcp');
    assert.ok(tools.length > 0, 'the tool list must be non-empty');
    assert.ok(tools.some((tool) => tool.name === 'overview'), 'the overview tool must be registered');

    const overview = await mcpCall(
      ctx.port,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'overview', arguments: {} } },
      accessA
    );
    const overviewResult = rpcResult(overview);
    const overviewContent = (overviewResult?.content as { type?: string; text?: string }[] | undefined) ?? [];
    const overviewPayload = JSON.parse(overviewContent.map((block) => block.text ?? '').join('') || '{}') as Record<string, unknown>;
    console.log(`[b] POST /mcp tools/call overview -> ${overview.status}; payload=${JSON.stringify(overviewPayload)}`);
    assert.equal(overview.status, 200, 'overview must answer 200');
    assert.equal(overviewResult?.isError, undefined, 'overview must not error');
    for (const key of ['running', 'awaitingPermission', 'aborted', 'hosts', 'quay']) {
      assert.ok(Array.isArray(overviewPayload[key]), `overview must carry the ${key} array`);
    }

    // ---- (AC6 / (d)) the SAME token: 200 before, 401 after a settings revoke --
    const beforeRevoke = await mcpCall(ctx.port, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, accessA);
    console.log(`[d] POST /mcp (before revoke) -> ${beforeRevoke.status}`);
    assert.equal(beforeRevoke.status, 200, 'the token must be live before the revoke');

    const grants = await httpCall(ctx.port, {
      method: 'GET',
      path: '/api/settings/oauth-grants',
      headers: { authorization: `Bearer ${ctx.jwt}` },
    });
    console.log(`[d] GET /api/settings/oauth-grants -> ${grants.status} ${grants.text}`);
    assert.equal(grants.status, 200, 'the settings grant list must answer 200');
    const grantRows = (grants.json?.grants as { id?: number; clientId?: string }[] | undefined) ?? [];
    const grantAId = grantRows.find((row) => row.clientId === clientId)?.id;
    assert.equal(typeof grantAId, 'number', 'the settings list must carry the grant A row');

    const revoke = await httpCall(ctx.port, {
      method: 'DELETE',
      path: `/api/settings/oauth-grants/${grantAId}`,
      headers: { authorization: `Bearer ${ctx.jwt}` },
    });
    console.log(`[d] DELETE /api/settings/oauth-grants/${grantAId} -> ${revoke.status} ${revoke.text}`);
    assert.equal(revoke.status, 200, 'revoking the grant must answer 200');
    assert.equal(revoke.json?.revoked, true, 'the grant must be reported revoked');

    const afterRevoke = await mcpCall(ctx.port, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, accessA);
    console.log(`[d] POST /mcp (after revoke, SAME token) -> ${afterRevoke.status} ${afterRevoke.text}`);
    assert.equal(afterRevoke.status, 401, 'the revoked token must be refused on the next /mcp call');

    // ---- (AC5 / (c)) refresh rotation, and the OLD refresh token refused ------
    const grantB = await obtainCode();
    const tokenB = await exchangeCode({ code: grantB.code, verifier: grantB.verifier });
    assert.equal(tokenB.status, 200, 'grant B exchange must succeed');
    const refreshB = tokenB.json?.refresh_token as string;
    const accessB = tokenB.json?.access_token as string;

    async function refreshCall(token: string): Promise<HttpReading> {
      return httpCall(ctx.port, {
        method: 'POST',
        path: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formEncode({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId as string }),
      });
    }

    const rotated = await refreshCall(refreshB);
    console.log(`[c] POST /oauth/token (refresh_token) -> ${rotated.status} ${rotated.text}`);
    assert.equal(rotated.status, 200, 'the refresh must succeed');
    const accessB2 = rotated.json?.access_token as string;
    const refreshB2 = rotated.json?.refresh_token as string;
    assert.notEqual(accessB2, accessB, 'the refresh must mint a new access token');
    assert.notEqual(refreshB2, refreshB, 'the refresh must rotate the refresh token');

    const replayRefresh = await refreshCall(refreshB);
    console.log(`[c] POST /oauth/token (OLD refresh_token) -> ${replayRefresh.status} ${replayRefresh.text}`);
    assert.equal(replayRefresh.status, 400, 'the rotated-out refresh token must be refused');
    assert.equal(replayRefresh.json?.error, 'invalid_grant', 'the refusal must be invalid_grant');

    const afterRefreshReplay = await mcpCall(ctx.port, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, accessB2);
    console.log(`[c] POST /mcp (post-reuse access token) -> ${afterRefreshReplay.status}`);
    assert.equal(afterRefreshReplay.status, 401, 'reusing a rotated refresh token must revoke the whole grant');

    // ---- (AC7 / (e)) the three counterexamples -------------------------------
    // (e1) no bearer JWT: the consent JSON API refuses both routes, and the
    // decision hands back no `redirectTo`.
    const noJwtQuery = new URLSearchParams({
      client_id: clientId as string,
      redirect_uri: REDIRECT_URI,
      state: 'no-jwt',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
    });
    const contextNoJwt = await httpCall(ctx.port, {
      method: 'GET',
      path: `/api/oauth/authorize/context?${noJwtQuery.toString()}`,
    });
    console.log(`[e1] GET /api/oauth/authorize/context (no JWT) -> ${contextNoJwt.status} ${contextNoJwt.text}`);
    assert.equal(contextNoJwt.status, 401, 'the context API must refuse a request with no bearer JWT');

    const decisionNoJwt = await httpCall(ctx.port, {
      method: 'POST',
      path: '/api/oauth/authorize/decision',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId as string,
        redirect_uri: REDIRECT_URI,
        state: 'no-jwt',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        scopes: [READ_SCOPE],
        action: 'allow',
      }),
    });
    console.log(`[e1] POST /api/oauth/authorize/decision (no JWT) -> ${decisionNoJwt.status} ${decisionNoJwt.text}`);
    assert.equal(decisionNoJwt.status, 401, 'the decision API must refuse a request with no bearer JWT');
    assert.equal(redirectToOf(decisionNoJwt), undefined, 'an unauthenticated decision must not hand back a redirectTo');

    // (e4, AC-261 narrowed) the right session but the WRONG confirmation password
    // for a WRITE grant: the real server re-verifies against the seeded bcrypt
    // hash, refuses, and mints no code — so holding a session JWT is not by itself
    // enough to authorize a state-changing client.
    const decisionWrongPassword = await httpCall(ctx.port, {
      method: 'POST',
      path: '/api/oauth/authorize/decision',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.jwt}` },
      body: JSON.stringify({
        client_id: clientId as string,
        redirect_uri: REDIRECT_URI,
        state: 'wrong-password',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        scopes: [READ_SCOPE, WRITE_SCOPE],
        action: 'allow',
        password: `${ACCOUNT_PASSWORD}-wrong`,
      }),
    });
    console.log(
      `[e4] POST /api/oauth/authorize/decision (write grant, wrong confirmation password) -> `
      + `${decisionWrongPassword.status} ${decisionWrongPassword.text}`
    );
    assert.equal(decisionWrongPassword.status, 401, 'a wrong confirmation password must be refused');
    assert.equal(
      decisionWrongPassword.json?.error,
      'invalid_credentials',
      'the refusal must name the credential check, not the session gate'
    );
    assert.equal(
      redirectToOf(decisionWrongPassword),
      undefined,
      'a refused confirmation must not hand back a redirectTo'
    );

    // (e5) the same write grant with NO password at all: an absent confirmation is
    // a failed confirmation, not a bypass — 401 and no code.
    const decisionNoPassword = await httpCall(ctx.port, {
      method: 'POST',
      path: '/api/oauth/authorize/decision',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.jwt}` },
      body: JSON.stringify({
        client_id: clientId as string,
        redirect_uri: REDIRECT_URI,
        state: 'no-password',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        scopes: [READ_SCOPE, WRITE_SCOPE],
        action: 'allow',
      }),
    });
    console.log(
      `[e5] POST /api/oauth/authorize/decision (write grant, no password) -> `
      + `${decisionNoPassword.status} ${decisionNoPassword.text}`
    );
    assert.equal(decisionNoPassword.status, 401, 'a write grant with no password must be refused');
    assert.equal(decisionNoPassword.json?.error, 'invalid_credentials', 'the refusal must be the credential check');
    assert.equal(redirectToOf(decisionNoPassword), undefined, 'a refused confirmation must not hand back a redirectTo');

    // (e2) wrong code_verifier: no token. Mode 2 of the chain: a WRITE grant with
    // the correct confirmation password must be admitted (and resets the source's
    // failure budget spent by (e4)/(e5)).
    const grantC = await obtainCode('write');
    const wrongVerifier = await exchangeCode({ code: grantC.code, verifier: `${grantC.verifier}-wrong` });
    console.log(`[e2] POST /oauth/token (wrong code_verifier) -> ${wrongVerifier.status} ${wrongVerifier.text}`);
    assert.equal(wrongVerifier.status, 400, 'a wrong code_verifier must be refused');
    assert.equal(wrongVerifier.json?.error, 'invalid_grant', 'the refusal must be invalid_grant');

    // (e3) code replay: the same code, after a successful exchange, is refused.
    const goodExchange = await exchangeCode({ code: grantC.code, verifier: grantC.verifier });
    console.log(`[e3] POST /oauth/token (correct verifier) -> ${goodExchange.status}`);
    assert.equal(goodExchange.status, 200, 'the code must exchange once');
    const replayedCode = await exchangeCode({ code: grantC.code, verifier: grantC.verifier });
    console.log(`[e3] POST /oauth/token (replayed code) -> ${replayedCode.status} ${replayedCode.text}`);
    assert.equal(replayedCode.status, 400, 'a replayed code must be refused');
    assert.equal(replayedCode.json?.error, 'invalid_grant', 'the refusal must be invalid_grant');

    // ---- (R) /oauth/revoke genuinely revokes --------------------------------
    const grantD = await obtainCode();
    const tokenD = await exchangeCode({ code: grantD.code, verifier: grantD.verifier });
    assert.equal(tokenD.status, 200, 'grant D exchange must succeed');
    const accessD = tokenD.json?.access_token as string;

    const revokeCall = await httpCall(ctx.port, {
      method: 'POST',
      path: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode({ token: accessD, client_id: clientId as string }),
    });
    console.log(`[R] POST /oauth/revoke -> ${revokeCall.status} ${revokeCall.contentType} ${revokeCall.text}`);
    assert.equal(revokeCall.status, 200, '/oauth/revoke must answer 200');
    assert.ok((revokeCall.contentType ?? '').includes('application/json'), '/oauth/revoke must be JSON, not the SPA');
    const afterOauthRevoke = await mcpCall(ctx.port, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, accessD);
    console.log(`[R] POST /mcp (after /oauth/revoke) -> ${afterOauthRevoke.status}`);
    assert.equal(afterOauthRevoke.status, 401, 'the revoked token must be refused on the next /mcp call');
  });
});
