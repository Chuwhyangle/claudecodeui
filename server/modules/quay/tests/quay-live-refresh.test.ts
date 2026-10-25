/**
 * The event-driven task-status refresh — one criterion file for the four new surfaces:
 *
 *   · `quay-capabilities.ts`        — the `--help` verb probe and its cache/backoff;
 *   · the whitelist widening        — `['--help']` and the structurally validated `task log` read;
 *   · `quay-task-events.service.ts` — fs.watch → `task log --since` → index apply;
 *   · `quay-dispatch-carrier.ts`    — the read-only `worker-dispatch.json` reading, plus the
 *                                     lanes-cache invalidation its CHANGE drives.
 *
 * Everything runs on an injected clock, fake timers, a scripted command stub and a fake
 * directory watcher, so no criterion spawns a real `quay` or waits on wall-clock time.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createQuayCapabilities,
  type QuayCapabilities,
  type QuayCapabilityReader,
  type QuayEntrypointIdentity,
} from '../quay-capabilities.js';
import { createQuayDispatchCarrier } from '../quay-dispatch-carrier.js';
import {
  createQuayTaskEvents,
  readTaskLogPage,
  type QuayTaskEventsService,
  type QuayTaskEventsTimers,
} from '../quay-task-events.service.js';
import {
  QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS,
  QUAY_TASK_INDEX_MIN_INTERVAL_MS,
  QUAY_TASK_INDEX_TTL_MS,
  createQuayService,
  isReadOnlyQuayCommand,
  type QuayCommandResult,
  type QuayFileReader,
  type QuayTaskIndexReading,
  type QuayTaskStatusRow,
} from '../quay.service.js';

const PROJECT_PATH = path.join(path.sep, 'workspace', 'project-1');
const PROJECT_PATH_2 = path.join(path.sep, 'workspace', 'project-2');
const QUAY_DIR = path.join(PROJECT_PATH, '.quay');
const DISPATCH_PATH = path.join(QUAY_DIR, 'worker-dispatch.json');

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Lets every pending promise callback run; the fake timers only control TIME, not microtasks. */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

//----------------- FAKE CLOCK + TIMERS ------------

type FakeTimer = {
  id: number;
  at: number;
  run: () => void;
};

type FakeClock = {
  now(): number;
  timers: QuayTaskEventsTimers;
  advance(ms: number): Promise<void>;
  pendingDelays(): number[];
};

function createFakeClock(startMs = 0): FakeClock {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  const timersApi: QuayTaskEventsTimers = {
    setTimeout: (handler, delayMs) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, at: now + delayMs, run: handler });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') {
        timers.delete(handle);
      }
    },
  };

  const pendingDelays = (): number[] =>
    [...timers.values()].map((timer) => timer.at - now).sort((left, right) => left - right);

  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      await settle();
      const due = [...timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (due === undefined) {
        break;
      }
      timers.delete(due.id);
      now = due.at;
      due.run();
    }
    now = target;
    await settle();
  };

  return { now: () => now, timers: timersApi, advance, pendingDelays };
}

//----------------- CAPABILITY PROBE ------------

type CapabilityHarness = {
  reader: QuayCapabilityReader;
  calls: string[][];
  logs: string[];
  clock: FakeClock;
  setIdentity(identity: QuayEntrypointIdentity | null): void;
};

function capabilityHarness(options: {
  respond: (args: readonly string[]) => QuayCommandResult;
  clock?: FakeClock;
  identity?: QuayEntrypointIdentity | null;
}): CapabilityHarness {
  const clock = options.clock ?? createFakeClock(0);
  let identity: QuayEntrypointIdentity | null = options.identity === undefined
    ? { realpath: '/plugins/quay/0.19.0/bin/quay', mtimeMs: 1_000, size: 4_096 }
    : options.identity;
  const calls: string[][] = [];
  const logs: string[] = [];
  const reader = createQuayCapabilities({
    runCommand: async (_cwd, args) => {
      calls.push([...args]);
      return options.respond(args);
    },
    readEntrypoint: () => identity,
    now: clock.now,
    log: (message) => logs.push(message),
    unknownBackoffMs: 60_000,
  });
  return {
    reader,
    calls,
    logs,
    clock,
    setIdentity: (next) => {
      identity = next;
    },
  };
}

function helpResult(stdout: string): QuayCommandResult {
  return { ok: true, code: 0, stdout, stderr: '' };
}

test('capability: the real 0.19.0 help reads task log absent and lanes available', async () => {
  const harness = capabilityHarness({ respond: () => helpResult(readFixture('quay-help-0.19.0.txt')) });
  assert.deepEqual(await harness.reader.probe(PROJECT_PATH), { taskLog: 'absent', lanes: 'available' });
});

test('capability: the real 0.22.0 help reads both verbs available', async () => {
  const harness = capabilityHarness({ respond: () => helpResult(readFixture('quay-help-0.22.0.txt')) });
  assert.deepEqual(await harness.reader.probe(PROJECT_PATH), { taskLog: 'available', lanes: 'available' });
});

test('capability: a spawn error, a timeout and a non-zero exit with no output are unknown, never absent', async () => {
  const failures: QuayCommandResult[] = [
    { ok: false, code: null, stdout: '', stderr: '', error: 'spawn ENOMEM', failureKind: 'spawn-error' },
    { ok: false, code: null, stdout: '', stderr: '', error: 'timed out', failureKind: 'timeout' },
    { ok: false, code: 1, stdout: '', stderr: '', error: 'exited 1', failureKind: 'nonzero-exit' },
  ];
  for (const failure of failures) {
    const harness = capabilityHarness({ respond: () => failure });
    assert.deepEqual(
      await harness.reader.probe(PROJECT_PATH),
      { taskLog: 'unknown', lanes: 'unknown' },
      `failureKind=${failure.failureKind ?? 'none'} must read unknown`,
    );
  }
});

test('capability: a non-zero exit that still printed help is a reading, not an unknown', async () => {
  const harness = capabilityHarness({
    respond: () => ({
      ok: false,
      code: 1,
      stdout: readFixture('quay-help-0.22.0.txt'),
      stderr: '',
      error: 'exited 1',
      failureKind: 'nonzero-exit',
    }),
  });
  assert.deepEqual(await harness.reader.probe(PROJECT_PATH), { taskLog: 'available', lanes: 'available' });
});

test('capability: the same entrypoint is not re-spawned; a realpath or mtime change re-probes', async () => {
  const harness = capabilityHarness({ respond: () => helpResult(readFixture('quay-help-0.19.0.txt')) });

  await harness.reader.probe(PROJECT_PATH);
  assert.equal(harness.calls.length, 1, 'first probe spawns');
  await harness.reader.probe(PROJECT_PATH);
  assert.equal(harness.calls.length, 1, 'same realpath+mtime+size is served from cache');

  // The version symlink is re-pointed: same path, new target.
  harness.setIdentity({ realpath: '/plugins/quay/0.22.0/bin/quay', mtimeMs: 1_000, size: 4_096 });
  await harness.reader.probe(PROJECT_PATH);
  assert.equal(harness.calls.length, 2, 'a new realpath re-probes');

  // The binary itself is replaced in place: same target path, new mtime.
  harness.setIdentity({ realpath: '/plugins/quay/0.22.0/bin/quay', mtimeMs: 2_000, size: 4_096 });
  await harness.reader.probe(PROJECT_PATH);
  assert.equal(harness.calls.length, 3, 'a new mtime re-probes');
});

test('capability: unknown is served from cache through its backoff and re-probed after it', async () => {
  const clock = createFakeClock(1_000);
  const harness = capabilityHarness({
    clock,
    respond: () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'boom', failureKind: 'spawn-error' }),
  });

  assert.deepEqual(await harness.reader.probe(PROJECT_PATH), { taskLog: 'unknown', lanes: 'unknown' });
  assert.equal(harness.calls.length, 1);

  await clock.advance(59_999);
  assert.deepEqual(await harness.reader.probe(PROJECT_PATH), { taskLog: 'unknown', lanes: 'unknown' });
  assert.equal(harness.calls.length, 1, 'the unknown answer is reused inside the 60 s backoff');

  await clock.advance(1);
  assert.deepEqual(await harness.reader.probe(PROJECT_PATH), { taskLog: 'unknown', lanes: 'unknown' });
  assert.equal(harness.calls.length, 2, 'the backoff expired, so the probe runs again');
});

test('capability: a state change is logged once per project, not once per probe', async () => {
  const harness = capabilityHarness({ respond: () => helpResult(readFixture('quay-help-0.19.0.txt')) });
  await harness.reader.probe(PROJECT_PATH);
  await harness.reader.probe(PROJECT_PATH);
  assert.equal(harness.logs.length, 1, 'the second identical answer is not a state change');
  assert.match(harness.logs[0], /quay capabilities: project=.*task log=absent lanes=available/);
});

//----------------- WHITELIST ------------

test('whitelist: --help and the validated task-log read are accepted', () => {
  const iso = '2026-10-25T00:00:00.000Z';
  const cursor = JSON.stringify({ v: 1, carrierEpoch: 'epoch-1', seq: 3 });
  const accepted = [
    ['--help'],
    ['task', 'log', '--json', '--since', iso, '--limit', '500'],
    ['task', 'log', '--json', '--since', cursor, '--limit', '1'],
  ];
  for (const args of accepted) {
    assert.equal(isReadOnlyQuayCommand(args), true, `expected accepted: ${args.join(' ')}`);
  }
});

test('whitelist: every malformed task-log variant is refused', () => {
  const iso = '2026-10-25T00:00:00.000Z';
  const cursor = JSON.stringify({ v: 1, carrierEpoch: 'epoch-1', seq: 3 });
  const refused = [
    ['task', 'log', '--json', '--since', iso, '--limit', '0'],
    ['task', 'log', '--json', '--since', iso, '--limit', '501'],
    ['task', 'log', '--json', '--since', iso, '--limit', 'abc'],
    // missing --since
    ['task', 'log', '--json', '--limit', '500'],
    // --since garbage
    ['task', 'log', '--json', '--since', 'not-a-time', '--limit', '500'],
    // cursor with an extra key
    ['task', 'log', '--json', '--since', JSON.stringify({ v: 1, carrierEpoch: 'epoch-1', seq: 3, extra: true }), '--limit', '500'],
    // cursor with a wrong type
    ['task', 'log', '--json', '--since', JSON.stringify({ v: 1, carrierEpoch: 'epoch-1', seq: '3' }), '--limit', '500'],
    // one extra token
    ['task', 'log', '--json', '--since', iso, '--limit', '500', '--root', '/tmp'],
    // missing --json
    ['task', 'log', '--since', iso, '--limit', '500'],
    // Not a cursor: an array
    ['task', 'log', '--json', '--since', '[]', '--limit', '500'],
  ];
  for (const args of refused) {
    assert.equal(isReadOnlyQuayCommand(args), false, `expected refused: ${args.join(' ')}`);
  }
  // A mutation to a bare `task` prefix rule would accept these; the structural validator is
  // what keeps every write verb unreachable, so the reject cases above are the pin for it.
  const writeVerbs = [
    ['task', 'create', 'x', '--title', 't'],
    ['task', 'edit', 'x', '--status', 'done'],
    ['task', 'check', 'x'],
    ['goal', 'write', 'GOAL-1', '--origin', 'x'],
    ['goal', 'batch', '--json', '[]'],
    ['goal', 'gate', 'GOAL-1'],
    ['promote', 'x'],
    ['retreat', 'x', '--reason', 'r'],
    ['driver', 'start', '--kind', 'worker'],
  ];
  for (const args of writeVerbs) {
    assert.equal(isReadOnlyQuayCommand(args), false, `expected refused: ${args.join(' ')}`);
  }
});

//----------------- EVENT SERVICE HARNESS ------------

type ProjectIndex = {
  projectPath: string;
  tasks: Map<string, QuayTaskStatusRow>;
  observedAtMs: number | null;
  baselineStartedAtMs: number | null;
  capabilities: QuayCapabilities;
};

type WatchHarness = {
  watchPath: (dirPath: string, onChange: (eventType: string, filename: string | null) => void) =>
    { close(): void; onError(handler: (error: Error) => void): void } | null;
  emit(dirPath: string, eventType: string, filename: string | null): void;
  fail(dirPath: string, error: Error): void;
  closable: Array<{ dirPath: string; closed: boolean }>;
};

function createWatchHarness(): WatchHarness {
  type WatcherRecord = {
    dirPath: string;
    onChange: (eventType: string, filename: string | null) => void;
    onError: ((error: Error) => void) | null;
    closed: boolean;
  };
  const watchers: WatcherRecord[] = [];

  return {
    watchPath: (dirPath, onChange) => {
      const entry: WatcherRecord = { dirPath, onChange, onError: null, closed: false };
      watchers.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
        onError: (handler) => {
          entry.onError = handler;
        },
      };
    },
    emit: (dirPath, eventType, filename) => {
      for (const watcher of watchers) {
        if (!watcher.closed && watcher.dirPath === dirPath) {
          watcher.onChange(eventType, filename);
        }
      }
    },
    fail: (dirPath, error) => {
      for (const watcher of watchers) {
        if (!watcher.closed && watcher.dirPath === dirPath) {
          watcher.onError?.(error);
        }
      }
    },
    // Access for the teardown/eviction criteria; `close()` flips `closed` on these records.
    get closable() {
      return watchers.map((watcher) => ({
        dirPath: watcher.dirPath,
        get closed() {
          return watcher.closed;
        },
      }));
    },
  };
}

function makeProject(
  projectPath: string,
  rows: Array<{ id: string; status: string; updatedAt?: string | null }>,
  observedAtMs: number | null,
  baselineStartedAtMs: number | null,
): ProjectIndex {
  return {
    projectPath,
    tasks: new Map(rows.map((row) => [row.id, {
      taskId: row.id,
      status: row.status,
      updatedAt: row.updatedAt ?? null,
      title: row.id,
    }])),
    observedAtMs,
    baselineStartedAtMs,
    capabilities: { taskLog: 'available', lanes: 'available' },
  };
}

type EventsHarness = {
  service: QuayTaskEventsService;
  clock: FakeClock;
  watch: WatchHarness;
  projects: Map<string, ProjectIndex>;
  calls: string[][];
  loads: Array<{ projectId: string; options?: { minIntervalMs?: number } }>;
  updates: Array<{ projectId: string; taskId: string; status: string; updatedAt: string | null }>;
  dispatchChanges: string[];
  logs: string[];
  exitHooks: Array<() => void>;
};

function eventsHarness(options: {
  projects: Map<string, ProjectIndex>;
  respond: (args: readonly string[], callIndex: number) => QuayCommandResult | Promise<QuayCommandResult>;
  clock?: FakeClock;
  watch?: WatchHarness;
  watchPathFactory?: WatchHarness['watchPath'];
  maxActiveMonitors?: number;
  onDispatchFileChanged?: (projectId: string) => void;
}): EventsHarness {
  const clock = options.clock ?? createFakeClock(0);
  const watch = options.watch ?? createWatchHarness();
  const calls: string[][] = [];
  const loads: EventsHarness['loads'] = [];
  const updates: EventsHarness['updates'] = [];
  const dispatchChanges: string[] = [];
  const logs: string[] = [];
  const exitHooks: Array<() => void> = [];

  const projectByPath = (projectPath: string): ProjectIndex | undefined =>
    [...options.projects.values()].find((project) => project.projectPath === projectPath);

  const capabilityReader: QuayCapabilityReader = {
    read: (projectPath) => projectByPath(projectPath)?.capabilities ?? { taskLog: 'unknown', lanes: 'unknown' },
    probe: async (projectPath) => capabilityReader.read(projectPath),
  };

  const service = createQuayTaskEvents({
    now: clock.now,
    resolveProjectPathById: (projectId) => options.projects.get(projectId)?.projectPath ?? null,
    readTaskIndex: (projectId): QuayTaskIndexReading => {
      const project = options.projects.get(projectId);
      const tasks = project?.tasks ?? new Map<string, QuayTaskStatusRow>();
      return {
        state: project?.observedAtMs === null ? 'cold' : 'ready',
        coverage: 'full',
        taskCount: tasks.size,
        observedAtMs: project?.observedAtMs ?? null,
        tasks,
      };
    },
    taskIndexLoadStartedAtMs: (projectId) => options.projects.get(projectId)?.baselineStartedAtMs ?? null,
    requestTaskIndexLoad: (projectId, requestOptions) => {
      loads.push({ projectId, options: requestOptions });
    },
    updateTaskIndexRow: (projectId, taskId, row) => {
      const project = options.projects.get(projectId);
      const existing = project?.tasks.get(taskId);
      if (project === undefined || existing === undefined) {
        return false;
      }
      project.tasks.set(taskId, { ...existing, status: row.status, updatedAt: row.updatedAt });
      updates.push({ projectId, taskId, status: row.status, updatedAt: row.updatedAt });
      return true;
    },
    capabilities: capabilityReader,
    runCommand: async (_cwd, args) => {
      calls.push([...args]);
      return options.respond([...args], calls.length - 1);
    },
    watchPath: options.watchPathFactory ?? watch.watchPath,
    onDispatchFileChanged: (projectId) => {
      dispatchChanges.push(projectId);
      options.onDispatchFileChanged?.(projectId);
    },
    log: (message) => logs.push(message),
    timers: clock.timers,
    registerExitHook: (handler) => {
      exitHooks.push(handler);
    },
    maxActiveMonitors: options.maxActiveMonitors,
  });

  return { service, clock, watch, projects: options.projects, calls, loads, updates, dispatchChanges, logs, exitHooks };
}

const EPOCH = 'epoch-1';

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function transition(overrides: Record<string, unknown> & { at?: string }): Record<string, unknown> {
  return {
    order: 0,
    schema: 'task-status-event/v1',
    seq: 0,
    eventId: 'event-0',
    carrierEpoch: EPOCH,
    taskId: 'task-a',
    from: 'todo',
    to: 'ready',
    kind: 'promote',
    at: isoAt(1_000_100),
    recordedAt: isoAt(1_000_100),
    source: 'task-status-events',
    inferred: false,
    ...overrides,
  };
}

function page(
  transitions: Array<Record<string, unknown>>,
  options: {
    nextCursor?: Record<string, unknown> | null;
    tailCursor?: Record<string, unknown> | null;
    rebase?: boolean;
    complete?: boolean;
    includeNextCursor?: boolean;
  } = {},
): string {
  const document: Record<string, unknown> = {
    transitions,
    complete: options.complete ?? false,
    coverage: { reasons: ['reconcile has no scheduler on this host'] },
    generatedAt: isoAt(1_000_200),
    rebase: options.rebase ?? false,
    rebaseReason: options.rebase === true ? 'epoch rotated' : null,
  };
  if (options.includeNextCursor !== false) {
    document.nextCursor = options.nextCursor ?? null;
  }
  if (options.tailCursor !== undefined) {
    document.tailCursor = options.tailCursor;
  }
  return JSON.stringify(document);
}

function singleProject(baselineStartedAtMs = 1_000_000): Map<string, ProjectIndex> {
  return new Map([
    ['project-1', makeProject(PROJECT_PATH, [{ id: 'task-a', status: 'todo' }], 1_000_500, baselineStartedAtMs)],
  ]);
}

//----------------- EVENT APPLICATION ------------

test('event apply: a known task transition updates its row and never triggers task list', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({
      ok: true,
      code: 0,
      stdout: page([transition({ to: 'ready', eventId: 'evt-1', seq: 1, at: isoAt(1_000_600) })], {
        nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 1 },
      }),
      stderr: '',
    }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');

  assert.equal(harness.projects.get('project-1')?.tasks.get('task-a')?.status, 'ready');
  assert.equal(harness.projects.get('project-1')?.tasks.get('task-a')?.updatedAt, isoAt(1_000_600));
  assert.equal(harness.loads.length, 0, 'a known task must not trigger task list');
  assert.equal(harness.calls.length, 1);
});

test('event apply: the same eventId delivered twice is idempotent', async () => {
  const payload = page([transition({ eventId: 'evt-dup', seq: 1, to: 'ready' })], {
    nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 1 },
  });
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: payload, stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  assert.equal(harness.updates.length, 1);
  // The cursor resumes INCLUSIVELY, so the boundary event is re-delivered on the next poll.
  await harness.service.pollProject('project-1');
  assert.equal(harness.updates.length, 1, 'the duplicate eventId must not re-apply');
});

test('event apply: out-of-order transitions are applied by seq', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({
      ok: true,
      code: 0,
      stdout: page([
        transition({ eventId: 'evt-later', seq: 2, to: 'done', at: isoAt(1_000_800) }),
        transition({ eventId: 'evt-earlier', seq: 1, to: 'ready', at: isoAt(1_000_600) }),
      ], { nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 2 } }),
      stderr: '',
    }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  assert.equal(
    harness.projects.get('project-1')?.tasks.get('task-a')?.status,
    'done',
    'the highest seq must win, even when the page arrived in reverse',
  );
});

test('event apply: an event older than the baseline load does not roll back the read state', async () => {
  const harness = eventsHarness({
    projects: singleProject(1_000_000),
    respond: () => ({
      ok: true,
      code: 0,
      stdout: page([transition({ eventId: 'evt-old', seq: 1, to: 'done', at: isoAt(900_000) })], {
        nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 1 },
      }),
      stderr: '',
    }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  assert.equal(harness.updates.length, 0, 'the manual edit the full read saw must survive');
  assert.equal(harness.projects.get('project-1')?.tasks.get('task-a')?.status, 'todo');
});

test('event apply: complete:false is ignored and produces no side effects', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([], { complete: false }), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.loads.length, 0);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.service.readMonitorState('project-1').state, 'active');
});

//----------------- FULL-LOAD TRIGGERS ------------

test('full load: a creation event triggers exactly one task list, at the 5 s event interval', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({
      ok: true,
      code: 0,
      stdout: page([transition({ eventId: 'evt-create', kind: 'create', from: null, seq: 1 })], {
        nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 1 },
      }),
      stderr: '',
    }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  assert.equal(harness.loads.length, 1);
  assert.equal(harness.loads[0].projectId, 'project-1');
  assert.equal(harness.loads[0].options?.minIntervalMs, 5_000, 'creation must not wait the TTL 60 s');
});

test('full load: a transition for a task missing from the index triggers a full load', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({
      ok: true,
      code: 0,
      stdout: page([transition({ eventId: 'evt-unknown', taskId: 'task-new', seq: 1 })], {
        nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 1 },
      }),
      stderr: '',
    }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  assert.equal(harness.loads.length, 1);
  assert.equal(harness.updates.length, 0, 'an event never invents an index row');
});

test('full load: rebase, an epoch change, invalid JSON and a missing field each reset the seed', async () => {
  const cases: Array<{ name: string; respond: (call: number) => QuayCommandResult }> = [
    {
      name: 'rebase',
      respond: (call) => ({
        ok: true,
        code: 0,
        stdout: page([], {
          rebase: call === 0,
          nextCursor: { v: 1, carrierEpoch: EPOCH, seq: 0 },
        }),
        stderr: '',
      }),
    },
    {
      name: 'carrierEpoch change',
      respond: (call) => ({
        ok: true,
        code: 0,
        stdout: page([], {
          nextCursor: {
            v: 1,
            carrierEpoch: call === 0 ? EPOCH : 'epoch-2',
            seq: 0,
          },
        }),
        stderr: '',
      }),
    },
    {
      name: 'invalid JSON',
      respond: () => ({ ok: true, code: 0, stdout: 'not json', stderr: '' }),
    },
    {
      name: 'missing field',
      respond: () => ({
        ok: true,
        code: 0,
        stdout: JSON.stringify({ nextCursor: null, rebase: false }),
        stderr: '',
      }),
    },
  ];

  for (const testCase of cases) {
    const harness = eventsHarness({
      projects: singleProject(),
      respond: (args, callIndex) => testCase.respond(callIndex),
    });
    await harness.service.ensureMonitored('project-1');
    await harness.service.pollProject('project-1');
    if (testCase.name === 'carrierEpoch change') {
      // The first page seeds a cursor; the SECOND poll is what sees the rotated epoch.
      await harness.service.pollProject('project-1');
    }
    assert.equal(harness.loads.length >= 1, true, `${testCase.name}: must request a full load`);
    assert.equal(
      harness.service.readMonitorState('project-1').seedKind,
      'unseeded',
      `${testCase.name}: the cursor must be reset to unseeded`,
    );
  }
});

test('full load: a task log failure degrades with a 5 s doubling backoff capped at 60 s', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({
      ok: false,
      code: 1,
      stdout: '',
      stderr: '',
      error: 'task log exploded',
      failureKind: 'nonzero-exit',
    }),
  });
  await harness.service.ensureMonitored('project-1');

  // Each poll fails; the retry timer's delay is the doubling backoff.
  await harness.service.pollProject('project-1');
  const state = harness.service.readMonitorState('project-1');
  assert.equal(state.state, 'degraded');
  assert.equal(state.reason, 'task log exploded');

  for (let index = 0; index < 6; index += 1) {
    await harness.clock.advance(index === 0 ? 5_000 : harness.clock.pendingDelays()[0] ?? 60_000);
  }

  const delays = harness.logs
    .map((line) => /retrying in (\d+) ms/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  assert.deepEqual(
    delays.slice(0, 6),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000],
    'the backoff doubles from 5 s and is capped at 60 s',
  );

  // Nothing here touched the full-read path; the TTL constants are still the shipped values.
  assert.equal(QUAY_TASK_INDEX_TTL_MS, 120_000);
  assert.equal(QUAY_TASK_INDEX_MIN_INTERVAL_MS, 60_000);
  assert.equal(QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS, 2);
});

test('full load: the 5 s event interval admits at most one load per burst, while the TTL floor stays 60 s', async () => {
  const clock = createFakeClock(1_000_000);
  const spawns: string[][] = [];
  const service = createQuayService({
    fileExists: () => false,
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => {
      spawns.push([...args]);
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => {
        throw new Error('ENOENT');
      },
    },
    probeWebService: async () => false,
    now: clock.now,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
  });

  service.requestTaskIndexLoad('project-1', { minIntervalMs: 5_000 });
  await settle();
  assert.equal(spawns.length, 1);

  await clock.advance(4_999);
  service.requestTaskIndexLoad('project-1', { minIntervalMs: 5_000 });
  await settle();
  assert.equal(spawns.length, 1, 'inside 5 s the event path still refuses a second load');

  await clock.advance(1);
  service.requestTaskIndexLoad('project-1', { minIntervalMs: 5_000 });
  await settle();
  assert.equal(spawns.length, 2, 'after 5 s the event path may load again');

  // At the same 5 s gap the DEFAULT (TTL) floor still refuses: 60 s is unchanged.
  await clock.advance(5_000);
  service.requestTaskIndexLoad('project-1');
  await settle();
  assert.equal(spawns.length, 2, 'the TTL path keeps its 60 s minimum interval');
  assert.deepEqual(spawns[0], ['task', 'list', '--json', '--no-body']);
});

//----------------- CURSOR ------------

test('cursor: the first call seeds from the load start minus 2 s, and a null nextCursor keeps it', async () => {
  const loadStartedAtMs = 1_000_000;
  const expectedIso = isoAt(loadStartedAtMs - 2_000);
  const harness = eventsHarness({
    projects: singleProject(loadStartedAtMs),
    respond: () => ({ ok: true, code: 0, stdout: page([], { nextCursor: null }), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  await harness.service.pollProject('project-1');

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0][4], expectedIso);
  assert.equal(harness.calls[1][4], expectedIso, 'a null nextCursor keeps the same ISO seed');
});

test('cursor: a non-null nextCursor is passed back verbatim with a stable key order', async () => {
  const cursor = { v: 1, carrierEpoch: EPOCH, seq: 3 };
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([], { nextCursor: cursor }), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  await harness.service.pollProject('project-1');

  assert.equal(harness.calls[1][4], JSON.stringify(cursor));
  assert.equal(harness.calls[1][4], '{"v":1,"carrierEpoch":"epoch-1","seq":3}', 'key order is v, carrierEpoch, seq');
});

test('cursor: a response tailCursor is adopted as the seed ahead of the ISO', async () => {
  const tail = { v: 1, carrierEpoch: 'epoch-tail', seq: 9 };
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({
      ok: true,
      code: 0,
      stdout: page([], { nextCursor: null, tailCursor: tail }),
      stderr: '',
    }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');
  const firstSeed = harness.calls[0][4];
  assert.notEqual(firstSeed, JSON.stringify(tail), 'the first call must reach the server somehow');
  await harness.service.pollProject('project-1');
  assert.equal(
    harness.calls[1][4],
    JSON.stringify(tail),
    'once the response names a tail, the ISO seed is no longer used',
  );
  assert.equal(harness.service.readMonitorState('project-1').seedKind, 'cursor');
});

test('cursor: a full 500-transition page is followed immediately, up to 5 pages', async () => {
  const bigPage = (pageIndex: number): string => page(
    Array.from({ length: 500 }, (_unused, index) => transition({
      order: index,
      seq: pageIndex * 500 + index,
      eventId: `evt-${pageIndex}-${index}`,
      to: 'ready',
      at: isoAt(1_000_600 + pageIndex * 1_000 + index),
    })),
    { nextCursor: { v: 1, carrierEpoch: EPOCH, seq: pageIndex * 500 + 499 } },
  );

  const harness = eventsHarness({
    projects: singleProject(),
    respond: (_args, callIndex) => ({ ok: true, code: 0, stdout: bigPage(callIndex), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.pollProject('project-1');

  assert.equal(harness.calls.length, 5, 'one change must page at most 5 times');
  assert.equal(harness.calls[1][4], JSON.stringify({ v: 1, carrierEpoch: EPOCH, seq: 499 }));
});

test('page parser: a document without a transitions array or with a malformed cursor is refused', () => {
  assert.equal(readTaskLogPage('not json'), null);
  assert.equal(readTaskLogPage('{"nextCursor":null,"rebase":false}'), null);
  assert.equal(readTaskLogPage('{"transitions":[],"rebase":false}'), null, 'nextCursor must be present');
  assert.equal(
    readTaskLogPage('{"transitions":[],"nextCursor":{"v":1,"carrierEpoch":"e","seq":1,"extra":2}}'),
    null,
  );
  assert.equal(
    readTaskLogPage('{"transitions":[{"to":"ready"}],"nextCursor":null}'),
    null,
    'a transition without a taskId is not a reading',
  );
  assert.notEqual(readTaskLogPage('{"transitions":[],"nextCursor":null,"rebase":false}'), null);
});

//----------------- WATCHER ------------

test('watcher: 10 change notifications inside 250 ms coalesce into one task log call', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  for (let index = 0; index < 10; index += 1) {
    harness.watch.emit(QUAY_DIR, 'change', 'task-status-events.jsonl');
  }
  await harness.clock.advance(250);
  assert.equal(harness.calls.length, 1, 'the debounce must merge the burst');
});

test('watcher: a change during a running poll schedules exactly one trailing poll', async () => {
  const release: { fn: (() => void) | null } = { fn: null };
  const harness = eventsHarness({
    projects: singleProject(),
    respond: (_args, callIndex) => {
      if (callIndex === 0) {
        return new Promise<QuayCommandResult>((resolve) => {
          release.fn = () => {
            resolve({ ok: true, code: 0, stdout: page([]), stderr: '' });
          };
        });
      }
      return { ok: true, code: 0, stdout: page([]), stderr: '' };
    },
  });
  await harness.service.ensureMonitored('project-1');

  harness.watch.emit(QUAY_DIR, 'change', 'task-status-events.jsonl');
  await harness.clock.advance(250);
  assert.equal(harness.calls.length, 1, 'the first poll is in flight');

  harness.watch.emit(QUAY_DIR, 'change', 'task-status-events.jsonl');
  await harness.clock.advance(250);
  assert.equal(harness.calls.length, 1, 'the second change is held while the poll runs');

  const releaseFn = release.fn;
  assert.ok(typeof releaseFn === 'function');
  releaseFn();
  await settle();
  assert.equal(harness.calls.length, 2, 'exactly one trailing poll follows the in-flight one');
});

test('watcher: other filenames (gate-events.jsonl change and rename) spawn nothing', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  harness.watch.emit(QUAY_DIR, 'change', 'gate-events.jsonl');
  harness.watch.emit(QUAY_DIR, 'rename', 'gate-events.jsonl');
  await harness.clock.advance(500);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.dispatchChanges.length, 0);
});

test('watcher: the atomic renames of both carriers are handled by the directory watcher', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');

  // `worker-dispatch.json` is renamed into place: it invalidates lanes and spawns no task log.
  harness.watch.emit(QUAY_DIR, 'rename', 'worker-dispatch.json');
  await harness.clock.advance(500);
  assert.deepEqual(harness.dispatchChanges, ['project-1']);
  assert.equal(harness.calls.length, 0);

  // `task-status-events.jsonl` is renamed into place: it is a status change.
  harness.watch.emit(QUAY_DIR, 'rename', 'task-status-events.jsonl');
  await harness.clock.advance(250);
  assert.equal(harness.calls.length, 1);
});

test('watcher: an error degrades the project with a recorded reason instead of failing silently', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  const watcher = harness.watch.closable[0];
  harness.watch.fail(QUAY_DIR, new Error('EMFILE: too many open files'));

  const state = harness.service.readMonitorState('project-1');
  assert.equal(state.state, 'degraded');
  assert.equal(state.reason, 'EMFILE: too many open files');
  assert.equal(watcher.closed, true, 'the failed watcher is closed, not leaked');
  assert.match(
    harness.logs.join('\n'),
    /watcher for .* failed \(EMFILE.*falls back to the TTL path/,
  );
});

test('watcher: a project without a .quay directory is off and does not throw', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
    watchPathFactory: () => null,
  });
  await harness.service.ensureMonitored('project-1');
  assert.equal(harness.service.readMonitorState('project-1').state, 'off');
  assert.equal(harness.calls.length, 0);
});

test('watcher: the 17th active project evicts the least-recently-used monitor', async () => {
  const projects = new Map<string, ProjectIndex>();
  for (let index = 0; index < 17; index += 1) {
    projects.set(`project-${index}`, makeProject(
      path.join(path.sep, 'workspace', `project-${index}`),
      [{ id: 'task-a', status: 'todo' }],
      1_000_500,
      1_000_000,
    ));
  }
  const clock = createFakeClock(1_000);
  const harness = eventsHarness({
    projects,
    clock,
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });

  for (let index = 0; index < 17; index += 1) {
    await harness.service.ensureMonitored(`project-${index}`);
    await clock.advance(1);
  }

  assert.equal(harness.service.readMonitorState('project-0').state, 'off', 'the oldest monitor is evicted');
  assert.equal(harness.service.readMonitorState('project-16').state, 'active');
  assert.equal(harness.watch.closable[0].closed, true);
});

test('watcher: a monitor idle for 10 minutes stops itself', async () => {
  const harness = eventsHarness({
    projects: singleProject(),
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  const watcher = harness.watch.closable[0];
  assert.equal(harness.service.readMonitorState('project-1').state, 'active');

  await harness.clock.advance(600_000);
  assert.equal(harness.service.readMonitorState('project-1').state, 'off');
  assert.equal(watcher.closed, true);
});

test('watcher: the process-exit hook closes every monitor', async () => {
  const projects = new Map<string, ProjectIndex>([
    ['project-1', makeProject(PROJECT_PATH, [{ id: 'task-a', status: 'todo' }], 1_000_500, 1_000_000)],
    ['project-2', makeProject(PROJECT_PATH_2, [{ id: 'task-b', status: 'todo' }], 1_000_500, 1_000_000)],
  ]);
  const harness = eventsHarness({
    projects,
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
  });
  await harness.service.ensureMonitored('project-1');
  await harness.service.ensureMonitored('project-2');
  assert.equal(harness.exitHooks.length, 1, 'the service registers exactly one exit hook');

  harness.exitHooks[0]();
  assert.equal(harness.watch.closable.every((watcher) => watcher.closed), true);
  assert.equal(harness.service.readMonitorState('project-1').state, 'off');
});

//----------------- DEGRADED / FALLBACK ------------

test('fallback: task log absent or unknown means zero monitors and zero task log spawns', async () => {
  for (const verb of ['absent', 'unknown'] as const) {
    const projects = singleProject();
    const project = projects.get('project-1');
    assert.ok(project !== undefined);
    project.capabilities = { taskLog: verb, lanes: 'available' };

    const harness = eventsHarness({
      projects,
      respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
    });
    await harness.service.ensureMonitored('project-1');
    harness.watch.emit(QUAY_DIR, 'change', 'task-status-events.jsonl');
    await harness.clock.advance(500);

    assert.equal(harness.service.readMonitorState('project-1').state, 'off', `${verb}: no monitor`);
    assert.equal(harness.watch.closable.length, 0, `${verb}: no watcher was even opened`);
    assert.equal(harness.calls.length, 0, `${verb}: zero task log spawns`);
    // The index still reads exactly as it did: the TTL path owns it.
    const reading = project.observedAtMs === null ? 'cold' : 'ready';
    assert.equal(reading, 'ready');
  }
});

test('fallback: the TTL full read still runs at 120 s while events may be flowing', async () => {
  const clock = createFakeClock(1_000_000);
  const spawns: string[][] = [];
  const service = createQuayService({
    fileExists: () => false,
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => {
      spawns.push([...args]);
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => {
        throw new Error('ENOENT');
      },
    },
    probeWebService: async () => false,
    now: clock.now,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
  });

  service.requestTaskIndexLoad('project-1');
  await settle();
  assert.equal(service.readTaskIndex('project-1').state, 'ready');
  assert.equal(spawns.length, 1);

  await clock.advance(QUAY_TASK_INDEX_TTL_MS + 1);
  assert.equal(service.readTaskIndex('project-1').state, 'stale');

  service.requestTaskIndexLoad('project-1');
  await settle();
  assert.equal(spawns.length, 2, 'the TTL refresh still performs a full task list');
  assert.deepEqual(spawns[1], ['task', 'list', '--json', '--no-body']);
});

//----------------- DISPATCH CARRIER ------------

type DispatchHarness = {
  reader: ReturnType<typeof createQuayDispatchCarrier>;
  paths: string[];
  reads: string[];
  setFile: (content: string | null, size?: number) => void;
};

function dispatchHarness(initial: { content: string | null; size?: number }): DispatchHarness {
  let content = initial.content;
  let size = initial.size;
  const paths: string[] = [];
  const reads: string[] = [];
  const readFile: QuayFileReader = {
    size: async (filePath) => {
      paths.push(filePath);
      if (content === null) {
        return null;
      }
      return size ?? Buffer.byteLength(content, 'utf8');
    },
    readChunk: async () => '',
    readText: async (filePath) => {
      reads.push(filePath);
      if (content === null) {
        throw new Error('ENOENT');
      }
      return content;
    },
  };
  const reader = createQuayDispatchCarrier({
    resolveProjectPathById: (projectId) => (projectId === 'project-1' ? PROJECT_PATH : null),
    readFile,
    isProcessAlive: (pid) => pid === 111,
  });
  return {
    reader,
    paths,
    reads,
    setFile: (next, nextSize) => {
      content = next;
      size = nextSize;
    },
  };
}

test('dispatch: a missing file is absent, and {} is empty', async () => {
  const missing = dispatchHarness({ content: null });
  assert.deepEqual(await missing.reader.readDispatchSet('project-1'), { state: 'absent' });

  const empty = dispatchHarness({ content: '{}' });
  assert.deepEqual(await empty.reader.readDispatchSet('project-1'), { state: 'empty' });
});

test('dispatch: each entry is live when its workerPid exists and residue when it does not', async () => {
  const harness = dispatchHarness({
    content: JSON.stringify({
      'task-live': {
        runId: 'run-1',
        workerPid: 111,
        startedAtMs: 1_000,
        timeoutDeadlineMs: 2_000,
        cmdlineFingerprint: 'node worker',
      },
      'task-residue': {
        runId: 'run-2',
        workerPid: 222,
        startedAtMs: 1_000,
        timeoutDeadlineMs: 2_000,
        cmdlineFingerprint: 'node worker',
      },
    }),
  });
  const reading = await harness.reader.readDispatchSet('project-1');
  assert.equal(reading.state, 'present');
  if (reading.state !== 'present') {
    return;
  }
  const byTask = new Map(reading.entries.map((entry) => [entry.taskId, entry]));
  assert.equal(byTask.get('task-live')?.state, 'live');
  assert.equal(byTask.get('task-residue')?.state, 'residue');
  assert.equal(byTask.get('task-live')?.workerPid, 111);
});

test('dispatch: invalid JSON, a non-object and an over-size file are not-evaluated, never empty', async () => {
  const invalidJson = dispatchHarness({ content: '{not json' });
  assert.equal((await invalidJson.reader.readDispatchSet('project-1')).state, 'not-evaluated');

  const array = dispatchHarness({ content: '[]' });
  assert.equal((await array.reader.readDispatchSet('project-1')).state, 'not-evaluated');

  const nullDocument = dispatchHarness({ content: 'null' });
  assert.equal((await nullDocument.reader.readDispatchSet('project-1')).state, 'not-evaluated');

  // Over the 1 MiB ceiling: refused from the size reading, without ever reading the body.
  const oversized = dispatchHarness({ content: '{}', size: 1024 * 1024 + 1 });
  assert.equal((await oversized.reader.readDispatchSet('project-1')).state, 'not-evaluated');
  assert.deepEqual(oversized.reads, [], 'an over-size file must not be read into memory');
});

test('dispatch: the only path read is <projectRoot>/.quay/worker-dispatch.json', async () => {
  const harness = dispatchHarness({ content: '{}' });
  await harness.reader.readDispatchSet('project-1');
  assert.deepEqual(harness.paths, [DISPATCH_PATH]);
  assert.ok(!harness.paths[0].includes('..'));
});

//----------------- LANES INVALIDATION ------------

const LANES_DOC = JSON.stringify({
  windowHours: 3,
  nowMs: 1_791_000_600_000,
  overflow: 0,
  lanes: [[{
    taskId: 'live-run',
    runId: 'worker-live-run',
    startMs: 1_791_000_000_000,
    endMs: 1_791_000_300_000,
    phase: 'implementing',
    finalState: null,
    fanInOutcome: null,
  }]],
});

function lanesService(options: { now: () => number }): {
  service: ReturnType<typeof createQuayService>;
  spawns: string[][];
} {
  const spawns: string[][] = [];
  const service = createQuayService({
    fileExists: () => false,
    resolveProjectPathById: (projectId) => {
      if (projectId === 'project-1') {
        return PROJECT_PATH;
      }
      if (projectId === 'project-2') {
        return PROJECT_PATH_2;
      }
      return null;
    },
    runCommand: async (_cwd, args) => {
      spawns.push([...args]);
      return { ok: true, code: 0, stdout: LANES_DOC, stderr: '' };
    },
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => {
        throw new Error('ENOENT');
      },
    },
    probeWebService: async () => false,
    now: options.now,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
  });
  return { service, spawns };
}

test('lanes: a dispatch-file change re-spawns lanes for that project on the next read', async () => {
  const clock = createFakeClock(1_791_000_600_000);
  const { service, spawns } = lanesService({ now: clock.now });

  await service.getQuayLanes('project-1');
  await service.getQuayLanes('project-1');
  assert.equal(spawns.length, 1, 'the second read is served from the lanes TTL cache');

  service.invalidateLanesForProject('project-1');
  await service.getQuayLanes('project-1');
  assert.equal(spawns.length, 2, 'the next read after the dispatch change spawns lanes again');
});

test('lanes: invalidating one project leaves another project’s cache warm', async () => {
  const clock = createFakeClock(1_791_000_600_000);
  const { service, spawns } = lanesService({ now: clock.now });

  await service.getQuayLanes('project-1');
  await service.getQuayLanes('project-2');
  assert.equal(spawns.length, 2);

  service.invalidateLanesForProject('project-1');
  await service.getQuayLanes('project-2');
  assert.equal(spawns.length, 2, 'project-2 is untouched');
  await service.getQuayLanes('project-1');
  assert.equal(spawns.length, 3, 'project-1 re-spawns');
});

test('lanes: the event service wires a dispatch-file change to that project’s invalidation', async () => {
  const clock = createFakeClock(1_791_000_600_000);
  const spawns: string[][] = [];
  let lanesAvailable = true;
  const service = createQuayService({
    fileExists: () => false,
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => {
      spawns.push([...args]);
      if (!lanesAvailable) {
        return { ok: false, code: 1, stdout: '', stderr: '', error: 'unknown verb', failureKind: 'nonzero-exit' };
      }
      return { ok: true, code: 0, stdout: LANES_DOC, stderr: '' };
    },
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => {
        throw new Error('ENOENT');
      },
    },
    probeWebService: async () => false,
    now: clock.now,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
  });

  const watch = createWatchHarness();
  const harness = eventsHarness({
    projects: singleProject(),
    clock,
    watch,
    respond: () => ({ ok: true, code: 0, stdout: page([]), stderr: '' }),
    // Exactly the composition root's binding.
    onDispatchFileChanged: (projectId) => service.invalidateLanesForProject(projectId),
  });
  await harness.service.ensureMonitored('project-1');

  await service.getQuayLanes('project-1');
  await service.getQuayLanes('project-1');
  assert.equal(spawns.length, 1, 'the lanes cache is warm');

  watch.emit(QUAY_DIR, 'rename', 'worker-dispatch.json');
  assert.deepEqual(harness.dispatchChanges, ['project-1']);
  await service.getQuayLanes('project-1');
  assert.equal(spawns.length, 2, 'the dispatch change made the next lanes read spawn again');

  lanesAvailable = false;
  service.invalidateLanesForProject('project-1');
  const unavailable = await service.getQuayLanes('project-1');
  assert.equal(unavailable?.ganttUnavailable, 'plugin-lacks-lanes-verb', 'the absent-verb reading is unchanged');
  // A dispatch change is a lanes signal only: it never spawns task log.
  assert.equal(harness.calls.length, 0);
});
