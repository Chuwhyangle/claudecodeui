/**
 * The Realtime bridge: a small, transport-injected state machine that opens a
 * WebSocket-like session, tells it what tools exist (`session.update`), forwards
 * audio frames, and routes the function calls the model emits to an injected
 * executor — all without ever touching a real socket.
 *
 * WHY TRANSPORT-INJECTED. `docs/proposals/voice-native-control-plane.md` wants
 * the bridge's BEHAVIOUR to be provable before any real Qwen/DashScope adapter
 * exists. So the socket is a `RealtimeTransport` the caller supplies: production
 * will hand it a real WS client (out of scope here), and the criteria hand it a
 * fake server, which makes the whole thing offline. Nothing in this module
 * reaches `fetch`, `WebSocket`, `http`, or `ws` — the module imports only a
 * type, so there is no network path to reach at all.
 *
 * WHY THE GUARDS ARE SHAPED THE WAY THEY ARE. Three things can go wrong at a
 * live socket — the connection drops, an executor throws, the server sends an
 * event type this bridge does not know — and NONE of them may kill the process,
 * because the process also carries every other session. Each is therefore
 * wrapped by {@link guardSync}/{@link guardAsync} and turned into ONE `onError`
 * call carrying an identifiable `code`. `tests/
 * voice-realtime-bridge.false-forms.test.ts` proves the guards are load-bearing
 * by deleting them from a copy of this file and requiring each scenario to
 * redden. Consumers: discovered through this module's barrel and wired (in a
 * later task) to a real Realtime client; the criteria drive it over a fake.
 */
import type { RealtimeToolDescriptor } from './voice-realtime-tools.js';

/** The bridge's connection state. `open` is the only state a message may arrive in. */
export type RealtimeBridgeState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * One tool as `session.update` advertises it.
 *
 * `parameters` is the tool's declared raw input shape. A production adapter
 * serializes that shape to JSON Schema on the way out; this task's fake server
 * only records what it was handed, so the shape travels as itself.
 */
export type RealtimeFunctionDeclaration = {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
};

/** A client→server message. The session configuration, a pass-through audio frame, and the manual segment close. */
export type RealtimeClientMessage =
  | { type: 'session.update'; session: { instructions: string; tools: readonly RealtimeFunctionDeclaration[] } }
  | { type: 'input_audio_buffer.append'; audio: string }
  /**
   * Closes the audio buffer the client has been appending to, as one utterance.
   *
   * Only meaningful when the session was opened with `turn_detection: null`: with the
   * endpoint's own VAD off, nothing else marks the end of a spoken segment, so the
   * client says so and the endpoint transcribes and answers it. See
   * `docs/proposals/voice-realtime-segmented-relay-SPEC.md` §提交方式.
   */
  | { type: 'input_audio_buffer.commit' }
  /** Asks the endpoint for a response. Follows a {@link input_audio_buffer.commit} one-for-one. */
  | { type: 'response.create' }
  /**
   * Turns the endpoint's OWN voice-activity detector off (`turn_detection: null`) on a live
   * session, or back on.
   *
   * A PARTIAL session update, deliberately not a `session.update`: it carries no
   * `instructions`/`tools`, so it cannot re-state — and cannot blank — a session body the
   * caller already advertised. The transport merges it over the shipping defaults, which is
   * where `voice` and the audio formats live.
   */
  | { type: 'session.turn_detection'; turnDetection: 'server_vad' | null }
  /**
   * A tool result. `resume: false` asks the transport NOT to follow it with its synthesized
   * `response.create`: the result is written into the conversation, but the model is not asked
   * to speak again (see {@link withoutToolResume}).
   */
  | { type: 'function_call_output'; callId: string; output: unknown; resume?: false };

const NO_TOOL_RESUME: unique symbol = Symbol('voice-realtime.no-tool-resume');
type NoToolResumeOutput = { readonly [NO_TOOL_RESUME]: true; readonly output: unknown };

/**
 * Used by the ws-proxy's continuous duplicate gate: wraps a tool executor's result so the bridge
 * sends it as `function_call_output` with `resume: false`. A model answered "already delivered"
 * and then resumed re-called the tool with the same words on every resume (live 2026-10-15,
 * 7 calls until TOOL_LOOP_GUARD); a result that ends the call chain must not invite the next call.
 */
export function withoutToolResume(output: unknown): unknown {
  const wrapped: NoToolResumeOutput = { [NO_TOOL_RESUME]: true, output };
  return wrapped;
}

function isNoToolResumeOutput(value: unknown): value is NoToolResumeOutput {
  return typeof value === 'object' && value !== null && NO_TOOL_RESUME in value;
}

/** A server→client function call, before its arguments are parsed. */
export type RealtimeFunctionCall = {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: string;
};

/** Any server→client message. Unknown `type`s are reported, never crashed on. */
export type RealtimeServerMessage = { type: string } & Record<string, unknown>;

/**
 * The endpoint's own protocol traffic that this bridge does not act on.
 *
 * WHY THIS SET EXISTS, AND WHY IT IS NOT A CATCH-ALL. The endpoint narrates its
 * whole turn — session lifecycle, item lifecycle, response lifecycle, streaming
 * text, server-side VAD — and none of it is a failure. Treating it as one is
 * what made every real session die immediately: the `session.update` this bridge
 * sends on connect is answered with `session.updated`, and that reply alone was
 * reported as an unknown event. Meanwhile the criteria's stand-in spoke only
 * `response.function_call_arguments.done`, so no test could see it.
 *
 * The members are exactly what the endpoint was OBSERVED to send, enumerated from
 * the preserved live capture rather than from documentation — see
 * `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json`.
 * A type NOT in here is still reported: the reading keeps its meaning, and in
 * particular `response.audio_transcript.delta` (an OpenAI-shaped name this
 * endpoint never emits) remains a genuine `UNKNOWN_EVENT`.
 */
const TOLERATED_ENDPOINT_EVENTS: ReadonlySet<string> = new Set([
  // Session lifecycle — `session.updated` answers our own `session.update`.
  'session.created',
  'session.updated',
  // Item lifecycle.
  'conversation.item.created',
  // The endpoint retiring an item of its own — it follows the relay's own truncation/cancel, so it is
  // expected traffic, not a failure (2026-10-14 evening reading: two of these reddened the page).
  'conversation.item.deleted',
  // Server-side VAD narrating the user's own speech.
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  // The model's turn: lifecycle, parts, and its streaming text.
  'response.created',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.text.delta',
  // The tool call's incremental half; the completed call arrives as
  // `function_call` and IS acted on.
  'response.function_call_arguments.delta',
]);

/**
 * Why the UPSTREAM ended the socket, as the transport read it off the close frame.
 *
 * OPTIONAL, AND THAT IS THE READING THE 2026-10-13 FORENSICS TASK EXISTS FOR. The bridge's own state
 * can say the socket closed; it cannot say WHY, and the incidents that look identical from there are
 * not: an abnormal drop (`1006`, no close frame at all) and the endpoint's own idle timeout
 * (`1007 response_idle_timeout`) are different causes with different fixes, and the segmented path's
 * 17–20 s losses (`0d2e6d93`, `10f039d0`) could be either. Only a transport that can read the close
 * frame's fields fills this in — the DashScope transport reads the `CloseEvent` — and a transport that
 * cannot (the criteria's plain fake) leaves every field undefined, so the bridge records the close
 * WITHOUT a detail rather than inventing one.
 *
 * A `1000` here is an upstream that closed the session on purpose; the bridge's own deliberate close
 * never reaches a registered handler at all (see {@link RealtimeTransport.onClose}).
 */
export type RealtimeCloseDetail = {
  /** The close frame's status code, when the socket carried one. */
  code?: number;
  /** The close frame's reason string, when the socket carried one. */
  reason?: string;
};

/**
 * The WebSocket client the bridge drives. Production supplies a real one; the
 * criteria supply a fake server. `subscribe`/`onClose` return unsubscribe
 * functions so the bridge can detach on a deliberate close.
 */
export type RealtimeTransport = {
  open(): Promise<void>;
  close(): Promise<void>;
  send(message: RealtimeClientMessage): void;
  subscribe(handler: (message: RealtimeServerMessage) => void): () => void;
  /**
   * Registers the unexpected-close listener. A DELIBERATE close (the bridge's own
   * {@link RealtimeBridge.close}) does NOT reach it — the transport filters that one out, so a
   * handler only ever runs for a socket the upstream ended.
   *
   * The handler takes the close frame's {@link RealtimeCloseDetail} when the transport can read one.
   * BACKWARD COMPATIBLE ON PURPOSE: a transport that cannot (the criteria's fake) calls the handler
   * with nothing, and the parameter being optional means such a handler stays assignable.
   */
  onClose(handler: (detail?: RealtimeCloseDetail) => void): () => void;
  /**
   * Registers a listener told each time a synthesized tool-resume `response.create`
   * has ACTUALLY been written to the socket — not merely intended.
   *
   * OPTIONAL on purpose. Only a transport that can suppress or defer that create knows
   * whether one left, so only such a transport implements this; a transport that never
   * synthesizes one (the criteria's plain fake, a non-DashScope adapter) omits it, and
   * the bridge then never expects a follow-up response — which is exactly right, because
   * no create was sent that could produce one. The DashScope transport implements it,
   * notifying at the two points a resume genuinely leaves (the immediate send and the
   * in-flight flush). It does NOT skip the create when `respondToToolOutputs` is false:
   * that frame is what drains the upstream turn, and skipping it leaked one orphan turn
   * per tool result until the ninth user turn was refused (2026-10-18).
   *
   * Returns an unsubscribe function, like {@link subscribe}/{@link onClose}.
   */
  onSynthesizedToolResume?(handler: () => void): () => void;
};

/** The injected executor: one handler per tool NAME — the routing table. */
export type RealtimeToolExecutor = Readonly<
  Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>
>;

/**
 * One failure the bridge survived, as it is reported to `onError`.
 *
 * Every member carries a discriminator (`code`) plus the fields a caller needs
 * to tell one from another — the "可辨识的错误信息" the criterion reads.
 */
export type RealtimeBridgeError =
  | { code: 'CONNECTION_FAILED'; attempt: number; maxAttempts: number; cause: unknown }
  | { code: 'CONNECTION_LOST'; attempt: number; maxAttempts: number; willRetry: boolean }
  | { code: 'UNKNOWN_EVENT'; eventType: string }
  /**
   * The endpoint's own `error` event, with its message. Reported as such instead of as an
   * unhandled event type: the endpoint saying WHY it refused something (an unsupported
   * voice, a rate limit) is the single most useful fact in a "no answer" report.
   */
  | { code: 'UPSTREAM_ERROR'; message: string }
  /** The endpoint could not transcribe one spoken segment. The session itself is fine. */
  | { code: 'TRANSCRIPTION_FAILED'; message: string }
  /**
   * The endpoint reported speech and then went silent: no event of any kind for `seconds`
   * while a segment was still waiting to be transcribed. Observed live (the upstream
   * sometimes accepts the audio, announces `speech_started`, and never answers), where it
   * read as a dead "Listening…" bar.
   *
   * A TURN OUTCOME, NOT A FAULT. When this is reported the awaited turn is closed as
   * unanswered (the bridge stops waiting for it — see `armStallTimer`), which is why the
   * proxy carries it to the page as its own disposition rather than as a generic error.
   */
  | { code: 'UPSTREAM_STALLED'; seconds: number }
  /**
   * The model called tools over and over without the user saying anything in between. Observed live:
   * a tool result it read as "not delivered yet" made it retry the same call every 0.65 s, each
   * round re-reading the whole context (89 calls, ~300,000 input tokens in one minute). The call is
   * dropped and, crucially, never answered — so the response that would have followed it is never
   * requested and the loop ends.
   */
  | { code: 'TOOL_LOOP_GUARD'; calls: number }
  /**
   * The model answered in TEXT instead of relaying the user's words. Nothing displays that text,
   * so without this report the user spoke, saw their words transcribed, and saw nothing happen.
   */
  | { code: 'MODEL_TEXT_REPLY'; text: string }
  | { code: 'UNKNOWN_TOOL'; tool: string; callId: string }
  | { code: 'MALFORMED_FUNCTION_CALL'; callId: string; reason: string }
  /**
   * A function call the upstream TRUNCATED because the person began speaking again while the model was
   * still writing its arguments.
   *
   * NOT A FAULT. The endpoint's own detector ends the response (`status: cancelled`,
   * `status_details.reason: turn_detected`) mid-argument, so the JSON arrives with its string or its
   * brace unwritten — the shape `MALFORMED_FUNCTION_CALL` is for — but the model re-sends the whole call
   * on its next response and nothing is lost (measured 5/5 on 2026-10-14 01:35–01:37, journal
   * `d4c9bfc4`). Reporting that as a failure put an error frame in front of the person for a turn that
   * worked, which is the noise this reading removes. See {@link RealtimeBridgeOptions.malformedSettleMs}
   * for how a MALFORMED call is held until its response's own outcome is known.
   */
  | { code: 'TRUNCATED_BY_TURN'; callId: string }
  | { code: 'TOOL_EXECUTION_FAILED'; tool: string; callId: string; cause: unknown }
  | { code: 'SEND_FAILED'; cause: unknown }
  | { code: 'DISPATCH_FAILED'; cause: unknown };

/**
 * One interim-or-final transcription of the user's OWN audio, as the endpoint
 * reports it (GOAL-033 / AC-317).
 *
 * THIS IS DISPLAY-ONLY AND MUST NEVER BECOME MODEL INPUT. The model receives the
 * raw audio stream; this text exists so the transcript can show the user what was
 * heard. Keeping it a separate channel — its own hook, its own outbound frame —
 * is what makes that structural rather than a convention someone can quietly
 * break: nothing here is ever routed into a `function_call`'s arguments.
 *
 * `itemId` is the endpoint's grouping key. Every `delta` for one utterance
 * carries the SAME id and the running text; the `completed` event closes it with
 * the final text. A consumer must therefore treat successive same-id captions as
 * replacements, not appends, or one utterance renders as many duplicated bubbles.
 */
export type RealtimeCaption = {
  /** The endpoint's grouping key for one spoken utterance. */
  itemId: string;
  /** The running text (`delta`) or the final text (`completed`). */
  text: string;
  /** `true` on the closing `completed` event, `false` on every `delta`. */
  final: boolean;
};

/**
 * Why a segment ended. Mirrors the browser segmenter's own vocabulary
 * (`src/modules/chat/utils/voiceLiveSegmenter.ts`): a pause, the max-length cut, or the
 * end of the stream. Carried through for the log line and the diagnosis report; the
 * upstream treatment is the same either way.
 */
export type RealtimeSegmentEndReason = 'gap' | 'max' | 'end';

/**
 * How the end of a segment is signalled to the upstream.
 *
 * `manual` is the shipping path (P0a concluded S1 `supported`): the session is opened
 * with `turn_detection: null` — the endpoint's own VAD off — and each `segment_end`
 * becomes one `input_audio_buffer.commit` plus one `response.create`.
 *
 * `server-vad` is the fallback the SPEC names for an upstream that rejects manual
 * commits: the endpoint keeps its VAD, the frames go up as they arrive, and a segment
 * is closed by appending up to {@link RealtimeSegmentOptions.commitGapMs} of REAL
 * silence, which is what the endpoint's own detector reads as the end of speech. This
 * is a switchable implementation, not a comment — the same tests run over both (see
 * `tests/voice-realtime-segmented-protocol.test.ts`).
 */
export type RealtimeSegmentCommitMode = 'manual' | 'server-vad';

/**
 * Where a segment is in its life, as the bridge reports it.
 *
 * - `committed` — the segment's end was handled: its audio is upstream and (manual mode)
 *   the commit went with it. A delivery that follows belongs to this `seq`.
 * - `replayed` — the same segment's audio was written to the upstream AGAIN (once per reconnect,
 *   within its replay budget — see {@link DEFAULT_MAX_SEGMENT_REPLAYS}), because the socket dropped
 *   after the commit and before the response finished. A delivery that follows belongs to a `seq` the
 *   session may already have seen; the receiving side is what de-duplicates on it.
 * - `settled` — the response the commit asked for finished. Nothing more is coming for
 *   this `seq`, so a caller keying deliveries on it may forget it.
 */
export type RealtimeSegmentPhase = 'committed' | 'replayed' | 'settled';

/** One segment phase transition, as {@link RealtimeBridgeHooks.onSegmentPhase} reports it. */
export type RealtimeSegmentPhaseEvent = { seq: number; phase: RealtimeSegmentPhase };

/**
 * One `input_audio_buffer.committed`: the endpoint ACCEPTING a piece of the user's own speech as an
 * input item, paired with the relay segment whose commit produced it.
 *
 * WHY THE PAIRING LIVES HERE. The item id is the endpoint's own key for one utterance, and it is the
 * ONLY key a transcription can be attributed by: transcripts arrive in an order the endpoint chooses
 * (the 2026-10-12 journal `ef9daacd` has seq2's transcript arriving after seq2's commit and seq4's
 * after seq4's, so "whichever segment happens to be active" is a different segment). A commit is
 * emitted by THIS module (`writeSegmentClose`) and its answer is read by THIS module (the dispatch
 * loop below), so the pairing is a local fact here and a consumer never has to guess it.
 *
 * `seq` is `null` when no commit of ours was outstanding — an item the endpoint's OWN detector
 * created (a continuous-mode session, or the fallback's server-side VAD). That is a READING, not a
 * missing one: such an item belongs to no segment this relay committed, and attributing it to
 * whichever segment is active is the defect this pairing exists to close.
 */
export type RealtimeUserAudioCommitted = { itemId: string; seq: number | null };

/**
 * The endpoint REFUSING a commit, as {@link RealtimeBridgeHooks.onSegmentCommitRejected} reports it.
 *
 * A refused commit creates no input item — the endpoint answers with a top-level `error` and no
 * `input_audio_buffer.committed` — so its segment can never be transcribed. `message` is the
 * endpoint's own words, carried through so the journal says why.
 */
export type RealtimeCommitRejected = { seq: number; message: string };

/**
 * What became of a segment whose audio the bridge cannot vouch for, as
 * {@link RealtimeBridgeHooks.onSegmentOutcome} reports it.
 *
 * TWO STATES, AND THE DIFFERENCE IS WHAT THE PERSON MAY BE TOLD:
 *
 * - `written` — the segment's frames and its commit were written to a socket that then died before
 *   the endpoint answered. The audio MAY have reached the endpoint (its own
 *   `input_audio_buffer.committed` is the only thing that proves it did) and may equally have gone
 *   down with the connection. "Uncertain" is the honest reading, and it is why this is not a
 *   `dropped`: a consumer must not tell the person their words were lost when they may have landed,
 *   nor that they landed when they may not have.
 * - `lost` — the bridge KNOWS this segment will never be transcribed, and `reason` says why:
 *   `connection-closed` (its end was handled while the socket was not open, so its frames were never
 *   written at all) or `upstream-drop` (it has spent its replay budget across reconnects; another
 *   socket would carry the same audio to the same silence).
 *
 * A segment that IS answered is reported by {@link RealtimeSegmentPhase} and
 * {@link RealtimeUserAudioCommitted} instead — those carry the proof; this carries its absence.
 */
export type RealtimeSegmentOutcome =
  | { seq: number; state: 'written' }
  | { seq: number; state: 'lost'; reason: 'connection-closed' | 'upstream-drop' };

/**
 * WHY a segment's audio did not come back — the 2026-10-13 forensics readings, one entry per cause.
 *
 * WHY THIS EXISTS. The segmented path lost four consecutive 17–20 s segments whole (`0d2e6d93`,
 * `10f039d0`): commit, then an immediate `CONNECTION_LOST`, three redials each re-dropping, then
 * `lost: upstream-drop` — with no transcript and no forward. Two paid isolation probes refuted the
 * obvious hypotheses (frame size/duration; connection-history + idle), so the human ruling was to
 * stop spending and instead CATCH THE NEXT NATURAL RECURRENCE with the readings the journal was
 * missing. Those are exactly the fields below, and the three classes are the three causes the
 * journal could not tell apart:
 *
 * - `upstream-close` — the upstream ended the socket, carrying the close frame's own `code`/`reason`
 *   (the reading that separates a network drop from the endpoint's idle timeout), the socket
 *   generation it happened on, which commits of that socket were still unanswered, the segment whose
 *   commit was in flight, and every segment's replay spend at that moment.
 * - `replay-exhausted` — the LOCAL budget that would have carried the segment again is spent, so no
 *   later socket will ever ask for it. `stage` says which budget: the per-segment replay budget
 *   (`replay-budget`, see {@link DEFAULT_MAX_SEGMENT_REPLAYS}) or the reconnect budget whose
 *   exhaustion means no further socket exists to replay onto (`redial-budget`).
 * - `pairing-mismatch` — the endpoint ANSWERED a commit that pairs with nothing on the open socket
 *   (a queued commit from an earlier socket generation). This is the mis-attribution
 *   {@link pendingCommitEpoch} exists to stop, and it is the one cause that produces a null `seq` on
 *   an item that really did land.
 *
 * READINGS ONLY. Nothing in this module branches on any of these fields — a forensic record that
 * changed behaviour would be a fix smuggled in under a measurement, which is the thing the task's
 * 不改变任何行为 forbids.
 */
export type RealtimeSegmentForensics =
  | {
      /** Class 1: the UPSTREAM closed the socket. */
      kind: 'upstream-close';
      /** The socket generation that ended — see {@link socketEpoch}. */
      socketEpoch: number;
      /** Whether the bridge is about to redial (its reconnect budget is not spent). */
      willRetry: boolean;
      /** The close frame's status code, or `null` when the transport could not read one. */
      closeCode: number | null;
      /** The close frame's reason, or `null` when the transport could not read one. */
      closeReason: string | null;
      /** The seqs whose commits this dying socket never answered, oldest first. */
      pendingSeqs: readonly number[];
      /** The segment whose commit is awaiting its response, or `null`. */
      committedSeq: number | null;
      /** Every segment's replay spend at the moment of the close, `[seq, used]`. */
      replays: readonly { seq: number; used: number }[];
    }
  | {
      /** Class 2: the budget that would have carried this segment again is spent. */
      kind: 'replay-exhausted';
      seq: number;
      socketEpoch: number;
      /** The replays already spent on this segment. */
      used: number;
      /** The per-segment replay ceiling ({@link DEFAULT_MAX_SEGMENT_REPLAYS} by default). */
      max: number;
      /** Which budget ran out — see the type's own doc. */
      stage: 'replay-budget' | 'redial-budget';
    }
  | {
      /** Class 3: an answer arrived that pairs with no commit of the open socket. */
      kind: 'pairing-mismatch';
      /** The endpoint's item id for the committed audio. */
      itemId: string;
      /** The socket generation the answer arrived on. */
      socketEpoch: number;
      /** The socket generation the unclaimable commits were written on. */
      pendingCommitEpoch: number;
      /** The commits that could not be claimed, oldest first. */
      pendingSeqs: readonly number[];
    };

/** How the segmented (manual-commit) path is configured. Omit it and none of it is used. */
export type RealtimeSegmentOptions = {
  /** How a segment's end is signalled upstream. Default `manual`. */
  commitMode?: RealtimeSegmentCommitMode;
  /**
   * Fallback mode only: how much REAL silence closes a segment. The upstream's VAD reads a
   * quiet stretch at least `silence_duration_ms` long as the end of speech, and the browser's
   * relay profile keeps the inter-segment gap under `RELAY_COMMIT_GAP_SEC` (2 s) so this is
   * the ceiling it also enforces. Default {@link DEFAULT_COMMIT_GAP_MS}.
   */
  commitGapMs?: number;
  /**
   * How many times ONE segment's audio may be rewritten to a fresh socket before the bridge gives
   * up on it. Default {@link DEFAULT_MAX_SEGMENT_REPLAYS} — read its reasoning there before changing
   * it: the default is an observed need, not a round number.
   */
  maxSegmentReplays?: number;
};

/** The hooks a caller uses to observe the bridge: state transitions, survived failures, captions, segments. */
export type RealtimeBridgeHooks = {
  onStateChange?: (next: RealtimeBridgeState, previous: RealtimeBridgeState) => void;
  onError?: (error: RealtimeBridgeError) => void;
  /** One interim-or-final transcription of the user's audio. Display-only — see {@link RealtimeCaption}. */
  onCaption?: (caption: RealtimeCaption) => void;
  /** One segment phase transition — see {@link RealtimeSegmentPhase}. */
  onSegmentPhase?: (event: RealtimeSegmentPhaseEvent) => void;
  /**
   * The endpoint committed one piece of the user's OWN speech into an input item
   * (`input_audio_buffer.committed`).
   *
   * WHY IT IS A HOOK AND NOT A NO-OP. This event is normal traffic the bridge does not act on — it
   * is in {@link TOLERATED_ENDPOINT_EVENTS} — but a CONSUMER needs to know that a NEW user
   * utterance actually landed. `voice-realtime-ws-proxy.service.ts`'s continuous-mode duplicate
   * guard counts these to tell "the model relayed words the user really spoke" from "the model
   * re-called `session_send` with no new audio behind it" (journal 57279cc1, 2026-10-11: one
   * sentence delivered three times). Without this signal the proxy never sees the event at all —
   * the bridge swallows it — so the guard could not exist.
   *
   * The payload carries the endpoint's `item_id` paired with the relay `seq` whose commit produced
   * it — see {@link RealtimeUserAudioCommitted}. A consumer that only wants the count ignores it.
   */
  onUserAudioCommitted?: (event: RealtimeUserAudioCommitted) => void;
  /**
   * The endpoint's own turn opened (`speech_started`) or closed (`speech_stopped`, or the
   * `committed` that ends a turn the relay closed itself). The proxy's uplink-VAD gate keeps the
   * tail flowing while the turn is open — see `UPLINK_VAD_HOLD_OPEN_MAX_MS`.
   */
  onUpstreamTurn?: (open: boolean) => void;
  /**
   * The endpoint REFUSED a segment's commit — see {@link RealtimeCommitRejected}.
   *
   * Reported ALONGSIDE the error the refusal already raises (the refusal is a real upstream failure
   * and the connection still reports it). This hook exists because the refusal has a consequence the
   * error does not carry: the segment will never be transcribed, and the segment that follows must
   * not be paired with the refused commit's slot. Fired before the error, so a consumer that marks
   * the seq has done so before anything else in the same tick reads the relay state.
   */
  onSegmentCommitRejected?: (event: RealtimeCommitRejected) => void;
  /**
   * A segment whose audio this bridge cannot vouch for — see {@link RealtimeSegmentOutcome}.
   *
   * WHY IT IS NOT SIMPLY THE ABSENCE OF A PHASE. Every other report on this bridge says something
   * POSITIVE happened: a phase is reached, an item is committed. A segment whose socket died with its
   * commit in flight reaches no phase at all in the new epoch (its seq is not queued on the new
   * socket), so without this hook the only trace of it is a `seq` the page was told about and never
   * heard of again — the "silent disappearance" the 2026-10-11 journal recorded, one layer down.
   *
   * WHEN IT FIRES. Twice at most per segment and never speculatively: at a DISCONNECT for every
   * commit of the dying socket's epoch still unanswered (`written`, or `lost(upstream-drop)` when the
   * reconnect budget is spent and no further socket will come), and at the segment's own end when the
   * socket was not open to write it (`lost(connection-closed)`). It never fires for a segment the
   * endpoint has since answered.
   */
  onSegmentOutcome?: (event: RealtimeSegmentOutcome) => void;
  /**
   * WHY that outcome happened — the 2026-10-13 forensics reading, one entry per cause.
   *
   * SEPARATE FROM {@link onSegmentOutcome}, DELIBERATELY. The outcome says WHAT the segment's fate is
   * ("written", "lost: upstream-drop"), which is what the PAGE is owed; this says WHY, which is what
   * the JOURNAL is owed, and the two have different audiences — the outcome is a page-facing verdict
   * whose shape is pinned by the reload criteria, while the forensics carry the close code, the socket
   * generation and the replay spend, none of which the page reads. Folding them together would put
   * forensic fields on a frame the browser parses.
   *
   * LOG-ONLY. A consumer (the proxy) records the event and nothing else — see
   * {@link RealtimeSegmentForensics} for why nothing may branch on it.
   */
  onSegmentForensics?: (event: RealtimeSegmentForensics) => void;
  /**
   * The model's remark on a tool result — the follow-up response's text, delivered on the resumed
   * turn the transport always opens after a function call. Non-empty only when the closing turn
   * asked the model to speak (`announce`); the `silent` turn produces none, and `respond` produces
   * "OK". This bridge would otherwise SWALLOW that text (`response.text.done` is display-only), so
   * the hook is the only path by which an announce remark can reach a consumer.
   *
   * The proxy routes it into the narrator queue when the connection's closing turn is `announce`;
   * every other closing turn ignores it. Not an error: the remark is expected traffic, unlike
   * {@link MODEL_TEXT_REPLY}, which is the model answering the USER instead of relaying.
   */
  onFollowUpText?: (event: { text: string }) => void;
};

/** How `connect` is configured. `maxConnectAttempts` bounds the initial connect AND reconnects. */
export type RealtimeBridgeOptions = {
  hooks?: RealtimeBridgeHooks;
  /**
   * How many socket opens in a row may fail or be lost before the bridge gives up. Default 3.
   *
   * CONSECUTIVE, not a session total: a connection that came up and stayed up gives the budget back
   * ({@link RealtimeBridgeOptions.reconnectStableMs}), so a long session survives any number of
   * drops, while an upstream that refuses or flaps every dial is still bounded.
   */
  maxConnectAttempts?: number;
  /**
   * How long the upstream may stay silent, after announcing speech, before the bridge reports
   * `UPSTREAM_STALLED`. Default {@link DEFAULT_STALL_MS}; 0 disables the check.
   */
  stallMs?: number;
  /**
   * How long a MALFORMED function call is HELD before it is reported as the failure it looks like.
   *
   * A malformed call is not classified when it arrives: the same unwritten JSON is produced by two
   * different causes, and only the end of its own response tells them apart. Held here, it is resolved
   * by that `response.done` — cancelled by `turn_detected` is {@link RealtimeBridgeError}'s
   * `TRUNCATED_BY_TURN` (the person spoke over the model, which re-sends), anything else is the
   * `MALFORMED_FUNCTION_CALL` it always was. This bound is the conservative fallback for a
   * `response.done` that never comes: the call is then reported as malformed exactly as before.
   * Default {@link DEFAULT_MALFORMED_SETTLE_MS}; a non-positive value arms no timer at all, so the hold
   * can then only be closed by its `response.done` or by the connection.
   */
  malformedSettleMs?: number;
  /**
   * How long a socket that came up must STAY up before it counts as a connection and resets
   * {@link RealtimeBridge.openAttempts}. Default {@link DEFAULT_RECONNECT_STABLE_MS}.
   */
  reconnectStableMs?: number;
  /** The segmented (manual-commit) path. Omitted entirely by a caller that never segments. */
  segment?: RealtimeSegmentOptions;
};

/** Tool calls tolerated between two finished utterances before the bridge stops answering them. */
const MAX_CALLS_PER_UTTERANCE = 6;

/** Silence after `speech_started` that counts as a stalled upstream (measured: healthy gaps are < 3 s). */
const DEFAULT_STALL_MS = 8_000;

/**
 * How long a MALFORMED function call waits for its own response's outcome before being reported as the
 * failure it looks like. See {@link RealtimeBridgeOptions.malformedSettleMs}.
 *
 * MEASURED: the truncating `response.done` lands in the SAME MILLISECOND as the truncated call (journal
 * `d4c9bfc4`: MALFORMED at `.664`, `response.done cancelled` at `.665`), so this bound is never reached
 * on a live wire — it exists only so that a malformed call whose response never ends is still reported.
 *
 * Deliberately SHORT: it is the "no `response.done` ever came" fallback, and falling back sooner only
 * reverts to the pre-existing report (a recoverable error frame) sooner. A long bound would delay a
 * genuine malformed report for no gain, since the live gap it guards is sub-millisecond.
 */
const DEFAULT_MALFORMED_SETTLE_MS = 1_000;

/** The Realtime session's `pcm16` input rate — what the fallback's silence frames are timed at. */
const PCM16_SAMPLE_RATE = 16_000;

/** Fallback mode's default segment-closing silence. The browser's relay profile caps the gap at 2 s. */
const DEFAULT_COMMIT_GAP_MS = 2_000;

/**
 * How many times ONE segment's audio may be rewritten to a fresh socket, across this bridge's whole
 * life, before the bridge gives up on it. Default 2.
 *
 * WHY 2 AND NOT 1 (the rule this replaced was "a segment is replayed at most once"). The journal this
 * path was written from (`e22ac831`, 2026-10-12) needed exactly two: the segment whose commit died
 * with the first socket was replayed onto the second, that dial lost every event of it and dropped
 * 1.15 s later, and a budget of one would have left the segment untranscribed while a THIRD socket was
 * about to come up and answer it. The offline reading of that sequence
 * (`voice-realtime-connection-resilience.test.ts`, D2) is the same shape: seq2's words only come back
 * because the segment is replayed a second time, onto the dial that answers.
 *
 * WHY NOT MORE. Every replay re-uploads the segment's audio and asks the endpoint to transcribe it
 * again, and the receiving side de-duplicates the extra delivery on `seq` (the proxy's
 * `deliveredSegmentSeqs`) — so a replay costs traffic and a duplicate to discard, never correctness.
 * An unbounded budget therefore turns a socket that opens but never answers into an upload loop that
 * outlives the reconnect budget the socket's own failures are bounded by. Two is the observed need
 * with one spare, and it is configurable for a deployment that measures a different one.
 *
 * THE BUDGET IS PER SEGMENT AND NEVER RESET. A segment's audio is the one already-written unit this
 * bridge can re-send, and every send of it is a second transcription of the same words; a socket that
 * came back does not make the first two attempts unspent.
 */
const DEFAULT_MAX_SEGMENT_REPLAYS = 2;

/**
 * How long a socket that came up must stay up before it counts as a connection and resets
 * {@link RealtimeBridge.openAttempts}. Default 250 ms.
 *
 * WHY A WINDOW AT ALL. The reconnect budget bounds CONSECUTIVE failures. A socket that opens and dies
 * immediately has not recovered anything — it is the same instability continuing — and counting it as
 * a recovered connection would let an upstream that accepts and drops in a loop reset the budget
 * forever, i.e. reconnect without bound. The window is what separates "came back" from "flapped".
 *
 * WHY 250 ms. It is above the scale on which a socket proves nothing and below the scale of any turn
 * a session would call served. The journal this path was written from dropped a dial 204 ms after the
 * commit that was in flight (`e22ac831`: 54.991 s → 55.195 s) — a socket that had already carried
 * three whole segments — so this window must not be read as "a turn was served"; it is only long
 * enough that a socket which dies on open cannot claim the reset, and short enough that a session
 * which reconnected for real has its budget back long before the person's next segment is spoken.
 */
const DEFAULT_RECONNECT_STABLE_MS = 250;

/**
 * Fallback mode's silence frame length. Matched to the capture pipeline's own frame
 * cadence (`voice-realtime-diagnose.service.ts`'s `CHUNK_MS`) so a segment's closing
 * silence arrives looking exactly like the audio around it.
 */
const SILENCE_FRAME_MS = 100;

/**
 * The endpoint REFUSING to commit an input audio buffer, in its own words.
 *
 * Matched on the sentence rather than on a code, because the real refusal carries no code of its
 * own: the 2026-10-12 journal `ef9daacd` logged it three times — 07:47:49.034Z (the commit closing
 * seq1), 07:49:04.873Z (seq6) and 07:49:22.919Z (seq8) — as `invalid_request_error` with
 * `Error committing input audio buffer: buffer too small, or have no audio.` and nothing else to key
 * on. The sentence names the subsystem, so it is the identifier.
 *
 * Narrow ON PURPOSE, and the trade-off is deliberate: a refusal worded some other way leaves its seq
 * queued ({@link pendingCommitSeqs}) for the next accepted commit to claim. The alternative — draining
 * the queue on ANY error — is worse, because it unpairs a commit the endpoint is about to answer
 * normally, and that costs a HEALTHY segment its attribution to cover a broken one.
 */
const COMMIT_REFUSAL = /input audio buffer/i;

/** The handle `connect` returns. */
export type RealtimeBridge = {
  readonly state: RealtimeBridgeState;
  /**
   * How many times the transport's `open` has been called SINCE the last connection that stayed up
   * (the initial connect included) — the count `maxConnectAttempts` bounds, so it is CONSECUTIVE
   * attempts rather than a session total. Reset once a socket has been open for
   * {@link DEFAULT_RECONNECT_STABLE_MS}, so a session that reconnects three times over an hour is not
   * one that failed three times in a row.
   */
  readonly openAttempts: number;
  /**
   * The follow-up credits outstanding: synthesized tool-resume `response.create`s
   * actually sent whose `response.created` has not yet claimed them. See
   * {@link followUpResponsesExpected}. Consumers: the follow-up-credit criterion
   * (`tests/voice-realtime-follow-up-credit.test.ts`), which samples it to assert the
   * invariant; production never has to read it.
   *
   * OPTIONAL so a bridge-shaped WRAPPER need not carry it: `voice-realtime-upstream-pool.ts`
   * composes a facade over a bridge and forwards only what its own consumers read. The
   * concrete bridge `connect` returns always exposes it.
   */
  readonly followUpResponsesExpected?: number;
  /**
   * Resolves when the bridge first reaches `open`, or when it has exhausted its
   * attempts and reached `closed`. The shipped implementation NEVER rejects — a
   * rejection from this promise means the error guard was removed.
   */
  whenConnected(): Promise<void>;
  sendSessionUpdate(instructions: string): void;
  sendAudioFrame(audio: string): void;
  /**
   * Opens a locally-heard utterance — the person has begun speaking, as read off OUR side of the
   * wire rather than the endpoint's.
   *
   * The pair {@link noteLocalUtteranceStart}/{@link noteLocalUtteranceEnd} exists because the stall
   * watchdog's arming flag is otherwise set only by the endpoint's `input_audio_buffer.speech_started`,
   * which makes the party that can go silent the only one able to raise the alarm. Measured
   * 2026-10-12: 118.4 s of complete upstream silence during which the person spoke ~28 s, and no
   * error was ever reported.
   *
   * Consumers: `voice-realtime-ws-proxy.service.ts`, which feeds it the boundaries its local speech
   * gate reads; and the upstream pool, which forwards it to the active bridge.
   */
  noteLocalUtteranceStart(): void;
  /**
   * Closes that utterance, and arms the stall watchdog ONLY if the upstream said nothing at all
   * while it was open.
   *
   * The guard is the whole point. A coarse energy gate cannot tell a slow-but-healthy endpoint from
   * a dead one, so arming unconditionally would manufacture "No answer — say it again" notices for
   * turns the endpoint was handling exactly as it always does. "The person spoke for N ms and the
   * upstream emitted nothing during it" is a claim our own two records can support.
   */
  noteLocalUtteranceEnd(): void;
  /**
   * The browser produced audio, whether or not that audio was forwarded upstream.
   *
   * WHY THIS IS NOT `sendAudioFrame`. Silence Tail Suppression withholds frames while the person is
   * quiet, so on a quiet connection `sendAudioFrame` stops being called for minutes at a time — and
   * the upstream pool (SPEC §C3) reads `sendAudioFrame` as the connection's activity clock, so it
   * would rotate onto a fresh session every `idleRotateMs` of a suppression that was never idle: the
   * microphone was streaming the whole time, and only the FORWARD was paused. Measured on the AC-363
   * probe (V-2), an upstream that stops receiving is closed by the endpoint itself after ~304 s, which
   * is the very thing suppression has to survive; rotating every 90 s would defeat it twenty times.
   *
   * OPTIONAL because only a bridge that HAS an idle clock can act on it. The concrete bridge owns no
   * timer, so it omits the method and a caller that never passes through a pool is unaffected; the
   * upstream pool implements it as the same `touch()` its other user verbs call.
   *
   * Consumers: `voice-realtime-ws-proxy.service.ts`, once per browser audio frame.
   */
  noteLocalActivity?(): void;
  /**
   * Opens a segment. The browser's segmenter cuts speech into segments and numbers them; the
   * number is the idempotency key the whole path keys on.
   */
  startSegment(seq: number): void;
  /** One audio frame belonging to segment `seq`. */
  sendSegmentAudio(seq: number, audio: string): void;
  /**
   * Ends segment `seq`: exactly what that means is {@link RealtimeSegmentOptions.commitMode}'s.
   *
   * The `reason` the browser gave (a pause, the max length, the end of the stream) is
   * the PROXY's to log and to carry on the ack — the upstream treatment is the same
   * whichever it was, so it does not travel through here.
   */
  endSegment(seq: number): void;
  /**
   * Closes the segment that is still open, with the frames it has so far — the End/Mute flush.
   *
   * Returns the `seq` that was closed, or `null` when no segment was open. Called on the way
   * out (a `close` frame, a socket close) so the last thing the user said is not lost to the
   * fact that they stopped talking by ending the session rather than by pausing.
   */
  flushOpenSegment(): number | null;
  /** The `seq` that has been started and not yet ended, or `null`. */
  readonly openSegmentSeq: number | null;
  /** The `seq` whose commit is awaiting its response, or `null`. */
  readonly committedSegmentSeq: number | null;
  close(): Promise<void>;
};

/** A failure the bridge itself raises, carrying the `onError` payload it maps to. */
class RealtimeBridgeFault extends Error {
  constructor(readonly bridgeError: RealtimeBridgeError) {
    super(bridgeError.code);
    this.name = 'RealtimeBridgeFault';
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function normalizeError(error: unknown): RealtimeBridgeError {
  return error instanceof RealtimeBridgeFault ? error.bridgeError : { code: 'DISPATCH_FAILED', cause: error };
}

/**
 * Reads a `response.done` as the endpoint's own detector having cut the response short because the
 * person spoke again — the shape the live trace carries (`status: 'cancelled'`,
 * `status_details: { type: 'cancelled', reason: 'turn_detected' }`).
 *
 * BOTH FIELDS ARE REQUIRED. `cancelled` alone is also what an explicit cancel produces, and a
 * `turn_detected` reason without the cancelled status is not a shape the endpoint emits; demanding the
 * pair keeps the reading from swallowing an unrelated cancellation as this benign one.
 */
function isTurnDetectedCancellation(message: RealtimeServerMessage): boolean {
  const response = (message as { response?: { status?: unknown; status_details?: { reason?: unknown } } }).response;
  return response?.status === 'cancelled' && response.status_details?.reason === 'turn_detected';
}

/**
 * The `response.id` a `response.created`/`response.done` carries, or `null`.
 *
 * An EMPTY STRING IS `null`. The live trace has `response.done` frames whose `id` is `""` on the very
 * cancellations this module classifies (`function-call-trace.json`), so treating `""` as an id would
 * make the hold's "same response" test fail against the wire it exists for.
 */
function responseIdOf(message: RealtimeServerMessage): string | null {
  const id = (message as { response?: { id?: unknown } }).response?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Runs one synchronous step, routing a throw to `onError`.
 *
 * Its body is the synchronous half of the error guard the AC-4 false form
 * deletes; keep the two lines of `try`/`catch` exactly as written.
 */
function guardSync(body: () => void, onError: (error: unknown) => void): void {
  try {
    body();
  } catch (error) {
    onError(error);
  }
}

/**
 * Runs one asynchronous step, routing a rejection to `onError`.
 *
 * Its body is the asynchronous half of the error guard the AC-4 false form
 * deletes; keep the two lines of `try`/`catch` exactly as written.
 */
async function guardAsync(body: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  try {
    await body();
  } catch (error) {
    onError(error);
  }
}

/**
 * Opens a Realtime bridge over `transport`, advertising `tools` and routing
 * function calls to `executor`.
 *
 * Consumers: this module's barrel (and, in a later task, a real Realtime
 * client); the criteria drive it over a fake transport.
 */
export function connect(
  transport: RealtimeTransport,
  tools: readonly RealtimeToolDescriptor[],
  executor: RealtimeToolExecutor,
  options: RealtimeBridgeOptions = {},
): RealtimeBridge {
  const hooks = options.hooks ?? {};
  const maxConnectAttempts = options.maxConnectAttempts ?? 3;
  const toolDeclarations: RealtimeFunctionDeclaration[] = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));

  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const reconnectStableMs = options.reconnectStableMs ?? DEFAULT_RECONNECT_STABLE_MS;
  /** Set between `speech_started` and the segment's transcription outcome; the stall timer runs only then. */
  let awaitingTranscription = false;
  /**
   * How many upstream events have arrived since the locally-heard utterance began, or `null` when
   * no local utterance is open. `0` at its end means the upstream said NOTHING while the person
   * spoke — the one reading that distinguishes a dead endpoint from a slow one. See
   * {@link RealtimeBridge.noteLocalUtteranceEnd}.
   */
  let upstreamEventsSinceLocalStart: number | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStallTimer = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStallTimer = (): void => {
    clearStallTimer();
    if (stallMs <= 0 || !awaitingTranscription) {
      return;
    }
    stallTimer = setTimeout(() => {
      stallTimer = null;
      // THE AWAITED TURN IS CLOSED HERE, not merely reported. `awaitingTranscription` is what
      // this timer is armed from, and every upstream event re-arms it — so leaving it `true`
      // across the report meant the NEXT event (a late caption, the endpoint finally waking up)
      // re-armed a fresh window and reported the same stall a second time. Clearing it says what
      // the report means: this turn has no answer, and the bridge is no longer waiting for one.
      // Only a NEW `speech_started` re-enters the awaiting state (see `dispatch`).
      awaitingTranscription = false;
      emitError({ code: 'UPSTREAM_STALLED', seconds: Math.round(stallMs / 1000) });
    }, stallMs);
    stallTimer.unref?.();
  };

  /** Tool calls handled since the user last finished saying something; a runaway loop makes this grow. */
  let callsSinceUtterance = 0;
  /**
   * Follow-up credits outstanding: synthesized tool-resume `response.create`s that
   * have genuinely left the socket and whose own `response.created` has not yet claimed them.
   *
   * GRANTED BY THE TRANSPORT, NOT BY SENDING A TOOL RESULT. The credit is a claim that
   * "the model will speak once more because we asked it to", so it is only made when a
   * synthesized `response.create` actually left the socket. A transport that suppresses or
   * never synthesizes one does not notify, and the claim is not made; the DashScope
   * transport now always sends the protocol-mandatory resume (2026-10-18: skipping it left
   * the turn unconsumed upstream), so its credit tracks that real send. The bridge accrues
   * the credit only from {@link RealtimeTransport.onSynthesizedToolResume}, which fires at
   * the actual outbound point (deferred creates notify at their flush), and the invariant
   * "额度 > 0 ⇒ 有一次已外发的合成 create 尚未被收走" holds by construction.
   */
  let followUpResponsesExpected = 0;
  /** Ids of the follow-up responses (the model's remark on a tool result), whose text is expected. */
  const followUpResponseIds = new Set<string>();

  const malformedSettleMs = options.malformedSettleMs ?? DEFAULT_MALFORMED_SETTLE_MS;
  /**
   * The id of the response the upstream is streaming right now, or `null`.
   *
   * Read from `response.created` and cleared by `response.done`. It is what makes the hold below a
   * statement about ONE response rather than about whatever event happens to arrive next — a malformed
   * call belongs to the response that was open when it landed, and only THAT response's outcome may
   * classify it. `null` when the wire never announced one, which is also the honest reading for a
   * transport whose fixture does not narrate `response.created`.
   */
  let currentResponseId: string | null = null;
  /**
   * A MALFORMED function call HELD until its own response's outcome is known, or `null`.
   *
   * WHY IT IS HELD. The same unwritten JSON ("Unexpected end of JSON input") has two causes and the
   * call itself cannot tell them apart: the model wrote a genuinely bad call, or the person spoke over
   * it and the endpoint's detector ended the response mid-argument (see
   * {@link RealtimeBridgeError}'s `TRUNCATED_BY_TURN`). Only the response's own `response.done` says
   * which, so the report waits for it — bounded by `malformedSettleMs`, and closed on the connection's
   * end, both of which fall back to reporting the malformed call as it always was.
   */
  let pendingMalformed: {
    error: Extract<RealtimeBridgeError, { code: 'MALFORMED_FUNCTION_CALL' }>;
    responseId: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  const clearMalformedTimer = (): void => {
    if (pendingMalformed !== null && pendingMalformed.timer !== null) {
      clearTimeout(pendingMalformed.timer);
      pendingMalformed.timer = null;
    }
  };
  /**
   * Reports the held call as the malformed failure it looks like — the conservative reading, taken when
   * no `response.done` classified it (the bound elapsed, or the connection ended).
   */
  const flushMalformed = (): void => {
    const pending = pendingMalformed;
    if (pending === null) return;
    clearMalformedTimer();
    pendingMalformed = null;
    emitError(pending.error);
  };
  /** Holds one malformed call, after reporting any earlier one that was still waiting. */
  const holdMalformed = (error: Extract<RealtimeBridgeError, { code: 'MALFORMED_FUNCTION_CALL' }>): void => {
    // The hold is for ONE call, and a second malformed call means the first's response already moved on:
    // reporting it now is the fallback, taken rather than dropped.
    flushMalformed();
    pendingMalformed = { error, responseId: currentResponseId, timer: null };
    if (malformedSettleMs > 0) {
      pendingMalformed.timer = setTimeout(() => {
        flushMalformed();
      }, malformedSettleMs);
      pendingMalformed.timer.unref?.();
    }
  };
  /**
   * Closes the hold on the outcome of the call's own response. `cancelledByTurn` is the caller's reading
   * of that `response.done` (see {@link isTurnDetectedCancellation}).
   */
  const settleMalformed = (cancelledByTurn: boolean): void => {
    const pending = pendingMalformed;
    if (pending === null) return;
    clearMalformedTimer();
    pendingMalformed = null;
    if (cancelledByTurn) {
      emitError({ code: 'TRUNCATED_BY_TURN', callId: pending.error.callId });
      return;
    }
    emitError(pending.error);
  };

  let state: RealtimeBridgeState = 'connecting';
  let openAttempts = 0;
  let deliberateClose = false;
  /**
   * The `instructions` the caller last advertised, or `null` until they do.
   *
   * A realtime session is PER-SOCKET: the endpoint's `session.update` (instructions
   * plus the tool declarations the model may call) does not survive the socket that
   * carried it. So a reconnect has to re-establish it, and this is the bridge's
   * memory of what to re-establish (see {@link readvertiseSession}). It stays `null`
   * on the initial connect, which is what keeps the reconnect-only traffic honest.
   */
  let lastSessionInstructions: string | null = null;

  // ----- the segmented (manual-commit) path -------------------------------------------------
  //
  // A segment is captured by the browser and handed over as one unit: `segment_start`,
  // its `audio` frames, `segment_end`. Its frames are therefore held here and written to
  // the upstream at its END, immediately followed (manual mode) by the commit — so the
  // upstream always sees `append…, commit`, never a commit that precedes the audio it
  // closes. Holding them also makes the reconnect replay exact: the same frames, in the
  // same order, once.
  //
  // WHY HOLDING IS SAFE (manual mode). The endpoint's own VAD is OFF on this path
  // (`turn_detection: null`), so there is no detector waiting on realtime pacing; the
  // endpoint transcribes the buffer when it is committed. Fallback mode is the mode that
  // DOES need live pacing — its detector is watching — so it forwards on arrival instead
  // (see {@link sendSegmentAudio}).

  const segmentMode: RealtimeSegmentCommitMode = options.segment?.commitMode ?? 'manual';
  const commitGapMs = options.segment?.commitGapMs ?? DEFAULT_COMMIT_GAP_MS;
  const maxSegmentReplays = options.segment?.maxSegmentReplays ?? DEFAULT_MAX_SEGMENT_REPLAYS;

  /** The segment being captured and not yet ended. */
  let openSegment: { seq: number; frames: string[] } | null = null;
  /**
   * The segment whose commit is awaiting its response — the anchor a replay is read
   * against. Cleared when that response completes (`settled`), or when its replay budget
   * is spent (nothing further will carry its audio).
   */
  let committedSegment: { seq: number; frames: string[] } | null = null;
  /**
   * How many times each segment has already been rewritten to a fresh socket — the
   * {@link DEFAULT_MAX_SEGMENT_REPLAYS} budget, counted per segment.
   */
  const replaysBySeq = new Map<number, number>();
  /**
   * The socket generation a commit was written on. Bumped ONLY by a successful
   * `transport.open()`, so it changes exactly when the previous socket's connection is gone.
   *
   * WHY A COMMIT NEEDS ONE. `pendingCommitSeqs` is a queue of "commits the endpoint still owes an
   * answer for", and the answer arrives on whatever socket is open when the endpoint gets round to
   * it. A socket that dies with a commit unanswered leaves that commit in the queue, and the NEXT
   * socket's first `input_audio_buffer.committed` — which belongs to the next socket's own commit —
   * would then be paired with the DEAD socket's seq. That is the mis-attribution the journal
   * `e22ac831` shows end to end: the residue shifted every later seq by one, so seq4's empty
   * transcript was reported against seq2. The epoch is what makes a pairing a fact about ONE
   * connection instead of about position in a list that outlives it.
   */
  let socketEpoch = 0;
  /** The {@link socketEpoch} the oldest queued commit was written on. */
  let pendingCommitEpoch = 0;
  /**
   * The segments whose `input_audio_buffer.commit` is on the wire and not yet answered, oldest first.
   *
   * THIS IS THE seq↔itemId PAIRING, and it is a queue rather than a lookup because that is what the
   * protocol is: the endpoint answers commits IN THE ORDER THEY WERE SENT, so the oldest unclaimed
   * seq is the one this item belongs to. Pushed where the commit is actually written (see
   * {@link writeSegmentClose}) and shifted where the endpoint answers — accepted
   * (`input_audio_buffer.committed`) or refused (the `error` branch of {@link dispatch}).
   *
   * IT NEVER OUTLIVES ITS SOCKET. Every entry is stamped with the {@link socketEpoch} it was written
   * on, and both the disconnect (`handleTransportClose`) and a refusal drain the queue of the epoch
   * they close — see {@link drainUnansweredCommits}. So an entry here is always a commit of the
   * CURRENT socket, and an answer from another epoch would be a fact about a connection this queue
   * does not describe.
   *
   * WHY BOTH ENDS MATTER. The refusal produces NO item at all (journal `ef9daacd`, 2026-10-12:
   * seq1's and seq6's commits were each answered `buffer too small, or have no audio` and created no
   * input item), so a slot left behind by a refusal would be claimed by the NEXT accepted commit —
   * and that commit's item, hence its transcript, would be attributed to the refused segment. That is
   * the mis-attribution this whole task removes, one layer down.
   */
  const pendingCommitSeqs: number[] = [];
  /**
   * Whether a segment has ever been opened on this connection — the trigger for the manual
   * VAD switch below. Once true it stays true: a connection that segment-framed audio owns
   * its utterance boundaries for its whole life.
   */
  let segmentsStarted = false;
  /** Whether the CURRENT socket has been told to turn its own detector off. Reset on every (re)open. */
  let vadDisabledOnSocket = false;

  /**
   * Turns the endpoint's OWN voice-activity detector off for a connection that has begun to segment.
   *
   * LAZY, NOT AT CONNECT. Most connections never segment (every continuous-capture client), and
   * switching the detector off for one of those would leave nobody to end an utterance: the
   * endpoint holds the audio in its buffer and transcribes nothing at all. So the switch is tied
   * to the first `segment_start` — the client saying it owns the boundary — and it is what makes
   * `turn_detection: null` a property of the segmented path rather than of the deployment.
   *
   * Re-sent after a reconnect: the detector setting lives with the socket, exactly like the
   * instructions (see {@link readvertiseSession}), so a socket that came up after a drop starts
   * with it on again. A failure to send is reported and NOT remembered, so the next open retries.
   *
   * THIS FRAME IS THE WHOLE SWITCH, AND THE TRANSPORT KEEPS IT. It is the ONE door to
   * `turn_detection: null` (`voice-realtime-turn-detection.ts`), and the transport re-states the
   * value it carried into every later full `session.update` — so the state injection
   * (`readvertiseSession` on a reconnect, `sendSessionUpdate` on a status change) can no longer
   * re-open the endpoint's detector behind this frame's back. That was the 2026-10-12 defect
   * (journal `ef9daacd`): after the first status injection the endpoint reported `speech_started`
   * ~100 ms after every manual commit and never `speech_stopped`, so the following segment was
   * refused with `buffer too small, or have no audio`. The reconnect ordering below is unchanged and
   * still matters: this frame goes out BEFORE the replayed segment, so the frames that close an
   * utterance are never written onto a socket whose detector is still watching.
   */
  function ensureManualVadOff(): void {
    if (segmentMode !== 'manual' || !segmentsStarted || vadDisabledOnSocket || state !== 'open') return;
    guardSync(
      () => {
        transport.send({ type: 'session.turn_detection', turnDetection: null });
        vadDisabledOnSocket = true;
      },
      (error) => emitError(normalizeError(error)),
    );
  }

  /** One fallback-mode stretch of real silence, as the base64 frames the endpoint takes. */
  function silenceFrames(ms: number): string[] {
    const totalBytes = Math.round((PCM16_SAMPLE_RATE * Math.max(0, ms)) / 1000) * 2;
    const frameBytes = Math.round((PCM16_SAMPLE_RATE * SILENCE_FRAME_MS) / 1000) * 2;
    const out: string[] = [];
    for (let remaining = totalBytes; remaining > 0; remaining -= frameBytes) {
      out.push(Buffer.alloc(Math.min(frameBytes, remaining)).toString('base64'));
    }
    return out;
  }

  /**
   * Writes one frame upstream if the socket is open, reporting a send failure instead of
   * letting it escape. The segment path runs from the browser's socket handler just like
   * {@link forwardAudio}, so an unguarded throw here takes the process down.
   */
  function writeSegmentFrame(audio: string): void {
    if (state !== 'open') return;
    try {
      transport.send({ type: 'input_audio_buffer.append', audio });
    } catch (cause) {
      emitError({ code: 'SEND_FAILED', cause });
    }
  }

  /**
   * Empties {@link pendingCommitSeqs}, reporting every commit the socket never answered.
   *
   * THE ONE PLACE THE QUEUE IS ALLOWED TO SHRINK WITHOUT AN ANSWER, and it exists because the queue's
   * other two exits (an accepted commit, a refused one) both require the endpoint to say something
   * about a socket that is, by definition, no longer there to say it.
   *
   * `written` — the bridge is going to redial: the segment may yet be replayed and answered, so its
   * audio MAY be upstream. The page is owed exactly this uncertainty, and it is not the same reading
   * as "lost": the journal's own double drop is a segment that was uncertain for 1.15 s and then
   * answered, and a page told "lost" there would have told the person to repeat words the model had
   * already heard.
   *
   * `lost` — the reconnect budget is spent, so no further socket will carry this audio: the segment
   * will never be transcribed, whatever the dying socket managed to deliver.
   */
  function drainUnansweredCommits(disposition: 'written' | 'lost'): void {
    while (pendingCommitSeqs.length > 0) {
      const seq = pendingCommitSeqs.shift() as number;
      if (disposition === 'written') {
        hooks.onSegmentOutcome?.({ seq, state: 'written' });
        continue;
      }
      // CLASS 2 of the forensics (2026-10-13): this seq is being reported lost because the RECONNECT
      // budget is spent — there is no later socket for the segment's replay to land on, so what is
      // exhausted here is the local redial budget rather than the per-segment replay one. Recorded
      // beside the outcome it explains, never instead of it.
      hooks.onSegmentForensics?.({
        kind: 'replay-exhausted',
        seq,
        socketEpoch,
        used: replaysBySeq.get(seq) ?? 0,
        max: maxSegmentReplays,
        stage: 'redial-budget',
      });
      hooks.onSegmentOutcome?.({ seq, state: 'lost', reason: 'upstream-drop' });
    }
  }

  /**
   * Writes the frames that close a segment upstream (manual commit, or the fallback's silence).
   *
   * The manual branch PAIRS the commit with its `seq` ({@link pendingCommitSeqs}) at the exact point
   * the commit leaves: after the send, so a transport that refused to write one never queues a seq no
   * event can claim, and before the `response.create`, which is not part of the commit — if THAT
   * throws, the commit is on the wire and the endpoint still owes this seq an answer.
   */
  function writeSegmentClose(frames: readonly string[], seq: number): void {
    if (segmentMode === 'manual') {
      // The queue's entries all belong to the socket that is open NOW — every boundary drains the
      // previous epoch ({@link drainUnansweredCommits}) — so the stamp is taken once, before this
      // commit joins it, and the answer that claims it is only read while the epochs still agree.
      pendingCommitEpoch = socketEpoch;
      for (const frame of frames) writeSegmentFrame(frame);
      if (state !== 'open') return;
      try {
        transport.send({ type: 'input_audio_buffer.commit' });
        pendingCommitSeqs.push(seq);
        transport.send({ type: 'response.create' });
      } catch (cause) {
        emitError({ code: 'SEND_FAILED', cause });
      }
      // THE WRITE ABOVE CAN BE WHAT KILLS THE SOCKET, and that is the one way an entry can outlive
      // the connection it belongs to. The endpoint may drop the connection while the commit is on
      // its way — journal `e22ac831`'s 54.991 → 55.195 ms pair is exactly that — and the close
      // handler runs INSIDE this send, so it drained a queue this `seq` had not been pushed onto
      // yet. The push above then leaves the residue: a commit of a socket that no longer exists,
      // standing at the head of the queue, where the NEXT socket's first answer — which belongs to
      // the segment the reconnect replays — would claim it. So it is reported here, like every other
      // commit of the socket that died (`written` when a redial is coming, `lost` when the budget is
      // spent — the same rule {@link handleTransportClose} applies) instead of being left behind.
      if (state !== 'open') {
        drainUnansweredCommits(openAttempts < maxConnectAttempts ? 'written' : 'lost');
      }
      return;
    }
    // Fallback: the endpoint's VAD is still on and the frames already went up as they
    // arrived, so real silence is what closes the segment.
    for (const frame of silenceFrames(commitGapMs)) writeSegmentFrame(frame);
  }

  /**
   * Re-writes the committed-but-unanswered segment onto a socket that came up after a drop.
   *
   * AT MOST {@link DEFAULT_MAX_SEGMENT_REPLAYS} times per segment, and the budget is what replaces the
   * old "exactly once": a replay can be lost like anything else (the journal's second dial took the
   * replay, lost every event of it and dropped), and a rule of one then left a segment untranscribed
   * while a third socket was about to answer it. The receiving side de-duplicates a repeated delivery
   * on `seq`, so a second replay costs a duplicate to discard and buys the segment its last chance.
   *
   * WHEN THE BUDGET IS SPENT the segment is dropped as an anchor and reported `lost(upstream-drop)`:
   * its audio will not be written again on any later socket, so whatever the endpoint did with the
   * copies it already has, this bridge will never learn the segment's words.
   *
   * Runs on the reconnect path only — `committedSegment` is `null` on a first connect — and reports
   * the `replayed` phase so the delivery side knows which `seq` it is reading.
   */
  function replayCommittedSegment(): void {
    const segment = committedSegment;
    if (segment === null) return;
    const used = replaysBySeq.get(segment.seq) ?? 0;
    if (used >= maxSegmentReplays) {
      committedSegment = null;
      // CLASS 2 of the forensics (2026-10-13): the segment has spent its per-segment replay budget,
      // which is the LOCAL cause of this loss and not an upstream one. Reported before the outcome
      // that carries the same verdict to the page.
      hooks.onSegmentForensics?.({
        kind: 'replay-exhausted',
        seq: segment.seq,
        socketEpoch,
        used,
        max: maxSegmentReplays,
        stage: 'replay-budget',
      });
      hooks.onSegmentOutcome?.({ seq: segment.seq, state: 'lost', reason: 'upstream-drop' });
      return;
    }
    replaysBySeq.set(segment.seq, used + 1);
    writeSegmentClose(segment.frames, segment.seq);
    hooks.onSegmentPhase?.({ seq: segment.seq, phase: 'replayed' });
  }

  const setState = (next: RealtimeBridgeState): void => {
    if (next === state) return;
    const previous = state;
    state = next;
    hooks.onStateChange?.(next, previous);
  };
  const emitError = (error: RealtimeBridgeError): void => {
    hooks.onError?.(error);
  };

  // ----- the message loop -----

  /** Guards ONE server event. A malformed one is reported, never allowed to escape. */
  function dispatchSafely(message: RealtimeServerMessage): void {
    guardSync(
      () => dispatch(message),
      (error) => emitError(normalizeError(error)),
    );
  }

  function dispatch(message: RealtimeServerMessage): void {
    // Any upstream event during a locally-heard utterance clears the local path's claim that this
    // endpoint is silent — see `noteLocalUtteranceEnd`. Counted BEFORE the stall bookkeeping so the
    // event that ends a stall is never itself misread as part of the silence.
    if (upstreamEventsSinceLocalStart !== null) {
      upstreamEventsSinceLocalStart += 1;
    }
    // Stall bookkeeping: a segment is "awaiting" from `speech_started` until its
    // transcription settles; any upstream event in between proves it is alive.
    if (message.type === 'input_audio_buffer.speech_started') {
      hooks.onUpstreamTurn?.(true);
    } else if (
      message.type === 'input_audio_buffer.speech_stopped' ||
      message.type === 'input_audio_buffer.committed'
    ) {
      hooks.onUpstreamTurn?.(false);
    }
    if (message.type === 'input_audio_buffer.speech_started') {
      awaitingTranscription = true;
    } else if (
      message.type === 'conversation.item.input_audio_transcription.completed' ||
      message.type === 'conversation.item.input_audio_transcription.failed'
    ) {
      awaitingTranscription = false;
    }
    armStallTimer();

    if (message.type === 'response.created' && followUpResponsesExpected > 0) {
      followUpResponsesExpected -= 1;
      const id = (message as { response?: { id?: unknown } }).response?.id;
      if (typeof id === 'string') {
        followUpResponseIds.add(id);
      }
    }
    // The response now open is the one a malformed call arriving next belongs to (see `pendingMalformed`).
    if (message.type === 'response.created') {
      currentResponseId = responseIdOf(message);
    }

    // The response a committed segment asked for has finished: nothing more is coming for
    // that `seq`, so the delivery side may stop keying on it. Read before the general
    // handling below, which does not act on `response.done`.
    if (message.type === 'response.done') {
      const segment = committedSegment;
      if (segment !== null) {
        committedSegment = null;
        hooks.onSegmentPhase?.({ seq: segment.seq, phase: 'settled' });
      }
      // THE HELD MALFORMED CALL IS CLASSIFIED HERE, on its own response's outcome and nothing else.
      // A response that ran to a clean end met a genuinely bad call; one its own detector cancelled
      // because the person spoke again met a call cut off mid-argument, which the model re-sends.
      const doneId = responseIdOf(message);
      const pending = pendingMalformed;
      if (pending !== null && (pending.responseId === null || doneId === null || pending.responseId === doneId)) {
        settleMalformed(isTurnDetectedCancellation(message));
      }
      currentResponseId = null;
    }

    if (message.type === 'function_call') {
      // A MALFORMED call is HELD, not thrown: whether it is a defect or the endpoint's detector cutting
      // the model off mid-argument is decided by the response's own `response.done`, read above and
      // applied at the settle below. Every other fault keeps the throw it always had.
      try {
        handleFunctionCall(message as RealtimeFunctionCall);
      } catch (error) {
        const fault = error instanceof RealtimeBridgeFault ? error.bridgeError : null;
        if (fault !== null && fault.code === 'MALFORMED_FUNCTION_CALL') {
          holdMalformed(fault);
          return;
        }
        throw error;
      }
      return;
    }
    // A committed user utterance: the endpoint's server-side VAD has closed one piece of the
    // user's speech and put its audio into an input item. The bridge itself never acts on it —
    // it is TOLERATED below — but a consumer needs to know a NEW utterance landed, so the hook
    // fires here and control returns before the tolerated-return below (the event must still
    // NOT be reported as an error: a continuously-capturing session emits these constantly).
    if (message.type === 'input_audio_buffer.committed') {
      // The endpoint answering an outstanding commit, in order. Shift BEFORE the hook so a consumer
      // that pairs the item id can never see the queue still holding it.
      //
      // ONLY THE CURRENT SOCKET'S COMMITS MAY BE CLAIMED. A `committed` arriving now was produced by
      // the socket that is open now, so a queued seq from an EARLIER socket — one this bridge has
      // already redialled past — must not claim it: that pairing is a fact about a connection that no
      // longer exists, and it is what shifted every later seq by one in journal `e22ac831`. The
      // disconnect drains those entries ({@link drainUnansweredCommits}), so this is the second of two
      // independent guards and the one that holds if a drain is ever missed.
      //
      // `null` when nothing was outstanding: the endpoint's OWN detector committed a piece of speech
      // this relay never asked about (a continuous-capture session, or the fallback's server-VAD
      // path). The item exists and is the user's — but it belongs to no `seq` of ours, and saying so
      // is the point: a consumer must not hand it to whichever segment happens to be open.
      const seq = pendingCommitEpoch === socketEpoch ? (pendingCommitSeqs.shift() ?? null) : null;
      const itemId = message.item_id;
      // CLASS 3 of the forensics (2026-10-13): the epoch guard above refused to pair this answer and
      // there WERE commits waiting to be paired — an answer that landed but belongs to no commit of
      // the open socket. This is the mis-attribution the guard exists to stop, so when it fires it is
      // recorded: the alternative is a `seq` of `null` on a real item with nothing on disk saying the
      // pairing broke rather than that the endpoint's own detector committed it. A queue that is
      // ALREADY empty is not this class — a `null` there is the honest "no commit of ours" reading.
      if (pendingCommitEpoch !== socketEpoch && pendingCommitSeqs.length > 0) {
        hooks.onSegmentForensics?.({
          kind: 'pairing-mismatch',
          itemId: typeof itemId === 'string' ? itemId : '',
          socketEpoch,
          pendingCommitEpoch,
          pendingSeqs: [...pendingCommitSeqs],
        });
      }
      hooks.onUserAudioCommitted?.({ itemId: typeof itemId === 'string' ? itemId : '', seq });
      return;
    }
    // Normal traffic from the endpoint that this bridge does not act on. It is
    // TOLERATED rather than reported: these are the endpoint answering us and
    // narrating its own turn, not failures, and faulting on them kills a session
    // that is working. `session.updated` is the reply to the `session.update`
    // WE send on connect — so before this, every real session died on its first
    // handshake reply, while the criteria's stand-in (which spoke only
    // `response.function_call_arguments.done`) never showed it.
    if (TOLERATED_ENDPOINT_EVENTS.has(message.type)) {
      return;
    }
    // The user's own audio, transcribed. Recognised rather than reported: a
    // continuous-capture session emits these constantly, so routing them to the
    // error channel (as this bridge did before AC-317) would leave the browser
    // holding a stream of unexplained failures for a session that is working.
    if (message.type === 'conversation.item.input_audio_transcription.delta') {
      handleCaption(message, false);
      return;
    }
    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      callsSinceUtterance = 0;
      handleCaption(message, true);
      return;
    }
    if (message.type === 'response.text.done') {
      const text = String((message as { text?: unknown }).text ?? '').trim();
      const responseId = (message as { response_id?: unknown }).response_id;
      const isFollowUp = typeof responseId === 'string' && followUpResponseIds.delete(responseId);
      // A function-call response closes its (empty) text part too, and the model's remark on a
      // tool result is expected; only a real reply to the user's words is news.
      if (text !== '' && !isFollowUp) {
        throw new RealtimeBridgeFault({ code: 'MODEL_TEXT_REPLY', text });
      }
      if (text !== '' && isFollowUp) {
        hooks.onFollowUpText?.({ text });
      }
      return;
    }
    if (message.type === 'error') {
      const detail = (message as { error?: { message?: unknown; code?: unknown } }).error;
      const detailMessage = typeof detail?.message === 'string' ? detail.message : '';
      // A REFUSED COMMIT is answered by this error and by nothing else — no
      // `input_audio_buffer.committed` ever follows it (journal `ef9daacd`, 2026-10-12 07:47:49Z and
      // 07:49:04Z: seq1's and seq6's commits were refused and created no item). So the slot has to be
      // released HERE, or the next accepted commit claims it and ITS item — hence its transcript —
      // is attributed to the refused segment. Reported before the fault below, so a consumer that
      // marks the seq has done so by the time the error surfaces.
      if (pendingCommitSeqs.length > 0 && COMMIT_REFUSAL.test(detailMessage)) {
        const seq = pendingCommitSeqs.shift() as number;
        hooks.onSegmentCommitRejected?.({ seq, message: detailMessage });
      }
      throw new RealtimeBridgeFault({
        code: 'UPSTREAM_ERROR',
        message: [detail?.code, detail?.message].filter((part) => typeof part === 'string').join(': ') || 'the endpoint reported an error',
      });
    }
    if (message.type === 'conversation.item.input_audio_transcription.failed') {
      const detail = (message as { error?: { message?: unknown } }).error;
      throw new RealtimeBridgeFault({
        code: 'TRANSCRIPTION_FAILED',
        message: typeof detail?.message === 'string' ? detail.message : 'a spoken segment could not be transcribed',
      });
    }
    // Any event type this bridge does not know: reported, not fatal.
    throw new RealtimeBridgeFault({ code: 'UNKNOWN_EVENT', eventType: String(message.type) });
  }

  /**
   * Routes one transcription event to `onCaption`.
   *
   * The endpoint's field names differ between the two events and neither is
   * self-describing: a `delta` carries the running text in `stash` (its `text`
   * field is present but EMPTY on every delta — confirmed against the preserved
   * live capture in `experiments/voice-realtime-ambiguity/real-trace/`), while
   * `completed` carries the final text in `transcript`. Reading `text` here would
   * produce an empty caption on every interim event.
   *
   * A caption that does not conform is DROPPED, not escalated. It is display-only
   * and non-actionable, so reporting it would spend the error channel — which the
   * browser renders as a session failure — on something the session survives.
   */
  function handleCaption(message: RealtimeServerMessage, final: boolean): void {
    const itemId = message.item_id;
    const text = final ? message.transcript : message.stash;
    if (typeof itemId !== 'string' || typeof text !== 'string') {
      return;
    }
    hooks.onCaption?.({ itemId, text, final });
  }

  function handleFunctionCall(call: RealtimeFunctionCall): void {
    if (typeof call.name !== 'string' || typeof call.callId !== 'string' || typeof call.arguments !== 'string') {
      throw new RealtimeBridgeFault({ code: 'MALFORMED_FUNCTION_CALL', callId: String(call.callId), reason: 'missing callId/name/arguments' });
    }
    // Several calls for ONE utterance are normal (it is relayed in pieces); a dozen is a loop.
    callsSinceUtterance += 1;
    if (callsSinceUtterance > MAX_CALLS_PER_UTTERANCE) {
      throw new RealtimeBridgeFault({ code: 'TOOL_LOOP_GUARD', calls: callsSinceUtterance });
    }
    // The routing table lookup: the tool NAME the model chose selects its executor.
    const handler = executor[call.name];
    if (handler === undefined) {
      throw new RealtimeBridgeFault({ code: 'UNKNOWN_TOOL', tool: call.name, callId: call.callId });
    }
    const args = parseFunctionCallArguments(call);
    let result: unknown;
    try {
      result = handler(args);
    } catch (cause) {
      throw new RealtimeBridgeFault({ code: 'TOOL_EXECUTION_FAILED', tool: call.name, callId: call.callId, cause });
    }
    if (isThenable(result)) {
      result.then(
        (value) => sendFunctionCallOutput(call, value),
        (cause) => emitError({ code: 'TOOL_EXECUTION_FAILED', tool: call.name, callId: call.callId, cause }),
      );
      return;
    }
    sendFunctionCallOutput(call, result);
  }

  /** Parses the wire's JSON `arguments`, preserving field order (never re-keys or reorders). */
  function parseFunctionCallArguments(call: RealtimeFunctionCall): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch (cause) {
      throw new RealtimeBridgeFault({ code: 'MALFORMED_FUNCTION_CALL', callId: call.callId, reason: `arguments are not JSON: ${String(cause)}` });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RealtimeBridgeFault({ code: 'MALFORMED_FUNCTION_CALL', callId: call.callId, reason: 'arguments must be a JSON object' });
    }
    return parsed as Record<string, unknown>;
  }

  function sendFunctionCallOutput(call: RealtimeFunctionCall, output: unknown): void {
    try {
      // The follow-up credit is NOT accrued here: sending a tool result does not by
      // itself make the model speak again. The transport decides whether its
      // synthesized `response.create` goes out, and it is that frame — and only that
      // frame — that grants the credit, through {@link RealtimeTransport.onSynthesizedToolResume}.
      if (isNoToolResumeOutput(output)) {
        transport.send({ type: 'function_call_output', callId: call.callId, output: output.output, resume: false });
      } else {
        transport.send({ type: 'function_call_output', callId: call.callId, output });
      }
    } catch (cause) {
      emitError({ code: 'SEND_FAILED', cause });
    }
  }

  // ----- the connection loop -----

  /** Tries one socket open. A failure is reported and answered `false`, never thrown. */
  async function attemptOpen(): Promise<boolean> {
    openAttempts += 1;
    // A new socket has the endpoint's own detector ON whatever the previous one was told —
    // session settings do not survive the socket (see {@link ensureManualVadOff}).
    vadDisabledOnSocket = false;
    let opened = false;
    await guardAsync(
      async () => {
        await transport.open();
        opened = true;
      },
      (cause) => {
        emitError({ code: 'CONNECTION_FAILED', attempt: openAttempts, maxAttempts: maxConnectAttempts, cause });
      },
    );
    // The epoch turns over here and ONLY here: a successful open means whatever socket carried the
    // previous epoch is gone, so a commit queued under it can no longer be answered by anything — see
    // {@link socketEpoch}. A refused open changes nothing: no socket existed to carry a commit.
    if (opened) {
      socketEpoch += 1;
    }
    return opened;
  }

  /**
   * The window after which a socket that is still up counts as a connection and gives the reconnect
   * budget back (see {@link DEFAULT_RECONNECT_STABLE_MS}), and the timer that carries it.
   */
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStableTimer = (): void => {
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  /**
   * Arms that window. Called once per successful open.
   *
   * The epoch is captured rather than re-read when the timer fires: a socket that died and was
   * replaced inside the window is a DIFFERENT connection, and the reset belongs to the one that
   * stayed — which is exactly the case this whole mechanism exists to keep out of the count.
   */
  function armReconnectReset(): void {
    clearStableTimer();
    if (reconnectStableMs <= 0) {
      openAttempts = 0;
      return;
    }
    const epoch = socketEpoch;
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (state === 'open' && socketEpoch === epoch) {
        openAttempts = 0;
      }
    }, reconnectStableMs);
    stableTimer.unref?.();
  }

  /**
   * Re-advertises the session on a socket that came up AFTER a drop.
   *
   * The reconnect loop re-dials; the new socket knows nothing, so the bridge
   * re-sends the instructions and tool declarations the caller last advertised.
   * Nothing is sent on the initial connect — `lastSessionInstructions` is still
   * `null` then — so this adds traffic ONLY to a reconnect, and a drop before the
   * caller ever advertised anything stays a pure reconnect. Runs through the same
   * error guard as every other step on the loop, so a send failure is reported
   * rather than escaping the `void`-started `openLoop()`.
   */
  function readvertiseSession(): void {
    const instructions = lastSessionInstructions;
    if (instructions === null) return;
    guardSync(
      () => transport.send({ type: 'session.update', session: { instructions, tools: toolDeclarations } }),
      (error) => emitError(normalizeError(error)),
    );
  }

  /**
   * Drives attempts until the socket is open or the budget is spent, then settles.
   * Resolves on `open` or `closed`; it rejects only if the guard was removed.
   */
  async function openLoop(): Promise<void> {
    for (;;) {
      if (openAttempts >= maxConnectAttempts) {
        setState('closing');
        setState('closed');
        return;
      }
      const opened = await attemptOpen();
      if (opened) {
        if (deliberateClose) return;
        setState('open');
        // The reconnect budget is given back to a socket that STAYS up — see
        // {@link DEFAULT_RECONNECT_STABLE_MS}. Armed here, before the re-advertisement and the
        // replay, because it measures the CONNECTION and neither of those is part of coming up.
        armReconnectReset();
        // A socket that came up after a drop has no session of its own.
        readvertiseSession();
        // …and not the detector setting either: a connection that had already begun to segment
        // gets its own VAD turned back off here, before the replayed segment goes up.
        ensureManualVadOff();
        // …nor any audio: the segment the drop interrupted went with the old socket, so it
        // is written again here, once. A no-op on a first connect.
        replayCommittedSegment();
        return;
      }
    }
  }

  /** An UNEXPECTED close (the server dropped us). A deliberate `close()` never lands here. */
  function handleTransportClose(detail?: RealtimeCloseDetail): void {
    if (deliberateClose || state === 'closed' || state === 'closing') return;
    const willRetry = openAttempts < maxConnectAttempts;
    // CLASS 1 of the forensics (2026-10-13): the upstream ending the socket, recorded BEFORE the drain
    // below empties the queue — the commits this socket never answered are the reading that says
    // whether a segment was in flight when it died. `detail` carries the close frame's own code and
    // reason when the transport could read them (a `1006` and the endpoint's `1007
    // response_idle_timeout` are the two shapes the segmented losses could be), and `null` when it
    // could not, which is a reading too — an absent detail is never written as a code.
    hooks.onSegmentForensics?.({
      kind: 'upstream-close',
      socketEpoch,
      willRetry,
      closeCode: typeof detail?.code === 'number' ? detail.code : null,
      closeReason: typeof detail?.reason === 'string' ? detail.reason : null,
      pendingSeqs: [...pendingCommitSeqs],
      committedSeq: committedSegment?.seq ?? null,
      replays: [...replaysBySeq.entries()].map(([seq, used]) => ({ seq, used })),
    });
    clearStableTimer();
    // A call held for a `response.done` this socket will never deliver is reported as the malformed
    // failure it looks like: the classified reading needs the wire, and the wire is gone.
    flushMalformed();
    emitError({ code: 'CONNECTION_LOST', attempt: openAttempts, maxAttempts: maxConnectAttempts, willRetry });
    // THE EPOCH ENDS HERE. Every commit this socket never answered is reported now, while the queue
    // still describes a connection the caller has heard of: `written` when a redial is coming (the
    // segment may be replayed onto it), `lost(upstream-drop)` when the budget is spent and no further
    // socket will carry its audio. Emptied BEFORE any of them can be answered — the socket that owed
    // the answer is gone, and the reading the page gets ("no answer for this seq on this connection")
    // is a fact, not a guess.
    drainUnansweredCommits(willRetry ? 'written' : 'lost');
    if (!willRetry) {
      setState('closing');
      setState('closed');
      return;
    }
    setState('connecting');
    void openLoop();
  }

  const unsubscribeMessages = transport.subscribe(dispatchSafely);
  const unsubscribeClose = transport.onClose(handleTransportClose);
  // The ONE event that may grant a follow-up credit: the transport telling us its
  // synthesized tool-resume `response.create` actually left the socket. A transport
  // that omits the hook can never grant one (see {@link RealtimeTransport.onSynthesizedToolResume}).
  const unsubscribeSynthesizedResume = transport.onSynthesizedToolResume?.(() => {
    followUpResponsesExpected += 1;
  });
  const connection = openLoop();

  return {
    get state(): RealtimeBridgeState {
      return state;
    },
    get openAttempts(): number {
      return openAttempts;
    },
    get followUpResponsesExpected(): number {
      return followUpResponsesExpected;
    },
    whenConnected: () => connection,
    sendSessionUpdate(instructions: string): void {
      // Remembered so a reconnect can re-advertise it: the session lives with the socket.
      lastSessionInstructions = instructions;
      transport.send({ type: 'session.update', session: { instructions, tools: toolDeclarations } });
    },
    sendAudioFrame(audio: string): void {
      // A frame that arrives while the upstream is not open is DROPPED, never
      // forwarded. The transport refuses to send in that state by throwing, and
      // this call sits directly under the browser's socket handler — so an
      // unguarded send turns "the user kept talking during a reconnect" into an
      // exception escaping an EventEmitter, which takes the whole process down
      // and every other user's connection with it. The reconnect re-advertises
      // the session when it lands; the frames in between are stale audio, and
      // dropping them is the correct reading, not a loss.
      if (state !== 'open') {
        return;
      }
      transport.send({ type: 'input_audio_buffer.append', audio });
    },
    noteLocalUtteranceStart(): void {
      upstreamEventsSinceLocalStart = 0;
    },
    noteLocalUtteranceEnd(): void {
      const silent = upstreamEventsSinceLocalStart === 0;
      upstreamEventsSinceLocalStart = null;
      if (!silent) {
        return;
      }
      // The endpoint owed this utterance an answer and, by our own count, has said nothing about
      // it. Entering the awaiting state is what arms the timer; a transcription that does arrive
      // still clears it through the ordinary path, so this can only ever report silence that
      // outlasted the window.
      awaitingTranscription = true;
      armStallTimer();
    },
    startSegment(seq: number): void {
      // The first segment of a connection is what turns the endpoint's own detector off
      // (manual mode): from here on nothing upstream may close an utterance but the commit.
      segmentsStarted = true;
      ensureManualVadOff();
      openSegment = { seq, frames: [] };
    },
    sendSegmentAudio(seq: number, audio: string): void {
      // Frames for a `seq` whose start never arrived still go to the segment they name:
      // a dropped `segment_start` must not cost the user their audio. Anything for the
      // segment already open is appended to it, which is what the reconnect replay reads.
      if (openSegment === null || openSegment.seq !== seq) {
        openSegment = { seq, frames: [] };
      }
      openSegment.frames.push(audio);
      // Fallback mode's endpoint VAD is watching, so its audio has to arrive as it was
      // spoken. Manual mode's endpoint is not, and holds it until the commit instead.
      if (segmentMode === 'server-vad') {
        writeSegmentFrame(audio);
      }
    },
    endSegment(seq: number): void {
      const segment = openSegment !== null && openSegment.seq === seq ? openSegment : { seq, frames: [] };
      openSegment = null;
      // A segment whose end is handled while the socket is NOT open was never written anywhere: no
      // frames, no commit, and nothing the endpoint could answer. Its audio is not uncertain — it is
      // LOST, and the connection is the only reason there is. Reported INSTEAD of a phase, because a
      // `committed` phase here is what told the page a segment had been taken when nothing had left
      // the process at all (journal `e22ac831`: seqs 7–12 were each answered `segment_ack committed`
      // with nothing on the wire, after the reconnect budget was spent).
      if (state !== 'open') {
        hooks.onSegmentOutcome?.({ seq: segment.seq, state: 'lost', reason: 'connection-closed' });
        return;
      }
      committedSegment = { seq: segment.seq, frames: segment.frames };
      writeSegmentClose(segment.frames, segment.seq);
      hooks.onSegmentPhase?.({ seq: segment.seq, phase: 'committed' });
    },
    flushOpenSegment(): number | null {
      const segment = openSegment;
      if (segment === null) return null;
      openSegment = null;
      if (state !== 'open') {
        hooks.onSegmentOutcome?.({ seq: segment.seq, state: 'lost', reason: 'connection-closed' });
        return segment.seq;
      }
      committedSegment = { seq: segment.seq, frames: segment.frames };
      writeSegmentClose(segment.frames, segment.seq);
      hooks.onSegmentPhase?.({ seq: segment.seq, phase: 'committed' });
      return segment.seq;
    },
    get openSegmentSeq(): number | null {
      return openSegment?.seq ?? null;
    },
    get committedSegmentSeq(): number | null {
      return committedSegment?.seq ?? null;
    },
    async close(): Promise<void> {
      deliberateClose = true;
      awaitingTranscription = false;
      clearStallTimer();
      clearStableTimer();
      // Same reading as an unexpected close: no `response.done` is coming for a socket being torn down,
      // so a still-held malformed call is reported rather than silently dropped.
      flushMalformed();
      setState('closing');
      await transport.close();
      unsubscribeMessages();
      unsubscribeClose();
      unsubscribeSynthesizedResume?.();
      setState('closed');
    },
  };
}
