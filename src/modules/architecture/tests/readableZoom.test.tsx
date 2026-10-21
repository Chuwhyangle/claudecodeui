import assert from 'node:assert/strict';

import { test } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import {
  buildSeedHierarchy,
  canvasIsTooWide,
  decideReadableZoom,
  densestSeedPackage,
  MIN_READABLE_FONT_PX,
  READABLE_ZOOM_SCALE,
  readableFocusPackage,
  RENDERED_LABEL_FONT_PX,
  seedPackageCount,
  WIDE_CANVAS_ASPECT_RATIO,
} from '@/modules/architecture/readableZoom';
import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';
import { MIN_ZOOM_SCALE } from '@/modules/architecture/svgViewport';

/**
 * The readable default of the architecture diagram.
 *
 * A fit that shows the whole graph can still be unreadable: at 3.5% the
 * renderer's 13px labels are a third of a pixel tall. These cases pin the
 * policy that replaces that smear with either a legible focus on the densest
 * seeded package or an honest whole-graph overview carrying a "zoom into …"
 * hint, and the aspect guard that collapses a band-shaped canvas.
 */

/** Alpha and beta each hold one seed; gamma is reachable but not seeded. */
const GRAPH: ArchitectureRendererGraph = {
  nodes: [
    { id: 'src/modules/alpha/a.ts', label: 'a', distance: 0 },
    { id: 'src/modules/alpha/b.ts', label: 'b', distance: 1 },
    { id: 'src/modules/beta/c.ts', label: 'c', distance: 0 },
    { id: 'src/modules/beta/d.ts', label: 'd', distance: 1 },
    { id: 'src/modules/beta/e.ts', label: 'e', distance: 1 },
    { id: 'src/modules/gamma/f.ts', label: 'f', distance: 2 },
  ],
  edges: [],
};

const HIERARCHY = buildSeedHierarchy(GRAPH);

/** The quay session's measured drawing: 32880×9860 fitted into 1151×700. */
const HUGE_NATURAL = { width: 32880, height: 9860 };
const DESKTOP_VIEWPORT = { width: 1151, height: 700 };
/** The geometric (whole-graph) fit of that pair, clamped by the manual 5% floor. */
const HUGE_FIT = MIN_ZOOM_SCALE;

/** The English copy, read the way the component reads it. */
const ENGLISH = (enCommon as unknown as {
  architecture: { plantuml: { readable: Record<string, string> } };
}).architecture.plantuml.readable;

test('the readable scale is derived from the smallest readable label', () => {
  assert.equal(RENDERED_LABEL_FONT_PX, 13);
  assert.equal(MIN_READABLE_FONT_PX, 9);
  assert.equal(READABLE_ZOOM_SCALE, 9 / 13);
  assert.ok(READABLE_ZOOM_SCALE > MIN_ZOOM_SCALE, 'readable is stricter than the manual zoom floor');
});

test('a fit below the readable scale opens in focus mode on the densest seeded package', () => {
  const decision = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
  });

  assert.equal(decision.defaultMode, 'focus', 'an unreadable fit must not be the default');
  assert.equal(decision.mode, 'focus');
  assert.equal(decision.scale, READABLE_ZOOM_SCALE, 'focus renders at the readable floor');
  // Alpha is 1 seed / 2 entities = 0.5, beta is 1/3; modules is their 0.4 ancestor.
  assert.equal(decision.focusPackageId, 'modules/alpha');
  assert.equal(decision.overviewHint, null, 'focus mode carries no "zoom in" hint');
  assert.equal(decision.collapsedForAspect, false);
});

test('a fit at or above the readable scale stays in the whole-graph overview', () => {
  const decision = decideReadableZoom({
    fitScale: 0.9,
    natural: { width: 1000, height: 500 },
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
  });

  assert.equal(decision.defaultMode, 'overview');
  assert.equal(decision.mode, 'overview');
  assert.equal(decision.scale, 0.9, 'overview applies the geometric fit unchanged');
});

test('the toolbar switches between focus and overview, and overview names the package to zoom into', () => {
  const focused = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
    mode: 'focus',
  });
  const overview = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
    mode: 'overview',
  });

  // An explicit mode wins over the drawing's own default, without changing the
  // scale each mode maps to.
  assert.equal(focused.mode, 'focus');
  assert.equal(overview.mode, 'overview');
  assert.equal(overview.scale, HUGE_FIT, 'overview shows the whole graph even when it is tiny');
  assert.equal(overview.overviewHint?.packageId, 'modules/alpha');
  assert.equal(overview.overviewHint?.packageCount, 1, 'alpha plus one other seeded package (beta)');
  assert.equal(overview.overviewHint?.zoomPercent, 5);

  // The shipped copy states both the package and the count.
  assert.match(ENGLISH.overviewHint, /\{\{package\}\}/);
  assert.match(ENGLISH.overviewHint, /\{\{count\}\}/);
  const rendered = ENGLISH.overviewHint
    .replace('{{zoom}}', String(overview.overviewHint?.zoomPercent))
    .replace('{{package}}', String(overview.overviewHint?.packageId))
    .replace('{{count}}', String(overview.overviewHint?.packageCount));
  assert.match(rendered, /modules\/alpha/, 'the hint names the largest seeded package');
  assert.match(rendered, /1 other package/, 'the hint states how many others share the drawing');
});

test('a selected entity wins over the density ranking, like the explosion LOD', () => {
  assert.equal(
    readableFocusPackage(HIERARCHY, ['src/modules/gamma/f.ts']),
    'modules/gamma',
    'the focus follows what the reader selected, even when it holds no seed',
  );
  assert.equal(
    readableFocusPackage(HIERARCHY, [null, undefined]),
    'modules/alpha',
    'with no selection the densest seeded package is the fallback',
  );
});

test('seed ranking reads the payload tree: count, density, and deterministic ties', () => {
  const densest = densestSeedPackage(HIERARCHY);
  assert.equal(densest?.packageId, 'modules/alpha');
  assert.equal(densest?.seedCount, 1);
  assert.equal(densest?.entityCount, 2);
  assert.equal(densest?.density, 0.5);

  assert.equal(seedPackageCount(HIERARCHY), 2, 'ancestor-only packages are not counted twice');
  assert.equal(HIERARCHY.packages.get('modules/alpha')?.descendantSeedCount, 1);
  assert.equal(HIERARCHY.packages.get('modules')?.descendantSeedCount, 2, 'ancestors accumulate their subtree');
});

test('a canvas far wider than its container is flagged for the collapsed overview', () => {
  // 52040×3012 (the measured explosion drawing) in a 1151×700 panel: ~10.5× the
  // container's own aspect ratio.
  assert.equal(canvasIsTooWide({ width: 52040, height: 3012 }, DESKTOP_VIEWPORT), true);
  assert.equal(WIDE_CANVAS_ASPECT_RATIO, 6);

  const decision = decideReadableZoom({
    fitScale: 0.02,
    natural: { width: 52040, height: 3012 },
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
  });
  assert.equal(decision.collapsedForAspect, true, 'the caller must collapse this drawing');
  assert.match(ENGLISH.collapsed, /collapsed/i, 'the notice says the drawing was collapsed');
  assert.ok(ENGLISH.collapsed.includes('overview'), 'the notice names the fallback view');

  // A merely wide drawing keeps its view.
  assert.equal(canvasIsTooWide({ width: 2000, height: 1000 }, DESKTOP_VIEWPORT), false);
  // No measurement is not evidence of a band.
  assert.equal(canvasIsTooWide({ width: 52040, height: 3012 }, { width: 0, height: 0 }), false);
});

test('an empty or package-less graph yields no focus target without throwing', () => {
  const empty = buildSeedHierarchy({ nodes: [], edges: [] });
  const decision = decideReadableZoom({
    fitScale: 0.01,
    natural: { width: 1000, height: 500 },
    viewport: DESKTOP_VIEWPORT,
    hierarchy: empty,
  });

  assert.equal(decision.mode, 'focus');
  assert.equal(decision.scale, READABLE_ZOOM_SCALE);
  assert.equal(decision.focusPackageId, null);
  assert.equal(decision.overviewHint, null);
});
