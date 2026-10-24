import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { DEFAULT_NODE_ID_SHAPE } from '@/modules/architecture/adaptiveGrouping';
import { ArchitectureMinimap } from '@/modules/architecture/ArchitectureMinimap';
import {
  BOTTOM_SLOT_GAP_PX,
  bottomCornerLayout,
  overlayLayoutDefect,
} from '@/modules/architecture/bottomSlotLayout';
import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
  MEMBER_MAX_ROWS,
  memberDisplayLimits,
  memberOverflowLabel,
  parserSafePlantUml,
  type ArchitectureDiagramView,
} from '@/modules/architecture/archguardToPlantUml';
import { standardiseDrawnStereotypes } from '@/modules/architecture/plantUmlText';
import {
  createExplosionLodScheduler,
  type ExplosionLodScheduler,
} from '@/modules/architecture/explosionLod';
import {
  ASPECT_RELAYOUT_DEBOUNCE_MS,
  createLayoutEngine,
  shouldRelayoutForAspect,
  type ArchitectureLayoutEngineClass,
} from '@/modules/architecture/elkAspectEngine';
import {
  chooseLayoutOrientation,
  createOrientationCache,
  graphFingerprint,
  orientationCacheKey,
  shouldAttemptDualLayout,
  ORIENTATION_REASON,
  type LayoutOrientation,
  type OrientationDecision,
  type OrientationSize,
} from '@/modules/architecture/layoutOrientation';
import {
  solveFitScale,
  solveSemanticZoom,
  semanticContentBounds,
  lodDepthForTier,
  type SemanticTier,
  type SemanticZoomLayout,
} from '@/modules/architecture/semanticZoomLayout';
import {
  SEMANTIC_MIN_FONT_MOBILE_PX,
  SEMANTIC_MIN_FONT_PX,
} from '@/modules/architecture/semanticZoomPlan';
import {
  PORTRAIT_CONTROL_BAND_PX,
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useCanvasHeaderSlot,
  useCompactToolbarSlot,
  useTouchLayout,
  ZOOM_CLUSTER_TARGET_STYLE,
} from '@/modules/architecture/hooks/useTouchLayout';
import { canvasIsTooWide, READABLE_ZOOM_SCALE } from '@/modules/architecture/readableZoom';
import type {
  ArchitectureDiffHighlight,
  ArchitectureRendererEdge,
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';
import {
  moveEntityFocus,
  PACKAGE_NAV_PREFIX,
  type EntityNavigationDirection,
  type EntityNavigationItem,
} from '@/modules/architecture/entityNavigation';
import {
  selectionsIntersectingBox,
  type ArchitectureSelection,
  type ArchitectureSelectionRect,
} from '@/modules/architecture/selectionModel';
import {
  centerElementInContainer,
  centeredScrollForDrawingRect,
  clampZoomScale,
  createSvgDragPan,
  createSvgTouchGestures,
  createSvgViewport,
  fitPlacementAvoidingCorners,
  applyZoomScale,
  measureViewportSize,
  MIN_READABLE_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  readSvgNaturalSize,
  ZOOM_STEP,
  type SvgCornerRect,
  type SvgFitPlacement,
  type SvgViewportController,
  type SvgViewportSize,
} from '@/modules/architecture/svgViewport';
import {
  DOUBLE_TAP_MS,
  ENTITY_HIGHLIGHT_EVENT,
  GROUP_PREFIX,
  KEYBOARD_PAN_STEP,
  STUB_PREFIX,
  TOOLBAR_BUTTON_CLASS,
} from '@/modules/architecture/graphConstants';
import {
  addNodeHitTargets,
  annotateNodes,
  addEdgeHitTargets,
  announceSelection,
  applySelectionStyles,
  boxCandidates,
  captureSemanticDrawing,
  clearHighlight,
  defaultViewOf,
  drawSemanticLayout,
  drawStickyLabels,
  drawingKeyOf,
  drawnPackageFrame,
  edgeElement,
  highlightEdge,
  highlightRelations,
  highlightSelection,
  hideEdgeLabels,
  isEntityGraph,
  markDrawingUnselectable,
  measureLayoutAspect,
  nearestNodeHitId,
  nodeElement,
  positionOverviewHint,
  relationsOf,
  rendererOptionsFor,
  restoreEntityIds,
  reverseAliases,
  selectionOf,
  type PlantUmlApplyView,
  type PlantUmlRenderDetailed,
  type PlantUmlToPlantUml,
  type SemanticCapture,
} from '@/modules/architecture/graphDom';
import {
  CANVAS_UNSELECTABLE_STYLE,
  HIGHLIGHT_STYLE,
} from '@/modules/architecture/graphStyles';

/**
 * The marker-anchor geometry lives in `graphDom.ts` with the rest of the
 * drawing helpers; it stays exported from this module because the renderer is
 * where a reader (and the geometry test) expects to find it.
 */
export { markerAnchor } from '@/modules/architecture/graphDom';

/**
 * The DEV-only lever a control arm pulls to draw the SAME document with the
 * member caps genuinely ABSENT.
 *
 * `e2e/architecture-canvas-layout.spec.ts` has to prove its node-size guard can
 * go red on the defect it watches. Injecting a wide rect into the live SVG
 * would only imitate the symptom: the box was wide because the renderer's
 * layout used the untruncated member text, so the honest lever is to not pass
 * the options. DEV-gated exactly like the `?ui-scenario=1` semantic surface —
 * a production build does not contain this branch.
 */
const MEMBER_LIMITS_STORAGE_KEY = 'architecture-member-limits';

/** The member caps to hand the renderer: the shipped ones, or none for the control arm. */
function drawnMemberLimits(): { memberMaxChars?: number } {
  if (import.meta.env.DEV) {
    try {
      if (window.localStorage.getItem(MEMBER_LIMITS_STORAGE_KEY) === 'off') return {};
    } catch {
      // Private mode: the store is unreadable, so the shipped caps apply.
    }
  }
  return memberDisplayLimits();
}

/**
 * The DEV-only lever the orientation criterion's control arm pulls: forcing the
 * DOWNWARD layout is the only way to measure what the canvas looks like WITHOUT
 * the direction choice, in the same page and through the same reading.
 *
 * DEV-gated exactly like the member-limit lever above — a production build does
 * not contain this branch, so no reader can turn the feature off.
 */
const LAYOUT_ORIENTATION_STORAGE_KEY = 'architecture-layout-orientation';

/** Whether this build's control arm asked for the downward-only layout. */
function forcedLayoutOrientation(): LayoutOrientation | null {
  if (import.meta.env.DEV) {
    try {
      if (window.localStorage.getItem(LAYOUT_ORIENTATION_STORAGE_KEY) === 'down') return 'DOWN';
    } catch {
      // Private mode: the store is unreadable, so the shipped policy applies.
    }
  }
  return null;
}

/** The natural size a finished layout reports, or `null` when it is unusable. */
function layoutSizeOf(detailed: { readonly layout: unknown }): OrientationSize | null {
  const layout = detailed.layout as { readonly width?: unknown; readonly height?: unknown } | null;
  const width = Number(layout?.width);
  const height = Number(layout?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/**
 * Cap the member ROWS the drawing shows, after layout and before the drawing is
 * captured for semantic zoom.
 *
 * This is the drawing layer's rule, not the renderer's: `memberMaxRows` would
 * write the fold row into `model.entities[].members` as a synthetic member, and
 * the Text page / a copied document must never state a member the source did
 * not declare. The renderer is asked only to shorten LINES (`memberMaxChars`);
 * here the surplus rows are removed from the DOM and replaced by the same
 * `… +N more (M members)` row the renderer would emit — which the read layer
 * already parses back into `memberTotal`, so the count survives the fold.
 *
 * Rows the entity does not exceed are left untouched, and a box keeps the
 * rect the layout gave it: the drawing is not re-laid out for a display rule.
 *
 * The label is the LONG form on purpose, and only here: the read layer parses
 * `… +N more (M members)` as the total source, so the marker survives the
 * semantic pass as a count. The semantic pass's own `… +N more` stays short —
 * if IT painted the long form, a re-read drawing would count the app's own row
 * as an upstream overflow and trip the "one marker only" guard.
 */
export function capDrawnMemberRows(host: HTMLElement): void {
  for (const group of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const rows = [...group.querySelectorAll<SVGTextElement>('text.uml-attr, text.uml-op')];
    if (rows.length <= MEMBER_MAX_ROWS) continue;
    const hidden = rows.slice(MEMBER_MAX_ROWS);
    // The marker inherits the first hidden row's position and font attributes.
    const marker = hidden[0].cloneNode(false) as SVGTextElement;
    for (const row of hidden) row.remove();
    marker.textContent = memberOverflowLabel(hidden.length, rows.length);
    group.appendChild(marker);
  }
}

/**
 * The member detail every drawing is rendered with.
 *
 * The package's default picks a level from the entity count (`≤40` full,
 * `≤150` compact, else names). Compact replaces every box's tail with a
 * synthetic `… +N more (M members)` row and, more importantly, writes that row
 * into the drawn MODEL — so `renderDetailed(...).model`, which the text page
 * serializes, was already lossy on any diagram past 40 entities. The text the
 * reader copies, downloads or sends must carry every member, so the detail is
 * pinned here instead of left to the entity count. The on-screen row cap is the
 * semantic-zoom layout's job (`planMemberRows`), independent of this value.
 *
 * Consumers: `PlantUmlGraph.tsx` (the render call) and
 * `tests/plantUmlText.test.ts` (the completeness criteria).
 */
export const PLANTUML_MEMBER_DETAIL = 'full' as const;

/**
 * Call `renderDetailed` with {@link PLANTUML_MEMBER_DETAIL} added to its
 * options.
 *
 * `type PlantUmlRenderDetailed` in `graphDom.ts` models only the structural
 * subset the renderer needs (`layout`/`view`); the package's own `detail`
 * option is added here, once, so every drawing — and therefore every drawn
 * model the text page serializes — is complete. Kept as a named function so a
 * unit test can assert the option the real renderer receives without mounting
 * the component.
 *
 * Consumers: `PlantUmlGraph.tsx` (the only render call) and
 * `tests/plantUmlText.test.ts`.
 */
export function renderWithMemberDetail(
  render: PlantUmlRenderDetailed,
  puml: string,
  options: Partial<Parameters<PlantUmlRenderDetailed>[1]> = {},
): ReturnType<PlantUmlRenderDetailed> {
  // A variable, not a fresh literal: the structural options type deliberately
  // does not name `detail`, and an object with the extra key is assignable to
  // it (the package reads the key at runtime).
  const detailedOptions = { ...options, detail: PLANTUML_MEMBER_DETAIL };
  return render(puml, detailedOptions as Parameters<PlantUmlRenderDetailed>[1]);
}

/** The class the keyboard cursor paints on the drawn box it stands on. */
const NAV_FOCUS_CLASS = 'arch-nav-focus';
/** The id prefix the cursor's DOM elements carry, for `aria-activedescendant`. */
const NAV_DOM_ID_PREFIX = 'arch-nav-';
/** How far the focus ring sits outside the box, in SVG user units. */
const NAV_RING_GAP = 2;

/**
 * The layout cost, per entity, a drawing with NO measured sample is assumed to
 * pay. Calibrated on the reported project (573 functions in 17.6 s ≈ 31 ms per
 * entity on this machine), rounded DOWN on purpose: the estimate only decides
 * whether to say "laying out", and a false positive costs the reader a status
 * line for the length of a fast layout, while a false negative leaves a
 * 17-second blank canvas unexplained.
 */
const LAYOUT_MS_PER_ENTITY_FALLBACK = 4;

/**
 * How long a layout is expected to take before the canvas says so. Below this
 * the status would flash and be noise; above it the reader has time to wonder
 * whether the click did anything.
 */
const LAYOUT_STATUS_THRESHOLD_MS = 1000;

/** One measured layout of a drawing kind: how many entities, and how long ELK took. */
type LayoutSample = { readonly nodes: number; readonly ms: number };

/**
 * The expected duration of a layout of `nodes` entities, from the entity count
 * and the LAST layout of the same drawing kind (`sample`).
 *
 * Both inputs matter: a project whose drawings are consistently slow shows the
 * status earlier than its entity count alone would suggest, and a fast one
 * never hides a genuinely slow layout behind a low sample. The measured
 * per-entity cost is therefore used only when it is ABOVE the shipped floor —
 * a sample from a small, fast drawing must not talk the canvas out of
 * announcing a large one.
 */
export function estimateLayoutMs(nodes: number, sample: LayoutSample | null): number {
  if (!Number.isFinite(nodes) || nodes <= 0) return 0;
  const measured = sample !== null && sample.nodes > 0 && Number.isFinite(sample.ms)
    ? sample.ms / sample.nodes
    : 0;
  return nodes * Math.max(measured, LAYOUT_MS_PER_ENTITY_FALLBACK);
}

/**
 * Resolve after the browser has had the chance to PAINT what React just
 * committed.
 *
 * The layout this guards is one blocking call on the main thread: once it
 * starts, nothing — not a status line, not an animation — can be committed or
 * painted until it returns. The status must therefore be in the document and
 * on screen BEFORE the layout is entered, which is what the frame + task pair
 * here buys: the frame callback runs after the commit, and the timeout yields
 * to the paint that follows it.
 */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * The id `aria-activedescendant` names. Derived from the cursor id alone, so the
 * React attribute and the element's own `id` are written from one source and
 * cannot disagree.
 */
function navigationDomId(cursorId: string): string {
  return `${NAV_DOM_ID_PREFIX}${cursorId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** A positive numeric attribute, or `null` when absent/unparseable. */
function numericAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The item's rectangle in the SVG's own user coordinates.
 *
 * The leading `rect` is read FIRST: the semantic pass rebuilds every group's
 * children in the mapped layout but leaves the group's original `data-x/y/w/h`
 * (published by the renderer before that rewrite) in place, so a ring painted
 * from those would sit at the pre-semantic position. A drawing the semantic
 * pass has not touched has the two in agreement, and the attributes remain the
 * fallback for a group without a rect.
 */
function navigationRectOf(element: Element): { x: number; y: number; width: number; height: number } | null {
  const rect = element.querySelector('rect');
  const x = (rect === null ? null : numericAttribute(rect, 'x')) ?? numericAttribute(element, 'data-x');
  const y = (rect === null ? null : numericAttribute(rect, 'y')) ?? numericAttribute(element, 'data-y');
  const width = (rect === null ? null : numericAttribute(rect, 'width')) ?? numericAttribute(element, 'data-w');
  const height = (rect === null ? null : numericAttribute(rect, 'height')) ?? numericAttribute(element, 'data-h');
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

/** The package a node id lives in, when the drawing did not publish one. */
function packageIdOfNodeId(id: string): string {
  const path = id.startsWith(GROUP_PREFIX) ? id.slice(GROUP_PREFIX.length) : id;
  const slash = path.lastIndexOf('/');
  if (slash === -1) return '';
  // An entity id is `<file path>.<Entity>`; its file's directory is the package.
  return path.slice(0, slash);
}

function normalizedPackageId(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = raw.trim().split('/').filter(Boolean).join('/');
  return normalized;
}

// ── the observation wall's structural diff ──────────────────────────────────

/** The attribute/class a diff-marked element carries; both are removed on clear. */
const DIFF_MARK_ATTRIBUTE = 'data-architecture-diff';
const DIFF_NODE_CLASS = 'arch-diff-node';
const DIFF_EDGE_CLASS = 'arch-diff-edge';

/** The marker's stylesheet: an amber dashed frame/line, distinct from selection blue. */
const DIFF_HIGHLIGHT_STYLE = `
  [data-architecture-plantuml] .${DIFF_NODE_CLASS} > rect { stroke: #c2410c; stroke-width: 2.5; stroke-dasharray: 5,3; }
  [data-architecture-plantuml] .${DIFF_EDGE_CLASS} path,
  [data-architecture-plantuml] .${DIFF_EDGE_CLASS} polyline,
  [data-architecture-plantuml] .${DIFF_EDGE_CLASS} line { stroke: #c2410c; stroke-width: 2.5; stroke-dasharray: 6,3; }
`;

/**
 * Whether a drawn package id is the declared package (or lives inside it).
 *
 * The two sides spell a package from different roots on purpose: the snapshot's ids are
 * project-relative (`server/modules/observation`), while the drawing publishes the scope's own
 * path (`modules/observation`, sometimes with the opaque scope key in front). Neither side is
 * wrong, so the match accepts a suffix on EITHER side at a path boundary rather than an exact
 * string — anything looser would mark a neighbour.
 */
function packageMatches(candidate: string | null, wanted: string): boolean {
  if (candidate === null) return false;
  const normalizedCandidate = candidate.replace(/^\/+|\/+$/g, '');
  const normalizedWanted = wanted.trim().replace(/^\/+|\/+$/g, '');
  if (normalizedCandidate === '' || normalizedWanted === '') return false;
  return normalizedCandidate === normalizedWanted
    || normalizedCandidate.endsWith(`/${normalizedWanted}`)
    || normalizedCandidate.startsWith(`${normalizedWanted}/`)
    || normalizedWanted.endsWith(`/${normalizedCandidate}`);
}

/** The package a drawn node id belongs to, as the drawing published it. */
function drawnPackageOf(host: HTMLElement, nodeId: string): string | null {
  const element = nodeElement(host, nodeId);
  const published = element === null ? null : normalizedPackageId(element.getAttribute('data-package-id'));
  return published ?? packageOfDrawnId(nodeId);
}

/**
 * The package a drawn id names, for a node that carries no `data-package-id`.
 *
 * A collapsed overview draws PACKAGE boxes (`grp::server/modules/observation`) rather than files;
 * that box IS the package, so its whole id is the package id. Everything else is a file/entity id
 * and its directory is the package.
 */
function packageOfDrawnId(nodeId: string): string | null {
  if (nodeId === '') return null;
  if (nodeId.startsWith(GROUP_PREFIX)) return normalizedPackageId(nodeId.slice(GROUP_PREFIX.length));
  return packageIdOfNodeId(nodeId);
}

/** Removes every diff marker from a drawing (a fresh SVG never carries any). */
function clearDiffStyles(host: HTMLElement): void {
  for (const element of host.querySelectorAll(`[${DIFF_MARK_ATTRIBUTE}]`)) {
    element.removeAttribute(DIFF_MARK_ATTRIBUTE);
    element.classList.remove(DIFF_NODE_CLASS, DIFF_EDGE_CLASS);
  }
}

/**
 * Marks the structural differences the observation tile passed in.
 *
 * Package ids mark their member nodes; package EDGES mark every drawn relation crossing that
 * pair; the exact `nodeIds`/`edges` forms mark the ids verbatim. With no highlight (or an empty
 * one) the drawing is left exactly as it was — the pre-highlight rendering.
 */
function applyDiffStyles(host: HTMLElement, highlight: ArchitectureDiffHighlight | null): void {
  clearDiffStyles(host);
  if (highlight === null) return;

  const exactNodeIds = new Set(highlight.nodeIds ?? []);
  const packageIds = (highlight.packageIds ?? []).filter((entry) => entry.trim() !== '');
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id') ?? '';
    const packageId = normalizedPackageId(element.getAttribute('data-package-id'))
      ?? packageOfDrawnId(id);
    const marked = exactNodeIds.has(id)
      || packageIds.some((wanted) => packageMatches(packageId, wanted));
    if (!marked) continue;
    element.setAttribute(DIFF_MARK_ATTRIBUTE, 'node');
    element.classList.add(DIFF_NODE_CLASS);
  }

  const exactEdges = highlight.edges ?? [];
  const packageEdges = (highlight.packageEdges ?? []).filter(
    (entry) => entry.from.trim() !== '' && entry.to.trim() !== '',
  );
  for (const element of host.querySelectorAll('.uml-edge[data-edge-source]')) {
    const from = element.getAttribute('data-edge-source') ?? '';
    const to = element.getAttribute('data-edge-target') ?? '';
    const marked = exactEdges.some((entry) => entry.from === from && entry.to === to)
      || (packageEdges.length > 0 && packageEdges.some(
        (entry) => packageMatches(drawnPackageOf(host, from), entry.from)
          && packageMatches(drawnPackageOf(host, to), entry.to),
      ));
    if (!marked) continue;
    element.setAttribute(DIFF_MARK_ATTRIBUTE, 'edge');
    element.classList.add(DIFF_EDGE_CLASS);
  }
}

/**
 * Everything the keyboard can stand on in the drawing just laid out: its entity
 * boxes (group and stub nodes included, since `[`/`]` and Enter act on whatever
 * is drawn) and the package frames that contain them.
 *
 * Read from the DOM rather than the payload on purpose: the drawing is the
 * visible slice, and a node that the semantic tier hid must not be a keyboard
 * target the reader cannot see.
 */
function collectNavigationItems(host: HTMLElement): EntityNavigationItem[] {
  const items: EntityNavigationItem[] = [];
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id') ?? '';
    if (id === '' || id.startsWith(STUB_PREFIX)) continue;
    if ((element as SVGElement).style?.display === 'none') continue;
    const rect = navigationRectOf(element);
    if (rect === null) continue;
    const packageId = normalizedPackageId(element.getAttribute('data-package-id'))
      ?? packageIdOfNodeId(id);
    items.push({ id, kind: 'entity', packageId, ...rect });
  }
  for (const element of host.querySelectorAll('.uml-package[data-package-id]')) {
    const packageId = normalizedPackageId(element.getAttribute('data-package-id'));
    if (packageId === null || packageId === '') continue;
    if ((element as SVGElement).style?.display === 'none') continue;
    const rect = navigationRectOf(element);
    if (rect === null) continue;
    items.push({ id: `${PACKAGE_NAV_PREFIX}${packageId}`, kind: 'package', packageId, ...rect });
  }
  return items;
}

/** The drawn element a cursor id names. */
function navigationElementOf(host: HTMLElement, cursorId: string): Element | null {
  if (!cursorId.startsWith(PACKAGE_NAV_PREFIX)) return nodeElement(host, cursorId);
  const packageId = cursorId.slice(PACKAGE_NAV_PREFIX.length);
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    if (normalizedPackageId(frame.getAttribute('data-package-id')) === packageId) return frame;
  }
  return null;
}

/**
 * Paint the keyboard cursor: remove the previous ring, mark the new element for
 * `aria-activedescendant`, and draw a 3px ring with a 2px gap around its box —
 * a shape cue, not a colour-only one. The ring is a separate SVG rect so a
 * reader (and the e2e guard) can read its screen rectangle.
 */
function paintNavigationFocus(host: HTMLElement, cursorId: string | null): void {
  for (const ring of host.querySelectorAll('[data-architecture-nav-ring]')) ring.remove();
  for (const marked of host.querySelectorAll(`.${NAV_FOCUS_CLASS}`)) {
    marked.classList.remove(NAV_FOCUS_CLASS);
    marked.removeAttribute('data-architecture-nav-focus');
  }
  if (cursorId === null) return;
  const element = navigationElementOf(host, cursorId);
  if (element === null) return;
  element.id = navigationDomId(cursorId);
  element.classList.add(NAV_FOCUS_CLASS);
  element.setAttribute('data-architecture-nav-focus', 'true');
  const rect = navigationRectOf(element);
  const svg = host.querySelector('svg');
  if (rect === null || svg === null) return;
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  ring.setAttribute('data-architecture-nav-ring', 'true');
  ring.setAttribute('x', String(rect.x - NAV_RING_GAP));
  ring.setAttribute('y', String(rect.y - NAV_RING_GAP));
  ring.setAttribute('width', String(rect.width + NAV_RING_GAP * 2));
  ring.setAttribute('height', String(rect.height + NAV_RING_GAP * 2));
  ring.setAttribute('rx', '4');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', '#1d4ed8');
  ring.setAttribute('stroke-width', '3');
  ring.setAttribute('pointer-events', 'none');
  svg.appendChild(ring);
}

/** Remove every trace of the keyboard cursor from a drawing. */
function clearNavigationFocus(host: HTMLElement): void {
  paintNavigationFocus(host, null);
}

/**
 * The renderer-local budget hints are accepted (the contract carries them) but
 * deliberately unused: the overview/group/neighbourhood views below derive what
 * is visible from the graph itself, which is this renderer's replacement for
 * the old maxHops/maxNodes truncation.
 */
type PlantUmlGraphProps = ArchitectureRendererProps & {
  /**
   * A node the panel asked this renderer to reveal (a search hit, or a match
   * that was outside the current detail range). The renderer centres the drawn
   * box on it and selects it. It does NOT change the view unless `focusDrill`
   * is set: the interaction review found that pressing Enter in the search box
   * replaced the whole drawing with the entity's neighbourhood, losing the
   * context the reader was searching in.
   */
  readonly focusNodeId?: string | null;
  /** Bumped on every request, so asking for the same node twice re-centres it. */
  readonly focusToken?: number;
  /**
   * Whether this focus request also opens the node's neighbourhood. Only the
   * explicit "view neighbourhood" command (Shift+Enter, or the result row's
   * secondary button) sets it.
   */
  readonly focusDrill?: boolean;
  /**
   * Reports the view currently drawn (overview/group/neighbourhood/hierarchy)
   * so the panel's export menu can rebuild the document that is on screen.
   * Optional: a renderer embedded without a panel has no menu to feed.
   */
  readonly onViewChange?: (view: ArchitectureDiagramView) => void;
  /**
   * Manual curation. Optional as a group so a renderer embedded without a
   * curation store keeps drawing exactly as before (no menu, no key handling).
   */
  readonly canCurate?: boolean;
  readonly pinnedNodeIds?: readonly string[];
  readonly onPinNode?: (node: ArchitectureRendererNode) => void;
  readonly onUnpinNode?: (node: ArchitectureRendererNode) => void;
  readonly onRemoveNode?: (node: ArchitectureRendererNode) => void;
  readonly onHideRelation?: (edge: ArchitectureRendererEdge) => void;
  /** "Only show this pinned item": the panel narrows the drawing to one node. */
  readonly onSoloNode?: (node: ArchitectureRendererNode) => void;
  /**
   * The context menu's "Put in chat input": the panel composes the message.
   * Optional so a renderer embedded without a chat keeps drawing as before.
   */
  readonly onPutNodeInChat?: (node: ArchitectureRendererNode) => void;
  /** Ctrl/Cmd+Z while the canvas is focused: undo the latest adjustment. */
  readonly onUndo?: () => void;
  /**
   * Additive click: Shift/Ctrl/Cmd on a fine pointer, or any tap while the touch
   * multi-select mode is on. The panel toggles that member of the set; without
   * this callback the click keeps the contract's replace semantics.
   */
  readonly onToggleNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onToggleEdgeClick?: (edge: ArchitectureRendererEdge) => void;
  /**
   * The whole selection set, used to style every member. The contract's
   * `selectedNodeId`/`selectedRelation` stay the primary reading, so a renderer
   * embedded without the panel keeps exactly its old props.
   */
  readonly selectedNodeIds?: readonly string[];
  readonly selectedRelations?: readonly {
    readonly from: string;
    readonly to: string;
    readonly relationType: string;
  }[];
  /** Whether the touch multi-select mode is on (taps become toggles). */
  readonly multiSelectMode?: boolean;
  /**
   * A 500ms press on an entity on a coarse pointer. The panel turns multi-select
   * mode on and adds that node; a press anywhere else keeps the curation menu.
   */
  readonly onMultiSelectStart?: (node: ArchitectureRendererNode) => void;
  /**
   * Shift+drag marquee result (the drawn entities and relations the rectangle
   * hit). Absent keeps the canvas's old pan-only drag, which is what a renderer
   * embedded without a tray wants.
   */
  readonly onBoxSelect?: (selections: readonly ArchitectureSelection[]) => void;
  /**
   * The project whose graph is drawn. Retained for embedders that still pass
   * it; the readable-mode choice it used to key is retired, so nothing reads it.
   */
  readonly projectId?: string | null;
  /**
   * How many pixels at the bottom of the canvas are covered by chrome drawn
   * OVER it (the coarse tier's inspector drawer). The drawing reserves that
   * band — so a fitted drawing is centred above the drawer instead of behind
   * it — and a selected box is scrolled clear of it. 0 everywhere else.
   */
  readonly bottomObscuredPx?: number;
};

/**
 * The diagram's presentation scale and whether it follows the canvas.
 *
 * `auto` is the sticky fit state: every canvas size change (window resize,
 * fullscreen, the inspector/drawer/tray opening, phone rotation, a re-layout)
 * re-solves the scale after a short debounce. Any EXPLICIT zoom — a button, the
 * wheel, a pinch, the keyboard, a package click — flips the state to `manual`,
 * which keeps the reader's `scale` and only clamps the scroll. Pressing Fit
 * returns to `auto`.
 */
type DiagramZoom = {
  readonly scale: number;
  readonly fit: 'auto' | 'manual';
};

/** How long a canvas size change must settle before an `auto` fit re-solves. */
const AUTO_FIT_DEBOUNCE_MS = 150;

/**
 * The DEV-only lever the e2e control arm pulls to re-create the retired
 * fit-time CSS factor. It makes every semantic Fit multiply the semantic scale
 * by a factor the same way the shipped defect did, so the arm can prove its
 * min-font reading lands on the failing side. DEV-gated like the other levers:
 * a production build does not contain this branch.
 */
const FIT_CSS_FACTOR_STORAGE_KEY = 'architecture-fit-css-factor';

/** The control-arm CSS factor, or `null` when the shipped path runs. */
function forcedFitCssFactor(): number | null {
  if (import.meta.env.DEV) {
    try {
      const stored = window.localStorage.getItem(FIT_CSS_FACTOR_STORAGE_KEY);
      if (stored === null) return null;
      const value = Number.parseFloat(stored);
      return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
    } catch {
      // Private mode: the shipped path applies.
    }
  }
  return null;
}

/**
 * The DEV-only lever that restores the retired "unreadable fit opens focused"
 * rule: the drawing opens at the readable floor instead of the solved fit, the
 * state the control arm measures as overflow on the Quay fixture.
 */
const DEFAULT_FOCUS_STORAGE_KEY = 'architecture-default-focus';

/** Whether this build's control arm asked for the retired focus default. */
function forcedDefaultFocus(): boolean {
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem(DEFAULT_FOCUS_STORAGE_KEY) === 'on';
    } catch {
      // Private mode: the shipped path applies.
    }
  }
  return false;
}

/**
 * The DEV-only lever that suppresses the `auto` re-solve, so the control arm can
 * prove the resize criterion goes red when the ResizeObserver path is off.
 */
const AUTO_FIT_STORAGE_KEY = 'architecture-auto-fit';

/** Whether this build's control arm disabled auto refit. */
function autoFitDisabled(): boolean {
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem(AUTO_FIT_STORAGE_KEY) === 'off';
    } catch {
      // Private mode: auto refit stays on.
    }
  }
  return false;
}

/**
 * Renders one architecture neighbourhood as a lazily loaded PlantUML/ELK
 * layered diagram.
 *
 * Used by ArchitecturePanel. THREE views replace the old maxHops/maxNodes
 * truncation, and all of them slice the payload already in hand:
 *  · overview — the whole graph folded into path groups (`groupByPathPrefix`);
 *  · group — clicking an overview group expands just that group;
 *  · neighbourhood — clicking an entity drills into it, and clicking the
 *    centred entity again adds one hop.
 * Hovering a node highlights its in/out edges and dims the rest; clicking an
 * entity pins that highlight and announces the entity with its JSON in/out
 * neighbours on `architecture:entity-selected`, while a sibling panel can ask
 * for one by id through `architecture:highlight-entity`. Every view is local:
 * nothing here re-enters the fetch. The renderer package is imported
 * dynamically, so elkjs never enters the first-screen bundle.
 */
export function PlantUmlGraph({
  graph,
  idShape = DEFAULT_NODE_ID_SHAPE,
  diffHighlight = null,
  detailReading,
  onNodeClick,
  onEdgeClick,
  onSelectionClear,
  onNodeHover,
  onEscapeSelection,
  selectedNodeId = null,
  selectedRelation = null,
  relayoutLocked = false,
  fitRequest = null,
  onZoomModeChange,
  onExport,
  onDrawnPlantUmlChange,
  focusNodeId = null,
  focusToken,
  focusDrill = false,
  onViewChange,
  canCurate = false,
  pinnedNodeIds = [],
  onPinNode,
  onUnpinNode,
  onRemoveNode,
  onHideRelation,
  onSoloNode,
  onPutNodeInChat,
  onUndo,
  onToggleNodeClick,
  onToggleEdgeClick,
  selectedNodeIds,
  selectedRelations,
  multiSelectMode = false,
  onMultiSelectStart,
  onBoxSelect,
  bottomObscuredPx = 0,
  topObscuredPx = 0,
}: PlantUmlGraphProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The structural diff to mark on the NEXT drawing; a repaint reads this ref.
  const diffHighlightRef = useRef<ArchitectureDiffHighlight | null>(diffHighlight);
  // The pointer/size tier: coarse pointers get 44px hit areas, narrow screens
  // collect the toolbar into one overflow menu (see `useTouchLayout`).
  const {
    touchUi,
    coarsePointer,
    compactToolbar,
    portraitControlsOverlay,
    portraitPhone,
    shortTouch,
  } = useTouchLayout();
  // The semantic layout runs from imperative callbacks, so the pointer tier
  // that picks the minimum font size is mirrored into a ref.
  const coarsePointerRef = useRef(coarsePointer);
  coarsePointerRef.current = coarsePointer;
  // On the compact tier the panel owns the single toolbar row and lends its
  // overflow menu as the slot these controls are drawn into; `null` (menu shut)
  // means this renderer has no chrome on screen at all.
  const compactToolbarSlot = useCompactToolbarSlot();
  const touchTargetStyle = touchUi ? TOUCH_TARGET_STYLE : undefined;
  // Which slice of the payload is drawn. Local by construction: the payload is
  // fetched whole, so switching views must never re-request it. The class view
  // starts on the whole hierarchy (entities in package frames); the file view
  // starts on the directory-grouped overview.
  const entityGraph = isEntityGraph(idShape);
  const [view, setView] = useState<ArchitectureDiagramView>(() => defaultViewOf(idShape));
  // What the last render actually drew; drives the visible-count readout and
  // lets a test tell a stale SVG from the new view's SVG.
  const [drawn, setDrawn] = useState<{ view: ArchitectureDiagramView; nodes: number; edges: number } | null>(null);
  // A failed render is shown instead of the previous (now stale) diagram.
  const [failure, setFailure] = useState<string | null>(null);
  // How long the drawing on screen took to lay out and render, in ms. Exposed
  // as `data-architecture-layout-ms` for the DoD's readings; deliberately not
  // shown as UI text (a number the reader cannot act on is noise).
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  // Read inside the delegated DOM listeners without re-registering them: the
  // listeners are registered once per mount, while these values change as the
  // parent re-renders (hover key, graph swap).
  const viewRef = useRef(view);
  const graphRef = useRef(graph);
  const hoverCallbackRef = useRef(onNodeHover);
  const clickCallbackRef = useRef(onNodeClick);
  const edgeClickCallbackRef = useRef(onEdgeClick);
  const selectionClearCallbackRef = useRef(onSelectionClear);
  const escapeSelectionCallbackRef = useRef(onEscapeSelection);
  // Multi-select callbacks, in refs for the same reason as the click callbacks:
  // the delegated listeners are registered once per mount.
  const toggleNodeCallbackRef = useRef(onToggleNodeClick);
  const toggleEdgeCallbackRef = useRef(onToggleEdgeClick);
  const multiSelectStartCallbackRef = useRef(onMultiSelectStart);
  const boxSelectCallbackRef = useRef(onBoxSelect);
  const multiSelectModeRef = useRef(multiSelectMode);
  // A click the browser fires AFTER a gesture that already acted (a long-press
  // entering multi-select, or a marquee release) must not toggle/clear again.
  const suppressClickRef = useRef(false);
  // Whether Shift is held, read by the drag-pan predicate. Updated from a
  // window CAPTURE listener so it is fresh before the canvas's bubble listeners.
  const shiftHeldRef = useRef(false);
  // The marquee rectangle in the canvas's coordinates (null when not dragging).
  // State, not a ref: the overlay must follow the finger/pointer.
  const [marquee, setMarquee] = useState<
    { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null
  >(null);
  // The same rectangle in client pixels, for the hit test on release.
  const marqueeClientRef = useRef<ArchitectureSelectionRect | null>(null);
  // The drawn-model consumer. A ref, like the other callbacks: reporting the
  // model must not make the draw effect depend on the parent's render identity.
  const drawnCallbackRef = useRef(onDrawnPlantUmlChange);
  // The geometry of the current drawing, kept beside the model it belongs to.
  const drawnLayoutRef = useRef<unknown>(null);
  // The panel's selection, readable from the delegated listeners and the async
  // draw without re-registering either. It is also what the draw re-applies
  // after replacing the SVG.
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  const selectedRelationRef = useRef<PlantUmlGraphProps['selectedRelation']>(selectedRelation);
  // The whole set, readable from the async draw that replaces the SVG.
  const selectedNodeIdsRef = useRef<readonly string[]>(selectedNodeIds ?? []);
  const selectedRelationsRef = useRef<NonNullable<PlantUmlGraphProps['selectedRelations']>>(
    selectedRelations ?? [],
  );
  // The last entity the keyboard cursor stood on. A ref (not state): the
  // cursor's own move only edits SVG classes/ids, and this reading exists so
  // re-entering the navigation state lands where the reader left off rather
  // than at the top-left entity.
  const keyboardFocusRef = useRef<string | null>(null);
  // Whether the canvas is in its entity-navigation state: Enter puts it there,
  // Escape leaves it. State, not a ref, because the host's role and
  // `aria-activedescendant` are render output that must follow it.
  const [navigationActive, setNavigationActive] = useState(false);
  // The item the keyboard cursor stands on (an entity id, or
  // `package::<path>`). Also state: it is the `aria-activedescendant` value.
  const [navigationCursorId, setNavigationCursorId] = useState<string | null>(null);
  // The polite live-region sentence for the current entity / last selection.
  const [navigationAnnouncement, setNavigationAnnouncement] = useState('');
  // The same two readings as refs: the redraw callback (async, outside the
  // render that created it) re-paints the ring from the settled values.
  const navigationActiveRef = useRef(false);
  const navigationCursorRef = useRef<string | null>(null);
  // The entity the user clicked (or a sibling panel asked for). Unlike the
  // hover reading it survives leaving the node and being re-rendered, so the
  // dependency/reverse-dependency highlight stays pinned until the selection is
  // replaced or cleared.
  const selectedRef = useRef<string | null>(null);
  // A state copy of the selection, used only to render the explicit "Drill in"
  // action. It deliberately does not feed the drawing effect: selecting must
  // never re-lay the diagram out.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Whether the selection came from a touch tap. A desktop click already
  // navigated, so only a touch selection needs a separate drill command.
  const [selectedByTouch, setSelectedByTouch] = useState(false);
  // The pointer type of the last press on the graph. A click that follows a
  // touch press keeps the touch semantics (select only); a mouse click keeps
  // the original click-to-drill behaviour.
  const lastPointerTypeRef = useRef<string | null>(null);
  // The previous tap, for the touch double-tap drill gesture.
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  // The pin menu: right-click (desktop) or long-press (touch) on a node or a
  // relation opens the same adjustment actions the inspector offers. Null keeps
  // it shut; the position is in the canvas's own coordinate space.
  const [contextMenu, setContextMenu] = useState<
    | { readonly x: number; readonly y: number; readonly nodeId: string }
    | { readonly x: number; readonly y: number; readonly edge: ArchitectureRendererEdge }
    | null
  >(null);
  const pinnedSet = useMemo(() => new Set(pinnedNodeIds), [pinnedNodeIds]);
  useEffect(() => {
    viewRef.current = view;
    graphRef.current = graph;
    hoverCallbackRef.current = onNodeHover;
    clickCallbackRef.current = onNodeClick;
    edgeClickCallbackRef.current = onEdgeClick;
    selectionClearCallbackRef.current = onSelectionClear;
    escapeSelectionCallbackRef.current = onEscapeSelection;
    toggleNodeCallbackRef.current = onToggleNodeClick;
    toggleEdgeCallbackRef.current = onToggleEdgeClick;
    multiSelectStartCallbackRef.current = onMultiSelectStart;
    boxSelectCallbackRef.current = onBoxSelect;
    multiSelectModeRef.current = multiSelectMode;
    drawnCallbackRef.current = onDrawnPlantUmlChange;
    selectedNodeIdRef.current = selectedNodeId;
    selectedRelationRef.current = selectedRelation;
    selectedNodeIdsRef.current = selectedNodeIds
      ?? (selectedNodeId === null ? [] : [selectedNodeId]);
    selectedRelationsRef.current = selectedRelations
      ?? (selectedRelation === null ? [] : [selectedRelation]);
    diffHighlightRef.current = diffHighlight;
  }, [view, graph, onNodeHover, onNodeClick, onEdgeClick, onSelectionClear, onEscapeSelection, onDrawnPlantUmlChange, selectedNodeId, selectedRelation, selectedNodeIds, selectedRelations, onToggleNodeClick, onToggleEdgeClick, onMultiSelectStart, onBoxSelect, multiSelectMode, diffHighlight]);

  // Repaint the selection whenever the panel changes it. The draw effect below
  // applies the same styles to a fresh SVG; this one covers a selection made
  // without a re-layout. The whole set is styled; `selectedNodeId` stays the
  // primary reading the pinned highlight and Delete follow.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const nodeIds = selectedNodeIds ?? (selectedNodeId === null ? [] : [selectedNodeId]);
    const relationList = selectedRelations ?? (selectedRelation === null ? [] : [selectedRelation]);
    applySelectionStyles(host, nodeIds, relationList);
    selectedRef.current = selectedNodeId;
    if (selectedNodeId !== null) highlightSelection(host, selectedNodeId);
    else if (relationList.length === 0) clearHighlight(host);
  }, [selectedNodeId, selectedRelation, selectedNodeIds, selectedRelations]);

  // Tell the panel which slice is on screen. The export menu rebuilds exactly
  // this view; a remount (session/scope change resets `view`) reports the
  // overview again, so the panel never exports a stale drill-down.
  useEffect(() => {
    onViewChange?.(view);
  }, [onViewChange, view]);

  // The viewed scale and whether it follows the canvas (see DiagramZoom).
  // Rendering reads it for the toolbar readout; the semantic path rewrites the
  // geometry at this scale and the ordinary path resizes the SVG imperatively,
  // so neither re-enters the drawing path.
  const [zoom, setZoom] = useState<DiagramZoom>({ scale: 1, fit: 'auto' });
  // Mirror of `zoom` for the async render / wheel / resize handlers, which run
  // outside the render that last committed the state.
  const zoomRef = useRef(zoom);
  const viewportRef = useRef<SvgViewportController | null>(null);
  /**
   * The drawing's ORIGINAL size for every fit computation.
   *
   * Semantic zoom rewrites the SVG's width/height to the mapped layout's size,
   * so `readSvgNaturalSize` would feed the fit a size that already contains the
   * zoom and the stretch — a feedback loop. The controller keeps the base size
   * the engine was built from; the ordinary scaled mode has none and reads the
   * element as before.
   */
  const naturalOfDrawing = useCallback((drawing: SVGSVGElement | null): SvgViewportSize | null => {
    // The folded tier is the exception the rule above does not cover: its
    // packed drawing is NOT the original geometry times a scale (`x`/`y` are
    // identity maps), so measuring a fit against the original bounds would ask
    // for a scale of a fraction of a percent and then render the fold at 1:1
    // anyway. Here the drawing on screen IS its own natural size.
    const folded = appliedLayoutRef.current;
    if (folded !== null && folded.foldDepth !== null) {
      return { width: Math.max(1, folded.content.width), height: Math.max(1, folded.content.height) };
    }
    const semanticBase = viewportRef.current?.semanticBaseSize() ?? null;
    if (semanticBase !== null) return semanticBase;
    return drawing === null ? null : readSvgNaturalSize(drawing);
  }, []);
  const applyZoom = useCallback((next: DiagramZoom): void => {
    // A settle that re-derives the same state must not re-render (the semantic
    // pass writes the solved scale back after every application).
    if (next.scale === zoomRef.current.scale && next.fit === zoomRef.current.fit) return;
    zoomRef.current = next;
    setZoom(next);
  }, []);

  // The package the reader zoomed into from the too-small overview hint (the  // "tap a package" gesture), or `null` while the whole graph is on screen. It
  // is what keeps the hint row visible after the zoom and gives that row its
  // "back to whole graph" action; a fit or an explicit readable-mode switch
  // clears it.
  const [packageFocus, setPackageFocus] = useState<string | null>(null);

  /** The viewBox origin of the drawing on screen, in user units (usually 0,0). */
  const drawingOrigin = useCallback((): { x: number; y: number } => {    const parts = (hostRef.current?.querySelector('svg')?.getAttribute('viewBox') ?? '')
      .trim().split(/[\s,]+/).map(Number);
    return parts.length === 4 && parts.every(Number.isFinite)
      ? { x: parts[0], y: parts[1] }
      : { x: 0, y: 0 };
  }, []);

  // The panel's chrome-row cell this renderer draws the zoom tier into, or null
  // when the renderer is not inside a panel (see `CanvasHeaderSlotContext`).
  const canvasHeaderSlot = useCanvasHeaderSlot();

  /**
   * The floating corner chrome rectangles — the minimap and the zoom cluster —
   * in the canvas content box's coordinates (the box `measureViewportSize`
   * returns: host border box minus its padding). An unlaid-out element (jsdom,
   * a hidden tab) reports a zero-area box and is dropped, so a missing
   * measurement can never be read as "the chrome covers everything".
   */
  const cornerRects = useCallback((): SvgCornerRect[] => {
    const host = hostRef.current;
    const canvas = host?.parentElement ?? null;
    const overlays = canvas?.querySelector<HTMLElement>('[data-architecture-canvas-overlays]') ?? null;
    if (host === null || overlays === null) return [];
    const hostRect = host.getBoundingClientRect();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
    const paddingLeft = Number.parseFloat(style?.paddingLeft ?? '') || 0;
    const paddingTop = Number.parseFloat(style?.paddingTop ?? '') || 0;
    const originLeft = hostRect.left + paddingLeft;
    const originTop = hostRect.top + paddingTop;
    const rects: SvgCornerRect[] = [];
    for (const child of overlays.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      rects.push({
        left: rect.left - originLeft,
        top: rect.top - originTop,
        width: rect.width,
        height: rect.height,
      });
    }
    return rects;
  }, []);

  /**
   * The whole-graph fit placement for a CSS-scaled (non-semantic) drawing: the
   * geometric fit, moved off-centre when the floating corner chrome would
   * otherwise cover it. The semantic path never uses a CSS factor, so this is
   * only consulted when no semantic capture exists.
   */
  const fitPlacementFor = useCallback(
    (natural: SvgViewportSize, box: SvgViewportSize): SvgFitPlacement =>
      fitPlacementAvoidingCorners(natural, box, cornerRects(), MIN_ZOOM_SCALE),
    [cornerRects],
  );

  /**
   * Apply a fit placement to the drawing through its own margins. The host is a
   * flex column with `align-items: flex-start`; an explicit left/top margin
   * pins the drawing at the placement's offset, while `margin-bottom: auto`
   * keeps it from being stretched. `null` restores the stylesheet's centring.
   */
  const applyPlacement = useCallback((drawing: SVGSVGElement | null, placement: SvgFitPlacement | null): void => {
    if (drawing === null) return;
    if (placement === null) {
      drawing.style.marginLeft = 'auto';
      drawing.style.marginRight = 'auto';
      drawing.style.marginTop = 'auto';
      drawing.style.marginBottom = 'auto';
      return;
    }
    drawing.style.marginLeft = placement.offsetX > 0 ? `${placement.offsetX}px` : '0';
    drawing.style.marginRight = 'auto';
    drawing.style.marginTop = placement.offsetY > 0 ? `${placement.offsetY}px` : '0';
    drawing.style.marginBottom = 'auto';
  }, []);

  /**
   * Zoom the viewport onto one drawn package frame and centre it.
   *
   * Occurrences: the overview hint's "tap a package" gesture while the whole
   * graph is too small to read. The target scale is the one that makes the
   * frame fill most of the content box, lifted to the readable floor so the
   * gesture always lands on text a reader can use; the offsets come from the
   * drawing's own user units, so the frame is centred without waiting for a
   * layout pass. A package the drawing has no frame for is a no-op.
   */
  const zoomToPackage = useCallback((packageId: string): void => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) return;
    const frame = drawnPackageFrame(host, packageId);
    const box = measureViewportSize(host);
    if (frame === null || box === null) return;
    const multiplier = Math.min(
      (box.width * 0.9) / frame.width,
      (box.height * 0.9) / frame.height,
    );
    if (semanticCaptureRef.current !== null) {
      // The frame's attributes are already in the CURRENT map's screen units,
      // so the multiplier is relative to the scale on screen. The new scale is
      // solved by the same engine as Fit (its floor-font rule keeps every label
      // readable), and the geometry is rewritten now rather than 200 ms later.
      const current = appliedLayoutRef.current?.scale ?? zoomRef.current.scale;
      const solved = clampZoomScale(Math.max(current * multiplier, MIN_ZOOM_SCALE));
      applyZoom({ scale: solved, fit: 'manual' });
      centerPackageOnApplyRef.current = packageId;
      applySemanticRef.current?.({ fit: false, scale: solved });
      setPackageFocus(packageId);
      return;
    }
    const scale = clampZoomScale(Math.max(multiplier, MIN_READABLE_ZOOM_SCALE));
    const applied = viewport.zoomTo(scale);
    applyZoom({ scale: applied, fit: 'manual' });
    // The fit placement pins explicit margins; a zoomed package is centred by
    // the scroll offsets below instead, so hand the drawing back to `auto`.
    applyPlacement(host.querySelector('svg'), null);
    const origin = drawingOrigin();
    const offsets = centeredScrollForDrawingRect(box, {
      left: frame.x - origin.x,
      top: frame.y - origin.y,
      width: frame.width,
      height: frame.height,
    }, applied);
    host.scrollLeft = offsets.left;
    host.scrollTop = offsets.top;
    setPackageFocus(packageId);
  }, [applyPlacement, applyZoom, drawingOrigin]);

  // Set when a drawing was too wide for its container and was collapsed to the
  // directory overview; the notice stays until the user asks for the explosion
  // view again.
  const [collapsedNotice, setCollapsedNotice] = useState(false);

  /**
   * The navigation command, kept separate from the gesture that triggers it:
   * a desktop click runs it immediately, while a touch tap selects first and
   * reaches it through a double-tap or the "Drill in" button.
   */
  const drillInto = useCallback((id: string): void => {
    if (id.startsWith(STUB_PREFIX)) return;
    if (id.startsWith(GROUP_PREFIX)) {
      setView({ kind: 'group', prefix: id.slice(GROUP_PREFIX.length) });
      return;
    }
    const current = viewRef.current;
    const hops = current.kind === 'neighborhood' && current.entityId === id
      ? current.hops + 1
      : DEFAULT_NEIGHBORHOOD_HOPS;
    setView({ kind: 'neighborhood', entityId: id, hops });
  }, []);

  const drillSelected = useCallback((): void => {
    const id = selectedRef.current;
    if (id !== null) drillInto(id);
  }, [drillInto]);

  /**
   * A panel-level focus request (a search hit / an inspector "centre" action).
   * It selects the named node and centres it — the drawing stays on the view
   * the reader was working in, so the context a search was asked from survives.
   * Only an explicit `focusDrill` (Shift+Enter / "View neighbourhood") opens the
   * node's own neighbourhood. Keyed by `focusToken` so choosing the same node
   * twice re-centres it.
   */
  useEffect(() => {
    if (focusNodeId === null) return;
    selectedRef.current = focusNodeId;
    setSelectedId(focusNodeId);
    setSelectedByTouch(false);
    if (focusDrill) setView({ kind: 'neighborhood', entityId: focusNodeId, hops: DEFAULT_NEIGHBORHOOD_HOPS });
  }, [focusNodeId, focusToken, focusDrill]);

  // Switching the class/file subgraph is a new drawing, so a drill-down state
  // from the previous one must not be carried over: a neighbourhood opened in
  // the class diagram used to reappear after switching to the file graph and
  // back. The default view is the discriminator (hierarchy vs. overview).
  const previousIdShapeRef = useRef(idShape);
  useEffect(() => {
    if (previousIdShapeRef.current === idShape) return;
    previousIdShapeRef.current = idShape;
    setView(defaultViewOf(idShape));
  }, [idShape]);

  // The drawing captured for semantic zoom: its annotated inner SVG, the
  // geometry read once, and the tooltips annotateNodes added. `null` for views
  // that are not semantically zoomed (the grouped file overview).
  const semanticCaptureRef = useRef<SemanticCapture | null>(null);
  const semanticTierRef = useRef<SemanticTier | null>(null);
  /**
   * The last layout's cost per drawing KIND (`entity` / `file`), keyed by the
   * id shape. The status estimate reads the sample of the kind it is about to
   * lay out: class boxes and file boxes cost different amounts, and a file
   * drawing's 200-node sample must not predict a class drawing's 500.
   */
  const layoutSamplesRef = useRef<Map<string, LayoutSample>>(new Map());
  /**
   * How many entities the layout in progress holds, or `null` when no layout is
   * running. Essential state, not a derived reading: it is written BEFORE the
   * blocking ELK call and cleared after it, and nothing in the render output
   * can reconstruct "a layout this size is running right now".
   */
  const [layoutStatusNodes, setLayoutStatusNodes] = useState<number | null>(null);
  /**
   * How many package levels the folded tier kept for the drawing on screen, or
   * `null` for every other tier. State, not a derived value: it is the semantic
   * pass's reading of the geometry it just rewrote, and nothing in the render
   * output can reconstruct it.
   */
  const [foldDepth, setFoldDepth] = useState<number | null>(null);
  // The last layout applied to the captured drawing, plus the font it was
  // planned at. The scroll listener re-reads them to keep the sticky package
  // names at the viewport's top edge as the reader pans.
  const appliedLayoutRef = useRef<SemanticZoomLayout | null>(null);
  const appliedFontRef = useRef<number>(SEMANTIC_MIN_FONT_PX);
  // A package the reader asked to zoom into; the next semantic application
  // centres THIS frame instead of the densest window.
  const centerPackageOnApplyRef = useRef<string | null>(null);
  // The neighbourhood's centre entity, re-marked after every rewrite (the
  // rewrite rebuilds the node groups' children from the captured drawing).
  const neighborCenterRef = useRef<string | null>(null);
  // The semantic application, reachable from `zoomToPackage` (defined above it)
  // so the "tap a package" gesture rewrites and centres in one go, and from the
  // debounced resize / zoom paths.
  const applySemanticRef = useRef<((options: { readonly fit: boolean; readonly scale: number }) => void) | null>(null);
  const lodSchedulerRef = useRef<ExplosionLodScheduler | null>(null);
  const [lodDepth, setLodDepth] = useState<0 | 1 | 2 | null>(null);
  // Bumped whenever the semantic pass rewrites the geometry, so the minimap
  // re-reads its boxes instead of blitting the previous scale's bitmap.
  const [drawnRevision, setDrawnRevision] = useState(0);

  // Repaint the structural diff whenever the panel hands a new set in, and after every draw:
  // the two subgraphs (and the drill-down views) each rewrite the SVG, and a marker applied to
  // the previous drawing is gone with it.
  useEffect(() => {
    diffHighlightRef.current = diffHighlight;
    const host = hostRef.current;
    if (host !== null) applyDiffStyles(host, diffHighlight);
  }, [diffHighlight, drawnRevision]);
  // Whether the portrait phone's zoom cluster is open. Why state: the tier
  // ships ONE 44px button by default (its drawing owns the height), and the
  // reader's open is what reveals the ±/Fit row. Not persisted: the compact
  // default is part of the tier, not a per-reader preference.
  const [clusterExpanded, setClusterExpanded] = useState(false);

  /**
   * Write one semantic layout onto the captured drawing, INCLUDING the folded
   * tier's omissions.
   *
   * The scale is the drawing's ONLY scale: `drawSemanticLayout` bakes the
   * engine's map into the geometry and sizes the SVG to the mapped content, so
   * the element is shown 1:1 (`k = 1`). No CSS factor is ever applied on top —
   * the retired Fit path multiplied the already-mapped drawing by
   * `min(1, canvas ÷ content)`, which is what made a 17 % map print 74 % and
   * push 10 px floor text down to 7.4 px.
   *
   * `drawSemanticLayout` also hands the folded tier the drawings it owns (it
   * drops whole sub-packages and every relation); those consequences live here
   * rather than in the DOM writer because they are the CALLER's view of the
   * layout.
   */
  const applySemanticLayout = useCallback((
    host: HTMLElement,
    capture: SemanticCapture,
    layout: SemanticZoomLayout,
    fontPx: number,
  ): void => {
    drawSemanticLayout(host, capture, layout, fontPx);
    // The rewritten drawing rebuilds every node group's children, so the
    // coarse-pointer hit rectangles are laid down again on the geometry that is
    // actually on screen (they are not part of `capture.inner`, which stays the
    // undecorated snapshot).
    addNodeHitTargets(host, coarsePointerRef.current);
    // The renderer's own `.uml-canvas` rectangle is a paper-coloured fill sized
    // to the mapped CONTENT. Once the geometry pass reshapes the drawing, that
    // leaves a white rectangle around the content with the panel's own
    // background showing outside it — the seam the review found on both
    // viewports. The rectangle is made transparent, so the canvas background IS
    // the panel's background; no second colour is painted anywhere.
    for (const canvasRect of host.querySelectorAll<SVGRectElement>('svg .uml-canvas')) {
      canvasRect.setAttribute('fill', 'none');
    }
    if (layout.foldDepth !== null) {
      const drawnPackages = new Set(layout.packages.map((entry) => entry.id));
      for (const group of host.querySelectorAll('.uml-package[data-package-id]')) {
        if (!drawnPackages.has(group.getAttribute('data-package-id') ?? '')) {
          (group as SVGGElement).style.display = 'none';
        }
      }
      // The folded tier draws packages only: the entity relations were mapped
      // for a geometry that no longer exists.
      for (const group of host.querySelectorAll('.uml-edge[data-edge-source]')) {
        (group as SVGGElement).style.display = 'none';
      }
    }
    // The DEV-only control-arm lever. Production builds do not contain this
    // branch; when an arm asks for it, the retired CSS factor is re-applied so
    // the arm can prove its min-font reading lands on the failing side.
    const controlFactor = forcedFitCssFactor();
    if (controlFactor !== null) applyZoomScale(capture.svg, controlFactor);
  }, []);

  // Apply a semantic solve: `fit` asks the engine for the largest scale whose
  // mapped content fits the canvas; otherwise the reader's explicit scale is
  // honoured. Both paths draw 1:1 (see `applySemanticLayout`).
  const applySemantic = useCallback((options: { readonly fit: boolean; readonly scale: number }): void => {
    const host = hostRef.current;
    const capture = semanticCaptureRef.current;
    if (host === null || capture === null) return;
    const box = measureViewportSize(host);
    const fontPx = coarsePointerRef.current ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX;
    let layout: SemanticZoomLayout;
    let solvedScale: number;
    if (options.fit) {
      const forcedFocus = forcedDefaultFocus();
      const fit = solveFitScale(capture.geometry, { viewport: box, minFontPx: fontPx });
      if (forcedFocus && fit.fits) {
        // The control arm's retired rule: the "unreadable fit" opened at the
        // readable floor instead of the solved scale, overflowing the canvas.
        layout = solveSemanticZoom(capture.geometry, {
          scale: Math.max(fit.scale, READABLE_ZOOM_SCALE),
          viewport: box,
          previousTier: null,
          minFontPx: fontPx,
        });
        solvedScale = layout.scale;
      } else {
        layout = fit.layout;
        solvedScale = fit.scale;
      }
    } else {
      layout = solveSemanticZoom(capture.geometry, {
        scale: options.scale,
        viewport: box,
        previousTier: semanticTierRef.current,
        minFontPx: fontPx,
      });
      solvedScale = layout.scale;
    }
    semanticTierRef.current = layout.tier;
    appliedLayoutRef.current = layout;
    appliedFontRef.current = fontPx;
    applySemanticLayout(host, capture, layout, fontPx);
    setFoldDepth(layout.foldDepth);
    applyZoom({ scale: solvedScale, fit: options.fit ? 'auto' : 'manual' });
    // A rewritten SVG is a fresh set of elements: re-pin the selection and the
    // unselectable declaration, exactly as the render effect does.
    applySelectionStyles(host, selectedNodeIdsRef.current, selectedRelationsRef.current);
    highlightSelection(host, selectedRef.current);
    markDrawingUnselectable(host);
    applyDiffStyles(host, diffHighlightRef.current);
    if (neighborCenterRef.current !== null) {
      nodeElement(host, neighborCenterRef.current)?.classList.add('arch-center');
    }
    setLodDepth(lodDepthForTier(layout.tier));
    setDrawnRevision((revision) => revision + 1);
    // The zoom anchor is the densest window of the mapped layout, not the
    // bounding-box centre: on a sparse drawing the centre is blank space. A
    // "tap a package" request overrides it with that package's frame.
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0) {
      const requested = centerPackageOnApplyRef.current;
      centerPackageOnApplyRef.current = null;
      const target = requested === null
        ? null
        : layout.packages.find((entry) => entry.id === requested) ?? null;
      if (target === null) {
        host.scrollLeft = Math.max(0, layout.anchor.x - width / 2);
        host.scrollTop = Math.max(0, layout.anchor.y - height / 2);
      } else {
        const centreX = target.frame.x - layout.content.x + target.frame.width / 2;
        const centreY = target.frame.y - layout.content.y + target.frame.height / 2;
        host.scrollLeft = Math.max(0, centreX - width / 2);
        host.scrollTop = Math.max(0, centreY - height / 2);
      }
    }
    // The sticky labels and the hint are POSITIONED FROM the applied scroll
    // offset, so they are drawn after it is written. Drawing them inside the
    // layout pass measured the previous offset and left the ghosts one zoom
    // behind (the defect this task fixes).
    drawStickyLabels(host, layout, appliedFontRef.current);
    positionOverviewHint(host);
  }, [applySemanticLayout, applyZoom]);
  applySemanticRef.current = applySemantic;
  // One controller per mount: it survives the renderer replacing the SVG (each
  // render re-attaches), so the mode and scale outlive a single drawing.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    viewportRef.current = createSvgViewport(host);
    return () => {
      viewportRef.current = null;
    };
  }, []);

  // A sticky package name belongs to the VIEWPORT, not to the drawing: panning
  // must move the ghost labels with the reader, and must never leave one over a
  // class name it no longer clears. Re-place them (and the hint) on the settled
  // frame after each scroll, from the layout last applied.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let frame: number | null = null;
    const repaint = (): void => {
      frame = null;
      const layout = appliedLayoutRef.current;
      if (layout === null || semanticCaptureRef.current === null) return;
      drawStickyLabels(host, layout, appliedFontRef.current);
      positionOverviewHint(host);
    };
    const onScroll = (): void => {
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame !== 'function') {
        repaint();
        return;
      }
      frame = window.requestAnimationFrame(repaint);
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      host.removeEventListener('scroll', onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Touch gestures ride on the SAME controller the toolbar and Ctrl+wheel use,
  // so pinch never introduces a second zoom model. The host's `touch-action:
  // none` (below) is what suppresses the browser's own page pan/zoom; that is
  // also why the single-finger drag has to pan the container here.
  useEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) return;
    const gestures = createSvgTouchGestures(host, viewport, {
      onZoom: (scale) => applyZoom({ scale, fit: 'manual' }),
    });
    return () => gestures.destroy();
  }, [applyZoom]);

  // Mouse/pen panning rides on the same scroll container the touch gestures
  // pan: left-drag from the blank canvas and middle-drag from anywhere scroll
  // it. Presses on a node are refused so they stay selection/drill gestures,
  // and fingers are left to `createSvgTouchGestures` — one pan, two input
  // families, never two competing drag states.
  // Shift+drag is the marquee (below): refusing a pan while Shift is held is
  // what keeps the two drag readings from running at the same time.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const pan = createSvgDragPan(host, {
      canPanFrom: (target) => !shiftHeldRef.current
        && !(target instanceof Element && target.closest('[data-entity-id]') !== null),
    });
    return () => pan.destroy();
  }, []);

  // A press inside the drawing never starts the browser's own text selection.
  // The `user-select` rules already refuse it, but a drag can begin on a label
  // the browser treats as selectable content (and a selection that started
  // OUTSIDE the canvas survives a drag over it), so the primary-button default
  // is cancelled too — `mousedown`'s default action IS "begin a selection".
  // Cancelling it does not cancel the `click` the drawing's own select/drill
  // handlers ride on, and the wheel is a different event family entirely.
  //
  // The refusal is read from the PRESS TARGET's computed policy rather than
  // assumed: only an element declared `user-select: none` has a selection worth
  // refusing. A canvas whose policy is switched back to `auto` (the e2e control
  // arm, or a future selectable-drawing mode) keeps the browser's own
  // behaviour, which is what makes the criterion able to read a false.
  //
  // `preventDefault` also suppresses the focus a press would give the scroll
  // host, so the host is focused explicitly: click-then-arrow-keys keeps
  // panning the way it did before this guard existed.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof window === 'undefined') return;
    const onMouseDown = (event: MouseEvent): void => {
      // Right/middle presses have their own browser meanings (context menu,
      // autoscroll) and never start a selection.
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === null || window.getComputedStyle(target).userSelect !== 'none') return;
      event.preventDefault();
      const selection = window.getSelection();
      if (selection !== null && selection.rangeCount > 0) selection.removeAllRanges();
      if (document.activeElement !== host) host.focus({ preventScroll: true });
    };
    host.addEventListener('mousedown', onMouseDown);
    return () => host.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Whether Shift is held, kept fresh by a window CAPTURE listener: the capture
  // phase runs before the canvas's own bubble listeners, so the drag-pan
  // predicate reads the modifier of the very press that starts the gesture.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const record = (event: KeyboardEvent | PointerEvent): void => {
      shiftHeldRef.current = event.shiftKey;
    };
    window.addEventListener('keydown', record, true);
    window.addEventListener('keyup', record, true);
    window.addEventListener('pointerdown', record, true);
    return () => {
      window.removeEventListener('keydown', record, true);
      window.removeEventListener('keyup', record, true);
      window.removeEventListener('pointerdown', record, true);
    };
  }, []);

  // Shift+drag marquee: a rectangle in client pixels whose release selects every
  // drawn entity and relation it intersects. A plain drag never starts one (it
  // stays the pan above). The overlay is drawn in the canvas's coordinates so it
  // follows the pointer exactly.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof window === 'undefined') return;
    const canvas = host.parentElement;
    let drag: { readonly pointerId: number; readonly startX: number; readonly startY: number } | null = null;

    const canvasOffset = (): { left: number; top: number } => {
      const rect = canvas?.getBoundingClientRect();
      return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
    };
    const updateMarquee = (clientX: number, clientY: number): void => {
      if (drag === null) return;
      const box: ArchitectureSelectionRect = {
        left: Math.min(drag.startX, clientX),
        top: Math.min(drag.startY, clientY),
        right: Math.max(drag.startX, clientX),
        bottom: Math.max(drag.startY, clientY),
      };
      marqueeClientRef.current = box;
      const offset = canvasOffset();
      setMarquee({
        left: box.left - offset.left,
        top: box.top - offset.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
      });
    };

    const onDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.button !== 0 || !event.shiftKey) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
      marqueeClientRef.current = {
        left: event.clientX,
        top: event.clientY,
        right: event.clientX,
        bottom: event.clientY,
      };
      event.preventDefault();
      updateMarquee(event.clientX, event.clientY);
    };
    const onMove = (event: PointerEvent): void => {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      updateMarquee(event.clientX, event.clientY);
    };
    const onUp = (event: PointerEvent): void => {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      const box = marqueeClientRef.current;
      drag = null;
      marqueeClientRef.current = null;
      setMarquee(null);
      if (box === null) return;
      // A shift+CLICK that never travelled is not a marquee; let the click
      // listener handle it as an ordinary additive click.
      if (box.right - box.left < 2 && box.bottom - box.top < 2) return;
      suppressClickRef.current = true;
      boxSelectCallbackRef.current?.(selectionsIntersectingBox(boxCandidates(host), box));
    };
    const onCancel = (event: PointerEvent): void => {
      if (drag === null || event.pointerId !== drag.pointerId) return;
      drag = null;
      marqueeClientRef.current = null;
      setMarquee(null);
    };

    host.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, []);

  // The LOD debouncer lives for the mount; a drawing change cancels its pending
  // application through the render effect below.
  useEffect(() => {
    const scheduler = createExplosionLodScheduler();
    lodSchedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      lodSchedulerRef.current = null;
    };
  }, []);

  // The container ratio the NEXT drawing is laid out for. A resize does not
  // re-render on its own (the SVG is resized imperatively), so a shape change
  // that is worth a new layout needs a state write to re-enter the render
  // effect; it stays `null` until the first such change, letting the first draw
  // measure the container directly (see `measureLayoutAspect`).
  const [layoutAspect, setLayoutAspect] = useState<number | null>(null);
  // The ratio the drawing on screen was laid out with (`null` = the engine's own
  // default). Read by the resize observer to decide whether the container has
  // moved far enough to earn a re-layout.
  const drawnAspectRef = useRef<number | null>(null);
  // The direction the drawing on screen was laid out in, and the policy's reason
  // for it. Published as the layout readout (`data-architecture-layout-direction`
  // and its `-reason` sibling); `null` before the first drawing lands.
  const [layoutDirection, setLayoutDirection] = useState<LayoutOrientation | null>(null);
  const [layoutDirectionReason, setLayoutDirectionReason] = useState<string | null>(null);
  // One direction-decision cache per canvas. A graph re-laid out for the same
  // canvas band reuses the decision instead of paying for the comparison layout
  // a second time (see `layoutOrientation.ts`).
  const orientationCacheRef = useRef(createOrientationCache());
  // The drawing the LOD level belongs to, so an aspect re-layout of the SAME
  // view carries the current level and focus over instead of re-deriving them.
  const drawnKeyRef = useRef<string | null>(null);
  // The inputs the last layout effect run was given. When the effect re-runs
  // with the SAME inputs it is an aspect-driven re-layout (the container's
  // shape changed), not a new view/graph; a custom zoom the reader chose must
  // survive that. A genuinely new drawing re-derives its own scale.
  const layoutInputRef = useRef<{ graph: unknown; viewKey: string; idShape: string; entityGraph: boolean } | null>(null);
  // Pending debounced re-layout (one timer: the latest reading wins).
  const aspectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether aspect-driven re-layout is frozen (see `relayoutLocked`). The lock
  // lives in the panel; here it only suppresses the schedule. When it LIFTS,
  // the current container ratio becomes the new comparison base WITHOUT a
  // layout, so the dock opening/closing is never itself a shape change.
  const relayoutLockedRef = useRef(relayoutLocked);
  const wasRelayoutLockedRef = useRef(relayoutLocked);
  useEffect(() => {
    relayoutLockedRef.current = relayoutLocked;
    if (wasRelayoutLockedRef.current && !relayoutLocked) {
      const host = hostRef.current;
      const measured = host === null ? null : measureLayoutAspect(host);
      if (measured !== null) drawnAspectRef.current = measured;
    }
    wasRelayoutLockedRef.current = relayoutLocked;
  }, [relayoutLocked]);
  const scheduleAspectRelayout = useCallback((aspect: number): void => {
    if (aspectTimerRef.current !== null) clearTimeout(aspectTimerRef.current);
    aspectTimerRef.current = setTimeout(() => {
      aspectTimerRef.current = null;
      setLayoutAspect(aspect);
    }, ASPECT_RELAYOUT_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => {
    if (aspectTimerRef.current !== null) clearTimeout(aspectTimerRef.current);
    aspectTimerRef.current = null;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    // The drawing identity is recorded so a re-layout of the SAME view can
    // carry the semantic tier over inside the engine's dead band.
    const viewKey = drawingKeyOf(view);
    layoutInputRef.current = { graph, viewKey, idShape, entityGraph };
    // A pending application belongs to the drawing being replaced; the new one
    // is applied synchronously below.
    lodSchedulerRef.current?.cancel();
    setFailure(null);
    hoverCallbackRef.current?.(null);
    // A reloaded graph may not contain the previously selected entity.
    if (selectedRef.current !== null && !graph.nodes.some((node) => node.id === selectedRef.current)) {
      selectedRef.current = null;
      setSelectedId(null);
      setSelectedByTouch(false);
    }

    void (async () => {
      try {
        // The only plantuml-js/elkjs import in the module graph: Vite emits it
        // as its own async chunk, so the first-screen bundle stays untouched.
        const { renderDetailed, toPlantUml, applyView, ElkLayoutEngine } =
          (await import('@yalehwang/plantuml-js/elk')) as unknown as {
            renderDetailed: PlantUmlRenderDetailed;
            toPlantUml: PlantUmlToPlantUml;
            applyView: PlantUmlApplyView;
            ElkLayoutEngine: ArchitectureLayoutEngineClass;
          };
        if (cancelled) return;

        // The container's shape is a LAYOUT input, not a post-render scale: the
        // engine is CONSTRUCTED with it so ELK draws for this container instead
        // of for its own default proportions.
        const drawnAspect = layoutAspect ?? measureLayoutAspect(host);
        // The panel is the adaptive consumer for the FILE graph: the bridge
        // collapses its directory layers itself (the renderer's
        // `groupByPathPrefix` would count a file name as a layer, which is the
        // bug this view exists to avoid). The CLASS graph is never folded: its
        // entities are what the reader asked to see, and the layout budget —
        // not a directory fold — keeps the drawing inside the node bound. The
        // panel also states how this subgraph's ids are shaped, so a file graph
        // keeps its top directory in every group prefix and label.
        const diagram = archguardToPlantUml(graph, {
          view,
          grouping: entityGraph ? 'raw' : 'adaptive',
          idShape,
        });
        // Layout + render is the expensive, blocking part (ELK runs on the main
        // thread); its duration is the DoD's per-view reading. `renderDetailed`
        // runs the same pipeline but hands back the model that was actually
        // drawn, which the text page serializes (see `onDrawnPlantUmlChange`).
        //
        // The layout cannot be interrupted or progressed: once it starts, the
        // main thread belongs to ELK until it returns. So the reading it is
        // ABOUT to cost (this drawing's entity count times the last layout of
        // the same kind, see `estimateLayoutMs`) is taken first, and a layout
        // expected to take more than a second announces itself and yields a
        // frame, so the status is ON SCREEN before the block begins. The
        // previous drawing stays in the host throughout: nothing replaces it
        // until the new SVG is ready.
        const layoutNodes = graph.nodes.length;
        const estimate = estimateLayoutMs(layoutNodes, layoutSamplesRef.current.get(idShape) ?? null);
        const announce = estimate > LAYOUT_STATUS_THRESHOLD_MS;
        if (announce) {
          setLayoutStatusNodes(layoutNodes);
          await afterPaint();
          if (cancelled) {
            setLayoutStatusNodes(null);
            return;
          }
        }

        /**
         * One complete layout + render in one direction. The engine comes from
         * the single factory either way, so `direction` is a LAYOUT input (an
         * `elk.direction` option) and never a post-render transform.
         */
        const renderOnce = (direction?: LayoutOrientation): ReturnType<typeof renderWithMemberDetail> => {
          const engine = createLayoutEngine({
            aspectRatio: drawnAspect,
            ...(direction === undefined ? {} : { direction }),
            Engine: ElkLayoutEngine,
          });
          return renderWithMemberDetail(
            renderDetailed,
            // The document the reader copies uses real stereotypes
            // (`class "X" as n0 <<function>>`); the bundled parser needs that
            // token before the alias, so the DRAWING gets the parser-safe
            // spelling. `standardiseDrawnStereotypes` reverses it when the drawn
            // model is serialized for the text page.
            parserSafePlantUml(diagram.puml),
            {
              ...rendererOptionsFor(view, diagram, engine),
              // The box is sized from the text the renderer will PAINT: a member
              // line longer than MEMBER_MAX_CHARS is drawn with a trailing `…`,
              // BEFORE layout, so the width follows what the screen shows. Only
              // the LINES are capped here — the row cap (`MEMBER_MAX_ROWS`) is a
              // drawing rule applied after render, so no folded row ever enters
              // the model. `raw` keeps the full declaration for the Text page,
              // copy and Inspector.
              ...drawnMemberLimits(),
            },
          );
        };

        // The direction policy (see `layoutOrientation.ts`): draw the graph
        // downward, and — only for a small graph on a canvas clearly wider than
        // that drawing — draw it once more to the RIGHT, keeping whichever the
        // canvas can show larger. The decision is cached per graph + canvas
        // band, so a shape-driven re-layout reuses it instead of laying the
        // graph out twice again.
        const canvasBox = measureViewportSize(host);
        const cacheKey = canvasBox === null
          ? null
          : orientationCacheKey(graphFingerprint(graph, viewKey, idShape), canvasBox);
        const forced = forcedLayoutOrientation();
        // A forced reading is a control arm, not a cached result: it must not be
        // shadowed by a RIGHT decision the same canvas earned a moment ago.
        const cached = forced === null && cacheKey !== null
          ? orientationCacheRef.current.get(cacheKey)
          : null;

        let detailed: Awaited<ReturnType<typeof renderWithMemberDetail>>;
        let elapsedMs = 0;
        let orientation: OrientationDecision;

        if (cached !== null) {
          // Cache hit: this drawing was already evaluated for this canvas band,
          // so only its chosen direction is drawn — no comparison layout.
          const cachedStartedAt = performance.now();
          detailed = await renderOnce(cached.direction === 'DOWN' ? undefined : 'RIGHT');
          elapsedMs = Math.round(performance.now() - cachedStartedAt);
          orientation = cached;
        } else if (forced !== null) {
          const forcedStartedAt = performance.now();
          detailed = await renderOnce(undefined);
          elapsedMs = Math.round(performance.now() - forcedStartedAt);
          orientation = chooseLayoutOrientation({
            canvas: canvasBox ?? { width: 0, height: 0 },
            down: layoutSizeOf(detailed) ?? { width: 0, height: 0 },
            right: null,
            entities: layoutNodes,
            firstLayoutMs: elapsedMs,
            forceDown: true,
          });
        } else {
          const firstStartedAt = performance.now();
          const down = await renderOnce(undefined);
          const firstLayoutMs = Math.round(performance.now() - firstStartedAt);
          const downSize = layoutSizeOf(down);
          const eligibility = canvasBox === null || downSize === null
            ? { attempt: false as const, reason: ORIENTATION_REASON.canvasNotWide }
            : shouldAttemptDualLayout({
                canvas: canvasBox,
                down: downSize,
                entities: layoutNodes,
                firstLayoutMs,
              });
          if (eligibility.attempt && canvasBox !== null && downSize !== null) {
            const secondStartedAt = performance.now();
            const right = await renderOnce('RIGHT');
            const secondLayoutMs = Math.round(performance.now() - secondStartedAt);
            if (cancelled) return;
            orientation = chooseLayoutOrientation({
              canvas: canvasBox,
              down: downSize,
              right: layoutSizeOf(right),
              entities: layoutNodes,
              firstLayoutMs,
            });
            const turned = orientation.direction === 'RIGHT';
            detailed = turned ? right : down;
            elapsedMs = turned ? secondLayoutMs : firstLayoutMs;
          } else {
            orientation = chooseLayoutOrientation({
              canvas: canvasBox ?? { width: 0, height: 0 },
              down: downSize ?? { width: 0, height: 0 },
              right: null,
              entities: layoutNodes,
              firstLayoutMs,
            });
            detailed = down;
            elapsedMs = firstLayoutMs;
          }
          if (cacheKey !== null) orientationCacheRef.current.set(cacheKey, orientation);
        }

        // The next layout of this kind is estimated from this one: the sample is
        // the drawing kind's own, never another kind's.
        layoutSamplesRef.current.set(idShape, { nodes: layoutNodes, ms: elapsedMs });
        if (cancelled) return;
        // The orientation is part of the layout reading, not a hidden detail:
        // the canvas states which direction it drew and why, so a reader (and
        // the criterion's control arm) can tell the two layouts apart.
        setLayoutDirection(orientation.direction);
        setLayoutDirectionReason(orientation.reason);

        const { svg, model } = detailed;
        // The geometry the renderer used, kept for consumers that would rather
        // read rectangles than reverse-engineer the SVG (not yet wired).
        drawnLayoutRef.current = detailed.layout;
        host.innerHTML = svg;
        // The row cap is a DRAWING rule (`MEMBER_MAX_ROWS`): it removes the
        // surplus rows from the DOM and paints the app's own fold label, so the
        // model the text page serializes keeps every authored member.
        capDrawnMemberRows(host);
        // The renderer's own `.uml-canvas` rectangle paints a paper colour
        // sized to the drawing. Against the panel's background that reads as a
        // second background with a seam around it, on every view — not only the
        // semantically rewritten one (which re-applies this after each pass).
        for (const canvasRect of host.querySelectorAll<SVGRectElement>('svg .uml-canvas')) {
          canvasRect.setAttribute('fill', 'none');
        }
        setLayoutMs(elapsedMs);
        // The layout of the drawing that was just replaced must not answer
        // questions about this one (a folded layout's content size, in
        // particular, is not this drawing's).
        appliedLayoutRef.current = null;
        // The new drawing is in the host, so the layout the status described is
        // over: it is cleared in this same commit. A state write here is safe
        // because the drawing the reader now sees is already the new one.
        setLayoutStatusNodes(null);
        // The text page reads this: the model just drawn, plus the upstream
        // functions that serialize and scope it. `diagram.aliasOf` is the
        // graph-id (and overview `grp::` group) → drawn entity id map.
        drawnCallbackRef.current?.({
          model,
          entityIdOf: diagram.aliasOf,
          // The drawn model names each function `<<function>> Name` (the
          // parser-safe spelling it was rendered from); the copied document
          // must carry the stereotype as a real token instead.
          toPlantUml: (drawnModel) => standardiseDrawnStereotypes(toPlantUml(drawnModel)),
          applyView,
        });
        drawnAspectRef.current = drawnAspect;
        restoreEntityIds(host, diagram.aliasOf);
        // Labels are off until a node is hovered/selected, and every entity
        // box carries its source file + seed marker (see `annotateNodes`).
        hideEdgeLabels(host);
        annotateNodes(host, graph, idShape);
        // Relations get their enlarged, invisible hit bands; the panel's
        // selection is repainted on top of the fresh drawing.
        addEdgeHitTargets(host, coarsePointer);
        // A drawing that is semantically zoomed is captured BEFORE any
        // selection decoration: every later application restores this snapshot,
        // so no decoration can accumulate. The grouped overview (a directory
        // map, not a UML drawing) keeps the ordinary CSS-scaled viewport.
        const semanticEligible = !diagram.grouped && !(view.kind === 'overview' && !entityGraph);
        const capture = semanticEligible ? captureSemanticDrawing(host, graph) : null;
        semanticCaptureRef.current = capture;
        semanticTierRef.current = null;
        const viewportForMode = viewportRef.current;
        // The semantic base size is the SAME boundary the canvas will draw
        // (`semanticContentBounds`), not the renderer's pre-semantic viewBox:
        // the fit reading and the minimap must measure what is on screen.
        viewportForMode?.setSemanticMode(
          capture === null ? null : semanticContentBounds(capture.geometry),
        );
        applySelectionStyles(host, selectedNodeIdsRef.current, selectedRelationsRef.current);
        applyDiffStyles(host, diffHighlightRef.current);
        // Every view has its own natural size, so the scale is re-derived here
        // rather than carried over; the fit/custom MODE survives so the resize
        // observer keeps following the container only for a fit user.
        //
        // The default is not "fit everything" any more: a fit below the
        // readable floor would draw sub-pixel labels, so the readable policy
        // focuses the densest seeded package at a legible scale instead. The
        // overview toggle still offers the explicit whole-graph fit.
        const drawing = host.querySelector('svg');
        if (drawing !== null) {
          // Vertical centring lives here, not in the CSS sheet: the host is a
          // flex column and the drawing owns the auto block margins, so a short
          // drawing is centred while a taller one (negative free space) starts
          // at the top and scrolls. `flex: none` keeps the explicit width/height
          // the viewport writes from being shrunk along the column's main axis.
          drawing.style.marginTop = 'auto';
          drawing.style.marginBottom = 'auto';
          drawing.style.flex = 'none';
        }
        const viewport = viewportRef.current;
        if (drawing !== null && viewport !== null) {
          viewport.attach(drawing);
          const natural = naturalOfDrawing(drawing);
          const box = measureViewportSize(host);
          // A canvas several times wider than its container is a band, not a
          // diagram: collapse it to the directory overview and say so. Only the
          // file graph's explosion view can reach this — its overview is the
          // coarser drawing. The class view has NO coarser drawing to fall back
          // to, so it keeps its hierarchy.
          const aspectBounds = capture === null ? natural : semanticContentBounds(capture.geometry);
          if (view.kind === 'hierarchy' && !entityGraph
            && aspectBounds !== null && box !== null && canvasIsTooWide(aspectBounds, box)) {
            setCollapsedNotice(true);
            setView({ kind: 'overview' });
          } else if (view.kind === 'hierarchy') {
            setCollapsedNotice(false);
          }
          if (capture === null) {
            // The ordinary CSS-scaled drawing (a grouped directory map). `auto`
            // fits the whole drawing down to the manual floor; `manual` keeps
            // the reader's own scale. Either way the placement re-centres it.
            const placement = natural === null ? null : fitPlacementFor(natural, box ?? { width: 0, height: 0 });
            const drawnScale = zoomRef.current.fit === 'auto'
              ? viewport.zoomTo(placement?.scale ?? zoomRef.current.scale)
              : viewport.zoomTo(zoomRef.current.scale);
            applyPlacement(drawing, placement);
            applyZoom({ scale: drawnScale, fit: zoomRef.current.fit });
            // A fresh drawing is a new whole-graph view; a package zoom from
            // the previous one no longer names a frame on screen.
            setPackageFocus(null);
          }
        }
        // A fresh SVG has no highlight classes; re-pin the current selection.
        highlightSelection(host, selectedRef.current);
        neighborCenterRef.current = null;
        if (view.kind === 'neighborhood') {
          const center = diagram.rendererEntity;
          if (center !== null) {
            const id = reverseAliases(diagram.aliasOf).get(center);
            if (id !== undefined) {
              neighborCenterRef.current = id;
              nodeElement(host, id)?.classList.add('arch-center');
            }
          }
        }
        // A new drawing gets its semantic layout applied synchronously, so it
        // never flashes at the wrong detail before the debouncer fires. The
        // sticky fit state decides how: `auto` re-solves the scale against the
        // new drawing's canvas, `manual` keeps the reader's scale.
        const drawingKey = drawingKeyOf(view);
        const carriedTier = drawingKey === drawnKeyRef.current ? semanticTierRef.current : null;
        drawnKeyRef.current = drawingKey;
        if (capture === null) {
          semanticTierRef.current = null;
          appliedLayoutRef.current = null;
          setLodDepth(null);
          setFoldDepth(null);
          // A drawing with no semantic pass still needs its coarse-pointer hit
          // rectangles; the captured path lays them down inside
          // `applySemanticLayout`, after the rewrite rebuilt the nodes.
          addNodeHitTargets(host, coarsePointer);
        } else {
          semanticTierRef.current = carriedTier;
          // The new drawing is applied through ONE path, so the draw and the
          // settled-zoom/resize paths can never disagree about which scale is
          // on screen.
          applySemantic({ fit: zoomRef.current.fit === 'auto', scale: zoomRef.current.scale });
        }
        // A focus request (search hit) is centred LAST: the reader asked for
        // THIS node, so it wins.
        // The marker is what tests and sibling panels read; the scroll is the
        // actual "jump to it".
        if (focusNodeId !== null) {
          const focused = nodeElement(host, focusNodeId);
          if (focused !== null) {
            focused.classList.add('arch-focus');
            focused.setAttribute('data-architecture-focus-target', focusNodeId);
            centerElementInContainer(host, focused);
          }
        }
        // Every scroll above has landed: place the sticky package names and the
        // overview hint against the viewport the reader will actually see.
        const appliedLayout = appliedLayoutRef.current;
        if (appliedLayout !== null && semanticCaptureRef.current !== null) {
          drawStickyLabels(host, appliedLayout, appliedFontRef.current);
          positionOverviewHint(host);
        }
        setDrawn({
          view,
          nodes: host.querySelectorAll('[data-entity-id]').length,
          edges: host.querySelectorAll('[data-edge-source]').length,
        });
        // LAST DOM write of the drawing: every label, badge and hit band is in
        // place, so the unselectable declaration covers the finished drawing.
        markDrawingUnselectable(host);
      } catch (error) {
        if (cancelled) return;
        host.innerHTML = '';
        setDrawn(null);
        setLayoutMs(null);
        setLayoutDirection(null);
        setLayoutDirectionReason(null);
        // The layout ended — badly — so the status that described it must not
        // outlive it; the failure line below is the reader's explanation.
        setLayoutStatusNodes(null);
        setFoldDepth(null);
        // The previous drawing is gone; the text page must not keep describing it.
        drawnLayoutRef.current = null;
        drawnCallbackRef.current?.(null);
        setFailure(error instanceof Error ? error.message : 'unknown render error');
      }
    })();

    return () => {
      cancelled = true;
      // A superseded/unmounted drawing no longer describes the page's canvas.
      // The text page debounces its rebuild, so a redraw settling quickly never
      // flashes the bridge fallback.
      drawnLayoutRef.current = null;
      drawnCallbackRef.current?.(null);
      // A status belongs to the layout that set it; the run replacing this one
      // decides again whether to announce (and clears it again when it ends).
      setLayoutStatusNodes(null);
    };
  }, [applyPlacement, applySemantic, applySemanticLayout, applyZoom, coarsePointer, entityGraph, fitPlacementFor, focusNodeId, graph, idShape, layoutAspect, naturalOfDrawing, view]);

  /**
   * Keep the SELECTED box inside the visible canvas.
   *
   * Two states need this and they are the same reading: the coarse drawer is an
   * overlay, so its bottom band must not hide the box (the host's padding
   * reserves it, see the host style above); and the landscape-phone side column
   * NARROWS the canvas, which in a focus-mode drawing does not re-fit the
   * geometry (only `fit` mode does). A box that sat near the old right edge
   * would otherwise end up outside the host — or under the side column.
   *
   * The correction is re-asserted for a moment rather than applied once: the
   * fit/placement machinery may re-centre the drawing a few frames later, and
   * that re-centre would otherwise undo it. Each step is a no-op once the box
   * is clear, so a settled page stops scrolling. `scrollLeft/scrollTop` pan the
   * drawing without changing its scale.
   */
  const revealSelectedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || selectedNodeId === null) {
      revealSelectedRef.current = null;
      return;
    }
    const revealSelected = (): void => {
      const selected = nodeElement(host, selectedNodeId);
      if (selected === null) return;
      const hostRect = host.getBoundingClientRect();
      const nodeRect = selected.getBoundingClientRect();
      // The uncovered part of the host: the overlay drawer's band is not
      // visible ground for the selection.
      const visibleBottom = hostRect.bottom - Math.min(bottomObscuredPx, hostRect.height);
      const margin = 8;
      let dx = 0;
      let dy = 0;
      if (nodeRect.left < hostRect.left + margin) {
        dx = nodeRect.left - hostRect.left - margin;
      } else if (nodeRect.right > hostRect.right - margin) {
        dx = nodeRect.right - hostRect.right + margin;
      }
      if (nodeRect.top < hostRect.top + margin) {
        dy = nodeRect.top - hostRect.top - margin;
      } else if (nodeRect.bottom > visibleBottom - margin) {
        dy = nodeRect.bottom - visibleBottom + margin;
      }
      if (dx !== 0) host.scrollLeft += dx;
      if (dy !== 0) host.scrollTop += dy;
    };
    revealSelectedRef.current = revealSelected;
    const frame = requestAnimationFrame(revealSelected);
    const timers = [250, 600, 1000].map((delay) => setTimeout(revealSelected, delay));
    return () => {
      revealSelectedRef.current = null;
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [bottomObscuredPx, selectedNodeId, drawnRevision]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const nodeFrom = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target.closest('[data-entity-id]') : null;

    const onMouseOver = (event: MouseEvent): void => {
      const node = nodeFrom(event.target);
      const id = node?.getAttribute('data-entity-id') ?? null;
      if (id === null) return;
      highlightRelations(host, id);
      // The contract's hovered node is the one the panel handed over. Group and
      // stub nodes are view scaffolding, not entities, so they have none and
      // report no hover (their highlight still works).
      const hoveredNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (hoveredNode !== undefined) {
        hoverCallbackRef.current?.({ node: hoveredNode, relations: relationsOf(host, id) });
      }
    };

    const onMouseOut = (event: MouseEvent): void => {
      const node = nodeFrom(event.target);
      if (node === null) return;
      const next = event.relatedTarget;
      if (next instanceof Node && node.contains(next)) return;
      // Hover is transient; a pinned selection is restored when the pointer leaves.
      highlightSelection(host, selectedRef.current);
      hoverCallbackRef.current?.(null);
    };

    // The pin/remove menu: right click on a fine pointer, a 500ms press on a
    // touch pointer. Coordinates are relative to the canvas's positioned
    // parent, which is where the menu element is rendered.
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelLongPress = (): void => {
      if (longPressTimer === null) return;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    };
    const openMenuAt = (clientX: number, clientY: number, target: EventTarget | null): boolean => {
      const canvas = host.parentElement;
      if (canvas === null) return false;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, clientX - rect.left);
      const y = Math.max(0, clientY - rect.top);
      const edgeHit = target instanceof Element
        ? target.closest('[data-architecture-edge-hit]')
        : null;
      if (edgeHit !== null) {
        const from = edgeHit.getAttribute('data-architecture-edge-source');
        const to = edgeHit.getAttribute('data-architecture-edge-target');
        const relationType = edgeHit.getAttribute('data-architecture-edge-type') ?? '';
        if (from === null || to === null) return false;
        setContextMenu({ x, y, edge: { from, to, relationType } });
        return true;
      }
      const id = nodeFrom(target)?.getAttribute('data-entity-id') ?? null;
      if (id === null || id.startsWith(GROUP_PREFIX) || id.startsWith(STUB_PREFIX)) return false;
      if (!graphRef.current.nodes.some((candidate) => candidate.id === id)) return false;
      setContextMenu({ x, y, nodeId: id });
      return true;
    };

    // Record how the press that produces the next click was made. Mouse clicks
    // keep the original single-click navigation; a touch tap only selects.
    //
    // A 500ms press on a real entity enters the touch multi-select mode (the
    // panel turns the mode on and adds that node); a press on a relation or the
    // blank canvas keeps opening the curation menu. `navigator.vibrate` is the
    // optional acknowledgement — guarded because jsdom and some browsers lack it.
    const onPointerDown = (event: PointerEvent): void => {
      lastPointerTypeRef.current = event.pointerType ?? null;
      cancelLongPress();
      if (event.pointerType !== 'touch') return;
      const target = event.target;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const id = nodeFrom(target)?.getAttribute('data-entity-id') ?? null;
        const node = id === null
          ? null
          : graphRef.current.nodes.find((candidate) => candidate.id === id) ?? null;
        if (
          node !== null
          && !id?.startsWith(GROUP_PREFIX)
          && !id?.startsWith(STUB_PREFIX)
          && multiSelectStartCallbackRef.current !== undefined
        ) {
          // The click the browser sends on release must not undo the toggle the
          // long press just performed.
          suppressClickRef.current = true;
          if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(10);
          }
          multiSelectStartCallbackRef.current(node);
          return;
        }
        if (canCurate) openMenuAt(event.clientX, event.clientY, target);
      }, 500);
    };
    const onPointerMove = (): void => cancelLongPress();
    const onPointerUp = (): void => cancelLongPress();
    const onContextMenu = (event: MouseEvent): void => {
      if (!canCurate) return;
      if (openMenuAt(event.clientX, event.clientY, event.target)) event.preventDefault();
      else setContextMenu(null);
    };

    /** Pin an entity's highlight and announce it to sibling panels. */
    const selectEntity = (id: string): void => {
      selectedRef.current = id;
      highlightRelations(host, id);
      const clickedNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (clickedNode === undefined) return;
      // The JSON lookup is what sibling panels receive, independent of the
      // hops the drill gesture expands.
      announceSelection(graphRef.current, id);
      clickCallbackRef.current?.(clickedNode);
    };

    const onClick = (event: MouseEvent): void => {
      const isTouchTap = lastPointerTypeRef.current === 'touch';
      lastPointerTypeRef.current = null;
      // A gesture already acted on release (long-press multi-select, marquee):
      // the browser's trailing click is not a second command.
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      // Additive = the platform's add-to-selection modifier, or any tap while
      // the touch multi-select mode is on.
      const additive = event.shiftKey || event.ctrlKey || event.metaKey || multiSelectModeRef.current;
      // Any ordinary click on the drawing closes the pin menu. A click on the
      // menu itself never reaches this listener (the menu is a sibling).
      setContextMenu(null);

      // At the package-only levels (`C`, and the folded `D` it deepens into)
      // the drawing is a map of frames, not selectable entities: a click on one
      // zooms into it — the "tap a package" gesture the too-small overview hint
      // offers, on every pointer tier. It runs before the background-clear
      // branch because a frame carries no `data-entity-id` of its own.
      if (semanticTierRef.current === 'C' || semanticTierRef.current === 'D') {
        const frame = event.target instanceof Element
          ? event.target.closest('.uml-package[data-package-id]')
          : null;
        const packageId = frame?.getAttribute('data-package-id') ?? null;
        if (packageId !== null) {
          zoomToPackage(packageId);
          return;
        }
      }

      // On a coarse pointer a node's visible shape is far smaller than a
      // finger: the drawing scales with the zoom, so even a fitted overview can
      // paint a file box ~10px tall. Resolve the tap against the 44px hit
      // rectangles instead, and let the NEAREST centre win when a dense
      // drawing's rectangles overlap (the topmost rectangle would otherwise
      // hand the tap to a neighbour). The package-only tiers draw no entities,
      // so they keep their frame-zoom path untouched.
      const packageOnly = semanticTierRef.current === 'C' || semanticTierRef.current === 'D';
      const coarseNodeId = coarsePointerRef.current && !packageOnly
        ? nearestNodeHitId(host, event.clientX, event.clientY)
        : null;

      // A relation's enlarged hit band sits ON TOP of the drawing, so it is
      // checked before the ordinary node lookup: clicking a line selects the
      // relation, not whatever box the line starts on. A coarse tap inside a
      // node's touch target is a node press (the finger aimed at the box, and
      // the band is wider than the visible line anyway).
      let id = coarseNodeId;
      if (id === null) {
        const edgeHit = event.target instanceof Element
          ? event.target.closest('[data-architecture-edge-hit]')
          : null;
        if (edgeHit !== null) {
          const from = edgeHit.getAttribute('data-architecture-edge-source');
          const to = edgeHit.getAttribute('data-architecture-edge-target');
          const relationType = edgeHit.getAttribute('data-architecture-edge-type') ?? '';
          if (from === null || to === null) return;
          const edge = { from, to, relationType };
          if (additive && toggleEdgeCallbackRef.current !== undefined) {
            toggleEdgeCallbackRef.current(edge);
            return;
          }
          selectedRelationRef.current = edge;
          selectedRef.current = null;
          setSelectedId(null);
          setSelectedByTouch(false);
          highlightEdge(host, edgeElement(host, from, to));
          edgeClickCallbackRef.current?.(edge);
          return;
        }
        id = nodeFrom(event.target)?.getAttribute('data-entity-id') ?? null;
      }
      if (id === null) {
        // Clicking the background is the "clear the pinned selection" gesture.
        selectedRef.current = null;
        setSelectedId(null);
        setSelectedByTouch(false);
        clearHighlight(host);
        hoverCallbackRef.current?.(null);
        selectionClearCallbackRef.current?.();
        return;
      }
      if (id.startsWith(STUB_PREFIX)) return;

      if (id.startsWith(GROUP_PREFIX)) {
        // A group is view scaffolding: selecting it marks the node but does not
        // announce an entity to sibling panels.
        selectedRef.current = id;
        highlightRelations(host, id);
      } else {
        const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
        if (node === undefined) return;
        // Additive clicks toggle the member without touching the drill machinery
        // (a multi-select gesture is not a request to open the neighbourhood).
        if (additive && toggleNodeCallbackRef.current !== undefined) {
          selectedRef.current = id;
          highlightRelations(host, id);
          announceSelection(graphRef.current, id);
          toggleNodeCallbackRef.current(node);
          return;
        }
        selectEntity(id);
      }
      setSelectedId(id);
      setSelectedByTouch(isTouchTap);

      if (!isTouchTap) {
        // Desktop: a single click only SELECTS and opens the inspector. Drilling
        // one hop deeper is the double-click gesture below.
        return;
      }
      // Touch: the first tap only selects — the drawing must not re-lay out
      // under the finger. A second tap on the same node inside the double-tap
      // window is the explicit drill command.
      const last = lastTapRef.current;
      lastTapRef.current = { id, at: event.timeStamp };
      if (last !== null && last.id === id && event.timeStamp - last.at <= DOUBLE_TAP_MS) {
        lastTapRef.current = null;
        drillInto(id);
      }
    };

    // Desktop drill-down: two clicks on the same node. The click handler above
    // has already selected it (and opened the inspector); this only navigates.
    const onDoubleClick = (event: MouseEvent): void => {
      const id = nodeFrom(event.target)?.getAttribute('data-entity-id') ?? null;
      if (id === null || id.startsWith(STUB_PREFIX)) return;
      drillInto(id);
    };

    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('mouseover', onMouseOver);
    host.addEventListener('mouseout', onMouseOut);
    host.addEventListener('click', onClick);
    host.addEventListener('dblclick', onDoubleClick);
    host.addEventListener('contextmenu', onContextMenu);
    return () => {
      cancelLongPress();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('mouseover', onMouseOver);
      host.removeEventListener('mouseout', onMouseOut);
      host.removeEventListener('click', onClick);
      host.removeEventListener('dblclick', onDoubleClick);
      host.removeEventListener('contextmenu', onContextMenu);
    };
  }, [canCurate, drillInto, zoomToPackage]);

  // The other direction of the cross-panel linkage: a sibling panel selects an
  // entity by its stable id (e.g. a file referenced in chat). The graph pins the
  // selection and drills into that entity's neighbourhood, all from the payload
  // already in hand — no request.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onExternalHighlight = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) return;
      selectedRef.current = id;
      setSelectedId(id);
      setSelectedByTouch(false);
      const host = hostRef.current;
      if (host !== null) highlightSelection(host, id);
      const current = viewRef.current;
      const hops = current.kind === 'neighborhood' && current.entityId === id
        ? current.hops + 1
        : DEFAULT_NEIGHBORHOOD_HOPS;
      setView({ kind: 'neighborhood', entityId: id, hops });
    };

    window.addEventListener(ENTITY_HIGHLIGHT_EVENT, onExternalHighlight);
    return () => window.removeEventListener(ENTITY_HIGHLIGHT_EVENT, onExternalHighlight);
  }, []);

  // The canvas is the wheel's ONLY consumer: a wheel turn zooms around the
  // pointer, whether or not Ctrl/Cmd is held (a trackpad pinch arrives as a
  // ctrlKey wheel, so that form keeps working unchanged). A wheel outside the
  // canvas — the toolbar, the chat behind it — never reaches this listener, so
  // scrolling the page elsewhere is untouched.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const onWheel = (event: WheelEvent): void => {
      const viewport = viewportRef.current;
      if (viewport === null) return;
      // The drawing never scrolls under the wheel any more; the zoom below is
      // the whole response, so the browser's own scroll/page zoom must not run.
      event.preventDefault();
      // deltaMode 1 is lines and 2 is pages; normalise so a mouse wheel and a
      // trackpad zoom at comparable rates.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.0015);
      applyZoom({
        scale: viewport.zoomBy(factor, { clientX: event.clientX, clientY: event.clientY }),
        fit: 'manual',
      });
    };

    // `passive: false` is needed because a passive wheel listener may not call
    // preventDefault — without it the browser's own page zoom would also fire.
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  // The auto-fit debounce: a canvas size change settles for 150ms before the
  // scale is re-solved. One timer per mount; the latest reading wins.
  const autoFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoFitTimerRef.current !== null) clearTimeout(autoFitTimerRef.current);
    autoFitTimerRef.current = null;
  }, []);
  const scheduleAutoFit = useCallback((): void => {
    if (zoomRef.current.fit !== 'auto') return;
    if (autoFitTimerRef.current !== null) clearTimeout(autoFitTimerRef.current);
    autoFitTimerRef.current = setTimeout(() => {
      autoFitTimerRef.current = null;
      // Read the state at FIRE time: an explicit zoom in the meantime cancels
      // the pending refit even if the timer already fired its scheduling.
      if (zoomRef.current.fit !== 'auto' || autoFitDisabled()) return;
      if (semanticCaptureRef.current !== null) {
        applySemanticRef.current?.({ fit: true, scale: zoomRef.current.scale });
        return;
      }
      const host = hostRef.current;
      const viewport = viewportRef.current;
      if (host === null || viewport === null) return;
      const drawing = host.querySelector('svg');
      const natural = naturalOfDrawing(drawing);
      const box = measureViewportSize(host);
      if (natural === null || box === null) return;
      const placement = fitPlacementFor(natural, box);
      const scale = viewport.zoomTo(placement.scale);
      applyPlacement(drawing, placement);
      applyZoom({ scale, fit: 'auto' });
    }, AUTO_FIT_DEBOUNCE_MS);
  }, [applyPlacement, applyZoom, fitPlacementFor, naturalOfDrawing]);

  // Every canvas size change — window resize, fullscreen, the inspector/drawer/
  // tray opening, a phone rotation, a re-layout — reaches this observer. Under
  // `auto` it re-solves the fit; under `manual` the reader's scale is kept and
  // only the selected box is panned back into view.
  //
  // The same observer notices a SHAPE change: a resize that only re-fits is
  // cheap, but one that turns the container landscape/portrait makes the
  // drawing's proportions wrong, which only a new layout fixes. That path is
  // behind `shouldRelayoutForAspect`'s threshold and its own debounce.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      const measured = measureLayoutAspect(host);
      if (shouldRelayoutForAspect(drawnAspectRef.current, measured, { locked: relayoutLockedRef.current }) && measured !== null) {
        scheduleAspectRelayout(measured);
      }
      revealSelectedRef.current?.();
      scheduleAutoFit();
    });
    observer.observe(host);
    // The corner chrome decides the CSS-scaled fit, and the minimap mounts a
    // beat after the drawing does (it needs the drawn node rectangles).
    // Observing the overlay column re-runs the fit once that chrome has a size.
    const overlays = host.parentElement?.querySelector<HTMLElement>('[data-architecture-canvas-overlays]');
    if (overlays !== undefined && overlays !== null) observer.observe(overlays);
    return () => observer.disconnect();
  }, [scheduleAspectRelayout, scheduleAutoFit]);

  // The zoom is read through `zoomRef` when the debounced application runs, so
  // a burst of wheel updates coalesces into one rewrite rather than walking
  // every intermediate level. Auto-fit re-solves are driven by the resize path
  // above; this effect only answers explicit (manual) scales.
  useEffect(() => {
    if (zoom.fit !== 'manual') return;
    const scheduler = lodSchedulerRef.current;
    if (scheduler === null) return;
    scheduler.request(() => applySemanticRef.current?.({ fit: false, scale: zoomRef.current.scale }));
  }, [zoom.fit, zoom.scale]);

  const zoomToScale = (scale: number): void => {
    if (semanticCaptureRef.current !== null) {
      const applied = clampZoomScale(scale);
      applyZoom({ scale: applied, fit: 'manual' });
      applySemanticRef.current?.({ fit: false, scale: applied });
      return;
    }
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.zoomTo(scale) ?? scale, fit: 'manual' });
  };

  const zoomByStep = (factor: number): void => {
    if (semanticCaptureRef.current !== null) {
      const applied = clampZoomScale(zoomRef.current.scale * factor);
      applyZoom({ scale: applied, fit: 'manual' });
      applySemanticRef.current?.({ fit: false, scale: applied });
      return;
    }
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.zoomBy(factor) ?? 1, fit: 'manual' });
  };

  /**
   * Fit: return to the sticky `auto` state and solve the largest scale whose
   * mapped content fits the canvas. A semantic drawing never takes a CSS factor
   * here — the solved scale is written into the geometry and shown 1:1.
   */
  const fitDiagram = (): void => {
    // A fit is the whole-graph reading: the package zoom the hint offered is
    // over, and its row must not keep asking the reader to go back.
    setPackageFocus(null);
    if (semanticCaptureRef.current !== null) {
      applyZoom({ scale: zoomRef.current.scale, fit: 'auto' });
      applySemanticRef.current?.({ fit: true, scale: zoomRef.current.scale });
      return;
    }
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) {
      applyZoom({ scale: 1, fit: 'auto' });
      return;
    }
    const drawing = host.querySelector('svg');
    const natural = naturalOfDrawing(drawing);
    const box = measureViewportSize(host);
    if (natural === null || box === null) {
      applyZoom({ scale: viewport.fitAll(), fit: 'auto' });
      return;
    }
    const placement = fitPlacementFor(natural, box);
    const scale = viewport.zoomTo(placement.scale);
    applyPlacement(drawing, placement);
    applyZoom({ scale, fit: 'auto' });
  };

  // The panel is told whether the drawing follows the container, because that
  // is the condition under which a fullscreen toggle may re-fit it: a scale the
  // reader chose must survive the overlay. The callback rides in a ref so a new
  // parent render identity never re-registers the effect.
  const onZoomModeChangeRef = useRef(onZoomModeChange);
  onZoomModeChangeRef.current = onZoomModeChange;
  useEffect(() => {
    onZoomModeChangeRef.current?.(zoom.fit === 'auto' ? 'fit' : 'custom');
  }, [zoom.fit]);

  // A fit request comes from the PANEL's own size change (the fullscreen
  // overlay swaps the region's `flex-1` for `fixed; inset: 0`). The renderer
  // answers each token once, and only while it is in Fit mode: the overlay must
  // not undo a manual zoom. The token is remembered synchronously so a re-render
  // carrying the same request cannot fit twice.
  const fitDiagramRef = useRef(fitDiagram);
  fitDiagramRef.current = fitDiagram;
  const answeredFitTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (fitRequest === null) return;
    if (answeredFitTokenRef.current === fitRequest.token) return;
    answeredFitTokenRef.current = fitRequest.token;
    if (zoomRef.current.fit !== 'auto') return;
    fitDiagramRef.current();
  }, [fitRequest]);

  /**
   * The node a cursor id names, when it names an entity that is in the payload.
   * Package frames and overview group nodes have no payload node.
   */
  const navigationNodeOf = (cursorId: string | null): ArchitectureRendererNode | null => {
    if (cursorId === null || cursorId.startsWith(PACKAGE_NAV_PREFIX)) return null;
    return graphRef.current.nodes.find((candidate) => candidate.id === cursorId) ?? null;
  };

  /** The spoken kind of an entity: the payload's kind, translated. */
  const navigationKindLabel = (node: ArchitectureRendererNode | null): string => {
    switch (node?.kind) {
      case 'class':
        return t('architecture.nav.kindClass', { defaultValue: 'class' });
      case 'interface':
        return t('architecture.nav.kindInterface', { defaultValue: 'interface' });
      case 'enum':
        return t('architecture.nav.kindEnum', { defaultValue: 'enum' });
      case 'abstract':
        return t('architecture.nav.kindAbstract', { defaultValue: 'abstract class' });
      case 'function':
        return t('architecture.nav.kindFunction', { defaultValue: 'function' });
      default:
        return t('architecture.nav.kindEntity', { defaultValue: 'entity' });
    }
  };

  /** The label a cursor id reads as: the payload label, the drawn label, or the id. */
  const navigationLabelOf = (host: HTMLElement, cursorId: string): string => {
    const node = navigationNodeOf(cursorId);
    if (node !== null) return node.label;
    const element = navigationElementOf(host, cursorId);
    const drawn = element?.querySelector('[data-architecture-label]')?.getAttribute('data-architecture-label');
    if (drawn !== undefined && drawn !== null && drawn !== '') return drawn;
    const text = element?.querySelector('text')?.textContent ?? '';
    return text === '' ? cursorId : text;
  };

  /**
   * The polite sentence for a cursor position: the entity's label, its kind,
   * the package it lives in and its drawn relations. A frame is read as a frame
   * with the count of entities inside it.
   */
  const navigationAnnouncementFor = (host: HTMLElement, cursorId: string): string => {
    if (cursorId.startsWith(PACKAGE_NAV_PREFIX)) {
      const packageId = cursorId.slice(PACKAGE_NAV_PREFIX.length);
      const prefix = `${packageId}/`;
      const count = collectNavigationItems(host)
        .filter((item) => item.kind === 'entity'
          && (item.packageId === packageId || item.packageId.startsWith(prefix)))
        .length;
      return t('architecture.nav.announcePackage', {
        defaultValue: 'Package {{package}}, {{count}} entities',
        package: packageId,
        count,
      });
    }
    const node = navigationNodeOf(cursorId);
    const element = navigationElementOf(host, cursorId);
    const packageId = (element === null ? null : normalizedPackageId(element.getAttribute('data-package-id')))
      ?? packageIdOfNodeId(cursorId);
    const selection = selectionOf(graphRef.current, cursorId);
    return t('architecture.nav.announceEntity', {
      defaultValue: '{{label}}, {{kind}}, package {{package}}, {{outgoing}} outgoing, {{incoming}} incoming',
      label: navigationLabelOf(host, cursorId),
      kind: navigationKindLabel(node),
      package: packageId === ''
        ? t('architecture.nav.rootPackage', { defaultValue: 'the root package' })
        : packageId,
      outgoing: selection.outgoing.length,
      incoming: selection.incoming.length,
    });
  };

  /** Write the cursor into both the refs the async redraw reads and the render state. */
  const applyNavigationCursor = (cursorId: string | null, announcement: string): void => {
    navigationCursorRef.current = cursorId;
    setNavigationCursorId(cursorId);
    setNavigationAnnouncement(announcement);
  };

  /** Repaint the ring and scroll the current box into the viewport. */
  const paintCurrentNavigationItem = (host: HTMLElement): void => {
    const cursorId = navigationCursorRef.current;
    paintNavigationFocus(host, cursorId);
    if (cursorId === null) return;
    const element = navigationElementOf(host, cursorId);
    if (element === null) return;
    centerElementInContainer(host, element);
  };

  /**
   * Enter the entity-navigation state on the current selection (or the first
   * drawn entity), paint its ring and announce it. False when the drawing has
   * nothing to stand on.
   */
  const enterEntityNavigation = (host: HTMLElement): boolean => {
    const items = collectNavigationItems(host);
    const preferred = selectedRef.current ?? keyboardFocusRef.current;
    const first = (preferred === null
      ? null
      : items.find((item) => item.kind === 'entity' && item.id === preferred))
      ?? items.filter((item) => item.kind === 'entity')
        .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id))[0];
    if (first === undefined) return false;
    navigationActiveRef.current = true;
    setNavigationActive(true);
    keyboardFocusRef.current = first.id;
    applyNavigationCursor(first.id, navigationAnnouncementFor(host, first.id));
    paintCurrentNavigationItem(host);
    return true;
  };

  /** Leave the navigation state; the selection and the drawing stay unchanged. */
  const exitEntityNavigation = (host: HTMLElement): void => {
    navigationActiveRef.current = false;
    navigationCursorRef.current = null;
    setNavigationActive(false);
    setNavigationCursorId(null);
    clearNavigationFocus(host);
  };

  /** Move the cursor one step and announce the landing (or "nothing there"). */
  const moveNavigationCursor = (host: HTMLElement, direction: EntityNavigationDirection): void => {
    const currentId = navigationCursorRef.current;
    const next = moveEntityFocus(collectNavigationItems(host), currentId, direction);
    if (next === null) return;
    if (next === currentId) {
      applyNavigationCursor(currentId, t('architecture.nav.noNeighbour', {
        defaultValue: 'No entity in that direction',
      }));
      return;
    }
    if (!next.startsWith(PACKAGE_NAV_PREFIX)) keyboardFocusRef.current = next;
    applyNavigationCursor(next, navigationAnnouncementFor(host, next));
    paintCurrentNavigationItem(host);
  };

  /**
   * Keyboard navigation once the canvas has focus: arrows pan, `+`/`-` zoom,
   * `0` fits and `1` returns to natural size.
   *
   * `Enter` enters the entity-navigation state on the current selection (or the
   * first drawn entity). In that state arrows move by screen position, Home/End
   * go to the top-left/bottom-right entity, PageUp/PageDown walk one package,
   * `[`/`]` walk to the enclosing frame and back to its first entity, `Enter`
   * selects (opening the inspector), `Shift+Enter`/Space toggles multi-select,
   * `A` pins and `X` removes through the same callbacks the context menu uses.
   * `Escape` leaves the state and calls `stopPropagation`, so the chat page's
   * global abort never sees it; outside the state Escape keeps its old
   * selection-clearing behaviour, and with no selection at all it is not
   * consumed.
   *
   * Modified presses are left to the browser and the app's shortcuts (Ctrl/Cmd
   * + key), except the curation undo.
   */
  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const host = hostRef.current;
    if (host === null) return;

    // Ctrl/Cmd+Z is the curation undo, but only while the canvas owns focus
    // (this is the canvas's own key handler).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && onUndo !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      onUndo();
      return;
    }
    if (event.ctrlKey || event.metaKey) return;

    if (event.key === 'Escape') {
      if (contextMenu !== null) {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu(null);
        return;
      }
      // In the entity-navigation state Escape leaves that state and nothing
      // else: `stopPropagation` keeps the chat page's global abort out of it.
      if (navigationActiveRef.current) {
        event.preventDefault();
        event.stopPropagation();
        exitEntityNavigation(host);
        return;
      }
      if (selectedRef.current === null && selectedRelationRef.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      escapeSelectionCallbackRef.current?.();
      return;
    }

    // Delete/Backspace removes the selected entity (or hides the selected
    // relation) through the panel's curation store. `stopPropagation` keeps the
    // key away from the chat page's global abort — the drawing owns it only
    // while a selection exists AND a curation callback can act on it.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const edge = selectedRelationRef.current ?? null;
      const nodeId = selectedRef.current;
      if (edge === null && nodeId === null) return;
      if (edge !== null) {
        if (onHideRelation === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onHideRelation({ from: edge.from, to: edge.to, relationType: edge.relationType });
        return;
      }
      if (onRemoveNode === undefined || nodeId === null) return;
      const node = graphRef.current.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      onRemoveNode(node);
      return;
    }

    /** The entity the cursor stands on, or null on a frame / nowhere. */
    const cursorNode = (): ArchitectureRendererNode | null => navigationNodeOf(navigationCursorRef.current);

    /** Enter's selection: an entity opens the inspector, a frame zooms into it. */
    const selectCursorItem = (): boolean => {
      const cursorId = navigationCursorRef.current;
      if (cursorId === null) return false;
      if (cursorId.startsWith(PACKAGE_NAV_PREFIX)) {
        // A frame is a place, not an entity: the same gesture a tap gives it.
        zoomToPackage(cursorId.slice(PACKAGE_NAV_PREFIX.length));
        setNavigationAnnouncement(t('architecture.nav.enteredPackage', {
          defaultValue: 'Entered package {{package}}',
          package: cursorId.slice(PACKAGE_NAV_PREFIX.length),
        }));
        return true;
      }
      const node = cursorNode();
      if (node === null) return false;
      selectedRef.current = cursorId;
      highlightRelations(host, cursorId);
      announceSelection(graphRef.current, cursorId);
      clickCallbackRef.current?.(node);
      setNavigationAnnouncement(t('architecture.nav.selected', {
        defaultValue: '{{label}} selected',
        label: navigationLabelOf(host, cursorId),
      }));
      return true;
    };

    /** Shift+Enter / Space: toggle the cursor's entity in the multi-select set. */
    const toggleCursorSelection = (): boolean => {
      const node = cursorNode();
      const cursorId = navigationCursorRef.current;
      if (node === null || cursorId === null) return false;
      const wasSelected = selectedNodeIdsRef.current.includes(cursorId) || selectedRef.current === cursorId;
      selectedRef.current = cursorId;
      highlightRelations(host, cursorId);
      announceSelection(graphRef.current, cursorId);
      if (toggleNodeCallbackRef.current !== undefined) toggleNodeCallbackRef.current(node);
      else clickCallbackRef.current?.(node);
      setNavigationAnnouncement(wasSelected
        ? t('architecture.nav.deselected', {
            defaultValue: '{{label}} removed from the selection',
            label: node.label,
          })
        : t('architecture.nav.selectedIntoSet', {
            defaultValue: '{{label}} added to the selection',
            label: node.label,
          }));
      return true;
    };

    if (navigationActiveRef.current) {
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'up');
          return;
        case 'ArrowDown':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'down');
          return;
        case 'ArrowLeft':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'left');
          return;
        case 'ArrowRight':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'right');
          return;
        case 'Home':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'home');
          return;
        case 'End':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'end');
          return;
        case 'PageUp':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'pageUp');
          return;
        case 'PageDown':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'pageDown');
          return;
        case '[':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'parent');
          return;
        case ']':
          event.preventDefault();
          event.stopPropagation();
          moveNavigationCursor(host, 'child');
          return;
        case 'Enter':
          if (event.shiftKey) {
            if (!toggleCursorSelection()) return;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.altKey) {
            const drillId = navigationCursorRef.current;
            if (drillId === null || drillId.startsWith(PACKAGE_NAV_PREFIX)) return;
            event.preventDefault();
            drillInto(drillId);
            return;
          }
          if (!selectCursorItem()) return;
          event.preventDefault();
          event.stopPropagation();
          return;
        case ' ':
        case 'Spacebar':
          if (!toggleCursorSelection()) return;
          event.preventDefault();
          event.stopPropagation();
          return;
        case 'a':
        case 'A': {
          const node = cursorNode();
          if (node === null) return;
          const action = pinnedSet.has(node.id) ? onUnpinNode : onPinNode;
          if (action === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          action(node);
          return;
        }
        case 'x':
        case 'X': {
          const node = cursorNode();
          if (node === null || onRemoveNode === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          onRemoveNode(node);
          return;
        }
        default:
          // `+`/`-`/`0`/`1` keep working below; everything else is default.
          break;
      }
    } else {
      // Enter enters the navigation state on the current selection or the first
      // drawn entity. Arrows keep panning until then (requirement 4).
      if (event.key === 'Enter') {
        if (enterEntityNavigation(host)) event.preventDefault();
        return;
      }
      if (event.key === '[' || event.key === ']') {
        if (!enterEntityNavigation(host)) return;
        event.preventDefault();
        moveNavigationCursor(host, event.key === '[' ? 'parent' : 'child');
        return;
      }
    }

    if (event.altKey) return;
    switch (event.key) {
      case 'ArrowLeft':
        if (navigationActiveRef.current) return;
        host.scrollLeft -= KEYBOARD_PAN_STEP;
        break;
      case 'ArrowRight':
        if (navigationActiveRef.current) return;
        host.scrollLeft += KEYBOARD_PAN_STEP;
        break;
      case 'ArrowUp':
        if (navigationActiveRef.current) return;
        host.scrollTop -= KEYBOARD_PAN_STEP;
        break;
      case 'ArrowDown':
        if (navigationActiveRef.current) return;
        host.scrollTop += KEYBOARD_PAN_STEP;
        break;
      case '+':
      case '=':
        zoomByStep(ZOOM_STEP);
        break;
      case '-':
      case '_':
        zoomByStep(1 / ZOOM_STEP);
        break;
      case '0':
        fitDiagram();
        break;
      case '1':
        zoomToScale(1);
        break;
      default:
        // Anything else keeps its default behaviour.
        return;
    }
    event.preventDefault();
  };

  // The keyboard cursor lives in the DOM (a class, an element id and a drawn
  // ring), so a drawing that was replaced — a new view, or a semantic rewrite —
  // loses it. Repaint it from the settled state; the cursor's own moves paint
  // synchronously in the key handler, and this is the restoring half.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (!navigationActive) {
      clearNavigationFocus(host);
      return;
    }
    paintCurrentNavigationItem(host);
  }, [drawn, drawnRevision, navigationActive, navigationCursorId]);

  const viewLabel = view.kind === 'overview'
    ? t('architecture.plantuml.overview', { defaultValue: 'Overview' })
    : view.kind === 'group'
      ? t('architecture.plantuml.group', { defaultValue: 'Group: {{group}}', group: view.prefix })
      : view.kind === 'hierarchy'
        ? t('architecture.plantuml.explosion', { defaultValue: 'Explosion view' })
        : t('architecture.plantuml.neighborhood', {
            defaultValue: '{{entity}} · {{hops}} hop(s)',
            entity: view.entityId,
            hops: view.hops,
          });
  /**
   * What the reader is looking at while a neighbourhood is open, said in the
   * toolbar on BOTH tiers.
   *
   * Double-clicking an entity replaces the drawing with a smaller one and used
   * to state nothing: the only new chrome was "Back to Class diagram" and
   * "Explosion view", which name where the reader could go, never where they
   * were. The status names the entity — and the entity is named the way the
   * panel names it everywhere else: the payload's own label, falling back to
   * the id's last segment so an opaque scope prefix never reaches a reader.
   */
  const neighbourhoodStatus = (() => {
    if (view.kind !== 'neighborhood') return null;
    const node = graph.nodes.find((candidate) => candidate.id === view.entityId);
    const label = node === undefined ? '' : node.label.trim();
    const name = label !== '' && label !== view.entityId
      ? label
      : view.entityId.slice(view.entityId.lastIndexOf('.') + 1);
    return t('architecture.plantuml.neighbourhoodStatus', {
      defaultValue: 'Neighbourhood of {{entity}} · {{hops}} hop(s)',
      entity: name,
      hops: view.hops,
    });
  })();

  // The explicit drill command is offered only for a touch selection that has
  // not already opened its own view: a desktop click navigated on its own, and
  // a selection whose neighbourhood is on screen has nothing left to drill.
  const selectedPrefix = selectedId !== null && selectedId.startsWith(GROUP_PREFIX)
    ? selectedId.slice(GROUP_PREFIX.length)
    : null;
  const selectionAlreadyOpen = selectedId === null
    || (selectedPrefix !== null
      ? view.kind === 'group' && view.prefix === selectedPrefix
      : view.kind === 'neighborhood' && view.entityId === selectedId);
  const canDrill = selectedByTouch && selectedId !== null && !selectionAlreadyOpen;

  const zoomGroupLabel = t('architecture.plantuml.zoomGroup', { defaultValue: 'Diagram zoom' });
  /**
   * The percentage every surface states. For a semantic drawing this is the
   * engine's own scale `s` — the ONE proportion, baked into the geometry and
   * shown 1:1 — so it equals the SVG's `data-architecture-semantic-scale`.
   * For a grouped directory map it is the CSS scale the viewport applied.
   */
  const displayScale = zoom.scale;

  /** The collapsed-to-overview notice: the only reading banner the canvas keeps. */
  const readableNotice = collapsedNotice ? (
    <span data-architecture-readable-collapsed="true" className="text-amber-600 dark:text-amber-400">
      {t('architecture.plantuml.readable.collapsed', {
        defaultValue: 'The graph is too wide, so it was collapsed to the directory overview.',
      })}
    </span>
  ) : null;

  /**
   * Where the ONE scale reading is drawn.
   *
   * The desktop tier draws the in-flow row above the canvas, so the reading
   * belongs there beside the zoom tier. The compact tier has no visible
   * in-flow row (the tier is portaled into the Adjust sheet, which is shut by
   * default), so the reading rides in the on-canvas zoom cluster instead —
   * always drawn, always exactly once. Rendering it in both places is the
   * defect the task removed: two percentages for one drawing.
   */
  const readoutInCluster = compactToolbar;
  /** The DEV control arm's second reading; `null` in the shipped build. */
  const duplicateReadout = overlayLayoutDefect() === 'duplicate-readout';

  /** The single place the actual scale is stated, so fit (e.g. 42%) and 100% are distinguishable. */
  const zoomReadout = (
    <span
      data-architecture-zoom-level
      // The zoom readout carries the same orientation reading as the layout
      // row: the scale on screen and the direction that produced it are one
      // statement about the drawing.
      data-architecture-layout-direction={layoutDirection ?? undefined}
      data-architecture-layout-direction-reason={layoutDirectionReason ?? undefined}
      className="min-w-9 text-center tabular-nums"
    >
      {Math.round(displayScale * 100)}%
    </span>
  );

  // The default drawing of this graph (see `defaultViewOf`): the class view's
  // hierarchy, or the file overview. "Back" returns HERE, so the entity graph
  // goes back to the full class drawing rather than to a document it never
  // renders.
  const defaultView = defaultViewOf(idShape);
  // The breadcrumb is offered ONLY from a real drill-down (a neighbourhood or
  // an expanded group). It used to follow `!atDefaultView`, which also counted
  // the explosion view — so "Back to overview" appeared when nothing had been
  // drilled at all.
  const inDrillView = view.kind === 'neighborhood' || view.kind === 'group';
  const backTargetLabel = isEntityGraph(idShape)
    ? t('architecture.plantuml.classDiagram', { defaultValue: 'Class diagram' })
    : t('architecture.plantuml.overview', { defaultValue: 'Overview' });
  const backButton = inDrillView
    ? (
      <button
        type="button"
        onClick={() => setView(defaultView)}
        data-architecture-back="true"
        style={touchTargetStyle}
        className={`${TOOLBAR_BUTTON_CLASS} text-left`}
      >
        {t('architecture.plantuml.backTo', {
          defaultValue: 'Back to {{view}}',
          view: backTargetLabel,
        })}
      </button>
    )
    : null;

  // The explosion view draws the whole graph as one nested hierarchy; zooming it
  // then switches visibility levels instead of re-laying it.
  const explosionButton = view.kind === 'hierarchy'
    ? null
    : (
      <button
        type="button"
        onClick={() => {
          // Asking for the explosion view again re-evaluates the aspect guard;
          // the notice returns only if the canvas is still a band.
          setCollapsedNotice(false);
          setView({ kind: 'hierarchy' });
        }}
        data-architecture-explosion="true"
        // The label alone never said what the view is; the tooltip does, in the
        // same words a hover anywhere else on this canvas would use.
        title={t('architecture.plantuml.explosionHint', {
          defaultValue: 'Draw every entity as its own box, the whole graph at once',
        })}
        style={touchTargetStyle}
        className={`${TOOLBAR_BUTTON_CLASS} text-left`}
      >
        {t('architecture.plantuml.explosion', { defaultValue: 'Explosion view' })}
      </button>
    );

  // The zoom controls live in the on-canvas cluster (bottom right of the
  // drawing), not in the toolbar: they act on the drawing, so they belong on
  // it. 32px targets on a fine pointer, 44px on a coarse one.
  const clusterTargetStyle = touchUi ? TOUCH_TARGET_STYLE : ZOOM_CLUSTER_TARGET_STYLE;
  /** The corner slot's direction and insets: the same model the pill's slot uses. */
  const cornerLayout = bottomCornerLayout({ touchUi, shortTouch });
  /**
   * The bottom band the portrait phone keeps clear for its corner controls.
   * Zero on every other tier (and for the DEV arm that restores the pre-task
   * floating controls), so the existing fit is unchanged there.
   */
  const portraitControlBandPx = portraitPhone && !portraitControlsOverlay && !shortTouch
    ? PORTRAIT_CONTROL_BAND_PX
    : 0;
  /** The portrait cluster's shipped form is the one 44px button. */
  const portraitClusterCollapsed = portraitPhone && !clusterExpanded && !portraitControlsOverlay;

  /**
   * The canvas pill. It has two reasons to exist, and neither is a Focus notice:
   *  · the folded tier always states what the reader is looking at — a map of
   *    collapsed package tabs — because the drawing no longer shows entities;
   *  · after the reader taps a package the row carries the "back to the whole
   *    graph" action.
   *
   * The retired "whole graph at N % — tap a package" hint is gone with Focus:
   * `auto` fit always shows the whole graph on purpose, so a sentence telling
   * the reader it is too small had no action to offer that the palette did not.
   */
  const foldedDepth = foldDepth;
  const showOverviewHint = foldedDepth !== null || packageFocus !== null;
  const overviewHintText = foldedDepth !== null
    ? t('architecture.plantuml.readable.folded', {
        defaultValue: 'Collapsed to {{depth}} levels — tap a package to zoom in',
        depth: foldedDepth,
      })
    : null;
  // The pill may only cover the drawing where no package tab is painted. It is
  // measured after every commit that can move either side (the drawing was
  // rewritten, the pill's wording changed, or a package zoom re-scrolled).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !showOverviewHint) return;
    positionOverviewHint(host);
  }, [showOverviewHint, drawnRevision, zoom.scale, packageFocus, foldedDepth]);

  const zoomOutButton = (
    <button
      type="button"
      onClick={() => zoomByStep(1 / ZOOM_STEP)}
      aria-label={t('architecture.plantuml.zoomOut', { defaultValue: 'Zoom out' })}
      data-architecture-zoom-out="true"
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      −
    </button>
  );

  const zoomInButton = (
    <button
      type="button"
      onClick={() => zoomByStep(ZOOM_STEP)}
      aria-label={t('architecture.plantuml.zoomIn', { defaultValue: 'Zoom in' })}
      data-architecture-zoom-in="true"
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      +
    </button>
  );

  const fitButton = (
    <button
      type="button"
      onClick={fitDiagram}
      aria-pressed={zoom.fit === 'auto'}
      data-architecture-zoom-fit="true"
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      {t('architecture.plantuml.zoomFit', { defaultValue: 'Fit to view' })}
    </button>
  );

  const drillButton = canDrill
    ? (
      <button
        type="button"
        onClick={drillSelected}
        data-architecture-drill-in="true"
        style={touchTargetStyle}
        className={TOOLBAR_BUTTON_CLASS}
      >
        {t('architecture.plantuml.drillIn', { defaultValue: 'Drill in' })}
      </button>
    )
    : null;

  // The single zoom-tier group: ONE scale reading plus the breadcrumb/drill
  // actions. The Focus | Overview switch that used to sit here is retired with
  // the focus policy itself.
  const zoomTierGroup = (
    <div
      data-architecture-zoom-tier="true"
      role="group"
      aria-label={t('architecture.plantuml.zoomTier', { defaultValue: 'Zoom level' })}
      style={{ gap: touchUi ? TOUCH_CONTROL_GAP_PX : 4 }}
      className="pointer-events-auto flex max-w-full flex-wrap items-center rounded-lg border border-border/60 bg-background/90 p-1 text-[11px] text-muted-foreground shadow-sm"
    >
      {!readoutInCluster && zoomReadout}
      {neighbourhoodStatus !== null && (
        <span
          data-architecture-neighbourhood-status="true"
          className="min-w-0 max-w-full truncate"
        >
          {neighbourhoodStatus}
        </span>
      )}
      {backButton}
      {explosionButton}
      {drillButton}
    </div>
  );

  const exportButton = onExport === undefined
    ? null
    : (
      <button
        type="button"
        // The panel owns the menu this button is drawn into, so closing it is
        // the panel's job too (its `onExport` closes the menu after writing).
        onClick={() => onExport()}
        data-architecture-overflow-export="true"
        style={touchTargetStyle}
        className={`${TOOLBAR_BUTTON_CLASS} text-left`}
      >
        {t('architecture.exportMmd', { defaultValue: 'Export .mmd' })}
      </button>
    );

  // When the panel has a detail knob above this renderer it hands over the two
  // numbers the reader asked about (retained vs. in-scope). Without one — this
  // component rendered directly — the summary stays the local drawn/total
  // reading it always was.
  const visibleSummary = detailReading === undefined ? (
    t('architecture.visibleNodes', {
      defaultValue: '{{visible}} of {{total}} nodes',
      visible: drawn?.view === view ? drawn.nodes : 0,
      total: graph.nodes.length,
    })
  ) : (
    t('architecture.controls.detailReading', {
      defaultValue: 'Showing {{shown}} of {{total}} related nodes',
      shown: detailReading.shown,
      total: detailReading.totalInScope,
    })
  );

  // The row above the canvas: the zoom tier and the scale it is at. The panel
  // owns the row itself (the one-line readout sits on its left) and hands this
  // renderer the right-hand cell; standalone, the renderer draws the row.
  const headerControls = (
    <span
      data-architecture-graph-header-controls="true"
      // Desktop pins the tier to the header's right edge; the compact tier's
      // Adjust sheet stacks its sections, so the same row is left-aligned
      // there (right-aligned, it left a strip of empty space down the left).
      className={`flex min-w-0 max-w-full flex-wrap items-center gap-1 ${
        compactToolbar ? 'w-full justify-start' : 'justify-end'
      }`}
    >
      {zoomTierGroup}
    </span>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-architecture-plantuml-graph="true"
      data-architecture-view={view.kind}
      data-architecture-hops={view.kind === 'neighborhood' ? view.hops : undefined}
      data-architecture-visible-nodes={drawn?.view === view ? drawn.nodes : 0}
      data-architecture-visible-edges={drawn?.view === view ? drawn.edges : 0}
      // `fit`/`custom` keeps the panel's existing vocabulary: `auto` is the
      // sticky fit that follows the canvas, `manual` is a scale the reader set.
      data-architecture-zoom-mode={zoom.fit === 'auto' ? 'fit' : 'custom'}
      data-architecture-fit={zoom.fit}
      // The ONE proportion on screen. For a semantic drawing it equals the
      // SVG's own `data-architecture-semantic-scale`; there is no CSS factor.
      data-architecture-zoom-scale={displayScale}
      data-architecture-semantic-scale={semanticCaptureRef.current !== null ? displayScale : undefined}
      data-architecture-fold-depth={foldDepth ?? undefined}
      data-architecture-lod-depth={lodDepth ?? undefined}
      data-architecture-layout-ms={layoutMs ?? undefined}
      // The layout readout's direction and reason: WHICH orientation the
      // drawing was laid out in, and why the policy chose it.
      data-architecture-layout-direction={layoutDirection ?? undefined}
      data-architecture-layout-direction-reason={layoutDirectionReason ?? undefined}
    >
      <style>{HIGHLIGHT_STYLE}</style>
      <style data-architecture-diff-highlight-style="true">{DIFF_HIGHLIGHT_STYLE}</style>
      <style data-architecture-canvas-selection-style="true">{CANVAS_UNSELECTABLE_STYLE}</style>
      {/* The renderer's own legend is NOT part of the semantic rewrite, so its
          fixed 10px text would be the one label below the phone floor. The
          floor is stated here, in screen pixels, because k = 1. */}
      <style data-architecture-legend-floor="true">
        {`[data-architecture-plantuml] svg .uml-legend text { font-size: ${touchUi ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX}px; }`}
      </style>
      {canvasHeaderSlot !== null ? (
        createPortal(headerControls, canvasHeaderSlot)
      ) : compactToolbar ? null : (
        // The compact tier has no in-flow chrome row: when the panel has not
        // mounted a slot (the bottom sheet is shut), drawing one would put a
        // second row back between the header and the drawing.
        <div
          data-architecture-graph-header="true"
          className="flex shrink-0 flex-wrap items-center justify-end gap-1 px-1 pb-1"
        >
          {headerControls}
        </div>
      )}
      {compactToolbar ? (
        // On the compact tier the panel already spends the one row it has on
        // the title, granularity and "…"; the rest of this renderer's controls
        // (view label, export, visible summary) are drawn inside that menu at
        // the same 44px targets. The zoom tier is NOT here: it lives in the
        // in-flow row above the canvas on every tier, so no popover floats it
        // over the drawing.
        compactToolbarSlot !== null && createPortal(
          <span data-architecture-compact-controls="true" className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span data-architecture-view-label>{viewLabel}</span>
            </span>
            {exportButton}
            <span
              data-architecture-visible-summary
              data-architecture-detail-shown={detailReading?.shown}
              data-architecture-detail-total={detailReading?.totalInScope}
            >
              {visibleSummary}
            </span>
          </span>,
          compactToolbarSlot,
        )
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col" data-architecture-canvas="true">
        <div
          ref={hostRef}
          // The canvas is an image until the reader enters entity navigation;
          // then it is an application whose active descendant is the entity the
          // keyboard cursor stands on (the ring is drawn inside the drawing).
          role={navigationActive ? 'application' : 'img'}
          aria-label={t('architecture.graphAria', { defaultValue: 'Architecture neighbourhood graph' })}
          aria-activedescendant={
            navigationActive && navigationCursorId !== null
              ? navigationDomId(navigationCursorId)
              : undefined
          }
          // The canvas is its own keyboard target: arrows pan, +/- zoom, 0 fits
          // and 1 is natural size (see `onCanvasKeyDown`). The ring is only drawn
          // for keyboard focus, so a mouse press does not flash a box.
          tabIndex={0}
          // The phone tier spends only 4px a side on padding: the task wants
          // the fitted drawing at ≥95% of the canvas width, and a 12px inset
          // already costs 6.5% of a 366px canvas. The fine-pointer tier keeps
          // the roomier p-3.
          className={`h-full w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 ${touchUi ? 'p-1' : 'p-3'}`}
          // The gestures own every touch on the drawing: without this the browser
          // would pan/zoom the page and the pinch would never reach the controller.
          // The flex column is the vertical-centring mechanism: the injected SVG
          // gets `margin-block: auto` (set where it is inserted), so a drawing
          // shorter than the canvas sits in the middle instead of hugging the top.
          // The selection declarations are stated inline as well as in the
          // injected rule above: this host is where a drag starts, and
          // `markDrawingUnselectable` repeats them on the drawing itself.
          style={{
            touchAction: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            // The coarse drawer overlays the canvas' bottom band. Reserving it
            // as padding makes the flex centring use the area ABOVE the drawer,
            // so a fitted drawing is never half-hidden behind it. The portrait
            // phone reserves its collapsible zoom controls' band in the SAME
            // bottom region: the controls float over the canvas, so the drawing
            // is fitted ABOVE them instead of under them. The two bands are
            // measured from the same bottom edge, so they compose as a maximum
            // rather than a sum — an open drawer already covers the controls'
            // footprint, and reserving both would lift the drawing 80px higher
            // than either surface needs. Padding (not a chrome row) is
            // deliberate — `clientHeight` still counts it, so the canvas-share
            // reading loses nothing.
            ...(bottomObscuredPx + portraitControlBandPx > 0
              ? {
                paddingBottom: `${(touchUi ? 4 : 12)
                  + Math.max(bottomObscuredPx, portraitControlBandPx)}px`,
              }
              : {}),
            // The overlay's chrome (toolbar + readout rows) is drawn OVER the
            // viewport-sized canvas. Reserving it as padding makes the flex
            // centring — and `measureViewportSize`'s fit box — use the area
            // BELOW the chrome, so a fitted drawing is never tucked behind it.
            ...(topObscuredPx > 0
              ? { paddingTop: `${(touchUi ? 4 : 12) + topObscuredPx}px` }
              : {}),
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
          onKeyDown={onCanvasKeyDown}
          data-testid="plantuml-host"
          data-architecture-plantuml="true"
        />
        {/* The keyboard cursor's polite reading: the entity it stands on (label,
            kind, package, in/out counts) and the last selection action. Sibling
            of the host so the drawing's imperative innerHTML never wipes it. */}
        <span
          role="status"
          aria-live="polite"
          data-architecture-nav-announcer="true"
          className="sr-only"
        >
          {navigationAnnouncement}
        </span>
        {layoutStatusNodes !== null && (
          // An overlay, deliberately: a status drawn in flow would change the
          // canvas' height, and therefore the very fit the drawing after it is
          // laid out for. It sits above the drawing the reader is still looking
          // at, not in place of it — the host keeps the previous SVG until the
          // new one is ready.
          <div
            data-architecture-layout-status={layoutStatusNodes}
            role="status"
            aria-live="polite"
            style={{ position: 'absolute', zIndex: 26, left: 12, top: 12, maxWidth: '78%' }}
            className="pointer-events-none flex items-center gap-2 rounded-md border border-border/60 bg-background/95 px-2 py-1 text-[11px] font-medium text-foreground shadow-sm"
          >
            <span aria-hidden="true" className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
            <span className="min-w-0 truncate">
              {t('architecture.plantuml.layoutProgress', {
                defaultValue: 'Laying out {{count}} entities…',
                count: layoutStatusNodes,
              })}
            </span>
          </div>
        )}
        {/* The Focus / collapsed explanation, drawn as an OVERLAY: it must not
            take a row from the toolbar (that moved the canvas' top edge every
            time Focus was pressed) and it must be readable in full, so it
            wraps inside a bounded width instead of truncating. */}
        {readableNotice !== null && (
          <div
            data-architecture-readable-notice="true"
            role="status"
            style={{ position: 'absolute', zIndex: 24, left: 8, top: 8, maxWidth: 'min(78%, 520px)' }}
            className="pointer-events-none rounded-md border border-border/60 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm"
          >
            {readableNotice}
          </div>
        )}
        {showOverviewHint && (
          <div
            data-architecture-readable-hint="true"
            role="status"
            // An overlay pill, not a row: it must never take height from the
            // drawing (which would move the very fit it is talking about). Its
            // left/top are written by `positionOverviewHint` after the drawing
            // is laid out, so it never covers a package tab; leaving them out of
            // the style object keeps React from resetting the placement on a
            // later render.
            style={{ position: 'absolute', zIndex: 25, maxWidth: '78%' }}
            className="pointer-events-auto flex items-center gap-2 rounded-md border border-border/60 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm"
          >
            <span className="min-w-0 truncate">{overviewHintText}</span>
            {packageFocus !== null && (
              <button
                type="button"
                data-architecture-readable-back="true"
                onClick={fitDiagram}
                style={clusterTargetStyle}
                className={TOOLBAR_BUTTON_CLASS}
              >
                {t('architecture.plantuml.readable.backToWhole', {
                  defaultValue: 'Back to whole graph',
                })}
              </button>
            )}
          </div>
        )}
        {marquee !== null && (
          <div
            data-architecture-marquee="true"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
              zIndex: 35,
              pointerEvents: 'none',
              border: '1px dashed #1d4ed8',
              background: 'rgba(29, 78, 216, 0.08)',
            }}
          />
        )}
        {contextMenu !== null && (() => {
          const menuNode = 'nodeId' in contextMenu
            ? graph.nodes.find((candidate) => candidate.id === contextMenu.nodeId) ?? null
            : null;
          const menuEdge = 'edge' in contextMenu ? contextMenu.edge : null;
          const isPinned = menuNode !== null && pinnedSet.has(menuNode.id);
          if (menuNode === null && menuEdge === null) return null;
          return (
            <div
              data-architecture-context-menu="true"
              role="menu"
              aria-label={t('architecture.curation.heading', { defaultValue: 'Adjust' })}
              style={{ position: 'absolute', left: contextMenu.x, top: contextMenu.y, zIndex: 40 }}
              className="flex min-w-40 flex-col rounded-lg border border-border bg-popover p-1 shadow-lg"
            >
              {menuNode !== null && (
                <>
                  {isPinned ? (
                    <button
                      type="button"
                      role="menuitem"
                      data-architecture-context-unpin={menuNode.id}
                      onClick={() => {
                        setContextMenu(null);
                        onUnpinNode?.(menuNode);
                      }}
                      className="rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {t('architecture.curation.unpin', { defaultValue: 'Unpin' })}
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      data-architecture-context-pin={menuNode.id}
                      onClick={() => {
                        setContextMenu(null);
                        onPinNode?.(menuNode);
                      }}
                      className="rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {t('architecture.curation.pin', { defaultValue: 'Pin to graph' })}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    data-architecture-context-remove={menuNode.id}
                    onClick={() => {
                      setContextMenu(null);
                      onRemoveNode?.(menuNode);
                    }}
                    className="rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {t('architecture.curation.removeEntity', { defaultValue: 'Remove from graph' })}
                  </button>
                  {onPutNodeInChat !== undefined && (
                    <button
                      type="button"
                      role="menuitem"
                      data-architecture-context-put-in-chat={menuNode.id}
                      onClick={() => {
                        setContextMenu(null);
                        onPutNodeInChat(menuNode);
                      }}
                      className="rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {t('architecture.curation.putInChat', { defaultValue: 'Put in chat input' })}
                    </button>
                  )}
                  {isPinned && onSoloNode !== undefined && (
                    <button
                      type="button"
                      role="menuitem"
                      data-architecture-context-solo={menuNode.id}
                      onClick={() => {
                        setContextMenu(null);
                        onSoloNode(menuNode);
                      }}
                      className="rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {t('architecture.curation.solo', { defaultValue: 'Show only this' })}
                    </button>
                  )}
                </>
              )}
              {menuEdge !== null && (
                <button
                  type="button"
                  role="menuitem"
                  data-architecture-context-hide={menuEdge.from}
                  onClick={() => {
                    setContextMenu(null);
                    onHideRelation?.(menuEdge);
                  }}
                  className="rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {t('architecture.curation.hideRelation', { defaultValue: 'Hide relation' })}
                </button>
              )}
            </div>
          );
        })()}
        <div
          data-architecture-canvas-overlays="true"
          data-architecture-bottom-corner={cornerLayout.direction}
          // The arrangement is stated inline rather than in utility classes:
          // "one absolute slot, positive gap, map before cluster" is what
          // makes the two boxes unable to intersect, and a test can read it
          // without a laid-out browser (the same reason the zoom targets carry
          // inline sizes). The inset/direction come from the shared
          // `bottomCornerLayout` the selection pill's slot is measured against.
          style={{
            position: 'absolute',
            bottom: cornerLayout.inset,
            right: cornerLayout.inset,
            display: 'flex',
            // A phone spends one ROW on the corner chrome: the collapsed
            // minimap button and the zoom cluster sit side by side, bottom
            // aligned, so the pair takes ~52px of height instead of a 204px
            // column covering the drawing's right edge. The fine-pointer tier
            // keeps its stacked column.
            flexDirection: cornerLayout.direction,
            alignItems: 'flex-end',
            rowGap: BOTTOM_SLOT_GAP_PX,
            columnGap: cornerLayout.direction === 'row' ? cornerLayout.gap : 0,
          }}
          className="z-20 pointer-events-none"
        >
          <ArchitectureMinimap
            hostRef={hostRef}
            // A new drawing, and every semantic rewrite, is a new set of node
            // rectangles; the same drawing re-fitted or panned only moves the
            // range frame.
            revision={`${drawnRevision}:${semanticTierRef.current ?? ''}`}
            // In semantic mode the SVG is already sized in mapped screen
            // units, so the drawing's scale is 1 — the non-linear map lives in
            // the geometry, not in the minimap's arithmetic.
            scale={semanticCaptureRef.current !== null ? 1 : zoom.scale}
          />
          {/* The zoom cluster floats at the bottom right OF the drawing: the
              three controls act on it, so they stay next to it instead of in
              the toolbar. The scale reading and the semantic tier live in the
              row above the canvas, not here — the cluster is only buttons. */}
          <div
            role="group"
            aria-label={zoomGroupLabel}
            data-architecture-zoom-cluster="true"
            // A phone draws ONE horizontal row (+, −, Fit, then the scale and
            // the level label as small text): 44px buttons + 4px padding a side
            // make the row exactly 52px tall. The fine-pointer tier keeps the
            // compact vertical cluster beside the drawing. The landscape-phone
            // tier trims the row to the 44px targets themselves (no extra
            // band) because its height budget is the whole point of the tier.
            style={{
              gap: shortTouch ? 4 : touchUi ? TOUCH_CONTROL_GAP_PX : 4,
              flexDirection: touchUi ? 'row' : 'column',
              height: portraitClusterCollapsed
                ? '44px'
                : shortTouch
                  ? '44px'
                  : touchUi
                    ? '52px'
                    : undefined,
            }}
            className={`pointer-events-auto flex items-center rounded-lg border border-border/60 bg-background/90 shadow-sm ${touchUi ? 'p-0' : 'flex-col p-1'}`}
          >
            {portraitClusterCollapsed ? (
              // ONE 44px button by default. It states the same percentage the
              // expanded row does, so the collapsed form is still a reading,
              // and it is the only corner control that can touch the drawing —
              // which the host's reserved band keeps it from doing.
              <button
                type="button"
                aria-expanded={false}
                aria-label={t('architecture.plantuml.zoomControls.show', {
                  defaultValue: 'Show zoom controls',
                })}
                onClick={() => setClusterExpanded(true)}
                data-architecture-zoom-cluster-toggle="true"
                style={TOUCH_TARGET_STYLE}
                className={TOOLBAR_BUTTON_CLASS}
              >
                {Math.round(displayScale * 100)}%
              </button>
            ) : (
              <>
                {zoomInButton}
                {zoomOutButton}
                {fitButton}
                {/* On the compact tier the tier bar above the canvas is not on
                    screen, so the cluster IS the one place the scale is stated.
                    On the desktop tier the in-flow row states it and this span
                    is not drawn at all — one drawing, one percentage. */}
                {(readoutInCluster || duplicateReadout) && (
                  <span
                    data-architecture-zoom-cluster-level="true"
                    className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
                  >
                    {Math.round(displayScale * 100)}%
                  </span>
                )}
                {lodDepth !== null && (
                  <span data-architecture-lod-label className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                    {lodDepth === 2
                      ? t('architecture.plantuml.lod.tierNames', { defaultValue: 'Names' })
                      : lodDepth === 1
                        ? t('architecture.plantuml.lod.tierFrames', { defaultValue: 'Frames' })
                        : t('architecture.plantuml.lod.tierPackages', { defaultValue: 'Packages' })}
                  </span>
                )}
                {portraitPhone && (
                  // The way back to the small form, stated as its own 44px
                  // target so it is never mistaken for a zoom-out step.
                  <button
                    type="button"
                    aria-expanded
                    aria-label={t('architecture.plantuml.zoomControls.hide', {
                      defaultValue: 'Hide zoom controls',
                    })}
                    onClick={() => setClusterExpanded(false)}
                    data-architecture-zoom-cluster-collapse="true"
                    style={TOUCH_TARGET_STYLE}
                    className={TOOLBAR_BUTTON_CLASS}
                  >
                    ▾
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {failure !== null && (
        <p data-architecture-plantuml-error="true" role="alert" className="px-4 pb-2 text-xs text-destructive">
          {t('architecture.plantuml.error', { defaultValue: 'The diagram could not be rendered: {{message}}', message: failure })}
        </p>
      )}
    </div>
  );
}
