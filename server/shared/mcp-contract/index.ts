// The MCP mechanism contract (`server/shared/mcp-contract`).
//
// Proposal `docs/proposals/mcp-gateway-tool-architecture.md` stage 1. This is a
// LEAF: it imports only `server/shared/**`, node builtins and external packages
// (zod, the MCP SDK) — never anything under `server/modules/**` (rule R1), so a
// domain tool package that depends on it stays a leaf under AC-394.
//
// Consumers import from THIS barrel (`@/shared/mcp-contract`), never from the
// individual files. `server/shared/index.ts` deliberately does NOT re-export the
// contract: shared's barrel stays the generic shared surface, and the contract
// is reached by its own path.

// The one tool-failure envelope and the canonical code vocabulary (AC-284/AC-285/
// AC-286/AC-288). The gateway's `mcp-error-envelope.ts` is now a re-export of this
// file, so existing consumers keep answering exactly as they did.
export {
  insufficientScopeResult,
  invalidArgumentFields,
  isMcpErrorCode,
  MCP_ERROR_CODES,
  MCP_ERROR_ENVELOPE_SHAPE,
  mcpErrorResult,
  McpScopeDeniedError,
  McpToolError,
  toMcpErrorResult,
  unknownToolResult,
} from './errors.js';
export type {
  McpErrorCode,
  McpErrorDescriptor,
  McpErrorDetails,
  McpErrorEnvelope,
  McpInvalidField,
} from './errors.js';

// The authenticated caller (AC-241 / AC-263).
export type { McpPrincipal } from './principal.js';

// A tool's declared argument schema (AC-288).
export type { McpToolInputSchema } from './schemas.js';

// The stage-2 tool-module boundary (proposal §3.3).
export type {
  McpToolAnnotations,
  McpToolContext,
  McpToolDefinition,
  McpToolResult,
  ToolDefinition,
} from './tool-definition.js';
export type { McpControlCaller, McpToolModule, McpToolRegistry } from './types.js';
// The one scope vocabulary (AC-243), re-homed from `modules/oauth`.
export { ACCESS_TOKEN_SCOPES } from './types.js';
export { createToolRegistry, ToolRegistry } from './tool-registry.js';

// The approval vocabulary (AC-274).
export type {
  ApprovalAnswerPayload,
  ApprovalsListPayload,
  McpAnswerApprovalResult,
  McpApprovalAnswerInput,
  McpApprovalListItem,
  McpApprovalOption,
  McpApprovalPending,
  McpApprovalQuestion,
  McpApprovalsDeps,
  McpApprovalsListInput,
  McpPendingApprovalsResult,
  McpPendingInteraction,
} from './approvals.js';
