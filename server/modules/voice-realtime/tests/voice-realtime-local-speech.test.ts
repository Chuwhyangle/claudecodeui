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
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalSpeechGate } from '../voice-realtime-local-speech.js';

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
