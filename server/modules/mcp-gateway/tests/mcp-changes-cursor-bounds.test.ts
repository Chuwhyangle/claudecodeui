/**
 * AC-349 criterion: the `changes` cursor is BOUNDED, and the per-project Quay
 * baselines it used to embed live SERVER-SIDE in a bounded LRU instead.
 *
 * The defect this reds is D4 of
 * docs/proposals/cloudcli-mcp-control-observability-2026-10.md §11d: a v2 cursor
 * carried one `{tasks: {taskId → status}}` table PER in-scope Quay project, so
 * its size grew with the corpus — ~4.2 KB already for 58 projects with empty
 * heads, ~51 KB once a real project's 672 tasks were in it — and a scope switch
 * wrote a fresh table for the new scope, DROPPING every other project's head.
 * The fix keeps only a compact `{baselineId, digest}` per project in the cursor,
 * holds the baselines in a capacity-bounded LRU, and turns every way a baseline
 * can be LOST (LRU eviction, a tampered/foreign digest, a restart, or a cursor
 * so large the refs had to be trimmed) into an explicit `state: 'rebase'` gap:
 * the caller is told the window may be unreported instead of being handed a
 * fabricated "everything appeared" burst.
 *
 * Everything is driven through the module's injected deps ({@link McpChangesDeps})
 * — a counting fake index for the corpus, a store the test can size so eviction is
 * deterministic. The real service is the AC's DoD, not this criterion.
 *
 * Readings, one leg each:
 *   (a) 58 projects / 8 with a Quay config / 2729 tasks: the cursor stays within
 *       the byte budget across the bootstrap, migration and idle phases;
 *   (b) the cursor embeds no per-task table — one compact ref per Quay project,
 *       and a non-Quay project is absent from it entirely;
 *   (c) a baseline the LRU evicted, or a cursor issued by another boot, reports a
 *       `rebase` gap with `complete: false` and NO events, and the next call has
 *       re-established a baseline and is `ready` again;
 *   (d) switching scope away and back does not re-baseline — the retained ref is
 *       diffed, so no "all tasks are new" burst;
 *   (e) a v2 cursor (which DOES embed a task table) is still accepted, diffed
 *       against exactly once, and the cursor handed back is v3;
 *   (f) the LRU capacity, the per-baseline task cap and the byte budget are code
 *       constants AND are named in the tool description;
 *   (g) when the refs alone exceed the budget the cursor is trimmed, and every
 *       project dropped by that trim reports `rebase` on the next call.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// `auth.middleware.ts` resolves the JWT secret at module-load time, so the
// environment is set before any aliased module is pulled in — the order the
// sibling mcp-changes criteria established.
process.env.JWT_SECRET = 'mcp-changes-cursor-bounds-test-secret';

import type {
  McpChangesBaselineStore,
  McpChangesDeps,
  McpChangesQuayTaskRow,
} from '../mcp-changes.js';

const {
  MCP_CHANGES_BASELINE_LRU_CAPACITY,
  MCP_CHANGES_BASELINE_MAX_TASKS,
  MCP_CHANGES_CURSOR_MAX_BYTES,
  buildChanges,
  createChangesBaselineStore,
  decodeChangesCursor,
  readChangesInput,
} = await import('../mcp-changes.js');
const { MCP_STAGE3_READ_TOOLS } = await import('../mcp-gateway.read-tools.js');

// --------------------------- fixture ---------------------------

/** The instant this reading is taken. */
const NOW_MS = Date.parse('2026-04-01T00:00:00.000Z');
/** Every seeded task's record instant — strictly before `NOW_MS`, so its age reads positive. */
const RECORD_MS = NOW_MS - 120_000;

type World = {
  /** The process identity the deps report; a test flips it to simulate a restart. */
  bootId: string;
  projects: { id: string; title: string }[];
  /** The project ids that carry a `.quay/config.yml`. */
  configured: Set<string>;
  /** Each configured project's full task index. */
  rows: Map<string, McpChangesQuayTaskRow[]>;
};

function taskRow(taskId: string, status: string): McpChangesQuayTaskRow {
  return { taskId, title: `Task ${taskId}`, status, updatedAt: new Date(RECORD_MS).toISOString() };
}

/** A world of `ids`, every one Quay-configured, each holding `count` tasks. */
function smallWorld(ids: string[], count: number): World {
  const rows = new Map<string, McpChangesQuayTaskRow[]>();
  for (const id of ids) {
    rows.set(
      id,
      Array.from({ length: count }, (_, index) => taskRow(`QX-${id}-${String(index).padStart(3, '0')}`, 'todo')),
    );
  }
  return { bootId: 'boot-1', projects: ids.map((id) => ({ id, title: id })), configured: new Set(ids), rows };
}

/** The AC's own corpus: 58 projects, 8 of them Quay, 2729 tasks in total. */
function bigWorld(): World {
  const counts = [700, 672, 450, 400, 250, 150, 80, 27];
  const ids = Array.from({ length: 58 }, (_, index) => `proj-${String(index).padStart(2, '0')}`);
  const rows = new Map<string, McpChangesQuayTaskRow[]>();
  counts.forEach((count, index) => {
    const id = ids[index];
    rows.set(
      id,
      Array.from({ length: count }, (_, task) => taskRow(`QX-${id}-${String(task).padStart(4, '0')}`, 'todo')),
    );
  });
  return { bootId: 'boot-1', projects: ids.map((id) => ({ id, title: id })), configured: new Set(ids.slice(0, 8)), rows };
}

/**
 * The module's own store when the build under test has one, so the legs that need
 * a deterministic capacity can size it; `undefined` on a build that has no store
 * yet, which is what makes the (c) legs red on the pre-change tree.
 */
function makeStore(capacity?: number): McpChangesBaselineStore | undefined {
  return typeof createChangesBaselineStore === 'function'
    ? createChangesBaselineStore(capacity ?? MCP_CHANGES_BASELINE_LRU_CAPACITY)
    : undefined;
}

/** The `changes` deps bag: a counting fake index over `world`, no sessions/runs/approvals. */
function makeDeps(world: World, store?: McpChangesBaselineStore): McpChangesDeps {
  const deps: McpChangesDeps = {
    sessions: { listChangedSince: () => ({ rows: [], hasMore: false }), projectForSession: () => null },
    runs: { listRecentRuns: () => [] },
    approvals: { listPending: () => [] },
    quay: {
      hasQuayConfig: (projectId) => world.configured.has(projectId),
      readTaskIndex: (projectId) => {
        const rows = world.rows.get(projectId) ?? [];
        return {
          state: 'ready' as const,
          coverage: 'full' as const,
          taskCount: rows.length,
          observedAtMs: NOW_MS - 1_000,
          tasks: new Map(rows.map((row) => [row.taskId, row])),
        };
      },
      requestTaskIndexLoad: () => {},
    },
    projects: { list: () => world.projects },
    now: () => NOW_MS,
    bootId: () => world.bootId,
  };
  if (store !== undefined) {
    deps.baselines = store;
  }
  return deps;
}

const statesOf = (page: { sources: { state: string }[] }): string[] => page.sources.map((source) => source.state);

// --------------------------- (a) the byte budget ---------------------------

test('(a) 58 projects / 8 Quay / 2729 tasks: no phase\'s cursor exceeds the byte budget', async () => {
  const world = bigWorld();
  const totalTasks = [...world.rows.values()].reduce((sum, rows) => sum + rows.length, 0);
  assert.equal(totalTasks, 2729, 'the fixture must hold the AC\'s 2729 tasks');
  const deps = makeDeps(world, makeStore());

  const bootstrap = await buildChanges(readChangesInput({}), undefined, deps);
  assert.ok(
    bootstrap.cursor.length <= MCP_CHANGES_CURSOR_MAX_BYTES,
    `bootstrap cursor is ${bootstrap.cursor.length} bytes, over the ${MCP_CHANGES_CURSOR_MAX_BYTES}-byte budget`,
  );

  // Migration: one status transition in each of the 8 Quay projects.
  for (const projectId of world.configured) {
    const rows = world.rows.get(projectId) as McpChangesQuayTaskRow[];
    rows[0] = taskRow(rows[0].taskId, 'ready');
  }
  const migration = await buildChanges(readChangesInput({ cursor: bootstrap.cursor }), undefined, deps);
  assert.ok(
    migration.cursor.length <= MCP_CHANGES_CURSOR_MAX_BYTES,
    `migration cursor is ${migration.cursor.length} bytes, over the ${MCP_CHANGES_CURSOR_MAX_BYTES}-byte budget`,
  );

  const idle = await buildChanges(readChangesInput({ cursor: migration.cursor }), undefined, deps);
  assert.ok(
    idle.cursor.length <= MCP_CHANGES_CURSOR_MAX_BYTES,
    `idle cursor is ${idle.cursor.length} bytes, over the ${MCP_CHANGES_CURSOR_MAX_BYTES}-byte budget`,
  );

  assert.equal(decodeChangesCursor(idle.cursor).v, 3, 'this build issues v3 cursors');
});

// --------------------------- (b) no embedded task table ---------------------------

test('(b) the cursor embeds no task table: one compact {baselineId, digest} per Quay project', async () => {
  const world = bigWorld();
  const deps = makeDeps(world, makeStore());
  const page = await buildChanges(readChangesInput({}), undefined, deps);
  const decoded = decodeChangesCursor(page.cursor);

  const configured = [...world.configured].sort();
  const baselines: Record<string, { baselineId?: unknown; digest?: unknown }> = decoded.baselines ?? {};
  assert.deepEqual(Object.keys(baselines).sort(), configured, 'every Quay project is referenced by a compact ref');
  for (const projectId of configured) {
    const ref = baselines[projectId];
    assert.equal(typeof ref.baselineId, 'string', `${projectId} must carry a baselineId`);
    assert.match(String(ref.digest), /^[0-9a-f]{64}$/, `${projectId}'s digest must be a sha256 hex digest`);
  }

  // The whole point: no task id ↔ status table rides in the cursor any more.
  assert.equal(
    JSON.stringify(decoded).includes('"tasks"'),
    false,
    'the cursor must not embed a per-task table',
  );
  assert.equal(decoded.legacyHead, undefined, 'a v3 cursor carries no legacy per-project head');

  // A project without a Quay config is not a Quay source: it is absent, not empty.
  const nonQuay = world.projects.map((project) => project.id).filter((id) => !world.configured.has(id));
  assert.ok(nonQuay.length > 0, 'the fixture must have non-Quay projects');
  for (const id of nonQuay) {
    assert.equal(baselines[id], undefined, `non-Quay project ${id} must be absent from the cursor`);
  }
});

// --------------------------- (c) a lost baseline reports rebase ---------------------------

test('(c) a baseline the LRU evicted reports a rebase gap — never a fabricated "everything appeared"', async () => {
  const world = smallWorld(['proj-a', 'proj-b', 'proj-c'], 3);
  // Capacity 2 with 3 projects: writing the third ref evicts the first's baseline.
  const deps = makeDeps(world, makeStore(2));

  const a = await buildChanges(readChangesInput({ projects: ['proj-a'] }), undefined, deps);
  const b = await buildChanges(readChangesInput({ projects: ['proj-b'], cursor: a.cursor }), undefined, deps);
  const c = await buildChanges(readChangesInput({ projects: ['proj-c'], cursor: b.cursor }), undefined, deps);

  // Out-of-scope projects' refs ride through untouched — the baseline loss below is
  // the LRU's doing, not a scope switch dropping the head.
  const carried: Record<string, unknown> = decodeChangesCursor(c.cursor).baselines ?? {};
  for (const id of ['proj-a', 'proj-b', 'proj-c']) {
    assert.ok(carried[id], `an out-of-scope project's ref (${id}) must survive the scope switch`);
  }

  // proj-a's baseline was evicted; coming back must REPORT the loss.
  const back = await buildChanges(readChangesInput({ projects: ['proj-a'], cursor: c.cursor }), undefined, deps);
  const rebaseGaps = back.gaps.filter((gap) => gap.kind === 'quay_task' && gap.state === 'rebase');
  assert.equal(rebaseGaps.length, 1, 'the evicted project must produce exactly one rebase gap');
  assert.match(
    rebaseGaps[0].reason,
    /evict|may .*not .*report|may be missing|not reported/i,
    'the rebase reason must say changes in that window may be unreported',
  );
  assert.deepEqual(statesOf(back), ['rebase'], 'the source reports the rebase, not a silent bootstrap');
  assert.equal(back.complete, false, 'a rebase reading cannot claim completeness');
  assert.equal(back.events.length, 0, 'a rebase must fabricate no events');

  // The next call has re-established a baseline from the current index.
  const after = await buildChanges(readChangesInput({ projects: ['proj-a'], cursor: back.cursor }), undefined, deps);
  assert.deepEqual(statesOf(after), ['ready'], 'the call after a rebase is re-baselined and ready');
  assert.deepEqual(after.gaps, []);
  assert.equal(after.events.length, 0, 'an unchanged index after re-baselining emits nothing');
});

test('(c) a cursor from another boot rebases every carried Quay project', async () => {
  const world = smallWorld(['proj-a', 'proj-b'], 4);
  const deps = makeDeps(world, makeStore());
  const first = await buildChanges(readChangesInput({}), undefined, deps);
  assert.deepEqual(statesOf(first), ['bootstrap', 'bootstrap'], 'a first sighting is a bootstrap, not a change');

  world.bootId = 'boot-2';
  const restarted = await buildChanges(readChangesInput({ cursor: first.cursor }), undefined, deps);
  const rebaseGaps = restarted.gaps.filter((gap) => gap.kind === 'quay_task' && gap.state === 'rebase');
  assert.equal(rebaseGaps.length, 2, 'every carried Quay baseline must report a rebase after a restart');
  assert.match(
    rebaseGaps[0].reason,
    /restart|may .*not .*report|may be missing|not reported/i,
    'the reason must say migrations in the restart window may be unreported',
  );
  assert.deepEqual(statesOf(restarted), ['rebase', 'rebase']);
  assert.equal(restarted.complete, false);
  assert.equal(restarted.events.length, 0, 'a restart rebase fabricates no events');

  const next = await buildChanges(readChangesInput({ cursor: restarted.cursor }), undefined, deps);
  assert.deepEqual(statesOf(next), ['ready', 'ready'], 'the next call is re-baselined');
  assert.deepEqual(next.gaps, []);
});

// --------------------------- (d) scope switching ---------------------------

test('(d) switching scope away and back does not re-baseline (no "all tasks are new" burst)', async () => {
  const world = smallWorld(['proj-a', 'proj-b'], 5);
  const deps = makeDeps(world, makeStore());

  const seen = await buildChanges(readChangesInput({ projects: ['proj-a'] }), undefined, deps);
  assert.deepEqual(statesOf(seen), ['bootstrap']);
  const elsewhere = await buildChanges(readChangesInput({ projects: ['proj-b'], cursor: seen.cursor }), undefined, deps);
  const returned = await buildChanges(readChangesInput({ projects: ['proj-a'], cursor: elsewhere.cursor }), undefined, deps);

  assert.deepEqual(
    statesOf(returned),
    ['ready'],
    'coming back to a project must diff against its retained baseline, not re-baseline',
  );
  assert.equal(returned.events.length, 0, 'an unchanged project must not report all its tasks as new');
  assert.deepEqual(returned.gaps, []);
  // The reading is not vacuous: a dropped head would surface as `bootstrap` here.
  assert.notEqual(returned.sources[0].state, 'bootstrap');
});

// --------------------------- (e) legacy cursors ---------------------------

test('(e) a v2 cursor (which DOES embed a task table) is accepted, diffed once, and upgraded to v3', async () => {
  const world = smallWorld(['proj-a'], 3);
  const deps = makeDeps(world, makeStore());
  const rows = world.rows.get('proj-a') as McpChangesQuayTaskRow[];
  const table: Record<string, string> = {};
  for (const row of rows) {
    table[row.taskId] = row.status;
  }
  const v2Body = {
    v: 2,
    watermark: NOW_MS - 10_000,
    bootId: world.bootId,
    perProjectHead: { 'proj-a': { tasks: table } },
    sessionKey: null,
  };
  const v2Cursor = Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify(v2Body), 'utf8')]).toString('base64url');

  const page = await buildChanges(readChangesInput({ cursor: v2Cursor }), undefined, deps);
  assert.equal(page.events.length, 0, 'an unchanged index diffs empty against the legacy table (it is used, not rejected)');
  const decoded = decodeChangesCursor(page.cursor);
  assert.equal(decoded.v, 3, 'the cursor handed back is migrated to v3');
  const baselines: Record<string, { digest?: unknown }> = decoded.baselines ?? {};
  assert.match(String(baselines['proj-a']?.digest), /^[0-9a-f]{64}$/, 'the migrated cursor references a server-side baseline');

  // A migration in that one window IS reported: the legacy table was genuinely diffed.
  rows[0] = taskRow(rows[0].taskId, 'ready');
  const moved = await buildChanges(readChangesInput({ cursor: v2Cursor }), undefined, deps);
  assert.equal(moved.events.length, 1, 'the legacy baseline must still surface the one transition');
  assert.deepEqual(moved.events[0].transition, { from: 'todo', to: 'ready' });
});

// --------------------------- (f) the caps are declared ---------------------------

test('(f) the caps are code constants AND are named in the `changes` tool description', async () => {
  assert.equal(MCP_CHANGES_CURSOR_MAX_BYTES, 8192, 'the cursor byte budget must be 8192');
  assert.equal(MCP_CHANGES_BASELINE_LRU_CAPACITY, 256, 'the baseline LRU capacity must be 256');
  assert.equal(MCP_CHANGES_BASELINE_MAX_TASKS, 10000, 'the per-baseline task cap must be 10000');

  const changes = MCP_STAGE3_READ_TOOLS.find((tool) => tool.name === 'changes');
  assert.ok(changes, 'the stage-3 table must carry a `changes` entry');
  const description: string = changes.description;
  assert.match(description, /8192/, 'the description must name the cursor byte budget');
  assert.match(description, /256/, 'the description must name the LRU capacity');
  assert.match(description, /10[_,]?000/, 'the description must name the per-baseline task cap');
  assert.match(description, /rebas/i, 'the description must name the rebase behavior');
});

// --------------------------- (g) trimming to the budget ---------------------------

test('(g) refs exceeding the budget are trimmed, and every dropped project reports rebase next call', async () => {
  const ids = Array.from({ length: 200 }, (_, index) => `p${String(index).padStart(3, '0')}`);
  const world = smallWorld(ids, 2);
  const deps = makeDeps(world, makeStore());

  const first = await buildChanges(readChangesInput({}), undefined, deps);
  assert.ok(
    first.cursor.length <= MCP_CHANGES_CURSOR_MAX_BYTES,
    `a ${ids.length}-project cursor must fit the budget, got ${first.cursor.length}`,
  );
  const decoded = decodeChangesCursor(first.cursor);
  const referenced = Object.keys(decoded.baselines ?? {});
  const rebased = decoded.rebased ?? [];
  assert.ok(referenced.length < ids.length, 'the byte budget must force some baselines out of the cursor');
  assert.ok(rebased.length > 0, 'the projects dropped from the cursor must be marked for rebase');

  const second = await buildChanges(readChangesInput({ cursor: first.cursor }), undefined, deps);
  const rebaseGaps = second.gaps.filter((gap) => gap.kind === 'quay_task' && gap.state === 'rebase');
  assert.equal(rebaseGaps.length, rebased.length, 'every dropped project must report exactly one rebase gap');
  assert.equal(second.complete, false);
  assert.equal(second.events.length, 0, 'a trimmed cursor must not fabricate an all-new burst either');
});
