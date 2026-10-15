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

// The registry is entered BEFORE the rule module, and the order is load-bearing: the registry's own
// table reads this provider module's exports while it evaluates, so importing the provider first is
// a TDZ (`Cannot access 'dashscopeOmniId' before initialization`). The barrel below pulls the same
// pair through the transport, but the explicit side-effect import makes this file's order correct
// on its own — the same discipline `server/modules/voice/tests/voice-dashscope-usage.test.ts` uses.
import '../../../../shared/asr/asrRegistry.js';
// The endpoint rule module's SINGLE source for the address this service is reached at (AC-140). The
// transport composes `DASHSCOPE_REALTIME_ENDPOINT` from this export rather than typing the host.
import { PUBLIC_HOSTNAME as DASHSCOPE_PUBLIC_HOSTNAME } from '../../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js';
import {
  argumentSchemaViolation,
  connect,
  CONTEXT_BUDGET_WARNING_TOKENS,
  contextBudgetStatus,
  createDashscopeTransport,
  DASHSCOPE_REALTIME_ENDPOINT,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_TURN_DETECTION,
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  TOOL_OUTPUT_MAX_CHARS,
  toBridgeEvent,
  toDashscopeFrames,
  type DashscopeTransportError,
  type RealtimeClientMessage,
  type RealtimeToolExecutor,
} from '../index.js';

import { createFakeDashscopeServer, readRealtimeTrace } from './voice-realtime-dashscope-harness.js';
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

  // A tool result bigger than TOOL_OUTPUT_MAX_CHARS is replaced with a marked, bounded stand-in —
  // never silently cut mid-JSON (which would hand the model invalid JSON), and the real size stays
  // visible to both the model and a journal reader.
  const bigValue = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 500);
  const bigRaw = JSON.stringify({ value: bigValue });
  const [bigItemCreate] = toDashscopeFrames({ type: 'function_call_output', callId: 'c10', output: { value: bigValue } }, {});
  const bigOutput = (bigItemCreate as { item: { output: string } }).item.output;
  const parsedBigOutput = JSON.parse(bigOutput) as { truncated: boolean; originalChars: number; maxChars: number; preview: string };
  assert.equal(parsedBigOutput.truncated, true);
  assert.equal(parsedBigOutput.originalChars, bigRaw.length);
  assert.equal(parsedBigOutput.maxChars, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(parsedBigOutput.preview, bigRaw.slice(0, TOOL_OUTPUT_MAX_CHARS));
  assert.ok(bigOutput.length < bigRaw.length, 'the capped output must be smaller than the uncapped one');

  // A tool result AT the ceiling is untouched — the cap is inclusive, not an off-by-one trap.
  const exactValue = 'y'.repeat(TOOL_OUTPUT_MAX_CHARS - '{"value":""}'.length);
  const exactRaw = JSON.stringify({ value: exactValue });
  assert.equal(exactRaw.length, TOOL_OUTPUT_MAX_CHARS);
  const [exactItemCreate] = toDashscopeFrames({ type: 'function_call_output', callId: 'c11', output: { value: exactValue } }, {});
  assert.equal((exactItemCreate as { item: { output: string } }).item.output, exactRaw);
});

test('AC-xxx: contextBudgetStatus reads the SAME cumulative usage fields estimateRealtimeCostCny does, fails open on unknown shapes', () => {
  const under = contextBudgetStatus({
    input_tokens: CONTEXT_BUDGET_WARNING_TOKENS - 1,
    input_tokens_details: { audio_tokens: 0, text_tokens: CONTEXT_BUDGET_WARNING_TOKENS - 1 },
  });
  assert.deepEqual(under, {
    textTokens: CONTEXT_BUDGET_WARNING_TOKENS - 1,
    audioTokens: 0,
    overBudget: false,
    thresholdTokens: CONTEXT_BUDGET_WARNING_TOKENS,
  });

  // AT the threshold counts as over — a connection a human should glance at, not one token short.
  const at = contextBudgetStatus({
    input_tokens: CONTEXT_BUDGET_WARNING_TOKENS,
    input_tokens_details: { audio_tokens: 0, text_tokens: CONTEXT_BUDGET_WARNING_TOKENS },
  });
  assert.equal(at.overBudget, true);

  // No `input_tokens_details.text_tokens` reported ⇒ falls back to input-minus-audio, same rule
  // estimateRealtimeCostCny uses, so the two readings can never disagree about what "text" means.
  const fallback = contextBudgetStatus({ input_tokens: 9000, input_tokens_details: { audio_tokens: 400 } });
  assert.equal(fallback.textTokens, 8600);
  assert.equal(fallback.overBudget, true);

  // Unknown/malformed usage reads as zero, never throws — the same fail-open rule the cost
  // estimator documents for the exact same reason (a budget check must not crash the guard it
  // sits beside).
  assert.deepEqual(contextBudgetStatus(null), { textTokens: 0, audioTokens: 0, overBudget: false, thresholdTokens: CONTEXT_BUDGET_WARNING_TOKENS });
  assert.deepEqual(contextBudgetStatus(undefined), { textTokens: 0, audioTokens: 0, overBudget: false, thresholdTokens: CONTEXT_BUDGET_WARNING_TOKENS });
  assert.deepEqual(contextBudgetStatus('not an object'), { textTokens: 0, audioTokens: 0, overBudget: false, thresholdTokens: CONTEXT_BUDGET_WARNING_TOKENS });
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

test('AC-140: the endpoint is composed from the rule module’s single-source host', () => {
  // AC-140 holds that the addresses this service is reached at are spelled in exactly ONE shipping
  // source file — the endpoint rule module (`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`).
  // This transport is the second consumer, so it must BUILD its URL from that module's exported host
  // rather than carry a second literal. These two assertions are what make a future hard-coded
  // hostname here red: an endpoint that no longer starts with the exported host fails the first.
  assert.equal(
    DASHSCOPE_REALTIME_ENDPOINT,
    `wss://${DASHSCOPE_PUBLIC_HOSTNAME}/api-ws/v1/realtime`,
    'the endpoint must be composed from the rule module’s exported host',
  );
  assert.ok(
    DASHSCOPE_REALTIME_ENDPOINT.startsWith(`wss://${DASHSCOPE_PUBLIC_HOSTNAME}/`),
    'a second, hard-coded host in this module would no longer derive from the single source',
  );
});

test('AC10: the schema check passes a conforming call and names the field a violating one breaks', () => {
  const shape = REALTIME_TOOLS_BY_NAME.session_send.inputSchema as unknown as Readonly<Record<string, unknown>>;
  assert.equal(argumentSchemaViolation(shape, { session: 's', message: 'm' }), null);
  const reason = argumentSchemaViolation(shape, { session: 42 });
  assert.ok(reason !== null, 'a call missing a required field must be a violation');
  assert.ok(reason.includes('message'), `the reason must name the missing field: ${reason}`);
});

test('AC9: the preserved qwen3.8-omni-flash-realtime trace records a real target-model connection', () => {
  const trace = readRealtimeTrace('qwen38-omni-realtime-trace.json');

  // The formally adopted target model, and the voice constraint it requires.
  assert.equal(trace.model, 'qwen3.8-omni-flash-realtime');
  assert.equal(trace.voice, 'Tina', 'the trace must record the explicit voice the model requires');
  assert.equal(trace.endpoint, DASHSCOPE_REALTIME_ENDPOINT);

  // The session advertised all six tools AND the explicit voice on the wire.
  const sessionUpdate = trace.exchange.find(
    (entry) => entry.direction === 'sent' && entry.wire.type === 'session.update',
  );
  assert.ok(sessionUpdate, 'the trace must record the session.update the transport sent');
  const session = sessionUpdate.wire.session as Record<string, unknown>;
  assert.equal(session.voice, 'Tina', 'session.update must carry the explicit voice the model requires');
  assert.equal((session.tools as unknown[]).length, REALTIME_TOOLS.length);

  // A real endpoint-assigned session + conversation id.
  assert.match(trace.session.id, /^sess_/);
  assert.match(trace.session.conversationId ?? '', /^conv_/);

  // Real, non-zero, VARIED network latencies (a fixture's in-process "latencies" cannot look like this).
  assert.ok(trace.latenciesMs.length > 0);
  assert.ok(trace.latenciesMs.every((ms) => ms > 0));
  assert.ok(new Set(trace.latenciesMs).size > 1, 'real latencies vary');

  // Real audio input crossed the wire.
  assert.ok(
    trace.exchange.some((entry) => entry.direction === 'sent' && entry.wire.type === 'input_audio_buffer.append'),
    'real audio must have been sent',
  );

  // At least one MODEL-initiated call, for one of the DECLARED tools.
  const modelCalls = trace.functionCalls.filter((call) => call.source === 'model');
  assert.ok(modelCalls.length > 0, 'the model must have emitted a function call');
  assert.ok(
    REALTIME_TOOLS.some((tool) => tool.name === modelCalls[0].name),
    'the model-chosen tool must be one the session declared',
  );

  // The function_call_output was backfilled, and the model continued the SAME turn.
  const outputIndex = trace.exchange.findIndex(
    (entry) =>
      entry.direction === 'sent' &&
      entry.wire.type === 'conversation.item.create' &&
      (entry.wire.item as { type?: string } | undefined)?.type === 'function_call_output',
  );
  assert.ok(outputIndex >= 0, 'the tool result must have been backfilled as a function_call_output item');
  assert.ok(
    trace.exchange
      .slice(outputIndex + 1)
      .some((entry) => entry.direction === 'received' && entry.wire.type === 'response.created'),
    'the model must resume the same turn after the function_call_output',
  );

  // AC5: no credential literal ever reached the trace.
  assert.ok(!JSON.stringify(trace).includes('Authorization'));
});

test('AC9: the qwen3.8 trace is distinct from the preserved historical traces', () => {
  const target = readRealtimeTrace('qwen38-omni-realtime-trace.json');
  const historical = readRealtimeTrace('function-call-trace.json');
  assert.notEqual(target.model, historical.model, 'the target trace is not the 3.5 historical one');
  assert.notEqual(target.session.id, historical.session.id, 'the target trace is a fresh real session');
});

test('GOAL-037: the transport`s turn_detection default IS the resolver`s shipped default — one source, not two', () => {
  // The literal used to live here a second time (see DEFAULT_SESSION_DEFAULTS). If the two copies ever
  // diverged, the fallback the transport uses when no caller passes `sessionDefaults` would advertise a
  // different detector than the one `resolveTurnDetection` hands a deployment that configures nothing.
  assert.equal(
    DEFAULT_SESSION_DEFAULTS.turn_detection,
    DEFAULT_TURN_DETECTION,
    'the transport default must be the same frozen object the resolver exports',
  );
  assert.equal(
    JSON.stringify(DEFAULT_SESSION_DEFAULTS.turn_detection),
    '{"type":"server_vad","threshold":0.5,"silence_duration_ms":800}',
    'and its wire bytes are the shipped 800 ms window, stated here as well as in the resolver',
  );
});
