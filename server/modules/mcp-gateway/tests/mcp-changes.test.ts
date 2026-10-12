/**
 * `changes` criterion (gap-mcp-changes-on-demand-event-stream / AC-335).
 *
 * `changes` is the incremental read surface that replaces "poll
 * `sessions_list` / `session_get` between every write": one call, with the
 * cursor a previous call returned, answers what moved since — a session's new
 * activity (`liveness`), a run starting or settling and a Quay task's status
 * transition (`progress`), and a tool approval waiting on a person (`blocked`).
 *
 * This criterion drives the REAL module two ways, and nothing is faked at the
 * seam being read:
 *
 *  - {@link buildChanges} with injected readers, so the cursor codec, the
 *    watermark, the at-least-once paging, the signal classification and the
 *    `gaps` honesty all run exactly as they do in production;
 *  - `registerMcpReadTools` with a recording seam, so "the name is in the one
 *    stage-3 table, carries `cloudcli:read`, and its handler is the real one
 *    when the deps are wired — the body-table refusal when they are not" is a
 *    reading, not a claim.
 *
 * The injected readers are deliberately decoys-carrying: the deps bag has extra
 * members a naive implementation would reach for (`synchronizeSessions`,
 * `refreshQuay`, `fetchHistory`) and the criterion asserts their call counts are
 * ZERO. The task's whole "no heavy work" requirement is structural —
 * {@link McpChangesDeps} declares none of them — and the counters give the
 * requirement a reading that reds if one is ever wired in.
 *
 * No HTTP and no database: the wire path (a real `/mcp` mount, a real token, the
 * audited wrapper's envelope for a tampered cursor) is the DoD's real-service
 * run, and the wrapper's own criteria cover the envelope shape. What is legible
 * HERE is the semantics — shapes, signals, at-least-once, gaps, refusal.
 *
 * Readings, one leg each:
 *   (a) the input bounds (`limit` 1..200, default 50) and the emitted shapes are
 *       field-for-field, validated against the ADVERTISED schemas; every
 *       `signal` is one of three and every `source.type` one of the six declared
 *       sources; a session MESSAGE BODY's marker string appears nowhere in the
 *       response and the body reader is never called;
 *   (b) with the baseline cursor, a second call sees EXACTLY the five scripted
 *       changes, each with its own signal; the one `projects` parameter scopes
 *       both workspace-wide and per-project, and `kinds` filters;
 *   (c) the SAME cursor read twice is byte-identical, and a truncated page
 *       re-reads its boundary so paging never DROPS an event (at-least-once: a
 *       duplicate is allowed, a loss is not);
 *   (d) a cursor from a previous `bootId` reports `gaps` and never claims
 *       `complete: true`; a same-boot cursor reports neither (negative control);
 *   (e) NO HEAVY WORK, AND A COLD INDEX IS A NAMED STATE (the leg AC-348
 *       revises): the two heavy sources are never reached (counters 0), a Quay
 *       project with a config but an index that has never landed is a
 *       `quay_task` gap carrying the machine-readable `state` rather than a CLI
 *       spawn, an unconfigured project is not a gap at all, and the reading that
 *       ASKED for a load still reports the index as never-observed — the
 *       structural form of "changes never awaits the loader";
 *   (f) a cursor this tool did not issue is refused `INVALID_ARGUMENT`.
 *
 * The two false forms the AC names (session signal mislabelled `progress`; a
 * boot change silently declared complete) are recorded with the task.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

// The gateway's auth module pulls `@/shared/utils.js`, which freezes
// IS_PLATFORM on first import, so the environment is set before any aliased
// module is loaded and every application module below comes in dynamically.
process.env.JWT_SECRET = 'mcp-changes-test-secret';

import type { McpChangesDeps, McpChangesEvent, McpChangesPayload } from '../mcp-changes.js';
import type { McpReadToolDeps, McpReadToolRegistration } from '../index.js';

const {
  MCP_CHANGES_DEFAULT_LIMIT,
  MCP_CHANGES_INPUT_SCHEMA,
  MCP_CHANGES_MAX_LIMIT,
  MCP_CHANGES_OUTPUT_SCHEMA,
  buildChanges,
  decodeChangesCursor,
  encodeChangesCursor,
  isChangesWired,
  readChangesInput,
} = await import('../mcp-changes.js');
const { MCP_ERROR_CODES, MCP_STAGE3_READ_TOOLS, MCP_TOOL_NOT_IMPLEMENTED_CODE, registerMcpReadTools } = await import(
  '../index.js'
);

// --------------------------- fixture ---------------------------

const READ_SCOPE = 'cloudcli:read';
/** The envelope's code STRING: `MCP_ERROR_CODES.INVALID_ARGUMENT` is the descriptor. */
const INVALID_ARGUMENT_CODE = MCP_ERROR_CODES.INVALID_ARGUMENT.code;
const FIXED_NOW = Date.parse('2026-02-01T12:00:00.000Z');
/** The second observation instant: five minutes after the baseline reading. */
const LATER = FIXED_NOW + 5 * 60 * 1000;
const MINUTE = 60 * 1000;

/** A string only a session's MESSAGE BODY carries — a naive reading would leak it. */
const BODY_MARKER = 'SESSION-BODY-MARKER-DO-NOT-LEAK';

type SessionRow = { sessionId: string; projectId: string | null; title: string; updatedAtMs: number };
type RunRow = {
  runId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'aborted';
  startedAt: number;
  completedAt: number | null;
};
type ApprovalRow = { requestId: string; sessionId: string; toolName: string; receivedAtMs: number };
type QuayTaskRow = { taskId: string; title: string; status: string; updatedAt: string | null };

/**
 * The mutable world the injected readers answer from. A test mutates it between
 * two `buildChanges` calls and the deps see the change immediately — the run
 * registry, the approval table and the Quay index are all process state, and
 * this is that state in small.
 */
type World = {
  now: number;
  bootId: string;
  projects: { id: string; title: string }[];
  sessionRows: SessionRow[];
  /** Every session id either source can name, mapped to the project it belongs to. */
  sessionProject: Map<string, string | null>;
  runs: RunRow[];
  approvals: ApprovalRow[];
  /** Projects that carry a `.quay/config.yml`. */
  quayConfigured: Set<string>;
  /**
   * Each project's WHOLE status index, as the last load left it: `null` models an
   * index that has never landed (the `cold` / `warming` reading), a row list
   * models a full-coverage reading of every task the project has.
   */
  quayIndex: Map<string, QuayTaskRow[] | null>;
  /** The instant each project's index was last loaded — the reading's `observedAt`. */
  quayIndexObservedAt: Map<string, number>;
  /** Projects whose in-flight index load never settles. */
  quayIndexPending: Set<string>;
};

/** The decoys: counters for the heavy sources `changes` must never reach. */
type Decoys = {
  synchronizeSessions: () => void;
  refreshQuay: () => void;
  fetchHistory: () => string;
};
type Counters = {
  synchronizeSessions: number;
  refreshQuay: number;
  fetchHistory: number;
  /** Every `requestTaskIndexLoad` the read path made, per project. */
  indexLoadRequests: Map<string, number>;
};

function zeroCounters(): Counters {
  return { synchronizeSessions: 0, refreshQuay: 0, fetchHistory: 0, indexLoadRequests: new Map() };
}

/** The deps bag plus the decoys, so a call on a decoy is a countable event. */
type ChangesDeps = McpChangesDeps & Decoys;

function makeWorld(): World {
  const quayAlpha: QuayTaskRow[] = [
    { taskId: 'QX-1', title: 'First task', status: 'todo', updatedAt: new Date(FIXED_NOW - 30 * MINUTE).toISOString() },
  ];
  return {
    now: FIXED_NOW,
    bootId: 'boot-1',
    projects: [
      { id: 'proj-1', title: 'Alpha' },
      { id: 'proj-2', title: 'Beta' },
    ],
    // One session older than the first watermark, so the baseline reading is
    // empty of sessions but the project map is populated for runs/approvals.
    sessionRows: [
      { sessionId: 'sess-old-1', projectId: 'proj-1', title: 'Quiet session', updatedAtMs: FIXED_NOW - 60 * MINUTE },
    ],
    sessionProject: new Map<string, string | null>([
      ['sess-old-1', 'proj-1'],
      ['sess-2', 'proj-2'],
    ]),
    runs: [],
    approvals: [],
    quayConfigured: new Set(['proj-1']),
    quayIndex: new Map<string, QuayTaskRow[] | null>([['proj-1', quayAlpha]]),
    quayIndexObservedAt: new Map([['proj-1', FIXED_NOW - 30 * MINUTE]]),
    quayIndexPending: new Set<string>(),
  };
}

/**
 * Builds the injected deps over a world. `listChangedSince` is a real ascending
 * `(updatedAt, sessionId)` keyset page — filtered in the reader (never after a
 * `limit`), bounded to `limit` rows, with `hasMore` telling whether a row was
 * held back — so the incremental contract is exercised rather than assumed;
 * `projectForSession` reads the world's map, so a run or approval whose session
 * resolves to a project is attributed without a second reader.
 */
function makeDeps(world: World, counters: Counters): ChangesDeps {
  return {
    sessions: {
      listChangedSince: (
        after: { atMs: number; sessionId: string | null },
        projectIds: string[] | null,
        limit: number,
      ) => {
        const ordered = world.sessionRows
          .filter((row) => {
            const afterPosition =
              row.updatedAtMs > after.atMs ||
              (row.updatedAtMs === after.atMs &&
                after.sessionId !== null &&
                row.sessionId > after.sessionId);
            const inScope =
              projectIds === null || (row.projectId !== null && projectIds.includes(row.projectId));
            return afterPosition && inScope;
          })
          .sort(
            (left, right) =>
              left.updatedAtMs - right.updatedAtMs ||
              (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0),
          );
        return {
          hasMore: ordered.length > limit,
          rows: ordered.slice(0, limit).map((row) => ({ ...row })),
        };
      },
      projectForSession: (sessionId: string) => world.sessionProject.get(sessionId) ?? null,
    },
    runs: { listRecentRuns: () => world.runs.map((run) => ({ ...run })) },
    approvals: { listPending: () => world.approvals.map((row) => ({ ...row })) },
    // The index reader NEVER loads: it answers from the world's last load, and
    // `requestTaskIndexLoad` only counts the request and returns at once (the
    // injected member's type is what makes "never awaited" structural — it is
    // `void`, not a promise). Freshness (`stale`) is a reading of the SHIPPED
    // service's clock and lives in `mcp-changes-quay-index.test.ts`; here an
    // index that has landed is fresh.
    quay: {
      hasQuayConfig: (projectId: string) => world.quayConfigured.has(projectId),
      readTaskIndex: (projectId: string) => {
        const rows = world.quayIndex.get(projectId) ?? null;
        return {
          state: rows === null ? (world.quayIndexPending.has(projectId) ? 'warming' : 'cold') : 'ready',
          coverage: 'full' as const,
          taskCount: rows?.length ?? 0,
          observedAtMs: rows === null ? null : (world.quayIndexObservedAt.get(projectId) ?? world.now),
          tasks: new Map((rows ?? []).map((row) => [row.taskId, { ...row }])),
        };
      },
      requestTaskIndexLoad: (projectId: string) => {
        counters.indexLoadRequests.set(projectId, (counters.indexLoadRequests.get(projectId) ?? 0) + 1);
      },
    },
    projects: { list: () => world.projects.map((project) => ({ ...project })) },
    now: () => world.now,
    bootId: () => world.bootId,
    // The heavy sources a naive implementation could reach for. Not members of
    // `McpChangesDeps`; their presence here is what makes "never called" a
    // reading instead of a promise.
    synchronizeSessions: () => {
      counters.synchronizeSessions += 1;
    },
    refreshQuay: () => {
      counters.refreshQuay += 1;
    },
    fetchHistory: () => {
      counters.fetchHistory += 1;
      return `${BODY_MARKER}: the message body a naive reading would inline`;
    },
  };
}

/** The registry-equivalent reading: every event as `kind/signal`, sorted. */
function signals(payload: McpChangesPayload): string[] {
  return payload.events.map((event) => `${event.kind}/${event.signal}`).sort();
}

/** A stable identity for one event, so duplicates collapse but losses do not. */
function eventKey(event: McpChangesEvent): string {
  return `${event.kind}|${JSON.stringify(event.ref)}|${event.at.iso}`;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** The required members of a read-tools bag, all inert: only registration is read. */
const minimalReadDeps: McpReadToolDeps = {
  projects: {
    getProjectsWithSessions: async () => [],
    getArchivedProjectsWithSessions: async () => [],
    getProjectSessionsPage: async () => ({ projectId: 'none', sessions: [] }),
    getProjectIdByPath: () => null,
  },
  sessions: {
    listRecentSessions: () => ({ conversations: [], total: 0 }),
    readSessionLifecycle: () => null,
    fetchHistory: async () => ({ messages: [], total: 0 }),
    fetchOutline: async () => ({ total: 0, turns: [] }),
    fetchWindowAround: async () => ({ messages: [], startIndex: 0, total: 0 }),
  },
  hosts: { snapshot: () => [], liveHostForSession: () => null },
  runs: { listRunningRuns: () => [] },
  now: () => FIXED_NOW,
};

// --------------------------- (a) shapes ---------------------------

test('(a) the declared input bounds and the emitted shapes are field-for-field', async () => {
  const counters = zeroCounters();
  const deps = makeDeps(makeWorld(), counters);

  // The defaults and the bounds, read off the one reader the handler calls.
  assert.equal(readChangesInput({}).limit, MCP_CHANGES_DEFAULT_LIMIT, 'no `limit` defaults to 50');
  assert.equal(MCP_CHANGES_DEFAULT_LIMIT, 50, 'the contract fixes the default at 50');
  assert.equal(readChangesInput({ limit: 1 }).limit, 1);
  assert.equal(readChangesInput({ limit: MCP_CHANGES_MAX_LIMIT }).limit, MCP_CHANGES_MAX_LIMIT);
  assert.equal(MCP_CHANGES_MAX_LIMIT, 200, 'the contract fixes the ceiling at 200');
  // A PRESENT but malformed `limit` is refused, never clamped and never
  // silently replaced by the default: the advertised schema says `integer`, so
  // the reader must agree field for field.
  for (const bad of [0, -1, 201, 9999, 1.5, Number.NaN, '5']) {
    assert.throws(
      () => readChangesInput({ limit: bad }),
      (error: unknown) => codeOf(error) === INVALID_ARGUMENT_CODE,
      `limit=${bad} must be refused INVALID_ARGUMENT`,
    );
  }

  // The ADVERTISED schema enforces the same bound — a warm client that validates
  // against `tools/list` sees the refusal coming.
  const inputSchema = z.object(MCP_CHANGES_INPUT_SCHEMA);
  assert.equal(inputSchema.safeParse({}).success, true, 'an empty argument object is a legal call');
  assert.equal(inputSchema.safeParse({ limit: MCP_CHANGES_MAX_LIMIT }).success, true);
  assert.equal(inputSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(inputSchema.safeParse({ limit: 201 }).success, false);
  assert.equal(inputSchema.safeParse({ limit: 1.5 }).success, false, 'the advertised limit must be an integer');
  assert.equal(inputSchema.safeParse({ limit: '5' }).success, false);
  assert.equal(
    inputSchema.safeParse({ kinds: ['bogus'] }).success,
    false,
    'the advertised `kinds` enum admits only the contract vocabulary',
  );

  const payload = await buildChanges(readChangesInput({}), undefined, deps);

  // The output schema validates the payload FIELD FOR FIELD: a shape that drifted
  // from the advertisement would throw here.
  z.object(MCP_CHANGES_OUTPUT_SCHEMA).parse(payload);

  assert.ok(payload.events.length > 0, 'the seeded world must produce events');
  for (const event of payload.events) {
    assert.ok(
      ['liveness', 'progress', 'blocked'].includes(event.signal),
      `signal must be one of three, got ${event.signal}`,
    );
    assert.ok(
      ['db.sessions', 'mem.runs', 'mem.approvals', 'quay.cache', 'quay.index', 'git'].includes(event.source.type),
      `source.type must be a declared source, got ${event.source.type}`,
    );
    assert.equal(typeof event.source.ageMs, 'number');
    assert.ok(event.source.ageMs >= 0, 'an age is never negative');
    assert.equal(typeof event.summary, 'string');
    assert.ok(
      Number.isFinite(Date.parse(event.at.iso)),
      `${event.at.iso} must be a real instant`,
    );
    assert.ok(
      Number.isFinite(Date.parse(event.source.observedAt.iso)),
      'source.observedAt must be a real instant',
    );
  }

  // The message BODY never reaches the stream: the marker a session message
  // carries is nowhere in the response, and the reader that would return it was
  // never called.
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(BODY_MARKER), 'a session message body must not appear in the response');
  assert.equal(counters.fetchHistory, 0, 'changes must not read session message bodies');

  // The stream with no cursor is the whole workspace. `complete` is honest about
  // the one configured project: AC-348 redefined it as "no gap, no truncation,
  // and every in-scope Quay source `ready`", and a first reading of a project
  // BOOTSTRAPS — it has compared nothing yet, so claiming completeness would be
  // exactly the D2 defect. A bootstrap is still not a gap: the baseline is a real
  // reading.
  assert.equal(payload.complete, false, 'a first reading has no baseline to be complete about');
  assert.deepEqual(payload.gaps, [], 'a bootstrap is a reading, not a gap');
  assert.equal(payload.sources.find((source) => source.project === 'proj-1')?.state, 'bootstrap');

  // Negative control: the same world re-read with the cursor it just issued IS
  // complete and emits nothing, so the `false` above is the bootstrap rather than
  // a constant of every reading.
  const settled = await buildChanges(readChangesInput({ cursor: payload.cursor }), undefined, deps);
  assert.equal(settled.complete, true, 'a baseline plus a ready index is complete');
  assert.deepEqual(settled.gaps, []);
  assert.deepEqual(settled.events, [], 'nothing moved between the two readings');
});

// --------------------------- (b) the scripted changes ---------------------------

test('(b) the second call sees exactly the scripted changes, each with the right signal', async () => {
  const world = makeWorld();
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  // Baseline: the cursor a caller would have from a previous poll. It BOOTSTRAPS
  // the one Quay source (AC-348) — the cursor had never seen proj-1, so this
  // reading records the baseline and emits nothing rather than announcing every
  // task as new — and therefore does not claim completeness. It is not a gap.
  const baseline = await buildChanges(readChangesInput({}), undefined, deps);
  assert.equal(baseline.complete, false, 'a first reading has compared nothing yet');
  assert.deepEqual(baseline.gaps, [], 'a bootstrap is a reading, not a gap');
  assert.deepEqual(
    baseline.sources.map((source) => source.state),
    ['bootstrap'],
  );

  // The five changes the AC names, and the clock advances past all of them.
  world.now = LATER;
  world.sessionRows.push({
    sessionId: 'sess-msg-1',
    projectId: 'proj-1',
    title: 'New turn in Alpha',
    updatedAtMs: LATER - 1000,
  });
  world.sessionProject.set('sess-msg-1', 'proj-1');
  // A run that starts after the watermark…
  world.runs.push({ runId: 'run-1', sessionId: 'sess-msg-1', status: 'running', startedAt: LATER - 900, completedAt: null });
  // …and one that started BEFORE it and settles now: only its END is a change.
  world.runs.push({
    runId: 'run-2',
    sessionId: 'sess-msg-1',
    status: 'completed',
    startedAt: FIXED_NOW - MINUTE,
    completedAt: LATER - 800,
  });
  world.approvals.push({ requestId: 'req-1', sessionId: 'sess-msg-1', toolName: 'Bash', receivedAtMs: LATER - 700 });
  // The Quay task's status TRANSITION — the cursor's head remembers `todo`. The
  // load that lands it also stamps when it was observed, exactly as a real load
  // does, so this reading's `source.observedAt` is the index's own instant.
  world.quayIndex.set('proj-1', [
    { taskId: 'QX-1', title: 'First task', status: 'ready', updatedAt: new Date(LATER - 600).toISOString() },
  ]);
  world.quayIndexObservedAt.set('proj-1', LATER);

  const next = await buildChanges(readChangesInput({ cursor: baseline.cursor }), undefined, deps);

  assert.deepEqual(
    signals(next),
    ['session/liveness', 'run/progress', 'run/progress', 'interaction/blocked', 'quay_task/progress'].sort(),
    'exactly the five scripted changes, each with its own signal',
  );
  assert.equal(next.events.length, 5, 'no change may be invented and none omitted');
  assert.equal(next.complete, true, 'a page that fit is complete');
  assert.deepEqual(next.gaps, []);

  // The reading is attributable, not just correctly shaped.
  const sessionEvent = next.events.find((event) => event.kind === 'session');
  assert.equal(sessionEvent?.ref.sessionId, 'sess-msg-1');
  assert.equal(sessionEvent?.project.id, 'proj-1');
  assert.equal(sessionEvent?.project.title, 'Alpha');
  assert.equal(sessionEvent?.source.type, 'db.sessions');

  const runEvents = next.events.filter((event) => event.kind === 'run');
  const started = runEvents.find((event) => event.ref.runId === 'run-1');
  const ended = runEvents.find((event) => event.ref.runId === 'run-2');
  assert.match(String(started?.summary), /started/, 'a run that started reads as started');
  assert.match(String(ended?.summary), /ended/, 'a run that settled reads as ended');
  assert.equal(ended?.source.type, 'mem.runs');

  const approvalEvent = next.events.find((event) => event.kind === 'interaction');
  assert.equal(approvalEvent?.signal, 'blocked', 'a waiting approval is the blocked signal');
  assert.equal(approvalEvent?.source.type, 'mem.approvals');
  assert.match(String(approvalEvent?.summary), /req-1/);
  assert.match(String(approvalEvent?.summary), /Bash/);

  const quayEvent = next.events.find((event) => event.kind === 'quay_task');
  assert.equal(quayEvent?.ref.taskId, 'QX-1');
  assert.equal(quayEvent?.project.id, 'proj-1');
  assert.equal(quayEvent?.source.type, 'quay.index', 'the source is the index, never the ten-row cache');
  assert.match(String(quayEvent?.summary), /moved from todo to ready/, 'a transition names both sides');
  assert.deepEqual(quayEvent?.transition, { from: 'todo', to: 'ready' }, 'the transition is machine-readable');
  assert.equal(quayEvent?.atSource, 'record.updatedAt', 'a transition is dated by the store, not the observer');
  assert.equal(
    quayEvent?.at.iso,
    new Date(LATER - 600).toISOString(),
    '`at` is the record own `updatedAt` — not the instant this reading happened',
  );
  assert.equal(
    quayEvent?.source.observedAt.iso,
    new Date(LATER).toISOString(),
    '`source.observedAt` is when the INDEX was loaded',
  );
  assert.equal(quayEvent?.source.ageMs, 600, '`ageMs` is the observer-minus-record difference');
  const quaySource = next.sources.find((source) => source.project === 'proj-1');
  assert.equal(quaySource?.state, 'ready');
  assert.equal(quaySource?.coverage, 'full');
  assert.equal(quaySource?.taskCount, 1);

  // The ONE `projects` parameter covers both scopes: naming proj-2 keeps only
  // proj-2's events, and drops the proj-1 session / run / approval / task.
  const betaOnly = await buildChanges(
    readChangesInput({ cursor: baseline.cursor, projects: ['proj-2'] }),
    undefined,
    deps,
  );
  assert.deepEqual(betaOnly.events, [], 'naming a project admits only that project');

  // …and a workspace reading admits an event whose project cannot be resolved,
  // while a project filter does not.
  world.sessionRows.push({ sessionId: 'sess-orphan', projectId: null, title: 'Orphan', updatedAtMs: LATER - 500 });
  world.sessionProject.set('sess-orphan', null);
  const workspace = await buildChanges(readChangesInput({ cursor: baseline.cursor }), undefined, deps);
  assert.ok(
    workspace.events.some((event) => event.ref.sessionId === 'sess-orphan'),
    'workspace scope admits an unresolvable project',
  );
  const filtered = await buildChanges(
    readChangesInput({ cursor: baseline.cursor, projects: ['proj-2'] }),
    undefined,
    deps,
  );
  assert.ok(
    !filtered.events.some((event) => event.ref.sessionId === 'sess-orphan'),
    'a project filter admits only the ids it named',
  );

  // `kinds` narrows the stream to the kinds asked for.
  const sessionsOnly = await buildChanges(
    readChangesInput({ cursor: baseline.cursor, kinds: ['session'] }),
    undefined,
    deps,
  );
  assert.ok(sessionsOnly.events.length > 0);
  assert.ok(sessionsOnly.events.every((event) => event.kind === 'session'));
});

// --------------------------- (c) at-least-once ---------------------------

test('(c) the same cursor read twice is identical, and paging never drops an event', async () => {
  const world = makeWorld();
  const deps = makeDeps(world, zeroCounters());

  const baseline = await buildChanges(readChangesInput({}), undefined, deps);
  world.now = LATER;
  world.sessionRows.push({ sessionId: 'sess-msg-1', projectId: 'proj-1', title: 'Turn', updatedAtMs: LATER - 5000 });
  world.sessionProject.set('sess-msg-1', 'proj-1');
  world.runs.push({ runId: 'run-1', sessionId: 'sess-msg-1', status: 'running', startedAt: LATER - 4000, completedAt: null });
  world.runs.push({
    runId: 'run-2',
    sessionId: 'sess-msg-1',
    status: 'aborted',
    startedAt: FIXED_NOW - MINUTE,
    completedAt: LATER - 3000,
  });
  world.approvals.push({ requestId: 'req-1', sessionId: 'sess-msg-1', toolName: 'Edit', receivedAtMs: LATER - 2000 });
  world.quayIndex.set('proj-1', [
    { taskId: 'QX-1', title: 'First task', status: 'done', updatedAt: new Date(LATER - 1000).toISOString() },
  ]);
  world.quayIndexObservedAt.set('proj-1', LATER);

  const first = await buildChanges(readChangesInput({ cursor: baseline.cursor }), undefined, deps);
  const repeat = await buildChanges(readChangesInput({ cursor: baseline.cursor }), undefined, deps);
  assert.deepEqual(repeat, first, 'the same cursor re-read yields the same page (repeatable, not consuming)');

  // A truncated page must not skip the event it cut: the next watermark stops
  // short so the boundary is re-read, and the union of the pages is the whole
  // change set.
  const seen = new Set<string>();
  let cursor: string = baseline.cursor;
  let guard = 0;
  let lastWatermark = baseline.cursor;
  while (guard < 20) {
    guard += 1;
    const page = await buildChanges(readChangesInput({ cursor, limit: 2 }), undefined, deps);
    for (const event of page.events) {
      seen.add(eventKey(event));
    }
    if (page.complete) {
      break;
    }
    assert.notEqual(page.cursor, cursor, 'an incomplete page must advance its cursor');
    cursor = page.cursor;
    lastWatermark = page.cursor;
  }
  assert.ok(guard < 20, 'paging must terminate');
  assert.notEqual(lastWatermark, undefined);
  assert.deepEqual(
    [...seen].sort(),
    first.events.map(eventKey).sort(),
    'the union of the paged reads is exactly the change set — nothing lost',
  );
  assert.equal(seen.size, first.events.length, 'the union has no phantom event');
});

// --------------------------- (d) boot change ---------------------------

test('(d) a cursor from a previous boot reports gaps and never claims completeness', async () => {
  const world = makeWorld();
  const deps = makeDeps(world, zeroCounters());

  const baseline = await buildChanges(readChangesInput({}), undefined, deps);
  world.bootId = 'boot-2';

  const after = await buildChanges(readChangesInput({ cursor: baseline.cursor }), undefined, deps);
  assert.equal(after.complete, false, 'a reading that cannot see in-memory history must not claim complete');
  const gapKinds = after.gaps.map((gap) => gap.kind).sort();
  assert.ok(gapKinds.includes('run'), 'the run stream must be declared invisible across a restart');
  assert.ok(gapKinds.includes('interaction'), 'the approval stream must be declared invisible across a restart');
  for (const gap of after.gaps) {
    assert.ok(gap.reason.length > 0, 'a gap must say why');
  }

  // Negative control: the SAME boot reports no such gap, so the gaps above are
  // the boot check and not a constant of every reading.
  const sameBootWorld = makeWorld();
  const sameBootDeps = makeDeps(sameBootWorld, zeroCounters());
  const first = await buildChanges(readChangesInput({}), undefined, sameBootDeps);
  const second = await buildChanges(readChangesInput({ cursor: first.cursor }), undefined, sameBootDeps);
  assert.deepEqual(second.gaps, [], 'a same-boot cursor has no restart gap');
  assert.equal(second.complete, true);
});

// --------------------------- (e) no heavy work, honest cold index ---------------------------

test('(e) changes never synchronizes sessions or spawns a Quay CLI, and a cold index is a gap', async () => {
  const world = makeWorld();
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  // proj-1 HAS a quay config but its index has never landed; proj-2 has no config
  // at all. This is the leg AC-348 revises: the source is the full-coverage index,
  // so "cold" is the absence of a LOAD, not an expired 30-second snapshot TTL.
  world.quayIndex.set('proj-1', null);
  world.quayIndexPending.add('proj-1');

  const cold = await buildChanges(readChangesInput({}), undefined, deps);
  assert.equal(counters.synchronizeSessions, 0, 'changes must never run a full session synchronisation');
  assert.equal(counters.refreshQuay, 0, 'changes must never refresh (spawn) the Quay CLI');
  assert.equal(counters.fetchHistory, 0, 'changes must never read session message bodies');

  // The NEVER-AWAITS reading, structurally: this very call ASKED for a load, and
  // it still reports the index as never observed — so it cannot have waited for
  // one. (`requestTaskIndexLoad` returns `void`; there is nothing to await.)
  assert.equal(counters.indexLoadRequests.get('proj-1'), 1, 'the read path asks for the load it needs');
  const coldSource = cold.sources.find((source) => source.project === 'proj-1');
  assert.equal(coldSource?.state, 'warming', 'an in-flight load is warming, never a wait');
  assert.equal(coldSource?.observedAt, null, 'nothing had been observed when the call returned');
  assert.equal(coldSource?.taskCount, 0);
  assert.deepEqual(
    cold.events.filter((event) => event.kind === 'quay_task'),
    [],
    'an unread index produces no events rather than guessing',
  );

  const quayGaps = cold.gaps.filter((gap) => gap.kind === 'quay_task');
  assert.equal(quayGaps.length, 1, 'exactly the configured-but-cold project is reported');
  assert.match(quayGaps[0].reason, /warming/i, 'the gap says where the index stands');
  assert.equal(quayGaps[0].state, 'warming', 'the gap carries the machine-readable state beside the prose');
  assert.equal(cold.complete, false, 'a gap means the reading is not complete');
  assert.ok(
    !cold.gaps.some((gap) => gap.reason.includes('proj-2')),
    'an unconfigured project is simply absent, never a gap',
  );
  assert.deepEqual(
    cold.sources.map((source) => source.project),
    ['proj-1'],
    'an unconfigured project is not a Quay source at all',
  );

  // Cold reading, cold reading: the counters stay 0 and the state is a READING of
  // the index rather than a first-call artefact — a repeat call, cursor in hand,
  // reports exactly the same thing.
  const coldAgain = await buildChanges(readChangesInput({ cursor: cold.cursor }), undefined, deps);
  assert.equal(coldAgain.sources.find((source) => source.project === 'proj-1')?.state, 'warming');
  assert.equal(coldAgain.complete, false);
  assert.deepEqual(coldAgain.events, []);
  assert.equal(counters.synchronizeSessions, 0);
  assert.equal(counters.refreshQuay, 0);

  // The load lands (the NEXT reading is where a background load ever shows up),
  // and the reading that has a baseline is complete with no heavy source touched.
  world.quayIndexPending.delete('proj-1');
  world.quayIndex.set('proj-1', [
    { taskId: 'QX-1', title: 'First task', status: 'todo', updatedAt: new Date(FIXED_NOW - MINUTE).toISOString() },
  ]);
  world.quayIndexObservedAt.set('proj-1', world.now);
  const bootstrapped = await buildChanges(readChangesInput({ cursor: coldAgain.cursor }), undefined, deps);
  assert.equal(bootstrapped.sources.find((source) => source.project === 'proj-1')?.state, 'bootstrap');
  assert.deepEqual(bootstrapped.events, [], 'the first full reading of a project is a baseline, not news');
  const warm = await buildChanges(readChangesInput({ cursor: bootstrapped.cursor }), undefined, deps);
  assert.equal(warm.complete, true);
  assert.deepEqual(warm.events, []);
  assert.equal(counters.synchronizeSessions, 0);
  assert.equal(counters.refreshQuay, 0);
  assert.equal(counters.fetchHistory, 0);
});

// --------------------------- (f) cursor refusal ---------------------------

test('(f) a cursor this tool did not issue is refused INVALID_ARGUMENT', async () => {
  const world = makeWorld();
  const deps = makeDeps(world, zeroCounters());

  const issued = (await buildChanges(readChangesInput({}), undefined, deps)).cursor;
  // A round trip through the codec is a cursor this tool issued.
  const roundTripped = encodeChangesCursor(decodeChangesCursor(issued));
  assert.equal(
    (await buildChanges(readChangesInput({ cursor: roundTripped }), undefined, deps)).bootId,
    world.bootId,
    'a re-encoded cursor is still accepted',
  );

  const payload = Buffer.from(issued, 'base64url');
  const json = JSON.parse(payload.subarray(1).toString('utf8')) as Record<string, unknown>;
  const withVersion = (body: Record<string, unknown>, version = 1): string =>
    Buffer.concat([Buffer.from([version]), Buffer.from(JSON.stringify(body), 'utf8')]).toString('base64url');

  const badCursors: Array<[string, string]> = [
    ['a non-base64url character', 'not-a-cursor!!'],
    ['a payload with no JSON after the version byte', Buffer.from([1]).toString('base64url')],
    ['a foreign version byte', withVersion(json, 3)],
    ['a wrong-shaped watermark', withVersion({ ...json, watermark: 'soon' })],
    ['a wrong-shaped head', withVersion({ ...json, perProjectHead: 'nope' })],
    ['a payload missing the head', withVersion({ v: 1, watermark: 0, bootId: 'x' })],
    ['a decoded body that is not a cursor at all', Buffer.from([1, 0x66, 0x6f, 0x6f]).toString('base64url')],
  ];

  for (const [label, cursor] of badCursors) {
    await assert.rejects(
      () => buildChanges(readChangesInput({ cursor }), undefined, deps),
      (error: unknown) => codeOf(error) === INVALID_ARGUMENT_CODE,
      `${label} must be refused INVALID_ARGUMENT`,
    );
  }

  // A blank cursor is treated as "no cursor" (the same reading `session_read`'s
  // cursor carries), never as a tampered one.
  const blank = await buildChanges(readChangesInput({ cursor: '' }), undefined, deps);
  assert.equal(typeof blank.cursor, 'string');
  assert.equal(blank.bootId, world.bootId);
});

// --------------------------- registration ---------------------------

test('the stage-3 table owns the name, and the wired / unwired branches agree', async () => {
  const entry = MCP_STAGE3_READ_TOOLS.find((tool) => tool.name === 'changes');
  assert.ok(entry, 'the stage-3 read table must declare `changes`');
  assert.equal(entry.requiredScope, READ_SCOPE, '`changes` requires cloudcli:read');
  assert.ok(entry.description && entry.description.length > 0, 'the tool must carry a description');

  const names = MCP_STAGE3_READ_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'no name may be declared twice');

  // Unwired: the name is still registered, through the body-table refusal.
  const unwired: McpReadToolRegistration[] = [];
  registerMcpReadTools((registration) => unwired.push(registration), minimalReadDeps);
  const unwiredChanges = unwired.find((registration) => registration.name === 'changes');
  assert.ok(unwiredChanges, '`changes` is registered even when its deps are unwired');
  assert.equal(unwiredChanges.requiredScope, READ_SCOPE);
  await assert.rejects(
    async () => {
      await unwiredChanges.handler({}, undefined);
    },
    (error: unknown) => codeOf(error) === MCP_TOOL_NOT_IMPLEMENTED_CODE,
    'an unwired mount refuses `changes` by name',
  );

  // Wired: the same name, registered by the real handler.
  const world = makeWorld();
  const deps = makeDeps(world, zeroCounters());
  const wired: McpReadToolRegistration[] = [];
  registerMcpReadTools((registration) => wired.push(registration), { ...minimalReadDeps, changes: deps });
  const wiredChanges = wired.find((registration) => registration.name === 'changes');
  assert.ok(wiredChanges, 'a wired mount registers `changes`');
  assert.equal(wiredChanges.requiredScope, READ_SCOPE);

  const payload = (await wiredChanges.handler({}, undefined)) as McpChangesPayload;
  z.object(MCP_CHANGES_OUTPUT_SCHEMA).parse(payload);
  assert.equal(payload.bootId, world.bootId);
  assert.equal(typeof payload.cursor, 'string');
  assert.ok(payload.cursor.length > 0);

  // The branch that decides between the two is the deps-shape guard.
  assert.equal(isChangesWired({ ...minimalReadDeps, changes: deps }), true);
  assert.equal(isChangesWired(minimalReadDeps), false);
});
