/**
 * AC2 — the local view-event log (`observation-p0-view-instrumentation-and-weekly-report`).
 *
 * The criterion drives the REAL route over a REAL express server and the real append path:
 *   ① a valid batch is appended to the configured JSONL path and every line parses as JSON;
 *   ② a batch over the ceiling is refused whole (413) and writes nothing;
 *   ③ invalid fields are refused (400), naming the offending event;
 *   ④ with the switch off the route answers 204 and nothing is written;
 *   ⑤ without a user the route answers 401.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/view-events.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';

import { AppError } from '@/shared/utils.js';

import { createViewEventRoutes } from '../view-events.routes.js';
import {
  createViewEventService,
  MAX_VIEW_EVENTS_PER_BATCH,
  type ViewEventsSettings,
} from '../view-events.service.js';

const USER_ID = '7';
const DEVICE_ID = 'device-criterion';

let temporaryDirectory = '';
let eventPath = '';

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'view-events-'));
  eventPath = path.join(temporaryDirectory, 'state', 'ui-view-events.jsonl');
});

test.after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

/** The process error middleware, reduced to what the module's `AppError`s need. */
function errorHandler(error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction): void {
  const status = error instanceof AppError ? error.statusCode : 500;
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  res.status(status).json({ error: error instanceof Error ? error.message : 'error', code });
}

/** One express app around the real router; `authenticated` decides whether `req.user` exists. */
function createApp(settings: ViewEventsSettings, authenticated = true): Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      (req as Request & { user?: { id: string } }).user = { id: USER_ID };
      next();
    });
  }
  app.use('/api/observation', createViewEventRoutes(createViewEventService(settings)));
  app.use(errorHandler);
  return app;
}

/** Starts one app on an ephemeral port and returns its base URL plus a stop function. */
async function listen(app: Express): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

/** One episode as the browser reports it. */
function episode(target: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: 1_800_000_000_000,
    kind: 'session',
    target,
    fromTarget: null,
    dwellMs: 1_500,
    deviceId: DEVICE_ID,
    ...overrides,
  };
}

async function postBatch(baseUrl: string, events: unknown[]) {
  return fetch(`${baseUrl}/api/observation/view-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

/** Reads the log back as parsed lines, or [] when the file was never created. */
async function readLog(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(eventPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

test('AC2: a valid batch is appended to the configured path, one JSON object per line', async () => {
  const { baseUrl, stop } = await listen(createApp({ enabled: true, path: eventPath }));
  try {
    const events = [episode('session-a'), episode('quay', { kind: 'tab', fromTarget: 'session-a', dwellMs: 900 })];
    const response = await postBatch(baseUrl, events);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '', '204 carries no body');

    const lines = await readLog();
    assert.deepEqual(lines, [
      {
        at: 1_800_000_000_000,
        kind: 'session',
        target: 'session-a',
        fromTarget: null,
        dwellMs: 1_500,
        deviceId: DEVICE_ID,
      },
      {
        at: 1_800_000_000_000,
        kind: 'tab',
        target: 'quay',
        fromTarget: 'session-a',
        dwellMs: 900,
        deviceId: DEVICE_ID,
      },
    ]);
    // The parent directory is created on demand rather than required to exist at boot.
    assert.ok((await stat(path.dirname(eventPath))).isDirectory());
  } finally {
    await stop();
  }
});

test('AC2: a batch over the ceiling is refused whole and appends nothing', async () => {
  const { baseUrl, stop } = await listen(createApp({ enabled: true, path: eventPath }));
  const before = await readLog();
  try {
    const oversized = Array.from({ length: MAX_VIEW_EVENTS_PER_BATCH + 1 }, (_value, index) => episode(`session-${index}`));
    const response = await postBatch(baseUrl, oversized);
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'BATCH_TOO_LARGE');
    assert.deepEqual(await readLog(), before, 'an oversized batch must not write a prefix');
  } finally {
    await stop();
  }
});

test('AC2: invalid fields are refused with 400 and append nothing', async () => {
  const { baseUrl, stop } = await listen(createApp({ enabled: true, path: eventPath }));
  const before = await readLog();
  try {
    const cases: Array<{ label: string; event: Record<string, unknown> }> = [
      { label: 'kind', event: episode('session-a', { kind: 'conversation' }) },
      { label: 'at', event: episode('session-a', { at: 'yesterday' }) },
      { label: 'target', event: episode('') },
      { label: 'dwellMs', event: episode('session-a', { dwellMs: -1 }) },
      { label: 'deviceId', event: episode('session-a', { deviceId: 42 }) },
    ];
    for (const { label, event } of cases) {
      const response = await postBatch(baseUrl, [event]);
      assert.equal(response.status, 400, `${label} must be refused`);
      const body = (await response.json()) as { error: string; code: string };
      assert.equal(body.code, 'INVALID_REQUEST');
      assert.match(body.error, new RegExp(`events\\[0\\]\\.${label}`), `the refusal must name ${label}`);
    }
    // A body without an events array is a shape error, not a silent no-op.
    const noArray = await fetch(`${baseUrl}/api/observation/view-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: [] }),
    });
    assert.equal(noArray.status, 400);
    assert.deepEqual(await readLog(), before, 'no rejected request may append a line');
  } finally {
    await stop();
  }
});

test('AC2: with the switch off the route answers 204 and writes nothing', async () => {
  const disabledPath = path.join(temporaryDirectory, 'disabled', 'ui-view-events.jsonl');
  const { baseUrl, stop } = await listen(createApp({ enabled: false, path: disabledPath }));
  try {
    const response = await postBatch(baseUrl, [episode('session-a')]);
    assert.equal(response.status, 204);
    await assert.rejects(readFile(disabledPath, 'utf8'), /ENOENT/, 'the disabled log must never be created');
  } finally {
    await stop();
  }
});

test('AC2: the route answers 401 without a user', async () => {
  const { baseUrl, stop } = await listen(createApp({ enabled: true, path: eventPath }, false));
  try {
    const response = await postBatch(baseUrl, [episode('session-a')]);
    assert.equal(response.status, 401);
  } finally {
    await stop();
  }
});
