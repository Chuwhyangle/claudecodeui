/**
 * The MCP contract's shared shapes: the tool module/registry boundary and the
 * control-plane caller vocabulary.
 *
 * Proposal `docs/proposals/mcp-gateway-tool-architecture.md` §3.3. These are the
 * types a domain tool package (`mcp-tools/<domain>`) and the composition root
 * agree on. Nothing here reaches into `server/modules/**`: the contract is a
 * leaf that only imports `server/shared/**`, so a tool package that depends on
 * it stays a leaf under AC-394's rule (proposal rule R1/R2).
 */

import type { McpToolDefinition } from './tool-definition.js';

/**
 * One domain package's declaration: a stable `domain` label plus the tools it
 * contributes to the registry.
 *
 * The label is declarative metadata for composition and diagnostics; the
 * gateway does not branch on it.
 */
export type McpToolModule<Deps = unknown> = {
  domain: string;
  tools: McpToolDefinition<Deps>[];
};

/**
 * The registry the gateway consumes instead of importing concrete tool packages
 * (proposal rule R3).
 *
 * `get` answers one tool by `tools/list` name; `all` answers every registered
 * tool for `tools/list`. Implemented by `ToolRegistry` in `tool-registry.ts`.
 */
export interface McpToolRegistry {
  get(name: string): McpToolDefinition | undefined;
  all(): McpToolDefinition[];
}

/**
 * Who is asking a control-plane verb to act, as the MCP and voice callers state
 * it.
 *
 * Re-homed from `server/modules/mcp-gateway/mcp-session-send.ts` so the
 * approval contract (and a stage-2 tool package) can name it without importing
 * the gateway. `via` is the transport the call arrived on, never a permission:
 * authorization is decided by the caller's token scopes, not by this label.
 *
 * Consumers: `mcp-session-send.ts` (re-exported through the gateway barrel),
 * `mcp-approvals.ts`, and the control-plane adapters.
 */
export type McpControlCaller = {
  userId: string | number | null;
  via: 'mcp' | 'voice';
};

// --------------------------- the authorization vocabulary ---------------------------

/**
 * The complete vocabulary of scopes a personal access token may be issued with,
 * per mcp-gateway-SPEC. `cloudcli:admin` is deliberately absent: it is reserved
 * and cannot be minted.
 *
 * Re-homed verbatim from `server/modules/oauth/access-tokens.service.ts`
 * (proposal `docs/proposals/mcp-gateway-tool-architecture.md` stage 1) so a
 * stage-2 tool package can declare `requiredScopes` without importing
 * `server/modules/oauth/**`. The OAuth module re-exports it, so its public
 * surface is unchanged.
 *
 * ORDER IS LOAD-BEARING: several production reads destructure it positionally
 * (read, session:send, session:create, session:control, approve), so a new scope
 * is appended LAST rather than inserted. `navigate` and `selection` were both
 * appended for exactly that reason.
 *
 * Consumers: `access-tokens.service.ts` (`normalizeAccessTokenScopes` and this
 * module's `issueToken`), the MCP tool authorisation checks, and the oauth
 * scope criterion.
 */
export const ACCESS_TOKEN_SCOPES = [
  'cloudcli:read',
  'cloudcli:session:send',
  'cloudcli:session:create',
  'cloudcli:session:control',
  'cloudcli:approve',
  // gap-mcp-ui-open-session: lets a token drive `ui_open_session`, the first
  // tool that changes what the user's screen shows. Appended LAST so the five
  // positional reads that predate it keep their index.
  'cloudcli:navigate',
  // gap-ui-visible-context-extended-fields: lets a token read `ui_selected_text`,
  // the user's transcript selection — the one content-bearing reading, and one
  // grade more sensitive than an id. Appended LAST so every earlier positional
  // read keeps its index (the array is read by position in places).
  'cloudcli:selection',
] as const;
