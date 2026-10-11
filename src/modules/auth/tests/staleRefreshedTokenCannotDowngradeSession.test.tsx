import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { AUTH_TOKEN_REFRESHED_EVENT } from '@/shared/authToken';

/**
 * A renewed token may only move the session FORWARD.
 *
 * The defect this pins: `/api/*` responses are browser-cacheable, so a reload
 * can be answered from the cache with a response — and a terminal
 * `X-Refreshed-Token` — minted when that entry was stored, not when it is
 * replayed. The request helper wrote any such header straight into localStorage,
 * so every refresh replayed an older token over the fresh one until the
 * replayed token's `exp` passed and the user was signed out. The server half of
 * the fix makes `/api/*` uncacheable; this is the client half, and it must hold
 * even if a stale response arrives by some other route — a proxy, a service
 * worker, a shared cache, or a `page.route` replay.
 *
 * Four header values are offered against one held token: an OLDER one, a
 * SAME-INSTANT one, an UNPARSEABLE one and a strictly NEWER one. Only the last
 * may change the stored token. The positive control then proves ordinary renewal
 * still works: the newer token is both stored and announced to the session
 * listeners, so the fix cannot pass by simply refusing every renewal.
 *
 * IS_PLATFORM is resolved at module scope from a build-time flag and decides
 * whether the app authenticates with a bearer token at all, so each test loads a
 * fresh copy of api.ts with the flag stubbed — the same technique, and the same
 * reason, as authenticatedFetch.test.ts.
 */

const loadFetch = async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  return (await import('@/shared/api')).authenticatedFetch;
};

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A well-formed token minted at `issuedAtSeconds`, signed with `signature`. */
const tokenIssuedAt = (issuedAtSeconds: number, signature: string): string =>
  [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ iat: issuedAtSeconds, exp: issuedAtSeconds + 7 * 24 * 60 * 60 }),
    signature,
  ].join('.');

// The held token and its mint instant are fixed once, so every offered value can
// be ordered against it without depending on how long the test itself takes.
const HELD_ISSUED_AT = Math.floor(Date.now() / 1000);
const HELD_TOKEN = tokenIssuedAt(HELD_ISSUED_AT, 'held');

const respondWith = (headers: Record<string, string>): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers })),
  );
};

const storedToken = (): string | null => localStorage.getItem('auth-token');

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  // The discard reading is console output by design; keep the runner quiet and
  // inspect it through the spy instead of letting it read as test noise.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('only a strictly newer refreshed token replaces the stored one', async () => {
  const fetch = await loadFetch();

  const rejected = [
    { label: 'older', value: tokenIssuedAt(HELD_ISSUED_AT - 3600, 'older') },
    { label: 'same-instant', value: tokenIssuedAt(HELD_ISSUED_AT, 'same') },
    { label: 'unparseable', value: 'not-a-jwt' },
  ];

  for (const { label, value } of rejected) {
    localStorage.setItem('auth-token', HELD_TOKEN);
    respondWith({ 'X-Refreshed-Token': value });

    await fetch('/api/projects');

    assert.equal(storedToken(), HELD_TOKEN, `a ${label} refreshed token must not be stored`);
  }

  const newer = tokenIssuedAt(HELD_ISSUED_AT + 3600, 'newer');
  localStorage.setItem('auth-token', HELD_TOKEN);
  respondWith({ 'X-Refreshed-Token': newer });

  await fetch('/api/projects');

  assert.equal(storedToken(), newer, 'a strictly newer refreshed token must be stored');
});

test('a newer refreshed token is stored and announced to the session listeners', async () => {
  const fetch = await loadFetch();
  localStorage.setItem('auth-token', HELD_TOKEN);
  const newer = tokenIssuedAt(HELD_ISSUED_AT + 60, 'newer');

  let announced: string | null = null;
  const onRefresh = (event: Event) => {
    announced = (event as CustomEvent<string>).detail;
  };
  window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, onRefresh);
  respondWith({ 'X-Refreshed-Token': newer });

  await fetch('/api/projects');

  window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, onRefresh);
  assert.equal(storedToken(), newer);
  assert.equal(announced, newer, 'the renewal must still reach the auth context');
});

test('a discarded renewal leaves an observable reading, and the reading carries no credential', async () => {
  const fetch = await loadFetch();
  localStorage.setItem('auth-token', HELD_TOKEN);
  const older = tokenIssuedAt(HELD_ISSUED_AT - 60, 'older');
  respondWith({ 'X-Refreshed-Token': older });

  await fetch('/api/projects');

  const reading = warnSpy.mock.calls
    .map((call) => String(call[0]))
    .find((line) => line.includes('discarded X-Refreshed-Token'));
  assert.ok(reading, `expected a discard reading, saw: ${JSON.stringify(warnSpy.mock.calls)}`);
  assert.match(reading ?? '', /older/);
  assert.equal(reading?.includes(older), false, 'the reading must not echo the token');
});

test('a renewal with nothing held is adopted, because there is nothing to roll back', async () => {
  const fetch = await loadFetch();
  // No baseline is held, so no ordering can be violated: this is the ordinary
  // "another tab established the session" path, and it must keep working.
  const incoming = tokenIssuedAt(HELD_ISSUED_AT - 3600, 'incoming');
  respondWith({ 'X-Refreshed-Token': incoming });

  await fetch('/api/projects');

  assert.equal(storedToken(), incoming);
});
