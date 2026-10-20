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
 * (`VOICE_REALTIME_CLOSING_TURN=silent`, no summary producer) therefore keeps the pre-narrator wire;
 * naming `announce` installs the queue so the remark can be spoken, and handing in a producer
 * installs the summary.
 *
 * THE SUMMARY PRODUCER IS A SEAM WITH TWO IMPLEMENTATIONS. The real one is the side text model leaf
 * (`voice-realtime-summary.ts`, armed by `VOICE_REALTIME_SUMMARY_MODEL`); the other is the fixed
 * `VOICE_REALTIME_SUMMARY_STANDIN` sentence. Both arrive here as the SAME `summarizeRunEnd` function,
 * so the proxy cannot tell them apart — it asks, re-reads the answer through its own quality gate
 * (≤40 chars, no Markdown, no verbatim tail), and injects what passes. The stand-in is the same kind
 * of deployment seam as `VOICE_REALTIME_ENDPOINT`; because it changes what the narrator says without
 * a credential, it is reported at assembly (see {@link describeVoiceRealtimeSummaryStandin}).
 */
import type { VoiceRealtimeClosingTurn } from './voice-realtime-closing-turn.js';
import type { VoiceRealtimeRunEndSummarizer } from './voice-realtime-summary.js';
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
 * speak each other's summaries. A wiring built for `silent` with no producer returns `null`, which is
 * what keeps every criterion written before this feature on its original wire.
 *
 * `summarizeRunEnd` is the seam, not the implementation: the composition root passes the side-model
 * leaf or a closure over the stand-in sentence. Pass `null` for "this deployment has no summary".
 *
 * Consumed by `server/index.ts`; the criteria drive the same proxy through their own injected seams.
 */
export function buildVoiceRealtimeNarratorWiring(input: {
  closingTurn: VoiceRealtimeClosingTurn;
  summarizeRunEnd: VoiceRealtimeRunEndSummarizer['summarize'] | null;
}): VoiceRealtimeNarratorWiring | null {
  if (input.closingTurn !== 'announce' && input.summarizeRunEnd === null) {
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
  if (input.summarizeRunEnd !== null) {
    wiring.runEndSummary = {
      // The proxy calls this only after its own context-pack check; the producer decides how to
      // answer — the side model's HTTP leaf, or the one sentence a stand-in criterion asked for.
      summarize: input.summarizeRunEnd,
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
