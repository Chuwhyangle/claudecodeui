/**
 * The Live Voice byte budget — the relay's admission rule, its refusal, and its readings.
 *
 * WHAT THIS FILE IS FOR. The bound used to count MESSAGES: three waiting and the next was refused.
 * Measured 2026-10-11 (19:22–19:30 CST, session `9db75ad5`): a four-minute turn in flight and the
 * operator's next EIGHT sentences — about 150 CJK characters, WELL UNDER 500 bytes together — were
 * every one refused (`VOICE_QUEUE_FULL depth=3 max=3`). The person ran out of patience for how much
 * they had SAID, not for how many times they had paused, so the admission axis is a UTF-8 byte
 * budget ({@link VOICE_QUEUE_MAX_BYTES}, 1000) and in-budget text is never refused, however many
 * messages it takes to say it.
 *
 * This file drives `handleVoiceRealtimeConnection` — the real proxy, offline, over the same fake
 * browser socket and fake transport the protocol-simulation suite uses — and pins:
 *
 *   · THE BYTE BOUNDARY (AC1). A message whose text fits is accepted; one that pushes the waiting
 *     total past the budget is refused before `base.session_send` is called at all, so it never
 *     reaches the CLI queue. THE FILE'S FIRST ASSERTION is the 1001-byte refusal's executor count,
 *     so restoring a message-count cap (or removing the bound) reddens this file at its first line.
 *   · IN-BUDGET TEXT IS NEVER REFUSED (AC3). The journal's eight sentences fit the budget together
 *     and every one is accepted — the defect this task exists to fix.
 *   · A REFUSAL DOES NOT CLOG THE PATH (AC4). After one message is refused, the NEXT one still
 *     reaches the executor: the refusal spends nothing.
 *   · THE READINGS. Every `sent`/`queued`/`refused` frame carries the pending byte total beside the
 *     message count, and both read 0 when nothing waits.
 *
 * TWO ROUTES, because the session has two ways of holding a message and the relay must bound both:
 * the session's own queue accepting a message (`queued: true`) and the relay's own busy wait
 * buffering what was said while the turn is still running.
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
 * up. Each acceptance is one more message the session is holding, and its text is bytes the relay
 * must not spend twice.
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
  maxQueuedVoiceBytes?: number;
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
    ...(options.maxQueuedVoiceBytes === undefined
      ? {}
      : { maxQueuedVoiceBytes: options.maxQueuedVoiceBytes }),
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

/** The frame shapes this file reads; `Extract` keeps them exact members of the union. */
type SentFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }>;
type QueuedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'queued' }>;
type RefusedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'refused' }>;

const sentFrames = (socket: FakeBrowserSocket): SentFrame[] =>
  socket.outbound.filter((frame): frame is SentFrame => frame.type === 'sent');
const queuedFrames = (socket: FakeBrowserSocket): QueuedFrame[] =>
  socket.outbound.filter((frame): frame is QueuedFrame => frame.type === 'queued');
const refusedFrames = (socket: FakeBrowserSocket): RefusedFrame[] =>
  socket.outbound.filter((frame): frame is RefusedFrame => frame.type === 'refused');
const functionCallOutputs = (transport: FakeTransport, callId: string) =>
  transport.sent.filter(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && message.callId === callId,
  );

/** ASCII text of exactly `bytes` UTF-8 bytes (one byte per character), for exact boundary reads. */
const asciiOfBytes = (bytes: number): string => 'x'.repeat(bytes);

// ── AC1: the byte boundary — the FILE'S FIRST ASSERTION ─────────────────────────────────────────
//
// Three fresh connections, so each message is judged against an empty pending total: the shipped
// budget (1000 bytes, NOT passed in — this pins the constant itself) accepts 999 and exactly 1000,
// and refuses 1001. The FIRST assertion this file runs is the 1001 refusal's executor count: the
// refused message must never reach `base.session_send`. A count cap would fail that line (the fourth
// message would be refused regardless of size, and a 999-byte fourth message would be refused too).

test('the byte budget: 999 and 1000 bytes are accepted, 1001 is refused before the executor', async () => {
  // 999 bytes: fits (0 + 999 <= 1000).
  const under = createQueuedExecutor();
  const underConn = wireConnection({ executor: under.executor });
  await waitFor(() => underConn.transport.openCalls >= 1);
  deliverSessionSendCall(underConn.transport, 'call-1', asciiOfBytes(999));
  await waitFor(() => sentFrames(underConn.socket).length === 1);
  const underCalls = under.calls.length;

  // Exactly 1000 bytes: still fits (0 + 1000 <= 1000) — the budget is inclusive.
  const exact = createQueuedExecutor();
  const exactConn = wireConnection({ executor: exact.executor });
  await waitFor(() => exactConn.transport.openCalls >= 1);
  deliverSessionSendCall(exactConn.transport, 'call-1', asciiOfBytes(1000));
  await waitFor(() => sentFrames(exactConn.socket).length === 1);
  const exactCalls = exact.calls.length;

  // 1001 bytes: one over. This must be refused, and NOT reach the executor at all.
  const over = createQueuedExecutor();
  const overConn = wireConnection({ executor: over.executor });
  await waitFor(() => overConn.transport.openCalls >= 1);
  deliverSessionSendCall(overConn.transport, 'call-1', asciiOfBytes(1001));
  await waitFor(() => functionCallOutputs(overConn.transport, 'call-1').length === 1);

  // ── AC1's first assertion: one byte over the budget, the executor is never reached. ──
  assert.equal(
    over.calls.length,
    0,
    'a message over the byte budget must be refused before the session is reached, so no call may run',
  );

  // ── AC1: 999 and 1000 bytes were accepted, each as one delivery. ──
  assert.equal(underCalls, 1, '999 bytes fits the budget and must be delivered');
  assert.equal(exactCalls, 1, 'exactly 1000 bytes fits the budget and must be delivered');

  // ── The accepted sends report their byte reading on the wire. ──
  assert.equal(sentFrames(underConn.socket)[0]!.bytes, 999);
  assert.equal(sentFrames(exactConn.socket)[0]!.bytes, 1000);

  // ── AC1: the browser is told, and told the byte total it happened at. ──
  assert.equal(refusedFrames(overConn.socket).length, 1, 'the browser must receive exactly one refusal');
  const refused = refusedFrames(overConn.socket)[0]!;
  assert.equal(refused.reason, 'queue-full');
  assert.equal(refused.bytes, 1001, 'the refusal carries the pending byte total it happened at');

  underConn.socket.close();
  exactConn.socket.close();
  overConn.socket.close();
});

// ── AC4: a refusal spends nothing — the next message still goes through ─────────────────────────

test('after a refusal the next delivery still reaches the executor', async () => {
  const base = createQueuedExecutor();
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitFor(() => transport.openCalls >= 1);

  // Over budget: refused, executor untouched.
  deliverSessionSendCall(transport, 'call-1', asciiOfBytes(1001));
  await waitFor(() => functionCallOutputs(transport, 'call-1').length === 1);
  const afterRefusal = base.calls.length;

  // A message that fits now must still be delivered: the refusal must not have clogged the path.
  deliverSessionSendCall(transport, 'call-2', 'a short one that fits');
  await waitFor(() => sentFrames(socket).length === 1);
  assert.equal(
    base.calls.length,
    afterRefusal + 1,
    'the message after a refusal must still reach the executor — the refusal spent nothing',
  );
  assert.equal(base.calls[base.calls.length - 1]!.args.message, 'a short one that fits');

  socket.close();
});

// ── AC3: in-budget text is never refused — the journal's eight sentences ────────────────────────

/** The eight sentences the operator spoke in the four-minute turn (session `9db75ad5`). */
const JOURNAL_SENTENCES = [
  '这个判断不要放在前端的渲染层里',
  '把它挪到服务端的那条处理链上面',
  '顺带把重复的那段逻辑一起清掉',
  '还有缓存的那个键名也顺手改一下',
  '日志里要多打一行输入的原始内容',
  '测试里补一个边界用例再跑一遍看',
  '如果有冲突先别合并等我确认再说',
  '剩下的几个小问题我一并说完了',
];

test('the journal turn: eight sentences well under the budget are all accepted, none refused', async () => {
  const totalBytes = JOURNAL_SENTENCES.reduce((sum, sentence) => sum + Buffer.byteLength(sentence, 'utf8'), 0);
  // The premise itself: these sentences really are far inside a 1000-byte budget (and well under
  // the 500 bytes the journal recorded), so the readings below are about the defect, not the fixture.
  assert.ok(totalBytes < 500, `the eight sentences must together be well under 500 bytes (got ${totalBytes})`);

  const base = createQueuedExecutor();
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitFor(() => transport.openCalls >= 1);

  for (let index = 0; index < JOURNAL_SENTENCES.length; index += 1) {
    // The person SPOKE each sentence before the model relayed it, so the upstream transcribed an
    // utterance between two calls. Replaying that here is not decoration: the bridge's loop guard
    // stops the model after six calls in a row with no utterance in between, and the journal's turn
    // was exactly eight utterances each followed by one relay.
    const utterance: RealtimeServerMessage = {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `utterance-${index + 1}`,
      transcript: JOURNAL_SENTENCES[index]!,
    } as RealtimeServerMessage;
    transport.peerSend(utterance);
    deliverSessionSendCall(transport, `call-${index + 1}`, JOURNAL_SENTENCES[index]!);
    await waitFor(() => functionCallOutputs(transport, `call-${index + 1}`).length === 1);
  }

  assert.equal(refusedFrames(socket).length, 0, 'in-budget text must never be refused');
  assert.equal(
    base.calls.length,
    JOURNAL_SENTENCES.length,
    'every one of the eight in-budget sentences must reach the session',
  );

  socket.close();
});

// ── The bound, reached through the relay's own busy wait ────────────────────────────────────────
//
// The route the operator hit: the session is mid-turn, so the relay buffers what was said while it
// waits. That buffer is bounded by the SAME byte budget — three short utterances fit, the fourth
// (which would push past it) is refused, and the refused delivery is never handed to the executor.

test('through the busy-session wait, the utterance that exceeds the budget is never handed over', async () => {
  const base = createBusyExecutor();
  const logs: string[] = [];
  const { socket, transport } = wireConnection({
    executor: base.executor,
    // `the first` is 9 bytes and opens the wait; three 9-byte utterances fit (27 <= 30); the next
    // 9-byte utterance would make 36 and is refused.
    maxQueuedVoiceBytes: 30,
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

  // The pending bytes are now at the budget. The next utterance is refused, and the executor sees
  // nothing new.
  deliverSessionSendCall(transport, 'call-5', 'message 5');
  await waitFor(() => functionCallOutputs(transport, 'call-5').length === 1);
  assert.equal(base.calls.length, callsWhileWaiting, 'the refused round must add no executor call');
  assert.equal(
    base.calls.some((call) => call.args.message === 'message 5'),
    false,
    'a message refused while the session is busy must never reach the executor',
  );
  assert.equal(refusedFrames(socket).length, 1, 'the browser must receive exactly one refusal');
  const refused = refusedFrames(socket)[0]!;
  assert.equal(refused.reason, 'queue-full');
  assert.equal(refused.bytes, 36, 'the refusal carries the pending byte total it happened at');

  const output = functionCallOutputs(transport, 'call-5')[0]!.output as { accepted: boolean; reason: string };
  assert.equal(output.accepted, false);
  assert.equal(output.reason, VOICE_QUEUE_FULL_REASON);

  socket.close();
});

// ── The readings, and their zero control ────────────────────────────────────────────────────────

test('every send reports its depth and bytes, and both read 0 when the session started a run', async () => {
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
  assert.equal(sentFrames(socket)[0]!.bytes, 0, 'and nothing to spend the byte budget on');

  const queued = createQueuedExecutor();
  const second = wireConnection({ executor: queued.executor });
  await waitFor(() => second.transport.openCalls >= 1);
  deliverSessionSendCall(second.transport, 'call-1', 'held by the session');
  await waitFor(() => sentFrames(second.socket).length === 1);
  assert.equal(sentFrames(second.socket)[0]!.depth, 1, 'a send the session queued is one waiting');
  assert.equal(
    sentFrames(second.socket)[0]!.bytes,
    Buffer.byteLength('held by the session', 'utf8'),
    'and its text is the byte reading',
  );

  socket.close();
  second.socket.close();
});

// ── The window is ONE message, so its own tail is never refused for its head ────────────────────

test('a call joining an open coalescing window is not refused at the budget: the window counts once', async () => {
  const base = createQueuedExecutor();
  const { socket, transport } = wireConnection({
    executor: base.executor,
    coalesceMs: 100,
    // Enough for the window's opening piece ('first half', 10 bytes) — so the window opens — but not
    // for the two halves summed; the join must still be let through, because it is the same message.
    maxQueuedVoiceBytes: 20,
  });
  await waitFor(() => transport.openCalls >= 1);

  // The window opens: this delivery is the one message waiting.
  deliverSessionSendCall(transport, 'call-1', 'first half');
  await waitFor(() => queuedFrames(socket).length === 1);

  // The tail of the same sentence lands INSIDE the window. Charging it as a new message would refuse
  // it for the budget its own head already spends — so it joins, and the window flushes as ONE message.
  deliverSessionSendCall(transport, 'call-2', 'second half');
  await waitFor(() => base.calls.length === 1);
  assert.deepEqual(
    refusedFrames(socket),
    [],
    'the tail of a sentence must not be refused for the budget its own head is spending',
  );
  assert.equal(base.calls[0]?.args.message, 'first half second half', 'the window is delivered as one message');

  socket.close();
});
