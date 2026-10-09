/**
 * GOAL-033 / AC-316 — the `/voice-realtime` proxy's protocol layer, simulated.
 *
 * WHAT THIS FILE IS FOR. AC-316's e2e specs prove the browser's healthy path with
 * a fake upstream and a fake microphone; AC-311's suite proves the BRIDGE survives
 * a dropped upstream connection and a response-concurrency conflict. Neither drives
 * `handleVoiceRealtimeConnection` itself — the proxy's own frame parsing, its
 * single-flight send bookkeeping, and its teardown path have no test naming them
 * directly. This file is that test, fully offline: a fake `RealtimeTransport`
 * (the same `createFakeTransport` AC-311/AC-310's suites use) stands in for the
 * DashScope upstream, and a minimal in-process EventEmitter stands in for the
 * browser's WebSocket — no network socket, no microphone, nothing CI cannot run.
 *
 * WHAT CHANGED FROM AC-315. The proxy used to surface a model's proposed
 * `session_send` to the browser as an editable intent and wait for a `decision`
 * frame. AC-316 removed that step — Live Voice is continuous capture with no
 * per-utterance confirmation UI — so `session_send` now executes the moment the
 * model calls it, and the browser has no `decision` frame to send. The five
 * scenarios below are the same five AC-315 proved, rewritten for that protocol:
 * the "interruption" scenario is now "Mute is the only interruption" (the
 * browser withholds audio frames; there is no decision frame to decline), and
 * the single-flight guard now protects a real in-flight call rather than an
 * awaited browser answer.
 *
 * WHAT EACH CASE PROVES:
 *   - AC1 chunked audio: N distinct browser `audio` frames reach the transport as
 *     N distinct `input_audio_buffer.append` wire messages, in the order sent.
 *   - AC2 interruption (Mute, not a decision): there is no browser `decision`
 *     frame any more (`readVoiceRealtimeInboundFrame` drops one), the proxy
 *     executes a model `session_send` with no browser round-trip, and withholding
 *     audio does not close the connection — the next call still works.
 *   - AC3 reconnection path (disconnect, not resume): a browser socket closing
 *     while a real `session_send` is in flight tears the bridge down — the
 *     proxy's `teardown()` must run on every terminal path, not only an explicit
 *     `{type:'close'}` frame.
 *   - AC4 concurrent response race: two `session_send` function calls arriving
 *     before the first real call returns must not both run against the same bound
 *     session. The proxy's `sending` flag is a single-slot guard, not a queue;
 *     this is a regression guard for that design — if a future edit removes the
 *     guard (AC-316's own false form (c)), the second call reaches the real
 *     executor and this test goes red.
 *   - AC5 tool-call fill-back: an executed call reaches the real executor and the
 *     model's `function_call_output` carries the same result back upstream.
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
  readVoiceRealtimeInboundFrame,
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

/**
 * A controllable stand-in for AC-310's real executor: records calls, never fails.
 *
 * With `manual` the first call's promise stays pending until `release()` — the
 * one way to hold a real `session_send` "in flight" deterministically, without
 * racing the microtask queue. That is exactly the window AC4's concurrency guard
 * and AC3's disconnect teardown need to observe.
 */
function createFakeBaseExecutor(options: { manual?: boolean } = {}): {
  calls: RecordedSend[];
  executor: RealtimeToolExecutor;
  release: () => void;
} {
  const calls: RecordedSend[] = [];
  let gate: Promise<void> | null = null;
  let release = (): void => undefined;
  if (options.manual) {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      if (gate) {
        await gate;
      }
      return { ok: true, echoedMessage: args.message };
    },
  };
  return { calls, executor, release };
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
function wireConnection(options: { manual?: boolean } = {}): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  base: { calls: RecordedSend[]; executor: RealtimeToolExecutor; release: () => void };
  boundSessionId: string;
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createFakeBaseExecutor(options);
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

test('interruption is Mute, not a decision: no decision frame exists, the send executes with no browser round-trip, and withholding audio keeps the connection usable', async () => {
  const { socket, transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  // The browser-side "interruption" the criterion describes — Mute — is simply
  // an absence of `audio` frames. The protocol no longer carries a decision at
  // all, so a stale one is dropped rather than mistaken for an approval.
  assert.equal(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'decision', approved: false })), null);
  assert.equal(readVoiceRealtimeInboundFrame(JSON.stringify({ type: 'intent', text: 'x' })), null);

  // The model's call runs the moment it arrives; no browser frame precedes it.
  deliverSessionSendCall(transport, 'call-1', 'first instruction');
  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'first instruction');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'sent'));

  // Mute withholds audio; it must not tear the connection down.
  assert.equal(transport.closeCalls, 0, 'withholding audio (Mute) must not close the upstream');
  assert.equal(socket.readyState, WS.OPEN);

  // Unmute (audio resumes) and a second, independent model call still works.
  deliverSessionSendCall(transport, 'call-2', 'second instruction');
  await waitFor(() => base.calls.length === 2);
  assert.equal(base.calls[1]?.args.message, 'second instruction');
});

test('disconnect while a real session_send is in flight tears the bridge down (no explicit close frame)', async () => {
  const { socket, transport, base } = wireConnection({ manual: true });
  await waitFor(() => transport.openCalls >= 1);

  deliverSessionSendCall(transport, 'call-1', 'in flight');
  // The real executor is held open, so the call is genuinely outstanding.
  await waitFor(() => base.calls.length === 1);

  // The browser vanishes — no `{type:'close'}` frame, just the socket's own
  // close event, exactly what a dropped tab/network produces.
  socket.close();

  await waitFor(() => transport.closeCalls >= 1);
  // The in-flight call already reached the real executor (execution is
  // immediate); the teardown is about the upstream socket, not about aborting it.
  assert.equal(base.calls.length, 1);

  // Let the held promise settle so nothing is left dangling; the proxy drops the
  // output because the socket it would send on is already closed.
  base.release();
});

test('concurrent response race: a second session_send before the first returns is refused, not run concurrently', async () => {
  const { socket, transport, base } = wireConnection({ manual: true });
  await waitFor(() => transport.openCalls >= 1);

  // Two function calls land back to back while the first real call is still in
  // flight — the shape AC-308 already proved DashScope's server-side VAD can
  // produce. The second must be refused by the single-slot guard, not run against
  // the same bound session.
  deliverSessionSendCall(transport, 'call-1', 'first');
  deliverSessionSendCall(transport, 'call-2', 'second');

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  assert.equal(base.calls.length, 1, 'only the first call may reach the real executor');
  assert.equal(base.calls[0]?.args.message, 'first');

  // The first call is still answerable — this is the regression guard: if the
  // proxy ever drops the guard (AC-316's false form (c)), `call-2` reaches the
  // executor too and this line reads 2, not 1.
  base.release();
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'sent'));
  assert.equal((socket.outbound.find((frame) => frame.type === 'sent') as { result: unknown }).result !== undefined, true);
});

test('tool-call fill-back: an executed session_send result fills back upstream as function_call_output', async () => {
  const { socket, transport, base, boundSessionId } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverSessionSendCall(transport, 'call-1', 'the instruction');
  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'the instruction');

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'sent'));
  const sentFrame = socket.outbound.find((frame) => frame.type === 'sent') as {
    type: 'sent';
    sessionId: string;
    result: unknown;
  };
  assert.equal(sentFrame.sessionId, boundSessionId);
  assert.deepEqual(sentFrame.result, { ok: true, echoedMessage: 'the instruction' });

  // The model's half of the fill-back: the upstream must receive a
  // `function_call_output` naming the SAME callId, carrying the SAME result.
  const fillBack = transport.sent.find(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output',
  );
  assert.ok(fillBack, 'the upstream must receive a function_call_output for the executed call');
  assert.equal(fillBack.callId, 'call-1');
  assert.deepEqual(fillBack.output, { ok: true, echoedMessage: 'the instruction' });
});
