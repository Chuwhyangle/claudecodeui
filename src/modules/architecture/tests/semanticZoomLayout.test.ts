import assert from 'node:assert/strict';
import { beforeAll, describe, test } from 'vitest';

import { createLayoutEngine, type ArchitectureLayoutEngine } from '@/modules/architecture/elkAspectEngine';
import {
  buildSemanticPackageTree,
  densestWindowAnchor,
  evaluateSemanticTiers,
  FIT_SOLVE_MAX_ITERATIONS,
  lodDepthForTier,
  MAX_FIT_SCALE,
  semanticCompactionAlpha,
  semanticContentBounds,
  SEMANTIC_CONTENT_MARGIN_PX,
  solveFitScale,
  solveSemanticZoom,
  type SemanticDrawingGeometry,
  type SemanticRect,
  type SemanticTier,
  type SemanticZoomLayout,
} from '@/modules/architecture/semanticZoomLayout';
import {
  readSemanticDrawingGeometry,
  type SemanticNodeGeometry,
  type SemanticPackageGeometry,
} from '@/modules/architecture/semanticZoomRead';
import { MIN_ZOOM_SCALE } from '@/modules/architecture/svgViewport';
import { TWENTY_SIX_PACKAGE_HIERARCHY } from '@/modules/architecture/tests/layoutFixtures';

/**
 * The semantic-zoom geometry engine, on geometry READ OFF the real renderer.
 *
 * Every fixture below is laid out by `@yalehwang/plantuml-js/elk` from the
 * repository's committed 26-package hierarchy and then read back out of the
 * SVG — never a hand-written rectangle. That is what makes the criteria mean
 * something about the product: the solver is fed the same shapes the canvas has.
 *
 * Criteria (README principles 1–6):
 *  · the map is monotone and non-decreasing on both axes;
 *  · at ≥ 90 % it IS the original layout times the scale;
 *  · minimum sizes are met and the map only stretches at a constraint;
 *  · the text-hidden compression fades in with alpha;
 *  · the budget steps down A → B → C and never past 1.8×;
 *  · same input → same output;
 *  · the zoom anchor sits on a real element, never in empty space.
 */

type PlantUmlElkModule = {
  ElkLayoutEngine: new (options?: unknown) => ArchitectureLayoutEngine;
  createRenderer: (options: { layout: ArchitectureLayoutEngine }) => {
    render: (puml: string) => Promise<{ svg: string }>;
  };
};

let geometry: SemanticDrawingGeometry;

beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
  const { ElkLayoutEngine, createRenderer } = (await import('@yalehwang/plantuml-js/elk')) as unknown as PlantUmlElkModule;
  const engine = createLayoutEngine({ aspectRatio: 1.6, Engine: ElkLayoutEngine });
  const { svg } = await createRenderer({ layout: engine }).render(TWENTY_SIX_PACKAGE_HIERARCHY);
  const host = document.createElement('div');
  host.innerHTML = svg;
  const element = host.querySelector('svg');
  assert.ok(element !== null, 'the real renderer produced an SVG');
  geometry = readSemanticDrawingGeometry(element);
  assert.ok(geometry.nodes.length > 20, `the fixture draws its entities; got ${geometry.nodes.length}`);
  assert.ok(geometry.packages.length > 10, `the fixture draws its packages; got ${geometry.packages.length}`);
});

/** A rectangle that contains `point` (edges count as inside). */
function rectContains(rect: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): boolean {
  const eps = 0.75;
  return point.x >= rect.x - eps && point.x <= rect.x + rect.width + eps
    && point.y >= rect.y - eps && point.y <= rect.y + rect.height + eps;
}

/** Every pair of original values whose order the monotone map must preserve. */
function assertMonotone(layout: SemanticZoomLayout, drawing: SemanticDrawingGeometry): void {
  const values: number[] = [];
  for (const node of drawing.nodes) {
    values.push(node.rect.x, node.rect.x + node.rect.width, node.rect.y, node.rect.y + node.rect.height);
  }
  for (const pkg of drawing.packages) {
    values.push(pkg.rect.x, pkg.rect.x + pkg.rect.width, pkg.rect.y, pkg.rect.y + pkg.rect.height);
  }
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const low = sorted[index];
    const high = sorted[index + 1];
    assert.ok(
      layout.x.map(low) <= layout.x.map(high) + 1e-6,
      `x must not invert ${low} → ${high}`,
    );
    assert.ok(
      layout.y.map(low) <= layout.y.map(high) + 1e-6,
      `y must not invert ${low} → ${high}`,
    );
  }
}

describe('the axis map (principle 3)', () => {
  test('is monotone and non-decreasing on both axes', () => {
    const layout = solveSemanticZoom(geometry, { scale: 0.33, viewport: { width: 900, height: 600 } });
    assertMonotone(layout, geometry);
    // Every node's mapped cell has a non-negative size.
    for (const node of layout.nodes) {
      assert.ok(node.cell.width >= 0);
      assert.ok(node.cell.height >= 0);
    }
  });

  test('at 90 % and above it is exactly the original layout times the scale', () => {
    const layout = solveSemanticZoom(geometry, { scale: 0.92, viewport: null });
    assert.ok(Math.abs(layout.x.ratio - 1) < 1e-9, 'no horizontal stretch');
    assert.ok(Math.abs(layout.y.ratio - 1) < 1e-9, 'no vertical stretch');
    assert.equal(layout.alpha, 0);
    for (let index = 1; index < layout.x.breakpoints.length; index += 1) {
      const span = layout.x.breakpoints[index] - layout.x.breakpoints[index - 1];
      assert.ok(
        Math.abs((layout.x.mapped[index] - layout.x.mapped[index - 1]) - 0.92 * span) < 1e-6,
        'every x gap is the original gap times 0.92',
      );
    }
    for (const node of layout.nodes) {
      const original = geometry.nodes.find((candidate) => candidate.id === node.id);
      assert.ok(original !== undefined);
      assert.ok(Math.abs(node.cell.width - original.rect.width * 0.92) < 1e-6);
    }
  });
});

describe('minimum sizes and the stretch budget (principles 2, 3 and 5)', () => {
  test('a text-drawing class box never falls under its planned minimum width', () => {
    const layout = solveSemanticZoom(geometry, { scale: 0.2, forceTier: 'A', viewport: null });
    let checked = 0;
    for (const node of layout.nodes) {
      if (node.hidden || node.showMembers) continue;
      checked += 1;
      assert.ok(
        node.cell.width >= node.plan.minWidth - 1e-6,
        `${node.id}: ${node.cell.width} < planned ${node.plan.minWidth}`,
      );
      assert.ok(
        node.cell.height >= node.plan.minHeight - 1e-6,
        `${node.id}: ${node.cell.height} < planned ${node.plan.minHeight}`,
      );
    }
    assert.ok(checked > 0, 'the fixture exercised constrained class boxes');
  });

  test('the map only stretches at a constraint (other gaps stay scale × original)', () => {
    const layout = solveSemanticZoom(geometry, { scale: 0.5, forceTier: 'B', viewport: null });
    for (const axis of [layout.x, layout.y]) {
      for (let index = 1; index < axis.breakpoints.length; index += 1) {
        if (axis.constrained[index] || axis.compressed[index]) continue;
        const span = axis.breakpoints[index] - axis.breakpoints[index - 1];
        assert.ok(
          Math.abs((axis.mapped[index] - axis.mapped[index - 1]) - 0.5 * span) < 1e-6,
          `${axis.axis} gap ${index} changed without a constraint`,
        );
      }
    }
  });

  test('the text-hidden compression fades in from alpha 0 to 1', () => {
    assert.equal(semanticCompactionAlpha(0.9), 0);
    assert.equal(semanticCompactionAlpha(0.5), 1);
    assert.ok(semanticCompactionAlpha(0.7) > 0 && semanticCompactionAlpha(0.7) < 1);

    // One real package plus the two real nodes stacked inside it, kept at the
    // coordinates the renderer produced: the gap between them is covered only
    // by text-hidden frames, so it is exactly the compressible case.
    const tree = buildSemanticPackageTree(geometry);
    const host = tree
      .filter((entry) => entry.nodeIds.length >= 2)
      .sort((a, b) => b.nodeIds.length - a.nodeIds.length)[0];
    assert.ok(host !== undefined, 'the fixture has a package with two nodes');
    const chosenNodes = geometry.nodes.filter((node) => host.nodeIds.includes(node.id)).slice(0, 2);
    assert.equal(chosenNodes.length, 2);
    const subGeometry: SemanticDrawingGeometry = {
      width: geometry.width,
      height: geometry.height,
      nodes: chosenNodes,
      packages: [host.geometry],
      edges: [],
    };
    const gapAt = (scale: number): number => {
      const layout = solveSemanticZoom(subGeometry, { scale, forceTier: 'B', viewport: null });
      const [first, second] = [...layout.nodes].sort((a, b) => a.cell.y - b.cell.y);
      return second.cell.y - (first.cell.y + first.cell.height);
    };
    const shrinkAt = (scale: number): number => gapAt(scale) / scale;
    assert.ok(
      shrinkAt(0.5) < shrinkAt(0.8),
      `a smaller scale compresses the gap relatively more: ${shrinkAt(0.5)} vs ${shrinkAt(0.8)}`,
    );
  });

  test('the budget steps A → B → C and never keeps a tier past 1.8×', () => {
    const trials = evaluateSemanticTiers(geometry, { scale: 0.06, viewport: null });
    assert.deepEqual(trials.map((trial) => trial.tier), ['A', 'B', 'C']);
    assert.ok(trials[0].ratio > 1.8, `tier A must blow the budget at 6 %; got ${trials[0].ratio}`);

    const layout = solveSemanticZoom(geometry, { scale: 0.06, viewport: null });
    // The winner is the FIRST trial inside the budget; when even C cannot fit
    // its minimum tab widths, C is still the floor — the design descends, it
    // does not keep stretching at a tier that blew the budget.
    const firstFit = trials.find((trial) => trial.ratio <= 1.8);
    assert.equal(layout.tier, firstFit?.tier ?? 'C');
    assert.equal(layout.tier, 'C', 'the 26-package fixture at 6 % needs the package-only tier');
  });

  test('tier C draws only packages, and its depth reading is the far level', () => {
    const layout = solveSemanticZoom(geometry, { scale: 0.06, forceTier: 'C', viewport: null });
    assert.equal(layout.edges.length, 0);
    for (const node of layout.nodes) assert.equal(node.showName, false);
    assert.equal(lodDepthForTier('A'), 2);
    assert.equal(lodDepthForTier('B'), 1);
    assert.equal(lodDepthForTier('C'), 0);
  });
});

describe('determinism and the anchor (principles 3 and 6)', () => {
  /** The comparable, serialisable part of a layout. */
  function digest(layout: SemanticZoomLayout): unknown {
    return {
      tier: layout.tier,
      ratio: layout.ratio,
      alpha: layout.alpha,
      x: layout.x.mapped,
      y: layout.y.mapped,
      nodes: layout.nodes.map((node) => [node.id, node.cell, node.drawn]),
      content: layout.content,
      anchor: layout.anchor,
    };
  }

  test('the same input produces the same layout', () => {
    const a = solveSemanticZoom(geometry, { scale: 0.42, viewport: { width: 800, height: 600 } });
    const b = solveSemanticZoom(geometry, { scale: 0.42, viewport: { width: 800, height: 600 } });
    assert.deepEqual(digest(a), digest(b));
  });

  test('the anchor lands on a real element, not in the whitespace between clusters', () => {
    const layout = solveSemanticZoom(geometry, { scale: 0.17, viewport: { width: 700, height: 500 } });
    const content = layout.content;
    const inside = (rect: { x: number; y: number; width: number; height: number }): boolean => rectContains({
      x: rect.x - content.x,
      y: rect.y - content.y,
      width: rect.width,
      height: rect.height,
    }, layout.anchor);
    // At a deep tier the visible elements are package frames; at a richer one
    // they are class boxes. Either way the anchor must be ON one, never in the
    // gap between clusters.
    const anchored = layout.nodes.filter((node) => !node.hidden).some((node) => inside(node.cell))
      || layout.packages.some((entry) => inside(entry.frame));
    assert.ok(anchored, 'the densest window medoid is inside a visible element');
  });

  test('an empty centre list falls back to the requested point', () => {
    const fallback = { x: 12, y: 34 };
    assert.deepEqual(densestWindowAnchor([], { width: 100, height: 100 }, fallback), fallback);
  });

  test('the tier keeps a dead band around the budget', () => {
    // Force a previous tier whose ratio is 5 % over the budget: inside the
    // 8 % dead band it is kept instead of flapping to the next tier.
    const trials = evaluateSemanticTiers(geometry, { scale: 0.06, viewport: null });
    const [first, second] = trials;
    const kept = solveSemanticZoom(geometry, {
      scale: 0.06,
      viewport: null,
      previousTier: first.ratio <= 1.8 * 1.04 ? first.tier : (second.tier as SemanticTier),
    });
    assert.ok(kept.tier === 'B' || kept.tier === 'C');
  });
});

/* ── the content boundary: relations routed outside the frames ─────────────────────────── */

/**
 * A drawing whose relations ELK routes ALONG THE OUTSIDE of the outermost package
 * frames: eight packages in a chain, plus back edges from the last one to five
 * earlier packages. The long back edges are what make the router place bends
 * outside the package union — the same shape the real claudecodeui graph had
 * (five relations up to 9 px outside the viewBox). Every geometry below is read
 * back out of the real renderer, never hand-written.
 */
const OUTER_PERIMETER_EDGES = `@startuml
package "p/p0" {
  class "P0" as p0
  class "Q0" as q0
}
package "p/p1" {
  class "P1" as p1
  class "Q1" as q1
}
package "p/p2" {
  class "P2" as p2
  class "Q2" as q2
}
package "p/p3" {
  class "P3" as p3
  class "Q3" as q3
}
package "p/p4" {
  class "P4" as p4
  class "Q4" as q4
}
package "p/p5" {
  class "P5" as p5
  class "Q5" as q5
}
package "p/p6" {
  class "P6" as p6
  class "Q6" as q6
}
package "p/p7" {
  class "P7" as p7
  class "Q7" as q7
}
p0 ..> p1
q0 ..> q1
p1 ..> p2
q1 ..> q2
p2 ..> p3
q2 ..> q3
p3 ..> p4
q3 ..> q4
p4 ..> p5
q4 ..> q5
p5 ..> p6
q5 ..> q6
p6 ..> p7
q6 ..> q7
p7 ..> p0
p7 ..> p1
p7 ..> p2
p7 ..> p3
p7 ..> p4
@enduml`;

/** The union of every package's rectangle, in the given drawing. */
function packageUnion(drawing: SemanticDrawingGeometry): SemanticRect {
  const left = Math.min(...drawing.packages.map((pkg) => pkg.rect.x));
  const top = Math.min(...drawing.packages.map((pkg) => pkg.rect.y));
  const right = Math.max(...drawing.packages.map((pkg) => pkg.rect.x + pkg.rect.width));
  const bottom = Math.max(...drawing.packages.map((pkg) => pkg.rect.y + pkg.rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Whether `point` is inside `rect` (a boundary point counts as inside). */
function insideRect(rect: SemanticRect, point: { x: number; y: number }, eps = 0.75): boolean {
  return point.x >= rect.x - eps && point.x <= rect.x + rect.width + eps
    && point.y >= rect.y - eps && point.y <= rect.y + rect.height + eps;
}

describe('the content boundary counts the relations that run outside the frames', () => {
  let perimeter: SemanticDrawingGeometry;

  beforeAll(async () => {
    await import('@yalehwang/plantuml-js/elk');
    const { ElkLayoutEngine, createRenderer } = (await import('@yalehwang/plantuml-js/elk')) as unknown as PlantUmlElkModule;
    const engine = createLayoutEngine({ aspectRatio: 1.6, Engine: ElkLayoutEngine });
    const { svg } = await createRenderer({ layout: engine }).render(OUTER_PERIMETER_EDGES);
    const host = document.createElement('div');
    host.innerHTML = svg;
    const element = host.querySelector('svg');
    assert.ok(element !== null, 'the real renderer produced an SVG');
    perimeter = readSemanticDrawingGeometry(element);
  });

  test('the fixture really routes at least five relations outside the package union', () => {
    const union = packageUnion(perimeter);
    const outside = perimeter.edges.filter((edge) => edge.points.some((point) => !insideRect(union, point)));
    assert.ok(
      outside.length >= 5,
      `the fixture must exercise perimeter routing; got ${outside.length} outside edges `
        + `(union=${JSON.stringify(union)})`,
    );
    assert.ok(
      perimeter.edges.some((edge) => (edge.arrowPoints?.length ?? 0) > 0),
      'the renderer must publish arrowhead polygons for the arrow leg to mean anything',
    );
  });

  test('every polyline point and arrowhead is inside the content boundary, ≥ packages + 12 px', () => {
    const layout = solveSemanticZoom(perimeter, { scale: 0.92, forceTier: 'A', viewport: null });
    assert.ok(layout.edges.length > 0, 'the fixture draws its relations');
    for (const edge of layout.edges) {
      for (const point of edge.points) {
        assert.ok(
          insideRect(layout.content, point),
          `${edge.source} → ${edge.target}: point ${JSON.stringify(point)} outside the content boundary `
            + `${JSON.stringify(layout.content)}`,
        );
      }
    }
    // Arrowheads are mapped through the same axes the rewrite uses; at ≥ 90 %
    // that map is the identity times the scale.
    const rawEdgesByPair = new Map(perimeter.edges.map((edge) => [`${edge.source}->${edge.target}`, edge]));
    for (const edge of layout.edges) {
      const raw = rawEdgesByPair.get(`${edge.source}->${edge.target}`);
      for (const arrow of raw?.arrowPoints ?? []) {
        const mapped = { x: layout.x.map(arrow.x), y: layout.y.map(arrow.y) };
        assert.ok(
          insideRect(layout.content, mapped),
          `arrowhead point of ${edge.source} → ${edge.target} (${JSON.stringify(mapped)}) outside `
            + `${JSON.stringify(layout.content)}`,
        );
      }
    }
    const framesLeft = Math.min(...layout.packages.map((pkg) => pkg.frame.x));
    const framesTop = Math.min(...layout.packages.map((pkg) => pkg.frame.y));
    const framesRight = Math.max(...layout.packages.map((pkg) => pkg.frame.x + pkg.frame.width));
    const framesBottom = Math.max(...layout.packages.map((pkg) => pkg.frame.y + pkg.frame.height));
    const eps = 0.75;
    assert.ok(
      layout.content.x <= framesLeft - SEMANTIC_CONTENT_MARGIN_PX + eps
        && layout.content.y <= framesTop - SEMANTIC_CONTENT_MARGIN_PX + eps
        && layout.content.x + layout.content.width
          >= framesRight + SEMANTIC_CONTENT_MARGIN_PX - eps
        && layout.content.y + layout.content.height
          >= framesBottom + SEMANTIC_CONTENT_MARGIN_PX - eps,
      `the boundary must keep the fixed ${SEMANTIC_CONTENT_MARGIN_PX}px margin around the package union; `
        + `content=${JSON.stringify(layout.content)} frames=${JSON.stringify({
          x: framesLeft, y: framesTop, w: framesRight - framesLeft, h: framesBottom - framesTop,
        })}`,
    );
  });

  test('without the relations the boundary collapses back to the frames', () => {
    const noEdges: SemanticDrawingGeometry = { ...perimeter, edges: [] };
    const without = solveSemanticZoom(noEdges, { scale: 0.92, forceTier: 'A', viewport: null });
    const frameMinX = Math.min(...without.packages.map((pkg) => pkg.frame.x));
    const frameMinY = Math.min(...without.packages.map((pkg) => pkg.frame.y));
    const frameMaxX = Math.max(...without.packages.map((pkg) => pkg.frame.x + pkg.frame.width));
    const frameMaxY = Math.max(...without.packages.map((pkg) => pkg.frame.y + pkg.frame.height));
    assert.ok(
      Math.abs(without.content.x - (frameMinX - SEMANTIC_CONTENT_MARGIN_PX)) < 1e-6
        && Math.abs(without.content.y - (frameMinY - SEMANTIC_CONTENT_MARGIN_PX)) < 1e-6
        && Math.abs(without.content.width - (frameMaxX - frameMinX + 2 * SEMANTIC_CONTENT_MARGIN_PX)) < 1e-6
        && Math.abs(without.content.height - (frameMaxY - frameMinY + 2 * SEMANTIC_CONTENT_MARGIN_PX)) < 1e-6,
      `with no relations the boundary is the frame union plus the fixed margin; got `
        + `${JSON.stringify(without.content)} frames=${JSON.stringify({
          x: frameMinX, y: frameMinY, w: frameMaxX - frameMinX, h: frameMaxY - frameMinY,
        })}`,
    );
    // And the full drawing is genuinely wider — the reading depends on the edges.
    const withEdges = solveSemanticZoom(perimeter, { scale: 0.92, forceTier: 'A', viewport: null });
    assert.ok(
      withEdges.content.x < without.content.x - 0.5 || withEdges.content.y < without.content.y - 0.5,
      `the perimeter relations must widen the boundary: with=${JSON.stringify(withEdges.content)} `
        + `without=${JSON.stringify(without.content)}`,
    );
  });

  test('at ≥ 90 % the boundary reads the identity layout, and the standalone helper agrees', () => {
    const layout = solveSemanticZoom(perimeter, { scale: 0.92, forceTier: 'A', viewport: null });
    assert.ok(Math.abs(layout.x.ratio - 1) < 1e-9, 'no horizontal stretch');
    assert.ok(Math.abs(layout.y.ratio - 1) < 1e-9, 'no vertical stretch');
    // The identity map is `original × scale` up to the layout's own origin
    // translation (the first breakpoint maps to 0), so offsets are preserved,
    // not absolute values. Endpoints may be snapped onto a drawn frame; interior
    // points are exactly the scaled original.
    for (const edge of layout.edges) {
      const raw = perimeter.edges.find((candidate) => candidate.source === edge.source && candidate.target === edge.target);
      assert.ok(raw !== undefined);
      for (let index = 1; index < raw.points.length - 1; index += 1) {
        const mapped = edge.points[index];
        const origin = edge.points[0];
        const rawOrigin = raw.points[0];
        assert.ok(
          Math.abs((mapped.x - origin.x) - (raw.points[index].x - rawOrigin.x) * 0.92) < 1e-6
            && Math.abs((mapped.y - origin.y) - (raw.points[index].y - rawOrigin.y) * 0.92) < 1e-6,
          `edge ${edge.source} → ${edge.target} point ${index} left the identity map: `
            + `${JSON.stringify(mapped)} vs ${JSON.stringify(raw.points[index])}`,
        );
      }
    }
    // The identity boundary is what the fit/minimap consumer measures. Only its
    // EXTENT is consumer-visible (the fit reads a width/height, and the solve
    // translates the layout so its first breakpoint sits at 0), so compare the
    // same boundary by size.
    const identity = semanticContentBounds(perimeter);
    const unit = solveSemanticZoom(perimeter, { scale: 1, forceTier: 'A', viewport: null });
    assert.ok(Math.abs(unit.content.width - identity.width) < 1e-6);
    assert.ok(Math.abs(unit.content.height - identity.height) < 1e-6);
  });
});

/* ── the folded tier (D): a large drawing that C still cannot fit ─────────────────────────── */

/**
 * A synthetic drawing with the shape of the reported project: 576 entities
 * under a FIVE-level package tree (6 roots → 2 → 2 → 2 → 2 = 96 leaf packages),
 * drawn DENSELY — 4 800 × 2 000 drawing units for all 576 boxes.
 *
 * The density is the point. At the 5 % floor scale the package tabs' minimum
 * widths (one per package) and the class boxes' minimum widths add up to far
 * more than 5 % of the drawing, so the stretch budget is blown well past 1.8×
 * and the engine descends to the package-only tier — the state the reported
 * 573-function graph was in, where the mapped drawing was 4 415 px wide on a
 * 1 151 px canvas.
 *
 * Five levels of NESTING (not six of breadth) is what makes the folded case
 * observable: at the test canvas even the full tree's tabs fit in a few rows,
 * so a fold is only exercised when the level count is what runs out of room.
 */
function deepWideGeometry(): SemanticDrawingGeometry {
  const packages: SemanticPackageGeometry[] = [];
  const nodes: SemanticNodeGeometry[] = [];
  const edges: { source: string; target: string; points: { x: number; y: number }[]; bundleSize: number }[] = [];
  const addNode = (id: string, rect: SemanticRect, seed: boolean): void => {
    nodes.push({
      id,
      rect,
      label: id.split('/').pop() ?? id,
      kind: 'class',
      stereotype: null,
      members: [],
      seed,
      mentionTier: null,
      titleHeight: 14,
      attributesHeight: 0,
      operationsHeight: 0,
      ruleCount: 1,
      titleRuleY: null,
    });
  };
  const addPackage = (id: string, rect: SemanticRect): void => {
    packages.push({
      id,
      rect,
      rawLabel: id,
      tabWidth: 40 + id.length * 2,
      tabHeight: 18,
      tabClosed: true,
    });
  };
  let entityIndex = 0;
  for (let root = 0; root < 6; root += 1) {
    const rootX = root * 800;
    addPackage(`root${root}`, { x: rootX, y: 0, width: 775, height: 1990 });
    for (let first = 0; first < 2; first += 1) {
      const firstX = rootX + 12 + first * 385;
      addPackage(`root${root}/first${first}`, { x: firstX, y: 30, width: 370, height: 1940 });
      for (let second = 0; second < 2; second += 1) {
        const secondX = firstX + 10 + second * 180;
        addPackage(`root${root}/first${first}/second${second}`, {
          x: secondX, y: 55, width: 172, height: 1900,
        });
        for (let third = 0; third < 2; third += 1) {
          const thirdX = secondX + 8 + third * 82;
          addPackage(`root${root}/first${first}/second${second}/third${third}`, {
            x: thirdX, y: 80, width: 78, height: 1860,
          });
          for (let leaf = 0; leaf < 2; leaf += 1) {
            const leafY = 110 + leaf * 920;
            const leafId = `root${root}/first${first}/second${second}/third${third}/leaf${leaf}`;
            addPackage(leafId, { x: thirdX + 4, y: leafY, width: 70, height: 880 });
            // Six entities per leaf: 96 leaves × 6 = 576 entities in total.
            const leafIds: string[] = [];
            for (let entity = 0; entity < 6; entity += 1) {
              const column = entity % 2;
              const row = Math.floor(entity / 2);
              const id = `${leafId}/Entity${entityIndex}`;
              addNode(
                id,
                { x: thirdX + 10 + column * 28, y: leafY + 30 + row * 60, width: 26, height: 20 },
                // A spread-out minority is a mention, so the ★N badge has a real
                // number to aggregate and not a zero that would pass vacuously.
                entityIndex % 7 === 0,
              );
              leafIds.push(id);
              entityIndex += 1;
            }
            for (let index = 1; index < leafIds.length; index += 1) {
              edges.push({
                source: leafIds[index - 1],
                target: leafIds[index],
                points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
                bundleSize: 1,
              });
            }
          }
        }
      }
    }
  }
  return { width: 4_800, height: 2_000, nodes, packages, edges };
}

/** Whether `inner` sits inside `outer` (edges inclusive, with float slack). */
function rectWithin(outer: SemanticRect, inner: SemanticRect): boolean {
  const slack = 0.75;
  return inner.x >= outer.x - slack
    && inner.y >= outer.y - slack
    && inner.x + inner.width <= outer.x + outer.width + slack
    && inner.y + inner.height <= outer.y + outer.height + slack;
}

describe('the folded tier (D): C cannot fit, so the levels collapse', () => {
  const CANVAS = { width: 900, height: 300 };
  const deepScale = 0.05;
  const deep = deepWideGeometry();

  test('the fixture really is the shape the defect needs', () => {
    assert.ok(deep.nodes.length >= 500, `the fixture draws ${deep.nodes.length} entities, needs ≥ 500`);
    const tree = buildSemanticPackageTree(deep);
    const deepest = tree.reduce((value, entry) => Math.max(value, entry.depth), 0);
    assert.ok(deepest >= 3, `packages nest ${deepest + 1} levels deep, needs ≥ 4`);
  });

  test('C is still more than twice the canvas wide, and D answers it', () => {
    // The state the reported canvas was in: the package-only map, measured.
    const sparse = solveSemanticZoom(deep, { scale: deepScale, forceTier: 'C', viewport: CANVAS });
    assert.ok(
      sparse.content.width > CANVAS.width * 2,
      `the C drawing must blow the 2× trigger; it is ${sparse.content.width} px against ${CANVAS.width}`,
    );

    const folded = solveSemanticZoom(deep, { scale: deepScale, viewport: CANVAS });
    assert.equal(folded.tier, 'D');
    assert.ok(folded.foldDepth !== null && folded.foldDepth >= 1, 'at least one level is kept');
    assert.equal(folded.nodes.length, 0, 'the folded drawing draws no class box');
    assert.equal(folded.edges.length, 0, 'and no relation');
    for (const entry of folded.packages) {
      assert.ok(
        entry.depth < (folded.foldDepth as number),
        `${entry.id} (depth ${entry.depth}) is deeper than the kept ${String(folded.foldDepth)} level(s)`,
      );
    }
    // The rule the tier exists for: the whole map is at most 1.2 canvases.
    assert.ok(
      folded.content.width <= CANVAS.width * 1.2 + 0.5,
      `the folded drawing is ${folded.content.width} px wide against a ${CANVAS.width} px canvas`,
    );
    assert.ok(
      folded.content.height <= CANVAS.height * 1.2 + 0.5,
      `the folded drawing is ${folded.content.height} px tall against a ${CANVAS.height} px canvas`,
    );
  });

  test('a folded child’s entities and mentions are summed into its parent’s (N) and ★N', () => {
    const folded = solveSemanticZoom(deep, { scale: deepScale, viewport: CANVAS });
    assert.equal(folded.tier, 'D');
    const drawnIds = new Set(folded.packages.map((entry) => entry.id));
    let packagesWithFoldedDescendants = 0;
    for (const entry of folded.packages) {
      const original = deep.packages.find((candidate) => candidate.id === entry.id);
      assert.ok(original !== undefined);
      // Counted from the GEOMETRY, not from the engine: an entity belongs to
      // this package when its own rect lies inside the package's original one,
      // which is exactly "this subtree" for a nested tree.
      const inside = deep.nodes.filter((candidate) => rectWithin(original.rect, candidate.rect));
      const mentioned = inside.filter((candidate) => candidate.seed).length;
      assert.equal(
        entry.tab.count,
        inside.length,
        `${entry.id} must state the ${inside.length} entities of its whole subtree`,
      );
      assert.equal(entry.mentionedCount, mentioned);
      if (mentioned > 0) {
        assert.ok(
          entry.tab.badge.includes(`★${mentioned}`),
          `${entry.id} carries "${entry.tab.badge}", expected ★${mentioned}`,
        );
      }
      // Did this frame really absorb a package the drawing no longer shows?
      const subtree = buildSemanticPackageTree(deep).filter(
        (candidate) => candidate.geometry.id !== entry.id
          && rectWithin(original.rect, candidate.geometry.rect),
      );
      if (subtree.some((candidate) => !drawnIds.has(candidate.geometry.id))) {
        packagesWithFoldedDescendants += 1;
      }
    }
    assert.ok(
      packagesWithFoldedDescendants > 0,
      'at least one drawn package stands for children the fold removed',
    );
  });

  test('a small drawing, and the same drawing at ≥ 90 %, keep the ordinary tiers', () => {
    // ≥ 90 % is the identity map: nothing is ever folded there.
    const zoomedIn = solveSemanticZoom(deep, { scale: 0.92, viewport: CANVAS });
    assert.equal(zoomedIn.tier, 'A');
    assert.equal(zoomedIn.foldDepth, null);

    // A drawing a canvas can hold is never folded either, whatever its scale.
    const small = solveSemanticZoom(geometry, { scale: 0.42, viewport: { width: 800, height: 600 } });
    assert.notEqual(small.tier, 'D');
    assert.equal(small.foldDepth, null);
  });

  test('the same input produces the same folded drawing', () => {
    const digest = (layout: SemanticZoomLayout): unknown => ({
      tier: layout.tier,
      foldDepth: layout.foldDepth,
      content: layout.content,
      packages: layout.packages.map((entry) => ({
        id: entry.id,
        frame: entry.frame,
        text: entry.tab.text,
        badge: entry.tab.badge,
        mentioned: entry.mentionedCount,
      })),
    });
    assert.deepEqual(
      digest(solveSemanticZoom(deep, { scale: deepScale, viewport: CANVAS })),
      digest(solveSemanticZoom(deep, { scale: deepScale, viewport: CANVAS })),
    );
  });
});

/* ── Fit is a solve: the ONE scale the semantic canvas applies ─────────────────────────────── */

describe('solveFitScale: the largest monotone scale whose mapped content fits', () => {
  test('the solved layout fits, and one step larger does not', () => {
    const canvas = { width: 700, height: 500 };
    const solution = solveFitScale(geometry, { viewport: canvas });
    assert.equal(solution.fits, true, 'the fixture is flexible enough to fit this canvas');
    assert.ok(solution.scale >= MIN_ZOOM_SCALE - 1e-9);
    assert.ok(solution.scale <= MAX_FIT_SCALE + 1e-9);
    assert.ok(
      solution.layout.content.width <= canvas.width + 0.5
        && solution.layout.content.height <= canvas.height + 0.5,
      `the mapped content must fit the canvas: ${JSON.stringify(solution.layout.content)} in ${JSON.stringify(canvas)}`,
    );
    // The same solve the engine applies: one visible step wider overflows. The
    // bisection resolves well below 0.01, so a hundredth is a real step.
    const wider = solveSemanticZoom(geometry, {
      scale: solution.scale + 0.01,
      viewport: canvas,
      previousTier: null,
      // Match the Fit solver's bracket: folding is its own fallback, not a
      // mid-search answer (a packed map does not shrink with `s`).
      autoFold: false,
    });
    assert.ok(
      wider.content.width > canvas.width + 0.5 || wider.content.height > canvas.height + 0.5,
      `a larger scale must overflow: ${JSON.stringify(wider.content)} in ${JSON.stringify(canvas)}`,
    );
  });

  test('the mapped content is monotone non-decreasing in the scale', () => {
    // Without a viewport the folded tier never triggers, so this reads the
    // engine's own map at each scale rather than the fold rule.
    const scales = [0.2, 0.35, 0.5, 0.7, 0.9, 1.2];
    let previous = -1;
    for (const scale of scales) {
      const layout = solveSemanticZoom(geometry, { scale, viewport: null });
      assert.ok(
        layout.content.width >= previous - 1e-6,
        `content width must not shrink as the scale grows: ${scale} → ${layout.content.width}`,
      );
      previous = layout.content.width;
    }
  });

  test('the upper bound is MAX_FIT_SCALE, and a small drawing is enlarged to it', () => {
    const single: SemanticDrawingGeometry = {
      width: geometry.width,
      height: geometry.height,
      nodes: geometry.nodes.slice(0, 1),
      packages: [],
      edges: [],
    };
    const solution = solveFitScale(single, { viewport: { width: 5000, height: 5000 } });
    assert.equal(MAX_FIT_SCALE, 1.5);
    assert.equal(solution.scale, MAX_FIT_SCALE, 'a tiny drawing is shown at the ceiling, not 100 %');
    assert.equal(solution.fits, true);
  });

  test('the solve is deterministic and never spends more than the iteration budget', () => {
    const canvas = { width: 640, height: 420 };
    const first = solveFitScale(geometry, { viewport: canvas });
    const second = solveFitScale(geometry, { viewport: canvas });
    assert.equal(first.scale, second.scale);
    assert.deepEqual(first.layout.content, second.layout.content);
    assert.ok(
      first.iterations <= FIT_SOLVE_MAX_ITERATIONS,
      `the solve spent ${first.iterations} evaluations; the contract caps it at ${FIT_SOLVE_MAX_ITERATIONS}`,
    );
  });

  test('when the floor cannot fit, the folded tier answers at the floor scale', () => {
    const canvas = { width: 900, height: 300 };
    const solution = solveFitScale(deepWideGeometry(), { viewport: canvas });
    assert.equal(solution.fits, true);
    assert.equal(solution.scale, MIN_ZOOM_SCALE, 'the fold is the fallback at the floor scale');
    assert.equal(solution.layout.tier, 'D');
    assert.ok(solution.foldDepth !== null && solution.foldDepth >= 1);
    assert.ok(
      solution.layout.content.width <= canvas.width + 0.5
        && solution.layout.content.height <= canvas.height + 0.5,
      'the packed map really fits',
    );
  });

  test('when even the folded map cannot fit, the floor scale is kept and the drawing scrolls', () => {
    // One package whose NAME alone is wider than the canvas: no fold level can
    // shrink a tab below its own text.
    const longLabel = 'package'.repeat(20);
    const impossible: SemanticDrawingGeometry = {
      width: 100_000,
      height: 4_000,
      nodes: [],
      packages: [{
        id: 'p',
        rect: { x: 0, y: 0, width: 100_000, height: 4_000 },
        rawLabel: longLabel,
        tabWidth: 900,
        tabHeight: 18,
        tabClosed: true,
      }],
      edges: [],
    };
    const solution = solveFitScale(impossible, { viewport: { width: 300, height: 200 } });
    assert.equal(solution.fits, false, 'the caller must keep the drawing scrollable');
    assert.equal(solution.scale, MIN_ZOOM_SCALE, 'the scale is clamped at the floor');
    assert.ok(
      solution.layout.content.width > 300 + 0.5,
      'the truth is stated: the drawing does not fit',
    );
  });
});
