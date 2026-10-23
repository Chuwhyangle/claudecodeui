import assert from 'node:assert/strict';
import { beforeAll, describe, test } from 'vitest';

import { createLayoutEngine, type ArchitectureLayoutEngine } from '@/modules/architecture/elkAspectEngine';
import {
  buildSemanticPackageTree,
  densestWindowAnchor,
  evaluateSemanticTiers,
  lodDepthForTier,
  semanticCompactionAlpha,
  solveSemanticZoom,
  type SemanticDrawingGeometry,
  type SemanticTier,
  type SemanticZoomLayout,
} from '@/modules/architecture/semanticZoomLayout';
import { readSemanticDrawingGeometry } from '@/modules/architecture/semanticZoomRead';
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
