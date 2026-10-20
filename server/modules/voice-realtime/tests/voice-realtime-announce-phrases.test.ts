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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  ANNOUNCE_PHRASES,
  ANNOUNCE_PHRASE_MAX_CHARS,
  pickAnnouncePhrase,
  pickAnnouncePhraseFrom,
  resolveAnnouncePhrases,
} from '../voice-realtime-announce-phrases.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeNarratorQueue,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── the table ─────────────────────────────────────────────────────────────────────────────────────

test('the default table is two characters or more per phrase', () => {
  for (const phrase of ANNOUNCE_PHRASES) {
    assert.ok(
      phrase.length >= 2,
      `${JSON.stringify(phrase)} is shorter than the two-character floor the live test asked for`,
    );
  }
});

test('resolveAnnouncePhrases splits on `|`, trims, and drops empty segments at the ends', () => {
  const resolved = resolveAnnouncePhrases(' 好的 | 收到 | 明白 | ');
  assert.deepEqual(resolved.problems, [], 'a well-formed list must not be refused');
  assert.deepEqual(resolved.phrases, ['好的', '收到', '明白'], 'each entry is trimmed and edge separators vanish');

  const four = resolveAnnouncePhrases('好的|收到|明白|在办');
  assert.deepEqual(four.problems, []);
  assert.deepEqual(four.phrases, ['好的', '收到', '明白', '在办']);

  const leading = resolveAnnouncePhrases('|好的|收到|明白');
  assert.deepEqual(leading.problems, []);
  assert.deepEqual(leading.phrases, ['好的', '收到', '明白']);
});

test('resolveAnnouncePhrases falls back to the default table and reports why', () => {
  const cases: { raw: unknown; reason: RegExp }[] = [
    // Fewer than three sentences cannot rotate.
    { raw: '好的|收到', reason: /at least 3 phrases/ },
    // An empty segment BETWEEN two phrases is a hole, unlike a trailing separator.
    { raw: '好的||收到|明白', reason: /empty phrase/ },
    // Longer than the announce criterion's 15-character budget.
    { raw: `好的|收到|${'长'.repeat(ANNOUNCE_PHRASE_MAX_CHARS + 1)}`, reason: /at most 15 characters/ },
    // A number is not a string, even if it could be coerced.
    { raw: 42, reason: /must be a .*-separated string/ },
  ];
  for (const { raw, reason } of cases) {
    const resolved = resolveAnnouncePhrases(raw);
    assert.deepEqual(resolved.phrases, ANNOUNCE_PHRASES, `${JSON.stringify(raw)} must fall back to the shipped table`);
    assert.ok(resolved.problems.length > 0, `${JSON.stringify(raw)} must say why it was refused`);
    assert.match(resolved.problems.join('; '), reason, `${JSON.stringify(raw)} must name the broken rule`);
  }
});

test('pickAnnouncePhraseFrom rotates through the caller-supplied table, not the shipped one', () => {
  const table = ['甲的句子', '乙的句子', '丙的句子'];
  const seen = new Set<string>();
  for (let seq = 0; seq < table.length; seq += 1) {
    const phrase = pickAnnouncePhraseFrom(table, seq);
    assert.equal(phrase, table[seq], `seq ${seq} must pick the table's own entry`);
    seen.add(phrase);
  }
  assert.equal(seen.size, table.length, 'one cycle reaches every entry of the supplied table');
  assert.equal(pickAnnouncePhraseFrom(table, table.length), table[0], 'the rotation is a cycle');
  assert.equal(pickAnnouncePhraseFrom(table, -1), table[table.length - 1], 'negative input folds onto the table');
  assert.equal(pickAnnouncePhraseFrom([], 0), '', 'an empty table answers the queue no-op, never undefined');
});

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
function wire(options: { settingsPath?: string } = {}): Harness {
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
    ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
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

test('announce: the settings file\'s `announcePhrases` are what the connection speaks', async () => {
  // The DoD's hot-edit reading, on the REAL connection path: point the seam at a file whose table
  // shares no phrase with the shipped one, and the announce gate must speak the file's first entry.
  const table = ['甲收到', '乙在办', '丙明白'];
  const dir = mkdtempSync(join(tmpdir(), 'voice-announce-phrases-settings-'));
  try {
    const file = join(dir, 'voice-realtime.settings.json');
    writeFileSync(file, JSON.stringify({ announcePhrases: table.join('|') }), 'utf8');

    const h = wire({ settingsPath: file });
    await open(h.socket, h.transport);
    followUpText(h.transport, 'resp-settings', '这句模型措辞不该被念出来。');

    await waitFor(() => speakFrames(h.socket).length === 1);
    const spoken = speakFrames(h.socket)[0]!;
    assert.equal(spoken.text, table[0], 'the file is the table the announce gate reads');
    for (const shipped of ANNOUNCE_PHRASES) {
      assert.notEqual(spoken.text, shipped, 'the shipped table must not leak through when the file named one');
    }
    // Same table, same rotation function: the second announcement takes the file's second entry.
    h.socket.receive({ type: 'narrator_done', utteranceId: spoken.utteranceId } as VoiceRealtimeInboundFrame);
    await waitFor(() => h.queue.reading().current === null);
    followUpText(h.transport, 'resp-settings-2', '还是模型措辞。');
    await waitFor(() => speakFrames(h.socket).length === 2);
    assert.equal(speakFrames(h.socket)[1]!.text, table[1], 'the rotation walks the file\'s table in order');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
