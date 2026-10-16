/**
 * The directory-level import-graph scanner for `server/` — the measuring core
 * AC-394's budget ratchet and AC-396's leaf assertion both read the tree with.
 *
 * It was inline in `server/shared/tests/server-import-cycle-budget.test.ts`
 * until AC-396 needed the same reading for a different question ("is
 * `modules/resident-ledger` a leaf?"). Copying it would have made two scanners
 * that can drift apart, which is exactly the duplicate-mechanism AC-396 (b)
 * forbids; so the scanning core moved here and AC-394's criterion imports it.
 *
 * Every reading comes from the TypeScript SYNTAX TREE (`ts.createSourceFile`),
 * never from grepped text: a comment mentioning `@/modules/...` produces no node
 * at all, so "this directory has zero module imports" is a reading of code, not
 * of prose.
 *
 * Scope: every non-test `.ts`/`.tsx` under a server root — `*.test.*`/`*.spec.*`
 * dropped by filename and every `tests/` directory pruned. Static `import` /
 * `export … from` (including `import type`), plus LITERAL-specifier dynamic
 * `import()`. A specifier is internal when it is `@/*` (→ `server/*`, per
 * `server/tsconfig.json`) or relative; it RESOLVES when the target is one of
 * those scanned files. A node is the directory that holds the file; an edge is a
 * cross-directory import. Non-trivial SCCs come from Tarjan.
 *
 * Pure over its inputs: `scanImportGraph` takes the source set, so a synthetic
 * fixture and the real tree drive the same code, and `collectServerSources` takes
 * the root rather than closing over one.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

/** A source and its path RELATIVE TO the scan root (posix), plus the text itself. */
export type SourceFile = { path: string; text: string };

/** One directory-level edge, flagged with which import form produced it. */
export type DirEdge = { from: string; to: string; static: boolean; dynamic: boolean };

/** One located finding (`file` is relative to the scan root). */
export type Hit = { file: string; line: number; specifier: string };

/** One full scan. `staticFileEdges`/`dynamicFileEdges` are FILE-level resolved edge counts. */
export type Graph = {
  files: number;
  staticFileEdges: number;
  dynamicFileEdges: number;
  /** Every directory holding at least one scanned file, sorted. */
  nodes: string[];
  dirEdges: DirEdge[];
  /** Every SCC, size 1 included. */
  sccs: string[][];
  /** The size ≥ 2 SCCs, largest first. */
  nonTrivialSccs: string[][];
  unresolvedInternal: Hit[];
  nonLiteralDynamic: Hit[];
};

/** `.tsx` must be parsed as TSX; a `.ts` file cannot contain JSX. */
export function scriptKindFor(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** The scan-root-relative directory of a scan-root-relative file path; `'.'` at the root. */
export function dirOf(filePath: string): string {
  const directory = path.posix.dirname(filePath);
  return directory === '' ? '.' : directory;
}

/**
 * `shared/**` — the only external target a brand-new directory may import
 * (AC-394 (c)). Note this is the `server/shared` the scanner sees (paths are
 * relative to `server/`), NOT the repo-root `shared/`.
 */
export function isSharedDir(directory: string): boolean {
  return directory === 'shared' || directory.startsWith('shared/');
}

/** The three states a specifier can be in — `external` is not an unresolved internal one. */
export type Resolution = { kind: 'external' } | { kind: 'file'; path: string } | { kind: 'unresolved' };

/**
 * The candidate paths a specifier may resolve to, in order. A `.js` specifier is the
 * compiled-relative form TypeScript's `NodeNext` resolution demands, so `x.js` means `x.ts`
 * first; a directory resolves through its `index`. `present` decides which candidate is real
 * — that is what makes the real tree and a synthetic fixture share one resolver.
 */
export function resolutionCandidates(base: string): string[] {
  const candidates: string[] = [];
  for (const compiled of ['.js', '.mjs']) {
    if (base.endsWith(compiled)) {
      const stem = base.slice(0, -compiled.length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    }
  }
  candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`);
  return candidates;
}

/**
 * `@/x` → `x` (the `@/*` → `server/*` alias of `server/tsconfig.json`); `./x` / `../x`
 * resolved against the importing file's directory. Anything else (a Node builtin, an npm
 * package) is `external` and never counted. An internal specifier that lands outside the
 * scanned set — the repo-root `shared/`, or a `.js` file the `.ts`/`.tsx` scope excludes —
 * is `unresolved`.
 */
export function resolveSpecifier(specifier: string, fromPath: string, present: ReadonlySet<string>): Resolution {
  let base: string;
  if (specifier.startsWith('@/')) base = specifier.slice(2);
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = path.posix.normalize(path.posix.join(dirOf(fromPath), specifier));
  else return { kind: 'external' };

  if (base.startsWith('..')) return { kind: 'unresolved' };
  for (const candidate of resolutionCandidates(base)) {
    if (present.has(candidate)) return { kind: 'file', path: candidate };
  }
  return { kind: 'unresolved' };
}

/** Tarjan, iterative-so-bounded, over the directory adjacency; components sorted for a stable reading. */
export function strongComponents(nodes: readonly string[], adjacency: ReadonlyMap<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let next = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    // An explicit work list keeps the traversal off the JS call stack (a deep import chain is
    // exactly the shape this criterion is about, so recursion depth must not be the limit).
    const work: { node: string; childIndex: number }[] = [{ node: start, childIndex: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.childIndex === 0) {
        index.set(frame.node, next);
        low.set(frame.node, next);
        next += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }
      const children = adjacency.get(frame.node) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex];
        frame.childIndex += 1;
        if (!index.has(child)) work.push({ node: child, childIndex: 0 });
        else if (onStack.has(child)) low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(child) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        found.push(component.sort());
      }
    }
  }
  return found.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/**
 * Scans `sources` into the directory graph. `includeDynamic` selects between the two readings
 * AC (b) requires to agree: static-only, and static plus LITERAL dynamic `import()`. A
 * non-literal (`import(specifier)`) is recorded separately either way — it never becomes an
 * edge, because its target is unknowable statically.
 */
export function scanImportGraph(sources: readonly SourceFile[], options: { includeDynamic?: boolean } = {}): Graph {
  const includeDynamic = options.includeDynamic ?? true;
  const present = new Set(sources.map((source) => source.path));
  const filesWithSources = new Set<string>();
  const dirEdgeMap = new Map<string, DirEdge>();
  const unresolvedInternal: Hit[] = [];
  const nonLiteralDynamic: Hit[] = [];
  let staticFileEdges = 0;
  let dynamicFileEdges = 0;

  for (const source of sources) {
    const fromDir = dirOf(source.path);
    filesWithSources.add(fromDir);
    const sourceFile = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, false, scriptKindFor(source.path));
    const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    const resolve = (specifier: string, node: ts.Node, kind: 'static' | 'dynamic'): void => {
      if (kind === 'dynamic' && !includeDynamic) return;
      const resolution = resolveSpecifier(specifier, source.path, present);
      if (resolution.kind === 'external') return;
      if (resolution.kind === 'unresolved') {
        unresolvedInternal.push({ file: source.path, line: lineOf(node), specifier });
        return;
      }
      if (kind === 'static') staticFileEdges += 1;
      else dynamicFileEdges += 1;

      const toDir = dirOf(resolution.path);
      if (toDir === fromDir) return;
      const key = `${fromDir}\u0000${toDir}`;
      const edge = dirEdgeMap.get(key) ?? { from: fromDir, to: toDir, static: false, dynamic: false };
      if (kind === 'static') edge.static = true;
      else edge.dynamic = true;
      dirEdgeMap.set(key, edge);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        resolve(node.moduleSpecifier.text, node.moduleSpecifier, 'static');
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        resolve(node.moduleSpecifier.text, node.moduleSpecifier, 'static');
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) resolve(argument.text, argument, 'dynamic');
        else nonLiteralDynamic.push({ file: source.path, line: lineOf(node), specifier: argument ? argument.getText(sourceFile).slice(0, 80) : '<none>' });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  const nodes = [...filesWithSources].sort();
  const dirEdges = [...dirEdgeMap.values()];
  const adjacency = new Map<string, string[]>();
  for (const edge of dirEdges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const sccs = strongComponents(nodes, adjacency);

  return {
    files: sources.length,
    staticFileEdges,
    dynamicFileEdges,
    nodes,
    dirEdges,
    sccs,
    nonTrivialSccs: sccs.filter((component) => component.length >= 2),
    unresolvedInternal,
    nonLiteralDynamic,
  };
}

/**
 * Every non-test `.ts`/`.tsx` under `serverDir`, path relative to it as posix. `tests/`
 * directories are pruned and `*.test.*` / `*.spec.*` files dropped, so the graph is the
 * shipping backend, not its criteria. The root is a parameter (AC-396) so a criterion can
 * scan the same tree AC-394 budgeted without re-implementing the walk.
 */
export function collectServerSources(serverDir: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
        walk(path.join(directory, entry.name));
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      found.push({ path: path.relative(serverDir, absolute).split(path.sep).join('/'), text: fs.readFileSync(absolute, 'utf8') });
    }
  };
  walk(serverDir);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
