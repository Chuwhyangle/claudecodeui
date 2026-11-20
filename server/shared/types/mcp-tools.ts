import type { ChatRunSource } from './primitives.js';
import type { DeliveryEntry } from './delivery.js';

// --------------------------- MCP tool-package shared types ------------

// The types below were re-homed from the feature modules that used to own them
// (proposal `docs/proposals/mcp-gateway-tool-architecture.md` stage 1) so the
// stage-2 domain tool packages can depend on `server/shared/**` alone. Each
// owning module re-exports its former definitions unchanged, so every existing
// consumer keeps reading the same shape from the same barrel.

/**
 * The phase of a session's turn, each value named for the signal that produces
 * it. `idle` is the absence of a turn (before the first frame, or after the
 * turn's `result`).
 *
 * - `thinking`  — a `system/thinking_tokens` estimate arrived.
 * - `writing`   — a text `content_block_delta` (the normalizer's `stream_delta`)
 *                 is in flight.
 * - `tool`      — a `tool_use` block was emitted and its paired `tool_result`
 *                 has not arrived.
 * - `awaitingPermission` — a `permission_request` is outstanding.
 * - `compacting` — a `system/compact_boundary` arrived.
 */
export type TurnPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'awaitingPermission' | 'compacting';

/**
 * What a caller reads back for one session.
 *
 * `toolName` is the `name` of the pending `tool_use` block (or `null`); it is
 * never derived from a lookup table or a clock. `toolDurationMs` is the tool's
 * elapsed time when a frame carries one — `null` otherwise, and always `null`
 * today because no captured run emitted a `tool_progress` frame.
 */
export type TurnState = {
  phase: TurnPhase;
  toolName: string | null;
  toolDurationMs: number | null;
};

/** One call's arguments: how long to wait, and which single device to ask. */
export type UiStateRequestOptions = {
  /** Overrides {@link UI_STATE_REQUEST_DEFAULT_TIMEOUT_MS} for this call. */
  timeoutMs?: number;
  /** Ask only this device's tabs; omitted means every connected device. */
  deviceId?: string;
};

/**
 * The answer the stop-task control plane's driver call gives.
 *
 * `requested` means the provider driver was called and its call settled — the
 * request was placed, and nothing about the task's state is claimed.
 * `unsupported` means no driver could carry it (the capability is off, the
 * session is not resident and has no per-run runtime, or the live process
 * exposes no stop verb). `timeout` means the driver call did not settle inside
 * its bound, and `error` means it threw. The three failure values are
 * deliberately distinct: a caller that conflated "cannot" with "did not finish"
 * would report a process-less session as a slow one.
 */
export type ControlStopTaskOutcome = 'requested' | 'unsupported' | 'timeout' | 'error';

/**
 * Read-only facts about one run, looked up by the run's own id.
 *
 * Deliberately *not* the internal `ChatRun`: a caller addressing a run by id
 * needs its identity and lifecycle and nothing else, and handing out the
 * internal record would leak the live `writer` and the event buffer it could
 * still mutate. Consumed by this module's criterion
 * (`server/modules/websocket/tests/chat-run-by-id.test.ts`) and, through the
 * module barrel, by the MCP gateway's `overview` tool (AC-247), which types the
 * aborted-run reading of `listRecentRuns` against it.
 */
export type ChatRunSummary = {
  runId: string;
  sessionId: string;
  source: ChatRunSource;
  status: 'running' | 'completed' | 'aborted';
  startedAt: number;
  completedAt: number | null;
  lastSeq: number;
};

/**
 * Why a `getRunById` lookup returned no summary.
 *
 * `expired` means the run existed and stayed terminal past the retention
 * window; `unknown` means the id was never handed out. The two are kept apart
 * so a caller can distinguish "you waited too long" from "that id is not
 * ours". Consumed by the same criterion as `ChatRunSummary`.
 */
export type ChatRunLookupMiss = {
  status: 'unknown';
  reason: 'expired' | 'unknown';
};

/**
 * The result of a run lookup by id: the run's summary, or a typed miss.
 * Consumed by the same criterion as `ChatRunSummary`.
 */
export type ChatRunLookupResult = ChatRunSummary | ChatRunLookupMiss;

/**
 * The authoritative activity snapshot for one session: what the server knows the
 * session is doing, stamped with who is saying it and when.
 *
 * This is the record the whole activity protocol moves. A client never assembles
 * it by patching deltas — the server hands the *whole* thing on every change (see
 * `recordChange`) and hands the same whole thing over REST to a client that joins
 * late, so the two paths cannot disagree about what the session's activity is. The
 * fields are:
 *
 *  - `sessionId` — the app session id the client subscribes with. It is carried in
 *    the body (not only in the URL) so a frame and a snapshot are the same shape
 *    whether they arrive over the socket or over HTTP.
 *  - `bootId` — the identity of the running process, the same value the heartbeat
 *    frames carry, so a client can tell "the server restarted" from "the session
 *    is busy". It is *the same* value by construction: this module reads the one
 *    `BOOT_ID` the heartbeat owns rather than generating a second one.
 *  - `rev` — the session's monotonic activity revision. It is the single number
 *    that lets a client tell a continuous stream from one with a hole in it, and it
 *    has exactly one producer in the process (see `readActivityRevision`).
 *  - `asOf` — the instant the snapshot was produced, read from the injected
 *    `now()`. The protocol has no local clock of its own: every timestamp here is
 *    whatever the injected reader answered, so a criterion can pin it and a
 *    caller cannot be surprised by a value that came from `Date.now()` anyway.
 *  - `turn` — the session's turn phase, from the providers module's reduction,
 *    joined with the identity of the turn's run when the driver knows one
 *    ({@link ActivitySnapshotTurn}). Transported, not computed here.
 *  - `tasks` / `schedules` — the session's live task and schedule projections. Their
 *    internal shape belongs to the reducers that own them (AC-191 / AC-192); this
 *    module only carries whatever the injected readers answer, which is why the
 *    element type is `unknown` rather than a shape redefined here.
 *  - `deliveries` — the session's accepted deliveries, in send order: what is
 *    still queued or running, plus every one that ended inside the retention
 *    window (SPEC §7.1). This is the one projection whose *element* shape this
 *    file names, because it is the channel's own contract rather than a reducer's
 *    private record: a client draws a pending row and settles it from exactly
 *    these ten facts, and a reader that had to discover the shape from the
 *    producer would be reading a copy of it.
 *
 *    Optional in the *type*, and only there. Every snapshot this module builds
 *    carries it — `buildSnapshot` reads it from the reader unconditionally — but a
 *    frame-shaped literal written by a caller (a criterion injecting a
 *    hand-built frame to prove a client ignores an unplaceable one) is still a
 *    well-formed frame without it, and requiring the field would have made this
 *    channel's arrival edit criteria whose subject is not this channel. A reader
 *    that needs the queue reads `snapshot.deliveries ?? []`.
 */
export type ActivityProtocolSnapshot = {
  sessionId: string;
  bootId: string;
  rev: number;
  asOf: number;
  turn: ActivitySnapshotTurn;
  tasks: unknown[];
  schedules: unknown[];
  deliveries?: DeliveryEntry[];
};

/**
 * The session's turn as the snapshot carries it: the phase reduction, plus the
 * run the turn IS when a driver on the run=turn path can name one (SPEC §7.1).
 *
 * The two extra fields are optional on purpose. The phase belongs to the
 * providers module's tracker and is known for every session; the run identity
 * belongs to whoever opened the run, and a session whose turns are one process
 * each (or whose driver has not bound a turn yet) has no run to state. Stating
 * them as a separate, optional half is what lets one snapshot serve both, and it
 * is why a reader that injected its own turn reduction is not made to invent a
 * run id it does not have.
 */
export type ActivitySnapshotTurn = TurnState & {
  /** The run this turn is executing as, when the driver has bound one. */
  runId?: string | null;
  /** When that run was opened, by the driver's clock. */
  startedAt?: number | null;
};

/** Driver summary rendered by the sidebar badge and the Tier-2 panel header. */
export type QuayDriverState = 'running' | 'idle' | 'stale';

export type QuayDriverSummary = {
  state: QuayDriverState;
  alive: boolean;
  running: boolean;
  lastRecordAt: string | null;
};

/**
 * One row of a per-entity detail list (tasks, goals or ADRs). Only the fields the
 * panel renders are kept; the source command returns whole documents (body,
 * children, extra, …) which would bloat every snapshot response.
 */
export type QuayListItem = {
  id: string;
  title: string;
  status: string;
  /**
   * The row's last-updated instant as ISO-8601, converted from the epoch
   * **milliseconds** the CLI prints (`1786439928515.85`), or `null` when the
   * record carried no usable timestamp. This is the value the list is ranked by,
   * so the panel can show the ordering key instead of an invisible one. It is
   * never epoch 0 (`1970-01-01T00:00:00.000Z`) for a missing reading, and never
   * an `Invalid Date` string.
   */
  updatedAt: string | null;
};

export type QuayTaskCounts = {
  total: number;
  byStatus: Record<string, number>;
  ready: number;
  needsHuman: number;
  done: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` tasks, most recently updated first. */
  recent: QuayListItem[];
};

/** Goal counts read from `quay goal list --json`; the panel shows the stage breakdown. */
export type QuayGoalCounts = {
  total: number;
  achieved: number;
  /** Per-status grouping plus the most recent goals, for the panel's "Stage goals" card. */
  breakdown: QuayGoalBreakdown;
};

/**
 * Stage-goals card payload: how many goals sit in each status the CLI reports,
 * plus the most recently updated goals as display rows.
 */
export type QuayGoalBreakdown = {
  /** Counts keyed by the CLI's own status string (`active`/`achieved`/`draft`/`superseded`/…). */
  byStatus: Record<string, number>;
  /** Up to `QUAY_RECENT_LIST_LIMIT` goals, most recently updated first. */
  recent: QuayListItem[];
};

export type QuayAdrCounts = {
  total: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` ADRs, most recently updated first. */
  recent: QuayListItem[];
};

/**
 * Current full-suite reading from `.quay/full-suite-state.json`, rendered as the
 * "current" half of the Tests card. `null` means no run state is on disk — a
 * normal "nothing running" state, never a warning.
 */
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

/** One history round projected from `.quay/verification-round.jsonl`; the heavy per-file detail is dropped. */
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

/**
 * One merged in-flight-or-historical run interval for the Loop pulse gantt.
 *
 * Field-for-field what quay's `dashboard-kernel` publishes as `LiveGanttInterval`, as they
 * arrive inside the read-only `quay lanes --json` document. This is re-declared rather than
 * imported from the plugin because the plugin is an external, per-project artifact resolved
 * at runtime — the shape is the contract, and the verb is what supplies the values.
 */
export type QuayGanttInterval = {
  taskId: string;
  runId: string;
  startMs: number;
  endMs: number;
  phase: string | null;
  finalState: string | null;
  fanInOutcome: string | null;
};

/**
 * Loop pulse card payload: the document `quay lanes --json` prints for one time window
 * (quay's `packLanes` output, plus the window it was selected at and the clock it was read).
 *
 * `overflow` counts the intervals that found no free lane. quay deliberately does not drop
 * them, so `lanes` alone does NOT account for the whole window whenever it is non-zero —
 * a consumer must render the count or it silently loses runs.
 */
export type QuayGanttLanes = {
  windowHours: number;
  nowMs: number;
  lanes: QuayGanttInterval[][];
  overflow: number;
};

/**
 * Why a Loop pulse lane reading is missing, when it is.
 *
 * The card must not collapse every missing reading into one sentence: "the installed plugin has
 * no `lanes` verb" is the normal state of an un-upgraded project, while "the verb ran and its
 * document could not be read" is a read failure. Different facts about different things, and the
 * reader acts differently on each — one calls for an upgrade, the other for a retry.
 */
export type QuayGanttUnavailableReason = 'plugin-lacks-lanes-verb' | 'lanes-read-failed';

/** One fan-in attempt projected from `.quay/worker-outcome.jsonl`. */
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
 * How one Tests / Fan-in reading was obtained, reported beside the reading itself.
 *
 * The four carrier states are quay's own (`quay suite` / `quay driver log` publish them), passed
 * through untouched. The last two are this side's: `verb-unavailable` is the honest reading of an
 * older pinned CLI that does not have the verb at all, and `failed` is a body that came back but
 * could not be read as the documented document. Neither is ever drawn as "no records" — a failed
 * read is not an empty history.
 */
export type QuayCarrierReading = {
  state: 'ok' | 'absent' | 'unreadable' | 'empty-writer-zero-records' | 'verb-unavailable' | 'failed';
  /** Why the reading is what it is, or `null` when the state needs no explanation. */
  reason: string | null;
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
 * One of quay's published in-flight phases — the values its `dashboard-kernel` marks a live
 * interval with (`LIVE_INTERVAL_PHASES`). Re-declared rather than imported because the plugin
 * is an external, per-project artifact resolved at runtime; the set is the contract.
 */
export type QuayInFlightPhase = 'implementing' | 'fan-in' | 'awaiting-land' | 'landed';

/**
 * One task currently in flight, as the Loop pulse gantt plots it — the SAME set the "In
 * flight" card renders, so the two readings can never disagree about which tasks are running.
 *
 * The task set and `phase` come from quay's own `lanes` reading (its `readLive`, which merges
 * the worker-round carrier, worker-outcome history and live worker processes, and drops tasks
 * that have already landed). The project's `.quay/worker-round.jsonl` heartbeat carrier
 * supplies ONLY the supplementary fields the card adds on top of that set — the task's ISO
 * dispatch instant, the reading's heartbeat, and the worker-driver process id — so this
 * projection opens no second in-flight state machine and can never contradict the chart.
 *
 * Consumer: the MCP `quay_snapshot` tool (`mcp-overview-tools.ts`) surfaces the whole
 * list as `snapshot.inFlight`, and the Quay panel's "In flight" card renders it.
 */
export type QuayInFlightTask = {
  taskId: string;
  /**
   * The in-flight phase quay's lane interval carries for the task. It is relayed from that
   * interval (which quay derives from its own signals, including an unreleased fan-in lock),
   * never re-derived here — so it always equals the phase the Loop pulse card draws for the
   * same interval.
   */
  phase: QuayInFlightPhase;
  /** The task's dispatch instant (ISO) from the round record's per-task start map, or the lane interval's start when it carries none. */
  startedAt: string | null;
  /**
   * The reading's heartbeat instant (ISO): the round record's `ts` when the carrier has one,
   * otherwise the lane clock's own read instant. When the round carrier is what has gone quiet
   * this value lags `generatedAt`, which is exactly the staleness the card marks.
   */
  lastHeartbeat: string;
  /**
   * The worker-driver loop's own process id from the round record — the `--kind worker`
   * instance, NOT a per-task child/session pid (the carrier holds no per-task pid). `null`
   * when the record carries none.
   */
  workerPid: number | null;
};

export type QuayConfigIssueCounts = {
  total: number;
  errors: number;
};

/**
 * The contracts a `quay-fleet --version --json` handshake declares. The server compares them
 * with the versions it supports; the CLI's `version` string is informational only.
 */
export type QuayFleetContracts = {
  wallUri: string;
  registry: number;
  interfaceSession: string;
};

/**
 * How this server's fleet-CLI locator reads the host.
 *
 * `missing` and `incompatible` are hard failures (no fleet handle may be minted); `no-handshake`
 * stays usable during the transition (an older fleet that does not answer `--version`).
 */
export type QuayFleetCliState = 'ok' | 'missing' | 'incompatible' | 'no-handshake';

/** The locator's complete reading, carried by the fleet summary and by every snapshot. */
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
 * Where the resolved quay CLI came from, in resolution-priority order.
 *
 * - `override` — the SERVER settings file's `quay.entrypoints` entry for this project root.
 * - `local` / `project` / `user` — a Claude Code plugin install record at that scope.
 * - `legacy-pin` — `<projectRoot>/.quay/plugin`, accepted only when it does not point into the
 *   Claude plugin cache (a developer's own pinned checkout).
 * - `path` — the bare `quay` on the server process's `PATH` (the warned last resort).
 */
export type QuayEntrypointSource = 'override' | 'local' | 'project' | 'user' | 'legacy-pin' | 'path';

/**
 * Which quay binary this panel's reads actually went through.
 *
 * Diagnostic only: it answers "which CLI produced this snapshot?" without the panel having to
 * infer it from a project-level symlink. Carried as an OPTIONAL snapshot field so an older
 * backend or a cached snapshot reads as "not reported" rather than as "no entrypoint".
 */
export type QuayEntrypointDiagnostic = {
  /** Absolute path of the spawned binary, or the bare `quay` for the PATH fallback. */
  path: string;
  /** The install's version carrier (`VERSION`/plugin manifest/record), or `''` when unknown. */
  version: string;
  /** The rule that selected it. */
  source: QuayEntrypointSource;
};

/**
 * How the quay kernel the loop is RUNNING compares with the quay version installed for
 * this host, as `quay driver status --kind worker --json` reports it in `loaded_version`.
 *
 * The four states are mutually exclusive readings, not a numeric scale: `current` means
 * the running kernel's version equals the installed one, `behind` means it is older,
 * `ahead` means it is newer (a source checkout running ahead of the registry), and
 * `not-evaluated` means quay could not take the reading at all (dead host, unreadable
 * run record). `not-evaluated` is deliberately NOT an alias for `current`: a reader must
 * never render "could not tell" as "up to date".
 */
export type QuayLoopVersionRelation = 'current' | 'behind' | 'ahead' | 'not-evaluated';

/**
 * The running kernel vs. installed version reading for the loop's anchor.
 *
 * `loaded` and `installed` are the raw version strings the CLI printed (`null` when the
 * field was absent or not a string — an absent version is unknown, never `0.0.0`).
 * `relation` is the four-state {@link QuayLoopVersionRelation}; an unknown or missing
 * `loaded_version` reads `not-evaluated`, never `current`. `reason` explains why the
 * relation could not be evaluated and is `null` only when the CLI gave a determinate
 * relation.
 */
export type QuayLoopKernel = {
  /** The version the running kernel reports it loaded (e.g. `0.22.0`), or `null` when unread. */
  loaded: string | null;
  /** The version installed on this host (e.g. `0.22.0`), or `null` when unread. */
  installed: string | null;
  /** The four-state comparison; `not-evaluated` is never collapsed into `current`. */
  relation: QuayLoopVersionRelation;
  /** Why `relation` is `not-evaluated`; `null` when the relation is determinate. */
  reason: string | null;
};

/**
 * quay's own reading of `<project>/.quay/plugin` — the symlink the project's commands and
 * drivers resolve through — against the core plugin root the running kernel belongs to.
 *
 * `state` follows the same four-state vocabulary as {@link QuayLoopVersionRelation}:
 * `current` when the link points at the kernel's own version, `behind`/`ahead` when it
 * points at an older/newer one, and `not-evaluated` when quay could not read the link or
 * a version (or reported a value this reader does not recognise). `linkVersion` is the
 * version of the plugin the link pins, `coreVersion` the version of the kernel's root;
 * either is `null` when unread. The whole object is `null` when the driver status carried
 * no `pointer` segment at all (an older CLI), which reads as "not reported", never as
 * "current".
 */
export type QuayLoopPointer = {
  /** Four-state link-vs-core reading, never defaulting an unknown value to `current`. */
  state: QuayLoopVersionRelation;
  /** Version of the plugin pinned by `<project>/.quay/plugin`, or `null` when unread. */
  linkVersion: string | null;
  /** Version of the core plugin root the running kernel belongs to, or `null` when unread. */
  coreVersion: string | null;
};

/**
 * Whether Claude Code has marked the running kernel's version directory for deletion.
 *
 * `marked` means the version directory carries `.orphaned_at` and Claude Code's background
 * cleanup will delete it once the retention window passes — the loop's scripts disappear
 * with it. `none` means the directory carries no marker. `not-evaluated` means the marker
 * exists but could not be read or held no millisecond timestamp. `not-applicable` means
 * `loaded_kernel` does not live under the plugin cache (e.g. a scratch build), so orphan
 * marking cannot apply. `not-evaluated` and `not-applicable` are never `none`.
 */
export type QuayLoopOrphanState = 'none' | 'marked' | 'not-evaluated' | 'not-applicable';

/**
 * The orphan-marker reading for the kernel directory the loop is running from.
 *
 * `markedAt` is when Claude Code recorded the marker, as ISO-8601, and `removeAfter` is
 * the documented retention deadline (`markedAt` + 14 days) after which the directory may
 * be deleted. Both are `null` unless `state` is `marked`.
 */
export type QuayLoopOrphan = {
  /** Whether the running kernel's version directory is orphan-marked (see above). */
  state: QuayLoopOrphanState;
  /** Marker timestamp as ISO-8601, or `null` unless `state` is `marked`. */
  markedAt: string | null;
  /** `markedAt` + 14 days (Claude Code's documented retention), or `null` unless `marked`. */
  removeAfter: string | null;
};

/**
 * Whether each quay driver kind is drained (halted) in this project.
 *
 * `true` means the control file's `halted` flag is set — the driver accepts no new work;
 * `false` means the file says it is running, or the file does not exist (never drained);
 * `null` means the file exists but its JSON is unreadable or `halted` is not a boolean.
 * `null` is never folded into `false`: "cannot tell" and "running" are different facts.
 */
export type QuayLoopDrain = {
  /** Worker-dispatch halt flag (`.quay/worker-control.json`). */
  worker: boolean | null;
  /** Promotion-dispatch halt flag (`.quay/promotion-control.json`). */
  promotion: boolean | null;
  /** Quality-dispatch halt flag (`.quay/quality-control.json`). */
  quality: boolean | null;
};

/**
 * The loop's OVERALL running-status reading: what version the kernel the loop is running
 * from actually is, whether the project's `.quay/plugin` pointer agrees, whether the
 * drivers are drained, and whether Claude Code is about to delete the very directory the
 * loop runs from.
 *
 * This is a separate, purely additive projection of the SAME `driver status --kind worker
 * --json` document plus two small file reads — it costs no extra subprocess. A missing or
 * `null` reading on {@link QuaySnapshot.loop} means "the loop status was not read", which
 * must never be rendered as "everything is normal": every field here has an explicit
 * unknown state (`not-evaluated` / `null`) for exactly that reason.
 */
export type QuayLoopStatus = {
  /** PID of the anchor process the loop runs under, or `null` when the CLI did not report it. */
  anchorPid: number | null;
  /** Running-kernel vs. installed-version reading. */
  kernel: QuayLoopKernel;
  /** The project's `.quay/plugin` pointer reading, or `null` when the CLI carried no pointer segment. */
  pointer: QuayLoopPointer | null;
  /** Per-kind drain (halt) flags; a `null` member means that kind's flag could not be read. */
  drain: QuayLoopDrain;
  /** Whether the running kernel's version directory is orphan-marked for deletion. */
  orphan: QuayLoopOrphan;
  /** When this reading was taken, as ISO-8601 from the service clock. */
  observedAt: string;
};

/**
 * Everything the Tier-2 panel renders, assembled from whitelisted read-only
 * commands. A section is `null` when its command failed or returned unparseable
 * output; the failure is recorded in `warnings` rather than thrown, so one
 * misbehaving subcommand never blanks the whole panel.
 */
export type QuaySnapshot = {
  projectId: string;
  projectPath: string;
  /**
   * The CLI this snapshot's reads went through, when the backend reports it. OPTIONAL so a
   * cached snapshot written before this field existed reads as "not reported", never as
   * "no CLI"; `null` is a deliberately reported "could not resolve".
   */
  entrypoint?: QuayEntrypointDiagnostic | null;
  /**
   * The host-level fleet CLI reading for this snapshot, from the shared locator.
   *
   * OPTIONAL because the Tier-2 cache can hold a snapshot written before this field existed;
   * absent is "not reported", never "the CLI is missing". The panel uses it to state ONE cause
   * (missing / incompatible / no-handshake) instead of repeating 「未登记到 quay-fleet」 per card.
   */
  fleet?: QuayFleetCliReading;
  /**
   * The project's quay-fleet registry id, joined from the fleet registry by matching the
   * project root. It is the ONLY project segment a `quay://` reference may carry: the fleet
   * dereferences by its own registry id, so Cloudpit's project UUID would read `unknown-project`
   * there. `null` means the root is not registered with quay-fleet, and the panel then declares
   * no addressable objects (「未登记到 quay-fleet」) rather than minting a UUID reference.
   */
  fleetProjectId?: string | null;
  generatedAt: string;
  cached: boolean;
  driver: QuayDriverSummary | null;
  /**
   * The loop's overall running-status reading (kernel version, `.quay/plugin` pointer,
   * drain flags, orphan countdown), projected from the SAME `driver status` document the
   * `driver` field comes from plus two file reads.
   *
   * OPTIONAL and nullable so a snapshot cached before this field existed — or a request
   * whose `driver status` read failed — reads as "not reported", never as "the loop is
   * healthy". Absent and `null` are equivalent.
   */
  loop?: QuayLoopStatus | null;
  tasks: QuayTaskCounts | null;
  goals: QuayGoalCounts | null;
  adrs: QuayAdrCounts | null;
  configIssues: QuayConfigIssueCounts | null;
  /** Tests card: the current suite run plus recent history rounds, read from `.quay/` carrier files. */
  tests: QuayTestsSummary;
  /** Fan-in card: recent mechanical fan-in attempts, read from `.quay/worker-outcome.jsonl`. */
  fanIn: QuayFanInSummary;
  /**
   * How the two readings above were obtained. OPTIONAL and nullable so an older cached snapshot
   * reads as "not reported": absent is never "ok", because a snapshot written before this field
   * carried no carrier reading to report.
   */
  carrierReadings?: {
    suite: QuayCarrierReading;
    fanIn: QuayCarrierReading;
  };
  /**
   * Pulse strip's blocked row: the live obstructions in this project's task store, merged by
   * failure signature (see `QuayBlockerSummary`). OPTIONAL and nullable so an older backend /
   * cached snapshot reads as "not reported": absent or `null` is an unread store, `[]` is a read
   * store with nothing blocked — the two must never be collapsed.
   */
  blockers?: QuayBlockerSummary[] | null;
  /**
   * Tasks the worker currently has in flight, taken from the SAME `lanes` reading the Loop
   * pulse gantt plots (quay's `readLive`, which drops already-landed tasks) so the card and the
   * chart cannot disagree. `null` = no reading: the `lanes` verb failed or the installed plugin
   * predates it. `[]` = read, and nothing is running. The two are deliberately distinct — the
   * same null-vs-empty convention `tests.current` and `driver` follow — so "could not read" is
   * never shown as "nothing running".
   */
  inFlight: QuayInFlightTask[] | null;
  /**
   * Loop pulse card: the packed gantt lanes for this project's recent worker runs, as printed
   * by quay's own read-only `quay lanes --json` verb — which merges quay's live telemetry with
   * its worker-outcome history and packs the result onto the fixed five lanes using quay's own
   * kernel. `null` = the reading could not be produced: the installed plugin predates the
   * `lanes` verb, or the verb failed to read its carriers. A null is never "no runs": an unread
   * lane set and a genuinely idle window are different readings, and only the second means
   * nothing ran (the same convention `inFlight` and `tests.current` follow).
   */
  gantt: QuayGanttLanes | null;
  /**
   * Why `gantt` is null, when it is: the installed plugin has no `lanes` verb, or the verb ran
   * and its document was unreadable. `null` when `gantt` is present. The two are kept distinct
   * (they are different facts — an un-upgraded plugin vs. a failed read) so the panel can state
   * the actual reason rather than one generic sentence.
   */
  ganttUnavailable?: QuayGanttUnavailableReason | null;
  /**
   * Link to quay's own `quay serve` dashboard, when a live web service is
   * reported for this project. `null` when no dashboard is running — an absent
   * dashboard is a normal state, never a warning.
   */
  dashboardUrl: string | null;
  warnings: string[];
};

