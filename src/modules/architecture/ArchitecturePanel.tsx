import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { PlantUmlGraph } from '@/modules/architecture/PlantUmlGraph';
import { ArchitectureCurationManager, type ArchitectureCurationPage } from '@/modules/architecture/ArchitectureCurationManager';
import { ArchitectureDock } from '@/modules/architecture/ArchitectureDock';
import { ArchitectureInspector } from '@/modules/architecture/ArchitectureInspector';
import {
  createCurationStore,
  type ArchitectureCurationHiddenEdge,
  type ArchitectureCurationItem,
  type ArchitectureCurationState,
  type CurationActionResult,
  type CurationStorageLike,
} from '@/modules/architecture/curationStore';
import { resolveCurationItems, useProjectSearch } from '@/modules/architecture/hooks/useProjectSearch';
import { ArchitectureSheet } from '@/modules/architecture/ArchitectureSheet';
import { ArchitectureSelectionTray } from '@/modules/architecture/ArchitectureSelectionTray';
import { ArchitectureTextPanel } from '@/modules/architecture/ArchitectureTextPanel';
import {
  archguardToPlantUml,
  nodeFileOf,
  type ArchitectureDiagramView,
} from '@/modules/architecture/archguardToPlantUml';
import {
  ARCHITECTURE_DETAIL_TIERS,
  ARCHITECTURE_SCOPE_MAX,
  ARCHITECTURE_SCOPE_MIN,
  clampArchitectureScope,
  DEFAULT_ARCHITECTURE_SCOPE,
  rankArchitectureDetail,
  type ArchitectureDetailTier,
} from '@/modules/architecture/detailRanking';
import {
  activeFilterCount,
  applyFilter,
  ARCHITECTURE_DEFAULT_FILTER,
  ARCHITECTURE_ELEMENT_KINDS,
  ARCHITECTURE_RELATION_PRESETS,
  ARCHITECTURE_SHOW_ALL_FILTER,
  filtersEqual,
  hiddenTotal,
  isFilterNarrower,
  relationsForPreset,
  type ArchitectureElementRelationFilter,
  type ArchitectureFilterHidden,
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
import {
  CanvasHeaderSlotContext,
  CompactToolbarSlotContext,
  TOUCH_CONTROL_GAP_PX,
  TOUCH_TARGET_STYLE,
  useTouchLayout,
} from '@/modules/architecture/hooks/useTouchLayout';
import { fitToLayoutBudget, LAYOUT_NODE_BUDGET } from '@/modules/architecture/layoutBudget';
import { buildReadout } from '@/modules/architecture/readoutNumbers';
import type {
  ArchitectureDetailReading,
  ArchitectureDrawnPlantUml,
  ArchitectureEntityKind,
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
import { useArchitectureGraph, type ArchitectureGraphResult } from '@/modules/architecture/useArchitectureGraph';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { formatAbsoluteTime, formatRelativeTime } from '@/shared/utils';

/** The two subgraphs the endpoint returns together; switching between them is local. */
type ArchitectureGranularity = 'file' | 'entity';

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
 * The server-side BFS depth the panel asks for on its first activation when the
 * project has no remembered scope. Two hops is the server's loose default
 * (`DEFAULT_HOPS` in `architecture/service.ts`); the scope stepper below is a
 * REQUEST parameter, so unlike the granularity toggle it re-enters the fetch.
 */
const DEFAULT_SCOPE = DEFAULT_ARCHITECTURE_SCOPE;

/**
 * How long a filter/view change waits before it becomes a request.
 *
 * Walking the relation presets (structural → dependency → call) is one gesture;
 * without the debounce each step would POST its own reading. Narrowing never
 * waits at all — it is answered from the payload in hand.
 */
const FILTER_REQUEST_DEBOUNCE_MS = 250;

/**
 * Where one project's two display knobs are remembered. They are deliberately
 * separate keys: the sibling element/relation-filter task reuses this storage,
 * and a reader changing only the scope must not rewrite the detail choice.
 */
const SCOPE_STORAGE_PREFIX = 'architecture.scope.';
const DETAIL_STORAGE_PREFIX = 'architecture.detail.';
const FILTER_STORAGE_PREFIX = 'architecture.filter.';
/** Whether the one-off touch instruction has been dismissed in this browser. */
const TOUCH_HINT_STORAGE_KEY = 'architecture.touchHint.dismissed';
/** Whether the right-hand dock was open the last time this browser used it. */
const DOCK_STORAGE_KEY = 'architecture.dock.open';
/**
 * How long the dock's open/close animation lasts (matching the 160ms
 * `transform` transition in `ArchitectureDock`). Aspect-driven re-layout stays
 * frozen for the duration, plus a frame of slack, so the width change caused by
 * the dock itself is never read as a container shape change.
 */
const DOCK_LAYOUT_LOCK_MS = 200;

/** Whether the dock is open by default: the design ships it CLOSED. */
function readStoredDockOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DOCK_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the dock's open/closed state; a failed write must not break the dock. */
function writeStoredDockOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DOCK_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    // Private mode: the state still holds for this session.
  }
}

/** The touch instruction is a one-off: a remembered dismissal keeps it off screen. */
function readStoredTouchHintDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TOUCH_HINT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Remember the dismissal; storage being unavailable must not resurrect the bubble. */
function writeStoredTouchHintDismissed(): void {
  try {
    window.localStorage.setItem(TOUCH_HINT_STORAGE_KEY, 'true');
  } catch {
    // Private mode: the dismissal still holds for this session.
  }
}

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
};

/** Read one project's remembered scope, clamped into the stepper's range. */
function readStoredScope(projectId: string | null): number {
  if (projectId === null || typeof window === 'undefined') return DEFAULT_SCOPE;
  try {
    const stored = window.localStorage.getItem(`${SCOPE_STORAGE_PREFIX}${projectId}`);
    if (stored === null) return DEFAULT_SCOPE;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampArchitectureScope(parsed) : DEFAULT_SCOPE;
  } catch {
    // Storage can be unavailable (private mode, embedded webview); the knob
    // still works for this visit, it just is not remembered.
    return DEFAULT_SCOPE;
  }
}

/** Read one project's remembered detail tier, falling back to the identity tier. */
function readStoredDetail(projectId: string | null): ArchitectureDetailTier {
  if (projectId === null || typeof window === 'undefined') return 'all';
  try {
    const stored = window.localStorage.getItem(`${DETAIL_STORAGE_PREFIX}${projectId}`);
    return stored !== null && (ARCHITECTURE_DETAIL_TIERS as readonly string[]).includes(stored)
      ? (stored as ArchitectureDetailTier)
      : 'all';
  } catch {
    return 'all';
  }
}

/** Remember one project's scope choice; a failed write must not break the knob. */
function writeStoredScope(projectId: string | null, scope: number): void {
  if (projectId === null) return;
  try {
    window.localStorage.setItem(`${SCOPE_STORAGE_PREFIX}${projectId}`, String(scope));
  } catch {
    // See readStoredScope: remembering is best-effort, the knob is not.
  }
}

/** Remember one project's detail choice; a failed write must not break the knob. */
function writeStoredDetail(projectId: string | null, detail: ArchitectureDetailTier): void {
  if (projectId === null) return;
  try {
    window.localStorage.setItem(`${DETAIL_STORAGE_PREFIX}${projectId}`, detail);
  } catch {
    // See readStoredScope: remembering is best-effort, the knob is not.
  }
}

/** True when `value` is one of the element axis' kinds. */
function isElementKind(value: unknown): value is (typeof ARCHITECTURE_ELEMENT_KINDS)[number] {
  return typeof value === 'string' && (ARCHITECTURE_ELEMENT_KINDS as readonly string[]).includes(value);
}

/** True when `value` is one of the relation axis' presets. */
function isRelationPreset(value: unknown): value is ArchitectureRelationPreset {
  return typeof value === 'string' && (ARCHITECTURE_RELATION_PRESETS as readonly string[]).includes(value);
}

/**
 * Read one project's remembered element/relation filter.
 *
 * The stored value is a JSON object written by this panel; a hand-edited or
 * older entry (or storage being unavailable) falls back to the shipped default
 * rather than throwing. Validation is per FIELD, so one unknown kind does not
 * discard the other two selections.
 */
function readStoredFilter(projectId: string | null): ArchitectureElementRelationFilter {
  if (projectId === null || typeof window === 'undefined') return ARCHITECTURE_DEFAULT_FILTER;
  try {
    const stored = window.localStorage.getItem(`${FILTER_STORAGE_PREFIX}${projectId}`);
    if (stored === null) return ARCHITECTURE_DEFAULT_FILTER;
    const parsed: unknown = JSON.parse(stored);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ARCHITECTURE_DEFAULT_FILTER;
    }
    const record = parsed as Record<string, unknown>;
    const kinds = Array.isArray(record.kinds)
      ? record.kinds.filter(isElementKind)
      : ARCHITECTURE_DEFAULT_FILTER.kinds;
    return {
      kinds,
      relations: isRelationPreset(record.relations)
        ? record.relations
        : ARCHITECTURE_DEFAULT_FILTER.relations,
      hideIsolated: typeof record.hideIsolated === 'boolean'
        ? record.hideIsolated
        : ARCHITECTURE_DEFAULT_FILTER.hideIsolated,
    };
  } catch {
    return ARCHITECTURE_DEFAULT_FILTER;
  }
}

/** Remember one project's filter; a failed write must not break the popover. */
function writeStoredFilter(projectId: string | null, filter: ArchitectureElementRelationFilter): void {
  if (projectId === null) return;
  try {
    window.localStorage.setItem(`${FILTER_STORAGE_PREFIX}${projectId}`, JSON.stringify(filter));
  } catch {
    // See readStoredScope: remembering is best-effort, the knob is not.
  }
}

/**
 * The browser storage the curation store persists through.
 *
 * The store's own seam is the two methods it needs, so a blocked/unavailable
 * `localStorage` (private mode, storage quota) degrades to "this page's state
 * only" instead of throwing during render.
 */
const BROWSER_CURATION_STORAGE: CurationStorageLike = {
  getItem: (key) => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    } catch {
      // Best-effort: the in-memory store keeps working for this page.
    }
  },
};

/** Add two `hidden` readings; the narrow path composes the local cut onto the server's. */
function addHidden(base: ArchitectureFilterHidden, extra: ArchitectureFilterHidden): ArchitectureFilterHidden {
  const byKind: Partial<Record<string, number>> = { ...base.byKind };
  for (const [kind, count] of Object.entries(extra.byKind)) {
    byKind[kind] = (byKind[kind] ?? 0) + (count ?? 0);
  }
  const byRelation: Record<string, number> = { ...base.byRelation };
  for (const [type, count] of Object.entries(extra.byRelation)) {
    byRelation[type] = (byRelation[type] ?? 0) + count;
  }
  return { byKind, byRelation, isolated: base.isolated + extra.isolated };
}

/** An empty `hidden` reading, for a payload whose server carried no filter stats. */
const EMPTY_HIDDEN: ArchitectureFilterHidden = { byKind: {}, byRelation: {}, isolated: 0 };

/**
 * One granularity's truncation reading, taken from the response alone.
 *
 * The per-granularity flags are optional on the wire (a payload from an older
 * server has only the legacy `truncated` boolean), so an absent flag falls back
 * to `truncated`. When a granularity was cut, the retained count IS the budget
 * the generator applied, so it stands in for the limit.
 */
function truncationReading(result: ArchitectureGraphResult, granularity: ArchitectureGranularity) {
  const { stats } = result;
  if (granularity === 'file') {
    return {
      truncated: stats.fileTruncated ?? stats.truncated,
      shown: stats.fileNodes,
      total: stats.fileTotal ?? stats.fileNodes,
    };
  }
  return {
    truncated: stats.entityTruncated ?? stats.truncated,
    shown: stats.entityNodes,
    total: stats.entityTotal ?? stats.entityNodes,
  };
}

type ArchitecturePanelProps = {
  /** The selected project's DB id; the endpoint resolves it to a project root. */
  projectId: string | null;
  /** The selected session whose transcript supplies the graph's seeds. */
  sessionId: string | null;
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
    readonly onUndo?: () => void;
    /** Multi-select: additive clicks, the marquee, and the whole set's styling. */
    readonly onToggleNodeClick?: (node: ArchitectureRendererNode) => void;
    readonly onToggleEdgeClick?: (edge: ArchitectureRendererEdge) => void;
    readonly onBoxSelect?: (selections: readonly ArchitectureSelection[]) => void;
    readonly onMultiSelectStart?: (node: ArchitectureRendererNode) => void;
    readonly multiSelectMode?: boolean;
    readonly selectedNodeIds?: readonly string[];
    readonly selectedRelations?: readonly {
      readonly from: string;
      readonly to: string;
      readonly relationType: string;
    }[];
  }
>;

/** The five formats the export menu offers; `mmd` is the legacy Mermaid pair. */
type ArchitectureExportItemId = 'puml' | 'copy' | 'svg' | 'png' | 'mmd';

type ArchitectureExportMenuProps = {
  /** Whether the menu is drawn inside the compact toolbar's overflow panel. */
  readonly compact?: boolean;
  readonly onExportPlantUml: () => void;
  readonly onCopyPlantUml: () => void;
  readonly onExportSvg: () => void;
  readonly onExportPng: () => void;
  readonly onExportMermaid: () => void;
  /** Runs after an item is chosen, so the compact overflow panel can close. */
  readonly onAction: () => void;
};

/**
 * The `Export ▾` disclosure.
 *
 * Standard menu semantics: the trigger advertises `aria-haspopup="menu"`, the
 * list is a `role="menu"` of `menuitem` buttons, arrow keys move between them,
 * and Escape closes ONLY this menu — it calls `stopPropagation` so the chat
 * page's document-level Escape (abort the running turn) never sees the key.
 * The five formats are ordered PlantUML first and the legacy Mermaid pair last;
 * the item list is the same on every layout, only its position differs (the
 * compact tier draws it inside the panel's overflow sheet).
 *
 * Used by `ArchitecturePanel` only.
 */
function ArchitectureExportMenu({
  compact = false,
  onExportPlantUml,
  onCopyPlantUml,
  onExportSvg,
  onExportPng,
  onExportMermaid,
  onAction,
}: ArchitectureExportMenuProps) {
  const { t } = useTranslation();
  // A coarse pointer needs a real 44px hit area on the disclosure AND on each
  // item; the size is inline so the reading does not depend on a stylesheet.
  const { coarsePointer } = useTouchLayout();
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  // Whether the list is expanded. Local to the disclosure: the panel does not
  // need to know (it only learns about the chosen format through the callbacks).
  const [open, setOpen] = useState(false);
  // Which item owns the roving tab stop while the menu is open.
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const items: readonly {
    readonly id: ArchitectureExportItemId;
    readonly label: string;
    readonly legacy: boolean;
    readonly run: () => void;
  }[] = [
    {
      id: 'puml',
      label: t('architecture.export.plantUml', { defaultValue: 'PlantUML (.puml)' }),
      legacy: false,
      run: onExportPlantUml,
    },
    {
      id: 'copy',
      label: t('architecture.export.copy', { defaultValue: 'Copy PlantUML' }),
      legacy: false,
      run: onCopyPlantUml,
    },
    { id: 'svg', label: t('architecture.export.svg', { defaultValue: 'SVG' }), legacy: false, run: onExportSvg },
    { id: 'png', label: t('architecture.export.png', { defaultValue: 'PNG' }), legacy: false, run: onExportPng },
    {
      id: 'mmd',
      label: t('architecture.export.mermaid', { defaultValue: 'Mermaid (.mmd, legacy)' }),
      legacy: true,
      run: onExportMermaid,
    },
  ];

  const itemCount = items.length;
  const focusItem = (index: number): void => {
    const next = ((index % itemCount) + itemCount) % itemCount;
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  };
  // The toolbar scrolls horizontally, which would clip an absolutely positioned
  // dropdown. On the desktop tier the list is therefore `position: fixed`,
  // anchored under the trigger; the compact tier draws it inline in the sheet.
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null);
  const openMenu = (): void => {
    if (!compact) {
      const rect = toggleRef.current?.getBoundingClientRect();
      if (rect !== undefined) {
        setPopoverPosition({ left: Math.max(8, rect.right - 224), top: rect.bottom + 4 });
      }
    }
    setOpen(true);
  };

  // Opening moves focus into the list, the way a disclosure menu does.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // A press outside the disclosure closes it without stealing the press.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        // Escape belongs to this menu while it is open. Stopping propagation
        // is what keeps the chat page's global abort from also firing.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItem(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(itemCount - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className={compact ? 'flex flex-col' : 'relative'}
      style={compact ? { gap: TOUCH_CONTROL_GAP_PX } : undefined}
      data-architecture-export-menu-root="true"
    >
      <button
        ref={toggleRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) close(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
        data-architecture-export="true"
        style={targetStyle}
        className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
          compact ? 'px-3 py-2 text-sm text-left' : 'px-2 py-0.5 text-xs'
        }`}
      >
        {t('architecture.export.menu', { defaultValue: 'Export ▾' })}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('architecture.export.menu', { defaultValue: 'Export ▾' })}
          data-architecture-export-menu="true"
          onKeyDown={handleMenuKeyDown}
          style={compact ? { gap: TOUCH_CONTROL_GAP_PX } : popoverPosition ?? { left: 8, top: 56 }}
          className={
            compact
              ? 'flex flex-col'
              : 'fixed z-50 flex w-56 flex-col rounded-lg border border-border bg-popover p-1 shadow-lg'
          }
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              data-architecture-export-item={item.id}
              data-architecture-export-legacy={item.legacy ? 'true' : undefined}
              style={targetStyle}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                close(false);
                onAction();
                item.run();
              }}
              className={`rounded px-2 py-1 text-left text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
                compact ? 'py-2 text-sm' : ''
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The panel's empty state, for both "no session selected" and "no seeds found". */
function ArchitectureEmptyState({ message }: { message: string }) {
  return (
    <p data-architecture-empty="true" className="p-6 text-sm text-muted-foreground">
      {message}
    </p>
  );
}

/** How long a curation Toast lives before dismissing itself. */
const CURATION_TOAST_MS = 6000;

/**
 * The curation Toast: one sentence about what just changed, plus a focusable
 * 撤销 action. It auto-dismisses after {@link CURATION_TOAST_MS}, and hovering
 * or focusing inside it pauses that timer (so a keyboard user can reach the
 * undo button without racing it).
 */
function CurationToast({
  toast,
  undoLabel,
  onUndo,
  onDismiss,
}: {
  readonly toast: { readonly id: number; readonly message: string; readonly undoable: boolean };
  readonly undoLabel: string;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}) {
  // Whether the pointer/focus currently holds the Toast open; it pauses the
  // auto-dismiss so the undo action cannot disappear under the reader's hands.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, CURATION_TOAST_MS);
    return () => clearTimeout(timer);
  }, [paused, onDismiss, toast.id]);

  return (
    <div
      role="status"
      data-architecture-curation-toast="true"
      // The toast floats above the drawing, bottom-centre so it never covers
      // the toolbar or the dock.
      style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 60 }}
      className="flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-[11px] text-foreground shadow-lg"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span data-architecture-curation-toast-message="true">{toast.message}</span>
      {toast.undoable && (
        <button
          type="button"
          data-architecture-curation-undo="true"
          onClick={onUndo}
          className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {undoLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Dismiss a disclosure popover the way every menu in this panel must behave:
 * a press outside it closes it WITHOUT swallowing that press (the listener is
 * a plain `mousedown` observer, so the click still reaches its target), and
 * Escape closes it before the chat page's document-level Escape can abort the
 * running turn, returning focus to the disclosure that opened it.
 *
 * Used by `ArchitecturePanel` for the filter, legend and "Adjusted" popovers.
 */
function useDismissiblePopover(
  open: boolean,
  close: () => void,
  triggerRef: { readonly current: HTMLElement | null },
  panelSelector: string,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (triggerRef.current?.contains(target) === true) return;
      if (document.querySelector(panelSelector)?.contains(target) === true) return;
      // No preventDefault: the press that closed the popover still lands.
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Capture phase: this runs before the chat page's document-level abort.
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close, triggerRef, panelSelector]);
}

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
  renderer: Renderer = PlantUmlGraph as ArchitecturePanelRenderer,
  initialGranularity = 'entity',
  onOpenChat,
}: ArchitecturePanelProps) {
  // `i18n` is the readout's locale (locale-aware times); `t` labels both knobs.
  const { t, i18n } = useTranslation();

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
  const { coarsePointer, compactToolbar } = useTouchLayout();
  const headerButtonClass = coarsePointer
    ? 'rounded-md px-3 text-sm font-medium'
    : 'rounded-md px-2 py-0.5 text-xs font-medium';
  // The explicit 44px box on every compact-row control; on a coarse pointer the
  // reading must not depend on the stylesheet (see TOUCH_TARGET_STYLE).
  const compactTargetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  // Which of the two server subgraphs is on screen. Purely local state: both
  // arrive in one response, so this must never re-enter the fetch. The class
  // diagram is the shipped default (the entity subgraph is the one that has
  // entity kinds and members).
  const [granularity, setGranularity] = useState<ArchitectureGranularity>(initialGranularity);
  // The two display knobs, remembered per project (localStorage). `scope` is
  // the requested BFS depth — a server generation parameter and part of the
  // result cache's key, so changing it refetches; `detail` only ranks the
  // arrived payload, so changing it must never refetch. The pair is one state
  // object because a project switch reloads both together.
  const [displaySettings, setDisplaySettings] = useState<ArchitectureDisplaySettings>(() => ({
    projectId,
    scope: readStoredScope(projectId),
    detail: readStoredDetail(projectId),
  }));
  // React's "adjust state when a prop changes" pattern: a project switch swaps
  // the remembered pair in the same render, so the graph is never requested
  // with the previous project's depth.
  if (displaySettings.projectId !== projectId) {
    setDisplaySettings({
      projectId,
      scope: readStoredScope(projectId),
      detail: readStoredDetail(projectId),
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
  // The store is per `(project, session)`: the graph's seeds are the session's
  // transcript, so a project has no curation of its own. A missing session
  // leaves `canEdit: false`, which disables the whole feature (and says why).
  const curationStore = useMemo(
    () => createCurationStore({ storage: BROWSER_CURATION_STORAGE, projectId, sessionId }),
    [projectId, sessionId],
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
  const [requestGranularity, setRequestGranularity] = useState<ArchitectureGranularity>(initialGranularity);
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
  // The request the server is asked for. `kinds` rides only on the entity view
  // (a file has no element kind); `relations` rides on both views.
  const graphQuery = useMemo(
    () => ({
      ...(requestGranularity === 'entity' ? { kinds: requestFilter.kinds } : {}),
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
    () => ({ kinds: effectiveKinds, relations: filter.relations, hideIsolated: filter.hideIsolated }),
    [effectiveKinds, filter.relations, filter.hideIsolated],
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
  // Whether the dock is on screen. Remembered per browser, and forced open by a
  // fresh selection (the gesture that selects is a request to inspect).
  const [dockOpen, setDockOpen] = useState<boolean>(readStoredDockOpen);
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
  // ("raise detail", "reduce scope") live behind this toggle.
  const [readoutOpen, setReadoutOpen] = useState(false);
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
  // The rendered drawing's container, so the export actions can read the live
  // SVG without the renderer having to hand its host ref up the tree.
  const graphAreaRef = useRef<HTMLDivElement | null>(null);
  const copyFallbackRef = useRef<HTMLTextAreaElement | null>(null);
  // A fallback dialog opens with its text already selected, so the documented
  // "select and copy" path is one keystroke rather than a drag.
  useEffect(() => {
    if (copyFallbackText === null) return;
    copyFallbackRef.current?.focus();
    copyFallbackRef.current?.select();
  }, [copyFallbackText]);

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
   * Apply a new selection.
   *
   * A NARROWER selection is answered from the payload in hand — that is the
   * whole "收窄即时" half of the design — with one exception: if the arrived
   * reading was truncated, the freed budget may have exposed more nodes than
   * this payload carries, so it asks the server in the background. A WIDER (or
   * incomparable) selection cannot be reconstructed from a payload that already
   * had it cut away, so it always re-requests; the old drawing stays on screen
   * (`refreshing`) until the answer arrives.
   */
  const changeFilter = (next: ArchitectureElementRelationFilter): void => {
    setFilterSettings((current) => ({ ...current, filter: next }));
    writeStoredFilter(projectId, next);
    if (filtersEqual(next, requestFilter)) {
      cancelScheduledRequest();
      return;
    }
    if (isFilterNarrower(next, requestFilter)) {
      const truncated = view.status === 'loaded'
        && (granularity === 'file'
          ? (view.result.stats.fileTruncated ?? view.result.stats.truncated)
          : (view.result.stats.entityTruncated ?? view.result.stats.truncated));
      if (truncated) scheduleRequest(next, requestGranularity);
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
  // folded away is still findable and can be reported as out of range.
  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0 || activeNeighbourhood === null) return [];
    return activeNeighbourhood.nodes
      .filter((node) => node.id.toLowerCase().includes(query) || node.label.toLowerCase().includes(query))
      .slice(0, 8)
      .map((node) => ({
        node,
        inRange: detailRanking?.retainedNodeIds.has(node.id) ?? false,
      }));
  }, [activeNeighbourhood, detailRanking, searchQuery]);

  const revealNode = (nodeId: string, outOfRange: boolean): void => {
    // A folded node is only out of range because of the detail tier: raise it
    // to the identity tier before asking the renderer to show the node.
    if (outOfRange) changeDetail('all');
    // Revealing a node is a request to leave the "only show this pin" slice.
    setSoloNodeId(null);
    setFocusTarget((current) => ({ id: nodeId, token: (current?.token ?? 0) + 1 }));
    setSearchOpen(false);
  };

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

  /**
   * Open or close the dock and freeze aspect re-layout for the transition.
   * The lock is a plain boolean handed to the renderer; the panel owns its
   * lifetime because the panel owns the dock.
   */
  const changeDockOpen = useCallback((next: boolean): void => {
    setDockOpen(next);
    writeStoredDockOpen(next);
    setDockLayoutLocked(true);
    if (dockLockTimerRef.current !== null) clearTimeout(dockLockTimerRef.current);
    dockLockTimerRef.current = setTimeout(() => {
      dockLockTimerRef.current = null;
      setDockLayoutLocked(false);
    }, DOCK_LAYOUT_LOCK_MS);
  }, []);
  useEffect(() => () => {
    if (dockLockTimerRef.current !== null) clearTimeout(dockLockTimerRef.current);
  }, []);

  // Selecting anything is a request to inspect it: a NEW selection opens the
  // dock. Keyed on the selection alone — closing the dock must keep the
  // selection without the effect immediately reopening it (Escape's first press
  // closes the dock, its second clears the selection).
  const dockOpenRef = useRef(dockOpen);
  useEffect(() => {
    dockOpenRef.current = dockOpen;
  }, [dockOpen]);
  useEffect(() => {
    if (selection !== null && !dockOpenRef.current) changeDockOpen(true);
  }, [selection, changeDockOpen]);

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
   * (the selection survives), then the dock closes, then the selection clears.
   * `stopPropagation` happens in the renderer, so the chat page's global abort
   * never fires.
   */
  const escapeSelection = useCallback((): void => {
    if (trayExpanded) {
      setTrayExpanded(false);
      return;
    }
    if (dockOpen) {
      changeDockOpen(false);
      return;
    }
    setMultiSelectMode(false);
    dispatchSelection({ type: 'clear' });
  }, [dockOpen, changeDockOpen, trayExpanded]);
  /** A click on the empty canvas clears the selection AND closes the dock. */
  const clearSelectionOnCanvas = useCallback((): void => {
    dispatchSelection({ type: 'clear' });
    setMultiSelectMode(false);
    if (dockOpen) changeDockOpen(false);
  }, [dockOpen, changeDockOpen]);
  // An empty set has nothing to expand: reset both tray readings with it, so a
  // later selection starts from the pill rather than a stale drawer.
  useEffect(() => {
    if (selections.length > 0) return;
    setTrayExpanded(false);
    setMultiSelectMode(false);
  }, [selections.length]);
  /** Selecting a related node from the inspector also centres it in the drawing. */
  const inspectRelatedNode = (nodeId: string): void => {
    dispatchSelection({ type: 'select-entity', nodeId });
    revealNode(nodeId, false);
  };

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
      <p data-architecture-loading="true" className="p-6 text-sm text-muted-foreground">
        {t('architecture.loading', { defaultValue: 'Generating the architecture graph…' })}
      </p>
    );
  }

  if (view.status === 'error') {
    return (
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
   * The PlantUML document for the view on screen, exactly as the bridge builds
   * it. The file graph is the adaptive consumer (its overview folds directory
   * layers); the class graph is never folded — its document draws the entities
   * in package frames, matching the drawing the reader sees.
   */
  const currentPlantUml = (): string =>
    archguardToPlantUml(drawnGraph, {
      view: diagramView,
      grouping: granularity === 'file' ? 'adaptive' : 'raw',
      idShape: nodeIdShapeOf(granularity),
    }).puml;

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
          changeDockOpen(false);
          return;
        }
        setDockTab('text');
        if (!dockOpen) changeDockOpen(true);
      }}
      data-architecture-text-toggle="true"
      style={compactTargetStyle}
      className={`${headerButtonClass} border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      {t('architecture.text.open', { defaultValue: 'Text' })}
    </button>
  );

  const truncation = truncationReading(result, granularity);
  // How many nodes the server's node budget left out of this subgraph. The
  // compact toolbar badge and the marker's data attributes read it; the
  // expanded explanation states it as one of its layers.
  const budgetOmitted = Math.max(0, truncation.total - truncation.shown);
  // The ONE reading the reader gets: N is what the layout was handed (group
  // boxes count their members), M is the server's pre-budget total. The pure
  // function decides which budget layers are named; the panel only renders it.
  const readout = buildReadout({
    detailRetained: detailRanking?.retainedNodeIds.size ?? neighbourhood.nodes.length,
    drawnBoxes: layoutFit?.graph.nodes ?? [],
    returnedCount: truncation.shown,
    relatedTotal: truncation.total,
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
        className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
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
        className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
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
                  {count === undefined ? kindLabel(kind) : `${String(count)} ${kindLabel(kind)}`}
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
    </div>
  );

  const filterTriggerLabel = t('architecture.filter.menu', { defaultValue: 'Filter ▾' });
  const filterBadge = activeFilterCount(filter);
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
          className="ml-1 rounded-full bg-accent px-1.5 text-[10px] tabular-nums text-foreground"
        >
          {t('architecture.filter.badge', { defaultValue: '{{count}} on', count: filterBadge })}
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
  const chooseSearchOption = (index: number): void => {
    if (index < searchMatches.length) {
      const match = searchMatches[index];
      revealNode(match.node.id, !match.inRange);
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
          // Shift+Enter pins the first project-wide hit (the second group's
          // keyboard equivalent of `＋`).
          if (
            event.shiftKey
            && canCurate
            && projectSearch.search.status === 'ready'
            && projectSearch.search.results.length > 0
          ) {
            event.preventDefault();
            pinItem(projectSearch.search.results[0]);
            return;
          }
          if (activeSearchIndex >= 0) {
            event.preventDefault();
            chooseSearchOption(activeSearchIndex);
            return;
          }
          if (searchMatches.length > 0) {
            const first = searchMatches[0];
            revealNode(first.node.id, !first.inRange);
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
              <button
                key={match.node.id}
                id={searchOptionId(index)}
                type="button"
                role="option"
                aria-selected={activeSearchIndex === index}
                data-architecture-search-option-index={index}
                data-architecture-search-result={match.node.id}
                data-architecture-search-in-range={match.inRange}
                onClick={() => revealNode(match.node.id, !match.inRange)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <span className="min-w-0 truncate">{match.node.label}</span>
                {!match.inRange && (
                  <span className="shrink-0 text-amber-600 dark:text-amber-400">
                    {t('architecture.search.outOfRange', { defaultValue: 'Not in current range' })}
                  </span>
                )}
              </button>
            ))
          )}

          {canCurate && searchQuery.trim().length >= 2 && (
            <>
              <p
                data-architecture-search-group="project"
                className="mt-1 border-t border-border/60 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t('architecture.search.other', { defaultValue: 'Elsewhere in the project' })}
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
                    projectSearch.search.results.map((hit, projectIndex) => (
                      <div
                        key={hit.id}
                        id={searchOptionId(searchMatches.length + projectIndex)}
                        role="option"
                        aria-selected={activeSearchIndex === searchMatches.length + projectIndex}
                        data-architecture-search-project-result={hit.id}
                        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                      >
                        <span aria-hidden="true" className="w-3 shrink-0 text-center text-muted-foreground">
                          {searchKindGlyph(hit.kind)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{hit.name}</span>
                          <span className="ml-1 text-muted-foreground">{hit.file}</span>
                        </span>
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
                    ))
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

  // The legend body names every visual vocabulary the drawing uses, including
  // the text form of the old circular fold badge (`+N folded`). It is drawn in
  // the desktop `?` popover and, on the compact tier, directly inside the
  // bottom sheet (the sheet is the one place the phone's readings live).
  const legendBody = (
    <div
      data-architecture-legend-content="true"
      className="whitespace-pre-line text-[11px] text-muted-foreground"
    >
      {t('architecture.legend.body', {
        defaultValue:
          'Solid line: association or call.\nDashed line: dependency or implementation.\nArrows: △ inheritance · △ implementation · ◆ composition · ◇ aggregation · → dependency.\n«stereotype» marks the entity kind.\n● seed: named in this session.\n+N folded: hidden by the current detail level.',
      })}
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
  const kindCounts = stats.kindCounts;
  const kindLine = kindCounts === undefined
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

  const classNoun = granularity === 'entity' ? 'class' : 'file';
  const readoutSummary = classNoun === 'class'
    ? t('architecture.readout.classSummary', {
        defaultValue: 'Showing {{shown}} classes · {{total}} related',
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
  const hiddenKindParts = Object.entries(hiddenReading.byKind)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([kind, count]) => `${String(count)} ${kindLabel(kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number])}`);
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
    <div
      data-architecture-source-footer="true"
      className="relative z-20 flex shrink-0 items-center gap-2 overflow-hidden border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground"
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
        {' · '}
        <button
          type="button"
          aria-expanded={unresolvedOpen}
          data-architecture-unresolved={unresolvedCount}
          onClick={() => setUnresolvedOpen((open) => !open)}
          style={compactTargetStyle}
          className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.source.unresolved', {
            defaultValue: '{{count}} names mentioned in this session were not found in the analysis cache',
            count: unresolvedCount,
          })}
          <span aria-hidden="true">{unresolvedOpen ? ' ▾' : ' ▸'}</span>
        </button>
      </span>
      {unresolvedOpen && (
        <ul
          data-architecture-unresolved-list="true"
          aria-label={t('architecture.source.listLabel', { defaultValue: 'Unresolved names' })}
          className="absolute bottom-full left-3 z-30 mb-1 max-h-40 overflow-y-auto rounded-md border border-border/60 bg-background/95 px-2 py-1 shadow-sm"
        >
          {unresolvedNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
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
  const readoutPanel = (
    <div
      data-architecture-readout="true"
      aria-live="polite"
      className="pointer-events-auto max-w-full rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm"
    >
      <button
        type="button"
        aria-expanded={readoutOpen}
        onClick={() => setReadoutOpen((open) => !open)}
        data-architecture-readout-toggle="true"
        style={compactTargetStyle}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span data-architecture-readout-summary={readout.shown} data-architecture-readout-total={readout.related}>
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
      {/* The filter's second line: what the element/relation selection is
          hiding, and the one-click reset. Deliberately separate from the
          detail sentence above — the two knobs must not share a number. */}
      {hiddenCount > 0 && (
        <div
          data-architecture-filter-hidden={hiddenCount}
          data-architecture-filter-hidden-kinds={JSON.stringify(hiddenReading.byKind)}
          data-architecture-filter-hidden-relations={JSON.stringify(hiddenReading.byRelation)}
          data-architecture-filter-hidden-isolated={hiddenReading.isolated}
          className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
        >
          <span>
            {t('architecture.filter.hiddenPrefix', {
              defaultValue: 'Hidden {{parts}}',
              parts: hiddenParts.join(' · '),
            })}
          </span>
          <button
            type="button"
            data-architecture-filter-show-all="true"
            onClick={() => changeFilter(ARCHITECTURE_SHOW_ALL_FILTER)}
            style={compactTargetStyle}
            className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.filter.showAll', { defaultValue: '▸ Show all' })}
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

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-architecture-panel="true">
      {/* The one-off touch bubble's own fade. It is keyed CSS (not a JS timer)
          so the dismissal runs off the animation end even in a background tab,
          and a test can drive it with a single animation event. */}
      <style>{'@keyframes architecture-touch-hint-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }'}</style>
      <div
        data-architecture-toolbar="true"
        style={compactToolbar ? { gap: TOUCH_CONTROL_GAP_PX } : undefined}
        // The row WRAPS rather than scrolls. `overflow-x: auto` also makes the
        // block axis a scroll container, which clipped every absolutely
        // positioned child — the search results were cut to a 3px line. Wrapping
        // keeps the popovers in normal paint flow, and the desktop row still
        // fits one line at its breakpoint (it only wraps when the width really
        // runs out, which is preferable to hiding controls in a scroller).
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5"
      >
        {compactToolbar ? (
          <>
            {granularityGroup}
            <span className="flex-1" />
            {textToggle}
            <button
              ref={sheetTriggerRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              aria-label={t('architecture.sheet.open', { defaultValue: 'Adjust' })}
              onClick={() => setSheetOpen(true)}
              data-architecture-sheet-toggle="true"
              style={compactTargetStyle}
              className="rounded-lg border border-border px-3 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.sheet.open', { defaultValue: 'Adjust' })}
            </button>
          </>
        ) : (
          <>
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
            {textToggle}
            {exportMenu}
            {legendButton}
          </>
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
          <>
            {/* Desktop keeps its in-flow row: the readout on the left, the
                renderer's zoom tier and scale on the right. The compact tier
                has no such row — its readout floats on the drawing and the
                renderer's view chrome is portaled into the bottom sheet. */}
            {!compactToolbar && (
              <div
                data-architecture-canvas-header="true"
                className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-1"
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
            {compactToolbar && (
              <div
                data-architecture-canvas-header="true"
                data-architecture-readout-overlay="true"
                className="flex shrink-0 border-b border-border/60 px-3 py-1"
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
              className={`relative flex min-h-0 flex-1 flex-col transition-opacity ${refreshing ? 'opacity-60' : ''}`}
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
                    // The detail knob's two numbers, so a renderer that has a
                    // visible-summary slot can report shown/in-scope rather than
                    // its own drawn/total reading.
                    detailReading={detailReading}
                    // Which subgraph this is decides how ids are read (label and
                    // group prefixes). The renderer must not have to guess: see
                    // `nodeIdShapeOf`.
                    idShape={nodeIdShapeOf(granularity)}
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
                    // The renderer owns the drill-down view; reporting it keeps
                    // the export menu's PlantUML identical to the drawing.
                    onViewChange={setDiagramView}
                    // The model it actually drew, for the text page.
                    onDrawnPlantUmlChange={setDrawnPlantUml}
                    focusNodeId={focusTarget?.id ?? null}
                    focusToken={focusTarget?.token}
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
                    onUndo={undoCuration}
                  />
                </CanvasHeaderSlotContext.Provider>
              </CompactToolbarSlotContext.Provider>

              {/* The hover relation reading replaces the two duplicated
                  standing instructions: it only exists while a node is under
                  the pointer, so the page has no permanent hint sentence. It
                  stays a transient overlay; the readout above does not. */}
              {visibleHover !== null && (
                <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[85%] flex-col items-start gap-1">
                  <span
                    data-architecture-hover={visibleHover.node.id}
                    data-architecture-hover-relations={visibleHover.relations.join(',')}
                    className="pointer-events-none rounded bg-background/90 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm"
                  >
                    {t('architecture.hover.relations', {
                      defaultValue: '{{node}} — relations: {{relations}}',
                      node: visibleHover.node.id,
                      relations:
                        visibleHover.relations.length === 0
                          ? t('architecture.hover.none', { defaultValue: 'no outgoing/incoming relation' })
                          : visibleHover.relations.join(', '),
                    })}
                  </span>
                </div>
              )}

              {/* The selection tray floats inside the canvas: tags, the memo,
                  the optional PlantUML attachment and the append-to-draft
                  action. On the compact tier it becomes a bottom bar/drawer. */}
              {selections.length > 0 && (
                <ArchitectureSelectionTray
                  selections={selections}
                  graph={drawnGraph}
                  idShape={nodeIdShapeOf(granularity)}
                  view={diagramView}
                  grouping={granularity === 'file' ? 'adaptive' : 'raw'}
                  drawn={drawnPlantUml}
                  projectId={projectId}
                  analyzedAt={provenance.generatedAt}
                  canCompose={canComposeSelection}
                  canRemove={canCurateEntities}
                  multiSelect={multiSelectMode}
                  expanded={trayExpanded}
                  compact={compactToolbar}
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
        <ArchitectureDock
          open={dockOpen}
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
                <p
                  data-architecture-inspector-summary={selections.length}
                  className="text-xs text-muted-foreground"
                >
                  {t('architecture.inspector.selectedCount', {
                    defaultValue: '{{count}} selected',
                    count: selections.length,
                  })}
                </p>
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
                  analyzedAt={provenance.generatedAt}
                  viewLabel={textViewLabel}
                  filterSummary={textFilterSummary}
                  canvasRef={graphAreaRef}
                />
              ),
            },
          ]}
          activeTabId={dockTab}
          onTabChange={(tabId) => setDockTab(tabId === 'text' ? 'text' : 'inspector')}
          onClose={() => changeDockOpen(false)}
          collapsedSummary={dockSummary}
          snapLabels={{
            collapsed: t('architecture.dock.snapCollapsed', { defaultValue: 'Collapsed' }),
            half: t('architecture.dock.snapHalf', { defaultValue: 'Half' }),
            full: t('architecture.dock.snapFull', { defaultValue: 'Full' }),
          }}
        />
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
      </div>
      {/* The provenance/cleanup row is the panel's FOOTER: in the document
          flow BELOW the canvas (and the dock), never a pill over the drawing.
          The canvas therefore keeps only the minimap and the zoom cluster as
          floating corner chrome. */}
      {sourceFooter}
      </div>
    </div>
  );
}
