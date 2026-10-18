/**
 * GOAL-046 / AC-401 — the omission-fill rule WIRED INTO the ws proxy, read on a fake clock.
 *
 * WHAT THIS FILE PINS, and why the rule's own unit test (`voice-realtime-omission-fill.test.ts`) is
 * not enough. That file proves the planner's branches; this one proves the RELAY calls it at the
 * right moments and acts on its answer:
 *
 *  - a final the model's executed message covers produces NO verbatim delivery, even 2500 ms later
 *    (the old settle producer's window — the behaviour this rule replaces);
 *  - a final the model never covers (weight >= 7) is delivered verbatim EXACTLY ONCE, at the
 *    planner's own `T_i`, through the existing delivery path;
 *  - a short final (weight < 7) is passed over with its reason recorded;
 *  - two candidates due at the same moment become ONE message, in transcript order;
 *  - every connection journal carries the parameter set it judged with, and every decision line
 *    (`omission_fill {json}`) names the index, the reason and — for a fill — the due time and
 *    coverage;
 *  - every `session.update` carries `turn_detection.interrupt_response:false`.
 *
 * WHY A FAKE CLOCK. The locked parameters wait 12 s (H) / 3 s (S). Advancing Node's mocked timers
 * makes `T_i` exact — the assertion is "at 2999 ms nothing, at 3000 ms one delivery" — instead of a
 * tolerance around a real sleep, and keeps this file's cost independent of H.
 *
 * The transport is the shared fake `RealtimeTransport`; the browser socket is an EventEmitter, as in
 * `voice-realtime-ws-proxy.protocol-simulation.test.ts`. No network, no microphone, no real clock.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  DEFAULT_SESSION_DEFAULTS,
  toDashscopeFrames,
  type OmissionFillParams,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
} from '../index.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, type FakeTransport } from './realtime-bridge-harness.js';

/** A fixed epoch: every `dueAt` below is absolute and reproducible. */
const B = 1_760_000_000_000;

/** A minimal stand-in for the browser's `ws.WebSocket` (the surface the proxy uses). */
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

type RecordedSend = { args: Record<string, unknown> };

/** Wires one proxy connection over the fake browser socket and the fake upstream transport. */
function wireConnection(options: {
  omissionFillParams?: Partial<OmissionFillParams>;
  log?: (line: string) => void;
}): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  calls: RecordedSend[];
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, echoedMessage: args.message };
    },
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    // Everything below is about the omission planner; the other relay machinery is kept quiet so
    // its timers cannot fire inside a `tick` this file controls.
    coalesceMs: 0,
    stallMs: 0,
    statusRateMs: 60_000,
    browserKeepaliveMs: 0,
    // Absent = the LOCKED file's parameters. That is what proves the shipped values are wired.
    ...(options.omissionFillParams === undefined ? {} : { omissionFillParams: options.omissionFillParams }),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, calls };
}

/** Lets every microtask and every already-resolved promise run (no timer involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Delivers one final transcription from the endpoint. */
function deliverFinal(transport: FakeTransport, itemId: string, text: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  });
}

/** Delivers one model `session_send` call. */
function deliverSessionSend(transport: FakeTransport, callId: string, message: string): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  };
  transport.peerSend(call);
}

/** The proxy's own omission-fill records from a captured log. */
function omissionLines(logs: readonly string[]): string[] {
  return logs.filter((line) => line.startsWith('omission_fill '));
}

/** Finds the candidate decision for one index. */
function decisionFor(logs: readonly string[], index: number): Record<string, unknown> | null {
  for (const line of omissionLines(logs)) {
    const payload = line.slice('omission_fill '.length);
    if (payload.startsWith('params ')) continue;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (parsed.i === index) return parsed;
  }
  return null;
}

test('a covered final is never delivered verbatim, even after the old 2500 ms settle window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);
  const logs: string[] = [];
  const { socket, transport, calls } = wireConnection({ log: (line) => logs.push(line) });

  await flush();
  assert.ok(transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');

  const SENTENCE = 'the connection keeps dropping again';
  deliverFinal(transport, 'item-covered', SENTENCE);
  deliverSessionSend(transport, 'call-covered', SENTENCE);
  await flush();
  assert.deepEqual(calls.map((call) => call.args.message), [SENTENCE], 'the model`s own message is the delivery');

  // The old settle producer closed its 2500 ms window here and delivered the heard span verbatim.
  t.mock.timers.tick(2_500);
  await flush();

  assert.deepEqual(
    calls.map((call) => call.args.message),
    [SENTENCE],
    'a sentence the model carried must not be copied verbatim — the rule replaces the settle producer',
  );
  const decision = decisionFor(logs, 0);
  assert.equal(decision?.reason, 'covered', `the passed-over candidate must be recorded: ${JSON.stringify(decision)}`);

  // The parameters are the LOCKED file's, and they are on the record before any decision.
  const paramsLine = omissionLines(logs).find((line) => line.startsWith('omission_fill params '));
  assert.ok(paramsLine !== undefined, `the connection must log its parameters: ${logs.join(' | ')}`);
  const params = JSON.parse(paramsLine.slice('omission_fill params '.length)) as Record<string, unknown>;
  assert.equal(params.hMs, 12_000);
  assert.equal(params.silenceMs, 3_000);
  assert.equal(params.scoreT, 0.25);
  assert.equal(params.wMin, 7);
  assert.equal(params.numeralMode, 'runs2');

  socket.close();
});

test('an unanswered final of weight >= 7 is delivered verbatim exactly once, at its own T_i', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);
  const logs: string[] = [];
  const { socket, transport, calls } = wireConnection({ log: (line) => logs.push(line) });

  await flush();
  assert.ok(transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');

  const TEXT = '服务器一直连接不上';
  deliverFinal(transport, 'item-fill', TEXT);
  await flush();

  // Silent model, user quiet: T_i = t + S = 3000 ms (locked file).
  t.mock.timers.tick(2_999);
  await flush();
  assert.equal(calls.length, 0, 'nothing may be delivered before T_i');

  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls.map((call) => call.args.message), [TEXT], 'exactly one verbatim delivery at T_i');

  // A late decision must not deliver the same words again.
  t.mock.timers.tick(5_000);
  await flush();
  assert.deepEqual(calls.map((call) => call.args.message), [TEXT], 'the candidate is decided exactly once');

  const decision = decisionFor(logs, 0);
  assert.equal(decision?.reason, 'fill');
  assert.equal(decision?.dueAt, B + 3_000);
  assert.equal(decision?.coverage, 0);

  socket.close();
});

test('a final shorter than the weight floor is passed over with its reason recorded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);
  const logs: string[] = [];
  const { socket, transport, calls } = wireConnection({ log: (line) => logs.push(line) });

  await flush();
  assert.ok(transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');

  deliverFinal(transport, 'item-short', '我想想');
  await flush();
  t.mock.timers.tick(10_000);
  await flush();

  assert.equal(calls.length, 0, '<= 6 characters (weight < 7) is never filled');
  assert.equal(decisionFor(logs, 0)?.reason, 'weight');

  socket.close();
});

test('two candidates due at the same moment are delivered as ONE message, in transcript order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);
  const { socket, transport, calls } = wireConnection({});

  await flush();
  assert.ok(transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');

  const FIRST = '服务器一直连接不上';
  const SECOND = '麻烦你再看一下日志';
  deliverFinal(transport, 'item-a', FIRST);
  deliverFinal(transport, 'item-b', SECOND);
  await flush();

  t.mock.timers.tick(3_000);
  await flush();

  assert.equal(calls.length, 1, 'same-moment fills are coalesced into one delivery');
  const message = String(calls[0]?.args.message ?? '');
  assert.ok(message.includes(FIRST), `the first sentence must lead: ${message}`);
  assert.ok(message.includes(SECOND), `the second sentence must follow: ${message}`);
  assert.ok(message.indexOf(FIRST) < message.indexOf(SECOND), 'transcript order is preserved');

  socket.close();
});

test('every session.update carries turn_detection.interrupt_response:false — including later ones', () => {
  const fullUpdate = (): Record<string, unknown> => {
    const frames = toDashscopeFrames(
      { type: 'session.update', session: { instructions: 'be brief', tools: [] } },
      DEFAULT_SESSION_DEFAULTS,
    );
    return (frames[0] as { session: Record<string, unknown> }).session;
  };
  for (const label of ['first', 'later']) {
    const detector = fullUpdate().turn_detection as Record<string, unknown>;
    assert.equal(detector.interrupt_response, false, `${label} full session.update must disable interrupt_response`);
  }

  // The segmented path's detector-off state stays `null` — there is no detector object to annotate.
  const switchedOff = toDashscopeFrames(
    { type: 'session.turn_detection', turnDetection: null },
    DEFAULT_SESSION_DEFAULTS,
  )[0] as { session: Record<string, unknown> };
  assert.equal(switchedOff.session.turn_detection, null, 'the segmented relay`s detector-off state stays null');
});
