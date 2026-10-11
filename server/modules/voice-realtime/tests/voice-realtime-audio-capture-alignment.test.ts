/**
 * AC3 — THE ALIGNMENT CONTRACT, on a synthetic curve whose acoustics are known exactly.
 *
 * WHY THIS IS THE CRITERION THAT MAKES THE CAPTURE WORTH ANYTHING. Audio alone grades no detector: a
 * proposal can only be compared against what the endpoint itself decided, so the capture has to carry
 * the endpoint's judgement events ON THE SAME CLOCK as the samples. This file builds a capture whose
 * ground truth is exact — a curve that is silent, then speech, then silent again, and endpoint events
 * placed a few milliseconds off the acoustic boundaries, the way a real detector's are — and then reads
 * the two files back and checks the contract:
 *
 *   offset_ms(event) = event.wallClock − t0
 *
 * with the resulting audio offset landing within ONE FRAME of the acoustic boundary the event
 * describes, and the endpoint's `speech_stopped` landing INSIDE the silent stretch the curve actually
 * has there. The events enter through the SAME seam the journal uses (the transport's `observe`), so
 * what is proved is the production chain — wire event → recorder → timeline line — not a hand-built
 * timeline that could not disaggregate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createVoiceRealtimeCaptureRecorder,
  createVoiceRealtimeCaptureStore,
} from '../voice-realtime-audio-capture.js';

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_MS = 20;
const SILENCE_LEAD = 5; // frames
const SPEECH = 15; // frames
const SILENCE_TAIL = 10; // frames
const FRAME_COUNT = SILENCE_LEAD + SPEECH + SILENCE_TAIL;
const T0 = 1_700_000_000_000; // an arbitrary but FIXED wall clock, so every offset below is exact

/** The acoustics of frame `index`: silence outside the speech stretch, a tone inside it. */
function framePcm(index: number): Buffer {
  const buffer = Buffer.alloc(FRAME_SAMPLES * 2);
  const speaking = index >= SILENCE_LEAD && index < SILENCE_LEAD + SPEECH;
  for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
    buffer.writeInt16LE(speaking ? Math.round(16_000 * Math.sin((2 * Math.PI * 440 * sample) / SAMPLE_RATE)) : 0, sample * 2);
  }
  return buffer;
}

/** The frame a millisecond offset maps to, and how far into it the offset sits. */
function frameAt(offsetMs: number): { index: number; intoMs: number } {
  return { index: Math.floor(offsetMs / FRAME_MS), intoMs: offsetMs % FRAME_MS };
}

/** The peak absolute sample of one frame of the recorded WAV — 0 for a silent frame. */
function framePeak(audio: Buffer, index: number): number {
  let peak = 0;
  for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
    const value = Math.abs(audio.readInt16LE(44 + (index * FRAME_SAMPLES + sample) * 2));
    if (value > peak) peak = value;
  }
  return peak;
}

/** The judgement timeline, one parsed object per line. */
function readTimeline(directory: string, connectionId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(directory, `${connectionId}.timeline.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('AC3: the endpoint timeline is on the audio\'s own clock, and its stop lands in the curve\'s silence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'voice-capture-alignment-'));
  const directory = path.join(root, 'capture');
  const connectionId = 'conn-alignment';
  try {
    const recorder = createVoiceRealtimeCaptureRecorder({
      store: createVoiceRealtimeCaptureStore({ directory, connectionId, maxBytes: 8 * 1024 * 1024 }),
      connectionId,
      enabled: true,
      stdout: () => {},
    });

    // The curve, frame by frame, on a shared origin (the first frame fixes t0).
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      recorder.frame(framePcm(index).toString('base64'), SAMPLE_RATE, T0 + index * FRAME_MS);
    }

    // The endpoint's decisions, a few ms off the acoustic boundaries — where a real detector's are.
    // Speech actually runs [100 ms, 400 ms); the detector reports onset 8 ms late and release 12 ms late.
    const events = [
      { type: 'input_audio_buffer.speech_started', atMs: T0 + 108, expectedOffsetMs: 108, audioFrame: 5 },
      { type: 'input_audio_buffer.speech_stopped', atMs: T0 + 412, expectedOffsetMs: 412, audioFrame: 20 },
    ] as const;
    for (const event of events) {
      recorder.observe({ direction: 'received', atMs: event.atMs, wire: { type: event.type } });
    }
    recorder.observe({ direction: 'received', atMs: T0 + 420, wire: { type: 'input_audio_buffer.committed', item_id: 'item_1' } });
    recorder.finalize();

    const timeline = readTimeline(directory, connectionId);
    const origin = timeline.find((entry) => entry.kind === 'origin');
    assert.ok(origin !== undefined, 'the capture wrote its shared origin');
    assert.equal(origin.atMs, T0, 't0 is the FIRST frame\'s wall clock');
    assert.equal(origin.offsetMs, 0);

    const audio = readFileSync(path.join(directory, `${connectionId}.wav`));

    // The curve is what this criterion claims it is — otherwise "lands in silence" could be vacuous.
    assert.equal(framePeak(audio, 0), 0, 'the lead is silent');
    assert.ok(framePeak(audio, SILENCE_LEAD + 1) > 0, 'the speech stretch has signal');
    assert.equal(framePeak(audio, FRAME_COUNT - 1), 0, 'the tail is silent');

    for (const event of events) {
      const line = timeline.find((entry) => entry.kind === (event.type.endsWith('speech_started') ? 'speech_started' : 'speech_stopped'));
      assert.ok(line !== undefined, `the timeline records ${event.type}`);

      // THE CONTRACT: offset_ms(event) = event.wallClock − t0, exactly — no rounding, no accumulation.
      assert.equal(line.offsetMs, event.expectedOffsetMs, `${event.type}: offset_ms = wallClock − t0`);
      assert.equal((line.offsetMs as number), (line.atMs as number) - (origin.atMs as number));

      // The offset selects the RIGHT frame of audio: the one the event describes, within one frame.
      const { index } = frameAt(line.offsetMs as number);
      assert.ok(
        Math.abs(index - event.audioFrame) <= 1,
        `${event.type}: audio offset ${line.offsetMs}ms maps to frame ${index}, expected ~${event.audioFrame}`,
      );
    }

    // The two claims that make it a CORPUS rather than a coincidence: the onset offset lands in the
    // curve's speech and the release offset lands in the curve's SILENCE.
    const started = timeline.find((entry) => entry.kind === 'speech_started') as { offsetMs: number };
    const stopped = timeline.find((entry) => entry.kind === 'speech_stopped') as { offsetMs: number };
    assert.ok(framePeak(audio, frameAt(started.offsetMs).index) > 0, 'speech_started lands inside speech');
    assert.equal(framePeak(audio, frameAt(stopped.offsetMs).index), 0, 'speech_stopped lands inside the following silence');

    // The commit is on the same clock, and carries the item it closed.
    const committed = timeline.find((entry) => entry.kind === 'committed');
    assert.equal(committed?.offsetMs, 420);
    assert.equal(committed?.itemId, 'item_1');

    // Every line is on that one clock, monotonic from the origin.
    const offsets = timeline.filter((entry) => entry.kind !== 'origin' && entry.kind !== 'final').map((entry) => entry.offsetMs as number);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), 'the judgement timeline is monotonic');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
