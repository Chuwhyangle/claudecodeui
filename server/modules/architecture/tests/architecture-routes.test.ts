/**
 * AC-418 — the `/api/architecture/graph` endpoint and the Tier-1 gate.
 *
 * The fixture is a REAL on-disk `.archguard/query` tree (a two-scope manifest
 * plus each scope's `arch-index.json`), written into a temp project directory,
 * so the service runs its real filesystem and merge path rather than a
 * pre-parsed index handed to the generator. The transcript reader and the
 * project lookup are the injected seams, exactly as production injects them.
 *
 * The three readings the AC names:
 *  ① a cached project answers `200` with `mmd { file, entity }`, `stats`
 *    (seed counts, unresolved, node/edge counts, truncated) and `provenance`
 *    (`generatedAt`, per-scope fingerprints, `cacheHit`);
 *  ② a project without `.archguard/query/manifest.json` reads
 *    `hasArchguardCache: false` and the endpoint refuses (404);
 *  ③ an empty transcript yields empty seeds and does NOT call the generator.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/architecture/tests/architecture-routes.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type Express,
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { validateMermaid, type GenerateGraphResult, type GraphSeeds } from '../generator.js';
import { createArchitectureRoutes } from '../routes.js';
import { createArchitectureService, hasArchguardCache } from '../service.js';

const MANIFEST_GENERATED_AT = '2026-10-20T15:52:34.427Z';
const SRC_HASH = 'a'.repeat(64);
const SERVER_HASH = 'b'.repeat(64);
const SESSION_ID = 'session-architecture';

type ScopeIndexFixture = Record<string, unknown>;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/**
 * Build a real `.archguard` query tree under a temp project root.
 *
 * `src` holds a two-entity neighbourhood with one dependency
 * (`A.y` imports `A.x`); `server` holds one unrelated entity. The two scopes
 * are enough to exercise the project-relative merge (each scope's keys are
 * relative to its own source directory).
 */
function createProject(t: { after(callback: () => void): void }): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-routes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeJson(path.join(root, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    globalScopeKey: 'scope-server',
    scopes: [
      { key: 'scope-src', label: 'src (typescript)', language: 'typescript', sources: [path.join(root, 'src')] },
      { key: 'scope-server', label: 'server (typescript)', language: 'typescript', sources: [path.join(root, 'server')] },
    ],
  });

  writeJson(path.join(root, '.archguard', 'query', 'scope-src', 'arch-index.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    archJsonHash: SRC_HASH,
    language: 'typescript',
    fileToIds: { 'a.ts': ['A.x'], 'a2.ts': ['A.y'] },
    nameToIds: { Alpha: ['A.x'], Beta: ['A.y'] },
    idToFile: { 'A.x': 'a.ts', 'A.y': 'a2.ts' },
    idToName: { 'A.x': 'Alpha', 'A.y': 'Beta' },
    dependencies: { 'A.x': [], 'A.y': ['A.x'] },
    dependents: { 'A.x': ['A.y'], 'A.y': [] },
  } satisfies ScopeIndexFixture);

  writeJson(path.join(root, '.archguard', 'query', 'scope-server', 'arch-index.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    archJsonHash: SERVER_HASH,
    language: 'typescript',
    fileToIds: { 'b.ts': ['B.z'] },
    nameToIds: { Gamma: ['B.z'] },
    idToFile: { 'B.z': 'b.ts' },
    idToName: { 'B.z': 'Gamma' },
    dependencies: { 'B.z': [] },
    dependents: { 'B.z': [] },
  } satisfies ScopeIndexFixture);

  return { root };
}

function message(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'message-1',
    sessionId: SESSION_ID,
    timestamp: '2026-10-21T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    ...overrides,
  } as NormalizedMessage;
}

/**
 * A transcript that names `src/a2.ts` (a real seed), a file outside every
 * scope (`docs/readme.md`, an unresolved seed), the identifier `Alpha`, and a
 * user line that must be ignored.
 */
function seededTranscript(root: string): NormalizedMessage[] {
  return [
    message({
      id: 'tool-1',
      kind: 'tool_use',
      role: 'assistant',
      toolName: 'Read',
      toolInput: { file_path: path.join(root, 'src', 'a2.ts') },
    }),
    message({
      id: 'tool-2',
      kind: 'tool_use',
      role: 'assistant',
      toolName: 'Read',
      toolInput: { file_path: path.join(root, 'docs', 'readme.md') },
    }),
    message({
      id: 'text-1',
      kind: 'text',
      role: 'assistant',
      content: 'The entry point is `Alpha`, which Beta imports.',
    }),
    message({ id: 'text-2', kind: 'text', role: 'user', content: 'Thanks' }),
  ];
}

/** The process error middleware, reproduced so the route's `AppError`s read as they do in production. */
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

function postGraph(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/architecture/graph`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a cached project answers mmd + stats + provenance, and a repeated call is a cache hit', async (t) => {
  const { root } = createProject(t);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: (projectId) => (projectId === 'project-1' ? root : null),
        readSessionHistory: async () => seededTranscript(root),
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const first = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID });
    assert.equal(first.status, 200);
    const body = (await first.json()) as {
      mmd: { file: string; entity: string };
      stats: Record<string, unknown> & { unresolved: { files: string[]; identifiers: string[] } };
      provenance: { generatedAt: string; fingerprints: { scope: string; archJsonHash: string }[]; cacheHit: boolean };
    };

    // ① both Mermaid documents are renderable and self-contained.
    assert.equal(validateMermaid(body.mmd.file).length, 0, 'file graph must be valid Mermaid');
    assert.equal(validateMermaid(body.mmd.entity).length, 0, 'entity graph must be valid Mermaid');
    assert.match(body.mmd.file, /flowchart LR/);
    assert.match(body.mmd.entity, /Alpha/);

    // ② the seed readout: two file seeds were named, one of them unresolved,
    //    and two identifier seeds matched (`Alpha` from the backtick span,
    //    `Beta` from the PascalCase rule).
    assert.equal(body.stats.seedFiles, 2);
    assert.equal(body.stats.seedIdentifiers, 2);
    assert.deepEqual(body.stats.unresolved.files, ['docs/readme.md']);
    assert.deepEqual(body.stats.unresolved.identifiers, []);

    // ③ expansion (one hop, both directions) retained both src entities and
    //    their edge; the project-relative file keys are what the file graph shows.
    assert.equal(body.stats.entityNodes, 2);
    assert.equal(body.stats.entityEdges, 1);
    assert.equal(body.stats.fileNodes, 2);
    assert.equal(body.stats.fileEdges, 1);
    assert.equal(body.stats.nodeCount, 4);
    assert.equal(body.stats.edgeCount, 2);
    assert.equal(body.stats.truncated, false);
    assert.match(body.mmd.file, /src\/a\.ts/);
    assert.match(body.mmd.file, /src\/a2\.ts/);

    // ④ provenance is the ArchGuard analysis time and both scope fingerprints.
    assert.equal(body.provenance.generatedAt, MANIFEST_GENERATED_AT);
    assert.deepEqual(
      body.provenance.fingerprints.map((entry) => entry.scope),
      ['scope-src', 'scope-server'],
    );
    assert.deepEqual(
      body.provenance.fingerprints.map((entry) => entry.archJsonHash),
      [SRC_HASH, SERVER_HASH],
    );
    assert.equal(body.provenance.cacheHit, false, 'the first identical call is a miss');

    const second = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID });
    assert.equal(second.status, 200);
    const repeat = (await second.json()) as typeof body & { provenance: typeof body.provenance };
    assert.equal(repeat.provenance.cacheHit, true, 'an identical call must hit the result cache');
    assert.deepEqual(repeat.mmd, body.mmd, 'the cached reading is the same graph');
  });
});

test('a project without .archguard/query/manifest.json reads hasArchguardCache=false and the endpoint refuses', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-routes-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(hasArchguardCache(root), false, 'no manifest ⇒ the Tier-1 gate is false');

  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => [],
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const response = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID });
    assert.equal(response.status, 404);
    const body = (await response.json()) as {
      error: { code: string; details?: { hasArchguardCache?: boolean } };
    };
    assert.equal(body.error.code, 'ARCHGUARD_CACHE_NOT_FOUND');
    assert.equal(body.error.details?.hasArchguardCache, false);
  });
});

test('an empty transcript yields empty seeds and never calls the generator', async (t) => {
  const { root } = createProject(t);
  assert.equal(hasArchguardCache(root), true, 'the fixture project does have a manifest');

  const generatorCalls: Array<{ seeds: GraphSeeds }> = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => [
          message({ id: 'text-1', kind: 'text', role: 'user', content: 'Hello' }),
        ],
        generateGraph: (...args): GenerateGraphResult => {
          generatorCalls.push({ seeds: args[1] });
          throw new Error('generateGraph must not be called for an empty seed list');
        },
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const response = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      mmd: { file: string; entity: string };
      stats: Record<string, number>;
      provenance: { cacheHit: boolean };
    };
    assert.equal(generatorCalls.length, 0, 'the empty-seed short circuit must not reach the generator');
    assert.equal(body.stats.seedFiles, 0);
    assert.equal(body.stats.seedIdentifiers, 0);
    assert.equal(body.stats.nodeCount, 0);
    assert.equal(body.stats.edgeCount, 0);
    assert.match(body.mmd.file, /flowchart LR/);
    assert.match(body.mmd.entity, /flowchart LR/);
    assert.equal(body.provenance.cacheHit, false);
  });
});

test('a missing project or a malformed body is refused with the transport code, not a 500', async (t) => {
  const { root } = createProject(t);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: (projectId) => (projectId === 'project-1' ? root : null),
        readSessionHistory: async () => seededTranscript(root),
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const unknownProject = await postGraph(baseUrl, { projectId: 'nope', sessionId: SESSION_ID });
    assert.equal(unknownProject.status, 404);
    const unknownBody = (await unknownProject.json()) as { error: { code: string } };
    assert.equal(unknownBody.error.code, 'PROJECT_NOT_FOUND');

    const malformed = await postGraph(baseUrl, { projectId: 'project-1' });
    assert.equal(malformed.status, 400);
    const malformedBody = (await malformed.json()) as { error: { code: string } };
    assert.equal(malformedBody.error.code, 'INVALID_REQUEST');

    const negative = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, hops: -1 });
    assert.equal(negative.status, 400);
  });
});
