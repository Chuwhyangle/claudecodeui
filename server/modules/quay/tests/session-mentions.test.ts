import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import {
  readClaudeTranscriptMessage,
  readCodexTranscriptMessage,
} from '@/modules/providers/index.js';

import { createQuayRouter } from '../quay.routes.js';
import { createQuayService } from '../service/index.js';
import type { QuayCommandRunner, QuayTaskStatusRow } from '../read/index.js';
import { createQuayTaskEvents } from '../task/quay-task-events.service.js';
import type { QuayTaskEventsTimers } from '../task/quay-task-log-parse.js';
import {
  createSessionMentionsService,
  type SessionMentionsDependencies,
  type SessionMentionsGoalRow,
  type SessionMentionsIndexState,
  type SessionMentionsReading,
  type SessionMentionsService,
  type SessionMentionsTaskIndexRow,
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
 * The event-fresh index arm and the 60 s single-flight goal cache
 * (gap-session-mentions-reads-event-fresh-index-and-caches-goals) are the sections below:
 * a ready index under an active monitor answers with zero `task list` spawns, every non-fresh
 * combination falls back to exactly one direct read, the REAL `createQuayTaskEvents` delivers a
 * transition the very next reading reports, and a failed goal read is retried rather than cached.
 * Each fallback fixture is built so dropping the monitor check or the index-state check would red
 * (a `degraded` monitor and a `stale` index both come with index rows that would otherwise answer).
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
  /** Replaces the file with a new one at the same path (a rollover/restore): new identity. */
  rotate(text: string): void;
  /** Simulates a stat/read failure without destroying what the file holds. */
  setUnreadable(unreadable: boolean): void;
  size(): Promise<number | null>;
  stat(): Promise<{ size: number; identity: string | null } | null>;
  read(start: number): Promise<string | null>;
};

function transcriptFile(rows: readonly unknown[]): TranscriptFile {
  let text = jsonl(rows);
  let identity = 'dev:1';
  let unreadable = false;
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
    rotate(nextText) {
      text = nextText;
      // A rollover writes a NEW file at the same path: the inode changes even when the size
      // happens to be equal or larger, which is the case a size-only check cannot see.
      identity = `dev:${(Number(identity.split(':')[1]) || 1) + 1}`;
    },
    setUnreadable(nextUnreadable) {
      unreadable = nextUnreadable;
    },
    async size() {
      return unreadable ? null : Buffer.byteLength(text, 'utf8');
    },
    async stat() {
      return unreadable ? null : { size: Buffer.byteLength(text, 'utf8'), identity };
    },
    async read(start) {
      if (unreadable) return null;
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
  /** How many direct `task list --json --no-body` reads the CLI arm performed. */
  taskRowReads: number;
  /** How many `goal list --json` spawns the underlying reader performed. */
  goalRowReads: number;
  /** How many background index loads the reading asked for. */
  indexLoadRequests: number;
};

/**
 * A service over one transcript stub and the injected index/goal/lane readings.
 *
 * The dependency closures answer from the harness arrays, so pushing a row between two requests
 * is exactly the "a task was filed mid-conversation" case the cache must not hide. The task
 * vocabulary is served the way production does: the event-fresh INDEX arm when
 * `monitorState === 'active'` and `indexState === 'ready'`, the direct CLI arm otherwise.
 */
function createHarness(options: {
  rows?: readonly unknown[];
  file?: TranscriptFile;
  taskRows?: SessionMentionsTaskRow[];
  goalRows?: SessionMentionsGoalRow[];
  lanes?: ReturnType<typeof lanesOf> | null;
  unknownProject?: boolean;
  missingTranscript?: boolean;
  /** The monitor state the reading consults; default `off` (the direct CLI arm). */
  monitorState?: 'off' | 'active' | 'degraded';
  /** The index state; default `cold`, i.e. nothing ever loaded. */
  indexState?: SessionMentionsIndexState;
  /** Rows the index holds. Only `indexState: 'ready'` serves them without a CLI read. */
  indexRows?: SessionMentionsTaskIndexRow[];
  /** Overrides applied last, for the cases that need their own reader/clock. */
  dependencies?: Partial<SessionMentionsDependencies>;
}): Harness {
  const file = options.file ?? transcriptFile(options.rows ?? []);
  const taskRows = options.taskRows ?? [];
  const goalRows = options.goalRows ?? [];

  const harness: Harness = {
    // Assigned below; `Harness` exposes the counters the closures mutate.
    service: undefined as unknown as SessionMentionsService,
    file,
    taskRows,
    goalRows,
    taskRowReads: 0,
    goalRowReads: 0,
    indexLoadRequests: 0,
  };

  const dependencies: SessionMentionsDependencies = {
    resolveProjectPath(projectId) {
      return options.unknownProject === true || projectId !== 'project-1' ? null : '/repo';
    },
    resolveTranscriptPath() {
      return options.missingTranscript === true ? null : '/transcripts/session-1.jsonl';
    },
    transcriptStat: () => file.stat(),
    readTranscriptRange: (_path, start) => file.read(start),
    // Production resolves the reader from the session's provider; the harness defaults to the
    // Claude reader (the fixtures in this file are Claude-shaped) and each Codex case overrides
    // it. Pass `resolveTranscriptMessageReader` in `dependencies` for a providerless arm.
    resolveTranscriptMessageReader: () => readClaudeTranscriptMessage,
    readTaskRows: async () => {
      harness.taskRowReads += 1;
      return taskRows;
    },
    readGoalRows: async () => {
      harness.goalRowReads += 1;
      return goalRows;
    },
    readTaskIndex: () => ({
      state: options.indexState ?? 'cold',
      tasks: new Map((options.indexRows ?? []).map((row) => [row.taskId, row])),
    }),
    readMonitorState: () => ({ state: options.monitorState ?? 'off' }),
    requestTaskIndexLoad: () => {
      harness.indexLoadRequests += 1;
    },
    readLanes: async () => options.lanes ?? null,
    now: () => Date.parse('2026-10-25T12:00:00.000Z'),
    ...options.dependencies,
  };

  harness.service = createSessionMentionsService(dependencies);
  return harness;
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

// --------------------------- AC1/AC3/AC5: PROVIDER PROSE + TRANSCRIPT LIFECYCLE ------------

/*
 * These cases drive the PRODUCTION mention join with the production provider readers
 * (`readCodexTranscriptMessage` / `readClaudeTranscriptMessage`), not a hand-written row parser:
 * the service is handed exactly the reader the provider registry would hand it. They are the
 * cross-provider criterion — a Claude-shaped row is never interpreted by Quay itself, and a real
 * Codex carrier set is.
 */

/** A legacy Codex prompt: `event_msg` / `user_message`. */
function codexUserMessage(text: string, timestamp?: string): unknown {
  return {
    type: 'event_msg',
    ...(timestamp === undefined ? {} : { timestamp }),
    payload: { type: 'user_message', message: text },
  };
}

/** The wire form of a prompt, which a real rollout ALSO writes. */
function codexWireUser(text: string): unknown {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

/** A modern Codex prompt: `item_completed` / `UserMessage`. */
function codexUserItem(text: string, timestamp?: string): unknown {
  return {
    type: 'event_msg',
    ...(timestamp === undefined ? {} : { timestamp }),
    payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } },
  };
}

/** A Codex assistant answer: `response_item` / `message` / `role=assistant`. */
function codexAssistant(text: string, timestamp?: string): unknown {
  return {
    type: 'response_item',
    ...(timestamp === undefined ? {} : { timestamp }),
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

/** The SAME answer's second carrier: `item_completed` / `AgentMessage`. */
function codexAgentItem(text: string): unknown {
  return {
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }] } },
  };
}

test('AC1 — real Codex carriers reach the mention join, and duplicate carriers count once', async () => {
  const harness = createHarness({
    rows: [
      // The wire prompt also carries the environment/AGENTS injection; it is NOT the prompt
      // carrier. Naming an id here must not produce a mention on its own.
      codexWireUser('injected context mentions gap-hidden'),
      codexUserItem('please finish gap-codex', '2026-10-25T09:00:00.000Z'),
      // The older generation of the prompt carrier still works.
      codexUserMessage('legacy rollout names gap-legacy'),
      codexAgentItem('gap-codex is done'),
      codexAssistant('gap-codex is done', '2026-10-25T09:05:00.000Z'),
    ],
    taskRows: [taskRow('gap-codex', { status: 'ready' }), taskRow('gap-hidden'), taskRow('gap-legacy')],
    dependencies: { resolveTranscriptMessageReader: () => readCodexTranscriptMessage },
  });

  const reading = await read(harness);
  assert.equal(reading.transcript, 'ok');
  assert.deepEqual(
    reading.tasks.map(({ taskId, mentionCount, lastMentionAt }) => ({ taskId, mentionCount, lastMentionAt })),
    [
      { taskId: 'gap-codex', mentionCount: 2, lastMentionAt: '2026-10-25T09:05:00.000Z' },
      { taskId: 'gap-legacy', mentionCount: 1, lastMentionAt: null },
    ],
    'the chosen user carrier (1) + the chosen assistant carrier (1); the duplicated carriers do not double them',
  );
  assert.equal(
    mentionedTaskIds(reading).includes('gap-hidden'),
    false,
    'the wire user row is an internal carrier, not a prompt',
  );
});

test('AC3 — two independent Codex messages with identical text each count', async () => {
  const harness = createHarness({
    rows: [codexUserItem('gap-same please'), codexUserItem('gap-same please')],
    taskRows: [taskRow('gap-same')],
    dependencies: { resolveTranscriptMessageReader: () => readCodexTranscriptMessage },
  });

  const reading = await read(harness);
  assert.equal(reading.tasks[0]?.mentionCount, 2, 'dedupe is by carrier selection, never by identical text');
});

test('AC5/AC6 — a session without a provider prose reader is unreadable, not empty (Quay parses no format)', async () => {
  const harness = createHarness({
    // Claude-shaped prose Quay used to parse itself. With no provider reader, the service must
    // not interpret it: provider formats belong to providers, and the honest answer is
    // "unreadable", not "nothing was mentioned".
    rows: [assistantText('this row names gap-claude')],
    taskRows: [taskRow('gap-claude')],
    dependencies: { resolveTranscriptMessageReader: () => null },
  });

  const reading = await read(harness);
  assert.equal(reading.transcript, 'unreadable');
  assert.deepEqual(mentionedTaskIds(reading), []);
});

test('AC5 — an unreadable transcript is distinct from an empty reading and retries after recovery', async () => {
  const file = transcriptFile([assistantText('the file names gap-retry')]);
  const harness = createHarness({ file, taskRows: [taskRow('gap-retry')] });

  file.setUnreadable(true);
  const failed = await read(harness);
  assert.equal(failed.transcript, 'unreadable', 'a failed read is reported, not disguised as empty');
  assert.deepEqual(mentionedTaskIds(failed), [], 'nothing was consumed while the file was unreadable');

  file.setUnreadable(false);
  const recovered = await read(harness);
  assert.equal(recovered.transcript, 'ok', 'reopening after recovery retries and succeeds');
  assert.deepEqual(mentionedTaskIds(recovered), ['gap-retry']);
  assert.deepEqual(file.reads, [0], 'the retry reads the file from its unconsumed start');
});

test('AC4 — a same-size rotated file resets the scan through its identity, not its size', async () => {
  const first = 'the transcript names gap-old';
  const second = 'the transcript names gap-new';
  assert.equal(Buffer.byteLength(first, 'utf8'), Buffer.byteLength(second, 'utf8'), 'the fixture is size-neutral');
  const file = transcriptFile([assistantText(first)]);
  const harness = createHarness({ file, taskRows: [taskRow('gap-old'), taskRow('gap-new')] });

  assert.deepEqual(mentionedTaskIds(await read(harness)), ['gap-old']);

  file.rotate(jsonl([assistantText(second)]));
  const reading = await read(harness);
  assert.deepEqual(mentionedTaskIds(reading), ['gap-new'], 'the rotated file is rescanned, not read as "nothing new"');
  assert.deepEqual(file.reads, [0, 0], 'the new file is read from byte 0');
});

test('AC4 — a changed transcript path (rebinding) starts a fresh scan', async () => {
  let transcriptPath = '/transcripts/old.jsonl';
  let active = transcriptFile([assistantText('the old path names gap-a')]);
  const harness = createHarness({
    taskRows: [taskRow('gap-a'), taskRow('gap-b')],
    dependencies: {
      resolveTranscriptPath: () => transcriptPath,
      transcriptStat: () => active.stat(),
      readTranscriptRange: (_path, start) => active.read(start),
    },
  });

  assert.deepEqual(mentionedTaskIds(await read(harness)), ['gap-a']);

  transcriptPath = '/transcripts/new.jsonl';
  active = transcriptFile([assistantText('the new path names gap-b')]);
  const reading = await read(harness);
  assert.deepEqual(mentionedTaskIds(reading), ['gap-b'], 'a rebinding does not inherit the old file cursor');
  assert.deepEqual(active.reads, [0], 'the new file is read from byte 0');
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

// --------------------------- EVENT-FRESH INDEX + GOAL CACHE ------------

/**
 * The event-fresh index arm (gap-session-mentions-reads-event-fresh-index-and-caches-goals).
 *
 * The popover used to spawn `task list` (≈254 ms, 565 KB) and `goal list` (≈790 ms, 1.28 MB) on
 * every open, about 1.1 s per open. These cases pin the two ways that cost went away, and — just
 * as important — every case in which the reading must fall back to today's direct read.
 */

test('index arm — a ready index under an active monitor answers status/title/goalId with zero task list spawns', async () => {
  const harness = createHarness({
    rows: [assistantText('the conversation names gap-indexed')],
    monitorState: 'active',
    indexState: 'ready',
    indexRows: [
      {
        taskId: 'gap-indexed',
        title: 'the index title',
        status: 'done',
        goalAc: 'AC-500',
      },
    ],
    taskRows: [taskRow('gap-indexed', { title: 'the CLI title', status: 'todo' })],
    goalRows: [
      { id: 'GOAL-500', title: 'goal five hundred', status: 'active', kind: 'goal', goal: null },
      { id: 'AC-500', title: 'criterion', status: 'achieved', kind: 'criterion', goal: 'GOAL-500' },
    ],
  });

  const reading = await read(harness);

  assert.equal(harness.taskRowReads, 0, 'the index arm must spawn no `task list` child');
  assert.equal(reading.sources.tasks, 'index');
  assert.deepEqual(
    reading.tasks.map((entry) => [entry.taskId, entry.title, entry.status, entry.goalId]),
    [['gap-indexed', 'the index title', 'done', 'GOAL-500']],
    'title, status and the goalAc → criterion → goal join all come from the index rows',
  );
  assert.deepEqual(
    reading.goals.map((goal) => [goal.goalId, goal.viaTaskCount]),
    [['GOAL-500', 1]],
    'the goal join is unchanged: it reads the same criterion rows',
  );
});

test('index arm — every non-fresh combination falls back to exactly one direct read', async () => {
  // Each case is designed so the WRONG implementation reds:
  //   · `degraded`+ready and `off`+ready already hold index rows, so dropping the monitor check
  //     would serve them and make the "exactly one spawn" assertion fail;
  //   · `stale`+active already holds index rows under an active monitor, so dropping the
  //     index-state check would serve them and make this case red;
  //   · `cold`/`stale` must also ask for a reload, the others must not.
  const cases: Array<{
    monitorState: 'off' | 'active' | 'degraded';
    indexState: SessionMentionsIndexState;
    expectLoadRequest: boolean;
  }> = [
    { monitorState: 'off', indexState: 'ready', expectLoadRequest: false },
    { monitorState: 'degraded', indexState: 'ready', expectLoadRequest: false },
    { monitorState: 'active', indexState: 'cold', expectLoadRequest: true },
    { monitorState: 'active', indexState: 'warming', expectLoadRequest: false },
    { monitorState: 'active', indexState: 'stale', expectLoadRequest: true },
    { monitorState: 'active', indexState: 'error', expectLoadRequest: false },
  ];

  for (const testCase of cases) {
    const label = `monitor=${testCase.monitorState} index=${testCase.indexState}`;
    const harness = createHarness({
      rows: [assistantText('the conversation names gap-fallback')],
      monitorState: testCase.monitorState,
      indexState: testCase.indexState,
      indexRows: [
        { taskId: 'gap-fallback', title: 'the index title', status: 'done', goalAc: null },
      ],
      taskRows: [taskRow('gap-fallback', { title: 'the CLI title', status: 'todo' })],
    });

    const reading = await read(harness);

    assert.equal(harness.taskRowReads, 1, `${label}: exactly one direct \`task list\` read`);
    assert.equal(reading.sources.tasks, 'cli', `${label}: the CLI arm is reported`);
    assert.equal(
      reading.tasks[0]?.title,
      'the CLI title',
      `${label}: the direct read's row answered, never the index row`,
    );
    assert.equal(reading.tasks[0]?.status, 'todo', `${label}: the direct read's status answered`);
    assert.equal(
      harness.indexLoadRequests,
      testCase.expectLoadRequest ? 1 : 0,
      `${label}: a cold/stale index is asked to reload, and nothing else is`,
    );
  }
});

// --------------------------- EVENT CHAIN END TO END ------------

type TestClock = {
  now(): number;
  timers: QuayTaskEventsTimers;
  advance(ms: number): Promise<void>;
};

/** A fake clock driving BOTH the events service's timers and the mention reading's `now`. */
function createTestClock(startMs: number): TestClock {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();

  const api: QuayTaskEventsTimers = {
    setTimeout: (handler, delayMs) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delayMs, run: handler });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
  };

  /** Lets every pending promise callback run; the fake timers only control TIME, not microtasks. */
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      await settle();
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = target;
    await settle();
  };

  return { now: () => now, timers: api, advance };
}

/** A fake directory watcher that records what the service asked for and lets a test emit. */
function createWatchStub(): {
  watchPath: (dirPath: string, onChange: (eventType: string, filename: string | null) => void) =>
    { close(): void; onError(handler: (error: Error) => void): void } | null;
  emit(filename: string): void;
} {
  const watchers: Array<{
    dirPath: string;
    onChange: (eventType: string, filename: string | null) => void;
    closed: boolean;
  }> = [];
  return {
    watchPath: (dirPath, onChange) => {
      const record = { dirPath, onChange, closed: false };
      watchers.push(record);
      return {
        close: () => {
          record.closed = true;
        },
        onError: () => undefined,
      };
    },
    emit: (filename) => {
      for (const watcher of watchers) {
        if (!watcher.closed) watcher.onChange('change', filename);
      }
    },
  };
}

test('event chain — a delivered ready→done transition changes the mention reading with zero task list spawns', async () => {
  const clock = createTestClock(1_000_700);
  const watch = createWatchStub();
  // The index the events service mutates and the mention reading joins — one shared map, exactly
  // as `quay.module.ts` shares the one service-owned index between the two readers.
  const indexTasks = new Map<string, QuayTaskStatusRow>([
    ['task-a', { taskId: 'task-a', title: 'task a', status: 'todo', updatedAt: null, goalAc: null }],
  ]);
  let taskListSpawns = 0;
  let indexLoadRequests = 0;
  const commandCalls: string[][] = [];

  const events = createQuayTaskEvents({
    now: clock.now,
    resolveProjectPathById: (projectId) => (projectId === 'project-1' ? '/repo' : null),
    readTaskIndex: (projectId) => ({
      state: 'ready',
      coverage: 'full',
      taskCount: indexTasks.size,
      observedAtMs: projectId === 'project-1' ? 1_000_500 : null,
      tasks: indexTasks,
    }),
    taskIndexLoadStartedAtMs: () => 1_000_000,
    requestTaskIndexLoad: () => {
      indexLoadRequests += 1;
    },
    updateTaskIndexRow: (_projectId, taskId, row) => {
      const existing = indexTasks.get(taskId);
      if (existing === undefined) return false;
      indexTasks.set(taskId, { ...existing, status: row.status, updatedAt: row.updatedAt });
      return true;
    },
    capabilities: {
      read: () => ({ taskLog: 'available', lanes: 'available' }),
      probe: async () => ({ taskLog: 'available', lanes: 'available' }),
    },
    runCommand: async (_cwd, args) => {
      commandCalls.push([...args]);
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          transitions: [
            {
              order: 0,
              schema: 'task-status-event/v1',
              seq: 1,
              eventId: 'evt-ready-to-done',
              carrierEpoch: 'epoch-1',
              taskId: 'task-a',
              from: 'ready',
              to: 'done',
              kind: 'fan-in',
              at: new Date(1_000_600).toISOString(),
              recordedAt: new Date(1_000_600).toISOString(),
              source: 'task-status-events',
              inferred: false,
            },
          ],
          complete: false,
          coverage: { reasons: ['test'] },
          generatedAt: new Date(1_000_200).toISOString(),
          rebase: false,
          rebaseReason: null,
          nextCursor: { v: 1, carrierEpoch: 'epoch-1', seq: 1 },
        }),
        stderr: '',
      };
    },
    watchPath: watch.watchPath,
    directoryExists: () => true,
    onDispatchFileChanged: () => undefined,
    log: () => undefined,
    timers: clock.timers,
    registerExitHook: () => undefined,
  });

  const file = transcriptFile([assistantText('the conversation names task-a')]);
  const service = createSessionMentionsService({
    resolveProjectPath: () => '/repo',
    resolveTranscriptPath: () => '/transcripts/session-1.jsonl',
    transcriptStat: () => file.stat(),
    readTranscriptRange: (_path, start) => file.read(start),
    resolveTranscriptMessageReader: () => readClaudeTranscriptMessage,
    readTaskRows: async () => {
      taskListSpawns += 1;
      return [taskRow('task-a', { title: 'cli title', status: 'ready' })];
    },
    readGoalRows: async () => [],
    readTaskIndex: () => ({ state: 'ready', tasks: indexTasks }),
    readMonitorState: (projectId) => events.readMonitorState(projectId),
    requestTaskIndexLoad: () => {
      indexLoadRequests += 1;
    },
    readLanes: async () => null,
    now: clock.now,
  });

  // Activation is the real thing: `noteProjectRead` → `ensureMonitored` → capability probe →
  // watcher. Until it lands the monitor is `off`, so the reading would take the CLI arm.
  await events.ensureMonitored('project-1');
  assert.equal(events.readMonitorState('project-1').state, 'active');

  const before = await service.readSessionMentions({ projectId: 'project-1', sessionId: 'session-1' });
  assert.equal(before?.tasks[0]?.status, 'todo', 'the index row answered before any event');
  assert.equal(before?.sources.tasks, 'index');
  assert.equal(taskListSpawns, 0, 'the active+ready combination spawned no `task list`');

  // The carrier changes; the debounced poll reads `task log` and applies the transition.
  watch.emit('task-status-events.jsonl');
  await clock.advance(250);

  assert.equal(indexTasks.get('task-a')?.status, 'done', 'the event updated the shared index row');
  assert.deepEqual(commandCalls[0]?.slice(0, 3), ['task', 'log', '--json']);

  const after = await service.readSessionMentions({ projectId: 'project-1', sessionId: 'session-1' });
  assert.equal(after?.tasks[0]?.status, 'done', 'the reading reports the transitioned status');
  assert.equal(after?.sources.tasks, 'index', 'the event-fresh index still answered');
  assert.equal(taskListSpawns, 0, 'the whole event path spawned no `task list`');
  assert.equal(indexLoadRequests, 0, 'a known task transition needs no full reload');
});

// --------------------------- GOAL CACHE ------------

test('goal cache — two requests inside the TTL spawn once, and crossing the TTL spawns again', async () => {
  let nowMs = Date.parse('2026-10-25T12:00:00.000Z');
  const harness = createHarness({
    rows: [assistantText('t-1 is mentioned')],
    taskRows: [taskRow('t-1')],
    goalRows: [{ id: 'GOAL-600', title: 'a goal', status: 'active', kind: 'goal', goal: null }],
    dependencies: { now: () => nowMs },
  });

  const first = await read(harness);
  assert.equal(harness.goalRowReads, 1);
  assert.equal(first.sources.goals, 'cli', 'the first request spawned `goal list`');

  const second = await read(harness);
  assert.equal(harness.goalRowReads, 1, 'inside the TTL the second request spawns nothing');
  assert.equal(second.sources.goals, 'cache');
  assert.deepEqual(second.goals, first.goals, 'the cached reading answers the same goal rows');

  nowMs += 60_000;
  const third = await read(harness);
  assert.equal(harness.goalRowReads, 2, 'the TTL expired, so the next request spawns again');
  assert.equal(third.sources.goals, 'cli');
});

test('goal cache — three concurrent requests share exactly one spawn', async () => {
  let goalSpawns = 0;
  const harness = createHarness({
    rows: [assistantText('t-1 and GOAL-700 are mentioned')],
    taskRows: [taskRow('t-1')],
    dependencies: {
      readGoalRows: async () => {
        goalSpawns += 1;
        // Hold the spawn open so the other two requests arrive while it is still in flight.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return [{ id: 'GOAL-700', title: 'a goal', status: 'active', kind: 'goal', goal: null }];
      },
    },
  });

  const readings = await Promise.all([
    harness.service.readSessionMentions({ projectId: 'project-1', sessionId: 'session-1' }),
    harness.service.readSessionMentions({ projectId: 'project-1', sessionId: 'session-1' }),
    harness.service.readSessionMentions({ projectId: 'project-1', sessionId: 'session-1' }),
  ]);

  assert.equal(goalSpawns, 1, 'single-flight: three concurrent readers, one `goal list` child');
  for (const reading of readings) {
    assert.ok(reading !== null);
    assert.deepEqual(reading.goals.map((goal) => goal.goalId), ['GOAL-700']);
  }
});

test('goal cache — a failed read keeps the unavailable semantics and is never cached as empty', async () => {
  let goalSpawns = 0;
  const harness = createHarness({
    rows: [assistantText('t-1 is mentioned')],
    taskRows: [taskRow('t-1', { goalAc: 'AC-600' })],
    dependencies: {
      readGoalRows: async () => {
        goalSpawns += 1;
        if (goalSpawns === 1) return null; // the CLI failed this once
        return [
          { id: 'GOAL-600', title: 'a goal', status: 'active', kind: 'goal', goal: null },
          { id: 'AC-600', title: 'criterion', status: 'active', kind: 'criterion', goal: 'GOAL-600' },
        ];
      },
    },
  });

  const failed = await read(harness);
  assert.deepEqual(failed.goals, [], 'without a goal reading there is no goal row to report');
  assert.equal(failed.tasks[0]?.goalId, null, 'and no criterion row to resolve a task goal through');
  assert.equal(failed.sources.goals, 'cli');

  const retried = await read(harness);
  assert.equal(goalSpawns, 2, 'the failure was not cached: the very next request retried');
  assert.equal(retried.sources.goals, 'cli');
  assert.equal(retried.tasks[0]?.goalId, 'GOAL-600', 'the retry answers the real join');
});

test('goal cache / CLI arm — every field except the added sources is unchanged', async () => {
  const harness = createHarness({
    rows: [assistantText('t-1 runs, GOAL-800 is named', '2026-10-25T09:00:00.000Z')],
    taskRows: [taskRow('t-1', { status: 'ready', goalAc: 'AC-800' })],
    goalRows: [
      { id: 'GOAL-800', title: 'goal eight hundred', status: 'active', kind: 'goal', goal: null },
      { id: 'AC-800', title: 'criterion', status: 'active', kind: 'criterion', goal: 'GOAL-800' },
    ],
    lanes: lanesOf([laneInterval('t-1', 'implementing')]),
  });

  const reading = await read(harness);
  const { sources, ...rest } = reading;

  assert.deepEqual(rest, {
    ok: true,
    sessionId: 'session-1',
    projectId: 'project-1',
    tasks: [
      {
        taskId: 't-1',
        title: 'title of t-1',
        status: 'ready',
        phase: 'implementing',
        goalId: 'GOAL-800',
        mentionCount: 1,
        lastMentionAt: '2026-10-25T09:00:00.000Z',
      },
    ],
    goals: [
      { goalId: 'GOAL-800', title: 'goal eight hundred', status: 'active', viaTaskCount: 1, mentionedDirectly: true },
    ],
    transcript: 'ok',
    generatedAt: '2026-10-25T12:00:00.000Z',
  }, 'the pre-existing document is untouched; only `sources` was added');
  assert.deepEqual(sources, { tasks: 'cli', goals: 'cli' });
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
    transcript: 'ok',
    sources: { tasks: 'index', goals: 'cache' },
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
