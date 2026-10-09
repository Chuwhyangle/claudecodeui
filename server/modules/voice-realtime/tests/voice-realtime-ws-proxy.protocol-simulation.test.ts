/**
 * GOAL-031 / AC-315 — the `/voice-realtime` proxy's protocol layer, simulated.
 *
 * WHAT THIS FILE IS FOR. AC-312's e2e spec proves the browser's HAPPY PATH with a
 * fake upstream and a fake microphone; AC-311's suite proves the BRIDGE survives a
 * dropped upstream connection and a response-concurrency conflict. Neither drives
 * `handleVoiceRealtimeConnection` itself — the proxy's own frame parsing, its
 * single-pending-intent bookkeeping, and its teardown path have no test naming
 * them directly. This file is that test, fully offline: a fake `RealtimeTransport`
 * (the same `createFakeTransport` AC-311/AC-310's suites use) stands in for the
 * DashScope upstream, and a minimal in-process EventEmitter stands in for the
 * browser's WebSocket — no network socket, no microphone, nothing CI cannot run.
 *
 * WHAT EACH CASE PROVES:
 *   - AC1 chunked audio: N distinct browser `audio` frames reach the transport as
 *     N distinct `input_audio_buffer.append` wire messages, in the order sent.
 *   - AC2 interruption: a `decision: false` frame declines the pending intent
 *     without the proxy ever calling the real `session_send`, and leaves the
 *     connection usable for the next intent.
 *   - AC3 reconnection path (disconnect, not resume): a browser socket closing
 *     while an intent is pending settles that intent (declined) and tears the
 *     bridge down — the proxy's `teardown()` must run on every terminal path, not
 *     only an explicit `{type:'close'}` frame.
 *   - AC4 concurrent response race: two `session_send` function calls arriving
 *     before either is decided must not silently orphan the first. The proxy's
 *     `pending` slot is a single value, not a queue; this is a regression guard
 *     for that design — if a future edit goes back to unconditionally overwriting
 *     `pending`, the first call's awaited decision is never settled and this test
 *     times out via `waitFor` instead of passing silently.
 *   - AC5 tool-call fill-back: an approved intent's (possibly edited) text reaches
 *     the real executor, the browser gets the `sent` frame, and the model's
 *     `function_call_output` carries the same result back upstream.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers
 * that resolve to same-named `.ts` files; Node's own type-stripping does not
 * remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the
 * surface `handleVoiceRealtimeConnection` uses (`readyState`, `send`, `close`,
 * `on('message' | 'close', …)`). Driven over `EventEmitter` rather than a real
 * socket pair, so the whole proxy runs in-process with nothing to bind or tear
 * down at the OS level.
 */
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

  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** One `session_send` call the fake base executor recorded. */
type RecordedSend = { args: Record<string, unknown> };

/** A controllable stand-in for AC-310's real executor: records calls, never fails. */
function createFakeBaseExecutor(): { calls: RecordedSend[]; executor: RealtimeToolExecutor } {
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, echoedMessage: args.message };
    },
  };
  return { calls, executor };
}

/** Delivers one `function_call` event from the fake upstream for `session_send`. */
function deliverSessionSendCall(transport: FakeTransport, callId: string, message: string): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  };
  transport.peerSend(call);
}

/** Wires one fresh proxy connection over a fake browser socket and a fake transport. */
function wireConnection(): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  base: { calls: RecordedSend[]; executor: RealtimeToolExecutor };
  boundSessionId: string;
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createFakeBaseExecutor();
  const boundSessionId = 'session-under-test';
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], boundSessionId, seams);
  return { socket, transport, base, boundSessionId };
}

/** The `input_audio_buffer.append` frames among everything the fake transport recorded. */
function audioFramesSent(transport: FakeTransport): string[] {
  return transport.sent
    .filter((message): message is { type: 'input_audio_buffer.append'; audio: string } => message.type === 'input_audio_buffer.append')
    .map((message) => message.audio);
}

test('chunked audio: N distinct browser frames reach the transport as N distinct frames, in order', async () => {
  const { socket, transport } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  socket.receive({ type: 'audio', audio: 'chunk-1' });
  socket.receive({ type: 'audio', audio: 'chunk-2' });
  socket.receive({ type: 'audio', audio: 'chunk-3' });

  assert.deepEqual(audioFramesSent(transport), ['chunk-1', 'chunk-2', 'chunk-3']);
});

test('interruption: declining a pending intent never calls the real session_send, and the next intent still works', async () => {
  const { socket, transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverSessionSendCall(transport, 'call-1', 'first proposal');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'intent'));

  socket.receive({ type: 'decision', approved: false });
  await waitFor(() => base.calls.length === 0 && socket.outbound.filter((frame) => frame.type === 'intent').length === 1);
  assert.equal(base.calls.length, 0, 'a declined intent must never reach the real session_send');

  // The slot the decline cleared must accept the NEXT intent rather than staying stuck.
  deliverSessionSendCall(transport, 'call-2', 'second proposal');
  await waitFor(() => socket.outbound.filter((frame) => frame.type === 'intent').length === 2);
  socket.receive({ type: 'decision', approved: true });
  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'second proposal');
});

test('disconnect while an intent is pending declines it and tears the bridge down (no explicit close frame)', async () => {
  const { socket, transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverSessionSendCall(transport, 'call-1', 'never approved');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'intent'));

  // The browser vanishes — no `{type:'decision'}`, no `{type:'close'}`, just the
  // socket's own close event, exactly what a dropped tab/network produces.
  socket.close();

  await waitFor(() => transport.closeCalls >= 1);
  assert.equal(base.calls.length, 0, 'a pending intent abandoned by a disconnect must not reach the real session_send');
});

test('concurrent response race: a second session_send before the first settles is refused, not orphaned', async () => {
  const { socket, transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  // Two function calls land back to back, before the browser answers either —
  // the shape AC-308 already proved DashScope's server-side VAD can produce.
  deliverSessionSendCall(transport, 'call-1', 'first');
  deliverSessionSendCall(transport, 'call-2', 'second');

  // Only the FIRST call's intent reaches the browser; the second is refused
  // before it ever asks the browser to confirm anything.
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  const intentFrames = socket.outbound.filter((frame) => frame.type === 'intent');
  assert.equal(intentFrames.length, 1);
  assert.equal((intentFrames[0] as { type: 'intent'; text: string }).text, 'first');

  // The first call is still answerable — this is the regression guard: if the
  // proxy ever goes back to unconditionally overwriting `pending`, call-1's
  // awaited decision is never settled and this line hangs until `waitFor` times
  // the whole test out, rather than passing silently.
  socket.receive({ type: 'decision', approved: true });
  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'first');
});

test('tool-call fill-back: an approved (edited) intent reaches session_send, and its result fills back as function_call_output', async () => {
  const { socket, transport, base, boundSessionId } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverSessionSendCall(transport, 'call-1', 'ORIGINAL proposal');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'intent'));

  // The edit is the correction mechanism (AC2 of AC-312): what is approved, not
  // what was proposed, is what must reach the real session_send.
  socket.receive({ type: 'decision', approved: true, message: 'EDITED instruction' });

  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'EDITED instruction');

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'sent'));
  const sentFrame = socket.outbound.find((frame) => frame.type === 'sent') as {
    type: 'sent';
    sessionId: string;
    result: unknown;
  };
  assert.equal(sentFrame.sessionId, boundSessionId);
  assert.deepEqual(sentFrame.result, { ok: true, echoedMessage: 'EDITED instruction' });

  // The model's half of the fill-back: the upstream must receive a
  // `function_call_output` naming the SAME callId, carrying the SAME result.
  const fillBack = transport.sent.find(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output',
  );
  assert.ok(fillBack, 'the upstream must receive a function_call_output for the approved call');
  assert.equal(fillBack.callId, 'call-1');
  assert.deepEqual(fillBack.output, { ok: true, echoedMessage: 'EDITED instruction' });
});
