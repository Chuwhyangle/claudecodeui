/**
 * The local speech gate: where the person's utterance began and ended, read off our own side of
 * the wire.
 *
 * WHY THE RELAY NEEDS ITS OWN READING. In the continuous wire the endpoint's `server_vad` is the
 * only thing that endpoints speech, so every downstream decision — the stall watchdog included —
 * is armed by the party that can go silent. Measured 2026-10-12: 118.4 s of COMPLETE upstream
 * silence during which the person spoke ~28 s, and because the watchdog's arming flag is set only
 * by `input_audio_buffer.speech_started`, the longest silence on record produced no error, no
 * status and no answer. The audio that decides "did they speak?" is already in our hands, arriving
 * as the base64 PCM16 frames the transport forwards; this module is the cheap, honest reading of
 * it.
 *
 * WHY BOUNDARIES AND NOT A LEVEL. The watchdog wants one specific fact — "an utterance has just
 * finished and the upstream has said nothing about it". A level ("speech is present") cannot say
 * that: it is true mid-sentence, when a slow upstream is still perfectly healthy. Boundaries also
 * make the negative control expressible — see {@link DEFAULT_ENTER_FRAMES}.
 *
 * WHY IT IS DELIBERATELY COARSE. This is not a VAD and must not become one: the endpoint's own
 * detector still decides what the model hears, and a second, competing endpointing would be a
 * behavioural change disguised as instrumentation. It answers one question at one moment, and every
 * threshold here is a constant that can only make it fire LESS often than the truth, never more.
 */

/**
 * How loud a frame must be to count as voiced, as a root-mean-square over its PCM16 samples.
 *
 * Chosen from a measurement rather than a guess: across the captured uplink of the 2026-10-12
 * session, silence reads an RMS of 1–26 and speech 400–640. 250 sits an order of magnitude above
 * the silence floor and well below the softest observed speech, which is the safe direction — a
 * frame of quiet speech that fails this test produces no boundary, so the watchdog stays unarmed
 * rather than firing on something the person never said.
 */
export const LOCAL_SPEECH_RMS_THRESHOLD = 250;

/**
 * How many consecutive voiced frames open an utterance — 3 frames is 60 ms.
 *
 * THIS IS THE NEGATIVE CONTROL'S WHOLE MECHANISM. A single loud frame is a click, a keystroke, a
 * door; sustained sound is a voice. Without this, ordinary silence would arm an 8-second watchdog
 * and produce a "No answer — say it again" for a turn nobody spoke.
 */
export const DEFAULT_ENTER_FRAMES = 3;

/**
 * How many consecutive quiet frames close an utterance — 25 frames is 500 ms.
 *
 * Deliberately near the endpoint's own 400 ms silence cut, so a local boundary and the upstream's
 * agree about where a sentence ended; matching it exactly is not the point, and would be a claim
 * this module cannot support.
 */
export const DEFAULT_EXIT_FRAMES = 25;

/** One boundary this gate reports, or `null` for the frames in between. */
export type LocalSpeechBoundary = 'started' | 'ended';

/**
 * The per-connection gate. Stateful by necessity — a boundary is a transition — and cheap: one
 * base64 decode and one pass over 320 samples per 20 ms of audio.
 */
export type LocalSpeechGate = {
  /**
   * Feeds one frame and returns the boundary it closed, if any.
   *
   * A frame it cannot read (empty, not valid base64, not a whole number of PCM16 samples) is
   * ignored and returns `null` — never a throw. This runs directly under the browser's socket
   * handler, so an exception here would escape an EventEmitter and take the process down, which
   * this relay has already suffered once.
   */
  observe(audio: string): LocalSpeechBoundary | null;
};

/**
 * Builds one connection's gate.
 *
 * Consumers: `voice-realtime-ws-proxy.service.ts`, which feeds it every browser audio frame before
 * forwarding and hands the boundary to the bridge's watchdog, and this module's criterion.
 */
export function createLocalSpeechGate(options: {
  rmsThreshold?: number;
  enterFrames?: number;
  exitFrames?: number;
} = {}): LocalSpeechGate {
  const threshold = options.rmsThreshold ?? LOCAL_SPEECH_RMS_THRESHOLD;
  const enterFrames = options.enterFrames ?? DEFAULT_ENTER_FRAMES;
  const exitFrames = options.exitFrames ?? DEFAULT_EXIT_FRAMES;

  let speaking = false;
  let voicedRun = 0;
  let quietRun = 0;

  /** The frame's RMS over its PCM16 samples, or `null` when the frame is not readable audio. */
  function frameRms(audio: string): number | null {
    if (audio.length === 0 || audio.length % 4 !== 0) {
      return null;
    }
    const pcm = Buffer.from(audio, 'base64');
    if (pcm.length === 0 || pcm.length % 2 !== 0) {
      return null;
    }
    const samples = pcm.length / 2;
    let sumSquares = 0;
    for (let i = 0; i < samples; i += 1) {
      const sample = pcm.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
  }

  return {
    observe: (audio: string): LocalSpeechBoundary | null => {
      const rms = frameRms(audio);
      if (rms === null) {
        return null;
      }
      if (rms >= threshold) {
        voicedRun += 1;
        quietRun = 0;
        if (!speaking && voicedRun >= enterFrames) {
          speaking = true;
          return 'started';
        }
        return null;
      }
      quietRun += 1;
      voicedRun = 0;
      if (speaking && quietRun >= exitFrames) {
        speaking = false;
        quietRun = 0;
        return 'ended';
      }
      return null;
    },
  };
}
