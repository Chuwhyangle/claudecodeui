/**
 * Every finished sentence reaches the session (ruling 2026-10-14 "the model is a pen, not an agent").
 *
 * Live reading 2026-10-15 01:13 (connection b33412ea): the person said two sentences back to back,
 * the endpoint transcribed both, but never opened a response for either because the person kept
 * talking. The next response answered "No response requested." in text, so only that last turn got
 * a `heard_not_forwarded` and the two sentences before it reached neither the session nor the queue.
 *
 * The relay now owns the fallback: when the model ends a turn in text, the words transcribed since
 * the last relay that no `session_send` answered for are delivered verbatim through the same path a
 * model call takes. Only when there is nothing unanswered does the turn stay `heard_not_forwarded`.
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
}

function connect() {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const delivered: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      delivered.push(String(args.message ?? ''));
      return { runId: 'r', queued: false };
    },
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: 'sk-test-not-a-real-key', socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: false,
  });
  return { upstream, socket, delivered };
}

const transcribed = (itemId: string, transcript: string) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  transcript,
});

const isOpen = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

test('a text reply delivers the unanswered sentences verbatim, in spoken order, instead of setting them aside', async () => {
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '我刚才说，可能是Lost这东西闪了一下。'));
  upstream.peerSend(transcribed('i2', '然后，在这个消息出来之前，其实我已经点了mute蛮长时间了。'));
  upstream.peerSend({ type: 'response.text.done', text: 'No response requested.' });
  await waitFor(() => delivered.length === 1, 1_500);
  assert.equal(
    delivered[0],
    '我刚才说，可能是Lost这东西闪了一下。然后，在这个消息出来之前，其实我已经点了mute蛮长时间了。',
  );
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'heard_not_forwarded'),
    false,
    'words that were delivered are not "heard, not forwarded"',
  );
  socket.close();
});

test('sentences a session_send already answered for are not delivered a second time by a later text reply', async () => {
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '跑一下测试。'));
  upstream.peerSend({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    name: 'session_send',
    arguments: JSON.stringify({ message: '跑一下测试。' }),
  });
  await waitFor(() => delivered.length === 1, 1_500);
  upstream.peerSend({ type: 'response.text.done', text: 'No response requested.' });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'heard_not_forwarded'), 1_500);
  await sleep(50);
  assert.deepEqual(delivered, ['跑一下测试。']);
  socket.close();
});

test('an empty transcription alone is still "heard, not forwarded" — nothing to deliver', async () => {
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '。'));
  upstream.peerSend({ type: 'response.text.done', text: 'No response requested.' });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'heard_not_forwarded'), 1_500);
  await sleep(50);
  assert.deepEqual(delivered, []);
  socket.close();
});
