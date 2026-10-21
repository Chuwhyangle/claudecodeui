import {
  buildHierarchyIndex,
  ROOT_PACKAGE_ID,
  type ArchitectureHierarchyIndex,
} from '@/modules/architecture/hierarchyIndex';
import type {
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';
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
/** Preserves a package label's original text across far/middle rewrites. */
const LOD_LABEL_BASE_ATTRIBUTE = 'data-lod-base-label';

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
 * The package path implied by an entity id — the same scope-stripped directory
 * split `archguardToPlantUml` uses for its package blocks, so the index and the
 * drawn frames agree even when the renderer publishes no `data-package-id`.
 */
export function entityPackagePath(id: string): string {
  const scopeEnd = id.indexOf('/');
  const relative = scopeEnd === -1 ? id : id.slice(scopeEnd + 1);
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
): ArchitectureHierarchyIndex {
  const known = new Set(graph.nodes.map((node) => node.id));
  const entities: { id: string; packageId: string }[] = [];
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id');
    if (id === null || !known.has(id)) continue;
    const stamped = element.getAttribute('data-package-id');
    entities.push({
      id,
      packageId: stamped === null ? entityPackagePath(id) : normalizePackageId(stamped),
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

type FrameBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

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

/**
 * Draw the package-level edge overlay for a collapsed level. Coordinates come
 * from the frames' own `rect` attributes (SVG user units), so the overlay stays
 * attached to the frames at every zoom scale without measuring the browser.
 */
function renderPackageEdgeLayer(
  host: ParentNode,
  hierarchy: ArchitectureHierarchyIndex,
  edges: readonly ArchitectureRendererEdge[],
  depth: ExplosionLodDepth,
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

    const x1 = from.x + from.width / 2;
    const y1 = from.y + from.height / 2;
    const x2 = to.x + to.width / 2;
    const y2 = to.y + to.height / 2;

    const line = svg.ownerDocument.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'arch-lod-package-edge');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('stroke', '#2563eb');
    line.setAttribute('stroke-width', String(Math.min(1 + (packageEdge.weight - 1) * 0.5, 4)));
    line.setAttribute('data-lod-edge-source', packageEdge.from);
    line.setAttribute('data-lod-edge-target', packageEdge.to);
    line.setAttribute('data-lod-edge-weight', String(packageEdge.weight));
    layer.append(line);

    if (packageEdge.weight > 1) {
      const weight = svg.ownerDocument.createElementNS(SVG_NS, 'text');
      weight.setAttribute('class', 'arch-lod-package-weight');
      weight.setAttribute('x', String((x1 + x2) / 2));
      weight.setAttribute('y', String((y1 + y2) / 2 - 6));
      weight.setAttribute('text-anchor', 'middle');
      weight.setAttribute('font-size', '11');
      weight.setAttribute('fill', '#2563eb');
      weight.textContent = `×${packageEdge.weight}`;
      layer.append(weight);
    }
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
  if (!entityLevel) renderPackageEdgeLayer(host, hierarchy, edges, depth);

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
