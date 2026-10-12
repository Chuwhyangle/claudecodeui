/**
 * Silence Tail Suppression (STS) — the continuous wire's upload state machine, read end to end.
 *
 * WHAT THIS FILE PINS. `voice-realtime-silence-tail.ts` decides, per browser frame, whether the frame
 * crosses the wire; `voice-realtime-ws-proxy.service.ts` hands it the continuous wire's frames and
 * forwards whatever it returns. The decision is a TRADE — audio that does not cross costs nothing and
 * can never be recovered — so every leg below is written against the one thing that must never happen
 * (a spoken frame withheld) and against the two appliances the rest of the relay depends on: an
 * endpoint whose turn still closes, and a pool that does not read a suppressed stretch as an idle one.
 *
 * THE CORPUS. One PCM16 square-wave generator serves every arm: a square wave's RMS and its peak are
 * both its amplitude, so a single number says what each detector gates on — the gate reads RMS
 * (`voice-realtime-silence-tail.ts`), the scripted endpoint reads peak
 * (`voice-realtime-scripted-upstream.ts`), and the proxy's local speech gate reads RMS against its own
 * measured 250 threshold. Room tone is RMS 12, the corpus's speech RMS 500, and one AC3 arm adds RMS 90
 * speech — quiet, but above the loudest threshold this module can ever hold: the clamp's ceiling is
 * -60 dBFS ≈ RMS 33, and the floor-derived threshold saturates at it. Each frame carries a four-sample
 * marker, because S-2 asks whether THE frame that was spoken crossed the wire, not whether some frame of
 * the right amplitude did: without payload identity a count could hide the loss.
 *
 * THE GROUP ORDER IS AC1'S. The two false forms run FIRST, so the reading every later group leans on —
 * "these frames crossed the wire" — is shown to go red before it is used as the reason a later group is
 * green. The Plan's own wording: 取假形态排最前.
 *
 * WHAT IS, AND IS NOT, ASSERTED ABOUT THE TIME BASE (AC2, decision doc §10.3 V-1). V-1 measured the
 * real endpoint's silence clock on the AUDIO it received: 400 ms of real silence did not trigger
 * `speech_stopped`, 500 ms did, and a 700 ms digital-silence run triggered at 560 ms RECEIVED. Both
 * bases are run here — the stand-in makes the switch explicit precisely because V-1 was an open
 * question when it was written — and BOTH are read against the same bound. The audio-time base is the
 * one this criterion requires; the wall-clock base is the contrast.
 *
 * Consumers: the quay worker's AC state for `gap-live-voice-silence-tail-suppression` (GOAL-044 / AC-364).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  createSilenceTailGate,
  resolveSilenceTail,
  DEFAULT_SILENCE_TAIL_KEEPALIVE_MS,
  DEFAULT_SILENCE_TAIL_MS,
  DEFAULT_SILENCE_TAIL_PREROLL_MS,
  SILENCE_TAIL_ENTER_FRAMES,
  SILENCE_TAIL_ENV,
  SILENCE_TAIL_HANGOVER_MS,
  SILENCE_TAIL_KEEPALIVE_FRAME_MS,
  SILENCE_TAIL_KEEPALIVE_MS_ENV,
  SILENCE_TAIL_MS_ENV,
  SILENCE_TAIL_PREROLL_MS_ENV,
  type SilenceTailDecision,
  type SilenceTailGate,
  type SilenceTailOptions,
} from '../voice-realtime-silence-tail.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import type { RealtimeToolExecutor, UpstreamPoolRotation } from '../index.js';

import { createScriptedVad, type ScriptedVadTimeBase } from './voice-realtime-scripted-upstream.js';
import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── the corpus ────────────────────────────────────────────────────────────────────────────────────

/** The rate every frame here is built at, matching the browser capture's own. */
const SAMPLE_RATE = 16_000;
/** One audio frame — the browser's relay cadence, and what the gate's per-frame counters assume. */
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1_000;

/** Room tone. Below every threshold either detector can hold, and above digital silence. */
const SILENCE_RMS = 12;
/** The corpus's speech — 32 dB above the room tone, and above the local gate's measured 250. */
const SPEECH_RMS = 500;
/** AC3's 低音量语料: quiet, but still above the loudest threshold the gate can hold. */
const LOW_VOLUME_RMS = 90;
/** A broadband-ish noise stand-in: above the gate's ceiling, so it is a COST misjudgement, not a loss. */
const NOISE_RMS = 60;

/** How many samples carry a frame's identity, and how many values each of them takes. */
const MARKER_SAMPLES = 4;
const MARKER_STRIDE = 8;

/**
 * One PCM16 frame as a square wave at `amplitude`, with `index` written into it.
 *
 * The marker rides the first four samples and moves them by 1..8 — never by more than the +8 dB the
 * gate's own voice margin already allows for, and never by enough to change which side of a threshold
 * the frame is on (room tone peak 12 → 20 against the endpoint's 164 and the gate's ~30). A frame built
 * with no index is marker-free; an indexed frame is never equal to it, because every marker step ≥ 1.
 */
function pcmFrame(amplitude: number, index = -1): string {
  const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
    pcm.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  if (index >= 0) {
    for (let slot = 0; slot < MARKER_SAMPLES; slot += 1) {
      const step = (Math.floor(index / MARKER_STRIDE ** slot) % MARKER_STRIDE) + 1;
      pcm.writeInt16LE((slot % 2 === 0 ? 1 : -1) * (amplitude + step), slot * 2);
    }
  }
  return pcm.toString('base64');
}

/** The `ms`-long digital-silence payload the gate's keepalive uses, rebuilt here so it can be named. */
function digitalSilenceOf(ms: number): string {
  return Buffer.alloc(Math.max(1, Math.round((SAMPLE_RATE * ms) / 1_000)) * 2).toString('base64');
}

/** One unmarked room-tone frame, for the long feeds where identity says nothing. */
const SILENCE_FRAME = pcmFrame(SILENCE_RMS);
/** Digital silence — what the AC1 false form's tail substitutes for the microphone's own noise. */
const DIGITAL_SILENCE_FRAME = pcmFrame(0);
/** What the gate puts on the wire to hold a long suppression open. */
const KEEPALIVE_FRAME = digitalSilenceOf(SILENCE_TAIL_KEEPALIVE_FRAME_MS);

/** One stretch of one corpus: how long it lasts, and what it is made of. */
type Segment = { kind: 'silence' | 'speech' | 'noise'; ms: number; rms?: number };

/** One built frame, with the timeline position it occupies. `index` is its identity, not its time. */
type CorpusFrame = { index: number; audio: string; startMs: number; endMs: number; speech: boolean };

/** Turns a plan into frames. Every frame's payload is unique (see {@link pcmFrame}). */
function timeline(plan: readonly Segment[]): CorpusFrame[] {
  const frames: CorpusFrame[] = [];
  let atMs = 0;
  for (const segment of plan) {
    for (let n = 0; n < Math.round(segment.ms / FRAME_MS); n += 1) {
      const speech = segment.kind === 'speech';
      const amplitude = segment.rms ?? (speech ? SPEECH_RMS : segment.kind === 'noise' ? NOISE_RMS : SILENCE_RMS);
      frames.push({
        index: frames.length,
        audio: pcmFrame(amplitude, frames.length),
        startMs: atMs,
        endMs: atMs + FRAME_MS,
        speech,
      });
      atMs += FRAME_MS;
    }
  }
  return frames;
}

/**
 * The AC-363 V-3 corpus shape — 底噪 500 ms + 一句 + 底噪 4000 ms + 同一句 + 底噪 2000 ms.
 *
 * The leading room tone is what makes the FIRST utterance's window testable at all, and the 4000 ms gap
 * is what makes the SECOND one a resume: the first suppression episode opens inside it.
 */
const CORPUS: readonly Segment[] = [
  { kind: 'silence', ms: 500 },
  { kind: 'speech', ms: 600 },
  { kind: 'silence', ms: 4_000 },
  { kind: 'speech', ms: 600 },
  { kind: 'silence', ms: 2_000 },
];

/** Five utterances, so AC2's p50 has more than one reading to sit on. */
const TWO_ARM_PLAN: readonly Segment[] = [
  { kind: 'silence', ms: 500 },
  ...Array.from({ length: 5 }, () => [
    { kind: 'speech', ms: 600 } as Segment,
    { kind: 'silence', ms: 4_000 } as Segment,
  ]).flat(),
  { kind: 'silence', ms: 2_000 },
];

/** The switch's own settings for every arm that wants STS on: `T` and `P` at their shipping defaults. */
const ON: SilenceTailOptions = {
  tailMs: DEFAULT_SILENCE_TAIL_MS,
  prerollMs: DEFAULT_SILENCE_TAIL_PREROLL_MS,
  keepaliveMs: 0,
};

/** `P` and `T`'s own frame counts, so a leg can talk about the ring without re-deriving them. */
const PREROLL_FRAMES = DEFAULT_SILENCE_TAIL_PREROLL_MS / FRAME_MS;
const TAIL_FRAMES = DEFAULT_SILENCE_TAIL_MS / FRAME_MS;

// ── the gate, run over a timeline ────────────────────────────────────────────────────────────────

/** One suppression episode, as the gate reported leaving and entering it. */
type Transition = {
  atIndex: number;
  event: 'suppressed' | 'resumed';
  suppressedMs: number;
  preRollFrames: number;
};

type Run = {
  /** Every payload that crossed the wire, in order. */
  wired: string[];
  /** One decision per input frame, so a leg can read the stage it was in. */
  decisions: SilenceTailDecision[];
  transitions: Transition[];
};

/** Feeds a whole timeline through one gate. `nowMs` is the keepalive's clock only. */
function runGate(
  gate: SilenceTailGate,
  frames: readonly CorpusFrame[],
  nowMs: (frame: CorpusFrame) => number = () => 0,
): Run {
  const wired: string[] = [];
  const decisions: SilenceTailDecision[] = [];
  const transitions: Transition[] = [];
  for (const frame of frames) {
    const decision = gate.observe(frame.audio, nowMs(frame));
    decisions.push(decision);
    wired.push(...decision.frames);
    if (decision.transition !== null) {
      transitions.push({
        atIndex: frame.index,
        event: decision.transition,
        suppressedMs: decision.suppressedMs,
        preRollFrames: decision.preRollFrames,
      });
    }
  }
  return { wired, decisions, transitions };
}

/**
 * S-2 (no word loss): the input frames every speech segment's `[start − P, end + T]` covers.
 *
 * The window is measured from the TRUE segment boundaries, not from what the detector believed: the
 * requirement is that the endpoint can hear the utterance whole, so the yardstick has to be the audio
 * that was spoken. The `T` on the end is the tail's own contract — the endpoint needs the noise after
 * the words to close the turn.
 */
function s2Window(frames: readonly CorpusFrame[], options: { prerollMs: number; tailMs: number }): CorpusFrame[] {
  const segments: Array<{ startMs: number; endMs: number }> = [];
  let open: number | null = null;
  for (const frame of frames) {
    if (frame.speech && open === null) {
      open = frame.startMs;
    } else if (!frame.speech && open !== null) {
      segments.push({ startMs: open, endMs: frame.startMs });
      open = null;
    }
  }
  const last = frames[frames.length - 1];
  if (open !== null && last !== undefined) {
    segments.push({ startMs: open, endMs: last.endMs });
  }

  const required: CorpusFrame[] = [];
  for (const segment of segments) {
    for (const frame of frames) {
      if (frame.startMs >= segment.startMs - options.prerollMs && frame.startMs < segment.endMs + options.tailMs) {
        required.push(frame);
      }
    }
  }
  return required;
}

/**
 * THE S-2 CASE — the assertion the two false forms must make red.
 *
 * `run.wired` is a multiset, but the gate never replays a frame it has already forwarded (a withheld
 * frame enters the ring once and leaves it once), so membership is the honest reading of "this frame
 * crossed the wire"; a duplicate could only ever make this assertion MORE lenient.
 */
function assertS2Coverage(run: Run, frames: readonly CorpusFrame[], options: { prerollMs: number; tailMs: number }): void {
  const wired = new Set(run.wired);
  const missing = s2Window(frames, options).filter((frame) => !wired.has(frame.audio));
  assert.deepEqual(
    missing.map((frame) => frame.index),
    [],
    `S-2: ${missing.length} frame(s) of a speech window never crossed the wire — the first syllable is the casualty`,
  );
}

// ── the false forms (AC1) ────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(HERE, '..');
const SHIPPING_SOURCE = path.join(MODULE_DIR, 'voice-realtime-silence-tail.ts');

type StsModule = typeof import('../voice-realtime-silence-tail.js');

/**
 * One false form: a textual mutation of the shipping source, and the plausible implementation it stands
 * for. Both are things a person would write on purpose — neither is a random break.
 */
type FalseForm = { label: string; anchor: string; replacement: string; why: string };

const FALSE_FORMS: readonly FalseForm[] = [
  {
    label: 'synthetic-zero-tail',
    why: 'the tail pads the wire with synthetic digital silence instead of uploading the microphone',
    anchor: '        frames.push(audio);',
    replacement: "        frames.push(stage === 'tail' ? digitalSilence(reading.ms) : audio);",
  },
  {
    // The whole resume branch is replaced: a form that dropped only the loop would still report
    // `preRollFrames = ring.length`, and a flush it never performed would be a claim in the log.
    label: 'no-preroll',
    why: 'the pre-roll is dropped, so suppression resumes frame by frame from here on',
    anchor: [
      '          preRollFrames = ring.length;',
      '          for (const held of ring) {',
      '            frames.push(held.audio);',
      '          }',
    ].join('\n'),
    replacement: '          preRollFrames = 0;',
  },
];

/**
 * Loads the shipping module with `form` applied, as a transient copy BESIDE it.
 *
 * Beside it because the module's own imports are relative (today it has none, and a later one must not
 * have to know this file exists), and NAMED with the `__criterion-falsify-` prefix `server/tsconfig.json`
 * excludes by name — a `npm run typecheck` overlapping this suite must never collect a file that is about
 * to be removed. The copy goes as soon as the import resolves: the module is in the registry by then.
 * The anchor is asserted to occur exactly once, so a mutation that silently stopped matching would be a
 * red here rather than a form that quietly exercises the shipping code twice.
 */
async function loadFalseForm(form: FalseForm): Promise<StsModule> {
  const source = readFileSync(SHIPPING_SOURCE, 'utf8');
  const occurrences = source.split(form.anchor).length - 1;
  assert.equal(occurrences, 1, `the "${form.label}" false form's anchor is not in the shipping source exactly once`);
  const target = path.join(MODULE_DIR, `__criterion-falsify-${form.label}-${process.pid}.ts`);
  writeFileSync(target, source.replace(form.anchor, form.replacement), 'utf8');
  try {
    return (await import(pathToFileURL(target).href)) as StsModule;
  } finally {
    rmSync(target, { force: true });
  }
}

test('AC1 false form — a tail of synthetic zeros forges the wire the endpoint is owed, so the S-2 case goes red', async () => {
  const form = FALSE_FORMS[0] as FalseForm;
  const mutated = await loadFalseForm(form);
  const frames = timeline(CORPUS);
  const run = runGate(mutated.createSilenceTailGate(ON), frames);

  // The form is otherwise a WORKING gate: it still suppresses, and it still resumes. Without this its
  // red would say nothing about the tail. The third entry is the corpus's own shape: its trailing 2 s of
  // room tone opens a second episode that nothing ever resumes (the corpus ends inside it).
  assert.deepEqual(
    run.transitions.map((entry) => entry.event),
    ['suppressed', 'resumed', 'suppressed'],
    `the false form (${form.why}) must still be a gate that suppresses`,
  );
  assert.ok(
    run.wired.includes(DIGITAL_SILENCE_FRAME),
    'the false form never put a synthetic silence frame on the wire, so it is not the form this case describes',
  );

  // THE CASUALTY IS THE TAIL WINDOW ITSELF: the frames the endpoint was owed after the words, which this
  // form replaces with a stand-in that says nothing about the room.
  const wired = new Set(run.wired);
  const forged = s2Window(frames, { prerollMs: ON.prerollMs ?? 0, tailMs: ON.tailMs ?? 0 }).filter(
    (frame) => !wired.has(frame.audio),
  );
  assert.ok(
    forged.length > 0,
    `the tail window's own frames must be the casualty of "${form.why}", but every one of them is on the wire`,
  );
  // …and the frames forged are the TAIL's, not the pre-roll's: nothing before an utterance ended is lost.
  assert.ok(
    forged.every((frame) => frame.startMs >= 1_100),
    'a frame before the utterance ended was forged, which is the pre-roll, not the tail',
  );

  assert.throws(
    () => assertS2Coverage(run, frames, { prerollMs: ON.prerollMs ?? 0, tailMs: ON.tailMs ?? 0 }),
    /S-2: \d+ frame\(s\) of a speech window never crossed the wire/,
    'S-2 must go RED under the synthetic-zero tail',
  );
});

test('AC1 false form — dropping the pre-roll loses the first syllable of the resumed utterance, so the S-2 case goes red', async () => {
  const form = FALSE_FORMS[1] as FalseForm;
  const mutated = await loadFalseForm(form);
  const frames = timeline(CORPUS);
  const run = runGate(mutated.createSilenceTailGate(ON), frames);

  const resumed = run.transitions.find((entry) => entry.event === 'resumed');
  assert.ok(resumed !== undefined, 'the false form must still resume, or its red says nothing about the flush');
  assert.equal(resumed.preRollFrames, 0, 'the false form must report no pre-roll frames, which is what "dropped" means');

  // THE FIRST SYLLABLE SPECIFICALLY: the `P` of audio before the resumed onset is what the flush would
  // have replayed, and under this form none of it is on the wire.
  const wired = new Set(run.wired);
  const beforeOnset = frames.filter((frame) => frame.startMs >= 4_600 && frame.startMs < 5_100);
  assert.equal(beforeOnset.length, PREROLL_FRAMES, 'the window before the resumed onset is exactly one P');
  assert.ok(
    beforeOnset.every((frame) => !wired.has(frame.audio)),
    'some of the pre-roll crossed the wire under a form that drops it',
  );

  assert.throws(
    () => assertS2Coverage(run, frames, { prerollMs: ON.prerollMs ?? 0, tailMs: ON.tailMs ?? 0 }),
    /S-2: \d+ frame\(s\) of a speech window never crossed the wire/,
    'S-2 must go RED without the pre-roll',
  );
});

// ── AC1, the positive case ───────────────────────────────────────────────────────────────────────

test('AC1 — the corpus crosses the gate with every speech window whole, and the wire is measurably shorter for it', () => {
  const frames = timeline(CORPUS);
  const run = runGate(createSilenceTailGate(ON), frames);

  assertS2Coverage(run, frames, { prerollMs: ON.prerollMs ?? 0, tailMs: ON.tailMs ?? 0 });

  // Non-vacuity: the coverage above is a claim about a gate that ACTUALLY suppressed, and whose flush
  // had something to replay. The third entry is the corpus's trailing 2 s of room tone: it opens a
  // second episode that nothing resumes, because the corpus ends inside it.
  assert.deepEqual(
    run.transitions.map((entry) => entry.event),
    ['suppressed', 'resumed', 'suppressed'],
    'the corpus must suppress, resume, and then suppress again into its trailing silence',
  );
  const [suppressed, resumed] = run.transitions as [Transition, Transition];

  // THE TIMELINE, DERIVED RATHER THAN RECORDED. Frame 55 is the first quiet frame; the tail opens once
  // the 320 ms hangover is complete, which is frame 55 + 15; `T` of real noise then has to cross.
  assert.equal(
    suppressed.atIndex,
    55 + SILENCE_TAIL_HANGOVER_MS / FRAME_MS - 1 + TAIL_FRAMES,
    'suppression begins exactly T after the tail opened, not at some frame of its own',
  );
  // The flush is `P` plus the frames the run consumed plus one, because the ring's capacity is
  // `P + (ENTER_FRAMES + 1)` frames (`pushToRing`) and the resumed frame joins the ring before the test.
  assert.equal(
    resumed.preRollFrames,
    PREROLL_FRAMES + SILENCE_TAIL_ENTER_FRAMES + 1,
    'the flush is P plus what the detector needed to name the start',
  );
  assert.ok(
    run.wired.length < frames.length,
    'suppression that put every frame on the wire anyway is not suppression',
  );

  // The tail is the microphone's OWN noise: every frame that crossed during it is the corpus's, and the
  // synthesized stand-in — which this arm cannot produce, the keepalive being off — is nowhere on it.
  for (const frame of frames.slice(suppressed.atIndex - TAIL_FRAMES, suppressed.atIndex)) {
    assert.ok(
      run.wired.includes(frame.audio),
      `the tail must upload frame ${frame.index}'s real audio, not a stand-in`,
    );
  }
  assert.ok(
    !run.wired.includes(DIGITAL_SILENCE_FRAME),
    'the shipping tail must never put digital silence on the wire (the keepalive is off in this arm)',
  );
});

// ── AC2 (S-1 / S-3): the two arms agree, on both time bases ──────────────────────────────────────

type EndpointEvent = { atMs: number; type: string };

/**
 * The endpoint's own detector, hearing ONLY what STS let cross — and every event attributed to the
 * INPUT frame that made it due, so the two arms are compared on the audio the person actually spoke.
 *
 * The clock is stepped with the audio (`advance(frame.endMs)`) for BOTH bases, forwarded frame or not.
 * On the audio-time base that call is only a clock update; on the wall-clock base it is the only thing
 * that can move a silence with no frames behind it — which is exactly the clock a suppressed stretch
 * would otherwise freeze. Stepping one schedule and reading both bases is what makes them comparable.
 */
function endpointEvents(input: {
  frames: readonly CorpusFrame[];
  gate: SilenceTailGate | null;
  timeBase: ScriptedVadTimeBase;
}): EndpointEvent[] {
  const vad = createScriptedVad({
    timeBase: input.timeBase,
    silenceDurationMs: 400,
    // The corpus's own separation (room tone peaks at 20, speech at 508) is what both detectors gate
    // on, so the stand-in is tuned to the corpus rather than to a real room's level.
    threshold: 0.005,
  });
  const events: EndpointEvent[] = [];
  for (const frame of input.frames) {
    const wired = input.gate === null ? [frame.audio] : input.gate.observe(frame.audio, frame.startMs).frames;
    for (const audio of wired) {
      for (const wire of vad.receive({ type: 'input_audio_buffer.append', audio })) {
        events.push({ atMs: frame.startMs, type: String(wire.type) });
      }
    }
    for (const wire of vad.advance(frame.endMs)) {
      events.push({ atMs: frame.startMs, type: String(wire.type) });
    }
  }
  return events;
}

/** The median of a reading — AC2 and AC3 bound readings at p50, not at their worst case. */
function p50(values: readonly number[]): number {
  assert.ok(values.length > 0, 'p50 of nothing is not a reading');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * The one cost the trade is allowed to pay, in milliseconds: an utterance's onset is heard
 * `ENTER_FRAMES - 1` frames late, because that is how many frames the gate withholds while it decides
 * that speech has started. Everything after the onset is on the same frame it always was.
 */
const ONSET_BUDGET_MS = (SILENCE_TAIL_ENTER_FRAMES - 1) * FRAME_MS;

for (const timeBase of ['audio-time', 'wall-clock'] as const) {
  test(`AC2 — STS on and STS off agree event for event on the ${timeBase} base, inside S-1's budget`, () => {
    const frames = timeline(TWO_ARM_PLAN);
    const off = endpointEvents({ frames, gate: null, timeBase });
    const on = endpointEvents({ frames, gate: createSilenceTailGate(ON), timeBase });

    // Non-vacuity: the endpoint must have heard something in the OFF arm, or "they agree" is a
    // statement about two detectors that both said nothing.
    assert.ok(off.length > 0, 'the off arm produced no endpoint events at all');
    assert.equal(
      off.filter((event) => event.type === 'input_audio_buffer.speech_stopped').length,
      5,
      `the corpus must close all five utterances in the off arm, saw ${JSON.stringify(off.map((event) => event.type))}`,
    );

    // EVENT FOR EVENT: nothing appeared, nothing vanished, nothing reordered.
    assert.deepEqual(
      on.map((event) => event.type),
      off.map((event) => event.type),
      `the ${timeBase} arm must produce the same endpoint events in the same order`,
    );

    // …AND THE TIMES, up to the one shift the trade buys: the onset confirm window. The reading is not
    // zero and must not pretend to be — that 40 ms IS S-1's cost, and it has to fit in the budget.
    const deltas = off.map((event, index) => Math.abs(event.atMs - (on[index]?.atMs ?? -1)));
    assert.ok(
      Math.max(...deltas) <= ONSET_BUDGET_MS,
      `the onset confirm window is the only thing STS may shift, but some event moved ${Math.max(...deltas)} ms`,
    );
    assert.ok(
      deltas.some((delta) => delta === ONSET_BUDGET_MS),
      'and the onsets must actually shift, or this arm suppressed nothing to be late about',
    );
    assert.ok(p50(deltas) <= 100, `S-1/S-3: p50 timing difference must be <= 100 ms, saw ${p50(deltas)} ms`);
  });
}

test('AC2 — T outlasts the endpoint’s own close window, which is what lets the two arms agree at all', () => {
  // AC-363 V-1: 400 ms of real silence did NOT close the real endpoint's turn, 500 ms did. The tail has
  // to be longer than that, or the endpoint would be asked to close a turn on audio it never received —
  // and the agreement above would be an accident of this stand-in's own numbers rather than a property
  // of the relay. Cited rather than re-measured (S-7).
  assert.ok(
    DEFAULT_SILENCE_TAIL_MS > 500,
    `T must outlast the endpoint's measured close window (V-1: 500 ms), and ${DEFAULT_SILENCE_TAIL_MS} ms does not`,
  );
  assert.ok(SILENCE_TAIL_HANGOVER_MS < DEFAULT_SILENCE_TAIL_MS, 'the hangover is a fraction of the tail');
});

// ── AC3 (S-4 / S-5): a long suppression, and a corpus that must never be misread ──────────────────

/**
 * Frames that were spoken and did NOT cross the wire — S-5's hard zero.
 *
 * "Crossed" is membership in the WIRE, not in the frame's own decision: a frame the gate withheld enters
 * the ring, and a LATER frame's flush is what carries it. Asking each frame's own decision would report
 * every pre-roll frame as lost, which is the opposite of what the ring is for.
 */
function speechFramesWithheld(run: Run, frames: readonly CorpusFrame[]): CorpusFrame[] {
  const wired = new Set(run.wired);
  return frames.filter((frame) => frame.speech && !wired.has(frame.audio));
}

test('AC3 — the corpus of low-volume speech and noise never has a spoken frame misjudged as silence', () => {
  const plan: readonly Segment[] = [
    { kind: 'silence', ms: 500 },
    { kind: 'speech', ms: 600, rms: LOW_VOLUME_RMS },
    { kind: 'silence', ms: 4_000 },
    { kind: 'noise', ms: 600 },
    { kind: 'silence', ms: 4_000 },
    { kind: 'speech', ms: 600, rms: LOW_VOLUME_RMS },
    { kind: 'silence', ms: 2_000 },
  ];
  const frames = timeline(plan);
  const run = runGate(createSilenceTailGate(ON), frames);

  // S-5's hard requirement, in the direction decision doc §10.4 states it: the words cannot be recovered
  // later, so the rate of speech misjudged as silence must be zero.
  assert.deepEqual(
    speechFramesWithheld(run, frames).map((frame) => frame.index),
    [],
    'S-5: no frame of low-volume speech may be withheld',
  );

  // Non-vacuity: the corpus must have driven the gate into suppression, or "no speech was withheld" is a
  // statement about a gate that withheld nothing at all. Every quiet stretch is longer than the hangover
  // plus `T`, so each of the corpus's three ends opens an episode — and the two speech stretches are what
  // resume the first two, which is what makes this a reading about low-volume speech rather than about a
  // gate that never woke up.
  assert.deepEqual(
    run.transitions.map((entry) => entry.event),
    ['suppressed', 'resumed', 'suppressed', 'resumed', 'suppressed'],
    'the corpus must suppress into each silence and resume on each speech stretch',
  );

  // The OTHER half of the asymmetry, RECORDED rather than required: the noise stand-in sits above the
  // gate's ceiling, so it is uploaded as though it were speech. That is the 误判语音率 reading, and it is
  // the non-vacuity of the zero above — this arm really did contain audio the gate could have misjudged.
  const wired = new Set(run.wired);
  const noiseFrames = frames.filter((frame) => frame.audio === pcmFrame(NOISE_RMS, frame.index));
  assert.equal(noiseFrames.length, 30, 'the noise stretch is 600 ms of frames');
  assert.ok(
    noiseFrames.every((frame) => wired.has(frame.audio)),
    'the noise was withheld as silence, which would be a saving — the recorded reading is that it is not',
  );
});

/** Drives a gate from speech into suppression, and reports everything that crossed on the way. */
function driveToSuppressed(gate: SilenceTailGate): void {
  for (let frame = 0; frame < SILENCE_TAIL_ENTER_FRAMES; frame += 1) {
    gate.observe(pcmFrame(SPEECH_RMS, frame + 1), 0);
  }
  for (let quiet = 0; quiet < 200 && gate.stage !== 'suppressed'; quiet += 1) {
    gate.observe(SILENCE_FRAME, 0);
  }
  assert.equal(gate.stage, 'suppressed', 'the gate must reach suppression within a bounded quiet stretch');
}

/** 30 minutes of a microphone nobody is speaking into, in 20 ms frames. */
const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const THIRTY_MINUTES_FRAMES = THIRTY_MINUTES_MS / FRAME_MS;

test('AC3 — a 30-minute virtual suppression resumes, and the keepalive is what lets it survive the endpoint', () => {
  // (a) WITH the keepalive OFF, a 30-minute suppression is a completely quiet wire.
  const silent = createSilenceTailGate(ON);
  driveToSuppressed(silent);
  let silentFrames = 0;
  for (let ms = 0; ms <= THIRTY_MINUTES_MS; ms += FRAME_MS) {
    silentFrames += silent.observe(SILENCE_FRAME, ms).frames.length;
  }
  assert.equal(silentFrames, 0, 'a suppression with the keepalive off must put nothing on the wire');

  // (b) WITH the shipping keepalive, the wire is quiet EXCEPT for one frame per interval — which is what
  // AC-363 V-2 makes necessary: the endpoint closed an idle socket at 303.6–306.3 s.
  const kept = createSilenceTailGate({ ...ON, keepaliveMs: DEFAULT_SILENCE_TAIL_KEEPALIVE_MS });
  driveToSuppressed(kept);
  const seen: Array<{ atMs: number; audio: string }> = [];
  for (let ms = 0; ms <= THIRTY_MINUTES_MS; ms += FRAME_MS) {
    for (const audio of kept.observe(SILENCE_FRAME, ms).frames) {
      seen.push({ atMs: ms, audio });
    }
  }
  assert.equal(
    seen.length,
    Math.floor(THIRTY_MINUTES_MS / DEFAULT_SILENCE_TAIL_KEEPALIVE_MS),
    'the keepalive must land once per interval and never more often',
  );
  for (const [index, entry] of seen.entries()) {
    const expected = (index + 1) * DEFAULT_SILENCE_TAIL_KEEPALIVE_MS;
    assert.ok(
      entry.atMs === expected,
      `keepalive #${index + 1} landed at ${entry.atMs} ms, not at its ${expected} ms interval`,
    );
    assert.equal(
      entry.audio,
      KEEPALIVE_FRAME,
      'the keepalive must be digital silence, so it cannot be mistaken for the microphone',
    );
  }
  assert.ok(
    DEFAULT_SILENCE_TAIL_KEEPALIVE_MS * 10 <= 303_600,
    `the keepalive must leave an order of magnitude of margin inside V-2's measured 303.6–306.3 s close, and ${DEFAULT_SILENCE_TAIL_KEEPALIVE_MS} ms does not`,
  );

  // (c) S-4's recovery: the next syllable is real audio — the pre-roll, then the frame that resumed.
  let resume: SilenceTailDecision | null = null;
  for (let frame = 0; frame < SILENCE_TAIL_ENTER_FRAMES; frame += 1) {
    const decision = silent.observe(pcmFrame(SPEECH_RMS, frame + 1), THIRTY_MINUTES_MS + frame * FRAME_MS);
    if (decision.transition !== null) {
      resume = decision;
    }
  }
  assert.ok(resume !== null, 'the suppression must resume when speech returns');
  assert.equal(resume.transition, 'resumed');
  assert.equal(
    resume.preRollFrames,
    PREROLL_FRAMES + SILENCE_TAIL_ENTER_FRAMES + 1,
    'a 30-minute suppression still flushes exactly the bounded ring',
  );
  assert.equal(resume.frames.length, resume.preRollFrames, 'the flush IS the ring — the resumed frame is in it');
  assert.ok(
    resume.frames.every((audio) => audio !== KEEPALIVE_FRAME),
    'the resumed stream is the microphone, not the keepalive (this arm has the keepalive off)',
  );
});

// ── the relay itself: the proxy's continuous branch ───────────────────────────────────────────────

/** The slice of the browser socket the proxy touches — the same shape the sibling suites use. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type Wired = {
  socket: FakeBrowserSocket;
  /** One upstream per session, in dial order: `[0]` is the active session (and the one that hears audio). */
  transports: FakeTransport[];
  logs: string[];
  rotations: UpstreamPoolRotation[];
};

/**
 * One continuous-mode proxy connection over a fake browser socket and fake upstreams.
 *
 * `silenceTail` is passed only when the arm wants STS on: the seam's PRESENCE is the switch, exactly as
 * `resolveSilenceTail` leaves it, so the STS-off arms are wired the way a deployment that named no
 * environment variable is wired.
 */
function wire(options: { silenceTail?: SilenceTailOptions; stallMs?: number; idleRotateMs?: number } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const rotations: UpstreamPoolRotation[] = [];
  const executor: RealtimeToolExecutor = { session_send: async () => ({ runId: 'run-1', queued: false }) };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => executor,
    instructions: 'test instructions',
    // Pinned rather than inherited: `VOICE_REALTIME_MODE` in the ambient environment would make this a
    // segmented connection, and the segmented wire carries no bare `audio` frames at all (S-6).
    segmentedRelay: false,
    log: (line) => logs.push(line),
    ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
    ...(options.idleRotateMs === undefined
      ? {}
      : {
          upstreamPool: {
            idleRotateMs: options.idleRotateMs,
            onRotate: (rotation) => rotations.push(rotation),
          },
        }),
    ...(options.silenceTail === undefined ? {} : { silenceTail: options.silenceTail }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs, rotations };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

/** Every audio payload the ACTIVE upstream was handed, in order. */
const appends = (wired: Wired): string[] =>
  (wired.transports[0]?.sent ?? [])
    .filter((message) => message.type === 'input_audio_buffer.append')
    .map((message) => (message as { audio: string }).audio);

const turnUnanswered = (wired: Wired): number =>
  wired.socket.outbound.filter((frame) => frame.type === 'turn_unanswered').length;

/** Feeds `count` copies of one payload, yielding to the event loop every `chunk` frames. */
async function feed(wired: Wired, audio: string, count: number, chunk = 2_000): Promise<void> {
  for (let sent = 0; sent < count; sent += 1) {
    wired.socket.receive({ type: 'audio', audio });
    if ((sent + 1) % chunk === 0) {
      // A macrotask boundary, so a timer the pool or the watchdog armed can actually fire while frames
      // are still arriving. Without it a synchronous feed would hide the very false trigger AC3 names.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

// ── AC4 (S-6): the switch off ────────────────────────────────────────────────────────────────────

test('AC4 — with the switch off the continuous wire is the identity relay it was before STS existed', async () => {
  const wired = wire();
  await waitFor(() => opened(wired.socket));

  const frames = timeline(CORPUS);
  for (const frame of frames) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }

  // Byte for byte, in order: nothing withheld, nothing replayed, nothing substituted.
  assert.deepEqual(
    appends(wired),
    frames.map((frame) => frame.audio),
  );
  assert.equal(
    wired.logs.filter((line) => line.startsWith('silence_tail')).length,
    0,
    'an STS-off connection must not report a suppression it never performed',
  );
});

test('AC4 — the same corpus through the same wiring WITH the switch on is not the identity relay', async () => {
  const wired = wire({ silenceTail: ON });
  await waitFor(() => opened(wired.socket));

  const frames = timeline(CORPUS);
  for (const frame of frames) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }

  // The control for the assertion above: without this, the AC4 case would be green for a wiring that
  // could not have withheld anything in the first place.
  assert.ok(
    appends(wired).length < frames.length,
    'STS on must put fewer frames on the wire than the browser sent',
  );
  assert.ok(
    wired.logs.some((line) => line.startsWith('silence_tail event=suppressed')),
    `the suppression must be journalled, saw ${JSON.stringify(wired.logs)}`,
  );
  assert.ok(
    wired.logs.some((line) => line.includes('prerollFrames=') && !line.includes('prerollFrames=0')),
    'the resume line must report what the flush cost',
  );
});

// ── AC3, at the relay: the watchdog and the pool ─────────────────────────────────────────────────

const SPEECH_BURST_FRAMES = 100;

test('AC3 — 30 minutes of virtual suppression false-triggers neither the stall watchdog nor a pool rotation, and then resumes', async () => {
  // The pool's idle threshold is shrunk but NOT to the millisecond: the claim is that a suppressed
  // stretch is not an idle one, and a threshold a 2 000-frame feed could outrun by accident would be a
  // claim about this machine's scheduler rather than about the relay.
  const wired = wire({ silenceTail: ON, stallMs: 120, idleRotateMs: 1_000 });
  await waitFor(() => opened(wired.socket));

  await feed(wired, pcmFrame(SPEECH_RMS, 7), SPEECH_BURST_FRAMES);
  await waitFor(() => appends(wired).length > 0);
  // The endpoint hears the utterance and answers it, as a live one does. This pair is what keeps the
  // watchdog out of this leg's way: `speech_started` is the upstream having said something during the
  // locally-heard utterance, so the local boundary that ends it does NOT arm a stall — and the
  // transcription then clears the awaiting state that `speech_started` opened.
  const active = wired.transports[0] as FakeTransport;
  active.peerSend({ type: 'input_audio_buffer.speech_started' });
  active.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_corpus',
    transcript: '第一句',
  });

  // The tail crosses here and the suppression opens inside this first stretch: from its end the wire must
  // stay silent for 30 minutes of audio.
  await feed(wired, SILENCE_FRAME, 2_000);
  assert.ok(
    wired.logs.some((line) => line.startsWith('silence_tail event=suppressed')),
    'the suppression must have opened before the long stretch is asserted quiet',
  );
  const before = appends(wired).length;

  for (let chunk = 0; chunk < THIRTY_MINUTES_FRAMES / 2_000; chunk += 1) {
    await feed(wired, SILENCE_FRAME, 2_000, 2_000);
    assert.equal(
      appends(wired).length,
      before,
      `chunk ${chunk}: a suppressed stretch must put no microphone audio on the wire`,
    );
    assert.equal(turnUnanswered(wired), 0, `chunk ${chunk}: the watchdog fired during a suppressed stretch`);
    assert.equal(wired.rotations.length, 0, `chunk ${chunk}: the pool rotated during a suppressed stretch`);
  }

  // S-4: it resumes, and the next syllable reaches the endpoint.
  await feed(wired, pcmFrame(SPEECH_RMS, 8), SILENCE_TAIL_ENTER_FRAMES);
  await waitFor(() => appends(wired).length > before);
  assert.ok(
    wired.logs.some((line) => line.startsWith('silence_tail event=resumed')),
    'the resume must be journalled',
  );
  assert.equal(turnUnanswered(wired), 0, 'the resumed utterance is not an unanswered one');
  assert.equal(wired.rotations.length, 0, 'recovery must not rotate the session either');

  // Non-vacuity: THIS pool does rotate once the connection is genuinely idle, so the zeros above are
  // readings rather than a rotation that could never have happened through this wiring.
  await waitFor(() => wired.rotations.length >= 1, 5_000);
});

test('AC3 — the same wiring DOES report an unanswered turn when the endpoint never answers (the watchdog control)', async () => {
  const wired = wire({ silenceTail: ON, stallMs: 120 });
  await waitFor(() => opened(wired.socket));

  // A local utterance the endpoint never acknowledges: the stall is what says so, and `turn_unanswered`
  // is how the page hears it. Without this leg the zero above could be a watchdog that never ran.
  await feed(wired, pcmFrame(SPEECH_RMS, 7), SPEECH_BURST_FRAMES);
  await waitFor(() => appends(wired).length > 0);
  await feed(wired, SILENCE_FRAME, 2_000);

  await waitFor(() => turnUnanswered(wired) >= 1);
  assert.ok(
    wired.logs.some((line) => line.startsWith('to-browser turn_unanswered')),
    'the journal must say what the page was told',
  );
});

// ── the switch (S-6's other half: what "off" means at the assembly point) ─────────────────────────

test('S-6 — the environment switch is off unless a deployment spells it out, and a bad parameter is reported rather than guessed', () => {
  assert.deepEqual(resolveSilenceTail({}), {
    enabled: false,
    tailMs: DEFAULT_SILENCE_TAIL_MS,
    prerollMs: DEFAULT_SILENCE_TAIL_PREROLL_MS,
    keepaliveMs: DEFAULT_SILENCE_TAIL_KEEPALIVE_MS,
    invalid: [],
  });

  for (const spelling of ['1', 'on', 'true', 'yes', ' ON ']) {
    assert.equal(
      resolveSilenceTail({ [SILENCE_TAIL_ENV]: spelling }).enabled,
      true,
      `${JSON.stringify(spelling)} must turn STS on`,
    );
  }
  for (const spelling of ['0', 'off', 'false', 'no', '']) {
    assert.equal(
      resolveSilenceTail({ [SILENCE_TAIL_ENV]: spelling }).enabled,
      false,
      `${JSON.stringify(spelling)} must leave STS off`,
    );
  }

  // A misconfigured parameter falls back AND is reported: an "off by typo" must not look like an "off on
  // purpose", and a silently-defaulted `T` must not look like a configured one.
  const misconfigured = resolveSilenceTail({
    [SILENCE_TAIL_ENV]: '1',
    [SILENCE_TAIL_MS_ENV]: '1s',
    [SILENCE_TAIL_PREROLL_MS_ENV]: '-5',
    [SILENCE_TAIL_KEEPALIVE_MS_ENV]: '0',
  });
  assert.equal(misconfigured.enabled, true, 'a bad parameter must not turn the switch itself off');
  assert.equal(misconfigured.tailMs, DEFAULT_SILENCE_TAIL_MS);
  assert.equal(misconfigured.prerollMs, DEFAULT_SILENCE_TAIL_PREROLL_MS);
  assert.equal(misconfigured.keepaliveMs, 0, '0 is a legitimate keepalive setting: it disables it');
  assert.deepEqual(misconfigured.invalid, [
    `${SILENCE_TAIL_MS_ENV}="1s"`,
    `${SILENCE_TAIL_PREROLL_MS_ENV}="-5"`,
  ]);
});
