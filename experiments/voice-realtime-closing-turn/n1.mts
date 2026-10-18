/**
 * N1 as a pure transform, shared by the offline proxy probe and the live replay stages.
 *
 * N1 = no closing response after a tool result (`respondToToolOutputs:false`) + the two "reply OK"
 * requests removed. Nothing here edits production: the texts are rewritten at the transport seam, and
 * the rewritten bytes are exactly the ones a landing would ship.
 */
import { VOICE_REALTIME_INSTRUCTIONS } from '../../server/modules/voice-realtime/index.js';

export const OK_TAIL = 'Reply with the single word OK.';
export const NO_REPLY_TAIL =
  'Nothing more is needed from you: say nothing and wait for the user to speak again.';
const OK_SENTENCE = 'Then reply with the single word OK and say nothing else.';

if (!VOICE_REALTIME_INSTRUCTIONS.includes(OK_SENTENCE)) {
  throw new Error('the shipped prompt no longer contains the "reply OK" sentence N1 replaces — re-derive N1');
}

export const N1_INSTRUCTIONS = VOICE_REALTIME_INSTRUCTIONS.replace(OK_SENTENCE, 'Then say nothing more.');

/** Rewrites every "reply OK" request inside a tool result; anything else passes through untouched. */
export function n1Output(output: unknown): unknown {
  return JSON.parse(JSON.stringify(output ?? null).split(OK_TAIL).join(NO_REPLY_TAIL));
}

type Sendable = { send(message: Record<string, unknown>): void };

/** Wraps a transport so tool results are rewritten on the way out. The transport object is kept. */
export function withN1Results<T extends Sendable>(transport: T): T {
  const original = transport.send.bind(transport);
  transport.send = (message: Record<string, unknown>): void => {
    if (message.type === 'function_call_output') {
      original({ ...message, output: n1Output(message.output) });
      return;
    }
    original(message);
  };
  return transport;
}
