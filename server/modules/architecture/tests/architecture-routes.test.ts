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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  generateGraph,
  validateMermaid,
  type GenerateGraphResult,
  type GraphSeeds,
  type NeighborhoodEdge,
  type NeighborhoodNode,
} from '../generator.js';
import { buildMentionIndex } from '../mentions.js';
import { createArchitectureRoutes } from '../routes.js';
import { mergeScopesWithHygiene } from '../scope-hygiene.js';
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

function postMentions(baseUrl: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/architecture/mentions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
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
    // This fixture has two overlapping-free scopes with relative ids, so the
    // hygiene merge changes nothing and the provenance keeps its pre-hygiene
    // key set exactly (only `diagnostics` is added, from the missing archives).
    assert.deepEqual(Object.keys(body.provenance), [
      'generatedAt',
      'fingerprints',
      'cacheHit',
      'diagnostics',
    ]);

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
 * index body to the caller. `archive` (optional) is written as the scope's
 * sibling `arch.json`, in ArchGuard's real shape — omitting it is exactly the
 * "no archive" degradation the criteria read.
 */
function createIndexProject(
  t: { after(callback: () => void): void },
  index: ScopeIndexFixture,
  archive?: unknown,
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
  if (archive !== undefined) {
    writeJson(path.join(root, '.archguard', 'query', 'scope-src', 'arch.json'), archive);
  }
  return { root };
}

/**
 * The `arch.json` sibling for a scope, carrying only the fields this module
 * reads (`entities[].id/type/isAbstract/members`) and spelling them exactly as
 * ArchGuard does: `property` for an interface/class field, `constructor` for a
 * constructor, `fieldType`/`returnType` for type annotations.
 */
function archiveWith(entities: readonly unknown[]): unknown {
  return { version: '1.0', language: 'typescript', entities };
}

/** The subset of the response body the neighbourhood-JSON criteria read. */
type NeighborhoodBody = {
  graph: {
    file: { nodes: { id: string; label: string; distance: number }[]; edges: { from: string; to: string; relationType: string }[] };
    entity: {
      nodes: {
        id: string;
        label: string;
        distance: number;
        kind?: string;
        members?: { name: string; kind: string; visibility?: string; signature?: string }[];
      }[];
      edges: { from: string; to: string; relationType: string }[];
    };
  };
  stats: Record<string, unknown> & {
    truncated: boolean;
    entityNodes: number;
    entityEdges: number;
    fileNodes: number;
    fileEdges: number;
    entityTruncated?: boolean;
    fileTruncated?: boolean;
    entityTotal?: number;
    fileTotal?: number;
    kindCounts?: Record<string, number>;
    membersPerEntity?: number;
    membersTruncated?: boolean;
  };
  provenance: {
    cacheHit: boolean;
    diagnostics?: { scope: string; code: string; message: string }[];
  };
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

  // Every node carries the three contract fields; an ENTITY seed additionally
  // carries the optional provenance pair, and the reserved `type` is never
  // emitted. The file graph has no seeds, so its nodes stay exactly three-key.
  const provenanceKeys = new Set(['mentionTier', 'mentionCount']);
  for (const node of body.graph.entity.nodes) {
    const extra = Object.keys(node).filter((key) => !['distance', 'id', 'label'].includes(key));
    assert.ok(extra.every((key) => provenanceKeys.has(key)), `unexpected entity node key; got ${JSON.stringify(node)}`);
  }
  for (const node of body.graph.file.nodes) {
    assert.deepEqual(
      Object.keys(node).sort(),
      ['distance', 'id', 'label'],
      `a file node must carry exactly id/label/distance; got ${JSON.stringify(node)}`,
    );
  }
  const seedNode = body.graph.entity.nodes.find((node) => node.distance === 0);
  assert.ok(seedNode !== undefined);
  assert.ok('mentionTier' in seedNode && 'mentionCount' in seedNode, 'a seed carries its provenance pair');
  assert.equal('type' in seedNode, false, 'the reserved type stays unemitted');
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

test('the file graph has its own budget: an entity cut does not shorten the file view', async (t) => {
  // A seed with five direct dependents, each in its own file. `maxNodes: 2`
  // keeps the seed plus one dependent, but the file graph is projected from the
  // FULL reachable set and budgeted separately, so it keeps all six files.
  const WIDTH = 5;
  const fileToIds: Record<string, string[]> = { 'f0.ts': ['F0'] };
  const nameToIds: Record<string, string[]> = { Seed: ['F0'] };
  const idToFile: Record<string, string> = { F0: 'f0.ts' };
  const idToName: Record<string, string> = { F0: 'Seed' };
  const dependencies: Record<string, string[]> = { F0: [] };
  const dependents: Record<string, string[]> = { F0: [] };
  const pairs: [string, string][] = [];
  for (let index = 1; index <= WIDTH; index += 1) {
    const id = `F${index}`;
    fileToIds[`f${index}.ts`] = [id];
    idToFile[id] = `f${index}.ts`;
    idToName[id] = `Fan ${index}`;
    dependencies[id] = ['F0'];
    dependents[id] = [];
    dependents.F0.push(id);
    pairs.push([id, 'F0']);
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
    message({ id: 'text-1', kind: 'text', role: 'assistant', content: 'Start at `Seed`.' }),
  ], { hops: 1, maxNodes: 2 });

  // The entity graph was cut at the requested budget…
  assert.equal(body.stats.entityTruncated, true, 'the entity set exceeded maxNodes');
  assert.equal(body.stats.entityNodes, 2, 'the entity graph keeps exactly the budget');
  assert.equal(body.stats.entityTotal, WIDTH + 1, 'the entity total is the pre-budget reachable count');
  assert.equal(body.graph.entity.nodes.length, 2);
  assert.equal(body.graph.entity.edges.length, 1, 'only the retained pair keeps its edge');

  // …but the file graph is complete: every reachable file and edge survives,
  // because its budget is its own and the projection runs on the full set.
  assert.equal(body.stats.fileTruncated, false, 'the entity cut must not truncate the file graph');
  assert.equal(body.stats.fileNodes, WIDTH + 1);
  assert.equal(body.stats.fileTotal, WIDTH + 1);
  assert.equal(body.graph.file.nodes.length, WIDTH + 1);
  assert.equal(body.graph.file.edges.length, WIDTH);
  assert.deepEqual(
    body.graph.file.nodes.map((node) => node.id).sort(),
    ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'].map((file) => `src/${file}`),
    'every reachable file is in the file graph',
  );

  // The legacy boolean stays the OR of the two granularities, so pre-existing
  // `truncated` consumers still see "something was cut".
  assert.equal(body.stats.truncated, true);
});

/*
 * The entity-detail criteria (kind/members/kindCounts) drive the same real
 * filesystem path as the rest of this file: a scope index plus the sibling
 * `arch.json` ArchGuard writes next to it. Four entities in a chain, so a node
 * budget can cut the graph while the kind counts still describe the full set.
 */
const DETAIL_CHAIN = {
  fileToIds: { 'k0.ts': ['k0.ts.Seed'], 'k1.ts': ['k1.ts.Middle'], 'k2.ts': ['k2.ts.Leaf'], 'k3.ts': ['k3.ts.Deep'] },
  nameToIds: { Seed: ['k0.ts.Seed'], Middle: ['k1.ts.Middle'], Leaf: ['k2.ts.Leaf'], Deep: ['k3.ts.Deep'] },
  idToFile: { 'k0.ts.Seed': 'k0.ts', 'k1.ts.Middle': 'k1.ts', 'k2.ts.Leaf': 'k2.ts', 'k3.ts.Deep': 'k3.ts' },
  idToName: { 'k0.ts.Seed': 'Seed', 'k1.ts.Middle': 'Middle', 'k2.ts.Leaf': 'Leaf', 'k3.ts.Deep': 'Deep' },
  dependencies: {
    'k0.ts.Seed': ['k1.ts.Middle'],
    'k1.ts.Middle': ['k2.ts.Leaf'],
    'k2.ts.Leaf': ['k3.ts.Deep'],
    'k3.ts.Deep': [],
  },
  dependents: {
    'k0.ts.Seed': [],
    'k1.ts.Middle': ['k0.ts.Seed'],
    'k2.ts.Leaf': ['k1.ts.Middle'],
    'k3.ts.Deep': ['k2.ts.Leaf'],
  },
};

/** The chain's real-shape `arch.json`, with 25 members on the seed class. */
function detailArchive(seedType: string, seedIsAbstract = false): unknown {
  const seedMembers = [
    {
      name: 'constructor',
      type: 'constructor',
      visibility: 'public',
      parameters: [{ name: 'a', type: 'number', isOptional: false }],
    },
    { name: 'count', type: 'property', visibility: 'private', fieldType: 'number' },
    ...Array.from({ length: 23 }, (_, index) => ({
      name: `run${index}`,
      type: 'method',
      visibility: 'public',
      parameters: [{ name: 'input', type: 'string', isOptional: true }],
      returnType: 'Promise<void>',
    })),
  ];
  return archiveWith([
    { id: 'k0.ts.Seed', name: 'Seed', type: seedType, isAbstract: seedIsAbstract, members: seedMembers },
    {
      id: 'k1.ts.Middle',
      name: 'Middle',
      type: 'interface',
      members: [{ name: 'id', type: 'property', visibility: 'public', fieldType: 'string' }],
    },
    { id: 'k2.ts.Leaf', name: 'Leaf', type: 'function', members: [] },
    { id: 'k3.ts.Deep', name: 'Deep', type: 'class', isAbstract: true, members: [] },
  ]);
}

const DETAIL_TRANSCRIPT = [
  message({ id: 'text-1', kind: 'text', role: 'assistant', content: 'Start at `Seed`.' }),
];

test('entity nodes carry the arch.json kind and members, with kindCounts over the pre-budget set', async (t) => {
  const { root } = createIndexProject(t, DETAIL_CHAIN, detailArchive('class'));
  const body = await readGraphBody(root, DETAIL_TRANSCRIPT, { hops: 3, maxNodes: 2 });

  console.log(
    `architecture detail reading: nodes=${JSON.stringify(body.graph.entity.nodes.map((node) => [node.id, node.kind, node.members?.length ?? 0]))} ` +
      `kindCounts=${JSON.stringify(body.stats.kindCounts)} membersPerEntity=${String(body.stats.membersPerEntity)} ` +
      `membersTruncated=${String(body.stats.membersTruncated)}`,
  );

  const seedNode = body.graph.entity.nodes.find((node) => node.id === 'scope-src/k0.ts.Seed');
  const middleNode = body.graph.entity.nodes.find((node) => node.id === 'scope-src/k1.ts.Middle');
  assert.ok(seedNode !== undefined && middleNode !== undefined, 'the retained nodes must be in the payload');
  assert.equal(body.graph.entity.nodes.length, 2, 'the node budget still cuts the graph');

  // ① kind comes from arch.json and is normalised onto the wire vocabulary.
  assert.equal(seedNode.kind, 'class');
  assert.equal(middleNode.kind, 'interface');

  // ② members are normalised from ArchGuard's spelling: constructor → method,
  //    property → field, with a display-ready signature; the 25-member class is
  //    cut at the shipped cap and the cut is reported.
  assert.equal(body.stats.membersPerEntity, 20);
  assert.equal(body.stats.membersTruncated, true);
  assert.equal(seedNode.members?.length, 20, 'the class ships exactly the shipped cap');
  assert.deepEqual(seedNode.members?.[0], {
    name: 'constructor',
    kind: 'method',
    visibility: 'public',
    signature: 'constructor(a: number)',
  });
  assert.deepEqual(seedNode.members?.[1], {
    name: 'count',
    kind: 'field',
    visibility: 'private',
    signature: 'number',
  });
  assert.deepEqual(seedNode.members?.[2], {
    name: 'run0',
    kind: 'method',
    visibility: 'public',
    signature: 'run0(input?: string): Promise<void>',
  });
  assert.deepEqual(middleNode.members, [
    { name: 'id', kind: 'field', visibility: 'public', signature: 'string' },
  ]);

  // ③ kindCounts describes the PRE-budget reachable set — all four entities,
  //    including the two the node budget cut — and `abstract` is derived from
  //    the class's isAbstract flag, not a separate ArchGuard type.
  assert.deepEqual(body.stats.kindCounts, { class: 1, interface: 1, function: 1, abstract: 1 });
  assert.equal(body.stats.entityTotal, 4);
  assert.equal(body.stats.entityNodes, 2);

  // ④ the file graph is untouched by the detail path.
  for (const node of body.graph.file.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ['distance', 'id', 'label']);
  }
  assert.equal(body.provenance.diagnostics, undefined, 'a readable archive produces no diagnostic');
});

test('a scope without arch.json keeps the legacy node shape and names the degradation in provenance', async (t) => {
  const { root } = createIndexProject(t, DETAIL_CHAIN);
  const body = await readGraphBody(root, DETAIL_TRANSCRIPT, { hops: 3 });

  assert.equal(body.graph.entity.nodes.length, 4);
  for (const node of body.graph.entity.nodes) {
    // The legacy DETAIL shape is "no kind, no members". The provenance fields
    // are a separate, additive reading and are expected on distance-0 nodes.
    assert.deepEqual(
      Object.keys(node).filter((key) => key !== 'mentionTier' && key !== 'mentionCount').sort(),
      ['distance', 'id', 'label'],
      `a node from a scope without arch.json must keep the legacy detail shape; got ${JSON.stringify(node)}`,
    );
    assert.equal('kind' in node, false);
    assert.equal('members' in node, false);
  }
  assert.equal('kindCounts' in body.stats, false, 'no readable detail ⇒ no kind counts');

  // The degradation is VISIBLE, not swallowed: one diagnostic names the scope
  // and the reason, so a caller can tell "no classes here" from "no archive".
  assert.equal(body.provenance.diagnostics?.length, 1);
  assert.equal(body.provenance.diagnostics?.[0]?.scope, 'scope-src');
  assert.equal(body.provenance.diagnostics?.[0]?.code, 'ARCH_JSON_MISSING');
  assert.match(body.provenance.diagnostics?.[0]?.message ?? '', /arch\.json/);
});

test('an unparseable arch.json degrades to the legacy shape with an ARCH_JSON_INVALID diagnostic', async (t) => {
  const { root } = createIndexProject(t, DETAIL_CHAIN);
  // A truncated write is the shape this degradation exists for: the analysis
  // tree exists, but the sibling archive is not JSON.
  writeFileSync(path.join(root, '.archguard', 'query', 'scope-src', 'arch.json'), '{"entities": [');

  const body = await readGraphBody(root, DETAIL_TRANSCRIPT, { hops: 3 });
  for (const node of body.graph.entity.nodes) {
    assert.deepEqual(
      Object.keys(node).filter((key) => key !== 'mentionTier' && key !== 'mentionCount').sort(),
      ['distance', 'id', 'label'],
    );
    assert.equal('kind' in node, false);
    assert.equal('members' in node, false);
  }
  assert.equal(body.provenance.diagnostics?.[0]?.code, 'ARCH_JSON_INVALID');
  assert.equal(body.provenance.diagnostics?.[0]?.scope, 'scope-src');
});

test('a changed archJsonHash rebuilds kind/members and an unchanged one performs no second archive read', async (t) => {
  const { root } = createIndexProject(t, DETAIL_CHAIN, detailArchive('class'));
  // Production reads the archive through `fs.promises`; this seam records every
  // read so "the second request does no disk work" is a reading, not a belief.
  const archiveReads: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => DETAIL_TRANSCRIPT,
        readArchiveFile: async (filePath) => {
          archiveReads.push(filePath);
          return readFileSync(filePath, 'utf8');
        },
      }),
    ),
  );
  app.use(errorMiddleware);

  const indexPath = path.join(root, '.archguard', 'query', 'scope-src', 'arch-index.json');
  const archivePath = path.join(root, '.archguard', 'query', 'scope-src', 'arch.json');

  await withServer(app, async (baseUrl) => {
    const first = (await (await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, hops: 3 })).json()) as NeighborhoodBody;
    assert.equal(archiveReads.length, 1, 'the first request reads the archive exactly once');
    assert.equal(first.graph.entity.nodes.find((node) => node.id === 'scope-src/k0.ts.Seed')?.kind, 'class');

    const second = (await (await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, hops: 3 })).json()) as NeighborhoodBody;
    assert.equal(second.provenance.cacheHit, true, 'an identical request is a result-cache hit');
    assert.equal(archiveReads.length, 1, 'an unchanged fingerprint performs no second archive read');

    // Re-analysis: the index reports a new archJsonHash and the archive now
    // types the seed as a function. The mtime bump is what a real rewrite does.
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    index.archJsonHash = 'd'.repeat(64);
    writeJson(indexPath, index);
    writeJson(archivePath, detailArchive('function'));
    const bumped = new Date(Date.now() + 5_000);
    utimesSync(indexPath, bumped, bumped);

    const third = (await (await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, hops: 3 })).json()) as NeighborhoodBody;
    assert.equal(third.provenance.cacheHit, false, 'a new fingerprint is a cache miss by construction');
    assert.equal(archiveReads.length, 2, 'the new fingerprint re-reads the archive');
    assert.equal(
      third.graph.entity.nodes.find((node) => node.id === 'scope-src/k0.ts.Seed')?.kind,
      'function',
      'the node detail was rebuilt from the new archive, not served from the old one',
    );

    const fourth = (await (await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, hops: 3 })).json()) as NeighborhoodBody;
    assert.equal(fourth.provenance.cacheHit, true);
    assert.equal(archiveReads.length, 2, 'the rebuilt reading is memoised too');
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

/*
 * The on-demand provenance endpoint (`POST /api/architecture/mentions`).
 *
 * One scope with three entities sharing the name `main` and one uniquely-named
 * `Unique`; the transcript names both in prose, names `Unique` in a tool result
 * (the opt-in tier) and touches Unique's file through a Read tool. That is
 * enough to read every field of the response: candidate counts, ambiguity,
 * the default/opt-in split, path matching and edge co-mentions.
 */
const MENTION_INDEX: ScopeIndexFixture = {
  fileToIds: { 'm/a.ts': ['M.a'], 'm/b.ts': ['M.b'], 'm/c.ts': ['M.c'], 'm/u.ts': ['M.u'] },
  nameToIds: { main: ['M.a', 'M.b', 'M.c'], Unique: ['M.u'] },
  idToFile: { 'M.a': 'm/a.ts', 'M.b': 'm/b.ts', 'M.c': 'm/c.ts', 'M.u': 'm/u.ts' },
  idToName: { 'M.a': 'main', 'M.b': 'main', 'M.c': 'main', 'M.u': 'Unique' },
  dependencies: { 'M.a': [], 'M.b': [], 'M.c': [], 'M.u': [] },
  dependents: { 'M.a': [], 'M.b': [], 'M.c': [], 'M.u': [] },
};

function mentionTranscript(root: string): NormalizedMessage[] {
  return [
    message({ id: 'text-1', kind: 'text', role: 'user', content: 'We discussed `Unique` and main in one breath.' }),
    message({ id: 'text-2', kind: 'text', role: 'assistant', content: 'Only `Unique` is bound here; main is elsewhere.' }),
    message({ id: 'text-3', kind: 'text', role: 'user', content: '`main` and `Unique` share a page.' }),
    message({ id: 'result-1', kind: 'tool_result', toolId: 'call-r', content: 'Unique appears in the tool output' }),
    message({
      id: 'read-1',
      kind: 'tool_use',
      role: 'assistant',
      toolName: 'Read',
      toolInput: { file_path: path.join(root, 'src', 'm', 'u.ts') },
    }),
  ];
}

type MentionBody = {
  mentions: {
    entityId: string;
    candidateCount: number;
    ambiguous: boolean;
    hits: { messageId: string; role?: string; kind: string; excerpt: string; at: string }[];
  }[];
  edge?: { coMentions: MentionBody['mentions'][number]['hits'] };
  truncated: boolean;
};

async function readMentionsBody(
  root: string,
  transcript: NormalizedMessage[],
  request: Record<string, unknown>,
  buildMentionIndexOverride?: typeof buildMentionIndex,
): Promise<MentionBody> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => transcript,
        ...(buildMentionIndexOverride === undefined ? {} : { buildMentionIndex: buildMentionIndexOverride }),
      }),
    ),
  );
  app.use(errorMiddleware);

  let body: MentionBody | null = null;
  await withServer(app, async (baseUrl) => {
    const response = await postMentions(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID, ...request });
    assert.equal(response.status, 200);
    body = (await response.json()) as MentionBody;
  });
  if (body === null) throw new Error('the server never answered');
  return body;
}

test('mentions 唯一名字：命中都来自 fixture 历史，candidateCount=1 且不 ambiguous', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const transcript = mentionTranscript(root);
  const known = new Set(transcript.map((row) => row.id));

  const body = await readMentionsBody(root, transcript, { entityIds: ['scope-src/M.u'] });
  const unique = body.mentions[0];
  assert.ok(unique !== undefined);
  assert.equal(unique.entityId, 'scope-src/M.u');
  assert.equal(unique.candidateCount, 1);
  assert.equal(unique.ambiguous, false);
  assert.ok(unique.hits.length > 0, 'the unique name must have hits');
  for (const hit of unique.hits) {
    assert.ok(known.has(hit.messageId), `${hit.messageId} must exist in the fixture history`);
    assert.ok(hit.excerpt.length > 0, 'every hit carries an excerpt');
    assert.ok(hit.at.length > 0, 'every hit carries the message timestamp');
  }
  // The Read row names the entity's FILE, so its provenance is included too.
  assert.ok(unique.hits.some((hit) => hit.messageId === 'read-1'));
  assert.equal(body.truncated, false);
  console.log(`mentions reading: unique hits=${JSON.stringify(unique.hits.map((hit) => [hit.messageId, hit.kind]))}`);
});

test('mentions 同名候选：ambiguous=true 且 candidateCount 等于 nameToIds 长度', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const body = await readMentionsBody(root, mentionTranscript(root), { entityIds: ['scope-src/M.a'] });
  const main = body.mentions[0];
  assert.ok(main !== undefined);
  assert.equal(main.candidateCount, 3);
  assert.equal(main.ambiguous, true);
  assert.deepEqual(
    [...new Set(main.hits.map((hit) => hit.messageId))].sort(),
    ['text-1', 'text-2', 'text-3'],
    'every prose row that spells the shared name is a hit',
  );
  console.log(`mentions reading: main candidateCount=${main.candidateCount} ambiguous=${String(main.ambiguous)}`);
});

test('mentions 边：coMentions 是两端名字同条消息的命中', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const body = await readMentionsBody(root, mentionTranscript(root), {
    edge: { from: 'scope-src/M.a', to: 'scope-src/M.u' },
  });
  assert.ok(body.edge !== undefined);
  assert.deepEqual(
    body.edge.coMentions.map((hit) => hit.messageId).sort(),
    ['text-1', 'text-2', 'text-3'],
    'every row naming BOTH endpoints is a co-mention',
  );
  assert.deepEqual(body.mentions, [], 'an edge-only request returns no per-entity list');
  console.log(`mentions reading: coMentions=${JSON.stringify(body.edge.coMentions.map((hit) => hit.messageId))}`);
});

test('mentions includeToolResults：默认不含 tool_result，开启后多出该 kind', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const transcript = mentionTranscript(root);

  const byDefault = await readMentionsBody(root, transcript, { entityIds: ['scope-src/M.u'] });
  assert.ok(byDefault.mentions[0]?.hits.every((hit) => hit.kind !== 'tool_result'));

  const optedIn = await readMentionsBody(root, transcript, {
    entityIds: ['scope-src/M.u'],
    includeToolResults: true,
  });
  const toolHits = optedIn.mentions[0]?.hits.filter((hit) => hit.kind === 'tool_result') ?? [];
  assert.equal(toolHits.length, 1, 'the tool_result row is the only extra hit');
  assert.equal(toolHits[0]?.messageId, 'result-1');
  console.log(`mentions reading: defaultKinds=${JSON.stringify(byDefault.mentions[0]?.hits.map((hit) => hit.kind))}`);
});

test('mentions 扫描上限：超过 20000 条消息置 truncated', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const transcript: NormalizedMessage[] = [];
  for (let index = 0; index < 20_005; index += 1) {
    transcript.push(message({ id: `bulk-${index}`, kind: 'text', role: 'user', content: `row ${index}` }));
  }
  transcript.push(message({ id: 'last-row', kind: 'text', role: 'user', content: '`Unique` is last' }));

  const body = await readMentionsBody(root, transcript, { entityIds: ['scope-src/M.u'] });
  assert.equal(body.truncated, true, 'a history beyond the scan cap must report the cut');
  assert.ok(body.mentions[0]?.hits.some((hit) => hit.messageId === 'last-row'), 'the most recent rows are the ones scanned');
  console.log(`mentions reading: scanned cap truncated=${String(body.truncated)}`);
});

test('mentions 索引缓存：同一历史上第二次相同请求不重建倒排索引', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const transcript = mentionTranscript(root);
  let builds = 0;
  const countingBuild: typeof buildMentionIndex = (messages, options) => {
    builds += 1;
    return buildMentionIndex(messages, options);
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => transcript,
        buildMentionIndex: countingBuild,
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const request = { projectId: 'project-1', sessionId: SESSION_ID, entityIds: ['scope-src/M.u'] };
    assert.equal((await postMentions(baseUrl, request)).status, 200);
    assert.equal(builds, 1, 'the first request builds the index');
    assert.equal((await postMentions(baseUrl, request)).status, 200);
    assert.equal(builds, 1, 'the same history version must reuse the index');
    // The opt-in flag is part of the index identity, so it is a new build.
    assert.equal((await postMentions(baseUrl, { ...request, includeToolResults: true })).status, 200);
    assert.equal(builds, 2, 'a different tool-result mode needs its own index');
  });
  console.log(`mentions reading: builds=${builds}`);
});

/*
 * The route is mounted behind `authenticateToken` in `server/index.ts`; this
 * apps-level stand-in reproduces that mount (refuse a request with no bearer
 * token) so the transport criteria are read here too. The token value itself is
 * irrelevant — the middleware stops at its absence.
 */
/*
 * The element/relation filter, read through the real request path.
 *
 * One scope with three structural entities, one function and one class that is
 * reachable ONLY through the function. The archive supplies the kinds, the index
 * supplies typed relations (call + dependency + composition), and the transcript
 * names `Seed` — a unique name, so a `direct` tier seed.
 */
const FILTER_PROJECT_INDEX: ScopeIndexFixture = {
  fileToIds: {
    'a.ts': ['Seed'],
    'fn.ts': ['Fn'],
    'svc.ts': ['Svc'],
    'api.ts': ['Api'],
    'deep.ts': ['Deep'],
  },
  nameToIds: { Seed: ['Seed'], Fn: ['Fn'], Svc: ['Svc'], Api: ['Api'], Deep: ['Deep'] },
  idToFile: { Seed: 'a.ts', Fn: 'fn.ts', Svc: 'svc.ts', Api: 'api.ts', Deep: 'deep.ts' },
  idToName: { Seed: 'Seed', Fn: 'Fn', Svc: 'Svc', Api: 'Api', Deep: 'Deep' },
  dependencies: {
    Seed: ['Fn', 'Svc'],
    Fn: ['Deep'],
    Svc: ['Api'],
    Api: [],
    Deep: [],
  },
  dependents: {
    Seed: [],
    Fn: ['Seed'],
    Svc: ['Seed'],
    Api: ['Svc'],
    Deep: ['Fn'],
  },
  relationsByType: {
    call: [['Seed', 'Fn']],
    dependency: [['Seed', 'Svc'], ['Fn', 'Deep']],
    composition: [['Svc', 'Api']],
  },
};

const FILTER_ARCHIVE = archiveWith([
  { id: 'Seed', name: 'Seed', type: 'class', members: [] },
  { id: 'Fn', name: 'Fn', type: 'function', members: [] },
  { id: 'Svc', name: 'Svc', type: 'class', members: [] },
  { id: 'Api', name: 'Api', type: 'interface', members: [] },
  { id: 'Deep', name: 'Deep', type: 'class', members: [] },
]);

const STRUCTURAL_KIND_VALUES = ['class', 'interface', 'enum', 'abstract'];
const SEED_TRANSCRIPT = [
  message({ id: 'text-1', kind: 'text', role: 'assistant', content: 'Start at `Seed`.' }),
];

const entityIdSet = (body: NeighborhoodBody): string[] => body.graph.entity.nodes.map((node) => node.id).sort();
const edgeKeySet = (body: NeighborhoodBody): string[] =>
  body.graph.entity.edges.map((edge) => `${edge.from}->${edge.to}:${edge.relationType}`).sort();

type FilterBody = NeighborhoodBody & {
  mmd: { file: string; entity: string };
  stats: NeighborhoodBody['stats'] & {
    relationCounts?: Record<string, number>;
    mentionedByKind?: Record<string, number>;
    hidden?: {
      byKind: Record<string, number>;
      byRelation: Record<string, number>;
      isolated: number;
      mentionedByKind?: Record<string, number>;
    };
  };
};

test('no filter request keeps the pre-filter payload shape; the same reading is byte-identical', async (t) => {
  const { root } = createIndexProject(t, FILTER_PROJECT_INDEX, FILTER_ARCHIVE);

  const unfiltered = (await readGraphBody(root, SEED_TRANSCRIPT, { hops: 2 })) as FilterBody;
  console.log(
    `filter reading: unfiltered nodes=${JSON.stringify(entityIdSet(unfiltered))} ` +
      `statsKeys=${JSON.stringify(Object.keys(unfiltered.stats).sort())}`,
  );

  // ① Neither filter-only readout exists when the request carried no filter:
  //    the payload keeps its exact pre-filter key set, so an old client cannot
  //    tell the feature shipped.
  assert.equal('hidden' in unfiltered.stats, false, 'no filter ⇒ no hidden readout');
  assert.equal('relationCounts' in unfiltered.stats, false, 'no filter ⇒ no relation tally');
  assert.equal(unfiltered.stats.entityTotal, 5, 'the unfiltered two-hop scope is the whole chain');
  assert.deepEqual(entityIdSet(unfiltered), [
    'scope-src/Api',
    'scope-src/Deep',
    'scope-src/Fn',
    'scope-src/Seed',
    'scope-src/Svc',
  ]);

  // ② Explicitly asking for every kind and every relation is the SAME reading:
  //    same nodes, same edges, same Mermaid documents. That is what makes the
  //    absent-parameter path "the old behaviour" rather than a different mode.
  const explicitlyAll = (await readGraphBody(root, SEED_TRANSCRIPT, {
    hops: 2,
    kinds: ['class', 'interface', 'enum', 'abstract', 'function', 'other'],
    relations: ['dependency', 'call', 'composition', 'inheritance', 'implementation'],
  })) as FilterBody;
  assert.deepEqual(entityIdSet(explicitlyAll), entityIdSet(unfiltered));
  assert.deepEqual(edgeKeySet(explicitlyAll), edgeKeySet(unfiltered));
  assert.deepEqual(explicitlyAll.mmd, unfiltered.mmd, 'the export documents are identical too');
  assert.deepEqual(explicitlyAll.stats.hidden, {
    byKind: {},
    byRelation: {},
    isolated: 0,
    mentionedByKind: {},
  });
  assert.deepEqual(explicitlyAll.stats.relationCounts, { call: 1, dependency: 2, composition: 1 });
  // The mentioned denominator exists only because an element filter was asked
  // for: `Seed` is the one (class) mention in this transcript.
  assert.deepEqual(explicitlyAll.stats.mentionedByKind, { class: 1 });
  assert.equal('mentionedByKind' in unfiltered.stats, false, 'no element filter ⇒ no switch denominator');
});

test('a kinds filter hides a mentioned entity of a hidden kind, which still expands the scope', async (t) => {
  const { root } = createIndexProject(t, FILTER_PROJECT_INDEX, FILTER_ARCHIVE);

  const filtered = (await readGraphBody(root, SEED_TRANSCRIPT, {
    hops: 2,
    kinds: STRUCTURAL_KIND_VALUES,
  })) as FilterBody;
  console.log(
    `filter reading: kinds-only nodes=${JSON.stringify(entityIdSet(filtered))} ` +
      `edges=${JSON.stringify(edgeKeySet(filtered))} hidden=${JSON.stringify(filtered.stats.hidden)} ` +
      `relationCounts=${JSON.stringify(filtered.stats.relationCounts)}`,
  );

  assert.deepEqual(entityIdSet(filtered), ['scope-src/Api', 'scope-src/Seed', 'scope-src/Svc']);
  assert.equal(entityIdSet(filtered).includes('scope-src/Fn'), false, 'the function is hidden');
  assert.equal(
    entityIdSet(filtered).includes('scope-src/Deep'),
    false,
    'a class reachable ONLY through the hidden function is unreachable',
  );
  assert.deepEqual(edgeKeySet(filtered), [
    'scope-src/Seed->scope-src/Svc:dependency',
    'scope-src/Svc->scope-src/Api:composition',
  ]);
  assert.equal(filtered.stats.entityTotal, 3, 'the in-scope total the readout shows is the filtered one');

  // The hidden counts are UNFILTERED readings: one function, and every edge of
  // the unfiltered scope by type.
  assert.deepEqual(filtered.stats.hidden, {
    byKind: { function: 1 },
    byRelation: {},
    isolated: 0,
    mentionedByKind: {},
  });
  assert.deepEqual(filtered.stats.relationCounts, { call: 1, dependency: 2, composition: 1 });
  // The element popover can still say "1 function" while hiding it.
  assert.deepEqual(filtered.stats.kindCounts, { class: 3, function: 1, interface: 1 });
  // …and the switch's own denominator is unfiltered too: `Seed` is the mention.
  assert.deepEqual(filtered.stats.mentionedByKind, { class: 1 });

  // Naming `Fn` DIRECTLY in the transcript no longer exempts it: it is hidden
  // like any other function, but it stays a ROOT, so its class neighbour
  // `Deep` (reachable only through it) is now in scope.
  const mentionedTranscript = [
    ...SEED_TRANSCRIPT,
    message({ id: 'text-2', kind: 'text', role: 'assistant', content: 'It calls `Fn` directly.' }),
  ];
  const mentionedHidden = (await readGraphBody(root, mentionedTranscript, {
    hops: 2,
    kinds: STRUCTURAL_KIND_VALUES,
  })) as FilterBody;
  assert.equal(
    entityIdSet(mentionedHidden).includes('scope-src/Fn'),
    false,
    'a directly mentioned function of a hidden kind is not drawn by default',
  );
  assert.ok(
    entityIdSet(mentionedHidden).includes('scope-src/Deep'),
    'the hidden mention is still a traversal root, so its allowed-kind neighbour appears',
  );
  assert.deepEqual(mentionedHidden.stats.hidden?.byKind, { function: 1 });
  assert.deepEqual(mentionedHidden.stats.hidden?.mentionedByKind, { function: 1 });
  assert.deepEqual(mentionedHidden.stats.mentionedByKind, { class: 1, function: 1 });

  // Opening the `function` switch draws it again and empties the hidden counts.
  const mentionedKept = (await readGraphBody(root, mentionedTranscript, {
    hops: 2,
    kinds: STRUCTURAL_KIND_VALUES,
    keepMentionedKinds: ['function'],
  })) as FilterBody;
  assert.ok(
    entityIdSet(mentionedKept).includes('scope-src/Fn'),
    'the switch keeps the directly mentioned function drawn',
  );
  assert.deepEqual(mentionedKept.stats.hidden?.byKind, {});
  assert.deepEqual(mentionedKept.stats.hidden?.mentionedByKind, {});
});

test('a relations filter expands only along the allowed types and emits only them', async (t) => {
  const { root } = createIndexProject(t, FILTER_PROJECT_INDEX, FILTER_ARCHIVE);

  const dependencyOnly = (await readGraphBody(root, SEED_TRANSCRIPT, {
    hops: 2,
    relations: ['dependency'],
  })) as FilterBody;
  console.log(
    `filter reading: dependency-only nodes=${JSON.stringify(entityIdSet(dependencyOnly))} ` +
      `edges=${JSON.stringify(edgeKeySet(dependencyOnly))} hidden=${JSON.stringify(dependencyOnly.stats.hidden)}`,
  );

  // Seed →(call) Fn is not followed, and Svc →(composition) Api is not either.
  assert.deepEqual(entityIdSet(dependencyOnly), ['scope-src/Seed', 'scope-src/Svc']);
  assert.deepEqual(edgeKeySet(dependencyOnly), ['scope-src/Seed->scope-src/Svc:dependency']);
  assert.deepEqual(dependencyOnly.stats.hidden?.byRelation, { call: 1, composition: 1 });
  assert.deepEqual(dependencyOnly.stats.hidden?.byKind, {}, 'the element axis was not requested');
  assert.deepEqual(dependencyOnly.stats.relationCounts, { call: 1, dependency: 2, composition: 1 });
});

test('the filter participates in the content-addressed cache key (and a repeat is a hit)', async (t) => {
  const { root } = createIndexProject(t, FILTER_PROJECT_INDEX, FILTER_ARCHIVE);
  const generatorCalls: Array<{
    kinds?: readonly string[];
    keepMentionedKinds?: readonly string[];
    relations?: readonly string[];
  }> = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => SEED_TRANSCRIPT,
        // The real generator, counted: the call count IS the reading of "did the
        // cache recompute this combination".
        generateGraph: (...args) => {
          generatorCalls.push({
            ...(args[2].kinds === undefined ? {} : { kinds: args[2].kinds }),
            ...(args[2].keepMentionedKinds === undefined
              ? {}
              : { keepMentionedKinds: args[2].keepMentionedKinds }),
            ...(args[2].relations === undefined ? {} : { relations: args[2].relations }),
          });
          return generateGraph(...args);
        },
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const base = { projectId: 'project-1', sessionId: SESSION_ID, hops: 2 };
    const structural = await postGraph(baseUrl, { ...base, kinds: STRUCTURAL_KIND_VALUES });
    assert.equal(structural.status, 200);
    let body = (await structural.json()) as FilterBody;
    assert.equal(body.provenance.cacheHit, false, 'the first filtered request is a miss');
    assert.equal(generatorCalls.length, 1);

    const dependencyOnly = await postGraph(baseUrl, {
      ...base,
      kinds: STRUCTURAL_KIND_VALUES,
      relations: ['dependency'],
    });
    assert.equal(dependencyOnly.status, 200);
    body = (await dependencyOnly.json()) as FilterBody;
    assert.equal(body.provenance.cacheHit, false, 'a different filter is a different key');
    assert.equal(generatorCalls.length, 2);

    const repeat = await postGraph(baseUrl, { ...base, kinds: STRUCTURAL_KIND_VALUES });
    assert.equal(repeat.status, 200);
    body = (await repeat.json()) as FilterBody;
    assert.equal(body.provenance.cacheHit, true, 'the same combination must not be recomputed');
    assert.equal(generatorCalls.length, 2, 'the repeated combination performed no second generation');

    // The "keep mentioned" switches are part of the same key: a different list
    // is a different reading, and the same list (in any order) is a hit.
    const kept = await postGraph(baseUrl, {
      ...base,
      kinds: STRUCTURAL_KIND_VALUES,
      keepMentionedKinds: ['function', 'class'],
    });
    assert.equal(kept.status, 200);
    body = (await kept.json()) as FilterBody;
    assert.equal(body.provenance.cacheHit, false, 'a different switch set is a different key');
    assert.equal(generatorCalls.length, 3);
    assert.deepEqual(
      generatorCalls[2]?.keepMentionedKinds,
      ['class', 'function'],
      'the generator receives the normalized (sorted) list',
    );

    const keptRepeat = await postGraph(baseUrl, {
      ...base,
      kinds: STRUCTURAL_KIND_VALUES,
      keepMentionedKinds: ['class', 'function'],
    });
    assert.equal(keptRepeat.status, 200);
    body = (await keptRepeat.json()) as FilterBody;
    assert.equal(body.provenance.cacheHit, true, 'the same switch set must not be recomputed');
    assert.equal(generatorCalls.length, 3);

    // The unfiltered reading is yet another key.
    assert.equal((await postGraph(baseUrl, base)).status, 200);
    assert.equal(generatorCalls.length, 4);
    assert.equal(generatorCalls[3]?.kinds, undefined, 'the unfiltered request carries no filtered params');
    assert.equal(generatorCalls[3]?.relations, undefined);
    assert.equal(generatorCalls[3]?.keepMentionedKinds, undefined);
  });
  console.log(`filter reading: generator calls=${JSON.stringify(generatorCalls)}`);
});

test('an unknown kind or relation type is refused with 400 rather than silently dropped', async (t) => {
  const { root } = createIndexProject(t, FILTER_PROJECT_INDEX, FILTER_ARCHIVE);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => SEED_TRANSCRIPT,
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const base = { projectId: 'project-1', sessionId: SESSION_ID };
    for (const request of [
      { ...base, kinds: ['class', 'rocket'] },
      { ...base, relations: ['dependency', 'handshake'] },
      { ...base, kinds: 'class' },
      { ...base, relations: [1] },
      { ...base, kinds: ['class'], keepMentionedKinds: ['class', 'rocket'] },
      { ...base, keepMentionedKinds: 'function' },
    ]) {
      const response = await postGraph(baseUrl, request);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(request)}`);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'INVALID_REQUEST');
    }

    // An EMPTY array is legal and means "show none of that axis" — every
    // entity goes now, including the directly mentioned class seed (a mention
    // is no longer exempt without its kind's switch).
    const empty = await postGraph(baseUrl, { ...base, kinds: [], hops: 0 });
    assert.equal(empty.status, 200);
    const body = (await empty.json()) as FilterBody;
    assert.deepEqual(entityIdSet(body), [], 'kinds: [] hides every entity, mentioned or not');
    assert.deepEqual(body.stats.hidden?.byKind, { class: 1 });
    assert.deepEqual(body.stats.hidden?.mentionedByKind, { class: 1 });

    // …and the class switch brings it back.
    const kept = await postGraph(baseUrl, {
      ...base,
      kinds: [],
      keepMentionedKinds: ['class'],
      hops: 0,
    });
    assert.equal(kept.status, 200);
    const keptBody = (await kept.json()) as FilterBody;
    assert.deepEqual(entityIdSet(keptBody), ['scope-src/Seed'], 'the switch keeps the mentioned class');
    assert.deepEqual(keptBody.stats.hidden?.byKind, {});
  });
});

test('mentions 未登录 401，缺参数 400', async (t) => {
  const { root } = createIndexProject(t, MENTION_INDEX);
  const app = express();
  app.use(express.json());
  app.use('/api/architecture', (request, response, next) => {
    if (request.headers.authorization === undefined) {
      response.status(401).json({ error: 'Access denied. No token provided.', code: 'AUTH_TOKEN_INVALID' });
      return;
    }
    next();
  });
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => mentionTranscript(root),
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const anonymous = await postMentions(baseUrl, {
      projectId: 'project-1',
      sessionId: SESSION_ID,
      entityIds: ['scope-src/M.u'],
    });
    assert.equal(anonymous.status, 401, 'a request with no bearer token must be refused');

    // A token lets the request through the stand-in; the missing target then
    // reaches the route's own validation.
    const noTarget = await postMentions(
      baseUrl,
      { projectId: 'project-1', sessionId: SESSION_ID },
      'test-token',
    );
    assert.equal(noTarget.status, 400, 'neither entityIds nor edge must be a bad request');
    const noTargetBody = (await noTarget.json()) as { error: { code: string } };
    assert.equal(noTargetBody.error.code, 'INVALID_REQUEST');

    const accepted = await postMentions(
      baseUrl,
      { projectId: 'project-1', sessionId: SESSION_ID, entityIds: ['scope-src/M.u'] },
      'test-token',
    );
    assert.equal(accepted.status, 200, 'the same request with a token is accepted');
  });
});

// ---------------------------------------------------------------------------
// architecture-scope-hygiene — the merge rules
// ---------------------------------------------------------------------------

/**
 * A manifest shaped like the real archguard one the task was filed from: three
 * NESTED scopes over the same tree (project root, `src`, `src/mermaid`), two
 * scopes whose sources are outside this project (a claudecodeui-shaped checkout
 * and a `/tmp` fixture), and one scope whose entity ids/files are ABSOLUTE
 * paths — the upstream parser bug that produced `42ceaef3//data/home/...`.
 *
 * The overlap is deliberate in two places: `App` is indexed by both the outer
 * and the `src` scope, `MermaidView` by both the outer and the absolute-id
 * `mermaid` scope. `Mid` and `OnlyInner` exist in only one scope and must
 * survive.
 */
function createHygieneProject(t: { after(callback: () => void): void }): {
  root: string;
  outsideClaudecodeui: string;
  outsideTmp: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-hygiene-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Two outside sources that need not exist: containment compares paths, and a
  // non-existent path falls back to `path.resolve` exactly as production does.
  const outsideClaudecodeui = '/data/home/yale/work/claudecodeui';
  const outsideTmp = path.join(tmpdir(), 'arch-hygiene-outside-fixture');

  writeJson(path.join(root, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    // The real manifest's globalScopeKey pointed at a scope from ANOTHER
    // project; the service must never use it to pick a scope.
    globalScopeKey: 'outside-claudecodeui',
    scopes: [
      { key: 'outer-scope', label: 'archguard (typescript)', language: 'typescript', sources: [root] },
      { key: 'mid-scope', label: 'src (typescript)', language: 'typescript', sources: [path.join(root, 'src')] },
      {
        key: 'inner-scope',
        label: 'mermaid (typescript)',
        language: 'typescript',
        sources: [path.join(root, 'src', 'mermaid')],
      },
      {
        key: 'outside-claudecodeui',
        label: 'claudecodeui (typescript)',
        language: 'typescript',
        sources: [outsideClaudecodeui],
      },
      {
        key: 'outside-tmp',
        label: 'fixture (typescript)',
        language: 'typescript',
        sources: [outsideTmp],
      },
    ],
  });

  writeJson(path.join(root, '.archguard', 'query', 'outer-scope', 'arch-index.json'), {
    version: '1.0',
    generatedAt: '2026-10-20T10:00:00.000Z',
    archJsonHash: '1'.repeat(64),
    language: 'typescript',
    fileToIds: {
      'src/app.ts': ['src/app.ts.App'],
      'src/mermaid/MermaidView.ts': ['src/mermaid/MermaidView.ts.MermaidView'],
    },
    nameToIds: {
      App: ['src/app.ts.App'],
      MermaidView: ['src/mermaid/MermaidView.ts.MermaidView'],
    },
    idToFile: {
      'src/app.ts.App': 'src/app.ts',
      'src/mermaid/MermaidView.ts.MermaidView': 'src/mermaid/MermaidView.ts',
    },
    idToName: {
      'src/app.ts.App': 'App',
      'src/mermaid/MermaidView.ts.MermaidView': 'MermaidView',
    },
    dependencies: {
      'src/app.ts.App': ['src/mermaid/MermaidView.ts.MermaidView'],
      'src/mermaid/MermaidView.ts.MermaidView': [],
    },
    dependents: {
      'src/app.ts.App': [],
      'src/mermaid/MermaidView.ts.MermaidView': ['src/app.ts.App'],
    },
    relationsByType: {
      dependency: [['src/app.ts.App', 'src/mermaid/MermaidView.ts.MermaidView']],
    },
  });
  writeJson(path.join(root, '.archguard', 'query', 'outer-scope', 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: [
      { id: 'src/app.ts.App', type: 'class', members: [] },
      { id: 'src/mermaid/MermaidView.ts.MermaidView', type: 'class', members: [] },
    ],
  });

  writeJson(path.join(root, '.archguard', 'query', 'mid-scope', 'arch-index.json'), {
    version: '1.0',
    generatedAt: '2026-10-20T11:00:00.000Z',
    archJsonHash: '2'.repeat(64),
    language: 'typescript',
    fileToIds: { 'app.ts': ['app.ts.App'], 'mid.ts': ['mid.ts.Mid'] },
    nameToIds: { App: ['app.ts.App'], Mid: ['mid.ts.Mid'] },
    idToFile: { 'app.ts.App': 'app.ts', 'mid.ts.Mid': 'mid.ts' },
    idToName: { 'app.ts.App': 'App', 'mid.ts.Mid': 'Mid' },
    // The edge into the duplicate `App` must be re-pointed at the OUTER scope's
    // retained id, not dropped.
    dependencies: { 'app.ts.App': [], 'mid.ts.Mid': ['app.ts.App'] },
    dependents: { 'app.ts.App': ['mid.ts.Mid'], 'mid.ts.Mid': [] },
    relationsByType: { call: [['mid.ts.Mid', 'app.ts.App']] },
  });

  const absoluteMermaidId = path.join(root, 'src', 'mermaid', 'MermaidView.ts') + '.MermaidView';
  const absoluteOnlyInnerId = path.join(root, 'src', 'mermaid', 'OnlyInner.ts') + '.OnlyInner';
  writeJson(path.join(root, '.archguard', 'query', 'inner-scope', 'arch-index.json'), {
    version: '1.0',
    generatedAt: '2026-10-20T12:00:00.000Z',
    archJsonHash: '3'.repeat(64),
    language: 'typescript',
    // Absolute ids AND absolute file keys, exactly as the upstream parser wrote
    // them (`42ceaef3//data/home/...` came from prefixing these).
    fileToIds: {
      [path.join(root, 'src', 'mermaid', 'MermaidView.ts')]: [absoluteMermaidId],
      [path.join(root, 'src', 'mermaid', 'OnlyInner.ts')]: [absoluteOnlyInnerId],
    },
    nameToIds: { MermaidView: [absoluteMermaidId], OnlyInner: [absoluteOnlyInnerId] },
    idToFile: {
      [absoluteMermaidId]: path.join(root, 'src', 'mermaid', 'MermaidView.ts'),
      [absoluteOnlyInnerId]: path.join(root, 'src', 'mermaid', 'OnlyInner.ts'),
    },
    idToName: { [absoluteMermaidId]: 'MermaidView', [absoluteOnlyInnerId]: 'OnlyInner' },
    // A self-edge that only appears as one AFTER the alias rewrite; the merge
    // must drop it rather than emit a loop.
    dependencies: { [absoluteMermaidId]: [absoluteMermaidId], [absoluteOnlyInnerId]: [absoluteMermaidId] },
    dependents: { [absoluteMermaidId]: [absoluteOnlyInnerId], [absoluteOnlyInnerId]: [] },
    relationsByType: { composition: [[absoluteOnlyInnerId, absoluteMermaidId]] },
  });
  writeJson(path.join(root, '.archguard', 'query', 'inner-scope', 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: [
      { id: absoluteMermaidId, type: 'class', members: [] },
      { id: absoluteOnlyInnerId, type: 'function', members: [] },
    ],
  });

  for (const key of ['outside-claudecodeui', 'outside-tmp']) {
    writeJson(path.join(root, '.archguard', 'query', key, 'arch-index.json'), {
      version: '1.0',
      generatedAt: MANIFEST_GENERATED_AT,
      archJsonHash: key === 'outside-claudecodeui' ? '4'.repeat(64) : '5'.repeat(64),
      language: 'typescript',
      fileToIds: { 'outside.ts': [`outside.ts.${key}`] },
      nameToIds: { [`Outside-${key}`]: [`outside.ts.${key}`] },
      idToFile: { [`outside.ts.${key}`]: 'outside.ts' },
      idToName: { [`outside.ts.${key}`]: `Outside-${key}` },
      dependencies: { [`outside.ts.${key}`]: [] },
      dependents: { [`outside.ts.${key}`]: [] },
    });
  }

  return { root, outsideClaudecodeui, outsideTmp };
}

/** A transcript naming every project file in the hygiene fixture, so every entity is a seed. */
function hygieneTranscript(root: string): NormalizedMessage[] {
  return ['src/app.ts', 'src/mid.ts', path.join('src', 'mermaid', 'OnlyInner.ts'), path.join('src', 'mermaid', 'MermaidView.ts')].map(
    (relative, index) =>
      message({
        id: `tool-${index}`,
        kind: 'tool_use',
        role: 'assistant',
        toolName: 'Read',
        toolInput: { file_path: path.join(root, relative) },
      }),
  );
}

type HygieneBody = {
  graph: {
    file: { nodes: { id: string }[]; edges: { from: string; to: string }[] };
    entity: {
      nodes: { id: string; label: string; distance: number; kind?: string }[];
      edges: { from: string; to: string; relationType: string }[];
    };
  };
  provenance: {
    scopeHygiene?: {
      total: number;
      kept: number;
      droppedOutsideRoot: { scope: string; label: string; sources: string[] }[];
      subsumed: { scope: string; label: string; intoScope: string; droppedEntities: number }[];
      normalizedAbsoluteIds: number;
    };
  };
};

async function readHygieneBody(
  root: string,
  messages: NormalizedMessage[] = hygieneTranscript(root),
): Promise<HygieneBody> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => messages,
      }),
    ),
  );
  app.use(errorMiddleware);
  let body: HygieneBody | null = null;
  await withServer(app, async (baseUrl) => {
    const response = await postGraph(baseUrl, { projectId: 'project-1', sessionId: SESSION_ID });
    assert.equal(response.status, 200);
    body = (await response.json()) as HygieneBody;
  });
  assert.ok(body !== null);
  return body;
}

test('scope hygiene: nested scopes collapse to the outer entity, absolute ids normalise, outside scopes vanish', async (t) => {
  const { root, outsideClaudecodeui, outsideTmp } = createHygieneProject(t);
  const body = await readHygieneBody(root);

  const hygiene = body.provenance.scopeHygiene;
  assert.ok(hygiene !== undefined, 'a cleaned-up merge must report scopeHygiene');
  assert.equal(hygiene.total, 5);
  assert.equal(hygiene.kept, 3, 'outer, mid and inner still place distinct entities');
  assert.deepEqual(hygiene.droppedOutsideRoot, [
    { scope: 'outside-claudecodeui', label: 'claudecodeui (typescript)', sources: [outsideClaudecodeui] },
    { scope: 'outside-tmp', label: 'fixture (typescript)', sources: [outsideTmp] },
  ]);
  assert.deepEqual(hygiene.subsumed, [
    { scope: 'mid-scope', label: 'src (typescript)', intoScope: 'outer-scope', droppedEntities: 1 },
    { scope: 'inner-scope', label: 'mermaid (typescript)', intoScope: 'outer-scope', droppedEntities: 1 },
  ]);
  assert.equal(hygiene.normalizedAbsoluteIds, 2, 'the two absolute ids of the mermaid scope were normalised');

  const entityIds = body.graph.entity.nodes.map((node) => node.id);
  // Exactly one id per canonical (file, name); the OUTER scope's copy survived.
  assert.deepEqual(entityIds, [
    'inner-scope/src/mermaid/OnlyInner.ts.OnlyInner',
    'mid-scope/mid.ts.Mid',
    'outer-scope/src/app.ts.App',
    'outer-scope/src/mermaid/MermaidView.ts.MermaidView',
  ]);
  assert.ok(entityIds.every((id) => !id.startsWith('/')), 'no entity id may start with /');
  assert.ok(entityIds.every((id) => !id.includes('//')), 'no entity id may contain //');
  assert.ok(!entityIds.some((id) => id.includes('outside')), 'a scope outside the project contributes no node');

  const fileIds = body.graph.file.nodes.map((node) => node.id);
  assert.deepEqual(fileIds.sort(), [
    'src/app.ts',
    'src/mermaid/MermaidView.ts',
    'src/mermaid/OnlyInner.ts',
    'src/mid.ts',
  ]);
  assert.ok(fileIds.every((id) => !id.startsWith('/') && !id.includes('//')));
  assert.ok(!fileIds.some((id) => id.split('/')[0] === 'data'), 'the `data (…)` directory group came from absolute ids');

  const edges = body.graph.entity.edges.map((edge) => `${edge.from} -> ${edge.to}`);
  assert.ok(edges.includes('mid-scope/mid.ts.Mid -> outer-scope/src/app.ts.App'), 'the dropped id was re-pointed at the keeper');
  assert.ok(
    edges.includes('inner-scope/src/mermaid/OnlyInner.ts.OnlyInner -> outer-scope/src/mermaid/MermaidView.ts.MermaidView'),
    'an absolute-id edge was re-pointed after normalisation',
  );
  assert.ok(edges.every((edge) => edge.split(' -> ')[0] !== edge.split(' -> ')[1]), 'no self-loop survives');
  assert.equal(new Set(edges).size, edges.length, 'no duplicate edge survives');
  assert.ok(edges.length >= 3, 'no edge was lost by the rewrite');

  const kindById = new Map(body.graph.entity.nodes.map((node) => [node.id, node.kind]));
  assert.equal(kindById.get('outer-scope/src/mermaid/MermaidView.ts.MermaidView'), 'class', 'entityDetails follow the kept id');
  assert.equal(kindById.get('inner-scope/src/mermaid/OnlyInner.ts.OnlyInner'), 'function');
});

test('scope hygiene: the merge is deterministic and a no-cleanup project keeps the legacy shape', () => {
  const index = {
    fileToIds: { 'a.ts': ['A.x'] },
    nameToIds: { Alpha: ['A.x'] },
    idToFile: { 'A.x': 'a.ts' },
    idToName: { 'A.x': 'Alpha' },
    dependencies: { 'A.x': [] },
    dependents: { 'A.x': [] },
    relationsByType: {},
  };
  const scopes = [
    {
      key: 'scope-src',
      label: 'src (typescript)',
      sources: ['/projects/demo/src'],
      sourcePrefix: 'src',
      generatedAt: MANIFEST_GENERATED_AT,
      index,
    },
  ];

  const first = mergeScopesWithHygiene({ projectPath: '/projects/demo', scopes });
  const second = mergeScopesWithHygiene({ projectPath: '/projects/demo', scopes });

  // The pre-hygiene merge verbatim: one scope, relative ids, no overlap.
  assert.deepEqual(first.index, {
    fileToIds: { 'src/a.ts': ['scope-src/A.x'] },
    nameToIds: { Alpha: ['scope-src/A.x'] },
    dependencies: { 'scope-src/A.x': [] },
    dependents: { 'scope-src/A.x': [] },
    idToFile: { 'scope-src/A.x': 'src/a.ts' },
    idToName: { 'scope-src/A.x': 'Alpha' },
    relationsByType: {},
  });
  assert.deepEqual(first.hygiene, {
    total: 1,
    kept: 1,
    droppedOutsideRoot: [],
    subsumed: [],
    normalizedAbsoluteIds: 0,
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'the same input must produce the same bytes');
});

test('scope hygiene: a project reached through a symlink alias is still inside the project', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'arch-hygiene-symlink-'));
  const alias = `${root}-alias`;
  t.after(() => {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  symlinkSync(root, alias, 'dir');

  const index = {
    fileToIds: { 'a.ts': ['a.ts.A'] },
    nameToIds: { A: ['a.ts.A'] },
    idToFile: { 'a.ts.A': 'a.ts' },
    idToName: { 'a.ts.A': 'A' },
    dependencies: { 'a.ts.A': [] },
    dependents: { 'a.ts.A': [] },
  };
  const scope = {
    key: 'alias-scope',
    label: 'src (typescript)',
    sources: [path.join(alias, 'src')],
    sourcePrefix: 'src',
    generatedAt: MANIFEST_GENERATED_AT,
    index,
  };

  // A raw string comparison would call the alias path "outside"; realpath must not.
  const raw = mergeScopesWithHygiene({
    projectPath: root,
    scopes: [scope],
    canonicalizePath: (value) => path.resolve(value),
  });
  assert.equal(raw.hygiene.droppedOutsideRoot.length, 1, 'the control: without realpath the alias looks outside');

  const real = mergeScopesWithHygiene({
    projectPath: root,
    scopes: [scope],
    canonicalizePath: (value) => {
      try {
        return realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    },
  });
  assert.equal(real.hygiene.droppedOutsideRoot.length, 0, 'realpath keeps the aliased scope inside');
  assert.deepEqual(real.index.idToFile, { 'alias-scope/a.ts.A': 'src/a.ts' });

  // And end to end: the route (which injects realpath) draws the entity.
  writeJson(path.join(root, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    scopes: [{ key: 'alias-scope', label: 'src (typescript)', sources: [path.join(alias, 'src')] }],
  });
  writeJson(path.join(root, '.archguard', 'query', 'alias-scope', 'arch-index.json'), {
    version: '1.0',
    generatedAt: MANIFEST_GENERATED_AT,
    archJsonHash: 'a'.repeat(64),
    language: 'typescript',
    ...index,
  });
  const body = await readHygieneBody(root, [
    message({
      id: 'tool-alias',
      kind: 'tool_use',
      role: 'assistant',
      toolName: 'Read',
      toolInput: { file_path: path.join(root, 'src', 'a.ts') },
    }),
  ]);
  assert.equal(body.provenance.scopeHygiene, undefined, 'nothing was dropped, so no cleanup is reported');
  assert.deepEqual(body.graph.entity.nodes.map((node) => node.id), ['alias-scope/a.ts.A']);
});

test('scope hygiene: upstream outsideProjectRoot/parentScopeKey win over the heuristic, and their absence falls back', () => {
  const entity = (file: string, id: string, name: string) => ({
    fileToIds: { [file]: [id] },
    nameToIds: { [name]: [id] },
    idToFile: { [id]: file },
    idToName: { [id]: name },
    dependencies: { [id]: [] },
    dependents: { [id]: [] },
  });

  // parentScopeKey says `child-scope` (the SHORTER prefix) is nested inside
  // `parent-scope`; the heuristic alone would keep the child.
  const parent = {
    key: 'parent-scope',
    label: 'deep (typescript)',
    sources: ['/projects/demo/src/deep'],
    sourcePrefix: 'src/deep',
    generatedAt: MANIFEST_GENERATED_AT,
    index: entity('x.ts', 'x.ts.X', 'X'),
  };
  const child = {
    key: 'child-scope',
    label: 'root (typescript)',
    sources: ['/projects/demo'],
    sourcePrefix: '',
    generatedAt: '2026-10-21T00:00:00.000Z',
    parentScopeKey: 'parent-scope',
    index: entity('src/deep/x.ts', 'src/deep/x.ts.X', 'X'),
  };
  const withParent = mergeScopesWithHygiene({
    projectPath: '/projects/demo',
    scopes: [parent, child],
    canonicalizePath: (value) => path.resolve(value),
  });
  assert.deepEqual(Object.keys(withParent.index.idToFile), ['parent-scope/x.ts.X'], 'parentScopeKey decides the outer scope');

  const { parentScopeKey: _ignored, ...childWithoutParent } = child;
  const withoutParent = mergeScopesWithHygiene({
    projectPath: '/projects/demo',
    scopes: [parent, childWithoutParent],
    canonicalizePath: (value) => path.resolve(value),
  });
  assert.deepEqual(
    Object.keys(withoutParent.index.idToFile),
    ['child-scope/src/deep/x.ts.X'],
    'without the metadata the shortest source prefix wins, exactly as the heuristic alone',
  );

  // outsideProjectRoot is trusted verbatim in BOTH directions: an inside source
  // flagged true is dropped, an outside source flagged false is kept.
  const flaggedInside = {
    key: 'flagged-inside',
    label: 'flagged (typescript)',
    sources: ['/projects/demo/src'],
    sourcePrefix: 'src',
    generatedAt: MANIFEST_GENERATED_AT,
    outsideProjectRoot: true,
    index: entity('inside.ts', 'inside.ts.I', 'I'),
  };
  const flaggedOutside = {
    key: 'flagged-outside',
    label: 'external (typescript)',
    sources: ['/somewhere/else'],
    sourcePrefix: '',
    generatedAt: MANIFEST_GENERATED_AT,
    outsideProjectRoot: false,
    index: entity('external.ts', 'external.ts.E', 'E'),
  };
  const both = mergeScopesWithHygiene({
    projectPath: '/projects/demo',
    scopes: [flaggedInside, flaggedOutside],
    canonicalizePath: (value) => path.resolve(value),
  });
  assert.deepEqual(both.hygiene.droppedOutsideRoot.map((entry) => entry.scope), ['flagged-inside']);
  assert.deepEqual(Object.keys(both.index.idToFile), ['flagged-outside/external.ts.E']);
});

// ---------------------------------------------------------------------------
// architecture-curation-pins-and-excludes — graph curation + /search
// ---------------------------------------------------------------------------

const CURATION_INDEX: ScopeIndexFixture = {
  fileToIds: { 'n0.ts': ['N0'], 'n1.ts': ['N1'], 'n2.ts': ['N2'], 'n3.ts': ['N3'] },
  nameToIds: { Seed: ['N0'], One: ['N1'], Two: ['N2'], Three: ['N3'] },
  idToFile: { N0: 'n0.ts', N1: 'n1.ts', N2: 'n2.ts', N3: 'n3.ts' },
  idToName: { N0: 'Seed', N1: 'One', N2: 'Two', N3: 'Three' },
  dependencies: { N0: ['N1'], N1: ['N2'], N2: ['N3'], N3: [] },
  dependents: { N0: [], N1: ['N0'], N2: ['N1'], N3: ['N2'] },
  relationsByType: {
    dependency: [
      ['N0', 'N1'],
      ['N1', 'N2'],
      ['N2', 'N3'],
    ],
  },
};

const CURATION_ARCHIVE = archiveWith([
  { id: 'N0', type: 'class', members: [] },
  {
    id: 'N1',
    type: 'function',
    members: [
      { id: 'N1.m1', name: 'one', type: 'method', parameters: [], returnType: 'void' },
      { id: 'N1.m2', name: 'two', type: 'method', parameters: [], returnType: 'void' },
    ],
  },
  { id: 'N2', type: 'interface', members: [] },
  { id: 'N3', type: 'class', members: [] },
]);

/** A transcript whose only seed is the identifier `Seed`. */
function curationTranscript(): NormalizedMessage[] {
  return [message({ id: 'text-curation', kind: 'text', role: 'assistant', content: '`Seed` is the entry point.' })];
}

function postSearch(baseUrl: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/architecture/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function curationApp(root: string, generateGraphCounter?: unknown[]): Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => curationTranscript(),
        ...(generateGraphCounter === undefined
          ? {}
          : {
              generateGraph: (...args: Parameters<typeof generateGraph>) => {
                generateGraphCounter.push(args[2]);
                return generateGraph(...args);
              },
            }),
      }),
    ),
  );
  app.use(errorMiddleware);
  return app;
}

test('curation：excludeIds 移除遍历前的节点与边，extraSeeds 是 pinned 根且免于筛选', async (t) => {
  const { root } = createIndexProject(t, CURATION_INDEX, CURATION_ARCHIVE);
  const app = curationApp(root);

  await withServer(app, async (baseUrl) => {
    const baseline = (await (await postGraph(baseUrl, {
      projectId: 'project-1',
      sessionId: SESSION_ID,
      hops: 2,
    })).json()) as NeighborhoodBody;
    assert.equal(baseline.stats.entityNodes, 3, 'two hops from Seed reach Seed, One and Two');
    assert.equal('curation' in baseline.stats, false, 'no params ⇒ no curation key');
    assert.equal(
      'ids' in (baseline.stats.unresolved as Record<string, unknown>),
      false,
      'no extraSeeds ⇒ no unresolved.ids',
    );

    const excluded = (await (await postGraph(baseUrl, {
      projectId: 'project-1',
      sessionId: SESSION_ID,
      hops: 2,
      excludeIds: ['scope-src/N1'],
    })).json()) as NeighborhoodBody;
    assert.deepEqual(
      excluded.graph.entity.nodes.map((node) => node.id),
      ['scope-src/N0'],
      'removing One severs the chain: Two and Three are unreachable',
    );
    assert.deepEqual(excluded.graph.entity.edges, [], 'the removed node takes its edges with it');
    assert.deepEqual(excluded.stats.curation, { pinned: 0, excluded: 1 });

    const pinned = (await (await postGraph(baseUrl, {
      projectId: 'project-1',
      sessionId: SESSION_ID,
      hops: 0,
      kinds: ['class'],
      extraSeeds: ['scope-src/N1'],
      maxNodes: 100,
    })).json()) as NeighborhoodBody;
    const one = pinned.graph.entity.nodes.find((node) => node.id === 'scope-src/N1') as
      | (NeighborhoodBody['graph']['entity']['nodes'][number] & { mentionTier?: string })
      | undefined;
    assert.equal(one?.mentionTier, 'pinned', 'the function pin survives the class-only filter');
    assert.deepEqual(pinned.stats.curation, { pinned: 1, excluded: 0 });

    const missing = (await (await postGraph(baseUrl, {
      projectId: 'project-1',
      sessionId: SESSION_ID,
      hops: 0,
      extraSeeds: ['no/such.Entity'],
    })).json()) as NeighborhoodBody;
    assert.deepEqual(
      (missing.stats.unresolved as Record<string, unknown>).ids,
      ['no/such.Entity'],
      'an unknown pin is reported for the client to mark stale',
    );
  });
});

test('curation：两个参数进入缓存键（排序后），相同组合第二次不重算，超上限 400', async (t) => {
  const { root } = createIndexProject(t, CURATION_INDEX, CURATION_ARCHIVE);
  const generatorCalls: unknown[] = [];
  const app = curationApp(root, generatorCalls);

  await withServer(app, async (baseUrl) => {
    const base = { projectId: 'project-1', sessionId: SESSION_ID, hops: 1 };
    const first = await postGraph(baseUrl, { ...base, extraSeeds: ['N1', 'N2'] });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as NeighborhoodBody;
    assert.equal(firstBody.provenance.cacheHit, false);
    assert.equal(generatorCalls.length, 1);

    // The same SET in a different order is the same content key.
    const reordered = await postGraph(baseUrl, { ...base, extraSeeds: ['N2', 'N1'] });
    const reorderedBody = (await reordered.json()) as NeighborhoodBody;
    assert.equal(reorderedBody.provenance.cacheHit, true, 'sorted ids make a reordered request a cache hit');
    assert.equal(generatorCalls.length, 1);

    // A different exclusion is a different key.
    const excluded = await postGraph(baseUrl, { ...base, extraSeeds: ['N1', 'N2'], excludeIds: ['N3'] });
    const excludedBody = (await excluded.json()) as NeighborhoodBody;
    assert.equal(excludedBody.provenance.cacheHit, false, 'a new excludeIds set is a new content key');
    assert.equal(generatorCalls.length, 2);

    for (const body of [
      { ...base, extraSeeds: Array.from({ length: 201 }, (_, index) => `id-${index}`) },
      { ...base, excludeIds: Array.from({ length: 501 }, (_, index) => `id-${index}`) },
    ]) {
      const response = await postGraph(baseUrl, body);
      assert.equal(response.status, 400, 'over the cap is refused, never silently truncated');
      const parsed = (await response.json()) as { error: { code: string } };
      assert.equal(parsed.error.code, 'INVALID_REQUEST');
    }
  });
});

// ---------------------------------------------------------------------------
// /search — project-wide query and (file, name) re-anchoring
// ---------------------------------------------------------------------------

function buildSearchIndex(): {
  index: ScopeIndexFixture;
  archive: unknown;
} {
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const entities: unknown[] = [];

  const add = (id: string, name: string, file: string, type: string): void => {
    fileToIds[file] = [...(fileToIds[file] ?? []), id];
    nameToIds[name] = [id];
    idToFile[id] = file;
    idToName[id] = name;
    dependencies[id] = [];
    dependents[id] = [];
    entities.push({ id, type, members: [] });
  };

  add('S.Alpha', 'Alpha', 's/alpha.ts', 'class');
  add('S.AlphaService', 'AlphaService', 's/alphaService.ts', 'interface');
  add('S.alphaHelper', 'alphaHelper', 's/alphaHelper.ts', 'function');
  add('S.Beta', 'Beta', 's/beta.ts', 'class');
  // Twenty-five matches are what makes `truncated` observable at the 20 cap.
  for (let index = 0; index < 25; index += 1) {
    const suffix = String(index).padStart(2, '0');
    add(`S.Widget${suffix}`, `Widget${suffix}`, `s/widget${suffix}.ts`, 'class');
  }

  return {
    index: { fileToIds, nameToIds, idToFile, idToName, dependencies, dependents },
    archive: archiveWith(entities),
  };
}

test('/search：前缀/子串排序、kinds、truncated、resolve 按 (file, name) 返回当前 id', async (t) => {
  const { index, archive } = buildSearchIndex();
  const { root } = createIndexProject(t, index, archive);
  const app = curationApp(root);

  await withServer(app, async (baseUrl) => {
    const ranked = await postSearch(baseUrl, { projectId: 'project-1', query: 'alpha' });
    assert.equal(ranked.status, 200);
    const rankedBody = (await ranked.json()) as {
      results: { id: string; name: string; file: string; kind?: string }[];
      truncated: boolean;
    };
    assert.deepEqual(
      rankedBody.results.map((hit) => hit.name),
      ['Alpha', 'AlphaService', 'alphaHelper'],
      'exact first, then prefix, then substring (case-insensitive)',
    );
    assert.equal(rankedBody.truncated, false);
    assert.equal(rankedBody.results[0]?.kind, 'class', 'the hit carries the entity kind');

    const kinds = (await (await postSearch(baseUrl, {
      projectId: 'project-1',
      query: 'alpha',
      kinds: ['interface'],
    })).json()) as { results: { name: string }[] };
    assert.deepEqual(kinds.results.map((hit) => hit.name), ['AlphaService']);

    const many = (await (await postSearch(baseUrl, { projectId: 'project-1', query: 'Widget' })).json()) as {
      results: unknown[];
      truncated: boolean;
    };
    assert.equal(many.results.length, 20, 'the result list is bounded at 20');
    assert.equal(many.truncated, true, 'more matches than the bound is reported, not hidden');

    const resolved = (await (await postSearch(baseUrl, {
      projectId: 'project-1',
      resolve: [
        { name: 'AlphaService', file: 'src/s/alphaService.ts' },
        { name: 'Gone', file: 'src/s/gone.ts' },
      ],
    })).json()) as { resolved: ({ id: string; name: string; file: string } | null)[] };
    assert.equal(
      resolved.resolved[0]?.id,
      'scope-src/S.AlphaService',
      '(file, name) re-anchors onto the current (scope-prefixed) id',
    );
    assert.deepEqual(resolved.resolved[1], null, 'an unresolvable item stays null for the client to mark stale');

    for (const bad of [
      { projectId: 'project-1', query: 'a' },
      { projectId: 'project-1' },
      { projectId: 'project-1', query: 'alpha', resolve: [] },
    ]) {
      const response = await postSearch(baseUrl, bad);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      const parsed = (await response.json()) as { error: { code: string } };
      assert.equal(parsed.error.code, 'INVALID_REQUEST');
    }
  });
});

test('/search 未登录 401，带 token 通过', async (t) => {
  const { index, archive } = buildSearchIndex();
  const { root } = createIndexProject(t, index, archive);
  const app = express();
  app.use(express.json());
  app.use('/api/architecture', (request, response, next) => {
    if (request.headers.authorization === undefined) {
      response.status(401).json({ error: 'Access denied. No token provided.', code: 'AUTH_TOKEN_INVALID' });
      return;
    }
    next();
  });
  app.use(
    '/api/architecture',
    createArchitectureRoutes(
      createArchitectureService({
        resolveProjectPath: () => root,
        readSessionHistory: async () => curationTranscript(),
      }),
    ),
  );
  app.use(errorMiddleware);

  await withServer(app, async (baseUrl) => {
    const anonymous = await postSearch(baseUrl, { projectId: 'project-1', query: 'alpha' });
    assert.equal(anonymous.status, 401, 'a request with no bearer token must be refused');
    const accepted = await postSearch(baseUrl, { projectId: 'project-1', query: 'alpha' }, 'test-token');
    assert.equal(accepted.status, 200);
  });
});
