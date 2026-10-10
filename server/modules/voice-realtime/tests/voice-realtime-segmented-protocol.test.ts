/**
 * The segmented relay's server half — SPEC `docs/proposals/voice-realtime-segmented-relay-SPEC.md`,
 * §C1 (the frame protocol), §提交方式 (the two commit protocols) and §失败模式 (the replay).
 *
 * WHAT THIS FILE IS FOR. The continuous path is proved by the AC-316/AC-317 suites. This file is the
 * SEGMENTED path: the browser cuts speech at pauses and numbers the pieces, and the server must
 * (a) forward only the speech (a 200 s recording with four sentences must not put 200 s of audio
 * upstream), (b) close each segment exactly once, in an order that never commits before the audio it
 * closes, (c) survive an upstream drop between the commit and its response without the session
 * receiving one thought twice, and (d) not lose the last sentence when the user ends or mutes
 * mid-segment.
 *
 * FULLY OFFLINE. A fake `RealtimeTransport` (the same `createFakeTransport` the AC-310/AC-311 suites
 * use) stands in for the upstream, and a minimal EventEmitter stands in for the browser's WebSocket.
 * No socket, no microphone, no credential.
 *
 * TWO IMPLEMENTATIONS, ONE SUITE. `manual` turns the endpoint's own VAD off and closes a segment with
 * `input_audio_buffer.commit` + `response.create`; `server-vad` (the fallback the SPEC names for the
 * case where S1 concludes manual commit is unavailable) leaves the endpoint's detector on and lets
 * real silence close the segment. Every case below runs under BOTH, with the assertions the mode
 * actually has: a mode-agnostic invariant where one exists, and the mode's own vocabulary where the
 * two genuinely differ.
 *
 * WHAT THE FALSE FORMS PIN. The last block writes mutated copies of the shipping modules BESIDE them
 * (`__criterion-falsify-<label>-<pid>.ts`, excluded from `server/tsconfig.json` by name, removed in a
 * `finally`) and drives the same readings through them: dropping the `seq` dedup must redden the
 * idempotency case, moving the commit before the segment's last append must redden the commit-order
 * case, and removing the teardown flush must redden the End/Mute case.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-segmented-protocol.test.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';
import { WebSocket as WS } from 'ws';

import {
  REALTIME_TOOLS,
  connect,
  createDashscopeTransport,
  parseWavPcm16,
  runVoiceRealtimeDiagnosis,
  type DashscopeWireObserver,
  type RealtimeBridge,
  type RealtimeClientMessage,
  type RealtimeSegmentCommitMode,
  type RealtimeToolExecutor,
} from '../index.js';
import {
  VOICE_REALTIME_INSTRUCTIONS,
  handleVoiceRealtimeConnection,
  readVoiceRealtimeInboundFrame,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { createVoiceRealtimeRouter } from '../voice-realtime.routes.js';

import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';
import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── the audio vocabulary ──────────────────────────────────────────────────────────────────────

/** The rate the Realtime session's `pcm16` input expects, and the rate every frame below is at. */
const PCM_RATE = 16_000;
/** One frame is the browser worklet's own cadence (the diagnosis service's `CHUNK_MS` too). */
const CHUNK_MS = 100;
/** Bytes in one 100 ms mono 16-bit frame. */
const FRAME_BYTES = ((PCM_RATE * CHUNK_MS) / 1000) * 2;
/** Distinct, non-silent frames, so an ordering assertion can name which audio went where. */
const FRAME_A = Buffer.alloc(FRAME_BYTES, 0x0a).toString('base64');
const FRAME_B = Buffer.alloc(FRAME_BYTES, 0x0b).toString('base64');
const FRAME_C = Buffer.alloc(FRAME_BYTES, 0x0c).toString('base64');
/** What the fallback appends to close a segment: exactly `silenceFrames(commitGapMs)`'s output. */
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0).toString('base64');

/** The two segmented implementations this suite is parameterized over. */
const MODES: readonly RealtimeSegmentCommitMode[] = ['manual', 'server-vad'];

/** Seconds of audio the upstream was actually handed, from the base64 appends' decoded length. */
function upstreamSeconds(transport: FakeTransport): number {
  let bytes = 0;
  for (const message of transport.sent) {
    if (message.type === 'input_audio_buffer.append') {
      bytes += Buffer.from(message.audio, 'base64').length;
    }
  }
  return bytes / 2 / PCM_RATE;
}

/** Everything the upstream was told, as a list of frame types, in order. */
const sentTypes = (transport: FakeTransport): string[] => transport.sent.map((message) => message.type);

/** The base64 payloads of every appended frame, in order. */
const appendedAudio = (transport: FakeTransport): string[] =>
  transport.sent.flatMap((message) => (message.type === 'input_audio_buffer.append' ? [message.audio] : []));

/** The frame types that are the segmented path's OWN traffic — the manual VAD switch left out. */
const segmentTraffic = (transport: FakeTransport): string[] =>
  sentTypes(transport).filter((type) => type !== 'session.turn_detection');

const countOf = (transport: FakeTransport, type: string): number =>
  transport.sent.filter((message) => message.type === type).length;

/** Whether the connection told the endpoint to turn its own detector off (`turn_detection: null`). */
const vadWasDisabled = (transport: FakeTransport): boolean =>
  transport.sent.some((message) => message.type === 'session.turn_detection' && message.turnDetection === null);

/**
 * How many times the upstream has been told a segment is closed, in the mode's own vocabulary —
 * a `commit` under `manual`, the fallback's block of real silence under `server-vad`.
 */
function closeWrites(transport: FakeTransport, mode: RealtimeSegmentCommitMode): number {
  return mode === 'manual'
    ? countOf(transport, 'input_audio_buffer.commit')
    : appendedAudio(transport).filter((audio) => audio === SILENCE_FRAME).length;
}

/** One macrotask tick: lets a `void`-started async step settle before a synchronous reading. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── the fake browser socket ───────────────────────────────────────────────────────────────────

/** The minimal `ws.WebSocket` surface the proxy uses, driven over an EventEmitter. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: VoiceRealtimeInboundFrame | Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** A recording stand-in for the live executor: it never touches a session, it only records. */
function createRecordingExecutor(): { calls: Array<Record<string, unknown>>; executor: RealtimeToolExecutor } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    executor: {
      session_send: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { accepted: args.message };
      },
    },
  };
}

/** Delivers one `function_call` event from the fake upstream for `session_send`. */
function deliverSessionSend(transport: FakeTransport, callId: string, message: string): void {
  transport.peerSend({ type: 'function_call', name: 'session_send', callId, arguments: JSON.stringify({ message }) });
}

type Handler = typeof handleVoiceRealtimeConnection;

/** Wires one proxy connection over a fake browser socket, a fake upstream and a recording executor. */
function wire(options: { mode: RealtimeSegmentCommitMode; handle?: Handler }): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  calls: Array<Record<string, unknown>>;
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createRecordingExecutor();
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
    segmentCommit: options.mode,
  };
  (options.handle ?? handleVoiceRealtimeConnection)(
    socket as unknown as Parameters<Handler>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, calls: base.calls };
}

/** Waits until one proxy connection is open and usable. */
async function openSocket(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

// ── AC1: the frame protocol itself ────────────────────────────────────────────────────────────

test('the inbound frame reader separates the segmented frames from the continuous one', () => {
  // The segmented frames, with the fields each carries.
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'segment_start', seq: 3, startedAtMs: 120 })), {
    type: 'segment_start',
    seq: 3,
    startedAtMs: 120,
  });
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'audio', audio: 'AAA', seq: 3 })), {
    type: 'audio',
    audio: 'AAA',
    seq: 3,
  });
  assert.deepEqual(
    readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'segment_end', seq: 3, durationMs: 900, reason: 'max' })),
    { type: 'segment_end', seq: 3, durationMs: 900, reason: 'max' },
  );

  // The continuous frame is the SAME shape it always was — the absence of `seq` is the switch.
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'audio', audio: 'AAA' })), {
    type: 'audio',
    audio: 'AAA',
  });
  // A `seq` that is not an integer is refused rather than coerced: guessing an idempotency key is
  // worse than dropping the frame, which the page already treats as unacknowledged.
  assert.equal(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'segment_start', seq: 'x' })), null);
  assert.equal(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'audio', audio: 'AAA', seq: 1.5 })), null);
  // An unknown `reason` is dropped from the frame, not invented.
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'segment_end', seq: 1, reason: 'nonsense' })), {
    type: 'segment_end',
    seq: 1,
  });
  assert.deepEqual(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'close' })), { type: 'close' });
});

// ── AC2: only the speech goes upstream ────────────────────────────────────────────────────────

/**
 * The AC2 recording, modelled without a sound card: 200 s of wall clock of which only four
 * sentences are speech. The browser's segmenter is the thing that decides what that is; here the
 * test IS the segmenter and sends only the speech windows, which is the whole claim under test —
 * that a segmented client does not stream the silences between what was said.
 */
const AC2_SEGMENTS = [0, 1, 2, 3].map((seq) => ({ seq, frames: 40 })); // 4 s each = 16 s of speech

for (const mode of MODES) {
  test(`AC2 (${mode}): a 200 s recording with four sentences puts <= 25 s of audio upstream`, async () => {
    const { socket, transport } = wire({ mode });
    await openSocket(socket, transport);

    for (const segment of AC2_SEGMENTS) {
      socket.receive({ type: 'segment_start', seq: segment.seq });
      for (let frame = 0; frame < segment.frames; frame += 1) {
        socket.receive({ type: 'audio', audio: FRAME_A, seq: segment.seq });
      }
      socket.receive({ type: 'segment_end', seq: segment.seq, durationMs: 4_000, reason: 'gap' });
    }

    // The ~184 s of silence between the sentences never left the page: the only audio upstream is
    // the 16 s of speech, plus (fallback only) the bounded real silence that closes each segment.
    const seconds = upstreamSeconds(transport);
    assert.ok(seconds <= 25, `upstream received ${seconds.toFixed(1)} s of a 200 s recording (must be <= 25 s)`);
    assert.ok(seconds >= 16, `the speech itself must reach the upstream (saw ${seconds.toFixed(1)} s)`);
    if (mode === 'manual') {
      assert.equal(seconds, 16, 'manual mode forwards exactly the speech, nothing else');
    } else {
      assert.equal(seconds, 24, "the fallback's closing silence is bounded by commitGapMs");
    }
  });

  test(`AC2 legacy (${mode}): the same recording over the continuous protocol is forwarded frame for frame`, async () => {
    const { socket, transport } = wire({ mode });
    await openSocket(socket, transport);

    // The same 200 s timeline, but every frame is sent — which is what a non-segmenting client
    // does. Nothing about that path may change.
    const frames = Array.from({ length: 2000 }, (_, index) => Buffer.alloc(FRAME_BYTES, index % 251).toString('base64'));
    for (const audio of frames) {
      socket.receive({ type: 'audio', audio });
    }

    assert.deepEqual(appendedAudio(transport), frames, 'every legacy frame reaches the upstream, in order');
    // The continuous path never closes a segment and never switches the detector: a segmented
    // connection is the only thing that sends any of those.
    assert.equal(countOf(transport, 'input_audio_buffer.commit'), 0);
    assert.equal(countOf(transport, 'response.create'), 0);
    assert.equal(vadWasDisabled(transport), false, 'a continuous client keeps the endpoint VAD');
    assert.equal(upstreamSeconds(transport), 200, 'the continuous path still streams the whole recording');
  });
}

// ── AC3: one commit and one response.create per segment, after its last append ────────────────

/** Drives a fixed two-segment script straight over the bridge, returning the upstream traffic. */
async function driveCommitOrder(
  connectFn: typeof connect,
  mode: RealtimeSegmentCommitMode,
): Promise<FakeTransport> {
  const transport = createFakeTransport();
  const bridge: RealtimeBridge = connectFn(transport, REALTIME_TOOLS, {}, { segment: { commitMode: mode } });
  await bridge.whenConnected();
  bridge.startSegment(1);
  bridge.sendSegmentAudio(1, FRAME_A);
  bridge.sendSegmentAudio(1, FRAME_B);
  bridge.endSegment(1);
  bridge.startSegment(2);
  bridge.sendSegmentAudio(2, FRAME_C);
  bridge.endSegment(2);
  return transport;
}

for (const mode of MODES) {
  test(`AC3 (${mode}): each segment_end closes the segment exactly once, after its last append`, async () => {
    const transport = await driveCommitOrder(connect, mode);

    if (mode === 'manual') {
      // The literal reading of the criterion: the audio goes up, then the commit that closes it,
      // then the response it asks for — per segment, exactly once.
      assert.deepEqual(
        segmentTraffic(transport),
        [
          'input_audio_buffer.append',
          'input_audio_buffer.append',
          'input_audio_buffer.commit',
          'response.create',
          'input_audio_buffer.append',
          'input_audio_buffer.commit',
          'response.create',
        ],
        'the commit must follow the segment`s audio, never precede it',
      );
      assert.deepEqual(appendedAudio(transport), [FRAME_A, FRAME_B, FRAME_C], 'each segment carries its own frames');
      assert.equal(vadWasDisabled(transport), true, 'manual mode turns the endpoint`s own detector off');
    } else {
      // The fallback has no commit at all: the audio arrives as it was spoken, and the segment is
      // closed by appending up to `commitGapMs` of REAL silence (2 s = 20 frames of 100 ms).
      assert.equal(countOf(transport, 'input_audio_buffer.commit'), 0, 'the fallback never commits');
      assert.equal(countOf(transport, 'response.create'), 0, 'the fallback never asks for a response');
      assert.equal(vadWasDisabled(transport), false, 'the fallback keeps the endpoint`s detector on');
      const appends = appendedAudio(transport);
      assert.deepEqual(appends.slice(0, 2), [FRAME_A, FRAME_B], 'the fallback forwards each frame as it arrives');
      assert.equal(
        appends.slice(2, 22).every((audio) => audio === SILENCE_FRAME),
        true,
        'the segment closes with real silence',
      );
      assert.deepEqual(appends.slice(22), [FRAME_C, ...Array.from({ length: 20 }, () => SILENCE_FRAME)]);
    }
  });
}

// ── AC4: the replay is idempotent ─────────────────────────────────────────────────────────────

/**
 * AC4's scenario. One segment is committed; the model relays it, so the session has its text; the
 * upstream then drops BEFORE the response that would have settled the segment, and the bridge writes
 * the segment onto the new socket once more. The model may react to that replay too — and the
 * session must still end up with exactly one message.
 */
async function driveIdempotency(
  handle: Handler,
  mode: RealtimeSegmentCommitMode,
): Promise<{ calls: number; sentFrames: number }> {
  const { socket, transport, calls } = wire({ mode, handle });
  await openSocket(socket, transport);

  socket.receive({ type: 'segment_start', seq: 0 });
  socket.receive({ type: 'audio', audio: FRAME_A, seq: 0 });
  socket.receive({ type: 'segment_end', seq: 0, durationMs: 100, reason: 'gap' });
  await waitFor(() => closeWrites(transport, mode) >= 1);
  // What one segment's close looks like, counted in this mode's own vocabulary — one commit, or
  // one block of real silence. The replay below is the only thing that writes MORE than this.
  const closesAfterSegmentEnd = closeWrites(transport, mode);

  // The model relays the segment; the session is told once.
  deliverSessionSend(transport, 'call-1', '把超时改成五十秒');
  await waitFor(() => calls.length === 1);
  await waitFor(() => socket.outbound.filter((frame) => frame.type === 'sent').length === 1);

  // The drop lands after the commit and before `response.done`, so the segment never settled.
  const beforeDrop = transport.sent.length;
  transport.drop();
  // The replay really happened: strictly more of the mode's own close was written to the new
  // socket. Waiting on the INCREASE (not a fixed count) is what makes this hold in both modes —
  // the fallback's segment already wrote a whole block of silence, so `>= 2` would be a no-op there.
  await waitFor(() => closeWrites(transport, mode) > closesAfterSegmentEnd && transport.sent.length > beforeDrop);
  await waitFor(() => transport.openCalls >= 2);

  // The model reacts to the replayed audio a second time. The delivery side must recognise the
  // `seq` and answer the model as though it landed, without reaching the session again.
  deliverSessionSend(transport, 'call-2', '把超时改成五十秒');
  await waitFor(() => transport.sent.some((message) => message.type === 'function_call_output' && message.callId === 'call-2'));

  return { calls: calls.length, sentFrames: socket.outbound.filter((frame) => frame.type === 'sent').length };
}

for (const mode of MODES) {
  test(`AC4 (${mode}): a drop between the commit and its response replays the segment without a second delivery`, async () => {
    const { calls, sentFrames } = await driveIdempotency(handleVoiceRealtimeConnection, mode);
    assert.equal(calls, 1, 'the session must receive exactly one message for the segment');
    assert.equal(sentFrames, 1, 'the page must be told the instruction was delivered exactly once');
  });
}

// ── AC5: End / Mute does not lose the last sentence ───────────────────────────────────────────

/**
 * AC5's scenario. A segment was opened and audio arrived, but no `segment_end` did — the user
 * pressed End (or muted and closed) mid-sentence. The open segment must be closed once, with the
 * frames received, upstream.
 */
async function driveCloseFlush(
  handle: Handler,
  mode: RealtimeSegmentCommitMode,
  via: 'frame' | 'socket',
): Promise<FakeTransport> {
  const { socket, transport } = wire({ mode, handle });
  await openSocket(socket, transport);

  socket.receive({ type: 'segment_start', seq: 7 });
  socket.receive({ type: 'audio', audio: FRAME_A, seq: 7 });
  socket.receive({ type: 'audio', audio: FRAME_B, seq: 7 });

  if (via === 'frame') {
    socket.receive({ type: 'close' });
  } else {
    socket.close(); // the socket's own close event, with no `{type:'close'}` frame
  }
  await settle();
  return transport;
}

for (const mode of MODES) {
  for (const via of ['frame', 'socket'] as const) {
    test(`AC5 (${mode}, ${via}): the open segment is closed with the frames received`, async () => {
      const transport = await driveCloseFlush(handleVoiceRealtimeConnection, mode, via);

      if (mode === 'manual') {
        // The two frames that did arrive are written, then exactly one commit and one response.
        assert.deepEqual(appendedAudio(transport), [FRAME_A, FRAME_B], 'the frames received before the close are written');
        assert.equal(countOf(transport, 'input_audio_buffer.commit'), 1, 'exactly one commit');
        assert.equal(countOf(transport, 'response.create'), 1, 'exactly one response.create');
        // The commit follows the frames it closes, and the response follows the commit.
        assert.deepEqual(segmentTraffic(transport).slice(-4), [
          'input_audio_buffer.append',
          'input_audio_buffer.append',
          'input_audio_buffer.commit',
          'response.create',
        ]);
      } else {
        // The frames already went up as they arrived; the flush appends the fallback's silence.
        const appends = appendedAudio(transport);
        assert.deepEqual(appends.slice(0, 2), [FRAME_A, FRAME_B], 'the frames reached the upstream as they arrived');
        assert.equal(countOf(transport, 'input_audio_buffer.commit'), 0, 'the fallback never commits');
        assert.equal(appends.length, 22, 'the received frames plus the 2 s closing silence');
        assert.equal(
          appends.slice(2).every((audio) => audio === SILENCE_FRAME),
          true,
          'the flush closes the segment with real silence',
        );
      }
    });
  }
}

// ── a segment this connection never opened is refused, not invented ───────────────────────────

test('a segment_end for a segment that was never started is refused with a dropped ack', async () => {
  const { socket, transport } = wire({ mode: 'manual' });
  await openSocket(socket, transport);

  socket.receive({ type: 'segment_end', seq: 9 });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'segment_ack'));

  assert.deepEqual(socket.outbound.find((frame) => frame.type === 'segment_ack'), {
    type: 'segment_ack',
    seq: 9,
    state: 'dropped',
    reason: 'unknown-segment',
  });
  // Nothing was invented upstream: there was no audio to close.
  assert.deepEqual(appendedAudio(transport), []);
  assert.equal(countOf(transport, 'input_audio_buffer.commit'), 0);
});

// ── AC7: the diagnosis report carries the per-segment readings ────────────────────────────────

/** A mono 16 kHz PCM16 WAV of `seconds` of a tone. */
function makeWav(seconds: number): Buffer {
  const samples = Math.floor(PCM_RATE * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_RATE, 24);
  header.writeUInt32LE(PCM_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * A mono 16 kHz PCM16 WAV of voiced tone bursts over a low deterministic noise floor — the shape
 * `StreamingVad` reads as speech and a pause between bursts reads as a segment boundary. A flat
 * tone will NOT do: the detector's floor is the 15th percentile of recent frames, so a
 * constant-amplitude clip measures as loud silence and never fires.
 */
function makeSpeechWav(durationSec: number, bursts: ReadonlyArray<{ atSec: number; durSec: number }>): Buffer {
  const total = Math.round(PCM_RATE * durationSec);
  const samples = new Float32Array(total);
  let noise = 0;
  for (let index = 0; index < total; index += 1) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    samples[index] = ((noise / 0x7fffffff) * 2 - 1) * 1e-4;
  }
  const ramp = Math.max(1, Math.round(0.01 * PCM_RATE));
  for (const burst of bursts) {
    const from = Math.round(burst.atSec * PCM_RATE);
    const len = Math.round(burst.durSec * PCM_RATE);
    for (let index = 0; index < len && from + index < total; index += 1) {
      const envelope = Math.max(0, Math.min(1, index / ramp, (len - 1 - index) / ramp));
      const phase = (2 * Math.PI * 140 * index) / PCM_RATE;
      const tone = Math.sin(phase) * 0.6 + Math.sin(2 * phase) * 0.3 + Math.sin(3 * phase) * 0.15;
      samples[from + index] += tone * envelope * 0.05;
    }
  }
  const data = Buffer.alloc(total * 2);
  for (let index = 0; index < total; index += 1) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[index]! * 32768))), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_RATE, 24);
  header.writeUInt32LE(PCM_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('AC7: a segmented diagnosis reports segments[] and audioSecondsUpstream from the real wire', async () => {
  const upstream = createFakeDashscopeServer({
    toolName: 'session_send',
    toolArguments: JSON.stringify({ message: 'echo' }),
  });
  const sends: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { runId: 'r', queued: false };
    },
  };
  // The SAME seams `server/index.ts` builds: the REAL transport (so the wire observer sees what was
  // actually appended) over the fake upstream.
  const seams = {
    buildSeams: (observe: DashscopeWireObserver): VoiceRealtimeProxySeams => ({
      createTransport: (reportError: (error: { code: string } & Record<string, unknown>) => void) =>
        createDashscopeTransport({
          apiKey: 'sk-test',
          socketFactory: upstream.socketFactory,
          onError: reportError,
          observer: observe,
        }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
    }),
  };

  const clip = (parseWavPcm16(makeWav(0.4)) as { pcm16: Buffer }).pcm16;
  const segments = [0, 1, 2].map(() => ({ pcm16: clip, durationMs: 400, reason: 'gap' as const }));

  const report = await runVoiceRealtimeDiagnosis(
    { boundSessionId: 'sess', pcm16: clip, speed: 8, quietMs: 150, maxMs: 15_000, segments, segmentCommit: 'manual' },
    seams,
  );

  assert.equal(report.segments.length, 3, 'one report row per segment spoken');
  for (const [index, segment] of report.segments.entries()) {
    assert.equal(segment.seq, index);
    assert.equal(segment.durationMs, 400, 'the duration the segment was cut with');
    assert.equal(segment.commit, 'manual', 'the protocol the run was pinned to');
    assert.equal(segment.commits, 1, 'each segment produced exactly one commit upstream');
    assert.equal(segment.ack, 'committed', 'the page was told the segment was taken');
    assert.ok(segment.audioSeconds > 0 && segment.audioSeconds <= 0.45, `segment ${index}: ${segment.audioSeconds} s`);
  }
  // The whole-run reading: 3 × 0.4 s of speech, and no more.
  assert.ok(report.audioSecondsUpstream > 0, 'audioSecondsUpstream must be read off the wire, not left at zero');
  assert.ok(
    report.audioSecondsUpstream <= 3 * 0.4 + 0.05,
    `upstream received ${report.audioSecondsUpstream.toFixed(2)} s for 1.2 s of speech`,
  );
  assert.deepEqual(sends.map((args) => args.message), ['echo'], 'the model relayed the audio');
});

/**
 * Runs the CLI as a CHILD process and resolves with its streams. `spawn`, not `spawnSync`: the
 * server the CLI talks to runs in THIS process, so a synchronous wait would block the event loop
 * that has to answer the child's HTTP request — a deadlock, not a slow test.
 */
function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

test('AC7 CLI: `--segments` splits the clip here and prints each segment seq/duration/ack', async () => {
  // The route carries only a turn list, so the CLI cuts the WAV locally with the browser's relay
  // segmenter and sends the pieces as turns; forcing `segmentCommit` is the same switch the server
  // operator's `VOICE_REALTIME_SEGMENT_COMMIT=manual` throws in production.
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const executor: RealtimeToolExecutor = { session_send: async () => ({ runId: 'r' }) };
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api/voice-realtime',
    createVoiceRealtimeRouter({
      diagnose: async (input) =>
        runVoiceRealtimeDiagnosis(
          { ...input, segmentCommit: 'manual' },
          {
            buildSeams: (observe) => ({
              createTransport: (reportError) =>
                createDashscopeTransport({
                  apiKey: 'sk-test',
                  socketFactory: upstream.socketFactory,
                  onError: reportError,
                  observer: observe,
                }),
              createExecutor: () => executor,
              instructions: VOICE_REALTIME_INSTRUCTIONS,
            }),
          },
        ),
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-seg-cli-'));
  const wavPath = path.join(dir, 'clip.wav');
  // Two bursts with a >2 s pause after each, so the relay segmenter (called by the CLI) cuts them
  // apart and each commits on its own.
  writeFileSync(wavPath, makeSpeechWav(8, [{ atSec: 0.6, durSec: 0.6 }, { atSec: 3.6, durSec: 0.6 }]));
  try {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/voice-realtime-diagnose.mjs');
    // A non-zero exit is a normal reading here: the fake upstream never emits a final
    // transcription, so the run's `ok` is false and the CLI exits 1. The printed lines are the point.
    const result = await runCli([
      script, '--segments', '--speed', '8', '--quiet', '800',
      '--url', `http://127.0.0.1:${port}`, '--token', 't', '--session', 's', '--wav', wavPath,
    ]);
    const out = result.stdout;
    assert.match(result.stderr, /--segments: relay segmenter cut 2 segment/, result.stderr);
    assert.match(out, /segments: 2 \(audio upstream [\d.]+ s\)/, `${out}\n--- stderr ---\n${result.stderr}`);
    assert.match(out, /segment 0: \d+ ms manual ack=committed/, out);
    assert.match(out, /segment 1: \d+ ms manual ack=committed/, out);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC8: the false forms ──────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipping module directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
const SHIPPING_PROXY_MODULE = path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts');
const SHIPPING_BRIDGE_MODULE = path.join(MODULE_DIR, 'voice-realtime-bridge.service.ts');
/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Writes a mutated copy of `modulePath` beside it, runs `body` against the base and the mutant
 * paths, and removes both copies in a `finally`. The anchor must occur once — a mutation that
 * silently matched nothing would redden nothing and read as a green.
 */
async function withMutantCopy<T>(
  modulePath: string,
  anchor: string,
  mutation: string,
  label: string,
  body: (basePath: string, mutPath: string) => Promise<T>,
): Promise<T> {
  const source = readFileSync(modulePath, 'utf8');
  assert.equal(countOccurrences(source, anchor), 1, `the ${label} anchor must occur exactly once`);
  const basePath = ownCopy(`${label}-base`);
  const mutPath = ownCopy(`${label}-mut`);
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(anchor, mutation), 'utf8');
    return await body(basePath, mutPath);
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
}

/** Imports a proxy module by path; the specifier is dynamic, so it is typed structurally here. */
async function importProxy(modulePath: string): Promise<{ handleVoiceRealtimeConnection: Handler }> {
  return (await import(pathToFileURL(modulePath).href)) as { handleVoiceRealtimeConnection: Handler };
}

/** Imports a bridge module by path. */
async function importBridge(modulePath: string): Promise<{ connect: typeof connect }> {
  return (await import(pathToFileURL(modulePath).href)) as { connect: typeof connect };
}

test('AC8 false form (a): removing the seq dedup makes the idempotency case red', async () => {
  const DEDUP_GATE = 'if (activeSegmentSeq !== null && activeSegmentIsReplay && deliveredSegmentSeqs.has(activeSegmentSeq)) {';
  await withMutantCopy(SHIPPING_PROXY_MODULE, DEDUP_GATE, 'if (false) {', 'no-seq-dedup', async (basePath, mutPath) => {
    const base = await importProxy(basePath);
    const mutant = await importProxy(mutPath);
    const green = await driveIdempotency(base.handleVoiceRealtimeConnection, 'manual');
    assert.equal(green.calls, 1, 'unmutated: the replay produces no second delivery');
    const red = await driveIdempotency(mutant.handleVoiceRealtimeConnection, 'manual');
    assert.equal(red.calls, 2, 'without the dedup, the replay reaches the session a second time');
    assert.equal(red.sentFrames, 2, 'and the page is told twice');
  });
});

test('AC8 false form (b): committing before the segment`s last append makes the commit-order case red', async () => {
  const ORDER_ANCHOR = [
    '      for (const frame of frames) writeSegmentFrame(frame);',
    "      if (state !== 'open') return;",
    '      try {',
    "        transport.send({ type: 'input_audio_buffer.commit' });",
    "        transport.send({ type: 'response.create' });",
    '      } catch (cause) {',
    "        emitError({ code: 'SEND_FAILED', cause });",
    '      }',
  ].join('\n');
  const COMMIT_FIRST = [
    "      if (state !== 'open') return;",
    '      try {',
    "        transport.send({ type: 'input_audio_buffer.commit' });",
    "        transport.send({ type: 'response.create' });",
    '      } catch (cause) {',
    "        emitError({ code: 'SEND_FAILED', cause });",
    '      }',
    '      for (const frame of frames) writeSegmentFrame(frame);',
  ].join('\n');
  await withMutantCopy(SHIPPING_BRIDGE_MODULE, ORDER_ANCHOR, COMMIT_FIRST, 'commit-before-frames', async (basePath, mutPath) => {
    const base = await importBridge(basePath);
    const mutant = await importBridge(mutPath);
    const green = await driveCommitOrder(base.connect, 'manual');
    assert.deepEqual(segmentTraffic(green).slice(0, 4), [
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
      'response.create',
    ], 'unmutated: the commit follows the segment`s audio');
    const red = await driveCommitOrder(mutant.connect, 'manual');
    assert.equal(appendedAudio(red).length, 3, 'the mutated close still writes the frames — but only after the commit');
    assert.equal(segmentTraffic(red)[0], 'input_audio_buffer.commit', 'mutated: the commit now precedes every append');
  });
});

test('AC8 false form (c): removing the teardown flush makes the End/Mute case red', async () => {
  const FLUSH_ANCHOR = [
    '    const flushedSeq = bridge.flushOpenSegment();',
    '    if (flushedSeq !== null) {',
    '      seams.log?.(`teardown: closed the open segment seq=${flushedSeq} with the frames received`);',
    '    }',
    '',
  ].join('\n');
  await withMutantCopy(SHIPPING_PROXY_MODULE, FLUSH_ANCHOR, '', 'no-close-flush', async (basePath, mutPath) => {
    const base = await importProxy(basePath);
    const mutant = await importProxy(mutPath);
    for (const via of ['frame', 'socket'] as const) {
      const green = await driveCloseFlush(base.handleVoiceRealtimeConnection, 'manual', via);
      assert.equal(countOf(green, 'input_audio_buffer.commit'), 1, `unmutated: the open segment is closed (${via})`);
      const red = await driveCloseFlush(mutant.handleVoiceRealtimeConnection, 'manual', via);
      assert.equal(
        countOf(red, 'input_audio_buffer.commit'),
        0,
        `without the flush the open segment is never closed (${via}) — the last sentence is lost`,
      );
    }
  });
});

test("AC8: the false forms leave none of this process's copies behind", () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});

// ── the barrel and the client-message union this suite drives the bridge with ─────────────────

test('the bridge is driven with the shipping tool table and the segmented client frames', () => {
  assert.equal(Array.isArray(REALTIME_TOOLS), true);
  assert.equal(REALTIME_TOOLS.length > 0, true);
  // A compile-time pin: the two frames the segmented path relies on exist in the client union.
  const commit: RealtimeClientMessage = { type: 'input_audio_buffer.commit' };
  const turnOff: RealtimeClientMessage = { type: 'session.turn_detection', turnDetection: null };
  assert.equal(commit.type, 'input_audio_buffer.commit');
  assert.equal(turnOff.type, 'session.turn_detection');
});
