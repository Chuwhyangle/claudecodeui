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

  // The session must be OPEN first: a frame that reaches the proxy while the upstream is
  // still connecting is dropped rather than forwarded (an unguarded send throws there, and
  // this call sits directly under the browser's socket handler — see `sendAudioFrame`).
  // In production the browser waits for exactly this `state: open` before it sends anything.
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

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
  // `sent` is written to the browser before the result is handed back to the bridge, so the
  // fill-back lands a few ticks later: wait for it rather than assume it is already there.
  await waitFor(() => transport.sent.some((message) => message.type === 'function_call_output'));
  const fillBack = transport.sent.find(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output',
  );
  assert.ok(fillBack, 'the upstream must receive a function_call_output for the executed call');
  assert.equal(fillBack.callId, 'call-1');
  assert.deepEqual(fillBack.output, { ok: true, echoedMessage: 'the instruction' });
});

// ── AC-317: the caption channel ──────────────────────────────────────────────────────────────
//
// The endpoint's transcription of the USER'S OWN audio, forwarded so the browser can show the
// user their own words. Two properties matter and neither is cosmetic: these events must NOT
// land on the error channel (a continuously-capturing session emits them constantly, so
// reporting them would leave the UI holding a stream of failures for a session that works), and
// this text must never become model input.

/** Delivers one transcription event from the fake upstream, as DashScope spells it. */
function deliverTranscription(
  transport: FakeTransport,
  kind: 'delta' | 'completed',
  itemId: string,
  text: string,
): void {
  // The field names differ between the two events and neither is self-describing:
  // a `delta` carries its running text in `stash` with `text` present but EMPTY,
  // and `completed` carries the final text in `transcript`. Taken from the
  // preserved live capture under experiments/voice-realtime-ambiguity/real-trace/.
  transport.peerSend(
    kind === 'delta'
      ? { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, stash: text, text: '' }
      : { type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text },
  );
}

const captionFrames = (socket: FakeBrowserSocket) =>
  socket.outbound.filter((frame): frame is { type: 'caption'; itemId: string; text: string; final: boolean } =>
    frame.type === 'caption',
  );

test('transcription deltas become caption frames, and are NOT reported as unknown events', async () => {
  const { socket, transport } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverTranscription(transport, 'delta', 'item-1', '把超时');
  deliverTranscription(transport, 'delta', 'item-1', '把超时从十五秒改成五十秒');

  await waitFor(() => captionFrames(socket).length === 2);
  const captions = captionFrames(socket);
  assert.deepEqual(
    captions.map((frame) => ({ itemId: frame.itemId, text: frame.text, final: frame.final })),
    [
      { itemId: 'item-1', text: '把超时', final: false },
      { itemId: 'item-1', text: '把超时从十五秒改成五十秒', final: false },
    ],
  );

  // The regression this case exists for: before AC-317 these fell through to
  // UNKNOWN_EVENT and reached the browser as session failures.
  assert.equal(
    socket.outbound.filter((frame) => frame.type === 'error').length,
    0,
    'transcription events are recognised, not reported as unexplained failures',
  );
});

test('a completed transcription arrives as the final caption for the same item', async () => {
  const { socket, transport } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverTranscription(transport, 'delta', 'item-7', '把超时从十五秒');
  deliverTranscription(transport, 'completed', 'item-7', '把超时从十五秒改成五十秒，不是五秒。');

  await waitFor(() => captionFrames(socket).length === 2);
  const last = captionFrames(socket)[1]!;
  assert.equal(last.itemId, 'item-7');
  assert.equal(last.text, '把超时从十五秒改成五十秒，不是五秒。');
  assert.equal(last.final, true);
});

test('caption text never reaches a session_send call: the display channel and the model input are disjoint', async () => {
  const { socket, transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  // The model hears "please summarize"; the endpoint's transcription of that same
  // audio is a DIFFERENT string. If any plumbing ever routed the caption into the
  // executor, the sent message would be the transcription rather than the model's
  // own arguments — which is exactly what this asserts cannot happen.
  deliverTranscription(transport, 'delta', 'item-1', 'please summarize the last three commits');
  deliverTranscription(transport, 'completed', 'item-1', 'please summarize the last three commits');
  deliverSessionSendCall(transport, 'call-1', 'MODEL ARGUMENTS, not the transcription');

  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'MODEL ARGUMENTS, not the transcription');
  for (const call of base.calls) {
    assert.notEqual(
      String(call.args.message),
      'please summarize the last three commits',
      'the transcription is display-only and must never become the arguments of a real send',
    );
  }
});

// ── The endpoint's own protocol traffic must not kill the session ───────────────────────────
//
// Provenance: the real endpoint sends `session.created` and `session.updated` on connect — the
// latter is its reply to OUR `session.update`. Reporting either as an unknown event killed every
// real session on its first handshake reply, and no criterion saw it because the stand-ins spoke
// only `response.function_call_arguments.done`. Enumerated from the preserved live capture under
// experiments/voice-realtime-ambiguity/real-trace/.

const errorFrames = (socket: FakeBrowserSocket) =>
  socket.outbound.filter((frame) => frame.type === 'error');

test('the endpoint answering our own session.update does not end the session', async () => {
  const { socket, transport } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  transport.peerSend({ type: 'session.created' });
  transport.peerSend({ type: 'session.updated' });
  transport.peerSend({ type: 'response.created' });
  transport.peerSend({ type: 'response.text.delta', delta: 'hello' });
  transport.peerSend({ type: 'response.done' });
  transport.peerSend({ type: 'input_audio_buffer.speech_started' });

  // Give the bridge a turn to have reported anything it was going to.
  await waitFor(() => transport.openCalls >= 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(
    errorFrames(socket),
    [],
    'endpoint lifecycle traffic is normal, not a failure to report to the browser',
  );

  // And the session is still usable: a real tool call after the lifecycle still runs.
  deliverSessionSendCall(transport, 'call-after-lifecycle', 'still working');
  await waitFor(() => transport.sent.some((m) => m.type === 'function_call_output'));
});

test('a type this endpoint never sends is STILL reported, so the reading keeps its meaning', async () => {
  const { socket, transport } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  // An OpenAI-shaped name — exactly what the other bridge case pins. Tolerating the
  // endpoint's real traffic must not turn into tolerating everything.
  transport.peerSend({ type: 'response.audio_transcript.delta' });

  await waitFor(() => errorFrames(socket).length >= 1);
  assert.equal(errorFrames(socket)[0]!.code, 'UNKNOWN_EVENT');
});

test('an audio frame arriving before the upstream is open is dropped, not thrown', async () => {
  const { socket, transport } = wireConnection();

  // Deliberately BEFORE the session reports open — the shape a reconnect produces when the
  // browser, which only ever saw `open` once, keeps talking. Forwarding here throws inside the
  // browser's own socket handler and takes the process down.
  assert.doesNotThrow(() => socket.receive({ type: 'audio', audio: 'too-early' }));

  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((f) => f.type === 'state' && f.state === 'open'));

  assert.deepEqual(
    audioFramesSent(transport),
    [],
    'a frame from before the session opened is stale audio, not something to forward',
  );

  // The session still works afterwards: frames sent once open are forwarded as normal.
  socket.receive({ type: 'audio', audio: 'after-open' });
  await waitFor(() => audioFramesSent(transport).length === 1);
  assert.deepEqual(audioFramesSent(transport), ['after-open']);
});
