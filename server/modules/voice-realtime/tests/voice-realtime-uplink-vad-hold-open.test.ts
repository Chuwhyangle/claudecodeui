// The uplink-VAD gate holds the tail open while the upstream's turn is open, and closes it itself at a cap.
//
// Live test 2026-10-15 (connection 73f2622b): a ~3 s sentence was closed by the upstream 16 s after it
// began, because the fixed 620 ms tail was not heard as silence and the gate then sent nothing — the
// upstream's audio clock stopped until the next utterance's pre-roll closed the turn. The gate now keeps
// forwarding real audio past `a` for as long as the upstream says its turn is open, up to a cap, and at
// the cap asks the relay to commit the turn.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  UPLINK_VAD_FRAME_BYTES,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from '../voice-realtime-uplink-vad.js';
import {
  UPLINK_VAD_FRAME_MS,
  UPLINK_VAD_HOLD_OPEN_MAX_MS,
  createUplinkVadGate,
  uplinkHeadKeepFrames,
  type UplinkVadGate,
} from '../voice-realtime-uplink-vad-gate.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { DEFAULT_TURN_DETECTION } from '../voice-realtime-turn-detection.js';
import type { RealtimeToolExecutor } from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

const A = uplinkHeadKeepFrames(DEFAULT_TURN_DETECTION.silence_duration_ms);
const CAP = Math.round(UPLINK_VAD_HOLD_OPEN_MAX_MS / UPLINK_VAD_FRAME_MS);

type Frame = { audio: string; speech: boolean };

function pcmFrame(amplitude: number, index: number): string {
  const pcm = Buffer.alloc(UPLINK_VAD_FRAME_BYTES);
  for (let sample = 0; sample < UPLINK_VAD_FRAME_BYTES / 2; sample += 1) {
    pcm.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  // A unique head per frame, so a leg can ask whether THIS frame crossed.
  pcm.writeInt32LE(index, 0);
  return pcm.toString('base64');
}

function build(specs: readonly { speech: boolean; count: number }[]): Frame[] {
  const frames: Frame[] = [];
  for (const spec of specs) {
    for (let n = 0; n < spec.count; n += 1) {
      frames.push({ audio: pcmFrame(spec.speech ? 500 : 12, frames.length), speech: spec.speech });
    }
  }
  return frames;
}

function scriptedClassifier(pattern: readonly boolean[]): UplinkVadClassifier {
  let next = 0;
  return {
    backend: 'webrtc',
    status: 'available',
    reason: null,
    async classify(): Promise<UplinkVadFrameVerdict | null> {
      const index = next;
      next += 1;
      const speech = pattern[index] ?? true;
      return { frameIndex: index, speech, probability: speech ? 0.9 : 0.05, bypassed: false, reason: null };
    },
    async flush(): Promise<UplinkVadFrameVerdict[]> {
      return [];
    },
    async close(): Promise<void> {},
  };
}

/** Feeds frames, calling `at[i]` just before frame `i`; returns what crossed and the close requests. */
async function drive(
  gate: UplinkVadGate,
  frames: readonly Frame[],
  at: Record<number, () => void> = {},
): Promise<{ wired: string[]; closeTurnAt: number[]; heldOpen: number }> {
  const wired: string[] = [];
  const closeTurnAt: number[] = [];
  let heldOpen = 0;
  for (let index = 0; index < frames.length; index += 1) {
    at[index]?.();
    const decision = await gate.observe(frames[index]!.audio);
    wired.push(...decision.frames);
    if (decision.closeTurn) {
      closeTurnAt.push(index);
    }
    heldOpen = decision.heldOpen;
  }
  return { wired, closeTurnAt, heldOpen };
}

const gateFor = (frames: readonly Frame[], extra: { holdOpenMaxMs?: number } = {}): UplinkVadGate =>
  createUplinkVadGate({
    classifier: scriptedClassifier(frames.map((f) => f.speech)),
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
    ...extra,
  });

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────

test('the shipped hold-open cap is 2 s, longer than the head-keep window', () => {
  assert.equal(UPLINK_VAD_HOLD_OPEN_MAX_MS, 2_000);
  assert.ok(CAP > A, `cap ${CAP} frames must exceed a=${A}`);
});

// AC6 of `gap-live-voice-turn-detection-silence-in-settings-file-default-800`: the shipped silence window
// moved 400 → 800 and `a` followed it, so the relationship the hold-open rule depends on had to be
// RE-CHECKED, not assumed. `holdOpenEnabled` is internal to the gate, so the reading is the gate's own
// exposed numbers — `CAP` (from `UPLINK_VAD_HOLD_OPEN_MAX_MS`) and `aFrames` — plus the observable
// consequence: a turn the upstream leaves open is still held PAST `a`, which is only possible while the
// relation holds.
test('AC6 — at the shipped 800 ms window the cap still exceeds `a`, so the hold-open rule stays enabled', async () => {
  assert.equal(A, 51, `the shipped window resolves to a=51 frames (got ${A})`);
  assert.equal(CAP, 100, `the shipped cap is 100 frames (got ${CAP})`);
  assert.equal(
    CAP > A,
    true,
    `holdOpenEnabled is "cap > a": ${CAP} > ${A} must still hold after the silence window widened`,
  );

  // The same relation, read where it is observable rather than declared: a gate at the shipped window
  // whose upstream turn stays open keeps sending past `a` and asks for exactly one close at the cap.
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 10 },
  ]);
  const gate = gateFor(frames);
  const run = await drive(gate, frames, { 0: () => gate.noteUpstreamTurn(true) });
  assert.equal(run.heldOpen, CAP - A, 'frames past `a` cross because the hold is on — the relation is doing work');
  assert.deepEqual(run.closeTurnAt, [5 + CAP], 'and the cap still bounds the hold with exactly one close');
});

test('an upstream turn still open past `a` keeps real audio flowing up to the cap, then asks to close once', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 40 },
  ]);
  const gate = gateFor(frames);
  const run = await drive(gate, frames, { 0: () => gate.noteUpstreamTurn(true) });

  const quiet = frames.slice(5).map((f) => f.audio);
  assert.deepEqual(
    run.wired,
    [...frames.slice(0, 5).map((f) => f.audio), ...quiet.slice(0, CAP)],
    'every quiet frame up to the cap crosses, in order; none past it',
  );
  assert.equal(run.heldOpen, CAP - A, 'the frames past `a` are counted as held open');
  assert.deepEqual(run.closeTurnAt, [5 + CAP], 'the close is requested exactly once, on the first frame past the cap');
});

test('the upstream closing its turn stops the hold at once, and no close is requested', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 40 },
  ]);
  const gate = gateFor(frames);
  const closeAt = 5 + A + 10;
  const run = await drive(gate, frames, {
    0: () => gate.noteUpstreamTurn(true),
    [closeAt]: () => gate.noteUpstreamTurn(false),
  });

  assert.equal(run.wired.length, closeAt, 'nothing after the upstream closed its turn crosses');
  assert.equal(run.heldOpen, 10);
  assert.deepEqual(run.closeTurnAt, []);
});

test('with no upstream turn open the gate is what it was: exactly `a` quiet frames, no close request', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 40 },
  ]);
  const run = await drive(gateFor(frames), frames);
  assert.equal(run.wired.length, 5 + A);
  assert.equal(run.heldOpen, 0);
  assert.deepEqual(run.closeTurnAt, []);
});

test('a new utterance re-arms the close request for its own quiet run', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 5 },
    { speech: true, count: 5 },
    { speech: false, count: CAP + 5 },
  ]);
  const gate = gateFor(frames);
  const run = await drive(gate, frames, { 0: () => gate.noteUpstreamTurn(true) });
  assert.deepEqual(run.closeTurnAt, [5 + CAP, 5 + CAP + 5 + 5 + CAP]);
});

test('holdOpenMaxMs: 0 turns the hold off — `a` frames only, never a close request', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 40 },
  ]);
  const gate = gateFor(frames, { holdOpenMaxMs: 0 });
  const run = await drive(gate, frames, { 0: () => gate.noteUpstreamTurn(true) });
  assert.equal(run.wired.length, 5 + A);
  assert.deepEqual(run.closeTurnAt, []);
});

// ── the relay: the upstream's own speech events drive the gate, and the cap commits the turn ─────────

class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }
  close(): void {
    if (this.readyState !== WS.CLOSED) {
      this.readyState = WS.CLOSED;
      this.emit('close');
    }
  }
  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

function wire(pattern: readonly boolean[]): { socket: FakeBrowserSocket; transports: FakeTransport[]; logs: string[] } {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const executor: RealtimeToolExecutor = { session_send: async () => ({ runId: 'run-1', queued: false }) };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => executor,
    instructions: 'test instructions',
    segmentedRelay: false,
    log: (line) => logs.push(line),
    stallMs: 10_000,
    uplinkVad: { classifier: scriptedClassifier(pattern) },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sentTypes = (transport: FakeTransport): string[] => transport.sent.map((message) => message.type);
const appendCount = (transport: FakeTransport): number =>
  transport.sent.filter((message) => message.type === 'input_audio_buffer.append').length;

// Live test 2026-10-15 (connection 71e53da5), both forced closes: the commit made the upstream close the
// turn itself (speech_stopped + committed within 500 ms), its server_vad answered that turn, and the
// commit was then refused as "buffer too small". A response.create sent beside the commit was a SECOND
// response for the same utterance — it re-sent the sentence and started a 7-call duplicate loop.
test('relay: an upstream turn left open past the cap is committed by the relay, and nothing else', async () => {
  const frames = build([
    { speech: true, count: 5 },
    { speech: false, count: CAP + 40 },
  ]);
  const wired = wire(frames.map((f) => f.speech));
  await waitFor(() => opened(wired.socket));
  const upstream = wired.transports[0]!;
  upstream.peerSend({ type: 'input_audio_buffer.speech_started' });
  for (const frame of frames) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }
  await settle();

  assert.equal(appendCount(upstream), 5 + CAP, 'audio crosses up to the cap and stops there');
  const types = sentTypes(upstream);
  const commitAt = types.indexOf('input_audio_buffer.commit');
  assert.ok(commitAt !== -1, 'the relay commits the turn the upstream left open');
  assert.equal(types.filter((type) => type === 'input_audio_buffer.commit').length, 1, 'exactly once');
  assert.ok(wired.logs.some((line) => /uplink_vad: .*still open.*commit/.test(line)), 'the forced close is logged');

  // The live sequence that followed: the upstream closes the turn and answers it on its own.
  upstream.peerSend({ type: 'input_audio_buffer.speech_stopped' });
  upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_forced' });
  upstream.peerSend({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Error committing input audio buffer: buffer too small, or have no audio.' },
  });
  await settle();
  assert.equal(
    sentTypes(upstream).filter((type) => type === 'response.create').length,
    0,
    'the relay asks for no answer of its own — the upstream\'s server_vad answers the turn it closed',
  );
});

test('relay: the upstream\'s own speech_stopped ends the hold and the relay commits nothing', async () => {
  const head = build([
    { speech: true, count: 5 },
    { speech: false, count: A + 10 },
  ]);
  const rest = build([{ speech: false, count: CAP }]).map((f, i) => ({ ...f, audio: pcmFrame(12, 10_000 + i) }));
  const wired = wire([...head, ...rest].map((f) => f.speech));
  await waitFor(() => opened(wired.socket));
  const upstream = wired.transports[0]!;
  upstream.peerSend({ type: 'input_audio_buffer.speech_started' });
  for (const frame of head) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }
  await settle();
  upstream.peerSend({ type: 'input_audio_buffer.speech_stopped' });
  for (const frame of rest) {
    wired.socket.receive({ type: 'audio', audio: frame.audio });
  }
  await settle();

  assert.equal(appendCount(upstream), head.length, 'nothing crosses after the upstream closed its turn');
  assert.ok(!sentTypes(upstream).includes('input_audio_buffer.commit'));
});
