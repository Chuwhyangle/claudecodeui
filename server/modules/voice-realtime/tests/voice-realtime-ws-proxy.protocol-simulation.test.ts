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
 *   - AC6 below-cap control (the bounded queue's): with nothing waiting, every model
 *     call still reaches the executor with its own words and no `refused` frame exists —
 *     the cap and the refusal change nothing under the bound.
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

import type { RealtimeSegmentCommitMode, RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
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
function wireConnection(
  options: {
    manual?: boolean;
    coalesceMs?: number;
    segmentCommit?: RealtimeSegmentCommitMode;
    /** The settle producer's window; a small value makes the boundary observable in-test. */
    settleMs?: number;
    /** Receives the proxy's own log lines, so a criterion can read the journal the operator reads. */
    log?: (line: string) => void;
  } = {},
): {
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
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    ...(options.segmentCommit === undefined ? {} : { segmentCommit: options.segmentCommit }),
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
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

// ── The bounded queue's negative control: below the cap, the path is the one it always was ──────
//
// `gap-live-voice-bounded-queue-refusal-visible` put a cap on how many spoken messages may be
// WAITING and a `refused` frame at the cap. Neither may change what happens below it: this session
// never reports `queued: true`, so nothing is ever waiting, and every model call must reach the
// executor with its own words, in order, exactly as the fill-back case above reads. A relay that
// refused or coalesced here would show up as a shorter `calls` sequence, not as a new frame.

test('below the cap every model call reaches the executor unchanged, and nothing is refused', async () => {
  const { socket, transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  for (let index = 1; index <= 4; index += 1) {
    deliverSessionSendCall(transport, `call-${index}`, `message ${index}`);
    await waitFor(() => base.calls.length === index);
    await waitFor(() => socket.outbound.filter((frame) => frame.type === 'sent').length === index);
  }

  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    ['message 1', 'message 2', 'message 3', 'message 4'],
    'below the cap the relay must hand each call through unchanged, in the order the model made them',
  );
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'refused'),
    false,
    'below the cap there is nothing to refuse',
  );
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
  socket.outbound.filter((frame): frame is { type: 'caption'; itemId: string; text: string; final: boolean; seq: number | null } =>
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
  // audio is a DIFFERENT string (the model's own wording, capitalised and punctuated). If any
  // plumbing ever routed the caption into the executor, the sent message would be the
  // transcription rather than the model's own arguments — which is exactly what this asserts
  // cannot happen.
  //
  // The model's words cover what was heard here on purpose: a heard sentence the model's words
  // LEAVE OUT is delivered verbatim in front of them by design (ruling 2026-10-14, "every finished
  // sentence is delivered"; `voice-realtime-partial-relay-fragments.test.ts`), which is a different
  // question from the caption replacing the arguments.
  deliverTranscription(transport, 'delta', 'item-1', 'please summarize the last three commits');
  deliverTranscription(transport, 'completed', 'item-1', 'please summarize the last three commits');
  deliverSessionSendCall(transport, 'call-1', 'MODEL ARGUMENTS: Please summarize the last three commits.');

  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, 'MODEL ARGUMENTS: Please summarize the last three commits.');
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

// ── AC-327: the delivery wait is visible on the wire ─────────────────────────────────────────
//
// `session_send` is accepted immediately but delivered only when the coalescing window closes
// (1 s in production). Every frame above this point is a coalesceMs=0 connection, where that
// window does not exist — so these two cases are the only ones that pass `coalesceMs`. The first
// pins the frame the window opens with (exactly one, before `sent`); the second pins that a
// REPLAYED segment — already delivered once — opens no second window at all.

const queuedFrames = (socket: FakeBrowserSocket) => socket.outbound.filter((frame) => frame.type === 'queued');
const sentFrames = (socket: FakeBrowserSocket) => socket.outbound.filter((frame) => frame.type === 'sent');

test('AC-327: one accepted delivery opens one window — the frame comes before sent, and a replay adds none', async () => {
  const { socket, transport, base } = wireConnection({ coalesceMs: 40, segmentCommit: 'manual' });
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

  // One segment, spoken and committed upstream.
  socket.receive({ type: 'segment_start', seq: 0 });
  socket.receive({ type: 'audio', audio: 'chunk-a', seq: 0 });
  socket.receive({ type: 'segment_end', seq: 0, durationMs: 100, reason: 'gap' });
  await waitFor(() => transport.sent.filter((message) => message.type === 'input_audio_buffer.commit').length >= 1);

  // The model delivers for that segment. The wait the person stares at must be on the wire: one
  // frame, and it must land BEFORE `sent` (which is the wait ending, not beginning).
  deliverSessionSendCall(transport, 'call-1', '把超时改成五十秒');
  await waitFor(() => sentFrames(socket).length === 1);
  assert.equal(queuedFrames(socket).length, 1, 'one accepted delivery opens exactly one window');
  assert.ok(
    socket.outbound.indexOf(queuedFrames(socket)[0]!) < socket.outbound.indexOf(sentFrames(socket)[0]!),
    'the window-opening frame must precede the `sent` that closes it',
  );

  // The upstream drops between the commit and its response, so the bridge writes the segment onto
  // the new socket once more and the model may call `session_send` for it a second time.
  const beforeDrop = transport.sent.length;
  transport.drop();
  await waitFor(() => transport.openCalls >= 2 && transport.sent.length > beforeDrop);

  deliverSessionSendCall(transport, 'call-2', '把超时改成五十秒');
  await waitFor(() =>
    transport.sent.some((message) => message.type === 'function_call_output' && (message as { callId?: string }).callId === 'call-2'),
  );

  // The replay was recognised (the call was answered upstream), the session saw the thought once,
  // and the page was told once — the replay opened no second window.
  assert.equal(base.calls.length, 1, 'the session received the thought exactly once');
  assert.equal(sentFrames(socket).length, 1, 'the page was told exactly once');
  assert.equal(queuedFrames(socket).length, 1, 'a replayed segment must not open a second window');
});

test('AC-327: a second message inside an open window joins it without a second frame', async () => {
  const { socket, transport, base } = wireConnection({ coalesceMs: 60 });
  await waitFor(() => transport.openCalls >= 1);

  // Two calls land back to back, both before the window closes; they are relayed as one message.
  deliverSessionSendCall(transport, 'call-1', '第一句');
  deliverSessionSendCall(transport, 'call-2', '第二句');
  await waitFor(() => sentFrames(socket).length === 1);

  assert.equal(queuedFrames(socket).length, 1, 'a message joining an already-open window opens nothing');
  assert.equal(base.calls.length, 1, 'the two pieces were relayed together');
});

// ── Continuous mode: the model re-sending one utterance with no new audio behind it ─────────────
//
// Provenance (goal-record proposal, 2026-10-11 operator run): journal 57279cc1, connection session
// 79d7515b, continuous mode. Two real utterances were committed and transcribed and the model
// relayed them as ONE coalesced sentence at 15:40:00.340; then at 15:40:13 and 15:40:29 the
// upstream produced a bare `conversation.item.created` → `response.created` → the SAME `session_send`
// literal with NO speech/commit/transcription in between, and the sentence reached the session three
// times (`response` audioTokens 259 on each no-audio turn). The call ids are fresh and continuous
// mode carries no `seq`, so neither the segmented replay gate nor the per-utterance cap caught it.
//
// The guard counts user utterances COMMITTED upstream and not yet accounted for by an accepted
// delivery (the bridge's `onUserAudioCommitted` hook), and drops a call only when that count is 0
// AND its normalized text is the last accepted delivery's (or a fragment of it). The two negative
// controls below hold the guard to exactly that: a genuinely new literal, and the user really
// repeating themselves, must both still be delivered.

/** The `function_call_output` the fake upstream received for one call, or undefined. */
function fillBackFor(transport: FakeTransport, callId: string) {
  return transport.sent.find(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && (message as { callId?: string }).callId === callId,
  );
}

/** One upstream utterance: the endpoint's VAD closes it and then transcribes it. */
function deliverCommittedUtterance(transport: FakeTransport, itemId: string, transcript: string): void {
  transport.peerSend({ type: 'input_audio_buffer.speech_started' });
  transport.peerSend({ type: 'input_audio_buffer.speech_stopped' });
  transport.peerSend({ type: 'input_audio_buffer.committed' });
  transport.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript });
}

test('AC1: the 57279cc1 sequence delivers the sentence once — the model, with no new audio, repeats the call and is answered, not delivered', async () => {
  const logs: string[] = [];
  const { socket, transport, base } = wireConnection({ log: (line) => logs.push(line) });
  await waitFor(() => transport.openCalls >= 1);

  // 15:39:54–15:39:57 — two real utterances, each committed upstream and transcribed.
  deliverCommittedUtterance(transport, 'i-190', '呃，我们原来的这些风格还是有蛮大的差异。');
  deliverCommittedUtterance(transport, 'i-197', '这个应该要检查和讨论一下。');

  // 15:39:57.837 — the model relays the two pieces as one coalesced sentence.
  const sentence = '我们原来的这些风格还是有蛮大的差异，这个应该要检查和讨论一下。';
  deliverSessionSendCall(transport, 'call-1', sentence);
  await waitFor(() => base.calls.length === 1);
  assert.equal(base.calls[0]?.args.message, sentence);

  // 15:40:13 / 15:40:29 — NO speech, NO commit, NO transcription: the upstream starts a response on
  // its own and the model re-issues the SAME literal. Both must be recognised as an echo.
  for (const callId of ['call-2', 'call-3']) {
    transport.peerSend({
      type: 'conversation.item.created',
      item: { id: `item-${callId}`, type: 'message', role: 'assistant' },
      previous_item_id: 'item-1',
    });
    transport.peerSend({ type: 'response.created', response: { id: `resp-${callId}` } });
    deliverSessionSendCall(transport, callId, sentence);
    await waitFor(() => fillBackFor(transport, callId) !== undefined);
  }

  assert.equal(base.calls.length, 1, 'the same spoken sentence must reach the session exactly once');

  // Each repeat was answered as already-delivered — not left hanging, and NOT refused.
  for (const callId of ['call-2', 'call-3']) {
    const output = fillBackFor(transport, callId)!.output as { accepted?: unknown; instruction?: unknown };
    assert.equal(output.accepted, true, `${callId} must be answered as accepted`);
    assert.match(String(output.instruction), /already reached the session/);
  }
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'refused'),
    false,
    'an echo is not a queue-full refusal',
  );

  // The journal the operator reads records both non-deliveries.
  assert.equal(
    logs.filter((line) => line.includes('not-delivered (duplicate')).length,
    2,
    `two non-deliveries must be recorded: ${logs.join(' | ')}`,
  );
});

test('AC2 (negative control): the f6166468 late forward — commits present, a different literal — is still delivered', async () => {
  const { transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverCommittedUtterance(transport, 'i-50', '先这样吧。');
  deliverSessionSendCall(transport, 'call-1', '先这样吧。');
  await waitFor(() => base.calls.length === 1);

  // 00:14:54 — two commits land after that delivery; the model first answers in TEXT
  // ("No response requested.") then forwards a literal it has never sent.
  transport.peerSend({ type: 'input_audio_buffer.committed' });
  transport.peerSend({ type: 'input_audio_buffer.committed' });
  transport.peerSend({ type: 'response.created', response: { id: 'resp-text' } });
  transport.peerSend({ type: 'response.done' });
  deliverSessionSendCall(transport, 'call-2', '啊，稍好一点。');
  await waitFor(() => base.calls.length === 2);
  assert.equal(base.calls[1]?.args.message, '啊，稍好一点。');
});

test('AC2 (negative control): no new speech but a literal no recent delivery restates is still delivered', async () => {
  const { transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverCommittedUtterance(transport, 'i-1', '把超时改成五十秒。');
  deliverSessionSendCall(transport, 'call-1', '把超时改成五十秒。');
  await waitFor(() => base.calls.length === 1);

  // No new commit, no new transcription — but these are words the session has never held, and they
  // are not a restatement of anything recently delivered (the interrupt's next message and the
  // `b33412ea` late forward have this shape). The watermark decides there is no NEW SPAN; the
  // restatement window decides this call is not an echo of an old one; so it is a delivery.
  deliverSessionSendCall(transport, 'call-2', '再检查一下日志。');
  await waitFor(() => base.calls.length === 2);
  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    ['把超时改成五十秒。', '再检查一下日志。'],
    'a response that adds words the session never had must not be dropped on the watermark alone',
  );
});

test('AC3 (negative control): the user really repeating the same words (a fresh commit) is delivered', async () => {
  const { transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverCommittedUtterance(transport, 'i-1', '再说一遍。');
  deliverSessionSendCall(transport, 'call-1', '再说一遍。');
  await waitFor(() => base.calls.length === 1);

  // The user says it AGAIN: a fresh commit lands, so the counter is > 0 and the echo guard must
  // not fire even though the literal is identical to the last delivery.
  transport.peerSend({ type: 'input_audio_buffer.committed' });
  deliverSessionSendCall(transport, 'call-2', '再说一遍。');
  await waitFor(() => base.calls.length === 2);
  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    ['再说一遍。', '再说一遍。'],
    'a genuine repetition has new audio behind it and must reach the session',
  );
});

test('AC3 (negative control): a repeat announced by a TRANSCRIPTION alone — no commit the proxy saw — is delivered', async () => {
  const { transport, base } = wireConnection();
  await waitFor(() => transport.openCalls >= 1);

  deliverCommittedUtterance(transport, 'i-1', '再说一遍。');
  deliverSessionSendCall(transport, 'call-1', '再说一遍。');
  await waitFor(() => base.calls.length === 1);

  // The user says it again and upstream announces the repeat by its COMPLETED TRANSCRIPTION only:
  // no `input_audio_buffer.committed` the proxy observes. That is still a genuinely new utterance —
  // the very signal the bridge ends an utterance on (`callsSinceUtterance = 0`) — so the echo guard
  // must not fire. `voice-realtime-status-injection.test.ts`'s scripted stand-in drives every turn
  // this way, which is why the guard counts a final caption as well as a commit; were it to key on
  // the commit alone, that whole criterion would starve (its repeats would never reach the executor).
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'i-2',
    transcript: '再说一遍。',
  });
  deliverSessionSendCall(transport, 'call-2', '再说一遍。');
  await waitFor(() => base.calls.length === 2);
  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    ['再说一遍。', '再说一遍。'],
    'a repeat upstream announced by transcript alone must reach the session',
  );
});

// ── AC2 (R2): the three live journals, replayed against the settle producer ─────────────────────
//
// THE DEFECT THIS FILE'S NEW ARM REPRODUCES. On 2026-10-17 the dropped-input audit aligned every
// final transcription in six journals against the `session_send` calls on the same connection. Four
// rounds lost input; `764f0c7a` lost 3 of 5 sentences. The losses were not "the model heard and
// refused": they were utterances for which the endpoint opened NO response (A), calls the next
// utterance truncated (B), and calls that answered only the newest span. The model was the delivery
// judge, and the judge was absent.
//
// THE THREE SEQUENCES BELOW ARE THOSE JOURNALS, reduced to the events that decide delivery. They are
// replayed against the SHIPPED producer, so what is measured is the rule and not a fixture:
//   · `57279cc1` — one sentence relayed three times, 15:39:57 / 15:40:13 / 15:40:30 (CST). The
//     settlement must deliver it ONCE; the watermark, not a text comparison, is what refuses the
//     repeats.
//   · `764f0c7a` — five finals, two answers (`05:40:38` and `05:42:12Z`). The three unanswered
//     sentences must each reach the session verbatim: no lost span, and no span delivered twice.
//   · `3d2d3b2c` — the endpoint misheard "LiveWire" as "来望也" and the model repaired it from the
//     audio. The response is the delivery, WHOLE: the mishearing is not prepended (that was the
//     deleted fragment heuristic), and the sentence is delivered once.

/** The endpoint's final transcription of one input item — what arms the settle window. */
function deliverFinalTranscript(transport: FakeTransport, itemId: string, text: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  });
}

/** A macrotask boundary wide enough for one settle window (the callers set it well below `wait`). */
const settleWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('AC2 replay 57279cc1: one heard sentence relayed three times is delivered exactly once', async () => {
  const SENTENCE = '我们原来的这些风格还是有蛮大的差异，这个应该要检查和讨论一下。';
  // Long enough that only the model's own response can settle the span in this case: the triple
  // re-send is about the WATERMARK, not about the deadline.
  const { transport, base } = wireConnection({ settleMs: 60_000 });
  await waitFor(() => transport.openCalls >= 1);

  deliverFinalTranscript(transport, 'item-57279-1', SENTENCE);
  deliverSessionSendCall(transport, 'call-57279-1', SENTENCE);
  await waitFor(() => base.calls.length === 1);

  // The same response twice more with NO new audio behind it — the live shape (three calls, 33 s
  // apart, identical words). The first settled the span; the watermark says there is nothing new
  // for the others to deliver.
  deliverSessionSendCall(transport, 'call-57279-2', SENTENCE);
  deliverSessionSendCall(transport, 'call-57279-3', SENTENCE);
  await waitFor(() => (transport.sent.filter((message) => message.type === 'function_call_output').length) >= 3);
  await settleWait(20);

  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    [SENTENCE],
    'one heard span is one delivery however many times the model restates it',
  );
});

test('AC2 replay 764f0c7a: five heard sentences, two model answers — every span delivered once, none lost', async () => {
  const SPOKEN = [
    '让我们讨论Live Voice的进一步改进及语音输出。',
    '当然，我并不希望这个语音输出只是简单把 Claude Code 的输出念一遍。',
    '它应当具有更好的实时性，然后呢，也能够更适合原来用户在持续的语音对话中所需要的一些特征。',
    '另一方面呢，我也认为我们并不需要使用特别大的模型。',
    '我们来进一步讨论一下这个问题。',
  ];
  const ANSWERED = [
    '当然，我并不希望这个语音输出只是简单把 Claude Code 的输出念一遍。',
    '我们来进一步讨论一下这个问题。',
  ];
  // A short window: the two unanswered spans must be delivered by the deadline, which is the arm
  // this journal's 3-of-5 loss lived on. A missed deadline shows up as a missing text below.
  const { transport, base } = wireConnection({ settleMs: 40 });
  await waitFor(() => transport.openCalls >= 1);

  // 1 — heard, never answered (the journal's first call was truncated by the next turn).
  deliverFinalTranscript(transport, 'item-764-1', SPOKEN[0]!);
  await waitFor(() => base.calls.length === 1);

  // 2 — heard, answered inside the window.
  deliverFinalTranscript(transport, 'item-764-2', SPOKEN[1]!);
  deliverSessionSendCall(transport, 'call-764-2', ANSWERED[0]!);
  await waitFor(() => base.calls.length === 2);

  // 3 and 4 — heard, never answered.
  deliverFinalTranscript(transport, 'item-764-3', SPOKEN[2]!);
  await waitFor(() => base.calls.length === 3);
  deliverFinalTranscript(transport, 'item-764-4', SPOKEN[3]!);
  await waitFor(() => base.calls.length === 4);

  // 5 — heard, answered inside the window.
  deliverFinalTranscript(transport, 'item-764-5', SPOKEN[4]!);
  deliverSessionSendCall(transport, 'call-764-5', ANSWERED[1]!);
  await waitFor(() => base.calls.length === 5);

  // Let a late deadline fire if one was left armed: a span already settled must produce NOTHING.
  await settleWait(80);

  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    [SPOKEN[0], ANSWERED[0], SPOKEN[2], SPOKEN[3], ANSWERED[1]],
    'each heard span is delivered once: the response where there is one, the endpoint\'s words otherwise',
  );
});

test('AC2 replay 3d2d3b2c: a model repair of an ASR mishearing is the whole delivery, never prefixed', async () => {
  const HEARD = '十月十五日，来望也，嗯，第一次考试。';
  const REPAIRED = '十月十五日，LiveWire 第一次测试。';
  const { transport, base } = wireConnection({ settleMs: 40 });
  await waitFor(() => transport.openCalls >= 1);

  deliverFinalTranscript(transport, 'item-3d2d-1', HEARD);
  // The model answers from the AUDIO, correcting the name. Under the deleted fragment guard the
  // pair overlap scored this repair as an omission and delivered the mishearing in front of it.
  deliverSessionSendCall(transport, 'call-3d2d-1', REPAIRED);
  await waitFor(() => base.calls.length === 1);
  await settleWait(80);

  assert.deepEqual(
    base.calls.map((call) => call.args.message),
    [REPAIRED],
    'a response that covers the span is delivered WHOLE; no text-side measure may prepend the transcript',
  );
});
