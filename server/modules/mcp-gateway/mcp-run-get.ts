/**
 * The MCP gateway's `run_get` handler (AC-248).
 *
 * `run_get` reads one run by id and, when asked, waits a BOUNDED time for it to
 * settle. Everything it reads is injected ({@link McpRunGetDeps}): the run
 * registry (lookup + the boot the run was created under), the activity store
 * (turn phase and pending tool), the provider sessions service (history, for the
 * closing assistant message and the miss fallback), and — this is the point —
 * the clock and the sleeper. The wait loop moves ONLY through `deps.now()` and
 * `deps.sleep()`, never `Date.now()`/`setTimeout` directly, so a criterion can
 * drive it on a fake clock and assert "returned before the full budget" as a
 * number rather than by waiting.
 *
 * Three readings, and what each establishes:
 *
 *  - a HIT (`ChatRunSummary`) is the run's summary plus its live turn phase and
 *    pending tool from the activity store; a settled run additionally carries its
 *    session's last assistant message.
 *  - a MISS is an ERROR (AC-287): the `runId` named nothing this process has, so
 *    the handler throws `RUN_NOT_FOUND` — an `isError` envelope whose `message`
 *    is the cause's own explanation and whose `details` carries
 *    `{ idKind, runId, deliveryId, reason, bootId, fallback }`. `reason` is
 *    `'expired'` for a run that aged out of retention AND for `restarted` (a
 *    previous boot's run: the id no longer names anything this process has),
 *    `'never_issued'` for an id that was never handed out. The `fallback` read —
 *    the named session's recent messages, verbatim — rides in `details` so a
 *    caller still gets the context the old success-shaped miss carried.
 *  - a WAIT returns as soon as one of three things happens — the run reaches a
 *    terminal state, its turn parks on `awaitingPermission`, or the deadline
 *    passes — and never sleeps for a requested `waitSeconds` above
 *    {@link MCP_RUN_GET_MAX_WAIT_SECONDS}. `waitSeconds` absent or `0` returns
 *    the current state without a single `sleep` call: the whole wait loop lives
 *    inside the `waitSeconds > 0` branch, so "immediate" is structural.
 *
 * AC-386 adds the DUAL-ID reading (SPEC §8.2): the id may name a run OR a
 * delivery, and the two spaces do not intersect — a `runId` is minted by the run
 * registry, a `deliveryId` is the `commandUuid` the host minted for a frame — so
 * naming both is a parameter error rather than a preference. Read by delivery,
 * `waitSeconds` waits for the DELIVERY's terminal (`completed` | `cancelled`, the
 * one definition in the host driver) rather than the run's, which is the question
 * a caller actually has: C-3 makes a delivery's terminal and its turn's `RESULT`
 * two independent events, so a turn can hold an already-terminal delivery (a
 * folded command) and a `RESULT` can precede a command's terminal. The reading
 * carries the bound turn's closing assistant message and the turn's `phase` /
 * `pendingTool`, and a `cancelled` delivery states the ledger's own `reason`.
 *
 * `expired` / `unknown` have no record to read a session from (that is exactly
 * what `getRunById` refusing them means), so their fallback target is the
 * caller's optional `session` argument; `restarted` reads it from the summary
 * the lookup DID return. When no session can be named at all the fallback says
 * so in words (its `note`), and the envelope is still thrown — the error is the
 * missing run, not the missing fallback.
 *
 * Cross-module vocabulary comes through the barrels (`ActivityProtocolSnapshot`,
 * `ChatRunLookupResult` from the websocket module). `formatMcpTime` is AC-245's
 * one time renderer — reused rather than restated. The import edge to
 * `mcp-gateway.read-tools.js` closes a cycle whose only members are hoisted
 * function declarations, none read at module-evaluation time, so it cannot
 * touch an uninitialised binding (the overview module avoids the cycle only
 * because it needs nothing but types from the sibling).
 */

import { z } from 'zod';

import type {
  NormalizedMessage,
  ResidentDeliveryLookup,
  ResidentDeliveryLookupReason,
} from '@/shared/types.js';
import type { ActivityProtocolSnapshot, ChatRunLookupResult } from '@/modules/websocket/index.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import { formatMcpTime } from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam, McpTime } from './mcp-gateway.read-tools.js';

// --------------------------- limits and vocabulary ---------------------------

/**
 * The ceiling on how long `run_get` will actually wait, in seconds.
 *
 * The ONE literal for the cap: a request for longer waits this many seconds and
 * no more, so an MCP client cannot pin a request handler open indefinitely. The
 * sibling `session_send` (AC-249) imports this constant rather than writing a
 * second copy.
 */
export const MCP_RUN_GET_MAX_WAIT_SECONDS = 25;

/** How long one wait iteration sleeps before re-reading the run. */
const MCP_RUN_GET_TICK_MS = 250;

/** How many recent messages a settle/miss read takes from history. */
const MCP_RUN_GET_HISTORY_LIMIT = 20;

/** Why a wait returned. Present only when the caller asked to wait. */
export type McpRunGetOutcome = 'settled' | 'awaitingPermission' | 'cancelled' | 'timeout';

/**
 * Which id space a `run_get` call was resolved through (SPEC §8.2).
 *
 * The two spaces do not intersect — a `runId` is minted by the run registry and
 * a `deliveryId` is the `commandUuid` the host minted for a frame — so a call
 * names exactly one of them and the reading says which. It rides on the miss's
 * `details` too, which is the point of it there: a caller who passed the wrong
 * kind of id can see that is what happened rather than only that nothing was
 * found.
 */
export type McpRunGetIdKind = 'run' | 'delivery';

/**
 * Why a by-id read found no run, as the `RUN_NOT_FOUND` envelope reports it
 * (AC-287's two values).
 *
 * `expired` covers both a run aged out of retention and a run belonging to a
 * previous boot; `never_issued` covers an id nothing ever handed out.
 */
export type McpRunGetMissReason = 'expired' | 'never_issued';

/**
 * The INTERNAL cause of a miss, which picks the sentence.
 *
 * Three causes, two reportable reasons: `restarted` is a fourth reading — a run
 * whose record still exists but belongs to another boot — and it reports
 * `'expired'` because the id no longer names anything this process has, while
 * its SENTENCE still says the service restarted. Keeping the cause separate
 * from the report lets the prose stay precise where the reason is coarse.
 */
type McpRunGetMissCause = 'expired' | 'unknown' | 'unknown_delivery' | 'restarted';

const EXPLANATION_EXPIRED = 'This run existed but is past its retention window; its result can no longer be retrieved.';
const EXPLANATION_UNKNOWN = 'This runId was never issued.';
const EXPLANATION_UNKNOWN_DELIVERY = 'This deliveryId was never issued.';
const EXPLANATION_RESTARTED = 'The service restarted; this run belongs to a previous boot.';

const EXPLANATION_BY_CAUSE: Record<McpRunGetMissCause, string> = {
  expired: EXPLANATION_EXPIRED,
  unknown: EXPLANATION_UNKNOWN,
  unknown_delivery: EXPLANATION_UNKNOWN_DELIVERY,
  restarted: EXPLANATION_RESTARTED,
};

/** The reportable reason each internal cause maps onto. */
const REASON_BY_CAUSE: Record<McpRunGetMissCause, McpRunGetMissReason> = {
  expired: 'expired',
  unknown: 'never_issued',
  unknown_delivery: 'never_issued',
  restarted: 'expired',
};

/** The note carried when a session's activity store has no snapshot for it. */
const NO_ACTIVITY_NOTE = 'This session has no activity record.';
/** The note carried when a settled run's session yields no assistant message. */
const NO_ASSISTANT_MESSAGE_NOTE = 'This run has ended, but the session has no readable assistant message.';
/** The note carried when a miss cannot name a session to fall back to. */
const NO_FALLBACK_SESSION_NOTE = 'No session can be determined, so there is nothing to fall back to.';

// --------------------------- injected services ---------------------------

/**
 * The services `run_get` answers from, all injected.
 *
 * `runs.getRunBootId` is the run's creation boot (compared against
 * `bootId()` to detect a restart); `activity.snapshot` supplies the turn phase
 * and pending tool; `sessions.fetchHistory` supplies the closing assistant
 * message and the miss fallback; `deliveries.lookupById` resolves a
 * `deliveryId` to the ledger's own record of it (AC-386). `sleep` is the wait
 * loop's only clock advance, and `now` its only time read — neither is optional,
 * so production's real timers and a criterion's fake ones are the same code path.
 */
export type McpRunGetDeps = {
  runs: {
    getRunById(runId: string): ChatRunLookupResult;
    /** The boot the run was created under, or `null` when the registry no longer holds it. */
    getRunBootId(runId: string): string | null;
  };
  activity: {
    snapshot(sessionId: string): ActivityProtocolSnapshot | null;
  };
  sessions: {
    fetchHistory(sessionId: string, options: { limit: number }): Promise<{ messages: NormalizedMessage[] }>;
  };
  /**
   * The ledger's by-id delivery reading (SPEC §8.2), when this mount has one.
   *
   * Optional so a mount that predates the delivery-id arm stays a valid deps
   * bag — the same compatibility direction `McpReadToolDeps.sessions.readSessionById`
   * takes. Production supplies `lookupResidentDeliveryById`; a mount without it
   * answers every delivery id as a miss, which is the honest reading of a
   * process whose reads cannot see a ledger.
   */
  deliveries?: {
    lookupById(deliveryId: string): ResidentDeliveryLookup | null;
  };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The current process identity; a run whose boot differs from this has been restarted past. */
  bootId: () => string;
};

// --------------------------- payload ---------------------------

/** A miss's fallback read: the named session and the messages it yielded. */
export type McpRunGetFallback = {
  session: string | null;
  messages: NormalizedMessage[];
  /** Why there are no messages (no session named, or the read returned none). */
  note: string | null;
};

/** A run summary, with the activity reading and (on settle) the closing message. */
export type McpRunGetHit = {
  /** Which id space resolved this reading (SPEC §8.2). */
  idKind: McpRunGetIdKind;
  /**
   * The run id: the run's own on a run read, or the run the delivery's turn is
   * executing as (SPEC §5.2). `null` for a delivery with no turn yet — a state
   * the caller can tell apart from "not found" because the read is a HIT.
   */
  runId: string | null;
  /** The delivery named, on a delivery read; `null` on a run read. */
  deliveryId: string | null;
  sessionId: string;
  source: string;
  status: 'running' | 'completed' | 'aborted' | 'cancelled';
  /** The activity store's turn phase, or `null` when it has no snapshot. */
  phase: string | null;
  /** The pending tool's name, or `null`. */
  toolName: string | null;
  /** Set only when the activity store has no snapshot for the session. */
  activityNote: string | null;
  startedAt: McpTime;
  completedAt: McpTime | null;
  elapsedMs: number;
  bootId: string;
  /** Present only when the caller asked to wait; names why the wait returned. */
  outcome?: McpRunGetOutcome;
  /** Why a `cancelled` delivery ended; `null` for a clean completion or a run read. */
  reason: ResidentDeliveryLookupReason | null;
  /** The session's last assistant message, attached when the run settled or the delivery ended. */
  lastAssistantMessage: NormalizedMessage | null;
  /** Why a field is absent in words (no assistant message), else `null`. */
  note: string | null;
  /** Always `null` on a hit — the field exists so "no explanation" is a value, not a missing key. */
  explanation: null;
};

/**
 * What a `RUN_NOT_FOUND` envelope carries in `details` (AC-287): which id was
 * named and in WHICH space (`idKind`, SPEC §8.2), why it names nothing live, the
 * boot that answered, and the best-effort fallback read. The old
 * `status: 'unknown'` member is gone — a miss is no longer a success payload
 * with a status, it is an error with details.
 */
export type McpRunGetMiss = {
  /** Which id space the miss was read in: a caller can see it named the wrong kind. */
  idKind: McpRunGetIdKind;
  /** The id the caller named, in the space `idKind` names. */
  runId: string | null;
  /** The delivery id the caller named, on a delivery miss. */
  deliveryId: string | null;
  /** Why the id names nothing this process has, as AC-287 spells it. */
  reason: McpRunGetMissReason;
  /** The current process boot, so a caller can see which boot it was told from. */
  bootId: string;
  /** The fallback read: the named session and the messages it yielded, verbatim. */
  fallback: McpRunGetFallback;
};

/** The `run_get` tool's SUCCESS result — always a hit; a miss is thrown. */
export type RunGetPayload = McpRunGetHit;

// --------------------------- input ---------------------------

/**
 * The `run_get` tool's typed input.
 *
 * `runId` and `deliveryId` are MUTUALLY EXCLUSIVE (SPEC §8.2): the two uuid
 * spaces do not intersect, so naming both is a contradiction rather than a
 * preference, and {@link readRunGetInput} refuses it as a parameter error. At
 * least one of the two must be present. `session` is not a third addressing
 * mode — it is the fallback target a miss reads recent messages from, and it is
 * legal alongside either id.
 */
export type McpRunGetInput = {
  runId?: string;
  deliveryId?: string;
  waitSeconds?: number;
  /** Fallback target when no run is found (see the module doc). */
  session?: string;
};

/** Which id space a parsed input addresses, or `null` when it names neither. */
function readIdKind(input: McpRunGetInput): McpRunGetIdKind | null {
  if (input.runId !== undefined) {
    return 'run';
  }
  return input.deliveryId === undefined ? null : 'delivery';
}

/** The one-sentence refusal for an argument combination SPEC §8.2 forbids. */
const BOTH_IDS_MESSAGE =
  'Name only one of "runId" and "deliveryId"; they address different id spaces and cannot be combined.';
const NEITHER_ID_MESSAGE = 'One of "runId" or "deliveryId" is required and must be a non-empty string.';

/**
 * Reads and validates `run_get`'s arguments.
 *
 * The mutual exclusion is checked HERE as well as declared in the tool's input
 * schema (`mcp-gateway.read-tools.js`): a direct caller of the builder bypasses
 * the schema, and SPEC §8.2's "同时给出为参数错误" has to hold on the handler's own
 * path or it is only a wire-level courtesy. Both arms throw the same
 * `INVALID_ARGUMENT` envelope.
 */
function readRunGetInput(args: Record<string, unknown>): McpRunGetInput {
  const runId = readNonEmptyString(args.runId);
  const deliveryId = readNonEmptyString(args.deliveryId);
  if (runId !== undefined && deliveryId !== undefined) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, BOTH_IDS_MESSAGE, false, {
      fields: [{ path: 'deliveryId', problem: 'cannot be combined with "runId"' }],
    });
  }
  if (runId === undefined && deliveryId === undefined) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, NEITHER_ID_MESSAGE, false, {
      fields: [{ path: 'runId', problem: 'required' }],
    });
  }
  const waitSeconds =
    typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) ? args.waitSeconds : undefined;
  const session = typeof args.session === 'string' && args.session.length > 0 ? args.session : undefined;
  return { runId, deliveryId, waitSeconds, session };
}

/** A non-empty string argument, or `undefined` for anything else. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

// --------------------------- reading a hit ---------------------------

/**
 * Projects a found run onto its reading. Async only because a settled run's
 * session history is fetched; the other outcomes attach no history (the wait
 * ended for a reason other than the run settling, so there is no "last message"
 * to mean).
 */
async function buildHit(
  runId: string,
  deps: McpRunGetDeps,
  summary: Extract<ChatRunLookupResult, { runId: string }>,
  outcome: McpRunGetOutcome | undefined,
): Promise<McpRunGetHit> {
  const snapshot = deps.activity.snapshot(summary.sessionId);
  const at = deps.now();

  let lastAssistantMessage: NormalizedMessage | null = null;
  let note: string | null = null;
  if (outcome === 'settled') {
    const history = await deps.sessions.fetchHistory(summary.sessionId, { limit: MCP_RUN_GET_HISTORY_LIMIT });
    const assistant = [...history.messages].reverse().find((message) => message.role === 'assistant');
    if (assistant === undefined) {
      note = NO_ASSISTANT_MESSAGE_NOTE;
    } else {
      lastAssistantMessage = assistant;
    }
  }

  return {
    idKind: 'run',
    runId: summary.runId,
    deliveryId: null,
    sessionId: summary.sessionId,
    source: summary.source,
    status: summary.status,
    // `phase`/`toolName` come from the activity store and nowhere else; a store
    // that has never been told about the session says so in words rather than
    // by dropping the keys.
    phase: snapshot?.turn.phase ?? null,
    toolName: snapshot?.turn.toolName ?? null,
    activityNote: snapshot === null ? NO_ACTIVITY_NOTE : null,
    startedAt: formatMcpTime(summary.startedAt, deps.now),
    completedAt: summary.completedAt === null ? null : formatMcpTime(summary.completedAt, deps.now),
    elapsedMs: Math.max(0, at - summary.startedAt),
    bootId: deps.runs.getRunBootId(runId) ?? deps.bootId(),
    ...(outcome === undefined ? {} : { outcome }),
    reason: null,
    lastAssistantMessage,
    note,
    explanation: null,
  };
}

/**
 * Projects a delivery onto its reading (SPEC §8.2).
 *
 * `status` is the delivery's own terminal (`completed` / `cancelled`) or
 * `running` while it is live; `outcome` names WHY the wait returned, which is a
 * different question from what state the delivery reached. The closing assistant
 * message is attached on a terminal delivery — a cancelled one included, because
 * the delivery's turn still ran and the caller asked what came of it — and the
 * turn's `phase` / `toolName` come from the activity store, exactly as on a run
 * read and for the same reason.
 */
async function buildDeliveryHit(
  delivery: ResidentDeliveryLookup,
  deps: McpRunGetDeps,
  outcome: McpRunGetOutcome | undefined,
): Promise<McpRunGetHit> {
  const snapshot = deps.activity.snapshot(delivery.sessionId);
  const at = deps.now();
  const terminal = isTerminalDeliveryState(delivery.state);
  const startAt = delivery.startedAt ?? delivery.enqueuedAt;

  let lastAssistantMessage: NormalizedMessage | null = null;
  let note: string | null = null;
  if (terminal) {
    const history = await deps.sessions.fetchHistory(delivery.sessionId, { limit: MCP_RUN_GET_HISTORY_LIMIT });
    const assistant = [...history.messages].reverse().find((message) => message.role === 'assistant');
    if (assistant === undefined) {
      note = NO_ASSISTANT_MESSAGE_NOTE;
    } else {
      lastAssistantMessage = assistant;
    }
  }

  return {
    idKind: 'delivery',
    runId: delivery.runId,
    deliveryId: delivery.deliveryId,
    sessionId: delivery.sessionId,
    source: delivery.source,
    status:
      delivery.state === 'completed' ? 'completed' : delivery.state === 'cancelled' ? 'cancelled' : 'running',
    phase: snapshot?.turn.phase ?? null,
    toolName: snapshot?.turn.toolName ?? null,
    activityNote: snapshot === null ? NO_ACTIVITY_NOTE : null,
    startedAt: formatMcpTime(startAt, deps.now),
    completedAt: delivery.endedAt === null ? null : formatMcpTime(delivery.endedAt, deps.now),
    elapsedMs: Math.max(0, at - startAt),
    bootId: deps.bootId(),
    ...(outcome === undefined ? {} : { outcome }),
    reason: delivery.state === 'cancelled' ? delivery.reason : null,
    lastAssistantMessage,
    note,
    explanation: null,
  };
}

/** Whether a delivery's state is one of the two terminals SPEC §8.2 waits for. */
function isTerminalDeliveryState(state: ResidentDeliveryLookup['state']): boolean {
  return state === 'completed' || state === 'cancelled';
}

// --------------------------- reading a miss ---------------------------

/**
 * Throws the `RUN_NOT_FOUND` envelope for a by-id read that found no run.
 *
 * `sessionHint` is the session the lookup itself named (only `restarted` has
 * one, because its record is still returned); otherwise the caller's optional
 * `session` is used. When neither exists the fallback's `note` says so in words
 * — the fallback is best-effort — while the error itself is unconditional: an
 * id that names no run is a reference to nothing (AC-287).
 *
 * The `fallback` read is taken BEFORE the throw, so the envelope's `details`
 * carries the same recent messages the old success-shaped miss carried.
 */
async function buildMiss(
  input: McpRunGetInput,
  deps: McpRunGetDeps,
  cause: McpRunGetMissCause,
  sessionHint?: string,
): Promise<never> {
  const target = sessionHint ?? input.session ?? null;
  let messages: NormalizedMessage[] = [];
  let note: string | null = null;
  if (target === null) {
    note = NO_FALLBACK_SESSION_NOTE;
  } else {
    const history = await deps.sessions.fetchHistory(target, { limit: MCP_RUN_GET_HISTORY_LIMIT });
    messages = history.messages;
  }

  const details: McpRunGetMiss = {
    idKind: readIdKind(input) ?? 'run',
    runId: input.runId ?? null,
    deliveryId: input.deliveryId ?? null,
    reason: REASON_BY_CAUSE[cause],
    bootId: deps.bootId(),
    fallback: { session: target, messages, note },
  };
  throw new McpToolError(MCP_ERROR_CODES.RUN_NOT_FOUND, EXPLANATION_BY_CAUSE[cause], false, details);
}

// --------------------------- buildRunGet ---------------------------

/** The effective wait: a positive finite request, else zero (no waiting). */
function readWaitSeconds(waitSeconds: number | undefined): number {
  return typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 0;
}

/**
 * Reads one run by id, optionally waiting a bounded time for it to settle.
 *
 * The immediate path (`waitSeconds` absent or `0`) reads the run once and
 * returns it: no `sleep` call is reachable from here. The waiting path re-reads
 * the run and its turn on every iteration and returns as soon as the run is
 * terminal (attaching its closing assistant message), the turn parks on
 * `awaitingPermission`, or the deadline passes. The deadline is
 * `now() + min(waitSeconds, {@link MCP_RUN_GET_MAX_WAIT_SECONDS}) * 1000`.
 *
 * A `deliveryId` in place of a `runId` takes {@link buildDeliveryGet}: the same
 * shape of wait, over the delivery's terminal instead of the run's.
 */
export async function buildRunGet(input: McpRunGetInput, deps: McpRunGetDeps): Promise<RunGetPayload> {
  if (input.deliveryId !== undefined) {
    if (input.runId !== undefined) {
      // Unreachable through `readRunGetInput`, which refuses the combination
      // first; kept so a direct caller of the builder cannot silently prefer one.
      throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, BOTH_IDS_MESSAGE, false, {
        fields: [{ path: 'deliveryId', problem: 'cannot be combined with "runId"' }],
      });
    }
    return buildDeliveryGet(input, deps);
  }

  const runId = input.runId;
  if (runId === undefined) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, NEITHER_ID_MESSAGE, false, {
      fields: [{ path: 'runId', problem: 'required' }],
    });
  }

  const initial = deps.runs.getRunById(runId);
  if (initial.status === 'unknown') {
    return buildMiss(input, deps, initial.reason);
  }
  if (isRestarted(runId, deps)) {
    return buildMiss(input, deps, 'restarted', initial.sessionId);
  }

  const waitSeconds = readWaitSeconds(input.waitSeconds);
  if (waitSeconds === 0) {
    return buildHit(runId, deps, initial, undefined);
  }

  const effectiveWaitSeconds = Math.min(waitSeconds, MCP_RUN_GET_MAX_WAIT_SECONDS);
  const deadline = deps.now() + effectiveWaitSeconds * 1000;

  for (;;) {
    const current = deps.runs.getRunById(runId);
    if (current.status === 'unknown') {
      return buildMiss(input, deps, current.reason);
    }
    if (isRestarted(runId, deps)) {
      return buildMiss(input, deps, 'restarted', current.sessionId);
    }
    if (current.status === 'completed' || current.status === 'aborted') {
      return buildHit(runId, deps, current, 'settled');
    }

    const phase = deps.activity.snapshot(current.sessionId)?.turn.phase ?? null;
    if (phase === 'awaitingPermission') {
      return buildHit(runId, deps, current, 'awaitingPermission');
    }

    if (deps.now() >= deadline) {
      return buildHit(runId, deps, current, 'timeout');
    }

    await deps.sleep(MCP_RUN_GET_TICK_MS);
  }
}

/**
 * Reads one DELIVERY by id, optionally waiting a bounded time for its terminal
 * (SPEC §8.2).
 *
 * What the caller is really asking is "has the sentence I sent finished", and
 * that is the delivery's terminal (`completed` | `cancelled`), not the turn's
 * `RESULT`: C-3 makes those two independent events, so a turn can hold an
 * already-terminal delivery (a folded command) and a `RESULT` can arrive before
 * a command's terminal. The wait therefore re-reads the DELIVERY and returns the
 * moment it is terminal, carrying the bound turn's closing assistant message and
 * the activity store's `phase` / `toolName`.
 *
 * The clock is the same injected pair as the run path: the loop advances only
 * through `deps.sleep`, never a real timer, so a criterion drives it on a fake
 * clock and asserts "returned before the full budget" as a number.
 */
async function buildDeliveryGet(input: McpRunGetInput, deps: McpRunGetDeps): Promise<RunGetPayload> {
  const deliveryId = input.deliveryId;
  if (deliveryId === undefined) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, NEITHER_ID_MESSAGE, false, {
      fields: [{ path: 'deliveryId', problem: 'required' }],
    });
  }
  const lookup = (id: string): ResidentDeliveryLookup | null => deps.deliveries?.lookupById(id) ?? null;

  const initial = lookup(deliveryId);
  if (initial === null) {
    return buildMiss(input, deps, 'unknown_delivery');
  }

  const waitSeconds = readWaitSeconds(input.waitSeconds);
  if (waitSeconds === 0) {
    return buildDeliveryHit(initial, deps, undefined);
  }

  const effectiveWaitSeconds = Math.min(waitSeconds, MCP_RUN_GET_MAX_WAIT_SECONDS);
  const deadline = deps.now() + effectiveWaitSeconds * 1000;

  for (;;) {
    const current = lookup(deliveryId);
    if (current === null) {
      return buildMiss(input, deps, 'unknown_delivery');
    }
    if (isTerminalDeliveryState(current.state)) {
      return buildDeliveryHit(current, deps, current.state === 'cancelled' ? 'cancelled' : 'settled');
    }
    if (deps.now() >= deadline) {
      return buildDeliveryHit(current, deps, 'timeout');
    }
    await deps.sleep(MCP_RUN_GET_TICK_MS);
  }
}

/** Whether the stored run belongs to a boot other than the current process. */
function isRestarted(runId: string, deps: McpRunGetDeps): boolean {
  const runBoot = deps.runs.getRunBootId(runId);
  return runBoot !== null && runBoot !== deps.bootId();
}

// --------------------------- registration ---------------------------

/**
 * `run_get`'s metadata, as `registerMcpReadTools` passes it down from the one
 * {@link MCP_STAGE3_READ_TOOLS} table (name / description / scope / schemas), so
 * this module only attaches a real handler to a name the table already owns.
 */
export type McpRunGetRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /**
   * AC-288: passed down from the one stage-3 body table, which holds a raw shape
   * OR a built schema carrying a constraint a raw shape cannot express. `run_get`
   * is the second kind since AC-386: its `runId` / `deliveryId` mutual exclusion
   * is an object-level rule no raw shape can state.
   */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Whether a read-tool deps bag carries a wired `run_get` deps bag.
 * `registerMcpReadTools` uses it to route the `run_get` NAME to the real handler
 * when the composition root supplied one, and to keep the named
 * `MCP_TOOL_NOT_IMPLEMENTED` refusal on a mount that did not (AC-240/244/245's
 * criteria) — the registered name set is unchanged either way.
 */
export function isRunGetWired(deps: McpReadToolDeps): deps is McpReadToolDeps & { runGet: McpRunGetDeps } {
  return deps.runGet !== undefined;
}

/**
 * Registers `run_get` with its real handler through the audited registration
 * seam. Consumers: `registerMcpReadTools`, which routes the one name here when
 * its deps are wired, and the criterion, which drives the seam directly to read
 * back the registered name.
 */
export function registerMcpRunGetTool(
  seam: McpReadToolSeam,
  deps: McpRunGetDeps,
  registration: McpRunGetRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args) => handleRunGet(args, deps),
  });
}

/**
 * `run_get`'s handler as the registration seam installs it: parse the caller's
 * arguments, then read.
 *
 * Exported so a criterion can drive the tool's WHOLE production path — the
 * validation included — without standing up the HTTP transport. The argument
 * rules (SPEC §8.2's mutual exclusion) live in {@link readRunGetInput}, and a
 * builder that skipped it would let the parameter error go unread.
 */
export function handleRunGet(args: Record<string, unknown>, deps: McpRunGetDeps): Promise<RunGetPayload> {
  return buildRunGet(readRunGetInput(args), deps);
}
