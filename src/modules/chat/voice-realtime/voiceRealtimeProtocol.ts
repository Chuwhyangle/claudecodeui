/**
 * The segmented-relay wire vocabulary for `/voice-realtime` (GOAL-031, P1c).
 *
 * The browser OFFERS {@link SEGMENTED_RELAY_PROTOCOL} once the socket is open and only
 * switches to sentence-granular sending when the server answers with the same token. A
 * proxy that says nothing keeps receiving exactly the continuous frames it always got.
 * That asymmetry is the whole point of putting the offer here: segmented relay changes
 * what the upstream hears (silence stops being uploaded), so a client may not turn it on
 * by assuming a version — it has to be told, per connection, that the peer speaks it.
 *
 * Consumed by `useVoiceRealtimeSession` (the sender) and by
 * `tests/useVoiceRealtimeSession.segmented.test.tsx`, whose fake server is the declaring peer.
 */
import type { LiveSegment } from '@/modules/chat/utils/voiceLiveSegmenter';

/** The protocol token the browser offers and the server must answer with to enable segmented relay. */
export const SEGMENTED_RELAY_PROTOCOL = 'segmented-v1';

/** The browser's opening offer: "I can send segmented relay, if you can receive it". */
export type VoiceRealtimeHelloFrame = { type: 'hello'; protocol: string };

/** The server's acceptance. Without it — or with another token — the connection stays continuous. */
export type VoiceRealtimeReadyFrame = { type: 'ready'; protocol?: string };

/** The server's verdict on one segment; `dropped` means the proxy did not forward it upstream. */
export type VoiceRealtimeSegmentAck = {
  type: 'segment_ack';
  seq: number;
  state: 'committed' | 'dropped';
  reason?: string;
};

/** The offer to send the moment the socket opens. */
export function segmentedRelayOffer(): VoiceRealtimeHelloFrame {
  return { type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL };
}

/**
 * Whether one server frame declares segmented relay support for this connection.
 *
 * Accepted on a dedicated `ready` frame and on the `state` frame that already announces the
 * upstream session, so a proxy may declare the protocol either before or alongside it.
 */
export function declaresSegmentedRelay(frame: { type?: string; protocol?: string }): boolean {
  return frame.protocol === SEGMENTED_RELAY_PROTOCOL && (frame.type === 'ready' || frame.type === 'state');
}

/**
 * The WAV header `LiveSegmenter` always writes (RIFF/WAVE, one 16-byte `fmt ` chunk).
 *
 * The segment's payload is 16 kHz mono 16-bit PCM, which is exactly what an `audio` frame
 * carries on the continuous path — so the bytes past this header need no re-encoding, only
 * base64.
 */
const WAV_HEADER_BYTES = 44;

/** The base64 PCM16 payload of one segment: the `audio` field of its `audio` frame. */
export function wavPcm16Base64(wav: Uint8Array): string {
  const pcm = wav.subarray(WAV_HEADER_BYTES);
  let binary = '';
  for (let index = 0; index < pcm.length; index += 1) {
    binary += String.fromCharCode(pcm[index]!);
  }
  return btoa(binary);
}

/**
 * The three wire frames that carry one relay segment, serialized in send order:
 * `segment_start` (which opens `seq`), one `audio{seq}` (the whole segment, already at the
 * transport's rate) and `segment_end` (which lets the proxy commit it).
 *
 * One `audio` frame per segment: a relay segment is one sentence, and the proxy's own
 * accounting counts frames per `seq`, so a single frame is the honest shape for "this
 * segment's audio, all of it".
 */
export function segmentFrames(segment: LiveSegment, seq: number, startedAtMs: number): string[] {
  const durationMs = Math.round((segment.durationSec ?? segment.endSec - segment.startSec) * 1000);
  return [
    JSON.stringify({ type: 'segment_start', seq, startedAtMs }),
    JSON.stringify({ type: 'audio', seq, audio: wavPcm16Base64(segment.wav) }),
    JSON.stringify({ type: 'segment_end', seq, durationMs, reason: segment.reason ?? 'end' }),
  ];
}
