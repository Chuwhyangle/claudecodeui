import { useTranslation } from 'react-i18next';

import type { QuayDriverState, QuayFocusableObject, QuayObjectUri } from '@/shared/types';
import { cn } from '@/shared/utils';
import { QuayPanel } from '@/modules/quay';
import type { QuayPanelView } from '@/modules/quay';
import type { CockpitProject, CockpitView } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit stage: one view at a time, with the view's focusable children declared exactly
 * as the wall contract requires (`{uri, label, display}`), plus the project strip's reading.
 *
 * The stage is presentational. Focus and key handling live in `CockpitPage`; this file draws
 * what that state says, so one contract (the `focusables` array) is the single source for
 * what can be focused, what the status bar names, and what a direction key moves between.
 */

/** The i18n key for each driver reading; the badge text and the accessibility label share it. */
const DRIVER_LABEL_KEYS: Record<QuayDriverState, string> = {
  running: 'cockpit.driverRunning',
  idle: 'cockpit.driverIdle',
  stale: 'cockpit.driverStale',
  'not-configured': 'cockpit.driverNotConfigured',
  unavailable: 'cockpit.driverUnavailable',
};

export type CockpitFleetStatus = 'loading' | 'loaded' | 'error';

export type CockpitStageProps = {
  view: CockpitView;
  projects: readonly CockpitProject[];
  fleetStatus: CockpitFleetStatus;
  fleetError: string | null;
  /** The current view's declared focusable children, in spatial order. */
  focusables: readonly QuayFocusableObject[];
  focusUri: QuayObjectUri | null;
  /** Moves focus to a clicked tile; the tile itself owns no navigation. */
  onFocusObject: (uri: string) => void;
  /** The board view's own reading and re-read seam, handed straight to `QuayPanel`. */
  boardProjectId: string | null;
  boardView: QuayPanelView;
  onRefreshBoard: () => void;
};

/** Rendered by `CockpitPage` as the right-hand stage. */
export default function CockpitStage({
  view,
  projects,
  fleetStatus,
  fleetError,
  focusables,
  focusUri,
  onFocusObject,
  boardProjectId,
  boardView,
  onRefreshBoard,
}: CockpitStageProps) {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid="cockpit-stage"
      data-cockpit-view={view.type}
    >
      {view.type === 'fleet' ? (
        <FleetView
          projects={projects}
          fleetStatus={fleetStatus}
          fleetError={fleetError}
          focusables={focusables}
          focusUri={focusUri}
          onFocusObject={onFocusObject}
        />
      ) : (
        <BoardView
          focusables={focusables}
          focusUri={focusUri}
          onFocusObject={onFocusObject}
          boardProjectId={boardProjectId}
          boardView={boardView}
          onRefreshBoard={onRefreshBoard}
        />
      )}
    </section>
  );
}

/** The fleet view: every quay project as one tile, in the order the contract declares them. */
function FleetView({
  projects,
  fleetStatus,
  fleetError,
  focusables,
  focusUri,
  onFocusObject,
}: {
  projects: readonly CockpitProject[];
  fleetStatus: CockpitFleetStatus;
  fleetError: string | null;
  focusables: readonly QuayFocusableObject[];
  focusUri: QuayObjectUri | null;
  onFocusObject: (uri: string) => void;
}) {
  const { t } = useTranslation();

  if (fleetStatus === 'loading') {
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="cockpit-fleet-loading">
        {t('cockpit.loading')}
      </p>
    );
  }

  if (fleetStatus === 'error') {
    return (
      <p className="p-6 text-sm text-amber-700 dark:text-amber-300" data-testid="cockpit-fleet-error">
        {t('cockpit.projectsError', { message: fleetError ?? '' })}
      </p>
    );
  }

  if (projects.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="cockpit-fleet-empty">
        {t('cockpit.emptyProjects')}
      </p>
    );
  }

  return (
    <ul
      className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3"
      data-testid="cockpit-fleet-tiles"
      // The view contract itself, published once so a test (or the future semantic surface)
      // reads the same declaration the renderer drew.
      data-cockpit-focusables={JSON.stringify(focusables)}
    >
      {projects.map((project, index) => {
        const focusable = focusables[index];
        if (focusable === undefined) {
          return null;
        }
        const isFocused = focusable.uri === focusUri;

        return (
          <li
            key={project.projectId}
            role="button"
            tabIndex={-1}
            onClick={() => onFocusObject(focusable.uri)}
            className={cn(
              'cursor-pointer rounded-lg border border-border/50 bg-card p-3 text-left transition-shadow focus:outline-none',
              isFocused && 'ring-2 ring-primary',
            )}
            data-testid="cockpit-fleet-tile"
            data-quay-uri={focusable.uri}
            data-quay-label={focusable.label}
            data-quay-display={JSON.stringify(focusable.display)}
            data-focused={isFocused ? 'true' : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[11px] text-muted-foreground" data-testid="cockpit-fleet-tile-label">
                  {focusable.label}
                </span>
                <span className="truncate text-sm font-semibold text-foreground" title={project.projectPath}>
                  {project.name}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {t(DRIVER_LABEL_KEYS[project.driverState])}
              </span>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="cockpit-fleet-tile-counts">
              {t('cockpit.tasksCount', { total: project.tasks.total })}
              {' · '}
              {t('cockpit.readyCount', { n: project.tasks.ready })}
              {' · '}
              {t('cockpit.needsHumanCount', { n: project.tasks.needsHuman })}
            </p>
            {project.error !== null && (
              <p className="mt-1 truncate text-[11px] text-amber-700 dark:text-amber-300" data-testid="cockpit-fleet-tile-error">
                {project.error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The board view: the project's in-flight objects as a focus rail, then quay's own panel. */
function BoardView({
  focusables,
  focusUri,
  onFocusObject,
  boardProjectId,
  boardView,
  onRefreshBoard,
}: {
  focusables: readonly QuayFocusableObject[];
  focusUri: QuayObjectUri | null;
  onFocusObject: (uri: string) => void;
  boardProjectId: string | null;
  boardView: QuayPanelView;
  onRefreshBoard: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cockpit-board">
      <div className="border-b border-border/40 p-3" data-cockpit-focusables={JSON.stringify(focusables)}>
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          {t('cockpit.inFlight')}
        </p>
        {focusables.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="cockpit-board-rail-empty">
            {t('cockpit.inFlightEmpty')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="cockpit-board-rail">
            {focusables.map((focusable) => {
              const isFocused = focusable.uri === focusUri;
              return (
                <li key={focusable.uri}>
                  <button
                    type="button"
                    onClick={() => onFocusObject(focusable.uri)}
                    className={cn(
                      'flex max-w-full items-center gap-1.5 rounded border border-border/50 px-2 py-1 text-xs text-foreground',
                      isFocused && 'ring-2 ring-primary',
                    )}
                    data-testid="cockpit-board-object"
                    data-quay-uri={focusable.uri}
                    data-quay-label={focusable.label}
                    data-quay-display={JSON.stringify(focusable.display)}
                    data-focused={isFocused ? 'true' : undefined}
                  >
                    <span className="text-[11px] text-muted-foreground">{focusable.label}</span>
                    <span className="max-w-md truncate font-mono text-[11px]">{focusable.uri}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {focusable.display.status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {boardProjectId !== null && (
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="cockpit-board-panel">
          {/* QuayPanel owns the snapshot's four states — including its error branch with the
              retry button — so a failed read shows an error surface, never a blank stage. */}
          <QuayPanel projectId={boardProjectId} view={boardView} onRefresh={onRefreshBoard} />
        </div>
      )}
    </div>
  );
}
