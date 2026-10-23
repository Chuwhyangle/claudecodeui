import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/shared/api';
import type { QuayFleetSummary, QuayFocusableObject } from '@/shared/types';
import { buildQuayInFlightContract, formatQuayUri, parseQuayUri, useQuayStatus } from '@/modules/quay';
import CockpitInput from '@/modules/cockpit/CockpitInput';
import CockpitStage from '@/modules/cockpit/CockpitStage';
import type { CockpitFleetStatus } from '@/modules/cockpit/CockpitStage';
import { parseCockpitIntent } from '@/modules/cockpit/cockpitIntent';
import {
  buildCockpitFleetContract,
  cockpitViewPath,
  cockpitViewUri,
  parseCockpitView,
  projectNameFromPath,
} from '@/modules/cockpit/cockpitView';
import type { CockpitProject, CockpitTiming, CockpitView } from '@/modules/cockpit/cockpitView';
import { useCockpitFocus } from '@/modules/cockpit/hooks/useCockpitFocus';

/**
 * The cockpit's top-level page (`/cockpit`): a read-only stage over the quay fleet.
 *
 * It owns the three pieces of state the stage is built from — the fleet reading, the current
 * view (carried in the URL, so it is linkable and reloadable) and focus over the view's
 * declared objects — and it is the one place that turns a key press or a submitted phrase into
 * one of them. Nothing here mutates quay; the page only reads and points.
 */

/** One fleet reading; the discriminated union keeps a failed read from being drawn as empty. */
type FleetReading =
  | { status: 'loading' }
  | { status: 'loaded'; projects: CockpitProject[] }
  | { status: 'error'; message: string };

/** A view change whose intent → first-frame latency is still being measured. `startedAt` is
 * absent for a change triggered from a click, where the measurement starts at the handler. */
type PendingTiming = {
  source: CockpitTiming['source'];
  input: string;
  startedAt?: number;
};

/**
 * The instant this module loaded. The initial `url` latency reading is measured from here
 * rather than from a render-time `performance.now()`: a module-level read is not a render
 * impurity, and module evaluation still precedes the page's first committed frame.
 */
const PAGE_LOADED_AT = performance.now();

/** The parser's own failure message, shown verbatim: an unmatched phrase is never a guess. */
type IntentFeedback = { text: string };

/**
 * True when the focused element owns keyboard input. The stage must not steal arrows or Enter
 * while the cockpit's own input (or any other field) has focus — that is the whole point of
 * AC4's split.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Normalizes a pending timing, stamping the start at handler time when the caller did not
 * capture one (a click has no earlier "parse" instant to measure from).
 */
function stampTiming(timing: PendingTiming): PendingTiming {
  return { ...timing, startedAt: timing.startedAt ?? performance.now() };
}

/** Rendered by `App` for the `/cockpit` route. */
export default function CockpitPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  // The fleet reading behind the project strip and the fleet tiles (`GET /api/quay/fleet-summary`).
  const [fleet, setFleet] = useState<FleetReading>({ status: 'loading' });
  // The submitted phrase's unmatched feedback; `null` means the last phrase resolved or nothing
  // was submitted yet. Kept as state because the UI must state "not recognised" verbatim.
  const [intentText, setIntentText] = useState('');
  const [intentFeedback, setIntentFeedback] = useState<IntentFeedback | null>(null);
  // Every measured intent → first-frame latency, oldest first. Rendered as JSON on the root so
  // the future scenario runner can read it without another interface.
  const [timings, setTimings] = useState<CockpitTiming[]>([]);

  // The views already shown, newest last. Backspace pops this rather than trusting the browser
  // history stack, so a deep link (`?view=board&...`) still has a defined "back" (the fleet).
  const viewHistoryRef = useRef<CockpitView[]>([]);
  // The change whose first committed render has not been observed yet; consumed by the effect
  // below exactly once, so a latency is recorded once per real view change and never leaks into
  // a later one.
  const pendingTimingRef = useRef<PendingTiming | null>(null);
  // The address the page opened on. A ref, not a reactive read: the mount-only effect below
  // must record the ORIGINAL URL, not whichever one a later view change navigated to.
  const initialUrlRef = useRef<string>(`${location.pathname}${location.search}`);

  const view = useMemo(() => parseCockpitView(location.search), [location.search]);

  const loadFleet = useCallback(async () => {
    setFleet({ status: 'loading' });
    try {
      const response = await api.quayFleetSummary();
      if (!response.ok) {
        setFleet({ status: 'error', message: `HTTP ${response.status}` });
        return;
      }
      const summary = (await response.json()) as QuayFleetSummary;
      setFleet({
        status: 'loaded',
        projects: summary.projects.map((project) => ({
          projectId: project.projectId,
          name: projectNameFromPath(project.projectPath, project.projectId),
          projectPath: project.projectPath,
          driverState: project.driver.state,
          tasks: project.tasks,
          cached: project.cached,
          error: project.error,
        })),
      });
    } catch (error) {
      setFleet({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to read the quay fleet',
      });
    }
  }, []);

  useEffect(() => {
    void loadFleet();
  }, [loadFleet]);

  const projects = useMemo<CockpitProject[]>(
    () => (fleet.status === 'loaded' ? fleet.projects : []),
    [fleet],
  );

  const boardProjectId = view.type === 'board' ? view.project : null;
  // The board reads through the Quay module's own hook — the same snapshot request, cache
  // bypass and window handling the Quay tab uses. `isActive` keeps it idle on the fleet view.
  const { view: boardView, refresh: refreshBoard } = useQuayStatus(
    boardProjectId,
    true,
    boardProjectId !== null,
  );

  const fleetFocusables = useMemo(
    () => (fleet.status === 'loaded' ? buildCockpitFleetContract(fleet.projects).focusables : []),
    [fleet],
  );

  const boardFocusables = useMemo<QuayFocusableObject[]>(() => {
    if (view.type !== 'board' || boardView.status !== 'loaded') {
      return [];
    }
    return buildQuayInFlightContract(view.project, boardView.snapshot.inFlight).focusables;
  }, [view, boardView]);

  const focusables = view.type === 'fleet' ? fleetFocusables : boardFocusables;
  const focusState = useCockpitFocus(focusables);
  const moveFocus = focusState.move;
  const focusOn = focusState.focus;

  const showView = useCallback(
    (next: CockpitView, timing?: PendingTiming) => {
      const unchanged =
        next.type === view.type &&
        (next.type === 'fleet' || (view.type === 'board' && next.project === view.project));
      if (unchanged) {
        return;
      }
      viewHistoryRef.current.push(view);
      pendingTimingRef.current = timing === undefined ? null : stampTiming(timing);
      navigate(cockpitViewPath(next));
    },
    [navigate, view],
  );

  const goBack = useCallback(
    (timing?: PendingTiming) => {
      const previous = viewHistoryRef.current.pop();
      const next: CockpitView = previous ?? (view.type === 'board' ? { type: 'fleet' } : view);
      const unchanged =
        next.type === view.type &&
        (next.type === 'fleet' || (view.type === 'board' && next.project === view.project));
      if (unchanged) {
        return;
      }
      pendingTimingRef.current = timing === undefined ? null : stampTiming(timing);
      // Replace rather than push: "back" must not grow the browser stack it is walking.
      navigate(cockpitViewPath(next), { replace: true });
    },
    [navigate, view],
  );

  const zoomIn = useCallback(
    (timing?: PendingTiming) => {
      const focused = focusState.focusObject;
      if (focused === null) {
        return;
      }
      const parsed = parseQuayUri(focused.uri);
      // This stage ships project → board. Task → task detail belongs to the wall's later work,
      // so a task focus is a stated no-op rather than an invented sub-view.
      if (!parsed.ok || parsed.object.type !== 'board') {
        return;
      }
      showView({ type: 'board', project: parsed.object.project }, timing);
    },
    [focusState.focusObject, showView],
  );

  const handleIntentSubmit = useCallback(
    (text: string) => {
      const startedAt = performance.now();
      const intent = parseCockpitIntent(text, { visible: focusables, projects });
      setIntentText('');

      switch (intent.kind) {
        case 'view':
          setIntentFeedback(null);
          showView(intent.view, { source: 'intent', input: text, startedAt });
          break;
        case 'focus':
          setIntentFeedback(null);
          focusOn(intent.uri);
          break;
        case 'zoom-in':
          setIntentFeedback(null);
          zoomIn({ source: 'intent', input: text, startedAt });
          break;
        case 'back':
          setIntentFeedback(null);
          goBack({ source: 'intent', input: text, startedAt });
          break;
        case 'unmatched':
          // No guess: the UI states exactly what it did not understand.
          setIntentFeedback({ text: intent.text });
          break;
      }
    },
    [focusOn, focusables, goBack, projects, showView, zoomIn],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // The cockpit's text input owns every key while it has focus (arrows and Enter included).
      if (isEditableTarget(event.target)) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveFocus('down');
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveFocus('up');
          break;
        case 'ArrowRight':
          event.preventDefault();
          moveFocus('right');
          break;
        case 'ArrowLeft':
          event.preventDefault();
          moveFocus('left');
          break;
        case 'Enter':
          event.preventDefault();
          zoomIn({ source: 'key', input: 'Enter', startedAt: performance.now() });
          break;
        case 'Backspace':
          event.preventDefault();
          goBack({ source: 'key', input: 'Backspace', startedAt: performance.now() });
          break;
        default:
          // Escape is deliberately NOT handled: it aborts a running session turn elsewhere in
          // the app, and the cockpit's "back" is Backspace for exactly that reason.
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [moveFocus, goBack, zoomIn]);

  // One reading for the initial URL-driven mount: how long the first stage took to appear.
  useEffect(() => {
    const ms = performance.now() - PAGE_LOADED_AT;
    setTimings([{ source: 'url', input: initialUrlRef.current, ms }]);
  }, []);

  const viewKey = view.type === 'board' ? `board:${view.project}` : 'fleet';
  useEffect(() => {
    const pending = pendingTimingRef.current;
    if (pending === null) {
      return;
    }
    pendingTimingRef.current = null;
    const ms = performance.now() - (pending.startedAt ?? performance.now());
    setTimings((previous) => [...previous, { source: pending.source, input: pending.input, ms }]);
  }, [viewKey]);

  const fleetStatus: CockpitFleetStatus = fleet.status;
  const fleetError = fleet.status === 'error' ? fleet.message : null;
  const lastTiming = timings.length > 0 ? timings[timings.length - 1] : null;
  const viewUri = cockpitViewUri(view);
  const focusedProjectName =
    focusState.focusObject === null
      ? null
      : projects.find(
          (project) =>
            formatQuayUri({ type: 'board', project: project.projectId }) ===
            focusState.focusObject?.uri,
        )?.name ?? null;

  const openProject = (project: CockpitProject) => {
    showView(
      { type: 'board', project: project.projectId },
      { source: 'pointer', input: project.name },
    );
  };

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      data-testid="cockpit-page"
      data-cockpit-view={view.type}
      data-cockpit-timings={JSON.stringify(timings)}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{t('cockpit.title')}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('cockpit.readOnly')}
          </span>
          <span className="text-[11px] text-muted-foreground" data-testid="cockpit-view-label">
            {view.type === 'fleet'
              ? t('cockpit.fleetView')
              : `${t('cockpit.boardView')} · ${projects.find((project) => project.projectId === view.project)?.name ?? view.project}`}
          </span>
        </div>
        <span className="hidden text-[11px] text-muted-foreground sm:block" data-testid="cockpit-key-hint">
          {t('cockpit.keyHint')}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/40 p-3"
          data-testid="cockpit-project-strip"
          // The strip is navigation chrome, NOT part of the stage's focus contract: the fleet
          // tiles are the declared objects, and declaring the same project twice would make
          // 「第二个」 ambiguous.
          aria-label={t('cockpit.projectStrip')}
        >
          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('cockpit.projectStrip')}
          </p>
          {fleet.status === 'loading' && (
            <p className="text-xs text-muted-foreground">{t('cockpit.loading')}</p>
          )}
          {fleet.status === 'error' && (
            <button
              type="button"
              onClick={() => void loadFleet()}
              className="rounded border border-border/60 px-2 py-1 text-xs text-foreground hover:bg-accent"
              data-testid="cockpit-fleet-retry"
            >
              {t('cockpit.retry')}
            </button>
          )}
          {projects.map((project) => (
            <button
              key={project.projectId}
              type="button"
              onClick={() => openProject(project)}
              className="truncate rounded px-2 py-1 text-left text-xs text-foreground hover:bg-accent"
              data-testid="cockpit-project-strip-item"
              title={project.projectPath}
            >
              {project.name}
            </button>
          ))}
        </aside>

        <CockpitStage
          view={view}
          projects={projects}
          fleetStatus={fleetStatus}
          fleetError={fleetError}
          focusables={focusables}
          focusUri={focusState.focusUri}
          onFocusObject={focusState.focus}
          boardProjectId={boardProjectId}
          boardView={boardView}
          onRefreshBoard={refreshBoard}
        />
      </div>

      <footer className="border-t border-border/40 px-4 py-2" data-testid="cockpit-status">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span data-testid="cockpit-focus" data-cockpit-focus={focusState.focusUri ?? undefined}>
            {t('cockpit.focus')}: {focusState.focusUri ?? t('cockpit.noFocus')}
          </span>
          {focusedProjectName !== null && (
            <span data-testid="cockpit-focus-name">
              {focusState.focusObject?.label} · {focusedProjectName}
            </span>
          )}
          {focusState.focusObject !== null && focusedProjectName === null && (
            <span data-testid="cockpit-focus-name">
              {focusState.focusObject.label} · {focusState.focusObject.display.status}
            </span>
          )}
          <span data-testid="cockpit-view-uri" data-cockpit-view-uri={viewUri ?? undefined}>
            {viewUri ?? ''}
          </span>
          {lastTiming !== null && (
            <span data-testid="cockpit-timing">
              {t('cockpit.timingLast', { ms: Math.round(lastTiming.ms) })}
            </span>
          )}
        </div>

        {intentFeedback !== null && (
          <p className="mb-2 text-xs text-amber-700 dark:text-amber-300" data-testid="cockpit-intent-unmatched">
            {t('cockpit.intentUnmatched', { text: intentFeedback.text })}
          </p>
        )}

        <CockpitInput
          value={intentText}
          onValueChange={setIntentText}
          onSubmit={handleIntentSubmit}
        />
      </footer>
    </div>
  );
}
