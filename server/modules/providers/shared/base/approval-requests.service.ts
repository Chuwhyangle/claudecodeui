/**
 * The shared approval-request service: the one owner of the "ask a connected
 * client and wait for its answer" protocol that both resident providers use.
 *
 * Claude's per-run and resident paths asked this question first (AC-168) and
 * Codex's app-server asks it for five server-request kinds (AC-438). The state
 * and the wire frames are identical — a `permission_request` frame on the run's
 * writer, an `action_required` notification, a bounded wait, then
 * `permission_resolved` — so they live here once instead of in either provider.
 * The per-provider differences are arguments: `provider` names the frame's
 * provider id and `onPermissionPhase` is the provider's optional observer
 * (Claude feeds its turn tracker through it; Codex has no equivalent and does
 * not pass one).
 *
 * Consumed by `claude-runtime.provider.ts` (which re-exports every name below
 * unchanged), `codex-runtime.provider.ts` (the permissions facet the
 * `provider-runtime.service` fan-out reaches), and the Codex approval broker in
 * `providers/list/codex/`.
 *
 * Lives in `providers/shared/base/` rather than `providers/services/` on
 * purpose: `modules/providers/services` already imports
 * `providers/list/codex/codex-transcript-format.ts`
 * (`session-conversations-search.service.ts`), so a `list/codex` import back
 * into `services` would close a new directory cycle in the AC-394 budget
 * ratchet. `providers/shared/base` is a leaf of the providers component — it
 * points only at `server/shared/**`, `modules/notifications` and itself — so
 * both provider implementations may import it without becoming a cycle member.
 */
import {
  createBoundedLedger,
  MAX_REMEMBERED_APPROVALS,
} from '@/shared/bounded-approval-ledger.js';
import { createNotificationEvent } from '@/modules/notifications/index.js';
import { readSessionAwaitingReplyPort } from '@/shared/ports/session-awaiting-reply.port.js';
import { createNormalizedMessage } from '@/shared/utils.js';
import type {
  AnyRecord,
  ApprovalDecisionRecord,
  LLMProvider,
  MissingApprovalReason,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/**
 * A pending tool-approval waiter.
 *
 * The extra fields are the metadata `getPendingApprovalsForSession` replays a
 * pending prompt from, attached to the resolver so one map holds the wait and
 * the facts a reconnecting client needs.
 */
type ToolApprovalResolver = ((decision: AnyRecord | null) => void) & {
  _sessionId?: string | null;
  _toolName?: string;
  _input?: unknown;
  _context?: unknown;
  _receivedAt?: Date;
};

/** The options one tool-approval wait is armed with. */
type ToolApprovalOptions = {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  onCancel?: (reason: string) => void;
  metadata?: AnyRecord | null;
};

/** The phase change a `permission_request`/`permission_resolved` frame states. */
export type ToolApprovalPhaseEvent = {
  kind: 'permission_request' | 'permission_resolved';
  requestId: string;
};

/**
 * Observes the permission lifecycle for a session, when the provider has a
 * consumer for it (Claude's turn tracker does; Codex does not).
 */
export type ToolApprovalPhaseObserver = (
  sessionId: string,
  event: ToolApprovalPhaseEvent,
) => void;

/** One client decision request. */
export type ClientToolDecisionInput = {
  /** The frame's provider id; defaults to `claude` so legacy callers keep their wire shape. */
  provider?: LLMProvider;
  toolName: string;
  input: unknown;
  /** True for a request only a person can answer; makes the default wait unbounded. */
  requiresInteraction: boolean;
  requestId: string;
  /** The run's writer. The caller guarantees it is present when a client is. */
  ws: ProviderRuntimeWriter | null;
  emitNotification: (event: AnyRecord) => void;
  sessionId: string | null;
  sessionSummary: string | null;
  signal?: AbortSignal | null;
  onCancel?: (reason: string) => void;
  /** Explicit deadline; when omitted the Claude default policy applies. */
  timeoutMs?: number;
  /** Provider-specific phase observer; never called with a null session id. */
  onPermissionPhase?: ToolApprovalPhaseObserver;
};

/**
 * How long an ordinary (non-interactive) tool approval waits before it is
 * auto-denied, in milliseconds. Read once from the environment.
 *
 * Exported because the MCP gateway has to state this same deadline on the
 * requests it lists (`approvals_list`'s `autoTimeoutMs` and
 * `session_get`'s `pendingInteraction`), and a re-derived copy would be a
 * second answer to the same question.
 */
export const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS as string, 10) || 55000;

/**
 * Owns the pending-approval registry and the two bounded ledgers.
 *
 * The pending map is emptied the instant a request settles, so the held ledger
 * (was this id ever minted here?) and the decision ledger (who settled it?)
 * keep the two facts a late caller needs after the wait is gone. One instance
 * is shared by every provider: request ids are unique, so a settle is
 * idempotent across the fan-out and a second resolve for the same id is a
 * no-op.
 */
export class ApprovalRequestsService {
  /** Tool-approval waits keyed by request id, awaiting a client decision. */
  private readonly pending = new Map<string, ToolApprovalResolver>();

  /** Ids this process has HELD; survives the pending entry's deletion. */
  private readonly held = createBoundedLedger<true>(MAX_REMEMBERED_APPROVALS);

  /** Ids this process has DECIDED, recorded at settle time. */
  private readonly decisions = createBoundedLedger<ApprovalDecisionRecord>(MAX_REMEMBERED_APPROVALS);

  /**
   * Classifies a `requestId` that is NOT in the pending registry.
   *
   * `expired` means this process held the request and no longer does (it timed
   * out or was already decided); `never_issued` means nothing here ever minted
   * it. Consumed by `provider-runtime.service.ts`'s fan-out and, through it,
   * `chat-control.service.ts` / `mcp-approvals.ts`.
   */
  classifyMissingApproval = (requestId: string): MissingApprovalReason =>
    this.held.has(requestId) ? 'expired' : 'never_issued';

  /**
   * The decision this process recorded for a request id, or `null` when it
   * never decided one. A request still awaiting an answer reads `null`.
   */
  readApprovalDecision = (requestId: string): ApprovalDecisionRecord | null =>
    this.decisions.read(requestId) ?? null;

  /** Pending approvals for one app session, in arming order. */
  getPendingApprovalsForSession = (sessionId: string): AnyRecord[] => {
    const pending: AnyRecord[] = [];
    for (const [requestId, resolver] of this.pending.entries()) {
      if (resolver._sessionId === sessionId) {
        pending.push({
          requestId,
          toolName: resolver._toolName || 'UnknownTool',
          input: resolver._input,
          context: resolver._context,
          sessionId,
          receivedAt: resolver._receivedAt || new Date(),
        });
      }
    }
    return pending;
  };

  /**
   * Settles one pending request.
   *
   * A decision for an id this process is not holding must not enter the ledger,
   * or a later caller would read a settlement that never happened — so the
   * lookup and the ledger write are one synchronous step. The decision is
   * recorded BEFORE the resolver runs, because `finalize` deletes the pending
   * entry in the same tick.
   */
  resolveToolApproval = (
    requestId: string,
    decision: AnyRecord | null,
    decidedBy: string | null = null,
  ): void => {
    const resolver = this.pending.get(requestId);
    if (!resolver) {
      return;
    }
    this.decisions.remember(requestId, {
      decidedAt: Date.now(),
      decidedBy,
      allow: typeof decision?.allow === 'boolean' ? decision.allow : null,
    });
    resolver(decision);
  };

  /**
   * Asks the attached client to decide one human-facing request.
   *
   * A `permission_request` frame on the run's writer, an `action_required`
   * notification, then a wait. `permission_resolved` is sent before the answer
   * is handed back, so a mid-run page refresh cannot resurrect a prompt that
   * has nothing left to retract it.
   *
   * Returns the client's own decision object, `{ cancelled: true }` when the
   * wait was aborted, or `null` when it timed out.
   */
  requestClientToolDecision = async ({
    provider = 'claude',
    toolName,
    input,
    requiresInteraction,
    requestId,
    ws,
    emitNotification,
    sessionId,
    sessionSummary,
    signal,
    onCancel = undefined,
    timeoutMs,
    onPermissionPhase,
  }: ClientToolDecisionInput): Promise<AnyRecord | null> => {
    ws!.send(createNormalizedMessage({
      kind: 'permission_request',
      requestId,
      toolName,
      input,
      sessionId: sessionId || null,
      provider,
    }));
    if (sessionId) {
      onPermissionPhase?.(sessionId, { kind: 'permission_request', requestId });
    }
    emitNotification(createNotificationEvent({
      provider,
      sessionId: sessionId || null,
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName, sessionName: sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `${provider}:permission:${sessionId || 'none'}:${requestId}`,
    } as unknown as Parameters<typeof createNotificationEvent>[0]));

    // The permission prompt is a wait the USER owes an answer to, so the
    // session belongs on the sidebar's awaiting-reply list while the prompt is
    // outstanding. Marked after the notification so the two cannot disagree
    // about whether the request was ever shown, and read through the shared port
    // rather than importing the providers service: this file is a leaf of the
    // providers component (see the header), and the codex half of it must not
    // pull `providers/services` into the codex group's import graph.
    readSessionAwaitingReplyPort()?.markSessionAwaitingReply(sessionId, 'permission');

    let decision: AnyRecord | null = null;
    try {
      decision = await this.waitForToolApproval(requestId, {
        timeoutMs: timeoutMs ?? (requiresInteraction ? 0 : TOOL_APPROVAL_TIMEOUT_MS),
        signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws!.send(createNormalizedMessage({
            kind: 'permission_cancelled',
            requestId,
            reason,
            sessionId: sessionId || null,
            provider,
          }));
          onCancel?.(reason);
        },
      });
    } finally {
      // The wait is over the moment it settles, times out or aborts — the
      // observer must leave its waiting phase in every one of those cases.
      if (sessionId) {
        onPermissionPhase?.(sessionId, { kind: 'permission_resolved', requestId });
        // The awaiting-reply row follows the same rule: answering the prompt
        // means the turn is moving again. A turn that then fails or finishes
        // re-marks the row with its own reason, so clearing here cannot lose the
        // later state; it only prevents a settled prompt from leaving the row
        // saying "permission" for a turn that is already running on.
        readSessionAwaitingReplyPort()?.clearSessionAwaitingReply(sessionId);
      }
    }
    if (!decision) {
      return null;
    }
    if (decision.cancelled) {
      return { cancelled: true };
    }

    ws!.send(createNormalizedMessage({
      kind: 'permission_resolved',
      requestId,
      sessionId: sessionId || null,
      provider,
    }));
    return decision;
  };

  /** Arms one wait and resolves it on a decision, a timeout or an abort. */
  private waitForToolApproval(
    requestId: string,
    options: ToolApprovalOptions = {},
  ): Promise<AnyRecord | null> {
    const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

    // Recorded at ARM time, not at settle time: the ledger must still name this
    // id after `cleanup()` deletes the pending entry, which is the whole point.
    this.held.remember(requestId, true);

    return new Promise((resolve) => {
      let settled = false;

      const finalize = (decision: AnyRecord | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(decision);
      };

      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        this.pending.delete(requestId);
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      // timeoutMs 0 = wait indefinitely (interactive tools)
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          onCancel?.('timeout');
          finalize(null);
        }, timeoutMs);
      }

      const abortHandler = () => {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
      };

      if (signal) {
        if (signal.aborted) {
          onCancel?.('cancelled');
          finalize({ cancelled: true });
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const resolver: ToolApprovalResolver = (decision) => {
        finalize(decision);
      };
      if (metadata) {
        Object.assign(resolver, metadata);
      }
      this.pending.set(requestId, resolver);
    });
  }
}

/**
 * Builds one approval-requests owner. Callers that must not share process-wide
 * state (tests, a second runtime) construct their own; the server uses
 * {@link approvalRequests}.
 */
export function createApprovalRequestsService(): ApprovalRequestsService {
  return new ApprovalRequestsService();
}

/** The process-wide owner both resident providers' permission facets point at. */
export const approvalRequests = createApprovalRequestsService();
