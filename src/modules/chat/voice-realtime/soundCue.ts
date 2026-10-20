/**
 * The three non-verbal cues that tell a person Live Voice started, ended, or lost its connection.
 *
 * WHY SOUND INSTEAD OF WORDS. Entering Live Voice used to print three transient words in turn —
 * connecting, starting the microphone, listening. None of them asks the person to do anything: the
 * microphone either comes up or it does not. Live Voice is meant to be usable without looking at the
 * screen, so those phases are silent now, and the one reading a person must notice without looking —
 * "the connection is gone" — gets a third, distinct sound rather than a fourth line of copy.
 *
 * SYNTHESIZED, NOT RECORDED. Each cue is a short sequence of `OscillatorNode` tones through a gain
 * envelope: no asset file, no fetch, and deliberately no shared path with the spoken narration — a
 * voice in the ear must always mean the model said something.
 *
 * CONSUMERS: `useVoiceRealtimeSession` plays the cues from its connection lifecycle, and
 * `ChatInterface` calls `primeVoiceCues()` inside the Live Voice tap — the user gesture browsers
 * require before this document may start audio.
 */

/** One note of a cue. Offsets and durations are in seconds. */
type CueTone = {
  /** Pitch, in Hz. */
  frequency: number;
  /** Seconds from the start of the cue. */
  at: number;
  /** Seconds the note sounds for, envelope included. */
  duration: number;
};

/** Quiet enough to sit under a meeting, loud enough to register on laptop speakers. */
const PEAK_GAIN = 0.05;

/** Rising pair: the microphone is live and the person can talk. */
const ENTER_TONES: readonly CueTone[] = [
  { frequency: 659.25, at: 0, duration: 0.09 },
  { frequency: 987.77, at: 0.1, duration: 0.12 },
];

/** Falling pair: the mirror of the enter cue, so leaving is heard as the inverse of arriving. */
const EXIT_TONES: readonly CueTone[] = [
  { frequency: 987.77, at: 0, duration: 0.09 },
  { frequency: 659.25, at: 0.1, duration: 0.12 },
];

/**
 * Three flat pulses: a different rhythm AND no pitch movement, so it cannot be mistaken for either
 * of the two-note cues even at low volume.
 */
const ATTENTION_TONES: readonly CueTone[] = [
  { frequency: 440, at: 0, duration: 0.07 },
  { frequency: 440, at: 0.12, duration: 0.07 },
  { frequency: 440, at: 0.24, duration: 0.1 },
];

/**
 * The one output context for every cue, created on first use.
 *
 * Module-level because a cue is a page-level enhancement, not a per-connection resource: recreating
 * the context per connection would exhaust the browser's small allowance and could not be resumed
 * by the tap that primed it.
 */
let sharedContext: AudioContext | null = null;

/** The browser's constructor, or `null` where WebAudio does not exist (jsdom, old browsers). */
function audioContextConstructor(): typeof AudioContext | null {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const ctor = scope.AudioContext ?? scope.webkitAudioContext;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * The shared context, or `null` when cues cannot be played here.
 *
 * An incomplete context is treated as absent rather than trusted: a test stand-in (e.g. a capture
 * fake installed by an e2e spec) may define `AudioContext` without the synthesis surface, and a cue
 * is an enhancement — it must never throw on the capture path it describes.
 */
function audioContext(): AudioContext | null {
  if (sharedContext !== null) return sharedContext;
  const Ctor = audioContextConstructor();
  if (Ctor === null) return null;
  let created: AudioContext;
  try {
    created = new Ctor();
  } catch {
    return null;
  }
  if (
    typeof created.createOscillator !== 'function' ||
    typeof created.createGain !== 'function' ||
    typeof created.currentTime !== 'number'
  ) {
    return null;
  }
  sharedContext = created;
  return created;
}

/**
 * Starts (or resumes) the audio context inside a user gesture.
 *
 * Browsers create a context suspended unless it is started from a gesture, and a cue missed for that
 * reason would be permanently silent. `ChatInterface` calls this synchronously in the Live Voice tap.
 */
export function primeVoiceCues(): void {
  const context = audioContext();
  if (context === null) return;
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
}

/** Schedules one cue on the shared context; every failure degrades to silence. */
function play(tones: readonly CueTone[]): void {
  const context = audioContext();
  if (context === null) return;
  try {
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const now = context.currentTime;
    for (const tone of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + tone.at;
      const end = start + tone.duration;
      // Triangle: softer than a square wave at the same level, and clearly not a voice.
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(tone.frequency, start);
      // A short attack and release, so no click rides on the note's edges.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.012);
      gain.gain.setValueAtTime(PEAK_GAIN, Math.max(start + 0.012, end - 0.025));
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end);
    }
  } catch {
    // A cue that cannot be synthesized says nothing about the session it describes.
  }
}

/** Rising two-note cue: the session's first capture is live (or unmuting made it live again). */
export function playVoiceEnterCue(): void {
  play(ENTER_TONES);
}

/** Falling two-note cue: the person ended the session after it had opened. */
export function playVoiceExitCue(): void {
  play(EXIT_TONES);
}

/** Three flat pulses: the connection dropped or failed, and what is said now is not heard. */
export function playVoiceAttentionCue(): void {
  play(ATTENTION_TONES);
}
