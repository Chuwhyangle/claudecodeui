import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { createQuayService } from '../service/index.js';
import {
  isReadOnlyQuayCommand,
  normalizeGanttWindowHours,
  readGanttLanes,
  type QuayCommandResult,
  type QuayCommandRunner,
  type QuayFileReader,
} from '../read/index.js';
import { QUAY_COMMAND_TIMEOUT_MS, QUAY_DRIVER_STATUS_TIMEOUT_MS } from '../quay-process.js';

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
 * Lets every pending promise callback run: a background index load is fire-and-forget, so a test
 * that asked for one must give its async continuation a chance to land before reading the index.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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
  // The Tests and Fan-in readings now come from quay's own verbs (0.24.0), not from parsing
  // the project's `.quay/` carrier files here.
  'driver log --kind worker --json --limit 300',
  'driver status --kind worker --json',
  'goal list --json',
  // The Loop pulse card's lanes. `lanes` is the read-only verb that merges in-flight runs with
  // worker-outcome history and packs them onto the fixed five lanes itself, so the snapshot
  // relays its document instead of spawning `driver live` and packing locally. `--json` leads
  // on purpose: quay's dispatcher eats the token after the verb as a sub-command (see
  // `QUAY_LANES_PREFIX`), so a window written first would never reach the flag parser.
  'lanes --json --window-hours 3',
  'suite --json --limit 300',
  'task list --json --no-body',
];

/** A runner that answers each whitelisted read-only command with a fixture JSON document. */
function createFixtureRunner(
  counter: { calls: number; commands?: string[] },
  overrides: Record<string, unknown> = {},
): QuayCommandRunner {
  const responses: Record<string, unknown> = {
    'task list --json --no-body': [
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
    ...overrides,
  };

  return async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    counter.calls += 1;
    const key = args.join(' ');
    counter.commands?.push(key);
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

test('the compact status index argv is whitelisted, and whitelisted only exactly', async () => {
  // AC-348 (g): the index reader behind `changes` runs `task list --json --no-body`,
  // the one widening this table has taken — as a SEPARATE exact-match entry, so
  // the new flag is admitted for this command and no other. Every neighbour below
  // is refused by equality, before a child process could exist.
  const spawned: string[][] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (cwd: string, args: readonly string[]) => {
      spawned.push([cwd, ...args]);
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  assert.equal(isReadOnlyQuayCommand(['task', 'list', '--json', '--no-body']), true);
  const result = await service.runQuayCommand(PROJECT_PATH, ['task', 'list', '--json', '--no-body']);
  assert.equal(result.ok, true);
  assert.deepEqual(spawned, [[PROJECT_PATH, 'task', 'list', '--json', '--no-body']]);

  const refused = [
    // Without `--json`: a different command, not a shorter spelling of this one.
    ['task', 'list', '--no-body'],
    // Flags in the other order.
    ['task', 'list', '--no-body', '--json'],
    // The read-only prefix plus anything at all.
    ['task', 'list', '--json', '--no-body', '--inject'],
    ['task', 'list', '--json', '--no-body', 'gap-x'],
    // `--no-body` must not turn into a general-purpose flag on other reads.
    ['adr', 'list', '--json', '--no-body'],
    ['task', 'get', 'gap-x', '--no-body'],
  ];
  for (const args of refused) {
    assert.equal(isReadOnlyQuayCommand(args), false, `${args.join(' ')} must not be whitelisted`);
    const denied = await service.runQuayCommand(PROJECT_PATH, args);
    assert.equal(denied.ok, false, `expected refusal for: ${args.join(' ')}`);
    assert.match(denied.error ?? '', /whitelist/);
  }
  assert.equal(spawned.length, 1, 'only the exact index argv may reach the subprocess runner');
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

test('the snapshot reads the compact task list and still projects counts, recents and blockers', async () => {
  // The payload deliberately carries NO `body` field on any record — exactly what
  // `task list --json --no-body` prints. Everything the panel shows from the task ledger must
  // still be derivable from it.
  const tasks = [
    { id: 'gap-a', title: 'A', status: 'ready', updatedAt: 300 },
    { id: 'gap-b', title: 'B', status: 'done', updatedAt: 100 },
    { id: 'gap-nh', title: 'NH', status: 'needs-human', updatedAt: 200 },
    { id: 'gap-wait', title: 'Wait', status: 'todo', updatedAt: 50 },
  ];
  const taskArgvs: string[][] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args[0] === 'task' && args[1] === 'list') {
        taskArgvs.push([...args]);
      }
      return {
        ok: true,
        code: 0,
        stdout: args.join(' ') === 'task list --json --no-body' ? JSON.stringify(tasks) : '[]',
        stderr: '',
      };
    },
    // `depends_on` lives only in the task file's frontmatter, so the blocked row's impact side
    // still comes from the store — the compact CLI reading is not expected to carry it.
    readFile: createFileReader({
      readText: async (filePath: string) => {
        if (filePath === path.join(PROJECT_PATH, 'tasks', 'gap-wait.md')) {
          return '---\ndepends_on: [gap-nh]\n---\n\nwaiting on the human decision\n';
        }
        throw new Error('ENOENT');
      },
    }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  // The one argv the snapshot's task read may use: the whole array, without bodies.
  assert.deepEqual(taskArgvs, [['task', 'list', '--json', '--no-body']]);

  assert.equal(snapshot.tasks?.total, 4);
  assert.deepEqual(snapshot.tasks?.byStatus, {
    ready: 1,
    done: 1,
    'needs-human': 1,
    todo: 1,
  });
  assert.equal(snapshot.tasks?.ready, 1);
  assert.equal(snapshot.tasks?.needsHuman, 1);
  assert.equal(snapshot.tasks?.done, 1);

  // Recents are ranked by `updatedAt` and carry the same four displayed fields as before.
  assert.deepEqual(snapshot.tasks?.recent, [
    { id: 'gap-a', title: 'A', status: 'ready', updatedAt: new Date(300).toISOString() },
    { id: 'gap-nh', title: 'NH', status: 'needs-human', updatedAt: new Date(200).toISOString() },
    { id: 'gap-b', title: 'B', status: 'done', updatedAt: new Date(100).toISOString() },
    { id: 'gap-wait', title: 'Wait', status: 'todo', updatedAt: new Date(50).toISOString() },
  ]);

  // The blocked row survives the compact read: the needs-human task is the obstruction and the
  // unfinished dependent (whose edge came from its store file) is its impact.
  assert.deepEqual(snapshot.blockers, [{
    taskId: 'gap-nh',
    since: new Date(200).toISOString(),
    signature: 'needs-human',
    occurrences: 1,
    dependents: ['gap-wait'],
  }]);
});

test('the driver-status read takes its own injected ceiling, wider than the shared per-command bound', async () => {
  const seen: { command: string; timeoutMs: number }[] = [];
  const service = createQuayService(createDependencies({
    commandTimeoutMs: QUAY_COMMAND_TIMEOUT_MS,
    driverStatusTimeoutMs: QUAY_DRIVER_STATUS_TIMEOUT_MS,
    runCommand: async (_cwd: string, args: readonly string[], options): Promise<QuayCommandResult> => {
      seen.push({ command: args.join(' '), timeoutMs: options.timeoutMs });
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  await service.getQuaySnapshot('project-1');

  const timeoutsFor = (command: string): number[] => [
    ...new Set(seen.filter((call) => call.command === command).map((call) => call.timeoutMs)),
  ];

  // Both bounds are the values handed in through dependencies — no constant read at the call
  // site and no wall-clock measurement: the stub records what each spawn received.
  assert.deepEqual(timeoutsFor('task list --json --no-body'), [QUAY_COMMAND_TIMEOUT_MS]);
  assert.deepEqual(timeoutsFor('driver status --kind worker --json'), [QUAY_DRIVER_STATUS_TIMEOUT_MS]);
  // Every other read keeps the shared default.
  assert.deepEqual(timeoutsFor('goal list --json'), [QUAY_COMMAND_TIMEOUT_MS]);
  // The driver read is the structurally expensive one, so its ceiling must be the wider bound.
  assert.ok(
    QUAY_DRIVER_STATUS_TIMEOUT_MS > QUAY_COMMAND_TIMEOUT_MS,
    'the driver-status ceiling must be strictly wider than the shared per-command bound',
  );
});

test('a partial snapshot is not cached, a complete one is, and entrypoint warnings do not make it partial', async () => {
  // (a) A single failed section (task list timeout) must NOT populate the TTL cache: the very
  // next open inside the TTL re-spawns instead of serving the same hole as `cached: true`.
  let nowMs = 0;
  const failedTaskSpawns: string[][] = [];
  const failing = createQuayService(createDependencies({
    now: () => nowMs,
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args[0] === 'task' && args[1] === 'list') {
        failedTaskSpawns.push([...args]);
        return {
          ok: false,
          code: null,
          stdout: '',
          stderr: '',
          error: 'quay command timed out: killed',
          failureKind: 'timeout',
        };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const first = await failing.getQuaySnapshot('project-1');
  assert.equal(first?.tasks, null, 'a timed-out task read is not a task ledger');
  assert.equal(first?.cached, false);
  assert.ok(
    first?.warnings.some((warning) => warning.includes('task list --json --no-body') && warning.includes('timeout')),
    `expected the task-list timeout to be surfaced, saw: ${String(first?.warnings)}`,
  );
  const spawnsAfterFirst = failedTaskSpawns.length;

  nowMs += 1_000; // still well inside the 30 s TTL
  const second = await failing.getQuaySnapshot('project-1');
  assert.equal(second?.cached, false, 'a partial reading must never be reported as cached');
  assert.equal(
    failedTaskSpawns.length,
    spawnsAfterFirst + 1,
    'a partial reading must be re-read on the next open, not served from the TTL',
  );

  // (b) With every section read, the same TTL window serves the cached reading and spawns nothing.
  let healthyNow = 0;
  const counter = { calls: 0, commands: [] as string[] };
  const healthy = createQuayService(createDependencies({
    now: () => healthyNow,
    runCommand: createFixtureRunner(counter),
  }));
  const cold = await healthy.getQuaySnapshot('project-1');
  assert.equal(cold?.cached, false);
  const callsAfterCold = counter.calls;
  assert.ok(callsAfterCold > 0);
  healthyNow += 1_000;
  const warm = await healthy.getQuaySnapshot('project-1');
  assert.equal(warm?.cached, true);
  assert.equal(counter.calls, callsAfterCold, 'a complete TTL reading spawns no CLI');

  // (c) An entrypoint diagnostic (skipped plugin record / bare-PATH fallback) is NOT a failed
  // read, so it must still cache: otherwise every open would pay a full pass for a warning.
  let warningNow = 0;
  const warningCounter = { calls: 0 };
  const warned = createQuayService(createDependencies({
    now: () => warningNow,
    runCommand: createFixtureRunner(warningCounter),
    resolveEntrypoint: () => ({
      path: path.join(path.sep, 'opt', 'quay', 'bin', 'quay'),
      version: '0.31.1',
      source: 'path',
      warning: 'no project record; falling back to the bare PATH command',
    }),
  }));
  const warnedCold = await warned.getQuaySnapshot('project-1');
  assert.equal(warnedCold?.cached, false);
  assert.ok(warnedCold?.warnings.some((warning) => warning.includes('falling back to the bare PATH command')));
  const warnedCalls = warningCounter.calls;
  warningNow += 1_000;
  const warnedWarm = await warned.getQuaySnapshot('project-1');
  assert.equal(warnedWarm?.cached, true, 'an entrypoint warning alone must not suppress caching');
  assert.equal(warningCounter.calls, warnedCalls, 'the cached reading spawned nothing');
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

test('getQuaySnapshot reports the resolved entrypoint diagnostic without widening the driver summary', async () => {
  const counter = { calls: 0 };
  const resolvedPath = path.join(
    path.sep, 'home', 'tester', '.claude', 'plugins', 'cache', 'quay', 'quay', '0.22.0', 'bin', 'quay',
  );
  const service = createQuayService(createDependencies({
    runCommand: createFixtureRunner(counter),
    resolveEntrypoint: () => ({
      path: resolvedPath,
      version: '0.22.0',
      source: 'user',
      warning: 'a higher-priority project record no longer exists; using the user record.',
    }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');

  assert.deepEqual(snapshot?.entrypoint, {
    path: resolvedPath,
    version: '0.22.0',
    source: 'user',
  });
  // The resolver's warning is a real diagnostic and travels in the snapshot's warning banner.
  assert.deepEqual(snapshot?.warnings, [
    'a higher-priority project record no longer exists; using the user record.',
  ]);
  // The increment must not widen the driver summary/state — the panel's existing contract.
  assert.deepEqual(Object.keys(snapshot?.driver ?? {}).sort(), ['alive', 'lastRecordAt', 'running', 'state']);
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
 * The task ledger's counts are an aggregate of the WHOLE task array, and the collector must keep
 * asking for that whole array (dropping only each record's `body`): the paginated `--json` is a
 * bare array carrying no total, so paging would silently turn a real ledger ("2583 tasks") into
 * the page size ("10 tasks"). The reading is load-bearing, so the argv is pinned to prove the
 * collector does not — and must not — ask for a page.
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
      return { ok: true, code: 0, stdout: key === 'task list --json --no-body' ? JSON.stringify(tasks) : '[]', stderr: '' };
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
  // (and the paginated `--json` carries no total to count from). The body is dropped because
  // nothing in this projection reads it; the array itself is complete.
  assert.deepEqual(taskListArgv, [['task', 'list', '--json', '--no-body']]);
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
      if (key === 'task list --json --no-body') {
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
      if (args.join(' ') === 'task list --json --no-body') {
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
      if (key === 'task list --json --no-body') return { ok: true, code: 0, stdout: JSON.stringify(tasks), stderr: '' };
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

// The bounded-tail reader and the suite-state projector that used to live in this service are
// gone: the Tests and Fan-in readings are now taken through quay's `suite` / `driver log` verbs
// (see `quay-suite-fanin-reader.test.ts`), and this service no longer parses those carriers.
// `readLastCarrierRecord` still streams the worker-round heartbeat's tail, which the in-flight
// cases below exercise end to end.

test('getQuaySnapshot projects the Tests and Fan-in cards and drops the heavy round detail', async () => {
  // The two documents the reader relays. The heavy `perFile` detail the old carrier carried is
  // absent from the verb's document by design, and an attempt without `mechanical_fan_in` is
  // dropped rather than projected as an empty row.
  const suiteDocument = {
    current: {
      state: 'green',
      runner: 'inner',
      scope: 'worktree',
      startedAt: '2026-10-03T06:58:14.072Z',
      // ISO in the verb's output; the adapter converts it back to the epoch SECONDS the
      // `QuaySuiteState` contract has always carried.
      finishedAt: '2026-10-03T07:01:30.890Z',
      durationMs: 196_837,
      laneCount: 127,
      commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
      taskId: 'gap-x',
      runId: 'r1',
    },
    rounds: [
      {
        round: 7,
        startedAt: '2026-10-03T01:00:00.000Z',
        durationMs: 12_000,
        pass: 4,
        fail: 1,
        state: 'red',
        perFile: [{ file: 'a.test.ts', detail: 'x'.repeat(5_000) }],
      },
      {
        round: 8,
        startedAt: '2026-10-03T02:00:00.000Z',
        durationMs: 9_000,
        pass: 5,
        fail: 0,
        state: 'green',
        perFile: [],
      },
    ],
    carrier: {
      state: 'ok',
      reason: null,
      suiteState: { state: 'ok', reason: null },
      rounds: { state: 'ok', reason: null, bytesRead: 4096, exhausted: false },
    },
    evaluated: true,
  };
  const driverLogDocument = {
    attempts: [
      {
        task: 'gap-a',
        mechanical_fan_in: { outcome: 'landed', lockAcquireEpoch: 1_791_003_441, lockReleaseEpoch: 1_791_003_657 },
      },
      // No mechanical_fan_in block: the task never reached fan-in, so it is filtered out.
      { task: 'gap-b' },
      {
        task: 'gap-c',
        mechanical_fan_in: { outcome: 'failed', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
      },
    ],
    status: 'ok',
    reason: null,
  };

  const service = createQuayService(createDependencies({
    runCommand: async (_cwd, args): Promise<QuayCommandResult> => {
      const key = args.join(' ');
      if (key === 'suite --json --limit 300') {
        return { ok: true, code: 0, stdout: JSON.stringify(suiteDocument), stderr: '' };
      }
      if (key === 'driver log --kind worker --json --limit 300') {
        return { ok: true, code: 0, stdout: JSON.stringify(driverLogDocument), stderr: '' };
      }
      return {
        ok: true,
        code: 0,
        stdout: key === 'goal list --json'
          ? JSON.stringify([
              { id: 'GOAL-1', status: 'achieved', updatedAt: 2 },
              { id: 'GOAL-2', status: 'active', updatedAt: 1 },
              { id: 'GOAL-3', status: 'active', updatedAt: 3 },
            ])
          : '[]',
        stderr: '',
      };
    },
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
    // `quay suite`'s rounds carry no `tests` count; the shape keeps the field as `null`.
    { round: 7, startedAt: '2026-10-03T01:00:00.000Z', durationMs: 12_000, pass: 4, fail: 1, tests: null, state: 'red' },
    { round: 8, startedAt: '2026-10-03T02:00:00.000Z', durationMs: 9_000, pass: 5, fail: 0, tests: null, state: 'green' },
  ]);
  assert.equal('perFile' in (snapshot.tests.recentRounds[0] as object), false, 'the heavy per-file detail must be dropped');

  assert.deepEqual(snapshot.fanIn.recent, [
    { task: 'gap-a', outcome: 'landed', lockAcquireEpoch: 1_791_003_441, lockReleaseEpoch: 1_791_003_657 },
    { task: 'gap-c', outcome: 'failed', lockAcquireEpoch: 1_791_010_000, lockReleaseEpoch: null },
  ]);

  // Both verbs answered with `ok` carriers, so the panel draws the readings rather than a
  // "failed to read" line.
  assert.deepEqual(snapshot.carrierReadings, {
    suite: { state: 'ok', reason: null },
    fanIn: { state: 'ok', reason: null },
  });

  // Stage goals breakdown groups by status and orders the recent rows newest first.
  assert.deepEqual(snapshot.goals?.breakdown.byStatus, { achieved: 1, active: 2 });
  assert.deepEqual(snapshot.goals?.breakdown.recent.map((goal) => goal.id), ['GOAL-3', 'GOAL-1', 'GOAL-2']);

  // A failed/absent carrier reading is reported through `carrierReadings`, never as a warning.
  assert.deepEqual(snapshot.warnings, []);
});

test('the Tests and Fan-in read verbs are whitelisted, and only their exact argv', async () => {
  const spawned: string[] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      spawned.push(args.join(' '));
      return { ok: true, code: 0, stdout: '{}', stderr: '' };
    },
  }));

  for (const args of [
    ['suite', '--json', '--limit', '300'],
    ['driver', 'log', '--kind', 'worker', '--json', '--limit', '300'],
  ]) {
    assert.equal(isReadOnlyQuayCommand(args), true, `${args.join(' ')} must be whitelisted`);
    const result = await service.runQuayCommand(PROJECT_PATH, args);
    assert.equal(result.ok, true);
  }
  assert.deepEqual(spawned, [
    'suite --json --limit 300',
    'driver log --kind worker --json --limit 300',
  ]);

  const refused = [
    // The window is part of the reading: another limit is another command, not this one.
    ['suite', '--json', '--limit', '301'],
    ['suite', '--json', '--limit'],
    // Without `--json` the verb prints its human-readable form.
    ['suite', '--limit', '300'],
    ['suite', '--json', '--limit', '300', '--since', '2026-10-01T00:00:00Z'],
    // Another driver kind is a different log, not a flag on this one.
    ['driver', 'log', '--kind', 'promotion', '--json', '--limit', '300'],
    ['driver', 'log', '--kind', 'worker', '--limit', '300'],
    ['driver', 'log', '--json', '--kind', 'worker', '--limit', '300'],
    ['driver', '--json', '--limit', '300'],
  ];
  for (const args of refused) {
    assert.equal(isReadOnlyQuayCommand(args), false, `${args.join(' ')} must not be whitelisted`);
    const denied = await service.runQuayCommand(PROJECT_PATH, args);
    assert.equal(denied.ok, false, `expected refusal for: ${args.join(' ')}`);
    assert.match(denied.error ?? '', /whitelist/);
  }
  assert.equal(spawned.length, 2, 'only the two exact verb argv may reach the subprocess runner');
});

test('one project’s Tests / Fan-in reading is spawned once for the snapshot and the fleet summary', async () => {
  const seen: string[] = [];
  const service = createQuayService(createDependencies({
    // The fleet summary only considers projects with a `.quay/config.yml`.
    fileExists: () => true,
    listProjects: () => [{ projectId: 'project-1', projectPath: PROJECT_PATH }],
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      const key = args.join(' ');
      seen.push(key);
      if (key === 'suite --json --limit 300') {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({ current: null, rounds: [], carrier: { state: 'absent', reason: 'no suite state yet' } }),
          stderr: '',
        };
      }
      if (key === 'driver log --kind worker --json --limit 300') {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({ attempts: [], status: 'absent', reason: 'no worker history yet' }),
          stderr: '',
        };
      }
      return { ok: true, code: 0, stdout: '[]', stderr: '' };
    },
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);
  const fleet = await service.getFleetSummary();
  assert.equal(fleet.projects.length, 1);

  const count = (command: string) => seen.filter((entry) => entry === command).length;
  // The snapshot cached the pair; the fleet summary's pulse row served the same reading
  // inside the TTL instead of spawning a second pair.
  assert.equal(count('suite --json --limit 300'), 1);
  assert.equal(count('driver log --kind worker --json --limit 300'), 1);
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

/** The `now` instant the lane fixtures below are read at — one fixed clock for every case. */
const LANES_NOW_MS = 1_791_000_600_000;

/**
 * A runner answering `driver status` as running and the `lanes` verb with the given document —
 * the Loop pulse reading the In-flight card is now derived from. Every other whitelisted verb
 * answers `[]`. A caller that wants "the lanes verb could not be read" passes the bare
 * `createDriverRunningRunner` instead (its `lanes` answer, `[]`, is not a lane document).
 */
function createLanesRunner(lanesDocument: unknown): QuayCommandRunner {
  return async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    const key = args.join(' ');
    if (key === 'driver status --kind worker --json') {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ alive: 1, running: 1, last_record_ts: '2026-10-07T00:00:00.000Z' }),
        stderr: '',
      };
    }
    if (key === 'lanes --json --window-hours 3') {
      return { ok: true, code: 0, stdout: JSON.stringify(lanesDocument), stderr: '' };
    }
    return { ok: true, code: 0, stdout: '[]', stderr: '' };
  };
}

/**
 * One `quay lanes --json` document carrying a single lane of the given intervals — the packed
 * `LiveGanttInterval` rows the installed verb prints, so the service relays them verbatim.
 * `phase` non-null marks an in-flight interval; `finalState` non-null marks a finished one
 * (exactly one side non-null, as quay's kernel keeps them).
 */
function lanesDocument(
  intervals: ReadonlyArray<{ taskId: string; phase: string | null; startMs?: number }>,
): unknown {
  return {
    windowHours: 3,
    nowMs: LANES_NOW_MS,
    lanes: [
      intervals.map((interval) => ({
        taskId: interval.taskId,
        runId: `run-${interval.taskId}`,
        startMs: interval.startMs ?? LANES_NOW_MS - 600_000,
        endMs: LANES_NOW_MS,
        phase: interval.phase,
        finalState: interval.phase === null ? 'done' : null,
        fanInOutcome: null,
      })),
    ],
    overflow: 0,
  };
}

/** The in-flight task ids of a snapshot's gantt reading — its intervals whose `phase` is non-null. */
function ganttInFlightTaskIds(gantt: { lanes: Array<Array<{ taskId: string; phase: string | null }>> } | null | undefined): string[] {
  if (!gantt) {
    return [];
  }
  return gantt.lanes.flat().filter((interval) => interval.phase !== null).map((interval) => interval.taskId);
}

/**
 * The In-flight card names the SAME task set the Loop pulse gantt is plotted from: both are
 * projections of one `lanes` reading (quay's `readLive`, which drops already-landed tasks), so
 * the two can never disagree about which tasks are running. The round carrier is consulted only
 * for the fields the lanes do not carry — the ISO dispatch instant, the heartbeat and the pid.
 *
 * Before this task the card projected `.quay/worker-round.jsonl` directly, so a round whose task
 * had since landed still showed as in-flight; that divergence is what this reading removes.
 */
test('getQuaySnapshot reads the in-flight task from the same lanes reading as the gantt', async () => {
  // A real carrier still naming the task by id; the started/pid/heartbeat fields are the ones
  // the lanes reading cannot supply.
  const workerRound = `${JSON.stringify({
    at: '2026-10-07T00:00:00.000Z',
    pid: 4242,
    inFlightTasks: ['gap-example-task'],
    inFlightTaskStarts: { 'gap-example-task': '2026-10-06T23:50:00.000Z' },
  })}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createLanesRunner(lanesDocument([{ taskId: 'gap-example-task', phase: 'implementing' }])),
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

  // The in-flight reading, with the carrier supplying the instant, heartbeat and pid.
  assert.deepEqual(snapshot.inFlight, [
    {
      taskId: 'gap-example-task',
      phase: 'implementing',
      startedAt: '2026-10-06T23:50:00.000Z',
      lastHeartbeat: '2026-10-07T00:00:00.000Z',
      workerPid: 4242,
    },
  ]);
  // The positive control: the task id now appears in the serialized snapshot.
  assert.ok(
    JSON.stringify(snapshot).includes('gap-example-task'),
    'the in-flight task id must reach the serialized snapshot',
  );
});

test('the In-flight card relays each task’s phase from the lanes reading', async () => {
  const workerRound = `${JSON.stringify({
    ts: '2026-10-07T00:00:00.000Z',
    pid: 999,
    in_flight_tasks: ['gap-fan-in-task', 'gap-implementing-task'],
    in_flight_task_starts: {
      'gap-fan-in-task': '2026-10-06T23:00:00.000Z',
      'gap-implementing-task': '2026-10-06T23:30:00.000Z',
    },
  })}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createLanesRunner(lanesDocument([
      { taskId: 'gap-fan-in-task', phase: 'fan-in' },
      { taskId: 'gap-implementing-task', phase: 'implementing' },
    ])),
    readFile: createCarrierReader({ 'worker-round.jsonl': workerRound }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  // Both phases really occur in one reading, so "always one state" cannot pass.
  const phaseByTask = new Map((snapshot.inFlight ?? []).map((task) => [task.taskId, task.phase]));
  assert.equal(phaseByTask.get('gap-fan-in-task'), 'fan-in');
  assert.equal(phaseByTask.get('gap-implementing-task'), 'implementing');
  assert.equal(snapshot.inFlight?.length, 2);
});

test('in-flight distinguishes "no lane reading" (null) from "nothing running" ([])', async () => {
  // (a) The `lanes` verb could not be read (a plugin predating it, or a non-zero exit) → null:
  // with no lane set there is no authoritative in-flight set to name.
  const absent = createQuayService(createDependencies({
    runCommand: createDriverRunningRunner(),
    readFile: createCarrierReader({}),
  }));
  const absentSnapshot = await absent.getQuaySnapshot('project-1');
  assert.equal(absentSnapshot?.inFlight, null, 'no lane reading is null, never []');
  assert.equal(absentSnapshot?.gantt, null);

  // (b) The lane reading is taken but holds no in-flight interval → [] (a real "nothing running").
  // The one interval is finished (`phase: null`), so the gantt has a bar but nothing is live.
  const idle = createQuayService(createDependencies({
    runCommand: createLanesRunner(lanesDocument([{ taskId: 'gap-finished-task', phase: null }])),
    readFile: createCarrierReader({}),
  }));
  const idleSnapshot = await idle.getQuaySnapshot('project-1');
  assert.deepEqual(idleSnapshot?.inFlight, [], 'a readable lane set with no in-flight interval is [], never null');
  assert.notEqual(idleSnapshot?.inFlight, null);
  assert.ok(idleSnapshot?.gantt, 'the lane reading itself is present');
});

/**
 * The reading is pinned to the shape a REAL `.quay/worker-round.jsonl` carries, read off
 * disk (2026-10-07): `writeRound` builds each record from camelCase options but persists
 * it through a snake_case projection (`ts`, `in_flight_task_starts`). The task SET now comes
 * from the lanes reading; the round carrier supplies the supplemental `startedAt`,
 * `lastHeartbeat` and `workerPid`, so this test guards that the persisted snake_case spelling
 * of those three is understood (an implementation that only read the camelCase option spelling
 * would fall back to the lane clock and the interval start here).
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
    runCommand: createLanesRunner(lanesDocument([{ taskId: 'gap-real-shape', phase: 'implementing' }])),
    readFile: createCarrierReader({ 'worker-round.jsonl': workerRound }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.inFlight, [
    {
      taskId: 'gap-real-shape',
      phase: 'implementing',
      // From the round's `in_flight_task_starts` — NOT the lane's own start (the fixture's
      // default is a different instant), which is what proves the snake_case field was read.
      startedAt: '2026-10-07T13:00:00.000Z',
      lastHeartbeat: '2026-10-07T13:04:56.527Z',
      workerPid: 578_567,
    },
  ]);
});

/**
 * When there is a lane reading but no round carrier, the card still names the right task set —
 * the reader is not the round carrier any more. The fields the carrier would have supplied fall
 * back to the lane reading itself: `startedAt` to the interval's own start, `lastHeartbeat` to
 * the instant the lane set was read (which never reads as stale), and `workerPid` to null.
 */
test('without a worker-round carrier the card falls back to the lane clock and the interval start', async () => {
  const service = createQuayService(createDependencies({
    runCommand: createLanesRunner(lanesDocument([
      { taskId: 'gap-lane-only', phase: 'awaiting-land', startMs: LANES_NOW_MS - 120_000 },
    ])),
    readFile: createCarrierReader({}),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.deepEqual(snapshot?.inFlight, [
    {
      taskId: 'gap-lane-only',
      phase: 'awaiting-land',
      startedAt: new Date(LANES_NOW_MS - 120_000).toISOString(),
      lastHeartbeat: new Date(LANES_NOW_MS).toISOString(),
      workerPid: null,
    },
  ]);
});

/**
 * AC1 (gap-quay-tab-inflight-card-and-gantt-two-sources): the In-flight card and the Loop pulse
 * gantt must name the SAME in-flight set, and a landed task must be in neither.
 *
 * The round carrier here is STALE — it still lists a task that has since landed next to the one
 * still running — while the lanes reading (quay's `readLive`) has already dropped that task to a
 * finished interval (`phase: null`). A card that projected the round carrier would list the
 * landed task; the card that takes the lanes reading does not. This is the 取假: reverting the
 * card to project the round carrier directly reds `deepEqual(inFlightIds, ['gap-running-task'])`.
 */
test('the In-flight card and the Loop pulse gantt name the same set — a landed task is in neither', async () => {
  const workerRound = `${JSON.stringify({
    ts: '2026-10-07T00:00:00.000Z',
    pid: 4242,
    in_flight_tasks: ['gap-landed-task', 'gap-running-task'],
    in_flight_task_starts: {
      'gap-landed-task': '2026-10-06T22:00:00.000Z',
      'gap-running-task': '2026-10-06T23:50:00.000Z',
    },
  })}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createLanesRunner(lanesDocument([
      // The landed task is now a finished interval — no `phase`, just a `finalState`.
      { taskId: 'gap-landed-task', phase: null, startMs: LANES_NOW_MS - 7_200_000 },
      { taskId: 'gap-running-task', phase: 'implementing' },
    ])),
    readFile: createCarrierReader({ 'worker-round.jsonl': workerRound }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  const inFlightIds = (snapshot.inFlight ?? []).map((task) => task.taskId).sort();
  const ganttIds = ganttInFlightTaskIds(snapshot.gantt).sort();

  // The two readings name exactly the same in-flight set...
  assert.deepEqual(inFlightIds, ganttIds, 'the card and the gantt must name the same in-flight set');
  assert.deepEqual(inFlightIds, ['gap-running-task']);
  // ...and neither names the landed task the stale carrier still lists.
  assert.ok(!inFlightIds.includes('gap-landed-task'), 'the landed task must not appear as in-flight in the card');
  assert.ok(!ganttIds.includes('gap-landed-task'), 'the landed interval carries no phase, so it is not in-flight');
});

/**
 * AC1's same-source rule must survive a window switch, not just the default reading. A
 * non-default window reuses the fresh default snapshot for every window-independent section and
 * re-reads only the lanes — but the In-flight card is a projection of those lanes, so leaving it
 * at the base snapshot's reading would hand back a card (default window) and a gantt (requested
 * window) that name different in-flight sets, re-opening the very contradiction this reading
 * removes. 取假: reusing `base.snapshot.inFlight` in the window-change path reds the deepEqual
 * below (`['default-window-task']` vs `['twelve-window-task']`).
 */
test('a window change re-derives the In-flight card from the new window’s lanes, never the base reading', async () => {
  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
      if (args[0] !== 'lanes') {
        return { ok: true, code: 0, stdout: '[]', stderr: '' };
      }
      const windowHours = Number(args[args.indexOf('--window-hours') + 1]);
      // One running task per window, named after the window, so a stale card is visible: the
      // base reading names `default-window-task`, the 12h reading names `twelve-window-task`.
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          windowHours,
          nowMs: LANES_NOW_MS,
          overflow: 0,
          lanes: [[{
            taskId: `${windowHours === 3 ? 'default' : 'twelve'}-window-task`,
            runId: 'r',
            startMs: LANES_NOW_MS - 600_000,
            endMs: LANES_NOW_MS,
            phase: 'implementing',
            finalState: null,
            fanInOutcome: null,
          }]],
        }),
        stderr: '',
      };
    },
    readFile: createCarrierReader({}),
    now: () => LANES_NOW_MS,
  }));

  const base = await service.getQuaySnapshot('project-1');
  assert.deepEqual((base?.inFlight ?? []).map((task) => task.taskId), ['default-window-task']);

  const twelve = await service.getQuaySnapshot('project-1', { windowHours: '12' });
  assert.ok(twelve);
  const cardIds = (twelve.inFlight ?? []).map((task) => task.taskId).sort();
  const ganttIds = ganttInFlightTaskIds(twelve.gantt).sort();

  assert.equal(twelve.gantt?.windowHours, 12);
  assert.deepEqual(cardIds, ['twelve-window-task'], 'the card must re-derive from the new window’s lanes');
  assert.deepEqual(cardIds, ganttIds, 'the card and the gantt must still name the same in-flight set');
});

/**
 * AC2 (gap-quay-tab-inflight-card-and-gantt-two-sources): a task parked in fan-in must read as
 * `fan-in` in the card AND equal the gantt's phase for that interval — even when the worker
 * outcome table has no record for the attempt.
 *
 * The task holds an unreleased fan-in lock: quay's `readLive` reads
 * `.quay/fan-in-lock-events.jsonl` (an acquire with no release) and publishes the interval with
 * `phase: 'fan-in'` — the document this service relays. The lock carrier is inert to THIS
 * service (it never opens it); it is in the corpus only to name the upstream cause.
 * The 取假: sourcing `phase` from the outcome-attempt table would answer `implementing` here
 * (the table has no record for the task) and red.
 */
test('a task parked in fan-in reads as fan-in in the card and the gantt, with no outcome record', async () => {
  const lockEvents = `${JSON.stringify({
    event: 'acquire',
    task: 'gap-fan-in-no-outcome',
    epoch: 1_791_010_000,
  })}\n`;
  // The outcome table records a DIFFERENT task only: nothing here would make this task read
  // as fan-in, which is exactly why the phase must come from the lanes reading.
  const workerOutcome = `${JSON.stringify({
    task: 'some-other-task',
    mechanical_fan_in: { outcome: 'landed', lockAcquireEpoch: 1, lockReleaseEpoch: 2 },
  })}\n`;
  const workerRound = `${JSON.stringify({
    ts: '2026-10-07T00:00:00.000Z',
    pid: 4242,
    in_flight_tasks: ['gap-fan-in-no-outcome'],
    in_flight_task_starts: { 'gap-fan-in-no-outcome': '2026-10-06T23:00:00.000Z' },
  })}\n`;

  const service = createQuayService(createDependencies({
    runCommand: createLanesRunner(lanesDocument([
      { taskId: 'gap-fan-in-no-outcome', phase: 'fan-in' },
    ])),
    readFile: createCarrierReader({
      'worker-round.jsonl': workerRound,
      'worker-outcome.jsonl': workerOutcome,
      'fan-in-lock-events.jsonl': lockEvents,
    }),
  }));

  const snapshot = await service.getQuaySnapshot('project-1');
  assert.ok(snapshot);

  const cardPhase = snapshot.inFlight?.find((task) => task.taskId === 'gap-fan-in-no-outcome')?.phase;
  const ganttPhase = snapshot.gantt?.lanes.flat().find((interval) => interval.taskId === 'gap-fan-in-no-outcome')?.phase;

  assert.equal(cardPhase, 'fan-in', 'a task holding an unreleased fan-in lock must read as fan-in');
  assert.equal(ganttPhase, 'fan-in');
  assert.equal(cardPhase, ganttPhase, 'the card phase and the gantt phase must be the same reading');
});

/* ── Loop pulse: the window and the relayed `lanes` verb ────────────────────────── */

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

test('readGanttLanes reports an unreadable payload as null, never as an empty lane set', () => {
  // `null` and `{lanes: [], overflow: 0}` are different readings: the latter is a real answer
  // ("nothing ran in this window"), the former is "this payload does not answer the question".
  // Collapsing them would render a broken read as an idle board.
  assert.equal(readGanttLanes(null), null);
  assert.equal(readGanttLanes('nope'), null);
  assert.equal(readGanttLanes([]), null);
  assert.equal(readGanttLanes({}), null);
  // Every documented top-level field is required, and each must have its documented type.
  assert.equal(readGanttLanes({ nowMs: 1, lanes: [], overflow: 0 }), null);
  assert.equal(readGanttLanes({ windowHours: 3, lanes: [], overflow: 0 }), null);
  assert.equal(readGanttLanes({ windowHours: 3, nowMs: 1, overflow: 0 }), null);
  assert.equal(readGanttLanes({ windowHours: 3, nowMs: 1, lanes: 'nope', overflow: 0 }), null);
  assert.equal(readGanttLanes({ windowHours: 3, nowMs: 1, lanes: [], overflow: 'x' }), null);

  // An all-empty reading is a real one and round-trips verbatim — the verb's five empty lanes.
  assert.deepEqual(
    readGanttLanes({ windowHours: 3, nowMs: 1, lanes: [[], [], [], [], []], overflow: 0 }),
    { windowHours: 3, nowMs: 1, lanes: [[], [], [], [], []], overflow: 0 },
  );

  // One mistyped interval invalidates the whole reading rather than being silently dropped:
  // a lane that lost an interval would plot a board that differs from quay's own.
  assert.equal(
    readGanttLanes({
      windowHours: 3,
      nowMs: 1,
      overflow: 0,
      lanes: [[
        { taskId: 't1', runId: 'r1', startMs: 1, endMs: 2, phase: null, finalState: null, fanInOutcome: null },
        // No `endMs`: an interval with no end coordinate cannot be placed, so it voids the read.
        { taskId: 't2', runId: 'r2', startMs: 1 },
      ]],
    }),
    null,
  );

  // Optional descriptive fields are honestly null when the verb omits them; the coordinates
  // (taskId/runId/startMs/endMs) are what actually place an interval, and they are required.
  assert.deepEqual(
    readGanttLanes({
      windowHours: 3,
      nowMs: 1_791_000_600_000,
      overflow: 2,
      lanes: [
        [{
          taskId: 't1',
          runId: 'r1',
          startMs: 1_791_000_000_000,
          endMs: 1_791_000_300_000,
          phase: 'implementing',
          finalState: null,
          fanInOutcome: null,
        }],
        [],
      ],
    }),
    {
      windowHours: 3,
      nowMs: 1_791_000_600_000,
      overflow: 2,
      lanes: [
        [{
          taskId: 't1',
          runId: 'r1',
          startMs: 1_791_000_000_000,
          endMs: 1_791_000_300_000,
          phase: 'implementing',
          finalState: null,
          fanInOutcome: null,
        }],
        [],
      ],
    },
  );
});

test('the Loop pulse lanes are the read-only `lanes` verb’s own document, relayed verbatim', async () => {
  // The collector neither merges runs with history nor packs lanes: it spawns the whitelisted
  // verb and passes its document through untouched, so the interval set, the window and the
  // overflow count are all quay's own. This case pins that WIRING — the verb is asked for the
  // selected window, and whatever it prints is what the snapshot carries.
  const lanesDoc = JSON.stringify({
    windowHours: 3,
    nowMs: 1_791_000_600_000,
    overflow: 2,
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

  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => ({
      ok: true,
      code: 0,
      stdout: args.join(' ') === 'lanes --json --window-hours 3' ? lanesDoc : 'null',
      stderr: '',
    }),
    now: () => 1_791_000_600_000,
  }));

  const snapshot = await service.getQuaySnapshot('project-1', { forceRefresh: true });
  assert.ok(snapshot, 'the snapshot must load');
  assert.ok(snapshot.gantt, 'a project whose plugin answers the `lanes` verb must report lanes');

  assert.equal(snapshot.gantt.windowHours, 3);
  assert.equal(snapshot.gantt.nowMs, 1_791_000_600_000);
  assert.equal(snapshot.gantt.overflow, 2, 'the overflow count is passed through, never recomputed');
  assert.equal(snapshot.gantt.lanes.length, 1);
  assert.equal(snapshot.gantt.lanes[0][0].taskId, 'live-run');
  assert.equal(snapshot.gantt.lanes[0][0].phase, 'implementing');
  assert.equal(snapshot.gantt.lanes[0][0].finalState, null, 'an in-flight interval keeps its null finalState');
});

test('a request for a non-default window is read at that window, never answered from the default’s reading', async () => {
  // The verb re-selects its sources per window, so the collector must hand it the requested
  // window — a cache keyed on the project alone would answer 12h with the 3h reading.
  const seen: string[] = [];
  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => {
      const key = args.join(' ');
      seen.push(key);
      if (args[0] !== 'lanes') return { ok: true, code: 0, stdout: 'null', stderr: '' };
      const windowHours = Number(args[args.indexOf('--window-hours') + 1]);
      return {
        ok: true,
        code: 0,
        // Echo the window back, so the interval's taskId reads which window the verb was told.
        stdout: JSON.stringify({
          windowHours,
          nowMs: 1_791_000_600_000,
          overflow: 0,
          lanes: [[{
            taskId: String(windowHours),
            runId: 'r',
            startMs: 1,
            endMs: 2,
            phase: null,
            finalState: null,
            fanInOutcome: null,
          }]],
        }),
        stderr: '',
      };
    },
    now: () => 1_791_000_600_000,
  }));

  const defaulted = await service.getQuaySnapshot('project-1');
  const twelve = await service.getQuaySnapshot('project-1', { windowHours: '12' });
  const one = await service.getQuaySnapshot('project-1', { windowHours: '1' });

  assert.equal(defaulted?.gantt?.lanes[0][0].taskId, '3');
  assert.equal(twelve?.gantt?.lanes[0][0].taskId, '12');
  assert.equal(one?.gantt?.lanes[0][0].taskId, '1');
  assert.equal(twelve?.gantt?.windowHours, 12);
  assert.ok(seen.includes('lanes --json --window-hours 3'));
  assert.ok(seen.includes('lanes --json --window-hours 12'));
  assert.ok(seen.includes('lanes --json --window-hours 1'));
});

test('a window change re-reads only the lanes verb, and a repeated (project, window) is served from cache', async () => {
  // A window is a *data* filter on ONE project: only the Loop pulse reading depends on it, so a
  // window switch must re-read the lanes alone and reuse every other section. Before this each
  // click paid a full cold pass (task/goal/ADR/driver/config/lanes) — 3–4 s on a large store.
  const seen: string[] = [];
  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => {
      const key = args.join(' ');
      seen.push(key);
      if (args[0] !== 'lanes') {
        // A non-null, non-trivial body for the window-independent sections, so "reused" is
        // distinguishable from "both happen to be null".
        return { ok: true, code: 0, stdout: JSON.stringify([{ id: 'x', title: 'X', status: 'ready', updatedAt: 1 }]), stderr: '' };
      }
      const windowHours = Number(args[args.indexOf('--window-hours') + 1]);
      return {
        ok: true,
        code: 0,
        // Echo the window back as the interval's taskId, so a reader can see which window the
        // verb was asked for and that the per-window entries never cross-answer each other.
        stdout: JSON.stringify({
          windowHours,
          nowMs: 1_791_000_600_000,
          overflow: 0,
          lanes: [[{
            taskId: String(windowHours),
            runId: 'r',
            startMs: 1,
            endMs: 2,
            phase: null,
            finalState: null,
            fanInOutcome: null,
          }]],
        }),
        stderr: '',
      };
    },
    now: () => 1_791_000_600_000,
  }));

  // The default window: this is the ONE full pass, and it primes the per-project cache the
  // window change reuses.
  const base = await service.getQuaySnapshot('project-1');
  assert.ok(base);
  assert.notEqual(base.tasks, null, 'the fixture sections must be real, so reuse is observable');
  seen.length = 0;

  // A different window: only the lanes family may be spawned.
  const twelve = await service.getQuaySnapshot('project-1', { windowHours: '12' });
  assert.deepEqual(seen, ['lanes --json --window-hours 12'], 'a window change must not re-read the window-independent sections');
  assert.equal(twelve?.gantt?.windowHours, 12);
  assert.equal(twelve?.gantt?.lanes[0][0].taskId, '12');
  assert.equal(twelve?.cached, false, 'the lanes were freshly read, so the response is not wholly cached');
  // The window-independent sections are the default reading's, reused rather than re-spawned.
  assert.deepEqual(twelve?.tasks, base?.tasks);
  assert.deepEqual(twelve?.adrs, base?.adrs);

  // The SAME (project, window) again: a cache hit, so no subprocess at all.
  seen.length = 0;
  const twelveAgain = await service.getQuaySnapshot('project-1', { windowHours: '12' });
  assert.deepEqual(seen, [], 'a repeated (project, window) must spawn nothing');
  assert.equal(twelveAgain?.cached, true);
  assert.equal(twelveAgain?.gantt?.windowHours, 12);

  // A THIRD window is again lanes-only — the cache is keyed by window, not project, so the
  // 3h/12h entries must never answer the 1h request.
  seen.length = 0;
  const one = await service.getQuaySnapshot('project-1', { windowHours: '1' });
  assert.deepEqual(seen, ['lanes --json --window-hours 1']);
  assert.equal(one?.gantt?.windowHours, 1);
  assert.equal(one?.gantt?.lanes[0][0].taskId, '1');
});

test('a project whose plugin predates the `lanes` verb reports no lanes, not an empty board', async () => {
  // `null` is the honest reading for "this project cannot answer": an empty lane set would
  // render as "nothing ran in this window", which is a different claim. An un-upgraded plugin
  // has no such verb, so it exits non-zero with a usage error and prints no document.
  const service = createQuayService(createDependencies({
    resolveProjectPathById: () => PROJECT_PATH,
    runCommand: async (_cwd, args) => (args[0] === 'lanes'
      ? { ok: false, code: 1, stdout: '', stderr: 'unknown command: lanes', failureKind: 'nonzero-exit' }
      : { ok: true, code: 0, stdout: 'null', stderr: '' }),
    now: () => 1_791_000_600_000,
  }));

  const snapshot = await service.getQuaySnapshot('project-1', { forceRefresh: true });

  assert.equal(snapshot?.gantt, null);
  // A plugin older than the verb is a normal state for an un-upgraded project, not a fault of
  // this panel — so it must not pepper the warnings banner.
  assert.deepEqual(snapshot?.warnings, []);
});

test('an un-upgraded plugin and a failed `lanes` read are classified as different reasons', async () => {
  // A missing lane reading has two distinct causes and the panel states which one it is: the
  // CLI refusing the sub-command (no such verb) vs. the verb running but not returning a usable
  // document. Collapsing them would tell the reader nothing about whether to upgrade or retry.
  const withRunner = (lanesResult: () => QuayCommandResult) =>
    createQuayService(createDependencies({
      resolveProjectPathById: () => PROJECT_PATH,
      runCommand: async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => (args[0] === 'lanes'
        ? lanesResult()
        : { ok: true, code: 0, stdout: 'null', stderr: '' }),
      now: () => 1_791_000_600_000,
    }));

  const missingVerb = await withRunner(() => ({ ok: false, code: 1, stdout: '', stderr: 'unknown command: lanes', failureKind: 'nonzero-exit' }))
    .getQuaySnapshot('project-1', { forceRefresh: true });
  assert.equal(missingVerb?.gantt, null);
  assert.equal(missingVerb?.ganttUnavailable, 'plugin-lacks-lanes-verb');

  const readFailed = await withRunner(() => ({ ok: true, code: 0, stdout: 'not a lane document', stderr: '' }))
    .getQuaySnapshot('project-1', { forceRefresh: true });
  assert.equal(readFailed?.gantt, null);
  assert.equal(readFailed?.ganttUnavailable, 'lanes-read-failed');

  assert.notEqual(missingVerb?.ganttUnavailable, readFailed?.ganttUnavailable);
});

/* ── real install: the `lanes` verb answers this service's consumer shape ─────────── */

/**
 * The consumer-side half of the integration contract: on a machine where the released plugin
 * is installed, run the project's OWN `quay lanes --json` and require that its document is
 * exactly what this service accepts — the shape check `readGanttLanes` performs is the same
 * one the snapshot runs, so if the verb ever drifts from it the panel would silently render
 * no lanes, and this case reds instead.
 *
 * Also pins the two documented invariants a consumer may rely on: the verb always prints the
 * fixed five reference lanes, and a wider window selects at least as many intervals as a
 * narrower one (the window is a data filter over the same history, not a zoom).
 *
 * Skips (loudly) where no plugin is installed: the worktree this file is checked out in
 * carries no `.quay/plugin` pointer, so there is genuinely no verb to run, and a silent pass
 * would claim a verification that never ran. The positive run happens in the main checkout.
 */
test('the installed `lanes` verb answers this service’s shape and re-selects with the window', (t) => {
  const root = process.cwd();
  const cli = path.join(root, '.quay', 'plugin', 'vendor', 'quay', 'dist', 'quay.js');
  if (!fs.existsSync(cli)) {
    t.skip(`no installed quay plugin at ${cli}`);
    return;
  }

  const run = (hours: number) =>
    spawnSync(
      process.execPath,
      [cli, 'lanes', '--json', '--window-hours', String(hours), '--root', root],
      { encoding: 'utf8' },
    );
  const parse = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf('{')));
  const intervalCount = (lanes: Array<unknown[]>) => lanes.reduce((n, lane) => n + lane.length, 0);

  const three = run(3);
  assert.equal(three.status, 0, `quay lanes --window-hours 3 exited ${three.status}: ${three.stderr}`);
  const lanesThree = readGanttLanes(parse(three.stdout));
  assert.ok(lanesThree, 'the installed verb’s document must pass this service’s shape check');
  assert.equal(lanesThree.windowHours, 3);
  assert.equal(lanesThree.lanes.length, 5, 'the verb always prints the fixed five reference lanes');
  assert.ok(lanesThree.overflow >= 0, 'the overflow count is a count, never negative');

  const twelve = run(12);
  assert.equal(twelve.status, 0, `quay lanes --window-hours 12 exited ${twelve.status}: ${twelve.stderr}`);
  const lanesTwelve = readGanttLanes(parse(twelve.stdout));
  assert.ok(lanesTwelve, 'the 12h document must pass the same shape check as the 3h one');
  assert.equal(lanesTwelve.windowHours, 12);
  assert.equal(lanesTwelve.lanes.length, 5);
  assert.ok(
    intervalCount(lanesTwelve.lanes) >= intervalCount(lanesThree.lanes),
    'a wider window must select at least as many intervals as a narrower one (data filter, not zoom)',
  );

  console.log(
    `[quay-gantt] lanes verb: 3h → ${intervalCount(lanesThree.lanes)} interval(s) on ${lanesThree.lanes.length} lanes`
    + ` + ${lanesThree.overflow} overflow; 12h → ${intervalCount(lanesTwelve.lanes)} interval(s)`,
  );
});

/* ── the lanes-only reading (gap-quay-session-mentions-and-lanes-only-readings) ─────────── */

/**
 * A runner that answers `lanes` with a document carrying the REQUESTED window and every other
 * whitelisted verb with `[]`, recording each argv it saw. A window-echoing fixture is what lets
 * a test tell "the requested window reached the verb" from "the default answered instead".
 */
function createWindowEchoLanesRunner(recorded: string[]): QuayCommandRunner {
  return async (_cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    recorded.push(args.join(' '));
    if (args[0] === 'lanes') {
      const windowHours = Number(args[args.length - 1]);
      // `lanesDocument` is deliberately `unknown` (it feeds the parser); the echo needs its
      // documented shape, so this arm spells the object out.
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({
          windowHours,
          nowMs: LANES_NOW_MS,
          lanes: [[{
            taskId: 'gap-lanes-only',
            runId: 'run-gap-lanes-only',
            startMs: LANES_NOW_MS - 600_000,
            endMs: LANES_NOW_MS,
            phase: 'implementing',
            finalState: null,
            fanInOutcome: null,
          }]],
          overflow: 0,
        }),
        stderr: '',
      };
    }
    return { ok: true, code: 0, stdout: '[]', stderr: '' };
  };
}

test('the lanes-only reading spawns one `lanes` child, nothing else, and reuses it inside the TTL', async () => {
  const recorded: string[] = [];
  let now = 1_000_000;
  const service = createQuayService(createDependencies({
    runCommand: createWindowEchoLanesRunner(recorded),
    now: () => now,
  }));

  const six = await service.getQuayLanes('project-1', '6');
  assert.ok(six !== null);
  assert.equal(six.ok, true);
  assert.equal(six.gantt?.windowHours, 6);
  assert.equal(six.ganttUnavailable, null);
  assert.equal(six.generatedAt, new Date(now).toISOString());
  assert.deepEqual(
    recorded,
    ['lanes --json --window-hours 6'],
    'the title bar’s reading must not spawn task list, goal list, adr list or any driver read',
  );

  // A poll inside the TTL is answered from the (project, window) cache without a new child.
  now += 1_000;
  const again = await service.getQuayLanes('project-1', 6);
  assert.deepEqual(again?.gantt, six.gantt);
  assert.deepEqual(recorded, ['lanes --json --window-hours 6']);

  // An off-set window and an unparseable one both fall back to the default 3h window.
  now += 1_000;
  const seven = await service.getQuayLanes('project-1', '7');
  assert.equal(seven?.gantt?.windowHours, 3);
  assert.deepEqual(recorded, [
    'lanes --json --window-hours 6',
    'lanes --json --window-hours 3',
  ]);

  now += 1_000;
  const abc = await service.getQuayLanes('project-1', 'abc');
  assert.equal(abc?.gantt?.windowHours, 3);
  assert.deepEqual(
    recorded,
    ['lanes --json --window-hours 6', 'lanes --json --window-hours 3'],
    'hours=abc normalises onto the cached default window instead of spawning again',
  );
});

test('the lanes-only reading carries the same gantt and failure reading the snapshot gives for that window', async () => {
  const recorded: string[] = [];
  const service = createQuayService(createDependencies({
    runCommand: createWindowEchoLanesRunner(recorded),
    now: () => LANES_NOW_MS,
  }));

  const lanes = await service.getQuayLanes('project-1', 6);
  const snapshot = await service.getQuaySnapshot('project-1', { windowHours: 6 });
  assert.ok(lanes !== null && snapshot !== null);
  assert.deepEqual(lanes.gantt, snapshot.gantt, 'the title bar and the Loop pulse plot the same document');
  assert.deepEqual(lanes.ganttUnavailable, snapshot.ganttUnavailable);
});

test('the lanes-only reading classifies an un-upgraded verb and an unreadable document apart', async () => {
  // A plugin predating the `lanes` verb: the CLI refuses the sub-command with a non-zero exit.
  const missingVerb = createQuayService(createDependencies({
    runCommand: async (_cwd, args) => (args[0] === 'lanes'
      ? { ok: false, code: 1, stdout: '', stderr: 'unknown command', failureKind: 'nonzero-exit' }
      : { ok: true, code: 0, stdout: '[]', stderr: '' }),
  }));
  const missing = await missingVerb.getQuayLanes('project-1');
  assert.equal(missing?.gantt, null);
  assert.equal(missing?.ganttUnavailable, 'plugin-lacks-lanes-verb');

  // The verb ran but printed something that is not a lane document.
  const unreadable = createQuayService(createDependencies({
    runCommand: async () => ({ ok: true, code: 0, stdout: 'not a lane document', stderr: '' }),
  }));
  const broken = await unreadable.getQuayLanes('project-1');
  assert.equal(broken?.gantt, null);
  assert.equal(broken?.ganttUnavailable, 'lanes-read-failed');
});

//----------------- LOOP OVERALL STATUS (QuaySnapshot.loop) ------------

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const WORKER_CONTROL_PATH = path.join(PROJECT_PATH, '.quay', 'worker-control.json');
const PROMOTION_CONTROL_PATH = path.join(PROJECT_PATH, '.quay', 'promotion-control.json');
const QUALITY_CONTROL_PATH = path.join(PROJECT_PATH, '.quay', 'quality-control.json');
const ORPHAN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** The REAL `driver status --kind worker --json` documents captured from 0.22.0 / 0.19.0. */
function loadDriverStatusFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>;
}

/**
 * A file reader over an in-memory corpus that records every path it was asked about — so a
 * drain test can assert the reads stayed under `<project>/.quay/`, and an orphan test can
 * assert an escaping path never reached the read seam at all.
 */
function createRecordingReader(files: Record<string, string>, seen: string[]): QuayFileReader {
  const has = (filePath: string) => Object.prototype.hasOwnProperty.call(files, filePath);
  return createFileReader({
    size: async (filePath) => {
      seen.push(filePath);
      return has(filePath) ? files[filePath].length : null;
    },
    readText: async (filePath) => {
      seen.push(filePath);
      if (!has(filePath)) {
        throw new Error('ENOENT');
      }
      return files[filePath];
    },
  });
}

/** Runs `body` with `CLAUDE_CODE_PLUGIN_CACHE_DIR` set to `pluginsRoot`, restoring it afterwards. */
async function withPluginCacheRoot<T>(pluginsRoot: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = pluginsRoot;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = previous;
    }
  }
}

/** One snapshot of project-1 whose `driver status` answers with `driverStatus`. */
async function snapshotWithDriver(
  driverStatus: Record<string, unknown> | null,
  options: { files?: Record<string, string>; seen?: string[]; nowMs?: number; snapshotTtlMs?: number } = {},
): Promise<Awaited<ReturnType<ReturnType<typeof createQuayService>['getQuaySnapshot']>>> {
  const counter = { calls: 0 };
  const service = createQuayService(createDependencies({
    runCommand: createFixtureRunner(
      counter,
      driverStatus === null ? {} : { 'driver status --kind worker --json': driverStatus },
    ),
    readFile: createRecordingReader(options.files ?? {}, options.seen ?? []),
    now: () => options.nowMs ?? 0,
    snapshotTtlMs: options.snapshotTtlMs ?? 30_000,
  }));
  return service.getQuaySnapshot('project-1');
}

test('loop.kernel and loop.pointer map the real 0.22.0 and 0.19.0 driver-status fixtures', async () => {
  const fixture22 = loadDriverStatusFixture('driver-status-worker-0.22.0.json');
  const fixture19 = loadDriverStatusFixture('driver-status-worker-0.19.0.json');

  const current22 = await snapshotWithDriver(fixture22);
  assert.ok(current22?.loop, 'a readable driver status must produce a loop reading');
  assert.deepEqual(current22.loop.kernel, {
    loaded: '0.22.0',
    installed: '0.22.0',
    relation: 'current',
    reason: null,
  });
  assert.equal(current22.loop.anchorPid, 2877551);
  assert.deepEqual(current22.loop.pointer, {
    state: 'current',
    linkVersion: '0.22.0',
    coreVersion: '0.22.0',
  });

  // The 0.19.0 binary still READ the running (0.22.0) kernel, but its own core is 0.19.0, so
  // its pointer is ahead of the core it belongs to — a different pointer reading, same kernel.
  const current19 = await snapshotWithDriver(fixture19);
  assert.deepEqual(current19?.loop?.kernel, {
    loaded: '0.22.0',
    installed: '0.22.0',
    relation: 'current',
    reason: null,
  });
  assert.deepEqual(current19?.loop?.pointer, {
    state: 'ahead',
    linkVersion: '0.22.0',
    coreVersion: '0.19.0',
  });

  // The remaining determinate states map one-to-one; none of them is folded into `current`.
  for (const relation of ['behind', 'ahead'] as const) {
    const snapshot = await snapshotWithDriver({ ...fixture22, loaded_version: relation });
    assert.equal(snapshot?.loop?.kernel.relation, relation);
    assert.equal(snapshot?.loop?.kernel.reason, null);
  }

  const failing = await snapshotWithDriver({
    ...fixture22,
    loaded_version: 'not-evaluated',
    loaded_version_reason: 'the anchor process is not alive',
  });
  assert.deepEqual(failing?.loop?.kernel, {
    loaded: '0.22.0',
    installed: '0.22.0',
    relation: 'not-evaluated',
    reason: 'the anchor process is not alive',
  });

  // An unknown value or a missing field must read `not-evaluated` WITH a reason. Defaulting
  // either to `current` would make these two assertions fail.
  const unknown = await snapshotWithDriver({ ...fixture22, loaded_version: 'sideways' });
  assert.equal(unknown?.loop?.kernel.relation, 'not-evaluated');
  assert.match(unknown?.loop?.kernel.reason ?? '', /sideways/);

  const { loaded_version: _omitVersion, loaded: _omitLoaded, installed: _omitInstalled, pointer: _omitPointer, ...noVersionReading } = fixture22;
  const missing = await snapshotWithDriver(noVersionReading);
  assert.deepEqual(missing?.loop?.kernel, {
    loaded: null,
    installed: null,
    relation: 'not-evaluated',
    reason: 'driver status carried no loaded_version reading',
  });
  assert.equal(missing?.loop?.pointer, null, 'an absent pointer segment is "not reported", never "current"');

  // An unrecognised pointer state is also not passed through as a healthy reading.
  const oddPointer = await snapshotWithDriver({ ...fixture22, pointer: { state: 'sideways', link_version: '1', core_version: '2' } });
  assert.deepEqual(oddPointer?.loop?.pointer, { state: 'not-evaluated', linkVersion: '1', coreVersion: '2' });
});

test('loop.drain reads each control file independently, distinguishing absent from unreadable', async () => {
  const driverStatus = { alive: 1, running: 1 };
  const seen: string[] = [];

  const running = await snapshotWithDriver(driverStatus, {
    seen,
    files: {
      [WORKER_CONTROL_PATH]: JSON.stringify({ halted: true }),
      [PROMOTION_CONTROL_PATH]: JSON.stringify({ halted: false }),
      // quality-control.json absent: never drained reads `false`, not `null`.
    },
  });
  assert.deepEqual(running?.loop?.drain, { worker: true, promotion: false, quality: false });
  assert.deepEqual(
    [...new Set(seen.filter((filePath) => filePath.endsWith('-control.json')))].sort(),
    [WORKER_CONTROL_PATH, PROMOTION_CONTROL_PATH, QUALITY_CONTROL_PATH].sort(),
    'the drain reading touches exactly the three control files, all under <project>/.quay/',
  );
  assert.ok(
    seen.filter((filePath) => filePath.endsWith('-control.json'))
      .every((filePath) => filePath.startsWith(path.join(PROJECT_PATH, '.quay') + path.sep)),
    'every control-file read stays under <project>/.quay/',
  );

  const unreadableSeen: string[] = [];
  const unreadable = await snapshotWithDriver(driverStatus, {
    seen: unreadableSeen,
    files: {
      // invalid JSON, a non-boolean `halted`, and an absent worker file, each on its own kind.
      [WORKER_CONTROL_PATH]: '{not json',
      [PROMOTION_CONTROL_PATH]: JSON.stringify({ halted: 'yes' }),
      [QUALITY_CONTROL_PATH]: JSON.stringify({ halted: true }),
    },
  });
  assert.deepEqual(unreadable?.loop?.drain, { worker: null, promotion: null, quality: true });
  assert.ok(
    unreadableSeen.filter((filePath) => filePath.endsWith('-control.json'))
      .every((filePath) => filePath.startsWith(path.join(PROJECT_PATH, '.quay') + path.sep)),
    'a corrupt drain file must not make the reader look anywhere but the three control paths',
  );
});

test('loop.orphan marks a cache version directory, and removeAfter is exactly 14 days after markedAt', async () => {
  const pluginsRoot = path.join(os.tmpdir(), `quay-loop-cache-${process.pid}-${Date.now()}`);
  const cacheRoot = path.join(pluginsRoot, 'cache');
  const versionDir = path.join(cacheRoot, 'marketplace', 'quay', '1.2.3');
  const marker = path.join(versionDir, '.orphaned_at');
  const kernel = path.join(versionDir, 'scripts', 'dist', 'driver-anchor.js');
  const markedAtMs = Date.parse('2026-10-25T13:24:39.273Z');

  await withPluginCacheRoot(pluginsRoot, async () => {
    const fixture = loadDriverStatusFixture('driver-status-worker-0.22.0.json');
    const marked = await snapshotWithDriver({ ...fixture, loaded_kernel: kernel }, {
      files: { [marker]: `${markedAtMs}\n` },
    });
    assert.deepEqual(marked?.loop?.orphan, {
      state: 'marked',
      markedAt: new Date(markedAtMs).toISOString(),
      removeAfter: new Date(markedAtMs + ORPHAN_RETENTION_MS).toISOString(),
    });

    const none = await snapshotWithDriver({ ...fixture, loaded_kernel: kernel });
    assert.deepEqual(none?.loop?.orphan, { state: 'none', markedAt: null, removeAfter: null });

    for (const [markerText, label] of [['', 'empty'], ['not-a-number', 'non-numeric']] as const) {
      const invalid = await snapshotWithDriver({ ...fixture, loaded_kernel: kernel }, {
        files: { [marker]: markerText },
      });
      assert.equal(invalid?.loop?.orphan.state, 'not-evaluated', `${label} marker content must read not-evaluated`);
      assert.equal(invalid?.loop?.orphan.markedAt, null);
      assert.equal(invalid?.loop?.orphan.removeAfter, null);
    }
  });

  const seen: string[] = [];
  const unreadableReaderService = createQuayService(createDependencies({
    now: () => 0,
    runCommand: createFixtureRunner(
      { calls: 0 },
      { 'driver status --kind worker --json': { ...loadDriverStatusFixture('driver-status-worker-0.22.0.json'), loaded_kernel: kernel } },
    ),
    readFile: createFileReader({
      size: async (filePath) => (filePath === marker ? 13 : null),
      readText: async (filePath) => {
        seen.push(filePath);
        throw new Error('EACCES');
      },
    }),
  }));
  const readFailed = await withPluginCacheRoot(pluginsRoot, () => unreadableReaderService.getQuaySnapshot('project-1'));
  assert.deepEqual(readFailed?.loop?.orphan, { state: 'not-evaluated', markedAt: null, removeAfter: null });
  assert.ok(seen.includes(marker), 'the read failure arm must have attempted the marker read');
});

test('loop.orphan keeps scratch kernels and escaped paths out of the cache', async () => {
  const pluginsRoot = path.join(os.tmpdir(), `quay-loop-escape-${process.pid}-${Date.now()}`);
  const cacheRoot = path.join(pluginsRoot, 'cache');
  const fixture = loadDriverStatusFixture('driver-status-worker-0.22.0.json');
  const versionDir = path.join(cacheRoot, 'marketplace', 'quay', '1.2.3');
  const marker = path.join(versionDir, '.orphaned_at');

  await withPluginCacheRoot(pluginsRoot, async () => {
    const seen: string[] = [];
    const scratch = await snapshotWithDriver(
      { ...fixture, loaded_kernel: '/data/home/yale/work/quay-scratch/official-dist-020-dev-r6-restart/scripts/dist/driver-anchor.js' },
      { seen },
    );
    assert.deepEqual(scratch?.loop?.orphan, { state: 'not-applicable', markedAt: null, removeAfter: null });
    assert.ok(!seen.some((filePath) => filePath.includes('quay-scratch')), 'a scratch kernel must not be read');

    // The cache-root override is honoured: a kernel under the DEFAULT plugins root is outside
    // the overridden cache and therefore not applicable.
    const defaultRootKernel = path.join(
      os.homedir(), '.claude', 'plugins', 'cache', 'marketplace', 'quay', '9.9.9', 'scripts', 'dist', 'driver-anchor.js',
    );
    const defaultRootSeen: string[] = [];
    const defaultRoot = await snapshotWithDriver({ ...fixture, loaded_kernel: defaultRootKernel }, { seen: defaultRootSeen });
    assert.equal(defaultRoot?.loop?.orphan.state, 'not-applicable');
    assert.ok(!defaultRootSeen.some((filePath) => filePath.includes('.orphaned_at')));

    // A kernel under the OVERRIDDEN root is evaluated normally.
    const underOverride = await snapshotWithDriver(
      { ...fixture, loaded_kernel: path.join(versionDir, 'scripts', 'dist', 'driver-anchor.js') },
      { files: { [marker]: '1792934659273' } },
    );
    assert.equal(underOverride?.loop?.orphan.state, 'marked');

    for (const [kernel, label] of [
      // Built by string concatenation on purpose: `path.join` would fold the `..` segments
      // away and the case would silently test "outside the cache" instead of the escape.
      [`${cacheRoot}/marketplace/quay/1.2.3/../../../../outside/driver-anchor.js`, 'dotdot'],
      ['cache/marketplace/quay/1.2.3/scripts/dist/driver-anchor.js', 'relative'],
    ] as const) {
      const escapeSeen: string[] = [];
      const escaped = await snapshotWithDriver({ ...fixture, loaded_kernel: kernel }, { seen: escapeSeen });
      assert.equal(escaped?.loop?.orphan.state, 'not-evaluated', `${label} path must read not-evaluated`);
      assert.ok(!escapeSeen.some((filePath) => filePath.includes('.orphaned_at')), `${label} path must never reach the marker read`);
    }

    // A version directory that is a SYMLINK out of the cache is refused too — lexically it
    // looks contained, so only resolving it catches the escape.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quay-loop-symlink-'));
    try {
      const realPluginsRoot = path.join(tmpRoot, 'plugins');
      const realCacheRoot = path.join(realPluginsRoot, 'cache');
      const outside = path.join(tmpRoot, 'outside');
      const linkedVersionDir = path.join(realCacheRoot, 'marketplace', 'quay', '1.2.3');
      fs.mkdirSync(path.join(realCacheRoot, 'marketplace', 'quay'), { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, '.orphaned_at'), '1792934659273');
      fs.symlinkSync(outside, linkedVersionDir);

      const symlinkSeen: string[] = [];
      const symlinked = await withPluginCacheRoot(realPluginsRoot, () => snapshotWithDriver(
        { ...fixture, loaded_kernel: path.join(linkedVersionDir, 'scripts', 'dist', 'driver-anchor.js') },
        { seen: symlinkSeen },
      ));
      assert.equal(symlinked?.loop?.orphan.state, 'not-evaluated');
      assert.ok(!symlinkSeen.some((filePath) => filePath.includes('.orphaned_at')), 'an escaping version dir must never reach the marker read');

      // A legitimately contained version directory whose MARKER file is the escaping symlink
      // is refused as well.
      const containerDir = path.join(realCacheRoot, 'marketplace', 'quay', '2.0.0');
      fs.mkdirSync(containerDir, { recursive: true });
      fs.symlinkSync(path.join(outside, '.orphaned_at'), path.join(containerDir, '.orphaned_at'));
      const markerSeen: string[] = [];
      const markerEscape = await withPluginCacheRoot(realPluginsRoot, () => snapshotWithDriver(
        { ...fixture, loaded_kernel: path.join(containerDir, 'scripts', 'dist', 'driver-anchor.js') },
        { seen: markerSeen },
      ));
      assert.equal(markerEscape?.loop?.orphan.state, 'not-evaluated');
      assert.ok(!markerSeen.some((filePath) => filePath.includes('.orphaned_at')), 'an escaping marker symlink must never be read');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

test('loop costs no extra driver-status spawn, is null on failure, and rides the snapshot TTL', async () => {
  const pluginsRoot = path.join(os.tmpdir(), `quay-loop-ttl-${process.pid}-${Date.now()}`);
  const versionDir = path.join(pluginsRoot, 'cache', 'marketplace', 'quay', '1.2.3');
  const marker = path.join(versionDir, '.orphaned_at');
  const fixture = loadDriverStatusFixture('driver-status-worker-0.22.0.json');
  const driverStatus = { ...fixture, loaded_kernel: path.join(versionDir, 'scripts', 'dist', 'driver-anchor.js') };

  await withPluginCacheRoot(pluginsRoot, async () => {
    const counter = { calls: 0, commands: [] as string[] };
    const seen: string[] = [];
    let nowMs = 0;
    const service = createQuayService(createDependencies({
      now: () => nowMs,
      snapshotTtlMs: 30_000,
      runCommand: createFixtureRunner(counter, { 'driver status --kind worker --json': driverStatus }),
      readFile: createRecordingReader({ [marker]: '1792934659273' }, seen),
    }));

    const cold = await service.getQuaySnapshot('project-1');
    assert.ok(cold?.loop, 'the loop reading must be present when driver status is readable');
    assert.equal(
      counter.commands.filter((command) => command === 'driver status --kind worker --json').length,
      1,
      'the loop projection must reuse the ONE driver-status spawn, never add a second',
    );
    assert.equal(counter.calls, EXPECTED_SNAPSHOT_COMMANDS.length, 'loop adds no CLI read at all');
    assert.ok(seen.includes(marker), 'the first reading evaluated the orphan marker');
    const readsAfterCold = seen.length;

    nowMs += 10_000;
    const warm = await service.getQuaySnapshot('project-1');
    assert.equal(warm?.cached, true);
    assert.equal(warm?.loop?.orphan.state, 'marked');
    assert.equal(counter.calls, EXPECTED_SNAPSHOT_COMMANDS.length, 'a TTL hit spawns no CLI');
    assert.equal(seen.length, readsAfterCold, 'a TTL hit must not re-read the control files or .orphaned_at');

    const base = createFixtureRunner({ calls: 0 });
    const failing = createQuayService(createDependencies({
      runCommand: async (cwd, args, options) => args.join(' ') === 'driver status --kind worker --json'
        ? { ok: false, code: 1, stdout: '', stderr: 'driver status exploded', failureKind: 'nonzero-exit' }
        : base(cwd, args, options),
    }));
    const failedSnapshot = await failing.getQuaySnapshot('project-1');
    assert.equal(failedSnapshot?.loop, null, 'an unread driver status is "not reported", never a made-up healthy loop');
    assert.equal(failedSnapshot?.driver, null);
    assert.equal(failedSnapshot?.tasks?.total, 3, 'the rest of the snapshot is unaffected');
    assert.ok(failedSnapshot?.warnings.some((warning) => warning.includes('driver status')));
  });
});

//----------------- COMPACT TASK INDEX: goal_ac ------------

test('task index: the loader carries each row’s goal_ac, and an event update leaves it intact', async () => {
  const spawns: string[][] = [];
  const service = createQuayService(createDependencies({
    runCommand: async (_cwd, args) => {
      spawns.push([...args]);
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify([
          {
            id: 'gap-indexed',
            title: 'indexed task',
            status: 'ready',
            updatedAt: '2026-10-25T00:00:00.000Z',
            goal_ac: 'AC-394',
          },
          { id: 'gap-no-goal', title: 'no goal', status: 'todo', updatedAt: null },
        ]),
        stderr: '',
      };
    },
  }));

  service.requestTaskIndexLoad('project-1');
  await settle();

  const index = service.readTaskIndex('project-1');
  assert.equal(index.state, 'ready');
  assert.equal(
    index.tasks.get('gap-indexed')?.goalAc,
    'AC-394',
    'goal_ac from the SAME --no-body read is carried on the row',
  );
  assert.equal(
    index.tasks.get('gap-no-goal')?.goalAc,
    null,
    'a row that carries no goal_ac reads null, never undefined',
  );
  assert.deepEqual(
    spawns,
    [['task', 'list', '--json', '--no-body']],
    'arriving goal_ac costs no second CLI read',
  );

  const applied = service.updateTaskIndexRow('project-1', 'gap-indexed', {
    status: 'done',
    updatedAt: '2026-10-25T01:00:00.000Z',
  });
  assert.equal(applied, true, 'the row exists, so an event may update it');

  const after = service.readTaskIndex('project-1');
  assert.equal(after.tasks.get('gap-indexed')?.status, 'done');
  assert.equal(
    after.tasks.get('gap-indexed')?.goalAc,
    'AC-394',
    'an event carries no goal_ac, so the known row’s value must survive the update',
  );
});
