/**
 * The Live Voice WebSocket wire contract: the frames the browser and the relay exchange, the
 * execution-status reading the relay renders, and the seams the composition root injects.
 *
 * WHY THIS MODULE EXISTS. These declarations used to live in `voice-realtime-ws-proxy.service.ts`,
 * the 6.5k-line connection handler. Every leaf that only needed ONE shape — the TTS seam, the
 * narrator queue, the frame registry, the diagnosis route — had to import the whole handler to get
 * it, so the contract could not be reused or type-tested independently of the god file. They are
 * moved here verbatim (a pure relocation; no runtime behaviour changed) and the handler re-exports
 * them, so every existing import path still resolves.
 *
 * PURITY. This module carries only type declarations plus the one constant the contract's callers
 * need (`VOICE_QUEUE_MAX_BYTES`, the relay queue's byte bound). It must not grow runtime logic: the
 * handler owns behaviour, this file owns the shape of what crosses the wire.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts` (the handler), `voice-realtime-tts-local.ts`,
 * `voice-realtime-narrator.ts`, `voice-realtime-live-executor.ts`,
 * `voice-realtime-frame-registry.ts`, `voice-realtime-diagnose.service.ts`, and the module barrel
 * (`index.ts`). The browser side mirrors these shapes in
 * `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts`.
 */
import type { VoiceRealtimeAudioCapture } from './voice-realtime-audio-capture.js';
import type {
  RealtimeBridgeState,
  RealtimeSegmentCommitMode,
  RealtimeSegmentEndReason,
  RealtimeToolExecutor,
  RealtimeTransport,
} from './voice-realtime-bridge.service.js';
import type { VoiceRealtimeClosingTurn } from './voice-realtime-closing-turn.js';
import type { VoiceRealtimeFrameRegistry } from './voice-realtime-frame-registry.js';
import type { VoiceRealtimeTransport } from './voice-realtime-mode.js';
import type { OmissionFillParams } from './voice-realtime-omission-fill.js';
import type { VoiceRealtimeSettings } from './voice-realtime-settings.js';
import type { SilenceTailOptions } from './voice-realtime-silence-tail.js';
import type { VoiceSpeakerTrackerSeam } from './voice-realtime-speaker-seam.js';
import type {
  VoiceRealtimeTtsFrame,
  VoiceRealtimeTtsInput,
  VoiceRealtimeTtsResult,
} from './voice-realtime-tts.js';
import type { VoiceRealtimeTrunkStepRegistry } from './voice-realtime-trunk-steps.js';
import type { TurnDetectionValues } from './voice-realtime-turn-detection.js';
import type { UplinkVadClassifier } from './voice-realtime-uplink-vad.js';
import type { UpstreamPoolRotation } from './voice-realtime-upstream-pool.js';

//----------------- the relay queue's byte bound ------------

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

//----------------- execution status ------------

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

//----------------- browser wire frames ------------

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

//----------------- host readings the seams carry ------------

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

//----------------- narrator queue ------------

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

//----------------- narrator seams ------------

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

//----------------- uplink VAD seam ------------

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

//----------------- run-end summary seams ------------

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

//----------------- the injected seams ------------

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
   * THIS connection's settings reading, already taken by the composition root — the ONE reading the
   * connection uses for every file-sourced knob.
   *
   * WHY IT TRAVELS THROUGH THE SEAM. `server/index.ts` resolves the spend guard before the proxy
   * starts, and the proxy needs the same reading for the context pack's size and the injected
   * prompt. If each side read the file itself, an edit landing between the two reads would give one
   * connection a cap from the old file and a pack budget from the new one — exactly the split
   * reading this seam exists to prevent. The proxy uses this reading when present and only falls
   * back to loading the file when a criterion constructs the connection without a composition root.
   *
   * Optional: absent is the historical per-connection `loadVoiceRealtimeSettings` call, so a leaf
   * test's hand-built seams keep working unchanged.
   */
  settings?: VoiceRealtimeSettings;
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
   * This connection's SPEAKER TRACKING observer (Phase 1, shadow), or absent for "off".
   *
   * PRESENCE IS THE SWITCH, exactly like {@link audioCapture}: `server/index.ts` builds this only when
   * `VOICE_SPEAKER_TRACKING=shadow` resolved AND the CAM++ model finished loading, so a deployment that
   * named nothing — or whose model failed to load — gets `speakerTracker === undefined` and the relay is
   * byte-for-byte the one it was before this seam existed (AC6).
   *
   * WHAT IT CAN SEE. The proxy hands it completed 2 s windows decoded from the browser's PCM. It is a
   * SIDE CHANNEL: the frame is forwarded before, and independently of, the observation. The seam has no
   * way to drop, rewrite, delay or commit audio, and nothing it returns is sent to the browser — only
   * `speaker_shadow` log lines. That is what "shadow" means here, and it is structural rather than a
   * convention.
   *
   * IT READS BOTH WIRES. Unlike {@link silenceTail}/{@link uplinkVad} (which rewrite the continuous
   * uplink and therefore only apply there), the observer takes a copy of every `{type:'audio'}` frame,
   * segmented or continuous: the default relay is segmented, so a shadow that only looked at the
   * continuous wire would observe nothing on a stock deployment.
   */
  speakerTracker?: VoiceSpeakerTrackerSeam;
  /**
   * The inbound-frame dispatch seam: the registry this connection routes parsed frames through.
   *
   * Optional, and absent is the shipped set — {@link createDefaultVoiceRealtimeFrameRegistry},
   * whose handlers live in `voice-realtime-frame-handlers.ts`. A criterion hands in its own
   * registry so a probe registered from the test file is what a real connection dispatches on
   * (and so unregistering that probe proves the dispatch really consults the registry). The
   * handlers never see this object; it is the connection's routing table, not a handler input.
   */
  frameRegistry?: VoiceRealtimeFrameRegistry;
  /**
   * The connection-lifecycle step table: the ordered steps this connection runs at each trunk
   * timing (after the handshake, around every frame, at the interrupt fence, at each status
   * injection, on the way out).
   *
   * Optional, and absent is the shipped set — {@link createDefaultVoiceRealtimeTrunkSteps}, whose
   * steps live in `voice-realtime-trunk-step-handlers.ts`. A criterion hands in its own table so a
   * step registered from the test file is what a real connection runs at that timing (and so
   * unregistering that step proves the traversal really consults the table). The steps never see
   * this object; it is the connection's schedule, not a step input.
   */
  trunkSteps?: VoiceRealtimeTrunkStepRegistry;
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
