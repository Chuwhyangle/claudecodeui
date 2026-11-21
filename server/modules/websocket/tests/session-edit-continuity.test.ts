import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionBindingService,
  sessionsDb,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * End-to-end continuity of "edit an earlier message and send it again".
 *
 * WHY THIS FILE EXISTS. Each half of the feature has its own criterion: the
 * preparation service orders close/rewind, the binding repository refuses stale
 * writes, and the provider readers parse a transcript. None of them answers the
 * person's question — after an edit, is my conversation still there? That answer
 * crosses the websocket gateway, the run registry, the database binding, the
 * provider's own rewind (a real `thread/fork` for Codex), and the history reader,
 * and only the composition shows whether a regression in any one of them leaves
 * the session readable.
 *
 * The transport is a fake socket and the model runtime is a stub, deliberately:
 * this criterion is about the wiring between them. The replacement turn is
 * written where the real CLI writes it — appended to the transcript the session
 * row now points at — so the history read is the same read a browser makes after
 * the edit completes. The Codex arms run the bundled CLI's real app-server
 * (`thread/fork`) against a rollout written in its `paginated` mode; when the
 * source rollout is written that way the fork file holds only a pointer, which
 * is what made the history look empty in the reported session.
 *
 * Evidence the task body quotes (all printed below): the message list before the
 * edit, after it, after a refresh, after switching sessions and back, and after
 * closing and reopening the database; plus the fork file's own row count, which
 * is smaller than the history the reader returns.
 */

const SESSION_ID = 'continuity-session';
const SWITCHED_SESSION_ID = 'continuity-other-session';

type AnyRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fake browser socket + host manager (the same seams other gateway criteria use)
// ---------------------------------------------------------------------------

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRow[];
  send: (data: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as AnyRow);
  return socket;
}

function createFakeHostManager(socket: FakeSocket, events: string[], failClose = false) {
  const rewinds: string[] = [];
  let remainingFailures = failClose ? 1 : 0;
  return {
    rewinds,
    truncatedBeforeClose: false,
    async closeHostForEditAndWait(sessionId: string): Promise<{ found: boolean }> {
      events.push('close-start');
      // Read at entry: the client has to be told to drop the superseded turns
      // before a rebuild that can be slow begins.
      this.truncatedBeforeClose = socket.frames.some((frame) => frame.kind === 'history_truncated');
      await Promise.resolve();
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('host refused to close');
      }
      rewinds.push(sessionId);
      events.push('close-done');
      return { found: true };
    },
    attachViewer(): void {
      // No viewer subscribes in this file.
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript fixtures
// ---------------------------------------------------------------------------

/**
 * Three Claude turns. The middle prompt (`cl-u2`) is the one edited.
 * Rows carry the provider-native session id because that is what the reader
 * filters on.
 */
function claudeTranscriptRows(providerSessionId: string): AnyRow[] {
  const row = (
    type: 'user' | 'assistant',
    uuid: string,
    parentUuid: string | null,
    text: string,
    seconds: number,
  ): AnyRow => ({
    type,
    uuid,
    parentUuid,
    sessionId: providerSessionId,
    timestamp: new Date(Date.UTC(2026, 9, 30, 0, 0, seconds)).toISOString(),
    message: { role: type, content: [{ type: 'text', text }] },
  });
  return [
    row('user', 'cl-u1', null, 'first', 0),
    row('assistant', 'cl-a1', 'cl-u1', 'reply-first', 1),
    row('user', 'cl-u2', 'cl-a1', 'second', 2),
    row('assistant', 'cl-a2', 'cl-u2', 'reply-second', 3),
    row('user', 'cl-u3', 'cl-a2', 'third', 4),
    row('assistant', 'cl-a3', 'cl-u3', 'reply-third', 5),
  ];
}

/** A two-row Claude conversation in a freshly started transcript file. */
function claudeNewConversationRows(providerSessionId: string, prompt: string, answer: string): AnyRow[] {
  const row = (type: 'user' | 'assistant', uuid: string, parentUuid: string | null, text: string): AnyRow => ({
    type,
    uuid,
    parentUuid,
    sessionId: providerSessionId,
    timestamp: new Date(Date.UTC(2026, 9, 30, 0, 2, 0)).toISOString(),
    message: { role: type, content: [{ type: 'text', text }] },
  });
  return [
    row('user', 'new-u1', null, prompt),
    row('assistant', 'new-a1', 'new-u1', answer),
  ];
}

async function appendClaudeRows(
  transcriptPath: string,
  providerSessionId: string,
  rows: Array<{ type: 'user' | 'assistant'; uuid: string; parentUuid: string | null; text: string }>,
  seconds: number,
): Promise<void> {
  const lines = rows.map((entry, index) => JSON.stringify({
    type: entry.type,
    uuid: entry.uuid,
    parentUuid: entry.parentUuid,
    sessionId: providerSessionId,
    timestamp: new Date(Date.UTC(2026, 9, 30, 0, 1, seconds + index)).toISOString(),
    message: { role: entry.type, content: [{ type: 'text', text: entry.text }] },
  }));
  await appendFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 9, 30, 0, 0, offsetSeconds)).toISOString();
}

/**
 * A rollout in the CLI's `paginated` history mode. The assistant answer is a
 * `response_item` message row, which is the shape the real CLI writes (and the
 * shape a reader that only knows `event_msg` silently drops).
 */
function codexRolloutRows(threadId: string, turns: Array<{ prompt: string; answer: string }>): AnyRow[] {
  const rows: AnyRow[] = [
    {
      timestamp: timestamp(0),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        creator_user_id: 'continuity-test',
        creator_account_id: 'continuity-test',
        session_id: threadId,
        id: threadId,
        timestamp: timestamp(0),
        cwd: '/tmp/continuity-workspace',
        runtime_workspace_roots: ['/tmp/continuity-workspace'],
        originator: 'cloudcli',
        cli_version: '0.166.0',
        source: 'vscode',
        model_provider: 'openai',
        base_instructions: { text: 'test instructions' },
        history_mode: 'paginated',
      },
    },
  ];
  let ordinal = 1;
  turns.forEach((turn, index) => {
    const turnId = `turn-${index + 1}`;
    rows.push(
      { timestamp: timestamp(ordinal), ordinal: ordinal++, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { timestamp: timestamp(ordinal), ordinal: ordinal++, type: 'turn_context', payload: { turn_id: turnId, cwd: '/tmp/continuity-workspace' } },
      {
        timestamp: timestamp(ordinal),
        ordinal: ordinal++,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: threadId,
          turn_id: turnId,
          item: { type: 'UserMessage', id: `user-${index + 1}`, content: [{ type: 'text', text: turn.prompt }] },
        },
      },
      {
        timestamp: timestamp(ordinal),
        ordinal: ordinal++,
        type: 'response_item',
        payload: {
          type: 'message',
          status: 'completed',
          id: `answer-${index + 1}`,
          role: 'assistant',
          content: [{ type: 'output_text', text: turn.answer, annotations: [] }],
        },
      },
      { timestamp: timestamp(ordinal), ordinal: ordinal++, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    );
  });
  return rows;
}

/** One replacement turn, appended to the fork file the session now points at. */
function codexReplacementRows(threadId: string, startOrdinal: number): AnyRow[] {
  return [
    { timestamp: timestamp(startOrdinal), ordinal: startOrdinal, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-replacement' } },
    {
      timestamp: timestamp(startOrdinal + 1),
      ordinal: startOrdinal + 1,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: 'turn-replacement',
        item: { type: 'UserMessage', id: 'user-replacement', content: [{ type: 'text', text: 'replacement' }] },
      },
    },
    {
      timestamp: timestamp(startOrdinal + 2),
      ordinal: startOrdinal + 2,
      type: 'response_item',
      payload: {
        type: 'message',
        status: 'completed',
        id: 'answer-replacement',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'reply-replacement', annotations: [] }],
      },
    },
    { timestamp: timestamp(startOrdinal + 3), ordinal: startOrdinal + 3, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-replacement' } },
  ];
}

async function writeJsonl(filePath: string, rows: AnyRow[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

async function appendJsonl(filePath: string, rows: AnyRow[]): Promise<void> {
  await appendFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

/** The fork's exclusive cut, read from the file the CLI actually wrote. */
async function readForkCut(filePath: string): Promise<number> {
  const first = (await readFile(filePath, 'utf8')).split('\n').find((line) => line.trim());
  const meta = JSON.parse(first ?? '{}') as { payload?: Record<string, unknown> };
  const cut = meta.payload?.forked_from_ordinal_exclusive;
  assert.equal(typeof cut, 'number', 'a paginated fork must name its exclusive ordinal cut');
  return cut as number;
}

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

type RunRecord = {
  provider: string;
  command: string;
  options: AnyRow;
  writer: { setSessionId: (sessionId: string) => void };
};

type ScenarioContext = {
  socket: FakeSocket;
  events: string[];
  hosts: ReturnType<typeof createFakeHostManager>;
  runs: RunRecord[];
  sendFrame: (frame: AnyRow) => Promise<void>;
  home: string;
  projectPath: string;
  codexSessionsRoot: string;
  transcriptPath: string;
  providerSessionId: string;
  basePath: string;
  history: (sessionId?: string) => Promise<string[]>;
};

type RuntimeRunContext = {
  options: AnyRow;
  writer: RunRecord['writer'];
  scenario: ScenarioContext;
};

async function withScenario(
  config: {
    provider: 'claude' | 'codex';
    resident?: boolean;
    failClose?: boolean;
    prepare: (environment: {
      home: string;
      projectPath: string;
      codexSessionsRoot: string;
    }) => Promise<{ transcriptPath: string; providerSessionId: string; rows: AnyRow[] }>;
    onRuntimeRun: (context: RuntimeRunContext) => Promise<void>;
  },
  body: (context: ScenarioContext) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-edit-continuity-'));
  const projectPath = path.join(home, 'project');
  await mkdir(projectPath, { recursive: true });
  const codexSessionsRoot = path.join(home, '.codex', 'sessions');

  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  if (config.provider === 'codex') {
    process.env.CODEX_HOME = path.join(home, '.codex');
  }

  closeConnection();
  await initializeDatabase();

  try {
    const prepared = await config.prepare({ home, projectPath, codexSessionsRoot });
    await writeJsonl(prepared.transcriptPath, prepared.rows);

    sessionsDb.createAppSession(SESSION_ID, config.provider, projectPath, 'Continuity');
    sessionBindingService.replaceBinding({
      sessionId: SESSION_ID,
      providerSessionId: prepared.providerSessionId,
      jsonlPath: prepared.transcriptPath,
    });
    if (config.resident) {
      sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident');
    }

    const events: string[] = [];
    const runs: RunRecord[] = [];
    const socket = createFakeSocket();
    const hosts = createFakeHostManager(socket, events, config.failClose);

    const context: ScenarioContext = {
      socket,
      events,
      hosts,
      runs,
      sendFrame: async () => {
        throw new Error('sendFrame used before the connection was installed');
      },
      home,
      projectPath,
      codexSessionsRoot,
      transcriptPath: prepared.transcriptPath,
      providerSessionId: prepared.providerSessionId,
      basePath: prepared.transcriptPath,
      history: async (sessionId = SESSION_ID) => {
        const result = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
        return result.messages.map(
          (message) => `${String(message.role ?? '')}:${String(message.content ?? '')}`,
        );
      },
    };

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (
            provider: string,
            command: string,
            options: AnyRow,
            writer: RunRecord['writer'],
          ) => {
            events.push('run');
            runs.push({ provider, command, options, writer });
            await config.onRuntimeRun({ options, writer, scenario: context });
          },
        } as never,
        sessionHostManager: hosts as never,
      },
    );

    // `emit` discards the listener's promise, so await the listener
    // `handleChatConnection` registered; it settles when the turn is over.
    const handleMessage = socket.listeners('message')[0] as (raw: unknown) => Promise<void>;
    context.sendFrame = async (frame: AnyRow) => {
      await handleMessage(JSON.stringify(frame));
    };

    await body(context);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(home, { recursive: true, force: true });
  }
}

function protocolErrors(socket: FakeSocket): Array<{ code?: unknown; error?: unknown }> {
  return socket.frames.filter((frame) => frame.kind === 'protocol_error') as Array<{
    code?: unknown;
    error?: unknown;
  }>;
}

function editFrame(anchorId: string, content: string): AnyRow {
  return { type: 'chat.edit-send', sessionId: SESSION_ID, anchorId, content };
}

// ---------------------------------------------------------------------------
// Claude — per-run, resident, and first-turn
// ---------------------------------------------------------------------------

test('Claude per-run: editing the middle prompt keeps the prefix and survives refresh, switch and restart', async () => {
  await withScenario({
    provider: 'claude',
    prepare: async ({ projectPath }) => {
      const providerSessionId = 'claude-continuity-thread';
      return {
        transcriptPath: path.join(projectPath, `${providerSessionId}.jsonl`),
        providerSessionId,
        rows: claudeTranscriptRows(providerSessionId),
      };
    },
    onRuntimeRun: async ({ options, scenario }) => {
      // A per-run Claude edit resumes the SDK at the answer before the edited
      // prompt; it never branches the transcript file itself.
      assert.equal(options.resumeAnchorId, 'cl-a1');
      assert.equal(options.resumeFromScratch, false);
      await appendClaudeRows(
        scenario.transcriptPath,
        scenario.providerSessionId,
        [
          { type: 'user', uuid: 'cl-u2r', parentUuid: 'cl-a1', text: 'replacement' },
          { type: 'assistant', uuid: 'cl-a2r', parentUuid: 'cl-u2r', text: 'reply-replacement' },
        ],
        20,
      );
    },
  }, async (context) => {
    const before = await context.history();
    console.log(`continuity.claude.before=${JSON.stringify(before)}`);
    assert.deepEqual(before, [
      'user:first', 'assistant:reply-first',
      'user:second', 'assistant:reply-second',
      'user:third', 'assistant:reply-third',
    ]);

    await context.sendFrame(editFrame('cl-u2', 'replacement'));
    assert.deepEqual(protocolErrors(context.socket), []);
    assert.deepEqual(context.hosts.rewinds, [], 'a per-run edit must not close a host');

    const after = await context.history();
    console.log(`continuity.claude.after=${JSON.stringify(after)}`);
    assert.deepEqual(after, [
      'user:first', 'assistant:reply-first',
      'user:replacement', 'assistant:reply-replacement',
    ]);
    // The abandoned branch and the turns after it are not drawn, and the
    // replacement is drawn exactly once.
    assert.equal(after.filter((entry) => entry === 'user:second').length, 0);
    assert.equal(after.filter((entry) => entry === 'user:third').length, 0);
    assert.equal(after.filter((entry) => entry === 'user:replacement').length, 1);

    // Refresh: a second read of the same session.
    const refreshed = await context.history();
    assert.deepEqual(refreshed, after);
    console.log(`continuity.claude.refreshed=${JSON.stringify(refreshed)}`);

    // Switch away to an unrelated session and back. The other session has its
    // own transcript and binding, so a cache keyed too loosely would answer
    // with the wrong conversation.
    const otherPath = path.join(context.projectPath, 'claude-other.jsonl');
    const otherRows = claudeTranscriptRows('claude-other-thread').slice(0, 2);
    await writeJsonl(otherPath, otherRows);
    sessionsDb.createAppSession(SWITCHED_SESSION_ID, 'claude', context.projectPath, 'Other');
    sessionBindingService.replaceBinding({
      sessionId: SWITCHED_SESSION_ID,
      providerSessionId: 'claude-other-thread',
      jsonlPath: otherPath,
    });
    const other = await context.history(SWITCHED_SESSION_ID);
    assert.deepEqual(other, ['user:first', 'assistant:reply-first']);
    const back = await context.history();
    assert.deepEqual(back, after);
    console.log(`continuity.claude.switched-back=${JSON.stringify(back)}`);

    // Isolated restart: close the database and open it again. The session must
    // read the same history from disk, not from whatever the run left in memory.
    closeConnection();
    await initializeDatabase();
    const restarted = await context.history();
    console.log(`continuity.claude.restarted=${JSON.stringify(restarted)}`);
    assert.deepEqual(restarted, after);
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.session_id, SESSION_ID);
  });
});

test('Claude resident: the truncation is announced before the old host closes, then the replacement continues', async () => {
  await withScenario({
    provider: 'claude',
    resident: true,
    prepare: async ({ projectPath }) => {
      const providerSessionId = 'claude-resident-thread';
      return {
        transcriptPath: path.join(projectPath, `${providerSessionId}.jsonl`),
        providerSessionId,
        rows: claudeTranscriptRows(providerSessionId),
      };
    },
    onRuntimeRun: async ({ scenario }) => {
      await appendClaudeRows(
        scenario.transcriptPath,
        scenario.providerSessionId,
        [
          { type: 'user', uuid: 'cl-u2r', parentUuid: 'cl-a1', text: 'replacement' },
          { type: 'assistant', uuid: 'cl-a2r', parentUuid: 'cl-u2r', text: 'reply-replacement' },
        ],
        20,
      );
    },
  }, async (context) => {
    await context.sendFrame(editFrame('cl-u2', 'replacement'));
    assert.deepEqual(protocolErrors(context.socket), []);

    assert.deepEqual(context.events, ['close-start', 'close-done', 'run']);
    assert.equal(context.hosts.truncatedBeforeClose, true, 'history_truncated must be on the wire before the close');
    assert.deepEqual(context.hosts.rewinds, [SESSION_ID]);
    assert.equal(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    const after = await context.history();
    console.log(`continuity.claude.resident.after=${JSON.stringify(after)}`);
    assert.deepEqual(after, [
      'user:first', 'assistant:reply-first',
      'user:replacement', 'assistant:reply-replacement',
    ]);
    assert.equal(after.filter((entry) => entry === 'user:second').length, 0);
    assert.equal(after.filter((entry) => entry === 'user:third').length, 0);
  });
});

test('Claude first prompt: the edit starts from empty context and the new transcript is the only history', async () => {
  await withScenario({
    provider: 'claude',
    prepare: async ({ projectPath }) => {
      const providerSessionId = 'claude-first-thread';
      return {
        transcriptPath: path.join(projectPath, `${providerSessionId}.jsonl`),
        providerSessionId,
        rows: claudeTranscriptRows(providerSessionId),
      };
    },
    onRuntimeRun: async ({ options, writer, scenario }) => {
      // First-prompt edit: no anchor to resume through.
      assert.equal(options.resumeFromScratch, true);
      assert.equal(options.resumeAnchorId, undefined);
      // The CLI starts a brand-new session. Announce it, as the runtime does.
      const newProviderSessionId = 'claude-restarted-thread';
      const newPath = path.join(scenario.projectPath, `${newProviderSessionId}.jsonl`);
      await writeJsonl(newPath, claudeNewConversationRows(newProviderSessionId, 'replacement-first', 'reply-first'));
      writer.setSessionId(newProviderSessionId);
      // The watcher picks the new transcript up on its next sweep; this is its
      // exact repository write (find the row by provider id, fill the path).
      sessionsDb.createSession(
        newProviderSessionId,
        'claude',
        scenario.projectPath,
        undefined,
        new Date().toISOString(),
        new Date().toISOString(),
        newPath,
      );
    },
  }, async (context) => {
    await context.sendFrame(editFrame('cl-u1', 'replacement-first'));
    assert.deepEqual(protocolErrors(context.socket), []);

    const binding = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(binding?.session_id, SESSION_ID, 'the app session id is stable');
    assert.equal(binding?.provider, 'claude');
    assert.equal(binding?.provider_session_id, 'claude-restarted-thread');
    assert.ok(binding?.jsonl_path?.endsWith('claude-restarted-thread.jsonl'));

    const after = await context.history();
    console.log(`continuity.claude.first-edit=${JSON.stringify(after)}`);
    // Only the new transcript is read: none of the abandoned conversation comes
    // along, which is what "start from empty context" means to the person.
    assert.deepEqual(after, ['user:replacement-first', 'assistant:reply-first']);
  });
});

// ---------------------------------------------------------------------------
// Codex — per-run, resident, and first-turn
// ---------------------------------------------------------------------------

const CODEX_BASE_THREAD = '01a1e300-0001-7000-8000-000000000001';
const CODEX_TURNS = [
  { prompt: 'first', answer: 'reply-first' },
  { prompt: 'second', answer: 'reply-second' },
  { prompt: 'third', answer: 'reply-third' },
];

test('Codex per-run: the real fork keeps the prefix, the reader follows the pointer, and a late old-thread write is refused', async () => {
  await withScenario({
    provider: 'codex',
    prepare: async ({ codexSessionsRoot }) => {
      return {
        transcriptPath: path.join(codexSessionsRoot, '2026', '10', '30', `rollout-2026-10-30T00-00-00-${CODEX_BASE_THREAD}.jsonl`),
        providerSessionId: CODEX_BASE_THREAD,
        rows: codexRolloutRows(CODEX_BASE_THREAD, CODEX_TURNS),
      };
    },
    onRuntimeRun: async ({ options, writer, scenario }) => {
      // Codex replaces its own binding during preparation, so the runtime is
      // given no Claude-style resume anchor.
      assert.equal(options.resumeAnchorId, undefined);
      assert.equal(options.resumeFromScratch, undefined);

      const binding = sessionsDb.getSessionById(SESSION_ID);
      const forkPath = binding?.jsonl_path;
      assert.ok(forkPath && forkPath !== scenario.basePath);
      // The replacement turn lands in the fork's own file, as the real CLI does.
      await appendJsonl(forkPath, codexReplacementRows(String(binding?.provider_session_id), await readForkCut(forkPath)));
      // The runtime announces the thread it is writing. After an edit the row
      // already names the fork; the announcement is an observation, not a
      // rebind, so it must leave the row alone.
      writer.setSessionId(String(binding?.provider_session_id));
    },
  }, async (context) => {
    const before = await context.history();
    console.log(`continuity.codex.before=${JSON.stringify(before)}`);
    assert.deepEqual(before, [
      'user:first', 'assistant:reply-first',
      'user:second', 'assistant:reply-second',
      'user:third', 'assistant:reply-third',
    ]);

    await context.sendFrame(editFrame('turn-2', 'replacement'));
    assert.deepEqual(protocolErrors(context.socket), []);
    assert.deepEqual(context.hosts.rewinds, [], 'a per-run Codex edit must not close a host');

    const binding = sessionsDb.getSessionById(SESSION_ID);
    const forkPath = binding?.jsonl_path as string;
    const forkThreadId = binding?.provider_session_id as string;
    assert.notEqual(forkThreadId, CODEX_BASE_THREAD);
    const forkRows = (await readFile(forkPath, 'utf8')).trim().split('\n');
    const forkText = forkRows.join('\n');
    console.log(`continuity.codex.fork.rows=${forkRows.length}`);
    console.log(`continuity.codex.fork.thread=${forkThreadId}`);
    // The CLI writes a pointer, not a copy: the fork file alone cannot contain
    // the kept turns. The assertions below can only pass because the reader
    // followed `forked_from_id` into the source rollout.
    assert.equal(forkText.includes('"text":"first"'), false);
    assert.equal(forkText.includes('"text":"reply-first"'), false);

    const after = await context.history();
    console.log(`continuity.codex.after=${JSON.stringify(after)}`);
    assert.deepEqual(after, [
      'user:first', 'assistant:reply-first',
      'user:replacement', 'assistant:reply-replacement',
    ]);
    assert.equal(after.filter((entry) => entry === 'user:second').length, 0);
    assert.equal(after.filter((entry) => entry === 'user:third').length, 0);
    assert.equal(after.filter((entry) => entry === 'user:replacement').length, 1);

    // Late old-frame control: an old run/host announcing the pre-edit thread
    // long after the fork must not move the binding back. This is the real
    // registry + writer + binding service path, not a direct repository call.
    const lateRun = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'codex',
      providerSessionId: CODEX_BASE_THREAD,
      connection: null,
      userId: null,
    });
    assert.ok(lateRun, 'the session must be idle between turns');
    lateRun!.writer.setSessionId(CODEX_BASE_THREAD);
    const afterLateWrite = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(afterLateWrite?.provider_session_id, forkThreadId, 'a retired thread must not be resumed');
    assert.equal(afterLateWrite?.jsonl_path, forkPath);
    chatRunRegistry.completeRunIfCurrent(lateRun!, { exitCode: 0 });

    const stillAfter = await context.history();
    assert.deepEqual(stillAfter, after);

    // Refresh + isolated restart.
    closeConnection();
    await initializeDatabase();
    const restarted = await context.history();
    console.log(`continuity.codex.restarted=${JSON.stringify(restarted)}`);
    assert.deepEqual(restarted, after);
  });
});

test('Codex resident: the old host is closed before the real fork, and the replacement continues on the new binding', async () => {
  await withScenario({
    provider: 'codex',
    resident: true,
    prepare: async ({ codexSessionsRoot }) => ({
      transcriptPath: path.join(codexSessionsRoot, '2026', '10', '30', `rollout-2026-10-30T00-00-00-${CODEX_BASE_THREAD}.jsonl`),
      providerSessionId: CODEX_BASE_THREAD,
      rows: codexRolloutRows(CODEX_BASE_THREAD, CODEX_TURNS),
    }),
    onRuntimeRun: async ({ scenario }) => {
      const binding = sessionsDb.getSessionById(SESSION_ID);
      const forkPath = binding?.jsonl_path as string;
      assert.ok(forkPath && forkPath !== scenario.basePath);
      await appendJsonl(forkPath, codexReplacementRows(String(binding?.provider_session_id), await readForkCut(forkPath)));
    },
  }, async (context) => {
    await context.sendFrame(editFrame('turn-2', 'replacement'));
    assert.deepEqual(protocolErrors(context.socket), []);

    // Close completes before the provider rewinds (which is where the fork
    // happens) and before the replacement run starts.
    assert.deepEqual(context.events, ['close-start', 'close-done', 'run']);
    assert.equal(context.hosts.truncatedBeforeClose, true);
    assert.deepEqual(context.hosts.rewinds, [SESSION_ID]);
    assert.equal(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    const binding = sessionsDb.getSessionById(SESSION_ID);
    assert.notEqual(binding?.provider_session_id, CODEX_BASE_THREAD);
    assert.ok(binding?.jsonl_path && binding.jsonl_path !== context.basePath);
    const forkRows = (await readFile(binding?.jsonl_path as string, 'utf8')).trim().split('\n');
    console.log(`continuity.codex.resident.fork.rows=${forkRows.length}`);

    const after = await context.history();
    console.log(`continuity.codex.resident.after=${JSON.stringify(after)}`);
    assert.deepEqual(after, [
      'user:first', 'assistant:reply-first',
      'user:replacement', 'assistant:reply-replacement',
    ]);
    assert.equal(after.filter((entry) => entry === 'user:second').length, 0);
    assert.equal(after.filter((entry) => entry === 'user:third').length, 0);
  });
});

test('Codex first prompt: the row is detached, the new thread is adopted, and the old history does not return', async () => {
  await withScenario({
    provider: 'codex',
    prepare: async ({ codexSessionsRoot }) => ({
      transcriptPath: path.join(codexSessionsRoot, '2026', '10', '30', `rollout-2026-10-30T00-00-00-${CODEX_BASE_THREAD}.jsonl`),
      providerSessionId: CODEX_BASE_THREAD,
      rows: codexRolloutRows(CODEX_BASE_THREAD, CODEX_TURNS),
    }),
    onRuntimeRun: async ({ writer, scenario }) => {
      // A first-prompt edit detaches the row; the next run opens a new thread.
      const detached = sessionsDb.getSessionById(SESSION_ID);
      assert.equal(detached?.provider_session_id, null);
      assert.equal(detached?.jsonl_path, null);

      const newThreadId = '01a1e301-0002-7000-8000-000000000002';
      const newPath = path.join(scenario.codexSessionsRoot, '2026', '10', '31', `rollout-2026-10-31T00-00-00-${newThreadId}.jsonl`);
      await writeJsonl(newPath, codexRolloutRows(newThreadId, [{ prompt: 'replacement-first', answer: 'reply-first' }]));
      // The watcher indexed the new rollout before the id was announced, which
      // is the duplicate row the discovery write merges (adopting its path).
      sessionsDb.createSession(
        newThreadId,
        'codex',
        scenario.projectPath,
        'New thread',
        new Date().toISOString(),
        new Date().toISOString(),
        newPath,
      );
      writer.setSessionId(newThreadId);
    },
  }, async (context) => {
    await context.sendFrame(editFrame('turn-1', 'replacement-first'));
    assert.deepEqual(protocolErrors(context.socket), []);

    const binding = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(binding?.session_id, SESSION_ID);
    assert.equal(binding?.provider, 'codex');
    assert.equal(binding?.provider_session_id, '01a1e301-0002-7000-8000-000000000002');
    assert.ok(binding?.jsonl_path?.endsWith('01a1e301-0002-7000-8000-000000000002.jsonl'));

    const after = await context.history();
    console.log(`continuity.codex.first-edit=${JSON.stringify(after)}`);
    assert.deepEqual(after, ['user:replacement-first', 'assistant:reply-first']);
  });
});

// ---------------------------------------------------------------------------
// Negative control
// ---------------------------------------------------------------------------

test('negative control: a host that will not close stops the edit, leaving history and binding as they were', async () => {
  await withScenario({
    provider: 'claude',
    resident: true,
    failClose: true,
    prepare: async ({ projectPath }) => {
      const providerSessionId = 'claude-failing-host-thread';
      return {
        transcriptPath: path.join(projectPath, `${providerSessionId}.jsonl`),
        providerSessionId,
        rows: claudeTranscriptRows(providerSessionId),
      };
    },
    onRuntimeRun: async ({ scenario }) => {
      // If the gateway ignored the close failure, this write would happen and
      // the history assertions below would fail: the control is discriminating.
      await appendClaudeRows(
        scenario.transcriptPath,
        scenario.providerSessionId,
        [
          { type: 'user', uuid: 'cl-u2r', parentUuid: 'cl-a1', text: 'replacement' },
          { type: 'assistant', uuid: 'cl-a2r', parentUuid: 'cl-u2r', text: 'reply-replacement' },
        ],
        20,
      );
    },
  }, async (context) => {
    const before = await context.history();
    await context.sendFrame(editFrame('cl-u2', 'replacement'));

    const errors = protocolErrors(context.socket);
    console.log(`continuity.negative.control=${JSON.stringify(errors.map((entry) => entry.code))}`);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'EDIT_REWIND_FAILED');
    assert.ok(String(errors[0].error ?? '').includes('did not close'));
    assert.deepEqual(context.runs, [], 'the replacement run must never start');
    assert.deepEqual(context.events, ['close-start']);
    assert.equal(context.hosts.truncatedBeforeClose, true);

    const after = await context.history();
    assert.deepEqual(after, before, 'a refused edit must not change the conversation');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.provider_session_id, 'claude-failing-host-thread');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.jsonl_path, context.basePath);
  });
});
