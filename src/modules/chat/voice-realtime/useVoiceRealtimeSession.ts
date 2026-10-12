import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import { useAuth } from '@/modules/auth';
import {
  fileAudioSource,
  microphoneAudioSource,
  pacedFileAudioSource,
  type PacedAudioSourceOptions,
  type VoiceRealtimeAudioFrame,
  type VoiceRealtimeAudioSource,
} from '@/modules/chat/voice-realtime/audioSource';
// The close trace's count is the row algebra's own question — which utterances a shown delivery
// accounts for — so it is asked through the same shared rule the fold removes words by, not a
// second copy of it that could drift.
import { countUnshownUtterances, normalizeForMatch } from '@/modules/chat/voice-realtime/placeCaptions';
import {
  contextFrame,
  declaresSegmentedRelay,
  SEGMENTED_RELAY_PROTOCOL,
  segmentFrames,
  segmentedRelayOffer,
} from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';
import { buildVoiceContextPack } from '@/modules/chat/utils/voiceContextPack';
import { createLiveSegmenter, type LiveSegment, type LiveSegmenter } from '@/modules/chat/utils/voiceLiveSegmenter';
import { voiceRealtimeSocketUrl } from '@/shared/api';
import type { ChatMessage } from '@/shared/types';
import { StreamingVad } from '@/shared/voiceEndpoint';

/**
 * Where a Live Voice connection is, as the bar renders it (GOAL-033 / AC-316).
 *
 * There is no `understanding`/`sending`/`sent` step: AC-316 removed the
 * per-utterance draft-and-confirm flow, so a model-proposed `session_send`
 * executes the moment it is called and the result reaches the transcript
 * through the ordinary `mcp`-source rendering, not through this phase.
 * `muted` is its own phase (not a separate boolean layered on `listening`)
 * because the bar renders one of a small fixed set of states, never a
 * combination.
 */
export type VoiceRealtimePhase = 'idle' | 'connecting' | 'listening' | 'muted' | 'failed';

/**
 * One outbound server frame (the protocol `/voice-realtime` answers with).
 *
 * `state` carries the optional `protocol` token with which the proxy can declare the
 * segmented relay in the same frame that reports the upstream session; `ready` is the
 * standalone form of that declaration. Both are optional to receive — see
 * {@link declaresSegmentedRelay}.
 */
type ServerFrame =
  | { type: 'state'; state: string; protocol?: string }
  | { type: 'ready'; protocol?: string }
  | { type: 'caption'; itemId: string; text: string; final: boolean }
  | { type: 'queued'; depth?: number; bytes?: number }
  | { type: 'refused'; reason: string; depth?: number; bytes?: number }
  | { type: 'sent'; sessionId: string; result: unknown; message?: string; depth?: number; bytes?: number }
  | { type: 'segment_ack'; seq: number; state: 'committed' | 'dropped'; reason?: string }
  /**
   * One spoken turn the proxy reports the endpoint never answered. Delivered as its own frame
   * rather than as an `error` (see the proxy's `VoiceRealtimeOutboundFrame`): the turn is over,
   * and what the person needs is to see that it is — not another failure notice.
   */
  | { type: 'turn_unanswered'; seconds: number }
  /**
   * The proxy carried out a stop: the run in flight was aborted. `aborted` is the control service's
   * own verdict (false = there was nothing to stop); `depth` is how many of the person's messages are
   * STILL waiting — a stop ends one run and never cancels what was already accepted.
   */
  | { type: 'stopped'; aborted: boolean; depth?: number }
  | { type: 'error'; code: string; message: string; recoverable?: true };

/**
 * What the model heard, as the transcript renders it (AC-317).
 *
 * DISPLAY ONLY. This text exists so the user can see their own words; the model
 * itself receives the raw audio. Nothing in this module — or in anything that
 * consumes `captions` — may route it back as a `session_send` argument.
 *
 * One entry per spoken utterance, keyed by the endpoint's `itemId`: successive
 * captions for the same id REPLACE the text rather than appending, which is what
 * keeps an interim stream from rendering as a wall of duplicated bubbles. An
 * utterance the endpoint reports with no words never becomes an entry at all —
 * see the caption branch in `onmessage` (AC-326).
 */
export type VoiceRealtimeCaption = {
  /** The endpoint's grouping key for one spoken utterance. */
  itemId: string;
  /** The running (interim) or final text for that utterance. */
  text: string;
  /** `true` once the endpoint has closed the utterance. */
  final: boolean;
  /**
   * When this client first saw the utterance, in epoch ms.
   *
   * Recorded once, on arrival, and preserved across the identical-`itemId`
   * replacements an interim stream produces: the transcript stamps each row with
   * it, and re-minting it during render would make the row's timestamp drift on
   * every keystroke of the model's own transcription.
   */
  at: number;
};

/**
 * One instruction the proxy confirmed it delivered to the session — the bridge between what the
 * person was HEARD saying (captions) and the real user message that appears in the transcript.
 */
export type VoiceRealtimeDelivery = {
  /** The text delivered to the session. */
  message: string;
  /** When the delivery was confirmed, in epoch ms. */
  at: number;
  /** What the recogniser heard for the utterances this delivery carries (they may differ from `message`). */
  heard: string[];
  /** The captions this delivery accounts for; the pane hides them once the real message is shown. */
  itemIds: string[];
  /**
   * The session's OWN queue id for this delivery's command (`session_send`'s `queuedMessageUuid`),
   * or `null` when the send opened a run instead of joining one, or when the result carried none.
   *
   * THIS IS THE ONLY NAME A WITHDRAWAL CAN USE. The uuid is the address the CLI's queue answers to
   * (`cancelQueuedInput`), so a per-utterance withdraw button that had no uuid would be a button
   * that does nothing. The proxy had it all along — it is what the interrupt fence keys its
   * `commandUuid → utteranceSeq` map on — and the page dropped it on the floor before this; reading
   * it here is what makes one queued spoken sentence withdrawable without touching the run in
   * flight.
   *
   * Optional in the type because it was added to an existing record: a fixture that predates it, or
   * a frame from a proxy that reports no uuid, leaves it absent, which a reader must take as "not
   * withdrawable" rather than as an empty name.
   */
  queuedMessageUuid?: string | null;
};

/**
 * One `session_send` the proxy refused, as the page reads it: the stable reason code and the queue
 * depth at the moment of the refusal. See {@link VoiceRealtimeSession.refusal}.
 */
export type VoiceRealtimeRefusal = {
  /** The proxy's reason code (`queue-full`); a page that shows copy keys off this, never off the copy. */
  reason: string;
  /** How many of the person's messages were already waiting when this one was refused. */
  depth: number;
  /** How many UTF-8 bytes of the person's text were waiting (plus the refused message) — the reading the budget was judged against. */
  bytes: number;
};

/**
 * A stop the proxy carried out, as the page reads it (the `stopped` frame).
 *
 * `aborted` is the control service's verdict — false means there was no run in flight to stop, which
 * is not an error. `depth` is how many of the person's messages are still waiting AFTER the stop: a
 * stop ends one run, it never cancels the messages already accepted, so the bar shows this count as
 * the honest promise that survives the stop ("已排队的 N 条仍会依次处理").
 */
export type VoiceRealtimeStopped = {
  aborted: boolean;
  depth: number;
};

/** What the bar reads and drives. */
export type VoiceRealtimeSession = {
  /** The current phase; the bar renders its indicator from this. */
  phase: VoiceRealtimePhase;
  /**
   * The last failure message, or `null`.
   *
   * A failure only reaches this slot when it is NOT recoverable: a recoverable error (`recoverable:
   * true`) spoiled one model turn, the session recovers on its own, and the person can act on
   * nothing — so it goes to the browser console instead and this stays `null`. See the error-frame
   * branch below for the ruling.
   */
  error: string | null;
  /**
   * The deadline (seconds) an unanswered spoken turn expired at, or `null` while nothing is pending.
   *
   * A TURN OUTCOME, not an error, and deliberately not the same channel: the endpoint heard the
   * utterance and never answered it, so the turn is over — the bar says so instead of leaving the
   * person looking at "Listening…" with no sign their words went anywhere. Cleared the moment a
   * turn IS delivered (`sent`), which is what makes it a window rather than a sticky notice.
   */
  unansweredSeconds: number | null;
  /**
   * What the model has heard so far, oldest utterance first (AC-317). Display
   * only — see {@link VoiceRealtimeCaption}. The transcript renders these as the
   * user's own messages; they are never sent anywhere.
   */
  captions: readonly VoiceRealtimeCaption[];
  /**
   * Instructions the server confirmed as delivered, oldest first, each naming the captions it carries.
   * The pane uses them to show the delivered message as the primary row, marked as spoken, and to take
   * the provisional caption copies of the same words off the screen.
   */
  deliveries: readonly VoiceRealtimeDelivery[];
  /**
   * `true` between the proxy ACCEPTING a `session_send` and confirming it delivered (AC-327).
   *
   * The server coalesces deliveries in a 2.5 s window, during which it used to send nothing at all:
   * the person's row sat frozen long enough to read as "nothing is happening". The `queued` frame
   * opens this window on the wire, and `sent` closes it — so this is a reading of the server's own
   * timeline, not a client timer guessing at one.
   */
  delivering: boolean;
  /**
   * How many of the person's messages are waiting for the session, as the proxy last reported it —
   * `0` when nothing is waiting.
   *
   * Read from the `depth` the proxy puts on `queued`, `sent` and `refused` frames rather than counted
   * here: only the server can see the messages the session's own queue is holding. The default is 0
   * for a connection that has been told nothing (and for a proxy too old to report a depth), which is
   * the reading of a session with an empty queue.
   */
  queuedDepth: number;
  /**
   * How many UTF-8 bytes of the person's text are waiting for the session, as the proxy last reported
   * it — `0` when nothing is waiting. The byte sibling of {@link queuedDepth}, read off the `bytes`
   * the proxy puts on `queued`, `sent` and `refused` frames.
   *
   * It is the reading the bar shows as "待投递 N 字" / "N bytes queued": three short sentences and one
   * long paragraph are both one message to the count, and only the byte total tells them apart. It is
   * also the reading the admission bound is judged against server-side (1000 bytes), so a page that
   * shows it lets the person see how close they are before a refusal.
   */
  queuedBytes: number;
  /**
   * The utterances the proxy REFUSED and no delivery ever took over, oldest first (AC6).
   *
   * Every one is a thing the person said that is not going to reach Claude. It is the pane's cue to
   * leave a row of its own per utterance saying so, rather than folding them into the one provisional
   * row with everything else: a refusal is a per-utterance outcome, and words that did not go must
   * stay countable and readable one by one. An item id leaves this list only if a delivery later
   * claims it; the connection's own boundary clears the list.
   */
  undelivered: readonly string[];
  /**
   * The last `session_send` the proxy REFUSED because the queue was full, or `null`.
   *
   * The other half of {@link delivering}'s story: `delivering` says "your words are on their way",
   * this says "this one did not go". Nothing claims the refused utterance's captions, so its words
   * stay on screen as an undelivered line — the refusal never silently drops what the person said.
   */
  refusal: VoiceRealtimeRefusal | null;
  /**
   * The most recent stop the proxy carried out, or `null`.
   *
   * A stop's own outcome channel, distinct from {@link refusal} (a stop cancels one run and never
   * refuses anything) and from {@link error} (a stop is not a failure). It holds until the next
   * delivery answers the queue it left behind, or the connection ends — the bar reads it to say,
   * honestly, "已停止当前回合；已排队的 N 条仍会依次处理".
   */
  stopped: VoiceRealtimeStopped | null;
  /**
   * Loudness of the most recent captured frame, 0..1 (0 while muted). A ref rather than state: it
   * changes every ~20ms, and the bar's waveform reads it from its own animation frame instead of
   * re-rendering the whole chat pane at the audio rate.
   */
  levelRef: MutableRefObject<number>;
  /**
   * `true` while the browser has suspended the microphone's capture `AudioContext` and the source
   * is trying to resume it, `false` once capture is live again.
   *
   * Its OWN channel, deliberately not {@link error} and not the `muted` phase. A suspended context
   * makes the microphone stop producing frames with no page-visible sign, so it has to be shown —
   * but the operator ruled out the red `error` line for it, and `muted` is the button's own
   * user-driven state (`aria-pressed`, the mute/unmute label flip), which must not move for a
   * suspension the user never asked for. The bar reads this to grey its waveform and nothing else;
   * the detail goes to the console (see the suspension handler in `beginCapture`).
   */
  micSuspended: boolean;
  /** When this connection began, in epoch ms; `null` while none is open. Drives the bar's elapsed clock. */
  connectedAt: number | null;
  /** `true` after the server or network closed the socket under a live mode — the bar offers Retry. */
  disconnected: boolean;
  /**
   * How many utterances the connection CLOSED ON without them ever reaching the screen (P3), or 0.
   *
   * A COUNT rather than a boolean: the trace has to say how much was lost, and `> 0` is the pane's
   * cue to leave a visible line. Counted the moment the socket closes and reset when the next
   * connection opens, so the reading always belongs to the connection it describes.
   */
  closedUnshown: number;
  /** Opens the Realtime session and starts continuous microphone capture. */
  start: () => void;
  /**
   * Opens the Realtime session and replays an uploaded file through the same
   * pipeline `start()` feeds from the microphone — the test-only injection
   * path (AC-315/AC-316): no production UI calls this.
   *
   * `options` selects the REAL-TIME paced source ({@link pacedFileAudioSource}) instead of the
   * default microtask source, and is how a test drives the fixture on a controlled clock and
   * interrupts it mid-playback. Omitting it keeps the shipped upload path exactly as it was.
   */
  startWithFile: (file: File, options?: PacedAudioSourceOptions) => void;
  /** Pauses sending audio frames without closing the connection. */
  mute: () => void;
  /** Resumes sending audio frames on the still-open connection. */
  unmute: () => void;
  /** Closes the connection and releases capture. The only way to fully stop. */
  end: () => void;
};

/**
 * One console line per lifecycle event of a Live Voice connection. The server log shows what
 * the upstream said; only the page knows why IT started, replaced or ended a connection, and
 * "the session closed right after it opened" is unanswerable without that.
 */
function voiceLog(message: string): void {
  console.info(`[voice-realtime] ${message}`);
}

/** Peak-ish loudness of one frame, 0..1: RMS scaled so ordinary speech fills most of the range. */
function frameLevel(samples: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
}

/** The rate the Realtime transport's `pcm16` input expects. */
const TARGET_SAMPLE_RATE = 16_000;

/**
 * Encodes one captured Float32 frame as base64 little-endian PCM16.
 *
 * The Realtime session's `input_audio_format` is `pcm16` at 16 kHz, while the
 * audio graph runs at whatever the capture device picked (48 kHz in most
 * browsers), so the frame is decimated by nearest-neighbour before it is
 * quantised. Nearest-neighbour is enough here: this is speech headed for an
 * ASR-grade model, and the alternative — a windowed resampler — buys nothing
 * the recogniser can hear.
 */
function encodePcm16Base64(samples: Float32Array, sourceRate: number): string {
  const step = sourceRate > TARGET_SAMPLE_RATE ? sourceRate / TARGET_SAMPLE_RATE : 1;
  const count = step > 1 ? Math.floor(samples.length / step) : samples.length;
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    const sample = step > 1 ? samples[Math.floor(index * step)] : samples[index];
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

/**
 * One `audio` frame on the CONTINUOUS path — the shipped behaviour, and the fallback for
 * every connection whose server never declares the segmented relay. Its bytes are the
 * pre-P1c client's exactly: the segmented path must be additive, so a connection that
 * negotiates nothing (or negotiates against an older proxy) still sends what it always did.
 */
function continuousAudioFrame(frame: VoiceRealtimeAudioFrame): string {
  return JSON.stringify({ type: 'audio', audio: encodePcm16Base64(frame.samples, frame.sourceRate) });
}

/**
 * The `queuedMessageUuid` a `sent` frame's `result` carries, or `null` when it carries none.
 *
 * The client counterpart of the proxy's own `queuedMessageUuidOf`: the SAME reading, so the name a
 * withdraw button sends back is the name the fence joined the command to, not one this file minted.
 * Read as "a non-empty string or nothing" — a result whose send opened a run instead of joining the
 * queue has no uuid, and a fabricated one would address a command that is not ours.
 */
function readQueuedMessageUuid(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const uuid = (result as { queuedMessageUuid?: unknown }).queuedMessageUuid;
  return typeof uuid === 'string' && uuid !== '' ? uuid : null;
}

/**
 * Owns one Live Voice connection: the `/voice-realtime` socket and the
 * continuous audio capture that feeds it.
 *
 * Consumed by `VoiceRealtimeBar` (this module's only UI). The transport
 * concern is deliberately here rather than in the bar so the component
 * renders state and nothing else.
 *
 * `onSent` is called once the server confirms a `session_send`; the chat
 * interface uses it to re-read the transcript, because an MCP-source run
 * writes into history rather than into any live connection this page holds.
 */
export function useVoiceRealtimeSession({
  sessionId,
  onSent,
  contextMessages,
}: {
  sessionId: string | null;
  onSent?: (() => void) | undefined;
  /**
   * The conversation the C2 context pack is built from, read once per NEW connection.
   *
   * The transcript the pane renders, not the caption rows: what the person is in the middle of
   * saying is audio the model already hears, and the words land in this list as a real message the
   * moment the delivery is confirmed.
   */
  contextMessages?: readonly ChatMessage[] | undefined;
}): VoiceRealtimeSession {
  const { token } = useAuth();
  // The phase the bar renders; driven by the wire above all.
  const [phase, setPhase] = useState<VoiceRealtimePhase>('idle');
  // The last failure, kept so a closed session can explain itself after the
  // socket that carried the reason is gone.
  const [error, setError] = useState<string | null>(null);
  // The deadline an unanswered turn expired at, or `null`. Set by the `turn_unanswered` frame and
  // cleared by the next delivery, so the bar can hold the outcome on screen for exactly as long as
  // the turn is unresolved — see `VoiceRealtimeSession.unansweredSeconds` for why this is not `error`.
  const [unansweredSeconds, setUnansweredSeconds] = useState<number | null>(null);
  // What the model has heard so far, as the transcript renders it. Kept as
  // state (not a ref) because it drives a list of rendered messages; a caption
  // for an id already present REPLACES that entry in place, so an interim
  // stream updates one bubble rather than growing the list unboundedly.
  const [captions, setCaptions] = useState<VoiceRealtimeCaption[]>([]);
  // The start of the current connection, so the bar can show how long Live Voice has run. State
  // (set once per connection) rather than a ref because the bar renders from it.
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // Set when the socket closes on its own. Without it a closed connection and a not-yet-started one
  // are both `idle`, and the bar showed "Connecting…" over a dead microphone.
  const [disconnected, setDisconnected] = useState(false);
  // `true` while the microphone's capture `AudioContext` is browser-suspended and being resumed (see
  // `VoiceRealtimeSession.micSuspended`). State, not a ref, because the bar re-renders from it to
  // grey the waveform; set only by the mic source's suspension report, and cleared on every
  // connection boundary so a suspension never outlives the capture that reported it.
  const [micSuspended, setMicSuspended] = useState(false);
  const levelRef = useRef(0);
  const [deliveries, setDeliveries] = useState<VoiceRealtimeDelivery[]>([]);
  // How many utterances the last connection CLOSED on without them ever reaching the screen (P3).
  // Counted in `onclose`, where the connection's own state is still readable, and held so the pane
  // can leave a visible trace instead of the words going silent. Reset by the next connection, so
  // the reading belongs to the connection it describes and not to the pane's lifetime.
  const [closedUnshown, setClosedUnshown] = useState(0);
  // `true` while the proxy has accepted an instruction but not yet delivered it (AC-327). Set by
  // the `queued` frame, cleared by `sent` and on every connection boundary, so a row can never be
  // left reading "tidying up" after the connection that promised it has gone.
  const [delivering, setDelivering] = useState(false);
  // How many of the person's messages the proxy reports as waiting. Server-owned (only it can see the
  // session's own queue), so this is a reading of the last frame that carried a `depth`, not a count.
  const [queuedDepth, setQueuedDepth] = useState(0);
  // The same waiting set, measured in UTF-8 bytes — the reading the bar shows as "待投递 N 字" and the
  // unit the admission budget is written in (1000). Server-owned, like the depth: read off the frame.
  const [queuedBytes, setQueuedBytes] = useState(0);
  // The utterances the proxy refused and no delivery ever claimed (AC6). A LIST, not a boolean: each
  // refused utterance gets a row of its own, so the pane must know how many and which.
  const [undelivered, setUndelivered] = useState<readonly string[]>([]);
  // The last refusal, so the bar can say "that one did not go" without also hiding the words.
  const [refusal, setRefusal] = useState<VoiceRealtimeRefusal | null>(null);
  // The last stop the proxy carried out, so the bar can say what became of the queue the stop left
  // behind. Its own channel — a stop is not a refusal and not an error.
  const [stopped, setStopped] = useState<VoiceRealtimeStopped | null>(null);
  // The captions as last committed, readable from a socket handler. A delivery needs to know which
  // finished utterances it carries, and state updaters cannot be read from outside.
  const captionsRef = useRef<VoiceRealtimeCaption[]>([]);
  const attributedRef = useRef<Set<string>>(new Set());
  // The utterances that were already on screen when the LAST delivery landed — the earlier speech
  // window. A rewrite whose message matches no pending words is attributed to the thought spoken
  // SINCE this window (see the `sent` frame); anything already present then was the previous
  // delivery's business and must not be claimed by the next one.
  const priorDeliveryWindowRef = useRef<Set<string>>(new Set());
  // The deliveries as last committed, readable from the socket's `onclose` without a stale
  // `deliveries` closure: the close trace asks which of them ever became visible, and that question
  // is answered against the connection's own record, not the render that happens to be current.
  const deliveriesRef = useRef<VoiceRealtimeDelivery[]>([]);

  // `connect` reads the CURRENT session and token through this ref instead of closing over
  // them. Closing over them made `start` a new function on every token refresh or session-id
  // change, and the pane's "start capturing when voice mode is entered" effect depends on
  // `start` — so it re-fired mid-session and opened a SECOND connection beside the first.
  const latestRef = useRef({ sessionId, token });
  useEffect(() => {
    latestRef.current = { sessionId, token };
  });

  const socketRef = useRef<WebSocket | null>(null);
  // Holds whichever `VoiceRealtimeAudioSource` is active — the microphone or
  // an uploaded file — so `end()` and the socket's own `onclose` can release
  // it without knowing which one it was.
  const sourceRef = useRef<VoiceRealtimeAudioSource | null>(null);
  // Read inside the frame callback to decide whether to send: a ref rather
  // than relying on `phase` because the callback closes over it once, at
  // `beginCapture` time, and must see every later `mute()`/`unmute()`.
  const mutedRef = useRef(false);
  // Frames captured before the proxy has reported the upstream session `open`,
  // held in order and replayed once it does. A short uploaded fixture decodes
  // and chunks faster than a WebSocket handshakes AND faster than the upstream
  // Realtime session opens, so without this queue the whole capture is produced
  // into that gap and lost (AC-315's flake): the proxy forwards each `audio`
  // frame straight to a transport whose `send()` throws `SOCKET_NOT_OPEN` until
  // its upstream is up.
  //
  // Held as the RAW frames (not pre-encoded strings) because which encoding the
  // replay uses is decided by the `open` frame that ends the wait: the continuous
  // fallback encodes here, while a segmented connection feeds the same frames
  // through the segmenter, so a whole fixture replayed out of this queue still
  // becomes one segment per sentence instead of one `audio` frame per chunk.
  const pendingFramesRef = useRef<VoiceRealtimeAudioFrame[]>([]);
  // Whether the proxy has reported the upstream Realtime session `open`. Audio
  // is only forwarded from here on: `WebSocket.OPEN` alone is not enough, for
  // the reason above.
  const socketOpenRef = useRef(false);
  // Whether THIS connection negotiated the segmented relay. Set by the handshake
  // and read on every captured frame, so it is a ref rather than state: the frame
  // callback closes over it once, at `beginCapture` time, and must see the
  // declaration whenever it arrives.
  const segmentedRef = useRef(false);
  // The relay segmenter and the VAD whose events drive its boundaries, built the
  // first time a frame is fed on a segmented connection. Both are rebuilt when the
  // capture rate changes (nothing resamples ahead of the segmenter, so its frame
  // grid is the source rate's) and cleared when Mute ends the open segment.
  const segmenterRef = useRef<LiveSegmenter | null>(null);
  const vadRef = useRef<StreamingVad | null>(null);
  const segmentRateRef = useRef(0);
  // The offset of the next captured sample from this connection's first, handed to
  // `LiveSegmenter.push` as its `atSample` — which throws on a gap or a reorder
  // rather than cutting a segment in the wrong place.
  const atSampleRef = useRef(0);
  // The `seq` of the next segment on this connection, monotonic from 0 and reset
  // per connection: the proxy keys its per-segment accounting (and its duplicate
  // suppression) on it.
  const seqRef = useRef(0);
  // `onSent` is read through a ref so a caller that passes an inline closure
  // does not resubscribe the socket handler on every render.
  const onSentRef = useRef(onSent);
  useEffect(() => {
    onSentRef.current = onSent;
  });

  // The transcript the context pack is built from, read through a ref for the same reason `onSent`
  // is: `connect` must stay stable. It is a dependency chain of exactly one — `start` depends on
  // `connect`, and the pane's "start capturing when voice mode is entered" effect depends on
  // `start` — so closing over a fresh array here would re-open a LIVE connection every time a
  // message streamed in.
  const contextMessagesRef = useRef<readonly ChatMessage[]>(contextMessages ?? []);
  useEffect(() => {
    contextMessagesRef.current = contextMessages ?? [];
  });

  /** Releases whichever audio source is active (the microphone, or a file decode). Safe to call twice. */
  const releaseCapture = useCallback(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    source?.stop();
  }, []);

  /**
   * Drops the segmentation pipeline so the next frame opens a fresh segment stream.
   *
   * Called when Mute ends a segment: `LiveSegmenter` re-derives its segments from the
   * whole buffer on every push, so a segment it already handed over would swallow the
   * speech that follows the mute instead of being re-emitted — the stream has to restart
   * on the far side of a mute, and `atSample` with it.
   */
  const resetSegmentation = useCallback(() => {
    segmenterRef.current = null;
    vadRef.current = null;
    segmentRateRef.current = 0;
    atSampleRef.current = 0;
  }, []);

  /** Sends one committed segment as `segment_start` → `audio{seq}` → `segment_end`. */
  const sendSegment = useCallback((segment: LiveSegment) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const seq = seqRef.current;
    seqRef.current += 1;
    for (const frame of segmentFrames(segment, seq, Date.now())) {
      socket.send(frame);
    }
    const seconds = (segment.durationSec ?? segment.endSec - segment.startSec).toFixed(2);
    voiceLog(
      `segment seq=${seq} duration=${seconds}s reason=${segment.reason ?? 'end'} frames=1 bytes=${segment.wav.length}`,
    );
  }, []);

  /**
   * Feeds one captured frame through the relay segmenter and sends every segment a pause
   * closed during it. Frames that fall in silence reach the segmenter (it needs them to
   * see the pause) but are never sent: silence is exactly what this path exists to keep
   * off the upstream, so the upstream's `audioSecondsUpstream` is the sum of the sentences,
   * not of the session.
   */
  const feedSegmented = useCallback(
    (frame: VoiceRealtimeAudioFrame) => {
      if (segmentRateRef.current !== frame.sourceRate) {
        segmenterRef.current = createLiveSegmenter({ sampleRate: frame.sourceRate, profile: 'relay' });
        vadRef.current = new StreamingVad({ sampleRate: frame.sourceRate });
        segmentRateRef.current = frame.sourceRate;
        atSampleRef.current = 0;
      }
      const vad = vadRef.current;
      const segmenter = segmenterRef.current;
      if (!vad || !segmenter) {
        return;
      }
      const events = vad.push(frame.samples);
      const atSample = atSampleRef.current;
      atSampleRef.current += frame.samples.length;
      for (const segment of segmenter.push(frame.samples, atSample, events)) {
        sendSegment(segment);
      }
    },
    [sendSegment],
  );

  /**
   * Closes the segment still being accumulated and sends it, then restarts segmentation.
   *
   * The relay segmenter only releases a segment when a pause long enough to commit it
   * arrives, and Mute and End provide no such pause: a sentence spoken right up to either
   * would otherwise be sitting in the segmenter's buffer when the microphone stops or the
   * socket closes. Flushing is what makes "stop" mean "and deliver what was just said".
   */
  const flushSegments = useCallback(() => {
    const segmenter = segmenterRef.current;
    if (segmenter) {
      for (const segment of segmenter.flush()) {
        sendSegment(segment);
      }
    }
    resetSegmentation();
  }, [resetSegmentation, sendSegment]);

  const end = useCallback(() => {
    if (socketRef.current || sourceRef.current) {
      voiceLog('end(): releasing capture and closing the connection');
    }
    releaseCapture();
    // Before the socket goes: a sentence still open in the segmenter is delivered as its
    // own `segment_end` and only then is the session closed, so Ending does not swallow
    // the last thing the user said. Capture has already stopped, so no frame can arrive
    // between the flush and the close.
    flushSegments();
    mutedRef.current = false;
    levelRef.current = 0;
    setConnectedAt(null);
    setDisconnected(false);
    // The connection that could report a suspension is going away with its capture, so the reading
    // is cleared rather than left greyed over a microphone that is no longer running.
    setMicSuspended(false);
    // Dropping the queue here is deliberate: the session is ending, so a frame
    // still awaiting `open` has no proxy to reach and is not replayed.
    pendingFramesRef.current = [];
    socketOpenRef.current = false;
    segmentedRef.current = false;
    seqRef.current = 0;
    setDelivering(false);
    setUnansweredSeconds(null);
    // The connection that reported a depth, a byte total or a refusal is going away, so all three
    // readings go with it: a bar left showing "3 waiting" over a dead socket would be reporting a
    // queue nobody holds.
    setQueuedDepth(0);
    setQueuedBytes(0);
    setRefusal(null);
    setStopped(null);
    setUndelivered([]);
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'close' }));
      }
      socket.close();
    }
    setPhase('idle');
  }, [flushSegments, releaseCapture]);

  // `end` is stable, so the cleanup runs once per mount. A page that
  // navigates away with the microphone open is the one state this must not
  // leave behind.
  const endRef = useRef(end);
  useEffect(() => {
    endRef.current = end;
  }, [end]);
  useEffect(() => () => endRef.current(), []);

  /**
   * Begins pulling frames from `source` and feeding them to the open socket as
   * PCM16 `audio` frames — the one pipeline the microphone and an uploaded
   * file both run through. Frames are dropped locally (never sent) while
   * `mutedRef.current` is true, which is how Mute pauses capture without
   * closing the connection. A failure here (denied mic permission, a file
   * that will not decode) fails the session exactly as a socket failure
   * would.
   */
  const beginCapture = useCallback(
    (source: VoiceRealtimeAudioSource) => {
      sourceRef.current = source;
      void source
        .start(
          (frame) => {
            // Mute drops the frame outright — it is never queued, or a burst captured
            // just before Mute would still reach the upstream after it (the criterion
            // reads Mute as "the upstream frame count stops growing").
            if (mutedRef.current) {
              levelRef.current = 0;
              return;
            }
            levelRef.current = frameLevel(frame.samples);
            const active = socketRef.current;
            if (active && active.readyState === WebSocket.OPEN && socketOpenRef.current) {
              // Which framing this connection sends was decided by the handshake: segmented
              // relay (only what the segmenter commits) or the continuous stream it has
              // always been. There is no third state, and the declaration never changes
              // mid-connection, so the choice is read here rather than re-negotiated.
              if (segmentedRef.current) {
                feedSegmented(frame);
              } else {
                active.send(continuousAudioFrame(frame));
              }
              return;
            }
            // The socket is still connecting, or the proxy has not yet reported the
            // upstream session `open`: hold the frame and replay it in order once
            // `open` arrives, rather than dropping it into the handshake gap.
            pendingFramesRef.current.push(frame);
          },
          (suspension) => {
            // The browser suspended the microphone's capture context (or it came back). This is
            // console-only on purpose: the operator ruled out the red `error` notice for it and it
            // is not Mute, so the only page-visible effect is the greyed waveform `micSuspended`
            // drives. The detail text never becomes a rendered string.
            voiceLog(suspension.detail);
            setMicSuspended(suspension.suspended);
          },
        )
        .catch((failure) => {
          setPhase('failed');
          setError(failure instanceof Error ? failure.message : String(failure));
        });
    },
    [feedSegmented],
  );

  /**
   * Opens the `/voice-realtime` socket and begins capture from `source`.
   * Shared by `start()` (the microphone) and `startWithFile()` (the
   * test-only uploaded-fixture path) — everything from here down is
   * audio-source-agnostic.
   */
  const connect = useCallback(
    (source: VoiceRealtimeAudioSource) => {
      const { sessionId, token } = latestRef.current;
      // Starting while a connection exists REPLACES it. Leaving the old socket open
      // left two upstream sessions answering one microphone, and the old capture running.
      const previous = socketRef.current;
      if (previous || sourceRef.current) {
        voiceLog('start while connected: replacing the existing connection');
        socketRef.current = null;
        releaseCapture();
        previous?.close();
      }
      if (!sessionId || !token) {
        setPhase('failed');
        setError('Sign in and open a session before starting voice control.');
        return;
      }

      setError(null);
      mutedRef.current = false;
      // A new connection hears a new conversation: the previous run's captions
      // are not this one's, and carrying them over would attribute old speech to
      // a session that never heard it.
      captionsRef.current = [];
      attributedRef.current = new Set();
      priorDeliveryWindowRef.current = new Set();
      deliveriesRef.current = [];
      setCaptions([]);
      setDeliveries([]);
      setDelivering(false);
      // The close trace describes the connection that ended; a new one has not closed on anything yet.
      setClosedUnshown(0);
      // A new connection is a new conversation: an unanswered turn from the previous one is not
      // this one's, and holding it would put the previous run's outcome over a live session.
      setUnansweredSeconds(null);
      // A new connection has told this page nothing yet: no messages waiting, no bytes, no refusal.
      setQueuedDepth(0);
      setQueuedBytes(0);
      setRefusal(null);
      setUndelivered([]);
      voiceLog(`connecting to session ${sessionId}`);
      setDisconnected(false);
      // A fresh capture has reported nothing yet: the previous connection's suspension reading is
      // not this one's, so the waveform starts un-greyed.
      setMicSuspended(false);
      setConnectedAt(Date.now());
      setPhase('connecting');
      // Each connection starts with an empty queue and an unopened upstream:
      // frames captured from here wait for this connection's own `state: open`.
      pendingFramesRef.current = [];
      socketOpenRef.current = false;
      // A new connection negotiates from scratch: the previous run's protocol, its `seq`
      // numbering and whatever was still buffered in its segmenter are not this one's.
      segmentedRef.current = false;
      seqRef.current = 0;
      resetSegmentation();

      let socket: WebSocket;
      try {
        socket = new WebSocket(voiceRealtimeSocketUrl(token, sessionId));
      } catch (failure) {
        setPhase('failed');
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
      socketRef.current = socket;

      // The offer goes out the moment the socket is usable: the client states what it can
      // send, and says nothing else about it until the server answers. A proxy that
      // ignores the frame (one built before the segmented relay) simply never declares,
      // and this connection stays on the continuous path it has always used.
      socket.onopen = () => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(JSON.stringify(segmentedRelayOffer()));
        // The C2 context pack follows the offer on the same turn of the event loop, so it is
        // already on the wire before any `segment_start`: the proxy composes its instructions from
        // the pack it has at that moment, and the upstream session opens well after both frames
        // (the client holds captured audio until the proxy reports `state: open`). A conversation
        // with nothing said yet sends no frame at all.
        const pack = buildVoiceContextPack(contextMessagesRef.current);
        const frame = contextFrame(pack);
        if (frame) {
          socket.send(JSON.stringify(frame));
          voiceLog(`context chars=${frame.chars} rows=${frame.rows}`);
        }
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data) as ServerFrame;
        } catch {
          return;
        }
        if (frame.type !== 'caption') {
          voiceLog(`frame ${frame.type}${'state' in frame ? ` ${frame.state}` : ''}${'code' in frame ? ` ${frame.code}` : ''}`);
        }
        // The declaration may arrive on its own (`ready`) or on the `state` frame that
        // reports the session; either way it is remembered here, before the frames that
        // depend on it are framed.
        if (declaresSegmentedRelay(frame)) {
          segmentedRef.current = true;
          voiceLog(`server declares ${SEGMENTED_RELAY_PROTOCOL}: only committed speech is sent upstream`);
        }
        if (frame.type === 'state') {
          if (frame.state === 'open') {
            socketOpenRef.current = true;
            // The upstream session is up, so replay everything captured ahead
            // of it, in order, before any later frame is sent directly.
            const queued = pendingFramesRef.current;
            pendingFramesRef.current = [];
            for (const captured of queued) {
              if (socket.readyState !== WebSocket.OPEN) {
                break;
              }
              if (segmentedRef.current) {
                feedSegmented(captured);
              } else {
                socket.send(continuousAudioFrame(captured));
              }
            }
            // Mute pressed while still connecting must survive the handshake: the frames are
            // already being dropped (`mutedRef`), so reporting `listening` here would tell the
            // user the microphone is live when it is not.
            // A fresh connection starts with no stop recorded — the previous connection's reading
            // does not carry over.
            setStopped(null);
            setPhase(mutedRef.current ? 'muted' : 'listening');
          } else if (frame.state === 'closed') {
            setPhase('idle');
          }
          return;
        }
        if (frame.type === 'ready') {
          // A declaration with any other token says the server does NOT speak this
          // version, which is the continuous fallback's own case: nothing to do.
          return;
        }
        if (frame.type === 'caption') {
          // Same `itemId` ⇒ same utterance ⇒ REPLACE, so an interim stream
          // updates one bubble instead of appending a new one per delta. A
          // `final` caption keeps its place in the order and simply stops
          // changing.
          const current = captionsRef.current;
          const index = current.findIndex((entry) => entry.itemId === frame.itemId);
          const said = frame.text.trim() !== '';
          // A caption with no words is not something the person said: the endpoint emits one
          // beside every utterance's interim text (its `text` is empty while the running words
          // sit in `stash`), and letting it in minted an utterance the pane rendered as a blank
          // user row (AC-326). Dropped at the SOURCE, not at the renderer, so nothing downstream
          // — the transcript row, a delivery's `heard` list — can ever see it. The one exception
          // is a wordless frame that CLOSES an utterance already on screen: its closing is what
          // lets a delivery carry those words, and blanking a row the person is reading is the
          // thing this guard exists to prevent, not a way to do it.
          if (!said && !(frame.final && index !== -1)) {
            return;
          }
          const text = said ? frame.text : current[index]!.text;
          let next: VoiceRealtimeCaption[];
          if (index === -1) {
            next = [...current, { itemId: frame.itemId, text, final: frame.final, at: Date.now() }];
          } else {
            next = current.slice();
            // `at` is carried over from the first sighting, not re-minted: the
            // row keeps the time the user started speaking to it.
            next[index] = { ...next[index]!, text, final: frame.final };
          }
          captionsRef.current = next;
          setCaptions(next);
          return;
        }
        if (frame.type === 'queued') {
          // The proxy ACCEPTED an instruction and is holding it in its coalescing window (AC-327).
          // This is the server's own "in flight" moment; the page reads it rather than guessing at
          // one with a timer, so the row can only say "tidying up" when the server is really waiting.
          setDelivering(true);
          // How many of the person's messages the session is holding right now, as the proxy counts
          // them, and how much text that is in bytes. Carried on the frame rather than counted here:
          // the messages the session's own queue took are invisible to the page.
          setQueuedDepth(typeof frame.depth === 'number' ? frame.depth : 0);
          setQueuedBytes(typeof frame.bytes === 'number' ? frame.bytes : 0);
          return;
        }
        if (frame.type === 'refused') {
          // The proxy reached its bound and did NOT accept this instruction. The words stay on
          // screen as the caption nobody claimed, so the refusal is visible without swallowing what
          // the person said; the delivery state was never opened, so there is nothing to close.
          const depth = typeof frame.depth === 'number' ? frame.depth : 0;
          const bytes = typeof frame.bytes === 'number' ? frame.bytes : 0;
          setQueuedDepth(depth);
          setQueuedBytes(bytes);
          setRefusal({ reason: frame.reason, depth, bytes });
          // AC6: the utterances the model just tried to relay and had refused are exactly the
          // finished ones no delivery has claimed yet. Mark them so the pane can leave a row of its
          // own per refused utterance — a refusal is per-utterance, and each must stay countable.
          const refusedItems = captionsRef.current
            .filter((caption) => caption.final && !attributedRef.current.has(caption.itemId))
            .map((caption) => caption.itemId);
          if (refusedItems.length > 0) {
            setUndelivered((previous) => {
              const next = new Set(previous);
              for (const itemId of refusedItems) next.add(itemId);
              return [...next];
            });
          }
          voiceLog(`session_send refused reason=${frame.reason} depth=${depth} bytes=${bytes}`);
          return;
        }
        if (frame.type === 'sent') {
          setError(null);
          // The turn that was waiting has an answer: whatever the person said last reached the
          // session, so the "no answer" outcome (if any) is spent and the bar goes back to
          // reporting the phase alone.
          setUnansweredSeconds(null);
          setDelivering(false);
          // The proxy's own reading after this delivery landed: 0 when it opened a run, the queue's
          // length when the session took it. A frame from a proxy that reports no depth reads as 0.
          setQueuedDepth(typeof frame.depth === 'number' ? frame.depth : 0);
          setQueuedBytes(typeof frame.bytes === 'number' ? frame.bytes : 0);
          // The queue moved, so the last refusal is no longer what the person needs to see.
          setRefusal(null);
          // Same for the last stop: the delivery that just landed is the queue the stop left behind
          // moving again, which is exactly what the stop notice promised.
          setStopped(null);
          // What this delivery CARRIED — judged by its OWN relayed message, never by "everything still
          // unclaimed". A delivery that claimed every finished utterance no earlier delivery had
          // accounted for swallowed words it never relayed: an utterance the model recognised but
          // chose not to forward kept no delivery, so the NEXT delivery — even one relaying quite
          // different words — claimed it. Those words then looked delivered, so leaving the mode both
          // kept them out of the composer and dropped their rows off screen, and only their raw audio
          // survived. The delivery's message is the evidence of what it carried.
          //
          // THE KEY IS THE MESSAGE'S TEXT, through the same normalization the fold and the row-drop
          // use ({@link normalizeForMatch}, the client counterpart of the proxy's `normalizeRelayText`),
          // so attribution cannot drift from what the transcript reads back as delivered.
          //
          // WHEN THE TEXT CANNOT DECIDE. The relay does not always repeat the recognised words — it
          // may translate or rewrite them (the "shown, but a different string" shape the caption
          // fixtures use), so the message matches no pending utterance. Since the client cannot tell
          // "rewritten" from "not carried", it falls back to the ONE thought the relay is answering:
          // everything spoken since the last delivery. The endpoint closes an utterance at every
          // pause, so that one thought arrives as SEVERAL pending captions — all of which the merged
          // message carried — and claiming only the last piece (`pending.slice(-1)`) left the rest on
          // their own row beside the delivered message (AC-326 read two rows where it must never read
          // more than one). An empty relay carries nothing.
          //
          // THE BOUND IS THE LAST DELIVERY, NOT "EVERYTHING STILL UNCLAIMED". 14b8e9ed's guarantee
          // still holds: an utterance the model recognised but never forwarded keeps no delivery, so a
          // LATER rewrite must not swallow it. The captions already on screen when the previous `sent`
          // landed belonged to that earlier window and are excluded (see `priorDeliveryWindowRef`); only
          // the speech after it — the thought just spoken — is claimed. What this bound cannot separate
          // is an utterance the model declined to forward INSIDE the same window (the person kept talking
          // with no delivery in between): the client has no signal that distinguishes those pieces from
          // the ones the rewrite carried, so claiming the window errs toward one too MANY there. That is
          // the residual cost of a rewrite; the verbatim case keeps its exact text attribution, and
          // anything never claimed is still offered to the composer on leave.
          const relayed = typeof frame.message === 'string' ? normalizeForMatch(frame.message) : '';
          const pending = captionsRef.current.filter(
            (caption) => caption.final && !attributedRef.current.has(caption.itemId),
          );
          const matched =
            relayed === ''
              ? []
              : pending.filter((caption) => {
                  const words = normalizeForMatch(caption.text);
                  return words !== '' && relayed.includes(words);
                });
          // The thought the relay is answering: the pending captions spoken since the last delivery. A
          // caption already present when the previous `sent` landed belonged to that earlier window.
          const thought = pending.filter((caption) => !priorDeliveryWindowRef.current.has(caption.itemId));
          const carried = relayed === '' ? [] : matched.length > 0 ? matched : thought;
          for (const caption of carried) {
            attributedRef.current.add(caption.itemId);
          }
          // An utterance a refusal had marked undelivered that this delivery DID carry is delivered
          // after all, so its undelivered row goes (AC6's negative control: with everything delivered,
          // none are left marked).
          if (carried.length > 0) {
            const deliveredItems = new Set(carried.map((caption) => caption.itemId));
            setUndelivered((previous) => previous.filter((itemId) => !deliveredItems.has(itemId)));
          }
          if (typeof frame.message === 'string' && frame.message !== '') {
            const delivery: VoiceRealtimeDelivery = {
              message: frame.message,
              at: Date.now(),
              heard: carried.map((caption) => caption.text),
              itemIds: carried.map((caption) => caption.itemId),
              // The command's own queue id, off the delivery result — the one name a withdrawal can
              // address (D-11). `null` when the send opened a run rather than joining the queue: that
              // delivery is not withdrawable, and saying so by absence is what keeps a button from
              // being drawn for a command the CLI is not holding.
              queuedMessageUuid: readQueuedMessageUuid(frame.result),
            };
            // Synchronous, so a close in the same tick as this `sent` still sees the delivery it just
            // recorded: `onclose` reads this ref, and a state update alone would not have landed yet.
            deliveriesRef.current = [...deliveriesRef.current, delivery];
            setDeliveries(deliveriesRef.current);
          }
          // This delivery closes the current speech window: every caption on screen NOW is the NEXT
          // delivery's "earlier window", so a later rewrite cannot reach back past this `sent`.
          priorDeliveryWindowRef.current = new Set(captionsRef.current.map((caption) => caption.itemId));
          onSentRef.current?.();
          return;
        }
        if (frame.type === 'segment_ack') {
          // The proxy's verdict on one segment. Logged, not acted on: a dropped segment is
          // audio that did not reach the model, which is worth a line in the console — but
          // it is not a reason to tear down a session that is otherwise live.
          voiceLog(`segment_ack seq=${frame.seq} ${frame.state}${frame.reason ? ` reason=${frame.reason}` : ''}`);
          return;
        }
        if (frame.type === 'turn_unanswered') {
          // The turn the person just spoke is over and has no answer. Recorded as its own state
          // (not `error`): the session is healthy and still listening, and the outcome stays on
          // screen until a delivery closes it, so it cannot be missed by looking a second late.
          setUnansweredSeconds(frame.seconds);
          return;
        }
        if (frame.type === 'stopped') {
          // The proxy aborted the run in flight. Recorded with the queue depth the stop left behind,
          // so the bar can say what happens to the messages still waiting — nothing is thrown away by
          // a stop. Cleared by the next delivery, like the other turn outcomes.
          const depth = typeof frame.depth === 'number' ? frame.depth : 0;
          setStopped({ aborted: frame.aborted, depth });
          setQueuedDepth(depth);
          voiceLog(`stopped aborted=${frame.aborted} backlog=${depth}`);
          return;
        }
        // A recoverable error spoiled one model turn, not the connection: the session recovers on
        // its own and there is nothing for the person to act on, so it goes to the console (with
        // both the code and the message) rather than the bar. The on-screen error slot is reserved
        // for a failure a reader has to SEE; the microphone and the socket stay alive either way.
        if (frame.recoverable === true) {
          console.warn('[voice-realtime] recoverable error', frame.code, frame.message);
          return;
        }
        setError(frame.message);
        setPhase('failed');
      };
      socket.onerror = () => {
        voiceLog('socket error');
        setError('The voice connection failed.');
        setPhase('failed');
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) {
          return;
        }
        voiceLog('socket closed by the server or network');
        // P3 — the close trace, counted BEFORE anything below is cleared, because this is the last
        // moment the connection's own captions, deliveries and segment count are all readable.
        // Closing a socket under a live session could drop words that never reached the screen —
        // either as a final caption no shown delivery took over, or as a segment handed to the relay
        // that produced no caption at all — and the person was given no sign. `countUnshownUtterances`
        // asks the fold's own question (which utterances a VISIBLE delivery accounts for), so the
        // trace and the row agree on what "shown" means.
        const unshown = countUnshownUtterances(
          captionsRef.current,
          deliveriesRef.current,
          contextMessagesRef.current,
          seqRef.current,
        );
        if (unshown > 0) {
          voiceLog(
            `socket closed with ${unshown} unshown utterance(s): ${unshown} of the words just spoken never reached the screen`,
          );
        }
        setClosedUnshown(unshown);
        socketRef.current = null;
        pendingFramesRef.current = [];
        socketOpenRef.current = false;
        segmentedRef.current = false;
        // A window the dead connection opened will never be closed by its `sent`.
        setDelivering(false);
        // Same for an unanswered turn: the connection that would have answered it is gone, and the
        // bar reads `disconnected` from here on rather than an outcome nothing can resolve.
        setUnansweredSeconds(null);
        // The refusal, the depth and the byte total belonged to that connection's queue; what the
        // next one holds is not known yet, so all read as empty rather than as the dead connection's
        // last reading.
        setQueuedDepth(0);
        setQueuedBytes(0);
        setRefusal(null);
        // A stop belonged to the connection that carried it out; the next one starts with no stop.
        setStopped(null);
        // The segmenter holds the whole session's audio; a connection nobody is sending on
        // has no reason to keep it.
        resetSegmentation();
        releaseCapture();
        levelRef.current = 0;
        setDisconnected(true);
        // The capture that reported a suspension is being released with the socket, so the greyed
        // waveform does not outlive it.
        setMicSuspended(false);
        setConnectedAt(null);
        setPhase('idle');
      };

      beginCapture(source);
    },
    [beginCapture, feedSegmented, releaseCapture, resetSegmentation],
  );

  const start = useCallback(() => connect(microphoneAudioSource()), [connect]);

  const startWithFile = useCallback(
    (file: File, options?: PacedAudioSourceOptions) =>
      // The default (no `options`) is the microtask source AC-315's handshake guard depends on;
      // `options` is the explicit test seam onto the real-time paced source beside it.
      connect(options ? pacedFileAudioSource(file, options) : fileAudioSource(file)),
    [connect],
  );

  const mute = useCallback(() => {
    // The sentence in flight is delivered as its own segment BEFORE the mute takes
    // hold: Mute pauses sending, it does not discard what was already being said.
    // Nothing can arrive between this flush and the flag below, because the capture
    // callback is read synchronously.
    flushSegments();
    mutedRef.current = true;
    levelRef.current = 0;
    // A frame queued during the handshake just before Mute must not be replayed
    // when `open` later arrives — the criterion reads Mute as "the upstream
    // frame count stops growing", and a replayed pre-Mute burst would move it.
    pendingFramesRef.current = [];
    setPhase((current) => (current === 'listening' ? 'muted' : current));
  }, [flushSegments]);

  const unmute = useCallback(() => {
    mutedRef.current = false;
    setPhase((current) => (current === 'muted' ? 'listening' : current));
  }, []);

  return { phase, error, unansweredSeconds, captions, deliveries, delivering, queuedDepth, queuedBytes, refusal, undelivered, stopped, levelRef, connectedAt, disconnected, closedUnshown, micSuspended, start, startWithFile, mute, unmute, end };
}
