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
import type { LiveSegment } from '@/modules/chat/utils/voice/voiceLiveSegmenter';

/** The protocol token the browser offers and the server must answer with to enable segmented relay. */
export const SEGMENTED_RELAY_PROTOCOL = 'segmented-v1';

/** The browser's opening offer: "I can send segmented relay, if you can receive it". */
export type VoiceRealtimeHelloFrame = { type: 'hello'; protocol: string };

/** The server's acceptance. Without it — or with another token — the connection stays continuous. */
export type VoiceRealtimeReadyFrame = { type: 'ready'; protocol?: string };

/**
 * The C2 ContextPack, as the browser hands it to the proxy: what the person could SEE SAID in this
 * conversation, so the Realtime session's instructions can carry it (SPEC §C2).
 *
 * It travels as text rather than as the rows it was built from, and that is the whole point: the
 * pack is built from the transcript's own visibility rules, which are a frontend concern, while the
 * proxy only has to know how much of it arrived. The three counts are what the proxy logs — never
 * the body, which is the person's conversation (`@/modules/chat/utils/voice`).
 */
export type VoiceRealtimeContextFrame = {
  type: 'context';
  /** The rendered pack: one `角色（时间）：文本` line per row, oldest first. */
  text: string;
  /** `text.length` in UTF-16 code units. */
  chars: number;
  /** How many conversation rows the pack carries. */
  rows: number;
};

/**
 * The server's GRADED verdict on one relay segment.
 *
 * Four names, and the page must not blur them (AC-366's vocabulary, consumed on the browser side by
 * AC-367):
 *
 *   - `written` — the segment's frames AND its commit were written to the upstream socket, which
 *     then died before the endpoint answered. UNCERTAIN, not lost: the bridge may still replay the
 *     segment, so its words may yet be transcribed. `written` ≠ `committed`.
 *   - `committed` — the endpoint took the audio (`input_audio_buffer.committed`). Whether words come
 *     of it is still open, so the client keeps waiting on the transcript.
 *   - `lost` — the segment will never be transcribed, and `reason` names the failure (never the same
 *     as "no words came of it"): `connection-closed` (the upstream socket was not open when the
 *     segment ended, so the frames were never written) or `upstream-drop` (the reconnect/replay
 *     budget was spent and the bridge gave up on ever learning the segment's words).
 *   - `dropped` — the proxy or the endpoint refused the commit, or reported no words for it; this is
 *     the page's not-recognised row, not a connection outcome.
 *
 * `reason` stays a loose string: `dropped` carries its own codes in it
 * (`commit-refused`, `empty-transcript`), so it cannot be the `lost` union alone.
 */
export type VoiceRealtimeSegmentAck = {
  type: 'segment_ack';
  seq: number;
  state: 'written' | 'committed' | 'lost' | 'dropped';
  reason?: string;
};

/** The offer to send the moment the socket opens. */
export function segmentedRelayOffer(): VoiceRealtimeHelloFrame {
  return { type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL };
}

/**
 * The `context` frame for one built pack, or `null` when the pack carries no rows.
 *
 * An empty pack is not sent rather than sent as `rows: 0`: a connection over a conversation with
 * nothing said yet has no context to hand over, and a frame that says so would only make the proxy
 * compose an injection with an empty body. The structural parameter keeps this module free of a
 * dependency on the pack builder — the wire vocabulary does not need to know how the pack is made.
 */
export function contextFrame(pack: { text: string; chars: number; rows: number }): VoiceRealtimeContextFrame | null {
  if (pack.rows <= 0 || pack.text === '') return null;
  return { type: 'context', text: pack.text, chars: pack.chars, rows: pack.rows };
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
