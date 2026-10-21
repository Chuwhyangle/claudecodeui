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

import {
  validateMermaid,
  type GenerateGraphResult,
  type GraphSeeds,
  type NeighborhoodEdge,
  type NeighborhoodNode,
} from '../generator.js';
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

/**
 * Write a one-scope project whose index is supplied wholesale.
 *
 * The JSON-reading criterion needs a fixture it can shape per case (a two-hop
 * chain; a 300-node fan), so this helper only owns the manifest and leaves the
 * index body to the caller.
 */
function createIndexProject(
  t: { after(callback: () => void): void },
  index: ScopeIndexFixture,
): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-neighborhood-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeJson(path.join(root, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    globalScopeKey: 'scope-src',
    scopes: [
      { key: 'scope-src', label: 'src (typescript)', language: 'typescript', sources: [path.join(root, 'src')] },
    ],
  });
  writeJson(path.join(root, '.archguard', 'query', 'scope-src', 'arch-index.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    archJsonHash: SRC_HASH,
    language: 'typescript',
    ...index,
  });
  return { root };
}

/** The subset of the response body the neighbourhood-JSON criteria read. */
type NeighborhoodBody = {
  graph: {
    file: { nodes: { id: string; label: string; distance: number }[]; edges: { from: string; to: string; relationType: string }[] };
    entity: { nodes: { id: string; label: string; distance: number }[]; edges: { from: string; to: string; relationType: string }[] };
  };
  stats: Record<string, unknown> & { truncated: boolean; entityNodes: number; entityEdges: number };
  provenance: { cacheHit: boolean };
};

/** Run one graph request against a temp project and return its parsed body. */
async function readGraphBody(
  root: string,
  transcript: NormalizedMessage[],
  request: Record<string, unknown> = {},
): Promise<NeighborhoodBody> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => transcript,
      }),
    ),
  );
  app.use(errorMiddleware);

  let body: NeighborhoodBody | null = null;
  await withServer(app, async (baseUrl) => {
    const response = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, ...request });
    assert.equal(response.status, 200);
    body = (await response.json()) as NeighborhoodBody;
  });
  if (body === null) throw new Error('the server never answered');
  return body;
}

test('the neighbourhood JSON carries true hop distances and each edge relationType', async (t) => {
  // A three-hop chain, each link a DIFFERENT relation type: Seed -dependency->
  // One -call-> Two -composition-> Three. Seeding `Seed` at hop 2 must retain
  // exactly the first two links and report distances 0/1/2.
  const { root } = createIndexProject(t, {
    fileToIds: { 'n0.ts': ['N0'], 'n1.ts': ['N1'], 'n2.ts': ['N2'], 'n3.ts': ['N3'] },
    nameToIds: { Seed: ['N0'], One: ['N1'], Two: ['N2'], Three: ['N3'] },
    idToFile: { N0: 'n0.ts', N1: 'n1.ts', N2: 'n2.ts', N3: 'n3.ts' },
    idToName: { N0: 'Seed', N1: 'One', N2: 'Two', N3: 'Three' },
    dependencies: { N0: ['N1'], N1: ['N2'], N2: ['N3'], N3: [] },
    dependents: { N0: [], N1: ['N0'], N2: ['N1'], N3: ['N2'] },
    relationsByType: {
      dependency: [['N0', 'N1']],
      call: [['N1', 'N2']],
      composition: [['N2', 'N3']],
    },
  });

  const body = await readGraphBody(root, [
    message({ id: 'text-1', kind: 'text', role: 'assistant', content: 'Start at `Seed`.' }),
  ], { hops: 2 });

  const entityDistances = new Map(body.graph.entity.nodes.map((node) => [node.id, node.distance]));
  assert.deepEqual(
    [...entityDistances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    [['scope-src/N0', 0], ['scope-src/N1', 1], ['scope-src/N2', 2]],
    'distance must be the BFS hop count from the seed over both adjacency directions',
  );
  assert.deepEqual(
    body.graph.entity.edges,
    [
      { from: 'scope-src/N0', to: 'scope-src/N1', relationType: 'dependency' },
      { from: 'scope-src/N1', to: 'scope-src/N2', relationType: 'call' },
    ],
    'every edge between retained nodes survives WITH its ArchGuard relation type; the N3 link is out of range',
  );

  // The file graph mirrors the entity reading: n0 at 0, n1 at 1, n2 at 2.
  const fileDistances = new Map(body.graph.file.nodes.map((node) => [node.id, node.distance]));
  assert.deepEqual(
    [...fileDistances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    [['src/n0.ts', 0], ['src/n1.ts', 1], ['src/n2.ts', 2]],
    'a file node inherits the closest distance of the entities it contains',
  );
  assert.deepEqual(
    body.graph.file.edges,
    [
      { from: 'src/n0.ts', to: 'src/n1.ts', relationType: 'dependency' },
      { from: 'src/n1.ts', to: 'src/n2.ts', relationType: 'call' },
    ],
  );
});

test('the neighbourhood JSON schema is pinned to the renderer contract fields', async (t) => {
  // The frontend renderer contract is written against these exact fields, so the
  // schema is pinned from both sides: at runtime each emitted object carries ONLY
  // the contract keys (the reserved `type` is never emitted, leaving old payloads
  // byte-identical), and at compile time the optional `type` admits a future node
  // kind while the three required node fields stay required.
  const { root } = createIndexProject(t, {
    fileToIds: { 'a.ts': ['A'], 'b.ts': ['B'] },
    nameToIds: { Alpha: ['A'], Beta: ['B'] },
    idToFile: { A: 'a.ts', B: 'b.ts' },
    idToName: { A: 'Alpha', B: 'Beta' },
    dependencies: { A: ['B'], B: [] },
    dependents: { A: [], B: ['A'] },
    relationsByType: { dependency: [['A', 'B']] },
  });

  const body = await readGraphBody(root, [
    message({ id: 'text-1', kind: 'text', role: 'assistant', content: 'Start at `Alpha`.' }),
  ], { hops: 1 });

  // Every node is id/label/distance — and nothing else, so `type` stays reserved
  // (an emitted value would change what old clients read).
  for (const node of [...body.graph.entity.nodes, ...body.graph.file.nodes]) {
    assert.deepEqual(
      Object.keys(node).sort(),
      ['distance', 'id', 'label'],
      `a node must carry exactly id/label/distance; got ${JSON.stringify(node)}`,
    );
  }
  // Every edge is from/to/relationType.
  for (const edge of [...body.graph.entity.edges, ...body.graph.file.edges]) {
    assert.deepEqual(
      Object.keys(edge).sort(),
      ['from', 'relationType', 'to'],
      `an edge must carry exactly from/to/relationType; got ${JSON.stringify(edge)}`,
    );
  }

  // Compile-time pins, checked by the server typecheck (`tsc -p server/tsconfig.json`):
  // a payload written before the reserved field existed still satisfies the schema…
  const legacyNode: NeighborhoodNode = { id: 'A', label: 'Alpha', distance: 0 };
  // …a future producer may add a node kind without a breaking change…
  const kindedNode: NeighborhoodNode = { id: 'B', label: 'Beta', distance: 1, type: 'class' };
  // …and `distance` remains required: dropping it must not typecheck.
  // @ts-expect-error — a node without `distance` must not satisfy NeighborhoodNode.
  const incompleteNode: NeighborhoodNode = { id: 'C', label: 'Gamma' };
  const edge: NeighborhoodEdge = { from: 'A', to: 'B', relationType: 'dependency' };

  assert.deepEqual(
    [legacyNode, kindedNode].map((node) => Object.keys(node).sort()),
    [['distance', 'id', 'label'], ['distance', 'id', 'label', 'type']],
  );
  assert.equal('distance' in incompleteNode, false);
  assert.deepEqual(Object.keys(edge).sort(), ['from', 'relationType', 'to']);
});

test('the loose default budget (2 hops / 2000 nodes) keeps all 300 edges instead of the old 200 cut', async (t) => {
  // One seed with 300 direct dependents: the old default `maxNodes: 200`
  // truncated this at 200 nodes and dropped 100 edges. The neighbourhood JSON
  // now ships the whole 301-node fan, and `truncated` stays false.
  const WIDTH = 300;
  const fileToIds: Record<string, string[]> = { 'w0.ts': ['W0'] };
  const nameToIds: Record<string, string[]> = { Wide: ['W0'] };
  const idToFile: Record<string, string> = { W0: 'w0.ts' };
  const idToName: Record<string, string> = { W0: 'Wide' };
  const dependencies: Record<string, string[]> = { W0: [] };
  const dependents: Record<string, string[]> = { W0: [] };
  const pairs: [string, string][] = [];
  for (let index = 1; index <= WIDTH; index += 1) {
    const id = `W${index}`;
    fileToIds[`w${index}.ts`] = [id];
    idToFile[id] = `w${index}.ts`;
    idToName[id] = `Wide ${index}`;
    dependencies[id] = ['W0'];
    dependents[id] = [];
    dependents.W0.push(id);
    pairs.push([id, 'W0']);
  }

  const { root } = createIndexProject(t, {
    fileToIds,
    nameToIds,
    idToFile,
    idToName,
    dependencies,
    dependents,
    relationsByType: { dependency: pairs },
  });

  const body = await readGraphBody(root, [
    message({ id: 'text-1', kind: 'text', role: 'assistant', content: '`Wide` is the entry.' }),
  ]);

  assert.equal(body.stats.entityNodes, WIDTH + 1, 'the default budget must not cut a 301-node neighbourhood');
  assert.equal(body.stats.entityEdges, WIDTH, 'every one-hop edge must survive the default budget');
  assert.equal(body.stats.truncated, false);
  assert.equal(body.graph.entity.nodes.length, WIDTH + 1);
  assert.equal(body.graph.entity.edges.length, WIDTH);
  assert.ok(body.graph.entity.edges.every((edge) => edge.relationType === 'dependency'));
  assert.equal(
    body.graph.entity.nodes.filter((node) => node.distance === 1).length,
    WIDTH,
    'each dependent sits exactly one hop from the seed',
  );
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
