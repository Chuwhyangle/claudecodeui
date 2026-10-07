/**
 * Criterion: the SPA OAuth consent contract, server half
 * (gap-oauth-consent-spa-backend-contract).
 *
 * Drives the PRODUCTION mount (`mountOAuthServer` + the SPA document-headers
 * middleware + the real static layer) over real HTTP (`app.listen(0)` + `fetch`),
 * backed by a real better-sqlite3 database built on a temp `DATABASE_PATH`
 * through the production migration path, the real `createOAuthStore` /
 * `createOAuthProvider`, and the real AC-258 client repository. The ONE injected
 * seam is the bearer-JWT middleware: the harness mounts the same `authenticateToken`
 * contract `server/index.ts` passes in — admit exactly one minted token (setting
 * `req.user`), 401 otherwise — so code issuance can be asserted as a function of
 * the session gate without a real login.
 *
 * Legs, mapped onto the AC. The AC-260 legs that described the server-rendered
 * form are RETIRED IN PLACE, with the reason each lost its subject:
 *
 *   (a) GET /oauth/authorize (valid) 302s to the RELATIVE SPA route with the
 *       original query preserved item-by-item (AC2).
 *   (b) GET context returns the client name as JSON DATA — verbatim, even when it
 *       contains HTML — plus the correct callback host (AC4). [was the AC-260 (a)
 *       HTML-escaping leg: the server renders no HTML any more, so escaping has no
 *       subject; the honest translation is that the value is structured data.]
 *   (c) GET context returns the whole scope vocabulary, `cloudcli:read` flagged
 *       `required:true`/`writable:false`, the rest `required:false`/`writable:true`,
 *       and never `cloudcli:admin` (AC4; old (b)/(m)'s intent).
 *   (d) decision deny → `redirectTo` carries `error=access_denied` and the verbatim
 *       state, no code, no new code row (AC6; old (d)).
 *   (e) decision allow → `redirectTo` carries a non-empty code and the verbatim
 *       state, and the grant row's scopes are exactly the submitted set ∪
 *       `cloudcli:read`, once each (AC5; old (c)/(e)).
 *   (f) an unregistered `redirect_uri` is refused at GET /oauth/authorize (400
 *       error page, NO Location), at context (400 JSON) and at decision for BOTH
 *       allow and deny (400, no `redirectTo`, no code row) — the deny branch is
 *       not an open redirector (AC3/AC6; old (j)).
 *   (g) the JSON API's headers: `X-Frame-Options: DENY`, CSP `frame-ancestors
 *       'none'`, `Cache-Control: no-store` on the context and decision responses
 *       (AC8; old (g)).
 *   (h) the SPA DOCUMENT at `/oauth/consent` carries the same three headers when
 *       served through the real static layer — the layer sets its own
 *       `Cache-Control` for `index.html`, so this is what proves the document-header
 *       middleware wins (AC8).
 *   (i) the SPA document's CSP has NO `form-action` and NO `default-src 'none'`
 *       (the shell's bundle must load), while the HTML error page keeps the
 *       `default-src 'none'` posture (AC8; old (i)'s intent).
 *   (j) a missing/disabled client and a non-`code` `response_type` are refused with
 *       the 400 error page and no Location (AC3).
 *   (k) context and decision without a JWT are 401 and no code row appears (AC7).
 *   (l) in a REAL browser, GET /oauth/authorize follows the 302 onto the SPA route,
 *       the SPA's decision round-trip ends in a `window.location` hop that survives
 *       a TWO-hop callback chain to a third origin with code and verbatim state —
 *       with a `default-src 'none'` control that cannot run the SPA script and so
 *       never reaches the end (proving the consent document must not carry the
 *       error page's CSP). [old (l), re-based on the new hand-off.]
 *   (m) a forged scope outside the vocabulary cannot reach the grant (AC5; old (n)).
 *   (n) GET context carries the client's registration provenance (`clientCreatedAt`
 *       / `clientCreatedVia`) and the provider's OWN access-token lifetime — a
 *       NON-default value, so a hardcoded 3600 in the screen would read wrong (AC5,
 *       gap-oauth-consent-flow-ux-hardening).
 *   (o) a read-only allow with NO password and NO injected verifier is admitted and
 *       mints a code — the session-only behavior AC-260 pinned, kept for a grant
 *       that stays within the read scope (AC6).
 *   (p) a deny that carries a write scope and no password is still admitted as
 *       `error=access_denied`: a denial grants nothing (AC6).
 *
 * RETIRED WITHOUT TRANSLATION (subject deleted by this task):
 *   · AC-260 (c) password re-entry — the page no longer has a password field;
 *     the session gate in (k) is the replacement and has its own leg.
 *   · AC-260 (f) CSRF ledger — the ledger is gone; the JWT-in-a-header API is
 *     not form-submittable cross-site, which is the property the ledger bought.
 *   · AC-260 (h) `createCredentialVerifier` mapping — the consent router no longer
 *     consumes the credential verifier, so its mapping is no longer this module's
 *     subject.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { chromium } from 'playwright';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  oauthClientsDb,
} from '@/modules/database/index.js';
import {
  createOAuthConsentDocumentHeadersMiddleware,
  createOAuthProvider,
  createOAuthStore,
  mountOAuthServer,
} from '@/modules/oauth/index.js';
import type { OAuthStore } from '@/modules/oauth/index.js';
import { createStaticAssetsMiddleware } from '@/modules/static-assets/index.js';

import { OAUTH_CONSENT_SPA_PATH } from '../../../../shared/oauthConsent.js';

const PUBLIC_BASE_URL = 'https://cli.example';
const REDIRECT_URI = 'https://app.example/cb';
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const READ_SCOPE = 'cloudcli:read';
const WRITE_SCOPE = 'cloudcli:session:send';
const CREATE_SCOPE = 'cloudcli:session:create';
const CONTROL_SCOPE = 'cloudcli:session:control';
const NAVIGATE_SCOPE = 'cloudcli:navigate';
const APPROVE_SCOPE = 'cloudcli:approve';
const VOCABULARY = [READ_SCOPE, WRITE_SCOPE, CREATE_SCOPE, CONTROL_SCOPE, APPROVE_SCOPE, NAVIGATE_SCOPE];
const USER_ID = 1;
const OWNER = 'owner';
/**
 * The access-token lifetime this harness gives its provider. Deliberately NOT the
 * service default (3600) so leg (n) can prove the screen's token-lifetime line
 * reads the provider's value through the context endpoint rather than a hardcoded
 * copy of it.
 */
const NON_DEFAULT_TTL_SECONDS = 1234;

/** A fresh PKCE pair: a random verifier and its S256 (base64url) challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

type Harness = {
  /** Base URL of the mounted app (the SPA routes live under `/oauth`, the JSON API under `/api/oauth/authorize`). */
  baseUrl: string;
  /** The store behind the provider, for registering clients. */
  store: OAuthStore;
  /** Registers a public client with the given callback and returns its id. */
  registerClient: (clientName: string, redirectUri?: string) => string;
  /** The one bearer token the injected middleware admits. */
  jwt: string;
  /** Dist directory the static layer serves the SPA document from. */
  distDir: string;
};

/**
 * Runs `run` against a fresh temp database, real provider/store, the production
 * mount, the SPA document-header middleware and the real static layer over a
 * temp `dist/` that holds an `index.html`.
 */
async function withConsentServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-consent-'));
  const databasePath = path.join(tempDirectory, 'oauth-consent.db');
  const distDir = path.join(tempDirectory, 'dist');
  const publicDir = path.join(tempDirectory, 'public');
  await mkdir(distDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // `oauth_grants.user_id` references `users(id)`; the owner row has to exist.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, OWNER, 'placeholder-hash');

  // One fixed clock for both layers, mirroring the production wiring (provider
  // and store must agree on "now").
  const now = (): Date => new Date(START_MS);
  const store = createOAuthStore({ now });
  const provider = createOAuthProvider({
    store,
    now,
    publicBaseUrl: PUBLIC_BASE_URL,
    accessTokenTtlSeconds: NON_DEFAULT_TTL_SECONDS,
  });

  const jwt = `consent-test-jwt-${crypto.randomUUID()}`;
  // The injected seam, shaped exactly like the production `authenticateToken`:
  // admit the one minted token and attach `req.user`, 401 for everything else.
  const authenticateToken: RequestHandler = (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${jwt}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as express.Request & { user?: { id: number } }).user = { id: USER_ID };
    next();
  };

  const registerClient = (clientName: string, redirectUri: string = REDIRECT_URI): string =>
    store.registerClient({
      clientName,
      redirectUris: [redirectUri],
      metadata: {},
      createdVia: 'manual',
      publicClient: true,
    }).clientId;

  const app = express();
  // The entrypoint's order: API routes, then the SPA document headers, then the
  // static layer whose catch-all serves `index.html`.
  mountOAuthServer(app, { provider, store, clients: oauthClientsDb, authenticateToken });
  app.use(OAUTH_CONSENT_SPA_PATH, createOAuthConsentDocumentHeadersMiddleware());
  app.use(
    createStaticAssetsMiddleware({
      distDir,
      publicDir,
      onMissingIndex: (_req, res) => res.status(404).send('no index'),
    })
  );

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
      registerClient,
      jwt,
      distDir,
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

/** The number of rows in the authorization-code table right now. */
function codeCount(): number {
  const row = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM oauth_authorization_codes')
    .get() as { n: number };
  return row.n;
}

/** The most recent grant row's scope array, as stored. */
function latestGrantScopes(): string[] {
  const row = getConnection()
    .prepare('SELECT scopes FROM oauth_grants ORDER BY id DESC LIMIT 1')
    .get() as { scopes: string };
  return JSON.parse(row.scopes) as string[];
}

/** Builds the `/oauth/authorize` query string a client would send. */
function authorizeQuery(
  clientId: string,
  challenge: string,
  scopes: string[] = [READ_SCOPE],
  state = 'xyz',
  redirectUri: string = REDIRECT_URI
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (scopes.length > 0) {
    params.set('scope', scopes.join(' '));
  }
  return params.toString();
}

type JsonResponse = { status: number; body: unknown; headers: Headers };

/** GETs the consent context through the JWT-authenticated JSON API. */
async function getContext(
  harness: Harness,
  clientId: string,
  opts: { challenge?: string; state?: string; redirectUri?: string; jwt?: string | null } = {}
): Promise<JsonResponse> {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri ?? REDIRECT_URI,
    state: opts.state ?? 'xyz',
    code_challenge: opts.challenge ?? pkcePair().challenge,
    code_challenge_method: 'S256',
  });
  const headers: Record<string, string> = {};
  if (opts.jwt !== null) {
    headers.authorization = `Bearer ${opts.jwt ?? harness.jwt}`;
  }
  const response = await fetch(`${harness.baseUrl}/api/oauth/authorize/context?${params}`, { headers });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}

type DecisionResponse = { status: number; body: { redirectTo?: string } | null; headers: Headers };

/** POSTs a decision through the JWT-authenticated JSON API. */
async function postDecision(
  harness: Harness,
  fields: Record<string, unknown>,
  jwt: string | null = harness.jwt
): Promise<DecisionResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (jwt !== null) {
    headers.authorization = `Bearer ${jwt}`;
  }
  const response = await fetch(`${harness.baseUrl}/api/oauth/authorize/decision`, {
    method: 'POST',
    headers,
    body: JSON.stringify(fields),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as { redirectTo?: string } | null, headers: response.headers };
}

test('(a) GET /oauth/authorize 302s to the relative SPA route, query preserved item-by-item', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const query = authorizeQuery(clientId, pair.challenge, [READ_SCOPE, WRITE_SCOPE], 'state-abc');
    const response = await fetch(`${harness.baseUrl}/oauth/authorize?${query}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = response.headers.get('location') ?? '';
    // Same-origin and relative: no scheme, no host, and it starts at the SPA path.
    assert.ok(location.startsWith(`${OAUTH_CONSENT_SPA_PATH}?`), `location must be the relative SPA route: ${location}`);
    assert.ok(!/^https?:/i.test(location), `location must not be absolute: ${location}`);
    const landed = new URL(location, 'http://placeholder');
    for (const [key, value] of new URLSearchParams(query)) {
      assert.equal(landed.searchParams.get(key), value, `the original ${key} must survive the redirect`);
    }
    console.log(`(a) 302 location=${location}`);
  });
});

test('(b) GET context returns the client name as JSON data (verbatim) and the right callback host', async () => {
  await withConsentServer(async (harness) => {
    const scriptName = '<script>alert(1)</script>';
    const clientId = harness.registerClient(scriptName);
    const reading = await getContext(harness, clientId, { state: 'state-xyz' });
    assert.equal(reading.status, 200);
    assert.match(reading.headers.get('content-type') ?? '', /application\/json/);
    const body = reading.body as { clientName: string; callbackHost: string; redirectUri: string; state: string };
    // Structured data, not an HTML interpolation: the name arrives exactly as stored.
    assert.equal(body.clientName, scriptName);
    assert.equal(body.callbackHost, 'app.example');
    assert.equal(body.redirectUri, REDIRECT_URI);
    assert.equal(body.state, 'state-xyz');
    console.log(`(b) clientName=${JSON.stringify(body.clientName)} callbackHost=${body.callbackHost} state=${body.state}`);
  });
});

test('(c) GET context returns the whole vocabulary with cloudcli:read required and non-writable', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const reading = await getContext(harness, clientId);
    assert.equal(reading.status, 200);
    const scopes = (reading.body as { scopes: Array<{ scope: string; description: string; required: boolean; writable: boolean; group: string; risk: string | null }> }).scopes;
    assert.deepEqual(scopes.map((entry) => entry.scope), VOCABULARY, 'the whole vocabulary, in order');
    for (const entry of scopes) {
      assert.ok(entry.description.length > 0, `${entry.scope} must carry an English description`);
      if (entry.scope === READ_SCOPE) {
        assert.equal(entry.required, true, 'the read-only scope is pinned');
        assert.equal(entry.writable, false, 'the read-only scope is not removable');
      } else {
        assert.equal(entry.required, false, `${entry.scope} is optional`);
        assert.equal(entry.writable, true, `${entry.scope} is selectable`);
      }
    }
    assert.ok(!scopes.some((entry) => entry.scope === 'cloudcli:admin'), 'the reserved scope is never offered');

    // gap-oauth-consent-flow-ux-hardening: each option now names its screen group
    // and, for a state-changing scope, a risk code the badge renders from. The
    // existing assertions above are untouched; these are additive.
    for (const entry of scopes) {
      if (entry.scope === READ_SCOPE) {
        assert.equal(entry.group, 'read', 'the pinned scope is filed under the read group');
        assert.equal(entry.risk, null, 'a read scope carries no risk badge');
      } else {
        assert.equal(entry.group, 'write', `${entry.scope} is filed under the state-changing group`);
        assert.ok(
          typeof entry.risk === 'string' && entry.risk.length > 0,
          `${entry.scope} must carry a non-empty risk code for its badge`
        );
      }
    }
    console.log(`(c) scopes=${scopes.map((entry) => `${entry.scope}(required=${entry.required},writable=${entry.writable},group=${entry.group},risk=${entry.risk})`).join(' ')}`);
  });
});

test('(d) decision deny returns error=access_denied with the verbatim state and no code', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const before = codeCount();
    const denied = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'state-deny-1',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scopes: [READ_SCOPE],
      action: 'deny',
    });
    assert.equal(denied.status, 200);
    const redirectTo = denied.body?.redirectTo ?? '';
    const url = new URL(redirectTo);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('code'), null, 'a denial must carry no code');
    assert.equal(url.searchParams.get('state'), 'state-deny-1', 'the state must be echoed verbatim');
    assert.equal(codeCount(), before, 'a denial must not create a code');
    console.log(`(d) redirectTo=${redirectTo} codes ${before}->${codeCount()}`);
  });
});

test('(e) decision allow returns a code and stores the submitted set plus cloudcli:read', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const before = codeCount();
    const allowed = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'state-allow-1',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      // The read-only box is pinned on the client, so it is not submitted; the
      // control scope was left unchecked.
      scopes: [WRITE_SCOPE],
      action: 'allow',
    });
    assert.equal(allowed.status, 200);
    const url = new URL(allowed.body?.redirectTo ?? '');
    assert.ok(url.origin + url.pathname === REDIRECT_URI, `redirectTo must target the callback: ${allowed.body?.redirectTo}`);
    const code = url.searchParams.get('code');
    assert.ok(code !== null && code.length > 0, 'an allow must carry a non-empty code');
    assert.equal(url.searchParams.get('state'), 'state-allow-1', 'the state must be echoed verbatim');
    assert.equal(codeCount(), before + 1, 'the allow must create exactly one code');
    assert.deepEqual(
      [...latestGrantScopes()].sort(),
      [READ_SCOPE, WRITE_SCOPE].sort(),
      'the grant carries the submitted set plus the forced read-only scope'
    );
    console.log(`(e) redirectTo=${allowed.body?.redirectTo} grant.scopes=${JSON.stringify(latestGrantScopes())} codes ${before}->${codeCount()}`);
  });
});

test('(f) an unregistered redirect_uri is refused at authorize, context and decision (allow and deny)', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const evil = 'https://evil.example/steal';

    // GET /oauth/authorize: an error page and NO Location header.
    const getResponse = await fetch(
      `${harness.baseUrl}/oauth/authorize?${authorizeQuery(clientId, pkcePair().challenge, [READ_SCOPE], 'xyz', evil)}`,
      { redirect: 'manual' }
    );
    const getBody = await getResponse.text();
    assert.equal(getResponse.status, 400);
    assert.equal(getResponse.headers.get('location'), null, 'an unregistered callback must never be redirected to');
    assert.ok(getBody.includes('Authorization error'), 'the refusal is the rendered error page');
    assert.ok(!getBody.includes('evil.example'), 'the unregistered host must not be echoed');

    // GET context: 400 JSON.
    const context = await getContext(harness, clientId, { redirectUri: evil });
    assert.equal(context.status, 400);
    assert.equal((context.body as { error?: string }).error, 'invalid_request');

    // POST decision, both branches: 400, no redirectTo, no code row.
    const before = codeCount();
    for (const action of ['allow', 'deny'] as const) {
      const response = await postDecision(harness, {
        client_id: clientId,
        redirect_uri: evil,
        state: 'xyz',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        scopes: [READ_SCOPE],
        action,
      });
      assert.equal(response.status, 400, `decision ${action} to an unregistered callback must be refused`);
      assert.equal(response.body?.redirectTo, undefined, `decision ${action} must not hand back a redirectTo`);
    }
    assert.equal(codeCount(), before, 'no authorization code may be issued');
    console.log(`(f) GET=${getResponse.status} (no location) context=${context.status} decision allow/deny=400; codes ${before}->${codeCount()}`);
  });
});

test('(g) the JSON API carries the anti-framing and no-store headers', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const context = await getContext(harness, clientId);
    for (const [label, headers] of [['context 200', context.headers]] as const) {
      assert.equal(headers.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
      assert.ok((headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), `${label}: CSP`);
      assert.equal(headers.get('cache-control'), 'no-store', `${label}: Cache-Control`);
    }
    const decision = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scopes: [READ_SCOPE],
      action: 'deny',
    });
    assert.equal(decision.headers.get('x-frame-options'), 'DENY');
    assert.ok((decision.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"));
    assert.equal(decision.headers.get('cache-control'), 'no-store');
    const refused = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: 'https://evil.example/x',
      state: 'xyz',
      action: 'allow',
    });
    assert.equal(refused.headers.get('x-frame-options'), 'DENY', 'the 400 JSON path carries the headers too');
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    console.log(
      `(g) context x-frame-options=${context.headers.get('x-frame-options')} csp="${context.headers.get('content-security-policy')}" cache-control=${context.headers.get('cache-control')}; `
      + `decision 200/400 the same`
    );
  });
});

test('(h) the SPA document at /oauth/consent carries the three headers over the static layer', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const query = authorizeQuery(clientId, pkcePair().challenge, [READ_SCOPE], 'state-doc');
    const response = await fetch(`${harness.baseUrl}${OAUTH_CONSENT_SPA_PATH}?${query}`);
    assert.equal(response.status, 200, 'the SPA document is served from dist/index.html');
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const frame = response.headers.get('x-frame-options');
    const csp = response.headers.get('content-security-policy');
    const cache = response.headers.get('cache-control');
    assert.equal(frame, 'DENY');
    assert.ok((csp ?? '').includes("frame-ancestors 'none'"), `CSP: ${csp}`);
    // The static layer sets `no-cache, no-store, must-revalidate` for index.html;
    // the document-header middleware must have re-asserted `no-store` at writeHead.
    assert.ok((cache ?? '').includes('no-store'), `Cache-Control must survive the static layer: ${cache}`);
    console.log(`(h) ${OAUTH_CONSENT_SPA_PATH} x-frame-options=${frame} csp="${csp}" cache-control="${cache}"`);
  });
});

test('(i) the SPA document CSP keeps no form-action and no default-deny; the error page keeps default-deny', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const document = await fetch(`${harness.baseUrl}${OAUTH_CONSENT_SPA_PATH}?${authorizeQuery(clientId, pkcePair().challenge)}`);
    const docCsp = document.headers.get('content-security-policy') ?? '';
    assert.ok(!/form-action/i.test(docCsp), `form-action has no subject under window.location and must not appear: ${docCsp}`);
    assert.ok(!docCsp.includes("default-src 'none'"), `the shell's bundle must be able to load: ${docCsp}`);
    assert.ok(docCsp.includes("frame-ancestors 'none'"), `anti-framing must stay: ${docCsp}`);

    const errorPage = await fetch(`${harness.baseUrl}/oauth/authorize?client_id=${clientId}`, { redirect: 'manual' });
    assert.equal(errorPage.status, 400);
    const errorCsp = errorPage.headers.get('content-security-policy') ?? '';
    assert.ok(errorCsp.includes("default-src 'none'"), `the error page keeps the default-deny posture: ${errorCsp}`);
    console.log(`(i) document csp="${docCsp}" error-page csp="${errorCsp}"`);
  });
});

test('(j) a missing/disabled client or a non-code response_type gets the error page and no Location', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();

    const missing = await fetch(`${harness.baseUrl}/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`, { redirect: 'manual' });
    assert.equal(missing.status, 400);
    assert.equal(missing.headers.get('location'), null);
    assert.ok((await missing.text()).includes('Authorization error'));

    const unknown = await fetch(`${harness.baseUrl}/oauth/authorize?${authorizeQuery('0'.repeat(32), pair.challenge)}`, { redirect: 'manual' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get('location'), null);

    const badType = await fetch(
      `${harness.baseUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&code_challenge=${pair.challenge}&code_challenge_method=S256`,
      { redirect: 'manual' }
    );
    assert.equal(badType.status, 400);
    assert.equal(badType.headers.get('location'), null);
    assert.ok((await badType.text()).includes('Authorization error'));
    console.log(`(j) missing=${missing.status} unknown=${unknown.status} non-code=${badType.status} (all without Location)`);
  });
});

test('(k) context and decision without a JWT are 401 and create no code row', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const before = codeCount();

    const context = await getContext(harness, clientId, { jwt: null });
    assert.equal(context.status, 401, 'context without a bearer JWT must be refused');

    const decision = await postDecision(
      harness,
      {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        state: 'xyz',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        scopes: [READ_SCOPE],
        action: 'allow',
      },
      null
    );
    assert.equal(decision.status, 401, 'decision without a bearer JWT must be refused');
    assert.equal(decision.body?.redirectTo, undefined);
    assert.equal(codeCount(), before, 'an unauthenticated decision must not create a code');
    console.log(`(k) context=${context.status} decision=${decision.status}; oauth_authorization_codes rows ${before}->${codeCount()}`);
  });
});

test('(m) a forged scope outside the vocabulary never reaches the grant', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const allowed = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scopes: ['cloudcli:admin', 'bogus', CREATE_SCOPE, CREATE_SCOPE, NAVIGATE_SCOPE],
      action: 'allow',
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(
      [...latestGrantScopes()].sort(),
      [READ_SCOPE, CREATE_SCOPE, NAVIGATE_SCOPE].sort(),
      'only vocabulary scopes survive, once each, plus the forced read-only scope'
    );
    console.log(`(m) forged scopes dropped; grant.scopes=${JSON.stringify(latestGrantScopes())}`);
  });
});

test('(n) GET context carries the registration provenance and the provider\'s own token lifetime', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const reading = await getContext(harness, clientId);
    assert.equal(reading.status, 200);
    const body = reading.body as {
      clientCreatedAt: string | null;
      clientCreatedVia: string | null;
      accessTokenTtlSeconds: number;
    };

    // The registration facts the screen shows as data. `registerClient` records
    // `manual`; the timestamp is the provider/store clock's own.
    assert.equal(body.clientCreatedVia, 'manual', 'the registration route must be reported');
    assert.ok(
      typeof body.clientCreatedAt === 'string' && !Number.isNaN(Date.parse(body.clientCreatedAt)),
      `the registration time must be a parseable timestamp: ${JSON.stringify(body.clientCreatedAt)}`
    );

    // The lifetime is the provider's OWN value, not the 3600 default and not a
    // literal in the transport: the harness built the provider at 1234.
    assert.equal(
      body.accessTokenTtlSeconds,
      NON_DEFAULT_TTL_SECONDS,
      'the context must report the provider constant, so a hardcoded TTL would read wrong'
    );
    console.log(
      `(n) clientCreatedAt=${body.clientCreatedAt} clientCreatedVia=${body.clientCreatedVia} `
      + `accessTokenTtlSeconds=${body.accessTokenTtlSeconds} (default is 3600)`
    );
  });
});

test('(o) a read-only allow with no password and no injected verifier mints a code', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const before = codeCount();
    // This harness injects NO `verifyCredentials`, so the session gate is the only
    // authority — the AC-260 behavior. A grant of nothing but the read scope stays
    // in that regime (there is no password to ask for and none is sent).
    const allowed = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'state-readonly',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scopes: [READ_SCOPE],
      action: 'allow',
      password: '',
    });
    assert.equal(allowed.status, 200);
    const url = new URL(allowed.body?.redirectTo ?? '');
    assert.ok((url.searchParams.get('code') ?? '').length > 0, 'a read-only allow must carry a code');
    assert.equal(url.searchParams.get('state'), 'state-readonly');
    assert.equal(codeCount(), before + 1, 'a read-only allow mints exactly one code');
    assert.deepEqual(latestGrantScopes(), [READ_SCOPE], 'the grant is exactly the read scope');
    console.log(`(o) read-only allow, no password -> ${allowed.status}; grant.scopes=${JSON.stringify(latestGrantScopes())}`);
  });
});

test('(p) a deny carrying a write scope and no password is still access_denied', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const before = codeCount();
    const denied = await postDecision(harness, {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'state-deny-write',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      scopes: [WRITE_SCOPE],
      action: 'deny',
      password: '',
    });
    assert.equal(denied.status, 200, 'a denial needs no password, even with a write scope');
    const url = new URL(denied.body?.redirectTo ?? '');
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('code'), null, 'a denial must carry no code');
    assert.equal(url.searchParams.get('state'), 'state-deny-write', 'the state must be echoed verbatim');
    assert.equal(codeCount(), before, 'a denial must not create a code');
    console.log(`(p) deny with write scope and no password -> ${denied.status} redirectTo=${denied.body?.redirectTo}`);
  });
});

test('(l) in a real browser the 302 lands on the SPA route and the window.location hop survives a two-hop chain', async () => {
  // Hop two's destination: a third origin, as Gemini's own page is for Google's callback.
  const finalServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>final destination</h1>');
  });
  finalServer.listen(0, '127.0.0.1');
  await once(finalServer, 'listening');
  const finalOrigin = `http://127.0.0.1:${(finalServer.address() as AddressInfo).port}`;

  // Hop one: the registered callback. Like Google's callback page it answers with ANOTHER redirect.
  const callbackServer = http.createServer((req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `${finalOrigin}/done${req.url?.includes('?') ? `?${req.url.split('?')[1]}` : ''}`);
    res.end();
  });
  callbackServer.listen(0, '127.0.0.1');
  await once(callbackServer, 'listening');
  const callbackOrigin = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}`;

  // The SPA stand-in: reads the query, round-trips the context API with a JWT in a
  // header, posts the decision, then performs the final navigation with
  // `window.location` — the hop the design moved out of the server.
  const spaDocument = (jwt: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>consent</title></head>
<body><div id="status">loading</div>
<script>
  const jwt = ${JSON.stringify(jwt)};
  (async () => {
    const q = new URLSearchParams(location.search);
    const headers = { authorization: 'Bearer ' + jwt };
    const ctx = await fetch('/api/oauth/authorize/context?' + q, { headers });
    if (!ctx.ok) { document.getElementById('status').textContent = 'context ' + ctx.status; return; }
    const decision = await fetch('/api/oauth/authorize/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
      body: JSON.stringify({
        client_id: q.get('client_id'), redirect_uri: q.get('redirect_uri'), state: q.get('state'),
        code_challenge: q.get('code_challenge'), code_challenge_method: 'S256',
        scopes: ['cloudcli:read'], action: 'allow',
      }),
    }).then((r) => r.json());
    window.location.href = decision.redirectTo;
  })().catch((error) => { document.getElementById('status').textContent = 'ERR ' + error; });
</script></body></html>`;

  // Control: the same SPA script served with the ERROR PAGE's `default-src 'none'`
  // CSP. The script cannot run, so the chain never starts — which is what proves
  // the consent document must not carry that posture.
  const controlServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.end(spaDocument('control-jwt'));
  });
  controlServer.listen(0, '127.0.0.1');
  await once(controlServer, 'listening');
  const controlUrl = `http://127.0.0.1:${(controlServer.address() as AddressInfo).port}/oauth/consent`;

  const browser = await chromium.launch();
  try {
    await withConsentServer(async (harness) => {
      // Replace the harness's placeholder document with the SPA stand-in, carrying
      // the harness's own minted JWT.
      await writeFile(path.join(harness.distDir, 'index.html'), spaDocument(harness.jwt));

      const callback = `${callbackOrigin}/cb`;
      const clientId = harness.registerClient('browser-app', callback);
      const pair = pkcePair();
      const query = authorizeQuery(clientId, pair.challenge, [READ_SCOPE], 'state-browser', callback);

      const page = await browser.newPage();
      await page.goto(`${harness.baseUrl}/oauth/authorize?${query}`);
      // The server 302 must have landed the browser on the SPA route.
      assert.ok(
        page.url().includes(`${OAUTH_CONSENT_SPA_PATH}?`),
        `the browser must land on the SPA route, not the server endpoint: ${page.url()}`
      );
      await page.waitForURL(`${finalOrigin}/done**`, { timeout: 10_000 });
      const landed = new URL(page.url());
      assert.equal(landed.origin, finalOrigin, 'the chain must end on the third origin');
      assert.ok((landed.searchParams.get('code') ?? '').length > 0, 'the code must survive both hops');
      assert.equal(landed.searchParams.get('state'), 'state-browser', 'the state must survive both hops verbatim');

      const controlPage = await browser.newPage();
      await controlPage.goto(controlUrl);
      await controlPage.waitForTimeout(1500);
      assert.ok(
        !controlPage.url().startsWith(finalOrigin),
        `control (default-src 'none'): the browser must NOT reach the end of the chain — otherwise this test cannot detect the defect`
      );

      console.log(
        `(l) real Chromium: authorize 302 -> ${OAUTH_CONSENT_SPA_PATH} -> window.location -> 2 hops -> ${landed.origin}${landed.pathname} `
        + `code=${(landed.searchParams.get('code') ?? '').length} chars state=${landed.searchParams.get('state')}; `
        + `control stopped on ${new URL(controlPage.url()).pathname}`
      );
    });
  } finally {
    await browser.close();
    for (const server of [finalServer, callbackServer, controlServer]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
