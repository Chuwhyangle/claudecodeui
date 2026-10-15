/**
 * A `session_send` that leaves a heard sentence out does not make it disappear.
 *
 * Live reading 2026-10-15 23:02 (journal `8fe60310`): the person said "涉及了Live Voice的这些修改。",
 * paused, and went on with "可以确认是有很大的问题。". The endpoint transcribed both and opened one
 * response, whose single `session_send` carried only "我现在可以确认是有很大的问题。". The first sentence
 * was captioned on the page and delivered nowhere — no `heard_not_forwarded`, no queue entry. Two
 * sentences were lost that way in under a minute.
 *
 * The relay's net for a text reply (`voice-realtime-unclaimed-utterance-relay.test.ts`) did not cover a
 * call that DID happen. These cases pin that a call which leaves a heard sentence out carries that
 * sentence, verbatim and in front of the model's words, in the SAME delivery — and that a call which
 * covers everything is passed through untouched.
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

const sessionSend = (callId: string, message: string) => ({
  type: 'response.function_call_arguments.done',
  call_id: callId,
  name: 'session_send',
  arguments: JSON.stringify({ message }),
});

const isOpen = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

test('a call that carries only the last sentence also delivers the earlier one, verbatim and first', async () => {
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '涉及了Live Voice的这些修改。'));
  upstream.peerSend(transcribed('i2', '可以确认是有很大的问题。'));
  upstream.peerSend(sessionSend('call-1', '我现在可以确认是有很大的问题。'));
  await waitFor(() => delivered.length === 1, 1_500);
  await sleep(50);

  assert.deepEqual(delivered, ['涉及了Live Voice的这些修改。我现在可以确认是有很大的问题。']);
  socket.close();
});

test('a call whose words cover every heard sentence is delivered exactly as the model wrote it', async () => {
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '涉及了Live Voice的这些修改。'));
  upstream.peerSend(transcribed('i2', '可以确认是有很大的问题。'));
  upstream.peerSend(sessionSend('call-1', '涉及了 Live Voice 的这些修改，我现在可以确认是有很大的问题。'));
  await waitFor(() => delivered.length === 1, 1_500);
  await sleep(50);

  assert.deepEqual(delivered, ['涉及了 Live Voice 的这些修改，我现在可以确认是有很大的问题。']);
  socket.close();
});

test('a sentence an earlier call answered for is not added to the next call', async () => {
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '先跑一下测试。'));
  upstream.peerSend(sessionSend('call-1', '先跑一下测试。'));
  await waitFor(() => delivered.length === 1, 1_500);
  upstream.peerSend(transcribed('i2', '然后看一下日志。'));
  upstream.peerSend(sessionSend('call-2', '然后看一下日志。'));
  await waitFor(() => delivered.length === 2, 2_500);
  await sleep(50);

  assert.deepEqual(delivered, ['先跑一下测试。', '然后看一下日志。']);
  socket.close();
});
