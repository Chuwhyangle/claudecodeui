/**
 * The MCP gateway's `approvals_list` and `approval_answer` handlers (AC-274).
 *
 * The two tools are an ADAPTER over the shared `ChatControlService`'s
 * `pendingApprovals` / `answerApproval` verbs (AC-274 lands those in
 * `chat-control.service.ts`), the same transport-free control plane the
 * WebSocket gateway and the scheduled dispatcher use. This module owns the
 * tool-facing vocabulary and nothing else:
 *
 *  - `approvals_list` reads the pending set and reshapes each entry into the
 *    tool's report: the request id, the session, the tool name, a HUMAN-READABLE
 *    input summary (never the whole input verbatim) and how long it has waited,
 *    computed from the injected clock and the entry's `receivedAt`. For an
 *    `AskUserQuestion` it EXPANDS the input's `questions` into the question text
 *    and each option's label/description, so a caller reads the question rather
 *    than parsing a raw argument blob.
 *  - `approval_answer` forwards `allow` (and `message` / `answers`) to the
 *    control service. `answers` is the runtime's `updatedInput` — it is not a
 *    distinct field — and `message` rides alongside it. A request that is no
 *    longer pending is an ERROR (AC-287): `isError: true` with
 *    `code: APPROVAL_NOT_FOUND` and `details.reason` distinguishing a request
 *    that timed out (`expired`) from one this process never minted
 *    (`never_issued`). The control plane's English sentence ("the approval
 *    request has expired or does not exist") is now the envelope's `message`.
 *    The control service has already guaranteed `resolveToolApproval` was not
 *    called.
 *
 * Everything is injected ({@link McpApprovalsDeps}): production wires the one
 * process control service and a real clock (`server/index.ts`); the criterion
 * wires the REAL control service over a FAKE runtime and a pinned clock, so the
 * "expired" and "answers -> updatedInput" readings are observable at the runtime
 * seam rather than asserted against a stub of the service under test.
 *
 * Scope comes from AC-243's single vocabulary (`ACCESS_TOKEN_SCOPES`): the list
 * tool needs `cloudcli:read`, the answer tool `cloudcli:approve`.
 */

import { z } from 'zod';

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';
import { describeApprovalPolicy } from '@/modules/providers/index.js';
import type { MissingApprovalReason } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpControlCaller } from './mcp-session-send.js';

// Position within AC-243's single scope vocabulary, in the order the constant
// declares and `access-token-scopes.test.ts` pins: read, session:send,
// session:create, session:control, approve.
const [READ_SCOPE, , , , APPROVE_SCOPE] = ACCESS_TOKEN_SCOPES;

// --------------------------- control-service vocabulary ---------------------------

/**
 * One pending approval as the runtime reports it, the shape this adapter reads.
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
 * AC-287 makes this adapter report as `details.reason` on the
 * `APPROVAL_NOT_FOUND` envelope — while `FORBIDDEN` is translated to a
 * structured refusal (AC-232's vocabulary).
 *
 * `ALREADY_DECIDED` is the third refusal the control plane can state: the
 * request was live but another caller settled it first. It carries the winning
 * `decidedBy`/`decidedAt` and is reported under the same forwarded code (see
 * `buildApprovalAnswer`), never as `APPROVAL_NOT_FOUND` — the id DID exist and
 * WAS answered, just not by this caller.
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
 * The services the two tools answer from: the SAME one control service the rest
 * of the gateway uses, presented under its approval verbs, plus the wall clock.
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

// --------------------------- list payload ---------------------------

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

// --------------------------- input schemas and readers ---------------------------

/** The `approvals_list` tool's Zod input shape, used for registration and validation. */
const APPROVALS_LIST_INPUT_SCHEMA = {
  session: z.string().optional(),
} satisfies z.ZodRawShape;

/** The `approval_answer` tool's Zod input shape, used for registration and validation. */
const APPROVAL_ANSWER_INPUT_SCHEMA = {
  requestId: z.string(),
  allow: z.boolean(),
  answers: z.unknown().optional(),
  message: z.string().optional(),
} satisfies z.ZodRawShape;

/** The `approvals_list` tool's typed input. */
export type McpApprovalsListInput = { session?: string };

/** Reads and validates `approvals_list`'s arguments. */
function readApprovalsListInput(args: Record<string, unknown>): McpApprovalsListInput {
  const session = args.session;
  if (session === undefined || session === null) {
    return {};
  }
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" must be a non-empty string when given.',
    );
  }
  return { session };
}

/** The `approval_answer` tool's typed input. */
export type McpApprovalAnswerInput = {
  requestId: string;
  allow: boolean;
  answers?: unknown;
  message?: string;
};

/** Reads and validates `approval_answer`'s arguments. */
function readApprovalAnswerInput(args: Record<string, unknown>): McpApprovalAnswerInput {
  const requestId = args.requestId;
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"requestId" is required and must be a non-empty string.',
    );
  }
  const allow = args.allow;
  if (typeof allow !== 'boolean') {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, '"allow" is required and must be a boolean.');
  }
  const input: McpApprovalAnswerInput = { requestId, allow };
  if (args.answers !== undefined) {
    input.answers = args.answers;
  }
  if (args.message !== undefined) {
    if (typeof args.message !== 'string') {
      throw new McpToolError(
        MCP_ERROR_CODES.INVALID_ARGUMENT,
        '"message" must be a string when given.',
      );
    }
    input.message = args.message;
  }
  return input;
}

// --------------------------- input summary ---------------------------

/**
 * Input keys whose scalar value is more useful to a human than the JSON blob.
 * In order: a shell command, the file it touches, a pattern, or a URL.
 */
const SUMMARY_SCALAR_KEYS = ['command', 'file_path', 'pattern', 'url'] as const;

/** The longest a summary may be before one trailing ellipsis replaces the tail. */
const SUMMARY_MAX_CHARS = 200;

/** Truncates to {@link SUMMARY_MAX_CHARS}, appending a single ellipsis when cut. */
function truncateSummary(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text;
}

/**
 * Reduces a tool's raw input to a one-line human-readable summary.
 *
 * A known scalar key (`command` / `file_path` / `pattern` / `url`) is preferred
 * because it names what the tool is about to do; anything else falls back to the
 * JSON encoding, truncated. The whole input is deliberately NOT returned
 * verbatim: a pending approval's input can be arbitrarily large, and the point of
 * the listing is a glance rather than a copy.
 */
function summarizeApprovalInput(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of SUMMARY_SCALAR_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return truncateSummary(value);
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(input ?? null);
  } catch {
    encoded = String(input);
  }
  return truncateSummary(encoded ?? 'null');
}

/**
 * Expands an `AskUserQuestion` input's `questions` array into report shape.
 *
 * Each question keeps its text and header; each option keeps the label and, when
 * present, its description and `multiSelect`. A question or option without the
 * required string field is skipped rather than reported half-formed, and a
 * non-array `questions` yields an empty list (the caller sees no expansion
 * rather than a fabricated one).
 */
function extractApprovalQuestions(input: unknown): McpApprovalQuestion[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) {
    return [];
  }

  const expanded: McpApprovalQuestion[] = [];
  for (const raw of questions) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.question !== 'string') {
      continue;
    }

    const options: McpApprovalOption[] = [];
    if (Array.isArray(record.options)) {
      for (const rawOption of record.options) {
        if (typeof rawOption !== 'object' || rawOption === null) {
          continue;
        }
        const option = rawOption as Record<string, unknown>;
        if (typeof option.label !== 'string') {
          continue;
        }
        const reading: McpApprovalOption = { label: option.label };
        if (typeof option.description === 'string') {
          reading.description = option.description;
        }
        if (typeof option.multiSelect === 'boolean') {
          reading.multiSelect = option.multiSelect;
        }
        options.push(reading);
      }
    }

    const question: McpApprovalQuestion = { question: record.question, options };
    if (typeof record.header === 'string') {
      question.header = record.header;
    }
    expanded.push(question);
  }
  return expanded;
}

/** Projects one runtime entry into the tool's report, computing the wait from the injected clock. */
function toApprovalListItem(entry: McpApprovalPending, now: number): McpApprovalListItem {
  // `interactive` / `autoTimeoutMs` come from the runtime's own policy decision
  // (`describeApprovalPolicy`) — the same membership test that decides whether
  // the wait is armed with `timeoutMs: 0`. They are reported here so a caller
  // can tell "this will hang until a person answers" from "this auto-denies in
  // N ms" without knowing the tool taxonomy.
  const policy = describeApprovalPolicy(entry.toolName);
  const item: McpApprovalListItem = {
    requestId: entry.requestId,
    session: entry.sessionId,
    toolName: entry.toolName,
    inputSummary: summarizeApprovalInput(entry.input),
    interactive: policy.interactive,
    autoTimeoutMs: policy.autoTimeoutMs,
    waitedMs: Math.max(0, now - entry.receivedAt.getTime()),
  };
  if (entry.toolName === 'AskUserQuestion') {
    const questions = extractApprovalQuestions(entry.input);
    if (questions.length > 0) {
      item.questions = questions;
    }
  }
  return item;
}

/**
 * Projects a pending set onto the shape `session_get`'s `pendingInteraction`
 * reports: the first entry's {@link toApprovalListItem} reading minus the
 * `session` the caller already named.
 *
 * Exported for `mcp-gateway.read-tools.ts`, which must report the SAME request
 * id, tool, questions and wait its `approvals_list` sibling does for the same
 * request — deriving both from this one projection is what makes that identity
 * structural rather than a promise. Returns `null` when there is nothing
 * pending (the reading `session_get` carries as `pendingInteraction: null`).
 */
export function toPendingInteraction(
  entries: McpApprovalPending[],
  now: number,
): McpPendingInteraction | null {
  const first = entries[0];
  if (!first) {
    return null;
  }
  const { session: _session, ...interaction } = toApprovalListItem(first, now);
  return interaction;
}

// --------------------------- buildApprovalsList ---------------------------

/**
 * Lists the pending approvals for one session, or for every running session.
 *
 * The caller is the token's owner under `via: 'mcp'`, so the control service's
 * shared access entry decides exactly as it does for the other gateway verbs. An
 * `AskUserQuestion` carries its questions expanded alongside the summary; every
 * other entry carries only the summary. A control-service refusal is thrown as a
 * JSON-bodied error, which the audit wrapper renders `isError`.
 *
 * Consumers: `registerMcpApprovalTools` (the registered handler) and this
 * module's criterion, which drives it through the real mount.
 */
export async function buildApprovalsList(
  input: McpApprovalsListInput,
  ctx: { principal: McpPrincipal },
  deps: McpApprovalsDeps,
): Promise<ApprovalsListPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const result = await deps.control.pendingApprovals(
    caller,
    input.session === undefined ? {} : { sessionId: input.session },
  );

  if (!result.ok) {
    throw new McpToolError(result.code, result.message);
  }

  const now = deps.now();
  return { approvals: result.approvals.map((entry) => toApprovalListItem(entry, now)) };
}

// --------------------------- buildApprovalAnswer ---------------------------

/**
 * Decides one pending approval, forwarding `allow` / `message` / `answers`.
 *
 * `answers` reaches the runtime as the decision's `updatedInput` — the control
 * service does that mapping — and `message` rides alongside it. BOTH refusals
 * are THROWN as `isError` envelopes (AC-287): a request the control service
 * reports as no longer pending becomes `APPROVAL_NOT_FOUND` carrying the
 * control plane's `details.reason` (`'expired'` vs `'never_issued'`), and a
 * refusal the control service attributes to access becomes `FORBIDDEN`
 * (AC-232's vocabulary). Neither is an `ok:false` success any more — a
 * reference that names no live request is an error, not a reading.
 *
 * Consumers: `registerMcpApprovalTools` (the registered handler) and this
 * module's criterion, which drives it through the real mount.
 */
export async function buildApprovalAnswer(
  input: McpApprovalAnswerInput,
  ctx: { principal: McpPrincipal },
  deps: McpApprovalsDeps,
): Promise<ApprovalAnswerPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const result = await deps.control.answerApproval(caller, {
    requestId: input.requestId,
    allow: input.allow,
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    ...(input.message === undefined ? {} : { message: input.message }),
  });

  if (result.ok) {
    return { ok: true, requestId: result.requestId, decision: input.allow ? 'allow' : 'deny' };
  }

  if (result.code === 'APPROVAL_EXPIRED_OR_NOT_FOUND') {
    // AC-287: a reference that points at no live request is an ERROR, not an
    // `ok:false` success. The control plane's `reason` rides as
    // `details.reason`, so the caller can tell a request that timed out
    // (`expired`) from one this process never minted (`never_issued`).
    throw new McpToolError(MCP_ERROR_CODES.APPROVAL_NOT_FOUND, result.message, false, {
      reason: result.reason,
    });
  }

  if (result.code === 'ALREADY_DECIDED') {
    // The request WAS live and another caller settled it first. This is NOT
    // `APPROVAL_NOT_FOUND`: the id existed and was answered, so reporting
    // "expired or does not exist" would be false. The code is forwarded from
    // the control service's own vocabulary (like `UNSUPPORTED_PROVIDER`,
    // `LIFECYCLE_MODE_*`) and is deliberately NOT a member of `MCP_ERROR_CODES`
    // — it is that service's word, not this envelope's. `decidedBy`/`decidedAt`
    // ride as details so the loser can report who beat it.
    throw new McpToolError('ALREADY_DECIDED', result.message, false, {
      decidedBy: result.decidedBy,
      decidedAt: result.decidedAt,
    });
  }

  throw new McpToolError(MCP_ERROR_CODES.FORBIDDEN, result.message);
}

// --------------------------- registration ---------------------------

/**
 * One approval tool as it is handed to the registration seam.
 *
 * Deliberately the same shape as AC-271/AC-273's resident registrations, so the
 * transport's one audited seam installs it without a special case.
 */
type McpApprovalRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/** The seam `registerMcpApprovalTools` installs through (AC-244's audited wrapper). */
type McpApprovalSeam = (registration: McpApprovalRegistration) => void;

/**
 * Installs `approvals_list` (scope `cloudcli:read`) and `approval_answer` (scope
 * `cloudcli:approve`) through the audited seam.
 *
 * The scope literals are read from {@link ACCESS_TOKEN_SCOPES}'s positions rather
 * than re-typed, so the two tools cannot drift from the one scope vocabulary.
 * Consumers: `registerMcpResidentTools` (the stage-6 assembly) and this module's
 * criterion, which drives the names through the real mount.
 */
export function registerMcpApprovalTools(seam: McpApprovalSeam, deps: McpApprovalsDeps): void {
  seam({
    name: 'approvals_list',
    description:
      'List the tool approvals waiting on a session (or every running session): request id, session, tool, input summary, waited time, and — for AskUserQuestion — the expanded questions and options.',
    requiredScope: READ_SCOPE,
    inputSchema: APPROVALS_LIST_INPUT_SCHEMA,
    outputSchema: {
      approvals: z.array(
        z.object({
          requestId: z.string(),
          session: z.string(),
          toolName: z.string(),
          inputSummary: z.string(),
          interactive: z.boolean(),
          autoTimeoutMs: z.number().nullable(),
          waitedMs: z.number(),
          questions: z
            .array(
              z.object({
                question: z.string(),
                header: z.string().optional(),
                options: z.array(
                  z.object({
                    label: z.string(),
                    description: z.string().optional(),
                    multiSelect: z.boolean().optional(),
                  }),
                ),
              }),
            )
            .optional(),
        }),
      ),
    },
    handler: (args, ctx) => buildApprovalsList(readApprovalsListInput(args), ctx, deps),
  });

  seam({
    name: 'approval_answer',
    description:
      'Decide a pending tool approval: allow/deny through the running provider, forwarding an optional message and — for AskUserQuestion — the chosen answers as updatedInput.',
    requiredScope: APPROVE_SCOPE,
    inputSchema: APPROVAL_ANSWER_INPUT_SCHEMA,
    outputSchema: {
      ok: z.literal(true),
      requestId: z.string(),
      decision: z.string(),
    },
    handler: (args, ctx) => buildApprovalAnswer(readApprovalAnswerInput(args), ctx, deps),
  });
}
