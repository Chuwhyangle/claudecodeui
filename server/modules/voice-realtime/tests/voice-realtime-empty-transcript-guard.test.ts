/**
 * The empty-transcript delivery guard.
 *
 * THE DEFECT THIS PINS (2026-10-11 02:38 CST, connection `d88c6722`). A segmented Live Voice call
 * committed four segments; one of them came back from the endpoint transcribed as the EMPTY string,
 * and the relay model answered that silence by inventing a user message from nothing:
 *
 *     18:38:23.955  segment seq=0 dur=19200ms reason=max frames=1
 *     18:38:30.777  << transcription.completed ""        ← the endpoint reported zero words
 *     18:38:31.050  << function_call session_send {"message": "（用户没有说话）"}
 *     18:38:33.552  session_send delivered in 1 ms        ← a message nobody said, in the session
 *
 * WHAT IS GUARDED, AND WHAT IS NOT. The only fact this guard acts on is MECHANICAL: the endpoint
 * reported zero words for a committed segment. It never decides whether a relayed message is a
 * faithful rendering of what the person said — the relay model legitimately repairs and rephrases,
 * and judging that is a model-capability question explicitly out of scope. So the boundary is
 * "empty vs not empty", and the negative control below (`嗯`/`呃`) is what keeps the predicate from
 * growing into a stop-word filter.
 *
 * WHERE THE GUARD SITS. At the DELIVERY point, not only where the transcription arrives: the
 * endpoint's transcript and the model's `session_send` call are independent upstream events and
 * either may land first (the defect happened to be transcription-first; the reverse is just as
 * legal). A call whose segment has no transcript yet is held briefly and released by whichever of
 * the two arrives first, so both orders reach the same decision.
 *
 * The first assertion in this file is AC1's — "an empty transcript delivers nothing" — deliberately:
 * a false form that made the empty segment deliver must red HERE, before any sibling assertion can
 * mask it.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  createDashscopeTransport,
  parseWavPcm16,
  runVoiceRealtimeDiagnosis,
  type DashscopeWireObserver,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
} from '../index.js';
import {
  VOICE_REALTIME_INSTRUCTIONS,
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import {
  createVoiceRealtimeRecorder,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeLogStore,
} from '../voice-realtime-log.js';

import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';
import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * A minimal stand-in for the browser's `ws.WebSocket` — the surface the proxy uses, driven over
 * `EventEmitter` so nothing binds at the OS level. Same shape as the protocol-simulation suite's.
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

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type RecordedSend = { args: Record<string, unknown> };

/**
 * The executor stand-in: records every `session_send` the proxy decided to deliver, never fails.
 *
 * `calls` is the reading AC1/AC2/AC3 assert on — the count is the whole question ("did a message
 * reach the session?"), so it is recorded at call time rather than after a delay.
 */
function createRecordingExecutor(): { calls: RecordedSend[]; executor: RealtimeToolExecutor } {
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, echoedMessage: args.message };
    },
  };
  return { calls, executor };
}

type Wired = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  base: { calls: RecordedSend[]; executor: RealtimeToolExecutor };
  logs: string[];
};

/** One proxy connection over a fake browser socket, a fake upstream, and a recording log seam. */
function wire(options: { transcriptGraceMs?: number; coalesceMs?: number } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createRecordingExecutor();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
    // Pin the relay mode instead of inheriting `VOICE_REALTIME_MODE`. THIS file is about the
    // segmented delivery guard, not about mode resolution — that question is owned by
    // `voice-realtime-segmented-default.test.ts`. Without this seam the connection falls back to
    // the ambient variable (voice-realtime-ws-proxy.service.ts:785), so an environment that says
    // `continuous` sends no `ready` frame and the AC5 handshake wait below times out on something
    // the guard has nothing to do with. Same seam `voice-realtime-log-wiring.test.ts` pins.
    segmentedRelay: true,
    log: (line) => logs.push(line),
    ...(options.transcriptGraceMs === undefined ? {} : { transcriptGraceMs: options.transcriptGraceMs }),
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'session-under-test', seams);
  return { socket, transport, base, logs };
}

/** Offers the segmented protocol and waits for the session to be open and usable. */
async function open(wired: Wired): Promise<void> {
  wired.socket.receive({ type: 'hello', protocol: 'segmented-v1' });
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** One committed segment: start, one audio frame, end. */
function speakSegment(socket: FakeBrowserSocket, seq: number, reason: 'gap' | 'max' = 'gap', durationMs = 100): void {
  socket.receive({ type: 'segment_start', seq, startedAtMs: 0 });
  socket.receive({ type: 'audio', audio: 'U0VHTUVOVA==', seq });
  socket.receive({ type: 'segment_end', seq, durationMs, reason });
}

/**
 * The endpoint's report about one utterance: its `input_audio_buffer.committed` acceptance, then its
 * FINAL transcript — in that order, because that is the wire's.
 *
 * BOTH FRAMES, not just the transcript. The acceptance is what carries the item id, and the item id is
 * the only key that says which SEGMENT a transcript belongs to (`segmentSeqByItemId`): the endpoint
 * transcribes asynchronously, so a transcript can land after a LATER segment has been committed, and
 * the guard must still decide the segment it was spoken in. A transcript with no acceptance beside it
 * is a report about an item no segment of ours created — the `seq: null` case, exercised deliberately
 * in `voice-realtime-caption-item-attribution.test.ts`, not this file's subject.
 */
function transcribe(transport: FakeTransport, itemId: string, text: string): void {
  transport.peerSend({ type: 'input_audio_buffer.committed', item_id: itemId } as RealtimeServerMessage);
  const message: RealtimeServerMessage = {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  };
  transport.peerSend(message);
}

/** The model's relay, as the real wire reports it. */
function relay(transport: FakeTransport, callId: string, message: string): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  };
  transport.peerSend(call);
}

/** The upstream's answer to a segment's commit finishing. */
function responseDone(transport: FakeTransport): void {
  transport.peerSend({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } } as RealtimeServerMessage);
}

const acks = (socket: FakeBrowserSocket): Array<Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }>> =>
  socket.outbound.filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }> => frame.type === 'segment_ack');

/** Yields to the microtask queue and one timer turn, so an async delivery that was going to happen has. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * The journal the recorder would have written for these log lines.
 *
 * The recorder is the SHIPPING classifier — fed the proxy's own captured lines and an in-memory
 * store — so "the journal has no delivered entry for this segment" is asserted against the code
 * that writes the journal, not against a hand-rolled reading of the strings.
 */
function journalOf(lines: readonly string[]): VoiceRealtimeLogEntry[] {
  const entries: VoiceRealtimeLogEntry[] = [];
  const store: VoiceRealtimeLogStore = {
    append: (entry) => {
      entries.push(entry);
    },
    clear: () => ({ deleted: 0 }),
    directory: () => '/no-such-journal-directory',
  };
  const recorder = createVoiceRealtimeRecorder({
    store,
    connectionId: 'connection-under-test',
    sessionId: 'session-under-test',
    tag: 'test',
    mode: 'segmented',
    stdout: () => undefined,
  });
  for (const line of lines) {
    recorder.log(line);
  }
  return entries;
}

const deliveredSends = (entries: readonly VoiceRealtimeLogEntry[]) =>
  entries.filter((entry): entry is Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }> => entry.kind === 'session_send' && entry.outcome === 'delivered');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — the defect itself: an empty transcript produces no message.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC1: a segment the endpoint transcribed as empty delivers nothing and is acked dropped', async () => {
  const wired = wire();
  await open(wired);

  // The defect's own shape: one 19.2 s segment, cut by the ceiling, `reason=max`.
  speakSegment(wired.socket, 0, 'max', 19_200);
  await waitFor(() => acks(wired.socket).length === 1);
  transcribe(wired.transport, 'item-0', '');
  relay(wired.transport, 'call-1', '（用户没有说话）');
  await tick();

  // FIRST ASSERTION IN THIS FILE, on purpose: a false form where an empty transcript still
  // delivered must red here, before any sibling assertion can stand in front of it.
  assert.equal(wired.base.calls.length, 0, 'an empty transcript must not produce a session_send');

  const dropped = acks(wired.socket).filter((frame) => frame.state === 'dropped');
  assert.equal(dropped.length, 1, 'the page is told the segment was refused');
  assert.equal(dropped[0]?.seq, 0);
  assert.equal(dropped[0]?.reason, 'empty-transcript', 'the refusal carries an explicit reason');

  // The journal is the operator's answer to "did this reach the session?". The refusal is a
  // RECORDED outcome, not a gap: one `session_send` entry, and it says `not-delivered` with why.
  const entries = journalOf(wired.logs);
  assert.equal(deliveredSends(entries).length, 0, 'the journal records no delivery for the segment');
  const sendEntries = entries.filter(
    (entry): entry is Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }> => entry.kind === 'session_send',
  );
  assert.equal(sendEntries.length, 1, 'the refusal is recorded, not silently dropped');
  assert.equal(sendEntries[0]?.outcome, 'not-delivered', 'and it is recorded as a non-delivery');
  assert.equal(sendEntries[0]?.reason, 'empty-transcript', 'with the reason the operator needs');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — the empty boundary, and the negative control that keeps it from becoming a stop-word filter.
// ════════════════════════════════════════════════════════════════════════════════════════════════

for (const [label, text] of [
  ['the empty string', ''],
  ['whitespace only', '   \t \n '],
  ['a full stop', '。'],
  ['an ellipsis', '…'],
  ['a run of full stops', '。。。'],
] as const) {
  test(`AC2: a segment transcribed as ${label} delivers nothing and is acked dropped`, async () => {
    const wired = wire();
    await open(wired);
    speakSegment(wired.socket, 0);
    await waitFor(() => acks(wired.socket).length === 1);
    transcribe(wired.transport, 'item-0', text);
    relay(wired.transport, 'call-1', `（用户没有说话）`);
    await tick();

    const dropped = acks(wired.socket).filter((frame) => frame.state === 'dropped');
    assert.equal(wired.base.calls.length, 0, `${JSON.stringify(text)} must not produce a session_send`);
    assert.equal(dropped.length, 1, `${JSON.stringify(text)}: the segment is acked dropped`);
    assert.equal(dropped[0]?.reason, 'empty-transcript');
    assert.equal(deliveredSends(journalOf(wired.logs)).length, 0, `${JSON.stringify(text)}: no delivery in the journal`);
  });
}

for (const [label, text] of [
  ['嗯', '嗯'],
  ['呃', '呃'],
] as const) {
  test(`AC2 negative control: a segment transcribed as "${label}" IS relayed`, async () => {
    const wired = wire();
    await open(wired);
    speakSegment(wired.socket, 0);
    await waitFor(() => acks(wired.socket).length === 1);
    transcribe(wired.transport, 'item-0', text);
    relay(wired.transport, 'call-1', text);
    await waitFor(() => wired.base.calls.length === 1, 3_000);

    // The filter must not eat content: a filler word is something the person said.
    assert.equal(wired.base.calls[0]?.args.message, text, 'a filler word reaches the session');
    assert.equal(acks(wired.socket).filter((frame) => frame.state === 'dropped').length, 0, 'and the segment is not dropped');
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — the delivery point: ordering, the model's own message, audio-state drops, and `seq` handling.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC3 ordering race: the model calls session_send BEFORE the empty transcript arrives, and the guard still refuses it', async () => {
  const wired = wire({ transcriptGraceMs: 400 });
  await open(wired);
  speakSegment(wired.socket, 0);
  await waitFor(() => acks(wired.socket).length === 1);

  // The other order: the relay lands first, while the segment's transcript is not yet known.
  relay(wired.transport, 'call-1', '（用户没有说话）');
  await tick();
  assert.equal(wired.base.calls.length, 0, 'a call whose segment is untranscribed is held, not delivered');

  // ...and the transcript decides it: zero words ⇒ refused, and the hold is released.
  transcribe(wired.transport, 'item-0', '');
  await waitFor(() => acks(wired.socket).some((frame) => frame.state === 'dropped'));
  await tick();
  assert.equal(wired.base.calls.length, 0, 'the held call is refused once the empty transcript lands');
});

test('AC3 ordering race, other direction: a held call is delivered when a non-empty transcript lands', async () => {
  const wired = wire({ transcriptGraceMs: 400 });
  await open(wired);
  speakSegment(wired.socket, 0);
  await waitFor(() => acks(wired.socket).length === 1);

  relay(wired.transport, 'call-1', '把超时改成五十秒');
  await tick();
  assert.equal(wired.base.calls.length, 0, 'the call waits for the segment to be transcribed');

  transcribe(wired.transport, 'item-0', '把超时改成五十秒');
  await waitFor(() => wired.base.calls.length === 1, 3_000);
  assert.equal(wired.base.calls[0]?.args.message, '把超时改成五十秒', 'the words reach the session, not a mixture');
});

test('AC3: the model-authored message is judged on its own — an empty one is delivered even when the transcript has words', async () => {
  const wired = wire();
  await open(wired);
  speakSegment(wired.socket, 0);
  await waitFor(() => acks(wired.socket).length === 1);
  transcribe(wired.transport, 'item-0', '这信号还可以啊。');
  relay(wired.transport, 'call-1', '   ');
  await tick();

  assert.equal(wired.base.calls.length, 0, 'an empty model message must not be delivered');
  assert.equal(deliveredSends(journalOf(wired.logs)).length, 0, 'and the journal says so');
});

test('AC3: audio arriving while the upstream is connecting, closing or closed is dropped, never thrown', async () => {
  const wired = wire();
  // `connecting`: no wait for `open` — the frame lands with the transport still dialling.
  assert.doesNotThrow(() => {
    wired.socket.receive({ type: 'audio', audio: 'PREOPEN==', seq: 0 });
    wired.socket.receive({ type: 'segment_start', seq: 0 });
    wired.socket.receive({ type: 'audio', audio: 'PREOPEN==', seq: 0 });
  }, 'audio during `connecting` must be dropped, not thrown (an unguarded send takes the process down)');
  await open(wired);
  assert.equal(
    wired.transport.sent.filter((message) => message.type === 'input_audio_buffer.append').length,
    0,
    'nothing was forwarded while the upstream was not open',
  );

  // `closing` / `closed`: the browser keeps talking into a socket that is on its way out.
  wired.socket.close();
  assert.doesNotThrow(() => {
    wired.socket.receive({ type: 'audio', audio: 'POSTCLOSE==' });
    wired.socket.receive({ type: 'audio', audio: 'POSTCLOSE==', seq: 0 });
    wired.socket.receive({ type: 'segment_end', seq: 0 });
    wired.socket.receive({ type: 'segment_end', seq: 99 });
  }, 'frames after teardown must be dropped, not thrown');
});

test('AC3: an unknown seq is acked unknown-segment, and a repeated segment_end never closes one twice', async () => {
  const wired = wire();
  await open(wired);

  wired.socket.receive({ type: 'segment_end', seq: 7, durationMs: 10, reason: 'gap' });
  const unknown = acks(wired.socket).filter((frame) => frame.state === 'dropped');
  assert.equal(unknown.length, 1, 'a segment_end for a segment never opened is refused');
  assert.equal(unknown[0]?.reason, 'unknown-segment');

  speakSegment(wired.socket, 1);
  await waitFor(() => acks(wired.socket).some((frame) => frame.seq === 1 && frame.state === 'committed'));
  const commitsAfterFirstEnd = wired.transport.sent.filter((message) => message.type === 'input_audio_buffer.commit').length;

  // The page (or a retry) sends the same end again. One segment must not become two commits.
  wired.socket.receive({ type: 'segment_end', seq: 1, durationMs: 10, reason: 'gap' });
  await tick();
  assert.equal(
    wired.transport.sent.filter((message) => message.type === 'input_audio_buffer.commit').length,
    commitsAfterFirstEnd,
    'a repeated segment_end must not commit the same segment twice',
  );
  assert.equal(acks(wired.socket).filter((frame) => frame.seq === 1).length, 1, 'and the page is not re-acked');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC5 — the handshake is neutral, and the tools ledger still carries the send and interrupt tools.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The frames one script produces, as JSON, for a byte-for-byte comparison of two runs. */
async function framesFor(offer: VoiceRealtimeInboundFrame | null): Promise<string[]> {
  const wired = wire();
  if (offer !== null) {
    wired.socket.receive(offer);
  }
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
  wired.socket.receive({ type: 'audio', audio: 'AAAA' });
  wired.socket.receive({ type: 'context', text: 'x', chars: 1, rows: 1 });
  await tick();
  return wired.socket.outbound.map((frame) => JSON.stringify(frame));
}

test('AC5: a correct hello is answered ready{segmented-v1}; the ledger still carries all three tools', async () => {
  const wired = wire();
  wired.socket.receive({ type: 'hello', protocol: 'segmented-v1' });
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'ready'));

  const ready = wired.socket.outbound.find((frame) => frame.type === 'ready');
  assert.deepEqual(ready, { type: 'ready', protocol: 'segmented-v1' }, 'the offered token is echoed, and only that token');

  // The session update goes out from the bridge's own `whenConnected` continuation, one microtask
  // behind the `open` state the wait above reads, so it is awaited rather than assumed present.
  await waitFor(() => wired.transport.sent.some((message) => message.type === 'session.update'));
  const sessionUpdate = wired.transport.sent.find((message) => message.type === 'session.update') as
    | { session?: { tools?: unknown[] } }
    | undefined;
  assert.ok(sessionUpdate !== undefined, 'the session was opened with an update');
  assert.equal(sessionUpdate.session?.tools?.length, 3, '`session_send`, `session_interrupt` and `session_status` are still declared — a zero here is a blocking finding, not a value to pin');
});

test('AC5: a wrong or missing hello leaves the frame sequence byte-identical to the continuous path', async () => {
  const wrongToken = await framesFor({ type: 'hello', protocol: 'segmented-v0' });
  const noOffer = await framesFor(null);
  assert.deepEqual(wrongToken, noOffer, 'an offer this proxy does not speak must change nothing the page sees');
  assert.equal(
    wrongToken.some((frame) => frame.startsWith('{"type":"ready"')),
    false,
    'and must never be answered with a ready frame',
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC6 — L3: the `--segments` diagnosis path, through the REAL transport and the REAL proxy.
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// The cases above drive a FAKE transport, which is the right instrument for deciding one frame at a
// time. These drive `runVoiceRealtimeDiagnosis` — the same entry point `--segments` uses — over the
// real DashScope transport, so a reading here is a reading of the pipeline an operator reaches.
// The upstream is still a fixture; what makes it an L3 reading is that nothing between the scripted
// audio and the report is re-implemented by the test.

/** A mono 16 kHz PCM16 WAV of `seconds` of a tone — what the diagnosis path is fed. */
function makeWav(seconds: number): Buffer {
  const samples = Math.floor(16_000 * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(16_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The diagnosis seams, spelled the way `server/index.ts` builds them: the real transport, over the fake upstream. */
function diagnoseSeams(
  upstream: ReturnType<typeof createFakeDashscopeServer>,
  sends: Array<Record<string, unknown>>,
): { buildSeams(observe: DashscopeWireObserver): VoiceRealtimeProxySeams } {
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { runId: 'r', queued: false };
    },
  };
  return {
    buildSeams: (observe: DashscopeWireObserver): VoiceRealtimeProxySeams => ({
      createTransport: (reportError: (error: { code: string } & Record<string, unknown>) => void) =>
        createDashscopeTransport({
          apiKey: 'sk-test',
          socketFactory: upstream.socketFactory,
          onError: reportError,
          observer: observe,
        }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
    }),
  };
}

/** What the fixture answers for one segment: the endpoint's transcript, and the model's relay (or none). */
type SegmentAnswer = { transcript: string; message: string | null };

/**
 * The fake upstream, answering PER COMMIT: the Nth `input_audio_buffer.commit` gets the Nth scripted
 * answer, so a run of several sentences has several independent endpoints behind it.
 *
 * `functionCallAfterAudioFrames: 1_000_000` silences the fixture's own auto-call — every relay here
 * is the script's, so the reading is about the guard and not about the fixture's convenience.
 *
 * The answers are delivered on a MICROTASK rather than inline: the commit is written by the bridge
 * BEFORE it announces the `committed` phase, so an inline answer would arrive while the proxy still
 * attributed deliveries to the previous segment. The real endpoint has that same gap.
 */
function scriptedSegmentUpstream(answers: readonly SegmentAnswer[]): ReturnType<typeof createFakeDashscopeServer> {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const original = upstream.socketFactory;
  const scripted: typeof original = (url, headers) => {
    const socket = original(url, headers);
    const send = socket.send.bind(socket);
    let commits = 0;
    socket.send = (data: string): void => {
      send(data);
      if ((JSON.parse(data) as { type: string }).type !== 'input_audio_buffer.commit') {
        return;
      }
      const index = commits;
      commits += 1;
      const answer = answers[index];
      if (answer === undefined) {
        return;
      }
      queueMicrotask(() => {
        // The acceptance first: it is what pairs this item with the seq whose commit created it, which
        // is what lets the proxy decide the segment from the ITEM rather than from whichever segment is
        // active when the transcript arrives. The real endpoint sends it, so a fixture that omitted it
        // would be scripting a wire that cannot happen.
        upstream.peerSend({ type: 'input_audio_buffer.committed', item_id: `item-${index}` });
        upstream.peerSend({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: `item-${index}`,
          transcript: answer.transcript,
        });
        if (answer.message !== null) {
          upstream.peerSend({
            type: 'response.function_call_arguments.done',
            call_id: `call-${index}`,
            name: 'session_send',
            arguments: JSON.stringify({ message: answer.message }),
          });
        }
        upstream.peerSend({ type: 'response.done', response: { id: `resp-${index}`, status: 'completed' } });
      });
    };
    return socket;
  };
  return { ...upstream, socketFactory: scripted } as ReturnType<typeof createFakeDashscopeServer>;
}

test('AC6: two sentences with a pause between them each deliver once, each with its own caption', async () => {
  const upstream = scriptedSegmentUpstream([
    { transcript: '第一句。', message: '第一句。' },
    { transcript: '第二句。', message: '第二句。' },
  ]);
  const sends: Array<Record<string, unknown>> = [];
  const clip = (parseWavPcm16(makeWav(0.4)) as { pcm16: Buffer }).pcm16;
  const segments = [0, 1].map(() => ({ pcm16: clip, durationMs: 400, reason: 'gap' as const }));

  const report = await runVoiceRealtimeDiagnosis(
    { boundSessionId: 'sess', pcm16: clip, speed: 8, quietMs: 150, maxMs: 15_000, segments, segmentCommit: 'manual' },
    diagnoseSeams(upstream, sends),
  );

  assert.deepEqual(report.segments.map((segment) => segment.seq), [0, 1], 'both sentences were spoken as segments');
  assert.deepEqual(report.segments.map((segment) => segment.ack), ['committed', 'committed'], 'both were taken');
  assert.deepEqual(sends.map((args) => args.message), ['第一句。', '第二句。'], 'one delivery per sentence, in order');
  assert.deepEqual(report.turns.map((turn) => turn.captions), [['第一句。'], ['第二句。']], 'each sentence carries its caption');
  assert.equal(report.frames.some((frame) => frame.type === 'segment_ack' && frame.state === 'dropped'), false, 'nothing was refused');
});

test('AC6: a 25 s monologue cut by the ceiling, whose transcript comes back empty, delivers nothing', async () => {
  const upstream = scriptedSegmentUpstream([{ transcript: '', message: '（用户没有说话）' }]);
  const sends: Array<Record<string, unknown>> = [];
  const clip = (parseWavPcm16(makeWav(25)) as { pcm16: Buffer }).pcm16;

  const report = await runVoiceRealtimeDiagnosis(
    {
      boundSessionId: 'sess',
      pcm16: clip,
      speed: 32,
      quietMs: 150,
      maxMs: 15_000,
      segments: [{ pcm16: clip, durationMs: 25_000, reason: 'max' }],
      segmentCommit: 'manual',
    },
    diagnoseSeams(upstream, sends),
  );

  assert.equal(report.segments[0]?.reason, 'max', 'the ceiling is what cut the segment');
  assert.notEqual(report.segments[0]?.ack, 'pending', 'the page was told what became of the segment');
  assert.equal(sends.length, 0, 'an empty transcript must not deliver a message');
  assert.equal(report.turns[0]?.sentMessages.length, 0, 'and the report says the segment sent nothing');
  assert.equal(
    report.frames.some((frame) => frame.type === 'error' && frame.recoverable !== true),
    false,
    'and nothing threw or faulted',
  );
});
