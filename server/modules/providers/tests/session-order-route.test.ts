import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { connectedClients } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(run: (baseUrl: string, workspacePath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-order-route-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const reorder = (baseUrl: string, projectId: string, body: unknown) =>
  fetch(`${baseUrl}/api/providers/projects/${projectId}/session-order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The page order the project listing reads. Read through the repository rather
 * than `/api/projects`: this test server mounts the providers router only, and
 * the ordering rule under test lives in this SQL.
 */
const listedOrder = (projectPath: string): string[] =>
  (sessionsDb.getSessionsByProjectPathPage(projectPath, 50, 0) as Array<{ session_id: string }>)
    .map((row) => row.session_id);

const storedOrder = (projectPath: string): Array<{ id: string; order: number | null }> =>
  (sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as Array<{ session_id: string; session_order?: number | null }>)
    .map((row) => ({ id: row.session_id, order: row.session_order ?? null }))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

const projectIdFor = (projectPath: string): string => {
  const project = projectsDb.getProjectPath(projectPath);
  assert.ok(project, 'the session fixture must have created its project row');
  return project.project_id;
};

test('a dropped order is stored and becomes the listing order', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    for (const id of ['order-a', 'order-b', 'order-c']) {
      sessionsDb.createSession(id, 'claude', workspacePath, id);
    }
    const projectId = projectIdFor(workspacePath);

    const response = await reorder(baseUrl, projectId, { sessionIds: ['order-c', 'order-a', 'order-b'] });

    assert.equal(response.status, 200);
    const payload = await response.json() as { data: { projectId: string; sessionIds: string[] } };
    assert.deepEqual(payload.data.sessionIds, ['order-c', 'order-a', 'order-b']);
    assert.deepEqual(
      storedOrder(workspacePath).map((row) => row.id),
      ['order-c', 'order-a', 'order-b'],
      'every row must be numbered in the order the drop produced',
    );
    assert.deepEqual(listedOrder(workspacePath), ['order-c', 'order-a', 'order-b']);
  });
});

test('a session the project does not own is ignored rather than moved in', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const otherWorkspace = path.join(workspacePath, 'other');
    sessionsDb.createSession('mine-1', 'claude', workspacePath, 'mine');
    sessionsDb.createSession('theirs-1', 'claude', otherWorkspace, 'theirs');
    const projectId = projectIdFor(workspacePath);

    const response = await reorder(baseUrl, projectId, { sessionIds: ['theirs-1', 'mine-1'] });

    assert.equal(response.status, 200);
    assert.deepEqual(
      storedOrder(workspacePath).map((row) => row.id),
      ['mine-1'],
      'the other project\'s session must keep its position',
    );
    assert.deepEqual(
      (sessionsDb.getSessionsByProjectPathIncludingArchived(otherWorkspace) as Array<{ session_order?: number | null }>)
        .map((row) => row.session_order ?? null),
      [null],
      'a foreign id must not be written at all',
    );
  });
});

test('a malformed order is rejected without touching the stored one', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createSession('order-x', 'claude', workspacePath, 'x');
    const projectId = projectIdFor(workspacePath);

    for (const body of [
      {},
      { sessionIds: [] },
      { sessionIds: 'order-x' },
      { sessionIds: [1, 2] },
      { sessionIds: ['order-x', 'order-x'] },
    ]) {
      const response = await reorder(baseUrl, projectId, body);
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
      const payload = await response.json() as { error: { code: string } };
      assert.equal(payload.error.code, 'INVALID_SESSION_ORDER');
    }

    assert.deepEqual(
      (sessionsDb.getSessionsByProjectPathIncludingArchived(workspacePath) as Array<{ session_order?: number | null }>)
        .map((row) => row.session_order ?? null),
      [null],
    );
  });
});

test('an unknown project is a 404 and writes nothing', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createSession('order-orphan', 'claude', workspacePath, 'orphan');

    const response = await reorder(baseUrl, 'no-such-project', { sessionIds: ['order-orphan'] });

    assert.equal(response.status, 404);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'PROJECT_NOT_FOUND');
    assert.deepEqual(
      (sessionsDb.getSessionsByProjectPathIncludingArchived(workspacePath) as Array<{ session_order?: number | null }>)
        .map((row) => row.session_order ?? null),
      [null],
    );
  });
});
