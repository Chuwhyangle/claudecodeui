import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/shared/api';
import { useWebSocketOptional } from '@/shared/context/WebSocketContext';
import type { QuayFleetSummary, QuayFocusableObject, VoiceFailureReport } from '@/shared/types';
import { buildQuayInFlightContract, parseQuayUri, useQuayStatus } from '@/modules/quay';
import CockpitInput from '@/modules/cockpit/CockpitInput';
import CockpitStage from '@/modules/cockpit/CockpitStage';
import type { CockpitFleetStatus } from '@/modules/cockpit/CockpitStage';
import type { CockpitIntent } from '@/modules/cockpit/cockpitIntent';
import {
  openCockpitSendGate,
  cockpitProjectForUri,
  pinCockpitTargetSession,
  routeCockpitText,
} from '@/modules/cockpit/cockpitRouting';
import type {
  CockpitFleetPort,
  CockpitFleetReading,
  CockpitFleetWriteResult,
  CockpitSendGate,
  CockpitSendPreview,
} from '@/modules/cockpit/cockpitRouting';
import {
  buildCockpitFleetContract,
  cockpitViewPath,
  cockpitViewUri,
  parseCockpitView,
  projectNameFromPath,
} from '@/modules/cockpit/cockpitView';
import type { CockpitProject, CockpitTiming, CockpitView } from '@/modules/cockpit/cockpitView';
import { useCockpitFocus } from '@/modules/cockpit/hooks/useCockpitFocus';
import { useCockpitPushToTalk } from '@/modules/cockpit/hooks/useCockpitPushToTalk';

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

/**
 * Why a phrase produced no action: the parser matched no view command and the cockpit found no
 * conversation to route it to. `text` is the phrase verbatim, so the notice can quote what it
 * could not place instead of guessing at a nearby object.
 */
type IntentFeedback = { text: string; reason: 'no-focus' | 'no-session' };

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
  // The confirmation card for one routed phrase. Non-null means NOTHING has been sent yet: the
  // gate below owns the single transition, and this state is what draws the preview.
  const [pendingSend, setPendingSend] = useState<CockpitSendPreview | null>(null);
  // The project whose target conversation just received a message. Shown on the project strip
  // until the next submission; the conversation's own status change is the session's business.
  const [sentProjectId, setSentProjectId] = useState<string | null>(null);
  // The result of the last pin attempt, shown beside the preview. `null` means no attempt.
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  // The dictation chain's own failure sentence, shown where the cockpit's other notices are.
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  // The open confirmation gate. A ref, not state: it is a one-shot transition, not something the
  // UI renders, and re-creating it on a render would re-open a gate the person already closed.
  const gateRef = useRef<CockpitSendGate | null>(null);

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

  /**
   * The last-opened session, but only when it belongs to the project being addressed — the pointer
   * is global, and routing a phrase about project A into project B's conversation would be the
   * wrong-object failure this whole surface exists to prevent.
   */
  const readRecentSessionForProject = useCallback(async (projectId: string) => {
    const response = await api.quayLastOpenedSession();
    if (!response.ok) return null;
    const pointer = (await response.json()) as { sessionId?: unknown };
    const sessionId =
      typeof pointer.sessionId === 'string' && pointer.sessionId !== '' ? pointer.sessionId : null;
    if (sessionId === null) return null;
    const detailsResponse = await api.sessionDetails(sessionId);
    if (!detailsResponse.ok) return null;
    const details = (await detailsResponse.json()) as {
      data?: { project?: { projectId?: string } | null };
    };
    return details.data?.project?.projectId === projectId ? sessionId : null;
  }, []);

  /** One conversation's title for the preview bar; absent or unreadable falls back to its id. */
  const readSessionTitle = useCallback(async (sessionId: string) => {
    try {
      const response = await api.sessionDetails(sessionId);
      if (!response.ok) return null;
      const details = (await response.json()) as { data?: { summary?: unknown } };
      const summary = details.data?.summary;
      return typeof summary === 'string' && summary.trim() !== '' ? summary.trim() : null;
    } catch {
      return null;
    }
  }, []);

  /**
   * Where a confirmed message goes: the chat websocket the whole app shares, addressing the
   * target session by id. This is the same `chat.send` frame the composer sends and the same
   * control service the MCP gateway's `session_send` uses — the cockpit opens no second path.
   * `null` outside a provider (a standalone render) simply sends nothing.
   */
  const socket = useWebSocketOptional();
  const sendToSession = useCallback(
    (sessionId: string, content: string) => {
      socket?.sendMessage({ type: 'chat.send', sessionId, content });
    },
    [socket],
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

  // The board's project segment: the fleet registry id, never the CloudCLI project id. The
  // fleet summary and the board snapshot carry the same server join, so either is a valid
  // source; `null` means the project is not registered and has no addressable objects.
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
      // The address's project segment is the fleet registry id, while the view description
      // (and the snapshot route behind it) is keyed by the CloudCLI project id — resolve the
      // one to the other rather than writing a fleet id into the URL.
      const project = cockpitProjectForUri(projects, focused.uri);
      if (project === null) {
        return;
      }
      showView({ type: 'board', project: project.projectId }, timing);
    },
    [focusState.focusObject, projects, showView],
  );

  /** Applies a recognised intent to the stage. Routing decisions never reach here. */
  const applyIntent = useCallback(
    (intent: CockpitIntent, text: string, startedAt: number) => {
      switch (intent.kind) {
        case 'view':
          showView(intent.view, { source: 'intent', input: text, startedAt });
          break;
        case 'focus':
          focusOn(intent.uri);
          break;
        case 'zoom-in':
          zoomIn({ source: 'intent', input: text, startedAt });
          break;
        case 'back':
          goBack({ source: 'intent', input: text, startedAt });
          break;
        case 'unmatched':
          // `routeCockpitText` never returns this arm; kept exhaustive on purpose so a new intent
          // kind cannot be added without this switch being visited.
          setIntentFeedback({ text: intent.text, reason: 'no-focus' });
          break;
      }
    },
    [focusOn, goBack, showView, zoomIn],
  );

  /**
   * The ONE submit path for typed and dictated text.
   *
   * The parser decides the destination: a recognised phrase changes the view (reversible), and
   * anything else is routed to the focused project's target conversation — as a PREVIEW, never
   * as a send. Nothing leaves until {@link confirmSend}; that is the whole point of the gate.
   */
  const handleSubmit = useCallback(
    async (text: string) => {
      const startedAt = performance.now();
      setIntentText('');
      setVoiceNotice(null);
      setPinNotice(null);

      const decision = await routeCockpitText({
        text,
        visible: focusables,
        projects,
        focusUri: focusState.focusUri,
        fleet: fleetPort,
        recentSessionId: readRecentSessionForProject,
        sessionTitle: readSessionTitle,
      });

      switch (decision.kind) {
        case 'intent':
          setIntentFeedback(null);
          applyIntent(decision.intent, text, startedAt);
          break;
        case 'preview': {
          setIntentFeedback(null);
          gateRef.current = openCockpitSendGate(decision.preview, sendToSession);
          setPendingSend(decision.preview);
          break;
        }
        case 'no-target':
          // No guess, no send: the notice quotes the phrase and says what was missing.
          setIntentFeedback({ text: decision.text, reason: decision.reason });
          break;
      }
    },
    [
      applyIntent,
      fleetPort,
      focusState.focusUri,
      focusables,
      projects,
      readRecentSessionForProject,
      readSessionTitle,
      sendToSession,
    ],
  );

  /** Sends the preview that is on screen, exactly once, and records「已发送」 on its project. */
  const confirmSend = useCallback(() => {
    const gate = gateRef.current;
    if (gate === null) return;
    gateRef.current = null;
    gate.confirm();
    setPendingSend(null);
    setPinNotice(null);
    setSentProjectId(gate.preview.projectId);
  }, []);

  /** Abandons the preview without sending. */
  const cancelSend = useCallback(() => {
    gateRef.current?.cancel();
    gateRef.current = null;
    setPendingSend(null);
    setPinNotice(null);
  }, []);

  /**
   * 「钉选为目标会话」: writes the preview's target into the fleet registry, then marks the
   * preview as pinned. The fleet's own refusal reason is shown verbatim — the dev-session
   * refusal is actionable, so paraphrasing it would hide the fix.
   */
  const pinTarget = useCallback(async () => {
    const preview = pendingSend;
    if (preview === null) return;
    const result = await pinCockpitTargetSession(fleetPort, preview.projectId, preview.sessionId);
    if (!result.ok) {
      setPinNotice(t('cockpit.pinRefused', { reason: result.reason }));
      return;
    }
    const pinned: CockpitSendPreview = {
      ...preview,
      source: 'pinned',
      fleetUnavailableReason: null,
    };
    gateRef.current = openCockpitSendGate(pinned, sendToSession);
    setPendingSend(pinned);
    setPinNotice(t('cockpit.pinned'));
  }, [fleetPort, pendingSend, sendToSession, t]);

  // The value the dictation is committed into: the box as it stood when THIS listen opened, so
  // segments committed one after another replace the listen's own text instead of stacking it.
  const voiceBaseRef = useRef('');
  const previousVoiceStateRef = useRef<'idle' | 'recording' | 'transcribing'>('idle');

  // Dictation lands in the input box and nowhere else. The hook's `send` flag is deliberately
  // dropped: confirming a send is a separate, explicit act.
  const pushToTalk = useCockpitPushToTalk({
    onTranscript: useCallback((text: string) => {
      const base = voiceBaseRef.current.trim();
      setIntentText(base === '' ? text : `${base} ${text}`);
    }, []),
    onError: useCallback((failure: VoiceFailureReport) => {
      setVoiceNotice(typeof failure === 'string' ? failure : failure.code ?? 'VOICE_FAILED');
    }, []),
    // The recogniser's hotwords: what the stage shows, plus the project names the person can say.
    candidates: useMemo(
      () => [
        ...projects.map((project) => project.name),
        ...focusables.flatMap((object) => [object.label, object.uri]),
      ],
      [focusables, projects],
    ),
    // While a confirmation is open, Space belongs to the confirmation, not to a new listen.
    enabled: pendingSend === null,
  });

  useEffect(() => {
    const previous = previousVoiceStateRef.current;
    previousVoiceStateRef.current = pushToTalk.state;
    if (pushToTalk.state === 'recording' && previous !== 'recording') {
      voiceBaseRef.current = intentText;
      setVoiceNotice(null);
    }
  }, [intentText, pushToTalk.state]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // A confirmation owns Enter and Backspace wherever focus is: Enter sends the preview,
      // Backspace abandons it. Without this, Enter in the (now empty) box would submit nothing
      // and Backspace would walk the view history out from under the pending message.
      if (pendingSend !== null) {
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
  }, [cancelSend, confirmSend, moveFocus, goBack, pendingSend, zoomIn]);

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
  const viewUri = cockpitViewUri(view, boardFleetProjectId);
  const focusedProjectName =
    focusState.focusObject === null
      ? null
      : cockpitProjectForUri(projects, focusState.focusObject.uri)?.name ?? null;

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
            {intentFeedback.reason === 'no-focus'
              ? t('cockpit.noFocusTarget', { text: intentFeedback.text })
              : t('cockpit.noTargetSession', { text: intentFeedback.text })}
          </p>
        )}

        {voiceNotice !== null && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-400" data-testid="cockpit-voice-error">
            {voiceNotice}
          </p>
        )}

        {/*
          The confirmation card. It shows the destination in the person's own words — project,
          conversation, text, and the references that will ride along — and nothing is sent until
          the button (or Enter) is pressed. 「取消」 and Backspace abandon it.

          `data-cockpit-send-pack` publishes the exact reference pack the message carries, for the
          same reason the timings are published: a browser check reads what will leave rather than
          inferring it from the rendered sentence.
        */}
        {pendingSend !== null && (
          <div
            className="mb-2 rounded border border-border/60 bg-muted/40 px-2 py-1.5"
            data-testid="cockpit-send-preview"
            data-cockpit-session={pendingSend.sessionId}
            data-cockpit-send-source={pendingSend.source}
            data-cockpit-send-pack={JSON.stringify(pendingSend.pack)}
          >
            <p className="text-xs" data-testid="cockpit-send-preview-line">
              {t('cockpit.sendPreview', {
                project: pendingSend.projectName,
                session: pendingSend.sessionTitle ?? pendingSend.sessionId,
                text: pendingSend.text,
              })}
            </p>
            <p className="text-[11px] text-muted-foreground" data-testid="cockpit-send-references">
              {t('cockpit.sendReferences', {
                refs: [
                  ...(pendingSend.pack.focus === null
                    ? []
                    : [`${pendingSend.pack.focus.label} → ${pendingSend.pack.focus.uri}`]),
                  ...pendingSend.pack.visible.map((object) => `${object.label} → ${object.uri}`),
                ].join('；'),
              })}
            </p>
            <p className="text-[11px] text-muted-foreground" data-testid="cockpit-send-source">
              {pendingSend.source === 'pinned'
                ? t('cockpit.sendTargetPinned')
                : pendingSend.fleetUnavailableReason !== null
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
                disabled={pendingSend.fleetUnavailableReason !== null}
                title={
                  pendingSend.fleetUnavailableReason === null
                    ? t('cockpit.pinTarget')
                    : t('cockpit.pinUnavailable')
                }
                className="rounded border border-border/60 px-2 py-0.5 text-[11px] disabled:opacity-50"
              >
                {pendingSend.source === 'pinned' ? t('cockpit.pinned') : t('cockpit.pinTarget')}
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
          onSubmit={(text) => void handleSubmit(text)}
          voiceState={pushToTalk.state}
          onVoiceToggle={pushToTalk.toggle}
          voiceInFlight={pushToTalk.inFlight}
        />
      </footer>
    </div>
  );
}
