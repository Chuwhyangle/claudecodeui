/**
 * The MCP gateway's tool-failure envelope — now a re-export of the contract.
 *
 * The single statement of `MCP_ERROR_CODES`, the error-envelope shapes,
 * `McpToolError`, `mcpErrorResult`, `toMcpErrorResult` and the argument/scope
 * helpers moved verbatim to `server/shared/mcp-contract/errors.ts` (proposal
 * `docs/proposals/mcp-gateway-tool-architecture.md`, stage 1) so a domain tool
 * package can depend on it without importing `server/modules/**`.
 *
 * This file stays only as the gateway-internal compatibility path: existing
 * consumers and the gateway barrel (`./index.js`) import from here, and the
 * contract is the ONE definition behind them. New code should import from
 * `@/shared/mcp-contract` directly.
 */

export * from '@/shared/mcp-contract/errors.js';
