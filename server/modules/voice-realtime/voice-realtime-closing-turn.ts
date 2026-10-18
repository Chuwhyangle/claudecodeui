/**
 * The relay's closing turn and its `session_send` shape — two deployment switches, resolved purely.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE COMPOSITION ROOT. Same reason as
 * `voice-realtime-mode.ts`: the switch has to be resolvable, printable and testable on its own, and
 * nothing here reads `process.env`, logs, or touches a socket. `server/index.ts` hands in the
 * environment at the ONE place the seams are assembled; a proxy handed no seam reads the shipped
 * default constants below, never the environment, so a criterion that sets nothing sees the same
 * default a deployment that sets nothing does.
 *
 * THE CLOSING TURN. After a delivered `session_send` the transport synthesizes a
 * `response.create` so the model can answer "OK" to nobody. Each such response re-reads the whole
 * context. On the 2026-10-15 23:00–00:02 journals 18 of 38 responses were exactly that, 46% of the
 * spend. Removing the RESPONSE alone had regressed twice the day it was tried (the next utterance's
 * response was spent on the reply the model had been told it owed), because the tool result and the
 * prompt still said "Reply with the single word OK". `silent` removes both REQUESTS instead —
 * the tool-result tail and the after-stop sentence — while the transport keeps sending the
 * protocol-mandatory resume: a `function_call_output` that is never followed by a `response.create`
 * leaves the turn unconsumed upstream, and eight such orphans filled the endpoint's turn queue
 * until the ninth user turn was refused (`Turn queue overflow: capacity=8`, 2026-10-18). Replays
 * through the shipped transport and bridge (`experiments/voice-realtime-closing-turn`: ten whole
 * sessions and windows, ¥0.40) kept every stop and lost no unit the closing turn delivered, at
 * 46–50% of its cost. `respond` is the previous wording, byte for byte — the rollback.
 *
 * THE SLIM SEND TOOL. The voice plane advertises `session_send` and `session_interrupt`. The first
 * carries the gateway's generic description and three fields (`session`, `waitSeconds`,
 * `correlationId`) the relay never reads on this plane. `on` advertises `message` alone with a one-line
 * description: −202 tokens on every response, same delivery in four replay windows.
 *
 * BOTH DEFAULT TO THE NEW BEHAVIOUR, AND AN UNKNOWN VALUE RESOLVES TO THAT DEFAULT — REPORTED. A
 * typo in a rollback (`VOICE_REALTIME_CLOSING_TURN=respnd`) must be said out loud rather than read as
 * a working rollback while the new behaviour stayed on; see `invalid`.
 */

/**
 * The environment variable that selects the closing turn for a deployment.
 *
 * Read by the composition root (`server/index.ts`) and handed to {@link resolveVoiceRealtimeClosingTurn};
 * consumed by `voice-realtime-ws-proxy.service.ts` through the resolved value only.
 */
export const VOICE_REALTIME_CLOSING_TURN_ENV = 'VOICE_REALTIME_CLOSING_TURN';

/**
 * The environment variable that selects the voice plane's `session_send` shape.
 *
 * Read by the composition root and handed to {@link resolveVoiceRealtimeSlimSendTool}.
 */
export const VOICE_REALTIME_SLIM_SEND_TOOL_ENV = 'VOICE_REALTIME_SLIM_SEND_TOOL';

/**
 * Whether the model is asked to speak again after a delivered `session_send`.
 *
 * `silent` — neither the tool result nor the prompt asks for an "OK"; the transport still resumes
 * the turn with its protocol-mandatory `response.create`, and that resumed turn is expected to
 * produce no speech. `respond` — the shipped spoken request before 2026-10-16, the rollback.
 */
export type VoiceRealtimeClosingTurn = 'silent' | 'respond';

/** The closing turn a deployment that names none gets. Consumed by the proxy's seam default and by the criteria. */
export const DEFAULT_VOICE_REALTIME_CLOSING_TURN: VoiceRealtimeClosingTurn = 'silent';

/** Whether a deployment that names none advertises the slim `session_send`. Consumed like the constant above. */
export const DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL = true;

/** One closing-turn resolution; `invalid` is the offending raw value, or `null` when there was none. */
export type VoiceRealtimeClosingTurnResolution = {
  closingTurn: VoiceRealtimeClosingTurn;
  invalid: string | null;
};

/** One slim-send-tool resolution; `invalid` is the offending raw value, or `null` when there was none. */
export type VoiceRealtimeSlimSendToolResolution = {
  slim: boolean;
  invalid: string | null;
};

/**
 * Resolves the closing turn from the environment it is handed.
 *
 * Pure and total: unset, empty and blank are the default; `silent` and `respond` are taken as
 * spelled; anything else is the default AND reported through `invalid`.
 * Consumed by `server/index.ts` (`buildVoiceRealtimeSeams`).
 */
export function resolveVoiceRealtimeClosingTurn(
  env: Readonly<Record<string, string | undefined>>,
): VoiceRealtimeClosingTurnResolution {
  const raw = env[VOICE_REALTIME_CLOSING_TURN_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { closingTurn: DEFAULT_VOICE_REALTIME_CLOSING_TURN, invalid: null };
  }
  const value = raw.trim();
  if (value === 'silent' || value === 'respond') {
    return { closingTurn: value, invalid: null };
  }
  return { closingTurn: DEFAULT_VOICE_REALTIME_CLOSING_TURN, invalid: value };
}

/**
 * Resolves the slim send tool from the environment it is handed.
 *
 * Same shape as {@link resolveVoiceRealtimeClosingTurn}: `on` / `off` as spelled, unset or empty the
 * default, anything else the default and reported. Consumed by `server/index.ts`.
 */
export function resolveVoiceRealtimeSlimSendTool(
  env: Readonly<Record<string, string | undefined>>,
): VoiceRealtimeSlimSendToolResolution {
  const raw = env[VOICE_REALTIME_SLIM_SEND_TOOL_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { slim: DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL, invalid: null };
  }
  const value = raw.trim();
  if (value === 'on') return { slim: true, invalid: null };
  if (value === 'off') return { slim: false, invalid: null };
  return { slim: DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL, invalid: value };
}

/**
 * The line to log for a closing-turn resolution, or `null` when there is nothing to report.
 * Consumed by `server/index.ts`, which passes its own sink.
 */
export function describeVoiceRealtimeClosingTurn(resolution: VoiceRealtimeClosingTurnResolution): string | null {
  if (resolution.invalid === null) return null;
  return `closing-turn: ${VOICE_REALTIME_CLOSING_TURN_ENV}="${resolution.invalid}" is not a known value (silent | respond) — using the default (${DEFAULT_VOICE_REALTIME_CLOSING_TURN})`;
}

/**
 * The line to log for a slim-send-tool resolution, or `null` when there is nothing to report.
 * Consumed by `server/index.ts`.
 */
export function describeVoiceRealtimeSlimSendTool(resolution: VoiceRealtimeSlimSendToolResolution): string | null {
  if (resolution.invalid === null) return null;
  return `slim-send-tool: ${VOICE_REALTIME_SLIM_SEND_TOOL_ENV}="${resolution.invalid}" is not a known value (on | off) — using the default (${DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL ? 'on' : 'off'})`;
}

/**
 * The closing sentence of every "the message was accepted" tool result, for one closing-turn mode.
 *
 * `respond` is the wording the model has always been given. `silent` replaces ONLY the request to
 * answer: the "do not call it again" half stays in the result's own text, because the loop guard it
 * implements (2026-10-10, 89 calls in a minute) is independent of whether a closing turn exists.
 * Consumed by `voice-realtime-ws-proxy.service.ts` (the six result wordings).
 */
export function acceptedResultTail(closingTurn: VoiceRealtimeClosingTurn): string {
  return closingTurn === 'respond'
    ? 'Reply with the single word OK.'
    : 'Nothing more is needed from you: say nothing and wait for the user to speak again.';
}

/**
 * What the prompt says to do after a stop is issued, for one closing-turn mode.
 *
 * `respond` asks for the one-word acknowledgement the closing turn exists to carry; `silent` must not,
 * or the model is told to reply and given no turn in which to do it (the failure the first rollback
 * attempt hit). Consumed by `voice-realtime-ws-proxy.service.ts` (`voiceRealtimeInstructionsFor`).
 */
export function afterStopSentence(closingTurn: VoiceRealtimeClosingTurn): string {
  return closingTurn === 'respond'
    ? 'Then reply with the single word OK and say nothing else.'
    : 'Then say nothing more.';
}
