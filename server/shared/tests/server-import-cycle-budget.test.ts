/**
 * AC-394 — the directory-level import-cycle BUDGET ratchet for `server/`.
 *
 * GOAL-045's ledger refactor keeps adding and moving directories under
 * `server/modules/**`, and the eight-member cycle this file pins is the static shadow of
 * exactly the coupling that refactor is trying to break (the ledger inlined in the driver,
 * `RESIDENT_RUN_IS_TURN` read from two places). What this criterion does is serialise that
 * structure into one reading that reds on the FIRST commit that widens it, instead of
 * waiting for a behavioural criterion to red in some other shape. It is a ratchet — the
 * pinned cycles may only ever SHRINK, brand-new directories must stay leaves, and
 * `server/shared` must never grow an edge back into `server/modules/**`. A group that
 * genuinely disappears is lowered explicitly in this file and in the baseline JSON; it is
 * never re-pinned to accommodate a reading.
 *
 * G2 WAS RETIRED on 2026-10-20 by `gap-database-connection-directory-cycle`: the
 * `modules/database` ↔ `modules/database/repositories` two-member cycle was closed by
 * moving the connection module into the leaf directory `modules/database/core/`. G2 is now
 * the empty group in both this file and the committed baseline. G1 was untouched by that task.
 *
 * G3 WAS RETIRED on 2026-10-20 by `gap-server-root-browser-use-cycle-relocate-mcp-entry`: the
 * `.` ↔ `modules/browser-use` cycle was closed by moving the MCP stdio entrypoint out of the
 * feature module into the existing `modules/cli/` directory, which already imports the root
 * bootstrap and is never imported by the root. G3 is the empty group in both this file and the
 * committed baseline; the slot stays so the groups remain a fixed, disjoint three-slot pin.
 *
 * Every reading comes from the TypeScript SYNTAX TREE (`ts.createSourceFile`), never from
 * grepped text: a comment mentioning `@/modules/...` (there is exactly one, at
 * `server/shared/interfaces.ts:95`) produces no node at all, so the "shared has zero
 * module imports" reading is a reading of code, not of prose.
 *
 * Scope (AC (a)): every non-test `.ts`/`.tsx` under `server/` — `*.test.*`/`*.spec.*`
 * dropped by filename and every `tests/` directory pruned. Static `import` /
 * `export … from` (including `import type`), plus LITERAL-specifier dynamic `import()`.
 * A specifier is internal when it is `@/*` (→ `server/*`, per `server/tsconfig.json`) or
 * relative; it RESOLVES when the target is one of those scanned files. A node is the
 * directory that holds the file; an edge is a cross-directory import. Non-trivial SCCs come
 * from Tarjan.
 *
 * Readings measured on this tree (2026-10-20, TypeScript compiler API, after
 * `gap-server-provider-websocket-init-cycle-ports` on top of
 * `gap-database-connection-directory-cycle`):
 *
 *   files=332 staticEdges=1301 dynamicEdges=4 sccs=[8]   (file-level resolved edges; the
 *                                two-member `.` ↔ `modules/browser-use` SCC is GONE — the G3
 *                                slot is now empty, see the `CYCLE_GROUPS` note. `dynamicEdges`
 *                                fell 5 → 4 because the relocation turned the one dynamic
 *                                `modules/cli -> modules/browser-use` import into a same-directory
 *                                one)
 *   unresolved internal = 19   (16 to the repo-root `shared/`, 3 to in-server `.js` files
 *                               living in out-of-cycle directories)
 *   non-literal dynamic specifiers = 2, in the two named files (both optional-dependency seams)
 *   node count = 51            (the committed `directoryManifest`, incl. `shared/ports`,
 *                               `shared/mcp-contract`, `modules/database/core` and
 *                               `modules/architecture`)
 *
 * ONE READING DIVERGES FROM THE立案 NOTE, and the divergence is itself pinned (see the `(b)`
 * case). The note expects the static-only and the static+literal-dynamic readings to agree
 * member-for-member. On this tree they do NOT: the eight-member cycle is closed by one
 * LITERAL dynamic import (`voice-lexicon.ts:298` → `modules/providers`), so static-only
 * yields a seven-member component. What is asserted instead is the invariant that does hold —
 * both readings clear the pinned groups, and the static-only component is a strict sub-part of
 * the dynamic one — plus an explicit `(b) DEVIATION:` line naming the difference, so nobody
 * can later mistake it for a scanner artefact. (The eleven-member component that originally
 * closed through `claude-host-driver.provider.ts`'s dynamic import of `modules/voice-realtime`
 * was lowered here; see the `(b)` case's note.)
 *
 * The baseline JSON is a committed artifact and a ratchet: the groups may only shrink, the
 * budgets may only fall. It is never edited to accommodate a red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The scanning core lives in `server/shared/import-graph.ts` now (AC-396 (b)
// forbids a second copy of it): this criterion BUDGETS the tree, AC-396 asserts a
// leaf in it, and both read the tree through the SAME scanner rather than through
// two that can drift apart. Nothing about the readings below changed — the code
// moved, verbatim, and the criterion still drives it over the real tree.
import {
  collectServerSources,
  isSharedDir,
  scanImportGraph,
  type DirEdge,
  type Graph,
  type SourceFile,
} from '@/shared/import-graph.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const BASELINE_PATH = path.join(TEST_DIR, 'server-import-cycle-budget.baseline.json');

/**
 * The ratchet pin. The baseline cycles, spelled out member by member so a widened cycle
 * cannot be blessed by editing the JSON alone (AC (b): "只许缩小，不许新增成员，不许合并两组").
 * Lowering one of these is an explicit edit to this constant. G2 keeps its slot but is now
 * EMPTY: `gap-database-connection-directory-cycle` retired the two-member database cycle,
 * and an empty group is filtered out of the canonical-group comparison.
 *
 * G3 IS NOW EMPTY TOO, lowered by `gap-server-root-browser-use-cycle-relocate-mcp-entry`
 * (2026-10-20): the `.` ↔ `modules/browser-use` cycle was closed by moving the MCP stdio
 * entrypoint into `modules/cli/`. The slot is kept (not deleted) for the same reason as G2 —
 * the three groups stay disjoint and a future re-formation of this exact cycle has to be
 * re-pinned explicitly rather than sliding into an unused slot.
 */
const CYCLE_GROUPS: readonly string[][] = [
  [
    'modules/projects',
    'modules/projects/services',
    'modules/providers',
    'modules/providers/list/claude',
    'modules/providers/services',
    'modules/voice',
    'modules/websocket',
    'modules/websocket/services',
  ],
  [],
  [],
];

/**
 * The directory-manifest pin, for the same reason as `CYCLE_GROUPS`: the committed
 * `directoryManifest` is what separates "an old directory" from "a brand-new one", so a
 * non-leaf new directory must not be able to walk through the leaf rule by being added to
 * the JSON (AC (c): "新增即红"). The JSON may only ever name directories from this set;
 * removing entries is the sanctioned direction.
 *
 * ONE ENTRY WAS ADDED, by AC-396, under AC (c)'s own escape hatch ("新增即红，除非该新目录
 * 满足叶子规则"): `modules/resident-ledger` is the leaf AC-396 created — it imports only
 * `server/shared/**` and itself, and is in no SCC — and AC-396 (c) REQUIRES the driver to
 * import it through its barrel. Without the entry the leaf rule would red on that mandated
 * inbound edge; with it, the directory is a known one and the leaf rule no longer applies to
 * it, while G1/G2/G3 and every other reading stay exactly as pinned. The set the JSON names
 * is still what this pin checks — it is not a licence to add non-leaf directories.
 *
 * A SECOND ENTRY WAS ADDED, by `gap-database-connection-directory-cycle` (2026-10-20), under
 * the same escape hatch: `modules/database/core` is the leaf that task created (it imports
 * only node builtins and `better-sqlite3`, nothing from `server/`, and sits in no SCC). Its
 * inbound edges from `modules/database` and `modules/database/repositories` are the mandated
 * shape of the fix — the cycle disappears precisely because the repositories now import a
 * sibling leaf instead of their parent package — so the directory is registered as known
 * rather than left to red the leaf rule's inbound arm.
 * A THIRD ENTRY WAS ADDED, by `gap-mcp-contract-extract` (2026-10-20), under the
 * same escape hatch: `shared/mcp-contract` is the contract leaf that proposal's
 * stage 1 created (it imports only external packages, `server/shared/**` and
 * itself, and sits in no SCC). Its inbound edges from `modules/mcp-gateway` and
 * `modules/oauth` are the intended shape of the extraction, so the directory is
 * registered as known rather than left to red the leaf rule's inbound arm.
 * A FOURTH ENTRY WAS ADDED, by `architecture-graph-endpoint` (2026-10-21), under
 * the same escape hatch: `modules/architecture` holds AC-415/416/417's pure
 * helpers plus AC-418's route/service/module wiring. The directory imports only
 * `server/shared/**` and itself — `server/index.ts` injects the project and
 * transcript readers, so the module reaches no sibling — and it sits in no SCC.
 * Its mandated inbound edges (`modules/projects/services`' Tier-1 listing field
 * and `modules/mcp-gateway`'s overview reading) are the leaf rule's sanctioned
 * shape; without the entry they would red the inbound arm.
 */
const MANIFEST_PIN: readonly string[] = [
  '.',
  'modules/architecture',
  'modules/assets',
  'modules/assets/services',
  'modules/auth',
  'modules/browser-use',
  'modules/cli',
  'modules/commands',
  'modules/database',
  'modules/database/core',
  'modules/database/repositories',
  'modules/debug-agent',
  'modules/file-tree',
  'modules/git',
  'modules/logging',
  'modules/mcp-gateway',
  'modules/notifications',
  'modules/notifications/services',
  'modules/notifications/websocket',
  'modules/oauth',
  'modules/plugins',
  'modules/projects',
  'modules/projects/services',
  'modules/providers',
  'modules/providers/list/claude',
  'modules/providers/list/codex',
  'modules/providers/list/cursor',
  'modules/providers/list/opencode',
  'modules/providers/services',
  'modules/providers/shared/base',
  'modules/providers/shared/mcp',
  'modules/providers/shared/skills',
  'modules/quay',
  'modules/resident-ledger',
  'modules/scheduled-messages',
  'modules/scheduled-messages/services',
  'modules/session-hosts',
  'modules/settings',
  'modules/static-assets',
  'modules/system',
  'modules/taskmaster',
  'modules/user',
  'modules/voice',
  'modules/voice-realtime',
  'modules/websocket',
  'modules/websocket/services',
  'modules/worktrees',
  'modules/worktrees/services',
  'shared',
  'shared/mcp-contract',
  'shared/ports',
];

/**
 * (f)'s floor. A scanner that resolved nothing would satisfy every "no violation" assertion
 * vacuously, so the resolved FILE-level edge count is asserted above this floor on the real
 * tree. The measured value is an order of magnitude larger; the floor only has to be
 * impossible to reach by a dead walk.
 */
const MIN_RESOLVED_FILE_EDGES = 1000;

/** (h)'s per-run ceiling, with a second of headroom so the guard fires first. */
const PROCESS_BUDGET_MS = 29_000;

// ---------------------------------------------------------------------------
// The reading helpers — shared by the real-tree tests and the synthetic fixtures
// ---------------------------------------------------------------------------

/** `server/<dir>` for display, so a printed reading matches the AC text verbatim. */
function repoRelative(fileOrDir: string): string {
  return fileOrDir === '.' ? 'server' : `server/${fileOrDir}`;
}

/**
 * AC (b): every size ≥ 2 component must be CONTAINED IN one baseline group — no new member,
 * no two groups merged. Returns the violations; empty means green.
 */
function cycleViolations(components: readonly string[][], groups: readonly string[][], label: string): string[] {
  const violations: string[] = [];
  for (const component of components) {
    if (component.length < 2) continue;
    const containing = groups.filter((group) => {
      const members = new Set(group);
      return component.every((member) => members.has(member));
    });
    if (containing.length === 0) {
      violations.push(
        `${label}: SCC [${component.map(repoRelative).join(', ')}] is not contained in any baseline cycle group — ` +
          `a new member joined a cycle, or two groups merged. Do NOT raise the baseline: find the import that closed the loop.`,
      );
    } else if (containing.length > 1) {
      violations.push(`${label}: SCC [${component.map(repoRelative).join(', ')}] matches more than one baseline group — the groups must stay disjoint`);
    }
  }
  return violations;
}

/**
 * Every size ≥ 2 component of `inner` must fit inside some size ≥ 2 component of `outer`.
 * This is the invariant that actually holds between the static-only and the
 * static+literal-dynamic readings — see the `(b)` case below for why the two are NOT equal
 * member-for-member on this tree.
 */
function componentsContainedIn(inner: readonly string[][], outer: readonly string[][]): string[] {
  const violations: string[] = [];
  for (const component of inner) {
    if (component.length < 2) continue;
    const fits = outer.some((candidate) => {
      const members = new Set(candidate);
      return component.every((member) => members.has(member));
    });
    if (!fits) violations.push(`[${component.map(repoRelative).join(', ')}] is not contained in any component of the wider reading`);
  }
  return violations;
}

/**
 * AC (c): a directory absent from the committed manifest is a NEW directory, and a new
 * directory must be a leaf — its out-edges may target only `server/shared/**` or itself, and
 * no other `server/modules/**` directory may import it. Returns the violations.
 */
function newDirectoryViolations(graph: Graph, manifest: readonly string[]): string[] {
  const known = new Set(manifest);
  const violations: string[] = [];
  for (const directory of graph.nodes) {
    if (known.has(directory)) continue;
    for (const edge of graph.dirEdges) {
      if (edge.from === directory && edge.to !== directory && !isSharedDir(edge.to)) {
        violations.push(
          `new directory ${repoRelative(directory)} imports ${repoRelative(edge.to)} — a directory absent from the baseline manifest must be a leaf ` +
            `(its only allowed targets are server/shared/** and itself)`,
        );
      }
      if (edge.to === directory && edge.from !== directory && edge.from.startsWith('modules/')) {
        violations.push(
          `${repoRelative(edge.from)} imports the new directory ${repoRelative(directory)} — a new directory must have zero inbound edges from other ` +
            `server/modules/** directories`,
        );
      }
    }
  }
  return [...new Set(violations)];
}

/**
 * AC (d): `server/shared` (not the repo-root `shared/`) may not import `server/modules/**`,
 * statically OR dynamically. Returns the offending edges.
 */
function sharedToModulesEdges(graph: Graph): DirEdge[] {
  return graph.dirEdges.filter((edge) => isSharedDir(edge.from) && edge.to.startsWith('modules/'));
}

// ---------------------------------------------------------------------------
// Reading the tree and the committed baseline
// ---------------------------------------------------------------------------

const sourcesOnce = (() => {
  let cached: SourceFile[] | undefined;
  return (): SourceFile[] => (cached ??= collectServerSources(SERVER_DIR));
})();

const graphCache = new Map<string, Graph>();
/** The real tree, scanned once per reading — the scan itself is not repeated per assertion. */
function realGraph(includeDynamic = true): Graph {
  const key = String(includeDynamic);
  const cached = graphCache.get(key);
  if (cached) return cached;
  const graph = scanImportGraph(sourcesOnce(), { includeDynamic });
  graphCache.set(key, graph);
  return graph;
}

/**
 * AC (a): the scanner prints its summary line BEFORE any assertion, so the reading is on the
 * record even when a later assertion reds. Returns the line so a test can assert its shape.
 */
function printSummary(graph: Graph): string {
  const line = `files=${graph.files} staticEdges=${graph.staticFileEdges} dynamicEdges=${graph.dynamicFileEdges} sccs=[${graph.nonTrivialSccs.map((component) => component.length).join(',')}]`;
  console.log(line);
  console.log(`[ac394] nodes=${graph.nodes.length} unresolvedInternal=${graph.unresolvedInternal.length} nonLiteralDynamic=${graph.nonLiteralDynamic.length}`);
  return line;
}

type CycleGroups = { G1: string[]; G2: string[]; G3: string[] };
type Baseline = {
  measuredAt: string;
  fileEdges: { static: number; dynamic: number };
  nodeCount: number;
  directoryManifest: string[];
  cycleGroups: CycleGroups;
  unresolvedInternalBudget: number;
  nonLiteralDynamic: { allowedFiles: Array<{ file: string; maxPerFile: number }> };
};

/** Reads and validates the committed baseline — no `any`, every field checked. */
function readBaseline(): Baseline {
  const raw: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.ok(typeof raw === 'object' && raw !== null, 'the baseline must be a JSON object');
  const record = raw as Record<string, unknown>;

  const measuredAt = record.measuredAt;
  assert.ok(typeof measuredAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(measuredAt), 'baseline.measuredAt must carry a date (YYYY-MM-DD)');

  const stringArray = (key: string): string[] => {
    const value = record[key];
    assert.ok(Array.isArray(value) && value.every((entry) => typeof entry === 'string'), `baseline.${key} must be an array of strings`);
    return value as string[];
  };

  const fileEdges = record.fileEdges;
  assert.ok(typeof fileEdges === 'object' && fileEdges !== null, 'baseline.fileEdges must be an object');
  const edgeRecord = fileEdges as Record<string, unknown>;
  const edgeCount = (key: string): number => {
    const value = edgeRecord[key];
    assert.ok(typeof value === 'number' && Number.isInteger(value) && value >= 0, `baseline.fileEdges.${key} must be a non-negative integer`);
    return value;
  };

  const nodeCount = record.nodeCount;
  assert.ok(typeof nodeCount === 'number' && Number.isInteger(nodeCount) && nodeCount > 0, 'baseline.nodeCount must be a positive integer');

  const groups = record.cycleGroups;
  assert.ok(typeof groups === 'object' && groups !== null, 'baseline.cycleGroups must be an object');
  const groupRecord = groups as Record<string, unknown>;
  const group = (key: keyof CycleGroups): string[] => {
    const value = groupRecord[key];
    assert.ok(Array.isArray(value) && value.every((entry) => typeof entry === 'string'), `baseline.cycleGroups.${key} must be an array of strings`);
    return value as string[];
  };

  const budget = record.unresolvedInternalBudget;
  assert.ok(typeof budget === 'number' && Number.isInteger(budget) && budget >= 0, 'baseline.unresolvedInternalBudget must be a non-negative integer');

  const nonLiteral = record.nonLiteralDynamic;
  assert.ok(typeof nonLiteral === 'object' && nonLiteral !== null, 'baseline.nonLiteralDynamic must be an object');
  const nonLiteralRecord = nonLiteral as Record<string, unknown>;
  const allowedRaw = nonLiteralRecord.allowedFiles;
  assert.ok(Array.isArray(allowedRaw) && allowedRaw.length > 0, 'baseline.nonLiteralDynamic.allowedFiles must be a non-empty array');
  const allowedFiles = allowedRaw.map((entry, index): { file: string; maxPerFile: number } => {
    assert.ok(typeof entry === 'object' && entry !== null, `baseline.nonLiteralDynamic.allowedFiles[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    const file = row.file;
    const maxPerFile = row.maxPerFile;
    assert.ok(typeof file === 'string' && file.length > 0, `baseline.nonLiteralDynamic.allowedFiles[${index}].file must be a non-empty string`);
    assert.ok(
      typeof maxPerFile === 'number' && Number.isInteger(maxPerFile) && maxPerFile >= 0,
      `baseline.nonLiteralDynamic.allowedFiles[${index}].maxPerFile must be a non-negative integer`,
    );
    return { file, maxPerFile };
  });

  return {
    measuredAt,
    fileEdges: { static: edgeCount('static'), dynamic: edgeCount('dynamic') },
    nodeCount,
    directoryManifest: stringArray('directoryManifest'),
    cycleGroups: { G1: group('G1'), G2: group('G2'), G3: group('G3') },
    unresolvedInternalBudget: budget,
    nonLiteralDynamic: { allowedFiles },
  };
}

/** Canonical form of a set-of-groups reading, so two readings can be compared exactly. */
function canonicalGroups(components: readonly string[][]): string[][] {
  return components.map((component) => [...component].sort()).filter((component) => component.length >= 2).sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// Process budget guard — a hang is a budget kill, not one red case
// ---------------------------------------------------------------------------

const STARTED_AT = Date.now();
const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${PROCESS_BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the server-import-cycle-budget criterion ` +
      `did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, PROCESS_BUDGET_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// (a) the reading, and (h) its cost
// ---------------------------------------------------------------------------

test('(a)(h) the scanner walks the real server tree, prints its summary line, and finishes inside the budget', () => {
  const scanStartedAt = Date.now();
  const graph = scanImportGraph(sourcesOnce(), { includeDynamic: true });
  const scanMs = Date.now() - scanStartedAt;
  const line = printSummary(graph);
  const elapsedMs = Date.now() - STARTED_AT;
  console.log(`[ac394] duration_ms=${scanMs} elapsed_ms=${elapsedMs}`);

  assert.match(line, /^files=\d+ staticEdges=\d+ dynamicEdges=\d+ sccs=\[\d+(,\d+)*\]$/, 'the summary line must keep its shape');
  assert.ok(graph.files > 0, 'the walk must have read files');
  assert.ok(scanMs < 30_000, `(h) the scan took ${scanMs}ms, over the 30s ceiling`);
  assert.ok(elapsedMs < 30_000, `(h) the run reached this assertion at ${elapsedMs}ms, over the 30s ceiling`);
});

// ---------------------------------------------------------------------------
// (b) three baseline groups, both readings agree
// ---------------------------------------------------------------------------

test('(b) every non-trivial SCC is contained in one baseline group — static-only and static+dynamic agree on the groups', () => {
  const sources = sourcesOnce();
  const staticOnly = scanImportGraph(sources, { includeDynamic: false });
  const withDynamic = scanImportGraph(sources, { includeDynamic: true });

  console.log(`(b) static-only:    ${printSummary(staticOnly)}`);
  console.log(`(b) static+dynamic: ${printSummary(withDynamic)}`);
  for (const [label, graph] of [['static-only', staticOnly], ['static+dynamic', withDynamic]] as const) {
    for (const component of graph.nonTrivialSccs) console.log(`(b) ${label} SCC[${component.length}] ${component.map(repoRelative).join(', ')}`);
  }

  // MEASURED DEVIATION from the立案 note, on the record in the criterion's own output.
  //
  // The two readings are NOT member-for-member identical on this tree, and this is a real,
  // load-bearing structural fact rather than a scanner artefact: the eight-member cycle is
  // reached only because ONE literal dynamic `import()` closes it —
  //   · modules/voice -> modules/providers
  //     (`voice-lexicon.ts:298`, `@/modules/providers/index.js`)
  // Statically, `modules/voice` reaches the cycle through no static import at all, so the
  // static-only reading yields a SEVEN-member component. "The same result" therefore holds
  // at the level of the baseline GROUPS (both readings place every cycle inside one pinned
  // group, and no group gains a member), and the static-only reading is a strict sub-part of
  // the dynamic one — not as an equality of member lists. The dynamic-only edges are printed
  // below so the difference can never be dismissed as scanner noise.
  //
  // The eleven-member component this file originally pinned was lowered by
  // `gap-server-provider-websocket-init-cycle-ports` (2026-10-20): the
  // `session-hosts -> mcp-gateway`, `providers/list/claude -> websocket`,
  // `providers/list/claude -> voice-realtime` and `providers -> provider.registry` edges
  // became shared ports, which removed `modules/mcp-gateway`, `modules/session-hosts` and
  // `modules/voice-realtime` from the component. The ratchet may only shrink; this edit
  // records the new, strictly smaller reading.
  const staticPairs = new Set(staticOnly.dirEdges.map((edge) => `${edge.from} -> ${edge.to}`));
  const dynamicOnlyEdges = withDynamic.dirEdges.filter((edge) => !staticPairs.has(`${edge.from} -> ${edge.to}`));
  for (const edge of dynamicOnlyEdges) console.log(`(b) dynamic-only edge ${repoRelative(edge.from)} -> ${repoRelative(edge.to)}`);
  console.log(`(b) DEVIATION: static-only SCCs=${JSON.stringify(staticOnly.nonTrivialSccs.map((component) => component.length))} vs static+dynamic=${JSON.stringify(withDynamic.nonTrivialSccs.map((component) => component.length))} — the member lists differ by exactly modules/voice, which the literal dynamic import above carries into G1`);

  const baseline = readBaseline();
  const baselineGroups = [baseline.cycleGroups.G1, baseline.cycleGroups.G2, baseline.cycleGroups.G3];

  // The JSON may only shrink against the pin; it can never be raised.
  baselineGroups.forEach((group, index) => {
    const pin = new Set(CYCLE_GROUPS[index]);
    const extra = group.filter((member) => !pin.has(member));
    assert.deepEqual(extra, [], `baseline.cycleGroups.${'G' + (index + 1)} holds members outside the pin — the baseline may only be lowered, never raised`);
  });

  // (b) the ratchet: the primary reading matches the pin and the committed JSON member-for-member.
  assert.deepEqual(canonicalGroups(withDynamic.nonTrivialSccs), canonicalGroups(CYCLE_GROUPS), 'the measured cycles must match the pinned baseline groups member-for-member');
  assert.deepEqual(canonicalGroups(withDynamic.nonTrivialSccs), canonicalGroups(baselineGroups), 'the measured cycles must match the committed baseline JSON member-for-member');

  // Both readings must clear the baseline; neither may introduce a member or merge two groups.
  const dynamicViolations = cycleViolations(withDynamic.nonTrivialSccs, CYCLE_GROUPS, 'static+dynamic');
  const staticViolations = cycleViolations(staticOnly.nonTrivialSccs, CYCLE_GROUPS, 'static-only');
  assert.deepEqual(dynamicViolations, [], dynamicViolations.join('\n'));
  assert.deepEqual(staticViolations, [], staticViolations.join('\n'));

  // And the static-only reading may never grow OUTSIDE the dynamic-inclusive one: a static edge
  // the dynamic reading cannot see would mean the two口径 disagree about which directories are
  // even in play.
  const subsetViolations = componentsContainedIn(staticOnly.nonTrivialSccs, withDynamic.nonTrivialSccs);
  assert.deepEqual(subsetViolations, [], subsetViolations.join('\n'));
});

// ---------------------------------------------------------------------------
// (c) the committed directory manifest, and the new-directory leaf rule
// ---------------------------------------------------------------------------

test('(c) the directory manifest is committed, cannot be raised, and any directory outside it is a leaf', () => {
  const graph = realGraph(true);
  const baseline = readBaseline();
  console.log(`(c) manifest=${baseline.directoryManifest.length} dirs, measured nodes=${graph.nodes.length}, measuredAt=${baseline.measuredAt}`);
  assert.equal(baseline.nodeCount, baseline.directoryManifest.length, 'baseline.nodeCount must agree with the manifest it describes');

  // The JSON may only shrink against the pin; it can never be raised.
  const pin = new Set(MANIFEST_PIN);
  const padded = baseline.directoryManifest.filter((directory) => !pin.has(directory));
  assert.deepEqual(padded, [], 'the manifest names directories outside the pin — the manifest may only be lowered, never raised, so a new directory cannot be blessed by editing the JSON');

  const manifest = new Set(baseline.directoryManifest);
  const newDirectories = graph.nodes.filter((directory) => !manifest.has(directory));
  console.log(`(c) directories present but absent from the manifest: ${JSON.stringify(newDirectories)}`);

  const violations = newDirectoryViolations(graph, baseline.directoryManifest);
  assert.deepEqual(violations, [], violations.join('\n'));

  // Today the manifest is exactly the tree, so this reading is the "no new directory at all"
  // one; the leaf rule above is what decides whether a future new directory is acceptable.
  console.log(`(c) new directories all evaluated as leaves: ${newDirectories.length === 0 || violations.length === 0}`);
});

test('(c-fixture) the leaf rule reds a new directory that imports a modules peer, in a synthetic tree', () => {
  const sources: SourceFile[] = [
    { path: 'modules/A/index.ts', text: "import '../B/index.js';\n" },
    { path: 'modules/B/index.ts', text: "import '../A/index.js';\n" },
    { path: 'modules/C/index.ts', text: "import '../A/index.js';\n" },
  ];
  const graph = scanImportGraph(sources);
  console.log(`(c-fixture) nodes=${JSON.stringify(graph.nodes)} sccs=${JSON.stringify(graph.nonTrivialSccs)}`);
  assert.deepEqual(newDirectoryViolations(graph, ['modules/A', 'modules/B', 'modules/C']), [], 'C declared in the manifest is an old directory, not a new one — no violation');

  const undeclared = newDirectoryViolations(graph, ['modules/A', 'modules/B']);
  console.log(`(c-fixture) C undeclared: ${JSON.stringify(undeclared)}`);
  assert.ok(undeclared.length > 0, 'an undeclared directory importing a modules peer must be a violation');
  assert.ok(undeclared.some((message) => message.includes('modules/C')), 'the violation must name the offending directory');
});

// ---------------------------------------------------------------------------
// (d) the shared leaf — asserted on its own, never as "an ordinary directory"
// ---------------------------------------------------------------------------

test('(d) server/shared has zero imports into server/modules/**, static or dynamic', () => {
  const graph = realGraph(true);
  const offending = sharedToModulesEdges(graph);
  for (const edge of offending) console.log(`(d) OFFENCE ${repoRelative(edge.from)} -> ${repoRelative(edge.to)}`);
  console.log(`(d) shared->modules edges: ${offending.length} (static=${offending.filter((edge) => edge.static).length} dynamic=${offending.filter((edge) => edge.dynamic).length})`);
  assert.deepEqual(offending.map((edge) => `${edge.from} -> ${edge.to}`), [], 'server/shared must not import server/modules/** — it is the leaf every module may reach');
});

test('(d-fixture) the shared leaf check reds an injected back-reference, in a synthetic tree', () => {
  const clean: SourceFile[] = [
    { path: 'shared/utils.ts', text: "import './index.js';\n" },
    { path: 'modules/websocket/index.ts', text: 'export const socket = 1;\n' },
  ];
  const dirty: SourceFile[] = [
    { path: 'shared/utils.ts', text: "import '@/modules/websocket/index.js';\n" },
    { path: 'modules/websocket/index.ts', text: 'export const socket = 1;\n' },
  ];
  const cleanEdges = sharedToModulesEdges(scanImportGraph(clean));
  const dirtyEdges = sharedToModulesEdges(scanImportGraph(dirty));
  console.log(`(d-fixture) clean=${JSON.stringify(cleanEdges)} dirty=${JSON.stringify(dirtyEdges)}`);
  assert.deepEqual(cleanEdges, [], 'a shared file importing only shared must stay green');
  assert.deepEqual(
    dirtyEdges.map((edge) => `${edge.from} -> ${edge.to}`),
    ['shared -> modules/websocket'],
    'a shared file importing a modules peer must be caught',
  );
});

// ---------------------------------------------------------------------------
// (e) the two budgets — non-literal dynamic specifiers, and unresolved internals
// ---------------------------------------------------------------------------

test('(e) the non-literal dynamic import and unresolved-internal budgets hold', () => {
  const graph = realGraph(true);
  const baseline = readBaseline();

  const perFile = new Map<string, number>();
  for (const hit of graph.nonLiteralDynamic) perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1);
  for (const [file, count] of perFile) console.log(`(e) non-literal dynamic: ${repoRelative(file)} x${count} at lines ${graph.nonLiteralDynamic.filter((hit) => hit.file === file).map((hit) => hit.line).join(',')}`);
  console.log(
    `(e) non-literal dynamic total=${graph.nonLiteralDynamic.length} ` +
      `budgetFiles=${baseline.nonLiteralDynamic.allowedFiles.map((entry) => `${entry.file}:${entry.maxPerFile}`).join(',')}`,
  );

  const allowed = new Map(
    baseline.nonLiteralDynamic.allowedFiles.map((entry) => [
      entry.file.startsWith('server/') ? entry.file.slice('server/'.length) : entry.file,
      entry.maxPerFile,
    ]),
  );
  const strayFiles = [...perFile.keys()].filter((file) => !allowed.has(file));
  assert.deepEqual(
    strayFiles,
    [],
    `non-literal dynamic import() may only appear in ${[...allowed.keys()].map((file) => repoRelative(file)).join(', ')} — a stray occurrence is a red even if the total is unchanged`,
  );
  for (const [file, budget] of allowed) {
    const count = perFile.get(file) ?? 0;
    assert.ok(count <= budget, `${repoRelative(file)} holds ${count} non-literal dynamic import()s, over the budget of ${budget}`);
  }

  console.log(`(e) unresolved internal=${graph.unresolvedInternal.length} budget=${baseline.unresolvedInternalBudget}`);
  for (const hit of graph.unresolvedInternal) console.log(`(e) unresolved ${repoRelative(hit.file)}:${hit.line} ${hit.specifier}`);
  assert.ok(
    graph.unresolvedInternal.length <= baseline.unresolvedInternalBudget,
    `unresolved internal specifiers=${graph.unresolvedInternal.length}, over the baseline budget of ${baseline.unresolvedInternalBudget} — the budget may only fall`,
  );
});

// ---------------------------------------------------------------------------
// (f) no dead walk, and a synthetic tree that exercises every detector
// ---------------------------------------------------------------------------

test('(f) the resolved file-level edge count is far above the floor — the walk cannot be vacuously green', () => {
  const graph = realGraph(true);
  const resolved = graph.staticFileEdges + graph.dynamicFileEdges;
  console.log(`(f) resolved file-level edges=${resolved} (static=${graph.staticFileEdges} dynamic=${graph.dynamicFileEdges}) floor=${MIN_RESOLVED_FILE_EDGES}`);
  assert.ok(resolved >= MIN_RESOLVED_FILE_EDGES, `only ${resolved} file-level edges resolved — a dead walk satisfies the "no violation" assertions for the wrong reason`);
});

test('(f-fixture) a two-directory cycle is reported and a one-way import is not', () => {
  const cycle = scanImportGraph([
    { path: 'modules/A/index.ts', text: "import '../B/index.js';\n" },
    { path: 'modules/B/index.ts', text: "import '../A/index.js';\n" },
  ]);
  const acyclic = scanImportGraph([
    { path: 'modules/A/index.ts', text: "import '../B/index.js';\n" },
    { path: 'modules/B/index.ts', text: 'export const b = 1;\n' },
  ]);
  console.log(`(f-fixture) cycle sccs=${JSON.stringify(cycle.nonTrivialSccs)} acyclic sccs=${JSON.stringify(acyclic.nonTrivialSccs)}`);
  assert.deepEqual(cycle.nonTrivialSccs, [['modules/A', 'modules/B']], 'A -> B -> A must be reported as one SCC');
  assert.deepEqual(acyclic.nonTrivialSccs, [], 'A -> B with no return edge must not be an SCC');
});

test('(f-fixture) an out-of-cycle directory is pulled into the SCC by a LITERAL dynamic import back into it', () => {
  const sources: SourceFile[] = [
    { path: 'modules/A/index.ts', text: "import '../B/index.js';\n" },
    { path: 'modules/B/index.ts', text: "import '../A/index.js';\nimport '../D/index.js';\n" },
    { path: 'modules/D/index.ts', text: "import('../B/index.js');\n" },
  ];
  const staticOnly = scanImportGraph(sources, { includeDynamic: false });
  const withDynamic = scanImportGraph(sources, { includeDynamic: true });
  console.log(`(f-fixture) static-only sccs=${JSON.stringify(staticOnly.nonTrivialSccs)} static+dynamic sccs=${JSON.stringify(withDynamic.nonTrivialSccs)}`);

  assert.deepEqual(staticOnly.nonTrivialSccs, [['modules/A', 'modules/B']], 'without the dynamic edge, D is outside the cycle');
  assert.deepEqual(withDynamic.nonTrivialSccs, [['modules/A', 'modules/B', 'modules/D']], 'the literal dynamic import back into B must pull D into the SCC — proof the scanner really parses import()');

  const groups = [['modules/A', 'modules/B']];
  const violations = cycleViolations(withDynamic.nonTrivialSccs, groups, 'fixture');
  console.log(`(f-fixture) containment violations: ${JSON.stringify(violations)}`);
  assert.ok(violations.length > 0, 'the widened SCC must red the containment check');
  assert.ok(violations.some((message) => message.includes('modules/D')), 'the violation must name the directory pulled in');
});

// ---------------------------------------------------------------------------
// (g) the real-tree false form — a cycle member and an out-of-cycle directory fenced together
// ---------------------------------------------------------------------------

test('(g) pulling a real out-of-cycle directory into a real cycle reds (b); the unmodified tree stays green', () => {
  const green = cycleViolations(realGraph(true).nonTrivialSccs, CYCLE_GROUPS, 'unmodified tree');
  console.log(`(g) unmodified tree violations: ${JSON.stringify(green)}`);
  assert.deepEqual(green, [], 'the unmodified tree must be green before the injection');

  // The injection is in memory: two REAL files (one in a cycle, one out of it) get one import
  // each, and the SAME scanner is re-run over the real source set. Nothing on disk moves.
  const OUT_OF_CYCLE = 'modules/logging/index.ts';
  const CYCLE_MEMBER = 'modules/websocket/index.ts';
  const injected = sourcesOnce().map((source) => {
    if (source.path === OUT_OF_CYCLE) return { path: source.path, text: `${source.text}\nimport '../../modules/websocket/index.js';\n` };
    if (source.path === CYCLE_MEMBER) return { path: source.path, text: `${source.text}\nimport '../../modules/logging/index.js';\n` };
    return source;
  });
  const fenced = scanImportGraph(injected, { includeDynamic: true });
  const red = cycleViolations(fenced.nonTrivialSccs, CYCLE_GROUPS, 'injected tree');
  console.log(`(g) injected tree sccs=${JSON.stringify(fenced.nonTrivialSccs.map((component) => component.length))}`);
  console.log(`(g) injected tree violations: ${JSON.stringify(red, null, 0)}`);
  assert.ok(red.length > 0, 'fencing a real out-of-cycle directory into a real cycle must red the containment check');
  assert.ok(red.some((message) => message.includes('modules/logging')), 'the red must name the directory that was pulled in');
  assert.ok(red.some((message) => message.includes('modules/websocket')), 'the red must name the cycle it joined');
});
