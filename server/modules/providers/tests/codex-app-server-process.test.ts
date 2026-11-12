import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startCodexAppServerProcess } from '@/modules/providers/list/codex/app-server/codex-app-server-process.js';
import { codexAppServer } from '@/modules/providers/list/codex/app-server/codex-app-server.client.js';

/**
 * The criterion for AC-447: stopping a `codex app-server` means stopping the
 * process group it leads, and returning only once the group is empty.
 *
 * WHY THIS EXISTS. The edit/rewind criteria spawn the real app-server against a
 * temporary `CODEX_HOME` and remove that home in their teardown. The CLI starts
 * descendants (plugin-sync git among them) that survived the old bare
 * `child.kill()` for up to a second and kept writing under the home, so the
 * final `rmdir` intermittently failed with ENOTEMPTY under load while the same
 * tree passed when idle. The four arms below are the discriminating readings:
 * (a) a grandchild dies with the group, (b) a SIGTERM-ignoring child is killed
 * by escalation, (c) the OLD behavior (bare `child.kill()`) demonstrably leaves
 * the grandchild running, and (d) the real packaged CLI leaves no process bound
 * to its `CODEX_HOME` once `model/list` returns and the home removes in one
 * un-retried pass.
 *
 * Linux-only readings: `/proc` is the existence and environ probe. On other
 * platforms the arms skip rather than pass vacuously.
 */

const LINUX = process.platform === 'linux';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** `/proc/<pid>` is the authoritative existence probe on Linux. */
const processExists = (pid: number): boolean => existsSync(`/proc/${pid}`);

async function waitForPidFile(file: string, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(file, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // Not written yet.
    }
    await delay(20);
  }
  throw new Error(`fixture did not report a pid within ${timeoutMs}ms (${file})`);
}

async function waitForLeaderExit(owner: { child: { exitCode: number | null; signalCode: string | null } }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (owner.child.exitCode === null && owner.child.signalCode === null) {
    if (Date.now() >= deadline) {
      throw new Error('the direct child did not exit within 15s');
    }
    await delay(20);
  }
}

/**
 * Writes one fixture script. It is launched exactly the way the product
 * launches the CLI — `process.execPath <launcher> <args...>` — so the arms test
 * the same start/stop path, not a parallel one.
 */
async function writeFixtureScript(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `${body}\n`, 'utf8');
  return file;
}

/** Leader that starts a long-lived grandchild and records its pid. */
const GRANDCHILD_FIXTURE = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(grandchild.pid));
setInterval(() => {}, 1000);
`;

/** Leader that refuses SIGTERM, so only escalation can end it. */
const SIGTERM_IGNORING_FIXTURE = `
import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`;

function hasBundledCodexLauncher(): boolean {
  try {
    createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    return true;
  } catch {
    return false;
  }
}

/**
 * Every live process whose environment names this exact `CODEX_HOME`.
 *
 * The test process itself carries the variable too, so it is excluded by pid.
 * A leftover descendant of the stopped app-server would show up here even after
 * being reparented away from the direct child.
 */
async function processesBoundTo(codexHome: string): Promise<number[]> {
  const needle = `CODEX_HOME=${codexHome}`;
  const bound: number[] = [];
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (pid === process.pid) {
      continue;
    }
    try {
      const environ = await readFile(`/proc/${pid}/environ`);
      if (environ.toString('utf8').split('\0').includes(needle)) {
        bound.push(pid);
      }
    } catch {
      // Exited between readdir and read, or not ours to read.
    }
  }
  return bound.sort((a, b) => a - b);
}

test('(a) a grandchild disappears with the group before stop() resolves', async (t) => {
  if (!LINUX) {
    t.skip('the /proc existence probe requires Linux');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-group-a-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const fixture = await writeFixtureScript(dir, 'leader.mjs', GRANDCHILD_FIXTURE);
  const owner = startCodexAppServerProcess(fixture, [pidFile]);
  try {
    const grandchild = await waitForPidFile(pidFile);
    assert.ok(processExists(grandchild), 'the fixture grandchild must be running before the stop');
    assert.equal(processExists(owner.pid as number), true, 'the leader must be running before the stop');

    const result = await owner.stop();
    assert.equal(result.groupStop, true, 'POSIX spawn must report a group stop');
    assert.equal(result.groupEmpty, true, 'stop() must only resolve once the group is empty');
    assert.equal(result.escalated, false, 'a well-behaved group needs no SIGKILL');
    assert.equal(processExists(grandchild), false, 'the grandchild must be gone when stop() returns');
    assert.equal(processExists(owner.pid as number), false, 'the leader must be gone when stop() returns');
  } finally {
    await owner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('(b) a SIGTERM-ignoring child is escalated to SIGKILL within the bounded wait', async (t) => {
  if (!LINUX) {
    t.skip('the /proc existence probe requires Linux');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-group-b-'));
  const pidFile = path.join(dir, 'leader.pid');
  const fixture = await writeFixtureScript(dir, 'leader.mjs', SIGTERM_IGNORING_FIXTURE);
  const owner = startCodexAppServerProcess(fixture, [pidFile], { graceMs: 150, killMs: 5_000 });
  try {
    const leader = await waitForPidFile(pidFile);
    assert.equal(processExists(leader), true);

    const result = await owner.stop();
    assert.equal(result.escalated, true, 'the grace must expire and SIGKILL must be sent');
    assert.equal(result.groupEmpty, true);
    assert.equal(processExists(leader), false, 'the escalated process must be gone when stop() returns');
  } finally {
    await owner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('(c) negative control: a bare child.kill() leaves the grandchild running', async (t) => {
  if (!LINUX) {
    t.skip('the /proc existence probe requires Linux');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-group-c-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const fixture = await writeFixtureScript(dir, 'leader.mjs', GRANDCHILD_FIXTURE);
  const owner = startCodexAppServerProcess(fixture, [pidFile]);
  try {
    const grandchild = await waitForPidFile(pidFile);
    assert.ok(processExists(grandchild));

    // The old behavior, byte for byte: signal the direct child only.
    assert.equal(owner.child.kill(), true, 'the direct child must accept the signal');
    await waitForLeaderExit(owner);

    assert.equal(
      processExists(grandchild),
      true,
      'the discriminator: only the direct child died, so the grandchild is still running',
    );

    // The group stop is what actually cleans up the fixture.
    const result = await owner.stop();
    assert.equal(result.groupEmpty, true);
    assert.equal(processExists(grandchild), false, 'the group stop must reach the survivor');
  } finally {
    await owner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('(d) the real packaged CLI leaves no process bound to its CODEX_HOME', async (t) => {
  if (!LINUX) {
    t.skip('the /proc environ probe requires Linux');
    return;
  }
  if (!hasBundledCodexLauncher()) {
    t.skip('the packaged @openai/codex launcher is not installed');
    return;
  }

  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-home-'));
  const codexHome = path.join(home, '.codex');
  // The CLI refuses to start when CODEX_HOME does not exist.
  await mkdir(codexHome, { recursive: true });
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const catalog = await codexAppServer.listModels();
    assert.ok(catalog, 'the packaged CLI must answer model/list; a null reading proves nothing about the stop');

    const leftovers = await processesBoundTo(codexHome);
    assert.deepEqual(
      leftovers,
      [],
      `no process may keep CODEX_HOME bound after model/list returns (leftovers: ${leftovers.join(',')})`,
    );

    // One removal, no maxRetries: the descendants that used to write here are
    // gone, so there is no writer left to race the traversal.
    await rm(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false, 'the temporary home must be removable in a single pass');
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
