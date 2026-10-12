/**
 * `changes`' Quay source: full-coverage compact status index, loaded
 * asynchronously (AC-348, revising AC-335 (e)).
 *
 * AC-335's Quay leg read `snapshot.tasks.recent`, which the panel truncates to
 * `QUAY_RECENT_LIST_LIMIT` (10) rows: a transition on the eleventh-ranked task
 * was invisible, and the reading still claimed `complete`. AC-348 replaces that
 * source with a per-project COMPACT STATUS INDEX built from
 * `task list --json --no-body` — every task, no body — loaded NON-BLOCKING,
 * deduped and rate-limited inside the quay service, and reported per project in
 * a new `sources[]` field, so `cold` / `warming` / `bootstrap` / `stale` /
 * `ready` / `error` are legible instead of being flattened into "no change".
 *
 * This criterion drives the REAL modules twice over: `createQuayService` owns
 * the index, the loader and its budget, and it is composed into the REAL
 * `buildChanges` through the SAME three-member bag `server/index.ts` binds. The
 * loader the counters watch is the service's own `runCommand` dependency, so
 * "one load per project per minute" is a reading of the shipped rate limiter —
 * not of a test double that could be deduping on the implementation's behalf.
 *
 * Readings, one leg each:
 *   (a) FULL COVERAGE: with a 30-task project whose fifteenth-ranked task
 *       transitions, exactly one `quay_task` event appears — a reading taken
 *       from `recent` (the newest ten) could not have seen it — and the
 *       `sources` entry says `coverage: 'full'` / `taskCount: 30`;
 *   (b) BOOTSTRAP: a project the cursor has never seen emits NO event on its
 *       first full reading, reports `state: 'bootstrap'`, and records the
 *       baseline; only a task that appears AFTER that baseline becomes an
 *       `appeared` event (a cursor with no baseline must never turn a whole
 *       project into "everything is new");
 *   (c) FOUR INSTANTS: a transition carries `transition.from`/`to`, its `at` is
 *       the RECORD's own `updatedAt` (with `atSource: 'record.updatedAt'`), its
 *       `source.observedAt` is when the INDEX was loaded, and `ageMs` is the
 *       difference — so the same transition re-read later has the same `at` and
 *       `(kind, ref, at)` still dedupes;
 *   (d) NON-BLOCKING: with a loader that never resolves, `changes` returns well
 *       inside 50 ms, reports the index as `cold`/`warming` with a
 *       machine-readable gap and `complete: false`, and twenty concurrent and
 *       repeated calls inside one minute run the loader EXACTLY once per
 *       project — with zero whole-snapshot CLI runs;
 *   (e) STALE: an index past its freshness window keeps its data and still
 *       diffs (no event is lost, the reading is not "absent"), reports
 *       `state: 'stale'` with `observedAt`/`ageMs`, and `complete: false` — and
 *       the same index inside the window is `ready` and complete (the negative
 *       control that makes `stale` a reading rather than a constant);
 *   (f) RESTART / CLEARED INDEX: a cursor that carries a baseline while the
 *       server's index is empty invents NO event, reports the gap, keeps the
 *       baseline in the next cursor, and diffs against that baseline once the
 *       load lands — one real change, not "every task is new".
 *
 * The whitelist entry that makes the load legal at all (AC-348 (g)) is read in
 * `quay.service.test.ts`, beside the command table it belongs to.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

// The gateway's auth module pulls `@/shared/utils.js`, which freezes IS_PLATFORM
// on first import, so the environment is set before any aliased module loads and
// every application module below comes in dynamically.
process.env.JWT_SECRET = 'mcp-changes-quay-index-test-secret';

import type { McpChangesDeps, McpChangesEvent, McpChangesPayload } from '../mcp-changes.js';

const {
  MCP_CHANGES_OUTPUT_SCHEMA,
  MCP_CHANGES_SOURCE_STATES,
  buildChanges,
  decodeChangesCursor,
  readChangesInput,
} = await import('../mcp-changes.js');
// `createQuayService` is the module's own factory, re-exported by its barrel:
// the same symbol `quay.module.ts` composes in production.
const { QUAY_TASK_INDEX_MIN_INTERVAL_MS, QUAY_TASK_INDEX_TTL_MS, createQuayService } = await import(
  '@/modules/quay/index.js'
);

// --------------------------- fixture ---------------------------

const FIXED_NOW = Date.parse('2026-03-01T12:00:00.000Z');
const MINUTE = 60 * 1000;
const BODY_MARKER = 'QUAY-BODY-MARKER-DO-NOT-LEAK';

/** The one argv a load may run: every task, no body. */
const INDEX_ARGS = ['task', 'list', '--json', '--no-body'];

/**
 * One row of `quay task list --json --no-body`, as the CLI prints it: `updatedAt`
 * is the epoch-millisecond reading the store writes (`1786439928515.85`), NOT an
 * ISO string — the service is what converts it, and the fixture must not do that
 * conversion for it.
 */
type TaskRecord = { id: string; title: string; status: string; updatedAt: number | null };

type World = {
  now: number;
  bootId: string;
  projects: { id: string; title: string }[];
  /** Projects carrying a `.quay/config.yml`. */
  configured: Set<string>;
  /** Each project's whole task list, exactly as `task list --json --no-body` prints it. */
  taskList: Map<string, TaskRecord[]>;
  /** Projects whose next index load never settles (the "loader wedged" world). */
  indexPending: Set<string>;
  /** Every argv the loader was asked to run, in order. */
  commands: { cwd: string; args: string[] }[];
};

type Counters = {
  indexLoads: number;
  indexLoadsByProject: Map<string, number>;
  /** Any command that is NOT the index read — a whole-snapshot CLI run would land here. */
  otherCommands: string[][];
  synchronizeSessions: number;
  refreshQuay: number;
  fetchHistory: number;
};

function zeroCounters(): Counters {
  return {
    indexLoads: 0,
    indexLoadsByProject: new Map(),
    otherCommands: [],
    synchronizeSessions: 0,
    refreshQuay: 0,
    fetchHistory: 0,
  };
}

/** One project's task row, as the index reports it. */
function task(id: string, status: string, updatedAtMs: number | null, title = `Task ${id}`): TaskRecord {
  return { id, title, status, updatedAt: updatedAtMs };
}

/**
 * Thirty tasks, newest first, so `QX-15` is the FIFTEENTH by recency — outside
 * the ten the panel's `recent` list keeps, and therefore invisible to any
 * reading that still goes through `snapshot.tasks.recent`.
 */
function thirtyTasks(): TaskRecord[] {
  return Array.from({ length: 30 }, (_, index) =>
    task(`QX-${String(index + 1).padStart(2, '0')}`, 'todo', FIXED_NOW - (index + 1) * MINUTE),
  );
}

function makeWorld(): World {
  return {
    now: FIXED_NOW,
    bootId: 'boot-1',
    projects: [{ id: 'proj-1', title: 'Alpha' }],
    configured: new Set(['proj-1']),
    taskList: new Map([['proj-1', thirtyTasks()]]),
    indexPending: new Set(),
    commands: [],
  };
}

function isIndexCommand(args: readonly string[]): boolean {
  return args.length === INDEX_ARGS.length && INDEX_ARGS.every((value, index) => value === args[index]);
}

/**
 * The production composition, in small: the real quay service (owning the index,
 * the loader, the per-project in-flight guard and the rate limit) bound to the
 * real `changes` deps through the SAME three members `server/index.ts` binds.
 * The only things injected are the world's own adapters, so every reading below
 * is a reading of shipped behaviour.
 */
function makeDeps(world: World, counters: Counters): McpChangesDeps & {
  synchronizeSessions: () => void;
  refreshQuay: () => void;
  fetchHistory: () => string;
} {
  const service = createQuayService({
    fileExists: (filePath: string) => {
      const match = /^(.*)\/\.quay\/config\.yml$/.exec(filePath);
      return match !== null && world.configured.has(match[1].slice('/repos/'.length));
    },
    resolveProjectPathById: (projectId: string) =>
      world.projects.some((project) => project.id === projectId) ? `/repos/${projectId}` : null,
    runCommand: (cwd: string, args: readonly string[]) => {
      world.commands.push({ cwd, args: [...args] });
      const projectId = cwd.slice('/repos/'.length);
      if (!isIndexCommand(args)) {
        counters.otherCommands.push([...args]);
        return Promise.resolve({ ok: true, code: 0, stdout: '[]', stderr: '' });
      }
      counters.indexLoads += 1;
      counters.indexLoadsByProject.set(projectId, (counters.indexLoadsByProject.get(projectId) ?? 0) + 1);
      if (world.indexPending.has(projectId)) {
        // The loader that never settles: the reading must not wait on it.
        return new Promise(() => {});
      }
      // A real task row carries its document; the index command drops it, and the
      // index must never surface it either. The marker proves the reading stays
      // body-free even if a loader were to leak one.
      const rows = (world.taskList.get(projectId) ?? []).map((row) => ({ ...row, body: BODY_MARKER }));
      return Promise.resolve({ ok: true, code: 0, stdout: JSON.stringify(rows), stderr: '' });
    },
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => '',
    },
    probeWebService: async () => false,
    now: () => world.now,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 5_000,
  });

  return {
    sessions: {
      listChangedSince: () => ({ rows: [], hasMore: false }),
      projectForSession: () => null,
    },
    runs: { listRecentRuns: () => [] },
    approvals: { listPending: () => [] },
    quay: {
      hasQuayConfig: (projectId: string) => service.getQuayStatus(projectId)?.hasQuayConfig ?? false,
      readTaskIndex: (projectId: string) => service.readTaskIndex(projectId),
      requestTaskIndexLoad: (projectId: string) => service.requestTaskIndexLoad(projectId),
    },
    projects: { list: () => world.projects.map((project) => ({ ...project })) },
    now: () => world.now,
    bootId: () => world.bootId,
    // The heavy sources a naive implementation could reach for. Not members of
    // `McpChangesDeps`; their presence is what makes "never called" a reading.
    synchronizeSessions: () => {
      counters.synchronizeSessions += 1;
    },
    refreshQuay: () => {
      counters.refreshQuay += 1;
    },
    fetchHistory: () => {
      counters.fetchHistory += 1;
      return BODY_MARKER;
    },
  };
}

/**
 * Lets the fire-and-forget loader settle. The load is a chain of promise
 * continuations with no timer in it, so a handful of macrotask turns is enough
 * for the index to be swapped in — and `world.now` is a fixed number, so this
 * never races a clock.
 */
async function settleLoads(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function quaySource(payload: McpChangesPayload, projectId: string) {
  return payload.sources.find((source) => source.project === projectId);
}

function quayEvents(payload: McpChangesPayload): McpChangesEvent[] {
  return payload.events.filter((event) => event.kind === 'quay_task');
}

/** The dedup key the contract names: `(kind, ref, at)`. */
function eventKey(event: McpChangesEvent): string {
  return `${event.kind}|${JSON.stringify(event.ref)}|${event.at.iso}`;
}

/**
 * Primes a world's index and returns the cursor of its FIRST full reading: the
 * one that establishes the baseline. The first call reports a cold index and
 * asks for a load; the load is then settled and the second call reads it.
 */
async function bootstrap(world: World, deps: McpChangesDeps): Promise<{ cursor: string; payload: McpChangesPayload }> {
  await buildChanges(readChangesInput({ projects: [...world.configured] }), undefined, deps);
  await settleLoads();
  const payload = await buildChanges(readChangesInput({ projects: [...world.configured] }), undefined, deps);
  return { cursor: payload.cursor, payload };
}

// --------------------------- (a) full coverage ---------------------------

test('(a) a transition on the fifteenth-ranked task is seen, and the source is a full-coverage index', async () => {
  const world = makeWorld();
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  const { cursor, payload: baseline } = await bootstrap(world, deps);
  const baselineSource = quaySource(baseline, 'proj-1');
  assert.ok(baselineSource, 'a configured project must appear in `sources`');
  assert.equal(baselineSource.coverage, 'full', 'the index covers every task, not a page of ten');
  assert.equal(baselineSource.taskCount, 30, 'the source reports the real task count');
  assert.deepEqual(quayEvents(baseline), [], 'the baseline reading invents no event');

  // The fifteeenth by recency changes status. Its `updatedAt` is deliberately left
  // alone: a store that bumped it would push the task into the top ten and make a
  // `recent`-based reader look correct, which is exactly what must not pass.
  const ranked = world.taskList.get('proj-1') ?? [];
  const fifteenth = ranked[14];
  assert.equal(fifteenth.id, 'QX-15', 'the fixture must rank QX-15 fifteenth');
  assert.ok(
    ranked.filter((row) => (row.updatedAt ?? 0) > (fifteenth.updatedAt ?? 0)).length >= 10,
    'QX-15 must be outside the newest ten — that is what makes this reading discriminate',
  );
  world.taskList.set(
    'proj-1',
    ranked.map((row) => (row.id === 'QX-15' ? { ...row, status: 'ready' } : row)),
  );

  // Past the per-project minimum interval, so the reload is a legal one.
  world.now = FIXED_NOW + QUAY_TASK_INDEX_MIN_INTERVAL_MS + 1000;
  await buildChanges(readChangesInput({ cursor, projects: ['proj-1'] }), undefined, deps);
  await settleLoads();
  const next = await buildChanges(readChangesInput({ cursor, projects: ['proj-1'] }), undefined, deps);

  const events = quayEvents(next);
  assert.equal(events.length, 1, 'exactly the one task that moved — a `recent` reading would have seen none');
  assert.equal(events[0].ref.taskId, 'QX-15');
  assert.equal(events[0].summary.includes(BODY_MARKER), false, 'a task body must never reach the stream');

  const source = quaySource(next, 'proj-1');
  assert.equal(source?.coverage, 'full');
  assert.equal(source?.taskCount, 30);
  assert.equal(source?.state, 'ready', 'a freshly loaded index is ready');

  // The whole-snapshot CLI is never the way the index is built: the one argv the
  // loader ran is the body-free index read, and nothing else was spawned.
  assert.deepEqual(counters.otherCommands, [], 'changes must never run a whole-snapshot Quay CLI');
  assert.ok(counters.indexLoads > 0, 'the index is loaded by the index command');
  for (const command of world.commands) {
    assert.deepEqual(command.args, INDEX_ARGS, 'the only command the index loader may run');
  }

  // Field for field against the advertisement. `.strict()` matters: a `sources`
  // field the schema forgot to advertise would be silently stripped instead of
  // refused, and the contract is what a warm client validates against.
  z.object(MCP_CHANGES_OUTPUT_SCHEMA).strict().parse(next);
});

// --------------------------- (b) bootstrap ---------------------------

test('(b) a first reading bootstraps without events; only later tasks appear', async () => {
  const world = makeWorld();
  world.projects = [{ id: 'proj-b', title: 'Bravo' }];
  world.configured = new Set(['proj-b']);
  world.taskList = new Map([
    [
      'proj-b',
      [task('QB-1', 'todo', FIXED_NOW - 3 * MINUTE),
       task('QB-2', 'done', FIXED_NOW - 2 * MINUTE),
       task('QB-3', 'ready', FIXED_NOW - MINUTE)],
    ],
  ]);
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  const { cursor, payload: boot } = await bootstrap(world, deps);
  assert.deepEqual(quayEvents(boot), [], 'the first full reading of a project emits no event');
  const bootSource = quaySource(boot, 'proj-b');
  assert.equal(bootSource?.state, 'bootstrap', 'the project is marked as building its baseline');
  assert.equal(bootSource?.taskCount, 3);
  assert.equal(boot.complete, false, 'nothing may be declared complete while a baseline is being built');

  // The baseline really is in the cursor: the next cursor carries all three
  // tasks, so the follow-up diff has something to compare against.
  const head = decodeChangesCursor(cursor).perProjectHead['proj-b'];
  assert.deepEqual(Object.keys(head.tasks).sort(), ['QB-1', 'QB-2', 'QB-3']);

  // A task that appears AFTER the baseline: one `appeared` event, not four.
  world.taskList.get('proj-b')?.push(task('QB-4', 'todo', FIXED_NOW + MINUTE));
  world.now = FIXED_NOW + QUAY_TASK_INDEX_MIN_INTERVAL_MS + 1000;
  await buildChanges(readChangesInput({ cursor, projects: ['proj-b'] }), undefined, deps);
  await settleLoads();
  const next = await buildChanges(readChangesInput({ cursor, projects: ['proj-b'] }), undefined, deps);

  const events = quayEvents(next);
  assert.equal(events.length, 1, 'one new task is one event — never "everything is new"');
  assert.equal(events[0].ref.taskId, 'QB-4');
  assert.deepEqual(events[0].transition, { from: null, to: 'todo' }, 'an appearance has no prior status');
  assert.equal(events[0].atSource, 'record.updatedAt');
  assert.match(events[0].summary, /QB-4/);
  assert.equal(quaySource(next, 'proj-b')?.state, 'ready', 'the baseline now exists, so the project is ready');
  assert.equal(next.complete, true, 'a bootstrapped, freshly-loaded reading hides nothing');
});

// --------------------------- (c) four instants ---------------------------

test('(c) the four instants are separated, and a re-read transition keeps its `at`', async () => {
  const world = makeWorld();
  world.projects = [{ id: 'proj-c', title: 'Charlie' }];
  world.configured = new Set(['proj-c']);
  const recordAt = FIXED_NOW - 7 * MINUTE;
  world.taskList = new Map([['proj-c', [task('QC-1', 'todo', recordAt)]]]);
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  const { cursor } = await bootstrap(world, deps);

  // The status moves; the record's own `updatedAt` does not. The index is
  // re-read one minute later, so the observation instant is its own thing.
  const observedAt = FIXED_NOW + QUAY_TASK_INDEX_MIN_INTERVAL_MS + 1000;
  world.taskList.set('proj-c', [task('QC-1', 'ready', recordAt)]);
  world.now = observedAt;
  await buildChanges(readChangesInput({ cursor, projects: ['proj-c'] }), undefined, deps);
  await settleLoads();

  const read = async (): Promise<McpChangesEvent> => {
    const payload = await buildChanges(readChangesInput({ cursor, projects: ['proj-c'] }), undefined, deps);
    const events = quayEvents(payload);
    assert.equal(events.length, 1, 'the same cursor re-reads the same one transition');
    return events[0];
  };

  const first = await read();
  assert.deepEqual(first.transition, { from: 'todo', to: 'ready' }, 'the transition names both sides');
  assert.equal(first.at.iso, new Date(recordAt).toISOString(), '`at` is the RECORD’s instant, not the observation instant');
  assert.equal(first.atSource, 'record.updatedAt', 'and the reading says so');
  assert.equal(first.source.type, 'quay.index', 'the event names the index as its fact source');
  assert.equal(
    first.source.observedAt.iso,
    new Date(observedAt).toISOString(),
    '`source.observedAt` is when the INDEX was loaded',
  );
  assert.equal(first.source.ageMs, observedAt - recordAt, '`ageMs` is the difference of the two');
  assert.notEqual(first.at.iso, first.source.observedAt.iso, 'the two instants must be distinguishable');

  // Two more reads, one of them after the clock has moved a long way on: the
  // observation instant moves, the record instant does not, so the caller's
  // `(kind, ref, at)` dedup still collapses the repeat.
  const second = await read();
  world.now = observedAt + 3 * QUAY_TASK_INDEX_MIN_INTERVAL_MS;
  const third = await read();

  assert.equal(second.at.iso, new Date(recordAt).toISOString());
  assert.equal(third.at.iso, new Date(recordAt).toISOString(), 'a stored instant does not drift with the clock');
  assert.deepEqual(
    new Set([first, second, third].map(eventKey)).size,
    1,
    'the three reads are one event under `(kind, ref, at)`',
  );
});

// --------------------------- (d) non-blocking ---------------------------

/** The one-project world the two halves of leg (d) share. */
function deltaWorld(): World {
  const world = makeWorld();
  world.projects = [{ id: 'proj-d', title: 'Delta' }];
  world.configured = new Set(['proj-d']);
  world.taskList = new Map([['proj-d', [task('QD-1', 'todo', FIXED_NOW - MINUTE)]]]);
  return world;
}

test('(d) changes never awaits a loader that never settles', async () => {
  const world = deltaWorld();
  // The loader never settles: every reading below happens while it is in flight.
  world.indexPending = new Set(['proj-d']);
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  const started = performance.now();
  const cold = await buildChanges(readChangesInput({}), undefined, deps);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 50, `changes must not wait on the loader, took ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(quayEvents(cold), [], 'a cold index invents no event');
  assert.equal(cold.complete, false, 'an index that has not been read cannot be complete');

  const source = quaySource(cold, 'proj-d');
  assert.ok(source, 'a configured project with no index is still reported');
  assert.ok(
    source.state === 'cold' || source.state === 'warming',
    `a never-loaded index reads cold or warming, got ${source.state}`,
  );
  assert.equal(source.coverage, 'full');
  assert.equal(source.taskCount, 0, 'nothing has been read yet');
  assert.equal(source.observedAt, null, 'there is no observation instant to report yet');

  const gaps = cold.gaps.filter((gap) => gap.kind === 'quay_task');
  assert.equal(gaps.length, 1, 'the unread index is declared, once, for the one configured project');
  assert.ok(
    gaps[0].state === 'cold' || gaps[0].state === 'warming',
    `the gap must carry a machine-readable state, got ${JSON.stringify(gaps[0].state)}`,
  );
  assert.match(gaps[0].reason, /cold|warming/i, 'and a reason a person can read');

  // A second reading while the loader is STILL in flight is just as prompt, and
  // is deduped rather than queued behind the first.
  const startedAgain = performance.now();
  const again = await buildChanges(readChangesInput({}), undefined, deps);
  assert.ok(performance.now() - startedAgain < 50, 'the second reading must not wait either');
  assert.equal(quaySource(again, 'proj-d')?.state, 'warming', 'the in-flight load is legible as warming');
  assert.equal(counters.indexLoadsByProject.get('proj-d'), 1, 'a project has at most one load in flight');

  assert.equal(counters.synchronizeSessions, 0, 'changes must never run a full session synchronisation');
  assert.equal(counters.refreshQuay, 0, 'changes must never refresh (spawn) the whole Quay snapshot');
  assert.equal(counters.fetchHistory, 0, 'changes must never read session message bodies');
  assert.deepEqual(counters.otherCommands, [], 'and must never run any other Quay command');
});

test('(d) one index load per project per minute, however often it is asked', async () => {
  const world = deltaWorld();
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  // Twenty calls inside one minute — concurrent first, then repeated once the
  // load has settled, so neither the in-flight guard nor the interval alone can
  // account for the answer.
  await Promise.all(Array.from({ length: 20 }, () => buildChanges(readChangesInput({}), undefined, deps)));
  await settleLoads();
  for (let repeat = 0; repeat < 20; repeat += 1) {
    await buildChanges(readChangesInput({}), undefined, deps);
  }
  await settleLoads();

  assert.equal(
    counters.indexLoadsByProject.get('proj-d'),
    1,
    'a project must not load its index twice inside the minimum interval',
  );
  assert.equal(counters.indexLoads, 1, 'and nothing else loaded either');

  // The negative control for the counter itself: it is wired, and past the
  // interval a load is legal again.
  world.now = FIXED_NOW + QUAY_TASK_INDEX_MIN_INTERVAL_MS + 1;
  await buildChanges(readChangesInput({}), undefined, deps);
  await settleLoads();
  assert.equal(counters.indexLoadsByProject.get('proj-d'), 2, 'past the interval, a load is legal again');
  assert.deepEqual(counters.otherCommands, [], 'and still never a whole-snapshot Quay CLI');
});

// --------------------------- (e) stale ---------------------------

test('(e) a stale index keeps its data and still diffs, and is reported as stale', async () => {
  const world = makeWorld();
  world.projects = [{ id: 'proj-e', title: 'Echo' }];
  world.configured = new Set(['proj-e']);
  const recordAt = FIXED_NOW - 10 * MINUTE;
  world.taskList = new Map([['proj-e', [task('QE-1', 'todo', recordAt)]]]);
  const counters = zeroCounters();
  const deps = makeDeps(world, counters);

  // The baseline sees `todo`.
  const { cursor } = await bootstrap(world, deps);

  // The task settles and the index is re-read one minute later, so the server's
  // copy says `ready` while the baseline cursor still says `todo`.
  const loadedAt = FIXED_NOW + QUAY_TASK_INDEX_MIN_INTERVAL_MS + 1000;
  world.taskList.set('proj-e', [task('QE-1', 'ready', recordAt)]);
  world.now = loadedAt;
  await buildChanges(readChangesInput({ cursor, projects: ['proj-e'] }), undefined, deps);
  await settleLoads();

  // Now nothing is ever read again: the loader is wedged and the clock runs past
  // the freshness window. The service's copy IS the stale index.
  world.indexPending = new Set(['proj-e']);
  const staleAt = loadedAt + QUAY_TASK_INDEX_TTL_MS + 1;
  world.now = staleAt;

  const stale = await buildChanges(readChangesInput({ cursor, projects: ['proj-e'] }), undefined, deps);
  const source = quaySource(stale, 'proj-e');
  assert.equal(source?.state, 'stale', 'an index past its freshness window is stale, not absent');
  assert.equal(source?.observedAt?.iso, new Date(loadedAt).toISOString(), 'the reading says how old the data is');
  assert.equal(source?.ageMs, staleAt - loadedAt);
  assert.equal(source?.taskCount, 1, 'the retained rows are still reported');
  assert.equal(stale.complete, false, 'a stale reading hides whatever moved since the load');

  const events = quayEvents(stale);
  assert.equal(events.length, 1, 'a stale index STILL diffs — the change since the baseline is not dropped');
  assert.equal(events[0].ref.taskId, 'QE-1');
  assert.equal(stale.gaps.some((gap) => gap.kind === 'quay_task'), false, 'stale is reported in `sources`, not as a gap');

  // Negative control: the SAME index inside its window is ready and complete, so
  // `stale` above is the freshness test and not a constant of every reading.
  world.now = loadedAt;
  const fresh = await buildChanges(readChangesInput({ cursor, projects: ['proj-e'] }), undefined, deps);
  assert.equal(quaySource(fresh, 'proj-e')?.state, 'ready');
  assert.equal(fresh.complete, true);
});

// --------------------------- (f) restart / cleared index ---------------------------

test('(f) an empty server index never invents events, and the baseline survives', async () => {
  const world = makeWorld();
  world.projects = [{ id: 'proj-f', title: 'Foxtrot' }];
  world.configured = new Set(['proj-f']);
  world.taskList = new Map([
    [
      'proj-f',
      [task('QF-1', 'todo', FIXED_NOW - 3 * MINUTE),
       task('QF-2', 'done', FIXED_NOW - 2 * MINUTE),
       task('QF-3', 'todo', FIXED_NOW - MINUTE)],
    ],
  ]);
  const counters = zeroCounters();
  const first = makeDeps(world, counters);
  const { cursor } = await bootstrap(world, first);

  // A restart: the process that held the index is gone (a fresh service), and the
  // cursor was issued by the previous boot. The task settles while the index is
  // still empty — the load the next reading starts captures THIS list.
  world.taskList.set(
    'proj-f',
    (world.taskList.get('proj-f') ?? []).map((row) => (row.id === 'QF-2' ? { ...row, status: 'ready' } : row)),
  );
  world.bootId = 'boot-2';
  const second = makeDeps(world, counters);
  world.now = FIXED_NOW + QUAY_TASK_INDEX_MIN_INTERVAL_MS + 1000;

  const empty = await buildChanges(readChangesInput({ cursor, projects: ['proj-f'] }), undefined, second);
  assert.deepEqual(quayEvents(empty), [], 'an empty index must not read as "every task is new"');
  const emptySource = quaySource(empty, 'proj-f');
  assert.ok(
    emptySource?.state === 'cold' || emptySource?.state === 'warming',
    `an empty server index reads cold or warming, got ${emptySource?.state}`,
  );
  assert.equal(emptySource?.taskCount, 0);
  const gaps = empty.gaps.filter((gap) => gap.kind === 'quay_task');
  assert.equal(gaps.length, 1, 'the unreadable index is declared');
  assert.equal(empty.complete, false);

  // The baseline rode through untouched — the cursor still remembers all three.
  const carried = decodeChangesCursor(empty.cursor).perProjectHead['proj-f'];
  assert.deepEqual(Object.keys(carried.tasks).sort(), ['QF-1', 'QF-2', 'QF-3']);

  // The load lands with one real change (the QF-2 the world already settled). The
  // diff is against the CURSOR's baseline, so the answer is one transition — not
  // three appearances.
  await settleLoads();
  const after = await buildChanges(readChangesInput({ cursor: empty.cursor, projects: ['proj-f'] }), undefined, second);
  const events = quayEvents(after);
  assert.equal(events.length, 1, 'one real change is one event');
  assert.equal(events[0].ref.taskId, 'QF-2');
  assert.deepEqual(events[0].transition, { from: 'done', to: 'ready' });
  assert.equal(quaySource(after, 'proj-f')?.taskCount, 3);
});

// --------------------------- the source vocabulary ---------------------------

test('(g) the source-state vocabulary is exactly the six the contract names', () => {
  assert.deepEqual(
    [...MCP_CHANGES_SOURCE_STATES],
    ['ready', 'stale', 'cold', 'warming', 'bootstrap', 'error'],
    'a seventh state would be a silent widening of the wire contract',
  );
  const shell = z.object(MCP_CHANGES_OUTPUT_SCHEMA).strict().safeParse({
    cursor: 'x',
    generatedAt: { relative: 'just now', iso: new Date(FIXED_NOW).toISOString() },
    bootId: 'boot-1',
    complete: false,
    events: [],
    gaps: [],
    sources: [
      {
        kind: 'quay_task',
        project: 'proj-1',
        state: 'bootstrap',
        coverage: 'full',
        taskCount: 0,
        observedAt: null,
        ageMs: null,
      },
    ],
  });
  assert.equal(shell.success, true, 'the advertised output schema must carry the new `sources` field');
});
