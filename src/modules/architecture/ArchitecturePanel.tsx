import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PlantUmlGraph } from '@/modules/architecture/PlantUmlGraph';
import { useTouchLayout } from '@/modules/architecture/hooks/useTouchLayout';
import type {
  ArchitectureGraphRenderer,
  ArchitectureRendererHover,
} from '@/modules/architecture/rendererContract';
import { useArchitectureGraph, type ArchitectureGraphResult } from '@/modules/architecture/useArchitectureGraph';

/** The two subgraphs the endpoint returns together; switching between them is local. */
type ArchitectureGranularity = 'file' | 'entity';

/**
 * The server-side BFS depth the panel asks for on first activation. Two hops is
 * the server's loose default (`DEFAULT_HOPS` in `architecture/service.ts`); the
 * knob below is a REQUEST parameter, so unlike the granularity toggle it
 * re-enters the fetch.
 */
const DEFAULT_HOPS = 2;

/** The depths the hops knob offers. Kept small: three hops explodes most neighbourhoods. */
const HOP_OPTIONS = [1, 2, 3] as const;

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
}: {
  result: ArchitectureGraphResult;
  granularity: ArchitectureGranularity;
  hops: number;
}) {
  const { t } = useTranslation();
  const { stats, provenance } = result;
  const unresolvedCount = stats.unresolved.files.length + stats.unresolved.identifiers.length;
  const cut = truncationReading(result, granularity);

  return (
    <div
      data-architecture-honesty="true"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground"
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
 * the same payload, so it must never re-enter the fetch. The hops knob is the
 * opposite: it is a server-side generation parameter (and part of the result
 * cache's content key), so changing it re-requests the neighbourhood. The
 * Mermaid documents stay in hand for the `.mmd` export.
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
    ? 'min-h-11 min-w-11 rounded-md px-3 text-sm font-medium'
    : 'rounded-md px-2 py-0.5 text-xs font-medium';
  // Which of the two server subgraphs is on screen. Purely local state: both
  // arrive in one response, so this must never re-enter the fetch.
  const [granularity, setGranularity] = useState<ArchitectureGranularity>('file');
  // The requested BFS depth. This one IS a request parameter: it changes the
  // server's neighbourhood and its cache key, so `useArchitectureGraph` refetches.
  const [hops, setHops] = useState<number>(DEFAULT_HOPS);
  // The node under the pointer and its visible relation kinds, as reported by
  // the mounted renderer. Kept here so the readout is renderer-neutral; the key
  // names the graph the reading came from (session + granularity + depth), so
  // changing any of them discards the reading during render instead of via a
  // reset effect.
  const [hovered, setHovered] = useState<{ key: string; hover: ArchitectureRendererHover | null } | null>(null);
  const hoverKey = `${sessionId ?? ''}:${granularity}:${hops}`;
  // Stable while the same graph is on screen, so hovering never tears down the
  // renderer's effect; it only changes when the graph itself changes.
  const handleNodeHover = useCallback(
    (hover: ArchitectureRendererHover | null) => setHovered({ key: hoverKey, hover }),
    [hoverKey],
  );
  const { view, reload } = useArchitectureGraph(projectId, sessionId, hops);

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

  return (
    <div className="flex h-full flex-col overflow-hidden" data-architecture-panel="true">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2">
        <h3 className="text-sm font-semibold text-foreground">
          {t('architecture.title', { defaultValue: 'Architecture' })}
        </h3>
        {/* Both subgraphs are in hand; toggling only picks one, so it must not refetch. */}
        <div
          role="group"
          aria-label={t('architecture.granularity', { defaultValue: 'Graph granularity' })}
          className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5"
        >
          <button
            type="button"
            aria-pressed={granularity === 'file'}
            onClick={() => setGranularity('file')}
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
            className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              granularity === 'entity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('architecture.entityGraph', { defaultValue: 'Entity graph' })}
          </button>
        </div>
        {/* The depth is a server-side generation parameter, so this control
            re-enters the fetch (unlike the granularity toggle above). */}
        <div
          role="group"
          aria-label={t('architecture.controls.maxHops', { defaultValue: 'Hops' })}
          data-architecture-hops-control="true"
          className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5"
        >
          {HOP_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={hops === option}
              data-architecture-hops-option={option}
              onClick={() => setHops(option)}
              className={`${headerButtonClass} outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                hops === option ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        {/* On a narrow screen the export action lives in the graph's overflow
            menu instead (a second tiny button here would defeat the touch
            target work). */}
        {!compactToolbar && (
          <button
            type="button"
            onClick={() => downloadMermaid(
              granularity === 'file' ? mmd.file : mmd.entity,
              `architecture-${granularity}.mmd`,
            )}
            data-architecture-export="true"
            className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
              coarsePointer ? 'min-h-11 min-w-11 px-3 text-sm' : 'px-2 py-0.5 text-xs'
            }`}
          >
            {t('architecture.exportMmd', { defaultValue: 'Export .mmd' })}
          </button>
        )}
      </div>

      <ArchitectureHonestyBar result={result} granularity={granularity} hops={hops} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {hasSeeds ? (
          <>
            <ArchitectureHoverBar hover={visibleHover} />
            <div className="min-h-0 flex-1">
              <Renderer
                key={`${sessionId}:${granularity}:${hops}`}
                graph={neighbourhood}
                onNodeHover={handleNodeHover}
                onExport={() => downloadMermaid(
                  granularity === 'file' ? mmd.file : mmd.entity,
                  `architecture-${granularity}.mmd`,
                )}
              />
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
