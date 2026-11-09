
import type {
  QuayBlockerSummary,
  QuayDriverState,
  QuayFanInSummary,
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuayInFlightTask,
  QuayTestsSummary,
} from '@/shared/types.js';

import type { QuayFleetAvailability } from '../fleet/quay-fleet-project-id.js';

/**
 * The read-only vocabulary the quay display paths publish: the compact task index, the fleet
 * summary, the lanes-only reading and the Tier-1 detection shape. The TTL/ceiling constants
 * live beside the types they bound.
 *
 * Consumers: `read/` (the readers produce them), `service/` (the caches age them) and the
 * module barrel, which re-exports the ones the MCP gateway / cockpit / observation layers
 * type their own contracts against.
 */

/**
 * How long a project's compact task status index stays fresh. Past this the index
 * is reported `stale` — the previous reading is still SERVED, aged and labelled,
 * which is what lets a reader tell "the server has not looked lately" from "the
 * server has never looked" without spawning a CLI to find out.
 */
export const QUAY_TASK_INDEX_TTL_MS = 120_000;

/** The minimum interval between two index loads for the SAME project. */
export const QUAY_TASK_INDEX_MIN_INTERVAL_MS = 60_000;

/**
 * How many projects may load their index at once, across the whole process. A
 * burst of readers over a cold workspace is bounded to this many `quay` children
 * rather than one per project.
 */
export const QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS = 2;

/**
 * The largest index stdout accepted. The quay repository's own reading is about
 * 1.36 MB; this ceiling is far above any real store and far below the point where
 * a single stdout would be a memory problem, and an over-size reading is refused
 * whole rather than half-applied.
 */
export const QUAY_TASK_INDEX_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** How much of a task title the compact index keeps. */
export const QUAY_TASK_INDEX_TITLE_LIMIT = 80;

/**
 * How long one project's fleet-summary reading stays fresh. The summary is polled by
 * the sidebar; inside this window a repeat request must cost zero CLI spawns. Two
 * minutes is long enough that a busy front end polls the store at most a few times a
 * minute, and short enough that a flipped task reaches the badge promptly.
 */
export const QUAY_FLEET_SUMMARY_TTL_MS = 120_000;

/**
 * How many projects the fleet summary may read at once. Measured on a real fleet, four
 * concurrent `quay` reads take roughly the wall clock of one (the host absorbs the
 * parallelism) but their CPU and memory grow linearly, so this bounds the fan-out
 * rather than letting a twenty-project workspace spawn twenty children in one burst.
 */
export const QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS = 4;

/**
 * One task row of the compact status index: what `changes` needs to notice a
 * transition and to say when it happened, and nothing else. The whole task
 * document (body, children, extra) is deliberately absent — the index is built
 * from `task list --json --no-body` precisely so a status poll cannot carry one.
 */
export type QuayTaskStatusRow = {
  taskId: string;
  status: string;
  /** The record's own last-write instant as ISO-8601, or `null` when it carries none. */
  updatedAt: string | null;
  /** The task title, truncated to {@link QUAY_TASK_INDEX_TITLE_LIMIT} characters. */
  title: string;
  /**
   * The record's `goal_ac` (an AC id), or `null` when it carries none. Optional because a row
   * carried only by the event path (a transition with no title and no goal_ac) never saw a full
   * load's record; every consumer defaults a missing value to `null`. The MCP `changes` reading
   * never reads this field, so its outward document is unchanged.
   */
  goalAc?: string | null;
};

/**
 * Where a project's task status index stands. `cold`/`warming` mean nothing has
 * ever been read (`warming` = a load is in flight); `ready`/`stale` are a real
 * reading inside / past its freshness window; `error` means the last load failed.
 */
export type QuayTaskIndexState = 'cold' | 'warming' | 'ready' | 'stale' | 'error';

/**
 * One project's compact task status index as a READER sees it — produced without
 * ever loading, so a read path can never be made to wait on a subprocess.
 */
export type QuayTaskIndexReading = {
  state: QuayTaskIndexState;
  /** Always `full`: every task the store has, never a page of ten. */
  coverage: 'full';
  /** How many tasks the last successful load saw (0 before one succeeds). */
  taskCount: number;
  /** When the last successful load observed the index (epoch ms), or `null`. */
  observedAtMs: number | null;
  /** Every task's last known status, keyed by task id. Empty until the first success. */
  tasks: ReadonlyMap<string, QuayTaskStatusRow>;
  /** Why the last load failed; present only while `state` is `error`. */
  reason?: string;
};

//----------------- FLEET SUMMARY ------------

/**
 * The task status counts one project contributes to the fleet summary. This is the
 * `--no-body` reading, narrowed to the five numbers the sidebar badge renders, so a
 * fleet request can never carry a task body (contrast {@link QuayTaskCounts}, whose
 * `byStatus`/`recent` serve the Tier-2 panel).
 */
export type QuayFleetTaskCounts = {
  total: number;
  todo: number;
  ready: number;
  needsHuman: number;
  done: number;
};

/**
 * The compact per-project reading behind one cockpit `PulseStrip`.
 *
 * It is deliberately NOT a `QuaySnapshot`: a fleet tile needs the four pulse rows (in-flight,
 * fan-in, suite, blockers) and nothing else, so the fleet fan-out skips the goals / ADRs / config
 * / dashboard reads a full snapshot performs. Every source is the same one the Quay panel's cards
 * read, so the strip's counts cannot disagree with the cards.
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
 * One project's entry in the fleet summary. `driver`, `tasks` and `error` describe a
 * single reading taken together, so a consumer never mixes sections of two reads.
 */
export type QuayFleetProjectSummary = {
  projectId: string;
  projectPath: string;
  /**
   * The project's quay-fleet REGISTRY id — the only project segment a `quay://` reference may
   * mint. `null` means the root is not registered in the fleet, so this project declares no
   * addressable objects (falling back to the Cloudpit UUID would mint a reference the fleet
   * cannot dereference).
   */
  fleetProjectId: string | null;
  /**
   * The worker driver reading, or `{ state: 'unavailable' }` when that command did not
   * answer. `unavailable` is deliberately its own state rather than `stale`: a failed
   * read is "no reading", not the observation that the driver is not alive.
   */
  driver: { state: QuayDriverState | 'unavailable' };
  tasks: QuayFleetTaskCounts;
  /**
   * The compact pulse reading behind this tile's `PulseStrip`. Optional so an older cached
   * entry remains readable; `null` is "the pulse could not be read", not "idle".
   */
  pulse?: QuayPulseSummary | null;
  /** `true` when this entry was served from the per-project TTL cache. */
  cached: boolean;
  /** Why this project's reading failed, or `null` when both commands answered. */
  error: string | null;
};

/**
 * The eager, cheap cross-project reading behind the sidebar's task-count badges:
 * driver state plus task status counts for every project with a `.quay/config.yml`.
 * It deliberately carries no goal, in-flight or gantt section — those stay on the
 * lazy Tier-2 snapshot, which is only read when a project is opened.
 */
/**
 * The context-event stream's state, reported beside the fleet's own availability.
 *
 * Declared structurally here rather than imported from `modules/context-events`:
 * the quay module must not acquire an inbound dependency on the stream module,
 * and this reading is a plain value. The composition root binds the two.
 */
export type QuayContextEventsStatus = {
  state: 'ok' | 'schema-unavailable';
  reason: string | null;
  schemaPath: string | null;
  eventsDir: string;
  writes: number;
  rejected: number;
};

export type QuayFleetSummary = {
  projects: QuayFleetProjectSummary[];
  /**
   * Whether this host could ask quay-fleet at all.
   *
   * A summary read while the CLI is missing still carries every project's quay CLI reading
   * (driver + task counts); what it cannot carry is a registry identity for ANY of them. The
   * UI must say that once, as "quay-fleet is not available (set QUAY_FLEET_BIN)", instead of
   * rendering each tile as an individually unregistered project.
   */
  fleet: QuayFleetAvailability;
  generatedAt: string;
  /** How long one project's cached reading stays fresh. */
  ttlPerProjectMs: number;
  /** `true` only when every project in the response came from the TTL cache. */
  cached: boolean;
  /**
   * The context-event writer's state ("the reading beside fleet-summary"), or
   * `null` when the composition does not bind the stream at all. `schema-
   * unavailable` is the honest state on a host whose fleet release predates the
   * schema — the stream is then writing zero events, which is exactly what this
   * field must say.
   */
  contextEvents: QuayContextEventsStatus | null;
};

/**
 * The lanes-ONLY reading behind the workspace title bar's always-on mini gantt.
 *
 * It is deliberately not a `QuaySnapshot`: a pulse strip sits on every tab of the title bar, so
 * the reading it polls must cost one `quay lanes` child and nothing else. The snapshot would
 * spawn the task/goal/ADR/driver/config reads on the same poll, none of which the strip plots.
 * `gantt` / `ganttUnavailable` carry exactly the snapshot's fields and failure semantics, so a
 * strip and the Loop pulse card can never disagree about the same window.
 */
export type QuayLanesReading = {
  ok: true;
  gantt: QuayGanttLanes | null;
  ganttUnavailable: QuayGanttUnavailableReason | null;
  /** When this reading was assembled (ISO-8601). */
  generatedAt: string;
};

/** Tier-1 reading: whether a project directory carries a `.quay/config.yml`. */
export type QuayProjectStatus = {
  projectId: string;
  projectPath: string;
  hasQuayConfig: boolean;
};
