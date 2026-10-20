/**
 * The authenticated MCP caller, as the contract states it.
 *
 * This was defined by the gateway's `/mcp` auth middleware
 * (`server/modules/mcp-gateway/mcp-gateway.auth.ts`, AC-241 / AC-263) and is
 * re-homed here so a domain tool package can type its handler's principal
 * without importing `server/modules/**` (proposal
 * `docs/proposals/mcp-gateway-tool-architecture.md`, rule R2). The middleware
 * still OWNS the resolution: it builds this shape from a verified token and
 * attaches it to `res.locals.mcpPrincipal`; this file only states the contract.
 *
 * `userId` is the token owner; `scopes` are the scopes the token carries;
 * `tokenId` is the token's row id and `clientId` the OAuth client it was issued
 * to (always `null` for a personal access token, which has no client).
 *
 * Consumers: `mcp-gateway.auth.ts` (re-exported unchanged through the gateway
 * barrel), the audit wrapper, the transport's tool dispatch (which maps it to a
 * `ControlCaller`), the voice-realtime live executor, and every tool handler
 * that reads the caller's scopes or identity.
 */
export type McpPrincipal = {
  userId: number;
  tokenId: number;
  clientId: string | null;
  scopes: string[];
};
