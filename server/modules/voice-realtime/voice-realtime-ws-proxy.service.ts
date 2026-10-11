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
import { WebSocket } from 'ws';

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
  type RealtimeSegmentPhaseEvent,
  type RealtimeToolExecutor,
  type RealtimeTransport,
} from './voice-realtime-bridge.service.js';
import {
  composeVoiceRealtimeInstructions,
  loadVoiceRealtimeSettings,
} from './voice-realtime-settings.js';
import { VOICE_REALTIME_TOOLS } from './voice-realtime-tools.js';
import { createUpstreamPool, type UpstreamPoolRotation } from './voice-realtime-upstream-pool.js';
import {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  describeVoiceRealtimeMode,
  resolveVoiceRealtimeMode,
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
 */
export const VOICE_REALTIME_INSTRUCTIONS = [
  'You are a voice relay for one Claude Code session.',
  'You never answer, comment or reason yourself, and you never reply in text.',
  'EVERYTHING the user says — instructions, questions, remarks, feedback, even a single',
  'word — must be passed on by calling the `session_send` function with `{ message }`,',
  'where message is what the user said, kept in their own words (fix obvious',
  'speech-recognition slips only). Always call the function; never produce a text reply.',
  'The ONE exception is a stop: if the user tells you to stop — "stop", "停", "停下",',
  '"别做了" — call the `session_interrupt` function instead of `session_send`, then reply',
  'with the single word OK and say nothing else.',
  'The session is fixed by the connection; never name one.',
].join(' ');

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

/** How often a spoken instruction re-tries a session that is mid-turn. */
const BUSY_RETRY_INTERVAL_MS = 2_000;
/** How long it keeps trying before giving up and saying so. A turn longer than this is not waited out. */
const BUSY_RETRY_MAX_MS = 120_000;

/**
 * How many of the user's spoken messages may be WAITING before the relay refuses the next one.
 *
 * WHY A CAP AT ALL. Measured 2026-10-11 (01:54–01:57 CST, tag `d88c6722`): the operator spoke for
 * over two minutes into a session whose turn was in flight; four deliveries were accepted, three of
 * them silently piled up in the session's own queue, and the screen showed one message. Nothing told
 * the operator that three sentences were still waiting, and nothing bounded how many could. Every
 * accepted message is a promise the session will answer it; an unbounded queue is a promise the
 * session cannot keep, and one the operator cannot see.
 *
 * WHY IT CANNOT BE A CANCELLATION. The provider's `cancelQueuedInput` slot is `false` for the
 * Claude provider (see `provider-capabilities.service.ts`), so a message already handed over cannot
 * be taken back. The bound therefore has to be enforced BEFORE `base.session_send` is reached —
 * which is exactly where {@link handleVoiceRealtimeConnection}'s `sessionSend` judges it — rather
 * than by dropping an item the session is already holding.
 *
 * WHY THREE. It is the same order of magnitude as the measured pile-up (three messages), and it is
 * deliberately small: the cap is a paging threshold, not a throughput limit. A person talking to a
 * working Claude wants to be told "that one did not go" long before the sentence they are waiting on.
 */
export const VOICE_QUEUE_MAX_DELIVERIES = 3;

/** The reason code a refused `session_send` carries — stable, so the model can act on it, and so the log can be read. */
export const VOICE_QUEUE_FULL_REASON = 'VOICE_QUEUE_FULL';

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
   * The browser's own STOP (the local fallback for a spoken stop the model did NOT relay as a
   * `session_interrupt` call). The page recognises a tiny, exact stop-word set in the endpoint's
   * FINAL caption and sends this frame, so "停" stops the run even when the relay model answered in
   * text instead of calling the function. It carries no payload: the connection is bound to one
   * session, and the stop is always "the run this connection's session is doing".
   */
  | { type: 'interrupt' }
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
   */
  | { type: 'caption'; itemId: string; text: string; final: boolean }
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
   * has accepted and not drained (see {@link VOICE_QUEUE_MAX_DELIVERIES}). It is the reading the page
   * shows as the waiting depth, so "one waiting" and "at the cap" are distinguishable on screen.
   */
  | { type: 'queued'; depth: number }
  /**
   * The bound was reached: the `session_send` this frame answers was NOT accepted and will never
   * reach the session (AC1/AC3 — the model's call is answered, the executor is not touched).
   *
   * The person's words are NOT silently dropped: nothing claims them, so their caption stays on
   * screen as an undelivered line rather than being absorbed into a delivered message. That is the
   * disposition this frame's `reason` names — `queue-full` means "kept as the caption you can still
   * read, not sent".
   */
  | { type: 'refused'; reason: 'queue-full'; depth: number }
  /**
   * `message` is the text actually delivered to the session (after pieces were joined). The browser
   * uses it to recognise the real user message in the transcript and mark it as having come from
   * the voice transcript, instead of showing the person's words twice.
   *
   * `depth` is the waiting depth AFTER this delivery landed — the reading the page keeps between
   * `queued` frames. A send that started a run (`queued: false`) reports 0, because starting a run
   * means everything queued ahead of it had drained.
   */
  | { type: 'sent'; sessionId: string; result: unknown; message?: string; depth: number }
  /**
   * What became of one segment the browser sent (SPEC §C1). Display/diagnosis only: the
   * page uses it to show that a segment was taken rather than silently swallowing it.
   *
   * `committed` means the segment reached the upstream as an utterance — in manual mode
   * when its `input_audio_buffer.commit` went out, in fallback mode when the endpoint
   * transcribed it (which is what proves the VAD closed it). `dropped` means the proxy
   * refused it (a `segment_end` for a segment it never saw open), with `reason` saying so.
   */
  | { type: 'segment_ack'; seq: number; state: 'committed' | 'dropped'; reason?: string }
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
   * A spoken STOP was carried out: the run in flight was aborted and the person should be told,
   * honestly, what became of everything else.
   *
   * `aborted` is the control service's own verdict — `true` means a run was stopped, `false` means
   * there was nothing in flight to stop (the provider's `session_interrupt` reports both without
   * error; see `NO_RUN_TO_ABORT_MESSAGE`). `depth` is how many of the person's messages are STILL
   * waiting after the stop — the reading the bar turns into "已停止当前回合；已排队的 N 条仍会依次
   * 处理". A stop ends ONE run; it never cancels the messages already accepted, so `depth` is the
   * promise that survives the stop, not a count of what was thrown away.
   */
  | { type: 'stopped'; aborted: boolean; depth: number };

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
   */
  createTransport(reportError: (error: { code: string } & Record<string, unknown>) => void): RealtimeTransport;
  /** Builds the live executor whose `session_send` is whitelisted to `boundSessionId`. */
  createExecutor(input: { boundSessionId: string }): RealtimeToolExecutor;
  /** The session instructions sent upstream once connected, and the base of the defaults a settings file overrides. */
  instructions: string;
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
   * How many of the person's messages may be waiting before the relay refuses the next one
   * (see {@link VOICE_QUEUE_MAX_DELIVERIES}). Optional: the constant is what ships, and a criterion
   * shrinks it to reach the bound in a couple of calls.
   */
  maxQueuedVoiceDeliveries?: number;
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
    case 'TOOL_EXECUTION_FAILED':
      return `The tool "${error.tool}" failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
    case 'SEND_FAILED':
      return `A frame could not be sent upstream: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
    case 'DISPATCH_FAILED':
      return `A tool result could not be dispatched: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`;
  }
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

  if (frame.type === 'interrupt') {
    return { type: 'interrupt' };
  }

  if (frame.type === 'close') {
    return { type: 'close' };
  }

  return null;
}

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
  const send = (frame: VoiceRealtimeOutboundFrame): void => {
    if (frame.type === 'caption' ? frame.final : true) {
      seams.log?.(
        `to-browser ${frame.type}${frame.type === 'state' ? ` ${frame.state}` : ''}${
          frame.type === 'error' ? ` ${frame.code}${frame.recoverable === true ? ' (recoverable)' : ''}: ${frame.message}` : ''
        }${frame.type === 'caption' ? ` ${JSON.stringify(frame.text)}` : ''}${
          frame.type === 'queued' || frame.type === 'refused' || frame.type === 'stopped' ? ` depth=${frame.depth}` : ''
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
  /** The pack this connection was sent, or `''` before it arrives (and for a session with nothing said). */
  let contextText = '';
  let contextChars = 0;
  let contextRows = 0;
  /** The pack text already advertised upstream, so a repeated compose is not a second `session.update`. */
  let advertisedContext: string | null = null;

  /**
   * Pushes the composed instructions onto the upstream session.
   *
   * Guarded on `bridge.state`, not called-and-hoped: `sendSessionUpdate` throws on a transport that
   * is not open, and the pack can arrive either side of the upstream handshake — the browser sends
   * it the moment its socket opens, which is usually well before the upstream is up. When the
   * bridge is not open this is a no-op and the `whenConnected` path below applies it instead.
   */
  const advertiseInstructions = (): void => {
    if (bridge.state !== 'open' || advertisedContext === contextText) {
      return;
    }
    advertisedContext = contextText;
    bridge.sendSessionUpdate(composeVoiceRealtimeInstructions(settings, contextText));
    if (contextText !== '') {
      // What was injected, by size and provenance — never the body: this log goes to the server's
      // console, and the body is the user's conversation (SPEC §C2).
      seams.log?.(
        `context injected chars=${contextChars} rows=${contextRows} template=${settings.source}${
          settings.version === null ? '' : ` version=${settings.version}`
        }`,
      );
    }
  };

  const segmentCommitMode = resolveSegmentSelection(seams).mode;

  // ---- the P4 rollout switch: does this connection declare the segmented relay? ------------------
  //
  // Read ONCE per connection, like the settings above: a live connection keeps the answer it was
  // opened with, so flipping the environment variable affects the NEXT connection and leaves the one
  // already in progress alone. When the caller passed no seam, this resolves the shipped default —
  // the same {@link resolveVoiceRealtimeMode} `server/index.ts` calls at the assembly point — and
  // reports a misconfigured variable here, where there is a log sink to report it to.
  const modeResolution = resolveVoiceRealtimeMode(process.env);
  if (seams.segmentedRelay === undefined) {
    const modeNote = describeVoiceRealtimeMode(modeResolution);
    if (modeNote !== null) {
      seams.log?.(modeNote);
    }
  }
  const segmentedRelay = seams.segmentedRelay ?? (modeResolution.mode === 'segmented');
  /** The segment a delivery arriving now belongs to, or `null` outside any segment. */
  let activeSegmentSeq: number | null = null;
  /** Whether that segment is being replayed onto a NEW upstream socket. */
  let activeSegmentIsReplay = false;
  /** Segments that have already produced one delivered message. */
  const deliveredSegmentSeqs = new Set<number>();
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
  /** Segments whose `segment_end` has already been handled, so a repeat cannot close one twice. */
  const endedSegmentSeqs = new Set<number>();
  /** The one relayed instruction held back because its segment's transcript is not yet known. */
  let heldDelivery: { seq: number; isReplay: boolean; args: Record<string, unknown>; resolve: (value: unknown) => void } | null = null;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  const transcriptGraceMs = seams.transcriptGraceMs ?? SEGMENT_TRANSCRIPT_GRACE_MS;

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
   * This is the half of the waiting depth the relay cannot see inside: once `session_send` resolves
   * with `queued: true` the message is the session's, and nothing tells the relay when the turn
   * ahead of it ends. The one reading that IS available is the next send's result — a send that
   * started a run (`queued: false`) could only start it because everything queued ahead had drained,
   * so it resets this to 0. See {@link VOICE_QUEUE_MAX_DELIVERIES} for why it is counted at all.
   */
  let cliQueuedDeliveries = 0;

  const deliverSessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    if (sending) {
      if (waitingForBusySession) {
        // Something more was said while the session is still busy. It joins the waiting message
        // (one delivery, in order) instead of being refused or replacing what was said before it.
        if (typeof args.message === 'string' && args.message.trim() !== '') {
          waitingExtraMessages.push(args.message);
        }
        seams.log?.(`session_send joined the instruction waiting for the session`);
        return {
          accepted: true,
          instruction: 'The message was accepted and joins the one already waiting. Do not call session_send again for it. Reply with the single word OK.',
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
          const payload =
            waitingExtraMessages.length === 0
              ? args
              : { ...args, message: [String(args.message ?? ''), ...waitingExtraMessages].join(' ') };
          const result = await base.session_send(payload);
          seams.log?.(`session_send delivered in ${Date.now() - startedAt} ms`);
          // The two readings the depth is made of, updated BEFORE the frame that reports it.
          // A `queued: true` result is one more of the person's messages the session is holding;
          // a `queued: false` one started a run, which could only happen with the queue ahead of it
          // drained — so it is the one moment the count can be reset rather than incremented.
          // The joined messages have just been delivered inside `payload`, so they leave the buffer
          // here rather than a whole turn later in the `finally` below.
          cliQueuedDeliveries =
            typeof result === 'object' && result !== null && (result as { queued?: unknown }).queued === true
              ? cliQueuedDeliveries + 1
              : 0;
          waitingExtraMessages = [];
          send({
            type: 'sent',
            sessionId: boundSessionId,
            result,
            depth: queuedDepth(),
            ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
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
   * How many of the person's messages are WAITING right now — the reading the page is shown and the
   * one the bound is judged against.
   *
   * Three terms, one per place a message can be waiting, and no term for the delivery being handed
   * over: a delivery in flight is not waiting, it is being delivered.
   *
   *   · the coalescing window, as ONE. However many pieces of a paused sentence landed in
   *     `pendingParts`, they are joined into one message at the flush — counting the pieces would
   *     refuse the tail of a sentence that was always going to be one message.
   *   · the utterances joined into an outstanding busy wait, one each. These are NOT pieces of one
   *     sentence: the window is 2.5 s and a busy turn can run for two minutes, so a person who keeps
   *     talking into a working session has really said that many things, and each is waiting.
   *   · what the session's own queue accepted and has not drained ({@link cliQueuedDeliveries}).
   */
  const queuedDepth = (): number =>
    (pendingParts.length > 0 ? 1 : 0) + waitingExtraMessages.length + cliQueuedDeliveries;

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

  const flushCoalesced = (): void => {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    if (pendingParts.length === 0) return;
    const message = joinParts(pendingParts);
    const extra = pendingExtra;
    seams.log?.(`coalesced ${pendingParts.length} relayed piece(s) into one message`);
    pendingParts = [];
    pendingExtra = {};
    void deliverSessionSend({ ...extra, message }).catch((error: unknown) => {
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
    if (pendingParts.length === 0) return;
    if (coalesceTimer !== null) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(flushCoalesced, coalesceMs);
    coalesceTimer.unref?.();
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
    instruction: 'The message was accepted and has already been handled. Do not call session_send again for it. Reply with the single word OK.',
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

  /** Answers one segment as refused because the endpoint reported no words for it (once per seq). */
  const markSegmentEmpty = (seq: number): void => {
    if (emptiedSegmentSeqs.has(seq)) {
      return;
    }
    emptiedSegmentSeqs.add(seq);
    seams.log?.(`segment ${seq} dropped: the endpoint reported no words for it`);
    send({ type: 'segment_ack', seq, state: 'dropped', reason: 'empty-transcript' });
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
        instruction: 'The message was accepted and has already reached the session. Do not call session_send again for it. Reply with the single word OK.',
      };
    }
    // The BOUND (AC1/AC3), judged here — the model's call point, before any await — so a message
    // the relay refuses never reaches the executor at all: `base.session_send` is not called and the
    // session never sees it. Judged AFTER the replay gate, because a replayed segment is not a new
    // message and adds nothing to the queue; and BEFORE the segment bookkeeping, because a refused
    // delivery must not be recorded as one this segment produced.
    //
    // A call that JOINS a window already open adds nothing to the depth — that window is counted as
    // the one message it is — so it is let through even at the cap. Without this, the tail of a
    // paused sentence would be refused for the queue the sentence's own head is in.
    const maxQueued = seams.maxQueuedVoiceDeliveries ?? VOICE_QUEUE_MAX_DELIVERIES;
    const joiningOpenWindow = coalesceMs > 0 && pendingParts.length > 0;
    if (!joiningOpenWindow && queuedDepth() >= maxQueued) {
      const depth = queuedDepth();
      seams.log?.(`session_send refused: ${VOICE_QUEUE_FULL_REASON} depth=${depth} max=${maxQueued}`);
      send({ type: 'refused', reason: 'queue-full', depth });
      // The model reads this. The reason code is stable and the instruction names the disposition of
      // the words — kept as the caption the person can still see, NOT delivered — and forbids the
      // retry that would otherwise turn one refusal into a stream of them.
      return {
        accepted: false,
        reason: VOICE_QUEUE_FULL_REASON,
        depth,
        instruction:
          `Refused: ${depth} of the user's messages are already waiting for this session (the limit is ${maxQueued}). ` +
          'This message was NOT delivered and will not be. It stays on the user\'s screen as an undelivered line, ' +
          'so the words are not lost. Do not call session_send again for them, and do not retry: the next thing the ' +
          'user says will be carried once the session has caught up.',
      };
    }
    // First delivery of this segment: remember it, so the replay of the same `seq` can be told apart.
    if (segmentSeq !== null) {
      deliveredSegmentSeqs.add(segmentSeq);
    }
    if (coalesceMs <= 0) {
      return deliverSessionSend(args);
    }
    // The window OPENS here, and only here: `pendingParts` was empty, so nothing was already
    // waiting and this delivery starts the wait that `flushCoalesced` ends. Tell the browser at
    // this instant (AC-327) — before the timer is armed, so the frame precedes `sent` for certain.
    // A later message that lands INSIDE an open window joins it without a second frame.
    const openingWindow = pendingParts.length === 0;
    if (typeof args.message === 'string' && args.message.trim() !== '') {
      pendingParts.push(args.message);
    }
    const { message: _ignored, ...rest } = args;
    pendingExtra = { ...pendingExtra, ...rest };
    if (openingWindow && pendingParts.length > 0) {
      // The other end of this delivery's journal: `flushCoalesced` writes `coalesced …` when the
      // window closes, this is where it opened and the frame above announced it. An operator
      // reading the log sees the two lines bracketing the wait the browser showed as "tidying up".
      seams.log?.(`queued: opening a ${coalesceMs} ms coalescing window (the frame precedes the sent)`);
      send({ type: 'queued', depth: queuedDepth() });
    }
    armCoalesce();
    // The model reads this. Wording matters: "will be delivered when the user stops speaking" made it
    // retry the same call every 0.65 s. Say it is DONE from its side, and what to do next.
    return {
      accepted: true,
      instruction: 'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
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

  /**
   * `session_send`, executed immediately (AC-316) — behind the empty-transcript guard.
   *
   * The guard sits HERE, at the delivery point, and not only where the transcription arrives: the
   * endpoint's transcript and the model's relay are independent upstream events and either may land
   * first. Deciding when the call arrives therefore covers both orders, and the hold above makes the
   * decision the same one whichever it was.
   */
  const sessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
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
    }
    return proceedRelay(args, activeSegmentSeq, activeSegmentIsReplay);
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
   */
  const sessionInterrupt = async (args: Record<string, unknown>): Promise<unknown> => {
    const result = await base.session_interrupt(args);
    const aborted =
      typeof result === 'object' && result !== null && (result as { aborted?: unknown }).aborted === true;
    const depth = queuedDepth();
    seams.log?.(`session_interrupt: aborted=${aborted} backlog=${depth}`);
    send({ type: 'stopped', aborted, depth });
    // Release the backlog's first message NOW (its coalescing window would otherwise hold it for up
    // to `coalesceMs`). Only when nothing is mid-delivery: `deliverSessionSend` is single-flight and
    // would refuse a second concurrent call, turning the release into a spurious failure. While a
    // send is in flight the flush is a no-op and the queued message keeps its own timer — the stop
    // has already done its job by aborting the run.
    if (!sending) {
      flushCoalesced();
    }
    return result;
  };

  const executor: RealtimeToolExecutor = {
    ...base,
    session_send: sessionSend,
    session_interrupt: sessionInterrupt,
  };

  const reportTransportError = (error: { code: string } & Record<string, unknown>): void => {
    send(errorFrame(error.code, describeTransportError(error)));
    if (error.code === 'SPEND_LIMIT') {
      // Not recoverable: a connection spending at this rate is not left running. The pending
      // instruction (if any) is still delivered by the teardown flush; nothing more is asked of the model.
      seams.log?.(`teardown: spend guard tripped (${JSON.stringify({ ...error, code: undefined })})`);
      teardown();
    }
  };

  /**
   * One segment phase transition from the bridge: which `seq` a delivery belongs to now,
   * whether it is a replay, and — where the protocol says so — the ack the page is owed.
   *
   * The ack TIMING is the whole difference between the two implementations, and neither is
   * a placeholder. Manual mode knows the segment landed the moment its commit goes out.
   * Fallback mode does not: the segment is closed by real silence and the endpoint's own
   * detector, so nothing is proven until it transcribes the segment — hence the queue, and
   * `onCaption` draining it below.
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
    if (segmentCommitMode === 'manual') {
      send({ type: 'segment_ack', seq: event.seq, state: 'committed' });
      return;
    }
    if (event.phase === 'committed') {
      awaitingTranscriptionSeqs.push(event.seq);
    }
  };

  let bridge: RealtimeBridge;
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
        // `session_send` executor above.
        onCaption: (caption) => {
          send({ type: 'caption', ...caption });
          if (caption.final) {
            // The segment's transcript, finally known. `true` means the endpoint reported ZERO
            // words for it — the one mechanical fact the guard acts on — and the segment is
            // answered as refused here, where the fact arrives, whether or not the model relays it.
            const empty = EMPTY_RELAY_TEXT.test(caption.text);
            if (activeSegmentSeq !== null) {
              segmentTranscriptEmpty.set(activeSegmentSeq, empty);
              if (empty) {
                markSegmentEmpty(activeSegmentSeq);
              }
              if (heldDelivery !== null && heldDelivery.seq === activeSegmentSeq) {
                releaseHeldDelivery();
              }
            }
            // Fallback mode's ack: a FINAL caption is the endpoint having closed the oldest
            // segment still waiting on one, because the segment only closed at all once its
            // trailing silence was read as the end of speech. In order, one caption per ack.
            // An empty one was already answered `dropped` above, so it is not acked twice.
            if (segmentCommitMode === 'server-vad' && awaitingTranscriptionSeqs.length > 0) {
              const seq = awaitingTranscriptionSeqs.shift() as number;
              if (!emptiedSegmentSeqs.has(seq)) {
                send({ type: 'segment_ack', seq, state: 'committed' });
              }
            }
          }
          // The person is still talking: the quiet window starts over.
          armCoalesce();
        },
    };
    bridge =
      seams.upstreamPool === undefined
        ? connect(seams.createTransport(reportTransportError), VOICE_REALTIME_TOOLS, executor, { ...bridgeOptions, hooks: bridgeHooks })
        : // SPEC §C3. `createTransport` is called once per SESSION, so the standby is a
          // second upstream connection rather than a second view of the first; the pool
          // owns both, and closing the pool closes both.
          createUpstreamPool({
            createSession: (sessionHooks) =>
              connect(seams.createTransport(reportTransportError), VOICE_REALTIME_TOOLS, executor, {
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
    send({ type: 'error', code: 'TRANSPORT', message: error instanceof Error ? error.message : String(error) });
    socket.close();
    return;
  }

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
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
    void bridge.close().catch(() => undefined);
    if (socket.readyState === socket.OPEN) {
      socket.close();
    }
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
        seams.log?.(
          `hello: not declaring (offered ${JSON.stringify(frame.protocol)}${
            segmentedRelay ? '' : `, relay off via ${VOICE_REALTIME_MODE_ENV}`
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

    if (frame.type === 'interrupt') {
      // The browser's LOCAL STOP — its own exact stop-word fallback, sent when the model did not
      // relay the stop as a `session_interrupt` call. It reaches the SAME handler the model's call
      // would: one interrupt path, whichever side noticed the stop. Fire-and-forget, because the
      // page needs no answer beyond the `stopped` frame the handler emits.
      seams.log?.('interrupt: the browser reported a local stop');
      void sessionInterrupt({}).catch((error: unknown) => {
        send(
          errorFrame(
            'TOOL_EXECUTION_FAILED',
            `The stop could not be carried out: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
        );
      });
      return;
    }

    if (frame.type === 'segment_start') {
      segmentFrameCounts.set(frame.seq, 0);
      bridge.startSegment(frame.seq);
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
        bridge.sendAudioFrame(frame.audio);
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
      return;
    }

    seams.log?.(`teardown: the browser sent a close frame (audio frames received=${audioFramesFromBrowser})`);
    teardown();
  });

  socket.on('close', () => {
    seams.log?.(`teardown: the browser socket closed (audio frames received=${audioFramesFromBrowser})`);
    teardown();
  });
}
