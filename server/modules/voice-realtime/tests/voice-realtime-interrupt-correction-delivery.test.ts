/**
 * An interrupt's correction is ONE delivery: it rides the interrupt-closing turn, and the words it
 * carries are not delivered a second time.
 *
 * Live reading 2026-10-15 23:32 (journal `259b51e0`, third test of the day). The person said a long
 * foreground operation was running, said "list the files" (queued in the CLI behind it), then said
 * "stop that operation". Two defects, both in `sessionInterrupt`'s correction path:
 *
 *   1. The correction was enqueued WITHOUT a priority, so the host fell back to its own `later` and
 *      the correction waited out a whole turn behind the `next`-priority message the busy hold had
 *      released a moment before — the person's "stop" arrived 16.8 s after the sentence it was
 *      meant to travel with. The busy hold's release already used `next`; the stop is the same
 *      relay's same words and has to ride the same tier.
 *   2. The correction was delivered through `deliverSessionSend`, which never touches the
 *      forwarding watermark, so the sentence it carried still read as "heard, never forwarded". The
 *      next model text reply (here: the one a teardown's forced `response.create` drew) delivered
 *      it verbatim a SECOND time, behind a note that described an interruption that had already
 *      been explained.
 *
 * The fix gives the correction the busy release's priority, and the delivery accounts for the span it
 * answered for so the sentence it carried is not delivered a second time.
 *
 * WHAT IT NO LONGER DOES (ruling 2026-10-16, task `gap-live-voice-one-text-per-segment-prefer-response`).
 * The correction briefly ran the `session_send` span guard too — a heard sentence whose
 * adjacent-character pairs the correction's words did not cover went in FRONT of it, verbatim (the
 * pair-overlap measure, landed 2026-10-16 for journal `259b51e0`). Both consumers of
 * that measure are deleted together: it cannot tell a rewrite from a drop, and the live round of
 * 2026-10-16 13:20 (`3d2d3b2c`) reads both out — the endpoint misheard "LiveWire" as "来望也", the
 * model repaired it from the audio in the same response, and the guard's 0.462 pair share put the
 * mishearing in front of the repair. An answered segment sends ONE text: the model's. The span is
 * still spent, so nothing the correction answered for comes back through the text-reply arm.
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

type RecordedSend = { message: string; priority: unknown };

function connect() {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const sends: RecordedSend[] = [];
  const order: string[] = [];
  const logs: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args) => {
      sends.push({ message: String(args.message ?? ''), priority: args.priority });
      order.push('send');
      return { runId: 'r', queued: true, queuedMessageUuid: `u${sends.length}` };
    },
    session_interrupt: async () => {
      order.push('abort');
      return { aborted: true };
    },
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: 'sk-test-not-a-real-key', socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: false,
    log: (line: string) => logs.push(line),
  });
  return { upstream, socket, sends, order, logs };
}

const transcribed = (itemId: string, transcript: string) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  transcript,
});

const interruptCall = (callId: string, message: string) => ({
  type: 'response.function_call_arguments.done',
  call_id: callId,
  name: 'session_interrupt',
  arguments: JSON.stringify({ message, intent: 'the person changed direction' }),
});

const isOpen = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

test("the interrupt's correction is enqueued at the busy release's `next` priority, before the abort", async () => {
  const { upstream, socket, sends, order } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '终止前面那个长的前台操作。'));
  upstream.peerSend(interruptCall('call-1', '终止前面那个长的前台操作。'));
  await waitFor(() => order.includes('abort'), 1_500);
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0]!.priority,
    'next',
    'without a priority the host falls back to `later` and the correction waits out a whole turn',
  );
  assert.deepEqual(order, ['send', 'abort'], 'the correction is enqueued before the abort');
  socket.close();
});

test('a later text reply does not deliver the sentence the interrupt already carried', async () => {
  const { upstream, socket, sends, order, logs } = connect();
  await waitFor(() => isOpen(socket));
  upstream.peerSend(transcribed('i1', '终止前面那个长的前台批处理操作。'));
  upstream.peerSend(interruptCall('call-1', '终止前面那个长的前台 bash 操作。'));
  // The abort follows the enqueue's confirmation AND the span's advance: waiting on the send alone
  // would let the text reply land inside the interrupt's own await, a race the live relay never has.
  await waitFor(() => order.includes('abort'), 1_500);
  upstream.peerSend({ type: 'response.text.done', text: '好的，已终止。' });
  // The relay's own delivery window is ~1 s; wait past it so a second send would have landed.
  await sleep(1_500);
  assert.equal(sends.length, 1, `delivered a second time: ${JSON.stringify(sends.map((s) => s.message))}\n${logs.filter((l) => /interrupt|relayed|verbatim|queued|session_send/.test(l)).join('\n')}`);
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'heard_not_forwarded'),
    true,
    'with nothing left to deliver the turn is the ordinary "heard, not forwarded"',
  );
  socket.close();
});

test('the correction carries the model’s words alone — a heard sentence it does not repeat is not spliced in front', async () => {
  const { upstream, socket, sends, order } = connect();
  await waitFor(() => isOpen(socket));
  const left = '先把数据库迁移脚本检查一遍再说。';
  const CORRECTION = '停下，改成跑一下 lint 检查。';
  upstream.peerSend(transcribed('i1', left));
  upstream.peerSend(transcribed('i2', CORRECTION));
  upstream.peerSend(interruptCall('call-1', CORRECTION));
  // The abort follows the enqueue's confirmation AND the span's advance: waiting on the send alone
  // would let the text reply land inside the interrupt's own await, a race the live relay never has.
  await waitFor(() => order.includes('abort'), 1_500);
  assert.equal(sends.length, 1, `one delivery: ${JSON.stringify(sends.map((send) => send.message))}`);
  const message = sends[0]!.message;
  // The interruption's aftermath note leads the delivery (`voice-realtime-interrupt-aftermath.test.ts`
  // pins that); what this case is about is the OTHER half the guard used to add.
  assert.ok(message.includes(CORRECTION), `the model’s correction is carried: ${message}`);
  assert.equal(
    message.includes(left),
    false,
    `an interrupt with a message is a response for the span: a heard sentence it does not repeat is not spliced in front: ${message}`,
  );
  // The span is spent with that one delivery, so the text-reply arm finds nothing unanswered — the
  // earlier sentence is not carried a second time, and the turn is the ordinary disposition.
  upstream.peerSend({ type: 'response.text.done', text: '好的。' });
  await sleep(1_500);
  assert.equal(sends.length, 1, 'the span was spent by the interrupt');
  assert.equal(
    socket.outbound.some((frame) => frame.type === 'heard_not_forwarded'),
    true,
    'with the span spent there is nothing left to deliver',
  );
  socket.close();
});
