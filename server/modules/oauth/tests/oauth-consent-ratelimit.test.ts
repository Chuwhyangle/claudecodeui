/**
 * AC-261 criterion (restored on the SPA data plane by
 * gap-ac261-consent-password-ratelimit-restore): the consent page's password
 * submission is rate limited PER SOURCE — ten failures per fifteen minutes, and
 * the eleventh attempt is refused (429) even when its password is correct — and
 * the source is decided by `TRUST_PROXY`: with it, `CF-Connecting-IP` names the
 * client and two clients count independently; without it, forged
 * `CF-Connecting-IP`/`X-Forwarded-For` headers change nothing and every request
 * shares the socket peer's bucket.
 *
 * The criterion drives the PRODUCTION router factory
 * (`createOAuthAuthorizeApiRouter`) on a bare express app over real HTTP
 * (`app.listen(0)` + `fetch`). It is self-contained: a fake client lookup, a fake
 * provider whose `authorize` is a counter, and a fake credential verifier — no
 * database, no `server/index.ts`, no real JWT. The one mutable `nowMs` and the
 * injected `now` advance the limiter's fixed window without sleeping real time.
 *
 * Legs, one per reading:
 *   (a)+(b) one source: ten wrong-password POSTs are all refused but not 429;
 *       the ELEVENTH carries the correct password, is 429, and mints no code;
 *       after `nowMs += windowMs + 1` the same source succeeds with a code.
 *   (c) `trustProxy: true`: source A's eleventh attempt is 429 while source B's
 *       first attempt succeeds — the two buckets are independent.
 *   (d) no trusted proxy: ten failures spread across forged `CF-Connecting-IP`
 *       values (and one `X-Forwarded-For`-only) still share one bucket, so the
 *       eleventh attempt is 429 regardless of the correct password.
 *   (e) `trustProxy: true`: a success for A clears ONLY A — B keeps its five
 *       failures and is blocked on its eleventh, while A can fail ten more times
 *       before it is blocked again.
 *
 * gap-oauth-consent-flow-ux-hardening narrowed the password branch to a grant that
 * REACHES PAST `cloudcli:read`, derived from the service's `grantedScopes` (never
 * a client flag) and computed before the limiter is consulted. Legs (f)–(j) pin
 * that boundary — the AC's seven enforcement cases, all on this one harness
 * because it is the only one that injects a credential verifier:
 *   (f) a read-only decision with NO password is admitted and mints a code, and
 *       ten of them spend none of the source's budget (the eleven wrong-password
 *       write failures that follow are each an ordinary 401, not 429).
 *   (g) a write scope with NO password is 401 and COUNTS toward the budget.
 *   (h) a body that dresses a write scope up as read-only (an extra `readonly`
 *       flag, and the read scope present too) still lands the write scope in the
 *       grant and is 401 without a valid password — the flag is not consulted.
 *   (i) an out-of-vocabulary scope is dropped BEFORE the decision, so a body of
 *       junk plus the read scope is a read-only grant and needs no password.
 *   (j) deny never needs a password, even with a write scope, and never spends a
 *       source's budget.
 *
 * Legs (a)–(e) POST a state-changing scope (`cloudcli:session:send`) so they
 * exercise the password branch this file is about; a read-only body would now
 * bypass it entirely and never reach the limiter.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { CredentialVerifier } from '@/modules/auth/index.js';
import type { OAuthClientRow } from '@/modules/database/index.js';
import { createOAuthAuthorizeApiRouter } from '@/modules/oauth/index.js';
import { createConsentPasswordRateLimiter } from '@/modules/oauth/oauth-consent-ratelimit.service.js';
import type { OAuthProvider } from '@/modules/oauth/index.js';

const CLIENT_ID = 'client-ratelimit';
const REDIRECT_URI = 'https://app.example/cb';
const READ_SCOPE = 'cloudcli:read';
/**
 * A state-changing scope. The password branch is now reached ONLY by a grant that
 * goes past `cloudcli:read`, so the legs that are about the password (a–h below)
 * must submit this rather than the read scope.
 */
const WRITE_SCOPE = 'cloudcli:session:send';
/** Fifteen minutes, the AC's window; also the amount leg (b) advances past. */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
/** An arbitrary fixed epoch the injected clock starts at. */
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const CORRECT_PASSWORD = 'correct-horse';
/** The signed-in principal the harness attaches; the route reads its username as the fallback. */
const OWNER = 'owner';

/** The fake client row the consent routes validate the request against. */
const CLIENT_ROW = {
  client_id: CLIENT_ID,
  client_name: 'Rate Limit App',
  redirect_uris: JSON.stringify([REDIRECT_URI]),
  disabled_at: null,
} as unknown as OAuthClientRow;

const clients = {
  findById: (clientId: string): OAuthClientRow | undefined =>
    clientId === CLIENT_ID ? CLIENT_ROW : undefined,
};

/** The fake credential check the AC pins the failure/correct boundary on. */
const verifyCredentials: CredentialVerifier = async (_username, password) =>
  password === CORRECT_PASSWORD ? { ok: true, userId: 1 } : { ok: false };

type DecisionReading = { status: number; redirectTo: string | null; body: unknown };

type Harness = {
  baseUrl: string;
  /** How many times the fake provider minted a code (the AC's "no code was issued" reading). */
  authorizeCalls: () => number;
  /** Advances the injected clock; the criterion never sleeps real time. */
  advance: (deltaMs: number) => void;
};

/**
 * Runs `run` against a freshly mounted consent JSON API on a bare app, over real
 * HTTP. `trustProxy` is injected into the limiter directly — never read from the
 * ambient environment — so the unproxied legs are deterministic.
 */
async function withRateLimitServer(
  trustProxy: boolean,
  run: (harness: Harness) => Promise<void>
): Promise<void> {
  let nowMs = START_MS;
  let authorizeCount = 0;
  const provider = {
    authorize: (): { ok: true; code: string } => {
      authorizeCount += 1;
      return { ok: true, code: `code-${authorizeCount}` };
    },
  } as unknown as OAuthProvider;

  const app = express();
  // The JWT middleware is out of scope here (AC-268's leg covers it); the route
  // only needs `req.user` for the username fallback, so a pass-through stands in.
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number; username: string } }).user = {
      id: 1,
      username: OWNER,
    };
    next();
  });
  app.use(
    '/api/oauth/authorize',
    createOAuthAuthorizeApiRouter({
      provider,
      clients,
      verifyCredentials,
      rateLimiter: createConsentPasswordRateLimiter({
        now: () => new Date(nowMs),
        windowMs: WINDOW_MS,
        maxAttempts: MAX_ATTEMPTS,
        trustProxy,
      }),
    })
  );

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authorizeCalls: () => authorizeCount,
      advance: (deltaMs: number) => {
        nowMs += deltaMs;
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * POSTs one decision; `password` and any extra headers are the leg's variable.
 * `overrides` lets a leg choose the action or the submitted scope set — the AC's
 * read-only / forged / junk-scope cases all turn on exactly those two fields.
 */
async function postDecision(
  harness: Harness,
  password: string,
  headers: Record<string, string> = {},
  overrides: { scopes?: string[]; action?: 'allow' | 'deny'; extraBody?: Record<string, unknown> } = {}
): Promise<DecisionReading> {
  const response = await fetch(`${harness.baseUrl}/api/oauth/authorize/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      scopes: overrides.scopes ?? [WRITE_SCOPE],
      action: overrides.action ?? 'allow',
      password,
      ...overrides.extraBody,
    }),
  });
  const body = (await response.json().catch(() => null)) as { redirectTo?: string } | null;
  return { status: response.status, redirectTo: body?.redirectTo ?? null, body };
}

const WRONG = 'wrong-horse';

test('(a)+(b) ten failures block the source; the eleventh is 429 even with the right password; the next window admits it', async () => {
  await withRateLimitServer(false, async (harness) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      statuses.push((await postDecision(harness, WRONG)).status);
    }
    const blocked = await postDecision(harness, CORRECT_PASSWORD);
    statuses.push(blocked.status);
    console.log(
      `(a) statuses=${statuses.join(',')}; the 11th carried the correct password and answered ${blocked.status}; `
      + `authorizeCalls=${harness.authorizeCalls()}; redirectTo=${JSON.stringify(blocked.redirectTo)}`
    );
    assert.ok(
      statuses.slice(0, MAX_ATTEMPTS).every((status) => status === 401),
      `the first ten wrong-password attempts must each be 401, got ${statuses.slice(0, MAX_ATTEMPTS).join(',')}`
    );
    assert.equal(blocked.status, 429, 'the eleventh attempt must be refused, even with the correct password');
    assert.equal(harness.authorizeCalls(), 0, 'a blocked attempt must not mint a code');
    assert.equal(blocked.redirectTo, null, 'a blocked attempt must not hand back a redirectTo');

    // (b) Advance past the fixed window: the same source is readable again.
    const advanceBy = WINDOW_MS + 1;
    harness.advance(advanceBy);
    const recovered = await postDecision(harness, CORRECT_PASSWORD);
    console.log(
      `(b) nowMs += ${advanceBy}; same source POST correct password -> ${recovered.status}; `
      + `redirectTo=${JSON.stringify(recovered.redirectTo)}; authorizeCalls=${harness.authorizeCalls()}`
    );
    assert.equal(recovered.status, 200, 'after the window, a correct password must be admitted');
    assert.ok(recovered.redirectTo !== null, 'the recovery must hand back a redirectTo');
  });
});

test('(c) with a trusted proxy, CF-Connecting-IP separates sources: A is blocked, B is not', async () => {
  await withRateLimitServer(true, async (harness) => {
    const aHeaders = { 'CF-Connecting-IP': '1.1.1.1' };
    const bHeaders = { 'CF-Connecting-IP': '2.2.2.2' };
    const aStatuses: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      aStatuses.push((await postDecision(harness, WRONG, aHeaders)).status);
    }
    const aEleventh = await postDecision(harness, CORRECT_PASSWORD, aHeaders);
    aStatuses.push(aEleventh.status);
    const bFirst = await postDecision(harness, CORRECT_PASSWORD, bHeaders);
    console.log(
      `(c) source A(1.1.1.1) statuses=${aStatuses.join(',')}; source B(2.2.2.2) first=${bFirst.status} `
      + `redirectTo=${JSON.stringify(bFirst.redirectTo)}`
    );
    assert.equal(aEleventh.status, 429, 'the eleventh attempt from A must be refused');
    assert.notEqual(bFirst.status, 429, 'B has its own bucket, so its first attempt is not refused');
    assert.equal(bFirst.status, 200, 'B with the correct password must be admitted');
  });
});

test('(d) without a trusted proxy, forged CF-Connecting-IP / X-Forwarded-For never change the source', async () => {
  await withRateLimitServer(false, async (harness) => {
    const forged: Array<Record<string, string>> = [
      { 'CF-Connecting-IP': '9.9.9.9' },
      { 'CF-Connecting-IP': '8.8.8.8' },
      { 'X-Forwarded-For': '7.7.7.7' },
    ];
    const statuses: number[] = [];
    const headerLog: string[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const headers = forged[attempt % forged.length];
      headerLog.push(JSON.stringify(headers));
      statuses.push((await postDecision(harness, WRONG, headers)).status);
    }
    const eleventh = await postDecision(harness, CORRECT_PASSWORD, { 'CF-Connecting-IP': '9.9.9.9' });
    statuses.push(eleventh.status);
    console.log(
      `(d) forged headers per attempt=${headerLog.join(' ')}; statuses=${statuses.join(',')}; `
      + `the 11th answered ${eleventh.status}`
    );
    assert.ok(
      statuses.slice(0, MAX_ATTEMPTS).every((status) => status === 401),
      'every forged-header failure must be an ordinary 401, not a fresh-source success'
    );
    assert.equal(statuses[MAX_ATTEMPTS], 429, 'the forged headers must not buy the client an extra identity');
  });
});

test('(e) a confirmed password clears only its own source', async () => {
  await withRateLimitServer(true, async (harness) => {
    const aHeaders = { 'CF-Connecting-IP': '1.1.1.1' };
    const bHeaders = { 'CF-Connecting-IP': '2.2.2.2' };

    const aFailures: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      aFailures.push((await postDecision(harness, WRONG, aHeaders)).status);
    }
    const bFailures: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      bFailures.push((await postDecision(harness, WRONG, bHeaders)).status);
    }
    const aSuccess = await postDecision(harness, CORRECT_PASSWORD, aHeaders);

    const bMore: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      bMore.push((await postDecision(harness, WRONG, bHeaders)).status);
    }

    const aSuffix: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      aSuffix.push((await postDecision(harness, WRONG, aHeaders)).status);
    }

    console.log(
      `(e) A failures=${aFailures.join(',')}; B failures=${bFailures.join(',')}; `
      + `A success=${aSuccess.status} (redirectTo=${JSON.stringify(aSuccess.redirectTo)}); `
      + `B next six=${bMore.join(',')}; A next eleven=${aSuffix.join(',')}`
    );

    // B's six after A's success: the first five are ordinary failures; the sixth
    // is B's eleventh overall, so it is refused — B's bucket was never cleared.
    assert.equal(bMore[5], 429, 'B must still be blocked on its eleventh attempt after A succeeded');
    assert.ok(
      bMore.slice(0, 5).every((status) => status === 401),
      'B must keep counting through its first five post-success failures'
    );
    // A was cleared by its own success: it takes ten more failures to be blocked again.
    assert.ok(
      aSuffix.slice(0, MAX_ATTEMPTS).every((status) => status === 401),
      'A must have been reset by its own success, so ten more failures are admitted'
    );
    assert.equal(aSuffix[MAX_ATTEMPTS], 429, 'A must be blocked again only on its eleventh failure');
  });
});

test('(f) a read-only decision needs no password, mints a code, and spends none of the budget', async () => {
  await withRateLimitServer(false, async (harness) => {
    // Ten read-only allows, no password at all: each must be admitted.
    const readOnly: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      readOnly.push((await postDecision(harness, '', {}, { scopes: [READ_SCOPE] })).status);
    }
    assert.ok(
      readOnly.every((status) => status === 200),
      `every read-only decision must be admitted without a password, got ${readOnly.join(',')}`
    );
    assert.equal(harness.authorizeCalls(), MAX_ATTEMPTS, 'each read-only allow must mint a code');

    // The ten read-only allows must not have spent the source's budget: ten
    // wrong-password write attempts are each an ordinary 401, not 429.
    const writeFailures: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      writeFailures.push((await postDecision(harness, WRONG)).status);
    }
    console.log(
      `(f) read-only no-password statuses=${readOnly.join(',')} authorizeCalls=${harness.authorizeCalls()}; `
      + `then write wrong-password statuses=${writeFailures.join(',')}`
    );
    assert.ok(
      writeFailures.every((status) => status === 401),
      'the read-only branch must not consume the rate-limit budget'
    );
    // The budget is now genuinely full, so the eleventh write attempt is blocked —
    // proving the ten read-only allows really spent nothing (this is the control
    // that the previous assertion would be vacuous without).
    const eleventh = await postDecision(harness, CORRECT_PASSWORD);
    assert.equal(eleventh.status, 429, 'the write branch must still be blockable after ten write failures');
  });
});

test('(g) a write scope with no password is 401 and counts toward the budget', async () => {
  await withRateLimitServer(false, async (harness) => {
    const noPassword: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      noPassword.push((await postDecision(harness, '', {}, { scopes: [WRITE_SCOPE] })).status);
    }
    const eleventh = await postDecision(harness, CORRECT_PASSWORD, {}, { scopes: [WRITE_SCOPE] });
    console.log(`(g) write no-password statuses=${noPassword.join(',')}; the 11th (correct password)=${eleventh.status}`);
    assert.ok(
      noPassword.every((status) => status === 401),
      `an absent password must be a failed confirmation, got ${noPassword.join(',')}`
    );
    assert.equal(harness.authorizeCalls(), 0, 'no write decision may mint a code without a password');
    assert.equal(eleventh.status, 429, 'an absent password must count toward the source budget like a wrong one');
  });
});

test('(h) a body that dresses a write scope up as read-only is still refused without a valid password', async () => {
  await withRateLimitServer(false, async (harness) => {
    // The read scope is present and an explicit `readonly` flag claims the body
    // grants nothing — but a write scope is in the set, so the grant set reaches
    // past read and the password is required. The flag is never consulted.
    const forged = await postDecision(
      harness,
      '',
      {},
      { scopes: [READ_SCOPE, WRITE_SCOPE], extraBody: { readonly: true, read_only: true } }
    );
    const forgedWithWrong = await postDecision(
      harness,
      WRONG,
      {},
      { scopes: [READ_SCOPE, WRITE_SCOPE], extraBody: { readonly: true } }
    );
    const forgedWithRight = await postDecision(
      harness,
      CORRECT_PASSWORD,
      {},
      { scopes: [READ_SCOPE, WRITE_SCOPE], extraBody: { readonly: true } }
    );
    console.log(
      `(h) forged read-only-looking write body: no password=${forged.status} wrong=${forgedWithWrong.status} correct=${forgedWithRight.status}`
    );
    assert.equal(forged.status, 401, 'a write scope dressed as read-only must still need a password');
    assert.equal(forgedWithWrong.status, 401, 'a wrong password must not be rescued by the flag');
    assert.equal(forgedWithRight.status, 200, 'a genuinely correct password must still be admitted');
  });
});

test('(i) an out-of-vocabulary scope is dropped before the decision, so the rest is read-only and password-free', async () => {
  await withRateLimitServer(false, async (harness) => {
    const allowed = await postDecision(harness, '', {}, {
      scopes: ['cloudcli:admin', 'bogus:scope', READ_SCOPE],
    });
    console.log(`(i) junk+read scopes, no password -> ${allowed.status}; authorizeCalls=${harness.authorizeCalls()}`);
    assert.equal(allowed.status, 200, 'after the filter the grant is read-only, so the session alone authorizes it');
    assert.ok(allowed.redirectTo !== null, 'the read-only grant must hand back a redirectTo');
    assert.equal(harness.authorizeCalls(), 1, 'exactly one code must be minted');
  });
});

test('(j) deny never needs a password and never spends a source budget', async () => {
  await withRateLimitServer(false, async (harness) => {
    const denials: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt += 1) {
      // A write scope in the body, and no password: a denial grants nothing, so
      // neither the password nor the limiter has any subject.
      denials.push((await postDecision(harness, '', {}, { scopes: [WRITE_SCOPE], action: 'deny' })).status);
    }
    const stillAllowed = await postDecision(harness, CORRECT_PASSWORD, {}, { scopes: [WRITE_SCOPE] });
    console.log(
      `(j) deny statuses=${denials.join(',')}; then write allow (correct password)=${stillAllowed.status}; `
      + `authorizeCalls=${harness.authorizeCalls()}`
    );
    // Counted rather than tested with `.every`: TypeScript infers a type
    // predicate for an inline `status === 200` comparison, which narrows the
    // array to `200[]` for the rest of the block and makes the very next
    // comparison against 429 a "no overlap" error.
    const admitted = denials.filter((status) => status === 200);
    const rateLimited = denials.filter((status) => status === 429);
    assert.equal(
      admitted.length,
      denials.length,
      `every denial must be admitted without a password, got ${denials.join(',')}`
    );
    assert.equal(rateLimited.length, 0, `a denial must never be rate limited, got ${denials.join(',')}`);
    assert.equal(harness.authorizeCalls(), 1, 'only the final allow may mint a code');
    assert.equal(
      stillAllowed.status,
      200,
      'twelve denials must not have spent the source budget for the following allow'
    );
  });
});
