/**
 * The frontend DIRECTORY-level import-cycle ratchet for `src/`.
 *
 * The architecture-analysis routine reported five non-trivial directory SCCs in `src`
 * (finding `src-import-cycles-unpinned`, runId `architecture-analysis-1793381097836`,
 * 2026-10-30): chat/tools ↔ chat/tools/ContentRenderers ↔ chat/transcript;
 * cockpit ↔ cockpit/hooks ↔ project-workspace; git-panel ↔ git-panel/changes ↔
 * git-panel/history; architecture ↔ architecture/hooks; settings/hooks ↔ settings/tabs.
 * RE-READ 2026-11-02 (task gap-routine-architecture-analysis-god-package-src-cockpit): the
 * cockpit god-package split moved its card and workspace files into `cockpit/cards` and
 * `cockpit/workspace`. Those files already imported each other, so the same dependency web is
 * now read across four cockpit directories plus project-workspace; the group was re-measured and
 * re-pinned member-for-member rather than dropped. This is the mandated re-read for a structural
 * split, not a widened dependency: the module-level SCC below is unchanged.
 * RE-READ 2026-11-04 (task gap-routine-architecture-analysis-god-package-src-architecture): the
 * architecture god-package split moved every implementation file out of `modules/architecture`
 * into the `render/`, `layout/` and `dom/` leaves, leaving the root as the barrel. The former
 * `architecture <-> architecture/hooks` dependency now runs root -> hooks -> dom, so that group
 * was re-measured and LOWERED out of the pin; no new group or member appeared.
 * The backend already had AC-394's directory budget, but `src` had no cycle criterion and
 * `.oxlintrc.json` enables no `import/no-cycle`, so those five could widen unmeasured.
 *
 * This criterion pins them. It reads the tree with `server/shared/import-graph.ts` — the
 * SAME walk, resolver and Tarjan core AC-394 uses, never a second copy — passing `src` as
 * the scan root, so `@/` resolves to `src/` exactly as the bundler and vitest resolve it.
 *
 * THE RATCHET: the groups below may only SHRINK. A shrink is recorded by lowering this
 * constant AND the committed baseline JSON; the two must name the same groups, so a wider
 * cycle cannot be blessed by editing the JSON alone. A new non-trivial SCC — or a new
 * member joining one of the pinned groups — reds this file on the first commit that carries it.
 *
 * The counts in the JSON are PROVENANCE (re-measured on the date named there), not a gate:
 * a new acyclic import is ordinary feature work and must not red this criterion. What IS
 * gated is non-vacuity — a walk that matched no files would otherwise report "zero cycles"
 * and pass, so the real-tree case asserts a floor on files, directories and resolved edges.
 *
 * MODULE GRANULARITY (finding `src-module-scc-cockpit-hub`). The directory reading above is
 * finer than the question the architecture review asks: "which FEATURES depend on each other?"
 * A node there is `modules/<name>` (the scope `.oxlintrc.json` calls `frontend-module`), and an
 * edge is any cross-module import, collapsed from the same walk and resolved with the same
 * resolver — no second scanner. The second reading must see no feature cycle; re-read 2026-11-19
 * (task gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace) it now sees
 * none: the cockpit reads the workspace's optimistic-session registration through the shared
 * seam `@/shared/context/OptimisticSessionContext` rather than importing `@/modules/project-workspace`,
 * so `project-workspace -> cockpit` is one-way. The cockpit's leaf contract is its own top-level
 * module so the chat/sidebar/ui-scenario edges into it cannot pull those modules back into the
 * cockpit's SCC. A new module cycle, or a leaf contract that grows an out-edge, reds this file.
 *
 * FILE GRANULARITY (finding `file-cycle-shared-api-voiceconfig-barrel`, 2026-11-07). Both readings
 * above collapse their nodes, so neither can see a cycle between two FILES of one package:
 * `src/shared/api` is one directory node, and `src/shared` is not a feature module at all. That is
 * how `voiceConfig.ts` (importing the `api` object from its own package's `index.ts` barrel) and
 * `index.ts` (value-importing `readVoiceConfig`/`voiceConfigHeaders` back) stayed one file-level
 * value SCC, invisible to every committed ratchet. The third reading below is the same walk,
 * resolver and Tarjan core at file nodes over `src/shared`, pinned to ZERO non-trivial SCCs.
 *
 * ENTITY GRANULARITY (finding `cycle-voice-asr-factory-singleton`, 2026-11-14). All three
 * readings above collapse their nodes to files or directories, so a cycle between two ENTITIES OF
 * ONE FILE is invisible to every one of them. That is how `createVoiceClientAsrEngine` (the
 * standalone adapter factory) and `VoiceClientAsrEngine` (the per-tab lifecycle class) stayed a
 * 2-node SCC: the factory reached `voiceClientAsrEngineInstance.noteProgress()` from its worker
 * message handler, while `install()` called the factory. Archguard's class-level reading saw it;
 * the committed ratchets did not. The fourth reading below is an entity-level reference graph over
 * `src/shared`, pinned to ZERO non-trivial SCCs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  collectTypeScriptSources,
  scanFileImportGraph,
  scanImportGraph,
  scriptKindFor,
  strongComponents,
  type FileGraph,
  type Graph,
  type SourceFile,
} from '@/shared/import-graph.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const BASELINE_PATH = path.join(TEST_DIR, 'frontend-import-cycle-budget.baseline.json');

/**
 * The ratchet pin, spelled member by member so a widened cycle cannot be blessed by editing
 * the JSON alone. Each group is the exact member set measured on the merged tree; lowering
 * one (a cycle closed by a port/leaf extraction) is a deliberate edit here and in the JSON.
 */
const CYCLE_GROUPS: readonly string[][] = [
  ['modules/chat/tools', 'modules/chat/tools/ContentRenderers', 'modules/chat/transcript'],
  // Re-read 2026-11-19 (task gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace):
  // the cockpit's card list now reads the optimistic-session registration seam from
  // `@/shared/context/OptimisticSessionContext` instead of `@/modules/project-workspace`, so
  // `project-workspace` no longer has an out-edge into the cockpit cluster and drops out of the
  // directory group (5 -> 4 members). The residual root-barrel <-> subdirectory web is the
  // cockpit module's own structure and may only shrink further.
  ['modules/cockpit', 'modules/cockpit/cards', 'modules/cockpit/hooks', 'modules/cockpit/workspace'],
  ['modules/git-panel', 'modules/git-panel/changes', 'modules/git-panel/history'],
  // Lowered 2026-11-04 (architecture god-package split): the root <-> hooks edge now runs
  // through the leaves (root -> hooks -> dom), so this group no longer exists.
  ['modules/settings/hooks', 'modules/settings/tabs'],
];

/**
 * A walk that returns far fewer files, directories or edges than the tree carries is a broken
 * reading, not a clean one. These floors sit well below the measured 688 files / 108 directories
 * / 2144 resolved static edges (2026-10-31) so they only fire on a collapsed scan.
 */
const MIN_FILES = 600;
const MIN_DIRECTORIES = 100;
const MIN_STATIC_FILE_EDGES = 2000;

/**
 * The module-level pin (finding `src-module-scc-cockpit-hub`): the ONLY non-trivial SCC in the
 * `modules/<name>` graph was cockpit ↔ project-workspace. Re-read 2026-11-19 (task
 * gap-routine-architecture-analysis-cycle-cockpit-cluster-project-workspace): the cockpit's cards
 * list now reads the optimistic-session registration seam from
 * `@/shared/context/OptimisticSessionContext`, so `project-workspace -> cockpit` is a one-way
 * dependency and the module graph carries no non-trivial SCC. The pin is empty and may only
 * shrink; a new module cycle reds this file.
 */
const MODULE_SCC_GROUPS: readonly string[][] = [];

/**
 * Non-vacuity for the module reading: the merged tree carries 29 module nodes and 53
 * cross-module import pairs (2026-10-31, the same walk after the leaf-contract extraction).
 * The floors sit far below so only a collapsed scan trips them.
 */
const MIN_MODULES = 25;
const MIN_CROSS_MODULE_EDGES = 30;

/**
 * Non-vacuity floors for the FILE-level `src/shared` reading (finding
 * `file-cycle-shared-api-voiceconfig-barrel`). The tree carries 77 files and 139 resolved file
 * edges; the pin itself is "no non-trivial SCC", which a collapsed walk would satisfy for the
 * wrong reason.
 */
const MIN_SHARED_FILES = 60;
const MIN_SHARED_FILE_EDGES = 100;

type Baseline = {
  measuredAt: string;
  scope: string;
  cycleGroups: string[][];
  moduleSccGroups?: string[][];
  readings: Record<string, number>;
};

/** Member order inside a group and the order between groups are not part of the reading. */
function normalize(groups: readonly string[][]): string[][] {
  return groups
    .map((group) => [...group].sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/**
 * The ratchet itself, driven by the same call in every case: the real tree must equal the
 * pinned groups, a planted cycle must NOT, and an acyclic fixture must equal the empty pin.
 * Equality (not subset) is what makes a shrink an explicit lowering of both pins instead of
 * a silent pass, matching AC-394's server criterion.
 */
function assertCycleBudget(graph: Graph, pinned: readonly string[][]): void {
  assert.deepEqual(
    normalize(graph.nonTrivialSccs),
    normalize(pinned),
    'src directory cycles do not match the committed baseline. A cycle may only shrink: ' +
      'when one is genuinely closed, lower CYCLE_GROUPS here and the committed JSON in the ' +
      'same commit. Never add a member or a group to accommodate a red reading.',
  );
}

/** `modules/cockpit/hooks` → `modules/cockpit`; `null` for anything outside `src/modules/`. */
function moduleOf(directory: string): string | null {
  if (!directory.startsWith('modules/')) return null;
  const [name] = directory.slice('modules/'.length).split('/');
  return name ? `modules/${name}` : null;
}

/**
 * Collapse the directory graph to the module graph: nodes are `modules/<name>`, an edge is any
 * import crossing two of them. Intra-module imports (`modules/cockpit/hooks` → `modules/cockpit`)
 * are the module's own business and drop out; paths under `src/shared`, `src/` root files etc.
 * are not feature modules and are outside this reading. The SCC pass is the SAME
 * `strongComponents` the directory reading uses, so the two granularities cannot diverge.
 */
function moduleGraph(graph: Graph): { nodes: string[]; adjacency: Map<string, string[]>; edges: number } {
  const nodes = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const pairs = new Set<string>();
  for (const edge of graph.dirEdges) {
    const from = moduleOf(edge.from);
    const to = moduleOf(edge.to);
    if (from === null || to === null || from === to) continue;
    nodes.add(from);
    nodes.add(to);
    pairs.add(`${from}\u0000${to}`);
    const targets = adjacency.get(from) ?? new Set<string>();
    targets.add(to);
    adjacency.set(from, targets);
  }
  return {
    nodes: [...nodes].sort(),
    adjacency: new Map([...adjacency].map(([from, targets]) => [from, [...targets].sort()])),
    edges: pairs.size,
  };
}

/** The non-trivial SCCs of the module graph, largest first — the same Tarjan pass, coarser nodes. */
function moduleSccs(graph: Graph): string[][] {
  const { nodes, adjacency } = moduleGraph(graph);
  return strongComponents(nodes, adjacency).filter((component) => component.length >= 2);
}

/** The module ratchet: the pin may only shrink, by lowering both this constant and the JSON. */
function assertModuleSccBudget(measured: readonly string[][], pinned: readonly string[][]): void {
  assert.deepEqual(
    normalize(measured),
    normalize(pinned),
    'the src MODULE cycle budget changed. A module SCC may only shrink: when one is genuinely ' +
      'closed, lower MODULE_SCC_GROUPS here and moduleSccGroups in the committed JSON in the ' +
      'same commit. Never add a module (or move a leaf contract back inside a feature module) ' +
      'to accommodate a red reading.',
  );
}

/** Scan a synthetic tree through the shared scanner, so controls exercise the production reading. */
function scanFixture(files: Record<string, string>): Graph {
  const sources: SourceFile[] = Object.entries(files).map(([filePath, text]) => ({ path: filePath, text }));
  return scanImportGraph(sources, { includeDynamic: false });
}

test('the current src tree carries exactly the pinned directory cycles', () => {
  const sources = collectTypeScriptSources(SRC_DIR);
  const graph = scanImportGraph(sources, { includeDynamic: false });

  assert.ok(graph.files >= MIN_FILES, `src scan read ${graph.files} files (< ${MIN_FILES}) — a collapsed walk is not a clean one`);
  assert.ok(
    graph.nodes.length >= MIN_DIRECTORIES,
    `src scan found ${graph.nodes.length} directories (< ${MIN_DIRECTORIES}) — a collapsed walk is not a clean one`,
  );
  assert.ok(
    graph.staticFileEdges >= MIN_STATIC_FILE_EDGES,
    `src scan resolved ${graph.staticFileEdges} static file edges (< ${MIN_STATIC_FILE_EDGES}) — the graph is not being read`,
  );
  assert.ok(
    !sources.some((source) => /\.(test|spec)\.(ts|tsx)$/.test(source.path)),
    'the ratchet reads the shipping tree; test/spec files must be dropped by the walk',
  );

  assertCycleBudget(graph, CYCLE_GROUPS);

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  assert.deepEqual(
    normalize(baseline.cycleGroups),
    normalize(CYCLE_GROUPS),
    'the committed JSON and the in-file pin must name the same groups, or a wider reading could be blessed by editing one of them',
  );
  assert.match(baseline.scope, /src\//, 'the baseline must declare that its scope is the frontend tree');
  assert.match(baseline.measuredAt, /^\d{4}-\d{2}-\d{2}$/, 'the baseline must date its reading');
});

test('positive control: a planted two-directory cycle reds the ratchet, including an @/-resolved edge', () => {
  const graph = scanFixture({
    'alpha/a.ts': "import '../beta/b.js';\n",
    'beta/b.ts': "import '@/alpha/a.js';\n",
  });

  assert.deepEqual(
    graph.nonTrivialSccs,
    [['alpha', 'beta']],
    'the shared scanner must see the planted cycle: one relative edge and one @/ edge (the src alias)',
  );
  assert.throws(
    () => assertCycleBudget(graph, CYCLE_GROUPS),
    /do not match the committed baseline/,
    'a cycle outside the pin must red the same assertion the real tree uses',
  );
});

test('negative control: a one-way import is a resolved edge, not a cycle', () => {
  const graph = scanFixture({
    'alpha/a.ts': "import '../beta/b.js';\n",
    'beta/b.ts': 'export const b = 1;\n',
  });

  assert.deepEqual(graph.nonTrivialSccs, [], 'a one-way import cannot close a cycle');
  assert.equal(graph.staticFileEdges, 1, 'the edge must resolve — an unresolved import would make the empty SCC list vacuous');
  assert.doesNotThrow(() => assertCycleBudget(graph, []), 'an acyclic reading matches the empty pin');
});

// ── The module-level reading (finding `src-module-scc-cockpit-hub`) ─────────────

test('the current src module graph carries exactly the pinned module cycles', () => {
  const sources = collectTypeScriptSources(SRC_DIR);
  const graph = scanImportGraph(sources, { includeDynamic: false });
  const { nodes, adjacency, edges } = moduleGraph(graph);

  assert.ok(nodes.length >= MIN_MODULES, `module reading saw ${nodes.length} modules (< ${MIN_MODULES}) — a collapsed scan is not a clean one`);
  assert.ok(
    edges >= MIN_CROSS_MODULE_EDGES,
    `module reading saw ${edges} cross-module import pairs (< ${MIN_CROSS_MODULE_EDGES}) — the module graph is not being read`,
  );
  assert.ok(nodes.includes('modules/cockpit-contract'), 'the cockpit leaf contract must be its own top-level module');

  // The leaf contract's whole point: it has no out-edge into a feature module, so importing it
  // from chat/sidebar/ui-scenario cannot pull anything into a cycle.
  assert.deepEqual(
    adjacency.get('modules/cockpit-contract') ?? [],
    [],
    'the cockpit leaf contract grew an out-edge to a feature module — it is no longer a leaf',
  );

  assertModuleSccBudget(moduleSccs(graph), MODULE_SCC_GROUPS);

  // Two-place pin: the committed JSON and the in-file constant must name the same SCC groups.
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  assert.deepEqual(
    normalize(baseline.moduleSccGroups ?? []),
    normalize(MODULE_SCC_GROUPS),
    'the committed JSON and the in-file module pin must name the same groups, or a wider reading could be blessed by editing one of them',
  );
});

test('positive control: a planted two-module cycle reds the module ratchet', () => {
  const graph = scanFixture({
    'modules/alpha/a.ts': "import '@/modules/beta/b.js';\n",
    'modules/beta/b.ts': "import '../alpha/a.js';\n",
  });

  assert.deepEqual(moduleSccs(graph), [['modules/alpha', 'modules/beta']], 'the module reading must see the planted @/-resolved cycle');
  assert.throws(
    () => assertModuleSccBudget(moduleSccs(graph), MODULE_SCC_GROUPS),
    /MODULE cycle budget changed/,
    'a module cycle outside the pin must red the same assertion the real tree uses',
  );
});

test('control: a shared leaf module imported by two modules closes no cycle', () => {
  const acyclic = scanFixture({
    'modules/alpha/a.ts': "import '@/modules/leaf/index.js';\n",
    'modules/beta/b.ts': "import '@/modules/leaf/index.js';\n",
    'modules/leaf/index.ts': 'export const x = 1;\n',
  });
  assert.deepEqual(moduleSccs(acyclic), [], 'a leaf imported by two modules is a fan-in, not a cycle');

  // The discriminating twin: the same two importers DO red when the "leaf" imports one back.
  const cyclic = scanFixture({
    'modules/alpha/a.ts': "import '@/modules/leaf/index.js';\n",
    'modules/leaf/index.ts': "export { a } from '@/modules/alpha/a.js';\n",
  });
  assert.deepEqual(
    moduleSccs(cyclic),
    [['modules/alpha', 'modules/leaf']],
    'a contract that imports a feature module must join its SCC — otherwise the leaf guard would be vacuous',
  );
});

// ── The FILE-level reading of `src/shared` (finding `file-cycle-shared-api-voiceconfig-barrel`) ──
//
// The two readings above collapse first (directories, then modules), so a cycle between two files
// of ONE package is invisible to both. This one keeps files as nodes; the pin is empty, so the only
// movement it allows is none — a new file-level cycle reds on the commit that adds it.

/** Scan a synthetic file tree through the shared FILE-level scanner, so controls drive the real reading. */
function scanFileFixture(files: Record<string, string>): FileGraph {
  const sources: SourceFile[] = Object.entries(files).map(([filePath, text]) => ({ path: filePath, text }));
  return scanFileImportGraph(sources);
}

/** The file-level pin: zero non-trivial SCCs. A shrink is impossible; any addition is a red. */
function assertNoFileSccs(measured: readonly string[][]): void {
  assert.deepEqual(
    measured,
    [],
    'src/shared gained a file-level SCC. A cycle between files of one package is invisible to the ' +
      'directory and module readings above: close it by extracting a leaf module (as ' +
      '`api/client.ts` did for the voiceConfig barrel), never by pinning it.',
  );
}

test('the current src/shared file graph carries no cycle', () => {
  const sources = collectTypeScriptSources(SRC_DIR).filter((source) => source.path.startsWith('shared/'));
  const graph = scanFileImportGraph(sources);

  assert.ok(
    graph.files >= MIN_SHARED_FILES,
    `src/shared file scan read ${graph.files} files (< ${MIN_SHARED_FILES}) — a collapsed walk is not a clean one`,
  );
  assert.ok(
    graph.fileEdges.length >= MIN_SHARED_FILE_EDGES,
    `src/shared file scan resolved ${graph.fileEdges.length} edges (< ${MIN_SHARED_FILE_EDGES}) — the graph is not being read`,
  );
  assert.ok(
    !sources.some((source) => /\.(test|spec)\.(ts|tsx)$/.test(source.path)),
    'the file-level reading reads the shipping tree; test/spec files must be dropped by the walk',
  );

  console.log(`(file) src/shared files=${graph.files} edges=${graph.fileEdges.length} sccs=${JSON.stringify(graph.nonTrivialSccs)}`);
  assertNoFileSccs(graph.nonTrivialSccs);
});

test('positive control: a planted two-file cycle reds the file-level pin', () => {
  const graph = scanFileFixture({
    'shared/alpha/a.ts': "import '@/shared/beta/b.js';\n",
    'shared/beta/b.ts': "import '../alpha/a.js';\n",
  });

  assert.deepEqual(
    graph.nonTrivialSccs,
    [['shared/alpha/a.ts', 'shared/beta/b.ts']],
    'the shared file-level scanner must see the planted cycle: one @/ edge and one relative edge',
  );
  assert.throws(
    () => assertNoFileSccs(graph.nonTrivialSccs),
    /gained a file-level SCC/,
    'a file-level cycle outside the pin must red the same assertion the real tree uses',
  );
});

test('negative control: a one-way file import is not a cycle', () => {
  const graph = scanFileFixture({
    'shared/alpha/a.ts': "export { b } from '@/shared/beta/b.js';\n",
    'shared/beta/b.ts': 'export const b = 1;\n',
  });

  assert.deepEqual(graph.nonTrivialSccs, [], 'a one-way re-export cannot close a file-level cycle');
  assert.equal(
    graph.fileEdges.length,
    1,
    'the edge must resolve — an unresolved import would make the empty SCC list vacuous',
  );
  assert.doesNotThrow(() => assertNoFileSccs(graph.nonTrivialSccs), 'an acyclic reading matches the empty pin');
});

// ── The ENTITY-level reading of `src/shared` (finding `cycle-voice-asr-factory-singleton`) ──────
//
// The three readings above stop at files and directories, so two entities IN ONE FILE cannot be a
// cycle to any of them. This one keeps exported entities as nodes and draws an edge when one
// entity's declaration references another. It asks the same question archguard's class-level
// `sccCount` asks — "can these two pieces of behaviour only be understood cyclically?" — at the
// granularity where the finding was measured. The pin is empty, like the file-level one.
//
// WHAT IS AN ENTITY. An exported function or class declaration, and an exported `const` bound to a
// function expression or arrow (a function in all but spelling). Exported singletons — `export
// const x = new Klass()` — are not nodes of their own: they are ALIASES to the class they
// instantiate, which is what makes a reference to `voiceClientAsrEngineInstance` an edge back to
// `VoiceClientAsrEngine` (and therefore the exact regression this criterion exists for). Interfaces
// and type aliases are excluded on purpose: this is a graph of behaviour, and a type-only reference
// cannot call anything.
//
// The edges are read from the TypeScript syntax tree, never from grepped text: declaration names,
// member-access names, property keys, parameters and import/export specifiers are not references.
// A name shared by two files resolves to both (conservative: it can only over-report a cycle,
// never hide one). Only `src/shared` is read, matching the finding's scope.

/** One exported entity: the node whose body contributes the out-edges. */
type EntityNode = { id: string; name: string; node: ts.Node };

type EntityGraph = {
  /** How many exported entities the walk found — the non-vacuity reading. */
  entityCount: number;
  /** How many distinct entity→entity references were resolved — the other non-vacuity reading. */
  edgeCount: number;
  nodes: string[];
  nonTrivialSccs: string[][];
};

/**
 * Non-vacuity floors for the ENTITY-level `src/shared` reading. The merged tree carries 230
 * entities and 117 entity→entity references (measured 2026-11-14, the same day as the finding).
 * The floors sit far below so only a collapsed walk trips them.
 */
const MIN_SHARED_ENTITIES = 150;
const MIN_SHARED_ENTITY_EDGES = 70;

/** `export` on the declaration itself; a declaration re-exported from elsewhere is not a node here. */
function isExportedDeclaration(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/** Collect one file's exported entities plus the `export const x = new C()` aliases to class `C`. */
function collectEntities(file: string, source: ts.SourceFile): { entities: EntityNode[]; singletons: Map<string, string> } {
  const entities: EntityNode[] = [];
  const singletons = new Map<string, string>();
  const add = (name: string, node: ts.Node): void => {
    entities.push({ id: `${file}#${name}`, name, node });
  };

  ts.forEachChild(source, (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name !== undefined && isExportedDeclaration(node)) add(node.name.text, node);
      return;
    }
    if (!ts.isVariableStatement(node) || !isExportedDeclaration(node)) return;

    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const initializer = declaration.initializer;
      if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
        singletons.set(declaration.name.text, initializer.expression.text);
      } else if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        add(declaration.name.text, declaration);
      }
    }
  });

  return { entities, singletons };
}

/**
 * The names one entity's declaration references, ignoring the positions where the same text is a
 * declaration or a member name rather than a use of some other entity.
 */
function referencedNames(node: ts.Node, candidates: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();

  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && candidates.has(current.text)) {
      const parent = current.parent;
      const declaresName =
        ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent)
          || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isMethodDeclaration(parent)
          || ts.isPropertyDeclaration(parent))
          && (parent as { name?: ts.Node }).name === current);
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === current;
      const isPropertyKey = ts.isPropertyAssignment(parent) && parent.name === current;
      const isSpecifier =
        ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
        || ts.isExportSpecifier(parent) || ts.isQualifiedName(parent);
      if (!declaresName && !isMemberName && !isPropertyKey && !isSpecifier) found.add(current.text);
    }
    ts.forEachChild(current, visit);
  };

  ts.forEachChild(node, visit);
  return found;
}

/**
 * The entity-level reference graph. Pure over its sources, so the real tree and a synthetic fixture
 * drive the same code — the property the three readings above also rely on.
 */
function scanEntityReferenceGraph(sources: readonly SourceFile[]): EntityGraph {
  const entities: EntityNode[] = [];
  const singletons = new Map<string, string>();

  for (const source of sources) {
    const parsed = ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
      scriptKindFor(source.path),
    );
    const collected = collectEntities(source.path, parsed);
    entities.push(...collected.entities);
    for (const [name, target] of collected.singletons) singletons.set(name, target);
  }

  const byName = new Map<string, EntityNode[]>();
  for (const entity of entities) {
    const group = byName.get(entity.name) ?? [];
    group.push(entity);
    byName.set(entity.name, group);
  }

  /** A reference resolves directly to an entity, or through a singleton alias to its class. */
  const resolve = (name: string): EntityNode[] => {
    const direct = byName.get(name);
    if (direct !== undefined) return direct;
    const aliased = singletons.get(name);
    return aliased === undefined ? [] : (byName.get(aliased) ?? []);
  };

  const candidateNames = new Set<string>([...byName.keys(), ...singletons.keys()]);
  const adjacency = new Map<string, string[]>(entities.map((entity) => [entity.id, []]));
  const seen = new Set<string>();
  let edgeCount = 0;

  for (const entity of entities) {
    for (const name of referencedNames(entity.node, candidateNames)) {
      for (const target of resolve(name)) {
        if (target.id === entity.id) continue;
        const key = `${entity.id}\u0000${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        adjacency.get(entity.id)?.push(target.id);
        edgeCount += 1;
      }
    }
  }

  const nodes = entities.map((entity) => entity.id).sort();
  const sorted = new Map([...adjacency].map(([from, targets]) => [from, [...targets].sort()]));
  const sccs = strongComponents(nodes, sorted);
  return {
    entityCount: entities.length,
    edgeCount,
    nodes,
    nonTrivialSccs: sccs.filter((component) => component.length >= 2),
  };
}

/** Scan a synthetic file tree through the same entity reader, so controls drive the real reading. */
function scanEntityFixture(files: Record<string, string>): EntityGraph {
  const sources: SourceFile[] = Object.entries(files).map(([filePath, text]) => ({ path: filePath, text }));
  return scanEntityReferenceGraph(sources);
}

/** The entity-level pin: zero non-trivial SCCs. Any addition reds; a shrink is impossible. */
function assertNoEntitySccs(measured: readonly string[][]): void {
  assert.deepEqual(
    measured,
    [],
    'src/shared gained an ENTITY-level SCC. Two exported entities that reference each other can be ' +
      'understood only cyclically, and the file-/directory-/module-level readings above cannot see ' +
      'it when both live in one file. Invert one edge (an owner passes the callback in; the callee ' +
      'does not reach back for the owner), never pin the cycle.',
  );
}

test('the current src/shared entity graph carries no cycle', () => {
  const sources = collectTypeScriptSources(SRC_DIR).filter((source) => source.path.startsWith('shared/'));
  const graph = scanEntityReferenceGraph(sources);

  assert.ok(
    graph.entityCount >= MIN_SHARED_ENTITIES,
    `src/shared entity scan read ${graph.entityCount} entities (< ${MIN_SHARED_ENTITIES}) — a collapsed walk is not a clean one`,
  );
  assert.ok(
    graph.edgeCount >= MIN_SHARED_ENTITY_EDGES,
    `src/shared entity scan resolved ${graph.edgeCount} references (< ${MIN_SHARED_ENTITY_EDGES}) — the graph is not being read`,
  );
  // The reading must actually contain the pair the finding named, or "zero cycles" would be a
  // statement about an unrelated graph.
  assert.ok(
    graph.nodes.includes('shared/voice-asr/voiceClientAsrWorker.ts#createVoiceClientAsrEngine'),
    'the entity reading no longer sees the standalone client ASR factory',
  );
  assert.ok(
    graph.nodes.includes('shared/voice-asr/voiceClientAsrWorker.ts#VoiceClientAsrEngine'),
    'the entity reading no longer sees the per-tab client ASR lifecycle class',
  );

  console.log(`(entity) src/shared entities=${graph.entityCount} edges=${graph.edgeCount} sccs=${JSON.stringify(graph.nonTrivialSccs)}`);
  assertNoEntitySccs(graph.nonTrivialSccs);
});

test('positive control: the factory→singleton→class shape reds the entity-level pin', () => {
  // The exact pre-fix shape, one file: the factory's handler reaches the singleton, the class's
  // `install()` calls the factory, and the singleton is a `new` of that class.
  const cyclic = scanEntityFixture({
    'shared/x/engine.ts': [
      'export function createEngine() { return engineInstance.noteProgress(); }',
      'export class Engine { install() { return createEngine(); } }',
      'export const engineInstance = new Engine();',
    ].join('\n'),
  });

  assert.equal(cyclic.edgeCount, 2, 'both references must resolve — otherwise the red reading is vacuous');
  assert.deepEqual(
    normalize(cyclic.nonTrivialSccs),
    normalize([['shared/x/engine.ts#Engine', 'shared/x/engine.ts#createEngine']]),
    'the entity scanner must see the planted factory/class cycle through the singleton alias',
  );
  assert.throws(
    () => assertNoEntitySccs(cyclic.nonTrivialSccs),
    /gained an ENTITY-level SCC/,
    'a same-file entity cycle must red the same assertion the real tree uses',
  );

  // THE DISCRIMINATING TWIN: the same three declarations with the factory's reach DELETED (the fix
  // this criterion guards) are acyclic. One line is the whole difference.
  const fixed = scanEntityFixture({
    'shared/x/engine.ts': [
      'export function createEngine() { return null; }',
      'export class Engine { install() { return createEngine(); } }',
      'export const engineInstance = new Engine();',
    ].join('\n'),
  });
  assert.deepEqual(fixed.nonTrivialSccs, [], 'the one-way class → factory edge is a dependency, not a cycle');
  assert.equal(fixed.edgeCount, 1, 'the surviving edge must still resolve, or the green reading is vacuous');
  assert.doesNotThrow(() => assertNoEntitySccs(fixed.nonTrivialSccs), 'an acyclic reading matches the empty pin');
});

test('negative control: a one-way entity reference is not a cycle', () => {
  const graph = scanEntityFixture({
    'shared/y/a.ts': 'export function helper() { return 1; }\nexport function user() { return helper(); }\n',
  });

  assert.deepEqual(graph.nonTrivialSccs, [], 'a one-way call cannot close an entity-level cycle');
  assert.equal(graph.edgeCount, 1, 'the edge must resolve — an unresolved reference would make the empty SCC list vacuous');
  assert.doesNotThrow(() => assertNoEntitySccs(graph.nonTrivialSccs), 'an acyclic reading matches the empty pin');
});
