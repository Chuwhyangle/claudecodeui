import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test, vi } from 'vitest';

import OAuthConsentRoute from '@/modules/oauth-consent/OAuthConsentRoute';
import { useOAuthConsent } from '@/modules/oauth-consent/hooks/useOAuthConsent';
import { ApiRequestError } from '@/shared/api';
import enConsent from '@/modules/i18n/locales/en/consent.json';
import type { OAuthConsentContext } from '@/shared/types';

/**
 * The consent page's decision logic and its render, against a stubbed transport.
 *
 * This is the half a browser probe cannot pin cheaply: that the pinned read
 * scope is the ONLY pre-checked box and a write scope never arrives checked,
 * that the submitted decision carries exactly the ticks the user made (empty on
 * Deny), and that a request the server refused renders an error face with NO
 * Allow button — the property that keeps a refused request unapprovable. Which
 * cookies, redirects and HTTP statuses really produce those states, and that the
 * granted scopes really reach a live token, is the e2e criterion's job.
 *
 * It also pins what gap-oauth-consent-flow-ux-hardening added: the two scope
 * groups with a risk badge on every state-changing scope BEFORE it is ticked,
 * the self-reported-client notice with its registration provenance and the
 * server's own token lifetime, and that the password confirmation appears ONLY
 * for a grant that reaches past the read scope.
 *
 * The real translations are loaded (not a stub `t`) so a missing key would render
 * as its own namespaced path and the assertions below would see it.
 */

const SEARCH =
  '?client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback'
  + '&state=state-1&code_challenge=challenge-1&code_challenge_method=S256';

const { contextMock, decideMock, locationRef } = vi.hoisted(() => ({
  contextMock: vi.fn(),
  decideMock: vi.fn(),
  locationRef: {
    search:
      '?client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback'
      + '&state=state-1&code_challenge=challenge-1&code_challenge_method=S256',
  },
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    api: { oauthConsent: { context: contextMock, decide: decideMock } },
  };
});

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'ada' } }) }));

vi.mock('react-router-dom', () => ({ useLocation: () => locationRef }));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['consent'],
  defaultNS: 'consent',
  resources: { en: { consent: enConsent } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const CONSENT_CONTEXT: OAuthConsentContext = {
  clientName: 'ChatGPT',
  callbackHost: '127.0.0.1:8765',
  redirectUri: 'http://127.0.0.1:8765/callback',
  scopes: [
    { scope: 'cloudcli:read', description: 'read', required: true, writable: false, group: 'read', risk: null },
    { scope: 'cloudcli:session:send', description: 'send', required: false, writable: true, group: 'write', risk: 'sessionSend' },
    { scope: 'cloudcli:session:create', description: 'create', required: false, writable: true, group: 'write', risk: 'sessionCreate' },
    { scope: 'cloudcli:session:control', description: 'control', required: false, writable: true, group: 'write', risk: 'sessionControl' },
    { scope: 'cloudcli:approve', description: 'approve', required: false, writable: true, group: 'write', risk: 'approve' },
    { scope: 'cloudcli:navigate', description: 'navigate', required: false, writable: true, group: 'write', risk: 'navigate' },
  ],
  state: 'state-1',
  // A non-default lifetime so a hardcoded 3600 (or 60) would NOT satisfy the
  // token-lifetime assertion below.
  accessTokenTtlSeconds: 1800,
  // Registered long ago, so the "new application" emphasis is OFF by default;
  // the test that wants it supplies a fresh timestamp.
  clientCreatedAt: '2020-01-02T03:04:05.000Z',
  clientCreatedVia: 'dcr',
};

/** A Response-shaped object; the hook reads only `ok`, `status` and `json()`. */
const okJson = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data });

/**
 * A refusal exactly as the consent surface answers it: an RFC 6749 error object
 * whose `error` code — not the status — is what separates a wrong confirmation
 * password from a lapsed session (both are 401).
 */
const refusal = (status: number, error: string, description: string) =>
  Promise.resolve({
    ok: false,
    status,
    json: async () => ({ error, error_description: description }),
  });

/** The tick box inside the scope row whose `data-scope` matches. */
const tickBoxFor = (scope: string): HTMLInputElement => {
  const row = screen.getAllByTestId('consent-scope').find((candidate) => candidate.getAttribute('data-scope') === scope);
  assert.ok(row, `no scope row for ${scope}`);
  return row.querySelector('input') as HTMLInputElement;
};

const allowButton = () => screen.getByTestId('consent-allow') as HTMLButtonElement;

beforeEach(() => {
  contextMock.mockReset();
  decideMock.mockReset();
  locationRef.search = SEARCH;
});

describe('useOAuthConsent', () => {
  test('loads the context and pins exactly the required read scope', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    const { result } = renderHook(() => useOAuthConsent(SEARCH, vi.fn()));

    await waitFor(() => assert.equal(result.current.phase, 'ready'));
    assert.deepEqual(result.current.selectedScopes, ['cloudcli:read']);
    assert.equal(result.current.hasWriteSelection, false);
    assert.equal(result.current.requiresPassword, false);
    assert.equal(result.current.context?.clientName, 'ChatGPT');
  });

  test('a ticked write scope turns on the risk warning and is submitted with Allow', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(okJson({ redirectTo: 'http://127.0.0.1:8765/callback?code=abc&state=state-1' }));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.toggleScope('cloudcli:navigate', true));
    assert.equal(result.current.hasWriteSelection, true);
    assert.equal(result.current.requiresPassword, true);

    await act(async () => result.current.decide('allow'));
    const decision = decideMock.mock.calls[0][0] as { scopes: string[]; action: string };
    assert.equal(decision.action, 'allow');
    assert.deepEqual([...decision.scopes].sort(), ['cloudcli:navigate', 'cloudcli:read'].sort());
    assert.equal(navigate.mock.calls[0][0], 'http://127.0.0.1:8765/callback?code=abc&state=state-1');
  });

  test('Deny submits no scopes and still navigates to the callback', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(okJson({ redirectTo: 'http://127.0.0.1:8765/callback?error=access_denied&state=state-1' }));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.toggleScope('cloudcli:navigate', true));
    await act(async () => result.current.decide('deny'));

    const decision = decideMock.mock.calls[0][0] as { scopes: string[]; action: string };
    assert.equal(decision.action, 'deny');
    assert.deepEqual(decision.scopes, []);
    assert.equal(navigate.mock.calls[0][0], 'http://127.0.0.1:8765/callback?error=access_denied&state=state-1');
  });

  test('a link with no client_id never reaches the server and reports missing-request', async () => {
    const { result } = renderHook(() => useOAuthConsent('?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb', vi.fn()));
    await waitFor(() => assert.equal(result.current.phase, 'error'));
    assert.equal(result.current.error?.kind, 'missing-request');
    assert.equal(contextMock.mock.calls.length, 0);
  });

  test('a 401 from the context endpoint is the unauthorized face, not a generic error', async () => {
    contextMock.mockRejectedValue(new ApiRequestError('Unauthorized', { status: 401 }));
    const { result } = renderHook(() => useOAuthConsent(SEARCH, vi.fn()));
    await waitFor(() => assert.equal(result.current.phase, 'unauthorized'));
    assert.equal(result.current.error?.kind, 'unauthorized');
  });

  test('Allow carries the re-entered password; Deny carries none', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(okJson({ redirectTo: 'http://127.0.0.1:8765/callback?code=abc&state=state-1' }));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.setPassword('hunter2'));
    await act(async () => result.current.decide('allow'));
    const allow = decideMock.mock.calls[0][0] as { action: string; password: string };
    assert.equal(allow.action, 'allow');
    assert.equal(allow.password, 'hunter2', 'the confirmation password must reach the server');

    decideMock.mockReturnValue(
      okJson({ redirectTo: 'http://127.0.0.1:8765/callback?error=access_denied&state=state-1' }),
    );
    await act(async () => result.current.decide('deny'));
    const deny = decideMock.mock.calls[1][0] as { action: string; password: string };
    assert.equal(deny.action, 'deny');
    assert.equal(deny.password, '', 'a denial grants nothing, so it sends no secret');
  });

  test('a wrong confirmation password keeps the decision on screen and reports invalid-credentials', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(refusal(401, 'invalid_credentials', 'Incorrect username or password'));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.setPassword('wrong'));
    await act(async () => result.current.decide('allow'));

    await waitFor(() => assert.equal(result.current.submitError?.kind, 'invalid-credentials'));
    assert.equal(result.current.phase, 'ready', 'a wrong password must not take the decision away');
    assert.equal(result.current.error, null);
    assert.equal(navigate.mock.calls.length, 0, 'a refused confirmation must not navigate');
  });

  test('a 429 is reported as rate-limited, not as a lapsed session', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(refusal(429, 'too_many_requests', 'Too many password attempts; try again later'));
    const navigate = vi.fn();
    const { result } = renderHook(() => useOAuthConsent(SEARCH, navigate));
    await waitFor(() => assert.equal(result.current.phase, 'ready'));

    act(() => result.current.setPassword('hunter2'));
    await act(async () => result.current.decide('allow'));

    await waitFor(() => assert.equal(result.current.submitError?.kind, 'rate-limited'));
    assert.equal(result.current.phase, 'ready');
    assert.equal(result.current.error, null);
    assert.equal(navigate.mock.calls.length, 0);
  });
});

describe('OAuthConsentRoute', () => {
  test('renders the client, the callback host and six scopes with only the read box checked and disabled', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);

    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));
    assert.equal(screen.getByTestId('consent-client-name').textContent, 'ChatGPT');
    assert.equal(screen.getByTestId('consent-callback-host').textContent, '127.0.0.1:8765');

    const rows = screen.getAllByTestId('consent-scope');
    assert.equal(rows.length, 6);
    const boxes = screen.getAllByTestId('consent-scope-checkbox') as HTMLInputElement[];
    assert.deepEqual(boxes.map((box) => box.checked), [true, false, false, false, false, false]);
    assert.deepEqual(boxes.map((box) => box.disabled), [true, false, false, false, false, false]);
    // No write scope is ticked, so the risk warning is absent until one is.
    assert.equal(screen.queryByTestId('consent-write-warning'), null);
  });

  test('files the scopes under two headings and badges every write scope BEFORE it is ticked', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);
    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));

    const readGroup = screen.getByTestId('consent-group-read');
    const writeGroup = screen.getByTestId('consent-group-write');
    assert.ok(readGroup.textContent?.includes(enConsent.groups.read));
    assert.ok(writeGroup.textContent?.includes(enConsent.groups.write));

    // The read group holds exactly the pinned, checked and disabled read scope,
    // and no risk badge.
    const readBox = within(readGroup).getByTestId('consent-scope-checkbox') as HTMLInputElement;
    assert.equal(readBox.checked, true);
    assert.equal(readBox.disabled, true);
    assert.equal(within(readGroup).queryAllByTestId('consent-scope-risk').length, 0);

    // The write group holds the other five, all unticked and each with a visible
    // risk badge even before anything is selected.
    assert.equal(within(writeGroup).getAllByTestId('consent-scope').length, 5);
    const badges = within(writeGroup).getAllByTestId('consent-scope-risk');
    assert.equal(badges.length, 5, 'every state-changing scope carries its risk badge');
    for (const badge of badges) {
      assert.ok((badge.textContent ?? '').trim().length > 0);
    }
    const writeBoxes = within(writeGroup).getAllByTestId('consent-scope-checkbox') as HTMLInputElement[];
    assert.deepEqual(writeBoxes.map((box) => box.checked), [false, false, false, false, false]);
  });

  test('ticking a write scope reveals the risk warning', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);
    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));

    await act(async () => tickBoxFor('cloudcli:navigate').click());

    await waitFor(() => assert.ok(screen.queryByTestId('consent-write-warning')));
  });

  test('names the client as self-reported, shows its provenance and the server token lifetime', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);
    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));

    const unverified = screen.getByTestId('consent-client-unverified');
    assert.equal(unverified.textContent, enConsent.clientUnverified);
    // The notice must never read as a trust signal.
    assert.ok(!/trusted/i.test(unverified.textContent ?? ''));

    const registered = screen.getByTestId('consent-client-registered').textContent ?? '';
    assert.ok(registered.includes(enConsent.clientRegisteredVia.dcr));

    // Registered long ago, so no "new application" emphasis.
    assert.equal(screen.queryByTestId('consent-new-client'), null);

    // The token lifetime is the context endpoint's value, rendered verbatim on
    // the element, and its visible minutes are that value's own, not a literal.
    const lifetime = screen.getByTestId('consent-token-lifetime');
    assert.equal(lifetime.getAttribute('data-ttl-seconds'), String(CONSENT_CONTEXT.accessTokenTtlSeconds));
    assert.ok(lifetime.textContent?.includes(String(CONSENT_CONTEXT.accessTokenTtlSeconds / 60)));
  });

  test('flags a freshly registered client with the new-application notice', async () => {
    contextMock.mockReturnValue(okJson({ ...CONSENT_CONTEXT, clientCreatedAt: new Date().toISOString() }));
    render(<OAuthConsentRoute />);

    await waitFor(() => assert.ok(screen.queryByTestId('consent-new-client')));
    assert.equal(screen.getByTestId('consent-new-client').textContent, enConsent.newClientNotice);
  });

  test('shows the password field only for a write grant, and only then gates Allow on it', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    render(<OAuthConsentRoute />);
    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));

    // Read-only: no confirmation field, and Allow is immediately available.
    assert.equal(screen.queryByTestId('consent-password'), null);
    assert.equal(allowButton().disabled, false);

    await act(async () => tickBoxFor('cloudcli:navigate').click());

    const field = (await screen.findByTestId('consent-password')) as HTMLInputElement;
    assert.equal(field.type, 'password');
    assert.equal(allowButton().disabled, true, 'a write grant must wait for the confirmation password');

    await act(async () => {
      fireEvent.change(field, { target: { value: 'hunter2' } });
    });
    assert.equal(allowButton().disabled, false, 'a typed password must enable Allow');
  });

  test('a rate-limited refusal is shown in place with the decision intact', async () => {
    contextMock.mockReturnValue(okJson(CONSENT_CONTEXT));
    decideMock.mockReturnValue(refusal(429, 'too_many_requests', 'Too many password attempts; try again later'));
    render(<OAuthConsentRoute />);
    await waitFor(() => assert.ok(screen.queryByTestId('consent-allow')));

    await act(async () => tickBoxFor('cloudcli:navigate').click());
    const field = await screen.findByTestId('consent-password');
    await act(async () => {
      fireEvent.change(field, { target: { value: 'hunter2' } });
    });

    await act(async () => allowButton().click());
    // The refusal is rendered from the locale file (not a raw key), and the
    // decision stays on screen so the user can come back and try again.
    await waitFor(() =>
      assert.equal(screen.getByTestId('consent-submit-error').textContent, enConsent.errors.rateLimited),
    );
    assert.ok(screen.queryByTestId('consent-allow'), 'a rate-limited refusal must keep the decision rendered');
    assert.equal(screen.queryByTestId('consent-error'), null, 'a rate-limited refusal is not the page-level error face');
  });

  test('a refused request shows the error face and offers no Allow button', async () => {
    contextMock.mockRejectedValue(
      new ApiRequestError('redirect_uri is not registered for this client', { status: 400 }),
    );
    render(<OAuthConsentRoute />);

    await waitFor(() => assert.ok(screen.queryByTestId('consent-error')));
    assert.equal(screen.queryByTestId('consent-allow'), null);
    assert.equal(screen.queryByTestId('consent-deny'), null);
    assert.ok(screen.getByTestId('consent-error-message').textContent?.trim());
  });

  test('never hardcodes the token lifetime in the page source', () => {
    // vitest runs with the project root as cwd; `import.meta.url` is not a file:
    // URL under the jsdom environment, so read the source by repo-relative path.
    const source = readFileSync('src/modules/oauth-consent/OAuthConsentRoute.tsx', 'utf8');
    assert.ok(
      !source.includes('3600'),
      'the token lifetime must come from the context endpoint, never a hardcoded literal',
    );
  });
});
