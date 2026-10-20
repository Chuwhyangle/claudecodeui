/**
 * The session-turn read port.
 *
 * The MCP self-target guard and the stage-2 session tools need the live phase of
 * one session's turn, but the implementation (`readSessionTurn`) belongs to the
 * provider runtime and must stay there — the proposal
 * `docs/proposals/mcp-gateway-tool-architecture.md` (§3.3, rule R2) injects it
 * through this port from the composition root instead of letting a tool package
 * import `server/modules/providers/**`.
 *
 * This file states the SHAPE only; `readSessionTurn` itself remains in
 * `server/modules/providers/list/claude/claude-runtime.provider.ts` and is
 * re-exported unchanged through the providers barrel.
 *
 * Consumers: the composition root (which binds the port to `readSessionTurn`)
 * and any tool package that needs the turn reading. Like every other port in
 * this directory it is imported as a type, so it adds no runtime edge.
 */

/**
 * The live phase of one session's turn.
 *
 * - `idle` — no turn in flight (before the first frame, or after `result`).
 * - `thinking` — a `system/thinking_tokens` estimate arrived.
 * - `writing` — a text `content_block_delta` is in flight.
 * - `tool` — a `tool_use` block was emitted and its paired `tool_result` has
 *   not arrived.
 * - `awaitingPermission` — a `permission_request` is outstanding.
 * - `compacting` — a `system/compact_boundary` arrived.
 */
export type SessionTurnPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'awaitingPermission' | 'compacting';

/**
 * What a caller reads back for one session.
 *
 * Structurally the provider runtime's `TurnState` (this port deliberately
 * restates the shape rather than importing it, so `server/shared` grows no edge
 * into `server/modules/**`). `toolName` is the `name` of the pending `tool_use`
 * block (or `null`); `toolDurationMs` is the tool's elapsed time when a frame
 * carries one — `null` otherwise.
 */
export type SessionTurnState = {
  phase: SessionTurnPhase;
  toolName: string | null;
  toolDurationMs: number | null;
};

/**
 * The injected turn-reading seam.
 *
 * `readSessionTurn` is synchronous and side-effect free: it reads the process's
 * turn tracker and returns the current reduction, never a copy that can be
 * mutated to change it.
 */
export interface SessionTurnPort {
  readSessionTurn(sessionId: string): SessionTurnState;
}
