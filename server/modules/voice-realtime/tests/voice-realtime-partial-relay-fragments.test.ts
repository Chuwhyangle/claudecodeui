/**
 * What a `session_send` sends for the span it answers for — the shipped "one text per segment" rule,
 * and the default-off A/B switch that brings the deleted span guard back.
 *
 * THE SHIPPED RULE (ruling 2026-10-16, task `gap-live-voice-one-text-per-segment-prefer-response`)
 * stands: what the model's call carries IS what goes, untouched; the transcript is delivered only
 * when the segment drew no response at all (`voice-realtime-unclaimed-utterance-relay.test.ts`).
 * These cases pin that default. The first was written for the ORIGINAL span guard on journal
 * `8fe60310` (live 2026-10-15 23:02): the person said "涉及了Live Voice的这些修改。", paused, and went
 * on with "可以确认是有很大的问题。"; the endpoint transcribed both and opened one response whose
 * single `session_send` carried only the second sentence. The guard spliced the first in front by
 * adjacent-character-pair overlap. It was removed when the 2026-10-16 13:20 round (journal
 * `3d2d3b2c`) showed that measure cannot tell a model's rewrite from a model's omission: the
 * endpoint misheard "LiveWire" as "来望也", the model repaired it from the audio, and the share
 * (6/13 = 0.462 < 0.5) delivered the mishearing in front of the correction.
 *
 * THE SWITCH (task `gap-live-voice-span-guard-flag`). `VOICE_REALTIME_SPAN_GUARD=on` restores that
 * guard for an A/B measurement: uncovered heard sentences, verbatim, in spoken order, in front of the
 * model's message — ONE delivery, never a second send. Default `off` is byte-for-byte the shipped
 * behaviour. The guard knowingly reproduces the `3d2d3b2c` duplicate when it is on; that is the arm
 * being measured, which is why the switch is opt-in.
 *
 * This file also carries the measure's own unit readings (`selectUncoveredFragments`) and the
 * resolver's four readings, so the switch's two arms and its default are provable without a server.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  createDashscopeTransport,
  resolveVoiceRealtimeSpanGuard,
  selectUncoveredFragments,
  VOICE_REALTIME_SPAN_GUARD_ENV,
  type RealtimeToolExecutor,
  type VoiceRealtimeProxySeams,
} from '../index.js';
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

function connect(options: { spanGuard?: boolean } = {}) {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const delivered: string[] = [];
  const logs: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      delivered.push(String(args.message ?? ''));
      return { runId: 'r', queued: false };
    },
  };
  const socket = new FakeBrowserSocket();
  const seams: VoiceRealtimeProxySeams = {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: 'sk-test-not-a-real-key', socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    // THE CONTINUOUS WIRE, PINNED: the span guard lives on the continuous path, and a segmented
    // environment would route these calls through the seq-keyed relay instead.
    segmentedRelay: false,
    log: (line) => logs.push(line),
    ...(options.spanGuard === undefined ? {} : { spanGuard: options.spanGuard }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'bound',
    seams,
  );
  return { upstream, socket, delivered, logs };
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

// The live round's two lost sentences, verbatim (journal `764f0c7a`, 2026-10-17): the model's call
// answered for the last thing it heard and these two reached nothing.
const LOST_ONE = '让我们讨论Live Voice的进一步改进及语音输出。';
const LOST_TWO = '它应当具有更好的实时性。';
/** What the model said when it answered only the tail — a sentence sharing no pair with either. */
const MODEL_REPLY = '我已经记下了。';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — the measure and the resolver, unit-level.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC1: selectUncoveredFragments names the heard sentence the message does not cover', () => {
  const heard = [LOST_ONE, LOST_TWO];

  // The live-round shape: the model answered only the second sentence, so the first is reported —
  // verbatim and in spoken order, which is what the switch prepends.
  assert.deepEqual(selectUncoveredFragments(heard, LOST_TWO), [LOST_ONE]);
  // A message that covers both reports neither: the overlap measure is not equality.
  assert.deepEqual(selectUncoveredFragments(heard, `${LOST_ONE}${LOST_TWO}`), []);
  // Under the five-word-character floor a fragment is a filler or a mishearing, never a drop.
  assert.deepEqual(selectUncoveredFragments(['好的。'], MODEL_REPLY), []);
});

test('AC1: resolveVoiceRealtimeSpanGuard reads on / off / unset / misspelt', () => {
  assert.deepEqual(resolveVoiceRealtimeSpanGuard({ [VOICE_REALTIME_SPAN_GUARD_ENV]: 'on' }), {
    spanGuard: true,
    invalid: null,
  });
  assert.deepEqual(resolveVoiceRealtimeSpanGuard({ [VOICE_REALTIME_SPAN_GUARD_ENV]: 'off' }), {
    spanGuard: false,
    invalid: null,
  });
  // Unset and empty are the shipped default: OFF.
  assert.deepEqual(resolveVoiceRealtimeSpanGuard({}), { spanGuard: false, invalid: null });
  assert.deepEqual(resolveVoiceRealtimeSpanGuard({ [VOICE_REALTIME_SPAN_GUARD_ENV]: '  ' }), {
    spanGuard: false,
    invalid: null,
  });
  // A misspelling must not silently turn the A/B arm on; it resolves OFF and names the offending value.
  assert.deepEqual(resolveVoiceRealtimeSpanGuard({ [VOICE_REALTIME_SPAN_GUARD_ENV]: 'true' }), {
    spanGuard: false,
    invalid: 'true',
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — flag off (and absent) is the shipped behaviour: the model's words, and nothing else.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC2: flag off — a call that carries only the last sentence delivers exactly that, with no prepend', async () => {
  // The `8fe60310` walk under the 2026-10-16 ruling: the call IS the segment's response, so what it
  // carries is what goes, in the words the model chose. The switch is EXPLICITLY off here — the
  // default is pinned by the cases that pass no seam at all.
  const { upstream, socket, delivered, logs } = connect({ spanGuard: false });
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
  assert.equal(
    logs.some((line) => line.includes('delivered verbatim in front')),
    false,
    'the span guard’s prepend never ran with the flag off',
  );
  socket.close();
});

test('AC2: no seam at all — the shipped default is off', async () => {
  const { upstream, socket, delivered, logs } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', LOST_ONE));
  upstream.peerSend(transcribed('i2', LOST_TWO));
  upstream.peerSend(sessionSend('call-1', MODEL_REPLY));
  await waitFor(() => delivered.length === 1, 1_500);
  await sleep(50);

  assert.deepEqual(delivered, [MODEL_REPLY]);
  assert.equal(logs.some((line) => line.includes('delivered verbatim in front')), false);
  socket.close();
});

test('AC2: a call whose words cover every heard sentence is delivered exactly as the model wrote it', async () => {
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

test('AC2: a sentence an earlier call answered for is not added to the next call', async () => {
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — flag on: the uncovered heard sentences are prepended, in ONE delivery.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC3: flag on — uncovered heard sentences go verbatim in front of the model’s message, as one send', async () => {
  const { upstream, socket, delivered, logs } = connect({ spanGuard: true });
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', LOST_ONE));
  upstream.peerSend(transcribed('i2', LOST_TWO));
  upstream.peerSend(sessionSend('call-1', MODEL_REPLY));
  await waitFor(() => delivered.length === 1, 1_500);
  await sleep(50);

  // ONE send — the heard sentences and the model's words are one message, never two racing sends.
  assert.equal(delivered.length, 1, 'exactly one session_send delivery');
  assert.deepEqual(delivered, [`${LOST_ONE}${LOST_TWO}${MODEL_REPLY}`]);
  const prependLines = logs.filter((line) => line.includes('session_send left '));
  assert.equal(prependLines.length, 1, 'the journal records the prepend exactly once');
  assert.match(prependLines[0] ?? '', /session_send left 2 heard sentence\(s\) out; delivered verbatim in front of it:/);
  socket.close();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — the empty-span refusal still comes first with the flag on.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC4: flag on — an entirely empty span is still refused and injects nothing', async () => {
  const { upstream, socket, delivered, logs } = connect({ spanGuard: true });
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', ''));
  upstream.peerSend(transcribed('i2', '   '));
  upstream.peerSend(sessionSend('call-1', MODEL_REPLY));
  await waitFor(() => logs.some((line) => line.includes('empty-transcript')), 1_500);
  await sleep(50);

  assert.deepEqual(delivered, [], 'nothing reaches the session for a span the endpoint reported no words for');
  assert.equal(
    logs.some((line) => line.includes('session_send left ')),
    false,
    'the guard does not treat an empty span as recoverable text',
  );
  assert.equal(
    logs.filter((line) => line.includes('session_send not-delivered (empty-transcript)')).length,
    1,
    'the refusal is recorded on the same journal line the empty-transcript guard always used',
  );
  socket.close();
});
