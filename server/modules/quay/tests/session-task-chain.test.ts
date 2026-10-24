import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySessionTaskStage,
  createSessionTaskChainService,
  readBlockedReason,
  type SessionTaskChainDependencies,
  type SessionTaskChainReading,
  type SessionTaskStoreRecord,
} from '../session-task-chain.service.js';

/**
 * The session → task flow chain (AC1 + AC2).
 *
 * WHAT THIS FILE PROVES:
 *
 *   - AC1 — the transcript scan reads WRITING tool calls only. `quay task create <id>`,
 *     `quay task edit <id> …` and an MCP `task_write` land in the map; a read-only
 *     `quay task view <id>` does not. The scan is incremental: appending rows and polling
 *     again picks up the new task without re-counting the old ones.
 *   - AC2 — the stage rule against a stub task store, stub git ancestry and stub deploy
 *     readings: todo → 立案, ready+worktree → 执行中, done but not in the built artifact →
 *     已合入, in the built artifact but not running → 已构建, in the running build → 线上运行;
 *     a not-landed task carrying a `未落地原因` bullet → 卡住, carrying that reason's first
 *     line.
 *
 * The service is driven through its factory with every side effect injected, so no subprocess,
 * filesystem or deployment state is touched. It is a server test: `tsx --test` drives it
 * (vitest's include is `src/**`).
 */

/** A transcript row carrying one Bash tool call. */
function bashRow(command: string): unknown {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tool-${command.length}`, name: 'Bash', input: { command } }],
    },
  };
}

/** A transcript row carrying one MCP tool call. */
function mcpRow(name: string, input: Record<string, unknown>): unknown {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `mcp-${name}`, name, input }] },
  };
}

/** The JSONL a transcript file holds, newline-terminated like the real one. */
function jsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** One mutable transcript file the scan reads in byte ranges. */
type TranscriptFile = {
  text: string;
  append(rows: readonly unknown[]): void;
  size(): Promise<number | null>;
  read(start: number): Promise<string | null>;
};

function transcriptFile(rows: readonly unknown[]): TranscriptFile {
  let text = jsonl(rows);
  return {
    get text() {
      return text;
    },
    append(nextRows) {
      text += jsonl(nextRows);
    },
    async size() {
      return Buffer.byteLength(text, 'utf8');
    },
    async read(start) {
      return Buffer.from(text, 'utf8').subarray(start).toString('utf8');
    },
  };
}

type Harness = {
  service: ReturnType<typeof createSessionTaskChainService>;
  file: TranscriptFile;
  projectPath: string;
  dependencies: SessionTaskChainDependencies;
};

/**
 * A service over one temp transcript stub and the three injected readings.
 *
 * `landCommits` maps a task id to the commit that landed it; `ancestors` maps a commit to the
 * shas it is an ancestor of (`git merge-base --is-ancestor` answers yes for those pairs).
 */
function createHarness(options: {
  context: string;
  /** A transcript the caller keeps a handle on, when it wants to append between polls. */
  file?: TranscriptFile;
  rows?: readonly unknown[];
  tasks?: Record<string, SessionTaskStoreRecord>;
  worktreeTaskIds?: readonly string[];
  landCommits?: Record<string, string>;
  ancestors?: Record<string, readonly string[]>;
  builtSha?: string | null;
  runningSha?: string | null;
}): Harness {
  const file = options.file ?? transcriptFile(options.rows ?? []);
  const tasks = options.tasks ?? {};
  const landCommits = options.landCommits ?? {};
  const ancestors = options.ancestors ?? {};
  const worktreeTaskIds = new Set(options.worktreeTaskIds ?? []);
  const projectPath = '/repo';

  const dependencies: SessionTaskChainDependencies = {
    resolveProjectPath(projectId) {
      return projectId === 'project-1' ? projectPath : null;
    },
    resolveTranscriptPath() {
      return '/transcripts/session-1.jsonl';
    },
    transcriptSize: () => file.size(),
    readTranscriptRange: (_path, start) => file.read(start),
    readTask(_projectPath, taskId) {
      return tasks[taskId] ?? null;
    },
    worktreeTaskIds: () => worktreeTaskIds,
    findLandCommit(_projectPath, taskId) {
      return landCommits[taskId] ?? null;
    },
    isAncestor(_projectPath, ancestor, descendant) {
      return (ancestors[ancestor] ?? []).includes(descendant);
    },
    readDeployShas() {
      return { builtSha: options.builtSha ?? null, runningSha: options.runningSha ?? null };
    },
    now: () => Date.parse('2026-10-24T12:00:00.000Z'),
  };

  return {
    service: createSessionTaskChainService(dependencies),
    file,
    projectPath,
    dependencies,
  };
}

/** Reads the one session the harness stubs, asserting it is not the `null` (unknown project) arm. */
async function readChain(harness: Harness): Promise<SessionTaskChainReading> {
  const reading = await harness.service.readSessionTaskChain({
    projectId: 'project-1',
    sessionId: 'session-1',
  });
  assert.ok(reading !== null, 'the stubbed project must produce a reading');
  return reading;
}

// --------------------------- AC1: WHICH TASKS ------------

test('AC1 — reads create/edit/write tool calls, ignores read-only view, and polls incrementally', async () => {
  const file = transcriptFile([
    bashRow('quay task create a --title "first task"'),
    bashRow('cd /repo && quay task edit b --body-file /tmp/b.md'),
    mcpRow('mcp__plugin_quay_quay__task_write', { id: 'c', body: 'edited through the provider ABI' }),
    bashRow('quay task view d'),
  ]);

  const harness = createHarness({ context: 'AC1 transcript', file });
  const service = harness.service;

  const first = await service.readSessionTaskChain({ projectId: 'project-1', sessionId: 'session-1' });
  assert.ok(first !== null);
  assert.deepEqual(first.created, ['a'], 'the create call names a');
  assert.deepEqual(first.edited, ['b', 'c'], 'edit and MCP task_write name b and c; view names none');
  assert.equal(first.created.includes('d'), false, 'a read-only view must not enter the chain');

  // The transcript grows: one new task edit, plus a repeat of an already-seen edit and create.
  file.append([
    bashRow('quay task edit e --title "later"'),
    bashRow('quay task edit b --body-file /tmp/b2.md'),
    bashRow('quay task create a --title "again"'),
  ]);

  const second = await service.readSessionTaskChain({ projectId: 'project-1', sessionId: 'session-1' });
  assert.ok(second !== null);
  assert.deepEqual(second.created, ['a'], 'created stays a after the incremental read');
  assert.deepEqual(second.edited, ['b', 'c', 'e'], 'only the new edit is appended; repeats do not duplicate');
  assert.deepEqual(second.counts.total, 4);
  assert.deepEqual(second.created, first.created);
});

// --------------------------- AC2: WHERE EACH TASK STANDS ------------

/** Every fixture task, named so a failure message says which arm broke. */
const STAGE_ROWS = [
  bashRow('quay task create t-todo --title "still a proposal"'),
  bashRow('quay task create t-ready --title "ready, no worktree"'),
  bashRow('quay task create t-running-work --title "a worker is on it"'),
  bashRow('quay task create t-landed --title "landed, not built"'),
  bashRow('quay task create t-built --title "built, not running"'),
  bashRow('quay task create t-live --title "in the running build"'),
  bashRow('quay task create t-blocked --title "parked"'),
  bashRow('quay task create t-human --title "needs a person"'),
  bashRow('quay task create t-superseded --title "replaced"'),
  bashRow('quay task create t-gone --title "deleted from the store"'),
];

const BLOCKED_BODY = [
  '## Proposal',
  '',
  'Something was started.',
  '',
  '## Blocker',
  '',
  '- 未落地原因：step=suite: not ok - server/modules/x/tests/x.test.ts: AssertionError',
  '- 历史原因：an earlier round parked this task',
  '',
  '## Touches',
  '',
  '- server/modules/x.ts',
].join('\n');

const STAGE_TASKS: Record<string, SessionTaskStoreRecord> = {
  't-todo': { status: 'todo', title: 'still a proposal', body: '## Proposal\n\nDraft.' },
  't-ready': { status: 'ready', title: 'ready, no worktree', body: '## Proposal\n\nQueued.' },
  't-running-work': { status: 'ready', title: 'a worker is on it', body: '## Proposal\n\nIn flight.' },
  't-landed': { status: 'done', title: 'landed, not built', body: '## Proposal\n\nLanded.' },
  't-built': { status: 'done', title: 'built, not running', body: '## Proposal\n\nBuilt.' },
  't-live': { status: 'done', title: 'in the running build', body: '## Proposal\n\nLive.' },
  't-blocked': { status: 'todo', title: 'parked', body: BLOCKED_BODY },
  't-human': { status: 'needs-human', title: 'needs a person', body: '## Proposal\n\nWaiting.' },
  't-superseded': { status: 'superseded', title: 'replaced', body: '## Proposal\n\nReplaced.' },
};

test('AC2 — todo is 立案; ready with a worktree is 执行中; ready without one is 就绪', async () => {
  const harness = createHarness({
    context: 'AC2 filed/ready/in-progress',
    rows: STAGE_ROWS,
    tasks: STAGE_TASKS,
    worktreeTaskIds: ['t-running-work'],
  });
  const reading = await readChain(harness);
  const stageOf = new Map(reading.tasks.map((entry) => [entry.taskId, entry.stage]));

  assert.equal(stageOf.get('t-todo'), 'filed');
  assert.equal(stageOf.get('t-ready'), 'ready');
  assert.equal(stageOf.get('t-running-work'), 'in-progress');
});

test('AC2 — a landed commit outside the built artifact is 已合入; inside it is 已构建; in the running build it is 线上运行', async () => {
  const harness = createHarness({
    context: 'AC2 landed/built/running',
    rows: STAGE_ROWS,
    tasks: STAGE_TASKS,
    landCommits: {
      't-landed': 'sha-landed',
      't-built': 'sha-built',
      't-live': 'sha-live',
    },
    // The built artifact contains sha-built and sha-live; the running build contains sha-live.
    ancestors: {
      'sha-landed': [],
      'sha-built': ['built-sha'],
      'sha-live': ['built-sha', 'running-sha'],
    },
    builtSha: 'built-sha',
    runningSha: 'running-sha',
  });
  const reading = await readChain(harness);
  const stageOf = new Map(reading.tasks.map((entry) => [entry.taskId, entry.stage]));

  assert.equal(stageOf.get('t-landed'), 'landed', 'not an ancestor of the built sha');
  assert.equal(stageOf.get('t-built'), 'built', 'in the built artifact but not the running build');
  assert.equal(stageOf.get('t-live'), 'running', 'in the running build');
  assert.equal(reading.counts.landed, 1);
  assert.equal(reading.counts.built, 1);
  assert.equal(reading.counts.running, 1);
});

test('AC2 — a 未落地原因 bullet makes the task 卡住 and carries the reason’s first line', async () => {
  const harness = createHarness({
    context: 'AC2 blocked',
    rows: STAGE_ROWS,
    tasks: STAGE_TASKS,
  });
  const reading = await readChain(harness);
  const blocked = reading.tasks.find((entry) => entry.taskId === 't-blocked');

  assert.ok(blocked !== undefined);
  assert.equal(blocked.stage, 'blocked');
  assert.equal(
    blocked.blockedReason,
    'step=suite: not ok - server/modules/x/tests/x.test.ts: AssertionError',
    'the first line of 未落地原因, not the following bullet',
  );
});

test('AC2 — needs-human and superseded keep their own branches; a vanished task is unknown', async () => {
  const harness = createHarness({
    context: 'AC2 terminal branches',
    rows: STAGE_ROWS,
    tasks: STAGE_TASKS,
  });
  const reading = await readChain(harness);
  const stageOf = new Map(reading.tasks.map((entry) => [entry.taskId, entry.stage]));

  assert.equal(stageOf.get('t-human'), 'needs-human');
  assert.equal(stageOf.get('t-superseded'), 'superseded');
  assert.equal(stageOf.get('t-gone'), 'unknown', 'a task the store no longer has is not silently dropped');
  assert.equal(reading.counts.needsHuman, 1);
  assert.equal(reading.counts.superseded, 1);
  assert.equal(reading.counts.unknown, 1);
});

// --------------------------- the rules in isolation ------------

test('the stage rule treats the running reading as newer than the built one', () => {
  const shared = {
    status: 'done',
    blockedReason: null,
    hasWorktree: false,
    landCommit: 'sha',
    builtSha: 'built',
    runningSha: 'running',
    isAncestor: (ancestor: string, descendant: string) =>
      ancestor === 'sha' && (descendant === 'built' || descendant === 'running'),
  };

  assert.equal(classifySessionTaskStage(shared), 'running');
  assert.equal(
    classifySessionTaskStage({ ...shared, runningSha: 'stale-running' }),
    'built',
    'a running build that does not contain the commit reads as built, not live',
  );
  assert.equal(
    classifySessionTaskStage({ ...shared, builtSha: null, runningSha: null }),
    'landed',
    'with no deploy fingerprint the landed commit can only claim 已合入',
  );
});

test('readBlockedReason needs the 未落地原因 bullet, not just the heading', () => {
  assert.equal(readBlockedReason('## Blocker\n\n- 历史原因：old\n'), null);
  assert.equal(readBlockedReason('## Proposal\n\nNo blocker here.\n'), null);
  assert.equal(
    readBlockedReason('## Blocker\n- 未落地原因：AC 未全勾（checked 3/4）\n'),
    'AC 未全勾（checked 3/4）',
  );
});
