import assert from 'node:assert/strict';

import { test } from 'vitest';

import * as readableZoom from '@/modules/architecture/readableZoom';
import {
  canvasIsTooWide,
  MIN_READABLE_FONT_PX,
  READABLE_ZOOM_SCALE,
  RENDERED_LABEL_FONT_PX,
  WIDE_CANVAS_ASPECT_RATIO,
} from '@/modules/architecture/readableZoom';
import { MIN_ZOOM_SCALE } from '@/modules/architecture/svgViewport';

/**
 * The readable floor and the band test that survive the single-scale contract.
 *
 * The old policy chose between a `focus` crop and an `overview` fit and
 * persisted that choice per project. Fit is now a SOLVED scale owned by the
 * semantic engine, so none of those decisions exists; this file pins what is
 * still load-bearing and the fact that the retired surface is really gone.
 */

/** The quay session's measured drawing: 32880×9860 fitted into 1151×700. */
const DESKTOP_VIEWPORT = { width: 1151, height: 700 };

test('the readable scale is derived from the smallest readable label', () => {
  assert.equal(RENDERED_LABEL_FONT_PX, 13);
  assert.equal(MIN_READABLE_FONT_PX, 9);
  assert.equal(READABLE_ZOOM_SCALE, 9 / 13);
  assert.ok(READABLE_ZOOM_SCALE > MIN_ZOOM_SCALE, 'readable is stricter than the manual zoom floor');
});

test('a canvas far wider than its container is flagged for the collapsed overview', () => {
  // 52040×3012 (the measured explosion drawing) in a 1151×700 panel: ~10.5× the
  // container's own aspect ratio.
  assert.equal(canvasIsTooWide({ width: 52040, height: 3012 }, DESKTOP_VIEWPORT), true);
  assert.equal(WIDE_CANVAS_ASPECT_RATIO, 6);

  // A merely wide drawing keeps its view.
  assert.equal(canvasIsTooWide({ width: 2000, height: 1000 }, DESKTOP_VIEWPORT), false);
  // No measurement is not evidence of a band.
  assert.equal(canvasIsTooWide({ width: 52040, height: 3012 }, { width: 0, height: 0 }), false);
  // A degenerate drawing is not a band either.
  assert.equal(canvasIsTooWide({ width: 0, height: 0 }, DESKTOP_VIEWPORT), false);
});

test('the retired focus policy exposes nothing that could persist a mode again', () => {
  // The module's whole runtime surface. Re-introducing the Focus default (or
  // the `architecture.readableMode.v1:*` store) would have to add an export
  // here first, so the defect cannot come back silently under this criterion.
  assert.deepEqual(Object.keys(readableZoom).sort(), [
    'MIN_READABLE_FONT_PX',
    'READABLE_ZOOM_SCALE',
    'RENDERED_LABEL_FONT_PX',
    'WIDE_CANVAS_ASPECT_RATIO',
    'canvasIsTooWide',
  ]);
});
