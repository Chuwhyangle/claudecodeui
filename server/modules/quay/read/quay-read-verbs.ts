
import type { QuayGanttInterval, QuayGanttLanes } from '@/shared/types.js';

import { QUAY_FAN_IN_READ_COMMAND, QUAY_SUITE_READ_COMMAND } from './quay-suite-fanin-reader.js';

/**
 * The READ-VERB surface: the exact-match read-only command whitelist, the validated
 * `task log` transition read, the Loop pulse window set and the `lanes` payload parser.
 * Nothing here spawns anything — the whitelist is a predicate the service's runner consults
 * before a child is started.
 *
 * Consumers: `service/` (the guarded runner and the gantt read) and the module barrel
 * (`isReadOnlyQuayCommand` / `normalizeGanttWindowHours` / `readGanttLanes` are driven by
 * criteria).
 */

/**
 * The windows the Loop pulse card offers, in hours — quay's own set, with quay's own default.
 * A window is a *data* filter (the interval set is re-selected), never a visual zoom.
 */
export const QUAY_GANTT_WINDOW_HOURS = [1, 3, 6, 12] as const;
export const DEFAULT_QUAY_GANTT_WINDOW_HOURS = 3;

/**
 * Coerces a requested window to one this card offers, falling back to the default.
 *
 * The set is closed deliberately: the window drives how far back the history read and the
 * packing go, and the card has a button for exactly these four values. Anything else — a
 * negative, a fraction, a string from a stray query param — reads as "not a window I offer"
 * rather than being honoured, so a malformed request can never widen the read.
 */
export function normalizeGanttWindowHours(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_QUAY_GANTT_WINDOW_HOURS;
  }
  return (QUAY_GANTT_WINDOW_HOURS as readonly number[]).includes(parsed)
    ? parsed
    : DEFAULT_QUAY_GANTT_WINDOW_HOURS;
}

export function readGanttLanes(value: unknown): QuayGanttLanes | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const payload = value as { windowHours?: unknown; nowMs?: unknown; lanes?: unknown; overflow?: unknown };
  if (
    typeof payload.windowHours !== 'number' || !Number.isFinite(payload.windowHours)
    || typeof payload.nowMs !== 'number' || !Number.isFinite(payload.nowMs)
    || typeof payload.overflow !== 'number' || !Number.isFinite(payload.overflow)
    || !Array.isArray(payload.lanes)
  ) {
    return null;
  }

  const lanes: QuayGanttInterval[][] = [];
  for (const lane of payload.lanes) {
    if (!Array.isArray(lane)) {
      return null;
    }
    const intervals: QuayGanttInterval[] = [];
    for (const entry of lane) {
      const interval = readGanttInterval(entry);
      if (interval === null) {
        return null;
      }
      intervals.push(interval);
    }
    lanes.push(intervals);
  }

  return { windowHours: payload.windowHours, nowMs: payload.nowMs, lanes, overflow: payload.overflow };
}

/** One lane bar, or `null` when any documented field is missing or mistyped. */
function readGanttInterval(value: unknown): QuayGanttInterval | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.taskId !== 'string'
    || typeof entry.runId !== 'string'
    || typeof entry.startMs !== 'number' || !Number.isFinite(entry.startMs)
    || typeof entry.endMs !== 'number' || !Number.isFinite(entry.endMs)
  ) {
    return null;
  }
  return {
    taskId: entry.taskId,
    runId: entry.runId,
    startMs: entry.startMs,
    endMs: entry.endMs,
    phase: typeof entry.phase === 'string' ? entry.phase : null,
    finalState: typeof entry.finalState === 'string' ? entry.finalState : null,
    fanInOutcome: typeof entry.fanInOutcome === 'string' ? entry.fanInOutcome : null,
  };
}

const QUAY_DRIVER_KINDS = ['promotion', 'worker', 'outer', 'quality', 'meta', 'goal'] as const;

/**
 * Leading argv of the Loop pulse card's `lanes` read — `quay lanes --json …`.
 *
 * ⛔ `--json` must stay FIRST, and this is not a style choice. quay's dispatcher splits the
 * argv as `[cmd, sub, ...rest]` and runs `parseFlags` over `rest` only, so whatever token
 * follows `lanes` is swallowed as the sub-command and never reaches the flag parser. Written
 * the other way round (`lanes --window-hours 12 --json`) the verb silently falls back to the
 * default 3 h window — measured against quay 0.19.0's real CLI, whose own help line
 * (`quay lanes [--json] [--window-hours N] [--root <path>]`) does not disclose the ordering.
 * With `--json` first, `sub` is a harmless marker the `lanes` handler ignores and both
 * options parse.
 */
export const QUAY_LANES_PREFIX = ['lanes', '--json'] as const;

/**
 * The complete read-only command whitelist.
 *
 * `runQuayCommand` accepts an argv only when it equals one of these arrays
 * element-by-element, so no caller — and therefore no frontend request — can
 * reach a write command (`task create/edit/check`, `driver start/stop`,
 * `gate run`, `promote/retreat`, …). Widening the display surface means adding
 * an entry here; every entry must stay a read-only verb.
 *
 * `server status --json` is deliberately absent. It was the one source of the
 * panel's optional dashboard link, but answering it costs ~4 s of its own
 * driver-kind subprocesses — for one `web` host/port that the `.quay/server.json`
 * carrier already records. The dashboard reading now reads that carrier and
 * probes the recorded address directly, so the command is no longer reachable at
 * all rather than merely uncalled.
 */
export const QUAY_READ_ONLY_COMMANDS: readonly (readonly string[])[] = [
  // The capability probe's one read: `--help` lists the verbs a project's pinned CLI has.
  // It is only ever used to answer "does `task log` / `lanes` exist", never to read state.
  ['--help'],
  ['config', 'validate', '--json'],
  ['task', 'list', '--json'],
  // The compact status index behind `changes` (AC-348): the same read with the
  // whole task document dropped. It is a SEPARATE exact-match entry rather than a
  // flag appended to the row above, so "no body" is the only widening this list
  // has taken and every other flag combination is still refused by equality.
  ['task', 'list', '--json', '--no-body'],
  ['goal', 'list', '--json'],
  ['adr', 'list', '--json'],
  // The Tests and Fan-in cards' readings. quay 0.24.0 publishes both as bounded JSON from its
  // own readers, so Cloudpit no longer parses `.quay/` carrier files itself. Exact-match entries
  // (no prefix rule): the window is part of the reading, and any other flag combination is
  // refused before a child is spawned.
  QUAY_SUITE_READ_COMMAND,
  QUAY_FAN_IN_READ_COMMAND,
  ...QUAY_DRIVER_KINDS.map((kind) => ['driver', 'status', '--kind', kind, '--json']),
  // The Loop pulse gantt's packed lanes, printed by quay's own read-only `lanes` verb — which
  // merges quay's live telemetry with its worker outcome history and packs the result onto the
  // fixed five lanes itself, so this service neither merges nor packs. The window is an enum,
  // so each offered value is its own exact-match entry rather than a prefix rule: the
  // whitelist stays an equality check, and a stray window can never widen the read.
  ...QUAY_GANTT_WINDOW_HOURS.map((hours) => [...QUAY_LANES_PREFIX, '--window-hours', String(hours)]),
];

/**
 * The largest `--limit` the transition read accepts (quay's own cap). A value above it would
 * be refused by the CLI itself, so the whitelist refuses it before any child is spawned.
 */
const QUAY_TASK_LOG_MAX_LIMIT = 500;

/** A strict-enough ISO-8601 instant: the date/time shape `task log --since` documents. */
function isIso8601Instant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

/**
 * The cursor shape `task log --since` accepts: exactly `{v, carrierEpoch, seq}` with the
 * documented types. Extra keys are refused on purpose — the CLI itself tolerates them, but a
 * caller that widened the cursor could smuggle a fourth field through a read-only boundary.
 */
function isTaskLogCursorArg(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.includes('v') || !keys.includes('carrierEpoch') || !keys.includes('seq')) {
    return false;
  }
  return record.v === 1
    && typeof record.carrierEpoch === 'string'
    && record.carrierEpoch.length > 0
    && typeof record.seq === 'number'
    && Number.isInteger(record.seq)
    && record.seq >= 0;
}

/**
 * Structural validation of the transition read:
 * `task log --json --since <ISO8601|cursor> --limit <1..500>`.
 *
 * This is deliberately NOT a prefix rule. A prefix match on `task` would accept
 * `task create` / `task edit` / `task check`; every token here is pinned by position, every
 * value is validated, and one extra token refuses the whole argv.
 */
function isTaskLogReadCommand(args: readonly string[]): boolean {
  if (args.length !== 7) {
    return false;
  }
  return args[0] === 'task'
    && args[1] === 'log'
    && args[2] === '--json'
    && args[3] === '--since'
    && (isIso8601Instant(args[4]) || isTaskLogCursorArg(args[4]))
    && args[5] === '--limit'
    && /^\d+$/.test(args[6])
    && Number(args[6]) >= 1
    && Number(args[6]) <= QUAY_TASK_LOG_MAX_LIMIT;
}

/** True when `args` is exactly one whitelisted read-only command (or the validated task-log read). */
export function isReadOnlyQuayCommand(args: readonly string[]): boolean {
  if (isTaskLogReadCommand(args)) {
    return true;
  }
  return QUAY_READ_ONLY_COMMANDS.some(
    (allowed) =>
      allowed.length === args.length
      && allowed.every((value, index) => value === args[index]),
  );
}
