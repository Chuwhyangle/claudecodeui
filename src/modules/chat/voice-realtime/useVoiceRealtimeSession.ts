import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import { useAuth } from '@/modules/auth';
import { continuousAudioFrame, frameLevel } from '@/modules/chat/voice-realtime/audioFrameEncoding';
import {
  fileAudioSource,
  microphoneAudioSource,
  pacedFileAudioSource,
  type PacedAudioSourceOptions,
  type VoiceRealtimeAudioFrame,
  type VoiceRealtimeAudioSource,
} from '@/modules/chat/voice-realtime/audioSource';
import {
  claimThrough,
  sortCaptionsInSpokenOrder,
  unclaimedSegment,
} from '@/modules/chat/voice-realtime/captionOrdering';
import {
  concatNarratorBytes,
  narratorBase64Bytes,
  parseNarratorWavHeader,
  releaseNarratorStream,
  type NarratorStream,
  type NarratorWavHeader,
} from '@/modules/chat/voice-realtime/narratorWav';
// The count a close leaves behind is the row algebra's own question — which utterances a shown
// delivery accounts for — so it is asked through the same shared rule the fold removes words by, not
// a second copy of it that could drift.
import { countUnshownUtterances, normalizeForMatch } from '@/modules/chat/voice-realtime/placeCaptions';
import {
  playVoiceAttentionCue,
  playVoiceEnterCue,
  playVoiceExitCue,
} from '@/modules/chat/voice-realtime/soundCue';
import {
  contextFrame,
  declaresSegmentedRelay,
  SEGMENTED_RELAY_PROTOCOL,
  segmentFrames,
  segmentedRelayOffer,
  type VoiceRealtimeSegmentAck,
} from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';
import { buildVoiceContextPack, buildVoiceRunOutput } from '@/modules/chat/utils/voice/voiceContextPack';
import { createLiveSegmenter } from '@/modules/chat/utils/voice/voiceLiveSegmenter';
import type { LiveSegment, LiveSegmenter } from '@/modules/chat/utils/voice/voiceLiveSegmenter';

import { voiceRealtimeSocketUrl } from '@/shared/api';
import { readVoiceRuntimeConfig } from '@/shared/voiceRuntimeConfig';
import type { ChatMessage, VoiceRealtimeSegmentOutcome } from '@/shared/types';
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
 *
 * `arming` is the window between the upstream reporting `state: open` and the
 * audio source delivering its FIRST frame. Capture is asynchronous
 * (`getUserMedia` → `AudioContext` → the worklet), so the connection can be
 * open while nothing can yet be sent; saying `listening` there claimed a
 * microphone the page did not have. The phase moves to `listening` on that
 * first frame (see {@link VoiceRealtimeSession.captureReady}), and re-enters
 * `arming` on a reconnect, whose capture starts over.
 */
export type VoiceRealtimePhase = 'idle' | 'connecting' | 'arming' | 'listening' | 'muted' | 'failed';

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
  /**
   * `seq` is the relay segment the transcript was spoken in, or `null` when it belongs to none this
   * connection closed. The server resolves it from the endpoint's item id, so a transcript that
   * reaches the page after a LATER segment has started still names the segment it came from. Nothing
   * reads it yet — the render path places captions by arrival — but it is declared here because the
   * page must not treat the field as absent-therefore-impossible: a consumer that later places words
   * by segment reads this, and `null` is its honest "no segment" answer.
   */
  | { type: 'caption'; itemId: string; text: string; final: boolean; seq?: number | null }
  | { type: 'queued'; depth?: number; bytes?: number }
  /**
   * The ONE message the relay is HOLDING while Claude is busy (ruling 2026-10-14): every sentence
   * spoken during a run, merged. `text` is that message right now and the page draws one read-only
   * card from it; `bytes` is its length. An EMPTY `text` is the clear — the words were delivered,
   * folded into a stop, or lost with the connection, so the card comes down.
   *
   * A DIFFERENT WAIT from {@link queued}: that one is the 1 s tidying window on a single sentence,
   * this one lasts as long as the run in flight. The page renders them differently for exactly that
   * reason — the tidying window has no card of its own.
   */
  | { type: 'pending'; text?: string; bytes?: number }
  | { type: 'refused'; reason: string; depth?: number; bytes?: number }
  | {
      type: 'sent';
      sessionId: string;
      result: unknown;
      message?: string;
      depth?: number;
      bytes?: number;
      /**
       * The last user item the endpoint had committed when this instruction was relayed — the
       * conversation boundary the sentences it answers belong to. The claim step attributes by THIS
       * and not by the relayed text, because the model rewords and omits what it relays; absent only
       * on a connection that has committed no speech, where the window rule below takes over.
       */
      coveredThroughItemId?: string;
    }
  /**
   * The GRADED verdict on one relay segment (AC-366's vocabulary), read here by the type the protocol
   * module owns rather than a second copy of the union — the wire shape and this consumer cannot drift.
   * See {@link VoiceRealtimeSegmentAck} for what each state means; the two this page renders as a row
   * of their own are `written` (uncertain) and `lost` (terminal).
   */
  | VoiceRealtimeSegmentAck
  /**
   * One spoken turn the proxy reports the endpoint never answered. Delivered as its own frame
   * rather than as an `error` (see the proxy's `VoiceRealtimeOutboundFrame`): the turn is over,
   * and what the person needs is to see that it is — not another failure notice.
   */
  | { type: 'turn_unanswered'; seconds: number }
  /**
   * The model heard the person and chose NOT to forward their words — the continuous relay's
   * "heard, not forwarded" disposition (decision doc §12.6 B-8), delivered as its own frame rather
   * than as an `error` (see the proxy's `VoiceRealtimeOutboundFrame`): the utterance is over and
   * was set aside, not lost, so the bar says so instead of flashing the failure state. Absent under
   * the segmented wire, where a text reply is that wire's regression and keeps its error frame.
   */
  | { type: 'heard_not_forwarded' }
  /**
   * The proxy carried out a stop: the run in flight was aborted. `aborted` is the control service's
   * own verdict (false = there was nothing to stop); `depth` is how many of the person's messages are
   * STILL waiting — a stop ends one run and never cancels what was already accepted.
   */
  | { type: 'stopped'; aborted: boolean; depth?: number }
  /**
   * A narration the narrator layer wants spoken (GOAL-047), and the cut that ends the current one.
   *
   * The words are the DISPLAY/fallback half of what is said; the audio arrives just behind them as
   * the three `tts_*` frames below. `utteranceId` is the id the queue paces on and the correlation
   * key between the text, the audio slices and the `narrator_done` ack. `narrator_done` is the
   * page→server frame and is not one this side receives.
   */
  | { type: 'narrator_speak'; utteranceId: string; text: string }
  | { type: 'narrator_stop'; utteranceId: string; reason?: string }
  /**
   * The server asks for the output of the run that just ended — the run-end summary's only source.
   * Answer with a `run_output` frame carrying the same `requestId` and the text rendered NOW from
   * the transcript. Nothing is cached: the request names one run, the reply carries one turn.
   */
  | { type: 'run_output_request'; requestId: string }
  /**
   * The narrator's synthesized audio, produced by the server's TTS leaf (the `voice-realtime-tts`
   * frame contract). `tts_audio` carries a bounded base64 slice with a zero-based `seq`;
   * `tts_done` closes the utterance with the byte/duration readings; `tts_error` is the named
   * refusal that replaces silence. The utterance is played here and answered with `narrator_done`
   * — the server's queue is PACED on that ack, so playback completion is what advances narration.
   */
  | { type: 'tts_audio'; utteranceId: string; seq: number; audio: string; format: string; sampleRate: number }
  | {
      type: 'tts_done';
      utteranceId: string;
      frames: number;
      bytes: number;
      durationMs: number | null;
      characters: number;
    }
  | {
      type: 'tts_error';
      utteranceId: string;
      code: string;
      message: string;
      upstreamCode?: string;
      httpStatus?: number;
    }
  /**
   * The host's own account of which of the person's delivered commands its queue STILL holds — the
   * reconcile set (see the proxy's `VoiceRealtimeOutboundFrame`). `queuedMessageUuids` names only
   * THIS person's own deliveries the host has not yet dequeued, so an EMPTY array is the real
   * reading "nothing of yours is still waiting". Folded onto {@link VoiceRealtimeDelivery.queuePending}
   * so a `queued` withdraw row whose terminal lifecycle frame was lost still clears.
   */
  | { type: 'queue_reconcile'; queuedMessageUuids?: string[] }
  /**
   * The proxy's correction of the waiting depth when the session's own queue moved and no delivery
   * said so (a drain after a stop). Moves {@link VoiceRealtimeSession.queuedDepth}/`queuedBytes` only.
   */
  | { type: 'queue_depth'; depth?: number; bytes?: number }
  | { type: 'error'; code: string; message: string; recoverable?: true };

/**
 * The audio the server is still assembling for ONE narrator utterance.
 *
 * Slices are keyed by the server's own `seq` because a WebSocket delivers them in order but the
 * page must not depend on that: assembling by `seq` is what lets `tts_done` locate every slice the
 * utterance declared, and a missing one is a reading the page can report rather than silently
 * playing a shorter clip.
 */
type NarratorTtsBuffer = {
  utteranceId: string;
  format: string;
  sampleRate: number;
  chunks: Map<number, string>;
};

/** The narrator utterance whose `<audio>` element is playing now. */
type NarratorPlaying = { utteranceId: string; url: string };

/**
 * The MIME type one TTS container is decoded as.
 *
 * `wav` is the leaf's default and the only shape this page needs; the other three are declared so a
 * deployment that changes the leaf's format is still handed to the media element as the container
 * it is, rather than as a mislabelled blob.
 */
const NARRATOR_TTS_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  pcm: 'audio/L16',
};

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
  /**
   * The relay segment this utterance was SPOKEN in, or `null` when it belongs to no segment this
   * connection closed (the continuous path, or an item the endpoint's own detector created).
   *
   * THE ONLY KEY THAT SURVIVES THE ENDPOINT'S OWN REORDERING. `at` is the browser's arrival clock,
   * and the endpoint answers its commits in whatever order it finishes — journal `ef9daacd` has
   * seq2's transcript arriving after seq3's commit and seq4's after seq5's — so arrival order is not
   * spoken order, and a late transcript read by `at` sorts to the wrong place in the person's own
   * sentences. `seq` is the order the person actually spoke in, and it is what the transcript places
   * the words by.
   *
   * Optional because it was added to an existing record: a fixture, or a frame from a proxy built
   * before the segmented relay's seq↔itemId pairing, leaves it absent — read as "place this
   * utterance by arrival", never as segment 0.
   */
  seq?: number | null;
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
  /**
   * Whether the host's own queue still held this delivery's command at the last reconcile frame
   * the voice socket received — the `queue_reconcile` reading (see
   * `voice-realtime-ws-proxy.service.ts`), keyed by the same `queuedMessageUuid` a withdrawal uses.
   *
   * THE SECOND SOURCE FOR THE WITHDRAW ROW. The host's `command_lifecycle` frames are the primary
   * reading, but they travel host → writer → browser and the 2026-10-14 defect was a break on that
   * path: the host had read the CLI's dequeue while the browser still showed the row. This field is
   * set from a frame the proxy derives from the HOST'S OWN `started` reading, so a `queued` row whose
   * uuid the host no longer reports is one to clear even if its terminal lifecycle frame never
   * arrived. `true` = held, `false` = the host's queue no longer has it, `undefined` = no reconcile
   * has named it yet (lifecycle frames remain the only source). The per-row withdraw control the
   * 2026-10-14 ruling retired was its only reader (it dropped a row on `false`); the field is kept as
   * part of the delivery record.
   */
  queuePending?: boolean;
  /**
   * The conversation boundary this delivery answered through — the `sent` frame's
   * `coveredThroughItemId`, when the proxy reported one.
   *
   * WHY IT IS KEPT. The transcription of the item the model answered is a SEPARATE, slower upstream
   * event: a delivery can be confirmed while the caption for the sentence it carries is still being
   * recognised (observed on 2026-10-22, tree `9b141d3f`: the delivery rows landed while one final
   * caption was still on its way). At the `sent` the caption was not on screen, so nothing was
   * claimed, and by the time it arrived no later delivery existed to claim it — leaving the mode
   * handed a sentence the model had already received back to the composer as a draft. The boundary
   * is what the client can still check afterwards: a caption that becomes final for THIS item is one
   * this delivery answered, so it joins `itemIds` late (see the `caption` handler).
   *
   * Optional because a relay that reports no boundary (an older proxy, a stand-in) leaves it absent;
   * there the delivery is judged by its message and window alone, exactly as before.
   */
  coveredThroughItemId?: string;
  /**
   * A delivery the proxy has ACCEPTED (`queued`, its coalescing window opened) whose `sent` has not
   * arrived — its `message` is empty because the proxy has not reported the words yet.
   *
   * WHY THE CLIENT RECORDS IT BEFORE THE CONFIRMATION. Leaving Live Voice closes the browser socket
   * at once, and the `sent` frame is emitted only after `session_send` resolves — which can take
   * seconds (the coalescing window plus the session's own queue). Exit could therefore beat the
   * frame for a delivery the proxy had already accepted; the proxy still finishes it on teardown
   * (`flushCoalesced`), so the words DO reach the session while the page treated them as unheard and
   * put them back in the composer's draft (2026-10-22 01:48, AC-323). The window is the same one the
   * `sent` handler would claim — the finished utterances no delivery has yet taken — recorded early
   * so a leave in the gap keeps them out of the backlog. A refusal or an error withdraws it (the
   * words were never accepted and must be offered back).
   */
  inFlight?: true;
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
   * Whether the audio source has actually produced its first frame.
   *
   * This is the reading `phase === 'listening'` rests on. `state: open` only says the upstream
   * session is up; capture is asynchronous (`getUserMedia` → `AudioContext` → the worklet), so
   * there is a window — hundreds of ms even when permission was already granted, longer on the
   * first grant — in which the connection is open and no audio can possibly be sent. The phase
   * says `arming` across that window and this stays false; the first captured frame flips it and
   * `unmute`/`state: open` read it. The status cell carries the same reading as
   * `data-capture` (`starting` / `live`) so a test need not depend on the copy.
   */
  captureReady: boolean;
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
   * The machine-readable class of {@link error}, or `null` when there is no failure.
   *
   * The bar must say ONE understandable reason, and the raw {@link error} text is the upstream's
   * own wording — technical, and untranslated. So the failure is classified where it happens, next
   * to the message it describes: an error frame contributes its own `code` (`SPEND_LIMIT`,
   * `MISSING_API_KEY`, …); the browser's failures — a socket that errors, a WebSocket that will not
   * construct, a microphone that will not open — carry no code at all, so they are given a local
   * one here (`SOCKET_ERROR`, `MIC_UNAVAILABLE`). Both travel together: this field exists only to
   * pick the bar's sentence, and the raw message stays for the element's `title`.
   */
  errorCode: string | null;
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
   * `true` when the model heard the last utterance and chose NOT to forward it, `false` otherwise —
   * the `heard_not_forwarded` disposition (decision doc §12.6 B-8).
   *
   * A TURN OUTCOME, not an error, and deliberately not the same channel as {@link error}: the model
   * answering in text instead of calling a tool is the "nothing to do" disposition, so the utterance
   * was heard and set aside — not lost, and not a reason to put the session into its failed state.
   * The bar shows it so the words leave a visible trace rather than disappearing silently, which is
   * what the continuous relay did before this frame existed. Cleared the moment a delivery answers
   * (`sent`) and at every connection boundary, so it is a window rather than a sticky notice.
   */
  heardNotForwarded: boolean;
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
   * The server coalesces deliveries in a 1 s window, during which it used to send nothing at all:
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
   * THE ONE MESSAGE THE RELAY IS HOLDING while the session is busy, or `''`.
   *
   * Ruling 2026-10-14: while the bound session reports a run in flight, the relay does NOT push a
   * command per sentence into the CLI's queue. It keeps ONE merged message — every sentence joins the
   * same buffer — and hands the whole thing to the session as ONE message when the run ends. This is
   * that message's text, as the last `pending` frame reported it; `''` is the clear (the hold was
   * delivered, or the connection is going down), and the one read-only card the pane draws comes down
   * with it.
   *
   * It is distinct from {@link delivering}/{@link queuedDepth}: those describe a delivery already on
   * its way after the 1 s coalescing window, while this describes words being held for as long as the
   * run lasts. It is also what keeps the held words out of the leave-backlog the composer is handed —
   * the proxy delivers them on teardown, so re-typing them would send them twice.
   */
  pendingMessage: string;
  /**
   * THE ONE DELIVERED-AWAITING-DEQUEUE CARD's text, or `''` — the words of the newest delivery whose
   * command the host has not dequeued yet (2026-10-14 evening reading).
   *
   * WHY THE PAGE OWED A SECOND READING. The relay's hold (`pendingMessage`) hands the merged message
   * to the session and clears its card the moment it goes in; but a delivery the CLI ENQUEUES is not
   * yet a message in the conversation — it becomes one only when the CLI dequeues it at the next turn
   * boundary, which the 2026-10-14 evening reading measured at 3–54 s. For that whole gap the screen
   * showed NOTHING (the page has no row for a voice delivery of its own), so the person read the
   * vanished card as a lost message. This is the text of that wait: the newest delivery the last
   * `queue_reconcile` still names (`queuePending === true`), and `''` once the host reports it started.
   *
   * DERIVED FROM {@link deliveries}, never a second state — the flag lives on the delivery and the
   * newest held one IS the card. It is the render half of the same reading the per-row withdraw control
   * (retired 2026-10-14) used to consume, and — like that control — it NEVER coexists with the hold
   * card: `VoicePendingMessageCard` draws the hold when {@link pendingMessage} is non-empty and this
   * only when it is empty, so there is still exactly one waiting card on screen at any moment.
   */
  queuedDeliveryText: string;
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
  /**
   * `true` once the voice connection is not usable under a live mode — the bar says so and offers
   * Retry.
   *
   * TWO WAYS TO REACH IT, both the connection dying under a live mode rather than the user's own
   * Exit: the page socket closed on its own, or the VOICE connection did — the bridge reported
   * `state: closed`, or a segment came back `lost(reason: 'connection-closed')` because the upstream
   * socket was already gone while the page socket stayed open (the shape journal `e22ac831` records).
   * The second is why this is not a page-socket flag alone: a person whose upstream died would
   * otherwise watch the bar say "Listening…" over a microphone that has nowhere to send.
   */
  disconnected: boolean;
  /**
   * The automatic reconnect under way after a network drop, or `null`: `attempt` of `of`, counted
   * from the drop until a reconnected connection reports `state: open` or the attempts run out.
   * Only a raw drop of an OPENED microphone connection reconnects — never Exit, a server
   * `state: closed`, a failure, or a file source (person's ruling, 2026-10-15).
   */
  reconnecting: { attempt: number; of: number } | null;
  /**
   * How many utterances the connection CLOSED ON without them ever reaching the screen (P3), or 0.
   *
   * A COUNT rather than a boolean: the trace has to say how much was lost, and `> 0` is the pane's
   * cue to leave a visible line. Counted the moment the socket closes and reset when the next
   * connection opens, so the reading always belongs to the connection it describes.
   */
  closedUnshown: number;
  /**
   * The relay segments this connection closed that produced NO transcript — the words the endpoint
   * never turned into text, as segment ids, in spoken order.
   *
   * A LIST rather than a flag or a count: each one is a sentence of the person's that has no words to
   * show, and the transcript marks each at its own spoken place, so the person reads WHICH of their
   * sentences went unrecognised rather than that some did. Two things put a segment here, and both
   * are answers the page is owed rather than inferences it makes:
   *
   *   - the endpoint REFUSED the segment's commit, or reported no words for it — the proxy's own
   *     `segment_ack {state: 'dropped'}`, an immediate, mechanical verdict;
   *   - the segment was committed and no transcript had arrived by the deadline
   *     ({@link SEGMENT_TRANSCRIPT_GRACE_MS}) — the endpoint's answers are late by seconds, so only
   *     a deadline can tell "still coming" from "never coming".
   *
   * A transcript that arrives AFTER the deadline retracts the entry: the words replace the
   * not-recognised line in place, because a late transcript is not a defect. Reset at every
   * connection boundary, like the readings beside it — a segment id means nothing to the next socket.
   */
  unrecognizedSeqs: readonly number[];
  /**
   * The relay segments this connection reported UNCERTAIN or LOST, in spoken order — the graded
   * segment ACK's own reading (AC-366→AC-367).
   *
   * THE THIRD DISPOSITION, BESIDE `heard` AND `not recognised`. A segment the endpoint answered with
   * no words is not recognised; a segment whose audio and commit were written to an upstream socket
   * that died before the endpoint answered is UNCERTAIN (`written` — the bridge may still replay it,
   * so the words may yet arrive); a segment the connection will never transcribe is LOST (`lost`),
   * and its reason says which failure it was: `connection-closed` (the voice connection was not open,
   * so nothing was ever sent) or `upstream-drop` (the replay budget was spent — the words never
   * reached the model). Reading any of these as "not recognised" would blame the endpoint's
   * transcription for a wire that never carried the audio.
   *
   * An entry is superseded by its seq's latest verdict (a `written` that a later `lost` replaces), is
   * RETRACTED when a transcript arrives for that seq (the words take its place, exactly as a late
   * transcript retracts a not-recognised line), and is cleared with `committed` — the endpoint
   * answering doubles as "no longer uncertain". Reset at every connection boundary, like the segment
   * verdicts beside it: a seq is a name only the socket that numbered it can answer for.
   */
  segmentOutcomes: readonly VoiceRealtimeSegmentOutcome[];
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
 * The waits before each automatic reconnect after a network drop. Five attempts over ~15 s rides out
 * a tunnel blip (live 2026-10-15: the voice socket alone dropped) without retrying forever against a
 * network that is really gone.
 */
const VOICE_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

/**
 * How long the transcript must stay quiet before the C2 context pack is re-sent.
 *
 * The pack used to be sent once, at `socket.onopen`, and the proxy kept that reading for the whole
 * connection — so every run-end summary described the conversation as it stood when the person
 * opened Live Voice. A run's own output lands in the transcript after the run ends, which is a
 * burst of rows rather than one; debouncing keeps a streaming answer from putting a frame per
 * token on the wire. 2.5 s is inside the proposal's 2–3 s window and shorter than the proxy's
 * 400 ms settle wait plus a TTS round trip, so the fresh pack is normally standing before the
 * run-end summary is asked.
 */
const VOICE_CONTEXT_RESEND_DEBOUNCE_MS = 2_500;

/**
 * One console line per lifecycle event of a Live Voice connection. The server log shows what
 * the upstream said; only the page knows why IT started, replaced or ended a connection, and
 * "the session closed right after it opened" is unanswerable without that.
 */
function voiceLog(message: string): void {
  console.info(`[voice-realtime] ${message}`);
}

/**
 * How long a committed segment is given to produce a transcript before the page stops waiting and
 * marks the words as not recognised.
 *
 * THE DEADLINE IS THE ONLY SIGNAL FOR ONE OF THE TWO WAYS A SEGMENT GOES UNRECOGNISED. When the
 * endpoint refuses a commit, or reports no words for it, the proxy says so on `segment_ack` and the
 * page needs no clock. When a segment IS committed and the endpoint simply never answers for it,
 * nothing on the wire ever says so — the absence is the fact — and only a deadline can separate
 * "still arriving" from "not coming".
 *
 * WHY THIS LONG. The endpoint transcribes a one-second utterance in about a second, and the journal
 * this deadline was written against (`ef9daacd`, 2026-10-12) has transcripts landing one to three
 * seconds after their commit. Six seconds clears that comfortably, and stays well inside the eight-
 * second stall that produced the unrecognised segment there. Being late is the cheap error: the page
 * marks a segment only after the wait, and a transcript that arrives afterwards REPLACES the
 * not-recognised line in place, so an over-long wait costs a few seconds of silence about a sentence
 * that is still coming, while an over-short one would accuse the endpoint of dropping words it was
 * about to send.
 */
const SEGMENT_TRANSCRIPT_GRACE_MS = 6_000;

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
 * The conversation boundary a `sent` frame reports, or `null` when it reports none.
 *
 * `null` is "this relay did not say", never "the boundary is at the start": a frame without the
 * field comes from a relay that cannot answer the question, and the caller falls back to its own
 * window rule rather than treating every sentence as uncovered.
 */
function readCoveredThroughItemId(frame: { coveredThroughItemId?: unknown }): string | null {
  const value = frame.coveredThroughItemId;
  return typeof value === 'string' && value !== '' ? value : null;
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
   * The conversation the C2 context pack is built from.
   *
   * Read once when a connection opens and again (debounced) whenever this array changes while the
   * connection stays up, so the proxy's instructions follow the conversation instead of freezing
   * on the first snapshot. The transcript the pane renders, not the caption rows: what the person
   * is in the middle of saying is audio the model already hears, and the words land in this list as
   * a real message the moment the delivery is confirmed.
   */
  contextMessages?: readonly ChatMessage[] | undefined;
}): VoiceRealtimeSession {
  const { token } = useAuth();
  // The phase the bar renders; driven by the wire above all.
  const [phase, setPhase] = useState<VoiceRealtimePhase>('idle');
  /**
   * `true` once the audio source has delivered its first frame — see
   * {@link VoiceRealtimeSession.captureReady}. State because the bar renders `data-capture` from it
   * and the `arming`/`listening` distinction is a render; the ref beside it is the same reading for
   * the socket/capture handlers, which close over a value once.
   */
  const [captureReady, setCaptureReady] = useState(false);
  const captureReadyRef = useRef(false);
  // The last failure, kept so a closed session can explain itself after the
  // socket that carried the reason is gone.
  const [error, setError] = useState<string | null>(null);
  // The failure's class, set with the message and cleared with it — see `VoiceRealtimeSession.errorCode`
  // for why the two are recorded together at the point of failure rather than inferred from the text.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  /**
   * Records a failure as one indivisible pair: the raw message (the bar's `title`) and the code that
   * picks the bar's sentence. Kept as a pair so the two can never disagree — a code left over from a
   * previous failure would explain the wrong reason.
   */
  const fail = useCallback((message: string, code: string | null) => {
    setError(message);
    setErrorCode(code);
  }, []);
  // The deadline an unanswered turn expired at, or `null`. Set by the `turn_unanswered` frame and
  // cleared by the next delivery, so the bar can hold the outcome on screen for exactly as long as
  // the turn is unresolved — see `VoiceRealtimeSession.unansweredSeconds` for why this is not `error`.
  const [unansweredSeconds, setUnansweredSeconds] = useState<number | null>(null);
  // `true` when the model heard the last utterance and chose NOT to forward it — the
  // `heard_not_forwarded` disposition (decision doc §12.6 B-8). Its own channel, like
  // `unansweredSeconds` and deliberately not `error`: the session is healthy and still listening,
  // and the outcome holds until a delivery answers it, so the bar can leave a visible trace of an
  // utterance that reached neither the session nor the screen. See
  // `VoiceRealtimeSession.heardNotForwarded` for why this is not the failure slot.
  const [heardNotForwarded, setHeardNotForwarded] = useState(false);
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
  // The reconnect attempt under way after a network drop (see `VoiceRealtimeSession.reconnecting`).
  // State because the bar draws its banner from it; the counter itself lives in the ref below.
  const [reconnecting, setReconnecting] = useState<{ attempt: number; of: number } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Attempts made since the last drop of an opened connection; 0 when no reconnect is under way.
  const reconnectAttemptRef = useRef(0);
  // Whether the current connection's source can be re-opened: the microphone can, an uploaded file cannot.
  const reconnectableRef = useRef(false);
  // The server ended this connection on purpose (`state: closed` or a fatal error): its close is not a drop.
  const serverEndedRef = useRef(false);
  // The reconnect timer fires outside any render, so it reaches the latest `connect` through this ref.
  const connectRef = useRef<(source: VoiceRealtimeAudioSource, options: { reconnectable: boolean; reconnect?: boolean }) => void>(
    () => undefined,
  );
  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    setReconnecting(null);
  }, []);
  // `true` while the microphone's capture `AudioContext` is browser-suspended and being resumed (see
  // `VoiceRealtimeSession.micSuspended`). State, not a ref, because the bar re-renders from it to
  // grey the waveform; set only by the mic source's suspension report, and cleared on every
  // connection boundary so a suspension never outlives the capture that reported it.
  const [micSuspended, setMicSuspended] = useState(false);
  const levelRef = useRef(0);
  /**
   * Whether the session has ever opened a connection. The exit cue belongs to a session the person
   * really had; leaving a mode that never connected must not sound like leaving a live one.
   */
  const sessionStartedRef = useRef(false);
  /**
   * Whether the enter cue has sounded for THIS session. Reset by a start the person asks for, NOT by
   * a reconnect: the reconnect replaces the wire and the capture, but it is the same session, and
   * hearing "you are live" again after every tunnel blip would be a new kind of noise.
   */
  const enterCuedRef = useRef(false);
  /**
   * Whether the attention cue has sounded for THIS connection. Reset by every connection, reconnect
   * included: a fresh wire that drops again is a second loss the person has to hear about.
   */
  const attentionCuedRef = useRef(false);
  /** Rings the entry cue at most once per session; the capture-ready and unmute paths share it. */
  const ringEnterCueOnce = useCallback(() => {
    if (enterCuedRef.current) return;
    enterCuedRef.current = true;
    playVoiceEnterCue();
  }, []);
  /** Rings the attention cue at most once per connection; every disconnect/failure path shares it. */
  const ringAttentionCueOnce = useCallback(() => {
    if (attentionCuedRef.current) return;
    attentionCuedRef.current = true;
    playVoiceAttentionCue();
  }, []);
  const [deliveries, setDeliveries] = useState<VoiceRealtimeDelivery[]>([]);
  // How many utterances the last connection CLOSED on without them ever reaching the screen (P3).
  // Counted in `onclose`, where the connection's own state is still readable, and held so the pane
  // can leave a visible trace instead of the words going silent. Reset by the next connection, so
  // the reading belongs to the connection it describes and not to the pane's lifetime.
  const [closedUnshown, setClosedUnshown] = useState(0);
  // The segments this connection got no transcript for, in spoken order (see
  // `VoiceRealtimeSession.unrecognizedSeqs`). State, not a ref, because the transcript renders a line
  // per entry; the ref beside it is the same list, readable — and deduplicable — from a socket handler
  // without a stale closure over this render.
  const [unrecognizedSeqs, setUnrecognizedSeqs] = useState<readonly number[]>([]);
  const unrecognizedRef = useRef<number[]>([]);
  // The segments the graded ACK reported UNCERTAIN (`written`) or LOST (`lost`), in spoken order (see
  // `VoiceRealtimeSession.segmentOutcomes`). State, not a ref, because the transcript renders a line per
  // entry; the ref beside it is the same list, readable — and supersedable by seq — from a socket
  // handler without a stale closure over this render.
  const [segmentOutcomes, setSegmentOutcomes] = useState<readonly VoiceRealtimeSegmentOutcome[]>([]);
  const segmentOutcomesRef = useRef<VoiceRealtimeSegmentOutcome[]>([]);
  // The deadline each committed segment is under, keyed by its seq: armed when the segment goes out,
  // cleared the moment its transcript arrives or the endpoint answers for it. A map rather than a
  // single timer because several segments are in flight at once on a segmented connection — the
  // person keeps talking while the endpoint is still transcribing what they said before.
  const transcriptDeadlinesRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
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
  // THE ONE MESSAGE THE PROXY IS HOLDING (ruling 2026-10-14). While the bound session reports a run
  // in flight the relay keeps ONE merged message instead of pushing a command per sentence into the
  // CLI's queue, and this is that message's text as the last `pending` frame reported it. Server-owned
  // like the depth: an EMPTY string — the clear frame — means nothing is held and the card comes down.
  // It is also what keeps the held words out of the leave-backlog (`collectUndeliveredUtterances`):
  // the proxy will deliver them on teardown, so re-typing them into the composer would send twice.
  const [pendingMessage, setPendingMessage] = useState('');
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
  /**
   * The deliveries still owed a caption whose FINAL transcription had not arrived when their `sent`
   * landed — `itemId` (the delivery's `coveredThroughItemId`) → its index in `deliveriesRef`.
   *
   * The ordering upstream is not fixed: the endpoint's transcription of the item the model answered
   * can land after the delivery that answered it. Such a caption is claimed when it finally becomes
   * final (see the `caption` handler), by ITEM ID — never by "everything still unclaimed", which is
   * the swallow defect `gap-live-voice-caption-attribution-swallows-undelivered` closed. Cleared per
   * connection, because an item id and a delivery index are facts about one socket's conversation.
   */
  const lateClaimRef = useRef<Map<string, number>>(new Map());

  /**
   * Takes back the claim a `queued` delivery made before its confirmation.
   *
   * The early claim exists because a leave can beat the `sent` of a message the proxy has already
   * accepted (see `VoiceRealtimeDelivery.inFlight`). It is only true while the proxy really carries
   * it: a refusal or a fatal error says the words never left, and they must be offered back to the
   * composer as the backlog they are. Called from those two frames only — a connection close leaves
   * the claim standing, because the proxy's teardown flushes an accepted instruction.
   */
  const releaseInFlightDelivery = useCallback(() => {
    const remaining = deliveriesRef.current.filter((delivery) => delivery.inFlight !== true);
    if (remaining.length === deliveriesRef.current.length) {
      return;
    }
    const stillClaimed = new Set(remaining.flatMap((delivery) => delivery.itemIds));
    for (const delivery of deliveriesRef.current) {
      if (delivery.inFlight !== true) continue;
      for (const itemId of delivery.itemIds) {
        if (!stillClaimed.has(itemId)) attributedRef.current.delete(itemId);
      }
    }
    deliveriesRef.current = remaining;
    setDeliveries(deliveriesRef.current);
  }, []);
  // The host's last reconcile reading, as a set of the person's command uuids its queue STILL holds
  // (`queue_reconcile`). `null` until the first such frame: no reading yet, so nothing may be
  // cleared on this field alone. Held as a ref so a delivery committed in the same tick can be
  // annotated without waiting for a render, the same reason `deliveriesRef` is a ref.
  const queuePendingRef = useRef<Set<string> | null>(null);

  // `connect` reads the CURRENT session and token through this ref instead of closing over
  // them. Closing over them made `start` a new function on every token refresh or session-id
  // change, and the pane's "start capturing when voice mode is entered" effect depends on
  // `start` — so it re-fired mid-session and opened a SECOND connection beside the first.
  const latestRef = useRef({ sessionId, token });
  useEffect(() => {
    latestRef.current = { sessionId, token };
  });

  const socketRef = useRef<WebSocket | null>(null);
  /**
   * The narrator's TTS playback state (GOAL-047): the one `<audio>` element every narration is
   * played through, the slices still being assembled for the utterance the server is reading, and
   * the utterance playing now.
   *
   * ONE ELEMENT, because the server's narrator queue is PACED — it sends the next utterance only
   * after this page's `narrator_done` — so there is never more than one narration to play. Reusing
   * the element also keeps the playback unlock a single gesture-scoped action (see `start`).
   */
  const narratorAudioRef = useRef<HTMLAudioElement | null>(null);
  const narratorTtsRef = useRef<NarratorTtsBuffer | null>(null);
  const narratorPlayingRef = useRef<NarratorPlaying | null>(null);
  // The utterance being scheduled through an AudioContext before its `tts_done` (the streaming
  // path). `null` means the page is on the element/Blob path for whatever it is playing.
  const narratorStreamRef = useRef<NarratorStream | null>(null);
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

  /**
   * The pack text this connection already put on the wire, or `null` before its first frame.
   *
   * The resend exists because the conversation grows while ONE connection stays open: the proxy
   * keeps using whatever pack it last received, so a run-end summary read one connection-opening
   * snapshot forever. A pack that did not change is NOT re-sent — the proxy composes on every
   * `context` frame, and a duplicate would move its `context injected` reading without the
   * conversation moving. Reset per connection, because "already sent" is a fact about one socket.
   */
  const sentContextTextRef = useRef<string | null>(null);
  /** The debounce that re-sends the pack once the transcript settles, or `null`. */
  const contextResendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Drops a pending pack resend. Safe to call twice and safe on a connection that never sent one. */
  const clearContextResend = useCallback(() => {
    if (contextResendTimerRef.current !== null) {
      clearTimeout(contextResendTimerRef.current);
      contextResendTimerRef.current = null;
    }
  }, []);

  /**
   * Hands the CURRENT conversation to the proxy, if this connection has not already been told it.
   *
   * Called from `socket.onopen` (the first pack) and from the debounced resend effect below. The
   * proxy reads a `context` frame at any point in the connection's life and re-composes the
   * instructions from it, so neither call has to wait for the upstream session to open: a frame
   * that arrives before the handshake is picked up by the `whenConnected` path.
   */
  const sendContextPack = useCallback((socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // The deployment's effective rows / budget / per-row cap, published by `useVoiceAvailable`.
    // `null` (no reading yet, or a failed fetch) is the shipped default — the builder never invents
    // a value the server did not name. The proxy trims again server-side, so a reading that lands
    // after this first frame still governs what reaches the model.
    const pack = buildVoiceContextPack(contextMessagesRef.current, readVoiceRuntimeConfig() ?? {});
    const frame = contextFrame(pack);
    // No frame for an empty pack, and none for a pack that matches what this connection already
    // sent: the first run over an empty conversation sends nothing at all.
    if (frame === null || frame.text === sentContextTextRef.current) {
      return;
    }
    sentContextTextRef.current = frame.text;
    socket.send(JSON.stringify(frame));
    voiceLog(`context chars=${frame.chars} rows=${frame.rows}`);
  }, []);

  /**
   * Keeps the proxy's pack following the conversation while one connection stays open.
   *
   * The transcript array is a NEW identity each time rows land, which is exactly the "something
   * was said" edge this watches: after {@link VOICE_CONTEXT_RESEND_DEBOUNCE_MS} of quiet, the pack
   * is rebuilt and sent only if it differs from the one already on the wire (a caption row that
   * changes without changing what the person could READ sends nothing).
   *
   * No socket means nothing to follow: the connection's own `onopen` sends the first pack, and a
   * pending timer is dropped with the close (`end` and `onclose` both call
   * {@link clearContextResend}), so a dead socket is never written to.
   */
  useEffect(() => {
    clearContextResend();
    const socket = socketRef.current;
    if (contextMessages === undefined || socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    contextResendTimerRef.current = setTimeout(() => {
      contextResendTimerRef.current = null;
      const current = socketRef.current;
      if (current === null) {
        return;
      }
      sendContextPack(current);
    }, VOICE_CONTEXT_RESEND_DEBOUNCE_MS);
    return clearContextResend;
  }, [contextMessages, clearContextResend, sendContextPack]);

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

  /** Stops waiting on one segment's transcript. Safe to call for a segment that has no deadline. */
  const clearTranscriptDeadline = useCallback((seq: number) => {
    const timer = transcriptDeadlinesRef.current.get(seq);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    transcriptDeadlinesRef.current.delete(seq);
  }, []);

  /**
   * Records that one segment produced no transcript, so the transcript can mark it at its own
   * spoken place. Idempotent: the two ways in (the endpoint's own verdict, and the deadline) can
   * both fire for one segment, and the line is per segment, not per reason.
   */
  const markSegmentUnrecognized = useCallback((seq: number, why: string) => {
    if (unrecognizedRef.current.includes(seq)) {
      return;
    }
    unrecognizedRef.current = [...unrecognizedRef.current, seq].sort((a, b) => a - b);
    setUnrecognizedSeqs(unrecognizedRef.current);
    voiceLog(`segment seq=${seq} has no transcript (${why}): shown as not recognised`);
  }, []);

  /**
   * Drops one segment's graded outcome, because a later answer made it untrue: a transcript arrived
   * for that segment (its words take the line's place), or the endpoint answered it (`committed`),
   * which is what "no longer uncertain" means.
   */
  const clearSegmentOutcome = useCallback((seq: number) => {
    if (!segmentOutcomesRef.current.some((entry) => entry.seq === seq)) {
      return;
    }
    segmentOutcomesRef.current = segmentOutcomesRef.current.filter((entry) => entry.seq !== seq);
    setSegmentOutcomes(segmentOutcomesRef.current);
  }, []);

  /**
   * Records the graded ACK's verdict on one segment (AC-367): `written` (uncertain) or `lost`.
   *
   * ONE ENTRY PER SEQ, LATEST VERDICT WINS. A segment can be answered more than once — `written` when
   * its commit was written to a socket that then died, and later `lost(upstream-drop)` once the bridge
   * has spent its replays and given up — and the person needs one line per segment carrying the latest
   * fate, not a growing stack of them.
   *
   * IT ALSO RETRACTS A NOT-RECOGNISED MARK the transcript deadline may already have drawn for the same
   * seq. The deadline can only say "no words came"; the graded ACK says exactly what became of the
   * segment, and the more specific answer wins — a lost segment must never ALSO read as an empty
   * transcription, which would blame the endpoint for a wire that never carried the audio.
   *
   * `lost(connection-closed)` also flips {@link VoiceRealtimeSession.disconnected}: this frame is the
   * page's evidence that the VOICE connection was already gone when the segment ended, and the bar has
   * to say so rather than keep reporting "Listening…" over a microphone with nowhere to send.
   */
  const recordSegmentOutcome = useCallback((outcome: VoiceRealtimeSegmentOutcome) => {
    if (unrecognizedRef.current.includes(outcome.seq)) {
      unrecognizedRef.current = unrecognizedRef.current.filter((value) => value !== outcome.seq);
      setUnrecognizedSeqs(unrecognizedRef.current);
    }
    segmentOutcomesRef.current = [
      ...segmentOutcomesRef.current.filter((entry) => entry.seq !== outcome.seq),
      outcome,
    ].sort((left, right) => left.seq - right.seq);
    setSegmentOutcomes(segmentOutcomesRef.current);
    if (outcome.state === 'lost' && outcome.reason === 'connection-closed') {
      // This verdict is the page's evidence that the voice connection is gone; the person gets the
      // attention sound once per connection, just as on the explicit close paths.
      setDisconnected(true);
      ringAttentionCueOnce();
    }
  }, [ringAttentionCueOnce]);

  /**
   * The transcript for one segment arrived: stop its deadline, and retract a not-recognised mark the
   * deadline already made.
   *
   * THE RETRACTION IS NOT AN EDGE CASE, IT IS THE POINT. The deadline can only guess, and the guess
   * is wrong exactly when the endpoint was slow rather than silent — which the journal shows
   * happening. A late transcript is not a defect: its words replace the line in place, at the segment
   * they were spoken in, and the transcript never says the person's words went missing when they did
   * not.
   */
  const settleSegmentTranscript = useCallback(
    (seq: number | null) => {
      if (seq === null) {
        return;
      }
      clearTranscriptDeadline(seq);
      // A transcript landing IS the segment's words: it is no longer uncertain or lost, so a graded
      // outcome the ACK had put on it goes — the words take that line's place.
      clearSegmentOutcome(seq);
      if (!unrecognizedRef.current.includes(seq)) {
        return;
      }
      unrecognizedRef.current = unrecognizedRef.current.filter((value) => value !== seq);
      setUnrecognizedSeqs(unrecognizedRef.current);
    },
    [clearSegmentOutcome, clearTranscriptDeadline],
  );

  /**
   * Drops every segment verdict and every outstanding deadline.
   *
   * Called at both ends of a connection. A seq is a name only the socket that numbered it can answer
   * for, so a verdict from the previous connection is not the next one's, and a deadline left armed
   * across a reconnect would mark a segment of a session that no longer exists. Releasing the timers
   * is also what keeps a closed session from waking up later to write state.
   */
  const resetSegmentVerdicts = useCallback(() => {
    for (const timer of transcriptDeadlinesRef.current.values()) {
      clearTimeout(timer);
    }
    transcriptDeadlinesRef.current.clear();
    if (segmentOutcomesRef.current.length > 0) {
      segmentOutcomesRef.current = [];
      setSegmentOutcomes([]);
    }
    if (unrecognizedRef.current.length === 0) {
      return;
    }
    unrecognizedRef.current = [];
    setUnrecognizedSeqs([]);
  }, []);

  /** Sends one committed segment as `segment_start` → `audio{seq}` → `segment_end`. */
  const sendSegment = useCallback(
    (segment: LiveSegment) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const seq = seqRef.current;
      seqRef.current += 1;
      // The deadline this segment's transcript is now under. Armed with the audio, because the one
      // moment the page knows a segment exists is the moment it commits it: nothing later on the wire
      // says "and no words will ever come for this one".
      transcriptDeadlinesRef.current.set(
        seq,
        setTimeout(() => {
          transcriptDeadlinesRef.current.delete(seq);
          // A segment the graded ACK already answered is not "no transcript came": the page was told
          // exactly what became of it (uncertain, or lost with a reason), and the deadline's less
          // specific verdict must not overwrite that (AC-367).
          if (segmentOutcomesRef.current.some((entry) => entry.seq === seq)) {
            return;
          }
          markSegmentUnrecognized(seq, `no transcript within ${SEGMENT_TRANSCRIPT_GRACE_MS}ms`);
        }, SEGMENT_TRANSCRIPT_GRACE_MS),
      );
      for (const frame of segmentFrames(segment, seq, Date.now())) {
        socket.send(frame);
      }
      const seconds = (segment.durationSec ?? segment.endSec - segment.startSec).toFixed(2);
      voiceLog(
        `segment seq=${seq} duration=${seconds}s reason=${segment.reason ?? 'end'} frames=1 bytes=${segment.wav.length}`,
      );
    },
    [markSegmentUnrecognized],
  );

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

  /**
   * Cuts narrator playback and drops any bytes still being assembled.
   *
   * THE DUPLEX RULE'S CLIENT HALF. The server sends `narrator_stop` when the person speaks; by then
   * it has already dropped the queue and will send nothing more for that id, so this only has to
   * make the page quiet — pause the element, revoke its URL and forget the partial utterance. It is
   * called on `end` too: a connection that is going away has no audio to finish.
   */
  const stopNarratorAudio = useCallback(() => {
    const playing = narratorPlayingRef.current;
    narratorPlayingRef.current = null;
    narratorTtsRef.current = null;
    // Streaming playback owns scheduled AudioBufferSourceNodes: stop them and close the context
    // BEFORE the element path below runs, so a cut leaves nothing still sounding.
    const stream = narratorStreamRef.current;
    narratorStreamRef.current = null;
    if (stream !== null) {
      releaseNarratorStream(stream);
    }
    if (playing !== null) {
      URL.revokeObjectURL(playing.url);
    }
    const audio = narratorAudioRef.current;
    if (audio !== null) {
      try {
        audio.pause();
      } catch {
        /* an element the browser already detached */
      }
      audio.removeAttribute('src');
    }
  }, []);

  const end = useCallback(() => {
    // Whether a connection is really being torn down here. `end` is also the unmount cleanup and the
    // effect cleanup that follows the bar's own Exit, so it runs a second time on an already-closed
    // session — and the close trace below must be counted while the connection is still readable, not
    // re-derived from state this function has just reset.
    const live = socketRef.current !== null || sourceRef.current !== null;
    if (live) {
      voiceLog('end(): releasing capture and closing the connection');
    }
    // The falling pair plays once, and only for a session that really opened: `end` is also the
    // unmount and effect cleanup, so it can run on an already-closed session, and a mode that never
    // connected must not sound like one that did. The guard is cleared here, so the repeat is silent.
    if (sessionStartedRef.current) {
      sessionStartedRef.current = false;
      playVoiceExitCue();
    }
    cancelReconnect();
    releaseCapture();
    // Before the socket goes: a sentence still open in the segmenter is delivered as its
    // own `segment_end` and only then is the session closed, so Ending does not swallow
    // the last thing the user said. Capture has already stopped, so no frame can arrive
    // between the flush and the close.
    flushSegments();
    // THE CLOSE TRACE ON A DELIBERATE EXIT (this task). `onclose` returns early for a socket this
    // function replaced, so an Exit — the one way a person leaves with words still unshown — left no
    // trace at all: leaving the mode dropped the caption rows off the screen and nothing said how
    // much of what was just said never got there. Counted at the same moment `onclose` counts at, and
    // by the same rule, so a close the SERVER reported and an Exit report the same number: the
    // utterances no shown delivery took over, plus the segments handed to the relay that produced no
    // caption. Read before `seqRef` and `socketRef` are cleared below.
    if (live) {
      const unshown = countUnshownUtterances(
        captionsRef.current,
        deliveriesRef.current,
        contextMessagesRef.current,
        seqRef.current,
      );
      if (unshown > 0) {
        voiceLog(`exit with ${unshown} unshown utterance(s): leaving does not deliver them`);
      }
      setClosedUnshown(unshown);
      // The connection's segment verdicts go with it: a seq belongs to the socket that numbered it,
      // and a deadline left armed past the close would wake up to mark a session that is gone.
      resetSegmentVerdicts();
    }
    mutedRef.current = false;
    // The capture this reading described is being released with the connection; the next one starts
    // over and reports its own first frame.
    captureReadyRef.current = false;
    setCaptureReady(false);
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
    setHeardNotForwarded(false);
    // The connection that reported a depth, a byte total or a refusal is going away, so all three
    // readings go with it: a bar left showing "3 waiting" over a dead socket would be reporting a
    // queue nobody holds.
    setQueuedDepth(0);
    setQueuedBytes(0);
    setPendingMessage('');
    setRefusal(null);
    setStopped(null);
    setUndelivered([]);
    // The narration playing (or being synthesized) belongs to the connection going away; a blob
    // URL left behind would keep the utterance audible after Exit.
    stopNarratorAudio();
    // A pack still waiting out its debounce has no socket left to reach: the connection is being
    // taken down here, and `onclose` returns early because `socketRef` is about to be cleared.
    clearContextResend();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'close' }));
      }
      socket.close();
    }
    setPhase('idle');
  }, [cancelReconnect, clearContextResend, flushSegments, releaseCapture, resetSegmentVerdicts, stopNarratorAudio]);

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
            // THE FIRST FRAME IS WHAT MAKES "LISTENING" TRUE. `state: open` is the upstream
            // session, not the microphone: capture is async, so the two are hundreds of ms apart
            // (longer on the first permission grant) and the page used to say `listening` across
            // that whole window. Recorded BEFORE the muted early-return below: frames keep arriving
            // while muted, and readiness is a fact about capture, not about sending.
            if (!captureReadyRef.current) {
              captureReadyRef.current = true;
              setCaptureReady(true);
              // The cue belongs to the microphone becoming live, not to the wire: capture is ready
              // before the handshake often enough that waiting for `open` made the cue lag the
              // first usable frame. Mute still outranks it — `unmute` rings then.
              if (!mutedRef.current) ringEnterCueOnce();
              // Promote only when the upstream is open and the person is not muted. If `open` has
              // not arrived yet, the open handler reads this ref and goes straight to `listening`;
              // if muted, `unmute` decides (it reads the same ref).
              if (socketOpenRef.current && !mutedRef.current) {
                setPhase((current) => (current === 'arming' ? 'listening' : current));
              }
            }
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
          // A capture that will not start is the microphone's failure, whatever the browser's own
          // wording: the person is told they cannot use the microphone, not the exception's text.
          fail(failure instanceof Error ? failure.message : String(failure), 'MIC_UNAVAILABLE');
          ringAttentionCueOnce();
        });
    },
    [fail, feedSegmented, ringAttentionCueOnce, ringEnterCueOnce],
  );

  /**
   * Opens the `/voice-realtime` socket and begins capture from `source`.
   * Shared by `start()` (the microphone) and `startWithFile()` (the
   * test-only uploaded-fixture path) — everything from here down is
   * audio-source-agnostic.
   */
  const connect = useCallback(
    (source: VoiceRealtimeAudioSource, options: { reconnectable: boolean; reconnect?: boolean }) => {
      const { sessionId, token } = latestRef.current;
      // A start the person asked for ends any reconnect still pending; a reconnect keeps counting.
      if (options.reconnect === true) {
        reconnectTimerRef.current = null;
      } else {
        cancelReconnect();
      }
      // Cue bookkeeping for the connection being opened. A start the person asked for begins a NEW
      // session: its entry cue has not sounded and the previous session's exit cue is spent. A
      // reconnect is the SAME session (so its entry cue stays spent) but a NEW connection (so a loss
      // of this wire is news again).
      if (options.reconnect !== true) {
        sessionStartedRef.current = false;
        enterCuedRef.current = false;
      }
      attentionCuedRef.current = false;
      reconnectableRef.current = options.reconnectable;
      serverEndedRef.current = false;
      // Starting while a connection exists REPLACES it. Leaving the old socket open
      // left two upstream sessions answering one microphone, and the old capture running.
      const previous = socketRef.current;
      if (previous || sourceRef.current) {
        voiceLog('start while connected: replacing the existing connection');
        socketRef.current = null;
        releaseCapture();
        previous?.close();
      }
      // A narration belongs to the connection that sent it; the new one has its own queue.
      stopNarratorAudio();
      if (!sessionId || !token) {
        // A failure here has no close to schedule the next attempt from, so a reconnect ends with it.
        cancelReconnect();
        setPhase('failed');
        // No code: the precondition is nobody's failure class, so the bar falls to the generic
        // sentence — which still tells the person the one thing that helps, "leave and come back".
        fail('Sign in and open a session before starting voice control.', null);
        ringAttentionCueOnce();
        return;
      }

      setError(null);
      setErrorCode(null);
      // Mute is the person's choice and outlives a network drop (live 2026-10-15: muted, dropped,
      // reconnected — and the microphone was live again). Only a start the person asked for clears it.
      if (options.reconnect !== true) {
        mutedRef.current = false;
      }
      // A new connection hears a new conversation: the previous run's captions
      // are not this one's, and carrying them over would attribute old speech to
      // a session that never heard it.
      captionsRef.current = [];
      attributedRef.current = new Set();
      priorDeliveryWindowRef.current = new Set();
      deliveriesRef.current = [];
      lateClaimRef.current.clear();
      setCaptions([]);
      setDeliveries([]);
      setDelivering(false);
      // The close trace describes the connection that ended; a new one has not closed on anything yet.
      setClosedUnshown(0);
      // A new connection is a new conversation: an unanswered turn from the previous one is not
      // this one's, and holding it would put the previous run's outcome over a live session.
      setUnansweredSeconds(null);
      // Same for a "heard, not forwarded" disposition: it named an utterance the previous
      // connection's model set aside, and the next connection has heard nothing yet.
      setHeardNotForwarded(false);
      // A new connection has told this page nothing yet: no messages waiting, no bytes, no refusal.
      setQueuedDepth(0);
      setQueuedBytes(0);
      setPendingMessage('');
      setRefusal(null);
      setUndelivered([]);
      voiceLog(`connecting to session ${sessionId}`);
      setDisconnected(false);
      // A fresh capture has reported nothing yet: the previous connection's suspension reading is
      // not this one's, so the waveform starts un-greyed.
      setMicSuspended(false);
      // A new connection starts a NEW capture (a reconnect replaces the source too), so readiness
      // starts over: the previous source's frames say nothing about this one. The bar re-enters
      // `arming` after `state: open` until this capture's first frame arrives.
      captureReadyRef.current = false;
      setCaptureReady(false);
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
      // The previous connection's segment verdicts and their deadlines are not this one's.
      resetSegmentVerdicts();
      resetSegmentation();
      // "Already sent" was a fact about the PREVIOUS socket: this connection has been told nothing,
      // so its `onopen` must put the pack on this wire even if the words are the same as before.
      clearContextResend();
      sentContextTextRef.current = null;

      let socket: WebSocket;
      try {
        socket = new WebSocket(voiceRealtimeSocketUrl(token, sessionId));
      } catch (failure) {
        cancelReconnect();
        setPhase('failed');
        // A WebSocket that will not construct never reached the server, so no frame carries a code
        // for it: the browser's own failure to open a connection is classed here as a socket error.
        fail(failure instanceof Error ? failure.message : String(failure), 'SOCKET_ERROR');
        ringAttentionCueOnce();
        return;
      }
      socketRef.current = socket;
      // From here the session has a connection to leave; `end()` may sound the exit cue.
      sessionStartedRef.current = true;

      /**
       * Answers the narrator queue's pacing ack for one narration.
       *
       * SOCKET-IDENTITY GUARDED: a clip that finishes after its connection was replaced must not
       * ack on the NEW socket, where that id belongs to no queue this page holds — the server would
       * ignore it, but sending it would claim a completion that never happened there.
       */
      const ackNarratorDone = (utteranceId: string): void => {
        if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(JSON.stringify({ type: 'narrator_done', utteranceId }));
        voiceLog(`narrator done ${utteranceId}`);
      };

      /**
       * Ends a streaming utterance exactly once: releases the context and sends the pacing ack.
       *
       * `acked` is the guard the criterion reads as "exactly one `narrator_done`": the `ended`
       * event and the `tts_done` frame can both arrive last (a long clip finishes after the stream
       * closed; a clipped one finishes before it), and only one of them may ack.
       */
      /**
       * Switches an in-flight utterance to the element path, silencing anything already scheduled.
       *
       * NOT `releaseNarratorStream`: the utterance is still arriving and `tts_done` must still be
       * able to play the assembled Blob, so the stream stays current (not `stopped`) and only its
       * scheduled audio is torn down.
       */
      const fallBackToElement = (stream: NarratorStream): void => {
        for (const source of stream.sources) {
          source.onended = null;
          try {
            source.stop();
          } catch {
            /* already ended */
          }
        }
        stream.sources.length = 0;
        stream.lastSource = null;
        stream.lastEnded = false;
        const context = stream.context;
        stream.context = null;
        if (context !== null) {
          try {
            void context.close();
          } catch {
            /* already closed */
          }
        }
        stream.fallback = true;
      };

      const finishNarratorStream = (stream: NarratorStream): void => {
        if (stream.acked || stream.stopped) return;
        stream.acked = true;
        if (narratorStreamRef.current === stream) narratorStreamRef.current = null;
        const context = stream.context;
        stream.context = null;
        if (context !== null) {
          try {
            void context.close();
          } catch {
            /* an already-closed context */
          }
        }
        ackNarratorDone(stream.utteranceId);
      };

      /**
       * Converts the whole-sample prefix of `bytes` into an `AudioBuffer` and schedules it.
       *
       * Slices are scheduled at `max(now, nextStartTime)` so they are contiguous even when a frame
       * arrives after the previous one finished playing: the play head never jumps backwards, and
       * an underrun resumes at the current time rather than replaying silence.
       */
      const scheduleNarratorPcm = (stream: NarratorStream, bytes: Uint8Array): void => {
        const context = stream.context;
        const header = stream.header;
        if (context === null || header === null || stream.stopped) return;
        stream.pending = concatNarratorBytes(stream.pending, bytes);
        const bytesPerSample = (header.bitsPerSample / 8) * header.channels;
        const frames = Math.floor(stream.pending.length / bytesPerSample);
        if (frames === 0) return;
        const usable = frames * bytesPerSample;
        const pcm = stream.pending.subarray(0, usable);
        stream.pending = stream.pending.subarray(usable);

        let buffer: AudioBuffer;
        try {
          buffer = context.createBuffer(header.channels, frames, header.sampleRate);
        } catch {
          // A context that cannot build a buffer is a playback failure, not an utterance failure:
          // the collected slices can still be played through the element path at `tts_done`.
          voiceLog(`narrator stream fallback ${stream.utteranceId}: createBuffer refused`);
          fallBackToElement(stream);
          return;
        }
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let channel = 0; channel < header.channels; channel += 1) {
          const data = buffer.getChannelData(channel);
          for (let index = 0; index < frames; index += 1) {
            const sample = view.getInt16((index * header.channels + channel) * 2, true);
            data[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
          }
        }

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const startAt = Math.max(context.currentTime, stream.nextStartTime);
        stream.nextStartTime = startAt + buffer.duration;
        source.onended = () => {
          if (source !== stream.lastSource) return;
          stream.lastEnded = true;
          // `tts_done` may already have arrived (the last slice was short) — then this is the ack.
          if (stream.done) finishNarratorStream(stream);
        };
        stream.sources.push(source);
        stream.lastSource = source;
        stream.lastEnded = false;
        try {
          source.start(startAt);
        } catch {
          /* a context closed under us has nothing left to schedule */
        }
        if (stream.sources.length === 1) {
          voiceLog(`narrator stream first source ${stream.utteranceId} at=${startAt.toFixed(3)}`);
        }
      };

      /**
       * Creates the playback context and starts scheduling the utterance's PCM.
       *
       * The header frame (`seq: 0`) is the trigger: its `dataStart` says where PCM begins, and the
       * remainder of that frame (non-empty only when an older producer sent a full 16 KiB slice) is
       * scheduled immediately. A `resume()` refused by the autoplay policy tears the sources back
       * down and sets `fallback`, so `tts_done` plays the assembled Blob as before.
       */
      const beginNarratorStream = (
        stream: NarratorStream,
        header: NarratorWavHeader,
        firstPcm: Uint8Array,
      ): void => {
        const Ctor = typeof AudioContext === 'undefined' ? undefined : AudioContext;
        if (stream.format !== 'wav' || typeof Ctor !== 'function') {
          voiceLog(`narrator stream fallback ${stream.utteranceId}: format=${stream.format} context=${typeof Ctor}`);
          stream.fallback = true;
          return;
        }
        let context: AudioContext;
        try {
          context = new Ctor();
        } catch (error) {
          voiceLog(
            `narrator stream fallback ${stream.utteranceId}: AudioContext threw ` +
              `${error instanceof Error ? error.name : String(error)}`,
          );
          stream.fallback = true;
          return;
        }
        stream.context = context;
        stream.header = header;
        stream.nextStartTime = 0;
        if (context.state === 'suspended') {
          void context.resume().catch((error: unknown) => {
            if (stream.stopped || stream.fallback) return;
            voiceLog(
              `narrator stream fallback ${stream.utteranceId}: resume rejected ` +
                `${error instanceof Error ? error.name : String(error)}`,
            );
            fallBackToElement(stream);
          });
        }
        if (firstPcm.length > 0) scheduleNarratorPcm(stream, firstPcm);
      };

      /** The stream state for one utterance; a frame for a new id replaces the previous one. */
      const ensureNarratorStream = (frame: Extract<ServerFrame, { type: 'tts_audio' }>): NarratorStream => {
        const existing = narratorStreamRef.current;
        if (existing !== null && existing.utteranceId === frame.utteranceId && !existing.stopped) {
          return existing;
        }
        if (existing !== null) releaseNarratorStream(existing);
        const stream: NarratorStream = {
          utteranceId: frame.utteranceId,
          format: frame.format,
          header: null,
          context: null,
          fallback: frame.format !== 'wav',
          pending: new Uint8Array(0),
          nextStartTime: 0,
          sources: [],
          lastSource: null,
          lastEnded: false,
          done: false,
          stopped: false,
          acked: false,
        };
        narratorStreamRef.current = stream;
        return stream;
      };

      /**
       * Feeds one `tts_audio` frame to the streaming scheduler.
       *
       * The slices are ALSO kept in {@link NarratorTtsBuffer} by the caller, because every reason to
       * fall back (no `AudioContext`, a refused resume, an unreadable header) is discovered while
       * the utterance is still arriving, and the element path needs the complete bytes.
       */
      const consumeNarratorAudioFrame = (frame: Extract<ServerFrame, { type: 'tts_audio' }>): void => {
        const stream = ensureNarratorStream(frame);
        if (stream.fallback || stream.stopped) return;
        const bytes = narratorBase64Bytes(frame.audio);
        if (bytes === null) {
          voiceLog(`narrator stream fallback ${frame.utteranceId}: slice ${frame.seq} is not base64`);
          stream.fallback = true;
          return;
        }
        if (frame.seq === 0 && stream.header === null) {
          const header = parseNarratorWavHeader(bytes);
          if (header === null) {
            voiceLog(`narrator stream fallback ${frame.utteranceId}: unreadable WAV header`);
            stream.fallback = true;
            return;
          }
          beginNarratorStream(stream, header, bytes.subarray(Math.min(header.dataStart, bytes.length)));
          return;
        }
        if (stream.header === null) {
          // A window that starts mid-utterance (or a producer that never sent the header) cannot be
          // scheduled; the element path still gets whatever slices exist and plays them at done.
          voiceLog(`narrator stream fallback ${frame.utteranceId}: first audio frame was seq ${frame.seq}`);
          stream.fallback = true;
          return;
        }
        scheduleNarratorPcm(stream, bytes);
      };

      /**
       * Handles `tts_done` for both playback paths.
       *
       * STREAMING: the frame only means "no more slices"; the ack waits for the last scheduled
       * source's `ended` (immediately when the clip already finished). ELEMENT: the old behaviour,
       * assembling the slices into one Blob and playing it.
       */
      const finishNarratorTts = (frame: Extract<ServerFrame, { type: 'tts_done' }>): void => {
        const stream = narratorStreamRef.current;
        if (
          stream !== null &&
          stream.utteranceId === frame.utteranceId &&
          stream.header !== null &&
          !stream.fallback &&
          !stream.stopped
        ) {
          // The scheduled audio IS the utterance; the collected slices are no longer needed.
          narratorTtsRef.current = null;
          stream.done = true;
          if (stream.sources.length === 0 || stream.lastEnded) finishNarratorStream(stream);
          return;
        }
        playNarratorTts(frame);
      };

      /**
       * Plays one narrator utterance after its last `tts_audio` slice (`tts_done`).
       *
       * THE SLICES ARE DECODED ONE BY ONE, not concatenated as base64 text: the server encodes each
       * raw byte slice independently, so a slice may end in `=` padding and joining the strings
       * would corrupt every slice after it. The byte total is compared with the frame's own
       * `bytes` reading — a stream that lost a slice is a reading the page reports, and the audio
       * it did receive is still played rather than swallowed whole.
       *
       * BOTH terminal media events ACK. `ended` is playback finishing; `error` (and a rejected
       * `play()`, e.g. no autoplay permission) is an utterance the element could not play. In
       * either case this narration is over, and leaving the server's queue without the ack would
       * hold every narration behind it for the life of the connection.
       */
      const playNarratorTts = (frame: Extract<ServerFrame, { type: 'tts_done' }>): void => {
        const buffer = narratorTtsRef.current;
        narratorTtsRef.current = null;
        if (buffer === null || buffer.utteranceId !== frame.utteranceId) {
          voiceLog(`tts done without bytes utterance=${frame.utteranceId}`);
          ackNarratorDone(frame.utteranceId);
          return;
        }

        const parts: Uint8Array[] = [];
        let total = 0;
        for (let seq = 0; seq < frame.frames; seq += 1) {
          const chunk = buffer.chunks.get(seq);
          if (chunk === undefined) {
            voiceLog(`tts missing seq=${seq} utterance=${frame.utteranceId} frames=${frame.frames}`);
            continue;
          }
          try {
            const raw = atob(chunk);
            const bytes = new Uint8Array(raw.length);
            for (let index = 0; index < raw.length; index += 1) {
              bytes[index] = raw.charCodeAt(index);
            }
            parts.push(bytes);
            total += bytes.length;
          } catch {
            voiceLog(`tts chunk not base64 seq=${seq} utterance=${frame.utteranceId}`);
          }
        }
        if (total !== frame.bytes) {
          voiceLog(
            `tts bytes deviation assembled=${total} declared=${frame.bytes} utterance=${frame.utteranceId}`,
          );
        }
        if (total === 0) {
          voiceLog(`tts done with no audio utterance=${frame.utteranceId}`);
          ackNarratorDone(frame.utteranceId);
          return;
        }

        const merged = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          merged.set(part, offset);
          offset += part.length;
        }
        const blob = new Blob([merged], { type: NARRATOR_TTS_MIME[buffer.format] ?? 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        // One narration at a time (the server paces on our ack), but a replacement can still race a
        // state edge; releasing the previous URL here keeps blob memory from accumulating.
        const previous = narratorPlayingRef.current;
        if (previous !== null) {
          URL.revokeObjectURL(previous.url);
        }
        narratorPlayingRef.current = { utteranceId: frame.utteranceId, url };

        const audio = narratorAudioRef.current ?? (narratorAudioRef.current = new Audio());
        const finish = (reason: string): void => {
          const playing = narratorPlayingRef.current;
          if (playing === null || playing.utteranceId !== frame.utteranceId) {
            return;
          }
          narratorPlayingRef.current = null;
          URL.revokeObjectURL(url);
          if (reason !== 'ended') {
            voiceLog(`narrator playback ${reason} utterance=${frame.utteranceId}`);
          }
          ackNarratorDone(frame.utteranceId);
        };
        audio.onended = () => finish('ended');
        audio.onerror = () => finish('error');
        audio.src = url;
        audio.load();
        const started = audio.play();
        if (started && typeof started.catch === 'function') {
          started.catch((error: unknown) => {
            finish(`rejected:${error instanceof Error ? error.name : String(error)}`);
          });
        }
      };

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
        // with nothing said yet sends no frame at all. Later changes to the conversation are
        // carried by the debounced resend effect, not by a second connection.
        sendContextPack(socket);
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
            // The VOICE connection is up again: a disconnect an earlier `state: closed` or a
            // `lost(connection-closed)` verdict reported is over, so the bar goes back to the phase.
            setDisconnected(false);
            // A reconnect that reached `open` is over, and the next drop starts its backoff afresh.
            reconnectAttemptRef.current = 0;
            setReconnecting(null);
            // The upstream being open is not the microphone being live: if the first captured frame
            // has not arrived yet, the bar says it is still starting the microphone (`arming`) until
            // it does. Mute still outranks the capture reading — a muted session stays `muted`
            // whether or not frames are flowing, and `unmute` promotes once they are. The entry cue
            // is not rung here: it already sounded when capture became ready (see `beginCapture`).
            setPhase(mutedRef.current ? 'muted' : captureReadyRef.current ? 'listening' : 'arming');
          } else if (frame.state === 'closed') {
            serverEndedRef.current = true;
            // The VOICE connection closed under a live mode. The page socket may still be open, so this
            // frame is the only sign the bar can read; reported as a disconnect (the bar says so and
            // offers Retry) rather than as a bare `idle`, which rendered as "Connecting…" over a
            // microphone that has nowhere left to send.
            setDisconnected(true);
            setPhase('idle');
            // The voice connection is gone under a live mode: the person must hear it without
            // looking, once per connection.
            ringAttentionCueOnce();
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
          // Which segment these words were spoken in. The proxy names it on every frame it can
          // attribute; when it cannot — the utterance's item was created by the endpoint's own
          // detector — the client falls back to its own numbering rather than leaving the sentence
          // unplaceable. See {@link unclaimedSegment}: the oldest segment no other utterance accounts
          // for, so the words land at their spoken place instead of under the answers that followed
          // them.
          const attributed = typeof frame.seq === 'number' && Number.isInteger(frame.seq) ? frame.seq : null;
          const text = said ? frame.text : current[index]!.text;
          const seq =
            attributed ??
            unclaimedSegment(
              current.filter((entry) => entry.itemId !== frame.itemId),
              seqRef.current,
            );
          // A transcript ARRIVED for the segment this utterance was spoken in, so that segment is
          // answered: its deadline stops, and a not-recognised line the deadline had already drawn is
          // retracted — its words take that line's place, at the same spoken position. A transcript
          // that belongs to no segment at all (`seq: null` with nothing left to claim it, i.e. a
          // connection that never committed one) answers for no segment.
          settleSegmentTranscript(seq);
          let next: VoiceRealtimeCaption[];
          if (index === -1) {
            next = [...current, { itemId: frame.itemId, text, final: frame.final, at: Date.now(), seq }];
          } else {
            next = current.slice();
            // `at` is carried over from the first sighting, not re-minted: the
            // row keeps the time the user started speaking to it. `seq` likewise — a frame that
            // reports none does not unlearn the segment the utterance was spoken in.
            next[index] = { ...next[index]!, text, final: frame.final, ...(seq === null ? {} : { seq }) };
          }
          // Spoken order, NOT arrival order: the endpoint answers its commits out of order, so an
          // appended array reads the person their own sentences shuffled. Stable, so captions that
          // belong to no segment keep the order they arrived in.
          next = sortCaptionsInSpokenOrder(next);
          captionsRef.current = next;
          setCaptions(next);
          // A FINAL caption the delivery on the wire already named (see `coveredThroughItemId` and
          // `lateClaimRef`): the transcription was slower than the `sent`, so nothing claimed it then.
          // It joins the delivery that answered its item NOW, by item id — never by "everything still
          // unclaimed", which would swallow words the model never relayed.
          if (frame.final) {
            const claimIndex = lateClaimRef.current.get(frame.itemId);
            const claimedDelivery = claimIndex === undefined ? undefined : deliveriesRef.current[claimIndex];
            if (claimIndex !== undefined && claimedDelivery !== undefined && !claimedDelivery.itemIds.includes(frame.itemId)) {
              lateClaimRef.current.delete(frame.itemId);
              attributedRef.current.add(frame.itemId);
              deliveriesRef.current = deliveriesRef.current.map((entry, position) =>
                position === claimIndex
                  ? { ...entry, itemIds: [...entry.itemIds, frame.itemId], heard: [...entry.heard, text] }
                  : entry,
              );
              setDeliveries(deliveriesRef.current);
              // A refusal had marked it undelivered when it was still nobody's; now it is delivered.
              setUndelivered((previous) => previous.filter((itemId) => itemId !== frame.itemId));
            }
          }
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
          // THE WINDOW THIS ACCEPTED DELIVERY ANSWERS, recorded BEFORE the `sent` (see
          // `VoiceRealtimeDelivery.inFlight`). Leaving the mode closes the socket at once while the
          // proxy is still holding this message; the `sent` that would claim it then has nowhere to
          // land, and the leave handed delivered words back to the composer. The window is the one
          // the `sent` handler would claim — the finished utterances no delivery has taken — so the
          // record is the same claim, made early enough to survive a leave in the gap. A `refused`
          // or an `error` withdraws it (those words never left).
          const accepted = captionsRef.current.filter(
            (caption) => caption.final && !attributedRef.current.has(caption.itemId),
          );
          if (accepted.length > 0 && !deliveriesRef.current.some((delivery) => delivery.inFlight === true)) {
            for (const caption of accepted) attributedRef.current.add(caption.itemId);
            deliveriesRef.current = [
              ...deliveriesRef.current,
              {
                message: '',
                at: Date.now(),
                heard: accepted.map((caption) => caption.text),
                itemIds: accepted.map((caption) => caption.itemId),
                queuedMessageUuid: null,
                inFlight: true,
              },
            ];
            setDeliveries(deliveriesRef.current);
          }
          return;
        }
        if (frame.type === 'queue_depth') {
          // Not `queued`: nothing new was accepted, so no delivery opens — only the reading moves.
          setQueuedDepth(typeof frame.depth === 'number' ? frame.depth : 0);
          setQueuedBytes(typeof frame.bytes === 'number' ? frame.bytes : 0);
          return;
        }
        if (frame.type === 'pending') {
          // THE ONE HELD MESSAGE (ruling 2026-10-14). The relay is holding the person's words while
          // the session is busy, and this frame is its running text. It is NOT the `queued` frame
          // above: that one's wait is the 1 s coalescing window (a delivery is already on its way),
          // this one's lasts as long as the run and ends with the WHOLE thing going in as one
          // message. Empty text is the CLEAR — the hold was delivered, or the connection is being
          // taken down — so the card comes down with it.
          setPendingMessage(typeof frame.text === 'string' ? frame.text : '');
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
          // The instruction was NOT accepted, so the early claim its opening `queued` frame made is
          // withdrawn FIRST: the words must read as nobody's again, and the per-utterance rows below
          // (which skip attributed captions) have to see them that way.
          releaseInFlightDelivery();
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
          setErrorCode(null);
          // The turn that was waiting has an answer: whatever the person said last reached the
          // session, so the "no answer" outcome (if any) is spent and the bar goes back to
          // reporting the phase alone.
          setUnansweredSeconds(null);
          // Same for the "heard, not forwarded" disposition: a delivery is words that DID reach
          // the session, so the notice that the previous turn's words did not is spent with it.
          setHeardNotForwarded(false);
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
          // THE WATERMARK DECIDES WHEN IT IS THERE, and it is what the shipping proxy sends. The
          // question a person is asking of a caption is not "did the model repeat my exact words" —
          // it never promised to — but "has this been handled". The endpoint moving its conversation
          // boundary is the answer: the model had every sentence up to it in front of it and chose
          // what to relay, so those sentences are DISPOSED OF — relayed, reworded, merged or dropped
          // on purpose — and folding them into the delivery's row is the truth, not a concession.
          // Leaving them pending is what drew bubbles that could never be dismissed and, on leaving
          // the mode, a composer draft made of sentences that had already gone.
          //
          // THE TEXT PATH SURVIVES ONLY AS A FALLBACK, for a frame from a relay that reports no
          // boundary (an older proxy, a stand-in): there the window rule applies, narrowed by the
          // literal match when the relay happened to repeat the words verbatim.
          const coveredThroughItemId = readCoveredThroughItemId(frame);
          const carried =
            coveredThroughItemId !== null
              ? claimThrough(pending, coveredThroughItemId)
              : relayed === ''
                ? []
                : matched.length > 0
                  ? matched
                  : thought;
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
          let deliveryIndex = -1;
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
              ...(coveredThroughItemId === null ? {} : { coveredThroughItemId }),
            };
            // THE `queued` WINDOW THIS CONFIRMS. The proxy told the page it had accepted an instruction
            // before it resolved the send; that early record is THIS delivery, so it is replaced rather
            // than duplicated, keeping the utterances it claimed — the claim was made from the same
            // pending window this frame's `carried` reads, and the frame adds whatever landed since.
            const inFlightIndex = deliveriesRef.current.findIndex((entry) => entry.inFlight === true);
            const confirmed =
              inFlightIndex === -1
                ? delivery
                : {
                    ...delivery,
                    itemIds: [...new Set([...deliveriesRef.current[inFlightIndex]!.itemIds, ...delivery.itemIds])],
                    heard: [...deliveriesRef.current[inFlightIndex]!.heard, ...delivery.heard],
                  };
            // Synchronous, so a close in the same tick as this `sent` still sees the delivery it just
            // recorded: `onclose` reads this ref, and a state update alone would not have landed yet.
            if (inFlightIndex === -1) {
              deliveriesRef.current = [...deliveriesRef.current, confirmed];
              deliveryIndex = deliveriesRef.current.length - 1;
            } else {
              deliveriesRef.current = deliveriesRef.current.map((entry, position) =>
                position === inFlightIndex ? confirmed : entry,
              );
              deliveryIndex = inFlightIndex;
            }
            setDeliveries(deliveriesRef.current);
            // THE ITEM THIS DELIVERY ANSWERED, WHOSE TRANSCRIPTION MAY STILL BE COMING. The endpoint
            // transcribes on its own, slower clock, so the caption for the boundary item can become
            // final AFTER this `sent` — the one case `carried` cannot reach (nothing was pending). The
            // item id is recorded here and the `caption` handler claims it when it arrives; a caption
            // that is already final on screen was carried above and needs no late claim.
            if (coveredThroughItemId !== null) {
              const onScreen = captionsRef.current.find((caption) => caption.itemId === coveredThroughItemId);
              if (onScreen === undefined || !onScreen.final) {
                lateClaimRef.current.set(coveredThroughItemId, deliveryIndex);
              }
            }
          }
          // This delivery closes the current speech window: every caption on screen NOW is the NEXT
          // delivery's "earlier window", so a later rewrite cannot reach back past this `sent`.
          priorDeliveryWindowRef.current = new Set(captionsRef.current.map((caption) => caption.itemId));
          onSentRef.current?.();
          return;
        }
        if (frame.type === 'segment_ack') {
          // The proxy's GRADED verdict on one segment (AC-366's vocabulary, consumed here by AC-367).
          // Four states, and the page keeps them apart rather than collapsing them into "no words":
          //
          //   - `committed` — the endpoint took the audio. Whether words come of it is still open, so
          //     the deadline armed at send keeps running; the segment is no longer UNCERTAIN, so a
          //     `written` outcome it carried goes.
          //   - `written` — UNCERTAIN: the segment's frames and its commit were written to an upstream
          //     socket that died before the endpoint answered. The bridge may still replay it, so the
          //     person reads "retrying this part", NEVER "not recognised".
          //   - `lost` — terminal, with a reason that says which failure it was: `connection-closed`
          //     (the voice connection was not open, so nothing was sent) or `upstream-drop` (the replay
          //     budget was spent and the words never reached the model).
          //   - `dropped` — the endpoint refused the commit, or reported no words for it: the one answer
          //     the page is owed without waiting, marked as not recognised NOW at the spoken place the
          //     words are missing from.
          if (frame.state === 'dropped') {
            clearTranscriptDeadline(frame.seq);
            clearSegmentOutcome(frame.seq);
            markSegmentUnrecognized(frame.seq, frame.reason ?? 'dropped');
          } else if (frame.state === 'committed') {
            clearSegmentOutcome(frame.seq);
          } else if (frame.state === 'written') {
            recordSegmentOutcome({ seq: frame.seq, state: 'written' });
          } else if (frame.state === 'lost') {
            // The server always names the reason; anything that is not the connection-closed verdict is
            // read as the words never reaching the model, the more conservative of the two readings.
            recordSegmentOutcome({
              seq: frame.seq,
              state: 'lost',
              reason: frame.reason === 'connection-closed' ? 'connection-closed' : 'upstream-drop',
            });
          }
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
        if (frame.type === 'heard_not_forwarded') {
          // The model heard the person and chose not to forward their words ("heard, not forwarded",
          // decision doc §12.6 B-8). Recorded as its own state, never as `error`: the utterance is
          // over and set aside, not lost, and the session is still listening — so the bar says the
          // words were heard and not passed on rather than flashing "Voice control stopped". Like
          // the `turn_unanswered` outcome it holds until a delivery closes the window.
          setHeardNotForwarded(true);
          voiceLog('heard-not-forwarded disposition');
          return;
        }
        if (frame.type === 'queue_reconcile') {
          // The host's own account of which of the person's delivered commands its queue still holds.
          // Kept as a set and folded onto the deliveries, so a `queued` row whose command the host no
          // longer reports is marked cleared even when its `command_lifecycle` terminal frame never
          // reached the browser — the 2026-10-14 defect. The per-row withdraw control the ruling
          // retired was its reader.
          const uuids = Array.isArray(frame.queuedMessageUuids)
            ? frame.queuedMessageUuids.filter((uuid): uuid is string => typeof uuid === 'string' && uuid !== '')
            : [];
          const held = new Set(uuids);
          queuePendingRef.current = held;
          // Re-annotate every delivery that has a uuid: membership is the whole reading, and a
          // delivery the reconcile does not name was already held (or is not addressable at all).
          const next = deliveriesRef.current.map((delivery) => {
            const uuid = delivery.queuedMessageUuid;
            if (typeof uuid !== 'string' || uuid === '') {
              return delivery;
            }
            return { ...delivery, queuePending: held.has(uuid) };
          });
          deliveriesRef.current = next;
          setDeliveries(next);
          voiceLog(`queue-reconcile held=${held.size}`);
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
        // ---- the narrator's speech (GOAL-047): text, then TTS audio, then the playback ack ------
        // The text frame is the sentence (display/fallback); the audio arrives behind it. These
        // branches must exist because the fall-through below treats any unrecognised frame as a
        // protocol failure — a deployment that runs the `announce` closing turn or a run-end
        // summary would otherwise fail the whole voice session the first time the narrator spoke.
        if (frame.type === 'narrator_speak') {
          voiceLog(`narrator speak ${frame.utteranceId} chars=${frame.text.length}`);
          return;
        }
        if (frame.type === 'run_output_request') {
          // The run-end summary's source: this run's OWN output, rendered at request time. The
          // reply is the only thing that crosses the wire — no pack, no cached snapshot.
          const text = buildVoiceRunOutput(contextMessagesRef.current);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'run_output', requestId: frame.requestId, text }));
            voiceLog(`run_output ${frame.requestId} chars=${text.length}`);
          }
          return;
        }
        if (frame.type === 'tts_audio') {
          // Slices are keyed by `seq`; a frame for a NEW utterance starts its own buffer, so a late
          // slice cannot be appended to the sentence that has already begun.
          const existing = narratorTtsRef.current;
          const buffer: NarratorTtsBuffer =
            existing !== null && existing.utteranceId === frame.utteranceId
              ? existing
              : {
                  utteranceId: frame.utteranceId,
                  format: frame.format,
                  sampleRate: frame.sampleRate,
                  chunks: new Map(),
                };
          buffer.chunks.set(frame.seq, frame.audio);
          narratorTtsRef.current = buffer;
          // Start playing NOW when the page can schedule PCM (the first frame is the WAV header);
          // otherwise this frame only feeds the Blob path that `tts_done` will play.
          consumeNarratorAudioFrame(frame);
          return;
        }
        if (frame.type === 'tts_done') {
          finishNarratorTts(frame);
          return;
        }
        if (frame.type === 'tts_error') {
          // A refusal is a DISPLAYED outcome, not a dead session: the rest of Live Voice is healthy,
          // and the queue stays paced because the ack below advances it. The bytes assembled so far
          // are dropped — a partial utterance is never played as if it were the sentence.
          voiceLog(`tts error ${frame.utteranceId} ${frame.code}: ${frame.message}`);
          stopNarratorAudio();
          fail(frame.message, frame.code);
          ackNarratorDone(frame.utteranceId);
          return;
        }
        if (frame.type === 'narrator_stop') {
          // The person spoke: cut playback and drop what was buffered. NO ack — the server has
          // already cleared the queue and will not wait for this id.
          voiceLog(`narrator stop ${frame.utteranceId} reason=${frame.reason ?? '-'}`);
          stopNarratorAudio();
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
        // The frame's own `code` is the classification — the server knows which class it is
        // reporting, and the bar must not guess it from the message text.
        //
        // The FIRST fatal frame wins. A transport that already named the failure
        // (MISSING_API_KEY / MASKED_API_KEY) also throws, and the bridge then reports
        // CONNECTION_FAILED for the same event — that second, vaguer frame must not overwrite the
        // specific code the person should act on. serverEndedRef marks "a fatal reason is already
        // on screen".
        if (serverEndedRef.current) {
          return;
        }
        serverEndedRef.current = true;
        // A fatal error ends the connection that was holding an accepted instruction, so the early
        // claim goes with it: nothing will deliver those words now, and the leave must offer them back.
        releaseInFlightDelivery();
        fail(frame.message, frame.code);
        setPhase('failed');
        // This is a connection-ending failure (a recoverable one returned above), so the person is
        // told by sound as well as by the failure sentence.
        ringAttentionCueOnce();
      };
      socket.onerror = () => {
        // A drop of a connection that will reconnect is not a failure: the close that follows
        // schedules the reconnect, and failing here would put "connection failed" over it.
        if (reconnectableRef.current && !serverEndedRef.current && (socketOpenRef.current || reconnectAttemptRef.current > 0)) {
          voiceLog('socket error (the close that follows reconnects)');
          return;
        }
        voiceLog('socket error');
        // The browser's socket error carries no code and no usable message of its own; the class
        // is recorded as a socket error and the sentence on the page is the connection one.
        fail('The voice connection failed.', 'SOCKET_ERROR');
        setPhase('failed');
        ringAttentionCueOnce();
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) {
          return;
        }
        voiceLog('socket closed by the server or network');
        // Read before the reset below: only a connection that had opened (or a reconnect attempt
        // already under way) was dropped rather than refused.
        const dropped =
          reconnectableRef.current &&
          !serverEndedRef.current &&
          (socketOpenRef.current || reconnectAttemptRef.current > 0);
        // P3 — the closing count, taken BEFORE anything below is cleared, because this is the last
        // moment the connection's own captions, deliveries and segment count are all readable.
        // Closing a socket under a live session could drop words that never reached the screen —
        // either as a final caption no shown delivery took over, or as a segment handed to the relay
        // that produced no caption at all — and the person was given no sign. `countUnshownUtterances`
        // asks the fold's own question (which utterances a VISIBLE delivery accounts for), so this
        // count and the row algebra agree on what "shown" means. The count is no longer DRAWN in the
        // conversation (operator's ruling, 2026-10-14) — it stays a reading, with this log line as the
        // client's own record of it.
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
        // A pack still waiting out its debounce belonged to this connection, and the socket it
        // would be written to is gone: the next connection starts its own debounce and its own
        // "already sent" record.
        clearContextResend();
        pendingFramesRef.current = [];
        socketOpenRef.current = false;
        segmentedRef.current = false;
        // A window the dead connection opened will never be closed by its `sent`.
        setDelivering(false);
        // Same for an unanswered turn: the connection that would have answered it is gone, and the
        // bar reads `disconnected` from here on rather than an outcome nothing can resolve.
        setUnansweredSeconds(null);
        // And the "heard, not forwarded" disposition: it belonged to the connection whose model
        // set the utterance aside, and the dead connection's reading must not outlive it.
        setHeardNotForwarded(false);
        // The refusal, the depth and the byte total belonged to that connection's queue; what the
        // next one holds is not known yet, so all read as empty rather than as the dead connection's
        // last reading.
        setQueuedDepth(0);
        setQueuedBytes(0);
        // The held message was the dead connection's, and the proxy delivers it on teardown — so this
        // page must take the card down rather than keep showing words that are already on their way.
        setPendingMessage('');
        setRefusal(null);
        // A stop belonged to the connection that carried it out; the next one starts with no stop.
        setStopped(null);
        // The segmenter holds the whole session's audio; a connection nobody is sending on
        // has no reason to keep it.
        resetSegmentation();
        // The dead connection's segment verdicts go with it, and so do their deadlines: nothing will
        // answer them now, and a timer left running would write state for a session that is over.
        resetSegmentVerdicts();
        releaseCapture();
        // The source this reading came from is released with the socket; a reconnect begins a new
        // capture and reports its own first frame (see `connect`).
        captureReadyRef.current = false;
        setCaptureReady(false);
        levelRef.current = 0;
        setDisconnected(true);
        // The capture that reported a suspension is being released with the socket, so the greyed
        // waveform does not outlive it.
        setMicSuspended(false);
        setConnectedAt(null);
        setPhase('idle');
        // The wire is gone whether or not a reconnect follows, and the person must hear that once
        // per connection. The guard also keeps this silent after `state: closed` already said it.
        ringAttentionCueOnce();
        if (!dropped) {
          return;
        }
        const attempt = reconnectAttemptRef.current + 1;
        if (attempt > VOICE_RECONNECT_DELAYS_MS.length) {
          voiceLog(`reconnect: gave up after ${VOICE_RECONNECT_DELAYS_MS.length} attempts`);
          reconnectAttemptRef.current = 0;
          setReconnecting(null);
          return;
        }
        const delay = VOICE_RECONNECT_DELAYS_MS[attempt - 1]!;
        reconnectAttemptRef.current = attempt;
        setReconnecting({ attempt, of: VOICE_RECONNECT_DELAYS_MS.length });
        voiceLog(`reconnect: attempt ${attempt}/${VOICE_RECONNECT_DELAYS_MS.length} in ${delay} ms`);
        reconnectTimerRef.current = setTimeout(() => {
          connectRef.current(microphoneAudioSource(), { reconnectable: true, reconnect: true });
        }, delay);
      };

      beginCapture(source);
    },
    [
      beginCapture,
      cancelReconnect,
      clearContextResend,
      clearSegmentOutcome,
      clearTranscriptDeadline,
      fail,
      feedSegmented,
      markSegmentUnrecognized,
      recordSegmentOutcome,
      releaseCapture,
      releaseInFlightDelivery,
      resetSegmentVerdicts,
      resetSegmentation,
      ringAttentionCueOnce,
      sendContextPack,
      settleSegmentTranscript,
      stopNarratorAudio,
    ],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // The narrator's media element is created on the FIRST TTS frame rather than here: the click that
  // starts Live Voice already grants this document sticky autoplay permission, so a later `play()`
  // is allowed, and an element nobody needs yet is one less thing a test environment must emulate.
  const start = useCallback(() => connect(microphoneAudioSource(), { reconnectable: true }), [connect]);

  const startWithFile = useCallback(
    (file: File, options?: PacedAudioSourceOptions) =>
      // The default (no `options`) is the microtask source AC-315's handshake guard depends on;
      // `options` is the explicit test seam onto the real-time paced source beside it.
      connect(options ? pacedFileAudioSource(file, options) : fileAudioSource(file), { reconnectable: false }),
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
    setPhase((current) => (current === 'listening' || current === 'arming' ? 'muted' : current));
  }, [flushSegments]);

  const unmute = useCallback(() => {
    mutedRef.current = false;
    // Capture readiness decides what unmuting means: Mute can be pressed while the microphone is
    // still arming, and unmuting then must NOT claim `listening` — the first frame may be the one
    // that arrives next. When frames are already flowing, this is the old `listening` behaviour —
    // and, when Mute had hidden the session's first `captureReady`, the second moment for the entry
    // cue (the first frame is the other one).
    if (captureReadyRef.current) ringEnterCueOnce();
    setPhase((current) => (current === 'muted' ? (captureReadyRef.current ? 'listening' : 'arming') : current));
  }, [ringEnterCueOnce]);

  // THE ONE DELIVERED-AWAITING-DEQUEUE CARD (AC5). A delivery the host has not dequeued yet has no row
  // of its own on the page, so its wait is drawn as a card — see {@link VoiceRealtimeSession.queuedDeliveryText}.
  // The NEWEST such delivery is the card (the most recent words waiting); derived from `deliveries`,
  // never a second state. Empty until a `queue_reconcile` names a delivery the host still holds.
  let queuedDeliveryText = '';
  for (let index = deliveries.length - 1; index >= 0; index -= 1) {
    const delivery = deliveries[index]!;
    if (delivery.queuePending === true) {
      queuedDeliveryText = delivery.message;
      break;
    }
  }

  return { phase, captureReady, error, errorCode, unansweredSeconds, heardNotForwarded, captions, deliveries, delivering, queuedDepth, queuedBytes, pendingMessage, queuedDeliveryText, refusal, undelivered, stopped, levelRef, connectedAt, disconnected, reconnecting, closedUnshown, unrecognizedSeqs, segmentOutcomes, micSuspended, start, startWithFile, mute, unmute, end };
}
