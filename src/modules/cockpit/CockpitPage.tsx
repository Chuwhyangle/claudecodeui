import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { api } from '@/shared/api';
import { cn } from '@/shared/utils';
import type {
  CockpitHubView,
  CockpitPendingSend,
  QuayFleetCliState,
  QuayFleetSummary,
  QuayFocusableObject,
  QuayObjectUri,
  VoiceFailureReport,
} from '@/shared/types';
import { buildQuayInFlightContract, useQuayStatus } from '@/modules/quay';
import { SidebarModeSwitch } from '@/modules/sidebar';
import CockpitInput from '@/modules/cockpit/CockpitInput';
import CockpitStage from '@/modules/cockpit/CockpitStage';
import type { CockpitFleetStatus } from '@/modules/cockpit/CockpitStage';
import { pinCockpitTargetSession } from '@/modules/cockpit/cockpitRouting';
import type { CockpitFleetPort, CockpitFleetReading, CockpitFleetWriteResult } from '@/modules/cockpit/cockpitRouting';
import {
  buildCockpitFleetContract,
  buildInitiativeContract,
  buildObservationWallContract,
  cockpitViewPath,
  cockpitViewUri,
  parseCockpitView,
  projectNameFromPath,
  resolveCockpitProject,
} from '@/modules/cockpit/cockpitView';
import type { CockpitProject, CockpitTiming, CockpitView } from '@/modules/cockpit/cockpitView';
import DecisionQueue from '@/modules/cockpit/DecisionQueue';
import DeployReadiness from '@/modules/cockpit/DeployReadiness';
import InitiativeView from '@/modules/cockpit/InitiativeView';
import { useCockpitHub } from '@/modules/cockpit/hooks/useCockpitHub';
import { useCockpitPushToTalk } from '@/modules/cockpit/hooks/useCockpitPushToTalk';
import {
  decideInitiative,
  useInitiativeReading,
} from '@/modules/cockpit/hooks/useInitiatives';
import {
  latestProducerRunAt,
  markObservationSeen,
  observationPinnedUris,
  toggleObservationPin,
  useObservationWall,
} from '@/modules/cockpit/hooks/useObservationWall';
import type {
  ObservationWallEntry,
  ObservationWallView,
} from '@/modules/cockpit/hooks/useObservationWall';
import { parseObservationUri } from '@/modules/cockpit/observationUri';
import { encodeQr } from '@/modules/cockpit/cockpitQr';

/** Where the phone remote lives, relative to the cockpit's router basename. */
const REMOTE_PATH = '/cockpit/remote';

/**
 * The cockpit header's control size, shared by the mode switch's segments and the phone-remote
 * toggle so the two controls line up: a 44px touch target on a phone, the 28px icon-button size
 * from `md` up (the same size the sidebar's settings button uses). Exported so the cockpit test
 * can assert both controls carry this class rather than measuring jsdom boxes, which have no CSS.
 */
export const COCKPIT_HEADER_CONTROL_SIZE_CLASS = 'min-h-11 min-w-11 md:min-h-7 md:min-w-7';

/**
 * The address the stage's QR code encodes: this deployment's origin and basename plus
 * `/cockpit/remote`. Derived from the URL the stage is ALREADY on rather than from the router,
 * because a reverse proxy can mount the app under a prefix and the phone must open exactly the
 * address that works from outside — the one the desktop itself was served at.
 */
function remotePageUrl(): string {
  if (typeof window === 'undefined') return REMOTE_PATH;
  const { origin, pathname } = window.location;
  const cockpitPath = '/cockpit';
  const base = pathname.endsWith(cockpitPath)
    ? pathname.slice(0, pathname.length - cockpitPath.length)
    : '';
  return `${origin}${base}${REMOTE_PATH}`;
}

/**
 * The remote link as a scannable code. The QR encoder is the cockpit's own (see `cockpitQr.ts`);
 * this component only turns its matrix into one `<path>`, so the stage pays one DOM node rather
 * than a few thousand — and the code is `currentColor`, so it reads in both themes.
 */
function RemoteQr({ value, title }: { value: string; title: string }) {
  const matrix = useMemo(() => encodeQr(value), [value]);
  const path = useMemo(() => {
    let data = '';
    matrix.modules.forEach((row, rowIndex) => {
      row.forEach((dark, columnIndex) => {
        if (dark) data += `M${columnIndex} ${rowIndex}h1v1h-1z`;
      });
    });
    return data;
  }, [matrix]);
  return (
    <svg
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      width={112}
      height={112}
      role="img"
      aria-label={title}
      data-testid="cockpit-remote-qr"
      className="rounded bg-white p-1 text-black dark:bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

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
  | {
      status: 'loaded';
      projects: CockpitProject[];
      /** Whether the server could ask quay-fleet at all (false = the CLI is missing or incompatible). */
      fleetAvailable: boolean;
      /** The server's reason the fleet CLI could not be asked. */
      fleetReason: string | null;
      /**
       * The locator's state, when the server reported one. `null` for an older server that
       * only sends `{available, reason}`; the page must not invent a state it was not given.
       */
      fleetState: QuayFleetCliState | null;
      /** The binary the server selected, shown beside the notice. */
      fleetBinPath: string | null;
      /** The CLI's self-reported version, shown beside the notice. */
      fleetVersion: string | null;
    }
  | { status: 'error'; message: string };

/** A view change whose intent → first-frame latency is still being measured. */
type PendingTiming = {
  source: CockpitTiming['source'];
  input: string;
  startedAt: number;
};

/**
 * Every input gets an echo — the references' 「每次输入都有回声」 rule. The three shapes are the
 * product's: something was DONE, something CANNOT be done (with the reason and the next step),
 * or something needs CONFIRMATION. The first two disappear after a few seconds; a confirmation
 * stays exactly as long as the confirmation card does.
 */
type CockpitEchoKind = 'done' | 'refused' | 'confirm';

type CockpitEcho = {
  kind: CockpitEchoKind;
  /** What happened / what was asked, in the person's own words where possible. */
  text: string;
  /** Refused only: why it could not be done. */
  reason?: string;
  /** Refused only: the next step the person can take. */
  next?: string;
};

/** How long a done/refused echo stays on screen. */
export const COCKPIT_ECHO_TTL_MS = 3_000;

/** How often the wall's liveness labels are re-derived ("3 min ago" must not freeze). */
const LIVENESS_TICK_MS = 30_000;

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
 * The fleet tile grid's column count at a viewport width.
 *
 * It MIRRORS the classes on the grid in `CockpitStage` (`grid-cols-1 sm:grid-cols-2
 * xl:grid-cols-3`). The hub snaps focus over the `pos` the display reports and the server has
 * no DOM to measure, so the display must report the grid it actually drew — a contract where
 * every tile sits in column 1 is what made → a no-op and ↓ a linear "next tile".
 */
const FLEET_GRID_BREAKPOINTS = [
  { minWidth: 1280, columns: 3 },
  { minWidth: 640, columns: 2 },
] as const;

function fleetGridColumns(viewportWidth: number): number {
  for (const breakpoint of FLEET_GRID_BREAKPOINTS) {
    if (viewportWidth >= breakpoint.minWidth) return breakpoint.columns;
  }
  return 1;
}

/** The viewport width, or 0 where there is no window (a non-browser render pass). */
function currentViewportWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth;
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
  if (hubView.type === 'fleet') return { type: 'wall' };
  // The hub's segment is a fleet registry id; the spoken project name is still accepted as an
  // alias because the intent parser may hand one through.
  const project =
    resolveCockpitProject(projects, hubView.project) ??
    projects.find((candidate) => candidate.name.toLowerCase() === hubView.project.toLowerCase()) ??
    null;
  // The URL carries the FLEET registry id (the project segment every `quay://` address uses),
  // never the CloudCLI project id — a stored UUID link is rewritten by the page's own effect.
  return project === null
    ? { type: 'wall' }
    : { type: 'board', project: project.fleetProjectId ?? project.projectId };
}

/**
 * Keeps `?debug=1` across a view navigation. The debug switch is a reading preference, not part
 * of the view; dropping it whenever the view changes would turn itself off the first time the
 * person navigated.
 */
function withDebugQuery(path: string, search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('debug') !== '1') return path;
  return `${path}${path.includes('?') ? '&' : '?'}debug=1`;
}

/** The fleet registry segment a page view addresses, or null (wall / fleet / unregistered). */
function fleetSegmentForView(
  projects: readonly CockpitProject[],
  view: CockpitView,
): string | null {
  if (view.type !== 'board') return null;
  return resolveCockpitProject(projects, view.project)?.fleetProjectId ?? null;
}

/**
 * True when the URL spells a view explicitly (`?view=fleet`, `?view=board&project=…`).
 *
 * THIS IS THE DIFFERENCE BETWEEN A NAVIGATION AND A LANDING. A bare `/cockpit` is where the
 * person happens to arrive; a `view` parameter was put there by someone — a sidebar mode switch,
 * a project row's 「在驾驶舱中查看」, a pasted link — and states what they asked to see. The hub's
 * held view must not override the latter (that is the stale-hub bug this page used to have),
 * while it still owns the former (the cross-device "another display drove it" semantics).
 */
function hasExplicitCockpitView(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get('view');
  return value !== null && value.trim() !== '';
}

/** Rendered by `App` for the `/cockpit` route. */
export default function CockpitPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const hub = useCockpitHub();
  const hubState = hub.state;
  // The remote link: computed once — the origin and basename the stage was served at.
  const remoteUrl = useMemo(() => remotePageUrl(), []);

  // The fleet reading behind the project strip and the fleet tiles (`GET /api/quay/fleet-summary`).
  const [fleet, setFleet] = useState<FleetReading>({ status: 'loading' });
  // The input box's draft. The only page-local state the stage cannot derive: it is text being
  // typed, not cockpit state, and it must survive the round trip that follows submission.
  const [intentText, setIntentText] = useState('');
  // The window's width, tracked so the display reports the SAME grid it draws: the tile grid
  // changes columns at `sm`/`xl`, and the hub's arrow snapping reads the reported `pos`.
  const [viewportWidth, setViewportWidth] = useState<number>(currentViewportWidth);
  // The textarea, so `/` can move focus into it without the box ever taking focus on load.
  const intentInputRef = useRef<HTMLTextAreaElement>(null);
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

  // The observation wall (GET /api/observation/wall): the cockpit's home.
  const observation = useObservationWall();
  // The initiative whose pin write is in flight, so its button states it is busy.
  const [initiativePinPendingUri, setInitiativePinPendingUri] = useState<string | null>(null);
  // The wall's liveness labels ("3 min ago") are re-derived on a slow tick, so a timestamp is a
  // reading about now rather than about the moment the page happened to mount.
  const [now, setNow] = useState(() => Date.now());
  // The object whose in-place preview is open; `null` when the stage shows the list alone.
  const [wallPreviewUri, setWallPreviewUri] = useState<string | null>(null);
  // The object whose pin write is in flight.
  const [wallPinPendingUri, setWallPinPendingUri] = useState<string | null>(null);
  // The answer to the last input: done / refused+reason+next / awaiting confirmation.
  const [echo, setEcho] = useState<CockpitEcho | null>(null);
  // The phone remote's QR is opt-in: the code lives behind 「手机遥控」, not in the header.
  const [remoteOpen, setRemoteOpen] = useState(false);
  // `?debug=1` is the only place machine handles are drawn: URIs, first-frame timings and
  // device ids are diagnostics, not something a person reads on a status bar.
  const debug = useMemo(() => {
    const params = new URLSearchParams(location.search.startsWith('?') ? location.search.slice(1) : location.search);
    return params.get('debug') === '1';
  }, [location.search]);

  // The change whose first committed render has not been observed yet; consumed by the effect
  // below exactly once, so a latency is recorded once per real view change.
  const pendingTimingRef = useRef<PendingTiming | null>(null);
  // The address the page opened on. A ref, not a reactive read: the mount-only effect below
  // must record the ORIGINAL URL, not whichever one a later view change navigated to.
  const initialUrlRef = useRef<string>(`${location.pathname}${location.search}`);
  // A deep link (`?view=board&project=…`) is restored into the hub ONCE, after the fleet reads,
  // because the fleet registry id that addresses the hub is only known then.
  const seededRef = useRef(false);
  // Whether the page was opened on an explicit view. Captured at mount: the URL changes as the
  // page mirrors the hub later, and the entry decision must keep reading the ORIGINAL address.
  const initialViewExplicitRef = useRef(hasExplicitCockpitView(location.search));
  // Who wins the view on entry: `pending` until the roster can translate a deep link, then
  // `url` (a deliberate navigation was opened) or `hub` (a bare `/cockpit` adopts what the hub
  // holds). A reconnection moves it back to `hub` — see the reconnect effect below.
  const viewDirectionRef = useRef<'pending' | 'url' | 'hub'>('pending');
  // The hub revision at the moment the entry URL chose its view. A frame the hub broadcast
  // BEFORE that moment describes where the hub was, not where this page asked to go; it must
  // not rewrite the URL. Frames after it are the hub acknowledging the entry (or another
  // display genuinely driving the cockpit) and are mirrored normally.
  const urlDirectionRevRef = useRef(0);
  // Wakes the mirror effect for decisions that are not a hub revision: the entry direction
  // being settled, and a reconnection adopting the hub again.
  const [viewReconcileNonce, setViewReconcileNonce] = useState(0);
  // Connection edge tracking: the FIRST connect is not a reconnection (a deep link must
  // survive the socket coming up after mount); only a later false→true adopts the hub.
  const connectedRef = useRef(hub.connected);
  const everConnectedRef = useRef(hub.connected);
  // Set on a reconnection so the mirror effect follows the hub even when its view key is
  // unchanged (the transport, not the view, is what changed).
  const forceHubMirrorRef = useRef(false);
  // The echo arm: true between submitting a phrase and the hub answering it, so an unrelated
  // hub frame cannot be reported as "your input did". `echoSubmitRevRef` is the hub revision
  // the phrase was sent at, so a repeat of the SAME view still produces a done echo.
  const echoArmedRef = useRef(false);
  const echoSubmitRevRef = useRef(0);
  // The phrase the armed echo is about, so the done sentence can quote it.
  const lastSubmittedTextRef = useRef('');

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
        // An older server omits `fleet`; that is not the same as "the CLI is missing", so it
        // reads as available and the per-project ids carry the whole story.
        fleetAvailable: summary.fleet?.available !== false,
        fleetReason: summary.fleet?.reason ?? null,
        fleetState: summary.fleet?.state ?? null,
        fleetBinPath: summary.fleet?.binPath ?? null,
        fleetVersion: summary.fleet?.version ?? null,
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

  // One resize listener for the whole page: the grid contract is derived from this reading.
  useEffect(() => {
    const handleResize = () => setViewportWidth(currentViewportWidth());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const projects = useMemo<CockpitProject[]>(
    () => (fleet.status === 'loaded' ? fleet.projects : []),
    [fleet],
  );

  // The reading the project strip's gate is drawn from. The stage gets the same two values, so
  // the strip's tooltip and the stage's missing-CLI notice cannot tell two different stories.
  const fleetAvailable = fleet.status === 'loaded' ? fleet.fleetAvailable : true;
  const fleetReason = fleet.status === 'loaded' ? fleet.fleetReason : null;

  /**
   * Why a project cannot be opened, or `null` when it can. Two causes, and they are NOT the same
   * sentence: 「未登记」 is a registry action (`quay-fleet registry add`), 「驱动不可用」 is a
   * runtime one. A project whose root the fleet does not know has no `quay://` segment to open,
   * and a registered project whose driver did not answer has nothing to show behind its board.
   */
  const projectBlock = useCallback(
    (project: CockpitProject): { reason: string; next: string } | null => {
      if (!fleetAvailable) {
        return {
          reason: t('cockpit.fleetCliMissing', { reason: fleetReason ?? '' }),
          next: t('cockpit.fleetCliMissingNext'),
        };
      }
      if ((project.fleetProjectId ?? null) === null) {
        return {
          reason: t('cockpit.projectNotRegistered'),
          next: t('cockpit.projectUnregisteredNext'),
        };
      }
      if (project.driverState === 'unavailable') {
        return {
          reason: t('cockpit.projectDriverUnavailable'),
          next: t('cockpit.projectDriverUnavailableNext'),
        };
      }
      return null;
    },
    [fleetAvailable, fleetReason, t],
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
  /**
   * THE URL IS THE VIEW.
   *
   * A view change is a browser navigation, so the back button returns to the previous view —
   * one of the walkthrough items folded into this task. The hub still owns board intents (its
   * `setView` / `zoom` / `back` events are mirrored INTO the URL by the effect below), but the
   * page renders the URL rather than keeping a second copy of the hub's view.
   */
  const view: CockpitView = urlView;

  // The initiative view's reading (GET /api/quay/initiatives). It is fetched only while that
  // view is showing; its four states are drawn by the view so a fleet that cannot answer is
  // never misread as "no initiatives".
  const initiative = useInitiativeReading(view.type === 'initiatives');

  // `?attention=1` is the badge's way into the fleet: the projects waiting for a person come
  // first. The view stays `fleet`, so the URL still describes WHERE the person is; the flag only
  // says how the tiles are ordered. `sort` is stable, so equal readings keep the fleet's order.
  const attentionFirst =
    view.type === 'fleet' &&
    new URLSearchParams(
      location.search.startsWith('?') ? location.search.slice(1) : location.search,
    ).get('attention') === '1';
  // ONE ordering feeds both the tile render and the focus contract: sorting only inside the view
  // would leave the arrows snapping over the pre-sort grid.
  const orderedProjects = useMemo(
    () =>
      attentionFirst
        ? [...projects].sort(
            (left, right) => Number(right.tasks.needsHuman > 0) - Number(left.tasks.needsHuman > 0),
          )
        : projects,
    [attentionFirst, projects],
  );

  // The observation wall's reading, and the entries the stage draws (empty while loading).
  const wallView: ObservationWallView = observation.view;
  const wallEntries = useMemo(
    () => (wallView.status === 'loaded' ? wallView.wall.entries : []),
    [wallView],
  );

  // The view's project segment may be either handle: the cockpit's own URL writes the
  // CloudCLI id, while the sidebar's entry links speak the fleet registry id. Resolve it once
  // so the snapshot request, the board contract and the hub all use the CloudCLI id.
  const viewProject = useMemo(
    () => (view.type === 'board' ? resolveCockpitProject(projects, view.project) : null),
    [projects, view],
  );
  // The snapshot route is keyed by the CloudCLI project id. While the roster is still loading
  // a deep-linked fleet id cannot be translated yet; wait instead of requesting a 404 under the
  // wrong id (a later roster failure falls back to the raw segment, so the stage still tries).
  const boardProjectId =
    view.type === 'board'
      ? viewProject?.projectId ?? (fleet.status === 'loading' ? null : view.project)
      : null;
  // The board reads through the Quay module's own hook — the same snapshot request, cache
  // bypass and window handling the Quay tab uses. `isActive` keeps it idle on the fleet view.
  const { view: boardView, refresh: refreshBoard } = useQuayStatus(
    boardProjectId,
    true,
    boardProjectId !== null,
  );

  // The wall's declared objects: one per entry, with the same grid cells the tiles are drawn in.
  const wallFocusables = useMemo(
    () =>
      wallView.status === 'loaded'
        ? buildObservationWallContract(wallView.wall.entries, fleetGridColumns(viewportWidth)).focusables
        : [],
    [wallView, viewportWidth],
  );

  const fleetFocusables = useMemo(
    () =>
      fleet.status === 'loaded'
        ? buildCockpitFleetContract(orderedProjects, fleetGridColumns(viewportWidth)).focusables
        : [],
    [fleet, orderedProjects, viewportWidth],
  );

  // The board's project segment: the fleet registry id, never the CloudCLI project id.
  const boardFleetProjectId: string | null = view.type === 'board'
    ? viewProject?.fleetProjectId
      ?? (boardView.status === 'loaded' ? boardView.snapshot.fleetProjectId ?? null : null)
    : null;

  const boardFocusables = useMemo<QuayFocusableObject[]>(() => {
    if (view.type !== 'board' || boardView.status !== 'loaded') {
      return [];
    }
    return buildQuayInFlightContract(boardFleetProjectId, boardView.snapshot.inFlight)?.focusables ?? [];
  }, [view, boardView, boardFleetProjectId]);

  // The initiative view's declared objects: one per active initiative, addressed by the
  // fleet's reserved URI. A closed initiative is drawn as history and declares no object.
  const initiativeFocusables = useMemo<QuayFocusableObject[]>(
    () =>
      initiative.view.status === 'loaded'
        ? buildInitiativeContract(initiative.view.reading.initiatives).focusables
        : [],
    [initiative.view],
  );

  const focusables =
    view.type === 'wall'
      ? wallFocusables
      : view.type === 'fleet'
        ? fleetFocusables
        : view.type === 'initiatives'
          ? initiativeFocusables
          : boardFocusables;
  // Focus is the hub's: the page only looks the address up in the set it is drawing. An address
  // the current view does not declare renders as "no focus" (never as a local fallback).
  const focusObject = useMemo(
    () =>
      hubState.focusUri === null
        ? null
        : focusables.find((object) => object.uri === hubState.focusUri) ?? null,
    [focusables, hubState.focusUri],
  );

  // Decide who owns the view on entry, once the fleet roster can translate a deep link.
  //
  // THE ORDER IS THE WHOLE POINT. A URL that spells a view explicitly is a deliberate
  // navigation and WINS over whatever the hub held from another display: the page keeps the URL
  // it was asked to show and tells the hub (`setView`), so the other displays follow. Only a
  // bare `/cockpit` adopts the hub's held view — that is where "another display drove it" still
  // means something. Before this decision the mirror effect stays out of the way, so a stale
  // `?view=board&project=A` frame cannot erase a `?view=board&project=B` link.
  useEffect(() => {
    // While the roster is still loading, a fleet id in the URL has no translation yet — and a
    // gateway error must not leave the direction permanently undecided, so only `loading` waits.
    if (seededRef.current || fleet.status === 'loading') return;
    seededRef.current = true;
    urlDirectionRevRef.current = hubState.rev;
    setViewReconcileNonce((nonce) => nonce + 1);
    if (!initialViewExplicitRef.current) {
      viewDirectionRef.current = 'hub';
      return;
    }
    viewDirectionRef.current = 'url';
    // The hub has no wall stage — the wall and 「全部项目」 are both its `fleet`. Saying so
    // explicitly is also what moves a board held by another display back to the fleet.
    if (urlView.type !== 'board') {
      hub.dispatch({ type: 'setView', view: { type: 'fleet' } });
      return;
    }
    const segment = fleetSegmentForView(projects, urlView);
    // An unregistered project has no hub address; the URL still wins, but there is nothing to
    // tell the hub (the page's own board is the only place it exists).
    if (segment !== null) {
      hub.dispatch({ type: 'setView', view: { type: 'board', project: segment } });
    }
  }, [fleet.status, hub, hubState.rev, projects, urlView]);

  // A reconnection is not a navigation: the display comes back and follows the hub again, even
  // when the URL still spells the view it was opened with. The FIRST connection is exempt —
  // the socket coming up after mount must not undo a deep link.
  useEffect(() => {
    const wasConnected = connectedRef.current;
    const hadConnectedBefore = everConnectedRef.current;
    connectedRef.current = hub.connected;
    if (hub.connected) everConnectedRef.current = true;
    if (wasConnected || !hub.connected || !hadConnectedBefore || !seededRef.current) return;
    viewDirectionRef.current = 'hub';
    forceHubMirrorRef.current = true;
    setViewReconcileNonce((nonce) => nonce + 1);
  }, [hub.connected]);

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
  // True when the hub's view is one this page can describe. The wall and 「全部项目」 are both
  // the hub's `fleet` stage (the wall adds objects the fleet grid does not address); a board is
  // described only when the fleet registry can mint its address. A deep link to an unregistered
  // project therefore keeps its board and does NOT report a stage the hub cannot describe.
  const hubDescribesView = useMemo(() => {
    if (view.type !== 'board') return hubState.view.type === 'fleet';
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

  // A hub-originated view becomes a browser navigation (PUSH), so 「后退」 returns to the view
  // the person came from. Wall/「全部项目」 are page-local views: the hub never needs to name them,
  // and turning every key press into a history entry would be noise.
  //
  // NOTHING HERE RUNS BEFORE THE ENTRY DIRECTION IS DECIDED (`pending`): until the roster has
  // translated a deep link, the only frames in hand describe where the HUB was, and mirroring
  // them is exactly how a `?view=board&project=B` link used to land on A and stay there.
  const lastHubViewRef = useRef<string>('fleet');
  useEffect(() => {
    if (hubState.rev === 0) return;
    if (viewDirectionRef.current === 'pending') return;
    const key =
      hubState.view.type === 'board' ? `board:${hubState.view.project.toLowerCase()}` : 'fleet';
    const forced = forceHubMirrorRef.current;
    forceHubMirrorRef.current = false;
    // The URL was a deliberate navigation on entry. Only frames the hub broadcast AFTER that
    // decision can speak for it: the hub agreeing with the URL is our `setView` acknowledged
    // (ordinary mirroring resumes), and anything else is a later push from another display.
    if (viewDirectionRef.current === 'url' && !forced) {
      if (hubState.rev <= urlDirectionRevRef.current) return;
      const hubMatchesUrl =
        hubState.view.type === 'fleet'
          ? urlView.type !== 'board'
          : urlView.type === 'board' &&
            (fleetSegmentForView(projects, urlView) ?? urlView.project).toLowerCase() ===
              hubState.view.project.toLowerCase();
      viewDirectionRef.current = 'hub';
      lastHubViewRef.current = key;
      if (hubMatchesUrl) return;
    } else if (!forced && lastHubViewRef.current === key) {
      return;
    }
    lastHubViewRef.current = key;
    if (hubState.view.type === 'board') {
      const target = cockpitViewForHubView(projects, hubState.view);
      const segment = target.type === 'board' ? target.project : hubState.view.project;
      // The URL already describes this board (possibly with `?debug=1`): not a navigation.
      if (urlView.type === 'board' && urlView.project.toLowerCase() === segment.toLowerCase()) {
        return;
      }
      navigate(withDebugQuery(cockpitViewPath({ type: 'board', project: segment }), location.search));
      return;
    }
    // The hub went back to its fleet stage: follow it from a board to the wall.
    if (urlView.type === 'board') {
      navigate(withDebugQuery(cockpitViewPath({ type: 'wall' }), location.search));
    }
  }, [
    hubState.rev,
    hubState.view,
    location.search,
    navigate,
    projects,
    urlView,
    viewReconcileNonce,
  ]);

  // A URL stored by an older cockpit carries the CloudCLI project id. Once the roster can
  // translate it, rewrite it to the fleet registry id with REPLACE — the same view, spelled in
  // the address space the rest of the app uses, so no history entry is added for the rename.
  useEffect(() => {
    if (urlView.type !== 'board' || fleet.status !== 'loaded') return;
    const project = resolveCockpitProject(projects, urlView.project);
    const fleetId = project?.fleetProjectId ?? null;
    if (fleetId === null || fleetId === urlView.project) return;
    navigate(withDebugQuery(cockpitViewPath({ type: 'board', project: fleetId }), location.search), {
      replace: true,
    });
  }, [fleet.status, location.search, navigate, projects, urlView]);

  // The wall's liveness labels are re-derived on a slow tick ("3 min ago" must not freeze).
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LIVENESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // The preview's entry, resolved from the live wall. A tile a re-read removes closes the
  // preview instead of leaving a stale object on the stage.
  const wallPreviewEntry = useMemo<ObservationWallEntry | null>(
    () =>
      wallPreviewUri === null
        ? null
        : wallEntries.find((entry) => entry.object.uri === wallPreviewUri) ?? null,
    [wallEntries, wallPreviewUri],
  );
  useEffect(() => {
    if (wallPreviewUri !== null && wallView.status === 'loaded' && wallPreviewEntry === null) {
      setWallPreviewUri(null);
    }
  }, [wallPreviewEntry, wallPreviewUri, wallView.status]);

  /**
   * Opening a tile's preview. THE OPEN IS THE SEE: one `POST /seen` for this open, then the
   * local wall drops the object's deltas (the cursor is the server's, so they clear on every
   * device). 「稍后再看」 closes without this call — that is the whole difference.
   */
  const openWallEntry = useCallback(
    (uri: string) => {
      const entry = wallEntries.find((candidate) => candidate.object.uri === uri);
      if (entry === undefined) return;
      setWallPreviewUri(uri);
      void markObservationSeen(entry.object.uri, entry.object.revision)
        .then(() => observation.applySeen(entry.object.uri, entry.object.revision))
        .catch((error) => {
          setEcho({
            kind: 'refused',
            text: t('cockpit.observationSeenFailed'),
            reason: error instanceof Error ? error.message : '',
            next: t('cockpit.observationSeenNext'),
          });
        });
    },
    [observation, t, wallEntries],
  );

  const closeWallPreview = useCallback(() => setWallPreviewUri(null), []);

  /**
   * Pin / unpin one initiative on the observation wall. The URI is the fleet's reserved
   * address; the wall's read is re-run afterwards so the shared pin cache — the one source the
   * sidebar and the cockpit's buttons both read — reflects the write.
   */
  const toggleInitiativePin = useCallback(
    async (uri: string) => {
      setInitiativePinPendingUri(uri);
      try {
        await toggleObservationPin(uri, !observationPinnedUris().has(uri));
        await observation.reload();
      } catch (error) {
        setEcho({
          kind: 'refused',
          text: t('cockpit.initiativePinFailed'),
          reason: error instanceof Error ? error.message : '',
          next: t('cockpit.initiativePinNext'),
        });
      } finally {
        setInitiativePinPendingUri(null);
      }
    },
    [observation, t],
  );

  /**
   * The decision queue's only write. It goes through the server's decide route (which pins
   * provenance to a human fact) and re-reads the initiatives on success so the queue is the
   * server's reading rather than a local guess.
   */
  const decidePort = useCallback(
    async (request: Parameters<typeof decideInitiative>[0]) => {
      const outcome = await decideInitiative(request);
      if (outcome.ok) {
        await initiative.reload();
      }
      return outcome;
    },
    [initiative],
  );

  /** Pin / unpin one wall object. The wall is re-read so the tile's residency is the server's. */
  const toggleWallPin = useCallback(
    async (uri: string) => {
      const entry = wallEntries.find((candidate) => candidate.object.uri === uri);
      if (entry === undefined) return;
      setWallPinPendingUri(uri);
      try {
        await toggleObservationPin(uri, !entry.pinned);
        await observation.reload();
        setEcho({
          kind: 'done',
          text: t(entry.pinned ? 'cockpit.observationUnpinnedEcho' : 'cockpit.observationPinnedEcho', {
            title: entry.object.title,
          }),
        });
      } catch (error) {
        setEcho({
          kind: 'refused',
          text: t('cockpit.observationPinFailed'),
          reason: error instanceof Error ? error.message : '',
          next: t('cockpit.observationPinNext'),
        });
      } finally {
        setWallPinPendingUri(null);
      }
    },
    [observation, t, wallEntries],
  );

  /** A session tile's one door into the conversation, and its reason when it has no id. */
  const openWallSession = useCallback(() => {
    if (wallPreviewEntry === null) return;
    const parsed = parseObservationUri(wallPreviewEntry.object.uri);
    if (parsed === null || parsed.kind !== 'session') return;
    navigate(`/session/${encodeURIComponent(parsed.id)}`);
  }, [navigate, wallPreviewEntry]);

  /**
   * Architecture tiles open the architecture tab with the changed entity focused
   * (`?entity=` is the tab's own deep-link parameter). The digest carries the session the
   * graph was read from; without it there is no tab to open, and the preview states that.
   */
  const wallArchitectureSessionId = useMemo(() => {
    if (wallPreviewEntry === null || wallPreviewEntry.object.kind !== 'architecture') return null;
    const digest = wallPreviewEntry.object.digest;
    for (const key of ['sessionId', 'session', 'sourceSessionId']) {
      const value = digest[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  }, [wallPreviewEntry]);

  const openWallArchitecture = useCallback(() => {
    if (wallArchitectureSessionId === null) return;
    const digest = wallPreviewEntry?.object.digest ?? {};
    const entityCandidate = [digest.entityId, digest.entity, digest.focusEntity].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    const search = new URLSearchParams();
    if (entityCandidate !== undefined) search.set('entity', entityCandidate);
    // The architecture tile's structural diff travels as package-level deep-link parameters
    // (`diffPkg` / `diffPkgEdge`), which the tab marks on the drawing. Only well-typed entries
    // are forwarded: a malformed digest must not break the link.
    const diffPackages = Array.isArray(digest.diffPackages)
      ? digest.diffPackages.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      : [];
    for (const packageId of diffPackages) search.append('diffPkg', packageId.trim());
    const diffPackageEdges = Array.isArray(digest.diffPackageEdges) ? digest.diffPackageEdges : [];
    for (const edge of diffPackageEdges) {
      if (edge === null || typeof edge !== 'object') continue;
      const from = (edge as { from?: unknown }).from;
      const to = (edge as { to?: unknown }).to;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      if (from.trim() === '' || to.trim() === '') continue;
      search.append('diffPkgEdge', `${from.trim()}->${to.trim()}`);
    }
    const suffix = search.toString();
    navigate(
      `/session/${encodeURIComponent(wallArchitectureSessionId)}/architecture${suffix === '' ? '' : `?${suffix}`}`,
    );
  }, [navigate, wallArchitectureSessionId, wallPreviewEntry]);

  // Every input gets an echo. The hub's answer is what decides which of the three shapes it is:
  // a confirmation card (needs confirmation), an unmatched phrase (refused, with the reason and
  // the next step), or any other hub revision after a submit (done — including a repeat of the
  // view the person is already on).
  useEffect(() => {
    const pending = hubState.pendingSend;
    if (pending !== null) {
      echoArmedRef.current = false;
      if (pending.target === null) {
        setEcho({
          kind: 'refused',
          text: t('cockpit.echoUnmatched', { text: pending.text }),
          reason:
            pending.reason === 'no-focus'
              ? t('cockpit.noFocusTarget', { text: pending.text })
              : t('cockpit.noTargetSession', { text: pending.text }),
          next: t('cockpit.echoUnmatchedNext'),
        });
      } else {
        setEcho({ kind: 'confirm', text: t('cockpit.echoConfirm', { text: pending.text }) });
      }
      return;
    }
    if (!echoArmedRef.current) return;
    if (hubState.rev <= echoSubmitRevRef.current) return;
    echoArmedRef.current = false;
    setEcho({ kind: 'done', text: t('cockpit.echoDone', { text: lastSubmittedTextRef.current }) });
  }, [hubState.pendingSend, hubState.rev, t]);

  // The done/refused echo disappears after a few seconds; a confirmation lives exactly as long
  // as the card it belongs to.
  useEffect(() => {
    if (echo === null || echo.kind === 'confirm') return undefined;
    const timer = window.setTimeout(() => setEcho(null), COCKPIT_ECHO_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [echo]);

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
      // Arm the echo BEFORE the event leaves: the hub's answer may arrive on the very next frame.
      echoArmedRef.current = true;
      echoSubmitRevRef.current = hubState.rev;
      lastSubmittedTextRef.current = text;
      hub.dispatch({ type: 'utterance', text });
    },
    [hub, hubState.rev],
  );

  const confirmSend = useCallback(() => {
    const target = hubState.pendingSend?.target;
    hub.dispatch({ type: 'confirm' });
    setPinNotice(null);
    setEcho({ kind: 'done', text: t('cockpit.echoSent') });
    if (target?.projectId != null) setSentProjectId(target.projectId);
  }, [hub, hubState.pendingSend, t]);

  const cancelSend = useCallback(() => {
    hub.dispatch({ type: 'cancel' });
    setPinNotice(null);
    setEcho({ kind: 'done', text: t('cockpit.echoCancelled') });
  }, [hub, t]);

  /**
   * A page-local view switch (wall ⇄ 「全部项目」). A PUSH, so the browser's back returns to the
   * previous view; a repeat of the view already drawn is not a navigation and adds no entry.
   */
  const switchView = useCallback(
    (next: CockpitView) => {
      const alreadyThere =
        next.type === view.type &&
        (next.type !== 'board' || (view.type === 'board' && next.project === view.project));
      if (alreadyThere) return;
      navigate(withDebugQuery(cockpitViewPath(next), location.search));
    },
    [location.search, navigate, view],
  );

  /**
   * The attention badge's destination: the fleet view with the waiting projects on top. The
   * segment's own href stays the ordinary cockpit path, so a modified click (new tab) and the
   * browser's context menu still get a usable link; only a plain click takes this ordering.
   */
  const openAttentionFleet = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(withDebugQuery(`${cockpitViewPath({ type: 'fleet' })}&attention=1`, location.search));
    },
    [location.search, navigate],
  );

  /**
   * The hub's view, from a pointer on a project in the strip.
   *
   * A project the fleet cannot address — or whose driver did not answer — is refused OUT LOUD.
   * The strip draws it as disabled, and a pointer still lands an echo naming the reason and the
   * next step: silently returning made a deliberate disable indistinguishable from a broken
   * click, which is exactly the ambiguity this task removes.
   */
  const openProject = useCallback(
    (project: CockpitProject) => {
      const blocked = projectBlock(project);
      if (blocked !== null) {
        setEcho({
          kind: 'refused',
          text: t('cockpit.projectOpenRefused', { name: project.name }),
          reason: blocked.reason,
          next: blocked.next,
        });
        return;
      }
      const segment = project.fleetProjectId ?? null;
      // Unreachable for an unblocked project; keeping the guard makes the type honest.
      if (segment === null) return;
      pendingTimingRef.current = {
        source: 'pointer',
        input: project.name,
        startedAt: performance.now(),
      };
      hub.dispatch({ type: 'setView', view: { type: 'board', project: segment } });
    },
    [hub, projectBlock, t],
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

      // Ordinal addressing: a digit key focuses the declared object carrying that number. The
      // fleet mints its numbers for REGISTERED projects only, so a digit with no declared ordinal
      // names an unnumbered project — a real refusal, echoed with the reason instead of swallowed.
      if (/^[1-9]$/.test(event.key) && view.type === 'fleet') {
        event.preventDefault();
        const ordinal = Number(event.key);
        const target = focusables.find((object) => object.display.ordinal === ordinal);
        if (target !== undefined) {
          hub.dispatch({ type: 'focus', uri: target.uri });
        } else {
          setEcho({
            kind: 'refused',
            text: t('cockpit.ordinalUnavailable', { n: event.key }),
            reason: t('cockpit.ordinalsRegisteredOnly'),
            next: t('cockpit.ordinalUnavailableNext'),
          });
        }
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
          // On the wall, Enter opens the focused object's in-place preview. The hub's zoom is
          // a BOARD gesture (`quay://…/board`); an observation URI is not a board address, so
          // the wall's preview is the page's own transition rather than a stated no-op.
          if (view.type === 'wall' && focusObject !== null) {
            openWallEntry(focusObject.uri);
            break;
          }
          pendingTimingRef.current = {
            source: 'key',
            input: 'Enter',
            startedAt: performance.now(),
          };
          hub.dispatch({ type: 'zoom', direction: 'in' });
          break;
        case 'Backspace':
          event.preventDefault();
          // A preview is the innermost stage: Backspace closes it before it pops the view.
          if (wallPreviewUri !== null) {
            closeWallPreview();
            break;
          }
          pendingTimingRef.current = {
            source: 'key',
            input: 'Backspace',
            startedAt: performance.now(),
          };
          hub.dispatch({ type: 'back' });
          break;
        case '/':
          // `/` enters the composer. The box deliberately does not take focus on load: an
          // auto-focused textarea swallows the first arrow press, so the stage owns the
          // keyboard until the person asks for the box.
          event.preventDefault();
          intentInputRef.current?.focus();
          break;
        default:
          // Escape is deliberately NOT handled: it aborts a running session turn elsewhere in
          // the app, and the cockpit's "back" is Backspace for exactly that reason.
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    cancelSend,
    closeWallPreview,
    confirmSend,
    focusObject,
    focusables,
    hub,
    hubState.pendingSend,
    openWallEntry,
    t,
    view.type,
    wallPreviewUri,
  ]);

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

  const viewKey = view.type === 'board' ? `board:${view.project}` : view.type;
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
  // The status bar names what the person calls the object, never its storage address. On the
  // wall that is the tile's title; on a board it is the task id, or the ordinal when the object
  // is not a task. The raw `quay://` / `cloudcli://` handle lives behind `?debug=1` only.
  // The fleet tile a person sees ringed for attention. The ring is a NEEDS-YOU marker, not the
  // keyboard focus ring, so the footer names it separately; otherwise a fleet whose display has
  // not (yet) reported a focusable set reads 「Focus: none」 while a tile is visibly ringed.
  const attentionProject =
    view.type === 'fleet'
      ? (orderedProjects.find((project) => project.tasks.needsHuman > 0) ?? null)
      : null;
  const focusedHumanLabel =
    focusObject === null
      ? null
      : view.type === 'wall'
        ? (wallEntries.find((entry) => entry.object.uri === focusObject.uri)?.object.title ??
          focusObject.label)
        : view.type === 'initiatives'
          ? (initiative.view.status === 'loaded'
              ? initiative.view.reading.initiatives.find(
                  (candidate) => candidate.uri === focusObject.uri,
                )?.slug ?? focusObject.label
              : focusObject.label)
          : (() => {
            const parsed = focusObject.uri.startsWith('quay://') ? focusObject.uri.split('/') : [];
            // quay://<project>/task/<id> — the id is the readable part.
            return parsed.length >= 5 && parsed[3] === 'task' ? parsed[4]! : focusObject.label;
          })();

  const pendingSend: CockpitPendingSend | null = hubState.pendingSend;
  const pendingTarget = pendingSend?.target ?? null;
  // What the card calls the destination: the conversation's TITLE. A session id is a storage
  // handle, not a name — the preview used to print the full UUID, which told the person
  // nothing about where the message would go. Without a title, the honest label is
  // 「unnamed conversation」 plus a short id, never the whole identifier.
  const pendingSessionTitle = pendingTarget?.sessionTitle?.trim() ?? '';
  const pendingSessionLabel =
    pendingTarget === null
      ? ''
      : pendingSessionTitle !== ''
        ? pendingSessionTitle
        : t('cockpit.unnamedSession', { id: pendingTarget.sessionId.slice(0, 8) });

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      data-testid="cockpit-page"
      data-cockpit-view={view.type}
      data-cockpit-timings={JSON.stringify(timings)}
      data-cockpit-hub-rev={hubState.rev}
      data-cockpit-hub-view={JSON.stringify(hubState.view)}
      // The transport reading, beside the state it delivers: a display that has lost the hub is
      // a diagnosable state for the scenario runner, not something to infer from a frozen rev.
      data-cockpit-hub-connected={hub.connected ? 'true' : 'false'}
      data-cockpit-focus-uri={focusObject?.uri ?? undefined}
      data-cockpit-debug={debug ? 'true' : undefined}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold">{t('cockpit.title')}</span>
          <span className="text-xs text-muted-foreground" data-testid="cockpit-view-label">
            {view.type === 'wall'
              ? t('cockpit.wallView')
              : view.type === 'fleet'
                ? t('cockpit.fleetView')
                : view.type === 'initiatives'
                  ? t('cockpit.initiativesView')
                  : `${t('cockpit.boardView')} · ${viewProject?.name ?? view.project}`}
          </span>
          {/*
            When every producer is healthy the wall's own tile is absent — the layer has nothing
            to say. One quiet timestamp says it is alive without spending the top of the page on
            an all-green statement: 「各生产者最近更新」.
          */}
          {wallView.status === 'loaded' &&
            wallView.wall.producers.length > 0 &&
            wallView.wall.producers.every((producer) => producer.state === 'ok') &&
            latestProducerRunAt(wallView.wall) !== null && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="cockpit-producers-ok"
                data-last-run-at={latestProducerRunAt(wallView.wall)}
              >
                {t('cockpit.observationProducersOk')}
              </span>
            )}
        </div>
        <span className="hidden text-xs text-muted-foreground sm:block" data-testid="cockpit-key-hint">
          {t('cockpit.keyHint')}
        </span>
        {/* The same switch the sidebar header draws, with this page's segment active: that is
            the way back to the session list (no separate 「返回」 link to drift from it). The
            header's one control size is passed in so the segments and the remote toggle below
            are the same height; the badge opens the fleet with the waiting projects first. */}
        <SidebarModeSwitch
          mode="cockpit"
          controlSizeClass={COCKPIT_HEADER_CONTROL_SIZE_CLASS}
          onAttentionBadgeClick={openAttentionFleet}
          t={t}
        />
        {/* The phone remote is one button, not a permanent QR in the header. It is hidden on a
            phone: scanning your own screen there is meaningless, and the wrapped second row
            used to cost roughly 60px of the only viewport the stage has. */}
        <button
          type="button"
          onClick={() => setRemoteOpen((open) => !open)}
          aria-expanded={remoteOpen}
          className={cn(
            COCKPIT_HEADER_CONTROL_SIZE_CLASS,
            'hidden items-center justify-center rounded-md border border-border/60 px-2 text-xs text-foreground hover:bg-accent md:inline-flex',
          )}
          data-testid="cockpit-remote-toggle"
        >
          {t('cockpit.remoteTitle')}
        </button>
        {/*
          The phone remote's door: no token is minted — the remote is behind the same login, and
          the hub binds a device to the signed-in user's state, so the code only carries the URL.
          Rendered ONLY after the person asks for it (the QR is noise for everyone else).
        */}
        {remoteOpen && (
          <div
            className="flex items-center gap-2"
            data-testid="cockpit-remote-panel"
            data-cockpit-remote-url={remoteUrl}
          >
            <RemoteQr value={remoteUrl} title={t('cockpit.remoteScanHint')} />
            <div className="flex max-w-40 flex-col gap-0.5 text-xs leading-tight text-muted-foreground">
              <span className="font-medium text-foreground">{t('cockpit.remoteTitle')}</span>
              <span>{t('cockpit.remoteScanHint')}</span>
              <a href={remoteUrl} className="underline" data-testid="cockpit-remote-link">
                {t('cockpit.remoteOpen')}
              </a>
            </div>
          </div>
        )}
      </header>

      {/* The deployment reading is chrome, not a view: it stays put across the wall, the fleet,
          the initiatives and every project stage, the same way the header does. */}
      <div className="border-b border-border/40 px-4 py-2">
        <DeployReadiness />
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/*
          On a phone the strip becomes a horizontal row above the stage: the same two view
          switches and the same project list, without a fixed 12rem column that would push the
          single-column wall into horizontal overflow.
        */}
        <aside
          className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto border-b border-border/40 p-2 md:w-48 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:p-3"
          data-testid="cockpit-project-strip"
          // The strip is navigation chrome, NOT part of the stage's focus contract: the fleet
          // tiles are the declared objects, and declaring the same project twice would make
          // 「第二个」 ambiguous.
          aria-label={t('cockpit.projectStrip')}
        >
          <p className="mb-1 hidden shrink-0 text-xs uppercase tracking-wide text-muted-foreground md:block">
            {t('cockpit.projectStrip')}
          </p>
          {/*
            Two page-local views, above the project list: the observation wall (home) and
            「全部项目」 (the old fleet grid, demoted from the landing page). Each switch is a
            browser navigation, so the back button returns to the previous view.
          */}
          <button
            type="button"
            onClick={() => switchView({ type: 'wall' })}
            aria-current={view.type === 'wall' ? 'page' : undefined}
            className="min-h-11 shrink-0 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-accent md:min-h-0"
            data-testid="cockpit-nav-wall"
          >
            {t('cockpit.wallView')}
          </button>
          <button
            type="button"
            onClick={() => switchView({ type: 'fleet' })}
            aria-current={view.type === 'fleet' ? 'page' : undefined}
            className="min-h-11 shrink-0 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-accent md:min-h-0"
            data-testid="cockpit-nav-fleet"
          >
            {t('cockpit.fleetView')}
          </button>
          {/*
            The cross-project view: one row per initiative, with the decision queue beside it.
            It sits with the other page-local views so the browser's back button returns here.
          */}
          <button
            type="button"
            onClick={() => switchView({ type: 'initiatives' })}
            aria-current={view.type === 'initiatives' ? 'page' : undefined}
            className="min-h-11 shrink-0 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-accent md:min-h-0"
            data-testid="cockpit-nav-initiatives"
          >
            {t('cockpit.initiativesView')}
          </button>
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
          {projects.map((project) => {
            // A project the fleet cannot address (or whose driver is unavailable) is drawn as
            // disabled — lower contrast, `aria-disabled`, and its reason as the tooltip — but it
            // stays pointer-reachable: the click lands a refused echo instead of nothing.
            const blocked = projectBlock(project);
            return (
              <button
                key={project.projectId}
                type="button"
                onClick={() => openProject(project)}
                aria-disabled={blocked === null ? undefined : true}
                className={cn(
                  'min-h-11 shrink-0 truncate rounded px-2 py-1 text-left text-xs md:min-h-0',
                  blocked === null
                    ? 'text-foreground hover:bg-accent'
                    : 'cursor-not-allowed text-muted-foreground',
                )}
                data-testid="cockpit-project-strip-item"
                data-project-openable={blocked === null ? 'true' : 'false'}
                data-cockpit-sent={sentProjectId === project.projectId ? 'true' : undefined}
                title={blocked === null ? project.projectPath : blocked.reason}
              >
                {project.name}
                {sentProjectId === project.projectId && (
                  <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-400">
                    {t('cockpit.sent')}
                  </span>
                )}
              </button>
            );
          })}
        </aside>

        {view.type === 'initiatives' ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden" data-testid="cockpit-initiatives-stage">
            <div className="flex flex-col border-b border-border/40 lg:min-h-0 lg:flex-1 lg:border-b-0 lg:border-r">
              {initiative.view.status === 'loading' && (
                <p className="p-3 text-xs text-muted-foreground" data-testid="initiative-loading">
                  {t('cockpit.loading')}
                </p>
              )}
              {initiative.view.status === 'unavailable' && (
                <p
                  className="p-3 text-xs text-amber-700 dark:text-amber-300"
                  data-testid="initiative-unavailable"
                  data-reason={initiative.view.reading.reason}
                >
                  {t('cockpit.initiativeUnavailable', { reason: initiative.view.reading.reason })}
                </p>
              )}
              {initiative.view.status === 'error' && (
                <p
                  className="p-3 text-xs text-red-600 dark:text-red-400"
                  data-testid="initiative-error"
                >
                  {initiative.view.message}
                </p>
              )}
              {initiative.view.status === 'loaded' && (
                <InitiativeView
                  initiatives={initiative.view.reading.initiatives}
                  focusUri={focusObject?.uri ?? null}
                  pinnedUris={observationPinnedUris()}
                  pinPendingUri={initiativePinPendingUri}
                  now={now}
                  onFocus={(uri) => hub.dispatch({ type: 'focus', uri: uri as QuayObjectUri })}
                  onPin={(uri) => void toggleInitiativePin(uri)}
                />
              )}
            </div>
            <div className="flex w-full flex-col border-t border-border/40 lg:min-h-0 lg:w-96 lg:border-t-0 lg:border-l">
              {initiative.view.status === 'loaded' || initiative.view.status === 'unavailable' ? (
                <DecisionQueue
                  items={initiative.view.reading.decisionQueue}
                  audit={initiative.view.status === 'loaded' ? initiative.view.reading.audit : []}
                  auditRatio={initiative.view.reading.auditRatio}
                  decide={decidePort}
                />
              ) : (
                <p className="p-3 text-xs text-muted-foreground" data-testid="decision-queue-idle">
                  {t('cockpit.decisionQueueEmpty')}
                </p>
              )}
            </div>
          </div>
        ) : (
        <CockpitStage
          view={view}
          projects={orderedProjects}
          fleetStatus={fleetStatus}
          fleetError={fleetError}
          fleetAvailable={fleetAvailable}
          fleetReason={fleetReason}
          focusables={focusables}
          focusUri={focusObject?.uri ?? null}
          onFocusObject={(uri) => hub.dispatch({ type: 'focus', uri: uri as QuayObjectUri })}
          boardProjectId={boardProjectId}
          boardView={boardView}
          onRefreshBoard={refreshBoard}
          wallView={wallView}
          wallFocusUri={focusObject?.uri ?? null}
          wallNow={now}
          wallPreview={wallPreviewEntry}
          wallPinPendingUri={wallPinPendingUri}
          wallArchitectureReason={
            wallPreviewEntry !== null &&
            wallPreviewEntry.object.kind === 'architecture' &&
            wallArchitectureSessionId === null
              ? t('cockpit.observationArchitectureUnavailable')
              : null
          }
          onWallFocus={(uri) => hub.dispatch({ type: 'focus', uri: uri as QuayObjectUri })}
          onWallOpen={openWallEntry}
          onWallLater={closeWallPreview}
          onWallTogglePin={(uri) => void toggleWallPin(uri)}
          onWallOpenSession={openWallSession}
          onWallOpenArchitecture={openWallArchitecture}
          onReloadWall={() => void observation.reload()}
        />
        )}
      </div>

      <footer className="relative shrink-0 border-t border-border/40 bg-background px-4 py-2" data-testid="cockpit-status">
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {/*
            The status bar says only what a person can read: the focused object's NAME, never its
            storage handle. `quay://…`, first-frame timings and device ids are diagnostics and
            live behind `?debug=1` below.
          */}
          <span data-testid="cockpit-focus">
            {t('cockpit.focus')}: {focusedHumanLabel ?? t('cockpit.noFocus')}
            {/* A fleet tile's readable name is its ordinal AND its project; naming only the
                ordinal leaves 「Focus: ①」 as vague as 「none」. */}
            {view.type === 'fleet' && focusedProjectName !== null && ` · ${focusedProjectName}`}
          </span>
          {view.type === 'fleet' && focusObject === null && attentionProject !== null && (
            <span
              className="font-medium text-amber-700 dark:text-amber-300"
              data-testid="cockpit-fleet-attention"
            >
              {t('cockpit.fleetNeedsYou', { name: attentionProject.name })}
            </span>
          )}
          {focusObject !== null && focusedProjectName !== null && view.type !== 'fleet' && (
            <span data-testid="cockpit-focus-name">
              {focusedHumanLabel} · {focusedProjectName}
            </span>
          )}
          {/*
            ONE line per non-ok locator state. `missing` is already stated once by the stage's
            fleet notice (「找不到 quay-fleet」); `incompatible` and `no-handshake` are different
            facts the stage's missing-CLI sentence would misreport, so they get their own line
            here. This is intentionally English-only, like the Quay panel's own status lines.
          */}
          {fleet.status === 'loaded'
            && (fleet.fleetState === 'incompatible' || fleet.fleetState === 'no-handshake') && (
            <span
              className={fleet.fleetState === 'incompatible'
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-muted-foreground'}
              data-testid="cockpit-fleet-state"
              data-fleet-state={fleet.fleetState}
            >
              {fleet.fleetState === 'incompatible'
                ? `quay-fleet${fleet.fleetBinPath === null ? '' : ` at ${fleet.fleetBinPath}`} speaks an incompatible contract — ${fleet.fleetReason ?? 'no reason reported'}`
                : `quay-fleet${fleet.fleetBinPath === null ? '' : ` at ${fleet.fleetBinPath}`} did not complete the version handshake${fleet.fleetVersion === null ? '' : ` (v${fleet.fleetVersion})`} — continuing as compatible`}
            </span>
          )}
          {debug && (
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="cockpit-debug">
              <span data-testid="cockpit-view-uri" data-cockpit-view-uri={viewUri ?? undefined}>
                {viewUri ?? ''}
              </span>
              <span data-testid="cockpit-focus-uri" data-cockpit-focus={focusObject?.uri ?? undefined}>
                {focusObject?.uri ?? ''}
              </span>
              {lastTiming !== null && (
                <span data-testid="cockpit-timing">
                  {t('cockpit.timingLast', { ms: Math.round(lastTiming.ms) })}
                </span>
              )}
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
            </span>
          )}
        </div>

        {/* Every input gets an echo; done/refused fade after a few seconds, confirmation waits.
            THE ECHO IS AN OVERLAY, NOT A FOOTER ROW: an in-flow banner grew the footer, shrank
            the stage and clipped its last line on every submit. Anchored to the footer's top
            edge, it draws over the stage without changing either one's size. */}
        {echo !== null && (
          <div
            role="status"
            className={
              echo.kind === 'refused'
                ? 'cockpit-echo-overlay absolute bottom-full left-0 right-0 z-10 mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 shadow-sm dark:text-amber-200'
                : 'cockpit-echo-overlay absolute bottom-full left-0 right-0 z-10 mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-border/60 bg-muted px-2 py-1 text-xs text-foreground shadow-sm'
            }
            data-testid="cockpit-echo"
            data-echo-kind={echo.kind}
          >
            <span data-testid="cockpit-echo-text">
              {echo.kind === 'refused' ? '⚠ ' : echo.kind === 'confirm' ? '? ' : '✓ '}
              {echo.text}
            </span>
            {echo.reason !== undefined && echo.reason !== '' && (
              <span data-testid="cockpit-echo-reason">{echo.reason}</span>
            )}
            {echo.next !== undefined && echo.next !== '' && (
              <span data-testid="cockpit-echo-next">{echo.next}</span>
            )}
          </div>
        )}

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
                session: pendingSessionLabel,
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
          textareaRef={intentInputRef}
        />
      </footer>
    </div>
  );
}
