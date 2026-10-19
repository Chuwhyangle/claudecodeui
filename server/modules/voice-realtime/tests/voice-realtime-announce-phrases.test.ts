/**
 * The announce closing turn's fixed phrase table, and the proxy leg that uses it.
 *
 * WHAT THIS FILE PINS, one reason per block:
 *
 *   · `pickAnnouncePhrase()` is TOTAL AND DETERMINISTIC. Every sequence number resolves to a member
 *     of `ANNOUNCE_PHRASES`, the same input always resolves to the same sentence, and consecutive
 *     numbers rotate through the table in order. This is what makes the warm cache's key set and the
 *     spoken sentence predictable instead of a per-connection race.
 *
 *   · THE PROXY SPEAKS THE TABLE, NOT THE MODEL. Driven through the real
 *     `handleVoiceRealtimeConnection` over the same fake browser socket and fake transport the
 *     announce-narrator suite uses: under `announce`, every `narrator_speak.text` belongs to the
 *     fixed table, and the model's follow-up wording never appears in ANY outbound frame. A wiring
 *     that kept `enqueue({ text })` from the model would be red on both readings.
 *
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import { ANNOUNCE_PHRASES, pickAnnouncePhrase } from '../voice-realtime-announce-phrases.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeNarratorQueue,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── the table ─────────────────────────────────────────────────────────────────────────────────────

test('pickAnnouncePhrase is total, deterministic, and rotates through the table', () => {
  assert.ok(ANNOUNCE_PHRASES.length >= 3, 'the table carries enough phrases for a deterministic rotation');
  const seen = new Set<string>();
  for (let seq = 0; seq < ANNOUNCE_PHRASES.length; seq += 1) {
    const phrase = pickAnnouncePhrase(seq);
    assert.ok(ANNOUNCE_PHRASES.includes(phrase), `seq ${seq} produced ${phrase}, not a table member`);
    assert.equal(pickAnnouncePhrase(seq), phrase, `seq ${seq} must be deterministic`);
    seen.add(phrase);
  }
  assert.equal(seen.size, ANNOUNCE_PHRASES.length, 'one full cycle reaches every phrase');
  // The rotation is a cycle, not a clamp: the next cycle repeats the first sentence.
  assert.equal(pickAnnouncePhrase(ANNOUNCE_PHRASES.length), pickAnnouncePhrase(0));
  // Total for inputs a counter should never produce: still a table member, never `undefined`.
  for (const seq of [-1, -7, 1.9, Number.NaN]) {
    assert.ok(ANNOUNCE_PHRASES.includes(pickAnnouncePhrase(seq)), `seq ${seq} must still name a phrase`);
  }
});

// ── the proxy leg ─────────────────────────────────────────────────────────────────────────────────

/** A minimal stand-in for the browser socket, mirroring the announce-narrator suite's own fake. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  /** Every JSON string sent to the page, for "the model's wording never crossed the wire". */
  readonly raw: string[] = [];

  send(data: string): void {
    this.raw.push(data);
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

/** One `announce` connection with the narrator seam wired. */
function wire(): Harness {
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
    closingTurn: 'announce',
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
function followUpText(transport: FakeTransport, responseId: string, text: string): void {
  transport.notifySynthesizedToolResume();
  transport.peerSend({ type: 'response.created', response: { id: responseId } } as RealtimeServerMessage);
  transport.peerSend({ type: 'response.text.done', response_id: responseId, text } as RealtimeServerMessage);
}

test('announce: every narrator_speak carries a fixed phrase and the model wording never reaches the page', async () => {
  const h = wire();
  await open(h.socket, h.transport);

  const modelTexts = [
    '好的，测试已记录。',
    '正在处理你的反馈。',
    '这条是模型自己的措辞，不应该被念出来。',
  ];

  for (let index = 0; index < modelTexts.length; index += 1) {
    followUpText(h.transport, `resp-${index}`, modelTexts[index]!);
    // The queue paces on the page's ack; without it only the first narration would be emitted.
    await waitFor(() => speakFrames(h.socket).length === index + 1);
    const spoken = speakFrames(h.socket)[index]!;
    assert.equal(spoken.utteranceId, `announce-${index}`);
    h.socket.receive({ type: 'narrator_done', utteranceId: spoken.utteranceId } as VoiceRealtimeInboundFrame);
    await waitFor(() => h.queue.reading().current === null);
  }

  const spokenTexts = speakFrames(h.socket).map((frame) => frame.text);
  assert.equal(spokenTexts.length, modelTexts.length);
  for (const [index, text] of spokenTexts.entries()) {
    assert.equal(text, pickAnnouncePhrase(index), `announcement ${index} must speak its rotation step`);
    assert.ok(ANNOUNCE_PHRASES.includes(text), `${text} must belong to the fixed table`);
  }

  // The load-bearing half: not one outbound frame (text or audio) carries the model's wording.
  const outbound = h.socket.raw.join('\n');
  for (const modelText of modelTexts) {
    assert.ok(!outbound.includes(modelText), `the model follow-up ${JSON.stringify(modelText)} reached the page`);
  }
});
