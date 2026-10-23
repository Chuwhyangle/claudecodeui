import assert from 'node:assert/strict';
import { beforeAll, describe, test } from 'vitest';

import {
  pathPointsOf,
  readSemanticDrawingGeometry,
  type SemanticDrawingGeometry,
  type SemanticReadHints,
} from '@/modules/architecture/semanticZoomRead';

/**
 * The semantic-zoom READ layer, on SVG rendered by the real 0.4.0 renderer.
 *
 * 0.4.0 publishes what the old prototype had to guess: box geometry as
 * `data-x/y/w/h`, compartment heights as `data-title-h/attrs-h/ops-h`, a
 * package's closed tab as `data-tab-w/h` plus a `.uml-package-tab` path,
 * members as `uml-attr` / `uml-op` classes, compartment rules as
 * `.uml-compartment-rule[data-rule]`, and a bundled edge as `uml-edge-bundle`
 * with `data-bundle-size`. This criterion reads exactly those facts back.
 *
 * The decisive leg is the member classification: 0.4.0 writes every member row
 * with the compartment its MODEL gave it (`uml-attr` / `uml-op`), and the read
 * layer must take that class verbatim. It never overlays the payload's member
 * order: the renderer groups fields before methods while the payload keeps the
 * source order, so an index-aligned overlay lands attributes in the operations
 * compartment. The corner case this guards is a field whose declared TYPE
 * contains a parenthesis — the reader must still call it an attribute when the
 * renderer classed it as one.
 */

type PlantUmlElkModule = {
  ElkLayoutEngine: new () => unknown;
  createRenderer: (options: { layout: unknown; detail?: 'full' | 'compact' | 'names' }) => {
    render: (puml: string) => Promise<{ svg: string }>;
  };
};

let render: (puml: string) => Promise<string>;
/** The same renderer at the compact detail level (the one that adds an overflow row). */
let renderCompact: (puml: string) => Promise<string>;

/** Parse a rendered SVG string into an element the reader can walk. */
function intoSvg(svg: string): Element {
  const host = document.createElement('div');
  host.innerHTML = svg;
  const element = host.querySelector('svg');
  assert.ok(element !== null, 'the renderer produced an SVG');
  return element;
}

beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
  const { ElkLayoutEngine, createRenderer } = (await import('@yalehwang/plantuml-js/elk')) as unknown as PlantUmlElkModule;
  const renderer = createRenderer({ layout: new ElkLayoutEngine() });
  render = async (puml: string): Promise<string> => (await renderer.render(puml)).svg;
  // `compact` is the level the real canvas uses past 40 entities: it keeps four
  // member rows and appends its own truncation row when a class has more.
  const compact = createRenderer({ layout: new ElkLayoutEngine(), detail: 'compact' });
  renderCompact = async (puml: string): Promise<string> => (await compact.render(puml)).svg;
});

const EXAMPLE = `@startuml
package "modules/alpha" {
  class "Alpha" as a1 {
    - map: (A) => B
    + run(input: (A|B)): void
  }
  interface "Runner" as r1 {
    + run(): void
  }
  class "Mixed" as mix {
    + firstMethod(): void
    - alpha: string
    + secondMethod(input: number): boolean
    - beta: number
  }
}
package "modules/beta" {
  class "Beta" as b1
}
a1 ..> b1
r1 ..> b1
@enduml`;

/** The example drawing, read once. */
async function exampleGeometry(hints: SemanticReadHints = {}): Promise<{ svg: Element; geometry: SemanticDrawingGeometry }> {
  const svg = intoSvg(await render(EXAMPLE));
  return { svg, geometry: readSemanticDrawingGeometry(svg, hints) };
}

test('entity and package boxes come from the published data attributes', async () => {
  const { svg, geometry } = await exampleGeometry();
  const node = svg.querySelector('.uml-node[data-entity-id="a1"]');
  const pkg = svg.querySelector('.uml-package[data-package-id="modules/alpha"]');
  assert.ok(node !== null && pkg !== null);

  const alpha = geometry.nodes.find((candidate) => candidate.id === 'a1');
  assert.ok(alpha !== undefined);
  for (const [name, key] of [['data-x', 'x'], ['data-y', 'y'], ['data-w', 'width'], ['data-h', 'height']] as const) {
    assert.equal(
      alpha.rect[key],
      Number(node.getAttribute(name)),
      `${key} is read from ${name}, not re-derived from the box`,
    );
  }
  assert.equal(alpha.titleHeight, Number(node.getAttribute('data-title-h')));
  assert.equal(alpha.attributesHeight, Number(node.getAttribute('data-attrs-h')));
  assert.equal(alpha.operationsHeight, Number(node.getAttribute('data-ops-h')));

  const frame = geometry.packages.find((candidate) => candidate.id === 'modules/alpha');
  assert.ok(frame !== undefined);
  assert.equal(frame.tabWidth, Number(pkg.getAttribute('data-tab-w')));
  assert.equal(frame.tabHeight, Number(pkg.getAttribute('data-tab-h')));
  assert.equal(frame.tabClosed, true, 'the 0.4.0 tab is a Z-closed rectangle');
});

test('a class whose members interleave fields and methods keeps each row in its true compartment', async () => {
  // The payload (this source) authors the rows INTERLEAVED: field, method,
  // field, method. The renderer groups fields before methods, so the drawn
  // order is NOT the payload order. Reading the renderer's own `uml-attr` /
  // `uml-op` class is therefore the only honest classification; an index-aligned
  // overlay of the payload's kinds would swap the two compartments.
  const { geometry } = await exampleGeometry();
  const mixed = geometry.nodes.find((candidate) => candidate.id === 'mix');
  assert.ok(mixed !== undefined);
  assert.deepEqual(
    mixed.members.map((member) => [member.text, member.compartment]),
    [
      ['- alpha: string', 'attr'],
      ['- beta: number', 'attr'],
      ['+ firstMethod(): void', 'op'],
      ['+ secondMethod(input: number): boolean', 'op'],
    ],
    'every row’s compartment is its own kind, asserted member by member',
  );
});

test('a field whose TYPE contains parentheses stays an attribute (the reader never parses the text)', () => {
  // 0.4.0 publishes the compartment of every row from the model's member kind,
  // so the class is the model's answer. The hand-built shape states that answer
  // directly: the reader must believe the class and must not re-infer a member's
  // kind from the `(` in its text (it has no payload hint to fall back on).
  const svg = intoSvg(`<svg viewBox="0 0 220 60" width="220" height="60">
    <g class="uml-node" data-entity-id="holder" data-x="0" data-y="0" data-w="220" data-h="60">
      <text class="uml-attr">- map: (A) => B</text>
      <text class="uml-op">+ run(input: (A|B)): void</text>
    </g>
  </svg>`);
  const geometry = readSemanticDrawingGeometry(svg);
  const holder = geometry.nodes.find((candidate) => candidate.id === 'holder');
  assert.ok(holder !== undefined);
  assert.deepEqual(
    holder.members.map((member) => [member.text, member.compartment]),
    [
      ['- map: (A) => B', 'attr'],
      ['+ run(input: (A|B)): void', 'op'],
    ],
    'a parenthesised TYPE stays an attribute; a method stays an operation',
  );
});

test('the read function takes no payload member-kind parameter (the index overlay is gone)', () => {
  const source = readSemanticDrawingGeometry.toString();
  assert.ok(
    !/memberKindsById|\bkinds\b/.test(source),
    `the read function must not thread payload member kinds (source: ${source.slice(0, 200)}…)`,
  );
  assert.equal(
    readSemanticDrawingGeometry.length,
    1,
    'only the SVG is required; the hints bag is optional and carries no member kinds',
  );
});

test('an interface with only operations carries exactly one compartment rule', async () => {  const { geometry } = await exampleGeometry();
  const runner = geometry.nodes.find((candidate) => candidate.id === 'r1');
  assert.ok(runner !== undefined);
  assert.equal(runner.kind, 'interface', 'the italic title names the interface');
  assert.equal(runner.attributesHeight, 0);
  assert.equal(runner.operationsHeight, 18);
  assert.equal(runner.ruleCount, 1, 'title only — the ops compartment is the body');
});

test('a bundled edge is read with its bundle size', async () => {
  const svg = intoSvg(await render(`@startuml
class "Hub" as hub
${Array.from({ length: 8 }, (_, index) => `class "C${index}" as c${index}`).join('\n')}
${Array.from({ length: 8 }, (_, index) => `hub ..> c${index}`).join('\n')}
@enduml`));
  const geometry = readSemanticDrawingGeometry(svg);
  const bundle = geometry.edges.find((edge) => edge.bundleSize > 1);
  assert.ok(bundle !== undefined, 'the renderer bundled the eight fan-out relations');
  assert.equal(bundle.bundleSize, 8);
  assert.equal(bundle.source, 'hub');
  assert.equal(bundle.target, '', 'a bundle has no single target');
});

test('path points are read in order, including a rounded corner', () => {
  const points = pathPointsOf('M10,20 L30,20 Q35,20 35,25 L35,40');
  assert.deepEqual(points, [
    { x: 10, y: 20 },
    { x: 30, y: 20 },
    { x: 35, y: 20 },
    { x: 35, y: 25 },
    { x: 35, y: 40 },
  ]);
});

describe('title text is read by ROLE, not by child order (defect 6)', () => {
  test('a pinned node’s name is not the badge even when the badge is the first text', () => {
    // The graph annotator inserts the pin badge BEFORE the title; taking the
    // first `<text>` made the label `📌` and the entity lost its name.
    const svg = intoSvg(`<svg viewBox="0 0 200 80" width="200" height="80">
      <g class="uml-node" data-entity-id="cursor" data-architecture-pinned="true"
         data-x="0" data-y="0" data-w="200" data-h="80">
        <text class="arch-pinned-badge" data-architecture-pinned-badge="true" font-size="11">📌</text>
        <text font-style="italic">«interface»</text>
        <text font-style="italic">CursorProvider</text>
        <text class="uml-attr">+ id: string</text>
      </g>
    </svg>`);
    const geometry = readSemanticDrawingGeometry(svg);
    const node = geometry.nodes.find((candidate) => candidate.id === 'cursor');
    assert.ok(node !== undefined);
    assert.equal(node.label, 'CursorProvider', 'the entity label, not the badge glyph');
    assert.notEqual(node.label, '📌');
    assert.equal(node.stereotype, 'interface', 'the standalone stereotype line is read as the kind token');
    assert.equal(node.kind, 'interface');
    assert.equal(
      svg.querySelectorAll('.arch-pinned-badge').length,
      1,
      'the fixture carries exactly one badge',
    );
  });
});

describe('upstream compact-detail overflow row', () => {
  const FIVE_MEMBERS = `@startuml
class "Big" as big {
  - a: string
  - b: string
  - c: string
  - d: string
  - e: string
}
@enduml`;

  test('a class past the renderer’s compact limit reports its total, not the truncation row', async () => {
    const svg = intoSvg(await renderCompact(FIVE_MEMBERS));
    const geometry = readSemanticDrawingGeometry(svg);
    const big = geometry.nodes.find((node) => node.id === 'big');
    assert.ok(big !== undefined);
    // The renderer keeps COMPACT_MEMBER_ROWS = 4 rows and appends
    // `+ … +1 more (5 members)`. The row is a paging hint, not a member.
    const rawTexts = [...svg.querySelectorAll('.uml-node[data-entity-id="big"] text')]
      .map((text) => text.textContent ?? '');
    assert.ok(
      rawTexts.some((text) => /more \(\d+ members\)/.test(text)),
      'the real renderer must have emitted its truncation row for this case to mean anything',
    );
    assert.equal(big.members.length, 4, 'only the real member rows are kept');
    assert.ok(
      big.members.every((member) => !/more \(\d+ members\)/.test(member.text)),
      'the upstream overflow row must not appear in the member list',
    );
    assert.equal(big.memberTotal, 5, 'the total is the row’s `(N members)`, not the kept row count');
    assert.equal(big.upstreamOverflow, true);
  });

  test('a class whose only row is the truncation row reads no members and the upstream total', () => {
    // The boundary the renderer cannot produce (it always keeps four rows):
    // read directly from the shape, so the strip rule is exercised on its own.
    const svg = intoSvg(`<svg viewBox="0 0 120 40" width="120" height="40">
      <g class="uml-node" data-entity-id="only" data-x="0" data-y="0" data-w="120" data-h="40">
        <text class="uml-attr">+ … +3 more (7 members)</text>
      </g>
    </svg>`);
    const geometry = readSemanticDrawingGeometry(svg);
    const only = geometry.nodes.find((node) => node.id === 'only');
    assert.ok(only !== undefined);
    assert.deepEqual(only.members, [], 'the truncation row is not a member');
    assert.equal(only.memberTotal, 7);
    assert.equal(only.upstreamOverflow, true);
  });
});
