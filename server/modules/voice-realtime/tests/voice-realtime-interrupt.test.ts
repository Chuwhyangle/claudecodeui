/**
 * The Live Voice STOP — `session_interrupt` offered to the relay model, and the one path that
 * deliberately bypasses the send machinery.
 *
 * WHAT THIS FILE IS FOR. Measured 2026-10-11: the operator spoke a stop into a session whose turn
 * was in flight and the turn kept going — the relay model was never offered a way to stop a run at
 * all (only `session_send` existed), and a stop queued behind the send it was meant to cancel would
 * never run anyway. This file drives `handleVoiceRealtimeConnection` — the real proxy, offline, over
 * the same fake browser socket and fake transport the bounded-queue suite uses — and pins four
 * things:
 *
 *   · AC1 — THE TOOL SURFACE. The names the relay model is offered are EXACTLY `session_send`,
 *     `session_interrupt` and `session_status` (`session_status` was added by
 *     `gap-live-voice-status-tool`, SPEC §6.3). The FILE'S FIRST ASSERTION is that set equality, so
 *     removing the interrupt tool (or leaking the six read tools into the relay's surface) reddens
 *     this file at its first line rather than somewhere the shape of the change could hide.
 *   · AC2 — IT IS NOT SINGLE-FLIGHT. While a `session_send` is parked in the busy-wait (the
 *     single-flight `sending` held, so a second send throws "A previous voice instruction is still
 *     being sent."), a `session_interrupt` still executes at once and the abort runs exactly once.
 *     Proven against a live control: the contrast send, delivered in the same state, DOES carry that
 *     error — so the bypass is a property of the interrupt path, not of the guard being absent.
 *   · AC3 — IT IS NOT JUDGED BY THE DELIVERY BOUND. With the waiting depth at the cap — the state in
 *     which the next `session_send` is refused with `VOICE_QUEUE_FULL` before it reaches the session
 *     — an interrupt still reaches the executor.
 *   · AC4 — A STOP IS NOT A TEARDOWN. The voice connection, the microphone and the messages already
 *     accepted all survive it; the backlog the stop did not throw away is counted in the frame it
 *     sends (`depth`, read BEFORE the release) and its first message is delivered IMMEDIATELY rather
 *     than waiting out its coalescing window.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';
import { z } from 'zod';

import { VOICE_REALTIME_TOOLS, type RealtimeServerMessage, type RealtimeToolExecutor } from '../index.js';
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
 * `handleVoiceRealtimeConnection` uses. Same shape as the bounded-queue suite's fake — the two files
 * drive the same handler, so they must drive it the same way.
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

/** One `session_send` / `session_interrupt` call the fake base executor recorded. */
type RecordedCall = { args: Record<string, unknown> };

/**
 * The fake executor every stop case is driven over.
 *
 * `sends` records EVERY `session_send` the executor was reached with — synchronously, before the
 * caller-supplied `sessionSend` behaviour runs — so a test can read "the send is in flight" the
 * instant it is dispatched, not only once it resolves. `sessionSend` is a caller-supplied behaviour,
 * so one fake covers the parked send (AC2), the queue-filling send (AC3) and the ordinary send whose
 * coalescing window AC4 releases. The interrupt route always records and always reports a stopped
 * run — it is the stand-in for the control service's own `abort`.
 */
function createStopExecutor(sessionSend: RealtimeToolExecutor['session_send']): {
  sends: RecordedCall[];
  interrupts: RecordedCall[];
  executor: RealtimeToolExecutor;
} {
  const sends: RecordedCall[] = [];
  const interrupts: RecordedCall[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push({ args });
      return sessionSend(args);
    },
    session_interrupt: async (args: Record<string, unknown>) => {
      interrupts.push({ args });
      return { aborted: true };
    },
  };
  return { sends, interrupts, executor };
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

/** Wires one fresh proxy connection over a fake browser socket and a fake transport. */
function wireConnection(options: {
  executor: RealtimeToolExecutor;
  maxQueuedVoiceBytes?: number;
  coalesceMs?: number;
  logs?: string[];
}): { socket: FakeBrowserSocket; transport: FakeTransport } {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => options.executor,
    instructions: 'test instructions',
    ...(options.maxQueuedVoiceBytes === undefined ? {} : { maxQueuedVoiceBytes: options.maxQueuedVoiceBytes }),
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    ...(options.logs === undefined ? {} : { log: (line: string) => options.logs!.push(line) }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport };
}

/** Waits until the proxy has reported the upstream open, so audio frames are forwarded not dropped. */
async function waitForOpen(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** The frame shapes this file reads; `Extract` keeps them exact members of the union. */
type RefusedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'refused' }>;
type StoppedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'stopped' }>;
type QueuedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'queued' }>;
type ErrorFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'error' }>;

const framesOf = <T extends VoiceRealtimeOutboundFrame>(socket: FakeBrowserSocket, type: T['type']): T[] =>
  socket.outbound.filter((frame): frame is T => frame.type === type);
const functionCallOutputs = (transport: FakeTransport, callId: string) =>
  transport.sent.filter(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && message.callId === callId,
  );

/**
 * The receipt one `session_interrupt` call answered with — the gateway's own payload plus the three
 * audit readings this plane adds (AC-339, SPEC §6.2/§10.3). Read through one helper so every stop
 * case in this file asserts on the same shape rather than on a hand-copied literal.
 */
type StopReceipt = {
  aborted: boolean;
  message?: string;
  runId: string | null;
  triggerSeq: number | null;
  queuedStillPending: number;
};

function stopReceipt(transport: FakeTransport, callId: string): StopReceipt {
  const outputs = functionCallOutputs(transport, callId);
  assert.equal(outputs.length, 1, `expected exactly one receipt for ${callId}`);
  return outputs[0]!.output as StopReceipt;
}

// ── AC1: the relay model is offered exactly the send tool and the interrupt tool ────────────────

test('AC1: the tools the Live Voice model is offered are exactly session_send, session_interrupt and session_status', () => {
  // ── AC1's first assertion: the name SET is exactly these three. ──
  // The surface grew by one tool since this criterion was written: `session_status` (SPEC §6.3) is
  // the FULL reading behind the compact status line the model already receives, so the relay model
  // can ask for the detail instead of guessing. The interrupt tool this file guards is still there —
  // the assertion is widened, not weakened: nothing was removed and no READ tool leaked in.
  assert.deepEqual(
    [...VOICE_REALTIME_TOOLS.map((tool) => tool.name)].sort(),
    ['session_send', 'session_interrupt', 'session_status'].sort(),
    'the relay model must be offered the send, stop and full-status tools, and nothing else',
  );

  // The surface is not the six read tools the MCP gateway registers: those are for a caller that
  // reasons, and this model only carries words over.
  assert.equal(VOICE_REALTIME_TOOLS.length, 3, 'the relay surface is exactly three tools');
  assert.equal(
    VOICE_REALTIME_TOOLS.some((tool) => tool.name === 'run_get' || tool.name === 'session_get'),
    false,
    'a read tool must never leak into the relay surface',
  );

  // Both descriptors carry a schema the model can be shown, and the interrupt one names its own tool.
  for (const tool of VOICE_REALTIME_TOOLS) {
    assert.ok(tool.description.length > 0, `${tool.name}: every offered tool needs a description`);
    assert.ok(typeof tool.inputSchema === 'object' && tool.inputSchema !== null, `${tool.name}: needs an input schema`);
  }
  assert.equal(VOICE_REALTIME_TOOLS[0]!.name, 'session_send', 'the send tool stays first');

  // ── AC-339: the STOP tool's advertised shape. ──
  // The voice plane adds the audit pair SPEC §6.2 makes mandatory, and the order of the two is not
  // decoration: `intent` is what the model must supply to stop at all, `heard` is the transcript it
  // judged on and may legitimately have none. Asserted by PARSING the advertised shape rather than by
  // listing keys, so "required" is the same reading the endpoint makes when it validates the call.
  const interrupt = VOICE_REALTIME_TOOLS.find((tool) => tool.name === 'session_interrupt');
  assert.ok(interrupt, 'the relay model must be offered the stop tool');
  const advertised = z.object(interrupt.inputSchema);
  assert.equal(advertised.safeParse({ intent: 'the user said stop' }).success, true, '`session` stays optional');
  assert.equal(
    advertised.safeParse({ intent: 'the user said stop', heard: 'never mind, stop' }).success,
    true,
    '`heard` is an optional part of the call',
  );
  assert.equal(advertised.safeParse({}).success, false, '`intent` is required');
  assert.equal(advertised.safeParse({ heard: 'stop' }).success, false, '`heard` alone is not a stop');
  // AC-342 (SPEC §0.3 D-6 / §18.4 G1): the stop tool gained the OPTIONAL `message` — the corrected
  // instruction for an interrupt the model judged a change of direction. Optional, so a bare stop
  // is unchanged, and the proxy enqueues it before the abort (`voice-realtime-interrupt-revision-order.test.ts`).
  assert.equal(
    advertised.safeParse({ intent: 'they are correcting the direction' }).success,
    true,
    '`message` is optional, so a bare stop still parses',
  );
  assert.equal(
    advertised.safeParse({ intent: 'they are correcting the direction', message: 'do Y instead' }).success,
    true,
    'an interrupt may carry the corrected instruction in `message`',
  );
});

// ── AC2: the stop bypasses the single-flight send guard ─────────────────────────────────────────

test('AC2: while a send is parked, session_interrupt runs at once and aborts exactly once', async () => {
  // The first send parks forever: `sending` is held, so a second send must be refused outright.
  const base = createStopExecutor(
    () =>
      new Promise<never>(() => {
        /* parked: the delivery never returns, holding the single-flight guard */
      }),
  );
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitFor(() => transport.openCalls >= 1);

  // The send is delivered and parks: the executor saw it, and it has no function_call_output yet.
  deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'do the long thing' });
  await waitFor(() => base.sends.length === 1);
  assert.equal(functionCallOutputs(transport, 'call-send').length, 0, 'the first send must still be in flight');

  // The stop arrives in exactly that state.
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {});
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);

  // ── AC2: the abort ran exactly once, and the answer is the abort result — NOT the single-flight
  //    refusal a second send would have produced. ──
  assert.equal(base.interrupts.length, 1, 'the stop must reach the session exactly once');
  const stopOutput = stopReceipt(transport, 'call-stop');
  assert.equal(stopOutput.aborted, true, 'the receipt carries the abort result');
  // AC-339: the receipt also carries the three readings the audit record is made from (SPEC §6.2/
  // §10.3). Nothing was waiting, no `session_send` had reported a run and nothing had been
  // transcribed — so all three say exactly that rather than a placeholder.
  assert.equal(stopOutput.queuedStillPending, 0, 'nothing was waiting behind this stop');
  assert.equal(stopOutput.runId, null, 'no run had been reported to this connection');
  assert.equal(stopOutput.triggerSeq, null, 'no non-empty utterance had been heard');

  // The refusal the stop bypassed is REAL: the very same parked state refuses a second send.
  deliverFunctionCall(transport, 'call-send-2', 'session_send', { message: 'and another thing' });
  await waitFor(() => framesOf<ErrorFrame>(socket, 'error').length === 1);
  assert.match(
    framesOf<ErrorFrame>(socket, 'error')[0]!.message,
    /A previous voice instruction is still being sent\./,
    'a second send in this state is still refused — the stop bypassed a guard that is genuinely live',
  );
  assert.equal(base.sends.length, 1, 'the refused send never reached the executor');

  // And the stop is unaffected by that refusal: it ran once, before the refusal and after it.
  assert.equal(base.interrupts.length, 1, 'the stop still ran exactly once');

  socket.close();
});

// ── AC3: the stop is not judged by the delivery bound ───────────────────────────────────────────

test('AC3: with the queue at its cap, session_interrupt still reaches the session', async () => {
  // A session that ACCEPTS each message into its own queue, so one delivery fills the depth of 1.
  const base = createStopExecutor(async () => ({
    ok: true,
    queued: true,
    runId: `run-${base.sends.length}`,
    queuedMessageUuid: null,
  }));
  // The bound is a UTF-8 BYTE budget since `gap-live-voice-queue-byte-budget-and-visible-backlog`
  // landed (it counted messages before): `the first` is 9 bytes, so a 9-byte budget admits it and
  // refuses whatever comes next — which is the state this case needs.
  const { socket, transport } = wireConnection({ executor: base.executor, maxQueuedVoiceBytes: 9 });
  await waitFor(() => transport.openCalls >= 1);

  deliverFunctionCall(transport, 'call-1', 'session_send', { message: 'the first' });
  await waitFor(() => base.sends.length === 1);
  await waitFor(() => functionCallOutputs(transport, 'call-1').length === 1);

  // The cap is reached: the NEXT send is refused before it reaches the session (the bound is live).
  deliverFunctionCall(transport, 'call-2', 'session_send', { message: 'the second' });
  await waitFor(() => framesOf<RefusedFrame>(socket, 'refused').length === 1);
  const refused = framesOf<RefusedFrame>(socket, 'refused')[0]!;
  assert.equal(refused.reason, 'queue-full');
  assert.equal(refused.depth, 1);
  assert.equal(base.sends.length, 1, 'the refused send never reached the executor');

  // ── AC3: a stop delivered in exactly this state is NOT judged by the bound. ──
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {});
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
  assert.equal(base.interrupts.length, 1, 'the stop must reach the session past the full queue');
  // The receipt is the abort's answer plus the audit readings (AC-339): the one waiting message is
  // still counted (`queuedStillPending` is read before the release), and the run the queued send
  // reported is the one the stop names.
  const stopOutput = stopReceipt(transport, 'call-stop');
  assert.equal(stopOutput.aborted, true);
  assert.equal(stopOutput.queuedStillPending, 1, 'the waiting message is still counted behind the stop');
  assert.equal(stopOutput.runId, 'run-1', 'the run the queued send opened is the run the stop names');
  assert.equal(stopOutput.triggerSeq, null, 'no transcription had arrived on this connection');
  // The refusal was about the SEND; the stop neither added to it nor was caught by it.
  assert.equal(framesOf<RefusedFrame>(socket, 'refused').length, 1, 'the stop does not become a refused delivery');

  socket.close();
});

// ── AC4: a stop ends the run, not the connection, and releases the backlog ──────────────────────

test('AC4: a stop leaves the connection and the backlog intact, and delivers the backlog at once', async () => {
  const base = createStopExecutor(async () => ({
    ok: true,
    queued: false,
    runId: `run-${base.sends.length}`,
    queuedMessageUuid: null,
  }));
  const logs: string[] = [];
  // A window far longer than any wait in this test: if the queued message is delivered at all, the
  // stop released it, because the timer could not have fired.
  const { socket, transport } = wireConnection({ executor: base.executor, coalesceMs: 60_000, logs });
  await waitForOpen(socket, transport);

  // A message opens a coalescing window: it is the one waiting message, held for 60 s.
  deliverFunctionCall(transport, 'call-1', 'session_send', { message: 'first thing' });
  await waitFor(() => framesOf<QueuedFrame>(socket, 'queued').length === 1);
  assert.equal(framesOf<QueuedFrame>(socket, 'queued')[0]!.depth, 1);
  assert.equal(base.sends.length, 0, 'the message is waiting in the window, not delivered yet');
  const audioBefore = transport.sent.filter((message) => message.type === 'input_audio_buffer.append').length;

  // The MODEL decides to stop and calls the tool. That is the only abort entry point: a human
  // ruling made natural-language "stop" a judgement for the realtime model, not a deterministic
  // client-side mapping, so the page has no stop frame to send.
  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {});
  await waitFor(() => framesOf<StoppedFrame>(socket, 'stopped').length === 1);

  // ── AC4: the abort ran once, and the frame reports the backlog it did NOT throw away. ──
  assert.equal(base.interrupts.length, 1, 'the stop must reach the session exactly once');
  const stopped = framesOf<StoppedFrame>(socket, 'stopped')[0]!;
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.depth, 1, 'the depth is read BEFORE the release, so the waiting message is still counted');
  // AC-339: the receipt agrees with the frame — the same `depth`, read at the same moment, and the
  // same "nothing was transcribed" reading the audit record will carry.
  assert.equal(stopReceipt(transport, 'call-stop').queuedStillPending, 1);

  // ── AC4: the connection and the microphone survive — a stop is not a teardown. ──
  assert.equal(socket.readyState, WS.OPEN, 'the voice connection must stay open after a stop');
  assert.equal(transport.closeCalls, 0, 'the upstream must not be closed by a stop');
  socket.receive({ type: 'audio', audio: 'U1RJTEw=' });
  await waitFor(
    () => transport.sent.filter((message) => message.type === 'input_audio_buffer.append').length === audioBefore + 1,
  );

  // ── AC4: the backlog's first message is delivered IMMEDIATELY, not after its 60 s window. ──
  await waitFor(() => base.sends.length === 1, 2000);
  assert.equal(base.sends[0]!.args.message, 'first thing', 'the waiting message is carried, not discarded');
  assert.equal(framesOf<RefusedFrame>(socket, 'refused').length, 0, 'the release is a delivery, not a refusal');

  // The operator's log carries the stop the proxy carried out, and the backlog it kept.
  assert.ok(
    logs.some((line) => line.includes('session_interrupt: aborted=true backlog=1')),
    `the server log must carry the stop and its backlog, got:\n${logs.join('\n')}`,
  );

  socket.close();
});

// ── The honest copy's reading: a stop with nothing waiting reports zero ─────────────────────────

test('a stop with nothing waiting reports aborted=true and depth=0', async () => {
  const base = createStopExecutor(async () => ({
    ok: true,
    queued: false,
    runId: 'run-1',
    queuedMessageUuid: null,
  }));
  const { socket, transport } = wireConnection({ executor: base.executor });
  await waitFor(() => transport.openCalls >= 1);

  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {});
  await waitFor(() => framesOf<StoppedFrame>(socket, 'stopped').length === 1);
  const stopped = framesOf<StoppedFrame>(socket, 'stopped')[0]!;
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.depth, 0, 'nothing was waiting, so the copy must not claim a queue');
  assert.equal(transport.sent.some((message) => message.type === 'input_audio_buffer.append'), false);

  // The refusal reason code is exported for the sibling suite; keep the import honest.
  assert.equal(VOICE_QUEUE_FULL_REASON, 'VOICE_QUEUE_FULL');

  socket.close();
});
