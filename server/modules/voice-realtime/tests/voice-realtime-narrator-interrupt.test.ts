/**
 * AC-406 — DUPLEX: the person speaking stops the narrator and clears its queue.
 *
 * WHAT THIS FILE IS FOR. Live Voice's voice output is the NARRATOR's (GOAL-047): a bypass producer
 * says short sentences — a run-end summary, a placeholder confirmation — so an eyes-off person keeps
 * the confidence that the system heard them. That output is NOT information they must be able to
 * recall, so it is DROPPABLE, and the duplex rule is one line: the moment they start a new
 * utterance, the narration playing is STOPPED and everything queued behind it is CLEARED. Not
 * paused and resumed — dropped, because they have already moved on and replaying a stale summary is
 * an interruption of them.
 *
 * INTERRUPTING IS CONVERSATION, NOT AN ERROR. Their words still travel the ordinary path (the model
 * relays them through `session_send`), the connection stays open, and nothing on this path reports
 * an `error`. A narrator that treated the person talking as a fault would be exactly backwards.
 *
 * WHAT THIS FILE PINS, and the false form that proves each line is load-bearing:
 *
 *   · AC-406(a) — WHILE A NARRATION PLAYS, a new user utterance sends `narrator_stop` for the
 *     utterance standing now and drops the one queued behind it. The queue is PACED
 *     (`narrator_speak` → wait for `narrator_done`), so the queued item was never sent to the page:
 *     there is nothing for the clear to miss.
 *   · AC-406(b) — THE PERSON'S WORDS STILL GO THROUGH. After the interrupt, a relayed `session_send`
 *     reaches the executor and answers `sent`, and the connection reports NO `error` frame and no
 *     error-level journal line. Interrupt ≠ failure.
 *   · AC-406(c) — A STALE ACK DOES NOT ADVANCE. A `narrator_done` for the interrupted utterance (the
 *     page sent it before it saw the stop) must not start the next narration.
 *   · THE FALSE FORM — with `interruptOnUserSpeech: false` (the seam that removes the hook) the
 *     narration keeps playing through the person's speech and the queued one is sent after the ack.
 *     That is the red the AC's last clause names; the shipped arm above is its control.
 *
 * Driven through `handleVoiceRealtimeConnection` — the real proxy, offline — over the same fake
 * browser socket and fake transport the bounded-queue suite uses. The "user speech" is the
 * endpoint's own `input_audio_buffer.speech_started`, the reading the deployed `server_vad` always
 * fires; the segmented and local-gate readings are wired to the same hook in the proxy.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  createVoiceRealtimeNarratorQueue,
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeNarratorQueue,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses. Mirrors the bounded-queue suite's own fake — the two files
 * drive the same handler, so they must drive it the same way.
 */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** The frame shapes this file reads; `Extract` keeps them exact members of the union. */
type SpeakFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_speak' }>;
type StopFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_stop' }>;
type SentFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }>;
type ErrorFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'error' }>;

const speakFrames = (socket: FakeBrowserSocket): SpeakFrame[] =>
  socket.outbound.filter((frame): frame is SpeakFrame => frame.type === 'narrator_speak');
const stopFrames = (socket: FakeBrowserSocket): StopFrame[] =>
  socket.outbound.filter((frame): frame is StopFrame => frame.type === 'narrator_stop');
const sentFrames = (socket: FakeBrowserSocket): SentFrame[] =>
  socket.outbound.filter((frame): frame is SentFrame => frame.type === 'sent');
const errorFrames = (socket: FakeBrowserSocket): ErrorFrame[] =>
  socket.outbound.filter((frame): frame is ErrorFrame => frame.type === 'error');

/** A session that starts the run now, so a relayed instruction answers `sent` at once. */
function createStartedExecutor(): { calls: Array<Record<string, unknown>>; executor: RealtimeToolExecutor } {
  const calls: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { ok: true, queued: false, runId: 'run-1', queuedMessageUuid: null };
    },
  };
  return { calls, executor };
}

type Harness = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  /** The queue the connection handed the composition root through `narrator.attach`. */
  queue: VoiceRealtimeNarratorQueue;
  /** Every journal line the proxy wrote. */
  logs: string[];
  /** Every `session_send` reach, in order. */
  calls: Array<Record<string, unknown>>;
};

/**
 * One connection with the narrator seam wired.
 *
 * `interruptOnUserSpeech` is the seam the false-form leg turns off; omitted is the shipped rule.
 */
function wire(options: { interruptOnUserSpeech?: boolean } = {}): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const { calls, executor } = createStartedExecutor();
  const logs: string[] = [];
  let queue: VoiceRealtimeNarratorQueue | null = null;

  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    log: (line: string) => logs.push(line),
    narrator: {
      attach: (attached: VoiceRealtimeNarratorQueue) => {
        queue = attached;
      },
      ...(options.interruptOnUserSpeech === undefined
        ? {}
        : { interruptOnUserSpeech: options.interruptOnUserSpeech }),
    },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  assert.ok(queue !== null, 'the connection must hand the narrator queue to the composition root');
  return { socket, transport, queue, logs, calls };
}

/** Waits until the upstream session is open (the proxy sends `state: open`). */
async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** The person starts a new utterance, as the endpoint's own detector reports it. */
function userSpeechStarted(transport: FakeTransport): void {
  transport.peerSend({ type: 'input_audio_buffer.speech_started' } as RealtimeServerMessage);
}

/** The model relays the person's words — the ordinary path their speech still takes. */
function relay(transport: FakeTransport, callId: string, message: string): void {
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  } as RealtimeServerMessage);
}

// ── AC-406(a)/(b): the person speaks → the narrator stops, the queue clears, and their words go on ─

test('AC-406: a new user utterance stops the playing narration, clears the queue, and the words still reach session_send without an error', async () => {
  const h = wire();
  await open(h.socket, h.transport);

  // A narration is playing and a second one is waiting behind it. The pacing rule is what makes the
  // queue a SERVER-side object: only the first one has been sent to the page.
  h.queue.enqueue({ utteranceId: 'n-1', text: '工作总结：已经改好了。' });
  h.queue.enqueue({ utteranceId: 'n-2', text: '等你确认下一步。' });
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1'],
    'exactly the playing narration was sent; the queued one waits for the page’s narrator_done',
  );
  assert.deepEqual(
    h.queue.reading(),
    { current: 'n-1', queued: 1, dropped: 0 },
    'the reading names what is playing and what is queued',
  );

  // THE PERSON OPENS THEIR MOUTH.
  userSpeechStarted(h.transport);
  await waitFor(() => stopFrames(h.socket).length === 1);

  assert.deepEqual(
    stopFrames(h.socket),
    [{ type: 'narrator_stop', utteranceId: 'n-1', reason: 'user-spoke' }],
    'the narration playing now is stopped with the reason the page needs',
  );
  assert.deepEqual(
    h.queue.reading(),
    { current: null, queued: 0, dropped: 2 },
    'the playing narration AND the one queued behind it are dropped — not paused and resumed',
  );

  // A LATE ACK from the page, sent before it processed the stop, must not resurrect the queue.
  h.socket.receive({ type: 'narrator_done', utteranceId: 'n-1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1'],
    'a stale narrator_done for the interrupted utterance does not start the next narration',
  );

  // THEIR WORDS STILL TAKE THE ORDINARY PATH — and it succeeds.
  relay(h.transport, 'call-1', '放到 server。那边去');
  await waitFor(() => sentFrames(h.socket).length === 1);
  assert.equal(sentFrames(h.socket)[0]!.message, '放到 server。那边去', 'the person’s words reached session_send');
  assert.equal(h.calls.length, 1, 'the executor was reached exactly once');
  assert.equal(h.calls[0]!.message, '放到 server。那边去', 'and carried the words they said');

  // INTERRUPTING IS NOT AN ERROR: no error frame, no error-level journal line.
  assert.deepEqual(errorFrames(h.socket), [], 'an interruption is conversation, not an error frame');
  assert.deepEqual(
    h.logs.filter((line) => /error/i.test(line)),
    [],
    'and the journal records no error-level line for it',
  );
  assert.ok(
    h.logs.some((line) => line === 'narrator cleared reason=user-spoke dropped=2'),
    'the drop is recorded once, as an informational line naming what it dropped',
  );

  h.socket.close();
});

// ── AC-406(c): with the hook removed (the FALSE FORM), narration plays through the person ────────

test('AC-406 false form: without the new-utterance hook the narration keeps playing and the queued one follows', async () => {
  const h = wire({ interruptOnUserSpeech: false });
  await open(h.socket, h.transport);

  h.queue.enqueue({ utteranceId: 'n-1', text: '工作总结：已经改好了。' });
  h.queue.enqueue({ utteranceId: 'n-2', text: '等你确认下一步。' });
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1'],
    'the false form starts from the same wire the shipped arm does',
  );

  // The same injection the shipped arm passes: the person speaks.
  userSpeechStarted(h.transport);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(stopFrames(h.socket), [], 'WITH THE HOOK REMOVED nothing stops the narration — the red');
  assert.deepEqual(
    h.queue.reading(),
    { current: 'n-1', queued: 1, dropped: 0 },
    'and the queue is untouched while the person is talking',
  );

  // The narration runs to its end and the QUEUED one starts — exactly the "排队播报继续" the AC names.
  h.socket.receive({ type: 'narrator_done', utteranceId: 'n-1' });
  await waitFor(() => speakFrames(h.socket).length === 2);
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1', 'n-2'],
    'with the hook removed the queued narration still plays over the person’s speech',
  );

  h.socket.close();
});

// ── The queue is shipped code, not the test's: its own pacing and stale-ack rules ────────────────

test('narrator queue: pacing, stale acks and teardown without the connection', () => {
  const frames: VoiceRealtimeOutboundFrame[] = [];
  const queue = createVoiceRealtimeNarratorQueue({ send: (frame) => frames.push(frame) });

  queue.enqueue({ utteranceId: 'a', text: 'first' });
  queue.enqueue({ utteranceId: 'b', text: 'second' });
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['narrator_speak'],
    'one narration on the wire at a time',
  );

  // A done that names nothing standing now changes nothing.
  queue.completed('not-playing');
  assert.equal(queue.reading().current, 'a', 'an unknown utterance cannot end the playing one');

  queue.completed('a');
  assert.deepEqual(
    frames.map((frame) => (frame.type === 'narrator_speak' ? frame.utteranceId : frame.type)),
    ['a', 'b'],
    'the ack for the playing narration advances to the next',
  );

  // Interrupt while playing: stop frame for the current one, queued dropped, nothing else sent.
  queue.enqueue({ utteranceId: 'c', text: 'third' });
  const dropped = queue.interrupt('user-spoke');
  assert.equal(dropped, 2, 'the playing narration AND the one queued behind it are dropped');
  assert.deepEqual(
    frames.slice(-1),
    [{ type: 'narrator_stop', utteranceId: 'b', reason: 'user-spoke' }],
    'the interrupt stops exactly what is playing',
  );
  assert.deepEqual(queue.reading(), { current: null, queued: 0, dropped: 2 });

  // A stale done after the interrupt must not start `c` — and after close nothing is sent at all.
  queue.completed('b');
  queue.close();
  queue.enqueue({ utteranceId: 'd', text: 'late' });
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'narrator_speak').map((frame) => frame.utteranceId),
    ['a', 'b'],
    'no narration is sent after the interrupt or after close',
  );
});
