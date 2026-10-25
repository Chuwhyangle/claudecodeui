/**
 * AC3 — the observation module's three HTTP endpoints.
 *
 * The criterion drives the REAL router over a REAL express server and the isolated database the
 * store test uses. Three readings:
 *   ① success paths: `GET /wall`, `POST /seen`, `PUT/DELETE /watch/:uri`;
 *   ② the authentication path: with no `req.user`, every route answers 401;
 *   ③ invalid URIs / revisions answer 400, and a `seen` write that moves the cursor BACKWARDS
 *      is ignored (the stored cursor stays at the higher revision).
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/observation-routes.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { formatSessionUri } from '../observation-uri.js';
import { createObservationRoutes } from '../observation.routes.js';
import { createObservationStore } from '../observation-store.js';

const USER_ID = '7';
const SESSION_URI = formatSessionUri('routes-session');

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;
let clock = 2_000_000;

const store = createObservationStore({ now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
});

test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

/** The process error middleware, reduced to what the module's `AppError`s need. */
function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = error instanceof AppError ? error.statusCode : 500;
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  res.status(status).json({ error: error instanceof Error ? error.message : 'error', code });
}

/** One express app around the real router; `authenticated` decides whether `req.user` exists. */
function createApp(authenticated: boolean, cockpitEnabled = true): Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      (req as Request & { user?: { id: string } }).user = { id: USER_ID };
      next();
    });
  }
  app.use(
    '/api/observation',
    createObservationRoutes(store, () => cockpitEnabled),
  );
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

function writeOneRevision() {
  clock += 1_000;
  return store.writeRevision({
    uri: SESSION_URI,
    kind: 'session',
    title: 'Routes session',
    status: { state: 'red', reason: 'tests failing' },
    digest: { turns: 4 },
    deltaItems: ['新增 2 轮'],
    provenance: { producer: 'session-digest', tier: 'deterministic' },
  });
}

test.beforeEach(() => {
  // The route tests share the file's database; start every case from empty tables.
  const db = getConnection();
  db.exec('DELETE FROM observed_revisions');
  db.exec('DELETE FROM observed_objects');
  db.exec('DELETE FROM observation_seen_cursors');
  db.exec('DELETE FROM observation_watch_entries');
  db.exec('DELETE FROM observation_producer_heartbeats');
  clock = 2_000_000;
});

test('AC3: the three endpoints answer on their success paths', async () => {
  const object = writeOneRevision();
  const { baseUrl, stop } = await listen(createApp(true));
  try {
    const wall = await fetch(`${baseUrl}/api/observation/wall`);
    assert.equal(wall.status, 200);
    const wallBody = (await wall.json()) as { entries: Array<{ object: { uri: string }; pinned: boolean }> };
    assert.deepEqual(wallBody.entries.map((entry) => entry.object.uri), [SESSION_URI]);
    assert.equal(wallBody.entries[0]!.pinned, false, 'an unpinned red object surfaces automatically');

    const pin = await fetch(`${baseUrl}/api/observation/watch/${encodeURIComponent(SESSION_URI)}`, { method: 'PUT' });
    assert.equal(pin.status, 200);
    const pinBody = (await pin.json()) as { watch: { uri: string } };
    assert.equal(pinBody.watch.uri, SESSION_URI);

    const pinnedWall = (await (await fetch(`${baseUrl}/api/observation/wall`)).json()) as {
      entries: Array<{ pinned: boolean; deltaItems: string[] }>;
    };
    assert.equal(pinnedWall.entries[0]!.pinned, true);
    assert.deepEqual(pinnedWall.entries[0]!.deltaItems, ['新增 2 轮']);

    const seen = await fetch(`${baseUrl}/api/observation/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: object.uri, revision: object.revision }),
    });
    assert.equal(seen.status, 200);
    const seenBody = (await seen.json()) as { advanced: boolean; cursor: { revision: number } };
    assert.equal(seenBody.advanced, true);
    assert.equal(seenBody.cursor.revision, object.revision);

    const clearedWall = (await (await fetch(`${baseUrl}/api/observation/wall`)).json()) as {
      entries: Array<{ deltaItems: string[] }>;
    };
    assert.deepEqual(clearedWall.entries[0]!.deltaItems, []);

    const unpin = await fetch(`${baseUrl}/api/observation/watch/${encodeURIComponent(SESSION_URI)}`, { method: 'DELETE' });
    assert.equal(unpin.status, 200);
    assert.deepEqual(await unpin.json(), { removed: true });
  } finally {
    await stop();
  }
});

test('AC3: every endpoint answers 401 without an authenticated user', async () => {
  const object = writeOneRevision();
  const { baseUrl, stop } = await listen(createApp(false));
  try {
    const encoded = encodeURIComponent(object.uri);
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/observation/wall`),
      fetch(`${baseUrl}/api/observation/seen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri: object.uri, revision: 1 }),
      }),
      fetch(`${baseUrl}/api/observation/watch/${encoded}`, { method: 'PUT' }),
      fetch(`${baseUrl}/api/observation/watch/${encoded}`, { method: 'DELETE' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401]);
  } finally {
    await stop();
  }
});

test('AC3: an invalid URI or revision is a 400, not a stored object', async () => {
  const { baseUrl, stop } = await listen(createApp(true));
  try {
    const badWatch = await fetch(`${baseUrl}/api/observation/watch/${encodeURIComponent('not-a-uri')}`, { method: 'PUT' });
    assert.equal(badWatch.status, 400);

    const badSeenUri = await fetch(`${baseUrl}/api/observation/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: 'cloudcli://session', revision: 1 }),
    });
    assert.equal(badSeenUri.status, 400);

    const badRevision = await fetch(`${baseUrl}/api/observation/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: SESSION_URI, revision: 0 }),
    });
    assert.equal(badRevision.status, 400);

    const wall = (await (await fetch(`${baseUrl}/api/observation/wall`)).json()) as { entries: unknown[] };
    assert.deepEqual(wall.entries, [], 'a refused write must not have created an object');
  } finally {
    await stop();
  }
});

test('AC3: a seen write that would move the cursor backwards is ignored', async () => {
  writeOneRevision();
  writeOneRevision();
  const head = writeOneRevision();
  const { baseUrl, stop } = await listen(createApp(true));
  try {
    const first = await fetch(`${baseUrl}/api/observation/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: head.uri, revision: head.revision }),
    });
    assert.equal(first.status, 200);

    const backwards = await fetch(`${baseUrl}/api/observation/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: head.uri, revision: 1 }),
    });
    assert.equal(backwards.status, 200);
    const body = (await backwards.json()) as { advanced: boolean; cursor: { revision: number } };
    assert.equal(body.advanced, false);
    assert.equal(body.cursor.revision, head.revision, 'the stored cursor stays at the higher revision');
  } finally {
    await stop();
  }
});

test('AC-cockpit: with the switch off every wall endpoint is 404, including the pin writes', async () => {
  writeOneRevision();
  const { baseUrl, stop } = await listen(createApp(true, false));
  try {
    const wall = await fetch(`${baseUrl}/api/observation/wall`);
    assert.equal(wall.status, 404);

    const pin = await fetch(`${baseUrl}/api/observation/watch/${encodeURIComponent(SESSION_URI)}`, { method: 'PUT' });
    assert.equal(pin.status, 404);

    const seen = await fetch(`${baseUrl}/api/observation/seen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: SESSION_URI, revision: 1 }),
    });
    assert.equal(seen.status, 404);
  } finally {
    await stop();
  }
});
