/**
 * AC-342 (GOAL-041 §18.4 G1 / §18.7 F2): an interrupt ENQUEUES the correction before it aborts.
 *
 * WHAT WAS WRONG. `sessionInterrupt` aborted FIRST and only then released the pending voice text,
 * so a correction could be scheduled AFTER "the old queue forms its own turn" — the stale-first
 * defect SPEC §18.1 F-7. The fix is the SPEC's G1: send the correction into the CLI's own queue and
 * wait for the enqueue's confirmation BEFORE aborting, so the corrected words and the run they
 * correct ride the SAME turn, in speech order.
 *
 * THE RIGHT FORM IS THE E10/U2 FORM. E10 (`gap-claude-resident-e10-enqueue-interrupt-drain`) read
 * on the real binary that:
 *   · U1 — at the abort the CLI delivers EVERYTHING queued behind the running turn into the
 *     interrupt-closing turn; nothing queued is lost.
 *   · U2 — a correction pushed 0 ms after the interrupt lands in that same request, while one
 *     pushed ≥50 ms later lands a whole turn after (the stale-first window F-7 names).
 * The two together choose the implementation form the SPEC left open ("中断工具携带修正 vs. 冲刷合并
 * 窗口"): the correction travels as the `message` of the interrupt call, and the proxy enqueues it
 * AHEAD of the abort. That is `enqueue-then-abort`.
 *
 * HOW IT IS PROVEN. A scripted resident host models the CLI's own queue with E10's dequeue timing:
 * `enqueue` is a `queued:true` send, `interrupt` is the abort that drains the queue into the closing
 * turn. The REAL proxy is driven over a fake browser socket and a fake transport:
 *
 *   · FALSE FORM (F-7, driven end to end through the proxy): the correction is relayed as ordinary
 *     voice text (`session_send`) and the interrupt carries no `message`, so the abort drains the
 *     OLD message alone and the correction is released after — the stale-first turn the fix removes.
 *   · TRUE FORM: the correction rides the interrupt's `message`, is enqueued before the abort, and
 *     the interrupt-closing turn carries the old message AND the correction, correction LAST.
 *
 * AC2 then checks the cross-channel order (voice A, composer B, voice correction C ⇒ A, B, C); AC3
 * checks that a correction that cannot be enqueued aborts NOTHING; AC4 checks the interrupted turn's
 * input is not re-sent. The final test is DoD's "连说 3 句 → 修正 → 中断" walk, whose CLI-side
 * per-turn comparison is the reading written into the task's `## Notes`.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt-revision-order.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { type RealtimeServerMessage, type RealtimeToolExecutor } from '../index.js';
import {
  buildInterruptAftermathNote,
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * The text a CORRECTION reaches the CLI as, once the proxy is done with it.
 *
 * The stop's aftermath note rides the correction (ruling 2026-10-16): the note is armed before the
 * enqueue, so the message the stop's own words go in on is the one that carries the explanation of
 * the interruption. Every correction this file drives therefore arrives with this prefix — the
 * fixtures below compare against the text the CLI REALLY received rather than against the words
 * alone, because "the correction is carried once, in order" is a claim about that text.
 *
 * The tool-free form: this file wires no `hostRunActivity` seam, so the proxy's one reading of the
 * interrupted run's in-flight tool is `null` (and it never guesses one — C-3).
 */
const withAftermathNote = (text: string): string => `${buildInterruptAftermathNote(null)}\n\n${text}`;

/** A minimal stand-in for the browser's `ws.WebSocket` — the shape the handler uses, nothing more. */
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

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/**
 * The scripted resident host: the CLI's own queue, with E10's dequeue timing modelled.
 *
 * `enqueue` is the CLI accepting a message into its queue (a `session_send` that returned
 * `queued:true`). `interrupt` is the abort: E10/U1 read that cancelling the run in flight delivers
 * EVERYTHING queued behind it into the interrupt-closing turn, so the host drains its whole queue
 * into one turn and opens the next. That drain is what makes the ORDER of enqueue-vs-abort
 * observable — a correction enqueued before the abort rides the closing turn; one enqueued after
 * lands a turn late (E10/U2, the stale-first defect F-7).
 */
type ScriptedHost = {
  enqueue(text: string): void;
  interrupt(): void;
  /** The messages queued but not yet delivered — the NEXT turn's input. */
  pending(): string[];
  /** Every turn the host delivered, in order: the queue snapshot at each dequeue. */
  turns(): string[][];
};

function createScriptedHost(): ScriptedHost {
  const pending: string[] = [];
  const turns: string[][] = [];
  return {
    enqueue(text: string): void {
      pending.push(text);
    },
    interrupt(): void {
      turns.push([...pending]);
      pending.length = 0;
    },
    pending: () => [...pending],
    turns: () => turns.map((turn) => [...turn]),
  };
}

/** One `session_send` / `session_interrupt` the fake base executor recorded, with its args. */
type RecordedCall = { args: Record<string, unknown> };

/**
 * The fake base executor the real proxy wraps. `session_send` turns the message into a host enqueue
 * and answers the queue confirmation the proxy's G1 path requires; `session_interrupt` is the abort
 * that drains the host's queue into the closing turn. `failEnqueueFor` (a message text) makes that
 * one send answer WITHOUT the confirmation, modelling a correction the session refused to queue.
 *
 * `failEnqueueFor` / `throwOn` are matched by INCLUSION, not equality: a correction leaves the proxy
 * with the stop's aftermath note prefixed to it, so the text that arrives here is the note plus the
 * correction the fixture named. The correction's own words are still what identifies the send.
 */
type FakeBase = {
  sends: RecordedCall[];
  interrupts: RecordedCall[];
  executor: RealtimeToolExecutor;
};

function createFakeBase(
  host: ScriptedHost,
  options: { failEnqueueFor?: string; throwOn?: string } = {},
): FakeBase {
  const sends: RecordedCall[] = [];
  const interrupts: RecordedCall[] = [];
  let calls = 0;
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push({ args });
      const text = typeof args.message === 'string' ? args.message : '';
      if (options.throwOn !== undefined && text.includes(options.throwOn)) {
        throw new Error('the session refused this message');
      }
      if (options.failEnqueueFor !== undefined && text.includes(options.failEnqueueFor)) {
        // A send that reached the session but did NOT enter its queue: nothing waiting took it.
        return { ok: true, queued: false, runId: null, queuedMessageUuid: null };
      }
      host.enqueue(text);
      calls += 1;
      return { ok: true, queued: true, runId: `run-${calls}`, queuedMessageUuid: `uuid-${calls}` };
    },
    session_interrupt: async (args: Record<string, unknown>) => {
      interrupts.push({ args });
      host.interrupt();
      return { aborted: true };
    },
  };
  return { sends, interrupts, executor };
}

/** Wires one fresh real-proxy connection over a fake browser socket and a fake transport. */
function wireConnection(options: {
  executor: RealtimeToolExecutor;
  coalesceMs?: number;
  logs?: string[];
}): { socket: FakeBrowserSocket; transport: FakeTransport } {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => options.executor,
    instructions: 'test instructions',
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    ...(options.logs === undefined ? {} : { log: (line: string) => options.logs!.push(line) }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'revision-order-session',
    seams,
  );
  return { socket, transport };
}

/** Delivers one `function_call` event from the fake upstream. */
function deliverFunctionCall(transport: FakeTransport, callId: string, name: string, args: unknown): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name,
    callId,
    arguments: JSON.stringify(args),
  };
  transport.peerSend(call);
}

/** Delivers one voice utterance: the model relays `message` through `session_send`. */
function relayVoice(transport: FakeTransport, callId: string, message: string): void {
  deliverFunctionCall(transport, callId, 'session_send', { message });
}

const functionCallOutputs = (transport: FakeTransport, callId: string) =>
  transport.sent.filter(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && message.callId === callId,
  );

/** The receipt one `session_interrupt` call answered with. */
function stopReceipt(transport: FakeTransport, callId: string): Record<string, unknown> {
  const outputs = functionCallOutputs(transport, callId);
  assert.equal(outputs.length, 1, `expected exactly one receipt for ${callId}`);
  return outputs[0]!.output as Record<string, unknown>;
}

const waitForOpen = async (socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> => {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
};

/**
 * The stale-first reading over the host's turns: a turn that carries a pre-correction message but
 * NOT the correction. SPEC §18.4 G1's target is that this counts ZERO after an interrupt.
 *
 * Membership is BY CONTAINMENT because the correction arrives with the aftermath note prefixed: the
 * turn's entry is the note plus the correction, so the correction is what identifies it.
 */
const staleFirstTurns = (host: ScriptedHost, correction: string): string[][] =>
  host.turns().filter((turn) => !turn.some((entry) => entry.includes(correction)));

// ── AC1: the correction rides the interrupt-closing turn, in order — and the OLD form reddens ────

test('AC1 false form: aborting BEFORE the enqueue leaves the correction a turn late (stale-first)', async () => {
  const host = createScriptedHost();
  // A message from an earlier turn is already in the CLI's queue.
  host.enqueue('do the first thing');
  const base = createFakeBase(host);
  // A window that will NOT fire on its own: the correction is held until the stop releases it.
  const { socket, transport } = wireConnection({ executor: base.executor, coalesceMs: 60_000 });
  await waitForOpen(socket, transport);

  // The model relays the CORRECTION as ordinary voice text — it is not carried by the interrupt.
  // It opens a coalescing window and is HELD there (60 s), so nothing reaches the CLI yet.
  relayVoice(transport, 'call-correction', 'no, do the second thing instead');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'queued'));
  assert.equal(base.sends.length, 0, 'the correction is held in the window, not yet in the CLI queue');
  // …and then judges a stop is needed, with NO `message` on the interrupt call.
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user changed their mind' });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
  await waitFor(() => base.sends.length === 1);

  // The abort drained the queue BEFORE the correction was released: the closing turn has the old
  // message ALONE, and the correction is still waiting — the stale-first turn the fix must remove.
  const firstTurn = host.turns()[0] ?? [];
  assert.deepEqual(
    firstTurn,
    ['do the first thing'],
    'the false form leaves the correction out of the interrupt-closing turn (SPEC §18.1 F-7)',
  );
  assert.ok(
    staleFirstTurns(host, 'no, do the second thing instead').length >= 1,
    'the old form produces at least one stale-first turn — the red F2 must fix',
  );
});

test('AC1 true form: the correction is enqueued before the abort and rides the SAME turn, last', async () => {
  const host = createScriptedHost();
  host.enqueue('do the first thing');
  const base = createFakeBase(host);
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitForOpen(socket, transport);

  const correction = 'no, do the second thing instead';
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
    intent: 'the user is correcting the direction',
    message: correction,
  });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  // ── the correction reached the CLI's queue BEFORE the abort … ──
  assert.equal(base.sends.length, 1, 'the correction was delivered as a session_send first');
  // …as the stop's OWN message: the interruption's note rides it, and the correction's words are
  // intact at the end of it (see `withAftermathNote`).
  assert.equal(base.sends[0]!.args.message, withAftermathNote(correction));
  assert.ok(String(base.sends[0]!.args.message).endsWith(correction), 'the correction is carried verbatim');
  assert.equal(base.interrupts.length, 1, 'and exactly one abort followed it');
  // …so the interrupt-closing turn carries the old message AND the correction, correction LAST.
  const firstTurn = host.turns()[0] ?? [];
  assert.deepEqual(
    firstTurn,
    ['do the first thing', withAftermathNote(correction)],
    'the next turn\'s input carries the old queued message then the correction, in speech order',
  );
  // The SPEC §18.4 G1 target: ZERO stale-first turns.
  assert.equal(
    staleFirstTurns(host, correction).length,
    0,
    'no turn may carry a pre-correction message without the correction',
  );
  // The receipt is the abort's own answer plus the audit readings (AC-339), not a refusal.
  const receipt = stopReceipt(transport, 'call-stop');
  assert.equal(receipt['aborted'], true, 'the stop really aborted the run it corrected');
  socket.close();
});

// ── AC2: cross-channel order — voice A, composer B, voice correction C ⇒ the CLI receives A, B, C ─

test('AC2: a composer message interleaved between two voice relays keeps its order ahead of the correction', async () => {
  const host = createScriptedHost();
  const base = createFakeBase(host);
  // No coalescing window: the voice relays reach the CLI's queue in the order they are made.
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitForOpen(socket, transport);

  // A — the person SPOKE this and the model relayed it.
  relayVoice(transport, 'call-a', 'start the deploy');
  await waitFor(() => base.sends.length === 1);
  await waitFor(() => host.pending().length === 1);

  // B — the person TYPED this into the composer. The composer is not this proxy's channel; it shares
  // the CLI's own queue (A+ leaves the delivery channel alone), so it is modelled as the CLI taking
  // the message directly. The criterion's claim is about the ORDER the CLI ends up with.
  host.enqueue('and also bump the version');

  // C — the person SPOKE a correction; the model carries it on the interrupt call.
  const correction = 'wait — deploy to staging, not production';
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
    intent: 'the user is correcting the direction',
    message: correction,
  });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  const firstTurn = host.turns()[0] ?? [];
  assert.deepEqual(
    firstTurn,
    ['start the deploy', 'and also bump the version', withAftermathNote(correction)],
    'the CLI receives the voice relay, the composer text and the voice correction in occurrence order',
  );
  socket.close();
});

// ── AC3: a correction that cannot be enqueued aborts NOTHING, and says why ──────────────────────

test('AC3: a correction the session refused to queue aborts nothing and answers stopped:false', async () => {
  const host = createScriptedHost();
  const correction = 'no, do the second thing instead';
  const base = createFakeBase(host, { failEnqueueFor: correction });
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitForOpen(socket, transport);

  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
    intent: 'the user is correcting the direction',
    message: correction,
  });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  // The correction was attempted but NOT queued, so the abort must not run.
  assert.equal(base.sends.length, 1, 'the correction was attempted as a delivery');
  assert.equal(base.interrupts.length, 0, 'an enqueue that was not confirmed must not abort the run');
  const receipt = stopReceipt(transport, 'call-stop');
  assert.equal(receipt['stopped'], false, 'the receipt must not claim a stop that did not happen');
  assert.equal(receipt['reason'], 'revision-not-enqueued');
  assert.match(String(receipt['detail']), /confirm/, 'the receipt must say WHY the correction was not queued');
  // Nothing was stopped: no turn was drained.
  assert.deepEqual(host.turns(), [], 'no abort means no closing turn');
  socket.close();
});

test('AC3: a delivery that throws while enqueuing the correction also aborts nothing', async () => {
  const host = createScriptedHost();
  const correction = 'no, do the second thing instead';
  const base = createFakeBase(host, { throwOn: correction });
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitForOpen(socket, transport);

  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
    intent: 'the user is correcting the direction',
    message: correction,
  });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  assert.equal(base.interrupts.length, 0, 'a delivery that threw must not be followed by an abort');
  const receipt = stopReceipt(transport, 'call-stop');
  assert.equal(receipt['stopped'], false);
  assert.equal(receipt['reason'], 'revision-not-enqueued');
  assert.deepEqual(host.turns(), [], 'nothing was stopped');
  socket.close();
});

// ── AC4: the interrupted turn's input is not re-sent (SPEC §18.1 F-8) ───────────────────────────

test('AC4: the interrupted turn\'s input is carried once, never re-sent', async () => {
  const host = createScriptedHost();
  host.enqueue('do the first thing');
  const base = createFakeBase(host);
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitForOpen(socket, transport);

  const correction = 'no, do the second thing instead';
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
    intent: 'the user is correcting the direction',
    message: correction,
  });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  // Every message the CLI received, across every turn, flattened — the never-re-send reading.
  // Counted BY CONTAINMENT: the correction arrives as the stop's own message with the aftermath note
  // prefixed (see `withAftermathNote`), so "the correction was carried once" is the entry that
  // carries its words, not an entry equal to them.
  const delivered = host.turns().flat();
  const countOf = (text: string): number => delivered.filter((entry) => entry.includes(text)).length;
  assert.equal(countOf('do the first thing'), 1, 'the interrupted turn\'s input must appear exactly once');
  assert.equal(
    countOf(correction),
    1,
    'the correction must be delivered exactly once — never re-sent by the abort',
  );
  socket.close();
});

// ── DoD: the "连说 3 句 → 修正 → 中断" walk, its CLI-side per-turn comparison printed as evidence ──

test('DoD: three spoken sentences, then a correction, then an interrupt — the CLI-side per-turn input', async (t) => {
  const host = createScriptedHost();
  const base = createFakeBase(host);
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitForOpen(socket, transport);

  // Three sentences spoken into the working session, relayed one after another. E10/U3 read that the
  // CLI delivers N queued messages as ONE turn's input, in push order; the host models that by
  // holding them in `pending` until the interrupt drains them.
  const spoken = ['please refactor the parser module', 'then run the server test suite', 'and update the changelog'];
  for (const [index, sentence] of spoken.entries()) {
    relayVoice(transport, `call-say-${index}`, sentence);
    // Wait for each delivery: `deliverSessionSend` is single-flight, so back-to-back relays would
    // race the guard rather than queue in order.
    await waitFor(() => base.sends.length === index + 1);
  }
  assert.deepEqual(host.pending(), spoken, 'the three sentences are queued in speech order, none delivered yet');

  // The correction, then the interrupt that carries it.
  const correction = 'actually, skip the changelog — just refactor and test';
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
    intent: 'the user corrected the direction of the running work',
    message: correction,
  });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  const turns = host.turns();
  const lines = turns.map((turn, index) => `turn[${index}] (${turn.length} msg): ${turn.join(' ⏎ ')}`);
  t.diagnostic(`DoD CLI-side per-turn input (correction="${correction}")`);
  for (const line of lines) {
    t.diagnostic(`  ${line}`);
  }
  t.diagnostic(`  stale-first turns = ${staleFirstTurns(host, correction).length}`);
  t.diagnostic(`  abort count = ${base.interrupts.length}, sends = ${base.sends.length}`);

  // The one turn the interrupt closes carries all four inputs, in occurrence order, correction last
  // — the correction as the stop's own message, aftermath note and all (see `withAftermathNote`).
  assert.deepEqual(
    turns[0],
    [...spoken, withAftermathNote(correction)],
    'the interrupt-closing turn carries the three sentences then the correction, in order',
  );
  assert.equal(staleFirstTurns(host, correction).length, 0, 'stale-first turns must be zero');
  assert.equal(base.interrupts.length, 1, 'exactly one abort');
  socket.close();
});
