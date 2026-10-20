/**
 * The MCP contract's approval vocabulary.
 *
 * Re-homed from `server/modules/mcp-gateway/mcp-approvals.ts` (AC-274): the
 * deps bag and the report shapes the two approval tools speak. They are stated
 * here so a stage-2 tool package can implement `approvals_list` /
 * `approval_answer` against the contract without importing the gateway
 * (proposal `docs/proposals/mcp-gateway-tool-architecture.md`, rule R2).
 *
 * The adapter that CALLS the shared `ChatControlService` is unchanged and still
 * lives in the gateway for stage 1; only the types moved.
 *
 * Consumers: `mcp-approvals.ts` (re-exported through the gateway barrel), which
 * keeps the production registration, and the stage-2 approval tool package.
 */

import type { MissingApprovalReason } from '@/shared/types.js';

import type { McpControlCaller } from './types.js';

/**
 * One pending approval as the runtime reports it, the shape the approval
 * adapter reads.
 *
 * Structurally the claude runtime's `getPendingApprovalsForSession` entry. Only
 * the fields the tools report are declared; `context` (the runtime's opaque bag)
 * is not needed here.
 */
export type McpApprovalPending = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  receivedAt: Date;
};

/**
 * The result `pendingApprovals` returns, declared structurally because the
 * control service's own `PendingApprovalsResult` is module-local.
 */
export type McpPendingApprovalsResult =
  | { ok: true; approvals: McpApprovalPending[] }
  | { ok: false; code: 'FORBIDDEN' | 'SESSION_NOT_FOUND'; message: string };

/**
 * The result `answerApproval` returns, declared structurally.
 *
 * The expired branch carries the control plane's `reason` — the distinction
 * AC-287 makes the adapter report as `details.reason` on the
 * `APPROVAL_NOT_FOUND` envelope — while `FORBIDDEN` is translated to a
 * structured refusal (AC-232's vocabulary).
 *
 * `ALREADY_DECIDED` is the third refusal the control plane can state: the
 * request was live but another caller settled it first. It carries the winning
 * `decidedBy`/`decidedAt` and is reported under the same forwarded code (see
 * the gateway's `buildApprovalAnswer`), never as `APPROVAL_NOT_FOUND` — the id
 * DID exist and WAS answered, just not by this caller.
 */
export type McpAnswerApprovalResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      code: 'APPROVAL_EXPIRED_OR_NOT_FOUND';
      reason: MissingApprovalReason;
      message: string;
    }
  | {
      ok: false;
      code: 'ALREADY_DECIDED';
      decidedBy: string | null;
      decidedAt: number;
      message: string;
    }
  | {
      ok: false;
      code: 'FORBIDDEN';
      message: string;
    };

/**
 * The services the two approval tools answer from: the SAME one control service
 * the rest of the gateway uses, presented under its approval verbs, plus the
 * wall clock.
 *
 * The control service is the real `createChatControlService` instance in
 * production and in the criterion alike — only its `runtime` differs (a fake in
 * the criterion) — so the shared access entry, the in-registry precheck and the
 * scope refusal are all the production ones. `now` is injected so "how long has
 * this waited" can be asserted exactly.
 */
export type McpApprovalsDeps = {
  control: {
    pendingApprovals(
      caller: McpControlCaller,
      input: { sessionId?: string },
    ): Promise<McpPendingApprovalsResult>;
    answerApproval(
      caller: McpControlCaller,
      input: { requestId: string; allow: boolean; answers?: unknown; message?: string },
    ): Promise<McpAnswerApprovalResult>;
  };
  now(): number;
};

/** One option of an `AskUserQuestion` question, as the tool reports it. */
export type McpApprovalOption = {
  label: string;
  description?: string;
  multiSelect?: boolean;
};

/** One expanded `AskUserQuestion` question. */
export type McpApprovalQuestion = {
  question: string;
  header?: string;
  options: McpApprovalOption[];
};

/** One pending approval as `approvals_list` reports it. */
export type McpApprovalListItem = {
  requestId: string;
  /** The session id the approval belongs to. */
  session: string;
  toolName: string;
  /** A human-readable digest of the tool's input — never the whole input verbatim. */
  inputSummary: string;
  /**
   * True when only a person can answer this (an `AskUserQuestion` /
   * `ExitPlanMode`): the run waits indefinitely and will not time out on its
   * own. False for an ordinary permission prompt, which auto-denies at
   * {@link McpApprovalListItem.autoTimeoutMs}. From the runtime's own
   * `describeApprovalPolicy`, never re-derived here.
   */
  interactive: boolean;
  /**
   * The auto-deny deadline in milliseconds for a non-interactive request, or
   * `null` when there is none (an interactive one waits forever). The real
   * `TOOL_APPROVAL_TIMEOUT_MS` the runtime would enforce — not an echo.
   */
  autoTimeoutMs: number | null;
  /** How long the request has waited, in milliseconds, from the injected clock. */
  waitedMs: number;
  /** Present only for an `AskUserQuestion`: its questions expanded into text and options. */
  questions?: McpApprovalQuestion[];
};

/**
 * The pending-interaction reading `session_get` carries, derived from the SAME
 * projection `approvals_list` uses — an {@link McpApprovalListItem} without its
 * `session` (already stated by the tool the reading hangs off).
 *
 * It is a `Pick`-by-omission of the list item on purpose: `session_get` and
 * `approvals_list` must report the same request id, tool, questions and wait for
 * the same request, and a second hand-written projection would be a second
 * answer that could drift.
 */
export type McpPendingInteraction = Omit<McpApprovalListItem, 'session'>;

/** The `approvals_list` result. */
export type ApprovalsListPayload = {
  approvals: McpApprovalListItem[];
};

/**
 * The `approval_answer` result, on success only.
 *
 * A failure is no longer a payload of this shape: AC-287 moved both refusals to
 * the error side, so a caller sees either this (the decision was handed over) or
 * an `isError` envelope (`APPROVAL_NOT_FOUND` / `FORBIDDEN`). The former
 * `code` / `message` fields are gone with the `ok:false` payload that carried
 * them — a "successful answer" now has exactly one shape.
 */
export type ApprovalAnswerPayload = {
  ok: true;
  requestId: string;
  /** `allow` / `deny` on success. */
  decision: string;
};

/** The `approvals_list` tool's typed input. */
export type McpApprovalsListInput = { session?: string };

/** The `approval_answer` tool's typed input. */
export type McpApprovalAnswerInput = {
  requestId: string;
  allow: boolean;
  answers?: unknown;
  message?: string;
};
