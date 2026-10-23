import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { DEFAULT_NODE_ID_SHAPE } from '@/modules/architecture/adaptiveGrouping';
import { ArchitectureMinimap } from '@/modules/architecture/ArchitectureMinimap';
import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
  isSessionSeedNode,
  nodeFileOf,
  parserSafePlantUml,
  seedMarkerMode,
  type ArchitectureDiagramView,
  type ArchitecturePlantUml,
} from '@/modules/architecture/archguardToPlantUml';
import { standardiseDrawnStereotypes } from '@/modules/architecture/plantUmlText';
import {
  createExplosionLodScheduler,
  type ExplosionLodScheduler,
} from '@/modules/architecture/explosionLod';
import {
  ASPECT_RELAYOUT_DEBOUNCE_MS,
  clampAspectRatio,
  createLayoutEngine,
  shouldRelayoutForAspect,
  type ArchitectureLayoutEngine,
  type ArchitectureLayoutEngineClass,
} from '@/modules/architecture/elkAspectEngine';
import type { ArchitectureHierarchyIndex } from '@/modules/architecture/hierarchyIndex';
import { readSemanticDrawingGeometry, type SemanticEntityKind } from '@/modules/architecture/semanticZoomRead';
import {
  semanticCompartmentRules,
  solveSemanticZoom,
  lodDepthForTier,
  type SemanticDrawingGeometry,
  type SemanticTier,
  type SemanticZoomLayout,
} from '@/modules/architecture/semanticZoomLayout';
import {
  placeStickyLabels,
  planHintPlacement,
  planRectsIntersect,
  planStickyLabels,
  PACKAGE_TAB_INSET_PX,
  SEMANTIC_MIN_FONT_MOBILE_PX,
  SEMANTIC_MIN_FONT_PX,
  type PlanPoint,
  type PlanRect,
} from '@/modules/architecture/semanticZoomPlan';
import {
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useCanvasHeaderSlot,
  useCompactToolbarSlot,
  useTouchLayout,
  ZOOM_CLUSTER_TARGET_STYLE,
} from '@/modules/architecture/hooks/useTouchLayout';
import {
  buildSeedHierarchy,
  decideReadableZoom,
  fitControlReading,
  readStoredReadableMode,
  shortPackageName,
  writeStoredReadableMode,
  type ReadableZoomDecision,
  type ReadableZoomHint,
  type ReadableZoomMode,
} from '@/modules/architecture/readableZoom';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureNodeIdShape,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';
import {
  cycleNodeFocus,
  selectionsIntersectingBox,
  type ArchitectureBoxCandidate,
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
  fitZoomScale,
  measureViewportSize,
  MIN_READABLE_ZOOM_SCALE,
  MIN_USEFUL_OVERVIEW_SCALE,
  MIN_ZOOM_SCALE,
  readSvgNaturalSize,
  ZOOM_STEP,
  type SvgCornerRect,
  type SvgFitPlacement,
  type SvgViewportController,
  type SvgViewportSize,
} from '@/modules/architecture/svgViewport';

/**
 * The renderer options this component drives. Structural subsets of the
 * package's `RendererOptions` / `ViewSpec`, so the lazily imported module is
 * typed without importing its types into the first-screen chunk.
 */
type PlantUmlView = { kind: 'neighborhood'; entity: string; hops: number };

/** The drawn model's type, without importing the package into this module's graph. */
type PlantUmlDrawnModel = ArchitectureDrawnPlantUml['model'];

/**
 * `renderDetailed` returns the model that was actually laid out and drawn,
 * alongside the SVG — `model` is what the text page serializes, and `layout` is
 * the geometry the renderer used. `layout` takes the engine instance, not the
 * `'elk'` keyword: the engine is built by `createLayoutEngine` so the
 * container's aspect ratio reaches the layout (see `elkAspectEngine.ts`).
 */
type PlantUmlRenderDetailed = (
  puml: string,
  options: { layout: ArchitectureLayoutEngine; view?: PlantUmlView },
) => Promise<{
  model: PlantUmlDrawnModel;
  layout: unknown;
  svg: string;
}>;

/** The upstream serializer and viewer, carried to the text page with the model. */
type PlantUmlToPlantUml = (model: PlantUmlDrawnModel) => string;
type PlantUmlApplyView = (
  model: PlantUmlDrawnModel,
  view: PlantUmlView,
) => PlantUmlDrawnModel;

/** The alias marker the renderer prefixes on overview group nodes (`grp::<path prefix>`). */
const GROUP_PREFIX = 'grp::';
/** Stub nodes in a view (external neighbours) are not real entities; clicks ignore them. */
const STUB_PREFIX = 'stub::';

/**
 * How close two taps on the same node must be to count as the explicit drill
 * gesture. A touch tap cannot double as both "select" and "drill", so the
 * second tap is the user saying "yes, open this one".
 */
const DOUBLE_TAP_MS = 350;

/** The shared look of the diagram toolbar's buttons. */
const TOOLBAR_BUTTON_CLASS =
  'rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60';

/** How far one arrow-key press pans a focused canvas, in CSS pixels. */
const KEYBOARD_PAN_STEP = 40;

/**
 * The cross-panel linkage channel. The SVG is the shared surface: a click on an
 * entity announces it on `window` together with the in/out neighbours read from
 * the neighbourhood JSON, and a sibling panel (the chat, when a file is
 * referenced) can select an entity by its stable `data-entity-id` through the
 * second event. Both names are part of the renderer's documented contract, so a
 * consumer listens for the literal names rather than importing this module.
 */
const ENTITY_SELECTED_EVENT = 'architecture:entity-selected';
const ENTITY_HIGHLIGHT_EVENT = 'architecture:highlight-entity';

/** The selection announced to sibling panels: one entity and its JSON neighbours. */
type EntitySelection = {
  readonly id: string;
  readonly incoming: readonly string[];
  readonly outgoing: readonly string[];
};

/**
 * The dim strength applied to everything that is NOT part of a highlight.
 * Kept at 0.4 (not the old 0.15): the unselected boxes stay readable, which is
 * what the interaction review asked for after a dimmed drawing looked blank.
 */
const DIM_OPACITY = 0.4;

/** Diagram chrome: dim everything not on the hovered node's edges. */
const HIGHLIGHT_STYLE = `
  [data-architecture-plantuml] .arch-dim { opacity: ${DIM_OPACITY}; }
  [data-architecture-plantuml] .arch-hl-in rect,
  [data-architecture-plantuml] .arch-hl-out rect { stroke: #2563eb; stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-hl-in polyline,
  [data-architecture-plantuml] .arch-hl-out polyline { stroke: #2563eb; }
  [data-architecture-plantuml] .arch-hl-in .uml-arrow,
  [data-architecture-plantuml] .arch-hl-out .uml-arrow { fill: #2563eb; stroke: #2563eb; }
  [data-architecture-plantuml] .arch-center rect { fill: #dbeafe; stroke: #1d4ed8; }
  /* A session seed (distance 0) is marked by WEIGHT, not only colour: the frame
     is drawn twice as thick, which survives a greyscale print and colour-blind
     reading. */
  [data-architecture-plantuml] .arch-seed > rect { stroke: #b45309; stroke-width: 3; }
  /* When seeds are half the drawn entities or more the thick frame would mark
     most of the drawing and stop discriminating, so the marker degrades to a
     thin frame plus a small dot. The dot is drawn into the box itself (see
     annotateNodes), so the reading is never colour alone. */
  [data-architecture-plantuml] .arch-seed-light > rect { stroke: #b45309; stroke-width: 1; }
  [data-architecture-plantuml] .arch-seed-light .arch-seed-dot { fill: #b45309; pointer-events: none; }
  /* A hand-pinned entity: its own frame plus the pin glyph annotationNodes
     inserts, so the reading is a shape/symbol and never colour alone. */
  [data-architecture-plantuml] .arch-pinned > rect { stroke: #1d4ed8; stroke-width: 3; }
  [data-architecture-plantuml] .arch-pinned-badge { pointer-events: none; }
  /* Edge relation labels are hidden by default (a dense drawing turns the
     relation stereotypes into a wall of overlapping text); hovering or
     selecting a node reveals the labels of its own edges. The DOM helpers
     hideEdgeLabels/showHighlightedEdgeLabels toggle the SVG display
     presentation attribute on the labels the renderer already drew, so this is
     a visibility toggle, never a re-layout. */
  /* Directory groups are scaffolding, not entities: same dashed, grey frame the
     renderer's own overview stubs use, so a collapsed overview reads as a map. */
  [data-architecture-plantuml] [data-entity-id^="grp::"] rect { fill: #f6f8fa; stroke-dasharray: 5,3; }
  /* At the collapsed LOD levels a package frame whose interior shows nothing
     (no visible entity box, no visible subpackage frame) is background, not
     content: the fill fades and the border halves, so the packages that DO
     carry something keep the reader's attention. The class is toggled with the
     level by applyExplosionLod, never baked into the drawing. */
  [data-architecture-plantuml] .arch-lod-empty-frame > rect { fill-opacity: 0.4; stroke-width: 0.5; }
  /* The inspector's selection: a heavier frame plus the check badge the helper
     appends, so the reading never depends on colour alone. */
  [data-architecture-plantuml] .arch-selected > rect { stroke: #1d4ed8; stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-selected polygon { stroke: #1d4ed8; }
  [data-architecture-plantuml] .arch-selected-check { fill: #1d4ed8; font-weight: 700; }
  /* A selected relation: a bolder line and its type label made visible. */
  [data-architecture-plantuml] .arch-edge-selected path { stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-edge-selected text { display: block; }
  /* The keyboard focus cursor ([ / ] while the canvas is focused). */
  [data-architecture-plantuml] .arch-keyboard-focus > rect { stroke: #1d4ed8; stroke-dasharray: 3,2; }
  /* The invisible hit band laid over each relation. It is a separate path, so
     the renderer's data-edge-* contract is untouched; 12 CSS px on a fine
     pointer, 44 on a coarse one, written by the helper. */
  [data-architecture-plantuml] .arch-edge-hit { fill: none; stroke: transparent; pointer-events: stroke; }
  [data-architecture-plantuml] svg { display: block; margin: 0 auto; }
`;

/**
 * The drawing is something to LOOK AT and OPERATE, not text to copy (copying a
 * diagram goes through the Text page and the export menu). Every element a
 * drag can cross — the scroll host, the injected `svg` and its `text`/`tspan`
 * labels — is declared unselectable, and `-webkit-touch-callout` keeps a phone
 * long-press from opening the select/share bubble over the drawing.
 *
 * The rule and the inline declarations written by `markDrawingUnselectable`
 * say the same thing on purpose: the rule covers every label the renderer adds
 * later, the inline marks are readable without a laid-out browser (the
 * component tests read them), and a browser that ignores the rule on SVG text
 * still honours the inline declaration.
 */
const CANVAS_UNSELECTABLE_STYLE = `
  [data-architecture-plantuml],
  [data-architecture-plantuml] svg,
  [data-architecture-plantuml] text,
  [data-architecture-plantuml] tspan {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
`;

/** The real browser store, or `null` where accessing it throws (private mode). */
function localReadableStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
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
   * The project whose graph is drawn. The reader's explicit readable mode is
   * remembered per project under this id; absent (an embedded renderer with no
   * panel) means the choice is kept for this visit only.
   */
  readonly projectId?: string | null;
};

/**
 * The diagram's presentation scale and why it has that value: `fit` follows the
 * container whenever it resizes, while `custom` is a scale the user chose with
 * the toolbar or the wheel. A view switch re-derives the scale (a new diagram
 * has a new natural size) but keeps this mode, so a fit user stays fitted and a
 * manual user is not silently moved into fit-on-resize.
 */
type DiagramZoom = {
  readonly scale: number;
  readonly mode: 'fit' | 'custom';
};

/** The alias → original id direction of the bridge's map. */
function reverseAliases(aliasOf: ReadonlyMap<string, string>): Map<string, string> {
  const idOf = new Map<string, string>();
  for (const [id, alias] of aliasOf) idOf.set(alias, id);
  return idOf;
}

/**
 * Rewrite the renderer's `data-*` ids from PlantUML aliases back to the
 * ArchGuard ids. The SVG is the renderer's own output and every attribute is
 * already XML-escaped there; here we only swap equal, escaped values, so the
 * decoded attribute values can be exchanged safely through the DOM.
 */
function restoreEntityIds(host: HTMLElement, aliasOf: ReadonlyMap<string, string>): void {
  const idOf = reverseAliases(aliasOf);
  const rename = (element: Element, attribute: string): void => {
    const value = element.getAttribute(attribute);
    if (value === null) return;
    const id = idOf.get(value);
    if (id !== undefined) element.setAttribute(attribute, id);
  };
  for (const node of host.querySelectorAll('[data-entity-id]')) rename(node, 'data-entity-id');
  for (const edge of host.querySelectorAll('[data-edge-source]')) rename(edge, 'data-edge-source');
  for (const edge of host.querySelectorAll('[data-edge-target]')) rename(edge, 'data-edge-target');
}

/**
 * Whether the graph on screen is the ENTITY (class) graph.
 *
 * The panel hands the entity subgraph over with `scope-prefixed` ids and the
 * file subgraph with `project-relative` ones (see `ArchitectureNodeIdShape`),
 * so the shape is the discriminator at the renderer boundary. A renderer given
 * no `idShape` defaults to the entity scheme, which matches the bridge's raw
 * contract.
 */
function isEntityGraph(idShape: ArchitectureNodeIdShape): boolean {
  return idShape === DEFAULT_NODE_ID_SHAPE;
}

/**
 * The view a drawing opens at. The class view opens on the hierarchy, i.e. the
 * entities themselves inside their package frames: folding them into
 * `grp::` directory boxes is the FILE overview's job, and doing it to a class
 * diagram replaced every class the reader asked for with a directory count.
 * The file view keeps the directory-grouped overview.
 */
function defaultViewOf(idShape: ArchitectureNodeIdShape): ArchitectureDiagramView {
  return isEntityGraph(idShape) ? { kind: 'hierarchy' } : { kind: 'overview' };
}

/**
 * The renderer options for one view. The file overview and group views are
 * already collapsed by the bridge (directory-only adaptive grouping), so only
 * the neighbourhood view asks the renderer to slice the model.
 */
function rendererOptionsFor(
  view: ArchitectureDiagramView,
  diagram: ArchitecturePlantUml,
  layout: ArchitectureLayoutEngine,
): { layout: ArchitectureLayoutEngine; view?: PlantUmlView } {
  if (view.kind === 'neighborhood' && diagram.rendererEntity !== null) {
    return {
      layout,
      view: { kind: 'neighborhood', entity: diagram.rendererEntity, hops: view.hops },
    };
  }
  return { layout };
}

/**
 * The container's width/height, clamped by `clampAspectRatio`, or `null` when
 * it has no box yet (jsdom, or a first paint before layout). Measured from the
 * scroll container itself — the element the drawing is actually fitted into.
 */
function measureLayoutAspect(host: HTMLElement): number | null {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return clampAspectRatio(width / height);
}

/** A drawing's identity: the view (with its parameters) that produced it. */
function drawingKeyOf(view: ArchitectureDiagramView): string {
  switch (view.kind) {
    case 'overview':
      return 'overview';
    case 'group':
      return `group:${view.prefix}`;
    case 'neighborhood':
      return `neighborhood:${view.entityId}:${view.hops}`;
    case 'hierarchy':
      return 'hierarchy';
  }
}

/** The readable default currently applied: mode, focus target and overview hint. */
type ReadableView = {
  readonly mode: ReadableZoomMode;
  readonly focusPackageId: string | null;
  readonly hint: ReadableZoomHint | null;
};

/** Normalise a drawn package id the way the hierarchy index does, for comparison. */
function normalizeDrawnPackageId(raw: string | null): string {
  if (raw === null) return '';
  return raw.trim().split('/').filter(Boolean).join('/');
}

/**
 * The element a focus jump should centre. Package frames are the first choice
 * (explosion/neighbourhood views draw them); the grouped overview instead draws
 * `grp::<prefix>` nodes, so the deepest drawn prefix that contains the package
 * is the group the reader should see. `null` when the drawing shows neither.
 */
function focusElementFor(host: HTMLElement, packageId: string): Element | null {
  const wanted = normalizeDrawnPackageId(packageId);
  if (wanted === '') return null;
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    if (normalizeDrawnPackageId(frame.getAttribute('data-package-id')) === wanted) return frame;
  }
  let best: Element | null = null;
  let bestLength = -1;
  for (const node of host.querySelectorAll('[data-entity-id^="grp::"]')) {
    const prefix = normalizeDrawnPackageId(
      (node.getAttribute('data-entity-id') ?? '').slice(GROUP_PREFIX.length),
    );
    if (prefix === '' || (wanted !== prefix && !wanted.startsWith(`${prefix}/`))) continue;
    if (prefix.length > bestLength) {
      best = node;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Centre the package focus mode selected, through the shared viewport entry. */
function centerOnPackage(host: HTMLElement, packageId: string): void {
  const target = focusElementFor(host, packageId);
  if (target !== null) centerElementInContainer(host, target);
}

/**
 * Hide every edge relation label the renderer drew. The label is still in the
 * DOM (the SVG structure is the renderer's contract); only its visibility is
 * toggled, which is why a hover never re-lays the drawing out.
 */
function hideEdgeLabels(host: HTMLElement): void {
  for (const label of host.querySelectorAll('.uml-edge text')) {
    label.setAttribute('display', 'none');
  }
}

/** Reveal the labels of the edges the highlight marked (and only those). */
function showHighlightedEdgeLabels(host: HTMLElement): void {
  for (const edge of host.querySelectorAll('.arch-hl-in, .arch-hl-out')) {
    for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
  }
}

/** Remove every highlight class the hover interaction may have added. */
function clearHighlight(host: HTMLElement): void {
  for (const element of host.querySelectorAll('.arch-dim, .arch-hl-in, .arch-hl-out')) {
    element.classList.remove('arch-dim', 'arch-hl-in', 'arch-hl-out');
  }
  hideEdgeLabels(host);
}

/**
 * Dim everything except the hovered node and its one-hop neighbourhood, and
 * mark its outgoing (`arch-hl-out`) and incoming (`arch-hl-in`) edges. The
 * marked edges are also the only ones whose relation label becomes visible.
 */
function highlightRelations(host: HTMLElement, id: string): void {
  clearHighlight(host);
  const neighbours = new Set<string>([id]);
  const highlighted: Element[] = [];
  const dimmed: Element[] = [];
  for (const edge of host.querySelectorAll('.uml-edge')) {
    const from = edge.getAttribute('data-edge-source');
    const to = edge.getAttribute('data-edge-target');
    if (from === id) {
      edge.classList.add('arch-hl-out');
      highlighted.push(edge);
      if (to !== null) neighbours.add(to);
    } else if (to === id) {
      edge.classList.add('arch-hl-in');
      highlighted.push(edge);
      if (from !== null) neighbours.add(from);
    } else {
      dimmed.push(edge);
    }
  }
  // A node whose relations were all filtered away (e.g. a function whose call
  // edges are hidden) has NOTHING to highlight. Dimming the rest of the drawing
  // in that state painted the whole graph translucent with no reading to
  // compensate — so the dim is only applied alongside at least one highlighted
  // relation.
  if (highlighted.length === 0) return;
  for (const edge of dimmed) edge.classList.add('arch-dim');
  for (const node of host.querySelectorAll('.uml-node')) {
    const nodeId = node.getAttribute('data-entity-id');
    if (nodeId !== null && !neighbours.has(nodeId)) node.classList.add('arch-dim');
  }
  showHighlightedEdgeLabels(host);
}

/**
 * Pin a SELECTED relation: dim everything except the two endpoints and that
 * one edge, and reveal the edge's own type label. Used by the click handler
 * (immediate feedback) and restored after a redraw by the selection effect.
 */
function highlightEdge(host: HTMLElement, edge: Element | null): void {
  clearHighlight(host);
  if (edge === null) return;
  const from = edge.getAttribute('data-edge-source');
  const to = edge.getAttribute('data-edge-target');
  const keep = new Set<string>([from, to].filter((id): id is string => id !== null));
  for (const other of host.querySelectorAll('.uml-edge')) {
    if (other === edge) other.classList.add('arch-hl-out');
    else other.classList.add('arch-dim');
  }
  for (const node of host.querySelectorAll('.uml-node')) {
    const id = node.getAttribute('data-entity-id');
    if (id !== null && !keep.has(id)) node.classList.add('arch-dim');
  }
  for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
}

/** A drawn node rect's own coordinates, as the renderer emits them. */
type MarkerRect = {
  readonly x: number;
  readonly y: number;
};

/**
 * The SVG point `dx`/`dy` inside a node's own rect.
 *
 * The renderer draws each node's `rect` in ABSOLUTE SVG coordinates — the
 * enclosing `<g class="uml-node">` carries no `translate` — so a marker written
 * at a fixed `(4,4)` lands on the canvas origin for every node instead of on the
 * node it annotates. Anchoring the marker to the rect keeps each marker on its
 * own box and keeps the drawing's bounding box unchanged. Used by the seed dot
 * and the pin badge in {@link annotateNodes}; exported so the geometry can be
 * tested without a layout pass.
 */
export function markerAnchor(
  rect: MarkerRect | null | undefined,
  dx: number,
  dy: number,
): { readonly x: number; readonly y: number } {
  const x = rect === null || rect === undefined ? 0 : rect.x;
  const y = rect === null || rect === undefined ? 0 : rect.y;
  return {
    x: (Number.isFinite(x) ? x : 0) + dx,
    y: (Number.isFinite(y) ? y : 0) + dy,
  };
}

/**
 * The first `rect` a node group draws, read as the node's own geometry.
 *
 * `applySelectionStyles` already reads the same rect for its check badge, so
 * every node-anchored decoration agrees on which rectangle is the box.
 */
function nodeRectOf(element: Element): MarkerRect | null {
  const rect = element.querySelector('rect');
  if (rect === null) return null;
  return {
    x: Number(rect.getAttribute('x') ?? '0'),
    y: Number(rect.getAttribute('y') ?? '0'),
  };
}

/**
 * Annotate the freshly drawn SVG with the two readings the node boxes no longer
 * carry themselves:
 *  · the hover `<title>` names the FILE the entity lives in — the box label is
 *    the bare entity name, so the path has to live somewhere the pointer can
 *    reveal it;
 *  · a DIRECT session mention gets the seed marker attribute + class, which the
 *    stylesheet turns into a thicker frame (see HIGHLIGHT_STYLE) — or the light
 *    frame + dot when seeds are the majority of the drawn entities.
 * View scaffolding (group and stub nodes) is not an entity and is skipped.
 */
function annotateNodes(
  host: HTMLElement,
  graph: ArchitectureRendererGraph,
  idShape: ArchitectureNodeIdShape,
): void {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // One reading for the whole drawing: a marker that covered most of the boxes
  // would stop distinguishing anything, so it degrades to its light form (thin
  // frame + dot) once seeds are at least half the drawn entities.
  const seedMode = seedMarkerMode(graph.nodes);
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id');
    if (id === null) continue;
    const node = byId.get(id);
    if (node === undefined) continue;
    const file = nodeFileOf(node, idShape);
    if (file !== '') {
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = file;
      element.insertBefore(title, element.firstChild);
    }
    // The seed reading itself is the shared predicate (`isSessionSeedNode`), so
    // old payloads keep `distance === 0` and only a direct mention is a seed.
    if (isSessionSeedNode(node)) {
      if (seedMode === 'light') {
        // A DOM-shape reading, not colour alone: a small dot beside the label
        // plus the thin frame from the stylesheet. The dot is anchored to THIS
        // node's rect (see `markerAnchor`) — a fixed (4,4) is the SVG origin.
        element.setAttribute('data-architecture-seed', 'light');
        element.classList.add('arch-seed-light');
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'arch-seed-dot');
        dot.setAttribute('data-architecture-seed-dot', 'true');
        const dotAnchor = markerAnchor(nodeRectOf(element), 4, 4);
        dot.setAttribute('cx', String(dotAnchor.x));
        dot.setAttribute('cy', String(dotAnchor.y));
        dot.setAttribute('r', '2.5');
        element.insertBefore(dot, element.firstChild);
      } else {
        element.setAttribute('data-architecture-seed', 'true');
        element.classList.add('arch-seed');
      }
    }
    // A manual pin is not a session seed: it gets its own marker and a literal
    // pin glyph, so the reading never depends on colour alone.
    if (node.mentionTier === 'pinned') {
      element.setAttribute('data-architecture-pinned', 'true');
      element.classList.add('arch-pinned');
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badge.setAttribute('class', 'arch-pinned-badge');
      badge.setAttribute('data-architecture-pinned-badge', 'true');
      // Same absolute-coordinate rule as the seed dot: a fixed (4,12) would
      // paint every pin glyph at the canvas origin.
      const badgeAnchor = markerAnchor(nodeRectOf(element), 4, 12);
      badge.setAttribute('x', String(badgeAnchor.x));
      badge.setAttribute('y', String(badgeAnchor.y));
      badge.setAttribute('font-size', '11');
      badge.textContent = '📌';
      element.insertBefore(badge, element.firstChild);
    }
  }
}

/**
 * The entity's dependency direction, read from the neighbourhood JSON already in
 * hand rather than from the drawn SVG: the SVG is only the visible slice, while
 * the payload is what a sibling panel is told about.
 */
function selectionOf(graph: ArchitectureRendererGraph, id: string): EntitySelection {
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const edge of graph.edges) {
    if (edge.to === id) incoming.push(edge.from);
    if (edge.from === id) outgoing.push(edge.to);
  }
  return { id, incoming, outgoing };
}

/**
 * Announce a click to sibling panels. Guarded because the renderer is mounted
 * in jsdom tests too, where `window` is present, and in a future non-browser
 * render there would simply be no listener to notify.
 */
function announceSelection(graph: ArchitectureRendererGraph, id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<EntitySelection>(ENTITY_SELECTED_EVENT, {
    detail: selectionOf(graph, id),
  }));
}

/**
 * Re-apply the selected entity's highlight after a render, and clear it when the
 * selection is not part of the view that was just drawn (a group view can hide
 * the entity a previous neighbourhood selection named).
 */
function highlightSelection(host: HTMLElement, id: string | null): void {
  if (id === null || nodeElement(host, id) === null) {
    clearHighlight(host);
    return;
  }
  highlightRelations(host, id);
}

/** The relation kinds on the hovered node's VISIBLE edges, read from what was actually drawn. */
function relationsOf(host: HTMLElement, id: string): string[] {
  const relations = new Set<string>();
  for (const edge of host.querySelectorAll('.uml-edge')) {
    if (edge.getAttribute('data-edge-source') !== id && edge.getAttribute('data-edge-target') !== id) continue;
    const type = edge.getAttribute('data-edge-type');
    if (type !== null) relations.add(type);
  }
  return [...relations].sort();
}

/** The drawn node carrying `id`, without relying on `CSS.escape` (absent in jsdom). */
function nodeElement(host: HTMLElement, id: string): Element | null {
  for (const node of host.querySelectorAll('.uml-node')) {
    if (node.getAttribute('data-entity-id') === id) return node;
  }
  return null;
}

/**
 * Enlarge every relation's clickable band WITHOUT touching the renderer's
 * `data-edge-*` contract: each drawn edge gets one extra transparent stroke
 * path with the same geometry, 12 CSS px wide on a fine pointer and 44 on a
 * coarse one. The clone carries `data-architecture-edge-*` names instead of the
 * `data-edge-*` ones, so every existing reading (drawn-edge counts, hover
 * highlights) keeps seeing exactly one element per relation.
 */
function addEdgeHitTargets(host: HTMLElement, coarsePointer: boolean): void {
  const width = coarsePointer ? 44 : 12;
  for (const edge of host.querySelectorAll('.uml-edge')) {
    const source = edge.getAttribute('data-edge-source');
    const target = edge.getAttribute('data-edge-target');
    if (source === null || target === null) continue;
    // The renderer draws the line as the edge's first path; the arrow is a
    // separate polygon and needs no hit band of its own.
    const line = edge.querySelector('path');
    if (line === null) continue;
    const hit = line.cloneNode(false) as SVGPathElement;
    hit.removeAttribute('class');
    hit.setAttribute('class', 'arch-edge-hit');
    hit.setAttribute('data-architecture-edge-hit', 'true');
    hit.setAttribute('data-architecture-edge-source', source);
    hit.setAttribute('data-architecture-edge-target', target);
    hit.setAttribute('data-architecture-edge-type', edge.getAttribute('data-edge-type') ?? '');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', String(width));
    hit.setAttribute('vector-effect', 'non-scaling-stroke');
    hit.setAttribute('pointer-events', 'stroke');
    edge.appendChild(hit);
  }
}

/**
 * Mark the freshly injected drawing unselectable, inline.
 *
 * The injected {@link CANVAS_UNSELECTABLE_STYLE} rule already covers the host,
 * the `svg` and every label, but two things need the inline declaration too: a
 * browser that only honours `user-select` on HTML (not on SVG text) would still
 * start a drag-selection on a node label, and the component tests read the
 * inline value because jsdom's computed style drops properties it does not
 * know. Called after EVERY DOM addition on the drawing (labels, badges, hit
 * bands), so no node the renderer appends later is left selectable.
 */
function markDrawingUnselectable(host: HTMLElement): void {
  host.style.userSelect = 'none';
  const drawing = host.querySelector('svg');
  if (drawing === null) return;
  drawing.style.userSelect = 'none';
  for (const label of drawing.querySelectorAll('text, tspan')) {
    if (label instanceof SVGElement) label.style.userSelect = 'none';
  }
}

/**
 * One drawing captured for semantic zoom.
 *
 * `inner` is the annotated SVG BEFORE any semantic rewrite (labels hidden,
 * entity ids restored, seed markers added, edge hit bands present). Every
 * application restores it first, so rewriting is idempotent and the ≥ 90 %
 * view is the renderer's own drawing times the scale. `geometry` holds the
 * same rectangles read in user units; the engine never reads a rewritten DOM.
 */
type SemanticCapture = {
  readonly svg: SVGSVGElement;
  readonly inner: string;
  readonly geometry: SemanticDrawingGeometry;
  readonly baseSize: SvgViewportSize;
  readonly titles: ReadonlyMap<string, string | null>;
};

/** Capture the drawing that was just injected. */
function captureSemanticDrawing(
  host: HTMLElement,
  graph: ArchitectureRendererGraph,
): SemanticCapture | null {
  const svg = host.querySelector('svg');
  if (!(svg instanceof SVGSVGElement)) return null;
  // 0.4.0 publishes compartments but not the entity KIND (function vs class)
  // and its member parser calls a field whose type contains `(` a method, so
  // the payload's authoritative kinds are handed to the read layer as hints.
  const kindById = new Map<string, SemanticEntityKind>(graph.nodes.map((node) => {
    const kind = node.kind;
    const mapped: SemanticEntityKind = kind === 'interface' || kind === 'enum' || kind === 'function'
      ? kind
      : 'class';
    return [node.id, mapped];
  }));
  const memberKindsById = new Map<string, readonly ('field' | 'method')[]>(
    graph.nodes
      .filter((node) => (node.members?.length ?? 0) > 0)
      .map((node) => [
        node.id,
        (node.members ?? []).map((member) => (member.kind === 'method' ? 'method' : 'field')),
      ]),
  );
  const geometry = readSemanticDrawingGeometry(svg, { kindById, memberKindsById });
  const titles = new Map<string, string | null>();
  for (const node of svg.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = node.getAttribute('data-entity-id');
    if (id === null) continue;
    const title = [...node.children].find((child) => child.tagName.toLowerCase() === 'title');
    titles.set(id, title?.textContent ?? null);
  }
  const baseSize = readSvgNaturalSize(svg) ?? { width: geometry.width, height: geometry.height };
  return { svg, inner: svg.innerHTML, geometry, baseSize, titles };
}

/** Create an SVG element with presentation attributes. */
function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
  parent: Element,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  parent.appendChild(element);
  return element;
}

/** Rewrite a path's coordinate pairs through `map`, pinning its two ends. */
function rewritePathData(
  d: string,
  map: (x: number, y: number) => PlanPoint,
  ends: { readonly first: PlanPoint | null; readonly last: PlanPoint | null },
): string {
  const pairs = [...d.matchAll(/(-?\d*\.?\d+(?:e[-+]?\d+)?)[\s,]+(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi)];
  let index = 0;
  return d.replace(
    /(-?\d*\.?\d+(?:e[-+]?\d+)?)[\s,]+(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi,
    (_match, x: string, y: string) => {
      let point = map(Number(x), Number(y));
      if (index === 0 && ends.first !== null) point = ends.first;
      else if (index === pairs.length - 1 && ends.last !== null) point = ends.last;
      index += 1;
      return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    },
  );
}

/** The fill/stroke palette the semantic renderer draws class boxes with. */
const SEMANTIC_NODE_STYLE: Record<string, readonly [string, string]> = {
  class: ['#ffffff', '#64748b'],
  interface: ['#e0f2fe', '#0284c7'],
  enum: ['#fef3c7', '#d97706'],
  function: ['#f1f5f9', '#64748b'],
};
/** Nested package fills, pale so the tab text stays readable. */
const SEMANTIC_PACKAGE_FILLS = ['#f1f5f9', '#e7edf5', '#dde6f1', '#d3deec', '#c9d7e7'];
const SEMANTIC_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SEMANTIC_SANS = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
/** The accent the design uses for a session-mentioned entity and its ★N badge. */
const SEMANTIC_SEED_COLOR = '#ea580c';

/**
 * Draw one semantic layout over the captured drawing.
 *
 * Every element the renderer emitted is rewritten in place and keeps its
 * contract attributes (`data-entity-id`, `data-package-id`, `data-edge-source`,
 * `data-edge-target`); only the geometry and the text plan change. The SVG is
 * then sized 1:1 for the mapped layout, which is what lets the minimum font
 * size be a real screen reading instead of a CSS-scaled one.
 */
function drawSemanticLayout(
  host: HTMLElement,
  capture: SemanticCapture,
  layout: SemanticZoomLayout,
  fontPx: number,
): void {
  const svg = capture.svg;
  // Restoring the annotated drawing first makes every application independent
  // of the previous one (and keeps the ≥ 90 % view byte-identical to the
  // renderer's own output).
  svg.innerHTML = capture.inner;
  const offsetX = -layout.content.x;
  const offsetY = -layout.content.y;
  const width = Math.max(1, Math.ceil(layout.content.width));
  const height = Math.max(1, Math.ceil(layout.content.height));
  const mapPoint = (x: number, y: number): PlanPoint => ({
    x: layout.x.map(x) + offsetX,
    y: layout.y.map(y) + offsetY,
  });

  // The canvas background follows the mapped extent.
  const canvas = svg.querySelector('.uml-canvas');
  if (canvas !== null) {
    canvas.setAttribute('width', String(width));
    canvas.setAttribute('height', String(height));
  }

  // ---- edges (mapped first; the class boxes are drawn on top of them)
  for (const group of svg.querySelectorAll('.uml-edge[data-edge-source]')) {
    if (layout.tier === 'C') {
      // Tier C draws packages only: the entity relations are hidden, not left
      // mapped at their old coordinates.
      (group as SVGGElement).style.display = 'none';
      continue;
    }
    (group as SVGGElement).style.display = '';
    const edge = layout.edges.find(
      (candidate) => candidate.source === group.getAttribute('data-edge-source')
        && candidate.target === group.getAttribute('data-edge-target'),
    );
    const ends = edge === undefined
      ? { first: null, last: null }
      : {
          // The engine works in absolute mapped units; the drawing is
          // translated so its content starts at the origin. The endpoints must
          // get that same translation as every other mapped point.
          first: edge.points[0] === undefined
            ? null
            : { x: edge.points[0].x + offsetX, y: edge.points[0].y + offsetY },
          last: edge.points[edge.points.length - 1] === undefined
            ? null
            : {
                x: edge.points[edge.points.length - 1].x + offsetX,
                y: edge.points[edge.points.length - 1].y + offsetY,
              },
        };
    for (const path of group.querySelectorAll('path')) {
      const d = path.getAttribute('d');
      if (d !== null) path.setAttribute('d', rewritePathData(d, mapPoint, ends));
    }
    for (const polygon of group.querySelectorAll('polygon')) {
      const points = (polygon.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(',').map(Number))
        .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
      if (points.length === 0) continue;
      // The marker keeps its drawn SIZE and is translated so its vertex nearest
      // the line's end lands exactly on that end (which the engine snapped onto
      // the frame). This is what keeps the arrowhead attached to the line at
      // every tier, including a compacted one.
      const centroid = {
        x: points.reduce((total, point) => total + point[0], 0) / points.length,
        y: points.reduce((total, point) => total + point[1], 0) / points.length,
      };
      const mappedCentroid = mapPoint(centroid.x, centroid.y);
      const toTarget = ends.last !== null
        && (Math.hypot(mappedCentroid.x - ends.last.x, mappedCentroid.y - ends.last.y)
          <= Math.hypot(
            mappedCentroid.x - (ends.first?.x ?? mappedCentroid.x),
            mappedCentroid.y - (ends.first?.y ?? mappedCentroid.y),
          ));
      const reference = toTarget ? ends.last : ends.first;
      let dx = 0;
      let dy = 0;
      if (reference !== null) {
        let nearest = mapPoint(points[0][0], points[0][1]);
        let best = Math.hypot(nearest.x - reference.x, nearest.y - reference.y);
        for (const point of points) {
          const mapped = mapPoint(point[0], point[1]);
          const distance = Math.hypot(mapped.x - reference.x, mapped.y - reference.y);
          if (distance < best) {
            best = distance;
            nearest = mapped;
          }
        }
        dx = reference.x - nearest.x;
        dy = reference.y - nearest.y;
      }
      polygon.setAttribute('points', points
        .map((point) => {
          const mapped = mapPoint(point[0], point[1]);
          return `${(mapped.x + dx).toFixed(1)},${(mapped.y + dy).toFixed(1)}`;
        })
        .join(' '));
    }
    for (const text of group.querySelectorAll('text')) {
      const x = Number(text.getAttribute('x'));
      const y = Number(text.getAttribute('y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const mapped = mapPoint(x, y);
      text.setAttribute('x', mapped.x.toFixed(1));
      text.setAttribute('y', mapped.y.toFixed(1));
    }
    if (edge !== undefined) {
      (group as SVGGElement).style.opacity = String(edge.opacity);
    }
  }

  // ---- package frames + tabs
  for (const packageLayout of layout.packages) {
    const group = [...svg.querySelectorAll('.uml-package[data-package-id]')].find(
      (candidate) => candidate.getAttribute('data-package-id') === packageLayout.id,
    );
    if (group === undefined) continue;
    while (group.firstChild !== null) group.removeChild(group.firstChild);
    const frame = packageLayout.frame;
    const x = frame.x + offsetX;
    const y = frame.y + offsetY;
    const w = Math.max(0, frame.width);
    const h = Math.max(0, frame.height);
    svgElement('rect', {
      x,
      y,
      width: w,
      height: h,
      rx: 3,
      fill: SEMANTIC_PACKAGE_FILLS[Math.min(packageLayout.depth, SEMANTIC_PACKAGE_FILLS.length - 1)],
      stroke: '#94a3b8',
      'stroke-width': 1,
    }, group);
    if (packageLayout.tabRect === null) continue;
    const tabX = x + PACKAGE_TAB_INSET_PX - 1;
    const tabTop = y;
    const tabWidth = packageLayout.tab.width;
    const tabHeight = packageLayout.tab.height;
    // The tab is a complete little rectangle closed on its right side: top
    // edge, right cap and underline. It is what makes a package frame read as
    // UML rather than as a plain box.
    svgElement('path', {
      d: `M${tabX.toFixed(1)},${tabTop.toFixed(1)} H${(tabX + tabWidth).toFixed(1)}`
        + ` V${(tabTop + tabHeight).toFixed(1)} H${tabX.toFixed(1)}`,
      fill: 'none',
      stroke: '#94a3b8',
      'stroke-width': 1,
    }, group);
    const label = svgElement('text', {
      x: tabX + 3,
      y: tabTop + tabHeight / 2 + fontPx * 0.36,
      'font-family': SEMANTIC_SANS,
      'font-size': fontPx,
      'font-weight': 600,
      fill: '#334155',
    }, group);
    label.textContent = packageLayout.tab.text;
    if (packageLayout.tab.badge !== '') {
      const badge = svgElement('tspan', { fill: SEMANTIC_SEED_COLOR }, label);
      badge.textContent = packageLayout.tab.badge;
    }
  }

  // ---- class boxes
  const lineHeight = fontPx * 1.25;
  const drawnNodeIds = new Set(layout.nodes.map((node) => node.id));
  // Tier C draws no class box at all: the entity groups must be hidden, not
  // merely left out of the draw loop.
  for (const group of svg.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = group.getAttribute('data-entity-id') ?? '';
    if (!drawnNodeIds.has(id)) (group as SVGGElement).style.display = 'none';
  }
  for (const nodeLayout of layout.nodes) {
    const group = [...svg.querySelectorAll('.uml-node[data-entity-id]')].find(
      (candidate) => candidate.getAttribute('data-entity-id') === nodeLayout.id,
    );
    if (group === undefined) continue;
    if (nodeLayout.hidden) {
      (group as SVGGElement).style.display = 'none';
      continue;
    }
    (group as SVGGElement).style.display = '';
    while (group.firstChild !== null) group.removeChild(group.firstChild);
    const drawn = nodeLayout.drawn;
    const x = drawn.x + offsetX;
    const y = drawn.y + offsetY;
    const w = Math.max(0, drawn.width);
    const h = Math.max(0, drawn.height);
    const style = SEMANTIC_NODE_STYLE[nodeLayout.plan.kind] ?? SEMANTIC_NODE_STYLE.class;
    const title = capture.titles.get(nodeLayout.id);
    if (title !== null && title !== undefined) {
      const titleElement = svgElement('title', {}, group);
      titleElement.textContent = title;
    }
    const seed = capture.geometry.nodes.find((node) => node.id === nodeLayout.id)?.seed === true;
    svgElement('rect', {
      x,
      y,
      width: w,
      height: h,
      rx: 2,
      fill: seed ? '#fff7ed' : style[0],
      stroke: seed ? SEMANTIC_SEED_COLOR : style[1],
      'stroke-width': seed ? 2 : 1,
    }, group);
    // UML form never degrades: the compartment rules are drawn even when the
    // member text is hidden, and an operations-only interface keeps one.
    for (const rule of semanticCompartmentRules(nodeLayout)) {
      svgElement('line', {
        x1: x,
        x2: x + w,
        y1: y + rule,
        y2: y + rule,
        stroke: seed ? SEMANTIC_SEED_COLOR : style[1],
        'stroke-width': 1,
      }, group);
    }
    if (nodeLayout.showName) {
      const lines = nodeLayout.plan.name.lines;
      const centreX = x + w / 2;
      const stereotypeHeight = nodeLayout.plan.stereotype === null ? 0 : fontPx;
      if (nodeLayout.plan.stereotype !== null) {
        // The stereotype is drawn at the SAME floor font as every other visible
        // label: the old 0.8× drew 8px on the PC tier, under the 10px floor.
        // The plan already grew the title compartment by a full line for it.
        const stereotype = svgElement('text', {
          x: centreX,
          y: y + fontPx * 0.85,
          'text-anchor': 'middle',
          'font-family': SEMANTIC_SANS,
          'font-size': fontPx,
          'font-style': 'italic',
          'data-architecture-node-stereotype': 'true',
          fill: '#475569',
        }, group);
        stereotype.textContent = `<<${nodeLayout.plan.stereotype}>>`;
      }
      const baseY = y + nodeLayout.drawnTitleHeight / 2 - (lines.length * lineHeight) / 2
        + fontPx * 0.9 + stereotypeHeight / 2;
      lines.forEach((line, index) => {
        const text = svgElement('text', {
          x: centreX,
          y: baseY + index * lineHeight,
          'text-anchor': 'middle',
          'font-family': SEMANTIC_MONO,
          'font-size': fontPx,
          'font-weight': 700,
          'font-style': nodeLayout.plan.kind === 'interface' ? 'italic' : 'normal',
          'data-architecture-node-name': 'true',
          // The full label, so a reading can tell a wrapped/ellipsized name
          // from one that lost its title to a decoration.
          'data-architecture-label': nodeLayout.plan.name.label,
          fill: nodeLayout.plan.kind === 'interface' ? '#075985' : '#1e293b',
        }, group);
        text.textContent = line;
      });
    }
    if (nodeLayout.showMembers && nodeLayout.memberRows !== null) {
      const rows = nodeLayout.memberRows;
      // The operations block starts BELOW the member-positioned rule, so the
      // rule can never cut through a row (the proportional rule did).
      const split = semanticCompartmentRules(nodeLayout);
      const splitY = split.length > 1 ? split[1] : null;
      let attrIndex = 0;
      let opIndex = 0;
      rows.rows.forEach((row, index) => {
        const inAttributes = index < rows.attrCount;
        const baseline = y + (inAttributes
          ? nodeLayout.drawnTitleHeight + (attrIndex + 1) * lineHeight - 2
          : (splitY ?? nodeLayout.drawnTitleHeight) + (opIndex + 1) * lineHeight - 2);
        const text = svgElement('text', {
          x: x + 5,
          y: baseline,
          'font-family': SEMANTIC_MONO,
          'font-size': fontPx,
          'data-architecture-node-member': 'true',
          'data-architecture-member-compartment': inAttributes ? 'attr' : 'op',
          fill: '#475569',
        }, group);
        text.textContent = row;
        if (inAttributes) attrIndex += 1;
        else opIndex += 1;
      });
      if (rows.moreLabel !== null) {
        const inAttributes = rows.moreCompartment === 'attr';
        const baseline = y + (inAttributes
          ? nodeLayout.drawnTitleHeight + (rows.attrCount + 1) * lineHeight - 2
          : (splitY ?? nodeLayout.drawnTitleHeight) + (opIndex + 1) * lineHeight - 2);
        const text = svgElement('text', {
          x: x + 5,
          y: baseline,
          'font-family': SEMANTIC_MONO,
          'font-size': fontPx,
          'font-style': 'italic',
          'data-architecture-node-more': 'true',
          fill: '#64748b',
        }, group);
        text.textContent = rows.moreLabel;
      }
    }
    if (capture.geometry.nodes.find((node) => node.id === nodeLayout.id)?.mentionTier === 'pinned') {
      const badge = svgElement('text', {
        x: x + 4,
        y: y + 12,
        'font-size': 11,
        class: 'arch-pinned-badge',
        'data-architecture-pinned-badge': 'true',
      }, group);
      badge.textContent = '📌';
    } else if (group.classList.contains('arch-seed-light')) {
      // The light seed marker is a DOT beside the label (a shape reading, not
      // colour alone); it is re-drawn because wiping the group's children also
      // removed the one annotateNodes inserted.
      svgElement('circle', {
        cx: x + 4,
        cy: y + 4,
        r: 2.5,
        class: 'arch-seed-dot',
        'data-architecture-seed-dot': 'true',
        fill: SEMANTIC_SEED_COLOR,
        'pointer-events': 'none',
      }, group);
    }
  }

  // ---- sticky package names
  // Drawn by `drawStickyLabels` AFTER the caller has applied the scroll offset:
  // a sticky label's position is a reading of where the viewport is, and the
  // offset this draw computes is only written back afterwards.

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  // The reading tests (and the E2E guard) can tell a semantically rewritten
  // drawing from a CSS-scaled one: in this mode width/height are the mapped
  // layout at 1:1 and the scale is carried by the geometry itself.
  svg.setAttribute('data-architecture-semantic', layout.tier);
  svg.setAttribute('data-architecture-semantic-scale', String(layout.scale));
}

/** A CSS length read out of a computed style, in px (0 when absent). */
function stylePx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The reader's visible content box, in the drawing SVG's own user units.
 *
 * Semantic mode shows the SVG 1:1 (its width/height attributes equal its
 * viewBox), so a screen-pixel offset relative to the SVG's own box IS a user
 * unit. The host's padding is excluded: that band is not where the drawing is
 * visible, and a sticky label placed into it would sit under the border.
 */
function visibleViewportInSvg(host: HTMLElement, svg: SVGSVGElement): PlanRect | null {
  const hostRect = host.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  let paddingLeft = 0;
  let paddingTop = 0;
  let paddingX = 0;
  let paddingY = 0;
  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(host);
    paddingLeft = stylePx(style.paddingLeft);
    paddingTop = stylePx(style.paddingTop);
    paddingX = paddingLeft + stylePx(style.paddingRight);
    paddingY = paddingTop + stylePx(style.paddingBottom);
  }
  const width = host.clientWidth - paddingX;
  const height = host.clientHeight - paddingY;
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: hostRect.left + paddingLeft - svgRect.left,
    y: hostRect.top + paddingTop - svgRect.top,
    w: width,
    h: height,
  };
}

/** One element's painted rectangle in the SVG's user units, or null when it has none. */
function rectInSvg(element: Element, svgRect: DOMRect): PlanRect | null {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { x: rect.left - svgRect.left, y: rect.top - svgRect.top, w: rect.width, h: rect.height };
}

/**
 * Draw the sticky package names at the viewport's top edge, after the caller
 * has applied the scroll offset this layout was solved for.
 *
 * A sticky label appears ONLY for a package whose own tab has scrolled out of
 * view (a visible tab is already the label), never over a visible class name or
 * another package's tab, and always fully inside the viewport. The rules are in
 * `planStickyLabels` / `placeStickyLabels`; this function only converts the
 * live DOM to their coordinate space and draws the result.
 *
 * Consumers: the semantic application paths and the host's scroll listener.
 */
function drawStickyLabels(host: HTMLElement, layout: SemanticZoomLayout, fontPx: number): void {
  const svg = host.querySelector('svg');
  if (!(svg instanceof SVGSVGElement)) return;
  // Every pass rebuilds the ghosts; a previous pass's labels would otherwise
  // survive a scroll and be read at the old viewport position.
  for (const stale of [...svg.querySelectorAll('[data-architecture-sticky-package]')]) stale.remove();
  const viewport = visibleViewportInSvg(host, svg);
  if (viewport === null) return;
  const svgRect = svg.getBoundingClientRect();
  const offsetX = -layout.content.x;
  const offsetY = -layout.content.y;

  // Prefer the PAINTED tab rect over the planned one: the plan is a user-unit
  // rectangle, while the reading that decides "is my own tab on screen" uses
  // the path the browser actually painted (a 1px difference at the viewport
  // edge would otherwise show a ghost beside a visible tab).
  const paintedTabs = new Map<string, PlanRect>();
  for (const group of svg.querySelectorAll('.uml-package[data-package-id]')) {
    const path = [...group.children].find((child) => child.tagName.toLowerCase() === 'path');
    const rect = path === undefined ? null : rectInSvg(path, svgRect);
    if (rect !== null) paintedTabs.set(group.getAttribute('data-package-id') ?? '', rect);
  }

  const candidates = layout.packages
    .filter((entry) => entry.tabRect !== null)
    .map((entry) => {
      const tab = entry.tabRect;
      const planned = tab === null
        ? null
        : { x: tab.x + offsetX, y: tab.y + offsetY, w: tab.w, h: tab.h };
      const painted = paintedTabs.get(entry.id) ?? planned;
      return {
        id: entry.id,
        depth: entry.depth,
        top: entry.frame.y + offsetY,
        bottom: entry.frame.y + offsetY + entry.frame.height,
        tab: painted,
        anchorX: painted?.x ?? 0,
        width: painted?.w ?? entry.tab.width,
        height: painted?.h ?? entry.tab.height,
      };
    });
  const stickyFrames = planStickyLabels(candidates, viewport.y, viewport);
  if (stickyFrames.length === 0) return;

  // A ghost may cover neither a visible class name (rule 3) nor a real tab
  // (rule 2), so both are obstacles in the same user-unit space.
  const obstacles: PlanRect[] = [];
  for (const text of svg.querySelectorAll('[data-architecture-node-name]')) {
    const rect = rectInSvg(text, svgRect);
    if (rect !== null) obstacles.push(rect);
  }
  for (const tab of svg.querySelectorAll('.uml-package[data-package-id] > path')) {
    const rect = rectInSvg(tab, svgRect);
    if (rect !== null) obstacles.push(rect);
  }
  const hint = host.parentElement?.querySelector('[data-architecture-readable-hint]');
  if (hint !== undefined && hint !== null) {
    const rect = rectInSvg(hint, svgRect);
    if (rect !== null) obstacles.push(rect);
  }

  const placements = placeStickyLabels({
    candidates: stickyFrames.map((frame) => ({
      id: frame.id,
      anchorX: frame.anchorX,
      width: frame.width,
      height: frame.height,
    })),
    viewport,
    obstacles,
  });
  for (const placement of placements) {
    const entry = layout.packages.find((candidate) => candidate.id === placement.id);
    if (entry === undefined) continue;
    const group = svgElement('g', {
      'data-architecture-sticky-package': placement.id,
    }, svg);
    svgElement('rect', {
      x: placement.rect.x,
      y: placement.rect.y,
      width: placement.rect.w,
      height: placement.rect.h,
      rx: 3,
      fill: 'rgba(248,250,252,.92)',
    }, group);
    const text = svgElement('text', {
      x: placement.rect.x + 3,
      y: placement.rect.y + placement.rect.h / 2 + fontPx * 0.36,
      'font-family': SEMANTIC_SANS,
      'font-size': fontPx,
      fill: '#334155',
    }, group);
    text.textContent = entry.tab.text;
    if (entry.tab.badge !== '') {
      const badge = svgElement('tspan', { fill: SEMANTIC_SEED_COLOR }, text);
      badge.textContent = entry.tab.badge;
    }
  }
}

/**
 * Place the overview hint pill where it cannot cover a package tab.
 *
 * The pill is an HTML overlay in the canvas's own coordinate space; the tab
 * rects are converted from screen to canvas-local coordinates. When the layout
 * has not been measured (jsdom) the declared top-left position is left alone.
 */
function positionOverviewHint(host: HTMLElement): void {
  const canvas = host.closest('[data-architecture-canvas]');
  if (!(canvas instanceof HTMLElement)) return;
  const hint = canvas.querySelector('[data-architecture-readable-hint]');
  if (!(hint instanceof HTMLElement)) return;
  const canvasRect = canvas.getBoundingClientRect();
  const hintRect = hint.getBoundingClientRect();
  const viewport: PlanRect = { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
  if (!(viewport.w > 0) || !(viewport.h > 0)) return;
  if (!(hintRect.width > 0) || !(hintRect.height > 0)) return;
  const obstacles: PlanRect[] = [];
  for (const tab of host.querySelectorAll('.uml-package[data-package-id] > path')) {
    const rect = tab.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    const local: PlanRect = {
      x: rect.left - canvasRect.left,
      y: rect.top - canvasRect.top,
      w: rect.width,
      h: rect.height,
    };
    if (planRectsIntersect(local, viewport)) obstacles.push(local);
  }
  const placement = planHintPlacement({
    width: hintRect.width,
    height: hintRect.height,
    viewport,
    obstacles,
  });
  hint.style.left = `${Math.round(placement.x)}px`;
  hint.style.top = `${Math.round(placement.y)}px`;
}

/**
 * The on-screen frame rect of a drawn package, in drawing user units. Read from
 * the SVG that is on screen NOW (after the semantic pass rewrote it), so a
 * "tap a package" zoom centres the frame the reader is looking at.
 */
function drawnPackageFrame(
  host: ParentNode,
  packageId: string,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
  const frame = [...host.querySelectorAll('.uml-package[data-package-id]')]
    .find((candidate) => candidate.getAttribute('data-package-id') === packageId);
  const rect = frame?.querySelector('rect');
  if (rect === undefined || rect === null) return null;
  const read = (name: string): number => {
    const value = Number(rect.getAttribute(name));
    return Number.isFinite(value) ? value : 0;
  };
  return { x: read('x'), y: read('y'), width: read('width'), height: read('height') };
}

/** The drawn edge group between `from` and `to`, if this view draws one. */
function edgeElement(host: HTMLElement, from: string, to: string): Element | null {  for (const edge of host.querySelectorAll('.uml-edge')) {
    if (edge.getAttribute('data-edge-source') === from && edge.getAttribute('data-edge-target') === to) {
      return edge;
    }
  }
  return null;
}

/**
 * Draw the panel's selection set on the freshly rendered (or re-rendered) SVG:
 * a heavier frame plus a check badge on every selected node, and a bolder line
 * with its visible type label on every selected relation. Cleared first, so a
 * selection that is no longer drawn leaves no residue. Single-selection callers
 * pass one-element arrays and get exactly the old drawing.
 */
function applySelectionStyles(
  host: HTMLElement,
  nodeIds: readonly string[],
  relations: readonly { readonly from: string; readonly to: string }[],
): void {
  for (const element of host.querySelectorAll('.arch-selected, .arch-edge-selected')) {
    element.classList.remove('arch-selected', 'arch-edge-selected');
  }
  for (const badge of host.querySelectorAll('.arch-selected-check')) badge.remove();

  for (const nodeId of nodeIds) {
    const node = nodeElement(host, nodeId);
    if (node === null) continue;
    node.classList.add('arch-selected');
    const rect = node.querySelector('rect');
    if (rect !== null) {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      const x = Number(rect.getAttribute('x') ?? '0') + Number(rect.getAttribute('width') ?? '0') - 4;
      const y = Number(rect.getAttribute('y') ?? '0') + 11;
      badge.setAttribute('x', String(x));
      badge.setAttribute('y', String(y));
      badge.setAttribute('text-anchor', 'end');
      badge.setAttribute('font-size', '11');
      badge.setAttribute('class', 'arch-selected-check');
      badge.setAttribute('data-architecture-selected-check', nodeId);
      badge.textContent = '✓';
      node.appendChild(badge);
    }
  }

  for (const relation of relations) {
    const edge = edgeElement(host, relation.from, relation.to);
    if (edge === null) continue;
    edge.classList.add('arch-edge-selected');
    for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
  }
}

/** The drawn rectangles a marquee hit test compares against, in client pixels. */
function rectOf(element: Element): ArchitectureSelectionRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/**
 * Every drawn entity and relation, paired with the rectangle it occupies. Group
 * and stub nodes are view scaffolding rather than entities, so a marquee never
 * selects them. A zero-area box (jsdom, a hidden tab) is dropped by the same
 * half-open rule the pure hit test applies.
 */
function boxCandidates(host: HTMLElement): ArchitectureBoxCandidate[] {
  const candidates: ArchitectureBoxCandidate[] = [];
  for (const element of host.querySelectorAll('[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id') ?? '';
    if (id === '' || id.startsWith(GROUP_PREFIX) || id.startsWith(STUB_PREFIX)) continue;
    candidates.push({ selection: { kind: 'entity', nodeId: id }, rect: rectOf(element) });
  }
  for (const element of host.querySelectorAll('[data-architecture-edge-hit]')) {
    const from = element.getAttribute('data-architecture-edge-source');
    const to = element.getAttribute('data-architecture-edge-target');
    if (from === null || to === null) continue;
    const relationType = element.getAttribute('data-architecture-edge-type') ?? '';
    candidates.push({
      selection: { kind: 'relation', from, to, relationType },
      rect: rectOf(element),
    });
  }
  return candidates;
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
  detailReading,
  onNodeClick,
  onEdgeClick,
  onSelectionClear,
  onNodeHover,
  onEscapeSelection,
  selectedNodeId = null,
  selectedRelation = null,
  relayoutLocked = false,
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
  projectId = null,
}: PlantUmlGraphProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The pointer/size tier: coarse pointers get 44px hit areas, narrow screens
  // collect the toolbar into one overflow menu (see `useTouchLayout`).
  const { touchUi, coarsePointer, compactToolbar } = useTouchLayout();
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
  // The node the `[`/`]` keyboard cursor sits on. A ref (not state): moving the
  // cursor only touches SVG classes, so it must not re-render (and never
  // re-layout) the drawing.
  const keyboardFocusRef = useRef<string | null>(null);
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
  }, [view, graph, onNodeHover, onNodeClick, onEdgeClick, onSelectionClear, onEscapeSelection, onDrawnPlantUmlChange, selectedNodeId, selectedRelation, selectedNodeIds, selectedRelations, onToggleNodeClick, onToggleEdgeClick, onMultiSelectStart, onBoxSelect, multiSelectMode]);

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

  // The viewed scale and its mode (see DiagramZoom). Rendering reads it for the
  // toolbar readout and the next attach; the SVG itself is resized imperatively
  // through `viewportRef`, so scaling never re-enters the drawing path.
  const [zoom, setZoom] = useState<DiagramZoom>({ scale: 1, mode: 'fit' });
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
    const semanticBase = viewportRef.current?.semanticBaseSize() ?? null;
    if (semanticBase !== null) return semanticBase;
    return drawing === null ? null : readSvgNaturalSize(drawing);
  }, []);
  const applyZoom = useCallback((next: DiagramZoom): void => {
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
   * The scale to write for a readable decision. Overview is a whole-graph fit,
   * so it is the one that must clear the floating corner chrome; focus is
   * deliberately larger than its box (a pannable, legible crop), where shrinking
   * to avoid a fixed corner would undo the readability the mode exists for.
   */
  const placementForDecision = useCallback(
    (
      natural: SvgViewportSize | null,
      box: SvgViewportSize | null,
      decision: ReadableZoomDecision,
    ): SvgFitPlacement | null => (
      decision.mode === 'overview' && natural !== null && box !== null
        // The placement clears the chrome by TRANSLATING the drawing first and
        // only shrinking when no translation can. Returning the offset is what
        // lets a centred fit that is merely clipped in one corner stay at full
        // size instead of shrinking symmetrically.
        ? fitPlacementAvoidingCorners(natural, box, cornerRects(), MIN_ZOOM_SCALE)
        : null
    ),
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
    const fitToFrame = Math.min(
      (box.width * 0.9) / frame.width,
      (box.height * 0.9) / frame.height,
    );
    const scale = clampZoomScale(Math.max(fitToFrame, MIN_READABLE_ZOOM_SCALE));
    const applied = viewport.zoomTo(scale);
    applyZoom({ scale: applied, mode: 'custom' });
    // The fit placement pins explicit margins; a zoomed package is centred by
    // the scroll offsets below instead, so hand the drawing back to `auto`.
    applyPlacement(host.querySelector('svg'), null);
    if (semanticCaptureRef.current !== null) {
      // The geometry is about to be rewritten for the new scale; apply it now
      // (the debounced pass would otherwise fire 200 ms later) and let the
      // semantic pass centre the requested frame once it has the mapped rect.
      centerPackageOnApplyRef.current = packageId;
      applyLodRef.current?.(applied);
      setPackageFocus(packageId);
      return;
    }
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

  // The readable default applied to the drawing on screen: focus or overview,
  // the package focus centres, and the overview hint (if any). Rendering reads
  // it for the toolbar toggle and the two notice lines; the SCALE itself lives
  // in `zoom`, because it is the same value the +/- controls manipulate.
  const [readableView, setReadableView] = useState<ReadableView | null>(null);
  // The user's EXPLICIT toolbar choice, remembered per project. `null` means
  // "nothing chosen yet": the drawing then opens at the whole-graph overview.
  // A new view/drawing does not invent a choice — it re-reads this project's
  // remembered one, so the reader's Focus survives a reload and never leaks
  // into another project.
  const [readableMode, setReadableMode] = useState<ReadableZoomMode | null>(
    () => readStoredReadableMode(localReadableStorage(), projectId),
  );
  const readableModeRef = useRef<ReadableZoomMode | null>(readableMode);
  // Switching projects switches which remembered choice applies. The effect is
  // keyed on the project id only: an in-visit choice is already in state.
  useEffect(() => {
    const remembered = readStoredReadableMode(localReadableStorage(), projectId);
    readableModeRef.current = remembered;
    setReadableMode(remembered);
  }, [projectId]);
  // The seed hierarchy of the payload on screen, so a resize or a mode switch
  // can re-decide the focus without rebuilding the tree.
  const seedHierarchyRef = useRef<ArchitectureHierarchyIndex | null>(null);
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
  // The settled-zoom application, reachable from `zoomToPackage` (defined
  // above it) so the "tap a package" gesture rewrites and centres in one go.
  const applyLodRef = useRef<((scale: number) => void) | null>(null);
  const lodSchedulerRef = useRef<ExplosionLodScheduler | null>(null);
  const [lodDepth, setLodDepth] = useState<0 | 1 | 2 | null>(null);
  // Bumped whenever the semantic pass rewrites the geometry, so the minimap
  // re-reads its boxes instead of blitting the previous scale's bitmap.
  const [drawnRevision, setDrawnRevision] = useState(0);

  // Re-evaluate the semantic layout after the zoom settles; the previous tier
  // is passed so the 8 % dead band applies at the boundary.
  const applyLod = useCallback((scale: number): void => {
    const host = hostRef.current;
    const capture = semanticCaptureRef.current;
    if (host === null || capture === null) return;
    const box = measureViewportSize(host);
    const layout = solveSemanticZoom(capture.geometry, {
      scale,
      viewport: box,
      previousTier: semanticTierRef.current,
      minFontPx: coarsePointerRef.current ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX,
    });
    semanticTierRef.current = layout.tier;
    appliedLayoutRef.current = layout;
    appliedFontRef.current = coarsePointerRef.current ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX;
    drawSemanticLayout(
      host,
      capture,
      layout,
      coarsePointerRef.current ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX,
    );
    // A rewritten SVG is a fresh set of elements: re-pin the selection and the
    // unselectable declaration, exactly as the render effect does.
    applySelectionStyles(host, selectedNodeIdsRef.current, selectedRelationsRef.current);
    highlightSelection(host, selectedRef.current);
    markDrawingUnselectable(host);
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
  }, []);
  applyLodRef.current = applyLod;
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
      onZoom: (scale) => applyZoom({ scale, mode: 'custom' }),
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
  // The drawing the LOD level belongs to, so an aspect re-layout of the SAME
  // view carries the current level and focus over instead of re-deriving them.
  const drawnKeyRef = useRef<string | null>(null);
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
    // A pending application belongs to the drawing being replaced; the new one
    // is applied synchronously below.
    lodSchedulerRef.current?.cancel();
    setFailure(null);
    hoverCallbackRef.current?.(null);
    // A NEW view keeps the reader's remembered choice: it is an explicit
    // preference for this project, not a property of one drawing. Re-read it so
    // a change made in another tab (or another project) is honoured.
    if (drawingKeyOf(view) !== drawnKeyRef.current) {
      const remembered = readStoredReadableMode(localReadableStorage(), projectId);
      readableModeRef.current = remembered;
      setReadableMode(remembered);
    }
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
        const engine = createLayoutEngine({ aspectRatio: drawnAspect, Engine: ElkLayoutEngine });
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
        const renderStartedAt = performance.now();
        const detailed = await renderDetailed(
          // The document the reader copies uses real stereotypes
          // (`class "X" as n0 <<function>>`); the bundled parser needs that
          // token before the alias, so the DRAWING gets the parser-safe
          // spelling. `standardiseDrawnStereotypes` reverses it when the drawn
          // model is serialized for the text page.
          parserSafePlantUml(diagram.puml),
          rendererOptionsFor(view, diagram, engine),
        );
        const elapsedMs = Math.round(performance.now() - renderStartedAt);
        if (cancelled) return;

        const { svg, model } = detailed;
        // The geometry the renderer used, kept for consumers that would rather
        // read rectangles than reverse-engineer the SVG (not yet wired).
        drawnLayoutRef.current = detailed.layout;
        host.innerHTML = svg;
        setLayoutMs(elapsedMs);
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
        viewportForMode?.setSemanticMode(capture?.baseSize ?? null);
        applySelectionStyles(host, selectedNodeIdsRef.current, selectedRelationsRef.current);
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
        let drawnScale = zoomRef.current.scale;
        let readout: ReadableView | null = null;
        let matchReading: ReadableZoomDecision | null = null;
        if (drawing !== null && viewport !== null) {
          viewport.attach(drawing);
          const seedHierarchy = buildSeedHierarchy(graph, idShape);
          seedHierarchyRef.current = seedHierarchy;
          const natural = naturalOfDrawing(drawing);
          const box = measureViewportSize(host);
          const fitScale = natural !== null && box !== null
            ? fitZoomScale(natural, box, MIN_ZOOM_SCALE)
            : 1;
          const decision = decideReadableZoom({
            fitScale,
            natural: natural ?? { width: 0, height: 0 },
            viewport: box,
            hierarchy: seedHierarchy,
            selectedEntityIds: [
              selectedRef.current,
              view.kind === 'neighborhood' ? view.entityId : null,
            ],
            mode: readableModeRef.current ?? undefined,
          });
          // A canvas several times wider than its container is a band, not a
          // diagram: collapse it to the directory overview and say so. Only the
          // file graph's explosion view can reach this — its overview is the
          // coarser drawing. The class view has NO coarser drawing to fall back
          // to (its overview is the same entity document), so it keeps the
          // hierarchy and lets the readable focus place a legible region.
          if (view.kind === 'hierarchy' && !entityGraph && decision.collapsedForAspect) {
            setCollapsedNotice(true);
            setView({ kind: 'overview' });
          } else if (view.kind === 'hierarchy') {
            setCollapsedNotice(false);
          }
          const placement = placementForDecision(natural, box, decision);
          drawnScale = viewport.zoomTo(placement?.scale ?? decision.scale);
          applyPlacement(drawing, placement);
          applyZoom({ scale: drawnScale, mode: zoomRef.current.mode });
          readout = {
            mode: decision.mode,
            focusPackageId: decision.focusPackageId,
            hint: decision.overviewHint,
          };
          setReadableView(readout);
          // A fresh drawing is a new whole-graph view; a package zoom from the
          // previous one no longer names a frame on screen.
          setPackageFocus(null);
          matchReading = decision;
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
        // never flashes at the wrong detail before the debouncer fires. A
        // re-layout of the SAME view (the container's shape changed) is not a
        // new drawing in the reader's eyes: keep the tier they were reading.
        // Any other drawing derives the tier from the fresh fit scale.
        const drawingKey = drawingKeyOf(view);
        const carriedTier = drawingKey === drawnKeyRef.current ? semanticTierRef.current : null;
        drawnKeyRef.current = drawingKey;
        if (capture === null) {
          semanticTierRef.current = null;
          appliedLayoutRef.current = null;
          setLodDepth(null);
        } else {
          semanticTierRef.current = carriedTier;
          const layout = solveSemanticZoom(capture.geometry, {
            scale: drawnScale,
            viewport: measureViewportSize(host),
            previousTier: carriedTier,
            minFontPx: coarsePointer ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX,
          });
          semanticTierRef.current = layout.tier;
          const fontPx = coarsePointer ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX;
          appliedLayoutRef.current = layout;
          appliedFontRef.current = fontPx;
          drawSemanticLayout(host, capture, layout, fontPx);
          applySelectionStyles(host, selectedNodeIdsRef.current, selectedRelationsRef.current);
          highlightSelection(host, selectedRef.current);
          markDrawingUnselectable(host);
          if (neighborCenterRef.current !== null) {
            nodeElement(host, neighborCenterRef.current)?.classList.add('arch-center');
          }
          setLodDepth(lodDepthForTier(layout.tier));
          setDrawnRevision((revision) => revision + 1);
          const hostWidth = host.clientWidth;
          const hostHeight = host.clientHeight;
          if (hostWidth > 0 && hostHeight > 0) {
            host.scrollLeft = Math.max(0, layout.anchor.x - hostWidth / 2);
            host.scrollTop = Math.max(0, layout.anchor.y - hostHeight / 2);
          }
        }
        // The readable default's focus jump runs AFTER the LOD application:
        // the LOD only recentres on a level cross, so this is the one scroll
        // that places a freshly focused package after a new drawing.
        if (matchReading !== null && matchReading.mode === 'focus' && readout !== null && readout.focusPackageId !== null) {
          centerOnPackage(host, readout.focusPackageId);
        }
        // A focus request (search hit) is centred LAST, after the readable
        // default's package jump: the reader asked for THIS node, so it wins.
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
    };
  }, [applyPlacement, applyZoom, coarsePointer, entityGraph, focusNodeId, graph, idShape, layoutAspect, naturalOfDrawing, placementForDecision, projectId, view]);

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

      // At the package level the drawing is a map of frames, not selectable
      // entities: a click on one zooms into it — the "tap a package" gesture
      // the too-small overview hint offers, on every pointer tier. This runs
      // before the background-clear branch because a frame carries no
      // `data-entity-id` of its own.
      if (semanticTierRef.current === 'C') {
        const frame = event.target instanceof Element
          ? event.target.closest('.uml-package[data-package-id]')
          : null;
        const packageId = frame?.getAttribute('data-package-id') ?? null;
        if (packageId !== null) {
          zoomToPackage(packageId);
          return;
        }
      }

      // A relation's enlarged hit band sits ON TOP of the drawing, so it is
      // checked before the node lookup: clicking a line selects the relation,
      // not whatever box the line starts on.
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

      const id = nodeFrom(event.target)?.getAttribute('data-entity-id') ?? null;
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
        mode: 'custom',
      });
    };

    // `passive: false` is needed because a passive wheel listener may not call
    // preventDefault — without it the browser's own page zoom would also fire.
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  // A fit diagram follows the container; a manually zoomed one keeps the size
  // the user chose. The scale is compared before writing state so a burst of
  // observer callbacks cannot re-render in a loop.
  //
  // The same observer is where a SHAPE change is noticed: a resize that only
  // re-fits is cheap, but one that turns the container landscape/portrait makes
  // the drawing's proportions wrong, which only a new layout fixes. That path is
  // behind `shouldRelayoutForAspect`'s threshold and a debounce, so a drag pays
  // for one layout, not one per frame.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      const measured = measureLayoutAspect(host);
      if (shouldRelayoutForAspect(drawnAspectRef.current, measured, { locked: relayoutLockedRef.current }) && measured !== null) {
        scheduleAspectRelayout(measured);
      }
      if (zoomRef.current.mode !== 'fit') return;
      const viewport = viewportRef.current;
      if (viewport === null) return;
      const drawing = host.querySelector('svg');
      const natural = naturalOfDrawing(drawing);
      const box = measureViewportSize(host);
      if (natural === null || box === null) return;
      const currentView = viewRef.current;
      const decision = decideReadableZoom({
        fitScale: fitZoomScale(natural, box, MIN_ZOOM_SCALE),
        natural,
        viewport: box,
        hierarchy: seedHierarchyRef.current,
        selectedEntityIds: [
          selectedRef.current,
          currentView.kind === 'neighborhood' ? currentView.entityId : null,
        ],
        mode: readableModeRef.current ?? undefined,
      });
      // A container that shrinks can cross the readable floor, which must move
      // the drawing from overview to focus (and back on growth), so the mode is
      // re-decided here rather than frozen at the drawing's first fit.
      setReadableView((current) => (
        current !== null
          && current.mode === decision.mode
          && current.focusPackageId === decision.focusPackageId
          && current.hint?.packageId === decision.overviewHint?.packageId
          && current.hint?.packageCount === decision.overviewHint?.packageCount
          && current.hint?.zoomPercent === decision.overviewHint?.zoomPercent
          ? current
          : { mode: decision.mode, focusPackageId: decision.focusPackageId, hint: decision.overviewHint }
      ));
      const placement = placementForDecision(natural, box, decision);
      const scale = viewport.zoomTo(placement?.scale ?? decision.scale);
      applyPlacement(drawing, placement);
      if (Math.abs(scale - zoomRef.current.scale) < 1e-6) return;
      applyZoom({ scale, mode: 'fit' });
    });
    observer.observe(host);
    // The corner chrome is measured by the fit, and the minimap mounts a beat
    // after the drawing does (it needs the drawn node rectangles). Observing
    // the overlay column re-runs the fit once that chrome has a size, so the
    // overview clears the map as well as the zoom cluster.
    const overlays = host.parentElement?.querySelector<HTMLElement>('[data-architecture-canvas-overlays]');
    if (overlays !== undefined && overlays !== null) observer.observe(overlays);
    return () => observer.disconnect();
  }, [applyPlacement, applyZoom, naturalOfDrawing, placementForDecision, scheduleAspectRelayout]);

  // The zoom is read through `zoomRef` when the debounced application runs, so
  // a burst of wheel/resize updates coalesces into one visibility toggle rather
  // than walking every intermediate level.
  useEffect(() => {
    const scheduler = lodSchedulerRef.current;
    if (scheduler === null) return;
    scheduler.request(() => applyLod(zoomRef.current.scale));
  }, [applyLod, zoom.scale]);

  const zoomToScale = (scale: number): void => {
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.zoomTo(scale) ?? scale, mode: 'custom' });
  };

  const zoomByStep = (factor: number): void => {
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.zoomBy(factor) ?? 1, mode: 'custom' });
  };

  /** Re-apply the readable mode's scale to the drawing already on screen. */
  const applyReadableMode = useCallback((mode: ReadableZoomMode): void => {
    readableModeRef.current = mode;
    setReadableMode(mode);
    setPackageFocus(null);
    // The toolbar click is the EXPLICIT choice this project remembers; an
    // automatic default is never written here.
    writeStoredReadableMode(localReadableStorage(), projectId, mode);
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) return;
    const drawing = host.querySelector('svg');
    const natural = naturalOfDrawing(drawing);
    const box = measureViewportSize(host);
    if (natural === null || box === null) return;
    const currentView = viewRef.current;
    const decision = decideReadableZoom({
      fitScale: fitZoomScale(natural, box, MIN_ZOOM_SCALE),
      natural,
      viewport: box,
      hierarchy: seedHierarchyRef.current,
      selectedEntityIds: [
        selectedRef.current,
        currentView.kind === 'neighborhood' ? currentView.entityId : null,
      ],
      mode,
    });
    const placement = placementForDecision(natural, box, decision);
    applyZoom({ scale: viewport.zoomTo(placement?.scale ?? decision.scale), mode: 'fit' });
    applyPlacement(drawing, placement);
    setReadableView({
      mode: decision.mode,
      focusPackageId: decision.focusPackageId,
      hint: decision.overviewHint,
    });
    if (decision.mode === 'focus' && decision.focusPackageId !== null) {
      centerOnPackage(host, decision.focusPackageId);
    }
  }, [applyPlacement, applyZoom, naturalOfDrawing, placementForDecision, projectId]);

  const fitDiagram = (): void => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    // A fit is the whole-graph reading: the package zoom the hint offered is
    // over, and its row must not keep asking the reader to go back.
    setPackageFocus(null);
    if (host === null || viewport === null) {
      applyZoom({ scale: 1, mode: 'fit' });
      return;
    }
    // "Fit to view" follows the readable mode in force: the whole-graph fit in
    // overview, the readable fit (plus its focus) in focus mode.
    const drawing = host.querySelector('svg');
    const natural = naturalOfDrawing(drawing);
    const box = measureViewportSize(host);
    if (natural === null || box === null) {
      applyZoom({ scale: viewport.fit(), mode: 'fit' });
      return;
    }
    const currentView = viewRef.current;
    const decision = decideReadableZoom({
      fitScale: fitZoomScale(natural, box, MIN_ZOOM_SCALE),
      natural,
      viewport: box,
      hierarchy: seedHierarchyRef.current,
      selectedEntityIds: [
        selectedRef.current,
        currentView.kind === 'neighborhood' ? currentView.entityId : null,
      ],
      mode: readableModeRef.current ?? undefined,
    });
    const placement = placementForDecision(natural, box, decision);
    applyZoom({ scale: viewport.zoomTo(placement?.scale ?? decision.scale), mode: 'fit' });
    applyPlacement(drawing, placement);
    setReadableView({
      mode: decision.mode,
      focusPackageId: decision.focusPackageId,
      hint: decision.overviewHint,
    });
    if (decision.mode === 'focus' && decision.focusPackageId !== null) {
      centerOnPackage(host, decision.focusPackageId);
    }
  };

  /**
   * Keyboard navigation once the canvas has focus: arrows pan, `+`/`-` zoom,
   * `0` fits and `1` returns to natural size.
   *
   * The selection keys follow the inspector task: `]`/`[` move a visible cursor
   * through the drawing's node order (wrapping), `Enter` selects the cursor's
   * node, `Alt+Enter` drills into it, and `Escape` — ONLY while something is
   * selected — closes the dock / clears the selection. That Escape branch calls
   * `stopPropagation`, so the chat page's global abort never sees it; with no
   * selection the key keeps its default behaviour. Modified presses are left to
   * the browser and the app's shortcuts (Ctrl/Cmd + key).
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

    if (event.key === ']' || event.key === '[') {
      event.preventDefault();
      const drawnIds = graphRef.current.nodes
        .map((node) => node.id)
        .filter((id) => nodeElement(host, id) !== null);
      const nextId = cycleNodeFocus(drawnIds, keyboardFocusRef.current, event.key === ']' ? 1 : -1);
      if (nextId === null) return;
      keyboardFocusRef.current = nextId;
      for (const element of host.querySelectorAll('.arch-keyboard-focus')) {
        element.classList.remove('arch-keyboard-focus');
        element.removeAttribute('data-architecture-keyboard-focus');
      }
      const focused = nodeElement(host, nextId);
      if (focused !== null) {
        focused.classList.add('arch-keyboard-focus');
        focused.setAttribute('data-architecture-keyboard-focus', 'true');
      }
      host.setAttribute('data-architecture-keyboard-focus-id', nextId);
      return;
    }

    // Space / Shift+Enter toggles the keyboard cursor's node in the selection
    // set; a renderer embedded without a tray keeps the old "select" reading.
    if (event.key === ' ' || event.key === 'Spacebar' || (event.key === 'Enter' && event.shiftKey)) {
      const id = keyboardFocusRef.current;
      if (id === null) return;
      const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      selectedRef.current = id;
      highlightRelations(host, id);
      announceSelection(graphRef.current, id);
      if (toggleNodeCallbackRef.current !== undefined) toggleNodeCallbackRef.current(node);
      else clickCallbackRef.current?.(node);
      return;
    }

    if (event.key === 'Enter') {
      const id = keyboardFocusRef.current;
      if (id === null) return;
      event.preventDefault();
      if (event.altKey) {
        drillInto(id);
        return;
      }
      const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) return;
      selectedRef.current = id;
      highlightRelations(host, id);
      announceSelection(graphRef.current, id);
      clickCallbackRef.current?.(node);
      return;
    }

    if (event.altKey) return;
    switch (event.key) {
      case 'ArrowLeft':
        host.scrollLeft -= KEYBOARD_PAN_STEP;
        break;
      case 'ArrowRight':
        host.scrollLeft += KEYBOARD_PAN_STEP;
        break;
      case 'ArrowUp':
        host.scrollTop -= KEYBOARD_PAN_STEP;
        break;
      case 'ArrowDown':
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
  // The toggle's pressed state follows the user's last explicit choice; before
  // any choice the drawing's own default (readableView) is what is on screen.
  const activeReadableMode: ReadableZoomMode = readableMode ?? readableView?.mode ?? 'overview';
  // What the fit control really does right now. The readable floor raises a
  // geometric fit that would smear the labels, and in that state the control
  // must not claim the whole drawing is on screen (see `fitControlReading`).
  const fitReading = fitControlReading(readableView, zoom.mode);

  /** The 聚焦 / 全貌 switch: focus at the readable floor, or the whole drawing. */
  const readableModeGroup = (
    <span
      role="group"
      aria-label={t('architecture.plantuml.readable.group', { defaultValue: 'Readable zoom mode' })}
      style={{ gap: touchUi ? TOUCH_CONTROL_GAP_PX : 4 }}
      className="flex items-center rounded border border-border/60 p-0.5"
    >
      <button
        type="button"
        aria-pressed={activeReadableMode === 'focus'}
        onClick={() => applyReadableMode('focus')}
        data-architecture-readable-focus-mode="true"
        style={touchTargetStyle}
        className={TOOLBAR_BUTTON_CLASS}
      >
        {t('architecture.plantuml.readable.focus', { defaultValue: 'Focus' })}
      </button>
      <button
        type="button"
        aria-pressed={activeReadableMode === 'overview'}
        onClick={() => applyReadableMode('overview')}
        data-architecture-readable-overview-mode="true"
        style={touchTargetStyle}
        className={TOOLBAR_BUTTON_CLASS}
      >
        {t('architecture.plantuml.readable.overview', { defaultValue: 'Overview' })}
      </button>
    </span>
  );

  /**
   * The tier bar's ONE explanatory sentence. The review found the same reading
   * split across two sentences — a "Readable zoom is on … choose Overview"
   * escape notice and a "Zoom N% · zoom in on <package> and N other
   * package(s)" hint — which could appear together and repeat the tier label
   * a third time. They are merged here, and only the Focus tier shows them:
   * Overview needs no explanation because it already is the whole graph. The
   * percentage is the same `zoom.scale` reading the tier's `zoomReadout`
   * prints, never the decision's unconstrained fit.
   */
  const focusPackage = readableView?.focusPackageId ?? readableView?.hint?.packageId ?? null;
  const readableNotice = collapsedNotice ? (
    <span data-architecture-readable-collapsed="true" className="text-amber-600 dark:text-amber-400">
      {t('architecture.plantuml.readable.collapsed', {
        defaultValue: 'The graph is too wide, so it was collapsed to the directory overview.',
      })}
    </span>
  ) : activeReadableMode === 'focus' ? (
    <span
      data-architecture-readable-focus-summary="true"
      title={focusPackage ?? undefined}
      className="min-w-0 max-w-full truncate"
    >
      {focusPackage === null
        ? t('architecture.plantuml.readable.focusOnly', {
            defaultValue: 'Readable zoom is on — choose Overview to see the whole graph.',
          })
        : t('architecture.plantuml.readable.focusSummary', {
            defaultValue:
              'Readable zoom is on: focused on {{package}} at {{zoom}}% — choose Overview to see the whole graph ({{count}} other package(s)).',
            package: shortPackageName(focusPackage),
            zoom: Math.round(zoom.scale * 100),
            count: readableView?.hint?.packageCount ?? 0,
          })}
    </span>
  ) : null;

  /** The single place the actual scale is stated, so fit (e.g. 42%) and 100% are distinguishable. */
  const zoomReadout = (
    <span data-architecture-zoom-level className="min-w-9 text-center tabular-nums">
      {Math.round(zoom.scale * 100)}%
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

  /**
   * The overview hint: shown while the WHOLE graph is too small to read (the
   * fit / a manual zoom-out below `MIN_USEFUL_OVERVIEW_SCALE`) on any pointer
   * tier, and kept on screen after the reader taps a package so the row carries
   * the way back. Focus mode is a readable crop already, so it never shows one.
   */
  const overviewTooSmall = zoom.scale < MIN_USEFUL_OVERVIEW_SCALE;
  const showOverviewHint = readableView !== null
    && readableView.mode === 'overview'
    && (overviewTooSmall || packageFocus !== null);
  const overviewHintText = packageFocus === null
    ? t('architecture.plantuml.readable.overviewTooSmall', {
        defaultValue: 'Whole graph at {{zoom}}% — tap a package to zoom in',
        zoom: Math.round(zoom.scale * 100),
      })
    : t('architecture.plantuml.readable.focusHint', {
        defaultValue: 'Focused on {{package}}',
        package: shortPackageName(packageFocus),
      });
  // The pill may only cover the drawing where no package tab is painted. It is
  // measured after every commit that can move either side (the drawing was
  // rewritten, the pill's wording changed, or a package zoom re-scrolled).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !showOverviewHint) return;
    positionOverviewHint(host);
  }, [showOverviewHint, drawnRevision, zoom.scale, packageFocus, readableView]);

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
      aria-pressed={fitReading.pressed}
      data-architecture-zoom-fit="true"
      // The honest reading of what this control applies. `zoom-mode` above keeps
      // its existing fit/custom vocabulary; this is the view the fit lands on.
      data-architecture-zoom-fit-mode={fitReading.mode}
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      {/* The scale action is named "Fit", not after the tier it lands on: the
          tier is stated once, by the zoom-tier group above. */}
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

  // The single zoom-tier group. It carries ONE Focus | Overview segmented
  // control plus ONE scale reading — the review found the tier stated three
  // times (a label, the toggle, and a sentence). A breadcrumb appears only
  // from a real drill-down, and the focus explanation only in the Focus tier.
  const zoomTierGroup = (
    <div
      data-architecture-zoom-tier="true"
      role="group"
      aria-label={t('architecture.plantuml.zoomTier', { defaultValue: 'Zoom level' })}
      style={{ gap: touchUi ? TOUCH_CONTROL_GAP_PX : 4 }}
      className="pointer-events-auto flex max-w-full flex-wrap items-center rounded-lg border border-border/60 bg-background/90 p-1 text-[11px] text-muted-foreground shadow-sm"
    >
      {readableModeGroup}
      {zoomReadout}
      {backButton}
      {explosionButton}
      {drillButton}
      {readableNotice}
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
      className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1"
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
      data-architecture-zoom-mode={zoom.mode}
      data-architecture-zoom-scale={zoom.scale}
      data-architecture-lod-depth={lodDepth ?? undefined}
      data-architecture-layout-ms={layoutMs ?? undefined}
      data-architecture-readable-mode={readableView?.mode}
      data-architecture-readable-package={readableView?.focusPackageId ?? undefined}
    >
      <style>{HIGHLIGHT_STYLE}</style>
      <style data-architecture-canvas-selection-style="true">{CANVAS_UNSELECTABLE_STYLE}</style>
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
          role="img"
          aria-label={t('architecture.graphAria', { defaultValue: 'Architecture neighbourhood graph' })}
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
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
          onKeyDown={onCanvasKeyDown}
          data-testid="plantuml-host"
          data-architecture-plantuml="true"
        />
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
          // The arrangement is stated inline rather than in utility classes:
          // "one absolute column, positive gap, map before cluster" is what
          // makes the two boxes unable to intersect, and a test can read it
          // without a laid-out browser (the same reason the zoom targets carry
          // inline sizes).
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            display: 'flex',
            // A phone spends one ROW on the corner chrome: the collapsed
            // minimap button and the zoom cluster sit side by side, bottom
            // aligned, so the pair takes ~52px of height instead of a 204px
            // column covering the drawing's right edge. The fine-pointer tier
            // keeps its stacked column.
            flexDirection: touchUi ? 'row' : 'column',
            alignItems: 'flex-end',
            rowGap: 8,
            columnGap: touchUi ? 8 : 0,
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
            // compact vertical cluster beside the drawing.
            style={{
              gap: touchUi ? TOUCH_CONTROL_GAP_PX : 4,
              flexDirection: touchUi ? 'row' : 'column',
              height: touchUi ? '52px' : undefined,
            }}
            className={`pointer-events-auto flex items-center rounded-lg border border-border/60 bg-background/90 shadow-sm ${touchUi ? 'p-0' : 'flex-col p-1'}`}
          >
            {zoomInButton}
            {zoomOutButton}
            {fitButton}
            {/* The cluster states the same scale reading as the tier bar above
                the canvas: both are `zoom.scale`, so a reader never sees two
                percentages for one drawing. */}
            <span
              data-architecture-zoom-cluster-level="true"
              className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
            >
              {Math.round(zoom.scale * 100)}%
            </span>
            {lodDepth !== null && (
              <span data-architecture-lod-label className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                {lodDepth === 2
                  ? t('architecture.plantuml.lod.tierNames', { defaultValue: 'Names' })
                  : lodDepth === 1
                    ? t('architecture.plantuml.lod.tierFrames', { defaultValue: 'Frames' })
                    : t('architecture.plantuml.lod.tierPackages', { defaultValue: 'Packages' })}
              </span>
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
