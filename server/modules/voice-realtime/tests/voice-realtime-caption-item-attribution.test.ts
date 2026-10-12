/**
 * Which SEGMENT a transcription belongs to — decided by the endpoint's item id, not by whichever
 * segment happened to be open when the words landed.
 *
 * THE DEFECT THIS PINS. The endpoint transcribes asynchronously, and the journal of 2026-10-12
 * (`~/.cloudcli/voice-realtime-log/ef9daacd-*.jsonl`) shows its answers arriving well after the commit
 * that produced them, and one segment never transcribed at all. The relay used to attribute every
 * transcript to `activeSegmentSeq`, the segment that happened to be open when the words arrived. For a
 * NON-empty transcript that is merely a wrong label; for an EMPTY one it refuses the wrong segment's
 * genuine relay — the variant V reading in `e2e/voice-realtime-segmented-replay-20261012.spec.ts`,
 * where a late empty transcript for segment C marked the ACTIVE segment empty and threw away the words
 * the person had actually spoken.
 *
 * WHAT REPLACES IT. The endpoint's `input_audio_buffer.committed` accepts a commit and names the item
 * it created; `conversation.item.input_audio_transcription.completed` names the same item. The item id
 * is therefore the one key that survives the reordering. The bridge owns both sides — it writes the
 * commit and reads the answer — so it pairs them (`pendingCommitSeqs` → `onUserAudioCommitted`) and
 * this service resolves a transcript's segment from the item (`segmentSeqByItemId` →
 * `segmentSeqForCaption`). An item created by the endpoint's OWN detector belongs to no commit of
 * ours; it resolves to `null`, and `null` is reported as `null` rather than defaulted to the active
 * segment.
 *
 * ONE PROPERTY OF THE WIRE EVERY FIXTURE HERE RESPECTS: the endpoint answers commits IN THE ORDER THEY
 * WERE SENT, so the Nth `input_audio_buffer.committed` pairs with the Nth outstanding commit. A
 * fixture that delivered one acceptance for two outstanding commits would be scripting a wire that
 * cannot happen, and it would pair the item with the wrong seq for a reason of the fixture's own.
 *
 * THE FIRST GROUP IS THE FALSE FORM (AC1): the shipping service is copied beside itself with
 * `segmentSeqForCaption` put back to `return activeSegmentSeq;`, and the same scenario is run through
 * both, so the reading every later group depends on is shown to go RED rather than being green for a
 * reason of its own. The last group replays the journal's own frame order and reads the per-segment
 * attribution table out of it (the task's DoD).
 *
 * Consumers: the quay worker's AC state for
 * `gap-live-voice-caption-segment-attribution-by-item-id`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  REALTIME_TOOLS,
  connect,
  type RealtimeBridge,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
} from '../index.js';
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

type Handler = typeof handleVoiceRealtimeConnection;
type AckFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }>;
type CaptionFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }>;

/**
 * A minimal stand-in for the browser's `ws.WebSocket` — the surface the proxy uses, driven over
 * `EventEmitter` so nothing binds at the OS level. Same shape as the sibling suites'.
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

/** The executor stand-in: records every `session_send` the proxy decided to deliver, never fails. */
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

/**
 * One proxy connection over a fake browser socket, a fake upstream, and a recording log seam.
 *
 * `segmentCommit: 'manual'` is pinned rather than inherited: manual IS the shipping path (one commit
 * per segment, the endpoint's detector off), and this file is about attributing a commit's answer.
 * The fallback's own anchoring is a different fact with its own reading below.
 */
function wire(options: { handler?: Handler; transcriptGraceMs?: number; segmentCommit?: 'manual' | 'server-vad' } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createRecordingExecutor();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
    // Pin the relay mode instead of inheriting `VOICE_REALTIME_MODE`: without this the connection
    // falls back to the ambient variable, and an environment that says `continuous` sends no `ready`
    // frame, so the handshake wait below times out on something attribution has nothing to do with.
    segmentedRelay: true,
    segmentCommit: options.segmentCommit ?? 'manual',
    log: (line) => logs.push(line),
    ...(options.transcriptGraceMs === undefined ? {} : { transcriptGraceMs: options.transcriptGraceMs }),
  };
  const handler = options.handler ?? handleVoiceRealtimeConnection;
  handler(socket as unknown as Parameters<Handler>[0], 'session-under-test', seams);
  return { socket, transport, base, logs };
}

/** Offers the segmented protocol and waits for the session to be open and usable. */
async function open(wired: Wired): Promise<void> {
  wired.socket.receive({ type: 'hello', protocol: 'segmented-v1' });
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** One audio frame, in the shape the browser relays it: base64 of one 100 ms pcm16 chunk. */
const AUDIO_FRAME = 'U0VHTUVOVA==';

/** One committed segment: start, one audio frame, end. */
function speakSegment(socket: FakeBrowserSocket, seq: number, reason: 'gap' | 'max' = 'gap', durationMs = 100): void {
  socket.receive({ type: 'segment_start', seq, startedAtMs: 0 });
  socket.receive({ type: 'audio', audio: AUDIO_FRAME, seq });
  socket.receive({ type: 'segment_end', seq, durationMs, reason });
}

/**
 * The endpoint ACCEPTING a commit: its `input_audio_buffer.committed` for the item that commit
 * created. This is the frame that carries the item id, and the only one that pairs an item with the
 * `seq` whose commit produced it.
 */
function commitItem(transport: FakeTransport, itemId: string): void {
  transport.peerSend({ type: 'input_audio_buffer.committed', item_id: itemId } as RealtimeServerMessage);
}

/** The endpoint's FINAL transcription of one item — the words it heard, for the item it names. */
function transcript(transport: FakeTransport, itemId: string, text: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  } as RealtimeServerMessage);
}

/** The endpoint's whole report about one utterance, when its acceptance is the next one owed. */
function transcribe(transport: FakeTransport, itemId: string, text: string): void {
  commitItem(transport, itemId);
  transcript(transport, itemId, text);
}

/**
 * The endpoint REFUSING a commit, in its own words.
 *
 * A refusal creates NO item and is followed by no `input_audio_buffer.committed` — the journal logged
 * it three times this way (07:47:49.034Z for seq1, 07:49:04.873Z for seq6, 07:49:22.919Z for seq8),
 * each time followed by `speech_started` and an item the endpoint's own detector created.
 */
function refuseCommit(
  transport: FakeTransport,
  message = 'Error committing input audio buffer: buffer too small, or have no audio.',
): void {
  transport.peerSend({ type: 'error', error: { code: 'invalid_request_error', message } } as RealtimeServerMessage);
}

/** A user item the endpoint created by itself — no acceptance of ours names it. */
function endpointUserItem(transport: FakeTransport, itemId: string): void {
  transport.peerSend({ type: 'input_audio_buffer.speech_started' } as RealtimeServerMessage);
  transport.peerSend({
    type: 'conversation.item.created',
    item: { id: itemId, type: 'message', role: 'user' },
  } as RealtimeServerMessage);
}

/** The model's relay, as the real wire reports it. */
function relay(transport: FakeTransport, callId: string, message: string): void {
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  } as RealtimeServerMessage);
}

/** The upstream closing the response a commit asked for: nothing more is coming for that `seq`. */
function responseDone(transport: FakeTransport, id = 'resp-1'): void {
  transport.peerSend({ type: 'response.done', response: { id, status: 'completed' } } as RealtimeServerMessage);
}

const acks = (socket: FakeBrowserSocket): AckFrame[] =>
  socket.outbound.filter((frame): frame is AckFrame => frame.type === 'segment_ack');
const captions = (socket: FakeBrowserSocket): CaptionFrame[] =>
  socket.outbound.filter((frame): frame is CaptionFrame => frame.type === 'caption');

/** The acks as `seq:state[:reason]`, which is how a reader compares two runs at a glance. */
const ackStrings = (socket: FakeBrowserSocket): string[] =>
  acks(socket).map((frame) => `${frame.seq}:${frame.state}${frame.reason === undefined ? '' : `:${frame.reason}`}`);

/** The caption frames as `seq=itemId:text` — the attribution table's rows. */
const captionRows = (socket: FakeBrowserSocket): string[] =>
  captions(socket).map((frame) => `${frame.seq}=${frame.itemId}:${frame.text}`);

/** Yields to the microtask queue and one timer turn, so an async delivery that was going to happen has. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * The grace this file pins on the relay (`SEGMENT_TRANSCRIPT_GRACE_MS` is 600 ms in production,
 * which would put every held call's decision outside a test's own lifetime).
 */
const LATE_TRANSCRIPT_GRACE_MS = 120;

/**
 * The journal the recorder would have written for these log lines.
 *
 * The recorder is the SHIPPING classifier — fed the proxy's own captured lines and an in-memory
 * store — so "the journal records no delivery" is asserted against the code that writes the journal,
 * not against a hand-rolled reading of the strings.
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
  entries.filter(
    (entry): entry is Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }> =>
      entry.kind === 'session_send' && entry.outcome === 'delivered',
  );

// ── the false forms ───────────────────────────────────────────────────────────────────────────

/** Where the shipping modules and their falsify copies live. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(HERE, '..');
const SHIPPING_PROXY_MODULE = path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts');
const SHIPPING_BRIDGE_MODULE = path.join(MODULE_DIR, 'voice-realtime-bridge.service.ts');
/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Writes a mutated copy of one shipping module beside it, runs `body` against the base and the mutant
 * paths, and removes both copies in a `finally`. The anchor must occur once — a mutation that
 * silently matched nothing would redden nothing and read as a green.
 */
async function withMutantCopy<T>(
  modulePath: string,
  anchor: string,
  mutation: string,
  label: string,
  body: (basePath: string, mutPath: string) => Promise<T>,
): Promise<T> {
  const source = readFileSync(modulePath, 'utf8');
  assert.equal(countOccurrences(source, anchor), 1, `the ${label} anchor must occur exactly once`);
  const basePath = ownCopy(`${label}-base`);
  const mutPath = ownCopy(`${label}-mut`);
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(anchor, mutation), 'utf8');
    return await body(basePath, mutPath);
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
}

/** Imports the service by path; the specifier is dynamic, so it is typed structurally here. */
async function importProxy(modulePath: string): Promise<{ handleVoiceRealtimeConnection: Handler }> {
  return (await import(pathToFileURL(modulePath).href)) as { handleVoiceRealtimeConnection: Handler };
}

/** Imports the bridge by path — the entry point its own criteria drive it through. */
async function importBridge(modulePath: string): Promise<{ connect: typeof connect }> {
  return (await import(pathToFileURL(modulePath).href)) as { connect: typeof connect };
}

/**
 * The pre-fix attribution rule, as one function body: whichever segment was ACTIVE when the transcript
 * landed.
 *
 * This is the whole of the old decision — the item id was not consulted, because nothing paired an
 * item with a `seq` — so restoring it is what makes every reading below a reading of the fix.
 */
const ACTIVE_SEGMENT_BODY = [
  '  const segmentSeqForCaption = (itemId: string): number | null => {',
  '    void itemId;',
  '    return activeSegmentSeq;',
  '  };',
].join('\n');

/** The shipping rule, verbatim, so a mutation can be expressed as a replacement of it. */
const ITEM_ID_BODY = [
  '  const segmentSeqForCaption = (itemId: string): number | null => {',
  "    const mapped = itemId === '' ? undefined : segmentSeqByItemId.get(itemId);",
  '    if (mapped !== undefined) {',
  '      return mapped;',
  '    }',
  "    if (segmentCommitMode === 'server-vad') {",
  '      return awaitingTranscriptionSeqs[0] ?? null;',
  '    }',
  '    return null;',
  '  };',
].join('\n');

/**
 * Two segments committed and BOTH of their commits ACCEPTED, in order — so `item-1` pairs with seq1
 * and the caller is free to land seq0's transcript whenever it likes.
 *
 * The caller's scenario is the endpoint's asynchrony: seq0's words arriving while seq1 is the segment
 * the relay has open.
 *
 * The grace is pinned SHORT so a held call is decided inside the test's own lifetime. It is pinned at
 * all because the value defaults to {@link SEGMENT_TRANSCRIPT_GRACE_MS} and the relay, not the test,
 * owns the wait.
 */
async function twoSegmentsAccepted(handler: Handler): Promise<Wired> {
  const wired = wire({ handler, transcriptGraceMs: LATE_TRANSCRIPT_GRACE_MS });
  await open(wired);
  speakSegment(wired.socket, 0);
  speakSegment(wired.socket, 1);
  await waitFor(() => acks(wired.socket).length === 2);
  commitItem(wired.transport, 'item-0');
  commitItem(wired.transport, 'item-1');
  await tick();
  return wired;
}

/**
 * A reading of the relay's disposition taken BEFORE the relay, so the wait below is about THIS call.
 *
 * Not a detail: an earlier segment of the same scenario may already have been refused, and a wait
 * phrased as "some ack is dropped" would be satisfied by that older ack — reading the call while it is
 * still held, which is a reading of nothing. Measured: it read a delivery as `[]` exactly that way.
 */
function relayBaseline(wired: Wired): { calls: number; dropped: number } {
  return {
    calls: wired.base.calls.length,
    dropped: acks(wired.socket).filter((frame) => frame.state === 'dropped').length,
  };
}

/**
 * Waits for THIS relay's disposition, whichever way it went: a delivery, a refusal, or the hold
 * failing open because its segment is never transcribed at all.
 *
 * A BOUNDED POLL RATHER THAN A `waitFor`, because a refusal of a segment that was ALREADY marked
 * empty is silent: the second `markSegmentEmpty` is deduped, no delivery happens, and no error frame
 * is raised, so there is no frame to wait on. The window is the hold's grace plus a margin — the
 * decision cannot arrive later than that — and the poll still returns the instant a delivery lands,
 * so a green run costs one tick.
 */
async function relaySettled(wired: Wired, before: { calls: number; dropped: number }): Promise<void> {
  const decided = (): boolean =>
    wired.base.calls.length > before.calls ||
    acks(wired.socket).filter((frame) => frame.state === 'dropped').length > before.dropped ||
    wired.socket.outbound.some((frame) => frame.type === 'error');
  const deadline = Date.now() + LATE_TRANSCRIPT_GRACE_MS + 480;
  while (!decided() && Date.now() < deadline) {
    await tick();
  }
  await tick();
}

/**
 * One run of the late-transcript scenario: seq0's transcript arriving after seq1's commit, then the
 * model relaying the words the person spoke in seq1 — the delivery a wrong attribution destroys when
 * seq0 was transcribed as silence.
 */
async function driveLateTranscript(
  handler: Handler,
  text: string,
): Promise<{ acks: string[]; rows: string[]; delivered: string[] }> {
  const wired = await twoSegmentsAccepted(handler);
  transcript(wired.transport, 'item-0', text);
  await tick();
  const before = relayBaseline(wired);
  relay(wired.transport, 'call-1', '第二句话。');
  await relaySettled(wired, before);
  return {
    acks: ackStrings(wired.socket),
    rows: captionRows(wired.socket),
    delivered: wired.base.calls.map((call) => String(call.args.message)),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — the false form, FIRST: attribute by the active segment and the NEXT segment is marked.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC1 false form: attributing a late transcript by the ACTIVE segment marks the NEXT segment empty', async () => {
  await withMutantCopy(SHIPPING_PROXY_MODULE, ITEM_ID_BODY, ACTIVE_SEGMENT_BODY, 'active-segment-attribution', async (basePath, mutPath) => {
    const base = await importProxy(basePath);
    const mutant = await importProxy(mutPath);

    const green = await driveLateTranscript(base.handleVoiceRealtimeConnection, '');
    const red = await driveLateTranscript(mutant.handleVoiceRealtimeConnection, '');

    // The fix: seq0's own empty transcript marks seq0, and seq1's relay is delivered.
    assert.deepEqual(green.acks, ['0:committed', '1:committed', '0:dropped:empty-transcript'], 'the empty transcript answers the segment it was spoken in');
    assert.deepEqual(green.delivered, ['第二句话。'], 'and the segment that carried words is relayed');

    // The false form: the same transcript marks seq1 — a segment the endpoint never called empty —
    // and the words the person actually spoke are thrown away with it.
    assert.ok(
      red.acks.includes('1:dropped:empty-transcript'),
      `attributing by the active segment marks seq1, the segment the transcript does NOT belong to: ${JSON.stringify(red.acks)}`,
    );
    assert.deepEqual(red.delivered, [], 'and seq1`s genuine relay is refused on that false reading');
  });
});

test('AC1: the false forms leave none of this process`s copies behind', () => {
  const leftovers = readFileSync(SHIPPING_PROXY_MODULE, 'utf8').includes(TEMP_PREFIX);
  assert.equal(leftovers, false, 'the shipping module must not be a falsify copy');
  assert.deepEqual(
    readdirSync(MODULE_DIR).filter((name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`)),
    [],
    'a falsify copy outlives the test that wrote it',
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — a late transcript acts on ITS OWN segment, in both of its consequences.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC2: a late EMPTY transcript for seq N does not refuse seq N+1`s genuine relay', async () => {
  const wired = await twoSegmentsAccepted(handleVoiceRealtimeConnection);

  transcript(wired.transport, 'item-0', '');
  await tick();
  const before = relayBaseline(wired);
  relay(wired.transport, 'call-1', '第二句话。');
  await relaySettled(wired, before);

  assert.deepEqual(ackStrings(wired.socket), ['0:committed', '1:committed', '0:dropped:empty-transcript'], 'the refusal names the segment the endpoint called empty');
  assert.deepEqual(wired.base.calls.map((call) => call.args.message), ['第二句话。'], 'the segment that carried words still reaches the session');
  assert.equal(wired.logs.some((line) => line.includes('segment 1 dropped')), false, 'and the journal does not call seq1 silent');
});

test('AC2: a late NON-empty transcript for seq N is labelled with seq N, not with the open segment', async () => {
  const wired = await twoSegmentsAccepted(handleVoiceRealtimeConnection);

  transcript(wired.transport, 'item-0', '第一句话。');
  await tick();
  const before = relayBaseline(wired);
  relay(wired.transport, 'call-1', '第二句话。');
  await relaySettled(wired, before);

  // The caption is the page's only view of this: the words must carry the segment they were SPOKEN
  // in, and an implementation that read the open segment would label them seq1.
  assert.deepEqual(captionRows(wired.socket), ['0=item-0:第一句话。'], 'the words are labelled with their own segment');
  assert.deepEqual(ackStrings(wired.socket), ['0:committed', '1:committed'], 'nothing was refused');
  assert.deepEqual(wired.base.calls.map((call) => call.args.message), ['第二句话。'], 'and the open segment`s relay is untouched');
});

test('AC2: a relay held for seq N is decided by seq N`s own transcript', async () => {
  // A grace far beyond the test's own lifetime, so the only thing that can release the hold is the
  // transcript: were it released by the timer instead, the call would fail OPEN and be delivered.
  const wired = wire({ transcriptGraceMs: 60_000 });
  await open(wired);
  speakSegment(wired.socket, 1);
  await waitFor(() => acks(wired.socket).length === 1);

  // The model relays while seq1's transcript is not yet known: the call is held, not delivered.
  relay(wired.transport, 'call-1', '（用户没有说话）');
  await tick();
  assert.equal(wired.base.calls.length, 0, 'a call whose segment is untranscribed is held');

  // seq1's own empty transcript is what decides it — and it refuses the held call rather than
  // letting the grace elapse and deliver a message nobody said.
  transcribe(wired.transport, 'item-1', '');
  await waitFor(() => acks(wired.socket).some((frame) => frame.state === 'dropped'));
  await tick();
  assert.equal(wired.base.calls.length, 0, 'the hold is released by its own segment`s transcript, and refused');
  assert.deepEqual(ackStrings(wired.socket), ['1:committed', '1:dropped:empty-transcript']);

  // The 60 s grace is still outstanding; closing the connection is what clears it.
  wired.socket.close();
  await tick();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — a refused commit, and an item no commit of ours created. Neither goes to the active segment.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * One run of the refusal scenario: seq0's commit is refused (no item is created for it), then seq1 is
 * spoken and its own commit is ACCEPTED under `item-1`.
 *
 * The load-bearing reading is the table: if the refused slot is not released, the next accepted commit
 * claims it and `item-1` — hence seq1's own words — is attributed to the refused seq0.
 */
async function driveRefusedCommit(handler: Handler): Promise<{ acks: string[]; rows: string[]; logs: string[] }> {
  const wired = wire({ handler });
  await open(wired);
  speakSegment(wired.socket, 0);
  await waitFor(() => acks(wired.socket).length === 1);
  refuseCommit(wired.transport);
  await tick();

  speakSegment(wired.socket, 1);
  await waitFor(() => acks(wired.socket).some((frame) => frame.seq === 1));
  transcribe(wired.transport, 'item-1', '第二句话。');
  await tick();
  return { acks: ackStrings(wired.socket), rows: captionRows(wired.socket), logs: wired.logs };
}

test('AC3: a refused commit is answered `dropped:commit-refused`, and its slot is not claimed by the next commit', async () => {
  const run = await driveRefusedCommit(handleVoiceRealtimeConnection);

  assert.deepEqual(run.acks, ['0:committed', '0:dropped:commit-refused', '1:committed'], 'the refused segment is answered, and answered once');
  // The endpoint created no item for seq0 — a refusal is followed by no acceptance — so if the queue
  // still held seq0, `item-1` would map to it and this row would read `0=item-1`.
  assert.deepEqual(run.rows, ['1=item-1:第二句话。'], 'the refused seq does not absorb the next commit`s item');
  assert.equal(run.logs.some((line) => line.includes('refused by the endpoint')), true, 'and the refusal is on the connection`s record');
});

/**
 * The refusal scenario one level down: the BRIDGE driven directly, with the two hooks the relay
 * consumes.
 *
 * WHY NOT THROUGH THE PROXY. The slot that must be released on a refusal is the bridge's own
 * `pendingCommitSeqs`, and the proxy holds a STATIC import of the shipping bridge — a mutated copy
 * written beside it is never the one the proxy talks to. Driving the mutant through the proxy
 * therefore reads the shipping bridge and reports it as a false form: measured, and it read green on
 * both sides until this was moved here. The pairing the proxy reads is exactly what these two hooks
 * carry, so the unit surface is the same fact one seam closer.
 */
async function driveBridgeRefusal(connectFn: typeof connect): Promise<{
  rejected: number[];
  committed: Array<{ itemId: string; seq: number | null }>;
}> {
  const transport = createFakeTransport();
  const rejected: number[] = [];
  const committed: Array<{ itemId: string; seq: number | null }> = [];
  const bridge: RealtimeBridge = connectFn(transport, REALTIME_TOOLS, {}, {
    segment: { commitMode: 'manual' },
    hooks: {
      onSegmentCommitRejected: (event) => rejected.push(event.seq),
      onUserAudioCommitted: (event) => committed.push({ itemId: event.itemId, seq: event.seq }),
    },
  });
  await bridge.whenConnected();

  // seq0: committed, and the endpoint REFUSES it. A refusal creates no item, so nothing pairs with it.
  bridge.startSegment(0);
  bridge.sendSegmentAudio(0, AUDIO_FRAME);
  bridge.endSegment(0);
  refuseCommit(transport);
  // seq1: committed and ACCEPTED, under the only item id an acceptance names.
  bridge.startSegment(1);
  bridge.sendSegmentAudio(1, AUDIO_FRAME);
  bridge.endSegment(1);
  commitItem(transport, 'item-1');
  await tick();
  return { rejected, committed };
}

test('AC3 false form: a refused seq left in the queue is claimed by the next commit`s item', async () => {
  const RELEASE = '      if (pendingCommitSeqs.length > 0 && COMMIT_REFUSAL.test(detailMessage)) {';
  await withMutantCopy(SHIPPING_BRIDGE_MODULE, RELEASE, '      if (false) {', 'refusal-does-not-release', async (basePath, mutPath) => {
    const base = await importBridge(basePath);
    const mutant = await importBridge(mutPath);

    const green = await driveBridgeRefusal(base.connect);
    assert.deepEqual(green.rejected, [0], 'unmutated: the refused commit is reported, so a consumer can mark its seq');
    assert.deepEqual(green.committed, [{ itemId: 'item-1', seq: 1 }], 'and the next commit`s item is paired with ITS OWN seq');

    // Without the release the refusal is never reported AND the refused slot is still queued, so the
    // next accepted commit claims it: seq1`s words are attributed to seq0, which was never transcribed.
    const red = await driveBridgeRefusal(mutant.connect);
    assert.deepEqual(red.rejected, [], 'without the release, the refusal is never reported at all');
    assert.deepEqual(red.committed, [{ itemId: 'item-1', seq: 0 }], 'and seq1`s item is paired with the REFUSED seq0');
  });
});

test('AC3: an item the endpoint created by itself belongs to no seq, and is reported as `null`', async () => {
  const wired = wire();
  await open(wired);
  speakSegment(wired.socket, 0);
  await waitFor(() => acks(wired.socket).length === 1);

  // The journal's own shape after seq1's refusal (07:47:49.507Z): no acceptance of ours names this
  // item — the endpoint's detector created it — and `speech_started` announces it.
  endpointUserItem(wired.transport, 'item_B5xbXwo6VjzvvwgvdgzvL');
  await tick();
  transcript(wired.transport, 'item_B5xbXwo6VjzvvwgvdgzvL', '');
  await tick();

  const rows = captions(wired.socket);
  assert.equal(rows.length, 1, 'the endpoint`s own item is still reported to the page');
  assert.equal(rows[0]?.seq, null, 'but it belongs to no segment this relay closed, and `null` says so');
  assert.equal(rows[0]?.itemId, 'item_B5xbXwo6VjzvvwgvdgzvL', 'and it carries the item the endpoint created');
  assert.deepEqual(ackStrings(wired.socket), ['0:committed'], 'the open segment is not marked empty on its account');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — the page is told both halves of the attribution: the seq and the item it came from.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC4: a caption frame carries the seq the words were spoken in and the endpoint`s item id', async () => {
  const wired = await twoSegmentsAccepted(handleVoiceRealtimeConnection);

  transcript(wired.transport, 'item-1', '第二句话。');
  await waitFor(() => captions(wired.socket).length === 1);

  assert.deepEqual(
    captions(wired.socket)[0],
    { type: 'caption', itemId: 'item-1', text: '第二句话。', final: true, seq: 1 },
    'the frame the page places the words with',
  );
});

test('AC4: the fallback`s own anchor is the oldest segment still awaiting a transcription', async () => {
  // No commit of ours exists in this mode — the endpoint's detector chose the boundary — so an item id
  // pairs with nothing. What orders a transcript to a segment here is the segment's closing silence,
  // which is why the queue of segments still awaiting one is the anchor.
  const wired = wire({ segmentCommit: 'server-vad' });
  await open(wired);
  speakSegment(wired.socket, 0);
  speakSegment(wired.socket, 1);
  await tick();

  transcript(wired.transport, 'item_endpoint_own', '第一句话。');
  await waitFor(() => captions(wired.socket).length === 1);
  transcript(wired.transport, 'item_endpoint_own_2', '第二句话。');
  await waitFor(() => captions(wired.socket).length === 2);

  assert.deepEqual(
    captionRows(wired.socket),
    ['0=item_endpoint_own:第一句话。', '1=item_endpoint_own_2:第二句话。'],
    'each transcript closes the oldest segment still awaiting one, in order',
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC5 — the pin that nothing auto-forwards: a transcript the model never relayed reaches nothing.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC5: a transcript the model never relays is delivered to Claude zero times', async () => {
  const wired = wire();
  await open(wired);

  // Four segments with words, none of them relayed — the shape of a session where the model stayed
  // silent. Attribution must not become a delivery path: the transcript is the page's to display.
  for (const [seq, text] of [[0, '第一句话。'], [1, '第二句话。'], [2, '第三句话。'], [3, '第四句话。']] as const) {
    speakSegment(wired.socket, seq);
    await waitFor(() => acks(wired.socket).some((frame) => frame.seq === seq));
    transcribe(wired.transport, `item-${seq}`, text);
    responseDone(wired.transport, `resp-${seq}`);
  }
  await tick();

  assert.equal(wired.base.calls.length, 0, 'no transcript reaches the session on its own');
  assert.equal(
    wired.socket.outbound.some((frame) => frame.type === 'sent' || frame.type === 'queued' || frame.type === 'refused'),
    false,
    'and the page is never told a delivery was accepted for one',
  );
  assert.equal(deliveredSends(journalOf(wired.logs)).length, 0, 'the journal records no delivery');
  // The captions DID reach the page — this is a zero about delivery, not about silence.
  assert.deepEqual(captionRows(wired.socket), [
    '0=item-0:第一句话。',
    '1=item-1:第二句话。',
    '2=item-2:第三句话。',
    '3=item-3:第四句话。',
  ]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DoD — the journal`s own frame order, replayed, and the per-segment attribution table read out.
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Real proxy + real bridge over the fake transport; every endpoint frame below is the 2026-10-12
// journal `ef9daacd` in its own order, with the journal's own item ids. Zero cloud calls: the only
// peer is this process. `settled` marks the steps whose response the journal closed with a
// `response.done` (seq0, 1, 5, 7, 8) — the stalled ones it never closed, and reading that from the
// journal rather than closing every step is what keeps the attribution window the journal's.
//
// ONE THING THE JOURNAL CANNOT SUPPLY, SAID PLAINLY: its log line for `input_audio_buffer.committed`
// prints no item id, and seq2 has no `conversation.item.created` line either, so seq2's item id is not
// recoverable from the file. It is named `item_scripted_2` below and is the only id the journal does
// not spell out. Every transcript's TEXT and POSITION is the journal's.

/** One segment of the replay: what the endpoint said between this commit and the next. */
type JournalStep = {
  seq: number;
  /** The segment's own length, as the journal's `segment` line recorded it (`dur=`). */
  durationMs: number;
  /** The item the commit was accepted under, or `null` for a commit the endpoint refused. */
  itemId: string | null;
  /** What the endpoint transcribed it as, or `null` for a segment the journal never transcribed. */
  transcript: string | null;
  /** What the model relayed, or `null`. */
  relay: string | null;
  /** Whether the journal closed this segment's response with a `response.done`. */
  settled: boolean;
  /** An item the endpoint created by ITSELF after this commit — seq1's, after the refusal. */
  endpointItem?: string;
};

const JOURNAL: readonly JournalStep[] = [
  { seq: 0, durationMs: 3_460, itemId: 'item_GwgJFajaMzs3vySGWMpX2', transcript: '这是一轮新的Live Voice Mod 测试。', relay: '这是一轮新的 live voice mode 测试。', settled: true },
  { seq: 1, durationMs: 3_740, itemId: null, transcript: null, relay: null, settled: true, endpointItem: 'item_B5xbXwo6VjzvvwgvdgzvL' },
  { seq: 2, durationMs: 1_220, itemId: 'item_scripted_2', transcript: '现在是第二句话。', relay: null, settled: false },
  { seq: 3, durationMs: 1_540, itemId: 'item_Q26nL87tIMtxZW8FHDUh1', transcript: null, relay: null, settled: false },
  { seq: 4, durationMs: 3_320, itemId: 'item_OsZh2fsopXcNz9XOS2Ky7', transcript: '第四句话。', relay: null, settled: false },
  { seq: 5, durationMs: 860, itemId: 'item_CGvOOLqlKXscZ8bWQ6pLe', transcript: '上面我们看见丢了一句话。', relay: '上面我们看见丢了一句话。', settled: true },
  { seq: 6, durationMs: 2_660, itemId: null, transcript: null, relay: null, settled: false },
  { seq: 7, durationMs: 4_180, itemId: 'item_EtrMhyoYoCdQGlBCWFmhJ', transcript: '所以你已经可以看到很多错了。', relay: '所以你已经可以看到很多错了。', settled: true },
  { seq: 8, durationMs: 720, itemId: null, transcript: null, relay: null, settled: true },
];

/** The attribution table the journal replays to: `seq=itemId:text`, one row per transcribed segment. */
const JOURNAL_TABLE = [
  '0=item_GwgJFajaMzs3vySGWMpX2:这是一轮新的Live Voice Mod 测试。',
  '2=item_scripted_2:现在是第二句话。',
  '4=item_OsZh2fsopXcNz9XOS2Ky7:第四句话。',
  '5=item_CGvOOLqlKXscZ8bWQ6pLe:上面我们看见丢了一句话。',
  '7=item_EtrMhyoYoCdQGlBCWFmhJ:所以你已经可以看到很多错了。',
];

/** Replays {@link JOURNAL} through one handler and returns the attribution table it produced. */
async function replayJournal(handler: Handler): Promise<{ rows: string[]; acks: string[]; delivered: string[] }> {
  const wired = wire({ handler });
  await open(wired);
  for (const step of JOURNAL) {
    speakSegment(wired.socket, step.seq, 'gap', step.durationMs);
    await waitFor(() => acks(wired.socket).some((frame) => frame.seq === step.seq));
    if (step.itemId === null) {
      // Refused: the error, then the item the endpoint's OWN detector created for the audio it kept.
      refuseCommit(wired.transport);
    } else {
      commitItem(wired.transport, step.itemId);
      if (step.transcript !== null) {
        transcript(wired.transport, step.itemId, step.transcript);
      }
    }
    if (step.endpointItem !== undefined) {
      endpointUserItem(wired.transport, step.endpointItem);
    }
    if (step.relay !== null) {
      relay(wired.transport, `call_${step.seq}`, step.relay);
      await waitFor(() => wired.base.calls.length > 0);
    }
    if (step.settled) {
      responseDone(wired.transport, `resp_${step.seq}`);
    }
    await tick();
  }
  return {
    rows: captionRows(wired.socket),
    acks: ackStrings(wired.socket),
    delivered: wired.base.calls.map((call) => String(call.args.message)),
  };
}

test('DoD: the journal`s frame order replays to one attribution per segment, with every refusal answered', async () => {
  const run = await replayJournal(handleVoiceRealtimeConnection);

  assert.deepEqual(run.rows, JOURNAL_TABLE, 'one row per transcribed segment, in the journal`s own order');
  assert.deepEqual(run.acks, [
    '0:committed',
    '1:committed',
    '1:dropped:commit-refused',
    '2:committed',
    '3:committed',
    '4:committed',
    '5:committed',
    '6:committed',
    '6:dropped:commit-refused',
    '7:committed',
    '8:committed',
    '8:dropped:commit-refused',
  ], 'every segment is answered once, and the three refusals (seq1, seq6, seq8) are answered as refusals');
  assert.deepEqual(run.delivered, [
    '这是一轮新的 live voice mode 测试。',
    '上面我们看见丢了一句话。',
    '所以你已经可以看到很多错了。',
  ], 'the three relays the journal recorded, and only those');
});

test('DoD reading: on THIS journal the two rules agree — and here is exactly where they would not', async () => {
  const shipping = await replayJournal(handleVoiceRealtimeConnection);

  // The journal's transcripts each landed while their OWN segment was still the open one (seq2's
  // 0.29 s after its commit and 7.7 s before seq3's; seq4's and seq5's likewise), so restoring the
  // pre-fix rule reproduces this table exactly. Said plainly rather than left implied: the journal
  // evidences the ASYNCHRONY, not the misattribution — the misattribution needs a transcript that
  // crosses a commit, which is what AC1's false form drives and variant V of
  // `e2e/voice-realtime-segmented-replay-20261012.spec.ts` replays.
  await withMutantCopy(SHIPPING_PROXY_MODULE, ITEM_ID_BODY, ACTIVE_SEGMENT_BODY, 'dod-active-segment', async (basePath, mutPath) => {
    const mutant = await importProxy(mutPath);
    const preFix = await replayJournal(mutant.handleVoiceRealtimeConnection);
    assert.deepEqual(preFix.rows, shipping.rows, 'this journal cannot separate the two rules');
    assert.deepEqual(preFix.acks, shipping.acks, 'and both answer the same refusals');

    // WHAT DOES SEPARATE THEM IN THIS JOURNAL is not a transcript but the seq3 row that is MISSING:
    // the endpoint never transcribed `item_Q26nL87tIMtxZW8FHDUh1`, so seq3 has no words under either
    // rule. The moment such a transcript crosses into seq4's commit — the case AC1 drives — the two
    // tables part. Asserted here as the journal's own gap, so the gap is a reading and not an oversight.
    assert.equal(shipping.rows.some((row) => row.startsWith('3=')), false, 'seq3 was never transcribed, in the journal or here');
  });
});
