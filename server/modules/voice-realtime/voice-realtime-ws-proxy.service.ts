/**
 * The `/voice-realtime` WebSocket handler — the browser's half of a Realtime
 * voice connection (GOAL-031 / AC-312).
 *
 * WHY IT EXISTS. AC-310 wired the Realtime TOOL table to the real MCP services
 * (`voice-realtime-live-executor.ts`) and AC-311 made the bridge survive a
 * dropped connection, but both are server-side leaves: nothing let a BROWSER
 * open a Realtime session. This handler is that wire. It sits between the
 * browser socket and a real DashScope transport, so the credentials stay on the
 * server (the browser never dials the upstream itself) and the browser speaks
 * one small JSON protocol rather than DashScope's.
 *
 * WHY THERE IS NO INTENT CONFIRMATION (GOAL-033 / AC-316). Earlier builds
 * surfaced the model's proposed `session_send` as an editable draft and
 * awaited a browser `decision` frame before calling the real AC-310 handler.
 * AC-316 removed that step: Live Voice is a continuous-capture mode with no
 * per-utterance confirmation UI, so `session_send` now executes the moment the
 * model calls it. The bridge routes `function_call` frames straight into the
 * executor's routing table and exposes no `onFunctionCall` hook — deliberately,
 * so the bridge stays an offline-provable leaf — so this handler's executor
 * wrapper is now a thin single-flight guard rather than a confirmation gate.
 *
 * WHAT THE BROWSER MAY SAY (inbound, one JSON object per frame):
 *   - `{ type: 'hello', protocol }` — the segmented-relay offer, sent the moment the socket opens
 *     (P4 / AC-322). The server answers it, or does not, and that answer is the whole protocol
 *     switch: silence keeps the connection on the continuous frames below.
 *   - `{ type: 'segment_start' | 'audio' | 'segment_end' }` — one relay segment (SPEC §C1).
 *   - `{ type: 'context', text, chars, rows }` — the C2 context pack.
 *   - `{ type: 'audio', audio }`  — one base64 PCM frame from the capture
 *     pipeline (microphone or an injected test file), sent only while the
 *     browser is not muted.
 *   - `{ type: 'close' }` — the browser is done; the upstream is closed.
 *
 * WHAT THE SERVER SAYS (outbound):
 *   - `{ type: 'ready', protocol }` — the segmented-relay acceptance; absent means "stay continuous".
 *   - `{ type: 'state', state }`   — the bridge's connection state.
 *   - `{ type: 'sent', sessionId, result }` — the real `session_send` answer.
 *   - `{ type: 'error', code, message }` — a reported bridge/transport failure.
 *
 * The tool whitelist that pins every send onto the connection's one session is
 * NOT re-implemented here: the executor the caller injects is
 * `createVoiceRealtimeLiveExecutor`, whose `boundSessionId` already refuses a
 * call naming another session. This handler only decides WHEN a send happens,
 * never WHICH session it reaches.
 */
import { readFileSync } from 'node:fs';

import { WebSocket } from 'ws';

import { clearVoiceSessionActive, markVoiceSessionActive } from './voice-realtime-active.js';
import { pickAnnouncePhraseFrom } from './voice-realtime-announce-phrases.js';
import type { VoiceRealtimeAudioCapture } from './voice-realtime-audio-capture.js';
import {
  connect,
  type RealtimeBridge,
  type RealtimeBridgeError,
  type RealtimeBridgeHooks,
  type RealtimeBridgeOptions,
  type RealtimeBridgeState,
  type RealtimeSegmentCommitMode,
  type RealtimeSegmentEndReason,
  type RealtimeSegmentForensics,
  type RealtimeSegmentPhaseEvent,
  type RealtimeToolExecutor,
  type RealtimeTransport,
  withoutToolResume,
} from './voice-realtime-bridge.service.js';
import {
  composeVoiceRealtimeInstructions,
  loadVoiceRealtimeSettings,
} from './voice-realtime-settings.js';
import {
  DEFAULT_VOICE_REALTIME_CLOSING_TURN,
  DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL,
  acceptedResultTail,
  afterStopSentence,
  type VoiceRealtimeClosingTurn,
} from './voice-realtime-closing-turn.js';
import {
  OMISSION_FILL_NUMERAL_MODES,
  planOmissionFills,
  type OmissionFill,
  type OmissionFillExecuted,
  type OmissionFillFinal,
  type OmissionFillParams,
} from './voice-realtime-omission-fill.js';
import { voiceRealtimeToolsFor } from './voice-realtime-tools.js';
import type {
  VoiceRealtimeTtsFrame,
  VoiceRealtimeTtsInput,
  VoiceRealtimeTtsResult,
} from './voice-realtime-tts.js';
import { createLocalSpeechGate, type LocalSpeechBoundary } from './voice-realtime-local-speech.js';
import { createSilenceTailGate, type SilenceTailOptions } from './voice-realtime-silence-tail.js';
import {
  describeUplinkVadBackend,
  readUplinkVadBackend,
  type UplinkVadClassifier,
} from './voice-realtime-uplink-vad.js';
import {
  UPLINK_VAD_HOLD_OPEN_MAX_MS,
  createUplinkVadGate,
  type UplinkVadGate,
  type UplinkVadGateStats,
} from './voice-realtime-uplink-vad-gate.js';
import { markUplinkVadFailed, readUplinkVadState } from './voice-realtime-uplink-vad-arm-point.js';
import {
  describeSilenceDurationSource,
  describeTurnDetection,
  resolveTurnDetection,
  type TurnDetectionValues,
} from './voice-realtime-turn-detection.js';
import { createUpstreamPool, type UpstreamPoolRotation } from './voice-realtime-upstream-pool.js';
import {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  applyVoiceRealtimeTransport,
  describeVoiceRealtimeMode,
  resolveVoiceRealtimeMode,
  type VoiceRealtimeTransport,
} from './voice-realtime-mode.js';

/** The WebSocket path this handler answers. Mounted by the websocket gateway. */
export const VOICE_REALTIME_PATH = '/voice-realtime';

/**
 * The scopes a first-party voice connection carries.
 *
 * A voice connection presents no PAT and reaches no HTTP endpoint: it is opened
 * by an already-authenticated browser, so the browser's own authority is what it
 * acts with. The set is the full first-party vocabulary the gateway's tools
 * check against, listed in one place so a tool that later adds a scope names a
 * missing entry rather than silently narrowing what the user can say.
 */
export const VOICE_REALTIME_CALLER_SCOPES = [
  'cloudcli:approve',
  'cloudcli:navigate',
  'cloudcli:read',
  'cloudcli:session:control',
  'cloudcli:session:create',
  'cloudcli:session:send',
] as const;

/**
 * The session instructions the proxy installs once the Realtime connection is up.
 *
 * A RELAY, deliberately. The first version told the model to call `session_send` only for
 * "something to be done" and not "to answer questions you can answer yourself"; measured against
 * the real model that forwarded 7 of 12 test utterances, and the other 5 were answered in a TEXT
 * reply nothing displays — so the user spoke, saw their words transcribed, and then saw nothing
 * (`experiments/voice-realtime-prompt/`). Claude is the one who reasons; this model only carries
 * the words over.
 *
 * Kept here rather than in a UI string table because it is a PROMPT, not copy:
 * it names the function the model must call and the argument the server's
 * whitelist reads back, so it has to agree with `VOICE_REALTIME_TOOLS`' `session_send`
 * schema rather than with anything the browser renders.
 *
 * THE MODEL IS A PEN, NOT AN AGENT (2026-10-14 ruling, journal `e650117b`; replay measured in
 * `experiments/voice-realtime-relay-mode-replay/`). The prompt used to spend a whole paragraph
 * opening a four-way choice for what to do about the work that is running — let it continue by
 * calling no function, add to it, change where it goes, or stop it — and the real model took the
 * first arm literally: while Claude was running it judged that nothing new needed carrying and
 * answered in text, so four utterances from the 2026-10-14 morning session never reached the
 * session. The ruling fixes the role: this model tidies the person's words and passes them on, and
 * whether they are worth passing on is never its call. The paragraph is gone, replaced by one
 * sentence that leaves the model no no-op arm and forbids a text reply. On the three most recent
 * real captures the shipped four-arm prompt produced 31 text replies to the person's speech and
 * lost or materially cut ≈22 message units; the reworded prompt produced 0 of each.
 *
 * THE STOP JUDGEMENT CARRIES NO WORD LIST, and that half predates the ruling. The sentence used to
 * spell out the words that counted as a stop (the list is preserved in SPEC §18.1 F-5; it is
 * deliberately NOT repeated in this file, so the prompt is not one grep away from being a keyword
 * table again), which is a CONDITIONAL MAPPING from words to an abort: it makes the model a matcher
 * rather than a reader, and it fails on exactly the utterance that motivated this — the user asked
 * for the in-flight work to be cancelled without using any of those words, so the model relayed it
 * as ordinary speech and the run kept going (SPEC C-2 forbids the mapping; SPEC §18.1 F-5 records
 * the journal). The exception is stated as the JUDGEMENT it always was: the model reads what the
 * person meant, and a stop is whatever reads that way. The `intent` field is the audit of that
 * reading, so the instructions name it and the reason it is owed (SPEC §6.2).
 *
 * THE INTERRUPT ALWAYS CARRIES THE PERSON'S WORDS (2026-10-14 ruling, Q1). The interrupt stays the
 * model's own judgement, but the call now states their words in `message` and the reading behind
 * the judgement in `intent`; the words are always present, even when all they asked for was the
 * stop. The second live test lost exactly that case — the person asked to interrupt and only the
 * intent reached the CLI (journal `e650117b`). The replay measured the change: interrupts that
 * carried the person's words went 5/6 → 6/6, and the ones that should have interrupted 6/10 →
 * 8/10. The proxy enqueues the carried `message` BEFORE it aborts (`sessionInterrupt`, E10/U2), so
 * the words and the run they correct reach the CLI in the same turn rather than a turn late.
 *
 * THE SEMANTIC WIDENING (SPEC §0.3 D-6, §18.4 G1, GOAL-041 AC-342). The exception names two
 * judgements — "stop", and "correct the direction of what is running" — and a correction travels as
 * the `message` field of the SAME `session_interrupt` call rather than as a second `session_send`.
 * It stays a semantic judgement over what the person meant, so the keyword list that used to sit
 * here must not come back (the negative-control scan in
 * `voice-realtime-instructions-no-stop-words.test.ts` holds that; AC-340 stays green).
 *
 * THE RELIABILITY PASS (2026-10-14 ruling; task `gap-voice-busy-preemption-instruction-reliability`).
 * A word list is not the only way this prompt can make the model a matcher; §1.4 of the proposal
 * measured the SAME sentence judged `session_send` on the live session and `session_interrupt` on
 * replay — "该抢不抢" — and the shape of the failing window is that the wish to stop or redirect
 * arrives wrapped in words the person is ALSO adding (a pause plus a fresh request). The model read
 * the added words as an addition and queued the whole thing behind the run. The clauses kept here
 * are the whole of that reading: the wish is read from the WHOLE utterance rather than from the part
 * that looks like a command, added words are the correction to carry rather than a reason to queue,
 * and one sentence names that exact failure so the model has the mistake in view. It adds no
 * threshold, no duration and no relatedness gate (SPEC D-6 stands): it is instruction text only, and
 * the negative-control scan in `voice-realtime-instructions-no-stop-words.test.ts` still holds it to
 * the same form.
 *
 * AC7 CORRECTED THE WORDING (2026-10-14, task `gap-voice-relay-mode-a-prompt-drop-continue-arm-and-session-status`).
 * The first draft of this text stated the rule without the framing below and the replay's arm B —
 * which replays THIS array — measured 4 text replies to the person's speech on `e650117b`, twice, so
 * not a flake; the experiment's arm A measured 0 on the same capture in the same session. The clauses
 * that close the gap are arm A's: the relay opens by saying it tidies the person's words and passes
 * them on rather than taking part, the pass-on sentence keeps the fragment-joining and the
 * no-paraphrase limit, and the rule ends by naming the only choice the model has as HOW a thing is
 * delivered. With them the same three-capture replay reads 0/0/0 text replies. Nothing was dropped
 * from the reliability pass above.
 *
 * This array is the text the replay's arm B replays verbatim, so the measured prompt and the shipped
 * one are the same bytes.
 */
/**
 * The relay's instructions for one closing-turn mode.
 *
 * ONE SENTENCE MOVES. After a stop the shipped prompt tells the model to "reply with the single word
 * OK"; with no closing turn that request has nowhere to land and the model spends the NEXT
 * utterance's response on it (the first rollback attempt, 2026-10-10: three of five spoken
 * instructions heard and never relayed). So `silent` replaces that sentence and nothing else, and
 * `respond` is the shipped text byte for byte — {@link VOICE_REALTIME_INSTRUCTIONS}.
 *
 * Consumed by `server/index.ts` (the `instructions` seam) and by the criteria.
 */
export function voiceRealtimeInstructionsFor(closingTurn: VoiceRealtimeClosingTurn): string {
  return [
    'You are a voice relay for one Claude Code session: you tidy up what the user says and pass it on.',
    'You are not a participant. You never answer, comment, judge or reason about what was said, and',
    'you never reply in text.',
    'EVERYTHING the user says — instructions, questions, remarks, feedback, acknowledgements,',
    'complaints, even a single word — must be passed on by calling the `session_send` function',
    'with `{ message }`, where message is what the user said, kept in their own words (fix obvious',
    'speech-recognition slips, and join the fragments of one sentence; do not paraphrase, summarise or',
    'add anything). Always call the function; never produce a text reply.',
    'There is no case in which you call no function: deciding that something does not need to be',
    'passed on is never your call. The only choice you make is HOW it is delivered, never whether.',
    'The ONE exception is a stop, or a request to correct the direction of what is running:',
    'judge for yourself whether the user wants the work that is running right now to stop —',
    'or wants it taken a different way — reading what they MEANT rather than looking for any',
    'particular word; there is no list of words to match, and what they said may not look',
    'like a stop at all. Read the WHOLE wish, not the shape of the sentence: a wish for the',
    'running work to stop, or to be taken a different way, is very often wrapped inside new',
    'words the person is adding, and those added words do NOT turn it back into an addition —',
    'they are the correction to carry, not a reason to queue behind the run. When you judge',
    'that they do want it stopped or redirected, call the `session_interrupt` function instead of `session_send`,',
    'with their words in `message` — kept exactly as you would for `session_send`, and always',
    'present, even when all they asked for was the stop — and the reason you read it that way',
    'in `intent`; their words reach the session right after the stop.',
    afterStopSentence(closingTurn),
    ...(closingTurn === 'announce'
      ? [
          'One more exception to the no-reply rule: right after you deliver a `session_send`, say ONE short sentence (in the user’s language, at most 15 words) telling them you are starting — for example “好的，我来查一下”. It reports your action only: never an answer to what they said, never their words repeated, never Claude Code’s output read back. This is the only thing you may ever say aloud; then wait for the user to speak again.',
        ]
      : []),
    'The mistake this exception exists to prevent is relaying such a wish as an ordinary',
    '`session_send`, so it sits in the queue and the running work carries on as if the person',
    'had said nothing — that answer is wrong whenever the person was asking for the running',
    'work to stop or to go somewhere else, however ordinary their words sounded.',
    'The session is fixed by the connection; never name one.',
  ].join(' ');
}

/**
 * The shipped relay instructions as they were measured: the `respond` closing turn. The text the
 * replay's arm B replays verbatim, and the rollback value of `VOICE_REALTIME_CLOSING_TURN`.
 *
 * Consumed by `server/index.ts` (diagnosis path), the settings composer and many criteria. Where the
 * closing turn is switchable the caller uses {@link voiceRealtimeInstructionsFor} instead.
 */
export const VOICE_REALTIME_INSTRUCTIONS = voiceRealtimeInstructionsFor('respond');

/**
 * How long a relayed instruction may wait for its committed segment's transcription.
 *
 * THE RACE THIS CLOSES. The endpoint reports a segment's transcript and the model relays it as two
 * independent upstream events, and nothing orders them: measured on the 2026-10-11 defect the
 * transcription preceded the `session_send` call by 273 ms, but the reverse is just as legal. A
 * guard that only looks at the transcript when the call arrives would therefore deliver an invented
 * message whenever the model answers first, so the delivery point HOLDS a call whose segment has no
 * transcription yet and releases it the moment one lands (or the segment settles).
 *
 * WHY A CEILING AT ALL. The hold must never become a deadlock: a caller that committed a segment
 * but whose endpoint never transcribes it (the offline protocol suites are exactly that case) would
 * otherwise wait forever for an event that is not coming. This is the point at which the guard
 * gives up and FAILS OPEN — an unknown transcript is not an empty one, and inventing a delay for a
 * delivery the user is waiting on is worse than relaying words nobody has proved absent. It sits
 * well under the retry/poll budgets the criteria use, so a held call still reads as delivered.
 */
export const SEGMENT_TRANSCRIPT_GRACE_MS = 600;

/**
 * Whether a relayed piece carries no words at all: empty, whitespace, or punctuation/symbols only.
 *
 * THE BOUND IS MECHANICAL, and that line is deliberate. The endpoint saying "zero words" is the one
 * fact this guard may act on; nothing here compares the relayed text with what the person said, and
 * nothing here decides whether a message is *worth* sending. A filter that started with stop words
 * would be a different mechanism with a different failure mode (`嗯`/`呃` are content: they are
 * relayed, and the negative control in the criteria holds this predicate to that).
 *
 * `\p{P}` covers `。`, `…`, `！` and the rest of the punctuation blocks; `\p{S}` covers the symbol
 * blocks, so a stray emoji-like mark is not mistaken for speech either.
 */
const EMPTY_RELAY_TEXT = /^[\s\p{P}\p{S}]*$/u;

/**
 * The form the continuous-mode duplicate guard compares two relayed messages in.
 *
 * WHY A NORMALIZATION AT ALL. The endpoint's transcript and the model's relay are independent
 * upstream events, and JSON quoting mangles one against the other: two relays of the SAME spoken
 * sentence differed only in where a quote landed — 「只有用"现在我在用live voice"」 against
 * 「只有"用现在我在用live voice"」 (journal 95a9d738). Comparing raw strings would call those
 * different and deliver the sentence twice. Collapsing whitespace, punctuation and symbols to
 * nothing — the same character classes {@link EMPTY_RELAY_TEXT} already treats as non-words — makes
 * the two forms equal while leaving the spoken words themselves untouched.
 */
export function normalizeRelayText(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Whether `next` says NOTHING the previous delivery did not already say: every character of the new
 * message appears, in order, inside the previous one.
 *
 * WHY A SUBSEQUENCE AND NOT EQUALITY (ruling 2026-10-16; live journal `cae49fed`). The continuous
 * wire's duplicate guard used to require the new text to EQUAL the last delivery or be CONTAINED in
 * it, which the model defeats the moment it restates rather than copies. Live: the relay delivered
 * "A B" (the span guard prepends a heard sentence the model's call left out), and 44 s later, with no
 * new audio, the model re-sent A — its filler words dropped ("嗯" removed), punctuation added, one
 * phrase reworded (`real time 服模型` → `realtime 模型`) — and it went through, because the rewritten
 * form is neither equal to nor contained in the delivered one. Every one of those edits is an
 * ELISION or a punctuation change, and normalization already removes the punctuation, so the
 * re-send's characters all survive in the delivered text, in order. That is the whole shape: a model
 * RETYPING a transcript it read elides, it does not invent.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH: a restatement that SUBSTITUTES words rather than eliding them
 * (journal `259b51e0`, `batch` for `bash`), which shares too little to read as the same words. That
 * class stays delivered — and it is also the class the relay must not drop on a guess, since a
 * substituted word can be the correction the person is waiting for. Leg A of this task removes the
 * exit path's unasked-for response, which is the response that produced both live instances.
 *
 * WHY THIS IS STILL A REAL TEST, not a widening that swallows everything: an ADDITION (the model
 * continuing a sentence it had already started, or relaying a second thought) puts characters in
 * `next` that are not in `previous` in that order, so it fails — which is exactly what the relay's
 * coalescing window and busy hold depend on (a tail joining an open window must be let through; see
 * `proceedRelay`'s `joiningOpenWindow`). An empty `next` never reaches here (`EMPTY_RELAY_TEXT` has
 * already answered it) and an empty `previous` has nothing to be a restatement of.
 *
 * WHY NOT A SIMILARITY THRESHOLD. A distance or overlap ratio needs a number, and the corpus does not
 * offer one: the shapes on both sides of the line (a one-character substitution, a sentence continued
 * after a pause) differ by an amount a threshold would have to be tuned to, and would then be tuned
 * per language. Subsequence needs no tuning: it is an exact predicate, and it is a strict
 * generalization of the containment test it replaces, so a relay that used to be refused still is.
 */
export function relayRestatesDelivery(next: string, previous: string): boolean {
  if (previous === '' || next.length > previous.length) {
    return false;
  }
  let matched = 0;
  for (let index = 0; index < previous.length && matched < next.length; index += 1) {
    if (previous[index] === next[matched]) {
      matched += 1;
    }
  }
  return matched === next.length;
}

/** How often a spoken instruction re-tries a session that is mid-turn. */
const BUSY_RETRY_INTERVAL_MS = 2_000;
/** How long it keeps trying before giving up and saying so. A turn longer than this is not waited out. */
const BUSY_RETRY_MAX_MS = 120_000;

/**
 * The most UTF-8 bytes of the person's as-yet-undelivered text the relay will hold before refusing
 * the next `session_send`.
 *
 * WHY A BOUND AT ALL. Measured 2026-10-11 (01:54–01:57 CST, tag `d88c6722`): the operator spoke for
 * over two minutes into a session whose turn was in flight; four deliveries were accepted, three of
 * them silently piled up in the session's own queue, and the screen showed one message. Nothing told
 * the operator that three sentences were still waiting, and nothing bounded how much could. Every
 * accepted message is a promise the session will answer it; an unbounded queue is a promise the
 * session cannot keep, and one the operator cannot see.
 *
 * WHY IT CANNOT BE A CANCELLATION. Withdrawal is a DETERMINISTIC UI act, not an admission one.
 * The provider does carry the verb — `cancelQueuedInput` is `true` for the Claude provider,
 * measured by E9 and E10/U4 (see `provider-capabilities.service.ts`) — and a person can click the
 * pending row that withdraws it. What the relay has is neither half: the model's tool surface is
 * deliberately not given withdrawal (SPEC D-2), and a relayed sentence carries no id a caller
 * could name, so the only thing that could be taken back is a row somebody is looking at. The
 * bound this guard enforces is therefore an ADMISSION decision, taken BEFORE `base.session_send`
 * is reached — which is exactly where {@link handleVoiceRealtimeConnection}'s `sessionSend` judges
 * it — rather than a withdrawal of an item the session is already holding.
 *
 * WHY BYTES, NOT MESSAGES. The bound this replaces counted MESSAGES (`VOICE_QUEUE_MAX_DELIVERIES`,
 * three). Measured 2026-10-11 (19:22–19:30 CST, session `9db75ad5`): a four-minute turn in flight,
 * and the operator's next EIGHT sentences — about 150 CJK characters, well UNDER 500 bytes together
 * — were every one refused (`VOICE_QUEUE_FULL depth=3 max=3`). The count was already spent on the
 * first three; the sentences after them were far inside any sane budget of TEXT and were still
 * thrown away. The thing a person runs out of is the patience to wait, and that is spent by how much
 * they have said, not by how many times they paused. So the admission axis is the UTF-8 byte length
 * of the text still waiting, and 1000 is a page or so of their words: enough that a real
 * mid-turn monologue is carried whole, small enough that the session is never handed a promise it
 * cannot keep.
 */
export const VOICE_QUEUE_MAX_BYTES = 1000;

/**
 * The UTF-8 byte length of a relayed message, which is the unit {@link VOICE_QUEUE_MAX_BYTES} is
 * written in. A non-string message (the model occasionally calls `session_send` without `message`)
 * counts as zero: there are no words to spend the budget on.
 */
export function voiceMessageBytes(message: unknown): number {
  return typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : 0;
}

/** The reason code a refused `session_send` carries — stable, so the model can act on it, and so the log can be read. */
export const VOICE_QUEUE_FULL_REASON = 'VOICE_QUEUE_FULL';

/**
 * The omission-fill parameters SHIPPED WITH THE SERVER, loaded ONCE at module load.
 *
 * WHY A LOAD-TIME READ RATHER THAN `import … with { type: 'json' }`. A relative `.json` specifier is
 * an internal specifier whose target is outside AC-394's `.ts`/`.tsx` scan set, so the
 * `server-import-cycle-budget` criterion counts it as unresolved — and that budget may only fall.
 * The shipping contract is unchanged: `server/tsconfig.json` lists the JSON in `include` (the same
 * way it lists the `.mjs` hook), so tsc copies it to
 * `dist-server/server/modules/voice-realtime/omission-fill-params.json`, exactly beside this
 * compiled service, and `import.meta.url` finds it in a built tree.
 *
 * Reading it HERE (module evaluation) rather than per connection is also what keeps the per-
 * connection filesystem seam in AC-402 (a) discriminating: that seam throws for any path naming
 * `omission-fill-params.json`, so a reader that went back to opening `experiments/…` on every
 * connection would be caught, while these shipped values are already in memory.
 *
 * A file that is missing, unreadable, or not a JSON object yields `null`; {@link readOmissionFillParams}
 * then reports the reason and leaves the producer OFF. Never a guessed parameter set.
 */
const OMISSION_FILL_PARAMS: { chosen?: Record<string, unknown> } | null = (() => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('./omission-fill-params.json', import.meta.url), 'utf8'),
    );
    return parsed !== null && typeof parsed === 'object' ? (parsed as { chosen?: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
})();

/**
 * Reads and validates the omission-fill parameters that ship with `server/`.
 *
 * THE PARAMETER FILE IS OWNED BY `server/` AND TRAVELS WITH THE BUILD. `omission-fill-params.json`
 * is listed in `server/tsconfig.json`'s `include`, so tsc copies it beside this compiled service: a
 * `dist-server` deployment never needs the `experiments/` tree. The earlier reader resolved the
 * application root and re-read `experiments/voice-relay-qb/omission-fill-params.json` on every
 * connection, which made a deployment's producer silently switch off when that measurement-only
 * directory was absent.
 *
 * HOT CHANGES GO THROUGH THE SETTINGS FILE. The loaded values are fixed at process start; an
 * operator changes them for the NEXT connection through `voice-realtime-settings.ts`'s optional
 * `omissionFill` key, which the caller merges over these below. A live connection keeps the values
 * it logged.
 *
 * `params: null` with a `problem` is the honest answer to an unreadable or malformed shipped block:
 * the caller records it and leaves the producer OFF. A guessed fallback would be a second source of
 * truth, and the rule's own module deliberately declares none.
 *
 * Consumers: {@link handleVoiceRealtimeConnection}, once per connection.
 */
function readOmissionFillParams(): { params: OmissionFillParams | null; problem: string | null } {
  if (OMISSION_FILL_PARAMS === null) {
    return { params: null, problem: 'unreadable omission-fill-params.json' };
  }
  const chosen = OMISSION_FILL_PARAMS.chosen;
  if (chosen === null || typeof chosen !== 'object') {
    return { params: null, problem: 'missing chosen block' };
  }
  const hMs = chosen.h_ms;
  const gMs = chosen.g_ms;
  const scoreT = chosen.score_t;
  const wMin = chosen.w_min;
  const wHallu = chosen.w_hallu;
  const domN = chosen.dom_n;
  const lookbackMs = chosen.lookback_ms;
  const silenceMs = chosen.silence_ms;
  const numeralMode = chosen.numeral_mode;
  if (
    typeof hMs !== 'number' ||
    typeof gMs !== 'number' ||
    typeof scoreT !== 'number' ||
    typeof wMin !== 'number' ||
    typeof wHallu !== 'number' ||
    typeof domN !== 'number' ||
    typeof lookbackMs !== 'number' ||
    !(typeof silenceMs === 'number' || silenceMs === null) ||
    typeof numeralMode !== 'string' ||
    !OMISSION_FILL_NUMERAL_MODES.includes(numeralMode as OmissionFillParams['numeralMode'])
  ) {
    return { params: null, problem: 'malformed chosen block' };
  }
  return {
    params: {
      hMs,
      gMs,
      scoreT,
      wMin,
      wHallu,
      domN,
      lookbackMs,
      silenceMs,
      numeralMode: numeralMode as OmissionFillParams['numeralMode'],
    },
    problem: null,
  };
}

/**
 * The most pack text one `context` frame may carry, in UTF-16 code units.
 *
 * The browser builds its pack to the SPEC's own budget (`VOICE_CONTEXT_BUDGET_CHARS` in
 * `src/modules/chat/utils/voiceContextPack.ts`) and this is that number again, on purpose: the
 * proxy does not trust the page with what reaches the upstream. A frame over the cap is refused
 * whole — not truncated — because a partial pack is a conversation with a hole in it, and a hole is
 * worse for the model than no context at all. Nothing legitimate ever sends one; the refusal exists
 * so a client that grew its own, larger budget is visible in the log instead of silently obeyed.
 */
export const VOICE_REALTIME_CONTEXT_MAX_CHARS = 2000;

// ---- S-A: the execution-status line (SPEC `voice-realtime-persistent-control-SPEC.md` §8.3) ----

/**
 * The most UTF-8 bytes ONE injected status line may take, marker included (SPEC §8.3's "注入行 ≤
 * 200 字节"). The line is built from bounded, sanitized fields, so this bound is the belt to
 * construction's braces: it holds even if a future field (a tool name, say) grows.
 */
export const VOICE_REALTIME_STATUS_MAX_BYTES = 200;

/**
 * How many status lines ONE run may put on the wire (SPEC §8.3's "总注入次数 ≤ 8 / run"). The eighth
 * is the last: it carries the `(+N more)` marker and then the run is silent until a new run begins.
 * §8.3 registers this as a SAFETY CAP, not an optimum — the per-injection cost was never measured
 * (G-5), so it may only be widened once that reading exists.
 */
export const VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN = 8;

/**
 * The S-A rate window (SPEC §8.3: "最多 1 次 / 2 s"). A change opens the window; everything that
 * changes inside it collapses to the latest reading and none is queued — so a burst of state changes
 * costs one `session.update`, not one each.
 */
export const VOICE_REALTIME_STATUS_RATE_MS = 2000;

/**
 * How often a held merged message re-reads the host's `busy` reading so the words leave the moment
 * the run does (ruling 2026-10-14; see {@link VoiceRealtimeProxySeams.busyPollMs}).
 *
 * Well under the S-A rate window on purpose: this poll decides when the person's words are DELIVERED,
 * not how often a line is drawn, and a quarter second is the point past which "Claude finished" and
 * "my sentence went in" would read as two separate events. It is armed only while something is held,
 * so its cost is bounded by the wait it is watching.
 */
export const VOICE_REALTIME_BUSY_POLL_MS = 250;

/**
 * How long the upstream must have been QUIET before a held merged message is released into the
 * running turn instead of waiting for it to end (X3' replay, 2026-10-15; see
 * {@link VoiceRealtimeProxySeams.busyQuietWindowMs}).
 *
 * `2000` is the middle of the window the replay's D arm measured: releasing on "the person stopped
 * speaking" rather than on "the run ended" moved the delivery delay's p90 from 18.5 s (A) / 10.8 s
 * (B) to 1.6 s, and the first reaction's p90 from 22.5 s / 14.0 s to 8.4 s, on the same 84 readings.
 * The number is the replay's own `lastStop + 2000`, kept rather than re-derived.
 */
export const VOICE_BUSY_QUIET_WINDOW_MS = 2000;

/**
 * The floor under the quiet window: no release lands sooner than this after the LAST held piece
 * joined the buffer, however quiet the upstream already was.
 *
 * Without it a piece relayed into an ALREADY-quiet session would leave on the very next tick, which
 * is the 1 s coalescing window's job done badly — a sentence the endpoint cut into two pieces would
 * go in as two messages. `800` is the replay's own `lastPiece + 800`.
 */
export const VOICE_BUSY_QUIET_SINCE_PIECE_MS = 800;

/**
 * The ceiling on a busy hold, counted from its FIRST piece: at this point the merged message is
 * released whether or not the person ever stopped talking.
 *
 * `20000` is the replay's own `buf[0] + 20_000`. It exists because the quiet window is only as
 * reliable as the upstream's turn reporting: an endpoint that never closes its turn (the stall the
 * 2026-10-15 00:08 reading recorded) would otherwise hold a person's words for the whole run.
 */
export const VOICE_BUSY_QUIET_CAP_MS = 20_000;

/**
 * The tier the busy quiet window's release writes its one merged message under — `next`, so the frame
 * is merged into the turn in flight at its next tool boundary instead of queueing behind it.
 *
 * THE OTHER HALF OF THE SAME MEASUREMENT. The replay's C, D and E arms shared one window and differed
 * only in priority: `now` pre-empted the turn (2/16 `error_during_execution`, both zero-output turns)
 * and `later` (the tier every other busy write uses) waited the turn out. `next` is the tier that
 * neither cuts the turn nor waits for it. Kept as a literal here rather than imported from the host
 * driver's `HostInputPriority`: the relay speaks the CLI's vocabulary on the wire, and importing the
 * provider module would drag the whole provider registry into a lean, offline-provable seam.
 */
export const VOICE_BUSY_RELEASE_PRIORITY = 'next';

/**
 * Which of the two ways a BUSY hold ended asked for the delivery. Only the quiet window's release
 * carries {@link VOICE_BUSY_RELEASE_PRIORITY}; the run ending needs no tier (there is no turn left to
 * queue behind), and the interrupt/teardown releases are the person's own stop, not this window's.
 *
 * Declared at module scope, and not exported, because it is this file's own accounting of a release:
 * the journal line is the only reader, and a criterion reads the line, not the value.
 */
type VoiceBusyRelease = 'run-end' | 'quiet-window';

/** `setTimeout`'s ceiling. A window configured "infinite" is clamped here rather than wrapping to 1 ms. */
const VOICE_MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The three session phases SPEC §6.3/§7.2 names for the execution plane.
 *
 * `awaiting-permission` is deliberately ABSENT: the proxy has no event source for a pending
 * interaction (the voice tool surface is `session_send` + `session_interrupt`), so nothing could
 * honestly report it. {@link VoiceRealtimeExecStatusReading.pendingInteraction} is the field it would
 * arrive on, and it stays `null` until the tool that can observe one lands.
 */
export type VoiceRealtimeExecPhase = 'idle' | 'queued' | 'running';

/** The pending interaction a paused session is waiting on — SPEC §8.3 keys the dedup on its `requestId`. */
export type VoiceRealtimePendingInteraction = { requestId: string; toolName: string };

/**
 * The RunDigest (SPEC §12.5's minimal mechanism): the content-level reading that lets the model tell
 * "continue / add / change / stop" apart on something other than a bare count.
 *
 * DERIVED, NEVER A SECOND COMPUTATION. Every term is folded from an execution-plane fact the proxy
 * already has — the host's `command_lifecycle` `started` set (the same one the stop fence reads),
 * the session's own queued-and-not-started depth, the in-flight tool. `covers` says how much of what
 * the person said the CURRENT run has taken up; `queuedNotStarted` says what is waiting behind it;
 * `lastCliActivity` is the tool the run is executing; `freshness` is how old this sample is.
 */
export type VoiceRealtimeRunDigest = {
  /** The person's deliveries the current run has taken up: `count` and the last one's (bounded) text. */
  covers: { count: number; last: string | null };
  /** Messages waiting but NOT yet started: `count` is `null` when the depth cannot be read (§18.5). */
  queuedNotStarted: { count: number | null; last: string | null };
  /** The run's most recent CLI activity — the tool in flight, or `null` when none is readable. */
  lastCliActivity: { tool: string | null };
  /** ms since this digest was sampled (`0` at the sample); `null` before anything was ever sampled. */
  freshness: number | null;
};

/** One digest observation folded into the aggregator. An absent term keeps its previous value. */
export type VoiceRealtimeRunDigestPatch = {
  covers?: { count: number; last: string | null };
  queuedNotStarted?: { count: number | null; last: string | null };
  lastCliActivity?: { tool: string | null };
};

/**
 * One reading of the execution plane — the SINGLE source S-A renders its line from, and the same
 * reading a future S-B (`session_status`) and S-C (the browser event stream) would read (SPEC §8.2,
 * R-8.3). Kept as one object so no consumer can compute a second, disagreeing version of it.
 */
export type VoiceRealtimeExecStatusReading = {
  phase: VoiceRealtimeExecPhase;
  runId: string | null;
  elapsedMs: number;
  queuedItems: number;
  queuedBytes: number;
  /**
   * Whether {@link queuedItems}/{@link queuedBytes} include the bound session's OWN queue.
   *
   * The relay can only see the L3 terms it owns (the coalescing window and the busy wait); the
   * messages the session itself accepted are held by the CLI, which drains them at a turn boundary
   * nothing tells the relay about. So the CLI term is reconciled against the host's own reading
   * ({@link VoiceRealtimeProxySeams.hostQueueReading}) rather than counted here, and when that
   * reading is unavailable this is `false`: the numbers above are then the L3 terms ONLY, and the
   * line says so instead of presenting them as a complete depth (SPEC §18.5: 「读不到…显式记为未知」).
   *
   * Optional and defaulting to KNOWN so a reading literal written before the field existed stays
   * valid and reads as a complete depth — the same convention {@link VoiceRealtimeExecStatusPatch}
   * uses for its absent fields. A consumer that must distinguish them reads `=== false`.
   */
  queuedKnown?: boolean;
  pendingInteraction: VoiceRealtimePendingInteraction | null;
  /**
   * The RunDigest, or `null` before one has been sampled. NOT part of the dedup key: a digest that
   * moves with nothing else changing is not a status CHANGE — it rides the next line that a real
   * change produces rather than putting one of its own on the wire (SPEC §8.3's rate byte-identity).
   */
  digest: VoiceRealtimeRunDigest | null;
  /** Monotone within a run: bumped the moment the dedup key moves. The shared provenance reading. */
  statusSeq: number;
  /** Epoch ms of the last change — the line's `at`, which `ageMs` is measured from. */
  at: number;
};

/** One observation folded into the aggregator. An absent field is left as it was. */
export type VoiceRealtimeExecStatusPatch = {
  phase?: VoiceRealtimeExecPhase;
  /** Present (possibly `null`) means "this is the run now"; a DIFFERENT non-null id opens a new run. */
  runId?: string | null;
  queuedItems?: number;
  queuedBytes?: number;
  /** Whether the queued readings carry a reconciled CLI term. See {@link VoiceRealtimeExecStatusReading.queuedKnown}. */
  queuedKnown?: boolean;
  pendingInteraction?: VoiceRealtimePendingInteraction | null;
  /** A fresh RunDigest sample. Folded into the reading without moving the dedup key (see the reading). */
  digest?: VoiceRealtimeRunDigestPatch;
};

/** The aggregator: the reading, its dedup key, and the one line rendered from them. */
export type VoiceRealtimeExecStatus = {
  /** Whether there is anything worth telling the model yet — false leaves the prompt byte-identical. */
  hasState(): boolean;
  /** The current dedup key (SPEC §8.3's tuple), or `''` before there is any state. */
  key(): string;
  /** The current reading. */
  reading(): VoiceRealtimeExecStatusReading;
  /** Folds one observation in; `changed` says the dedup key moved, `newRun` that a new run opened. */
  update(patch: VoiceRealtimeExecStatusPatch): { changed: boolean; newRun: boolean };
  /**
   * Renders the one injectable line (and the reading it came from) for `nowMs`.
   *
   * The line carries `statusSeq` — the same number on the reading — even though §8.4's example
   * shape omits it. The field is ADDITIVE (the §8.4 budget is bytes, not a field list) and it is
   * what makes §8.3's "同源" requirement checkable from the wire alone: a reader can compare the
   * line's `statusSeq` against the reading's without recomputing anything.
   */
  render(
    nowMs: number,
    marker?: { more: number },
  ): { key: string; text: string; reading: VoiceRealtimeExecStatusReading };
};

/**
 * One field of the injected line, sanitized to the alphabet the shape allows and cut to `maxChars`.
 *
 * This is the WHOLE defence against the line carrying something it must not (SPEC §8.4: never a
 * session body, a file path or the user's own words): only `[\w.:-]` survives, so a `runId` that
 * somehow held a path or a sentence comes out as an opaque token — or as `-` when nothing is left.
 */
function voiceStatusField(value: string, maxChars: number): string {
  const kept = value.replace(/[^\w.:-]+/g, '');
  return kept === '' ? '-' : kept.slice(0, maxChars);
}

/**
 * One RunDigest text field, sanitized to the alphabet the injected line allows and cut to `maxChars`.
 *
 * STRICTER THAN {@link voiceStatusField}, and for a reason the digest's own content makes concrete:
 * the `.` that field keeps is exactly what lets a filename through (`…proxy.service.ts`, which §8.4
 * forbids on the line), and a digest summary is the person's own words, so only `[\w:-]` survives
 * here. A CJK sentence, a `/path`, or anything else outside that comes out as `-` — never the words
 * themselves. The line's separate `.ts`/`/`-free assertion is the reading that holds this.
 */
function voiceDigestField(value: string, maxChars: number): string {
  const kept = value.replace(/[^\w:-]+/g, '');
  return kept === '' ? '-' : kept.slice(0, maxChars);
}

/**
 * The RunDigest tail of the status line, or `''` when there is no digest to show.
 *
 * Appended AFTER `ageMs=` so the byte cap eats the digest before it eats the staleness reading (§8.4
 * names `ageMs` the load-bearing one). Deliberately free of `/`, `\`, `.` and CJK — the count:last
 * pairs use `:` rather than `/`, which the line's `queued=<n>/<n>B` field is the only place allowed
 * to carry — so a line this renders is still within the same alphabet the rest of the line is.
 */
function renderRunDigest(digest: VoiceRealtimeRunDigest | null): string {
  if (digest === null) {
    return '';
  }
  const last = (value: string | null, max: number): string => (value === null ? '-' : voiceDigestField(value, max));
  const count = (value: number | null): string => (value === null ? '?' : String(value));
  return (
    ` cov=${digest.covers.count}:${last(digest.covers.last, 12)}` +
    ` qns=${count(digest.queuedNotStarted.count)}:${last(digest.queuedNotStarted.last, 12)}` +
    ` act=${digest.lastCliActivity.tool === null ? '-' : voiceDigestField(digest.lastCliActivity.tool, 16)}` +
    ` fresh=${digest.freshness === null ? '-' : digest.freshness}`
  );
}

/**
 * The run id a `session_send` result names, or `null` when it names none.
 *
 * Read defensively: the result is the executor's own `unknown` (a `queued: true` delivery has no run
 * at all, and the MCP gateway's shape is not this module's to police), so anything that is not a
 * non-empty string is "no run" rather than a guess. `null` is also what a NEW run is detected from —
 * a result that names the same run as last time is the same run, not a restart.
 */
function runIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const runId = (result as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId !== '' ? runId : null;
}

/**
 * Builds the per-connection execution-status aggregator (SPEC §8.2's L3 single source).
 *
 * NOT A POLLER. Every field is folded in from an event the proxy already handles, and nothing here
 * reads the clock except to stamp `at` and to measure `elapsedMs`/`ageMs` at render time — which is
 * what makes the reading a thing that CHANGES rather than a snapshot taken on a schedule.
 *
 * `now` is injectable so a criterion can drive a stale reading deterministically; production takes
 * `Date.now`.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the connection handler) and
 * `tests/voice-realtime-status-injection.test.ts`.
 */
export function createVoiceRealtimeExecStatus(now: () => number = Date.now): VoiceRealtimeExecStatus {
  let phase: VoiceRealtimeExecPhase = 'idle';
  let runId: string | null = null;
  let runStartedAt: number | null = null;
  let queuedItems = 0;
  let queuedBytes = 0;
  let queuedKnown = true;
  let pendingInteraction: VoiceRealtimePendingInteraction | null = null;
  /**
   * The last digest sample, stamped with the epoch ms it was taken. The stored value carries no
   * `freshness` of its own: it is derived from `sampledAt` at read time, so an unrefreshed sample
   * ages rather than freezing on the number it had when it was folded in.
   */
  let digest: (Omit<VoiceRealtimeRunDigest, 'freshness'> & { sampledAt: number }) | null = null;
  let statusSeq = 0;
  let at = 0;
  /** Whether a run has started or messages wait — before that there is no line at all. */
  let started = false;

  const keyOf = (): string =>
    [phase, runId ?? '-', queuedKnown ? 'k' : '?', queuedItems, queuedBytes, pendingInteraction?.requestId ?? '-'].join(
      '|',
    );
  let currentKey = keyOf();

  const reading = (): VoiceRealtimeExecStatusReading => ({
    phase,
    runId,
    elapsedMs: runStartedAt === null ? 0 : Math.max(0, now() - runStartedAt),
    queuedItems,
    queuedBytes,
    queuedKnown,
    pendingInteraction,
    digest:
      digest === null
        ? null
        : {
            covers: digest.covers,
            queuedNotStarted: digest.queuedNotStarted,
            lastCliActivity: digest.lastCliActivity,
            freshness: Math.max(0, now() - digest.sampledAt),
          },
    statusSeq,
    at,
  });

  const update = (patch: VoiceRealtimeExecStatusPatch): { changed: boolean; newRun: boolean } => {
    const before = currentKey;
    let newRun = false;
    if ('runId' in patch) {
      const next = patch.runId ?? null;
      if (next !== null && next !== runId) {
        newRun = true;
        runStartedAt = now();
      }
      runId = next;
    }
    if (patch.phase !== undefined) phase = patch.phase;
    if (patch.queuedItems !== undefined) queuedItems = Math.max(0, Math.trunc(patch.queuedItems));
    if (patch.queuedBytes !== undefined) queuedBytes = Math.max(0, Math.trunc(patch.queuedBytes));
    if (patch.queuedKnown !== undefined) queuedKnown = patch.queuedKnown;
    if ('pendingInteraction' in patch) pendingInteraction = patch.pendingInteraction ?? null;
    // The digest is folded OUTSIDE the dedup key on purpose: it carries no field `keyOf` reads, so a
    // sample that moves content-with-nothing-else is `changed: false` and arms nothing (@@SPEC §8.3).
    if (patch.digest !== undefined) {
      const prior = digest;
      digest = {
        covers: patch.digest.covers ?? prior?.covers ?? { count: 0, last: null },
        queuedNotStarted: patch.digest.queuedNotStarted ?? prior?.queuedNotStarted ?? { count: null, last: null },
        lastCliActivity: patch.digest.lastCliActivity ?? prior?.lastCliActivity ?? { tool: null },
        sampledAt: now(),
      };
    }
    if (phase !== 'idle' || runId !== null || queuedItems > 0) started = true;

    currentKey = keyOf();
    if (currentKey === before) {
      return { changed: false, newRun };
    }
    statusSeq += 1;
    at = now();
    return { changed: true, newRun };
  };

  const render = (nowMs: number, marker?: { more: number }) => {
    const current = reading();
    if (!started) {
      return { key: '', text: '', reading: current };
    }
    const pending =
      current.pendingInteraction === null
        ? '-'
        : `${voiceStatusField(current.pendingInteraction.requestId, 12)}/${voiceStatusField(
            current.pendingInteraction.toolName,
            16,
          )}`;
    // A depth with no readable CLI term is stated as unknown, not as the L3-only number it would
    // otherwise print: "queued=0/0B" while the session holds messages is the exact lie §18.5 names.
    const queueReading =
      current.queuedKnown === false
        ? 'queued=unknown'
        : `queued=${current.queuedItems}/${current.queuedBytes}B`;
    const body =
      `[exec] phase=${current.phase} run=${current.runId === null ? '-' : voiceStatusField(current.runId, 16)}` +
      ` statusSeq=${current.statusSeq} elapsed=${Math.round(current.elapsedMs / 1000)}s ${queueReading}` +
      ` pending=${pending} at=${current.at} ageMs=${Math.max(0, nowMs - current.at)}` +
      renderRunDigest(current.digest);
    // The marker is appended AFTER the cap is applied to the body, not inside it: the cap notice is
    // the last thing a run says, so it is the one thing that must survive the byte bound. Measured in
    // bytes so the two halves together are still ≤ {@link VOICE_REALTIME_STATUS_MAX_BYTES}.
    const markerText = marker === undefined ? '' : ` (+${marker.more} more)`;
    const bodyCap = VOICE_REALTIME_STATUS_MAX_BYTES - Buffer.byteLength(markerText, 'utf8');
    let text = body;
    if (Buffer.byteLength(text, 'utf8') > bodyCap) {
      text = Buffer.from(text, 'utf8').subarray(0, Math.max(0, bodyCap)).toString('utf8');
    }
    text += markerText;
    return { key: currentKey, text, reading: current };
  };

  return { hasState: () => started, key: () => currentKey, reading, update, render };
}

/**
 * One inbound browser frame, as far as this handler distinguishes them.
 *
 * Three of these are the segmented relay's (SPEC §C1): a browser-side segmenter cuts
 * the capture at pauses and numbers each piece, and the number is what makes the whole
 * path idempotent — see {@link VoiceRealtimeOutboundFrame}'s `segment_ack`.
 *
 * The fourth is the ORIGINAL continuous frame and is deliberately still spelled exactly
 * as it was: `{ type: 'audio', audio }`, with no `seq`. A capture that does not segment
 * (an older page, a microphone in the default mode) keeps the behaviour it always had,
 * and `seq` — not a mode flag — is what tells the two apart.
 */
export type VoiceRealtimeInboundFrame =
  /**
   * The segmented-relay offer (P4 / AC-322): the browser names the protocol it can speak and waits to
   * be told the server speaks it too. `protocol` is read as given — the handler answers only the token
   * it actually implements (see {@link SEGMENTED_RELAY_PROTOCOL}).
   */
  | { type: 'hello'; protocol: string }
  /** A segment opens. `startedAtMs` is the browser's own clock reading, for the log only. */
  | { type: 'segment_start'; seq: number; startedAtMs?: number }
  /**
   * One base64 PCM frame. With `seq` it belongs to that segment; without, it is the continuous path.
   *
   * `sourceRate` is the rate the CLIENT says its capture ran at — optional, and absent from the
   * shipped page, which resamples every frame to 16 kHz and names no rate on the wire. It is read for
   * the audio capture's WAV header (a client that downsamples differently must have that recorded),
   * never for the relay: what crosses to the endpoint is the same bytes with or without it.
   */
  | { type: 'audio'; audio: string; seq?: number; sourceRate?: number }
  /** A segment closes: the pause, the max length, or the end of the stream. */
  | { type: 'segment_end'; seq: number; durationMs?: number; reason?: RealtimeSegmentEndReason }
  /**
   * The C2 ContextPack (`VoiceRealtimeContextFrame` in the browser's protocol module): the part of
   * the conversation the user could see said, already rendered as text. It arrives once, right
   * behind the offer, and is what the session's instructions are composed from — see
   * `voice-realtime-settings.ts`.
   *
   * `chars`/`rows` are the browser's own accounting and are used for the log only; the text is the
   * payload, and it is re-checked against {@link VOICE_REALTIME_CONTEXT_MAX_CHARS} here rather than
   * trusted, because the cap is what bounds what reaches the upstream.
   */
  | { type: 'context'; text: string; chars: number; rows: number }
  /**
   * The browser finished playing one narration. THE NARRATOR QUEUE'S PACING SIGNAL: the queue sends
   * one `narrator_speak` at a time and waits for this ack before sending the next, so what is still
   * waiting is held on the SERVER — where a new user utterance can actually drop it. A late ack for
   * an utterance the person already interrupted is ignored (the id is the correlation, and only the
   * utterance standing now can end normally). See {@link VoiceRealtimeNarratorQueue}.
   */
  | { type: 'narrator_done'; utteranceId: string }
  /**
   * The page's answer to `run_output_request`: the output THIS run produced, rendered from the
   * page's own transcript when the request arrives. The server summarizes exactly this text and
   * keeps none of it — there is no pack to go stale. `requestId` correlates the reply with the one
   * request it answers (a late reply to a superseded run is ignored).
   */
  | { type: 'run_output'; requestId: string; text: string }
  | { type: 'close' };

/** One outbound server frame. */
export type VoiceRealtimeOutboundFrame =
  /**
   * The segmented-relay acceptance (P4 / AC-322). `protocol` repeats the token the browser offered;
   * a server frame WITHOUT this — or with another token — leaves the page on the continuous wire.
   */
  | { type: 'ready'; protocol?: string }
  | { type: 'state'; state: RealtimeBridgeState }
  /**
   * One interim-or-final transcription of the user's own audio (AC-317). Display
   * only: the browser renders it as the user's message and MUST NOT route it back
   * as model input — the model hears the audio itself. See `RealtimeCaption`.
   *
   * `seq` is the relay segment the transcript was SPOKEN in, or `null` when it belongs to no segment
   * this connection closed (an item the endpoint's own detector created). It is the transcript's OWN
   * segment, resolved from the endpoint's item id — not the segment that happened to be open when the
   * transcript arrived, which the endpoint's asynchronous transcription makes a different segment. The
   * page uses it to place the words at the segment they were spoken in; `null` is the honest answer
   * and must not be shown as a segment.
   */
  | { type: 'caption'; itemId: string; text: string; final: boolean; seq: number | null }
  /**
   * A `session_send` was ACCEPTED and is waiting in the coalescing window (AC-327). The moment the
   * model decides to deliver — `pendingParts` goes from empty to non-empty — is the real start of
   * the wait that ends at {@link sent}, and this frame is that moment made visible: the page shows
   * the person's row as "being tidied up" instead of leaving it frozen for the whole window.
   *
   * Emitted once per window, only on the coalescing path (`coalesceMs > 0`), and NOT on the replay
   * branch — a segment being replayed has already been delivered and must not open a second window.
   *
   * `depth` is how many of the person's messages are waiting at this instant: the one this frame
   * announces, anything joined into an outstanding busy wait, and everything the session's own queue
   * has accepted and not drained. It is a COUNT reading, kept beside the byte reading below so the
   * page can say both "how many" and "how much".
   *
   * `bytes` is how many UTF-8 bytes of the person's text are waiting at this instant — the same
   * three places as `depth`, measured in the unit the bound is judged in
   * (see {@link VOICE_QUEUE_MAX_BYTES}). It is what the bar shows as "待投递 N 字", the reading
   * a person needs to tell "a sentence is waiting" from "a paragraph is waiting".
   */
  | { type: 'queued'; depth: number; bytes: number }
  /**
   * A correction of the waiting depth that NO delivery announced: the turn-boundary poll
   * (`pollDrain`) saw the session's own queue move. Same `depth`/`bytes` readings as `queued`, but it
   * opens no delivery — without it the badge a `stopped` frame set stayed up until the next `sent`.
   */
  | { type: 'queue_depth'; depth: number; bytes: number }
  /**
   * The ONE message the relay is HOLDING while the session is busy, after every genuinely-queued
   * utterance has been merged into it (ruling 2026-10-14: Live Voice queues as ONE bubble).
   *
   * WHY THIS IS NOT {@link queued}. That frame announces the 1 s coalescing window — a wait measured
   * in `coalesceMs`, one per window, and the sentence it holds is about to be delivered on its own.
   * This frame is the OTHER wait: the one that lasts as long as the run in flight and whose payload
   * is the JOIN of everything said during it. The page draws one read-only card from it, and the two
   * waits are different things, so they are different frames.
   *
   * `text` is the joined text of every piece held so far — the card's whole content — and `bytes` is
   * that text's UTF-8 length, the same unit {@link VOICE_QUEUE_MAX_BYTES} is judged in. An EMPTY
   * `text` is the CLEAR: the buffer was spent (delivered, folded into an interrupt, or lost with the
   * connection), so the card comes down. Every change to the buffer that the browser should see is
   * one frame; the frame precedes the `sent` that ends the wait, so the card never lags the delivery.
   */
  | { type: 'pending'; text: string; bytes: number }
  /**
   * The bound was reached: the `session_send` this frame answers was NOT accepted and will never
   * reach the session (AC1/AC3 — the model's call is answered, the executor is not touched).
   *
   * The person's words are NOT silently dropped: nothing claims them, so their caption stays on
   * screen as an undelivered line rather than being absorbed into a delivered message. That is the
   * disposition this frame's `reason` names — `queue-full` means "kept as the caption you can still
   * read, not sent".
   *
   * `bytes` is the pending byte total this delivery would have pushed over the budget
   * (pending + this message); the page shows it so the refusal names the number it happened at.
   */
  | { type: 'refused'; reason: 'queue-full'; depth: number; bytes: number }
  /**
   * `message` is the text actually delivered to the session (after pieces were joined). The browser
   * uses it to recognise the real user message in the transcript and mark it as having come from
   * the voice transcript, instead of showing the person's words twice.
   *
   * `depth` is the waiting depth AFTER this delivery landed — the reading the page keeps between
   * `queued` frames. A send that started a run (`queued: false`) reports 0, because starting a run
   * means everything queued ahead of it had drained. `bytes` is the same reading in
   * {@link VOICE_QUEUE_MAX_BYTES}'s unit.
   */
  | {
      type: 'sent';
      sessionId: string;
      result: unknown;
      message?: string;
      depth: number;
      bytes: number;
      /**
       * The last user item the endpoint had COMMITTED when this instruction was relayed — the
       * conversation boundary the sentences in it belong to. Present whenever this connection has
       * committed any speech; absent on a connection that has heard none. See the claim step in
       * `useVoiceRealtimeSession.ts`: the browser attributes by THIS, not by the relayed text.
       */
      coveredThroughItemId?: string;
    }
  /**
   * What became of one segment the browser sent (SPEC §C1). Display/diagnosis only: the
   * page uses it to show that a segment was taken rather than silently swallowing it.
   *
   * FOUR STATES, GRADED BY WHAT THE APP ACTUALLY KNOWS — and the distinction is the whole
   * point of this frame, because the page tells the person what happened to their words:
   *
   * - `committed` — the endpoint itself accepted the segment as an utterance: this frame is
   *   sent from the endpoint's own `input_audio_buffer.committed` for the item the segment's
   *   commit created, never from the moment the commit was written. It is the only state that
   *   proves the words reached the model.
   * - `written` — the segment's audio and commit went out on a socket that died before the
   *   endpoint answered. The words MAY have arrived (a replay on the next socket may yet be
   *   answered); the page is owed exactly that uncertainty, because "delivered" would be a
   *   guess and "lost" would tell the person to repeat words the model may already have heard.
   * - `lost` — the app knows this segment will never be transcribed, and `reason` says why:
   *   `connection-closed` (its end was handled with no upstream socket at all, so nothing was
   *   ever written) or `upstream-drop` (its replay budget across reconnects is spent).
   * - `dropped` — the proxy refused the segment itself, with `reason` saying so: it never saw
   *   the segment open (`unknown-segment`), the endpoint refused its commit (`commit-refused`),
   *   or the endpoint reported no words for it (`empty-transcript`). The last two are things the
   *   ENDPOINT said about the segment; only `unknown-segment` is the proxy's own refusal.
   *
   * HOW THE STATES FOLLOW EACH OTHER, for a page that keys its display on a `seq`:
   * `committed` is FINAL — nothing follows it for that segment. `written` is not: the segment
   * may be replayed onto the next socket and answered there, so a `written` may be followed by
   * another `written` (a second socket died too) or by `committed` (it landed). `lost` and
   * `dropped` are final as well. A page must therefore not treat `written` as a settled
   * outcome — that is the intermediate state that exists precisely because the app does not
   * know yet.
   */
  | { type: 'segment_ack'; seq: number; state: 'written' | 'committed' | 'lost' | 'dropped'; reason?: string }
  /**
   * A failure. `recoverable` marks the ones that concern a single model turn (a bad
   * function call) rather than the connection: the browser reports the message but
   * keeps listening, because ending the user's session over one malformed call
   * would turn a model hiccup into a dead microphone. Absent means fatal.
   */
  | { type: 'error'; code: string; message: string; recoverable?: true }
  /**
   * One spoken turn the endpoint never answered (observed live as "我说完之后就没反应了").
   *
   * NOT an `error`. The endpoint heard the utterance, announced `speech_started` and then went
   * silent until the bridge's stall deadline passed — no fault on either side, and nothing left
   * to retry: in the continuous path the audio is already upstream and was never held, so there
   * is no replay to make. What the page was missing was not a worse message but a DESTINATION
   * for that utterance: it got its own frame, so the bar can say the turn ended unanswered
   * (instead of sitting on "Listening…", which is what the real report was about).
   *
   * `seconds` is the deadline that expired, not a measurement of the silence. The connection is
   * untouched: the next utterance is heard normally, and a later `sent` is an answer to it.
   */
  | { type: 'turn_unanswered'; seconds: number }
  /**
   * The model heard the person and chose NOT to forward their words — the continuous relay's
   * "heard, not forwarded" disposition (decision doc §12.6 B-8; §12.5's reserved slot for it).
   *
   * NOT an `error` and NOT a `turn_unanswered`. The model answering in text instead of calling a
   * tool is the "nothing to do" disposition, and here it used to be SILENT: the proxy logged it and
   * sent the browser nothing, so a person whose words never reached Claude saw a working bar with no
   * sign their utterance had been set aside — under `continuous` the bar reads the same whether the
   * model relayed or ignored what it heard. This frame is that utterance's destination: the bar says
   * it was HEARD and NOT FORWARDED, and because it is its own type the page never flashes the
   * failure state an `error` frame produces.
   *
   * CONTINUOUS ONLY. Under segmented relay a text reply is the retired wire's regression and keeps
   * its `error` frame — the segmented criteria (streaming-stages P6, the segmented replay e2e) pin
   * that reading, and this frame exists to give the CONTINUOUS path the disposition §12.5 reserved.
   *
   * No payload: the model's reply text is display-only and never shown (see the `MODEL_TEXT_REPLY`
   * case in {@link describeBridgeError}), so the disposition is the fact "heard, not forwarded" and
   * nothing about what the model said.
   */
  | { type: 'heard_not_forwarded' }
  /**
   * A spoken STOP was carried out: the run in flight was aborted and the person should be told,
   * honestly, what became of everything else.
   *
   * `aborted` is the control service's own verdict — `true` means a run was stopped, `false` means
   * there was nothing in flight to stop (the provider's `session_interrupt` reports both without
   * error; see `NO_RUN_TO_ABORT_MESSAGE`). `depth` is how many of the person's messages are STILL
   * waiting after the stop — the reading the bar turns into "已停止当前回合；已排队的 N 条仍会依次
   * 处理". A stop ends ONE run; it never cancels the messages already accepted, so `depth` is the
   * promise that survives the stop, not a count of what was thrown away.
   *
   * `runId` names the run the stop ENDED — the id the run's own activity carried at the moment of the
   * abort, read once and carried here, in the audit record and on the receipt from the SAME reading
   * (SPEC §18.5's 「哪个回合停了」). It is `null` when no run had been reported to this connection, and
   * the honest reading is then "there was nothing named to end" rather than a placeholder id.
   */
  | { type: 'stopped'; aborted: boolean; depth: number; runId: string | null }
  /**
   * The host's own account of which of the person's delivered commands its queue is STILL holding —
   * the reconcile set (2026-10-14).
   *
   * WHY A SECOND SOURCE WHEN `command_lifecycle` ALREADY EXISTS. The lifecycle rows are the page's
   * primary reading, but they travel host → writer → browser, and the defect was a break on that
   * path: the host had read the CLI's dequeue (`status injected … queued=0`, server.log 01:38:15)
   * while the voice bar's withdraw row stayed on screen. This frame is derived from the SAME host
   * reading the interrupt fence already samples ({@link HostCommandLifecycleReading}'s `started`
   * set) but is pushed to the browser on every state change, so a `queued` row whose own terminal
   * frame was lost is still cleared when the host stops reporting its command.
   *
   * `queuedMessageUuids` names only THIS connection's own deliveries the host has not yet dequeued
   * (this connection's `commandUuid → utteranceSeq` map minus the host's `started` set) — never the
   * host's whole queue breadth, which the relay cannot see. An EMPTY array is the real reading
   * "nothing of yours is still waiting" and is what clears every stale row. A host reading that is
   * absent or unreadable leaves the set UNCHANGED from the relay's perspective (every delivered
   * command still reads as waiting), which KEEPS rows rather than dropping them — the safe
   * direction, because only the host's own word may clear a row.
   */
  | { type: 'queue_reconcile'; queuedMessageUuids: string[] }
  /**
   * The narrator should start speaking this utterance — the browser's queue takes it now, and
   * answers with `narrator_done` when playback ends. TEXT layer: the page owns synthesis/playback
   * (the server's TTS leaf is wired separately), so this frame carries words, not audio.
   *
   * The narrator's output is DROPPABLE by design (see {@link VoiceRealtimeNarratorQueue}): the next
   * user utterance stops it, and a `narrator_stop` for this `utteranceId` is the only thing the page
   * needs to hear to cut playback. A `narrator_speak` for an id that already has a `narrator_stop`
   * never follows it — the queue drops what the person has moved past.
   */
  | { type: 'narrator_speak'; utteranceId: string; text: string }
  /**
   * A request for the output of the run that just ended — the run-end summary's ONLY source.
   *
   * Deliberately a REQUEST: the summary must describe one run, not a stored conversation
   * snapshot. The page renders that turn from its own transcript at request time and answers with
   * `run_output` carrying the same `requestId`; the server summarizes and discards it. Nothing is
   * cached on either side, so there is no "current pack" and no staleness to reason about — only a
   * page that may fail to answer (bounded by `outputWaitMs`).
   */
  | { type: 'run_output_request'; requestId: string }
  /**
   * Stop playing this utterance: the person spoke, and a narration is not worth talking over them.
   *
   * NOT an `error` and not a failure of the utterance — it is the duplex rule working. Nothing more
   * will arrive for this id (the queue cleared it and everything behind it), so the page can drop
   * it without waiting for a closing frame.
   */
  | { type: 'narrator_stop'; utteranceId: string; reason: VoiceRealtimeNarratorInterruptReason }
  /**
   * The narrator's synthesized audio, in the leaf's own frame contract.
   *
   * `tts_audio` frames carry base64 slices in `seq` order, `tts_done` closes the utterance with the
   * byte/duration readings the page needs, and `tts_error` is the destination of every refusal.
   * Declared as the leaf's union rather than re-spelled here: the producer and the wire cannot
   * drift, and the page's own union mirrors the same three shapes. See
   * `voice-realtime-tts.ts` for why silence is never an `ok` answer.
   */
  | VoiceRealtimeTtsFrame;

/**
 * How much of the person's text the bound session's OWN queue is still holding.
 *
 * The count and byte readings the relay reconciles its CLI term against (SPEC §18.1 F-3). The same
 * units {@link queuedDepth}/{@link queuedBytes} use, so the reading and the relay's own terms add
 * up: `items` is a message count and `bytes` is UTF-8 text length. Structurally identical to the
 * runtime gateway's `HostPendingQueuedInputs`, and declared here rather than imported so the
 * voice-realtime module keeps its lean half free of a providers-module dependency — the composition
 * root, not this leaf, is what knows both shapes and joins them.
 */
export type HostQueueReading = { items: number; bytes: number };

/**
 * The host's own `command_lifecycle` `started` reading for the bound session (SPEC §18.3, R-4.3):
 * the `commandUuid`s the CLI has DEQUEUED into a turn.
 *
 * THE ONE READING THE RELAY CANNOT DERIVE ITSELF. Which of the person's sentences the CURRENT run
 * already covers is decided by the CLI — it drains its own queue at a turn boundary nothing tells the
 * relay about — so a relay that inferred it from the message ids it sent would be guessing. SPEC
 * §18.3 R-4.3 forbids exactly that: `covers` comes from the host's `command_lifecycle` `started`
 * events, not from a message id the relay chose. The host hands over the fact here; the proxy joins
 * it with the `commandUuid → utteranceSeq` map it built from its own delivery results.
 *
 * A reader answers `null` (never `{ started: [] }`) when it cannot take the reading at all — a
 * per-run session, a host that is gone — and a caller must read that as UNKNOWN rather than empty.
 */
export type HostCommandLifecycleReading = { started: readonly string[] };

/**
 * What the bound session's run is DOING right now, as the host's own activity record reads it: the
 * name of the tool a run is currently executing, or `null` when no tool is in flight.
 *
 * WHY THE STOP NEEDS THIS AT ALL. A stop's aftermath has to say which tool the interrupted turn was
 * in the middle of and that partial changes from it may remain (SPEC §0.3 D-8, §18.5). The proxy
 * cannot derive that: its own state knows which messages it sent, never which `tool_use` the CLI
 * took up. The host's activity record does — the resident turn reduction's `phase: 'tool'` carries
 * the `tool_use` name — so the reading is pulled from there through this seam.
 *
 * `inFlightTool: null` INSIDE A READING means "the run is not inside a tool" (thinking, writing, no
 * run at all); a reader that cannot take the reading at all answers `null` FOR THE WHOLE READING.
 * Both end up as an unnamed tool at the stop, which is the honest fallback — the note then says the
 * turn was interrupted without naming a tool rather than inventing one (C-3's rule).
 *
 * `busy` IS THE SAME READING'S OTHER HALF, and optional on purpose (ruling 2026-10-14: Live Voice
 * holds ONE merged message while the session is busy). The turn phase that decides whether a tool is
 * in flight already answers "is a turn in flight at all", so a reader that has the phase reports both
 * from one sample; a reader (or a criterion) that only cares about the tool leaves it out.
 *
 * ABSENT IS NOT FALSE. `busy: false` is the host SAYING the session is idle; an ABSENT `busy` is a
 * reader that never made the claim, and the relay must then keep the behaviour it had before this
 * reading existed — the 1 s coalescing window followed by a delivery into the CLI's own queue. That
 * is what makes the single-buffer switch a property of the HOST's answer rather than of the proxy's
 * version: a bare proxy, or a deployment whose activity record cannot say, is unchanged.
 *
 * `source` NAMES WHICH READING PRODUCED `busy`, and exists so a hold's release can be audited (the
 * `busy=… source=…` suffix on the release log line). `'host-rounds'` is the resident driver's own
 * `rounds` FIFO — the authority — and `'turn-phase'` the activity store's reduced phase, which the
 * composition root keeps only for the sessions no driver hosts (see
 * {@link composeHostRunActivityReading}).
 */
export type HostRunActivityReading = {
  inFlightTool: string | null;
  busy?: boolean;
  source?: 'host-rounds' | 'turn-phase';
};

/**
 * Composes one host run-activity reading from its two halves: the host's own rounds and the activity
 * store's turn.
 *
 * THE PREFERENCE LIVES HERE, IN ONE PLACE. `roundsBusy` is the resident driver's own account of
 * whether a turn is in flight (`runInFlight`); `turn` is the process-wide activity store's snapshot
 * of the same session, `null` when it holds none. When the driver can answer — `roundsBusy` is a
 * boolean — that answer IS `busy`, and the phase is not consulted; the phase is a REDUCTION of stream
 * traffic that leaves `idle` mid-turn (a tool's execution, the gap after a `tool_result`), and
 * letting it decide is exactly the 2026-10-14 evening defect (a hold released mid-turn, the words
 * dropped into the CLI's own queue). Only when the driver cannot answer (`null` — a per-run session, a
 * host that is gone, a driver with no turn model) does the phase reading decide, which keeps every
 * non-hosted path byte-identical to before this reading existed.
 *
 * `inFlightTool` is ALWAYS the activity store's half — the rounds reading says a turn is in flight,
 * never which tool it is inside — so a `null` turn answers a tool-free reading and so does a turn
 * outside `phase: 'tool'`.
 *
 * `null` for the whole reading is returned only when NEITHER half can speak (`roundsBusy === null &&
 * turn === null`) — the honest "cannot say" the relay reads as "no claim", never as "idle". Consumed
 * by the composition root's `hostRunActivity` (`server/index.ts`), and by the criteria that drive the
 * proxy over the same composition.
 */
export function composeHostRunActivityReading(input: {
  roundsBusy: boolean | null;
  turn: { phase: string; toolName: string | null } | null;
}): HostRunActivityReading | null {
  const { roundsBusy, turn } = input;
  if (roundsBusy === null && turn === null) {
    return null;
  }
  const inFlightTool = turn !== null && turn.phase === 'tool' ? turn.toolName : null;
  if (roundsBusy !== null) {
    return { inFlightTool, busy: roundsBusy, source: 'host-rounds' };
  }
  // Only reachable with a non-null `turn`: the guard above rejected the both-`null` case.
  return { inFlightTool, busy: turn !== null && turn.phase !== 'idle', source: 'turn-phase' };
}

/** Why a model-initiated interrupt does or does not run — the two outcomes the FENCE can produce. */
export type ModelInterruptDecision = 'abort' | 'covered';

/**
 * The interrupt FENCE (SPEC §0.3 D-7 / §18.4 G2, GOAL-041 AC-343): does this model-initiated stop
 * run, or is it the debounce `covered`?
 *
 * WHY A FENCE AT ALL. The model can call `session_interrupt` for a sentence whose command the
 * CURRENT run has already dequeued into its turn — an E-2 self-answer, or a retry after the
 * `TOOL_LOOP_GUARD` — and stopping a run for an utterance it is already answering is the
 * repeat-interrupt thrash D-7 exists to forbid. Two readings rule that out, and one of them is
 * enough:
 *
 *   · COVERED — `max(coveredSeqs) >= triggerSeq`. The trigger utterance's command reached the host's
 *     `started` state, so the run already carries it (SPEC §18.3: `covers` from `command_lifecycle`
 *     `started` events, joined through the `commandUuid → utteranceSeq` map). Because `utteranceSeq`
 *     only ever grows and the model always triggers on the LATEST utterance, no earlier-starting
 *     sentence can stand in for a later one: `max(covers) >= triggerSeq` is exactly "the trigger
 *     sentence is already inside the run".
 *   · IDEMPOTENT — `abortedTriggerSeq === triggerSeq`. The SAME call repeated after it already ran is
 *     not a second stop. This is the ONLY guard a session with no lifecycle channel has, which is the
 *     documented degradation for a non-resident connection (see {@link HostCommandLifecycleReading}).
 *
 * `triggerSeq === null` means no non-empty utterance has been heard, so there is no sentence to
 * fence on and the path is exactly the pre-fence one — a bare stop still aborts.
 *
 * Exported and pure so a criterion can drive the fence's own decision directly, including the false
 * form that must redden: with BOTH guards neutralized (`coveredSeqs` empty, `abortedTriggerSeq`
 * null) the same input decides `abort` every time — two aborts for the one sentence, which is what
 * removing the fence would do (SPEC §18.7 F3).
 */
export function decideModelInterrupt(input: {
  triggerSeq: number | null;
  coveredSeqs: ReadonlySet<number>;
  abortedTriggerSeq: number | null;
}): ModelInterruptDecision {
  if (input.triggerSeq === null) {
    return 'abort';
  }
  if (input.abortedTriggerSeq === input.triggerSeq) {
    return 'covered';
  }
  let maxCovered: number | null = null;
  for (const seq of input.coveredSeqs) {
    if (maxCovered === null || seq > maxCovered) {
      maxCovered = seq;
    }
  }
  if (maxCovered !== null && maxCovered >= input.triggerSeq) {
    return 'covered';
  }
  return 'abort';
}

/**
 * The fixed sentence prepended to the FIRST message that enters the CLI after an interrupt (SPEC §0.3
 * D-8, §18.5; GOAL-041 AC-344).
 *
 * WHY THE MODEL HAS TO BE TOLD. An interrupt ends the run, not its side effects: a `Bash` call that
 * wrote a file or started a background listener is NOT undone by the abort (the 2026-10-12 transcript
 * `c6493eb6` ran `nohup … & disown` and the process outlived the turn). Without a word about it the
 * next turn answers as if the previous one had simply ended, and the model re-runs or contradicts
 * work that is half-done. One sentence, carried by the proxy itself, is what makes the next turn
 * honest — the model is told what stopped, what tool it stopped in, and that the words that follow
 * are the current instruction.
 *
 * TWO FORMS, ONE RULE. With a tool name the sentence names it (`inFlightTool` read from the host's
 * activity record at the stop); with no readable tool it says only that the turn was interrupted and
 * that partial changes may remain — it never invents a tool. The unreadable case is the whole of
 * AC-344's fourth reading, and `null` there is a reading rather than a gap (C-3).
 *
 * WHAT THE SENTENCE MUST NOT SAY. SPEC §11.4 forbids the interruption path from claiming it undid
 * anything: no `revert` / `rollback` / `undo`，no 「撤销」/「回滚」. The words are "may still be
 * present" because that is exactly what the proxy knows — it never inspected the changed state, so
 * it cannot say the changes exist, only that the tool was mid-flight when it was cut off. A criterion
 * asserts the absence of those words on the text that actually entered the CLI.
 */
export function buildInterruptAftermathNote(inFlightTool: string | null): string {
  const head =
    inFlightTool === null
      ? 'The previous turn was interrupted before it finished.'
      : `The previous turn was interrupted while it was running the \`${inFlightTool}\` tool.`;
  // The partial-change sentence follows the SAME split: with no readable tool it must not refer to
  // "that tool", or the tool-free form would point at a tool it never named.
  const partial =
    inFlightTool === null
      ? 'Any partial changes the interrupted turn had already made may still be present.'
      : 'Any partial changes that tool had already made may still be present.';
  return (
    `[${head} ${partial} ` +
    'Everything after this note is your current instruction and takes precedence over any ' +
    'conflicting thing said earlier.]'
  );
}

// ---- the narrator's playback queue: the droppable layer ------------------------------------------
//
// WHAT THIS IS. Voice output on a Live Voice connection belongs to the NARRATOR — a bypass producer
// (run-end summary now, TTS next) that says short sentences so an eyes-off person keeps the
// confidence that the system heard them. It is NOT the relay model's reply and NOT the person's
// conversation: nothing it says is information they must be able to recall, so every narration is
// DROPPABLE.
//
// WHY THE PERSON SPEAKING CLEARS IT. Duplex conversation advances when they talk. A narration that
// keeps playing after their first word competes with them; one replayed after they have moved on is
// a stale summary of work they already left. So the rule is one line — a new user utterance stops
// the current narration and clears everything queued behind it. Not paused-and-resumed: dropped.
// Interrupting is conversation, not an error, and nothing here reports one.
//
// WHY THE QUEUE IS PACED. One narration is sent at a time and the next waits for the browser's
// `narrator_done`. If every item went out immediately, "clearing the queue" could not stop a
// narration the page already held — which is exactly the behaviour this layer exists to prevent.
//
// PRESENCE IS THE SWITCH, like every other narrator seam here: a connection wired without
// {@link VoiceRealtimeProxySeams.narrator} creates no queue and takes no hook, so every criterion
// written before this feature keeps its exact wire.

/** Why a narration was stopped. One value today, named rather than implied so the wire can grow. */
export type VoiceRealtimeNarratorInterruptReason = 'user-spoke';

/** One narration the narrator wants this connection to speak, with the id the page correlates on. */
export type VoiceRealtimeNarration = { utteranceId: string; text: string };

/** What the narrator queue holds right now. Read by the journal and by the AC-406 criterion. */
export type VoiceRealtimeNarratorReading = {
  /** The id of the utterance being played, or `null` when nothing is playing. */
  current: string | null;
  /** How many narrations are waiting behind it. */
  queued: number;
  /** How many narrations this connection has dropped because the person spoke (monotonic). */
  dropped: number;
};

/** One connection's narrator queue. See the block comment above for the contract. */
export type VoiceRealtimeNarratorQueue = {
  /** Queue one narration; if nothing is playing it starts at once. No-op after {@link close}. */
  enqueue(narration: VoiceRealtimeNarration): void;
  /** The page finished `utteranceId`; advance to the next. A stale id is ignored. */
  completed(utteranceId: string): void;
  /** The person spoke: stop the current narration and DROP everything queued. Returns how many. */
  interrupt(reason: VoiceRealtimeNarratorInterruptReason): number;
  /** What the queue holds right now. */
  reading(): VoiceRealtimeNarratorReading;
  /** The connection is gone: drop everything, send nothing. */
  close(): void;
};

/**
 * Builds the queue over this connection's browser downlink.
 *
 * The downlink is injected rather than reached for, for the same reason every other leaf here takes
 * one: the criterion hands it a recorder, and the handler hands it its own `send`.
 */
export function createVoiceRealtimeNarratorQueue(input: {
  send: (frame: VoiceRealtimeOutboundFrame) => void;
  log?: (line: string) => void;
  /**
   * The TTS seam this connection's narrator speaks through, or absent for the text-only wire.
   *
   * ABSENCE IS THE PRE-TTS BEHAVIOUR, and every criterion written before the downlink existed uses
   * it: the queue emits `narrator_speak` and waits for the page's `narrator_done` exactly as before.
   * With a seam, the same `pump()` that emitted the text also synthesizes it and streams the audio
   * to the same page; the pacing ack still comes from the page, after playback.
   */
  tts?: VoiceRealtimeNarratorTtsSeam;
}): VoiceRealtimeNarratorQueue {
  /** The narration the page holds now, or `null`. Only one at a time — see the pacing note. */
  let current: VoiceRealtimeNarration | null = null;
  /** Narrations the page has NOT been sent. This is what an interrupt can still drop. */
  const pending: VoiceRealtimeNarration[] = [];
  let dropped = 0;
  let closed = false;

  /** Sends the next narration when the page is free. The ONLY place `narrator_speak` is emitted. */
  const pump = (): void => {
    if (closed || current !== null || pending.length === 0) return;
    const next = pending.shift() as VoiceRealtimeNarration;
    current = next;
    // The TEXT frame goes first even when audio follows: it is the sentence the page can display,
    // and it is the fallback a page without TTS playback can still honour. The audio frames are
    // ordered BEHIND it on the same socket, so a page that receives either has the correlation id.
    input.send({ type: 'narrator_speak', utteranceId: next.utteranceId, text: next.text });
    input.log?.(`narrator speak ${next.utteranceId} chars=${next.text.length} queued=${pending.length}`);

    const tts = input.tts;
    if (tts === undefined) return;
    // The downlink is guarded rather than trusted: an utterance the person has already cleared
    // (`interrupt` sets `current` to null) must not receive late audio AFTER its `narrator_stop`,
    // and a closed connection has no page to send to. The synth call itself is not cancellable
    // (the leaf's timeout is its bound); dropping the output is what makes the cut immediate.
    void tts
      .speak({ utteranceId: next.utteranceId, text: next.text }, (frame) => {
        if (closed || current === null || current.utteranceId !== next.utteranceId) return;
        input.send(frame);
      })
      .then((result) => {
        if (result.ok) {
          input.log?.(
            `narrator tts done ${next.utteranceId} frames=${result.frames} bytes=${result.bytes} ` +
              `durationMs=${result.durationMs === null ? '-' : Math.round(result.durationMs)}`,
          );
        }
        // A failure already reached the page as a `tts_error` frame (the leaf emits exactly one);
        // the log line is the server-side reading of the same refusal. The queue stays paced: the
        // page answers `narrator_done` on the error frame, so the next narration is still advanced.
        else {
          input.log?.(
            `narrator tts failed ${next.utteranceId} code=${result.code} upstream=${result.upstreamCode ?? '-'}`,
          );
        }
      })
      .catch((error: unknown) => {
        input.log?.(
          `narrator tts threw ${next.utteranceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  return {
    enqueue(narration: VoiceRealtimeNarration): void {
      if (closed) return;
      pending.push(narration);
      pump();
    },
    completed(utteranceId: string): void {
      // Only the utterance STANDING NOW can end normally. A done for one the person already
      // interrupted (a frame the page sent before it processed the stop) must not advance the
      // cleared queue — it is the stale ack the drop exists to make harmless.
      if (closed || current === null || current.utteranceId !== utteranceId) return;
      current = null;
      pump();
    },
    interrupt(reason: VoiceRealtimeNarratorInterruptReason): number {
      if (closed) return 0;
      const droppedNow = (current === null ? 0 : 1) + pending.length;
      if (current !== null) {
        input.send({ type: 'narrator_stop', utteranceId: current.utteranceId, reason });
      }
      current = null;
      pending.length = 0;
      dropped += droppedNow;
      // One INFO line, never an error: this is the duplex rule working, and a journal that calls it
      // a failure would send an operator looking for a fault that does not exist.
      if (droppedNow > 0) {
        input.log?.(`narrator cleared reason=${reason} dropped=${droppedNow}`);
      }
      return droppedNow;
    },
    reading(): VoiceRealtimeNarratorReading {
      return { current: current === null ? null : current.utteranceId, queued: pending.length, dropped };
    },
    close(): void {
      closed = true;
      current = null;
      pending.length = 0;
    },
  };
}

/**
 * The narrator's speech synthesis, as the proxy sees it.
 *
 * The proxy owns WHEN an utterance starts and the queue's pacing; the composition root owns the
 * credential, the voice and the endpoint the TTS leaf dials. This seam is that boundary: the proxy
 * hands over the utterance and a downlink, and the leaf decides every frame that reaches the page.
 *
 * `speak` MUST emit either audio frames or exactly one `tts_error` — never neither (see
 * `voice-realtime-tts.ts`). The proxy never inspects the result to decide whether to send a frame;
 * the downlink is the only channel, so a fake implementation in a criterion sees exactly what the
 * browser would. Consumed by `createVoiceRealtimeNarratorQueue` and built in `server/index.ts`.
 */
export type VoiceRealtimeNarratorTtsSeam = {
  speak(
    input: VoiceRealtimeTtsInput,
    downlink: (frame: VoiceRealtimeTtsFrame) => void,
  ): Promise<VoiceRealtimeTtsResult>;
};

/**
 * The narrator seam: this connection's queue handoff and the duplex rule's switch.
 *
 * LEFT UNSET BY EVERY CALLER WITH NO NARRATOR, and absence is byte-neutral: no queue is built, no
 * hook fires, and the wire is exactly what it was before this feature existed.
 */
export type VoiceRealtimeNarratorSeams = {
  /**
   * Receives the connection's narrator queue once the browser downlink exists. The composition
   * root's narrator producers (the run-end summary, the TTS wiring) enqueue through it; the queue
   * owns order, pacing and the interrupt rule.
   */
  attach?: (queue: VoiceRealtimeNarratorQueue) => void;
  /**
   * Whether a new user utterance stops the current narration and clears the queue.
   *
   * OMITTED MEANS ENABLED — the shipped duplex rule, so the mechanism is on without a
   * composition-root change. `false` is the FALSE FORM the AC-406 criterion builds: narration plays
   * and queues through the person's speech, which is what reddens "去掉新语音清空队列的钩子必红".
   */
  interruptOnUserSpeech?: boolean;
  /**
   * Whether a LOCAL speech boundary (`voice-realtime-local-speech.ts`) may also stop the narrator.
   *
   * OMITTED MEANS NO — and no is the shipped rule since the 2026-10-19 live capture: the local gate
   * is deliberately coarse (its own header: "not a VAD and must not become one"), and on that
   * connection its `started` boundary opened five times on ambient noise (RMS 300–470, against
   * speech at 1000–10000). Each one called `interrupt('user-spoke')` while a narration was playing,
   * so `narrator_stop` reached the page before `tts_done` and the whole announcement was cleared
   * before it could be heard — the person heard none of the five.
   *
   * The narrator is interrupted by the two PRECISE readings only: the endpoint's own
   * `speech_started` and the browser's `segment_start`. `true` restores the old wiring and is the
   * false-form switch the local-gate criterion uses to prove the removed line is load-bearing.
   */
  narratorInterruptsOnLocalSpeech?: boolean;
  /**
   * This connection's speech synthesis, or absent for the text-only wire.
   *
   * OMITTED IS THE PRE-TTS CONTRACT: the queue emits text and the page's own ack advances it. A
   * composition root that owns a TTS leaf passes this, and the queue's `pump()` then also sends the
   * leaf's `tts_audio`/`tts_done`/`tts_error` frames. See {@link VoiceRealtimeNarratorTtsSeam}.
   */
  tts?: VoiceRealtimeNarratorTtsSeam;
};

/**
 * The uplink VAD seam: one connection's classifier, plus the two numbers the gate derives from.
 *
 * PRESENCE IS THE SWITCH, like {@link VoiceRealtimeProxySeams.silenceTail} — the deployment turns the
 * uplink VAD on by passing this, and a connection wired without it takes the same `=== null` fast path
 * the relay took before the feature existed (AC1/AC2). This round ships NO production caller: the seam
 * exists, `uplinkVad === undefined` is the shipped state, and the criterion is what fires it.
 *
 * THE CLASSIFIER BELONGS TO THE CONNECTION. All three backends carry per-stream state (see
 * `voice-realtime-uplink-vad.ts`), so a caller builds a FRESH classifier per connection and hands it
 * over here; the connection then owns it and releases it at teardown. A classifier shared between two
 * connections would attribute one stream's verdicts to the other's audio.
 */
export type UplinkVadSeam = {
  /** The per-stream classifier (see the ownership note above). */
  classifier: UplinkVadClassifier;
  /**
   * The RESOLVED `turn_detection.silence_duration_ms` the head-keep window `a` derives from.
   *
   * OMITTED MEANS "READ THE ENVIRONMENT" — the proxy then resolves it through
   * `voice-realtime-turn-detection.ts`, the single source, exactly as the transport's own default is
   * resolved. A caller that already holds the resolved value (the diagnosis route's per-run override)
   * passes it so the window follows THAT, not the deployment default.
   */
  silenceDurationMs?: number;
  /**
   * The bound on the exit path's wait for the endpoint's `committed` + transcription before the socket
   * closes (§6.3). Optional; a criterion shrinks it so the wait is observable in milliseconds.
   */
  exitWaitMs?: number;
};

/**
 * The default bound on the uplink VAD's exit-path wait (§6.3): how long the connection lets the
 * endpoint commit, transcribe and (ideally) relay the last utterance before the socket goes.
 *
 * A WAIT, not a sleep: the exit resolves the moment BOTH the `committed` and the final transcription
 * have arrived and only times out when they do not (an exit with nothing said times out, which is the
 * benign branch §6.4 describes). 1.5 s bounds how long a person waits for the session to close.
 */
export const UPLINK_VAD_EXIT_WAIT_MS = 1_500;

// ---- the narrator's run-end summary (TEXT layer only) -------------------------------------------
//
// WHAT THIS IS. When a run ends, the narrator — a SIDE text model, never the realtime relay — is
// asked for one short spoken summary of the run's latest output. The relay stays the "pen": it
// forwards words and reports what happened, and this file only decides WHEN to ask and carries the
// answer to the narrator's own text queue. TTS is a later task; here the loop closes at text.
//
// THE TRANSITION ALSO SPEAKS A FIXED ACK (2026-10-20). The side model takes 0.6–1 s (previously
// 6–12 s), but the gap between the run ending and the first sound was still a silent 8–13 s in the
// live wire. So the SAME transition first enqueues one deployment-chosen confirmation
// (`VOICE_REALTIME_RUN_END_ACK`), and only then arms the settle wait for the summary. The ack is
// independent of the pack, the model answer and the quality gate — see `VoiceRealtimeRunEndAckSeam`.
//
// WHY THE SETTLE WAIT IS LOAD-BEARING. The context pack the browser built may lag the run's last
// output by the time the run ends. Asking the summarizer at the transition itself would summarize
// the PREVIOUS state of the work — the exact timing failure this mechanism has to survive. So the
// summarizer is asked `settleMs` after the transition and reads the context pack THAT MOMENT, not
// the one the transition saw.
//
// WHY THE HOST IS POLLED. The relay is never told a run ended (see `busyPollMs`): the host's own
// activity record is a PULL reading. The watcher below samples `hostRunActivity` while the status
// says a run is live and treats only an explicit `busy: false` as the end — an unreadable host
// (`null`) keeps waiting rather than inventing an end.

/** How long after a run ends the summarizer is asked, so the last output has landed in the context pack. */
export const DEFAULT_RUN_END_SUMMARY_SETTLE_MS = 400;

/**
 * How long the run-end summary waits for the page's `run_output` reply.
 *
 * The summary source is the RUN'S OWN OUTPUT, fetched on demand: the server sends
 * `run_output_request` and the page renders that turn from its transcript. Nothing is cached, so
 * there is no staleness to reason about; the only failure left is a page that does not answer.
 * Two seconds covers a busy render without making the driver wait on a dead socket.
 */
export const DEFAULT_RUN_OUTPUT_WAIT_MS = 2_000;

/** How often the host's run-activity reading is sampled while a run is believed live. */
export const DEFAULT_RUN_END_SUMMARY_POLL_MS = 250;

/**
 * The most characters the summary's longest shared SUFFIX with the source may carry.
 *
 * The B-1 probe's `verbatimTail` reading: a summary whose tail is the output's own tail is reading
 * the output back instead of summarizing it. A few characters of overlap (punctuation, a common
 * ending) are not that, so the bound is small but not zero.
 */
export const RUN_END_SUMMARY_MAX_VERBATIM_TAIL = 6;

/**
 * The three mechanical quality readings `experiments/voice-realtime-announce-summary/summarize.mts`
 * pinned, kept here so the gate and the experiment judge a summary the same way.
 *
 * `chars` is the summary's length (LOGGED, not gated since 2026-10-20 — `qwen-flash` answers run
 * 42–44 chars), `markdown` the glyphs a voice cannot pronounce (`# * \` | -`, each recorded once),
 * and `verbatimTail` the longest suffix the summary shares with the source.
 *
 * Consumers: the proxy's run-end gate (it refuses Markdown and a read-back tail) and
 * `tests/voice-realtime-run-end-summary.test.ts` (it re-reads the injected text with the same
 * function, so the criterion cannot pass on a different idea of "short" or "verbatim").
 */
export type VoiceRealtimeSummaryQuality = {
  chars: number;
  markdown: string[];
  verbatimTail: number;
};

/**
 * Reads one summary's mechanical quality against the source it summarizes.
 *
 * The readings are the experiment's, copied deliberately: `verbatimTail` walks the shared suffix
 * outward until it stops matching, and `markdown` records each forbidden glyph once. Pure and
 * total — an empty source answers `verbatimTail: 0`.
 */
export function readVoiceRealtimeSummaryQuality(
  summary: string,
  source: string,
): VoiceRealtimeSummaryQuality {
  const markdown: string[] = [];
  for (const ch of summary) {
    if ('#*`|'.includes(ch) || (ch === '-' && !markdown.includes('-'))) markdown.push(ch);
  }
  let verbatimTail = 0;
  for (let n = 1; n <= Math.min(summary.length, source.length); n++) {
    if (summary.slice(-n) === source.slice(-n)) verbatimTail = n;
    else break;
  }
  return { chars: summary.length, markdown, verbatimTail };
}

/**
 * The narrator's run-end summary, as the proxy sees it: a side text model, the queue its text is
 * injected into, and the two timings a criterion shrinks.
 *
 * `summarize` is ASYNC and OUTSIDE this module on purpose — the relay must not become the
 * summarizer (the B-1 decision). `inject` is the text-layer boundary: the narrator's own queue (and,
 * in a later task, its TTS) consumes it. Called EXACTLY once per run end, and only for a summary that
 * passes {@link readVoiceRealtimeSummaryQuality}.
 */
export type VoiceRealtimeRunEndSummarySeams = {
  /** Ask the bypass text model for one spoken summary of the run's OWN output. */
  summarize(input: { output: string; runId: string | null }): Promise<string | null>;
  /** Inject the accepted summary text into the narrator's queue. */
  inject(text: string, meta: { runId: string | null }): void;
  /** The settle wait; see {@link DEFAULT_RUN_END_SUMMARY_SETTLE_MS}. */
  settleMs?: number;
  /**
   * How long to wait for the page's `run_output` reply; see
   * {@link DEFAULT_RUN_OUTPUT_WAIT_MS}.
   */
  outputWaitMs?: number;
  /** The host poll cadence; see {@link DEFAULT_RUN_END_SUMMARY_POLL_MS}. */
  pollMs?: number;
  /** Overrides {@link RUN_END_SUMMARY_MAX_VERBATIM_TAIL} (a criterion may tighten it). */
  verbatimTailMax?: number;
};

/**
 * The run-end confirmation, as the proxy sees it: one fixed sentence, spoken at the transition.
 *
 * INDEPENDENT OF THE SUMMARY SEAM ON PURPOSE. The ack answers "the run ended, I am still here" and
 * must not wait for — or depend on — a context pack, a side model answer, or a summary that passes
 * the quality gate. The proxy calls `speak` exactly once per `running → idle` transition, BEFORE
 * the settle timer is armed; the composition root's narrator wiring owns candidate selection and
 * the `run-end-ack-N` id family. Absent means the pre-ack wire, byte for byte.
 */
export type VoiceRealtimeRunEndAckSeam = {
  /** Enqueue one confirmation now, with the run it belongs to. */
  speak(meta: { runId: string | null }): void;
};

/**
 * What the handler needs from the composition root, all injected.
 *
 * Functions rather than values because both halves are per-connection: the
 * transport carries the upstream socket, and the executor carries the
 * `boundSessionId` whitelist. A closed gate or a missing upstream credential is
 * therefore reported per connection, where the browser can see it, rather than
 * aborting the whole server at boot.
 */
export type VoiceRealtimeProxySeams = {
  /**
   * Builds a fresh upstream transport for one browser connection.
   *
   * `reportError` is the transport's own error channel (a rejected function call,
   * a malformed upstream frame, …). A transport that is handed no `onError` drops
   * those silently, which is how a rejected `session_send` once read as "Listening…"
   * forever; pass it straight through as the transport's `onError`.
   *
   * `settingsTurnDetection` is THIS connection's settings-file reading, VALIDATED by the
   * loader (the fields the file named, or `{}` when it named none). It travels through the
   * seam because only the proxy reads the file, while only the composition root builds the
   * transport: without it the file's `silence_duration_ms` reached the local uplink gate and
   * the log line but never the `session.update`, which kept the shipped 800 ms (live,
   * 2026-10-20 — "the log says 1500, the wire says 800"). The builder resolves it with the
   * SAME precedence as every other reader (override > environment > file > shipped default).
   */
  createTransport(
    reportError: (error: { code: string } & Record<string, unknown>) => void,
    settingsTurnDetection?: TurnDetectionValues,
  ): RealtimeTransport;
  /** Builds the live executor whose `session_send` is whitelisted to `boundSessionId`. */
  createExecutor(input: { boundSessionId: string }): RealtimeToolExecutor;
  /** The session instructions sent upstream once connected, and the base of the defaults a settings file overrides. */
  instructions: string;
  /**
   * Whether the model is asked to speak again after a delivered `session_send`. Selects the wording
   * of the tool results the model reads — `silent` asks for nothing, `respond` asks for "OK" — and
   * must agree with the transport's declared `respondToToolOutputs` intent and with `instructions`
   * (see {@link voiceRealtimeInstructionsFor}); the composition root resolves all three from one
   * value. The transport always resumes the turn; this seam decides only whether the model is asked
   * to say anything on that resumed turn.
   * Optional: absent is {@link DEFAULT_VOICE_REALTIME_CLOSING_TURN}, never the environment.
   */
  closingTurn?: VoiceRealtimeClosingTurn;
  /**
   * Whether the voice plane advertises `session_send` with `message` alone. Optional: absent is
   * {@link DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL}, never the environment.
   */
  slimSendTool?: boolean;
  /**
   * The settings file to read for this connection, overriding {@link VOICE_REALTIME_SETTINGS_ENV}.
   * A criterion points it at a file it owns; a deployment sets the environment variable instead.
   */
  settingsPath?: string;
  /**
   * How a spoken instruction waits for a session that is mid-turn. Optional: the defaults
   * ({@link BUSY_RETRY_INTERVAL_MS}, {@link BUSY_RETRY_MAX_MS}) are what ships; a criterion
   * shrinks them so the wait is observable in milliseconds.
   */
  busyRetry?: { intervalMs: number; maxMs: number };
  /**
   * How many UTF-8 bytes of the person's as-yet-undelivered text may be waiting before the relay
   * refuses the next message (see {@link VOICE_QUEUE_MAX_BYTES}). Optional: the constant is what
   * ships, and a criterion shrinks it to reach the bound in a couple of calls.
   */
  maxQueuedVoiceBytes?: number;
  /**
   * The S-A rate window (SPEC §8.3: at most one status line per 2 s, a window's changes collapsing to
   * the latest). Optional: {@link VOICE_REALTIME_STATUS_RATE_MS} is what ships, and a criterion shrinks
   * it so the collapse is observable in milliseconds rather than in seconds.
   */
  statusRateMs?: number;
  /**
   * How often the browser socket is pinged, in ms; `0` disables it. Optional: 25 s ships, under the
   * idle limits common reverse proxies apply to a WebSocket that a muted microphone leaves silent.
   */
  browserKeepaliveMs?: number;
  /**
   * Receives the aggregator reading behind each status line that goes upstream — the provenance
   * reading SPEC §8.2 wants shared between S-A and the future S-B/S-C. A criterion reads it to prove
   * the line and the reading are ONE source (`statusSeq` included), not two computations of the same
   * thing. Never the line's text: this is the reading, not the wire.
   */
  onExecStatus?: (reading: VoiceRealtimeExecStatusReading) => void;
  /**
   * Receives one plain line per event worth knowing about on the BROWSER side of the
   * connection — what was sent to the page, and how long a spoken instruction took to
   * deliver. `server/index.ts` writes it to the server log: the upstream log alone
   * cannot say whether the page was ever told.
   */
  log?: (line: string) => void;
  /** Overrides the bridge's stall threshold (ms). Production leaves it unset; a criterion shrinks it. */
  stallMs?: number;
  /**
   * How long speech must be quiet before what the model relayed is delivered as ONE message.
   * The server VAD cuts a sentence at every pause and the model relays each piece, so without this
   * one thought reached Claude as four or five fragments ("这个逻辑不要放在前。" / "端。" / "放到 server。"
   * / "那边去。" — measured on three clips: 13 messages). Unset or 0 delivers every call at once.
   */
  coalesceMs?: number;
  /**
   * How often the relay re-reads {@link HostRunActivityReading.busy} while it is HOLDING a merged
   * message, so the words reach the session the moment the run ends (ruling 2026-10-14).
   *
   * A BOUNDED POLL, for the same reason {@link hostQueueTurnBoundaryRefresh} is one: the host's own
   * activity record is a PULL reading and the relay is never told a run ended, so "Claude is idle
   * now, deliver" has to be observed. It is armed only while a merged message is actually held, it
   * costs one reading per tick, and it is dropped the instant the buffer is spent or the connection
   * closes — so a connection that never holds anything never polls.
   *
   * Optional: {@link VOICE_REALTIME_BUSY_POLL_MS} is what ships, and a criterion shrinks it so a run
   * ending is observed in milliseconds rather than in seconds.
   */
  busyPollMs?: number;
  /**
   * How long the upstream must be quiet before a held merged message is released into the RUNNING
   * turn (X3' replay, 2026-10-15). The hold no longer waits for the turn to end: once the endpoint's
   * own turn has closed and this much time has passed with nothing more said, the merged message goes
   * in — under `next`, so the turn in flight picks it up at its next tool boundary rather than
   * finishing without having heard it.
   *
   * Optional: {@link VOICE_BUSY_QUIET_WINDOW_MS} is what ships. Setting the window AND the cap to
   * zero (or a non-positive number) restores the ruling this replaces — the hold releases only when
   * the run ends, which is what `pollBusy` alone did. A criterion shrinks both so a release is
   * observable in milliseconds.
   */
  busyQuietWindowMs?: number;
  /**
   * The floor under {@link busyQuietWindowMs}: how long after the LAST held piece joined the buffer
   * the earliest possible release may land. See {@link VOICE_BUSY_QUIET_SINCE_PIECE_MS}.
   */
  busyQuietSincePieceMs?: number;
  /**
   * The ceiling on a busy hold, counted from its first piece — released at this point whatever the
   * upstream says. See {@link VOICE_BUSY_QUIET_CAP_MS}.
   */
  busyQuietCapMs?: number;
  /**
   * How long one relayed instruction may wait for its committed segment's transcription to come back
   * before it stops being held and is delivered anyway. See {@link SEGMENT_TRANSCRIPT_GRACE_MS}.
   */
  transcriptGraceMs?: number;
  /**
   * How the segmented path closes a segment upstream: `manual` (the endpoint's own VAD
   * off, one `commit` + `response.create` per `segment_end`) or `server-vad` (the
   * fallback the SPEC names, where real silence between segments is what the endpoint's
   * detector reads). A criterion sets it directly; a deployment sets
   * {@link VOICE_REALTIME_SEGMENT_COMMIT_ENV} instead (see {@link resolveSegmentSelection}).
   * Left unset by both, the segmented path still runs — the browser's own frames are what
   * select it — with the adopted protocol (`manual`).
   */
  segmentCommit?: RealtimeSegmentCommitMode;
  /** Fallback mode only: the ceiling on the real silence that closes a segment. See the bridge. */
  commitGapMs?: number;
  /**
   * The C3 upstream session pool (SPEC §C3). When set, this connection runs over one active
   * session plus a pre-warmed standby and switches to the standby after `idleRotateMs` idle;
   * when omitted it is exactly one session, as before. The pool IS a `RealtimeBridge`, so the
   * connection below cannot tell the difference — which is the point: the rotation is a
   * property of the transport, not of the protocol the page speaks.
   *
   * `onRotate` is how the DIAGNOSIS report gets its `rotations[]`: the pool itself is built
   * here, so the readings are handed out as they happen rather than reconstructed afterwards.
   */
  upstreamPool?: { idleRotateMs: number; onRotate?: (rotation: UpstreamPoolRotation) => void };
  /**
   * Whether this connection answers a matching `hello` with `ready{protocol:'segmented-v1'}` — the
   * P4 rollout switch (AC-322).
   *
   * LEFT UNSET BY EVERY CALLER THAT HAS NO OPINION, and that is deliberate: unset means "resolve from
   * {@link VOICE_REALTIME_MODE_ENV} with the same pure resolver `server/index.ts` calls", so the
   * shipped default (segmented) is what a caller that passes nothing gets. `server/index.ts` passes
   * it EXPLICITLY, because it is the composition root and the resolution belongs at the assembly
   * point; a criterion passes nothing, so it reads the real default rather than re-declaring it.
   */
  segmentedRelay?: boolean;
  /**
   * The omission-fill rule's parameters for this connection, or a test-shaped override of them.
   *
   * ABSENT USES THE LOCKED FILE. The rule's parameters live in exactly one place —
   * `experiments/voice-relay-qb/omission-fill-params.json`, the file the replay gate reads — and
   * this seam only lets a criterion shrink the (12 s / 3 s) windows so a fill is observable in
   * milliseconds. A partial is merged OVER the locked values, so a test that names one window still
   * exercises the locked thresholds.
   *
   * `null` DISABLES the producer. That is not a deployment switch: it exists so a criterion about
   * some other relay behaviour (interrupts, the busy hold, segments) does not have fills landing in
   * the middle of its readings. A deployment leaves it unset.
   */
  omissionFillParams?: Partial<OmissionFillParams> | null;
  /**
   * THIS connection's transport choice, or absent (the per-connection opt-in).
   *
   * The other axis of {@link VoiceRealtimeProxySeams.segmentedRelay}: that one is the DEPLOYMENT's
   * answer, this one is the BROWSER's, asked per connection on the URL. When set it WINS — the
   * connection resolves `segmentedRelay` from it rather than from the environment, so one browser can
   * take the continuous transport while every other connection keeps the default — and it is what the
   * handshake branch names when it stays silent, so "this connection asked for continuous" is told
   * apart in the log from "the deployment turned the relay off".
   *
   * `server/index.ts` passes it from the connection URL's {@link VOICE_REALTIME_TRANSPORT_PARAM}; a
   * criterion that passes nothing reads the environment's resolution, exactly as before.
   */
  transport?: VoiceRealtimeTransport;
  /**
   * THIS connection's uplink audio capture, or absent (see `voice-realtime-audio-capture.ts`).
   *
   * A SIDE CHANNEL, never a replacement: the proxy tells it what crossed the wire and it decides what
   * lands on disk. Every call below is `?.`-guarded and the recorder behind the seam is fail-open, so a
   * connection that was given no capture — and one whose capture cannot be written — forwards exactly
   * the frames it always did. That is what makes "capture off" byte-neutral (AC6), and why the capture
   * resolves its own directory rather than the proxy ever seeing one: the environment belongs to the
   * assembly point (`server/index.ts`), which passes this only when `VOICE_REALTIME_CAPTURE` turned it on.
   */
  audioCapture?: VoiceRealtimeAudioCapture;
  /**
   * Silence Tail Suppression's parameters (decision doc §10), or absent for "off".
   *
   * PRESENCE IS THE SWITCH, and it is deliberately not a boolean here: STS is off unless a deployment
   * names {@link SILENCE_TAIL_ENV}, and `server/index.ts` — the composition root — turns a resolution
   * into this seam only when it resolved to enabled. A criterion passes the three readings-backed
   * numbers directly (often shrunk, so a suppression is observable in milliseconds).
   *
   * IT ONLY EVER APPLIES TO THE CONTINUOUS WIRE. The gate is built, if at all, on the branch a
   * `{type:'audio'}` frame with no `seq` arrives on — the continuous path. A connection that answered
   * the segmented handshake never reaches it (see {@link VoiceRealtimeProxySeams.segmentedRelay}),
   * which is what §10.4 S-6 means by "manual / segmented 下关闭".
   */
  silenceTail?: SilenceTailOptions;
  /**
   * The uplink VAD's per-connection classifier and window, or absent for "off" (see {@link UplinkVadSeam}).
   *
   * THE OTHER UPLINK GATE, and deliberately a SEPARATE seam from {@link silenceTail} rather than a
   * widening of it. STS decides WHEN to stop forwarding and for how long; the uplink VAD decides WHICH
   * frames are speech. They are orthogonal by design (scheme §7: 正交、不得耦合, both default off), so
   * they are two seams, and the handler REFUSES to run both at once — see the setup below — rather than
   * defining a composition order neither the scheme nor a measurement backs.
   *
   * IT ONLY EVER APPLIES TO THE CONTINUOUS WIRE, like {@link silenceTail}: the branch a `{type:'audio'}`
   * frame with no `seq` arrives on. A connection that answered the segmented handshake never reaches it.
   */
  uplinkVad?: UplinkVadSeam;
  /**
   * A fresh, read-only sample of the BOUND session's own queue, or `null` when it cannot be taken.
   *
   * THE ONE READING THE RELAY CANNOT PRODUCE. Every other term in {@link queuedDepth} is an event
   * the proxy saw; the messages the session's own queue accepted are held by the CLI, which drains
   * them at a turn boundary the proxy is never told about — so the relay's own count could only
   * grow (SPEC §18.1 F-3: reported `queued=8→9→10` against a real peak of 7 that then fell ≤2).
   * When present, this seam is consulted at each report point (each delivery result, before each
   * status line, after a stop) and the CLI term is read from it instead of counted.
   *
   * `null` means the reading could not be taken — a per-run session, a host that is gone — and the
   * CLI term is then UNKNOWN, not zero: the line says so
   * ({@link VoiceRealtimeExecStatusReading.queuedKnown} `false`) rather than presenting the L3-only
   * remainder as a complete depth.
   *
   * LEFT UNSET BY A CALLER WITH NO HOST. `server/index.ts` — the composition root — always passes
   * it, so a deployed connection always reconciles; a criterion that stands up a bare proxy keeps
   * the relay's own optimistic count, exactly as before this seam existed.
   */
  hostQueueReading?: (sessionId: string) => HostQueueReading | null;
  /**
   * Whether the connection re-samples {@link hostQueueReading} ON THE TURN BOUNDARY the relay is
   * never told about — the residue AC-338 (GOAL-041) left. The host reconciliation reads a fresh
   * depth at each event the proxy already handles (a delivery result, a stop, before a status line),
   * but a turn boundary that drains the CLI's queue while NO voice event fires leaves the reported
   * depth at its old value until the next event, which may never come — against SPEC §18.5's
   * 「回合边界深度误差 = 0」.
   *
   * HOW IT REFRESHES, AND WHY A BOUNDED POLL RATHER THAN A SUBSCRIPTION. The host's own account of
   * its queue is a PULL reading (`pendingQueuedInputs`); the resident driver holds the
   * `command_lifecycle`/`result` events in its own process state ({@link HostCommandLifecycleReading}
   * is the same pull, sampled for the fence) and exposes no push channel to the proxy. A subscription
   * would need a new cross-module emitter carried driver → runtime → composition root → these seams
   * for this one consumer; the bounded poll rides the seam that already exists. It samples the host
   * once per S-A rate window ({@link statusRateMs}, SPEC §8.3's 2 s) while a run is believed active
   * (`phase !== 'idle'`) and the connection is open, folds a moved reading through the SAME
   * `noteStatus` dedup+cap path every other change uses, and injects NOTHING when the reading has
   * not moved — so §8.3's event-driven rule (no periodic no-change injection) is untouched. It is
   * bounded by that window cadence and terminates on `idle`, on teardown, or when the host answers
   * `null` (an unreadable host stays UNKNOWN rather than being re-read as a zero).
   *
   * OMITTED MEANS ENABLED — the deployed behaviour, so the fix ships without a composition-root
   * change. `false` is the FALSE FORM a criterion builds: the host is sampled only at the events the
   * relay already handles, so a drain no event announces is never seen and the reading stays at its
   * old value (the exact gap this task closes).
   */
  hostQueueTurnBoundaryRefresh?: boolean;
  /**
   * The host's own `command_lifecycle` `started` reading for the bound session (SPEC §18.3), sampled
   * by the interrupt FENCE so a stop for an utterance the current run already covers is answered
   * `covered` instead of aborting (SPEC §18.4 G2, GOAL-041 AC-343).
   *
   * A SIBLING OF {@link hostQueueReading}, not a widening of it: the depth reading is two numbers,
   * this one is the set of commands the CLI has dequeued. Both are the host's account of its own
   * queue, and both come from the same `command_lifecycle` the CLI writes; they are separate seams
   * because a caller reconciling a depth and a caller deciding an interrupt are different readers.
   *
   * LEFT UNSET BY A CALLER WITH NO LIFECYCLE CHANNEL. The fence then degrades to its idempotent half
   * — the same `triggerSeq` runs once — which is the honest behavior for a non-resident session with
   * no `command_lifecycle` to read (SPEC §18.4 G2). A criterion stands a scripted host up through
   * this seam; the pre-seam proxy simply has no coverage reading.
   */
  hostCommandLifecycle?: (sessionId: string) => HostCommandLifecycleReading | null;
  /**
   * What the bound session's run is executing right now, sampled at the interrupt so the stop's
   * audit record and the next turn's note can name the tool the interrupted turn stopped in
   * (SPEC §0.3 D-8, §18.5; see {@link HostRunActivityReading}).
   *
   * A THIRD SIBLING of {@link hostQueueReading} / {@link hostCommandLifecycle}, and separate for the
   * same reason: the depth is two numbers, the fence reads a set of dequeued commands, and this one
   * reads which `tool_use` is open. All three are the host's account of its own run, pulled at the
   * moments the proxy reports on it.
   *
   * LEFT UNSET BY A CALLER WITH NO ACTIVITY RECORD. The stop then records `inFlightTool: null` and
   * the next turn's note is the tool-free form — the pre-seam behaviour, and the honest reading for
   * a session whose activity this process does not track. `server/index.ts` — the composition root —
   * always passes it, resolved from the process-wide activity store's turn reading.
   */
  hostRunActivity?: (sessionId: string) => HostRunActivityReading | null;
  /**
   * The narrator's run-end summary (task `voice-output-run-end-summary`), or absent for "no
   * narrator on this connection".
   *
   * LEFT UNSET BY EVERY CALLER WITH NO NARRATOR, and absence is byte-neutral: nothing below is
   * armed, sampled or sent, so every criterion written before this seam existed keeps its exact
   * behaviour. The composition root that owns the side text model passes it.
   *
   * WHEN IT FIRES. The status aggregator's `running → idle` transition — observed either from the
   * host watcher below (`hostRunActivity` answering `busy: false`) or from a stop — schedules the
   * summarizer once, `settleMs` later, with the context pack standing THEN. A new run beginning
   * inside that window supersedes the pending summary instead of producing two.
   */
  runEndSummary?: VoiceRealtimeRunEndSummarySeams;
  /**
   * The run-end confirmation (`VOICE_REALTIME_RUN_END_ACK`), or absent for the pre-ack wire.
   *
   * Fired at the SAME `running → idle` transition that schedules the summary, but BEFORE the
   * settle wait: the person hears that the run ended immediately instead of after the side model's
   * answer. Presence is the switch, and the seam is independent of `runEndSummary` — a deployment
   * with an ack but no summarizer still speaks the ack.
   */
  runEndAck?: VoiceRealtimeRunEndAckSeam;
  /**
   * The narrator's playback queue and the duplex rule's switch, or absent for "no narrator".
   *
   * The queue is the droppable layer of Live Voice output (GOAL-047): narration is played ONE
   * utterance at a time, and a new user utterance stops what is playing and clears what is queued.
   * A composition root that owns a narrator producer passes {@link VoiceRealtimeNarratorSeams} and
   * enqueues through the queue it receives in `attach`; a caller with no narrator passes nothing and
   * the connection is byte-neutral.
   */
  narrator?: VoiceRealtimeNarratorSeams;
};

/**
 * The environment variable that asks a deployment for the segmented relay's commit protocol.
 *
 * `manual` or `server-vad`; anything else (including unset) asks for nothing. It exists so a
 * run of `scripts/voice-realtime-diagnose.mjs --segments` can exercise the path over HTTP,
 * where the seams are built by `server/index.ts` and the request body names no protocol —
 * the route's body is transport input, and a protocol switch is not transport input.
 */
export const VOICE_REALTIME_SEGMENT_COMMIT_ENV = 'VOICE_REALTIME_SEGMENT_COMMIT';

/**
 * Which segmented-path protocol this connection speaks, and whether the caller asked for it.
 *
 * Resolution order, highest first: the seam (what a criterion or the composition root
 * passes), then {@link VOICE_REALTIME_SEGMENT_COMMIT_ENV}, then the adopted protocol —
 * `manual`, the one P0a's S1 probe concluded the endpoint supports.
 *
 * `explicit` distinguishes "someone asked for the segmented path" from "this is just the
 * default". The distinction is the diagnosis service's, not the connection's: a `turns`
 * script arriving over HTTP is spoken as segments only when the operator asked for it, so
 * the existing continuous multi-turn diagnosis keeps its meaning (see
 * `runVoiceRealtimeDiagnosis`). Consumers: this service's connection handler and
 * `voice-realtime-diagnose.service.ts`.
 */
export function resolveSegmentSelection(seams: {
  segmentCommit?: RealtimeSegmentCommitMode;
}): { mode: RealtimeSegmentCommitMode; explicit: boolean } {
  if (seams.segmentCommit !== undefined) return { mode: seams.segmentCommit, explicit: true };
  const requested = process.env[VOICE_REALTIME_SEGMENT_COMMIT_ENV];
  if (requested === 'manual' || requested === 'server-vad') return { mode: requested, explicit: true };
  return { mode: 'manual', explicit: false };
}

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
function formatSegmentForensics(event: RealtimeSegmentForensics): string {
  return `segment_forensics ${JSON.stringify(event)}`;
}

/**
 * Failure codes that spoil one model turn but leave the connection sound: the model
 * called a tool badly. Everything else (a lost upstream, a missing credential, an
 * event this build cannot read) ends the session.
 */
const RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
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

const errorFrame = (code: string, message: string, recoverable = RECOVERABLE_ERROR_CODES.has(code)): VoiceRealtimeOutboundFrame =>
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
const UPSTREAM_CANCELLED_BY_NEW_INPUT = /cancelled by new input/i;

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

/**
 * Parses one raw browser frame.
 *
 * Returns `null` for anything this handler does not understand. A malformed or
 * unknown frame is dropped rather than answered: the browser speaks a protocol
 * this server owns, so an unknown frame is a version mismatch, and replying to
 * every one of them would turn a mismatch into a frame storm.
 */
export function readVoiceRealtimeInboundFrame(raw: unknown): VoiceRealtimeInboundFrame | null {
  if (typeof raw !== 'string') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const frame = parsed as Record<string, unknown>;
  // The segmented-relay offer. `protocol` is read as a string and nothing more: whether it is a
  // token this proxy speaks is the HANDLER's decision, because that depends on the connection's mode
  // — the reader stays a pure shape-check so both answers are observable from one parsed frame.
  if (frame.type === 'hello' && typeof frame.protocol === 'string') {
    return { type: 'hello', protocol: frame.protocol };
  }

  // A `seq` makes an audio frame a segment's; its absence keeps the continuous path.
  // A non-integer `seq` is dropped rather than coerced: guessing an idempotency key is
  // worse than refusing the frame, which the browser already treats as unacknowledged.
  if (frame.type === 'audio' && typeof frame.audio === 'string') {
    // The rate the client declared, when it declared a usable one. Absent stays ABSENT (not defaulted
    // here): only the first audio frame's rate reaches the capture's header, and it is the capture, not
    // this reader, that knows what "no rate declared" means. Adding the key only when present is also
    // what keeps this reader's output identical for every existing caller that deep-compares it.
    const rate: { sourceRate?: number } =
      typeof frame.sourceRate === 'number' && Number.isFinite(frame.sourceRate) && frame.sourceRate > 0
        ? { sourceRate: frame.sourceRate }
        : {};
    if (frame.seq === undefined) {
      return { type: 'audio', audio: frame.audio, ...rate };
    }
    return Number.isInteger(frame.seq)
      ? { type: 'audio', audio: frame.audio, seq: frame.seq as number, ...rate }
      : null;
  }

  if (frame.type === 'segment_start' && Number.isInteger(frame.seq)) {
    return {
      type: 'segment_start',
      seq: frame.seq as number,
      ...(typeof frame.startedAtMs === 'number' ? { startedAtMs: frame.startedAtMs } : {}),
    };
  }

  if (frame.type === 'segment_end' && Number.isInteger(frame.seq)) {
    const reason = frame.reason;
    return {
      type: 'segment_end',
      seq: frame.seq as number,
      ...(typeof frame.durationMs === 'number' ? { durationMs: frame.durationMs } : {}),
      ...(reason === 'gap' || reason === 'max' || reason === 'end' ? { reason } : {}),
    };
  }

  if (frame.type === 'context' && typeof frame.text === 'string') {
    // `chars`/`rows` are the browser's own accounting and are logged, so they are read as given and
    // defaulted rather than validated: a frame with the text is usable, and refusing it over a
    // mis-counted integer would drop the context the text carries.
    return {
      type: 'context',
      text: frame.text,
      chars: typeof frame.chars === 'number' && Number.isFinite(frame.chars) ? frame.chars : frame.text.length,
      rows: typeof frame.rows === 'number' && Number.isFinite(frame.rows) ? frame.rows : 0,
    };
  }

  // The narrator queue's pacing ack. Like `hello`'s protocol, the id is read as a string and nothing
  // more: whether it names the utterance standing NOW is the QUEUE's decision (a stale ack must not
  // advance it), not this shape-check's.
  if (frame.type === 'narrator_done' && typeof frame.utteranceId === 'string') {
    return { type: 'narrator_done', utteranceId: frame.utteranceId };
  }

  // The answer to one `run_output_request`. The id and the text are both required: a reply that
  // cannot name its request cannot be matched to a run, and an empty text is the page saying this
  // turn produced nothing visible (a real reading, not a malformed frame).
  if (frame.type === 'run_output' && typeof frame.requestId === 'string' && typeof frame.text === 'string') {
    return { type: 'run_output', requestId: frame.requestId, text: frame.text };
  }

  if (frame.type === 'close') {
    return { type: 'close' };
  }

  return null;
}

//----------------- THE LIVE VOICE REGISTRY — the one fact the dispatch hook gates on -------------
//
// The resident launch's `UserPromptSubmit` hook injects the "foreground schedules, background works"
// rules ONLY for a session that has a Live Voice connection at that moment, and this module is what
// tells it: a connection is handled ⇒ {@link markVoiceSessionActive}, every path that ends one ⇒
// {@link clearVoiceSessionActive}. The state lives in `voice-realtime-active.ts`, in this process.
//
// IT USED TO BE A FILE AT `~/.cloudcli/voice-active/<session id>`. The hook was a command hook the
// CLI spawned in its own process, so a file was the cheapest channel across that boundary — at the
// price of a spawn per prompt and of a marker that outlived a relay which was killed, which is why a
// start-up sweep had to exist. The hook is now an in-process callback and both ends are here, so the
// gate is a `Set`. Nothing to clean up at start-up: a `Set` cannot outlive its process.

/**
 * Runs one browser voice connection to completion.
 *
 * Consumed by `server/index.ts`, which derives `boundSessionId` and the caller
 * from the authenticated upgrade request and hands the result to the websocket
 * gateway's `/voice-realtime` branch.
 *
 * The socket is closed by this function on every terminal path — an upstream
 * failure, the browser's own `close`, or the socket's `close` event — because a
 * browser that keeps its microphone open against a dead upstream is the one
 * state this must not leave behind.
 */
export function handleVoiceRealtimeConnection(
  socket: WebSocket,
  boundSessionId: string,
  seams: VoiceRealtimeProxySeams,
): void {
  // THE CONNECTION IS ESTABLISHED HERE, so this is where the dispatch hook is turned on for the
  // session: the browser is in Live Voice, and the next prompt that session submits should be told
  // to schedule rather than to work in the foreground. Balanced by the three exits below — the
  // teardown, the raw socket `close`, and the transport-construction failure — because an entry left
  // behind by any one of them keeps injecting rules into a session nobody is talking to.
  markVoiceSessionActive(boundSessionId);

  // The tool result's closing sentence, chosen once per connection from the same value that names the
  // transport's declared `respondToToolOutputs` intent and the prompt (see
  // `VoiceRealtimeProxySeams.closingTurn`).
  const acceptedTail = acceptedResultTail(seams.closingTurn ?? DEFAULT_VOICE_REALTIME_CLOSING_TURN);
  const advertisedTools = voiceRealtimeToolsFor(seams.slimSendTool ?? DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL);

  const send = (frame: VoiceRealtimeOutboundFrame): void => {
    // One line per outbound frame, EXCEPT non-final captions and `tts_audio` slices: the audio
    // frames are a STREAM (one bounded slice each), and a journal line per slice would bury the
    // utterance-level readings that matter — `narrator speak`, `tts_done` and `tts_error`.
    if (frame.type === 'caption' ? frame.final : frame.type !== 'tts_audio') {
      seams.log?.(
        `to-browser ${frame.type}${frame.type === 'state' ? ` ${frame.state}` : ''}${
          frame.type === 'error' ? ` ${frame.code}${frame.recoverable === true ? ' (recoverable)' : ''}: ${frame.message}` : ''
        }${frame.type === 'caption' ? ` ${JSON.stringify(frame.text)}` : ''}${
          frame.type === 'queued' || frame.type === 'refused' || frame.type === 'stopped' ? ` depth=${frame.depth}` : ''
        }${frame.type === 'queue_reconcile' ? ` held=${frame.queuedMessageUuids.length}` : ''}${
          frame.type === 'narrator_speak' || frame.type === 'narrator_stop' ? ` utterance=${frame.utteranceId}` : ''
        }`,
      );
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };

  let sending = false;
  let closed = false;
  let audioFramesFromBrowser = 0;

  // ---- the narrator's queue (GOAL-047; see `createVoiceRealtimeNarratorQueue`) ------------------
  //
  // Built over THIS connection's downlink, and only when a narrator is wired: with no seam there is
  // no queue, no hook and no change to the wire. The composition root receives the queue through
  // `attach` and its producer (run-end summary, TTS) enqueues text into it.
  const narratorQueue: VoiceRealtimeNarratorQueue | null =
    seams.narrator === undefined
      ? null
      : createVoiceRealtimeNarratorQueue({
          send,
          log: seams.log,
          // The connection's own TTS send. Absent keeps the queue on the text-only wire every
          // pre-TTS criterion was written against.
          ...(seams.narrator.tts === undefined ? {} : { tts: seams.narrator.tts }),
        });
  if (narratorQueue !== null) {
    seams.narrator?.attach?.(narratorQueue);
  }
  /** The narrator's own utterance-id counter, so the announce remark's `narrator_speak` id is unique. */
  let announceNarrationSeq = 0;
  /** The EARLY announce's own id family, spoken when the endpoint says the person stopped. */
  let earlyAnnounceSeq = 0;
  /**
   * Whether this turn still owes an early announce.
   *
   * The endpoint reports the close TWICE — `speech_stopped` and then `committed` — so a naive hook
   * would say "好的" twice for one utterance. Armed at `speech_started`, spent at the first close.
   */
  let earlyAnnounceArmed = false;
  /** When the last early announce was spoken, so the model's closing turn does not repeat it. */
  let lastEarlyAnnounceAt: number | null = null;
  /**
   * How long after an early announce the model's closing-turn remark is suppressed.
   *
   * The two say the same thing ("I'm starting"). The live 2026-10-21 reading put the closing turn
   * about 0.9 s after `speech_stopped`; the early announce lands there instead, so within this
   * window the closing turn would be a second "好的" for the same utterance.
   */
  const EARLY_ANNOUNCE_SUPPRESS_MS = 3_000;
  /** The counter for a MODEL TEXT REPLY's narration, kept separate so its ids never collide with an announce's. */
  let modelReplyNarrationSeq = 0;
  /** The duplex rule's switch. Omitted means enabled — the shipped behaviour. */
  const narratorInterruptsOnUserSpeech = seams.narrator?.interruptOnUserSpeech ?? true;
  /**
   * Whether the COARSE local gate may interrupt the narrator. Omitted means no — see
   * {@link VoiceRealtimeNarratorSeams.narratorInterruptsOnLocalSpeech} for the live capture that
   * made ambient noise mute five announcements in a row.
   */
  const narratorInterruptsOnLocalSpeech = seams.narrator?.narratorInterruptsOnLocalSpeech ?? false;

  /**
   * The person opened their mouth: a narration must not talk over them.
   *
   * Called from the two paths that report a PRECISE new-utterance boundary — the endpoint's own
   * `speech_started` and the browser's `segment_start` — because the two transports see the same
   * fact at different moments and the earliest one wins. NOT called from the local speech gate: its
   * boundary is an energy reading that answers the watchdog's question ("has speech been seen at
   * all?"), not "is this person speaking now", and on the 2026-10-19 capture ambient noise opened it
   * five times while a narration played. Idempotent: a queue with nothing playing and nothing
   * queued drops 0 and sends nothing.
   */
  const noteUserSpokeForNarrator = (): void => {
    if (narratorQueue !== null && narratorInterruptsOnUserSpeech) {
      narratorQueue.interrupt('user-spoke');
    }
  };

  /**
   * Where the person's utterance began and ended, as heard on THIS side of the wire. One per
   * connection, because a boundary is a transition and the state must not outlive the audio it
   * describes — see `voice-realtime-local-speech.ts`.
   */
  const localSpeechGate = createLocalSpeechGate();
  /**
   * Hands a local boundary to the bridge, whose stall watchdog is otherwise armed only by the
   * endpoint's own `speech_started`. Deliberately silent on `null`: most frames close no boundary.
   *
   * THE NARRATOR IS NOT STOPPED HERE. This gate is the watchdog's reading and only that: it is
   * documented as coarse on purpose, and its boundary fires on loud non-speech (measured 2026-10-19:
   * RMS 300–470 ambient noise against 1000–10000 speech). Interrupting playback on that reading
   * cleared five complete announcements in one live connection. `narratorInterruptsOnLocalSpeech`
   * exists only so the criterion can re-wire the old behaviour as its false form.
   */
  const reportLocalSpeechBoundary = (boundary: LocalSpeechBoundary | null): void => {
    if (boundary === 'started') {
      if (narratorInterruptsOnLocalSpeech) {
        noteUserSpokeForNarrator();
      }
      bridge.noteLocalUtteranceStart();
      return;
    }
    if (boundary === 'ended') {
      bridge.noteLocalUtteranceEnd();
    }
  };

  // ---- the segmented path: which seq a delivery belongs to, and what was already delivered ----
  //
  // The upstream can be made to repeat a committed segment: the socket drops after the
  // commit and before the response, and the bridge writes that segment once more onto the
  // new one. The MODEL may then call `session_send` a second time for words the session was
  // already given — which, left alone, puts one thought in the conversation twice. So every
  // delivery is attributed to the segment that was in flight, and a delivery that arrives
  // while a segment is being REPLAYED is dropped if that segment already produced one.
  // Dropping it here (and answering the model as though it landed) is what keeps the
  // session at exactly one message.
  // ---- the C2 context pack: what the session was told about the conversation ----
  //
  // Read ONCE, here, and this connection keeps this reading for its whole life: an edit to the
  // settings file reaches the NEXT connection and leaves live ones alone (the criterion reads this
  // as "a new connection gets the new template, an existing one is unaffected").
  const settings = loadVoiceRealtimeSettings({ baseInstructions: seams.instructions, settingsPath: seams.settingsPath });
  if (settings.problems.length > 0) {
    seams.log?.(`settings: using the built-in prompt — ${settings.problems.join('; ')}`);
  }
  // THE DETECTOR THIS CONNECTION WILL USE, resolved ONCE here so the line below and the gate built further
  // down cannot disagree about it. The line fires only when the SETTINGS FILE named a parameter — the edit
  // an operator is watching for ("I changed the file; did it take?") — and it names the SOURCE, so a value
  // the environment or a diagnosis override won cannot be mistaken for the file's. A deployment that
  // configured nothing still reads no line about a detector it never asked about.
  const turnDetection = resolveTurnDetection(process.env, {}, settings.turnDetection);
  if (Object.keys(settings.turnDetection).length > 0) {
    const settingsTurnDetectionNote = describeTurnDetection(
      turnDetection,
      describeSilenceDurationSource(process.env, {}, settings.turnDetection),
    );
    if (settingsTurnDetectionNote !== null) {
      seams.log?.(settingsTurnDetectionNote);
    }
  }
  // ---- the omission-fill producer's parameters (GOAL-046) --------------------------------------
  //
  // The shipped values come from the JSON module beside this file — they travel with the build, so
  // the producer is on in a deployment that has no `experiments/` tree. The settings file's
  // `omissionFill` override (validated there, read once per connection) is applied next, then the
  // seam's partial, so a criterion can shrink one window without inventing the others. The readings
  // go into the journal before any candidate is judged: a replayed journal cannot be checked
  // without them.
  //
  // `seams.omissionFillParams === null` is the criterion-only "not this connection" switch. A
  // malformed shipped block is recorded and leaves the producer off — never guessed.
  const shippedOmissionFill = readOmissionFillParams();
  const omissionFillParams: OmissionFillParams | null =
    seams.omissionFillParams === null
      ? null
      : shippedOmissionFill.params === null
        ? null
        : {
            ...shippedOmissionFill.params,
            ...(settings.omissionFill ?? {}),
            ...(seams.omissionFillParams ?? {}),
          };
  if (omissionFillParams === null) {
    seams.log?.(
      `omission_fill disabled (${
        seams.omissionFillParams === null ? 'seam' : shippedOmissionFill.problem ?? 'no parameters'
      })`,
    );
  } else {
    seams.log?.(`omission_fill params ${JSON.stringify(omissionFillParams)}`);
  }
  /** The pack this connection was sent, or `''` before it arrives (and for a session with nothing said). */
  let contextText = '';
  let contextChars = 0;
  let contextRows = 0;
  /** The (context, status) pair already advertised, so a repeated compose is not a second `session.update`. */
  let advertisedKey: string | null = null;

  // ---- S-A: the execution-status line, folded into this connection's instructions (SPEC §8.3) ----
  //
  // ONE aggregator per connection, driven only by events this proxy already sees: a `session_send`
  // result, a coalescing window opening, a stop. Its reading is the single source the line is
  // rendered from, so the line and any other reader can never disagree (AC6).
  const execStatus = createVoiceRealtimeExecStatus();
  const statusRateMs = seams.statusRateMs ?? VOICE_REALTIME_STATUS_RATE_MS;
  /** Status lines this run has put on the wire. The cap is on THIS, not on how many changes there were. */
  let statusInjectionsThisRun = 0;
  /** Distinct dedup keys this run has observed — what the last line's `(+N more)` counts the gap from. */
  let statusChangesThisRun = 0;
  /** Set once the run's last line has gone out: no further status line until a new run begins. */
  let statusCapReached = false;
  /** The marker the NEXT line must carry. Set only for the cap notice, cleared as it is sent. */
  let statusMarker: { more: number } | null = null;
  /** The open rate window. A change inside it updates the reading but arms nothing second (coalesce). */
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Folds one observation in and, when the dedup key moved, opens the rate window.
   *
   * The dedup gate is SPEC §8.3's: a change that leaves the key `(phase, runId, queuedItems,
   * queuedBytes, pendingInteraction.requestId)` where it was is NOT a change, and nothing is sent.
   * A new run resets the per-run counters, which is what makes the cap a property of a run rather
   * than of the connection.
   */
  const noteStatus = (patch: VoiceRealtimeExecStatusPatch): void => {
    // The phase BEFORE this observation — the run-end transition below is a comparison of two
    // readings, not a second interpretation of the patch.
    const beforePhase = execStatus.reading().phase;
    // `queuedKnown` is always written from the current term, so a reading that fell out of a host
    // source says so. The host is sampled by the CALLER before it computes the depth this patch
    // carries (a delivery result, a stop), so the numbers and this flag describe one sample.
    const { changed, newRun } = execStatus.update({ ...patch, queuedKnown: cliQueueTerm().known });
    // The content-level RunDigest rides BESIDE the change (SPEC §12.5): sampled here, where the run's
    // facts are as current as the line that is about to carry them, and folded OUTSIDE the dedup key
    // so a digest that moves with nothing else does not put a line of its own on the wire (§8.3).
    execStatus.update({ digest: sampleRunDigest() });
    // The turn-boundary refresh rides every status change: while the status says a run is live, the
    // host is polled once per S-A window so a drain no event announces is still seen (see
    // `hostQueueTurnBoundaryRefresh`). A patch that settles the run drops the poll instead.
    armDrainPoll();
    if (newRun) {
      // A new run supersedes any summary still waiting out its settle window: the person has moved
      // on, and that summary describes work the new run has already replaced. Bumping the generation
      // also voids a summarizer call that is already in flight.
      runEndGeneration += 1;
      clearRunEndSettle();
      // The request (if any) belonged to the run that just got superseded: its answer must not be
      // summarized as if it described the new run.
      clearRunOutputRequest();
      statusInjectionsThisRun = 0;
      statusChangesThisRun = 0;
      statusCapReached = false;
      statusMarker = null;
    }
    // THE NARRATOR'S TRIGGER: exactly the transition the task names. Initial `idle` never matches,
    // and a change that stays within a phase never matches — only `running → idle` does. The stop
    // path and the host watcher both fold their end through this one comparison.
    if (beforePhase === 'running' && execStatus.reading().phase === 'idle') {
      // The ack goes FIRST — at the transition, before the settle timer — and is independent of the
      // summary (see `VoiceRealtimeRunEndAckSeam`). The summary then follows through the same queue.
      speakRunEndAck();
      scheduleRunEndSummary();
    }
    // The host watcher exists exactly while a run is believed live; `pollRunEnd` folds its end back
    // through this same function, so arming it is part of every observation rather than a caller's
    // duty.
    armRunEndWatch();
    if (!changed) {
      return;
    }
    statusChangesThisRun += 1;
    if (statusTimer === null) {
      // No window is open, so this change opens one. A change that arrives while one IS open only
      // updates the reading the window will render — nothing is armed a second time, and nothing is
      // queued behind it, which is what makes a burst coalesce to its latest state (SPEC §8.3).
      statusTimer = setTimeout(flushStatus, statusRateMs);
      statusTimer.unref();
    }
  };

  /**
   * Pushes the composed instructions onto the upstream session.
   *
   * Guarded on `bridge.state`, not called-and-hoped: `sendSessionUpdate` throws on a transport that
   * is not open, and the pack can arrive either side of the upstream handshake — the browser sends
   * it the moment its socket opens, which is usually well before the upstream is up. When the
   * bridge is not open this is a no-op and the `whenConnected` path below applies it instead.
   *
   * Returns whether a frame actually went out — the status bookkeeping below counts on that and must
   * not spend a slot on a compose that the dedup (or a closed bridge) swallowed.
   */
  const advertiseInstructions = (): boolean => {
    if (bridge.state !== 'open') {
      return false;
    }
    const status = execStatus.render(Date.now(), statusMarker ?? undefined);
    const key = `${status.key}\u0000${contextText}`;
    if (advertisedKey === key) {
      return false;
    }
    advertisedKey = key;
    bridge.sendSessionUpdate(
      composeVoiceRealtimeInstructions(settings, contextText, status.text === '' ? undefined : status.text),
    );
    if (contextText !== '') {
      // What was injected, by size and provenance — never the body: this log goes to the server's
      // console, and the body is the user's conversation (SPEC §C2).
      seams.log?.(
        `context injected chars=${contextChars} rows=${contextRows} template=${settings.source}${
          settings.version === null ? '' : ` version=${settings.version}`
        }`,
      );
    }
    if (status.text !== '') {
      // Safe to log whole: §8.4 forbids the line from carrying a body, a path or the user's words,
      // and `voiceStatusField` is what enforces that. The reading is handed out here, beside the
      // send, so a criterion can prove the line and the reading are one source (AC6).
      seams.log?.(
        `status injected seq=${status.reading.statusSeq} phase=${status.reading.phase} queued=${status.reading.queuedItems}/${status.reading.queuedBytes}B ageMs=${Math.max(0, Date.now() - status.reading.at)}${
          statusMarker === null ? '' : ` more=${statusMarker.more}`
        }`,
      );
      seams.onExecStatus?.(status.reading);
    }
    statusMarker = null;
    return true;
  };

  /**
   * The end of one rate window: put the LATEST reading on the wire, once.
   *
   * The last line of a run carries the `(+N more)` marker and shuts the run down — the cap is on
   * INJECTIONS, so a burst that coalesced into one line has spent one slot, not five.
   */
  const flushStatus = (): void => {
    statusTimer = null;
    if (closed || bridge.state !== 'open' || statusCapReached || !execStatus.hasState()) {
      return;
    }
    // Reconcile at the INJECTION, not only when the change was folded in: the CLI can drain its own
    // queue between the event that armed this window and the moment the line goes out, and §18.5's
    // "回合边界深度误差 = 0" is judged on what the line says. This updates the aggregator's stored
    // queued fields from a fresh sample; it arms nothing (only `noteStatus` opens a window), so a
    // drain noticed here is simply the reading this one line carries.
    refreshHostQueue();
    execStatus.update({
      queuedItems: queuedDepth(),
      queuedBytes: queuedBytes(),
      queuedKnown: cliQueueTerm().known,
    });
    const last = statusInjectionsThisRun >= VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN - 1;
    if (last) {
      statusMarker = { more: Math.max(1, statusChangesThisRun - statusInjectionsThisRun) };
    }
    if (advertiseInstructions()) {
      statusInjectionsThisRun += 1;
      if (last) {
        statusCapReached = true;
      }
    }
    statusMarker = null;
  };

  const segmentCommitMode = resolveSegmentSelection(seams).mode;

  // ---- the P4 rollout switch: does this connection declare the segmented relay? ------------------
  //
  // Read ONCE per connection, like the settings above: a live connection keeps the answer it was
  // opened with, so flipping the environment variable affects the NEXT connection and leaves the one
  // already in progress alone. When the caller passed no seam, this resolves the shipped default —
  // the same {@link resolveVoiceRealtimeMode} `server/index.ts` calls at the assembly point — and
  // reports a misconfigured variable here, where there is a log sink to report it to. A per-connection
  // transport choice (`seams.transport`) overrides the environment for THIS connection only.
  const modeResolution = applyVoiceRealtimeTransport(
    resolveVoiceRealtimeMode(process.env),
    seams.transport ?? null,
  );
  if (seams.segmentedRelay === undefined) {
    const modeNote = describeVoiceRealtimeMode(modeResolution);
    if (modeNote !== null) {
      seams.log?.(modeNote);
    }
  }
  const segmentedRelay = seams.segmentedRelay ?? (modeResolution.mode === 'segmented');
  // ---- Silence Tail Suppression (decision doc §10): the continuous wire's upload state machine ----
  //
  // Built ONCE per connection and only when the deployment asked for it, so an STS-off connection
  // never allocates the state machine and the branch below is byte-identical to before this existed
  // (§10.4 S-6). `segmentedRelay` is read here rather than at the use site because a connection that
  // declares the segmented relay never carries bare `audio` frames at all, and building a gate for it
  // would be state that can never run.
  const silenceTailOptions = seams.silenceTail === undefined || segmentedRelay ? null : seams.silenceTail;
  const silenceTail = silenceTailOptions === null ? null : createSilenceTailGate(silenceTailOptions);
  // ---- Uplink VAD (scheme §5): the continuous wire's per-frame speech / non-speech gate ----
  //
  // SAME SHAPE AS STS: built once per connection and only when the deployment asked for it, so an
  // `uplinkVad === undefined` connection never allocates a gate and the branch below keeps the
  // pre-feature `=== null` fast path (AC1/AC2). `a` is derived from the RESOLVED silence window, read
  // here from the SAME `voice-realtime-turn-detection.ts` the transport's own default comes from, so a
  // deployment that moves the window moves this gate's with it (AC8).
  //
  // AC6 — THE STS RELATIONSHIP IS DECIDED HERE, NOT LEFT UNDEFINED. Both gates rewrite the uplink frame
  // stream, and the scheme says they are orthogonal and must not be coupled (§7); running both would be
  // exactly that coupling (the VAD's kept frames feeding STS's silence estimate, or STS's withheld
  // frames feeding the VAD's index space). So exactly one runs: when BOTH seams are present the
  // INCUMBENT wins — STS is the shipped, measured gate — and the uplink VAD is refused OUT LOUD, so a
  // deployment that turned both on gets a working connection and a log line saying which gate ran,
  // never a silent, undefined mixture.
  const uplinkVadRequested = seams.uplinkVad !== undefined && !segmentedRelay;
  let uplinkVad: UplinkVadGate | null = null;
  /**
   * The classifier the gate consults, kept beside the gate because the FAIL-SAFE BYPASS is the proxy's,
   * not the gate's: the connection-level state it carries (`loading`/`ready`/`bypassed`/`failed`) is what
   * decides whether a frame may go through the gate at all. `null` whenever no gate was built.
   */
  let uplinkVadClassifier: UplinkVadClassifier | null = null;
  let uplinkVadExitWaitMs = UPLINK_VAD_EXIT_WAIT_MS;
  if (uplinkVadRequested && silenceTail !== null) {
    seams.log?.(
      'uplink_vad refused: silence tail suppression is also enabled, and the two uplink gates do not ' +
        'compose (scheme §7) — the incumbent STS gate wins and the uplink VAD is off for this connection',
    );
  } else if (uplinkVadRequested && seams.uplinkVad !== undefined) {
    // The detector was resolved ONCE, above, so the value the gate derives `a` from and the value logged
    // at connect time are the same one. Only a REFUSAL is reported here (`describeTurnDetection`'s
    // historical contract): the resolved values are already in the line above when the settings file named
    // them, and the `uplink_vad:` line below carries the EFFECTIVE window — `silenceDurationMs`, the seam
    // override included — so nothing is said twice.
    const turnDetectionNote = describeTurnDetection(turnDetection);
    if (turnDetectionNote !== null) {
      seams.log?.(turnDetectionNote);
    }
    const silenceDurationMs =
      seams.uplinkVad.silenceDurationMs ?? turnDetection.turnDetection.silence_duration_ms;
    uplinkVadClassifier = seams.uplinkVad.classifier;
    uplinkVad = createUplinkVadGate({ classifier: uplinkVadClassifier, silenceDurationMs });
    uplinkVadExitWaitMs = seams.uplinkVad.exitWaitMs ?? UPLINK_VAD_EXIT_WAIT_MS;
    // `state=` is the connection-level reading; a production arm point is `loading` here (its backend is
    // constructed asynchronously) while a hand-injected classifier reads `ready`. The whole point of the
    // two fields is that a reader can tell "filtering, found no speech" from "not filtering at all".
    seams.log?.(
      `uplink_vad: ${describeUplinkVadBackend(readUplinkVadBackend(uplinkVadClassifier))} ` +
        `state=${readUplinkVadState(uplinkVadClassifier)} silenceMs=${silenceDurationMs} aFrames=${uplinkVad.aFrames}`,
    );
  }
  /**
   * The uplink VAD's per-connection serialisation. `observe` is async and the classifier answers in
   * frame order, so each browser frame chains onto the previous and whatever a call lets through is
   * forwarded as it settles. The chain is ALSO the exit path's drain point — awaiting it is how the exit
   * knows every ARRIVED frame has been judged.
   */
  let uplinkVadChain: Promise<void> = Promise.resolve();
  /** The exit path's wait signals: bit 1 = `input_audio_buffer.committed`, bit 2 = a FINAL transcription. */
  let uplinkVadExitSignals = 0;
  /** Resolves the exit wait early once BOTH signals have arrived; `null` outside a wait. */
  let uplinkVadExitResolve: (() => void) | null = null;
  const signalUplinkVadExit = (bit: number): void => {
    uplinkVadExitSignals |= bit;
    if (uplinkVadExitSignals === 3 && uplinkVadExitResolve !== null) {
      uplinkVadExitResolve();
    }
  };
  /**
   * The gate's latest cumulative reading, plus the proxy's own byte counters — the material for the ONE
   * summary line a connection logs when it closes.
   *
   * The gate's numbers count what IT decided (per frame); the byte counters count what actually crossed
   * the wire and what did not, which is the reading that answers "did this gate save anything". Bytes are
   * the DECODED PCM sizes, so a deployment compares them against the audio it sent, not against base64's
   * 4/3 expansion.
   */
  let uplinkVadStats: UplinkVadGateStats | null = null;
  let uplinkVadBytesIn = 0;
  let uplinkVadBytesOut = 0;
  /**
   * Frames this connection has FORWARDED UPSTREAM since the endpoint last committed an input item.
   *
   * The exit path's second reading (see {@link exitUplinkVad}): a count of `0` says the audio the
   * endpoint holds is exactly the audio it has already accounted for — its own last `committed`
   * drained everything this connection sent, so a commit now has nothing to close.
   *
   * COUNTED AT THE FORWARD, NOT AT THE ARRIVAL. `audioFramesFromBrowser` is the browser's reading and
   * is deliberately the wrong one here: the gate withholds silence, and a frame the gate never sent is
   * not audio a commit could reach. Reset on every upstream `committed` (`onUserAudioCommitted`), and
   * only there — that is the event the reading is defined against.
   */
  let uplinkVadFramesSinceCommit = 0;
  /**
   * How many turn-close notifications the bridge has delivered (`onUpstreamTurn(false)`), and the
   * value that stood when THIS relay sent its own forced commit.
   *
   * WHY A COUNT RATHER THAN `upstreamTalking`. The bridge reports BOTH `speech_stopped` and
   * `committed` as a turn close, and it reports the committed's close BEFORE it calls
   * {@link onUserAudioCommitted} — so by the time this proxy may react, `upstreamTalking` has already
   * been cleared by the very frame being judged. Counting closes keeps the distinction the recovery
   * needs: a forced commit answered by a `committed` with NO `speech_stopped` in between produces
   * exactly ONE close notification on top of the snapshot (the committed's own); a turn the endpoint
   * closed itself produces TWO (`speech_stopped`, then `committed`) — the live 71e53da5 shape where a
   * second `response.create` re-sent the sentence. A new `speech_started` retires the snapshot:
   * whatever the next committed answers, it is no longer the turn this relay closed.
   */
  let upstreamTurnCloseCount = 0;
  let forcedCommitCloseSnapshot: number | null = null;

  /**
   * The hold-open cap was reached with the upstream's turn still open: commit it ourselves. A refused
   * commit ("buffer too small") means the turn was already closed.
   *
   * COMMIT ONLY HERE, unlike the exit path's pair. The uplink VAD runs only on continuous connections
   * (server_vad), and live, the commit made the upstream close the turn itself and its server_vad
   * answered it; a `response.create` sent unconditionally beside the commit was a second response for
   * the same utterance, which re-sent the sentence and looped on the duplicate guard (2026-10-15,
   * connection 71e53da5). The other live shape is why this is not the whole story: when the endpoint
   * answers `committed` WITHOUT ever emitting `speech_stopped`, its server_vad will not open a
   * response and the sentence waits for the next utterance (2026-10-17, 22.5 s / 49.6 s late). The
   * recovery is state-driven, not a pair sent up front: the snapshot below lets the `committed` tell
   * the two shapes apart — see `onUserAudioCommitted`.
   */
  const closeUplinkVadHeldTurn = (): void => {
    const transport = lastSendingTransport;
    if (transport === null) {
      return;
    }
    seams.log?.(
      `uplink_vad: upstream turn still open after ${UPLINK_VAD_HOLD_OPEN_MAX_MS} ms of quiet — committing it`,
    );
    transport.send({ type: 'input_audio_buffer.commit' });
    // SNAPSHOT AFTER THE SEND, before any answer can arrive: the committed that answers THIS commit
    // is recognised by a single turn-close notification on top of this value (see the field doc and
    // `onUserAudioCommitted`'s recovery block).
    forcedCommitCloseSnapshot = upstreamTurnCloseCount;
  };
  /** Feeds one browser frame through the VAD path and forwards whatever it lets through, in order. */
  const enqueueUplinkVad = (audio: string): void => {
    const gate = uplinkVad as UplinkVadGate;
    uplinkVadBytesIn += Buffer.byteLength(audio, 'base64');
    uplinkVadChain = uplinkVadChain
      .then(async () => {
        // FAIL-SAFE BYPASS. Once the backend has thrown, this connection never consults it again: this
        // frame — and every frame after it — crosses unjudged. The chain is still the path rather than a
        // bare `sendAudioFrame` so a frame queued behind an in-flight classification cannot overtake it.
        if (readUplinkVadState(uplinkVadClassifier) === 'failed') {
          uplinkVadBytesOut += Buffer.byteLength(audio, 'base64');
          uplinkVadFramesSinceCommit += 1;
          bridge.sendAudioFrame(audio);
          return;
        }
        const decision = await gate.observe(audio);
        uplinkVadStats = decision;
        for (const forwarded of decision.frames) {
          uplinkVadBytesOut += Buffer.byteLength(forwarded, 'base64');
          uplinkVadFramesSinceCommit += 1;
          bridge.sendAudioFrame(forwarded);
        }
        if (decision.closeTurn) {
          closeUplinkVadHeldTurn();
        }
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        // THE BACKEND IS DONE FOR THIS CONNECTION, AND THE AUDIO IT WAS HOLDING IS NOT LOST. The frame
        // whose classification threw is still inside the gate — it was pushed before `classify` ran — so
        // `flush` releases it (and anything older still pending) BYPASSED, in order: the audio crosses
        // unjudged at the moment it failed, rather than disappearing the way a log-only catch let it.
        markUplinkVadFailed(uplinkVadClassifier, message);
        seams.log?.(`uplink_vad: failed — ${message}; every frame from here passes through unjudged`);
        try {
          const tail = await gate.flush();
          uplinkVadStats = tail;
          for (const forwarded of tail.frames) {
            uplinkVadBytesOut += Buffer.byteLength(forwarded, 'base64');
            uplinkVadFramesSinceCommit += 1;
            bridge.sendAudioFrame(forwarded);
          }
        } catch (flushError) {
          // Resolved rather than rethrown: a rejected chain would also swallow every LATER frame's
          // forward, turning one backend failure into a connection that stops relaying audio entirely.
          seams.log?.(
            `uplink_vad: the post-failure flush failed — ${
              flushError instanceof Error ? flushError.message : String(flushError)
            }`,
          );
        }
      });
  };
  /** The segment a delivery arriving now belongs to, or `null` outside any segment. */
  let activeSegmentSeq: number | null = null;
  /** Whether that segment is being replayed onto a NEW upstream socket. */
  let activeSegmentIsReplay = false;
  /** Segments that have already produced one delivered message. */
  const deliveredSegmentSeqs = new Set<number>();

  // ---- continuous mode's duplicate guard: one spoken sentence is one message ----
  //
  // THE DEFECT THIS CLOSES. The endpoint's server-side VAD commits an utterance when the user stops
  // speaking and the model relays it as `session_send`; but the model can then re-issue the SAME
  // call with no new audio behind it — nudged by the tool-resume `response.create`, or by the
  // upstream starting a response on its own. The call ids are fresh, the segmented replay gate above
  // never fires (continuous mode carries no `seq`), and the per-utterance cap is nowhere near, so
  // one sentence was delivered into the session three times (journal 57279cc1, 2026-10-11,
  // 15:40:00 / 15:40:16 / 15:40:33 — the last two with `audioTokens=259`, i.e. no new input audio).
  //
  // THE COUNTER is "user utterances the upstream has begun and not yet accounted for by an accepted
  // delivery". A NEW utterance is signalled two ways and BOTH count — the endpoint's
  // `input_audio_buffer.committed` (through {@link RealtimeBridgeHooks.onUserAudioCommitted}: the
  // proxy cannot see the event itself, the bridge tolerates it) and a FINAL transcription
  // (`onCaption` below — the very signal the bridge uses to end its own per-utterance tool-loop
  // count, `MAX_CALLS_PER_UTTERANCE`). Counting the commit ALONE is not enough: a producer that
  // announces an utterance by its transcript with no `committed` the proxy observed — the scripted
  // stand-in `voice-realtime-status-injection.test.ts` drives its turns exactly that way — would have
  // every genuine repeat swallowed as an echo. The guard only ever reads the count for "== 0", so
  // counting both is strictly safer than either and never masks a phantom (which carries neither).
  // RESET to 0 the moment a call passes every gate and is accepted, NOT at the `flushCoalesced`
  // moment: an utterance that lands INSIDE the 1 s window then belongs to the NEXT one instead of
  // being erased by the flush.
  let unforwardedUserUtterances = 0;
  /**
   * The L3 `utteranceSeq` (SPEC §10.3 / C-3): a MONOTONE count of the NON-EMPTY final transcriptions
   * this connection has heard, starting at 0 and never reset. A stop's audit record names the value
   * it stood at when the model decided to stop, which is what turns "the model stopped a run" into
   * "the model stopped the run it had just heard *this* utterance for" — the reading C-3's "误停可
   * 审计" needs and the one nothing else on this connection carries (the `stopped` frame counts the
   * backlog, the L3 aggregator counts state CHANGES as `statusSeq`, and neither says which utterance
   * the judgement was made on).
   *
   * AN EMPTY FINAL TRANSCRIPTION DOES NOT ADVANCE IT. The endpoint closing a segment with zero words
   * is not an utterance — it is the endpoint saying nobody spoke — so counting it would let a cough,
   * a door, or a silent segment push `triggerSeq` past the words the model actually answered. It is
   * the same reading `EMPTY_RELAY_TEXT` already makes for the relay guard, applied to the count.
   */
  let utteranceSeq = 0;
  /**
   * The FENCE's `commandUuid → utteranceSeq` map (SPEC §18.3, GOAL-041 AC-343): what each command
   * the host acknowledged carried, so a `command_lifecycle` `started` event can be turned back into
   * the utterance it dequeued. Filled from the delivery result's `queuedMessageUuid` paired with the
   * `utteranceSeq` standing at the delivery.
   */
  const deliveredSeqByCommandUuid = new Map<string, number>();
  /**
   * The utterance seqs whose command the host reported `started` — the CURRENT run's `covers`
   * (SPEC §18.3 R-4.3). Accumulated from {@link HostCommandLifecycleReading}, never from a message
   * id this proxy chose. Monotone within a connection, which is what lets the fence compare a
   * `max` against the trigger rather than track run boundaries.
   */
  const coveredSeqs = new Set<number>();
  /**
   * The text each non-empty utterance carried, keyed by its `utteranceSeq` — what the RunDigest's
   * `covers.last` reads. Filled beside the `utteranceSeq += 1` that mints the key (in `onCaption`),
   * so a covered seq always resolves to the words it stood for; the SANITIZER, not this map, is what
   * keeps those words off the line (see {@link voiceDigestField}).
   */
  const utteranceTextBySeq = new Map<number, string>();
  /**
   * The last message the session took into its OWN queue (`queued: true`) and has not begun — the
   * RunDigest's `queuedNotStarted.last`. Cleared when a delivery STARTS a run (`queued: false`), the
   * one moment the queue ahead of it is provably drained; `null` when nothing is waiting.
   */
  let lastQueuedNotStartedText: string | null = null;
  /**
   * The endpoint's per-ITEM empty reading on the CONTINUOUS wire, keyed by `item_id`. In continuous
   * mode there is no segment to key the empty guard on (`seq` is `null`), so the guard keys on the
   * item the transcript is ABOUT instead — the one thing the endpoint says that survives the
   * reordering (§10 "按条目自身空转写判定").
   */
  const itemTranscriptEmpty = new Map<string, boolean>();
  /**
   * The words of each item in {@link transcribedSinceWatermark}, keyed by `item_id` — what the relay
   * delivers verbatim when the model ends a turn in text with those items still unanswered (see the
   * `MODEL_TEXT_REPLY` branch of `onError`). Kept per item like {@link itemTranscriptEmpty}.
   */
  const itemTranscriptText = new Map<string, string>();
  /**
   * THE CONTINUOUS WIRE'S FORWARDING WATERMARK, read as the SPAN a relay arriving now answers for.
   *
   * The ids in {@link transcribedSinceWatermark}, oldest first, are exactly the FINAL transcriptions
   * that have landed SINCE the last call this guard decided on — so at the moment a relay is judged,
   * "everything transcribed after the watermark" IS this array, and draining it is advancing the
   * watermark. Held that way the watermark needs no number of its own and the array cannot grow with
   * the connection's age.
   *
   * WHY THE SPAN AND NOT THE LAST ITEM (journal `b5d01c21`, 2026-10-13 23:57 CST, the defect this
   * replaced). The model routinely answers SEVERAL of the endpoint's items with ONE `session_send` —
   * here the person's sentence, the fragment after it, and the 0.37 s sliver the endpoint split off
   * behind both — and the merged call's words are the ones that had text. Judged against the LAST
   * item alone, that call was refused whenever the last item happened to be the empty sliver, and the
   * whole sentence was lost. The interval is the honest scope: a call is answerable for exactly the
   * transcriptions that landed since the last call it answered for.
   *
   * ONLY THE TWO VERDICTS BELOW DRAIN IT. A call the wire TRUNCATED never reaches this file at all —
   * the bridge reports it (`TRUNCATED_BY_TURN` for the endpoint's own `turn_detected` cancellation,
   * `MALFORMED_FUNCTION_CALL` when no such cancellation arrives) before any executor runs — so the items
   * transcribed before it are still in the span when the model re-sends the same content, and the
   * re-send's interval covers them. That is the reading the model's own re-send depends on, and it is
   * why nothing here is drained by an error.
   *
   * APPENDED FOR THE CONTINUOUS WIRE ONLY. The segmented wire's guard is keyed by `seq` and never
   * reads this, so appending there would be footprint with no reader.
   */
  const transcribedSinceWatermark: string[] = [];
  /**
   * The id of the last user item the endpoint COMMITTED on this connection — the watermark a delivery
   * reports as "the model had seen at least this far when this instruction was relayed".
   *
   * WHY A COMMIT AND NOT A TRANSCRIPT. A `committed` is the moment the endpoint created the input
   * item, which is the moment it enters the model's conversation; the transcription is a separate,
   * slower read of that same item. The page needs the CONVERSATION boundary (what the model could
   * have acted on), not the display boundary, so this is the earlier and the righter of the two.
   *
   * Consumed by the `sent` frame's `coveredThroughItemId`, which is how a browser attributes the
   * sentences it spoke to the delivery that answered them — see the client's claim step. Without it
   * the page has only the relayed TEXT to match against, and a model that rewords or omits one of
   * several sentences it answered in one call leaves the other on screen as never-delivered.
   */
  let lastCommittedUserItemId: string | null = null;
  /**
   * The items the endpoint has COMMITTED but not yet transcribed, in commit order.
   *
   * The two upstream events are independent: a `committed` creates the input item, and its
   * transcription lands later (sometimes seconds later, and out of order across items). A model
   * response can therefore be produced BEFORE the transcription of the sentence it answers arrives.
   * Without this set, the late transcript would look unanswered and the `MODEL_TEXT_REPLY` net
   * would deliver it verbatim — a duplicate of a sentence the model already carried. See
   * {@link claimOutstandingCommits}.
   */
  const committedPendingTranscription = new Set<string>();
  /**
   * The committed items a model response has already answered for, waiting for their transcription.
   * A final transcription for one of these is CONSUMED by the response: it is recorded (the digest
   * and the transcript view still read it) and it does not join {@link transcribedSinceWatermark} —
   * so the `MODEL_TEXT_REPLY` net cannot deliver it again. The omission planner still sees it: the
   * rule's coverage question is answered from the executed messages, not from this set.
   */
  const committedCoveredByResponse = new Set<string>();
  /**
   * Whether any FINAL transcription has landed on this connection. Once it has, the watermark owns
   * the duplicate question: a model response arriving with no new speech since the last accepted
   * delivery is a restatement of a span that is already delivered, and is refused by the watermark
   * rather than by comparing its words. A connection that has never heard a final keeps the
   * pre-watermark behaviour (every call is its own delivery), which is what keeps fixture
   * connections that drive `session_send` directly working unchanged.
   */
  let finalTranscriptHeard = false;
  /**
   * A monotonic count of "the person said something" events — every `input_audio_buffer.committed`
   * and every final transcription. It is the watermark's clock: a delivery records the epoch it was
   * accepted at, and a model response arriving at the SAME epoch carried no new speech, so the span
   * it would deliver is already in the session.
   *
   * A COMMIT COUNTS, NOT ONLY A TRANSCRIPTION. The endpoint creates the input item at the commit and
   * transcribes it later, sometimes seconds later; a person who speaks and whose transcription is
   * still in flight has really said something, and the model's late forward of those words is a
   * delivery, not an echo (journal `f6166468`). Counting only finals would drop it — the dropped-input
   * class this task exists to close, reached from the other side.
   */
  let speechEpoch = 0;
  /** The `speechEpoch` the last accepted delivery consumed. See {@link speechEpoch}. */
  let deliveredEpoch = 0;
  /**
   * The normalized text of the last few accepted deliveries, newest last — the window a no-new-speech
   * call is checked against for RESTATEMENT.
   *
   * WHY A WINDOW AND NOT JUST THE LAST DELIVERY. A span can be delivered verbatim (by the
   * `MODEL_TEXT_REPLY` net or an omission fill) BEFORE the model's response for it arrives (the
   * response lost the race and is a restatement of the endpoint's own words). The last delivery may already be the NEXT span, so
   * comparing only against it would let the earlier sentence through a second time — the active
   * duplicate this task closes. A bounded window keeps that comparison local without keeping the
   * whole conversation.
   *
   * WHY THE RESTATEMENT TEST IS STILL NEEDED AT ALL, given the watermark. The watermark answers "is
   * there a new span?"; it does NOT answer "are these words already in the session?". A call with no
   * new speech can still be the FIRST delivery of words nobody has (the interrupt's next message —
   * the person spoke, the model answered, and the transcription has not landed yet; journal
   * `b33412ea`'s late forward). Refusing those on the watermark alone loses real input, which is the
   * class this task exists to stop. So the rule is: no new span AND a restatement of something
   * recently delivered ⇒ echo; anything that adds words is a delivery.
   */
  const recentDeliveredTexts: string[] = [];
  /**
   * The omission-fill rule's in-memory inputs (GOAL-046): every final transcription `F_i`, every
   * EXECUTED model message `M_k`, and the endpoint's `speech_started` times.
   *
   * THE PLAN IS RECOMPUTED FROM THESE, NEVER INCREMENTALLY. The rule's decision time `T_i` depends
   * on messages that had not arrived when the final did, and the silence branch depends on whether
   * the user speaks again inside `S`; incrementally patching a plan would be a second implementation
   * of §3. The arrays stay small for a voice connection (one entry per final / executed response),
   * and the pure planner is cheap.
   */
  const omissionFinals: OmissionFillFinal[] = [];
  const omissionExecuted: OmissionFillExecuted[] = [];
  const omissionSpeechStarts: number[] = [];
  /**
   * Item id → the index of that item's final in {@link omissionFinals}. The `MODEL_TEXT_REPLY` net
   * already delivers some finals verbatim; mapping back to the index is what lets it CLOSE the
   * planner's candidate, so the rule does not deliver the same sentence a second time.
   */
  const omissionIndexByItemId = new Map<string, number>();
  /**
   * The indices whose disposition is final: filled, or skipped for a recorded reason. An item is
   * decided exactly once — a late model message must never un-fill words already delivered, and a
   * fill must never be re-delivered on the next recompute.
   */
  const omissionSettled = new Set<number>();
  /** The one timer waiting for the earliest undecided `T_i`, or `null`. See `evaluateOmissionFill`. */
  let omissionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The `triggerSeq` this connection has already interrupted for — the idempotent half of the fence.
   * Set when a model stop RUNS, read by {@link decideModelInterrupt}, and never reset: a repeat of
   * the same trigger is the debounce D-7 forbids, and a NEW utterance always carries a HIGHER seq.
   */
  let abortedTriggerSeq: number | null = null;
  /**
   * Normalized text of the most recent message this connection accepted for delivery (the window's
   * joined text while a window is open). Not the guard's criterion any more — see {@link proceedRelay}
   * — but the reading that says whether there IS a previous delivery to be re-sent at all.
   */
  let lastAcceptedRelayText = '';
  /** Per-segment frame count, for the log line and the ack. */
  const segmentFrameCounts = new Map<number, number>();
  /** Fallback mode: segments committed whose transcription has not come back yet, oldest first. */
  const awaitingTranscriptionSeqs: number[] = [];
  /**
   * A committed segment's transcript, once the endpoint has reported one: `false` when it carried
   * words, `true` when it carried none. ABSENT means "not known yet", which is a third state and
   * not the same as empty — the guard holds on absent and drops on `true` (see
   * {@link SEGMENT_TRANSCRIPT_GRACE_MS}).
   */
  const segmentTranscriptEmpty = new Map<number, boolean>();
  /** Segments already answered with `dropped`/`empty-transcript`, so the ack goes out once. */
  const emptiedSegmentSeqs = new Set<number>();
  /**
   * Segments already answered `committed` (manual mode), so the ack goes out once.
   *
   * A segment replayed onto a later socket is committed a SECOND time upstream — a second input item
   * for the same audio — and the endpoint answers each with its own `input_audio_buffer.committed`.
   * The page's verdict for that `seq` is already `committed`; a second one would read as a log line
   * rather than a state, and the delivery side already treats the replay as the same segment
   * (`deliveredSegmentSeqs`). One verdict per segment, agreed by both halves.
   */
  const committedSegmentSeqs = new Set<number>();
  /**
   * WHICH SEGMENT AN INPUT ITEM IS — the endpoint's `item_id` for the utterance a segment's commit
   * created, paired with its `seq`.
   *
   * THE DEFECT THIS CLOSES. A transcription is the endpoint's answer about an ITEM, and the endpoint
   * answers in whatever order it finishes: journal `ef9daacd` (2026-10-12) has seq2's transcript
   * arriving after seq3's commit and seq4's after seq5's. Attributing a transcript by "whichever
   * segment is active when it lands" therefore attributes it to a DIFFERENT segment — and when it is
   * empty, it marks THAT segment empty, which refuses that segment's genuine relay. The item id is the
   * only key that survives the reordering, and the bridge pairs it with the seq whose commit created
   * it ({@link RealtimeBridgeHooks.onUserAudioCommitted}) because the bridge is what writes the commit
   * and reads the answer.
   *
   * AN ABSENT ENTRY IS NOT AN EMPTY ONE. `Map.get` returning `undefined` means "this item belongs to
   * no segment this relay committed" — an item the endpoint's OWN detector created (continuous mode,
   * or the fallback's server VAD), carried by the hook as `seq: null`. Those are exactly the items the
   * old code mis-attributed to the active segment, so absent maps to "no attribution", never to
   * `activeSegmentSeq`.
   */
  const segmentSeqByItemId = new Map<string, number>();
  /** Segments whose commit the endpoint REFUSED — no item exists for them, so no transcript ever will. */
  const rejectedSegmentSeqs = new Set<number>();
  /** Segments whose `segment_end` has already been handled, so a repeat cannot close one twice. */
  const endedSegmentSeqs = new Set<number>();
  /** The one relayed instruction held back because its segment's transcript is not yet known. */
  let heldDelivery: { seq: number; isReplay: boolean; args: Record<string, unknown>; resolve: (value: unknown) => void } | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  const transcriptGraceMs = seams.transcriptGraceMs ?? SEGMENT_TRANSCRIPT_GRACE_MS;

  /**
   * Which segment one input item's transcription belongs to, or `null` for none of them.
   *
   * TWO MODES, TWO DIFFERENT FACTS, and neither of them is "whichever segment is open":
   *
   *  - MANUAL (the shipping path). The item is the one the segment's own `input_audio_buffer.commit`
   *    created, and the bridge pairs them ({@link segmentSeqByItemId}). An item with no entry is one
   *    the endpoint's own detector made — no segment of ours — so `null`.
   *  - SERVER-VAD (the fallback). There is no commit of OURS to pair with: the endpoint's detector
   *    chose the boundary, and the frames went up as they arrived. What orders a transcript to a
   *    segment there is the segment's own closing silence, which is why the queue of segments still
   *    awaiting a transcription holds exactly the ones whose endings the endpoint has read. The OLDEST
   *    of them is the one this transcript closes. That queue — not the active segment — is the anchor,
   *    and it is the reading this function had to change to as well: the active segment in this mode
   *    is set by the same `committed` phase, so a late transcript landed on the next segment here too.
   *
   * AN EMPTY `itemId` MAPS TO NOTHING. A malformed event (no `item_id`) must not be given the benefit
   * of the doubt by falling through to an anchor it does not belong to.
   */
  const segmentSeqForCaption = (itemId: string): number | null => {
    const mapped = itemId === '' ? undefined : segmentSeqByItemId.get(itemId);
    if (mapped !== undefined) {
      return mapped;
    }
    if (segmentCommitMode === 'server-vad') {
      return awaitingTranscriptionSeqs[0] ?? null;
    }
    return null;
  };

  const base = seams.createExecutor({ boundSessionId });

  /**
   * `session_send`, executed immediately — no browser confirmation (AC-316).
   *
   * DashScope's server-side VAD can start a second response (and so a second
   * `session_send` call) before the first real call has returned — AC-308's
   * real trace already proved that race happens. `sending` is a single-flight
   * guard, not a queue: a second call while one is outstanding is refused
   * outright rather than running concurrently against the same bound session
   * (AC-315's protocol-simulation suite regresses this).
   */
  /** True while an instruction is waiting out a busy session — the only state a newer call may join. */
  let waitingForBusySession = false;
  /** What was said while the first instruction was waiting; delivered with it, in order. */
  let waitingExtraMessages: string[] = [];
  /**
   * Deliveries the bound session's OWN queue accepted (`queued: true`) and has not drained yet.
   *
   * THE RELAY'S OWN GUESS, and it is only used when this connection has no host to ask (see
   * {@link hostQueueSource}). It can only ever grow: once `session_send` resolves with `queued: true`
   * the message is the session's, and nothing here is told when the turn ahead of it ends — the next
   * send's own result is the sole reset (a `queued: false` send could only start its run because
   * everything ahead had drained). Measured 2026-10-12 (SPEC §18.1 F-3): that guess reached 10 while
   * the CLI's real depth peaked at 7 and then fell to 2, so a connection that CAN ask the host does
   * not use this at all.
   */
  let cliQueuedDeliveries = 0;
  /**
   * The UTF-8 bytes those same `queued: true` deliveries carried, moving with
   * {@link cliQueuedDeliveries} — see that field for when this is read at all.
   */
  let cliQueuedBytes = 0;
  /** Whether this connection reconciles its CLI term against a host reading. Set once, at construction. */
  const hostQueueSource = seams.hostQueueReading;
  /**
   * The last host sample for the bound session, or `null` when the last read failed.
   *
   * Only meaningful when {@link hostQueueSource} is set: `null` there is UNKNOWN depth, which is a
   * reading of its own — never the relay's own count, and never zero.
   */
  let hostQueueSample: HostQueueReading | null = null;

  /**
   * Samples the host's own queue reading for this connection's bound session.
   *
   * Called at each point the proxy REPORTS a depth — each delivery result, before each status line,
   * after a stop — because those are the only moments a fresh number is shown, and the CLI can drain
   * its queue between any two of them. A missing seam is a no-op; a seam that throws, or answers
   * `null`, leaves {@link hostQueueSample} at `null` so the depth reads as UNKNOWN rather than stale
   * (the failure §18.5 forbids is reusing the last count as if it were current).
   */
  const refreshHostQueue = (): void => {
    if (hostQueueSource === undefined) {
      return;
    }
    try {
      hostQueueSample = hostQueueSource(boundSessionId) ?? null;
    } catch {
      hostQueueSample = null;
    }
  };

  /**
   * The aftermath note waiting to ride the next message into the CLI, or `null`.
   *
   * Set by {@link sessionInterrupt} and consumed by {@link deliverSessionSend} when it composes a
   * message — see {@link buildInterruptAftermathNote} for why the turn has to be told at all. One per
   * connection and spent once: a second stop before the next message REPLACES it, because the newest
   * interruption is the one the next message needs to know about.
   *
   * WHICH MESSAGE IT RIDES (ruling 2026-10-16, this task). A stop that CARRIES A CORRECTION arms the
   * note BEFORE the correction is enqueued, so it rides THAT message: the correction is the message
   * the stop's own words go in on, and — per SPEC §18.4 G1 — at the abort the CLI delivers it into
   * the interrupt-closing turn, the very turn the note is about. It is the FIRST message into the CLI
   * after the interruption, which is the property AC-344 asks for, and it is the message whose reader
   * most needs to know ("Everything after this note is your current instruction" is true of the
   * correction and of nothing that was said before it).
   *
   * A stop that carries NO correction has no such message of its own, so the note is armed AFTER the
   * abort and after the backlog release, and rides whatever is delivered next. WHY AFTER THE RELEASE
   * THERE: that release delivers the message the stop did not throw away, which belongs to the turn
   * the stop closed rather than to the turn that follows it (SPEC §18.4: at an abort the CLI delivers
   * everything queued behind the run into the interrupt-closing turn). Attaching the note there would
   * announce an interruption to the very turn it interrupted.
   */
  let aftermathNote: string | null = null;

  /**
   * Whether the MOST RECENT {@link deliverSessionSend} prepended an armed {@link aftermathNote} to
   * the message it handed the CLI — the reading {@link sessionInterrupt} turns into the audit's
   * `noteCarried`.
   *
   * WHY A SEPARATE READING AND NOT "is the note still armed". A correction whose enqueue is not
   * confirmed has the note REVOKED ({@link sessionInterrupt}), which is the same `null` a spent note
   * leaves — the two are different facts and the audit has to tell them apart: "the note went out with
   * this correction and the stop was then refused / found no run" is measurable only if the delivery
   * says so. Written by the ONE place a note is spent, read by the stop that armed it; the caller
   * clears it immediately before its own delivery, and no other delivery can spend the note in
   * between (a second {@link deliverSessionSend} while one is in flight joins or throws — see the
   * single-flight `sending` there — and never reaches the compose step).
   */
  let lastDeliveryCarriedNote = false;

  /**
   * Reads the tool the run is executing right now, or `null` when that cannot be read.
   *
   * A missing seam, a seam that throws and a `null` reading are ONE answer: the stop records
   * `inFlightTool: null` and the note is the tool-free form. Guessing here would put a tool name into
   * the next turn's instruction that nothing observed, which is the failure C-3 exists to forbid.
   */
  const readInFlightTool = (): string | null => {
    const source = seams.hostRunActivity;
    if (source === undefined) {
      return null;
    }
    try {
      return source(boundSessionId)?.inFlightTool ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Whether the bound session has a turn IN FLIGHT — the reading that decides whether the relay holds
   * one merged message or keeps the 1 s coalescing window (ruling 2026-10-14).
   *
   * THREE ANSWERS, AND THE THIRD IS THE IMPORTANT ONE. `true`/`false` are the host saying busy/idle;
   * `null` is no answer at all — no seam, a seam that throws, a `null` reading, or a reading that
   * leaves {@link HostRunActivityReading.busy} out. `null` is NOT false: the relay cannot hold words
   * on a guess about a session it cannot see, and a deployment whose activity record does not speak
   * (or a bare proxy) must keep the behaviour it had before this reading existed. So the caller gates
   * the hold on `=== true` and treats every other answer as "carry on as before".
   */
  const readRunBusy = (): boolean | null => {
    const source = seams.hostRunActivity;
    if (source === undefined) {
      return null;
    }
    try {
      const reading = source(boundSessionId);
      return typeof reading?.busy === 'boolean' ? reading.busy : null;
    } catch {
      return null;
    }
  };

  /**
   * Which reading decided {@link readRunBusy}'s last answer, or `null` when there was none.
   *
   * THE AUDIT HALF OF THE SAME READING. A hold's release is the moment the 2026-10-14 evening defect
   * was invisible: the `busy hold released` line said the words were going in, never which reading
   * said the run was over. `'host-rounds'` means the resident driver's own `rounds` FIFO answered;
   * `'turn-phase'` means it could not and the activity phase did (see
   * {@link composeHostRunActivityReading}). Sampled once per release, together with `busy`, so the
   * two fields of the log suffix can never disagree.
   */
  const sampleRunBusy = (): { busy: boolean | null; source: 'host-rounds' | 'turn-phase' | null } => {
    const source = seams.hostRunActivity;
    if (source === undefined) {
      return { busy: null, source: null };
    }
    try {
      const reading = source(boundSessionId);
      return {
        busy: typeof reading?.busy === 'boolean' ? reading.busy : null,
        source: reading?.source ?? null,
      };
    } catch {
      return { busy: null, source: null };
    }
  };

  /**
   * The CLI term of the depth and byte readings: the session's own queue, and whether it is known.
   *
   * Three-way on purpose. A connection with NO host source reports its own optimistic count (the
   * pre-seam behaviour, kept for a bare proxy); one with a source whose last read failed reports
   * UNKNOWN, contributing nothing to the numbers and setting `known: false`; one with a live reading
   * reports it verbatim.
   */
  const cliQueueTerm = (): { known: boolean; items: number; bytes: number } => {
    if (hostQueueSource === undefined) {
      return { known: true, items: cliQueuedDeliveries, bytes: cliQueuedBytes };
    }
    if (hostQueueSample === null) {
      return { known: false, items: 0, bytes: 0 };
    }
    return { known: true, items: hostQueueSample.items, bytes: hostQueueSample.bytes };
  };

  /**
   * The `queuedMessageUuid` a delivery result carries, or `null` when it has none. Read as "a string
   * or nothing": a gateway that reports no uuid leaves the command unjoinable to a later `started`
   * event, and a fabricated key would join the wrong sentence.
   */
  const queuedMessageUuidOf = (result: unknown): string | null => {
    if (typeof result !== 'object' || result === null) {
      return null;
    }
    const uuid = (result as { queuedMessageUuid?: unknown }).queuedMessageUuid;
    return typeof uuid === 'string' && uuid !== '' ? uuid : null;
  };

  /**
   * Whether a delivery result CONFIRMS the message entered the CLI's OWN queue — the confirmation
   * the enqueue-then-abort half of G1 requires before it lets an abort run (SPEC §18.4 G1, GOAL-041
   * AC-342).
   *
   * `queued: true` is the gateway saying the run in flight took the message into its queue behind
   * it; a `queuedMessageUuid` is the per-command id the fence already keys on, and it stands as a
   * confirmation in its own right. EITHER counts, and nothing else does: a `queued: false` result
   * means the send STARTED A RUN rather than joining one — there was nothing in flight for the
   * correction to correct — and a result carrying neither is a delivery that never reached the
   * queue. Aborting on either would stop the very run the correction had just become.
   */
  const enqueueConfirmed = (result: unknown): boolean =>
    queuedMessageUuidOf(result) !== null ||
    (typeof result === 'object' && result !== null && (result as { queued?: unknown }).queued === true);

  /**
   * Records what command a delivery carried, for the fence's `commandUuid → utteranceSeq` map
   * (SPEC §18.3, GOAL-041 AC-343). The seq is the one STANDING at the delivery — the sentence the
   * model was answering when it relayed this message — so when the host later reports that command
   * `started`, the fence knows which utterance entered the run. No transcription heard yet (`0`)
   * means there is no utterance to name, so nothing is remembered.
   */
  const rememberDeliveredCommand = (result: unknown): void => {
    const uuid = queuedMessageUuidOf(result);
    if (uuid !== null && utteranceSeq > 0) {
      deliveredSeqByCommandUuid.set(uuid, utteranceSeq);
    }
  };

  /**
   * Folds the host's latest `command_lifecycle` `started` reading into {@link coveredSeqs}.
   *
   * The join the fence needs and the relay cannot make alone: the host names the `commandUuid`s it
   * dequeued; this connection maps each back to the utterance its delivery carried. A missing seam is
   * a no-op (the fence then has only its idempotent half); a seam that throws, or answers `null`,
   * adds nothing, so an unreadable lifecycle never looks like "nothing has started".
   */
  const refreshInterruptCovers = (): void => {
    const source = seams.hostCommandLifecycle;
    if (source === undefined) {
      return;
    }
    let reading: HostCommandLifecycleReading | null;
    try {
      reading = source(boundSessionId) ?? null;
    } catch {
      return;
    }
    if (reading === null) {
      return;
    }
    for (const uuid of reading.started) {
      const seq = deliveredSeqByCommandUuid.get(uuid);
      if (seq !== undefined) {
        coveredSeqs.add(seq);
      }
    }
  };

  /**
   * The person's delivered commands the host's queue has NOT yet dequeued — the reconcile set pushed
   * as {@link VoiceRealtimeOutboundFrame} `queue_reconcile`.
   *
   * THE JOIN THE PAGE CANNOT MAKE. This connection's own delivered `commandUuid`s
   * ({@link deliveredSeqByCommandUuid}) minus the host's `started` set: a command the host has taken
   * up (started, or started-then-completed) has left the queue, so it is NOT in this set and the row
   * it backs may clear; one the host still holds IS. A host reading that is absent, `null`, or throws
   * contributes no `started` uuid, so every delivered command reads as still waiting — which KEEPS
   * rows, the safe direction (only the host's own word clears a row, never the relay's silence).
   */
  const pendingQueueUuids = (): string[] => {
    const started = new Set<string>();
    const source = seams.hostCommandLifecycle;
    if (source !== undefined) {
      try {
        const reading = source(boundSessionId) ?? null;
        if (reading !== null) {
          for (const uuid of reading.started) {
            started.add(uuid);
          }
        }
      } catch {
        // Unreadable ⇒ no `started` reported ⇒ nothing is cleared. See the doc above.
      }
    }
    const pending: string[] = [];
    for (const uuid of deliveredSeqByCommandUuid.keys()) {
      if (!started.has(uuid)) {
        pending.push(uuid);
      }
    }
    return pending;
  };

  /**
   * Pushes the reconcile set to the page. Called at each state change the browser sees anyway — a
   * delivery result, a stop — so the row clears on the NEXT such event when a terminal lifecycle
   * frame was lost (the 2026-10-14 case), rather than needing a timer of its own.
   */
  const pushQueueReconcile = (): void => {
    const held = pendingQueueUuids();
    send({ type: 'queue_reconcile', queuedMessageUuids: held });
    lastReconcileKey = held.join('\u0000');
    armReconcilePoll(held.length > 0);
  };

  /** The held set the page was last told, joined — what the watch below compares a fresh read to. */
  let lastReconcileKey = '';
  /** The watch on a held command, or `null`. Armed only while the page shows one (see below). */
  let reconcilePollTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * While the page draws a held command as its waiting card, re-read the host once per status window
   * and push the set again the moment it moves (live 2026-10-15 86559798: the host took the command up
   * seconds after the stop, and the card stayed for minutes because only the NEXT delivery pushed a
   * reconcile). An unchanged set is not re-sent; an empty one ends the watch.
   */
  const armReconcilePoll = (watch: boolean): void => {
    if (reconcilePollTimer !== null) {
      clearTimeout(reconcilePollTimer);
      reconcilePollTimer = null;
    }
    if (!watch || closed) {
      return;
    }
    reconcilePollTimer = setTimeout(() => {
      reconcilePollTimer = null;
      if (closed) {
        return;
      }
      const held = pendingQueueUuids();
      if (held.join('\u0000') !== lastReconcileKey) {
        pushQueueReconcile();
        return;
      }
      armReconcilePoll(true);
    }, statusRateMs);
    reconcilePollTimer.unref?.();
  };

  /**
   * One RunDigest sample, from execution-plane facts this connection already holds (SPEC §12.5).
   *
   * The fence's own covers first ({@link refreshInterruptCovers}, so the digest and the stop fence
   * can never disagree about what the run has taken up), then the depth the line already shows, then
   * the tool the run is executing. `covers.last` is the LAST covered utterance's words; the line's
   * sanitiser is what keeps them from being the person's words verbatim (§8.4). Every term is a
   * reading of a seam that may answer `null`/throw — the honest "unreadable", never a guess.
   */
  const sampleRunDigest = (): VoiceRealtimeRunDigestPatch => {
    refreshInterruptCovers();
    let lastCoveredSeq = 0;
    for (const seq of coveredSeqs) {
      if (seq > lastCoveredSeq) {
        lastCoveredSeq = seq;
      }
    }
    const queued = cliQueueTerm();
    return {
      covers: {
        count: coveredSeqs.size,
        last: lastCoveredSeq === 0 ? null : (utteranceTextBySeq.get(lastCoveredSeq) ?? null),
      },
      queuedNotStarted: { count: queued.known ? queued.items : null, last: lastQueuedNotStartedText },
      lastCliActivity: { tool: readInFlightTool() },
    };
  };

  /**
   * Sends one composed instruction and reports it, with the conversation boundary it ANSWERS.
   *
   * `answeredThroughItemId` is the boundary read WHEN THE MODEL PRODUCED THE INSTRUCTION, never the
   * one standing when the frame happens to leave. The two are seconds apart — a busy session holds a
   * send until its turn ends, and a coalescing window holds the pieces for `coalesceMs` — and speech
   * committed during that wait was NOT in front of the model when it decided what to relay. Reading
   * the boundary at the frame made the first delivery claim sentences it had never seen: the page
   * attributes every caption up to this boundary to THIS delivery, so `item_vad_2` (the half of the
   * merged message the model had not been shown yet) was swallowed by the delivery before it and the
   * merged delivery was left owning no sentence at all
   * (`gap-voice-delivered-merged-message-invisible-in-transcript`, 2026-10-13).
   *
   * The default is the boundary as of NOW, which is the relay moment for a call delivered without
   * waiting; a caller that separated the relay from the send passes the boundary it captured then.
   */
  const deliverSessionSend = async (
    args: Record<string, unknown>,
    answeredThroughItemId: string | null = lastCommittedUserItemId,
  ): Promise<unknown> => {
    let answeredThrough = answeredThroughItemId;
    if (sending) {
      if (waitingForBusySession) {
        // Something more was said while the session is still busy. It joins the waiting message
        // (one delivery, in order) instead of being refused or replacing what was said before it.
        if (typeof args.message === 'string' && args.message.trim() !== '') {
          waitingExtraMessages.push(args.message);
          // The joined words were relayed LATER, by a call of their own, so the boundary that covers
          // them is the one standing now rather than the one this send started with.
          answeredThrough = lastCommittedUserItemId;
        }
        seams.log?.(`session_send joined the instruction waiting for the session`);
        return {
          accepted: true,
          instruction: `The message was accepted and joins the one already waiting. Do not call session_send again for it. ${acceptedTail}`,
        };
      }
      throw new Error('A previous voice instruction is still being sent.');
    }
    sending = true;
    try {
      const intervalMs = seams.busyRetry?.intervalMs ?? BUSY_RETRY_INTERVAL_MS;
      const maxMs = seams.busyRetry?.maxMs ?? BUSY_RETRY_MAX_MS;
      const startedAt = Date.now();
      let told = false;
      seams.log?.(`session_send start ${JSON.stringify(args).slice(0, 200)}`);
      for (;;) {
        try {
          const composed =
            waitingExtraMessages.length === 0
              ? args
              : { ...args, message: [String(args.message ?? ''), ...waitingExtraMessages].join(' ') };
          // ── THE INTERRUPT AFTERMATH NOTE (SPEC §0.3 D-8 / §18.5, GOAL-041 AC-344) ──
          // A stop leaves a note for the message that follows it (see `aftermathNote`): the reader of
          // that message is the one that has to be told which tool the previous turn stopped in and
          // that partial changes may remain. Prepended HERE, where the text that actually crosses into
          // the CLI is composed, so a coalesced batch and a release that joined extra messages all
          // carry it — and spent here, for the same reason: "the first message after the interrupt" is
          // a property of the delivery, not of the caller. WHICH message that is — the stop's own
          // correction, or the next thing said after a stop that carried none — is decided by WHEN the
          // note was armed, in `sessionInterrupt`.
          const payload =
            aftermathNote !== null && typeof composed.message === 'string' && composed.message.trim() !== ''
              ? { ...composed, message: `${aftermathNote}\n\n${composed.message}` }
              : composed;
          if (payload !== composed) {
            aftermathNote = null;
            lastDeliveryCarriedNote = true;
          }
          const result = await base.session_send(payload);
          seams.log?.(`session_send delivered in ${Date.now() - startedAt} ms`);
          // The fence's record of what this command carried (SPEC §18.3, GOAL-041 AC-343): the
          // `commandUuid` the host acknowledged, paired with the `utteranceSeq` standing now, so a
          // later `command_lifecycle` `started` for that uuid resolves back to this sentence.
          rememberDeliveredCommand(result);
          // The readings the depth and the byte total are made of, updated BEFORE the frame that
          // reports them. A `queued: true` result is one more of the person's messages the session
          // is holding, and its text adds to the bytes it holds; a `queued: false` one started a
          // run, which could only happen with the queue ahead of it drained — so it is the one
          // moment both readings can be reset rather than incremented. The joined messages have just
          // been delivered inside `payload`, so they leave the buffer here rather than a whole turn
          // later in the `finally` below.
          const queuedResult =
            typeof result === 'object' && result !== null && (result as { queued?: unknown }).queued === true;
          // The relay's own guess is only kept when there is no host to ask (see `cliQueueTerm`); a
          // connection with a host samples it HERE, at the delivery result, which is the first moment
          // a drain the CLI performed during the send becomes visible.
          if (hostQueueSource === undefined) {
            cliQueuedDeliveries = queuedResult ? cliQueuedDeliveries + 1 : 0;
            cliQueuedBytes = queuedResult ? cliQueuedBytes + voiceMessageBytes(payload.message) : 0;
          } else {
            refreshHostQueue();
          }
          // The RunDigest's `queuedNotStarted.last`: the last message the session took into its queue
          // and has not begun. A `queued: false` result STARTED a run — the queue ahead of it drained
          // — so the text clears with the count rather than going stale behind it.
          lastQueuedNotStartedText = queuedResult && typeof payload.message === 'string' ? payload.message : null;
          waitingExtraMessages = [];
          send({
            type: 'sent',
            sessionId: boundSessionId,
            result,
            depth: queuedDepth(),
            bytes: queuedBytes(),
            ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
            // The conversation boundary this delivery answers up to, read when the model produced the
            // instruction — see `deliverSessionSend`. Absent only when the endpoint had committed
            // nothing yet AT THAT MOMENT, which is a connection that had heard no speech then: there is
            // nothing to attribute and the browser falls back to its own window.
            ...(answeredThrough === null ? {} : { coveredThroughItemId: answeredThrough }),
          });
          // The host's reconcile account, pushed with each delivery result: a row whose terminal
          // lifecycle frame is lost still clears here once the host stops reporting its command.
          pushQueueReconcile();
          // S-A: this result is the one reading that says which run the session is on and whether
          // this message started it or is waiting behind one. Folded in AFTER the frame that reports
          // the same depth/bytes, so the browser sees the delivery and the status line agrees with it.
          noteStatus({
            phase: queuedResult ? 'queued' : 'running',
            runId: runIdOf(result),
            queuedItems: queuedDepth(),
            queuedBytes: queuedBytes(),
          });
          return result;
        } catch (error) {
          // A session that is mid-turn refuses a new run. A person talking to Claude
          // while it works means "after this", not "never": wait for the turn to end
          // (bounded), say so once, and deliver. Without this the instruction was
          // dropped, the model heard nothing back, and the user saw nothing happen.
          const busy = (error as { code?: unknown } | null)?.code === 'SESSION_BUSY';
          if (!busy || closed || Date.now() - startedAt >= maxMs) {
            seams.log?.(`session_send failed after ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
          if (!told) {
            told = true;
            send({
              type: 'error',
              code: 'SESSION_BUSY',
              message: 'Claude is still working in this session; your instruction will be sent as soon as it finishes.',
              recoverable: true,
            });
          }
          waitingForBusySession = true;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    } finally {
      sending = false;
      waitingForBusySession = false;
      waitingExtraMessages = [];
    }
  };

  // ---- coalescing: one spoken thought is one message ----------------------------------------
  const coalesceMs = seams.coalesceMs ?? 0;
  let pendingParts: string[] = [];
  let pendingExtra: Record<string, unknown> = {};
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The conversation boundary the pieces in the window answer: the boundary the LAST piece saw when
   * the model produced it, stamped at acceptance rather than read at the flush.
   *
   * WHY NOT AT THE FLUSH. The window closes `coalesceMs` after its LAST piece, and a person still
   * talking re-arms it, so a flush can be seconds after the earliest piece was relayed — long enough
   * for the endpoint to commit sentences the model had not been shown when it relayed that piece.
   * The page attributes every caption up to the boundary to the delivery, so a boundary read late
   * hands this delivery sentences it never carried and leaves the next delivery owning none (see
   * `deliverSessionSend`, and the merged message it made invisible).
   */
  let pendingBoundary: string | null = null;

  /**
   * How many of the person's messages are WAITING right now — the COUNT reading the page is shown.
   *
   * Three terms, one per place a message can be waiting, and no term for the delivery being handed
   * over: a delivery in flight is not waiting, it is being delivered.
   *
   *   · the coalescing window, as ONE. However many pieces of a paused sentence landed in
   *     `pendingParts`, they are joined into one message at the flush — counting the pieces would
   *     refuse the tail of a sentence that was always going to be one message.
   *   · the utterances joined into an outstanding busy wait, one each. These are NOT pieces of one
   *     sentence: the window is 1 s and a busy turn can run for two minutes, so a person who keeps
   *     talking into a working session has really said that many things, and each is waiting.
   *   · the session's own queue, read from the host when this connection can ask it
   *     ({@link cliQueueTerm}). When it can and the read fails, the term is UNKNOWN and contributes
   *     nothing — the count the page is shown is then the L3 terms alone, and
   *     {@link VoiceRealtimeExecStatusReading.queuedKnown} says so rather than letting the page read
   *     a partial number as complete.
   *
   * The bound is NOT judged against this any more (see {@link VOICE_QUEUE_MAX_BYTES}); it is kept
   * because the page shows "how many waiting" beside "how much", and the two answer different
   * questions — three short sentences and one long paragraph are both one waiting message to the
   * count.
   */
  const queuedDepth = (): number =>
    (pendingParts.length > 0 ? 1 : 0) + waitingExtraMessages.length + cliQueueTerm().items;

  const joinParts = (parts: readonly string[]): string => {
    let out = '';
    for (const part of parts) {
      const next = part.trim();
      if (next === '') continue;
      // No space between two CJK pieces; one between anything else.
      const cjkBoundary = /[\u3000-\u9fff\uff00-\uffef]$/.test(out) && /^[\u3000-\u9fff\uff00-\uffef]/.test(next);
      out = out === '' ? next : `${out}${cjkBoundary ? '' : ' '}${next}`;
    }
    return out;
  };

  /**
   * How many UTF-8 bytes of the person's text are WAITING right now — the reading the bound is
   * judged against, and the one the page shows as "待投递 N 字" (AC1/AC3).
   *
   * The same three terms as {@link queuedDepth}, each measured in bytes rather than counted, and each
   * measured the way it will be delivered: the coalescing window is joined into the one message it
   * will become (so a paused sentence is charged once, at its true length, not piece by piece), and
   * the busy-wait utterances are summed as separate messages (they arrive as separate sends, joined
   * into one payload — the space the join adds between them is not charged, which under-states the
   * pending total by at most a space per seam; that is the safe direction, because it can accept a
   * sliver too much and never refuse a sentence that fits).
   */
  const queuedBytes = (): number =>
    (pendingParts.length > 0 ? voiceMessageBytes(joinParts(pendingParts)) : 0) +
    waitingExtraMessages.reduce((sum, message) => sum + voiceMessageBytes(message), 0) +
    cliQueueTerm().bytes;

  /** The open turn-boundary poll, or `null`. Armed while a run is believed active; see {@link armDrainPoll}. */
  let drainPollTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Arms — or disarms — the turn-boundary refresh (SPEC §18.5's 「回合边界深度误差 = 0」, GOAL-041
   * AC-344; see {@link VoiceRealtimeProxySeams.hostQueueTurnBoundaryRefresh} for WHY a bounded poll).
   *
   * Called from {@link noteStatus} after every observation, so the poll is present exactly while the
   * status says a run is live: a patch that moves the phase to `idle` (a stop, a teardown) calls this
   * and the stale timer is dropped rather than left to fire into a settled connection. Idempotent —
   * an already-armed poll is left alone and re-arms itself from {@link pollDrain}.
   */
  const armDrainPoll = (): void => {
    if (
      seams.hostQueueTurnBoundaryRefresh === false ||
      hostQueueSource === undefined ||
      closed ||
      bridge.state !== 'open' ||
      execStatus.reading().phase === 'idle'
    ) {
      if (drainPollTimer !== null) {
        clearTimeout(drainPollTimer);
        drainPollTimer = null;
      }
      return;
    }
    if (drainPollTimer !== null) {
      return;
    }
    drainPollTimer = setTimeout(pollDrain, statusRateMs);
    drainPollTimer.unref?.();
  };

  /**
   * One turn-boundary sample: re-read the host and, if the depth MOVED with no event to say so, put
   * the fresh reading on the wire through the SAME path every other change takes.
   *
   * The move is real only when the number, the byte count or the known/unknown flag differs from the
   * aggregator's stored reading — so a poll over an unchanged queue folds nothing and injects nothing
   * (AC2: the dedup still holds, and no periodic no-change line is ever sent — §8.3). When it HAS
   * moved, {@link noteStatus} folds it and opens a window; the poll then ends that window itself,
   * because a poll IS this window's boundary — the refresh must land within ONE S-A window of the
   * drain, not two. A host that answers `null` moves the reading to UNKNOWN (never back to a zero),
   * which is itself a change the dedup reports.
   */
  const pollDrain = (): void => {
    drainPollTimer = null;
    if (closed || bridge.state !== 'open') {
      return;
    }
    const before = execStatus.reading();
    if (before.phase === 'idle') {
      return;
    }
    refreshHostQueue();
    const depth = queuedDepth();
    const bytes = queuedBytes();
    const known = cliQueueTerm().known;
    const moved = depth !== before.queuedItems || bytes !== before.queuedBytes || known !== (before.queuedKnown !== false);
    if (moved) {
      send({ type: 'queue_depth', depth, bytes });
      noteStatus({ phase: before.phase, runId: before.runId, queuedItems: depth, queuedBytes: bytes });
      if (statusTimer !== null) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      flushStatus();
    }
    armDrainPoll();
  };

  // ---- the narrator's run-end summary (TEXT layer) ---------------------------------------------
  //
  // Gated on the seam: no narrator means no timer, no host sample, no behaviour change. See
  // `VoiceRealtimeProxySeams.runEndSummary` for the contract and the settle wait's purpose.
  const runEndSummary = seams.runEndSummary;
  const runEndAck = seams.runEndAck;
  const runEndSettleMs = runEndSummary?.settleMs ?? DEFAULT_RUN_END_SUMMARY_SETTLE_MS;
  const runEndOutputWaitMs = runEndSummary?.outputWaitMs ?? DEFAULT_RUN_OUTPUT_WAIT_MS;
  const runEndPollMs = runEndSummary?.pollMs ?? DEFAULT_RUN_END_SUMMARY_POLL_MS;
  const runEndVerbatimTailMax = runEndSummary?.verbatimTailMax ?? RUN_END_SUMMARY_MAX_VERBATIM_TAIL;
  /** The open run-end watcher, or `null`. Armed only while the status says a run is live. */
  let runEndWatchTimer: ReturnType<typeof setTimeout> | null = null;
  /** The open settle wait between a transition and the output request, or `null`. */
  let runEndSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The one `run_output` request outstanding for this connection, or `null`. */
  let runOutputPending: { requestId: string; generation: number; runId: string | null } | null = null;
  /** The wait for that request's answer, or `null`. */
  let runOutputTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic per connection: every request is named, so a late reply cannot answer a newer ask. */
  let runOutputSeq = 0;
  /**
   * Bumped by every transition and by teardown, so an ASYNC summarizer that resolves after a newer
   * run ended (or after the connection died) cannot inject a stale summary. `null` of the two is
   * "exactly once per transition" across the one await this machinery has.
   */
  let runEndGeneration = 0;

  /** Drops the settle wait. Idempotent; the summarizer's own generation guard is the other half. */
  const clearRunEndSettle = (): void => {
    if (runEndSettleTimer !== null) {
      clearTimeout(runEndSettleTimer);
      runEndSettleTimer = null;
    }
  };

  /**
   * Speaks the fixed run-end confirmation, if this deployment wired one.
   *
   * Called at the `running → idle` transition, BEFORE the settle timer is armed. Deliberately reads
   * nothing but the run id: no context pack, no summarizer, no quality gate — the ack must arrive
   * even when the summary has nothing to say. Absence of the seam is the pre-ack wire.
   */
  const speakRunEndAck = (): void => {
    if (runEndAck === undefined || closed) return;
    const runId = execStatus.reading().runId;
    runEndAck.speak({ runId });
    seams.log?.(`run-end ack run=${runId ?? '-'}`);
  };

  /** Drops an outstanding output request and its wait. Idempotent. */
  const clearRunOutputRequest = (): void => {
    if (runOutputTimer !== null) {
      clearTimeout(runOutputTimer);
      runOutputTimer = null;
    }
    runOutputPending = null;
  };

  /**
   * Asks the PAGE for the output THIS run produced — the summary's only source.
   *
   * The turn is rendered by the page at request time from its own transcript, so nothing is
   * cached here and no pack can go stale. `requestId` names the ask; a reply for an older id is
   * ignored, and a page that never answers costs one logged silence.
   */
  const requestRunOutput = (generation: number, runId: string | null): void => {
    if (runEndSummary === undefined || closed) return;
    clearRunOutputRequest();
    const requestId = `run-output-${(runOutputSeq += 1)}`;
    runOutputPending = { requestId, generation, runId };
    send({ type: 'run_output_request', requestId });
    runOutputTimer = setTimeout(() => {
      runOutputTimer = null;
      if (runOutputPending?.requestId !== requestId) return;
      runOutputPending = null;
      seams.log?.(`run-end summary skipped: the page did not answer ${requestId}`);
    }, runEndOutputWaitMs);
    runOutputTimer.unref?.();
  };

  /**
   * Summarizes exactly the text the page returned for one run, judges the answer, and injects it.
   *
   * A summary that breaks the narrator's readings (Markdown glyphs, or the output's own tail read
   * back) is NOT injected — a violation is logged rather than voiced. LENGTH is a reading, not a
   * refusal: `qwen-flash` answers run 42–44 chars and are still plain speech.
   */
  const summarizeRunOutput = async (
    generation: number,
    runId: string | null,
    output: string,
  ): Promise<void> => {
    if (runEndSummary === undefined || closed) return;
    const source = output.trim();
    if (source === '') {
      seams.log?.('run-end summary skipped: the run produced no visible output');
      return;
    }
    let raw: string | null;
    try {
      raw = await runEndSummary.summarize({ output: source, runId });
    } catch (error) {
      seams.log?.(
        `run-end summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // A newer run ended (or the connection died) while the side model was thinking: this answer is
    // about a run the person has already moved past. Dropped, not injected late.
    if (generation !== runEndGeneration || closed) return;
    // ONE line of speech: the model's newlines/indentation are not a spoken structure.
    const text = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (text === '') {
      seams.log?.('run-end summary skipped: the narrator returned nothing');
      return;
    }
    const quality = readVoiceRealtimeSummaryQuality(text, source);
    if (quality.markdown.length > 0 || quality.verbatimTail > runEndVerbatimTailMax) {
      seams.log?.(
        `run-end summary refused: chars=${quality.chars} ` +
          `markdown=[${quality.markdown.join('')}] verbatimTail=${quality.verbatimTail}/${runEndVerbatimTailMax}`,
      );
      return;
    }
    runEndSummary.inject(text, { runId });
    seams.log?.(
      `run-end summary injected chars=${quality.chars} verbatimTail=${quality.verbatimTail} run=${runId ?? '-'}`,
    );
  };

  /**
   * Arms the settle wait for one `running → idle` transition.
   *
   * A pending wait is DROPPED and its generation invalidated: two transitions inside one settle
   * window describe two runs, and only the later one is still what the person is looking at.
   */
  const scheduleRunEndSummary = (): void => {
    if (runEndSummary === undefined || closed) return;
    const generation = (runEndGeneration += 1);
    const runId = execStatus.reading().runId;
    clearRunEndSettle();
    runEndSettleTimer = setTimeout(() => {
      runEndSettleTimer = null;
      requestRunOutput(generation, runId);
    }, runEndSettleMs);
    runEndSettleTimer.unref?.();
  };

  /**
   * Samples the host's activity while a run is believed live; `busy: false` settles the status.
   *
   * The relay is never told a run ended, so this bounded poll is how `running → idle` is observed at
   * all. Only an EXPLICIT `false` ends the run — an absent seam, a throw, a `null` reading or a
   * reading without `busy` all mean "cannot say" and leave the watcher waiting (the same three-way
   * reading the busy hold uses, see `readRunBusy`).
   */
  const pollRunEnd = (): void => {
    runEndWatchTimer = null;
    if (closed || bridge.state !== 'open') return;
    const current = execStatus.reading();
    if (current.phase === 'idle') return;
    if (readRunBusy() !== false) {
      armRunEndWatch();
      return;
    }
    // The transition itself: `noteStatus` detects `running → idle` and arms the settle wait, so the
    // stop path and this natural end share one trigger rather than two.
    noteStatus({
      phase: 'idle',
      runId: current.runId,
      queuedItems: queuedDepth(),
      queuedBytes: queuedBytes(),
    });
  };

  /**
   * Arms — or drops — the run-end watcher from the status reading standing now.
   *
   * Idempotent, and called after every status observation so the timer exists exactly while a run is
   * live. A transition to `idle` clears it; a connection torn down clears it (see `teardown`).
   */
  const armRunEndWatch = (): void => {
    if (runEndSummary === undefined || seams.hostRunActivity === undefined) return;
    if (closed || bridge.state !== 'open' || execStatus.reading().phase === 'idle') {
      if (runEndWatchTimer !== null) {
        clearTimeout(runEndWatchTimer);
        runEndWatchTimer = null;
      }
      return;
    }
    if (runEndWatchTimer !== null) return;
    runEndWatchTimer = setTimeout(pollRunEnd, runEndPollMs);
    runEndWatchTimer.unref?.();
  };

  /**
   * Delivers the merged message and empties the buffer.
   *
   * `busyRelease` names WHICH way a busy hold ended, and is `null` for every release that is not one
   * (the 1 s coalescing window, the teardown, the interrupt fold). It decides two things and nothing
   * else: the journal's wording, and — for {@link VoiceBusyRelease} `'quiet-window'` alone — the tier
   * the frame is written under. See {@link VOICE_BUSY_RELEASE_PRIORITY}.
   */
  const flushCoalesced = (busyRelease: VoiceBusyRelease | null = null): void => {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    if (pendingParts.length === 0) {
      // Nothing to deliver, but the two timers a hold armed and has since been spent are dropped here
      // too — this is the single exit every release runs through (the flush, the stop, the teardown).
      clearBusyPoll();
      clearBusyQuiet();
      return;
    }
    const engaged = busyBufferEngaged;
    const message = joinParts(pendingParts);
    const extra = pendingExtra;
    // What the window's last piece answered, captured when the model relayed it — see
    // `pendingBoundary`. Taken before the buffers are cleared, so the join is delivered with the
    // boundary it was produced against rather than the one standing `coalesceMs` later.
    const boundary = pendingBoundary;
    // Only the quiet window's release names a tier. Every other release — including the run ending
    // one — writes the frame exactly as it did before this feature existed, so "which release asked
    // for `next`" stays a property of THIS branch rather than of `flushCoalesced` as a whole.
    const priority = busyRelease === 'quiet-window' ? VOICE_BUSY_RELEASE_PRIORITY : null;
    // The release's own readings, appended AFTER the original wording (which is left byte-for-byte —
    // the journal and the criteria read it): what `busy` said and which source said it, so a mid-turn
    // release (the 2026-10-14 evening defect) can be attributed afterwards instead of guessed at (AC3).
    // Sampled only when a hold is really being released; the coalescing window's line pays nothing.
    let releaseLine = `coalesced ${pendingParts.length} relayed piece(s) into one message`;
    if (engaged) {
      const { busy: releaseBusy, source: releaseSource } = sampleRunBusy();
      const why = busyRelease === 'quiet-window' ? 'busy quiet window released' : 'busy hold released';
      releaseLine =
        `${why}: delivering the ONE merged message (${pendingParts.length} relayed piece(s))` +
        ` busy=${releaseBusy === null ? 'null' : String(releaseBusy)} source=${releaseSource ?? 'null'}` +
        (priority === null ? '' : ` priority=${priority}`);
    }
    seams.log?.(releaseLine);
    // Clears `pendingParts`/`pendingExtra`/`pendingBoundary`, drops the hold poll, and takes the card
    // down (the clear frame) when this buffer was the busy hold's. Done BEFORE the delivery so the
    // card is gone by the time `sent` confirms the words landed.
    resetHeldBuffer();
    void deliverSessionSend({ ...extra, message, ...(priority === null ? {} : { priority }) }, boundary).catch((error: unknown) => {
      // The model has already been told the call was accepted; a late failure surfaces here.
      send(
        errorFrame(
          'TOOL_EXECUTION_FAILED',
          `The instruction could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
      );
    });
  };

  const armCoalesce = (): void => {
    // A HELD MESSAGE IS NOT ON THE COALESCING WINDOW'S CLOCK. While the busy hold is engaged the 1 s
    // window must not reopen under it. The caption path below ("the person is still talking: the quiet
    // window starts over") arms this timer on EVERY final transcription, so without this guard an
    // utterance transcribed a moment after a held piece put the hold back on the window's clock and
    // flushed it about a second later — delivering the merged message into the CLI's queue while the
    // session was still busy, which is exactly the mid-turn release the 2026-10-14 evening defect was,
    // reached from the caption side instead of the phase side. A connection with no live hold
    // (`busyBufferEngaged` false — every deployment whose activity record cannot say, and every
    // criterion written before the ruling) is unchanged.
    //
    // THE HOLD HAS ITS OWN CLOCK INSTEAD (X3' replay, 2026-10-15). The busy hold is released by the
    // QUIET WINDOW — the upstream having stopped speaking for {@link VOICE_BUSY_QUIET_WINDOW_MS} —
    // and never by the run ending alone; but that window is armed off the upstream's own turn
    // reporting and the buffer's own pieces (see `armBusyQuietWindow`), never off `coalesceMs`. So a
    // caption re-arms the HOLD's window here rather than the coalescing one: same guard, two clocks.
    if (busyBufferEngaged) {
      armBusyQuietWindow();
      return;
    }
    if (pendingParts.length === 0) return;
    if (coalesceTimer !== null) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(flushCoalesced, coalesceMs);
    coalesceTimer.unref?.();
  };

  // ---- the ONE merged pending message (ruling 2026-10-14) -----------------------------------
  //
  // WHAT THIS IS FOR. Until this ruling a sentence spoken while Claude was busy became a command in
  // the CLI's own queue the moment the model relayed it, and the CLI merged those commands into one
  // only at the turn boundary — so the page drew one row per sentence and the person watched a stack
  // of them (the 2026-10-14 morning reading: two registries disagreeing and a row that would not go).
  // Under this ruling the merge happens HERE, one layer earlier: while the session is busy every
  // relayed piece joins the SAME buffer, nothing reaches the CLI until the run ends, and the whole
  // thing goes in as ONE message. The buffer is the proxy's, not the page's — the page is only told
  // what it says (the `pending` frame), and the person gets ONE read-only card instead of a stack.
  //
  // WHY THE HOST'S `busy` READING GATES IT. `readRunBusy()` answering `true` is a CLAIM the host makes
  // about a turn in flight; every other answer (no seam, a throw, a `null`, a reading without `busy`)
  // leaves the relay exactly as it was. So a deployment whose activity record cannot say, and every
  // criterion written before this ruling, keep the 1 s coalescing window and the delivery into the
  // CLI's queue — and this connection never speaks a `pending` frame.
  /** How often a held message re-reads the host; see {@link VoiceRealtimeProxySeams.busyPollMs}. */
  const busyPollMs = seams.busyPollMs ?? VOICE_REALTIME_BUSY_POLL_MS;
  /** The busy hold's own three numbers; see {@link VoiceRealtimeProxySeams.busyQuietWindowMs}. */
  const busyQuietWindowMs = seams.busyQuietWindowMs ?? VOICE_BUSY_QUIET_WINDOW_MS;
  const busyQuietSincePieceMs = seams.busyQuietSincePieceMs ?? VOICE_BUSY_QUIET_SINCE_PIECE_MS;
  const busyQuietCapMs = seams.busyQuietCapMs ?? VOICE_BUSY_QUIET_CAP_MS;
  /** The open hold poll, or `null`. Armed only while {@link pendingParts} is non-empty. */
  let busyPollTimer: ReturnType<typeof setTimeout> | null = null;
  /** The open quiet-window timer, or `null`. The other way a hold ends; see `armBusyQuietWindow`. */
  let busyQuietTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * When the FIRST piece of the hold now in progress joined the buffer, or `null` when nothing is
   * held. {@link VOICE_BUSY_QUIET_CAP_MS} is counted from here, so a person who talked over the whole
   * window cannot push the release out with every new piece.
   */
  let busyWindowOpenedAt: number | null = null;
  /**
   * When the LAST piece joined the buffer, or `null` when nothing is held. The floor under the quiet
   * window ({@link VOICE_BUSY_QUIET_SINCE_PIECE_MS}) is counted from here: a piece relayed into an
   * already-quiet session must still be given the merge window the 1 s coalescing path would give it.
   */
  let lastBusyPieceAt: number | null = null;
  /**
   * Whether the UPSTREAM's own turn is open — `speech_started` seen, no `speech_stopped`/commit
   * since (`onUpstreamTurn`). This is the relay's reading of "the person is still talking", and the
   * quiet window is only allowed to release while it is `false`.
   */
  let upstreamTalking = false;
  /**
   * When the upstream last CLOSED its turn, or `null` if it has not done so since this connection
   * opened. The window's {@link VOICE_BUSY_QUIET_WINDOW_MS} is counted from here.
   *
   * `null` is load-bearing: an endpoint that has never reported a closed turn gives the quiet window
   * nothing to count from, so the hold then waits for the run to end (what `pollBusy` alone did) or
   * for the cap — never for a quiet that was never observed.
   */
  let lastUpstreamSilenceAt: number | null = null;
  /**
   * Whether this connection is HOLDING a merged message for a busy session — which is also the
   * question "does this connection speak the `pending` frame at all?".
   *
   * Set the first time the busy branch below puts a piece in the buffer and cleared wherever the
   * buffer is spent. It is what keeps the two waits apart: the 1 s coalescing window announces
   * itself with `queued` and is unchanged by this feature, and only a hold emits `pending`.
   */
  let busyBufferEngaged = false;

  /** Tells the browser what the held message says right now (one frame per change; AC1/AC2). */
  const emitPending = (): void => {
    if (closed) return;
    const text = joinParts(pendingParts);
    send({ type: 'pending', text, bytes: voiceMessageBytes(text) });
  };

  /** Drops the hold poll. Idempotent, and safe to call when none is armed. */
  const clearBusyPoll = (): void => {
    if (busyPollTimer !== null) {
      clearTimeout(busyPollTimer);
      busyPollTimer = null;
    }
  };

  /** Drops the quiet window's timer. Idempotent, and safe to call when none is armed. */
  const clearBusyQuiet = (): void => {
    if (busyQuietTimer !== null) {
      clearTimeout(busyQuietTimer);
      busyQuietTimer = null;
    }
  };

  /**
   * The instant the held message is due to leave on the quiet window, from the readings standing
   * right now — `null` when this connection has no quiet window at all (both numbers non-positive).
   *
   * THE REPLAY'S OWN ARITHMETIC (`experiments/voice-now-priority/x3-replay.mts`, the D arm):
   * `due = max(lastPiece + 800, lastStop + 2000)`, capped at `buf[0] + 20_000`, and released only
   * while the person is NOT talking. Every term is a reading this side already has: the last piece's
   * arrival (`lastBusyPieceAt`), the last turn close (`lastUpstreamSilenceAt`, from `onUpstreamTurn`)
   * and the hold's first piece (`busyWindowOpenedAt`). While the upstream's turn is OPEN — or has
   * never closed — only the cap applies, so "still talking" can never be read as "quiet".
   *
   * The cap is applied with `Math.min`, so the window can only ever pull the release EARLIER than the
   * cap; an upstream quiet longer than the cap releases at the cap, not later.
   */
  const busyQuietDueAt = (now: number): number | null => {
    if (busyQuietWindowMs <= 0 && busyQuietCapMs <= 0) {
      return null;
    }
    const capDue = (busyWindowOpenedAt ?? now) + busyQuietCapMs;
    if (busyQuietCapMs <= 0) {
      // The cap is switched off; the window alone decides, and only once the upstream has gone quiet.
      return !upstreamTalking && lastUpstreamSilenceAt !== null
        ? Math.max((lastBusyPieceAt ?? now) + busyQuietSincePieceMs, lastUpstreamSilenceAt + busyQuietWindowMs)
        : Number.POSITIVE_INFINITY;
    }
    if (upstreamTalking || lastUpstreamSilenceAt === null || busyQuietWindowMs <= 0) {
      return capDue;
    }
    return Math.min(
      capDue,
      Math.max((lastBusyPieceAt ?? now) + busyQuietSincePieceMs, lastUpstreamSilenceAt + busyQuietWindowMs),
    );
  };

  /**
   * Arms — or drops — the quiet window's release timer from the readings standing now.
   *
   * Called from the three places a term of {@link busyQuietDueAt} can change: the upstream closing
   * its turn, the upstream opening it again, a piece joining the hold, and the caption path's own
   * re-arm (see `armCoalesce`). It is idempotent — re-arming with unchanged readings computes the
   * same deadline — so being called more often than strictly necessary costs a timer, never a release.
   */
  const armBusyQuietWindow = (): void => {
    clearBusyQuiet();
    if (!busyBufferEngaged || closed || bridge.state !== 'open') {
      return;
    }
    const due = busyQuietDueAt(Date.now());
    if (due === null) {
      return;
    }
    // `setTimeout` wraps a delay past 2^31-1 ms back to 1 ms, so a window configured "infinite" (the
    // AC's false form) is clamped to the ceiling rather than fired immediately.
    const delay = Math.min(Math.max(0, due - Date.now()), VOICE_MAX_TIMER_DELAY_MS);
    busyQuietTimer = setTimeout(releaseBusyQuiet, delay);
    busyQuietTimer.unref?.();
  };

  /**
   * The quiet window's deadline arrived. Releases the hold, or re-arms when the deadline moved under
   * the timer — the SAME re-judgement `pollBusy` makes of `busy`, done here against the window's own
   * three readings so a piece that arrived (or speech that resumed) after the timer was armed is not
   * flushed under.
   */
  const releaseBusyQuiet = (): void => {
    busyQuietTimer = null;
    if (!busyBufferEngaged || closed || bridge.state !== 'open') {
      return;
    }
    const now = Date.now();
    const due = busyQuietDueAt(now);
    if (due === null) {
      return;
    }
    if (now < due) {
      const delay = Math.min(due - now, VOICE_MAX_TIMER_DELAY_MS);
      busyQuietTimer = setTimeout(releaseBusyQuiet, delay);
      busyQuietTimer.unref?.();
      return;
    }
    flushCoalesced('quiet-window');
  };

  /**
   * Empties the held message: the parts, their extra/boundary, the poll, and — when a hold was
   * actually shown — the `pending{text:''}` frame that takes the card down.
   *
   * The ONE reset every way of spending the buffer goes through (the flush, the interrupt fold, the
   * teardown), so the state and the page can never disagree about whether something is held.
   */
  const resetHeldBuffer = (): void => {
    clearBusyPoll();
    clearBusyQuiet();
    const wasEngaged = busyBufferEngaged;
    pendingParts = [];
    pendingExtra = {};
    pendingBoundary = null;
    busyBufferEngaged = false;
    // The hold's own two stamps belong to the hold that just ended: the next one opens its own window
    // from its own first piece, and carrying these over would let a spent window's cap release a hold
    // that had only just begun.
    busyWindowOpenedAt = null;
    lastBusyPieceAt = null;
    if (wasEngaged && !closed) {
      send({ type: 'pending', text: '', bytes: 0 });
    }
  };

  /**
   * Arms — or drops — the hold poll. Called each time the buffer changes, so the poll exists exactly
   * while something is held and the connection is live.
   */
  const armBusyPoll = (): void => {
    if (busyPollMs <= 0 || closed || bridge.state !== 'open' || pendingParts.length === 0) {
      clearBusyPoll();
      return;
    }
    if (busyPollTimer !== null) {
      return;
    }
    busyPollTimer = setTimeout(pollBusy, busyPollMs);
    busyPollTimer.unref?.();
  };

  /**
   * One hold sample: has the run ended? If it has, the whole merged message goes in NOW.
   *
   * FAIL-OPEN ON AN UNREADABLE HOST, deliberately: only an explicit `true` keeps the hold, and a
   * reading that stopped answering (`null`) releases it just as `false` does. Words delivered a
   * moment late are recoverable; words held until the person gives up and leaves are not.
   */
  const pollBusy = (): void => {
    busyPollTimer = null;
    if (closed || bridge.state !== 'open' || pendingParts.length === 0) {
      return;
    }
    if (readRunBusy() === true) {
      armBusyPoll();
      return;
    }
    flushCoalesced();
  };

  /**
   * The answer a relayed call gets when it will NOT become a message: the raw text carried nothing,
   * the segment it belonged to was transcribed as silence, or the connection is already gone.
   *
   * Said as "handled", never as "reached the session": the model must not re-call, and it must not
   * be told a falsehood it could act on. The wording is the same shape as the other replies so the
   * model's single behaviour — reply `OK` and stop — stays one instruction rather than three.
   */
  const handledWithoutDelivery = (): unknown => ({
    accepted: true,
    instruction: `The message was accepted and has already been handled. Do not call session_send again for it. ${acceptedTail}`,
  });

  /**
   * Records that a relayed instruction did NOT reach the session, with why.
   *
   * The journal line is the point of this call: the 2026-10-11 defect ended with a segment's reply
   * arriving after the browser had gone and simply vanishing, leaving the operator unable to tell
   * "dropped on purpose" from "never happened". `voice-realtime-log.ts` recognises the line, so the
   * absence is a recorded outcome rather than a gap in the record.
   */
  const noteNotDelivered = (reason: string): void => {
    seams.log?.(`session_send not-delivered (${reason})`);
  };

  /**
   * Answers one segment `dropped` — the ONE place that verdict is sent, so a segment can never be
   * answered twice however many ways the app learns it produced nothing.
   *
   * Two facts answer a segment this way, and they reach here from opposite directions: the endpoint
   * reporting ZERO words for it ({@link markSegmentEmpty}, from a transcription), and the endpoint
   * REFUSING its commit (`onSegmentCommitRejected`, from an error). Both mean the same thing to the
   * page — this segment produced no words — so they share a frame type and differ in `reason`.
   */
  const answerSegmentDropped = (seq: number, reason: 'empty-transcript' | 'commit-refused'): void => {
    if (emptiedSegmentSeqs.has(seq)) {
      return;
    }
    emptiedSegmentSeqs.add(seq);
    send({ type: 'segment_ack', seq, state: 'dropped', reason });
  };

  /** Answers one segment as refused because the endpoint reported no words for it (once per seq). */
  const markSegmentEmpty = (seq: number): void => {
    if (emptiedSegmentSeqs.has(seq)) {
      return;
    }
    seams.log?.(`segment ${seq} dropped: the endpoint reported no words for it`);
    answerSegmentDropped(seq, 'empty-transcript');
  };

  /**
   * The delivery point for a relayed instruction this connection has decided MAY become a message.
   *
   * `segmentSeq`/`segmentIsReplay` are passed in rather than read from the live state because a call
   * released from the transcript hold concludes the segment it was HELD for, which by then may not
   * be the segment that is active.
   */
  const proceedRelay = async (
    args: Record<string, unknown>,
    segmentSeq: number | null,
    segmentIsReplay: boolean,
  ): Promise<unknown> => {
    // The idempotency gate. A segment being REPLAYED has been sent upstream before, and if
    // it already produced a message the session must not get a second one. The model is
    // answered exactly as a first delivery would answer it, so it does not retry — the
    // words are already where they were meant to go.
    if (segmentSeq !== null && segmentIsReplay && deliveredSegmentSeqs.has(segmentSeq)) {
      seams.log?.(`segment ${segmentSeq} replayed: the relay repeated an already-delivered call, dropped`);
      return {
        accepted: true,
        instruction: `The message was accepted and has already reached the session. Do not call session_send again for it. ${acceptedTail}`,
      };
    }
    // The CONTINUOUS-MODE duplicate gate. A call made while NOTHING NEW HAS BEEN HEARD since the
    // last accepted delivery — `unforwardedUserUtterances === 0`, a counter fed by BOTH of the
    // endpoint's "the user said something" events (`input_audio_buffer.committed` and a final
    // transcription) — is the model re-sending words the session already has, not relaying a new
    // utterance. Answered exactly as a replayed segment above, so the model does not retry, and
    // nothing reaches the session.
    //
    // WHY THE TEXT IS NO LONGER COMPARED FOR EQUALITY OR CONTAINMENT (ruling 2026-10-16; live journal
    // `cae49fed`). The previous criterion was exactly `normalized === lastAcceptedRelayText ||
    // lastAcceptedRelayText.includes(normalized)`, which the model defeats simply by REWRITING what it
    // re-sends: live, a delivery carried "A B" (the relay had prepended A verbatim over a call that
    // carried only B — see the span guard in `sessionSend`), and 44 s later, with zero frames on the
    // wire since, the model re-sent A with its filler words dropped, punctuation added and one phrase
    // reworded. Neither equal nor contained, so the guard let it through and the person was shown a
    // second message they never said. The rewritten form is the NORMAL shape of this echo — the model
    // is reproducing a transcript it read rather than a string it copied — so the comparison is now
    // {@link relayRestatesDelivery}, an elision-tolerant reading of the same question.
    //
    // WHY THE COUNTER IS THE OTHER HALF, AND WHY NEITHER HALF IS ENOUGH ON ITS OWN. The counter alone
    // (drop whenever no new words have been heard) would also drop a sentence the model is still
    // completing: one utterance relayed in two calls — a pause inside a sentence, the tail joining the
    // coalescing window or the busy hold — carries a second call with no `committed` behind it, and
    // that tail must be delivered (the relay's own window and hold rest on it). The text comparison
    // alone cannot see a rewrite. Together they separate the two shapes exactly: a restatement of
    // words already delivered, with nothing new heard in between, is an echo; anything that ADDS
    // words, or any call with a fresh `committed`/transcription behind it, is a delivery.
    //
    // Corpus check over every continuous connection in `~/.cloudcli/voice-realtime-log/*.jsonl`: of
    // 250 `session_send`/`session_interrupt` calls, the 27 made with zero new `committed`/transcript
    // since the previous call split 25 literal repeats (the two earlier recurrences of this defect)
    // and 1 rewritten phantom (the defect this task exists for) — every one an echo — plus 1 whose
    // delivered text was a `session_interrupt` CORRECTION (out of this guard`s scope: the correction
    // path does not advance `lastAcceptedRelayText`, so it stays delivered either way). Zero
    // legitimate relay calls in the population.
    //
    // SCOPED TO `segmentSeq === null`, i.e. the CONTINUOUS path. A delivery that belongs to a
    // segment (segmented relay) is the `seq` dedup gate's job — that gate keys on identity the text
    // comparison cannot see, and applying both here would let this guard mask the other's false
    // forms (the AC8 mutation suite reddens the missing `seq` gate by expecting the replay to land
    // twice). The defect this guard closes is precisely that continuous mode carries no `seq`.
    const normalizedRelay = normalizeRelayText(typeof args.message === 'string' ? args.message : '');
    // ── THE DELIVERY WATERMARK (GOAL-046 keeps it; the settle producer did not) ──
    // On the continuous wire, once a final transcription has been heard, the watermark
    // (`speechEpoch`/`deliveredEpoch`) is what stops the same span from being delivered again — the
    // 2026-10-11 `57279cc1` shape, where one sentence was sent three times, and the `cae49fed`
    // phantom rewrite the old identity/containment comparison missed.
    //
    // The watermark answers "is there a NEW span?", not "are these words already in the session?".
    // A call with no new speech can still be the FIRST delivery of words nobody holds: the
    // interrupt's next message (the person spoke, the model answered, the transcription has not
    // landed — journal `b33412ea`'s late forward), or the first call of a connection whose commits
    // the proxy does not observe. So the refusal needs BOTH halves: no new speech AND a restatement
    // of something recently delivered. Anything that ADDS words is a delivery, which is also what
    // the relay's coalescing window and busy hold depend on (a tail joining an open window must be
    // let through).
    //
    // `unforwardedUserUtterances === 0` is the fallback for a connection that has never heard a final
    // (a direct `session_send` fixture): there is no epoch to compare, and the counter is the same
    // "nothing new happened" reading. SCOPED TO `segmentSeq === null`: a segmented delivery is the
    // `seq` gate's job, and applying both here would mask that gate's own false forms.
    const noNewSpeech = finalTranscriptHeard
      ? speechEpoch === deliveredEpoch
      : unforwardedUserUtterances === 0;
    if (
      segmentSeq === null &&
      !segmentedRelay &&
      noNewSpeech &&
      recentDeliveredTexts.some((previous) => relayRestatesDelivery(normalizedRelay, previous))
    ) {
      // Parens are stripped from the preview: `voice-realtime-log.ts`'s `SEND_NOT_DELIVERED_LINE`
      // reads the reason up to the first `)`, so one in the message would truncate the journal line.
      const preview = String(args.message ?? '').replace(/[\r\n()]/g, ' ').slice(0, 80);
      noteNotDelivered(`duplicate: no new speech since the last settled delivery — ${preview}`);
      // No tool-resume: a resume after this answer is what the model re-called the tool on, 7 times
      // live (2026-10-15, connection 71e53da5). The delivered call already had its closing turn.
      return withoutToolResume({
        accepted: true,
        instruction: `The message was accepted and has already reached the session. Do not call session_send again for it. ${acceptedTail}`,
      });
    }
    // The BOUND (AC1/AC3), judged here — the model's call point, before any await — so a message
    // the relay refuses never reaches the executor at all: `base.session_send` is not called and the
    // session never sees it. Judged AFTER the replay gate, because a replayed segment is not a new
    // message and adds nothing to the queue; and BEFORE the segment bookkeeping, because a refused
    // delivery must not be recorded as one this segment produced.
    //
    // WHO IS REFUSED: a message whose text would push the person's waiting bytes past the budget —
    // `pendingBytes + thisMessageBytes > maxBytes`. A message that FITS is always accepted, however
    // many have come before it (AC1/AC3): the axis is text, not turns.
    //
    // A call that JOINS a window already open adds nothing new to the total — that window is already
    // counted as the one message it will become — so it is let through even at the budget. Without
    // this, the tail of a paused sentence would be refused for the sentence's own head.
    const maxBytes = seams.maxQueuedVoiceBytes ?? VOICE_QUEUE_MAX_BYTES;
    // THE HOLD IS BOUNDED (AC1(c)). A piece joining the 1 s window adds nothing new — that window is
    // already charged as the one message it will become — but a piece joining the BUSY HOLD does add:
    // the hold can last a whole turn, so it is the one wait a person can genuinely overrun, and a
    // piece that would push it past the budget is refused (buffer unchanged) rather than admitted.
    const busy = readRunBusy() === true;
    const joiningOpenWindow = coalesceMs > 0 && pendingParts.length > 0 && !busy;
    const incomingBytes = voiceMessageBytes(args.message);
    if (!joiningOpenWindow && queuedBytes() + incomingBytes > maxBytes) {
      const bytes = queuedBytes() + incomingBytes;
      const depth = queuedDepth();
      seams.log?.(`session_send refused: ${VOICE_QUEUE_FULL_REASON} bytes=${bytes} max=${maxBytes} depth=${depth}`);
      send({ type: 'refused', reason: 'queue-full', depth, bytes });
      // The model reads this. The reason code is stable and the instruction names the number it
      // happened at and the disposition of the words — kept as the caption the person can still
      // see, NOT delivered — and forbids the retry that would otherwise turn one refusal into a
      // stream of them, while still asking the model to keep relaying what the person says next
      // rather than answering them itself (the model must not take over the conversation).
      return {
        accepted: false,
        reason: VOICE_QUEUE_FULL_REASON,
        depth,
        bytes,
        instruction:
          `Refused: the user's undelivered text already waiting for this session plus this message would come to ${bytes} bytes, ` +
          `over the budget of ${maxBytes} bytes (${depth} of their messages are waiting). ` +
          'This message was NOT delivered and will not be. It stays on the user\'s screen as an undelivered line, ' +
          'so the words are not lost. Do not call session_send again for them, and do not retry. ' +
          'Keep passing what the user says next through session_send — do not answer the user yourself: ' +
          'the next thing they say will be carried once the session has caught up.',
      };
    }
    // First delivery of this segment: remember it, so the replay of the same `seq` can be told apart.
    if (segmentSeq !== null) {
      deliveredSegmentSeqs.add(segmentSeq);
    }
    // Accepted: this call consumes whatever user utterance upstream has begun so far, and its text
    // becomes the baseline the NEXT no-audio repeat is judged against. Reset HERE, at acceptance —
    // not at the flush — so an utterance arriving inside the window is charged to the next delivery.
    unforwardedUserUtterances = 0;
    // The watermark's clock stops here too: everything the person has said up to this acceptance is
    // answered for by this delivery, so a later model response with no NEW speech behind it is a
    // restatement and is refused (`speechEpoch` / `deliveredEpoch`).
    deliveredEpoch = speechEpoch;
    // The restatement window (see `recentDeliveredTexts`): bounded, newest last. The text is the
    // message this acceptance is for — the composed one, which is what actually reaches the session.
    const acceptedText = normalizeRelayText(typeof args.message === 'string' ? args.message : '');
    if (acceptedText !== '') {
      recentDeliveredTexts.push(acceptedText);
      if (recentDeliveredTexts.length > 8) {
        recentDeliveredTexts.shift();
      }
    }
    // THE CONTINUOUS WIRE'S FORWARDING WATERMARK ADVANCES HERE — the first of its two advance points
    // (the span guard's refusal is the other, and it advances on the same reading: this call has been
    // ANSWERED FOR). Everything transcribed so far belongs to the interval this call just consumed, so
    // the next call's interval starts after it. Advancing at ACCEPTANCE rather than at the flush is
    // deliberate: with a coalescing window open the text is delivered later, but the decision is made
    // here, and a span that stayed open until the flush would let an utterance arriving inside the
    // window be charged to the call before it. Scoped to the continuous path — a delivery keyed by a
    // `seq` is the segmented gate's, and nothing appended to the span for it (see
    // {@link transcribedSinceWatermark}).
    if (!segmentedRelay && segmentSeq === null) {
      transcribedSinceWatermark.length = 0;
    }
    // ── THE BUSY HOLD (ruling 2026-10-14; release point revised by the X3' replay, 2026-10-15) ──
    // While the host says a turn is in flight, the accepted piece JOINS the one held message and
    // NOTHING is delivered yet: no coalescing timer (the 1 s window would otherwise flush under the
    // busy session and undo the merge), no `sent` frame, no CLI queue entry. The browser is told what
    // the message says right now, and the WHOLE thing goes in as ONE message.
    //
    // TWO WAYS OUT, and the second is the one this task changed. The run ending still releases it
    // (the hold poll, `pollBusy`), which is what the 2026-10-14 ruling had as the ONLY way out — but
    // the replay measured that waiting for the turn end costs a p90 delivery delay of 10.8–18.5 s and
    // routinely lands the words AFTER the model has already answered without them, buying a whole
    // duplicated turn for an instruction the model then reads twice. So the hold ALSO leaves on the
    // QUIET WINDOW: the upstream has closed its turn, the person has said nothing for 2 s, and the
    // merged message goes in under `next` — at the running turn's next tool boundary — instead of
    // queueing behind it. The cap (20 s from the first piece) is the backstop for an upstream that
    // never reports a closed turn at all. A hold that a person overran is bounded exactly like the
    // window is, by the byte check above.
    //
    // Judged BEFORE the `coalesceMs <= 0` fast path below, because a deployment could run with no
    // coalescing window at all and would still want the merge while busy.
    if (busy) {
      if (typeof args.message === 'string' && args.message.trim() !== '') {
        pendingParts.push(args.message);
        pendingBoundary = lastCommittedUserItemId;
        // The quiet window's two stamps, taken at the piece rather than at the flush: the cap is
        // counted from the hold's FIRST piece and the floor from its LAST (see `busyQuietDueAt`).
        const now = Date.now();
        if (busyWindowOpenedAt === null) {
          busyWindowOpenedAt = now;
        }
        lastBusyPieceAt = now;
      }
      lastAcceptedRelayText = normalizeRelayText(joinParts(pendingParts));
      const { message: _held, ...rest } = args;
      pendingExtra = { ...pendingExtra, ...rest };
      if (pendingParts.length > 0) {
        const opening = !busyBufferEngaged;
        busyBufferEngaged = true;
        if (opening) {
          // The journal's opening bracket, the hold's answer to the window's `queued:` line. No
          // `queued` frame is sent here: that frame's contract is the 1 s window's, and this wait is
          // announced by `pending` (below) instead.
          seams.log?.('queued: holding while the session is busy (one merged message, not one per sentence)');
          // S-A: text is waiting without a run of its own having started — the same phase move the
          // window's opening makes.
          noteStatus({ phase: 'queued', queuedItems: queuedDepth(), queuedBytes: queuedBytes() });
        }
        emitPending();
        armBusyPoll();
        // The hold's own clock, re-armed at every piece: a second piece moves the floor and must move
        // the deadline with it.
        armBusyQuietWindow();
      }
      // The same answer every accepted relay gets: DONE from the model's side, and do not re-call.
      return {
        accepted: true,
        instruction: `The message was accepted and will reach the session. Do not call session_send again for it. ${acceptedTail}`,
      };
    }
    if (coalesceMs <= 0) {
      lastAcceptedRelayText = normalizedRelay;
      return deliverSessionSend(args);
    }
    // The window OPENS here, and only here: `pendingParts` was empty, so nothing was already
    // waiting and this delivery starts the wait that `flushCoalesced` ends. Tell the browser at
    // this instant (AC-327) — before the timer is armed, so the frame precedes `sent` for certain.
    // A later message that lands INSIDE an open window joins it without a second frame.
    const openingWindow = pendingParts.length === 0;
    if (typeof args.message === 'string' && args.message.trim() !== '') {
      pendingParts.push(args.message);
      // Stamped HERE, the moment the model's call arrives, not at the flush — see `pendingBoundary`.
      pendingBoundary = lastCommittedUserItemId;
    }
    // The baseline a repeat is judged against is the WINDOW'S joined text, so a call that joins an
    // open window widens it: a no-audio repeat of any piece already in the window is recognised.
    lastAcceptedRelayText = normalizeRelayText(joinParts(pendingParts));
    const { message: _ignored, ...rest } = args;
    pendingExtra = { ...pendingExtra, ...rest };
    if (openingWindow && pendingParts.length > 0) {
      // The other end of this delivery's journal: `flushCoalesced` writes `coalesced …` when the
      // window closes, this is where it opened and the frame above announced it. An operator
      // reading the log sees the two lines bracketing the wait the browser showed as "tidying up".
      seams.log?.(`queued: opening a ${coalesceMs} ms coalescing window (the frame precedes the sent)`);
      const depth = queuedDepth();
      const bytes = queuedBytes();
      send({ type: 'queued', depth, bytes });
      // S-A: text is now waiting even though no run has been started for it — the one event that
      // moves the status line to `queued` with a non-zero backlog.
      noteStatus({ phase: 'queued', queuedItems: depth, queuedBytes: bytes });
    }
    armCoalesce();
    // The model reads this. Wording matters: "will be delivered when the user stops speaking" made it
    // retry the same call every 0.65 s. Say it is DONE from its side, and what to do next.
    return {
      accepted: true,
      instruction: `The message was accepted and will reach the session. Do not call session_send again for it. ${acceptedTail}`,
    };
  };

  /**
   * Releases a held instruction: with the transcript now known, deliver it — or, if the segment was
   * transcribed as silence, refuse it and say so.
   */
  const releaseHeldDelivery = (): void => {
    if (heldTimer !== null) {
      clearTimeout(heldTimer);
      heldTimer = null;
    }
    const held = heldDelivery;
    if (held === null) {
      return;
    }
    heldDelivery = null;
    if (closed) {
      noteNotDelivered('socket closed');
      held.resolve(handledWithoutDelivery());
      return;
    }
    if (segmentTranscriptEmpty.get(held.seq) === true) {
      noteNotDelivered('empty-transcript');
      held.resolve(handledWithoutDelivery());
      return;
    }
    void proceedRelay(held.args, held.seq, held.isReplay).then(held.resolve, (error: unknown) => {
      send(
        errorFrame(
          'TOOL_EXECUTION_FAILED',
          `The instruction could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
      );
      held.resolve(handledWithoutDelivery());
    });
  };

  /**
   * Holds one relayed instruction until its segment's transcription is known, or the grace elapses.
   *
   * The held call is answered only when it is released, which is what makes the ORDERING of the
   * transcription and the model's call irrelevant: both orders end in the same decision.
   */
  const holdUntilTranscriptKnown = (
    seq: number,
    isReplay: boolean,
    args: Record<string, unknown>,
  ): Promise<unknown> =>
    new Promise((resolve) => {
      if (heldDelivery !== null) {
        // A second piece while the first is held is the same utterance relayed in pieces — the shape
        // coalescing exists for. Join them, so the wait costs one message rather than two or none.
        heldDelivery.args = {
          ...heldDelivery.args,
          message: joinParts([String(heldDelivery.args.message ?? ''), String(args.message ?? '')]),
        };
        resolve(handledWithoutDelivery());
        return;
      }
      heldDelivery = { seq, isReplay, args, resolve };
      heldTimer = setTimeout(releaseHeldDelivery, transcriptGraceMs);
      heldTimer.unref?.();
    });

  // ---- the omission-fill producer (GOAL-046, rule v2) -----------------------------------------
  //
  // THE MODEL IS STILL THE PRIMARY DELIVERY; THE RELAY IS THE NET FOR WHAT IT DID NOT CARRY. The
  // 2026-10-17 settle producer replaced the model as the delivery judge, and that was one rule too
  // many: it delivered the whole heard span verbatim whenever no response arrived in 2.5 s, even
  // when the model had carried the sentence in its own words. The rule this replaces it with is the
  // one measured on 47 frozen connections (`docs/proposals/voice-realtime-omission-fill-SPEC.md`):
  // a final transcription is delivered VERBATIM only when the model's executed messages do not
  // contain it (`planOmissionFills`, the pure planner this module owns). No settle timer, no span
  // consumption by a model message, no text-side heuristic here — the ordering decisions belong to
  // the planner.
  //
  // THE THREE REGISTRATION POINTS are the planner's whole input: a final transcription, an EXECUTED
  // model message, and `speech_started`. Each recomputes the plan; only `T_i` (the planner's own
  // `dueAt`) decides when a candidate is judged, and an index is decided exactly once.
  const logOmissionFill = (payload: Record<string, unknown>): void => {
    seams.log?.(`omission_fill ${JSON.stringify(payload)}`);
  };

  /** Drops the waiting decision timer. Idempotent, and safe when none is armed. */
  const clearOmissionTimer = (): void => {
    if (omissionTimer !== null) {
      clearTimeout(omissionTimer);
      omissionTimer = null;
    }
  };

  /**
   * Delivers one planned fill through the EXISTING relay path — busy hold, coalescing window, byte
   * bound and watermark included. It deliberately does not go through {@link sessionSend}: that
   * wrapper registers the call as an EXECUTED MODEL MESSAGE, and a fill is the relay's own words.
   */
  const deliverOmissionFill = async (message: string): Promise<unknown> =>
    proceedRelay({ message }, null, false);

  /**
   * Recomputes the plan and acts on everything whose `T_i` has arrived, then arms the next one.
   *
   * SKIPPED CANDIDATES ARE LOGGED AS SOON AS THE PLAN NAMES THEM. Every skip reason the planner
   * produces is stable once true: weight / empty-grams / wrong-script do not depend on time, and
   * `covered` / `incomparable` only become MORE covered as executed messages arrive (the covering
   * window starts at `t_i − lookback` and its first message is already inside it). Logging them at
   * once is what makes the journal say why a candidate was passed over, instead of leaving a gap.
   *
   * FILLS WAIT FOR THEIR OWN `dueAt`. Fills sharing a `dueAt` are delivered as ONE message, in
   * transcript order; different due times are delivered in order, sequentially, because the send
   * path has a single-flight guard that a concurrent second delivery would trip.
   */
  function evaluateOmissionFill(): void {
    clearOmissionTimer();
    if (closed || segmentedRelay || omissionFillParams === null) {
      return;
    }
    const now = Date.now();
    const plan = planOmissionFills(
      omissionFinals,
      omissionExecuted,
      omissionFillParams,
      omissionSpeechStarts,
    );

    for (const skip of plan.skipped) {
      if (omissionSettled.has(skip.index)) continue;
      omissionSettled.add(skip.index);
      logOmissionFill({ i: skip.index, reason: skip.reason });
    }

    let earliest: number | null = null;
    const dueByTime = new Map<number, OmissionFill[]>();
    for (const fill of plan.fills) {
      if (omissionSettled.has(fill.index)) continue;
      if (fill.dueAt <= now) {
        const group = dueByTime.get(fill.dueAt) ?? [];
        group.push(fill);
        dueByTime.set(fill.dueAt, group);
      } else if (earliest === null || fill.dueAt < earliest) {
        earliest = fill.dueAt;
      }
    }

    const dueTimes = [...dueByTime.keys()].sort((left, right) => left - right);
    if (dueTimes.length > 0) {
      const messages: string[] = [];
      for (const dueAt of dueTimes) {
        const group = (dueByTime.get(dueAt) ?? []).sort((left, right) => left.index - right.index);
        for (const fill of group) {
          omissionSettled.add(fill.index);
          logOmissionFill({ i: fill.index, dueAt: fill.dueAt, coverage: fill.coverage, reason: 'fill' });
        }
        const message = joinParts(group.map((fill) => omissionFinals[fill.index].text));
        if (message !== '') messages.push(message);
      }
      void (async (): Promise<void> => {
        for (const message of messages) {
          try {
            await deliverOmissionFill(message);
          } catch (error) {
            // One failed fill does not cancel the others, and it is NOT retried: the rule is a
            // single action (SPEC §4.3). The failure is reported the same way a failed relay is.
            send(
              errorFrame(
                'TOOL_EXECUTION_FAILED',
                `The omitted speech could not be delivered: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                true,
              ),
            );
          }
        }
      })();
    }

    if (earliest !== null) {
      omissionTimer = setTimeout(evaluateOmissionFill, Math.max(0, earliest - now));
      omissionTimer.unref?.();
    }
  }

  /** Registers one final transcription (`F_i`) and lets the planner re-decide. */
  const registerOmissionFinal = (text: string, itemId: string): void => {
    if (closed || segmentedRelay || omissionFillParams === null) return;
    if (itemId !== '') omissionIndexByItemId.set(itemId, omissionFinals.length);
    omissionFinals.push({ t: Date.now(), text });
    evaluateOmissionFill();
  };

  /**
   * Closes the candidates the `MODEL_TEXT_REPLY` net just delivered verbatim, so the planner does
   * not fill the same words again at `T_i`. The net is the relay's own path, not an executed model
   * message, so the planner cannot see it; this is the relay saying "these are delivered".
   */
  const closeOmissionFillsDeliveredVerbatim = (itemIds: readonly string[]): void => {
    for (const itemId of itemIds) {
      const index = omissionIndexByItemId.get(itemId);
      if (index === undefined || omissionSettled.has(index)) continue;
      omissionSettled.add(index);
      logOmissionFill({ i: index, reason: 'text-reply' });
    }
  };

  /**
   * Registers one EXECUTED model message (`M_k`) — a `session_send` / `session_interrupt` call whose
   * own response completed. A call from a response the endpoint CANCELLED never reaches these
   * executors at all (the bridge reports `TRUNCATED_BY_TURN` before dispatch), which is the input
   * contract `planOmissionFills` requires.
   */
  const registerOmissionExecuted = (message: unknown): void => {
    if (closed || segmentedRelay || omissionFillParams === null) return;
    if (typeof message !== 'string' || message.trim() === '') return;
    omissionExecuted.push({ t: Date.now(), text: message });
    evaluateOmissionFill();
  };

  /** Registers one `input_audio_buffer.speech_started` arrival (the planner's silence branch). */
  const registerOmissionSpeechStart = (): void => {
    if (closed || segmentedRelay || omissionFillParams === null) return;
    omissionSpeechStarts.push(Date.now());
    evaluateOmissionFill();
  };

  /**
   * Marks every committed-but-untranscribed item as answered by the model response that just went
   * out, so its late transcription does not join the verbatim span the `MODEL_TEXT_REPLY` net
   * delivers.
   *
   * NOTE — THIS IS NOT SPAN CONSUMPTION FOR THE OMISSION RULE. The omission planner sees every final
   * transcription regardless of this set (`registerOmissionFinal` runs before the branch below);
   * this only keeps the MODEL_TEXT_REPLY fallback from delivering words a response already carried.
   */
  const claimOutstandingCommits = (): void => {
    for (const itemId of committedPendingTranscription) {
      committedCoveredByResponse.add(itemId);
    }
    committedPendingTranscription.clear();
  };

  /**
   * The relay body behind BOTH the model's `session_send` and the relay's own verbatim deliveries
   * (`MODEL_TEXT_REPLY`'s net, and omission fills). It is not exported and not the executor entry
   * point: the difference is that a call arriving here is already known to be a delivery, not the
   * model's response, so it must not register as an EXECUTED model message.
   */
  const relaySessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    // A connection the browser has already left has nowhere to deliver to. Without this the relay
    // of a segment that arrived after the socket closed was handed to the session anyway, and the
    // page was never told because there was no page — the "silent disappearance" of 2026-10-11.
    if (closed) {
      noteNotDelivered('socket closed');
      return handledWithoutDelivery();
    }
    // The model's own message, judged on its own: an empty or punctuation-only `message` is not a
    // thought to relay, whatever the segment's transcript said.
    if (EMPTY_RELAY_TEXT.test(typeof args.message === 'string' ? args.message : '')) {
      noteNotDelivered('empty-message');
      return handledWithoutDelivery();
    }
    // What this call is delivered as: its own arguments, unchanged. The voice plane no longer
    // rewrites the model's words (the deleted span guard was the only thing that did).
    const relayArgs = args;
    if (activeSegmentSeq !== null) {
      const empty = segmentTranscriptEmpty.get(activeSegmentSeq);
      if (empty === true) {
        noteNotDelivered('empty-transcript');
        markSegmentEmpty(activeSegmentSeq);
        return handledWithoutDelivery();
      }
      if (empty === undefined) {
        return holdUntilTranscriptKnown(activeSegmentSeq, activeSegmentIsReplay, args);
      }
    } else if (!segmentedRelay && transcribedSinceWatermark.length > 0) {
      // THE CONTINUOUS WIRE'S SPAN GUARD (SPEC §10, decision doc §12.5「按条目自身空转写判定」).
      // With no segment to key on, the guard asks the endpoint's own per-item reading for EVERY item
      // transcribed since the watermark — the interval this relay is the answer to — and refuses the
      // call only when that whole interval reported zero words, on the SAME journal line a segment's
      // empty transcript uses, so the two wires read alike. ONE item with words is enough to let the
      // call through: a relay that covers several items is a faithful rendering of what was said
      // across them, and the empty sliver at the end of the span is not a reason to drop the sentence
      // in front of it (`b5d01c21` — see {@link transcribedSinceWatermark}).
      //
      // AN EMPTY SPAN IS NOT AN EMPTY TRANSCRIPT. Before any final transcription has landed there is
      // nothing to judge and the call passes through, never held: the continuous caller relays after
      // the endpoint has closed the utterance, and inventing a delay for a genuine delivery is the
      // failure `SEGMENT_TRANSCRIPT_GRACE_MS` names — an unknown is not an empty. An item in the span
      // whose reading is somehow absent reads the same way, for the same reason.
      //
      // Scoped so the segmented path's own seq-keyed guard above stays the one it is.
      if (transcribedSinceWatermark.every((itemId) => itemTranscriptEmpty.get(itemId) === true)) {
        noteNotDelivered('empty-transcript');
        // ANSWERED FOR, so the watermark advances over the span this refusal consumed — the same
        // reading the accepted delivery below makes. The items are behind the guard either way; not
        // advancing would leave them in the next call's interval, where they could only ever make a
        // later, genuinely-empty span look non-empty.
        transcribedSinceWatermark.length = 0;
        return handledWithoutDelivery();
      }
      // ── THE MODEL'S RESPONSE IS THE PRIMARY DELIVERY (GOAL-046) ──
      // Whether these words cover the span is the omission planner's question, not this path's:
      // the call was registered as an EXECUTED message by {@link sessionSend} before it got here,
      // and the planner judges every final against it at `T_i`. This branch only claims the
      // committed-but-not-yet-transcribed items so their late finals do not enter the
      // `MODEL_TEXT_REPLY` net; `proceedRelay` advances the watermark as before.
      claimOutstandingCommits();
    } else if (!segmentedRelay) {
      // The response arrived BEFORE the span's transcription. There is nothing to judge here — the
      // endpoint has not said what was heard yet — but the items it has COMMITTED are exactly the
      // ones this response answers for, so they are claimed now: their late final transcriptions
      // must not arm the verbatim `MODEL_TEXT_REPLY` delivery of words the model already carried.
      claimOutstandingCommits();
    }
    return proceedRelay(relayArgs, activeSegmentSeq, activeSegmentIsReplay);
  };

  /**
   * `session_send`, executed immediately (AC-316) — the MODEL's call, registered as an executed
   * message before it is relayed.
   *
   * The guard sits HERE, at the delivery point, and not only where the transcription arrives: the
   * endpoint's transcript and the model's relay are independent upstream events and either may land
   * first. Deciding when the call arrives therefore covers both orders, and the hold above makes the
   * decision the same one whichever it was.
   */
  const sessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    registerOmissionExecuted(args.message);
    return relaySessionSend(args);
  };

  /**
   * Writes the ONE audit record for a stop (SPEC §6.2, §10.3 / C-3) and answers the three readings
   * the receipt carries.
   *
   * WHY THE JOURNAL GETS A LINE RATHER THAN A NEW SEAM. The proxy's `log` seam is already the
   * connection's on-disk record — `voice-realtime-log.ts`'s recorder tees every line into this
   * connection's journal and classifies the ones it recognises — so a stop that printed nothing
   * structured was the one thing on this connection with no record at all. One `session_interrupt
   * audit {json}` line puts it beside the segment, send and rotation entries the same way they got
   * there, with no second assembly point and no new argument for `server/index.ts` to remember.
   *
   * `intent` and `heard` are the MODEL's words, so both are read as "a string, or nothing": an
   * omitted `heard` is a real reading (`null`), and a stop that named no reason is a real reading too.
   * Neither is invented, and `intent: ''` is never written in place of an absent one — a fabricated
   * reason on an audit line is worse than an empty field.
   *
   * A MISSING `intent` IS RECORDED, NOT REFUSED (this task's whole point). The schema makes `intent`
   * OPTIONAL and the executor does not check it (see `voice-realtime-tools.ts`,
   * `voice-realtime-live-executor.ts`): the real form journal `b5d01c21` shows is a model that
   * called the stop with only a `message`, and refusing it at the transport dropped the stop AND the
   * correction. So an absent or blank `intent` is written as `intent: null` AND FLAGGED with
   * `intentMissing: true`, which is what keeps C-3's "误停可审计" satisfiable — the record says the
   * model gave no reason rather than pretending it gave one.
   *
   * `inFlightTool` is the tool the interrupted run was executing, read ONCE per stop from the host's
   * own activity record ({@link hostRunActivity}) and carried into the journal, the receipt's sibling
   * reading and the next turn's note (`buildInterruptAftermathNote`) so all three name the same tool.
   * When the reading cannot be taken — no host activity for this session, a seam that throws — it is
   * `null` rather than a guess, and the next turn gets the tool-free form of the note (C-3's rule:
   * record what is known, say `null` for the rest). A run that was executing NO tool also reads
   * `null`; the two are the same reading at this seam, which is why the note says "interrupted" and
   * only names a tool when there is one.
   *
   * `noteCarried` says whether THIS stop's aftermath note left with THIS stop's own correction
   * ({@link lastDeliveryCarriedNote}). It is the reading that keeps the two halves of the aftermath
   * honest when they come apart, which is exactly the case a stop-with-correction can produce: a note
   * that went out on the correction while the abort then found NO run (`outcome: 'no-run'`) or was
   * refused (`outcome: 'refused'`) — the message carries an interruption note, and whether it should
   * is only answerable if the audit says the note rode it. A stop that carries no correction is
   * `false` by construction: its note is armed after the abort and rides a LATER message, so this
   * stop's own delivery never carried one.
   */
  const writeInterruptAudit = (
    args: Record<string, unknown>,
    outcome: 'aborted' | 'no-run' | 'refused' | 'covered',
    queuedStillPending: number,
    inFlightTool: string | null,
    noteCarried: boolean,
  ): { runId: string | null; triggerSeq: number | null; queuedStillPending: number } => {
    const runId = execStatus.reading().runId;
    // `0` is "no non-empty utterance has been heard yet", which is not the same reading as "utterance
    // number zero": the count starts at 1, so an absent one is `null` rather than a 0 that could be
    // read as "the first utterance".
    const triggerSeq = utteranceSeq === 0 ? null : utteranceSeq;
    // `intent` is the model's own statement of why it stopped. A present one is carried verbatim; an
    // ABSENT or blank one is `null` with `intentMissing: true` (SPEC §6.2 / §10.3, C-3) — never `''`,
    // never an invented reason, and never a refusal, because a model that forgot the field still
    // meant to stop and its `message` still has to land.
    const intent = typeof args.intent === 'string' && args.intent.trim() !== '' ? args.intent : null;
    seams.log?.(
      `session_interrupt audit ${JSON.stringify({
        runId,
        triggerSeq,
        intent,
        intentMissing: intent === null,
        heard: typeof args.heard === 'string' ? args.heard : null,
        queuedStillPending,
        inFlightTool,
        noteCarried,
        by: 'model',
        outcome,
      })}`,
    );
    return { runId, triggerSeq, queuedStillPending };
  };

  /**
   * `session_interrupt`, the STOP path — the ONE handler that deliberately does not go through
   * {@link deliverSessionSend}.
   *
   * WHY IT BYPASSES THE SEND MACHINERY. A stop has to work precisely when a send is stuck: while a
   * `session_send` is parked in the busy-wait (the single-flight `sending` held) or while the queue
   * is full (`VOICE_QUEUE_FULL`), a stop that queued behind the send it is meant to cancel would
   * never run — the user says stop and the run keeps going. So it does NOT touch `sending`, it does
   * NOT open a coalescing window, and it is NOT judged by the delivery bound. It calls the bound
   * session's own interrupt and answers at once (AC2/AC3).
   *
   * WHAT A STOP IS NOT. It is not a teardown: the voice connection, the microphone and the messages
   * already accepted all survive it (AC4). It ends the ONE run in flight (the control service's
   * abort verb — the SAME one the browser's stop button and the MCP `session_interrupt` reach), and
   * the backlog's first message is released immediately rather than waiting for its coalescing
   * window, so the person's next words are carried without a pause. `depth` is read BEFORE that
   * release, so the number the bar shows still counts everything the stop did not throw away.
   *
   * AND IT IS AUDITED. Every outcome of this path — a run aborted, nothing in flight, or a call the
   * voice plane refused before the abort — goes through {@link writeInterruptAudit}, and the same
   * three readings ride back on the receipt. The stop is the one tool whose whole effect is
   * destructive, so it is the one tool whose reason for firing has to be readable afterwards
   * (SPEC §10.3, C-3).
   *
   * AND IT IS FENCED (SPEC §18.4 G2, GOAL-041 AC-343). This is the MODEL's stop path only — the
   * browser's stop button and Esc reach the control service's abort directly over `chat.abort` and
   * never pass through here, so the fence cannot restrain them (D-7's "UI 停止键不受栅栏约束"). The
   * model's call is first offered to {@link decideModelInterrupt}: an utterance the current run
   * already covers, or the same `triggerSeq` repeated, is answered `{stopped:false, reason:'covered'}`
   * with one `outcome:'covered'` audit line and NO second `stopped` frame — the debounce, not a
   * second stop.
   *
   * AND IT ENQUEUES A CORRECTION BEFORE IT ABORTS (SPEC §18.4 G1, GOAL-041 AC-342). When the call
   * carries a `message` — the corrected instruction for an interrupt the model judged a change of
   * direction (D-6) — that text is delivered into the CLI's own queue FIRST, and the abort waits on
   * the enqueue's confirmation (see {@link enqueueConfirmed}). Only a confirmed enqueue aborts,
   * which is what makes the corrected words and the run they correct land in the SAME turn rather
   * than the correction arriving a turn late (the E10/U1, E10/U2 readings). An enqueue that could
   * not be confirmed answers `{stopped:false, reason:'revision-not-enqueued'}` and aborts nothing.
   *
   * AND THAT CORRECTION IS WHERE THE AFTERMATH NOTE RIDES (ruling 2026-10-16). The note is armed
   * BEFORE the enqueue, so the message the stop's own words go in on is the message that carries the
   * interruption's explanation — see {@link aftermathNote}. A stop with no correction has no such
   * message, keeps its note for whatever is delivered next, and the two are told apart in the audit by
   * `noteCarried`.
   */
  const sessionInterrupt = async (args: Record<string, unknown>): Promise<unknown> => {
    // The stop's `message` is the model's own words for this utterance, exactly like a
    // `session_send`. It is registered BEFORE the fence, because whether the call is a repeat does
    // not change the fact that the model's response carries those words.
    registerOmissionExecuted(args.message);
    // WHAT THE INTERRUPTED RUN WAS DOING, read ONCE for the whole stop (SPEC §0.3 D-8, §18.5). The
    // audit record, the `stopped` frame's run and the note the next MESSAGE carries all name what this
    // one reading answered, so they cannot disagree — and a reading that cannot be taken is `null`
    // here, once, rather than a second attempt later that might answer differently.
    const inFlightTool = readInFlightTool();
    // THE FENCE, before any abort. `covered` is the whole of the debounce: no call to the session's
    // own interrupt, no `stopped` frame, no backlog release — just the ONE audit line recording that
    // the model asked again for a sentence the run already has (SPEC §18.4 G2).
    refreshInterruptCovers();
    const fenceTriggerSeq = utteranceSeq === 0 ? null : utteranceSeq;
    if (
      decideModelInterrupt({ triggerSeq: fenceTriggerSeq, coveredSeqs, abortedTriggerSeq }) === 'covered'
    ) {
      // Re-sample the host for the depth the receipt reports, for the same reason the success path
      // does: a number carried over from an earlier sample can disagree with what the CLI holds now.
      refreshHostQueue();
      const coveredDepth = queuedDepth();
      const coveredAudit = writeInterruptAudit(args, 'covered', coveredDepth, inFlightTool, false);
      seams.log?.(`session_interrupt: covered (no abort) backlog=${coveredDepth}`);
      return { stopped: false, reason: 'covered', ...coveredAudit };
    }
    // ── G1: ENQUEUE THE CORRECTION BEFORE THE ABORT (SPEC §18.4 G1, GOAL-041 AC-342) ──
    // A call the model judged to be a change of direction (SPEC §0.3 D-6) carries the corrected
    // instruction in `message`. It goes into the CLI's own queue FIRST, and the abort WAITS on the
    // enqueue's confirmation. That ordering is the whole fix for F-7's stale-first: E10/U1 reads
    // that at the abort the CLI delivers everything queued behind the run into the interrupt-closing
    // turn, and E10/U2 reads that a correction pushed AFTER the abort (Δ≥50 ms) lands a whole turn
    // late. Enqueued first, the corrected words and the run they correct reach the CLI in the SAME
    // turn, in speech order.
    //
    // A CORRECTION THAT CANNOT BE ENQUEUED DOES NOT ABORT (AC3). If a delivery is already in flight
    // (the single-flight `sending`), or the session does not confirm the correction entered its
    // queue, or the delivery throws, the honest reading is that the correction never reached the
    // session — so the run is left alone and the receipt says `stopped:false` with the reason,
    // rather than stopping a run whose correction was silently dropped.
    const correctionText =
      typeof args.message === 'string' && args.message.trim() !== '' ? args.message : '';
    // ── THE HOLD FOLDS INTO THE INTERRUPT (ruling 2026-10-14) ──
    // A stop that arrives while words are HELD for a busy session is the one case where the hold and
    // the correction are the same utterance: the person said "stop — do this instead" without the
    // held sentence ever reaching the session. The ruling fixes its shape — the held words, the new
    // words and the interruption's explanation go in as ONE message, in speaking order, delivered
    // through the SAME enqueue-then-abort path G1 already runs. So the buffer's text takes the front
    // of the correction (the words were said first), and the note rides that ONE message.
    //
    // AND SO DOES EVERY OTHER CORRECTION (ruling 2026-10-16, this task). The note is armed for every
    // stop that carries a correction, not only for the held one: the reasoning the hold's ruling
    // records — "the note for THIS stop rides THIS message instead of being deferred to the next one"
    // — is true of a plain spoken correction for exactly the same reason. Per G1 the correction is
    // delivered into the CLI's queue BEFORE the abort, and the abort delivers it into the
    // interrupt-closing turn, so it IS the first message into the CLI after the interruption; arming
    // the note afterwards instead put it on the NEXT thing the person said, where "the previous turn
    // was interrupted" describes the wrong turn and "everything after this note takes precedence"
    // demotes the correction that actually answered the interruption (SPEC §18.4 G1, D-6).
    const mergesHold = busyBufferEngaged && pendingParts.length > 0;
    const held = mergesHold ? joinParts(pendingParts) : '';
    // ── THE CORRECTION CARRIES THE MODEL'S WORDS AND NOTHING ELSE (ruling 2026-10-16, this task) ──
    // The interrupt's correction used to run the same span guard a `session_send` ran (landed
    // 2026-10-16 for journal `259b51e0`): sentences heard since the watermark whose adjacent-character
    // pairs the correction's words did not cover went in front of it, verbatim. Both consumers of that
    // measure are gone together, for the reason written at the `session_send` guard's former site — it
    // cannot tell a rewrite from a drop, and the live round of 2026-10-16
    // 13:20 (`3d2d3b2c`) is the two cases read out side by side. An interrupt with a `message` is a
    // RESPONSE for the span, so the segment sends ONE text: the model's correction. A sentence the
    // correction does not literally repeat is not lost by that — what no response answered for is still
    // delivered by `onError`'s `MODEL_TEXT_REPLY` arm.
    //
    // THE HELD WORDS ARE NOT A HEARD SENTENCE. `mergesHold` still leads the correction, because the
    // busy hold's words were said by the person and were never delivered: they are that utterance's
    // own text, held instead of dropped, not a transcript spliced in beside the model's.
    const correction = mergesHold
      ? [held, correctionText].filter((piece) => piece.trim() !== '').join('\n\n')
      : correctionText;
    /**
     * Whether the note THIS stop armed left on THIS stop's own correction — the audit's `noteCarried`
     * (see {@link writeInterruptAudit}). `false` for a stop that carries no correction, whose note is
     * armed after the abort and rides a later message; also `false` when the correction never reached
     * the CLI, where the note is revoked rather than spent.
     */
    let noteCarried = false;
    if (correction !== '') {
      // ── THE NOTE IS ARMED BEFORE THE ENQUEUE, SO IT RIDES THE CORRECTION (ruling 2026-10-16) ──
      // Order is the whole mechanism: `deliverSessionSend` prepends an ALREADY-ARMED note, so arming
      // after the enqueue would miss the one message this stop has of its own. Arming it here and
      // letting the delivery spend it is what makes "the note for THIS stop rides THIS message" true
      // for a plain correction and not only for the held one (see `aftermathNote`).
      aftermathNote = buildInterruptAftermathNote(inFlightTool);
      // Cleared immediately before the delivery and read immediately after, so the reading belongs to
      // THIS delivery: no other delivery can spend a note while one is in flight (its own single-flight
      // `sending` makes a concurrent call join or throw, never compose).
      lastDeliveryCarriedNote = false;
      let enqueueReason: string | null = sending
        ? 'a delivery is already in flight, so the correction could not be queued ahead of the abort'
        : null;
      if (enqueueReason === null) {
        try {
          // `next`, the tier the busy hold's release uses: a message the CLI queued earlier at `next`
          // is delivered at the abort, and a correction left to the host's own `later` fallback waits
          // out that whole turn behind it (journal `259b51e0`: the stop arrived 16.8 s after the
          // sentence it was meant to ride with).
          const confirmed = await deliverSessionSend({
            message: correction,
            priority: VOICE_BUSY_RELEASE_PRIORITY,
          });
          noteCarried = lastDeliveryCarriedNote;
          if (!enqueueConfirmed(confirmed)) {
            enqueueReason = 'the session did not confirm the correction entered its queue';
          } else if (!segmentedRelay && correctionText !== '') {
            // ANSWERED FOR: the watermark advances over the span this delivery consumed, the same
            // reading `proceedRelay`'s acceptance makes. Only on a confirmed enqueue — a correction
            // that never reached the queue leaves the span for the text-reply net to deliver.
            transcribedSinceWatermark.length = 0;
          }
        } catch (error) {
          noteCarried = lastDeliveryCarriedNote;
          enqueueReason = error instanceof Error ? error.message : String(error);
        }
      }
      if (enqueueReason !== null) {
        // No abort follows, so no interruption is announced to anyone: the note armed for this
        // correction is REVOKED. When nothing was handed over it is still armed and this is what
        // stops it riding the next message; when the correction did reach the CLI the note went with
        // it and there is nothing left to revoke — `noteCarried` above is then the reading that says
        // so, and the refused audit carries it beside `outcome: 'refused'`.
        aftermathNote = null;
        const refusedAudit = writeInterruptAudit(args, 'refused', queuedDepth(), inFlightTool, noteCarried);
        seams.log?.(`session_interrupt: correction not enqueued (${enqueueReason}); not aborting`);
        return { stopped: false, reason: 'revision-not-enqueued', detail: enqueueReason, ...refusedAudit };
      }
      if (mergesHold) {
        // The held words are in the CLI's queue now, as part of the message G1 confirmed: the buffer
        // is spent, so it is emptied (and the card taken down) BEFORE the abort, and the backlog
        // release below cannot deliver the same words a second time.
        resetHeldBuffer();
      }
      seams.log?.('session_interrupt: correction enqueued; aborting the run it corrects');
    }
    // The backlog a REFUSED stop is audited with, read BEFORE the call: the voice plane can turn the
    // stop away (a missing `intent`, a foreign session, D-2's forbidden verb), and that record still
    // has to carry a reading — the abort answer it would otherwise be read after never arrives. The
    // reading the SUCCESS path reports is taken below instead, once the host has been re-sampled.
    const depthBeforeStop = queuedDepth();
    let result: unknown;
    try {
      result = await base.session_interrupt(args);
    } catch (error) {
      // A REFUSED stop is written before it is rethrown (SPEC §10.3, C-3). The reading that matters
      // most for "误停可审计" is the stop that did NOT happen — a call the voice plane turned away
      // (a missing `intent`, a foreign session, D-2's forbidden verb) — and it is gone the moment the
      // bridge turns the throw into a `TOOL_EXECUTION_FAILED` frame, so the record is made here.
      //
      // THIS REFUSAL CAN COME AFTER THE CORRECTION WENT OUT (open question, resolved by reading the
      // code: the whitelist lives INSIDE `base.session_interrupt` — `voice-realtime-live-executor.ts`'s
      // `assertBoundSession` — and this proxy calls it BELOW the enqueue, so a stop naming a foreign
      // session still delivers its correction first). The note that rode that correction cannot be
      // recalled, so it is RECORDED rather than pretended away: `noteCarried` sits beside
      // `outcome: 'refused'` and says the message in the CLI carries an interruption note for a stop
      // that never happened. Moving the check above the enqueue was the alternative and was NOT taken:
      // it would have to be duplicated here, a second copy of the whitelist that can drift from the
      // one the executor owns.
      writeInterruptAudit(args, 'refused', depthBeforeStop, inFlightTool, noteCarried);
      throw error;
    }
    const aborted =
      typeof result === 'object' && result !== null && (result as { aborted?: unknown }).aborted === true;
    // Sample the host right after the stop: ending the run in flight is the one event that can make
    // the CLI dequeue what was waiting behind it, so the depth reported here has to be re-read rather
    // than carried over from before the stop. Read ONCE, and the log, the audit and the `stopped`
    // frame below all carry this same number: `queuedStillPending` is "what the stop did NOT throw
    // away", so a second reading would let the receipt disagree with the frame.
    refreshHostQueue();
    const depth = queuedDepth();
    seams.log?.(`session_interrupt: aborted=${aborted} backlog=${depth}`);
    // The audit is written from the aggregator BEFORE `noteStatus` below clears the run: after that
    // patch the reading says `idle`/`runId: null`, and a record naming the wrong run (or none) would
    // be an audit of a different stop than the one that happened.
    const audit = writeInterruptAudit(args, aborted ? 'aborted' : 'no-run', depth, inFlightTool, noteCarried);
    // The fence's idempotent half: this triggerSeq has now RUN on this connection, so a repeat of the
    // same call is answered `covered` rather than aborting again (SPEC §18.4 G2). Set whether or not
    // the abort found a run to stop — "the same triggerSeq runs once" is the guarantee, and it holds
    // for a session with no lifecycle channel too.
    abortedTriggerSeq = fenceTriggerSeq;
    // NO VERBATIM DELIVERY MAY FOLLOW THE STOP (X-5, AC-361). A stop whose correction is only an
    // `intent` (the e2e's U5, journal `19:02:05.781`) carries no message for the omission planner to
    // match, so without this the sentence the stop just disposed of would be filled at `T_i` — a
    // second disposition, after the stop. The span the person had spoken up to this stop is
    // therefore CLOSED: every candidate already known is decided now, with `reason: 'stop'`, and
    // the watermark advances as it always did. A `covered` repeat (fenced above) and a stop that
    // never ran (refused, returned above) do not reach here: they answered nothing.
    if (!segmentedRelay) {
      for (let index = 0; index < omissionFinals.length; index += 1) {
        if (omissionSettled.has(index)) continue;
        omissionSettled.add(index);
        logOmissionFill({ i: index, reason: 'stop' });
      }
      transcribedSinceWatermark.length = 0;
    }
    // The frame names the run the stop ENDED (`audit.runId`, read from the aggregator before the
    // patch below) and the depth it kept — the two readings §18.5 asks the aftermath to carry, taken
    // from the same post-stop host sample as the audit and the status line.
    send({ type: 'stopped', aborted, depth, runId: audit.runId });
    // The stop is a state change the page sees, so it is also a reconcile point: after an abort the
    // CLI delivers the backlog into the closing turn, so the host's `started` set has just moved and
    // this push is what clears any backlog row whose terminal frame goes missing.
    pushQueueReconcile();
    // S-A: the run in flight just ended, so the status line goes back to `idle`. The backlog the stop
    // did not throw away is still counted, which is why the phase and the counts are one patch rather
    // than two — a line reading `idle queued=0` while text waits would be a lie. The runId STAYS: the
    // line and `session_status` keep naming the run that was just stopped until a new one starts, so
    // "which run did I stop" is answerable for as long as the aftermath is (SPEC §18.5). A stop with
    // no run reported to this connection carries `null` here, unchanged.
    noteStatus({ phase: 'idle', runId: audit.runId, queuedItems: depth, queuedBytes: queuedBytes() });
    // Release the backlog's first message NOW (its coalescing window would otherwise hold it for up
    // to `coalesceMs`). Only when nothing is mid-delivery: `deliverSessionSend` is single-flight and
    // would refuse a second concurrent call, turning the release into a spurious failure. While a
    // send is in flight the flush is a no-op and the queued message keeps its own timer — the stop
    // has already done its job by aborting the run.
    if (!sending) {
      flushCoalesced();
    }
    // ── THE NEXT MESSAGE'S NOTE, FOR A STOP THAT CARRIED NO CORRECTION ──
    // Armed AFTER the release above, because the release carries the interrupted turn's own backlog
    // rather than the turn that follows it (see `aftermathNote` and `buildInterruptAftermathNote`).
    // The tool named is the ONE reading taken at the top of this call, so the note, the journal line
    // and the frame all describe the same stop. A stop that aborted nothing arms nothing: there is no
    // interruption to explain, and a note claiming one would be a fabrication.
    // ...and NOT when this stop's note ALREADY left on its own correction (`noteCarried`): that
    // correction is the message this note was owed to, and arming a second one would make the NEXT
    // message repeat an interruption the correction has already explained — the duplication the
    // single-message ruling exists to avoid. Read from the delivery rather than from "did this stop
    // carry a correction": a correction that never reached the CLI leaves no note behind either way,
    // and a correction whose abort then found no run still took the note out with it.
    if (aborted && !noteCarried) {
      aftermathNote = buildInterruptAftermathNote(inFlightTool);
    }
    // The receipt the model reads back: the gateway's own payload (untouched — `aborted` and its
    // `message` are the abort's answer, not this plane's) plus the three readings the audit was made
    // from. They are on the receipt for the same reason they are in the journal: the model that
    // decided to stop is the one that can say whether stopping was right, and it cannot do that
    // without knowing WHICH run and WHICH utterance it stopped.
    const gatewayPayload =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
    return { ...gatewayPayload, ...audit };
  };

  const executor: RealtimeToolExecutor = {
    ...base,
    session_send: sessionSend,
    session_interrupt: sessionInterrupt,
  };

  const reportTransportError = (error: { code: string } & Record<string, unknown>): void => {
    // Every transport failure is logged with its human sentence — a MISSING_API_KEY or a
    // MASKED_API_KEY is a server-side misconfiguration, and the log is where the operator reads
    // WHICH one without the browser's copy (which deliberately never names the key's value).
    if (error.code !== 'SPEND_LIMIT') {
      seams.log?.(`to-browser transport error ${error.code}: ${describeTransportError(error)}`);
    }
    send(errorFrame(error.code, describeTransportError(error)));
    if (error.code === 'SPEND_LIMIT') {
      // Not recoverable: a connection spending at this rate is not left running. The pending
      // instruction (if any) is still delivered by the teardown flush; nothing more is asked of the model.
      seams.log?.(`teardown: spend guard tripped (${JSON.stringify({ ...error, code: undefined })})`);
      teardown();
    }
  };

  /**
   * One segment phase transition from the bridge: which `seq` a delivery belongs to now, and whether
   * it is a replay.
   *
   * NO ACK IS SENT FROM HERE IN EITHER MODE, and that is the change this frame's grading rests on.
   * A phase says what the APP did (the commit went out; the audio was written again) — not what the
   * endpoint did with it. Manual mode used to answer `committed` at this point, which made the ack a
   * statement about the app's own write and let it say "committed" for segments whose commit was lost
   * with the socket (journal `e22ac831`: six segments answered `committed` with nothing on the wire).
   * The ack now comes from the two places the ENDPOINT is heard from: its own
   * `input_audio_buffer.committed` (manual mode, {@link onUserAudioCommitted}) and the segment's final
   * transcription (fallback mode, `onCaption` — the endpoint's VAD closed it, which is what proves the
   * segment was taken). What the app knows on its own — the socket died, the budget is spent — is
   * reported as `written`/`lost` instead (see the bridge's `onSegmentOutcome`).
   *
   * The bookkeeping here is about DELIVERIES, and stays: `activeSegmentSeq` is the segment a call
   * arriving now belongs to, which is a fact about the segment's window rather than about its ack.
   */
  const onSegmentPhase = (event: RealtimeSegmentPhaseEvent): void => {
    // A held instruction belongs to the segment it was relayed for, and any transition that ends
    // that segment's window releases it: the segment settled (its response is over, nothing more is
    // coming), or a DIFFERENT segment's audio is now the active one. The release re-reads the
    // transcript, so a segment that was never transcribed fails open rather than waiting forever.
    if (heldDelivery !== null && (event.phase === 'settled' || event.seq !== heldDelivery.seq)) {
      releaseHeldDelivery();
    }
    activeSegmentSeq = event.phase === 'settled' ? null : event.seq;
    activeSegmentIsReplay = event.phase === 'replayed';
    if (event.phase === 'settled') {
      return;
    }
    // Fallback mode's ack is owed at the ENDPOINT's own signal, not here: the segment only closed at
    // all once the endpoint's detector read its trailing silence as the end of speech, so the queue is
    // what orders the segment to the transcription that proves it — see `onCaption`.
    if (segmentCommitMode === 'server-vad' && event.phase === 'committed') {
      awaitingTranscriptionSeqs.push(event.seq);
    }
  };

  let bridge: RealtimeBridge;
  /**
   * The upstream transport the exit path writes its closing commit to — the session the relay last WROTE
   * to. The bridge's public surface exposes no raw `send` (the exit needs one), so the proxy captures it
   * here; under the upstream pool, "the active session" is the one that last received a frame, not the
   * last one created (the newest transport is the standby), which is why the wrapper below records the
   * SENDER rather than creation order.
   */
  let lastSendingTransport: RealtimeTransport | null = null;
  /**
   * Opens one upstream transport. WITH the uplink VAD on the transport is wrapped so the exit path can
   * name the session that received the audio; WITHOUT it this is the plain `createTransport` call the
   * relay has always made, so an `uplinkVad === null` connection is unwrapped and byte-identical (AC2).
   */
  const openTransport = (): RealtimeTransport => {
    // THIS connection's settings reading, handed to the transport that opens the wire. The proxy
    // resolved the same reading above for its gate and log line; passing it here is what makes the
    // endpoint's `session.update` carry the same detector instead of the file-less shipped default
    // (live, 2026-10-20: the log said 1500 ms, the frame said 800 ms).
    const inner = seams.createTransport(reportTransportError, settings.turnDetection);
    if (uplinkVad === null) {
      return inner;
    }
    const wrapper: RealtimeTransport = {
      open: () => inner.open(),
      close: () => inner.close(),
      send: (message) => {
        lastSendingTransport = wrapper;
        inner.send(message);
      },
      subscribe: (handler) => inner.subscribe(handler),
      onClose: (handler) => inner.onClose(handler),
    };
    const synthesized = inner.onSynthesizedToolResume;
    if (synthesized !== undefined) {
      wrapper.onSynthesizedToolResume = (handler) => synthesized(handler);
    }
    return wrapper;
  };
  try {
    const bridgeOptions: RealtimeBridgeOptions = {
      ...(seams.stallMs === undefined ? {} : { stallMs: seams.stallMs }),
      segment: {
        commitMode: segmentCommitMode,
        ...(seams.commitGapMs === undefined ? {} : { commitGapMs: seams.commitGapMs }),
      },
    };
    const bridgeHooks: RealtimeBridgeHooks = {
      onSegmentPhase,
      // Continuous mode's duplicate guard's signal (see `unforwardedUserUtterances`): every user
      // utterance the endpoint COMMITS is one the model may yet relay. The bridge tolerates the
      // event itself, so this hook is the proxy's only view of it; the guard's other signal, a final
      // transcription (`onCaption`), is already on this side.
      //
      // The same event carries the seq↔itemId pairing (`segmentSeqByItemId`), because it is the only
      // place the endpoint says which item a segment's commit created. A `seq` of `null` means the
      // endpoint's OWN detector created the item: counted like any other utterance, deliberately NOT
      // recorded in the map — the map's absence is what says "attribute this to no segment", and an
      // entry here would recreate exactly the mis-attribution this closes.
      onUpstreamTurn: (open) => {
        uplinkVad?.noteUpstreamTurn(open);
        // The busy quiet window's OTHER reading (X3' replay, 2026-10-15): "the person is still
        // talking" is the endpoint's own turn being open, so the window may only release while this
        // is `false`, and its 2 s is counted from the moment the turn closed. Both are recorded here
        // and nowhere else — the caption path cannot answer this question, because a caption can
        // arrive for a segment long after the person stopped speaking.
        upstreamTalking = open;
        if (!open) {
          upstreamTurnCloseCount += 1;
          lastUpstreamSilenceAt = Date.now();
          // THE EARLY ANNOUNCE (2026-10-21). The endpoint says the person just stopped, and this is
          // the earliest honest moment to acknowledge: transcription has not run yet, the model has
          // not seen the words, and the closing turn is still ~0.9 s away. The queue is free here —
          // user speech cleared it at `speech_started`. One remark per closed turn, from the same
          // settings table the closing turn uses (so the TTS cache already holds the clip).
          //
          // NOT fired on the local energy gate: ambient noise opened it over narrations five times
          // in the 2026-10-19 live connection (see the duplex note below), and an announce for noise
          // is worse than a late one.
          if (
            earlyAnnounceArmed &&
            (seams.closingTurn ?? DEFAULT_VOICE_REALTIME_CLOSING_TURN) === 'announce' &&
            narratorQueue !== null
          ) {
            earlyAnnounceArmed = false;
            const earlySeq = earlyAnnounceSeq;
            earlyAnnounceSeq += 1;
            lastEarlyAnnounceAt = Date.now();
            narratorQueue.enqueue({
              utteranceId: `announce-early-${earlySeq}`,
              text: pickAnnouncePhraseFrom(settings.announcePhrases, earlySeq),
            });
          }
        } else {
          // A new turn is open: it owes one early announce when it closes (see the close branch).
          earlyAnnounceArmed = true;
          // A NEW turn starting retires any pending forced-commit snapshot: whatever the next
          // `committed` answers, it no longer answers the turn this relay closed itself.
          forcedCommitCloseSnapshot = null;
          // THE DUPLEX RULE'S ENDPOINT READING (AC-406): the endpoint heard the person start a new
          // utterance, so the narrator stops and its queue is cleared. This path is the one the
          // deployed `server_vad` always fires; the browser's segment boundary is the OTHER precise
          // reading of the same fact (see `noteUserSpokeForNarrator`). The local speech gate is
          // deliberately NOT one of them — it is an energy reading for the watchdog, and ambient
          // noise opened it five times over narrations in the 2026-10-19 live connection.
          noteUserSpokeForNarrator();
          // THE OMISSION PLANNER'S SILENCE BRANCH. `speech_started` inside `(t_i, t_i + S]` means the
          // model may still answer for `x_i` in its response to the newer speech, so the decision
          // waits the full H instead of confirming at S (SPEC §3). The planner needs the ARRIVAL
          // TIME, which is why the time is recorded here rather than only the boolean above.
          registerOmissionSpeechStart();
        }
        armBusyQuietWindow();
      },
      onUserAudioCommitted: ({ itemId, seq }) => {
        // The exit path's first signal (§6.3): the endpoint accepted the exit's commit into an input
        // item. Set unconditionally; only a live exit wait reads it (see `signalUplinkVadExit`).
        signalUplinkVadExit(1);
        // The exit path's READING, not a signal: the endpoint has just accounted for everything this
        // connection sent it, so the frames forwarded since the PREVIOUS commit stop being "audio the
        // endpoint has not yet been asked to close". See `uplinkVadFramesSinceCommit`.
        uplinkVadFramesSinceCommit = 0;
        unforwardedUserUtterances += 1;
        // The watermark's clock: a commit is the person having said something, whether or not its
        // transcription has landed yet (see `speechEpoch`).
        speechEpoch += 1;
        if (itemId !== '') {
          // The conversation boundary moves HERE, on the commit, whether or not this relay asked for
          // it (`seq === null` is the endpoint's own detector committing a piece of speech): the item
          // exists and is the user's either way, and it is in front of the model from this moment.
          lastCommittedUserItemId = itemId;
          // This item exists but has not been transcribed yet, so a model response from now on
          // answers for it even if its final lands afterwards (the `MODEL_TEXT_REPLY` net's input).
          if (!segmentedRelay) {
            committedPendingTranscription.add(itemId);
          }
        }
        if (seq !== null && itemId !== '') {
          segmentSeqByItemId.set(itemId, seq);
        }
        // MANUAL MODE'S `committed` ACK, sent here and only here — the endpoint saying, in its own
        // frame, that this segment's commit created an input item. Everything the app knew earlier
        // (the commit went out, the audio was written again after a reconnect) is a statement about
        // the app, and those segments get `written`/`lost` from `onSegmentOutcome` instead.
        //
        // ONCE PER SEGMENT. A segment replayed onto a later socket is committed AGAIN (a second item
        // for the same audio), and the page's display for that `seq` has already moved past
        // "committed" — a second frame would be a log line, not a verdict. The delivery side treats a
        // replayed segment the same way (`deliveredSegmentSeqs`), so the segment's whole story stays
        // one-verdict-per-seq.
        if (segmentCommitMode === 'manual' && seq !== null && !committedSegmentSeqs.has(seq)) {
          committedSegmentSeqs.add(seq);
          send({ type: 'segment_ack', seq, state: 'committed' });
        }
        // THE FORCED COMMIT'S RECOVERY — the 2026-10-17 dropped-sentence defect. When the relay
        // commits a turn the endpoint left open, the endpoint may answer `committed` + a transcript but
        // never `speech_stopped`: its server_vad only fires on a speech→silence transition INSIDE one
        // uncommitted buffer, and the commit froze the buffer, so nothing will open a response and the
        // sentence waits for the next utterance (measured 22.5 s / 49.6 s late). The state says whether
        // the endpoint will answer on its own: a `committed` that is the ONLY turn close since our
        // snapshot had no `speech_stopped` before it, so nothing else is coming and the relay asks for
        // the response. Any `speech_stopped` (fast or same-batch close) adds a second close and leaves
        // the endpoint to answer exactly as it did on 2026-10-15 (connection 71e53da5, where a pair sent
        // unconditionally caused a second response and a duplicate-delivery loop). NO TIMER: this is a
        // reading of events already delivered, and a new `speech_started` retires the snapshot.
        //
        // Segmented connections never reach here in practice — the uplink VAD is not built for them
        // (`uplinkVadRequested`), so no forced commit exists — but the guard is stated, not implied.
        const forcedCommit = forcedCommitCloseSnapshot;
        forcedCommitCloseSnapshot = null;
        if (!segmentedRelay && forcedCommit !== null && upstreamTurnCloseCount === forcedCommit + 1) {
          seams.log?.(
            'uplink_vad: forced commit answered with no speech_stopped — asking for the response the endpoint will not open',
          );
          lastSendingTransport?.send({ type: 'response.create' });
        }
      },
      /**
       * What the bridge knows and the endpoint never said: a segment whose audio it wrote but whose
       * answer died with the socket (`written`), or one it will never be able to answer for
       * (`lost`, with the reason). Forwarded as `segment_ack` — the same vocabulary the two
       * endpoint-driven verdicts use, so the page has ONE place to read a segment's fate — and
       * journalled, because the page may be gone by the time the socket dies and the absence of this
       * record is what made the 2026-10-11 "silent disappearance" undiagnosable.
       */
      onSegmentOutcome: (event) => {
        seams.log?.(
          event.state === 'written'
            ? `segment ${event.seq} written, not yet acknowledged by the endpoint`
            : `segment ${event.seq} lost: ${event.reason}`,
        );
        send(
          event.state === 'written'
            ? { type: 'segment_ack', seq: event.seq, state: 'written' }
            : { type: 'segment_ack', seq: event.seq, state: 'lost', reason: event.reason },
        );
      },
      // The endpoint REFUSED a commit: no item exists for that segment and none ever will, so its
      // transcript can never arrive to say whether it was empty. Recorded rather than merely logged —
      // `answerSegmentDropped` skips a seq already answered, and a refusal is the one case where the
      // page is owed an answer even though the endpoint never said anything about the segment's words.
      onSegmentCommitRejected: ({ seq, message }) => {
        rejectedSegmentSeqs.add(seq);
        seams.log?.(`segment ${seq} refused by the endpoint: ${message}`);
        answerSegmentDropped(seq, 'commit-refused');
      },
      /**
       * The 2026-10-13 forensics reading: WHY a segment's audio did not come back. LOG-ONLY — the page
       * is owed the segment's FATE, which `onSegmentOutcome` already sends as a `segment_ack`; this
       * carries the close code, the socket generation and the replay spend, which the page has no use
       * for and a `segment_ack` frame has no room for.
       *
       * Recorded here rather than in `onError` on purpose: a forensic reading must not reach the error
       * channel, because an error frame is a session failure the browser renders — routing a
       * measurement through it would tell the person their voice session is broken every time the
       * upstream redials, which is exactly the "只加读数" line this task is not allowed to cross.
       */
      onSegmentForensics: (event) => {
        seams.log?.(formatSegmentForensics(event));
      },
      onStateChange: (next) => send({ type: 'state', state: next }),
        // A dropped upstream the bridge is already redialling is a hiccup, not the end: the
        // `state: open` that follows the redial restores the page, and a fatal frame here
        // would flash "Voice control stopped" over a session that is about to recover.
        //
        // A STALL IS NOT AN ERROR AT ALL. It used to travel this channel like any other failure,
        // which put it in the same slot as a malformed call and left the page with a sentence and
        // no state: the turn the person had just spoken was neither answered nor ended. It gets its
        // own frame — the utterance's disposition — and the human reading still goes to the log, so
        // a reported incident stays diagnosable from the server side alone.
        onError: (error) => {
          if (error.code === 'UPSTREAM_STALLED') {
            seams.log?.(`to-browser turn_unanswered: ${describeBridgeError(error)}`);
            send({ type: 'turn_unanswered', seconds: error.seconds });
            return;
          }
          // A MODEL TEXT REPLY IS "HEARD, NOT FORWARDED", NOT A FAILURE (SPEC §12.5, decision doc
          // §12.6 B-8). The model answering in words instead of calling a function is the "nothing
          // to do" disposition. It used to be silent under continuous — logged and then RETURNED
          // with the browser told nothing — which turned a failure from visible into invisible: the
          // person's words reached neither the session nor the screen, over a bar that looked exactly
          // like one where the model had relayed. It now has its own frame, `heard_not_forwarded`
          // (§12.5's reserved disposition), so the bar can say the utterance was heard and set aside.
          // Deliberately NOT the `error` channel: an error frame flashes "Voice control stopped" over
          // a session that is working exactly as it should. SCOPED TO THE CONTINUOUS RELAY — the
          // segmented wire keeps its `error` frame, the reading its own criteria pin (streaming-stages
          // P6, the segmented replay e2e), where a text reply is the retired relay's regression rather
          // than this disposition. The reading goes to the journal either way.
          if (error.code === 'MODEL_TEXT_REPLY' && !segmentedRelay) {
            // SPEAK THE MODEL'S OWN WORDS (2026-10-19). A text reply is not only a disposition to
            // report — it is the model talking to the person, and the person should HEAR it. The
            // sentence is enqueued verbatim into the narrator (the queue the announce remark and the
            // run-end summary share), so a connection with the narrator wired speaks exactly what the
            // model said. A connection without a narrator still gets the disposition below unchanged.
            if (narratorQueue !== null && error.text.trim() !== '') {
              narratorQueue.enqueue({ utteranceId: `model-reply-${modelReplyNarrationSeq}`, text: error.text.trim() });
              modelReplyNarrationSeq += 1;
            }
            // EVERY FINISHED SENTENCE IS DELIVERED (ruling 2026-10-14, "a pen, not an agent"; live
            // 2026-10-15 b33412ea). When the person speaks again within a beat of finishing, the
            // endpoint opens no response for the sentence just committed, and the next response's
            // text reply sets the whole run aside — the sentences before it got no disposition at all.
            // The relay delivers what no `session_send` answered for, verbatim, through the model's
            // own path (hold, window, bound and watermark included).
            const unansweredItemIds = transcribedSinceWatermark.filter(
              (itemId) => itemTranscriptEmpty.get(itemId) === false,
            );
            const unanswered = unansweredItemIds.map((itemId) => itemTranscriptText.get(itemId) ?? '');
            if (unanswered.some((text) => text.trim() !== '')) {
              const message = joinParts(unanswered);
              seams.log?.(`relayed verbatim after a text reply: ${unanswered.length} unanswered sentence(s)`);
              // These sentences are delivered by THIS net, so the planner must not fill them
              // again at `T_i` — it cannot see a relay delivery (only executed model messages).
              closeOmissionFillsDeliveredVerbatim(unansweredItemIds);
              // THE RELAY'S OWN WORDS, NOT THE MODEL'S: the body is used directly so the net's
              // delivery is not recorded as an executed model message for the omission planner.
              void relaySessionSend({ message });
              return;
            }
            seams.log?.(`to-browser heard-not-forwarded: ${describeBridgeError(error)}`);
            send({ type: 'heard_not_forwarded' });
            return;
          }
          // A CALL THE ENDPOINT'S DETECTOR CUT OFF IS A MEASUREMENT, NOT A FAILURE (2026-10-14,
          // journal `d4c9bfc4`). The person spoke while the model was still writing `session_send`'s
          // arguments, the response was cancelled `turn_detected`, and the model re-sent the whole call
          // on its next turn — an error frame here put "A function call from the upstream was malformed"
          // in front of the person, five times in two minutes, for turns that all worked. The bridge
          // already told the two apart (see its `TRUNCATED_BY_TURN`), so this side does exactly what it
          // does for a stall: writes the reading to the journal and tells the browser NOTHING. The
          // journal line is the count — one per truncation, each naming its call — so the recurrence
          // stays visible on the server side without the page rendering it.
          if (error.code === 'TRUNCATED_BY_TURN') {
            seams.log?.(`to-browser truncated-by-turn: ${describeBridgeError(error)}`);
            return;
          }
          // AN UPSTREAM "CANCELLED BY NEW INPUT" IS THE INTERRUPT WORKING, NOT A FAILURE (2026-10-14
          // evening reading). The endpoint cancels the response in flight when the person speaks over
          // the model and reports it this way; a frame here put a red bar over a session that was fine.
          // Same disposition as a stall or a truncated call: the reading goes to the journal, and the
          // browser is told NOTHING. Every OTHER upstream error falls through to the frame below.
          if (error.code === 'UPSTREAM_ERROR' && UPSTREAM_CANCELLED_BY_NEW_INPUT.test(error.message)) {
            seams.log?.(`to-browser upstream-cancelled-by-new-input: ${describeBridgeError(error)}`);
            return;
          }
          send(
            errorFrame(
              error.code,
              describeBridgeError(error),
              error.code === 'CONNECTION_LOST' ? error.willRetry : RECOVERABLE_ERROR_CODES.has(error.code),
            ),
          );
        },
        // Forwarded verbatim: the caption channel exists so the browser can SHOW
        // what the model heard, and it deliberately shares no path with the
        // `session_send` executor above. The one field this side adds is the `seq` the transcript
        // belongs to — the page needs it to place the words at the segment they were spoken in, and
        // `null` is the honest answer for a transcript that belongs to no segment this relay closed.
        onCaption: (caption) => {
          if (caption.final) {
            // The exit path's second signal (§6.3): a FINAL transcription is the endpoint having
            // committed AND transcribed the utterance the exit's `input_audio_buffer.commit` asked for,
            // so once it lands beside the `committed` the connection can close rather than wait out the
            // bound. Set unconditionally; only a live exit wait reads it.
            signalUplinkVadExit(2);
          }
          const seq = segmentSeqForCaption(caption.itemId);
          send({ type: 'caption', ...caption, seq });
          if (caption.final) {
            // A FINAL transcription is a user utterance begun upstream — the same reading the bridge
            // takes when it resets `callsSinceUtterance` on this event. Counting it here, beside
            // `onUserAudioCommitted`, is what keeps the duplicate guard from treating a legitimate
            // repeat as an echo when the utterance reached us by transcript rather than by a
            // `committed` the proxy saw. See `unforwardedUserUtterances`.
            unforwardedUserUtterances += 1;
            // The watermark's clock (see `speechEpoch`): a final transcription is also "the person
            // said something" — the endpoint's own statement, for a connection whose commit the proxy
            // may not have observed.
            speechEpoch += 1;
            // The segment's transcript, finally known. `true` means the endpoint reported ZERO
            // words for it — the one mechanical fact the guard acts on — and the segment is
            // answered as refused here, where the fact arrives, whether or not the model relays it.
            const empty = EMPTY_RELAY_TEXT.test(caption.text);
            // The stop audit's `triggerSeq` (see {@link utteranceSeq}): a segment that carried WORDS
            // is one more utterance the model can be stopping FOR. Counted here, beside the `empty`
            // reading it is decided from, so the count and the guard can never disagree about what
            // "the endpoint reported no words" means.
            if (!empty) {
              utteranceSeq += 1;
              // The words that seq stood for, for the RunDigest's `covers.last` (see `utteranceTextBySeq`).
              utteranceTextBySeq.set(utteranceSeq, caption.text);
            }
            // THE OMISSION PLANNER'S `F_i` (GOAL-046). Every final with words is registered,
            // including one a response already claimed (`coveredByResponse` below): the rule's
            // coverage question is answered by `planOmissionFills` from the executed messages, not
            // by this wire's span accounting. Silence is not a candidate (the SPEC excludes it).
            if (!segmentedRelay && !empty) {
              registerOmissionFinal(caption.text, caption.itemId);
            }
            // THE CONTINUOUS WIRE'S SPAN (SPEC §10, decision doc §12.5「按条目自身空转写判定」). With no
            // segment to key on, the guard keys on the ITEMS transcribed since its watermark: the
            // endpoint's own per-item reading is recorded beside the `empty` it is decided from, and
            // the item joins the span a relay arriving now will be judged against. Appending in
            // ARRIVAL order is what makes the span an interval rather than a set — a relay covers the
            // transcriptions that landed since the last one it answered for, in the order the endpoint
            // finished them, which is the only order this wire has. `itemId === ''` is a malformed
            // event and is given no anchor.
            if (caption.itemId !== '') {
              itemTranscriptEmpty.set(caption.itemId, empty);
              if (!segmentedRelay) {
                // The item's final has arrived, so it is no longer "committed but untranscribed".
                committedPendingTranscription.delete(caption.itemId);
                // A response already answered for this item (it was produced before the
                // transcription landed): consume the transcription rather than settling it again.
                const coveredByResponse = committedCoveredByResponse.delete(caption.itemId);
                if (coveredByResponse) {
                  itemTranscriptText.set(caption.itemId, caption.text);
                } else {
                  transcribedSinceWatermark.push(caption.itemId);
                  itemTranscriptText.set(caption.itemId, caption.text);
                  // A final with words is the reading the duplicate guard needs; whether it becomes a
                  // verbatim delivery is the omission planner's decision, made at `T_i`.
                  if (!empty) {
                    finalTranscriptHeard = true;
                  }
                }
              }
            }
            // THE SEGMENT THIS TRANSCRIPT IS ABOUT — its OWN, never the one that happens to be active.
            // The endpoint answers in whatever order it finishes, so a transcript for seq N regularly
            // lands after seq N+1's commit (journal `ef9daacd`: seq2's after seq3's, seq4's after
            // seq5's). Reading `activeSegmentSeq` here is what made a late EMPTY transcript for N mark
            // N+1 empty and refuse N+1's genuine relay — see `segmentSeqByItemId`, and
            // `segmentSeqForCaption` for what a `null` means.
            if (seq !== null) {
              segmentTranscriptEmpty.set(seq, empty);
              if (empty) {
                markSegmentEmpty(seq);
              }
              // The relay held for THIS segment is the one this answers — the hold was opened for
              // `seq` because its transcript was not yet known, and this is that transcript arriving.
              if (heldDelivery !== null && heldDelivery.seq === seq) {
                releaseHeldDelivery();
              }
            }
            // Fallback mode's ack: a FINAL caption is the endpoint having closed the oldest
            // segment still waiting on one, because the segment only closed at all once its
            // trailing silence was read as the end of speech. In order, one caption per ack.
            // An empty one was already answered `dropped` above, so it is not acked twice.
            if (segmentCommitMode === 'server-vad' && awaitingTranscriptionSeqs.length > 0) {
              const vadSeq = awaitingTranscriptionSeqs.shift() as number;
              if (!emptiedSegmentSeqs.has(vadSeq)) {
                send({ type: 'segment_ack', seq: vadSeq, state: 'committed' });
              }
            }
          }
          // The person is still talking: the quiet window starts over.
          armCoalesce();
        },
      // The announce closing turn's "I'm starting" remark. The trigger stays the model's follow-up
      // text after a delivered session_send, but the SENTENCE is now this connection's fixed
      // announce phrase (see `voice-realtime-announce-phrases.ts`) rather than the model's wording:
      // the five remarks in the 2026-10-19 capture were 8–9 characters and semantically identical,
      // so per-utterance wording bought nothing while every one of them paid a separate synthesis
      // round trip. The model's own prompt contract is unchanged (still "one short sentence"), so
      // this wiring change is independent of it.
      //
      // The TABLE is the settings reading resolved once at the top of this connection
      // (`settings.announcePhrases`), not the compiled-in constant: a deployment's
      // `voice-realtime.settings.json` can replace it, and `server/index.ts` warms the TTS cache from
      // the same resolution, so the spoken sentence is always one the cache pre-synthesized.
      //
      // Still routed into the narrator queue and ONLY for `announce`: `silent` produces no text,
      // `respond`'s "OK" must not be spoken, and a text the model said in answer to the user is
      // MODEL_TEXT_REPLY (a different path). No queue (no narrator wired) is a no-op, not an error.
      onFollowUpText: () => {
        if ((seams.closingTurn ?? DEFAULT_VOICE_REALTIME_CLOSING_TURN) !== 'announce') return;
        if (narratorQueue === null) return;
        // The early announce already said this turn's "I'm starting" at `speech_stopped`; a second
        // utterance of the same phrase for the same turn is noise, not acknowledgment.
        if (
          lastEarlyAnnounceAt !== null &&
          Date.now() - lastEarlyAnnounceAt < EARLY_ANNOUNCE_SUPPRESS_MS
        ) {
          return;
        }
        const seq = announceNarrationSeq;
        narratorQueue.enqueue({ utteranceId: `announce-${seq}`, text: pickAnnouncePhraseFrom(settings.announcePhrases, seq) });
        announceNarrationSeq += 1;
      },
    };
    bridge =
      seams.upstreamPool === undefined
        ? connect(openTransport(), advertisedTools, executor, { ...bridgeOptions, hooks: bridgeHooks })
        : // SPEC §C3. `createTransport` is called once per SESSION, so the standby is a
          // second upstream connection rather than a second view of the first; the pool
          // owns both, and closing the pool closes both.
          createUpstreamPool({
            createSession: (sessionHooks) =>
              connect(openTransport(), advertisedTools, executor, {
                ...bridgeOptions,
                hooks: sessionHooks,
              }),
            idleRotateMs: seams.upstreamPool.idleRotateMs,
            hooks: { ...bridgeHooks, onRotate: seams.upstreamPool.onRotate },
            log: seams.log,
          });
  } catch (error) {
    // `createTransport()` is the only call above that can throw synchronously
    // (a missing upstream credential is refused at construction). The bridge
    // itself reports every later failure through `onError`/the state hook.
    //
    // THE REGISTRY GOES FIRST, and here rather than through a teardown: this return is above every
    // socket handler below, so the `close` this is about to fire has no listener to catch it — and
    // the connection just died without ever having a teardown. Left here, the entry would arm the
    // dispatch hook for a session whose voice connection failed to exist.
    clearVoiceSessionActive(boundSessionId);
    send({ type: 'error', code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) });
    socket.close();
    return;
  }

  /**
   * Whether the uplink VAD's exit sequence is under way. While it is, the socket `'close'` handler must
   * NOT tear the connection down: the browser sends its close FRAME and then closes the socket, so the
   * `'close'` event arrives while the exit is still waiting, and a teardown there would close the
   * bridge before the exit's commit pair was written (the exact defect §6.3 names).
   */
  let uplinkVadExiting = false;
  /** Whether the exit sequence has been entered, so the close frame and the socket close cannot both run it. */
  let uplinkVadExitStarted = false;

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    // The session stops being in Live Voice at exactly this point, so the dispatch hook stops being
    // armed with it. The socket `close` handler below clears it too, and the two race by design —
    // `clearVoiceSessionActive` is idempotent.
    clearVoiceSessionActive(boundSessionId);
    if (statusTimer !== null) {
      // A status window armed just before the end would fire into a connection that no longer
      // exists. `flushStatus` guards on `closed` too; this is the cheaper half of the same rule.
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (drainPollTimer !== null) {
      // Same rule for the turn-boundary poll: a sample into a torn-down connection is dropped.
      clearTimeout(drainPollTimer);
      drainPollTimer = null;
    }
    // The narrator's two timers and any summarizer call in flight: a summary injected after the
    // connection is gone has no queue to land in, and the generation guard drops a late resolve.
    if (runEndWatchTimer !== null) {
      clearTimeout(runEndWatchTimer);
      runEndWatchTimer = null;
    }
    clearRunEndSettle();
    clearRunOutputRequest();
    runEndGeneration += 1;
    // A due omission fill has nowhere to go once the connection is gone: `evaluateOmissionFill`
    // guards on `closed` too, but dropping the timer is the cheaper half of the same rule.
    clearOmissionTimer();
    // The narrator has no page to speak to any more. Dropped with NO stop frame: the socket is
    // going, and the page's own teardown discards playback with it.
    narratorQueue?.close();
    armReconcilePoll(false);
    // An instruction still waiting on its segment's transcript will never get it now: releasing it
    // here records the non-delivery instead of leaving it held until the grace timer fires into a
    // connection that no longer exists.
    releaseHeldDelivery();
    // Ending the session right after speaking must not drop the last thing said — and
    // ending it mid-segment must not either. A segment that was started and never ended is
    // closed here with the frames that did arrive, upstream and all: the user stopped
    // talking by ending the session, not by pausing, and that is a segment end too.
    const flushedSeq = bridge.flushOpenSegment();
    if (flushedSeq !== null) {
      seams.log?.(`teardown: closed the open segment seq=${flushedSeq} with the frames received`);
    }
    flushCoalesced();
    // The capture's last words: the recorder patches the WAV's size fields and appends the final
    // frame/byte/duration reading. A no-op with no capture wired, and fail-open with one — a capture
    // that cannot be closed must not keep a dead connection's microphone open (why this is before the
    // socket close, with the rest of the teardown).
    seams.audioCapture?.finalize();
    // THE UPLINK VAD'S ONE SUMMARY LINE, on the connection's own way out and only when a gate was built
    // (`uplinkVad === null` ⇒ no line, so a default connection's log is unchanged). The frame counts are
    // the gate's own cumulative reading; `browserFrames` is the count of frames the BROWSER sent, which
    // is never the forwarded count while the gate is withholding anything; the byte figures are the
    // decoded PCM sizes of what crossed and what did not.
    if (uplinkVad !== null) {
      const stats = uplinkVadStats ?? { sent: 0, headKept: 0, heldOpen: 0, dropped: 0, bypassed: 0, preRoll: 0 };
      seams.log?.(
        `uplink_vad summary: browserFrames=${audioFramesFromBrowser} sent=${stats.sent} ` +
          `headKept=${stats.headKept} dropped=${stats.dropped} bypassed=${stats.bypassed} ` +
          `preRoll=${stats.preRoll} heldOpen=${stats.heldOpen} ` +
          `forwardedBytes=${uplinkVadBytesOut} droppedBytes=${Math.max(0, uplinkVadBytesIn - uplinkVadBytesOut)}`,
      );
    }
    // Release the uplink VAD's classifier if one was built — the connection owned it (see
    // `UplinkVadSeam`). Off the `void` path, like the bridge's close: a classifier that cannot release
    // must not keep a dead connection's socket open. Exactly one `close()` reaches the backend on every
    // exit path: this is the only call site, `teardown` is guarded once, and the gate's own `close` is
    // idempotent.
    void uplinkVad?.close().catch(() => undefined);
    void bridge.close().catch(() => undefined);
    if (socket.readyState === socket.OPEN) {
      socket.close();
    }
  };

  /**
   * The uplink VAD's exit path (scheme §6.3): drain the gate, then `input_audio_buffer.commit` →
   * `response.create` → a bounded wait → teardown.
   *
   * TRIGGERED BY THE USER'S OWN EXIT — the browser's close frame and nothing else (a raw socket drop is a
   * disconnect, where §6 says the relay has no choice of teardown order and the browser is gone anyway).
   * This is §0's ONLY, BOUNDED exception to "never send `response.create`": the scope is this one path,
   * and the normal-flow send decision is never driven by any upstream VAD event.
   *
   * The ORDER is the whole point. A bare commit into an immediate close drops the answer the commit just
   * flushed, because the endpoint had not yet committed, transcribed and relayed it (§6.3; the shipped
   * manual path sends the SAME pair, `voice-realtime-bridge.service.ts`'s `writeSegmentClose`).
   *
   * WHY THE PAIR IS SKIPPED WHEN THERE IS NOTHING TO COMMIT. The reason for the pair — "do not let an
   * immediate close swallow the tail the flush just released" — only holds while there IS a tail. With
   * nothing flushed, nothing sent since the endpoint's last commit, and no turn open upstream, the commit
   * can only be refused ("buffer too small, or have no audio") and the `response.create` still opens a
   * whole response over the history: live 2026-10-16 01:06 (journal `cae49fed`), 44 s of zero frames
   * after a delivery ended with the endpoint re-answering an utterance it had already been given, its
   * `session_send` this time carrying the SAME sentence REWRITTEN (the model's own retelling of a
   * transcript the relay had forwarded verbatim). That is a message the person never said, and a whole
   * context's worth of spend to produce it. So the pair is omitted — TOGETHER, never one of the two —
   * only when all three readings below say there is nothing to close:
   *
   *   1. the gate's flush released no frames ({@link UplinkVadGate.flush});
   *   2. this connection has forwarded no frame upstream since the endpoint's last `committed`
   *      ({@link uplinkVadFramesSinceCommit} — the flush's own frames are (1)'s reading, so they are
   *      deliberately not added to this one);
   *   3. the upstream has no unclosed `speech_started` (`upstreamTalking`).
   *
   * Any one of them false ⇒ the original behaviour, unchanged and in the original order. What is
   * omitted is the whole pair on a connection that has nothing to say; what is NEVER omitted is the
   * commit of a tail that exists — the old "never short-circuit the commit" warning is about that
   * order, and it still holds.
   */
  const exitUplinkVad = async (): Promise<void> => {
    if (uplinkVadExitStarted) {
      return;
    }
    uplinkVadExitStarted = true;
    uplinkVadExiting = true;
    const gate = uplinkVad as UplinkVadGate;
    try {
      // 1. Drain: every ARRIVED frame has been judged once the chain settles; `flush` then judges the
      //    frames still inside the lagging classifier's window, and both go out before the commit.
      await uplinkVadChain;
      const tail = await gate.flush();
      uplinkVadStats = tail;
      for (const forwarded of tail.frames) {
        uplinkVadBytesOut += Buffer.byteLength(forwarded, 'base64');
        bridge.sendAudioFrame(forwarded);
      }
      // 2. The exit pair, on the session the audio actually went to.
      const transport = lastSendingTransport;
      if (transport !== null) {
        const nothingToCommit =
          tail.frames.length === 0 && uplinkVadFramesSinceCommit === 0 && !upstreamTalking;
        if (nothingToCommit) {
          // The journal's record of the omission, so an operator reading a connection that ends with a
          // bare close can tell "there was nothing to commit" from "the pair was lost".
          seams.log?.(
            'uplink_vad exit: nothing to commit (no flushed tail, no frame since the endpoint`s last ' +
              'commit, no open turn upstream) — closing without the commit/response pair',
          );
        } else {
          uplinkVadExitSignals = 0; // Only signals arriving DURING this wait count (see the hooks).
          transport.send({ type: 'input_audio_buffer.commit' });
          transport.send({ type: 'response.create' });
          // 3. Bounded wait for the endpoint's `committed` + transcription (§6.3), or the bound.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              uplinkVadExitResolve = null;
              resolve();
            }, uplinkVadExitWaitMs);
            uplinkVadExitResolve = () => {
              clearTimeout(timer);
              uplinkVadExitResolve = null;
              resolve();
            };
          });
        }
      }
    } catch (error) {
      seams.log?.(
        `uplink_vad exit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    teardown();
  };

  // `whenConnected()` never rejects — it resolves on `open` or once the bridge
  // has exhausted its attempts and closed — so the state is what decides whether
  // there is a session to advertise. Sending an update on a closed bridge would
  // be dropped silently and leave the browser listening to nothing.
  void bridge.whenConnected().then(() => {
    if (bridge.state !== 'open') {
      send({
        type: 'error',
        code: 'TRANSPORT',
        message: 'The Realtime upstream could not be reached.',
      });
      teardown();
      return;
    }
    // The session is opened with the instructions AS THEY STAND: the settings read at the top of
    // this connection, plus whatever pack the browser has sent by now. A pack that arrives after
    // this point is applied by its own branch in the message handler.
    advertiseInstructions();
  });

  socket.on('message', (raw: unknown) => {
    const frame = readVoiceRealtimeInboundFrame(
      Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : String(raw),
    );
    if (!frame) {
      return;
    }

    if (frame.type === 'hello') {
      // THE WHOLE PROTOCOL SWITCH, one branch (P4 / AC-322). The browser offered a token; answering
      // with the same token is what lets it start cutting speech into segments. Anything else —
      // the mode turned off, or an offer this proxy does not speak — is answered with silence, and
      // silence is a MEANINGFUL answer here: the page keeps sending the continuous frames it always
      // did, so a rollback needs no browser release. Only the exact token is echoed: a page offering
      // a protocol this proxy does not implement is told nothing rather than told the wrong thing.
      if (segmentedRelay && frame.protocol === SEGMENTED_RELAY_PROTOCOL) {
        send({ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL });
        seams.log?.(`hello: declaring ${SEGMENTED_RELAY_PROTOCOL}`);
      } else {
        // WHY the relay stayed silent, named: the log must tell "the deployment turned it off" apart
        // from "this connection asked for the continuous transport" (the per-connection opt-in), so an
        // operator reading one connection's journal is not sent looking at a variable that is fine.
        const relayOffBecause =
          seams.transport === 'continuous'
            ? 'continuous transport requested for this connection'
            : `relay off via ${VOICE_REALTIME_MODE_ENV}`;
        seams.log?.(
          `hello: not declaring (offered ${JSON.stringify(frame.protocol)}${
            segmentedRelay ? '' : `, ${relayOffBecause}`
          })`,
        );
      }
      return;
    }

    if (frame.type === 'context') {
      // The browser built this from its own transcript's visibility rules; what the proxy owns is
      // the size it is willing to hand upstream. Refusing the WHOLE frame rather than trimming it is
      // deliberate: a pack cut anywhere but its own oldest-row boundary is a conversation with a
      // hole in it, and the injection would then be evidence of nothing. The builder already holds a
      // 2000-char budget, so this only fires on a client that ignored it — and it says so.
      if (frame.text.length > VOICE_REALTIME_CONTEXT_MAX_CHARS) {
        seams.log?.(
          `context refused: ${frame.text.length} chars exceeds the ${VOICE_REALTIME_CONTEXT_MAX_CHARS}-char cap (rows=${frame.rows})`,
        );
        return;
      }
      contextText = frame.text;
      contextChars = frame.chars;
      contextRows = frame.rows;
      seams.log?.(`context received chars=${contextChars} rows=${contextRows}`);
      advertiseInstructions();
      return;
    }

    // The narrator queue's pacing ack. Handled before the speech branches: it is a statement about
    // PLAYBACK, never about the person having spoken (an ack arriving while they talk must not look
    // like a new utterance, and a stale one is ignored by the queue itself).
    if (frame.type === 'narrator_done') {
      narratorQueue?.completed(frame.utteranceId);
      return;
    }

    // The page's answer to the run-end output request. Only the ONE outstanding request may be
    // answered: a late reply for a superseded run is dropped by the id check, not summarized late.
    if (frame.type === 'run_output') {
      const pending = runOutputPending;
      if (pending === null || pending.requestId !== frame.requestId) return;
      clearRunOutputRequest();
      void summarizeRunOutput(pending.generation, pending.runId, frame.text);
      return;
    }

    if (frame.type === 'segment_start') {
      segmentFrameCounts.set(frame.seq, 0);
      // THE SEGMENTED PATH'S READING of "they started talking" — the browser's own boundary. On this
      // wire there is no endpoint `speech_started` to clear the narrator (the relay runs
      // `turn_detection: null`), so this is the only early signal, and clearing here is what keeps
      // a narration from talking over the first segment.
      noteUserSpokeForNarrator();
      bridge.startSegment(frame.seq);
      // The SEGMENTED path's own boundary, handed to the same watchdog the continuous path feeds.
      // It needs its own: this wire runs `turn_detection: null`, so the endpoint never sends the
      // `speech_started` the watchdog's timer is otherwise armed from — a committed segment nobody
      // answered was silently unanswered, which is exactly this path's stall to report.
      bridge.noteLocalUtteranceStart();
      return;
    }

    if (frame.type === 'audio') {
      audioFramesFromBrowser += 1;
      // A sparse heartbeat, so the log can say whether the page is sending audio at all
      // (and for how long) without a line per 20 ms frame.
      if (audioFramesFromBrowser === 1 || audioFramesFromBrowser % 250 === 0) {
        seams.log?.(`from-browser audio frames=${audioFramesFromBrowser}`);
      }
      if (frame.seq === undefined) {
        // THE UPLINK CAPTURE'S ONE FEED (see `voice-realtime-audio-capture.ts`). The continuous path is
        // the full microphone stream — silence included — which is the material an offline VAD study
        // needs; the segmented path below is deliberately NOT captured, because a segmenter has already
        // dropped its silence and a corpus of speech-only clips cannot answer a detector question.
        //
        // Sees the frame on ARRIVAL, before the forward, so the audio and the endpoint's judgement
        // timeline are read against one origin. A SIDE CHANNEL: the frame is forwarded unconditionally,
        // and with no capture wired (`?.`) this branch is the bytes it was before the seam existed.
        seams.audioCapture?.frame(frame.audio, frame.sourceRate, Date.now());
        // THE WATCHDOG'S READING FOR THE CONTINUOUS WIRE, where the endpoint's own `server_vad` is
        // what endpoints this audio — so if it goes silent, nothing else can tell the relay that an
        // utterance happened (measured 2026-10-12: 118.4 s of total upstream silence, and no report).
        // The segmented path needs no energy gate because it already HAS precise boundaries, the
        // browser's own segmenter's; it hands those to the same watchdog instead (see the
        // `segment_start`/`segment_end` branches). Running this gate there as well would be a
        // second, competing endpointing over audio the segmenter has already decided.
        reportLocalSpeechBoundary(localSpeechGate.observe(frame.audio));
        // THE `=== null` FAST PATH. With NEITHER gate built this is the exact relay the continuous wire
        // was before either existed — same call, same bytes, same order (AC1/AC2). Checked before any
        // gate work so a default connection never pays for a feature it did not ask for.
        if (silenceTail === null && uplinkVad === null) {
          bridge.sendAudioFrame(frame.audio);
          return;
        }
        // `noteLocalActivity` is called for EVERY browser frame, forwarded or not: the upstream pool
        // reads it as the connection's activity clock, and neither suppressed nor VAD-dropped audio is
        // an idle connection. Called with EITHER gate on, and its count is the BROWSER's frame count,
        // never the forwarded one (AC4).
        bridge.noteLocalActivity?.();
        if (silenceTail !== null) {
          // SILENCE TAIL SUPPRESSION (decision doc §10). The browser keeps streaming at full rate; what
          // crosses the wire is the gate's decision, not the frame's arrival. The local speech gate
          // above is fed FIRST and unconditionally, so the watchdog's boundaries are unchanged by
          // suppression — which is what keeps a long quiet stretch from ever arming a stall (AC-363
          // V-2: the endpoint's silence clock is AUDIO-time, so it cannot advance on audio nobody sent).
          const decision = silenceTail.observe(frame.audio, Date.now());
          for (const forwarded of decision.frames) {
            bridge.sendAudioFrame(forwarded);
          }
          if (decision.transition !== null) {
            // The cost phase's structured reading (see `voice-realtime-log.ts`): one line in, one out.
            seams.log?.(
              `silence_tail event=${decision.transition} tailMs=${silenceTailOptions?.tailMs ?? 0} suppressedMs=${Math.round(
                decision.suppressedMs,
              )} prerollFrames=${decision.preRollFrames}`,
            );
          }
          return;
        }
        // UPLINK VAD (scheme §5). The gate is ASYNC — the classifier answers in frame order with a lag —
        // so frames are chained rather than awaited here, and whatever a call lets through is forwarded
        // as it settles. `localSpeechGate` was fed the frame on ARRIVAL above, unconditionally, so the
        // watchdog's boundaries are the browser's own and never the gate's surviving subset (AC3).
        enqueueUplinkVad(frame.audio);
        return;
      }
      segmentFrameCounts.set(frame.seq, (segmentFrameCounts.get(frame.seq) ?? 0) + 1);
      bridge.sendSegmentAudio(frame.seq, frame.audio);
      return;
    }

    if (frame.type === 'segment_end') {
      // An end for a segment this connection never saw open is refused rather than
      // committed: there is no audio to close, and inventing an empty utterance would ask
      // the endpoint for a response to nothing.
      if (!segmentFrameCounts.has(frame.seq)) {
        seams.log?.(`segment seq=${frame.seq} dropped: no matching segment_start`);
        send({ type: 'segment_ack', seq: frame.seq, state: 'dropped', reason: 'unknown-segment' });
        return;
      }
      // A repeat of an end already handled is DROPPED rather than committed again: closing one
      // segment twice would put the same audio upstream a second time and ask the endpoint for a
      // second response to it — one utterance billed and relayed twice. Idempotent, and silent on
      // the ack channel because the page already has this segment's answer.
      if (endedSegmentSeqs.has(frame.seq)) {
        seams.log?.(`segment seq=${frame.seq} end repeated for an already-closed segment, dropped`);
        return;
      }
      endedSegmentSeqs.add(frame.seq);
      // SPEC §C4's one line per segment, with the wall clock the log is read against.
      seams.log?.(
        `segment seq=${frame.seq} dur=${frame.durationMs ?? 0}ms reason=${frame.reason ?? 'gap'} frames=${
          segmentFrameCounts.get(frame.seq) ?? 0
        } at=${new Date().toISOString()}`,
      );
      // The segment's own accounting joins the capture's judgement timeline — the endpoint's decision
      // (which utterance it closed, how long the browser said it ran, how many frames carried it) is
      // exactly what an offline detector's proposals are graded against. Recorded even though the
      // segmented path sends no continuous audio: the timeline is the point, not a rider on the WAV.
      seams.audioCapture?.timeline({
        kind: 'segment',
        atMs: Date.now(),
        seq: frame.seq,
        durationMs: frame.durationMs ?? 0,
        frames: segmentFrameCounts.get(frame.seq) ?? 0,
      });
      bridge.endSegment(frame.seq);
      // The segment is closed and its commit asks the endpoint for an answer. If the endpoint said
      // nothing during the segment, that answer is now owed and the clock starts — see
      // `noteLocalUtteranceEnd`. A DROPPED or repeated end returns above and deliberately does not
      // reach here: no commit left, so no answer is owed and nothing may be reported missing.
      bridge.noteLocalUtteranceEnd();
      return;
    }

    seams.log?.(`teardown: the browser sent a close frame (audio frames received=${audioFramesFromBrowser})`);
    if (uplinkVad === null) {
      // The default connection has no exit pair to flush, so the close frame is the teardown it always
      // was — byte-identical to before this seam existed (AC1/AC5).
      teardown();
      return;
    }
    // UPLINK VAD EXIT (§6). This close frame is the user's explicit exit, the ONLY trigger for the
    // commit+response.create pair — NOT the socket's `close` below, which also fires on a raw drop. The
    // async exit owns the teardown; the socket handler is guarded so the imminent `close` cannot race it.
    void exitUplinkVad();
  });

  // THE BROWSER LEG'S KEEPALIVE (live 2026-10-15 86559798). Mute stops every browser→server frame,
  // and an idle relay sends nothing back, so an intermediate proxy dropped the socket after ~2.5 min
  // of silence — and the server only noticed 28 s after the replacement had opened. A protocol ping
  // is answered by the browser without page code; a socket that missed a whole interval's pong is
  // ended so the server stops holding a half-open connection.
  const browserKeepaliveMs = seams.browserKeepaliveMs ?? 25_000;
  let browserAnsweredPing = true;
  socket.on('pong', () => {
    browserAnsweredPing = true;
  });
  const browserKeepaliveTimer =
    browserKeepaliveMs > 0 && typeof socket.ping === 'function'
      ? setInterval(() => {
          if (socket.readyState !== socket.OPEN) {
            return;
          }
          if (!browserAnsweredPing) {
            seams.log?.(`teardown: the browser missed a keepalive pong within ${browserKeepaliveMs} ms`);
            socket.terminate();
            return;
          }
          browserAnsweredPing = false;
          socket.ping();
        }, browserKeepaliveMs)
      : null;
  browserKeepaliveTimer?.unref?.();

  socket.on('close', () => {
    if (browserKeepaliveTimer !== null) {
      clearInterval(browserKeepaliveTimer);
    }
    seams.log?.(`teardown: the browser socket closed (audio frames received=${audioFramesFromBrowser})`);
    // THE RAW-DROP EXIT CLEARS THE REGISTRY ITSELF, before any early return can skip it. This handler
    // is reached on EVERY way the connection ends — a browser close frame, a keepalive-terminated
    // half-open socket, a network drop — while the teardown below is not: the `uplinkVadExiting`
    // branch returns and leaves the teardown to a bounded wait that a process killed in the meantime
    // never finishes. The registry entry is the one thing that has to be gone the moment the
    // connection is, so it is cleared here rather than relying on the path that a crash can cut short.
    clearVoiceSessionActive(boundSessionId);
    if (uplinkVadExiting) {
      // The user-explicit exit is mid-flight on its bounded wait; `exitUplinkVad()` will call
      // `teardown()` when the wait resolves. Tearing down here would close the socket the exit still
      // needs for its commit's answer (§6.3). A raw drop never sets this flag, so it still tears down.
      return;
    }
    teardown();
  });
}
