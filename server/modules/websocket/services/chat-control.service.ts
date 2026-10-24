import { sessionsDb } from '@/modules/database/index.js';
import type {
  ControlBackgroundTaskOutcome,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import { readSessionDeliveries, readSessionTurnRun } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  assertSessionAccess,
  dispatchRun,
} from '@/modules/websocket/services/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { isRunIdCompatWindowOpen } from '@/shared/types.js';
import type {
  AnyRecord,
  ChatRunSource,
  DeliveryEntry,
  HostQueuedInputCancelResult,
  LLMProvider,
  MissingApprovalReason,
  ProviderPermissionDecision,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { residentRunIsTurn } from '@/shared/utils.js';

/**
 * Who asked for a control action, and through which front end.
 *
 * `userId` is `null` for a caller that was never authenticated — an upgrade with
 * no user attached — and that is exactly the value the shared access entry
 * refuses. It is carried here rather than asserted away at the boundary, so the
 * refusal stays the one entry's decision instead of this service inventing a
 * second check.
 *
 * `via` names the adapter that made the call — the WebSocket gateway, the
 * scheduled-message dispatcher, the MCP gateway, or the Live Voice relay. It is
 * carried so the run this service registers can state its origin
 * (`websocket` → `user`, `scheduled` → `scheduled`, `mcp` → `mcp`,
 * `voice` → `voice`); the adapter does not get to omit
 * it, because a caller that forgot would otherwise be indistinguishable from
 * one that knowingly came in over a socket.
 */
type ControlCaller = {
  userId: string | number | null;
  via: 'websocket' | 'mcp' | 'scheduled' | 'voice';
};

/**
 * The run source each control front end's own `via` names.
 *
 * This mapping is load-bearing, not a convenience: `send` always dispatches
 * with `ws = null` and a null connection override, so `startRun`'s
 * connection-derived default would file every run this service opens as
 * `scheduled` — a `chat.send` that arrived over a socket and an MCP tool call
 * alike. It is written as an exhaustive `Record` rather than a chain of
 * ternaries so a future `via` value is a `tsc` error here, not a call
 * silently recorded under another front end's source.
 */
const SOURCE_BY_VIA: Record<ControlCaller['via'], ChatRunSource> = {
  websocket: 'user',
  scheduled: 'scheduled',
  mcp: 'mcp',
  // The Live Voice relay. It reaches this service through the MCP gateway's
  // `session_send` builder, so without this member a spoken delivery would be
  // recorded as an `mcp` command — the origin a client draws a withdrawable
  // pending row from. See `ActivityDeliverySource`'s `voice` member.
  voice: 'voice',
};

/**
 * The input `send` accepts. `interruptActiveRun` is the scheduled-message
 * semantics: a timer fires knowing it may land on a busy session, and the send
 * outranks whatever is running instead of being refused.
 */
type SendInput = {
  sessionId: string;
  content: string;
  options?: AnyRecord;
  interruptActiveRun?: boolean;
  /**
   * The transport handle a socket front end wants this run's frames streamed
   * to, or `null`/absent for a caller with no live client (scheduled, and the
   * MCP gateway's tools).
   *
   * The control service is transport-free and never sends a frame itself, but a
   * run is only readable live by the socket that asked for it (`chat.send` binds
   * the requesting socket as the run's connection). The WebSocket adapter
   * therefore passes its socket here so the run it dispatches reaches the same
   * audience the old inline `chat.send` did; a timer passes nothing, and the run
   * simply has no live audience until someone subscribes.
   */
  connection?: RealtimeClientConnection | null;
  /**
   * A synchronous notification of the verdict when `send` refuses *before* it
   * can yield — the shared access entry's `FORBIDDEN`, a session that does not
   * exist, a provider with no runtime, or a run already in progress.
   *
   * Every one of those refusals is decided, and every one of them was emitted
   * on the requesting socket, before the adapter existed: the old inline
   * `chat.send` ran `dispatchRun` synchronously up to the refusal, so the
   * `protocol_error` frame was on the wire the instant the frame was handled.
   * Routing the verb through this service moved the decision behind an `await`,
   * and a caller that reports the refusal on that same tick (the WebSocket
   * adapter) needs the verdict back in that same tick or the frame slips a
   * microtask late — which is exactly the reading
   * `server/modules/providers/tests/claude-resident-busy-input.test.ts` takes.
   *
   * This is a *notification*, not a frame: the service still constructs nothing
   * and emits nothing — the caller decides what to do with the verdict, so the
   * seam stays transport-free.
   */
  onRefuse?: (refusal: { code: string; message: string }) => void;
};

/**
 * The value `send` returns. Success is the DELIVERY's id (`deliveryId`), stated
 * the moment the send is accepted, together with the run the turn belongs to
 * (`runId`, or `null` when no turn exists yet and the compatibility window has
 * closed), the run id the registry minted handed back as soon as the run exists
 * — *not* after the turn ends — and whether the turn was written into a provider
 * process that was already running.
 *
 * `queued` is `false` and `queuedMessageUuid` is `null` for the ordinary send;
 * for a resident session's busy send `queued` is `true` and
 * `queuedMessageUuid` is the uuid the provider stamped the message with, which
 * is the id `cancelQueued` withdraws it by. It can still be `null` on a
 * `queued: true` result when the gateway has no seam to name the queued message
 * — the message is queued all the same, but no later withdrawal can address it,
 * so a null is the honest report rather than a fabricated id.
 *
 * On a queued result `queuedMessageUuid` and `deliveryId` are the same command
 * (SPEC §8.1: the former is retained as the latter's alias), so a caller that
 * already withdraws by uuid and a caller that follows by delivery id name the
 * same message.
 *
 * Failure is a value with a stable code, so each adapter can translate it
 * without parsing an exception (the WebSocket handler into a `protocol_error`
 * frame, the MCP gateway into an `isError` tool result).
 */
type SendResult =
  | {
      ok: true;
      /**
       * The id of the DELIVERY this send was accepted as (SPEC §4.1, §8.1) —
       * the `commandUuid` the host minted for the frame it wrote and the CLI
       * echoes back in `command_lifecycle`.
       *
       * Stated for every accepted send, which is the whole point: it is the
       * handle a caller holds to follow or withdraw the message it just handed
       * over, and it exists from the instant the send is accepted rather than
       * from the instant a turn happens to open. `null` only when this layer
       * cannot name it — run=turn off, or a resident host that never recorded
       * the delivery inside the handover bound — because a fabricated id would
       * be worse than a stated absence.
       */
      deliveryId: string | null;
      /**
       * The turn's run id, or `null` when there is no turn to name yet.
       *
       * Per-run providers mint the run with the delivery, so this is always a
       * string for them. A resident send has no turn when it answers; inside the
       * compatibility window (SPEC §8.3) the field is BACKFILLED with the
       * `deliveryId` (`runId === deliveryId` is how a caller recognizes it, and
       * `run_get` accepts either id), and past the window it is stated as
       * `null` rather than invented.
       */
      runId: string | null;
      queued: boolean;
      queuedMessageUuid: string | null;
      /**
       * A promise for the run's own outcome, resolving when the provider turn
       * settles. It is *not* awaited by `send` — the run is already admitted and
       * keeps going — but it is handed back so a caller that must report a
       * failure has somewhere to read it from: the scheduled dispatcher records
       * a failed delivery on the message row, and a crash after registration
       * would otherwise be invisible to it (`send` resolves before the provider
       * has run). `error` is the provider runtime's own failure text, or `null`
       * when the turn completed.
       */
      completion: Promise<{ started: boolean; error: string | null }>;
    }
  | {
      ok: false;
      code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'RUN_IN_PROGRESS' | 'FORBIDDEN';
      message: string;
    };

/**
 * What `abort` returns.
 *
 * Success carries the provider's own answer for the aborted turn — `aborted:
 * true` when a live process was really stopped, `false` when there was nothing
 * to stop — so the verdict is never fabricated here. A refusal is a value with a
 * stable `code` in the same vocabulary `send` uses, so each adapter translates
 * it without parsing an exception; `aborted: false` is stated on every refusal
 * so a caller that only reads that field is told the truth rather than left
 * undefined.
 */
type AbortResult =
  | { ok: true; aborted: boolean }
  | {
      ok: false;
      aborted: false;
      code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'FORBIDDEN';
      message: string;
    };

/**
 * The verdicts a transport-free control verb states before it reaches a driver.
 *
 * `forbidden` is the shared access entry's own word, kept in the lowercase the
 * gateway's control verbs already answer in; the two upper-case codes are the
 * ones `send`/`abort` state for a session that does not exist and a provider
 * with no runtime assembled. Keeping one vocabulary across the string-returning
 * verbs lets an adapter translate any of the five without a per-verb table.
 */
type ControlVerbRefusal = 'forbidden' | 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER';

/** What `stopTask` returns: the driver's outcome vocabulary, or a stable refusal. */
type StopTaskResult = ControlStopTaskOutcome | ControlVerbRefusal;

/** What `backgroundTask` returns: the driver's outcome vocabulary, or a refusal. */
type BackgroundTaskResult = ControlBackgroundTaskOutcome | ControlVerbRefusal;

/**
 * One pending tool approval, as a provider runtime reports it.
 *
 * Structurally the claude runtime's own entry (`claude-runtime.provider.ts`,
 * `getPendingApprovalsForSession`): the request id, the tool name, its raw input,
 * the runtime's opaque `context`, the session it belongs to, and when the
 * request arrived. `receivedAt` is a `Date`, which is what lets an adapter
 * compute "how long has this waited".
 */
type PendingApproval = {
  requestId: string;
  toolName: string;
  input: unknown;
  context: unknown;
  sessionId: string;
  receivedAt: Date;
};

/**
 * What `pendingApprovals` returns.
 *
 * Success carries the (possibly merged) pending entries — an empty array is the
 * normal "nothing is waiting", not an error. A refusal is a value with a stable
 * `code`: `FORBIDDEN` is the shared access entry's word, `SESSION_NOT_FOUND` the
 * same code `send` states for a named session that does not exist.
 */
type PendingApprovalsResult =
  | { ok: true; approvals: PendingApproval[] }
  | { ok: false; code: 'FORBIDDEN' | 'SESSION_NOT_FOUND'; message: string };

/** The input `answerApproval` accepts. */
type AnswerApprovalInput = {
  /** The runtime's id for the approval being decided. */
  requestId: string;
  /** The decision handed to `resolveToolApproval`. */
  allow: boolean;
  /**
   * For an `AskUserQuestion`, the chosen answers. Forwarded as the decision's
   * `updatedInput` — not a field of its own — so it reaches the runtime on the
   * same vocabulary the WebSocket `chat.permission-response` path uses.
   */
  answers?: unknown;
  /** An optional note forwarded alongside the decision. */
  message?: string;
};

/**
 * What `answerApproval` returns.
 *
 * Success is "the decision was handed to the runtime": `resolveToolApproval` has
 * no return value, so there is no second verdict to read and none is invented.
 * `ok:false` is stated ONLY for a request that is no longer in the registry
 * (`APPROVAL_EXPIRED_OR_NOT_FOUND`) or a caller the shared access entry refuses
 * (`FORBIDDEN`); BOTH refuse without calling `resolveToolApproval`, because the
 * in-registry check comes first and the access check before the call.
 *
 * The expired branch carries `reason`, the distinction AC-287 makes the MCP
 * `approval_answer` envelope report: an id the runtime HELD and dropped is
 * `'expired'`, one it never minted is `'never_issued'`. The distinction comes
 * from the runtime's own `classifyMissingApproval` (read through the gateway's
 * optional facet, defaulting to the conservative `'expired'`), never from this
 * service guessing — the live pending map alone cannot tell the two apart.
 *
 * `ALREADY_DECIDED` is a third, DIFFERENT refusal: the request WAS here and
 * another caller settled it first (an MCP peer racing this one, or the browser
 * UI's own `chat.permission-response`). It carries the winning decision's
 * `decidedBy`/`decidedAt` so the loser can report who beat it rather than
 * guess. It is read from the runtime's decision ledger, never inferred: the
 * pending entry a settle removes leaves no other trace, so without the ledger
 * this case would be indistinguishable from `expired`.
 */
type AnswerApprovalResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      code: 'APPROVAL_EXPIRED_OR_NOT_FOUND';
      /** Why the request is absent: held-then-dropped, or never minted here. */
      reason: MissingApprovalReason;
      message: string;
    }
  | {
      ok: false;
      code: 'ALREADY_DECIDED';
      /** Who settled it first — an MCP principal's id, or null when unnamed. */
      decidedBy: string | null;
      /** When that first decision was recorded (epoch ms). */
      decidedAt: number;
      message: string;
    }
  | {
      ok: false;
      code: 'FORBIDDEN';
      message: string;
    };

/**
 * Upper bound on how long `send` waits for the provider to hand over a queued
 * message's uuid before degrading to `queuedMessageUuid: null`.
 *
 * The gateway contract is "resolve once the message has been written into the
 * queue", a synchronous act in the resident drivers, so a healthy driver never
 * reaches this bound; it exists so a gateway whose promise never settles cannot
 * hold a `send` — and the caller that is awaiting it — open forever. Degrading
 * to `null` is the conservative direction: the caller learns the message was
 * queued, but learns honestly that it holds no id to withdraw it by.
 */
const QUEUED_UUID_HANDOVER_TIMEOUT_MS = 2_000;

/**
 * Reads the uuid the provider stamped a just-queued message with, bounded.
 *
 * `null` covers every way the uuid can be unavailable — no seam on the gateway,
 * a seam that answers `null`, a seam that rejects, or one that never settles
 * inside the bound. All of them mean the same thing to the caller: the message
 * is queued, but it cannot be named for withdrawal. A missing seam is never
 * read as an empty-string uuid, because an id no withdrawal can match is worse
 * than a stated absence.
 */
async function readQueuedMessageUuid(
  runtime: ProviderRuntimeGateway,
  provider: LLMProvider,
  sessionId: string,
): Promise<string | null> {
  const read = runtime.queuedInputUuid;
  if (typeof read !== 'function') {
    return null;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), QUEUED_UUID_HANDOVER_TIMEOUT_MS);
      timer.unref?.();
    });
    const uuid = await Promise.race([read.call(runtime, provider, sessionId), bound]);
    return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Upper bound on how long `send` waits for the resident ledger to record the
 * delivery it just accepted before degrading to `deliveryId: null`.
 *
 * The ledger's write is the host's own act on the dispatch's continuation — the
 * control service resolves the send at `beforeRun`, one turn of the loop before
 * the frame is armed — so a healthy driver never reaches this bound; it exists so
 * a host that never records one cannot hold a `send`, and the caller awaiting it,
 * open forever. Degrading to `null` is the conservative direction: the send is
 * still accepted, and the caller learns honestly that this layer cannot name the
 * delivery rather than being handed an id no later call would match.
 */
const DELIVERY_ID_HANDOVER_TIMEOUT_MS = 2_000;

/** How long the handover poll yields the loop between two reads of the ledger. */
const DELIVERY_ID_POLL_INTERVAL_MS = 1;

/** The delivery ids a session's ledger held before a send was dispatched. */
type DeliveryIdSnapshot = ReadonlySet<string>;

/** Reads the ids of the deliveries a session's resident ledger already holds. */
function deliveryIdsBefore(sessionId: string): DeliveryIdSnapshot {
  return new Set(readSessionDeliveries(sessionId).map((entry) => entry.deliveryId));
}

/**
 * The delivery a send just created, as the session's resident ledger records it.
 *
 * The identity is the ledger's by construction (SPEC §4.2: `commandUuid` has one
 * production surface, the host), so this is the one place this layer can learn it
 * without inventing a second surface. "The newest entry the ledger did not hold
 * when the send began" is the correlation this layer has — a dispatch states no
 * token the host would echo back — and a send is appended rather than inserted,
 * so the delivery being named is the newest one.
 *
 * Bounded, and `null` on every failure: no entry inside the bound, or a session
 * no resident host of this process has ever served.
 */
async function readAcceptedDelivery(
  sessionId: string,
  before: DeliveryIdSnapshot,
): Promise<DeliveryEntry | null> {
  const deadline = Date.now() + DELIVERY_ID_HANDOVER_TIMEOUT_MS;
  for (;;) {
    const fresh = readSessionDeliveries(sessionId).filter((entry) => !before.has(entry.deliveryId));
    const newest = fresh.at(-1);
    if (newest !== undefined) {
      return newest;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DELIVERY_ID_POLL_INTERVAL_MS);
      timer.unref?.();
    });
  }
}

/**
 * The seams the control service is assembled from.
 *
 * `runtime` is the same provider gateway the WebSocket handlers use, so a run
 * dispatched here is dispatched through the identical path. `assertSessionAccess`
 * defaults to this module's own entry — the one AC-196/197/198 established for
 * the control verbs — so a caller cannot end up with a control plane that checks
 * ownership a different way than the surface does.
 */
type ChatControlDependencies = {
  runtime: ProviderRuntimeGateway;
  /**
   * The single access entry every control verb shares (`send`, `abort`,
   * `cancelQueued`, `stopTask`, `backgroundTask`, `pendingApprovals`,
   * `answerApproval`).
   *
   * Defaults to this module's own {@link assertSessionAccess}. The seam exists
   * so a criterion can hand over a counting spy and observe that all seven verbs
   * go through the *same* entry — delegating to the production one, so the
   * verdict is the real ownership answer rather than a stub — instead of each
   * carrying a check of its own.
   */
  assertSessionAccess?: (
    userId: string | number | null,
    session: ReturnType<typeof sessionsDb.getSessionById>,
  ) => boolean;
  /**
   * The session ids `pendingApprovals` / `answerApproval` scan when no session is
   * named. Defaults to {@link chatRunRegistry}'s running sessions (a pending
   * approval can only belong to a session with a turn in flight) and is
   * injectable so a criterion can name its own candidate set — including a
   * session the registry does not know about.
   */
  listApprovalSessionIds?: () => string[];
  /**
   * The clock the `runId` compatibility window is judged against (SPEC §8.3).
   *
   * Defaults to `Date.now`. The seam exists so a criterion can push time past
   * {@link RUN_ID_COMPAT_WINDOW_END_MS} and read the post-window answer — a
   * `runId` stated as `null` for an unbound turn — without waiting for the date
   * to arrive, exactly as the `run_get` wait moves only through its injected
   * clock.
   */
  now?: () => number;
  /**
   * The context-event seam: one `utterance` per accepted send a PERSON made over
   * the socket or the voice relay. Scheduled and MCP sends are not utterances (no
   * person spoke at that moment), so they are not recorded here.
   *
   * The call is deliberately fire-and-forget and its failure is swallowed by this
   * service: recording is an observation of a user's action, never a precondition
   * for the action itself. Injected by `server/index.ts` so this module keeps
   * importing no sibling feature module.
   */
  recordContextEvent?: (event: {
    kind: 'utterance';
    session: string;
    data: { text: string; source: 'typing' | 'voice' };
  }) => void;
};

/** The caller front ends whose send is a person's utterance. */
const UTTERANCE_VIAS: ReadonlySet<ControlCaller['via']> = new Set(['websocket', 'voice']);

/**
 * The access entry a control verb must call: the injected seam when one was
 * provided, the process default otherwise.
 *
 * Every control verb resolves it here rather than reaching for the module
 * function directly, so an injected entry sees all five. That is the seam the
 * criterion (`server/modules/websocket/tests/chat-control-access.test.ts`) reads
 * to prove the five verbs share one entry rather than each carrying an inline
 * check. It mirrors the gateway's own helper of the same name.
 */
function accessEntry(
  dependencies: ChatControlDependencies,
): (userId: string | number | null, session: ReturnType<typeof sessionsDb.getSessionById>) => boolean {
  return dependencies.assertSessionAccess ?? assertSessionAccess;
}

/**
 * The session ids the approval verbs scan when no session is named.
 *
 * The default is the run registry's running sessions: a tool approval can only
 * be waiting on a session that has a turn in flight, so that set is both the
 * complete and the cheapest candidate list. The seam exists so a criterion can
 * name its own candidates without a live registry run.
 */
function approvalSessionIds(dependencies: ChatControlDependencies): string[] {
  return (
    dependencies.listApprovalSessionIds?.()
    ?? chatRunRegistry.listRunningRuns().map((run) => run.sessionId)
  );
}

/** Reads a runtime gateway's pending approvals for one session, typed to the entry shape it reports. */
function readPendingApprovals(
  dependencies: ChatControlDependencies,
  sessionId: string,
): PendingApproval[] {
  return dependencies.runtime.getPendingApprovalsForSession(sessionId) as PendingApproval[];
}

/**
 * The id of the session whose runtime currently holds `requestId`, or null when
 * no candidate session does.
 *
 * This is the in-registry precheck `answerApproval` runs BEFORE any decision:
 * `resolveToolApproval` is silent for an unknown id (`claude-runtime.provider.ts`
 * only calls a stored resolver), so "was this request ever here" must be read
 * from the pending set, never probed by calling the resolver.
 */
function findApprovalSession(
  dependencies: ChatControlDependencies,
  requestId: string,
): string | null {
  for (const sessionId of approvalSessionIds(dependencies)) {
    const pending = readPendingApprovals(dependencies, sessionId);
    if (pending.some((entry) => entry.requestId === requestId)) {
      return sessionId;
    }
  }
  return null;
}

/**
 * Builds the transport-agnostic control plane for chat sessions.
 *
 * This is the seam the WebSocket gateway, the scheduled-message dispatcher and
 * (later) the MCP gateway share: a run opened here is registered and dispatched
 * through the very `chatRunRegistry` + `dispatchRun` path the interactive
 * `chat.send` handler uses, so a run any front end opens is the same run the UI
 * can watch, subscribe to and abort.
 *
 * The service is deliberately transport-free: it accepts no socket, constructs
 * no frames and reports nothing by emitting. It ships `send` — including the
 * resident-session busy branch that queues into a running process and hands the
 * queued message's uuid back — `cancelQueued`, which withdraws a message by that
 * uuid, `abort`/`stopTask`/`backgroundTask`, which reach the provider's own
 * control verbs, and (AC-274) `pendingApprovals`/`answerApproval`, which read and
 * decide the runtime's pending tool approvals. All seven take the one shared
 * access entry before any driver call. The remaining verb (`editSend`) arrives
 * with a later AC.
 *
 * Consumed by this module's criteria
 * (`server/modules/websocket/tests/chat-control-send.test.ts`,
 * `chat-control-busy.test.ts`, `chat-control-access.test.ts`); the composition
 * root (`server/index.ts`) wires the single instance in AC-233.
 */
export function createChatControlService(deps: ChatControlDependencies) {
  /**
   * Registers a run for one session and returns its id immediately.
   *
   * The shared access entry is consulted first — before the session-not-found
   * verdict and long before any driver call — so an unauthenticated caller
   * (`FORBIDDEN`) can neither register a run nor reach the provider. Only then
   * must the session exist (`SESSION_NOT_FOUND`) and its provider have a runtime
   * (`UNSUPPORTED_PROVIDER`); the turn is handed to `dispatchRun`, which
   * registers the run and starts the provider in the background.
   *
   * The return is *immediate* — the run keeps going after this resolves. That is
   * achieved without a timeout by racing two facts `dispatchRun` produces in a
   * known order: the run id, surfaced through its `beforeRun` hook (called only
   * after `chatRunRegistry.startRun` succeeded), and the dispatch attempt
   * settling. A refused dispatch settles before `beforeRun` can run, so a
   * refusal wins the race and a registration reports its id first; neither arm
   * is decided by a clock.
   */
  async function send(caller: ControlCaller, input: SendInput): Promise<SendResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    // The shared access entry runs before the session-not-found verdict, so an
    // unauthenticated caller gets one answer for every session — it cannot tell
    // a session it may not touch from one that does not exist.
    if (!accessEntry(deps)(caller.userId, session)) {
      const refusal = {
        ok: false as const,
        code: 'FORBIDDEN' as const,
        message: `Caller is not allowed to send to session "${input.sessionId}".`,
      };
      input.onRefuse?.(refusal);
      return refusal;
    }

    if (!session) {
      const refusal = {
        ok: false as const,
        code: 'SESSION_NOT_FOUND' as const,
        message: `Session "${input.sessionId}" was not found.`,
      };
      input.onRefuse?.(refusal);
      return refusal;
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      const refusal = {
        ok: false as const,
        code: 'UNSUPPORTED_PROVIDER' as const,
        message: `Provider "${provider}" is not available.`,
      };
      input.onRefuse?.(refusal);
      return refusal;
    }

    // A scheduled send outranks whatever is running: mirroring
    // `runDetachedChatTurn`, an `interruptActiveRun` call aborts the session's
    // current run and emits its terminal `complete` on its behalf, so every
    // watching client sees the interrupted run end before the new one begins.
    if (input.interruptActiveRun) {
      const activeRun = chatRunRegistry.getRun(input.sessionId);
      if (activeRun && activeRun.status === 'running') {
        const aborted = await deps.runtime.abort(activeRun.provider, input.sessionId);
        chatRunRegistry.completeRun(input.sessionId, {
          exitCode: aborted ? 0 : 1,
          aborted: true,
        });
      }
    }

    // The "this run was registered" signal. Resolved by the `beforeRun` hook,
    // which `dispatchRun` reaches only once `startRun` has returned a run. The
    // same hook reports whether that run took the resident-session busy path, so
    // the two facts `send` needs — the id and whether the turn was queued into a
    // running process — arrive together, and neither is re-derived by probing
    // the registry.
    let resolveRunId!: (runId: string) => void;
    const runIdPromise = new Promise<string>((resolve) => {
      resolveRunId = resolve;
    });
    let busyAccepted = false;

    // What the delivery-shaped answer needs, read BEFORE the dispatch: run=turn
    // is the mode in which a send is a DELIVERY, and "would this session take a
    // busy write" is the same resident test `dispatchRun` makes (SPEC §6.1's two
    // halves). Off either, the answer keeps its pre-S3 shape exactly.
    const runIsTurn = residentRunIsTurn();
    const isResident = deps.runtime.acceptsBusyInput?.(provider, input.sessionId) === true;
    // The deliveries the session's ledger already held. The one this send is
    // about to create is whatever is NEWER than this set; taken before the
    // dispatch so a delivery the session was already holding cannot be mistaken
    // for this send's.
    const priorDeliveryIds: DeliveryIdSnapshot | null =
      runIsTurn && isResident ? deliveryIdsBefore(input.sessionId) : null;

    const data: AnyRecord = {
      sessionId: input.sessionId,
      content: input.content,
      options: input.options ?? {},
    };

    // The run continues after `send` resolves, so its promise is guarded: a
    // rejection would otherwise surface as an unhandled rejection. It is logged
    // and settled rather than propagated, because a failure *after* the run was
    // admitted is the run's business, not this call's result.
    const dispatchPromise = dispatchRun(
      // `ws` is deliberately `null`: the run's refusal is reported as this
      // call's result (translated by the adapter), never as a frame written
      // inside `dispatchRun`, so passing the socket here would double-send a
      // `RUN_IN_PROGRESS` frame. The socket still binds to the run — as the
      // connection override below — so its frames stream to the requesting client.
      null,
      caller.userId,
      input.sessionId,
      session,
      data,
      deps,
      {},
      (run, info) => {
        busyAccepted = info.busyAccepted;
        resolveRunId(run.runId);
      },
      input.connection ?? null,
      // A run in progress is `dispatchRun`'s own refusal and it is decided
      // before its first `await`, so the verdict can be handed back on this
      // tick. `ws` is null above, so this is the only channel that reports it.
      input.onRefuse,
      // The run's recorded origin. Derived from `caller.via` and passed
      // explicitly because `ws`/connection are both null here: the
      // connection-derived default cannot tell a WebSocket send from an MCP or
      // scheduled one, and would record all three as `scheduled`.
      SOURCE_BY_VIA[caller.via],
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ChatControl] Provider run "${provider}" for session "${input.sessionId}" failed`,
        { error: message },
      );
      return { started: true, error: message };
    });

    const outcome = await Promise.race([
      runIdPromise.then((runId) => ({ registered: true as const, runId })),
      dispatchPromise.then((result) => ({ registered: false as const, result })),
    ]);

    if (!outcome.registered) {
      return {
        ok: false,
        code: 'RUN_IN_PROGRESS',
        message: `Session "${input.sessionId}" already has a run in progress.`,
      };
    }

    // The accepted turn is the utterance. Recorded after registration and only
    // for a person's front end, so a refused send never enters the stream. A
    // throwing/failing recorder is contained here: the send has already been
    // accepted and must return its result unchanged.
    if (UTTERANCE_VIAS.has(caller.via)) {
      try {
        deps.recordContextEvent?.({
          kind: 'utterance',
          session: input.sessionId,
          data: { text: input.content, source: caller.via === 'voice' ? 'voice' : 'typing' },
        });
      } catch {
        // The stream is an observation, not part of the send's contract.
      }
    }

    // The delivery this send was accepted as (SPEC §8.1). A resident session's
    // ledger is the only surface that mints it, so it is read back from there —
    // bounded, and honestly `null` when this layer cannot name it. A per-run
    // session has no ledger: its delivery id is the uuid `dispatchRun` minted
    // with the run (SPEC §4.1's "non-resident is the uuid minted at send time"),
    // carried on the run's own `deliveryIds`.
    const accepted = priorDeliveryIds === null ? null : await readAcceptedDelivery(input.sessionId, priorDeliveryIds);
    const dispatchMintedDeliveryId =
      runIsTurn && !isResident
        ? (chatRunRegistry.readRun(outcome.runId)?.deliveryIds.at(-1) ?? null)
        : null;
    const deliveryId = accepted?.deliveryId ?? dispatchMintedDeliveryId;

    /**
     * The turn's run id, or the compatibility answer (SPEC §8.1, §8.3).
     *
     * A per-run provider mints the run with the delivery, so the registered run
     * id IS the turn's and is stated as-is. A resident session has no turn when
     * it answers: while the delivery is unbound the answer is the delivery id
     * itself, inside the window, and `null` once the window closes — the two
     * halves §8.3 states. A delivery that really did bind to an open turn inside
     * the handover gets that turn's run id.
     */
    const boundTurnRunId =
      accepted !== null && accepted.turnId !== null ? readSessionTurnRun(input.sessionId).runId : null;
    const runId = !runIsTurn || !isResident
      ? outcome.runId
      : boundTurnRunId ?? (isRunIdCompatWindowOpen((deps.now ?? Date.now)()) ? deliveryId : null);

    if (busyAccepted) {
      // The message is in the provider's own queue now. The uuid it was stamped
      // with comes from the provider, never minted here, because only that uuid
      // can be withdrawn later; a gateway with no such seam degrades to `null`.
      // SPEC §8.1 keeps this field as the delivery id's ALIAS, so when the queue
      // names it, that name is the delivery id — the two readings are one.
      const queuedMessageUuid = await readQueuedMessageUuid(deps.runtime, provider, input.sessionId);
      return {
        ok: true,
        deliveryId: queuedMessageUuid ?? deliveryId,
        runId,
        queued: true,
        queuedMessageUuid,
        completion: dispatchPromise,
      };
    }

    return {
      ok: true,
      deliveryId,
      runId,
      queued: false,
      queuedMessageUuid: null,
      completion: dispatchPromise,
    };
  }

  /**
   * Withdraws a message a busy send queued, before the provider's process has
   * started running it.
   *
   * The refusal is the same shared access entry every other control verb uses
   * (`send`, `abort`, `stopTask`, `backgroundTask`), and it is taken before the
   * driver is reached, so a caller with no access can neither withdraw a queued
   * message nor learn whether a uuid is live. The verdict itself is the
   * provider's own: this function does not decide whether the message was still
   * queued, it reports what the queue said, and reads a gateway with no
   * withdrawal seam as `unknown` — the one answer that must not be confused with
   * a successful withdrawal.
   */
  async function cancelQueued(
    caller: ControlCaller,
    input: { sessionId: string; messageUuid: string },
  ): Promise<HostQueuedInputCancelResult | 'forbidden'> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return 'forbidden';
    }

    if (!session) {
      return 'unknown';
    }

    const provider = session.provider as LLMProvider;
    return (
      (await deps.runtime.cancelQueuedInput?.(provider, input.sessionId, input.messageUuid)) ??
      'unknown'
    );
  }

  /**
   * Stops the run a session currently has, through the provider's own process.
   *
   * The same shape as `send`: the shared access entry runs first, so an
   * unauthenticated caller is refused without the provider being told anything;
   * the session must then exist and its provider must have a runtime before the
   * driver is reached. The verdict is the provider's own `abort` answer, so a
   * process that had already ended reports `aborted: false` rather than a
   * fabricated success.
   *
   * "Is there a run to abort" is deliberately **not** decided here. The registry
   * is the adapter's state and reading it around this call races the run's own
   * terminal event — an abort that kills a process can let that process's exit
   * path complete the run first, and a registry check made here would then turn a
   * real stop into a false `NO_ACTIVE_RUN`. The WebSocket handler checks the
   * registry *before* delegating (as it always has).
   *
   * The terminal `complete` for the aborted run is emitted here, immediately
   * after the provider answers, for the same timing reason: a stop that releases
   * an in-process generator (codex's forged stream, and its real SDK's abort)
   * can otherwise let that generator settle — and the run's own dispatch finish —
   * before an adapter several microtasks away got to write the client's frame,
   * which would surface the run as a plain failure instead of an abort. Emitting
   * it here keeps the exactly-one-complete contract identical to the old inline
   * handler. Every front end that aborts (the WebSocket gateway now, the MCP
   * gateway later) gets the same ending.
   */
  async function abort(caller: ControlCaller, input: { sessionId: string }): Promise<AbortResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return {
        ok: false,
        aborted: false,
        code: 'FORBIDDEN',
        message: `Caller is not allowed to abort session "${input.sessionId}".`,
      };
    }

    if (!session) {
      return {
        ok: false,
        aborted: false,
        code: 'SESSION_NOT_FOUND',
        message: `Session "${input.sessionId}" was not found.`,
      };
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return {
        ok: false,
        aborted: false,
        code: 'UNSUPPORTED_PROVIDER',
        message: `Provider "${provider}" is not available.`,
      };
    }

    const aborted = await deps.runtime.abort(provider, input.sessionId);

    // Runtimes skip their own terminal event for an aborted turn, and the
    // registry drops a duplicate if one still arrives; this is the client's
    // `complete`. A no-op when no run is live.
    chatRunRegistry.completeRun(input.sessionId, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
    });

    return { ok: true, aborted };
  }

  /**
   * Stops one named background task of a session through the provider's process.
   *
   * Transport-free and, for now, deliberately thin: it takes the shared access
   * entry first, then requires the session and a runtime, and hands the request
   * to the runtime's `controlStopTask`. The gateway handler's full "validate,
   * place, wait for the task table to settle" sequence is AC-233's to build on
   * top of this seam — a service that repeated it here would run the
   * confirmation wait for a caller that had not yet been authenticated through
   * the handler.
   */
  async function stopTask(
    caller: ControlCaller,
    input: { sessionId: string; taskId: string },
  ): Promise<StopTaskResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return 'forbidden';
    }

    if (!session) {
      return 'SESSION_NOT_FOUND';
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return 'UNSUPPORTED_PROVIDER';
    }

    return (await deps.runtime.controlStopTask?.(provider, input.sessionId, input.taskId)) ?? 'unsupported';
  }

  /**
   * Promotes one named foreground tool to a background task through the
   * provider's process.
   *
   * The stop-task sibling's shape, with the runtime's `controlBackgroundTask` as
   * its driver. The Turn Tracker match the gateway handler performs is AC-233's
   * to add; here the request only has to pass the one access entry first and
   * then reach the driver.
   */
  async function backgroundTask(
    caller: ControlCaller,
    input: { sessionId: string; toolUseId: string },
  ): Promise<BackgroundTaskResult> {
    const session = sessionsDb.getSessionById(input.sessionId);

    if (!accessEntry(deps)(caller.userId, session)) {
      return 'forbidden';
    }

    if (!session) {
      return 'SESSION_NOT_FOUND';
    }

    const provider = session.provider as LLMProvider;
    if (!deps.runtime.hasRuntime(provider)) {
      return 'UNSUPPORTED_PROVIDER';
    }

    return (
      (await deps.runtime.controlBackgroundTask?.(provider, input.sessionId, input.toolUseId)) ??
      'unsupported'
    );
  }

  /**
   * Lists the tool approvals one session — or every candidate session — is
   * waiting on, through the provider runtime's own pending set.
   *
   * With a `sessionId`: the shared access entry is consulted first (so an
   * unauthenticated caller is refused before any runtime read), then the session
   * must exist. With it omitted the candidate sessions are enumerated
   * ({@link approvalSessionIds}) and each one passes the same entry, so a caller
   * only ever sees approvals for sessions it may access; the merged list is the
   * answer. Entries are returned verbatim — the adapter above computes "how long
   * has this waited" from `receivedAt`.
   */
  async function pendingApprovals(
    caller: ControlCaller,
    input: { sessionId?: string },
  ): Promise<PendingApprovalsResult> {
    if (input.sessionId !== undefined) {
      const session = sessionsDb.getSessionById(input.sessionId);
      if (!accessEntry(deps)(caller.userId, session)) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: `Caller is not allowed to read session "${input.sessionId}" approvals.`,
        };
      }
      if (!session) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `Session "${input.sessionId}" was not found.`,
        };
      }
      return { ok: true, approvals: readPendingApprovals(deps, input.sessionId) };
    }

    const approvals: PendingApproval[] = [];
    for (const sessionId of approvalSessionIds(deps)) {
      const session = sessionsDb.getSessionById(sessionId);
      // A session the caller may not read, or one that no longer exists, is
      // skipped rather than refused: an unnameable candidate is not an error for
      // a listing that spans the workspace.
      if (!session || !accessEntry(deps)(caller.userId, session)) {
        continue;
      }
      approvals.push(...readPendingApprovals(deps, sessionId));
    }
    return { ok: true, approvals };
  }

  /**
   * Decides one pending tool approval through the provider runtime's own
   * resolver.
   *
   * The in-registry check comes FIRST, and it is what makes "expired" a fact
   * rather than a guess: a request that has already timed out (the runtime
   * deleted it) or never existed is reported `APPROVAL_EXPIRED_OR_NOT_FOUND`
   * and `resolveToolApproval` is NEVER called for it — the resolver is silent on
   * a missing id, so calling it would leave the caller unable to tell a real
   * decision from a no-op. Only once the id is known to be held does the shared
   * access entry run, and only after it passes is the decision handed over.
   *
   * `answers` is forwarded as the decision's `updatedInput` and `message`
   * alongside it — the same `ProviderPermissionDecision` vocabulary the
   * WebSocket `chat.permission-response` path uses. `rememberEntry` is not
   * introduced here.
   */
  async function answerApproval(
    caller: ControlCaller,
    input: AnswerApprovalInput,
  ): Promise<AnswerApprovalResult> {
    // The decision ledger is consulted BEFORE the pending registry, and must be:
    // a request another caller already settled has been deleted from the pending
    // map (the waiter cleans up on settle), so the registry alone would call it
    // absent and report `expired`/`never_issued` — telling this caller its
    // answer never landed when in fact a different caller's did. The ledger is
    // the only trace that removal leaves, and reading it first is what makes the
    // two cases distinguishable at all.
    const alreadyDecided = deps.runtime.readApprovalDecision?.(input.requestId) ?? null;
    if (alreadyDecided) {
      return {
        ok: false,
        code: 'ALREADY_DECIDED',
        decidedBy: alreadyDecided.decidedBy,
        decidedAt: alreadyDecided.decidedAt,
        message: 'The approval request was already decided by another caller.',
      };
    }

    const holderSessionId = findApprovalSession(deps, input.requestId);
    if (holderSessionId === null) {
      // The live pending map is empty for BOTH a settled id and an id nothing
      // ever minted, so the distinction is read from the runtime's own ledger
      // through the gateway's optional facet. A gateway that cannot classify
      // degrades to `'expired'` — the reading that never claims the caller
      // invented an id this process could not have seen.
      return {
        ok: false,
        code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',
        reason: deps.runtime.classifyMissingApproval?.(input.requestId) ?? 'expired',
        message: 'The approval request has expired or does not exist (it may have timed out and been auto-denied).',
      };
    }

    const session = sessionsDb.getSessionById(holderSessionId);
    if (!accessEntry(deps)(caller.userId, session)) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: `Caller is not allowed to answer approvals for session "${holderSessionId}".`,
      };
    }

    const decision: ProviderPermissionDecision = { allow: input.allow };
    if (input.answers !== undefined) {
      decision.updatedInput = input.answers;
    }
    if (input.message !== undefined) {
      decision.message = input.message;
    }
    // The caller's id rides along so the ledger can name who won a race; a
    // caller with no id records `null` rather than being dropped.
    const decidedBy = caller.userId === null || caller.userId === undefined ? null : String(caller.userId);
    deps.runtime.resolveToolApproval(input.requestId, decision, decidedBy);

    return { ok: true, requestId: input.requestId };
  }

  return { send, abort, cancelQueued, stopTask, backgroundTask, pendingApprovals, answerApproval };
}
