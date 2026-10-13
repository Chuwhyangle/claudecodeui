/**
 * The conversation boundary a delivery reports — `sent.coveredThroughItemId`.
 *
 * WHY THIS EXISTS. The page decides which spoken sentences a delivery answers. It used to do that
 * by searching the delivery's MESSAGE for each sentence's text, which a model that rewords or omits
 * one of several sentences it answers in one call breaks — the 2026-10-13 journal (`af5559c0`) left
 * two captions on screen that could never be dismissed and dumped already-handled sentences into the
 * composer on leaving. The fix moves the question to the one the endpoint can actually answer: how
 * far the CONVERSATION had got when the instruction was relayed. Everything at or before that
 * boundary was in front of the model; the model disposed of it — relayed, reworded, or dropped on
 * purpose — and only speech committed later is still owed an answer.
 *
 * WHY A COMMIT AND NOT A TRANSCRIPT. The item enters the conversation when the endpoint commits it;
 * transcribing it is a separate, slower read of the same item. A page that waited for the transcript
 * would call a just-committed sentence "not yet seen" and leave its bubble up.
 *
 * WHAT THE LAST CASE PINS. A connection that has committed no speech has no boundary, and must say
 * so by OMISSION — an empty string would read as a boundary at the start of the conversation, which
 * is a claim this relay cannot make.
 *
 * Run:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-delivery-boundary.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { type RealtimeServerMessage, type RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

type Handler = typeof handleVoiceRealtimeConnection;
type SentFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }>;

/** The minimal `ws.WebSocket` surface the proxy uses, driven over an EventEmitter. */
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

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

const sentFrames = (socket: FakeBrowserSocket): SentFrame[] =>
  socket.outbound.filter((frame): frame is SentFrame => frame.type === 'sent');

/** Wires one continuous connection with a short coalescing window, so a delivery lands promptly. */
function wire(): { socket: FakeBrowserSocket; transport: FakeTransport } {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    coalesceMs: 50,
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<Handler>[0], 'session-under-test', seams);
  return { socket, transport };
}

async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** The endpoint ACCEPTING a commit: the moment the item enters the model's conversation. */
function commitItem(transport: FakeTransport, itemId: string): void {
  transport.peerSend({ type: 'input_audio_buffer.committed', item_id: itemId } as RealtimeServerMessage);
}

/** The model's relay, as the real wire reports it. */
function relay(transport: FakeTransport, callId: string, message: string): void {
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  } as RealtimeServerMessage);
}

/** Runs one delivery and returns the `sent` frame it produced. */
async function delivered(
  socket: FakeBrowserSocket,
  transport: FakeTransport,
  callId: string,
  message: string,
): Promise<SentFrame> {
  const before = sentFrames(socket).length;
  relay(transport, callId, message);
  await waitFor(() => sentFrames(socket).length > before);
  return sentFrames(socket)[sentFrames(socket).length - 1]!;
}

test('a delivery reports the last item the endpoint had committed', async () => {
  const { socket, transport } = wire();
  await open(socket, transport);

  commitItem(transport, 'item-A');
  const frame = await delivered(socket, transport, 'call-1', '第一句');

  assert.equal(frame.coveredThroughItemId, 'item-A');
});

test('the boundary FOLLOWS the conversation — a later commit moves it', async () => {
  const { socket, transport } = wire();
  await open(socket, transport);

  commitItem(transport, 'item-A');
  await delivered(socket, transport, 'call-1', '第一句');

  commitItem(transport, 'item-B');
  const second = await delivered(socket, transport, 'call-2', '第二句');

  assert.equal(second.coveredThroughItemId, 'item-B', 'the second delivery answers up to the second item');
});

test('an item the endpoint committed BY ITSELF still moves the boundary', async () => {
  const { socket, transport } = wire();
  await open(socket, transport);

  // No `seq` of ours: the endpoint's own detector created this item. It is the user's speech either
  // way, so a delivery that answers after it must report it — the alternative is a sentence that
  // never reaches the page's settled set and draws a bubble that cannot be dismissed.
  transport.peerSend({ type: 'input_audio_buffer.speech_started' } as RealtimeServerMessage);
  transport.peerSend({
    type: 'conversation.item.created',
    item: { id: 'item-endpoint', type: 'message', role: 'user' },
  } as RealtimeServerMessage);
  commitItem(transport, 'item-endpoint');
  const frame = await delivered(socket, transport, 'call-1', '说了什么');

  assert.equal(frame.coveredThroughItemId, 'item-endpoint');
});

test('a connection that has committed nothing reports NO boundary — by omission, not empty', async () => {
  const { socket, transport } = wire();
  await open(socket, transport);

  const frame = await delivered(socket, transport, 'call-1', '没有音频');

  assert.equal(
    'coveredThroughItemId' in frame,
    false,
    'an absent boundary is "this relay cannot say", which is not the same as one at the beginning',
  );
});
