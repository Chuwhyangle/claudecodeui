/**
 * The ONE merged pending message — Live Voice queues as a single bubble (ruling 2026-10-14).
 *
 * WHAT THIS FILE PINS. Until this ruling a sentence spoken while Claude was busy became a command in
 * the CLI's own queue the moment the relay model passed it on, and the CLI merged those commands only
 * at the turn boundary — so the page drew one row per sentence and the person watched a stack of them
 * (the 2026-10-14 morning reading: two registries disagreeing and a row that would not go away). Under
 * this ruling the merge happens one layer EARLIER, in the relay: while the bound session reports a run
 * in flight, every relayed piece joins the SAME buffer, nothing reaches the CLI, and the whole thing
 * goes in as ONE message when the run ends. The browser is told what the buffer says through a
 * `pending` frame and draws ONE read-only card for it.
 *
 * WHAT IS DRIVEN. `handleVoiceRealtimeConnection` — the real proxy — over the fake browser socket and
 * fake transport the other continuous-mode criteria use, with the SCRIPTED CLI HOST behind the
 * executor so a delivery is a real command in a real queue. The only hand-built seam is
 * `hostRunActivity`, whose `busy` field is the host's one answer to "is a turn in flight"; a test
 * flips it to end the run.
 *
 *   · AC1(a) — busy: three relayed pieces are held (0 deliveries), the last `pending` frame carries
 *     all three in speaking order, and the moment the run ends they arrive as EXACTLY ONE message.
 *   · AC1(b) — busy with words held, a `session_interrupt` carrying a correction enqueues EXACTLY ONE
 *     message before the abort, and that message carries, in order: the interrupt note, the held
 *     words, the correction. The delivery AFTER the stop must NOT repeat the note.
 *   · AC1(c) — the hold is bounded: a piece that would overrun {@link VOICE_QUEUE_MAX_BYTES} is
 *     refused (`refused` frame), and the buffer is left exactly as it was.
 *   · AC1(d) — the connection closing with words held delivers them once, not zero and not twice.
 *   · AC1(e) — an IDLE sentence keeps the old behaviour: one delivery after the coalescing window,
 *     and no `pending` frame at all (the hold is a busy-session thing).
 *
 * Run:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { type RealtimeServerMessage, type RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_QUEUE_MAX_BYTES,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import { createScriptedCliHost } from './voice-realtime-scripted-cli-host.js';

type Handler = typeof handleVoiceRealtimeConnection;
type PendingFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'pending' }>;
type RefusedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'refused' }>;

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

const framesOf = <T extends VoiceRealtimeOutboundFrame>(socket: FakeBrowserSocket, type: T['type']): T[] =>
  socket.outbound.filter((frame): frame is T => frame.type === type);

type Harness = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  /** Every message the base executor was actually reached with, in order — the deliveries. */
  deliveries: string[];
  /** `session_send` / `session_interrupt` reaches, in one ordered list so "before the abort" is readable. */
  events: string[];
  aborts: () => number;
  setBusy: (busy: boolean) => void;
};

/**
 * One continuous connection, with a short coalescing window and a short hold poll so both waits are
 * observable in milliseconds. The scripted CLI host sits behind the executor, so a delivery is a real
 * command in its queue and its `command_lifecycle` is real.
 */
function wire(options: { coalesceMs?: number; maxQueuedVoiceBytes?: number } = {}): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const host = createScriptedCliHost();
  const deliveries: string[] = [];
  const events: string[] = [];
  let busy = false;
  let aborts = 0;
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      const message = typeof args.message === 'string' ? args.message : '';
      deliveries.push(message);
      events.push(`send:${message}`);
      return host.accept(message);
    },
    session_interrupt: async () => {
      aborts += 1;
      events.push('interrupt');
      return host.abort();
    },
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    coalesceMs: options.coalesceMs ?? 20,
    busyPollMs: 5,
    ...(options.maxQueuedVoiceBytes === undefined ? {} : { maxQueuedVoiceBytes: options.maxQueuedVoiceBytes }),
    // The host's ONE answer to "is a turn in flight". `runActivity` supplies the tool half (no turn is
    // open here, so it is always the tool-free form); the busy flag is what a test flips.
    hostRunActivity: () => ({ ...host.runActivity(), busy }),
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<Handler>[0], 'session-under-test', seams);
  return { socket, transport, deliveries, events, aborts: () => aborts, setBusy: (next) => (busy = next) };
}

async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** One relayed instruction, as the real wire reports it. */
function relay(transport: FakeTransport, callId: string, message: string): void {
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  } as RealtimeServerMessage);
}

/** One model-initiated stop, optionally carrying the corrected instruction (G1's `message`). */
function relayInterrupt(transport: FakeTransport, callId: string, args: Record<string, unknown>): void {
  transport.peerSend({
    type: 'function_call',
    name: 'session_interrupt',
    callId,
    arguments: JSON.stringify(args),
  } as RealtimeServerMessage);
}

/** Assert `needles` are present and appear in this order in `text`. */
function assertInOrder(text: string, needles: readonly string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    assert.ok(at !== -1, `expected ${JSON.stringify(text)} to contain ${JSON.stringify(needle)}`);
    assert.ok(at > cursor, `expected ${JSON.stringify(needle)} to come after the previous piece in ${JSON.stringify(text)}`);
    cursor = at;
  }
}

test('AC1(a): a busy session holds every relayed piece and delivers them as ONE message when the run ends', async () => {
  const h = wire();
  await open(h.socket, h.transport);
  h.setBusy(true);

  for (const [index, piece] of ['alpha', 'beta', 'gamma'].entries()) {
    relay(h.transport, `call-${index}`, piece);
    await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === index + 1);
  }

  // The whole point: three sentences spoke, and NONE of them reached the session.
  assert.deepEqual(h.deliveries, [], 'a busy session must not take a per-sentence delivery');

  const pending = framesOf<PendingFrame>(h.socket, 'pending');
  assert.equal(pending.length, 3, 'one frame per change to the held message');
  const last = pending[pending.length - 1]!;
  assert.ok(last.text.includes('alpha') && last.text.includes('beta') && last.text.includes('gamma'));
  assertInOrder(last.text, ['alpha', 'beta', 'gamma']);
  assert.equal(last.bytes, Buffer.byteLength(last.text, 'utf8'), 'the byte reading is the held text\'s own length');

  // The run ends. The hold poll sees it and the WHOLE thing goes in as one message.
  h.setBusy(false);
  await waitFor(() => h.deliveries.length === 1);

  assert.equal(h.deliveries.length, 1, 'the held pieces arrive as EXACTLY one message');
  assertInOrder(h.deliveries[0]!, ['alpha', 'beta', 'gamma']);
  const cleared = framesOf<PendingFrame>(h.socket, 'pending').at(-1)!;
  assert.equal(cleared.text, '', 'delivering the hold takes the card down');
});

test('AC1(b): a stop folds the held words, the correction and the note into ONE message, enqueued before the abort', async () => {
  const h = wire();
  await open(h.socket, h.transport);
  h.setBusy(true);

  relay(h.transport, 'call-held', 'the held words');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 1);
  // `[] as string[]` rather than a bare `[]`: `assert.deepEqual` is declared as `asserts actual is T`,
  // so a bare `[]` would infer `never[]` and narrow `h.deliveries` to it for the rest of the test.
  assert.deepEqual(h.deliveries, [] as string[], 'the held words are not delivered yet');

  relayInterrupt(h.transport, 'call-stop', { intent: 'the user corrected themselves', message: 'do this instead' });
  await waitFor(() => h.aborts() === 1);

  // ENQUEUE-THEN-ABORT, still one message: exactly one send reach, and it was before the stop.
  assert.equal(h.events.length, 2, 'exactly one delivery and one stop');
  assert.ok(h.events[0]!.startsWith('send:'), 'the correction is enqueued BEFORE the abort');
  assert.equal(h.events[1], 'interrupt');
  assert.equal(h.deliveries.length, 1);

  const body = h.deliveries[0]!;
  assert.ok(body.includes('interrupted'), 'the message carries an interruption note');
  assertInOrder(body, ['interrupted', 'the held words', 'do this instead']);

  // The note was spent ON this message: the next ordinary delivery must not repeat it.
  h.setBusy(false);
  relay(h.transport, 'call-next', 'next sentence');
  await waitFor(() => h.deliveries.length === 2);
  assert.ok(
    !h.deliveries[1]!.includes('interrupted'),
    `the note must not be deferred onto the next message, got ${JSON.stringify(h.deliveries[1])}`,
  );
});

test('AC1(c): a piece that would overrun the budget is refused and the held message is left alone', async () => {
  const h = wire({ maxQueuedVoiceBytes: 20 });
  await open(h.socket, h.transport);
  h.setBusy(true);

  relay(h.transport, 'call-small', 'fits');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 1);
  const held = framesOf<PendingFrame>(h.socket, 'pending')[0]!;

  // 200 characters of ASCII is far past the 20-byte budget this connection admits by.
  relay(h.transport, 'call-huge', 'x'.repeat(200));
  await waitFor(() => framesOf<RefusedFrame>(h.socket, 'refused').length === 1);

  const refused = framesOf<RefusedFrame>(h.socket, 'refused')[0]!;
  assert.equal(refused.reason, 'queue-full');
  assert.ok(refused.bytes > 20, 'the refusal names the byte total it happened at');

  const pending = framesOf<PendingFrame>(h.socket, 'pending');
  assert.equal(pending.length, 1, 'a refused piece is not added, so no `pending` frame follows it');
  assert.equal(pending[0]!.text, held.text, 'the held message is unchanged');
  assert.deepEqual(h.deliveries, [], 'a refused piece never reaches the session');
});

test('AC1(d): closing the connection with words held delivers them exactly once', async () => {
  const h = wire();
  await open(h.socket, h.transport);
  h.setBusy(true);

  relay(h.transport, 'call-held', 'said before leaving');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 1);
  assert.deepEqual(h.deliveries, []);

  h.socket.close();
  await waitFor(() => h.deliveries.length >= 1);
  // Give any second delivery a chance to appear before asserting there was none.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(h.deliveries, ['said before leaving'], 'the held words leave once — not zero times, not twice');
});

test('AC1(e): an idle sentence is still delivered once after the coalescing window, with no hold card', async () => {
  const h = wire();
  await open(h.socket, h.transport);
  // The run is idle: `busy: false` is the host SAYING so, which must keep the pre-ruling behaviour.
  relay(h.transport, 'call-idle', 'just one sentence');
  await waitFor(() => h.deliveries.length === 1);

  assert.deepEqual(h.deliveries, ['just one sentence']);
  assert.deepEqual(framesOf<PendingFrame>(h.socket, 'pending'), [], 'the hold is a busy-session thing');
  assert.ok(VOICE_QUEUE_MAX_BYTES > 0, 'the shipped budget is a positive number of bytes');
});
