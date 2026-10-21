import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildHierarchyIndexFromSvg,
  ROOT_PACKAGE_ID,
  type ArchitectureHierarchyIndex,
} from '@/modules/architecture/hierarchyIndex';
import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';

/**
 * The frontend hierarchy index read from a drawn PlantUML SVG plus the
 * neighbourhood JSON it was drawn from.
 *
 * The diagram keeps one layout and reveals hierarchy levels, so the index must
 * answer three questions without touching geometry: which innermost package an
 * entity belongs to, what that package's ancestor chain is, and how many
 * entities are directly in it versus in its whole subtree. An entity the SVG
 * drew without `data-package-id` is a top-level class and belongs to the root.
 */

/** A fixture graph whose ids mirror the real `<scope>/src/...` shape. */
function graphOf(ids: readonly string[]): ArchitectureRendererGraph {
  return {
    nodes: ids.map((id, index) => ({ id, label: id, distance: index })),
    edges: [],
  };
}

/** Draw a fake renderer SVG: entities with an optional innermost package. */
function svgOf(
  nodes: readonly { id: string; packageId?: string; className?: string }[],
): HTMLElement {
  const host = document.createElement('div');
  const attribute = (name: string, value: string): string =>
    ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  host.innerHTML = `<svg>${nodes
    .map((node) => {
      const pkg = node.packageId === undefined ? '' : attribute('data-package-id', node.packageId);
      return `<g${attribute('data-entity-id', node.id)}${pkg} class="${node.className ?? 'uml-node'}"></g>`;
    })
    .join('')}</svg>`;
  return host;
}

function packageIds(index: ArchitectureHierarchyIndex): string[] {
  return [...index.packages.keys()].sort();
}

/**
 * Four entities in the tree plus one with no directory: `a` holds one directly,
 * `a/b` is an ancestor-only frame (all its files live in `a/b/c`), and the root
 * holds the path-less entity.
 */
const GRAPH = graphOf([
  'src/a/A.ts.A',
  'src/a/b/c/B.ts.B',
  'src/a/b/c/C.ts.C',
  'src/a/b/c/D.ts.D',
  'src/top.ts.Top',
]);

const SVG = svgOf([
  { id: 'src/a/A.ts.A', packageId: 'a' },
  { id: 'src/a/b/c/B.ts.B', packageId: 'a/b/c' },
  { id: 'src/a/b/c/C.ts.C', packageId: 'a/b/c' },
  { id: 'src/a/b/c/D.ts.D', packageId: 'a/b/c' },
  { id: 'src/top.ts.Top' },
]);

test('entities map to their innermost package and every package carries its ancestor chain', () => {
  const index = buildHierarchyIndexFromSvg(SVG, GRAPH);

  assert.equal(index.rootId, ROOT_PACKAGE_ID);
  assert.deepEqual(packageIds(index), ['', 'a', 'a/b', 'a/b/c'], 'the whole tree is materialised, root first');

  assert.deepEqual([...index.entityPackage.entries()], [
    ['src/a/A.ts.A', 'a'],
    ['src/a/b/c/B.ts.B', 'a/b/c'],
    ['src/a/b/c/C.ts.C', 'a/b/c'],
    ['src/a/b/c/D.ts.D', 'a/b/c'],
    ['src/top.ts.Top', ROOT_PACKAGE_ID],
  ], 'each entity is assigned the INNERMOST package the SVG names');

  const a = index.packages.get('a');
  const ab = index.packages.get('a/b');
  const abc = index.packages.get('a/b/c');
  assert.ok(a !== undefined && ab !== undefined && abc !== undefined);

  assert.equal(a.parentId, ROOT_PACKAGE_ID);
  assert.equal(ab.parentId, 'a');
  assert.equal(abc.parentId, 'a/b');
  assert.equal(index.packages.get(ROOT_PACKAGE_ID)?.parentId, null);

  // Ancestors are root-first and exclude the package itself; the root is a
  // package, so it is the first link of every other chain.
  assert.deepEqual(index.packages.get(ROOT_PACKAGE_ID)?.ancestors, []);
  assert.deepEqual(a.ancestors, [ROOT_PACKAGE_ID]);
  assert.deepEqual(ab.ancestors, [ROOT_PACKAGE_ID, 'a']);
  assert.deepEqual(abc.ancestors, [ROOT_PACKAGE_ID, 'a', 'a/b']);

  assert.equal(a.name, 'a');
  assert.equal(abc.name, 'c', 'the leaf segment names the package');
  assert.equal(index.packages.get(ROOT_PACKAGE_ID)?.name, '');
  assert.deepEqual(index.packages.get(ROOT_PACKAGE_ID)?.childPackageIds, ['a']);
  assert.deepEqual(a.childPackageIds, ['a/b']);
});

test('direct and descendant entity counts separate the package from its subtree', () => {
  const index = buildHierarchyIndexFromSvg(SVG, GRAPH);
  const count = (id: string): { direct: number; descendant: number } => {
    const pkg = index.packages.get(id);
    assert.ok(pkg !== undefined, `package ${JSON.stringify(id)} exists`);
    return { direct: pkg.directEntityCount, descendant: pkg.descendantEntityCount };
  };

  assert.deepEqual(count(''), { direct: 1, descendant: 5 }, 'the root counts the directory-less entity plus every package');
  assert.deepEqual(count('a'), { direct: 1, descendant: 4 }, 'a holds A directly and owns the three in a/b/c');
  assert.deepEqual(count('a/b'), { direct: 0, descendant: 3 }, 'an ancestor-only frame has descendants but no direct files');
  assert.deepEqual(count('a/b/c'), { direct: 3, descendant: 3 });

  assert.deepEqual(index.packages.get('a/b/c')?.entityIds, [
    'src/a/b/c/B.ts.B',
    'src/a/b/c/C.ts.C',
    'src/a/b/c/D.ts.D',
  ], 'direct entity ids in graph order');
  assert.deepEqual(index.packages.get('a/b')?.entityIds, [], 'no entity belongs DIRECTLY to the ancestor-only package');
});

test('a top-level entity without data-package-id (or absent from the SVG) lands in the root', () => {
  const graph = graphOf(['src/undrawn.ts.Undrawn', 'src/drawn.ts.Drawn']);
  const svg = svgOf([{ id: 'src/drawn.ts.Drawn', packageId: 'p/q' }]);

  const index = buildHierarchyIndexFromSvg(svg, graph);

  assert.equal(index.entityPackage.get('src/undrawn.ts.Undrawn'), ROOT_PACKAGE_ID, 'missing from the SVG ⇒ root');
  assert.equal(index.entityPackage.get('src/drawn.ts.Drawn'), 'p/q');
  assert.deepEqual(index.packages.get(ROOT_PACKAGE_ID)?.entityIds, ['src/undrawn.ts.Undrawn']);
  assert.deepEqual(packageIds(index), ['', 'p', 'p/q'], 'ancestors of a rendered package are synthesised');
  assert.deepEqual(index.packages.get('p')?.ancestors, [ROOT_PACKAGE_ID]);
  assert.deepEqual(index.packages.get('p/q')?.ancestors, [ROOT_PACKAGE_ID, 'p']);
});

test('view scaffolding in the SVG is ignored: only the neighbourhood JSON’s entities are counted', () => {
  const graph = graphOf(['src/a/A.ts.A']);
  const svg = svgOf([
    { id: 'grp::a', packageId: 'grp::a' },
    { id: 'stub::other', packageId: 'other' },
    { id: 'src/a/A.ts.A', packageId: 'a' },
  ]);

  const index = buildHierarchyIndexFromSvg(svg, graph);

  assert.equal(index.entityPackage.size, 1, 'group and stub nodes are not entities');
  assert.equal(index.entityPackage.get('src/a/A.ts.A'), 'a');
  assert.deepEqual(packageIds(index), ['', 'a'], 'their package ids do not leak into the tree');
  assert.equal(index.packages.get(ROOT_PACKAGE_ID)?.descendantEntityCount, 1);
});

test('an empty drawing yields just the root', () => {
  const index = buildHierarchyIndexFromSvg(svgOf([]), graphOf([]));
  const root = index.packages.get(ROOT_PACKAGE_ID);

  assert.ok(root !== undefined);
  assert.deepEqual(packageIds(index), ['']);
  assert.deepEqual(root.entityIds, []);
  assert.equal(root.directEntityCount, 0);
  assert.equal(root.descendantEntityCount, 0);
  assert.deepEqual(root.childPackageIds, []);
  assert.equal(index.entityPackage.size, 0);
});
