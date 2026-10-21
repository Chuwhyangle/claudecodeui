import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PlantUmlGraph } from '@/modules/architecture/PlantUmlGraph';
import { useArchitectureGraph, type ArchitectureGraphResult } from '@/modules/architecture/useArchitectureGraph';

/** The two subgraphs the endpoint returns together; switching between them is local. */
type ArchitectureGranularity = 'file' | 'entity';

type ArchitecturePanelProps = {
  /** The selected project's DB id; the endpoint resolves it to a project root. */
  projectId: string | null;
  /** The selected session whose transcript supplies the graph's seeds. */
  sessionId: string | null;
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
 * not be placed in the ArchGuard index, and whether the server's loose node
 * budget cut the neighbourhood short. Rendered from the response alone, so it
 * can never claim a fresher reading than the one the graph came from.
 */
function ArchitectureHonestyBar({ result }: { result: ArchitectureGraphResult }) {
  const { t } = useTranslation();
  const { stats, provenance } = result;
  const unresolvedCount = stats.unresolved.files.length + stats.unresolved.identifiers.length;

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
      {stats.truncated && (
        <span data-architecture-truncated className="text-amber-600 dark:text-amber-400">
          {t('architecture.honesty.truncated', {
            defaultValue: 'Node budget reached — this graph is truncated.',
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
 * Rendered by WorkspaceMain when the architecture tab is active. It requests the
 * session's neighbourhood on mount (the tab activation) and draws it as a
 * PlantUML/ELK layered diagram; the file/entity switch only picks one of the two
 * subgraphs that already arrived in the same payload, so it must never re-enter
 * the fetch. The Mermaid documents stay in hand for the `.mmd` export.
 */
export default function ArchitecturePanel({ projectId, sessionId }: ArchitecturePanelProps) {
  const { t } = useTranslation();
  // Which of the two server subgraphs is on screen. Purely local state: both
  // arrive in one response, so this must never re-enter the fetch.
  const [granularity, setGranularity] = useState<ArchitectureGranularity>('file');
  const { view, reload } = useArchitectureGraph(projectId, sessionId);

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
            className={`rounded-md px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              granularity === 'file' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('architecture.fileGraph', { defaultValue: 'File graph' })}
          </button>
          <button
            type="button"
            aria-pressed={granularity === 'entity'}
            onClick={() => setGranularity('entity')}
            className={`rounded-md px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              granularity === 'entity' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('architecture.entityGraph', { defaultValue: 'Entity graph' })}
          </button>
        </div>
        <button
          type="button"
          onClick={() => downloadMermaid(
            granularity === 'file' ? mmd.file : mmd.entity,
            `architecture-${granularity}.mmd`,
          )}
          data-architecture-export="true"
          className="rounded-lg border border-border px-2 py-0.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.exportMmd', { defaultValue: 'Export .mmd' })}
        </button>
      </div>

      <ArchitectureHonestyBar result={result} />

      <div className="min-h-0 flex-1 overflow-hidden">
        {hasSeeds ? (
          <PlantUmlGraph key={`${sessionId}:${granularity}`} graph={neighbourhood} />
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
