/**
 * Bounded Live Voice queueing — the relay's cap, its refusal, and the depth reading.
 *
 * WHAT THIS FILE IS FOR. Measured 2026-10-11 (01:54–01:57 CST, tag `d88c6722`): the operator spoke
 * into a session whose turn was in flight; four deliveries were accepted, three of them silently
 * piled up in the session's own queue, and the screen showed one message. The relay had no bound
 * and no way to say "that one did not go". This file drives `handleVoiceRealtimeConnection` — the
 * real proxy, offline, over the same fake browser socket and fake transport the protocol-simulation
 * suite uses — and pins the three things the fix has to do:
 *
 *   · AT THE CAP, NOTHING REACHES THE SESSION. The next delivery is refused before
 *     `base.session_send` is called at all, so the message never reaches the CLI queue. This is the
 *     load-bearing reading: the provider's `cancelQueuedInput` slot is `false` for Claude, so a
 *     message already handed over cannot be taken back — the bound can only work BEFORE that call.
 *     The FILE'S FIRST ASSERTION is that count, so removing the cap reddens this file at its first
 *     line rather than somewhere the shape of the change could hide.
 *   · THE REFUSAL IS VISIBLE AND NAMED. The model reads a stable reason code
 *     ({@link VOICE_QUEUE_FULL_REASON}) and an instruction that says what happened to the words;
 *     the browser receives a `refused` frame carrying the same depth. "this one was refused" and
 *     "this one is waiting" are different readings.
 *   · THE DEPTH IS A NUMBER, AND IT IS ZERO WHEN NOTHING WAITS. Every accepted delivery reports the
 *     depth AFTER it landed; a send the session started immediately (`queued: false`) reports 0.
 *
 * TWO ROUTES TO THE CAP, because the session has two ways of holding a message and the relay must
 * bound both: the session's own queue accepting a message (`queued: true`) and the relay's own busy
 * wait buffering what was said while the turn is still running. Both are exercised below.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-bounded-queue.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_QUEUE_FULL_REASON,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses. Mirrors the protocol-simulation suite's own fake — the two
 * files drive the same handler, so they must drive it the same way.
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
 * The measured shape: a session that ACCEPTS every message into its own queue.
 *
 * `queued: true` is the result the real gateway returns for the send the operator measured piling
 * up ("Where one queued user message is in the CLI's own queue" — see the Claude provider). Each
 * such acceptance is one more message the session is holding, which is exactly what the relay's
 * depth counts.
 */
function createQueuedExecutor(): { calls: RecordedSend[]; executor: RealtimeToolExecutor } {
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, queued: true, runId: `run-${calls.length}`, queuedMessageUuid: `uuid-${calls.length}` };
    },
  };
  return { calls, executor };
}

/** A session that can start its run now (the negative control for the depth reading). */
function createStartedExecutor(): { calls: RecordedSend[]; executor: RealtimeToolExecutor } {
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, queued: false, runId: `run-${calls.length}`, queuedMessageUuid: null };
    },
  };
  return { calls, executor };
}

/**
 * A session mid-turn that NEVER finishes.
 *
 * The first call is refused as `SESSION_BUSY`; the retry after it hangs, so the relay stays in its
 * busy wait (`waitingForBusySession`) for the rest of the test. That is the state the unbounded
 * `waitingExtraMessages` buffer used to grow in — the route the operator actually hit — and it is
 * stable to read: `base.session_send` is called exactly twice and then never again.
 */
function createBusyExecutor(): { calls: RecordedSend[]; executor: RealtimeToolExecutor } {
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      if (calls.length === 1) {
        throw Object.assign(new Error('the session is mid-turn'), { code: 'SESSION_BUSY' });
      }
      // The turn never ends: the retry parks here, holding the relay in `sending` + `waitingForBusySession`.
      return new Promise<never>(() => undefined);
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
function wireConnection(options: {
  executor: RealtimeToolExecutor;
  maxQueuedVoiceDeliveries?: number;
  busyRetry?: { intervalMs: number; maxMs: number };
  coalesceMs?: number;
  logs?: string[];
}): { socket: FakeBrowserSocket; transport: FakeTransport; boundSessionId: string } {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const boundSessionId = 'session-under-test';
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => options.executor,
    instructions: 'test instructions',
    ...(options.maxQueuedVoiceDeliveries === undefined
      ? {}
      : { maxQueuedVoiceDeliveries: options.maxQueuedVoiceDeliveries }),
    ...(options.busyRetry === undefined ? {} : { busyRetry: options.busyRetry }),
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    ...(options.logs === undefined ? {} : { log: (line: string) => options.logs!.push(line) }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    boundSessionId,
    seams,
  );
  return { socket, transport, boundSessionId };
}

const sentFrames = (socket: FakeBrowserSocket) =>
  socket.outbound.filter((frame): frame is { type: 'sent'; depth: number } => frame.type === 'sent');
const refusedFrames = (socket: FakeBrowserSocket) =>
  socket.outbound.filter((frame): frame is { type: 'refused'; reason: string; depth: number } => frame.type === 'refused');
const functionCallOutputs = (transport: FakeTransport, callId: string) =>
  transport.sent.filter(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && message.callId === callId,
  );

// ── The cap, through the session's own queue ────────────────────────────────────────────────────
//
// The measured route: every send is accepted with `queued: true`, so the session holds each one.
// The third acceptance puts the depth at the cap; the fourth delivery must be refused before
// `base.session_send` is reached at all.

test('at the cap the next delivery is refused before it reaches the executor', async () => {
  const base = createQueuedExecutor();
  const logs: string[] = [];
  const { socket, transport } = wireConnection({ executor: base.executor, maxQueuedVoiceDeliveries: 3, logs });
  await waitFor(() => transport.openCalls >= 1);

  // Three deliveries, each accepted into the session's queue. Read with `waitFor` only — no
  // assertion before the one the criterion names, so this file's first assertion IS that reading.
  for (let index = 1; index <= 3; index += 1) {
    deliverSessionSendCall(transport, `call-${index}`, `message ${index}`);
    await waitFor(() => base.calls.length === index);
    await waitFor(() => sentFrames(socket).length === index);
  }
  const deliveredBefore = base.calls.length;

  // The cap is reached. This next call must NOT reach the session.
  deliverSessionSendCall(transport, 'call-4', 'the fourth');
  await waitFor(() => refusedFrames(socket).length === 1);

  // ── AC1's first assertion: after the cap, `base.session_send` is not called again. ──
  assert.equal(
    base.calls.length,
    deliveredBefore,
    'over the cap the relay must refuse before the session is reached, so no fourth call may run',
  );

  // ── AC1: the three below the cap each reported the depth after they landed. ──
  assert.equal(sentFrames(socket).map((frame) => frame.depth).join(','), '1,2,3');

  // ── AC3: the refused round added ZERO executor calls, and no call carries the refused words. ──
  assert.equal(base.calls.length - deliveredBefore, 0, 'the refused round must add no executor call');
  assert.equal(
    base.calls.some((call) => call.args.message === 'the fourth'),
    false,
    'the refused message must never reach the executor',
  );

  // ── AC1: the browser is told, and told which one. ──
  const refused = refusedFrames(socket)[0]!;
  assert.equal(refused.reason, 'queue-full');
  assert.equal(refused.depth, 3, 'the refusal carries the depth at which it happened');

  // ── AC1: the model reads a stable reason code and where the words went. ──
  await waitFor(() => functionCallOutputs(transport, 'call-4').length === 1);
  const output = functionCallOutputs(transport, 'call-4')[0]!.output as {
    accepted: boolean;
    reason: string;
    depth: number;
    instruction: string;
  };
  assert.equal(output.accepted, false);
  assert.equal(output.reason, VOICE_QUEUE_FULL_REASON);
  assert.equal(output.depth, 3);
  // The words are not silently dropped: the instruction names their disposition (kept as an
  // undelivered line on screen) and forbids the retry that would turn one refusal into a stream.
  assert.match(output.instruction, /NOT delivered/);
  assert.match(output.instruction, /not lost/);
  assert.match(output.instruction, /Do not call session_send again/);

  // ── The operator's log: the refusal line carries the reason, the depth and the cap. ──
  assert.ok(
    logs.some((line) => line.includes(`session_send refused: ${VOICE_QUEUE_FULL_REASON} depth=3 max=3`)),
    `the server log must carry the refusal, got:\n${logs.join('\n')}`,
  );

  socket.close();
});

// ── The cap, through the relay's own busy wait ──────────────────────────────────────────────────
//
// The route the operator hit: the session is mid-turn, so the relay buffers what was said while it
// waits. That buffer used to be unbounded; now the same cap bounds it, and the refused delivery is
// still never handed to the executor.

test('reached through the busy-session wait, the refused delivery is still never handed over', async () => {
  const base = createBusyExecutor();
  const logs: string[] = [];
  const { socket, transport } = wireConnection({
    executor: base.executor,
    maxQueuedVoiceDeliveries: 3,
    busyRetry: { intervalMs: 5, maxMs: 30_000 },
    logs,
  });
  await waitFor(() => transport.openCalls >= 1);

  // The first call is refused as busy, and its retry parks: the relay is now waiting out the turn.
  deliverSessionSendCall(transport, 'call-1', 'the first');
  await waitFor(() => base.calls.length === 2);

  // Three more utterances arrive while the relay waits. Each joins the waiting instruction.
  for (let index = 2; index <= 4; index += 1) {
    deliverSessionSendCall(transport, `call-${index}`, `message ${index}`);
  }
  await waitFor(
    () => logs.filter((line) => line.includes('joined the instruction waiting for the session')).length === 3,
  );
  const callsWhileWaiting = base.calls.length;

  // The buffer is at the cap. The next utterance is refused, and the executor sees nothing new.
  deliverSessionSendCall(transport, 'call-5', 'the fifth');
  await waitFor(() => refusedFrames(socket).length === 1);
  assert.equal(base.calls.length, callsWhileWaiting, 'the refused round must add no executor call');
  assert.equal(
    base.calls.some((call) => call.args.message === 'the fifth'),
    false,
    'a message refused while the session is busy must never reach the executor',
  );
  const refused = refusedFrames(socket)[0]!;
  assert.equal(refused.reason, 'queue-full');
  assert.equal(refused.depth, 3, 'the three utterances waiting behind the busy turn are the depth');

  await waitFor(() => functionCallOutputs(transport, 'call-5').length === 1);
  const output = functionCallOutputs(transport, 'call-5')[0]!.output as { accepted: boolean; reason: string };
  assert.equal(output.accepted, false);
  assert.equal(output.reason, VOICE_QUEUE_FULL_REASON);

  socket.close();
});

// ── The depth reading, and its zero control ─────────────────────────────────────────────────────

test('the delivery depth is reported on every send, and reads 0 when the session started a run', async () => {
  const started = createStartedExecutor();
  const { socket, transport } = wireConnection({ executor: started.executor });
  await waitFor(() => transport.openCalls >= 1);

  deliverSessionSendCall(transport, 'call-1', 'nothing is waiting');
  await waitFor(() => sentFrames(socket).length === 1);
  assert.equal(
    sentFrames(socket)[0]!.depth,
    0,
    'a send the session started at once (queued: false) leaves nothing waiting',
  );

  const queued = createQueuedExecutor();
  const second = wireConnection({ executor: queued.executor });
  await waitFor(() => second.transport.openCalls >= 1);
  deliverSessionSendCall(second.transport, 'call-1', 'held by the session');
  await waitFor(() => sentFrames(second.socket).length === 1);
  assert.equal(sentFrames(second.socket)[0]!.depth, 1, 'a send the session queued is one waiting');

  socket.close();
  second.socket.close();
});

// ── The window is ONE message, so its own tail is never refused for its head ────────────────────

test('a call joining an open coalescing window is not refused at the cap: the window counts once', async () => {
  const base = createQueuedExecutor();
  const { socket, transport } = wireConnection({
    executor: base.executor,
    coalesceMs: 100,
    maxQueuedVoiceDeliveries: 1,
  });
  await waitFor(() => transport.openCalls >= 1);

  // The window opens: this delivery is the one message waiting, and the depth is at the cap of 1.
  deliverSessionSendCall(transport, 'call-1', 'first half');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'queued'));

  // The tail of the same sentence lands INSIDE the window. Counting the pieces would refuse it for
  // the queue its own head is in — so it joins, and the window flushes as ONE message.
  deliverSessionSendCall(transport, 'call-2', 'second half');
  await waitFor(() => base.calls.length === 1);
  assert.deepEqual(
    refusedFrames(socket),
    [],
    'the tail of a sentence must not be refused for the queue its own head is in',
  );
  assert.equal(base.calls[0]?.args.message, 'first half second half', 'the window is delivered as one message');

  socket.close();
});
