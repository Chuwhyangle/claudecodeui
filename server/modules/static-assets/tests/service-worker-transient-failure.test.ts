/**
 * Criterion — the service worker this server ships must not answer a transient fetch failure with a
 * response of its own. `public/sw.js` is served from `publicDir` by this module, and it used to
 * resolve a failed navigation with a worker-authored HTML page and every other failed request with
 * `Response.error()`. One transient origin outage (the server restarting and cutting an in-flight
 * request) then read to the user as "the app says it cannot be reached" and only a manual refresh
 * recovered it, because the page's own retry never saw the real failure.
 *
 * The worker is a classic script with no imports, so it is loaded verbatim into a `node:vm` context
 * whose `self` and `caches` are fakes and whose `fetch` is chosen per reading. Each reading fires
 * the captured `fetch` listener with a real FetchEvent shape and settles the promise handed to
 * `respondWith`:
 *
 *   (1) a failed NAVIGATION fetch settles REJECTED — the real network error passes through;
 *   (2) the discriminating control: a worker that keeps the fallback resolves with the
 *       worker-authored HTML, so (1)'s reading cannot pass because the harness rejects everything;
 *   (3) a failed NON-navigation fetch with no cache entry settles REJECTED, not `Response.error()`;
 *   (4) a failed NON-navigation fetch WITH a cache entry still serves that entry — the network-first
 *       fallback was narrowed, not removed;
 *   (5) a CROSS-ORIGIN request never reaches `respondWith` — the worker cannot serve it from its
 *       cache and intercepting it only rewrites the browser's own error (ERR_NAME_NOT_RESOLVED
 *       becomes ERR_FAILED) and leaves an "Uncaught (in promise)" line behind;
 *   (6) a NON-GET request is left alone for the same reason. Reading (3) is the control for both:
 *       it requires `respondWith` on a same-origin GET, so an unconditional early return cannot
 *       pass this file.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SW_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');

/**
 * A representative of the forbidden shape: a navigation branch that answers a failed fetch with a
 * worker-authored page. The control reading loads this and requires the forbidden outcome, so a
 * reading that could only ever reject does not pass this file by accident. Kept as its own source
 * rather than a mutation of the shipped file so a future reformat of `sw.js` cannot red the control
 * — the shipped file is what reading (1) measures, this is the control that says the measurement
 * discriminates.
 */
const FALLBACK_WORKER_SOURCE = `
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() =>
      new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
        headers: { 'Content-Type': 'text/html' }
      })
    ));
    return;
  }
  event.respondWith(fetch(event.request));
});
`;

type RequestLike = { url: string; mode: string; method: string };
type FetchEventLike = {
  request: RequestLike;
  respondWith: (response: Promise<Response>) => void;
};

type Settled =
  | { status: 'fulfilled'; response: Response }
  | { status: 'rejected'; reason: unknown };

type Worker = {
  /** Fires the worker's fetch listener for one request and settles the respondWith promise. */
  respond: (request: RequestLike) => Promise<Settled>;
  /**
   * Fires the worker's fetch listener and reports whether it took the request at all.
   * The pass-through readings use this: a request the worker cannot serve must leave
   * `respondWith` uncalled so the browser handles it on its own network path.
   */
  handles: (request: RequestLike) => boolean;
  /** Replaces the network layer for the readings that follow. */
  setFetch: (impl: (request: unknown) => Promise<Response>) => void;
  /** Replaces the CacheStorage lookup for the readings that follow. */
  setCached: (response: Response | undefined) => void;
};

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function expectFulfilled(settled: Settled): Response {
  if (settled.status !== 'fulfilled') {
    assert.fail(`expected respondWith to resolve, but it rejected: ${reasonText(settled.reason)}`);
  }
  return settled.response;
}

function expectRejected(settled: Settled): unknown {
  if (settled.status !== 'rejected') {
    assert.fail('expected respondWith to reject, but it resolved with a response');
  }
  return settled.reason;
}

/**
 * Loads one copy of the worker source into a fresh vm context and captures its `fetch` listener.
 * Every copy gets its own globals, so two readings never share a cache stub or a network stub.
 */
function loadWorker(source: string): Worker {
  const listeners = new Map<string, (event: FetchEventLike) => void>();
  let fetchImpl: (request: unknown) => Promise<Response> = async () => {
    throw new Error('network unavailable');
  };
  let cachedResponse: Response | undefined;

  const context = createContext({
    self: {
      addEventListener: (type: string, handler: (event: FetchEventLike) => void) => {
        listeners.set(type, handler);
      },
      skipWaiting: () => {},
      clients: { matchAll: async () => [], openWindow: async () => undefined },
      registration: { showNotification: async () => undefined },
      location: { origin: 'https://app.example.test' },
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      match: async () => cachedResponse,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: (request: unknown) => fetchImpl(request),
    Response,
    Promise,
    URL,
  });
  runInContext(source, context);

  const fetchListener = listeners.get('fetch');
  assert.ok(fetchListener, 'the worker must register a fetch listener');

  return {
    setFetch: (impl) => {
      fetchImpl = impl;
    },
    setCached: (response) => {
      cachedResponse = response;
    },
    handles: (request) => {
      let responded = false;
      fetchListener({
        request,
        respondWith: (response) => {
          responded = true;
          // A worker that wrongly handles a pass-through request must still leave no
          // unhandled rejection behind for the runner to report.
          void response.catch(() => {});
        },
      });
      return responded;
    },
    respond: async (request) => {
      let responded: Promise<Response> | undefined;
      fetchListener({
        request,
        respondWith: (response) => {
          responded = response;
        },
      });
      const response = responded;
      assert.ok(response, 'the fetch listener must call respondWith for this request');
      try {
        return { status: 'fulfilled', response: await response };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    },
  };
}

const NAVIGATION: RequestLike = { url: 'https://app.example.test/session/2f0e', mode: 'navigate', method: 'GET' };
const PLAIN_GET: RequestLike = { url: 'https://app.example.test/data/board.json', mode: 'cors', method: 'GET' };
/** Same app-shaped path, another origin: the worker's cache can never answer it. */
const CROSS_ORIGIN_GET: RequestLike = { url: 'https://cdn.example.test/data/board.json', mode: 'cors', method: 'GET' };
/** Same-origin and not an API/asset path, so only the method decides its fate. */
const SAME_ORIGIN_POST: RequestLike = { url: 'https://app.example.test/data/board.json', mode: 'cors', method: 'POST' };

test('a transient navigation failure passes through instead of being replaced by a worker-authored page', async () => {
  const worker = loadWorker(SW_SOURCE);
  worker.setFetch(async () => {
    throw new Error('connection reset');
  });

  const settled = await worker.respond(NAVIGATION);
  const reason = expectRejected(settled);

  assert.match(
    reasonText(reason),
    /connection reset/,
    'the navigation branch must reject with the real network error, so the browser reports the truth',
  );
});

test('the navigation reading is not vacuous: a fallback worker resolves with the worker-authored page', async () => {
  const worker = loadWorker(FALLBACK_WORKER_SOURCE);
  worker.setFetch(async () => {
    throw new Error('connection reset');
  });

  const settled = await worker.respond(NAVIGATION);
  const response = expectFulfilled(settled);

  assert.match(
    await response.text(),
    /Offline/,
    'a failed navigation on a worker that keeps the fallback resolves with the worker-authored page, so reading (1) is measuring the pass-through and not an always-rejecting stub',
  );
});

test('a transient non-navigation failure with no cache entry rejects instead of resolving a synthetic error', async () => {
  const worker = loadWorker(SW_SOURCE);
  worker.setFetch(async () => {
    throw new Error('connection reset');
  });
  worker.setCached(undefined);

  const settled = await worker.respond(PLAIN_GET);
  const reason = expectRejected(settled);

  assert.match(
    reasonText(reason),
    /connection reset/,
    'a cache miss under a network failure must rethrow the real network error, not fabricate a response',
  );
});

test('a transient non-navigation failure still serves a cached entry when one exists', async () => {
  const cached = new Response('cached body', { status: 200 });
  const worker = loadWorker(SW_SOURCE);
  worker.setFetch(async () => {
    throw new Error('connection reset');
  });
  worker.setCached(cached);

  const settled = await worker.respond(PLAIN_GET);
  const response = expectFulfilled(settled);

  assert.equal(await response.text(), 'cached body', 'the network-first fallback must still serve a cached copy');
});

test('a cross-origin request is left to the browser instead of being answered by the worker', () => {
  const worker = loadWorker(SW_SOURCE);

  assert.equal(
    worker.handles(CROSS_ORIGIN_GET),
    false,
    'a request the worker can never serve from its cache must not be taken: taking it turns the browser\'s precise network failure into a generic ERR_FAILED and an uncaught rejection',
  );
});

test('a non-GET request is left to the browser instead of being answered by the worker', () => {
  const worker = loadWorker(SW_SOURCE);

  assert.equal(
    worker.handles(SAME_ORIGIN_POST),
    false,
    'a POST has no cache entry to fall back on, so the worker has nothing to add and must not take it',
  );
});
