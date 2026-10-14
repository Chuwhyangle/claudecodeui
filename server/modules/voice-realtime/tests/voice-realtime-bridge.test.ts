/**
 * AC-305's positive criterion for the Realtime bridge.
 *
 * The bridge is driven ENTIRELY over `realtime-bridge-harness.ts`'s fake WS
 * server — no socket, no `fetch` — across five readings:
 *
 *  - AC1: the state machine walks `connecting → open → closing → closed`, with a
 *    bounded reconnect after the peer drops the socket and a bounded give-up when
 *    the socket can never be opened.
 *  - AC2: each of the six mirrored tool schemas equals the MCP gateway's OWN
 *    declaration (captured over the gateway barrel), field for field.
 *  - AC3: a function call is routed to the executor named by the tool, with its
 *    arguments passed unchanged (same values, same key order).
 *  - AC4: an unknown event, an executor that throws, an unknown tool name and a
 *    dropped socket are each reported through `onError` and never fatal.
 *  - AC5: the whole exercise touches no real network — `fetch` and `WebSocket`
 *    are replaced by throwing probes and stay at zero calls.
 *
 * Provenance (goal record AC-305): this file is the criterion the AC-305 record
 * names. It MUST be run with THIS repo's runner and MUST NOT be rewritten to
 * `node --test`:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file> <the .false-forms sibling>
 *
 * The server tree is TS-ESM — source imports use `.js` specifiers that resolve to
 * same-named `.ts` files — and Node's type-stripping does NOT remap `.js` → `.ts`.
 * `node --test` therefore dies with ERR_MODULE_NOT_FOUND on `../index.js` and the
 * AC-305 criterion stays red no matter how correct the bridge is. AC-305's
 * recorded criterion was corrected to the tsx runner above; keep this file and
 * that record in step.
 *
 * Consumers: the quay worker's AC state for AC-305; the mirror's drift alarm.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  connect,
  diffToolDescriptors,
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  type RealtimeBridgeError,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
} from '../index.js';

import { captureMcpToolSchemas, createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import {
  createVoiceRealtimeRecorder,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeLogStore,
} from '../voice-realtime-log.js';
import { VOICE_ONLY_TOOLS, VOICE_REALTIME_TOOLS } from '../voice-realtime-tools.js';

/** The six tool names, in the order the descriptors declare them. */
const TOOL_NAMES = REALTIME_TOOLS.map((tool) => tool.name);

/** An executor that answers every tool the same way, so routing can be read off it. */
function answeringExecutor(onCall: (tool: string, args: Record<string, unknown>) => void): RealtimeToolExecutor {
  const executor: Record<string, (args: Record<string, unknown>) => unknown> = {};
  for (const tool of REALTIME_TOOLS) {
    executor[tool.name] = (args) => {
      onCall(tool.name, args);
      return { ok: tool.name };
    };
  }
  return executor;
}

test('AC1: walks connecting -> open -> closing -> closed, reconnecting after a drop', async () => {
  const transport = createFakeTransport();
  const states: string[] = [];
  const bridge = connect(transport, REALTIME_TOOLS, {}, {
    maxConnectAttempts: 3,
    hooks: { onStateChange: (next) => states.push(next) },
  });

  await bridge.whenConnected();
  assert.equal(bridge.state, 'open');
  assert.equal(transport.openCalls, 1);

  // The peer drops the socket: the bridge reconnects on its own and never throws.
  transport.drop();
  await waitFor(() => bridge.state === 'open' && transport.openCalls === 2);
  assert.equal(bridge.state, 'open');

  await bridge.close();
  assert.equal(bridge.state, 'closed');
  assert.equal(transport.closeCalls, 1);
  assert.deepEqual(states, ['open', 'connecting', 'open', 'closing', 'closed']);
});

test('AC1: spends a bounded attempt budget and closes rather than retrying forever', async () => {
  const transport = createFakeTransport({ failOpens: Number.POSITIVE_INFINITY });
  const errors: RealtimeBridgeError[] = [];
  const states: string[] = [];
  const bridge = connect(transport, REALTIME_TOOLS, {}, {
    maxConnectAttempts: 2,
    hooks: { onError: (error) => errors.push(error), onStateChange: (next) => states.push(next) },
  });

  // `whenConnected` resolves even though the socket never opened — it NEVER rejects.
  await bridge.whenConnected();
  assert.equal(bridge.state, 'closed');
  assert.equal(transport.openCalls, 2);
  assert.equal(errors.length, 2);
  for (const error of errors) {
    assert.equal(error.code, 'CONNECTION_FAILED');
    if (error.code === 'CONNECTION_FAILED') {
      assert.equal(error.maxAttempts, 2);
    }
  }
  assert.deepEqual(states, ['closing', 'closed']);
});

test('AC2: each mirrored schema equals the MCP gateway declaration, field for field', async () => {
  const captured = await captureMcpToolSchemas();

  assert.deepEqual(
    [...TOOL_NAMES].sort(),
    ['approvals_list', 'run_get', 'session_background', 'session_get', 'session_send', 'ui_visible_context'],
  );

  for (const name of TOOL_NAMES) {
    const oracle = captured[name];
    assert.ok(oracle, `the MCP gateway must register ${name}`);
    const mismatches = diffToolDescriptors(oracle, REALTIME_TOOLS_BY_NAME[name]);
    assert.deepEqual(mismatches, [], `${name} drifted from the gateway's own declaration`);
  }
});

// ── AC2 (session_status): the voice-only whitelist has exactly one member, and the mirror is
// untouched ────────────────────────────────────────────────────────────────────────────────────────
//
// `session_status` is not a gateway mirror (see `VOICE_ONLY_TOOLS`), so the mirror invariant AC-2
// cannot see it — but that is exactly the kind of claim that drifts silently, so it is asserted here:
// the whitelist of tools EXCUSED from mirroring the gateway names exactly `session_status`, and the
// gateway really has no such registration to mirror (a second member, or a tool the gateway later
// happens to register, would red this).
//
// The whitelist still names it even though the 2026-10-14 ruling WITHDREW it from the advertised set
// (the model is a pen; see `VOICE_REALTIME_TOOLS`). The member is excused from the mirror because it
// has no gateway counterpart — NOT because it is advertised — so the two facts are asserted
// separately: it is in the whitelist, and it is absent from what the voice plane offers the model.
test('AC2 (session_status): the voice-only whitelist is exactly session_status, and the gateway does not register it', async () => {
  assert.deepEqual([...VOICE_ONLY_TOOLS], ['session_status'], 'the whitelist is exactly one member');

  // Every member of the whitelist is ABSENT from the voice plane's advertised set: withdrawing the
  // advertisement is the 2026-10-14 ruling, and re-advertising it must red here.
  const voiceNames = VOICE_REALTIME_TOOLS.map((tool) => tool.name);
  for (const name of VOICE_ONLY_TOOLS) {
    assert.equal(voiceNames.includes(name), false, `${name} is voice-only and withdrawn from the advertisement`);
  }

  // … and has NO gateway counterpart, which is the whole reason it is excused from the mirror.
  const captured = await captureMcpToolSchemas();
  for (const name of VOICE_ONLY_TOOLS) {
    assert.equal(captured[name], undefined, `${name} is voice-only: the gateway must not register it`);
  }
});

// ── AC6: the relay is TOLD to stop, and the send mirror is untouched ──────────────────────────
//
// Adding the interrupt tool must not disturb the send mirror (AC-2): the instruction text is the one
// place a stop word could have been smuggled into the RELAY rather than into the tool surface, so the
// directive is asserted HERE, beside the field-by-field mirror it must not have broken.
test('AC6: the relay instructions carry the stop directive, and the session_send mirror is intact', async () => {
  const captured = await captureMcpToolSchemas();
  const sendMirror = captured['session_send'];
  assert.ok(sendMirror, 'the MCP gateway must still register session_send');
  assert.deepEqual(
    diffToolDescriptors(sendMirror, REALTIME_TOOLS_BY_NAME['session_send']),
    [],
    'the stop change must not drift the session_send mirror',
  );

  // The model is told the ONE exception to "always call session_send": a stop, which calls
  // session_interrupt. The stop is the model's own JUDGEMENT — the prompt says outright that
  // there is no word list to match (SPEC C-2); the exhaustive no-stop-word scan is
  // `voice-realtime-instructions-no-stop-words.test.ts`.
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /session_interrupt/);
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /stop/i);
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /judge/i);
});

test('AC3: routes each function call to its executor and passes arguments unchanged', async () => {
  const transport = createFakeTransport();
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bridge = connect(transport, REALTIME_TOOLS, answeringExecutor((tool, args) => calls.push({ tool, args })), {});
  await bridge.whenConnected();

  const inputs: Record<string, Record<string, unknown>> = {
    ui_visible_context: { client: 'phone', navigationId: 'nav-1' },
    session_send: { session: 's-1', message: 'hello there', waitSeconds: 5 },
    session_get: { session: 's-1' },
    run_get: { runId: 'r-1', wait: true, waitSeconds: 3 },
    approvals_list: { session: 's-1' },
    session_background: { session: 's-1', stopTaskId: 'bg-1' },
  };

  TOOL_NAMES.forEach((name, index) => {
    transport.peerSend({
      type: 'function_call',
      callId: `call-${index}`,
      name,
      arguments: JSON.stringify(inputs[name]),
    });
  });

  // Every call went to the executor named by the tool — not to a fixed one.
  assert.deepEqual(calls.map((call) => call.tool), TOOL_NAMES);

  TOOL_NAMES.forEach((name, index) => {
    // Arguments are passed through untouched: same values AND same key order.
    assert.deepEqual(calls[index].args, inputs[name]);
    assert.deepEqual(Object.keys(calls[index].args), Object.keys(inputs[name]));
  });

  const outputs = transport.sent.filter(
    (message): message is Extract<RealtimeClientMessage, { type: 'function_call_output' }> =>
      message.type === 'function_call_output',
  );
  assert.equal(outputs.length, TOOL_NAMES.length);
  TOOL_NAMES.forEach((name, index) => {
    assert.equal(outputs[index].callId, `call-${index}`);
    assert.deepEqual(outputs[index].output, { ok: name });
  });
});

test('AC4: unknown events, an executor throw, an unknown tool and a dropped socket are reported, never fatal', async () => {
  const transport = createFakeTransport();
  const errors: RealtimeBridgeError[] = [];
  let routed = 0;
  const executor: RealtimeToolExecutor = {
    session_send: () => {
      routed += 1;
      return 'sent';
    },
    boom: () => {
      throw new Error('executor exploded');
    },
  };
  const bridge = connect(transport, REALTIME_TOOLS, executor, { hooks: { onError: (error) => errors.push(error) } });
  await bridge.whenConnected();

  // (1) an event type the bridge does not know.
  transport.peerSend({ type: 'response.audio_transcript.delta', delta: 'hi' });
  // (2) an executor that throws.
  transport.peerSend({ type: 'function_call', callId: 'c-boom', name: 'boom', arguments: '{"a":1}' });
  // (3) a tool name with no executor.
  transport.peerSend({ type: 'function_call', callId: 'c-unknown', name: 'not_a_tool', arguments: '{}' });
  // (4) the connection drops under it.
  transport.drop();

  assert.deepEqual(
    errors.map((error) => error.code),
    ['UNKNOWN_EVENT', 'TOOL_EXECUTION_FAILED', 'UNKNOWN_TOOL', 'CONNECTION_LOST'],
  );

  // Each failure carries the detail that identifies it, not just a generic code.
  const unknownEvent = errors[0];
  const executionFailed = errors[1];
  const unknownTool = errors[2];
  const connectionLost = errors[3];
  if (unknownEvent.code === 'UNKNOWN_EVENT') {
    assert.equal(unknownEvent.eventType, 'response.audio_transcript.delta');
  }
  if (executionFailed.code === 'TOOL_EXECUTION_FAILED') {
    assert.equal(executionFailed.tool, 'boom');
    assert.equal(executionFailed.callId, 'c-boom');
  }
  if (unknownTool.code === 'UNKNOWN_TOOL') {
    assert.equal(unknownTool.tool, 'not_a_tool');
  }
  if (connectionLost.code === 'CONNECTION_LOST') {
    assert.equal(connectionLost.willRetry, true);
  }

  // Still alive: the reconnect lands, and a valid call still routes afterwards.
  await waitFor(() => bridge.state === 'open');
  transport.peerSend({ type: 'function_call', callId: 'c-ok', name: 'session_send', arguments: '{"session":"s","message":"m"}' });
  assert.equal(routed, 1);
});

// ── AC4 (this task): a committed user utterance fires the hook, exactly once per event ──────────
//
// Continuous mode's duplicate guard (the proxy) counts the endpoint's `input_audio_buffer.committed`
// events to tell a real relay from the model re-sending one utterance with no new audio. The bridge
// swallows that event as tolerated traffic, so it must surface it through its own hook — and it must
// stay OUT of the error channel: a continuously-capturing session commits constantly, and a failure
// per commit would leave the page holding a stream of errors for a session that works.
test('AC4: a committed user utterance fires onUserAudioCommitted once and is not reported as an error', async () => {
  const transport = createFakeTransport();
  const errors: RealtimeBridgeError[] = [];
  let committed = 0;
  const bridge = connect(transport, REALTIME_TOOLS, {}, {
    hooks: { onError: (error) => errors.push(error), onUserAudioCommitted: () => { committed += 1; } },
  });
  await bridge.whenConnected();

  transport.peerSend({ type: 'input_audio_buffer.committed' });
  // A neighbouring tolerated event must NOT fire the hook: it is the commit that signals audio.
  transport.peerSend({ type: 'response.created', response: { id: 'r1' } });
  transport.peerSend({ type: 'input_audio_buffer.speech_stopped' });

  await waitFor(() => committed === 1);
  assert.equal(committed, 1, 'one committed utterance fires the hook exactly once');
  assert.deepEqual(errors, [], 'a committed utterance is normal traffic, not a failure');

  await bridge.close();
});

test('AC5: the whole exercise is offline — fetch and WebSocket are never touched', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  let networkCalls = 0;
  const trip = (label: string) => () => {
    networkCalls += 1;
    throw new Error(`real network via ${label}`);
  };
  globalThis.fetch = trip('fetch') as unknown as typeof fetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = trip('WebSocket');

  try {
    const transport = createFakeTransport({ failOpens: 1 });
    const bridge = connect(transport, REALTIME_TOOLS, answeringExecutor(() => {}), { maxConnectAttempts: 3 });
    await bridge.whenConnected();

    bridge.sendSessionUpdate('be brief');
    bridge.sendAudioFrame('AAAA');
    transport.peerSend({ type: 'function_call', callId: 'c1', name: 'session_send', arguments: '{"session":"s","message":"m"}' });
    transport.peerSend({ type: 'a_type_the_bridge_does_not_know' });
    transport.drop();
    await waitFor(() => bridge.state === 'open');
    await bridge.close();

    assert.equal(networkCalls, 0, 'the bridge must not reach for a real network');
    // The fake transport really carried the traffic.
    assert.ok(transport.sent.some((message) => message.type === 'session.update'));
    assert.ok(transport.sent.some((message) => message.type === 'input_audio_buffer.append'));
    assert.ok(transport.sent.some((message) => message.type === 'function_call_output'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A call the endpoint's own turn detector cut off MID-ARGUMENT (2026-10-14, journal `d4c9bfc4`).
//
// THE DEFECT THIS PINS. Five `MALFORMED_FUNCTION_CALL` frames reached the browser in two minutes
// (01:35:03, 01:36:45, 01:36:47, 01:37:20, 01:37:23) and every one of them had the SAME mechanism: the
// model was streaming `session_send`'s arguments, the person kept talking, the endpoint's `server_vad`
// read the new speech as a new turn, and the response was cancelled `turn_detected` with its JSON
// unwritten —
//
//     .664  << function_call session_send {"message": "        ← the bridge reports MALFORMED
//     .665  << response.done status=cancelled reason=turn_detected
//
// — after which the model re-sent the whole call, 5/5 times, and nothing was lost. So the truncation is
// the watermark design working as intended, and showing the person an error for it is noise.
//
// THE READINGS, ONE CASE EACH (all over the SHIPPING proxy and a fake upstream, so what is asserted is
// the browser's own frames and the journal's own lines):
//  - AC1 — the truncating cancellation sends the browser NO error frame and writes a `truncated-by-turn`
//          line to the journal.
//  - AC2 — the same unwritten JSON with a response that COMPLETED is still reported as
//          `MALFORMED_FUNCTION_CALL`: a genuinely bad call is not swallowed.
//  - AC3 — the model re-sending the call delivers the sentence transcribed before the truncation.
//  - AC4 — the false form: reporting on arrival (no hold) reds AC1.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A minimal stand-in for the browser's `ws.WebSocket` — same shape as the sibling criteria's. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
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

/** The executor stand-in: records every `session_send` the proxy decided to deliver, never fails. */
function createRecordingExecutor(): { calls: RecordedSend[]; executor: RealtimeToolExecutor } {
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, echoedMessage: args.message };
    },
  };
  return { calls, executor };
}

type Wired = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  base: { calls: RecordedSend[]; executor: RealtimeToolExecutor };
  logs: string[];
};

/** One proxy connection over a fake browser socket, a fake upstream, and a recording log seam. */
function wireOver(handler: typeof handleVoiceRealtimeConnection): Wired {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createRecordingExecutor();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
    // THE CONTINUOUS WIRE, PINNED — the mode the journal's defect was recorded in.
    segmentedRelay: false,
    log: (line) => logs.push(line),
  };
  handler(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'session-under-test', seams);
  return { socket, transport, base, logs };
}

const wire = (): Wired => wireOver(handleVoiceRealtimeConnection);

/** Waits for the session to be open and usable. Continuous needs no `hello`. */
async function open(wired: Wired): Promise<void> {
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** Yields to the microtask queue and one timer turn, so an async delivery that was going to happen has. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** The model's relay, cut off mid-argument exactly as the wire cut it: the closing quote never written. */
const TRUNCATED_ARGUMENTS = '{"message": "';

/** The endpoint's `response.done` for a response its own detector cancelled because the person spoke. */
const TURN_DETECTED_DONE = {
  type: 'response.done',
  response: { id: 'resp-truncated', status: 'cancelled', status_details: { type: 'cancelled', reason: 'turn_detected' } },
};

/**
 * The fixture both the criterion and its false form drive: a `session_send` cut off mid-argument, then
 * the endpoint's own `response.done` for that same response.
 */
async function runTruncatedCall(
  handler: typeof handleVoiceRealtimeConnection,
  done: RealtimeServerMessage,
): Promise<Wired> {
  const wired = wireOver(handler);
  await open(wired);
  wired.transport.peerSend({ type: 'response.created', response: { id: 'resp-truncated' } } as RealtimeServerMessage);
  wired.transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId: 'call_truncated',
    arguments: TRUNCATED_ARGUMENTS,
  } as RealtimeServerMessage);
  wired.transport.peerSend(done);
  await tick();
  return wired;
}

const errorFrames = (socket: FakeBrowserSocket, code?: string): VoiceRealtimeOutboundFrame[] =>
  socket.outbound.filter((frame) => frame.type === 'error' && (code === undefined || frame.code === code));

/**
 * The journal the shipping classifier would have written for these lines — so "the journal says so" is
 * asserted against the code that writes the journal, not against the raw seam array alone.
 */
function journalOf(lines: readonly string[]): VoiceRealtimeLogEntry[] {
  const entries: VoiceRealtimeLogEntry[] = [];
  const store: VoiceRealtimeLogStore = {
    append: (entry) => {
      entries.push(entry);
    },
    clear: () => ({ deleted: 0 }),
    directory: () => '/no-such-journal-directory',
  };
  const recorder = createVoiceRealtimeRecorder({
    store,
    connectionId: 'connection-under-test',
    sessionId: 'session-under-test',
    tag: 'test',
    mode: 'continuous',
    stdout: () => undefined,
  });
  for (const line of lines) recorder.log(line);
  return entries;
}

/** The journal lines that read as a truncated-by-turn truncation. */
const truncationLines = (entries: readonly VoiceRealtimeLogEntry[]): string[] =>
  entries
    .filter((entry): entry is Extract<VoiceRealtimeLogEntry, { kind: 'log' }> => entry.kind === 'log')
    .map((entry) => entry.line)
    .filter((line) => line.includes('truncated-by-turn'));

test('AC1: a call the turn detector cut off sends the browser no error frame and is journalled as truncated-by-turn', async () => {
  const wired = await runTruncatedCall(handleVoiceRealtimeConnection, TURN_DETECTED_DONE as RealtimeServerMessage);

  // FIRST ASSERTION IN THIS SECTION, on purpose: the false form below sends this same frame, so a build
  // that reported the truncation on arrival must red HERE, on the browser-side reading the defect is about.
  assert.deepEqual(errorFrames(wired.socket), [], 'the truncation must not put any error frame in front of the person');

  // The reading still exists — on the server side, where the recurrence is diagnosed, and with the call
  // it belongs to, so the journal is the count.
  assert.equal(truncationLines(journalOf(wired.logs)).length, 1, 'the journal carries one truncated-by-turn line');
  assert.match(truncationLines(journalOf(wired.logs))[0] ?? '', /call_truncated/, 'and it names the call that was cut off');
  assert.ok(
    wired.logs.some((line) => line.includes('truncated-by-turn')),
    'the line the journal classifies is the one the proxy wrote',
  );

  wired.socket.close();
});

test('AC2: the same unwritten JSON with a COMPLETED response is still reported as MALFORMED_FUNCTION_CALL', async () => {
  const wired = await runTruncatedCall(handleVoiceRealtimeConnection, {
    type: 'response.done',
    response: { id: 'resp-truncated', status: 'completed' },
  } as RealtimeServerMessage);

  const malformed = errorFrames(wired.socket, 'MALFORMED_FUNCTION_CALL');
  assert.equal(malformed.length, 1, 'a genuinely malformed call is not swallowed by the truncation reading');
  assert.equal(truncationLines(journalOf(wired.logs)).length, 0, 'and nothing is journalled as a truncation');

  wired.socket.close();
});

test('AC3: the model re-sending the call delivers the sentence transcribed before the truncation', async () => {
  const wired = wire();
  await open(wired);

  wired.transport.peerSend({ type: 'response.created', response: { id: 'resp-1' } } as RealtimeServerMessage);
  // The item the truncating call was answering for, transcribed with words.
  wired.transport.peerSend({ type: 'input_audio_buffer.committed', item_id: 'item_before' } as RealtimeServerMessage);
  wired.transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_before',
    transcript: '识别到实际执行的时间。',
  } as RealtimeServerMessage);
  // The model's call for it, cut off mid-argument by `turn_detected`.
  wired.transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId: 'call_truncated',
    arguments: TRUNCATED_ARGUMENTS,
  } as RealtimeServerMessage);
  wired.transport.peerSend(TURN_DETECTED_DONE as RealtimeServerMessage);
  // The model re-sends the whole call on its next turn — the item before the truncation still in its span.
  wired.transport.peerSend({ type: 'response.created', response: { id: 'resp-2' } } as RealtimeServerMessage);
  wired.transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId: 'call_resend',
    arguments: JSON.stringify({ message: '识别到实际执行的时间。' }),
  } as RealtimeServerMessage);
  await tick();

  assert.deepEqual(
    wired.base.calls.map((call) => call.args.message),
    ['识别到实际执行的时间。'],
    'the re-send is delivered, and its text is the sentence transcribed before the truncation',
  );
  assert.deepEqual(errorFrames(wired.socket), [], 'and no error frame was shown for the truncation that preceded it');

  wired.socket.close();
});

test('the conservative fallback: a truncated call whose response never ends is still reported as MALFORMED', async () => {
  // The hold must not become a swallow. When no `response.done` arrives (the endpoint never ends the
  // response, or the connection closes), the reading has to revert to the pre-existing report rather
  // than leaving the truncation unreported. Driven at the BRIDGE, so the settle bound can be shrunk.
  const transport = createFakeTransport();
  const errors: RealtimeBridgeError[] = [];
  const bridge = connect(transport, REALTIME_TOOLS, createRecordingExecutor().executor, {
    malformedSettleMs: 60,
    hooks: { onError: (error) => errors.push(error) },
  });
  await bridge.whenConnected();
  transport.peerSend({ type: 'response.created', response: { id: 'resp-truncated' } } as RealtimeServerMessage);
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId: 'call_truncated',
    arguments: TRUNCATED_ARGUMENTS,
  } as RealtimeServerMessage);

  // Held, not reported on arrival: the fix's whole point.
  await tick();
  assert.ok(errors.length === 0, 'nothing is reported while the response is still open');

  // No `response.done` ever comes; the bound elapses and the truncation is reported as-is.
  await waitFor(() => errors.length === 1, 1_000);
  assert.equal(errors[0]?.code, 'MALFORMED_FUNCTION_CALL', 'the fallback reports MALFORMED, never TRUNCATED_BY_TURN');
  await bridge.close();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Two upstream events the page was wrongly shown as failures (2026-10-14 evening reading).
//
//  · `conversation.item.deleted` — the endpoint retiring an item of its own, which it does right after
//    the relay cuts a response off. Normal traffic; it must produce NO fault, and no frame.
//  · an `error` whose message is `Response request cancelled by new input` — the interrupt working. The
//    browser must NOT see an `UPSTREAM_ERROR` frame for it, but it must still be JOURNALED, so the
//    recurrence stays diagnosable from the server side. Every OTHER upstream error keeps its frame.
//
// Driven over the SHIPPING proxy and a fake upstream (the harness below), so what is asserted is the
// browser's own frames and the journal's own lines — not the bridge's internal field.
// ════════════════════════════════════════════════════════════════════════════════════════════════
test('AC6: a deleted item and a "cancelled by new input" error are not failures — but another upstream error still is', async () => {
  const wired = wire();
  await open(wired);

  // (1) The endpoint retiring an item of its own: expected traffic, so NO fault and no frame.
  wired.transport.peerSend({ type: 'conversation.item.deleted', item_id: 'item_1' } as RealtimeServerMessage);

  // (2) The interrupt working: the endpoint cancels the response in flight and narrates it this way.
  //     No frame — but a journal line, so the reading is kept.
  wired.transport.peerSend({
    type: 'error',
    error: { code: 'invalid_request_error', message: 'Response request cancelled by new input' },
  } as RealtimeServerMessage);

  await tick();
  assert.deepEqual(
    errorFrames(wired.socket),
    [],
    'neither a deleted item nor a cancelled response is a failure frame in front of the person',
  );
  assert.ok(
    wired.logs.some((line) => line.includes('upstream-cancelled-by-new-input')),
    `the cancellation must still be journaled, got ${JSON.stringify(wired.logs)}`,
  );

  // (3) THE REVERSE LEG: any other upstream error is a real failure and still reaches the browser.
  wired.transport.peerSend({
    type: 'error',
    error: { code: 'server_error', message: 'the upstream blew up' },
  } as RealtimeServerMessage);
  await waitFor(() => errorFrames(wired.socket, 'UPSTREAM_ERROR').length === 1);
  assert.equal(
    errorFrames(wired.socket, 'UPSTREAM_ERROR').length,
    1,
    'a genuine upstream error keeps its UPSTREAM_ERROR frame',
  );

  wired.socket.close();
});

// ── AC4: the false form ────────────────────────────────────────────────────────────────────────────
//
// The mutation is the one the defect's own reading forbids: report the malformed call ON ARRIVAL (no
// hold), which is what the shipping code did before this task. It is applied to a COPY of the bridge,
// and a COPY of the proxy is pointed at that copy — because AC1's reading is the BROWSER's frame, and a
// mutated bridge driven directly would only assert the bridge's own field.
//
// The copies sit beside the shipping modules (so their relative imports resolve), carry the
// `__criterion-falsify-` prefix (so `server/tsconfig.json` excludes them), and are removed in a
// `finally`; a closing case proves this process left none of its own behind.

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping bridge: what the mutation copies. */
const SHIPPING_BRIDGE_MODULE = path.join(MODULE_DIR, 'voice-realtime-bridge.service.ts');
/** The shipping proxy: what the import retarget copies. */
const SHIPPING_PROXY_MODULE = path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts');
/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling criterion's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The hold, as it ships: the malformed call is kept for its response's own outcome. */
const HOLD_ANCHOR = '          holdMalformed(fault);';
/** The same statement with the hold removed — report on arrival, exactly the pre-task behaviour. */
const IMMEDIATE_MUTANT = '          emitError(fault);';
/** The proxy's single import of the bridge: retargeted so the mutant proxy drives the mutant bridge. */
const BRIDGE_IMPORT_ANCHOR = "} from './voice-realtime-bridge.service.js';";

/** Rewrites ONE anchor in the shipping source, refusing to proceed unless it occurs exactly once. */
function mutate(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `the mutation anchor must occur exactly once: ${JSON.stringify(anchor)}`);
  return source.replace(anchor, replacement);
}

/** Imports a proxy module by path. The specifier is dynamic, so TS types it structurally here. */
async function importProxy(modulePath: string): Promise<{ handleVoiceRealtimeConnection: typeof handleVoiceRealtimeConnection }> {
  return (await import(pathToFileURL(modulePath).href)) as {
    handleVoiceRealtimeConnection: typeof handleVoiceRealtimeConnection;
  };
}

test('AC4 false form: reporting a truncated call on arrival puts the MALFORMED_FUNCTION_CALL frame back in front of the browser (AC1 reds)', async () => {
  const bridgeSource = readFileSync(SHIPPING_BRIDGE_MODULE, 'utf8');
  const mutatedBridge = mutate(bridgeSource, HOLD_ANCHOR, IMMEDIATE_MUTANT);

  const bridgeCopyPath = ownCopy('bridge-hold');
  const proxyCopyPath = ownCopy('proxy-immediate');
  // The mutant proxy imports the mutant bridge BY NAME: the shipping proxy hard-codes the shipping
  // module's specifier, so a copy of the bridge alone would never be the one the proxy runs.
  const proxySource = readFileSync(SHIPPING_PROXY_MODULE, 'utf8');
  const mutatedProxy = mutate(
    proxySource,
    BRIDGE_IMPORT_ANCHOR,
    `} from './${path.basename(bridgeCopyPath, '.ts')}.js';`,
  );

  try {
    writeFileSync(bridgeCopyPath, mutatedBridge, 'utf8');
    writeFileSync(proxyCopyPath, mutatedProxy, 'utf8');
    const mutant = await importProxy(proxyCopyPath);

    // Unmutated (shipping): the truncation is held and the browser is told nothing — AC1's reading.
    const baseRun = await runTruncatedCall(handleVoiceRealtimeConnection, TURN_DETECTED_DONE as RealtimeServerMessage);
    assert.deepEqual(errorFrames(baseRun.socket), [], 'the shipping build sends no error frame for the truncation');
    baseRun.socket.close();

    // Mutated (report on arrival): the very frame AC1 forbids is sent — AC1 reds on this build.
    const mutRun = await runTruncatedCall(mutant.handleVoiceRealtimeConnection, TURN_DETECTED_DONE as RealtimeServerMessage);
    assert.equal(
      errorFrames(mutRun.socket, 'MALFORMED_FUNCTION_CALL').length,
      1,
      'with the hold removed, the truncation reaches the browser as MALFORMED_FUNCTION_CALL',
    );
    mutRun.socket.close();
  } finally {
    rmSync(bridgeCopyPath, { force: true });
    rmSync(proxyCopyPath, { force: true });
  }
});

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
