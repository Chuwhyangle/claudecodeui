import { useTranslation } from 'react-i18next';

import type { QuayDriverState, QuayFocusableObject, QuayObjectUri } from '@/shared/types';
import { cn } from '@/shared/utils';
import { QuayPanel, parseQuayUri } from '@/modules/quay';
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

/**
 * A driver badge is only drawn when the driver is NOT running.
 *
 * An always-present "DRIVER RUNNING" badge is identical on every tile, so it occupies the most
 * prominent position in every tile to say nothing. A badge that appears only when the driver is
 * stopped, stale or unreadable is information: it is the one tile where something needs attention.
 */
const DRIVER_IS_NORMAL = (state: QuayDriverState): boolean => state === 'running';

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
        // 「需要人」 is the one coloured element in the fleet view: the only state that asks the
        // person to act must be visible at a glance without reading the counts line. The marker is
        // a data attribute as well as a border so the emphasis is addressable without CSS.
        const needsHuman = project.tasks.needsHuman > 0;

        return (
          <li
            key={project.projectId}
            role="button"
            tabIndex={-1}
            onClick={() => onFocusObject(focusable.uri)}
            className={cn(
              'cursor-pointer rounded-lg border bg-card p-3 text-left transition-shadow focus:outline-none',
              needsHuman
                ? 'border-amber-500 ring-1 ring-amber-500/40 dark:border-amber-400 dark:ring-amber-400/40'
                : 'border-border/50',
              isFocused && 'ring-2 ring-primary',
            )}
            data-testid="cockpit-fleet-tile"
            data-quay-uri={focusable.uri}
            data-quay-label={focusable.label}
            data-quay-display={JSON.stringify(focusable.display)}
            data-needs-human={needsHuman ? 'true' : undefined}
            data-focused={isFocused ? 'true' : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                {/* The ordinal is the spoken handle AND the place a pointer lands: it is drawn at
                    body size in the foreground colour, never as dim decorative small print. */}
                <span
                  className="shrink-0 text-sm font-semibold tabular-nums text-foreground"
                  data-testid="cockpit-fleet-tile-label"
                >
                  {focusable.label}
                </span>
                <span
                  className="truncate text-sm font-medium text-foreground"
                  title={project.projectPath}
                  data-testid="cockpit-fleet-tile-name"
                >
                  {project.name}
                </span>
              </span>
              {!DRIVER_IS_NORMAL(project.driverState) && (
                <span
                  className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                  data-testid="cockpit-fleet-tile-driver"
                  data-driver-state={project.driverState}
                >
                  {t(DRIVER_LABEL_KEYS[project.driverState])}
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground" data-testid="cockpit-fleet-tile-counts">
              {t('cockpit.tasksCount', { total: project.tasks.total })}
              {' · '}
              {t('cockpit.readyCount', { n: project.tasks.ready })}
              {' · '}
              <span
                className={cn(needsHuman && 'font-semibold text-amber-700 dark:text-amber-300')}
                data-testid="cockpit-fleet-tile-needs-human"
              >
                {t('cockpit.needsHumanCount', { n: project.tasks.needsHuman })}
              </span>
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

  // The task's human-readable title, when the snapshot's recent-tasks reading carries one. The
  // rail's title is the task id; the subtitle is this. A missing entry (the task is older than the
  // ten most recently updated) leaves the subtitle out rather than inventing one.
  const taskTitles = new Map<string, string>();
  if (boardView.status === 'loaded') {
    for (const task of boardView.snapshot.tasks?.recent ?? []) {
      taskTitles.set(task.id, task.title);
    }
  }

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
              // An in-flight tile is named the way a person names it: the task id as the title,
              // its title as the subtitle. The raw `quay://` address belongs to the status bar,
              // which is where the focus reading lives — it is not a headline and cannot be spoken.
              const parsed = parseQuayUri(focusable.uri);
              const taskId =
                parsed.ok && parsed.object.type === 'task' ? parsed.object.id : focusable.display.status;
              const taskTitle = parsed.ok && parsed.object.type === 'task'
                ? taskTitles.get(parsed.object.id)
                : undefined;

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
                    <span
                      className="shrink-0 text-sm font-semibold tabular-nums text-foreground"
                      data-testid="cockpit-board-object-label"
                    >
                      {focusable.label}
                    </span>
                    <span className="flex min-w-0 flex-col text-left">
                      <span
                        className="truncate text-xs font-semibold text-foreground"
                        title={taskId}
                        data-testid="cockpit-board-object-title"
                      >
                        {taskId}
                      </span>
                      {taskTitle !== undefined && (
                        <span
                          className="truncate text-[11px] text-muted-foreground"
                          data-testid="cockpit-board-object-subtitle"
                        >
                          {taskTitle}
                        </span>
                      )}
                    </span>
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
