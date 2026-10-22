import { useCallback, useMemo, useState } from 'react';
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
  ArchitectureGraphRenderer,
  ArchitectureNodeIdShape,
  ArchitectureRendererHover,
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
  renderer?: ArchitectureGraphRenderer;
};

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

/**
 * The honesty bar (ADR-005 decision 7): the analysis time, how many seeds could
 * not be placed in the ArchGuard index, and whether the CURRENT granularity was
 * cut by its node budget. The notice is deliberately per-granularity: the file
 * graph has its own budget, so an entity cut must not claim the file view is
 * truncated. It carries the shown/total counts so the reader can see what was
 * cut, and suggests lowering the hops when the depth is the cause.
 */
function ArchitectureHonestyBar({
  result,
  granularity,
  hops,
  compact = false,
}: {
  result: ArchitectureGraphResult;
  granularity: ArchitectureGranularity;
  hops: number;
  /**
   * The compact tier draws this bar inside the overflow menu instead of under
   * the toolbar, so it stacks in a narrow column and drops the full-width rule.
   * The truncation badge in the toolbar row is what keeps a real cut visible
   * while the menu is shut.
   */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { stats, provenance } = result;
  const unresolvedCount = stats.unresolved.files.length + stats.unresolved.identifiers.length;
  const cut = truncationReading(result, granularity);

  return (
    <div
      data-architecture-honesty="true"
      className={
        compact
          ? 'flex flex-col items-start gap-1 text-[11px] text-muted-foreground'
          : 'flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground'
      }
    >
      <span>
        {t('architecture.honesty.analysis', { defaultValue: 'Analysis' })}:{' '}
        {provenance.generatedAt ? (
          <time data-architecture-generated-at dateTime={provenance.generatedAt}>
            {provenance.generatedAt}
          </time>
        ) : (
          <span data-architecture-generated-at>unknown</span>
        )}
      </span>
      <span data-architecture-unresolved={unresolvedCount}>
        {t('architecture.honesty.unresolved', {
          defaultValue: '{{count}} unresolved seed(s)',
          count: unresolvedCount,
        })}
      </span>
      {cut.truncated && (
        <span
          data-architecture-truncated
          data-architecture-truncated-granularity={granularity}
          data-architecture-truncated-shown={cut.shown}
          data-architecture-truncated-total={cut.total}
          className="text-amber-600 dark:text-amber-400"
        >
          {granularity === 'file'
            ? t('architecture.honesty.fileTruncated', {
                defaultValue: 'File graph truncated — showing {{shown}} of {{total}} files (node budget {{limit}}).',
                shown: cut.shown,
                total: cut.total,
                limit: cut.shown,
              })
            : t('architecture.honesty.entityTruncated', {
                defaultValue: 'Entity graph truncated — showing {{shown}} of {{total}} entities (node budget {{limit}}).',
                shown: cut.shown,
                total: cut.total,
                limit: cut.shown,
              })}
        </span>
      )}
      {cut.truncated && hops > 1 && (
        <span data-architecture-hops-advice className="text-amber-600 dark:text-amber-400">
          {t('architecture.honesty.lowerHops', {
            defaultValue: '{{hops}} hops exceed the node budget — lower the hops to see the whole neighbourhood.',
            hops,
          })}
        </span>
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

/**
 * The renderer-neutral hover readout. Every renderer reports the hovered node
 * and its visible relation kinds through `onNodeHover`, so this bar looks the
 * same whichever library draws the graph; `data-architecture-hover` is present
 * only while a node is under the pointer.
 */
function ArchitectureHoverBar({ hover }: { hover: ArchitectureRendererHover | null }) {
  const { t } = useTranslation();
  const relationsText = hover === null || hover.relations.length === 0
    ? t('architecture.hover.none', { defaultValue: 'no outgoing/incoming relation' })
    : hover.relations.join(', ');

  return (
    <div className="flex flex-wrap items-center border-b border-border/40 px-4 py-1 text-[11px] text-muted-foreground">
      <span
        data-architecture-hover={hover?.node.id}
        data-architecture-hover-relations={hover?.relations.join(',')}
      >
        {hover === null
          ? t('architecture.expandHint', {
              defaultValue: 'Hover a node for its relation types; click a node to expand its next hop.',
            })
          : t('architecture.hover.relations', {
              defaultValue: '{{node}} — relations: {{relations}}',
              node: hover.node.id,
              relations: relationsText,
            })}
      </span>
    </div>
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
 */
export default function ArchitecturePanel({
  projectId,
  sessionId,
  renderer: Renderer = PlantUmlGraph,
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
  // arrive in one response, so this must never re-enter the fetch.
  const [granularity, setGranularity] = useState<ArchitectureGranularity>('file');
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
  const { stats, mmd } = result;
  const hasSeeds = stats.seedFiles > 0 || stats.seedIdentifiers > 0;
  const neighbourhood = result.graph[granularity];
  // A reading from the previous graph is not shown against this one.
  const visibleHover = hovered !== null && hovered.key === hoverKey ? hovered.hover : null;

  const changeScope = (next: number): void => {
    const clamped = clampArchitectureScope(next);
    setDisplaySettings((current) => ({ ...current, scope: clamped }));
    writeStoredScope(projectId, clamped);
  };
  const changeDetail = (next: ArchitectureDetailTier): void => {
    setDisplaySettings((current) => ({ ...current, detail: next }));
    writeStoredDetail(projectId, next);
  };

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

  // Both subgraphs are in hand; toggling only picks one, so it must not refetch.
  const granularityGroup = (
    <div
      role="group"
      aria-label={t('architecture.granularity', { defaultValue: 'Graph granularity' })}
      className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5"
    >
      <button
        type="button"
        aria-pressed={granularity === 'file'}
        onClick={() => setGranularity('file')}
        style={compactTargetStyle}
        className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          granularity === 'file' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('architecture.fileGraph', { defaultValue: 'File graph' })}
      </button>
      <button
        type="button"
        aria-pressed={granularity === 'entity'}
        onClick={() => setGranularity('entity')}
        style={compactTargetStyle}
        className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
          granularity === 'entity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('architecture.entityGraph', { defaultValue: 'Entity graph' })}
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
      {t('architecture.exportMmd', { defaultValue: 'Export .mmd' })}
    </button>
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-architecture-panel="true">
      {compactToolbar ? (
        // ONE row. A phone has no room for a header row plus a diagram toolbar
        // row: the title, the granularity switch and the "…" toggle are all the
        // chrome that stays; scope, detail, the honesty readings, export and every zoom
        // action live in the menu below. A real truncation still surfaces as a
        // compact badge here, so a cut is never hidden behind a closed menu.
        <div
          data-architecture-toolbar="true"
          className="flex items-center gap-2 border-b border-border/60 px-2 py-1"
        >
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {t('architecture.title', { defaultValue: 'Architecture' })}
          </h3>
          {granularityGroup}
          {truncation.truncated && (
            <span
              data-architecture-truncated-badge="true"
              data-architecture-truncated-granularity={granularity}
              data-architecture-truncated-shown={truncation.shown}
              data-architecture-truncated-total={truncation.total}
              title={t('architecture.honesty.truncated', {
                defaultValue: 'Node budget reached — this graph is truncated.',
              })}
              className="whitespace-nowrap text-[11px] font-medium text-amber-600 dark:text-amber-400"
            >
              ⚠ {truncation.shown}/{truncation.total}
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
        </div>
      ) : (
        <>
          <div
            data-architecture-toolbar="true"
            className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2"
          >
            <h3 className="text-sm font-semibold text-foreground">
              {t('architecture.title', { defaultValue: 'Architecture' })}
            </h3>
            {granularityGroup}
            {scopeGroup}
            {detailGroup}
            {/* On the compact tier the export action lives in the overflow menu
                instead (a second tiny button here would defeat the touch target
                work). */}
            {exportButton}
          </div>

          <ArchitectureHonestyBar result={result} granularity={granularity} hops={scope} />
        </>
      )}

      {compactToolbar && compactMenuOpen && (
        <div
          data-architecture-overflow-menu="true"
          className="absolute right-2 top-12 z-30 flex max-h-[70%] w-72 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg"
        >
          <ArchitectureHonestyBar result={result} granularity={granularity} hops={scope} compact />
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

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasSeeds ? (
          <>
            {/* A coarse pointer cannot hover, so the hover readout is not
                rendered at all on that tier — the touch instruction below is
                the only input guidance. It is a normal-flow row ABOVE the
                drawing, not an overlay: an absolutely placed hint covered the
                top row of nodes on a phone, which is the content the reader
                opened the tab for. It still costs only its own height and the
                drawing keeps `flex-1` of the rest. */}
            {!coarsePointer && <ArchitectureHoverBar hover={visibleHover} />}
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
                  // The detail knob's two numbers, so the renderer's
                  // visible-summary slot reports shown/in-scope rather than its
                  // own drawn/total reading.
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
                />
              </CompactToolbarSlotContext.Provider>
            </div>
          </>
        ) : (
          <ArchitectureEmptyState
            message={t('architecture.noSeeds', {
              defaultValue: 'This session has not referenced any file or identifier that the analysis can place.',
            })}
          />
        )}
      </div>
    </div>
  );
}
