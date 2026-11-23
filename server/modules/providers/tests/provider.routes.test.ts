import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionAwaitingReplyService } from '@/modules/providers/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

/**
 * Clears the off-browser alert command for the duration of `body`.
 *
 * Marking a session is exactly the event that spawns a desktop alert, and a
 * developer machine may export the notify command; a route test must exercise
 * the HTTP contract without raising a toast on somebody's workstation.
 */
async function withDesktopAlertsOff(body: () => Promise<void>): Promise<void> {
  const saved = {
    canonical: process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD,
    legacy: process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD,
  };
  delete process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD;
  delete process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD;
  try {
    await body();
  } finally {
    if (saved.canonical !== undefined) process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD = saved.canonical;
    if (saved.legacy !== undefined) process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD = saved.legacy;
  }
}

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

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
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session creation route names a Cloudpit session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('the active-model answer carries the recorded permission mode, and null before one is sent', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('mode-session', 'claude', workspacePath);

    const unrecordedResponse = await fetch(
      `${baseUrl}/api/providers/claude/sessions/mode-session/active-model`,
    );
    const unrecordedPayload = await unrecordedResponse.json() as {
      data: { permissionMode: string | null };
    };
    assert.equal(unrecordedResponse.status, 200);
    // NULL is the answer for "no message has carried a mode yet": the client
    // reads it as "use the provider default", not as a mode of its own.
    assert.equal(unrecordedPayload.data.permissionMode, null);

    // Recorded the way a send records it, then read back over HTTP.
    const stored = providerModelsService.setSessionPermissionMode('claude', 'mode-session', 'acceptEdits');
    assert.equal(stored?.permissionMode, 'acceptEdits');

    const recordedResponse = await fetch(
      `${baseUrl}/api/providers/claude/sessions/mode-session/active-model`,
    );
    const recordedPayload = await recordedResponse.json() as {
      data: { permissionMode: string | null; sessionId: string };
    };
    assert.equal(recordedResponse.status, 200);
    assert.equal(recordedPayload.data.sessionId, 'mode-session');
    assert.equal(recordedPayload.data.permissionMode, 'acceptEdits');
  });
});

test('the duplicate route answers the create envelope and its error codes', async () => {
  await withProviderServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/providers/claude/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'Gateway Origin',
        id: 'gw-origin',
        config: { env: [
          { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
          { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-origin-secret' },
        ] },
      }),
    });
    const createPayload = await createResponse.json() as { data: { model: { recordId: number } } };
    assert.equal(createResponse.status, 201);
    const sourceRecordId = createPayload.data.model.recordId;

    const duplicateResponse = await fetch(
      `${baseUrl}/api/providers/claude/models/${sourceRecordId}/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'Gateway Copy',
          id: 'gw-origin-copy',
          config: { env: [
            { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
            { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' },
          ] },
        }),
      },
    );
    const duplicatePayload = await duplicateResponse.json() as {
      success: boolean;
      data: {
        provider: string;
        model: { value: string; label: string; recordId: number; isCustom: boolean };
        models: { OPTIONS: Array<{ value: string }> };
      };
    };
    assert.equal(duplicateResponse.status, 201);
    assert.equal(duplicatePayload.success, true);
    // The client reads the copy through the same envelope as a create, so the
    // key set is part of the contract, not an implementation detail.
    assert.deepEqual(Object.keys(duplicatePayload.data).sort(), ['model', 'models', 'provider']);
    assert.equal(duplicatePayload.data.provider, 'claude');
    assert.equal(duplicatePayload.data.model.value, 'gw-origin-copy');
    assert.equal(duplicatePayload.data.model.label, 'Gateway Copy');
    assert.equal(duplicatePayload.data.model.isCustom, true);
    assert.equal(
      duplicatePayload.data.models.OPTIONS.some((option) => option.value === 'gw-origin-copy'),
      true,
    );

    const badRecordId = await fetch(
      `${baseUrl}/api/providers/claude/models/not-a-number/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Copy', id: 'copy-x' }),
      },
    );
    assert.equal(badRecordId.status, 400);
    assert.equal(
      ((await badRecordId.json()) as { error: { code: string } }).error.code,
      'INVALID_MODEL_RECORD_ID',
    );

    const unknownSource = await fetch(
      `${baseUrl}/api/providers/claude/models/999999/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Copy', id: 'copy-x' }),
      },
    );
    assert.equal(unknownSource.status, 404);
    assert.equal(
      ((await unknownSource.json()) as { error: { code: string } }).error.code,
      'MODEL_NOT_FOUND',
    );

    const takenId = await fetch(
      `${baseUrl}/api/providers/claude/models/${sourceRecordId}/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Copy', id: 'gw-origin-copy' }),
      },
    );
    assert.equal(takenId.status, 409);
    assert.equal(
      ((await takenId.json()) as { error: { code: string } }).error.code,
      'MODEL_ID_ALREADY_EXISTS',
    );
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

test('the awaiting-reply list route serves the snapshot without being read as a session id', async () => {
  await withDesktopAlertsOff(async () => withProviderServer(async (baseUrl, workspacePath) => {
    const emptyResponse = await fetch(`${baseUrl}/api/providers/sessions/awaiting-reply`);
    const emptyPayload = await emptyResponse.json() as {
      success: boolean;
      data: { sessions: unknown[] };
    };
    assert.equal(emptyResponse.status, 200);
    assert.equal(emptyPayload.success, true);
    assert.deepEqual(emptyPayload.data.sessions, []);

    const sessionId = sessionsDb.createAppSession('waiting-session', 'codex', workspacePath, '等待中的会话');
    sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'completed');

    const response = await fetch(`${baseUrl}/api/providers/sessions/awaiting-reply`);
    const payload = await response.json() as {
      data: {
        sessions: Array<{
          sessionId: string;
          provider: string;
          projectPath: string | null;
          projectDisplayName: string;
          sessionTitle: string;
          awaitingSince: string;
          reason: string;
        }>;
      };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.data.sessions.length, 1);

    const row = payload.data.sessions[0];
    assert.equal(row.sessionId, sessionId);
    assert.equal(row.provider, 'codex');
    assert.equal(row.sessionTitle, '等待中的会话');
    assert.equal(row.reason, 'completed');
    assert.equal(row.projectPath, workspacePath);
    assert.ok(row.projectDisplayName, 'a row always carries a project label');
    assert.ok(
      !Number.isNaN(Date.parse(row.awaitingSince)),
      'awaitingSince is an ISO-8601 instant the client can format',
    );
  }));
});

test('dismissing one awaiting-reply row clears it, reports whether a wait ended, and validates the id', async () => {
  await withDesktopAlertsOff(async () => withProviderServer(async (baseUrl, workspacePath) => {
    const sessionId = sessionsDb.createAppSession('dismiss-session', 'codex', workspacePath, '可移除');
    sessionAwaitingReplyService.markSessionAwaitingReply(sessionId, 'permission');

    const first = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/awaiting-reply`, {
      method: 'DELETE',
    });
    const firstPayload = await first.json() as { data: { sessionId: string; removed: boolean } };
    assert.equal(first.status, 200);
    assert.equal(firstPayload.data.sessionId, sessionId);
    assert.equal(firstPayload.data.removed, true);
    assert.equal(sessionsDb.getSessionById(sessionId)?.awaiting_reply_at, null);

    // Nothing was waiting the second time, so the caller is told a no-op, not an error.
    const second = await fetch(`${baseUrl}/api/providers/sessions/${sessionId}/awaiting-reply`, {
      method: 'DELETE',
    });
    const secondPayload = await second.json() as { data: { removed: boolean } };
    assert.equal(second.status, 200);
    assert.equal(secondPayload.data.removed, false);

    const refused = await fetch(`${baseUrl}/api/providers/sessions/${encodeURIComponent('bad id!')}/awaiting-reply`, {
      method: 'DELETE',
    });
    const refusedPayload = await refused.json() as { error: { code: string } };
    assert.equal(refused.status, 400);
    assert.equal(refusedPayload.error.code, 'INVALID_SESSION_ID');
  }));
});
