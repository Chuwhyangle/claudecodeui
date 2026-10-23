import assert from 'node:assert/strict';

import { applyView, checkSyntax, renderDetailed, toPlantUml } from '@yalehwang/plantuml-js';
import { test } from 'vitest';

import { archguardToPlantUml, parserSafePlantUml } from '@/modules/architecture/archguardToPlantUml';
import {
  PLANTUML_MEMBER_DETAIL,
  renderWithMemberDetail,
} from '@/modules/architecture/PlantUmlGraph';
import type { PlantUmlRenderDetailed } from '@/modules/architecture/graphDom';
import {
  buildFullPlantUmlDocument,
  buildPlantUmlDocument,
  buildPlantUmlText,
  measurePlantUmlText,
  NoSelectionScopeError,
  nodesIntersectingViewport,
  parsePlantUml,
  previewPlantUmlText,
  scopeSubgraph,
  standardiseDrawnStereotypes,
  TEXT_CHARS_PER_TOKEN,
  TEXT_HUGE_TOKEN_THRESHOLD,
  TEXT_LARGE_TOKEN_THRESHOLD,
  TEXT_PREVIEW_LINE_LIMIT,
  wrapSessionContext,
} from '@/modules/architecture/plantUmlText';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';

/**
 * The text page's pure core:
 *  · the three scopes each select the right subgraph (whole graph; the nodes
 *    intersecting the viewport; the selection plus one hop);
 *  · the `+1` scope with no selection is an explicit state, never an empty
 *    document;
 *  · the document is deterministic and always parses under plantuml-js's own
 *    `checkSyntax`;
 *  · the volume reading (characters / lines / 3.5-chars-per-token estimate) and
 *    its 8k / 30k bands, the 300-line preview, and the session-context fence.
 */

const ALPHA = 's1/src/modules/alpha/a.ts.Alpha';
const BETA = 's1/src/modules/alpha/b.ts.Beta';
const GAMMA = 's1/src/modules/beta/c.ts.Gamma';
const DELTA = 's1/src/modules/beta/d.ts.Delta';

/**
 * A chain alpha → beta → gamma → delta. The extra alpha → delta edge is what
 * makes "beta + 1 hop" a real cut: delta is two hops from beta even though it
 * touches alpha, so it must not survive the selection scope.
 */
const ENTITY_GRAPH: ArchitectureRendererGraph = {
  nodes: [
    { id: ALPHA, label: 'Alpha', distance: 0, kind: 'class' },
    { id: BETA, label: 'Beta', distance: 1, kind: 'class' },
    { id: GAMMA, label: 'Gamma', distance: 2, kind: 'interface' },
    { id: DELTA, label: 'Delta', distance: 3, kind: 'enum' },
  ],
  edges: [
    { from: ALPHA, to: BETA, relationType: 'dependency' },
    { from: BETA, to: GAMMA, relationType: 'call' },
    { from: GAMMA, to: DELTA, relationType: 'inheritance' },
    { from: ALPHA, to: DELTA, relationType: 'composition' },
  ],
};

/** The file graph: two directories, so the adaptive grouping has real groups. */
const FILE_GRAPH: ArchitectureRendererGraph = {
  nodes: [
    { id: 'src/modules/alpha/a.ts', label: 'src/modules/alpha/a.ts', distance: 0 },
    { id: 'src/modules/alpha/a2.ts', label: 'src/modules/alpha/a2.ts', distance: 1 },
    { id: 'src/modules/beta/b.ts', label: 'src/modules/beta/b.ts', distance: 2 },
    { id: 'src/modules/beta/b2.ts', label: 'src/modules/beta/b2.ts', distance: 3 },
  ],
  edges: [
    { from: 'src/modules/alpha/a2.ts', to: 'src/modules/alpha/a.ts', relationType: 'dependency' },
    { from: 'src/modules/beta/b.ts', to: 'src/modules/alpha/a2.ts', relationType: 'call' },
    { from: 'src/modules/beta/b2.ts', to: 'src/modules/beta/b.ts', relationType: 'inheritance' },
  ],
};

const ENTITY_OPTIONS = { view: { kind: 'hierarchy' } as const, grouping: 'raw' as const, idShape: 'scope-prefixed' as const };

/** Every class-box name a document declares, in source order (all UML keywords). */
function classLabels(puml: string): string[] {
  return [...puml.matchAll(/(?:abstract class|class|interface|enum) "(?:<<[^>]+>> )?([^"]+)" as n\d+/g)]
    .map((match) => match[1]);
}

function assertSyntaxOk(puml: string): void {
  const result = checkSyntax(puml);
  assert.deepEqual(result.errors, [], `PlantUML must parse without errors:\n${puml}`);
}

type BridgeOptions = Parameters<typeof archguardToPlantUml>[1];

/**
 * The drawn model the renderer would report for one bridge document:
 * `renderDetailed` parses, applies the default transforms and details, and
 * hands back the exact model it laid out. `toPlantUml`/`applyView` are carried
 * with it, the same way `PlantUmlGraph` hands them to the text page.
 */
async function drawnFor(
  graph: ArchitectureRendererGraph,
  options: BridgeOptions,
): Promise<{
  bridge: ReturnType<typeof archguardToPlantUml>;
  detailed: Awaited<ReturnType<typeof renderDetailed>>;
  drawn: ArchitectureDrawnPlantUml;
}> {
  const bridge = archguardToPlantUml(graph, options);
  // The DRAWING path: the bridge spells a real stereotype after the alias; the
  // bundled parser needs it before the alias, exactly as PlantUmlGraph feeds it.
  const detailed = await renderDetailed(parserSafePlantUml(bridge.puml), {});
  return {
    bridge,
    detailed,
    drawn: {
      model: detailed.model,
      entityIdOf: bridge.aliasOf,
      // The text page's serializer: the drawn model's glued names come back out
      // as real stereotypes, matching PlantUmlGraph's wrapper.
      toPlantUml: (model) => standardiseDrawnStereotypes(toPlantUml(model)),
      applyView,
    },
  };
}

/**
 * Two raw alpha→run relations and a function with a member compartment: the
 * renderer's default transform aggregates the pair into one weighted edge, and
 * the upstream serializer has to carry `<<function>>` and the member row.
 */
const RICH_GRAPH: ArchitectureRendererGraph = {
  nodes: [
    {
      id: ALPHA,
      label: 'Alpha',
      distance: 0,
      kind: 'class',
      members: [{ name: 'count', kind: 'field', visibility: 'private', signature: 'number' }],
    },
    {
      id: 's1/src/modules/alpha/run.ts.run',
      label: 'run',
      distance: 1,
      kind: 'function',
      members: [{ name: 'halt', kind: 'method', signature: '(): void' }],
    },
  ],
  edges: [
    { from: ALPHA, to: 's1/src/modules/alpha/run.ts.run', relationType: 'dependency' },
    { from: ALPHA, to: 's1/src/modules/alpha/run.ts.run', relationType: 'call' },
  ],
};

test('the full scope is the whole graph, exactly as the bridge builds it', () => {
  const puml = buildPlantUmlText(ENTITY_GRAPH, { kind: 'full' }, ENTITY_OPTIONS);
  assert.equal(puml, archguardToPlantUml(ENTITY_GRAPH, ENTITY_OPTIONS).puml);
  assert.deepEqual(classLabels(puml), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assertSyntaxOk(puml);
});

test('the viewport scope keeps the intersecting nodes and only the edges between them', () => {
  const puml = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'viewport', nodeIds: [ALPHA, BETA] },
    ENTITY_OPTIONS,
  );
  assert.deepEqual(classLabels(puml), ['Alpha', 'Beta'], 'delta and gamma are outside the viewport');
  assert.match(puml, /n0 \.\.> n1/, 'alpha → beta is the one edge with both ends in scope');
  assert.doesNotMatch(puml, /n2|n3/, 'an edge to a node outside the scope must not be emitted');
  assertSyntaxOk(puml);
});

test('the viewport scope expands a drawn overview group to its directory nodes', () => {
  const puml = buildPlantUmlText(
    FILE_GRAPH,
    { kind: 'viewport', nodeIds: ['grp::src/modules/alpha'] },
    { view: { kind: 'overview' }, grouping: 'raw', idShape: 'project-relative' },
  );
  assert.deepEqual(classLabels(puml), ['src/modules/alpha/a.ts', 'src/modules/alpha/a2.ts']);
  assert.doesNotMatch(puml, /beta/, 'the other directory is not covered by the group box');
  assertSyntaxOk(puml);
});

test('the selection scope is the selected entity plus one hop, with the induced edges', () => {
  const puml = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'selection', nodeIds: [BETA] },
    ENTITY_OPTIONS,
  );
  assert.deepEqual(classLabels(puml), ['Alpha', 'Beta', 'Gamma']);
  assert.match(puml, /n0 \.\.> n1/);
  assert.match(puml, /n1 \.\.> n2/);
  assert.doesNotMatch(puml, /Delta/, 'delta is two hops away from beta');
  assertSyntaxOk(puml);
});

test('the selection scope centred on a relation takes both ends and their neighbours', () => {
  const puml = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'selection', nodeIds: [ALPHA, BETA] },
    ENTITY_OPTIONS,
  );
  // Alpha and beta are the anchors; gamma is beta's other neighbour and delta
  // is alpha's other neighbour. Both rings join the document.
  assert.deepEqual(classLabels(puml), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.match(puml, /n0 \.\.> n1/, 'the selected relation itself is in the text');
});

test('the +1 scope with no selection is an explicit no-selection state, not an empty document', () => {
  assert.throws(
    () => buildPlantUmlText(ENTITY_GRAPH, { kind: 'selection', nodeIds: [] }, ENTITY_OPTIONS),
    (error: unknown) => error instanceof NoSelectionScopeError && error.code === 'no-selection',
  );
  assert.throws(
    () => scopeSubgraph(ENTITY_GRAPH, { kind: 'selection', nodeIds: [] }),
    (error: unknown) => error instanceof NoSelectionScopeError,
  );
});

test('the document is deterministic for the same graph and scope', () => {
  const scope = { kind: 'selection', nodeIds: [BETA] } as const;
  assert.equal(
    buildPlantUmlText(ENTITY_GRAPH, scope, ENTITY_OPTIONS),
    buildPlantUmlText(ENTITY_GRAPH, scope, ENTITY_OPTIONS),
  );
});

test('a viewport scope with no intersecting node is an ordinary empty document, not an error', () => {
  const puml = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'viewport', nodeIds: [] },
    ENTITY_OPTIONS,
  );
  assert.equal(puml, '@startuml\n@enduml');
  assertSyntaxOk(puml);
});

test('the volume reading counts characters and lines and estimates tokens at 3.5 chars each', () => {
  const text = '@startuml\nclass "A" as n0\n@enduml';
  const volume = measurePlantUmlText(text);
  assert.equal(TEXT_CHARS_PER_TOKEN, 3.5);
  assert.equal(volume.characters, 33);
  assert.equal(volume.lines, 3);
  assert.equal(volume.tokens, Math.round(33 / 3.5));
  assert.equal(volume.level, 'normal');

  // A single unbroken line has one line, not zero.
  assert.deepEqual(measurePlantUmlText('x'.repeat(350)), {
    characters: 350,
    lines: 1,
    tokens: 100,
    level: 'normal',
  });
  assert.deepEqual(measurePlantUmlText(''), { characters: 0, lines: 0, tokens: 0, level: 'normal' });
});

test('the 8k and 30k token bands are inclusive at their lower edge and open above 30k', () => {
  const at = (characters: number) => measurePlantUmlText('x'.repeat(characters));
  // 27,999 chars → 7,999.71 → rounds to the first large reading (8,000 tokens).
  assert.equal(at(27998).tokens, 7999);
  assert.equal(at(27998).level, 'normal');
  assert.equal(at(27999).tokens, TEXT_LARGE_TOKEN_THRESHOLD);
  assert.equal(at(27999).level, 'large');
  // 105,000 chars → exactly 30,000 tokens: still the warning band.
  assert.equal(at(105000).tokens, TEXT_HUGE_TOKEN_THRESHOLD);
  assert.equal(at(105000).level, 'large');
  assert.equal(at(105004).tokens, TEXT_HUGE_TOKEN_THRESHOLD + 1);
  assert.equal(at(105004).level, 'huge');
});

test('the preview keeps only the first 300 lines and reports the real total', () => {
  const lines = Array.from({ length: 400 }, (_unused, index) => `line ${String(index + 1)}`);
  const preview = previewPlantUmlText(lines.join('\n'));
  assert.equal(TEXT_PREVIEW_LINE_LIMIT, 300);
  assert.equal(preview.totalLines, 400);
  assert.equal(preview.shownLines, 300);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.split('\n').length, 300);
  assert.doesNotMatch(preview.text, /line 301/);

  const short = previewPlantUmlText('a\nb\nc');
  assert.deepEqual(short, { text: 'a\nb\nc', shownLines: 3, totalLines: 3, truncated: false });
});

test('nodesIntersectingViewport is a half-open box test and drops zero-area boxes', () => {
  const viewport = { left: 0, top: 0, right: 100, bottom: 100 };
  assert.deepEqual(
    nodesIntersectingViewport(
      [
        ['inside', { left: 10, top: 10, right: 20, bottom: 20 }],
        ['overlap', { left: 90, top: 90, right: 120, bottom: 120 }],
        ['outside', { left: 200, top: 200, right: 300, bottom: 300 }],
        ['unmeasured', { left: 0, top: 0, right: 0, bottom: 0 }],
      ],
      viewport,
    ),
    ['inside', 'overlap'],
  );
});

test('the session-context payload is the header, a blank line, and the fenced document', () => {
  const puml = '@startuml\n@enduml';
  assert.equal(
    wrapSessionContext('About the diagram:', puml),
    'About the diagram:\n\n```plantuml\n@startuml\n@enduml\n```',
  );
});

test('the full scope serializes the drawn model verbatim, not the bridge text', async () => {
  const { bridge, detailed, drawn } = await drawnFor(ENTITY_GRAPH, ENTITY_OPTIONS);
  const built = buildPlantUmlDocument(ENTITY_GRAPH, { kind: 'full' }, { ...ENTITY_OPTIONS, drawn });
  assert.equal(built.fallback, false);
  assert.equal(built.text, standardiseDrawnStereotypes(toPlantUml(detailed.model)), 'the document is toPlantUml(the drawn model)');
  // The upstream serializer names package aliases, which the bridge does not;
  // this is what proves the drawn model — not the bridge — produced the text.
  assert.notEqual(built.text, bridge.puml);
  assert.deepEqual(classLabels(built.text), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assertSyntaxOk(built.text);
});

test('the drawn document keeps aggregated edges and member compartments and round-trips stably', async () => {
  const { detailed, drawn } = await drawnFor(RICH_GRAPH, ENTITY_OPTIONS);
  const text = buildPlantUmlText(RICH_GRAPH, { kind: 'full' }, { ...ENTITY_OPTIONS, drawn });
  assert.equal(text, standardiseDrawnStereotypes(toPlantUml(detailed.model)));
  // The bridge emits two alpha→run relations; the renderer aggregates them into
  // one drawn edge, and that is what the text carries.
  assert.equal(
    text.match(/n0 \.\.> n1/g)?.length,
    1,
    'the two raw relations are one aggregated edge in the drawn text',
  );
  assert.match(text, /class "run" as n1 <<function>>/, 'a function carries a real stereotype token');
  assert.doesNotMatch(text, /"<<function>>/, 'the stereotype is never glued into the quoted name');
  assert.match(text, /- count: number/, 'the member compartment survives the serialization');
  assertSyntaxOk(text);
});

test('the drawn-model viewport scope keeps exactly the intersecting nodes and their edges', async () => {
  const { drawn } = await drawnFor(ENTITY_GRAPH, ENTITY_OPTIONS);
  const text = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'viewport', nodeIds: [ALPHA, BETA] },
    { ...ENTITY_OPTIONS, drawn },
  );
  assert.deepEqual(classLabels(text), ['Alpha', 'Beta'], 'gamma and delta are outside the viewport');
  assert.match(text, /n0 \.\.> n1/);
  assert.doesNotMatch(text, /n2|n3/, 'no edge to a node outside the scope');
  assertSyntaxOk(text);
});

test('the drawn-model selection scope is the anchor plus one hop, from applyView', async () => {
  const { drawn } = await drawnFor(ENTITY_GRAPH, ENTITY_OPTIONS);
  const text = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'selection', nodeIds: [BETA] },
    { ...ENTITY_OPTIONS, drawn },
  );
  const betaAlias = drawn.entityIdOf.get(BETA);
  assert.ok(betaAlias !== undefined);
  assert.equal(text, standardiseDrawnStereotypes(toPlantUml(applyView(drawn.model, {
    kind: 'neighborhood',
    entity: betaAlias,
    hops: 1,
  }))));
  assert.deepEqual(classLabels(text), ['Alpha', 'Beta', 'Gamma']);
  assert.doesNotMatch(text, /Delta/, 'delta is two hops away from beta');
});

test('the drawn-model multi-selection scope unions each anchor neighbourhood', async () => {
  const { drawn } = await drawnFor(ENTITY_GRAPH, ENTITY_OPTIONS);
  const text = buildPlantUmlText(
    ENTITY_GRAPH,
    { kind: 'selection', nodeIds: [ALPHA, BETA] },
    { ...ENTITY_OPTIONS, drawn },
  );
  // Alpha reaches delta, beta reaches gamma: the union is the whole graph.
  assert.deepEqual(classLabels(text), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.match(text, /n0 \.\.> n1/, 'the selected relation itself is in the text');
});

test('a thrown or missing upstream serializer falls back to the bridge text and says so', async () => {
  const { drawn } = await drawnFor(ENTITY_GRAPH, ENTITY_OPTIONS);
  const bridgePuml = archguardToPlantUml(ENTITY_GRAPH, ENTITY_OPTIONS).puml;

  const thrown = buildPlantUmlDocument(ENTITY_GRAPH, { kind: 'full' }, {
    ...ENTITY_OPTIONS,
    drawn: {
      ...drawn,
      toPlantUml: () => {
        throw new Error('serializer exploded');
      },
    },
  });
  assert.equal(thrown.fallback, true);
  assert.equal(thrown.text, bridgePuml);

  // A runtime that does not carry the function at all is the same fallback,
  // never a crash and never an empty page.
  const missing = buildPlantUmlDocument(ENTITY_GRAPH, { kind: 'full' }, {
    ...ENTITY_OPTIONS,
    drawn: { ...drawn, toPlantUml: undefined as unknown as ArchitectureDrawnPlantUml['toPlantUml'] },
  });
  assert.equal(missing.fallback, true);
  assert.equal(missing.text, bridgePuml);

  const missingView = buildPlantUmlDocument(ENTITY_GRAPH, { kind: 'selection', nodeIds: [BETA] }, {
    ...ENTITY_OPTIONS,
    drawn: { ...drawn, applyView: undefined as unknown as ArchitectureDrawnPlantUml['applyView'] },
  });
  assert.equal(missingView.fallback, true);
});

test('the +1 scope without anchors stays an explicit no-selection error with a drawn model', async () => {
  const { drawn } = await drawnFor(ENTITY_GRAPH, ENTITY_OPTIONS);
  assert.throws(
    () => buildPlantUmlDocument(ENTITY_GRAPH, { kind: 'selection', nodeIds: [] }, { ...ENTITY_OPTIONS, drawn }),
    (error: unknown) => error instanceof NoSelectionScopeError,
  );
});

test('without a drawn model the document is the bridge text and is marked as a fallback', () => {
  const built = buildPlantUmlDocument(ENTITY_GRAPH, { kind: 'full' }, ENTITY_OPTIONS);
  assert.equal(built.fallback, true);
  assert.equal(built.text, archguardToPlantUml(ENTITY_GRAPH, ENTITY_OPTIONS).puml);
});

test('a function is copied as a real stereotype, and parsePlantUml reads the kind back', async () => {
  const { drawn } = await drawnFor(RICH_GRAPH, ENTITY_OPTIONS);
  const text = buildPlantUmlText(RICH_GRAPH, { kind: 'full' }, { ...ENTITY_OPTIONS, drawn });

  // The standard spelling: quoted name, alias, THEN the stereotype token.
  assert.match(text, /^\s*class "run" as n\d+ <<function>>$/m, 'a function is a real stereotype');
  assert.doesNotMatch(text, /"[^"]*<<[^"]*"/, 'no quoted name may smuggle a <<…>> token');
  assert.match(text, /^\s*class "Alpha" as n\d+( \{)?$/m, 'a plain class names its kind through the keyword only');

  // plantuml-js agrees the document is well-formed (warnings are not errors).
  assert.deepEqual(checkSyntax(text).errors, [], 'the standard spelling has no syntax error');

  // The parser reports the stereotype as DATA, not as part of the name.
  const model = await parsePlantUml(text);
  const fn = model.entities.find((entity) => entity.stereotype === 'function');
  assert.ok(fn !== undefined, 'parsePlantUml must report the function stereotype');
  assert.equal(fn.name, 'run', 'the quoted name stays the bare entity name');
  assert.doesNotMatch(fn.name, /<</);

  // The interface case too, so a function-only fix cannot pass alone.
  const IFACE_GRAPH: ArchitectureRendererGraph = {
    nodes: [{ id: 's1/src/modules/alpha/ports.ts.Ports', label: 'Ports', distance: 0, kind: 'interface' }],
    edges: [],
  };
  const ifaceText = buildPlantUmlText(IFACE_GRAPH, { kind: 'full' }, ENTITY_OPTIONS);
  assert.match(ifaceText, /^\s*interface "Ports" as n\d+ <<interface>>$/m);
  const ifaceModel = await parsePlantUml(ifaceText);
  assert.equal(ifaceModel.entities.find((entity) => entity.name === 'Ports')?.stereotype, 'interface');
});

/* ── lossless text: every text path carries every member ─────────────────────────── */

/** The bridge options the lossless fixtures use: the class graph's own view. */
const LOSSLESS_OPTIONS = {
  view: { kind: 'hierarchy' } as const,
  grouping: 'raw' as const,
  idShape: 'scope-prefixed' as const,
};

/**
 * The lossless fixtures: `count` classes, each carrying 7–25 members.
 *
 * Past 40 entities the renderer's default detail switches to `compact`, which
 * writes a synthetic `… +N more (M members)` row into the drawn model and keeps
 * only four real rows. The member count cycles across the 7–25 band so no
 * fixture can pass by sharing one truncation shape, and every member name is
 * distinct so a member line is countable from the document alone.
 */
function losslessGraph(count: number): ArchitectureRendererGraph {
  const nodes = Array.from({ length: count }, (_unused, index) => {
    const name = `Entity${String(index)}`;
    const memberCount = 7 + (index % 19);
    return {
      id: `s1/src/pkg${String(index % 7)}/e${String(index)}.ts.${name}`,
      label: name,
      distance: index === 0 ? 0 : 1 + (index % 3),
      kind: 'class' as const,
      members: Array.from({ length: memberCount }, (_member, member) => ({
        name: `member${String(member)}`,
        kind: 'field' as const,
        visibility: 'private',
        signature: 'number',
      })),
    };
  });
  // A chain, so the drawing is one connected diagram like a real session's.
  const edges = nodes.slice(1).map((node, index) => ({
    from: nodes[index].id,
    to: node.id,
    relationType: 'dependency',
  }));
  return { nodes, edges };
}

/** The drawn model the renderer reports for one graph, rendered losslessly. */
async function losslessDrawn(graph: ArchitectureRendererGraph): Promise<{
  drawn: ArchitectureDrawnPlantUml;
  bridge: ReturnType<typeof archguardToPlantUml>;
}> {
  const bridge = archguardToPlantUml(graph, LOSSLESS_OPTIONS);
  const detailed = await renderWithMemberDetail(
    renderDetailed,
    parserSafePlantUml(bridge.puml),
    {},
  );
  return {
    bridge,
    drawn: {
      model: detailed.model,
      entityIdOf: bridge.aliasOf,
      toPlantUml: (model) => standardiseDrawnStereotypes(toPlantUml(model)),
      applyView,
    },
  };
}

/** Every line that is the RENDERER's own truncation marker (never a real member). */
const TRUNCATION_LINE = /…\s*\+\d+\s+more|\(\d+\s+members\)/;

/** The member rows of every class block in a document, keyed by entity name. */
function memberRowsByEntity(puml: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  let current: { readonly name: string; readonly rows: string[] } | null = null;
  let depth = 0;
  for (const line of puml.split('\n')) {
    if (current === null) {
      const declaration = /^[ \t]*(?:abstract\s+)?(?:class|interface|enum)\s+"([^"]+)"\s+as\s+\w+(?:\s+<<[^>]+>>)?\s*\{\s*$/.exec(line);
      if (declaration !== null) {
        current = { name: declaration[1], rows: [] };
        depth = 1;
      }
      continue;
    }
    if (/^[ \t]*\}[ \t]*$/.test(line)) {
      depth -= 1;
      if (depth === 0) {
        rows.set(current.name, current.rows);
        current = null;
      }
      continue;
    }
    if (/\{[ \t]*$/.test(line)) depth += 1;
    if (/^[ \t]*[-+#~]\s+\S/.test(line)) current.rows.push(line);
  }
  if (current !== null) rows.set(current.name, current.rows);
  return rows;
}

/** Assert one document has no truncation row and every entity's members intact. */
function assertComplete(
  text: string,
  graph: ArchitectureRendererGraph,
  label: string,
  expectEveryEntity = true,
): void {
  for (const line of text.split('\n')) {
    assert.doesNotMatch(line, TRUNCATION_LINE, `${label}: a truncation row reached the text: ${line}`);
  }
  const rows = memberRowsByEntity(text);
  for (const node of graph.nodes) {
    const entityRows = rows.get(node.label);
    if (entityRows === undefined) {
      // A narrower scope may not include this entity at all; what must never
      // happen is that it appears WITHOUT its members (checked below).
      assert.equal(
        expectEveryEntity,
        false,
        `${label}: ${node.label} is missing from a document that must carry every entity`,
      );
      continue;
    }
    const expected = node.members?.length ?? 0;
    assert.equal(
      entityRows.length,
      expected,
      `${label}: ${node.label} must carry ${String(expected)} member rows, got ${String(entityRows.length)}`,
    );
  }
}

test('41, 150 and 600 entity drawings carry every member into every text path', async () => {
  for (const count of [41, 150, 600]) {
    const graph = losslessGraph(count);
    const { drawn } = await losslessDrawn(graph);
    const options = { ...LOSSLESS_OPTIONS, drawn };
    const label = `${String(count)} entities`;

    // The Text page's three scopes.
    const full = buildFullPlantUmlDocument(graph, options);
    assert.equal(full.fallback, false, `${label}: the drawn model is the source`);
    assertComplete(full.text, graph, `${label} full`);

    const viewport = buildPlantUmlText(
      graph,
      { kind: 'viewport', nodeIds: graph.nodes.map((node) => node.id) },
      options,
    );
    assertComplete(viewport, graph, `${label} viewport`);

    const anchor = graph.nodes[0].id;
    const selection = buildPlantUmlText(graph, { kind: 'selection', nodeIds: [anchor] }, options);
    assertComplete(selection, graph, `${label} selection`, false);

    // Copy / Download's document is the same string; "Copy for chat" fences it.
    assert.match(wrapSessionContext('About the diagram:', full.text), /```plantuml\n@startuml\n/);
    assertComplete(wrapSessionContext('About the diagram:', full.text), graph, `${label} context`);

    // The tray's attachment, over the same builder.
    const tray = buildPlantUmlText(
      graph,
      { kind: 'selected', nodeIds: graph.nodes.slice(0, 2).map((node) => node.id) },
      options,
    );
    assertComplete(tray, graph, `${label} tray attachment`, false);

    // The same document the Text page shows is what the export builder returns:
    // one definition, so the two doors cannot disagree.
    assert.equal(
      full.text,
      buildFullPlantUmlDocument(graph, options).text,
      `${label}: the Text page and the export menu read one document`,
    );
  }
});

test('the renderer is asked for the full member detail', async () => {
  assert.equal(PLANTUML_MEMBER_DETAIL, 'full');
  const received: Record<string, unknown>[] = [];
  const fakeRender = (async (_puml: string, options: Record<string, unknown>) => {
    received.push(options);
    return { model: { diagramType: 'class', entities: [], relations: [], packages: [] }, layout: null, svg: '' };
  }) as unknown as PlantUmlRenderDetailed;
  await renderWithMemberDetail(fakeRender, '@startuml\n@enduml', { layout: {} as never });
  assert.equal(received.length, 1);
  assert.equal(
    received[0].detail,
    'full',
    'renderDetailed must receive detail: full, never the entity-count default',
  );
});

test('the default detail is the defect the control arm reproduces: markers appear', async () => {
  const graph = losslessGraph(41);
  const bridge = archguardToPlantUml(graph, LOSSLESS_OPTIONS);
  // Exactly what the renderer does when detail is NOT pinned: the entity-count
  // default picks `compact`.
  const defaulted = await renderDetailed(parserSafePlantUml(bridge.puml), {});
  const drawn: ArchitectureDrawnPlantUml = {
    model: defaulted.model,
    entityIdOf: bridge.aliasOf,
    toPlantUml: (model) => standardiseDrawnStereotypes(toPlantUml(model)),
    applyView,
  };
  const text = buildFullPlantUmlDocument(graph, { ...LOSSLESS_OPTIONS, drawn }).text;
  assert.match(
    text,
    TRUNCATION_LINE,
    'the default detail must put the renderer overflow row into the text (the control)',
  );
  const rows = memberRowsByEntity(text);
  const first = graph.nodes[0];
  assert.ok(
    (rows.get(first.label) ?? []).length < (first.members?.length ?? 0),
    'the control must lose real member rows, not merely add a marker',
  );
});
