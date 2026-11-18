/**
 * The diagnostics log-window HTTP criterion.
 *
 * Mounts the real module on a real Express app: without a credential both log
 * routes are refused; `limit` is clamped (9999 → 500, 0 → 1); `since` accepts
 * ISO-8601 and epoch milliseconds and rejects anything else with 400; an unknown
 * `source` matches nothing rather than being opened as a path; and the source
 * roster's counts/lastAt are the ring's own readings. The last leg proves a
 * path-shaped parameter is ignored, not interpreted.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/diagnostics/tests/diagnostics-logs.test.ts
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

type Harness = { baseUrl: string };

function provider() {
  return {
    id: 'reply-suggestions',
    label: 'Reply suggestions',
    read: () => ({
      state: 'ready' as const,
      enabled: true,
      problems: [],
      lastSuccessAt: null,
      lastFailure: null,
      failures: [],
      configSource: 'file:/tmp/settings.json',
    }),
  };
}

async function start(
  t: { after(callback: () => void | Promise<void>): void },
  ring: LogRing,
  options: { auth?: 'real' | 'none' } = {},
): Promise<Harness> {
  const app = express();
  const guard = options.auth === 'real'
    ? authenticateToken
    : (_request: express.Request, _response: express.Response, next: express.NextFunction) => next();
  app.use('/api/diagnostics', guard, createDiagnosticsModule({
    providers: [provider()],
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
  return { baseUrl: `http://127.0.0.1:${port}` };
}

function seed(ring: LogRing, count: number): void {
  for (let index = 0; index < count; index += 1) {
    ring.append({
      at: new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + index * 1000).toISOString(),
      level: index % 3 === 0 ? 'error' : 'info',
      source: index % 2 === 0 ? 'reply-suggestions' : 'server',
      text: `[reply-suggestions] requestId=req-${String(index).padStart(4, '0')} httpStatus=${index % 3 === 0 ? 502 : 200}`,
    });
  }
}

test('AC2-a: without a token both log routes are refused', async (t) => {
  const { baseUrl } = await start(t, createLogRing(), { auth: 'real' });
  for (const route of ['/api/diagnostics/logs', '/api/diagnostics/logs/sources']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.ok([401, 403].includes(response.status), `${route} must refuse an unauthenticated caller, got ${response.status}`);
  }
});

test('AC2-b: limit is clamped to [1, 500]', async (t) => {
  const ring = createLogRing({ maxLines: 1000 });
  seed(ring, 800);
  const { baseUrl } = await start(t, ring);

  const huge = await fetch(`${baseUrl}/api/diagnostics/logs?limit=9999`);
  const hugeBody = await huge.json() as { lines: Array<{ text: string }> };
  assert.equal(huge.status, 200);
  assert.equal(hugeBody.lines.length, 500, '9999 is clamped to the 500 ceiling');
  assert.match(hugeBody.lines[hugeBody.lines.length - 1]?.text ?? '', /req-0799/, 'the newest line is kept');

  const zero = await fetch(`${baseUrl}/api/diagnostics/logs?limit=0`);
  const zeroBody = await zero.json() as { lines: Array<{ text: string }> };
  assert.equal(zeroBody.lines.length, 1, '0 is raised to 1');
  assert.match(zeroBody.lines[0]?.text ?? '', /req-0799/);
});

test('AC2-c: filters are exact, and an unknown source returns an empty set', async (t) => {
  const ring = createLogRing();
  seed(ring, 6);
  const { baseUrl } = await start(t, ring);

  const reply = await (await fetch(`${baseUrl}/api/diagnostics/logs?source=reply-suggestions`)).json() as {
    lines: Array<{ source: string }>;
  };
  assert.ok(reply.lines.length > 0);
  assert.ok(reply.lines.every((line) => line.source === 'reply-suggestions'));

  const errors = await (await fetch(`${baseUrl}/api/diagnostics/logs?level=error`)).json() as {
    lines: Array<{ level: string }>;
  };
  assert.ok(errors.lines.length > 0);
  assert.ok(errors.lines.every((line) => line.level === 'error'));

  const unknown = await fetch(`${baseUrl}/api/diagnostics/logs?source=../../etc/passwd`);
  const unknownBody = await unknown.json() as { lines: unknown[] };
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknownBody.lines, [], 'an unknown source matches nothing and opens no path');

  const badLevel = await fetch(`${baseUrl}/api/diagnostics/logs?level=debug`);
  assert.equal(badLevel.status, 400, 'a level outside info/warn/error is a 400');
});

test('AC2-d: since accepts ISO-8601 and epoch ms and rejects garbage with 400', async (t) => {
  const ring = createLogRing();
  seed(ring, 10);
  const { baseUrl } = await start(t, ring);

  const iso = await (await fetch(`${baseUrl}/api/diagnostics/logs?since=2026-11-18T10:00:07.000Z`)).json() as {
    lines: Array<{ at: string }>;
  };
  assert.equal(iso.lines[0]?.at, '2026-11-18T10:00:07.000Z');
  assert.equal(iso.lines.length, 3);

  const merged = Date.parse('2026-11-18T10:00:07.000Z');
  const epoch = await (await fetch(`${baseUrl}/api/diagnostics/logs?since=${merged}`)).json() as {
    lines: Array<{ at: string }>;
  };
  assert.deepEqual(epoch.lines, iso.lines, 'epoch ms and ISO name the same instant');

  const bad = await fetch(`${baseUrl}/api/diagnostics/logs?since=not-a-date`);
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'INVALID_LOG_SINCE');
});

test('AC2-e: /logs/sources counts and lastAt are the ring readings', async (t) => {
  const ring = createLogRing();
  seed(ring, 6);
  const { baseUrl } = await start(t, ring);

  const body = await (await fetch(`${baseUrl}/api/diagnostics/logs/sources`)).json() as {
    sources: Array<{ id: string; label: string; count: number; lastAt: string | null }>;
  };
  const ringStats = ring.stats();
  for (const id of ['server', 'reply-suggestions', 'sessions', 'voice', 'other']) {
    const source = body.sources.find((entry) => entry.id === id);
    assert.ok(source, `the roster must name ${id}`);
    const reading = ringStats.sources.find((entry) => entry.id === id);
    assert.equal(source.count, reading?.count ?? 0, `${id} count`);
    assert.equal(source.lastAt, reading?.lastAt ?? null, `${id} lastAt`);
    assert.ok(source.label.length > 0);
  }
  assert.ok(body.sources.length >= 5);
});

test('AC2-f: a path-shaped parameter is ignored, not read', async (t) => {
  const ring = createLogRing();
  seed(ring, 3);
  const { baseUrl } = await start(t, ring);

  const plain = await (await fetch(`${baseUrl}/api/diagnostics/logs`)).json();
  const withPath = await (await fetch(`${baseUrl}/api/diagnostics/logs?path=/etc/passwd&file=shadow`)).json();
  assert.deepEqual(withPath, plain, 'unknown parameters have no effect');
  assert.equal(((plain as { lines: unknown[] }).lines).length, 3);
});

test('AC2-g: the window caps are published and truncated is honest', async (t) => {
  const ring = createLogRing({ maxLines: 2, maxBytes: 4096 });
  seed(ring, 4);
  const { baseUrl } = await start(t, ring);
  const body = await (await fetch(`${baseUrl}/api/diagnostics/logs`)).json() as {
    lines: unknown[];
    truncated: boolean;
    window: { maxLines: number; maxBytes: number };
  };
  assert.equal(body.lines.length, 2);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.window, { maxLines: 2, maxBytes: 4096 });
});
