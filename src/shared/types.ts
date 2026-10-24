import type { TFunction } from 'i18next';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { NavigateFunction } from 'react-router-dom';

import type { AsrCapabilities, AsrRuntimeStatus } from '@shared/asr/asrRegistry';

//----------------- LLM PROVIDER MODEL CATALOG ------------

/** Identifies which coding-agent CLI backs a session, project selection or model list. */
export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';

/** One selectable model in a provider's model menu, including its optional reasoning-effort choices. */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  recordId?: number;
  isCustom?: boolean;
  /** Env config of a custom model as the server returns it; secret rows carry only `isSet`, never a value. */
  config?: ProviderModelPublicConfig | null;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/** The full model catalog for one provider: every option plus the value used when the user has not chosen one. */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/** One env row a client submits for a custom model: `value` a literal, `secret` a write-only literal (omit `value` to keep the stored one), `envref` the name of a server env variable in `value`, `unset` removes the variable. */
export type ProviderModelEnvRowInput = {
  key: string;
  kind: 'value' | 'secret' | 'envref' | 'unset';
  value?: string;
};

/** One env row of a custom model as read back from the server; a secret row has `isSet` and never a value. */
export type ProviderModelPublicEnvRow =
  | { key: string; kind: 'value' | 'envref'; value?: string }
  | { key: string; kind: 'secret'; isSet: true }
  | { key: string; kind: 'unset' };

/** The env config of a custom model as read back from the server, listing its rows in order. */
export type ProviderModelPublicConfig = {
  env: ProviderModelPublicEnvRow[];
};

/** Which server-process env variables are set, keyed by variable name; carries booleans only so the UI can show envref rows as set or unset. */
export type ModelEnvStatus = Record<string, boolean>;

/** User-supplied fields for creating or editing a custom provider model entry; omit `config` to leave the stored env config untouched. */
export type CustomProviderModelInput = {
  model: string;
  id: string;
  config?: { env: ProviderModelEnvRowInput[] } | null;
};

/** Mutation callbacks a model menu calls to persist custom provider models. */
export type ProviderModelActions = {
  create(provider: LLMProvider, input: CustomProviderModelInput): Promise<void>;
  /**
   * Copies `existing` into a new model. The copy is server-side on purpose: a
   * secret value never leaves the server, so only the stored row can hand it on.
   */
  duplicate(
    provider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ): Promise<void>;
  update(
    provider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ): Promise<void>;
  remove(provider: LLMProvider, existing: ProviderModelOption): Promise<void>;
};

// ---------------------------

//----------------- PROJECTS AND SESSIONS ------------

/** Identifies the workspace pane the user is looking at; plugin panes are namespaced by plugin id. */
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'quay' | 'architecture' | 'browser' | `plugin:${string}`;

/** A message queued to be sent to a session at a future time. */
export type ScheduledMessage = {
  id: string;
  sessionId: string;
  content: string;
  options: Record<string, unknown>;
  /** ISO instant, so the schedule does not move when the user changes time zone. */
  scheduledFor: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  /** Why it did not go, when `status` is `failed`. */
  failureReason: string | null;
  createdAt: string;
};

/** A single conversation inside a project, as returned by the sessions API and rendered in the sidebar and chat. */
export type ProjectSession = {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  // App id of the session this one was branched from, or null/absent when it
  // started on its own. The sidebar keeps a fork beside its source and renders a
  // branch marker from it, so a fork is never mistaken for a duplicate row.
  forkedFromSessionId?: string | null;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
};

/** Pagination metadata returned alongside a project's session page. */
type ProjectSessionMeta = {
  total?: number;
  hasMore?: boolean;
  /** Sessions hidden by the project's name filter; the sidebar's "hidden N" bar renders only when this is above zero. */
  hiddenCount?: number;
  [key: string]: unknown;
};

/** Task Master provisioning state for a project, used to decide whether the tasks tab is available. */
type ProjectTaskmasterInfo = {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

//----------------- QUAY STATUS ------------

/**
 * Quay driver reading. `not-configured` means the project has no `.quay/config.yml`
 * at all; `unavailable` means it has one but its driver command did not answer, so
 * the state is *unknown* rather than absent — rendering the two the same would
 * claim a configured project is unconfigured.
 */
export type QuayDriverState = 'running' | 'idle' | 'stale' | 'not-configured' | 'unavailable';

/** Driver summary attached to a Tier-2 quay snapshot and rendered by the panel header. */
export type QuayDriverSummary = {
  state: QuayDriverState;
  alive: boolean;
  running: boolean;
  lastRecordAt: string | null;
};

/** One row of the panel's per-entity detail list; only the fields the panel renders. */
export type QuayListItem = {
  id: string;
  title: string;
  status: string;
  /**
   * The row's last-updated instant as ISO-8601, or `null` when quay reported no
   * usable timestamp for it. Every one of these lists is ranked by this value, so
   * the rows render it — the ordering key would otherwise be invisible. `null`
   * renders as the em-dash placeholder, never as `never`.
   */
  updatedAt: string | null;
};

/** Task counts read from `quay task list --json`; the panel shows the status breakdown. */
export type QuayTaskCounts = {
  total: number;
  byStatus: Record<string, number>;
  ready: number;
  needsHuman: number;
  done: number;
  /** Up to ten tasks, most recently updated first, rendered as the "Recent tasks" list. */
  recent: QuayListItem[];
};

/** Goal counts read from `quay goal list --json`; the panel shows the status breakdown and recent goals. */
export type QuayGoalCounts = {
  total: number;
  achieved: number;
  /** Per-status grouping plus the most recently updated goals, for the "Stage goals" card. */
  breakdown: QuayGoalBreakdown;
};

/** Stage-goals card payload: goal counts per status, plus the recent goals as display rows. */
export type QuayGoalBreakdown = {
  /** Counts keyed by the CLI's own status string (`active`/`achieved`/`draft`/`superseded`/…). */
  byStatus: Record<string, number>;
  /** Up to ten goals, most recently updated first. */
  recent: QuayListItem[];
};

/** ADR counts read from `quay adr list --json`; `recent` feeds the "ADRs" list. */
export type QuayAdrCounts = {
  total: number;
  /** Up to ten ADRs, most recently updated first. Empty when quay reports none. */
  recent: QuayListItem[];
};

/** Issue counts read from `quay config validate --json`. */
export type QuayConfigIssueCounts = {
  total: number;
  errors: number;
};

/** Current full-suite reading from `.quay/full-suite-state.json`; `null` means no run state is on disk. */
export type QuaySuiteState = {
  state: string;
  runner: string | null;
  scope: string | null;
  /** ISO timestamp the run started, as the carrier file stores it. */
  startedAt: string | null;
  /** Unix epoch **seconds** the run finished, as the carrier file stores it. */
  finishedAt: number | null;
  durationMs: number | null;
  laneCount: number | null;
  commit: string | null;
  taskId: string | null;
  runId: string | null;
};

/** One history round from `.quay/verification-round.jsonl`; the heavy per-file detail is dropped. */
export type QuayTestRoundSummary = {
  round: number;
  startedAt: string | null;
  durationMs: number | null;
  pass: number | null;
  fail: number | null;
  tests: number | null;
  state: string;
};

/** Tests card payload: the current run (if any) plus the most recent history rounds. */
export type QuayTestsSummary = {
  current: QuaySuiteState | null;
  recentRounds: QuayTestRoundSummary[];
};

/** One fan-in attempt from `.quay/worker-outcome.jsonl`. */
export type QuayFanInAttemptSummary = {
  task: string;
  outcome: string;
  /** Lock acquisition as Unix epoch **seconds** (quay's own unit); the panel converts to ms. */
  lockAcquireEpoch: number | null;
  /** Lock release as Unix epoch **seconds**; `null` when the attempt never released the lock. */
  lockReleaseEpoch: number | null;
};

/** Fan-in card payload: the most recent mechanical fan-in attempts across all tasks. */
export type QuayFanInSummary = {
  recent: QuayFanInAttemptSummary[];
};

/**
 * One live obstruction as the pulse strip's blocked row draws it, read from the task store.
 *
 * The group is keyed by the NORMALISED failure signature (digits replaced with `#`), never by
 * task id: two tasks red at the same step are one obstruction with `occurrences` entries. `since`
 * is the earliest occurrence, so retrying a task extends the segment instead of resetting the
 * clock. `dependents` is the impact reading — the unfinished tasks whose `depends_on` names a
 * member of the group — which is what the `⛔ N` end label counts.
 */
export type QuayBlockerSummary = {
  /** Representative task id (the earliest occurrence), used by the tooltip and the focus action. */
  taskId: string;
  /** When the obstruction began, ISO-8601. */
  since: string;
  /** The normalised failure signature the group is keyed by. */
  signature: string;
  /** How many tasks currently carry this signature. */
  occurrences: number;
  /** Unfinished tasks waiting on a member of the group, sorted and unique. */
  dependents: string[];
};

/**
 * The compact per-project reading behind one `PulseStrip`.
 *
 * Assembled server-side from the SAME sources the Quay panel's cards read (the `lanes` document
 * for in-flight state, the `.quay/` carriers for fan-in/test history, the task store for
 * blockers), so the strip's counts and the cards cannot disagree. It is deliberately a separate
 * bundle from `QuaySnapshot`: the cockpit draws one strip per fleet tile and must not pay for the
 * goals, ADRs, config and dashboard reads a full snapshot performs.
 *
 * `inFlight: null` / `blockers: null` mean the source could not be read, never "nothing there".
 * A read source that is merely quiet yields `[]`.
 */
export type QuayPulseSummary = {
  /** The instant this reading was taken, ISO-8601 — the strip's `now`. */
  generatedAt: string;
  inFlight: QuayInFlightTask[] | null;
  /** In-flight lane reading; only its live intervals are plotted, so a null is tolerable. */
  gantt: QuayGanttLanes | null;
  tests: QuayTestsSummary;
  fanIn: QuayFanInSummary;
  blockers: QuayBlockerSummary[] | null;
};

/**
 * One of quay's published in-flight phases — the values its `dashboard-kernel` marks a live
 * interval with. Re-declared (not imported from the plugin) for the same reason as the Loops
 * pulse types below: the plugin is an external, per-project artifact resolved at runtime, so
 * this set is the contract.
 */
export type QuayInFlightPhase = 'implementing' | 'fan-in' | 'awaiting-land' | 'landed';

/**
 * One task a project's quay worker reports as being in flight right now, as the Loop
 * pulse gantt plots it. Projected by the backend
 * (`server/modules/quay/quay.service.ts`) and already present in the
 * `GET /:projectId/snapshot` response body; `QuayPanel`'s "In flight" card is the
 * consumer. Field names and units mirror the backend `QuayInFlightTask` verbatim.
 *
 * The task set and each row's `phase` come from the SAME `lanes` reading the Loop
 * pulse gantt is built from — quay's `readLive`, which drops already-landed tasks — so
 * the card can never disagree with the gantt about which tasks are running. The round
 * carrier only supplies the supplementary fields (`startedAt`, `lastHeartbeat`,
 * `workerPid`).
 */
export type QuayInFlightTask = {
  taskId: string;
  /** quay's published in-flight phase for the task's interval. */
  phase: QuayInFlightPhase;
  /** The task's dispatch instant (ISO), or `null` when the round record carries none. */
  startedAt: string | null;
  /** The instant the reading was written (ISO) — the round heartbeat, or the lane clock's read instant. */
  lastHeartbeat: string;
  /** The worker-driver loop's process id, or `null` when the record carries none. */
  workerPid: number | null;
};

/**
 * One merged in-flight-or-historical run interval for the Loop pulse gantt.
 *
 * Field-for-field the shape quay's own `quay/dashboard-kernel` publishes as
 * `LiveGanttInterval`, as relayed inside the `quay lanes --json` document — the packed
 * lanes below are computed by quay (never re-derived here), so this type is a *contract*
 * with that kernel rather than a local model.
 * `phase` (an in-flight run) and `finalState`/`fanInOutcome` (a finished one) are
 * mutually exclusive: exactly one side is non-null.
 */
export type QuayGanttInterval = {
  taskId: string;
  runId: string;
  /** Interval start, Unix epoch **milliseconds**. */
  startMs: number;
  /** Interval end, Unix epoch milliseconds; `now` for a run still in flight. */
  endMs: number;
  /** One of quay's published in-flight phases, or `null` for a historical interval. */
  phase: string | null;
  /** One of quay's published terminal states, or `null` for an in-flight interval. */
  finalState: string | null;
  /** The mechanical fan-in outcome, when the historical record carried one. */
  fanInOutcome: string | null;
};

/**
 * Loop pulse card payload: the document `quay lanes --json` prints for one time window
 * (quay's own `packLanes` output, plus the window and clock it was read at).
 *
 * `lanes` is indexed by lane (at most `FIXED_GANTT_LANES` = 5 of them) and each lane
 * holds its intervals in start order. `overflow` is the count of intervals that had no
 * free lane — quay deliberately does not drop them, so `lanes` alone does NOT account
 * for every interval whenever `overflow > 0`; a renderer must surface that count or it
 * silently loses data.
 */
export type QuayGanttLanes = {
  /** The window the intervals were filtered to, in hours (quay's own 1/3/6/12). */
  windowHours: number;
  /** The `now` instant the intervals were merged against, Unix epoch milliseconds. */
  nowMs: number;
  lanes: QuayGanttInterval[][];
  overflow: number;
};

/**
 * Why a Loop pulse lane reading is missing, when it is.
 *
 * The card must not collapse every missing reading into one sentence: "the installed plugin has
 * no `lanes` verb" is the normal state of an un-upgraded project, while "the verb ran and its
 * document could not be read" is a read failure. Those are different facts and the reader acts
 * differently on each — one calls for an upgrade, the other for a retry.
 */
export type QuayGanttUnavailableReason = 'plugin-lacks-lanes-verb' | 'lanes-read-failed';

/**
 * The one time window the Quay tab's three charts share, in Unix epoch milliseconds.
 *
 * Derived once by `QuayPanel` from the Loop pulse reading (`QuayGanttLanes.windowHours` and
 * `nowMs`) and handed to the gantt, the Tests bar and the Fan-in bar, so no chart adapts a
 * window to whatever records it happens to hold. `endMs` is the `now` instant the charts mark:
 * the window is always `[now - windowHours, now]`. Both consumers (`QuayPanel` passes it,
 * `TimelineBar` maps time through it) read the same declaration, so they cannot disagree about
 * what "the window" is.
 */
export type QuayTimelineWindow = {
  /** Left edge of the window, Unix epoch milliseconds. */
  startMs: number;
  /** Right edge of the window — the `now` instant the charts mark, Unix epoch milliseconds. */
  endMs: number;
};

/** Tier-2 read-only snapshot of one project's quay state, rendered by `QuayPanel`. */
export type QuaySnapshot = {
  projectId: string;
  projectPath: string;
  /**
   * The project's quay-fleet registry id, read from the fleet registry by matching the project
   * root. It is the ONLY project segment a `quay://` reference may carry, because the fleet
   * dereferences references by its own registry id and a CloudCLI UUID reads `unknown-project`
   * there. `null` means the root is not registered with quay-fleet: the panel then declares no
   * addressable objects and says so, rather than minting a UUID reference. Absent is the same
   * reading as `null` (a snapshot from an older backend).
   */
  fleetProjectId?: string | null;
  generatedAt: string;
  /** True when the snapshot was served from the backend's TTL cache rather than a fresh CLI pass. */
  cached: boolean;
  driver: QuayDriverSummary | null;
  tasks: QuayTaskCounts | null;
  goals: QuayGoalCounts | null;
  adrs: QuayAdrCounts | null;
  configIssues: QuayConfigIssueCounts | null;
  /** Tests card: the current suite run plus recent history rounds, read from `.quay/` carrier files. */
  tests: QuayTestsSummary;
  /** Fan-in card: recent mechanical fan-in attempts, read from `.quay/worker-outcome.jsonl`. */
  fanIn: QuayFanInSummary;
  /**
   * Pulse strip's blocked row: the live obstructions in this project's task store, merged by
   * failure signature (see `QuayBlockerSummary`). OPTIONAL and nullable so an older backend /
   * cached snapshot reads as "not reported": absent or `null` is an unread store, `[]` is a read
   * store with nothing blocked — the two must never be collapsed.
   */
  blockers?: QuayBlockerSummary[] | null;
  /**
   * In-flight card: the tasks the worker currently has in flight, taken from the SAME
   * `lanes` reading the Loop pulse gantt is built from (`gantt` below) — so the card and
   * the gantt name the same set, and a landed task (which quay's `readLive` drops) never
   * appears here. `null` means there was no lane reading at all (no authoritative set to
   * name), `[]` means the reading was taken and nothing is running — the two must never
   * be collapsed into one another.
   */
  inFlight: QuayInFlightTask[] | null;
  /**
   * Loop pulse card: quay's own packed gantt lanes over one time window.
   *
   * Optional because the backend does not produce this reading yet — it requires a
   * published quay build that can supply packed lanes, which does not exist at the time
   * of writing. Present-and-`null` and absent are therefore the same to a caller:
   * "not reported". A reader must not treat either as "no intervals" — an unread lane
   * set and a genuinely idle window are different readings, and only the second means
   * nothing ran.
   */
  gantt?: QuayGanttLanes | null;
  /**
   * Why `gantt` is missing, when it is: the installed plugin has no `lanes` verb, or the verb
   * ran and its document was unreadable. `null` when `gantt` is present. Kept beside `gantt`
   * rather than folded into it so the card can state the *actual* reason instead of one
   * generic sentence — an un-upgraded plugin and a failed read are different facts.
   */
  ganttUnavailable?: QuayGanttUnavailableReason | null;
  /**
   * Link to quay's own `quay serve` dashboard when a live web service is
   * reported; `null` when no dashboard is running (a normal state, not an error).
   */
  dashboardUrl: string | null;
  /** Non-fatal per-command failures; the panel surfaces them instead of hiding a partial read. */
  warnings: string[];
  /**
   * The server's fleet CLI reading for this snapshot. Optional because an older backend does
   * not send it (and the cached Tier-2 path may predate the field); absent is "not reported",
   * never "the CLI is missing". The panel uses it to state ONE cause (missing / incompatible /
   * no-handshake) instead of repeating 「未登记」 per card.
   */
  fleet?: QuayFleetCliReading;
};

/** Tier-1 reading returned by `GET /api/quay/:projectId/status`. */
export type QuayProjectStatus = {
  projectId: string;
  projectPath: string;
  hasQuayConfig: boolean;
};

//----------------- QUAY WALL VIEW CONTRACT ------------

/**
 * The object kinds a `quay://` URI can address, per quay-fleet's contract #1
 * (`fleet-wall-object-uri-address-space`): a task, a goal, one ledger event, or the
 * project's board. CloudCLI renders and focuses these objects; it never invents a kind the
 * fleet side does not publish.
 */
export type QuayObjectKind = 'task' | 'goal' | 'ledger' | 'board';

/**
 * An L1 object reference in quay-fleet's three-level serialization. The address carries a
 * PROJECT SEGMENT: `quay://<project>/<kind>/<id>`, with an optional `#ac-<n>` fragment
 * naming one acceptance criterion of a task. The five forms are:
 *
 *   quay://<project>/task/<id>
 *   quay://<project>/task/<id>#ac-<n>
 *   quay://<project>/goal/<id>
 *   quay://<project>/ledger/<name>/<eventId>
 *   quay://<project>/board
 *
 * A URI without the project segment (`quay://task/<id>`) is NOT this grammar and is
 * rejected by `parseQuayUri`. The voice/input layer treats a reference as an opaque string:
 * parsing belongs to `src/modules/quay/quayUri.ts`, so a reference crosses a process
 * boundary unchanged.
 */
export type QuayObjectUri = `quay://${string}`;

/**
 * Where one visible object sits in the declaring tile's own flow, both axes 1-based and
 * counted from the TOP-LEFT (`{row: 1, column: 1}`). A vertical list tile puts every row in
 * column 1; a grid tile may use both.
 *
 * Position is a display attribute because 「左上那个」 must resolve against where the
 * object was drawn, not against the order the data happened to arrive in.
 */
export type QuayObjectPos = {
  /** 1-based row, counting from the top. */
  row: number;
  /** 1-based column, counting from the left. */
  column: number;
};

/**
 * The display attributes of a visible object: the half a spoken referent resolves against
 * without reading the object itself (「红的那个」 → `color`, 「第二个」 → `ordinal`,
 * 「②」 → `label`, 「左上那个」 → `pos`).
 *
 * `color` is the bucket a person would actually say out loud, derived by the renderer from
 * `status`; `status` is kept verbatim beside it so a reader can tell which status the colour
 * stands for. A resolver matching a spoken phrase therefore never has to know the
 * renderer's CSS classes.
 */
export type QuayObjectDisplay = {
  /** The object's lifecycle status (or in-flight phase), verbatim from quay. */
  status: string;
  /** Human-language colour bucket derived from `status` (`red`/`green`/`amber`/`blue`/`gray`). */
  color: string;
  /** 1-based position in the view's spatial order; the short label `②` carries the same number. */
  ordinal: number;
  /** Where the object sits in the declaring tile's flow (top-left origin). */
  pos: QuayObjectPos;
};

/**
 * One focusable child of a rendered view, exactly the triple the view contract publishes:
 * the `quay://` reference, the short spoken label (circled ordinal ①②③…), and the display
 * attributes a spoken referent resolves against.
 *
 * It deliberately carries NO title, body or other object content: the reference is the
 * payload, and content is read back by URI downstream (「送引用不送内容」).
 */
export type QuayFocusableObject = {
  /** The L1 reference the input pack carries instead of the object's content. */
  uri: QuayObjectUri;
  /** The short spoken label — a circled ordinal (`①`, `②`, …) matching `display.ordinal`. */
  label: string;
  /** Status/colour/ordinal/position, so 「红的那个 / 第二个 / ② / 左上那个」 resolve without content. */
  display: QuayObjectDisplay;
};

/**
 * What a rendered view publishes so focus and voice input can address it: the focusable
 * children, in spatial (reading) order. `QuayPanel` declares one for its In-flight tile;
 * the voice input pack carries the same objects as references.
 *
 * Zooming into a focusable object replaces this contract with that object's own sub-view;
 * zooming back out returns the parent contract. CloudCLI ships the declaration side first —
 * the zoom navigation itself is the wall's later work.
 */
export type QuayViewContract = {
  /** Focusable children, first-drawn first — the ordinal each item displays is its index + 1. */
  focusables: QuayFocusableObject[];
};

// ---------------------------

//----------------- QUAY FLEET SUMMARY ------------

/**
 * One project's task status counts from `GET /api/quay/fleet-summary`; the sidebar's
 * project row renders the todo / ready / needs-human numbers as its task badge.
 */
export type QuayFleetTaskCounts = {
  /** Every task the store reports, including statuses the badge has no bucket for. */
  total: number;
  todo: number;
  ready: number;
  needsHuman: number;
  done: number;
};

/** One quay project's entry in the eager cross-project fleet summary. */
export type QuayFleetProjectSummary = {
  projectId: string;
  projectPath: string;
  /**
   * The project's quay-fleet registry id — the `quay://` project segment. `null` (or absent)
   * means its root is not registered with quay-fleet, so the project declares no addressable
   * objects. Never fall back to `projectId`: a CloudCLI UUID is not a fleet handle.
   */
  fleetProjectId?: string | null;
  /** The worker driver reading; `unavailable` means the status command did not answer. */
  driver: { state: QuayDriverState };
  tasks: QuayFleetTaskCounts;
  /**
   * The compact pulse reading behind this tile's `PulseStrip`. OPTIONAL: an older server does
   * not send it, and the tile then says "not reported" rather than drawing an empty (idle) row.
   */
  pulse?: QuayPulseSummary | null;
  /** Whether this entry was served from the backend's per-project TTL cache. */
  cached: boolean;
  /** The backend's reason when this project's reading failed; `null` on success. */
  error: string | null;
};

/**
 * The contracts a `quay-fleet --version --json` handshake declares. The cockpit and the panel
 * compare them with what the server build supports; `version` below is informational only.
 */
export type QuayFleetContracts = {
  wallUri: string;
  registry: number;
  interfaceSession: string;
};

/**
 * How the server's CLI locator reads this host.
 *
 * `missing` and `incompatible` are hard failures (no handle may be minted); `no-handshake`
 * stays usable during the transition (an older fleet that does not answer `--version`).
 */
export type QuayFleetCliState = 'ok' | 'missing' | 'incompatible' | 'no-handshake';

/** The locator's complete reading, as `GET /api/quay/fleet-summary` and the snapshot carry it. */
export type QuayFleetCliReading = {
  available: boolean;
  state: QuayFleetCliState;
  /** The selected binary, or `null` when none of the three lookups found one. */
  binPath: string | null;
  /** The CLI's self-reported version, for display/logging only. */
  version: string | null;
  /** The contracts it declared, or `null` for `no-handshake`/`missing`. */
  contracts: QuayFleetContracts | null;
  /** One sentence naming the failure, `null` exactly when the state is `ok`. */
  reason: string | null;
};

/**
 * The eager cross-project reading behind the project-row task badges. It carries driver
 * state and task counts only: goals, in-flight tasks and the gantt stay on the lazy
 * Tier-2 snapshot that is read when a project is opened.
 */
export type QuayFleetSummary = {
  projects: QuayFleetProjectSummary[];
  /**
   * Whether the server could ask `quay-fleet` at all. `available: false` means the CLI was
   * missing or speaks an incompatible contract, so EVERY project's `fleetProjectId` is null
   * for one reason the cockpit must state once ("set QUAY_FLEET_BIN") rather than per tile.
   * Absent when talking to a server that predates the reading; treat that as available.
   *
   * The locator fields are OPTIONAL for that same backward compatibility: an older server
   * sends only `{available, reason}`, and a reader must not infer a state it was not given.
   */
  fleet?: {
    available: boolean;
    reason: string | null;
    state?: QuayFleetCliState;
    binPath?: string | null;
    version?: string | null;
    contracts?: QuayFleetContracts | null;
  };
  generatedAt: string;
  ttlPerProjectMs: number;
  /** `true` only when every project in the response came from the TTL cache. */
  cached: boolean;
};

// ---------------------------

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
/** A workspace project as the UI knows it: identity, path, star state and its loaded sessions. */
export type Project = {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  /** Per-project rules (regex sources, case-insensitive, unanchored) that hide sessions by name; null/absent means none. */
  sessionFilter?: { hide: string[] } | null;
  taskmaster?: ProjectTaskmasterInfo;
  /** Tier-1 quay reading attached by the projects listing; drives the sidebar badge and the Quay tab. */
  hasQuayConfig?: boolean;
  /**
   * Tier-1 architecture reading attached by the projects listing (ADR-005
   * decision 1): whether the project carries `.archguard/query/manifest.json`.
   * It gates the architecture tab; absent on realtime snapshots that predate it,
   * exactly like {@link hasQuayConfig}.
   */
  hasArchguardCache?: boolean;
  [key: string]: unknown;
};

/**
 * A project's session-name filter, as a value: true when a session must stay out
 * of the project's visible list, false when it belongs there.
 *
 * It is declared here, in shared, rather than beside its implementation in
 * `project-workspace` because its second consumer is `sidebar`, which may not
 * import project-workspace: project-workspace already imports the sidebar's
 * stored-preference helpers, so the reverse import would close a cycle the
 * module-boundaries lint rejects. Instead `useProjectsState` (which owns the
 * rule runtime) passes the predicate down through the sidebar's props, and the
 * sidebar applies it to its own state — same rules, one implementation, no edge
 * between the two modules beyond the one that already exists.
 *
 * `keepSessionIds` and `isShowingHidden` are the two exemptions the Projects
 * list applies. The Conversations feed passes an empty set and `false`: the
 * reload it has to match (`GET /api/providers/sessions/recent`) applies no
 * exemption at all, and a live view that kept a row the reload drops is exactly
 * the bug this predicate is threaded for.
 */
export type SessionHiddenByProjectFilter = (
  project: Project,
  session: ProjectSession,
  keepSessionIds: ReadonlySet<string>,
  isShowingHidden: boolean,
) => boolean;

/** Progress payload streamed while the backend enumerates projects, used to drive the sidebar loading bar. */
export type LoadingProgress = {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
};

// ---------------------------

//----------------- RELEASES ------------

/** The latest GitHub release for the app, rendered by the update prompt and the About tab. */
export type ReleaseInfo = {
  title: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
};

/** How this CloudCLI install was obtained; decides whether the UI offers a self-update action. */
export type InstallMode = 'git' | 'npm';

// ---------------------------

//----------------- SESSION PROCESSING STATE ------------

/** What a session that is currently producing a response is doing, as shown by the activity indicator. */
export type SessionActivity = {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
  /**
   * The phase the server's activity snapshot last reported for this session's
   * turn, or absent when no snapshot has named one yet.
   *
   * The value is a passthrough of the server's own reduction — the same one the
   * chat activity dock draws — never a phase the client derives. Sidebar rows
   * render it so a running session says what it is doing without being opened.
   */
  phase?: ActivityPhase;
  /** The pending tool's name while `phase` is `tool`; null or absent otherwise. */
  toolName?: string | null;
};

/** Every session currently producing a response, keyed by session id. Read it to tell whether a session is busy. */
export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

/** Marks a session as producing a response; call it as soon as a send is dispatched so the UI reacts immediately. */
export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
) => void;

/** Marks a session as finished; `ifStartedBefore` lets a late acknowledgement clear only a stale run. */
export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

/** Replaces the whole processing map with the server's view, used by the periodic running-sessions poll. */
export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

/** Reports whether one session is currently producing a response. */
export type IsSessionProcessing = (sessionId?: string | null) => boolean;

/** One running session as reported by the server, before it is folded into the client-side activity map. */
export type SessionActivitySnapshot = {
  sessionId: string;
  statusText?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
};

/**
 * The liveness channel the activity dock reads: the app socket's frames plus
 * its own connection flag.
 *
 * Deliberately transport-shaped rather than a socket: production supplies the
 * `WebSocketContext` value, while a unit test can hand the dock an in-memory
 * source and drive every migration without a real network. `isConnected` is the
 * socket's own reading, not proof of a server — only a frame is.
 */
export type ActivityConnection = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isConnected: boolean;
};

/**
 * Which surface the activity dock is showing, as published on
 * `[data-activity-dock]`'s `data-activity-state`.
 *
 * `hidden` means the dock is not drawn at all; `in-turn` means fresh evidence of
 * a running turn; `unreachable` means the client has a turn to talk about but no
 * fresh evidence the server is still there; `send-failed` means a send was never
 * taken — the socket was gone or no answer came inside the deadline — so there
 * is deliberately no turn to speak about, only the failure to report.
 */
export type ActivityDockState = 'hidden' | 'in-turn' | 'unreachable' | 'send-failed' | 'background';

/**
 * What a running turn is doing, as the server's own frame reduction reports it.
 *
 * Each member names the *signal* that produced it — a thinking-token estimate, an
 * in-flight text delta, an outstanding tool call — so the dock can say what is
 * happening from evidence rather than from a local clock. It mirrors the
 * server-side `TurnPhase` one for one; the client never derives a phase of its
 * own. `idle` is the absence of a turn.
 */
export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'awaitingPermission'
  | 'compacting';

//----------------- BACKGROUND WORK (TASKS / SCHEDULES) ------------

/** The kind of work a background task represents, mirroring the server's `TaskKind`. */
export type ActivityTaskKind = 'subagent' | 'shell' | 'monitor' | 'workflow' | 'other';

/**
 * A background task's lifecycle state, mirroring the server's `TaskState`.
 *
 * `stopped` is not `failed`: it is a task ended by a stop, and `ended` is one the
 * Stop hook stopped naming with no stated cause. Both are terminal.
 */
export type ActivityTaskState = 'running' | 'blocked' | 'completed' | 'failed' | 'stopped' | 'ended';

/**
 * One row of a session's task table, as the activity snapshot carries it.
 *
 * The shape is the server's `ActivityTask` (AC-191) transported verbatim; the
 * client renders it and never derives a state of its own. Optional fields are
 * absent (not `undefined`-valued) when the frames never supplied them.
 */
export type ActivityTaskView = {
  taskId: string;
  kind: ActivityTaskKind;
  state: ActivityTaskState;
  /** The `tool_use` block that launched this task, for joining a transcript card. */
  toolUseId?: string;
  parentTaskId?: string;
  isBackgrounded: boolean;
  workflowName?: string;
  /** The latest progress description — a workflow's current step label. */
  stepLabel?: string;
  description: string;
  summary?: string;
  endReason?: 'unknown';
  origin: 'sdk-event' | 'stop-hook-snapshot';
  startedAt?: number;
  endedAt?: number;
};

/** One row of a session's schedule table, as the activity snapshot carries it. */
export type ActivityScheduleView = {
  scheduleId: string;
  kind: 'cron' | 'wakeup';
  /** The cron expression (authoritative) or the CLI's human description (provisional). */
  spec: string;
  recurring: boolean;
  prompt?: string;
  /** The next fire instant, minute-granular epoch ms; absent when unevaluable. */
  nextFireAt?: number;
  expiresAt?: number;
  source: 'tool-call' | 'stop-hook';
  toolUseId?: string;
};

/**
 * Who asked for a delivery, as the activity snapshot states it.
 *
 * The same vocabulary the run records use, carried verbatim: a client draws a
 * row from this, it does not classify one.
 *
 * `voice` is the Live Voice relay's own origin, and it is the one member a
 * client treats differently: a spoken sentence is not a command the person can
 * edit or withdraw, so its delivery must not be drawn as a pending command row
 * (see `deliveryRowsFromSnapshot` in `useSessionStore`). It is kept in the same
 * union — rather than a boolean beside it — because the snapshot documents ONE
 * origin vocabulary, and a second field would let the two disagree.
 */
export type ActivityDeliverySource = 'user' | 'scheduled' | 'unattended' | 'mcp' | 'voice';

/** The CLI queue tier a delivery's write was made under, or `null` for a write with no queue to be behind. */
export type ActivityDeliveryPriority = 'now' | 'next' | 'later';

/**
 * One accepted delivery, as a session's activity snapshot carries it (SPEC §7.1).
 *
 * This is the status projection of one accepted send — what a client needs to
 * draw a pending row and settle it without replaying a run stream and without
 * being attached to the run that happened to write the frames. It mirrors the
 * server's `DeliveryEntry` field for field, and it is deliberately not the
 * driver's ledger record: that is the process's own account (frames written,
 * leases held, rungs owed) and lives across the module edge.
 *
 * `deliveryId` is the row's identity and nothing else is: a client that keyed
 * its rows by the run or the turn the delivery belongs to would draw one row for
 * every command a turn carried, and would lose the one-to-one between a
 * withdrawal and the row it takes back. Two field-presence rules are load
 * bearing, and both are stated as values rather than as absent keys so an
 * entry's shape never depends on its state: `reason` is `null` unless the
 * delivery was cancelled, and `text` is `null` once the delivery reaches a
 * terminal (the words of a finished message are the transcript's).
 */
export type DeliveryView = {
  /** The delivery's identity: the host's own `commandUuid`, echoed back by the CLI. */
  deliveryId: string;
  state: CommandLifecycleState;
  source: ActivityDeliverySource;
  priority: ActivityDeliveryPriority | null;
  /** When the send was accepted, by the host's clock at the write. */
  enqueuedAt: number;
  /** When the CLI said it started running this command, or `null`. */
  startedAt: number | null;
  /** When the CLI stated the command's terminal, or `null` while it is live. */
  endedAt: number | null;
  /** The turn this command was bound to, or `null` while it is bound to none. */
  turnId: string | null;
  /** Why a cancelled delivery was cancelled; `null` for a live or cleanly completed one. */
  reason: string | null;
  /** The command's own words while the delivery is live, bounded; `null` once it ends. */
  text: string | null;
};

/**
 * A whole activity snapshot as it arrives over the socket: the store's
 * `activity.snapshot` (sent to a joiner before any change) or an
 * `activity.upsert` (the whole thing again, on every revision). Both carry the
 * same fields — the client replaces its picture rather than applying a delta.
 */
export type ActivitySnapshotFrame = {
  kind: 'activity.snapshot' | 'activity.upsert';
  sessionId: string;
  bootId: string;
  rev: number;
  asOf: number;
  /** The server's turn projection; the dock reads its phase through the heartbeat. */
  turn: unknown;
  tasks: ActivityTaskView[];
  schedules: ActivityScheduleView[];
  /**
   * The session's accepted deliveries in send order — what is still queued or
   * running, plus everything that ended inside the server's retention window.
   * This is the channel a pending row is drawn from and settled by, so a client
   * that reconnects reads the current queue from the snapshot it is handed
   * rather than from anyone replaying a run stream at it.
   *
   * Optional in the type, and only there: every snapshot the server builds
   * carries it, but a frame written before this channel existed, or a hand-built
   * one, is still well formed without it. Read `frame.deliveries ?? []`.
   */
  deliveries?: DeliveryView[];
};

// ---------------------------

//----------------- REALTIME TRANSPORT ------------

/**
 * The one frame a browser sends the chat websocket to say who it is.
 *
 * Sent once per connection — so also on every reconnect — and never again while
 * that socket lives: the server keeps the identity in memory and drops it when
 * the connection closes, so a reconnect has to re-announce rather than assume
 * the previous announcement survived.
 *
 * `deviceId` is this browser's stable identity and is what an MCP caller selects
 * a device by; `tabId` distinguishes the tabs of one browser; `deviceName` is
 * the human-readable name this device chose for itself. The connection's own
 * server-side id is deliberately absent — the caller addresses a device, never a
 * socket.
 */
export type UiHelloFrame = {
  type: 'ui.hello';
  deviceId: string;
  tabId: string;
  deviceName: string;
};

/**
 * The frame the server broadcasts when an MCP caller asks what the connected
 * browsers are showing.
 *
 * It carries a `requestId` and nothing else: the question is the same for every
 * tab, and the id is what the server matches an answer against. A tab that does
 * not answer is simply not reported — the request asks, it does not instruct.
 */
export type UiStateRequestFrame = {
  type: 'ui.state_request';
  requestId: string;
};

/**
 * The Git diffs this tab currently has expanded.
 *
 * Expanded is multi-valued — the Git panel keeps a Set of expanded files — so
 * the reading is a collection rather than "the one current diff". `null` means
 * the Git panel is not the active panel; `{ view, files: [], commits: [] }` is
 * the different fact "the Git panel is active but nothing is expanded".
 *
 * Paths and hashes are identifiers, not content: the diff BODY is deliberately
 * absent, exactly like a message id without its message.
 */
export type UiCurrentDiff = {
  /** The active Git sub-view: 'changes' | 'history' | 'branches' | 'worktrees'. */
  view: string;
  /** Workspace file paths expanded in the changes view. */
  files: string[];
  /** Commit hashes expanded in the history view. */
  commits: string[];
};

/**
 * The task this tab currently has focused, or null when none is.
 *
 * `source` is required: TaskMaster tasks (`tasks` panel) and quay tasks are two
 * different id namespaces, and an unlabelled id would read as the wrong one.
 * Only TaskMaster has a selection surface today, so `source` is always
 * `'taskmaster'`; the field exists so the ambiguity cannot recur silently.
 */
export type UiCurrentTask = {
  /** Which task system this id belongs to. */
  source: 'taskmaster';
  /** The task's id in its own namespace. */
  id: string;
  /** The task's title, or null when the surface carries none. */
  title: string | null;
};

/**
 * The text the user currently has selected in the transcript, already reduced.
 *
 * `truncated` records that the selection was longer than the cap and `text` is
 * its head, so a caller can tell a short selection from a clipped one. `region`
 * is always `'transcript'` and doubles as proof that the region check ran.
 */
export type UiSelectedTextReading = {
  text: string;
  truncated: boolean;
  region: 'transcript';
};

/**
 * What this tab reports about what it is showing, in answer to a
 * `ui.state_request`.
 *
 * Identifiers and ranges ONLY — message ids, counts, and the names of things.
 * A message body and a panel's content have no field here on purpose: the
 * server projects an answer down to exactly this shape, so a browser that sent
 * more would only be sending what nothing can read, and a caller that wants the
 * text behind a message id asks `session_read` for it. The one content-bearing
 * field, `selectedText`, is carried by the browser (it cannot know the caller's
 * token) but is delivered only through the separately-scoped `ui_selected_text`
 * tool — `ui_visible_context` never returns it.
 */
export type UiVisibleContextReport = {
  /** This browser's stable device id, the same value `ui.hello` announced. */
  deviceId: string;
  /** This tab's id, distinguishing the tabs of one browser. */
  tabId: string;
  /** The name this device chose for itself. */
  deviceName: string;
  /** This device's MCP navigation policy at the moment it answered. */
  navigationPolicy: string;
  /** Whether this page is in the foreground. */
  visibility: 'visible' | 'hidden';
  /** Whether this tab holds keyboard focus. */
  hasFocus: boolean;
  /** Epoch ms of the last moment this tab was focused; null when it never was. */
  lastFocusedAt: number | null;
  /**
   * The workspace panel this tab is showing: the active view's id, `null` when
   * this tab shows no workspace at all (so the question does not apply), or
   * `'unknown'` when a workspace is mounted but no view reports itself active.
   *
   * The two non-id values are deliberately different. A caller that sees `null`
   * learns there is no panel here; a caller that sees `'unknown'` learns the tab
   * does have a workspace and the reading failed — which is the case worth
   * acting on, and which a shared `null` used to hide.
   */
  panel: string | null;
  /** The project this tab has open, or null. */
  selectedProject: string | null;
  /** The session this tab has open, or null. */
  selectedSession: string | null;
  /** The first and last message ids currently visible in the transcript. */
  visibleMessages: { first: string | null; last: string | null };
  /** How many tool approvals are waiting for the user here. */
  pendingApprovals: number;
  /** How many of this tab's messages are still waiting in the send queue. */
  queuedMessages: number;
  /** The Git diffs expanded here, or null when the Git panel is not active. */
  currentDiff: UiCurrentDiff | null;
  /** The TaskMaster task focused here, or null. */
  currentTask: UiCurrentTask | null;
  /** The transcript selection here, or null; content is delivered only to a scoped caller. */
  selectedText: UiSelectedTextReading | null;
};

/**
 * The reply to a `ui.state_request`: the request's own id, echoed verbatim so
 * the server can match it, plus this tab's reading of what it is showing.
 */
export type UiStateResponseFrame = {
  type: 'ui.state_response';
  requestId: string;
} & UiVisibleContextReport;

//----------------- MCP-DRIVEN UI NAVIGATION ------------

/**
 * Where an incoming navigation request wants the target browser positioned.
 *
 * Five placements are supported, in two families:
 *
 *  - IN THE TRANSCRIPT — `{ latest: true }` pins the newest turns, `{ messageId }`
 *    centres one message, and `{ turnId }` centres one turn (addressed by the
 *    turn's `messageAnchorId`). A request that carries none of these is treated as
 *    `{ latest: true }`, so the common case needs no field at all.
 *  - ON ANOTHER SURFACE — `{ diffFile }` expands a file's diff in the Git panel and
 *    `{ taskId }` opens a task's detail. These do not move inside the transcript;
 *    the browser hands them to the surface that owns the target.
 */
export type UiNavigateTarget =
  | { latest: true }
  | { messageId: string }
  | { turnId: string }
  | { diffFile: string }
  | { taskId: string };

/**
 * A placement that changes a surface OTHER than the transcript, handed to the
 * host that owns it.
 *
 * The two transcript placements are the chat module's own business (`locateMessage`
 * / `scrollToLatest`), but the Git panel and the task-master panel live in sibling
 * modules, so the chat hook cannot reach them directly: it reduces the frame's `at`
 * to this shape and calls the host's reveal entry, which owns the view state.
 */
export type UiNavigateReveal =
  | { kind: 'diff'; filePath: string }
  | { kind: 'task'; taskId: string };

/**
 * A request from an external MCP caller — relayed by the server — for this
 * device's browser to open a session and place the transcript inside it.
 *
 * `requester` names the calling client (shown in the confirmation prompt) and
 * `navigationId` correlates the reply frames with this request. The right to
 * act belongs to this device's own policy, which is why the frame asks rather
 * than instructs.
 */
export type UiNavigateFrame = {
  type: 'ui.navigate';
  navigationId: string;
  requester: string;
  sessionId: string;
  at?: UiNavigateTarget;
};

/** The three delivery states this browser can answer a `ui.navigate` with; the server waits only for this frame. */
export type UiNavigateAckStatus = 'shown' | 'applied' | 'declined';

/** The states a navigation can settle into *after* its acknowledgement, once the user has answered the prompt or the request has lapsed. */
export type UiNavigateResultStatus = 'applied' | 'declined' | 'ignored' | 'superseded' | 'expired';

/**
 * The acknowledgement this browser sends the server for a `ui.navigate`.
 *
 * It answers "what did this device do with the request" at the moment it is
 * received: `reject` policies answer `declined`, an accepted request answers
 * `applied`, and a prompt that was shown answers `shown`. `reason` carries the
 * policy decision or a partial-success cause (for example a message id that
 * could not be located) and is absent when the status alone says everything.
 */
export type UiNavigateAckFrame = {
  type: 'ui.navigate_ack';
  navigationId: string;
  status: UiNavigateAckStatus;
  reason?: string;
};

/**
 * The frame a navigation settles into when its outcome only becomes known after
 * the user answers the prompt (or never answers it): applied, declined, ignored,
 * superseded by a newer request, or expired.
 */
export type UiNavigateResultFrame = {
  type: 'ui.navigate_result';
  navigationId: string;
  status: UiNavigateResultStatus;
  reason?: string;
};

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `hosts_changed`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  /** Identity of the run `seq` belongs to; see `NormalizedMessage.runId`. */
  runId?: string;
  [key: string]: unknown;
};

/**
 * The `hosts_changed` invalidation frame, mirrored from the server's
 * `HostsChangedEvent`.
 *
 * It carries no listing — only the session-host manager's revision — because
 * `GET /api/session-hosts` stays the one place the snapshot is built. The
 * session-hosts store reads `rev` to tell a frame it has already applied from a
 * fresh one and then re-reads that endpoint, so the push and the REST read can
 * never disagree about the shape of a host.
 */
export type HostsChangedEvent = {
  kind: 'hosts_changed';
  /** The manager's listing revision; strictly increasing across one server run. */
  rev: number;
  timestamp: string;
};

/**
 * One session's `chat.subscribe` replay cursor: the run the client last saw
 * (`runId`) and the highest `seq` it observed for that run.
 *
 * `seq` is numbered per run by the server, so a cursor is only meaningful for
 * the run it was recorded against. `runId` is what distinguishes "my `lastSeq`
 * is still good for your current run" (send it back unchanged) from "my
 * `lastSeq` is from an earlier run and means nothing to you" (send the new
 * run's id, or reset to seq 0). `runId` is `null` when no run id has been seen
 * — a server that does not publish them — in which case `seq` keeps its old
 * only-increasing, per-session meaning.
 */
export type ChatReplayCursor = {
  runId: string | null;
  seq: number;
};

/**
 * The per-session replay cursors a chat view keeps, shared between the realtime
 * handler that records them and the `chat.subscribe` sites that read them.
 *
 * A value is either a `ChatReplayCursor` or a bare `seq` number: the bare
 * number is the seq-only cursor a server without run ids produces, and reads go
 * through `readReplayCursor` so callers never branch on the form.
 */
export type ChatReplayCursorMap = Map<string, ChatReplayCursor | number>;


// ---------------------------

//----------------- SHARED UI PRIMITIVES ------------

/** Progress state of a single queue row, driving the indicator the Queue primitive renders. */
export type QueueItemStatus = 'completed' | 'in_progress' | 'pending';

// ---------------------------

//----------------- AUTH ------------


// ---------------------------

//----------------- CHAT MESSAGES AND PERMISSIONS ------------

/** Permission preset a provider runs a turn under ('default', 'acceptEdits', 'auto', 'bypassPermissions' or 'plan'), chosen in the composer and sent with each message; the backend capability matrix decides which values a given provider accepts. */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

/** A non-image file attached to a chat message, described by its path in the server-managed attachment store plus display metadata so it can be listed and downloaded. */
export type ChatAttachment = {
  /** Absolute path inside the server-managed chat attachment store. */
  path?: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

/** A chat attachment that is an image, extending ChatAttachment with the inline base64 data URL that Claude history uses when no stored path is available. */
export type ChatImage = {
  /** Inline data URL (Claude history stores image attachments as base64). */
  data?: string;
} & ChatAttachment;

/** One stored memory an assistant reply drew on, naming the file and line range read plus what was taken from it, shown as a footnote under the reply so a memory-derived claim stays traceable. */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/** One entry in a subagent's recorded timeline, normalized by the backend from either provider's transcript; `kind` decides whether the tool fields or `content` carry the entry, so read only the set that matches. */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  content?: string;
};

/** Identity and lifecycle of one spawned subagent as the backend reports it; present on the tool call that spawned the agent and used to draw its container header. */
/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

export type SubagentInfo = {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  status: 'running' | 'completed' | 'failed';
  model?: string;
  /** Total entries the agent recorded, which exceeds the received timeline when a long run was truncated for transport. */
  activityCount?: number;
};

/**
 * The graded fate of one Live Voice relay segment, as the page records it (AC-367).
 *
 * The relay's segment ACK has four names, and only two of them are ever this row's business: the
 * segment is either UNCERTAIN or LOST. `written` is the uncertain one — the segment's audio and its
 * commit reached the upstream socket, which died before the endpoint answered, so the bridge may
 * still replay it and the words may yet be transcribed; calling that lost would accuse the endpoint
 * of dropping words that are still coming. `lost` is the terminal one, and its `reason` is the whole
 * difference to the person: `connection-closed` means the voice connection was not open, so the
 * frames never left the page, while `upstream-drop` means they were written and the bridge gave up
 * on ever learning the segment's words — the words never reached the model.
 *
 * The endpoint's own answers (`committed`, `dropped`) are NOT outcomes this row carries: a segment
 * the endpoint committed has its transcript path open, and a `dropped` segment is the transcript's
 * own not-recognised row (see `VoiceRealtimeSession.unrecognizedSeqs`).
 */
export type VoiceRealtimeSegmentOutcome =
  | { seq: number; state: 'written' }
  | { seq: number; state: 'lost'; reason: 'connection-closed' | 'upstream-drop' };

/** One rendered entry in a chat transcript — user turn, assistant turn, tool call and result, local command output, or subagent container — and the shape the chat message list and message components consume. */
export type ChatMessage = {
  type: string;
  content?: string;
  displayText?: string;
  timestamp: string | number | Date;
  /**
   * The session store's identity for the row behind this message, when the
   * message is one this client streamed. Unlike the rest of a streaming message
   * — its text and its timestamp are re-minted on every delta — this is stable
   * for the turn's whole life, including the finalize that settles it, so it is
   * what the transcript derives its React key from. A message without one has no
   * store row of its own and is keyed by its content instead.
   */
  id?: string;
  images?: ChatImage[];
  files?: ChatAttachment[];
  reasoning?: string;
  /**
   * The provider's identifier for the transcript row behind this message, when
   * the provider has stable per-row identity. Present on user turns from
   * Claude; it is the anchor "edit this message" and "fork from here" send back.
   */
  transcriptAnchorId?: string;
  /**
   * The store row's own id, set on the rendered message when that row came from
   * a read rather than from this client's stream.
   *
   * It is the value `session_read mode=around` resolves an id against, which is
   * what lets a rendered row be *named back to the server* — the address
   * `ui_visible_context` publishes and a jump lands on. It is deliberately not
   * the same field as {@link id}: that one is this client's own row id and is
   * left off a read row, because several providers re-mint their row ids on
   * every read and a React key has to survive that. Addressing has the opposite
   * requirement — it only has to survive one read — so the two are two fields.
   */
  transcriptRowId?: string;
  /**
   * The anchor a *fork* taken from this answer cuts at, when this message ends
   * a turn. Separate from `transcriptAnchorId` (which names a user input):
   * forking here yields a conversation whose last row is this reply. Absent on
   * the final turn while its session is running.
   */
  forkAnchorId?: string;
  /**
   * Identity of the stream block this message belongs to, carried onto the
   * rendered row so the transcript keys it by the block rather than by the row
   * id that changes when it settles.
   *
   * The store's stream id (`live:…`) is the client's own and the settled record
   * has the server's (`<uuid>_0`); a React key derived from either re-keys the
   * row on the frame it settles, which is an unmount on a pane pinned to the
   * bottom. Keying by the block keeps one node across streaming → settled →
   * persisted. See `getIntrinsicMessageKey`.
   */
  blockKey?: string;
  /**
   * Set on the optimistic echo of a message being sent as a replacement for an
   * already-sent one, naming the anchor it replaces. Local to this client.
   */
  replacesAnchorId?: string;
  /**
   * Set (client-side only) on a user message that was SPOKEN: Live Voice relayed the person's words as
   * this message. `heard` holds what the speech recogniser transcribed, which can differ from the
   * message (the relay fixes recognition slips).
   *
   * The pane no longer draws a mark for it: a spoken message is an ordinary message (operator's
   * ruling, 2026-10-14). The field stays where the row algebra still sets it — `placeCaptions.ts`'s
   * `voiceTranscriptRows` — which the lifecycle scenario lane reads.
   */
  voiceTranscript?: { heard: string[] };
  /**
   * Set (client-side only) on a row of its own — one per utterance the relay REFUSED because the
   * session's undelivered backlog was over its byte budget (AC6): the words are not being spoken,
   * not heard and not on their way.
   *
   * No longer rendered: the conversation carries the real messages only, and a refusal is reported
   * on the voice bar. The field stays where the row algebra still sets it.
   */
  voiceRowState?: 'undelivered';
  /**
   * Set (client-side only) on the synthetic row that stands where a Live Voice segment came back with
   * NO transcript (AC4): the relay accepted the audio, refused to commit a transcription of it, and
   * the person's words for that segment never existed. Holds the segment's own number, so the row
   * says WHICH of their sentences was lost rather than that something was. The row is a plain line
   * (`type: 'system'`), never a user bubble, so a silence is not counted as something they said.
   *
   * No longer rendered by the pane; the field stays where the row algebra still sets it.
   */
  voiceUnrecognizedSeq?: number;
  /**
   * Set (client-side only) on the synthetic row that stands where a Live Voice relay segment was
   * reported UNCERTAIN (`written`) or LOST (`lost`) by the graded segment ACK (AC-367): the segment
   * was written to an upstream socket that died before the endpoint answered it (uncertain — the
   * words may still be replayed), or it will never be transcribed at all (lost, with the reason).
   *
   * DISTINCT FROM {@link voiceUnrecognizedSeq} ON PURPOSE. That row means "the endpoint was given
   * this audio and produced no words"; this one means "the words never reached the model, or may
   * not have". Reading a lost segment as not-recognised would blame the endpoint's transcription for
   * a connection failure, and reading it as the person's own row would put words the model never
   * heard into the conversation. The row is a plain line (`type: 'system'`), never a user bubble, at
   * the segment's own spoken place.
   *
   * No longer rendered by the pane; the field stays where the row algebra still sets it.
   */
  voiceSegmentOutcome?: VoiceRealtimeSegmentOutcome;
  isThinking?: boolean;
  isStreaming?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set on the row that stands in for a compaction, so it is drawn as one. */
  compact?: CompactionInfo;
  /** The summary that compaction produced, folded into the row above rather than left loose. */
  compactSummary?: string;
  /**
   * Set on the row the projection makes for one Monitor event — a
   * `<task-notification>` whose body carries an `<event>` rather than a
   * background agent's `<result>`.
   *
   * Its presence, together with a non-empty {@link monitorTaskId}, is the only
   * thing `collapseMonitorEventRows` groups by; an ordinary notification (no
   * `<event>`) and a row with no task id are both boundaries, never members of
   * a run. The event body itself lives in {@link monitorEvent}.
   */
  isMonitorEvent?: boolean;
  /**
   * The `<task-id>` a Monitor event reports on — the one grouping key a run is
   * built from. Empty when the notification carried no id, which is what keeps
   * such a row from ever being folded into a run.
   */
  monitorTaskId?: string;
  /** The `<event>` body one Monitor event carried, before any folding. */
  monitorEvent?: string;
  /** The notification's `<summary>`, drawn as the collapsed row's description. */
  monitorDescription?: string;
  /**
   * Set on the single row a run of adjacent Monitor events folds into. The
   * renderer draws this row in place of the individual events, which stay in
   * {@link monitorEvents} for the expandable list.
   */
  isMonitorCollapse?: boolean;
  /** How many Monitor events the collapsed row stands for. */
  monitorEventCount?: number;
  /** Every event body in the run, in arrival order, for the collapsed row's expandable list. */
  monitorEvents?: string[];
  /**
   * Whether the run a collapsed row stands for contains a Monitor timeout.
   * `'stopped'` drives the row's timed-out styling, which is deliberately not
   * the error styling: a stopped monitor is a thing that ended, not a failure.
   */
  monitorStatus?: 'stopped' | 'completed';
  isSubagentContainer?: boolean;
  /** The agent this row spawned, when it spawned one. Its presence is what makes a row a subagent container. */
  subagent?: SubagentInfo;
  /** What that agent did, in order. Empty while the agent is still starting up. */
  subagentActivity?: SubagentActivity[];
  /** Stored memory this reply drew on, shown as a footnote beneath it. */
  memoryCitations?: MemoryCitation[];
  /** Lifecycle the provider reported for this tool call, when it reports one; otherwise the status is inferred from whether a result has arrived. */
  toolStatus?: string;
  /**
   * Who started this turn, when it was not a person at a browser.
   *
   * Carried through from the store row rather than recomputed here: it is the
   * fact the transcript's divider and its non-user styling are both derived
   * from, and its absence is what says "a person typed this".
   */
  origin?: MessageOrigin;
  /**
   * The host's uuid for the command this row is, and where the host says the
   * command is in its own queue.
   *
   * Set on the row drawn for a message a resident process has taken but not
   * started (`type: 'resident_pending'`), and on no other row. The uuid is the
   * same one a withdrawal names, so the row's own button addresses the command
   * the host is holding rather than a message id this client invented; it is
   * `null` for the window between the send and the host's own account of it,
   * which is what makes "not yet acknowledged" a state the row can draw.
   */
  residentCommandUuid?: string | null;
  residentCommandState?: CommandLifecycleState;
  /**
   * The host's own delivery id for the command this row stands for, as the
   * session's activity snapshot named it.
   *
   * This is the row's identity — the same `deliveryId` a withdrawal addresses
   * and the key the activity channel's `deliveries[]` is folded by. It is `null`
   * for the window between the send and the host's own account of it, which is
   * the state a row draws "not yet acknowledged" from, and it is deliberately
   * not the run or the turn: one turn can carry several deliveries, and a row
   * keyed by the turn would merge commands the user sent one at a time.
   */
  residentDeliveryId?: string | null;
  [key: string]: unknown;
};

/** The user's locally persisted Claude preferences (allowed and disallowed tool lists, permission skipping and project sort order) read from and written back to browser storage. */
export type ClaudeSettings = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
};

/** A proposed Claude tool-permission rule derived from a denied tool call, offered to the user so that tool can be added to the stored allow list in one click. */
export type ClaudePermissionSuggestion = {
  toolName: string;
  entry: string;
  isAllowed: boolean;
};

/** Outcome of writing a tool-permission rule into the stored Claude settings, reporting whether it succeeded, whether the rule was already allowed, and the resulting settings. */
export type PermissionGrantResult = {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
};

/** A tool-permission request awaiting the user's decision, identified by its requestId and carrying the tool name, input and context needed to render the prompt and reply to the backend. */
export type PendingPermissionRequest = {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
};

/** One question asked by the AskUserQuestion tool, with its answer options and whether more than one option may be selected. */
export type Question = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

/** Options for a programmatic session navigation, currently only whether the route change should replace the current history entry instead of pushing a new one. */
export type SessionNavigationOptions = {
  replace?: boolean;
};

/** Context handed to the workspace when a chat run creates a session, naming the provider that created it, the owning project and the session summary, so the session can be selected and labelled. */
export type SessionEstablishedContext = {
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

/** The result returned for a tool call, carrying its content, error flag, timestamp and any provider-specific extras that the tool renderers read. */
export type ToolResult = {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
};

/** One selectable answer for a Question, with the label shown to the user and an optional explanatory description. */
type QuestionOption = {
  label: string;
  description?: string;
};

// ---------------------------

//----------------- CHAT SESSION STORE ------------

/** A provider-agnostic transcript event as normalized by the backend adapters, with all kind-specific fields kept flat; it is the shape the session store holds and that chat converts into ChatMessage for rendering, so treat it as the wire contract rather than a view model. */
export type NormalizedMessage = {
  id: string;
  /**
   * Identity of the stream block a *live* frame belongs to, as
   * `<message.id>:<index>` (the server declaration is the source of the shape;
   * treat the value as opaque).
   *
   * Set on the Claude frames forwarded off a live run — the `stream_delta`
   * fragments, the `stream_end` that closes the block, and the settled
   * `text`/`thinking`/`tool_use` record that block becomes all carry the same
   * value. It is what lets the store fold a block's fragments onto the single
   * row they settle into, instead of guessing by text equality and adjacency.
   *
   * Provider history reads never set it, so its presence is also the signal
   * that a row came off the wire rather than out of the transcript.
   */
  blockKey?: string;
  /**
   * The provider's own id for the transcript row behind this message, when the
   * provider has stable per-row identity (today: Claude). Sent back as the
   * anchor for "edit this message" and "fork from here".
   */
  transcriptAnchorId?: string;
  /**
   * The anchor a fork taken from this answer cuts at, when this message ends a
   * turn. Distinct from `transcriptAnchorId`: this one is set on assistant
   * replies, not user prompts, and is what the fork button sends back as
   * `upToAnchorId`. Absent while the turn is still running.
   */
  forkAnchorId?: string;
  /**
   * Set only on the client-side optimistic echo of an edited message, naming
   * the anchor that echo replaces. Never sent by the backend.
   *
   * The truncation that follows an edit clears every live row, because they
   * belonged to the turn being replaced. This tag is what tells the store the
   * replacement itself is not one of them.
   */
  replacesAnchorId?: string;
  /**
   * The **absolute history subscript** of the cut this echo was sent for — its
   * position in the complete normalized history, not an index into whichever
   * page happened to be on screen when the truncation was applied. Stamped when
   * the truncation is applied; the consumer subtracts the current window's
   * origin before using it as a lower bound on the page it holds.
   *
   * The echo is retired once the provider persists it, and that is decided by
   * matching text and attachments inside a time window. That is enough until a
   * rewind re-stamps the surviving turns — a provider that has to branch
   * writes the copy with the timestamps of the copy — because an earlier turn
   * with the same words then sits inside the window and retires the message
   * the user just sent. The replacement can only be a row that was not there
   * when the cut was made, so this is where those rows begin.
   *
   * Kept under this name for the duration of the coordinate fix; the identity
   * phase removes the field entirely.
   */
  replacesAfterRowCount?: number;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;
  /**
   * Identity of the run this live event's `seq` belongs to. Because `seq` is
   * numbered per run, this is what lets a reconnecting client tell whether its
   * stored cursor still describes the run now in flight — a frame whose
   * `runId` differs from the stored one restarts the cursor. REST history
   * messages do not carry it.
   */
  runId?: string;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set by the provider on the row that stands in for a compaction. */
  compact?: CompactionInfo;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  files?: Array<{ path?: string; name?: string; mimeType?: string; size?: number }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  /** Timeline of a spawned subagent's work, attached by the backend to the tool call that spawned it. */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of that subagent. */
  subagent?: SubagentInfo;
  /** Stored memory this reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  /**
   * Who started this turn, when it was not a person at a browser.
   *
   * Present only on turns the host layer opened on its own behalf — a
   * background task reporting back, a timer firing, another session writing in.
   * The transcript draws those turns differently from a typed one, and it can
   * only do that from a fact the server published: a client that guessed from
   * the sender's absence would be inferring, not reading.
   */
  origin?: MessageOrigin;
  /**
   * The host-assigned uuid of the queued command a `command_lifecycle` message
   * is about, and where that command is in the CLI's own queue.
   *
   * Both are set only on `kind: 'command_lifecycle'`, and they are the whole
   * payload of it: the server forwards "command <uuid> is now <state>" and
   * nothing else, because that is all the dialect row it normalizes carries.
   * The uuid is the same one a withdrawal names, which is what lets the client
   * hold a message and its queue state as one object instead of two.
   */
  commandUuid?: string;
  commandState?: CommandLifecycleState;
  /**
   * The activity channel's name for the delivery this row is: the `deliveryId`
   * of a snapshot entry, which is the same value `commandUuid` carries on the
   * legacy `command_lifecycle` frame.
   *
   * Set on a row minted from — or adopted by — a delivery the session's activity
   * snapshot named, and it is the ONLY key a pending row is folded by: the run
   * a command ends up executing as is not its identity, so a row keyed by the
   * run would collapse the several commands one turn can carry.
   */
  deliveryId?: string;
};

// ---------------------------

//----------------- SESSION TURN OUTLINE ------------

/**
 * One user turn in a session's outline, as `GET /api/providers/sessions/:id/outline`
 * reports it.
 *
 * The outline is the navigation rail's index of a conversation: every user
 * prompt, in transcript order, including the parts a client has never loaded.
 * `index` is the turn's *absolute* position in the full normalized history —
 * the subscript of the message in the same array the paginated messages route
 * slices — so it is stable when new turns are appended to the end; a tail
 * offset would move for every already-drawn turn on each append.
 */
export type SessionTurnOutlineTurn = {
  /** `transcriptAnchorId` when the provider has one, else the synthesized message id. */
  id: string;
  /** Absolute 0-based subscript of this message in the full normalized history. */
  index: number;
  /** The provider transcript row's timestamp. */
  timestamp: string;
  /** The first ~80 characters of the turn's text, with line breaks flattened to spaces. */
  preview: string;
};

/**
 * The full outline response: the number of normalized messages in the session
 * (`total`, identical to the paginated messages route's `total`) and every user
 * turn found within them.
 *
 * Mirrored by the backend service's own return shape in
 * `server/modules/providers/services/sessions.service.ts`; the two trees keep
 * separate copies of the shared declaration so the server build never pulls the
 * browser's React/i18next types.
 */
export type SessionTurnOutline = {
  total: number;
  turns: SessionTurnOutlineTurn[];
};

/**
 * A window of messages centered on one message id, as
 * `GET /api/providers/sessions/:id/messages?around=<id>&before=B&after=A`
 * reports it.
 *
 * `startIndex` is the *absolute* 0-based subscript of `messages[0]` in the full
 * normalized history — the same array the paginated messages route slices — so
 * it does not move when newer messages are appended to the end, unlike a tail
 * offset. `total` is that array's length, identical to the paginated route's
 * `total`, so a client can keep its own count without a second read. The two
 * `hasMore*` flags say whether the window is cut off at that edge; a client
 * loads the next stretch by asking again with the edge message's id as `around`.
 *
 * Mirrored by the backend service's own return shape in
 * `server/modules/providers/services/sessions.service.ts`; the two trees keep
 * separate copies of the shared declaration so the server build never pulls the
 * browser's React/i18next types.
 */
export type SessionMessageWindow = {
  messages: NormalizedMessage[];
  /** Absolute 0-based subscript of `messages[0]` in the full normalized history. */
  startIndex: number;
  /** The full history's length, identical to the paginated route's `total`. */
  total: number;
  /** Whether a message older than `messages[0]` exists before the window. */
  hasMoreBefore: boolean;
  /** Whether a message newer than the last window message exists after it. */
  hasMoreAfter: boolean;
};

/**
 * One messages read, in either of the route's two shapes.
 *
 * `limit`/`offset` is the tail page: `offset` counts back from the newest message,
 * so it moves for already-loaded rows whenever a turn is appended. `around` is the
 * id-anchored window read the {@link SessionMessageWindow} response describes:
 * the server returns `[max(0, X - before), min(total, X + after + 1))` around the
 * message whose `transcriptAnchorId ?? id` equals `around`. When `around` is
 * present the server ignores `limit`/`offset` on purpose — the two shapes answer
 * different questions and honoring both would make them fight over one slice.
 *
 * Kept as one type because the session store picks the shape per call, and used
 * by `src/shared/api.ts` to build the request URL.
 */
export type SessionMessagesQuery = {
  limit?: number | null;
  offset?: number;
  around?: string;
  before?: number;
  after?: number;
};

// ---------------------------

//----------------- COMMAND LIFECYCLE ------------

/**
 * Where one queued user message is in the CLI's own queue.
 *
 * The client's copy of the server's declaration (`server/shared/types.ts`), and
 * the same four members: `queued` and `started` are the two facts that separate
 * "still withdrawable" from "already running", `cancelled` is the ONLY evidence
 * a withdrawal worked — the CLI answers a `cancel_async_message` control frame
 * with no `control_response` at any timing, so the queue's own account of the
 * message is the verdict — and `completed` is the turn having run to its end.
 */
export type CommandLifecycleState = 'queued' | 'started' | 'cancelled' | 'completed';

// ---------------------------

//----------------- UNATTENDED TURN ORIGIN ------------

/**
 * What started a turn nobody typed.
 *
 * A closed set, and the ONLY one: the divider the transcript draws before such
 * a turn and the lease a host is held for both take their names from the
 * server's own declaration, so the client narrows to these rather than spelling
 * its own list. `background-task` and `cron` are the two turn origins that
 * describe work outliving a turn; the third is a message another session sent,
 * which is why it — and only it — carries a sender. A third held-work lease
 * kind, `monitor`, is not a turn origin and so is not here: it names held work
 * on the host, and it is the resident pill that reports held work rather than a
 * turn's cause. The resident status bar that used to echo this set is retired
 * with its counts.
 */
export type MessageOriginTrigger = 'background-task' | 'cron' | 'cross-session';

/**
 * Why a turn exists, when the answer is not "the user sent it".
 *
 * Absent on every turn a person typed, which is what makes the absence
 * meaningful: a message with no `origin` is a user turn, and the transcript
 * renders it the way it has always been rendered. `sender` is the address the
 * sending conversation answers to, and is null for the two triggers that have
 * no other conversation behind them.
 */
export type MessageOrigin = {
  trigger: MessageOriginTrigger;
  sender: string | null;
};

// ---------------------------

//----------------- SESSION HOSTS ------------

/**
 * One reason a resident process is being kept alive.
 *
 * `since` is on the two held-work kinds and is required here because the
 * server's listing projection always fills it: it is the epoch-ms instant the
 * manager began holding the lease, and it is the manager's own record of the
 * hold — the work's internal progress is not observable from the listing and is
 * deliberately not claimed. `cron` has its own `expiresAt` instead; `turn` and
 * `resident-policy` carry no clock.
 */
export type SessionHostLease =
  | { kind: 'turn'; runId: string }
  | { kind: 'background-task'; id: string; since: number }
  | { kind: 'monitor'; id: string; since: number }
  | { kind: 'cron'; id: string; recurring: boolean; expiresAt: number }
  | { kind: 'resident-policy' };

/** The `kind` discriminator of {@link SessionHostLease}, as its own union. */
export type SessionHostLeaseKind = SessionHostLease['kind'];

/** One conversation on a host, as `GET /api/session-hosts` reports it. */
export type SessionHostBindingView = {
  appSessionId: string;
  providerSessionId: string | null;
  state: string;
  leases: SessionHostLease[];
  lastActivityAt: number;
  /**
   * The address this conversation's process answers to, or null when it has
   * none. It is the one fact about a resident process the client cannot derive:
   * the name is registered inside the process.
   */
  peerName: string | null;
};

/**
 * A process serving one or more conversations.
 *
 * `closeReason` is null on a host that is still open, which is also the only
 * way to tell "still running" from "closed" without a second field: a closed
 * host always has a reason.
 */
export type SessionHostView = {
  hostId: string;
  provider: LLMProvider;
  mode: string;
  state: string;
  /** The child process id, or null for a host that was never given one. */
  pid: number | null;
  startedAt: number;
  closeReason: string | null;
  /**
   * The extra fact `closeReason` carries, or null when it carries none.
   *
   * It is what tells a process that exited on its own (`oom`, `signal`,
   * `error`) apart from one that was stopped, and it is the only source for the
   * exited banner's wording — the manager holds it on a field no other route
   * publishes.
   */
  closeDetail: string | null;
  bindings: SessionHostBindingView[];
};

/**
 * One session's host state — including the sessions no host is serving.
 *
 * `hosts` answers "what processes are there"; this answers "what should be
 * running, and isn't". The stored `lifecycleMode` is what survives the restart
 * that a live host does not.
 */
export type SessionHostStateView = {
  appSessionId: string;
  provider: LLMProvider;
  lifecycleMode: string;
  running: boolean;
  /** Why a resident session has no process, or null when the question does not apply. */
  reason: string | null;
  /**
   * The Claude Code background job holding this conversation, or null.
   *
   * Optional in the type even though the server always sends it, for the reason
   * `transcript_name` is optional on a session row: existing literals — the
   * sibling tests that build a snapshot to double `useSessionHosts` — predate
   * the field and mean "nothing is holding this". The server's own contract is
   * the stronger one: `session-hosts-routes.test.ts` asserts the key is on every
   * row it sends, so a client reads `undefined` only from a hand-built snapshot,
   * never from the wire.
   */
  occupiedBy?: SessionOccupiedBy | null;
};

/**
 * The Claude Code background job occupying one conversation.
 *
 * What the composer needs to explain itself, and the whole of it: `jobId` is the
 * handle `claude stop` takes, and `pid` is the process behind it. Shape-for-shape
 * with the server's `SessionOccupiedBy` in `session-hosts.routes.ts`.
 *
 * Nothing here is the reason the session is read-only — that is the mere
 * presence of the value. A session the *user* is running elsewhere and one some
 * other agent left running are the same situation from this app's side: it
 * cannot resume the conversation, so it must not offer to.
 */
export type SessionOccupiedBy = {
  jobId: string;
  pid: number;
};

/** The `GET /api/session-hosts` payload: the hosts, and the state of every session. */
export type SessionHostsSnapshot = {
  hosts: SessionHostView[];
  sessions: SessionHostStateView[];
};

/**
 * The five things a resident process can be doing, as the UI names it.
 *
 * Named for what a reader can act on rather than for the host's own six-member
 * state, two of which (`starting`, `closing`) describe a transition no control
 * behaves differently on. It is the ONE vocabulary the sidebar mark and the
 * status bar both draw from — {@link readResidentProcessState} is the only place
 * the host's words are translated into these — so the mark beside a session's
 * name and the sentence in its status bar cannot describe one process
 * differently.
 *
 * `unknown` is not a host state: no listing ever reports it. It is what the one
 * translation returns when the *read itself* failed, so the last snapshot's word
 * is not repeated as if it were current. A dead endpoint must not let the UI go
 * on saying `busy` about a process nobody can see; the successful read that
 * follows restores the real word immediately.
 */
export type ResidentProcessState = 'unstarted' | 'idle' | 'busy' | 'exited' | 'unknown';

/** Discriminator on NormalizedMessage naming which kind of transcript event it carries — plain text, tool use or result, thinking, stream delta or end, error, completion, status, permission request/resolution/cancellation, session creation, interactive prompt, or task notification. */
type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  | 'task_notification'
  | 'command_lifecycle';

// ---------------------------

//----------------- CHAT COMPOSER ------------

/** Result payload of the chat `/model` slash command, describing the session's current provider and model plus the model catalog it may switch to, used to populate the command modal's model picker. */
export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: ProviderModelOption[];
  defaultModel?: string;
};

/** Result payload of the chat `/cost` slash command, carrying the session's token usage totals and input/output breakdown for the command modal's usage view. */
export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
  /**
   * The title Claude generated for this session, read from its transcript when
   * the command ran — not the name the session is listed under, which a rename
   * or a first-message fallback can have replaced. The server omits the field
   * whenever the transcript has no generated title, so absence and emptiness
   * both mean "render nothing"; it is never an "Unknown" placeholder.
   */
  aiTitle?: string;
};

/** Result payload of the chat `/status` slash command, carrying server version, uptime, provider/model and process telemetry for the command modal's status view. */
export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

/** Result payload of the chat `/help` slash command, carrying either pre-rendered help content or the list of available commands for the command modal's help view. */
export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

/** Wrapper pairing a CommandModalKind with its matching command result data; pass it as the single payload prop that tells the chat command modal which slash-command result to render, or null to close it. */
export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

/** A composer message queued while its session is still busy, holding the text, the in-memory and already-uploaded attachments and the send options snapshotted at queue time so it can be auto-sent unchanged once the session goes idle. */
export type QueuedDraft = {
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

/** Viewport-relative placement box (right/bottom offsets plus max height and width) computed for a composer popover so the model and permission menus stay inside the window. */
export type ComposerMenuAnchor = {
  right: number;
  bottom: number;
  maxHeight: number;
  maxWidth: number;
};

/** One selectable slash command — built-in, user-defined or skill-backed — as listed in the chat composer's command menu and executed when the user picks it. */
export type SlashCommand = {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Discriminator naming which slash-command result the chat command modal is showing: 'help', 'models', 'cost' or 'status'. */
type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

// ---------------------------

//----------------- CHAT VOICE ------------

/** Lifecycle state of the composer's push-to-talk microphone: 'idle', 'recording' or 'transcribing'. */
export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/** Immutable snapshot of the app-level text-to-speech player for one utterance — its play state plus any error message — read by components so read-aloud state survives re-renders and chat switches. */
export type VoiceSnapshot = { state: VoicePlayState; error: string | null };

/** Playback state of one audio source owned by the voice layer (a read-aloud utterance or a recorded clip): 'idle', 'loading' or 'playing'. */
export type VoicePlayState = 'idle' | 'loading' | 'playing';

/**
 * What the composer knows about a recording without reading the blob back: its size,
 * the container the recorder produced, and how long the user held the mic. Computed
 * once when the clip is captured, because the single slot only ever needs to display it.
 */
export type VoiceClipMeta = {
  bytes: number;
  mimeType: string;
  durationMs: number;
};

/**
 * The composer's recording: an object URL that keeps a blob alive plus the meta its replay
 * control renders. Held by `useVoiceInput` and passed to `VoiceClipButton`; a new recording
 * replaces it, and it is never persisted beyond the open chat.
 */
export type VoiceClip = {
  url: string;
  meta: VoiceClipMeta;
};

/** Which of the slot's two replays a control or a play state belongs to. */
export type VoiceClipTrack = 'original' | 'trimmed';

/**
 * The composer's recording slot: what was recorded, and — when the trim applied — what was sent.
 *
 * Two tracks rather than one because the upload is no longer the recording. The trimmed body is a
 * re-encode, so a replay of it alone cannot answer the question the trim raises — whether it cut
 * something it should have kept — and the same audio heard twice cannot be told apart from a trim
 * that did nothing.
 *
 * At least one track is non-null; a slot with both null is not a slot the composer ever holds.
 *
 * `original` is null when the raw recording exceeded the capture limit and was never kept; the
 * composer then renders the trimmed control alone rather than a disabled one, because a disabled
 * control over audio nobody can play claims a recording that is not there.
 *
 * `trimmed` is null exactly when the chain uploaded the recording untouched (the trim's own
 * `fallback`). The composer then renders one control: a second one over the same bytes would be a
 * claim about a trim the run never made.
 */
export type VoiceClipSlot = {
  original: VoiceClip | null;
  trimmed: VoiceClip | null;
};

/**
 * The slot's replay state, one entry per track. At most one entry is ever non-idle: the two tracks
 * are the same speaker, and starting either is what stops the other.
 */
export type VoiceClipPlayState = {
  original: VoicePlayState;
  trimmed: VoicePlayState;
};

/**
 * A transcription the recogniser refused, kept as the fields the answer carried rather than as
 * the sentence they were flattened into.
 *
 * Structured because two consumers need two different things from one failure: the composer shows
 * the localized sentence its `code` selects, and the technical line shows the machine-readable
 * half. Building the sentence at the moment of failure — which is what the capture chain used to
 * do — spends the code and the status irreversibly: nothing downstream can tell a refusal the
 * vocabulary names from one it does not, and the status number survives only as digits inside a
 * sentence nobody can re-read.
 *
 * `code` is absent when the answer's body carried none, which is NOT the same fact as a code
 * outside the vocabulary: both take the fallback sentence, but only the first says the backend
 * never classified the failure at all. `upstreamCode` is the recogniser's own code string, passed
 * through when the backend had one; it names nothing on its own and is carried for the technical
 * line only.
 */
export type VoiceTranscriptionFailure = {
  code?: string;
  status?: number;
  upstreamCode?: string;
  /**
   * The spoken span this refusal is about, in seconds from the start of the listen.
   *
   * Present only on the continuous path, where one listen is many uploads and a failure is about one
   * segment rather than the whole recording. The notice renders it beside the sentence so the user
   * can tell which part of a long dictation is missing; the single-request path leaves it unset.
   */
  startSec?: number;
  endSec?: number;
};

/**
 * What one capture hands the composer when it fails.
 *
 * A union rather than one shape because the two kinds of failure are already unlike: a refusal from
 * the recogniser arrives with a code and a status and no sentence, while the chain's own local
 * failures (a recording too short to send, a missing microphone, a playback that would not start)
 * have neither a code nor a vocabulary behind them and carry their sentence already written. Sending
 * them through the same channel keeps one failure path; the discriminator is the `typeof` check at
 * the consumer, which is exactly the question "is this a sentence or something to look up?".
 */
export type VoiceFailureReport = string | VoiceTranscriptionFailure;

// ---------------------------

//----------------- CHAT STORAGE ------------

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

// ---------------------------

//----------------- CHAT MESSAGE RENDERING ------------

/** Function that turns an old/new string pair into rendered diff lines; the chat session state supplies one memoized, caching instance so each file diff is computed only once. */
export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

/** A synthetic transcript entry standing for a run of consecutive calls to the same tool, produced by the message grouping pass and identified by its `_isGroup` flag so the message list can collapse the run into one expandable block. */
export type ToolGroupItem = {
  _isGroup: true;
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
  /**
   * Summary line for the collapsed group, built while grouping so the tool-input
   * JSON parsing it needs never runs during render.
   */
  preview: string;
};

/**
 * A synthetic transcript entry standing for one run of adjacent work rows — the
 * thinking, tool-call and subagent-container rows the work-segment selector
 * (`groupWorkSegments`) absorbs — identified by its `_isWorkSegment` flag.
 *
 * The run is held verbatim: unlike {@link ToolGroupItem} it does not fold
 * same-name tool calls into an xN layer, so `messages.length` is the run's real
 * row count. `key` is the first member's intrinsic key (`getIntrinsicMessageKey`),
 * which is what gives the segment an identity independent of the streaming tail.
 */
export type WorkSegment = {
  _isWorkSegment: true;
  key: string | null;
  messages: ChatMessage[];
};

/** One entry of a transcript that has been through the work-segment selector: either a row no segment absorbed, or a {@link WorkSegment} standing in for a run of absorbed rows. */
export type WorkSegmentListItem = ChatMessage | WorkSegment;

/** One line of a rendered file diff, marked 'added' or 'removed', with its text and line number. */
export type DiffLine = {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
};

/** How many lines one file edit added and removed, for the `+12 -3` badge on a diff's header. */
export type DiffStats = {
  added: number;
  removed: number;
};

// ---------------------------

//----------------- CHAT TOOL RENDERING ------------

/** One entry of an agent todo list as produced by the TodoWrite/TodoRead tools, rendered as a single status row in the tool todo-list view. */
export type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority?: string;
  activeForm?: string;
};

/** Display state of a tool call — 'running', 'completed', 'error' or 'denied' — used to choose the status badge and styling shown beside it in the transcript. */
export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

/** Props contract that every interactive permission panel implements, giving the panel the pending request and the callback it calls to allow or deny that request; use it when registering a panel in the permission panel registry. */
export type PermissionPanelProps = {
  request: PendingPermissionRequest;
  onDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; updatedInput?: unknown },
  ) => void;
};

// ---------------------------

//----------------- CODE EDITOR ------------

/** The before/after strings of a pending edit attached to a file opened in the code editor, used to drive the editor's inline merge/diff view; extra keys are tolerated because it comes straight from tool payloads. */
export type CodeEditorDiffInfo = {
  old_string?: string;
  new_string?: string;
  [key: string]: unknown;
};

/** A file handed to the code editor for viewing or editing, carrying its display name, workspace-relative path, owning DB projectId for read/save requests and any diff to highlight. */
export type CodeEditorFile = {
  name: string;
  path: string;
  // DB projectId; used by the editor to build `/api/file-tree/projects/:projectId/file`
  // URLs for reading and saving content.
  projectId?: string;
  diffInfo?: CodeEditorDiffInfo | null;
  // 1-based line to reveal when the file opens (from a `path:line` reference).
  line?: number | null;
  [key: string]: unknown;
};

/** One request to reveal a line in the editor. The code editor builds a new object per opened file so the surface can tell a fresh request apart from a re-render, and jump only once per request. */
export type CodeEditorGotoTarget = {
  // 1-based, clamped to the document by the editor surface.
  line: number;
};

/** The category of browser-renderable media a file maps to, used by the code editor to decide whether to show an inline image, PDF, video or audio preview instead of a text buffer. */
export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio';

// ---------------------------

//----------------- FILE TREE ------------

/** Progress, completion or failure state of one in-flight file-tree upload, produced by the upload hook and rendered by the file tree's progress banner. */
export type FileTreeUploadProgressState = {
  status: 'uploading' | 'complete' | 'error';
  progress: number;
  fileCount: number;
  uploadedCount?: number;
  fileName?: string;
  targetPath?: string;
  error?: string;
};

/** Which density the file tree renders its rows at (simple, compact or detailed), chosen in the file tree header and persisted in local storage. */
export type FileTreeViewMode = 'simple' | 'compact' | 'detailed';

/** One request to reveal a directory in the file tree, coming from a `path/` reference in a chat message. The workspace builds a new object per click so the tree re-reveals a folder the user collapsed again in the meantime. */
export type DirectoryRevealRequest = {
  // As written in the message: relative to the project root, or absolute.
  path: string;
};

/** One file or directory entry in a project's file listing, with directories carrying their loaded `children`; used across the file tree for rendering, searching and filtering. */
export type FileTreeNode = {
  name: string;
  type: FileTreeItemType;
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
  [key: string]: unknown;
};

/** The image the file tree asked to preview, carrying the path plus the DB `projectId` the image viewer needs to build its raw content URL. */
export type FileTreeImageSelection = {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by ImageViewer to build the raw content URL.
  projectId: string;
};


/** Whether a file tree entry is a file or a directory; use it instead of repeating the string union wherever `FileTreeNode`-shaped data is handled. */
type FileTreeItemType = 'file' | 'directory';

// ---------------------------

//----------------- GIT PANEL ------------

/** The old/new text of a single edit, handed to the code editor so it can open a file focused on that change. */
type FileDiffInfo = {
  old_string: string;
  new_string: string;
};

/** Callback the git panel calls to open a file in the code editor, optionally focused on one edit. */
export type FileOpenHandler = (filePath: string, diffInfo?: FileDiffInfo) => void;


/** Which tab the git panel is showing (changes, history, branches or worktrees), driving both the tab bar and which data its controller loads. */
export type GitPanelView = 'changes' | 'history' | 'branches' | 'worktrees';

/** Single-letter git status of a changed file (M, A, D or U), used to pick its label, badge styling and change group. */
export type FileStatusCode = 'M' | 'A' | 'D' | 'U';

/** The git action a confirmation dialog is guarding, selecting that dialog's title, action label and colour scheme. */
export type ConfirmActionType = 'discard' | 'delete' | 'commit' | 'pull' | 'push' | 'publish' | 'revertLocalCommit' | 'deleteBranch';

/** Payload of the git status endpoint: the current branch plus working-tree paths grouped by status, or the error and `notGitRepository` fields when the project has no usable repository. */
export type GitStatusResponse = {
  branch?: string;
  hasCommits?: boolean;
  modified?: string[];
  added?: string[];
  deleted?: string[];
  untracked?: string[];
  /** Paths with index-side changes — mirrors the real git index. */
  staged?: string[];
  error?: string;
  details?: string;
  /** True when the project directory is not a git repository — the UI offers `git init`. */
  notGitRepository?: boolean;
};

/** Upstream state of the current branch (remote name, ahead/behind counts, up-to-date flag) that the git panel header and branches view use to enable fetch, pull, push and publish. */
export type GitRemoteStatus = {
  hasRemote?: boolean;
  hasUpstream?: boolean;
  branch?: string;
  remoteBranch?: string;
  remoteName?: string | null;
  ahead?: number;
  behind?: number;
  isUpToDate?: boolean;
  message?: string;
  error?: string;
};

/** One commit in the history list, including the parent hashes and ref decorations the commit graph needs to lay out lanes. */
export type GitCommitSummary = {
  hash: string;
  author: string;
  email?: string;
  date: string;
  message: string;
  stats?: string;
  /** Parent commit hashes — drives the History view commit graph. */
  parents?: string[];
  /** Ref decorations, e.g. "HEAD -> main", "origin/main", "tag: v1.0". */
  refs?: string[];
};

/** Unified diff text keyed by file path, used both for working-tree diffs and for the per-file diffs of an expanded commit. */
export type GitDiffMap = Record<string, string>;

/** A pending confirmation dialog — its message, confirm handler and optional escalated alternative — raised by git panel actions and rendered by the shared Confirmation UI. */
export type ConfirmationRequest = {
  type: ConfirmActionType;
  message: string;
  onConfirm: () => Promise<void> | void;
  alternateConfirmation?: {
    label: string;
    description: string;
    actionLabel: string;
    onConfirm: () => Promise<void> | void;
  };
};

/** The `error` and `details` fields any git API response may carry; intersect it with a route's own payload type instead of redeclaring them. */
export type GitApiErrorResponse = {
  error?: string;
  details?: string;
};

/** Response of a git write endpoint such as commit, pull, push or revert: the shared error fields plus `success` and the raw git `output`. */
export type GitOperationResponse = GitApiErrorResponse & {
  success?: boolean;
  output?: string;
};

/** One git worktree as reported by the worktrees API, including its branch, ahead/behind counts and the linked project used to open it. */
export type WorktreeInfo = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/** Choices made in the merge-worktree dialog (squash, commit message and whether to remove the worktree afterwards), passed straight to the merge request. */
export type MergeWorktreeOptions = {
  squash: boolean;
  message: string;
  removeAfterMerge: boolean;
};

/** Choices made in the remove-worktree dialog (force removal and whether to delete the worktree's branch), passed straight to the remove request. */
export type RemoveWorktreeOptions = {
  force: boolean;
  deleteBranch: boolean;
};

/** Pre-computed lane geometry for one row of the history commit graph, telling the graph strip which rails to draw above, through and below that commit's dot. */
export type CommitGraphRow = {
  /** Lane the commit dot sits in. */
  nodeLane: number;
  /** Total lanes visible in this row — determines the strip width. */
  laneCount: number;
  /** A line arrives at the node from the row above (some child expects this commit). */
  hasTopContinuation: boolean;
  /** The node's own lane continues below toward its first parent. */
  hasParentContinuation: boolean;
  /** Extra top lanes that merge into the node (multiple children / branch tips joining). */
  inbound: number[];
  /** Bottom lanes branching out of the node toward its extra parents (merge commits). */
  outbound: number[];
  /** Lanes whose lines pass straight through this row untouched. */
  passThrough: number[];
  /** Every lane still active below this row — rails continue through expanded content. */
  bottomLanes: number[];
};

// ---------------------------

//----------------- MCP SERVERS ------------

/** The LLM provider whose MCP server configuration is being read or written; use it to key provider-specific MCP capabilities such as supported scopes and transports. */
export type McpProvider = LLMProvider;

/** Where an MCP server definition is stored - the user's global provider config, Claude's project-local config, or a project workspace config - and therefore which config file a read or write targets. */
export type McpScope = 'user' | 'local' | 'project';

/** How a client connects to an MCP server (a stdio subprocess, streamable HTTP, or SSE); use it to decide which connection fields of a server or form apply. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** A plain string-to-string map used for the MCP environment variables and HTTP headers that are edited as `KEY=value` lines and sent as objects. */
export type KeyValueMap = Record<string, string>;

// Internal MCP shape; `projectId` replaces the legacy `name` field from the
// projectName → projectId migration.
export type McpProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** One MCP server as it is currently configured for a provider, as returned by the MCP API and rendered in the settings server list. */
export type ProviderMcpServer = {
  provider: McpProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
  workspacePath?: string;
  projectName?: string;
  projectDisplayName?: string;
};

/** The complete editable state of the MCP server form, covering the structured connection fields and the raw JSON import text; convert it with createMcpPayloadFromForm before sending it to the API. */
export type McpFormState = {
  name: string;
  scope: McpScope;
  workspacePath: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueMap;
  cwd: string;
  url: string;
  headers: KeyValueMap;
  envVars: string[];
  bearerTokenEnvVar: string;
  envHttpHeaders: KeyValueMap;
  importMode: McpImportMode;
  jsonInput: string;
};

/** The request body sent when creating or updating a provider's MCP server, built from McpFormState so only the fields valid for the chosen transport are included. */
export type UpsertProviderMcpServerPayload = {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
};

/** Whether the MCP server form is being filled in field by field or pasted in as raw JSON, which selects the form's input mode. */
type McpImportMode = 'form' | 'json';

// ---------------------------

//----------------- PLUGINS ------------

/** An installed CloudCLI plugin's manifest and runtime status (entry point, slot, permissions, enabled and server-running flags); always import this type explicitly from `@/shared/types`, because `Plugin` is also a DOM global and an unimported reference silently resolves to that instead. */
export type Plugin = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  type: 'react' | 'module';
  slot: 'tab';
  entry: string;
  server: string | null;
  permissions: string[];
  enabled: boolean;
  serverRunning: boolean;
  dirName: string;
  repoUrl: string | null;
};

// ---------------------------

//----------------- PRD EDITOR ------------

/** The PRD document the PRD editor should open, describing either an existing file to load (by path or inline content) or a blank draft to start from. */
export type PrdEditorFile = {
  name?: string;
  path?: string;
  // DB projectId used to resolve the project path when fetching file content.
  projectId?: string;
  content?: string;
  isExisting?: boolean;
};

/** A PRD already stored in a project's TaskMaster docs folder, used to detect filename collisions before saving and to load a previously written PRD. */
export type ExistingPrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

// ---------------------------

//----------------- PROJECT CREATION WIZARD ------------

/** The one-based index of the step currently shown by the project-creation wizard: 1 configures the workspace, 2 reviews it before creation. */
export type WizardStep = 1 | 2;

/** How the project-creation wizard authenticates a GitHub clone: reuse a 'stored' credential, enter a 'new' token, or use 'none' and rely on public access or an SSH key. */
export type TokenMode = 'stored' | 'new' | 'none';

/** One filesystem directory returned by the browse-filesystem endpoint, used to populate workspace-path autocomplete and the folder browser. */
export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

/** A stored GitHub token credential as returned by the credentials endpoint, listed so the user can pick which token authenticates a clone. */
export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

/** The full set of user-entered values carried across the project-creation wizard's steps, owned by ProjectCreationWizard and passed down to each step. */
export type WizardFormState = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

// ---------------------------

//----------------- PROJECT WORKSPACE ------------

/** The shared WebSocket connection and its send function, threaded through the workspace tree so descendants can exchange live session messages. */
export type RealtimeProps = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
};

/** Everything the project workspace shell and its regions need from the route: the realtime connection plus the current viewport mode and the router's navigate function. */
export type ProjectWorkspaceShellProps = RealtimeProps & {
  isMobile: boolean;
  navigate: NavigateFunction;
};

// ---------------------------

//----------------- PROVIDER AUTHENTICATION ------------

/** Sign-in state of one LLM provider CLI - whether it is authenticated, the account email and method, plus in-flight loading and error state - polled by the provider-auth module and rendered by the settings and onboarding account views. */
export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

/** The authentication state of every CLI provider at once, keyed by LLMProvider, so onboarding and settings can render each provider's connected, loading and error state from one object returned by useProviderAuthStatus. */
export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// ---------------------------

//----------------- TRANSCRIPT EXPORT SEAM ------------

/**
 * The chat module's export, published into the shared seam so the workspace
 * header's overflow menu can run one without either module importing the other.
 *
 * The action carries both the data the export needs and the download itself, so
 * the menu never touches chat's exporter — it only knows that a conversation is
 * registered and calls `runExport` with a format.
 */
export type TranscriptExportAction = {
  /** The conversation as chat holds it — the tail, when the transcript is paged. */
  messages: ChatMessage[];
  /** The title the file is named and headed with; absent falls back to a generic one at run time. */
  sessionTitle?: string;
  /** The provider the transcript belongs to, recorded in the export. */
  provider: LLMProvider | string;
  /** The project the session belongs to, used by the HTML export's context header. */
  selectedProject?: Project | null;
  /** Builds the diff lines the Markdown and HTML exports embed. */
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  /** Loads the rest of a paged transcript before export; omitted when the whole conversation is already held. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
  /** Runs one export end to end — loading the full transcript, building it and downloading it. */
  runExport: (format: 'html' | 'markdown' | 'json') => Promise<void>;
};

/**
 * What the header menu reads from the seam: whether chat has registered an
 * export for the open conversation, and how to reach the latest one.
 */
export type TranscriptExportRegistration = {
  /** True once a conversation with messages is registered; the menu hides its export group until then. */
  available: boolean;
  /** Reads the latest registered export at the moment the menu runs one. */
  getAction: () => TranscriptExportAction | null;
};

// ---------------------------

//----------------- SETTINGS ------------

/** The per-provider agent context the agents settings tab builds once and hands to each of its sections. */
export type AgentContextByProvider = Record<AgentProvider, AgentContext>;

/** The per-provider data the agents settings tab hands to its sections: that provider's auth status and the callback that starts its login flow. */
export type AgentContext = {
  authStatus: ProviderAuthStatus;
  onLogin: () => void;
};

/** Identifier of a top-level section in the settings dialog; use it whenever a tab is stored, compared or requested so deep links, the sidebar and the command palette all agree on the same set of names. */
export type SettingsMainTab = 'agents' | 'appearance' | 'git' | 'api' | 'voice' | 'tasks' | 'browser' | 'notifications' | 'plugins' | 'about';

/** The coding-agent CLI a settings screen is configuring, aliasing LLMProvider so agent-scoped settings read as being about an agent rather than a chat model. */
export type AgentProvider = LLMProvider;

/** One category of per-agent configuration in the agents settings tab (account, permissions, MCP servers, skills or the model library); use it to key which panel the tab renders. */
export type AgentCategory = 'account' | 'permissions' | 'mcp' | 'skills' | 'models';

/** How much Codex may do without asking, from prompting on every edit to bypassing permission checks entirely; persisted as the Codex agent's permission setting. */
export type CodexPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** A project as the settings dialog needs it - a required identifier in `name` plus optional display name and paths - passed down to the MCP and skills panels so they can scope configuration to a project. */
export type AgentSettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** Claude's persisted permission settings: the allowed and disallowed tool patterns and whether permission prompts are skipped; read and written as one unit by the settings controller. */
export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
};

/** The user's notification settings, grouped into delivery channels (in-app, web push, desktop, sound) and the events that trigger them; mirrors the payload of the notification preferences API. */
export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

/** Cursor's persisted permission settings: the allowed and disallowed command patterns and whether permission prompts are skipped; read and written as one unit by the settings controller. */
export type CursorPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

/** The code editor display preferences shown in the appearance tab (word wrap, minimap, line numbers and font size), stored together as one server-backed `codeEditorSettings` preference. */
export type CodeEditorSettingsState = {
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

// ---------------------------

//----------------- SETTINGS CREDENTIALS ------------

/** One stored personal access token as the server returns it, carrying its display prefix, name, scopes and timestamps — never the plaintext or the stored hash; render it, do not rebuild it. */
export type AccessTokenItem = {
  id: number;
  tokenPrefix: string;
  name: string | null;
  scopes: string[];
  expiresAt: string;
  lastUsed: string | null;
  createdAt: string | null;
  revokedAt: string | null;
};

/** A freshly issued personal access token: the only time `plaintext` is available. Show it once and never persist it; every other field matches the stored AccessTokenItem. */
export type CreatedAccessToken = {
  id: number;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string;
  lastUsed: string | null;
  createdAt: string | null;
  plaintext: string;
};

/** One OAuth access/refresh token as `GET /api/settings/oauth-tokens` returns it — read-only, and never carrying the stored hash. `clientName` is the OAuth client the token's grant belongs to (the token row itself has no name), and `kind` is `oauth_access` or `oauth_refresh`. The advanced list renders it; it is never created or revoked from there. */
export type OAuthTokenItem = {
  id: number;
  kind: string;
  tokenPrefix: string;
  clientName: string | null;
  scopes: string[];
  createdAt: string | null;
  expiresAt: string;
  lastUsed: string | null;
  revokedAt: string | null;
};

/** The CloudCLI MCP gateway's read-only status as `GET /api/settings/mcp-gateway` returns it: whether the gateway is enabled, the path it answers on, and the base url an MCP client should dial. */
export type McpGatewayStatus = {
  enabled: boolean;
  path: string;
  baseUrl: string;
};

/** One stored GitHub credential as the server returns it, in snake_case, carrying its name, optional description, creation timestamp and active flag - never the token itself. */
export type GithubCredentialItem = {
  id: string;
  credential_name: string;
  description?: string | null;
  created_at: string;
  is_active: boolean;
};

/** One OAuth consent grant the signed-in user approved, as `GET /api/settings/oauth-grants` returns it: the client's display name, the host of its first registered callback, the granted scopes and the two timestamps. Never a token or a secret - the settings page renders it in the "connected apps" list and revokes it by `id`. */
export type ConnectedAppGrant = {
  id: number;
  clientId: string;
  clientName: string | null;
  redirectHost: string | null;
  scopes: string[];
  createdAt: string | null;
  lastUsed: string | null;
};

/** One registered OAuth client as `GET /api/settings/oauth-clients` returns it: how it was created (`dcr` or `manual`), where it redirects and whether an operator has disabled it. Rendered in the "OAuth clients (advanced)" list; disabling it by `clientId` cascades to its grants' tokens. */
export type OAuthClientItem = {
  clientId: string;
  clientName: string | null;
  redirectHost: string | null;
  createdVia: string;
  disabledAt: string | null;
};

/** A freshly created manual OAuth client, as `POST /api/oauth/clients` answers it: `clientSecret` is plaintext and appears in this response only, so it must be shown once and never persisted. The stored client exposes every other field through OAuthClientItem. */
export type CreatedOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  clientSecret: string;
};

/** One scope the consent page offers, as `GET /api/oauth/authorize/context` returns it: the scope id, a human-readable description, whether it is the pinned read scope (`required`) and whether granting it lets the client change something (`writable`). `group` files the row under the screen's read or state-changing heading; `risk` is a stable code naming what makes a state-changing scope risky (a key into the consent namespace's `scopes.risk.*` strings) or null for the pinned read scope. The page renders one checked-or-not checkbox per row and disables the required one. */
export type OAuthConsentScopeOption = {
  scope: string;
  description: string;
  required: boolean;
  writable: boolean;
  group: 'read' | 'write';
  risk: string | null;
};

/** The authorization request as `GET /api/oauth/authorize/context` answers it, once its `(client_id, redirect_uri)` pair has been validated: the client's display name, the host of its registered callback (the anti-phishing "you will be sent to" line), the request's own `state` echoed verbatim, and the whole scope vocabulary flagged for the screen. DCR is open, so the client's name is self-reported: `clientCreatedAt`/`clientCreatedVia` carry the registration provenance the page shows as data, and `accessTokenTtlSeconds` is the provider's real access-token lifetime (never a hardcoded copy) for the page's token-lifetime line. */
export type OAuthConsentContext = {
  clientName: string;
  callbackHost: string;
  redirectUri: string;
  scopes: OAuthConsentScopeOption[];
  state: string | null;
  clientCreatedAt: string | null;
  clientCreatedVia: string | null;
  accessTokenTtlSeconds: number;
};

/** The decision the consent page submits to `POST /api/oauth/authorize/decision`. Field names are the authorization request's own (snake_case); `action` is the user's choice and `scopes` is the checkbox selection, which the server intersects with its vocabulary before granting. */
export type OAuthConsentDecisionRequest = {
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  scopes: string[];
  action: 'allow' | 'deny';
  /** The signed-in user's password, re-entered to confirm an Allow. The server requires and verifies it (behind a per-source rate limit) only when the decision's grant set reaches past the read scope; an empty value is a failed confirmation, never a bypass. */
  password: string;
};

/** The decision's answer, as `POST /api/oauth/authorize/decision` returns it: the client callback URL the browser must be sent to — carrying `code` and `state` on allow, or `error=access_denied` and `state` on deny. The page performs the navigation itself with `window.location.assign`. */
export type OAuthConsentDecisionResponse = {
  redirectTo: string;
};

// ---------------------------

//----------------- SHELL ------------

/** Handle returned when touch text-selection is installed on an xterm terminal; call updateHandles after the terminal reflows and dispose when tearing the terminal down. */
export type MobileTerminalSelectionManager = {
  dispose: () => void;
  updateHandles: () => void;
};

// ---------------------------

//----------------- SIDEBAR ------------

/**
 * The pointer, keyboard and reset handlers a sidebar splitter spreads onto its
 * element, produced by useSidebarResize and consumed by SidebarResizeHandle —
 * the hook owns the drag, the steps and the persistence, the handle the markup.
 */
export type SidebarResizeHandleHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
};

/** The complete project-list state and callback bundle the sidebar assembles once and threads down through its project list, project rows and session rows. */
/**
 * What a session row needs to draw its state and act on the session, named once
 * so the two lists that render a row — Projects and Conversations — cannot fall
 * out of step, and so a call site passes one prop instead of nine.
 *
 * SidebarProjectListProps composes it rather than restating it; it was already
 * carrying every member.
 */
export type SessionRowActions = {
  /** The rename currently open anywhere in the sidebar, or null. */
  activeRename: ActiveSidebarRename | null;
  /** Sessions with a run in flight: they show a spinner and hide destructive actions. */
  activeSessions: ReadonlySet<string>;
  /** Sessions waiting on the user, which show the amber dot. */
  attentionSessionIds: ReadonlySet<string>;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches a session into an independent one. Rows hide it for providers that cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
};

export type SidebarProjectListProps = SessionRowActions & {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  isProjectExpanded: (projectId: string) => boolean;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  isProjectStarred: (projectId: string) => boolean;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onNewSession: (project: Project) => void;
  /** Projects whose name-filtered sessions are temporarily shown in this browser. */
  showHiddenProjectIds?: ReadonlySet<string>;
  onToggleShowHidden?: (projectId: string) => void;
  /** With a session name, the editor opens seeded with a rule derived from it ("hide similar"). */
  onEditSessionFilter?: (project: Project, seedSessionName?: string) => void;
  t: TFunction;
};

/** The ordering applied to the project list, either alphabetically by name or by most recent activity, persisted alongside the user's appearance settings. */
export type ProjectSortOrder = 'name' | 'date';

/** Which list the sidebar is currently showing: projects, conversation search results, running sessions or archived items. */
export type SidebarSearchMode = 'projects' | 'conversations' | 'running' | 'archived';

/** A Project narrowed to the archived state so archived entries can be listed and restored without being mistaken for active projects. */
export type ArchivedProjectListItem = Project & { isArchived: true };

/** A ProjectSession whose LLM provider has been resolved into the required __provider field, so list rendering never has to re-derive it. */
export type SessionWithProvider = ProjectSession & {
  __provider: LLMProvider;
  // Nesting level the sidebar's lineage grouping placed this session at. Set on
  // branched sessions only and absent (level 0) on every other row; the row
  // renderer indents by it so a fork reads as belonging to the row above it.
  __lineageDepth?: number;
  // 1-based position of this branch among its source's branches, and how many
  // there are. The row shows the number only above one, where a bare branch
  // glyph could not say which of several branches the row is.
  __lineageSiblingIndex?: number;
  __lineageSiblingCount?: number;
};

/** One archived session as returned by the archive API, carrying its own project identity because the owning project may itself be archived. */
export type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
  // App id of the session this one was branched from, or null/absent when it
  // started on its own. Optional rather than required: the field is additive on
  // the wire, and rows the UI assembles from already-loaded project sessions do
  // not all carry it.
  forkedFromSessionId?: string | null;
};

/** The subset of archived-session fields needed to render a recent-conversations row and reopen the session it points at. */
export type RecentConversationListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity' | 'forkedFromSessionId'
>;

/**
 * The rename the sidebar currently has open, if any.
 *
 * One value rather than two id/draft pairs, so a project and a session cannot
 * both be mid-rename, and rows can be handed a resolved `isEditing` instead of
 * the raw id — a keystroke then only invalidates the row being renamed.
 *
 * A session rename carries the project that owns it so SidebarProjectList can
 * decide in O(1) which project row the draft belongs to. Without it every row
 * has to be handed the whole value and a keystroke invalidates all of them.
 */
export type ActiveSidebarRename =
  | { target: 'project'; id: string; draft: string }
  | { target: 'session'; id: string; projectId: string; draft: string };

/**
 * The sidebar's pending delete confirmation. One value rather than a pair of
 * nullable states, so a project dialog and a session dialog cannot both be
 * open — they are portalled at the same z-index and would stack. The project
 * variant carries the session count the dialog warns with.
 */
export type PendingSidebarDeletion =
  | { kind: 'project'; project: Project; sessionCount: number }
  | { kind: 'session'; sessionId: string; sessionTitle: string; isArchived: boolean };

/** Whether a TaskMaster MCP server is present and configured for a project, or null while that status is still unknown. */
export type MCPServerStatus = {
  hasMCPServer?: boolean;
  isConfigured?: boolean;
} | null;

// Retained as `name` for backwards compatibility with existing settings
// consumers; the value is populated from `projectId` by normalizeProjectForSettings.
export type SettingsProject = {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
};

// ---------------------------

//----------------- SIDEBAR SEARCH ------------

/** Full result set of a conversation search, combining per-project message matches, session-title matches, the total match count and the query that produced them. */
export type ConversationSearchResults = {
  results: ConversationProjectResult[];
  titleResults: SessionTitleSearchResult[];
  totalMatches: number;
  query: string;
};

/** Progress of an in-flight conversation search, reported as the number of projects scanned out of the total so the UI can show how far the scan has got. */
export type SearchProgress = {
  scannedProjects: number;
  totalProjects: number;
};

/** One session whose title matched a conversation search, carrying enough project and session identity to open that session directly. */
export type SessionTitleSearchResult = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
  /** True when the owning project's name filter hides this session from the normal list. */
  filtered?: boolean;
  // App id of the session this result was branched from, or null/absent when it
  // started on its own. A search spans every project, so a result's source is
  // usually absent from the same payload; the flag still marks the row.
  forkedFromSessionId?: string | null;
};

/** All conversation matches found inside a single project during a search, grouped so the results can be rendered under one project heading. */
export type ConversationProjectResult = {
  // Emitted by the provider search service so the sidebar can map a
  // match back to the Project in its current state by projectId.
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: ConversationSession[];
};

/** One session within a ConversationProjectResult, pairing the session's summary with the individual message matches found in it. */
type ConversationSession = {
  sessionId: string;
  sessionSummary: string;
  provider?: string;
  matches: ConversationMatch[];
};

/** A single matching message from a conversation search, holding the author role, the surrounding snippet and the ranges to highlight inside that snippet. */
type ConversationMatch = {
  role: string;
  snippet: string;
  highlights: SnippetHighlight[];
  timestamp: string | null;
  provider?: string;
  messageUuid?: string | null;
};

/** A start/end character range within a search-result snippet that should be visually marked as the matched text. */
type SnippetHighlight = {
  start: number;
  end: number;
};

// ---------------------------

//----------------- PROVIDER SKILLS ------------

/** The LLM provider whose skills are being listed, uploaded or deleted; use it to target the provider-specific skills endpoints. */
export type SkillsProvider = LLMProvider;

/** Where a skill was discovered - the user's home directory, a project, a plugin, the repository, an admin location, or the built-in system set - used to group, order and label skills and to decide whether one can be deleted. */
export type SkillsScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/** A project workspace whose skills can be listed or added to, identified by `projectId` with optional display name and path; passed into the skills settings UI as the list of selectable project scopes. */
export type SkillsProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** One skill available to a provider, carrying its slash command, description, originating scope and source path plus the owning plugin or project when it came from one. */
export type ProviderSkill = {
  provider: SkillsProvider;
  name: string;
  description: string;
  command: string;
  scope: SkillsScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
  projectDisplayName?: string;
  projectPath?: string;
};

/** One skill to upload, holding its SKILL.md content, the directory and file names to write it under, and any accompanying base64-encoded support files. */
export type ProviderSkillCreateEntryPayload = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: Array<{
    relativePath: string;
    content: string;
    encoding: 'base64';
  }>;
};

// ---------------------------

//----------------- TASK MASTER ------------

/** Identifier of a TaskMaster task or subtask, which TaskMaster may emit as either a number or a string. */
export type TaskId = string | number;

/** One task as returned by TaskMaster, including its status, priority, dependencies, implementation details and nested subtasks. */
export type TaskMasterTask = {
  id: TaskId;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  details?: string;
  testStrategy?: string;
  parentId?: TaskId;
  dependencies?: TaskId[];
  subtasks?: TaskMasterTask[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

/** A minimal pointer to a task, used by callbacks that only need its id and title rather than the full task record. */
export type TaskReference = {
  id: TaskId;
  title?: string;
  [key: string]: unknown;
};

/** A task handed to a click handler, which may be either a complete TaskMasterTask or a lightweight TaskReference. */
export type TaskSelection = TaskMasterTask | TaskReference;

/** A product-requirements document in a project's TaskMaster directory, used both for listing PRDs and for editing their content. */
export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  modified?: string;
  created?: string;
  path?: string;
  size?: number;
  [key: string]: unknown;
};

/** The TaskMaster section of a project record, describing whether the project has been initialised and the status metadata TaskMaster reports for it. */
export type TaskMasterProjectInfo = {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** A Project augmented with the flattened TaskMaster fields (configured flag, status and task counts) that the task board and its callers read directly. */
export type TaskMasterProject = Project & {
  taskMasterConfigured?: boolean;
  taskMasterStatus?: string;
  taskCount?: number;
  completedCount?: number;
  taskmaster?: TaskMasterProjectInfo;
};




/** The layout the task board is currently rendering: kanban columns, a flat list, or a grid. */
export type TaskBoardView = 'kanban' | 'list' | 'grid';

/** The task field the board is currently sorted by. */
export type TaskBoardSortField = 'id' | 'title' | 'status' | 'priority' | 'updated';

/** The direction of the task board's current sort, ascending or descending. */
export type TaskBoardSortOrder = 'asc' | 'desc';

/** One column of the kanban board, pairing its status and display colours with the tasks that belong to it. */
export type TaskKanbanColumn = {
  id: string;
  title: string;
  status: string;
  color: string;
  headerColor: string;
  tasks: TaskMasterTask[];
};

/** A TaskMaster task's lifecycle state; the known values are enumerated and the string fallback tolerates statuses added by newer TaskMaster releases. */
type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'review'
  | 'blocked'
  | 'deferred'
  | 'cancelled'
  | string;

/** A TaskMaster task's priority; high, medium and low are the known values and the string fallback tolerates anything else TaskMaster emits. */
type TaskPriority = 'high' | 'medium' | 'low' | string;

//----------------- VOICE CLIENT ASSETS ------------

/**
 * One file of the browser recogniser's deployment, as the SERVER reads its own disk: whether it is
 * there and how large it is. `expectedBytes` is the pinned size where the front end pins one and null
 * otherwise. Produced by the client-assets reading and consumed when the reason for a refusal is
 * built.
 */
export type VoiceClientAssetFile = {
  name: string;
  present: boolean;
  bytes: number | null;
  expectedBytes: number | null;
};

/**
 * The server's reading of the browser recogniser's model directory: whether one is configured, which
 * environment variable supplied it (`VOICE_CLIENT_MODEL_DIR`, or the `SENSEVOICE_MODEL_DIR`
 * fallback), and the state of the two files it must hold. `ready` is the server's verdict, true only
 * when both files are present and `model.int8.onnx` is the pinned size. The front end reads this
 * before it downloads anything.
 */
export type VoiceClientReadiness = {
  configured: boolean;
  directory: string | null;
  source: 'VOICE_CLIENT_MODEL_DIR' | 'SENSEVOICE_MODEL_DIR' | null;
  model: VoiceClientAssetFile;
  tokens: VoiceClientAssetFile;
  ready: boolean;
};

/**
 * The same-origin URLs the browser recogniser fetches: the two model-directory files and the
 * onnxruntime-web entry plus its WASM directory prefix. Produced by `voiceClientAssetPaths` from
 * Vite's `BASE_URL`, so a sub-path deployment resolves every one of them under its prefix.
 */
export type VoiceClientAssetPaths = {
  modelUrl: string;
  tokensUrl: string;
  ortScriptUrl: string;
  ortWasmPaths: string;
};

/**
 * One recogniser as the deployment publishes it, kept for the routing decisions that cannot be made
 * from the user's settings alone.
 *
 * WHY THE CLIENT HOLDS THESE ROWS AT ALL. `AsrCapabilities.locality` decides what may happen to a
 * user's audio, and the declarations live in the registry the SERVER compiles; the browser's copy of
 * the registry names the same providers but answers about the browser's own adapters, not about what
 * this deployment can actually serve. The health payload is the one reading that carries both, so it
 * is what the fallback resolver below reads: a recogniser this deployment does not publish is not a
 * recogniser to hand an upload to.
 *
 * `capabilities` and `runtime` are `null` rather than absent for the same reason every other lenient
 * reader in this codebase spells it that way: a row from a server too old to send the field, or one
 * that sent something unreadable, must be visibly unusable rather than silently missing.
 */
export type VoiceProviderRow = {
  id: string;
  label: string;
  configured: boolean;
  capabilities: AsrCapabilities | null;
  runtime: AsrRuntimeStatus | null;
};

// ---------------------------

//----------------- COCKPIT HUB ------------

/**
 * The two roles a cockpit connection announces over the shared chat websocket.
 *
 * A display renders the stage; an input sends direction keys and phrases. The `/cockpit` page
 * announces both on one socket, so a desktop can be watched while a phone drives it.
 */
export type CockpitRole = 'display' | 'input';

/** Which device produced an event; `deviceName` is what the status bar echoes (「来自手机」). */
export type CockpitEventSource = {
  deviceId: string;
  deviceName?: string;
  role: CockpitRole;
};

/** The stage's serializable view description; the project segment is the fleet registry id. */
export type CockpitHubView = { type: 'fleet' } | { type: 'board'; project: string };

/**
 * One project the display can address, with both identities the server's target rules need:
 * the CloudCLI project id the fleet registry is keyed by, and the fleet registry id that
 * appears in a `quay://` address.
 */
export type CockpitVisibleProject = {
  projectId: string;
  fleetProjectId: string | null;
  name: string;
  projectPath: string;
};

/** The display's report of what it is showing: the view address, its objects and its roster. */
export type CockpitVisibleSet = {
  viewUri: string | null;
  focusables: QuayFocusableObject[];
  projects: CockpitVisibleProject[];
};

/** The conversation a pending send would go to, and why that conversation. */
export type CockpitPendingSendTarget = {
  sessionId: string;
  projectId: string | null;
  projectName: string | null;
  sessionTitle: string | null;
  source: 'pinned' | 'recent';
  fleetUnavailableReason: string | null;
};

/**
 * The confirmation card as the hub holds it. `visible` is the DISPLAY's last reported set —
 * the input device's own page is irrelevant — and `target === null` means nothing will be sent.
 */
export type CockpitPendingSend = {
  text: string;
  visible: QuayFocusableObject[];
  viewUri: string | null;
  focusUri: QuayObjectUri | null;
  target: CockpitPendingSendTarget | null;
  reason: 'no-focus' | 'no-session' | null;
};

/** Everything the cockpit knows, as the server broadcasts it on every change. */
export type CockpitHubState = {
  /** Increments on every applied event; two devices compare it to tell whose state is newer. */
  rev: number;
  view: CockpitHubView;
  viewStack: CockpitHubView[];
  focusUri: QuayObjectUri | null;
  tray: QuayObjectUri[];
  history: QuayObjectUri[];
  visible: CockpitVisibleSet;
  pendingSend: CockpitPendingSend | null;
  lastEventSource: CockpitEventSource | null;
};

/** One event this client sends to the hub (the hub stamps the `source` itself). */
export type CockpitHubEvent =
  | { type: 'move'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'zoom'; direction: 'in' | 'out' }
  | { type: 'back' }
  | { type: 'focus'; uri: QuayObjectUri }
  | { type: 'pin' }
  | { type: 'unpin'; uri: QuayObjectUri }
  | { type: 'setView'; view: CockpitHubView }
  | { type: 'utterance'; text: string }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'pinTarget' };

/** The `cockpit.state` frame the server broadcasts (one of `ServerEvent`'s kinds). */
export type CockpitStateFrame = {
  kind: 'cockpit.state';
  state: CockpitHubState;
};

// ---------------------------

//----------------- COMPOSER CHIP STRIP ------------

/**
 * Where one composer chip came from.
 *
 * The three built-in sources are fixed by the strip's order. The trailing
 * `string & {}` keeps those literals autocompleted while letting a source be
 * registered from data alone (the accept contract's synthetic source does this),
 * because the accept entry looks every source up in
 * `SUGGESTION_CHIP_ACCEPT_SOURCES` rather than branching on the name.
 */
export type SuggestionChipSource = 'quoted' | 'model' | 'habit' | (string & {});

/**
 * One chip after the three sources have been merged, deduplicated and ordered.
 *
 * Used by the composer's chip strip and by the accept-descriptor record that
 * decides how each source's acceptance behaves.
 */
export type SuggestionChip = {
  /** Stable React key and option-id suffix: `<source>-<index>`. */
  id: string;
  /** The complete text a click fills into the draft — never the truncated label. */
  text: string;
  /** The source id that selects this chip's accept descriptor. */
  source: SuggestionChipSource;
  /** Index within its own source; the model index is what `picked` reports. */
  index: number;
};

/**
 * The composer chip strip's whole state and callbacks, produced once by the chip
 * hook and handed to `ChatComposer` as a single prop.
 *
 * It exists so the composer takes one object instead of a dozen separate chip
 * props: the strip's visibility, keyboard selection, listbox id, merged chips,
 * the single accept callback, and the Suggest control's enabled/loading/request
 * plus the expansion row all travel together. Consumers are `ChatComposer` and
 * `ChatInterface`.
 */
export type ComposerChipStrip = {
  /** Every display condition holds and at least one chip exists. */
  visible: boolean;
  /** The chip the keyboard is on, or null. Mirrored into `aria-activedescendant`. */
  selectedIndex: number | null;
  /** The listbox id from the chip hook; each option id is derived from it. */
  listId: string;
  /** The merged strip (quoted > model > habit). */
  chips: readonly SuggestionChip[];
  /** The one acceptance entry: fills the chip's text, never sends. */
  onAccept: (chip: SuggestionChip) => void;
  /** Whether the reply-suggestions feature is on and has a message to draw from. */
  suggestionsEnabled: boolean;
  /** A Suggest draw is in flight. */
  suggestionsLoading: boolean;
  /** Asks for a whole new batch; resolves false when the draw failed. */
  onRequestSuggestions: () => void | Promise<boolean>;
  /** The expansion experiment's variant/response chips for the draft in the box. */
  expansionChips: readonly string[];
  /** Accepts one variant/response chip: replaces the body, keeping a `> quote` prefix. */
  onAcceptExpansionChip: (text: string, index: number) => void;
};

// ---------------------------

//----------------- REPLY SUGGESTIONS ------------

/**
 * The public reading of the reply-suggestions feature, from `GET /api/reply-suggestions/status`.
 *
 * Carries no key and no path on purpose: the composer only needs to know whether the feature is
 * on and how much text a chip may hold, and the server owns everything else.
 */
export type ReplySuggestionsStatus = {
  /** False means the composer neither extracts nor draws the Suggest button. */
  enabled: boolean;
  /** The experimental post-pick expansion switch: `vary` makes a picked chip expand into variants. */
  expansion: 'off' | 'vary';
  /** Most model chips one draw may return. */
  maxChips: number;
  /** Longest chip text one draw may return, before the client's own label truncation. */
  maxChipChars: number;
};

/** One completed draw, from `POST /api/reply-suggestions`. `draw` names the batch later events refer to. */
export type ReplySuggestionsResult = {
  /** Complete reply texts, already deduplicated and capped by the server. */
  chips: string[];
  /** Local to this session; the ledger events refer to it. */
  draw: number;
};

/**
 * The text an expansion draw is anchored on: `seed` is the reply the person
 * already picked (it asks for variants), `focus` is the quoted passage with no
 * reply of their own yet (it asks for responses). Reported on a `picked` event
 * so the ledger can tell the two apart; the anchored text itself is not stored.
 */
export type ReplySuggestionsExpansionSource = 'seed' | 'focus';

/** The pointer/outcome events the composer reports on `POST /api/reply-suggestions/events`. */
export type ReplySuggestionsEventName = 'picked' | 'cleared' | 'redrawn' | 'sent';

/** One ledger event; `index` is present only when a specific chip was picked. */
export type ReplySuggestionsEventInput = {
  sessionId: string;
  draw: number;
  event: ReplySuggestionsEventName;
  index?: number;
  /** Present only when the picked chip came from an expansion draw. */
  source?: ReplySuggestionsExpansionSource;
};

/**
 * One request for a draw; `redraw` asks for a fresh batch, `focus` is the transcript text to centre on.
 *
 * `expand: true` marks the experimental post-pick expansion: `seed` then asks for
 * variants of the picked reply, and a `focus` with no seed asks for responses to
 * that passage. The server refuses both shapes unless `expansion` is `vary`.
 */
export type ReplySuggestionsRequest = {
  sessionId: string;
  redraw?: boolean;
  focus?: string;
  seed?: string;
  expand?: boolean;
};

// ---------------------------
