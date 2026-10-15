import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * Claude CLI 2.1.300 writes request-capture rows into the session transcript:
 * `api-request-blob` (the wire message itself, `message: { role, content }`),
 * plus `api-request`, `api-request-shape` and `atis-latch` bookkeeping. They
 * carry the session's `sessionId` but no `uuid` and no `timestamp`.
 *
 * The history reader used to project any row with `message.role === 'user'`, so
 * every blob became a chat message: a second copy of each prompt under a random
 * `claude_<uuid>` id stamped with the read time, and the `Tool loaded.` text
 * block the CLI appends to the wire request after a `tool_reference` result,
 * shown as something the user said. These cases pin that capture rows are not
 * conversation, on a full read and after an append.
 *
 * The row shapes are transcribed from a real transcript (session `aa6281b8…`).
 */

const SESSION_ID = 'claude-capture-rows';
const PROMPT_TEXT = 'can the browser reach the service?';
const REPLY_TEXT = 'Yes, it is up.';
const WIRE_ONLY_TEXT = 'Tool loaded.';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-capture-rows-db-'));

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

/** The conversation as the CLI persists it: one user prompt, one assistant reply. */
function conversationRows(): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: PROMPT_TEXT },
      uuid: 'prompt-1',
      timestamp: '2026-10-15T14:30:05.049Z',
      cwd: '/workspace/demo',
      sessionId: SESSION_ID,
    }),
    JSON.stringify({
      parentUuid: 'prompt-1',
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: REPLY_TEXT }] },
      uuid: 'reply-1',
      timestamp: '2026-10-15T14:30:16.619Z',
      sessionId: SESSION_ID,
    }),
  ];
}

/** The request-capture rows the CLI interleaves with the conversation. */
function captureRows(): string[] {
  return [
    JSON.stringify({
      type: 'api-request-blob',
      sessionId: SESSION_ID,
      hash: '0319968c7921ab5a8617ac04509b7e3da0ea4604f9d971b7e0561ca605044469',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01Nku7XGfiw9vGroDvPQDy3b',
            content: [{ type: 'tool_reference', tool_name: 'mcp__playwright__browser_navigate' }],
          },
          { type: 'text', text: WIRE_ONLY_TEXT },
        ],
      },
    }),
    JSON.stringify({
      type: 'api-request-blob',
      sessionId: SESSION_ID,
      hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      message: { role: 'user', content: [{ type: 'text', text: PROMPT_TEXT }] },
    }),
    JSON.stringify({
      type: 'api-request-blob',
      sessionId: SESSION_ID,
      hash: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      message: { role: 'assistant', content: [{ type: 'text', text: REPLY_TEXT }] },
    }),
    JSON.stringify({
      type: 'api-request',
      sessionId: SESSION_ID,
      id: 'ff54e314-edc6-4bee-9621-7852cd60931f',
      timestamp: '2026-10-15T14:30:12.983Z',
      version: '2.1.300',
      querySource: 'sdk',
    }),
    JSON.stringify({ type: 'api-request-shape', sessionId: SESSION_ID, shapeHash: '489e68a1' }),
    JSON.stringify({ type: 'atis-latch', sessionId: SESSION_ID }),
  ];
}

async function writeTranscript(lines: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-capture-rows-'));
  const filePath = path.join(directory, `${SESSION_ID}.jsonl`);
  await writeFile(filePath, [...lines, ''].join('\n'), 'utf8');
  return filePath;
}

/** Runs the provider's own history read for the transcript at `transcriptPath`. */
async function readHistory(transcriptPath: string): Promise<NormalizedMessage[]> {
  const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
    providerSessionId: SESSION_ID,
  });
  assert.ok(transcriptPath.endsWith(`${SESSION_ID}.jsonl`));
  return history.messages;
}

function registerSession(transcriptPath: string): void {
  const now = new Date().toISOString();
  sessionsDb.createSession(SESSION_ID, 'claude', path.dirname(transcriptPath), 'capture-rows', now, now, transcriptPath);
}

function assertConversationOnly(messages: NormalizedMessage[]): void {
  const texts = messages.filter((message) => message.kind === 'text');

  assert.deepEqual(
    texts.map((message) => [message.role, message.content]),
    [['user', PROMPT_TEXT], ['assistant', REPLY_TEXT]],
    'only the persisted conversation rows project to text messages',
  );
  assert.equal(
    messages.some((message) => message.content === WIRE_ONLY_TEXT),
    false,
    'the CLI\'s wire-only "Tool loaded." block is not something anyone said',
  );
  assert.deepEqual(
    messages.filter((message) => message.id.startsWith('claude_')).map((message) => message.id),
    [],
    'no message may take a generated id: every projected row must have come from a uuid-bearing row',
  );
}

test('history ignores request-capture rows interleaved with the conversation', { concurrency: false }, async () => {
  const [prompt, reply] = conversationRows();
  const transcriptPath = await writeTranscript([prompt, ...captureRows().slice(0, 3), reply, ...captureRows().slice(3)]);

  try {
    await withIsolatedDatabase(async () => {
      registerSession(transcriptPath);
      assertConversationOnly(await readHistory(transcriptPath));
    });
  } finally {
    await rm(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});

test('capture rows appended after a read stay out of the next read', { concurrency: false }, async () => {
  const transcriptPath = await writeTranscript(conversationRows());

  try {
    await withIsolatedDatabase(async () => {
      registerSession(transcriptPath);
      assertConversationOnly(await readHistory(transcriptPath));

      await appendFile(transcriptPath, `${captureRows().join('\n')}\n`, 'utf8');

      assertConversationOnly(await readHistory(transcriptPath));
    });
  } finally {
    await rm(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});
