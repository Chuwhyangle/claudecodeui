/**
 * The local speech gate: a boundary reading of the person's own audio that does not depend on the
 * upstream saying anything.
 *
 * WHY THIS FILE EXISTS. The relay's stall watchdog is armed by `awaitingTranscription`, which is set
 * in exactly ONE place: the endpoint's `input_audio_buffer.speech_started`. Measured 2026-10-12, the
 * upstream of an operator's Live Voice session emitted NOTHING AT ALL for 118.4 seconds — no
 * `speech_started`, no `speech_stopped`, no `committed` — while the browser side proved audio
 * arrived steadily and in real time. Because the timer could only be armed by the party that had
 * gone silent, the longest upstream silence on record produced zero errors and zero status: the
 * person's words went nowhere and the screen said nothing. The watchdog's arming condition is
 * therefore not "the upstream announced speech" but "the person SPOKE", and that reading has to
 * come from our own side of the wire.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS THE ASSERTION THAT MATTERS:
 *
 *  - AC1: a burst of loud frames followed by quiet frames reports exactly one `started` then one
 *    `ended`, and quiet audio reports neither. The watchdog needs BOUNDARIES, not a level: arming
 *    on "speech is present" would fire mid-sentence, and arming on a level that never falls would
 *    never fire at all.
 *  - AC2 (negative control): ONE loud frame surrounded by silence reports nothing. This is the
 *    assertion that keeps the watchdog honest — a single click, a keystroke or a door would
 *    otherwise arm an 8-second timer during ordinary silence and produce a spurious "No answer —
 *    say it again" for a turn nobody spoke.
 *  - AC3: utterances do not stick. A second burst reports its own pair, so a session's tenth
 *    sentence arms the watchdog as reliably as its first.
 *  - AC4 fail-open: a malformed or empty frame is ignored and never throws. The gate sits directly
 *    under the browser's socket handler, so a throw here would escape an EventEmitter and take the
 *    process down — the exact failure mode this relay has already suffered once.
 *
 * AND THE CASES THAT CAME LATER, once a real connection proved the constant wrong (2026-10-16):
 *
 *  - a noisy microphone's non-speech spikes (RMS ~860 over a 116 floor, 56 s) open NOTHING. This is
 *    the negative control for the FLOOR-FOLLOWING threshold rather than for the entry run: the
 *    entries here are short, so only a threshold that moves with the microphone can reject them.
 *  - the same microphone's SUSTAINED non-speech peaks — 3–8 frames, the shape the real capture has
 *    and the 1–2 frame spikes above do not — open nothing either. The two cases are not duplicates:
 *    the short spikes are already rejected by the entry run on the constant, while these fire on the
 *    rule this module actually shipped, which is what the real connection did. Each case first runs
 *    its fixture through the gate that must open it — the false form for the spikes, the shipped
 *    rule for the sustained peaks — so neither can go quietly vacuous if the fixture is edited.
 *  - speech on that same noisy floor still opens exactly one boundary per utterance, and the span it
 *    describes lines up with the utterance to within 200 ms. A gate that rejects noise by rejecting
 *    everything is not a fix.
 *  - a quiet microphone keeps the calibration the module was built on: 400–640 RMS speech (the
 *    softest this module was ever calibrated against) over a 1–26 floor still opens — including at
 *    the corner where that floor is 26, which is the tightest this rule ever gets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalSpeechGate,
  DEFAULT_EXIT_FRAMES,
  DEFAULT_ENTER_FRAMES,
  LOCAL_SPEECH_FLOOR_FACTOR,
  LOCAL_SPEECH_RMS_THRESHOLD,
} from '../voice-realtime-local-speech.js';

/** One 20 ms frame of 16 kHz mono PCM16 at the given amplitude, base64 — what the browser sends. */
function frame(amplitude: number): string {
  const samples = 320;
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(amplitude, i * 2);
  return buffer.toString('base64');
}

/** Feeds a run of frames and returns the boundary events in order. */
function feed(gate: { observe: (audio: string) => string | null }, amplitude: number, count: number): string[] {
  const events: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const event = gate.observe(frame(amplitude));
    if (event !== null) events.push(event);
  }
  return events;
}

const SILENT = 0;
const SPEECH = 3000;

test('AC1: a spoken burst reports one started then one ended; quiet audio reports neither', () => {
  const gate = createLocalSpeechGate();

  assert.deepEqual(feed(gate, SILENT, 25), [], 'silence must never open an utterance');
  assert.deepEqual(feed(gate, SPEECH, 25), ['started']);
  assert.deepEqual(feed(gate, SILENT, 50), ['ended']);
  assert.deepEqual(feed(gate, SILENT, 25), [], 'a closed utterance must not re-report');
});

test('AC2 (negative control): one loud frame in silence reports nothing', () => {
  const gate = createLocalSpeechGate();

  feed(gate, SILENT, 25);
  assert.deepEqual(feed(gate, SPEECH, 1), [], 'a single click must not arm the watchdog');
  assert.deepEqual(feed(gate, SILENT, 50), []);
});

test('AC3: a later utterance reports its own pair — the gate does not stick', () => {
  const gate = createLocalSpeechGate();

  feed(gate, SPEECH, 25);
  feed(gate, SILENT, 50);
  assert.deepEqual(feed(gate, SPEECH, 25), ['started']);
  assert.deepEqual(feed(gate, SILENT, 50), ['ended']);
});

test('AC3: an utterance that never ends reports started once and never ended', () => {
  const gate = createLocalSpeechGate();

  assert.deepEqual(feed(gate, SPEECH, 25), ['started']);
  assert.deepEqual(feed(gate, SPEECH, 200), []);
});

test('AC4 fail-open: empty and malformed frames are ignored, and nothing throws', () => {
  const gate = createLocalSpeechGate();

  assert.equal(gate.observe(''), null);
  assert.equal(gate.observe('not base64 at all'), null);
  assert.equal(gate.observe(Buffer.alloc(3).toString('base64')), null);
  assert.deepEqual(feed(gate, SPEECH, 25), ['started'], 'a malformed frame must not disturb the state');
});

// ── the microphone that is not quiet: the 2026-10-16 connection, synthesized ─────────────────────
//
// The fixtures below are noise, not the constant-amplitude frames above, because the defect they
// pin came from a real one: on 2026-10-16 a 56.4 s connection with no speech in it produced two
// "The voice service heard you and has not answered for 8 s" banners, while the relay's own silero
// uplink VAD called 1 of its 2820 frames speech. The capture's quiet-frame median is 86 RMS and its
// non-speech peaks reach 1550, so runs of three frames cleared the constant 250 — nine times.
//
// Levels are named as RMS, because that is what the gate measures: uniform noise in [-p, p] has RMS
// p/√3, and {@link noiseFrame} does the conversion, so a fixture that says 116 is a fixture whose
// frames read 116.
//
// The streams are built from a seeded generator rather than Math.random so that a reading taken
// here is reproducible, and so a failure names a fixture someone else can rebuild.

const NOISY_FLOOR_RMS = 116;
const NOISY_SPIKE_RMS = 860;
const NOISY_SPEECH_RMS = 3000;

/**
 * What the relative test makes of this floor — the level a frame has to clear to count as voiced on
 * this microphone. The fixtures below are checked against it, so a fixture edited past it fails
 * loudly here instead of quietly asserting something else.
 */
const NOISY_FLOOR_THRESHOLD = LOCAL_SPEECH_FLOOR_FACTOR * NOISY_FLOOR_RMS;
/** 2800 frames is the 56.4 s of the connection this comes from. */
const NOISY_STREAM_FRAMES = 2800;

/** A seeded LCG in [0, 1) — enough for fixture noise, and identical on every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** One 20 ms frame of uniform noise at the given RMS, base64 — what a microphone actually sends. */
function noiseFrame(rms: number, next: () => number): string {
  const peak = rms * Math.sqrt(3);
  const buffer = Buffer.alloc(320 * 2);
  for (let i = 0; i < 320; i += 1) buffer.writeInt16LE(Math.round((next() * 2 - 1) * peak), i * 2);
  return buffer.toString('base64');
}

/** Every boundary a stream of whole frames closes, in order, with the frame that closed it. */
function observeFrames(
  gate: { observe: (audio: string) => string | null },
  frames: readonly string[],
): Array<{ frame: number; event: string }> {
  const events: Array<{ frame: number; event: string }> = [];
  frames.forEach((audio, frame) => {
    const event = gate.observe(audio);
    if (event !== null) events.push({ frame, event });
  });
  return events;
}

/**
 * THE FALSE FORM, exactly as this task names it: the threshold back to the fixed constant
 * (`floorFactor: 0` leaves `max(250, 0)` = 250) and no minimum voiced duration
 * (`enterFrames: 1`).
 *
 * Every fixture that asserts silence is first run through this, so none of them can pass by being
 * incapable of anything else. It is worth reading what the two dials do separately, because it is
 * not symmetric: the 1–2 frame spikes of the first case open nothing on the constant WITHOUT this
 * second dial (three frames is already a minimum duration), while the capture's own 3–8 frame
 * peaks open utterances on the constant either way. Both dials have to come off for the task's
 * first case to go red.
 */
function falseFormGate() {
  return createLocalSpeechGate({ floorFactor: 0, enterFrames: 1 });
}

test('a noisy floor: 56 s of 116-RMS noise with 1–2 frame spikes opens nothing', () => {
  const next = makeRandom(20261016);
  const frames: string[] = [];
  let spikes = 0;
  while (frames.length < NOISY_STREAM_FRAMES) {
    // Roughly a spike a second, the rate the capture shows.
    const gap = 40 + Math.floor(next() * 40);
    for (let i = 0; i < gap && frames.length < NOISY_STREAM_FRAMES; i += 1) {
      frames.push(noiseFrame(NOISY_FLOOR_RMS, next));
    }
    const width = next() < 0.5 ? 1 : 2;
    for (let i = 0; i < width && frames.length < NOISY_STREAM_FRAMES; i += 1) {
      spikes += 1;
      frames.push(noiseFrame(NOISY_SPIKE_RMS, next));
    }
  }

  assert.equal(frames.length, NOISY_STREAM_FRAMES);
  assert.ok(spikes > 40, `the fixture must actually contain spikes, found ${spikes}`);
  assert.ok(
    NOISY_SPIKE_RMS <= NOISY_FLOOR_THRESHOLD,
    `the spikes must be inside what the relative test rejects (${NOISY_SPIKE_RMS} vs ${NOISY_FLOOR_THRESHOLD})`,
  );

  // The fixture is capable of firing: on the constant threshold these spikes DO open utterances.
  // Without this the assertion below could be satisfied by a fixture with no signal in it at all.
  const constantEvents = observeFrames(falseFormGate(), frames).filter((e) => e.event === 'started');
  assert.ok(
    constantEvents.length > 0,
    'the spike fixture must open utterances in the false form, or it asserts nothing',
  );

  assert.deepEqual(
    observeFrames(createLocalSpeechGate(), frames),
    [],
    'spikes at 860 RMS over a 116 floor are not speech and must close no boundary',
  );
});

test('a noisy floor: the capture’s own shape — 3–8 frame non-speech peaks — opens nothing', () => {
  // The widths the 56 s capture actually has, read frame by frame: runs of 3, 4, 5, 6 and 8 frames
  // above the constant — not the 1–2 frame spikes of the case above, which the ENTRY RUN alone
  // already rejects. These fire on the shipped rule (250, three frames) exactly as the real
  // connection did, so this is the case that pins the threshold rather than the entry run.
  const next = makeRandom(20261017);
  const frames: string[] = [];
  const envelopes = [
    [300, 700, 860, 700, 400],
    [400, 800, 860, 600],
    [250, 500, 860, 860, 600, 400, 300],
    [350, 700, 860, 860, 860, 500, 350, 250],
  ];
  let bursts = 0;
  while (frames.length < NOISY_STREAM_FRAMES) {
    const gap = 200 + Math.floor(next() * 200);
    for (let i = 0; i < gap && frames.length < NOISY_STREAM_FRAMES; i += 1) {
      frames.push(noiseFrame(NOISY_FLOOR_RMS, next));
    }
    const envelope = envelopes[bursts % envelopes.length];
    bursts += 1;
    for (const rms of envelope) {
      if (frames.length >= NOISY_STREAM_FRAMES) break;
      frames.push(noiseFrame(rms, next));
    }
  }

  assert.ok(
    NOISY_SPIKE_RMS <= NOISY_FLOOR_THRESHOLD,
    `the peaks must be inside what the relative test rejects (${NOISY_SPIKE_RMS} vs ${NOISY_FLOOR_THRESHOLD})`,
  );

  // The shipped rule — the constant, the default entry run — OPENS utterances on this fixture. That
  // is the whole point of the case: a sustained non-speech peak is not rejected by a minimum
  // duration, and the real connection is what that costs.
  const shippedEvents = observeFrames(createLocalSpeechGate({ floorFactor: 0 }), frames).filter(
    (e) => e.event === 'started',
  );
  assert.ok(
    shippedEvents.length >= 4,
    `the sustained-peak fixture must open utterances on the shipped rule (opened ${shippedEvents.length})`,
  );

  assert.deepEqual(
    observeFrames(createLocalSpeechGate(), frames),
    [],
    'a non-speech peak of 860 RMS over a 116 floor is not speech, however many frames wide it is',
  );
});

test('a noisy floor: speech on it opens one boundary per utterance, aligned to the utterance', () => {
  const next = makeRandom(20261018);
  const noise = (): string => noiseFrame(NOISY_FLOOR_RMS, next);
  const frames: string[] = [];
  /** Where each spoken segment starts and ends, in frames — the truth the boundaries are read against. */
  const segments: Array<{ start: number; end: number }> = [];

  // 6 s of floor first: a connection has to have heard this microphone before it can judge it.
  for (let i = 0; i < 300; i += 1) frames.push(noise());
  for (let i = 0; i < 5; i += 1) {
    const start = frames.length;
    for (let j = 0; j < 50; j += 1) frames.push(noiseFrame(NOISY_SPEECH_RMS, next)); // 1.0 s
    const end = frames.length;
    segments.push({ start, end });
    for (let j = 0; j < 100; j += 1) frames.push(noise()); // 2.0 s of floor between utterances
  }

  assert.ok(
    NOISY_SPEECH_RMS > NOISY_FLOOR_THRESHOLD,
    `speech must clear the floor-following threshold (${NOISY_SPEECH_RMS} vs ${NOISY_FLOOR_THRESHOLD})`,
  );

  const events = observeFrames(createLocalSpeechGate(), frames);
  const starts = events.filter((e) => e.event === 'started');
  const ends = events.filter((e) => e.event === 'ended');

  assert.equal(starts.length, segments.length, `expected one boundary per utterance: ${JSON.stringify(events)}`);
  assert.equal(ends.length, segments.length, 'every opened utterance must close once');

  /**
   * An "ended" is REPORTED {@link DEFAULT_EXIT_FRAMES} after the audio went quiet — that is what the
   * exit run means, and 500 ms is by construction more than the 200 ms tolerance below. So the
   * alignment is asserted on the moment each boundary DESCRIBES: the start it reports, and the end
   * the exit run was counted from. Asserting on the reported frame instead would be asserting that
   * the exit run is shorter than it is.
   */
  segments.forEach((segment, i) => {
    const started = starts[i].frame;
    const describedEnd = ends[i].frame - DEFAULT_EXIT_FRAMES;
    assert.ok(
      started >= segment.start && started <= segment.start + 10,
      `utterance ${i}: started at frame ${started}, utterance began at ${segment.start} (>200 ms off)`,
    );
    assert.ok(
      describedEnd >= segment.end - 10 && describedEnd <= segment.end + 10,
      `utterance ${i}: ended describes frame ${describedEnd}, utterance ended at ${segment.end} (>200 ms off)`,
    );
  });
});

test('a quiet floor keeps its calibration: 400–640 RMS speech over a 1–26 floor still opens', () => {
  const next = makeRandom(20261019);
  const quiet = (rms: number): string => noiseFrame(rms, next);

  for (const floorRms of [10, 26]) {
    for (const speechRms of [400, 640]) {
      const frames: string[] = [];
      for (let i = 0; i < 200; i += 1) frames.push(quiet(floorRms));
      for (let i = 0; i < 50; i += 1) frames.push(quiet(speechRms));
      for (let i = 0; i < 100; i += 1) frames.push(quiet(floorRms));

      assert.ok(
        speechRms > Math.max(LOCAL_SPEECH_RMS_THRESHOLD, LOCAL_SPEECH_FLOOR_FACTOR * floorRms),
        `a ${speechRms} utterance must clear this floor's threshold, or the case asserts nothing`,
      );

      const events = observeFrames(createLocalSpeechGate(), frames);
      assert.deepEqual(
        events.map((e) => e.event),
        ['started', 'ended'],
        `a ${speechRms} RMS utterance over a ${floorRms} RMS floor must still open and close`,
      );
      assert.ok(
        events[0].frame >= 200 && events[0].frame <= 200 + DEFAULT_ENTER_FRAMES,
        `the boundary must land on the utterance, not on the floor (frame ${events[0].frame})`,
      );
    }
  }
});
