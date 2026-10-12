/**
 * Teardown races: what a committed segment's answer does when the browser has already gone.
 *
 * THE SECOND HALF OF THE 2026-10-11 DEFECT. The first half — an empty transcript producing an
 * invented message — is pinned in `voice-realtime-empty-transcript-guard.test.ts`. The second is
 * this one: the connection's LAST segment was answered AFTER the browser socket closed, and the
 * answer simply vanished.
 *
 *     18:39:07.906  segment committed
 *     18:39:07.906  browser socket closed
 *     18:39:09.252  << transcription.completed "这信号还可以啊。"
 *     18:39:09.419  << function_call session_send {"message": "这信号还可以啊。"}
 *
 * Nothing was thrown and nothing was recorded. The operator could not tell "the relay was refused on
 * purpose" from "the relay never happened" — and for a message the user actually spoke, that gap is
 * the difference between a bug report and silence.
 *
 * WHAT IS GUARANTEED, AND WHERE THE WINDOW ENDS. There is a real window in which the bridge is still
 * subscribed after the browser socket is gone: `teardown` closes the upstream transport, and the
 * subscription is dropped only once that close RESOLVES — for a real socket, after the endpoint's
 * queued events have been delivered. An event landing in that window reaches the delivery point, and
 * the guard there records it as `not-delivered (socket closed)`. Past it the transport is gone and
 * there is no event to record; these cases pin the window that exists rather than pretend to one
 * that does not.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-teardown-races.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
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

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

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

function wire(options: { transcriptGraceMs?: number } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createRecordingExecutor();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
    log: (line) => logs.push(line),
    ...(options.transcriptGraceMs === undefined ? {} : { transcriptGraceMs: options.transcriptGraceMs }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, base, logs };
}

async function open(wired: Wired): Promise<void> {
  wired.socket.receive({ type: 'hello', protocol: 'segmented-v1' });
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** The three browser frames that make up one segment, in the order the page sends them. */
function sendSegment(wired: Wired, seq: number): void {
  wired.socket.receive({ type: 'segment_start', seq, startedAtMs: 0 });
  wired.socket.receive({ type: 'audio', audio: 'U0VHTUVOVA==', seq });
  wired.socket.receive({ type: 'segment_end', seq, durationMs: 19200, reason: 'max' });
}

/**
 * One segment TAKEN BY THE ENDPOINT, then the `committed` ack the page is owed.
 *
 * The ack is the endpoint's own verdict, so the fixture has to speak for the endpoint. This
 * connection speaks the default protocol (`segmentCommit` is unset, which resolves to `manual` —
 * see `resolveSegmentSelection`), so what proves the segment was taken is the endpoint's own
 * `input_audio_buffer.committed` for the item its commit created. The frames alone are no longer
 * enough: they say what the APP wrote, and the ack stopped answering for that (see the proxy's
 * `onSegmentPhase`), which is exactly why a segment committed onto a dying socket no longer reads
 * as taken.
 *
 * A segment whose frames have gone out WITHOUT this answer is what `sendSegment` alone is for — no
 * item, hence no transcript yet, which is the state the held-relay case below needs.
 */
async function commitSegment(wired: Wired, seq: number): Promise<void> {
  sendSegment(wired, seq);
  wired.transport.peerSend({ type: 'input_audio_buffer.committed', item_id: `item-${seq}` } as RealtimeServerMessage);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'segment_ack' && frame.seq === seq));
}

const acks = (socket: FakeBrowserSocket): Array<Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }>> =>
  socket.outbound.filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }> => frame.type === 'segment_ack');

/** The journal the recorder would have written for these log lines — the shipping classifier, fed by the proxy. */
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

const sendEntries = (entries: readonly VoiceRealtimeLogEntry[]) =>
  entries.filter((entry): entry is Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }> => entry.kind === 'session_send');

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — the post-close window.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC4: a transcript and a relay arriving after the browser socket closed are refused and RECORDED', async () => {
  const wired = wire();
  await open(wired);
  // The same order the journal recorded: 18:39:07.906 the segment was committed (and taken), and
  // only THEN did the connection go — its words came back at 18:39:09.252, into a socket that was
  // already gone.
  await commitSegment(wired, 0);

  // The browser goes. The upstream is still subscribed — the transport's close has not resolved —
  // which is exactly the window the real defect's last segment landed in.
  wired.socket.close();

  // The answer to the committed segment, arriving over that window. None of it may throw: these run
  // from the transport's message handler, and an escaping exception takes the whole process down.
  assert.doesNotThrow(() => {
    wired.transport.peerSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-0',
      transcript: '这信号还可以啊。',
    } as RealtimeServerMessage);
    wired.transport.peerSend({
      type: 'function_call',
      name: 'session_send',
      callId: 'call-1',
      arguments: JSON.stringify({ message: '这信号还可以啊。' }),
    } as RealtimeServerMessage);
    wired.transport.peerSend({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } } as RealtimeServerMessage);
  }, 'post-close upstream events must be dropped, not thrown');

  await tick();

  // A real thing was said and it did NOT reach a session — but the absence is a recorded fact, so
  // "refused" and "never happened" are told apart by reading the journal.
  assert.equal(wired.base.calls.length, 0, 'nothing was delivered to a session that is gone');
  const recorded = sendEntries(journalOf(wired.logs));
  assert.equal(recorded.length, 1, 'the refusal is recorded, not silently dropped');
  assert.equal(recorded[0]?.outcome, 'not-delivered');
  assert.equal(recorded[0]?.reason, 'socket closed');
  assert.match(recorded[0]?.line ?? '', /^session_send not-delivered \(socket closed\)$/);
  assert.equal(recorded.some((entry) => entry.outcome === 'delivered'), false, 'and no delivery is claimed');
});

test('AC4: a segment cut in half by the teardown leaves a held relay recorded, not vanished', async () => {
  // A long grace, so the ONLY thing that can release the held call is the teardown itself: if the
  // release path were missing, this test would hang on a timer instead of passing by accident.
  const wired = wire({ transcriptGraceMs: 60_000 });
  await open(wired);
  // Frames only: the whole point of this case is a segment whose transcript is STILL UNKNOWN.
  sendSegment(wired, 0);

  // The model relays while the segment's transcript is still unknown, so the call is HELD.
  wired.transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId: 'call-1',
    arguments: JSON.stringify({ message: '这信号还可以啊。' }),
  } as RealtimeServerMessage);
  await tick();
  assert.equal(wired.base.calls.length, 0, 'the call is held pending the segment transcript');

  // The browser vanishes mid-segment. The held call will never get its transcript.
  assert.doesNotThrow(() => wired.socket.close(), 'tearing down a connection with a held relay must not throw');
  await tick();

  assert.equal(wired.base.calls.length, 0, 'the held relay is not delivered into a gone connection');
  const recorded = sendEntries(journalOf(wired.logs));
  assert.equal(recorded.length, 1, 'the teardown recorded the held relay');
  assert.equal(recorded[0]?.outcome, 'not-delivered');
  assert.equal(recorded[0]?.reason, 'socket closed');
});

test('AC4: frames arriving after teardown are dropped, never thrown, and the committed segment is acked', async () => {
  const wired = wire();
  await open(wired);
  await commitSegment(wired, 0);
  assert.equal(acks(wired.socket).some((frame) => frame.state === 'committed'), true, 'the segment was acknowledged before the close');

  wired.socket.close();
  assert.doesNotThrow(() => {
    wired.socket.receive({ type: 'audio', audio: 'POST==', seq: 0 });
    wired.socket.receive({ type: 'segment_end', seq: 0, durationMs: 10, reason: 'gap' });
    wired.socket.receive({ type: 'segment_start', seq: 1 });
  }, 'frames after teardown are dropped, not thrown');
  await tick();

  assert.equal(wired.base.calls.length, 0, 'and none of them produced a message');
});
