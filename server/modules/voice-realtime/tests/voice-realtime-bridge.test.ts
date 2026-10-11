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
import test from 'node:test';

import {
  connect,
  diffToolDescriptors,
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  type RealtimeBridgeError,
  type RealtimeClientMessage,
  type RealtimeToolExecutor,
} from '../index.js';

import { captureMcpToolSchemas, createFakeTransport, waitFor } from './realtime-bridge-harness.js';
import { VOICE_REALTIME_INSTRUCTIONS } from '../voice-realtime-ws-proxy.service.js';

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

  // The model is told the ONE exception to "always call session_send": a stop calls session_interrupt.
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /session_interrupt/);
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /stop/i);
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /停/);
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
