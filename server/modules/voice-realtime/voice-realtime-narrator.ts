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
 * (no Markdown, no verbatim tail; length is only a reading), and injects what passes. The stand-in
 * is the same kind of deployment seam as `VOICE_REALTIME_ENDPOINT`; because it changes what the
 * narrator says without a credential, it is reported at assembly (see
 * {@link describeVoiceRealtimeSummaryStandin}).
 *
 * THE RUN-END ACK IS A SECOND, SMALLER PRODUCER. The run-end transition is otherwise silent for
 * 8–13 s while the side model thinks, so the proxy asks this wiring for one fixed confirmation the
 * moment the run ends and the summary follows afterwards. Its candidates are deployment text
 * (`VOICE_REALTIME_RUN_END_ACK`, `|`-separated), its pick is injected (`random`, so a criterion can
 * name the first and last candidate), and it is INDEPENDENT of the summary: an empty context pack,
 * a `null` answer or a refused summary all leave the ack in the queue. Ordering and the duplex rule
 * are the queue's — this wiring only enqueues with its own id family (`run-end-ack-N`).
 */
import type { VoiceRealtimeClosingTurn } from './voice-realtime-closing-turn.js';
import type { VoiceRealtimeRunEndSummarizer } from './voice-realtime-summary.js';
import type {
  VoiceRealtimeNarratorQueue,
  VoiceRealtimeNarratorSeams,
  VoiceRealtimeRunEndAckSeam,
  VoiceRealtimeRunEndSummarySeams,
} from './voice-realtime-ws-proxy.service.js';

/**
 * The environment variable that names the run-end confirmation's candidate sentences.
 *
 * Read by `server/index.ts` at its assembly point and resolved here. Unset or blank means no ack at
 * all — the pre-ack wire, byte for byte. This is the ESCAPE HATCH, not the primary knob: the
 * settings file's `runEndAck` key is where a deployment configures the table, and a non-empty value
 * here overrides it (environment > file > off).
 */
export const VOICE_REALTIME_RUN_END_ACK_ENV = 'VOICE_REALTIME_RUN_END_ACK';

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
  runEndAck?: VoiceRealtimeRunEndAckSeam;
};

/**
 * Splits ONE `|`-separated ack table into its candidate sentences.
 *
 * Pure and total: empty segments between separators are dropped, so a trailing `|` cannot put an
 * empty utterance on the queue, and a blank table answers `[]` (no ack). This is the ONE splitter:
 * `voice-realtime-settings.ts` parses the file's `runEndAck` key with it and
 * {@link resolveVoiceRealtimeRunEndAckCandidates} parses the environment escape hatch with it, so
 * the two sources cannot disagree about what a table means.
 *
 * Consumers: `voice-realtime-settings.ts` (the file key) and
 * {@link resolveVoiceRealtimeRunEndAckCandidates} (the environment key).
 */
export function splitVoiceRealtimeRunEndAckCandidates(raw: string): string[] {
  return raw
    .split('|')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== '');
}

/**
 * Splits the configured ack string into its candidate sentences.
 *
 * Pure and total: unset or blank answers `[]`. The parsing itself lives in
 * {@link splitVoiceRealtimeRunEndAckCandidates}, shared with the settings file's `runEndAck` key.
 * Consumed by `server/index.ts`.
 */
export function resolveVoiceRealtimeRunEndAckCandidates(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const raw = env[VOICE_REALTIME_RUN_END_ACK_ENV];
  if (raw === undefined) return [];
  return splitVoiceRealtimeRunEndAckCandidates(raw);
}

/**
 * Picks one candidate with the injected random source.
 *
 * `random` answers in `[0, 1)`, so `0` is the FIRST candidate and a value near `1` is the LAST —
 * the two readings the criterion names. Out-of-range answers are clamped rather than left to
 * `undefined`: a criterion may hand in an exact `1`, and "say nothing" must not be the accident of
 * an index one past the end. `null` only when the candidate list is empty.
 */
export function pickVoiceRealtimeRunEndAck(
  candidates: readonly string[],
  random: () => number,
): string | null {
  if (candidates.length === 0) return null;
  const index = Math.min(Math.max(Math.floor(random() * candidates.length), 0), candidates.length - 1);
  return candidates[index] ?? null;
}

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
 * speak each other's summaries. A wiring built for `silent` with no producer AND no ack candidates
 * returns `null`, which is what keeps every criterion written before this feature on its original
 * wire. An ack alone is enough to keep the wiring alive: it needs only the queue.
 *
 * `summarizeRunEnd` is the seam, not the implementation: the composition root passes the side-model
 * leaf or a closure over the stand-in sentence. Pass `null` for "this deployment has no summary".
 *
 * Consumed by `server/index.ts`; the criteria drive the same proxy through their own injected seams.
 */
export function buildVoiceRealtimeNarratorWiring(input: {
  closingTurn: VoiceRealtimeClosingTurn;
  summarizeRunEnd: VoiceRealtimeRunEndSummarizer['summarize'] | null;
  /** The confirmation sentences; unset/empty means no ack at all (the pre-ack wire). */
  runEndAck?: readonly string[];
  /** The picker's random source, injected so a criterion can name an exact candidate. */
  random?: () => number;
}): VoiceRealtimeNarratorWiring | null {
  const ackCandidates = input.runEndAck ?? [];
  const random = input.random ?? Math.random;
  if (input.closingTurn !== 'announce' && input.summarizeRunEnd === null && ackCandidates.length === 0) {
    return null;
  }
  /** This connection's queue, handed over by the proxy's `attach`. */
  let queue: VoiceRealtimeNarratorQueue | null = null;
  /** Ids the page correlates a summary's playback on; unique per connection and connection-local. */
  let summarySeq = 0;
  /** The ack's own id family, distinct from the summary's so the page can tell the two apart. */
  let ackSeq = 0;
  const wiring: VoiceRealtimeNarratorWiring = {
    narrator: {
      attach: (attached) => {
        queue = attached;
      },
    },
  };
  if (ackCandidates.length > 0) {
    wiring.runEndAck = {
      // The proxy calls this AT the `running → idle` transition, before the settle wait: the ack is
      // the immediate "I heard the run end" beat, and the summary follows it through the same queue.
      speak: () => {
        if (queue === null) return;
        const text = pickVoiceRealtimeRunEndAck(ackCandidates, random);
        if (text === null) return;
        queue.enqueue({ utteranceId: `run-end-ack-${ackSeq}`, text });
        ackSeq += 1;
      },
    };
  }
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
