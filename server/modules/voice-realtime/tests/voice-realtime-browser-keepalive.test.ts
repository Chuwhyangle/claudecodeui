/**
 * The browser leg is kept alive while the person is muted.
 *
 * Live reading 2026-10-15 01:09–01:12 (connection 86559798): Mute stopped every browser→server frame
 * and nothing flowed the other way either, so after ~2.5 min of silence the browser saw the socket
 * "closed by the server or network" while the server only noticed 28 s after the replacement had
 * opened. The relay now pings the browser socket on a fixed cadence (the browser answers each ping at
 * the protocol level), and a socket that missed a whole interval's pong is ended rather than left
 * half-open.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { handleVoiceRealtimeConnection, type RealtimeToolExecutor } from '../index.js';

import { createFakeTransport, waitFor } from './realtime-bridge-harness.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const KEEPALIVE_MS = 20;

class PingableBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  pings = 0;
  terminated = false;
  answersPings = true;
  send(): void {}
  ping(): void {
    this.pings += 1;
    if (this.answersPings) queueMicrotask(() => this.emit('pong'));
  }
  terminate(): void {
    this.terminated = true;
    this.close();
  }
  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
}

function open(socket: PingableBrowserSocket) {
  const transport = createFakeTransport();
  const executor: RealtimeToolExecutor = { session_send: async () => ({ runId: 'r', queued: false }) };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'keepalive instructions',
    browserKeepaliveMs: KEEPALIVE_MS,
  });
  return transport;
}

test('an idle browser socket is pinged every interval and stays open while it answers', async () => {
  const socket = new PingableBrowserSocket();
  open(socket);
  await waitFor(() => socket.pings >= 3, 1_000);
  assert.equal(socket.terminated, false);
  assert.equal(socket.readyState, WS.OPEN);
  socket.close();
});

test('a socket that stops answering pings is ended instead of left half-open', async () => {
  const socket = new PingableBrowserSocket();
  socket.answersPings = false;
  open(socket);
  await waitFor(() => socket.terminated, 1_000);
});

test('no ping is sent after the socket closed', async () => {
  const socket = new PingableBrowserSocket();
  open(socket);
  await waitFor(() => socket.pings >= 1, 1_000);
  socket.close();
  const after = socket.pings;
  await sleep(KEEPALIVE_MS * 5);
  assert.equal(socket.pings, after);
});
