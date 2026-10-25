// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const CACHE_PREFIX = 'claude-ui-';
// Bumped from v2 so activating this worker drops the unbounded v2 asset cache once.
const CACHE_NAME = 'claude-ui-v3';
const urlsToCache = [
  '/manifest.json'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const request = event.request;

  // Only requests this worker can actually answer belong here. A request it can never serve
  // from its cache — a non-GET method, another origin, a scheme that is not http(s) — has
  // nothing to gain from the detour, and `respondWith` rewrites its network failure into a
  // generic `net::ERR_FAILED` plus an "Uncaught (in promise)" line attributed to this file,
  // hiding the precise diagnosis the browser would have reported (ERR_NAME_NOT_RESOLVED and
  // friends). Returning without calling `respondWith` leaves the request on the browser's own
  // path, so its failure is reported as it happened. Cross-origin is also where the API
  // requests live (the GitHub release/star reads), and those are never in this cache.
  if (request.method !== 'GET') {
    return;
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept API requests or WebSocket upgrades
  const { pathname } = url;
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/ws') {
    return;
  }

  // Never intercept the OAuth consent flow or the MCP endpoint. They are server-rendered
  // pages and JSON-RPC, not part of the app shell, and a consent form's 302 chain ends on
  // another origin: routing that navigation through this worker added nothing and left an
  // unhandled "Failed to convert value to 'Response'" behind when the chain was cut short.
  if (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/') || pathname === '/mcp') {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching, and never a stand-in page.
  // A rejecting `respondWith` IS the browser's own network-error path; answering a failed
  // navigation with a worker-authored document here turned one transient unreachable moment (the
  // server restarting and cutting an in-flight request) into a page that declared itself
  // unreachable, when the page's own retry is what should recover it. So the failure is passed
  // straight through to the browser instead of being replaced.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          // Only cache real successes. This branch is cache-first, so a transient
          // failure (e.g. the dev server writing dist/ mid-rebuild) would otherwise
          // be pinned for that URL until the cache is purged.
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — network-first.
  // On a network failure, serve the cached copy when there is one; otherwise rethrow the real
  // network error so `respondWith` rejects and the browser reports the truth. Fabricating a
  // synthetic error response here would rewrite one transient failure as an application-level
  // error and hide it from the page's own retry.
  event.respondWith(
    fetch(event.request).catch(error =>
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        throw error;
      })
    )
  );
});

// Activate event — purge this worker's own old caches, and only those.
// The origin also holds the on-device speech model (`voice-client-asr-model-v1`, ~239 MB,
// 8–10 minutes to download), which this worker has no business deleting: a blanket
// "every name except CACHE_NAME" purge wiped it on every worker update.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
