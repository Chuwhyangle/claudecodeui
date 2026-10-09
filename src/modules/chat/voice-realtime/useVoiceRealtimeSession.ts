import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { fileAudioSource, microphoneAudioSource, type VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import { voiceRealtimeSocketUrl } from '@/shared/api';

/**
 * Where a voice turn is, as the control renders it.
 *
 * `listening` and `understanding` are the two states the criterion names: the
 * microphone is open against a live Realtime session, and a `session_send` the
 * model proposed is waiting for the user's edit and approval. `sending` covers
 * the gap between the approval frame and the server's `sent` acknowledgement, so
 * the send button cannot be pressed twice for one intent.
 */
export type VoiceRealtimePhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'understanding'
  | 'sending'
  | 'sent'
  | 'failed';

/** One outbound server frame (the protocol `/voice-realtime` answers with). */
type ServerFrame =
  | { type: 'state'; state: string }
  | { type: 'intent'; text: string }
  | { type: 'sent'; sessionId: string; result: unknown }
  | { type: 'error'; code: string; message: string };

/** What the control reads and drives. */
export type VoiceRealtimeSession = {
  /** The current phase; the control renders its indicator from this. */
  phase: VoiceRealtimePhase;
  /** The proposed intent text, editable by the user before it is sent. */
  intent: string;
  /** The last failure message, or `null`. */
  error: string | null;
  /** Replaces the intent text. The only correction mechanism — there is no confirm dialog. */
  setIntent: (text: string) => void;
  /** Opens the Realtime session and the microphone. */
  start: () => void;
  /**
   * Opens the Realtime session and replays an uploaded file through the same
   * pipeline `start()` feeds from the microphone — AC-315's fixed-corpus path,
   * the one CI drives with no microphone permission involved.
   */
  startWithFile: (file: File) => void;
  /** Releases the microphone (or the file decode) and closes the session. */
  stop: () => void;
  /** Approves the pending intent, sending the (possibly edited) text. */
  approve: () => void;
  /** Refuses the pending intent; nothing is sent to the session. */
  decline: () => void;
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
 * Owns one browser voice session: the `/voice-realtime` socket, the microphone
 * capture that feeds it, and the proposed-intent state the user edits.
 *
 * Consumed by `VoiceRealtimeControl` (this module's only UI). The transport
 * concern is deliberately here rather than in the control so the component
 * renders state and nothing else.
 *
 * `onSent` is called once the server acknowledges a `session_send`; the chat
 * interface uses it to re-read the transcript, because an MCP-source run writes
 * into history rather than into any live connection this page holds.
 */
export function useVoiceRealtimeSession({
  sessionId,
  onSent,
}: {
  sessionId: string | null;
  onSent?: (() => void) | undefined;
}): VoiceRealtimeSession {
  const { token } = useAuth();
  // The phase the control renders; driven by the wire above all.
  const [phase, setPhase] = useState<VoiceRealtimePhase>('idle');
  // The model's proposed instruction, editable in place. Held as state (not a
  // ref) because the textarea renders it and every keystroke must show.
  const [intent, setIntent] = useState('');
  // The last failure, kept so a closed session can explain itself after the
  // socket that carried the reason is gone.
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  // Holds whichever `VoiceRealtimeAudioSource` is active — the microphone or an
  // uploaded file — so `stop()` and the socket's own `onclose` can release it
  // without knowing which one it was.
  const sourceRef = useRef<VoiceRealtimeAudioSource | null>(null);
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

  const stop = useCallback(() => {
    releaseCapture();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'close' }));
      }
      socket.close();
    }
    setPhase('idle');
    setIntent('');
  }, [releaseCapture]);

  // `stop` is stable, so the cleanup runs once per mount. A page that navigates
  // away with the microphone open is the one state this must not leave behind.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(() => () => stopRef.current(), []);

  /**
   * Begins pulling frames from `source` and feeding them to the open socket as
   * PCM16 `audio` frames — the one pipeline the microphone and an uploaded file
   * both run through. A failure here (denied mic permission, a file that will
   * not decode) fails the session exactly as a socket failure would.
   */
  const beginCapture = useCallback((source: VoiceRealtimeAudioSource) => {
    sourceRef.current = source;
    void source.start((frame) => {
      const active = socketRef.current;
      if (!active || active.readyState !== WebSocket.OPEN) {
        return;
      }
      active.send(JSON.stringify({ type: 'audio', audio: encodePcm16Base64(frame.samples, frame.sourceRate) }));
    }).catch((failure) => {
      setPhase('failed');
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, []);

  /**
   * Opens the `/voice-realtime` socket and begins capture from `source`. Shared
   * by `start()` (the microphone) and `startWithFile()` (an uploaded fixture) —
   * everything from here down is audio-source-agnostic.
   */
  const connect = useCallback(
    (source: VoiceRealtimeAudioSource) => {
      if (!sessionId || !token) {
        setPhase('failed');
        setError('Sign in and open a session before starting voice control.');
        return;
      }

      setError(null);
      setIntent('');
      setPhase('connecting');

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
            setPhase('listening');
          } else if (frame.state === 'closed') {
            setPhase((current) => (current === 'sent' ? current : 'idle'));
          }
          return;
        }
        if (frame.type === 'intent') {
          setIntent(frame.text);
          setPhase('understanding');
          return;
        }
        if (frame.type === 'sent') {
          setPhase('sent');
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
        releaseCapture();
        setPhase((current) => (current === 'sent' ? current : 'idle'));
      };

      beginCapture(source);
    },
    [beginCapture, releaseCapture, sessionId, token],
  );

  const start = useCallback(() => connect(microphoneAudioSource()), [connect]);

  const startWithFile = useCallback((file: File) => connect(fileAudioSource(file)), [connect]);

  const decide = useCallback(
    (approved: boolean, message?: string) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: 'decision', approved, ...(message === undefined ? {} : { message }) }));
    },
    [],
  );

  const approve = useCallback(() => {
    setPhase('sending');
    decide(true, intent);
  }, [decide, intent]);

  const decline = useCallback(() => {
    decide(false);
    setIntent('');
    setPhase('listening');
  }, [decide]);

  return { phase, intent, error, setIntent, start, startWithFile, stop, approve, decline };
}
