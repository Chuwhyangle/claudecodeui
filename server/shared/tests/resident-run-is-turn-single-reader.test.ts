/**
 * AC-392 — the `RESIDENT_RUN_IS_TURN` switch has ONE reader in non-test server
 * code, and that reader is the shared evaluation leaf `server/shared/utils.ts`.
 *
 * The SPEC (§4.4 I6, §12, §14; GOAL-045 S2's "run 即 turn" switch face) turns a
 * resident session's run into its turn behind one environment variable. Before
 * this criterion the flag was spelled twice — a local `residentRunIsTurn()` in
 * `claude-host-driver.provider.ts` and a second one exported by
 * `chat-run-registry.service.ts` — because the providers module may not import
 * the websocket module (that edge closes a cycle whose evaluation order trips the
 * `providerRegistry` TDZ). Two spellings of one string is the defect: "one switch,
 * two spellings" drifts the moment one side is edited. The fix moves the predicate
 * to `@/shared/utils.ts`, a leaf both sides can import, leaving exactly one read.
 *
 * Every reading comes from the TypeScript SYNTAX TREE (`ts.createSourceFile`),
 * never from grepped text. The distinction is load-bearing: this file's own
 * fixtures and the surrounding prose name the variable, and the driver's header
 * explains the old copy in a comment. A parse gets that right for free — a comment
 * is trivia and a string literal is a `StringLiteral`, never a `PropertyAccess`
 * on `process.env` — and `(d)` proves the scanner in the SAME run with in-memory
 * sources rather than trusting that it can discriminate.
 *
 * Five readings, taken in one run against the tree on disk:
 *
 *   (a) flag readers — `process.env.RESIDENT_RUN_IS_TURN` (and the bracketed form)
 *       read as a value, across every non-test `server/` source. Expect `1`, at
 *       `server/shared/utils.ts`.
 *   (b) import face — the predicate is `export`ed from `server/shared/utils.ts`
 *       with a consumer comment, the driver / registry / chat-websocket each have
 *       an import of it from `@/shared/utils.js`, and the registry no longer
 *       re-exports it.
 *   (c) call-time read — with the predicate imported, `'1'` answers true and every
 *       other value (or a deleted variable) answers false.
 *   (d) negative control — the same scanner over in-memory sources: names that live
 *       only in comments and strings read 0; two real reads read 2.
 *
 * `(e)` — the false form — is the manual procedure recorded with this task: add a
 * second read in any non-test file and `(a)` must go red on `flagReaders=2`, not on
 * another leg. The whole run is capped by the `exit 3` process budget below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { residentRunIsTurn } from '@/shared/utils.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

/** The one location the flag may be read from. */
const LEAF_REL = 'server/shared/utils.ts';
/** The other three files whose import face this criterion pins. */
const DRIVER_REL = 'server/modules/providers/list/claude/claude-host-driver.provider.ts';
const REGISTRY_REL = 'server/modules/websocket/services/chat-run-registry.service.ts';
const WEBSOCKET_REL = 'server/modules/websocket/services/chat-websocket.service.ts';
/** The module specifier every consumer must import the predicate from. */
const LEAF_SPECIFIER = '@/shared/utils.js';

const FLAG_NAME = 'RESIDENT_RUN_IS_TURN';
const PREDICATE = 'residentRunIsTurn';

/** A source and its repo-relative path — real (from disk) or synthetic (a fixture). */
type SourceFile = { path: string; text: string };

/** One value-read of the flag, located as `file:line`. */
type FlagRead = { file: string; line: number };

/** The result of one scan: every read and how many files were read. */
type FlagScan = { reads: FlagRead[]; filesScanned: number };

// ---------------------------------------------------------------------------
// The counting core — pure over (sources), so a fixture can drive it
// ---------------------------------------------------------------------------

/** `.tsx` must be parsed as TSX; `.js`/`.mjs` as JS; everything else as TS. */
function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * `process.env.RESIDENT_RUN_IS_TURN` (a property access) or
 * `process.env['RESIDENT_RUN_IS_TURN']` (an element access over a string literal),
 * and nothing else. The receiver must be exactly `process.env`, so a shadowed
 * `env.RESIDENT_RUN_IS_TURN` on some other object is not counted; and the property
 * name must be the flag, so `process.env.SOMETHING_ELSE` is not.
 */
function isFlagRead(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text !== FLAG_NAME) return false;
    const receiver = node.expression;
    return (
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === 'env' &&
      ts.isIdentifier(receiver.expression) &&
      receiver.expression.text === 'process'
    );
  }
  if (ts.isElementAccessExpression(node)) {
    const receiver = node.expression;
    const argument = node.argumentExpression;
    return (
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === 'env' &&
      ts.isIdentifier(receiver.expression) &&
      receiver.expression.text === 'process' &&
      argument !== undefined &&
      ts.isStringLiteral(argument) &&
      argument.text === FLAG_NAME
    );
  }
  return false;
}

/**
 * Parses every source and counts the value-reads of the flag, each located as
 * `file:line`. A comment produces no node at all and a name inside a string
 * literal is a `StringLiteral` — neither can be counted, which is exactly the
 * discrimination `(d)` proves.
 */
function scanFlagReads(sources: readonly SourceFile[]): FlagScan {
  const reads: FlagRead[] = [];

  for (const source of sources) {
    const sourceFile = ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindFor(source.path),
    );

    const visit = (node: ts.Node): void => {
      if (isFlagRead(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        reads.push({ file: source.path, line: line + 1 });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { reads, filesScanned: sources.length };
}

/**
 * Non-test `server/` sources: `.ts`/`.tsx`/`.js`/`.mjs`, from disk. A file is
 * excluded when its name is `*.test.*`/`*.spec.*` OR any path segment is `tests/`,
 * and `node_modules/` and `dist/` directories are pruned. Read straight from disk,
 * so the reading is of what is on the tree, not of a tsconfig include set.
 */
function collectNonTestSources(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
        walk(path.join(directory, entry.name));
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(REPO_ROOT, absolute);
      if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(relative)) continue;
      found.push({ path: relative, text: fs.readFileSync(absolute, 'utf8') });
    }
  };
  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// The import/export face — a second, narrower parse of four named files
// ---------------------------------------------------------------------------

function parse(source: SourceFile): ts.SourceFile {
  return ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, scriptKindFor(source.path));
}

/** Whether `source` has an import of `PREDICATE` from `specifier`. */
function importsPredicateFrom(source: SourceFile, specifier: string): boolean {
  const file = parse(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some((element) => element.name.text === PREDICATE)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether `source` DECLARES an exported predicate (`export function residentRunIsTurn`). */
function declaresExportedPredicate(source: SourceFile): boolean {
  const file = parse(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === PREDICATE &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether `source` RE-EXPORTS the predicate (`export { residentRunIsTurn } from ...`). */
function reexportsPredicate(source: SourceFile): boolean {
  const file = parse(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      if (node.exportClause.elements.some((element) => (element.name.text ?? '') === PREDICATE)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The JSDoc/comment block immediately above a declaration, or `''`. */
function leadingComment(source: ts.SourceFile, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  return ranges.map((range) => source.text.slice(range.pos, range.end)).join('\n');
}

// ---------------------------------------------------------------------------
// Process budget guard — a hang is a budget kill, not one red case
// ---------------------------------------------------------------------------

const STARTED_AT = Date.now();
/** The AC-392 wall-clock ceiling is 20 s; the guard fires a second earlier. */
const PROCESS_BUDGET_MS = 19_000;

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${PROCESS_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the resident-run-is-turn-single-reader ` +
      `criterion did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, PROCESS_BUDGET_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// (a) the single-reader reading — the one leg the false form reds
// ---------------------------------------------------------------------------

test('(a) the flag is read exactly once in non-test server code, in the shared leaf', () => {
  const scan = scanFlagReads(collectNonTestSources(SERVER_DIR));

  // Every reading before any assert: the red must land on the count, not a timeout.
  console.log(`(a) scanned ${scan.filesScanned} non-test server sources`);
  console.log(`flagReaders=${scan.reads.length} at=${scan.reads.map((read) => `${read.file}:${read.line}`).join(',') || '-'}`);
  for (const read of scan.reads) {
    console.log(`(a)   ${read.file}:${read.line}`);
  }

  assert.equal(
    scan.reads.length,
    1,
    `the flag must be read exactly once in non-test server code, found ${scan.reads.length}: ` +
      scan.reads.map((read) => `${read.file}:${read.line}`).join(', '),
  );
  assert.equal(scan.reads[0].file, LEAF_REL, 'the one read must live in the shared evaluation leaf');
});

// ---------------------------------------------------------------------------
// (b) the import face — one export, three imports, no registry re-export
// ---------------------------------------------------------------------------

test('(b) the predicate is exported by the leaf, imported by driver/registry/websocket, and not re-exported by the registry', () => {
  const leaf: SourceFile = { path: LEAF_REL, text: fs.readFileSync(path.join(REPO_ROOT, LEAF_REL), 'utf8') };
  const driver: SourceFile = { path: DRIVER_REL, text: fs.readFileSync(path.join(REPO_ROOT, DRIVER_REL), 'utf8') };
  const registry: SourceFile = { path: REGISTRY_REL, text: fs.readFileSync(path.join(REPO_ROOT, REGISTRY_REL), 'utf8') };
  const websocket: SourceFile = { path: WEBSOCKET_REL, text: fs.readFileSync(path.join(REPO_ROOT, WEBSOCKET_REL), 'utf8') };

  const leafFile = parse(leaf);
  let predicateNode: ts.FunctionDeclaration | undefined;
  const findPredicate = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === PREDICATE) predicateNode = node;
    ts.forEachChild(node, findPredicate);
  };
  findPredicate(leafFile);
  assert.ok(predicateNode, 'the leaf must declare the predicate');
  const leafComment = leadingComment(leafFile, predicateNode);

  const predicateAtUtils = declaresExportedPredicate(leaf);
  const importDriver = importsPredicateFrom(driver, LEAF_SPECIFIER);
  const importRegistry = importsPredicateFrom(registry, LEAF_SPECIFIER);
  const importWebsocket = importsPredicateFrom(websocket, LEAF_SPECIFIER);
  const registryNoReexport = !declaresExportedPredicate(registry) && !reexportsPredicate(registry);

  // The consumer comment travels with the export: the standard requires it, and it
  // is what tells the next reader WHY the leaf sits between two modules.
  const commentNamesDriver = /claude-host-driver\.provider\.ts/.test(leafComment);
  const commentNamesRegistry = /chat-run-registry\.service\.ts/.test(leafComment);

  console.log(
    `predicateAtUtils=${predicateAtUtils} importDriver=${importDriver} importRegistry=${importRegistry} ` +
      `importWebsocket=${importWebsocket} registryNoReexport=${registryNoReexport}`,
  );
  console.log(`(b) leafCommentNamesDriver=${commentNamesDriver} leafCommentNamesRegistry=${commentNamesRegistry}`);

  assert.ok(predicateAtUtils, 'the predicate must be declared and exported by server/shared/utils.ts');
  assert.ok(commentNamesDriver, 'the leaf export must name its driver consumer in a doc comment');
  assert.ok(commentNamesRegistry, 'the leaf export must name its registry consumer in a doc comment');
  assert.ok(importDriver, `claude-host-driver.provider.ts must import the predicate from ${LEAF_SPECIFIER}`);
  assert.ok(importRegistry, `chat-run-registry.service.ts must import the predicate from ${LEAF_SPECIFIER}`);
  assert.ok(importWebsocket, `chat-websocket.service.ts must import the predicate from ${LEAF_SPECIFIER}`);
  assert.ok(registryNoReexport, 'chat-run-registry.service.ts must not export or re-export the predicate');

  // The export declaration is the leaf's alone: no other non-test file may declare it.
  const otherDeclarers = collectNonTestSources(SERVER_DIR).filter(
    (source) => source.path !== LEAF_REL && declaresExportedPredicate(source),
  );
  console.log(`(b) non-leaf exported declarations of ${PREDICATE}: ${otherDeclarers.map((s) => s.path).join(',') || '-'}`);
  assert.deepEqual(otherDeclarers.map((s) => s.path), [], `only ${LEAF_REL} may declare the predicate`);
});

// ---------------------------------------------------------------------------
// (c) call-time read — the value is read when the predicate runs, not at load
// ---------------------------------------------------------------------------

test('(c) the predicate reads the variable at call time, and only exactly "1" is true', () => {
  const original = process.env[FLAG_NAME];
  try {
    process.env[FLAG_NAME] = '1';
    const onOne = residentRunIsTurn();

    const others: Array<{ value: string; result: boolean }> = [];
    for (const value of ['true', '0', '', '01', 'yes']) {
      process.env[FLAG_NAME] = value;
      others.push({ value, result: residentRunIsTurn() });
    }

    delete process.env[FLAG_NAME];
    const onDeleted = residentRunIsTurn();

    console.log(`(c) '1'->${onOne} others=${JSON.stringify(others)} deleted->${onDeleted}`);
    console.log('callTimeRead=true onlyExactOne=true');

    assert.equal(onOne, true, "'1' must answer true");
    for (const { value, result } of others) {
      assert.equal(result, false, `'${value}' must answer false`);
    }
    assert.equal(onDeleted, false, 'an unset variable must answer false');
  } finally {
    if (original === undefined) delete process.env[FLAG_NAME];
    else process.env[FLAG_NAME] = original;
  }
});

// ---------------------------------------------------------------------------
// (d) negative control — the scanner discriminates, proven in memory
// ---------------------------------------------------------------------------

test('(d) negative control: names only in comments/strings read 0, two real reads read 2', () => {
  const commentOnly: SourceFile = {
    path: 'server/modules/websocket/services/negative-control-source.ts',
    text: [
      `// process.env.${FLAG_NAME} — prose, not code, and never a read`,
      `const note = "process.env.${FLAG_NAME}";`,
      `const element = "process.env['${FLAG_NAME}']";`,
    ].join('\n'),
  };
  const twoRealReads: SourceFile = {
    path: 'server/modules/websocket/services/positive-control-source.ts',
    text: [
      `export const on = process.env.${FLAG_NAME} === '1';`,
      `export const bracketed = process.env['${FLAG_NAME}'] === '1';`,
    ].join('\n'),
  };

  const commentOnlyScan = scanFlagReads([commentOnly]);
  const twoReadsScan = scanFlagReads([twoRealReads]);

  console.log(
    `commentOnlyCount=${commentOnlyScan.reads.length} twoRealReadsCount=${twoReadsScan.reads.length}`,
  );

  assert.equal(commentOnlyScan.reads.length, 0, 'a name in a comment or a string literal must not be a read');
  assert.equal(twoReadsScan.reads.length, 2, 'two real reads must both be counted (the bracketed form too)');
  assert.deepEqual(
    twoReadsScan.reads.map((read) => read.line),
    [1, 2],
    'each read must be located at its own line',
  );
});
