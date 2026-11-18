/**
 * The log-window redaction criterion.
 *
 * Redaction is the property that makes an in-process log window safe to expose:
 * a secret printed by a feature must never reach the browser. This puts a line
 * carrying every fixture family (`sk-`, `LITELLM_API_KEY=`, `Authorization:
 * Bearer`, `x-api-key`, `apiKey`, `client_secret`) into the ring and reads the
 * HTTP answer back. It also carries a NEGATIVE CONTROL: the same fixtures through
 * a ring built with an identity redactor DO leak, which is what proves the
 * assertions below are load-bearing rather than vacuous.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/diagnostics/tests/diagnostics-log-redaction.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { authenticateToken } from '@/modules/auth/index.js';
import { createLogRing, type LogRing } from '@/shared/log-ring.js';
import { AppError } from '@/shared/utils.js';

import { createDiagnosticsModule } from '../diagnostics.module.js';

const SECRETS = [
  'sk-test-secret',
  'LITELLM_API_KEY=sk-live-abcdefgh',
  'Authorization: Bearer abc.def-ghi_jkl',
  'x-api-key: xyz123',
  'apiKey: my-api-secret',
  'client_secret=topsecret',
];

const SECRET_TOKENS = [
  'sk-test-secret',
  'sk-live-abcdefgh',
  'abc.def-ghi_jkl',
  'xyz123',
  'my-api-secret',
  'topsecret',
];

async function start(
  t: { after(callback: () => void | Promise<void>): void },
  ring: LogRing,
  options: { auth?: 'real' | 'none' } = {},
): Promise<string> {
  const app = express();
  const guard = options.auth === 'real'
    ? authenticateToken
    : (_request: express.Request, _response: express.Response, next: express.NextFunction) => next();
  app.use('/api/diagnostics', guard, createDiagnosticsModule({
    providers: [],
    logRing: ring,
    meta: () => ({
      version: '1.2.3',
      installForm: 'git',
      platform: 'linux',
      settingsSource: 'file',
      settingsPath: '/tmp/settings.json',
    }),
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
  return `http://127.0.0.1:${port}`;
}

function fill(ring: LogRing): void {
  for (const secret of SECRETS) {
    ring.append({ level: 'error', source: 'reply-suggestions', text: `[reply-suggestions] upstream failed ${secret}` });
  }
}

/** True when every fixture token is absent from `text`. */
function clean(text: string): boolean {
  return SECRET_TOKENS.every((token) => !text.includes(token));
}

test('AC3-a: the API answer carries no fixture secret and shows [redacted] for each', async (t) => {
  const ring = createLogRing();
  fill(ring);
  const baseUrl = await start(t, ring);

  const response = await fetch(`${baseUrl}/api/diagnostics/logs?limit=100`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(clean(text), `the API answer leaked a secret:\n${text}`);
  assert.equal((text.match(/\[redacted\]/g) ?? []).length, SECRETS.length, 'each fixture is replaced');

  const direct = ring.read({ limit: 100 }).map((line) => line.text).join('\n');
  assert.ok(clean(direct), `the stored window leaked a secret:\n${direct}`);
});

test('AC3-b: the same route stays behind the token guard', async (t) => {
  const ring = createLogRing();
  fill(ring);
  const baseUrl = await start(t, ring, { auth: 'real' });
  const response = await fetch(`${baseUrl}/api/diagnostics/logs`);
  assert.ok([401, 403].includes(response.status), 'the route stays behind the token guard');
});

test('AC3-c negative control: an identity redactor leaks every fixture token', () => {
  const ring = createLogRing({ redact: (text) => text });
  fill(ring);
  const leaked = ring.read({ limit: 100 }).map((line) => line.text).join('\n');
  for (const token of SECRET_TOKENS) {
    assert.ok(leaked.includes(token), `the identity-redactor control must leak ${token}`);
  }
  assert.equal((leaked.match(/\[redacted\]/g) ?? []).length, 0);
});
