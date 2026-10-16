/**
 * What a `session_send` sends for the span it answers for.
 *
 * THE SPAN GUARD THIS FILE WAS WRITTEN FOR IS GONE (ruling 2026-10-16, task
 * `gap-live-voice-one-text-per-segment-prefer-response`). It was written on journal `8fe60310` (live
 * 2026-10-15 23:02): the person said "涉及了Live Voice的这些修改。", paused, and went on with "可以确认是
 * 有很大的问题。"; the endpoint transcribed both and opened one response whose single `session_send`
 * carried only "我现在可以确认是有很大的问题。" — so the first sentence was captioned and reached
 * nothing. The guard read that as "the model left a sentence out", measured the two by
 * adjacent-character-pair overlap, and spliced the uncovered sentence in front of the model's message.
 *
 * WHY THE MEASURE COULD NOT DECIDE IT — the live round of 2026-10-16 13:20 (journal `3d2d3b2c`), both
 * cases read out: `transcription.completed "十月十五日，来望也，嗯，第一次考试。"` (the endpoint misheard
 * "LiveWire" as "来望也") and, 283 ms later IN THE SAME RESPONSE, `session_send {"message": "十月十五日，
 * LiveWire 第一次测试。"}` — the model repairing it off the AUDIO. Six of thirteen adjacent pairs in
 * common, share 0.462 < 0.5: a rewrite read as an omission, and the mishearing delivered in front of
 * the words that corrected it. A low pair share is what BOTH cases look like, and the text is the
 * thing under judgement, so no text-side test can arbitrate. The ruling fixes the shape instead: ONE
 * text per segment — the response when there is one, the transcript only when the segment drew no
 * response at all.
 *
 * These cases pin what is left: whatever share of the span the model's words cover, the delivery IS
 * those words, untouched; and the watermark keeps a sentence an earlier call already answered for from
 * being carried by the next call. The other arm — no response at all, so the person's own sentences
 * ARE delivered — is pinned by `voice-realtime-unclaimed-utterance-relay.test.ts`.
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

test('a call that carries only the last sentence delivers exactly that — no heard sentence is spliced in front', async () => {
  // The `8fe60310` walk, re-read under the 2026-10-16 ruling: the call IS the segment's response, so
  // what it carries is what goes, in the words the model chose. (Before the ruling this delivered
  // '涉及了Live Voice的这些修改。我现在可以确认是有很大的问题。' — the earlier sentence measured as
  // uncovered and put in front, which is the reading the 13:20 round showed to be a rewrite read as a
  // drop.)
  const { upstream, socket, delivered } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '涉及了Live Voice的这些修改。'));
  upstream.peerSend(transcribed('i2', '可以确认是有很大的问题。'));
  upstream.peerSend(sessionSend('call-1', '我现在可以确认是有很大的问题。'));
  await waitFor(() => delivered.length === 1, 1_500);
  await sleep(50);

  assert.deepEqual(delivered, ['我现在可以确认是有很大的问题。']);
  assert.equal(
    delivered.some((message) => message.includes('涉及了Live Voice的这些修改。')),
    false,
    'the sentence the endpoint transcribed is not put in front of the model’s message',
  );
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
