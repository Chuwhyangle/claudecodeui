import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/index.js';

/**
 * Conversation search reads a Claude transcript line by line on its own, apart
 * from the history reader. The CLI's request-capture rows (`api-request-blob`
 * and kin) carry the wire `message: { role, content }` but are not part of the
 * conversation, so the search must not index them: one prompt would match twice,
 * and the wire-only `Tool loaded.` block would be searchable as user speech.
 * See `claude-transcript-capture-rows.test.ts` for the history-reader half.
 */

const SESSION_ID = 'claude-search-capture-rows';
const NEEDLE = 'zebrafinch-needle';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-search-capture-db-'));

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

function transcriptRows(): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: `please find the ${NEEDLE} sample` },
      uuid: 'prompt-1',
      timestamp: '2026-10-15T14:30:05.049Z',
      cwd: '/workspace/demo',
      sessionId: SESSION_ID,
    }),
    JSON.stringify({
      type: 'api-request-blob',
      sessionId: SESSION_ID,
      hash: '0319968c7921ab5a8617ac04509b7e3da0ea4604f9d971b7e0561ca605044469',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `please find the ${NEEDLE} sample` },
          { type: 'text', text: `Tool loaded. ${NEEDLE}` },
        ],
      },
    }),
    JSON.stringify({
      type: 'api-request-blob',
      sessionId: SESSION_ID,
      hash: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      message: { role: 'assistant', content: [{ type: 'text', text: `found the ${NEEDLE}` }] },
    }),
  ];
}

test('conversation search matches a prompt once, not once per capture row', { concurrency: false }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-search-capture-'));
  const transcriptPath = path.join(directory, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, `${transcriptRows().join('\n')}\n`, 'utf8');

  try {
    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', '/workspace/demo', 'search-capture', now, now, transcriptPath);

      const { totalMatches } = await searchConversations(NEEDLE, 50);

      assert.equal(totalMatches, 1, 'only the persisted user row is searchable');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
