/**
 * The diagnostics HTTP face criterion.
 *
 * Mounts the real `authenticateToken` in front of `createDiagnosticsModule` on a
 * real Express app, so the reading covers the auth posture the composition root
 * installs as well as the route's parsing: no credential is refused, `limit` is
 * clamped into `[1, 200]`, the bundle is `text/plain`, the JSON routes are
 * `application/json`, and no path/filename parameter reaches the service.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/diagnostics/tests/diagnostics-routes.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { authenticateToken } from '@/modules/auth/index.js';
import { AppError } from '@/shared/utils.js';

import { createDiagnosticsModule } from '../diagnostics.module.js';
import { readRecentFailuresLimit } from '../diagnostics.routes.js';
import type {
  DiagnosticsFailureRecord,
  DiagnosticsFeatureProvider,
  DiagnosticsFeatureReading,
} from '../diagnostics.service.js';

const SECRETS = 'sk-test-secret LITELLM_API_KEY=abc123 Authorization: Bearer eyJhbGciOi.xx-yy_zz';

function failure(index: number, overrides: Partial<DiagnosticsFailureRecord> = {}): DiagnosticsFailureRecord {
  return {
    at: new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + index * 1000).toISOString(),
    requestId: `req-${String(index).padStart(4, '0')}`,
    category: 'http',
    httpStatus: 502,
    durationMs: index,
    model: 'gateway-model',
    protocol: 'anthropic',
    ...overrides,
  };
}

function provider(overrides: Partial<DiagnosticsFeatureReading> = {}): DiagnosticsFeatureProvider {
  return {
    id: 'reply-suggestions',
    label: 'Reply suggestions',
    read: () => ({
      state: 'ready',
      enabled: true,
      problems: [],
      lastSuccessAt: null,
      lastFailure: null,
      failures: [],
      configSource: 'file:/tmp/settings.json',
      ...overrides,
    }),
  };
}

type Harness = { baseUrl: string };

/**
 * Mounts the module at `/api/diagnostics`. `auth: 'real'` puts the production
 * `authenticateToken` in front (the unauthenticated leg); the positive legs
 * leave it out, because a valid credential needs a database user this criterion
 * does not own, and the auth posture is measured on its own leg.
 */
async function start(
  t: { after(callback: () => void | Promise<void>): void },
  providers: DiagnosticsFeatureProvider[],
  options: { auth?: 'real' | 'none' } = {},
): Promise<Harness> {
  const app = express();
  const guard = options.auth === 'real' ? authenticateToken : (_request: express.Request, _response: express.Response, next: express.NextFunction) => next();
  app.use('/api/diagnostics', guard, createDiagnosticsModule({
    providers,
    meta: () => ({
      version: '1.2.3',
      installForm: 'git',
      platform: 'linux',
      settingsSource: 'file',
      settingsPath: '/tmp/settings.json',
    }),
    now: () => Date.parse('2026-11-18T12:00:00.000Z'),
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${port}` };
}

test('AC2-a: a request without a token is refused (401/403), and the token guard runs first', async (t) => {
  const { baseUrl } = await start(t, [provider()], { auth: 'real' });
  for (const route of ['/api/diagnostics/features', '/api/diagnostics/recent-failures', '/api/diagnostics/bundle']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.ok([401, 403].includes(response.status), `${route} must refuse an unauthenticated caller, got ${response.status}`);
  }
});

test('AC2-b: limit is clamped — 9999 to 200 and 0 to 1 — while the default keeps 50', async (t) => {
  const failures = Array.from({ length: 250 }, (_unused, index) => failure(index));
  const { baseUrl } = await start(t, [provider({ failures })]);

  const huge = await fetch(`${baseUrl}/api/diagnostics/recent-failures?limit=9999`);
  const hugeBody = await huge.json() as { failures: unknown[] };
  assert.equal(huge.status, 200);
  assert.equal(hugeBody.failures.length, 200, '9999 is clamped to the 200 ceiling');

  const zero = await fetch(`${baseUrl}/api/diagnostics/recent-failures?limit=0`);
  const zeroBody = await zero.json() as { failures: Array<{ requestId: string }> };
  assert.equal(zeroBody.failures.length, 1, '0 is raised to 1');
  assert.equal(zeroBody.failures[0]?.requestId, 'req-0249', 'the newest failure is the one kept');

  const eight = await fetch(`${baseUrl}/api/diagnostics/recent-failures?limit=8`);
  assert.equal(((await eight.json()) as { failures: unknown[] }).failures.length, 8);

  assert.equal(readRecentFailuresLimit('9999'), 200);
  assert.equal(readRecentFailuresLimit('0'), 1);
  assert.equal(readRecentFailuresLimit('-3'), 1);
  assert.equal(readRecentFailuresLimit('not-a-number'), 50);
  assert.equal(readRecentFailuresLimit(undefined), 50);
});

test('AC2-c: bundle is text/plain; the two JSON routes are application/json', async (t) => {
  const { baseUrl } = await start(t, [provider({ failures: [failure(1)] })]);

  const bundle = await fetch(`${baseUrl}/api/diagnostics/bundle`);
  assert.equal(bundle.status, 200);
  assert.ok((bundle.headers.get('content-type') ?? '').startsWith('text/plain'), 'the bundle is plain text');
  assert.ok((await bundle.text()).startsWith('Cloudpit diagnostics bundle'));

  const features = await fetch(`${baseUrl}/api/diagnostics/features`);
  assert.ok((features.headers.get('content-type') ?? '').startsWith('application/json'));
  assert.ok(Array.isArray(((await features.json()) as { features: unknown[] }).features));

  const recent = await fetch(`${baseUrl}/api/diagnostics/recent-failures`);
  assert.ok((recent.headers.get('content-type') ?? '').startsWith('application/json'));
  assert.ok(Array.isArray(((await recent.json()) as { failures: unknown[] }).failures));
});

test('AC2-d: there is no path/filename parameter — same answer with a hostile query, and an unknown route 404s', async (t) => {
  const { baseUrl } = await start(t, [provider()]);

  const plain = await (await fetch(`${baseUrl}/api/diagnostics/bundle`)).text();
  const hostile = await (await fetch(
    `${baseUrl}/api/diagnostics/bundle?path=/etc/passwd&file=../../etc/shadow&filename=secret`,
  )).text();
  assert.equal(hostile, plain, 'the bundle ignores path/filename parameters entirely');
  assert.ok(!hostile.includes('/etc/passwd'), 'a query path is never echoed into the bundle');
  assert.ok(!hostile.includes('/etc/shadow'));

  const missing = await fetch(`${baseUrl}/api/diagnostics/file?path=/etc/passwd`);
  assert.equal(missing.status, 404, 'there is no file-reading route');
});

test('AC3: the failures response is redacted server-side', async (t) => {
  const { baseUrl } = await start(t, [provider({
    problems: [SECRETS],
    lastFailure: failure(1, { model: 'sk-test-secret', protocol: 'openai' }),
    failures: [failure(1, { model: 'LITELLM_API_KEY=abc123' })],
  })]);

  const featuresText = await (await fetch(`${baseUrl}/api/diagnostics/features`)).text();
  const failuresText = await (await fetch(`${baseUrl}/api/diagnostics/recent-failures`)).text();
  const bundleText = await (await fetch(`${baseUrl}/api/diagnostics/bundle`)).text();

  for (const [label, text] of [['features', featuresText], ['failures', failuresText], ['bundle', bundleText]] as const) {
    assert.ok(!text.includes('sk-'), `${label} must not carry an sk- token`);
    assert.ok(!text.includes('LITELLM_API_KEY='), `${label} must not carry an API-key assignment`);
    assert.ok(!text.includes('Bearer '), `${label} must not carry a bearer header`);
    assert.ok(text.includes('[redacted]'), `${label} must show the redaction`);
  }
});
