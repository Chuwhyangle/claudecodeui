/**
 * Live Voice is a STREAM: audio goes up continuously, events come back on their own schedule
 * and may stop coming. These cases pin the behaviours that only exist over time, stage by
 * stage, before any browser is involved (the integration layers are the HTTP diagnosis, the
 * e2e specs and the live-contract script; see docs/operations/voice-realtime-test-stages.md).
 *
 *   Stage B — the bridge over the REAL transport: stall detection and its bookkeeping.
 *   Stage P — the proxy over the REAL transport: ordering, redial mid-stream, teardown,
 *             and recovery from a truncated function call.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { connect, createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import { VOICE_REALTIME_TOOLS } from '../voice-realtime-tools.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const KEY = 'sk-test-not-a-real-key';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  audio(audio: string): void {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'audio', audio }), 'utf8'));
  }
}

const quietUpstream = () => createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });

// ------------------------------------------------------------------------------------------
// Stage B — bridge stall detection
// ------------------------------------------------------------------------------------------

async function bridgeOver(upstream: ReturnType<typeof createFakeDashscopeServer>, stallMs: number) {
  const errors: Array<{ code: string; seconds?: number }> = [];
  const transport = createDashscopeTransport({ apiKey: KEY, socketFactory: upstream.socketFactory });
  const bridge = connect(transport, VOICE_REALTIME_TOOLS, {}, {
    stallMs,
    hooks: { onError: (error) => errors.push(error as { code: string; seconds?: number }) },
  });
  await bridge.whenConnected();
  return { bridge, errors };
}

test('B1: speech announced and then silence is reported once as a stalled upstream', async () => {
  const upstream = quietUpstream();
  const { bridge, errors } = await bridgeOver(upstream, 80);
  upstream.peerSend({ type: 'input_audio_buffer.speech_started', item_id: 'i1' });
  await waitFor(() => errors.some((error) => error.code === 'UPSTREAM_STALLED'), 2_000);
  await sleep(200);
  assert.equal(errors.filter((error) => error.code === 'UPSTREAM_STALLED').length, 1, 'reported once, not on a loop');
  await bridge.close();
});

test('B2: an upstream that keeps talking is never reported as stalled, and a settled segment stops the clock', async () => {
  const upstream = quietUpstream();
  const { bridge, errors } = await bridgeOver(upstream, 120);
  upstream.peerSend({ type: 'input_audio_buffer.speech_started', item_id: 'i1' });
  // Progress every 60 ms for ~400 ms: each event re-arms the timer.
  for (let step = 0; step < 6; step += 1) {
    await sleep(60);
    upstream.peerSend({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', stash: 'x'.repeat(step + 1) });
  }
  upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'done' });
  await sleep(300);
  assert.equal(errors.some((error) => error.code === 'UPSTREAM_STALLED'), false);
  await bridge.close();
});

test('B3: closing the bridge cancels a pending stall report', async () => {
  const upstream = quietUpstream();
  const { bridge, errors } = await bridgeOver(upstream, 100);
  upstream.peerSend({ type: 'input_audio_buffer.speech_started', item_id: 'i1' });
  await bridge.close();
  await sleep(300);
  assert.equal(errors.some((error) => error.code === 'UPSTREAM_STALLED'), false);
});

// ------------------------------------------------------------------------------------------
// Stage P — proxy over the real transport
// ------------------------------------------------------------------------------------------

function proxyOver(upstream: ReturnType<typeof createFakeDashscopeServer>, executor: RealtimeToolExecutor, extra: Partial<VoiceRealtimeProxySeams> = {}) {
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) => createDashscopeTransport({ apiKey: KEY, socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    ...extra,
  });
  return socket;
}
const isOpen = (socket: FakeBrowserSocket): boolean => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');
const okExecutor = (calls: Array<Record<string, unknown>> = []): RealtimeToolExecutor => ({
  session_send: async (args: Record<string, unknown>) => {
    calls.push(args);
    return { runId: 'r', queued: false };
  },
});

test('P1: two utterances interleave on the wire; each keeps its own caption row and order of first appearance', async () => {
  const upstream = quietUpstream();
  const socket = proxyOver(upstream, okExecutor());
  await waitFor(() => isOpen(socket));
  const delta = (item: string, text: string) =>
    upstream.peerSend({ type: 'conversation.item.input_audio_transcription.delta', item_id: item, stash: text });
  delta('a', '把');
  delta('b', 'Louis');
  delta('a', '把 server');
  upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Louis T.S.' });
  upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '把 server。' });

  await waitFor(() => socket.outbound.filter((frame) => frame.type === 'caption').length === 5);
  const captions = socket.outbound.filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption');
  assert.deepEqual(
    captions.map((frame) => `${frame.itemId}:${frame.final ? 'F' : 'i'}:${frame.text}`),
    ['a:i:把', 'b:i:Louis', 'a:i:把 server', 'b:F:Louis T.S.', 'a:F:把 server。'],
    'frames are forwarded in arrival order with their item ids intact',
  );
  socket.close();
});

test('P2: the upstream dropping mid-stream is a recoverable hiccup — redial, session re-advertised, audio resumes', async () => {
  const upstream = quietUpstream();
  const socket = proxyOver(upstream, okExecutor());
  await waitFor(() => isOpen(socket));
  socket.audio('before-drop');
  await waitFor(() => upstream.sent.some((frame) => frame.audio === 'before-drop'));
  const updatesBefore = upstream.sent.filter((frame) => frame.type === 'session.update').length;

  upstream.drop();
  await waitFor(() => upstream.openCalls >= 2, 5_000);
  await waitFor(() => upstream.sent.filter((frame) => frame.type === 'session.update').length > updatesBefore, 5_000);
  const lost = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'CONNECTION_LOST');
  assert.ok(lost && lost.type === 'error');
  assert.equal(lost.recoverable, true, 'a drop the bridge is already redialling must not read as the end of the session');

  // The bridge reports `open` again, and audio spoken after it reaches the NEW socket.
  await waitFor(() => socket.outbound.filter((frame) => frame.type === 'state' && frame.state === 'open').length >= 2, 5_000);
  socket.audio('after-redial');
  await waitFor(() => upstream.sent.some((frame) => frame.audio === 'after-redial'));
  socket.close();
});

test('P3: a browser that leaves while an instruction waits on a busy session stops the retries', async () => {
  const upstream = quietUpstream();
  let attempts = 0;
  const executor: RealtimeToolExecutor = {
    session_send: async () => {
      attempts += 1;
      throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' });
    },
  };
  const socket = proxyOver(upstream, executor, { busyRetry: { intervalMs: 20, maxMs: 60_000 } });
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'c', name: 'session_send', arguments: JSON.stringify({ message: 'hi' }) });
  await waitFor(() => attempts >= 3);

  socket.close();
  await sleep(100);
  const settled = attempts;
  await sleep(200);
  assert.equal(attempts, settled, 'no retry may outlive the connection');
});

test('P4: a function call truncated by a barge-in is reported, and the NEXT call still runs', async () => {
  const upstream = quietUpstream();
  const calls: Array<Record<string, unknown>> = [];
  const socket = proxyOver(upstream, okExecutor(calls));
  await waitFor(() => isOpen(socket));

  // Observed live: a new utterance cancels the in-flight response and its arguments end mid-string.
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'cut', name: 'session_send', arguments: '{"message": "用户说“race.' });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'MALFORMED_FUNCTION_CALL'));
  const malformed = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'MALFORMED_FUNCTION_CALL');
  assert.ok(malformed && malformed.type === 'error' && malformed.recoverable === true);

  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'good', name: 'session_send', arguments: JSON.stringify({ message: 'the real one' }) });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0]!.message, 'the real one');
  socket.close();
});

test('P5: a stalled upstream reaches the browser as a recoverable notice', async () => {
  const upstream = quietUpstream();
  const socket = proxyOver(upstream, okExecutor(), { stallMs: 80 });
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'input_audio_buffer.speech_started', item_id: 'i1' });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'UPSTREAM_STALLED'), 2_000);
  const stalled = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'UPSTREAM_STALLED');
  assert.ok(stalled && stalled.type === 'error' && stalled.recoverable === true);
  socket.close();
});

test('P6: a text reply from the model is reported (it is never displayed), an empty text part is not', async () => {
  const upstream = quietUpstream();
  const socket = proxyOver(upstream, okExecutor());
  await waitFor(() => isOpen(socket));

  // A function-call response closes an EMPTY text part: that is not news.
  upstream.peerSend({ type: 'response.text.done', text: '' });
  await sleep(50);
  assert.equal(socket.outbound.some((frame) => frame.type === 'error'), false);

  // Observed live: the model answered a spoken question itself, in text nobody sees.
  upstream.peerSend({ type: 'response.text.done', text: '是的，我听到了。' });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'MODEL_TEXT_REPLY'));
  const note = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'MODEL_TEXT_REPLY');
  assert.ok(note && note.type === 'error' && note.recoverable === true);
  assert.match(note.message, /是的，我听到了/);
  socket.close();
});

test('P7: the shipped instructions relay everything and forbid answering', () => {
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /EVERYTHING the user says/);
  assert.match(VOICE_REALTIME_INSTRUCTIONS, /never reply in text/i);
  assert.doesNotMatch(VOICE_REALTIME_INSTRUCTIONS, /answer questions you can answer yourself/i);
});

test('P8: pieces relayed in one breath are delivered as ONE message, a later thought as another', async () => {
  const upstream = quietUpstream();
  const calls: Array<Record<string, unknown>> = [];
  const socket = proxyOver(upstream, okExecutor(calls), { coalesceMs: 150 });
  await waitFor(() => isOpen(socket));
  const say = (id: string, message: string) =>
    upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: id, name: 'session_send', arguments: JSON.stringify({ message }) });

  // Observed live, verbatim: one sentence, four relayed pieces.
  say('a', '这个逻辑不要放在前。');
  await sleep(40);
  say('b', '端。');
  await sleep(40);
  say('c', '放到 server。');
  await sleep(40);
  say('d', '那边去。');
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0]!.message, '这个逻辑不要放在前。端。放到 server。那边去。');

  // The model was told each was accepted, so it is never left waiting on a result.
  assert.equal(upstream.sent.filter((frame) => frame.type === 'conversation.item.create').length, 4);

  // A new thought after the pause is its own message.
  say('e', 'Change the timeout.');
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1]!.message, 'Change the timeout.');
  socket.close();
});

test('P9: captions keep the quiet window open while the person is still talking', async () => {
  const upstream = quietUpstream();
  const calls: Array<Record<string, unknown>> = [];
  const socket = proxyOver(upstream, okExecutor(calls), { coalesceMs: 200 });
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'a', name: 'session_send', arguments: JSON.stringify({ message: 'first' }) });
  // Speech continues (interim captions every 100 ms for 600 ms): nothing may be delivered yet.
  for (let step = 0; step < 6; step += 1) {
    await sleep(100);
    upstream.peerSend({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i', stash: 'x'.repeat(step + 1) });
  }
  assert.equal(calls.length, 0, 'still talking: not delivered');
  await waitFor(() => calls.length === 1);
  socket.close();
});

test('P10: ending the session right after speaking still delivers what was said', async () => {
  const upstream = quietUpstream();
  const calls: Array<Record<string, unknown>> = [];
  const socket = proxyOver(upstream, okExecutor(calls), { coalesceMs: 60_000 });
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'a', name: 'session_send', arguments: JSON.stringify({ message: 'last words' }) });
  await waitFor(() => upstream.sent.some((frame) => frame.type === 'conversation.item.create'));
  socket.close();
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0]!.message, 'last words');
});

test('P11: a model that re-calls the tool after every result is stopped, not left to burn tokens', async () => {
  // Observed live: 89 calls and ~300,000 input tokens in about a minute.
  const upstream = quietUpstream();
  const original = upstream.socketFactory;
  let responseCreates = 0;
  let n = 0;
  const loopingFactory: typeof original = (url, headers) => {
    const socket = original(url, headers);
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      send(data);
      if ((JSON.parse(data) as { type: string }).type !== 'response.create') return;
      responseCreates += 1;
      n += 1;
      // The model answers every result with the same call again.
      upstream.peerSend({
        type: 'response.function_call_arguments.done',
        call_id: `loop-${n}`,
        name: 'session_send',
        arguments: JSON.stringify({ message: '的超时改成三十秒。' }),
      });
    };
    return socket;
  };
  const calls: Array<Record<string, unknown>> = [];
  const socket = proxyOver({ ...upstream, socketFactory: loopingFactory } as typeof upstream, okExecutor(calls));
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'start', name: 'session_send', arguments: JSON.stringify({ message: '的超时改成三十秒。' }) });

  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'TOOL_LOOP_GUARD'), 5_000);
  const settled = responseCreates;
  await sleep(300);
  assert.equal(responseCreates, settled, 'once guarded, nothing asks the model to speak again');
  assert.ok(settled <= 8, `the loop was cut after ${settled} rounds`);
  const guard = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'TOOL_LOOP_GUARD');
  assert.ok(guard && guard.type === 'error' && guard.recoverable === true);
  socket.close();
});

test('P12: the tool result the model reads says the message is done and not to call again', async () => {
  const upstream = quietUpstream();
  const socket = proxyOver(upstream, okExecutor(), { coalesceMs: 50 });
  await waitFor(() => isOpen(socket));
  upstream.peerSend({ type: 'response.function_call_arguments.done', call_id: 'a', name: 'session_send', arguments: JSON.stringify({ message: 'x' }) });
  await waitFor(() => upstream.sent.some((frame) => frame.type === 'conversation.item.create'));
  const output = upstream.sent.find((frame) => frame.type === 'conversation.item.create') as { item: { output: string } };
  const text = String(output.item.output);
  assert.match(text, /Do not call session_send again/);
  assert.doesNotMatch(text, /will be delivered when the user stops speaking/);
  socket.close();
});
