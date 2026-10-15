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
 *
 * WHY THE THRESHOLD FOLLOWS THE FLOOR. It was one constant, 250, and on 2026-10-16 that constant
 * produced two "The voice service heard you but has not answered for 8 s" banners in a 56-second
 * connection in which the relay's own silero uplink VAD found one speech frame in 2820. The
 * microphone's noise floor read a median of 86 RMS — not silence by the old calibration, but not
 * quiet either — and its non-speech peaks reached 1550, so runs of three frames cleared 250 and the
 * gate opened nine utterances the person never spoke. A frame is now voiced only if it clears BOTH
 * the constant (so a quiet microphone's calibration is untouched) and a multiple of the connection's
 * own measured floor (so a loud one is judged against itself). See
 * {@link LOCAL_SPEECH_FLOOR_FACTOR} for the measurement that fixes the multiple, and
 * {@link LOCAL_SPEECH_FLOOR_MIN_FRAMES} for why the opening seconds of a connection are read
 * conservatively.
 */

/**
 * The ABSOLUTE FLOOR of the voiced test: how loud a frame must be, in RMS over its PCM16 samples, for
 * the relative test below to be allowed to call it quiet.
 *
 * Chosen from a measurement rather than a guess: across the captured uplink of the 2026-10-12
 * session, silence reads an RMS of 1–26 and speech 400–640. 250 sits an order of magnitude above
 * the silence floor and well below the softest observed speech, which is the safe direction — a
 * frame of quiet speech that fails this test produces no boundary, so the watchdog stays unarmed
 * rather than firing on something the person never said.
 *
 * It is no longer the WHOLE test. It was, until the 2026-10-16 session below, and that is exactly
 * what broke: a constant calibrated on one microphone is not a reading of another one.
 */
export const LOCAL_SPEECH_RMS_THRESHOLD = 250;

/**
 * How many times its own noise floor a frame must clear to count as voiced: the effective threshold
 * is `max(LOCAL_SPEECH_RMS_THRESHOLD, LOCAL_SPEECH_FLOOR_FACTOR × floor)`.
 *
 * WHY A RATIO AND NOT A SECOND CONSTANT. Measured 2026-10-16 over two captured connections from the
 * same machine (`~/.cloudcli/voice-realtime-capture/`): one silent (quiet-frame median 86 RMS, loudest
 * frame 1550, and the relay's own silero uplink VAD called 1 of its 2820 frames speech), one with
 * speech in it (quiet-frame median 16, loudest frame 8636, 20 % of frames speech). The silent
 * connection's non-speech peaks sit at 18× its own floor; the speaking connection's speech sits at
 * 540× its. A single absolute constant cannot be both above 1550 and below the softest speech of a
 * quieter microphone, and the constant that was there — 250 — sat BELOW the silent connection's
 * peaks, so the gate opened nine utterances in a minute of silence and the watchdog banner fired
 * twice for a turn nobody took.
 *
 * 10 IS THE MIDDLE OF THE RANGE BOTH CONNECTIONS AGREE ON, not the edge of it. Replaying both
 * captures across the factor (with the warm-up default below): the silent one reaches zero boundaries
 * from 7 upward — at 6 it still opens one, at 4 it opens four — and the speaking one keeps its ten
 * boundaries, and every one of them the endpoint's own detector announced, up to 15; at 18 it loses
 * one of them. So the two measurements bound the factor at roughly 7…15, and 10 sits in the middle
 * of that with room on both sides: measured on the corpus rather than chosen to make one file come
 * out right. Below 7 the fixed constant 250 is doing all the work again, which is the defect itself.
 */
export const LOCAL_SPEECH_FLOOR_FACTOR = 10;

/**
 * How many of the most recent frames BELOW {@link LOCAL_SPEECH_RMS_THRESHOLD} the floor is read
 * from — 200 frames is 4 seconds of the connection's own silence.
 *
 * Only frames the absolute constant already calls silence are allowed to inform the floor: a window
 * that took whatever fell below the CURRENT threshold would feed itself (a louder floor raises the
 * threshold, which admits louder frames as "quiet", which raises the floor again) and the gate
 * would climb away from every voice in the connection. Bounded this way the estimate cannot exceed
 * `LOCAL_SPEECH_FLOOR_FACTOR × LOCAL_SPEECH_RMS_THRESHOLD`, so the gate's laziness has a ceiling.
 *
 * A connection whose every frame is louder than the constant — a genuinely loud room, not the one
 * this task measured — fills no window at all and keeps the constant's own reading. That is the
 * fail-safe direction twice over: no floor is invented for it, and the gate behaves exactly as it
 * did before this change.
 */
export const LOCAL_SPEECH_FLOOR_FRAMES = 200;

/**
 * How many quiet frames must exist before the floor is read as their MEDIAN — 120 frames is 2.4 s of
 * silence. Below it the floor is the window's maximum; see `noiseFloor` in
 * {@link createLocalSpeechGate}.
 *
 * WHAT THIS COSTS AND WHAT IT BUYS. A connection's first second of audio is usually not the room: the
 * 2026-10-16 silent capture's loudest non-speech sound arrives 0.4 s in, so a median over its first
 * twenty quiet frames reads ~48 — the beginning of that sound, not the microphone. With the maximum
 * standing in, that same opening is read against 10 × 233 = 2330 and closes nothing, and the median
 * only takes over once there is enough silence behind it to mean something.
 *
 * WHY 120 AND NOT 60. Replaying both captures across this dial: the silent one goes to zero
 * boundaries from 60 upward; the speaking one keeps its ten boundaries from 60 up to 200, and
 * fragments into fourteen at 220. The two ends disagree — 60 is the silent capture's edge and 200 the
 * speaking one's — so the default sits between them rather than on either. Below 60 the opening
 * sounds of the silent capture start coming back, which is the defect itself.
 *
 * The cost is bounded and named: inside the first 2.4 s of a connection an utterance has to clear the
 * maximum-based threshold to be reported at all. That is what the criterion's spoken case is placed
 * after, and the real speaking capture's 2.1 s utterance still clears it — as it should, since the
 * endpoint's own detector announced that one too.
 */
export const LOCAL_SPEECH_FLOOR_MIN_FRAMES = 120;

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
 *
 * Every knob is optional and every default is the shipped reading; the options exist so the
 * criterion can pin one dial at a time (`rmsThreshold` with the floor followed and not, the floor
 * followed with the entry run and without) rather than restating the algorithm in the test.
 */
export function createLocalSpeechGate(options: {
  rmsThreshold?: number;
  floorFactor?: number;
  floorFrames?: number;
  floorMinFrames?: number;
  enterFrames?: number;
  exitFrames?: number;
} = {}): LocalSpeechGate {
  const base = options.rmsThreshold ?? LOCAL_SPEECH_RMS_THRESHOLD;
  const floorFactor = options.floorFactor ?? LOCAL_SPEECH_FLOOR_FACTOR;
  const floorFrames = options.floorFrames ?? LOCAL_SPEECH_FLOOR_FRAMES;
  const floorMinFrames = options.floorMinFrames ?? LOCAL_SPEECH_FLOOR_MIN_FRAMES;
  const enterFrames = options.enterFrames ?? DEFAULT_ENTER_FRAMES;
  const exitFrames = options.exitFrames ?? DEFAULT_EXIT_FRAMES;

  let speaking = false;
  let voicedRun = 0;
  let quietRun = 0;
  /** The last `floorFrames` frame RMS values below `base`, oldest first — the floor's raw material. */
  const quietRms: number[] = [];

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

  /**
   * This connection's noise floor, or `null` while no quiet frame has been seen at all.
   *
   * Once {@link LOCAL_SPEECH_FLOOR_MIN_FRAMES} quiet frames exist it is their MEDIAN, not their mean:
   * a single loud frame that the absolute constant happens to admit into the window must not move the
   * reading the whole connection is judged by. Below that it is the window's MAXIMUM — the worst case
   * a median over so few frames could return, since a median can never exceed the largest member.
   * Reading the opening that way is what keeps a connection's first seconds honest: the window is
   * still filling with the sound that is being judged, so its median is a reading of that sound and
   * not of the room, while its maximum is already an upper bound on the room.
   */
  function noiseFloor(): number | null {
    if (quietRms.length === 0) {
      return null;
    }
    if (quietRms.length < floorMinFrames) {
      return Math.max(...quietRms);
    }
    const sorted = [...quietRms].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  return {
    observe: (audio: string): LocalSpeechBoundary | null => {
      const rms = frameRms(audio);
      if (rms === null) {
        return null;
      }
      if (rms < base) {
        quietRms.push(rms);
        if (quietRms.length > floorFrames) {
          quietRms.shift();
        }
      }
      const floor = noiseFloor();
      // No quiet frame yet — nothing has been measured, so the absolute constant alone decides. This
      // is the one state in which the relative test has nothing to say; every other state gives it at
      // least the worst case its own estimator could return, so the gate can only get looser.
      if (rms >= Math.max(base, floorFactor * (floor ?? 0))) {
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
