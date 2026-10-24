import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  classifyDeployStatus,
  createDeployReadinessService,
  taskIdFromSubject,
  verifyPendingDeploy,
  type DeployCommandResult,
  type DeployGitReading,
  type DeployLastDeploy,
  type DeployPersistedState,
} from '../deploy-readiness.service.js';
import { createSystemRouter } from '../system.routes.js';
import type { createSystemUpdateService } from '../system.service.js';

const NOW = 1_790_000_000_000;

async function withTempRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'deploy-readiness-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Writes one fingerprint the way both build scripts do. */
function writeFingerprint(root: string, relativePath: string, gitSha: string | null): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ gitSha, builtAt: '2026-10-24T00:00:00.000Z' }));
}

type Commit = { sha: string; subject: string; paths: string[] };

function stubGit(headSha: string | null, commits: Commit[] = []): DeployGitReading {
  return {
    headSha: () => headSha,
    commitsBetween: (fromSha, toSha) => {
      assert.equal(typeof fromSha, 'string');
      assert.equal(typeof toSha, 'string');
      return commits;
    },
  };
}

type BuildOverrides = {
  runningSha?: string | null;
  builtSha?: string | null;
  clientSha?: string | null;
  headSha?: string | null;
  commits?: Commit[];
  state?: DeployPersistedState | null;
};

/**
 * Builds the production service over a temp app root. `readState`/`writeState` are in-memory
 * (the AC1 cases are about classification, not persistence), and the build/restart adapters are
 * stubs that record every call — the AC2 arm asserts their call counts.
 */
function createService(
  root: string,
  overrides: BuildOverrides = {},
): {
  service: ReturnType<typeof createDeployReadinessService>;
  restartCalls: string[][];
  buildCalls: { count: number };
  writtenStates: DeployPersistedState[];
} {
  const runningSha = overrides.runningSha === undefined ? 'a'.repeat(40) : overrides.runningSha;
  const builtSha = overrides.builtSha === undefined ? runningSha : overrides.builtSha;
  const clientSha = overrides.clientSha === undefined ? builtSha : overrides.clientSha;
  if (builtSha !== null) {
    writeFingerprint(root, path.join('dist-server', 'build-info.json'), builtSha);
  }
  if (clientSha !== null) {
    writeFingerprint(root, path.join('dist', 'build-info.json'), clientSha);
  }

  let state = overrides.state ?? null;
  const restartCalls: string[][] = [];
  const buildCalls = { count: 0 };
  const writtenStates: DeployPersistedState[] = [];

  const service = createDeployReadinessService({
    appRoot: root,
    runningBuildInfo: { gitSha: runningSha, builtAt: null },
    git: stubGit(overrides.headSha === undefined ? builtSha : overrides.headSha, overrides.commits),
    readState: () => state,
    writeState: (next) => {
      state = next;
      writtenStates.push(next);
    },
    runBuild: async () => ({ exitCode: 0, output: 'built', errorOutput: '' }),
    runRestartScript: async (args) => {
      restartCalls.push(args);
      return { exitCode: 0, output: 'restart launched', errorOutput: '' };
    },
    now: () => NOW,
    cacheTtlMs: 0,
  });

  return { service, restartCalls, buildCalls, writtenStates };
}

// --------------------------- AC1: the three-sha reading ---------------------------

test('AC1: three equal shas read as fresh', async () => {
  await withTempRoot(async (root) => {
    const { service } = createService(root);
    const reading = await service.readReadiness();
    assert.equal(reading.status, 'fresh');
    assert.deepEqual(reading.pendingCommits, []);
    assert.equal(reading.lastDeploy, null);
  });
});

test('AC1: HEAD ahead with commits touching src/ or server/ reads as pending-build and lists them', async () => {
  await withTempRoot(async (root) => {
    const { service } = createService(root, {
      headSha: 'f'.repeat(40),
      commits: [
        {
          sha: 'c1',
          subject: 'src: draw the deploy strip',
          paths: ['src/modules/cockpit/DeployReadiness.tsx'],
        },
        {
          sha: 'c2',
          subject: 'tasks: deploy-readiness-build-and-safe-restart task_write by cli:1',
          paths: ['tasks/deploy-readiness-build-and-safe-restart.md', 'server/modules/system/system.routes.ts'],
        },
        { sha: 'c3', subject: 'docs: explain the ladder', paths: ['docs/proposals/x.md'] },
      ],
    });

    const reading = await service.readReadiness();
    assert.equal(reading.status, 'pending-build');
    // Only the two commits that touch application source are listed; the docs commit is not.
    assert.deepEqual(
      reading.pendingCommits.map((commit) => commit.sha),
      ['c1', 'c2'],
    );
    assert.equal(reading.pendingCommits[1]?.taskId, 'deploy-readiness-build-and-safe-restart');
    assert.equal(reading.pendingCommits[0]?.subject, 'src: draw the deploy strip');
  });
});

test('AC1: a HEAD ahead of only docs/ and tasks/ reads as fresh (nothing to build)', async () => {
  await withTempRoot(async (root) => {
    const { service } = createService(root, {
      headSha: 'f'.repeat(40),
      commits: [
        { sha: 'c1', subject: 'docs: proposal', paths: ['docs/proposals/x.md'] },
        { sha: 'c2', subject: 'tasks: fold', paths: ['tasks/x.md'] },
      ],
    });

    const reading = await service.readReadiness();
    assert.equal(reading.status, 'fresh');
    assert.deepEqual(reading.pendingCommits, []);
  });
});

test('AC1: built artifacts at HEAD while the running process is not reads as built-pending-restart', async () => {
  await withTempRoot(async (root) => {
    const head = 'f'.repeat(40);
    const { service } = createService(root, {
      runningSha: 'a'.repeat(40),
      builtSha: head,
      clientSha: head,
      headSha: head,
    });

    const reading = await service.readReadiness();
    assert.equal(reading.status, 'built-pending-restart');
    assert.equal(reading.runningSha, 'a'.repeat(40));
    assert.equal(reading.builtSha, head);
  });
});

test('AC1: no fingerprint at all reads as unknown (a tsx dev instance has none)', async () => {
  await withTempRoot(async (root) => {
    const { service } = createService(root, {
      runningSha: null,
      builtSha: null,
      clientSha: null,
      headSha: 'a'.repeat(40),
    });

    const reading = await service.readReadiness();
    assert.equal(reading.status, 'unknown');
    assert.equal(reading.runningSha, null);
  });
});

test('task ids are read from the two subject conventions the task store uses', () => {
  assert.equal(taskIdFromSubject('tasks: cockpit-x task_write by cli:1'), 'cockpit-x');
  assert.equal(
    taskIdFromSubject("Merge branch 'develop' into task/deploy-readiness-build-and-safe-restart"),
    'deploy-readiness-build-and-safe-restart',
  );
  assert.equal(taskIdFromSubject('quay: unrelated change'), null);
});

test('an in-flight build overrides the fingerprint reading', () => {
  assert.deepEqual(
    classifyDeployStatus({
      runningSha: 'a',
      builtSha: 'a',
      clientBuiltSha: 'a',
      headSha: 'a',
      inFlight: 'building',
      commitsBetween: () => [],
    }),
    { status: 'building', pendingCommits: [] },
  );
});

// --------------------------- AC2: POST /api/system/deploy ---------------------------

/** A system-update service enough for the router's other route; the deploy arm is what is tested. */
function unusedUpdateService(): ReturnType<typeof createSystemUpdateService> {
  return {
    updateSystem: async () => ({ success: true as const, output: '', message: '' }),
  } as unknown as ReturnType<typeof createSystemUpdateService>;
}

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  buildResult: DeployCommandResult,
): Promise<{ restartCalls: string[][]; buildCount: () => number }> {
  let restartCalls: string[][] = [];
  let buildCalls = 0;

  await withTempRoot(async (root) => {
    const service = createDeployReadinessService({
      appRoot: root,
      runningBuildInfo: { gitSha: 'a'.repeat(40), builtAt: null },
      git: stubGit('a'.repeat(40)),
      readState: () => null,
      writeState: () => undefined,
      runBuild: async () => {
        buildCalls += 1;
        return buildResult;
      },
      runRestartScript: async (args) => {
        restartCalls.push(args);
        return { exitCode: 0, output: 'launched', errorOutput: '' };
      },
      now: () => NOW,
      cacheTtlMs: 0,
    });

    const app = express();
    app.use(express.json());
    // The composition root mounts `authenticateToken` before this router; the criterion stands
    // in for that guard exactly as the architecture route tests do, so a request with no bearer
    // token must be refused before the route can start a build.
    app.use('/api/system', (request, response, next) => {
      if (request.headers.authorization === undefined) {
        response.status(401).json({ error: 'Access denied. No token provided.', code: 'AUTH_TOKEN_INVALID' });
        return;
      }
      next();
    });
    app.use('/api/system', createSystemRouter(unusedUpdateService(), service));

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  return { restartCalls, buildCount: () => buildCalls };
}

test('AC2: a failed build never calls the restart stub and the reading carries step + output tail', async () => {
  const { restartCalls } = await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/deploy`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 500);
    const body = (await response.json()) as {
      ok: boolean;
      step: string;
      outputTail: string;
      readiness: { failure: { step: string; outputTail: string } | null };
    };
    assert.equal(body.ok, false);
    assert.equal(body.step, 'build');
    assert.match(body.outputTail, /boom/);
    assert.equal(body.readiness.failure?.step, 'build');
    assert.match(body.readiness.failure?.outputTail ?? '', /boom/);
  }, { exitCode: 1, output: '', errorOutput: 'build boom: tsc failed' });

  assert.equal(restartCalls.length, 0);
});

test('AC2: a successful build calls the restart stub exactly once with --delay', async () => {
  const { restartCalls } = await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/deploy`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; step: string; targetSha: string };
    assert.equal(body.ok, true);
    assert.equal(body.step, 'restart');
  }, { exitCode: 0, output: 'built', errorOutput: '' });

  assert.equal(restartCalls.length, 1);
  assert.ok(restartCalls[0]?.includes('--delay'), `restart argv: ${JSON.stringify(restartCalls[0])}`);
});

test('AC2: an unauthenticated deploy is refused with 401 and starts nothing', async () => {
  const { restartCalls, buildCount } = await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/deploy`, { method: 'POST' });
    assert.equal(response.status, 401);
  }, { exitCode: 0, output: 'built', errorOutput: '' });

  assert.equal(buildCount(), 0);
  assert.equal(restartCalls.length, 0);
});

// --------------------------- AC3: the boot verification ---------------------------

type VerificationOverrides = {
  runningSha?: string | null;
  targetSha?: string;
  state?: DeployPersistedState | null;
  statuses?: { root: number | null; cockpit: number | null };
  fleetState?: string | null;
};

function verify(
  overrides: VerificationOverrides = {},
): {
  lastDeploy: Promise<DeployLastDeploy | null>;
  written: DeployPersistedState[];
} {
  const written: DeployPersistedState[] = [];
  const state: DeployPersistedState | null = overrides.state === undefined
    ? {
        targetSha: overrides.targetSha ?? 'a'.repeat(40),
        requestedAt: new Date(NOW).toISOString(),
        phase: 'restarting',
      }
    : overrides.state;
  const statuses = overrides.statuses ?? { root: 200, cockpit: 200 };

  return {
    written,
    lastDeploy: verifyPendingDeploy({
      runningSha: overrides.runningSha === undefined ? 'a'.repeat(40) : overrides.runningSha,
      readState: () => state,
      writeState: (next) => {
        written.push(next);
      },
      probeRoute: async (name) => statuses[name],
      readFleetState: async () => (overrides.fleetState === undefined ? 'ok' : overrides.fleetState),
      now: () => NOW,
    }),
  };
}

test('AC3: matching sha and 200 checks record lastDeploy.ok === true', async () => {
  const { lastDeploy, written } = verify();
  const result = await lastDeploy;
  assert.equal(result?.ok, true);
  assert.equal(result?.targetSha, 'a'.repeat(40));
  assert.ok(result?.checks.every((check) => check.ok));
  // The verdict is persisted so a later reading (and the next boot) can see it.
  assert.equal(written.at(-1)?.lastDeploy?.ok, true);
  assert.equal(written.at(-1)?.phase, 'verified');
});

test('AC3: a sha mismatch makes ok false and names the failing check', async () => {
  const { lastDeploy } = verify({ runningSha: 'b'.repeat(40) });
  const result = await lastDeploy;
  assert.equal(result?.ok, false);
  const failed = result?.checks.filter((check) => !check.ok).map((check) => check.name) ?? [];
  assert.deepEqual(failed, ['build-sha']);
});

test('AC3: a non-200 route check also makes ok false and is named', async () => {
  const { lastDeploy } = verify({ statuses: { root: 200, cockpit: 404 } });
  const result = await lastDeploy;
  assert.equal(result?.ok, false);
  assert.deepEqual(
    result?.checks.filter((check) => !check.ok).map((check) => check.name),
    ['route-cockpit'],
  );
});

test('AC3: no state file produces no lastDeploy', async () => {
  const { lastDeploy, written } = verify({ state: null });
  assert.equal(await lastDeploy, null);
  assert.deepEqual(written, []);
});
