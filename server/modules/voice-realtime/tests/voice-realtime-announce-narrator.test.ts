/**
 * GOAL-047 / AC-403 — the announce closing turn's "I'm starting" remark reaches the narrator.
 *
 * WHAT THIS FILE PINS. `announce` makes the relay say ONE short sentence after a delivered
 * `session_send` (the model's follow-up text on the resumed turn). That text would otherwise be
 * swallowed by the bridge as display-only; the wiring under test routes it into the narrator queue
 * so the browser speaks it. The gate is the closing turn itself: `silent` produces no text and
 * `respond`'s "OK" must not be spoken — only `announce` turns a follow-up remark into a narration.
 *
 *   · AC-403(narrator)(a) — under `announce`, a follow-up text (the bridge's `onFollowUpText`)
 *     enqueues ONE `narrator_speak` carrying that text, with a fresh `utteranceId`.
 *   · AC-403(narrator)(b) — under `silent`, the same follow-up text enqueues NOTHING (the remark is
 *     not a narration; the model simply would not say it).
 *
 * Driven through `handleVoiceRealtimeConnection` over the same fake browser socket and fake transport
 * the narrator-interrupt suite uses. A "follow-up text" is simulated as the bridge observes it: the
 * transport grants a follow-up credit (`notifySynthesizedToolResume`), the endpoint opens a response
 * (`response.created`), and that response's text lands (`response.text.done`).
 *
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeNarratorQueue,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/** A minimal stand-in for the browser socket, mirroring the narrator-interrupt suite's own fake. */
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

type SpeakFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_speak' }>;

const speakFrames = (socket: FakeBrowserSocket): SpeakFrame[] =>
  socket.outbound.filter((frame): frame is SpeakFrame => frame.type === 'narrator_speak');

type Harness = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  queue: VoiceRealtimeNarratorQueue;
};

/** One connection with the narrator seam wired and the closing turn under test. */
function wire(closingTurn: 'announce' | 'silent'): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const executor: RealtimeToolExecutor = {
    session_send: async () => ({ ok: true, queued: false, runId: 'run-1', queuedMessageUuid: null }),
  };
  let queue: VoiceRealtimeNarratorQueue | null = null;
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    closingTurn,
    narrator: {
      attach: (attached: VoiceRealtimeNarratorQueue) => {
        queue = attached;
      },
    },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  assert.ok(queue !== null, 'the connection must hand the narrator queue to the composition root');
  return { socket, transport, queue };
}

async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** The bridge's follow-up text, as three upstream events deliver it: credit → open → text. */
function followUpText(transport: FakeTransport, text: string): void {
  transport.notifySynthesizedToolResume();
  transport.peerSend({ type: 'response.created', response: { id: 'resp-1' } } as RealtimeServerMessage);
  transport.peerSend({ type: 'response.text.done', response_id: 'resp-1', text } as RealtimeServerMessage);
}

test('announce: a follow-up remark is spoken through the narrator', async () => {
  const h = wire('announce');
  await open(h.socket, h.transport);

  followUpText(h.transport, '好的，我来查一下这个报错。');
  await waitFor(() => speakFrames(h.socket).length === 1);

  const spoken = speakFrames(h.socket)[0]!;
  assert.equal(spoken.text, '好的，我来查一下这个报错。');
  assert.match(spoken.utteranceId, /^announce-\d+$/);
});

test('silent: the same follow-up remark is swallowed, not spoken', async () => {
  const h = wire('silent');
  await open(h.socket, h.transport);

  followUpText(h.transport, 'OK');
  // Yield to the microtask queue so any (wrong) narration would have been sent.
  await waitFor(() => h.transport.sent.length >= 0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(speakFrames(h.socket), [], 'silent must not turn a follow-up remark into a narration');
});
