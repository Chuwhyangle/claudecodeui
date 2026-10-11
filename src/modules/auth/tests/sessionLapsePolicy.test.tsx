import assert from 'node:assert/strict';

import { act, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import enAuth from '@/modules/i18n/locales/en/auth.json';
import { storeAuthToken } from '@/shared/authToken';

/**
 * The startup self-check's lapse policy, against a stubbed transport.
 *
 * The self-check is the only reader of `GET /api/auth/user` at boot, and it is
 * the only place that decides whether the stored session still exists. Both of
 * its failure exits used to call `notifySessionLapsed()` — which clears the
 * session and deletes the token — for ANY non-2xx response and for any 2xx whose
 * body is not `{ user }`. A gateway 502 during a server restart, or a reverse
 * proxy's HTML interception page, therefore destroyed a still-valid 7d session
 * and dropped the user onto the login form.
 *
 * These cases pin the corrected policy: only a server-side rejection
 * (`status === 401`) may lapse the session; every other failure — 5xx, an
 * unparseable 2xx, a dropped connection — keeps the token and the signed-in user
 * while the self-check retries with bounded backoff. The 401 case is the
 * positive control: it must stay byte-identical to the behaviour it had before.
 *
 * The real translations are loaded (not a stub `t`) so the banner assertions
 * read exactly the string the login page renders.
 */

const SESSION_EXPIRED_TEXT = 'Your session expired. Please log in again.';

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

// The app's issued JWT shape (three base64url segments) with a live `exp`, so
// `getStoredAuthToken()` hands it to the request instead of dropping it locally.
let tokenSerial = 0;
const liveToken = (): string => {
  tokenSerial += 1;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iat: now,
    exp: now + 600,
    sub: `probe-${tokenSerial}`,
  })}.signature`;
};

type UserResponseMode = 'success' | 'unauthorized' | 'gateway' | 'html' | 'offline';

let userMode: UserResponseMode = 'success';
let gatewayStatus = 502;
// Every `/api/auth/user` call, in order, plus the stored token as it looked when
// that call went out. The token snapshots are the mid-flight readings: a call
// that a retry issues can only see the token if no earlier failure removed it.
let userCalls = 0;
let tokenSeenByAttempt: (string | null)[] = [];

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const installFetch = () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/api/auth/status')) {
      return jsonResponse({ needsSetup: false });
    }

    if (url.includes('/api/user/onboarding-status')) {
      return jsonResponse({ hasCompletedOnboarding: true });
    }

    if (url.includes('/api/auth/user')) {
      userCalls += 1;
      tokenSeenByAttempt.push(localStorage.getItem('auth-token'));

      switch (userMode) {
        case 'unauthorized':
          return new Response('{}', {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'X-Auth-Error': 'session-expired' },
          });
        case 'gateway':
          return new Response('bad gateway', { status: gatewayStatus });
        case 'html':
          // What a captive portal or an intercepting reverse proxy answers: a
          // 2xx that is not the JSON the client asked for.
          return new Response('<!doctype html><html><body>proxy</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        case 'offline':
          throw new TypeError('Failed to fetch');
        default:
          return jsonResponse({ user: { id: 1, username: 'alice' } });
      }
    }

    // Preferences and any other follow-up read a signed-in check performs.
    return jsonResponse({});
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

function Probe() {
  const { user, isLoading, error, token } = useAuth();
  return (
    <div>
      <span data-testid="probe-user">{user ? String(user.username) : 'none'}</span>
      <span data-testid="probe-loading">{String(isLoading)}</span>
      {/* The error is an attribute, not text: the login page renders the same
          string, and a text node here would make the banner queries ambiguous. */}
      <span data-testid="probe-error" data-error={error ?? ''} />
      <span data-testid="probe-token">{token ?? 'none'}</span>
    </div>
  );
}

const renderApp = () =>
  render(
    <AuthProvider>
      <Probe />
      <ProtectedRoute>
        <div data-testid="app-shell">signed in</div>
      </ProtectedRoute>
    </AuthProvider>,
  );

const probeText = (testId: string) => screen.getByTestId(testId).textContent;

const waitForUser = (username: string, timeout = 5000) =>
  waitFor(() => assert.equal(probeText('probe-user'), username), { timeout });

/** Brings the app to a genuinely signed-in state: a stored token the server accepts. */
const establishSignedInSession = async (): Promise<string> => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  renderApp();
  await waitForUser('alice');
  return token;
};

/**
 * Forces the next self-check. A rotated token is how the server hands back a
 * refreshed credential, and the provider re-runs the check when its token
 * changes — so this is exactly the second self-check a long-lived tab makes.
 */
const triggerSelfCheck = (nextToken: string) => {
  act(() => {
    storeAuthToken(nextToken);
  });
};

beforeEach(() => {
  localStorage.clear();
  userMode = 'success';
  gatewayStatus = 502;
  userCalls = 0;
  tokenSeenByAttempt = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a 401 still lapses the session, drops the token and shows the banner', async () => {
  localStorage.setItem('auth-token', liveToken());
  userMode = 'unauthorized';

  renderApp();

  // The banner lives on the login form, so waiting for it also proves the app
  // fell through to the login page rather than staying on the gate.
  await screen.findByText(SESSION_EXPIRED_TEXT);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(probeText('probe-user'), 'none');
  assert.ok(userCalls >= 1);
});

for (const status of [500, 502, 503, 504]) {
  test(`a ${status} keeps the signed-in user and the stored token`, async () => {
    await establishSignedInSession();

    userMode = 'gateway';
    gatewayStatus = status;
    const rotated = liveToken();
    triggerSelfCheck(rotated);

    // Only a self-check that survived the failure issues the retry. One that
    // treated the 5xx as a lapse clears the token, and a cleared token is never
    // sent again.
    await waitFor(() => assert.ok(userCalls >= 3), { timeout: 4000 });

    assert.equal(probeText('probe-user'), 'alice');
    assert.equal(probeText('probe-loading'), 'false');
    assert.equal(screen.queryByText(SESSION_EXPIRED_TEXT), null);
    assert.equal(localStorage.getItem('auth-token'), rotated);
  });
}

test('a 2xx whose body is HTML keeps the signed-in user and the stored token', async () => {
  await establishSignedInSession();

  userMode = 'html';
  const rotated = liveToken();
  triggerSelfCheck(rotated);

  // A 2xx that is not `{ user }` is an interception page, not a rejection: the
  // session must survive it and the check must keep trying.
  await waitFor(() => assert.ok(userCalls >= 3), { timeout: 4000 });

  assert.equal(probeText('probe-user'), 'alice');
  assert.equal(probeText('probe-loading'), 'false');
  assert.equal(screen.queryByText(SESSION_EXPIRED_TEXT), null);
  assert.equal(localStorage.getItem('auth-token'), rotated);
});

test('a dropped connection keeps the signed-in user and the stored token', async () => {
  await establishSignedInSession();

  userMode = 'offline';
  const rotated = liveToken();
  triggerSelfCheck(rotated);

  await waitFor(() => assert.ok(userCalls >= 3), { timeout: 4000 });

  assert.equal(probeText('probe-user'), 'alice');
  assert.equal(probeText('probe-loading'), 'false');
  assert.equal(screen.queryByText(SESSION_EXPIRED_TEXT), null);
  assert.equal(localStorage.getItem('auth-token'), rotated);
});

test('a transient failure retries the same self-check and returns to the signed-in state', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  userMode = 'gateway';

  renderApp();

  // The retry is only issued after the first failure was processed, so its
  // arrival is the evidence that the failure did not end the session.
  await waitFor(() => assert.ok(userCalls >= 2), { timeout: 4000 });

  // A mid-flight reading: the second attempt still carried the original token.
  assert.equal(tokenSeenByAttempt[1], token);
  assert.equal(localStorage.getItem('auth-token'), token);
  // No user is on screen yet, so the auth gate must stay up — a login form here
  // would be the exact "forced to re-enter credentials" outcome.
  assert.equal(probeText('probe-loading'), 'true');
  assert.equal(screen.queryByText(SESSION_EXPIRED_TEXT), null);

  userMode = 'success';
  await waitForUser('alice');

  assert.equal(localStorage.getItem('auth-token'), token);
  assert.equal(probeText('probe-loading'), 'false');
});
