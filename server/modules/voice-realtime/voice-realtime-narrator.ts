/**
 * The narrator layer's composition-root wiring: the per-connection queue the announce closing turn
 * and the run-end summary speak through.
 *
 * WHY THIS FILE EXISTS. The proxy owns WHEN text is produced — the announce gate turns the model's
 * follow-up remark into a narration, and the run-end transition asks the summary producer once — and
 * the browser owns playback. Between them sits the composition root: it hands each connection a
 * {@link VoiceRealtimeNarratorSeams} (the queue `attach` receives) and, when a deployment names one,
 * a {@link VoiceRealtimeRunEndSummarySeams}. Keeping that assembly here rather than inline in
 * `server/index.ts` follows the module boundary the rest of this feature uses: the root reads the
 * environment once at its assembly point, and this module resolves it without touching a socket.
 *
 * PRESENCE IS THE SWITCH. Both halves are optional — the proxy builds no queue, takes no hook and
 * behaves byte-for-byte as before when the returned wiring is `null`. The shipped default
 * (`VOICE_REALTIME_CLOSING_TURN=silent`, no summary stand-in) therefore keeps the pre-narrator wire;
 * naming `announce` installs the queue so the remark can be spoken, and naming a summary stand-in
 * installs the producer.
 *
 * THE SUMMARY PRODUCER IS A STAND-IN, DELIBERATELY. The real run-end summary is a side text model
 * (the B-1 probe's findings); wiring that model here would need a cloud credential and a network the
 * E0 replay must not have. `VOICE_REALTIME_SUMMARY_STANDIN` is the same kind of deployment seam as
 * `VOICE_REALTIME_ENDPOINT`: a criterion names the text the narrator should say, and the proxy's own
 * quality gate (≤40 chars, no Markdown, no verbatim tail) judges it exactly as it judges a model's
 * answer. Unlike the endpoint seam it is NOT a criterion-only path — a deployment that sets it gets
 * that sentence spoken at every run end — so it is reported at assembly (see
 * {@link describeVoiceRealtimeSummaryStandin}) rather than being silently active.
 */
import type { VoiceRealtimeClosingTurn } from './voice-realtime-closing-turn.js';
import type {
  VoiceRealtimeNarratorQueue,
  VoiceRealtimeNarratorSeams,
  VoiceRealtimeRunEndSummarySeams,
} from './voice-realtime-ws-proxy.service.js';

/**
 * The environment variable that names the run-end summary's stand-in text.
 *
 * Read by `server/index.ts` at its assembly point and resolved here. Unset or blank means "no summary
 * producer at all", which is the shipped state: the narrator exists only for a closing turn that can
 * produce speech.
 */
export const VOICE_REALTIME_SUMMARY_STANDIN_ENV = 'VOICE_REALTIME_SUMMARY_STANDIN';

/**
 * One connection's narrator wiring, as the composition root hands it to the proxy.
 *
 * `runEndSummary` is optional even when `narrator` is present: `announce` needs the queue and nothing
 * else, while a summary needs a producer. Consumers: `server/index.ts`, which spreads this into the
 * seams it returns from `buildVoiceRealtimeSeams`.
 */
export type VoiceRealtimeNarratorWiring = {
  narrator: VoiceRealtimeNarratorSeams;
  runEndSummary?: VoiceRealtimeRunEndSummarySeams;
};

/**
 * Resolves the summary stand-in from the environment it is handed.
 *
 * Pure and total: unset and blank are both `null` (no producer), and any non-blank text is the
 * sentence the narrator says. No trimming of the text beyond surrounding whitespace — the proxy's
 * quality gate, not this resolver, decides whether the sentence is speakable. Consumed by
 * `server/index.ts`.
 */
export function resolveVoiceRealtimeSummaryStandin(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const raw = env[VOICE_REALTIME_SUMMARY_STANDIN_ENV];
  if (raw === undefined) return null;
  const text = raw.trim();
  return text === '' ? null : text;
}

/**
 * Builds one connection's narrator wiring, or `null` when this deployment has no narrator at all.
 *
 * The queue is captured through `attach` (the proxy calls it once the browser downlink exists), so
 * the summary producer injects into exactly that connection's queue and two connections can never
 * speak each other's summaries. A wiring built for `silent` with no stand-in returns `null`, which is
 * what keeps every criterion written before this feature on its original wire.
 *
 * Consumed by `server/index.ts`; the criteria drive the same proxy through their own injected seams.
 */
export function buildVoiceRealtimeNarratorWiring(input: {
  closingTurn: VoiceRealtimeClosingTurn;
  summaryStandin: string | null;
}): VoiceRealtimeNarratorWiring | null {
  if (input.closingTurn !== 'announce' && input.summaryStandin === null) {
    return null;
  }
  /** This connection's queue, handed over by the proxy's `attach`. */
  let queue: VoiceRealtimeNarratorQueue | null = null;
  /** Ids the page correlates a summary's playback on; unique per connection and connection-local. */
  let summarySeq = 0;
  const wiring: VoiceRealtimeNarratorWiring = {
    narrator: {
      attach: (attached) => {
        queue = attached;
      },
    },
  };
  if (input.summaryStandin !== null) {
    wiring.runEndSummary = {
      // The proxy calls this only after its own context-pack check; the stand-in ignores the pack by
      // construction and answers the one sentence a criterion asked for.
      summarize: async () => input.summaryStandin,
      inject: (text) => {
        if (queue === null) return;
        queue.enqueue({ utteranceId: `run-end-summary-${summarySeq}`, text });
        summarySeq += 1;
      },
    };
  }
  return wiring;
}

/**
 * The line to log when the stand-in is active, or `null` when it is not.
 *
 * Reported because this switch changes what the narrator says without any credential or side model:
 * an operator reading the server log has to be able to tell a stand-in deployment from a real one.
 * Consumed by `server/index.ts`, which passes its own sink.
 */
export function describeVoiceRealtimeSummaryStandin(standin: string | null): string | null {
  if (standin === null) return null;
  return (
    `run-end summary: ${VOICE_REALTIME_SUMMARY_STANDIN_ENV} is set — the narrator speaks the stand-in ` +
    `text (chars=${standin.length}) instead of asking a side text model`
  );
}
