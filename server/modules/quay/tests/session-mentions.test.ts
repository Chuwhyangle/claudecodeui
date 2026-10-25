import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createQuayRouter } from '../quay.routes.js';
import { createQuayService, type QuayCommandRunner } from '../quay.service.js';
import {
  createSessionMentionsService,
  type SessionMentionsDependencies,
  type SessionMentionsGoalRow,
  type SessionMentionsReading,
  type SessionMentionsService,
  type SessionMentionsTaskRow,
} from '../session-mentions.service.js';

/**
 * The session → mentions reading (gap-quay-session-mentions-and-lanes-only-readings).
 *
 * WHAT THIS FILE PROVES:
 *
 *   AC1 — only user/assistant MESSAGE TEXT is scanned. Six carriers each hold one id against the
 *         same vocabulary; only the assistant `text` block and the user string content hit.
 *         Tool inputs, tool results, thinking blocks and attachment rows do not — so an
 *         implementation that treats "any string in the row" as prose reds here.
 *   AC2 — closed-set exact matching: `gap-foo` does not match text `gap-foo-bar`, case folds to
 *         the vocabulary's canonical spelling, backticks/Chinese punctuation/a sentence period/
 *         a `quay://` reference all delimit, and neither `AC-NNN` nor an unknown kebab word hits.
 *   AC3 — whole-transcript + incremental scanning: a 3000-line transcript reports a mention on
 *         line 1; an append reads from the consumed byte offset (never from 0); a replaced,
 *         shorter file rescans from 0; a vocabulary that grows between polls reports an id that
 *         was already in the scanned text without re-reading it.
 *   AC4 — the join: task status from the index, `phase` from the in-flight lanes, task → `goal_ac`
 *         → criterion row → goal, a broken `goal_ac` answering `null` rather than throwing, all
 *         three goal provenances, and deterministic order.
 *   AC5 — the routes: 400 `session-id-required`, 503 `session-mentions-unavailable`, 404
 *         `project-or-session-not-found`, 200 with the documented body; plus the lanes route's
 *         200 shape and its illegal-window fallback.
 *
 * The service is driven through its factory with every side effect injected, so no subprocess,
 * filesystem or lane state is touched. It is a server test: `tsx --test` drives it.
 */

// --------------------------- FIXTURES ------------

/** The JSONL a transcript file holds, newline-terminated like the real one. */
function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** One transcript row whose assistant message carries a single `text` block. */
function assistantText(text: string, timestamp?: string): unknown {
  return {
    type: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** One transcript row whose user message content is a plain string. */
function userText(text: string, timestamp?: string): unknown {
  return {
    type: 'user',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: 'user', content: text },
  };
}

/** One assistant row whose only content is a tool call carrying `text` in its input. */
function assistantToolUse(text: string, timestamp?: string): unknown {
  return {
    type: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: `echo ${text}` } }],
    },
  };
}

/** One user row whose only content is a `tool_result` block (its inner text block included). */
function userToolResult(text: string, timestamp?: string): unknown {
  return {
    type: 'user',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text }] },
      ],
    },
  };
}

/** One assistant row whose only content is a thinking block. */
function assistantThinking(thinking: string, timestamp?: string): unknown {
  return {
    type: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
  };
}

/** One attachment row — not a message, even though it carries a message-shaped content. */
function attachment(text: string, timestamp?: string): unknown {
  return {
    type: 'attachment',
    ...(timestamp === undefined ? {} : { timestamp }),
    message: { role: 'user', content: text },
  };
}

/** One mutable transcript file the scan reads in byte ranges; records every read's start. */
type TranscriptFile = {
  readonly text: string;
  readonly reads: number[];
  append(rows: readonly unknown[]): void;
  replace(text: string): void;
  size(): Promise<number | null>;
  read(start: number): Promise<string | null>;
};

function transcriptFile(rows: readonly unknown[]): TranscriptFile {
  let text = jsonl(rows);
  const reads: number[] = [];
  return {
    get text() {
      return text;
    },
    reads,
    append(nextRows) {
      text += jsonl(nextRows);
    },
    replace(nextText) {
      text = nextText;
    },
    async size() {
      return Buffer.byteLength(text, 'utf8');
    },
    async read(start) {
      reads.push(start);
      return Buffer.from(text, 'utf8').subarray(start).toString('utf8');
    },
  };
}

/** One packed lane interval, in the shape `quay lanes --json` prints. */
function laneInterval(taskId: string, phase: string | null): {
  taskId: string;
  runId: string;
  startMs: number;
  endMs: number;
  phase: string | null;
  finalState: string | null;
  fanInOutcome: string | null;
} {
  return {
    taskId,
    runId: `run-${taskId}`,
    startMs: 1_000,
    endMs: 2_000,
    phase,
    finalState: phase === null ? 'done' : null,
    fanInOutcome: null,
  };
}

/** A lane document carrying one lane of the given intervals. */
function lanesOf(intervals: ReturnType<typeof laneInterval>[]): {
  windowHours: number;
  nowMs: number;
  lanes: ReturnType<typeof laneInterval>[][];
  overflow: number;
} {
  return { windowHours: 3, nowMs: 2_000, lanes: [intervals], overflow: 0 };
}

/** A task-index row with the mention join's four fields. */
function taskRow(taskId: string, options: { title?: string; status?: string; goalAc?: string | null } = {}): SessionMentionsTaskRow {
  return {
    taskId,
    title: options.title ?? `title of ${taskId}`,
    status: options.status ?? 'ready',
    goalAc: options.goalAc ?? null,
  };
}

type Harness = {
  service: SessionMentionsService;
  file: TranscriptFile;
  /** The mutable vocabulary the deps read on every request (so a test can grow it). */
  taskRows: SessionMentionsTaskRow[];
  goalRows: SessionMentionsGoalRow[];
};

/**
 * A service over one transcript stub and the injected index/goal/lane readings.
 *
 * The dependency closures answer from the harness arrays, so pushing a row between two requests
 * is exactly the "a task was filed mid-conversation" case the cache must not hide.
 */
function createHarness(options: {
  rows?: readonly unknown[];
  file?: TranscriptFile;
  taskRows?: SessionMentionsTaskRow[];
  goalRows?: SessionMentionsGoalRow[];
  lanes?: ReturnType<typeof lanesOf> | null;
  unknownProject?: boolean;
  missingTranscript?: boolean;
}): Harness {
  const file = options.file ?? transcriptFile(options.rows ?? []);
  const taskRows = options.taskRows ?? [];
  const goalRows = options.goalRows ?? [];

  const dependencies: SessionMentionsDependencies = {
    resolveProjectPath(projectId) {
      return options.unknownProject === true || projectId !== 'project-1' ? null : '/repo';
    },
    resolveTranscriptPath() {
      return options.missingTranscript === true ? null : '/transcripts/session-1.jsonl';
    },
    transcriptSize: () => file.size(),
    readTranscriptRange: (_path, start) => file.read(start),
    readTaskRows: async () => taskRows,
    readGoalRows: async () => goalRows,
    readLanes: async () => options.lanes ?? null,
    now: () => Date.parse('2026-10-25T12:00:00.000Z'),
  };

  return {
    service: createSessionMentionsService(dependencies),
    file,
    taskRows,
    goalRows,
  };
}

/** Reads the one session the harness stubs, asserting it is not the `null` (unknown) arm. */
async function read(harness: Harness): Promise<SessionMentionsReading> {
  const reading = await harness.service.readSessionMentions({
    projectId: 'project-1',
    sessionId: 'session-1',
  });
  assert.ok(reading !== null, 'the stubbed project/session must produce a reading');
  return reading;
}

/** The mentioned task ids, in the reading's order. */
function mentionedTaskIds(reading: SessionMentionsReading): string[] {
  return reading.tasks.map((entry) => entry.taskId);
}

// --------------------------- AC1: MESSAGE TEXT ONLY ------------

test('AC1 — only user/assistant message text is scanned; tool, thinking and attachment carriers are not', async () => {
  // Six carriers, six distinct ids, one vocabulary. If the scan took any string in the row, the
  // last four exclusions would each appear as a mention.
  const vocabulary = [
    'gap-assistant-text',
    'gap-user-content',
    'gap-tool-input',
    'gap-tool-result',
    'gap-thinking',
    'gap-attachment',
  ].map((taskId) => taskRow(taskId));

  const harness = createHarness({
    rows: [
      assistantText('the first words name gap-assistant-text', '2026-10-25T10:00:01.000Z'),
      userText('and the reply names gap-user-content', '2026-10-25T10:00:02.000Z'),
      assistantToolUse('gap-tool-input', '2026-10-25T10:00:03.000Z'),
      userToolResult('gap-tool-result', '2026-10-25T10:00:04.000Z'),
      assistantThinking('gap-thinking', '2026-10-25T10:00:05.000Z'),
      attachment('gap-attachment', '2026-10-25T10:00:06.000Z'),
    ],
    taskRows: vocabulary,
  });

  const reading = await read(harness);

  assert.deepEqual(
    mentionedTaskIds(reading),
    ['gap-user-content', 'gap-assistant-text'],
    'only the assistant text block and the user string content are prose; the other four carriers are not',
  );
  assert.deepEqual(
    reading.tasks.map((entry) => entry.mentionCount),
    [1, 1],
  );
  assert.deepEqual(
    reading.tasks.map((entry) => entry.lastMentionAt),
    ['2026-10-25T10:00:02.000Z', '2026-10-25T10:00:01.000Z'],
    'the mention instant is the hit row’s own timestamp',
  );
});

// --------------------------- AC2: CLOSED-SET EXACT MATCH ------------

test('AC2 — a longer id does not match a shorter vocabulary entry, and a vocabulary holding both matches only the longer', async () => {
  const both = createHarness({
    rows: [assistantText('only the longer one is written: gap-foo-bar')],
    taskRows: [taskRow('gap-foo'), taskRow('gap-foo-bar')],
  });
  assert.deepEqual(mentionedTaskIds(await read(both)), ['gap-foo-bar']);

  const shorterOnly = createHarness({
    rows: [assistantText('still the longer one: gap-foo-bar')],
    taskRows: [taskRow('gap-foo')],
  });
  assert.deepEqual(
    mentionedTaskIds(await read(shorterOnly)),
    [],
    'closed-set exact match: gap-foo is not a prefix rule',
  );
});

test('AC2 — goal ids match case-insensitively and the reading uses the vocabulary’s canonical spelling', async () => {
  const harness = createHarness({
    rows: [assistantText('the goal was goal-049, and later GOAL-049 again')],
    goalRows: [{ id: 'GOAL-049', title: 'the goal', status: 'active', kind: 'goal', goal: null }],
  });

  const reading = await read(harness);
  assert.deepEqual(
    reading.goals.map((goal) => goal.goalId),
    ['GOAL-049'],
    'both spellings name the one goal, printed canonically',
  );
  assert.equal(reading.goals[0].mentionedDirectly, true);
  assert.equal(reading.goals[0].viaTaskCount, 0);
});

test('AC2 — backticks, Chinese punctuation, a sentence period and a quay:// reference all delimit an id', async () => {
  const ids = ['gap-backtick', 'gap-paren', 'gap-period', 'gap-sentence', 'gap-uri'];
  const harness = createHarness({
    rows: [assistantText('`gap-backtick` 与（gap-paren），gap-period。还有 gap-sentence. 见 quay://p/task/gap-uri')],
    taskRows: ids.map((taskId) => taskRow(taskId)),
  });

  assert.deepEqual(mentionedTaskIds(await read(harness)).sort(), [...ids].sort());
});

test('AC2 — AC-NNN is not part of the vocabulary and an unknown kebab word does not hit', async () => {
  const harness = createHarness({
    rows: [assistantText('AC-417 and gap-not-in-the-index')],
    taskRows: [taskRow('gap-known')],
    goalRows: [
      { id: 'GOAL-049', title: 'the goal', status: 'active', kind: 'goal', goal: null },
      { id: 'AC-417', title: 'a criterion', status: 'achieved', kind: 'criterion', goal: 'GOAL-049' },
    ],
  });

  const reading = await read(harness);
  assert.deepEqual(reading.tasks, []);
  assert.deepEqual(reading.goals, [], 'a criterion id is not a goal mention');
});

// --------------------------- AC3: WHOLE TRANSCRIPT + INCREMENTAL ------------

test('AC3 — a single mention on line 1 of a 3000-line transcript is still reported', async () => {
  const filler = Array.from({ length: 3000 }, (_unused, index) => assistantText(`filler line ${index}`));
  const rows = [assistantText('the only mention: gap-buried'), ...filler];
  assert.ok(rows.length > 3000, 'the fixture is the full-transcript case, not a recent-N window');

  const harness = createHarness({ rows, taskRows: [taskRow('gap-buried')] });
  assert.deepEqual(mentionedTaskIds(await read(harness)), ['gap-buried']);
});

test('AC3 — an append is read from the consumed byte offset, and the counts grow with it', async () => {
  const file = transcriptFile([assistantText('first: gap-one')]);
  const harness = createHarness({ file, taskRows: [taskRow('gap-one'), taskRow('gap-two')] });
  const initialBytes = Buffer.byteLength(file.text, 'utf8');

  const first = await read(harness);
  assert.deepEqual(mentionedTaskIds(first), ['gap-one']);
  assert.deepEqual(file.reads, [0], 'the first read starts at 0');

  file.append([assistantText('second: gap-one again, and gap-two')]);
  const second = await read(harness);

  assert.deepEqual(
    file.reads,
    [0, initialBytes],
    'the second read starts exactly where the first consumed (a line boundary), not at 0',
  );
  assert.ok(file.reads[1] > 0);
  const counts = new Map(second.tasks.map((entry) => [entry.taskId, entry.mentionCount]));
  assert.equal(counts.get('gap-one'), 2, 'the earlier mention is not re-counted or lost');
  assert.equal(counts.get('gap-two'), 1);
});

test('AC3 — a transcript replaced by shorter content is rescanned from 0', async () => {
  const file = transcriptFile([assistantText('a much longer first transcript body that names gap-old')]);
  const harness = createHarness({ file, taskRows: [taskRow('gap-old'), taskRow('gap-new')] });
  assert.deepEqual(mentionedTaskIds(await read(harness)), ['gap-old']);

  file.replace(jsonl([assistantText('new: gap-new')]));
  const reading = await read(harness);

  assert.deepEqual(mentionedTaskIds(reading), ['gap-new'], 'the old scan is discarded, not merged');
  assert.deepEqual(file.reads, [0, 0], 'the replacement is read from byte 0');
});

test('AC3 — a vocabulary that grows between polls reports an id already present in the scanned text', async () => {
  const file = transcriptFile([assistantText('early words already name gap-later')]);
  const harness = createHarness({ file });

  const before = await read(harness);
  assert.deepEqual(mentionedTaskIds(before), [], 'not filed yet, so not in the vocabulary');

  // The task is filed mid-conversation; nothing new is appended to the transcript.
  harness.taskRows.push(taskRow('gap-later', { status: 'todo' }));
  const after = await read(harness);

  assert.deepEqual(mentionedTaskIds(after), ['gap-later'], 'the cached tokens are joined against the current vocabulary');
  assert.deepEqual(file.reads, [0], 'no re-read was needed to answer it');
  assert.equal(after.tasks[0].status, 'todo');
});

// --------------------------- AC4: THE JOIN ------------

test('AC4 — status from the index, phase from in-flight lanes, and task → goal_ac → AC row → goal', async () => {
  const harness = createHarness({
    rows: [
      assistantText('t-1 runs, t-2 landed, t-3 is a draft, t-4 runs too, goal GOAL-200', '2026-10-25T09:00:00.000Z'),
    ],
    taskRows: [
      taskRow('t-1', { status: 'ready', goalAc: 'AC-100' }),
      taskRow('t-2', { status: 'done', goalAc: 'AC-999' }),
      taskRow('t-3', { status: 'todo' }),
      taskRow('t-4', { status: 'ready', goalAc: 'AC-101' }),
    ],
    goalRows: [
      { id: 'GOAL-100', title: 'goal one hundred', status: 'active', kind: 'goal', goal: null },
      { id: 'GOAL-200', title: 'goal two hundred', status: 'achieved', kind: 'goal', goal: null },
      { id: 'AC-100', title: 'criterion', status: 'achieved', kind: 'criterion', goal: 'GOAL-100' },
      { id: 'AC-101', title: 'criterion', status: 'active', kind: 'criterion', goal: 'GOAL-200' },
    ],
    lanes: lanesOf([laneInterval('t-1', 'implementing'), laneInterval('t-2', null)]),
  });

  const reading = await read(harness);
  const byId = new Map(reading.tasks.map((entry) => [entry.taskId, entry]));

  assert.equal(byId.get('t-1')?.status, 'ready');
  assert.equal(byId.get('t-2')?.status, 'done');
  assert.equal(byId.get('t-1')?.phase, 'implementing', 'an in-flight interval supplies the phase');
  assert.equal(byId.get('t-2')?.phase, null, 'a finished interval carries no phase');
  assert.equal(byId.get('t-3')?.phase, null, 'a task with no lane at all has no phase');

  assert.equal(byId.get('t-1')?.goalId, 'GOAL-100', 'goal_ac → criterion row → goal');
  assert.equal(byId.get('t-4')?.goalId, 'GOAL-200');
  assert.equal(byId.get('t-2')?.goalId, null, 'a goal_ac pointing at no criterion is null, not a throw');
  assert.equal(byId.get('t-3')?.goalId, null);

  assert.deepEqual(reading.goals, [
    { goalId: 'GOAL-100', title: 'goal one hundred', status: 'active', viaTaskCount: 1, mentionedDirectly: false },
    { goalId: 'GOAL-200', title: 'goal two hundred', status: 'achieved', viaTaskCount: 1, mentionedDirectly: true },
  ], 'both provenances of one goal are covered, and the order is by goal id');
});

test('AC4 — a goal named only directly, only via a task, and both ways appears once with the right readings', async () => {
  const harness = createHarness({
    rows: [assistantText('directly: GOAL-300')],
    taskRows: [taskRow('t-5', { goalAc: 'AC-300' }), taskRow('t-6', { goalAc: 'AC-301' })],
    goalRows: [
      { id: 'GOAL-300', title: 'named directly', status: 'active', kind: 'goal', goal: null },
      { id: 'GOAL-400', title: 'named via a task', status: 'active', kind: 'goal', goal: null },
      { id: 'AC-300', title: 'criterion', status: 'active', kind: 'criterion', goal: 'GOAL-300' },
      { id: 'AC-301', title: 'criterion', status: 'active', kind: 'criterion', goal: 'GOAL-400' },
    ],
  });

  // `t-5` is not named in the text, so GOAL-300 has no via-task contribution yet.
  const first = await read(harness);
  assert.deepEqual(first.goals.map((goal) => [goal.goalId, goal.viaTaskCount, goal.mentionedDirectly]), [
    ['GOAL-300', 0, true],
  ]);

  // Now the conversation names t-5 (which belongs to GOAL-300) and t-6 (GOAL-400, only via task).
  harness.file.append([assistantText('and t-5, t-6')]);
  const second = await read(harness);
  assert.deepEqual(second.goals.map((goal) => [goal.goalId, goal.viaTaskCount, goal.mentionedDirectly]), [
    ['GOAL-300', 1, true],
    ['GOAL-400', 1, false],
  ]);
});

test('AC4 — task order is lastMentionAt descending, ties by id; a task with no instant sorts last', async () => {
  const harness = createHarness({
    rows: [
      assistantText('gap-older', '2026-10-25T08:00:00.000Z'),
      assistantText('gap-newer-a gap-undated'),
      assistantText('gap-newer-b', '2026-10-25T10:00:00.000Z'),
      assistantText('gap-tie-b', '2026-10-25T10:00:00.000Z'),
      assistantText('gap-tie-a', '2026-10-25T10:00:00.000Z'),
    ],
    taskRows: [
      taskRow('gap-older'),
      taskRow('gap-newer-a'),
      taskRow('gap-newer-b'),
      taskRow('gap-undated'),
      taskRow('gap-tie-a'),
      taskRow('gap-tie-b'),
    ],
  });

  assert.deepEqual(mentionedTaskIds(await read(harness)), [
    'gap-newer-b',
    'gap-tie-a',
    'gap-tie-b',
    'gap-older',
    'gap-newer-a',
    'gap-undated',
  ]);
});

// --------------------------- AC5: THE ROUTES ------------

/** Mounts the router on a random loopback port and runs `body` against it. */
async function withRouter(
  options: { sessionMentions?: SessionMentionsService; runCommand?: QuayCommandRunner },
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const service = createQuayService({
    fileExists: () => false,
    resolveProjectPathById: (projectId: string) => (projectId === 'project-1' ? '/repo' : null),
    runCommand: options.runCommand ?? (async () => ({ ok: true, code: 0, stdout: '[]', stderr: '' })),
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => {
        throw new Error('ENOENT');
      },
    },
    probeWebService: async () => false,
    now: () => Date.parse('2026-10-25T12:00:00.000Z'),
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
  });

  const app = express();
  app.use('/api/quay', createQuayRouter({ quayService: service, sessionMentions: options.sessionMentions }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await body(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('AC5 — missing sessionId is 400 session-id-required', async () => {
  await withRouter({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quay/project-1/session-mentions`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, reason: 'session-id-required' });
  });
});

test('AC5 — no service composed is 503 session-mentions-unavailable', async () => {
  await withRouter({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quay/project-1/session-mentions?sessionId=s1`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, reason: 'session-mentions-unavailable' });
  });
});

test('AC5 — a null reading is 404 project-or-session-not-found, and a reading is relayed as 200', async () => {
  const reading: SessionMentionsReading = {
    ok: true,
    sessionId: 's1',
    projectId: 'project-1',
    tasks: [],
    goals: [],
    generatedAt: '2026-10-25T12:00:00.000Z',
  };

  await withRouter(
    { sessionMentions: { readSessionMentions: async () => null } },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/quay/project-1/session-mentions?sessionId=s1`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { ok: false, reason: 'project-or-session-not-found' });
    },
  );

  await withRouter(
    { sessionMentions: { readSessionMentions: async () => reading } },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/quay/project-1/session-mentions?sessionId=s1`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), reading);
    },
  );
});

test('AC5/AC6 — GET /:projectId/lanes answers the lanes reading and falls an illegal window back to 3', async () => {
  const recorded: string[] = [];
  const runCommand: QuayCommandRunner = async (_cwd, args) => {
    recorded.push(args.join(' '));
    if (args[0] === 'lanes') {
      const windowHours = Number(args[args.length - 1]);
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ windowHours, nowMs: 2_000, lanes: [[]], overflow: 0 }),
        stderr: '',
      };
    }
    return { ok: true, code: 0, stdout: '[]', stderr: '' };
  };

  await withRouter({ runCommand }, async (baseUrl) => {
    const six = await fetch(`${baseUrl}/api/quay/project-1/lanes?hours=6`);
    assert.equal(six.status, 200);
    const body = (await six.json()) as {
      ok: boolean;
      gantt: { windowHours: number };
      ganttUnavailable: unknown;
      generatedAt: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.gantt.windowHours, 6);
    assert.equal(body.ganttUnavailable, null);
    assert.equal(body.generatedAt, '2026-10-25T12:00:00.000Z');

    await fetch(`${baseUrl}/api/quay/project-1/lanes?hours=abc`);
    assert.deepEqual(recorded, [
      'lanes --json --window-hours 6',
      'lanes --json --window-hours 3',
    ], 'hours=abc falls back to the default window, and only the lanes verb is spawned');
  });
});

test('AC5 — an unknown project on the lanes route is 404', async () => {
  await withRouter({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/quay/no-such-project/lanes`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: 'Project not found', projectId: 'no-such-project' });
  });
});
