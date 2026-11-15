import type { RealtimeBridgeError, RealtimeSegmentForensics } from "../frames/voice-realtime-bridge.service.js";
import type { VoiceRealtimeOutboundFrame } from "./voice-realtime-contract.js";

// The bridge/transport failure vocabulary rendered as the browser's error text.


/**
 * Renders one bridge failure as human-readable text for the browser.
 *
 * `RealtimeBridgeError` is a discriminated union of readings, not an `Error` —
 * its members carry the facts a caller branches on and no message — so this is
 * the one place the two worlds meet. The `code` is forwarded verbatim as the
 * frame's code; only the message is composed here.
 */
export function describeBridgeError(error: RealtimeBridgeError): string {
  switch (error.code) {
    case 'CONNECTION_FAILED':
      return `Could not reach the Realtime upstream (attempt ${error.attempt}/${error.maxAttempts}).`;
    case 'CONNECTION_LOST':
      return `The Realtime upstream dropped (attempt ${error.attempt}/${error.maxAttempts}).`;
    case 'UNKNOWN_EVENT':
      return `The upstream sent an event this build does not handle: ${error.eventType}.`;
    case 'UPSTREAM_ERROR':
      return `The Realtime upstream reported an error: ${error.message}`;
    case 'TRANSCRIPTION_FAILED':
      return `A spoken segment could not be transcribed: ${error.message}`;
    case 'MODEL_TEXT_REPLY':
      return `The voice model answered itself instead of passing your words to Claude: ${error.text.slice(0, 160)}`;
    case 'TOOL_LOOP_GUARD':
      return `The voice model kept calling the same tool (${error.calls} calls) without you saying anything; it was stopped.`;
    case 'UPSTREAM_STALLED':
      return `The voice service heard you but has not answered for ${error.seconds} s; it may be slow or stuck.`;
    case 'UNKNOWN_TOOL':
      return `The model called an undeclared tool: ${error.tool}.`;
    case 'MALFORMED_FUNCTION_CALL':
      return `A function call from the upstream was malformed: ${error.reason}.`;
    case 'TRUNCATED_BY_TURN':
      return `The model's call was cut off because you started speaking again (call ${error.callId}); it re-sends it.`;
    case 'TOOL_EXECUTION_FAILED':
      return `The tool "${error.tool}" failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
    case 'SEND_FAILED':
      return `A frame could not be sent upstream: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
    case 'DISPATCH_FAILED':
      return `A tool result could not be dispatched: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
  }
}

/**
 * Renders one disconnect-forensics reading as the journal line the log classifier reads.
 *
 * JSON, exactly like the stop audit (`session_interrupt audit {…}`): the bridge hands over a TYPED
 * record — see {@link RealtimeSegmentForensics} — whose field set IS the reading, so a hand-composed
 * sentence here would be a second, lossier copy of data the journal already has in full. The
 * classifier turns it back into a structured entry keyed on the payload's own `kind`.
 *
 * WHY THE PAYLOAD IS NOT SHRUNK TO A SENTENCE. The 2026-10-13 task exists because the journal could
 * not say WHY four whole segments were lost, and the three causes (`upstream-close`,
 * `replay-exhausted`, `pairing-mismatch`) are told apart by numbers — the close frame's code, the
 * socket generation, the replay spend. A prose line would put those numbers out of reach of the
 * reader that has to do the attribution on the next natural recurrence.
 *
 * NOTHING IS SENT TO THE PAGE. This is a measurement, not a disposition: the page already gets the
 * segment's fate from `onSegmentOutcome`, and a new frame here would change what the browser reads.
 */
export function formatSegmentForensics(event: RealtimeSegmentForensics): string {
  return `segment_forensics ${JSON.stringify(event)}`;
}

/**
 * Failure codes that spoil one model turn but leave the connection sound: the model
 * called a tool badly. Everything else (a lost upstream, a missing credential, an
 * event this build cannot read) ends the session.
 */
export const RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'TOOL_ARGUMENT_SCHEMA_VIOLATION',
  'UNDECLARED_TOOL',
  'UNKNOWN_TOOL',
  'MALFORMED_FUNCTION_CALL',
  'TOOL_EXECUTION_FAILED',
  'TRANSCRIPTION_FAILED',
  // `UPSTREAM_STALLED` is deliberately absent: it no longer reaches this channel at all (a stalled
  // turn is reported as `turn_unanswered`), and a code listed here that can never arrive would
  // describe a disposition the proxy does not have.
  'MODEL_TEXT_REPLY',
  'TOOL_LOOP_GUARD',
  // The endpoint's own `error` event usually refuses ONE request (an unknown call id, a
  // content-inspection verdict on one segment); a socket that is really gone is reported
  // separately as CONNECTION_LOST, so this need not end the session by itself.
  'UPSTREAM_ERROR',
]);

export const errorFrame = (code: string, message: string, recoverable = RECOVERABLE_ERROR_CODES.has(code)): VoiceRealtimeOutboundFrame =>
  recoverable ? { type: 'error', code, message, recoverable: true } : { type: 'error', code, message };

/**
 * The endpoint's own "this request was superseded" `error`, matched on the message it carries.
 *
 * AN INTERRUPT WORKING, NOT A FAILURE (2026-10-14 evening reading). When the person speaks over the
 * model, the endpoint cancels the response in flight and narrates it as an `error` whose message is
 * `Response request cancelled by new input`. The browser saw it as a red bar twice in five minutes on
 * a session that was doing exactly what it should. {@link RECOVERABLE_ERROR_CODES} already kept it from
 * ending the session; this is the narrower reading — it must not reach the browser AT ALL, while every
 * other upstream error keeps its frame (see the `onError` arm below).
 */
export const UPSTREAM_CANCELLED_BY_NEW_INPUT = /cancelled by new input/i;

/**
 * Renders one transport-level failure (the DashScope transport's own `onError`
 * channel) as text. The transport's members carry the facts and no message, so the
 * useful ones are named here; anything else falls back to its code plus whatever
 * `reason`/`message` it carried.
 */
export function describeTransportError(error: { code: string } & Record<string, unknown>): string {
  const detail = typeof error.reason === 'string' ? error.reason : typeof error.message === 'string' ? error.message : '';
  switch (error.code) {
    case 'MISSING_API_KEY':
      return 'The Realtime upstream credential is not configured on this server.';
    case 'MASKED_API_KEY':
      return 'The stored voice credential is the masked placeholder, not a real key.';
    case 'SPEND_LIMIT':
      return `Voice spending guard: this connection used about ¥${Number(error.cny).toFixed(3)} ${
        error.scope === 'window' ? `in ${Math.round(Number(error.windowMs ?? 0) / 1000)} s` : 'in total'
      } (limit ¥${Number(error.limitCny).toFixed(3)}), so it was ended. Start Live Voice again to continue.`;
    case 'TOOL_ARGUMENT_SCHEMA_VIOLATION':
      return `The model called ${String(error.tool)} with arguments that do not match its schema (${detail}).`;
    case 'UNDECLARED_TOOL':
      return `The model called an undeclared tool: ${String(error.tool)}.`;
    default:
      return detail === '' ? `Realtime transport error: ${error.code}.` : `Realtime transport error ${error.code}: ${detail}`;
  }
}
