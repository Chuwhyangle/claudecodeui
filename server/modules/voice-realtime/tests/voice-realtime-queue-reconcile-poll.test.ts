/**
 * The "waiting for Claude" card clears when the host dequeues, not at the next delivery.
 *
 * Live reading 2026-10-15 01:02 (connection 86559798): a delivered message the CLI still held was
 * drawn as the queue card (`queue_reconcile held=1`), the host took it up seconds later, and the card
 * stayed on screen for minutes — `queue_reconcile` was only pushed at a delivery result or a stop, so
 * nothing told the page until the person's next sentence was delivered. While the last reconcile the
 * page holds names a held command, the relay now re-reads the host each status window and pushes the
 * set again as soon as it moves.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  handleVoiceRealtimeConnection,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type VoiceRealtimeOutboundFrame,
} from '../index.js';

import { createFakeTransport, waitFor } from './realtime-bridge-harness.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOW_MS = 10;

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

type Reconcile = Extract<VoiceRealtimeOutboundFrame, { type: 'queue_reconcile' }>;
const reconciles = (socket: FakeBrowserSocket): Reconcile[] =>
  socket.outbound.filter((frame): frame is Reconcile => frame.type === 'queue_reconcile');

async function deliverOneHeldCommand() {
  const started: string[] = [];
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const executor: RealtimeToolExecutor = {
    session_send: async () => ({ ok: true, queued: true, runId: 'run-1', queuedMessageUuid: 'uuid-1' }),
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'queue-reconcile-poll instructions',
    statusRateMs: WINDOW_MS,
    hostCommandLifecycle: () => ({ started }),
  });
  await waitFor(() => transport.openCalls >= 1);
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'i1',
    transcript: '跑一下测试。',
  } as RealtimeServerMessage);
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId: 'call-1',
    arguments: JSON.stringify({ message: '跑一下测试。' }),
  } as RealtimeServerMessage);
  await waitFor(() => reconciles(socket).some((frame) => frame.queuedMessageUuids.includes('uuid-1')));
  return { socket, started };
}

test('a held command the host takes up clears from the page without another delivery', async () => {
  const { socket, started } = await deliverOneHeldCommand();
  started.push('uuid-1');
  await waitFor(() => {
    const all = reconciles(socket);
    return all.length > 0 && all[all.length - 1]!.queuedMessageUuids.length === 0;
  }, 1_000);
  socket.close();
});

test('an unchanged held set is not pushed again, and the watch stops once nothing is held', async () => {
  const { socket, started } = await deliverOneHeldCommand();
  const before = reconciles(socket).length;
  await sleep(WINDOW_MS * 10);
  assert.equal(reconciles(socket).length, before, 'no repeat while the host still holds the same command');
  started.push('uuid-1');
  await waitFor(() => reconciles(socket).length === before + 1, 1_000);
  await sleep(WINDOW_MS * 10);
  assert.equal(reconciles(socket).length, before + 1, 'nothing held ⇒ nothing more to watch');
  socket.close();
});
