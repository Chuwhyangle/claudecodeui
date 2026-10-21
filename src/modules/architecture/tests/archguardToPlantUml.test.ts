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

test('an empty graph is still a complete, package-free document', () => {
  const empty = archguardToPlantUml({ nodes: [], edges: [] });

  assert.equal(empty.puml, '@startuml\n@enduml');
  assert.equal(empty.rendererEntity, null);
  assert.deepEqual(empty.nodeIds, []);
});
