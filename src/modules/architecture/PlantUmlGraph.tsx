import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { DEFAULT_NODE_ID_SHAPE } from '@/modules/architecture/adaptiveGrouping';
import { ArchitectureMinimap } from '@/modules/architecture/ArchitectureMinimap';
import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
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
import type { ArchitectureHierarchyIndex } from '@/modules/architecture/hierarchyIndex';
import {
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
  type ReadableZoomMode,
} from '@/modules/architecture/readableZoom';
import type {
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
import {
  DOUBLE_TAP_MS,
  ENTITY_HIGHLIGHT_EVENT,
  GROUP_PREFIX,
  KEYBOARD_PAN_STEP,
  STUB_PREFIX,
  TOOLBAR_BUTTON_CLASS,
} from '@/modules/architecture/graphConstants';
import {
  annotateNodes,
  addEdgeHitTargets,
  announceSelection,
  applySelectionStyles,
  boxCandidates,
  captureSemanticDrawing,
  centerOnPackage,
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
  type ReadableView,
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

/** The class the keyboard cursor paints on the drawn box it stands on. */
const NAV_FOCUS_CLASS = 'arch-nav-focus';
/** The id prefix the cursor's DOM elements carry, for `aria-activedescendant`. */
const NAV_DOM_ID_PREFIX = 'arch-nav-';
/** How far the focus ring sits outside the box, in SVG user units. */
const NAV_RING_GAP = 2;

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
    // Is this run a re-layout of the SAME drawing (the container's shape
    // changed), rather than a new view/graph? Only the former may keep a
    // reader-chosen scale: a new drawing has its own natural size.
    const viewKey = drawingKeyOf(view);
    const previousLayoutInput = layoutInputRef.current;
    const sameDrawing = previousLayoutInput !== null
      && previousLayoutInput.graph === graph
      && previousLayoutInput.viewKey === viewKey
      && previousLayoutInput.idShape === idShape
      && previousLayoutInput.entityGraph === entityGraph;
    layoutInputRef.current = { graph, viewKey, idShape, entityGraph };
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
        const detailed = await renderWithMemberDetail(
          renderDetailed,
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
        // The semantic base size is the SAME boundary the canvas will draw
        // (`semanticContentBounds`), not the renderer's pre-semantic viewBox:
        // the fit reading and the minimap must measure what is on screen.
        viewportForMode?.setSemanticMode(
          capture === null ? null : semanticContentBounds(capture.geometry),
        );
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
          // An aspect re-layout keeps the scale the reader chose; a new
          // drawing re-derives it from its own natural size. `applyPlacement`
          // still re-centres the drawing inside the new container.
          drawnScale = sameDrawing && zoomRef.current.mode === 'custom'
            ? zoomRef.current.scale
            : viewport.zoomTo(placement?.scale ?? decision.scale);
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
