/**
 * The manual ArchGuard re-analysis job's criterion (refreshJob).
 *
 * Every leg drives the real job code over a throwaway project directory and an
 * injected spawn: no ArchGuard CLI runs, so the readings are about THIS module's
 * orchestration — single-flight, the staged swap, failure/timeout preservation,
 * the shutdown kill, and the argv shape — rather than about the CLI's own work.
 *
 * The live fixture is a minimal but real `.archguard/query` tree (a manifest plus
 * one scope's `arch.json`/`arch-index.json`), so the swap leg compares real bytes.
 * The fake child writes its staged artifacts exactly where the real CLI would
 * (`--work-dir/query/…`) and then reports the exit code the leg needs.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';

import { createArchguardRefreshJob, type RefreshSpawn } from '../refreshJob.js';

const SCOPE_KEY = 'aaaaaaaa';
const LEGACY_SCOPE_KEY = 'bbbbbbbb';
const OLD_GENERATED_AT = '2026-10-01T00:00:00.000Z';
const NEW_GENERATED_AT = '2026-10-24T12:00:00.000Z';

type SpawnCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
};

/** A child stand-in: real EventEmitter surface, no OS process. */
class FakeChild extends EventEmitter {
  readonly pid = 999_999_999;
  readonly stderr = new EventEmitter();
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Creates a project whose live analysis is known byte-for-byte.
 *
 * `src/` and `server/` exist so the manifest's scopes resolve; the live query
 * carries one current scope, one retired scope directory and one auxiliary
 * carrier (`git-history`), which is what the swap leg reads back.
 */
function createProject(t: { after: (fn: () => void) => void }): {
  projectPath: string;
  settingsPath: string;
  liveManifestPath: string;
  liveQuery: string;
} {
  const projectPath = mkdtempSync(path.join(tmpdir(), 'archguard-refresh-job-'));
  t.after(() => rmSync(projectPath, { recursive: true, force: true }));
  const srcDir = path.join(projectPath, 'src');
  const serverDir = path.join(projectPath, 'server');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });

  const liveQuery = path.join(projectPath, '.archguard', 'query');
  const liveManifestPath = path.join(liveQuery, 'manifest.json');
  writeJson(liveManifestPath, {
    version: '1.0',
    generatedAt: OLD_GENERATED_AT,
    globalScopeKey: SCOPE_KEY,
    scopes: [
      { key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] },
      { key: LEGACY_SCOPE_KEY, label: 'chat (typescript)', language: 'typescript', sources: [path.join(srcDir, 'modules', 'chat')] },
    ],
  });
  writeJson(path.join(liveQuery, SCOPE_KEY, 'arch-index.json'), { archJsonHash: 'old-hash' });
  writeJson(path.join(liveQuery, SCOPE_KEY, 'arch.json'), { version: '1.0' });
  writeJson(path.join(liveQuery, LEGACY_SCOPE_KEY, 'arch-index.json'), { archJsonHash: 'legacy' });
  mkdirSync(path.join(liveQuery, 'git-history'), { recursive: true });
  writeFileSync(path.join(liveQuery, 'git-history', 'commits.json'), '{"kept":true}\n', 'utf8');

  // The settings' explicit CLI entry must exist; the injected spawn never runs it.
  const fakeCli = path.join(projectPath, 'fake-cli.mjs');
  writeFileSync(fakeCli, '// fake ArchGuard CLI used by the injected spawn\n', 'utf8');

  const settingsPath = path.join(projectPath, 'server.settings.json');
  writeJson(settingsPath, {
    architecture: { refresh: { cliPath: fakeCli, timeoutMs: 5_000, memoryLimitMb: 0 } },
  });
  return { projectPath, settingsPath, liveManifestPath, liveQuery };
}

/** The artifacts a successful fake CLI writes into its `--work-dir`. */
function writeStagedArtifacts(projectPath: string, args: readonly string[]): void {
  const index = args.indexOf('--work-dir');
  assert.ok(index >= 0, `the child must be told a --work-dir (args: ${JSON.stringify(args)})`);
  const workDir = args[index + 1];
  assert.ok(workDir !== undefined && path.isAbsolute(workDir), '--work-dir must be absolute');
  const srcDir = path.join(projectPath, 'src');
  writeJson(path.join(workDir, 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt: NEW_GENERATED_AT,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] }],
  });
  writeJson(path.join(workDir, 'query', SCOPE_KEY, 'arch-index.json'), { archJsonHash: 'new-hash' });
  writeJson(path.join(workDir, 'query', SCOPE_KEY, 'arch.json'), { version: '1.0', refreshed: true });
}

function makeSpawn(handler: (call: SpawnCall, child: FakeChild) => void): {
  spawn: RefreshSpawn;
  calls: SpawnCall[];
  children: FakeChild[];
} {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new FakeChild();
    const call = { command, args: [...args], options };
    calls.push(call);
    children.push(child);
    handler(call, child);
    return child as unknown as ChildProcess;
  }) as unknown as RefreshSpawn;
  return { spawn, calls, children };
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('condition did not hold before the deadline'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('two concurrent starts spawn once and answer the same job; a finished job can be restarted', async (t) => {
  const { projectPath, settingsPath } = createProject(t);
  const fake = makeSpawn((call, child) => {
    // A real CLI takes seconds; the job must still be "running" when the second
    // start arrives. The staged artifacts are written now so the success path is
    // waiting only for the exit event.
    writeStagedArtifacts(projectPath, call.args);
    // Closed by the test after the coalescing reading.
    void child;
  });
  const job = createArchguardRefreshJob({
    resolveProjectPath: (projectId) => (projectId === 'project-1' ? projectPath : null),
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  const first = job.start('project-1');
  // `runJob` resolves the sources before spawning, so the child is one tick away.
  await waitFor(() => fake.calls.length === 1);
  const second = job.start('project-1');
  assert.equal(fake.calls.length, 1, 'the second start must NOT spawn a second analysis');
  assert.equal(second.jobId, first.jobId, 'the coalesced start must answer the running job id');
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
  assert.equal(job.status('project-1').state, 'running');

  fake.children[0]?.emit('close', 0);
  await waitFor(() => job.status('project-1').state === 'succeeded');

  const third = job.start('project-1');
  await waitFor(() => fake.calls.length === 2);
  assert.equal(third.coalesced, false);
  assert.notEqual(third.jobId, first.jobId);
});

test('a successful run swaps the staged query in, drops the retired scope and keeps auxiliary carriers', async (t) => {
  const { projectPath, settingsPath, liveManifestPath, liveQuery } = createProject(t);
  const fake = makeSpawn((call, child) => {
    writeStagedArtifacts(projectPath, call.args);
    setImmediate(() => child.emit('close', 0));
  });
  const job = createArchguardRefreshJob({
    resolveProjectPath: () => projectPath,
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  job.start('project-1');
  await waitFor(() => job.status('project-1').state === 'succeeded');

  const installed = JSON.parse(readFileSync(liveManifestPath, 'utf8')) as { generatedAt: string };
  assert.equal(installed.generatedAt, NEW_GENERATED_AT, 'the new manifest must be the live one');
  assert.equal(job.status('project-1').exitCode, 0);
  assert.equal(job.status('project-1').error, null);
  assert.ok(
    !existsSync(path.join(liveQuery, LEGACY_SCOPE_KEY)),
    'a scope the refresh did not write must not survive the swap',
  );
  assert.equal(
    readFileSync(path.join(liveQuery, 'git-history', 'commits.json'), 'utf8'),
    '{"kept":true}\n',
    'auxiliary query products must be carried into the new directory',
  );
  const stagingRoot = path.join(projectPath, '.archguard', 'refresh');
  assert.ok(
    !existsSync(stagingRoot) || readdirSafe(stagingRoot).length === 0,
    'the staging directory must be cleaned up after the swap',
  );
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test('a non-zero exit leaves the live analysis byte-for-byte untouched and reports the stderr tail', async (t) => {
  const { projectPath, settingsPath, liveManifestPath } = createProject(t);
  const before = readFileSync(liveManifestPath);
  const fake = makeSpawn((call, child) => {
    // A partial write in staging is exactly what a failing analysis can leave.
    writeStagedArtifacts(projectPath, call.args);
    // The job attaches its stderr listener after `spawn` returns, so a real
    // child's first chunk always arrives after this handler.
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('first failure line\nsecond failure line\n'));
      setImmediate(() => child.emit('close', 7));
    });
  });
  const job = createArchguardRefreshJob({
    resolveProjectPath: () => projectPath,
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  job.start('project-1');
  await waitFor(() => job.status('project-1').state === 'failed');

  const status = job.status('project-1');
  assert.equal(status.exitCode, 7);
  assert.match(status.error ?? '', /exited with code 7/);
  assert.deepEqual(status.stderrTail, ['first failure line', 'second failure line']);
  assert.deepEqual(
    readFileSync(liveManifestPath),
    before,
    'the live manifest must not change when the analysis fails',
  );
});

test('a timeout kills the child and reports failed', async (t) => {
  const { projectPath, settingsPath } = createProject(t);
  writeJson(settingsPath, {
    architecture: { refresh: { cliPath: path.join(projectPath, 'fake-cli.mjs'), timeoutMs: 30, memoryLimitMb: 0 } },
  });
  const fake = makeSpawn((_call, child) => {
    // Never closes: the job's own ceiling has to end it.
    void child;
  });
  const job = createArchguardRefreshJob({
    resolveProjectPath: () => projectPath,
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  job.start('project-1');
  await waitFor(() => job.status('project-1').state === 'failed');

  const status = job.status('project-1');
  assert.match(status.error ?? '', /did not finish within 30 ms/);
  assert.deepEqual(fake.children[0]?.killSignals, ['SIGTERM']);
});

test('shutdown kills a running child and marks the job failed', async (t) => {
  const { projectPath, settingsPath } = createProject(t);
  const fake = makeSpawn((_call, child) => {
    void child;
  });
  const job = createArchguardRefreshJob({
    resolveProjectPath: () => projectPath,
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  job.start('project-1');
  await waitFor(() => fake.calls.length === 1);
  assert.equal(job.status('project-1').state, 'running');
  await job.shutdown();

  const status = job.status('project-1');
  assert.equal(status.state, 'failed');
  assert.match(status.error ?? '', /shut down/);
  assert.deepEqual(fake.children[0]?.killSignals, ['SIGTERM']);
});

test('an unresolvable CLI fails with a readable reason and never spawns', (t) => {
  const { projectPath, settingsPath } = createProject(t);
  writeJson(settingsPath, {
    architecture: { refresh: { cliPath: path.join(projectPath, 'no-such-archguard.js'), memoryLimitMb: 0 } },
  });
  const fake = makeSpawn(() => {});
  const job = createArchguardRefreshJob({
    resolveProjectPath: () => projectPath,
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  const start = job.start('project-1');
  assert.equal(fake.calls.length, 0, 'an unresolvable CLI must not spawn anything');
  assert.equal(start.status.state, 'failed');
  assert.match(start.status.error ?? '', /cliPath names .*no-such-archguard\.js, which does not exist/);
});

test('the spawn is an argv array with no shell, and the project root is the cwd', async (t) => {
  const { projectPath, settingsPath } = createProject(t);
  const fake = makeSpawn((call, child) => {
    writeStagedArtifacts(projectPath, call.args);
    setImmediate(() => child.emit('close', 0));
  });
  const job = createArchguardRefreshJob({
    resolveProjectPath: () => projectPath,
    settingsPath,
    spawnImpl: fake.spawn,
    hasSystemdRun: () => false,
  });

  job.start('project-1');
  await waitFor(() => job.status('project-1').state === 'succeeded');

  const call = fake.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.command, process.execPath);
  assert.ok(Array.isArray(call.args));
  assert.ok(call.args.includes('analyze'));
  assert.ok(call.args.includes('-f') && call.args.includes('json'));
  assert.equal(call.options.shell, undefined, 'the child must not be started through a shell');
  assert.equal(call.options.cwd, projectPath);
  assert.equal(call.options.detached, true, 'the child needs its own group so a kill reaches its workers');
  const sourceIndex = call.args.indexOf('-s');
  const sources = call.args.slice(sourceIndex + 1, call.args.indexOf('--lang'));
  assert.deepEqual(
    sources,
    [path.join(projectPath, 'src')],
    'the legacy chat scope is nested inside src and must not be analysed as its own scope',
  );
});

test('an unknown project id is a PROJECT_NOT_FOUND error, not an idle reading', (t) => {
  const { projectPath, settingsPath } = createProject(t);
  const job = createArchguardRefreshJob({
    resolveProjectPath: (projectId) => (projectId === 'project-1' ? projectPath : null),
    settingsPath,
    spawnImpl: makeSpawn(() => {}).spawn,
    hasSystemdRun: () => false,
  });

  for (const call of [() => job.start('nope'), () => job.status('nope')]) {
    assert.throws(call, (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.equal((failure as Error & { code?: string }).code, 'PROJECT_NOT_FOUND');
      return true;
    });
  }
});
