import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { QuayDriverState, QuayFocusableObject, QuayObjectUri } from '@/shared/types';
import { cn } from '@/shared/utils';
import { QuayPanel, PulseStrip, formatQuayUri, parseQuayUri } from '@/modules/quay';
import type { QuayPanelView } from '@/modules/quay';
import type { CockpitProject, CockpitView } from '@/modules/cockpit/cockpitView';
import type {
  ObservationWallEntry,
  ObservationWallView,
} from '@/modules/cockpit/hooks/useObservationWall';
import ObservationPreview from '@/modules/cockpit/ObservationPreview';
import ObservationWall from '@/modules/cockpit/ObservationWall';

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
  /**
   * Whether the server could ask `quay-fleet` at all. `false` means every project's missing
   * registry id has ONE cause (no CLI on this host), so the stage states that once above the
   * tiles instead of repeating 「未登记」 on each of them.
   */
  fleetAvailable: boolean;
  /** The server's stated reason the fleet CLI could not be asked; shown beside the notice. */
  fleetReason: string | null;
  /** The current view's declared focusable children, in spatial order. */
  focusables: readonly QuayFocusableObject[];
  focusUri: QuayObjectUri | null;
  /** Moves focus to a clicked tile; the tile itself owns no navigation. */
  onFocusObject: (uri: string) => void;
  /** The board view's own reading and re-read seam, handed straight to `QuayPanel`. */
  boardProjectId: string | null;
  boardView: QuayPanelView;
  onRefreshBoard: () => void;
  /**
   * The observation wall's reading and its interactions. The stage draws it; the page owns the
   * preview's seen-cursor write, the pin write and the navigation, because those are requests,
   * not layout.
   */
  wallView: ObservationWallView;
  wallFocusUri: string | null;
  wallNow: number;
  wallPreview: ObservationWallEntry | null;
  wallPinPendingUri: string | null;
  wallArchitectureReason: string | null;
  onWallFocus: (uri: string) => void;
  onWallOpen: (uri: string) => void;
  onWallLater: () => void;
  onWallTogglePin: (uri: string) => void;
  onWallOpenSession: () => void;
  onWallOpenArchitecture: () => void;
  onReloadWall: () => void;
};

/** Rendered by `CockpitPage` as the right-hand stage. */
export default function CockpitStage({
  view,
  projects,
  fleetStatus,
  fleetError,
  fleetAvailable,
  fleetReason,
  focusables,
  focusUri,
  onFocusObject,
  boardProjectId,
  boardView,
  onRefreshBoard,
  wallView,
  wallFocusUri,
  wallNow,
  wallPreview,
  wallPinPendingUri,
  wallArchitectureReason,
  onWallFocus,
  onWallOpen,
  onWallLater,
  onWallTogglePin,
  onWallOpenSession,
  onWallOpenArchitecture,
  onReloadWall,
}: CockpitStageProps) {
  // FOCUS STARTS ON THE STAGE, NOT IN THE TEXT BOX. A page that loads with the intent input
  // focused swallows the first arrow press (editable targets own their keys by design), so the
  // stage takes focus on mount. `/` or a pointer is how a person enters the box.
  const stageRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    stageRef.current?.focus();
  }, []);

  return (
    <section
      ref={stageRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col focus:outline-none"
      data-testid="cockpit-stage"
      data-cockpit-view={view.type}
    >
      {view.type === 'wall' ? (
        <WallView
          wallView={wallView}
          focusables={focusables}
          focusUri={wallFocusUri}
          now={wallNow}
          preview={wallPreview}
          pinPendingUri={wallPinPendingUri}
          architectureReason={wallArchitectureReason}
          onFocus={onWallFocus}
          onOpen={onWallOpen}
          onLater={onWallLater}
          onTogglePin={onWallTogglePin}
          onOpenSession={onWallOpenSession}
          onOpenArchitecture={onWallOpenArchitecture}
          onReload={onReloadWall}
        />
      ) : view.type === 'fleet' ? (
        <FleetView
          projects={projects}
          fleetStatus={fleetStatus}
          fleetError={fleetError}
          fleetAvailable={fleetAvailable}
          fleetReason={fleetReason}
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

/**
 * The wall view: the observation list, with the preview stage beside it on a wide screen and
 * IN PLACE of it on a phone.
 *
 * The PC layout is the product's model (tiles + right-hand stage). The phone cannot show two
 * columns, so the preview takes the whole stage and 「稍后再看」 returns to the list — the same
 * model, one viewport. The list itself stays mounted on a wide screen, so a preview never
 * destroys its scroll position.
 */
function WallView({
  wallView,
  focusables,
  focusUri,
  now,
  preview,
  pinPendingUri,
  architectureReason,
  onFocus,
  onOpen,
  onLater,
  onTogglePin,
  onOpenSession,
  onOpenArchitecture,
  onReload,
}: {
  wallView: ObservationWallView;
  /** The wall's declared objects, published so the scenario surface can read them. */
  focusables: readonly QuayFocusableObject[];
  focusUri: string | null;
  now: number;
  preview: ObservationWallEntry | null;
  pinPendingUri: string | null;
  architectureReason: string | null;
  onFocus: (uri: string) => void;
  onOpen: (uri: string) => void;
  onLater: () => void;
  onTogglePin: (uri: string) => void;
  onOpenSession: () => void;
  onOpenArchitecture: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex min-h-0 flex-1"
      data-testid="cockpit-wall"
      // The same declaration the fleet/board views publish: what is focusable on this stage.
      // The dev-only scenario surface reads it, so a wall scenario can name ① / ② rather than
      // scraping a class name.
      data-cockpit-focusables={JSON.stringify(focusables)}
    >
      <div className={cn('flex min-w-0 flex-1 flex-col', preview !== null && 'hidden md:flex')}>
        {wallView.status === 'loading' && (
          <p className="p-6 text-xs text-muted-foreground" data-testid="observation-wall-loading">
            {t('cockpit.loading')}
          </p>
        )}
        {wallView.status === 'error' && (
          <div className="p-6" data-testid="observation-wall-error">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('cockpit.observationError', { message: wallView.message })}
            </p>
            <button
              type="button"
              onClick={onReload}
              className="mt-2 min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent sm:min-h-0 sm:py-0.5"
              data-testid="observation-wall-retry"
            >
              {t('cockpit.retry')}
            </button>
          </div>
        )}
        {wallView.status === 'loaded' && (
          <ObservationWall
            wall={wallView.wall}
            focusUri={focusUri}
            now={now}
            onFocus={onFocus}
            onOpen={onOpen}
            onTogglePin={onTogglePin}
            pinPendingUri={pinPendingUri}
          />
        )}
      </div>

      {preview !== null && (
        <div className="flex min-h-0 w-full md:w-96 md:shrink-0">
          <ObservationPreview
            entry={preview}
            now={now}
            onLater={onLater}
            onTogglePin={() => onTogglePin(preview.object.uri)}
            pinPending={pinPendingUri === preview.object.uri}
            onOpenSession={preview.object.kind === 'session' ? onOpenSession : undefined}
            onOpenArchitecture={preview.object.kind === 'architecture' ? onOpenArchitecture : undefined}
            architectureUnavailableReason={
              preview.object.kind === 'architecture' ? architectureReason : null
            }
          />
        </div>
      )}
    </div>
  );
}

/** The fleet view: every quay project as one tile, in the order the contract declares them. */
function FleetView({
  projects,
  fleetStatus,
  fleetError,
  fleetAvailable,
  fleetReason,
  focusables,
  focusUri,
  onFocusObject,
}: {
  projects: readonly CockpitProject[];
  fleetStatus: CockpitFleetStatus;
  fleetError: string | null;
  fleetAvailable: boolean;
  fleetReason: string | null;
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

  // "No projects" and "no fleet CLI" are different readings. With the CLI missing, "No quay
  // projects reported" would be a lie: the projects are there, their fleet identities are not.
  if (projects.length === 0 && fleetAvailable) {
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="cockpit-fleet-empty">
        {t('cockpit.emptyProjects')}
      </p>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      // The fleet stage is the phone's own scrolling region: the dock is in normal flow beneath
      // it, so a tile list taller than the viewport must scroll HERE rather than under the dock.
      // The narrow-layout criterion reads this element for 「the last tile scrolls fully into
      // view above the dock」.
      data-testid="cockpit-fleet-scroll"
    >
      {/*
        ONE line for the one cause. Every tile's registry id is null for the same reason, so
        repeating it per tile turns a single actionable fact (set QUAY_FLEET_BIN) into noise.
      */}
      {!fleetAvailable && (
        <p
          className="mx-4 mt-4 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="cockpit-fleet-cli-missing"
          data-fleet-available="false"
        >
          {t('cockpit.fleetCliMissing', { reason: fleetReason ?? '' })}
        </p>
      )}
      {/*
        The ordinals are minted from the REGISTERED projects, in reading order, so a roster with
        a hole in it draws ② next to a tile that carries no number at all. Without a sentence
        saying so, 「第二个」 and the digit 2 look like they should name the second TILE. One
        quiet line states the rule once for the whole grid.
      */}
      <p
        className="mx-4 mt-2 text-[11px] text-muted-foreground"
        data-testid="cockpit-fleet-ordinal-note"
      >
        {t('cockpit.ordinalsRegisteredOnly')}
      </p>
      <ul
        className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3"
        data-testid="cockpit-fleet-tiles"
        // The view contract itself, published once so a test (or the future semantic surface)
        // reads the same declaration the renderer drew.
        data-cockpit-focusables={JSON.stringify(focusables)}
      >
      {projects.map((project) => {
        // The fleet view's focusable objects are addressed by the fleet REGISTRY id. A project
        // whose root is not registered has no such id, so it is absent from the declared set
        // and its tile declares no address (「不可被引用」) — the counts still render.
        const fleetProjectId = project.fleetProjectId ?? null;
        const fleetProjectUri =
          fleetProjectId === null ? null : `quay://${fleetProjectId}/board`;
        const focusable =
          fleetProjectUri === null
            ? undefined
            : focusables.find((object) => object.uri === fleetProjectUri);
        const registered = focusable !== undefined;
        const isFocused = focusable !== undefined && focusable.uri === focusUri;
        // 「需要人」 is the one coloured element in the fleet view: the only state that asks the
        // person to act must be visible at a glance without reading the counts line. The marker is
        // a data attribute as well as a border so the emphasis is addressable without CSS.
        const needsHuman = project.tasks.needsHuman > 0;

        return (
          <li
            key={project.projectId}
            role={registered ? 'button' : undefined}
            tabIndex={registered ? -1 : undefined}
            onClick={focusable === undefined ? undefined : () => onFocusObject(focusable.uri)}
            className={cn(
              'rounded-lg border bg-card p-3 text-left transition-shadow focus:outline-none',
              registered ? 'cursor-pointer' : 'border-dashed',
              needsHuman
                ? 'border-amber-500 ring-1 ring-amber-500/40 dark:border-amber-400 dark:ring-amber-400/40'
                : 'border-border/50',
              isFocused && 'ring-2 ring-primary',
            )}
            data-testid="cockpit-fleet-tile"
            data-fleet-registered={registered ? 'true' : 'false'}
            data-quay-uri={focusable?.uri}
            data-quay-label={focusable?.label}
            data-quay-display={focusable === undefined ? undefined : JSON.stringify(focusable.display)}
            data-needs-human={needsHuman ? 'true' : undefined}
            data-focused={isFocused ? 'true' : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                {/* The ordinal is the spoken handle AND the place a pointer lands: it is drawn at
                    body size in the foreground colour, never as dim decorative small print. */}
                {focusable !== undefined && (
                  <span
                    className="shrink-0 text-sm font-semibold tabular-nums text-foreground"
                    data-testid="cockpit-fleet-tile-label"
                  >
                    {focusable.label}
                  </span>
                )}
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
            {/*
              Only when the fleet ANSWERED but this project is not in it. With the CLI
              missing, the single notice above already explains why no tile is registered,
              and repeating it here is the per-tile noise this task removes.
            */}
            {fleetAvailable && fleetProjectId === null && (
              <p className="mt-1 text-[11px] text-muted-foreground" data-testid="cockpit-fleet-tile-unregistered">
                {t('cockpit.projectNotRegistered')}
              </p>
            )}
            {project.error !== null && (
              <p className="mt-1 truncate text-[11px] text-amber-700 dark:text-amber-300" data-testid="cockpit-fleet-tile-error">
                {project.error}
              </p>
            )}
            {/*
              THE PULSE STRIP AT THE TILE'S FOOT. Four rows in 48 px: what is running, whether
              fan-in and the suite are landing or failing, and what is blocked for whom. It is
              drawn only when the server reported a reading — an unreported pulse is not an idle
              project, and an empty strip would say "nothing happened" about a fact nobody read.
              A mark activates the task it names: the fleet view's declared focusables are
              boards, so the page receives the task URI and can focus it on the board surface
              (the Quay panel's own strip emits the same address with the same handler).
            */}
            {project.pulse !== undefined && project.pulse !== null && (
              <div className="mt-2" data-testid="cockpit-fleet-tile-pulse">
                <PulseStrip
                  inFlight={project.pulse.inFlight}
                  gantt={project.pulse.gantt}
                  tests={project.pulse.tests}
                  fanIn={project.pulse.fanIn}
                  blockers={project.pulse.blockers}
                  generatedAt={project.pulse.generatedAt}
                  onFocusTask={
                    fleetProjectId === null
                      ? undefined
                      : (taskId) =>
                          onFocusObject(
                            formatQuayUri({ type: 'task', project: fleetProjectId, id: taskId, ac: null }),
                          )
                  }
                  testId={`cockpit-fleet-pulse-${project.projectId}`}
                />
              </div>
            )}
          </li>
        );
      })}
      </ul>
    </div>
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
          <ul className="flex flex-col gap-1.5" data-testid="cockpit-board-rail">
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
                <li key={focusable.uri} className="min-w-0">
                  {/*
                    ONE CHIP LAYOUT FOR EVERY IN-FLIGHT TASK. Earlier the chip's width came from
                    its longest line: a task with a subtitle drew a 600–900px bar while a task
                    without one stayed a small pill, and the status label never lined up. The
                    chip now fills the rail's column and its text WRAPS (`break-words`) instead
                    of overflowing, so short and long ids draw the same shape. The focus ring is
                    a data-attribute variant on the SHARED class string, so the chip's class set
                    cannot differ between the focused and unfocused state.
                  */}
                  <button
                    type="button"
                    onClick={() => onFocusObject(focusable.uri)}
                    className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded border border-border/50 px-2 py-1 text-left text-xs text-foreground data-[focused=true]:ring-2 data-[focused=true]:ring-primary"
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
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span
                        className="break-words text-xs font-semibold text-foreground"
                        title={taskId}
                        data-testid="cockpit-board-object-title"
                      >
                        {taskId}
                      </span>
                      {taskTitle !== undefined && (
                        <span
                          className="break-words text-[11px] text-muted-foreground"
                          data-testid="cockpit-board-object-subtitle"
                        >
                          {taskTitle}
                        </span>
                      )}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
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
              retry button — so a failed read shows an error surface, never a blank stage. Its
              pulse strip emits task addresses through `onFocusObject`, so activating a mark on
              the board's strip focuses the same in-flight card the rail declares. */}
          <QuayPanel
            projectId={boardProjectId}
            view={boardView}
            onRefresh={onRefreshBoard}
            onFocusTask={onFocusObject}
          />
        </div>
      )}
    </div>
  );
}
