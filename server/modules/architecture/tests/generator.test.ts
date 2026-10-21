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

import { generateGraph, validateMermaid, type ArchIndex, type GenerateGraphResult } from '../index.js';

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
