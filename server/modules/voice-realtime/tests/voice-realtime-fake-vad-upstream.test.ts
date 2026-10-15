/**
 * gap-live-voice-continuous-experience-e2e-harness — the ACOUSTIC half of the shared scripted
 * stand-in: {@link createScriptedVad} in `./voice-realtime-scripted-upstream.ts`.
 *
 * WHY THIS FILE EXISTS. The stand-in could REACT to the client's frames (the protocol machine AC-359
 * added) but it could not HEAR. Under continuous that is the whole story: the endpoint's own detector
 * decides where an utterance ends, and the response opportunity that follows is one the client never
 * asked for (decision doc §4 R-1 — 说完 → response 机会最短、不依赖我方 commit 时序). A stand-in that
 * reacted only to `input_audio_buffer.commit` would make every continuous reading a reading of what
 * the scenario's author believed the endpoint does with sound. So this file drives a detector that
 * decodes the appended PCM16 and closes an utterance by itself.
 *
 * THE UNKNOWN, AND WHY IT IS A SWITCH. Whether the real endpoint measures that silence in RECEIVED
 * SAMPLES (`audio-time`) or in ELAPSED TIME (`wall-clock`) is open — AC-363 V-1 answers it on the real
 * endpoint, and the decision doc forbids presupposing it. The two differ in exactly the case Silence
 * Tail Suppression exists for: a client that STOPS TRANSMITTING. An audio-time detector's clock cannot
 * move while no frames arrive, so only the tail it already received can close the turn; a wall-clock
 * detector keeps counting and can end the turn with no further audio at all. `timeBase` is therefore a
 * REQUIRED option and both bases are implemented — and the FIRST group below is the FALSE FORM (AC1):
 * the shipping module is copied beside itself with the one line that chooses between the clocks
 * removed, so both bases measure samples and the contrast this file rests on is shown to go RED rather
 * than being green for a reason of its own.
 *
 * HOW IT RUNS. Every leg drives the detector DIRECTLY: no socket, no credential, and — the point of
 * `advance(nowMs)` — no real clock. Time moves only when a leg says so, which is what makes a
 * wall-clock reading deterministic instead of flaky.
 *
 * Provenance (goal record AC-361): this file is the one the criterion names.
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 *
 * Consumers: the quay worker's AC state for `gap-live-voice-continuous-experience-e2e-harness`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  UPLINK_VAD_FRAME_BYTES,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from '../voice-realtime-uplink-vad.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import {
  createScriptedVad,
  type ScriptedVadDetector,
  type ScriptedVadOptions,
  type ScriptedVadTimeBase,
  type ScriptedVadTurn,
} from './voice-realtime-scripted-upstream.js';

/** The rate the bridge encodes at, and the rate every payload below is written at. */
const SAMPLE_RATE = 16_000;
/**
 * The `silence_duration_ms` this fixture drives its scripted detector with. It is the value the repository
 * shipped as its `server_vad` default when the fixture was recorded; the shipped default is 800 since
 * 2026-10-15, and the fixture KEEPS 400 so its recorded timings are not rewritten under it.
 */
const SILENCE_MS = 400;
/** Loud enough to cross the shipped 0.5 gate. */
const SPEECH_AMPLITUDE = 0.8;
/** Loud enough to cross a gate put under it, and not the shipped one. */
const QUIET_AMPLITUDE = 0.3;

// ── audio, built by hand ──────────────────────────────────────────────────────────────────────

/** `seconds` of a constant-amplitude PCM16 tone, base64 — one `input_audio_buffer.append` payload. */
function pcm16(seconds: number, amplitude: number): string {
  const samples = Math.max(1, Math.round(SAMPLE_RATE * seconds));
  const bytes = Buffer.alloc(samples * 2);
  const value = Math.round(amplitude * 32_767);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(value, index * 2);
  }
  return bytes.toString('base64');
}

/** One append carrying `seconds` of sound at `amplitude` (0 is digital silence). */
const append = (seconds: number, amplitude: number): Record<string, unknown> => ({
  type: 'input_audio_buffer.append',
  audio: pcm16(seconds, amplitude),
});

const speak = (seconds: number, amplitude = SPEECH_AMPLITUDE): Record<string, unknown> => append(seconds, amplitude);
const hush = (seconds: number): Record<string, unknown> => append(seconds, 0);

// ── driving the detector ──────────────────────────────────────────────────────────────────────

type VadFactory = (options: ScriptedVadOptions) => ScriptedVadDetector;

/** One detector, plus everything it said — what a leg asserts on instead of re-walking frame lists. */
type Hearing = {
  detector: ScriptedVadDetector;
  /** Every endpoint frame the detector made due, in order. */
  frames: Array<Record<string, unknown>>;
  /** Every frame the test handed IN, in order — so "the client asked for nothing" is readable. */
  sent: Array<Record<string, unknown>>;
  feed(...incoming: Array<Record<string, unknown>>): void;
  clock(nowMs: number): void;
  types(): string[];
  indexOf(type: string): number;
  count(type: string): number;
  only(type: string): Record<string, unknown>;
  /** The parsed arguments of every `response.function_call_arguments.done` naming `name`. */
  callsTo(name: string): Array<Record<string, unknown>>;
};

function hearWith(create: VadFactory, options: ScriptedVadOptions): Hearing {
  const detector = create(options);
  const frames: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const hearing: Hearing = {
    detector,
    frames,
    sent,
    feed(...incoming) {
      for (const frame of incoming) {
        sent.push(frame);
        frames.push(...detector.receive(frame));
      }
    },
    clock(nowMs) {
      frames.push(...detector.advance(nowMs));
    },
    types: () => frames.map((frame) => String(frame.type)),
    indexOf: (type) => frames.findIndex((frame) => frame.type === type),
    count: (type) => frames.filter((frame) => frame.type === type).length,
    only(type) {
      const found = frames.filter((frame) => frame.type === type);
      assert.equal(found.length, 1, `expected exactly one ${type}, got: ${JSON.stringify(hearing.types())}`);
      return found[0]!;
    },
    callsTo: (name) =>
      frames
        .filter((frame) => frame.type === 'response.function_call_arguments.done' && frame.name === name)
        .map((frame) => JSON.parse(String(frame.arguments)) as Record<string, unknown>),
  };
  return hearing;
}

/** The shipping detector, with only `timeBase` (and any overrides) named. */
const hear = (options: ScriptedVadOptions): Hearing => hearWith(createScriptedVad, options);

const base = (timeBase: ScriptedVadTimeBase, over: Partial<ScriptedVadOptions> = {}): ScriptedVadOptions => ({
  timeBase,
  silenceDurationMs: SILENCE_MS,
  threshold: 0.5,
  ...over,
});

/** One utterance, closed by its own tail — the shape every model-policy leg uses. */
function oneTurn(turn: ScriptedVadTurn): Hearing {
  const hearing = hear(base('audio-time', { turns: [turn] }));
  hearing.feed(speak(0.4), hush(0.5));
  return hearing;
}

// ── AC1: the false form — the reading can go red ──────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipping module the mutation below copies. */
const SHIPPING_MODULE = path.join(HERE, 'voice-realtime-scripted-upstream.ts');

/** The prefix every falsify copy carries, so `server/tsconfig.json` excludes it from the program. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.join(HERE, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/**
 * THE LINE THAT CHOOSES BETWEEN THE TWO CLOCKS — the whole of decision doc §10.3 V-1's open question,
 * as one assignment. Removing it leaves `silenceElapsedMs` on the audio-time clock for BOTH bases: a
 * stand-in that never had the switch, and whose wall-clock readings are really sample readings.
 */
const VAD_TIME_BASE_SWITCH = "  if (timeBase === 'wall-clock') silenceElapsedMs = wallClockSilenceMs;\n";

type VadFactoryModule = { createScriptedVad: VadFactory };

async function importVadFactory(modulePath: string): Promise<VadFactory> {
  const module = (await import(pathToFileURL(modulePath).href)) as VadFactoryModule;
  return module.createScriptedVad;
}

/**
 * The scenario the contrast rests on: one syllable, and then the client STOPS TRANSMITTING. Nothing
 * else is ever appended, so the only thing that can end the utterance is a clock that keeps running
 * while the wire is quiet — `advance` moves the wall clock, and on the audio-time base it cannot.
 */
function stopAfterSpeech(create: VadFactory, timeBase: ScriptedVadTimeBase): number {
  const hearing = hearWith(create, base(timeBase));
  hearing.feed(speak(0.4));
  hearing.clock(SILENCE_MS + 1);
  return hearing.detector.speechStopped;
}

test('AC1 false form: with the time-base switch removed both bases measure samples, and the contrast goes red', async () => {
  const source = readFileSync(SHIPPING_MODULE, 'utf8');
  assert.equal(
    source.split(VAD_TIME_BASE_SWITCH).length - 1,
    1,
    'the clock switch must occur exactly once, or the mutation below is not the one this form means',
  );
  const mutated = source.replace(VAD_TIME_BASE_SWITCH, '');
  assert.notEqual(mutated, source, 'the mutation must actually change the source');

  const basePath = ownCopy('vad-base');
  const mutPath = ownCopy('vad-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, mutated, 'utf8');
    const shipping = await importVadFactory(basePath);
    const mutant = await importVadFactory(mutPath);

    // Unmutated: the two bases DISAGREE on the same wire — the contrast every later leg reads.
    assert.equal(stopAfterSpeech(shipping, 'audio-time'), 0, 'audio-time cannot close a turn the client stopped feeding');
    assert.equal(stopAfterSpeech(shipping, 'wall-clock'), 1, 'wall-clock closes it with no further audio');

    // Mutated: the "wall-clock" run is an audio-time run wearing the name, so the
    // contrast is gone and the criterion above reddens HERE.
    assert.equal(stopAfterSpeech(mutant, 'audio-time'), 0);
    assert.equal(
      stopAfterSpeech(mutant, 'wall-clock'),
      0,
      'with the switch gone the wall clock is never read, so the two bases agree and the reading is dead',
    );
    assert.notEqual(
      stopAfterSpeech(shipping, 'wall-clock'),
      stopAfterSpeech(mutant, 'wall-clock'),
      'the mutation must be the difference the contrast leg reads',
    );
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC2: the detector's behaviour matrix ──────────────────────────────────────────────────────

test('AC2: silence past silence_duration_ms closes the utterance, commits it and opens the response — on both bases', () => {
  for (const timeBase of ['audio-time', 'wall-clock'] as const) {
    const transcript = `把 server 的日志贴出来 (${timeBase})`;
    const hearing = hear(base(timeBase, { turns: [{ text: transcript }] }));

    hearing.feed(speak(0.4));
    assert.equal(hearing.detector.speechStarted, 1, `${timeBase}: a loud frame opens the utterance`);

    // Below the configured duration nothing closes: the tail is not yet long enough.
    hearing.feed(hush(0.3));
    if (timeBase === 'wall-clock') hearing.clock(300);
    assert.equal(hearing.detector.speechStopped, 0, `${timeBase}: 300 ms is below the configured ${SILENCE_MS} ms`);

    // At the duration the endpoint closes it by itself.
    hearing.feed(hush(0.5));
    if (timeBase === 'wall-clock') hearing.clock(SILENCE_MS + 1);

    assert.equal(hearing.count('input_audio_buffer.speech_stopped'), 1, timeBase);
    assert.equal(hearing.count('input_audio_buffer.committed'), 1, timeBase);
    assert.equal(hearing.count('conversation.item.created'), 1, timeBase);
    assert.equal(
      hearing.only('conversation.item.input_audio_transcription.completed').transcript,
      transcript,
      `${timeBase}: the closed item carries its own words`,
    );
    assert.equal(hearing.detector.items.length, 1, timeBase);
    assert.equal(hearing.detector.opportunities, 1, `${timeBase}: one turn, one opportunity`);

    // The endpoint's order: the detector stops, the buffer commits, the item enters, and only THEN
    // does a response exist.
    const order = [
      'input_audio_buffer.speech_stopped',
      'input_audio_buffer.committed',
      'conversation.item.created',
      'response.created',
    ].map((type) => hearing.indexOf(type));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      `${timeBase}: the narration must be in order, got ${JSON.stringify(hearing.types())}`,
    );

    // "Automatic" read literally: the client asked for none of it.
    assert.equal(
      hearing.sent.some((frame) => frame.type === 'input_audio_buffer.commit' || frame.type === 'response.create'),
      false,
      `${timeBase}: the opportunity is the endpoint's own — P-3 forbids a client commit under server_vad`,
    );
    assert.deepEqual(hearing.callsTo('session_send'), [{ message: transcript }], timeBase);
  }
});

test('AC2: with only speech frames sent, audio-time never closes and wall-clock closes on the clock', () => {
  const audioTime = hearWith(createScriptedVad, base('audio-time'));
  audioTime.feed(speak(0.4));
  audioTime.clock(SILENCE_MS * 10);
  assert.equal(audioTime.detector.speechStarted, 1);
  assert.equal(audioTime.detector.speechStopped, 0, 'audio-time has received no silent samples, so there is no silence to measure');

  const wallClock = hearWith(createScriptedVad, base('wall-clock'));
  wallClock.feed(speak(0.4));
  wallClock.clock(SILENCE_MS + 1);
  assert.equal(wallClock.detector.speechStarted, 1);
  assert.equal(wallClock.detector.speechStopped, 1, 'wall-clock reaches the duration while the wire is quiet');
  assert.equal(wallClock.count('input_audio_buffer.speech_stopped'), 1);
  assert.equal(wallClock.count('input_audio_buffer.committed'), 1);
});

test('AC2 stop-transmit then resume: audio-time merges the two speech runs, wall-clock splits them', () => {
  const turns: ScriptedVadTurn[] = [{ text: '我想想' }, { text: '然后跑一下测试' }];

  const audioTime = hear(base('audio-time', { turns }));
  audioTime.feed(speak(0.4), hush(0.3)); // a 300 ms tail — under the duration
  // The client stops transmitting. No frames arrive, and the audio-time clock cannot move; a
  // wall-clock detector would have ended the turn right here (decision doc §10's whole premise).
  audioTime.clock(30_000);
  audioTime.feed(speak(0.4), hush(0.5)); // resume, then the tail that really closes it
  assert.equal(audioTime.detector.speechStarted, 1, 'audio-time: the resumed speech continues the SAME utterance');
  assert.equal(audioTime.detector.speechStopped, 1);
  assert.equal(audioTime.detector.items.length, 1, 'audio-time: one item, heard straight across the stall');

  const wallClock = hear(base('wall-clock', { turns }));
  wallClock.feed(speak(0.4), hush(0.3));
  wallClock.clock(SILENCE_MS + 1); // the turn ends with NO further audio at all
  assert.equal(wallClock.detector.speechStopped, 1, 'wall-clock: the client`s silence is part of the measurement');
  assert.equal(wallClock.detector.items.length, 1);
  wallClock.feed(speak(0.4), hush(0.5));
  wallClock.clock(SILENCE_MS * 3);
  assert.equal(wallClock.detector.speechStarted, 2, 'wall-clock: the resumed speech is a NEW utterance');
  assert.equal(wallClock.detector.items.length, 2);

  assert.equal(
    wallClock.detector.speechStopped,
    audioTime.detector.speechStopped + 1,
    'the two bases must NOT agree on a stop-transmit: that difference is the open question V-1 asks',
  );
});

test('AC2: the threshold decides — a weak tail still ends the turn, and a quiet floor is not speech', () => {
  // A tail BELOW the gate is silence: the utterance closes on it like any other tail.
  const weakTail = hear(base('audio-time', { turns: [{ text: '弱尾音' }] }));
  weakTail.feed(speak(0.4), append(0.5, 0.4));
  assert.equal(weakTail.detector.speechStopped, 1, 'a weak tail is below the gate, therefore silence, therefore a tail');

  // Speech BELOW the gate is not speech: no utterance is ever opened.
  const quiet = hear(base('audio-time'));
  quiet.feed(append(0.8, QUIET_AMPLITUDE), hush(0.6));
  assert.equal(quiet.detector.speechStarted, 0, 'the shipped 0.5 gate does not hear 0.3');

  // The same audio with a gate put under it does open one — what decides is the threshold.
  const loudEnough = hear(base('audio-time', { threshold: 0.2, turns: [{ text: '低音量' }] }));
  loudEnough.feed(append(0.8, QUIET_AMPLITUDE), hush(0.6));
  assert.equal(loudEnough.detector.speechStarted, 1);
  assert.deepEqual(loudEnough.detector.forwarded, ['低音量']);

  // Background noise ABOVE the gate triggers the detector with nobody speaking — the direction the
  // PRODUCT has to survive, and the stand-in's job is to reproduce it, not to be nice about it.
  const noisy = hear(base('audio-time'));
  noisy.feed(append(1.0, 0.6), hush(0.6));
  assert.equal(noisy.detector.speechStarted, 1, 'a noise floor above the gate is heard as speech');

  // Below the gate it is neither speech nor a stall: the real speech run still closes on schedule.
  const floor = hear(base('audio-time', { turns: [{ text: '噪声底' }] }));
  floor.feed(speak(0.4), append(0.5, 0.45));
  assert.equal(floor.detector.speechStarted, 1);
  assert.equal(floor.detector.speechStopped, 1, 'a sub-threshold floor must not hold the utterance open');
});

test('AC2 model policy forward: the utterance reaches session_send, and the record names the text it sent', () => {
  const hearing = oneTurn({ text: '甲', policy: 'forward' });
  assert.deepEqual(hearing.detector.forwarded, ['甲']);
  assert.deepEqual(hearing.callsTo('session_send'), [{ message: '甲' }]);
  assert.equal(hearing.detector.records[0]!.disposition, 'forwarded');
  assert.equal(hearing.detector.records[0]!.sentText, '甲');
});

test('AC2 model policy silent: the utterance is heard and never delivered', () => {
  const hearing = oneTurn({ text: '乙', policy: 'silent' });
  assert.deepEqual(hearing.detector.forwarded, []);
  assert.equal(hearing.callsTo('session_send').length, 0);
  assert.equal(hearing.detector.records[0]!.disposition, 'unforwarded');
  assert.equal(hearing.detector.records[0]!.sentText, null);
  // Still HEARD: the item and the transcript exist, so "unforwarded" is never "unheard" (X-2).
  assert.equal(hearing.only('conversation.item.input_audio_transcription.completed').transcript, '乙');
  assert.equal(hearing.detector.items.length, 1);
});

test('AC2 model policy wait: the deferred text rides the NEXT opportunity`s forward as one message (X-4)', () => {
  const hearing = hear(base('audio-time', { turns: [{ text: '丙', policy: 'wait' }, { text: '丁', policy: 'forward' }] }));
  hearing.feed(speak(0.4), hush(0.5));
  assert.deepEqual(hearing.detector.forwarded, [], 'a wait delivers nothing at its own opportunity');
  assert.equal(hearing.detector.records[0]!.disposition, 'merged');

  hearing.feed(speak(0.4), hush(0.5));
  assert.deepEqual(hearing.detector.forwarded, ['丙丁'], 'the deferred text rides the next forward');
  assert.deepEqual(hearing.callsTo('session_send'), [{ message: '丙丁' }], 'ONE message, not two — that is the debounce');
  assert.equal(hearing.detector.records[0]!.disposition, 'forwarded', 'the deferred record is back-filled');
  assert.equal(hearing.detector.records[0]!.sentText, '丙丁');
  assert.equal(hearing.detector.records[1]!.sentText, '丙丁');
});

test('AC2 model policy interrupt: the opportunity calls session_interrupt with its intent (X-5)', () => {
  const hearing = oneTurn({ text: '戊', policy: 'interrupt', intent: '改成跑 lint' });
  assert.deepEqual(hearing.callsTo('session_interrupt'), [{ intent: '改成跑 lint' }]);
  assert.equal(hearing.callsTo('session_send').length, 0, 'an interrupt is not a delivery');
  assert.equal(hearing.detector.records[0]!.disposition, 'interrupted');
});

test('AC2 model policy text: the model answers in text and calls no tool (MODEL_TEXT_REPLY)', () => {
  const hearing = oneTurn({ text: '己', policy: 'text' });
  assert.equal(hearing.callsTo('session_send').length, 0);
  assert.equal(hearing.callsTo('session_interrupt').length, 0);
  assert.equal(hearing.count('response.text.done'), 1);
  assert.equal(hearing.detector.records[0]!.disposition, 'text');
});

test('AC2: a payload with no reading as audio is not evidence — it moves neither clock', () => {
  const hearing = hear(base('audio-time', { turns: [{ text: '不该被关掉' }] }));
  hearing.feed(speak(0.4));
  hearing.feed({ type: 'input_audio_buffer.append' }); // no payload at all
  hearing.feed({ type: 'input_audio_buffer.append', audio: '' }); // empty
  hearing.feed({ type: 'input_audio_buffer.append', audio: 'AA==' }); // one byte: not a sample
  assert.equal(hearing.detector.speechStopped, 0, 'an undecodable append must not be counted as silence and end the turn');
  assert.equal(hearing.detector.speechStarted, 1);
});

test('AC2: a client that switches the endpoint`s detector off is no longer heard', () => {
  const hearing = hear(base('audio-time', { turns: [{ text: 'x' }] }));
  hearing.feed({ type: 'session.update', session: { turn_detection: null } });
  assert.equal(hearing.detector.turnDetection, null, 'the switch is read off session.update, like the protocol machine`s');
  hearing.feed(speak(0.4), hush(0.6));
  assert.equal(hearing.detector.speechStarted, 0);
  assert.equal(hearing.detector.speechStopped, 0);
});

test('the false-form copies this process made are all gone', () => {
  const leftovers = readdirSync(HERE).filter(
    (entry) => entry.startsWith(TEMP_PREFIX) && entry.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, [], 'every falsify copy must be removed in a finally');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// THE EXIT PAIR — `gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard`, leg A
//
// Live 2026-10-16 01:06 (journal `cae49fed`): a delivery landed at 17:06:05, and for the next 44 s the
// connection carried nothing at all — zero `speech_started`, zero transcriptions, and zero frames
// released by the uplink gate (`audioTokens` read 294 in both of the endpoint's usage records). The
// browser then sent its close frame, and the exit path sent its unconditional pair anyway. The commit
// was refused ("buffer too small, or have no audio") — the benign refusal §6.4 documents — but the
// `response.create` still opened a whole response over the history, and the model used it to re-send
// an utterance the relay had already delivered, rewritten, as a second message.
//
// What the pair is FOR is stated where it lives: do not let an immediate close swallow the tail the
// gate's flush just released. That reason needs a tail. These two legs read the two sides of it — the
// pair omitted when there is nothing to close, and the pair unchanged when there is.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

/** The browser end of the socket, driven directly — the same stand-in the sibling suites use. */
class ExitBrowserSocket extends EventEmitter {
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

  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** One grid frame — exactly the bytes the gate's index space counts in. */
function uplinkFrame(speech: boolean, index: number): { index: number; audio: string; speech: boolean } {
  const pcm = Buffer.alloc(UPLINK_VAD_FRAME_BYTES);
  for (let sample = 0; sample < UPLINK_VAD_FRAME_BYTES / 2; sample += 1) {
    // Room tone for silence, a loud square for speech: the classifier below is SCRIPTED, so the level
    // only has to be real audio of the right length, not something a level gate would agree with.
    pcm.writeInt16LE(sample % 2 === 0 ? (speech ? 8_000 : 12) : speech ? -8_000 : -12, sample * 2);
  }
  // A small unique head marker, so a leg can name the frame that crossed the wire rather than one of
  // the right size (the same device the seam suite uses).
  pcm.writeInt16LE((index % 7) + 1, 0);
  return { index, audio: pcm.toString('base64'), speech };
}

/** Builds one corpus from a compact spec. */
function uplinkFrames(specs: ReadonlyArray<{ speech: boolean; count: number }>): Array<{ index: number; audio: string; speech: boolean }> {
  const frames: Array<{ index: number; audio: string; speech: boolean }> = [];
  for (const spec of specs) {
    for (let n = 0; n < spec.count; n += 1) {
      frames.push(uplinkFrame(spec.speech, frames.length));
    }
  }
  return frames;
}

/**
 * A classifier whose verdicts are scripted by the corpus, with an optional lag in frames.
 *
 * `lag` is what puts frames INSIDE the gate at the moment of the exit: `flush` then has something to
 * release, which is the case the exit pair exists for.
 */
function scriptedClassifier(pattern: readonly boolean[], lag = 0): UplinkVadClassifier {
  const queue: UplinkVadFrameVerdict[] = [];
  let next = 0;
  return {
    backend: 'webrtc',
    status: 'available',
    reason: null,
    async classify(): Promise<UplinkVadFrameVerdict | null> {
      const index = next;
      next += 1;
      const speech = pattern[index] ?? true;
      queue.push({ frameIndex: index, speech, probability: speech ? 0.9 : 0.05, bypassed: false, reason: null });
      if (queue.length <= lag) {
        return null;
      }
      return queue.shift() as UplinkVadFrameVerdict;
    },
    async flush(): Promise<UplinkVadFrameVerdict[]> {
      return queue.splice(0);
    },
    async close(): Promise<void> {},
  };
}

type ExitWired = {
  socket: ExitBrowserSocket;
  transports: FakeTransport[];
  logs: string[];
};

/** One continuous-mode proxy connection with the uplink gate armed and an exit path on close. */
function wireExit(classifier: UplinkVadClassifier, exitWaitMs = 20): ExitWired {
  const socket = new ExitBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => ({ session_send: async () => ({ runId: 'run-1', queued: false }) }),
    instructions: 'test instructions',
    segmentedRelay: false,
    stallMs: 10_000,
    log: (line) => logs.push(line),
    uplinkVad: { classifier, exitWaitMs },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs };
}

const exitOpened = (socket: ExitBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

/** Every client→server message the active upstream was handed, in order. */
const exitSentTypes = (wired: ExitWired): string[] =>
  (wired.transports[0]?.sent ?? []).map((message) => message.type);

/** Feeds one corpus, yielding to the event loop between chunks so the gate's async chain can run. */
async function feedExit(wired: ExitWired, frames: ReadonlyArray<{ audio: string }>): Promise<void> {
  for (let index = 0; index < frames.length; index += 1) {
    wired.socket.receive({ type: 'audio', audio: frames[index]!.audio });
    if ((index + 1) % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/** Lets the gate's chain and any teardown microtask settle. */
const exitSettle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser's own exit: the close FRAME, then the socket close (see `useVoiceRealtimeSession.ts`). */
function browserExit(wired: ExitWired): void {
  wired.socket.receive({ type: 'close' });
  wired.socket.close();
}

test('leg A: an exit with nothing to commit sends neither commit nor response.create, and still tears down', async () => {
  const frames = uplinkFrames([
    { speech: false, count: 10 },
    { speech: true, count: 20 },
  ]);
  const wired = wireExit(scriptedClassifier(frames.map((frame) => frame.speech)));
  await waitFor(() => exitOpened(wired.socket), 2_000);
  await feedExit(wired, frames);
  await exitSettle();

  // The endpoint COMMITS what it has received. Everything this connection sent is accounted for from
  // here on, and nothing follows it: the live connection's own 44 seconds of nothing.
  wired.transports[0]!.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_exit_0' });
  await exitSettle();

  browserExit(wired);
  await waitFor(() => wired.socket.readyState === WS.CLOSED, 2_000);
  await exitSettle();

  const types = exitSentTypes(wired);
  assert.equal(
    types.includes('input_audio_buffer.commit'),
    false,
    `with nothing to commit the exit must not send a commit at all, got ${JSON.stringify(types)}`,
  );
  assert.equal(
    types.includes('response.create'),
    false,
    `and must not open a response over the history — that is what the model re-sent into, got ${JSON.stringify(types)}`,
  );
  assert.ok(
    wired.logs.some((line) => line.includes('uplink_vad exit: nothing to commit')),
    `the omission must be recorded, so a bare close reads as "nothing to commit" and not "the pair was lost": ${wired.logs.join(' | ')}`,
  );
  // The connection still ended: the exit path's omission is not a skipped teardown.
  assert.equal(wired.socket.readyState, WS.CLOSED);
});

test('leg A shape preserved: an exit with a tail still to flush, or an open upstream turn, keeps the pair', async () => {
  // (a) THE TAIL THE GATE STILL HOLDS. A classifier lagging three frames means three verdicts are
  // inside it when the exit drains, so `flush` releases audio that a bare close WOULD swallow — the
  // case the pair exists for. The endpoint then commits (so nothing else can be the trigger) and the
  // browser exits.
  const lagged = uplinkFrames([
    { speech: false, count: 10 },
    { speech: true, count: 20 },
  ]);
  const withTail = wireExit(scriptedClassifier(lagged.map((frame) => frame.speech), 3));
  await waitFor(() => exitOpened(withTail.socket), 2_000);
  await feedExit(withTail, lagged);
  await exitSettle();
  withTail.transports[0]!.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_exit_0' });
  await exitSettle();

  browserExit(withTail);
  await waitFor(() => withTail.socket.readyState === WS.CLOSED, 2_000);
  await exitSettle();
  assertPairInOrder(withTail, 'a tail the gate still holds');

  // (b) AN OPEN UPSTREAM TURN. Nothing is pending anywhere — the endpoint committed, so no frame has
  // crossed since — but its own detector has announced `speech_started` and never closed it. A bare
  // close here would end a turn the endpoint is still holding open, so the pair is sent.
  const openTurn = uplinkFrames([
    { speech: false, count: 10 },
    { speech: true, count: 20 },
  ]);
  const talking = wireExit(scriptedClassifier(openTurn.map((frame) => frame.speech)));
  await waitFor(() => exitOpened(talking.socket), 2_000);
  await feedExit(talking, openTurn);
  await exitSettle();
  talking.transports[0]!.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_exit_0' });
  await exitSettle();
  talking.transports[0]!.peerSend({ type: 'input_audio_buffer.speech_started' });
  await exitSettle();

  browserExit(talking);
  await waitFor(() => talking.socket.readyState === WS.CLOSED, 2_000);
  await exitSettle();
  assertPairInOrder(talking, 'an upstream turn still open');
});

/**
 * The exit pair, read off the wire: `commit` → `response.create` adjacent, in that order, with
 * nothing after them — §6.3's sequence, unchanged by this task.
 */
function assertPairInOrder(wired: ExitWired, why: string): void {
  const types = exitSentTypes(wired);
  const commitAt = types.indexOf('input_audio_buffer.commit');
  const responseAt = types.indexOf('response.create');
  assert.notEqual(commitAt, -1, `${why}: the exit must still send the commit, got ${JSON.stringify(types)}`);
  assert.equal(responseAt, commitAt + 1, `${why}: response.create must follow the commit immediately, got ${JSON.stringify(types)}`);
  assert.equal(
    types.slice(responseAt + 1).length,
    0,
    `${why}: nothing may cross the wire after response.create on the exit path, got ${JSON.stringify(types)}`,
  );
}
