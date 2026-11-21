import { sessionsDb } from '@/modules/database/index.js';
import type {
  ControlBackgroundTaskOutcome,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import type {
  AnyRecord,
  ApprovalDecisionRecord,
  HostQueuedInputCancelResult,
  MissingApprovalReason,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/**
 * The leaf contract between the chat control service and the WebSocket
 * transport.
 *
 * The two modules used to import each other: the transport needs
 * `createChatControlService`, and the service needed the gateway's port type
 * and the shared access entry. That was a package-local import cycle
 * (`cycle-websocket-services-two-pairs`). The port and the one access predicate
 * move here so the dependency is one-way: transport → service → this leaf.
 * Nothing here imports either module, so this file cannot close a cycle.
 */

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
 * The one access predicate every control verb and every transport handler
 * shares. Both sides declare the same seam, so a criterion can hand over one
 * counting spy and observe that all of them go through the *same* entry.
 */
export type SessionAccessCheck = (
  userId: string | number | null,
  session: ReturnType<typeof sessionsDb.getSessionById>,
) => boolean;

/**
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
