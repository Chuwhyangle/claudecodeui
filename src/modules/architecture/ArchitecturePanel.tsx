import { type ComponentType, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PlantUmlGraph } from '@/modules/architecture/PlantUmlGraph';
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
  CompactToolbarSlotContext,
  TOUCH_TARGET_STYLE,
  useTouchLayout,
} from '@/modules/architecture/hooks/useTouchLayout';
import type {
  ArchitectureDetailReading,
  ArchitectureNodeIdShape,
  ArchitectureRendererHover,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';
import { useArchitectureGraph, type ArchitectureGraphResult } from '@/modules/architecture/useArchitectureGraph';

/** The two subgraphs the endpoint returns together; switching between them is local. */
type ArchitectureGranularity = 'file' | 'entity';

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
 * Where one project's two display knobs are remembered. They are deliberately
 * separate keys: the sibling element/relation-filter task reuses this storage,
 * and a reader changing only the scope must not rewrite the detail choice.
 */
const SCOPE_STORAGE_PREFIX = 'architecture.scope.';
const DETAIL_STORAGE_PREFIX = 'architecture.detail.';

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

/**
 * Render an analysis timestamp as a relative reading ("3 hours ago").
 *
 * The panel used to print the raw UTC ISO string, which a reader had to
 * translate in their head. The precision stays available in `title` (the local
 * `toLocaleString()`), while the visible text answers the only question the
 * source line asks: how old is this analysis?
 */
function formatRelativeTime(iso: string | null): string {
  if (iso === null) return 'unknown';
  const analysed = Date.parse(iso);
  if (Number.isNaN(analysed)) return 'unknown';
  const seconds = Math.round((analysed - Date.now()) / 1000);
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, 'second');
}

/** The precise local instant behind a relative reading; the `<time>` title. */
function formatAbsoluteTime(iso: string | null): string | undefined {
  if (iso === null) return undefined;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString();
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
  }
>;

/**
 * Save a Mermaid document as a `.mmd` file.
 *
 * The `.mmd` pair is no longer the default render path (the panel draws the
 * neighbourhood JSON), but ADR-005 keeps it as the export format: the server
 * still generates both documents, so exporting is a Blob write with no request.
 */
function downloadMermaid(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The panel's empty state, for both "no session selected" and "no seeds found". */
function ArchitectureEmptyState({ message }: { message: string }) {
  return (
    <p data-architecture-empty="true" className="p-6 text-sm text-muted-foreground">
      {message}
    </p>
  );
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
}: ArchitecturePanelProps) {
  const { t } = useTranslation();
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
  const { view, reload } = useArchitectureGraph(projectId, sessionId, scope);
  // The detail tier's cut of the current subgraph. Memoised on the payload and
  // the tier: the renderer redraws whenever its `graph` prop changes identity,
  // so a fresh object on every panel render (a hover!) would re-lay the diagram.
  const activeNeighbourhood = view.status === 'loaded' ? view.result.graph[granularity] : null;
  const detailRanking = useMemo(
    () => (activeNeighbourhood === null
      ? null
      : rankArchitectureDetail(activeNeighbourhood.nodes, activeNeighbourhood.edges, detail)),
    [activeNeighbourhood, detail],
  );
  // The two numbers the detail knob reports: retained vs. in-scope (pre-cut).
  const detailReading = useMemo<ArchitectureDetailReading | undefined>(
    () => (detailRanking === null || activeNeighbourhood === null
      ? undefined
      : { shown: detailRanking.retainedNodeIds.size, totalInScope: activeNeighbourhood.nodes.length }),
    [detailRanking, activeNeighbourhood],
  );
  // Whether the compact tier's single "…" menu is open. On that tier the panel
  // draws one toolbar row and every other control lives behind this toggle.
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  // The menu's DOM node while it is open. It is handed to the renderer through
  // `CompactToolbarSlotContext` so the graph's own controls are drawn inside the
  // same menu instead of in a second toolbar row.
  const [compactMenuHost, setCompactMenuHost] = useState<HTMLElement | null>(null);
  // A coarse pointer has no hover, so the touch instruction is shown once and
  // then dismissed — either by its close button or by the first node selection.
  // It never becomes a permanent row the way the old gesture line was.
  const [touchHintDismissed, setTouchHintDismissed] = useState(false);
  // The node the reader asked to see, and the token that re-triggers the same
  // request. The renderer navigates to it and centres it; the panel only holds
  // the request so a search hit survives the renderer's own navigation state.
  const [focusTarget, setFocusTarget] = useState<ArchitectureFocusTarget | null>(null);
  // The one-line readout's expanded state: the explanation and the two knobs
  // ("raise detail", "reduce scope") live behind this toggle.
  const [readoutOpen, setReadoutOpen] = useState(false);
  // The `?` legend popover; shut by default so the drawing owns the canvas.
  const [legendOpen, setLegendOpen] = useState(false);
  // The source line's unresolved-names list, expanded on demand rather than
  // printing every unresolved identifier as a permanent row.
  const [unresolvedOpen, setUnresolvedOpen] = useState(false);
  // The search box's text. It is local because it only filters the payload in
  // hand; selecting a result is what changes the graph.
  const [searchQuery, setSearchQuery] = useState('');
  // Whether the match list is open. Focus loss is deliberately not a close
  // trigger (a click on a result would blur the input first); selecting a
  // result, pressing Escape, or clearing the box closes it.
  const [searchOpen, setSearchOpen] = useState(false);

  const changeScope = (next: number): void => {
    const clamped = clampArchitectureScope(next);
    setDisplaySettings((current) => ({ ...current, scope: clamped }));
    writeStoredScope(projectId, clamped);
  };
  const changeDetail = (next: ArchitectureDetailTier): void => {
    setDisplaySettings((current) => ({ ...current, detail: next }));
    writeStoredDetail(projectId, next);
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
    setFocusTarget((current) => ({ id: nodeId, token: (current?.token ?? 0) + 1 }));
    setSearchOpen(false);
  };

  if (!sessionId) {
    return (
      <ArchitectureEmptyState
        message={t('architecture.noSession', {
          defaultValue: 'Select a session to see the architecture of the files it touched.',
        })}
      />
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
  const hasSeeds = stats.seedFiles > 0 || stats.seedIdentifiers > 0;
  const neighbourhood = result.graph[granularity];
  // A reading from the previous graph is not shown against this one.
  const visibleHover = hovered !== null && hovered.key === hoverKey ? hovered.hover : null;

  const exportMmd = (): void => {
    downloadMermaid(
      granularity === 'file' ? mmd.file : mmd.entity,
      `architecture-${granularity}.mmd`,
    );
  };
  // The graph's overflow menu is the panel's menu: exporting from it must also
  // close it, so the panel owns that one extra step.
  const exportFromMenu = (): void => {
    setCompactMenuOpen(false);
    exportMmd();
  };

  const truncation = truncationReading(result, granularity);
  // How many nodes the server's node budget left out of this subgraph. The
  // readout answers this inline instead of printing a budget number.
  const budgetOmitted = Math.max(0, truncation.total - truncation.shown);
  const retainedCount = detailRanking?.retainedNodeIds.size ?? neighbourhood.nodes.length;
  const inScopeCount = activeNeighbourhood?.nodes.length ?? neighbourhood.nodes.length;
  const foldedCount = detailRanking?.foldedCount ?? 0;

  // Both subgraphs are in hand; toggling only picks one, so it must not refetch.
  // The two options are a radiogroup because exactly one graph is on screen.
  const granularityGroup = (
    <div
      role="radiogroup"
      aria-label={t('architecture.granularity', { defaultValue: 'Graph granularity' })}
      data-architecture-view-control="true"
      className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={granularity === 'entity'}
        onClick={() => setGranularity('entity')}
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
        onClick={() => setGranularity('file')}
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
      className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5"
    >
      <button
        type="button"
        aria-label={t('architecture.controls.scopeDecrease', { defaultValue: 'Decrease scope' })}
        data-architecture-scope-decrease="true"
        onClick={() => changeScope(scope - 1)}
        disabled={scope <= ARCHITECTURE_SCOPE_MIN}
        style={compactTargetStyle}
        className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
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
        className={`min-w-8 rounded px-1 text-center tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
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
        className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
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
      className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5"
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

  // The export slot is a menu-shaped button (`Export ▾`); the menu itself is a
  // sibling task's scope, so for now it writes the current subgraph's `.mmd`.
  const exportButton = (
    <button
      type="button"
      onClick={exportMmd}
      data-architecture-export="true"
      style={compactTargetStyle}
      className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
        coarsePointer ? 'px-3 text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {t('architecture.export.menu', { defaultValue: 'Export ▾' })}
    </button>
  );

  // The search box. Its matches are drawn in a listbox under the input; an
  // out-of-range match is labelled so the reader knows the detail level folded
  // it, and choosing it raises the tier and reveals it.
  const searchBox = (
    <div className="relative">
      <input
        type="search"
        value={searchQuery}
        aria-label={t('architecture.search.label', { defaultValue: 'Search entities or files' })}
        placeholder={t('architecture.search.placeholder', { defaultValue: 'Search entities or files…' })}
        data-architecture-search="true"
        onChange={(event) => {
          setSearchQuery(event.target.value);
          setSearchOpen(true);
        }}
        onFocus={() => setSearchOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setSearchOpen(false);
          } else if (event.key === 'Enter' && searchMatches.length > 0) {
            const first = searchMatches[0];
            revealNode(first.node.id, !first.inRange);
          }
        }}
        className="w-40 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      />
      {searchOpen && searchQuery.trim().length > 0 && (
        <div
          data-architecture-search-results="true"
          className="absolute left-0 top-full z-30 mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {searchMatches.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              {t('architecture.search.noMatches', { defaultValue: 'No matches' })}
            </p>
          ) : (
            searchMatches.map((match) => (
              <button
                key={match.node.id}
                type="button"
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
        </div>
      )}
    </div>
  );

  // `?` opens the legend: the place the two duplicated hover instructions and
  // the meaning of every line, arrow, stereotype, seed marker and folded badge
  // now live.
  const legendButton = (
    <button
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
  // the text form of the old circular fold badge (`+N folded`).
  const legend = (
    <div
      data-architecture-legend="true"
      role="dialog"
      aria-label={t('architecture.legend.title', { defaultValue: 'Legend' })}
      className="absolute right-2 top-11 z-40 w-80 whitespace-pre-line rounded-lg border border-border bg-popover p-3 text-[11px] text-muted-foreground shadow-lg"
    >
      {t('architecture.legend.body', {
        defaultValue:
          'Solid line: association or call.\nDashed line: dependency or implementation.\nArrows: △ inheritance · △ implementation · ◆ composition · ◇ aggregation · → dependency.\n«stereotype» marks the entity kind.\n● seed: named in this session.\n+N folded: hidden by the current detail level.',
      })}
    </div>
  );

  const unresolvedNames = [...stats.unresolved.files, ...stats.unresolved.identifiers];
  const unresolvedCount = unresolvedNames.length;
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
        shown: retainedCount,
        total: inScopeCount,
      })
    : t('architecture.readout.fileSummary', {
        defaultValue: 'Showing {{shown}} files · {{total}} related',
        shown: retainedCount,
        total: inScopeCount,
      });

  const raiseDetail = (): void => {
    const index = ARCHITECTURE_DETAIL_TIERS.indexOf(detail);
    changeDetail(ARCHITECTURE_DETAIL_TIERS[Math.min(index + 1, ARCHITECTURE_DETAIL_TIERS.length - 1)]);
  };

  /** The analysis/seed source line ... */
  /**
   * The analysis/seed source line, bottom-left. Relative time on the surface,
   * the exact local instant in `title`. Extracted so the empty-reading state
   * shows it too (the provenance exists even when no seed resolved).
   */
  const sourceLine = (
    <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex flex-col items-start gap-1 text-[11px] text-muted-foreground">
      <span
        data-architecture-source-line="true"
        className="pointer-events-auto rounded-md border border-border/60 bg-background/90 px-2 py-1 shadow-sm"
      >
        {t('architecture.honesty.analysis', { defaultValue: 'Analysis' })}:{' '}
        {provenance.generatedAt ? (
          <time
            data-architecture-generated-at
            dateTime={provenance.generatedAt}
            title={formatAbsoluteTime(provenance.generatedAt)}
          >
            {formatRelativeTime(provenance.generatedAt)}
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
          className="pointer-events-auto max-h-40 overflow-y-auto rounded-md border border-border/60 bg-background/95 px-2 py-1 shadow-sm"
        >
          {unresolvedNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </div>

  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-architecture-panel="true">
      <div
        data-architecture-toolbar="true"
        // ONE row on every tier: no wrapping container is allowed here, so the
        // header can never grow into the two/three rows the review measured.
        className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border/60 px-3 py-1.5"
      >
        {compactToolbar ? (
          <>
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {t('architecture.title', { defaultValue: 'Architecture' })}
            </h3>
            {granularityGroup}
            {truncation.truncated && (
              <span
                data-architecture-truncated-badge="true"
                data-architecture-truncated-granularity={granularity}
                data-architecture-truncated-omitted={budgetOmitted}
                title={t('architecture.readout.budgetOmitted', {
                  defaultValue: '{{count}} more left out by the node budget',
                  count: budgetOmitted,
                })}
                className="whitespace-nowrap text-[11px] font-medium text-amber-600 dark:text-amber-400"
              >
                +{budgetOmitted} folded
              </span>
            )}
            <button
              type="button"
              aria-haspopup="true"
              aria-expanded={compactMenuOpen}
              aria-label={t('architecture.plantuml.moreActions', { defaultValue: 'More actions' })}
              onClick={() => setCompactMenuOpen((open) => !open)}
              data-architecture-overflow-toggle="true"
              style={compactTargetStyle}
              className="rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              ⋯
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
            {searchBox}
            <span className="flex-1" />
            {exportButton}
            {legendButton}
          </>
        )}
      </div>

      {compactToolbar && compactMenuOpen && (
        <div
          data-architecture-overflow-menu="true"
          className="absolute right-2 top-12 z-30 flex max-h-[70%] w-72 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg"
        >
          {scopeGroup}
          {detailGroup}
          {/* The renderer's own controls (view navigation, readable mode, drill,
              zoom, export) are portaled in here — they belong to the drawing,
              not to the panel, and the slot keeps them at this menu's target
              size rather than in a second toolbar row. */}
          <div
            ref={setCompactMenuHost}
            data-architecture-compact-graph-controls="true"
            className="flex flex-col gap-1 border-t border-border/60 pt-1"
          />
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {hasSeeds ? (
          <>
            {coarsePointer && !touchHintDismissed && (
              <div
                data-architecture-touch-hint="true"
                role="status"
                className="flex items-start gap-2 border-b border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground"
              >
                <span className="min-w-0 flex-1">
                  {t('architecture.plantuml.touchHint', {
                    defaultValue: 'Tap a node to select it; drag to pan and pinch to zoom. Double-tap or choose Drill in to open its neighbourhood.',
                  })}
                </span>
                <button
                  type="button"
                  aria-label={t('architecture.dismissHint', { defaultValue: 'Dismiss hint' })}
                  onClick={() => setTouchHintDismissed(true)}
                  style={compactTargetStyle}
                  className="rounded border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  ×
                </button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <CompactToolbarSlotContext.Provider value={compactMenuHost}>
                <Renderer
                  key={`${sessionId}:${granularity}:${scope}`}
                  graph={detailRanking?.graph ?? neighbourhood}
                  // The detail knob's two numbers, so a renderer that has a
                  // visible-summary slot can report shown/in-scope rather than
                  // its own drawn/total reading.
                  detailReading={detailReading}
                  // Which subgraph this is decides how ids are read (label and
                  // group prefixes). The renderer must not have to guess: see
                  // `nodeIdShapeOf`.
                  idShape={nodeIdShapeOf(granularity)}
                  onNodeHover={handleNodeHover}
                  // Selecting a node is the reader working the drawing; the
                  // one-off touch instruction has done its job by then.
                  onNodeClick={() => setTouchHintDismissed(true)}
                  onExport={exportFromMenu}
                  focusNodeId={focusTarget?.id ?? null}
                  focusToken={focusTarget?.token}
                />
              </CompactToolbarSlotContext.Provider>

              {/* The one-line reading, ON the drawing's top-left corner. It is
                  the only place the shown/in-scope numbers are stated. */}
              <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[85%] flex-col items-start gap-1">
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
                    <span data-architecture-readout-summary={retainedCount} data-architecture-readout-total={inScopeCount}>
                      {readoutSummary}
                    </span>
                    {foldedCount > 0 && (
                      <span data-architecture-folded-badge={foldedCount} className="text-foreground">
                        {t('architecture.readout.folded', { defaultValue: '+{{count}} folded', count: foldedCount })}
                      </span>
                    )}
                    {truncation.truncated && (
                      <span
                        data-architecture-truncated="true"
                        data-architecture-truncated-granularity={granularity}
                        data-architecture-truncated-shown={truncation.shown}
                        data-architecture-truncated-total={truncation.total}
                        data-architecture-truncated-omitted={budgetOmitted}
                        className="text-amber-600 dark:text-amber-400"
                      >
                        {t('architecture.readout.budgetOmitted', {
                          defaultValue: '{{count}} more left out by the node budget',
                          count: budgetOmitted,
                        })}
                      </span>
                    )}
                    <span aria-hidden="true">{readoutOpen ? '▾' : '▸'}</span>
                  </button>
                  {readoutOpen && (
                    <div data-architecture-readout-detail="true" className="mt-1 flex flex-col gap-1">
                      <p>
                        {t('architecture.readout.explanation', {
                          defaultValue:
                            '{{shown}} is what the current detail level keeps; {{total}} is every related entity in the current scope.',
                          shown: retainedCount,
                          total: inScopeCount,
                        })}
                      </p>
                      {kindLine !== null && kindLine.length > 0 && (
                        <p data-architecture-kind-counts="true">{kindLine}</p>
                      )}
                      <span className="flex gap-2">
                        <button
                          type="button"
                          onClick={raiseDetail}
                          data-architecture-raise-detail="true"
                          className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                        >
                          {t('architecture.readout.raiseDetail', { defaultValue: 'Raise detail' })}
                        </button>
                        <button
                          type="button"
                          onClick={() => changeScope(scope - 1)}
                          data-architecture-reduce-scope="true"
                          disabled={scope <= ARCHITECTURE_SCOPE_MIN}
                          className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('architecture.readout.reduceScope', { defaultValue: 'Reduce scope' })}
                        </button>
                      </span>
                    </div>
                  )}
                </div>
                {/* The hover relation reading replaces the two duplicated
                    standing instructions: it only exists while a node is under
                    the pointer, so the page has no permanent hint sentence. */}
                {visibleHover !== null && (
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
                )}
              </div>

              {sourceLine}
            </div>
          </>
        ) : (
          <>
            <ArchitectureEmptyState
              message={t('architecture.noSeeds', {
                defaultValue: 'This session has not referenced any file or identifier that the analysis can place.',
              })}
            />
            {sourceLine}
          </>
        )}

        {legendOpen && legend}
      </div>
    </div>
  );
}
