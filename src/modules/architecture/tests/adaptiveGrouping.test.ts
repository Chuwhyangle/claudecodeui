import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  computeAdaptiveGrouping,
  directoryPathOf,
  OVERVIEW_GROUP_LIMIT,
  scopeRelativePath,
} from '@/modules/architecture/adaptiveGrouping';

/**
 * The overview's adaptive directory grouping.
 *
 * The regression this pins: the renderer's fixed-depth `groupByPathPrefix`
 * counted the FILE name as a path layer, so a flat directory of hundreds of
 * files produced one group per file (`grp::scripts/anti-drift-touches-check.ts`).
 * These criteria exercise the directory-only rule directly: a leaf directory is
 * one group with a count, the chosen depth never exceeds the group bound, and no
 * directory-derived group name can end in a source-file extension.
 */

/** Source extensions whose appearance at the END of a group name would mean a file became a group. */
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|py|go|rs|java|kt)$/;

/** The quay session's shape: one flat directory holding every script. */
function flatScripts(count = 230): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `src/scripts/tool-${String(index).padStart(3, '0')}.ts`,
  );
}

/**
 * A claudecodeui-shaped tree: 12 packages, 4 units each, 5 files per unit.
 * Three directory layers, so depth 3 would produce 48 groups — above the bound.
 */
function deepTree(): string[] {
  const ids: string[] = [];
  for (let moduleIndex = 0; moduleIndex < 12; moduleIndex += 1) {
    for (let unitIndex = 0; unitIndex < 4; unitIndex += 1) {
      for (let fileIndex = 0; fileIndex < 5; fileIndex += 1) {
        ids.push(`src/modules/mod-${String(moduleIndex)}/unit-${String(unitIndex)}/file-${String(fileIndex)}.ts`);
      }
    }
  }
  return ids;
}

test('a flat directory of 230 files collapses to one group with the right count', () => {
  const ids = flatScripts(230);
  const grouping = computeAdaptiveGrouping(ids);

  assert.equal(grouping.depth, 1, 'one directory layer is all the flat tree has');
  assert.equal(grouping.groups.length, 1, 'scripts/ is a single group, never one group per file');
  const [scripts] = grouping.groups;
  assert.ok(scripts !== undefined);
  assert.equal(scripts.prefix, 'scripts', 'the group name is the DIRECTORY');
  assert.equal(scripts.count, 230, 'the label count is the number of files in the directory');
  assert.equal(scripts.nodeIds.length, 230);
  assert.deepEqual(grouping.ungroupedNodeIds, [], 'every node is inside scripts/');
});

test('a deep tree stays within the group bound and is no coarser than the old depth 2', () => {
  const ids = deepTree();
  const grouping = computeAdaptiveGrouping(ids);

  assert.ok(
    grouping.groups.length <= OVERVIEW_GROUP_LIMIT,
    `the overview must stay at or below ${String(OVERVIEW_GROUP_LIMIT)} groups; got ${String(grouping.groups.length)}`,
  );
  // Old rule: first two display-name segments (`modules/mod-N`) → 12 groups.
  const oldDepthTwoGroups = new Set(ids.map((id) => id.split('/').slice(1, 3).join('/')));
  assert.ok(
    grouping.groups.length <= oldDepthTwoGroups.size,
    'the adaptive rule must not produce MORE groups than the old fixed depth 2',
  );
  assert.ok(grouping.depth >= 2, 'it still reaches at least the two directory layers depth 2 reached');
  // Depth 3 would be 48 groups (12 × 4) — over the bound — so depth 2 wins.
  assert.equal(grouping.depth, 2);
  assert.equal(grouping.groups.length, 12);
  for (const group of grouping.groups) assert.equal(group.count, 20, 'each package holds 4 units × 5 files');
});

test('the group bound actually selects a coarser depth instead of overshooting', () => {
  const ids = deepTree();

  const tight = computeAdaptiveGrouping(ids, { maxGroups: 10 });
  assert.ok(tight.depth < 2, 'depth 2 would be 12 groups, so a bound of 10 must fall back');
  assert.equal(tight.depth, 1);
  assert.equal(tight.groups.length, 1, 'the first directory layer has a single package');
  assert.ok(tight.groups.length <= 10);

  const exact = computeAdaptiveGrouping(ids, { maxGroups: 12 });
  assert.equal(exact.depth, 2, 'a bound that exactly fits keeps the deeper, more specific grouping');
  assert.equal(exact.groups.length, 12);
});

test('no directory-derived group name ends in a file extension', () => {
  const groupings = [
    computeAdaptiveGrouping(flatScripts()),
    computeAdaptiveGrouping(deepTree()),
    computeAdaptiveGrouping(
      [
        ...flatScripts(45),
        'src/scripts/release/pack.ts',
        'src/scripts/release/sign.ts',
        'src/scripts/systemd/install.ts',
      ],
      { prefix: 'scripts', groupDirectNodes: true },
    ),
  ];

  for (const grouping of groupings) {
    for (const group of grouping.groups) {
      assert.doesNotMatch(
        group.prefix,
        SOURCE_EXTENSION,
        `group "${group.prefix}" must be a directory, not a file name`,
      );
    }
  }
});

test('a group view re-groups its subtree: subdirectories stay groups, direct files share the prefix group', () => {
  const ids = [
    ...flatScripts(45),
    'src/scripts/release/pack.ts',
    'src/scripts/release/sign.ts',
    'src/scripts/systemd/install.ts',
  ];
  const grouping = computeAdaptiveGrouping(ids, { prefix: 'scripts', groupDirectNodes: true });

  assert.deepEqual(
    grouping.groups.map((group) => [group.prefix, group.count]),
    [
      ['scripts', 45],
      ['scripts/release', 2],
      ['scripts/systemd', 1],
    ],
    'expanding scripts shows its subdirectories as groups instead of 48 flat files',
  );
  assert.deepEqual(grouping.ungroupedNodeIds, [], 'the direct files belong to the expanded directory');
});

test('a flat leaf directory stays one group even when it is the group view itself', () => {
  const grouping = computeAdaptiveGrouping(flatScripts(230), {
    prefix: 'scripts',
    groupDirectNodes: true,
  });

  assert.equal(grouping.depth, 0, 'there is no deeper directory to group');
  assert.equal(grouping.groups.length, 1);
  assert.equal(grouping.groups[0]?.prefix, 'scripts');
  assert.equal(grouping.groups[0]?.count, 230);
});

test('scope-root files stay outside the grouping and keep their own entity id', () => {
  const grouping = computeAdaptiveGrouping(['src/App.tsx', 'src/scripts/a.ts', 'src/scripts/b.ts']);

  assert.deepEqual(grouping.ungroupedNodeIds, ['src/App.tsx']);
  assert.deepEqual(
    grouping.groups.map((group) => [group.prefix, group.count]),
    [['scripts', 2]],
  );
});

test('the path helpers strip the scope key and expose the DIRECTORY, never the file', () => {
  assert.equal(scopeRelativePath('src/modules/chat/Chat.ts.Chat'), 'modules/chat/Chat.ts.Chat');
  assert.equal(directoryPathOf('src/modules/chat/Chat.ts.Chat'), 'modules/chat');
  assert.equal(directoryPathOf('src/scripts/anti-drift-touches-check.ts'), 'scripts');
  assert.equal(directoryPathOf('src/App.tsx'), '', 'a scope-root file has no directory');
});
