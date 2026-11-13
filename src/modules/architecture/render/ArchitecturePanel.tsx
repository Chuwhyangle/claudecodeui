import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ArrowLeft, ExternalLink, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PlantUmlGraph } from '@/modules/architecture/render/PlantUmlGraph';
import { ArchitectureCurationManager, type ArchitectureCurationPage } from '@/modules/architecture/render/ArchitectureCurationManager';
import { ArchitectureDock } from '@/modules/architecture/render/ArchitectureDock';
import { ArchitectureInspector } from '@/modules/architecture/render/ArchitectureInspector';
import { ArchitectureRefreshDialog } from '@/modules/architecture/render/ArchitectureRefreshDialog';
import {
  type ArchitectureCurationHiddenEdge,
  type ArchitectureCurationItem,
  type CurationActionResult,
} from '@/modules/architecture/dom/curationStore';
import { createArchitectureCurationController } from '@/modules/architecture/render/architectureCurationController';
import { createArchitectureFilterController } from '@/modules/architecture/render/architectureFilterController';
import {
  createArchitectureSearchController,
  type ArchitectureSearchCommit,
} from '@/modules/architecture/render/architectureSearchController';
import { resolveCurationItems, useProjectSearch } from '@/modules/architecture/hooks/useProjectSearch';
import { ArchitectureSheet } from '@/modules/architecture/render/ArchitectureSheet';
import {
  ArchitectureSelectionTray,
  buildSelectionMessage,
} from '@/modules/architecture/render/ArchitectureSelectionTray';
import { ArchitectureTextPanel } from '@/modules/architecture/render/ArchitectureTextPanel';
import {
  nodeFileOf,
  seedMarkerMode,
  type ArchitectureDiagramView,
} from '@/modules/architecture/layout/archguardToPlantUml';
import {
  ARCHITECTURE_DETAIL_TIERS,
  ARCHITECTURE_SCOPE_MAX,
  ARCHITECTURE_SCOPE_MIN,
  rankArchitectureDetail,
  type ArchitectureDetailTier,
} from '@/modules/architecture/dom/detailRanking';
import { buildFullPlantUmlDocument } from '@/modules/architecture/layout/plantUmlText';
import {
  activeFilterCount,
  applyFilter,
  ARCHITECTURE_ELEMENT_KINDS,
  ARCHITECTURE_RELATION_PRESETS,
  hiddenTotal,
  keptMentionedCount,
  relationsForPreset,
  resetFilter,
  showAllFilter,
  type ArchitectureElementRelationFilter,
  type ArchitectureRelationPreset,
} from '@/modules/architecture/dom/elementRelationFilter';
import {
  architectureExportFilename,
  serializeSvgForExport,
} from '@/modules/architecture/render/exportArtifacts';
import { createArchitectureFitExportController } from '@/modules/architecture/render/architectureFitExportController';
import { BOTTOM_SLOT_INFO_INSET_PX, overlayLayoutDefect } from '@/modules/architecture/dom/bottomSlotLayout';
import {
  CanvasHeaderSlotContext,
  CompactToolbarSlotContext,
  shortTouchDockForm,
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useTouchLayout,
} from '@/modules/architecture/hooks/useTouchLayout';
import { fitToLayoutBudget, LAYOUT_NODE_BUDGET } from '@/modules/architecture/dom/layoutBudget';
import { buildReadout, drawnKindCounts } from '@/modules/architecture/dom/readoutNumbers';
import {
  HOVER_HINT_MARGIN_PX,
  type ArchitectureHintRect,
} from '@/modules/architecture/dom/hoverHintPlacement';
import type {
  ArchitectureDetailReading,
  ArchitectureDiffHighlight,
  ArchitectureEntityKind,
  ArchitectureNodeIdShape,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererHover,
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/dom/rendererContract';
import { readSvgNaturalSize } from '@/modules/architecture/layout/svgViewport';
import {
  createSelectionState,
  reduceSelection,
  resolveDraftScope,
  selectionInScope,
  selectionsInScope,
  type ArchitectureSelection,
  type ArchitectureSelectionScope,
} from '@/modules/architecture/dom/selectionModel';
import {
  formatRefreshElapsed,
  useArchitectureRefresh,
} from '@/modules/architecture/render/useArchitectureRefresh';
import { useArchitectureGraph } from '@/modules/architecture/dom/useArchitectureGraph';
import { useArchitectureFullscreen } from '@/modules/architecture/render/useArchitectureFullscreen';
import {
  buildArchitectureStandaloneHref,
  parseArchitectureDeepLink,
  type ArchitectureDeepLinkState,
} from '@/modules/architecture/render/architectureDeepLink';
import { sendArchitectureChatMessage } from '@/modules/architecture/render/architectureChatBridge';
import { readDraftText, writeDraftText } from '@/shared/api/chatDrafts';
import { formatAbsoluteTime, formatRelativeTime } from '@/shared/utils';
import { ArchitectureEmptyState } from '@/modules/architecture/render/ArchitectureEmptyState';
import { ArchitectureExportMenu } from '@/modules/architecture/render/ArchitectureExportMenu';
import { Tooltip } from '@/shared/ui';
import { CurationToast } from '@/modules/architecture/render/CurationToast';
import { LegendSwatch } from '@/modules/architecture/render/LegendSwatch';
import { useDismissiblePopover } from '@/modules/architecture/render/useDismissiblePopover';
import {
  addHidden,
  EMPTY_HIDDEN,
  truncationReading,
  type ArchitectureGranularity,
} from '@/modules/architecture/layout/panelFilters';
import {
  BROWSER_CURATION_STORAGE,
  BROWSER_PANEL_STORAGE,
  readStoredTouchHintDismissed,
  writeStoredTouchHintDismissed,
} from '@/modules/architecture/layout/panelPersistence';
import { createArchitectureChromeController } from '@/modules/architecture/render/architectureChromeController';
import { ArchitecturePanelShell } from '@/modules/architecture/render/architecturePanelShell';
import { useArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import {
  diffHighlightCounts,
  EMPTY_VIEW_UNRESOLVED_LIMIT,
  MENTIONED_HINT_ID,
  nodeIdShapeOf,
  parseDeepLinkDiffHighlight,
  parseDiffPair,
  readReadoutExpandedInSession,
  READOUT_EXPANDED_SESSION_KEY,
} from '@/modules/architecture/render/architecturePanelShared';



type ArchitecturePanelProps = {
  /** The selected project's DB id; the endpoint resolves it to a project root. */
  projectId: string | null;
  /** The selected session whose transcript supplies the graph's seeds. */
  sessionId: string | null;
  /**
   * The project's display name and the session's title, for the text page's
   * copied header. Optional: a standalone embed falls back to the ids.
   */
  projectName?: string | null;
  sessionTitle?: string | null;
  /**
   * The graph renderer implementation, defaulting to the PlantUML/ELK renderer.
   * Any component implementing the renderer contract can be swapped in here
   * without the panel knowing which library draws the graph; tests pass a
   * stand-in to prove exactly that.
   */
  renderer?: ArchitecturePanelRenderer;
  /**
   * Switches the workspace to the Chat tab. The inspector's mention hits call
   * it after asking the shared locator seam to centre the message; the panel
   * does not know how the chat is implemented.
   */
  onOpenChat?: () => void;
  /**
   * Which subgraph opens first. The shipped default is the class (entity)
   * diagram; sibling callers that want the file graph (and the existing test
   * fixtures that encode file ids) can ask for it explicitly without a toggle.
   */
  initialGranularity?: ArchitectureGranularity;
  /**
   * Render the panel as the standalone page (`/session/:sessionId/architecture`):
   * it fills the viewport, its "Put in chat input" actions travel over the
   * BroadcastChannel instead of writing this page's draft, and the Back entry
   * appears in the toolbar. The workspace passes nothing, so the in-page tab
   * keeps its shipped behavior.
   */
  standalone?: boolean;
  /**
   * The standalone page's "Back to session" action, supplied by the route that
   * owns navigation; the panel only draws the entry.
   */
  onBackToSession?: () => void;
  /**
   * The standalone page's query string (`location.search`). It decides the
   * FIRST paint only; a null/absent value leaves every stored knob in charge.
   */
  deepLinkSearch?: string;
  /**
   * The structural differences an observation tile asked this tab to mark (the
   * wall's architecture preview). A deep link's `diffNode`/`diffEdge`/`diffPkg`/
   * `diffPkgEdge` parameters carry the same set, so a preview can open this page
   * without a caller-side prop. Absent/null leaves the drawing exactly as before.
   */
  diffHighlight?: ArchitectureDiffHighlight | null;
};


/**
 * The renderer plus the two optional focus props this panel adds on top of the
 * shared contract. They stay optional so a stand-in written against
 * `ArchitectureRendererProps` alone is still a valid `renderer`.
 */
type ArchitecturePanelRenderer = ComponentType<
  ArchitectureRendererProps & {
    readonly focusNodeId?: string | null;
    readonly focusToken?: number;
    /** Whether the focus request also opens the node's neighbourhood. */
    readonly focusDrill?: boolean;
    /** Reports the drawn view so the export menu can rebuild that document. */
    readonly onViewChange?: (view: ArchitectureDiagramView) => void;
    /** Manual curation, all optional so a stand-in renderer can ignore them. */
    readonly canCurate?: boolean;
    readonly pinnedNodeIds?: readonly string[];
    readonly onPinNode?: (node: ArchitectureRendererNode) => void;
    readonly onUnpinNode?: (node: ArchitectureRendererNode) => void;
    readonly onRemoveNode?: (node: ArchitectureRendererNode) => void;
    readonly onHideRelation?: (edge: ArchitectureRendererEdge) => void;
    readonly onSoloNode?: (node: ArchitectureRendererNode) => void;
    /** The context menu's "Put in chat input"; the panel composes the message. */
    readonly onPutNodeInChat?: (node: ArchitectureRendererNode) => void;
    readonly onUndo?: () => void;
    /** Multi-select: additive clicks, the marquee, and the whole set's styling. */
    readonly onToggleNodeClick?: (node: ArchitectureRendererNode) => void;
    readonly onToggleEdgeClick?: (edge: ArchitectureRendererEdge) => void;
    readonly onBoxSelect?: (selections: readonly ArchitectureSelection[]) => void;
    readonly onMultiSelectStart?: (node: ArchitectureRendererNode) => void;
    readonly multiSelectMode?: boolean;
    /**
     * Whether the panel is the page-internal fullscreen overlay. The renderer
     * measures the chrome painted over the viewport-sized canvas and fits
     * inside what is left; the standalone page (which shares the full-bleed
     * geometry) keeps the ordinary Fit reading.
     */
    readonly fullscreen?: boolean;
    /**
     * The project whose graph is drawn; the renderer remembers the reader's
     * explicit readable mode per project under it.
     */
    readonly projectId?: string | null;
    /**
     * The coarse drawer's covered band, in CSS pixels: the renderer reserves it
     * so neither a fitted drawing nor the selected box hides behind the drawer.
     */
    readonly bottomObscuredPx?: number;
    readonly selectedNodeIds?: readonly string[];
    readonly selectedRelations?: readonly {
      readonly from: string;
      readonly to: string;
      readonly relationType: string;
    }[];
  }
>;

/**
 * Rendered by WorkspaceMain when the architecture tab is active. It requests the
 * session's neighbourhood on mount (the tab activation) and hands it to the
 * configured renderer through the renderer contract (`rendererContract.ts`) —
 * PlantUML/ELK by default, any other implementation when one is passed. The
 * file/entity switch only picks one of the two subgraphs that already arrived in
 * the same payload, so it must never re-enter the fetch. The scope stepper is
 * the opposite: it is a server-side generation parameter (and part of the
 * result cache's content key), so changing it re-requests the neighbourhood. The
 * detail presets rank the arrived payload locally instead, so they cut the
 * drawing without ever re-entering the fetch. The Mermaid documents stay in hand
 * for the `.mmd` export.
 *
 * Layout: ONE toolbar row, then the drawing. Everything that used to be a
 * second or third row (honesty bar, hover instruction, graph toolbar) is either
 * folded into the panel's overlays on the drawing or removed. The two readings
 * the reader actually asked for live ON the canvas: the one-line "showing N of
 * M" readout at the top-left, and the analysis/seed source line at the
 * bottom-left.
 */
function useArchitecturePanelModel({
  projectId,
  sessionId,
  projectName = null,
  sessionTitle = null,
  renderer: Renderer = PlantUmlGraph as ArchitecturePanelRenderer,
  initialGranularity = 'entity',
  onOpenChat,
  standalone = false,
  onBackToSession,
  deepLinkSearch = '',
  diffHighlight = null,
}: ArchitecturePanelProps) {
  // `i18n` is the readout's locale (locale-aware times); `t` labels both knobs.
  const { t, i18n } = useTranslation();

  // The structural diff the drawing marks: an explicit prop (the wall's preview) or the
  // standalone link's parameters. Absent means no markers and the pre-highlight rendering.
  const deepLinkDiffHighlight = useMemo(
    () => parseDeepLinkDiffHighlight(deepLinkSearch),
    [deepLinkSearch],
  );
  const resolvedDiffHighlight = diffHighlight ?? deepLinkDiffHighlight;

  // The standalone link's readings, captured ONCE: a link decides the first
  // paint, and every later change belongs to the page rather than the address
  // bar (the panel never writes these back).
  const [initialDeepLink] = useState<ArchitectureDeepLinkState>(
    () => parseArchitectureDeepLink(deepLinkSearch),
  );
  // The subgraph the link names, mapped onto the panel's own granularity.
  const deepLinkGranularity: ArchitectureGranularity | null = initialDeepLink.view === null
    ? null
    : initialDeepLink.view === 'file'
      ? 'file'
      : 'entity';

  // The element filter's labels. Each `t()` names its key literally (not a
  // template) so the locale-completeness test extracts every one of them from
  // this source; the noun is lowercase so `{count} {label}` reads correctly and
  // the same string serves the hidden-count line.
  const kindLabel = (kind: (typeof ARCHITECTURE_ELEMENT_KINDS)[number]): string => {
    switch (kind) {
      case 'class':
        return t('architecture.filter.kindClass', { defaultValue: 'classes' });
      case 'interface':
        return t('architecture.filter.kindInterface', { defaultValue: 'interfaces' });
      case 'enum':
        return t('architecture.filter.kindEnum', { defaultValue: 'enums' });
      case 'abstract':
        return t('architecture.filter.kindAbstract', { defaultValue: 'abstract classes' });
      case 'function':
        return t('architecture.filter.kindFunction', { defaultValue: 'functions' });
      default:
        return t('architecture.filter.kindOther', { defaultValue: 'others' });
    }
  };

  const relationPresetLabel = (preset: ArchitectureRelationPreset): string => {
    switch (preset) {
      case 'structural':
        return t('architecture.filter.relationStructural', { defaultValue: 'Structural' });
      case 'dependency':
        return t('architecture.filter.relationDependency', { defaultValue: '+Dependencies' });
      default:
        return t('architecture.filter.relationCall', { defaultValue: '+Calls' });
    }
  };

  const relationTypeLabel = (relationType: string): string => {
    if (relationType === 'dependency') {
      return t('architecture.filter.relDependency', { defaultValue: 'dependency' });
    }
    if (relationType === 'call') return t('architecture.filter.relCall', { defaultValue: 'call' });
    // A type nobody named: print it rather than inventing a category.
    return relationType;
  };

  // The pointer/size tier. On a narrow screen the export action moves into the
  // graph's overflow menu (one menu, not two), and on a coarse pointer every
  // header control grows to a 44px target.
  const { coarsePointer, compactToolbar, portraitPhone, shortTouch } = useTouchLayout();
  // The dock's structural form. On the landscape-phone tier the DEV-only
  // `drawer` override restores the old overlay for the criterion's control arm;
  // every normal render gets the in-flow side column.
  const dockTier: 'desktop' | 'drawer' | 'side' = shortTouch
    ? shortTouchDockForm()
    : coarsePointer
      ? 'drawer'
      : 'desktop';
  const headerButtonClass = coarsePointer
    ? 'rounded-md px-3 text-sm font-medium'
    : 'rounded-md px-2 py-0.5 text-xs font-medium';
  // The explicit 44px box on every compact-row control; on a coarse pointer the
  // reading must not depend on the stylesheet (see TOUCH_TARGET_STYLE).
  const compactTargetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  // The portrait row packs the view switch, Text and Adjust into 390px: the
  // 12px horizontal padding the other compact tiers afford is 8px there, while
  // the 44px hit box stays. Anything wider pushes Adjust off the 390px line.
  const compactHeaderButtonClass = portraitPhone
    ? 'rounded-md px-2 text-sm font-medium'
    : headerButtonClass;
  // ---- Panel chrome (open surfaces, drawer height, layout lock) ------------
  // The owner holds every open/close reading, the coarse drawer's height, the
  // dock's layout-lock window and the two remembered choices (the one-off touch
  // hint, the portrait readout). Viewport readings are callables because they
  // change per event; the ref keeps the owner stable across an orientation
  // change, so a rotation does not reset the dock.
  const portraitPhoneRef = useRef(portraitPhone);
  useEffect(() => {
    portraitPhoneRef.current = portraitPhone;
  }, [portraitPhone]);
  const chrome = useMemo(
    () => createArchitectureChromeController({
      viewport: {
        portraitPhone: () => portraitPhoneRef.current,
        height: () => (typeof window === 'undefined' ? 0 : window.innerHeight),
      },
      persistence: {
        readTouchHintDismissed: readStoredTouchHintDismissed,
        persistTouchHintDismissed: writeStoredTouchHintDismissed,
        readReadoutExpanded: readReadoutExpandedInSession,
        persistReadoutExpanded: (open) => {
          if (typeof window === 'undefined') return;
          try {
            window.sessionStorage.setItem(READOUT_EXPANDED_SESSION_KEY, open ? 'true' : 'false');
          } catch {
            // Private mode: the choice still holds for this mount.
          }
        },
      },
    }),
    [],
  );
  const chromeSnapshot = useSyncExternalStore(
    chrome.subscribe,
    chrome.getSnapshot,
    chrome.getSnapshot,
  );
  const {
    sheetOpen,
    sheetControlsHost,
    canvasHeaderHost,
    touchHintDismissed,
    focusTarget,
    trayExpanded,
    dockOpen,
    dockTab,
    dockLayoutLocked,
    touchDrawerHeight,
    readoutOpen,
    legendOpen,
    unresolvedOpen,
    scopeHygieneOpen,
    topChromePx,
    multiSelectMode,
  } = chromeSnapshot;
  const dismissTouchHint = chrome.dismissTouchHint;
  // The owner releases the layout-lock timer on unmount; StrictMode's
  // teardown-and-reset re-uses the same instance afterwards (dispose is not a
  // kill switch).
  useEffect(() => () => chrome.dispose(), [chrome]);
  // The filter/display owner: which subgraph is on screen, the requested BFS
  // depth and the detail tier, the element/relation filter, the debounced
  // request those selections become, and the filter popover's disclosure. A
  // deep link's `view`/`scope`/`detail` win for this mount; every other reading
  // comes from the project's storage. The controller is recreated on a project
  // switch, so the graph is never requested with the previous project's depth.
  const settings = useMemo(
    () => createArchitectureFilterController({
      storage: BROWSER_PANEL_STORAGE,
      projectId,
      initialGranularity: deepLinkGranularity ?? initialGranularity,
      ...(initialDeepLink.scope === null ? {} : { initialScope: initialDeepLink.scope }),
      ...(initialDeepLink.detail === null ? {} : { initialDetail: initialDeepLink.detail }),
    }),
    [projectId, deepLinkGranularity, initialGranularity, initialDeepLink.scope, initialDeepLink.detail],
  );
  const settingsSnapshot = useSyncExternalStore(
    settings.subscribe,
    settings.getSnapshot,
    settings.getSnapshot,
  );
  const {
    granularity,
    scope,
    detail,
    filter,
    requestFilter,
    requestGranularity,
    filterMenuOpen,
    filterPosition,
    includeToolResults,
  } = settingsSnapshot;
  // The owner clears its pending debounce on unmount; StrictMode's
  // teardown-and-reset re-uses the same instance afterwards (dispose releases
  // timers only, it does not make the controller dead).
  useEffect(() => () => settings.dispose(), [settings]);

  // ---- Manual curation (pins / removals / hidden relations) ----------------
  // The store is per `(project, session)`: the graph's seeds are the session's
  // transcript, so a project has no curation of its own. The controller owns
  // the store instance, the re-anchoring bookkeeping, the manager/solo
  // disclosures and the Toast lifetime; a missing session leaves
  // `canEdit: false`, which disables the whole feature (and says why).
  const curation = useMemo(
    () => createArchitectureCurationController({
      storage: BROWSER_CURATION_STORAGE,
      projectId,
      sessionId,
      resolveItems: resolveCurationItems,
    }),
    [projectId, sessionId],
  );
  const curationSnapshot = useSyncExternalStore(
    curation.subscribe,
    curation.getSnapshot,
    curation.getSnapshot,
  );
  const {
    canEdit: canCurate,
    state: curationState,
    managerOpen: curationManagerOpen,
    soloNodeId,
    toast: curationToast,
    canUndo: curationCanUndo,
  } = curationSnapshot;
  useEffect(() => () => curation.dispose(), [curation]);

  // ---- Search, hover hint and deep-link (owner) ----------------------------
  // The owner holds the query and its ranked matches, the transient active
  // option, the hover dwell and the MEASURED hint position, and the two "only
  // once" rules (the `?entity=` link and the per-analysis re-alignment). The
  // panel subscribes and renders; every decision lives in
  // `architectureSearchController`.
  const search = useMemo(() => createArchitectureSearchController(), []);
  const searchSnapshot = useSyncExternalStore(
    search.subscribe,
    search.getSnapshot,
    search.getSnapshot,
  );
  const {
    query: searchQuery,
    pending: searchPending,
    open: searchOpen,
    activeIndex: activeSearchIndex,
    candidates: searchMatches,
    hover,
    hoverVisible,
    hoverSignature,
    hoverHintPosition,
  } = searchSnapshot;
  // The owner releases its timers on unmount (StrictMode re-uses the instance).
  useEffect(() => () => search.dispose(), [search]);

  // Pins and removals are ENTITY operations: the request takes entity ids,
  // while a file node's id is a path. The file view can still manage/restore
  // the lists, but it is not where an entity gets pinned.
  const canCurateEntities = canCurate && granularity === 'entity';
  const pinnedIds = useMemo(
    () => curationState.pins.map((entry) => entry.id),
    [curationState.pins],
  );
  const excludedIds = useMemo(
    () => curationState.excluded.map((entry) => entry.id),
    [curationState.excluded],
  );
  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  // Hidden relations are keyed by (from, to, type): the same pair can be linked
  // by more than one relation kind, and only the chosen kind disappears.
  const hiddenEdgeKey = (edge: { from: string; to: string; relationType: string }): string =>
    `${edge.from}\u0000${edge.to}\u0000${edge.relationType}`;
  const hiddenEdgeKeys = useMemo(
    () => new Set(curationState.hiddenEdges.map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.type}`)),
    [curationState.hiddenEdges],
  );
  // The disclosure that opened the manager, so Escape can return focus to it.
  const curationManagerButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeCurationManager = useCallback((): void => curation.setManagerOpen(false), [curation]);
  useDismissiblePopover(
    curationManagerOpen,
    closeCurationManager,
    curationManagerButtonRef,
    '[data-architecture-curation-manager]',
  );
  const showCurationToast = useCallback((message: string, undoable = true): void => {
    curation.showToast(message, undoable);
  }, [curation]);
  const dismissCurationToast = useCallback((): void => curation.dismissToast(), [curation]);
  const pauseCurationToast = useCallback((): void => curation.pauseToast(), [curation]);
  const resumeCurationToast = useCallback((): void => curation.resumeToast(), [curation]);

  // Another tab's change to this project's remembered knobs. `storage` fires
  // only in OTHER documents, so applying it here cannot echo back a write this
  // tab just made. Each owner re-reads the keys it is responsible for.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent): void => {
      curation.handleStorageChange(event.key);
      settings.handleStorageChange(event.key);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [curation, settings]);
  // The popover is drawn `position: fixed` on the desktop tier because the
  // toolbar scrolls horizontally and would clip an absolutely positioned panel.
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeFilterMenu = useCallback((): void => settings.closeFilterMenu(), [settings]);
  // Outside-press / Escape dismissal for every panel-owned popover: the menu
  // used to close only by pressing its own trigger again.
  useDismissiblePopover(filterMenuOpen, closeFilterMenu, filterButtonRef, '[data-architecture-filter-menu]');
  // The node under the pointer and its visible relation kinds, as reported by
  // the mounted renderer. Kept renderer-neutral; the key names the graph the
  // reading came from (session + granularity + scope), and the owner discards a
  // hover reported for another graph. The dwell threshold and the measured hint
  // position are owner state too, so a pointer crossing the drawing never
  // flashes a reading.
  const hoverKey = `${sessionId ?? ''}:${granularity}:${scope}`;
  // Stable while the same graph is on screen, so hovering never tears down the
  // renderer's effect; it only changes when the graph itself changes.
  const handleNodeHover = useCallback(
    (reading: ArchitectureRendererHover | null) => search.setHover(hoverKey, reading),
    [hoverKey, search],
  );
  // The hint may not cover the drawing's own labels: package tabs are painted
  // along the top edge of every frame, and class names sit inside them. The
  // candidate walk and the avoidance live in `placeHoverHint` (behind the
  // owner); this effect only turns the live DOM into the rectangles it reads.
  // It runs before paint, so the hint never flashes at the pinned corner first.
  useLayoutEffect(() => {
    if (hoverSignature === null) {
      search.clearHoverHint();
      return;
    }
    const container = search.canvasRegionRef.current;
    const hint = search.hoverHintRef.current;
    if (container === null || hint === null) return;
    const containerBox = container.getBoundingClientRect();
    const hintBox = hint.getBoundingClientRect();
    const rectsOf = (selector: string, root: ParentNode = container): ArchitectureHintRect[] => [...root.querySelectorAll(selector)]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
    search.layoutHoverHint({
      container: {
        left: containerBox.left,
        top: containerBox.top,
        right: containerBox.right,
        bottom: containerBox.bottom,
      },
      hint: { width: hintBox.width, height: hintBox.height },
      // The bottom band's shared slots: the reading must not cover the drawing's
      // own labels, the corner slot (map + zoom controls), the INFO slot's pill,
      // or an open tray/dock that already owns part of the canvas. Every box
      // comes from the live DOM, so this one rule serves all tiers.
      obstacles: [
        // The package tabs (each frame's own `path`) and the class-name text.
        ...rectsOf('.uml-package[data-package-id] > path'),
        ...rectsOf('[data-architecture-node-name]'),
        // The canvas's own corner chrome, for the same reason the fit avoids it.
        ...rectsOf('[data-architecture-minimap]'),
        ...rectsOf('[data-architecture-zoom-cluster]'),
        // The INFO slot's other occupant: the selection pill. Before this, the
        // hint was placed bottom-first straight onto the pill. The DEV control
        // arm removes this obstacle (together with the pill's slot anchor) to
        // restore that defect.
        ...(overlayLayoutDefect() === 'no-slot-layout' ? [] : rectsOf('[data-architecture-tray-pill]')),
        // An expanded tray / open dock is a bottom band of its own; the reading
        // stays above it instead of being painted underneath. The dock is a
        // SIBLING of the canvas region in the panel column, so it is read from
        // the document rather than from inside the container.
        ...rectsOf('[data-architecture-tray-expanded-panel]'),
        ...rectsOf('[data-architecture-dock]', document),
        ...rectsOf('[data-architecture-dock-touch]', document),
      ],
      // The INFO slot's inset, stated once in `bottomSlotLayout`.
      margin: BOTTOM_SLOT_INFO_INSET_PX,
    });
  }, [hoverSignature, search]);
  // The request the server is asked for. `kinds` rides only on the entity view
  // (a file has no element kind); `relations` rides on both views. The
  // "keep mentioned" switches are part of `kinds`' own axis, so they ride only
  // there too — and an empty list is the old request, not a new field.
  const graphQuery = useMemo(
    () => ({
      ...(requestGranularity === 'entity' ? { kinds: requestFilter.kinds } : {}),
      ...(requestGranularity === 'entity' && requestFilter.keepMentionedKinds.length > 0
        ? { keepMentionedKinds: requestFilter.keepMentionedKinds }
        : {}),
      relations: relationsForPreset(requestFilter.relations),
      // An EMPTY curation set is the old request: the server keys on the
      // presence of these fields, and an uncurated session must keep the
      // pre-curation payload byte-identical.
      ...(pinnedIds.length === 0 ? {} : { extraSeeds: pinnedIds }),
      ...(excludedIds.length === 0 ? {} : { excludeIds: excludedIds }),
    }),
    [requestFilter, requestGranularity, pinnedIds, excludedIds],
  );
  const { view, refreshing, reload } = useArchitectureGraph(projectId, sessionId, scope, graphQuery);
  // The payload as it arrived for the current subgraph.
  const rawNeighbourhood = view.status === 'loaded' ? view.result.graph[granularity] : null;
  // The exemptions the filter honours: a direct session seed (stated from the
  // same rule the pure function applies) AND a manual pin. A pin is exempt from
  // the element axis and from the isolated-node cut, exactly like a direct seed
  // — but it stays its own tier in the drawing.
  const filterExemptIds = useMemo(
    () => new Set(
      (rawNeighbourhood?.nodes ?? [])
        .filter((node) => (
          node.mentionTier === 'pinned'
          || (node.distance === 0 && (node.mentionTier === undefined || node.mentionTier === 'direct'))
        ))
        .map((node) => node.id),
    ),
    [rawNeighbourhood],
  );
  // The element axis is the class view's alone; the file view keeps every kind
  // (file nodes carry none) while still honouring the relation/isolated axes.
  const effectiveKinds = granularity === 'entity' ? filter.kinds : ARCHITECTURE_ELEMENT_KINDS;
  const displayFilter = useMemo(
    () => ({
      kinds: effectiveKinds,
      relations: filter.relations,
      hideIsolated: filter.hideIsolated,
      // Also on the file view: a file node carries no kind, so the list is
      // inert there without needing a second filter shape.
      keepMentionedKinds: filter.keepMentionedKinds,
    }),
    [effectiveKinds, filter.relations, filter.hideIsolated, filter.keepMentionedKinds],
  );
  // The filter over the arrived payload. Narrowing is answered here (no
  // round-trip); widening has already been requested by `changeFilter`, which
  // keeps this old drawing on screen until the new reading lands.
  const filteredGraph = useMemo(
    () => (rawNeighbourhood === null ? null : applyFilter(rawNeighbourhood, displayFilter, filterExemptIds)),
    [rawNeighbourhood, displayFilter, filterExemptIds],
  );
  // The filtered subgraph, with a stable identity so the detail ranking (and the
  // renderer below it) only redo work when the graph itself changes — a hover
  // must never re-lay the diagram. Hidden relations are a DISPLAY cut only: the
  // nodes stay, the chosen (from, to, type) edges disappear.
  const activeNeighbourhood = useMemo(
    () => (filteredGraph === null
      ? null
      : {
          nodes: filteredGraph.nodes,
          edges: filteredGraph.edges.filter((edge) => !hiddenEdgeKeys.has(hiddenEdgeKey(edge))),
        }),
    // `hiddenEdgeKeys` is the content digest of the hidden list; the helper is
    // pure, so it needs no dependency of its own.
    [filteredGraph, hiddenEdgeKeys],
  );
  // The drawing's slice: the one-node "只显示它自己" filter (a pinned item's
  // menu action), applied on top of the readings above. Search and the manager
  // still read `activeNeighbourhood` so they can find what is folded away.
  const displayNeighbourhood = useMemo(() => {
    if (activeNeighbourhood === null || soloNodeId === null) return activeNeighbourhood;
    const node = activeNeighbourhood.nodes.find((candidate) => candidate.id === soloNodeId);
    return node === undefined ? activeNeighbourhood : { nodes: [node], edges: [] };
  }, [activeNeighbourhood, soloNodeId]);
  // What to say was hidden: the server counted the request's filter against the
  // UNFILTERED scope; a narrower local selection adds its own extra cut on top.
  const serverHidden = view.status === 'loaded' ? view.result.stats.hidden : undefined;
  const hiddenReading = useMemo(
    () => addHidden(serverHidden ?? EMPTY_HIDDEN, filteredGraph?.hidden ?? EMPTY_HIDDEN),
    [serverHidden, filteredGraph],
  );
  const detailRanking = useMemo(
    () => (displayNeighbourhood === null
      ? null
      : rankArchitectureDetail(displayNeighbourhood.nodes, displayNeighbourhood.edges, detail)),
    [displayNeighbourhood, detail],
  );
  // The two numbers the detail knob reports: retained vs. in-scope (pre-cut).
  const detailReading = useMemo<ArchitectureDetailReading | undefined>(
    () => (detailRanking === null || displayNeighbourhood === null
      ? undefined
      : { shown: detailRanking.retainedNodeIds.size, totalInScope: displayNeighbourhood.nodes.length }),
    [detailRanking, displayNeighbourhood],
  );
  // The control that opened the sheet. Closing the dialog returns focus here.
  const sheetTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The sheet body's DOM node while it is open, and the right-hand cell of the
  // in-flow row above the canvas. Both are renderer portal targets reported to
  // the chrome owner; the owner publishes them with the rest of the surface
  // state (see `sheetControlsHost` / `canvasHeaderHost`).
  // The node the reader asked for is PINNED: the layout budget may cut a large
  // graph down to its most important nodes, and a searched-for node must
  // survive that cut even when its own importance would put it outside it.
  const pinnedNodeIds = useMemo(
    () => (focusTarget === null ? [] : [focusTarget.id]),
    [focusTarget],
  );
  // The ONE selection (an entity, a relation, or nothing) plus the scope it was
  // made in. The scope is part of the state so switching the file/class view or
  // the session clears it in the same transition — no effect can race a render
  // and briefly draw the previous view's inspector.
  const selectionScope = useMemo<ArchitectureSelectionScope>(
    () => ({ projectId, sessionId, view: granularity }),
    [projectId, sessionId, granularity],
  );
  const [selectionState, dispatchSelection] = useReducer(
    reduceSelection,
    selectionScope,
    createSelectionState,
  );
  // The whole selection set, for the tray and the renderer's multi-select
  // styling. `selection` stays the primary (last added) member, which is what
  // the dock inspector and the renderer's pinned highlight read.
  const selections = selectionsInScope(selectionState, selectionScope);
  const selection = selectionInScope(selectionState, selectionScope);
  // The set split into the two shapes the renderer styles and the tray labels.
  const selectedNodeIds = useMemo(
    () => selections.flatMap((entry) => (entry.kind === 'entity' ? [entry.nodeId] : [])),
    [selections],
  );
  const selectedRelations = useMemo(
    () => selections.flatMap((entry) => (entry.kind === 'relation'
      ? [{ from: entry.from, to: entry.to, relationType: entry.relationType }]
      : [])),
    [selections],
  );
  // The multi-select/tray/dock readings below are the chrome owner's: the
  // snapshot destructured at the top of the component is the render side. Its
  // rules — the dock's explicit-vs-selection open, the layout-lock window, the
  // drawer height clamp — live in `architectureChromeController`.
  // The graph the renderer actually receives: the detail tier's cut, then the
  // layout budget's cut. PlantUML/ELK runs on the main thread and its layout
  // cost grows super-linearly with the node count, so an over-budget drawing
  // would freeze the tab; the budget is a local view bound, never a refetch.
  // A pin (and the search's focus target) must survive the layout budget's cut:
  // the reader asked for that node explicitly.
  const layoutPinnedIds = useMemo(
    () => [...new Set([...pinnedNodeIds, ...pinnedIds])],
    [pinnedNodeIds, pinnedIds],
  );
  const layoutFit = useMemo(
    () => (displayNeighbourhood === null
      ? null
      : fitToLayoutBudget(
        displayNeighbourhood.nodes,
        displayNeighbourhood.edges,
        detail,
        LAYOUT_NODE_BUDGET,
        layoutPinnedIds,
      )),
    [displayNeighbourhood, detail, layoutPinnedIds],
  );
  // The one-line readout, legend, unresolved-list and scope-hygiene disclosures
  // are chrome-owner readings (see the snapshot above); the legend's own focus
  // return stays here because it is a DOM gesture, not open/close state.
  // The disclosure that opened the legend, so Escape can return focus to it.
  const legendButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeLegend = useCallback((): void => chrome.closeLegend(), [chrome]);
  useDismissiblePopover(legendOpen, closeLegend, legendButtonRef, '[data-architecture-legend]');
  // The search box's readings (text, open, active option, ranked matches) are
  // the search owner's, destructured above. A press outside the combobox closes
  // it WITHOUT swallowing the press (the listener observes `mousedown`; the
  // click still reaches its target). The earlier contract required a second
  // press on the box itself to close it.
  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      // A press inside the widget (input or an option) is not "outside".
      if (search.isInsideSearchWidget(event.target as Node)) return;
      search.closeList();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [searchOpen, search]);
  // ---- Fit / export / refresh-state / scope readings (owner) ---------------
  // One React-free owner for the panel-level request/answer state: the fit
  // token and its once-per-viewport measurement, the fullscreen enter/leave
  // flag, the export notice and manual-copy fallback, the view and drawn model
  // the export rebuilds, the refresh dialog, and the scope-change disclosure.
  // The panel subscribes and renders; every rule lives in
  // `architectureFitExportController`.
  const readoutRowRef = useRef<HTMLDivElement | null>(null);
  // The DOM hook for the owner's manual-copy text: focusing and selecting it is
  // a presentation effect, not an export rule.
  const copyFallbackTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fitExport = useMemo(
    () => createArchitectureFitExportController({
      measure: () => ({
        canvasHeight: search.canvasRegionRef.current?.getBoundingClientRect().height ?? 0,
        windowHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
        chromeBottom: readoutRowRef.current?.getBoundingClientRect().bottom ?? 0,
      }),
      reportTopChrome: (pixels) => chrome.reportTopChrome(pixels),
    }),
    [chrome],
  );
  const fitExportSnapshot = useSyncExternalStore(
    fitExport.subscribe,
    fitExport.getSnapshot,
    fitExport.getSnapshot,
  );
  // The view the mounted renderer is drawing (`diagramView`) is the owner's:
  // the renderer reports every navigation and the export rebuilds exactly it.
  // `drawnPlantUml` is likewise reported by the renderer; the owner keeps the
  // single copy, readable synchronously so a click in the render-before-commit
  // window still exports the document the Text page will settle on.
  const {
    fitRequest,
    exportStatus,
    copyFallbackText,
    diagramView,
    drawnPlantUml,
    refreshDialogOpen,
    scopeHiddenDelta,
  } = fitExportSnapshot;
  // The owner releases its pending frame on unmount; StrictMode's
  // teardown-and-reset re-subscribes and revives the same instance.
  useEffect(() => () => fitExport.dispose(), [fitExport]);
  // The overlay root is the panel's own element: fullscreen restyles it in
  // place rather than mounting a second copy, so the renderer keeps its zoom
  // and the panel keeps every filter/scope/selection reading.
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  // Where focus returns when the overlay closes.
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  // A fallback dialog opens with its text already selected, so the documented
  // "select and copy" path is one keystroke rather than a drag.
  useEffect(() => {
    if (copyFallbackText === null) return;
    copyFallbackTextareaRef.current?.focus();
    copyFallbackTextareaRef.current?.select();
  }, [copyFallbackText]);

  // The page-internal overlay plus, on a fine pointer, the browser's own
  // fullscreen session. `allowNativeFullscreen` stays false on a coarse
  // pointer: phones get the overlay alone (which is all iOS Safari supports).
  const fullscreen = useArchitectureFullscreen({
    overlayRef: panelRootRef,
    allowNativeFullscreen: !coarsePointer,
  });
  // The stable members the effects and handlers below depend on, named so a
  // hook dependency is a callback rather than a freshly built object.
  const fullscreenActive = fullscreen.active;
  const exitFullscreen = fullscreen.exit;
  const toggleFullscreen = fullscreen.toggle;
  // The standalone page is viewport-sized from the first paint (it has no
  // workspace shell around it), so it borrows the overlay's geometry: the
  // canvas region is `fixed; inset: 0` and the toolbar/readout rows float over
  // it. Entering fullscreen thereafter changes nothing about that geometry.
  const fillsViewport = fullscreenActive || standalone;
  // Focus moves INTO the drawing on entry and back to the toggle on exit, so
  // the keyboard reader is never left on a control the overlay covers. The
  // enter/leave rule (and its "nothing to restore" answer) is the owner's.
  useEffect(() => {
    const target = fitExport.applyFullscreen(fullscreenActive);
    if (target === 'canvas') {
      (search.canvasRegionRef.current ?? panelRootRef.current)?.focus();
    } else if (target === 'toggle') {
      fullscreenButtonRef.current?.focus();
    }
  }, [fullscreenActive, fitExport]);
  // A different session or project is a different reading: fullscreen must not
  // travel with the panel into it.
  useEffect(() => {
    exitFullscreen();
  }, [sessionId, projectId, exitFullscreen]);

  // The renderer reports which zoom mode it is in; a manual zoom is the
  // reader's, so the owner refuses to re-fit after it. A viewport-filled
  // transition (entering or leaving the overlay) asks for its own fit once the
  // box has settled; the owner schedules that frame and measures the geometry.
  // The standalone page's fill is NOT a transition, so its first fit waits for
  // the reading that gives the chrome rows their height.
  useEffect(() => {
    fitExport.applyViewport({ fillsViewport, viewStatus: view.status });
  }, [fillsViewport, view.status, fitExport]);

  // The two knobs and the element/relation selection are owner commands; the
  // owner decides when a change becomes a request (narrowing is answered from
  // the payload in hand, widening after one debounce, a view switch
  // immediately). Showing the change now and requesting it later is one rule,
  // so it has one implementation.
  const changeScope = (next: number): void => settings.changeScope(next);
  const changeDetail = (next: ArchitectureDetailTier): void => settings.changeDetail(next);
  const changeFilter = (next: ArchitectureElementRelationFilter): void => settings.changeFilter(next);
  const changeGranularity = (next: ArchitectureGranularity): void => settings.changeGranularity(next);

  // Search the CURRENT subgraph before the detail cut, so a node the tier
  // folded away is still findable and can be reported as out of range. The
  // search reads the payload BEFORE the element/relation filter: a node the
  // filter removed must still be listed (with the reason and a "Show it"
  // action) instead of the search silently returning nothing. The owner ranks
  // the matches; this effect is the only place the reading is reported.
  const activeNodeIds = useMemo(
    () => new Set((activeNeighbourhood?.nodes ?? []).map((node) => node.id)),
    [activeNeighbourhood],
  );
  useEffect(() => {
    search.setReading(rawNeighbourhood === null
      ? null
      : {
        key: hoverKey,
        nodes: rawNeighbourhood.nodes,
        edges: rawNeighbourhood.edges,
        activeNodeIds,
        retainedNodeIds: detailRanking?.retainedNodeIds ?? null,
      });
  }, [search, hoverKey, rawNeighbourhood, activeNodeIds, detailRanking]);

  /**
   * Reveal a node the filter hid: release the element switch that removed its
   * kind, or — when no switch explains it — pin it so the server includes it in
   * the next reading. Then centre/select it like any other match. The action is
   * never silent: it is the search row's "Show it".
   */
  const showHiddenSearchMatch = (match: { readonly node: ArchitectureRendererNode }): void => {
    const kind = match.node.kind;
    if (kind !== undefined && !filter.kinds.includes(kind)) {
      changeFilter({
        ...filter,
        kinds: [...filter.kinds, kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number]],
      });
      revealNode(match.node.id, false, false);
      return;
    }
    pinNode(match.node);
    revealNode(match.node.id, false, false);
  };

  const revealNode = (nodeId: string, outOfRange: boolean, drill = false): void => {
    // A folded node is only out of range because of the detail tier: raise it
    // to the identity tier before asking the renderer to show the node.
    if (outOfRange) changeDetail('all');
    // Revealing a node is a request to leave the "only show this pin" slice.
    curation.setSoloNodeId(null);
    // "Reveal" includes SELECTING it: the search/inspector command must open
    // the inspector page and paint the node, not only scroll to it.
    dispatchSelection({ type: 'select-entity', nodeId });
    // `drill` is the ONLY thing that replaces the drawing with the entity's
    // neighbourhood; a plain reveal centres it in the drawing on screen.
    chrome.focusNode(nodeId, drill);
    search.closeList();
  };

  // Identifies the analysis for the owner's two "only once" rules. Computed
  // during render (not stored) so the effects below can stay dependency-free:
  // the owner deduplicates, this component does not mirror its flags.
  const deepLinkAnalysisKey = view.status === 'loaded'
    ? `${projectId}\u0000${sessionId ?? ''}\u0000${view.result.provenance.generatedAt ?? ''}\u0000${
      JSON.stringify(view.result.provenance.fingerprints)
    }`
    : '';
  // The standalone link's `entity`/`mode`: select and centre that node once the
  // reading that contains it has arrived, and drill only when the link says
  // `neighbourhood`. The OWNER holds the "applied once" flag, so this effect may
  // run on every render and still be a FIRST-OPEN instruction — a reader who
  // later selects another node is never dragged back by the URL.
  useEffect(() => {
    if (view.status !== 'loaded') return;
    const applied = search.applyDeepLink({
      entity: initialDeepLink.entity,
      mode: initialDeepLink.mode,
      loaded: true,
      analysisKey: deepLinkAnalysisKey,
      nodeIds: view.result.graph[granularity].nodes.map((candidate) => candidate.id),
      retainedNodeIds: detailRanking?.retainedNodeIds ?? null,
    });
    if (applied !== null) revealNode(applied.nodeId, applied.outOfRange, applied.drill);
  });
  // A manual re-analysis can move the graph under the reader. The owner
  // re-aligns the deep-linked entity at most once per analysis (the first apply
  // above already counts as that analysis's alignment), so a refresh keeps the
  // entity selected without every re-render re-centring the drawing.
  useEffect(() => {
    if (view.status !== 'loaded') return;
    const aligned = search.reconcileAnalysis({
      analysisKey: deepLinkAnalysisKey,
      nodeIds: view.result.graph[granularity].nodes.map((candidate) => candidate.id),
      retainedNodeIds: detailRanking?.retainedNodeIds ?? null,
    });
    if (aligned !== null) revealNode(aligned.nodeId, aligned.outOfRange, aligned.drill);
  });

  // ---- Curation actions ----------------------------------------------------
  /** The store shape of a drawn node: `(file, name)` beside the id. */
  const curationItemOf = useCallback((node: ArchitectureRendererNode): ArchitectureCurationItem => ({
    id: node.id,
    name: node.label.trim() === '' ? node.id : node.label,
    file: nodeFileOf(node, nodeIdShapeOf(granularity)),
    ...(node.kind === undefined ? {} : { kind: node.kind }),
  }), [granularity]);

  const reportCurationRefusal = useCallback((result: CurationActionResult): boolean => {
    if (result.ok) return false;
    if (result.code === 'NO_SESSION') {
      showCurationToast(
        t('architecture.curation.noSession', {
          defaultValue: 'Manual adjustments need a session: they are stored per session.',
        }),
        false,
      );
    } else {
      showCurationToast(
        t('architecture.curation.limitReached', {
          defaultValue: 'That list is full ({{limit}}). Remove an entry first.',
          limit: result.limit ?? 0,
        }),
        false,
      );
    }
    return true;
  }, [showCurationToast, t]);

  const pinItem = useCallback((item: ArchitectureCurationItem, label?: string): void => {
    if (reportCurationRefusal(curation.pin(item))) return;
    search.clear();
    showCurationToast(t('architecture.curation.toastPinned', {
      defaultValue: 'Pinned {{name}}',
      name: label ?? item.name,
    }));
  }, [curation, reportCurationRefusal, search, showCurationToast, t]);

  const pinNode = useCallback((node: ArchitectureRendererNode): void => {
    pinItem(curationItemOf(node));
  }, [curationItemOf, pinItem]);

  const removeNode = useCallback((node: ArchitectureRendererNode): void => {
    if (reportCurationRefusal(curation.exclude(curationItemOf(node)))) return;
    showCurationToast(t('architecture.curation.toastRemoved', {
      defaultValue: 'Removed {{name}} from the graph',
      name: node.label.trim() === '' ? node.id : node.label,
    }));
  }, [curationItemOf, curation, reportCurationRefusal, showCurationToast, t]);

  const unpinNode = useCallback((node: ArchitectureRendererNode): void => {
    // "已取消钉住；它仍因与 X 相连而在图中": an unpinned entity that is still
    // drawn (because another node or the transcript reaches it) must say so,
    // or the reader thinks the removal failed.
    const edges = activeNeighbourhood?.edges ?? [];
    const neighbourId = edges
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .map((edge) => (edge.from === node.id ? edge.to : edge.from))[0] ?? null;
    const neighbour = neighbourId === null
      ? null
      : activeNeighbourhood?.nodes.find((candidate) => candidate.id === neighbourId) ?? null;
    if (reportCurationRefusal(curation.unpin(node.id))) return;
    const name = node.label.trim() === '' ? node.id : node.label;
    showCurationToast(
      neighbour === null
        ? t('architecture.curation.toastUnpinned', { defaultValue: 'Unpinned {{name}}', name })
        : t('architecture.curation.toastUnpinnedConnected', {
            defaultValue: 'Unpinned {{name}}; it is still in the graph because it connects to {{other}}',
            name,
            other: neighbour.label.trim() === '' ? neighbour.id : neighbour.label,
          }),
    );
  }, [activeNeighbourhood, curation, reportCurationRefusal, showCurationToast, t]);

  const hideRelation = useCallback((edge: { from: string; to: string; relationType: string }): void => {
    if (reportCurationRefusal(
      curation.hideEdge({ from: edge.from, to: edge.to, type: edge.relationType }),
    )) return;
    showCurationToast(t('architecture.curation.toastRelationHidden', {
      defaultValue: 'Hid the relation — display only; the code is unchanged.',
    }));
  }, [curation, reportCurationRefusal, showCurationToast, t]);

  const undoCuration = useCallback((): void => {
    curation.undo();
    dismissCurationToast();
  }, [curation, dismissCurationToast]);

  const restoreItem = useCallback((group: 'pins' | 'excluded', id: string): void => {
    if (group === 'pins') curation.unpin(id);
    else curation.restore(id);
  }, [curation]);

  const restoreEdge = useCallback((edge: ArchitectureCurationHiddenEdge): void => {
    curation.showEdge(edge);
  }, [curation]);

  const restoreGroup = useCallback((group: ArchitectureCurationPage): void => {
    curation.restoreGroup(group);
  }, [curation]);

  const clearCurationItem = useCallback((group: 'pins' | 'excluded', id: string): void => {
    curation.clearItem(group, id);
  }, [curation]);

  // The project-wide search's second result group. It only runs with a session
  // (the shared storage key) and from two characters up (the endpoint's floor).
  const projectSearch = useProjectSearch(projectId, searchQuery, { enabled: canCurate });

  // Re-anchor saved items after a re-analysis. Entity ids can change while
  // `(file, name)` stays stable, so every loaded analysis resolves the saved
  // list once; unresolved items are marked stale instead of disappearing. The
  // once-per-analysis bookkeeping and the failed-request retry live in the
  // owner, so this effect only states when a re-anchoring is due.
  useEffect(() => {
    if (!canCurate || projectId === null || view.status !== 'loaded') return;
    const items = [...curationState.pins, ...curationState.excluded];
    if (items.length === 0) return;
    const analysisKey = `${projectId}\u0000${sessionId ?? ''}\u0000${
      view.result.provenance.generatedAt ?? ''
    }\u0000${JSON.stringify(view.result.provenance.fingerprints)}`;
    curation.reconcileForAnalysis(
      analysisKey,
      items.map((item) => ({ name: item.name, file: item.file })),
    );
  }, [canCurate, projectId, sessionId, view, curationState.pins, curationState.excluded, curation]);

  // A scope change (view or session) clears the selection through the reducer.
  useEffect(() => {
    dispatchSelection({ type: 'sync-scope', scope: selectionScope });
  }, [selectionScope]);

  // ── the manual whole-project re-analysis ──────────────────────────────────
  // The status is shared server-side, so a tab opened while another session's
  // job is running shows that run. The dialog is the confirmation step; the
  // owner holds whether it is open and which control opened it (for focus
  // return), and the post-success fit it arms is consumed once.
  const handleRefreshSucceeded = useCallback((): void => {
    // A new analysis can change entity ids while `(file, name)` stays stable,
    // so the saved curation must be re-anchored on the NEXT reading.
    curation.resetReconcile();
    fitExport.refreshSucceeded();
    // The content-addressed cache is keyed by the manifest, so this is a real
    // refetch of the refreshed analysis rather than a cache hit.
    reload();
  }, [curation, fitExport, reload]);
  const refresh = useArchitectureRefresh(projectId, { onSucceeded: handleRefreshSucceeded });
  const refreshRunning = refresh.status.state === 'running';
  // A job failure and a transport failure are different faces of the same
  // dialog; the job's own reason wins when both exist.
  const refreshFailureReason = refresh.status.state === 'failed'
    ? refresh.status.error
    : refresh.requestError;
  const openRefreshDialog = useCallback((trigger: HTMLElement | null): void => {
    fitExport.openRefreshDialog(trigger);
  }, [fitExport]);
  // The dialog takes a ref object; this binding reads the owner's return target
  // when the dialog opens and closes, so there is no second copy to sync.
  const refreshDialogReturnFocusRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return fitExport.getSnapshot().refreshDialogReturnFocus;
      },
    }),
    [fitExport],
  );
  // A finished job closes the dialog on its own; the footer's updated time (and
  // a failed job's own reading) are the durable evidence.
  useEffect(() => {
    fitExport.refreshStatusChanged(refresh.status.state);
  }, [refresh.status.state, fitExport]);
  // The refetched reading is back: the owner fits it once (even over a manual
  // zoom) and clears the armed flag.
  useEffect(() => {
    fitExport.applyRefreshReading({ viewStatus: view.status, refreshing });
  }, [view, refreshing, fitExport]);

  /**
   * The reader's close gesture for the dock (×, Escape, the Text door toggling
   * itself shut). The owner closes the dock and drops the explicit-open licence;
   * the panel clears the selection with it: the review found that closing the
   * inspector left the selection's dimming and highlight on the drawing with no
   * inspector open to explain it, and only a press on the empty canvas cleared it.
   */
  const closeDock = useCallback((): void => {
    dispatchSelection({ type: 'clear' });
    chrome.closeDock();
  }, [chrome]);

  // Selecting anything is a request to inspect it: a NEW selection opens the
  // dock AND lands on the Inspector page, whatever page the reader last used.
  // An open dock whose selection emptied is an empty column and closes — unless
  // the READER opened it themselves while nothing was selected (the Text door).
  // Both halves of that rule are the owner's; this effect only reports the fact.
  useEffect(() => {
    chrome.selectionChanged(selection !== null);
  }, [selection, chrome]);

  // A different session (or project) is a different reading, and the dock's
  // open state is per reading: it must not travel into a page with nothing
  // selected in it. This was the "empty 320px inspector on entry" the sessions
  // showed when they had opened the dock earlier.
  useEffect(() => {
    chrome.readingChanged();
  }, [sessionId, projectId, chrome]);

  const selectNodeOnCanvas = useCallback((node: ArchitectureRendererNode): void => {
    dispatchSelection({ type: 'select-entity', nodeId: node.id });
  }, []);
  const toggleNodeOnCanvas = useCallback((node: ArchitectureRendererNode): void => {
    dispatchSelection({ type: 'toggle-entity', nodeId: node.id });
  }, []);
  const selectRelationOnCanvas = useCallback((edge: ArchitectureRendererEdge): void => {
    dispatchSelection({
      type: 'select-relation',
      from: edge.from,
      to: edge.to,
      relationType: edge.relationType,
    });
  }, []);
  const toggleRelationOnCanvas = useCallback((edge: ArchitectureRendererEdge): void => {
    dispatchSelection({
      type: 'toggle-relation',
      from: edge.from,
      to: edge.to,
      relationType: edge.relationType,
    });
  }, []);
  /** A touch long-press on an entity: turn multi-select on and add that node. */
  const startMultiSelect = useCallback((node: ArchitectureRendererNode): void => {
    chrome.setMultiSelectMode(true);
    dispatchSelection({ type: 'toggle-entity', nodeId: node.id });
  }, [chrome]);
  /** A marquee release: add every drawn thing the rectangle hit. */
  const addBoxSelection = useCallback((boxed: readonly ArchitectureSelection[]): void => {
    if (boxed.length > 0) dispatchSelection({ type: 'add-selections', selections: boxed });
  }, []);
  const toggleSelection = useCallback((entry: ArchitectureSelection): void => {
    dispatchSelection(
      entry.kind === 'entity'
        ? { type: 'toggle-entity', nodeId: entry.nodeId }
        : { type: 'toggle-relation', from: entry.from, to: entry.to, relationType: entry.relationType },
    );
  }, []);
  /**
   * Escape, while the canvas owns the key: an expanded tray collapses first
   * (the selection survives), then the dock closes — and, like the × button,
   * that close also clears the selection, so no dim/highlight is left behind.
   * The owner decides which surface the press consumed; the panel performs the
   * reducer clear that the last two steps imply.
   * `stopPropagation` happens in the renderer, so the chat page's global abort
   * never fires.
   */
  const escapeSelection = useCallback((): void => {
    const step = chrome.escapeSelection();
    if (step === 'tray') return;
    dispatchSelection({ type: 'clear' });
  }, [chrome]);
  /** A click on the empty canvas clears the selection AND closes the dock. */
  const clearSelectionOnCanvas = useCallback((): void => {
    dispatchSelection({ type: 'clear' });
    chrome.clearSelection();
  }, [chrome]);

  /**
   * `F`, while the drawing owns the keyboard: the same toggle the toolbar
   * button performs. The handler lives on the canvas REGION (not the panel), so
   * typing `f` in the search box or a tray memo never enters fullscreen.
   */
  const handleCanvasFullscreenKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'f' && event.key !== 'F') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    toggleFullscreen();
  }, [toggleFullscreen]);
  // An empty set has nothing to expand: reset both tray readings with it, so a
  // later selection starts from the pill rather than a stale drawer.
  useEffect(() => {
    if (selections.length > 0) return;
    chrome.selectionsEmptied();
  }, [selections.length, chrome]);
  /** Selecting a related node from the inspector also centres it in the drawing. */
  const inspectRelatedNode = (nodeId: string): void => {
    revealNode(nodeId, false);
  };

  // A scope change can find more of the graph and then hide ALL of it behind
  // the element/relation filter: the drawing looks identical and the knob feels
  // dead. The owner remembers the previous settled reading so the delta can be
  // stated; the panel offers the one click that makes those entities visible.
  //
  // Declared ABOVE the status branches: a hook added after a conditional
  // return changes the hook order when the panel leaves its loading state.
  const loadedResult = view.status === 'loaded' ? view.result : null;
  // `readout.related` is the pre-budget total; the truncation reading is the
  // same denominator and is available before the status narrowing.
  const scopeRelatedTotal = loadedResult === null
    ? 0
    : truncationReading(loadedResult, granularity).total;
  // The payload identity keys the comparison: the scope STATE flips before the
  // new response arrives, so keying on it would record the old numbers under
  // the new scope and lose the delta.
  useEffect(() => {
    fitExport.observeScope({
      result: loadedResult,
      scope,
      related: scopeRelatedTotal,
      hidden: hiddenTotal(hiddenReading),
      kinds: hiddenReading.byKind,
      relations: hiddenReading.byRelation,
    });
  }, [loadedResult, scope, scopeRelatedTotal, hiddenReading, fitExport]);
  // The one-click fix: every kind the transition hid becomes visible again
  // (a widening, so `changeFilter` re-requests it from the server).
  const showScopeHiddenKinds = (): void => {
    if (scopeHiddenDelta === null || scopeHiddenDelta.kinds.length === 0) return;
    const kinds = [...new Set([
      ...filter.kinds,
      ...scopeHiddenDelta.kinds.map((entry) => entry.kind),
    ])];
    changeFilter({ ...filter, kinds });
  };

  /**
   * The standalone page's Back entry. It sits in the toolbar rather than in a
   * second bar, so the drawing keeps the full viewport; the compact tier keeps
   * the icon alone and states the action through `aria-label`.
   */
  const standaloneBackButton = standalone && onBackToSession !== undefined ? (
    <button
      type="button"
      onClick={onBackToSession}
      aria-label={t('architecture.standalone.backToSession', { defaultValue: 'Back to session' })}
      title={t('architecture.standalone.backToSession', { defaultValue: 'Back to session' })}
      data-architecture-standalone-back="true"
      style={compactTargetStyle}
      className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {!compactToolbar && (
        <span>{t('architecture.standalone.backToSession', { defaultValue: 'Back to session' })}</span>
      )}
    </button>
  ) : null;

  if (!sessionId) {
    return { branch: 'no-session' as const, t };
  }

  if (view.status === 'idle' || view.status === 'loading') {
    return {
      branch: 'loading' as const,
      t,
      standalone,
      fillsViewport,
      standaloneBackButton,
    };
  }

  if (view.status === 'error') {
    return {
      branch: 'error' as const,
      t,
      standalone,
      fillsViewport,
      standaloneBackButton,
      message: view.message,
      reload,
    };
  }

  const { result } = view;
  const { stats, mmd, provenance } = result;
  // A manual pin is a root of its own, so a curated request with no transcript
  // seeds still has something to draw.
  const hasSeeds = stats.seedFiles > 0 || stats.seedIdentifiers > 0 || pinnedIds.length > 0;
  const neighbourhood = result.graph[granularity];
  // A reading from the previous graph is not shown against this one.
  const visibleHover = hover;

  // The graph the renderer was last handed: the detail tier's cut, then the
  // layout budget's. The export rebuilds from the SAME graph, so the file is
  // the drawing on screen rather than a re-derivation from the payload.
  const drawnGraph: ArchitectureRendererGraph =
    layoutFit?.graph ?? detailRanking?.graph ?? displayNeighbourhood ?? neighbourhood;

  // The third empty state the seed reading cannot see: the session DID resolve
  // seeds, but the granularity on screen has no node to draw (the reported
  // `entityTotal=0` class view over a cache that carries files is the canonical
  // case). The other granularity may still have content, so the state explains
  // why instead of leaving a blank canvas, and offers a one-click switch.
  const drawnEmpty = drawnGraph.nodes.length === 0;
  const alternateGranularity: ArchitectureGranularity = granularity === 'entity' ? 'file' : 'entity';
  // The switch's count is the pre-budget total when the payload carries it (the
  // same denominator the readout uses), falling back to the graph in hand.
  const alternateTotal = alternateGranularity === 'file'
    ? stats.fileTotal ?? result.graph.file.nodes.length
    : stats.entityTotal ?? result.graph.entity.nodes.length;
  // Why nothing was drawn: the session's unresolved file seeds, capped so a
  // long list cannot turn the empty state into a wall of paths.
  const emptyViewMessage = (() => {
    const base = t('architecture.emptyView.title', { defaultValue: 'No nodes to draw in this view.' });
    const files = stats.unresolved.files;
    if (files.length === 0) return base;
    const shown = files.slice(0, EMPTY_VIEW_UNRESOLVED_LIMIT);
    const rest = files.length - shown.length;
    const names = rest === 0
      ? shown.join(', ')
      : `${shown.join(', ')} ${t('architecture.emptyView.more', {
        defaultValue: '…and {{count}} more',
        count: rest,
      })}`;
    return `${base} ${t('architecture.emptyView.unresolvedFiles', {
      defaultValue: 'Files mentioned in this session were not found in the analysis cache: {{names}}',
      names,
    })}`;
  })();

  // The hover reading, stated from the payload instead of the internal id: the
  // id carries the opaque scope key (`93e0a992/…`), which means nothing to the
  // reader and leaked into the tooltip.
  const hoverReading = visibleHover === null
    ? null
    : (() => {
        const node = visibleHover.node;
        const label = node.label.trim() === '' || node.label === node.id
          ? node.id.slice(node.id.lastIndexOf('.') + 1)
          : node.label;
        const file = nodeFileOf(node, nodeIdShapeOf(granularity));
        const outgoing = drawnGraph.edges.filter((edge) => edge.from === node.id).length;
        const incoming = drawnGraph.edges.filter((edge) => edge.to === node.id).length;
        const hidden = Object.values(hiddenReading.byNodeRelations?.[node.id] ?? {})
          .reduce((total, count) => total + count, 0);
        return { id: node.id, label, file, incoming, outgoing, hidden };
      })();
  /**
   * The hover reading as ONE string.
   *
   * It is built here rather than as JSX fragments for two reasons: the reading
   * must be printed whole in the span's `title` (the visible line may be
   * ellipsized on a narrow canvas), and the ellipsis must never remove anything
   * the title cannot give back.
   */
  const hoverHintText = hoverReading === null
    ? ''
    : [
        t('architecture.copyFix.hoverSummary', {
          defaultValue: '{{name}} · {{file}} · {{in}} in / {{out}} out',
          name: hoverReading.label,
          file: hoverReading.file,
          in: hoverReading.incoming,
          out: hoverReading.outgoing,
        }),
        ' — ',
        visibleHover !== null && visibleHover.relations.length > 0
          ? visibleHover.relations.join(', ')
          : t('architecture.copyFix.hoverNoRelations', { defaultValue: 'no drawn relations' }),
        hoverReading.hidden > 0
          ? ` · ${t('architecture.copyFix.hoverHidden', {
            defaultValue: '{{count}} more hidden by the filter',
            count: hoverReading.hidden,
          })}`
          : '',
      ].join('');
  // The selection as the renderer and the inspector need it: separate readings,
  // so neither has to narrow the union itself.
  const selectedNodeId = selection?.kind === 'entity' ? selection.nodeId : null;
  const selectedRelation = selection?.kind === 'relation'
    ? { from: selection.from, to: selection.to, relationType: selection.relationType }
    : null;
  // The coarse drawer's collapsed (96px) reading: what is selected, in one line.
  // A multi-selection states its size instead of pretending one member speaks
  // for the set.
  const dockSummary: string | null = selections.length === 0
    ? null
    : selections.length > 1
      ? t('architecture.inspector.selectedCount', {
        defaultValue: '{{count}} selected',
        count: selections.length,
      })
      : selection !== null && selection.kind === 'entity'
        ? (() => {
          const node = drawnGraph.nodes.find((candidate) => candidate.id === selection.nodeId);
          if (node === undefined) return selection.nodeId;
          return `${node.label.trim() === '' ? node.id : node.label} · ${node.kind ?? 'other'}`;
        })()
        : selection !== null
          ? `${selection.from} → ${selection.to}`
          : null;

  // Compose-to-chat, remove-selected and every export path live in the
  // action hook; it binds the same owners the panel wires above.
  const {
    composeSelectionText,
    putSelectionInChat,
    putNodeInChat,
    removeSelected,
    exportPlantUml,
    copyPlantUml,
    exportSvg,
    exportPng,
    exportMermaid,
    exportStatusText,
    canComposeSelection,
  } = useArchitecturePanelActions({
    projectName,
    diagramView,
    dispatchSelection,
    drawnGraph,
    exportStatus,
    fitExport,
    granularity,
    hideRelation,
    i18n,
    mmd,
    onOpenChat,
    projectId,
    provenance,
    removeNode,
    search,
    selections,
    sessionId,
    showCurationToast,
    standalone,
    t,
  });

  const truncation = truncationReading(result, granularity);
  // How many nodes the server's node budget left out of this subgraph. The
  // compact toolbar badge and the marker's data attributes read it; the
  // expanded explanation states it as one of its layers.
  const budgetOmitted = Math.max(0, truncation.total - truncation.shown);
  // Entities the ELEMENT selection (kinds + "keep mentioned") removes from the
  // payload in hand. That is the axis a widening request changed, so it is the
  // only one M has to subtract: the isolated/relation axes decide what is DRAWN
  // and keep their own readout line ("1 isolated nodes"), and the server's total
  // never reflected them (the live-voice 19 → 18 reading stays 19).
  const locallyHiddenKindCount = filteredGraph === null
    ? 0
    : Object.values(filteredGraph.hidden.byKind).reduce((sum, count) => sum + (count ?? 0), 0);
  const elementScopeCount = Math.max(
    0,
    (rawNeighbourhood?.nodes.length ?? neighbourhood.nodes.length) - locallyHiddenKindCount,
  );
  // The ONE reading the reader gets: N is what the layout was handed (group
  // boxes count their members), M is the server's pre-budget total. The pure
  // function decides which budget layers are named; the panel only renders it.
  const readout = buildReadout({
    detailRetained: detailRanking?.retainedNodeIds.size ?? neighbourhood.nodes.length,
    // The tier ranked the FILTERED subgraph. Measuring its cut against the
    // server's returned count instead would read a hidden isolated node (or an
    // element/relation filter) as a detail-tier fold and light the amber
    // `Budget-limited` marker on an otherwise untroubled drawing.
    detailInScope: displayNeighbourhood?.nodes.length ?? neighbourhood.nodes.length,
    drawnBoxes: layoutFit?.graph.nodes ?? [],
    returnedCount: truncation.shown,
    relatedTotal: truncation.total,
    // M follows the CURRENT element selection over the response in hand: a
    // local narrowing must not keep reading the wider payload's `entityTotal`
    // (that made the same filter read 5 related, then 40, after a widening
    // detour). Isolated/relation removals stay out of it — they are the
    // drawing's own filter line, not a change of scope.
    filteredCount: elementScopeCount,
    locale: i18n.language,
  });

  // Both subgraphs are in hand; toggling only picks one, so it must not refetch.
  // The two options are a radiogroup because exactly one graph is on screen.

  // ---- Readings shared by several view fragments --------------------------
const toggleKind = (kind: (typeof ARCHITECTURE_ELEMENT_KINDS)[number]): void => {
  const kinds = filter.kinds.includes(kind)
    ? filter.kinds.filter((entry) => entry !== kind)
    : [...filter.kinds, kind];
  changeFilter({ ...filter, kinds });
};
/**
 * Flip one kind's "keep mentioned" switch. Turning it ON can bring back
 * entities the arrived payload may not carry (the server had already hidden
 * them), so it is a widening and re-requests; turning it OFF is a narrowing
 * and is answered from the payload in hand.
 */
const toggleKeepMentioned = (kind: (typeof ARCHITECTURE_ELEMENT_KINDS)[number]): void => {
  const keepMentionedKinds = filter.keepMentionedKinds.includes(kind)
    ? filter.keepMentionedKinds.filter((entry) => entry !== kind)
    : [...filter.keepMentionedKinds, kind];
  changeFilter({ ...filter, keepMentionedKinds });
};
// Only the kinds the session actually mentioned are offered: a switch over a
// zero-count kind would be a control with nothing to keep. The numbers come
// from `stats.mentionedByKind`, which the server counts over the UNFILTERED
// scope, so hiding a kind never makes its own number disappear.
const mentionedKindCounts = stats.mentionedByKind ?? {};
const mentionedKinds = ARCHITECTURE_ELEMENT_KINDS.filter(
  (kind) => (mentionedKindCounts[kind] ?? 0) > 0,
);
/**
 * Open the switches for every kind whose mentioned entities the current
 * reading hides — the readout's "show mentioned" action. It names only the
 * kinds that are actually hidden, so a not-yet-mentioned kind is not silently
 * enabled.
 */
const showHiddenMentioned = (): void => {
  const hiddenKinds = Object.entries(hiddenReading.mentionedByKind ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([kind]) => kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number]);
  if (hiddenKinds.length === 0) return;
  const keepMentionedKinds = [
    ...new Set([...filter.keepMentionedKinds, ...hiddenKinds]),
  ];
  changeFilter({ ...filter, keepMentionedKinds });
};

// The DRAWN mix, counted from the boxes on screen. "Showing 40 classes" was a
// view label while every box was a «function»; this line names what is drawn.
const drawnKindParts = drawnKindCounts(layoutFit?.graph.nodes ?? []).map((part) => {
  switch (part.kind) {
    case 'function':
      return t('architecture.copyFix.kindFunction', { defaultValue: '{{count}} functions', count: part.count });
    case 'interface':
      return t('architecture.copyFix.kindInterface', { defaultValue: '{{count}} interfaces', count: part.count });
    case 'class':
      return t('architecture.copyFix.kindClass', { defaultValue: '{{count}} classes', count: part.count });
    default:
      return t('architecture.copyFix.kindOther', { defaultValue: '{{count}} others', count: part.count });
  }
});
const readoutSummary = granularity === 'entity'
  ? drawnKindParts.length > 0
    ? t('architecture.copyFix.entitySummary', {
        defaultValue: 'Showing {{shown}} ({{kinds}}) · {{total}} related',
        shown: readout.shownText,
        kinds: drawnKindParts.join(' · '),
        total: readout.relatedText,
      })
    : t('architecture.copyFix.entitySummaryPlain', {
        defaultValue: 'Showing {{shown}} · {{total}} related',
        shown: readout.shownText,
        total: readout.relatedText,
      })
  : t('architecture.readout.fileSummary', {
      defaultValue: 'Showing {{shown}} files · {{total}} related',
      shown: readout.shownText,
      total: readout.relatedText,
    });

/**
 * The landscape-phone summary's expansion cell and the shell's sidebar
 * collapse entry.
 *
 * The shell owns the sidebar and already renders a collapse control in its
 * header (the `PanelLeftClose` icon); the compact design asks the Architecture
 * tab for an entry that invokes that existing capability without changing the
 * shell. Lucide's exported icon name is part of its public API (`lucide-
 * panel-left-close` is the class it stamps), so the control is found by that
 * stable marker rather than by a localized title or a text match. No shell
 * implementation is touched, and if the shell ever stops rendering the
 * control the click is a no-op rather than an error.
 */
const collapseShellSidebar = (): void => {
  const button = document.querySelector('svg.lucide-panel-left-close')?.closest('button');
  if (button instanceof HTMLElement) button.click();
};

/**
 * The text page's header facts, stated once here so the dock page and the
 * copy header cannot disagree: the view axis is the granularity switch, and
 * the filter axis is the same reading the filter popover prints (how many
 * functions it hid and which relation preset is on).
 */
const textViewLabel = granularity === 'entity'
  ? t('architecture.controls.classView', { defaultValue: 'Class diagram' })
  : t('architecture.fileGraph', { defaultValue: 'File graph' });
const textFilterSummary = t('architecture.text.filterSummary', {
  defaultValue: '{{hiddenFunctions}} functions hidden; relations: {{relations}}',
  hiddenFunctions: String(hiddenReading.byKind.function ?? 0),
  relations: relationPresetLabel(filter.relations),
});

  // ---- View model -------------------------------------------------------
  // Everything the leaf view modules render, stated once so the panel keeps
  // only the owner wiring. The returned object IS the view contract (its type
  // is exported below for the modules to narrow).
  return {
    branch: 'ready' as const,
    Renderer,
    filter,
    scope,
    detail,
    activeNodeIds,
    activeSearchIndex,
    addBoxSelection,
    alternateGranularity,
    alternateTotal,
    budgetOmitted,
    canComposeSelection,
    canCurate,
    canCurateEntities,
    canvasHeaderHost,
    changeDetail,
    changeFilter,
    changeGranularity,
    changeScope,
    chrome,
    clearCurationItem,
    clearSelectionOnCanvas,
    closeDock,
    closeLegend,
    coarsePointer,
    collapseShellSidebar,
    compactHeaderButtonClass,
    compactTargetStyle,
    compactToolbar,
    composeSelectionText,
    copyFallbackText,
    copyFallbackTextareaRef,
    copyPlantUml,
    curation,
    curationCanUndo,
    curationManagerButtonRef,
    curationManagerOpen,
    curationState,
    curationToast,
    detailRanking,
    detailReading,
    diagramView,
    dismissTouchHint,
    dispatchSelection,
    displayNeighbourhood,
    dockLayoutLocked,
    dockOpen,
    dockSummary,
    dockTab,
    dockTier,
    drawnEmpty,
    drawnGraph,
    drawnKindParts,
    drawnPlantUml,
    emptyViewMessage,
    escapeSelection,
    exportMermaid,
    exportPlantUml,
    exportPng,
    exportStatusText,
    exportSvg,
    fillsViewport,
    filterButtonRef,
    filterMenuOpen,
    filterPosition,
    fitExport,
    fitRequest,
    focusTarget,
    fullscreen,
    fullscreenButtonRef,
    granularity,
    handleCanvasFullscreenKey,
    handleNodeHover,
    hasSeeds,
    headerButtonClass,
    hiddenReading,
    hideRelation,
    hoverHintPosition,
    hoverHintText,
    hoverReading,
    hoverVisible,
    i18n,
    includeToolResults,
    inspectRelatedNode,
    kindLabel,
    layoutFit,
    legendButtonRef,
    legendOpen,
    mentionedKindCounts,
    mentionedKinds,
    multiSelectMode,
    neighbourhood,
    onOpenChat,
    openRefreshDialog,
    panelRootRef,
    pauseCurationToast,
    pinItem,
    pinNode,
    pinnedIdSet,
    pinnedIds,
    portraitPhone,
    projectId,
    projectName,
    projectSearch,
    provenance,
    putNodeInChat,
    putSelectionInChat,
    readout,
    readoutOpen,
    readoutRowRef,
    readoutSummary,
    refresh,
    refreshDialogOpen,
    refreshDialogReturnFocusRef,
    refreshFailureReason,
    refreshRunning,
    refreshing,
    relationPresetLabel,
    relationTypeLabel,
    reload,
    removeNode,
    removeSelected,
    resolvedDiffHighlight,
    restoreEdge,
    restoreGroup,
    restoreItem,
    resumeCurationToast,
    revealNode,
    scopeHiddenDelta,
    scopeHygieneOpen,
    search,
    searchMatches,
    searchOpen,
    searchPending,
    searchQuery,
    selectNodeOnCanvas,
    selectRelationOnCanvas,
    selectedNodeId,
    selectedNodeIds,
    selectedRelation,
    selectedRelations,
    selection,
    selections,
    sessionId,
    sessionTitle,
    settings,
    sheetControlsHost,
    sheetOpen,
    sheetTriggerRef,
    shortTouch,
    showHiddenMentioned,
    showHiddenSearchMatch,
    showScopeHiddenKinds,
    soloNodeId,
    standalone,
    standaloneBackButton,
    startMultiSelect,
    stats,
    t,
    textFilterSummary,
    textViewLabel,
    toggleKeepMentioned,
    toggleKind,
    toggleNodeOnCanvas,
    toggleRelationOnCanvas,
    toggleSelection,
    topChromePx,
    touchDrawerHeight,
    touchHintDismissed,
    trayExpanded,
    truncation,
    undoCuration,
    unpinNode,
    unresolvedOpen,
    visibleHover,
  };
}

/** The panel model: every branch screen and the ready view scope. */
export type ArchitecturePanelModel = ReturnType<typeof useArchitecturePanelModel>;

/** The ready arm, as the leaf view modules receive it. */
export type ArchitecturePanelScope = ArchitecturePanelModel;

/** The architecture tab: the owner hook plus the leaf view shell. */
export default function ArchitecturePanel(props: ArchitecturePanelProps) {
  const model = useArchitecturePanelModel(props);
  return <ArchitecturePanelShell model={model} />;
}
