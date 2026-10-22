/**
 * AC-415 — the seeded architecture graph generator.
 *
 * What this criterion is FOR. ADR-005 decisions 4 and 5 need one pure transform
 * between "the caller has seeds" (AC-416) and "the route serves two Mermaid
 * documents" (AC-418):
 *
 *   seeds → resolve → 1-hop bidirectional expansion → node budget →
 *   entity/file aggregation → two legal `.mmd` documents.
 *
 * Every test drives the REAL generator over the checked-in frozen index slice
 * `fixtures/arch-index.sample.json`. That fixture is a crop of
 * `.archguard/query/93e0a992/arch-index.json` (scope `src`, archJsonHash
 * `d02930eaf41dacb0b22a498575d9d479bd77931e874e78d97b00db170b5e42f0`,
 * generatedAt `2026-10-20T15:52:34.424Z`) — see the fixture's `_fixture` header
 * for the exact cropped range. It is a SNAPSHOT: none of these assertions read
 * the live `.archguard/` cache, so the readings here stay meaningful after that
 * cache is regenerated.
 *
 * Test blocks are named one per reading, all prefixed `AC-415`, so a single leg
 * can be re-run with `--test-name-pattern`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DIRECT_MAX_CANDIDATES,
  generateGraph,
  validateMermaid,
  type ArchIndex,
  type GenerateGraphResult,
  type GraphSeeds,
} from '../index.js';

const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'arch-index.sample.json');

/** The fixture as the generator consumes it (the `_fixture` provenance key is ignored). */
const FIXTURE: ArchIndex = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ArchIndex;

/**
 * A writable copy of the fixture — the false forms mutate ONE mapping and must
 * leave the checked-in file untouched, so the immutability in `ArchIndex` is
 * dropped here on purpose.
 */
type MutableIndex = {
  fileToIds: Record<string, string[]>;
  nameToIds: Record<string, string[]>;
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
  idToFile: Record<string, string>;
  idToName: Record<string, string>;
};

function mutableFixture(): MutableIndex {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MutableIndex;
}

/** One node line of a Mermaid document: its cleaned id and its (quoted) label. */
type MermaidNode = { id: string; label: string };

/** Read the node lines of a document — the same shape the emitter writes. */
function mermaidNodes(mmd: string): MermaidNode[] {
  const nodes: MermaidNode[] = [];
  for (const line of mmd.split('\n')) {
    const match = /^\s*([A-Za-z0-9_]+)\["(.*)"\]\s*$/.exec(line);
    if (match !== null) nodes.push({ id: match[1] ?? '', label: match[2] ?? '' });
  }
  return nodes;
}

/** Read the edge lines of a document. */
function mermaidEdges(mmd: string): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const line of mmd.split('\n')) {
    const match = /^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$/.exec(line);
    if (match !== null) edges.push({ from: match[1] ?? '', to: match[2] ?? '' });
  }
  return edges;
}

/** The entity labels present in a result, sorted, for set comparisons. */
function entityLabels(result: GenerateGraphResult): string[] {
  return mermaidNodes(result.mmd.entity)
    .map((node) => node.label)
    .sort();
}

/** The file labels present in a result, sorted. */
function fileLabels(result: GenerateGraphResult): string[] {
  return mermaidNodes(result.mmd.file)
    .map((node) => node.label)
    .sort();
}

/** The entity ids present in a result, as a Set. */
function entityIds(result: GenerateGraphResult): Set<string> {
  return new Set(mermaidNodes(result.mmd.entity).map((node) => node.id));
}

const GIT_PANEL_UTILS = 'modules/git-panel/utils/gitPanelUtils.ts';
const COMMIT_HISTORY_ITEM = 'modules/git-panel/history/CommitHistoryItem.tsx';

/**
 * The six entities `fileToIds` expands the gitPanelUtils seed into. Spelled out
 * from the fixture so the seed-resolution leg asserts expansion, not a count.
 */
const GIT_PANEL_UTILS_NAMES = [
  'getAllChangedFiles',
  'getChangedFileCount',
  'getStatusBadgeClass',
  'getStatusLabelKey',
  'hasChangedFiles',
  'parseCommitFiles',
];

const FULL_CHAIN_SEEDS = {
  files: [GIT_PANEL_UTILS, COMMIT_HISTORY_ITEM],
  identifiers: ['GitPanel'],
};

test('AC-415 种子解析：fileToIds 展开文件种子，nameToIds 精确命中标识符种子', () => {
  const result = generateGraph(
    FIXTURE,
    {
      // A repeated file seed and a repeated identifier seed must not shift the reading.
      files: [GIT_PANEL_UTILS, GIT_PANEL_UTILS, 'modules/git-panel/does-not-exist.ts'],
      identifiers: ['CommitHistoryItem', 'CommitHistoryItem', 'commithistoryitem', 'CommitHistory'],
    },
    // hops 0 isolates resolution: the node set is exactly the resolved seeds.
    { hops: 0, maxNodes: 100 },
  );

  const labels = entityLabels(result);
  console.log(
    `AC-415 reading: seed resolution entityNodes=${result.stats.entityNodes} labels=${JSON.stringify(labels)} ` +
      `unresolved=${JSON.stringify(result.unresolved)}`,
  );

  // The file seed expanded through `fileToIds` into ALL of its entities.
  for (const name of GIT_PANEL_UTILS_NAMES) {
    assert.ok(labels.includes(name), `file seed must expand to ${name}, got ${JSON.stringify(labels)}`);
  }
  // The identifier seed hit `nameToIds` exactly.
  assert.ok(labels.includes('CommitHistoryItem'), 'CommitHistoryItem must resolve by exact name');
  assert.equal(result.stats.entityNodes, GIT_PANEL_UTILS_NAMES.length + 1);

  // Near misses are NOT silently dropped: wrong case and a prefix both stay unresolved.
  assert.deepEqual(result.unresolved.files, ['modules/git-panel/does-not-exist.ts']);
  assert.deepEqual(result.unresolved.identifiers, ['commithistoryitem', 'CommitHistory']);
  // A duplicate seed is collapsed, not counted twice.
  assert.equal(new Set(labels).size, labels.length, 'duplicate seeds must not duplicate nodes');
});

test('AC-415 双向扩展：dependencies + dependents 1 跳并集', () => {
  // Forward one hop: the seed's own imports.
  const forward = generateGraph(
    FIXTURE,
    { files: ['modules/git-panel/GitPanel.tsx'], identifiers: [] },
    { hops: 1, maxNodes: 100 },
  );
  // Backward one hop: the seed is reached FROM its callers.
  const backward = generateGraph(
    FIXTURE,
    { files: ['modules/git-panel/utils/gitPanelUtils.ts'], identifiers: [] },
    { hops: 1, maxNodes: 100 },
  );
  console.log(
    `AC-415 reading: forward entityNodes=${forward.stats.entityNodes} entityEdges=${forward.stats.entityEdges} ` +
      `backward entityNodes=${backward.stats.entityNodes} entityEdges=${backward.stats.entityEdges}`,
  );

  // GitPanel has two dependencies and no dependents: 1 + 2 nodes, both edges point
  // away from the seed.
  assert.deepEqual(entityLabels(forward), [
    'GitPanel',
    'getChangedFileCount',
    'useGitPanelController',
  ]);
  assert.deepEqual(
    mermaidEdges(forward.mmd.entity)
      .map((edge) => `${edge.from}->${edge.to}`)
      .sort(),
    [
      'modules_git_panel_GitPanel_tsx_GitPanel->modules_git_panel_hooks_useGitPanelController_ts_useGitPanelController',
      'modules_git_panel_GitPanel_tsx_GitPanel->modules_git_panel_utils_gitPanelUtils_ts_getChangedFileCount',
    ].sort(),
  );

  // gitPanelUtils.ts has six leaves and six dependents reachable in ONE hop from
  // the dependents direction (GitPanel arrives through a dependent, not through a
  // dependency) — the union, not just the forward half.
  assert.equal(backward.stats.entityNodes, 12);
  const backwardLabels = entityLabels(backward);
  for (const caller of ['ChangesView', 'FileChangeItem', 'FileStatusLegend', 'CommitHistoryItem', 'GitPanel', 'useGitPanelController']) {
    assert.ok(backwardLabels.includes(caller), `${caller} must be reached via dependents`);
  }
  // CommitHistoryItem -> laneColor is a dependency of a DISTANT node, so the 1-hop
  // budget must not include laneColor.
  assert.ok(!backwardLabels.includes('laneColor'), 'expansion must stop after one hop');
  assert.equal(backward.stats.entityEdges, 10);
});

test('AC-415 file 级聚合：entity 边按 idToFile 归并去重', () => {
  const result = generateGraph(FIXTURE, FULL_CHAIN_SEEDS, { hops: 1, maxNodes: 100 });
  console.log(
    `AC-415 reading: aggregation entityNodes=${result.stats.entityNodes} fileNodes=${result.stats.fileNodes} ` +
      `entityEdges=${result.stats.entityEdges} fileEdges=${result.stats.fileEdges} truncated=${result.stats.truncated}`,
  );

  const expectedFiles = [
    'modules/git-panel/GitPanel.tsx',
    'modules/git-panel/changes/ChangesView.tsx',
    'modules/git-panel/changes/FileChangeItem.tsx',
    'modules/git-panel/changes/FileStatusLegend.tsx',
    'modules/git-panel/history/CommitHistoryItem.tsx',
    'modules/git-panel/hooks/useGitPanelController.ts',
    'modules/git-panel/utils/commitGraph.ts',
    'modules/git-panel/utils/gitPanelUtils.ts',
  ];
  assert.deepEqual(fileLabels(result), expectedFiles);
  assert.equal(result.stats.entityNodes, 13);
  // 11 entity edges collapse to 8 file edges: several entities of the two
  // multi-entity files share the same (from, to) file pair.
  assert.equal(result.stats.entityEdges, 11);
  assert.equal(result.stats.fileEdges, 8);
  assert.equal(result.stats.truncated, false);

  const fileEdges = mermaidEdges(result.mmd.file).map((edge) => `${edge.from}->${edge.to}`);
  assert.equal(new Set(fileEdges).size, fileEdges.length, 'no duplicate file edge');
  for (const edge of mermaidEdges(result.mmd.file)) {
    assert.notEqual(edge.from, edge.to, 'no file-level self edge');
  }
  // The two multi-entity files are one node each, not one node per entity.
  assert.equal(new Set(fileLabels(result)).size, expectedFiles.length);
  assert.deepEqual(validateMermaid(result.mmd.file), []);
});

test('AC-415 节点预算：超限返回 truncated 且有界', () => {
  const capped = generateGraph(FIXTURE, { files: [GIT_PANEL_UTILS], identifiers: [] }, { hops: 1, maxNodes: 8 });
  const again = generateGraph(FIXTURE, { files: [GIT_PANEL_UTILS], identifiers: [] }, { hops: 1, maxNodes: 8 });
  const uncapped = generateGraph(FIXTURE, { files: [GIT_PANEL_UTILS], identifiers: [] }, { hops: 1, maxNodes: 100 });
  console.log(
    `AC-415 reading: budget cappedNodes=${capped.stats.entityNodes} cappedEdges=${capped.stats.entityEdges} ` +
      `truncated=${capped.stats.truncated} fullNodes=${uncapped.stats.entityNodes} fullTruncated=${uncapped.stats.truncated}`,
  );

  assert.equal(capped.stats.truncated, true);
  assert.ok(capped.stats.entityNodes <= 8, `must stay within maxNodes, got ${capped.stats.entityNodes}`);
  assert.equal(capped.stats.entityNodes, 8);

  // Every edge in the truncated document has both endpoints in the retained set.
  const nodeIds = entityIds(capped);
  assert.equal(nodeIds.size, capped.stats.entityNodes);
  for (const edge of mermaidEdges(capped.mmd.entity)) {
    assert.ok(nodeIds.has(edge.from), `edge endpoint ${edge.from} must be retained`);
    assert.ok(nodeIds.has(edge.to), `edge endpoint ${edge.to} must be retained`);
  }
  assert.equal(mermaidEdges(capped.mmd.entity).length, capped.stats.entityEdges);

  // The budget order is hop-first then id: both distance-0 seeds survive and the
  // two lexicographically-first neighbours fill the remaining slots.
  const cappedLabels = entityLabels(capped);
  for (const name of GIT_PANEL_UTILS_NAMES) {
    assert.ok(cappedLabels.includes(name), `${name} is a seed (distance 0) and must be retained`);
  }
  assert.ok(cappedLabels.includes('GitPanel'), 'the lexicographically-first distance-1 node must be retained');
  assert.ok(cappedLabels.includes('ChangesView'), 'the second distance-1 node must be retained');
  assert.ok(!cappedLabels.includes('CommitHistoryItem'), 'a later distance-1 node must be cut');

  // Determinism: same (index, seeds, params) => same retained set and same mmd.
  assert.deepEqual(mermaidNodes(again.mmd.entity), mermaidNodes(capped.mmd.entity));
  assert.equal(again.mmd.entity, capped.mmd.entity);

  // Under the budget nothing is cut.
  assert.equal(uncapped.stats.truncated, false);
  assert.equal(uncapped.stats.entityNodes, 12);
  assert.deepEqual(validateMermaid(capped.mmd.entity), []);
  assert.deepEqual(validateMermaid(capped.mmd.file), []);
});

test('AC-415 mermaid 合法性：directive/清洗 id/引号 label/边端点已定义', () => {
  const result = generateGraph(FIXTURE, FULL_CHAIN_SEEDS, { hops: 1, maxNodes: 100 });
  console.log(
    `AC-415 reading: full chain entityNodes=${result.stats.entityNodes} fileNodes=${result.stats.fileNodes} ` +
      `entityEdges=${result.stats.entityEdges} fileEdges=${result.stats.fileEdges} truncated=${result.stats.truncated}`,
  );
  console.log(`AC-415 reading: file directive=${JSON.stringify(result.mmd.file.split('\n')[0])}`);
  console.log(`AC-415 reading: entity directive=${JSON.stringify(result.mmd.entity.split('\n')[0])}`);

  for (const [document, label] of [
    [result.mmd.file, 'file'],
    [result.mmd.entity, 'entity'],
  ] as const) {
    const lines = document.split('\n');
    assert.match(lines[0] ?? '', /^%%\{init: .+\}%%$/, `${label} mmd must start with a directive`);
    assert.equal(lines[1], 'flowchart LR', `${label} mmd must declare a flowchart`);

    const nodes = mermaidNodes(document);
    assert.ok(nodes.length > 0, `${label} mmd must define nodes`);
    for (const node of nodes) {
      assert.match(node.id, /^[A-Za-z_][A-Za-z0-9_]*$/, `${label} node id must be cleaned: ${node.id}`);
      // The label is always double-quoted and never carries a raw inner quote.
      assert.ok(!node.label.includes('"'), `${label} label must escape inner quotes`);
    }
    const defined = new Set(nodes.map((node) => node.id));
    for (const edge of mermaidEdges(document)) {
      assert.ok(defined.has(edge.from), `${label} edge endpoint ${edge.from} must be defined`);
      assert.ok(defined.has(edge.to), `${label} edge endpoint ${edge.to} must be defined`);
    }

    assert.deepEqual(validateMermaid(document), [], `${label} mmd must validate cleanly`);
  }

  // A path with a quote and a digit-leading id exercise the two cleaning rules the
  // fixture's own paths do not. This augmentation is test-local and never written
  // back to the checked-in fixture.
  const augmented = mutableFixture();
  const quotedFile = 'modules/git-panel/utils/odd"name.ts';
  const quotedId = `${quotedFile}.Quote"Name`;
  augmented.fileToIds[quotedFile] = [quotedId];
  augmented.nameToIds['Quote"Name'] = [quotedId];
  augmented.idToFile[quotedId] = quotedFile;
  augmented.idToName[quotedId] = 'Quote"Name';
  augmented.dependencies[quotedId] = [];
  augmented.dependents[quotedId] = [];

  const quotedResult = generateGraph(augmented, { files: [quotedFile], identifiers: [] }, { hops: 0, maxNodes: 10 });
  const quotedMmd = quotedResult.mmd.entity;
  console.log(`AC-415 reading: escaped label line=${JSON.stringify(quotedMmd.split('\n')[2])}`);
  assert.ok(quotedMmd.includes('#quot;'), 'an inner quote must be escaped as #quot;');
  assert.ok(!/"[^"\n]*"[^"\n]*"/.test(quotedMmd.split('\n')[2] ?? ''), 'the label must carry exactly its two quote delimiters');
  assert.deepEqual(validateMermaid(quotedMmd), []);

  const digitFile = '123 numeric.ts';
  const digitId = '123numeric';
  augmented.fileToIds[digitFile] = [digitId];
  augmented.nameToIds[digitId] = [digitId];
  augmented.idToFile[digitId] = digitFile;
  augmented.idToName[digitId] = digitId;
  augmented.dependencies[digitId] = [];
  augmented.dependents[digitId] = [];
  const digitResult = generateGraph(augmented, { files: [digitFile], identifiers: [] }, { hops: 0, maxNodes: 10 });
  const digitNode = mermaidNodes(digitResult.mmd.entity)[0];
  console.log(`AC-415 reading: digit-leading id=${JSON.stringify(digitNode)}`);
  assert.ok(digitNode !== undefined, 'the digit-leading seed must produce a node');
  assert.match(digitNode.id, /^n_/, 'a digit-leading id must get the stable n_ prefix');
  assert.deepEqual(validateMermaid(digitResult.mmd.entity), []);
});

test('AC-415 假形态 A：fileToIds 漏一条 ⇒ 节点集断言红', () => {
  const seeds = { files: [GIT_PANEL_UTILS], identifiers: [] };
  const expected = generateGraph(FIXTURE, seeds, { hops: 1, maxNodes: 100 });
  const mutated = mutableFixture();
  delete mutated.fileToIds[GIT_PANEL_UTILS];
  const actual = generateGraph(mutated, seeds, { hops: 1, maxNodes: 100 });

  const expectedLabels = entityLabels(expected);
  const actualLabels = new Set(entityLabels(actual));
  const difference = expectedLabels.filter((label) => !actualLabels.has(label));
  console.log(
    `AC-415 reading: false-form-A expectedNodes=${expected.stats.entityNodes} actualNodes=${actual.stats.entityNodes} ` +
      `difference=${JSON.stringify(difference)} unresolvedFiles=${JSON.stringify(actual.unresolved.files)}`,
  );

  // The mutation is a REAL defect: the same-source expected node set and the
  // generated set now disagree, so the node-set assertion discriminates.
  assert.ok(difference.length > 0, 'deleting the fileToIds mapping must change the node set');
  assert.ok(difference.includes('getAllChangedFiles'), 'the lost file expansion must be visible');
  assert.equal(actual.stats.entityNodes, 0, 'a seed that no longer resolves yields no nodes');
  // And the seed is NAMED as unresolved instead of being silently dropped.
  assert.deepEqual(actual.unresolved.files, [GIT_PANEL_UTILS]);
});

test('AC-415 假形态 B：边引用未定义节点 ⇒ 合法性断言红', () => {
  const result = generateGraph(FIXTURE, FULL_CHAIN_SEEDS, { hops: 1, maxNodes: 100 });
  const original = result.mmd.entity;
  assert.deepEqual(validateMermaid(original), [], 'the untouched document must validate cleanly');

  // Remove the definition of a node that edges point AT — the document is now
  // referencing an undefined endpoint.
  const targetLabel = 'getStatusBadgeClass';
  const targetNode = mermaidNodes(original).find((node) => node.label === targetLabel);
  assert.ok(targetNode !== undefined, `fixture must define ${targetLabel}`);
  const withoutNode = original
    .split('\n')
    .filter((line) => !(line.includes(`[`) && line.includes(targetLabel) && line.trim().startsWith(targetNode.id)))
    .join('\n');

  const problems = validateMermaid(withoutNode);
  console.log(
    `AC-415 reading: false-form-B removed=${targetNode.id} problems=${JSON.stringify(problems.slice(0, 3))}`,
  );

  assert.ok(problems.length > 0, 'a dangling edge endpoint must be reported');
  assert.ok(
    problems.some((problem) => problem.includes(`"${targetNode.id}"`)),
    `the problem list must name the undefined node ${targetNode.id}`,
  );
});

/**
 * A chain of four entities whose `entityDetails` mirror the shape the service
 * parses out of a real `arch.json`: a class with a constructor/property/method
 * body, an interface of properties, a plain function, and an abstract class.
 *
 * The ids use ArchGuard's `<scope-relative path>.<Name>` form, so the reading
 * here exercises the same id space the merged service index hands over.
 */
const DETAIL_INDEX: ArchIndex = {
  fileToIds: {
    'k0.ts': ['k0.ts.Seed'],
    'k1.ts': ['k1.ts.Middle'],
    'k2.ts': ['k2.ts.Leaf'],
    'k3.ts': ['k3.ts.Deep'],
  },
  nameToIds: { Seed: ['k0.ts.Seed'], Middle: ['k1.ts.Middle'], Leaf: ['k2.ts.Leaf'], Deep: ['k3.ts.Deep'] },
  idToFile: {
    'k0.ts.Seed': 'k0.ts',
    'k1.ts.Middle': 'k1.ts',
    'k2.ts.Leaf': 'k2.ts',
    'k3.ts.Deep': 'k3.ts',
  },
  idToName: {
    'k0.ts.Seed': 'Seed',
    'k1.ts.Middle': 'Middle',
    'k2.ts.Leaf': 'Leaf',
    'k3.ts.Deep': 'Deep',
  },
  dependencies: { 'k0.ts.Seed': ['k1.ts.Middle'], 'k1.ts.Middle': ['k2.ts.Leaf'], 'k2.ts.Leaf': ['k3.ts.Deep'], 'k3.ts.Deep': [] },
  dependents: { 'k0.ts.Seed': [], 'k1.ts.Middle': ['k0.ts.Seed'], 'k2.ts.Leaf': ['k1.ts.Middle'], 'k3.ts.Deep': ['k2.ts.Leaf'] },
  entityDetails: {
    'k0.ts.Seed': {
      kind: 'class',
      members: [
        { name: 'constructor', kind: 'method', visibility: 'public', signature: 'constructor(a: number)' },
        { name: 'count', kind: 'field', visibility: 'private', signature: 'number' },
        { name: 'labels', kind: 'field', visibility: 'private', signature: 'string[]' },
        { name: 'run', kind: 'method', visibility: 'public', signature: 'run(): Promise<void>' },
        { name: 'stop', kind: 'method', visibility: 'public', signature: 'stop(): void' },
        { name: 'reset', kind: 'method', visibility: 'private', signature: 'reset(): void' },
      ],
    },
    'k1.ts.Middle': {
      kind: 'interface',
      members: [
        { name: 'id', kind: 'field', visibility: 'public', signature: 'string' },
        { name: 'fork', kind: 'field', visibility: 'public', signature: 'IProviderFork' },
      ],
    },
    'k2.ts.Leaf': { kind: 'function', members: [{ name: 'options', kind: 'field', visibility: 'public', signature: 'Options' }] },
    'k3.ts.Deep': { kind: 'abstract', members: [] },
  },
};

test('AC-415 实体细节：kind 透传、members 按上限截断并报告，kindCounts 统计预算前全体', () => {
  // Three hops reach all four entities; a two-node budget keeps only the seed
  // and its first neighbour, which is what makes "pre-budget" observable.
  const result = generateGraph(
    DETAIL_INDEX,
    { files: [], identifiers: ['Seed'] },
    { hops: 3, maxNodes: 2, maxMembers: 3 },
  );
  console.log(
    `AC-415 reading: detail nodes=${JSON.stringify(result.graph.entity.nodes.map((node) => [node.id, node.kind, node.members?.length ?? 0]))} ` +
      `kindCounts=${JSON.stringify(result.stats.kindCounts)} membersTruncated=${String(result.stats.membersTruncated)} ` +
      `membersPerEntity=${String(result.stats.membersPerEntity)}`,
  );

  const byId = new Map(result.graph.entity.nodes.map((node) => [node.id, node]));
  const seedNode = byId.get('k0.ts.Seed');
  const middleNode = byId.get('k1.ts.Middle');
  assert.ok(seedNode !== undefined && middleNode !== undefined, 'the two retained nodes must be present');
  assert.equal(byId.size, 2, 'the node budget still cuts the entity graph at maxNodes');

  // ① kind is the normalised entity kind, one per retained node.
  assert.equal(seedNode.kind, 'class');
  assert.equal(middleNode.kind, 'interface');

  // ② members are front-truncated to maxMembers (not re-sorted, not dropped).
  assert.equal(result.stats.membersPerEntity, 3);
  assert.equal(seedNode.members?.length, 3, 'a six-member class ships exactly the cap');
  assert.deepEqual(
    seedNode.members?.map((member) => member.name),
    ['constructor', 'count', 'labels'],
    'the retained members are the first N in ArchGuard order',
  );
  assert.deepEqual(seedNode.members?.[1], {
    name: 'count',
    kind: 'field',
    visibility: 'private',
    signature: 'number',
  });
  assert.equal(result.stats.membersTruncated, true, 'a cut member list must be visibly cut');
  assert.equal(middleNode.members?.length, 2, 'an under-cap entity keeps its whole body');

  // ③ kindCounts is a reading of the PRE-budget reachable set: all four kinds,
  //    including the two entities the node budget cut.
  assert.deepEqual(result.stats.kindCounts, { class: 1, interface: 1, function: 1, abstract: 1 });
  assert.equal(result.stats.entityTotal, 4, 'the kind counts describe the same pre-budget total');
  assert.equal(result.stats.entityNodes, 2);

  // ④ the file graph is a path projection: no kind, no members, old shape.
  for (const node of result.graph.file.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ['distance', 'id', 'label']);
  }
});

test('AC-415 实体细节：无 entityDetails 时保持旧形态，不凭空产出 kindCounts', () => {
  const legacy = generateGraph(FIXTURE, FULL_CHAIN_SEEDS, { hops: 1, maxNodes: 100, maxMembers: 5 });
  for (const node of legacy.graph.entity.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ['distance', 'id', 'label'], 'a detail-less index emits the legacy node');
  }
  assert.equal('kindCounts' in legacy.stats, false, 'no details ⇒ no kindCounts key at all');
  // The cap was still applied (a knob was passed), so its readout rides, but it
  // is a reading of zero truncation rather than of missing data.
  assert.equal(legacy.stats.membersPerEntity, 5);
  assert.equal(legacy.stats.membersTruncated, false);

  // And with no cap at all, neither member key is emitted — BYTE-identical old
  // stats shape for callers that never heard of members.
  const uncapped = generateGraph(FIXTURE, FULL_CHAIN_SEEDS, { hops: 1, maxNodes: 100 });
  assert.equal('membersPerEntity' in uncapped.stats, false);
  assert.equal('membersTruncated' in uncapped.stats, false);
  assert.equal('kindCounts' in uncapped.stats, false);
});

test('AC-415 带类型边：call/composition 选不同箭头，自环被丢弃', () => {
  const index: ArchIndex = {
    fileToIds: { 'a.ts': ['a.ts.A', 'a.ts.B'], 'b.ts': ['b.ts.C'] },
    nameToIds: { A: ['a.ts.A'], B: ['a.ts.B'], C: ['b.ts.C'] },
    dependencies: { 'a.ts.A': ['b.ts.C'], 'a.ts.B': ['b.ts.C'], 'b.ts.C': [] },
    dependents: { 'b.ts.C': ['a.ts.A', 'a.ts.B'], 'a.ts.A': [], 'a.ts.B': [] },
    idToFile: { 'a.ts.A': 'a.ts', 'a.ts.B': 'a.ts', 'b.ts.C': 'b.ts' },
    idToName: { 'a.ts.A': 'A', 'a.ts.B': 'B', 'b.ts.C': 'C' },
    relationsByType: {
      dependency: [['a.ts.A', 'b.ts.C']],
      // The second `call` pair is an entity self-loop: an intra-entity method
      // call, which the generator drops rather than drawing `A -.-> A`.
      call: [['a.ts.B', 'b.ts.C'], ['a.ts.A', 'a.ts.A']],
      composition: [['a.ts.B', 'b.ts.C']],
    },
  };

  const result = generateGraph(index, { files: [], identifiers: ['A', 'B', 'C'] }, { hops: 0, maxNodes: 50 });
  const entity = result.mmd.entity;

  assert.ok(entity.includes('a_ts_A --> b_ts_C'), 'dependency edge must use -->');
  assert.ok(entity.includes('a_ts_B -.-> b_ts_C'), 'call edge must use -.->');
  assert.ok(entity.includes('a_ts_B ==> b_ts_C'), 'composition edge must use ==>');
  assert.ok(!entity.includes('a_ts_A -.-> a_ts_A'), 'an entity self-loop must be dropped');
  assert.deepEqual(validateMermaid(entity), [], 'the typed document must validate cleanly');
  assert.strictEqual(result.stats.entityEdges, 3, 'dependency + call + composition = 3 edges, self-loop dropped');
});

// ------------------------- mention tiers -------------------------

/**
 * A real-shape tiering fixture.
 *
 *  · `main` resolves to FIVE entities across five files (the ambiguous-name
 *    shape the live index has for common names);
 *  · `OnlyOne` is unique;
 *  · `src/big.ts` holds EIGHT entities (the file-expansion shape).
 *
 * `src/a.ts` is named alongside `main` in the synthetic transcript, so its one
 * entity is disambiguated to `direct` while the other four stay `name`.
 */
const TIER_MAIN_IDS = [
  'src/a.ts.mainA',
  'src/b.ts.mainB',
  'src/c.ts.mainC',
  'src/d.ts.mainD',
  'src/e.ts.mainE',
];
const TIER_BIG_IDS = Array.from({ length: 8 }, (_unused, index) => `src/big.ts.e${String(index)}`);
const TIER_INDEX: ArchIndex = {
  fileToIds: {
    'src/a.ts': ['src/a.ts.mainA'],
    'src/b.ts': ['src/b.ts.mainB'],
    'src/c.ts': ['src/c.ts.mainC'],
    'src/d.ts': ['src/d.ts.mainD'],
    'src/e.ts': ['src/e.ts.mainE'],
    'src/only.ts': ['src/only.ts.OnlyOne'],
    'src/big.ts': TIER_BIG_IDS,
  },
  nameToIds: { main: TIER_MAIN_IDS, OnlyOne: ['src/only.ts.OnlyOne'] },
  idToFile: Object.fromEntries([
    ...TIER_MAIN_IDS.map((id) => [id, id.slice(0, id.lastIndexOf('.'))]),
    ['src/only.ts.OnlyOne', 'src/only.ts'],
    ...TIER_BIG_IDS.map((id) => [id, 'src/big.ts']),
  ]),
  idToName: Object.fromEntries([
    ...TIER_MAIN_IDS.map((id) => [id, 'main']),
    ['src/only.ts.OnlyOne', 'OnlyOne'],
    ...TIER_BIG_IDS.map((id) => [id, id.slice(id.lastIndexOf('.') + 1)]),
  ]),
  dependencies: Object.fromEntries([...TIER_MAIN_IDS, 'src/only.ts.OnlyOne', ...TIER_BIG_IDS].map((id) => [id, []])),
  dependents: Object.fromEntries([...TIER_MAIN_IDS, 'src/only.ts.OnlyOne', ...TIER_BIG_IDS].map((id) => [id, []])),
};

const TIER_SEEDS: GraphSeeds = {
  files: ['src/big.ts'],
  identifiers: ['main', 'OnlyOne'],
  mentions: {
    // Only src/a.ts co-occurred with the name in the transcript.
    identifierFiles: { main: ['src/a.ts'] },
    identifierCounts: { main: 3, OnlyOne: 1 },
    fileCounts: { 'src/big.ts': 2 },
  },
};

test('mention tiers：direct > name > file，节点带档位与提及数，stats.seedTiers 与节点一致', () => {
  const result = generateGraph(TIER_INDEX, TIER_SEEDS, { hops: 0, maxNodes: 100 });
  const byId = new Map(result.graph.entity.nodes.map((node) => [node.id, node]));
  console.log(
    `mention-tier reading: threshold=${DIRECT_MAX_CANDIDATES} tiers=` +
      JSON.stringify(result.graph.entity.nodes.map((node) => [node.id, node.mentionTier, node.mentionCount])) +
      ` stats=${JSON.stringify(result.stats.seedTiers)}`,
  );

  assert.equal(DIRECT_MAX_CANDIDATES, 3);
  assert.equal(result.stats.entityNodes, TIER_MAIN_IDS.length + 1 + TIER_BIG_IDS.length);

  // ① ambiguous name + path co-occurrence ⇒ direct; without the path ⇒ name.
  assert.equal(byId.get('src/a.ts.mainA')?.mentionTier, 'direct', 'the co-mentioned file disambiguates the name');
  for (const id of TIER_MAIN_IDS.slice(1)) {
    assert.equal(byId.get(id)?.mentionTier, 'name', `${id} is a same-name candidate`);
  }
  // ② a unique name is direct by candidate count alone.
  assert.equal(byId.get('src/only.ts.OnlyOne')?.mentionTier, 'direct');
  // ③ file-only expansion is the file tier.
  for (const id of TIER_BIG_IDS) {
    assert.equal(byId.get(id)?.mentionTier, 'file', `${id} was expanded from its file`);
  }

  // mentionCount is the number of messages naming the resolving seed.
  assert.equal(byId.get('src/a.ts.mainA')?.mentionCount, 3);
  assert.equal(byId.get('src/only.ts.OnlyOne')?.mentionCount, 1);
  assert.equal(byId.get('src/big.ts.e0')?.mentionCount, 2);

  // ④ the stats counts are read from the EMITTED nodes, so they agree.
  // `pinned` joins the vocabulary with the curation task; this fixture has no
  // pins, so the count map stays the original three keys.
  const counted: Partial<Record<'direct' | 'name' | 'file' | 'pinned', number>> = {
    direct: 0,
    name: 0,
    file: 0,
  };
  for (const node of result.graph.entity.nodes) {
    if (node.mentionTier !== undefined) counted[node.mentionTier] = (counted[node.mentionTier] ?? 0) + 1;
  }
  assert.deepEqual(result.stats.seedTiers, counted);
  assert.deepEqual(result.stats.seedTiers, { direct: 2, name: 4, file: 8 });
});

test('mention tiers：没有 provenance 的旧调用逐字节保持旧节点与旧 stats 形态', () => {
  const legacySeeds: GraphSeeds = { files: TIER_SEEDS.files, identifiers: TIER_SEEDS.identifiers };
  const result = generateGraph(TIER_INDEX, legacySeeds, { hops: 0, maxNodes: 100 });

  for (const node of result.graph.entity.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ['distance', 'id', 'label']);
  }
  assert.equal('seedTiers' in result.stats, false, 'no provenance ⇒ no seedTiers key');
});

// ------------------- element / relation filters -------------------

/**
 * A real-shape filter fixture: three structural entities, one function, and a
 * class (`D`) that is reachable ONLY through the function.
 *
 *  · `A` (class) — the seed; imports `Fn` and `C`, and CALLS `Fn`.
 *  · `Fn` (function) — imports `D`; the kind the default filter hides.
 *  · `C` (class) — imports `B` (composition); reachable directly from `A`.
 *  · `B` (interface) — reachable from `C` by a composition edge, never directly.
 *  · `D` (class) — reachable only through `Fn`, so it disappears when a hidden
 *    kind is not traversed through.
 *
 * `dependencies`/`dependents` are the full adjacency (`A` imports its callees),
 * `relationsByType` carries the typed edges of a REAL index (call + dependency +
 * composition), and `entityDetails` carries the kinds an `arch.json` supplies.
 */
const FILTER_INDEX: ArchIndex = {
  fileToIds: {
    'a.ts': ['a.ts.A'],
    'fn.ts': ['fn.ts.Fn'],
    'b.ts': ['b.ts.B'],
    'c.ts': ['c.ts.C'],
    'd.ts': ['d.ts.D'],
  },
  nameToIds: { A: ['a.ts.A'], Fn: ['fn.ts.Fn'], B: ['b.ts.B'], C: ['c.ts.C'], D: ['d.ts.D'] },
  idToFile: { 'a.ts.A': 'a.ts', 'fn.ts.Fn': 'fn.ts', 'b.ts.B': 'b.ts', 'c.ts.C': 'c.ts', 'd.ts.D': 'd.ts' },
  idToName: { 'a.ts.A': 'A', 'fn.ts.Fn': 'Fn', 'b.ts.B': 'B', 'c.ts.C': 'C', 'd.ts.D': 'D' },
  dependencies: {
    'a.ts.A': ['fn.ts.Fn', 'c.ts.C'],
    'fn.ts.Fn': ['d.ts.D'],
    'c.ts.C': ['b.ts.B'],
    'b.ts.B': [],
    'd.ts.D': [],
  },
  dependents: {
    'a.ts.A': [],
    'fn.ts.Fn': ['a.ts.A'],
    'c.ts.C': ['a.ts.A'],
    'b.ts.B': ['c.ts.C'],
    'd.ts.D': ['fn.ts.Fn'],
  },
  relationsByType: {
    call: [['a.ts.A', 'fn.ts.Fn']],
    dependency: [['a.ts.A', 'c.ts.C'], ['fn.ts.Fn', 'd.ts.D']],
    composition: [['c.ts.C', 'b.ts.B']],
  },
  entityDetails: {
    'a.ts.A': { kind: 'class', members: [] },
    'fn.ts.Fn': { kind: 'function', members: [] },
    'b.ts.B': { kind: 'interface', members: [] },
    'c.ts.C': { kind: 'class', members: [] },
    'd.ts.D': { kind: 'class', members: [] },
  },
};

const STRUCTURAL_KINDS = ['class', 'interface', 'enum', 'abstract'] as const;
const FILTER_SEED: GraphSeeds = { files: [], identifiers: ['A'] };

test('元素筛选：被隐藏种类的节点不穿过（其后代不可达），direct 种子仍保留', () => {
  // Kinds only: the adjacency is the index's own (dependencies/dependents), so
  // this leg isolates the ELEMENT axis. `Fn` is hidden and must not be used as
  // a stepping stone to `D`.
  const kindsOnly = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 2,
    maxNodes: 100,
    kinds: [...STRUCTURAL_KINDS],
  });
  const kindLabels = entityLabels(kindsOnly);
  console.log(
    `filter reading: kinds-only nodes=${JSON.stringify(kindLabels)} edges=${JSON.stringify(
      kindsOnly.graph.entity.edges.map((edge) => `${edge.from}->${edge.to}:${edge.relationType}`),
    )} hidden=${JSON.stringify(kindsOnly.stats.hidden)}`,
  );
  assert.deepEqual(kindLabels, ['A', 'B', 'C'], 'the hidden function is not a node and D is not reachable through it');
  assert.equal(kindLabels.includes('D'), false, 'a node only reachable THROUGH a hidden kind is unreachable');
  assert.deepEqual(
    kindsOnly.graph.entity.edges.map((edge) => `${edge.from}->${edge.to}:${edge.relationType}`),
    ['a.ts.A->c.ts.C:dependency', 'c.ts.C->b.ts.B:composition'],
    'the emitted edges are between retained nodes, typed',
  );

  // A direct mention is exempt even when its kind is hidden: `Fn` is seeded by
  // its unique name (a direct tier), so a kinds-only filter still keeps it.
  const directSeed = generateGraph(FILTER_INDEX, { files: [], identifiers: ['A', 'Fn'] }, {
    hops: 0,
    maxNodes: 100,
    kinds: [...STRUCTURAL_KINDS],
  });
  assert.deepEqual(entityLabels(directSeed), ['A', 'Fn'], 'the direct function seed survives the element filter');
});

test('关系筛选：只沿允许的关系类型扩展，未允许类型的边不发射', () => {
  // Relations only: every kind is admissible, so this leg isolates the RELATION
  // axis. From `A`, only the dependency to `C` may be followed — the `call` to
  // `Fn` and `C`'s `composition` to `B` are not traversed.
  const dependencyOnly = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 2,
    maxNodes: 100,
    relations: ['dependency'],
  });
  console.log(
    `filter reading: dependency-only nodes=${JSON.stringify(entityLabels(dependencyOnly))} ` +
      `edges=${JSON.stringify(dependencyOnly.graph.entity.edges.map((edge) => `${edge.from}->${edge.to}:${edge.relationType}`))}`,
  );
  assert.deepEqual(entityLabels(dependencyOnly), ['A', 'C'], 'only dependency edges were traversed');
  assert.deepEqual(
    dependencyOnly.graph.entity.edges.map((edge) => `${edge.from}->${edge.to}:${edge.relationType}`),
    ['a.ts.A->c.ts.C:dependency'],
  );

  // Structural-only reaches `C` (dependency is excluded, so actually nothing
  // beside the seed here): the fixture's only structural edge from A is the
  // composition from C, which A cannot reach without the dependency to C.
  const structuralOnly = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 2,
    maxNodes: 100,
    relations: ['composition', 'inheritance', 'implementation'],
  });
  assert.deepEqual(entityLabels(structuralOnly), ['A'], 'no structural edge leaves the seed');
  assert.deepEqual(structuralOnly.graph.entity.edges, []);
});

test('筛选后的预算：隐藏函数腾出的名额被结构性实体填补（entityTruncated 由 true 变 false）', () => {
  // One class seed, six function neighbours and three class neighbours — all
  // through dependency edges, so only the ELEMENT filter can change the set.
  const files: Record<string, string[]> = { 'seed.ts': ['seed.ts.Seed'] };
  const names: Record<string, string[]> = { Seed: ['seed.ts.Seed'] };
  const idToFile: Record<string, string> = { 'seed.ts.Seed': 'seed.ts' };
  const idToName: Record<string, string> = { 'seed.ts.Seed': 'Seed' };
  const dependencies: Record<string, string[]> = { 'seed.ts.Seed': [] };
  const dependents: Record<string, string[]> = { 'seed.ts.Seed': [] };
  const details: Record<string, { kind: 'class' | 'function'; members: never[] }> = {
    'seed.ts.Seed': { kind: 'class', members: [] },
  };
  const pairs: [string, string][] = [];
  for (let index = 0; index < 9; index += 1) {
    const kind = index < 6 ? 'function' : 'class';
    const id = `seed.ts.${kind === 'function' ? 'fn' : 'Klass'}${String(index)}`;
    files[`seed.ts`].push(id);
    idToFile[id] = 'seed.ts';
    idToName[id] = id.slice(id.lastIndexOf('.') + 1);
    dependencies['seed.ts.Seed'].push(id);
    dependencies[id] = [];
    dependents[id] = ['seed.ts.Seed'];
    details[id] = { kind, members: [] };
    pairs.push(['seed.ts.Seed', id]);
  }

  const index: ArchIndex = {
    fileToIds: files,
    nameToIds: names,
    idToFile,
    idToName,
    dependencies,
    dependents,
    relationsByType: { dependency: pairs },
    entityDetails: details,
  };

  const unfiltered = generateGraph(index, { files: [], identifiers: ['Seed'] }, { hops: 1, maxNodes: 4 });
  const filtered = generateGraph(index, { files: [], identifiers: ['Seed'] }, {
    hops: 1,
    maxNodes: 4,
    kinds: [...STRUCTURAL_KINDS],
  });
  console.log(
    `filter reading: budget unfiltered nodes=${unfiltered.stats.entityNodes} truncated=${String(unfiltered.stats.entityTruncated)} ` +
      `filtered nodes=${filtered.stats.entityNodes} truncated=${String(filtered.stats.entityTruncated)} ` +
      `labels=${JSON.stringify(entityLabels(filtered))} hidden=${JSON.stringify(filtered.stats.hidden)}`,
  );

  assert.equal(unfiltered.stats.entityTruncated, true, 'without the filter the 10-node set exceeds the budget');
  assert.equal(unfiltered.stats.entityNodes, 4);
  assert.equal(unfiltered.stats.entityTotal, 10);

  assert.equal(filtered.stats.entityTruncated, false, 'hiding the six functions frees the budget');
  assert.equal(filtered.stats.entityNodes, 4, 'the four structural entities fill the budget exactly');
  assert.equal(filtered.stats.entityTotal, 4, 'the filtered total is the post-filter reachable count');
  assert.deepEqual(
    filtered.graph.entity.nodes.map((node) => node.kind),
    ['class', 'class', 'class', 'class'],
    'only structural entities survive',
  );
  assert.deepEqual(filtered.stats.hidden, {
    byKind: { function: 6 },
    byRelation: {},
    isolated: 0,
  });
});

test('stats.hidden / relationCounts 是未过滤的读数；不带筛选时两个键都不存在', () => {
  const filtered = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 2,
    maxNodes: 100,
    kinds: [...STRUCTURAL_KINDS],
    relations: ['dependency'],
  });
  console.log(
    `filter reading: stats relationCounts=${JSON.stringify(filtered.stats.relationCounts)} ` +
      `hidden=${JSON.stringify(filtered.stats.hidden)} kindCounts=${JSON.stringify(filtered.stats.kindCounts)}`,
  );

  // The unfiltered traversal reaches A, Fn, C, B and D; the relation tally is
  // over the edges between THOSE nodes, before either axis removes anything.
  assert.deepEqual(filtered.stats.relationCounts, { call: 1, dependency: 2, composition: 1 });
  // `Fn` is the one non-direct entity whose kind the filter hides; `D` was never
  // reachable from the seed, so it is not a hidden-by-kind node.
  assert.deepEqual(filtered.stats.hidden, {
    byKind: { function: 1 },
    byRelation: { call: 1, composition: 1 },
    isolated: 0,
  });
  // The element popover's counts stay unfiltered: functions can be shown (and
  // re-enabled) even while they are hidden.
  assert.deepEqual(filtered.stats.kindCounts, { class: 3, function: 1, interface: 1 });

  // No filter requested ⇒ the two filter-only readouts are absent entirely, so
  // the payload keeps its pre-filter shape.
  const unfiltered = generateGraph(FILTER_INDEX, FILTER_SEED, { hops: 2, maxNodes: 100 });
  assert.equal('hidden' in unfiltered.stats, false);
  assert.equal('relationCounts' in unfiltered.stats, false);
  assert.equal(unfiltered.stats.entityTotal, 5, 'the unfiltered scope is the whole two-hop set');
  assert.deepEqual(entityLabels(unfiltered), ['A', 'B', 'C', 'D', 'Fn']);
});

// ---------------------------------------------------------------------------
// Manual curation: excludeIds (removal before traversal) + extraSeeds (pins)
// ---------------------------------------------------------------------------

test('AC-415 curation：excludeIds 在遍历前移除，节点不穿过、边一并消失', () => {
  // Without the removal, two hops from A reach A, Fn, C, D and B.
  const baseline = generateGraph(FILTER_INDEX, FILTER_SEED, { hops: 2, maxNodes: 100 });
  assert.deepEqual(entityLabels(baseline), ['A', 'B', 'C', 'D', 'Fn']);

  // Removing C severs the ONLY path to B (A →(dependency) C →(composition) B).
  const curated = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 2,
    maxNodes: 100,
    excludeIds: ['c.ts.C'],
  });
  assert.deepEqual(entityLabels(curated), ['A', 'D', 'Fn'], 'the removed node is gone and B is unreachable through it');
  assert.equal(
    curated.graph.entity.edges.some((edge) => edge.from === 'c.ts.C' || edge.to === 'c.ts.C'),
    false,
    'every edge incident to the removed entity is gone',
  );
  assert.deepEqual(curated.stats.curation, { pinned: 0, excluded: 1 }, 'the readout counts the removal that took effect');

  // Removal beats a seed: an excluded session seed does not reappear as a root.
  const excludedSeed = generateGraph(FILTER_INDEX, { files: [], identifiers: ['A', 'C'] }, {
    hops: 1,
    maxNodes: 100,
    excludeIds: ['a.ts.A', 'c.ts.C'],
  });
  assert.deepEqual(entityLabels(excludedSeed), [], 'both roots were removed, so there is nothing to traverse from');
});

test('AC-415 curation：extraSeeds 是 pinned 根，免于元素/关系筛选且成员不被裁剪', () => {
  // `Fn` is a function; the element filter hides functions, but a pin is exempt.
  const pinned = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 1,
    maxNodes: 100,
    kinds: [...STRUCTURAL_KINDS],
    extraSeeds: ['fn.ts.Fn'],
  });
  assert.deepEqual(entityLabels(pinned), ['A', 'C', 'D', 'Fn'], 'the pinned function survives the element axis');
  const fn = pinned.graph.entity.nodes.find((node) => node.id === 'fn.ts.Fn');
  assert.equal(fn?.distance, 0, 'a pin is a root');
  assert.equal(fn?.mentionTier, 'pinned', 'a pin carries its own tier, stronger than direct');
  assert.deepEqual(pinned.stats.curation, { pinned: 1, excluded: 0 });

  // A pin is also a root under the relation axis: the call edge A → Fn is not
  // followed (call is filtered out), yet Fn is still drawn.
  const relationFiltered = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 0,
    maxNodes: 100,
    relations: ['dependency'],
    extraSeeds: ['fn.ts.Fn'],
  });
  assert.deepEqual(entityLabels(relationFiltered), ['A', 'Fn']);

  // Detail cropping: the pinned node keeps every member even when the cap cuts
  // its neighbours.
  const withMembers: ArchIndex = {
    ...FILTER_INDEX,
    entityDetails: {
      ...FILTER_INDEX.entityDetails,
      'a.ts.A': {
        kind: 'class',
        members: [
          { name: 'a1', kind: 'field' },
          { name: 'a2', kind: 'field' },
        ],
      },
      'fn.ts.Fn': {
        kind: 'function',
        members: [
          { name: 'f1', kind: 'field' },
          { name: 'f2', kind: 'field' },
        ],
      },
    },
  };
  const capped = generateGraph(withMembers, { files: [], identifiers: ['A'] }, {
    hops: 1,
    maxNodes: 100,
    maxMembers: 1,
    extraSeeds: ['fn.ts.Fn'],
  });
  const cappedA = capped.graph.entity.nodes.find((node) => node.id === 'a.ts.A');
  const cappedFn = capped.graph.entity.nodes.find((node) => node.id === 'fn.ts.Fn');
  assert.equal(cappedA?.members?.length, 1, 'an ordinary node is still cut by the cap');
  assert.equal(cappedFn?.members?.length, 2, 'a pinned node is exempt from the detail cut');
});

test('AC-415 curation：解析不到的 extraSeeds 进入 unresolved.ids，缺省参数保持旧响应形态', () => {
  const missing = generateGraph(FILTER_INDEX, FILTER_SEED, {
    hops: 0,
    maxNodes: 100,
    extraSeeds: ['no/such.Entity'],
  });
  assert.deepEqual(missing.unresolved.ids, ['no/such.Entity'], 'an unknown pin is reported, never silently dropped');
  assert.deepEqual(missing.stats.curation, { pinned: 0, excluded: 0 });

  // Absent curation params: no new keys at all — the pre-curation payload shape.
  const legacy = generateGraph(FILTER_INDEX, FILTER_SEED, { hops: 1, maxNodes: 100 });
  assert.equal('curation' in legacy.stats, false, 'stats.curation is absent without the params');
  assert.equal('ids' in legacy.unresolved, false, 'unresolved.ids is absent without extraSeeds');
});
