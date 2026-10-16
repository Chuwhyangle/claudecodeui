/**
 * The CONTINUOUS wire's empty-transcript guard, judged over the SPAN a relay answers for.
 *
 * THE DEFECT THIS PINS (2026-10-13 23:57 CST, connection `b5d01c21`, continuous). The person said
 * 「几步的延迟都有点大，包括识别延迟，然后……」 and the sentence never reached the session:
 *
 *     56:57.740  << transcription.completed "几步的延迟都有点大。"
 *     56:57.815  << function_call session_send {"message": "        ← truncated (response cancelled,
 *                to-browser error MALFORMED_FUNCTION_CALL              turn_detected)
 *     57:01.504  << transcription.completed "包括识别脸识。"
 *     57:01.794  << transcription.completed ""                    ← the 0.37 s sliver, 57:01.323–01.695
 *     57:02.324  << function_call session_send {"message": "几步的延迟都有点大，包括识别延迟，然后……"}
 *     57:02.324  session_send not-delivered (empty-transcript)
 *
 * The model answered THREE of the endpoint's items with ONE call — two of them with words — and the
 * guard judged it against the item transcribed LAST, which happened to be the empty sliver. The
 * words were refused; the truncated call before them had already been lost to `turn_detected`, so
 * the whole sentence went with it.
 *
 * WHAT THE GUARD IS NOW. A forwarding WATERMARK: the items transcribed since the last call the guard
 * decided on are the interval a relay arriving now is answerable for, and the call is refused only
 * when EVERY item in that interval reported zero words. One item with words lets it through. The
 * watermark advances at the two verdicts — an accepted delivery and a judged-empty refusal — and
 * NOTHING ELSE advances it: a call the wire truncated never reaches the proxy at all (the bridge
 * reports `MALFORMED_FUNCTION_CALL` before any executor runs), so the items transcribed before it
 * are still inside the interval when the model re-sends their content.
 *
 * THE READINGS, ONE CASE EACH:
 *  - AC1 — the `b5d01c21` replay, verbatim, delivers the merged text; its FALSE FORM (the guard back
 *          on the last transcribed item alone) refuses that same replay.
 *  - AC2 — a span that is entirely empty is still refused, on the same journal line.
 *  - AC3 — the watermark advances on an accepted delivery; its FALSE FORM (no advance there) lets a
 *          later empty fragment through on the earlier item's words.
 *  - AC4 — a truncated call does not advance it.
 *
 * The two false forms are built the way this module's siblings build theirs: the shipping proxy is
 * copied beside itself, one statement is rewritten, and the copy is driven through the SAME case —
 * named with `__criterion-falsify-` so `server/tsconfig.json` excludes it from the typecheck program,
 * and removed in a `finally`.
 *
 * The wire is PINNED (`segmentedRelay: false`), never left to the environment's mode: the segmented
 * path's own seq-keyed guard is `voice-realtime-empty-transcript-guard.test.ts`'s subject.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** The shipping proxy's own signature — the base and mutant copies expose the same one. */
type HandleConnection = typeof handleVoiceRealtimeConnection;

/** A minimal stand-in for the browser's `ws.WebSocket` — same shape as the sibling criteria's. */
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

/** One proxy connection over a fake browser socket, a fake upstream, and a recording log seam. */
function wireOver(handler: HandleConnection, options: { coalesceMs?: number } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const base = createRecordingExecutor();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => base.executor,
    instructions: 'test instructions',
    // THE CONTINUOUS WIRE, PINNED. Without this seam the connection resolves the relay mode from
    // `VOICE_REALTIME_MODE`, and a `segmented` environment would route every relay below through the
    // seq-keyed guard this file is not about (see `voice-realtime-segmented-default.test.ts`).
    segmentedRelay: false,
    log: (line) => logs.push(line),
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
  };
  handler(socket as unknown as Parameters<HandleConnection>[0], 'session-under-test', seams);
  return { socket, transport, base, logs };
}

const wire = (options: { coalesceMs?: number } = {}): Wired => wireOver(handleVoiceRealtimeConnection, options);

/** Waits for the session to be open and usable. Continuous needs no `hello`: it is what the proxy does by default. */
async function open(wired: Wired): Promise<void> {
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/**
 * The endpoint's report about one utterance: the `input_audio_buffer.committed` that created the item,
 * then its FINAL transcript — in that order, because that is the wire's.
 *
 * BOTH FRAMES, not just the transcript: the acceptance is what carries the item id, and the item id is
 * the key the guard's span is made of and the key it reads. The real endpoint sends it, so a fixture
 * that omitted it would be scripting a wire that cannot happen.
 */
function transcribe(transport: FakeTransport, itemId: string, text: string): void {
  transport.peerSend({ type: 'input_audio_buffer.committed', item_id: itemId } as RealtimeServerMessage);
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
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

/**
 * The model's relay as the wire TRUNCATED it — the `turn_detected` cancellation beside this defect.
 *
 * `arguments` is handed over VERBATIM and is not JSON: the real one was `{"message": "` with the rest
 * of the call cut off, which the bridge refuses as `MALFORMED_FUNCTION_CALL` before any executor runs.
 * Nothing here reaches the proxy's `session_send` at all, which is the whole point of AC4.
 */
function truncatedRelay(transport: FakeTransport, callId: string, rawArguments: string): void {
  transport.peerSend({ type: 'function_call', name: 'session_send', callId, arguments: rawArguments } as RealtimeServerMessage);
}

/** The upstream's answer to a turn finishing. */
function responseDone(transport: FakeTransport): void {
  transport.peerSend({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } } as RealtimeServerMessage);
}

/** Yields to the microtask queue and one timer turn, so an async delivery that was going to happen has. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * The journal the recorder would have written for these log lines — the SHIPPING classifier, fed the
 * proxy's own captured lines, so "the journal says delivered / not-delivered" is asserted against the
 * code that writes the journal rather than against a hand-rolled reading of the strings.
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
    mode: 'continuous',
    stdout: () => undefined,
  });
  for (const line of lines) {
    recorder.log(line);
  }
  return entries;
}

type SendEntry = Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }>;

const sendEntries = (entries: readonly VoiceRealtimeLogEntry[]): SendEntry[] =>
  entries.filter((entry): entry is SendEntry => entry.kind === 'session_send');

const delivered = (entries: readonly VoiceRealtimeLogEntry[]): SendEntry[] =>
  sendEntries(entries).filter((entry) => entry.outcome === 'delivered');

const refusedEmpty = (entries: readonly VoiceRealtimeLogEntry[]): SendEntry[] =>
  sendEntries(entries).filter((entry) => entry.outcome === 'not-delivered' && entry.reason === 'empty-transcript');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The replay, shared by AC1 and its false form.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The merged call's words, verbatim from the journal (`b5d01c21`, 57:02.324). */
const MERGED = '几步的延迟都有点大，包括识别延迟，然后……';
/** The delivery the watermark starts behind — the journal's own accepted send at 56:56:53.011. */
const PRIOR = '看上去延迟还是有点大。';

/**
 * Replays `b5d01c21` from 56:56:50 (the last accepted delivery, which the watermark sits behind) to
 * 57:02.324 (the merged call), transcript for transcript and argument for argument.
 *
 * Deliberately ONE helper for both the criterion and its false form: the two runs differ only by
 * which copy of the proxy is driven, so a reading that came from the fixture rather than from the
 * guard could not make them differ.
 */
async function replayDefect(handler: HandleConnection): Promise<{
  socket: FakeBrowserSocket;
  wired: Wired;
  entries: VoiceRealtimeLogEntry[];
}> {
  const wired = wireOver(handler);
  await open(wired);

  // 56:56:50.034–53.011 — the previous turn, delivered. This is the call the watermark advances on,
  // so the defect's own interval starts after its item.
  transcribe(wired.transport, 'item_previous', PRIOR);
  relay(wired.transport, 'call_previous', PRIOR);
  await waitFor(() => wired.base.calls.length === 1, 3_000);
  responseDone(wired.transport);

  // 56:57.740 — the sentence, transcribed with words.
  transcribe(wired.transport, 'item_sentence', '几步的延迟都有点大。');
  // 56:57.815 — the model's call, cut off mid-argument by `turn_detected`. MALFORMED, never executed.
  truncatedRelay(wired.transport, 'call_truncated', '{"message": "');
  responseDone(wired.transport);
  // 57:01.504 — the fragment after it, transcribed with words.
  transcribe(wired.transport, 'item_fragment', '包括识别脸识。');
  // 57:01.794 — the 0.37 s sliver the endpoint split off, transcribed as the empty string.
  transcribe(wired.transport, 'item_sliver', '');
  // 57:02.324 — the model re-sends the whole of it as ONE call.
  relay(wired.transport, 'call_merged', MERGED);
  await tick();

  return { socket: wired.socket, wired, entries: journalOf(wired.logs) };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — the defect's own replay delivers the merged text.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC1: the b5d01c21 replay delivers the merged call even though the last transcribed item was empty', async () => {
  const { socket, wired, entries } = await replayDefect(handleVoiceRealtimeConnection);

  // FIRST ASSERTION IN THIS FILE, on purpose: the false form below refuses this same call, so a build
  // that judged the last item alone must red HERE, on the reading the defect was about.
  assert.deepEqual(
    wired.base.calls.map((call) => call.args.message),
    [PRIOR, MERGED],
    'the merged call reaches the session: two items of its span carry words, and the empty sliver behind them is not a reason to drop them',
  );

  // The journal is the operator's answer to "did this reach the session?" — the same classifier the
  // shipping recorder uses, so the reading is the one an operator would take from the disk.
  assert.deepEqual(
    delivered(entries).map((entry) => entry.message),
    [PRIOR, MERGED],
    'and the journal records both deliveries, with the merged text verbatim',
  );
  assert.equal(refusedEmpty(entries).length, 0, 'nothing on this connection was refused as an empty transcript');

  // The truncation really happened here, so the delivery above is not green because the malformed call
  // was never part of the scenario.
  const malformed = socket.outbound.filter((frame) => frame.type === 'error' && frame.code === 'MALFORMED_FUNCTION_CALL');
  assert.equal(malformed.length, 1, 'the model`s `turn_detected` truncation is on this connection, as the journal has it');

  socket.close();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 false form — the guard back on the last transcribed item alone.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This test module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping proxy: what the false forms copy. */
const SHIPPING_PROXY_MODULE = path.join(MODULE_DIR, 'voice-realtime-ws-proxy.service.ts');
/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling criterion's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/**
 * The span guard's decision — the ONE expression the "last item alone" false form rewrites.
 *
 * Anchored on the whole `if` line rather than on a fragment so the mutation is a swap of the same
 * statement, leaving everything around it (the refusal, the journal line, the watermark advance)
 * exactly as it ships.
 */
const SPAN_GUARD_LINE = '      if (transcribedSinceWatermark.every((itemId) => itemTranscriptEmpty.get(itemId) === true)) {';
/** The same decision, judged on the item transcribed LAST — the reading `b5d01c21` was refused by. */
const LAST_ITEM_GUARD_LINE =
  "      if (itemTranscriptEmpty.get(transcribedSinceWatermark[transcribedSinceWatermark.length - 1] ?? '') === true) {";

/**
 * The watermark's advance on an accepted delivery — the statement the "watermark never advances"
 * false form removes. Its three lines together because the `if` alone is not unique in the file.
 */
const ACCEPT_ADVANCE_ANCHOR = [
  '    if (!segmentedRelay && segmentSeq === null) {',
  '      transcribedSinceWatermark.length = 0;',
  '    }',
].join('\n');
/** What that block becomes under the mutation: nothing at all. */
const ACCEPT_ADVANCE_MUTANT = '    // mutated: the acceptance-side watermark advance is gone';

/** Rewrites ONE anchor in the shipping source, refusing to proceed unless it occurs exactly once. */
function mutate(source: string, anchor: string, replacement: string): string {
  assert.equal(source.split(anchor).length - 1, 1, `the mutation anchor must occur exactly once: ${JSON.stringify(anchor)}`);
  return source.replace(anchor, replacement);
}

/** Imports a proxy module by path. The specifier is dynamic, so TS types it structurally here. */
async function importProxy(modulePath: string): Promise<{ handleVoiceRealtimeConnection: HandleConnection }> {
  return (await import(pathToFileURL(modulePath).href)) as { handleVoiceRealtimeConnection: HandleConnection };
}

test('AC1 false form: with the guard back on the last transcribed item alone, this replay is refused (AC1 reds)', async () => {
  const source = readFileSync(SHIPPING_PROXY_MODULE, 'utf8');
  const mutated = mutate(source, SPAN_GUARD_LINE, LAST_ITEM_GUARD_LINE);

  const basePath = ownCopy('span-base');
  const mutPath = ownCopy('span-last-item');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, mutated, 'utf8');
    const base = await importProxy(basePath);
    const mut = await importProxy(mutPath);

    // Unmutated: the copy still delivers, so the reading below is the mutation's and not the fixture's.
    const baseRun = await replayDefect(base.handleVoiceRealtimeConnection);
    assert.deepEqual(
      baseRun.wired.base.calls.map((call) => call.args.message),
      [PRIOR, MERGED],
      'the unmutated copy still delivers the merged call',
    );
    baseRun.socket.close();

    // Mutated: the merged call is refused, exactly as `b5d01c21` records it — AC1 would red on this build.
    const mutRun = await replayDefect(mut.handleVoiceRealtimeConnection);
    assert.deepEqual(
      mutRun.wired.base.calls.map((call) => call.args.message),
      [PRIOR],
      'judged on the empty sliver alone, the merged call never reaches the session',
    );
    assert.equal(
      mutRun.entries.filter((entry) => entry.kind === 'session_send' && entry.outcome === 'not-delivered' && entry.reason === 'empty-transcript').length,
      1,
      'and the journal says `not-delivered (empty-transcript)` — the defect`s own line',
    );
    mutRun.socket.close();
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — a span that is entirely empty is still refused.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC2: an empty fragment followed by a relay is still refused, on the same journal line', async () => {
  const wired = wire();
  await open(wired);

  // The shape AC2 names, and the shape `d88c6722` had: ONE empty transcription, then a call.
  transcribe(wired.transport, 'item_sliver', '');
  relay(wired.transport, 'call-1', '（用户没有说话）');
  await tick();

  assert.equal(wired.base.calls.length, 0, 'a span that is entirely empty must deliver nothing');
  assert.equal(delivered(journalOf(wired.logs)).length, 0, 'and the journal records no delivery');
  const refusals = refusedEmpty(journalOf(wired.logs));
  assert.equal(refusals.length, 1, 'the refusal is a RECORDED outcome, not a gap in the record');
  assert.equal(refusals[0]?.outcome, 'not-delivered', 'read as `not-delivered`');
  assert.equal(refusals[0]?.reason, 'empty-transcript', 'with the reason the operator needs');

  // The negative control that keeps "empty" from growing into a stop-word filter: the same single-item
  // span, transcribed with one filler word, IS relayed.
  const second = wire();
  await open(second);
  transcribe(second.transport, 'item-1', '嗯');
  relay(second.transport, 'call-1', '嗯');
  await waitFor(() => second.base.calls.length === 1, 3_000);
  assert.equal(second.base.calls[0]?.args.message, '嗯', 'one item with words is a span that is not empty');

  wired.socket.close();
  second.socket.close();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — the watermark advances on an accepted delivery, and its false form.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Drives AC3's shape: a delivered item, then a lone empty fragment and a call of its own. */
async function driveWatermarkCase(handler: HandleConnection): Promise<Wired> {
  const wired = wireOver(handler);
  await open(wired);

  transcribe(wired.transport, 'item-1', '把超时改成五十秒。');
  relay(wired.transport, 'call-1', '把超时改成五十秒。');
  await waitFor(() => wired.base.calls.length === 1, 3_000);
  responseDone(wired.transport);

  // The span this call answers for is ONE empty fragment. The earlier sentence is behind the
  // watermark, so it must not lend its words to this call.
  transcribe(wired.transport, 'item-2', '');
  relay(wired.transport, 'call-2', '（用户没有说话）');
  await tick();
  return wired;
}

test('AC3: after an accepted delivery, a lone empty fragment is refused — the earlier item does not lend it words', async () => {
  const wired = await driveWatermarkCase(handleVoiceRealtimeConnection);

  assert.deepEqual(
    wired.base.calls.map((call) => call.args.message),
    ['把超时改成五十秒。'],
    'the empty fragment`s call is refused: the items before the watermark are not part of its interval',
  );
  assert.equal(refusedEmpty(journalOf(wired.logs)).length, 1, 'and the refusal is the recorded empty-transcript one');
  wired.socket.close();
});

test('AC3 false form: without the acceptance-side advance the earlier item lends its words (AC3 reds)', async () => {
  const source = readFileSync(SHIPPING_PROXY_MODULE, 'utf8');
  const mutated = mutate(source, ACCEPT_ADVANCE_ANCHOR, ACCEPT_ADVANCE_MUTANT);

  const basePath = ownCopy('watermark-base');
  const mutPath = ownCopy('watermark-static');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, mutated, 'utf8');
    const base = await importProxy(basePath);
    const mut = await importProxy(mutPath);

    const baseRun = await driveWatermarkCase(base.handleVoiceRealtimeConnection);
    assert.deepEqual(
      baseRun.base.calls.map((call) => call.args.message),
      ['把超时改成五十秒。'],
      'the unmutated copy refuses the empty fragment`s call',
    );
    baseRun.socket.close();

    const mutRun = await driveWatermarkCase(mut.handleVoiceRealtimeConnection);
    // The earlier sentence stays in the interval, so the span is not ENTIRELY empty and the empty
    // fragment's call is delivered. The red reading is the delivery itself: the span guard used to
    // carry the earlier sentence in front of it as well, and that guard is deleted (2026-10-16, task
    // `gap-live-voice-one-text-per-segment-prefer-response` — the pair-overlap measure cannot tell a
    // rewrite from a drop), so what the mutant delivers is the model's own words only.
    assert.deepEqual(
      mutRun.base.calls.map((call) => call.args.message),
      ['把超时改成五十秒。', '（用户没有说话）'],
      'with the watermark never advancing, the earlier sentence is still in the interval and the empty fragment is delivered',
    );
    mutRun.socket.close();
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — a call the wire truncated does not advance the watermark.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('AC4: a MALFORMED (truncated) call leaves the watermark where it was, so the re-send still covers the item before it', async () => {
  const wired = wire();
  await open(wired);

  // 57:08.644 — the one item of this window that carries words.
  transcribe(wired.transport, 'item_FjcJXXal', '即执行的时间。');
  // 57:08.830 — the model`s call for it, cut off mid-argument: `{"message": "识别到实际执行的时间。`
  // with the closing quote and brace never written. The bridge refuses it as MALFORMED and NO executor
  // runs, so nothing in the proxy decides anything about it.
  truncatedRelay(wired.transport, 'call_68969491', '{"message": "识别到实际执行的时间。');
  responseDone(wired.transport);
  // 57:09.716 — a later, empty fragment joins the span.
  transcribe(wired.transport, 'item_WZSnon6G', '');
  // 57:09.8xx — the model re-sends the content of the truncated call, together with the fragment.
  relay(wired.transport, 'call_25f07a9b', '识别到实际执行的时间。');
  await tick();

  const errors = wired.socket.outbound.filter((frame) => frame.type === 'error' && frame.code === 'MALFORMED_FUNCTION_CALL');
  assert.equal(errors.length, 1, 'the truncation is on this connection, and it never reached an executor');

  // The re-send`s interval is BOTH items — the one transcribed before the truncation and the empty one
  // after it. A proxy that had advanced the watermark on the truncation would judge it against the
  // empty fragment alone and refuse it.
  assert.deepEqual(
    wired.base.calls.map((call) => call.args.message),
    ['识别到实际执行的时间。'],
    'the re-send is delivered: the item transcribed before the truncation is still inside its interval',
  );
  assert.equal(refusedEmpty(journalOf(wired.logs)).length, 0, 'and nothing was refused as an empty transcript');

  wired.socket.close();
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Residue.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
