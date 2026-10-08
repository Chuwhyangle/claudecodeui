/**
 * The MCP gateway's ONE tool-failure envelope (AC-284).
 *
 * Every way a gateway tool can fail used to leave a different residue on the
 * wire, and none of them was machine-readable:
 *
 *  - a bare sentence in `content[0].text` — the audit wrapper's `Unauthorized.` /
 *    `Insufficient scope for this tool.` and the caught `Error.message` (which is
 *    how `session_read`'s not-found answer surfaced);
 *  - a JSON string smuggled THROUGH `content[0].text` — every tool's
 *    `refusal()` / `new Error(JSON.stringify(body))`, so a caller had to
 *    `JSON.parse` a prose field to learn the code;
 *  - no `structuredContent` at all, because the audit wrapper only fills it on
 *    the success path.
 *
 * This module is the single statement of the replacement: {@link mcpErrorResult}
 * builds the envelope, {@link McpToolError} lets a handler throw one directly,
 * and {@link toMcpErrorResult} normalizes anything else a handler throws (a
 * JSON-bodied `Error`, a `McpToolError`, a bare `Error`) onto the same shape.
 *
 * Two invariants the criterion reads back off the wire:
 *
 *  - `code` matches `^[A-Z][A-Z0-9_]*$` — a well-formed code, never a sentence;
 *  - `message` is a non-empty human sentence, and the ONLY human-readable field:
 *    `content[0].text` mirrors it so a text-only client still sees words, but the
 *    machine fields live in `structuredContent`.
 *
 * {@link MCP_ERROR_CODES} is the canonical vocabulary for the codes the GATEWAY
 * itself decides. A code forwarded from a service's own vocabulary (the control
 * service's `UNSUPPORTED_PROVIDER`, a resident host's `LIFECYCLE_MODE_*`, the
 * self-target guard's `SELF_TARGET`, …) passes through {@link toMcpErrorResult}
 * unchanged as long as it is well formed — a well-formed code is never silently
 * rewritten to a gateway one, because that would erase the service's reason.
 *
 * Consumers: `mcp-gateway.audit.ts` (the three failure branches of the audited
 * wrapper, plus the declared-input validation), every tool module's refusal path,
 * and `tests/mcp-error-envelope.test.ts`, which reads {@link MCP_ERROR_CODES} as
 * the expected code per probe class rather than re-typing the literals.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// --------------------------- the code vocabulary ---------------------------

/**
 * One canonical gateway error code: the code itself, one English sentence
 * stating what it means, and whether repeating the same call could plausibly
 * succeed.
 *
 * `code` repeats the entry's key so a call site can hand the WHOLE descriptor to
 * {@link mcpErrorResult} / {@link McpToolError} — `mcpErrorResult(MCP_ERROR_CODES.SESSION_NOT_FOUND, …)` —
 * without ever restating the name as a bare string. The criterion pins
 * `descriptor.code === key`, so the copy can never drift from the key it lives
 * under.
 */
export type McpErrorDescriptor = {
  /** The code itself — the same string as this entry's key in {@link MCP_ERROR_CODES}. */
  readonly code: string;
  /** One English sentence a human can read: never empty, never CJK. */
  readonly message: string;
  /** Whether repeating the same call against the same state could plausibly succeed. */
  readonly retryable: boolean;
};

/**
 * The canonical codes the gateway decides for itself — the ONE vocabulary (AC-285).
 *
 * `SESSION_NOT_FOUND` is the ONE code for "the session does not exist", on every
 * tool that can say it — the split AC-284 removed had two different codes naming
 * that one category depending on where in the gateway the miss was noticed.
 * `PROJECT_NOT_FOUND` is its project-side sibling; `TARGET_AMBIGUOUS` is
 * "several targets matched, so the gateway refuses to pick".
 *
 * `APPROVAL_NOT_FOUND` / `QUEUED_MESSAGE_NOT_FOUND` / `RUN_NOT_FOUND` were
 * declared by AC-284 but not MINTED by it: the tools that emit them
 * (`approval_answer` / `session_cancel_queued` / `run_get`) once answered a miss
 * as a normal payload. AC-287 converts all three to envelopes thrown through this
 * module, so a miss on those tools is now `isError` with the cause in `details`
 * (`{ reason: 'expired' | 'never_issued' }` for the two by-id reads) and the
 * successful payloads shrink to the cases that describe something that exists.
 * `APPROVAL_EXPIRED_OR_NOT_FOUND` is the one code `approval_answer` used to
 * report INSIDE its normal payload rather than as an envelope; AC-287 retired it
 * from the wire (the expired/unknown approval is `APPROVAL_NOT_FOUND` with
 * `details.reason`). It stays in this vocabulary because AC-285's criterion pins
 * the vocabulary key set in both directions and it is that record's entry — a
 * value a caller might still hold, not a code any tool mints.
 *
 * The record is `as const satisfies Record<string, McpErrorDescriptor>`: every
 * value is checked against the descriptor type, and {@link McpErrorCode} below is
 * derived from the SAME object, so the type and the record can never hold two
 * different key sets.
 */
export const MCP_ERROR_CODES = {
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    message: 'No session matches the id or title the caller named.',
    retryable: false,
  },
  PROJECT_NOT_FOUND: {
    code: 'PROJECT_NOT_FOUND',
    message: 'No project matches the id or title the caller named.',
    retryable: false,
  },
  TARGET_AMBIGUOUS: {
    code: 'TARGET_AMBIGUOUS',
    message: 'Several targets matched the name; the gateway will not pick one for the caller.',
    retryable: false,
  },
  INVALID_ARGUMENT: {
    code: 'INVALID_ARGUMENT',
    message: 'An argument is missing or has the wrong type.',
    retryable: false,
  },
  UNKNOWN_TOOL: {
    code: 'UNKNOWN_TOOL',
    message: 'The caller named a tool the gateway does not register.',
    retryable: false,
  },
  INSUFFICIENT_SCOPE: {
    code: 'INSUFFICIENT_SCOPE',
    message: "The caller's token lacks a scope the tool requires.",
    retryable: false,
  },
  SESSION_BUSY: {
    code: 'SESSION_BUSY',
    message: 'The session already has a run in progress.',
    retryable: true,
  },
  // The draft tools (gap-mcp-draft-get-set-submit). `draft_submit` with nothing
  // to send is a state refusal, NOT an argument error: the caller named a real
  // session, and the session's composer is simply empty — so it gets its own
  // code rather than `INVALID_ARGUMENT`, and no run is started.
  DRAFT_EMPTY: {
    code: 'DRAFT_EMPTY',
    message: 'The session has no unsent composer text, so there is nothing to submit.',
    retryable: false,
  },
  APPROVAL_NOT_FOUND: {
    code: 'APPROVAL_NOT_FOUND',
    message: 'No pending approval has the id the caller named.',
    retryable: false,
  },
  QUEUED_MESSAGE_NOT_FOUND: {
    code: 'QUEUED_MESSAGE_NOT_FOUND',
    message: 'No queued message has the id the caller named.',
    retryable: false,
  },
  RUN_NOT_FOUND: {
    code: 'RUN_NOT_FOUND',
    message: 'No run has the id the caller named.',
    retryable: false,
  },
  MCP_TOOL_NOT_IMPLEMENTED: {
    code: 'MCP_TOOL_NOT_IMPLEMENTED',
    message: 'The tool is registered but its behaviour is owned by a later task.',
    retryable: false,
  },
  TASK_NOT_FOUND: {
    code: 'TASK_NOT_FOUND',
    message: 'No background task or schedule in this session has the id the caller named.',
    retryable: false,
  },
  UNSUPPORTED_PERMISSION_MODE: {
    code: 'UNSUPPORTED_PERMISSION_MODE',
    message: 'The provider does not support the requested permission mode.',
    retryable: false,
  },
  FORBIDDEN: {
    code: 'FORBIDDEN',
    message: 'The caller is not allowed to act on this target.',
    retryable: false,
  },
  // The navigation codes (gap-mcp-ui-open-session). `CLIENT_REQUIRED` is the one
  // code for "several browsers are connected and the caller named none": the
  // gateway will not pick a screen on the caller's behalf, exactly as it will not
  // pick a session (TARGET_AMBIGUOUS). `NO_CLIENT` is the not-found sibling — no
  // browser is connected at all — and `CLIENT_NOT_FOUND` the per-device miss a
  // caller gets when it DID name one. One code per category, no parallel
  // vocabulary.
  CLIENT_REQUIRED: {
    code: 'CLIENT_REQUIRED',
    message: 'Several browsers are connected; name the one to open the session in.',
    retryable: false,
  },
  NO_CLIENT: {
    code: 'NO_CLIENT',
    message: 'No browser is connected, so there is no screen to open the session on.',
    retryable: true,
  },
  CLIENT_NOT_FOUND: {
    code: 'CLIENT_NOT_FOUND',
    message: 'No connected browser matches the device the caller named.',
    retryable: false,
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    message: 'This token has called the tool too many times in the last minute.',
    retryable: true,
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    message: 'The handler failed in a way the gateway could not attribute to a known code.',
    retryable: false,
  },
  // Retained for AC-285's both-direction vocabulary pin. No tool mints it since
  // AC-287 moved the expired/unknown approval onto `APPROVAL_NOT_FOUND`.
  APPROVAL_EXPIRED_OR_NOT_FOUND: {
    code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',
    message: 'The approval request has expired or no longer exists.',
    retryable: false,
  },
} as const satisfies Record<string, McpErrorDescriptor>;

/**
 * One canonical gateway error code, derived from {@link MCP_ERROR_CODES} — the
 * key set and the type are one statement, never two copies that can drift.
 */
export type McpErrorCode = keyof typeof MCP_ERROR_CODES;

/** Every well-formed code: an upper-snake identifier, never a sentence. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Whether a string is a well-formed error code. */
export function isMcpErrorCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

// --------------------------- the envelope ---------------------------

/** The free-form machine payload that rides alongside a code and its message. */
export type McpErrorDetails = Record<string, unknown>;

/** The `structuredContent` an error envelope carries. */
export type McpErrorEnvelope = {
  code: string;
  message: string;
  retryable: boolean;
  details?: McpErrorDetails;
};

/**
 * The error envelope's four fields as a Zod RAW SHAPE, every one optional
 * (gap-mcp-outputschema-drift-overview-and-error-envelope).
 *
 * A tool that declares an `outputSchema` validates EVERY result the SDK sees
 * against it — including an `isError` result, whose `structuredContent` is this
 * envelope rather than the tool's own success payload (AC-284 direction a').
 * Without these four keys a failure would itself be rejected as not matching
 * the tool's output schema, so the caller would read `-32602` instead of the
 * `PROJECT_NOT_FOUND` / `TARGET_AMBIGUOUS` code the gateway meant to send; all
 * four are optional so a SUCCESS payload, which carries none of them, still
 * validates.
 *
 * It is spliced into a tool's declared output schema in exactly ONE place — the
 * audited wrapper's registration line in `mcp-gateway.audit.js` — never in a
 * tool's own `TOOL_BODIES` shape, so the envelope is one statement rather than a
 * per-tool copy. The wrapper ALSO optionalizes the tool's own success fields
 * (module-private there): JSON-schema `required` is a per-object list, so a
 * declared-required success field would still be demanded of an error envelope
 * even with these four present.
 *
 * Consumers: `mcp-gateway.audit.js`'s {@link withMcpAudit} and this module's
 * criterion.
 */
export const MCP_ERROR_ENVELOPE_SHAPE: z.ZodRawShape = {
  code: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/**
 * Builds the one failure result every gateway error path returns.
 *
 * `code` may be either a bare string (a code a service forwarded — see the
 * module header: a well-formed service code passes through unchanged) or a
 * {@link McpErrorDescriptor} read straight out of {@link MCP_ERROR_CODES}. When
 * it is a descriptor, the code, the fallback sentence and the default
 * `retryable` all come FROM the vocabulary, so a call site names the code once
 * and never restates its meaning. An explicit `message` / `retryable` argument
 * always wins over the descriptor's, so existing call sites keep their exact
 * wording.
 *
 * `content[0].text` mirrors `message` so a text-only client still reads words,
 * but the machine-readable fields live in `structuredContent` — never as a JSON
 * string stuffed into the text. An empty `message` falls back to the
 * descriptor's sentence, then to the code, so the "non-empty message" invariant
 * holds no matter what a caller passes.
 *
 * Consumers: {@link toMcpErrorResult}, `mcp-gateway.audit.ts` (the denied /
 * invalid-argument branches), every tool module's refusal path, and this
 * module's criterion, which reads the shape back off the wire.
 */
export function mcpErrorResult(
  code: string | McpErrorDescriptor,
  message?: string,
  retryable?: boolean,
  details?: McpErrorDetails,
): CallToolResult {
  const resolvedCode = typeof code === 'string' ? code : code.code;
  const resolvedRetryable = retryable ?? (typeof code === 'string' ? false : code.retryable);
  const fallbackMessage = typeof code === 'string' ? '' : code.message;
  const candidate =
    typeof message === 'string' && message.trim().length > 0 ? message : fallbackMessage;
  const text = candidate.trim().length > 0 ? candidate : `${resolvedCode}.`;
  const envelope: McpErrorEnvelope = {
    code: resolvedCode,
    message: text,
    retryable: resolvedRetryable,
    ...(details === undefined ? {} : { details }),
  };
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: envelope,
  };
}

// --------------------------- the AC-288 field detail ---------------------------

/**
 * One offending argument, as `INVALID_ARGUMENT.details.fields` reports it: the
 * dotted path the caller used (`message`, `mode`, `items.0.name`) and ONE short
 * English reason — never zod's raw issue object, and never its sentence.
 *
 * The reason is a small fixed vocabulary a caller can branch on
 * (`required`, `expected string`, `must be one of "latest","outline"`, `must be
 * >= 1`, or the message a `.refine()` supplied) rather than prose a human has to
 * re-parse.
 */
export type McpInvalidField = {
  /** The argument's path, dot-joined; `''` means the argument object itself. */
  path: string;
  /** One short English reason, non-empty and never CJK. */
  problem: string;
};

/** One issue out of a `ZodError`, typed from the schema so this file restates no zod internals. */
type ZodIssueLike = z.ZodError['issues'][number];

/** CJK ideographs, kana and Hangul — the same class the criteria read "English" against. */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/** The reason for a path the caller did not supply, or supplied as `undefined`. */
const MISSING_PROBLEM = 'required';

/** The fallback reason when an issue carries no usable English sentence. */
const UNREADABLE_PROBLEM = 'is not accepted';

/** Resolves the value a zod issue's `path` points at, walking objects and arrays. */
function valueAtPath(args: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = args;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/**
 * Renders one zod issue as the field's `problem`.
 *
 * `args` is the caller's ORIGINAL argument object, because zod v4 files a MISSING
 * property and a wrong-typed one under the same `invalid_type` code: only the
 * caller's own value tells `required` from `expected <type>`. A `custom` issue
 * (an object-level `.refine()`) carries its sentence, but it is passed through
 * the same English guard as everything else, so a refine written in CJK cannot
 * put CJK in a `problem`.
 */
function problemForIssue(issue: ZodIssueLike, args: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return valueAtPath(args, issue.path) === undefined ? MISSING_PROBLEM : `expected ${issue.expected}`;
    case 'invalid_value':
      return `must be one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')}`;
    case 'too_small':
      return `must be ${issue.inclusive ? '>=' : '>'} ${String(issue.minimum)}`;
    case 'too_big':
      return `must be ${issue.inclusive ? '<=' : '<'} ${String(issue.maximum)}`;
    default:
      return englishProblem(issue.message);
  }
}

/** The message itself when it is a usable English sentence, else a fixed English reason. */
function englishProblem(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 && !CJK_PATTERN.test(trimmed) ? trimmed : UNREADABLE_PROBLEM;
}

/**
 * Maps a `ZodError` to the `INVALID_ARGUMENT` envelope's per-field detail (AC-288):
 * one `{ path, problem }` per issue, in issue order. `path` is dot-joined and
 * array indices are plain segments (`items.0.name`); a root-level issue reports
 * an empty path.
 *
 * Consumers: `mcp-gateway.audit.ts` (the audited wrapper's validation branch)
 * and `tests/mcp-invalid-argument.test.ts`, which asserts the exact
 * `{ path: 'message', problem: 'required' }` reading AC-288 names.
 */
export function invalidArgumentFields(error: z.ZodError, args: unknown): McpInvalidField[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    problem: problemForIssue(issue, args),
  }));
}

/** How much of a tool name an `UNKNOWN_TOOL` sentence repeats before it is clamped. */
const MAX_QUOTED_TOOL_NAME = 80;

/**
 * The `UNKNOWN_TOOL` envelope for a name the gateway does not register (AC-288).
 * It is the SAME family as every other failure — `code` / `message` / `retryable`
 * in `structuredContent` — so a caller branches on `code` instead of parsing the
 * SDK's `Tool X not found` sentence out of a text body.
 *
 * The name is quoted from the caller, so it is clamped before it reaches the
 * sentence: a caller cannot enlarge the envelope by naming a huge tool.
 *
 * Consumers: `mcp-gateway.audit.ts`'s `installMcpCallDispatcher`.
 */
export function unknownToolResult(tool: string): CallToolResult {
  const named = tool.length > MAX_QUOTED_TOOL_NAME ? `${tool.slice(0, MAX_QUOTED_TOOL_NAME)}...` : tool;
  return mcpErrorResult(
    MCP_ERROR_CODES.UNKNOWN_TOOL,
    `No tool named "${named}" is registered on this gateway.`,
  );
}

/**
 * A tool failure a handler throws to reach {@link mcpErrorResult} directly,
 * instead of building a JSON string and relying on the wrapper to parse it back.
 *
 * `code` may be a bare string (a forwarded service code) or a
 * {@link McpErrorDescriptor} from {@link MCP_ERROR_CODES}; a descriptor
 * contributes its own code and its `retryable`, while an explicit `retryable`
 * argument wins, exactly as in {@link mcpErrorResult}.
 *
 * Consumers: every tool module's refusal path (`mcp-session-send.ts`,
 * `mcp-session-lifecycle.ts`, `mcp-resolve-target.ts`, …).
 */
export class McpToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: McpErrorDetails | undefined;

  constructor(
    code: string | McpErrorDescriptor,
    message: string,
    retryable?: boolean,
    details?: McpErrorDetails,
  ) {
    super(message);
    this.name = 'McpToolError';
    this.code = typeof code === 'string' ? code : code.code;
    this.retryable = retryable ?? (typeof code === 'string' ? false : code.retryable);
    this.details = details;
  }
}

// --------------------------- the insufficient-scope envelope (AC-286) ---------------------------

/**
 * The `details` shape the `INSUFFICIENT_SCOPE` envelope carries (AC-286):
 * `requiredScopes` is the set the CALLER is actually missing — the tool's
 * declared scopes minus the ones the token already holds — never the tool's
 * whole declared set. Naming only what is missing is what lets a caller act on
 * it (re-authorize with exactly those scopes) instead of re-reading its token.
 *
 * The key set is fixed so the two places that refuse for a missing scope — the
 * audited wrapper's generic check and a handler's own check (the
 * `session_background` stop branch) — render the SAME `details` keys. The
 * `session` / `taskId` context that other refusals carry is deliberately NOT a
 * member: those belong to a tool's not-found refusals, not to a scope denial.
 */
type McpInsufficientScopeDetails = { requiredScopes: string[] };

/**
 * The one-sentence `message` an `INSUFFICIENT_SCOPE` envelope carries: EVERY
 * missing scope is named verbatim, and the sentence tells the caller to
 * re-authorize with it. Every scope is named (never truncated) because the
 * criterion reads the message back per scope, so a summary that dropped one
 * would hide a scope the caller has to add.
 */
function insufficientScopeMessage(requiredScopes: readonly string[], tool: string): string {
  const named = requiredScopes.map((scope) => `"${scope}"`).join(', ');
  const plural = requiredScopes.length === 1;
  return `Missing required scope${plural ? '' : 's'} ${named}. Re-authorize with ${
    plural ? 'that scope' : 'those scopes'
  } to call ${tool}.`;
}

/**
 * Builds the `INSUFFICIENT_SCOPE` envelope for a caller whose token lacks scopes
 * (AC-286): the missing scopes named in the sentence and carried as
 * `details.requiredScopes`, with `retryable: false` — no amount of repeating the
 * same call can add a scope to a token.
 *
 * Consumers: `mcp-gateway.audit.ts`'s generic scope branch (which passes the
 * scopes the caller is missing) and this module's criterion, which reads the
 * shape back off the wire. A handler that owns its own scope check throws
 * {@link McpScopeDeniedError} instead, which renders through this same sentence.
 */
export function insufficientScopeResult(requiredScopes: readonly string[], tool: string): CallToolResult {
  const details: McpInsufficientScopeDetails = { requiredScopes: [...requiredScopes] };
  return mcpErrorResult(
    MCP_ERROR_CODES.INSUFFICIENT_SCOPE,
    insufficientScopeMessage(details.requiredScopes, tool),
    false,
    details,
  );
}

/**
 * The refusal a tool HANDLER throws when the caller's token lacks a scope the
 * handler itself owns — the `session_background` stop branch, whose control
 * scope cannot be left to the audited registration seam (the tool's static scope
 * is the read half).
 *
 * It is a {@link McpToolError}, so {@link toMcpErrorResult} renders it onto the
 * SAME envelope shape as {@link insufficientScopeResult}: same `code`, same
 * `retryable`, same `details` key set (`{ requiredScopes }`). Being a distinct
 * type is what lets the audited wrapper's catch branch record the throw as
 * `denied` (with the missing scopes in the audit row) rather than `error`, while
 * every other handler throw keeps its `error` reading.
 *
 * Consumers: `mcp-session-background.ts` (the stop branch) and
 * `mcp-gateway.audit.ts` (the catch branch that discriminates it).
 */
export class McpScopeDeniedError extends McpToolError {
  /** The scopes the caller's token is missing — the same set `details.requiredScopes` carries. */
  readonly requiredScopes: string[];

  constructor(requiredScopes: readonly string[], tool: string) {
    const details: McpInsufficientScopeDetails = { requiredScopes: [...requiredScopes] };
    super(
      MCP_ERROR_CODES.INSUFFICIENT_SCOPE,
      insufficientScopeMessage(details.requiredScopes, tool),
      false,
      details,
    );
    this.name = 'McpScopeDeniedError';
    this.requiredScopes = details.requiredScopes;
  }
}

/**
 * Reads a JSON object out of an `Error` whose message is a stringified body, the
 * shape every tool module used before this task (`new Error(JSON.stringify(body))`).
 */
function readJsonBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const message = error.message.trim();
  if (!message.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes anything a tool handler can throw onto the one envelope.
 *
 *  - a {@link McpToolError} carries its own code / retryable / details;
 *  - a JSON-bodied `Error` (the pre-AC-284 `refusal()` shape, still thrown by any
 *    module that has not been converted) contributes its `code`, its `message`,
 *    its optional `retryable`, and every OTHER key as `details`;
 *  - anything else (a bare `Error`, a string, a thrown object) becomes
 *    `INTERNAL_ERROR` with its message (or `String(error)`) as the sentence.
 *
 * A JSON body whose `code` is not well formed is treated as a bare `Error`, so a
 * malformed body can never put a sentence in the `code` field.
 *
 * Consumers: `mcp-gateway.audit.ts` (the wrapper's catch branch) and this
 * module's criterion.
 */
export function toMcpErrorResult(error: unknown): CallToolResult {
  if (error instanceof McpToolError) {
    return mcpErrorResult(error.code, error.message, error.retryable, error.details);
  }

  const body = readJsonBody(error);
  if (body !== null && isMcpErrorCode(body.code)) {
    const { code, message, retryable, ...rest } = body;
    const text = typeof message === 'string' && message.trim().length > 0 ? message : `${code}.`;
    const details = Object.keys(rest).length > 0 ? rest : undefined;
    return mcpErrorResult(code, text, typeof retryable === 'boolean' ? retryable : false, details);
  }

  const message = error instanceof Error ? error.message : String(error);
  return mcpErrorResult(MCP_ERROR_CODES.INTERNAL_ERROR, message);
}
