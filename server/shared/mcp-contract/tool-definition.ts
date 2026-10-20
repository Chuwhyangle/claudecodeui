/**
 * One MCP tool's declaration, as a domain tool package states it.
 *
 * Proposal `docs/proposals/mcp-gateway-tool-architecture.md` §3.3. A domain
 * package (`mcp-tools/<domain>`) exports a {@link McpToolModule}; each of its
 * tools is a {@link ToolDefinition}. The gateway consumes the registry built
 * from these declarations (see `tool-registry.ts`) and never imports a concrete
 * tool package (rule R3).
 *
 * Read/write is NOT a second axis here: it is expressed by
 * `annotations.readOnlyHint`, and authorization by `requiredScopes` — the
 * existing `ACCESS_TOKEN_SCOPES` tokens. There is deliberately no parallel
 * scope enum; inventing one would duplicate and conflict with the two
 * mechanisms that already decide these things (rule R5).
 *
 * Consumers: composition roots and domain tool packages (stage 2), and the
 * contract's own registry. Nothing in stage 1 registers a tool through it yet —
 * the gateway still owns the current tool tables.
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { McpPrincipal } from './principal.js';
import type { McpToolInputSchema } from './schemas.js';

/**
 * The four declarative hints every tool carries, reusing the MCP SDK's shape so
 * the contract never restates the protocol it belongs to.
 *
 * `MCP_TOOL_ANNOTATIONS` in the gateway is the current production table; the
 * field is typed against the SDK's `ToolAnnotations` so a stage-2 package can
 * carry a row verbatim.
 */
export type McpToolAnnotations = ToolAnnotations;

/** The result a tool handler returns: the MCP SDK's `CallToolResult`. */
export type McpToolResult = CallToolResult;

/**
 * What a handler is handed besides its deps: the authenticated caller.
 *
 * Deliberately the principal alone for now — the audited wrapper still owns the
 * audit row, scope decision and validation, and a handler that needs a domain
 * service receives it through its `Deps` bag (composition root injection).
 */
export type McpToolContext = {
  principal: McpPrincipal;
};

/**
 * One tool declaration.
 *
 * - `name` is the `tools/list` name.
 * - `inputSchema` is the same `McpToolInputSchema` the audited wrapper already
 *   understands (a raw shape or a built Zod schema).
 * - `requiredScopes` are the `ACCESS_TOKEN_SCOPES` tokens a caller's token must
 *   carry; a missing one denies the call before the handler runs.
 * - `annotations` are the four SDK hints; `readOnlyHint` is what expresses
 *   read vs write.
 * - `handler` receives the validated argument object, the caller and the
 *   injected deps.
 */
export type ToolDefinition<Deps = unknown> = {
  name: string;
  /** The client-facing description, when the tool has one. */
  description?: string;
  inputSchema: McpToolInputSchema;
  /** Every scope the caller's token must carry. */
  requiredScopes: readonly string[];
  annotations: McpToolAnnotations;
  handler(args: Record<string, unknown>, ctx: McpToolContext, deps: Deps): Promise<McpToolResult> | McpToolResult;
};

/**
 * The `Mcp`-prefixed spelling of {@link ToolDefinition}, kept as an alias so
 * the proposal's draft names and the task body's name both resolve.
 */
export type McpToolDefinition<Deps = unknown> = ToolDefinition<Deps>;
