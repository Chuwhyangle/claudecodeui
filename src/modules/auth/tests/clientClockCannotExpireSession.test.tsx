import assert from 'node:assert/strict';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import enAuth from '@/modules/i18n/locales/en/auth.json';
import { AUTH_SESSION_EXPIRED_EVENT, getStoredAuthToken, recordAuthLapse } from '@/shared/authToken';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';

/**
 * The client must not hold the power to expire its own session.
 *
 * A stored token whose `exp` the page's own clock reads as past is still a
 * credential the SERVER may accept: only the server's `exp` arithmetic, against
 * the server's clock, decides. The client used to pre-empt that decision — it
 * deleted the token and announced the session expired — so a browser whose clock
 * ran ahead of the server signed itself out, and the server saw only a bare
 * `invalid-token` 401 (the request went out with no credential) rather than the
 * `session-expired` refusal that would have said what really happened.
 *
 * The scenario is built the worst way for the old code: a token the server would
 * still accept (its `exp` is an hour away in real time) is read by a page clock
 * that has been pushed forward eight days. Nothing about the token changed; only
 * the client's opinion of it did.
 *
 * The positive control is the other direction: when the SERVER really refuses the
 * credential, the client must still drop it, clear the user and show the shipped
 * banner — the lapse the user is told about has to keep working, it just may no
 * longer be triggered by the client's own clock.
 *
 * Finally, the lapse is made observable. Every end-of-session path writes a
 * breadcrumb — why the client stopped holding a usable token — that the next
 * login reports to the server. It carries no credential, and the last assertions
 * prove that against the token, its signature segment and a password sentinel.
 */

const SESSION_EXPIRED_TEXT = 'Your session expired. Please log in again.';

/** The page clock is pushed forward by more than the token's whole lifetime. */
const CLOCK_SHIFT_MS = 8 * 24 * 60 * 60 * 1000;

/** A password planted in a login body; a leaked breadcrumb would carry it. */
const PASSWORD_SENTINEL = 'criterion-password-must-not-be-reported';

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A token the server would accept: its `exp` is an hour ahead of REAL time.
 *
 * Built without a signing library — nothing here verifies a signature — and the
 * `exp` is taken from the real clock before the page clock is shifted, so the
 * token stays server-valid while the page's reading of `Date.now()` runs past it.
 */
const serverValidToken = (realNowMs: number, signature = 'signature'): string => {
  const nowSeconds = Math.floor(realNowMs / 1000);
  return [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ iat: nowSeconds, exp: nowSeconds + 3600, sub: 'client-clock-probe' }),
    signature,
  ].join('.');
};

/** A WebSocket stand-in that records the URL the provider asks it to open. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

/**
 * `WebSocketProvider` is handed its auth session as an injected port (it no longer
 * imports `modules/auth`; see the shared-layer isolation criterion). These socket
 * cases are about the token the provider is HANDED, so each render below supplies
 * the session directly. The positive control renders the real `AuthProvider`
 * through its deep path, which is untouched by this arrangement.
 */

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['auth'],
    defaultNS: 'auth',
    resources: { en: { auth: enAuth } },
    interpolation: { escapeValue: false },
  });
});

let realNow: number;
let shiftedNow: number;
let token: string;

beforeEach(() => {
  localStorage.clear();
  FakeWebSocket.instances = [];
  // Capture the real clock FIRST: the token is minted against it, then the page
  // clock the app reads is pushed forward. This ordering is the whole fixture.
  realNow = Date.now();
  shiftedNow = realNow + CLOCK_SHIFT_MS;
  token = serverValidToken(realNow);
  vi.spyOn(Date, 'now').mockReturnValue(shiftedNow);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** Loads a fresh api.ts with the bearer-token path active (not platform mode). */
const loadApi = async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  return import('@/shared/api');
};

/** The breadcrumb as it sits in storage, or null when none was written. */
const readBreadcrumb = (): { reason: string; exp: number | null; now: number; at: string } | null => {
  const raw = localStorage.getItem('auth-lapse');
  return raw ? (JSON.parse(raw) as { reason: string; exp: number | null; now: number; at: string }) : null;
};

// ─────────────────────────────── the shifted page clock (AC2) ─────────────────

test('AC2(i): a token the page clock reads as expired is still handed over and is not deleted', () => {
  localStorage.setItem('auth-token', token);
  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);

  const handed = getStoredAuthToken();

  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  assert.equal(handed, token, 'the stored token must be returned, not judged by the page clock');
  assert.equal(localStorage.getItem('auth-token'), token, 'the client must not delete a token the server may still accept');
  assert.equal(expiries, 0, 'no session-expired event may be raised by the client clock');
});

test('AC2(ii): the websocket is still opened with that token in its url', () => {
  localStorage.setItem('auth-token', token);
  vi.stubGlobal('WebSocket', FakeWebSocket);

  render(React.createElement(WebSocketProvider, {
    auth: { isLoading: false, token, user: { id: 1, username: 'criterion' } },
  }));

  const socket = FakeWebSocket.instances.at(-1);
  assert.ok(socket, 'the provider must still open a socket when the page clock reads the token as expired');
  assert.ok(
    socket.url.includes(encodeURIComponent(token)),
    'the socket url must carry the token the server may still accept',
  );
});

test('AC2(iii): the request that follows carries the token as its bearer credential', async () => {
  localStorage.setItem('auth-token', token);
  let sentHeaders: Record<string, string> = {};
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    sentHeaders = (init?.headers ?? {}) as Record<string, string>;
    return new Response('{}', { status: 200 });
  }));

  const { authenticatedFetch } = await loadApi();
  await authenticatedFetch('/api/projects');

  assert.equal(
    sentHeaders.Authorization,
    `Bearer ${token}`,
    'the credential must reach the wire instead of being dropped by the client first',
  );
});

// ───────────────────────────── the positive control (AC3) ─────────────────────

test('AC3: a server 401 + session-expired still drops the token, clears the user, shows the banner and raises the event', async () => {
  localStorage.setItem('auth-token', token);
  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/status')) return jsonResponse({ needsSetup: false });
    if (url.includes('/api/user/onboarding-status')) return jsonResponse({ hasCompletedOnboarding: true });
    if (url.includes('/api/auth/user')) {
      // The server really refuses the credential, naming its own reason.
      return new Response('{}', {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'X-Auth-Error': 'session-expired' },
      });
    }
    return jsonResponse({});
  }));

  function Probe() {
    const { user } = useAuth();
    return <span data-testid="probe-user">{user ? String(user.username) : 'none'}</span>;
  }

  render(
    <AuthProvider>
      <Probe />
      <ProtectedRoute>
        <div data-testid="app-shell">signed in</div>
      </ProtectedRoute>
    </AuthProvider>,
  );

  // The banner lives on the login form, so waiting for it also proves the app
  // fell through to the login page rather than staying on the gate.
  await screen.findByText(SESSION_EXPIRED_TEXT);
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);

  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(screen.getByTestId('probe-user').textContent, 'none');
  assert.ok(expiries >= 1, 'the lapse path must still raise AUTH_SESSION_EXPIRED_EVENT');
  assert.equal(readBreadcrumb()?.reason, 'server-expired', 'the server named the reason; the breadcrumb records it');
});

// ───────────────────────────── the lapse breadcrumb (AC4) ─────────────────────

test('AC4: a server refusal names its reason and records exp, now and at', async () => {
  localStorage.setItem('auth-token', token);
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'invalid-token' } })));

  const { authenticatedFetch } = await loadApi();
  await authenticatedFetch('/api/projects');

  const breadcrumb = readBreadcrumb();
  assert.ok(breadcrumb, 'a refused credential must leave a breadcrumb');
  assert.equal(breadcrumb.reason, 'server-401', 'invalid-token is a bare refusal, not a named expiry');
  assert.equal(breadcrumb.exp, Math.floor(realNow / 1000 + 3600) * 1000, 'exp is the lapsed token’s own claim');
  assert.equal(breadcrumb.now, shiftedNow, 'now is the page clock at the moment of the lapse');
  assert.equal(breadcrumb.at, new Date(shiftedNow).toISOString(), 'at renders the same instant for a human');
});

test('AC4: the first lapse wins — later unauthenticated traffic does not relabel it', async () => {
  localStorage.setItem('auth-token', token);
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'session-expired' } })));

  const { authenticatedFetch } = await loadApi();
  await authenticatedFetch('/api/projects');
  // The token is gone now; the next request runs with no credential at all.
  await authenticatedFetch('/api/projects');

  assert.equal(readBreadcrumb()?.reason, 'server-expired', 'the cause that ended the session is the one kept');
});

test('AC4: a request that leaves with no credential records storage-empty and a null exp', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

  const { authenticatedFetch } = await loadApi();
  await authenticatedFetch('/api/projects');

  const breadcrumb = readBreadcrumb();
  assert.ok(breadcrumb, 'leaving without a credential is a lapse worth recording');
  assert.equal(breadcrumb.reason, 'storage-empty');
  assert.equal(breadcrumb.exp, null, 'no token was held, so there is no exp to record');
  assert.equal(breadcrumb.now, shiftedNow);
  assert.equal(breadcrumb.at, new Date(shiftedNow).toISOString());
});

test('AC4: local-clock is a well-formed reason, but the fixed judgement path never produces it', () => {
  // The vocabulary keeps `local-clock` so a regression that reintroduces the old
  // deletion is recognisable. Recorded explicitly, its four fields are correct.
  recordAuthLapse('local-clock');
  const explicit = readBreadcrumb();
  assert.equal(explicit?.reason, 'local-clock');
  assert.equal(explicit?.now, shiftedNow);
  assert.equal(explicit?.at, new Date(shiftedNow).toISOString());

  // ...and the shipped judgement paths must not be the thing that produces it.
  localStorage.clear();
  localStorage.setItem('auth-token', token);
  getStoredAuthToken();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  render(React.createElement(WebSocketProvider, {
    auth: { isLoading: false, token, user: { id: 1, username: 'criterion' } },
  }));

  assert.equal(
    readBreadcrumb(),
    null,
    'neither the token read nor the websocket construction may record a local-clock lapse',
  );
});

test('AC4: neither the breadcrumb nor the report carries a credential', async () => {
  const signature = 'criterionSignatureSegment';
  const probeToken = serverValidToken(realNow, signature);
  localStorage.setItem('auth-token', probeToken);

  let loginBody: { clientClock?: unknown } = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/login')) {
      loginBody = JSON.parse(String(init?.body ?? '{}')) as { clientClock?: unknown };
      return jsonResponse({ token: probeToken, user: { id: 1, username: 'criterion' } });
    }
    if (url.includes('/api/auth/status')) return jsonResponse({ needsSetup: false });
    if (url.includes('/api/user/onboarding-status')) return jsonResponse({ hasCompletedOnboarding: true });
    // Every authenticated read is refused, which is what lapses the session.
    return new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'session-expired' } });
  }));

  const { authenticatedFetch, api } = await loadApi();
  // A real lapse, then the login that reports it — the two artifacts a leak
  // would show up in.
  await authenticatedFetch('/api/projects');
  await api.auth.login('criterion-user', PASSWORD_SENTINEL);

  const breadcrumbText = localStorage.getItem('auth-lapse') ?? '';
  const reportText = JSON.stringify(loginBody.clientClock ?? null);
  assert.ok(breadcrumbText.length > 0, 'the breadcrumb must exist for this assertion to mean anything');
  assert.ok(reportText.includes('"reason"'), 'the report must carry the breadcrumb for this assertion to mean anything');

  for (const [name, secret] of Object.entries({
    'the whole token': probeToken,
    'the signature segment': signature,
    'the password sentinel': PASSWORD_SENTINEL,
  })) {
    assert.ok(!breadcrumbText.includes(secret), `${name} must not appear in the breadcrumb`);
    assert.ok(!reportText.includes(secret), `${name} must not appear in the login report`);
  }
});

// ─────────────────────── the event path stays wired (AC3) ─────────────────────

test('AC3: a token the client would have judged expired still reaches the auth gate unchanged when the server accepts it', async () => {
  // The complementary reading of the shifted clock: nothing local fires, so a
  // signed-in user stays signed in across a reload whose clock is far ahead.
  localStorage.setItem('auth-token', token);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/status')) return jsonResponse({ needsSetup: false });
    if (url.includes('/api/user/onboarding-status')) return jsonResponse({ hasCompletedOnboarding: true });
    if (url.includes('/api/auth/user')) return jsonResponse({ user: { id: 1, username: 'alice' } });
    return jsonResponse({});
  }));

  function Probe() {
    const { user } = useAuth();
    return <span data-testid="probe-user">{user ? String(user.username) : 'none'}</span>;
  }

  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

  await waitFor(() => assert.equal(screen.getByTestId('probe-user').textContent, 'alice'));
  assert.equal(localStorage.getItem('auth-token'), token, 'no local judgement may delete the token');
  assert.equal(readBreadcrumb(), null, 'a healthy session records no lapse');
});
