import assert from 'node:assert/strict';

import { test } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import zhCNCommon from '@/modules/i18n/locales/zh-CN/common.json';
import {
  buildSeedHierarchy,
  canvasIsTooWide,
  decideReadableZoom,
  defaultReadableMode,
  densestSeedPackage,
  FIT_CONTROL_FOCUS_KEY,
  FIT_CONTROL_WHOLE_KEY,
  fitControlReading,
  MIN_READABLE_FONT_PX,
  READABLE_MODE_STORAGE_PREFIX,
  READABLE_ZOOM_SCALE,
  readableFocusPackage,
  readableModeStorageKey,
  readStoredReadableMode,
  RENDERED_LABEL_FONT_PX,
  resolveReadableMode,
  seedPackageCount,
  shortPackageName,
  WIDE_CANVAS_ASPECT_RATIO,
  writeStoredReadableMode,
  type ReadableModeStorageLike,
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
const ENGLISH_PLANTUML = (enCommon as unknown as {
  architecture: { plantuml: Record<string, string> & { readable: Record<string, string> } };
}).architecture.plantuml;
const ENGLISH = ENGLISH_PLANTUML.readable;
/** The Chinese bundle is the wording the mobile review asked for. */
const CHINESE_PLANTUML = (zhCNCommon as unknown as {
  architecture: { plantuml: Record<string, string> & { readable: Record<string, string> } };
}).architecture.plantuml;

test('the readable scale is derived from the smallest readable label', () => {
  assert.equal(RENDERED_LABEL_FONT_PX, 13);
  assert.equal(MIN_READABLE_FONT_PX, 9);
  assert.equal(READABLE_ZOOM_SCALE, 9 / 13);
  assert.ok(READABLE_ZOOM_SCALE > MIN_ZOOM_SCALE, 'readable is stricter than the manual zoom floor');
});

test('the default mode follows the geometric fit, and an explicit choice wins', () => {
  // The three arms the phone review asked for: an unreadable fit opens in
  // focus, a readable fit keeps the whole graph, and a persisted choice is
  // never overwritten by either automatic default.
  assert.equal(defaultReadableMode(HUGE_FIT), 'focus', 'a fit below the floor cannot read');
  assert.equal(defaultReadableMode(READABLE_ZOOM_SCALE), 'overview', 'the floor itself reads');
  assert.equal(defaultReadableMode(0.9), 'overview', 'a comfortably fitted drawing reads');

  assert.equal(resolveReadableMode(HUGE_FIT, 'overview'), 'overview', 'the reader chose the whole graph');
  assert.equal(resolveReadableMode(HUGE_FIT, 'focus'), 'focus');
  assert.equal(resolveReadableMode(HUGE_FIT, null), 'focus', 'no choice falls back to the drawing');
  assert.equal(resolveReadableMode(HUGE_FIT, undefined), 'focus');
  assert.equal(resolveReadableMode(0.9, null), 'overview');

  // The decision uses the same rule, so the component and the unit share one
  // definition rather than re-deriving it.
  const unreadable = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
  });
  assert.equal(unreadable.defaultMode, 'focus');
  assert.equal(unreadable.mode, 'focus');
});

test('a fit below the readable scale opens in the readable focus', () => {
  const decision = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
  });

  // The 32880 px drawing fitted into 1151 px needs 5 %; the 13 px labels would
  // draw at 0.65 px. The default is the readable focus at the floor instead.
  assert.equal(decision.defaultMode, 'focus');
  assert.equal(decision.mode, 'focus');
  assert.equal(decision.scale, READABLE_ZOOM_SCALE, 'the default applies the readable floor');
  assert.equal(decision.focusPackageId, 'modules/alpha');
  // Focus needs no "zoom into …" hint: it already IS the zoomed view.
  assert.equal(decision.overviewHint, null);
  // An explicit Overview still shows the whole drawing at its geometric fit.
  const wholeGraph = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
    mode: 'overview',
  });
  assert.equal(wholeGraph.mode, 'overview');
  assert.equal(wholeGraph.scale, HUGE_FIT, 'the explicit whole-graph fit is unchanged');
  assert.equal(wholeGraph.overviewHint?.zoomPercent, Math.round(HUGE_FIT * 100));
  assert.equal(wholeGraph.collapsedForAspect, false);
});

test('the explicit focus arm keeps its readable floor, unchanged by the new default', () => {
  const focused = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
    mode: 'focus',
  });

  assert.equal(focused.mode, 'focus');
  assert.equal(focused.scale, READABLE_ZOOM_SCALE, 'focus renders at the readable floor');
  assert.equal(focused.focusPackageId, 'modules/alpha');
  assert.equal(focused.overviewHint, null, 'focus mode carries no "zoom in" hint');
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

  // The unreadable default is focus even with no package to centre; it must
  // fall back to the readable floor without throwing.
  assert.equal(decision.mode, 'focus');
  assert.equal(decision.scale, READABLE_ZOOM_SCALE);
  assert.equal(decision.focusPackageId, null);
  assert.equal(decision.overviewHint, null);

  // The explicit overview arm keeps the geometric fit.
  const overview = decideReadableZoom({
    fitScale: 0.01,
    natural: { width: 1000, height: 500 },
    viewport: DESKTOP_VIEWPORT,
    hierarchy: empty,
    mode: 'overview',
  });
  assert.equal(overview.mode, 'overview');
  assert.equal(overview.scale, 0.01);
  assert.equal(overview.focusPackageId, null);
});

test('the fit control is only called "Fit to view" when the fit really contains the graph', () => {
  // The 390×844 phone case: the geometric fit is far below the readable floor.
  // The whole-graph default keeps the fit; the explicit Focus arm lands on the
  // readable view and must be labelled as one.
  const focusedDecision = decideReadableZoom({
    fitScale: HUGE_FIT,
    natural: HUGE_NATURAL,
    viewport: { width: 390, height: 700 },
    hierarchy: HIERARCHY,
    mode: 'focus',
  });
  assert.equal(focusedDecision.mode, 'focus');

  const focusedControl = fitControlReading(focusedDecision, 'fit');
  assert.equal(focusedControl.mode, 'focus', 'the mode reading says what the fit applies');
  assert.equal(focusedControl.labelKey, FIT_CONTROL_FOCUS_KEY);
  assert.equal(focusedControl.labelFallback, 'Focus');
  assert.equal(focusedControl.pressed, true, 'aria-pressed follows the applied fit, not the old label');
  assert.equal(focusedControl.focusNotice, true, 'a focused fit must say the whole graph is one choice away');

  // A fit that truly contains the drawing keeps the whole-graph wording.
  const wholeDecision = decideReadableZoom({
    fitScale: 0.9,
    natural: { width: 1000, height: 500 },
    viewport: DESKTOP_VIEWPORT,
    hierarchy: HIERARCHY,
  });
  assert.equal(wholeDecision.mode, 'overview');

  const wholeControl = fitControlReading(wholeDecision, 'fit');
  assert.equal(wholeControl.mode, 'overview');
  assert.equal(wholeControl.labelKey, FIT_CONTROL_WHOLE_KEY);
  assert.equal(wholeControl.labelFallback, 'Fit to view');
  assert.equal(wholeControl.pressed, true);
  assert.equal(wholeControl.focusNotice, false, 'a real fit has nothing to explain');

  // After a manual zoom the control is no longer the pressed one, but it still
  // names the view pressing it would restore.
  const manual = fitControlReading(focusedDecision, 'custom');
  assert.equal(manual.pressed, false);
  assert.equal(manual.focusNotice, false);
  assert.equal(manual.labelKey, FIT_CONTROL_FOCUS_KEY);

  // Before the first measurement there is no decision; the honest default is
  // the plain whole-graph label rather than a guess at focus.
  const unmeasured = fitControlReading(null, 'fit');
  assert.equal(unmeasured.mode, 'overview');
  assert.equal(unmeasured.labelKey, FIT_CONTROL_WHOLE_KEY);
  assert.equal(unmeasured.pressed, true);
});

test('the zoom strip names a package by its last two path segments', () => {
  // The measured long reading: the full path made the strip unusable.
  assert.equal(
    shortPackageName('data/home/yale/work/archguard/src/cli/mcp'),
    'cli/mcp',
    'only the last two segments are shown in the strip',
  );
  // A two-segment id is already short enough and must not lose a segment.
  assert.equal(shortPackageName('modules/alpha'), 'modules/alpha');
  // Degenerate ids keep the helper total: no throw, no leading slash.
  assert.equal(shortPackageName('alpha'), 'alpha');
  assert.equal(shortPackageName(''), '');
  assert.equal(shortPackageName('/alpha//beta/'), 'alpha/beta');
  assert.equal(shortPackageName('a/b/c/d', 3), 'b/c/d');
});

test('both fit labels ship in every reviewed bundle, and the focused one names Overview', () => {
  assert.equal(ENGLISH_PLANTUML.zoomFit, 'Fit to view');
  assert.equal(ENGLISH_PLANTUML.zoomFocus, 'Focus');
  assert.equal(CHINESE_PLANTUML.zoomFit, '适应视图');
  assert.equal(CHINESE_PLANTUML.zoomFocus, '聚焦');

  // The notice tells the reader where the whole drawing is, by the name of the
  // control that shows it.
  assert.match(ENGLISH.focusedFitHint, /Overview/);
  assert.match(ENGLISH.focusedFitHint, /whole graph/i);
  assert.match(CHINESE_PLANTUML.readable.focusedFitHint, /全貌/);
});

/** An in-memory stand-in for `localStorage`, one map per instance. */
function memoryStorage(): ReadableModeStorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

test('the explicit Focus choice is remembered per project and never leaks between projects', () => {
  const storage = memoryStorage();
  assert.equal(readStoredReadableMode(storage, 'project-1'), null, 'nothing chosen yet');
  assert.equal(
    readableModeStorageKey('project-1'),
    `${READABLE_MODE_STORAGE_PREFIX}:project-1`,
    'the key is project-scoped',
  );

  // The user presses Focus once; reopening the project restores it.
  writeStoredReadableMode(storage, 'project-1', 'focus');
  assert.equal(readStoredReadableMode(storage, 'project-1'), 'focus');
  assert.equal(storage.map.get(`${READABLE_MODE_STORAGE_PREFIX}:project-1`), 'focus');

  // Another project starts at the whole-graph default — the choice does not
  // leak, which is what "按项目隔离、换项目不串" requires.
  assert.equal(readStoredReadableMode(storage, 'project-2'), null);
  writeStoredReadableMode(storage, 'project-2', 'overview');
  assert.equal(readStoredReadableMode(storage, 'project-1'), 'focus', 'project-1 is untouched');
  assert.equal(readStoredReadableMode(storage, 'project-2'), 'overview');

  // An explicit Overview is a choice too (it persists as such), and clearing
  // returns the project to the un-chosen default.
  writeStoredReadableMode(storage, 'project-1', null);
  assert.equal(readStoredReadableMode(storage, 'project-1'), null);

  // A stale/hand-edited value is ignored rather than trusted.
  storage.setItem(`${READABLE_MODE_STORAGE_PREFIX}:project-3`, 'sideways');
  assert.equal(readStoredReadableMode(storage, 'project-3'), null);

  // No project id means no storage key: the choice is visit-only.
  assert.equal(readableModeStorageKey(null), null);
  writeStoredReadableMode(storage, null, 'focus');
  assert.equal(storage.map.size, 2, 'no key was invented for an unknown project');
  assert.equal(readStoredReadableMode(storage, null), null);
});
