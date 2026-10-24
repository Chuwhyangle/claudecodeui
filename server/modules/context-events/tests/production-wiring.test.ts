/**
 * AC5 — the production seams, driven directly.
 *
 *   (a) one accepted person-send produces exactly ONE `utterance` (and a voice
 *       send states `source: 'voice'`);
 *   (b) a refused send produces none, and an MCP/scheduled send is not an
 *       utterance at all;
 *   (c) a recorder that THROWS does not change the send's result;
 *   (d) the reply-suggestions ledger's tap turns one `picked` row into exactly
 *       one `chip.picked`, and rows with no v0 kind (cleared/sent) produce none.
 *
 * The chat-control fixture mirrors `chat-control-send.test.ts`: a temporary
 * DATABASE_PATH, one session row and an injected runtime whose run never needs to
 * finish for a send to be accepted. No socket is built.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createContextEvents, type ContextEventWriter } from '@/modules/context-events/index.js';
import {
  createReplySuggestionsUsageLog,
  setReplySuggestionsUsageObserver,
} from '@/modules/reply-suggestions/index.js';
import {
  chatRunRegistry,
  createChatControlService,
  type ProviderRuntimeGateway,
} from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

const SESSION_ID = 'context-wiring-session';

/** The recorder observation the wiring emits; a plain list keeps the assertion exact. */
type RecordedEvent = {
  kind: string;
  session?: string | null;
  data?: Record<string, unknown>;
};

/** A runtime whose run is accepted and never has to complete for this criterion. */
function createRuntime(): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    run: (_provider: LLMProvider, _command: string, _options: AnyRecord) => new Promise<unknown>(() => undefined),
    abort: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  } as ProviderRuntimeGateway;
}

/** Boots the real control service against a temp database, with a recorder. */
async function withControl(
  recorder: (event: {
    kind: 'utterance';
    session: string;
    data: { text: string; source: 'typing' | 'voice' };
  }) => void,
  run: (control: ReturnType<typeof createChatControlService>) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'context-wiring-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Wiring session', now, now, null);
    await run(createChatControlService({ runtime: createRuntime(), recordContextEvent: recorder }));
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A stream over a writer that records drafts, so chip events are read without disk. */
function createRecordingStream(): { stream: ReturnType<typeof createContextEvents>; written: RecordedEvent[] } {
  const written: RecordedEvent[] = [];
  const writer: ContextEventWriter = {
    eventsDir: '/tmp/never',
    schemaPath: '/tmp/never/schema.json',
    async append(draft) {
      written.push({
        kind: draft.kind,
        ...(draft.session === undefined || draft.session === null ? {} : { session: draft.session }),
        data: draft.data ?? {},
      });
      return { ok: true, id: `e-${written.length}`, path: '/tmp/never/events.jsonl' };
    },
    status: () => ({ state: 'ok', reason: null, schemaPath: '/tmp/never/schema.json', eventsDir: '/tmp/never', writes: written.length, rejected: 0 }),
  };
  return { stream: createContextEvents({ writer }), written };
}

/** Lets the stream's serial chain drain (its appends resolve immediately here). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('AC5 (a): one accepted send is exactly one utterance', async () => {
  const recorded: RecordedEvent[] = [];
  await withControl(
    (event) => recorded.push(event),
    async (control) => {
      const result = await control.send(
        { userId: 1, via: 'websocket' },
        { sessionId: SESSION_ID, content: '检查进展。' },
      );
      assert.equal(result.ok, true);
    },
  );
  assert.equal(recorded.length, 1, 'one send is one utterance');
  assert.equal(recorded[0].kind, 'utterance');
  assert.equal(recorded[0].session, SESSION_ID);
  assert.deepEqual(recorded[0].data, { text: '检查进展。', source: 'typing' });
  console.log(`AC5(a) recorded=${JSON.stringify(recorded)}`);
});

test('AC5 (a): a voice send states its own source', async () => {
  const recorded: RecordedEvent[] = [];
  await withControl(
    (event) => recorded.push(event),
    async (control) => {
      await control.send({ userId: 1, via: 'voice' }, { sessionId: SESSION_ID, content: '构建然后重启。' });
    },
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].data?.source, 'voice');
  console.log(`AC5(a2) source=${recorded[0].data?.source}`);
});

test('AC5 (b): a refused send and an MCP send produce no utterance', async () => {
  const recorded: RecordedEvent[] = [];
  await withControl(
    (event) => recorded.push(event),
    async (control) => {
      const refused = await control.send(
        { userId: 1, via: 'websocket' },
        { sessionId: 'no-such-session', content: 'hello' },
      );
      assert.equal(refused.ok, false);
      await control.send({ userId: 1, via: 'mcp' }, { sessionId: SESSION_ID, content: 'tool call' });
    },
  );
  assert.deepEqual(recorded, [], 'neither a refusal nor a tool call is a person utterance');
  console.log(`AC5(b) recorded=${recorded.length}`);
});

test('AC5 (c): a THROWING WRITER leaves the send result unchanged', async () => {
  // The real stream over a writer whose append throws: `record` contains the
  // throw, and the send seam does not even await it. The send must still succeed.
  const throwingWriter: ContextEventWriter = {
    eventsDir: '/tmp/never',
    schemaPath: '/tmp/never/schema.json',
    async append() {
      throw new Error('the context event file is unwritable');
    },
    status: () => ({ state: 'ok', reason: null, schemaPath: '/tmp/never/schema.json', eventsDir: '/tmp/never', writes: 0, rejected: 0 }),
  };
  const stream = createContextEvents({ writer: throwingWriter });
  await withControl(
    (event) => {
      void stream.record(event);
    },
    async (control) => {
      const result = await control.send(
        { userId: 1, via: 'websocket' },
        { sessionId: SESSION_ID, content: 'this send must still succeed' },
      );
      assert.equal(result.ok, true, 'the send completes even when the writer throws');
      console.log(`AC5(c) send_ok=${result.ok} writer_threw=true`);
    },
  );
});

test('AC5 (d): one picked chip row is exactly one chip.picked; cleared/sent produce none', async () => {
  const { stream, written } = createRecordingStream();
  stream.recordUsage({ type: 'picked', sessionId: 's-1', draw: 2, index: 1 });
  stream.recordUsage({ type: 'cleared', sessionId: 's-1', draw: 2 });
  stream.recordUsage({ type: 'sent', sessionId: 's-1', draw: 2 });
  await settle();

  const chips = written.filter((event) => event.kind.startsWith('chip.'));
  assert.equal(chips.length, 1, 'only the picked row produced an event');
  assert.equal(chips[0].kind, 'chip.picked');
  assert.equal(chips[0].session, 's-1');
  assert.equal(chips[0].data?.index, 1);
  assert.equal(chips[0].data?.draw, 2);
  console.log(`AC5(d) chip_events=${JSON.stringify(chips)}`);
});

test('AC5 (d): the usage ledger tap feeds the stream, and a throwing observer cannot lose the ledger row', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'context-usage-tap-'));
  const { stream, written } = createRecordingStream();
  try {
    const ledgerPath = path.join(dir, 'usage.jsonl');
    const ledger = createReplySuggestionsUsageLog({ filePath: ledgerPath });
    try {
      // A broken tap must not take the durable row with it.
      setReplySuggestionsUsageObserver(() => {
        throw new Error('observer failed');
      });
      ledger.write({ type: 'picked', sessionId: 's-broken', draw: 1, index: 0 });
      assert.equal((await readFile(ledgerPath, 'utf8')).trim().split('\n').length, 1, 'the ledger row is durable');

      setReplySuggestionsUsageObserver((record) => stream.recordUsage(record));
      ledger.write({ type: 'picked', sessionId: 's-2', draw: 1, index: 0 });
      await settle();
    } finally {
      setReplySuggestionsUsageObserver(null);
    }

    const chips = written.filter((event) => event.kind === 'chip.picked');
    assert.equal(chips.length, 1, 'the ledger tap produced exactly one chip.picked');
    assert.equal(chips[0].session, 's-2');
    console.log(`AC5(d2) tapped=${chips.length} ledger_rows=2`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
