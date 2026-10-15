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
 *   · AC1 — THE TOOL SURFACE. The names the relay model is offered are EXACTLY `session_send` and
 *     `session_interrupt`. (`session_status` was added by `gap-live-voice-status-tool` and WITHDRAWN
 *     by the 2026-10-14 ruling — the model is a pen, not an agent; journal `e650117b`.) The FILE'S
 *     FIRST ASSERTION is that set equality, so removing the interrupt tool, re-advertising the
 *     withdrawn one, or leaking the six read tools into the relay's surface reddens this file at its
 *     first line rather than somewhere the shape of the change could hide.
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
 * THE REAL ASSEMBLY (`gap-live-voice-interrupt-real-assembly-e2e`, deepening GOAL-041 AC-343 / AC-342
 * / AC-350). The four cases above — and the fence / revision-order criteria beside this file — drive
 * the proxy over a HAND-ROLLED executor whose `session_interrupt` simply answers `{aborted:true}`. They
 * prove the proxy's logic, never that a spoken stop reaches a host. The second half of this file
 * swaps that stub for the production chain, built exactly as `server/index.ts` builds it:
 *
 *     fake upstream function_call → handleVoiceRealtimeConnection (real proxy, fence, G1 enqueue)
 *       → createVoiceRealtimeLiveExecutor (real)  → buildSessionInterrupt / buildSessionSend (real gateway)
 *       → createChatControlService (real, real temp sqlite row, default access entry)
 *       → createProviderRuntimeService (real resident routing: declared `lifecycleModes`, the
 *         session row's stored `resident` mode, the driver's `run` shape)
 *       → hostDriver.interrupt(host, sessionId)                    ← the ONE fake: the resident host
 *
 * and reads the host's own state (pid, interrupt calls, rounds aborted, per-turn input) before and
 * after. It ends by reading `server/index.ts` itself: the composition root wires
 * `hostCommandLifecycle` in `buildVoiceRealtimeSeams`, so the fence's covered half is live in
 * production — the wiring `gap-live-voice-interrupt-fence-wire-host-command-lifecycle` landed.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';
import { z } from 'zod';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/types.js';
import {
  buildRunGet,
  buildSessionInterruptDeps,
  type McpApprovalsDeps,
  type McpReadToolDeps,
  type McpRunGetDeps,
  type McpSessionBackgroundDeps,
  type McpUiVisibleContextDeps,
} from '@/modules/mcp-gateway/index.js';
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry, createChatControlService } from '@/modules/websocket/index.js';

import {
  createVoiceRealtimeLiveExecutor,
  VOICE_REALTIME_CALLER_SCOPES,
  VOICE_REALTIME_TOOLS,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
} from '../index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_QUEUE_FULL_REASON,
  type HostCommandLifecycleReading,
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

test('AC1: the tools the Live Voice model is offered are exactly session_send and session_interrupt', () => {
  // ── AC1's first assertion: the name SET is exactly these two. ──
  // The surface once carried `session_status` too (SPEC §6.3); the 2026-10-14 ruling WITHDREW it —
  // the model is a pen, not an agent, so asking for a fresh reading is not its job. The interrupt
  // tool this file guards is still there; nothing else changed and no READ tool leaked in.
  assert.deepEqual(
    [...VOICE_REALTIME_TOOLS.map((tool) => tool.name)].sort(),
    ['session_send', 'session_interrupt'].sort(),
    'the relay model must be offered the send and stop tools, and nothing else',
  );

  // The withdrawn tool is NOT on the surface — the ruling's whole point, and the assertion that reds
  // if a future edit re-advertises it.
  assert.equal(
    VOICE_REALTIME_TOOLS.some((tool) => tool.name === 'session_status'),
    false,
    'session_status is withdrawn from the relay surface',
  );

  // The surface is not the six read tools the MCP gateway registers: those are for a caller that
  // reasons, and this model only carries words over.
  assert.equal(VOICE_REALTIME_TOOLS.length, 2, 'the relay surface is exactly two tools');
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

  // ── AC-339, REFINED by `gap-live-voice-interrupt-missing-intent-drops-stop`: the STOP tool's
  //    advertised shape. ──
  // The voice plane adds the audit pair SPEC §6.2 names (`intent`, `heard`) and the G1 `message`,
  // but ALL THREE are optional in the SCHEMA and none is required to stop: a stop the model sends
  // with no `intent` is a real observed form (journal `b5d01c21`), and making `intent` mandatory made
  // the upstream reject the whole call — dropping the stop AND its `message`. The audit records
  // `intent: null` with `intentMissing: true` instead of refusing (see
  // `voice-realtime-interrupt-audit.test.ts`). Asserted by PARSING the advertised shape rather than by
  // listing keys, so "optional" is the same reading the endpoint makes when it validates the call.
  const interrupt = VOICE_REALTIME_TOOLS.find((tool) => tool.name === 'session_interrupt');
  assert.ok(interrupt, 'the relay model must be offered the stop tool');
  const advertised = z.object(interrupt.inputSchema);
  assert.equal(advertised.safeParse({ intent: 'the user said stop' }).success, true, '`session` stays optional');
  assert.equal(
    advertised.safeParse({ intent: 'the user said stop', heard: 'never mind, stop' }).success,
    true,
    '`heard` is an optional part of the call',
  );
  // The form journal `b5d01c21` shows, VERBATIM: a stop carrying only the corrected instruction. It
  // MUST parse — a schema that rejects it is the bug this task fixes.
  assert.equal(
    advertised.safeParse({ message: '停止前面的操作，处理我现在说的这句话。' }).success,
    true,
    'a stop with only a `message` and no `intent` is a valid call (b5d01c21)',
  );
  assert.equal(advertised.safeParse({}).success, true, '`intent` is optional — a bare stop parses');
  assert.equal(
    advertised.safeParse({ heard: 'stop' }).success,
    true,
    '`heard` alone parses; the proxy reads the call as a stop and records a missing intent',
  );
  // AC-342 (SPEC §0.3 D-6 / §18.4 G1): the stop tool's OPTIONAL `message` — the corrected instruction
  // for an interrupt the model judged a change of direction. Optional, so a bare stop is unchanged,
  // and the proxy enqueues it before the abort (`voice-realtime-interrupt-revision-order.test.ts`).
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE REAL ASSEMBLY — the spoken stop reaches a resident host through the production chain
// (`gap-live-voice-interrupt-real-assembly-e2e`; deepens GOAL-041 AC-343, with AC-342 / AC-350)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The fixed pid the fake resident host reports. Read before and after every stop. */
const FIXTURE_PID = 4242;

/** One message waiting in the fake CLI's own queue (a busy write), with the uuid the host stamped. */
type HostQueuedCommand = { text: string; uuid: string; settle: () => void };

/** The round the fake CLI is running: its input, and the dispatches waiting for it to end. */
type HostRound = { input: string[]; settlers: Array<() => void> };

/**
 * The ONE fake in the real-assembly cases: a resident Claude Code host (the CLI process and the
 * driver verbs `provider-runtime.service.ts` reaches on it). Everything above it is production code.
 *
 * It models the readings E10 took on the real binary, the same ones the revision-order criterion's
 * scripted host models:
 *
 *   · a dispatch into an IDLE process starts a round whose input is that one message;
 *   · a dispatch into a BUSY process is a queued write — it gets a host-stamped uuid
 *     (`queuedInputUuid`, the id the control service hands back as `queuedMessageUuid`) and waits;
 *   · `interrupt` with a round in flight aborts that round and the CLI dequeues EVERYTHING waiting
 *     into the next round (E10/U1), in push order; with no round in flight it answers `false` —
 *     the honest "nothing to stop" — and changes nothing;
 *   · `finishRound` is the round ending on its own, with the same dequeue — the moment a waiting
 *     command becomes `command_lifecycle` `started` ({@link FakeResidentHost.started}).
 *
 * The process itself never changes: `pid` is a constant and `live` only flips when a case says so,
 * so "pid before === pid after" is a reading of whether the chain killed the host (the non-resident
 * route would call `requestAbort`, counted in {@link FakeResidentHost.requestAbortCalls}).
 */
type FakeResidentHost = {
  readonly pid: number;
  /** Whether the CLI process is up. `liveHostForSession` answers `null` once this is false. */
  live: boolean;
  /** How many times the driver's `interrupt` verb was reached, whatever it answered. */
  readonly interruptCalls: () => number;
  /** How many in-flight rounds `interrupt` actually aborted. */
  readonly roundsAborted: () => number;
  /** Per-run `provider.runtime.abort` calls — the NON-resident route. Must stay 0 here. */
  readonly perRunAbortCalls: () => number;
  /** `sessionHostManager.requestAbort` calls — closing the host. Must stay 0 for a resident stop. */
  readonly requestAbortCalls: () => number;
  /** The input of every round the host ran, in order (the CLI-side per-turn reading). */
  readonly turns: () => string[][];
  /** The host's ordered event log: dispatches, enqueues, interrupts, round starts. */
  readonly events: string[];
  /** The `commandUuid`s the CLI has dequeued into a round — `command_lifecycle` `started`. */
  readonly started: () => string[];
  /** Whether a round is in flight right now. */
  readonly roundInFlight: () => boolean;
  /** The round ends on its own; what was waiting is dequeued into the next one. */
  finishRound(): void;
  /** Settles every parked dispatch, so teardown leaves no promise pending. */
  releaseAll(): void;
  /** The provider object the runtime service's `resolveProvider` hands back for `'claude'`. */
  readonly provider: unknown;
  /** The host view the runtime service reads `liveHostForSession` from. */
  readonly sessionHostManager: unknown;
};

function createFakeResidentHost(sessionId: string): FakeResidentHost {
  const events: string[] = [];
  const turns: string[][] = [];
  const started: string[] = [];
  const queue: HostQueuedCommand[] = [];
  let round: HostRound | null = null;
  let interruptCalls = 0;
  let roundsAborted = 0;
  let perRunAbortCalls = 0;
  let requestAbortCalls = 0;
  let lastQueuedUuid: string | null = null;
  let minted = 0;

  const startRound = (input: string[], settlers: Array<() => void>): void => {
    round = { input, settlers };
    turns.push([...input]);
    events.push(`round:${JSON.stringify(input)}`);
  };

  // Ends the round in flight (aborted or finished) and dequeues everything waiting into the next.
  const endRound = (): void => {
    const ending = round;
    round = null;
    for (const settle of ending?.settlers ?? []) {
      settle();
    }
    if (queue.length > 0) {
      const drained = queue.splice(0, queue.length);
      for (const command of drained) {
        started.push(command.uuid);
      }
      startRound(
        drained.map((command) => command.text),
        drained.map((command) => command.settle),
      );
    }
  };

  const hostDriver = {
    // The resident turn entry `residentEntryFor` checks the shape of — its presence is one of the
    // three facts that route this session resident.
    run(appSessionId: string, turn: { command: string }): Promise<unknown> {
      assert.equal(appSessionId, sessionId, 'the runtime dispatched to the bound session');
      return new Promise<unknown>((resolve) => {
        const settle = () => resolve(undefined);
        if (round === null) {
          events.push(`dispatch-idle:${turn.command}`);
          startRound([turn.command], [settle]);
          return;
        }
        minted += 1;
        const uuid = `host-cmd-${minted}`;
        lastQueuedUuid = uuid;
        queue.push({ text: turn.command, uuid, settle });
        events.push(`enqueue:${turn.command}`);
      });
    },
    queuedInputUuid(): string | null {
      return lastQueuedUuid;
    },
    pendingQueuedInputs(): { items: number; bytes: number } {
      return {
        items: queue.length,
        bytes: queue.reduce((total, command) => total + Buffer.byteLength(command.text, 'utf8'), 0),
      };
    },
    // The resident process's own account of what it has DEQUEUED — this fake's stand-in for the
    // `command_lifecycle` `started` events the real driver reads off its stream. `started` is filled
    // by `endRound`'s drain, i.e. exactly at the turn boundary the proxy is never told about, so a
    // reading taken from it is the host's own and not something a caller could infer from the
    // messages it sent. `null` for any other session, the same conservative direction the real
    // driver takes (it answers only for a session it is hosting).
    startedQueuedCommands(appSessionId: string): readonly string[] | null {
      return appSessionId === sessionId ? [...started] : null;
    },
    // The verb the production resident abort reaches: `driver.interrupt(host, sessionId)`.
    async interrupt(host: { pid: number }, appSessionId: string): Promise<boolean> {
      interruptCalls += 1;
      assert.equal(host.pid, FIXTURE_PID, 'the runtime handed the driver the live host it resolved');
      assert.equal(appSessionId, sessionId);
      if (round === null) {
        events.push('interrupt:idle');
        return false;
      }
      roundsAborted += 1;
      events.push('interrupt:aborted');
      // The CLI acknowledges the interrupt now, but the aborted round's own `result` arrives over
      // stdout LATER — so the round ends (and the queue drains into the next one) on a later
      // macrotask, never inside this call. Ending it synchronously would let the run's dispatch
      // settle before the control service records the abort, which no real host can do.
      const aborting = round;
      setImmediate(() => {
        if (round === aborting) {
          endRound();
        }
      });
      return true;
    },
  };

  const state: FakeResidentHost = {
    pid: FIXTURE_PID,
    live: true,
    interruptCalls: () => interruptCalls,
    roundsAborted: () => roundsAborted,
    perRunAbortCalls: () => perRunAbortCalls,
    requestAbortCalls: () => requestAbortCalls,
    turns: () => turns.map((input) => [...input]),
    events,
    started: () => [...started],
    roundInFlight: () => round !== null,
    finishRound: () => {
      events.push('round:finished');
      endRound();
    },
    releaseAll: () => {
      for (const command of queue.splice(0, queue.length)) {
        command.settle();
      }
      while (round !== null) {
        const ending: HostRound = round;
        round = null;
        for (const settle of ending.settlers) {
          settle();
        }
      }
    },
    provider: {
      id: 'claude',
      // Present (truthy) so `hasRuntime('claude')` answers yes; its `abort` is the NON-resident
      // route, counted so a case can prove the resident route was the one taken.
      runtime: {
        run: () => {
          throw new Error('fake resident host: the per-run runtime must not be dispatched to');
        },
        abort: async () => {
          perRunAbortCalls += 1;
          return false;
        },
      },
      hostDriver,
      sessions: { normalizeMessage: () => [] },
      auth: { getStatus: async () => ({ installed: true }) },
    },
    sessionHostManager: {
      liveHostForSession: (appSessionId: string) =>
        state.live && appSessionId === sessionId
          ? { pid: FIXTURE_PID, appSessionId, provider: 'claude', mode: 'resident' }
          : null,
      requestAbort: () => {
        requestAbortCalls += 1;
      },
      trackPerRunTurn: () => {
        throw new Error('fake resident host: a resident session must not be tracked as a per-run turn');
      },
    },
  };
  return state;
}

/** Everything one real-assembly case reads. */
type RealChain = {
  sessionId: string;
  host: FakeResidentHost;
  runtime: ReturnType<typeof createProviderRuntimeService>;
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  logs: string[];
};

/**
 * Boots the production chain over a REAL temp sqlite database and the fake resident host, then
 * opens one real proxy connection over it.
 *
 * The database row is real (`sessionsDb.createSession`, provider `claude`) and its lifecycle mode is
 * stored `resident` through the real repository — the runtime service reads it back through its
 * DEFAULT `resolveSessionLifecycleMode`, and `claude`'s `['per-run','resident']` declaration through
 * the real capability table. Only `resolveProvider` and `sessionHostManager` are overridden: they are
 * where the resident host lives. The control service keeps its DEFAULT access entry (a non-empty
 * user id), and the executor gets `sessionInterrupt` from the same `buildSessionInterruptDeps` the
 * composition root calls. The four executor bags no case reaches (`ui_visible_context`, `session_get`,
 * `run_get`, `approvals_list` / `session_background`) are empty shells.
 *
 * `hostCommandLifecycle` — the fence's reading of what the run has dequeued — is wired by DEFAULT,
 * and wired the way the composition root wires it: the bound session's provider read off the real
 * `sessionsDb` row and handed to the REAL runtime gateway's `startedQueuedCommands`, which descends
 * to the fake resident host's own `lifecycle`-equivalent record. A case may replace that reading
 * with one it supplies itself (to isolate the proxy's join from the gateway) or ask for the FALSE
 * FORM, `'absent'`, which is the composer's pre-`gap-live-voice-interrupt-fence-wire-host-command-lifecycle`
 * assembly: no seam at all, so the fence has only its idempotent half.
 */
async function withRealChain(
  options: {
    /**
     * How this chain's `hostCommandLifecycle` seam is supplied.
     *
     * `'production'` (the default) is `server/index.ts`'s own wiring, resolved through the real
     * runtime gateway. A function is a reading the CRITERION supplies, for a case that wants the
     * proxy's join judged without the gateway in the path. `'absent'` is the false form — the
     * reading the composition root could not take before this task, when no seam was wired at all.
     */
    hostCommandLifecycle?:
      | 'production'
      | 'absent'
      | ((host: FakeResidentHost) => VoiceRealtimeProxySeams['hostCommandLifecycle']);
    coalesceMs?: number;
  },
  body: (chain: RealChain) => Promise<void>,
): Promise<void> {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'voice-interrupt-real-assembly-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  let host: FakeResidentHost | undefined;
  let socket: FakeBrowserSocket | undefined;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    const sessionId = sessionsDb.createSession(
      'voice-real-assembly-session',
      'claude',
      tempDirectory,
      'Voice real assembly',
      now,
      now,
      null,
    );
    assert.equal(sessionsDb.setSessionLifecycleMode(sessionId, 'resident'), true, 'the row stores `resident`');
    assert.equal(sessionsDb.getSessionLifecycleMode(sessionId), 'resident');

    const fakeHost = createFakeResidentHost(sessionId);
    host = fakeHost;
    type RuntimeOverrides = NonNullable<Parameters<typeof createProviderRuntimeService>[0]>;
    const runtime = createProviderRuntimeService({
      resolveProvider: ((name: string) => {
        if (name !== 'claude') {
          throw new Error(`fake registry: unexpected provider "${name}"`);
        }
        return fakeHost.provider;
      }) as RuntimeOverrides['resolveProvider'],
      sessionHostManager: fakeHost.sessionHostManager as RuntimeOverrides['sessionHostManager'],
    });
    const control = createChatControlService({ runtime });

    const logs: string[] = [];
    const fakeSocket = new FakeBrowserSocket();
    socket = fakeSocket;
    const transport = createFakeTransport();
    const requested = options.hostCommandLifecycle ?? 'production';
    // `server/index.ts`'s own two lines, over this chain's real session row and real gateway: the
    // provider is a stored field of the session, and the reading comes from the runtime service —
    // never from the proxy's own idea of what it sent.
    const lifecycle: VoiceRealtimeProxySeams['hostCommandLifecycle'] =
      typeof requested === 'function'
        ? requested(fakeHost)
        : requested === 'production'
          ? (bound) => {
                const provider = sessionsDb.getSessionById(bound)?.provider;
                if (typeof provider !== 'string' || provider === '') {
                    return null;
                }
                const started = runtime.startedQueuedCommands(provider as LLMProvider, bound);
                return started === null ? null : { started };
            }
          : undefined;
    const seams: VoiceRealtimeProxySeams = {
      createTransport: () => transport,
      createExecutor: ({ boundSessionId }) =>
        createVoiceRealtimeLiveExecutor({
          boundSessionId,
          caller: { userId: 1, scopes: VOICE_REALTIME_CALLER_SCOPES },
          visibleContext: {} as unknown as McpUiVisibleContextDeps,
          readTools: {} as unknown as McpReadToolDeps,
          runGet: {} as unknown as McpRunGetDeps,
          approvals: {} as unknown as McpApprovalsDeps,
          sessionBackground: {} as unknown as McpSessionBackgroundDeps,
          // The production `mcpSessionSendDeps` shape: the real control service and the whole
          // process run registry. `runGet` is only reached by a `waitSeconds` send, which voice
          // never makes.
          sessionSend: {
            control,
            runs: chatRunRegistry,
            runGet: { deps: {} as unknown as McpRunGetDeps, build: buildRunGet },
          },
          sessionInterrupt: buildSessionInterruptDeps({ control }),
          onSessionRefusal: (refusal) => {
            throw new Error(`unexpected session refusal: ${JSON.stringify(refusal)}`);
          },
        }),
      instructions: 'test instructions',
      log: (line: string) => logs.push(line),
      // As `server/index.ts` wires it: the bound session's own queue, read off the resident host.
      hostQueueReading: (bound) => runtime.pendingQueuedInputs('claude', bound),
      ...(lifecycle === undefined ? {} : { hostCommandLifecycle: lifecycle }),
      ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    };
    handleVoiceRealtimeConnection(
      fakeSocket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
      sessionId,
      seams,
    );
    await waitForOpen(fakeSocket, transport);

    await body({ sessionId, host: fakeHost, runtime, socket: fakeSocket, transport, logs });
  } finally {
    socket?.close();
    host?.releaseAll();
    // Let the released dispatches run their `finally` against the still-open database.
    await new Promise((resolve) => setImmediate(resolve));
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

/** The `session_send` result the proxy read back for one call (the gateway's own payload). */
type SendPayload = { runId: string; queued: boolean; queuedMessageUuid: string | null };

function sendPayload(transport: FakeTransport, callId: string): SendPayload {
  const outputs = functionCallOutputs(transport, callId);
  assert.equal(outputs.length, 1, `expected exactly one receipt for ${callId}`);
  return outputs[0]!.output as SendPayload;
}

/** The registry's status for one run id, or `unknown`. */
function runStatus(runId: string): string {
  const found = chatRunRegistry.getRunById(runId);
  return found && 'runId' in found ? found.status : String(found?.status);
}

/** Delivers one FINAL transcription of the user's own audio — what makes `utteranceSeq` advance. */
function deliverTranscript(transport: FakeTransport, itemId: string, transcript: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

// ── (a) RUNNING → ABORTED through the real chain; the resident host is interrupted, not killed ──

test('real assembly (a): a spoken session_interrupt reaches the resident host through the production chain — aborted, pid unchanged', async (t) => {
  await withRealChain({}, async ({ host, runtime, socket, transport, sessionId, logs }) => {
    // The model relays an instruction: a REAL `session_send` opens a real run, which the real runtime
    // dispatches resident — into the host's `run`, not the per-run wrapper.
    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'refactor the parser module' });
    await waitFor(() => functionCallOutputs(transport, 'call-send').length === 1);
    const sent = sendPayload(transport, 'call-send');
    assert.equal(sent.queued, false, 'an idle host starts a round rather than queuing');
    await waitFor(() => host.roundInFlight());

    const pidBefore = host.pid;
    const hostBefore = runtime.acceptsBusyInput('claude', sessionId);
    const statusBefore = runStatus(sent.runId);
    assert.equal(statusBefore, 'running', 'the run is registered and running');
    assert.equal(hostBefore, true, 'the session resolves resident with a live host');

    // The model judges a stop. `intent` is required by the voice plane.
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
    const receipt = stopReceipt(transport, 'call-stop');

    const pidAfter = host.pid;
    const hostAfter = runtime.acceptsBusyInput('claude', sessionId);
    const statusAfter = runStatus(sent.runId);
    const line =
      `(a) pidBefore=${pidBefore} hostBefore=${hostBefore} statusBefore=${statusBefore} runId=${sent.runId} ` +
      `interrupt=${JSON.stringify(receipt)} pidAfter=${pidAfter} hostAfter=${hostAfter} statusAfter=${statusAfter} ` +
      `abortCount=${host.interruptCalls()} roundsAborted=${host.roundsAborted()} ` +
      `perRunAbort=${host.perRunAbortCalls()} requestAbort=${host.requestAbortCalls()}`;
    t.diagnostic(line);
    console.log(`voice-real-assembly ${line}`);

    assert.equal(receipt.aborted, true, 'the gateway reports the host aborted the round');
    assert.equal(receipt.runId, sent.runId, 'the receipt names the run the stop ended');
    assert.equal(host.interruptCalls(), 1, 'the resident driver`s interrupt verb was reached exactly once');
    assert.equal(host.roundsAborted(), 1, 'and it stopped the one round in flight');
    assert.equal(pidAfter, pidBefore, 'the resident host is interrupted, never killed: same pid');
    assert.equal(hostAfter, true, 'the host is still live after the stop');
    assert.equal(host.requestAbortCalls(), 0, 'the resident route never closes the host');
    assert.equal(host.perRunAbortCalls(), 0, 'the per-run abort route was not taken');
    assert.equal(statusAfter, 'aborted', 'the control service completed the run as aborted');
    const stopped = framesOf<StoppedFrame>(socket, 'stopped');
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]!.aborted, true, 'the page is told the run stopped');
    assert.ok(logs.some((entry) => entry.includes('session_interrupt: aborted=true')), logs.join('\n'));
  });
});

// ── (b) the correction is enqueued into the host BEFORE the abort, through the real chain ──────

test('real assembly (b): an interrupt carrying `message` enqueues the correction into the host before the abort, and it rides the next turn last', async (t) => {
  await withRealChain({}, async ({ host, transport }) => {
    // A round is running, and one earlier instruction is already waiting in the CLI's own queue.
    deliverFunctionCall(transport, 'call-1', 'session_send', { message: 'start the deploy' });
    await waitFor(() => functionCallOutputs(transport, 'call-1').length === 1);
    deliverFunctionCall(transport, 'call-2', 'session_send', { message: 'and also bump the version' });
    await waitFor(() => functionCallOutputs(transport, 'call-2').length === 1);
    const waiting = sendPayload(transport, 'call-2');
    assert.equal(waiting.queued, true, 'a send into a busy resident host is queued');
    assert.equal(waiting.queuedMessageUuid, 'host-cmd-1', 'the uuid is the host`s own stamp');

    const correction = 'wait — deploy to staging, not production';
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      intent: 'the user is correcting the direction',
      message: correction,
    });
    await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
    const receipt = stopReceipt(transport, 'call-stop');
    // The aborted round's own end arrives after the acknowledgement; wait for the drain it causes.
    await waitFor(() => host.turns().length >= 2);

    t.diagnostic(`(b) host events: ${host.events.join(' | ')}`);
    t.diagnostic(`(b) turns: ${JSON.stringify(host.turns())} receipt=${JSON.stringify(receipt)}`);

    // ── ORDER, read off the host itself: the correction entered the CLI queue, THEN the abort ran. ──
    // Matched by INCLUSION: the correction is the stop's own message now, so it arrives with the
    // AC-344 aftermath note prefixed (ruling 2026-10-16, `noteCarried`) — the same reason the false
    // form below matches this way.
    const enqueuedAt = host.events.findIndex((event) => event.startsWith('enqueue:') && event.includes(correction));
    const abortedAt = host.events.indexOf('interrupt:aborted');
    assert.ok(enqueuedAt >= 0, 'the correction reached the host`s queue');
    assert.ok(abortedAt >= 0, 'the abort reached the host');
    assert.ok(enqueuedAt < abortedAt, 'enqueue-then-abort: the correction was queued BEFORE the interrupt');
    assert.equal(host.interruptCalls(), 1, 'exactly one abort');
    assert.equal(receipt.aborted, true);

    // ── E10/U1: the turn after the abort carries what waited AND the correction, correction last. ──
    const turns = host.turns();
    assert.deepEqual(turns[0], ['start the deploy'], 'the interrupted round');
    assert.equal(turns[1]?.length, 2, 'the next turn carries the waiting message then the correction');
    assert.equal(turns[1]?.[0], 'and also bump the version', 'the waiting message comes first, in speech order');
    assert.ok(
      String(turns[1]?.[1]).startsWith('[The previous turn was interrupted'),
      `the correction rides the interrupt-closing turn with the aftermath note in front of it: ${String(turns[1]?.[1])}`,
    );
    assert.ok(
      String(turns[1]?.[1]).endsWith(correction),
      'and the correction`s own words close it, verbatim',
    );
    const staleFirst = turns.slice(1).filter((input) => !input.some((text) => text.includes(correction)));
    assert.equal(staleFirst.length, 0, 'no stale-first turn after the interrupt');
    assert.equal(
      turns.flat().filter((text) => text.includes(correction)).length,
      1,
      'the correction is carried once',
    );
  });
});

test('real assembly (b) false form: a bare stop followed by the correction as plain voice text leaves a stale-first turn', async (t) => {
  // The SAME real chain and the SAME host state, with the order G1 replaced: the stop carries no
  // `message`, aborts FIRST, and the correction is relayed afterwards as an ordinary `session_send`
  // (SPEC §18.1 F-7, E10/U2). The turn after the abort then carries the old waiting message WITHOUT
  // the correction — the stale-first turn. Without this arm the order assertion above could be vacuous.
  await withRealChain({}, async ({ host, transport }) => {
    deliverFunctionCall(transport, 'call-1', 'session_send', { message: 'start the deploy' });
    await waitFor(() => functionCallOutputs(transport, 'call-1').length === 1);
    deliverFunctionCall(transport, 'call-2', 'session_send', { message: 'and also bump the version' });
    await waitFor(() => functionCallOutputs(transport, 'call-2').length === 1);

    const correction = 'wait — deploy to staging, not production';
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user changed their mind' });
    await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
    await waitFor(() => host.turns().length >= 2);
    deliverFunctionCall(transport, 'call-3', 'session_send', { message: correction });
    await waitFor(() => functionCallOutputs(transport, 'call-3').length === 1);
    t.diagnostic(`(b-false) host events: ${host.events.join(' | ')}`);

    // Relayed AFTER a stop, the correction is the first message into the CLI after an interrupt, so
    // the real proxy prepends the AC-344 aftermath note to it — matched by inclusion, not equality.
    const abortedAt = host.events.indexOf('interrupt:aborted');
    const enqueuedAt = host.events.findIndex((event) => event.startsWith('enqueue:') && event.includes(correction));
    assert.ok(abortedAt >= 0 && enqueuedAt > abortedAt, 'the false form reaches the host abort-THEN-enqueue');
    const turns = host.turns();
    assert.deepEqual(turns[1], ['and also bump the version'], 'the turn after the abort lacks the correction');
    const staleFirst = turns.slice(1).filter((input) => !input.some((text) => text.includes(correction)));
    assert.ok(staleFirst.length >= 1, 'the old order produces a stale-first turn — the red G1 removes');
  });
});

// ── (c) idle / no run → refused honestly, not a false abort ────────────────────────────────────

test('real assembly (c): with the host up but no round in flight, the stop answers aborted:false with the no-run message', async (t) => {
  await withRealChain({}, async ({ host, socket, transport }) => {
    assert.equal(host.roundInFlight(), false, 'the CLI process is up and idle');
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
    const receipt = stopReceipt(transport, 'call-stop');
    t.diagnostic(
      `(c-idle) interrupt=${JSON.stringify(receipt)} abortCount=${host.interruptCalls()} ` +
        `roundsAborted=${host.roundsAborted()} pid=${host.pid}`,
    );

    assert.equal(receipt.aborted, false, 'nothing was running, so nothing is reported stopped');
    assert.match(String(receipt.message), /no run to abort/, 'the gateway`s honest no-run message');
    assert.equal(host.roundsAborted(), 0, 'no round was aborted');
    assert.equal(host.interruptCalls(), 1, 'the driver was asked once and answered "nothing in flight"');
    assert.equal(host.requestAbortCalls(), 0, 'the idle host is not closed either');
    const stopped = framesOf<StoppedFrame>(socket, 'stopped');
    assert.equal(stopped.some((frame) => frame.aborted === true), false, 'no frame claims a stop that did not happen');
    assert.equal(stopped.length, 1, 'the one frame for the call');
    assert.equal(stopped[0]!.aborted, false);
  });
});

test('real assembly (c): with the host gone, the stop answers aborted:false and never reaches the driver', async (t) => {
  await withRealChain({}, async ({ host, socket, transport }) => {
    host.live = false;
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
    const receipt = stopReceipt(transport, 'call-stop');
    t.diagnostic(`(c-gone) interrupt=${JSON.stringify(receipt)} abortCount=${host.interruptCalls()}`);

    assert.equal(receipt.aborted, false);
    assert.match(String(receipt.message), /no run to abort/);
    assert.equal(host.interruptCalls(), 0, 'no live host ⇒ the driver`s interrupt is never reached');
    assert.equal(host.perRunAbortCalls(), 0, 'and the resident session does not fall back to the per-run abort');
    assert.equal(framesOf<StoppedFrame>(socket, 'stopped').some((frame) => frame.aborted === true), false);
  });
});

// ── (d) an utterance the current run already covers does not reach the host ───────────────────

/**
 * The covered scenario, shared by the fenced case and its production-wiring contrast: a round is
 * running, the person says one sentence, the model relays it (queued behind the round, host uuid
 * `host-cmd-1`), and the round ends on its own — the CLI dequeues the sentence into the next round,
 * which is its `command_lifecycle` `started`. The model then calls a stop FOR that sentence.
 */
async function driveCoveredScenario(host: FakeResidentHost, transport: FakeTransport): Promise<void> {
  deliverFunctionCall(transport, 'call-0', 'session_send', { message: 'run the server test suite' });
  await waitFor(() => functionCallOutputs(transport, 'call-0').length === 1);
  await waitFor(() => host.roundInFlight());

  deliverTranscript(transport, 'item-1', 'open the failing test');
  deliverFunctionCall(transport, 'call-1', 'session_send', { message: 'open the failing test' });
  await waitFor(() => functionCallOutputs(transport, 'call-1').length === 1);
  const queued = sendPayload(transport, 'call-1');
  assert.equal(queued.queued, true);
  assert.equal(queued.queuedMessageUuid, 'host-cmd-1', 'the uuid the fence will join on is the host`s');

  host.finishRound();
  assert.deepEqual(host.started(), ['host-cmd-1'], 'the CLI dequeued the sentence into the running round');
  assert.equal(host.roundInFlight(), true, 'the round carrying the sentence is running');

  deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user took it back' });
  await waitFor(() => functionCallOutputs(transport, 'call-stop').length === 1);
}

test('real assembly (d): with the host`s command lifecycle wired, a stop for an already-covered utterance is `covered` and never reaches the host', async (t) => {
  await withRealChain(
    {
      // The reading supplied by the CRITERION itself, so this case judges the proxy's JOIN — host
      // uuid → the utterance its delivery carried → `coveredSeqs` — with the gateway out of the
      // path. The production wiring is the contrast case below; the two are separate claims.
      hostCommandLifecycle: (host) => (): HostCommandLifecycleReading => ({ started: host.started() }),
    },
    async ({ host, socket, transport }) => {
      await driveCoveredScenario(host, transport);
      const receipt = stopReceipt(transport, 'call-stop') as StopReceipt & { stopped?: boolean; reason?: string };
      t.diagnostic(`(d-fenced) interrupt=${JSON.stringify(receipt)} abortCount=${host.interruptCalls()}`);

      assert.equal(receipt.stopped, false);
      assert.equal(receipt.reason, 'covered', 'the fence`s covered half answered');
      assert.equal(receipt.triggerSeq, 1, 'for the one sentence that was heard');
      assert.equal(host.interruptCalls(), 0, 'a covered stop never reaches the host`s interrupt verb');
      assert.equal(host.roundsAborted(), 0);
      assert.equal(host.roundInFlight(), true, 'the round answering the sentence keeps running');
      assert.equal(framesOf<StoppedFrame>(socket, 'stopped').length, 0, 'no `stopped` frame for a covered call');
    },
  );
});

// ── (d) contrast — THE PRODUCTION WIRING, over the real gateway ────────────────────────────────

test('real assembly (d) contrast — production wiring: with `hostCommandLifecycle` wired as `server/index.ts` wires it, the same stop is `covered` and the host is never reached', async (t) => {
  // NO criterion-supplied reading: the harness assembles the seam exactly as `server/index.ts` does
  // — the bound session's provider off the real `sessionsDb` row, handed to the REAL runtime
  // gateway's `startedQueuedCommands`, which descends through the driver to the host's own
  // `command_lifecycle` equivalent. This is the reading `gap-live-voice-interrupt-real-assembly-e2e`
  // pinned as MISSING: before
  // `gap-live-voice-interrupt-fence-wire-host-command-lifecycle` the same scenario over the same
  // chain read `{"aborted":true,…,"triggerSeq":1} abortCount=1` — the stop aborted the very round
  // answering the sentence it was called for (the red evidence, recorded in that task's Notes).
  await withRealChain({}, async ({ host, socket, transport }) => {
    await driveCoveredScenario(host, transport);
    const receipt = stopReceipt(transport, 'call-stop') as StopReceipt & { stopped?: boolean; reason?: string };
    t.diagnostic(`(d-production) interrupt=${JSON.stringify(receipt)} abortCount=${host.interruptCalls()}`);

    assert.equal(receipt.stopped, false, 'the production assembly answers a stop it can cover');
    assert.equal(receipt.reason, 'covered', 'and names the fence`s root cause rather than aborting');
    assert.equal(receipt.triggerSeq, 1, 'for the one sentence that was heard');
    assert.equal(host.interruptCalls(), 0, 'the wired seam spares the host the stop entirely');
    assert.equal(host.roundsAborted(), 0);
    assert.equal(host.roundInFlight(), true, 'the round answering the sentence keeps running');
    assert.equal(framesOf<StoppedFrame>(socket, 'stopped').length, 0, 'no `stopped` frame for a covered call');

    // The idempotent half still holds on the wired assembly: repeating the SAME call is `covered`
    // too, and still does not reach the host.
    deliverFunctionCall(transport, 'call-stop-2', 'session_interrupt', { intent: 'the user took it back' });
    await waitFor(() => functionCallOutputs(transport, 'call-stop-2').length === 1);
    const repeat = stopReceipt(transport, 'call-stop-2') as StopReceipt & { reason?: string };
    assert.equal(repeat.reason, 'covered', 'the idempotent half is live too');
    assert.equal(host.interruptCalls(), 0, 'the repeat did not reach the host either');
  });
});

// ── (d) false form — the same scenario with the reading UNAVAILABLE ────────────────────────────

test('real assembly (d) false form: with NO lifecycle reading the same stop aborts the run that already carries the sentence', async (t) => {
  // `'absent'` is not a different fixture for the same reading — it is the missing reading itself,
  // the composer's assembly before this task. The receipt below is therefore the DIFFERENT reading
  // (`aborted`, not `covered`), which is what makes the two cases above non-vacuous: the fence's
  // `covered` verdict is caused by the seam, not by the scenario.
  await withRealChain({ hostCommandLifecycle: 'absent' }, async ({ host, transport }) => {
    await driveCoveredScenario(host, transport);
    const receipt = stopReceipt(transport, 'call-stop');
    t.diagnostic(`(d-unwired) interrupt=${JSON.stringify(receipt)} abortCount=${host.interruptCalls()}`);

    assert.equal(receipt.aborted, true, 'with nothing to read, the covered sentence`s run is aborted');
    assert.equal(host.interruptCalls(), 1, 'the stop reached the host');
    assert.equal(host.roundsAborted(), 1);
  });
});

// ── (e) the composition root wires the fence's covered half ────────────────────────────────────

test('server/index.ts wires hostCommandLifecycle in buildVoiceRealtimeSeams', () => {
  const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../index.ts');
  const source = readFileSync(indexPath, 'utf8');

  // Scope the reading to the ONE construction both voice entry points share, and prove the scope is
  // the right one (it carries the two sibling host seams) so the hit below is not some other wiring
  // of the same name somewhere in the file.
  const start = source.indexOf('const buildVoiceRealtimeSeams');
  assert.ok(start >= 0, 'server/index.ts builds the voice seams in `buildVoiceRealtimeSeams`');
  const end = source.indexOf('function resolveIdleRotateMs', start);
  assert.ok(end > start, 'the seam builder is followed by `resolveIdleRotateMs`');
  const seamBuilder = source.slice(start, end);
  assert.ok(seamBuilder.includes('createVoiceRealtimeLiveExecutor('), 'the scope builds the live executor');
  assert.ok(seamBuilder.includes('hostQueueReading:'), 'the scope wires the sibling queue reading');
  assert.ok(seamBuilder.includes('hostRunActivity:'), 'the scope wires the sibling run-activity reading');

  // THE WIRING. The seam is present, it is the fence's, and it resolves through the runtime
  // gateway's own reading of the resident process rather than a stand-in built here.
  assert.ok(
    seamBuilder.includes('hostCommandLifecycle:'),
    'server/index.ts wires the interrupt fence`s `hostCommandLifecycle` seam in `buildVoiceRealtimeSeams`',
  );
  assert.ok(
    seamBuilder.includes('startedQueuedCommands('),
    'the wiring takes its reading from the runtime gateway\'s `startedQueuedCommands`',
  );
  assert.equal(
    seamBuilder.includes('hostCommandLifecycle: (sessionId) => null'),
    false,
    'the seam is a real reading, not a stub that answers `null` and leaves `coveredSeqs` empty',
  );
});
