import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Which URL each session-hosts read puts on the wire.
 *
 * The full listing carries one row per stored session — thousands on a long-lived
 * install — and every open tab re-reads it on every `hosts_changed` frame, so the
 * request's *shape* is the cost: the store must ask for the active rows only, and
 * a caller that wants one session's mode must ask for that one session. A test of
 * the URL is the right grain because the payload is the server's, pinned by its
 * own criterion; what the browser controls is only which question it asks.
 */

let requestedUrls: string[] = [];

const loadApi = async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'true');
  vi.resetModules();
  return (await import('@/shared/api')).api;
};

beforeEach(() => {
  requestedUrls = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({ success: true, data: { hosts: [], sessions: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('the store\'s listing read asks for the active rows only', async () => {
  const api = await loadApi();
  await api.sessionHosts.list();
  assert.deepEqual(requestedUrls, ['/api/session-hosts?scope=active']);
});

test('one session\'s state is read by id, not out of the whole listing', async () => {
  const api = await loadApi();
  await api.sessionHostState('0b1c2d3e-aaaa-bbbb-cccc-000000000001');
  assert.deepEqual(requestedUrls, ['/api/session-hosts/0b1c2d3e-aaaa-bbbb-cccc-000000000001']);
});

test('a session id is path-escaped, so it cannot address another route', async () => {
  const api = await loadApi();
  await api.sessionHostState('a/../b c');
  assert.deepEqual(requestedUrls, ['/api/session-hosts/a%2F..%2Fb%20c']);
});
