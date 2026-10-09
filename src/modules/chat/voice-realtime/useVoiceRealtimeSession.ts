import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { fileAudioSource, microphoneAudioSource, type VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import { voiceRealtimeSocketUrl } from '@/shared/api';

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

/** One outbound server frame (the protocol `/voice-realtime` answers with). */
type ServerFrame =
  | { type: 'state'; state: string }
  | { type: 'caption'; itemId: string; text: string; final: boolean }
  | { type: 'sent'; sessionId: string; result: unknown }
  | { type: 'error'; code: string; message: string };

/**
 * What the model heard, as the transcript renders it (AC-317).
 *
 * DISPLAY ONLY. This text exists so the user can see their own words; the model
 * itself receives the raw audio. Nothing in this module — or in anything that
 * consumes `captions` — may route it back as a `session_send` argument.
 *
 * One entry per spoken utterance, keyed by the endpoint's `itemId`: successive
 * captions for the same id REPLACE the text rather than appending, which is what
 * keeps an interim stream from rendering as a wall of duplicated bubbles.
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
}: {
  sessionId: string | null;
  onSent?: (() => void) | undefined;
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
  const pendingFramesRef = useRef<string[]>([]);
  // Whether the proxy has reported the upstream Realtime session `open`. Audio
  // is only forwarded from here on: `WebSocket.OPEN` alone is not enough, for
  // the reason above.
  const socketOpenRef = useRef(false);
  // `onSent` is read through a ref so a caller that passes an inline closure
  // does not resubscribe the socket handler on every render.
  const onSentRef = useRef(onSent);
  useEffect(() => {
    onSentRef.current = onSent;
  });

  /** Releases whichever audio source is active (the microphone, or a file decode). Safe to call twice. */
  const releaseCapture = useCallback(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    source?.stop();
  }, []);

  const end = useCallback(() => {
    releaseCapture();
    mutedRef.current = false;
    // Dropping the queue here is deliberate: the session is ending, so a frame
    // still awaiting `open` has no proxy to reach and is not replayed.
    pendingFramesRef.current = [];
    socketOpenRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'close' }));
      }
      socket.close();
    }
    setPhase('idle');
  }, [releaseCapture]);

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
  const beginCapture = useCallback((source: VoiceRealtimeAudioSource) => {
    sourceRef.current = source;
    void source.start((frame) => {
      // Mute drops the frame outright — it is never queued, or a burst captured
      // just before Mute would still reach the upstream after it (the criterion
      // reads Mute as "the upstream frame count stops growing").
      if (mutedRef.current) {
        return;
      }
      const audio = JSON.stringify({ type: 'audio', audio: encodePcm16Base64(frame.samples, frame.sourceRate) });
      const active = socketRef.current;
      if (active && active.readyState === WebSocket.OPEN && socketOpenRef.current) {
        active.send(audio);
        return;
      }
      // The socket is still connecting, or the proxy has not yet reported the
      // upstream session `open`: hold the frame and replay it in order once
      // `open` arrives, rather than dropping it into the handshake gap.
      pendingFramesRef.current.push(audio);
    }).catch((failure) => {
      setPhase('failed');
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, []);

  /**
   * Opens the `/voice-realtime` socket and begins capture from `source`.
   * Shared by `start()` (the microphone) and `startWithFile()` (the
   * test-only uploaded-fixture path) — everything from here down is
   * audio-source-agnostic.
   */
  const connect = useCallback(
    (source: VoiceRealtimeAudioSource) => {
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
      setCaptions([]);
      setPhase('connecting');
      // Each connection starts with an empty queue and an unopened upstream:
      // frames captured from here wait for this connection's own `state: open`.
      pendingFramesRef.current = [];
      socketOpenRef.current = false;

      let socket: WebSocket;
      try {
        socket = new WebSocket(voiceRealtimeSocketUrl(token, sessionId));
      } catch (failure) {
        setPhase('failed');
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      }
      socketRef.current = socket;

      socket.onmessage = (event: MessageEvent<string>) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data) as ServerFrame;
        } catch {
          return;
        }
        if (frame.type === 'state') {
          if (frame.state === 'open') {
            socketOpenRef.current = true;
            // The upstream session is up, so replay everything captured ahead
            // of it, in order, before any later frame is sent directly.
            const queued = pendingFramesRef.current;
            pendingFramesRef.current = [];
            for (const audio of queued) {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(audio);
              }
            }
            setPhase((current) => (current === 'muted' ? current : 'listening'));
          } else if (frame.state === 'closed') {
            setPhase('idle');
          }
          return;
        }
        if (frame.type === 'caption') {
          // Same `itemId` ⇒ same utterance ⇒ REPLACE, so an interim stream
          // updates one bubble instead of appending a new one per delta. A
          // `final` caption keeps its place in the order and simply stops
          // changing.
          setCaptions((current) => {
            const index = current.findIndex((entry) => entry.itemId === frame.itemId);
            if (index === -1) {
              return [...current, { itemId: frame.itemId, text: frame.text, final: frame.final, at: Date.now() }];
            }
            const next = current.slice();
            // `at` is carried over from the first sighting, not re-minted: the
            // row keeps the time the user started speaking to it.
            next[index] = { ...next[index]!, text: frame.text, final: frame.final };
            return next;
          });
          return;
        }
        if (frame.type === 'sent') {
          onSentRef.current?.();
          return;
        }
        setError(frame.message);
        setPhase('failed');
      };
      socket.onerror = () => {
        setError('The voice connection failed.');
        setPhase('failed');
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) {
          return;
        }
        socketRef.current = null;
        pendingFramesRef.current = [];
        socketOpenRef.current = false;
        releaseCapture();
        setPhase('idle');
      };

      beginCapture(source);
    },
    [beginCapture, releaseCapture, sessionId, token],
  );

  const start = useCallback(() => connect(microphoneAudioSource()), [connect]);

  const startWithFile = useCallback((file: File) => connect(fileAudioSource(file)), [connect]);

  const mute = useCallback(() => {
    mutedRef.current = true;
    // A frame queued during the handshake just before Mute must not be replayed
    // when `open` later arrives — the criterion reads Mute as "the upstream
    // frame count stops growing", and a replayed pre-Mute burst would move it.
    pendingFramesRef.current = [];
    setPhase((current) => (current === 'listening' ? 'muted' : current));
  }, []);

  const unmute = useCallback(() => {
    mutedRef.current = false;
    setPhase((current) => (current === 'muted' ? 'listening' : current));
  }, []);

  return { phase, error, captions, start, startWithFile, mute, unmute, end };
}
