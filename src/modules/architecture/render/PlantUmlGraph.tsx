import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { DEFAULT_NODE_ID_SHAPE } from '@/modules/architecture/dom/adaptiveGrouping';
import { ArchitectureMinimap } from '@/modules/architecture/render/ArchitectureMinimap';
import {
  BOTTOM_SLOT_GAP_PX,
  bottomCornerLayout,
  overlayLayoutDefect,
} from '@/modules/architecture/dom/bottomSlotLayout';
import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
  parserSafePlantUml,
  type ArchitectureDiagramView,
} from '@/modules/architecture/layout/archguardToPlantUml';
import { standardiseDrawnStereotypes } from '@/modules/architecture/layout/plantUmlText';
import {
  createLayoutEngine,
  type ArchitectureLayoutEngineClass,
} from '@/modules/architecture/layout/elkAspectEngine';
import {
  graphFingerprint,
  type LayoutOrientation,
} from '@/modules/architecture/dom/layoutOrientation';
import {
  solveFitArea,
  semanticContentBounds,
  type FitAreaRect,
  type FitOverlayRect,
  type SemanticZoomLayout,
} from '@/modules/architecture/layout/semanticZoomLayout';
import {
  createGraphLayoutPipeline,
  LAYOUT_STATUS_THRESHOLD_MS,
  type GraphLayoutCommit,
} from '@/modules/architecture/layout/graphLayoutPipeline';
import { capDrawnMemberRows, drawnFitScaleOf } from '@/modules/architecture/layout/drawnFit';
import {
  SEMANTIC_MIN_FONT_MOBILE_PX,
  SEMANTIC_MIN_FONT_PX,
} from '@/modules/architecture/dom/semanticZoomPlan';
import {
  PORTRAIT_CONTROL_BAND_PX,
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useCanvasHeaderSlot,
  useCompactToolbarSlot,
  useTouchLayout,
  ZOOM_CLUSTER_TARGET_STYLE,
} from '@/modules/architecture/hooks/useTouchLayout';
import { canvasIsTooWide } from '@/modules/architecture/layout/readableZoom';
import type {
  ArchitectureDiffHighlight,
  ArchitectureRendererEdge,
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/dom/rendererContract';
import {
  moveEntityFocus,
  PACKAGE_NAV_PREFIX,
  type EntityNavigationDirection,
  type EntityNavigationItem,
} from '@/modules/architecture/dom/entityNavigation';
import { createGraphGestureController } from '@/modules/architecture/dom/graphGestureController';
import { createGraphSelectionController } from '@/modules/architecture/dom/graphSelectionController';
import {
  createGraphViewportController,
  type GraphZoom,
} from '@/modules/architecture/layout/graphViewportController';
import {
  selectionsIntersectingBox,
  type ArchitectureSelection,
} from '@/modules/architecture/dom/selectionModel';
import {
  centerElementInContainer,
  centeredScrollForDrawingRect,
  clampZoomScale,
  createSvgDragPan,
  createSvgTouchGestures,
  createSvgViewport,
  fitAreaInsets,
  fitPlacementAvoidingCorners,
  applyZoomScale,
  measureHostSize,
  measureViewportSize,
  MIN_READABLE_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  readSvgNaturalSize,
  ZOOM_STEP,
  type SvgCornerRect,
  type SvgFitPlacement,
  type SvgViewportSize,
} from '@/modules/architecture/layout/svgViewport';
import {
  ENTITY_HIGHLIGHT_EVENT,
  GROUP_PREFIX,
  KEYBOARD_PAN_STEP,
  STUB_PREFIX,
  TOOLBAR_BUTTON_CLASS,
} from '@/modules/architecture/dom/graphConstants';
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
} from '@/modules/architecture/layout/graphDom';
import {
  CANVAS_UNSELECTABLE_STYLE,
  HIGHLIGHT_STYLE,
} from '@/modules/architecture/dom/graphStyles';

/**
 * The marker-anchor geometry lives in `graphDom.ts` with the rest of the
 * drawing helpers; it stays exported from this module because the renderer is
 * where a reader (and the geometry test) expects to find it.
 */
export { markerAnchor } from '@/modules/architecture/layout/graphDom';

export {
  KEYBOARD_A11Y_STORAGE_KEY,
  PLANTUML_MEMBER_DETAIL,
  keyboardA11yDefect,
  pickNavigationStart,
  renderWithMemberDetail,
} from '@/modules/architecture/render/plantUmlNavigation';
export type {
  KeyboardA11yDefect,
  NavigationPoint,
} from '@/modules/architecture/render/plantUmlNavigation';
import type { NavigationPoint } from '@/modules/architecture/render/plantUmlNavigation';
import {
  drawnMemberLimits,
  forcedLayoutOrientation,
  applyDiffStyles,
  pinFocusMarker,
  clearNavigationFocus,
  paintNavigationFocus,
  collectNavigationItems,
  navigationElementOf,
  keyboardA11yDefect,
  pickNavigationStart,
  renderWithMemberDetail,
  farthestNavigationStart,
  navigationDomId,
  normalizedPackageId,
  packageIdOfNodeId,
  DIFF_HIGHLIGHT_STYLE,
  afterPaint,
  layoutSizeOf,
} from '@/modules/architecture/render/plantUmlNavigation';
import { usePlantUmlDrawing } from '@/modules/architecture/render/usePlantUmlDrawing';
import { useCanvasPointerInteractions } from '@/modules/architecture/render/useCanvasPointerInteractions';
import { useCanvasKeyboardNavigation } from '@/modules/architecture/render/useCanvasKeyboardNavigation';
import { useCanvasFitZoom } from '@/modules/architecture/render/useCanvasFitZoom';
import {
  autoFitDisabled,
  forcedDefaultFocus,
  forcedFitCssFactor,
  forcedFullscreenReservedMargins,
  FULLSCREEN_FIT_ROUNDING_ALLOWANCE_PX,
} from '@/modules/architecture/render/plantUmlControlArm';
import { useCanvasDrawingSemantics } from '@/modules/architecture/render/useCanvasDrawingSemantics';
import { useCanvasSurfaceBindings } from '@/modules/architecture/render/useCanvasSurfaceBindings';

/** Kept exported here because this renderer is where the geometry test looks for it. */
export { capDrawnMemberRows };


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
  /**
   * Whether the panel is currently the page-internal fullscreen overlay (not
   * the standalone page, whose Fit must keep the ordinary readings).
   *
   * On the overlay the host IS the viewport, so Fit's available area is the
   * host less the measured chrome painted over it — the non-fullscreen
   * reserved margin (the host's own padding) must not be carried over.
   */
  readonly fullscreen?: boolean;
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
  fullscreen = false,
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
  // The semantic layout runs from imperative callbacks; the pointer tier that
  // picks the minimum font size is read from the gesture owner at call time
  // (`isCoarsePointer()`), which is what the mirrored ref used to provide.
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
  // Gestures are ONE owned slice. The ten callback slots this component used to
  // mirror into refs are now a single `setHandlers` write path, and the marquee
  // rectangle, the Shift reading, the touch multi-select mode and the one-click
  // suppression live in the controller (see `graphGestureController.ts`). Its
  // DOM measurements are injected so the rules are testable without React.
  const gestureController = useMemo(() => createGraphGestureController({
    canvasOrigin: () => {
      const rect = hostRef.current?.parentElement?.getBoundingClientRect();
      return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
    },
    boxHitTest: (box) => {
      const host = hostRef.current;
      return host === null ? [] : selectionsIntersectingBox(boxCandidates(host), box);
    },
    nodeHitTest: (clientX, clientY) => {
      const host = hostRef.current;
      return host === null ? null : nearestNodeHitId(host, clientX, clientY);
    },
  }), []);
  const gestureSnapshot = useSyncExternalStore(
    gestureController.subscribe,
    gestureController.getSnapshot,
    gestureController.getSnapshot,
  );
  // Selection and keyboard navigation are ONE owned slice. Every reading the
  // delegated listeners, the async draw and the render need lives in the
  // controller (see `graphSelectionController.ts`); this component renders its
  // snapshot and forwards events. The controller is created once per mount:
  // listeners read `getSnapshot()` at fire time, which is what the mirrored
  // refs used to provide.
  const selectionController = useMemo(() => createGraphSelectionController(), []);
  const selectionSnapshot = useSyncExternalStore(
    selectionController.subscribe,
    selectionController.getSnapshot,
    selectionController.getSnapshot,
  );
  /** Leave the navigation state; the selection and the drawing stay unchanged. */
  const exitEntityNavigation = (host: HTMLElement): void => {
    selectionController.exitNavigation();
    clearNavigationFocus(host);
  };
  const pinnedSet = useMemo(() => new Set(pinnedNodeIds), [pinnedNodeIds]);
  useEffect(() => {
    viewRef.current = view;
    graphRef.current = graph;
    diffHighlightRef.current = diffHighlight;
  }, [view, graph, selectedNodeId, selectedRelation, selectedNodeIds, selectedRelations, diffHighlight]);
  // The one write path that hands the gesture owner the current props: its
  // callbacks, the touch multi-select mode and the pointer tier. Listeners read
  // `getHandlers()` at fire time instead of each mirroring a ref.
  useEffect(() => {
    gestureController.setHandlers({
      onNodeHover,
      onNodeClick,
      onEdgeClick,
      onSelectionClear,
      onEscapeSelection,
      onToggleNodeClick,
      onToggleEdgeClick,
      onMultiSelectStart,
      onBoxSelect,
      onDrawnChange: onDrawnPlantUmlChange,
    });
    gestureController.setMultiSelectMode(multiSelectMode);
    gestureController.setCoarsePointer(coarsePointer);
  }, [gestureController, coarsePointer, multiSelectMode, onNodeHover, onNodeClick, onEdgeClick, onSelectionClear, onEscapeSelection, onDrawnPlantUmlChange, onToggleNodeClick, onToggleEdgeClick, onMultiSelectStart, onBoxSelect]);

  /**
   * Paint the panel's selection AND publish it as a `data-*` state. The class
   * (`.arch-selected`) is the style; the attribute is the state the keyboard
   * focus reading (`data-architecture-nav-focus`) is distinguishable from — a
   * different class AND a different data attribute for each.
   */
  const paintSelectionStyles = (
    host: HTMLElement,
    nodeIds: readonly string[],
    relations: readonly { readonly from: string; readonly to: string }[],
  ): void => {
    applySelectionStyles(host, nodeIds, relations);
    for (const marked of host.querySelectorAll('[data-architecture-selected]')) {
      marked.removeAttribute('data-architecture-selected');
    }
    for (const selected of host.querySelectorAll('.arch-selected')) {
      selected.setAttribute('data-architecture-selected', 'true');
    }
  };

  // Repaint the selection whenever the panel changes it. The draw effect below
  // applies the same styles to a fresh SVG; this one covers a selection made
  // without a re-layout. The whole set is styled; `selectedNodeId` stays the
  // primary reading the pinned highlight and Delete follow.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const nodeIds = selectedNodeIds ?? (selectedNodeId === null ? [] : [selectedNodeId]);
    const relationList = selectedRelations ?? (selectedRelation === null ? [] : [selectedRelation]);
    selectionController.syncPanelSelection({
      nodeId: selectedNodeId,
      relation: selectedRelation,
      nodeIds,
      relations: relationList,
    });
    paintSelectionStyles(host, nodeIds, relationList);
    if (selectedNodeId !== null) highlightSelection(host, selectedNodeId);
    else if (relationList.length === 0) clearHighlight(host);
  }, [selectedNodeId, selectedRelation, selectedNodeIds, selectedRelations, selectionController]);

  // Tell the panel which slice is on screen. The export menu rebuilds exactly
  // this view; a remount (session/scope change resets `view`) reports the
  // overview again, so the panel never exports a stale drill-down.
  useEffect(() => {
    onViewChange?.(view);
  }, [onViewChange, view]);

  // Zoom, the SVG viewport and the auto-fit rules are ONE owned slice (see
  // `graphViewportController.ts`). This component renders the snapshot and
  // forwards the host's measurements; the owner decides when a resize re-fits,
  // which scale survives a manual zoom, and how a Fit token is answered.
  const viewportController = useMemo(() => createGraphViewportController({
    autoFitDisabled,
  }), []);
  const viewportSnapshot = useSyncExternalStore(
    viewportController.subscribe,
    viewportController.getSnapshot,
    viewportController.getSnapshot,
  );
  const {
    zoom,
    packageFocus,
    fullscreenInsets,
    fitViewport: fitViewportReading,
  } = viewportSnapshot;
  // The semantic tier, the aspect debounce, the orientation cache and the
  // relayout lock are ONE owned slice (see `graphLayoutPipeline.ts`): this
  // component renders its snapshot and supplies the two DOM-bound actions
  // (solve, and write the solved layout) it cannot do itself.
  const layoutPipeline = useMemo(() => createGraphLayoutPipeline(), []);
  const layoutSnapshot = useSyncExternalStore(
    layoutPipeline.subscribe,
    layoutPipeline.getSnapshot,
    layoutPipeline.getSnapshot,
  );
  useEffect(() => () => layoutPipeline.dispose(), [layoutPipeline]);
  // At the package-only tiers the drawing is a map of frames, not selectable
  // entities: clicks zoom into a package and coarse hit rectangles are unused.
  const packageOnlyTier = useCallback(
    (): boolean => {
      const tier = layoutPipeline.getSnapshot().semanticTier;
      return tier === 'C' || tier === 'D';
    },
    [layoutPipeline],
  );
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
    const folded = layoutPipeline.getSnapshot().appliedLayout;
    if (folded !== null && folded.foldDepth !== null) {
      return { width: Math.max(1, folded.content.width), height: Math.max(1, folded.content.height) };
    }
    const semanticBase = viewportController.viewport()?.semanticBaseSize() ?? null;
    if (semanticBase !== null) return semanticBase;
    return drawing === null ? null : readSvgNaturalSize(drawing);
  }, [layoutPipeline, viewportController]);
  /** The one write path for a scale solved by Fit, the semantic engine or a gesture. */
  const applyZoom = useCallback((next: GraphZoom): boolean => viewportController.setZoom(next), [viewportController]);
  /** The owner's reading at call time; async handlers run outside the last render. */
  const controllerZoom = useCallback(
    (): GraphZoom => viewportController.getSnapshot().zoom,
    [viewportController],
  );

  // The package the reader zoomed into from the too-small overview hint (the
  // "tap a package" gesture) lives in the viewport owner's snapshot with the
  // zoom; it keeps the hint row visible and gives that row its action.


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

  // The overlay's measured insets and the box the last Fit solved against are
  // part of the viewport owner's snapshot: the host padding is render output,
  // and `data-architecture-fit-viewport` must state the area the solve used.

  /**
   * The chrome rectangles the overlay paints OVER its viewport-sized host, in
   * the host's border-box coordinates.
   *
   * Measured, never assumed: the toolbar/readout band comes from the panel's
   * own measurement (`topObscuredPx`), the drawer band from
   * `bottomObscuredPx`, and the floating corner slot / selection tray from
   * their live `getBoundingClientRect`. An unlaid-out element (jsdom, a hidden
   * tab) reports a zero-area rect and is dropped, so "not measured" can never
   * read as "covers everything".
   */
  const fullscreenOverlays = useCallback((): FitOverlayRect[] => {
    const host = hostRef.current;
    if (host === null) return [];
    const hostRect = host.getBoundingClientRect();
    const originLeft = hostRect.left + host.clientLeft;
    const originTop = hostRect.top + host.clientTop;
    // The SAME reading the solve uses (`measureHostSize`): the client box when
    // the browser has laid it out, else the rect. Using `clientWidth` directly
    // here would build a zero-wide top band in a host that only reports a rect
    // (jsdom), and `solveFitArea` drops zero-area overlays — the chrome would
    // silently vanish from the deduction.
    const hostSize = measureHostSize(host);
    const width = hostSize?.width ?? 0;
    const height = hostSize?.height ?? 0;
    const rects: FitOverlayRect[] = [];
    if (topObscuredPx > 0) {
      rects.push({ left: 0, top: 0, width, height: Math.min(height, topObscuredPx) });
    }
    if (bottomObscuredPx > 0) {
      rects.push({
        left: 0,
        top: Math.max(0, height - bottomObscuredPx),
        width,
        height: Math.min(height, bottomObscuredPx),
      });
    }
    const canvas = host.parentElement;
    if (canvas !== null) {
      // The panel's provenance footer stays in flow at the bottom of the
      // viewport-sized overlay, so it covers the canvas' bottom band unless it
      // is measured here too (the short landscape tier has none).
      const panel = host.closest('[data-architecture-panel]');
      const elements = [
        ...canvas.querySelectorAll('[data-architecture-canvas-overlays] > *'),
        // The tray ROOT is a `pointer-events: none` container covering the
        // whole canvas; only its visible surfaces (the collapsed pill, the
        // expanded panel, the multi-select bar) are chrome.
        ...canvas.querySelectorAll(
          '[data-architecture-tray-pill], [data-architecture-tray-expanded-panel], '
            + '[data-architecture-multiselect-bar]',
        ),
        ...(panel === null
          ? []
          : [
              ...panel.querySelectorAll('[data-architecture-source-footer]'),
              // On the overlay the fine-pointer Inspector is a floating
              // right-hand column (`absolute inset-y-0 right-0`), not an
              // in-flow dock; it covers the drawing exactly like the corner
              // slot does.
              ...panel.querySelectorAll('[data-architecture-fullscreen-dock]'),
            ]),
      ];
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        rects.push({
          left: rect.left - originLeft,
          top: rect.top - originTop,
          width: rect.width,
          height: rect.height,
        });
      }
    }
    return rects;
  }, [topObscuredPx, bottomObscuredPx]);

  /**
   * The overlay's measured Fit area: the host less its measured chrome. The
   * control-arm lever restores the retired non-fullscreen box instead, so the
   * same reading can be shown landing on its failing side.
   */
  const fullscreenFitArea = useCallback((): FitAreaRect | null => {
    const host = hostRef.current;
    if (host === null) return null;
    const hostSize = measureHostSize(host);
    if (hostSize === null) return null;
    return solveFitArea(hostSize, fullscreenOverlays());
  }, [fullscreenOverlays]);

  /**
   * The box the overlay's Fit solves against.
   *
   * One pixel smaller than the measured area: the semantic writer rounds the
   * mapped extent UP to the next CSS pixel (`Math.ceil`), and the solve itself
   * allows half a pixel of float slack, so a drawing solved exactly to the area
   * can paint one pixel over its edge — under the corner slot. The allowance is
   * not a margin: the published `data-architecture-fit-viewport` states this
   * solve box (one pixel inside the measured area), which is what the criterion
   * compares against.
   */
  const fullscreenFitBox = useCallback((): SvgViewportSize | null => {
    const host = hostRef.current;
    if (host === null) return null;
    if (forcedFullscreenReservedMargins()) return viewportController.lastFlowViewport() ?? measureHostSize(host);
    const area = fullscreenFitArea();
    if (area === null) return null;
    return {
      width: Math.max(1, area.width - FULLSCREEN_FIT_ROUNDING_ALLOWANCE_PX),
      height: Math.max(1, area.height - FULLSCREEN_FIT_ROUNDING_ALLOWANCE_PX),
    };
  }, [fullscreenFitArea, viewportController]);

  /** The reading every Fit/fold/sticky solve measures against. */
  const currentFitViewport = useCallback((host: HTMLElement): SvgViewportSize | null => {
    if (fullscreen) {
      const box = fullscreenFitBox();
      if (box !== null) return box;
    }
    return measureViewportSize(host);
  }, [fullscreen, fullscreenFitBox]);

  /** Publish the box the solve used; the owner ignores an unchanged reading. */
  const recordFitViewport = useCallback((box: SvgViewportSize | null): void => {
    viewportController.reportFitViewport(box);
  }, [viewportController]);

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
    const viewport = viewportController.viewport();
    if (host === null || viewport === null) return;
    const frame = drawnPackageFrame(host, packageId);
    const box = measureViewportSize(host);
    if (frame === null || box === null) return;
    const multiplier = Math.min(
      (box.width * 0.9) / frame.width,
      (box.height * 0.9) / frame.height,
    );
    if (layoutPipeline.getSnapshot().semanticCapture !== null) {
      // The frame's attributes are already in the CURRENT map's screen units,
      // so the multiplier is relative to the scale on screen. The new scale is
      // solved by the same engine as Fit (its floor-font rule keeps every label
      // readable), and the geometry is rewritten now rather than 200 ms later.
      const current = layoutPipeline.getSnapshot().appliedLayout?.scale ?? controllerZoom().scale;
      const solved = clampZoomScale(Math.max(current * multiplier, MIN_ZOOM_SCALE));
      applyZoom({ scale: solved, fit: 'manual' });
      layoutPipeline.requestPackageCenter(packageId);
      layoutPipeline.applySemantic({ fit: false, scale: solved });
      viewportController.setPackageFocus(packageId);
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
    viewportController.setPackageFocus(packageId);
  }, [applyPlacement, applyZoom, controllerZoom, drawingOrigin, viewportController]);

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
    const id = selectionController.getSnapshot().primaryNodeId;
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
    selectionController.focusNode(focusNodeId);
    if (focusDrill) setView({ kind: 'neighborhood', entityId: focusNodeId, hops: DEFAULT_NEIGHBORHOOD_HOPS });
  }, [focusNodeId, focusToken, focusDrill, selectionController]);

  // The semantic write path (per-view resets, the diff repaint and the two
  // layout writers) lives in the drawing-semantics hook.
  const { applySemanticLayout, commitSemantic } = useCanvasDrawingSemantics({
    hostRef,
    view,
    idShape,
    focusNodeId,
    setView,
    diffHighlight,
    diffHighlightRef,
    layoutPipeline,
    layoutSnapshot,
    gestureController,
    selectionController,
    applyZoom,
    paintSelectionStyles,
  });

  // The pipeline action slot, the viewport bindings and the four input
  // families the host binds directly live in the surface-bindings hook.
  useCanvasSurfaceBindings({
    hostRef,
    layoutPipeline,
    viewportController,
    gestureController,
    selectionController,
    commitSemantic,
    applyZoom,
    currentFitViewport,
    recordFitViewport,
    exitEntityNavigation,
  });
  // The panel owns the lock (it knows when a dock/split transition starts); the
  // pipeline owns what the lock suppresses and how lifting it re-bases the
  // container ratio, so the component only forwards the prop.
  useEffect(() => {
    if (relayoutLocked) layoutPipeline.lockRelayout();
    else layoutPipeline.unlockRelayout();
  }, [relayoutLocked, layoutPipeline]);

  // The DOM-bound half of the drawing pipeline lives in
  // `usePlantUmlDrawing`; every reading it writes goes through the owners
  // above, and the hook calls exactly the effect this component used to hold.
  usePlantUmlDrawing({
    hostRef,
    graph,
    view,
    idShape,
    coarsePointer,
    entityGraph,
    focusNodeId,
    layoutPipeline,
    layoutSnapshot,
    gestureController,
    selectionController,
    viewportController,
    diffHighlightRef,
    applyPlacement,
    applyZoom,
    controllerZoom,
    fitPlacementFor,
    naturalOfDrawing,
    paintSelectionStyles,
    setDrawn,
    setFailure,
    setLayoutMs,
    setCollapsedNotice,
    setView,
    applySemanticLayout,
  });

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
  // The reveal-the-selection effect and the delegated pointer listeners:
  // hover, click / double click / context menu, long press and the marquee.
  // The returned ref is re-invoked by the auto-fit observer below.
  const revealSelectedRef = useCanvasPointerInteractions({
    hostRef,
    graphRef,
    selectedNodeId,
    drawnRevision: layoutSnapshot.drawnRevision,
    bottomObscuredPx,
    canCurate,
    packageOnlyTier,
    drillInto,
    zoomToPackage,
    gestureController,
    selectionController,
    onNodeClick,
    onEdgeClick,
    onNodeHover,
    onSelectionClear,
    onToggleNodeClick,
    onToggleEdgeClick,
  });

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
      selectionController.focusNode(id);
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
      if (viewportController.viewport() === null) return;
      // The drawing never scrolls under the wheel any more; the zoom below is
      // the whole response, so the browser's own scroll/page zoom must not run.
      event.preventDefault();
      // deltaMode 1 is lines and 2 is pages; normalise so a mouse wheel and a
      // trackpad zoom at comparable rates.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.0015);
      viewportController.zoomBy(factor, { clientX: event.clientX, clientY: event.clientY });
    };

    // `passive: false` is needed because a passive wheel listener may not call
    // preventDefault — without it the browser's own page zoom would also fire.
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [viewportController]);

  // The auto-fit re-solve, the resize/overlay observers, the toolbar's zoom
  // commands and the explicit whole-graph fit live in the fit/zoom hook.
  const { runAutoFit, zoomToScale, zoomByStep, fitDiagram } = useCanvasFitZoom({
    hostRef,
    graph,
    fullscreen,
    zoom,
    fitRequest,
    layoutPipeline,
    viewportController,
    revealSelectedRef,
    applyPlacement,
    applyZoom,
    controllerZoom,
    fitPlacementFor,
    naturalOfDrawing,
    currentFitViewport,
    recordFitViewport,
    fullscreenOverlays,
    onZoomModeChange,
  });
  // Entity navigation and every canvas shortcut (arrows, Tab, Enter, Escape,
  // Delete, Ctrl/Cmd+Z, zoom keys) live in the keyboard-navigation hook.
  const { onCanvasFocus, onCanvasBlur, onCanvasKeyDown } = useCanvasKeyboardNavigation({
    hostRef,
    graphRef,
    t,
    selectionController,
    selectionSnapshot,
    gestureController,
    pinnedSet,
    exitEntityNavigation,
    drillInto,
    zoomToPackage,
    zoomByStep,
    zoomToScale,
    fitDiagram,
    onNodeClick,
    onToggleNodeClick,
    onEscapeSelection,
    onUndo,
    onPinNode,
    onUnpinNode,
    onRemoveNode,
    onHideRelation,
    drawn,
    drawnRevision: layoutSnapshot.drawnRevision,
  });
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
  const drillNodeId = selectionSnapshot.drillNodeId;
  const selectedPrefix = drillNodeId !== null && drillNodeId.startsWith(GROUP_PREFIX)
    ? drillNodeId.slice(GROUP_PREFIX.length)
    : null;
  const selectionAlreadyOpen = drillNodeId === null
    || (selectedPrefix !== null
      ? view.kind === 'group' && view.prefix === selectedPrefix
      : view.kind === 'neighborhood' && view.entityId === drillNodeId);
  const canDrill = selectionSnapshot.selectedByTouch && drillNodeId !== null && !selectionAlreadyOpen;

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
      data-architecture-layout-direction={layoutSnapshot.layoutDirection ?? undefined}
      data-architecture-layout-direction-reason={layoutSnapshot.layoutDirectionReason ?? undefined}
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
  const portraitClusterCollapsed = portraitPhone && !layoutSnapshot.clusterExpanded && !portraitControlsOverlay;

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
  const foldedDepth = layoutSnapshot.foldDepth;
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
  }, [showOverviewHint, layoutSnapshot.drawnRevision, zoom.scale, packageFocus, foldedDepth]);

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

  // The marquee overlay's rectangle, read from the gesture owner's snapshot
  // (canvas coordinates, so it follows the pointer exactly).
  const marqueeRect = gestureSnapshot.marquee;

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
      data-architecture-semantic-scale={layoutSnapshot.semanticCapture !== null ? displayScale : undefined}
      // The box the last Fit solved against, as `WxH`. On the overlay that is
      // the host less its measured chrome (not the non-fullscreen margin),
      // minus the one pixel the semantic writer rounds up — the reading a
      // criterion compares the drawn size against.
      data-architecture-fit-viewport={fitViewportReading === null
        ? undefined
        : `${Math.round(fitViewportReading.width)}x${Math.round(fitViewportReading.height)}`}
      data-architecture-fold-depth={layoutSnapshot.foldDepth ?? undefined}
      data-architecture-lod-depth={layoutSnapshot.lodDepth ?? undefined}
      data-architecture-layout-ms={layoutMs ?? undefined}
      // The layout readout's direction and reason: WHICH orientation the
      // drawing was laid out in, and why the policy chose it.
      data-architecture-layout-direction={layoutSnapshot.layoutDirection ?? undefined}
      data-architecture-layout-direction-reason={layoutSnapshot.layoutDirectionReason ?? undefined}
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
          role={selectionSnapshot.navigationActive ? 'application' : 'img'}
          aria-label={t('architecture.graphAria', { defaultValue: 'Architecture neighbourhood graph' })}
          aria-activedescendant={
            selectionSnapshot.navigationActive && selectionSnapshot.navigationCursorId !== null
              ? navigationDomId(selectionSnapshot.navigationCursorId)
              : undefined
          }
          // The canvas is its own keyboard target: Tab starts entity navigation
          // on the entity nearest the viewport centre, arrows then move the
          // cursor, `+`/`-` zoom, `0` fits and `1` is natural size (see
          // `onCanvasKeyDown`). The focus cue is the dashed ring drawn around
          // that entity, so the host itself draws no outline: a second blue
          // frame around the whole canvas was the stale focus residue.
          tabIndex={0}
          // The phone tier spends only 4px a side on padding: the task wants
          // the fitted drawing at ≥95% of the canvas width, and a 12px inset
          // already costs 6.5% of a 366px canvas. The fine-pointer tier keeps
          // the roomier p-3.
          className={`h-full w-full overflow-auto outline-none ${fullscreen ? '' : touchUi ? 'p-1' : 'p-3'}`}
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
            // On the overlay the host IS the viewport, and the ONLY ground it
            // loses is the chrome measured over it: the padding is exactly the
            // overlay-free rectangle the Fit solved against (computed by the
            // effect below from `topObscuredPx`/`bottomObscuredPx` and the
            // corner slot's live rects). The non-fullscreen reserved margin
            // (`p-3`/`p-1`) is deliberately NOT carried over — that margin
            // existed for the in-flow layout, and inheriting it is what left
            // the fullscreen drawing small. No overlay measured yet means no
            // padding: the first frame uses the whole host, then settles.
            ...(fullscreen
              ? (fullscreenInsets === null
                  ? {}
                  : {
                      paddingTop: `${fullscreenInsets.top}px`,
                      paddingRight: `${fullscreenInsets.right}px`,
                      paddingBottom: `${fullscreenInsets.bottom}px`,
                      paddingLeft: `${fullscreenInsets.left}px`,
                    })
              : {
                  // The coarse drawer overlays the canvas' bottom band.
                  // Reserving it as padding makes the flex centring use the
                  // area ABOVE the drawer, so a fitted drawing is never
                  // half-hidden behind it. The portrait phone reserves its
                  // collapsible zoom controls' band in the SAME bottom region:
                  // the controls float over the canvas, so the drawing is
                  // fitted ABOVE them instead of under them. The two bands are
                  // measured from the same bottom edge, so they compose as a
                  // maximum rather than a sum — an open drawer already covers
                  // the controls' footprint, and reserving both would lift the
                  // drawing 80px higher than either surface needs. Padding (not
                  // a chrome row) is deliberate — `clientHeight` still counts
                  // it, so the canvas-share reading loses nothing.
                  ...(bottomObscuredPx + portraitControlBandPx > 0
                    ? {
                      paddingBottom: `${(touchUi ? 4 : 12)
                        + Math.max(bottomObscuredPx, portraitControlBandPx)}px`,
                    }
                    : {}),
                  // The standalone page's chrome (toolbar + readout rows) is
                  // drawn OVER its viewport-sized canvas; the in-tab layout
                  // keeps those rows in flow. Reserving the band as padding
                  // makes the flex centring — and `measureViewportSize`'s fit
                  // box — use the area BELOW the chrome.
                  ...(topObscuredPx > 0
                    ? { paddingTop: `${(touchUi ? 4 : 12) + topObscuredPx}px` }
                    : {}),
                }),
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
          onKeyDown={onCanvasKeyDown}
          onFocus={onCanvasFocus}
          onBlur={onCanvasBlur}
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
          {selectionSnapshot.navigationAnnouncement}
        </span>
        {layoutSnapshot.layoutStatusNodes !== null && (
          // An overlay, deliberately: a status drawn in flow would change the
          // canvas' height, and therefore the very fit the drawing after it is
          // laid out for. It sits above the drawing the reader is still looking
          // at, not in place of it — the host keeps the previous SVG until the
          // new one is ready.
          <div
            data-architecture-layout-status={layoutSnapshot.layoutStatusNodes}
            role="status"
            aria-live="polite"
            style={{ position: 'absolute', zIndex: 26, left: 12, top: 12, maxWidth: '78%' }}
            className="pointer-events-none flex items-center gap-2 rounded-md border border-border/60 bg-background/95 px-2 py-1 text-[11px] font-medium text-foreground shadow-sm"
          >
            <span aria-hidden="true" className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
            <span className="min-w-0 truncate">
              {t('architecture.plantuml.layoutProgress', {
                defaultValue: 'Laying out {{count}} entities…',
                count: layoutSnapshot.layoutStatusNodes,
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
        {marqueeRect !== null && (
          <div
            data-architecture-marquee="true"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.width,
              height: marqueeRect.height,
              zIndex: 35,
              pointerEvents: 'none',
              border: '1px dashed #1d4ed8',
              background: 'rgba(29, 78, 216, 0.08)',
            }}
          />
        )}
        {selectionSnapshot.contextMenu !== null && (() => {
          const menu = selectionSnapshot.contextMenu;
          const menuNode = 'nodeId' in menu
            ? graph.nodes.find((candidate) => candidate.id === menu.nodeId) ?? null
            : null;
          const menuEdge = 'edge' in menu ? menu.edge : null;
          const isPinned = menuNode !== null && pinnedSet.has(menuNode.id);
          if (menuNode === null && menuEdge === null) return null;
          return (
            <div
              data-architecture-context-menu="true"
              role="menu"
              aria-label={t('architecture.curation.heading', { defaultValue: 'Adjust' })}
              style={{ position: 'absolute', left: menu.x, top: menu.y, zIndex: 40 }}
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
                        selectionController.closeContextMenu();
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
                        selectionController.closeContextMenu();
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
                      selectionController.closeContextMenu();
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
                        selectionController.closeContextMenu();
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
                        selectionController.closeContextMenu();
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
                    selectionController.closeContextMenu();
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
            revision={`${layoutSnapshot.drawnRevision}:${layoutSnapshot.semanticTier ?? ''}`}
            // In semantic mode the SVG is already sized in mapped screen
            // units, so the drawing's scale is 1 — the non-linear map lives in
            // the geometry, not in the minimap's arithmetic.
            scale={layoutSnapshot.semanticCapture !== null ? 1 : zoom.scale}
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
                onClick={() => layoutPipeline.expandCluster()}
                data-architecture-zoom-cluster-toggle="true"
                // The collapsed form IS the cluster's percentage reading on the
                // portrait tier; state it under the same attribute the expanded
                // span uses so a reading never depends on which form is shown.
                data-architecture-zoom-cluster-level="true"
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
                {layoutSnapshot.lodDepth !== null && (
                  <span data-architecture-lod-label className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                    {layoutSnapshot.lodDepth === 2
                      ? t('architecture.plantuml.lod.tierNames', { defaultValue: 'Names' })
                      : layoutSnapshot.lodDepth === 1
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
                    onClick={() => layoutPipeline.collapseCluster()}
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
