/**
 * AC-308's positive criterion for the real DashScope realtime transport.
 *
 * The transport is driven ENTIRELY over `voice-realtime-dashscope-harness.ts`'s
 * fake WS server — no socket, no `fetch` — across six readings:
 *
 *  - AC1: the full round trip works — `connect()` opens the transport,
 *    `session.update` is translated and sent, a real audio frame is forwarded, a
 *    server-delivered function call is routed to the executor, and the executor's
 *    result comes back as `conversation.item.create` + `response.create`.
 *  - the credential travels as a bearer HEADER (never in the URL), and the URL
 *    names the model.
 *  - the two DashScope function-call deliveries are normalised to ONE bridge
 *    `function_call` (de-duplicated by `call_id`), so the tool output is not sent twice.
 *  - a malformed server frame is reported, never fatal.
 *  - a dropped socket is reported through `onClose` and the bridge reconnects.
 *  - the whole exercise touches no real network — `fetch` and `WebSocket` are
 *    replaced by throwing probes and stay at zero calls.
 *
 * Provenance (goal record AC-308): this file is one of the two files the
 * criterion names. It MUST be run with THIS repo's runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file> <the .false-forms sibling>
 *
 * The server tree is TS-ESM — source imports use `.js` specifiers that resolve to
 * same-named `.ts` files — and Node's type-stripping does NOT remap `.js` → `.ts`.
 * `node --test` therefore dies with ERR_MODULE_NOT_FOUND on `../index.js`.
 *
 * Consumers: the quay worker's AC state for AC-308.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connect,
  createDashscopeTransport,
  DASHSCOPE_REALTIME_ENDPOINT,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  REALTIME_TOOLS,
  toBridgeEvent,
  toDashscopeFrames,
  type DashscopeTransportError,
  type RealtimeClientMessage,
  type RealtimeToolExecutor,
} from '../index.js';

import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';
import { waitFor } from './realtime-bridge-harness.js';

/** A key that is obviously not a real credential, so a leak would be unmistakable. */
const TEST_KEY = 'test-key-not-a-real-credential';

/** Picks the client frames the transport sent of one wire `type`. */
function sentOfType(
  sent: Array<Record<string, unknown>>,
  type: string,
): Array<Record<string, unknown>> {
  return sent.filter((frame) => frame.type === type);
}

test('AC1: drives connect / session.update / audio / function-call / function_call_output over the fake server', async () => {
  const server = createFakeDashscopeServer({ sessionId: 'sess_fixture_ws_0001', callId: 'call_fixture_ws_1' });
  const errors: DashscopeTransportError[] = [];
  const ran: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const executor: RealtimeToolExecutor = {
    ui_visible_context: (args) => {
      ran.push({ tool: 'ui_visible_context', args });
      return { devices: [] };
    },
  };
  const transport = createDashscopeTransport({
    apiKey: TEST_KEY,
    socketFactory: server.socketFactory,
    onError: (error) => errors.push(error),
  });
  const bridge = connect(transport, REALTIME_TOOLS, executor, {});

  await bridge.whenConnected();
  assert.equal(bridge.state, 'open');
  assert.equal(transport.state, 'open');
  assert.equal(server.openCalls, 1);

  // The credential travels as a header, and the URL names the model.
  assert.equal(server.dialedHeaders?.Authorization, `Bearer ${TEST_KEY}`);
  assert.ok(server.dialedUrl?.startsWith(DASHSCOPE_REALTIME_ENDPOINT));
  assert.match(server.dialedUrl ?? '', /[?&]model=/);
  assert.ok(!(server.dialedUrl ?? '').includes(TEST_KEY), 'the credential must never appear in the URL');

  // (1) session.update — the bridge's flat tool declarations are nested for the wire.
  bridge.sendSessionUpdate('be brief');
  const sessionUpdate = sentOfType(server.sent, 'session.update')[0];
  assert.ok(sessionUpdate, 'a session.update must have been sent');
  const session = sessionUpdate.session as Record<string, unknown>;
  assert.equal(session.instructions, 'be brief');
  const tools = session.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools.length, REALTIME_TOOLS.length);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, REALTIME_TOOLS[0].name);
  // The opening handshake was answered by the fixture, and the bridge survived the
  // events it does not model (reported, never fatal).
  assert.equal(sessionIdInSentinel(server.emitted), 'sess_fixture_ws_0001');

  // (2) audio frame — forwarded verbatim.
  bridge.sendAudioFrame('AAAA');
  const frame = sentOfType(server.sent, 'input_audio_buffer.append')[0];
  assert.ok(frame, 'an audio frame must have been sent');
  assert.equal(frame.audio, 'AAAA');

  // (3) function call received → executor routed → (4) function_call_output backfilled.
  assert.deepEqual(ran, [{ tool: 'ui_visible_context', args: { client: 'fixture' } }]);
  const itemCreate = sentOfType(server.sent, 'conversation.item.create')[0];
  assert.ok(itemCreate, 'the tool result must be sent back as a conversation item');
  const item = itemCreate.item as Record<string, unknown>;
  assert.equal(item.type, 'function_call_output');
  assert.equal(item.call_id, 'call_fixture_ws_1');
  assert.equal(item.output, JSON.stringify({ devices: [] }));
  // …and the turn is resumed.
  assert.equal(sentOfType(server.sent, 'response.create').length, 1);

  // Every bus error is the bridge's honest "unknown event", not a transport failure.
  assert.ok(errors.every((error) => error.code !== 'MALFORMED_SERVER_FRAME'));

  await bridge.close();
  assert.equal(bridge.state, 'closed');
  assert.equal(transport.state, 'closed');
});

/** Reads the session id out of the fixture's own emitted frames. */
function sessionIdInSentinel(emitted: Array<Record<string, unknown>>): string | null {
  for (const frame of emitted) {
    if (frame.type !== 'session.created') continue;
    const session = frame.session as Record<string, unknown> | undefined;
    if (session !== undefined && typeof session.id === 'string') return session.id;
  }
  return null;
}

test('AC1: the two DashScope function-call deliveries become ONE bridge function_call', async () => {
  const server = createFakeDashscopeServer();
  const transport = createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: server.socketFactory });
  const ran: string[] = [];
  const bridge = connect(transport, REALTIME_TOOLS, { ui_visible_context: () => { ran.push('ui'); return { devices: [] }; } }, {});
  await bridge.whenConnected();

  // The same call, delivered twice, exactly as the dialect can. (No audio frame
  // is sent: with no audio the fixture stays silent, so the TWO deliveries below
  // are the only source of calls and the de-duplication is unambiguous.)
  server.peerSend({ type: 'response.function_call_arguments.done', call_id: 'call_dup', name: 'ui_visible_context', arguments: '{}' });
  server.peerSend({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'call_dup', name: 'ui_visible_context', arguments: '{}' },
  });

  assert.deepEqual(ran, ['ui']);
  assert.equal(sentOfType(server.sent, 'conversation.item.create').length, 1, 'the de-duplication must hold');

  await bridge.close();
});

test('AC1: a malformed server frame is reported, never fatal', async () => {
  const server = createFakeDashscopeServer();
  const errors: DashscopeTransportError[] = [];
  const transport = createDashscopeTransport({
    apiKey: TEST_KEY,
    socketFactory: server.socketFactory,
    onError: (error) => errors.push(error),
  });
  const ran: string[] = [];
  const bridge = connect(transport, REALTIME_TOOLS, { ui_visible_context: () => { ran.push('ui'); return {}; } }, {});
  await bridge.whenConnected();

  server.peerSendRaw('{ this is not json');
  // Still alive: a real event after it still routes.
  server.peerSend({ type: 'response.function_call_arguments.done', call_id: 'call_after_bad', name: 'ui_visible_context', arguments: '{}' });

  assert.ok(errors.some((error) => error.code === 'MALFORMED_SERVER_FRAME'));
  assert.deepEqual(ran, ['ui']);
  await bridge.close();
});

test('AC1: an unexpected drop is reported through onClose and the bridge reconnects', async () => {
  const server = createFakeDashscopeServer();
  const transport = createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: server.socketFactory });
  const bridge = connect(transport, REALTIME_TOOLS, {}, { maxConnectAttempts: 3 });
  await bridge.whenConnected();
  assert.equal(server.openCalls, 1);

  server.drop();
  await waitFor(() => transport.state === 'open' && server.openCalls === 2);
  assert.equal(bridge.state, 'open');

  await bridge.close();
});

test('AC1: the whole exercise is offline — fetch and WebSocket are never touched', async () => {
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
    const server = createFakeDashscopeServer();
    const transport = createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: server.socketFactory });
    const bridge = connect(transport, REALTIME_TOOLS, { ui_visible_context: () => ({ ok: true }) }, {});
    await bridge.whenConnected();
    bridge.sendSessionUpdate('offline');
    bridge.sendAudioFrame('AAAA');
    server.peerSend({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'ui_visible_context', arguments: '{}' });
    server.drop();
    await waitFor(() => transport.state === 'open');
    await bridge.close();

    assert.equal(networkCalls, 0, 'the transport must not reach for a real network');
    assert.ok(server.sent.some((frame) => frame.type === 'session.update'));
    assert.ok(server.sent.some((frame) => frame.type === 'input_audio_buffer.append'));
    assert.ok(server.sent.some((frame) => frame.type === 'conversation.item.create'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  }
});

test('AC1: the outbound translation nests tools, resumes the turn, and keeps the bridge body authoritative', () => {
  const tools: RealtimeClientMessage = {
    type: 'session.update',
    session: {
      instructions: 'do it',
      tools: [{ type: 'function', name: 'session_send', description: 'send', parameters: { session: 's' } }],
    },
  };
  const [update] = toDashscopeFrames(tools, { modalities: ['text'], instructions: 'SHADOW' });
  const session = (update as { session: Record<string, unknown> }).session;
  // The caller's defaults may add wire fields, but never shadow the bridge's own body.
  assert.equal(session.instructions, 'do it');
  assert.deepEqual(session.tools, [
    { type: 'function', function: { name: 'session_send', description: 'send', parameters: { session: 's' } } },
  ]);
  assert.deepEqual(session.modalities, ['text']);

  // No tools → the field is omitted, not sent as an empty array.
  const [empty] = toDashscopeFrames(
    { type: 'session.update', session: { instructions: 'x', tools: [] } },
    {},
  );
  assert.ok(!('tools' in ((empty as { session: Record<string, unknown> }).session)));

  // A tool result becomes item-create + response-create.
  const frames = toDashscopeFrames({ type: 'function_call_output', callId: 'c9', output: { ok: true } }, {});
  assert.deepEqual(frames, [
    { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c9', output: '{"ok":true}' } },
    { type: 'response.create' },
  ]);
});

test('AC1: the inbound normaliser recognises both deliveries and passes everything else through', () => {
  assert.deepEqual(
    toBridgeEvent({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'session_get', arguments: '{"session":"s"}' }),
    { type: 'function_call', callId: 'c1', name: 'session_get', arguments: '{"session":"s"}' },
  );
  assert.deepEqual(
    toBridgeEvent({
      type: 'response.output_item.done',
      item: { object: 'realtime.item', type: 'function_call', call_id: 'c2', name: 'run_get', arguments: '{}' },
    }),
    { type: 'function_call', callId: 'c2', name: 'run_get', arguments: '{}' },
  );
  // A non-function-call output item is not a call; it is forwarded as itself.
  assert.deepEqual(toBridgeEvent({ type: 'response.output_item.done', item: { type: 'message' } }), {
    type: 'response.output_item.done',
    item: { type: 'message' },
  });
  // A frame with no `type`, and a non-object, are dropped.
  assert.equal(toBridgeEvent({ hello: 'world' }), null);
  assert.equal(toBridgeEvent('not an object'), null);
  assert.equal(toBridgeEvent(null), null);
});

test('AC1: the transport dials the model it was configured with, defaulting to the task-named model', () => {
  const server = createFakeDashscopeServer();
  const defaulted = createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: server.socketFactory });
  assert.match(defaulted.url, new RegExp(`model=${DEFAULT_DASHSCOPE_REALTIME_MODEL}$`));

  const toolCapable = createDashscopeTransport({
    apiKey: TEST_KEY,
    model: 'qwen3.5-omni-flash-realtime',
    socketFactory: server.socketFactory,
  });
  assert.match(toolCapable.url, /model=qwen3\.5-omni-flash-realtime$/);
});
