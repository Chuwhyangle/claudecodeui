import assert from 'node:assert/strict';
import { beforeAll, test } from 'vitest';

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
 * The decisive leg is the member classification: a field whose TYPE contains
 * parentheses (`- map: (A) => B`) must stay an attribute, and a method must stay
 * an operation — which is only possible because the kind comes from the
 * renderer's class, not from the text.
 */

type PlantUmlElkModule = {
  ElkLayoutEngine: new () => unknown;
  createRenderer: (options: { layout: unknown }) => {
    render: (puml: string) => Promise<{ svg: string }>;
  };
};

let render: (puml: string) => Promise<string>;

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

test('a field whose TYPE has parentheses is an attribute, not a method', async () => {
  // The payload is authoritative: the renderer's own parser calls a field with
  // a function type a method, and the hint corrects that without inspecting the
  // member text.
  const { geometry } = await exampleGeometry({
    memberKindsById: new Map([['a1', ['field', 'method'] as const]]),
  });
  const alpha = geometry.nodes.find((candidate) => candidate.id === 'a1');
  assert.ok(alpha !== undefined);
  assert.deepEqual(
    alpha.members.map((member) => [member.text, member.compartment]),
    [
      ['- map: (A) => B', 'attr'],
      ['+ run(input: (A|B)): void', 'op'],
    ],
    'a parenthesised TYPE stays an attribute; a method stays an operation',
  );
});

test('an interface with only operations carries exactly one compartment rule', async () => {
  const { geometry } = await exampleGeometry();
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
