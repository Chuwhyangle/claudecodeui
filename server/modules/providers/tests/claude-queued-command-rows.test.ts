import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * A message sent while the CLI is mid-turn is not written as a `user` row. The
 * CLI folds it into the running turn and records it as an
 * `attachment { type: 'queued_command' }` row (the queue-operation row beside it
 * says `absorbed_mid_turn`). The history reader only looked at `message.role`,
 * so every such message — every Live Voice sentence spoken while Claude was
 * busy — was delivered to the model and never drawn as something the user said
 * (live 2026-10-15 23:01: seven spoken sentences, one visible user row).
 *
 * The row shapes are transcribed from that session's transcript.
 */

const SESSION_ID = 'claude-queued-command-rows';
const FIRST_PROMPT = 'first question';
const ABSORBED_PROMPT = '所以你会查日志吗？';
const REPLY_TEXT = 'Looking at the journal.';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-queued-command-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function userRow(uuid: string, text: string, timestamp: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp,
    cwd: '/workspace/demo',
    sessionId: SESSION_ID,
  });
}

function assistantRow(uuid: string, text: string, timestamp: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    uuid,
    timestamp,
    sessionId: SESSION_ID,
  });
}

function queuedCommandRow(
  uuid: string,
  prompt: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt,
      source_uuid: `${uuid}-source`,
      delivery_id: `${uuid}-delivery`,
      commandMode: 'prompt',
      timestamp,
      ...extra,
    },
    uuid,
    timestamp,
    sessionId: SESSION_ID,
  });
}

async function readHistoryOf(lines: string[]): Promise<NormalizedMessage[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-queued-command-'));
  const transcriptPath = path.join(directory, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, [...lines, ''].join('\n'), 'utf8');
  try {
    let messages: NormalizedMessage[] = [];
    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', directory, 'queued-command', now, now, transcriptPath);
      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      messages = history.messages;
    });
    return messages;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const textRows = (messages: NormalizedMessage[]) =>
  messages.filter((message) => message.kind === 'text').map((message) => [message.role, message.content]);

test('a message the CLI absorbed mid-turn is drawn as a user row in its place', { concurrency: false }, async () => {
  const messages = await readHistoryOf([
    userRow('u-1', FIRST_PROMPT, '2026-10-15T15:01:07.000Z'),
    queuedCommandRow('q-1', ABSORBED_PROMPT, '2026-10-15T15:01:27.942Z'),
    assistantRow('a-1', REPLY_TEXT, '2026-10-15T15:01:40.000Z'),
  ]);

  assert.deepEqual(textRows(messages), [
    ['user', FIRST_PROMPT],
    ['user', ABSORBED_PROMPT],
    ['assistant', REPLY_TEXT],
  ]);
  const absorbed = messages.find((message) => message.content === ABSORBED_PROMPT);
  assert.equal(absorbed?.id, 'q-1', 'the row keeps the CLI\'s own uuid, so a later read and a live push agree on it');
  assert.equal(absorbed?.timestamp, '2026-10-15T15:01:27.942Z');
});

test('every absorbed message of a busy stretch survives, in order', { concurrency: false }, async () => {
  const sentences = ['那上面这句话也是一样。', '上面这句话识别错了，我说的是它们又消失了。', '赶快查一下。'];
  const messages = await readHistoryOf([
    userRow('u-1', FIRST_PROMPT, '2026-10-15T15:01:07.000Z'),
    ...sentences.map((sentence, index) =>
      queuedCommandRow(`q-${index}`, sentence, `2026-10-15T15:02:0${index}.000Z`)),
  ]);

  assert.deepEqual(
    textRows(messages),
    [['user', FIRST_PROMPT], ...sentences.map((sentence) => ['user', sentence])],
  );
});

test('only a prompt the person sent becomes a row: notifications and non-prompt commands do not', { concurrency: false }, async () => {
  const messages = await readHistoryOf([
    userRow('u-1', FIRST_PROMPT, '2026-10-15T15:01:07.000Z'),
    queuedCommandRow('q-notification', '<task-notification>done</task-notification>', '2026-10-15T15:01:10.000Z', {
      origin: { kind: 'task-notification' },
    }),
    queuedCommandRow('q-bash', 'ls -la', '2026-10-15T15:01:11.000Z', { commandMode: 'bash' }),
    queuedCommandRow('q-empty', '   ', '2026-10-15T15:01:12.000Z'),
  ]);

  assert.deepEqual(textRows(messages), [['user', FIRST_PROMPT]]);
});

test('a prompt the CLI dequeued into a turn of its own is drawn once', { concurrency: false }, async () => {
  const messages = await readHistoryOf([
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: FIRST_PROMPT, sessionId: SESSION_ID }),
    JSON.stringify({ type: 'queue-operation', operation: 'dequeue', sessionId: SESSION_ID }),
    userRow('u-1', FIRST_PROMPT, '2026-10-15T15:01:07.000Z'),
    assistantRow('a-1', REPLY_TEXT, '2026-10-15T15:01:09.000Z'),
  ]);

  assert.deepEqual(textRows(messages), [['user', FIRST_PROMPT], ['assistant', REPLY_TEXT]]);
});
