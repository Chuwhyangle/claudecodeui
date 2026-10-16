import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import {
  providerCapabilitiesService,
  providerModelsService,
  readSessionForegroundToolUseId,
  readSessionTasks,
  sessionsService,
} from '@/modules/providers/index.js';
import type {
  ActivityTask,
  ControlBackgroundTaskOutcome,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import { voiceLexicon } from '@/modules/voice/index.js';
import {
  activityAnnouncement,
  attachActivityHeartbeat,
} from '@/modules/websocket/services/activity-heartbeat.service.js';
import { activityStore } from '@/modules/websocket/services/activity-protocol.service.js';
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import { chatRunRegistry, residentRunIsTurn } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  uiClientRegistry,
  type UiClientRegistry,
} from '@/modules/websocket/services/ui-client-registry.service.js';
import {
  uiStateRequestService,
  type UiStateRequestService,
} from '@/modules/websocket/services/ui-state-request.service.js';
import {
  uiNavigationService,
  type UiNavigationService,
} from '@/modules/websocket/services/ui-navigation.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import { CHAT_TURN_OPTION } from '@/shared/types.js';
import type {
  AnyRecord,
  ApprovalDecisionRecord,
  AuthenticatedWebSocketRequest,
  ChatRunSource,
  HostQueuedInputCancelResult,
  MissingApprovalReason,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/**
 * The full verdict set one `chat.stop-task` receipt can carry: everything the
 * runtime gateway can answer, plus the two refusals the handler itself decides
 * before the gateway is reached (`forbidden` from the access entry,
 * `unknown-task` from the task table).
 */
type ControlStopTaskResult = ControlStopTaskOutcome | 'forbidden' | 'unknown-task';

/**
 * The full verdict set one `chat.background-task` receipt can carry: everything
 * the runtime gateway can answer, plus the refusal the handler itself decides
 * before the gateway is reached (`forbidden` from the access entry).
 *
 * Deliberately has no `unknown-task`: this verb does not address the task table
 * at all, so there is no table-side refusal — the handler's own
 * `no-foreground-match` (from the Turn Tracker) is the only pre-gate answer, and
 * it is already part of the gateway's union so a driven `false` and a
 * tracker-side mismatch read identically to the caller.
 */
type ControlBackgroundTaskResult = ControlBackgroundTaskOutcome | 'forbidden';

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  /**
   * Whether a turn dispatched right now would be written into a process the
   * session's provider is already holding, rather than run as a process of its
   * own.
   *
   * Optional, and read as `false` when absent, because the absent case is the
   * behaviour every session had before busy input existed: the duplicate-send
   * refusal is the default, and only a gateway that can answer for a live
   * process may lift it. A gateway assembled without this verb therefore
   * degrades to the refusal rather than losing it.
   */
  acceptsBusyInput?(provider: LLMProvider, sessionId: string): boolean;
  /**
   * Withdraws a message a busy send queued, if the provider's process has not
   * started running it yet.
   *
   * Optional for the same reason, and read as `unknown` when absent: the one
   * answer a caller must never receive is "withdrawn" from a seam that never
   * wrote anything.
   */
  cancelQueuedInput?(
    provider: LLMProvider,
    sessionId: string,
    messageUuid: string,
  ): Promise<HostQueuedInputCancelResult>;
  /**
   * The uuid of the message the session's provider most recently took into its
   * own queue — the same uuid `cancelQueuedInput` would withdraw.
   *
   * This is how the uuid the provider stamped a queued turn with reaches the
   * caller that asked for it. The provider's queue is the only thing that knows
   * the uuid (a busy send is written into the running process; the process
   * names the message), so a control caller cannot mint one and expect a later
   * withdrawal to match. The promise resolves once the message has been written
   * — never with a placeholder — and resolves `null` when the gateway has no
   * live process to read a queue from.
   *
   * Optional, and read as `null` when absent, because the conservative
   * degradation is "queued, but no uuid to withdraw". A missing seam must never
   * be read as a queued message with an empty uuid: the caller would then hold
   * an id that no withdrawal can match. Only the resident drivers can answer
   * this — a process-per-turn provider has no queue to name a message in.
   */
  queuedInputUuid?(provider: LLMProvider, sessionId: string): Promise<string | null>;
  /**
   * Stops one named background task through the provider's own process.
   *
   * Returns `requested` when the driver was called and its call settled, and a
   * failure value otherwise. It deliberately does **not** wait for the task to
   * stop and does not touch the task table: whether the task really stopped is
   * the approval the reducer writes from the `task_notification(stopped)` frame,
   * which the handler waits on with its own bound.
   *
   * Optional, and read as `unsupported` when absent, because a gateway that
   * cannot carry the request must never be read as having placed one.
   */
  controlStopTask?(
    provider: LLMProvider,
    sessionId: string,
    taskId: string,
  ): Promise<ControlStopTaskOutcome>;
  /**
   * Promotes one named *foreground* tool to a background task through the
   * provider's own process.
   *
   * Returns `requested` when the driver was called and its call settled `true`,
   * and a failure value otherwise. Like its stop-task sibling it deliberately
   * does **not** wait for the task to appear and does not touch the task table:
   * the task becomes a row only when the reducer consumes the
   * `task_started` + `task_updated{is_backgrounded:true}` frames the CLI emits,
   * which is a later step than this call.
   *
   * Optional, and read as `unsupported` when absent, because a gateway that
   * cannot carry the request must never be read as having placed one.
   */
  controlBackgroundTask?(
    provider: LLMProvider,
    sessionId: string,
    toolUseId: string,
  ): Promise<ControlBackgroundTaskOutcome>;
  resolveToolApproval(
    requestId: string,
    payload: ProviderPermissionDecision,
    decidedBy?: string | null,
  ): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
  /**
   * Why an approval `requestId` is absent from the pending registry: it was
   * held and is gone (`expired`), or nothing here ever minted it
   * (`never_issued`).
   *
   * Optional, and read through the control service's own `??` default
   * (`'expired'`) when absent, because a gateway that cannot classify must not
   * have `never_issued` invented for it: the conservative reading is the one
   * that never claims a request was never issued. `provider-runtime.service.ts`
   * forwards it from the first provider whose permission facet answers.
   */
  classifyMissingApproval?(requestId: string): MissingApprovalReason | null;
  /**
   * The decision the runtime recorded for `requestId`, or `null` when it never
   * decided one. The counterpart to `classifyMissingApproval`: that one says
   * where a missing id went, this one says whether it was already decided, which
   * is what lets `chat-control.service.ts` report a lost race as
   * `ALREADY_DECIDED` instead of `APPROVAL_EXPIRED_OR_NOT_FOUND`.
   *
   * Optional, and read as `null` when absent, because a gateway with no ledger
   * simply cannot distinguish a lost race and must fall back to the
   * missing-approval classification. `provider-runtime.service.ts` forwards it
   * from the first provider whose permission facet answers.
   */
  readApprovalDecision?(requestId: string): ApprovalDecisionRecord | null;
};

/**
 * The slice of the shared chat control service the WebSocket gateway uses.
 *
 * The gateway only ever `send`s, `abort`s and `cancelQueued`s; taking just those
 * three from the service's own return type keeps the seam honest (the handler
 * cannot reach a verb it does not advertise) and lets the wiring criterion stand
 * in a counting spy with exactly those three members.
 */
type ChatControlSeam = Pick<
  ReturnType<typeof createChatControlService>,
  'send' | 'abort' | 'cancelQueued'
>;

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
  /**
   * The single chat control service the three transport verbs
   * (`chat.send`/`chat.abort`/`chat.cancel-queued`) delegate to.
   *
   * Production supplies the one process-wide instance the composition root
   * builds (`server/index.ts`), so a WebSocket turn and a scheduled send reach
   * the *same* object. This seam is how the wiring criterion
   * (`server/modules/websocket/tests/chat-control-wiring.test.ts`) injects a
   * counting spy and reads "the handler called the control service once" without
   * a second instance anywhere.
   *
   * Optional only for the many existing harnesses that drive the gateway with a
   * bare `{ runtime }`; when it is absent the connection resolves exactly one
   * control service over the same `runtime` (see {@link resolveChatControl}), so
   * those callers keep the behaviour they had. The production path never relies
   * on that default — it passes the instance explicitly.
   */
  control?: ChatControlSeam;
  /**
   * The single access entry every control verb shares (AC-196's
   * `chat.stop-task`, AC-197's `chat.background-task`, and AC-198's reworked
   * `chat.cancel-queued`).
   *
   * Defaults to this module's own {@link assertSessionAccess}. The seam exists
   * so a criterion can hand over a counting spy and observe that all three
   * verbs go through the *same* entry, rather than each handler carrying a check
   * of its own — the asymmetry that let `chat.cancel-queued` ship with no
   * ownership check while its siblings had one.
   */
  assertSessionAccess?: (
    userId: string | number | null,
    session: ReturnType<typeof sessionsDb.getSessionById>,
  ) => boolean;
  /**
   * The capability seam the two resident control verbs share.
   *
   * Defaults to this module's own {@link defaultResidentControlVerbSupported},
   * which reads the shipped matrix plus the session's stored lifecycle mode. The
   * seam exists so a criterion can drive the *unsupported* arm of the control
   * plane directly — the shipped matrix declares `stopTask` true, so without an
   * injectable reader a criterion could not reach the gate at all — and so it
   * can observe that `chat.stop-task` and `chat.background-task` ask the same
   * question rather than each carrying a check of its own.
   */
  residentControlVerbSupported?: (
    provider: LLMProvider,
    sessionId: string,
    verb: 'stopTask' | 'backgroundTasks',
  ) => boolean;
  /** Test seam: replaces the default that discards a client-supplied `options.env`. */
  dropClientEnv?: (options: AnyRecord) => AnyRecord;
  /**
   * Where a subscription reports that a browser is now on a session.
   *
   * A subscription is the one client action that says "someone is watching this
   * session", and the host layer is what has to hear it: a resident process is
   * held across turns, so "who is attached" is a fact its lifetime is reasoned
   * about from. The manager's `attachViewer` is deliberately *not* activity (it
   * never moves `lastActivityAt`; see the manager's own rule), so routing it
   * here changes nothing about when a host closes — what it changes is that the
   * host layer is told at all.
   *
   * Optional, defaulting to the process-wide manager, for the same reason
   * `dropClientEnv` is: the composition root has nothing to say about it, while
   * a criterion that drove a manager of its own can hand that one over and see
   * the call land on it. Narrow on purpose — these are the only verbs the chat
   * gateway has any business calling.
   *
   * `rewindAndWait` joined it with the resident edit-send rebuild: an edit on a
   * resident session has to end the process holding the conversation before a
   * replacement can be started from the truncation point, and that ordering is
   * only observable through a seam that reports the rewind landing. It is
   * optional where the viewer half is not, because the two answer different
   * questions: a harness that hands over a host *watcher* has said nothing about
   * rewinding, and a session whose seam cannot rewind is not one to crash a run
   * over — the process-wide manager answers for it instead.
   */
  sessionHostManager?: Pick<SessionHostManager, 'attachViewer'> &
    Partial<Pick<SessionHostManager, 'rewindAndWait'>>;
  /**
   * The task table read seam for the stop-task control verb.
   *
   * Defaults to the process-wide reducer table below. A criterion injects its
   * own reader — built on the same `createClaudeTaskReducer()` — so it can drive
   * a frame sequence into the table and read the very table the handler
   * consulted, rather than a second registry the handler never saw.
   */
  getTask?: (sessionId: string, taskId: string) => { state: ActivityTask['state'] } | null;
  /**
   * How long the handler waits for the task table to show the task settled after
   * a `requested` driver call, and how often it re-reads it.
   *
   * Injectable so the criterion can reach the never-stopped arm in milliseconds.
   * Production's window is short on purpose: the SDK's `task_notification`
   * follows the stop within a round trip when it arrives at all, so a longer
   * wait would only delay the honest `timeout`.
   */
  stopTaskConfirmTimeoutMs?: number;
  stopTaskConfirmPollMs?: number;
  /**
   * Where a connection's `ui.hello` identity is recorded and forgotten.
   *
   * Defaults to the process-wide registry, which is the listing the MCP tools
   * read — one registry per server run, so a device's tabs and the identity the
   * gateway stored for them cannot be two different sets. The seam exists so a
   * criterion can drive registrations and closes against a registry of its own
   * without leaving devices behind for the next case to read.
   */
  uiClients?: UiClientRegistry;
  /**
   * Where a connection's `ui.state_response` is routed: the open request that
   * asked for it.
   *
   * Defaults to the process-wide round trip, which is the one the MCP tools'
   * `ui_visible_context` call goes through — one instance per server run, so an
   * answer and the question it belongs to cannot be held by two different
   * tables. The seam exists so a criterion can hand in its own service and read
   * the frame the gateway actually routed.
   */
  uiStateRequests?: UiStateRequestService;
  /**
   * Where a connection's `ui.navigate_ack` / `ui.navigate_result` frames are
   * routed: the open navigation that wrote the instruction, and the in-memory
   * record the final outcome belongs to.
   *
   * Defaults to the process-wide navigation service, which is the one the MCP
   * tool's `ui_open_session` writes through — one instance per server run, so an
   * instruction and the answer to it cannot be held by two different logs. The
   * seam exists so a criterion can hand in its own service and read the frames
   * the gateway actually routed.
   */
  uiNavigations?: UiNavigationService;
};

/**
 * The dependencies with the control service resolved, as the three transport
 * verbs see them. `handleChatConnection` resolves the seam once and passes this
 * down, so a handler never has to re-derive (or re-construct) a control.
 */
type ResolvedChatWebSocketDependencies = ChatWebSocketDependencies & { control: ChatControlSeam };

const DEFAULT_STOP_TASK_CONFIRM_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TASK_CONFIRM_POLL_MS = 25;

/**
 * The reducer's terminal states, read here as the set "the task is no longer in
 * flight" that ends the confirmation wait. `running` and `blocked` are the two
 * that do not.
 */
const TERMINAL_TASK_STATES: ReadonlySet<ActivityTask['state']> = new Set<ActivityTask['state']>([
  'stopped',
  'completed',
  'failed',
  'ended',
]);

/**
 * The default task-table reader: one row out of the providers module's own
 * reducer table.
 *
 * It reads `readSessionTasks` — the process-wide singleton the frame forwarder
 * feeds (`forwardNormalizedFrames` → `taskReducer.observe`) — and deliberately
 * does not build a second reducer here. A private instance would be empty for
 * the whole life of the process, so the stop-task verb would answer
 * `unknown-task` for every request against a session whose tasks the dock is
 * already drawing from that same reduction — the control plane and the surface
 * must read one table, or the verb's verdict is about the wrong one.
 */
function defaultGetTask(sessionId: string, taskId: string): { state: ActivityTask['state'] } | null {
  const task = readSessionTasks(sessionId).find((candidate) => candidate.taskId === taskId);
  return task ? { state: task.state } : null;
}

/**
 * Grants or refuses a control verb access to one session.
 *
 * The single entry the "stop something" verbs share (AC-196's `chat.stop-task`
 * today; AC-197's `chat.background-task` and AC-198's reworked
 * `chat.cancel-queued` next). It is deliberately the only place that decides
 * this: the alternative — each handler re-deriving it — is how one verb ends up
 * without a check while its sibling has one, which is exactly what happened to
 * `chat.cancel-queued`.
 *
 * A session row carries no owner column, so "belongs to this user" cannot be
 * read off the row. The app authenticates at the websocket upgrade, so access is
 * granted to an authenticated request (a user id was read off the upgrade) and
 * refused otherwise; an unauthenticated socket gets `forbidden` and no driver is
 * called. `session` is taken as a parameter so the shape of the check does not
 * change when the row grows an owner: only this function has to move.
 */
export function assertSessionAccess(
  userId: string | number | null,
  _session: ReturnType<typeof sessionsDb.getSessionById>,
): boolean {
  return userId !== null && userId !== undefined && `${userId}`.trim().length > 0;
}

/**
 * The access entry a control handler must call: the injected seam when one was
 * provided, the process default otherwise.
 *
 * Every control verb resolves it here rather than reaching for the module
 * function directly, so an injected entry sees all of them. That is the seam
 * AC-198's criterion reads to prove the three verbs share one entry rather than
 * each carrying an inline check.
 */
function accessEntry(
  dependencies: ChatWebSocketDependencies,
): (userId: string | number | null, session: ReturnType<typeof sessionsDb.getSessionById>) => boolean {
  return dependencies.assertSessionAccess ?? assertSessionAccess;
}

/**
 * One resident control verb, named as the capability matrix states it.
 *
 * The two members are the matrix's own `residentFeatures` keys, not a second
 * vocabulary: a caller asks for the verb it is about to place, and the answer
 * comes from the field whose name matches — so a verb that gains a capability
 * field is wired by naming it here, not by re-deriving what "supported" means.
 */
type ResidentControlVerb = 'stopTask' | 'backgroundTasks';

/**
 * Whether one session's provider declares the resident control verb, read from
 * the shipped capability matrix.
 *
 * This is the control plane stating the *verb-level* verdict itself, before it
 * addresses any particular task. Two properties make that worth doing here
 * rather than only inside the runtime gateway:
 *
 *  - the refusal stops depending on the addressing store. A provider that cannot
 *    stop a background task cannot stop *any* task, so with the gate off the
 *    honest answer is `unsupported` whatever id was named — not `unknown-task`,
 *    which is what the table check would otherwise produce first;
 *  - the verdict becomes the same rule the dock's disabled state mirrors. The
 *    dock disables a control from `GET /api/providers/capabilities` plus the
 *    session's lifecycle mode; this reads those two facts the same way, so the
 *    control that will not be clicked and the request that will be refused
 *    cannot disagree.
 *
 * A `resident` session is the only one this applies to. The per-run route is a
 * different placement — the runtime's own `stopTask` / `backgroundTask` on the
 * process the turn ran on — and the matrix's `residentFeatures` says nothing
 * about it, so a per-run session answers `supported` and keeps its route
 * unchanged. A declaration is read as absent-is-false, the matrix's own
 * "unmeasured is not a promise" discipline; a lookup that throws (no database,
 * no such session) fails open to `true`, because a probe that could not be taken
 * must not become a new reason to refuse.
 */
function defaultResidentControlVerbSupported(
  provider: LLMProvider,
  sessionId: string,
  verb: ResidentControlVerb,
): boolean {
  try {
    if (sessionsDb.getSessionLifecycleMode(sessionId) !== 'resident') {
      return true;
    }
    const features = providerCapabilitiesService.getProviderCapabilities(provider)?.residentFeatures;
    return verb === 'stopTask' ? features?.stopTask === true : features?.backgroundTasks === true;
  } catch {
    return true;
  }
}

/**
 * The capability entry a control handler must consult: the injected seam when
 * one was provided, the process default otherwise.
 *
 * Resolved through one function for the same reason {@link accessEntry} is: a
 * criterion hands over its own reader and observes that the verbs ask the *same*
 * question, and the two handlers cannot drift into disagreeing about what the
 * matrix said.
 */
function residentControlVerbEntry(
  dependencies: ChatWebSocketDependencies,
): (provider: LLMProvider, sessionId: string, verb: ResidentControlVerb) => boolean {
  return dependencies.residentControlVerbSupported ?? defaultResidentControlVerbSupported;
}

/**
 * The chat control service one connection's three transport verbs delegate to.
 *
 * The injected instance wins — production's single process-wide object, or a
 * criterion's counting spy. Only when a harness supplied none (the many existing
 * gateway harnesses that pass a bare `{ runtime }`) is one built here, over that
 * same runtime, so those callers keep working unchanged. `assertSessionAccess`
 * rides along so a harness that injected its own access entry keeps observing
 * `chat.cancel-queued` through it — the one control verb whose ownership check
 * now lives behind the service.
 */
function resolveChatControl(dependencies: ChatWebSocketDependencies): ChatControlSeam {
  return (
    dependencies.control ??
    createChatControlService({
      runtime: dependencies.runtime,
      assertSessionAccess: dependencies.assertSessionAccess,
    })
  );
}


/** The wire protocol carries the model selection; a client-supplied `options.env` is discarded. */
function withoutClientEnv(options: AnyRecord): AnyRecord {
  const { env: _ignoredClientEnv, ...rest } = options;
  return rest;
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: parses the frame, hands the turn to the shared control
 * service and translates the result to the one frame a refusal produces.
 *
 * The session row, provider availability and run registration all live behind
 * `control.send`; this handler neither reads them nor touches the provider
 * runtime. The requesting socket rides along as the run's connection so the
 * stream reaches the same client it always did.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ResolvedChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  // `onRefuse` is called on this very tick — every `send` refusal is decided
  // before `control.send` yields — so a refusal lands on the socket the instant
  // the frame was handled, exactly as the old inline handler's synchronous
  // `dispatchRun` did. A transport that reads the refusal synchronously (the
  // resident busy-input criterion) depends on that tick. `refusedSync` stops the
  // async tail below from writing the same frame a second time.
  let refusedSync = false;
  const result = await dependencies.control.send(
    { userId, via: 'websocket' },
    {
      sessionId,
      content: typeof data.content === 'string' ? data.content : '',
      options: (data.options ?? {}) as AnyRecord,
      connection: ws,
      onRefuse: (refusal) => {
        refusedSync = true;
        sendProtocolError(ws, refusal.code, refusal.message, sessionId);
      },
    },
  );

  if (!result.ok) {
    if (!refusedSync) {
      sendProtocolError(ws, result.code, result.message, sessionId);
    }
    return;
  }

  // The handler's own promise is the frame barrier the per-run parity harness
  // awaits: `send` deliberately resolves at registration — the run keeps going
  // after it — so without this the harness would read the socket's frames before
  // the terminal `complete` arrived. This mirrors the old inline `chat.send`,
  // which awaited the whole `dispatchRun`. No frame is written here; the run's
  // own stream is.
  await result.completion;
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 *
 * Exported for this module's transport-agnostic control service
 * (`chat-control.service.ts`): its `send` calls this with `ws = null` and a
 * `beforeRun` hook, so a run opened by MCP or a timer is registered and
 * dispatched through the exact same path `chat.send` uses rather than a second
 * copy of the registry logic.
 *
 * `beforeRun`'s second argument states whether this dispatch took the
 * resident-session busy path — the registry refused the first `startRun`,
 * `acceptsBusyInput` answered yes, and the turn was admitted as a superseding
 * run. It is reported here, through the same hook that reports the run, because
 * the fact belongs to this function's own control flow: a caller that wants to
 * know "was this turn queued into a running process" must not re-derive it by
 * probing the registry, and existing callers (a plain `chat.send`, an edit)
 * simply ignore the extra argument.
 *
 * `connectionOverride` separates "who this run streams to" from "who a refusal
 * is written to". The transport-agnostic control service dispatches with
 * `ws = null` (it reports refusals as its own result, so `dispatchRun` must not
 * also write a `RUN_IN_PROGRESS` frame) but still binds the requesting socket as
 * the run's connection, so a `chat.send` driven through the control service
 * reaches the same audience as before. Left `undefined` by callers that only
 * ever have one socket, in which case `ws` is used.
 *
 * `source` is the run's recorded origin, when the caller knows one the
 * connection cannot state. The control service passes it explicitly because it
 * always dispatches with `ws = null` (and, for a WebSocket send, with a
 * connection override that is also null): without it, `startRun`'s
 * connection-derived default would file every run the service opens as
 * `scheduled`, including a `chat.send` that arrived over a socket and an MCP
 * tool call. Left `undefined` by callers that want `startRun`'s existing
 * default (a run with a connection is `user`, one without is `scheduled`).
 */
export async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (
    run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>,
    info: { busyAccepted: boolean },
  ) => void | Promise<void>,
  connectionOverride?: RealtimeClientConnection | null,
  /**
   * A synchronous notification that this dispatch was refused because the
   * session already has a run in progress.
   *
   * The refusal is decided before this function's first `await` (`startRun`
   * returning null and the provider not accepting busy input are both
   * synchronous), so a caller that never passes a socket — the shared control
   * service passes `ws = null` and translates the verdict itself — can still
   * report the refusal on the same tick `chat.send` arrived. Passed by the
   * control service alone; every other caller leaves it undefined.
   */
  onRefuse?: (refusal: { code: string; message: string }) => void,
  source?: ChatRunSource,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  const runIsTurn = residentRunIsTurn();
  // Whether a busy send from this provider would be taken by a process that is
  // already running. Read once, before the probe, because run=turn makes two
  // decisions out of one answer: a busy send that IS accepted must not open a run
  // of its own, and a send that cannot be busy-accepted keeps the per-run shape,
  // where the delivery and the run are born together (SPEC §6.1) — so the run is
  // labelled with the delivery this send itself is (SPEC §4.1: a non-resident
  // delivery id is the uuid minted at send time).
  const busyInputAccepted = dependencies.runtime.acceptsBusyInput?.(provider, sessionId) === true;

  const startInput = {
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: connectionOverride ?? ws,
    userId,
    source,
    // A run=turn run's deliveries are what the CLI's ledger binds to the turn; the
    // per-run shape has no ledger, so the only delivery such a run will ever hold
    // is this send's. Off the flag the field is not stated at all.
    ...(runIsTurn && !busyInputAccepted ? { deliveryIds: [randomUUID()] } : {}),
  };

  /** The run this dispatch is admitted under, or `null`/`undefined` when refused. */
  let run: ReturnType<typeof chatRunRegistry.startRun> | undefined;
  let busyAccepted = false;
  if (runIsTurn) {
    // RUN=TURN RETIRES THE SUPERSEDING RUN (SPEC §6.1). A resident session's run IS
    // its turn, so an accepted busy send is a DELIVERY of the turn already in
    // flight rather than a second run: the session keeps the run it has, this
    // command's frames are written through that run's writer, and the CLI's own
    // queue runs the command later. The answer to "can this session take the
    // send" is unchanged; only what it buys changes, from a run to a delivery.
    // Opening a run here was the shape that left the newest run `running` forever,
    // because the CLI folds the command into the turn already in flight and emits
    // only one `RESULT` for it (SPEC §1.2).
    //
    // The probe is not made on this path at all, and that is deliberate: a
    // `startRun` that returns null because the session is busy is a call that
    // mints nothing, so the reading "every startRun call minted a run" (what the
    // S2 criterion takes as evidence that no run is opened behind a turn) holds
    // only when the busy branch is decided by a READ rather than by a refused
    // write. `getRun` is that read; it changes nothing.
    const current = chatRunRegistry.getRun(sessionId);
    if (current && current.status === 'running') {
      // A busy session whose provider cannot take busy input keeps the refusal
      // below — `run` stays undefined, the duplicate-send answer, byte for byte
      // what a per-run session answers today. The provider is never entered.
      if (busyInputAccepted) {
        run = current;
        busyAccepted = true;
      }
    } else {
      run = chatRunRegistry.startRun(startInput);
    }
  } else {
    run = chatRunRegistry.startRun(startInput);

    // The refusal is asked first, and only then is the session asked whether it
    // can take this turn anyway. That order is what keeps the answer correct for
    // every provider that runs a process per turn: it never reaches the second
    // question, so its behaviour is byte-for-byte what it was. A provider that
    // holds one process across turns answers yes, and the turn gets a run of its
    // own — the registry holds one run per session, so `supersedeRunning` is how
    // the newer turn becomes the session's current one instead of being refused.
    // Note that the first call is a pure probe: it returns null precisely when it
    // has changed nothing, which is what makes the retry safe.
    if (!run && busyInputAccepted) {
      run = chatRunRegistry.startRun({ ...startInput, supersedeRunning: true });
      busyAccepted = run !== null;
    }
  }

  if (!run) {
    const message = `Session "${sessionId}" already has a run in progress.`;
    if (ws) {
      sendProtocolError(ws, 'RUN_IN_PROGRESS', message, sessionId);
    }
    // Reported synchronously, before this function's first `await` below, so a
    // socket front end that translated the verdict itself (the control
    // service's `chat.send` adapter) lands the frame on the same tick the old
    // inline handler did.
    onRefuse?.({ code: 'RUN_IN_PROGRESS', message });
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  const rawClientOptions = (data.options ?? {}) as AnyRecord;
  const clientOptions = (dependencies.dropClientEnv ?? withoutClientEnv)(rawClientOptions);
  const command = typeof data.content === 'string' ? data.content : '';

  // THE ONE PLACE a message the person composed is recorded into the U-source
  // lexicon. `dispatchRun` is the single funnel every accepted human turn passes
  // through — the control service's `chat.send` and the inline `chat.edit-send`
  // both land here — so this is the whole auto-record path, not one of several.
  // A second hook anywhere else would count a message twice, which is exactly the
  // number this index exists to report.
  //
  // It is deliberately AFTER the `!run` refusal above: a turn that was refused
  // because the session was busy was never sent, so its words are not something
  // the user said yet. `command` is what the comment below already calls "a
  // message somebody composed"; the injected prompts and credential-style
  // messages are filtered inside the lexicon, so no caller has to know the rules.
  voiceLexicon.observeSentText(command, session.project_path ?? '');

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }
  // The permission mode is a session attribute the client no longer persists
  // anywhere, so this send is the only place it can be recorded. Only a mode
  // the provider's capability matrix lists is stored; an unsupported one is
  // ignored rather than rejected, because the run still has to go out and the
  // client would otherwise be told its message failed over a display detail.
  if (typeof clientOptions.permissionMode === 'string' && clientOptions.permissionMode.trim()) {
    providerModelsService.setSessionPermissionMode(provider, sessionId, clientOptions.permissionMode);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // This dispatch's `command` is a message somebody composed — typed now, or
    // scheduled earlier and fired by the timer below. Marked here and not left
    // to the runtime to infer, because the runtime cannot: an internal driver
    // reaching the same entry passes the same option keys with a *label* in
    // `command`, and a provider that records the prompt it was handed (the
    // debug agent, whose "process" runs a scenario instead of a CLI that would
    // write the row itself) has no other way to tell the two apart.
    [CHAT_TURN_OPTION]: true,
  };

  let failure: string | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run, { busyAccepted });
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  // A resident session cannot take the anchor on the live process: the process
  // already holds the conversation, and writing the replacement into it leaves
  // both the replaced turn and everything it produced in context and in the
  // transcript. So the host is torn down first and the replacement cold-starts
  // a new process from the same provider session at the same truncation point —
  // the session's identity (app id, provider session id, lifecycle mode, jsonl)
  // is untouched, and the abandoned branch is what `dropSupersededPromptBranches`
  // prunes on the next read. The anchor rides along exactly as it does per-run;
  // only the rewind in front of it is resident-specific.
  const rebuildsResidentHost =
    !rewinds && sessionsDb.getSessionLifecycleMode(sessionId) === 'resident';

  const { started, error: runError } = await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      } else if (rebuildsResidentHost) {
        // Awaited, not fired: the replacement process may not come up while the
        // old one is still being torn down, and appending into a host that is on
        // its way out would silently keep the old conversation. A rewind that
        // throws is deliberately not caught here — `dispatchRun`'s own
        // catch settles the run, the provider is never asked to continue a
        // conversation whose host was not rebuilt, and the failure is reported
        // once, below, through the rebuild's own protocol error.
        await resolveHostRewind(dependencies)(sessionId);
      }
    },
  );

  // One report for the whole resident rebuild. It covers both halves — the host
  // that would not close and the process that would not come back up — because
  // either one means the same thing to the person who pressed edit: the
  // conversation was not restarted, so the old turn is still there. Reported
  // only for a run that was actually admitted, so a busy refusal keeps its own
  // `RUN_IN_PROGRESS` and is not relabelled as a rebuild failure.
  if (started && runError && rebuildsResidentHost) {
    sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not restart the conversation: ${runError}`, sessionId);
  }
}

/**
 * The host manager's awaited rewind, as the edit-send rebuild needs it.
 *
 * Read through the gateway's own seam when it was given one that can rewind —
 * the same manager the subscription path is wired to — and off the process-wide
 * manager otherwise. The shape check rather than a bare dereference because the
 * seam's many harnesses hand over narrow fakes; a session whose manager cannot
 * report the rewind is not one to crash a run over.
 */
function resolveHostRewind(
  dependencies: ChatWebSocketDependencies,
): (sessionId: string) => Promise<boolean> {
  const seam = dependencies.sessionHostManager;
  if (seam && typeof seam.rewindAndWait === 'function') {
    const rewind = seam.rewindAndWait;
    return (sessionId) => rewind.call(seam, sessionId);
  }
  return (sessionId) => sessionHostManager.rewindAndWait(sessionId);
}

/**
 * Handles `chat.abort`: cancels the run for one app session through the shared
 * control service and emits the terminal `complete` on its behalf (runtimes skip
 * their own complete for aborted runs, and the registry drops any duplicate).
 *
 * The "is a run live" verdict stays here, as it always has, and is taken before
 * the control service is asked to stop anything — a session with no running run
 * answers `NO_ACTIVE_RUN` without a driver call. When a run *is* live the stop
 * itself (access, provider resolution, the provider's own abort, and the
 * terminal `complete` on the run's behalf) is the control service's; this
 * handler only parses the frame and translates a refusal.
 */
async function handleChatAbort(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ResolvedChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const result = await dependencies.control.abort({ userId, via: 'websocket' }, { sessionId });
  if (!result.ok) {
    sendProtocolError(ws, result.code, result.message, sessionId);
  }
}

/**
 * Handles `chat.cancel-queued`: withdraws a message that a busy send queued in
 * the provider's own process, before that process has started running it.
 *
 * The withdrawal is not the same request as `chat.abort`: aborting stops the
 * turn that is running, while this one takes back a turn that has not started
 * and leaves the running one alone. The address is the message, not the session
 * — a session can have several messages queued, and only the sender knows which
 * one it is taking back — and the id is the one the host stamped the frame with
 * when it wrote it.
 *
 * The verdict is reported as it is, including `already-started`: a message the
 * process has begun running cannot be withdrawn any more, and saying so is the
 * honest answer. `unknown` means the seam could not carry the question at all
 * (no live resident host, or a gateway with no withdrawal verb), which is
 * deliberately not the same answer as "it was already running".
 *
 * The shape matches its two control siblings (`chat.stop-task`,
 * `chat.background-task`): the three fields are required and the request must
 * belong to the session — but the session lookup, provider resolution and the
 * shared access entry now all live behind `control.cancelQueued`, so this
 * handler only parses the frame and formats the receipt. A forbidden request
 * answers with the same receipt kind (the frontend drops this kind as a control
 * frame; changing it would make the client append it as an ordinary message)
 * carrying `result: 'forbidden'` and places no withdrawal. `requestId` was added
 * here so a caller can correlate the receipt with the request it sent, which is
 * what lets the ownership refusal be told apart from an unrelated frame.
 */
async function handleChatCancelQueued(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ResolvedChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.cancel-queued requires a sessionId.');
    return;
  }

  const messageUuid = typeof data.messageUuid === 'string' ? data.messageUuid.trim() : '';
  if (!messageUuid) {
    sendProtocolError(
      ws,
      'MESSAGE_UUID_REQUIRED',
      'chat.cancel-queued requires the messageUuid of the queued message.',
      sessionId
    );
    return;
  }

  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    sendProtocolError(ws, 'REQUEST_ID_REQUIRED', 'chat.cancel-queued requires a requestId.', sessionId);
    return;
  }

  const result = await dependencies.control.cancelQueued(
    { userId, via: 'websocket' },
    { sessionId, messageUuid },
  );

  sendJson(ws, {
    kind: 'queued_input_cancel_result',
    sessionId,
    messageUuid,
    requestId,
    result,
    timestamp: new Date().toISOString(),
  });
}

/** Waits `ms`, never longer than the caller still has left. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Waits, within a bound, for the task table to show the named task settled.
 *
 * This is the second of the control verb's two bounds, and the only one that
 * reads the reducer: the first (the driver call) belongs to the runtime gateway
 * and answers whether the request was placed. Reaching a terminal state here —
 * driven by the `task_notification(stopped)` the provider emits, never by this
 * handler — is the confirmation that turns the driver's `requested` into the
 * caller's `requested`; not reaching one inside the bound is `timeout`, and the
 * table is left exactly as it was.
 *
 * A row that has left the table counts as settled: the handler already proved it
 * was there before the call, so a row that is gone is no longer in flight.
 */
async function waitForTaskSettled(
  getTask: (sessionId: string, taskId: string) => { state: ActivityTask['state'] } | null,
  sessionId: string,
  taskId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = getTask(sessionId, taskId);
    if (!task || TERMINAL_TASK_STATES.has(task.state)) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(pollMs, remaining));
  }
}

/**
 * Handles `chat.stop-task`: stops one named background task of a session, with
 * the request placed through the provider's own process and the confirmation
 * taken from the task table's own event.
 *
 * The shape is deliberately "validate, place, wait, report", and every refusal
 * happens **before** the driver is touched:
 *
 *  1. the three fields (`sessionId`, `taskId`, `requestId`) are required;
 *  2. the session must exist;
 *  3. the request must belong to the session (`assertSessionAccess`);
 *  4. the session's provider must declare the verb at all — a resident session
 *     whose matrix says `stopTask: false` is `unsupported` here, before the task
 *     is even looked up, because that provider cannot stop *any* task;
 *  5. the task must be in the table and not already terminal;
 *  6. only then is the runtime asked, and the capability matrix decides whether
 *     the provider can carry it at all.
 *
 * The receipt never carries a task state and never writes one. `requested` means
 * the request was placed *and* the table confirmed the task left `running`
 * inside the bound; `timeout` means it was placed but no such confirmation
 * arrived, with the table left untouched; `forbidden` and `unknown-task` are the
 * two refusals the task table and the access entry produce, and `unsupported`
 * covers both "this provider declares no such verb" (step 4) and "the driver
 * would not place it" (step 6) — the caller can tell them apart by the
 * capability it read, which is the same read the dock's disabled state goes by.
 * The `task_notification(stopped)` frame is what actually moves the table — this
 * handler reads it, it does not stand in for it.
 */
async function handleChatStopTask(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.stop-task requires a sessionId.');
    return;
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
  if (!taskId) {
    sendProtocolError(ws, 'TASK_ID_REQUIRED', 'chat.stop-task requires a taskId.', sessionId);
    return;
  }

  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    sendProtocolError(ws, 'REQUEST_ID_REQUIRED', 'chat.stop-task requires a requestId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const reply = (result: ControlStopTaskResult): void => {
    sendJson(ws, {
      kind: 'control_result',
      sessionId,
      requestId,
      result,
      timestamp: new Date().toISOString(),
    });
  };

  // Ownership is checked before the task table and long before any driver call,
  // so a forbidden request can neither learn what tasks exist nor place a stop.
  // Resolved through the shared entry (and therefore through the injected seam)
  // so all three control verbs are observed on the one check.
  if (!accessEntry(dependencies)(userId, session)) {
    reply('forbidden');
    return;
  }

  // The verb-level verdict, taken before the task is addressed: a provider that
  // declares no resident stop cannot stop a task it holds either, so the refusal
  // is `unsupported` for any id rather than `unknown-task` for this one.
  const provider = session.provider as LLMProvider;
  if (!residentControlVerbEntry(dependencies)(provider, sessionId, 'stopTask')) {
    reply('unsupported');
    return;
  }

  const getTask = dependencies.getTask ?? defaultGetTask;
  const task = getTask(sessionId, taskId);
  if (!task || TERMINAL_TASK_STATES.has(task.state)) {
    reply('unknown-task');
    return;
  }

  const outcome =
    (await dependencies.runtime.controlStopTask?.(provider, sessionId, taskId)) ?? 'unsupported';
  if (outcome !== 'requested') {
    reply(outcome);
    return;
  }

  const settled = await waitForTaskSettled(
    getTask,
    sessionId,
    taskId,
    dependencies.stopTaskConfirmTimeoutMs ?? DEFAULT_STOP_TASK_CONFIRM_TIMEOUT_MS,
    dependencies.stopTaskConfirmPollMs ?? DEFAULT_STOP_TASK_CONFIRM_POLL_MS,
  );
  reply(settled ? 'requested' : 'timeout');
}

/**
 * The per-socket activity-protocol subscriptions, so a socket that subscribes to
 * the same session twice is left with one feed and a dead socket leaves none.
 *
 * Mirrors the heartbeat's own bookkeeping: the subscription is keyed by the
 * session on the socket that opened it, and its unsubscribe is dropped on the
 * socket's close/error.
 */
const activityFeedsBySocket = new WeakMap<WebSocket, Map<string, () => void>>();

/**
 * Subscribes one socket to the activity protocol's frames for one session.
 *
 * The store hands the joiner its current snapshot the instant it subscribes
 * (`activity.snapshot`, whole — every field, tasks and schedules included) and
 * a whole-snapshot `activity.upsert` on every `recordChange` after that. That is
 * what lets the client draw the background panel from a snapshot on first load
 * and then watch it change without a reload or a poll — the two readings AC-194
 * turns on. A session already fed on this socket is left alone so a re-sent
 * `activity.subscribe` does not double the frame rate.
 *
 * Reached only through {@link handleActivitySubscribe}, never through
 * `chat.subscribe`: the run's frame sequence is a frozen contract, and the
 * `activity.snapshot` this hands a joiner is a frame that contract does not
 * carry (see the comment in `handleChatSubscribe`).
 */
function attachActivityFeed(ws: WebSocket, sessionId: string): void {
  const bySession = activityFeedsBySocket.get(ws) ?? new Map<string, () => void>();
  activityFeedsBySocket.set(ws, bySession);
  if (bySession.has(sessionId)) {
    return;
  }

  const sendFrame = (frame: unknown): void => {
    if (ws.readyState !== WS_OPEN_STATE) {
      return;
    }
    try {
      sendJson(ws, frame);
    } catch {
      // A socket that throws on send is one the close/error path would have
      // handled anyway; the feed is dropped with it.
    }
  };

  const unsubscribe = activityStore.subscribe(sessionId, sendFrame);

  const stopFeed = (): void => {
    unsubscribe();
    bySession.delete(sessionId);
    if (bySession.size === 0) {
      activityFeedsBySocket.delete(ws);
    }
    ws.off('close', stopFeed);
    ws.off('error', stopFeed);
  };

  ws.on('close', stopFeed);
  ws.on('error', stopFeed);
  bySession.set(sessionId, stopFeed);
}

/**
 * Handles `activity.subscribe`: starts feeding this socket the activity
 * protocol's frames for one session.
 *
 * It is deliberately its own verb rather than a side effect of `chat.subscribe`.
 * A `chat.subscribe` reply is the run's frame sequence, and that sequence is a
 * frozen contract: the per-run frame-parity criterion
 * (`session-host-per-run-parity.test.ts`, AC-155) compares it against a baseline
 * recorded on the tree that predates the session-host layer and flags any added
 * frame as a regression. Attaching the feed there injected an `activity.snapshot`
 * frame into that stream and red the criterion; splitting the verb keeps the run
 * stream byte-stable for a client (or a criterion) that never asks for activity,
 * and makes the subscription an explicit opt-in for a client that wants the
 * task/schedule panel. The reply is the store's own contract: a whole
 * `activity.snapshot` for the joiner first, then a whole-snapshot
 * `activity.upsert` per change.
 */
function handleActivitySubscribe(ws: WebSocket, data: AnyRecord): void {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'INVALID_SESSION_ID', 'activity.subscribe requires a sessionId');
    return;
  }
  attachActivityFeed(ws, sessionId);
}

/**
 * Handles `chat.background-task`: promotes one running *foreground* tool of a
 * session to a background task, with the request placed through the provider's
 * own process.
 *
 * The address is the Turn Tracker, not the task table. A foreground tool is not
 * a task until the CLI backgrounds it, so at the moment the request arrives the
 * table has no row for it — the id names a `tool_use` the tracker still holds as
 * pending. The handler therefore refuses every request whose `toolUseId` is not
 * the tracker's currently pending foreground tool, and never reads the task table
 * at all.
 *
 * The shape is "validate, address, place, report", and every refusal happens
 * **before** the driver is touched:
 *
 *  1. the three fields (`sessionId`, `toolUseId`, `requestId`) are required — the
 *     no-toolUseId "background everything" form is refused here, so the driver is
 *     only ever reached with a string id;
 *  2. the session must exist;
 *  3. the request must belong to the session (`assertSessionAccess`);
 *  4. the session's provider must declare the verb at all — a resident session
 *     whose matrix says `backgroundTasks: false` is `unsupported` here, before
 *     the tracker is consulted, for the same reason its stop sibling is;
 *  5. the requested `toolUseId` must equal the Turn Tracker's pending foreground
 *     tool (`readSessionForegroundToolUseId`) — anything else is
 *     `no-foreground-match`, with the driver un-called and no state moved;
 *  6. only then is the runtime asked, and the capability matrix decides whether
 *     the provider can carry it at all.
 *
 * The receipt never carries or writes a task state. `requested` means the request
 * was accepted and placed; whether the task then appears is the reducer's, driven
 * by the frames the CLI emits — this handler writes nothing and the tracker is
 * only ever read.
 */
async function handleChatBackgroundTask(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.background-task requires a sessionId.');
    return;
  }

  const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId.trim() : '';
  if (!toolUseId) {
    sendProtocolError(
      ws,
      'TOOL_USE_ID_REQUIRED',
      'chat.background-task requires the toolUseId of the foreground tool.',
      sessionId
    );
    return;
  }

  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  if (!requestId) {
    sendProtocolError(ws, 'REQUEST_ID_REQUIRED', 'chat.background-task requires a requestId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const reply = (result: ControlBackgroundTaskResult): void => {
    sendJson(ws, {
      kind: 'control_result',
      sessionId,
      requestId,
      result,
      timestamp: new Date().toISOString(),
    });
  };

  // Ownership is checked before the tracker and long before any driver call, so
  // a forbidden request can neither learn what foreground tools exist nor place a
  // background request. Resolved through the shared entry (and therefore through
  // the injected seam) so all three control verbs are observed on the one check.
  if (!accessEntry(dependencies)(userId, session)) {
    reply('forbidden');
    return;
  }

  // The addressing store is the Turn Tracker, never the task table: a foreground
  // tool has no task row yet, and a request that does not name the tracker's
  // pending tool is refused with no driver call and no state moved.
  const provider = session.provider as LLMProvider;
  if (!residentControlVerbEntry(dependencies)(provider, sessionId, 'backgroundTasks')) {
    reply('unsupported');
    return;
  }

  const pendingToolUseId = readSessionForegroundToolUseId(sessionId);
  if (pendingToolUseId !== toolUseId) {
    reply('no-foreground-match');
    return;
  }

  const outcome =
    (await dependencies.runtime.controlBackgroundTask?.(provider, sessionId, toolUseId)) ?? 'unsupported';
  reply(outcome);
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    // The run the client's `lastSeq` was recorded against, if it tracks run
    // ids. Omitted by clients that predate them (and by any client that has
    // seen no run yet), which keeps the plain `seq > lastSeq` replay rule.
    const runIdRaw = (target as AnyRecord).runId;
    const requestedRunId = typeof runIdRaw === 'string' && runIdRaw.length > 0 ? runIdRaw : undefined;

    // A browser is now on this session. Reported before anything else in the
    // loop because it is about the session rather than about the run: a session
    // with no run in flight has no host change to trigger, and one that does is
    // still a session somebody is watching.
    (dependencies.sessionHostManager ?? sessionHostManager).attachViewer(sessionId);

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    //
    // REGISTERED EVEN WHEN NO RUN IS IN FLIGHT. `attachConnection` records the
    // socket against the SESSION whether or not a run is current (and returns
    // whether one was), so a page opened while the session is idle is already
    // watching when the session's next run opens. Without this, an idle subscribe
    // registered nothing, and a voice `session_send` — which opens its run with
    // `connection: null` — carried no audience, so the queued sentence's
    // `command_lifecycle` rows were written to nobody and the withdraw row never
    // resolved (2026-10-14). The `chat_subscribed` ack below still reports the
    // run's own bit, so this does not claim a run exists when none does.
    chatRunRegistry.attachConnection(sessionId, ws);

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    // The ack names the run the server is currently on, so the client can
    // reset a cursor that was recorded against an earlier run. Omitted when no
    // run is in flight — there is no run identity to report.
    // The hello also carries the activity contract: which process this is
    // (`bootId`), the session's current activity revision, and the two timings
    // the heartbeat below will use. A client that compares `bootId` across
    // reconnects can tell a restart from a hiccup, and it can degrade to
    // "unreachable" when no frame arrives inside the announced threshold —
    // neither is possible from the invisible protocol-level ping.
    const ack: AnyRecord = {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      ...activityAnnouncement(sessionId),
      timestamp: new Date().toISOString(),
    };
    if (run) {
      ack.runId = run.runId;
    }
    sendJson(ws, ack);

    // A browser is now watching this session, so the server starts proving it
    // is still alive on the beat it just announced. Each beat carries the run
    // registry's own in-flight bit (the same one the hello above reports), so a
    // running turn whose provider sends no phase-carrying frames cannot be read
    // as ended just because the phase tracker has no phase for it.
    attachActivityHeartbeat(ws, sessionId, () => chatRunRegistry.isProcessing(sessionId));

    // The activity feed is deliberately NOT attached here: a `chat.subscribe`
    // reply is the run's frame sequence, and attaching the feed would inject an
    // `activity.snapshot` frame into it. That sequence is a frozen contract (the
    // per-run frame-parity criterion compares it against a pre-wrapper baseline
    // and forbids any added frame), so the activity feed has its own opt-in —
    // `activity.subscribe` — handled below.

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq, requestedRunId)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `ui.hello`: records which browser and tab this connection belongs to.
 *
 * The identity is per connection and lives no longer than it does — the close
 * handler below forgets it — so a reconnect simply announces itself again. The
 * frame is validated inside the registry (both ids must be bounded non-empty
 * strings); an unusable one is dropped with **no** reply and no other effect on
 * the connection, because a client whose announcement the server could not read
 * still has a perfectly good socket, and refusing its frames would turn a
 * display-detail mismatch into a broken session.
 */
function handleUiHello(
  ws: WebSocket,
  data: AnyRecord,
  registry: UiClientRegistry,
): void {
  registry.register(ws, data);
}

/**
 * Handles `ui.state_response`: a tab answering "what are you showing".
 *
 * The frame is a reply to a broadcast the server made itself, so it is routed by
 * `requestId` to the one call still waiting for it — the round trip's service
 * owns that table. A frame nothing is waiting for (a duplicate, a stale answer,
 * a `requestId` this process never minted) is dropped in silence: it is not a
 * client error, and replying with a protocol error would let a harmless late
 * frame from a slow browser produce noise on a connection that is otherwise
 * fine.
 */
function handleUiStateResponse(
  ws: WebSocket,
  data: AnyRecord,
  service: UiStateRequestService,
): void {
  service.handleResponse(ws, data);
}

/**
 * Handles `ui.navigate_ack`: a tab saying it received a `ui.navigate`.
 *
 * A delivery ack, routed by `navigationId` to the call still waiting for it. A
 * malformed, unknown or late frame is dropped in silence for the same reason a
 * stray `ui.state_response` is: the server asked for it, and a harmless leftover
 * from a slow browser is not a client error.
 */
function handleUiNavigateAck(
  ws: WebSocket,
  data: AnyRecord,
  service: UiNavigationService,
): void {
  service.handleAck(ws, data);
}

/**
 * Handles `ui.navigate_result`: a tab reporting what the user finally decided
 * about a navigation.
 *
 * Routed by `navigationId` to the RECORD — which may be long since returned to
 * the MCP caller — not to a pending call, because the user decides on their own
 * schedule. An `applied` result is what writes the "last opened" pointer; an
 * unknown or pruned id is dropped.
 */
function handleUiNavigateResult(
  ws: WebSocket,
  data: AnyRecord,
  service: UiNavigationService,
): void {
  service.handleResult(ws, data);
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.cancel-queued`       { sessionId, messageUuid, requestId }
 * - `chat.stop-task`           { sessionId, taskId, requestId }
 * - `chat.background-task`     { sessionId, toolUseId, requestId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `ui.hello`                 { deviceId, tabId, deviceName }
 * - `ui.state_response`        { requestId, deviceId, tabId, deviceName, …report }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `activity.heartbeat`, `session_upserted`,
 * `loading_progress`, `queued_input_cancel_result`, `control_result`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  // One control service for this connection's three transport verbs: the
  // injected instance (production's single process-wide object, or a criterion's
  // spy), or — for a harness that drove the gateway with a bare `{ runtime }` —
  // one resolved over that same runtime. Resolved here, once, so no handler
  // builds one and the connection cannot hold two.
  const resolvedDependencies: ResolvedChatWebSocketDependencies = {
    ...dependencies,
    control: resolveChatControl(dependencies),
  };

  // The registry this connection's identity goes into and is removed from. Both
  // ends use the same resolved instance so a socket cannot be announced to one
  // listing and forgotten from another.
  const uiClients = dependencies.uiClients ?? uiClientRegistry;

  // The round trip this connection's `ui.state_response` frames are routed into.
  // Resolved the same way — the injected service or the process-wide one — so a
  // browser's answer and the request that asked for it can never be held by two
  // different tables.
  const uiStateRequests = dependencies.uiStateRequests ?? uiStateRequestService;

  // The navigation log this connection's `ui.navigate_ack` / `ui.navigate_result`
  // frames are routed into. Resolved the same way — the injected service or the
  // process-wide one — so an instruction's delivery and its final outcome can
  // never be held by two different logs.
  const uiNavigations = dependencies.uiNavigations ?? uiNavigationService;

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, resolvedDependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, resolvedDependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, userId, data, resolvedDependencies);
          return;
        case 'chat.cancel-queued':
          await handleChatCancelQueued(ws, userId, data, resolvedDependencies);
          return;
        case 'chat.stop-task':
          await handleChatStopTask(ws, userId, data, resolvedDependencies);
          return;
        case 'chat.background-task':
          await handleChatBackgroundTask(ws, userId, data, resolvedDependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, resolvedDependencies);
          return;
        case 'activity.subscribe':
          handleActivitySubscribe(ws, data);
          return;
        case 'ui.hello':
          handleUiHello(ws, data, uiClients);
          return;
        case 'ui.state_response':
          handleUiStateResponse(ws, data, uiStateRequests);
          return;
        case 'ui.navigate_ack':
          handleUiNavigateAck(ws, data, uiNavigations);
          return;
        case 'ui.navigate_result':
          handleUiNavigateResult(ws, data, uiNavigations);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, resolvedDependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    // Identity is a fact about a live connection, so it leaves with the socket.
    // A browser that reconnects announces itself again on the new one.
    uiClients.unregister(ws);
  });
}
