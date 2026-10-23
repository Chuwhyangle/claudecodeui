import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/shared/api';
import type {
  CockpitHubView,
  CockpitPendingSend,
  QuayFleetSummary,
  QuayFocusableObject,
  QuayObjectUri,
  VoiceFailureReport,
} from '@/shared/types';
import { buildQuayInFlightContract, useQuayStatus } from '@/modules/quay';
import CockpitInput from '@/modules/cockpit/CockpitInput';
import CockpitStage from '@/modules/cockpit/CockpitStage';
import type { CockpitFleetStatus } from '@/modules/cockpit/CockpitStage';
import { pinCockpitTargetSession } from '@/modules/cockpit/cockpitRouting';
import type { CockpitFleetPort, CockpitFleetReading, CockpitFleetWriteResult } from '@/modules/cockpit/cockpitRouting';
import {
  buildCockpitFleetContract,
  cockpitViewPath,
  cockpitViewUri,
  parseCockpitView,
  projectNameFromPath,
} from '@/modules/cockpit/cockpitView';
import type { CockpitProject, CockpitTiming, CockpitView } from '@/modules/cockpit/cockpitView';
import { useCockpitHub } from '@/modules/cockpit/hooks/useCockpitHub';
import { useCockpitPushToTalk } from '@/modules/cockpit/hooks/useCockpitPushToTalk';

/**
 * The cockpit's top-level page (`/cockpit`): a stage over the quay fleet whose focus, view and
 * confirmation card are owned by the SERVER-SIDE cockpit hub.
 *
 * WHY THE PAGE OWNS NO TRANSITIONS. The desktop browser is a display: a global hotkey, or any
 * key pressed while its window is in the background, never reaches the page. The input comes
 * from a device that is always in hand, so the two roles talk through one shared state — the
 * hub — and this page only (a) renders the state it was last broadcast, (b) turns a key press
 * or a submitted phrase into an EVENT, and (c) reports what it is showing so the hub's input
 * pack describes the display rather than the device that happened to speak.
 *
 * Nothing here mutates quay. The only write the page performs is the user's explicit 「钉选」
 * action; a confirmed message is sent by the hub through the same session-send service the
 * chat composer uses.
 */

/** One fleet reading; the discriminated union keeps a failed read from being drawn as empty. */
type FleetReading =
  | { status: 'loading' }
  | { status: 'loaded'; projects: CockpitProject[] }
  | { status: 'error'; message: string };

/** A view change whose intent → first-frame latency is still being measured. */
type PendingTiming = {
  source: CockpitTiming['source'];
  input: string;
  startedAt: number;
};

/**
 * The instant this module loaded. The initial `url` latency reading is measured from here
 * rather than from a render-time `performance.now()`: a module-level read is not a render
 * impurity, and module evaluation still precedes the page's first committed frame.
 */
const PAGE_LOADED_AT = performance.now();

/**
 * True when the focused element owns keyboard input. The stage must not steal arrows or Enter
 * while the cockpit's own input (or any other field) has focus.
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
 * The hub's view → the page's view. The hub speaks in `quay://` project segments (fleet
 * registry ids); the page fetches and links by CloudCLI project id. An unregistered segment
 * has no board to show, so it stays on the fleet rather than inventing a URL.
 */
function cockpitViewForHubView(
  projects: readonly CockpitProject[],
  hubView: CockpitHubView,
): CockpitView {
  if (hubView.type === 'fleet') return { type: 'fleet' };
  const segment = hubView.project.toLowerCase();
  const project =
    projects.find((candidate) => (candidate.fleetProjectId ?? '').toLowerCase() === segment) ??
    projects.find((candidate) => candidate.name.toLowerCase() === segment);
  return project === undefined ? { type: 'fleet' } : { type: 'board', project: project.projectId };
}

/** The fleet registry segment a page view addresses, or null (fleet / unregistered project). */
function fleetSegmentForView(
  projects: readonly CockpitProject[],
  view: CockpitView,
): string | null {
  if (view.type === 'fleet') return null;
  const project = projects.find((candidate) => candidate.projectId === view.project);
  return project?.fleetProjectId ?? null;
}

/** Rendered by `App` for the `/cockpit` route. */
export default function CockpitPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const hub = useCockpitHub();
  const hubState = hub.state;

  // The fleet reading behind the project strip and the fleet tiles (`GET /api/quay/fleet-summary`).
  const [fleet, setFleet] = useState<FleetReading>({ status: 'loading' });
  // The input box's draft. The only page-local state the stage cannot derive: it is text being
  // typed, not cockpit state, and it must survive the round trip that follows submission.
  const [intentText, setIntentText] = useState('');
  // Every measured intent → first-frame latency, oldest first, published on the root for the
  // scenario runner. A measurement, not cockpit state.
  const [timings, setTimings] = useState<CockpitTiming[]>([]);
  // The project whose target conversation just received a message, shown on the strip until the
  // next submission. UI feedback for the person; the hub's `pendingSend` is the real card.
  const [sentProjectId, setSentProjectId] = useState<string | null>(null);
  // The result of the last pin attempt, shown beside the card. `null` means no attempt.
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  // The dictation chain's own failure sentence, shown where the cockpit's other notices are.
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);

  // The change whose first committed render has not been observed yet; consumed by the effect
  // below exactly once, so a latency is recorded once per real view change.
  const pendingTimingRef = useRef<PendingTiming | null>(null);
  // The address the page opened on. A ref, not a reactive read: the mount-only effect below
  // must record the ORIGINAL URL, not whichever one a later view change navigated to.
  const initialUrlRef = useRef<string>(`${location.pathname}${location.search}`);
  // A deep link (`?view=board&project=…`) is restored into the hub ONCE, after the fleet reads,
  // because the fleet registry id that addresses the hub is only known then.
  const seededRef = useRef(false);

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
          // The fleet registry id is the ONLY project segment the wall mints; an unregistered
          // project keeps `null` and therefore declares no addressable object.
          fleetProjectId: project.fleetProjectId ?? null,
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

  /**
   * The fleet registry seam's production binding: the server route that spawns the fleet CLI.
   * A failed request is `{ok:false, reason}` rather than a throw, so the cockpit can say the pin
   * could not be read and fall back instead of blanking the stage.
   */
  const fleetPort = useMemo<CockpitFleetPort>(
    () => ({
      async readInterfaceSession(projectId) {
        const response = await api.quayInterfaceSession(projectId);
        if (!response.ok) return { ok: false, reason: `http-${response.status}` };
        return (await response.json()) as CockpitFleetReading;
      },
      async writeInterfaceSession(projectId, sessionId) {
        const response = await api.pinQuayInterfaceSession(projectId, sessionId);
        if (!response.ok) return { ok: false, reason: `http-${response.status}` };
        return (await response.json()) as CockpitFleetWriteResult;
      },
      async clearInterfaceSession(projectId) {
        const response = await api.clearQuayInterfaceSession(projectId);
        if (!response.ok) return { ok: false, reason: `http-${response.status}` };
        return (await response.json()) as CockpitFleetWriteResult;
      },
    }),
    [],
  );

  const urlView = useMemo(() => parseCockpitView(location.search), [location.search]);
  // The view the hub describes, translated into the page's vocabulary.
  const hubView = useMemo(
    () => cockpitViewForHubView(projects, hubState.view),
    [hubState.view, projects],
  );
  // Before the hub's first event the page honours its own URL: that is what makes a deep link
  // open the board it names instead of flashing the fleet.
  const view = hubState.rev === 0 ? urlView : hubView;

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

  // The board's project segment: the fleet registry id, never the CloudCLI project id.
  const boardFleetProjectId: string | null = view.type === 'board'
    ? projects.find((project) => project.projectId === view.project)?.fleetProjectId
      ?? (boardView.status === 'loaded' ? boardView.snapshot.fleetProjectId ?? null : null)
    : null;

  const boardFocusables = useMemo<QuayFocusableObject[]>(() => {
    if (view.type !== 'board' || boardView.status !== 'loaded') {
      return [];
    }
    return buildQuayInFlightContract(boardFleetProjectId, boardView.snapshot.inFlight)?.focusables ?? [];
  }, [view, boardView, boardFleetProjectId]);

  const focusables = view.type === 'fleet' ? fleetFocusables : boardFocusables;
  // Focus is the hub's: the page only looks the address up in the set it is drawing. An address
  // the current view does not declare renders as "no focus" (never as a local fallback).
  const focusObject = useMemo(
    () =>
      hubState.focusUri === null
        ? null
        : focusables.find((object) => object.uri === hubState.focusUri) ?? null,
    [focusables, hubState.focusUri],
  );

  // Restore a deep-linked view into the hub once the fleet roster can translate it.
  useEffect(() => {
    if (seededRef.current || fleet.status !== 'loaded') return;
    seededRef.current = true;
    if (urlView.type === 'fleet') return;
    // The hub already has a view (another display drove it): the URL is stale, the hub wins.
    if (hubState.rev !== 0 || hubState.view.type !== 'fleet') return;
    const segment = fleetSegmentForView(projects, urlView);
    if (segment !== null) {
      hub.dispatch({ type: 'setView', view: { type: 'board', project: segment } });
    }
  }, [fleet.status, hub, hubState.rev, hubState.view, projects, urlView]);

  // The display's report: exactly what this page is drawing, published to the hub so the input
  // pack is built from the screen the person is looking at. Serialized as the effect key so a
  // re-render with identical content does not send a duplicate frame.
  const visibleReport = useMemo(
    () => ({
      viewUri: cockpitViewUri(view, boardFleetProjectId),
      focusables,
      projects: projects.map((project) => ({
        projectId: project.projectId,
        fleetProjectId: project.fleetProjectId ?? null,
        name: project.name,
        projectPath: project.projectPath,
      })),
    }),
    [boardFleetProjectId, focusables, projects, view],
  );
  const visibleReportKey = JSON.stringify(visibleReport);
  // True when the hub's view is the one this page is drawing. A deep link to a project the
  // fleet has not registered has no hub address, so the page keeps rendering its URL view and
  // does NOT report a stage the hub cannot describe (reporting would flip the hub to `fleet`
  // and take the board away with it).
  const hubDescribesView = useMemo(() => {
    if (view.type === 'fleet') return hubState.view.type === 'fleet';
    const segment = fleetSegmentForView(projects, view);
    return (
      segment !== null &&
      hubState.view.type === 'board' &&
      hubState.view.project.toLowerCase() === segment.toLowerCase()
    );
  }, [hubState.view, projects, view]);
  // The latest report, kept in a ref so the send effect can key on the SERIALIZED value: a new
  // hub frame re-creates the object identities, and depending on them would report in a loop.
  const visibleReportRef = useRef(visibleReport);
  useEffect(() => {
    visibleReportRef.current = visibleReport;
  });
  const reportVisible = hub.reportVisible;
  useEffect(() => {
    // Nothing to report until the roster is known: an early report would describe a fleet that
    // has not loaded, and the hub would build packs from it.
    if (fleet.status !== 'loaded' || !hub.connected || !seededRef.current) return;
    if (!hubDescribesView) return;
    reportVisible(visibleReportRef.current);
  }, [fleet.status, hub.connected, hubDescribesView, reportVisible, visibleReportKey]);

  // The URL follows the hub's view, so a view is linkable and a reload restores it. Replace,
  // not push: the browser's back stack is not this stage's history (the hub's stack is).
  // Compared as VIEWS, not as strings: `/cockpit` and `?view=fleet` are the same stage, and
  // rewriting an empty query to an explicit one would be a navigation nobody asked for.
  const viewPath = cockpitViewPath(view);
  useEffect(() => {
    const current = parseCockpitView(location.search);
    const alreadyThere =
      current.type === view.type &&
      (view.type === 'fleet' ||
        (current.type === 'board' && current.project === view.project));
    if (alreadyThere) return;
    navigate(viewPath, { replace: true });
  }, [location.search, navigate, view, viewPath]);

  /**
   * The send seam's explicit 「钉选」 action. It writes to the fleet registry, then tells the hub
   * the card is pinned; the hub is the one place the card's source is recorded.
   */
  const pinTarget = useCallback(async () => {
    const target = hubState.pendingSend?.target;
    if (target == null || target.projectId === null) return;
    const result = await pinCockpitTargetSession(fleetPort, target.projectId, target.sessionId);
    if (!result.ok) {
      setPinNotice(t('cockpit.pinRefused', { reason: result.reason }));
      return;
    }
    hub.dispatch({ type: 'pinTarget' });
    setPinNotice(t('cockpit.pinned'));
  }, [fleetPort, hub, hubState.pendingSend, t]);

  // The value the dictation is committed into: the box as it stood when THIS listen opened.
  const voiceBaseRef = useRef('');
  const previousVoiceStateRef = useRef<'idle' | 'recording' | 'transcribing'>('idle');

  // Dictation lands in the input box and nowhere else. Confirming a send is a separate act.
  const pushToTalk = useCockpitPushToTalk({
    onTranscript: useCallback((text: string) => {
      const base = voiceBaseRef.current.trim();
      setIntentText(base === '' ? text : `${base} ${text}`);
    }, []),
    onError: useCallback((failure: VoiceFailureReport) => {
      setVoiceNotice(typeof failure === 'string' ? failure : failure.code ?? 'VOICE_FAILED');
    }, []),
    // The recogniser's hotwords: what the stage shows, plus the project names a person can say.
    candidates: useMemo(
      () => [
        ...projects.map((project) => project.name),
        ...focusables.flatMap((object) => [object.label, object.uri]),
      ],
      [focusables, projects],
    ),
    // While a confirmation is open, Space belongs to the confirmation, not to a new listen.
    enabled: hubState.pendingSend === null,
  });

  useEffect(() => {
    const previous = previousVoiceStateRef.current;
    previousVoiceStateRef.current = pushToTalk.state;
    if (pushToTalk.state === 'recording' && previous !== 'recording') {
      voiceBaseRef.current = intentText;
      setVoiceNotice(null);
    }
  }, [intentText, pushToTalk.state]);

  /** The ONE submit path: the phrase becomes an event; the hub decides intent vs. a send card. */
  const handleSubmit = useCallback(
    (text: string) => {
      if (text.trim() === '') return;
      setIntentText('');
      setVoiceNotice(null);
      setPinNotice(null);
      pendingTimingRef.current = {
        source: 'intent',
        input: text,
        startedAt: performance.now(),
      };
      hub.dispatch({ type: 'utterance', text });
    },
    [hub],
  );

  const confirmSend = useCallback(() => {
    const target = hubState.pendingSend?.target;
    hub.dispatch({ type: 'confirm' });
    setPinNotice(null);
    if (target?.projectId != null) setSentProjectId(target.projectId);
  }, [hub, hubState.pendingSend]);

  const cancelSend = useCallback(() => {
    hub.dispatch({ type: 'cancel' });
    setPinNotice(null);
  }, [hub]);

  /** The hub's view, from a pointer on a fleet tile: address it and let the hub stack it. */
  const openProject = useCallback(
    (project: CockpitProject) => {
      const segment = project.fleetProjectId ?? null;
      if (segment === null) return;
      pendingTimingRef.current = {
        source: 'pointer',
        input: project.name,
        startedAt: performance.now(),
      };
      hub.dispatch({ type: 'setView', view: { type: 'board', project: segment } });
    },
    [hub],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // A confirmation owns Enter and Backspace wherever focus is: Enter sends the card,
      // Backspace abandons it.
      if (hubState.pendingSend !== null) {
        if (event.key === 'Enter') {
          event.preventDefault();
          confirmSend();
          return;
        }
        if (event.key === 'Backspace') {
          event.preventDefault();
          cancelSend();
          return;
        }
      }

      // The cockpit's text input owns every key while it has focus (arrows and Enter included).
      if (isEditableTarget(event.target)) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          hub.dispatch({ type: 'move', direction: 'down' });
          break;
        case 'ArrowUp':
          event.preventDefault();
          hub.dispatch({ type: 'move', direction: 'up' });
          break;
        case 'ArrowRight':
          event.preventDefault();
          hub.dispatch({ type: 'move', direction: 'right' });
          break;
        case 'ArrowLeft':
          event.preventDefault();
          hub.dispatch({ type: 'move', direction: 'left' });
          break;
        case 'Enter':
          event.preventDefault();
          pendingTimingRef.current = {
            source: 'key',
            input: 'Enter',
            startedAt: performance.now(),
          };
          hub.dispatch({ type: 'zoom', direction: 'in' });
          break;
        case 'Backspace':
          event.preventDefault();
          pendingTimingRef.current = {
            source: 'key',
            input: 'Backspace',
            startedAt: performance.now(),
          };
          hub.dispatch({ type: 'back' });
          break;
        default:
          // Escape is deliberately NOT handled: it aborts a running session turn elsewhere in
          // the app, and the cockpit's "back" is Backspace for exactly that reason.
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cancelSend, confirmSend, hub, hubState.pendingSend]);

  // One reading for the initial URL-driven mount: how long the first stage took to appear.
  useEffect(() => {
    const ms = performance.now() - PAGE_LOADED_AT;
    setTimings([{ source: 'url', input: initialUrlRef.current, ms }]);
  }, []);

  // An unmatched phrase is not a view change: drop the pending measurement rather than
  // attributing it to whichever view change happens next.
  useEffect(() => {
    if (hubState.pendingSend !== null) pendingTimingRef.current = null;
  }, [hubState.pendingSend]);

  const viewKey = view.type === 'board' ? `board:${view.project}` : 'fleet';
  useEffect(() => {
    const pending = pendingTimingRef.current;
    if (pending === null) return;
    pendingTimingRef.current = null;
    const ms = performance.now() - pending.startedAt;
    setTimings((previous) => [...previous, { source: pending.source, input: pending.input, ms }]);
  }, [viewKey]);

  const fleetStatus: CockpitFleetStatus = fleet.status;
  const fleetError = fleet.status === 'error' ? fleet.message : null;
  const lastTiming = timings.length > 0 ? timings[timings.length - 1] : null;
  const viewUri = cockpitViewUri(view, boardFleetProjectId);
  const focusedProjectName =
    focusObject === null
      ? null
      : projects.find((project) => {
          const segment = project.fleetProjectId ?? null;
          return segment !== null &&
            focusObject.uri.toLowerCase().startsWith(`quay://${segment.toLowerCase()}/`);
        })?.name ?? null;

  const pendingSend: CockpitPendingSend | null = hubState.pendingSend;
  const pendingTarget = pendingSend?.target ?? null;

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      data-testid="cockpit-page"
      data-cockpit-view={view.type}
      data-cockpit-timings={JSON.stringify(timings)}
      data-cockpit-hub-rev={hubState.rev}
      data-cockpit-hub-view={JSON.stringify(hubState.view)}
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
              data-cockpit-sent={sentProjectId === project.projectId ? 'true' : undefined}
              title={project.projectPath}
            >
              {project.name}
              {sentProjectId === project.projectId && (
                <span className="ml-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                  {t('cockpit.sent')}
                </span>
              )}
            </button>
          ))}
        </aside>

        <CockpitStage
          view={view}
          projects={projects}
          fleetStatus={fleetStatus}
          fleetError={fleetError}
          focusables={focusables}
          focusUri={focusObject?.uri ?? null}
          onFocusObject={(uri) => hub.dispatch({ type: 'focus', uri: uri as QuayObjectUri })}
          boardProjectId={boardProjectId}
          boardView={boardView}
          onRefreshBoard={refreshBoard}
        />
      </div>

      <footer className="border-t border-border/40 px-4 py-2" data-testid="cockpit-status">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span data-testid="cockpit-focus" data-cockpit-focus={focusObject?.uri ?? undefined}>
            {t('cockpit.focus')}: {focusObject?.uri ?? t('cockpit.noFocus')}
          </span>
          {focusedProjectName !== null && (
            <span data-testid="cockpit-focus-name">
              {focusObject?.label} · {focusedProjectName}
            </span>
          )}
          {focusObject !== null && focusedProjectName === null && (
            <span data-testid="cockpit-focus-name">
              {focusObject.label} · {focusObject.display.status}
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
          {/*
            「来自手机」: which device produced the last event. The name is the browser's own
            announcement, and the arrow is language-neutral, so this needs no translated
            sentence to stay readable in every locale.
          */}
          {hubState.lastEventSource !== null && (
            <span
              data-testid="cockpit-event-source"
              data-cockpit-source-role={hubState.lastEventSource.role}
              data-cockpit-source-device={hubState.lastEventSource.deviceId}
              title={hubState.lastEventSource.deviceId}
            >
              ← {hubState.lastEventSource.deviceName ?? hubState.lastEventSource.deviceId}
            </span>
          )}
        </div>

        {/*
          A phrase the hub could not place is stated verbatim rather than guessed at. When the
          hub found no destination it is a notice, not a confirmation card: nothing will be sent.
        */}
        {pendingSend !== null && pendingTarget === null && (
          <p className="mb-2 text-xs text-amber-700 dark:text-amber-300" data-testid="cockpit-intent-unmatched">
            {pendingSend.reason === 'no-focus'
              ? t('cockpit.noFocusTarget', { text: pendingSend.text })
              : t('cockpit.noTargetSession', { text: pendingSend.text })}
          </p>
        )}

        {voiceNotice !== null && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-400" data-testid="cockpit-voice-error">
            {voiceNotice}
          </p>
        )}

        {/*
          The confirmation card, built by the hub from the DISPLAY's visible set. It shows the
          destination in the person's own words — the text it will send, project, conversation
          and the references that ride along — and nothing leaves until the button (or Enter) is
          pressed. 「取消」 and Backspace abandon it.
        */}
        {pendingSend !== null && pendingTarget !== null && (
          <div
            className="mb-2 rounded border border-border/60 bg-muted/40 px-2 py-1.5"
            data-testid="cockpit-send-preview"
            data-cockpit-session={pendingTarget.sessionId}
            data-cockpit-send-source={pendingTarget.source}
            data-cockpit-send-refs={JSON.stringify([
              ...(pendingSend.focusUri === null ? [] : [pendingSend.focusUri]),
              ...pendingSend.visible.map((object) => object.uri),
            ])}
          >
            <p className="text-xs" data-testid="cockpit-send-preview-line">
              {t('cockpit.sendPreview', {
                project: pendingTarget.projectName ?? pendingTarget.projectId ?? '',
                session: pendingTarget.sessionTitle ?? pendingTarget.sessionId,
                text: pendingSend.text,
              })}
            </p>
            <p className="text-[11px] text-muted-foreground" data-testid="cockpit-send-references">
              {t('cockpit.sendReferences', {
                refs: [
                  ...(pendingSend.focusUri === null ? [] : [pendingSend.focusUri]),
                  ...pendingSend.visible.map((object) => `${object.label} → ${object.uri}`),
                ].join('；'),
              })}
            </p>
            <p className="text-[11px] text-muted-foreground" data-testid="cockpit-send-source">
              {pendingTarget.source === 'pinned'
                ? t('cockpit.sendTargetPinned')
                : pendingTarget.fleetUnavailableReason !== null
                  ? t('cockpit.sendTargetRecentUnavailable')
                  : t('cockpit.sendTargetRecent')}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="cockpit-send-confirm"
                onClick={confirmSend}
                className="rounded bg-foreground px-2 py-0.5 text-[11px] text-background"
              >
                {t('cockpit.sendConfirm')}
              </button>
              <button
                type="button"
                data-testid="cockpit-send-cancel"
                onClick={cancelSend}
                className="rounded border border-border/60 px-2 py-0.5 text-[11px]"
              >
                {t('cockpit.sendCancel')}
              </button>
              <button
                type="button"
                data-testid="cockpit-pin-target"
                onClick={() => void pinTarget()}
                disabled={pendingTarget.projectId === null}
                title={t('cockpit.pinTarget')}
                className="rounded border border-border/60 px-2 py-0.5 text-[11px] disabled:opacity-50"
              >
                {pendingTarget.source === 'pinned' ? t('cockpit.pinned') : t('cockpit.pinTarget')}
              </button>
              {pinNotice !== null && (
                <span className="text-[11px] text-muted-foreground" data-testid="cockpit-pin-notice">
                  {pinNotice}
                </span>
              )}
            </div>
          </div>
        )}

        <CockpitInput
          value={intentText}
          onValueChange={setIntentText}
          onSubmit={handleSubmit}
          voiceState={pushToTalk.state}
          onVoiceToggle={pushToTalk.toggle}
          voiceInFlight={pushToTalk.inFlight}
        />
      </footer>
    </div>
  );
}
