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
 * The fix gives the correction the busy release's priority and makes the delivery account for the
 * heard sentences exactly as a `session_send` does: sentences the correction's words do not cover go
 * in front of it verbatim (the same span guard), and the span is then spent.
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

test('a heard sentence the correction does not cover goes in front of it verbatim, once', async () => {
  const { upstream, socket, sends, order, logs } = connect();
  await waitFor(() => isOpen(socket));
  const left = '先把数据库迁移脚本检查一遍再说。';
  upstream.peerSend(transcribed('i1', left));
  upstream.peerSend(transcribed('i2', '算了停下，改成跑一下 lint 检查。'));
  upstream.peerSend(interruptCall('call-1', '停下，改成跑一下 lint 检查。'));
  // The abort follows the enqueue's confirmation AND the span's advance: waiting on the send alone
  // would let the text reply land inside the interrupt's own await, a race the live relay never has.
  await waitFor(() => order.includes('abort'), 1_500);
  const message = sends[0]!.message;
  assert.ok(message.includes(left), `the uncovered sentence is carried: ${message}`);
  assert.ok(
    message.indexOf(left) < message.indexOf('改成跑一下 lint'),
    'in spoken order: the earlier sentence first',
  );
  upstream.peerSend({ type: 'response.text.done', text: '好的。' });
  await sleep(1_500);
  assert.equal(sends.length, 1, 'the span was spent by the interrupt');
  socket.close();
});
