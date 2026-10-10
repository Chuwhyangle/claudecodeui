/**
 * Criterion for AC-209: the session outline read surface (`GET
 * /api/providers/sessions/:sessionId/outline`) must return every user turn of a
 * conversation in absolute order, with a stable index and a preview, derived
 * from the same full history the paginated messages route counts its `total`
 * from.
 *
 * Everything below runs against a real Claude JSONL transcript fixture and the
 * real provider/cache/service — nothing mocks the filesystem. The fixture
 * deliberately holds every shape that could make the outline disagree with the
 * drawn transcript: a compaction summary (which normalizes to an assistant row),
 * an abandoned prompt branch (dropped by superseded-branch pruning), a subagent
 * transcript (hung off its spawning tool call, never a top-level turn), a tool
 * result that folds back onto its call, and two identical checklist snapshots
 * (one folds away). It also holds a pair of user prompts that share one
 * millisecond timestamp, so a reader that dedupes by time would have to drop
 * one of them.
 *
 * Two further rows are turns nobody typed and must not be reported as the
 * reader's inputs: a Monitor event (a `<task-notification>` with no
 * `<tool-use-id>`, so nothing folds it onto a card) and a message another
 * session sent. Both normalize to `kind: 'text'`, `role: 'user'`; only the
 * first-class `origin` the CLI writes on each one tells them apart from a typed
 * prompt, so an outline that filters on transport shape alone reports them both.
 *
 * The expected turn list is not hand-written where it can be read: the tests
 * compare the outline against the provider's own full read, and separately
 * pin the specific ids/previews/order the fixture must produce. That is what
 * makes the "count raw JSONL rows", "use the tail offset as index" and "dedupe
 * by timestamp" false forms red rather than merely different.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes `IS_PLATFORM` on first import, so the environment
// is set before any aliased module is pulled in. Static imports are hoisted
// above this code, so every application module below comes in dynamically —
// the order `session-hosts/tests/lifecycle-mode.test.ts` established.
const TEST_JWT_SECRET = 'session-turn-outline-test-secret';
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');
const { providerRoutes, sessionsService } = await import('@/modules/providers/index.js');
const { AppError } = await import('@/shared/utils.js');

const SESSION_ID = 'outline-session-1';
const AGENT_ID = 'outlineagent0001';
const AGENT_TOOL_USE_ID = 'toolu_outline_agent';
const BASH_TOOL_USE_ID = 'toolu_outline_bash';

// The four live user prompts the outline must report, in the order the provider
// sorts them (by timestamp, stable), with the preview each one yields.
const FIRST_PROMPT = 'First question: how does the outline endpoint count user turns?';
const SECOND_PROMPT = 'Second question: with numbers 1, 2, 3 and a\nline break at the end';
const SAME_MS_PROMPT_A = 'Same-millisecond question A';
const SAME_MS_PROMPT_B = 'Same-millisecond question B';

const EXPECTED_TURN_IDS = ['u-prompt-1', 'u-prompt-2', 'u-same-ms-a', 'u-same-ms-b'];
const EXPECTED_PREVIEWS = [
  FIRST_PROMPT,
  'Second question: with numbers 1, 2, 3 and a line break at the end',
  SAME_MS_PROMPT_A,
  SAME_MS_PROMPT_B,
];
const SAME_MS_TIMESTAMP = '2026-09-01T11:00:00.000Z';

type ClaudeRow = Record<string, unknown>;

function userPromptRow(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  text: string,
  extra: ClaudeRow = {},
): ClaudeRow {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  };
}

function assistantTextRow(uuid: string, parentUuid: string, timestamp: string, text: string): ClaudeRow {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function assistantToolRow(
  uuid: string,
  parentUuid: string,
  timestamp: string,
  toolName: string,
  toolId: string,
  input: unknown,
): ClaudeRow {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: toolName, input }] },
  };
}

function toolResultRow(
  uuid: string,
  parentUuid: string,
  timestamp: string,
  toolId: string,
  content: string,
  extra: ClaudeRow = {},
): ClaudeRow {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] },
    ...extra,
  };
}

/** Rows in append order; the uuid chain and timestamps both walk forward. */
function buildParentRows(): ClaudeRow[] {
  return [
    userPromptRow('u-prompt-1', null, '2026-09-01T10:00:00.000Z', FIRST_PROMPT),
    assistantTextRow('a-reply-1', 'u-prompt-1', '2026-09-01T10:00:01.000Z', 'It walks the normalized transcript.'),
    // A compaction summary is a synthetic user row that the provider relabels
    // to `assistant`, so it must never surface as a user turn.
    userPromptRow('u-compact', 'a-reply-1', '2026-09-01T10:00:02.000Z', '', {
      isCompactSummary: true,
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context.',
      },
    }),
    // Two prompts share `u-compact`; the earlier is the abandoned branch.
    userPromptRow('u-draft', 'u-compact', '2026-09-01T10:00:03.000Z', 'abandoned draft question'),
    userPromptRow('u-prompt-2', 'u-compact', '2026-09-01T10:00:04.000Z', SECOND_PROMPT),
    assistantToolRow('a-tool-bash', 'u-prompt-2', '2026-09-01T10:00:05.000Z', 'Bash', BASH_TOOL_USE_ID, { command: 'echo hi' }),
    // This result folds back onto the Bash call and is not a drawn row.
    toolResultRow('u-bash-result', 'a-tool-bash', '2026-09-01T10:00:06.000Z', BASH_TOOL_USE_ID, 'hi\n'),
    // Two identical checklist snapshots in a row: the later supersedes the
    // first, so only one survives `prepareTranscriptMessages`.
    assistantToolRow('a-check-1', 'u-bash-result', '2026-09-01T10:00:07.000Z', 'TodoWrite', 'toolu_todo_1', {
      todos: [{ content: 'step one', status: 'in_progress', activeForm: 'Doing step one' }],
    }),
    assistantToolRow('a-check-2', 'a-check-1', '2026-09-01T10:00:08.000Z', 'TodoWrite', 'toolu_todo_2', {
      todos: [{ content: 'step one', status: 'in_progress', activeForm: 'Doing step one' }],
    }),
    assistantToolRow('a-agent', 'a-check-2', '2026-09-01T10:00:09.000Z', 'Agent', AGENT_TOOL_USE_ID, {
      subagent_type: 'Explore',
      description: 'Survey the repo',
      prompt: 'Look around',
    }),
    toolResultRow(
      'u-agent-ack',
      'a-agent',
      '2026-09-01T10:00:10.000Z',
      AGENT_TOOL_USE_ID,
      'Async agent launched successfully. agentId: internal bookkeeping',
      {
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: AGENT_ID,
          description: 'Survey the repo',
          resolvedModel: 'claude-opus-5',
        },
      },
    ),
    userPromptRow(
      'u-notification',
      'u-agent-ack',
      '2026-09-01T10:00:11.000Z',
      [
        '<task-notification>',
        `<task-id>${AGENT_ID}</task-id>`,
        `<tool-use-id>${AGENT_TOOL_USE_ID}</tool-use-id>`,
        '<status>completed</status>',
        '<summary>Agent "Survey the repo" finished</summary>',
        '<result>The repo has two packages.</result>',
        '</task-notification>',
      ].join('\n'),
    ),
    assistantTextRow('a-after-agent', 'u-notification', '2026-09-01T10:00:12.000Z', 'The agent finished.'),
    // A Monitor event: the same envelope with no `<tool-use-id>`, so nothing
    // folds it onto a tool card and it reaches the outline as a plain user row.
    // It carries the first-class `origin` the CLI writes on every
    // `<task-notification>` row, and that fact — not its content — is what must
    // keep it out of the turn list.
    monitorEventRow('u-monitor-event', 'a-after-agent', '2026-09-01T10:00:13.000Z'),
    // A message another session sent: real content the `isMeta` gate exempts
    // because it carries a first-class peer `origin`. It belongs in the
    // transcript, but it was not typed by this session's reader, so it must not
    // be reported as one of "your inputs".
    peerMessageRow(
      'u-peer',
      'u-monitor-event',
      '2026-09-01T10:00:14.000Z',
      'Peer question: what changed in the outline?',
      'peer-session',
    ),
    // Same-millisecond pair: distinct parents, so neither is a superseded
    // sibling, and a timestamp-deduping reader would lose one.
    userPromptRow('u-same-ms-a', 'u-peer', SAME_MS_TIMESTAMP, SAME_MS_PROMPT_A),
    assistantTextRow('a-mid', 'u-same-ms-a', '2026-09-01T11:00:00.500Z', 'Between the two.'),
    userPromptRow('u-same-ms-b', 'a-mid', SAME_MS_TIMESTAMP, SAME_MS_PROMPT_B),
    assistantTextRow('a-last', 'u-same-ms-b', '2026-09-01T11:00:01.000Z', 'Done.'),
  ];
}

/**
 * A Monitor event exactly as the harness injects it: a `user`-role
 * `<task-notification>` string row whose body has no `<tool-use-id>`, plus the
 * first-class `origin` every such row carries. String content, not the array
 * `userPromptRow` builds, because that is the shape the transcript persists.
 */
function monitorEventRow(uuid: string, parentUuid: string, timestamp: string): ClaudeRow {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: [
        '<task-notification>',
        '<task-id>monitor-outline-1</task-id>',
        '<status>completed</status>',
        '<summary>Monitor event: "build finished"</summary>',
        '<event>build finished</event>',
        '</task-notification>',
      ].join('\n'),
    },
  };
}

/** A message another session sent, in the transport envelope the CLI writes. */
function peerMessageRow(
  uuid: string,
  parentUuid: string,
  timestamp: string,
  body: string,
  name: string,
): ClaudeRow {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId: SESSION_ID,
    isMeta: true,
    origin: { kind: 'peer', name },
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/peer.sock" from-name="${name}" from-mode="bypass">\n${body}\n</cross-session-message>`,
    },
  };
}

/**
 * Writes the parent transcript plus the subagent sidecar pair current Claude
 * versions produce (`<project>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}`),
 * so the subagent's own rows are read from a separate file exactly as in
 * production and never leak into the parent turn list.
 */
async function writeOutlineTranscript(projectDirectory: string, rows: ClaudeRow[]): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const subagentDirectory = path.join(projectDirectory, SESSION_ID, 'subagents');
  await mkdir(subagentDirectory, { recursive: true });
  const agentRows = [
    {
      type: 'assistant',
      isSidechain: true,
      agentId: AGENT_ID,
      timestamp: '2026-09-01T10:00:30.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'Starting the survey.' },
          { type: 'tool_use', id: 'toolu_child_1', name: 'Read', input: { file_path: '/repo/package.json' } },
        ],
      },
    },
    {
      type: 'user',
      isSidechain: true,
      agentId: AGENT_ID,
      timestamp: '2026-09-01T10:00:31.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_child_1', content: '{"name":"repo"}' }],
      },
    },
  ];
  await writeFile(
    path.join(subagentDirectory, `agent-${AGENT_ID}.jsonl`),
    `${agentRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    path.join(subagentDirectory, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'Explore', description: 'Survey the repo', toolUseId: AGENT_TOOL_USE_ID, spawnDepth: 1 }),
    'utf8',
  );

  return transcriptPath;
}

/** A throwaway database, as the session-hosts route tests isolate theirs. */
async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-turn-outline-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

test('the outline reports every user turn in absolute order, from the same cache as pagination', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-turn-outline-'));

  try {
    await withIsolatedDatabase(async () => {
      const transcriptPath = await writeOutlineTranscript(projectDirectory, buildParentRows());
      sessionsDb.createSession(SESSION_ID, 'claude', projectDirectory, 'Outline session', undefined, undefined, transcriptPath);

      // The full normalized array the outline must agree with, read through the
      // paginated path so the comparison is against a real API reading rather
      // than a hand-copied expectation.
      const full = await sessionsService.fetchHistory(SESSION_ID, { limit: null, offset: 0 });
      const expectedIndexes = EXPECTED_TURN_IDS.map((id) => full.messages.findIndex(
        (message) => (message.transcriptAnchorId ?? message.id) === id,
      ));

      const outline = await sessionsService.fetchOutline(SESSION_ID);

      // `total` is the pagination total — the same full array, not a count of
      // raw JSONL rows.
      assert.equal(outline.total, full.total);
      assert.ok(outline.total > EXPECTED_TURN_IDS.length, 'assistant and tool rows must be counted in total');

      // Order and identity: exactly the live user prompts, and the same-millisecond
      // pair both present under distinct ids.
      assert.deepEqual(outline.turns.map((turn) => turn.id), EXPECTED_TURN_IDS);
      assert.notEqual(outline.turns[2].id, outline.turns[3].id);
      assert.equal(outline.turns[2].timestamp, SAME_MS_TIMESTAMP);
      assert.equal(outline.turns[3].timestamp, SAME_MS_TIMESTAMP);

      // Neither host-opened row is "your input": the Monitor event and the peer
      // message both normalize to `kind: 'text'`, `role: 'user'`, so only the
      // `origin` they carry can exclude them. Asserted by id, in addition to the
      // exact-list equality above, so the reason reds even if the expectation
      // list were ever widened.
      assert.ok(
        outline.turns.every((turn) => turn.id !== 'u-monitor-event'),
        'a Monitor event a person did not type must not be a user turn',
      );
      assert.ok(
        outline.turns.every((turn) => turn.id !== 'u-peer'),
        'a cross-session peer message a person did not type must not be a user turn',
      );

      // The first message of the conversation is a user prompt, so its absolute
      // index is 0 — a tail offset would report something else entirely.
      assert.equal(outline.turns[0].index, 0);
      assert.deepEqual(outline.turns.map((turn) => turn.index), expectedIndexes);

      assert.deepEqual(outline.turns.map((turn) => turn.timestamp), [
        '2026-09-01T10:00:00.000Z',
        '2026-09-01T10:00:04.000Z',
        SAME_MS_TIMESTAMP,
        SAME_MS_TIMESTAMP,
      ]);
      assert.deepEqual(outline.turns.map((turn) => turn.preview), EXPECTED_PREVIEWS);
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('the outline indexes survive an append: an earlier turn keeps its position', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-turn-outline-append-'));

  try {
    await withIsolatedDatabase(async () => {
      const transcriptPath = await writeOutlineTranscript(projectDirectory, buildParentRows());
      sessionsDb.createSession(SESSION_ID, 'claude', projectDirectory, 'Outline append session', undefined, undefined, transcriptPath);

      const before = await sessionsService.fetchOutline(SESSION_ID);
      const pageBefore = await sessionsService.fetchHistory(SESSION_ID, { limit: 20, offset: 0 });
      assert.equal(before.total, pageBefore.total);

      await appendFile(
        transcriptPath,
        `${[
          assistantTextRow('a-append', 'a-last', '2026-09-01T12:00:00.000Z', 'A later reply.'),
          userPromptRow('u-append', 'a-append', '2026-09-01T12:00:01.000Z', 'A question asked after the first read'),
        ].map((row) => JSON.stringify(row)).join('\n')}\n`,
        'utf8',
      );

      const after = await sessionsService.fetchOutline(SESSION_ID);

      assert.equal(after.total, before.total + 2);
      assert.equal(after.turns.length, before.turns.length + 1);
      // Every earlier turn keeps its id AND its absolute index; only the new
      // turn is appended.
      assert.deepEqual(after.turns.slice(0, before.turns.length), before.turns);
      assert.equal(after.turns[after.turns.length - 1].id, 'u-append');
      assert.equal(after.turns[after.turns.length - 1].preview, 'A question asked after the first read');
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

type AuthHarness = {
  baseUrl: string;
  token: string;
};

function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = createHmac('sha256', TEST_JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function addUser(id: number, username: string): string {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
  return signToken({ userId: id, username });
}

/**
 * The provider router mounted exactly as `server/index.ts` mounts it — the real
 * token middleware in front, the production error middleware after — so the
 * outline route's auth contract is read from the same wiring that ships.
 */
async function withAuthServer(run: (harness: AuthHarness) => Promise<void>, seed: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-turn-outline-auth-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  const token = addUser(1, 'outline-tester');
  await seed();

  const app = express();
  app.use(express.json());
  app.use('/api/providers', authenticateToken, providerRoutes);
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

test('the outline route refuses an unauthenticated call exactly as the messages route does', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-turn-outline-auth-'));

  try {
    await withAuthServer(
      async ({ baseUrl, token }) => {
        const outlineUnauthenticated = await fetch(`${baseUrl}/api/providers/sessions/${SESSION_ID}/outline`);
        const messagesUnauthenticated = await fetch(`${baseUrl}/api/providers/sessions/${SESSION_ID}/messages`);
        const outlineRefusal = await outlineUnauthenticated.json() as { error: string; code: string };
        const messagesRefusal = await messagesUnauthenticated.json() as { error: string; code: string };

        assert.equal(outlineUnauthenticated.status, 401);
        assert.equal(outlineUnauthenticated.status, messagesUnauthenticated.status);
        assert.deepEqual(outlineRefusal, messagesRefusal);
        assert.equal(outlineRefusal.code, 'AUTH_TOKEN_INVALID');

        // Authenticated: the route answers the outline envelope, over real HTTP.
        const outlineResponse = await fetch(`${baseUrl}/api/providers/sessions/${SESSION_ID}/outline`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const outlinePayload = await outlineResponse.json() as {
          success: boolean;
          data: { total: number; turns: Array<{ id: string; index: number; timestamp: string; preview: string }> };
        };
        assert.equal(outlineResponse.status, 200);
        assert.equal(outlinePayload.success, true);
        assert.deepEqual(outlinePayload.data.turns.map((turn) => turn.id), EXPECTED_TURN_IDS);
        assert.equal(outlinePayload.data.total > EXPECTED_TURN_IDS.length, true);

        // The HTTP leg answers with the SAME reading as the service call the
        // route delegates to — id sequence, indexes, timestamps and previews,
        // verbatim — and neither host-opened row is among them. The route adds
        // auth and an envelope; it must not add or drop a turn of its own.
        const direct = await sessionsService.fetchOutline(SESSION_ID);
        assert.deepEqual(outlinePayload.data.turns, direct.turns);
        assert.deepEqual(outlinePayload.data.total, direct.total);
        const ids = outlinePayload.data.turns.map((turn) => turn.id);
        assert.ok(!ids.includes('u-monitor-event'), 'the Monitor event is not an anchor the outline may report');
        assert.ok(!ids.includes('u-peer'), 'the peer message is not an anchor the outline may report');
      },
      async () => {
        const transcriptPath = await writeOutlineTranscript(projectDirectory, buildParentRows());
        sessionsDb.createSession(SESSION_ID, 'claude', projectDirectory, 'Outline auth session', undefined, undefined, transcriptPath);
      },
    );
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
