import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import { useAuth } from '@/modules/auth';
import {
  fileAudioSource,
  microphoneAudioSource,
  type VoiceRealtimeAudioFrame,
  type VoiceRealtimeAudioSource,
} from '@/modules/chat/voice-realtime/audioSource';
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
  | { type: 'queued' }
  | { type: 'sent'; sessionId: string; result: unknown; message?: string }
  | { type: 'segment_ack'; seq: number; state: 'committed' | 'dropped'; reason?: string }
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
};

/** What the bar reads and drives. */
export type VoiceRealtimeSession = {
  /** The current phase; the bar renders its indicator from this. */
  phase: VoiceRealtimePhase;
  /** The last failure message, or `null`. */
  error: string | null;
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
   * Loudness of the most recent captured frame, 0..1 (0 while muted). A ref rather than state: it
   * changes every ~20ms, and the bar's waveform reads it from its own animation frame instead of
   * re-rendering the whole chat pane at the audio rate.
   */
  levelRef: MutableRefObject<number>;
  /** When this connection began, in epoch ms; `null` while none is open. Drives the bar's elapsed clock. */
  connectedAt: number | null;
  /** `true` after the server or network closed the socket under a live mode — the bar offers Retry. */
  disconnected: boolean;
  /** Opens the Realtime session and starts continuous microphone capture. */
  start: () => void;
  /**
   * Opens the Realtime session and replays an uploaded file through the same
   * pipeline `start()` feeds from the microphone — the test-only injection
   * path (AC-315/AC-316): no production UI calls this.
   */
  startWithFile: (file: File) => void;
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
  const levelRef = useRef(0);
  const [deliveries, setDeliveries] = useState<VoiceRealtimeDelivery[]>([]);
  // `true` while the proxy has accepted an instruction but not yet delivered it (AC-327). Set by
  // the `queued` frame, cleared by `sent` and on every connection boundary, so a row can never be
  // left reading "tidying up" after the connection that promised it has gone.
  const [delivering, setDelivering] = useState(false);
  // The captions as last committed, readable from a socket handler. A delivery needs to know which
  // finished utterances it carries, and state updaters cannot be read from outside.
  const captionsRef = useRef<VoiceRealtimeCaption[]>([]);
  const attributedRef = useRef<Set<string>>(new Set());

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
    // Dropping the queue here is deliberate: the session is ending, so a frame
    // still awaiting `open` has no proxy to reach and is not replayed.
    pendingFramesRef.current = [];
    socketOpenRef.current = false;
    segmentedRef.current = false;
    seqRef.current = 0;
    setDelivering(false);
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
        .start((frame) => {
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
        })
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
      setCaptions([]);
      setDeliveries([]);
      setDelivering(false);
      voiceLog(`connecting to session ${sessionId}`);
      setDisconnected(false);
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
          return;
        }
        if (frame.type === 'sent') {
          setError(null);
          setDelivering(false);
          // This delivery carries every finished utterance not already accounted for by an earlier one.
          const carried = captionsRef.current.filter((caption) => caption.final && !attributedRef.current.has(caption.itemId));
          for (const caption of carried) {
            attributedRef.current.add(caption.itemId);
          }
          if (typeof frame.message === 'string' && frame.message !== '') {
            const delivery: VoiceRealtimeDelivery = {
              message: frame.message,
              at: Date.now(),
              heard: carried.map((caption) => caption.text),
              itemIds: carried.map((caption) => caption.itemId),
            };
            setDeliveries((previous) => [...previous, delivery]);
          }
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
        setError(frame.message);
        // A recoverable error spoiled one model turn, not the connection: say so,
        // but keep the microphone and the socket alive.
        if (frame.recoverable !== true) {
          setPhase('failed');
        }
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
        socketRef.current = null;
        pendingFramesRef.current = [];
        socketOpenRef.current = false;
        segmentedRef.current = false;
        // A window the dead connection opened will never be closed by its `sent`.
        setDelivering(false);
        // The segmenter holds the whole session's audio; a connection nobody is sending on
        // has no reason to keep it.
        resetSegmentation();
        releaseCapture();
        levelRef.current = 0;
        setDisconnected(true);
        setConnectedAt(null);
        setPhase('idle');
      };

      beginCapture(source);
    },
    [beginCapture, feedSegmented, releaseCapture, resetSegmentation],
  );

  const start = useCallback(() => connect(microphoneAudioSource()), [connect]);

  const startWithFile = useCallback((file: File) => connect(fileAudioSource(file)), [connect]);

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

  return { phase, error, captions, deliveries, delivering, levelRef, connectedAt, disconnected, start, startWithFile, mute, unmute, end };
}
