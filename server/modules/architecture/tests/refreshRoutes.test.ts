/**
 * The manual re-analysis HTTP face: `POST /api/architecture/refresh` and
 * `GET /api/architecture/refresh/status`.
 *
 * The route factory is mounted on a real express server, exactly as production
 * mounts it, over the REAL refresh job with an injected spawn — so the coalescing
 * and the status readings are the job's own, not a hand-written stub's. The
 * architecture service is a stub: these two endpoints never call it.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/architecture/tests/refreshRoutes.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';

import express, {
  type Express,
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import { AppError } from '@/shared/utils.js';

import { createArchguardRefreshJob, type ArchguardRefreshJob, type RefreshSpawn } from '../refreshJob.js';
import { createArchitectureRoutes } from '../routes.js';
import type { ArchitectureService } from '../service.js';

const SCOPE_KEY = 'cccccccc';
const OLD_GENERATED_AT = '2026-10-01T00:00:00.000Z';
const NEW_GENERATED_AT = '2026-10-24T12:30:00.000Z';

type Behaviour = 'hold' | 'succeed' | 'fail';
type SpawnCall = { readonly command: string; readonly args: readonly string[]; readonly options: Record<string, unknown> };

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

/** A minimal project with a real `.archguard/query` tree and an existing settings file. */
function createProject(t: { after: (fn: () => void) => void }, label: string): string {
  const projectPath = mkdtempSync(path.join(tmpdir(), `archguard-refresh-routes-${label}-`));
  t.after(() => rmSync(projectPath, { recursive: true, force: true }));
  const srcDir = path.join(projectPath, 'src');
  mkdirSync(srcDir, { recursive: true });
  const liveQuery = path.join(projectPath, '.archguard', 'query');
  writeJson(path.join(liveQuery, 'manifest.json'), {
    version: '1.0',
    generatedAt: OLD_GENERATED_AT,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] }],
  });
  writeJson(path.join(liveQuery, SCOPE_KEY, 'arch-index.json'), { archJsonHash: 'old-hash' });
  writeFileSync(path.join(projectPath, 'fake-cli.mjs'), '// injected spawn only\n', 'utf8');
  writeJson(path.join(projectPath, 'server.settings.json'), {
    architecture: {
      refresh: { cliPath: path.join(projectPath, 'fake-cli.mjs'), timeoutMs: 5_000, memoryLimitMb: 0 },
    },
  });
  return projectPath;
}

function stagedArtifacts(call: SpawnCall): void {
  const workDir = call.args[call.args.indexOf('--work-dir') + 1];
  assert.ok(workDir !== undefined);
  writeJson(path.join(workDir, 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt: NEW_GENERATED_AT,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [path.join(String(call.options.cwd), 'src')] }],
  });
  writeJson(path.join(workDir, 'query', SCOPE_KEY, 'arch-index.json'), { archJsonHash: 'new-hash' });
}

function errorMiddleware(error: unknown, _request: ExpressRequest, response: ExpressResponse, next: NextFunction): void {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function postRefresh(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/architecture/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getStatus(baseUrl: string, projectId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/architecture/refresh/status?projectId=${encodeURIComponent(projectId)}`);
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('condition did not hold before the deadline'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

type StatusBody = {
  state: string;
  jobId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stage: string;
  elapsedMs: number;
  exitCode: number | null;
  stderrTail: string[];
  error: string | null;
};

const STUB_SERVICE = {
  readGraph: async () => {
    throw new Error('the refresh routes must not read the graph');
  },
  readMentions: async () => {
    throw new Error('the refresh routes must not read mentions');
  },
  readSearch: async () => {
    throw new Error('the refresh routes must not search');
  },
  readStructure: async () => {
    throw new Error('the refresh routes must not read the structure');
  },
} as unknown as ArchitectureService;

test('start answers 202, a concurrent second start coalesces, and the status GET reports every state', async (t) => {
  const holding = createProject(t, 'hold');
  const succeeding = createProject(t, 'succeed');
  const failing = createProject(t, 'fail');
  const known = new Map<string, string>([
    ['project-hold', holding],
    ['project-succeed', succeeding],
    ['project-fail', failing],
  ]);
  const calls: SpawnCall[] = [];
  const spawnImpl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    const child = new FakeChild();
    const behaviour: Behaviour = options.cwd === succeeding
      ? 'succeed'
      : options.cwd === failing
        ? 'fail'
        : 'hold';
    if (behaviour !== 'hold') {
      stagedArtifacts(call);
      setImmediate(() => {
        if (behaviour === 'fail') {
          child.stderr.emit('data', Buffer.from('analysis exploded\n'));
          setImmediate(() => child.emit('close', 3));
        } else {
          child.emit('close', 0);
        }
      });
    }
    return child as unknown as ChildProcess;
  }) as unknown as RefreshSpawn;
  const job: ArchguardRefreshJob = createArchguardRefreshJob({
    resolveProjectPath: (projectId) => known.get(projectId) ?? null,
    settingsPath: path.join(holding, 'server.settings.json'),
    spawnImpl,
    hasSystemdRun: () => false,
  });
  t.after(async () => {
    await job.shutdown();
  });

  const app = express();
  app.use(express.json());
  app.use('/api/architecture', createArchitectureRoutes(STUB_SERVICE, job));
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    // ① idle, before anything started.
    const idleResponse = await getStatus(baseUrl, 'project-hold');
    assert.equal(idleResponse.status, 200);
    const idle = (await idleResponse.json()) as StatusBody;
    assert.deepEqual(idle, {
      state: 'idle',
      jobId: null,
      startedAt: null,
      finishedAt: null,
      stage: 'idle',
      elapsedMs: 0,
      exitCode: null,
      stderrTail: [],
      error: null,
    });

    // ② the first start: 202, not coalesced, running.
    const firstResponse = await postRefresh(baseUrl, { projectId: 'project-hold' });
    assert.equal(firstResponse.status, 202);
    const first = (await firstResponse.json()) as { jobId: string; coalesced: boolean; status: StatusBody };
    assert.equal(first.coalesced, false);
    assert.equal(first.status.state, 'running');
    assert.equal(first.status.stage, 'preparing');
    assert.match(first.status.startedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(first.status.finishedAt, null);

    await waitFor(() => calls.length === 1);

    // ③ the concurrent second start joins the same job.
    const secondResponse = await postRefresh(baseUrl, { projectId: 'project-hold' });
    assert.equal(secondResponse.status, 202);
    const second = (await secondResponse.json()) as { jobId: string; coalesced: boolean; status: StatusBody };
    assert.equal(second.coalesced, true);
    assert.equal(second.jobId, first.jobId);
    assert.equal(calls.length, 1, 'the concurrent start must not spawn a second CLI');

    const runningResponse = await getStatus(baseUrl, 'project-hold');
    const running = (await runningResponse.json()) as StatusBody;
    assert.equal(running.state, 'running');
    assert.equal(running.jobId, first.jobId);

    // ④ succeeded: the staged analysis was installed and the reading is terminal.
    assert.equal((await postRefresh(baseUrl, { projectId: 'project-succeed' })).status, 202);
    await waitFor(() => job.status('project-succeed').state === 'succeeded');
    const succeeded = (await (await getStatus(baseUrl, 'project-succeed')).json()) as StatusBody;
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.exitCode, 0);
    assert.equal(succeeded.error, null);
    assert.match(succeeded.finishedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    // ⑤ failed: the reason and the stderr tail ride back.
    assert.equal((await postRefresh(baseUrl, { projectId: 'project-fail' })).status, 202);
    await waitFor(() => job.status('project-fail').state === 'failed');
    const failed = (await (await getStatus(baseUrl, 'project-fail')).json()) as StatusBody;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.exitCode, 3);
    assert.match(failed.error ?? '', /exited with code 3: analysis exploded/);
    assert.deepEqual(failed.stderrTail, ['analysis exploded']);
  });
});

test('the start body cannot choose a directory: only projectId is read', async (t) => {
  const projectPath = createProject(t, 'path');
  const calls: SpawnCall[] = [];
  const spawnImpl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options });
    return new FakeChild() as unknown as ChildProcess;
  }) as unknown as RefreshSpawn;
  const job = createArchguardRefreshJob({
    resolveProjectPath: (projectId) => (projectId === 'project-path' ? projectPath : null),
    settingsPath: path.join(projectPath, 'server.settings.json'),
    spawnImpl,
    hasSystemdRun: () => false,
  });
  t.after(async () => {
    await job.shutdown();
  });

  const app = express();
  app.use(express.json());
  app.use('/api/architecture', createArchitectureRoutes(STUB_SERVICE, job));
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const response = await postRefresh(baseUrl, {
      projectId: 'project-path',
      path: '/tmp/some-other-project',
      sources: ['/etc'],
    });
    assert.equal(response.status, 202);
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0]?.options.cwd, projectPath, 'the cwd must be the resolved project root');
    const sources = calls[0]?.args.slice(calls[0].args.indexOf('-s') + 1, calls[0].args.indexOf('--lang'));
    assert.deepEqual(sources, [path.join(projectPath, 'src')], 'the body cannot inject source directories');
  });
});

test('an unknown project id is a 4xx on both verbs', async (t) => {
  const projectPath = createProject(t, 'unknown');
  const job = createArchguardRefreshJob({
    resolveProjectPath: (projectId) => (projectId === 'project-known' ? projectPath : null),
    settingsPath: path.join(projectPath, 'server.settings.json'),
    spawnImpl: (() => {
      throw new Error('must not spawn');
    }) as unknown as RefreshSpawn,
    hasSystemdRun: () => false,
  });
  t.after(async () => {
    await job.shutdown();
  });

  const app = express();
  app.use(express.json());
  app.use('/api/architecture', createArchitectureRoutes(STUB_SERVICE, job));
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    for (const response of [
      await postRefresh(baseUrl, { projectId: 'project-missing' }),
      await getStatus(baseUrl, 'project-missing'),
    ]) {
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'PROJECT_NOT_FOUND');
    }
  });
});
