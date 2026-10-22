import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  archguardAliasMap,
  archguardToPlantUml,
  displayName,
} from '@/modules/architecture/archguardToPlantUml';
import type { ArchitectureNeighborhood } from '@/modules/architecture/useArchitectureGraph';

/**
 * The bridge's package emission.
 *
 * The canvas keeps one layout and switches hierarchy levels, so the PlantUML
 * document must carry each entity's directory as a nested `package` block —
 * that is what the renderer turns into `data-package-id` for the frontend
 * hierarchy index. Aliasing must stay independent of the grouping: filtering
 * a view may change WHICH classes are drawn, never the id→alias map.
 */

/** Four nodes across three depths plus one file with no directory at all. */
const GRAPH: ArchitectureNeighborhood = {
  nodes: [
    { id: 'src/modules/chat/Chat.ts.Chat', label: 'Chat', distance: 0 },
    { id: 'src/modules/chat/hooks/useChat.ts.useChat', label: 'useChat', distance: 1 },
    { id: 'src/a/b/c/d/Deep.ts.Deep', label: 'Deep', distance: 2 },
    { id: 'App.tsx.App', label: 'App', distance: 3 },
  ],
  edges: [
    { from: 'src/modules/chat/hooks/useChat.ts.useChat', to: 'src/modules/chat/Chat.ts.Chat', relationType: 'dependency' },
    { from: 'src/a/b/c/d/Deep.ts.Deep', to: 'App.tsx.App', relationType: 'call' },
  ],
};

test('directories become nested package blocks; a directory-less entity stays unwrapped', () => {
  const { puml } = archguardToPlantUml(GRAPH);

  // `src/` is the scope key the bridge strips, so the hierarchy starts at
  // `modules`. Nesting is by the FULL path (`modules` → `modules/chat`), and
  // every level is spelled out so a leaf name cannot collide.
  assert.match(puml, /^@startuml\n/, 'a complete document');
  assert.match(puml, /^class "App\.tsx\.App" as n3$/m, 'a node with no directory is not wrapped in a package');
  assert.match(puml, /^package "modules" \{$/m, 'the first directory level is a package');
  assert.match(puml, /^  package "modules\/chat" \{$/m, 'its subdirectory is a NESTED package');
  assert.match(puml, /^    package "modules\/chat\/hooks" \{$/m, 'and so is the deepest directory');
  assert.match(puml, /^package "a" \{$/m);
  assert.match(puml, /^  package "a\/b" \{$/m);
  assert.match(puml, /^    package "a\/b\/c" \{$/m);
  assert.match(puml, /^      package "a\/b\/c\/d" \{$/m, 'the full ancestor chain is emitted');

  // The class label keeps the front-truncated display name (3 directory
  // segments), while its package uses the untruncated path.
  assert.equal(displayName('src/a/b/c/d/Deep.ts.Deep'), 'b/c/d/Deep.ts.Deep');
  assert.match(puml, /^\s+class "b\/c\/d\/Deep\.ts\.Deep" as n2$/m, 'truncation affects the label, not the package path');

  // Nesting is real: the deep class sits inside all four frames, the chat class
  // two levels down. A flat emission would still match the names above, so the
  // closing/opening order is what proves the tree.
  const modulesStart = puml.indexOf('package "modules" {');
  const chatStart = puml.indexOf('package "modules/chat" {');
  const chatClass = puml.indexOf('class "modules/chat/Chat.ts.Chat" as n0');
  const chatClose = puml.indexOf('\n  }\n', chatStart);
  assert.ok(modulesStart >= 0 && modulesStart < chatStart, 'modules opens before modules/chat');
  assert.ok(chatStart < chatClass, 'the chat class is inside its package');
  assert.ok(chatClass < chatClose, 'and the package closes after it');

  assert.match(puml, /\nn1 \.\.> n0 : <<uses>>/, 'relations are emitted outside the packages');
  assert.match(puml, /\nn2 \.\.> n3 : <<call>>/, 'call edges keep their stereotype');
  assert.match(puml, /\n@enduml$/, 'the document is closed');
});

test('the alias map is byte-identical to the pre-grouping map and survives filtering', () => {
  const expected = archguardAliasMap(GRAPH.nodes);
  const full = archguardToPlantUml(GRAPH);

  assert.deepEqual([...full.aliasOf.entries()], [...expected.entries()], 'grouping must not change id → alias order');

  // A group view draws a filtered subset but reuses the SAME map, so the
  // aliases other views printed stay valid.
  const group = archguardToPlantUml(GRAPH, { view: { kind: 'group', prefix: 'modules/chat' }, aliasOf: expected });
  assert.equal(group.aliasOf, expected, 'the caller-supplied map is reused, not rebuilt');
  assert.deepEqual(group.nodeIds, [
    'src/modules/chat/Chat.ts.Chat',
    'src/modules/chat/hooks/useChat.ts.useChat',
  ]);
  assert.match(group.puml, /package "modules" \{/);
  assert.match(group.puml, /package "modules\/chat" \{/);
  assert.doesNotMatch(group.puml, /Deep\.ts\.Deep|App\.tsx\.App/, 'only the group’s classes are drawn');
});

test('the neighbourhood view keeps the full graph and centers the requested entity', () => {
  const aliasOf = archguardAliasMap(GRAPH.nodes);
  const centered = archguardToPlantUml(GRAPH, {
    view: { kind: 'neighborhood', entityId: 'src/modules/chat/Chat.ts.Chat', hops: 1 },
    aliasOf,
  });

  assert.equal(centered.nodeIds.length, GRAPH.nodes.length, 'the neighbourhood view drawing is expanded by the renderer, not the bridge');
  assert.equal(centered.rendererEntity, 'n0', 'the renderer centers on the entity’s stable alias');
  assert.equal(centered.rendererEntity, aliasOf.get('src/modules/chat/Chat.ts.Chat'));
  assert.match(centered.puml, /package "a\/b\/c\/d" \{/, 'packages are still emitted for every drawn node');
});

/**
 * A real-shape FILE graph: project-relative ids sitting directly inside one
 * directory. One edge per adjacent pair, so a fold that swallowed a pair would
 * show up as a missing arrow.
 */
function leafDirectoryGraph(directory: string, count: number): ArchitectureNeighborhood {
  const nodes = Array.from({ length: count }, (_unused, index) => {
    const name = `file-${String(index).padStart(3, '0')}.ts`;
    return { id: `${directory}/${name}`, label: name, distance: index % 5 };
  });
  const edges = nodes.slice(1).map((node, index) => ({
    from: node.id,
    to: nodes[index]!.id,
    relationType: 'dependency',
  }));
  return { nodes, edges };
}

test('expanding a 229-file leaf directory draws its files, never the same group box again', () => {
  const graph = leafDirectoryGraph('plugin/scripts', 229);
  const { grouped, nodeIds, puml } = archguardToPlantUml(graph, {
    view: { kind: 'group', prefix: 'plugin/scripts' },
    grouping: 'adaptive',
    idShape: 'project-relative',
  });

  // The view prefix is the directory itself: a `grp::plugin/scripts` box would
  // navigate back to this same view, so the members MUST be entities — the
  // overview's 40-group bound does not apply to an explicit expansion.
  assert.equal(grouped, false, 'the expansion is an entity drawing, not directory scaffolding');
  assert.equal(nodeIds.length, 229, 'every file of the leaf directory is drawn');
  assert.equal((puml.match(/^\s*class "/gm) ?? []).length, 229, 'one class line per file');
  assert.doesNotMatch(puml, /grp::/, 'no group node survives into the document');
  assert.doesNotMatch(puml, /plugin\/scripts \(229\)/, 'the source group label is gone');

  // Folding must not swallow edges: the entity path emits every pair.
  assert.equal(
    (puml.match(/\n\S+ \.\.> \S+ : <<uses>>/g) ?? []).length,
    graph.edges.length,
    'every edge is drawn between the concrete files',
  );
  assert.match(puml, /class "plugin\/scripts\/file-000\.ts" as n0/, 'a file keeps its full path label');
});

test('expanding a directory with subdirectories keeps them as boxes and flattens its direct files', () => {
  const direct = Array.from({ length: 55 }, (_unused, index) => {
    const name = `file-${String(index).padStart(3, '0')}.ts`;
    return { id: `packages/app/${name}`, label: name, distance: 0 };
  });
  const internal = Array.from({ length: 2 }, (_unused, index) => {
    const name = `inner-${String(index)}.ts`;
    return { id: `packages/app/internal/${name}`, label: name, distance: 1 };
  });
  const solo = { id: 'packages/app/solo/only.ts', label: 'only.ts', distance: 1 };
  const nodes = [...direct, ...internal, solo];
  const graph: ArchitectureNeighborhood = {
    nodes,
    edges: [
      // A flattened direct file points into a subdirectory GROUP box.
      { from: direct[0]!.id, to: internal[0]!.id, relationType: 'dependency' },
      // The single-member directory's sole file keeps its own alias.
      { from: solo.id, to: direct[1]!.id, relationType: 'dependency' },
    ],
  };

  const { grouped, nodeIds, puml } = archguardToPlantUml(graph, {
    view: { kind: 'group', prefix: 'packages/app' },
    grouping: 'adaptive',
    idShape: 'project-relative',
  });

  assert.equal(grouped, true, 'the subdirectory layer is still scaffolding');
  assert.ok(nodeIds.includes('grp::packages/app/internal'), 'the subdirectory keeps its box');
  assert.ok(!nodeIds.includes('grp::packages/app'), 'the view-prefix group box is gone');
  assert.match(puml, /class "packages\/app\/internal \(2\)" as g0/, 'the subdirectory box carries its count');
  assert.doesNotMatch(puml, /class "packages\/app \(\d+\)"/, 'no class carries the source group label');

  // The 55 direct files are entities, in the neighbourhood's own order.
  assert.equal((puml.match(/class "packages\/app\/file-\d{3}\.ts"/g) ?? []).length, 55);
  assert.match(puml, /class "packages\/app\/file-000\.ts" as n0/);

  // Single-member directories still fold to their file (the `count < 2` rule),
  // never to a `(1)` box.
  assert.match(puml, /class "packages\/app\/solo\/only\.ts" as n57/);
  assert.doesNotMatch(puml, /\(1\)/);

  // Edges re-land on the concrete endpoints: flattened file → group box, and
  // entity → entity for the folded singleton.
  assert.match(puml, /n0 \.\.> g0 : <<uses>>/, 'a flattened file keeps its edge onto the subdirectory box');
  assert.match(puml, /n57 \.\.> n1 : <<uses>>/, 'a folded singleton keeps its own alias');
});

test('an empty graph is still a complete, package-free document', () => {
  const empty = archguardToPlantUml({ nodes: [], edges: [] });

  assert.equal(empty.puml, '@startuml\n@enduml');
  assert.equal(empty.rendererEntity, null);
  assert.deepEqual(empty.nodeIds, []);
});

/**
 * A real-shape ENTITY graph: the nodes carry the server's `kind`/`members`
 * detail (mirrored from the backend's `EntityKind`/`EntityMember`, see
 * `server/modules/architecture/generator.ts`). The class members deliberately
 * cover all four visibility keywords the backend passes through.
 */
const ENTITY_DETAIL_GRAPH: ArchitectureNeighborhood = {
  nodes: [
    {
      id: 'src/modules/rolling/rolling-slope-check.ts.haltVerdict',
      label: 'haltVerdict',
      distance: 0,
      kind: 'function',
    },
    {
      id: 'src/modules/rolling/rolling-slope-check.ts.RollingCheck',
      label: 'RollingCheck',
      distance: 1,
      kind: 'class',
      members: [
        { name: 'threshold', kind: 'field', visibility: 'private', signature: 'number' },
        { name: 'slope', kind: 'field', visibility: 'protected', signature: 'number' },
        { name: 'packages', kind: 'field', visibility: 'package-private', signature: 'string[]' },
        { name: 'haltVerdict', kind: 'method', visibility: 'public', signature: 'haltVerdict(input: number): boolean' },
      ],
    },
    {
      id: 'src/modules/rolling/ports.ts.SlopeReader',
      label: 'SlopeReader',
      distance: 2,
      kind: 'interface',
      members: [
        { name: 'read', kind: 'method', visibility: 'public', signature: 'read(): number' },
      ],
    },
    {
      id: 'src/modules/rolling/kinds.ts.Level',
      label: 'Level',
      distance: 2,
      kind: 'enum',
      members: [],
    },
    {
      id: 'src/modules/rolling/base.ts.Base',
      label: 'Base',
      distance: 3,
      kind: 'abstract',
      members: [],
    },
  ],
  edges: [
    { from: 'src/modules/rolling/rolling-slope-check.ts.RollingCheck', to: 'src/modules/rolling/rolling-slope-check.ts.haltVerdict', relationType: 'call' },
    { from: 'src/modules/rolling/rolling-slope-check.ts.RollingCheck', to: 'src/modules/rolling/ports.ts.SlopeReader', relationType: 'implementation' },
  ],
};

test('entity kind and members draw a UML class box: compartments, visibility, stereotypes', () => {
  const { puml } = archguardToPlantUml(ENTITY_DETAIL_GRAPH);

  // The box label is the ENTITY name; the file it lives in moved to the
  // package frame (and the renderer's hover title), never into the label.
  assert.doesNotMatch(puml, /rolling-slope-check\.ts\.haltVerdict/, 'the label must not carry the file name');
  assert.match(puml, /^\s+class "<<function>> haltVerdict" as n0$/m, 'a function is a single-compartment box');
  assert.doesNotMatch(puml, /class "<<function>> haltVerdict" as n0 \{/, 'a function never gets a member compartment');

  assert.match(puml, /^\s+class "RollingCheck" as n1 \{$/m, 'a class opens a member compartment');
  assert.match(puml, /^\s+- threshold: number$/m, 'a private field keeps its `-` symbol and declared type');
  assert.match(puml, /^\s+# slope: number$/m, 'a protected field keeps its `#` symbol');
  assert.match(puml, /^\s+~ packages: string\[\]$/m, 'a package-private field keeps its `~` symbol');
  assert.match(puml, /^\s+\+ haltVerdict\(input: number\): boolean$/m, 'a method keeps its `+` symbol and signature');

  assert.match(puml, /^\s+interface "<<interface>> SlopeReader" as n2 \{$/m, 'an interface is declared as interface and carries the stereotype');
  assert.match(puml, /^\s+\+ read\(\): number$/m, 'an interface method is a member row');

  assert.match(puml, /^\s+enum "Level" as n3$/m, 'an enum uses the parser’s enum kind');
  assert.match(puml, /^\s+abstract class "Base" as n4$/m, 'an abstract class uses the parser’s abstract kind');

  // Fields are drawn before methods, which is the only field/method separation
  // this renderer's single body compartment offers.
  const fieldIndex = puml.indexOf('- threshold: number');
  const methodIndex = puml.indexOf('+ haltVerdict(input: number): boolean');
  assert.ok(fieldIndex >= 0 && fieldIndex < methodIndex, 'fields precede methods inside the box');

  // The panel draws the ADAPTIVE path; expanding a leaf directory must yield the
  // same UML shapes as the raw bridge contract.
  const adaptive = archguardToPlantUml(ENTITY_DETAIL_GRAPH, {
    view: { kind: 'group', prefix: 'modules/rolling' },
    grouping: 'adaptive',
  });
  assert.match(adaptive.puml, /class "<<function>> haltVerdict" as n0/, 'adaptive path keeps the function stereotype');
  assert.match(adaptive.puml, /interface "<<interface>> SlopeReader"/, 'and the interface declaration');
  assert.match(adaptive.puml, /- threshold: number/, 'and the member rows');
});

test('two same-named entities in one package fall back to a file-qualified label', () => {
  const graph: ArchitectureNeighborhood = {
    nodes: [
      { id: 'src/a/Reader.ts.Reader', label: 'Reader', distance: 0, kind: 'interface' },
      { id: 'src/a/Ports.ts.Reader', label: 'Reader', distance: 1, kind: 'interface' },
    ],
    edges: [],
  };

  const { puml } = archguardToPlantUml(graph);

  assert.match(puml, /^\s+interface "<<interface>> Reader\.ts\.Reader" as n0$/m, 'the collision falls back to file + entity');
  assert.match(puml, /^\s+interface "<<interface>> Ports\.ts\.Reader" as n1$/m, 'and the other one is distinguishable');
  assert.doesNotMatch(puml, /<<interface>> Reader"/, 'no two boxes share the bare label');
});

test('a truncated member list ends with the documented … +N marker line', () => {
  const full = archguardToPlantUml(ENTITY_DETAIL_GRAPH);
  assert.doesNotMatch(full.puml, /… \+N/, 'the marker is absent unless the reading reports truncation');

  const truncated = archguardToPlantUml(ENTITY_DETAIL_GRAPH, { membersTruncated: true });
  assert.match(truncated.puml, /^\s+\+ … \+N$/m, 'the marked node ends with the truncation row');
  // Only boxes that actually draw members get the marker: a function is one
  // compartment and an empty class body has nothing to truncate. The flag is
  // reading-level, so both member-bearing boxes are marked — never an invented
  // per-node count.
  assert.equal(
    (truncated.puml.match(/… \+N/g) ?? []).length,
    2,
    'the class and the interface each end with one marker',
  );
});

test('a node without `kind` keeps the byte-identical legacy document', () => {
  // The pre-detail bridge output, spelled out: this is the contract that a
  // payload written before `kind`/`members` existed must not visibly change.
  const legacy: ArchitectureNeighborhood = {
    nodes: [
      { id: 'src/a/F.ts.Foo', label: 'Foo', distance: 0 },
      { id: 'src/b/G.ts.Bar', label: 'Bar', distance: 1 },
    ],
    edges: [{ from: 'src/a/F.ts.Foo', to: 'src/b/G.ts.Bar', relationType: 'call' }],
  };

  assert.equal(
    archguardToPlantUml(legacy).puml,
    [
      '@startuml',
      'package "a" {',
      '  class "a/F.ts.Foo" as n0',
      '}',
      'package "b" {',
      '  class "b/G.ts.Bar" as n1',
      '}',
      'n0 ..> n1 : <<call>>',
      '@enduml',
    ].join('\n'),
  );
});
