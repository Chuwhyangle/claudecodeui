import {
  buildHierarchyIndex,
  ROOT_PACKAGE_ID,
  type ArchitectureHierarchyIndex,
} from '@/modules/architecture/hierarchyIndex';
import type {
  ArchitectureNodeIdShape,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';
import { DEFAULT_NODE_ID_SHAPE, scopeRelativePath } from '@/modules/architecture/adaptiveGrouping';
import { centerElementInContainer } from '@/modules/architecture/svgViewport';

/**
 * Semantic zoom (level of detail) for the architecture explosion diagram.
 *
 * The diagram is laid out once — every package frame, subpackage frame, entity
 * and entity edge is already in the SVG. Zooming must therefore never re-layout
 * or re-render it: this module maps the current zoom scale onto a hierarchy
 * depth ("packages" → "subpackages" → "entities") and toggles the EXISTING DOM
 * nodes' `display`, rewrites the collapsed package labels with their `(N)`
 * entity count, and overlays package-level aggregated edges while the entity
 * UML edges are hidden. Positions never change, so a level cross cannot make a
 * package jump; the only gesture that moves the viewport is the focus recentre,
 * which scrolls the user's focus package back to the middle of the container.
 *
 * The hierarchy comes from the entity ids plus, when the renderer publishes it,
 * each entity's own `data-package-id` (see `hierarchyIndex.ts`). The published
 * plantuml-js build does not stamp that attribute on entities, so an id's path
 * is the fallback — the same scope-stripped directory split the PlantUML bridge
 * uses to emit the package blocks, never a geometric point-in-rectangle guess.
 *
 * Consumers: `PlantUmlGraph.tsx` (the diagram) and
 * `tests/explosionLod.test.tsx` (the level/deadzone/debounce/aggregation cases).
 */

/** The three levels of detail, ordered from the farthest to the nearest zoom. */
export type ExplosionLodDepth = 0 | 1 | 2;

/** Far level: only package frames, entities collapsed into them. */
export const PACKAGE_LOD_DEPTH: ExplosionLodDepth = 0;
/** Middle level: nested package frames, entities still collapsed. */
export const SUBPACKAGE_LOD_DEPTH: ExplosionLodDepth = 1;
/** Nearest level: entities and their UML edges are shown. */
export const ENTITY_LOD_DEPTH: ExplosionLodDepth = 2;

/** Zoom scale at or above which the subpackage level is entered. */
export const SUBPACKAGE_MIN_SCALE = 0.25;
/** Zoom scale at or above which entities are drawn. */
export const ENTITY_MIN_SCALE = 0.6;

/**
 * The dead band around each threshold, as a fraction of the threshold. Kept
 * inside the proposal's 5%–10% window: the level changes at `T·(1+d/2)` going
 * in and `T·(1−d/2)` coming back, so a scale resting on the boundary does not
 * flap. 5%–10% was chosen to be wider than wheel-delta noise but narrower than
 * the visual jump between levels.
 */
export const LOD_DEADZONE_RATIO = 0.08;

/**
 * How long the zoom must settle before the level is re-evaluated. The proposal
 * fixes the 150–250 ms window; 200 ms absorbs a wheel burst without making the
 * expansion feel laggy.
 */
export const LOD_DEBOUNCE_MS = 200;

/**
 * At the far level, package frames deeper than this many path segments are
 * hidden (their entities are hidden anyway) so the collapsed view shows only
 * the coarse package chain — `src/modules/chat` for a `src/modules/chat/hooks`
 * entity. Counts still include every descendant.
 */
export const PACKAGE_LEVEL_MAX_DEPTH = 3;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Marks the client-computed package-edge overlay so it can be replaced wholesale. */
const LOD_EDGE_LAYER_ATTRIBUTE = 'data-architecture-lod-edges';
/** Marks the counter-scaled package-title overlay so it can be replaced wholesale. */
export const LOD_LABELS_LAYER_ATTRIBUTE = 'data-architecture-lod-labels';
/** Preserves a package label's original text across far/middle rewrites. */
const LOD_LABEL_BASE_ATTRIBUTE = 'data-lod-base-label';

/**
 * The smallest on-screen height a counter-scaled package title may draw at.
 * Matches the readable-zoom policy's floor (9px) plus headroom, because these
 * titles sit on top of a drawing the reader is already looking at from afar.
 */
export const LOD_LABEL_MIN_SCREEN_PX = 11;
/** The largest a counter-scaled title may be enlarged to on screen. */
export const LOD_LABEL_MAX_SCREEN_PX = 16;
/**
 * Headroom added to the floor when planning a title. The SVG's rendered width
 * is rounded to hundredths of a pixel, so a plan that targets exactly 11px can
 * paint at 10.9997px; the margin keeps the FLOOR a floor under real
 * measurement rather than a float artefact.
 */
const LOD_LABEL_TARGET_HEADROOM_PX = 0.5;
/** The renderer's package-label font size, in SVG user units at 100% zoom. */
export const LOD_LABEL_BASE_FONT_PX = 12;
/**
 * A frame narrower than this on screen gets no title: an ellipsis is not a
 * name. The proposal fixes the threshold at about 60 CSS px.
 */
export const LOD_LABEL_MIN_FRAME_SCREEN_WIDTH_PX = 60;
/** Approximate glyph advance as a fraction of the font size (path-like ids). */
const LOD_LABEL_CHAR_WIDTH_RATIO = 0.6;
/** Inset of a title from its frame's top-left corner. */
const LOD_LABEL_INSET_PX = 3;

/**
 * The level-of-detail depth for a zoom scale, ignoring any history. Non-finite
 * scales (a not-yet-measured fit) are treated as natural size, i.e. entities.
 */
export function lodDepthForScale(scale: number): ExplosionLodDepth {
  if (!Number.isFinite(scale) || scale >= ENTITY_MIN_SCALE) return ENTITY_LOD_DEPTH;
  if (scale >= SUBPACKAGE_MIN_SCALE) return SUBPACKAGE_LOD_DEPTH;
  return PACKAGE_LOD_DEPTH;
}

/**
 * The level to show for `scale`, given the level already on screen. The first
 * reading (no previous level) uses the raw mapping; afterwards a boundary must
 * be crossed by the dead band before the level changes, which is what keeps a
 * scale hovering at 0.6 from alternating between subpackages and entities.
 */
export function resolveLodDepth(
  scale: number,
  previous: ExplosionLodDepth | null,
): ExplosionLodDepth {
  if (previous === null) return lodDepthForScale(scale);

  const raw = lodDepthForScale(scale);
  const halfBand = LOD_DEADZONE_RATIO / 2;

  if (previous === PACKAGE_LOD_DEPTH) {
    return scale >= SUBPACKAGE_MIN_SCALE * (1 + halfBand) ? raw : PACKAGE_LOD_DEPTH;
  }
  if (previous === ENTITY_LOD_DEPTH) {
    return scale < ENTITY_MIN_SCALE * (1 - halfBand) ? raw : ENTITY_LOD_DEPTH;
  }
  if (scale >= ENTITY_MIN_SCALE * (1 + halfBand)) return ENTITY_LOD_DEPTH;
  if (scale < SUBPACKAGE_MIN_SCALE * (1 - halfBand)) return PACKAGE_LOD_DEPTH;
  return SUBPACKAGE_LOD_DEPTH;
}

/** Coalesces a burst of zoom readings into one level application. */
export type ExplosionLodScheduler = {
  /** Replace any pending application with `apply`, to run after the delay. */
  request(apply: () => void): void;
  /** Drop the pending application (a new drawing replaces it). */
  cancel(): void;
};

/**
 * Create the debouncer the diagram drives from its zoom state. Kept separate
 * from the DOM so the timing contract can be tested without a laid-out SVG.
 */
export function createExplosionLodScheduler(
  delayMs: number = LOD_DEBOUNCE_MS,
): ExplosionLodScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    request(apply: () => void): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        apply();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Canonical path-form package id: no surrounding slashes, no empty segments. */
function normalizePackageId(raw: string | null): string {
  if (raw === null) return ROOT_PACKAGE_ID;
  return raw.trim().split('/').filter(Boolean).join('/');
}

/** How many path segments a package id has; the root is depth 0. */
export function packageDepth(packageId: string): number {
  const id = normalizePackageId(packageId);
  return id === ROOT_PACKAGE_ID ? 0 : id.split('/').length;
}

/**
 * The package path implied by an entity id — the same directory split
 * `archguardToPlantUml` uses for its package blocks, so the index and the drawn
 * frames agree even when the renderer publishes no `data-package-id`. `idShape`
 * must be the drawing's shape: a file id is already project-relative, so
 * peeling its first segment would name a package no frame carries.
 */
export function entityPackagePath(
  id: string,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): string {
  const relative = scopeRelativePath(id, idShape);
  const lastSlash = relative.lastIndexOf('/');
  return lastSlash === -1 ? ROOT_PACKAGE_ID : relative.slice(0, lastSlash);
}

/**
 * Build the hierarchy index for the entities actually drawn in `host`.
 *
 * Only `.uml-node` elements that the neighbourhood JSON also declares are
 * counted: overview `grp::` nodes and view stubs are scaffolding, and a
 * neighbourhood view may draw a subset of the JSON graph. An entity's own
 * `data-package-id` wins when the renderer ships it (it is the layout model's
 * own parent link); otherwise the id path supplies the package.
 */
export function buildExplosionHierarchy(
  host: ParentNode,
  graph: ArchitectureRendererGraph,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): ArchitectureHierarchyIndex {
  const known = new Set(graph.nodes.map((node) => node.id));
  const entities: { id: string; packageId: string }[] = [];
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id');
    if (id === null || !known.has(id)) continue;
    const stamped = element.getAttribute('data-package-id');
    entities.push({
      id,
      packageId: stamped === null ? entityPackagePath(id, idShape) : normalizePackageId(stamped),
    });
  }
  return buildHierarchyIndex(entities);
}

/** One weighted edge between two package frames, aggregated from entity edges. */
export type ExplosionPackageEdge = {
  readonly from: string;
  readonly to: string;
  /** How many original entity edges this package edge stands for. */
  readonly weight: number;
};

/**
 * The package a package id collapses to when only frames up to `maxDepth` are
 * shown: itself when shallow enough, else its ancestor at that depth. `null`
 * for the root, which has no frame to attach an edge to.
 */
function visiblePackage(packageId: string, maxDepth: number | null): string | null {
  if (packageId === ROOT_PACKAGE_ID) return null;
  if (maxDepth === null) return packageId;
  const segments = packageId.split('/');
  return segments.length <= maxDepth ? packageId : segments.slice(0, maxDepth).join('/');
}

/**
 * Aggregate entity edges into weighted package edges. Endpoints inside the same
 * visible package are dropped (an internal relation is not a package boundary),
 * and so are edges whose endpoint was not drawn (it has no package in the
 * index). `maxDepth` collapses deep endpoints onto the frame that is shown.
 *
 * Consumers: `applyExplosionLod` (the overlay) and the LOD tests.
 */
export function aggregatePackageEdges(
  hierarchy: ArchitectureHierarchyIndex,
  edges: readonly ArchitectureRendererEdge[],
  maxDepth: number | null = null,
): ExplosionPackageEdge[] {
  const aggregated = new Map<string, ExplosionPackageEdge>();
  for (const edge of edges) {
    const fromPackage = hierarchy.entityPackage.get(edge.from);
    const toPackage = hierarchy.entityPackage.get(edge.to);
    if (fromPackage === undefined || toPackage === undefined) continue;
    const from = visiblePackage(fromPackage, maxDepth);
    const to = visiblePackage(toPackage, maxDepth);
    if (from === null || to === null || from === to) continue;
    const key = `${from}\u0000${to}`;
    const existing = aggregated.get(key);
    aggregated.set(
      key,
      existing === undefined
        ? { from, to, weight: 1 }
        : { ...existing, weight: existing.weight + 1 },
    );
  }
  return [...aggregated.values()].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
}

/** Show or hide one existing DOM node without replacing it. */
function setShown(element: Element, shown: boolean): void {
  (element as HTMLElement).style.display = shown ? '' : 'none';
}

/** The package frame carrying `packageId`, if the renderer drew one. */
function packageFrame(host: ParentNode, packageId: string): Element | null {
  const wanted = normalizePackageId(packageId);
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    if (normalizePackageId(frame.getAttribute('data-package-id')) === wanted) return frame;
  }
  return null;
}

/** A package frame's label: its only direct `<text>` child. */
function frameLabel(frame: Element): Element | null {
  for (const child of frame.children) {
    if (child.tagName.toLowerCase() === 'text') return child;
  }
  return null;
}

export type FrameBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** One point of an orthogonal polyline, in SVG user units. */
export type PolyPoint = { readonly x: number; readonly y: number };

/** A package frame's outer geometry, read from its first `<rect>` in user units. */
function frameBox(frame: Element): FrameBox | null {
  for (const child of frame.children) {
    if (child.tagName.toLowerCase() !== 'rect') continue;
    const values = ['x', 'y', 'width', 'height'].map((name) => {
      const raw = child.getAttribute(name);
      return raw === null ? Number.NaN : Number(raw);
    });
    if (values.some((value) => !Number.isFinite(value))) return null;
    const [x, y, width, height] = values;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  }
  return null;
}

/* ── counter-scaled package titles ─────────────────────────────────────────────────────────── */

/** Normalise a zoom reading; a not-yet-measured scale means natural size. */
function zoomOf(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * The on-screen height a package title draws at for a given zoom.
 *
 * Below 100% the title overlay is counter-scaled so the text never falls under
 * {@link LOD_LABEL_MIN_SCREEN_PX}; it is capped at {@link LOD_LABEL_MAX_SCREEN_PX}
 * so the enlargement never turns the corner of a package into a headline. At
 * 100% and above nothing is enlarged: the renderer's own size already grows
 * with the zoom, and the title must not get smaller than the original font.
 */
export function lodLabelScreenFontPx(
  scale: number,
  baseFontPx: number = LOD_LABEL_BASE_FONT_PX,
): number {
  const zoom = zoomOf(scale);
  const natural = baseFontPx * zoom;
  if (zoom >= 1) return natural;
  const floor = Math.max(LOD_LABEL_MIN_SCREEN_PX, natural) + LOD_LABEL_TARGET_HEADROOM_PX;
  return Math.min(LOD_LABEL_MAX_SCREEN_PX, floor);
}

/** The inverse-scale factor a title `<g>` carries to reach its screen font height. */
export function lodLabelTransformScale(
  scale: number,
  baseFontPx: number = LOD_LABEL_BASE_FONT_PX,
): number {
  const zoom = zoomOf(scale);
  return lodLabelScreenFontPx(zoom, baseFontPx) / (baseFontPx * zoom);
}

function approximateTextWidthPx(text: string, screenFontPx: number): number {
  return text.length * screenFontPx * LOD_LABEL_CHAR_WIDTH_RATIO;
}

/**
 * Fit a package title into the on-screen width available to it, or `null` when
 * not even one character plus the ellipsis fits.
 */
export function truncatePackageTitle(
  text: string,
  availableScreenPx: number,
  screenFontPx: number,
): string | null {
  if (text.length === 0 || !(availableScreenPx > 0) || !(screenFontPx > 0)) return null;
  if (approximateTextWidthPx(text, screenFontPx) <= availableScreenPx) return text;
  const maxChars = Math.floor(availableScreenPx / (screenFontPx * LOD_LABEL_CHAR_WIDTH_RATIO));
  if (maxChars < 2) return null;
  return `${text.slice(0, maxChars - 1)}…`;
}

/** One frame that may carry a counter-scaled title. */
export type PackageTitleFrame = {
  readonly packageId: string;
  readonly text: string;
  readonly box: FrameBox;
};

/** A title to draw, with its user-space anchor and inverse-scale factor. */
export type PackageTitlePlan = {
  readonly packageId: string;
  readonly text: string;
  /** The on-screen font height the plan targets, in CSS px. */
  readonly screenFontPx: number;
  /** The `scale()` the title's `<g>` carries inside the SVG. */
  readonly transformScale: number;
  /** User-space anchor of the title's top-left. */
  readonly x: number;
  readonly y: number;
};

type ScreenRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

function intersects(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Plan the counter-scaled package titles for one zoom level.
 *
 * Pure geometry: it takes the frames' user-unit boxes and returns the titles
 * that fit. Outer frames (larger area) are placed first, and an inner title
 * that would overlap one already placed is dropped — the outer package is the
 * one that tells the reader where they are. A frame narrower than
 * {@link LOD_LABEL_MIN_FRAME_SCREEN_WIDTH_PX} on screen gets no title.
 */
export function planPackageTitles(
  frames: readonly PackageTitleFrame[],
  scale: number,
  baseFontPx: number = LOD_LABEL_BASE_FONT_PX,
): PackageTitlePlan[] {
  const zoom = zoomOf(scale);
  const screenFontPx = lodLabelScreenFontPx(zoom, baseFontPx);
  const transformScale = lodLabelTransformScale(zoom, baseFontPx);
  const ordered = frames
    .map((frame) => ({
      ...frame,
      screenWidth: frame.box.width * zoom,
      area: frame.box.width * frame.box.height,
    }))
    .filter((frame) => frame.text.trim().length > 0
      && frame.screenWidth >= LOD_LABEL_MIN_FRAME_SCREEN_WIDTH_PX)
    .sort((a, b) => b.area - a.area || a.packageId.localeCompare(b.packageId));

  const placed: ScreenRect[] = [];
  const plans: PackageTitlePlan[] = [];
  for (const frame of ordered) {
    const available = frame.screenWidth - LOD_LABEL_INSET_PX * 2;
    const text = truncatePackageTitle(frame.text, available, screenFontPx);
    if (text === null) continue;
    const screenX = frame.box.x * zoom + LOD_LABEL_INSET_PX;
    const screenY = frame.box.y * zoom + LOD_LABEL_INSET_PX;
    const rect: ScreenRect = {
      x: screenX,
      y: screenY,
      width: approximateTextWidthPx(text, screenFontPx),
      height: screenFontPx * 1.25,
    };
    if (placed.some((other) => intersects(rect, other))) continue;
    placed.push(rect);
    plans.push({
      packageId: frame.packageId,
      text,
      screenFontPx,
      transformScale,
      x: rect.x / zoom,
      y: rect.y / zoom,
    });
  }
  return plans.sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/* ── orthogonal package edges ─────────────────────────────────────────────────────────────── */

function samePoint(a: PolyPoint, b: PolyPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function dedupePoints(points: readonly PolyPoint[]): PolyPoint[] {
  const out: PolyPoint[] = [];
  for (const point of points) {
    if (out.length === 0 || !samePoint(out[out.length - 1], point)) out.push(point);
  }
  return out;
}

/**
 * Parse the renderer's orthogonal `d` into its corner points.
 *
 * The published renderer emits `M`/`L`/`Q` only (a quadratic rounds each
 * corner). Its control point IS the original corner, so including it keeps
 * every consecutive pair axis-aligned — which is what lets the caller clip the
 * route and still claim orthogonality.
 */
export function polylineFromPathData(d: string): PolyPoint[] {
  const points: PolyPoint[] = [];
  for (const command of d.match(/[MLQ][^MLQZz]*/g) ?? []) {
    const numbers = (command.slice(1).match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      if (!Number.isFinite(numbers[i]) || !Number.isFinite(numbers[i + 1])) continue;
      points.push({ x: numbers[i], y: numbers[i + 1] });
    }
  }
  return dedupePoints(points);
}

/** The orthogonal polyline of one drawn `.uml-edge` group, or `null`. */
export function polylineFromEdgeElement(edge: Element): PolyPoint[] | null {
  const path = edge.tagName.toLowerCase() === 'path'
    ? edge
    : edge.querySelector('path[d]');
  const d = path?.getAttribute('d') ?? null;
  if (d === null) return null;
  const points = polylineFromPathData(d);
  return points.length >= 2 ? points : null;
}

function pointInsideBox(point: PolyPoint, box: FrameBox, eps = 1e-3): boolean {
  return point.x >= box.x - eps
    && point.x <= box.x + box.width + eps
    && point.y >= box.y - eps
    && point.y <= box.y + box.height + eps;
}

function pointOnBoxBoundary(point: PolyPoint, box: FrameBox, eps = 1e-3): boolean {
  if (!pointInsideBox(point, box, eps)) return false;
  return Math.abs(point.x - box.x) <= eps
    || Math.abs(point.x - (box.x + box.width)) <= eps
    || Math.abs(point.y - box.y) <= eps
    || Math.abs(point.y - (box.y + box.height)) <= eps;
}

/** The point where the segment `a → b` leaves/enters `box` (a inside, b outside). */
function segmentBoxBoundaryPoint(a: PolyPoint, b: PolyPoint, box: FrameBox): PolyPoint | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let bestT = Number.POSITIVE_INFINITY;
  let best: PolyPoint | null = null;
  const consider = (t: number): void => {
    if (!(t > 1e-9) || t > 1 + 1e-9 || t >= bestT) return;
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    if (!pointOnBoxBoundary(point, box)) return;
    bestT = t;
    best = point;
  };
  if (Math.abs(dx) > 1e-9) {
    consider((box.x - a.x) / dx);
    consider((box.x + box.width - a.x) / dx);
  }
  if (Math.abs(dy) > 1e-9) {
    consider((box.y - a.y) / dy);
    consider((box.y + box.height - a.y) / dy);
  }
  return best;
}

/** First point outside `box`, from a polyline whose start is inside it. */
function exitPointFromBox(points: readonly PolyPoint[], box: FrameBox): { point: PolyPoint; index: number } | null {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!pointInsideBox(a, box, 1e-3) || pointInsideBox(b, box, 1e-3)) continue;
    const point = segmentBoxBoundaryPoint(a, b, box);
    if (point !== null) return { point, index: i + 1 };
  }
  return null;
}

/** Last point outside `box`, from a polyline whose end is inside it. */
function entryPointToBox(points: readonly PolyPoint[], box: FrameBox): { point: PolyPoint; index: number } | null {
  for (let i = points.length - 1; i >= 1; i -= 1) {
    const a = points[i - 1];
    const b = points[i];
    if (pointInsideBox(a, box, 1e-3) || !pointInsideBox(b, box, 1e-3)) continue;
    const point = segmentBoxBoundaryPoint(a, b, box);
    if (point !== null) return { point, index: i - 1 };
  }
  return null;
}

/**
 * Clip an entity-edge polyline to two package frames: start where the route
 * leaves `fromBox` and end where it enters `toBox`. The route's own shape is
 * preserved, so every clipped segment is still horizontal or vertical and the
 * two endpoints sit on the respective frame boundary. `null` when the route
 * never leaves the source frame or never reaches the target frame.
 */
export function clipPolylineToFrames(
  points: readonly PolyPoint[],
  fromBox: FrameBox,
  toBox: FrameBox,
): PolyPoint[] | null {
  if (points.length < 2) return null;
  let clipped = points.map((point) => ({ ...point }));

  if (pointInsideBox(clipped[0], fromBox, 1e-3)) {
    const exit = exitPointFromBox(clipped, fromBox);
    if (exit === null) return null;
    clipped = [exit.point, ...clipped.slice(exit.index)];
  }

  if (clipped.length >= 2 && pointInsideBox(clipped[clipped.length - 1], toBox, 1e-3)) {
    const entry = entryPointToBox(clipped, toBox);
    if (entry === null) return null;
    clipped = [...clipped.slice(0, entry.index + 1), entry.point];
  }

  const cleaned = dedupePoints(clipped);
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * The degenerate connector used when no drawn polyline can be found: an
 * orthogonal L between the two frames' facing sides. It never draws a diagonal.
 */
export function orthogonalConnector(fromBox: FrameBox, toBox: FrameBox): PolyPoint[] {
  const fromCx = fromBox.x + fromBox.width / 2;
  const fromCy = fromBox.y + fromBox.height / 2;
  const toCx = toBox.x + toBox.width / 2;
  const toCy = toBox.y + toBox.height / 2;
  if (Math.abs(toCx - fromCx) >= Math.abs(toCy - fromCy)) {
    const startX = toCx >= fromCx ? fromBox.x + fromBox.width : fromBox.x;
    const endX = toCx >= fromCx ? toBox.x : toBox.x + toBox.width;
    return dedupePoints([
      { x: startX, y: fromCy },
      { x: endX, y: fromCy },
      { x: endX, y: toCy },
    ]);
  }
  const startY = toCy >= fromCy ? fromBox.y + fromBox.height : fromBox.y;
  const endY = toCy >= fromCy ? toBox.y : toBox.y + toBox.height;
  return dedupePoints([
    { x: fromCx, y: startY },
    { x: fromCx, y: endY },
    { x: toCx, y: endY },
  ]);
}

function pathDataOf(points: readonly PolyPoint[]): string {
  const [first, ...rest] = points;
  return `M${first.x} ${first.y}${rest.map((point) => `L${point.x} ${point.y}`).join('')}`;
}

/** The bounding box of two frame boxes, used to synthesise a missing ancestor. */
function unionOf(a: FrameBox, b: FrameBox): FrameBox {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The geometry of the frame carrying `packageId`, or — when the renderer did
 * not draw that ancestor frame (a neighbourhood view keeps only the innermost
 * packages) — the union of the descendant frames it contains. This lets a
 * collapsed package edge attach to the cluster that is on screen instead of
 * disappearing.
 */
function frameBoxFor(host: ParentNode, packageId: string): FrameBox | null {
  const direct = packageFrame(host, packageId);
  if (direct !== null) return frameBox(direct);

  const prefix = `${packageId}/`;
  let union: FrameBox | null = null;
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    if (!normalizePackageId(frame.getAttribute('data-package-id')).startsWith(prefix)) continue;
    const box = frameBox(frame);
    if (box === null) continue;
    union = union === null ? box : unionOf(union, box);
  }
  return union;
}

/** The last two path segments: `src/modules/chat` → `modules/chat`. */
function compactPackageLabel(packageId: string): string {
  const segments = normalizePackageId(packageId).split('/').filter(Boolean);
  return segments.slice(-2).join('/') || packageId;
}

/**
 * Rewrite a package label for the current depth: collapsed levels append the
 * subtree's entity count, the nearest level restores the renderer's own text.
 * The original is preserved on the element so repeated applications never
 * stack `(N)` suffixes.
 */
function updateFrameLabel(
  frame: Element,
  hierarchy: ArchitectureHierarchyIndex,
  depth: ExplosionLodDepth,
  packageId: string,
): void {
  const label = frameLabel(frame);
  if (label === null) return;
  const stored = label.getAttribute(LOD_LABEL_BASE_ATTRIBUTE);
  if (stored === null) label.setAttribute(LOD_LABEL_BASE_ATTRIBUTE, label.textContent ?? '');
  const base = stored ?? label.textContent ?? '';

  if (depth === ENTITY_LOD_DEPTH) {
    label.textContent = base;
    return;
  }
  const count = hierarchy.packages.get(packageId)?.descendantEntityCount;
  if (count === undefined) return;
  const name = depth === PACKAGE_LOD_DEPTH ? compactPackageLabel(packageId) : base;
  label.textContent = `${name} (${count})`;
}

/** Drop the previous package-edge overlay, if any. */
function removePackageEdgeLayer(host: ParentNode): void {
  for (const layer of host.querySelectorAll(`[${LOD_EDGE_LAYER_ATTRIBUTE}]`)) layer.remove();
}

/** Drop the previous counter-scaled title overlay, if any. */
function removeLodLabelLayer(host: ParentNode): void {
  for (const layer of host.querySelectorAll(`[${LOD_LABELS_LAYER_ATTRIBUTE}]`)) layer.remove();
}

/** The drawn entity edge polyline for one package pair, with its own styling. */
type EdgeRoute = {
  readonly points: PolyPoint[];
  readonly stroke: string;
  readonly dash: string | null;
};

/**
 * The original entity edge to reuse for a package pair: the first graph edge
 * whose endpoints collapse onto that pair AND whose drawn `.uml-edge` group
 * still carries a usable polyline. The renderer's own stroke and dash are
 * copied so the package-level line stays the family's line, not a new one.
 */
function edgeRouteFor(
  host: ParentNode,
  hierarchy: ArchitectureHierarchyIndex,
  edges: readonly ArchitectureRendererEdge[],
  from: string,
  to: string,
  maxDepth: number | null,
): EdgeRoute | null {
  let fallback: EdgeRoute | null = null;
  for (const edge of edges) {
    const fromPackage = hierarchy.entityPackage.get(edge.from);
    const toPackage = hierarchy.entityPackage.get(edge.to);
    if (fromPackage === undefined || toPackage === undefined) continue;
    if (visiblePackage(fromPackage, maxDepth) !== from) continue;
    if (visiblePackage(toPackage, maxDepth) !== to) continue;
    for (const element of host.querySelectorAll('.uml-edge')) {
      if (element.getAttribute('data-edge-source') !== edge.from) continue;
      if (element.getAttribute('data-edge-target') !== edge.to) continue;
      const path = element.querySelector('path[d]');
      const points = polylineFromEdgeElement(element);
      const route: EdgeRoute = {
        points: points ?? [],
        stroke: path?.getAttribute('stroke') ?? '#2563eb',
        dash: path?.getAttribute('stroke-dasharray') ?? null,
      };
      if (points !== null && points.length >= 2) return route;
      fallback ??= route;
      break;
    }
  }
  return fallback !== null && fallback.points.length >= 2 ? fallback : null;
}

/** The middle of the longest segment, where the ×N weight label reads best. */
function longestSegmentMidpoint(points: readonly PolyPoint[]): PolyPoint {
  let best = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  let bestLength = -1;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

/** A small filled arrowhead on the target end of an orthogonal route. */
function arrowHeadPath(points: readonly PolyPoint[], zoom: number): string | null {
  if (points.length < 2) return null;
  const tip = points[points.length - 1];
  const previous = points[points.length - 2];
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  // Keep the head roughly constant on screen, like the line itself.
  const size = 8 / zoom;
  const ux = dx / length;
  const uy = dy / length;
  const back = { x: tip.x - ux * size, y: tip.y - uy * size };
  const left = { x: back.x - uy * size * 0.45, y: back.y + ux * size * 0.45 };
  const right = { x: back.x + uy * size * 0.45, y: back.y - ux * size * 0.45 };
  return `M${tip.x} ${tip.y}L${left.x} ${left.y}L${right.x} ${right.y}Z`;
}

/**
 * Draw the package-level edge overlay for a collapsed level.
 *
 * The line is NOT a centre-to-centre straight segment: it reuses the drawn
 * entity edge between the two packages, clipped to the frames' boundaries, so
 * its orthogonal corners, dash pattern and relation colour survive the
 * collapse. When no drawn route is available it degrades to an orthogonal L —
 * never a diagonal. Coordinates come from the frames' own `rect` attributes
 * (SVG user units), so the overlay stays attached to the frames at every zoom
 * scale without measuring the browser.
 */
function renderPackageEdgeLayer(
  host: ParentNode,
  hierarchy: ArchitectureHierarchyIndex,
  edges: readonly ArchitectureRendererEdge[],
  depth: ExplosionLodDepth,
  zoom: number,
): void {
  const svg = host.querySelector('svg');
  if (svg === null) return;

  const maxDepth = depth === PACKAGE_LOD_DEPTH ? PACKAGE_LEVEL_MAX_DEPTH : null;
  const layer = svg.ownerDocument.createElementNS(SVG_NS, 'g');
  layer.setAttribute(LOD_EDGE_LAYER_ATTRIBUTE, 'true');

  for (const packageEdge of aggregatePackageEdges(hierarchy, edges, maxDepth)) {
    const from = frameBoxFor(host, packageEdge.from);
    const to = frameBoxFor(host, packageEdge.to);
    if (from === null || to === null) continue;

    const route = edgeRouteFor(host, hierarchy, edges, packageEdge.from, packageEdge.to, maxDepth);
    const points = (route === null ? null : clipPolylineToFrames(route.points, from, to))
      ?? orthogonalConnector(from, to);
    if (points.length < 2) continue;

    const stroke = route?.stroke ?? '#2563eb';
    const path = svg.ownerDocument.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'arch-lod-package-edge');
    path.setAttribute('d', pathDataOf(points));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    if (route?.dash !== null && route?.dash !== undefined) path.setAttribute('stroke-dasharray', route.dash);
    path.setAttribute('stroke-width', String(Math.min(1 + (packageEdge.weight - 1) * 0.5, 4)));
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('data-lod-edge-source', packageEdge.from);
    path.setAttribute('data-lod-edge-target', packageEdge.to);
    path.setAttribute('data-lod-edge-weight', String(packageEdge.weight));
    layer.append(path);

    const arrow = arrowHeadPath(points, zoom);
    if (arrow !== null) {
      const head = svg.ownerDocument.createElementNS(SVG_NS, 'path');
      head.setAttribute('class', 'arch-lod-package-arrowhead');
      head.setAttribute('d', arrow);
      head.setAttribute('fill', stroke);
      head.setAttribute('data-lod-edge-source', packageEdge.from);
      head.setAttribute('data-lod-edge-target', packageEdge.to);
      layer.append(head);
    }

    if (packageEdge.weight > 1) {
      const midpoint = longestSegmentMidpoint(points);
      const weight = svg.ownerDocument.createElementNS(SVG_NS, 'text');
      weight.setAttribute('class', 'arch-lod-package-weight');
      weight.setAttribute('x', String(midpoint.x));
      weight.setAttribute('y', String(midpoint.y - 6 / zoom));
      weight.setAttribute('text-anchor', 'middle');
      weight.setAttribute('font-size', String(LOD_LABEL_MIN_SCREEN_PX / zoom));
      weight.setAttribute('fill', stroke);
      weight.textContent = `×${packageEdge.weight}`;
      layer.append(weight);
    }
  }

  svg.append(layer);
}

/**
 * Draw the counter-scaled title overlay for the visible package frames.
 *
 * The renderer's own label stays where it is (a 12px text at natural size);
 * this layer is the readable copy, anchored at the same top-left corner but
 * inverse-scaled so its screen height is at least {@link LOD_LABEL_MIN_SCREEN_PX}.
 * The entity level draws no overlay: its labels are the entity boxes' own.
 */
function renderLodLabelLayer(
  host: ParentNode,
  depth: ExplosionLodDepth,
  zoom: number,
): void {
  const svg = host.querySelector('svg');
  if (svg === null) return;

  const frames: PackageTitleFrame[] = [];
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    const packageId = normalizePackageId(frame.getAttribute('data-package-id'));
    if (depth === PACKAGE_LOD_DEPTH && packageDepth(packageId) > PACKAGE_LEVEL_MAX_DEPTH) continue;
    const box = frameBox(frame);
    const label = frameLabel(frame);
    if (box === null || label === null) continue;
    const text = (label.textContent ?? '').trim();
    if (text.length === 0) continue;
    frames.push({ packageId, text, box });
  }

  const layer = svg.ownerDocument.createElementNS(SVG_NS, 'g');
  layer.setAttribute(LOD_LABELS_LAYER_ATTRIBUTE, 'true');
  for (const plan of planPackageTitles(frames, zoom)) {
    const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'arch-lod-package-label');
    group.setAttribute('data-lod-label-package', plan.packageId);
    group.setAttribute('data-lod-label-screen-px', plan.screenFontPx.toFixed(2));
    group.setAttribute('transform', `translate(${plan.x} ${plan.y}) scale(${plan.transformScale})`);
    const text = svg.ownerDocument.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'arch-lod-package-title');
    text.setAttribute('font-size', String(LOD_LABEL_BASE_FONT_PX));
    text.setAttribute('dominant-baseline', 'text-before-edge');
    text.setAttribute('fill', '#111827');
    text.setAttribute('pointer-events', 'none');
    text.textContent = plan.text;
    group.append(text);
    layer.append(group);
  }

  svg.append(layer);
}

/** The focus package for a selection: the selected entity's, else the centre's. */
export function focusPackageOf(
  hierarchy: ArchitectureHierarchyIndex,
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const id of candidates) {
    if (id === null || id === undefined) continue;
    const packageId = hierarchy.entityPackage.get(id);
    if (packageId !== undefined && packageId !== ROOT_PACKAGE_ID) return packageId;
  }
  return null;
}

/** Everything one LOD application needs; the hierarchy/edges belong to one drawing. */
export type ExplosionLodOptions = {
  /** The scroll container that holds the drawn SVG. */
  readonly host: HTMLElement;
  readonly hierarchy: ArchitectureHierarchyIndex;
  readonly edges: readonly ArchitectureRendererEdge[];
  readonly depth: ExplosionLodDepth;
  /** The package the user is focused on (selection or neighbourhood centre). */
  readonly focusPackageId?: string | null;
  /** Scroll the focus package back to the container centre; only on a real level cross. */
  readonly centerFocus?: boolean;
  /**
   * The settled zoom scale the drawing is displayed at. Used by the
   * counter-scaled title overlay and the screen-constant edge furniture; a
   * missing/unmeasured scale is treated as natural size (100%).
   */
  readonly scale?: number;
};

/**
 * Apply one level of detail to the already-drawn SVG.
 *
 * This only toggles `display`, rewrites labels and replaces the overlay layer:
 * the SVG element, its nodes and their positions are untouched, so no layout
 * runs and nothing "re-renders". When `centerFocus` is set (a level cross) the
 * focus package is scrolled back to the middle of the viewport, collapsed to
 * the frame that is actually visible at this depth.
 *
 * Consumers: `PlantUmlGraph.tsx` (on every settled zoom) and the LOD tests.
 */
export function applyExplosionLod(options: ExplosionLodOptions): void {
  const { host, hierarchy, edges, depth } = options;
  const entityLevel = depth === ENTITY_LOD_DEPTH;
  const zoom = zoomOf(options.scale);

  for (const node of host.querySelectorAll('.uml-node[data-entity-id]')) {
    setShown(node, entityLevel);
  }
  for (const edge of host.querySelectorAll('.uml-edge')) {
    setShown(edge, entityLevel);
  }

  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    const packageId = normalizePackageId(frame.getAttribute('data-package-id'));
    const visibleAtDepth = depth !== PACKAGE_LOD_DEPTH || packageDepth(packageId) <= PACKAGE_LEVEL_MAX_DEPTH;
    setShown(frame, visibleAtDepth);
    updateFrameLabel(frame, hierarchy, depth, packageId);
  }

  removePackageEdgeLayer(host);
  removeLodLabelLayer(host);
  if (!entityLevel) {
    renderPackageEdgeLayer(host, hierarchy, edges, depth, zoom);
    renderLodLabelLayer(host, depth, zoom);
  }

  const focus = options.focusPackageId ?? null;
  if (options.centerFocus === true && focus !== null) {
    const visibleFocus = depth === PACKAGE_LOD_DEPTH
      ? visiblePackage(normalizePackageId(focus), PACKAGE_LEVEL_MAX_DEPTH)
      : normalizePackageId(focus);
    if (visibleFocus !== null) {
      const frame = packageFrame(host, visibleFocus);
      if (frame !== null) centerElementInContainer(host, frame);
    }
  }
}
