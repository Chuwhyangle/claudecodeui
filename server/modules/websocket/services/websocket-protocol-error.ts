import type { WebSocket } from 'ws';

import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The gateway's protocol-error writer, in its own leaf.
 *
 * Both the transport module and the run dispatcher report refusals through it
 * (the dispatcher reports the admission refusals it decides before the first
 * await), and the dispatcher must not import the transport — that edge would
 * close the `chat-control ⇄ chat-websocket` cycle the contract extraction
 * broke.
 */
export function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
export function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}
