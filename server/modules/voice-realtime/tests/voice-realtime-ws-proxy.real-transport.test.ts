/**
 * The `/voice-realtime` proxy driven over the REAL DashScope transport.
 *
 * WHY THIS FILE EXISTS. `voice-realtime-ws-proxy.protocol-simulation.test.ts` stands a
 * fake `RealtimeTransport` in for the upstream, so everything the real transport does
 * to a frame — validating a function call's arguments against the tool schema it
 * advertised, building the `session.update` body, routing its own errors — is invisible
 * to it. Three shipped defects lived exactly there, and each presented to the user as
 * "it heard me but never answered":
 *
 *   1. `session_send`'s advertised schema required a `session` argument while the
 *      instructions told the model never to name one. The model obeyed the instructions,
 *      the real transport rejected the call (`TOOL_ARGUMENT_SCHEMA_VIOLATION`), and
 *      nothing ran.
 *   2. That rejection went nowhere: the proxy never handed the transport an `onError`,
 *      so the browser saw "Listening…" forever.
 *   3. `session.update` carried no `voice`, and the adopted model rejects the endpoint's
 *      default (`Chelsie`) the moment a response is created.
 *
 * Fully offline: the upstream is `createFakeDashscopeServer`, the browser is an
 * in-process EventEmitter.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeOutboundFrame,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const TEST_KEY = 'sk-test-not-a-real-key';
const BOUND_SESSION = 'session-under-test';

/** The slice of the browser socket the proxy touches. */
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

function wire(): {
  socket: FakeBrowserSocket;
  upstream: ReturnType<typeof createFakeDashscopeServer>;
  calls: Array<Record<string, unknown>>;
} {
  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const calls: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { runId: 'run-1', queued: false };
    },
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    // Same construction as the composition root: the REAL transport over a fake socket.
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
  });
  return { socket, upstream, calls };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

test('a model session_send that names no session — exactly as the instructions tell it to — runs against the bound session', async () => {
  const { socket, upstream, calls } = wire();
  await waitFor(() => opened(socket));

  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'call_1',
    name: 'session_send',
    arguments: JSON.stringify({ message: '把超时改成三十秒' }),
  });

  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].message, '把超时改成三十秒');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'sent'));
  const sentFrame = socket.outbound.find((frame) => frame.type === 'sent');
  assert.ok(sentFrame && sentFrame.type === 'sent');
  assert.equal(sentFrame.message, '把超时改成三十秒', 'the browser is told WHICH text was delivered');
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'error'),
    false,
    'a call that follows the instructions must not be reported as an error',
  );
  socket.close();
});

test('a function call the real transport rejects is reported to the browser, not swallowed', async () => {
  const { socket, upstream, calls } = wire();
  await waitFor(() => opened(socket));

  // `message` is required by the schema; this is a genuinely malformed call.
  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'call_bad',
    name: 'session_send',
    arguments: JSON.stringify({}),
  });

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  const error = socket.outbound.find((frame) => frame.type === 'error');
  assert.ok(error && error.type === 'error');
  assert.equal(error.code, 'TOOL_ARGUMENT_SCHEMA_VIOLATION');
  assert.equal(error.recoverable, true, 'a bad model call spoils one turn; it must not end the session');
  assert.match(error.message, /message/, 'the message must name the offending argument');
  assert.equal(calls.length, 0, 'a rejected call must not reach the executor');
  socket.close();
});

test('an upstream failure that ends the connection is NOT marked recoverable', async () => {
  const { socket, upstream } = wire();
  await waitFor(() => opened(socket));

  upstream.peerSendRaw('{ this is not json');
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  const error = socket.outbound.find((frame) => frame.type === 'error');
  assert.ok(error && error.type === 'error');
  assert.equal(error.recoverable, undefined);
  socket.close();
});

test('session.update on the wire names an explicit voice (the adopted model rejects the endpoint default)', async () => {
  const { socket, upstream } = wire();
  await waitFor(() => opened(socket));
  await waitFor(() => upstream.sent.some((frame) => frame.type === 'session.update'));

  const update = upstream.sent.find((frame) => frame.type === 'session.update') as { session: Record<string, unknown> };
  assert.equal(update.session.voice, 'Tina');
  assert.equal(typeof update.session.instructions, 'string');
  socket.close();
});

test('a segment the endpoint could not transcribe is a recoverable report, not a fatal unknown event', async () => {
  const { socket, upstream } = wire();
  await waitFor(() => opened(socket));

  // Observed live: the endpoint interleaves this with a working session.
  upstream.peerSend({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item_1',
    error: { message: 'audio too short' },
  });

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  const error = socket.outbound.find((frame) => frame.type === 'error');
  assert.ok(error && error.type === 'error');
  assert.equal(error.code, 'TRANSCRIPTION_FAILED');
  assert.equal(error.recoverable, true);
  assert.match(error.message, /audio too short/);
  socket.close();
});

test("the endpoint's own error event is reported with ITS message, not as an unhandled type", async () => {
  const { socket, upstream } = wire();
  await waitFor(() => opened(socket));

  upstream.peerSend({
    type: 'error',
    error: { code: 'InternalError.Algo.InvalidParameter', message: "Voice 'Chelsie' is not supported." },
  });

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  const error = socket.outbound.find((frame) => frame.type === 'error');
  assert.ok(error && error.type === 'error');
  assert.equal(error.code, 'UPSTREAM_ERROR');
  assert.match(error.message, /Chelsie/);
  socket.close();
});

test('a session that is mid-turn is waited for, announced once, and the instruction is delivered when it frees up', async () => {
  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  let attempts = 0;
  const delivered: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      attempts += 1;
      if (attempts <= 3) {
        // Exactly what the MCP gateway throws for a run in progress.
        throw Object.assign(new Error('Session already has a run in progress.'), { code: 'SESSION_BUSY' });
      }
      delivered.push(args);
      return { runId: 'run-1', queued: false };
    },
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    busyRetry: { intervalMs: 10, maxMs: 5_000 },
  });
  await waitFor(() => opened(socket));

  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'call_busy',
    name: 'session_send',
    arguments: JSON.stringify({ message: 'after you finish' }),
  });

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'sent'));
  assert.equal(attempts, 4, 'it retried until the session freed up');
  assert.deepEqual(delivered.map((args) => args.message), ['after you finish']);
  const busyNotices = socket.outbound.filter((frame) => frame.type === 'error' && frame.code === 'SESSION_BUSY');
  assert.equal(busyNotices.length, 1, 'the user is told once, not on every retry');
  assert.equal(busyNotices[0]!.type === 'error' && busyNotices[0]!.recoverable, true);
  socket.close();
});

test('a session that stays busy past the limit is reported as a failure, not waited on forever', async () => {
  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const executor: RealtimeToolExecutor = {
    session_send: async () => {
      throw Object.assign(new Error('Session already has a run in progress.'), { code: 'SESSION_BUSY' });
    },
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    busyRetry: { intervalMs: 10, maxMs: 100 },
  });
  await waitFor(() => opened(socket));
  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'call_busy2',
    name: 'session_send',
    arguments: JSON.stringify({ message: 'never lands' }),
  });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'TOOL_EXECUTION_FAILED'), 3_000);
  assert.equal(socket.outbound.some((frame) => frame.type === 'sent'), false);
  socket.close();
});

test('what is said while an instruction waits on a busy session joins it: one delivery, in order', async () => {
  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  let attempts = 0;
  const delivered: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      attempts += 1;
      if (attempts <= 5) {
        throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' });
      }
      delivered.push(String(args.message));
      return { runId: 'run-1', queued: false };
    },
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    busyRetry: { intervalMs: 30, maxMs: 5_000 },
  });
  await waitFor(() => opened(socket));

  const call = (id: string, message: string): void =>
    upstream.peerSend({
      type: 'response.function_call_arguments.done',
      call_id: id,
      name: 'session_send',
      arguments: JSON.stringify({ message }),
    });
  call('c1', 'first half');
  await waitFor(() => attempts >= 2);
  call('c2', 'the whole sentence');

  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered, ['first half the whole sentence']);
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'TOOL_EXECUTION_FAILED'),
    false,
    'the second call must not be reported as a failure',
  );
  socket.close();
});

test('a call delivered twice that the schema rejects is reported ONCE', async () => {
  const { socket, upstream } = wire();
  await waitFor(() => opened(socket));
  const args = JSON.stringify({ message: 42 });
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'dup', name: 'session_send', arguments: args });
  upstream.peerSend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'dup', name: 'session_send', arguments: args } });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(socket.outbound.filter((frame) => frame.type === 'error').length, 1);
  socket.close();
});

test('a number written as a string ("120") is accepted as the number it is, and reaches the tool as one', async () => {
  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const seen: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      seen.push(args);
      return { ok: true };
    },
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    // This is about coercion of a field the FULL `session_send` declares. The slim shape (the shipped
    // default) no longer advertises `waitSeconds`, so the coercion has nothing to act on there — see
    // `voice-realtime-closing-turn.test.ts` for the slim shape's own contract.
    slimSendTool: false,
  });
  await waitFor(() => opened(socket));
  // The shape the model really produced (there it was run_get's waitSeconds; session_send has the same field).
  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'ws1',
    name: 'session_send',
    arguments: JSON.stringify({ message: 'hi', waitSeconds: '120' }),
  });
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0]!.waitSeconds, 120);
  assert.equal(socket.outbound.some((frame) => frame.type === 'error'), false);

  // A string that is not a number is still refused.
  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'ws2',
    name: 'session_send',
    arguments: JSON.stringify({ message: 'hi', waitSeconds: 'soon' }),
  });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'TOOL_ARGUMENT_SCHEMA_VIOLATION'));
  socket.close();
});

test('the voice plane advertises session_send and session_interrupt, with their session optional', async () => {
  const { socket, upstream } = wire();
  await waitFor(() => opened(socket));
  await waitFor(() => upstream.sent.some((frame) => frame.type === 'session.update'));
  const update = upstream.sent.find((frame) => frame.type === 'session.update') as { session: { tools: Array<{ function: { name: string; parameters: { required?: string[] } } }> } };
  assert.deepEqual(update.session.tools.map((tool) => tool.function.name), ['session_send', 'session_interrupt']);
  assert.ok(
    update.session.tools.every((tool) => tool.function.name !== 'session_status'),
    'session_status is withdrawn from the advertisement (2026-10-14 ruling)',
  );
  assert.ok(update.session.tools.every((tool) => !(tool.function.parameters.required ?? []).includes('session')), 'every advertised tool takes `session` as optional');
  socket.close();
});

test('a relay does not ask the model to speak again after a delivery, but the result is still written', async () => {
  for (const respond of [false, true]) {
    const socket = new FakeBrowserSocket();
    const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
    handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
      createTransport: (report) =>
        createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report, respondToToolOutputs: respond }),
      createExecutor: () => ({ session_send: async () => ({ runId: 'r' }) }),
      instructions: VOICE_REALTIME_INSTRUCTIONS,
    });
    await waitFor(() => opened(socket));
    upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: `c-${respond}`, name: 'session_send', arguments: JSON.stringify({ message: 'x' }) });
    await waitFor(() => upstream.sent.some((frame) => frame.type === 'conversation.item.create'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      upstream.sent.filter((frame) => frame.type === 'response.create').length,
      respond ? 1 : 0,
      `respondToToolOutputs=${respond}`,
    );
    socket.close();
  }
});
