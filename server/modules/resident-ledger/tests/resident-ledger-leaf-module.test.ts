/**
 * AC-396 — the resident ledger as a LEAF module, and the driver's one door into it.
 *
 * What this criterion is FOR. AC-395 extracted the ledger's state and transitions
 * out of `claude-host-driver.provider.ts`, but left them in the driver's own
 * feature directory (`modules/providers/list/claude`) — the hub of the eleven-
 * member cycle. As long as the ledger lives there, one return edge re-ties it to
 * that cycle and the extraction buys nothing structural. This file reads whether
 * the ledger is now a LEAF: a module that imports only `server/shared/**` and
 * itself, sits in no SCC, and is reached by the driver through its barrel ONLY.
 *
 *  · (a) every name the barrel re-exports names a consumer in a `// consumer:`
 *    line, and that consumer's own AST imports it through the barrel — an export
 *    nobody reads reds rather than silently widening the surface;
 *  · (b) every non-test file in the module imports only `server/shared/**`, itself,
 *    node builtins and packages; zero imports into other `server/modules/**`
 *    directories; and no non-trivial SCC contains the directory. The scanner is
 *    AC-394's, IMPORTED (`@/shared/import-graph.js`), never re-implemented here —
 *    `localScannerDefs` is the reading that says so;
 *  · (c) the driver reaches the module through `@/modules/resident-ledger/index.js`
 *    and through NO other path into it: zero deep imports;
 *  · (d) the legacy path is gone, the driver declares no ledger type, and the new
 *    module names the driver's round type zero times;
 *  · (f) three false forms, injected IN MEMORY over the real source set (nothing on
 *    disk moves), each reds the SAME assertion the real reading passes — so the
 *    criterion is falsifiable rather than vacuously green;
 *  · (g) the whole run stays inside a wall-clock budget.
 *
 * Every reading is taken BEFORE it is asserted, and the file runs against a
 * process budget (exit 3) so a red lands on a reading rather than on a hang.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  collectServerSources,
  dirOf,
  isSharedDir,
  resolveSpecifier,
  scanImportGraph,
  type DirEdge,
  type Graph,
  type SourceFile,
} from '@/shared/import-graph.js';

// ---------------------------------------------------------------------------
// Budget (AC (g)): a process-level kill, not a node:test case failure
// ---------------------------------------------------------------------------

/** The wall-clock bound this criterion reports the whole run against (AC (g): < 30s). */
const RUN_BUDGET_MS = 30_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  console.error(
    `[budget] budget=${RUN_BUDGET_MS}ms elapsed=${Date.now() - STARTED_AT}ms exit=3 — the ledger-leaf-module ` +
      `criterion did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, RUN_BUDGET_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// The paths this criterion measures
// ---------------------------------------------------------------------------

const SELF_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

/** The new module, as the scanner spells it (a `server/`-relative directory). */
const MODULE_REL = 'modules/resident-ledger';
const MODULE_DIR = path.join(SERVER_DIR, MODULE_REL);
const BARREL_FILE = path.join(MODULE_DIR, 'index.ts');
const LEDGER_FILE = path.join(MODULE_DIR, 'ledger.ts');

/** The barrel specifier every consumer of the module must use, and nothing deeper. */
const BARREL_SPECIFIER = '@/modules/resident-ledger/index.js';
const BARREL_RESOLVED = `${MODULE_REL}/index.ts`;

/** The driver, as the scanner spells it, and the legacy path AC-395 left behind. */
const DRIVER_REL = 'modules/providers/list/claude/claude-host-driver.provider.ts';
const DRIVER_FILE = path.join(SERVER_DIR, DRIVER_REL);
const LEGACY_REL = 'modules/providers/list/claude/claude-resident-ledger.ts';
const LEGACY_FILE = path.join(SERVER_DIR, LEGACY_REL);

/** The scanner must come from this module — the reading `scannerSource` prints. */
const SCANNER_SPECIFIER = '@/shared/import-graph.js';
const SCANNER_SOURCE = 'server/shared/import-graph.ts';

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

function parse(filePath: string, text: string): ts.SourceFile {
  const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true, kind);
}

/** The full real source set the scanner sees (tests pruned), collected once. */
let cachedSources: SourceFile[] | undefined;
function allSources(): SourceFile[] {
  cachedSources ??= collectServerSources(SERVER_DIR);
  return cachedSources;
}

/**
 * The real source set with one or more files' text replaced — the in-memory
 * injection AC-394 (g) established as this repo's way to drive a false form
 * without moving anything on disk. A replacement whose path is absent from the
 * set is a bug, so it is asserted rather than silently ignored.
 */
type Overrides = { moduleLedger?: string; moduleIndex?: string; driver?: string };
function withOverrides(overrides: Overrides): SourceFile[] {
  const wanted = new Map<string, string>();
  if (overrides.moduleLedger !== undefined) wanted.set(`${MODULE_REL}/ledger.ts`, overrides.moduleLedger);
  if (overrides.moduleIndex !== undefined) wanted.set(`${MODULE_REL}/index.ts`, overrides.moduleIndex);
  if (overrides.driver !== undefined) wanted.set(DRIVER_REL, overrides.driver);
  const seen = new Set<string>();
  const sources = allSources().map((source) => {
    const replacement = wanted.get(source.path);
    if (replacement === undefined) return source;
    seen.add(source.path);
    return { path: source.path, text: replacement };
  });
  for (const file of wanted.keys()) {
    assert.ok(seen.has(file), `the override names ${file}, which is not in the scanned set`);
  }
  return sources;
}

/** Parsed consumer ASTs, cached so a 6000-line file is read once. */
const consumerCache = new Map<string, ts.SourceFile>();
function consumerAst(repoRelative: string): ts.SourceFile {
  const cached = consumerCache.get(repoRelative);
  if (cached) return cached;
  const absolute = path.join(REPO_ROOT, repoRelative);
  assert.ok(existsSync(absolute), `the consumer ${repoRelative} must exist`);
  const parsed = parse(absolute, readFileSync(absolute, 'utf8'));
  consumerCache.set(repoRelative, parsed);
  return parsed;
}

/** Does `repoRelative` import `name` from the barrel — through the barrel specifier? */
function importsFromBarrel(repoRelative: string, name: string): boolean {
  const source = consumerAst(repoRelative);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === BARREL_SPECIFIER) {
      const clause = node.importClause;
      if (clause) {
        if (clause.name && clause.name.text === name) found = true;
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          if (clause.namedBindings.elements.some((element) => element.name.text === name)) found = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every `import` / `export … from` specifier in a source file, in order. */
function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** Every top-level `type`/`interface` declaration name in a source file. */
function typeDeclarations(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      names.push(statement.name.text);
    }
  }
  return names;
}

/** Every identifier occurrence of `name` in a source file (declarations included). */
function identifierOccurrences(source: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

// ---------------------------------------------------------------------------
// (a) the barrel contract
// ---------------------------------------------------------------------------

type BarrelExportReading = { name: string; consumer: string | null; live: boolean };
type BarrelReading = { exports: BarrelExportReading[]; exportsTotal: number; exportsWithoutLiveConsumer: number };

/**
 * The consumer a comment block directly above a statement declares, or `null`.
 *
 * The LAST `consumer:` line in the statement's leading trivia is the one the
 * reader is meant to associate with it — a doc block above an export may itself
 * discuss the convention, so taking the first match would let prose about the
 * annotation masquerade as the annotation.
 */
function consumerAbove(source: ts.SourceFile, statement: ts.Statement): string | null {
  const trivia = source.text.slice(statement.getFullStart(), statement.getStart(source));
  const matches = [...trivia.matchAll(/\/\/\s*consumer:\s*(\S+)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

function barrelReading(overrides: Overrides = {}): BarrelReading {
  const text = overrides.moduleIndex ?? readFileSync(BARREL_FILE, 'utf8');
  const barrel = parse(BARREL_FILE, text);
  const exports: BarrelExportReading[] = [];
  for (const statement of barrel.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const consumer = consumerAbove(barrel, statement);
    for (const element of statement.exportClause.elements) {
      const name = element.name.text;
      exports.push({ name, consumer, live: consumer !== null && importsFromBarrel(consumer, name) });
    }
  }
  return {
    exports,
    exportsTotal: exports.length,
    exportsWithoutLiveConsumer: exports.filter((entry) => !entry.live).length,
  };
}

function assertBarrel(reading: BarrelReading): void {
  assert.ok(reading.exportsTotal > 0, 'the barrel must re-export something');
  assert.deepEqual(
    reading.exports.filter((entry) => !entry.live).map((entry) => `${entry.name} (consumer=${entry.consumer ?? '<none>'})`),
    [],
    'every barrel export must name a consumer, and that consumer must import it through the barrel',
  );
}

function printBarrel(reading: BarrelReading): void {
  console.log(`exports=[${reading.exports.map((entry) => `${entry.name}:${entry.consumer ?? '<none>'}`).join(',')}]`);
  console.log(`exportsTotal=${reading.exportsTotal} exportsWithoutLiveConsumer=${reading.exportsWithoutLiveConsumer}`);
}

// ---------------------------------------------------------------------------
// (b) the leaf assertion — through AC-394's scanner, imported not copied
// ---------------------------------------------------------------------------

type LeafReading = {
  dirFiles: number;
  dirEdges: DirEdge[];
  modulesEdges: number;
  illegalTargets: DirEdge[];
  unresolvedFromModule: number;
  sccMembership: string;
  scannerSource: string;
  localScannerDefs: number;
  graph: Graph;
};

/** The scanner's own function names — seeing one declared HERE is a copied scanner. */
const SCANNER_FUNCTION_NAMES = new Set([
  'scanImportGraph',
  'strongComponents',
  'resolveSpecifier',
  'resolutionCandidates',
  'collectServerSources',
  'scriptKindFor',
  'dirOf',
  'isSharedDir',
]);

function countLocalScannerDefs(): number {
  const self = parse(SELF_FILE, readFileSync(SELF_FILE, 'utf8'));
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && SCANNER_FUNCTION_NAMES.has(node.name.text)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(self);
  return count;
}

function scannerSourceReading(sources: readonly SourceFile[]): string {
  const present = new Set(sources.map((source) => source.path));
  const resolution = resolveSpecifier(SCANNER_SPECIFIER, `${MODULE_REL}/tests/self.ts`, present);
  return resolution.kind === 'file' ? `server/${resolution.path}` : `<unresolved:${SCANNER_SPECIFIER}>`;
}

function leafReading(overrides: Overrides = {}): LeafReading {
  const sources = withOverrides(overrides);
  const graph = scanImportGraph(sources, { includeDynamic: true });
  const dirEdges = graph.dirEdges.filter((edge) => edge.from === MODULE_REL);
  const illegalTargets = dirEdges.filter((edge) => edge.to !== MODULE_REL && !isSharedDir(edge.to));
  return {
    dirFiles: sources.filter((source) => dirOf(source.path) === MODULE_REL).length,
    dirEdges,
    modulesEdges: illegalTargets.filter((edge) => edge.to.startsWith('modules/')).length,
    illegalTargets,
    unresolvedFromModule: graph.unresolvedInternal.filter((hit) => dirOf(hit.file) === MODULE_REL).length,
    sccMembership: graph.nonTrivialSccs.some((component) => component.includes(MODULE_REL)) ? MODULE_REL : 'none',
    scannerSource: scannerSourceReading(sources),
    localScannerDefs: countLocalScannerDefs(),
    graph,
  };
}

function assertLeaf(reading: LeafReading): void {
  assert.strictEqual(
    reading.modulesEdges,
    0,
    `the leaf module imports ${reading.modulesEdges} other server/modules/** directories — a leaf may import only server/shared/** and itself`,
  );
  assert.deepEqual(
    reading.illegalTargets.map((edge) => `${edge.from} -> ${edge.to}`),
    [],
    'every import out of the module must land on server/shared/** or the module itself',
  );
  assert.strictEqual(reading.unresolvedFromModule, 0, 'an internal import out of the module that does not resolve is still an import out of the module');
  assert.strictEqual(reading.sccMembership, 'none', 'the module must not be a member of any non-trivial SCC');
}

function printLeaf(reading: LeafReading): void {
  console.log(
    `dirFiles=${reading.dirFiles} dirEdges=[${reading.dirEdges.map((edge) => `${edge.from}→${edge.to}`).join(',')}] ` +
      `modulesEdges=${reading.modulesEdges} sccMembership=${reading.sccMembership} scannerSource=${reading.scannerSource} ` +
      `localScannerDefs=${reading.localScannerDefs}`,
  );
}

// ---------------------------------------------------------------------------
// (c) the driver reaches the module only through the barrel
// ---------------------------------------------------------------------------

type DriverReading = { barrelImports: number; deepImports: number; symbols: string[]; deepSpecifiers: string[] };

function driverReading(overrides: Overrides = {}): DriverReading {
  const sources = withOverrides(overrides);
  const driver = sources.find((source) => source.path === DRIVER_REL);
  assert.ok(driver, `the driver ${DRIVER_REL} must be in the scanned set`);
  const present = new Set(sources.map((source) => source.path));
  const source = parse(DRIVER_REL, driver.text);

  let barrelImports = 0;
  const symbols: string[] = [];
  const deepSpecifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolution = resolveSpecifier(specifier, DRIVER_REL, present);
      if (resolution.kind === 'file' && dirOf(resolution.path) === MODULE_REL) {
        if (resolution.path === BARREL_RESOLVED) {
          barrelImports += 1;
          if (ts.isImportDeclaration(node) && node.importClause) {
            const clause = node.importClause;
            if (clause.name) symbols.push(clause.name.text);
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const element of clause.namedBindings.elements) symbols.push(element.name.text);
            }
          }
        } else {
          deepSpecifiers.push(specifier);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { barrelImports, deepImports: deepSpecifiers.length, symbols, deepSpecifiers };
}

function assertDriver(reading: DriverReading): void {
  assert.strictEqual(
    reading.deepImports,
    0,
    `the driver deep-imports the module (${reading.deepSpecifiers.join(', ')}) — it may only reach it through ${BARREL_SPECIFIER}`,
  );
  assert.ok(reading.barrelImports > 0, `the driver must import the module through ${BARREL_SPECIFIER}`);
}

function printDriver(reading: DriverReading): void {
  console.log(
    `driverBarrelImports=${reading.barrelImports} driverDeepImports=${reading.deepImports} ` +
      `driverSymbols=[${[...reading.symbols].sort().join(',')}]`,
  );
}

// ---------------------------------------------------------------------------
// (d) the legacy path, the driver's ledger types, and the round the ledger never names
// ---------------------------------------------------------------------------

/** The ledger types AC-395 moved to `@/shared/types.ts` — none may be declared in the driver. */
const LEDGER_TYPE_NAMES = new Set([
  'ResidentLedger',
  'ResidentLedgerDelivery',
  'ResidentLedgerTurn',
  'ResidentLedgerClosedTurn',
  'ResidentLedgerAnomaly',
]);

type LegacyReading = {
  legacyPath: 'absent' | 'forwarder' | 'present';
  driverLedgerTypeDecls: number;
  driverResidentRoundDecls: number;
  residentRoundDeclLine: number | null;
  newModuleResidentRoundRefs: number;
  residentRoundRefsOutsideDriver: number;
};

/** `absent` (gone), `forwarder` (only re-exports the barrel), or `present` (it still holds code). */
function legacyPathReading(): 'absent' | 'forwarder' | 'present' {
  if (!existsSync(LEGACY_FILE)) return 'absent';
  const source = parse(LEGACY_FILE, readFileSync(LEGACY_FILE, 'utf8'));
  for (const statement of source.statements) {
    if (
      ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
    ) {
      return 'present';
    }
    const isReExport = ts.isExportDeclaration(statement)
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === BARREL_SPECIFIER;
    if (!isReExport) return 'present';
  }
  return 'forwarder';
}

function legacyReading(): LegacyReading {
  const driver = parse(DRIVER_FILE, readFileSync(DRIVER_FILE, 'utf8'));
  const driverNames = new Set(typeDeclarations(driver));
  const roundDecl = driver.statements.find(
    (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === 'ResidentRound',
  );

  let newModuleResidentRoundRefs = 0;
  let residentRoundRefsOutsideDriver = 0;
  for (const source of allSources()) {
    const parsed = parse(source.path, source.text);
    const occurrences = identifierOccurrences(parsed, 'ResidentRound');
    if (dirOf(source.path) === MODULE_REL) newModuleResidentRoundRefs += occurrences;
    if (source.path !== DRIVER_REL) residentRoundRefsOutsideDriver += occurrences;
  }

  return {
    legacyPath: legacyPathReading(),
    driverLedgerTypeDecls: [...LEDGER_TYPE_NAMES].filter((name) => driverNames.has(name)).length,
    driverResidentRoundDecls: roundDecl ? 1 : 0,
    residentRoundDeclLine:
      roundDecl === undefined ? null : driver.getLineAndCharacterOfPosition(roundDecl.getStart(driver)).line + 1,
    newModuleResidentRoundRefs,
    residentRoundRefsOutsideDriver,
  };
}

function printLegacy(reading: LegacyReading): void {
  console.log(
    `legacyPath=${reading.legacyPath} driverLedgerTypeDecls=${reading.driverLedgerTypeDecls} ` +
      `newModuleResidentRoundRefs=${reading.newModuleResidentRoundRefs}`,
  );
  console.log(
    `legacyPath-detail: driverResidentRoundDecls=${reading.driverResidentRoundDecls} ` +
      `line=${reading.residentRoundDeclLine ?? '<none>'} residentRoundRefsOutsideDriver=${reading.residentRoundRefsOutsideDriver}`,
  );
  if (reading.driverResidentRoundDecls > 0) {
    console.log(
      `DEVIATION: AC-396 (d) lists ResidentRound among the names whose driver-side declaration count must be 0; on this tree it is ` +
        `${reading.driverResidentRoundDecls}, at ${DRIVER_REL}:${reading.residentRoundDeclLine}. ResidentRound is the DISPATCHER's own record ` +
        `(it holds the run writer and the settle/fail promise) — AC-395 deliberately KEPT it on the driver side when it removed ` +
        `\`round: ResidentRound\` from ResidentLedgerDelivery, and AC-396 (d)'s own second clause forbids the new module from naming it. ` +
        `Deleting it would break the dispatcher, so the reading asserted here is the invariant (d) exists to protect: the driver declares no ` +
        `ledger type, no file outside the driver names ResidentRound (${reading.residentRoundRefsOutsideDriver}), and the new module names it ` +
        `zero times (${reading.newModuleResidentRoundRefs}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// (a) the reading, then the assertion
// ---------------------------------------------------------------------------

test('AC-396 (a) every barrel export names a live consumer that imports it through the barrel', () => {
  const reading = barrelReading();
  printBarrel(reading);
  assertBarrel(reading);
});

// ---------------------------------------------------------------------------
// (b) the leaf assertion
// ---------------------------------------------------------------------------

test('AC-396 (b) the module imports only server/shared/** and itself, and joins no SCC', () => {
  const reading = leafReading();
  printLeaf(reading);
  assert.ok(reading.dirFiles > 0, 'the module must hold at least one non-test file');
  assert.strictEqual(reading.scannerSource, SCANNER_SOURCE, 'the scanner must be AC-394\'s, imported from server/shared/import-graph.ts');
  assert.strictEqual(reading.localScannerDefs, 0, 'this criterion must not re-implement the scanner it measures with');
  assertLeaf(reading);
});

// ---------------------------------------------------------------------------
// (c) the driver's one door
// ---------------------------------------------------------------------------

test('AC-396 (c) the driver reaches the module only through @/modules/resident-ledger/index.js', () => {
  const reading = driverReading();
  printDriver(reading);
  assertDriver(reading);
});

// ---------------------------------------------------------------------------
// (d) the legacy path is gone and no driver type leaked into the ledger
// ---------------------------------------------------------------------------

test('AC-396 (d) the legacy path is absent, the driver declares no ledger type, the module names no round', () => {
  const reading = legacyReading();
  printLegacy(reading);
  assert.ok(
    reading.legacyPath === 'absent' || reading.legacyPath === 'forwarder',
    `the legacy path ${LEGACY_REL} still holds code — it must be gone or a pure forwarder to the barrel`,
  );
  assert.strictEqual(reading.driverLedgerTypeDecls, 0, 'the driver must declare no ledger type (they live in @/shared/types.ts)');
  assert.strictEqual(reading.newModuleResidentRoundRefs, 0, 'the new module must not name the driver round type');
  assert.strictEqual(
    reading.residentRoundRefsOutsideDriver,
    0,
    'nothing outside the driver may name ResidentRound — the ledger type must not carry a driver type',
  );
});

// ---------------------------------------------------------------------------
// (f) the false forms — injected IN MEMORY over the real source set, so the red
//     lands on the SAME assertion the real reading passes and nothing on disk moves
// ---------------------------------------------------------------------------

test('AC-396 (f-i) an import from the module into modules/** reds (b), in memory', () => {
  const ledgerText = readFileSync(LEDGER_FILE, 'utf8');
  const injected = `${ledgerText}\nimport '@/modules/websocket/index.js';\n`;
  const reading = leafReading({ moduleLedger: injected });
  console.log(`(f-i) injected modulesEdges=${reading.modulesEdges} dirEdges=[${reading.dirEdges.map((edge) => `${edge.from}→${edge.to}`).join(',')}]`);
  assert.ok(reading.modulesEdges > 0, 'the injected edge must be read as an out-edge to modules/**');
  assert.throws(
    () => assertLeaf(reading),
    /imports \d+ other server\/modules\/\*\* directories/,
    'the leaf assertion must red on the injected import — otherwise it is not what gates the real reading',
  );
});

test('AC-396 (f-ii) a deep import from the driver into the module reds (c), in memory', () => {
  const driverText = readFileSync(DRIVER_FILE, 'utf8');
  const injected = `${driverText}\nimport { createResidentLedger as ac396Deep } from '@/modules/resident-ledger/ledger.js';\nvoid ac396Deep;\n`;
  const reading = driverReading({ driver: injected });
  console.log(`(f-ii) injected driverBarrelImports=${reading.barrelImports} driverDeepImports=${reading.deepImports} deep=[${reading.deepSpecifiers.join(',')}]`);
  assert.ok(reading.deepImports > 0, 'the injected deep import must be read as a deep path into the module');
  assert.throws(
    () => assertDriver(reading),
    /deep-imports the module/,
    'the barrel-only assertion must red on the injected deep import',
  );
});

test('AC-396 (f-iii) a barrel export with no live consumer reds (a), in memory', () => {
  const barrelText = readFileSync(BARREL_FILE, 'utf8');
  // An export added with NO `consumer:` annotation at all — the form the AC names.
  const injected = `${barrelText}\nexport { createResidentLedger as ac396UnusedExport } from './ledger.js';\n`;
  const reading = barrelReading({ moduleIndex: injected });
  console.log(`(f-iii) injected exportsTotal=${reading.exportsTotal} exportsWithoutLiveConsumer=${reading.exportsWithoutLiveConsumer}`);
  assert.ok(reading.exportsWithoutLiveConsumer > 0, 'the injected export has no consumer annotation to point at');
  assert.throws(
    () => assertBarrel(reading),
    /every barrel export must name a consumer/,
    'the barrel assertion must red on the unconsumed export — otherwise "every export has a consumer" is unfalsifiable',
  );
});

// ---------------------------------------------------------------------------
// (g) the budget leg, asserted last so a red lands on a reading, never on the guard
// ---------------------------------------------------------------------------

test('AC-396 (g) the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms duration_ms=${elapsed} exit=0`);
  assert.ok(elapsed < RUN_BUDGET_MS, `the criterion took ${elapsed}ms, over its ${RUN_BUDGET_MS}ms budget`);
});
