/**
 * GOAL-047 — a MODEL TEXT REPLY is spoken, not only forwarded.
 *
 * WHAT THIS FILE PINS. When the relay model answers the USER in words instead of calling
 * `session_send`, the bridge reports `MODEL_TEXT_REPLY` carrying that text. The proxy used to drop
 * the model's words entirely (it only relayed the user's unforwarded sentences verbatim and told the
 * page `heard_not_forwarded`). The principle is "trust the model more, not the mechanism": the model's
 * own sentence is now enqueued into the narrator so the browser SPEAKS it, while the existing
 * verbatim relay of the user's words is unchanged.
 *
 *   · (a) a `MODEL_TEXT_REPLY` enqueues ONE `narrator_speak` carrying the model's text, with a fresh
 *     `utteranceId`.
 *   · (b) with no narrator wired, the same reply enqueues NOTHING (the pre-narrator wire is
 *     unchanged and the page still gets its `heard_not_forwarded` disposition).
 *
 * Driven through `handleVoiceRealtimeConnection` over the same fake browser socket and fake transport
 * the announce-narrator suite uses. A model text reply is simulated as the bridge observes it: a
 * `response.text.done` whose `response_id` was never granted a follow-up credit.
 *
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-model-reply-narrator.test.ts
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

/** A minimal stand-in for the browser socket, mirroring the announce-narrator suite's own fake. */
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
};

/** One connection with the narrator seam wired (or absent), always on the continuous relay. */
function wire(withNarrator: boolean): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const executor: RealtimeToolExecutor = {
    session_send: async () => ({ ok: true, queued: false, runId: 'run-1', queuedMessageUuid: null }),
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    closingTurn: 'announce',
    // The MODEL_TEXT_REPLY arm is scoped to the continuous relay; the default resolution is
    // continuous, but pinning it keeps the test independent of a leaked VOICE_REALTIME_MODE.
    segmentedRelay: false,
    ...(withNarrator
      ? {
          narrator: {
            attach: (_attached: VoiceRealtimeNarratorQueue) => {},
          },
        }
      : {}),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport };
}

async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** The bridge's model text reply: a `response.text.done` that was never a follow-up credit. */
function modelTextReply(transport: FakeTransport, text: string): void {
  transport.peerSend({ type: 'response.text.done', response_id: 'resp-model', text } as RealtimeServerMessage);
}

test('a MODEL_TEXT_REPLY is spoken through the narrator as the model said it', async () => {
  const h = wire(true);
  await open(h.socket, h.transport);

  const modelText = '好的，我明白了。';
  modelTextReply(h.transport, modelText);
  await waitFor(() => speakFrames(h.socket).length === 1);

  const spoken = speakFrames(h.socket)[0]!;
  assert.equal(spoken.text, modelText, 'the model wording must reach the narrator verbatim');
  assert.match(spoken.utteranceId, /^model-reply-\d+$/);
});

test('with no narrator wired the reply still does not crash, and is not spoken', async () => {
  const h = wire(false);
  await open(h.socket, h.transport);

  modelTextReply(h.transport, '好的，我明白了。');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(speakFrames(h.socket), [], 'no narrator means no narration');
  assert.ok(
    h.socket.outbound.some((frame) => frame.type === 'heard_not_forwarded'),
    'the page still gets the heard-not-forwarded disposition',
  );
});
