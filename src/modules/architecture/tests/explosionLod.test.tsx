import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  aggregatePackageEdges,
  applyExplosionLod,
  buildExplosionHierarchy,
  clipPolylineToFrames,
  createExplosionLodScheduler,
  ENTITY_LOD_DEPTH,
  ENTITY_MIN_SCALE,
  entityPackagePath,
  focusPackageOf,
  LOD_DEBOUNCE_MS,
  LOD_DEADZONE_RATIO,
  LOD_LABEL_BASE_FONT_PX,
  LOD_LABEL_MAX_SCREEN_PX,
  LOD_LABEL_MIN_FRAME_SCREEN_WIDTH_PX,
  LOD_LABEL_MIN_SCREEN_PX,
  LOD_LABELS_LAYER_ATTRIBUTE,
  lodDepthForScale,
  lodLabelScreenFontPx,
  orthogonalConnector,
  PACKAGE_LEVEL_MAX_DEPTH,
  PACKAGE_LOD_DEPTH,
  planPackageTitles,
  polylineFromPathData,
  resolveLodDepth,
  SUBPACKAGE_LOD_DEPTH,
  SUBPACKAGE_MIN_SCALE,
} from '@/modules/architecture/explosionLod';
import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';
import {
  centerElementInContainer,
  centeredScrollOffsets,
} from '@/modules/architecture/svgViewport';

/**
 * The architecture explosion diagram's semantic zoom.
 *
 * One layout is drawn; zooming may only switch what is displayed, never
 * re-place it. These cases pin the three questions that makes possible:
 *  · which hierarchy depth a scale maps to, with the dead band that stops a
 *    boundary from flapping and the debounce that stops a wheel burst from
 *    walking every intermediate level;
 *  · what each depth shows — entities and UML edges at the near level, package
 *    frames with `(N)` counts plus weighted package edges at the far ones —
 *    while the rendered SVG element itself is never replaced;
 *  · the focus package is scrolled back to the container centre on a level
 *    cross, so the user does not "lose" it.
 */

/**
 * A stand-in for the renderer's SVG. The real renderer emits package frames,
 * edges and entities as SIBLINGS (packages are boxes, not DOM parents), so the
 * fixture does the same and the module may never rely on DOM containment.
 */
function svgFixture(packages: readonly string[], entities: readonly string[]): string {
  const frames = packages.map((packageId, index) => {
    const x = index * 400;
    return (
      `<g data-package-id="${packageId}" class="uml-package">` +
      `<rect x="${x}" y="0" width="300" height="200" fill="none" stroke="#333333"/>` +
      `<rect x="${x}" y="0" width="60" height="18" fill="#ffffff" stroke="#333333"/>` +
      `<text x="${x + 6}" y="13" font-size="12">${packageId}</text>` +
      `</g>`
    );
  });
  const nodes = entities.map((id, index) =>
    `<g data-entity-id="${id}" class="uml-node"><rect x="10" y="${index * 40}" width="120" height="30"/></g>`,
  );
  return `<svg viewBox="0 0 1600 800" width="1600" height="800">${[...frames, ...nodes].join('')}</svg>`;
}

function hostWith(svg: string): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = svg;
  document.body.append(host);
  return host;
}

/** Three entities whose packages sit at depths 3, 4 and 2 of the same tree. */
const GRAPH: ArchitectureRendererGraph = {
  nodes: [
    { id: 'src/modules/chat/hooks/a.ts', label: 'a', distance: 0 },
    { id: 'src/modules/chat/hooks/deep/useX.ts', label: 'useX', distance: 1 },
    { id: 'src/modules/beta/b.ts', label: 'b', distance: 2 },
  ],
  edges: [
    // At the far level both of these collapse onto the same visible ancestor
    // (modules/chat/hooks), so the overlay must combine them into one ×2 edge.
    { from: 'src/modules/chat/hooks/a.ts', to: 'src/modules/beta/b.ts', relationType: 'call' },
    { from: 'src/modules/chat/hooks/deep/useX.ts', to: 'src/modules/beta/b.ts', relationType: 'dependency' },
    // The reverse direction stays a separate weighted edge.
    { from: 'src/modules/beta/b.ts', to: 'src/modules/chat/hooks/a.ts', relationType: 'inheritance' },
  ],
};

/** The frames the renderer would draw for those entities, ancestors included. */
const FRAMES = ['modules/chat', 'modules/chat/hooks', 'modules/chat/hooks/deep', 'modules/beta'];

function displayOf(element: Element | null): string {
  assert.ok(element !== null, 'the element must exist');
  return (element as HTMLElement).style.display;
}

function frameLabel(host: ParentNode, packageId: string): string {
  const frame = [...host.querySelectorAll('.uml-package')].find(
    (candidate) => candidate.getAttribute('data-package-id') === packageId,
  );
  assert.ok(frame !== undefined, `frame ${packageId} must be drawn`);
  const labels = [...frame.children].filter((child) => child.tagName.toLowerCase() === 'text');
  return labels.map((label) => label.textContent).join('');
}

/**
 * The package-level relation lines. They are `<path>` elements now (clipped
 * orthogonal routes), never centre-to-centre `<line>`s — see the dedicated
 * case at the end.
 */
function overlayEdges(host: ParentNode): Element[] {
  return [...host.querySelectorAll('[data-architecture-lod-edges] path.arch-lod-package-edge')];
}

/** The drawn counter-scaled titles, keyed by package id. */
function titleLabels(host: ParentNode): Map<string, { screenPx: number; transformScale: number; text: string }> {
  const labels = new Map<string, { screenPx: number; transformScale: number; text: string }>();
  for (const group of host.querySelectorAll(`[${LOD_LABELS_LAYER_ATTRIBUTE}] [data-lod-label-package]`)) {
    const packageId = group.getAttribute('data-lod-label-package') ?? '';
    const transform = group.getAttribute('transform') ?? '';
    const transformScale = Number(/scale\(([-\d.]+)\)/.exec(transform)?.[1] ?? 'NaN');
    labels.set(packageId, {
      screenPx: Number(group.getAttribute('data-lod-label-screen-px') ?? 'NaN'),
      transformScale,
      text: group.querySelector('text')?.textContent ?? '',
    });
  }
  return labels;
}

function isOrthogonal(points: readonly { x: number; y: number }[]): boolean {
  return points.every((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1];
    return Math.abs(point.x - previous.x) < 1e-6 || Math.abs(point.y - previous.y) < 1e-6;
  });
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
});

test('the scale maps to a hierarchy depth, and a dead band stops boundary flapping', () => {
  // The proposal fixes the dead band at 5–10% and the debounce at 150–250 ms.
  assert.ok(LOD_DEADZONE_RATIO >= 0.05 && LOD_DEADZONE_RATIO <= 0.1);
  assert.ok(LOD_DEBOUNCE_MS >= 150 && LOD_DEBOUNCE_MS <= 250);

  assert.equal(lodDepthForScale(0.1), PACKAGE_LOD_DEPTH);
  assert.equal(lodDepthForScale(0.3), SUBPACKAGE_LOD_DEPTH);
  assert.equal(lodDepthForScale(0.9), ENTITY_LOD_DEPTH);
  assert.equal(lodDepthForScale(Number.NaN), ENTITY_LOD_DEPTH, 'an unmeasured fit is natural size');

  // Entering the subpackage band requires passing the threshold by half the
  // dead band; leaving it requires falling below by the same margin.
  assert.equal(resolveLodDepth(SUBPACKAGE_MIN_SCALE + 0.001, PACKAGE_LOD_DEPTH), PACKAGE_LOD_DEPTH);
  assert.equal(resolveLodDepth(SUBPACKAGE_MIN_SCALE * 1.05, PACKAGE_LOD_DEPTH), SUBPACKAGE_LOD_DEPTH);
  assert.equal(resolveLodDepth(SUBPACKAGE_MIN_SCALE - 0.001, SUBPACKAGE_LOD_DEPTH), SUBPACKAGE_LOD_DEPTH);
  assert.equal(resolveLodDepth(SUBPACKAGE_MIN_SCALE * 0.95, SUBPACKAGE_LOD_DEPTH), PACKAGE_LOD_DEPTH);

  // The same band around the entity threshold, from both sides.
  assert.equal(resolveLodDepth(ENTITY_MIN_SCALE - 0.01, ENTITY_LOD_DEPTH), ENTITY_LOD_DEPTH);
  assert.equal(resolveLodDepth(ENTITY_MIN_SCALE * 0.95, ENTITY_LOD_DEPTH), SUBPACKAGE_LOD_DEPTH);
  assert.equal(resolveLodDepth(ENTITY_MIN_SCALE * 1.05, SUBPACKAGE_LOD_DEPTH), ENTITY_LOD_DEPTH);
  assert.equal(resolveLodDepth(ENTITY_MIN_SCALE - 0.01, SUBPACKAGE_LOD_DEPTH), SUBPACKAGE_LOD_DEPTH);

  // The first reading has no history to protect, so it is the raw mapping.
  assert.equal(resolveLodDepth(0.01, null), PACKAGE_LOD_DEPTH);
  assert.equal(resolveLodDepth(3, null), ENTITY_LOD_DEPTH);
});

test('the debouncer applies only the last reading, after the documented delay', () => {
  vi.useFakeTimers();
  const applied: string[] = [];
  const scheduler = createExplosionLodScheduler();

  scheduler.request(() => applied.push('first'));
  scheduler.request(() => applied.push('second'));
  vi.advanceTimersByTime(LOD_DEBOUNCE_MS - 1);
  assert.equal(applied.length, 0, 'nothing applies before the delay elapses');

  vi.advanceTimersByTime(1);
  assert.deepEqual(applied, ['second'], 'a burst coalesces into the newest reading');

  // A cancelled request never runs.
  scheduler.request(() => applied.push('cancelled'));
  scheduler.cancel();
  vi.advanceTimersByTime(LOD_DEBOUNCE_MS * 2);
  assert.deepEqual(applied, ['second']);
});

test('the far level collapses entities behind counted package frames and weighted package edges', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  const svg = host.querySelector('svg');
  const hierarchy = buildExplosionHierarchy(host, GRAPH);
  // With the published renderer (no per-entity data-package-id) the id path is
  // the source of the assignment; the same scope-stripped directory split the
  // bridge used to emit the package blocks.
  assert.equal(hierarchy.entityPackage.get('src/modules/chat/hooks/a.ts'), 'modules/chat/hooks');
  assert.equal(hierarchy.entityPackage.get('src/modules/chat/hooks/deep/useX.ts'), 'modules/chat/hooks/deep');
  assert.equal(entityPackagePath('src/modules/beta/b.ts'), 'modules/beta');

  // A marker the renderer owns: a re-render would wipe it, toggling must not.
  svg?.setAttribute('data-lod-sentinel', 'kept');

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: PACKAGE_LOD_DEPTH });

  for (const node of host.querySelectorAll('.uml-node')) {
    assert.equal(displayOf(node), 'none', 'entities collapse into their package at the far level');
  }
  for (const edge of host.querySelectorAll('.uml-edge')) {
    assert.equal(displayOf(edge), 'none', 'entity UML edges are replaced by package edges');
  }

  // Frames deeper than the coarse chain are hidden; the counted ones remain.
  assert.equal(displayOf(host.querySelector('[data-package-id="modules/chat/hooks/deep"]')), 'none');
  assert.equal(displayOf(host.querySelector('[data-package-id="modules/chat/hooks"]')), '');
  assert.equal(displayOf(host.querySelector('[data-package-id="modules/beta"]')), '');

  // The far labels name the frame by its last two path segments (the proposal's
  // `modules/chat (37)` form) and state the subtree entity count.
  assert.equal(frameLabel(host, 'modules/chat'), 'modules/chat (2)');
  assert.equal(frameLabel(host, 'modules/chat/hooks'), 'chat/hooks (2)');
  assert.equal(frameLabel(host, 'modules/beta'), 'modules/beta (1)');

  // Two entity edges collapse onto chat/hooks → beta with a ×2 weight, and the
  // reverse direction stays its own edge.
  const lines = overlayEdges(host);
  assert.equal(lines.length, 2, `expected two package edges, got ${lines.length}`);
  const forward = lines.find(
    (line) =>
      line.getAttribute('data-lod-edge-source') === 'modules/chat/hooks' &&
      line.getAttribute('data-lod-edge-target') === 'modules/beta',
  );
  const backward = lines.find(
    (line) =>
      line.getAttribute('data-lod-edge-source') === 'modules/beta' &&
      line.getAttribute('data-lod-edge-target') === 'modules/chat/hooks',
  );
  assert.equal(forward?.getAttribute('data-lod-edge-weight'), '2');
  assert.equal(backward?.getAttribute('data-lod-edge-weight'), '1');
  assert.equal(
    host.querySelector('[data-architecture-lod-edges] .arch-lod-package-weight')?.textContent,
    '×2',
    'a collapsed edge carries its ×N label',
  );

  assert.equal(host.querySelector('svg'), svg, 'the drawn SVG element is never replaced');
  assert.equal(svg?.getAttribute('data-lod-sentinel'), 'kept', 'no render path ran across the level change');
  assert.equal(PACKAGE_LEVEL_MAX_DEPTH, 3);
});

test('the middle level reveals nested frames; the near level restores entities, edges and labels', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  const hierarchy = buildExplosionHierarchy(host, GRAPH);
  const svg = host.querySelector('svg');
  svg?.setAttribute('data-lod-sentinel', 'kept');

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: SUBPACKAGE_LOD_DEPTH });
  for (const node of host.querySelectorAll('.uml-node')) assert.equal(displayOf(node), 'none');
  for (const frame of host.querySelectorAll('.uml-package')) assert.equal(displayOf(frame), '', 'every frame is visible at the subpackage level');
  assert.equal(frameLabel(host, 'modules/chat/hooks'), 'modules/chat/hooks (2)', 'nested labels keep their full path and carry their own count');
  assert.equal(frameLabel(host, 'modules/chat/hooks/deep'), 'modules/chat/hooks/deep (1)');
  assert.equal(overlayEdges(host).length, 3, 'at full package depth all three boundary edges survive');

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: ENTITY_LOD_DEPTH });
  for (const node of host.querySelectorAll('.uml-node')) assert.equal(displayOf(node), '');
  assert.equal(overlayEdges(host).length, 0, 'the package overlay is removed at the entity level');
  for (const edge of host.querySelectorAll('.uml-edge')) assert.equal(displayOf(edge), '');
  assert.equal(frameLabel(host, 'modules/chat'), 'modules/chat', 'the collapsed count is restored');
  assert.equal(host.querySelector('svg'), svg);
  assert.equal(svg?.getAttribute('data-lod-sentinel'), 'kept');
});

test('package edges aggregate by the visible ancestor and drop root/internal pairs', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  const hierarchy = buildExplosionHierarchy(host, GRAPH);

  const far = aggregatePackageEdges(hierarchy, GRAPH.edges, PACKAGE_LEVEL_MAX_DEPTH);
  assert.deepEqual(far, [
    { from: 'modules/beta', to: 'modules/chat/hooks', weight: 1 },
    { from: 'modules/chat/hooks', to: 'modules/beta', weight: 2 },
  ]);
  const mid = aggregatePackageEdges(hierarchy, GRAPH.edges);
  assert.deepEqual(mid, [
    { from: 'modules/beta', to: 'modules/chat/hooks', weight: 1 },
    { from: 'modules/chat/hooks', to: 'modules/beta', weight: 1 },
    { from: 'modules/chat/hooks/deep', to: 'modules/beta', weight: 1 },
  ]);

  // An entity whose package could not be resolved (not drawn) contributes no edge.
  assert.deepEqual(aggregatePackageEdges(hierarchy, [
    { from: 'src/elsewhere/x.ts', to: 'src/modules/beta/b.ts', relationType: 'call' },
  ]), []);
});

test('a collapsed edge attaches to the descendant cluster when the ancestor frame was not drawn', () => {
  // A neighbourhood view drops ancestor-only package frames; the overlay must
  // still connect the cluster that is on screen instead of losing the edge.
  const frames = FRAMES.filter((packageId) => packageId !== 'modules/chat/hooks');
  const host = hostWith(svgFixture(frames, GRAPH.nodes.map((node) => node.id)));
  const hierarchy = buildExplosionHierarchy(host, GRAPH);

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: PACKAGE_LOD_DEPTH });

  const lines = overlayEdges(host);
  assert.equal(lines.length, 2);
  assert.ok(
    lines.some(
      (line) =>
        line.getAttribute('data-lod-edge-source') === 'modules/chat/hooks' &&
        line.getAttribute('data-lod-edge-target') === 'modules/beta' &&
        line.getAttribute('data-lod-edge-weight') === '2',
    ),
    'the aggregate uses the union of the deepest drawn frames',
  );
});

test('a stamped data-package-id wins over the id path when the renderer supplies it', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  // The local plantuml-js build stamps the layout model's own parent link.
  for (const node of host.querySelectorAll('.uml-node')) {
    if (node.getAttribute('data-entity-id') === 'src/modules/chat/hooks/a.ts') {
      node.setAttribute('data-package-id', 'modules/chat/deep-ish');
    }
  }

  const hierarchy = buildExplosionHierarchy(host, GRAPH);
  assert.equal(hierarchy.entityPackage.get('src/modules/chat/hooks/a.ts'), 'modules/chat/deep-ish');
  assert.equal(hierarchy.entityPackage.get('src/modules/beta/b.ts'), 'modules/beta');
});

test('the focus package is scrolled back to the container centre on a level cross', () => {
  // Pure offset math: the container is 400×300 at (10, 20); the target is
  // 100×100 centred at client (560, 470). Its centre must land at (210, 170).
  assert.deepEqual(
    centeredScrollOffsets(
      { left: 0, top: 0, width: 400, height: 300 },
      { left: 500, top: 400, width: 100, height: 100 },
      { left: 0, top: 0 },
    ),
    { left: 350, top: 300 },
  );
  assert.deepEqual(
    centeredScrollOffsets(
      { left: 0, top: 0, width: 400, height: 300 },
      { left: 500, top: 400, width: 100, height: 100 },
      { left: 120, top: 30 },
    ),
    { left: 470, top: 330 },
    'the delta is applied on top of the current scroll',
  );

  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 });
  host.getBoundingClientRect = () => ({
    x: 10, y: 20, left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320,
    toJSON: () => ({}),
  }) as DOMRect;
  const target = document.createElement('div');
  target.getBoundingClientRect = () => ({
    x: 510, y: 420, left: 510, top: 420, width: 100, height: 100, right: 610, bottom: 520,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.append(host);

  centerElementInContainer(host, target);
  assert.equal(host.scrollLeft, 350, 'container centre (210) vs target centre (560)');
  assert.equal(host.scrollTop, 300, 'container centre (170) vs target centre (470)');
});

test('the LOD recentres the selected entity’s package when the level changes', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 });
  host.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300,
    toJSON: () => ({}),
  }) as DOMRect;
  const frame = host.querySelector('[data-package-id="modules/beta"]');
  assert.ok(frame !== null);
  frame.getBoundingClientRect = () => ({
    x: 500, y: 300, left: 500, top: 300, width: 200, height: 200, right: 700, bottom: 500,
    toJSON: () => ({}),
  }) as DOMRect;

  const hierarchy = buildExplosionHierarchy(host, GRAPH);
  assert.equal(
    focusPackageOf(hierarchy, ['src/modules/beta/b.ts', null]),
    'modules/beta',
    'the clicked entity names its innermost package',
  );
  assert.equal(focusPackageOf(hierarchy, [null, 'src/modules/beta/b.ts']), 'modules/beta', 'the centre is the fallback');
  assert.equal(focusPackageOf(hierarchy, [null, undefined]), null);

  applyExplosionLod({
    host,
    hierarchy,
    edges: GRAPH.edges,
    depth: ENTITY_LOD_DEPTH,
    focusPackageId: 'modules/beta',
    centerFocus: true,
  });
  assert.equal(host.scrollLeft, 400, 'the frame centre (600) is brought to the container centre (200)');
  assert.equal(host.scrollTop, 250, 'the frame centre (400) is brought to the container centre (150)');
});

/* ── counter-scaled package titles ────────────────────────────────────────────────────────── */

/** A frame carrying a package id, a rect and a label, as the renderer emits it. */
function frameMarkup(packageId: string, x: number, y: number, width: number, height: number): string {
  return (
    `<g data-package-id="${packageId}" class="uml-package">`
    + `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#333333"/>`
    + `<text x="${x + 6}" y="${y + 13}" font-size="12">${packageId}</text>`
    + `</g>`
  );
}

test('package titles are counter-scaled: readable at low zoom and never enlarged at 100%', () => {
  const host = hostWith(`<svg viewBox="0 0 1600 800" width="1600" height="800">${
    FRAMES.map((packageId, index) => frameMarkup(packageId, index * 400, 0, 300, 200)).join('')
  }</svg>`);
  const hierarchy = buildExplosionHierarchy(host, GRAPH);

  applyExplosionLod({ host, hierarchy, edges: [], depth: PACKAGE_LOD_DEPTH, scale: 0.33 });
  const lowZoom = titleLabels(host);
  assert.ok(lowZoom.size > 0, 'the package level draws counter-scaled titles');
  for (const [packageId, label] of lowZoom) {
    // The reading a browser would paint: font-size × the title's inverse scale
    // × the drawing's zoom. jsdom has no layout engine, so this is the same
    // arithmetic the real-browser criterion reads from `getBoundingClientRect`.
    const screenPx = LOD_LABEL_BASE_FONT_PX * label.transformScale * 0.33;
    assert.ok(
      screenPx >= LOD_LABEL_MIN_SCREEN_PX - 1e-6,
      `${packageId}: the title must be at least ${LOD_LABEL_MIN_SCREEN_PX}px on screen, got ${screenPx}`,
    );
    assert.ok(
      screenPx <= LOD_LABEL_MAX_SCREEN_PX + 1e-6,
      `${packageId}: the title must not exceed ${LOD_LABEL_MAX_SCREEN_PX}px, got ${screenPx}`,
    );
    assert.ok(Math.abs(label.screenPx - screenPx) < 1e-3, 'the published reading matches the transform');
    assert.ok(label.text.length > 0, 'a title carries text');
  }

  // At 100% the counter-scaling is off: the title keeps the renderer's own
  // size and is never shrunk below the original font.
  applyExplosionLod({ host, hierarchy, edges: [], depth: PACKAGE_LOD_DEPTH, scale: 1 });
  assert.equal(lodLabelScreenFontPx(1), LOD_LABEL_BASE_FONT_PX);
  for (const label of titleLabels(host).values()) {
    assert.ok(
      LOD_LABEL_BASE_FONT_PX * label.transformScale >= LOD_LABEL_BASE_FONT_PX - 1e-6,
      'at 100% the title is not smaller than the original font',
    );
  }
});

test('an overlapping inner title yields to the outer frame, and a narrow frame gets no title', () => {
  const plans = planPackageTitles(
    [
      { packageId: 'outer', text: 'outer (12)', box: { x: 0, y: 0, width: 400, height: 300 } },
      // Nested at the outer frame's top-left: its title would collide.
      { packageId: 'inner', text: 'inner (12)', box: { x: 2, y: 0, width: 200, height: 100 } },
      // 150 user units × 0.33 = 49.5 screen px < the 60px floor.
      { packageId: 'narrow', text: 'narrow (9)', box: { x: 500, y: 0, width: 150, height: 100 } },
    ],
    0.33,
  );
  const ids = plans.map((plan) => plan.packageId);
  assert.ok(ids.includes('outer'), 'the outer (larger) frame keeps its title');
  assert.ok(!ids.includes('inner'), 'the inner title is omitted where it cannot fit');
  assert.ok(!ids.includes('narrow'), 'a frame narrower than the 60px floor gets no title');
  assert.equal(LOD_LABEL_MIN_FRAME_SCREEN_WIDTH_PX, 60);

  // A long title is truncated with an ellipsis rather than overflowing.
  const truncated = planPackageTitles(
    [{ packageId: 'long', text: 'modules/chat/hooks/very/deep (12)', box: { x: 0, y: 0, width: 400, height: 300 } }],
    0.33,
  )[0];
  assert.ok(truncated !== undefined, 'the long title still draws');
  assert.ok(truncated.text.endsWith('…'), `the title truncates with an ellipsis, got ${truncated.text}`);
});

test('the clipping function preserves orthogonality and ends on both frame boundaries', () => {
  const fromBox = { x: 0, y: 0, width: 100, height: 100 };
  const toBox = { x: 300, y: 0, width: 100, height: 100 };
  const route = [
    { x: 50, y: 50 },
    { x: 150, y: 50 },
    { x: 150, y: 25 },
    { x: 350, y: 25 },
    { x: 350, y: 50 },
  ];
  const clipped = clipPolylineToFrames(route, fromBox, toBox);
  assert.ok(clipped !== null, 'the route leaves A and enters B, so it clips');
  assert.deepEqual(clipped, [
    { x: 100, y: 50 },
    { x: 150, y: 50 },
    { x: 150, y: 25 },
    { x: 300, y: 25 },
  ]);
  assert.ok(isOrthogonal(clipped ?? []), 'every clipped segment is horizontal or vertical');
  const first = clipped?.[0];
  const last = clipped?.[clipped.length - 1];
  assert.equal(first?.x, fromBox.x + fromBox.width, 'the start sits on the source frame boundary');
  assert.equal(last?.x, toBox.x, 'the end sits on the target frame boundary');
});

test('package edges reuse an orthogonal route: one path per pair, thicker with weight, no <line>', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  const hierarchy = buildExplosionHierarchy(host, GRAPH);

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: PACKAGE_LOD_DEPTH, scale: 0.33 });

  const paths = overlayEdges(host);
  assert.equal(paths.length, 2, 'the forward and reverse package pairs are two routes');
  const forward = paths.find(
    (path) =>
      path.getAttribute('data-lod-edge-source') === 'modules/chat/hooks'
      && path.getAttribute('data-lod-edge-target') === 'modules/beta',
  );
  const backward = paths.find(
    (path) =>
      path.getAttribute('data-lod-edge-source') === 'modules/beta'
      && path.getAttribute('data-lod-edge-target') === 'modules/chat/hooks',
  );
  assert.ok(forward !== undefined && backward !== undefined);
  assert.equal(forward.getAttribute('data-lod-edge-weight'), '2', 'two entity edges merge into one package path');
  assert.ok(
    Number(forward.getAttribute('stroke-width')) > Number(backward.getAttribute('stroke-width')),
    'the merged line is thicker than the single one',
  );
  for (const path of paths) {
    const points = polylineFromPathData(path.getAttribute('d') ?? '');
    assert.ok(points.length >= 2, 'the path carries a usable polyline');
    assert.ok(isOrthogonal(points), 'the relation line never draws a diagonal');
  }

  // The shipped defect was a centre-to-centre <line>; the overlay must not
  // produce one at any level.
  assert.equal(host.querySelectorAll('line.arch-lod-package-edge').length, 0);
});

test('without a drawn route the package edge degrades to an orthogonal L', () => {
  const connector = orthogonalConnector(
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 300, y: 250, width: 100, height: 100 },
  );
  assert.ok(connector.length >= 3, 'an L needs a corner');
  assert.ok(isOrthogonal(connector), 'the fallback never draws a diagonal');
  assert.deepEqual(connector[0], { x: 100, y: 50 }, 'the L starts on the source frame boundary');
  const last = connector[connector.length - 1];
  assert.equal(last.x, 300, 'the L ends on the target frame boundary');
  assert.ok(last.y >= 250 && last.y <= 350, 'the end lies on the target frame edge');
});

test('the entity level draws no title overlay, so entity labels are untouched', () => {
  const host = hostWith(svgFixture(FRAMES, GRAPH.nodes.map((node) => node.id)));
  const hierarchy = buildExplosionHierarchy(host, GRAPH);

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: PACKAGE_LOD_DEPTH, scale: 0.33 });
  assert.ok(host.querySelector(`[${LOD_LABELS_LAYER_ATTRIBUTE}]`) !== null);

  applyExplosionLod({ host, hierarchy, edges: GRAPH.edges, depth: ENTITY_LOD_DEPTH, scale: 1 });
  assert.equal(host.querySelector(`[${LOD_LABELS_LAYER_ATTRIBUTE}]`), null, 'the entity level removes the overlay');
  assert.equal(host.querySelector('[data-architecture-lod-edges]'), null);
});
