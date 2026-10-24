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
} from 'react';
import { ArrowLeft, ExternalLink, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PlantUmlGraph } from '@/modules/architecture/PlantUmlGraph';
import { ArchitectureCurationManager, type ArchitectureCurationPage } from '@/modules/architecture/ArchitectureCurationManager';
import { ArchitectureDock } from '@/modules/architecture/ArchitectureDock';
import { ArchitectureInspector } from '@/modules/architecture/ArchitectureInspector';
import { ArchitectureRefreshDialog } from '@/modules/architecture/ArchitectureRefreshDialog';
import {
  createCurationStore,
  curationStorageKey,
  type ArchitectureCurationHiddenEdge,
  type ArchitectureCurationItem,
  type ArchitectureCurationState,
  type CurationActionResult,
} from '@/modules/architecture/curationStore';
import { resolveCurationItems, useProjectSearch } from '@/modules/architecture/hooks/useProjectSearch';
import { ArchitectureSheet } from '@/modules/architecture/ArchitectureSheet';
import {
  ArchitectureSelectionTray,
  buildSelectionMessage,
} from '@/modules/architecture/ArchitectureSelectionTray';
import { ArchitectureTextPanel } from '@/modules/architecture/ArchitectureTextPanel';
import {
  nodeFileOf,
  seedMarkerMode,
  type ArchitectureDiagramView,
} from '@/modules/architecture/archguardToPlantUml';
import {
  ARCHITECTURE_DETAIL_TIERS,
  ARCHITECTURE_SCOPE_MAX,
  ARCHITECTURE_SCOPE_MIN,
  clampArchitectureScope,
  rankArchitectureDetail,
  type ArchitectureDetailTier,
} from '@/modules/architecture/detailRanking';
import { buildFullPlantUmlDocument } from '@/modules/architecture/plantUmlText';
import {
  activeFilterCount,
  applyFilter,
  ARCHITECTURE_ELEMENT_KINDS,
  ARCHITECTURE_RELATION_PRESETS,
  filtersEqual,
  hiddenTotal,
  keptMentionedCount,
  relationsForPreset,
  resetFilter,
  showAllFilter,
  type ArchitectureElementRelationFilter,
  type ArchitectureRelationPreset,
} from '@/modules/architecture/elementRelationFilter';
import {
  architectureExportFilename,
  downloadBlob,
  downloadTextFile,
  EXPORT_PNG_MAX_EDGE,
  pngTargetSize,
  rasterizeSvgToPng,
  serializeSvgForExport,
} from '@/modules/architecture/exportArtifacts';
import { BOTTOM_SLOT_INFO_INSET_PX, overlayLayoutDefect } from '@/modules/architecture/bottomSlotLayout';
import {
  CanvasHeaderSlotContext,
  CompactToolbarSlotContext,
  shortTouchDockForm,
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useTouchLayout,
} from '@/modules/architecture/hooks/useTouchLayout';
import { fitToLayoutBudget, LAYOUT_NODE_BUDGET } from '@/modules/architecture/layoutBudget';
import { buildReadout, drawnKindCounts } from '@/modules/architecture/readoutNumbers';
import {
  HOVER_HINT_MARGIN_PX,
  placeHoverHint,
  type ArchitectureHintRect,
} from '@/modules/architecture/hoverHintPlacement';
import type {
  ArchitectureDetailReading,
  ArchitectureDrawnPlantUml,
  ArchitectureDiffHighlight,
  ArchitectureEntityKind,
  ArchitectureFitRequest,
  ArchitectureNodeIdShape,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererHover,
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';
import { readSvgNaturalSize } from '@/modules/architecture/svgViewport';
import {
  createSelectionState,
  reduceSelection,
  resolveDraftScope,
  selectionInScope,
  selectionsInScope,
  type ArchitectureSelection,
  type ArchitectureSelectionScope,
} from '@/modules/architecture/selectionModel';
import {
  formatRefreshElapsed,
  useArchitectureRefresh,
} from '@/modules/architecture/useArchitectureRefresh';
import { useArchitectureGraph, type ArchitectureGraphResult } from '@/modules/architecture/useArchitectureGraph';
import { useArchitectureFullscreen } from '@/modules/architecture/useArchitectureFullscreen';
import {
  buildArchitectureStandaloneHref,
  parseArchitectureDeepLink,
  type ArchitectureDeepLinkState,
} from '@/modules/architecture/architectureDeepLink';
import { sendArchitectureChatMessage } from '@/modules/architecture/architectureChatBridge';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { formatAbsoluteTime, formatRelativeTime } from '@/shared/utils';
import { ArchitectureEmptyState } from '@/modules/architecture/ArchitectureEmptyState';
import { ArchitectureExportMenu } from '@/modules/architecture/ArchitectureExportMenu';
import { CurationToast } from '@/modules/architecture/CurationToast';
import { LegendSwatch } from '@/modules/architecture/LegendSwatch';
import { useDismissiblePopover } from '@/modules/architecture/useDismissiblePopover';
import {
  addHidden,
  EMPTY_HIDDEN,
  readStoredFilter,
  truncationReading,
  writeStoredFilter,
  type ArchitectureGranularity,
} from '@/modules/architecture/panelFilters';
import {
  BROWSER_CURATION_STORAGE,
  readStoredDetail,
  readStoredScope,
  readStoredTouchHintDismissed,
  writeStoredDetail,
  writeStoredScope,
  writeStoredTouchHintDismissed,
} from '@/modules/architecture/panelPersistence';

/**
 * The dock's pages. `inspector` is the selection reading; `text` is the
 * PlantUML page registered by the text-page task on the same shell.
 */
type ArchitectureDockTabId = 'inspector' | 'text';

/**
 * The id scheme the server used for a subgraph. File ids ARE project-relative
 * paths; entity ids are `<scopeKey>/<scope-relative path>.<Entity>`. The panel
 * is the only layer that knows which subgraph it is handing over, so it states
 * the shape for the renderer instead of letting the renderer guess.
 */
function nodeIdShapeOf(granularity: ArchitectureGranularity): ArchitectureNodeIdShape {
  return granularity === 'file' ? 'project-relative' : 'scope-prefixed';
}

/**
 * How long a filter/view change waits before it becomes a request.
 *
 * Walking the relation presets (structural → dependency → call) is one gesture;
 * without the debounce each step would POST its own reading. Narrowing never
 * waits at all — it is answered from the payload in hand.
 */
const FILTER_REQUEST_DEBOUNCE_MS = 250;

/**
 * How many unresolved file paths the "nothing to draw in this view" empty state
 * names before collapsing the rest into an "…and N more" count. The state exists
 * to explain a blank canvas, not to print the whole unresolved set.
 */
const EMPTY_VIEW_UNRESOLVED_LIMIT = 5;

/**
 * The id of the "keep these shown…" hint paragraph. Every "keep mentioned"
 * switch points `aria-describedby` at it, so the visible name and the extra
 * explanation are separate readings instead of one overloaded `aria-label`.
 */
const MENTIONED_HINT_ID = 'architecture-filter-mentioned-hint';
/**
 * How long the dock's open/close animation lasts (matching the 160ms
 * `transform` transition in `ArchitectureDock`). Aspect-driven re-layout stays
 * frozen for the duration, plus a frame of slack, so the width change caused by
 * the dock itself is never read as a container shape change.
 */
const DOCK_LAYOUT_LOCK_MS = 200;

/**
 * Where the portrait phone's summary remembers whether it is expanded.
 *
 * `sessionStorage`, not `localStorage`: the requirement is "remembered within
 * the session", and a fresh browser session must start collapsed again — the
 * phone's scarce height is why the default is the one-line form.
 */
const READOUT_EXPANDED_SESSION_KEY = 'architecture-readout-expanded';

/** The session's remembered expansion; storage being blocked reads as collapsed. */
const readReadoutExpandedInSession = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(READOUT_EXPANDED_SESSION_KEY) === 'true';
  } catch {
    return false;
  }
};

/** The remembered knobs for one project; `projectId` keys the loaded pair. */
type ArchitectureDisplaySettings = {
  readonly projectId: string | null;
  readonly scope: number;
  readonly detail: ArchitectureDetailTier;
};

/** A node the reader asked the graph to reveal (search hit or out-of-range jump). */
type ArchitectureFocusTarget = {
  readonly id: string;
  /** Bumped on every request so choosing the same node twice re-centres it. */
  readonly token: number;
  /**
   * Whether the request also opens the node's neighbourhood. A plain search
   * Enter only centres and selects IN the current drawing; only Shift+Enter or
   * the result row's "view neighbourhood" action drills.
   */
  readonly drill: boolean;
};

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

/** One `from->to` pair from a diff deep link; null when either side is missing. */
function parseDiffPair(raw: string): { from: string; to: string } | null {
  const separator = raw.indexOf('->');
  if (separator <= 0) return null;
  const from = raw.slice(0, separator).trim();
  const to = raw.slice(separator + 2).trim();
  return from === '' || to === '' ? null : { from, to };
}

/**
 * Parses the diff set a preview puts in the standalone URL.
 *
 * Repeatable parameters keep the link readable and avoid inventing a serialisation:
 * `diffNode=<drawn id>`, `diffEdge=<from>-><to>`, `diffPkg=<package id>`,
 * `diffPkgEdge=<from>-><to>`. Anything malformed is ignored, like every other deep-link
 * parameter — a shared URL must never break the page.
 */
function parseDeepLinkDiffHighlight(search: string): ArchitectureDiffHighlight | null {
  const trimmed = search.trim();
  if (trimmed === '') return null;
  const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
  const strings = (name: string): string[] =>
    params.getAll(name).map((value) => value.trim()).filter((value) => value !== '');
  const pairs = (name: string): { from: string; to: string }[] =>
    strings(name)
      .map(parseDiffPair)
      .filter((pair): pair is { from: string; to: string } => pair !== null);

  const nodeIds = strings('diffNode');
  const edges = pairs('diffEdge');
  const packageIds = strings('diffPkg');
  const packageEdges = pairs('diffPkgEdge');
  if (nodeIds.length === 0 && edges.length === 0 && packageIds.length === 0 && packageEdges.length === 0) {
    return null;
  }
  return {
    ...(nodeIds.length === 0 ? {} : { nodeIds }),
    ...(edges.length === 0 ? {} : { edges }),
    ...(packageIds.length === 0 ? {} : { packageIds }),
    ...(packageEdges.length === 0 ? {} : { packageEdges }),
  };
}

/** How many distinct node/edge targets a highlight names, for the readout chip. */
function diffHighlightCounts(highlight: ArchitectureDiffHighlight): { nodes: number; edges: number } {
  const nodes = new Set([...(highlight.nodeIds ?? []), ...(highlight.packageIds ?? [])]).size;
  const edges = new Set(
    [...(highlight.edges ?? []), ...(highlight.packageEdges ?? [])]
      .map((edge) => `${edge.from}->${edge.to}`),
  ).size;
  return { nodes, edges };
}

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
export default function ArchitecturePanel({
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
  // Which of the two server subgraphs is on screen. Purely local state: both
  // arrive in one response, so this must never re-enter the fetch. The class
  // diagram is the shipped default (the entity subgraph is the one that has
  // entity kinds and members); a standalone link's `view` overrides it once.
  const [granularity, setGranularity] = useState<ArchitectureGranularity>(
    deepLinkGranularity ?? initialGranularity,
  );
  // The two display knobs, remembered per project (localStorage). `scope` is
  // the requested BFS depth — a server generation parameter and part of the
  // result cache's key, so changing it refetches; `detail` only ranks the
  // arrived payload, so changing it must never refetch. The pair is one state
  // object because a project switch reloads both together. A standalone link's
  // scope/detail win for the first paint, without being persisted.
  const [displaySettings, setDisplaySettings] = useState<ArchitectureDisplaySettings>(() => ({
    projectId,
    scope: initialDeepLink.scope ?? readStoredScope(projectId),
    detail: initialDeepLink.detail ?? readStoredDetail(projectId),
  }));
  // React's "adjust state when a prop changes" pattern: a project switch swaps
  // the remembered pair in the same render, so the graph is never requested
  // with the previous project's depth. The link's readings stay authoritative
  // for this standalone mount (the project id arrives after the first render).
  if (displaySettings.projectId !== projectId) {
    setDisplaySettings({
      projectId,
      scope: initialDeepLink.scope ?? readStoredScope(projectId),
      detail: initialDeepLink.detail ?? readStoredDetail(projectId),
    });
  }
  const { scope, detail } = displaySettings;
  // The element/relation filter pair. `filter` is what the reader selected and
  // what the drawing obeys; `requestFilter` is the selection the last SERVER
  // request was made with, which is what decides whether a change can be
  // filtered locally (narrowing) or must ask the server (widening). Both are
  // per project, like the scope/detail pair above.
  const [filterSettings, setFilterSettings] = useState<{
    projectId: string | null;
    filter: ArchitectureElementRelationFilter;
    requestFilter: ArchitectureElementRelationFilter;
  }>(() => {
    const stored = readStoredFilter(projectId);
    return { projectId, filter: stored, requestFilter: stored };
  });
  if (filterSettings.projectId !== projectId) {
    const stored = readStoredFilter(projectId);
    setFilterSettings({ projectId, filter: stored, requestFilter: stored });
  }
  const { filter, requestFilter } = filterSettings;

  // ---- Manual curation (pins / removals / hidden relations) ----------------
  // A counter bumped by another tab's `storage` event. Recreating the store is
  // how this tab adopts the other tab's pins/exclusions without a second write
  // path: the store reads localStorage once at creation, so a fresh instance
  // IS the new state. (Undo history is deliberately per tab and starts over.)
  const [curationStorageRevision, setCurationStorageRevision] = useState(0);
  // The store is per `(project, session)`: the graph's seeds are the session's
  // transcript, so a project has no curation of its own. A missing session
  // leaves `canEdit: false`, which disables the whole feature (and says why).
  const curationStore = useMemo(
    () => {
      // `curationStorageRevision` is the dependency that rebuilds the store when
      // another tab writes: the store reads localStorage once at creation, so a
      // fresh instance IS the adopted state. The read makes that intent explicit
      // to the hook's dependency checker.
      void curationStorageRevision;
      return createCurationStore({ storage: BROWSER_CURATION_STORAGE, projectId, sessionId });
    },
    [projectId, sessionId, curationStorageRevision],
  );
  const [curationState, setCurationState] = useState<ArchitectureCurationState>(
    () => curationStore.getState(),
  );
  useEffect(() => {
    setCurationState(curationStore.getState());
    return curationStore.subscribe(() => setCurationState(curationStore.getState()));
  }, [curationStore]);
  const canCurate = curationStore.canEdit;
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
  // The `已调整 N 项` manager and the one-node "only show this" display filter.
  const [curationManagerOpen, setCurationManagerOpen] = useState(false);
  // The disclosure that opened the manager, so Escape can return focus to it.
  const curationManagerButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeCurationManager = useCallback((): void => setCurationManagerOpen(false), []);
  useDismissiblePopover(
    curationManagerOpen,
    closeCurationManager,
    curationManagerButtonRef,
    '[data-architecture-curation-manager]',
  );
  const [soloNodeId, setSoloNodeId] = useState<string | null>(null);
  // A curation Toast: `undoable` renders the focusable 撤销 action. The
  // component pauses its own 6s timer while hovered/focused.
  const [curationToast, setCurationToast] = useState<{
    readonly id: number;
    readonly message: string;
    readonly undoable: boolean;
  } | null>(null);
  const curationToastSeq = useRef(0);
  const showCurationToast = useCallback((message: string, undoable = true): void => {
    curationToastSeq.current += 1;
    setCurationToast({ id: curationToastSeq.current, message, undoable });
  }, []);
  const dismissCurationToast = useCallback((): void => setCurationToast(null), []);

  // The granularity the last REQUEST was made for. The element axis does not
  // apply to the file graph, so switching views moves the request too — but the
  // drawing switches immediately (both subgraphs arrive in one response).
  const [requestGranularity, setRequestGranularity] = useState<ArchitectureGranularity>(
    deepLinkGranularity ?? initialGranularity,
  );
  // Another tab's change to this project's remembered knobs. `storage` fires
  // only in OTHER documents, so applying it here cannot echo back a write this
  // tab just made. Curation is adopted by recreating the store (above); the
  // scope/detail pair and the element/relation filter are plain state, so they
  // are re-read from the same storage keys the other tab wrote.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const projectFilterKey = `architecture.filter.${projectId ?? ''}`;
    const projectScopeKey = `architecture.scope.${projectId ?? ''}`;
    const projectDetailKey = `architecture.detail.${projectId ?? ''}`;
    const sessionCurationKey = curationStorageKey(projectId, sessionId);
    const onStorage = (event: StorageEvent): void => {
      // `key === null` is `localStorage.clear()`: every knob is gone, so every
      // reading has to be re-adopted rather than left describing deleted state.
      const cleared = event.key === null;
      if (cleared || event.key === projectFilterKey) {
        const stored = readStoredFilter(projectId);
        setFilterSettings({ projectId, filter: stored, requestFilter: stored });
        // The filter is a generation knob for the view on screen, so the next
        // read asks for the newly stored selection instead of the old one.
        setRequestGranularity(granularity);
      }
      if (cleared || event.key === projectScopeKey) {
        const stored = readStoredScope(projectId);
        setDisplaySettings((current) => ({ ...current, scope: stored }));
      }
      if (cleared || event.key === projectDetailKey) {
        const stored = readStoredDetail(projectId);
        setDisplaySettings((current) => ({ ...current, detail: stored }));
      }
      if (cleared || event.key === sessionCurationKey) {
        setCurationStorageRevision((revision) => revision + 1);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [projectId, sessionId, granularity]);
  // The filter popover; local like the legend and the export menu.
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  // The popover is drawn `position: fixed` on the desktop tier because the
  // toolbar scrolls horizontally and would clip an absolutely positioned panel.
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const [filterPosition, setFilterPosition] = useState<{ left: number; top: number } | null>(null);
  // Widening (or a view switch) is debounced: a reader walking the relation
  // presets should produce one request, not one per step.
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (filterDebounceRef.current !== null) clearTimeout(filterDebounceRef.current);
  }, []);
  const closeFilterMenu = useCallback((): void => setFilterMenuOpen(false), []);
  // Outside-press / Escape dismissal for every panel-owned popover: the menu
  // used to close only by pressing its own trigger again.
  useDismissiblePopover(filterMenuOpen, closeFilterMenu, filterButtonRef, '[data-architecture-filter-menu]');
  // The node under the pointer and its visible relation kinds, as reported by
  // the mounted renderer. Kept here so the readout is renderer-neutral; the key
  // names the graph the reading came from (session + granularity + scope), so
  // changing any of them discards the reading during render instead of via a
  // reset effect.
  const [hovered, setHovered] = useState<{ key: string; hover: ArchitectureRendererHover | null } | null>(null);
  const hoverKey = `${sessionId ?? ''}:${granularity}:${scope}`;
  // Stable while the same graph is on screen, so hovering never tears down the
  // renderer's effect; it only changes when the graph itself changes.
  const handleNodeHover = useCallback(
    (hover: ArchitectureRendererHover | null) => setHovered({ key: hoverKey, hover }),
    [hoverKey],
  );
  // The hint element whose size the placement measures, and the position it
  // settled on (`null` until measured). Essential state: the position is a
  // MEASURED relation between the hint and the drawing's package tabs, so it
  // cannot be derived from props during render.
  const hoverHintRef = useRef<HTMLSpanElement | null>(null);
  // The canvas region that holds the drawing. Declared here (not with the other
  // refs below) because the hover-hint effect reads it from this render on.
  const graphAreaRef = useRef<HTMLDivElement | null>(null);
  const [hoverHintPosition, setHoverHintPosition] = useState<{ left: number; top: number } | null>(null);
  // What the measured position belongs to. The hint's own text (and therefore
  // its width) changes with the hovered entity and its relation kinds, so the
  // placement is recomputed whenever any of those move.
  const hoverHintSignature = hovered !== null && hovered.key === hoverKey && hovered.hover !== null
    ? `${hoverKey}\u0000${hovered.hover.node.id}\u0000${hovered.hover.relations.join(',')}`
    : null;
  // The hint may not cover the drawing's own labels: package tabs are painted
  // along the top edge of every frame, and class names sit inside them. The
  // candidate walk and the avoidance live in `placeHoverHint`; this effect only
  // turns the live DOM into the rectangles it reads. It runs before paint, so
  // the hint never flashes at the pinned corner first.
  useLayoutEffect(() => {
    if (hoverHintSignature === null) {
      setHoverHintPosition(null);
      return;
    }
    const container = graphAreaRef.current;
    const hint = hoverHintRef.current;
    if (container === null || hint === null) return;
    const containerBox = container.getBoundingClientRect();
    const hintBox = hint.getBoundingClientRect();
    const rectsOf = (selector: string, root: ParentNode = container): ArchitectureHintRect[] => [...root.querySelectorAll(selector)]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
    const placement = placeHoverHint({
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
    setHoverHintPosition({ left: placement.left, top: placement.top });
  }, [hoverHintSignature]);
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
  // Whether the compact tier's bottom sheet is open. On that tier the panel
  // draws one header row (the view switch and `Adjust`); every other control
  // lives in this sheet, which is the phone's one menu.
  const [sheetOpen, setSheetOpen] = useState(false);
  // The control that opened the sheet. Closing the dialog returns focus here.
  const sheetTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The sheet body's DOM node while it is open. It is handed to the renderer
  // through `CompactToolbarSlotContext` so the graph's own controls are drawn
  // inside the same sheet instead of in a second toolbar row.
  const [sheetControlsHost, setSheetControlsHost] = useState<HTMLElement | null>(null);
  // The right-hand cell of the in-flow row above the canvas. The renderer
  // portals the zoom tier and its scale reading into it, so that chrome sits in
  // normal flow instead of floating over the drawing's first row. On the
  // compact tier the same slot lives INSIDE the sheet (the canvas keeps no
  // in-flow chrome row there).
  const [canvasHeaderHost, setCanvasHeaderHost] = useState<HTMLElement | null>(null);
  // A coarse pointer has no hover, so the touch instruction is shown once and
  // then dismissed — by its close button, by the first node selection, or by
  // its own fade-out. The choice is remembered per browser, so the bubble is a
  // genuine one-off rather than a row that returns on every mount.
  const [touchHintDismissed, setTouchHintDismissed] = useState<boolean>(readStoredTouchHintDismissed);
  const dismissTouchHint = useCallback((): void => {
    setTouchHintDismissed(true);
    writeStoredTouchHintDismissed();
  }, []);
  // The node the reader asked to see, and the token that re-triggers the same
  // request. The renderer navigates to it and centres it; the panel only holds
  // the request so a search hit survives the renderer's own navigation state.
  const [focusTarget, setFocusTarget] = useState<ArchitectureFocusTarget | null>(null);
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
  // Whether the touch multi-select mode is on. It makes every tap a toggle
  // instead of a replace; a long-press on an entity turns it on.
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  // Whether the selection tray is expanded. The panel owns it because Escape
  // collapses the tray before it clears the selection.
  const [trayExpanded, setTrayExpanded] = useState(false);
  // Whether the dock is on screen. It ALWAYS starts closed: the previous
  // browser-remembered value was the cause of a fresh entry opening a 320px
  // empty inspector ("Select a node …") and squeezing the canvas. Only a
  // gesture opens it — a fresh selection, or the toolbar's explicit Text door.
  const [dockOpen, setDockOpen] = useState(false);
  // The coarse drawer's height in CSS pixels, reported by the dock itself (it
  // alone knows which of the three snaps is in force). Two consumers need the
  // number: the selection tray is lifted above the drawer, and the drawing
  // reserves the band so the selected box is not hidden behind it. 0 when the
  // drawer is closed or the tier is the desktop dock.
  const [touchDrawerHeight, setTouchDrawerHeight] = useState(0);
  // True when the reader opened the dock THEMSELVES while nothing was
  // selected (the Text button). Only that kind of open may show an empty
  // inspector page; an open that a selection caused must close as soon as the
  // selection empties, so an empty dock never claims a column on its own.
  const [dockExplicitlyOpened, setDockExplicitlyOpened] = useState(false);
  // Which dock page is on screen. The shell owns the tablist; this state is the
  // half that makes a tab click reach the content. A fresh selection does not
  // switch pages: a reader looking at the text of the drawing they just
  // selected in keeps that page.
  const [dockTab, setDockTab] = useState<ArchitectureDockTabId>('inspector');
  // True while the dock's 160ms open/close transition runs. The renderer freezes
  // aspect-driven re-layout for that window (the dock narrows the canvas), then
  // re-bases without a layout — the toggle is never counted as a shape change.
  const [dockLayoutLocked, setDockLayoutLocked] = useState(false);
  const dockLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the sessions page searches tool output too. Off by default: the
  // tool-output tier is the noisy one, and the reader opts in per inspection.
  const [includeToolResults, setIncludeToolResults] = useState(false);
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
  // The one-line readout's expanded state: the explanation and the two knobs
  // ("raise detail", "reduce scope") live behind this toggle. Why state: the
  // portrait tier must start collapsed (its height budget) yet keep the
  // reader's expansion across a tab round trip, so the initial value reads the
  // session store and the effect below writes every change back.
  const [readoutOpen, setReadoutOpen] = useState<boolean>(
    () => portraitPhone && readReadoutExpandedInSession(),
  );
  useEffect(() => {
    if (!portraitPhone) return;
    try {
      window.sessionStorage.setItem(READOUT_EXPANDED_SESSION_KEY, readoutOpen ? 'true' : 'false');
    } catch {
      // Private mode: the choice still holds for this mount.
    }
  }, [portraitPhone, readoutOpen]);
  // The `?` legend popover; shut by default so the drawing owns the canvas.
  const [legendOpen, setLegendOpen] = useState(false);
  // The disclosure that opened the legend, so Escape can return focus to it.
  const legendButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeLegend = useCallback((): void => setLegendOpen(false), []);
  useDismissiblePopover(legendOpen, closeLegend, legendButtonRef, '[data-architecture-legend]');
  // The source line's unresolved-names list, expanded on demand rather than
  // printing every unresolved identifier as a permanent row.
  const [unresolvedOpen, setUnresolvedOpen] = useState(false);
  // Expansion state for the scope-cleanup row; it only exists for readings the
  // server reported a cleanup for, so a healthy project renders nothing here.
  const [scopeHygieneOpen, setScopeHygieneOpen] = useState(false);
  // The search box's text. It is local because it only filters the payload in
  // hand; selecting a result is what changes the graph.
  const [searchQuery, setSearchQuery] = useState('');
  // Whether the match list is open. Escape, choosing a result, or a press
  // outside the combobox closes it; a press on a result is inside the widget,
  // so it does not count as "outside".
  const [searchOpen, setSearchOpen] = useState(false);
  // The option the combobox's arrow keys moved onto, as an index into the
  // flattened option list (in-graph matches first, then project hits). -1 means
  // no active option, so Enter keeps its historical "first match" behaviour.
  // Essential (not derivable): it is the transient focus of a keyboard user.
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  // The combobox's DOM root and input. The outside-press listener needs the
  // root, and returning focus after Escape needs the input.
  const searchRootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // A press outside the combobox closes it WITHOUT swallowing the press (the
  // listener observes `mousedown`; the click still reaches its target). The
  // earlier contract required a second press on the box itself to close it.
  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      // A press inside the widget (input or an option) is not "outside".
      if (searchRootRef.current?.contains(event.target as Node) === true) return;
      setSearchOpen(false);
      setActiveSearchIndex(-1);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [searchOpen]);
  // The slice the mounted renderer is drawing. The renderer owns its view, so
  // it reports every navigation here; the export menu rebuilds exactly this
  // view instead of guessing from the last click.
  const [diagramView, setDiagramView] = useState<ArchitectureDiagramView>({ kind: 'overview' });
  // The aria-live reading of the last export (copied / downscaled / failed).
  // It is panel state, not menu state: the message must survive the menu closing.
  const [exportStatus, setExportStatus] = useState('');
  // The PlantUML text offered in the manual-copy dialog when the Clipboard API
  // is unavailable. `null` keeps the dialog shut.
  const [copyFallbackText, setCopyFallbackText] = useState<string | null>(null);
  // The model the renderer actually laid out and drew, reported by the mounted
  // renderer. The text page serializes THIS, so aggregated/folded shapes in the
  // drawing also appear in the copied document. Null while nothing is drawn or
  // when a stand-in renderer does not report a model (the text page then says
  // it is showing the bridge fallback).
  const [drawnPlantUml, setDrawnPlantUml] = useState<ArchitectureDrawnPlantUml | null>(null);
  // The same model, kept synchronously: the renderer reports it while it is
  // drawing, one React render before `drawnPlantUml` commits. The Export menu
  // reads this ref so a click that lands in that window still exports the
  // document the Text page will settle on, never the bridge spelling.
  const drawnPlantUmlRef = useRef<ArchitectureDrawnPlantUml | null>(null);
  const handleDrawnPlantUmlChange = useCallback((drawn: ArchitectureDrawnPlantUml | null): void => {
    drawnPlantUmlRef.current = drawn;
    setDrawnPlantUml(drawn);
  }, []);
  // The overlay root is the panel's own element: fullscreen restyles it in
  // place rather than mounting a second copy, so the renderer keeps its zoom
  // and the panel keeps every filter/scope/selection reading.
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  // Where focus returns when the overlay closes.
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const copyFallbackRef = useRef<HTMLTextAreaElement | null>(null);
  // A fallback dialog opens with its text already selected, so the documented
  // "select and copy" path is one keystroke rather than a drag.
  useEffect(() => {
    if (copyFallbackText === null) return;
    copyFallbackRef.current?.focus();
    copyFallbackRef.current?.select();
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
  // the keyboard reader is never left on a control the overlay covers.
  const wasFullscreenRef = useRef(false);
  useEffect(() => {
    if (fullscreenActive) {
      wasFullscreenRef.current = true;
      (graphAreaRef.current ?? panelRootRef.current)?.focus();
      return;
    }
    if (!wasFullscreenRef.current) return;
    wasFullscreenRef.current = false;
    fullscreenButtonRef.current?.focus();
  }, [fullscreenActive]);
  // A different session or project is a different reading: fullscreen must not
  // travel with the panel into it.
  useEffect(() => {
    exitFullscreen();
  }, [sessionId, projectId, exitFullscreen]);

  // Whether the drawing follows the container (Fit) or a scale the reader
  // chose. The renderer reports it; the fullscreen re-fit below is gated on it,
  // so entering/leaving the overlay never undoes a manual zoom. A ref, not
  // state: nothing renders from it, and the toggle's effect must read the
  // latest report without re-scheduling itself.
  const zoomModeRef = useRef<'fit' | 'custom'>('fit');
  const handleZoomModeChange = useCallback((mode: 'fit' | 'custom'): void => {
    zoomModeRef.current = mode;
  }, []);
  // A request to fit the drawing again, sent after a size change THIS panel
  // caused (the overlay turns the region into `fixed; inset: 0`). The token
  // makes each toggle its own request; null means no request was made yet.
  const [fitRequest, setFitRequest] = useState<ArchitectureFitRequest | null>(null);
  const fitTokenRef = useRef(0);
  // How much of the viewport-sized canvas the floating chrome (the toolbar and
  // the readout row) covers. Reserving it lets the renderer fit the drawing
  // BELOW the chrome instead of tucking its top row underneath it. 0 when the
  // chrome sits in normal flow (the in-tab layout), where it takes height from
  // the canvas rather than covering it.
  const [topChromePx, setTopChromePx] = useState(0);
  const readoutRowRef = useRef<HTMLDivElement | null>(null);
  const filledViewportMeasuredRef = useRef(false);
  // Whether the last render was viewport-filled. A TRANSITION (entering or
  // leaving fullscreen) always re-fits; the standalone page's fill is NOT a
  // transition, so its first fit waits for the reading that gives the chrome
  // rows their height.
  const lastFillsViewportRef = useRef(fillsViewport);
  useEffect(() => {
    const transitioned = lastFillsViewportRef.current !== fillsViewport;
    lastFillsViewportRef.current = fillsViewport;

    if (!fillsViewport) {
      if (!transitioned) return;
      // Back to the flex column: the drawing's height is the region's own again.
      filledViewportMeasuredRef.current = false;
      setTopChromePx(0);
      if (zoomModeRef.current !== 'fit') return;
      const frame = requestAnimationFrame(() => {
        fitTokenRef.current += 1;
        setFitRequest({
          token: fitTokenRef.current,
          viewportHeight: graphAreaRef.current?.getBoundingClientRect().height ?? 0,
        });
      });
      return () => cancelAnimationFrame(frame);
    }

    // The chrome rows live inside the loaded branch. Measuring before they
    // mount would read 0 and never re-measure — the defect that left the
    // standalone page's top row of nodes under the toolbar.
    if (view.status !== 'loaded') return;
    if (!transitioned && filledViewportMeasuredRef.current) return;
    // One frame after the toggle (or the first reading): the overlay's box, or
    // the region's return to the flex column, is laid out by then, so the fit
    // uses the settled size.
    const frame = requestAnimationFrame(() => {
      filledViewportMeasuredRef.current = true;
      // The readout row is the LAST in-flow chrome row (the toolbar sits above
      // it), so its bottom edge is the covered band's height.
      const chromeBottom = readoutRowRef.current?.getBoundingClientRect().bottom ?? 0;
      setTopChromePx(Math.ceil(chromeBottom));
      // A manual zoom is the reader's; only a fit may be re-issued.
      if (zoomModeRef.current !== 'fit') return;
      fitTokenRef.current += 1;
      setFitRequest({ token: fitTokenRef.current, viewportHeight: window.innerHeight });
    });
    return () => cancelAnimationFrame(frame);
  }, [fillsViewport, view.status]);

  const changeScope = (next: number): void => {
    const clamped = clampArchitectureScope(next);
    setDisplaySettings((current) => ({ ...current, scope: clamped }));
    writeStoredScope(projectId, clamped);
  };
  const changeDetail = (next: ArchitectureDetailTier): void => {
    setDisplaySettings((current) => ({ ...current, detail: next }));
    writeStoredDetail(projectId, next);
  };

  /**
   * Queue a request for a filter/view change, collapsing a walk through the
   * presets into one round-trip.
   */
  const scheduleRequest = (
    nextFilter: ArchitectureElementRelationFilter,
    nextGranularity: ArchitectureGranularity,
  ): void => {
    if (filterDebounceRef.current !== null) clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => {
      filterDebounceRef.current = null;
      setFilterSettings((current) => ({ ...current, requestFilter: nextFilter }));
      setRequestGranularity(nextGranularity);
    }, FILTER_REQUEST_DEBOUNCE_MS);
  };

  const cancelScheduledRequest = (): void => {
    if (filterDebounceRef.current === null) return;
    clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = null;
  };

  /**
   * Apply a new selection: show it now, then let the SERVER settle it.
   *
   * Both halves matter. The selection is written to state immediately, and
   * `displayFilter` below cuts the payload in hand, so the drawing narrows in
   * the same frame as the click — that is the "收窄即时" half of the design and
   * it stays.
   *
   * The request that follows is NOT optional, and it used to be skipped for a
   * narrowing. A locally narrowed payload cannot reproduce the server's own
   * reading of the narrower state: the server runs its BFS and its node budget
   * ON the filtered graph, so a node reachable only through a filtered-away
   * edge is absent from its answer, while the wider payload in hand still
   * carries it (and then counts it, or counts its isolated removal). The
   * summary therefore drifted from what a reload of the same state printed —
   * "9 related · 1 call relations · 11 isolated nodes" against "5 related ·
   * 601 call relations · 6 isolated nodes" — and stayed wrong until the page
   * was reloaded. Every settled selection now ends on a server reading; the
   * debounce still collapses a walk through the presets into one round trip.
   */
  const changeFilter = (next: ArchitectureElementRelationFilter): void => {
    setFilterSettings((current) => ({ ...current, filter: next }));
    writeStoredFilter(projectId, next);
    if (filtersEqual(next, requestFilter)) {
      // Already the request's own selection: the payload in hand IS this state.
      cancelScheduledRequest();
      return;
    }
    scheduleRequest(next, requestGranularity);
  };

  const changeGranularity = (next: ArchitectureGranularity): void => {
    setGranularity(next);
    // Both subgraphs are in hand, so the drawing switches now; the request only
    // follows because the element axis does not apply to the file graph.
    if (next !== requestGranularity) scheduleRequest(requestFilter, next);
  };

  // Search the CURRENT subgraph before the detail cut, so a node the tier
  // folded away is still findable and can be reported as out of range. The
  // search reads the payload BEFORE the element/relation filter: a node the
  // filter removed must still be listed (with the reason and a "Show it"
  // action) instead of the search silently returning nothing.
  const activeNodeIds = useMemo(
    () => new Set((activeNeighbourhood?.nodes ?? []).map((node) => node.id)),
    [activeNeighbourhood],
  );
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0 || rawNeighbourhood === null) return [];
    return rawNeighbourhood.nodes
      .filter((node) => node.id.toLowerCase().includes(query) || node.label.toLowerCase().includes(query))
      .slice(0, 8)
      .map((node) => {
        const inGraph = activeNodeIds.has(node.id);
        return {
          node,
          inGraph,
          // A node the detail tier folded away is "out of range"; a node the
          // filter removed is not even in the drawing (`inGraph` false).
          inRange: inGraph && (detailRanking?.retainedNodeIds.has(node.id) ?? false),
        };
      });
  }, [rawNeighbourhood, activeNodeIds, detailRanking, searchQuery]);

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
    setSoloNodeId(null);
    // "Reveal" includes SELECTING it: the search/inspector command must open
    // the inspector page and paint the node, not only scroll to it.
    dispatchSelection({ type: 'select-entity', nodeId });
    // `drill` is the ONLY thing that replaces the drawing with the entity's
    // neighbourhood; a plain reveal centres it in the drawing on screen.
    setFocusTarget((current) => ({ id: nodeId, token: (current?.token ?? 0) + 1, drill }));
    setSearchOpen(false);
  };

  // The standalone link's `entity`/`mode`: select and centre that node once the
  // reading that contains it has arrived, and drill only when the link says
  // `neighbourhood`. The ref makes this a FIRST-OPEN instruction — a reader who
  // later selects another node must not be dragged back by the URL.
  const deepLinkEntityAppliedRef = useRef<string | null>(null);
  // `revealNode` closes over state that changes every render; a ref keeps the
  // link's one-shot effect from re-running (and re-focusing) on every render.
  const revealNodeRef = useRef(revealNode);
  useEffect(() => {
    revealNodeRef.current = revealNode;
  });
  useEffect(() => {
    const entity = initialDeepLink.entity;
    if (entity === null || deepLinkEntityAppliedRef.current === entity) return;
    if (view.status !== 'loaded') return;
    // An id the current subgraph does not carry is ignored rather than focused
    // blindly: the renderer can only centre a node it draws.
    if (!view.result.graph[granularity].nodes.some((candidate) => candidate.id === entity)) return;
    deepLinkEntityAppliedRef.current = entity;
    // A folded node would be "selected" without being on screen; the link asked
    // for it, so the identity detail tier is the reading that honours the link.
    const folded = detailRanking !== null && !detailRanking.retainedNodeIds.has(entity);
    revealNodeRef.current(entity, folded, initialDeepLink.mode === 'neighbourhood');
  }, [initialDeepLink, view, granularity, detailRanking]);

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
    if (reportCurationRefusal(curationStore.pin(item))) return;
    setSearchOpen(false);
    setSearchQuery('');
    showCurationToast(t('architecture.curation.toastPinned', {
      defaultValue: 'Pinned {{name}}',
      name: label ?? item.name,
    }));
  }, [curationStore, reportCurationRefusal, showCurationToast, t]);

  const pinNode = useCallback((node: ArchitectureRendererNode): void => {
    pinItem(curationItemOf(node));
  }, [curationItemOf, pinItem]);

  const removeNode = useCallback((node: ArchitectureRendererNode): void => {
    if (reportCurationRefusal(curationStore.exclude(curationItemOf(node)))) return;
    showCurationToast(t('architecture.curation.toastRemoved', {
      defaultValue: 'Removed {{name}} from the graph',
      name: node.label.trim() === '' ? node.id : node.label,
    }));
  }, [curationItemOf, curationStore, reportCurationRefusal, showCurationToast, t]);

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
    if (reportCurationRefusal(curationStore.unpin(node.id))) return;
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
  }, [activeNeighbourhood, curationStore, reportCurationRefusal, showCurationToast, t]);

  const hideRelation = useCallback((edge: { from: string; to: string; relationType: string }): void => {
    if (reportCurationRefusal(
      curationStore.hideEdge({ from: edge.from, to: edge.to, type: edge.relationType }),
    )) return;
    showCurationToast(t('architecture.curation.toastRelationHidden', {
      defaultValue: 'Hid the relation — display only; the code is unchanged.',
    }));
  }, [curationStore, reportCurationRefusal, showCurationToast, t]);

  const undoCuration = useCallback((): void => {
    curationStore.undo();
    dismissCurationToast();
  }, [curationStore, dismissCurationToast]);

  const restoreItem = useCallback((group: 'pins' | 'excluded', id: string): void => {
    if (group === 'pins') curationStore.unpin(id);
    else curationStore.restore(id);
  }, [curationStore]);

  const restoreEdge = useCallback((edge: ArchitectureCurationHiddenEdge): void => {
    curationStore.showEdge(edge);
  }, [curationStore]);

  const restoreGroup = useCallback((group: ArchitectureCurationPage): void => {
    curationStore.restoreGroup(group);
  }, [curationStore]);

  const clearCurationItem = useCallback((group: 'pins' | 'excluded', id: string): void => {
    curationStore.clearItem(group, id);
  }, [curationStore]);

  // The project-wide search's second result group. It only runs with a session
  // (the shared storage key) and from two characters up (the endpoint's floor).
  const projectSearch = useProjectSearch(projectId, searchQuery, { enabled: canCurate });

  // Re-anchor saved items after a re-analysis. Entity ids can change while
  // `(file, name)` stays stable, so every loaded analysis resolves the saved
  // list once; unresolved items are marked stale instead of disappearing.
  const reconciledAnalysisRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canCurate || projectId === null || view.status !== 'loaded') return;
    const items = [...curationState.pins, ...curationState.excluded];
    if (items.length === 0) return;
    const analysisKey = `${projectId}\u0000${sessionId ?? ''}\u0000${
      view.result.provenance.generatedAt ?? ''
    }\u0000${JSON.stringify(view.result.provenance.fingerprints)}`;
    if (reconciledAnalysisRef.current === analysisKey) return;
    reconciledAnalysisRef.current = analysisKey;
    void (async () => {
      const resolved = await resolveCurationItems(
        projectId,
        items.map((item) => ({ name: item.name, file: item.file })),
      );
      // A failed request is not a re-analysis: keep the saved ids and try again
      // on the next load.
      if (resolved === null) {
        reconciledAnalysisRef.current = null;
        return;
      }
      curationStore.reconcile(resolved);
    })();
  }, [canCurate, projectId, sessionId, view, curationState.pins, curationState.excluded, curationStore]);

  // A scope change (view or session) clears the selection through the reducer.
  useEffect(() => {
    dispatchSelection({ type: 'sync-scope', scope: selectionScope });
  }, [selectionScope]);

  // ── the manual whole-project re-analysis ──────────────────────────────────
  // The status is shared server-side, so a tab opened while another session's
  // job is running shows that run. The dialog is the confirmation step; the
  // panel owns whether it is open and which control opened it (for focus return).
  const [refreshDialogOpen, setRefreshDialogOpen] = useState(false);
  const refreshReturnFocusRef = useRef<HTMLElement | null>(null);
  // Set when a refresh succeeds, consumed once the refetched reading is on
  // screen: the new analysis re-lays the graph, so the drawing is fitted again.
  const pendingRefreshFitRef = useRef(false);
  const handleRefreshSucceeded = useCallback((): void => {
    // A new analysis can change entity ids while `(file, name)` stays stable,
    // so the saved curation must be re-anchored on the NEXT reading.
    reconciledAnalysisRef.current = null;
    pendingRefreshFitRef.current = true;
    // The content-addressed cache is keyed by the manifest, so this is a real
    // refetch of the refreshed analysis rather than a cache hit.
    reload();
  }, [reload]);
  const refresh = useArchitectureRefresh(projectId, { onSucceeded: handleRefreshSucceeded });
  const refreshRunning = refresh.status.state === 'running';
  // A job failure and a transport failure are different faces of the same
  // dialog; the job's own reason wins when both exist.
  const refreshFailureReason = refresh.status.state === 'failed'
    ? refresh.status.error
    : refresh.requestError;
  const openRefreshDialog = useCallback((trigger: HTMLElement | null): void => {
    refreshReturnFocusRef.current = trigger;
    setRefreshDialogOpen(true);
  }, []);
  // A finished job closes the dialog on its own; the footer's updated time (and
  // a failed job's own reading) are the durable evidence.
  useEffect(() => {
    if (refresh.status.state === 'succeeded') setRefreshDialogOpen(false);
  }, [refresh.status.state]);
  useEffect(() => {
    if (!pendingRefreshFitRef.current) return;
    if (view.status !== 'loaded' || refreshing) return;
    pendingRefreshFitRef.current = false;
    // "Fit" after a refresh is the same reading the Fit control means: the
    // refreshed drawing is fitted even if the reader had zoomed the old one.
    zoomModeRef.current = 'fit';
    fitTokenRef.current += 1;
    setFitRequest({
      token: fitTokenRef.current,
      viewportHeight: graphAreaRef.current?.getBoundingClientRect().height ?? 0,
      force: true,
    });
  }, [view, refreshing]);

  /**
   * Open or close the dock and freeze aspect re-layout for the transition.
   * The lock is a plain boolean handed to the renderer; the panel owns its
   * lifetime because the panel owns the dock.
   */
  const changeDockOpen = useCallback((next: boolean): void => {
    setDockOpen(next);
    // Closing drops the explicit-open licence; the next open has to earn it
    // again (a fresh selection, or another press on the Text door).
    if (!next) setDockExplicitlyOpened(false);
    setDockLayoutLocked(true);
    if (dockLockTimerRef.current !== null) clearTimeout(dockLockTimerRef.current);
    dockLockTimerRef.current = setTimeout(() => {
      dockLockTimerRef.current = null;
      setDockLayoutLocked(false);
    }, DOCK_LAYOUT_LOCK_MS);
  }, []);

  /**
   * The reader's close gesture for the dock (×, Escape, the Text door toggling
   * itself shut). Closing the dock also clears the selection: the review found
   * that closing the inspector left the selection's dimming and highlight on
   * the drawing with no inspector open to explain it, and only a press on the
   * empty canvas cleared it.
   */
  const closeDock = useCallback((): void => {
    setMultiSelectMode(false);
    dispatchSelection({ type: 'clear' });
    changeDockOpen(false);
  }, [changeDockOpen]);
  useEffect(() => () => {
    if (dockLockTimerRef.current !== null) clearTimeout(dockLockTimerRef.current);
  }, []);

  // Selecting anything is a request to inspect it: a NEW selection opens the
  // dock AND lands on the Inspector page, whatever page the reader last used.
  // The review found a selection opening the remembered "Text" page, so the
  // inspector they asked for never appeared. Keyed on the selection alone:
  // closing the dock clears the selection in the same gesture, so this effect
  // can never immediately reopen it.
  const dockOpenRef = useRef(dockOpen);
  useEffect(() => {
    dockOpenRef.current = dockOpen;
  }, [dockOpen]);
  useEffect(() => {
    if (selection === null) return;
    setDockTab('inspector');
    if (!dockOpenRef.current) changeDockOpen(true);
  }, [selection, changeDockOpen]);

  // A different session (or project) is a different reading, and the dock's
  // open state is per reading: it must not travel into a page with nothing
  // selected in it. This was the "empty 320px inspector on entry" the sessions
  // showed when they had opened the dock earlier.
  useEffect(() => {
    setDockExplicitlyOpened(false);
    if (dockOpenRef.current) changeDockOpen(false);
  }, [sessionId, projectId, changeDockOpen]);

  // An open dock whose selection emptied (a filter hid the selected node, a
  // curation removed it, the scope reducer cleared it) would be an empty
  // column. Close it — unless the READER opened the dock themselves while
  // nothing was selected (the Text door), where the empty inspector page is a
  // page they asked to see.
  useEffect(() => {
    if (selection === null && !dockExplicitlyOpened && dockOpenRef.current) changeDockOpen(false);
  }, [selection, dockExplicitlyOpened, changeDockOpen]);

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
    setMultiSelectMode(true);
    dispatchSelection({ type: 'toggle-entity', nodeId: node.id });
  }, []);
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
   * `stopPropagation` happens in the renderer, so the chat page's global abort
   * never fires.
   */
  const escapeSelection = useCallback((): void => {
    if (trayExpanded) {
      setTrayExpanded(false);
      return;
    }
    if (dockOpen) {
      closeDock();
      return;
    }
    setMultiSelectMode(false);
    dispatchSelection({ type: 'clear' });
  }, [closeDock, dockOpen, trayExpanded]);
  /** A click on the empty canvas clears the selection AND closes the dock. */
  const clearSelectionOnCanvas = useCallback((): void => {
    dispatchSelection({ type: 'clear' });
    setMultiSelectMode(false);
    if (dockOpen) changeDockOpen(false);
  }, [dockOpen, changeDockOpen]);

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
    setTrayExpanded(false);
    setMultiSelectMode(false);
  }, [selections.length]);
  /** Selecting a related node from the inspector also centres it in the drawing. */
  const inspectRelatedNode = (nodeId: string): void => {
    revealNode(nodeId, false);
  };

  // A scope change can find more of the graph and then hide ALL of it behind
  // the element/relation filter: the drawing looks identical and the knob feels
  // dead. Remember the previous settled reading so the delta can be stated, and
  // offer the one click that makes those entities visible.
  //
  // Declared ABOVE the status branches: a hook added after a conditional
  // return changes the hook order when the panel leaves its loading state.
  type ScopeHiddenDelta = {
    readonly scope: number;
    readonly found: number;
    readonly kinds: readonly { readonly kind: ArchitectureEntityKind; readonly count: number }[];
    readonly relations: readonly { readonly type: string; readonly count: number }[];
  };
  const loadedResult = view.status === 'loaded' ? view.result : null;
  // `readout.related` is the pre-budget total; the truncation reading is the
  // same denominator and is available before the status narrowing.
  const scopeRelatedTotal = loadedResult === null
    ? 0
    : truncationReading(loadedResult, granularity).total;
  const scopeReadingRef = useRef<{
    scope: number;
    related: number;
    hidden: number;
    kinds: Readonly<Record<string, number>>;
    relations: Readonly<Record<string, number>>;
  } | null>(null);
  const [scopeHiddenDelta, setScopeHiddenDelta] = useState<ScopeHiddenDelta | null>(null);
  // The payload the previous reading was taken from. The scope STATE flips
  // before the new response arrives, so keying the comparison on it would
  // record the old numbers under the new scope and lose the delta.
  const scopeResultRef = useRef<ArchitectureGraphResult | null>(null);
  useEffect(() => {
    if (loadedResult === null) return;
    if (scopeResultRef.current === loadedResult) return;
    scopeResultRef.current = loadedResult;
    const current = {
      scope,
      related: scopeRelatedTotal,
      hidden: hiddenTotal(hiddenReading),
      kinds: { ...hiddenReading.byKind } as Record<string, number>,
      relations: { ...hiddenReading.byRelation },
    };
    const previous = scopeReadingRef.current;
    scopeReadingRef.current = current;
    if (previous === null) return;
    const found = current.related - previous.related;
    const hiddenDelta = current.hidden - previous.hidden;
    // Only an INCREASE in scope can produce "it found more and hid it"; any
    // other settled reading (a filter widening that revealed them, a smaller
    // scope) makes the notice stale, so it is cleared.
    if (scope <= previous.scope || found <= 0 || hiddenDelta < found) {
      setScopeHiddenDelta(null);
      return;
    }
    // Only the NEW removals belong to this transition, not the whole reading.
    const kinds = Object.entries(current.kinds)
      .map(([kind, count]) => ({ kind: kind as ArchitectureEntityKind, count: count - (previous.kinds[kind] ?? 0) }))
      .filter((entry) => entry.count > 0);
    const relations = Object.entries(current.relations)
      .map(([type, count]) => ({ type, count: count - (previous.relations[type] ?? 0) }))
      .filter((entry) => entry.count > 0);
    setScopeHiddenDelta({ scope, found, kinds, relations });
  }, [loadedResult, scope, scopeRelatedTotal, hiddenReading]);
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
    return (
      <div data-architecture-no-session="true">
        <ArchitectureEmptyState
          message={t('architecture.noSession', {
            defaultValue: 'Select a session to see the architecture of the files it touched.',
          })}
        />
        {/* Manual curation is stored per session, so without one the feature is
            disabled — and says why instead of offering dead controls. */}
        <p
          data-architecture-curation-disabled="true"
          className="px-6 pb-6 text-xs text-muted-foreground"
        >
          {t('architecture.curation.noSession', {
            defaultValue: 'Manual adjustments need a session: they are stored per session.',
          })}
        </p>
      </div>
    );
  }

  if (view.status === 'idle' || view.status === 'loading') {
    return (
      <div
        data-architecture-standalone={standalone ? 'true' : undefined}
        data-architecture-viewport-fill={fillsViewport ? 'true' : undefined}
        style={fillsViewport ? { position: 'fixed', inset: 0, zIndex: 60 } : undefined}
        className={fillsViewport ? 'flex flex-col overflow-hidden bg-background' : undefined}
      >
        {standaloneBackButton !== null && <div className="shrink-0 p-2">{standaloneBackButton}</div>}
        <p data-architecture-loading="true" className="p-6 text-sm text-muted-foreground">
          {t('architecture.loading', { defaultValue: 'Generating the architecture graph…' })}
        </p>
      </div>
    );
  }

  if (view.status === 'error') {
    return (
      <div
        data-architecture-standalone={standalone ? 'true' : undefined}
        data-architecture-viewport-fill={fillsViewport ? 'true' : undefined}
        style={fillsViewport ? { position: 'fixed', inset: 0, zIndex: 60 } : undefined}
        className={fillsViewport ? 'flex flex-col overflow-hidden bg-background' : undefined}
      >
        {standaloneBackButton !== null && <div className="shrink-0 p-2">{standaloneBackButton}</div>}
        <div className="p-6">
          <p data-architecture-error="true" role="alert" className="text-sm text-destructive">
            {view.message}
          </p>
          <button
            type="button"
            onClick={reload}
            className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.retry', { defaultValue: 'Retry' })}
          </button>
        </div>
      </div>
    );
  }

  const { result } = view;
  const { stats, mmd, provenance } = result;
  // A manual pin is a root of its own, so a curated request with no transcript
  // seeds still has something to draw.
  const hasSeeds = stats.seedFiles > 0 || stats.seedIdentifiers > 0 || pinnedIds.length > 0;
  const neighbourhood = result.graph[granularity];
  // A reading from the previous graph is not shown against this one.
  const visibleHover = hovered !== null && hovered.key === hoverKey ? hovered.hover : null;

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

  /**
   * Append the tray's composed text to the chat draft and switch to Chat.
   *
   * The write is deliberately an APPEND: the reader may already be half-way
   * through a message, and the tray adds context rather than replacing it. The
   * scope is the composer's own (`resolveDraftScope`), and the composer restores
   * the text through its draft subscription. Sending stays the reader's action.
   */
  const composeSelectionText = (text: string): void => {
    // The standalone page has no composer of its own. The same composed text
    // travels to the session's workspace tab, which owns the draft AND the tab
    // switch; without an answer there is nothing to append to, so the reader is
    // handed the text on the clipboard instead of a silent no-op.
    if (standalone) {
      void (async () => {
        const delivered = await sendArchitectureChatMessage({ sessionId, text });
        if (delivered) {
          showCurationToast(
            t('architecture.standalone.sent', {
              defaultValue: 'Sent to the session’s chat input',
            }),
            false,
          );
          return;
        }
        try {
          await navigator.clipboard?.writeText(text);
        } catch {
          // The toast below still tells the reader the tab could not be reached;
          // a refused clipboard is the browser's own limit, not something this
          // page can repair.
        }
        showCurationToast(
          t('architecture.standalone.copied', {
            defaultValue: 'Main session tab not reachable — copied to the clipboard',
          }),
          false,
        );
      })();
      return;
    }
    const scope = resolveDraftScope(projectId, sessionId);
    if (scope === null) return;
    const existing = readDraftText(scope);
    const appended = existing.trim() === '';
    writeDraftText(scope, appended ? text : `${existing}\n\n${text}`);
    onOpenChat?.();
    // The composer belongs to a sibling module; focus it through its documented
    // slot rather than importing the chat module into this one.
    window.setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>('textarea[data-slot="prompt-input-textarea"]')
        ?.focus();
    }, 0);
    showCurationToast(
      appended
        ? t('architecture.tray.toastAdded', { defaultValue: 'Put in the input box' })
        : t('architecture.tray.toastAppended', { defaultValue: 'Appended to the input box' }),
      false,
    );
  };

  /**
   * The selection message every non-tray entry point (the inspector's Adjust
   * row, the multi-select summary and the canvas context menu) appends.
   *
   * Built by the tray's own exported builder, so those three send the same
   * header, the same entity lines and the same relation lines the tray's
   * primary button would — the tray adds its memo and attachment on top.
   */
  const selectionMessageFor = (entries: readonly ArchitectureSelection[]): string =>
    buildSelectionMessage(
      {
        selections: entries,
        graph: drawnGraph,
        idShape: nodeIdShapeOf(granularity),
        projectName,
        projectId,
        analyzedAt: provenance.generatedAt,
      },
      t,
      i18n.language,
    );

  /** The shared "put the selection in the chat input" action. */
  const putSelectionInChat = (): void => {
    composeSelectionText(selectionMessageFor(selections));
  };

  /**
   * The canvas context menu's "Put in chat input". A right-click on an entity
   * that is already part of the selection sends the whole set; on any other
   * entity it sends that entity alone, making it the selection first so the
   * drawing and the message agree.
   */
  const putNodeInChat = (node: ArchitectureRendererNode): void => {
    const inSelection = selections.some((entry) => (entry.kind === 'entity'
      ? entry.nodeId === node.id
      : entry.from === node.id || entry.to === node.id));
    if (inSelection) {
      putSelectionInChat();
      return;
    }
    dispatchSelection({ type: 'select-entity', nodeId: node.id });
    composeSelectionText(selectionMessageFor([{ kind: 'entity', nodeId: node.id }]));
  };

  /** "Remove selected" walks the curation actions: exclude entities, hide relations. */
  const removeSelected = (): void => {
    for (const entry of selections) {
      if (entry.kind === 'entity') {
        const node = drawnGraph.nodes.find((candidate) => candidate.id === entry.nodeId);
        if (node !== undefined) removeNode(node);
      } else {
        hideRelation(entry);
      }
    }
    dispatchSelection({ type: 'clear' });
  };

  // A pin/unpin action on a single entity reads the same store the tray's
  // removal does, so the two can never disagree.
  const canComposeSelection = resolveDraftScope(projectId, sessionId) !== null;

  /**
   * The PlantUML document for the view on screen — the SAME document the Text
   * page's "Whole filtered graph" scope shows.
   *
   * Both entry points call {@link buildFullPlantUmlDocument} with the same graph,
   * view, grouping, id shape and drawn model (the renderer renders that model
   * with `detail: 'full'`, so its members are complete), which is what makes
   * the exported file and the copyable text byte-identical instead of two
   * spellings of the same drawing. Before a drawing exists the builder falls
   * back to the local bridge — the same fallback the text page takes, so the
   * two are still equal.
   */
  const currentPlantUml = (): string =>
    buildFullPlantUmlDocument(drawnGraph, {
      view: diagramView,
      grouping: granularity === 'file' ? 'adaptive' : 'raw',
      idShape: nodeIdShapeOf(granularity),
      drawn: drawnPlantUmlRef.current,
    }).text;

  /** The live drawing, read from the panel's own subtree at export time. */
  const renderedSvg = (): SVGSVGElement | null =>
    graphAreaRef.current?.querySelector<SVGSVGElement>('[data-architecture-plantuml] svg') ?? null;

  const artifactFilename = (extension: string): string =>
    architectureExportFilename(granularity, projectId, new Date(), extension);

  const exportPlantUml = (): void => {
    setExportStatus('');
    downloadTextFile(currentPlantUml(), artifactFilename('puml'));
  };

  const copyPlantUml = async (): Promise<void> => {
    const text = currentPlantUml();
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(text);
      setExportStatus(t('architecture.export.copied', { defaultValue: 'PlantUML copied to the clipboard' }));
    } catch {
      // Documented fallback: when the clipboard is unavailable, show the same
      // text selected in a dialog the reader can copy by hand.
      setCopyFallbackText(text);
    }
  };

  const exportSvg = (): void => {
    const svg = renderedSvg();
    if (svg === null) {
      setExportStatus(t('architecture.export.notReady', { defaultValue: 'The diagram is not ready to export yet.' }));
      return;
    }
    setExportStatus('');
    downloadTextFile(serializeSvgForExport(svg), artifactFilename('svg'), 'image/svg+xml;charset=utf-8');
  };

  const exportPng = async (): Promise<void> => {
    const svg = renderedSvg();
    const natural = svg === null ? null : readSvgNaturalSize(svg);
    if (svg === null || natural === null) {
      setExportStatus(t('architecture.export.notReady', { defaultValue: 'The diagram is not ready to export yet.' }));
      return;
    }
    setExportStatus('');
    const target = pngTargetSize(natural);
    try {
      const blob = await rasterizeSvgToPng(serializeSvgForExport(svg), target);
      downloadBlob(blob, artifactFilename('png'));
      if (target.downscaled) {
        setExportStatus(t('architecture.export.pngScaled', {
          defaultValue: 'The PNG was scaled down so its longest side is {{edge}} px.',
          edge: EXPORT_PNG_MAX_EDGE,
        }));
      }
    } catch {
      setExportStatus(t('architecture.export.pngFailed', { defaultValue: 'The PNG could not be created.' }));
    }
  };

  // The Mermaid pair is the LEGACY export and deliberately unchanged: the same
  // server-returned document under the same pre-menu filename.
  const exportMermaid = (): void => {
    setExportStatus('');
    downloadTextFile(granularity === 'file' ? mmd.file : mmd.entity, `architecture-${granularity}.mmd`);
  };

  const exportMenu = (
    <ArchitectureExportMenu
      compact={compactToolbar}
      onExportPlantUml={exportPlantUml}
      onCopyPlantUml={() => {
        void copyPlantUml();
      }}
      onExportSvg={exportSvg}
      onExportPng={() => {
        void exportPng();
      }}
      onExportMermaid={exportMermaid}
      onAction={() => setSheetOpen(false)}
    />
  );

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

  /**
   * The toolbar's door to the text page. The dock otherwise opens only on a
   * selection, but the whole-graph text is exactly what a reader wants with
   * nothing selected — so the page gets its own entry, and it toggles: while
   * the dock shows this page, pressing it closes the dock.
   */
  const textToggle = (
    <button
      type="button"
      aria-expanded={dockOpen && dockTab === 'text'}
      onClick={() => {
        if (dockOpen && dockTab === 'text') {
          closeDock();
          return;
        }
        setDockTab('text');
        // This is the reader's own door, so the open is explicit: with nothing
        // selected it may legitimately show the empty inspector page.
        setDockExplicitlyOpened(true);
        if (!dockOpen) changeDockOpen(true);
      }}
      data-architecture-text-toggle="true"
      style={compactTargetStyle}
      className={`${compactHeaderButtonClass} border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      {t('architecture.text.open', { defaultValue: 'Text' })}
    </button>
  );

  /**
   * The overlay's one control. It carries an icon AND the visible word (the
   * icon alone is not a label), flips to "Exit fullscreen" while the overlay is
   * up, and lives on both toolbar tiers: on the compact row it sits OUTSIDE the
   * Adjust sheet, so entering the overlay never asks the reader to open a
   * sheet first.
   */
  const fullscreenButton = (
    <button
      ref={fullscreenButtonRef}
      type="button"
      aria-pressed={fullscreen.active}
      aria-label={
        fullscreen.active
          ? t('architecture.fullscreen.exit', { defaultValue: 'Exit fullscreen' })
          : t('architecture.fullscreen.enter', { defaultValue: 'Fullscreen' })
      }
      onClick={fullscreen.toggle}
      data-architecture-fullscreen-toggle="true"
      data-architecture-fullscreen-active={fullscreen.active ? 'true' : undefined}
      style={compactTargetStyle}
      className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      {fullscreen.active
        ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
        : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
      <span>
        {fullscreen.active
          ? t('architecture.fullscreen.exit', { defaultValue: 'Exit fullscreen' })
          : t('architecture.fullscreen.enter', { defaultValue: 'Fullscreen' })}
      </span>
    </button>
  );

  /**
   * The compact tier's one menu button. It is the row's rightmost control
   * normally, and in the fullscreen overlay it is one of only two: the view
   * switch and the Text page move INSIDE the sheet there, so the overlay spends
   * one 56px row on chrome instead of the two 44px rows that used to cover the
   * drawing's top nodes.
   */
  const adjustButton = (
    <button
      ref={sheetTriggerRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
      aria-label={t('architecture.sheet.open', { defaultValue: 'Adjust' })}
      onClick={() => setSheetOpen(true)}
      data-architecture-sheet-toggle="true"
      style={compactTargetStyle}
      className={`${compactHeaderButtonClass} rounded-lg border border-border text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      {t('architecture.sheet.open', { defaultValue: 'Adjust' })}
    </button>
  );

  /**
   * The view on screen, as the standalone link describes it.
   *
   * The panel is the only layer that knows which subgraph, depth, tier and
   * selection are current, so "Open in new tab" states the reading here rather
   * than letting the route guess. `entity` prefers the current selection and
   * falls back to the entity a drilled neighbourhood is centred on;
   * `mode=neighbourhood` is written only when the drawing IS that drill.
   */
  const currentDeepLinkState = (): ArchitectureDeepLinkState => ({
    view: granularity === 'entity' ? 'class' : 'file',
    scope,
    detail,
    entity: selection?.kind === 'entity'
      ? selection.nodeId
      : diagramView.kind === 'neighborhood'
        ? diagramView.entityId
        : null,
    mode: diagramView.kind === 'neighborhood' ? 'neighbourhood' : null,
  });

  /**
   * The toolbar's door to a standalone page for the SAME reading.
   *
   * The href is built from the current pathname so the deployment's router
   * basename survives, and carries only the FIRST-paint parameters; the new tab
   * shares the project's remembered knobs through localStorage afterwards. Also
   * offered in the fullscreen overlay, where a reader is most likely to want
   * the drawing on a second screen.
   */
  const openInNewTab = (): void => {
    if (sessionId === null || typeof window === 'undefined') return;
    const href = buildArchitectureStandaloneHref({
      pathname: window.location.pathname,
      sessionId,
      state: currentDeepLinkState(),
    });
    window.open(href, '_blank', 'noopener');
  };

  const openInNewTabButton = (
    <button
      type="button"
      onClick={openInNewTab}
      disabled={sessionId === null}
      aria-label={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
      title={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
      data-architecture-open-in-new-tab="true"
      style={compactTargetStyle}
      className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
      {!compactToolbar && (
        <span>{t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}</span>
      )}
    </button>
  );

  /**
   * The same door in the portrait Adjust sheet. The sheet stacks full-width
   * rows, so the entry states its name instead of the toolbar's icon alone —
   * an unlabelled external-link glyph is not a readable "Open in new tab".
   */
  const openInNewTabSheetButton = (
    <button
      type="button"
      onClick={openInNewTab}
      disabled={sessionId === null}
      aria-label={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
      data-architecture-open-in-new-tab="true"
      style={compactTargetStyle}
      className={`${headerButtonClass} inline-flex items-center justify-start gap-2 border border-border text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
      <span>{t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}</span>
    </button>
  );

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
  const granularityGroup = (
    <div
      role="radiogroup"
      aria-label={t('architecture.granularity', { defaultValue: 'Graph granularity' })}
      data-architecture-view-control="true"
      style={{ gap: compactToolbar ? TOUCH_CONTROL_GAP_PX : 4 }}
      className="flex items-center rounded-lg border border-border/60 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={granularity === 'entity'}
        onClick={() => changeGranularity('entity')}
        data-architecture-view-option="entity"
        style={compactTargetStyle}
        className={`${compactHeaderButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          granularity === 'entity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('architecture.controls.classView', { defaultValue: 'Class diagram' })}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={granularity === 'file'}
        onClick={() => changeGranularity('file')}
        data-architecture-view-option="file"
        style={compactTargetStyle}
        className={`${compactHeaderButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          granularity === 'file' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('architecture.fileGraph', { defaultValue: 'File graph' })}
      </button>
    </div>
  );

  // Scope is the server-side generation parameter (the old Hops 1/2/3), so this
  // control re-enters the fetch like the toggle it replaces. The readout is a
  // real spinbutton: `＋2` is the value, and the arrow keys (or the two step
  // buttons) move it, with the range clamped to 0..3 at both ends.
  const scopeGroup = (
    <div
      role="group"
      aria-label={t('architecture.controls.scope', { defaultValue: 'Scope' })}
      data-architecture-scope-control="true"
      style={{ gap: compactToolbar ? TOUCH_CONTROL_GAP_PX : 4 }}
      className="flex items-center rounded-lg border border-border/60 p-0.5"
    >
      <button
        type="button"
        aria-label={t('architecture.controls.scopeDecrease', { defaultValue: 'Decrease scope' })}
        data-architecture-scope-decrease="true"
        onClick={() => changeScope(scope - 1)}
        disabled={scope <= ARCHITECTURE_SCOPE_MIN}
        style={compactTargetStyle}
        // A visible border is what makes the `−`/`+` read as buttons rather
        // than stray glyphs; the 44px box is the touch target.
        className={`${headerButtonClass} border border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
      >
        −
      </button>
      <span
        role="spinbutton"
        tabIndex={0}
        aria-label={t('architecture.controls.scope', { defaultValue: 'Scope' })}
        aria-valuenow={scope}
        aria-valuemin={ARCHITECTURE_SCOPE_MIN}
        aria-valuemax={ARCHITECTURE_SCOPE_MAX}
        aria-valuetext={`+${scope}`}
        data-architecture-scope-value={scope}
        style={compactTargetStyle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            changeScope(scope + 1);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault();
            changeScope(scope - 1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            changeScope(ARCHITECTURE_SCOPE_MIN);
          } else if (event.key === 'End') {
            event.preventDefault();
            changeScope(ARCHITECTURE_SCOPE_MAX);
          }
        }}
        // The reading is vertically centred in its own box: `+2` used to sit
        // higher than the `−`/`+` glyphs beside it.
        className={`inline-flex min-w-8 items-center justify-center rounded px-1 text-center tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          coarsePointer ? 'text-sm' : 'text-xs'
        }`}
      >
        +{scope}
      </span>
      <button
        type="button"
        aria-label={t('architecture.controls.scopeIncrease', { defaultValue: 'Increase scope' })}
        data-architecture-scope-increase="true"
        onClick={() => changeScope(scope + 1)}
        disabled={scope >= ARCHITECTURE_SCOPE_MAX}
        style={compactTargetStyle}
        className={`${headerButtonClass} border border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
      >
        +
      </button>
    </div>
  );

  // Detail only re-ranks the payload already in hand: switching it must never
  // re-enter the fetch. The three presets trade completeness for readability;
  // the transcript's seeds survive every one of them. Each `t()` call names its
  // key literally so the locale-completeness test extracts it from this source.
  const detailButtonClass = (tier: ArchitectureDetailTier): string =>
    `${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
      detail === tier ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
    }`;
  // The detail knob only re-ranks what is already drawn, so on a graph where no
  // tier can fold anything it is a dead control. Saying so on the buttons is
  // better than the reader concluding the knob is broken.
  const detailNothingToTrim = displayNeighbourhood !== null
    && ARCHITECTURE_DETAIL_TIERS.every((tier) =>
      rankArchitectureDetail(displayNeighbourhood.nodes, displayNeighbourhood.edges, tier)
        .retainedNodeIds.size >= displayNeighbourhood.nodes.length);
  const detailNoChangeLabel = t('architecture.copyFix.detailNoChange', {
    defaultValue: 'No change: nothing more can be trimmed within the current scope',
  });
  const detailNoChangeProps = detailNothingToTrim
    ? { title: detailNoChangeLabel, 'data-architecture-detail-no-change': 'true' }
    : {};
  const detailGroup = (
    <div
      role="radiogroup"
      aria-label={t('architecture.controls.detail', { defaultValue: 'Detail' })}
      data-architecture-detail-control="true"
      style={{ gap: compactToolbar ? TOUCH_CONTROL_GAP_PX : 4 }}
      className="flex items-center rounded-lg border border-border/60 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={detail === 'core'}
        aria-label={t('architecture.controls.detailCore', { defaultValue: 'Core' })}
        data-architecture-detail-option="core"
        onClick={() => changeDetail('core')}
        style={compactTargetStyle}
        className={detailButtonClass('core')}
        {...detailNoChangeProps}
      >
        {t('architecture.controls.detailCore', { defaultValue: 'Core' })}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={detail === 'common'}
        aria-label={t('architecture.controls.detailCommon', { defaultValue: 'Common' })}
        data-architecture-detail-option="common"
        onClick={() => changeDetail('common')}
        style={compactTargetStyle}
        className={detailButtonClass('common')}
        {...detailNoChangeProps}
      >
        {t('architecture.controls.detailCommon', { defaultValue: 'Common' })}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={detail === 'all'}
        aria-label={t('architecture.controls.detailAll', { defaultValue: 'All' })}
        data-architecture-detail-option="all"
        onClick={() => changeDetail('all')}
        style={compactTargetStyle}
        className={detailButtonClass('all')}
        {...detailNoChangeProps}
      >
        {t('architecture.controls.detailAll', { defaultValue: 'All' })}
      </button>
    </div>
  );

  /**
   * The filter popover's CONTENT, independent of the container that hosts it.
   * The desktop tier draws it under the `Filter ▾` disclosure; the compact tier
   * draws the same fragment inside the panel's overflow sheet (the mobile
   * bottom-drawer container is a later task's business, and this content must
   * not know about it).
   */
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
  const filterContent = (
    <div data-architecture-filter-panel="true" className="flex flex-col gap-2 text-xs">
      {/* The element axis does not exist on the file graph: a file has no
          kind, so the section is not drawn there (rather than drawn disabled). */}
      {granularity === 'entity' && (
        <fieldset data-architecture-filter-elements="true" className="flex flex-col gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t('architecture.filter.elements', { defaultValue: 'Elements' })}
          </legend>
          <div className="flex flex-wrap" style={{ gap: coarsePointer ? TOUCH_CONTROL_GAP_PX : 4 }}>
            {ARCHITECTURE_ELEMENT_KINDS.map((kind) => {
              const count = stats.kindCounts?.[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  role="checkbox"
                  aria-checked={filter.kinds.includes(kind)}
                  data-architecture-filter-kind={kind}
                  data-architecture-filter-kind-count={count === undefined ? '' : String(count)}
                  onClick={() => toggleKind(kind)}
                  style={compactTargetStyle}
                  className={`rounded border px-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                    filter.kinds.includes(kind)
                      ? 'border-primary/60 bg-accent text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {/* The on/off state is a glyph, not only a fill shade. */}
                  <span aria-hidden="true" className="mr-1">{filter.kinds.includes(kind) ? '☑' : '☐'}</span>
                  {count === undefined ? kindLabel(kind) : `${String(count)} ${kindLabel(kind)}`}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {granularity === 'entity' && mentionedKinds.length > 0 && (
        <fieldset data-architecture-filter-mentioned="true" className="flex flex-col gap-1">
          <legend className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t('architecture.filter.mentioned', { defaultValue: 'Mentioned in this session' })}
          </legend>
          <p
            id={MENTIONED_HINT_ID}
            data-architecture-filter-mentioned-hint="true"
            className="text-[10px] text-muted-foreground"
          >
            {t('architecture.filter.mentionedHint', {
              defaultValue: 'Keep these shown even when their kind is hidden',
            })}
          </p>
          <div className="flex flex-wrap" style={{ gap: coarsePointer ? TOUCH_CONTROL_GAP_PX : 4 }}>
            {mentionedKinds.map((kind) => {
              const count = mentionedKindCounts[kind] ?? 0;
              const on = filter.keepMentionedKinds.includes(kind);
              // The visible text is "35 functions"; the accessible name must
              // START with exactly that (WCAG "label in name") and leave the
              // extra explanation to `aria-describedby`.
              const visible = `${String(count)} ${kindLabel(kind)}`;
              return (
                <button
                  key={kind}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={`${visible}, ${t('architecture.filter.mentionedToggleAria', {
                    defaultValue: 'mentioned in this session, kept visible even when the kind is hidden',
                  })}`}
                  aria-describedby={MENTIONED_HINT_ID}
                  data-architecture-filter-mentioned-kind={kind}
                  data-architecture-filter-mentioned-kind-count={String(count)}
                  onClick={() => toggleKeepMentioned(kind)}
                  style={compactTargetStyle}
                  className={`flex items-center gap-1 rounded border px-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                    on
                      ? 'border-primary/60 bg-accent text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {/* The state is carried by a glyph AND the background, so it
                      does not depend on colour alone. */}
                  <span aria-hidden="true">{on ? '☑' : '☐'}</span>
                  {`${String(count)} ${kindLabel(kind)}`}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div
        role="radiogroup"
        aria-label={t('architecture.filter.relations', { defaultValue: 'Relations' })}
        data-architecture-filter-relations="true"
        className="flex flex-col gap-1"
      >
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('architecture.filter.relations', { defaultValue: 'Relations' })}
        </span>
        <div className="flex flex-wrap" style={{ gap: coarsePointer ? TOUCH_CONTROL_GAP_PX : 4 }}>
          {ARCHITECTURE_RELATION_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={filter.relations === preset}
              data-architecture-filter-relation={preset}
              onClick={() => changeFilter({
                ...filter,
                relations: preset,
                // The isolated toggle follows the preset's own default: a
                // narrowed relation set makes isolated nodes an artefact of the
                // filter, while "every relation" makes isolation a real fact.
                hideIsolated: preset !== 'call',
              })}
              style={compactTargetStyle}
              className={`rounded border px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                filter.relations === preset
                  ? 'border-primary/60 bg-accent text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {/* A radio's selected state is a glyph too, so it survives a
                  colour-blind reader and a low-contrast theme. */}
              <span aria-hidden="true" className="mr-1">{filter.relations === preset ? '✓' : '○'}</span>
              {relationPresetLabel(preset)}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        role="checkbox"
        aria-checked={filter.hideIsolated}
        data-architecture-filter-isolated="true"
        onClick={() => changeFilter({ ...filter, hideIsolated: !filter.hideIsolated })}
        style={compactTargetStyle}
        className="flex items-center gap-1 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span aria-hidden="true">{filter.hideIsolated ? '☑' : '☐'}</span>
        {t('architecture.filter.isolated', { defaultValue: 'Hide isolated nodes' })}
      </button>

      {/* The way back to this project's shipped selection. It lives in the
          popover as well as in the readout row because the popover is where the
          reader made the changes; a sequence of switches has no other one-click
          undo, and the row is only drawn while something is hidden. */}
      <button
        type="button"
        data-architecture-filter-reset="true"
        onClick={() => changeFilter(resetFilter())}
        style={compactTargetStyle}
        className="mt-1 self-start rounded border border-border px-2 py-0.5 text-left text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {t('architecture.filter.reset', { defaultValue: '↺ Reset filters' })}
      </button>
    </div>
  );

  const filterTriggerLabel = t('architecture.filter.menu', { defaultValue: 'Filter ▾' });
  const filterBadge = activeFilterCount(filter);
  // "Keeping N" is the OPPOSITE direction from "Hiding N": opening a "keep
  // mentioned" switch shows more, so it must never raise the hidden count. The
  // badge states the two readings separately.
  const filterKept = keptMentionedCount(filter);
  // The badge counts DECISIONS THAT HIDE SOMETHING, not "options that are on".
  // The default filter has every kind enabled except functions/others, so the
  // old "4 on" read as four visible things while four cuts were in force.
  const filterBadgeAria = filterKept === 0
    ? t('architecture.copyFix.filterBadgeAria', {
      defaultValue: '{{count}} filter decisions are hiding content (elements, relations, isolated nodes)',
      count: filterBadge,
    })
    : t('architecture.copyFix.filterBadgeKeepingAria', {
      defaultValue: '{{count}} filter decisions are hiding content; {{kept}} kinds are kept visible',
      count: filterBadge,
      kept: filterKept,
    });
  const openFilterMenu = (): void => {
    if (!compactToolbar) {
      const rect = filterButtonRef.current?.getBoundingClientRect();
      if (rect !== undefined) setFilterPosition({ left: Math.max(8, rect.left), top: rect.bottom + 4 });
    }
    setFilterMenuOpen(true);
  };
  const filterDisclosure = (
    <div className={compactToolbar ? 'flex flex-col gap-1' : 'relative'} data-architecture-filter-root="true">
      <button
        ref={filterButtonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={filterMenuOpen}
        onClick={() => {
          if (filterMenuOpen) setFilterMenuOpen(false);
          else openFilterMenu();
        }}
        data-architecture-filter-toggle="true"
        style={compactTargetStyle}
        className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
          compactToolbar ? 'px-3 py-2 text-left text-sm' : 'px-2 py-0.5 text-xs'
        }`}
      >
        {filterTriggerLabel}
        <span
          data-architecture-filter-badge={filterBadge}
          title={filterBadgeAria}
          aria-label={filterBadgeAria}
          className="ml-1 rounded-full bg-accent px-1.5 text-[10px] tabular-nums text-foreground"
        >
          {filterKept === 0
            ? t('architecture.copyFix.filterBadge', { defaultValue: 'Hiding {{count}}', count: filterBadge })
            : t('architecture.copyFix.filterBadgeKeeping', {
              defaultValue: 'Hiding {{count}} · keeping {{kept}}',
              count: filterBadge,
              kept: filterKept,
            })}
        </span>
      </button>
      {filterMenuOpen && (
        <div
          role="group"
          aria-label={filterTriggerLabel}
          data-architecture-filter-menu="true"
          style={compactToolbar ? undefined : (filterPosition ?? { left: 8, top: 56 })}
          onKeyDown={(event) => {
            // Escape belongs to this panel while it is open; stopping it keeps
            // the chat page's document-level abort out of the interaction.
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setFilterMenuOpen(false);
          }}
          className={
            compactToolbar
              ? 'flex flex-col gap-1 rounded-lg border border-border bg-popover p-2'
              : 'fixed z-50 flex w-80 flex-col gap-1 rounded-lg border border-border bg-popover p-2 shadow-lg'
          }
        >
          {filterContent}
        </div>
      )}
    </div>
  );

  // The project-wide search's kind glyph. The same vocabulary the inspector
  // prints, kept local so the toolbar row stays a one-line reading.
  const searchKindGlyph = (kind: ArchitectureEntityKind | undefined): string => {
    switch (kind) {
      case 'interface':
        return 'I';
      case 'enum':
        return 'E';
      case 'abstract':
        return 'A';
      case 'function':
        return 'ƒ';
      case 'class':
        return 'C';
      default:
        return '•';
    }
  };

  // The search box. It draws TWO groups: "图中" (local matches, handled by
  // revealing/focusing an arrived node) and, with a session, "项目其它" — the
  // project-wide index behind the `＋` pin action. The second group appears
  // only from two characters up, the endpoint's own floor.
  //
  // The widget is a real combobox: the input carries `role="combobox"` and
  // `aria-activedescendant`, the results are a `listbox` of `option`s, the
  // arrow keys move the active option and Enter chooses it. The first options
  // are the in-graph matches; the project-wide hits follow in the same list.
  const projectHits = canCurate
    && searchQuery.trim().length >= 2
    && projectSearch.search.status === 'ready'
    ? projectSearch.search.results
    : [];
  const searchOptionCount = searchMatches.length + projectHits.length;
  const searchListId = 'architecture-search-listbox';
  const searchOptionId = (index: number): string => `architecture-search-option-${index}`;
  const moveSearchActive = (delta: number): void => {
    if (searchOptionCount === 0) return;
    setActiveSearchIndex((current) => {
      if (current < 0) return delta > 0 ? 0 : searchOptionCount - 1;
      return (current + delta + searchOptionCount) % searchOptionCount;
    });
  };
  const chooseSearchOption = (index: number, drill: boolean): void => {
    if (index < searchMatches.length) {
      const match = searchMatches[index];
      // A match the filter removed is not drawn yet: "Show it" first, then
      // centre/select it. A drawn match is centred in place; only `drill` (the
      // explicit "view neighbourhood" command) replaces the drawing.
      if (!match.inGraph) showHiddenSearchMatch(match);
      else revealNode(match.node.id, !match.inRange, drill);
    } else {
      const hit = projectHits[index - searchMatches.length];
      if (hit !== undefined) pinItem(hit);
    }
    setSearchOpen(false);
    setActiveSearchIndex(-1);
  };
  const searchBox = (
    <div ref={searchRootRef} className="relative" data-architecture-search-root="true">
      <input
        ref={searchInputRef}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={searchOpen && searchQuery.trim().length > 0}
        aria-controls={searchListId}
        aria-activedescendant={activeSearchIndex >= 0 && searchOpen ? searchOptionId(activeSearchIndex) : undefined}
        value={searchQuery}
        aria-label={t('architecture.search.label', { defaultValue: 'Search entities or files' })}
        placeholder={t('architecture.search.placeholder', { defaultValue: 'Search entities or files…' })}
        data-architecture-search="true"
        style={compactToolbar ? TOUCH_TARGET_STYLE : undefined}
        onChange={(event) => {
          setSearchQuery(event.target.value);
          setSearchOpen(true);
          setActiveSearchIndex(-1);
        }}
        onFocus={() => {
          setSearchOpen(true);
          setActiveSearchIndex(-1);
        }}
        onBlur={(event) => {
          // Focus moving INTO the listbox (a result press) keeps it open; any
          // other focus loss closes it.
          if (searchRootRef.current?.contains(event.relatedTarget as Node | null) === true) return;
          setSearchOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(false);
            setActiveSearchIndex(-1);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveSearchActive(1);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveSearchActive(-1);
            return;
          }
          if (event.key !== 'Enter') return;
          // Enter centres and selects the match IN the drawing on screen;
          // Shift+Enter is the explicit "open its neighbourhood" command.
          if (activeSearchIndex >= 0) {
            event.preventDefault();
            chooseSearchOption(activeSearchIndex, event.shiftKey);
            return;
          }
          if (searchMatches.length > 0) {
            event.preventDefault();
            chooseSearchOption(0, event.shiftKey);
          }
        }}
        className={`rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          compactToolbar ? 'w-full text-sm' : 'w-40'
        }`}
      />
      {projectSearch.search.status === 'loading' && (
        <span
          data-architecture-search-loading="true"
          aria-hidden="true"
          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground"
        />
      )}
      {searchOpen && searchQuery.trim().length > 0 && (
        <div
          id={searchListId}
          role="listbox"
          aria-label={t('architecture.search.label', { defaultValue: 'Search entities or files' })}
          data-architecture-search-results="true"
          className="absolute left-0 top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          <p
            data-architecture-search-group="in-graph"
            className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t('architecture.search.inGraph', { defaultValue: 'In the graph' })}
          </p>
          {searchMatches.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              {t('architecture.search.noMatches', { defaultValue: 'No matches' })}
            </p>
          ) : (
            searchMatches.map((match, index) => (
              <div
                key={match.node.id}
                id={searchOptionId(index)}
                role="option"
                aria-selected={activeSearchIndex === index}
                data-architecture-search-option-index={index}
                data-architecture-search-in-graph={match.inGraph}
                className="flex w-full items-start justify-between gap-1 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent"
              >
                <button
                  type="button"
                  data-architecture-search-result={match.node.id}
                  data-architecture-search-in-range={match.inRange}
                  onClick={() => {
                    if (!match.inGraph) {
                      showHiddenSearchMatch(match);
                      return;
                    }
                    // A plain choose centres/selects in the drawing on screen;
                    // the secondary button below is the drill command.
                    revealNode(match.node.id, !match.inRange, false);
                  }}
                  className="flex min-w-0 flex-1 items-start justify-between gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {/* The name wraps instead of truncating: it is how a reader
                      tells two similar results apart. */}
                  <span data-architecture-search-result-name="true" className="min-w-0 break-words">
                    {match.node.label}
                  </span>
                  {!match.inGraph ? (
                    <span
                      data-architecture-search-hidden-reason="true"
                      className="shrink-0 text-amber-600 dark:text-amber-400"
                    >
                      {t('architecture.search.hiddenByFilter', { defaultValue: 'Hidden by the current filter' })}
                    </span>
                  ) : !match.inRange ? (
                    <span className="shrink-0 text-amber-600 dark:text-amber-400">
                      {t('architecture.search.outOfRange', { defaultValue: 'Not in current range' })}
                    </span>
                  ) : null}
                </button>
                {match.inGraph ? (
                  <button
                    type="button"
                    aria-label={t('architecture.search.viewNeighbourhood', {
                      defaultValue: 'View neighbourhood of {{name}}',
                      name: match.node.label,
                    })}
                    data-architecture-search-neighbourhood={match.node.id}
                    onClick={() => revealNode(match.node.id, !match.inRange, true)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {t('architecture.search.viewNeighbourhoodShort', { defaultValue: 'Neighbourhood' })}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-architecture-search-show={match.node.id}
                    onClick={() => showHiddenSearchMatch(match)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {t('architecture.search.showIt', { defaultValue: 'Show it' })}
                  </button>
                )}
              </div>
            ))
          )}

          {canCurate && searchQuery.trim().length >= 2 && (
            <>
              <p
                data-architecture-search-group="project"
                className="mt-1 flex flex-wrap items-baseline gap-1 border-t border-border/60 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                <span>{t('architecture.search.other', { defaultValue: 'Elsewhere in the project' })}</span>
                {/* Said ONCE, here, instead of on every row: a row repeated the
                    sentence and the repetition is what pushed the names so
                    narrow that they were cut to a few characters. */}
                {projectSearch.search.status === 'ready'
                  && projectSearch.search.results.some((hit) => !activeNodeIds.has(hit.id)) && (
                  <span
                    data-architecture-search-project-missing-note="true"
                    // Sentence case: this is a sentence, not a section title.
                    className="font-normal normal-case tracking-normal text-amber-600 dark:text-amber-400"
                  >
                    {t('architecture.search.notInGraph', { defaultValue: 'Not in the current graph' })}
                  </span>
                )}
              </p>
              {projectSearch.search.status === 'error' ? (
                <div data-architecture-search-error="true" className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">{projectSearch.search.message}</span>
                  <button
                    type="button"
                    data-architecture-search-retry="true"
                    onClick={projectSearch.retry}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {t('architecture.search.retry', { defaultValue: 'Retry' })}
                  </button>
                </div>
              ) : projectSearch.search.status === 'ready' ? (
                <>
                  {projectSearch.search.results.length === 0 ? (
                    <p data-architecture-search-project-empty="true" className="px-2 py-1 text-[11px] text-muted-foreground">
                      {t('architecture.search.noMatches', { defaultValue: 'No matches' })}
                    </p>
                  ) : (
                    projectSearch.search.results.map((hit, projectIndex) => {
                      const inCurrentGraph = activeNodeIds.has(hit.id);
                      return (
                        <div
                          key={hit.id}
                          id={searchOptionId(searchMatches.length + projectIndex)}
                          role="option"
                          aria-selected={activeSearchIndex === searchMatches.length + projectIndex}
                          data-architecture-search-project-result={hit.id}
                          data-architecture-search-project-in-graph={inCurrentGraph}
                          // Top-aligned: the name and the path are two lines, so
                          // the actions stay beside the FIRST line.
                          className="flex items-start gap-1 rounded px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                        >
                          <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-center text-muted-foreground">
                            {searchKindGlyph(hit.kind)}
                          </span>
                          {/* The name is NEVER truncated: a reader distinguishes
                              results by the class name (and its kind glyph), so
                              it wraps onto a second line when it does not fit.
                              The path goes UNDER it and, when it is too long,
                              loses its left-hand directories — the file name is
                              the part that identifies the row. */}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span
                              data-architecture-search-project-name="true"
                              className="font-medium break-words"
                            >
                              {hit.name}
                            </span>
                            <span
                              data-architecture-search-project-file="true"
                              dir="rtl"
                              title={hit.file}
                              className="block truncate text-left text-muted-foreground"
                            >
                              {hit.file}
                            </span>
                          </span>
                          {!inCurrentGraph && (
                            <button
                              type="button"
                              // The visible label stays "Show it"; the accessible
                              // name adds WHICH entity, reusing the same key (no
                              // new i18n entry for a sentence no locale owns).
                              aria-label={`${t('architecture.search.showIt', { defaultValue: 'Show it' })}: ${hit.name}`}
                              data-architecture-search-show={hit.id}
                              // Pinning is what "show it" means for a server-side
                              // hidden entity: the next reading carries it.
                              onClick={() => pinItem(hit)}
                              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                            >
                              {t('architecture.search.showIt', { defaultValue: 'Show it' })}
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={t('architecture.curation.pinNamed', { defaultValue: 'Pin {{name}}', name: hit.name })}
                            data-architecture-search-pin={hit.id}
                            onClick={() => pinItem(hit)}
                            className="shrink-0 rounded border border-border px-1.5 py-0.5 font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                          >
                            ＋
                          </button>
                        </div>
                      );
                    })
                  )}
                  {projectSearch.search.truncated && (
                    <p data-architecture-search-truncated="true" className="px-2 py-1 text-[10px] text-muted-foreground">
                      {t('architecture.search.truncated', {
                        defaultValue: 'Showing the first 20 — narrow the query.',
                      })}
                    </p>
                  )}
                </>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );

  // The `已调整 N 项 ▾` trigger: N is the sum of the three lists. The manager
  // itself lists every entry with a restore, so this is the one place a reader
  // can audit and undo a whole page of adjustments after a reload.
  const curationCount = curationState.pins.length
    + curationState.excluded.length
    + curationState.hiddenEdges.length;
  const curationManagerButton = (
    <button
      ref={curationManagerButtonRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={curationManagerOpen}
      disabled={!canCurate}
      title={canCurate
        ? undefined
        : t('architecture.curation.noSession', {
            defaultValue: 'Manual adjustments need a session: they are stored per session.',
          })}
      onClick={() => setCurationManagerOpen((open) => !open)}
      data-architecture-curation-manager-toggle="true"
      data-architecture-curation-count={curationCount}
      style={compactTargetStyle}
      className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40 ${
        compactToolbar ? 'px-3 py-2 text-left text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {t('architecture.curation.managerButton', {
        defaultValue: 'Adjusted {{count}} ▾',
        count: curationCount,
      })}
    </button>
  );

  // `?` opens the legend: the place the two duplicated hover instructions and
  // the meaning of every line, arrow, stereotype, seed marker and folded badge
  // now live.
  const legendButton = (
    <button
      ref={legendButtonRef}
      type="button"
      aria-haspopup="true"
      aria-expanded={legendOpen}
      aria-label={t('architecture.legend.title', { defaultValue: 'Legend' })}
      onClick={() => setLegendOpen((open) => !open)}
      data-architecture-legend-toggle="true"
      style={compactTargetStyle}
      className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
        coarsePointer ? 'px-3 text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      ?
    </button>
  );

  // The drawing's own seed reading, so the legend states the light marker
  // exactly when the drawing uses it (seeds at half the drawn entities or
  // more stop discriminating as a thick frame).
  const seedMarkerIsLight = seedMarkerMode(drawnGraph.nodes) === 'light';
  // The legend body names every visual vocabulary the drawing uses, including
  // the text form of the old circular fold badge (`+N folded`). It is drawn in
  // the desktop `?` popover and, on the compact tier, directly inside the
  // bottom sheet (the sheet is the one place the phone's readings live).
  const legendBody = (
    <div
      data-architecture-legend-content="true"
      className="whitespace-pre-line text-[11px] text-muted-foreground"
    >
      {/* The line-style and arrow vocabulary as PICTURES, not just the letters
          the old body printed (which used `△` for both inheritance and
          implementation and said "● seed" for an orange frame). */}
      <div
        data-architecture-legend-swatches="true"
        className="mb-1 grid grid-cols-3 gap-x-2 gap-y-1 not-italic"
      >
        {['association', 'dependency', 'inheritance', 'implementation', 'composition', 'aggregation', 'stereotype', 'seed', 'folded'].map((glyph) => (
          <LegendSwatch key={glyph} glyph={glyph} />
        ))}
      </div>
      {t('architecture.legend.body', {
        defaultValue:
          'Solid line: association or call.\nDashed line: dependency or implementation.\nArrows: △ inheritance · △ implementation · ◆ composition · ◇ aggregation · → dependency.\n«stereotype» marks the entity kind.\n● seed: named in this session.\n+N folded: hidden by the current detail level.',
      })}
      {seedMarkerIsLight && (
        <>
          {'\n'}
          {t('architecture.legend.seedLight', {
            defaultValue: 'Many seeds: they are marked with a thin frame and a small dot.',
          })}
        </>
      )}
    </div>
  );

  const legend = (
    <div
      data-architecture-legend="true"
      role="dialog"
      aria-label={t('architecture.legend.title', { defaultValue: 'Legend' })}
      className="absolute right-2 top-11 z-40 w-80 rounded-lg border border-border bg-popover p-3 text-[11px] text-muted-foreground shadow-lg"
    >
      {legendBody}
    </div>
  );

  const unresolvedNames = [...stats.unresolved.files, ...stats.unresolved.identifiers];
  const unresolvedCount = unresolvedNames.length;
  // The server's scope hygiene reading. Absent = the merge changed nothing, and
  // the source line then shows no cleanup affordance at all.
  const scopeHygiene = provenance.scopeHygiene;
  const subsumedEntityCount = scopeHygiene === undefined
    ? 0
    : scopeHygiene.subsumed.reduce((total, entry) => total + entry.droppedEntities, 0);
  // The kind tally is a factual reading of what the analysis contains, NOT a
  // judgement about the drawing. `class` folds the UML flavours the class
  // diagram draws the same way (class/abstract/enum).
  // The kind tally is a factual reading of the ANALYSIS (pre-budget), NOT a
  // description of the drawing — the readout's own line states the drawn mix.
  // It is an entity-view reading only: a file graph has no entity kinds, so the
  // class tally there described a different graph.
  const kindCounts = stats.kindCounts;
  const kindLine = kindCounts === undefined || granularity !== 'entity'
    ? null
    : [
        { count: kindCounts.function ?? 0, key: 'kindFunction', defaultValue: '{{count}} functions' },
        { count: kindCounts.interface ?? 0, key: 'kindInterface', defaultValue: '{{count}} interfaces' },
        {
          count: (kindCounts.class ?? 0) + (kindCounts.abstract ?? 0) + (kindCounts.enum ?? 0),
          key: 'kindClass',
          defaultValue: '{{count}} classes',
        },
      ]
        .filter((part) => part.count > 0)
        .map((part) => t(`architecture.readout.${part.key}`, { defaultValue: part.defaultValue, count: part.count }))
        .join(' · ');

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
  // The amber marker's accessible name has to say WHICH budget is squeezing;
  // the visible text stays one short word so the line does not grow back into
  // the three-sentence block the task replaces.
  const budgetLayerNames = readout.limitedLayers.map((layer) => {
    if (layer === 'detail') return t('architecture.readout.layerDetail', { defaultValue: 'detail level' });
    if (layer === 'layout') return t('architecture.readout.layerLayout', { defaultValue: 'layout budget' });
    return t('architecture.readout.layerServer', { defaultValue: 'node budget' });
  });
  const budgetLimitedLabel = t('architecture.readout.budgetLimitedAria', {
    defaultValue: 'Budget-limited by {{layers}}',
    layers: budgetLayerNames.join(', '),
  });

  // The filter's own reading, the readout's second line. The parts reuse the
  // SAME labels the popover's checkboxes show, so the number and the control
  // can never disagree, and `total` above is the FILTERED in-scope count.
  // The mentioned subset of each hidden kind is a parenthetical on that kind's
  // own part: "451 functions (35 mentioned in this session)". It never becomes
  // a separate part, because it is a subset of the number beside it, not a
  // second removal.
  const hiddenMentionedByKind = hiddenReading.mentionedByKind ?? {};
  const hiddenKindParts = Object.entries(hiddenReading.byKind)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([kind, count]) => {
      const label = `${String(count)} ${kindLabel(kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number])}`;
      const mentioned = hiddenMentionedByKind[kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number]] ?? 0;
      if (mentioned <= 0) return label;
      return `${label} (${t('architecture.filter.mentionedInKind', {
        defaultValue: '{{count}} mentioned in this session',
        count: mentioned,
      })})`;
    });
  const hiddenMentionedKinds = ARCHITECTURE_ELEMENT_KINDS.filter(
    (kind) => (hiddenMentionedByKind[kind] ?? 0) > 0,
  );
  const hiddenRelationParts = Object.entries(hiddenReading.byRelation)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => t('architecture.filter.relationPart', {
      defaultValue: '{{count}} {{kind}} relations',
      count,
      kind: relationTypeLabel(type),
    }));
  const hiddenParts = [
    ...hiddenKindParts,
    ...hiddenRelationParts,
    ...(hiddenReading.isolated > 0
      ? [t('architecture.filter.isolatedPart', {
          defaultValue: '{{count}} isolated nodes',
          count: hiddenReading.isolated,
        })]
      : []),
  ];
  const hiddenCount = hiddenTotal(hiddenReading);

  const raiseDetail = (): void => {
    const index = ARCHITECTURE_DETAIL_TIERS.indexOf(detail);
    changeDetail(ARCHITECTURE_DETAIL_TIERS[Math.min(index + 1, ARCHITECTURE_DETAIL_TIERS.length - 1)]);
  };

  /** The analysis/seed source line ... */
  /**
   * The analysis/seed source line, now a FOOTER in the panel's document flow
   * BELOW the canvas instead of a pill floating over the drawing's bottom-left
   * corner. Relative time on the surface, the exact local instant in `title`.
   * Its detail lists expand UPWARDS out of the footer (`position: absolute;
   * bottom-full`), so opening one never changes the canvas's size. Extracted so
   * the empty-reading state shows it too (the provenance exists even when no
   * seed resolved).
   */
  const sourceFooter = (
    // NO `overflow-hidden` on this row. Both of its disclosures (`names
    // mentioned …` and `Scope cleanup`) open UPWARDS out of it
    // (`absolute bottom-full`), and the clipping footer cut them down to a
    // zero-height sliver: the toggle flipped to ▾ while nothing appeared. The
    // row cannot overflow on its own — the source line is `min-w-0 truncate`
    // (which clips itself) and the cleanup pill is `shrink-0` — so the clip
    // bought nothing and cost both panels.
    //
    // `z-30`, not `z-20`: the disclosures are absolutely positioned out of
    // this row and therefore overlap the drawing's own corner chrome
    // (the zoom cluster at 20, the readable Focus/Overview switch at 24).
    // At an equal tier the later sibling already won, but the footer's
    // stacking context capped its children below the switch, so the list's
    // first rows were painted under it.
    <div
      data-architecture-source-footer="true"
      className="relative z-30 flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground"
    >
      <span
        data-architecture-source-line="true"
        className="min-w-0 truncate rounded-md border border-border/60 bg-background/90 px-2 py-1 shadow-sm"
      >
        {t('architecture.honesty.analysis', { defaultValue: 'Analysis' })}:{' '}
        {provenance.generatedAt ? (
          <time
            data-architecture-generated-at
            dateTime={provenance.generatedAt}
            title={formatAbsoluteTime(provenance.generatedAt, i18n.language)}
          >
            {formatRelativeTime(provenance.generatedAt, i18n.language)}
          </time>
        ) : (
          <span data-architecture-generated-at>unknown</span>
        )}
      </span>
      {/* The manual re-analysis entry. It sits beside the analysis time because
          that is the reading it changes; while a job runs it shows the elapsed
          time and is disabled, so a second tab (or a second press) cannot start
          a duplicate analysis. */}
      <button
        type="button"
        data-architecture-refresh="true"
        data-architecture-refresh-state={refresh.status.state}
        aria-label={t('architecture.refresh.action', { defaultValue: 'Refresh analysis' })}
        title={t('architecture.refresh.action', { defaultValue: 'Refresh analysis' })}
        disabled={refreshRunning || projectId === null}
        onClick={(event) => openRefreshDialog(event.currentTarget)}
        style={compactTargetStyle}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-background/90 px-1.5 py-1 text-[11px] text-muted-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCw
          aria-hidden="true"
          className={refreshRunning ? 'h-3 w-3 animate-spin' : 'h-3 w-3'}
        />
        {refreshRunning && (
          <span data-architecture-refresh-footer-elapsed="true" className="tabular-nums">
            {formatRefreshElapsed(refresh.elapsedMs)}
          </span>
        )}
      </button>
      {/* The unresolved toggle is a SIBLING of the truncating source line, not
          its child: inside a `truncate` span its own 352px width was clipped by
          the span's `overflow: hidden`, so a phone showed "Analysis: 14 hours
          ago · …" and the names were neither visible nor tappable. As a
          `shrink-0` pill it keeps its whole hit box and the source line gives
          up width instead. The compact tier shortens the label to fit the same
          row; the full sentence moves to the top of the expanded list. */}
      <button
        type="button"
        aria-expanded={unresolvedOpen}
        data-architecture-unresolved={unresolvedCount}
        onClick={() => setUnresolvedOpen((open) => !open)}
        style={compactTargetStyle}
        className="shrink-0 whitespace-nowrap rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {compactToolbar
          ? t('architecture.source.unresolvedShort', {
              defaultValue: '{{count}} unmatched',
              count: unresolvedCount,
            })
          : t('architecture.source.unresolved', {
              defaultValue: '{{count}} names mentioned in this session were not found in the analysis cache',
              count: unresolvedCount,
            })}
        <span aria-hidden="true">{unresolvedOpen ? ' ▾' : ' ▸'}</span>
      </button>
      {unresolvedOpen && (
        <div
          data-architecture-unresolved-panel="true"
          className="absolute bottom-full left-3 z-30 mb-1 rounded-md border border-border/60 bg-background/95 shadow-sm"
        >
          {/* The names that were not found are the honest-bar reading the manual
              refresh answers, so its action lives beside them as well as beside
              the analysis time. It is a SIBLING of the list: the list's items are
              names only, and a control among them would read as a name. */}
          {projectId !== null && (
            <div className="px-2 pb-1 pt-1">
              <button
                type="button"
                data-architecture-refresh-unresolved="true"
                disabled={refreshRunning}
                onClick={(event) => openRefreshDialog(event.currentTarget)}
                className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('architecture.refresh.action', { defaultValue: 'Refresh analysis' })}
              </button>
            </div>
          )}
          <ul
            data-architecture-unresolved-list="true"
            aria-label={t('architecture.source.listLabel', { defaultValue: 'Unresolved names' })}
            className="max-h-40 overflow-y-auto px-2 pb-1"
          >
            {/* The pill drops the full sentence on the compact tier; the reader
                still gets it here, above the names it describes. */}
            {compactToolbar && (
              <li data-architecture-unresolved-summary="true" className="pb-1 text-muted-foreground">
                {t('architecture.source.unresolved', {
                  defaultValue: '{{count}} names mentioned in this session were not found in the analysis cache',
                  count: unresolvedCount,
                })}
              </li>
            )}
            {unresolvedNames.map((name) => (
              <li key={name} data-architecture-unresolved-name="true">
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Scope cleanup: what the server dropped or rewrote before drawing. It
          sits after the analysis/seed line because it explains that line's
          numbers, and it is absent entirely when the merge changed nothing. */}
      {scopeHygiene !== undefined && (
        <button
          type="button"
          aria-expanded={scopeHygieneOpen}
          data-architecture-scope-hygiene="true"
          data-architecture-scope-hygiene-total={scopeHygiene.total}
          data-architecture-scope-hygiene-kept={scopeHygiene.kept}
          onClick={() => setScopeHygieneOpen((open) => !open)}
          style={compactTargetStyle}
          className="shrink-0 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.scopeHygiene.summary', { defaultValue: 'Scope cleanup' })}
          <span aria-hidden="true">{scopeHygieneOpen ? ' ▾' : ' ▸'}</span>
        </button>
      )}
      {scopeHygiene !== undefined && scopeHygieneOpen && (
        <ul
          data-architecture-scope-hygiene-detail="true"
          aria-label={t('architecture.scopeHygiene.detailLabel', {
            defaultValue: 'Scope cleanup details',
          })}
          className="absolute bottom-full right-3 z-30 mb-1 max-h-40 max-w-xs overflow-y-auto rounded-md border border-border/60 bg-background/95 px-2 py-1 shadow-sm"
        >
          <li data-architecture-scope-hygiene-counts="true">
            {t('architecture.scopeHygiene.scopeCount', {
              defaultValue: '{{total}} scopes, kept {{kept}}',
              total: scopeHygiene.total,
              kept: scopeHygiene.kept,
            })}
          </li>
          {scopeHygiene.subsumed.length > 0 && (
            <li data-architecture-scope-hygiene-subsumed={scopeHygiene.subsumed.length}>
              {t('architecture.scopeHygiene.subsumed', {
                defaultValue: '{{count}} merged into an outer scope ({{entities}} duplicate entities dropped)',
                count: scopeHygiene.subsumed.length,
                entities: subsumedEntityCount,
              })}
            </li>
          )}
          {scopeHygiene.droppedOutsideRoot.length > 0 && (
            <li data-architecture-scope-hygiene-outside={scopeHygiene.droppedOutsideRoot.length}>
              {t('architecture.scopeHygiene.outside', {
                defaultValue: '{{count}} outside the project directory were ignored',
                count: scopeHygiene.droppedOutsideRoot.length,
              })}
            </li>
          )}
          {scopeHygiene.normalizedAbsoluteIds > 0 && (
            <li data-architecture-scope-hygiene-normalized={scopeHygiene.normalizedAbsoluteIds}>
              {t('architecture.scopeHygiene.normalized', {
                defaultValue: '{{count}} absolute-path ids normalised',
                count: scopeHygiene.normalizedAbsoluteIds,
              })}
            </li>
          )}
          {scopeHygiene.droppedOutsideRoot.map((entry) => (
            <li key={entry.scope} data-architecture-scope-hygiene-outside-scope={entry.scope}>
              {t('architecture.scopeHygiene.outsideItem', {
                defaultValue: '{{label}} — {{sources}}',
                label: entry.label,
                sources: entry.sources.join(', '),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>

  );

  /**
   * The one-line reading. It is the only place the shown/in-scope numbers are
   * stated, and it lives in the panel's in-flow row ABOVE the drawing (left
   * cell): as an overlay it covered the first row of the graph. The filter's
   * second line sits under it, so hiding and narrowing never share a number.
   */
  // The diff set's size, for the one readout line; null when nothing is highlighted.
  const diffCounts = resolvedDiffHighlight === null
    ? null
    : diffHighlightCounts(resolvedDiffHighlight);
  const readoutPanel = (
    <div
      data-architecture-readout="true"
      aria-live="polite"
      // On the compact tier the collapsed card is ONE line in a 44px box: a
      // phone spends its scarce height on the drawing, and the second/third
      // lines (plus the "show mentioned" actions) live in the expanded area
      // below the toggle, which stays in document flow. The desktop card keeps
      // its bordered, two-line form.
      style={compactToolbar && !readoutOpen ? { height: '44px' } : undefined}
      className={compactToolbar
        ? 'pointer-events-auto max-w-full overflow-hidden rounded-md bg-background/90 px-2 text-[11px] text-muted-foreground'
        : 'pointer-events-auto max-w-full rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm'}
    >
      <button
        type="button"
        aria-expanded={readoutOpen}
        onClick={() => setReadoutOpen((open) => !open)}
        data-architecture-readout-toggle="true"
        style={compactTargetStyle}
        className={compactToolbar
          ? 'flex h-full w-full flex-nowrap items-center gap-x-2 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
          : 'flex flex-wrap items-center gap-x-2 gap-y-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60'}
      >
        <span
          data-architecture-readout-summary={readout.shown}
          data-architecture-readout-total={readout.related}
          className={compactToolbar ? 'min-w-0 truncate whitespace-nowrap' : undefined}
        >
          {readoutSummary}
        </span>
        {compactToolbar && truncation.truncated && (
          // The compact tier has no room for a second badge in its one header
          // row, so the budget reading travels with the floating readout chip.
          <span
            data-architecture-truncated-badge="true"
            data-architecture-truncated-granularity={granularity}
            data-architecture-truncated-omitted={budgetOmitted}
            className="whitespace-nowrap font-medium text-amber-600 dark:text-amber-400"
          >
            +{budgetOmitted} folded
          </span>
        )}
        {readout.limited && (
          // ONE short amber marker, never the three budget sentences the task
          // replaces: the layer-specific numbers live in the expanded area. The
          // accessible name still says which layer(s) are squeezing, and the
          // DOM readings the panel has always exposed stay on this element with
          // the new meaning (N = drawn entities, M = pre-budget related).
          <span
            data-architecture-budget-limited="true"
            aria-label={budgetLimitedLabel}
            {...(layoutFit?.limited === true
              ? {
                  'data-architecture-layout-budget': layoutFit.graph.nodes.length,
                  'data-architecture-layout-budget-tier': layoutFit.tier,
                  'data-architecture-layout-budget-dropped': layoutFit.droppedCount,
                }
              : {})}
            {...(truncation.truncated
              ? {
                  'data-architecture-truncated': 'true',
                  'data-architecture-truncated-granularity': granularity,
                  'data-architecture-truncated-shown': truncation.shown,
                  'data-architecture-truncated-total': truncation.total,
                  'data-architecture-truncated-omitted': budgetOmitted,
                }
              : {})}
            className="text-amber-600 dark:text-amber-400"
          >
            {t('architecture.readout.budgetLimited', { defaultValue: 'Budget-limited' })}
          </span>
        )}
        <span aria-hidden="true">{readoutOpen ? '▾' : '▸'}</span>
      </button>
      {/* The wall's structural diff: one line stating how many targets are marked. On the
          compact tier it lives in the expanded area, like every other second line. */}
      {diffCounts !== null && (!compactToolbar || readoutOpen) && (
        <div
          data-testid="architecture-diff-highlight"
          data-architecture-diff-nodes={diffCounts.nodes}
          data-architecture-diff-edges={diffCounts.edges}
          className="mt-0.5 text-amber-700 dark:text-amber-400"
        >
          {t('architecture.diffHighlight', {
            defaultValue: 'Diff highlight: {{nodes}} targets · {{edges}} relations',
            nodes: diffCounts.nodes,
            edges: diffCounts.edges,
          })}
        </div>
      )}
      {/* A scope step that found entities and then hid all of them: state the
          delta and offer the one click that brings them back. On the compact
          tier this is part of the EXPANDED area — the collapsed card is one
          line by contract (see the card's style above). */}
      {scopeHiddenDelta !== null && (!compactToolbar || readoutOpen) && (
        <div
          data-architecture-scope-hidden={scopeHiddenDelta.found}
          data-architecture-scope-hidden-scope={scopeHiddenDelta.scope}
          className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
        >
          <span>
            {t('architecture.copyFix.scopeMoreHidden', {
              defaultValue: 'Scope +{{scope}} found {{count}} more related, all hidden by the filter ({{parts}})',
              scope: scopeHiddenDelta.scope,
              count: scopeHiddenDelta.found,
              parts: [
                ...scopeHiddenDelta.kinds.map((entry) => `${String(entry.count)} ${kindLabel(entry.kind)}`),
                ...scopeHiddenDelta.relations.map((entry) => `${String(entry.count)} ${relationTypeLabel(entry.type)} relations`),
              ].join(' · '),
            })}
          </span>
          {scopeHiddenDelta.kinds.length > 0 && (
            <button
              type="button"
              data-architecture-scope-show-kinds={scopeHiddenDelta.kinds.map((entry) => entry.kind).join(',')}
              onClick={showScopeHiddenKinds}
              style={compactTargetStyle}
              className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.copyFix.showKinds', {
                defaultValue: '▸ Show {{kinds}}',
                kinds: scopeHiddenDelta.kinds.map((entry) => kindLabel(entry.kind)).join(' · '),
              })}
            </button>
          )}
        </div>
      )}
      {/* The filter's second line: what the element/relation selection is
          hiding, and the one-click reset. Deliberately separate from the
          detail sentence above — the two knobs must not share a number. On the
          compact tier it lives in the expanded area, never in the one line. */}
      {hiddenCount > 0 && (!compactToolbar || readoutOpen) && (
        <div
          data-architecture-filter-hidden={hiddenCount}
          data-architecture-filter-hidden-kinds={JSON.stringify(hiddenReading.byKind)}
          data-architecture-filter-hidden-relations={JSON.stringify(hiddenReading.byRelation)}
          data-architecture-filter-hidden-isolated={hiddenReading.isolated}
          data-architecture-filter-hidden-mentioned={
            hiddenMentionedKinds.length === 0 ? '' : JSON.stringify(hiddenMentionedByKind)
          }
          className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
        >
          <span>
            {t('architecture.filter.hiddenPrefix', {
              defaultValue: 'Hidden {{parts}}',
              parts: hiddenParts.join(' · '),
            })}
          </span>
          {hiddenMentionedKinds.length > 0 && (
            // The one-click counterpart to the popover's switches: show exactly
            // the mentioned entities of the kinds this reading is hiding.
            <button
              type="button"
              data-architecture-filter-show-mentioned="true"
              onClick={showHiddenMentioned}
              style={compactTargetStyle}
              className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.filter.showMentioned', { defaultValue: '▸ Show mentioned' })}
            </button>
          )}
          <button
            type="button"
            data-architecture-filter-show-all="true"
            onClick={() => changeFilter(showAllFilter(filter))}
            // Show all is about the ELEMENT axis: it shows every kind and keeps
            // isolated nodes, and leaves the relation preset where the reader
            // put it (see `showAllFilter`).
            style={compactTargetStyle}
            className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.filter.showAll', { defaultValue: '▸ Show all' })}
          </button>
          <button
            type="button"
            data-architecture-filter-reset="true"
            onClick={() => changeFilter(resetFilter())}
            // The way back from a sequence of switches that no reader can
            // reconstruct from memory: one click, the project's shipped default.
            style={compactTargetStyle}
            className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.filter.reset', { defaultValue: '↺ Reset filters' })}
          </button>
        </div>
      )}
      {(curationState.excluded.length > 0 || curationState.pins.length > 0) && (
        <p
          data-architecture-curation-readout="true"
          data-architecture-curation-pinned={curationState.pins.length}
          data-architecture-curation-excluded={curationState.excluded.length}
          className="mt-0.5"
        >
          {t('architecture.curation.readout', {
            defaultValue: '{{excluded}} manually removed · {{pinned}} pinned',
            excluded: curationState.excluded.length,
            pinned: curationState.pins.length,
          })}
        </p>
      )}
      {readoutOpen && (
        <div data-architecture-readout-detail="true" className="mt-1 flex flex-col gap-1">
          {readout.lines.length > 0 && (
            // One line per budget layer that cut, each with its own number and
            // its "how to adjust" clause. Untriggered layers are absent.
            <div data-architecture-readout-budget-lines="true" className="flex flex-col gap-0.5">
              {readout.lines.map((line) => (
                <p
                  key={line.layer}
                  data-architecture-readout-line={line.layer}
                  data-architecture-readout-line-count={line.count}
                >
                  {line.layer === 'detail'
                    ? t('architecture.readout.detailLayer', {
                        defaultValue: 'Detail level kept {{value}}.',
                        value: line.countText,
                      })
                    : line.layer === 'layout'
                      ? t('architecture.readout.layoutLayer', {
                          defaultValue:
                            'The layout budget draws {{value}} — more would be slow; lower the detail to see more.',
                          value: line.countText,
                        })
                      : t('architecture.readout.serverLayer', {
                          defaultValue:
                            'The node budget left {{value}} out — reduce the scope to see them.',
                          value: line.countText,
                        })}
                </p>
              ))}
            </div>
          )}
          {kindLine !== null && kindLine.length > 0 && (
            <p data-architecture-kind-counts="true">{kindLine}</p>
          )}
          <span className="flex gap-2">
            <button
              type="button"
              onClick={raiseDetail}
              data-architecture-raise-detail="true"
              style={compactTargetStyle}
              className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.readout.raiseDetail', { defaultValue: 'Raise detail' })}
            </button>
            <button
              type="button"
              onClick={() => changeScope(scope - 1)}
              data-architecture-reduce-scope="true"
              disabled={scope <= ARCHITECTURE_SCOPE_MIN}
              style={compactTargetStyle}
              className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('architecture.readout.reduceScope', { defaultValue: 'Reduce scope' })}
            </button>
          </span>
        </div>
      )}
    </div>
  );

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
  const sidebarCollapseButton = (
    <button
      type="button"
      onClick={collapseShellSidebar}
      data-architecture-sidebar-collapse="true"
      style={compactTargetStyle}
      className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      {t('versionUpdate.ariaLabels.closeSidebar', { defaultValue: 'Close sidebar' })}
    </button>
  );

  /**
   * The landscape-phone toolbar's summary cell. It states the SAME one-line
   * reading the other tiers draw in their canvas-header row and expands into
   * that row's full reading (plus the provenance footer) as an overlay. This is
   * the cell that lets the short tier spend no standing height on a summary
   * row: the drawing gets the 44px the row would have taken.
   */
  const shortTouchReadoutToggle = (
    <button
      type="button"
      aria-expanded={readoutOpen}
      onClick={() => setReadoutOpen((open) => !open)}
      data-architecture-readout-toolbar-toggle="true"
      data-architecture-readout-toolbar-summary={readout.shown}
      data-architecture-readout-toolbar-total={readout.related}
      style={compactTargetStyle}
      className={`${headerButtonClass} inline-flex min-w-0 max-w-[38%] items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      <span className="min-w-0 truncate whitespace-nowrap">{readoutSummary}</span>
      <span aria-hidden="true">{readoutOpen ? '▾' : '▸'}</span>
    </button>
  );

  /**
   * The selection tray in its landscape-phone form: the TOP ROW of the
   * inspector column. It is never drawn across the canvas on this tier.
   */
  const shortTouchPanelTray = shortTouch && selections.length > 0
    ? (
      <ArchitectureSelectionTray
        selections={selections}
        graph={drawnGraph}
        idShape={nodeIdShapeOf(granularity)}
        view={diagramView}
        grouping={granularity === 'file' ? 'adaptive' : 'raw'}
        drawn={drawnPlantUml}
        projectId={projectId}
        projectName={projectName}
        analyzedAt={provenance.generatedAt}
        canCompose={canComposeSelection}
        canRemove={canCurateEntities}
        multiSelect={multiSelectMode}
        expanded={trayExpanded}
        compact={compactToolbar}
        panelRow
        onExpandedChange={setTrayExpanded}
        onExitMultiSelect={() => setMultiSelectMode(false)}
        onToggleItem={toggleSelection}
        onClear={clearSelectionOnCanvas}
        onCompose={composeSelectionText}
        onRemoveSelected={removeSelected}
      />
    )
    : undefined;

  return (
    <div
      ref={panelRootRef}
      // A programmatic focus target for the no-canvas (empty state) reading;
      // the drawing region is preferred whenever it exists.
      tabIndex={-1}
      data-architecture-panel="true"
      data-architecture-fullscreen={fullscreen.active ? 'true' : undefined}
      data-architecture-standalone={standalone ? 'true' : undefined}
      data-architecture-viewport-fill={fillsViewport ? 'true' : undefined}
      // The overlay is the SAME element the panel always renders: `fixed;
      // inset: 0` restyles it in place, which is what lets the renderer keep
      // its zoom and the panel keep every reading through the toggle. The
      // standalone page starts in this geometry because it has no shell.
      style={fillsViewport ? { position: 'fixed', inset: 0, zIndex: 60 } : undefined}
      className={
        fillsViewport
          ? 'flex flex-col overflow-hidden bg-background outline-none'
          : 'relative flex h-full flex-col overflow-hidden'
      }
    >
      {/* The one-off touch bubble's own fade. It is keyed CSS (not a JS timer)
          so the dismissal runs off the animation end even in a background tab,
          and a test can drive it with a single animation event. */}
      <style>{'@keyframes architecture-touch-hint-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }'}</style>
      <div
        data-architecture-toolbar="true"
        data-architecture-toolbar-short-touch={shortTouch ? 'true' : undefined}
        data-architecture-toolbar-portrait={portraitPhone ? 'true' : undefined}
        // On the overlay the compact row is ONE 56px line (a 44px target plus
        // the row's 2×6px padding): `nowrap` and the stated height are the
        // contract that keeps a second row from covering the drawing again.
        // The landscape-phone tier states the same `nowrap` contract at 52px
        // (a 44px target plus the row's 2×4px padding), because its scarce axis
        // is height and a wrapped second row would cost the drawing ~44px. The
        // portrait tier states it at 56px: its scarce axis is WIDTH, but the row
        // it replaces wrapped into two 56px bands, so the pinned height is what
        // buys the 12.5% of the viewport the canvas share is read against.
        style={
          compactToolbar
            ? fullscreen.active
              ? { gap: TOUCH_CONTROL_GAP_PX, height: 56, flexWrap: 'nowrap' }
              : shortTouch
                ? { gap: TOUCH_CONTROL_GAP_PX, height: 52, flexWrap: 'nowrap' }
                : portraitPhone
                  ? { gap: TOUCH_CONTROL_GAP_PX, height: 56, flexWrap: 'nowrap' }
                  : { gap: TOUCH_CONTROL_GAP_PX }
            : undefined
        }
        // Over the overlay the row is chrome ON TOP of a viewport-sized
        // drawing, not a band that shortens it. Otherwise the row WRAPS rather
        // than scrolls: `overflow-x: auto` also makes the block axis a scroll
        // container, which clipped every absolutely positioned child — the
        // search results were cut to a 3px line. Wrapping keeps the popovers in
        // normal paint flow, and the desktop row still fits one line at its
        // breakpoint (it only wraps when the width really runs out, which is
        // preferable to hiding controls in a scroller).
        className={`relative flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 ${
          shortTouch && !fullscreen.active ? 'py-1' : 'py-1.5'
        } ${fillsViewport ? 'relative z-40 bg-background' : ''}`}
      >
        {compactToolbar ? (
          fullscreen.active ? (
            // The overlay keeps ONE row: leaving, and the one menu the view
            // switch and Text page moved into. Everything else would be a
            // second row over the drawing's top edge.
            <>
              {standaloneBackButton}
              <span className="flex-1" />
              {openInNewTabButton}
              {fullscreenButton}
              {adjustButton}
            </>
          ) : portraitPhone ? (
            // The portrait-phone row: the view switch, the Text door and the
            // one Adjust menu. Fullscreen and "Open in new tab" live INSIDE
            // that sheet (see the Adjust section below) because a second entry
            // is exactly what wrapped this row in the pre-task chrome. The
            // standalone page's Back door travels with them for the same
            // reason: it is a fifth 44px target otherwise.
            <>
              {granularityGroup}
              <span className="flex-1" />
              {textToggle}
              {adjustButton}
            </>
          ) : shortTouch ? (
            // The landscape-phone row: the view switch, the one-line summary
            // (expanding into the readout above the drawing), the Text door and
            // the one Adjust menu. Fullscreen and export move INTO that menu —
            // the design's "remaining controls live in Adjust".
            <>
              {standaloneBackButton}
              {granularityGroup}
              <span className="flex-1" />
              {shortTouchReadoutToggle}
              {openInNewTabButton}
              {textToggle}
              {adjustButton}
            </>
          ) : (
            <>
              {standaloneBackButton}
              {granularityGroup}
              <span className="flex-1" />
              {openInNewTabButton}
              {textToggle}
              {fullscreenButton}
              {adjustButton}
            </>
          )
        ) : (
          <>
            {standaloneBackButton}
            <h3 className="shrink-0 text-sm font-semibold text-foreground">
              {t('architecture.title', { defaultValue: 'Architecture' })}
            </h3>
            {granularityGroup}
            {scopeGroup}
            {detailGroup}
            {filterDisclosure}
            {searchBox}
            {curationManagerButton}
            <span className="flex-1" />
            {openInNewTabButton}
            {textToggle}
            {fullscreenButton}
            {exportMenu}
            {legendButton}
          </>
        )}
        {/* The landscape-phone summary's expansion. It is an overlay anchored
            under the toolbar (not an in-flow row): opening it must not take
            height from the drawing the reader is inspecting, and closing it
            must return that height untouched. The provenance footer, which is a
            document-flow row on the other tiers, travels WITH the summary here
            — the short tier has no room for a standing footer. */}
        {shortTouch && readoutOpen && (
          <div
            data-architecture-readout-popover="true"
            className="absolute left-0 right-0 top-full z-50 max-h-[70vh] overflow-y-auto border-b border-border/60 bg-background shadow-lg"
          >
            {readoutPanel}
            {sourceFooter}
          </div>
        )}
      </div>

      {!canCurate && (
        <p
          role="status"
          data-architecture-curation-disabled="true"
          className="shrink-0 border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground"
        >
          {t('architecture.curation.noSession', {
            defaultValue: 'Manual adjustments need a session: they are stored per session.',
          })}
        </p>
      )}

      {/* The export reading lives outside the menu so it survives the menu
          closing: success, a downscale notice, or a failure is announced to
          screen readers without moving focus. */}
      <span role="status" aria-live="polite" data-architecture-export-status="true" className="sr-only">
        {exportStatus}
      </span>

      {copyFallbackText !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('architecture.export.copyFallbackTitle', { defaultValue: 'Copy PlantUML manually' })}
          data-architecture-export-fallback="true"
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
        >
          <div className="w-full max-w-lg rounded-lg border border-border bg-popover p-4 shadow-xl">
            <p className="text-sm text-foreground">
              {t('architecture.export.copyFallbackHint', {
                defaultValue: 'Clipboard access is unavailable. Select and copy the text below.',
              })}
            </p>
            <textarea
              ref={copyFallbackRef}
              readOnly
              value={copyFallbackText}
              aria-label={t('architecture.export.plantUml', { defaultValue: 'PlantUML (.puml)' })}
              data-architecture-export-fallback-text="true"
              className="mt-2 h-48 w-full resize-none rounded border border-border bg-background p-2 font-mono text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setCopyFallbackText(null)}
                data-architecture-export-fallback-close="true"
                className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {t('architecture.export.close', { defaultValue: 'Close' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {compactToolbar && (
        <ArchitectureSheet
          open={sheetOpen}
          title={t('architecture.sheet.title', { defaultValue: 'Adjust' })}
          closeLabel={t('architecture.sheet.close', { defaultValue: 'Close adjust panel' })}
          handleLabel={t('architecture.sheet.dragHandle', { defaultValue: 'Drag to close' })}
          onClose={() => setSheetOpen(false)}
          returnFocusRef={sheetTriggerRef}
        >
          {/* Every group in the sheet is LABELLED. The unlabelled version made
              the reader read `Filter ▾` as a section title and the `− +2 +`
              stepper as an unlabelled mystery; the titles are the same words
              the desktop toolbar's tooltips use. */}
          <section data-architecture-sheet-view="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.sheet.view', { defaultValue: 'View' })}
            </span>
            {/* In the overlay the one toolbar row keeps only Exit fullscreen and
                Adjust, so the view switch and the Text page move in here. */}
            {fullscreen.active && (
              <div className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
                {granularityGroup}
                {textToggle}
              </div>
            )}
            {/* The landscape-phone toolbar keeps only the view switch, the
                summary, Text and Adjust, so the overlay entry and the shell's
                sidebar-collapse entry live here. The collapse button invokes
                the control the shell header already renders; the architecture
                module does not own or change the sidebar. */}
            {shortTouch && !fullscreen.active && (
              <div className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
                {fullscreenButton}
                {sidebarCollapseButton}
              </div>
            )}
            {/* The portrait row keeps only the view switch, Text and Adjust, so
                the entries it gave up live here: the standalone Back door, the
                second-screen door and the fullscreen overlay. */}
            {portraitPhone && !fullscreen.active && (
              <div className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
                {standaloneBackButton}
                {openInNewTabSheetButton}
                {fullscreenButton}
              </div>
            )}
            {/* The renderer's own view chrome (tier, scale, readable mode, Back,
                Drill in) is portaled in here; on the compact tier the sheet is
                the one menu, so those entries do not spend a second canvas row. */}
            <div
              ref={setCanvasHeaderHost}
              data-architecture-sheet-view-controls="true"
              className="flex flex-col"
              style={{ gap: TOUCH_CONTROL_GAP_PX }}
            />
          </section>
          <section data-architecture-sheet-scope="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.sheet.scope', { defaultValue: 'Scope' })}
            </span>
            {scopeGroup}
          </section>
          <section data-architecture-sheet-detail="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.sheet.detail', { defaultValue: 'Detail' })}
            </span>
            {detailGroup}
          </section>
          <section data-architecture-sheet-filter="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.sheet.filter', { defaultValue: 'Filter' })}
            </span>
            {filterContent}
          </section>
          {searchBox}
          {curationManagerButton}
          <section data-architecture-sheet-export="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.sheet.export', { defaultValue: 'Export' })}
            </span>
            {exportMenu}
          </section>
          <section data-architecture-sheet-legend="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.legend.title', { defaultValue: 'Legend' })}
            </span>
            {legendBody}
          </section>
          {/* The renderer's remaining controls (view label, export) are drawn
              inside the same sheet at the same 44px targets. */}
          <div
            ref={setSheetControlsHost}
            data-architecture-compact-graph-controls="true"
            className="flex flex-col border-t border-border/60 pt-2"
            style={{ gap: TOUCH_CONTROL_GAP_PX }}
          />
        </ArchitectureSheet>
      )}

      {/* The panel's remaining height is one flex COLUMN whose single child is
          the row below it: every `flex-1` and `h-full` further down resolves
          against a flex parent with a definite height only while that direct
          child stays a column (the canvas layout contract walks this chain). */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Inside it, the canvas and the dock share one flex ROW: opening the dock
          takes width from the drawing (320px) instead of covering it, which is
          why its open/close has to freeze aspect re-layout. On a coarse pointer
          the dock renders itself as an absolutely positioned bottom drawer
          inside this relative parent. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasSeeds ? (
          drawnEmpty ? (
            // Seeds resolved, but this granularity has nothing to draw. The
            // toolbar above keeps the granularity radios, so the switch here is
            // a shortcut, not the only way out of the blank canvas.
            <ArchitectureEmptyState
              message={emptyViewMessage}
              action={
                alternateTotal > 0 ? (
                  <button
                    type="button"
                    data-architecture-empty-switch={alternateGranularity}
                    onClick={() => changeGranularity(alternateGranularity)}
                    style={compactTargetStyle}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {alternateGranularity === 'file'
                      ? t('architecture.emptyView.viewFileGraph', {
                        defaultValue: 'View the file graph ({{count}} files)',
                        count: alternateTotal,
                      })
                      : t('architecture.emptyView.viewEntityGraph', {
                        defaultValue: 'View the class diagram ({{count}} entities)',
                        count: alternateTotal,
                      })}
                  </button>
                ) : undefined
              }
            />
          ) : (
          <>
            {/* Desktop keeps its in-flow row: the readout on the left, the
                renderer's zoom tier and scale on the right. The compact tier
                has no such row — its readout floats on the drawing and the
                renderer's view chrome is portaled into the bottom sheet. */}
            {!compactToolbar && (
              <div
                ref={readoutRowRef}
                data-architecture-canvas-header="true"
                // Floats above the overlay's viewport-sized drawing instead of
                // taking a band from it (see the graph region below).
                className={`flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-1 ${
                  fillsViewport ? 'relative z-30 bg-background' : ''
                }`}
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-start gap-1">{readoutPanel}</div>
                <div
                  ref={setCanvasHeaderHost}
                  data-architecture-canvas-header-actions="true"
                  className="flex min-w-0 max-w-[65%] shrink-0 flex-wrap items-center justify-end gap-1"
                />
              </div>
            )}
            {/* The compact tier's readout is an IN-FLOW row above the drawing,
                not a translucent card floating over its top-left corner (the
                card covered the drawing and collided with the corner chrome).
                It is marked as the canvas header so the layout contract treats
                it as chrome: the drawing's available height starts below it. */}
            {compactToolbar && (!shortTouch || fullscreen.active) && (
              <div
                ref={readoutRowRef}
                data-architecture-canvas-header="true"
                data-architecture-readout-overlay="true"
                className={`flex shrink-0 border-b border-border/60 px-3 py-1 ${
                  fillsViewport ? 'relative z-30 bg-background' : ''
                }`}
              >
                {readoutPanel}
              </div>
            )}
            <div
              ref={graphAreaRef}
              // Focus returns here when the dock closes (see ArchitectureDock's
              // focus management); a programmatic focus target needs a tabindex.
              tabIndex={-1}
              aria-busy={refreshing}
              data-architecture-refreshing={refreshing ? 'true' : undefined}
              data-architecture-canvas-region="true"
              // Which source the Text page and the Export menu will serialize:
              // the drawn model (complete, rendered with `detail: 'full'`) once
              // the renderer has reported one, or the local bridge before that.
              // The renderer nulls the model when a new drawing starts, so this
              // flips back to `bridge` for the duration of a re-render — a
              // reader (and a criterion) can wait for `drawn` instead of racing it.
              data-architecture-drawn-source={drawnPlantUml === null ? 'bridge' : 'drawn'}
              // The canvas region is an instrument, not prose: dragging it pans
              // and double-clicking drills, so neither gesture may paint a text
              // selection. Scoped to THIS region — the dock beside it (the
              // inspector and the Text page) stays fully selectable.
              style={{
                userSelect: 'none',
                WebkitUserSelect: 'none',
                WebkitTouchCallout: 'none',
              }}
              // `F` is the drawing's own shortcut while it owns the keyboard.
              onKeyDown={handleCanvasFullscreenKey}
              // On the overlay (and on the standalone page, which borrows the
              // same geometry) the REGION itself is viewport-sized: the toolbar
              // and readout rows above float over it with a higher z-index, so
              // "the drawing fills the screen" is literally its box, not a
              // share of the remaining column.
              className={
                fillsViewport
                  ? `fixed inset-0 z-0 flex min-h-0 flex-col transition-opacity ${refreshing ? 'opacity-60' : ''}`
                  : `relative flex min-h-0 flex-1 flex-col transition-opacity ${refreshing ? 'opacity-60' : ''}`
              }
            >
              {/* One-off, in-canvas instruction. It is an overlay bubble (not a
                  row in the panel column), fades itself out after 3s, and the
                  dismissal is remembered, so it can never become standing
                  chrome. `role="status"` keeps it announceable. */}
              {compactToolbar && coarsePointer && !touchHintDismissed && (
                <div
                  data-architecture-touch-hint="true"
                  role="status"
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: 8,
                    zIndex: 30,
                    maxWidth: '55%',
                    animation: 'architecture-touch-hint-fade 3000ms ease forwards',
                  }}
                  onAnimationEnd={dismissTouchHint}
                  className="pointer-events-auto flex items-start rounded-lg border border-border/60 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm"
                >
                  <span className="min-w-0 flex-1">
                    {t('architecture.plantuml.touchHintBubble', {
                      defaultValue: 'Drag with one finger to pan, pinch to zoom, double-tap a node to drill in.',
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label={t('architecture.dismissHint', { defaultValue: 'Dismiss hint' })}
                    onClick={dismissTouchHint}
                    style={compactTargetStyle}
                    className="rounded border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    ×
                  </button>
                </div>
              )}
              <CompactToolbarSlotContext.Provider value={sheetControlsHost}>
                <CanvasHeaderSlotContext.Provider value={canvasHeaderHost}>
                  <Renderer
                    key={`${sessionId}:${granularity}:${scope}`}
                    graph={layoutFit?.graph ?? detailRanking?.graph ?? neighbourhood}
                    // The coarse drawer covers the canvas' bottom band while it
                    // is open; the drawing reserves that band and keeps the
                    // selected box above it. The landscape side column is in
                    // flow, so it covers nothing and reserves nothing. The one
                    // exception is the criterion's DEV drawer override: there
                    // the point IS that the restored overlay covers the drawing,
                    // so no band is reserved (reserving it would hide the
                    // defect the control arm exists to measure).
                    bottomObscuredPx={
                      dockTier === 'drawer' && dockOpen && !shortTouch ? touchDrawerHeight : 0
                    }
                    // On the overlay the chrome is painted OVER the viewport-
                    // sized canvas. The renderer measures the actual chrome
                    // rectangles and fits inside what is left; the standalone
                    // page keeps its own reserved-band reading (`fullscreen`
                    // stays false there).
                    topObscuredPx={topChromePx}
                    fullscreen={fullscreen.active}
                    // Which project the drawing belongs to; the renderer uses it
                    // to remember the reader's explicit readable mode.
                    projectId={projectId}
                    // The detail knob's two numbers, so a renderer that has a
                    // visible-summary slot can report shown/in-scope rather than
                    // its own drawn/total reading.
                    detailReading={detailReading}
                    // Which subgraph this is decides how ids are read (label and
                    // group prefixes). The renderer must not have to guess: see
                    // `nodeIdShapeOf`.
                    idShape={nodeIdShapeOf(granularity)}
                    diffHighlight={resolvedDiffHighlight}
                    onNodeHover={handleNodeHover}
                    // A SINGLE click only selects: the inspector opens on the
                    // right and the drawing must not re-lay out. Drilling is the
                    // renderer's own double-click / double-tap gesture.
                    onNodeClick={(node) => {
                      dismissTouchHint();
                      selectNodeOnCanvas(node);
                    }}
                    onEdgeClick={selectRelationOnCanvas}
                    onToggleNodeClick={toggleNodeOnCanvas}
                    onToggleEdgeClick={toggleRelationOnCanvas}
                    onBoxSelect={addBoxSelection}
                    onMultiSelectStart={startMultiSelect}
                    multiSelectMode={multiSelectMode}
                    selectedNodeIds={selectedNodeIds}
                    selectedRelations={selectedRelations}
                    onSelectionClear={clearSelectionOnCanvas}
                    onEscapeSelection={escapeSelection}
                    selectedNodeId={selectedNodeId}
                    selectedRelation={selectedRelation}
                    // The dock narrows the canvas; its transition must not be
                    // read as a container shape change.
                    relayoutLocked={dockLayoutLocked}
                    // The panel's own size change (the fullscreen overlay) is
                    // answered by an explicit fit, and only when the drawing is
                    // still fitted — a manual zoom survives the toggle.
                    fitRequest={fitRequest}
                    onZoomModeChange={handleZoomModeChange}
                    // The renderer owns the drill-down view; reporting it keeps
                    // the export menu's PlantUML identical to the drawing.
                    onViewChange={setDiagramView}
                    // The model it actually drew, for the text page.
                    onDrawnPlantUmlChange={handleDrawnPlantUmlChange}
                    focusNodeId={focusTarget?.id ?? null}
                    focusToken={focusTarget?.token}
                    focusDrill={focusTarget?.drill ?? false}
                    // Manual curation: the drawing owns right-click/long-press
                    // and Delete/Backspace, and reports the result through the
                    // same store the inspector and the manager use.
                    canCurate={canCurateEntities}
                    pinnedNodeIds={pinnedIds}
                    onPinNode={pinNode}
                    onUnpinNode={unpinNode}
                    onRemoveNode={removeNode}
                    onHideRelation={hideRelation}
                    onSoloNode={(node) => setSoloNodeId(node.id)}
                    // The right-click menu's entry. It sends the selection the
                    // right-clicked entity belongs to, or that entity alone.
                    {...(canComposeSelection ? { onPutNodeInChat: putNodeInChat } : {})}
                    onUndo={undoCuration}
                  />
                </CanvasHeaderSlotContext.Provider>
              </CompactToolbarSlotContext.Provider>

              {/* The hover relation reading replaces the two duplicated
                  standing instructions: it only exists while a node is under
                  the pointer, so the page has no permanent hint sentence. It
                  stays a transient overlay; the readout above does not.

                  Its position is MEASURED, never pinned: the drawing paints a
                  package tab (and the class names) along its top edge, and the
                  old fixed `left-3 top-3` covered exactly that row. The panel's
                  layout effect hands the hint the first free candidate. */}
              {hoverReading !== null && (
                <div
                  data-architecture-hover-hint="true"
                  style={{
                    left: hoverHintPosition?.left ?? HOVER_HINT_MARGIN_PX,
                    top: hoverHintPosition?.top ?? HOVER_HINT_MARGIN_PX,
                    // The reading never runs across the whole canvas: at 85% on
                    // a phone it would reach into the corner slot, and the
                    // measured placement has nothing left to choose from.
                    maxWidth: 'min(85%, 720px)',
                  }}
                  className="pointer-events-none absolute z-20 flex flex-col items-start gap-1"
                >
                  <span
                    ref={hoverHintRef}
                    data-architecture-hover={hoverReading.id}
                    data-architecture-hover-name={hoverReading.label}
                    data-architecture-hover-relations={visibleHover?.relations.join(',') ?? ''}
                    data-architecture-hover-in={hoverReading.incoming}
                    data-architecture-hover-out={hoverReading.outgoing}
                    // The visible line is ONE line: when the reading does not
                    // fit it is ellipsized, never hard-clipped — and the title
                    // always carries the words the ellipsis hid.
                    title={hoverHintText}
                    style={{
                      display: 'block',
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    className="pointer-events-none rounded bg-background/90 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm"
                  >
                    {hoverHintText}
                  </span>
                </div>
              )}

              {/* The selection tray floats inside the canvas: tags, the memo,
                  the optional PlantUML attachment and the append-to-draft
                  action. On the compact tier it becomes a bottom bar/drawer.
                  The landscape-phone tier draws it as the inspector column's
                  top row instead (see `shortTouchPanelTray`), so it is not
                  rendered over the drawing at all. */}
              {selections.length > 0 && !shortTouch && (
                <ArchitectureSelectionTray
                  selections={selections}
                  graph={drawnGraph}
                  idShape={nodeIdShapeOf(granularity)}
                  view={diagramView}
                  grouping={granularity === 'file' ? 'adaptive' : 'raw'}
                  drawn={drawnPlantUml}
                  projectId={projectId}
                  projectName={projectName}
                  analyzedAt={provenance.generatedAt}
                  canCompose={canComposeSelection}
                  canRemove={canCurateEntities}
                  multiSelect={multiSelectMode}
                  expanded={trayExpanded}
                  compact={compactToolbar}
                  // The coarse drawer is drawn OVER the canvas: lift the tray
                  // (pill and expanded panel) above its top edge so the two
                  // never share screen space. The side column is in flow, so
                  // there is nothing to lift above — and the DEV drawer override
                  // deliberately keeps the overlay's covering behaviour.
                  bottomInset={dockTier === 'drawer' && dockOpen && !shortTouch ? touchDrawerHeight : 0}
                  onExpandedChange={setTrayExpanded}
                  onExitMultiSelect={() => setMultiSelectMode(false)}
                  onToggleItem={toggleSelection}
                  onClear={clearSelectionOnCanvas}
                  onCompose={composeSelectionText}
                  onRemoveSelected={removeSelected}
                />
              )}
            </div>
          </>
          )
        ) : (
          <>
            <ArchitectureEmptyState
              message={t('architecture.noSeeds', {
                defaultValue: 'This session has not referenced any file or identifier that the analysis can place.',
              })}
            />
          </>
        )}

        {legendOpen && legend}
      </div>

      {hasSeeds && (
        // `contents` keeps the dock a direct flex item on the normal layout.
        // On the overlay it becomes a floating right-hand column instead: the
        // inspector/text pages overlay the drawing rather than narrowing it.
        // The coarse tier already draws its own bottom drawer, so only the
        // fine-pointer dock is wrapped.
        <div
          data-architecture-fullscreen-dock={
            fillsViewport && dockTier !== 'drawer' ? 'true' : undefined
          }
          className={
            fillsViewport && dockTier !== 'drawer'
              ? 'absolute inset-y-0 right-0 z-40 flex max-h-full flex-col'
              : 'contents'
          }
        >
        <ArchitectureDock
          open={dockOpen}
          tier={dockTier}
          panelHeader={shortTouchPanelTray}
          title={t('architecture.dock.title', { defaultValue: 'Inspector' })}
          closeLabel={t('architecture.dock.close', { defaultValue: 'Close inspector' })}
          returnFocusRef={graphAreaRef}
          tabs={[
            {
              id: 'inspector',
              label: t('architecture.dock.title', { defaultValue: 'Inspector' }),
              content: selection === null ? (
                <p data-architecture-dock-empty="true" className="text-xs text-muted-foreground">
                  {t('architecture.dock.empty', {
                    defaultValue: 'Select a node or a relation on the drawing.',
                  })}
                </p>
              ) : selections.length > 1 ? (
                // A multi-selection has no single entity/relation detail to
                // show; the open-ended work belongs in the tray, so the
                // inspector states the count instead of picking a member.
                <div className="flex flex-col items-start gap-1">
                  <p
                    data-architecture-inspector-summary={selections.length}
                    className="text-xs text-muted-foreground"
                  >
                    {t('architecture.inspector.selectedCount', {
                      defaultValue: '{{count}} selected',
                      count: selections.length,
                    })}
                  </p>
                  {/* The same action the tray carries, with the count in its
                      label, so a multi-selection can be sent without expanding
                      the tray first. */}
                  <button
                    type="button"
                    data-architecture-inspector-put-count-in-chat={selections.length}
                    disabled={!canComposeSelection}
                    onClick={putSelectionInChat}
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('architecture.curation.putCountInChat', {
                      defaultValue: 'Put {{count}} in chat input',
                      count: selections.length,
                    })}
                  </button>
                </div>
              ) : (
                <ArchitectureInspector
                  selection={selection}
                  graph={drawnGraph}
                  idShape={nodeIdShapeOf(granularity)}
                  projectId={projectId}
                  sessionId={sessionId}
                  includeToolResults={includeToolResults}
                  onIncludeToolResultsChange={setIncludeToolResults}
                  onSelectNode={(nodeId) => dispatchSelection({ type: 'select-entity', nodeId })}
                  onCenterNode={inspectRelatedNode}
                  onOpenChat={onOpenChat}
                  canCurate={canCurateEntities}
                  pinned={selectedNodeId !== null && pinnedIdSet.has(selectedNodeId)}
                  onPinNode={pinNode}
                  onUnpinNode={unpinNode}
                  onRemoveNode={removeNode}
                  onHideRelation={hideRelation}
                  // The tray's action, offered in the inspector; the panel's
                  // compose handler is the one both call.
                  {...(canComposeSelection ? { onPutInChat: putSelectionInChat } : {})}
                  {...(hiddenReading.byNodeRelations === undefined
                    ? {}
                    : { hiddenRelations: hiddenReading.byNodeRelations })}
                  // Widening: the preset that includes every relation type, so
                  // a hidden call/structure edge is drawn again.
                  onShowRelationType={() => changeFilter({ ...filter, relations: 'call' })}
                />
              ),
            },
            {
              id: 'text',
              label: t('architecture.text.tab', { defaultValue: 'Text' }),
              content: (
                <ArchitectureTextPanel
                  graph={drawnGraph}
                  drawn={drawnPlantUml}
                  idShape={nodeIdShapeOf(granularity)}
                  granularity={granularity}
                  view={diagramView}
                  grouping={granularity === 'file' ? 'adaptive' : 'raw'}
                  selection={selection}
                  projectId={projectId}
                  sessionId={sessionId}
                  projectName={projectName}
                  sessionTitle={sessionTitle}
                  analyzedAt={provenance.generatedAt}
                  viewLabel={textViewLabel}
                  filterSummary={textFilterSummary}
                  canvasRef={graphAreaRef}
                  // The text scope's own body, appended by the same compose
                  // handler the selection tray uses.
                  {...(canComposeSelection ? { onPutInChat: composeSelectionText } : {})}
                />
              ),
            },
          ]}
          activeTabId={dockTab}
          onTabChange={(tabId) => setDockTab(tabId === 'text' ? 'text' : 'inspector')}
          onClose={closeDock}
          collapsedSummary={dockSummary}
          onTouchDrawerHeightChange={setTouchDrawerHeight}
          snapLabels={{
            collapsed: t('architecture.dock.snapCollapsed', { defaultValue: 'Collapsed' }),
            half: t('architecture.dock.snapHalf', { defaultValue: 'Half' }),
            full: t('architecture.dock.snapFull', { defaultValue: 'Full' }),
          }}
        />
        </div>
      )}

      <ArchitectureCurationManager
        open={curationManagerOpen}
        onClose={() => setCurationManagerOpen(false)}
        state={curationState}
        canEdit={canCurate}
        onRestoreItem={restoreItem}
        onRestoreEdge={restoreEdge}
        onRestoreGroup={restoreGroup}
        onRestoreAll={() => curationStore.restoreAll()}
        onClearItem={clearCurationItem}
        // The Toast's Undo, offered in the popover header once the Toast is
        // gone; `undoCuration` is the one handler both entry points call.
        canUndo={curationStore.canUndo()}
        onUndo={undoCuration}
      />

      {soloNodeId !== null && (
        <button
          type="button"
          data-architecture-curation-solo-clear="true"
          onClick={() => setSoloNodeId(null)}
          className="absolute left-1/2 top-2 z-40 -translate-x-1/2 rounded-full border border-border bg-popover px-2 py-0.5 text-[11px] font-medium text-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.curation.soloClear', { defaultValue: 'Show the whole graph' })}
        </button>
      )}

      {curationToast !== null && (
        <CurationToast
          toast={curationToast}
          undoLabel={t('architecture.curation.undo', { defaultValue: 'Undo' })}
          onUndo={undoCuration}
          onDismiss={dismissCurationToast}
        />
      )}

      {/* The confirmation / running / failure dialog for the manual re-analysis.
          Escape is captured by the dialog so the chat page's abort never fires;
          the job itself is server-side and keeps running if the dialog closes. */}
      <ArchitectureRefreshDialog
        open={refreshDialogOpen}
        phase={
          refresh.status.state === 'running'
            ? 'running'
            : refresh.status.state === 'failed'
              ? 'failed'
              : 'confirm'
        }
        elapsedMs={refresh.elapsedMs}
        error={refreshFailureReason}
        onClose={() => setRefreshDialogOpen(false)}
        onStart={refresh.start}
        returnFocusRef={refreshReturnFocusRef}
      />
      </div>
      {/* The provenance/cleanup row is the panel's FOOTER: in the document
          flow BELOW the canvas (and the dock), never a pill over the drawing.
          The canvas therefore keeps only the minimap and the zoom cluster as
          floating corner chrome. The landscape-phone tier has no standing
          footer: its reading travels inside the toolbar summary's expansion,
          which is the row that buys the drawing the 44px the footer would cost
          on a 390px-tall viewport. */}
      {!shortTouch && sourceFooter}
      </div>
    </div>
  );
}
