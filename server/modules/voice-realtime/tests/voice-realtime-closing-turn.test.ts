/**
 * The relay's closing turn and its slim `session_send` — two independent deployment switches.
 *
 * WHY THESE ARE SWITCHES. A delivered `session_send` used to be followed by a synthesized
 * `response.create` so the model could answer "OK" to nobody; on the 2026-10-15 23:00–00:02 journals
 * those 18 of 38 responses were 46% of the spend, each re-reading the whole context. Replays
 * (`experiments/voice-realtime-closing-turn`, ¥0.40 over 10 whole sessions and windows) showed that
 * removing the response AND the two "reply OK" requests together keeps every stop and loses no unit
 * K delivered, at 46–50% of K's cost. The earlier same-day rollback had removed the response and
 * left the request in place.
 *
 *   - `VOICE_REALTIME_CLOSING_TURN`   `silent` (default) | `respond` — the old behaviour, the rollback.
 *   - `VOICE_REALTIME_SLIM_SEND_TOOL` `on` (default) | `off` — the voice plane's `session_send` shape.
 *
 * Fully offline: the upstream is `createFakeDashscopeServer`, the browser an in-process emitter.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import {
  DEFAULT_VOICE_REALTIME_CLOSING_TURN,
  DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL,
  VOICE_REALTIME_CLOSING_TURN_ENV,
  VOICE_REALTIME_SLIM_SEND_TOOL_ENV,
  describeVoiceRealtimeClosingTurn,
  describeVoiceRealtimeSlimSendTool,
  resolveVoiceRealtimeClosingTurn,
  resolveVoiceRealtimeSlimSendTool,
  type VoiceRealtimeClosingTurn,
} from '../voice-realtime-closing-turn.js';
import { REALTIME_TOOLS, VOICE_REALTIME_TOOLS, voiceRealtimeToolsFor } from '../voice-realtime-tools.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  voiceRealtimeInstructionsFor,
  type VoiceRealtimeOutboundFrame,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------------------- the two resolvers

test('the closing turn is SILENT by default: unset, empty and blank all land there with nothing to report', () => {
  assert.equal(DEFAULT_VOICE_REALTIME_CLOSING_TURN, 'silent');
  for (const raw of [undefined, '', '   ']) {
    const resolution = resolveVoiceRealtimeClosingTurn({ [VOICE_REALTIME_CLOSING_TURN_ENV]: raw });
    assert.deepEqual(resolution, { closingTurn: 'silent', invalid: null });
    assert.equal(describeVoiceRealtimeClosingTurn(resolution), null);
  }
  assert.deepEqual(resolveVoiceRealtimeClosingTurn({}), { closingTurn: 'silent', invalid: null });
});

test('`respond` is the rollback, spelled exactly; whitespace is trimmed', () => {
  assert.deepEqual(resolveVoiceRealtimeClosingTurn({ [VOICE_REALTIME_CLOSING_TURN_ENV]: 'respond' }), {
    closingTurn: 'respond',
    invalid: null,
  });
  assert.deepEqual(resolveVoiceRealtimeClosingTurn({ [VOICE_REALTIME_CLOSING_TURN_ENV]: '  respond  ' }), {
    closingTurn: 'respond',
    invalid: null,
  });
  assert.deepEqual(resolveVoiceRealtimeClosingTurn({ [VOICE_REALTIME_CLOSING_TURN_ENV]: 'silent' }), {
    closingTurn: 'silent',
    invalid: null,
  });
});

test('`announce` is a third closing turn, spelled exactly', () => {
  assert.deepEqual(resolveVoiceRealtimeClosingTurn({ [VOICE_REALTIME_CLOSING_TURN_ENV]: 'announce' }), {
    closingTurn: 'announce',
    invalid: null,
  });
});

test('an unknown closing-turn value is NOT obeyed as a rollback: it resolves to the default and says so', () => {
  const resolution = resolveVoiceRealtimeClosingTurn({ [VOICE_REALTIME_CLOSING_TURN_ENV]: 'respnd' });
  assert.deepEqual(resolution, { closingTurn: 'silent', invalid: 'respnd' });
  const line = describeVoiceRealtimeClosingTurn(resolution);
  assert.ok(line !== null && line.includes('respnd') && line.includes(VOICE_REALTIME_CLOSING_TURN_ENV), String(line));
});

test('the slim send tool is ON by default; `off` is the rollback; an unknown value is reported, not obeyed', () => {
  assert.equal(DEFAULT_VOICE_REALTIME_SLIM_SEND_TOOL, true);
  assert.deepEqual(resolveVoiceRealtimeSlimSendTool({}), { slim: true, invalid: null });
  assert.deepEqual(resolveVoiceRealtimeSlimSendTool({ [VOICE_REALTIME_SLIM_SEND_TOOL_ENV]: '' }), { slim: true, invalid: null });
  assert.deepEqual(resolveVoiceRealtimeSlimSendTool({ [VOICE_REALTIME_SLIM_SEND_TOOL_ENV]: 'on' }), { slim: true, invalid: null });
  assert.deepEqual(resolveVoiceRealtimeSlimSendTool({ [VOICE_REALTIME_SLIM_SEND_TOOL_ENV]: 'off' }), { slim: false, invalid: null });
  const typo = resolveVoiceRealtimeSlimSendTool({ [VOICE_REALTIME_SLIM_SEND_TOOL_ENV]: 'of' });
  assert.deepEqual(typo, { slim: true, invalid: 'of' });
  const line = describeVoiceRealtimeSlimSendTool(typo);
  assert.ok(line !== null && line.includes('"of"'), String(line));
});

test('the two switches are independent: every combination resolves, none reads the other', () => {
  for (const closing of ['silent', 'respond', 'announce']) {
    for (const slim of ['on', 'off']) {
      const env = { [VOICE_REALTIME_CLOSING_TURN_ENV]: closing, [VOICE_REALTIME_SLIM_SEND_TOOL_ENV]: slim };
      assert.equal(resolveVoiceRealtimeClosingTurn(env).closingTurn, closing);
      assert.equal(resolveVoiceRealtimeSlimSendTool(env).slim, slim === 'on');
    }
  }
});

// ------------------------------------------------------------------------------- the prompt text

test('the respond prompt is byte-identical to the shipped one; the silent prompt differs by ONE sentence', () => {
  const respond = voiceRealtimeInstructionsFor('respond');
  const silent = voiceRealtimeInstructionsFor('silent');
  assert.equal(respond, VOICE_REALTIME_INSTRUCTIONS, 'the rollback must be the prompt that was measured and shipped');
  assert.match(respond, /Then reply with the single word OK and say nothing else\./);
  assert.doesNotMatch(silent, /single word OK/);
  assert.match(silent, /Then say nothing more\./);
  assert.equal(
    silent,
    respond.replace('Then reply with the single word OK and say nothing else.', 'Then say nothing more.'),
    'nothing else in the prompt may move with the switch',
  );
});

test('the announce prompt is the silent prompt plus ONE starting-report exception', () => {
  const announce = voiceRealtimeInstructionsFor('announce');
  const silent = voiceRealtimeInstructionsFor('silent');
  assert.doesNotMatch(announce, /single word OK/);
  assert.match(announce, /Then say nothing more\./);
  assert.match(announce, /One more exception to the no-reply rule/);
  const added =
    'One more exception to the no-reply rule: right after you deliver a `session_send`, say ONE short sentence (in the user’s language, at most 15 words) telling them you are starting — for example “好的，我来查一下”. It reports your action only: never an answer to what they said, never their words repeated, never Claude Code’s output read back. This is the only thing you may ever say aloud; then wait for the user to speak again.';
  assert.equal(announce.replace(` ${added}`, ''), silent, 'nothing else in the prompt may move with the switch');
});

// ----------------------------------------------------------------- the tool result the model reads

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

type SeamChoice = { closingTurn?: VoiceRealtimeClosingTurn; slimSendTool?: boolean; instructions?: string };

function wire(choice: SeamChoice = {}) {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const delivered: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      delivered.push(args);
      return { runId: 'r', queued: false };
    },
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: 'sk-test-not-a-real-key', socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: choice.instructions ?? VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: false,
    // The coalescing window is the branch whose result is the one the model reads after an ordinary send.
    coalesceMs: 50,
    ...(choice.closingTurn === undefined ? {} : { closingTurn: choice.closingTurn }),
    ...(choice.slimSendTool === undefined ? {} : { slimSendTool: choice.slimSendTool }),
  });
  return { upstream, socket, delivered };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

const callSend = (upstream: ReturnType<typeof createFakeDashscopeServer>, callId: string, args: Record<string, unknown>): void =>
  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name: 'session_send',
    arguments: JSON.stringify(args),
  });

async function firstToolOutput(choice: SeamChoice): Promise<string> {
  const { upstream, socket } = wire(choice);
  await waitFor(() => opened(socket));
  callSend(upstream, 'c1', { message: '跑一下测试。' });
  await waitFor(() => upstream.sent.some((f) => f.type === 'conversation.item.create'));
  const item = upstream.sent.find((f) => f.type === 'conversation.item.create') as { item: { output: string } };
  socket.close();
  return String(item.item.output);
}

test('silent: the tool result no longer asks for "OK" and says nothing more is needed', async () => {
  const text = await firstToolOutput({ closingTurn: 'silent' });
  assert.doesNotMatch(text, /single word OK/);
  assert.match(text, /Do not call session_send again/, 'the loop guard wording must survive (streaming-stages P12)');
  assert.match(text, /say nothing and wait for the user to speak again/);
  assert.doesNotMatch(text, /will be delivered when the user stops speaking/);
});

test('respond: the tool result is the shipped wording, byte for byte', async () => {
  const text = await firstToolOutput({ closingTurn: 'respond' });
  assert.match(text, /Do not call session_send again for it\. Reply with the single word OK\./);
});

test('announce: the tool result asks for ONE starting sentence, not OK and not silence', async () => {
  const text = await firstToolOutput({ closingTurn: 'announce' });
  assert.doesNotMatch(text, /single word OK/);
  assert.doesNotMatch(text, /say nothing and wait for the user to speak again/);
  assert.match(text, /Do not call session_send again/, 'the loop guard wording must survive');
  assert.match(text, /Say ONE short sentence/);
  assert.match(text, /never read Claude Code/);
});

test('a proxy handed no closing-turn seam ships the default (silent), without reading the environment', async () => {
  const text = await firstToolOutput({});
  assert.doesNotMatch(text, /single word OK/);
  assert.match(text, /say nothing and wait for the user to speak again/);
});

test('silent: the duplicate-call refusal does not ask for "OK" either (the path that ends a call chain)', async () => {
  const { upstream, socket, delivered } = wire({ closingTurn: 'silent' });
  await waitFor(() => opened(socket));
  upstream.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'i1',
    transcript: '跑一下测试。',
  });
  callSend(upstream, 'c1', { message: '跑一下测试。' });
  await waitFor(() => delivered.length === 1, 2_000);
  callSend(upstream, 'c2', { message: '跑一下测试。' });
  await waitFor(
    () => upstream.sent.filter((f) => f.type === 'conversation.item.create').length >= 2,
    2_000,
  );
  await sleep(100);
  const outputs = upstream.sent
    .filter((f) => f.type === 'conversation.item.create')
    .map((f) => String((f as { item: { output?: unknown } }).item.output));
  assert.equal(delivered.length, 1, 'the repeat must not be delivered again');
  assert.ok(outputs.every((o) => !/single word OK/.test(o)), JSON.stringify(outputs));
  socket.close();
});

// ------------------------------------------------------------------------------ the slim tool

/**
 * The field names `session_send` is advertised with. The bridge declares a tool's `parameters` as the
 * descriptor's raw Zod shape, so on the wire its KEYS are the field names (there is no `properties`).
 */
const sessionSendProperties = (upstream: ReturnType<typeof createFakeDashscopeServer>): string[] => {
  const update = upstream.sent.find((f) => f.type === 'session.update') as {
    session: { tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> };
  };
  const tool = update.session.tools.find((t) => t.function.name === 'session_send')!;
  return Object.keys(tool.function.parameters).sort();
};

test('slim: the voice plane advertises session_send with `message` alone', async () => {
  const { upstream, socket } = wire({ slimSendTool: true });
  await waitFor(() => upstream.sent.some((f) => f.type === 'session.update'));
  assert.deepEqual(sessionSendProperties(upstream), ['message']);
  socket.close();
});

test('slim off: the full shape (message, session, waitSeconds, correlationId) is advertised as before', async () => {
  const { upstream, socket } = wire({ slimSendTool: false });
  await waitFor(() => upstream.sent.some((f) => f.type === 'session.update'));
  assert.deepEqual(sessionSendProperties(upstream), ['correlationId', 'message', 'session', 'waitSeconds']);
  socket.close();
});

test('the default is slim', async () => {
  const { upstream, socket } = wire({});
  await waitFor(() => upstream.sent.some((f) => f.type === 'session.update'));
  assert.deepEqual(sessionSendProperties(upstream), ['message']);
  socket.close();
});

test('slim: a call that still carries the retired fields is not rejected and is delivered once', async () => {
  const { upstream, socket, delivered } = wire({ slimSendTool: true });
  await waitFor(() => opened(socket));
  callSend(upstream, 'c1', { message: '带着旧字段。', waitSeconds: 5, correlationId: 'abc' });
  await waitFor(() => delivered.length === 1, 2_000);
  await sleep(50);
  assert.equal(delivered.length, 1);
  assert.equal(String(delivered[0]!.message), '带着旧字段。');
  assert.equal(
    socket.outbound.some((f) => f.type === 'error' && f.code === 'TOOL_ARGUMENT_SCHEMA_VIOLATION'),
    false,
    'a model that keeps writing the old fields must not be turned into a red error bar',
  );
  socket.close();
});

test('the descriptors: slim shrinks ONLY the voice-plane copy; the gateway mirror is untouched', () => {
  const full = voiceRealtimeToolsFor(false);
  const slim = voiceRealtimeToolsFor(true);
  assert.deepEqual(full.map((t) => t.name), slim.map((t) => t.name), 'same tools, same order');
  assert.deepEqual(full, VOICE_REALTIME_TOOLS, 'slim off IS the historical advertisement');
  const fullSend = full.find((t) => t.name === 'session_send')!;
  const slimSend = slim.find((t) => t.name === 'session_send')!;
  assert.deepEqual(Object.keys(slimSend.inputSchema), ['message']);
  assert.ok(slimSend.description.length < fullSend.description.length);
  // `session_interrupt` was not measured slim and must come through unchanged.
  assert.deepEqual(slim.find((t) => t.name === 'session_interrupt'), full.find((t) => t.name === 'session_interrupt'));
  // The AC-2 mirror still declares the gateway's fields.
  const mirror = REALTIME_TOOLS.find((t) => t.name === 'session_send')!;
  assert.ok('waitSeconds' in mirror.inputSchema && 'correlationId' in mirror.inputSchema && 'session' in mirror.inputSchema);
});

// ------------------------------------------------------- what actually reaches the upstream

const upstreamInstructions = (upstream: ReturnType<typeof createFakeDashscopeServer>): string => {
  const update = upstream.sent.find((f) => f.type === 'session.update') as { session: { instructions: string } };
  return update.session.instructions;
};

test('the silent prompt is what the upstream is told (it survives the settings composer)', async () => {
  const { upstream, socket } = wire({ closingTurn: 'silent', instructions: voiceRealtimeInstructionsFor('silent') });
  await waitFor(() => upstream.sent.some((f) => f.type === 'session.update'));
  const text = upstreamInstructions(upstream);
  assert.match(text, /Then say nothing more\./);
  assert.doesNotMatch(text, /single word OK/, 'the model must not be told to reply when it is given no turn to do it in');
  socket.close();
});

test('the respond prompt is what the upstream is told under the rollback', async () => {
  const { upstream, socket } = wire({ closingTurn: 'respond', instructions: voiceRealtimeInstructionsFor('respond') });
  await waitFor(() => upstream.sent.some((f) => f.type === 'session.update'));
  assert.match(upstreamInstructions(upstream), /Then reply with the single word OK and say nothing else\./);
  socket.close();
});
