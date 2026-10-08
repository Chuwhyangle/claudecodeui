/**
 * The error codes each MCP tool DECLARES it can return (AC-285): the ONE place
 * a tool's set of possible codes is written down.
 *
 * AC-285 requires the gateway's failure vocabulary to have a single source and
 * every tool to state which of its codes it can actually produce. This module is
 * the tool-side half: `MCP_ERROR_CODES` (in `mcp-error-envelope.ts`) is the
 * vocabulary, and {@link MCP_TOOL_ERROR_CODES} maps every gateway tool name to
 * the SUBSET of that vocabulary the tool can leave on the wire. The transport's
 * one `audited` seam attaches each row to its registration as `_meta`
 * (`{ 'cloudcli/errorCodes': [...] }`), so a real `tools/list` read-back carries
 * the declaration rather than a hand-kept list in a criterion.
 *
 * ## Why a total record over the tool-name union
 *
 * The record is typed `Record<McpGatewayToolName, readonly McpErrorCode[]>`, so a
 * tool added to any of the three tool tables without a row here fails to compile
 * rather than shipping with an empty declaration — the same guard
 * `mcp-tool-annotations.ts` uses. {@link readMcpToolErrorCodes} THROWS on an
 * unknown name for the same reason `readMcpToolAnnotations` does: the transport
 * calls it for every tool it registers, so a name with no row is a wiring bug
 * that must surface at mount time, not a silent omission on the wire.
 *
 * ## What each row means
 *
 * Every row starts from {@link WRAPPER_CODES} — the three codes the audited
 * wrapper itself can produce for ANY tool (a declared-input validation failure,
 * a scope denial, and the `INTERNAL_ERROR` fallback for a handler that throws
 * something unattributable). A tool that takes a `project` / `session` reference
 * adds the AC-246 target-gate codes for that kind; a tool whose handler has its
 * own refusals adds those. The codes a tool CANNOT produce are deliberately left
 * out, so the declaration is a reading of the tool rather than "all of them".
 *
 * Service codes forwarded unchanged from a dependency's own vocabulary (the
 * control service's `UNSUPPORTED_PROVIDER`, the resident host's
 * `LIFECYCLE_MODE_*`, the self-target guard's `SELF_TARGET`, …) are NOT listed
 * here: `mcp-error-envelope.ts` documents that a well-formed service code passes
 * through `McpErrorResult` untouched, and the declaration is about the codes the
 * GATEWAY decides for itself.
 *
 * Consumers: `mcp-gateway.transport.ts`'s `audited` helper (the single call site,
 * which attaches the row to every registration's `_meta`) and this module's
 * criterion, `tests/mcp-error-vocabulary.test.ts`, which reads the declaration
 * back off a real `tools/list` and checks every observed code against it.
 */

import type { McpErrorCode } from './mcp-error-envelope.js';
import type { McpGatewayToolName } from './mcp-tool-annotations.js';

/**
 * The codes the audited wrapper can produce for ANY registered tool: its own
 * declared-input validation (`INVALID_ARGUMENT`), the scope denial it decides
 * before the handler runs (`INSUFFICIENT_SCOPE`), and the catch-all it applies
 * to a handler throw it cannot attribute (`INTERNAL_ERROR`).
 */
const WRAPPER_CODES: readonly McpErrorCode[] = ['INVALID_ARGUMENT', 'INSUFFICIENT_SCOPE', 'INTERNAL_ERROR'];

/** The codes AC-246's target gate adds to a tool whose arguments include a `project`. */
const PROJECT_TARGET_CODES: readonly McpErrorCode[] = ['PROJECT_NOT_FOUND', 'TARGET_AMBIGUOUS'];

/** The codes AC-246's target gate adds to a tool whose arguments include a `session`. */
const SESSION_TARGET_CODES: readonly McpErrorCode[] = ['SESSION_NOT_FOUND', 'TARGET_AMBIGUOUS'];

/**
 * Every gateway tool's declared code set, keyed by the tool's `tools/list` name.
 *
 * TOTAL over {@link McpGatewayToolName}: a name the gateway can register without
 * a row here is a compile error, so the declaration can never silently fall
 * behind the registry.
 */
export const MCP_TOOL_ERROR_CODES: Record<McpGatewayToolName, readonly McpErrorCode[]> = {
  // -- stage-3 read tools ----------------------------------------------------
  // `overview` / `quay_snapshot` / `run_get` keep the body-table refusal when the
  // deps that own them are unwired, so they can also answer
  // `MCP_TOOL_NOT_IMPLEMENTED`.
  overview: [...WRAPPER_CODES, ...PROJECT_TARGET_CODES, 'MCP_TOOL_NOT_IMPLEMENTED'],
  // No `project` / `session` argument, so nothing beyond the wrapper's own codes.
  projects_list: [...WRAPPER_CODES],
  sessions_list: [...WRAPPER_CODES, ...PROJECT_TARGET_CODES],
  session_get: [...WRAPPER_CODES, ...SESSION_TARGET_CODES],
  session_read: [...WRAPPER_CODES, ...SESSION_TARGET_CODES],
  // AC-287: a by-id read that finds no run throws `RUN_NOT_FOUND`.
  run_get: [...WRAPPER_CODES, ...SESSION_TARGET_CODES, 'RUN_NOT_FOUND', 'MCP_TOOL_NOT_IMPLEMENTED'],
  // AC-287: a project id nothing matches throws `PROJECT_NOT_FOUND` — the
  // project-side code of this one-code-per-category vocabulary (AC-284's goal
  // retired the floating "target not found" name in favour of it, so there is
  // no separate literal to mint here; see the task record's AC5 note).
  quay_snapshot: [...WRAPPER_CODES, ...PROJECT_TARGET_CODES, 'MCP_TOOL_NOT_IMPLEMENTED'],
  // `ui_last_opened_session` has no target argument, so AC-246's gate adds
  // nothing; its handler throws `SESSION_NOT_FOUND` when nothing has been opened
  // (no `TARGET_AMBIGUOUS`: there is no target to disambiguate). Unwired, it
  // keeps the body-table refusal, hence `MCP_TOOL_NOT_IMPLEMENTED`.
  ui_last_opened_session: [...WRAPPER_CODES, 'SESSION_NOT_FOUND', 'MCP_TOOL_NOT_IMPLEMENTED'],
  // `ui_visible_context` resolves its one optional `client` reference against the
  // connected devices with AC-246's rules: several matches are refused with
  // `TARGET_AMBIGUOUS` and the candidates, and no match is refused with
  // `INVALID_ARGUMENT` carrying the query — the wrapper's own declared-input code,
  // because this vocabulary keeps one code per category and mints no second
  // "not found" literal for devices (AC-284). Unwired, it keeps the body-table
  // refusal, hence `MCP_TOOL_NOT_IMPLEMENTED`.
  ui_visible_context: [...WRAPPER_CODES, 'TARGET_AMBIGUOUS', 'MCP_TOOL_NOT_IMPLEMENTED'],
  // `ui_clients_list` takes NO arguments — it lists every connected device — so
  // AC-246's target gate adds nothing and no resolution can be refused. Unwired,
  // it keeps the body-table refusal, hence `MCP_TOOL_NOT_IMPLEMENTED`.
  ui_clients_list: [...WRAPPER_CODES, 'MCP_TOOL_NOT_IMPLEMENTED'],
  // `session_search` takes no `session` and resolves no target of its own: its
  // optional `project` is a FILTER over the results the scan already found, not
  // an AC-246 reference, so a project id nothing matches is simply an empty
  // result rather than `PROJECT_NOT_FOUND`. Unwired, it keeps the body-table
  // refusal, hence `MCP_TOOL_NOT_IMPLEMENTED`.
  session_search: [...WRAPPER_CODES, 'MCP_TOOL_NOT_IMPLEMENTED'],
  // `ui_selected_text` resolves the same optional `client` reference as
  // `ui_visible_context`, with the same two refusals: `TARGET_AMBIGUOUS` for
  // several matches, `INVALID_ARGUMENT` for none. The `cloudcli:selection` gate
  // is a SUCCESS path, not an error — a token without the scope reads
  // `selectedText: 'withheld'` rather than a scope-refused envelope — so no code
  // is minted for it. Unwired, it keeps the body-table refusal.
  ui_selected_text: [...WRAPPER_CODES, 'TARGET_AMBIGUOUS', 'MCP_TOOL_NOT_IMPLEMENTED'],

  // -- stage-4 write tools ---------------------------------------------------
  // `session_send` normalizes the control service's `RUN_IN_PROGRESS` to the
  // gateway's one "the session is busy" code.
  session_send: [...WRAPPER_CODES, ...SESSION_TARGET_CODES, 'SESSION_BUSY'],
  session_create: [...WRAPPER_CODES, ...PROJECT_TARGET_CODES],
  session_interrupt: [...WRAPPER_CODES, ...SESSION_TARGET_CODES],
  session_start: [...WRAPPER_CODES, ...SESSION_TARGET_CODES],
  session_close: [...WRAPPER_CODES, ...SESSION_TARGET_CODES],
  // `ui_open_session` resolves its optional `client` against the connected
  // devices: several matches are refused with `TARGET_AMBIGUOUS` and the
  // candidates, no match with `CLIENT_NOT_FOUND` carrying the query, an omitted
  // `client` against several devices with `CLIENT_REQUIRED`, and one against
  // none with `NO_CLIENT`. It throttles per token with `RATE_LIMITED`. It also
  // keeps the placeholder refusal when its deps are unwired, hence
  // `MCP_TOOL_NOT_IMPLEMENTED`.
  ui_open_session: [
    ...WRAPPER_CODES,
    ...SESSION_TARGET_CODES,
    'CLIENT_REQUIRED',
    'NO_CLIENT',
    'CLIENT_NOT_FOUND',
    'RATE_LIMITED',
    'MCP_TOOL_NOT_IMPLEMENTED',
  ],

  // -- stage-6 resident tools ------------------------------------------------
  // `session_cancel_queued` raises `FORBIDDEN` when the control service refuses
  // the withdrawal, and — AC-287 — `QUEUED_MESSAGE_NOT_FOUND` when the uuid
  // names no message this session's queue ever held. A message that already
  // started stays a SUCCESS (`outcome: 'already-started'`).
  session_cancel_queued: [
    ...WRAPPER_CODES,
    ...SESSION_TARGET_CODES,
    'FORBIDDEN',
    'QUEUED_MESSAGE_NOT_FOUND',
  ],
  // `session_reconfigure` refuses a permission mode the provider does not list.
  session_reconfigure: [...WRAPPER_CODES, ...SESSION_TARGET_CODES, 'UNSUPPORTED_PERMISSION_MODE'],
  // `session_background` refuses a `stopTaskId` absent from the host snapshot.
  session_background: [...WRAPPER_CODES, ...SESSION_TARGET_CODES, 'TASK_NOT_FOUND'],
  // `approvals_list` forwards the control service's own `FORBIDDEN` refusal.
  approvals_list: [...WRAPPER_CODES, ...SESSION_TARGET_CODES, 'FORBIDDEN'],
  // `approval_answer` refuses with `FORBIDDEN`, and — AC-287 — reports an
  // expired / unknown approval as `APPROVAL_NOT_FOUND`, an envelope whose
  // `details.reason` is `'expired'` or `'never_issued'`. The old `ok:false`
  // success carrying `APPROVAL_EXPIRED_OR_NOT_FOUND` is gone.
  approval_answer: [
    ...WRAPPER_CODES,
    ...SESSION_TARGET_CODES,
    'FORBIDDEN',
    'APPROVAL_NOT_FOUND',
  ],
};

/**
 * The codes one tool declares, by name.
 *
 * THROWS on a name with no row rather than answering `undefined`: the transport's
 * one registration seam calls this for every tool, so a tool registered without a
 * declaration is a wiring bug that must surface at mount time, not a silent
 * omission on the wire. The record is total over {@link McpGatewayToolName}, so
 * the only way to reach the throw is a name that is not a gateway tool at all.
 *
 * Consumers: `mcp-gateway.transport.ts`'s `audited` helper (the single call
 * site), and this module's criterion, which reads the declaration back off a real
 * `tools/list`.
 */
export function readMcpToolErrorCodes(tool: string): readonly McpErrorCode[] {
  const codes = MCP_TOOL_ERROR_CODES[tool as McpGatewayToolName];
  if (codes === undefined) {
    throw new Error(`No MCP tool error codes are declared for tool "${tool}".`);
  }
  return codes;
}
