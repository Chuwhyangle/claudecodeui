import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  createQuayService,
  isReadOnlyQuayCommand,
  normalizeGanttWindowHours,
  readCarrierFileTail,
  readCurrentSuiteState,
  readInFlightRuns,
  type QuayCommandResult,
  type QuayCommandRunner,
  type QuayFileReader,
} from '../quay.service.js';

type ServiceDependencies = Parameters<typeof createQuayService>[0];

const PROJECT_PATH = path.join(path.sep, 'workspace', 'project-1');
const CONFIG_PATH = path.join(PROJECT_PATH, '.quay', 'config.yml');

/**
 * A read-only file boundary over an in-memory corpus. `size`/`readChunk` serve a
 * synthetic carrier file and record every byte-range read, so a test can assert
 * how much of a file the tail reader actually touched.
 */
function createFileReader(overrides: Partial<QuayFileReader> = {}): QuayFileReader {
  return {
    size: async () => null,
    readChunk: async () => '',
    readText: async () => {
      throw new Error('ENOENT');
    },
    ...overrides,
  };
}

/** Minimal dependency set: fake availability check, fake runner, fake file boundary and a controllable clock. */
function createDependencies(overrides: Partial<ServiceDependencies> = {}): ServiceDependencies {
  return {
    fileExists: () => false,
    resolveProjectPathById: (projectId: string) => (projectId === 'project-1' ? PROJECT_PATH : null),
    runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    readFile: createFileReader(),
    // Default: nothing answers on the recorded address, so the dashboard is absent — the
    // same "no dashboard running" state a machine that never ran `quay serve` is in.
    probeWebService: async () => false,
    now: () => 0,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
    ...overrides,
  };
}

/**
 * A `.quay/server.json` body in the shape `quay serve` publishes (its `services[]` carry the
 * `name`/`host`/`port` the panel links to). Default argument is the one live `web` entry the
 * dashboard fixture reads.
 */
function serverStateCarrier(services: unknown[] = [{ name: 'web', host: '172.28.0.1', port: 3651, up: true }]): string {
  return JSON.stringify({ schemaVersion: 1, pid: 1, startedAt: '2026-01-01T00:00:00.000Z', services });
}

/**
 * The commands `collectSnapshot` is expected to spawn, as exact argv strings. The dashboard
 * is NOT among them: it reads the `.quay/server.json` carrier and probes the recorded address
 * in-process, so `server status --json` no longer costs a subprocess (nor is it whitelisted).
 */
const EXPECTED_SNAPSHOT_COMMANDS = [
  'adr list --json',
  'config validate --json',
  // The Loop pulse card's in-flight half. `driver live` is a separate read-only verb from
  // `driver status`: the latter reports liveness, the former the runs themselves.
  'driver live --kind worker --json',
  'driver status --kind worker --json',
  'goal list --json',
  'task list --json',
];

/** A runner that answers each whitelisted read-only command with a fixture JSON document. */
function createFixtureRunner(counter: { calls: number }): QuayCommandRunner {
  const responses: Record<string, unknown> = {
    'task list --json': [
      { id: 'a', title: 'Task A', status: 'ready', updatedAt: 300 },
      { id: 'b', title: 'Task B', status: 'done', updatedAt: 100 },
      { id: 'c', title: 'Task C', status: 'needs-human', updatedAt: 200 },
    ],
    'goal list --json': [{ id: 'GOAL-1', status: 'achieved' }, { id: 'GOAL-2', status: 'pending' }],
    'adr list --json': [],
    'driver status --kind worker --json': {
      alive: 1,
      running: 1,
      last_record_ts: '2026-01-01T00:00:00.000Z',
    },
    'config validate --json': [{ severity: 'error', field: 'loop.board', message: 'missing' }],
  };

  return async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    counter.calls += 1;
    const key = args.join(' ');
    return { ok: true, code: 0, stdout: JSON.stringify(responses[key] ?? null), stderr: '' };
  };
}

test('detectQuayConfig reports true only when .quay/config.yml exists', () => {
  const seen: string[] = [];
  const service = createQuayService(createDependencies({
    fileExists: (filePath: string) => {
      seen.push(filePath);
      return filePath === CONFIG_PATH;
    },
  }));

  assert.equal(service.detectQuayConfig(PROJECT_PATH), true);
  assert.deepEqual(seen, [CONFIG_PATH]);

  const missing = createQuayService(createDependencies({ fileExists: () => false }));
  assert.equal(missing.detectQuayConfig(PROJECT_PATH), false);
});

test('runQuayCommand refuses a non-whitelisted command without spawning a subprocess', async () => {
  let spawnCount = 0;
  const service = createQuayService(createDependencies({
    runCommand: async () => {
      spawnCount += 1;
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const writeCommands = [
    ['task', 'create', '--json'],
    ['task', 'edit', 'gap-x'],
    ['task', 'check', 'gap-x'],
    ['driver', 'start', '--kind', 'worker'],
    ['driver', 'stop', '--kind', 'worker'],
    ['gate', 'run', 'gap-x'],
    ['promote', 'gap-x'],
    ['retreat', 'gap-x'],
    // A read-only prefix with an extra argument must not slip through the exact-match rule.
    ['task', 'list', '--json', '--inject'],
  ];

  for (const args of writeCommands) {
    const result = await service.runQuayCommand(PROJECT_PATH, args);
    assert.equal(result.ok, false, `expected refusal for: ${args.join(' ')}`);
    assert.match(result.error ?? '', /whitelist/);
  }

  assert.equal(spawnCount, 0, 'no refused command may reach the subprocess runner');
});

test('runQuayCommand executes a whitelisted read-only command', async () => {
  const seen: string[][] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (cwd: string, args: readonly string[]) => {
      seen.push([cwd, ...args]);
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const result = await service.runQuayCommand(PROJECT_PATH, ['adr', 'list', '--json']);

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [[PROJECT_PATH, 'adr', 'list', '--json']]);
  assert.equal(isReadOnlyQuayCommand(['driver', 'status', '--kind', 'promotion', '--json']), true);
  assert.equal(isReadOnlyQuayCommand(['driver', 'status', '--json']), false);
  // `server status --json` is no longer on the whitelist at all: it was the one source of
  // the optional dashboard link, and it cost ~4s of driver-kind subprocesses to answer.
  // The panel reads the `.quay/server.json` carrier instead, so the command is now refused
  // before it could ever reach a child — structurally, not merely by not being called.
  assert.equal(isReadOnlyQuayCommand(['server', 'status', '--json']), false);
  assert.equal(isReadOnlyQuayCommand(['server', 'status']), false);
  assert.equal(isReadOnlyQuayCommand(['server', 'start']), false);
});

test('getQuaySnapshot deduplicates concurrent calls and reuses a fresh snapshot', async () => {
  const counter = { calls: 0 };
  let nowMs = 0;
  const service = createQuayService(createDependencies({
    now: () => nowMs,
    runCommand: createFixtureRunner(counter),
    // The dashboard link comes from the carrier plus a live probe, not from a spawned
    // `server status`; both are stubbed here so the composed URL is still asserted below.
    readFile: createFileReader({
      readText: async (filePath) => {
        if (filePath === path.join(PROJECT_PATH, '.quay', 'server.json')) {
          return serverStateCarrier();
        }
        throw new Error('ENOENT');
      },
    }),
    probeWebService: async (host, port) => host === '172.28.0.1' && port === 3651,
  }));

  // Two concurrent opens of the same project must share one CLI pass, not two.
  const [first, second] = await Promise.all([
    service.getQuaySnapshot('project-1'),
    service.getQuaySnapshot('project-1'),
  ]);

  // Derived from the expected command set rather than a literal, so adding a read does not
  // silently turn this dedupe assertion into a count assertion.
  const perPassCommands = EXPECTED_SNAPSHOT_COMMANDS.length;
  assert.equal(counter.calls, perPassCommands, 'two concurrent calls spawn the CLI once per command');
  assert.equal(first, second, 'the in-flight promise is shared, not recomputed');

  assert.ok(first);
  assert.equal(first.cached, false);
  assert.deepEqual(first.tasks, {
    total: 3,
    byStatus: { ready: 1, done: 1, 'needs-human': 1 },
    ready: 1,
    needsHuman: 1,
    done: 1,
    // Most recently updated first: a(300) → c(200) → b(100), each row carrying
    // the ISO form of the epoch it was ranked by.
    recent: [
      { id: 'a', title: 'Task A', status: 'ready', updatedAt: new Date(300).toISOString() },
      { id: 'c', title: 'Task C', status: 'needs-human', updatedAt: new Date(200).toISOString() },
      { id: 'b', title: 'Task B', status: 'done', updatedAt: new Date(100).toISOString() },
    ],
  });
  assert.deepEqual(first.goals, {
    total: 2,
    achieved: 1,
    breakdown: {
      byStatus: { achieved: 1, pending: 1 },
      // Neither goal carries an updatedAt, so both read `null` and the tie breaks by id ascending.
      recent: [
        { id: 'GOAL-1', title: '', status: 'achieved', updatedAt: null },
        { id: 'GOAL-2', title: '', status: 'pending', updatedAt: null },
      ],
    },
  });
  assert.deepEqual(first.adrs, { total: 0, recent: [] });
  assert.deepEqual(first.configIssues, { total: 1, errors: 1 });
  assert.equal(first.driver?.state, 'running');
  assert.equal(first.dashboardUrl, 'http://172.28.0.1:3651/');
  // No carrier files on disk in this fixture (the default reader returns nothing).
  assert.deepEqual(first.tests, { current: null, recentRounds: [] });
  assert.deepEqual(first.fanIn, { recent: [] });

  // A call inside the TTL window is served from cache — no new subprocess.
  const cached = await service.getQuaySnapshot('project-1');
  assert.equal(counter.calls, perPassCommands, 'a TTL hit must not spawn the CLI again');
  assert.equal(cached?.cached, true);

  // Past the TTL the snapshot is rebuilt; `forceRefresh` bypasses it outright.
  nowMs += 60_000;
  const refreshed = await service.getQuaySnapshot('project-1');
  assert.equal(counter.calls, perPassCommands * 2);
  assert.equal(refreshed?.cached, false);

  await service.getQuaySnapshot('project-1', { forceRefresh: true });
  assert.equal(counter.calls, perPassCommands * 3);
});

test('getQuaySnapshot keeps the findings of a command that signals via its exit code', async () => {
  // `quay config validate --json` prints its issue list and exits 1 to say the
  // issues exist; that list is the reading, so a non-zero exit must not discard it.
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args.join(' ') === 'config validate --json') {
        return {
          ok: false,
          code: 1,
          stdout: JSON.stringify([{ severity: 'error', field: 'loop.board', message: 'missing' }]),
          stderr: '',
        };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.configIssues, { total: 1, errors: 1 });
  assert.deepEqual(snapshot?.warnings, []);
});

test('getQuaySnapshot returns null for an unknown project', async () => {
  const service = createQuayService(createDependencies());
  assert.equal(await service.getQuaySnapshot('missing'), null);
});

/**
 * The reading this test is the permanent record of (2026-10-07): the cold snapshot was ~9.5s
 * because `collectSnapshot` `await`-ed six independent CLI reads in series, and one of them —
 * `server status --json` — cost ~4s of its own driver-kind subprocesses to yield a single
 * optional dashboard URL. Two criteria are asserted here, deliberately not by wall clock alone:
 *
 *  - STRUCTURAL: the injected runner records the highest number of calls it ever had in
 *    flight at once. Each call parks on a timer before answering, so if the collector overlaps
 *    them the peak reaches five; if it awaits them in series the peak is one, no matter how the
 *    host schedules. This is the assertion a re-serialised collector cannot pass.
 *  - WALL CLOCK, as a second witness: five overlapping `COMMAND_DELAY_MS` waits finish in about
 *    one delay, while a serial collector needs their sum.
 *
 * The command set is asserted exactly, so "made it faster by dropping a section" fails too.
 */
test('collectSnapshot overlaps its independent CLI reads instead of awaiting them in series', async () => {
  const COMMAND_DELAY_MS = 200;
  const seen: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;

  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      seen.push(args.join(' '));
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_DELAY_MS));
        return { ok: true, code: 0, stdout: '[]', stderr: '' };
      } finally {
        inFlight -= 1;
      }
    },
  }));

  const startedAt = performance.now();
  const snapshot = await service.getQuaySnapshot('project-1');
  const elapsedMs = performance.now() - startedAt;

  assert.ok(snapshot);
  // All five independent reads must be in flight at once. Under the serial collector this is 1.
  assert.equal(peakInFlight, EXPECTED_SNAPSHOT_COMMANDS.length, 'the independent reads must overlap');
  // Nothing was dropped to fake the speedup: the very same five commands still run, once each.
  assert.deepEqual([...seen].sort(), EXPECTED_SNAPSHOT_COMMANDS);
  // Second witness: one delay, not five. A serial pass cannot get under `COMMAND_DELAY_MS * 3`
  // (it needs `COMMAND_DELAY_MS * 5`), and an overlapped pass cannot approach the former.
  assert.ok(
    elapsedMs < COMMAND_DELAY_MS * 3,
    `expected an overlapped pass (< ${COMMAND_DELAY_MS * 3}ms), took ${Math.round(elapsedMs)}ms`,
  );
});

test('the dashboard link is read from the .quay/server.json carrier, never by spawning the CLI', async () => {
  const seen: string[] = [];
  const readPaths: string[] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      seen.push(args.join(' '));
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
    readFile: createFileReader({
      readText: async (filePath) => {
        readPaths.push(filePath);
        if (filePath === path.join(PROJECT_PATH, '.quay', 'server.json')) {
          return serverStateCarrier();
        }
        throw new Error('ENOENT');
      },
    }),
    probeWebService: async (host, port) => host === '172.28.0.1' && port === 3651,
  }));

  const snapshot = await service.getQuaySnapshot('project-1');

  assert.equal(snapshot?.dashboardUrl, 'http://172.28.0.1:3651/');
  // The carrier under the project root is where the link came from — not a `server status` body.
  assert.ok(
    readPaths.includes(path.join(PROJECT_PATH, '.quay', 'server.json')),
    'the dashboard must be read from the .quay/server.json carrier',
  );
  // `server status --json` is neither spawned nor even whitelisted any more.
  assert.equal(seen.includes('server status --json'), false, 'the dashboard must not cost a subprocess');
  assert.deepEqual([...seen].sort(), EXPECTED_SNAPSHOT_COMMANDS);
  assert.deepEqual(snapshot?.warnings, []);
});

test('a wildcard bind host is probed — and linked — on loopback, not at the wildcard literal', async () => {
  const probed: Array<{ host: string; port: number }> = [];
  const service = createQuayService(createDependencies({
    runCommand: async () => ({ ok: true, code: 0, stdout: '[]', stderr: '' }),
    readFile: createFileReader({
      readText: async () => serverStateCarrier([{ name: 'web', host: '0.0.0.0', port: 3651, up: true }]),
    }),
    probeWebService: async (host, port) => {
      probed.push({ host, port });
      return true;
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');

  assert.deepEqual(probed, [{ host: '127.0.0.1', port: 3651 }]);
  assert.equal(snapshot?.dashboardUrl, 'http://127.0.0.1:3651/');
});

test('the dashboard link is null — and warns nothing — when no live web service answers', async () => {
  const cases: Array<{ name: string; carrier: string | null; probeAlive?: boolean }> = [
    { name: 'no carrier file at all', carrier: null },
    { name: 'carrier that is not JSON', carrier: '{ not json' },
    {
      name: 'carrier with no web service entry',
      carrier: serverStateCarrier([{ name: 'control', host: '127.0.0.1', port: 13029, up: true }]),
    },
    {
      name: 'web entry with no usable host or port',
      carrier: serverStateCarrier([{ name: 'web', up: true }]),
    },
    {
      name: 'web service recorded but unreachable',
      carrier: serverStateCarrier([{ name: 'web', host: '127.0.0.1', port: 3651, up: true }]),
      probeAlive: false,
    },
  ];

  for (const scenario of cases) {
    let probeCalls = 0;
    const service = createQuayService(createDependencies({
      runCommand: async () => ({ ok: true, code: 0, stdout: '[]', stderr: '' }),
      readFile: createFileReader({
        readText: async () => {
          if (scenario.carrier === null) {
            throw new Error('ENOENT');
          }
          return scenario.carrier;
        },
      }),
      probeWebService: async () => {
        probeCalls += 1;
        return scenario.probeAlive ?? true;
      },
    }));

    const snapshot = await service.getQuaySnapshot('project-1');
    assert.equal(snapshot?.dashboardUrl, null, scenario.name);
    assert.deepEqual(snapshot?.warnings, [], `${scenario.name}: an absent dashboard is not a warning`);
    if (scenario.name !== 'web service recorded but unreachable') {
      assert.equal(probeCalls, 0, `${scenario.name}: a carrier with no usable web address must not be probed`);
    }
  }
});

/**
 * The task ledger's counts are an aggregate of the WHOLE `task list --json` array, and the
 * collector must keep asking for that whole array. This is the guard against "speeding up" the
 * cold path by adding `--page-size`: the paginated `--json` is a bare array carrying no total, so
 * paging would silently turn a real ledger ("2583 tasks") into the page size ("10 tasks"). The
 * reading is load-bearing, so the argv is pinned to prove the collector does not — and must not —
 * ask for a page.
 */
test('the task counts aggregate the whole list, and the collector asks for it unpaged', async () => {
  // Six tasks over five statuses, with a repeated status so the per-status fold is exercised.
  const tasks = [
    { id: 't-ready-1', title: 'R1', status: 'ready', updatedAt: 6 },
    { id: 't-todo', title: 'T', status: 'todo', updatedAt: 5 },
    { id: 't-done-1', title: 'D1', status: 'done', updatedAt: 4 },
    { id: 't-done-2', title: 'D2', status: 'done', updatedAt: 3 },
    { id: 't-nh', title: 'NH', status: 'needs-human', updatedAt: 2 },
    { id: 't-sup', title: 'S', status: 'superseded', updatedAt: 1 },
  ];
  const taskListArgv: string[][] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args[0] === 'task' && args[1] === 'list') {
        taskListArgv.push([...args]);
      }
      const key = args.join(' ');
      return { ok: true, code: 0, stdout: key === 'task list --json' ? JSON.stringify(tasks) : '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');

  // The counts are the true aggregate of the whole six-task array, not of any page of it.
  assert.equal(snapshot?.tasks?.total, 6, 'total counts every task in the array');
  assert.deepEqual(snapshot?.tasks?.byStatus, {
    ready: 1,
    todo: 1,
    done: 2,
    'needs-human': 1,
    superseded: 1,
  });
  assert.equal(snapshot?.tasks?.ready, 1);
  assert.equal(snapshot?.tasks?.needsHuman, 1);
  assert.equal(snapshot?.tasks?.done, 2);

  // ...and the collector asked for the whole array: no `--page-size`, which would truncate it
  // (and the paginated `--json` carries no total to count from).
  assert.deepEqual(taskListArgv, [['task', 'list', '--json']]);
  assert.equal(
    taskListArgv.some((argv) => argv.includes('--page-size')),
    false,
    'a paged task list would silently shrink the ledger counts',
  );
});

test('getQuaySnapshot caps the recent lists and orders them most-recent-first', async () => {
  const makeItems = (prefix: string, count: number) =>
    Array.from({ length: count }, (_item, index) => ({
      id: `${prefix}-${String(index).padStart(2, '0')}`,
      title: `${prefix} ${index}`,
      status: 'done',
      // Distinct timestamps so recency — not source order — decides the ranking.
      updatedAt: index,
    }));

  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      const key = args.join(' ');
      if (key === 'task list --json') {
        return { ok: true, code: 0, stdout: JSON.stringify(makeItems('T', 12)), stderr: '' };
      }
      if (key === 'adr list --json') {
        return { ok: true, code: 0, stdout: JSON.stringify(makeItems('ADR', 12)), stderr: '' };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  // 12 items, updatedAt 0..11 → the ten newest, newest first.
  const expectedIds = (prefix: string) =>
    Array.from({ length: 10 }, (_item, index) => `${prefix}-${String(11 - index).padStart(2, '0')}`);

  assert.deepEqual(snapshot.tasks?.recent.map((item) => item.id), expectedIds('T'));
  assert.deepEqual(snapshot.adrs?.recent.map((item) => item.id), expectedIds('ADR'));
  assert.equal(snapshot.tasks?.recent.length, 10);
  assert.equal(snapshot.adrs?.recent.length, 10);
  // The counts still describe the whole array, not just the capped recent slice.
  assert.equal(snapshot.tasks?.total, 12);
  assert.equal(snapshot.adrs?.total, 12);
});

test('getQuaySnapshot breaks a recency tie by id so the recent order is deterministic', async () => {
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args.join(' ') === 'task list --json') {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify([
            { id: 'zzz', title: 'Z', status: 'ready', updatedAt: 5 },
            { id: 'aaa', title: 'A', status: 'ready', updatedAt: 5 },
          ]),
          stderr: '',
        };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.tasks?.recent.map((item) => item.id), ['aaa', 'zzz']);
});

/**
 * The reading this test is the permanent record of (2026-10-04, project `quay`): both detail
 * lists are ranked by `updatedAt` descending — `quay task list --json` prints it as epoch
 * milliseconds, a float such as `1786439928515.85` — but the projection kept only
 * `{id, title, status}`, so the panel showed a list ordered by the one field it never showed.
 * The projection now carries the ISO-8601 form of that same epoch, which is what makes the
 * ranking key and the displayed value one reading instead of two.
 */
test('recent rows carry updatedAt as an ISO-8601 string, and the ranking is that same value', async () => {
  const tasks = [
    // The finite block's ids run the OPPOSITE way to its recency, so a sort by id — or the
    // source array order — produces a visibly different list from a sort by updatedAt.
    { id: 'a-epoch-zero', title: 'Epoch zero', status: 'done', updatedAt: 0 },
    { id: 'b-old', title: 'Oldest', status: 'done', updatedAt: 1_786_439_928_515.85 },
    { id: 'c-mid', title: 'Middle', status: 'needs-human', updatedAt: 1_788_773_746_346.9514 },
    { id: 'd-new', title: 'Newest', status: 'ready', updatedAt: 1_791_085_796_647.5442 },
    // No timestamp at all, and a value that is not numeric: both must read `null`, never 0.
    { id: 'e-missing', title: 'No stamp', status: 'todo' },
    { id: 'f-unreadable', title: 'Bad stamp', status: 'todo', updatedAt: 'not-a-number' },
  ];
  const goals = [
    { id: 'GOAL-A', title: 'Alpha', status: 'achieved', updatedAt: 1_700_000_000_000 },
    { id: 'GOAL-B', title: 'Beta', status: 'active', updatedAt: null },
    { id: 'GOAL-C', title: 'Gamma', status: 'draft', updatedAt: 1_800_000_000_000 },
  ];

  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      const key = args.join(' ');
      if (key === 'task list --json') return { ok: true, code: 0, stdout: JSON.stringify(tasks), stderr: '' };
      if (key === 'goal list --json') return { ok: true, code: 0, stdout: JSON.stringify(goals), stderr: '' };
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  const recentTasks = snapshot.tasks?.recent ?? [];
  // Most recently updated first, ties by id ascending: the finite block comes out in the
  // reverse of its id order, and both untimestamped rows land at the end.
  assert.deepEqual(
    recentTasks.map((item) => item.id),
    ['d-new', 'c-mid', 'b-old', 'a-epoch-zero', 'e-missing', 'f-unreadable'],
  );
  // Each row carries the ISO-8601 form of exactly the epoch it was ranked by.
  assert.deepEqual(recentTasks.map((item) => item.updatedAt), [
    new Date(1_791_085_796_647.5442).toISOString(),
    new Date(1_788_773_746_346.9514).toISOString(),
    new Date(1_786_439_928_515.85).toISOString(),
    new Date(0).toISOString(),
    null,
    null,
  ]);
  // An epoch of 0 is a real reading (1970-01-01) and a missing one is not it: the missing and
  // unreadable rows are `null`, not 0, not an empty string and not an `Invalid Date` string.
  assert.equal(recentTasks[3].updatedAt, '1970-01-01T00:00:00.000Z');
  for (const item of recentTasks) {
    if (item.updatedAt !== null) {
      assert.match(item.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  }

  const recentGoals = snapshot.goals?.breakdown.recent ?? [];
  assert.deepEqual(recentGoals.map((goal) => goal.id), ['GOAL-C', 'GOAL-A', 'GOAL-B']);
  assert.deepEqual(recentGoals.map((goal) => goal.updatedAt), [
    new Date(1_800_000_000_000).toISOString(),
    new Date(1_700_000_000_000).toISOString(),
    null,
  ]);
});

test('readCarrierFileTail keeps only the last N records and reads a bounded tail window, not the whole file', async () => {
  // ~1.4 MB of records; a whole-file read would be the very thing this reader exists to avoid.
  const lines = Array.from({ length: 100_000 }, (_line, index) => JSON.stringify({ round: index }));
  const content = `${lines.join('\n')}\n`;
  const reads: Array<{ position: number; length: number }> = [];
  const reader = createFileReader({
    size: async () => content.length,
    readChunk: async (_filePath, position, length) => {
      reads.push({ position, length });
      return content.slice(position, position + length);
    },
  });

  const records = await readCarrierFileTail(reader, '/workspace/history.jsonl', 10);

  assert.deepEqual(
    records.map((record) => (record as { round: number }).round),
    [99_990, 99_991, 99_992, 99_993, 99_994, 99_995, 99_996, 99_997, 99_998, 99_999],
  );
  assert.equal(reads.length, 1, 'one 64 KiB window already holds more than ten lines');
  assert.ok(reads[0].length <= 64 * 1024, `read ${reads[0].length} bytes, expected <= 64 KiB`);
  assert.ok(reads[0].length < content.length / 10, 'the tail read must be a small fraction of the file');
});

test('readCarrierFileTail skips malformed lines instead of failing the whole read', async () => {
  const content = `${JSON.stringify({ round: 1 })}\nnot json at all\n${JSON.stringify({ round: 3 })}\n`;
  const reader = createFileReader({
    size: async () => content.length,
    readChunk: async (_filePath, position, length) => content.slice(position, position + length),
  });

  assert.deepEqual(await readCarrierFileTail(reader, '/workspace/history.jsonl', 10), [{ round: 1 }, { round: 3 }]);
});

test('readCurrentSuiteState returns the projected reading, and null for a missing or unparseable file', async () => {
  const present = createFileReader({
    readText: async () => JSON.stringify({ state: 'red', laneCount: 3 }),
  });
  assert.deepEqual(await readCurrentSuiteState(present, '/workspace/full-suite-state.json'), {
    state: 'red',
    runner: null,
    scope: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    laneCount: 3,
    commit: null,
    taskId: null,
    runId: null,
  });

  const garbage = createFileReader({ readText: async () => '{ not json' });
  assert.equal(await readCurrentSuiteState(garbage, '/workspace/full-suite-state.json'), null);

  const noState = createFileReader({ readText: async () => JSON.stringify({ laneCount: 3 }) });
  assert.equal(await readCurrentSuiteState(noState, '/workspace/full-suite-state.json'), null);

  // The default reader throws (file absent): a normal "nothing running" state, never an error.
  assert.equal(await readCurrentSuiteState(createFileReader(), '/workspace/full-suite-state.json'), null);
});

test('getQuaySnapshot projects the Tests and Fan-in cards and drops the heavy round detail', async () => {
  const roundContent = `${[
    JSON.stringify({
      round: 7,
      startedAt: '2026-10-03T01:00:00.000Z',
      durationMs: 12_000,
      pass: 4,
      fail: 1,
      tests: 5,
      state: 'red',
      perFile: [{ file: 'a.test.ts', detail: 'x'.repeat(5_000) }],
    }),
    JSON.stringify({
      round: 8,
      startedAt: '2026-10-03T02:00:00.000Z',
      durationMs: 9_000,
      pass: 5,
      fail: 0,
      tests: 5,
      state: 'green',
      perFile: [],
    }),
  ].join('\n')}\n`;
  const outcomeContent = `${[
    JSON.stringify({
      task: 'gap-a',
      mechanical_fan_in: { outcome: 'landed', lockAcquireEpoch: 1_791_003_441, lockReleaseEpoch: 1_791_003_657 },
    }),
    // No mechanical_fan_in block: the task never reached fan-in, so it is filtered out.
    JSON.stringify({ task: 'gap-b' }),
    JSON.stringify({
      task: 'gap-c',
      mechanical_fan_in: { outcome: 'failed', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
    }),
  ].join('\n')}\n`;

  const reader = createFileReader({
    size: async (filePath) => {
      if (filePath.endsWith('verification-round.jsonl')) return roundContent.length;
      if (filePath.endsWith('worker-outcome.jsonl')) return outcomeContent.length;
      return null;
    },
    readChunk: async (filePath, position, length) => {
      const content = filePath.endsWith('verification-round.jsonl') ? roundContent : outcomeContent;
      return content.slice(position, position + length);
    },
    readText: async (filePath) => {
      if (filePath.endsWith('full-suite-state.json')) {
        return JSON.stringify({
          state: 'green',
          runner: 'inner',
          scope: 'worktree',
          startedAt: '2026-10-03T06:58:14.072Z',
          finishedAt: 1_791_010_890,
          durationMs: 196_837,
          laneCount: 127,
          commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
          taskId: 'gap-x',
          runId: 'r1',
        });
      }
      throw new Error('ENOENT');
    },
  });

  const service = createQuayService(createDependencies({
    readFile: reader,
    runCommand: async (_cwd, args): Promise<QuayCommandResult> => ({
      ok: true,
      code: 0,
      stdout: args.join(' ') === 'goal list --json'
        ? JSON.stringify([
            { id: 'GOAL-1', status: 'achieved', updatedAt: 2 },
            { id: 'GOAL-2', status: 'active', updatedAt: 1 },
            { id: 'GOAL-3', status: 'active', updatedAt: 3 },
          ])
        : '[]',
      stderr: '',
    }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  assert.deepEqual(snapshot.tests.current, {
    state: 'green',
    runner: 'inner',
    scope: 'worktree',
    startedAt: '2026-10-03T06:58:14.072Z',
    finishedAt: 1_791_010_890,
    durationMs: 196_837,
    laneCount: 127,
    commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
    taskId: 'gap-x',
    runId: 'r1',
  });
  assert.deepEqual(snapshot.tests.recentRounds, [
    { round: 7, startedAt: '2026-10-03T01:00:00.000Z', durationMs: 12_000, pass: 4, fail: 1, tests: 5, state: 'red' },
    { round: 8, startedAt: '2026-10-03T02:00:00.000Z', durationMs: 9_000, pass: 5, fail: 0, tests: 5, state: 'green' },
  ]);
  assert.equal('perFile' in (snapshot.tests.recentRounds[0] as object), false, 'the heavy per-file detail must be dropped');

  assert.deepEqual(snapshot.fanIn.recent, [
    { task: 'gap-a', outcome: 'landed', lockAcquireEpoch: 1_791_003_441, lockReleaseEpoch: 1_791_003_657 },
    { task: 'gap-c', outcome: 'failed', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
  ]);

  // Stage goals breakdown groups by status and orders the recent rows newest first.
  assert.deepEqual(snapshot.goals?.breakdown.byStatus, { achieved: 1, active: 2 });
  assert.deepEqual(snapshot.goals?.breakdown.recent.map((goal) => goal.id), ['GOAL-3', 'GOAL-1', 'GOAL-2']);

  // Missing carrier files are a normal empty reading, never a warning.
  assert.deepEqual(snapshot.warnings, []);
});

// --------------------------- in-flight tasks (gap-cloudcli-quay-snapshot-inflight-tasks) ---------------------------

/**
 * A read-only boundary serving an in-memory `.quay/` corpus keyed by file BASENAME; a
 * basename not in the corpus is absent (size `null`, `readText` throws), the same
 * "carrier not on disk" state the production adapter reports.
 */
function createCarrierReader(corpus: Record<string, string>): QuayFileReader {
  return createFileReader({
    size: async (filePath) => {
      const content = corpus[path.basename(filePath)];
      return content === undefined ? null : content.length;
    },
    readChunk: async (filePath, position, length) => (corpus[path.basename(filePath)] ?? '').slice(position, position + length),
    readText: async (filePath) => {
      const content = corpus[path.basename(filePath)];
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      return content;
    },
  });
}

/** A runner whose only non-empty answer is `driver status --kind worker --json`. */
function createDriverRunningRunner(): QuayCommandRunner {
  return async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    if (args.join(' ') === 'driver status --kind worker --json') {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ alive: 1, running: 1, last_record_ts: '2026-10-07T00:00:00.000Z' }),
        stderr: '',
      };
    }
    return { ok: true, code: 0, stdout: '[]', stderr: '' };
  };
}

/**
 * The reading this task exists for (2026-10-07): `driver status --kind worker --json`
 * says `running`, but the snapshot used to carry no field naming WHICH task was running —
 * `.quay/worker-round.jsonl`, the only in-flight carrier, was never read, so a full
 * `JSON.stringify(snapshot)` search for the in-flight task id found ZERO occurrences
 * (AC1's recorded red baseline: `occurrences of "gap-example-task" = 0`,
 * `snapshot.inFlight = undefined`). With the carrier wired in, the same fixture reads the
 * task back verbatim (AC2), while `driver.state` stays the unchanged `'running'`.
 */
test('getQuaySnapshot reads the in-flight task from the worker-round carrier', async () => {
  // The AC1 fixture, exactly.
  const workerRound = `${JSON.stringify({
    at: '2026-10-07T00:00:00.000Z',
    pid: 4242,
    inFlightTasks: ['gap-example-task'],
    inFlightTaskStarts: { 'gap-example-task': '2026-10-06T23:50:00.000Z' },
  })}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createDriverRunningRunner(),
    readFile: createCarrierReader({ 'worker-round.jsonl': workerRound }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  // The driver reading is unchanged by this task — still only `running`, no task id.
  assert.equal(snapshot.driver?.state, 'running');
  assert.deepEqual(snapshot.driver, {
    state: 'running',
    alive: true,
    running: true,
    lastRecordAt: '2026-10-07T00:00:00.000Z',
  });

  // The in-flight reading the gap was about, verbatim (AC2).
  assert.deepEqual(snapshot.inFlight, [
    {
      taskId: 'gap-example-task',
      phase: 'implementing',
      startedAt: '2026-10-06T23:50:00.000Z',
      lastHeartbeat: '2026-10-07T00:00:00.000Z',
      workerPid: 4242,
    },
  ]);
  // The positive control for AC1's negative: the task id now appears in the serialized snapshot.
  assert.ok(
    JSON.stringify(snapshot).includes('gap-example-task'),
    'the in-flight task id must reach the serialized snapshot',
  );
});

test('in-flight phase distinguishes a task parked in fan-in from one implementing', async () => {
  const workerRound = `${JSON.stringify({
    ts: '2026-10-07T00:00:00.000Z',
    pid: 999,
    in_flight_tasks: ['gap-fan-in-task', 'gap-implementing-task'],
    in_flight_task_starts: {
      'gap-fan-in-task': '2026-10-06T23:00:00.000Z',
      'gap-implementing-task': '2026-10-06T23:30:00.000Z',
    },
  })}\n`;
  const workerOutcome = `${[
    // Lock acquired and never released → still parked in fan-in.
    JSON.stringify({
      task: 'gap-fan-in-task',
      mechanical_fan_in: { outcome: 'running', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
    }),
    // An earlier attempt that already released the lock → not parked.
    JSON.stringify({
      task: 'gap-implementing-task',
      mechanical_fan_in: { outcome: 'landed', lockAcquireEpoch: 1_791_000_000, lockReleaseEpoch: 1_791_000_500 },
    }),
  ].join('\n')}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createDriverRunningRunner(),
    readFile: createCarrierReader({ 'worker-round.jsonl': workerRound, 'worker-outcome.jsonl': workerOutcome }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  // Both phases really occur in one reading, so "always one state" cannot pass.
  const phaseByTask = new Map((snapshot.inFlight ?? []).map((task) => [task.taskId, task.phase]));
  assert.equal(phaseByTask.get('gap-fan-in-task'), 'fan-in');
  assert.equal(phaseByTask.get('gap-implementing-task'), 'implementing');
  assert.equal(snapshot.inFlight?.length, 2);
});

test('in-flight distinguishes "no reading" (null) from "nothing running" ([])', async () => {
  // (a) No `.quay/worker-round.jsonl` on disk → null (the carrier-level "did not read").
  const absent = createQuayService(createDependencies({
    runCommand: createDriverRunningRunner(),
    readFile: createCarrierReader({}),
  }));
  const absentSnapshot = await absent.getQuaySnapshot('project-1');
  assert.equal(absentSnapshot?.inFlight, null, 'a missing carrier is null, never []');

  // (b) The carrier reads but names no in-flight task → [] (a real "nothing running").
  const emptyRound = `${JSON.stringify({
    ts: '2026-10-07T00:00:00.000Z',
    pid: 999,
    in_flight_tasks: [],
    in_flight_task_starts: {},
  })}\n`;
  const empty = createQuayService(createDependencies({
    runCommand: createDriverRunningRunner(),
    readFile: createCarrierReader({ 'worker-round.jsonl': emptyRound }),
  }));
  const emptySnapshot = await empty.getQuaySnapshot('project-1');
  assert.deepEqual(emptySnapshot?.inFlight, [], 'a readable carrier with no in-flight task is [], never null');
  assert.notEqual(emptySnapshot?.inFlight, null);
});

/**
 * The reading is pinned to the shape a REAL `.quay/worker-round.jsonl` carries, read off
 * disk (2026-10-07): `writeRound` builds each record from camelCase options but persists
 * it through a snake_case projection (`ts`, `in_flight_tasks`, `in_flight_task_starts`).
 * This test is the guard against an implementation that only understands the option
 * spelling and would therefore read nothing in production.
 */
test('the in-flight reading understands the persisted snake_case worker-round shape', async () => {
  const workerRound = `${JSON.stringify({
    round: 412,
    run_id: 'r1',
    pid: 578_567,
    action: 'dispatch',
    ts: '2026-10-07T13:04:56.527Z',
    in_flight: 1,
    in_flight_tasks: ['gap-real-shape'],
    in_flight_task_starts: { 'gap-real-shape': '2026-10-07T13:00:00.000Z' },
    needs_human: [],
  })}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createDriverRunningRunner(),
    readFile: createCarrierReader({ 'worker-round.jsonl': workerRound }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.inFlight, [
    {
      taskId: 'gap-real-shape',
      phase: 'implementing',
      startedAt: '2026-10-07T13:00:00.000Z',
      lastHeartbeat: '2026-10-07T13:04:56.527Z',
      workerPid: 578_567,
    },
  ]);
});

/* ── Loop pulse: the window, the in-flight projection, and the kernel ───────────── */

test('normalizeGanttWindowHours accepts only the offered windows and falls back otherwise', () => {
  // The set is closed because the window drives how far back the history read goes: an
  // arbitrary value from a stray query param must not widen that read.
  for (const hours of [1, 3, 6, 12]) {
    assert.equal(normalizeGanttWindowHours(hours), hours);
    assert.equal(normalizeGanttWindowHours(String(hours)), hours);
  }

  for (const rejected of [0, -3, 2, 24, 1.5, '', 'abc', null, undefined, {}, []]) {
    assert.equal(
      normalizeGanttWindowHours(rejected),
      3,
      `${JSON.stringify(rejected)} is not an offered window, so it must read as the default`,
    );
  }
});

test('readInFlightRuns reports an unreadable payload as null, never as an empty run set', () => {
  // `null` and `[]` are different readings: `[]` means "the worker was asked and nothing is
  // in flight", `null` means "this payload does not answer the question". Collapsing them
  // would render a broken read as an idle board.
  assert.equal(readInFlightRuns(null), null);
  assert.equal(readInFlightRuns('nope'), null);
  assert.equal(readInFlightRuns({}), null);
  assert.equal(readInFlightRuns({ inFlight: 'nope' }), null);
  assert.deepEqual(readInFlightRuns({ inFlight: [] }), []);

  const runs = readInFlightRuns({
    inFlight: [
      { taskId: 't1', runId: 'r1', startedAtMs: 1_791_000_000_000, phase: 'implementing' },
      // Dropped: a run the kernel cannot place on a timeline is not a run we can draw.
      { taskId: 'no-start', runId: 'r2', phase: 'implementing' },
      { taskId: 'nan-start', runId: 'r3', startedAtMs: Number.NaN, phase: 'fan-in' },
      // Kept with an honest null phase rather than dropped: the run happened.
      { taskId: 't4', runId: 'r4', startedAtMs: 1_791_000_001_000 },
    ],
  });

  assert.deepEqual(runs, [
    { taskId: 't1', runId: 'r1', startedAtMs: 1_791_000_000_000, phase: 'implementing' },
    { taskId: 't4', runId: 'r4', startedAtMs: 1_791_000_001_000, phase: null },
  ]);
});

/** A throwaway project whose `.quay/plugin` pointer carries the given kernel source. */
function projectWithKernel(kernelSource: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quay-gantt-'));
  if (kernelSource !== null) {
    const dir = path.join(root, '.quay', 'plugin', 'vendor', 'quay', 'dist');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dashboard-kernel.js'), kernelSource, 'utf8');
  }
  return root;
}

const IN_FLIGHT_PAYLOAD = JSON.stringify({
  root: '/tmp',
  kind: 'worker',
  workerSignal: { evaluated: true, reason: null },
  inFlight: [{ taskId: 'live-run', runId: 'worker-live-run', startedAtMs: 1_791_000_000_000, phase: 'implementing' }],
});

test('the Loop pulse lanes are produced by the project’s own kernel, through its .quay/plugin pointer', async () => {
  // The stub stands in for quay's kernel so this case pins the WIRING — that the module is
  // resolved under <project>/.quay/plugin and its output is passed through untouched. The
  // real algorithm's semantics are pinned separately by the vector replay below.
  const root = projectWithKernel(
    'export function mergeLiveAndHistoryIntervals(inFlight, records, windowStartMs, nowMs) {'
    + ' return [{ taskId: inFlight[0].taskId, runId: inFlight[0].runId, startMs: windowStartMs, endMs: nowMs,'
    + ' phase: inFlight[0].phase, finalState: null, fanInOutcome: null }]; }'
    + ' export function packLanes(intervals, maxLanes = 5) { return { lanes: [intervals], overflow: 2 }; }',
  );

  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => root,
    runCommand: async (_cwd, args) => {
      const key = args.join(' ');
      return {
        ok: true,
        code: 0,
        stdout: key === 'driver live --kind worker --json' ? IN_FLIGHT_PAYLOAD : 'null',
        stderr: '',
      };
    },
    now: () => 1_791_000_600_000,
  }));

  const snapshot = await service.getQuaySnapshot('project-1', { forceRefresh: true });
  assert.ok(snapshot, 'the snapshot must load');
  assert.ok(snapshot.gantt, 'a project whose plugin carries the kernel must report lanes');

  assert.equal(snapshot.gantt.windowHours, 3);
  assert.equal(snapshot.gantt.nowMs, 1_791_000_600_000);
  assert.equal(snapshot.gantt.overflow, 2, 'the overflow count is passed through, never recomputed');
  assert.equal(snapshot.gantt.lanes.length, 1);
  assert.equal(snapshot.gantt.lanes[0][0].taskId, 'live-run');
});

test('a request for a non-default window is read at that window and is never answered from the default’s cache', async () => {
  const root = projectWithKernel(
    'export function mergeLiveAndHistoryIntervals(inFlight, records, windowStartMs, nowMs) {'
    + ' return [{ taskId: String((nowMs - windowStartMs) / 3600000), runId: "r", startMs: windowStartMs,'
    + ' endMs: nowMs, phase: null, finalState: null, fanInOutcome: null }]; }'
    + ' export function packLanes(intervals) { return { lanes: [intervals], overflow: 0 }; }',
  );

  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => root,
    runCommand: async (_cwd, args) => ({
      ok: true,
      code: 0,
      stdout: args.join(' ') === 'driver live --kind worker --json' ? IN_FLIGHT_PAYLOAD : 'null',
      stderr: '',
    }),
    now: () => 1_791_000_600_000,
  }));

  const defaulted = await service.getQuaySnapshot('project-1');
  const twelve = await service.getQuaySnapshot('project-1', { windowHours: '12' });
  const one = await service.getQuaySnapshot('project-1', { windowHours: '1' });

  // The stub echoes the window it was handed, so this reads the window each request actually
  // used — a cache keyed on the project alone would answer 12h with the 3h reading.
  assert.equal(defaulted?.gantt?.lanes[0][0].taskId, '3');
  assert.equal(twelve?.gantt?.lanes[0][0].taskId, '12');
  assert.equal(one?.gantt?.lanes[0][0].taskId, '1');
  assert.equal(twelve?.gantt?.windowHours, 12);
});

test('a project whose plugin carries no kernel reports no lanes, not an empty board', async () => {
  // `null` is the honest reading for "this project cannot answer": an empty lane set would
  // render as "nothing ran in this window", which is a different claim.
  const root = projectWithKernel(null);

  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => root,
    runCommand: async (_cwd, args) => ({
      ok: true,
      code: 0,
      stdout: args.join(' ') === 'driver live --kind worker --json' ? IN_FLIGHT_PAYLOAD : 'null',
      stderr: '',
    }),
    now: () => 1_791_000_600_000,
  }));

  const snapshot = await service.getQuaySnapshot('project-1', { forceRefresh: true });

  assert.equal(snapshot?.gantt, null);
  // A plugin older than the read is a normal state for an un-upgraded project, not a fault of
  // this panel — so it must not pepper the warnings banner.
  assert.deepEqual(snapshot?.warnings, []);
});

/* ── cross-project equivalence: replay quay's own vectors through the shipped kernel ── */

/**
 * The contract test the kernel was published for: replay quay's own vectors through the
 * kernel THIS project's plugin ships, and require byte-identical lane assignment and
 * overflow. It is the only evidence that the card runs quay's algorithm rather than a
 * look-alike — the panel re-derives nothing, so what remains to prove is that the module it
 * loads is the same one quay's dashboard plots.
 *
 * Reads the plugin through the project's own `.quay/plugin` pointer, so it exercises the
 * same resolution the collector uses at runtime. Skips (loudly) where no plugin is
 * installed — on a machine without one there is genuinely nothing to replay, and a silent
 * pass would claim a verification that never ran.
 */
test('the project’s installed kernel reproduces quay’s published equivalence vectors', async (t) => {
  const kernelPath = path.join(
    process.cwd(),
    '.quay',
    'plugin',
    'vendor',
    'quay',
    'dist',
    'dashboard-kernel.js',
  );
  const vectorsPath = path.join(path.dirname(kernelPath), 'dashboard-kernel-vectors.json');

  if (!fs.existsSync(kernelPath) || !fs.existsSync(vectorsPath)) {
    t.skip(`no installed quay plugin with a dashboard-kernel at ${kernelPath}`);
    return;
  }

  const kernel = (await import(pathToFileURL(kernelPath).href)) as {
    mergeLiveAndHistoryIntervals: (i: unknown, r: unknown, w: number, n: number) => unknown;
    packLanes: (intervals: unknown) => unknown;
  };
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')) as {
    kernelVersion: string;
    vectors: Array<{
      name: string;
      input: { inFlight: unknown; records: unknown; windowStartMs: number; nowMs: number };
      expectedMerged: unknown;
      expectedLanes: unknown;
    }>;
  };

  assert.ok(vectors.vectors.length > 0, 'the vector file must carry at least one vector');

  for (const vector of vectors.vectors) {
    const { inFlight, records, windowStartMs, nowMs } = vector.input;
    const merged = kernel.mergeLiveAndHistoryIntervals(inFlight, records, windowStartMs, nowMs);
    assert.deepEqual(merged, vector.expectedMerged, `${vector.name}: merged intervals differ from quay's`);
    assert.deepEqual(
      kernel.packLanes(merged),
      vector.expectedLanes,
      `${vector.name}: lane assignment or overflow differs from quay's`,
    );
  }

  console.log(`[quay-gantt] replayed ${vectors.vectors.length} vectors from kernel ${vectors.kernelVersion}`);
});
