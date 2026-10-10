/**
 * The spend guard: a connection that is spending at a runaway rate is ended, and one behaving normally
 * is never touched. The numbers come from the owner's October 2026 bill and from recorded sessions.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, estimateRealtimeCostCny, type RealtimeToolExecutor } from '../index.js';
import { handleVoiceRealtimeConnection, VOICE_REALTIME_INSTRUCTIONS, type VoiceRealtimeOutboundFrame } from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
}

const usage = (input: number, audio: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  input_tokens_details: { text_tokens: input - audio, audio_tokens: audio },
});

test('the estimate reproduces the owner’s invoice lines', () => {
  // 07:09 — the runaway loop: 294.269k text + 5.852k audio input, 2.648k output = ¥0.4414 + ¥0.0351 + ¥0.0119.
  const loop = estimateRealtimeCostCny(usage(300_121, 5_852, 2_648));
  assert.ok(Math.abs(loop - 0.4885) < 0.001, `loop estimated at ${loop}`);
  // 07:43 — five utterances in one connection: 5.814k + 0.546k input, 0.146k output ≈ ¥0.0127.
  const session = estimateRealtimeCostCny(usage(6_360, 546, 146));
  assert.ok(Math.abs(session - 0.0127) < 0.0005, `session estimated at ${session}`);
  // Unknown shapes cost nothing: the guard must never fire on data it cannot read.
  assert.equal(estimateRealtimeCostCny(undefined), 0);
  assert.equal(estimateRealtimeCostCny({ input_tokens: 'many' }), 0);
});

test('real sessions sit well below the window limit: the recorded one, and the current build’s', () => {
  const recording = JSON.parse(
    readFileSync(path.join(HERE, 'fixtures/real-run-qwen38-four-utterances.json'), 'utf8'),
  ) as Array<{ wire: { type: string; response?: { usage?: unknown } } }>;
  const costs = recording.filter((entry) => entry.wire.type === 'response.done').map((entry) => estimateRealtimeCostCny(entry.wire.response?.usage));
  assert.ok(costs.length >= 8);
  // One response of the OLD six-tool context costs at most about ¥0.003.
  assert.ok(Math.max(...costs) < 0.0035, `one response costs at most ${Math.max(...costs)}`);
  // The same recorded session (old context, ¥0.020 over ~14 s) is exactly what the one-tool build cut.
  // The current build's measured run — 3,686 input (259 audio) / 91 output for the same 12 s clip:
  const current = estimateRealtimeCostCny(usage(3_686, 259, 91));
  assert.ok(current < 0.008, `the current build spends about ¥${current.toFixed(4)} on that clip`);
  assert.ok(current < 0.015, 'and that is inside the window limit with a wide margin');
});

function build(spendGuard: { maxCnyPerWindow?: number; windowMs?: number; maxCnyTotal?: number }) {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const socket = new FakeBrowserSocket();
  const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: 'sk-test', socketFactory: upstream.socketFactory, onError: report, spendGuard }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
  });
  return { upstream, socket };
}
const opened = (socket: FakeBrowserSocket) => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');
const responseDone = (upstream: ReturnType<typeof createFakeDashscopeServer>, u: unknown, id: string) =>
  upstream.peerSend({ type: 'response.done', response: { id, status: 'completed', usage: u } });

test('a runaway rate ends the session within a few responses, and tells the person why', async () => {
  const { upstream, socket } = build({ windowMs: 30_000, maxCnyPerWindow: 0.015 });
  await waitFor(() => opened(socket));
  // The observed loop: ~5.6k-token responses, one every 0.65 s (¥0.0084 each).
  for (let index = 0; index < 5; index += 1) {
    responseDone(upstream, usage(5_600, 100, 30), `r${index}`);
  }
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'));
  const trip = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  assert.ok(trip && trip.type === 'error');
  assert.equal(trip.recoverable, undefined, 'a runaway connection is not "recoverable"');
  assert.match(trip.message, /spending guard/i);
  assert.match(trip.message, /¥0\.0\d\d/);
  await waitFor(() => socket.readyState === WS.CLOSED);
  assert.equal(socket.outbound.filter((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT').length, 1, 'reported once');
});

test('ordinary use, however long, is not touched', async () => {
  const { upstream, socket } = build({ windowMs: 200, maxCnyPerWindow: 0.015 });
  await waitFor(() => opened(socket));
  // Ten responses of ~0.8k tokens (¥0.0013 each), spread out so no window holds more than a few.
  for (let index = 0; index < 10; index += 1) {
    responseDone(upstream, usage(800, 20, 30), `n${index}`);
    await sleep(60);
  }
  await sleep(100);
  assert.equal(socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'), false);
  assert.notEqual(socket.readyState, WS.CLOSED);
  socket.close();
});

test('the whole-connection total is a backstop for a slow leak', async () => {
  const { upstream, socket } = build({ windowMs: 100, maxCnyPerWindow: 1, maxCnyTotal: 0.01 });
  await waitFor(() => opened(socket));
  for (let index = 0; index < 8; index += 1) {
    responseDone(upstream, usage(1_500, 0, 20), `t${index}`);
    await sleep(150); // each in its own window: only the total can see this
  }
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'));
  const trip = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  assert.ok(trip && trip.type === 'error' && /in total/.test(trip.message));
});
