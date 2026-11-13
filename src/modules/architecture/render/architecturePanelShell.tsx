/**
 * The panel SHELL: the branch screens (no session / loading / error) and the full
 * ready tree that arranges the toolbar, the readout, the canvas region, the dock
 * and the dialogs.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * It is the only module that knows the arrangement; every fragment it renders is
 * built by a sibling module from the same panel model, so the panel itself keeps
 * only the owner wiring.
 */










import { ArchitectureEmptyState } from '@/modules/architecture/render/ArchitectureEmptyState';
import { ArchitecturePanelReadyView } from '@/modules/architecture/render/architecturePanelReadyView';
import type { ArchitecturePanelModel } from '@/modules/architecture/render/ArchitecturePanel';

/** The panel root: the branch screens, then the ready tree. */
export function ArchitecturePanelShell({ model }: { readonly model: ArchitecturePanelModel }) {
  if (model.branch === 'no-session') {
    const { t } = model;
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

  if (model.branch === 'loading') {
    const { t, standalone, fillsViewport, standaloneBackButton } = model;
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

  if (model.branch === 'error') {
    const { t, standalone, fillsViewport, standaloneBackButton, message, reload } = model;
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
        {message}
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

  return <ArchitecturePanelReadyView model={model} />;
}
