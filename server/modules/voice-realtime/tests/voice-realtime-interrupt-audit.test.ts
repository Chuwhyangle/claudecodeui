/**
 * The AUDITABLE stop — what a `session_interrupt` leaves behind, over the real proxy and the real
 * relay journal (GOAL-041 / AC-339, SPEC §6.2 / §10.3 / C-3, §18.1 F-6).
 *
 * WHAT THIS FILE IS FOR. Until now a stop was a WORD: the proxy printed one human line
 * (`session_interrupt: aborted=… backlog=…`), the journal classified it as an unclassified `log`
 * entry, and nothing anywhere recorded WHICH run was stopped, on WHICH utterance the model decided to
 * stop, what the model took the user to want, or what was still waiting behind the stop. C-3's "误停
 * 可审计" ("a mistaken stop is auditable") was therefore unsatisfiable — there was no record to audit.
 * This file drives `handleVoiceRealtimeConnection` over the same fake browser socket and fake
 * transport the other stop criteria use, with the SHIPPING recorder (`createVoiceRealtimeRecorder`,
 * the one `server/index.ts` wires) writing this connection's journal to a temp directory, and reads
 * the record back off disk.
 *
 * The criteria:
 *
 *   · AC1 — THE RECORD EXISTS AND ITS FIELD SET IS EXACTLY THE NINE READINGS. The file's FIRST
 *     ASSERTION is that set equality, so a record that quietly lost a field reddens at the top of
 *     this file rather than somewhere a narrower reading could hide. The false form that must redden
 *     it (delete any one field) runs immediately after the positive reading.
 *   · AC2 — THE MODEL'S OWN FIELDS, ABSENT OR PRESENT. An omitted `heard` is recorded as `null`
 *     (never invented); a stop the model sent with NO `intent` is likewise recorded — `intent: null`
 *     with `intentMissing: true` — rather than refused, and a stop the plane REFUSED for another
 *     reason (a foreign session) is recorded too, as an attempted stop.
 *   · AC3 — `triggerSeq` NAMES THE UTTERANCE. After two spoken sentences and one segment the endpoint
 *     reported NO words for, the record's `triggerSeq` is the second sentence's `utteranceSeq`: the
 *     empty segment did not advance the count. That is the whole difference between "the model
 *     stopped a run" and "the model stopped the run it had just heard THIS for".
 *
 * The gateway-compatibility half of this change (the MCP client's view of `session_interrupt` is
 * unchanged; `intent`/`heard`/`message` are stripped on the voice side before the gateway's own
 * reader runs) is pinned in `voice-realtime-live-executor.test.ts` — the routing/parameter file — and
 * in `voice-realtime-interrupt.test.ts`'s advertised-shape pins.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt-audit.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  createDashscopeTransport,
  createVoiceRealtimeLogStore,
  createVoiceRealtimeRecorder,
  handleVoiceRealtimeConnection,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import {
  captionCompleted,
  createScriptedUpstream,
  functionCall,
  SCRIPTED_ENDPOINT_URL,
} from './voice-realtime-scripted-upstream.js';

// ── the fixture constants ────────────────────────────────────────────────────────────────────

/** The connection this file records under. Any stable id: the journal is named from it. */
const CONNECTION_ID = 'conn-audit';
/** The session the connection is bound to. */
const BOUND_SESSION = 'session-under-test';
/** The run the fake `session_send` reports, so the audit can name a run that really was reported. */
const RUN_ID = 'run-7';

/**
 * The EXACT field set of a `kind: 'interrupt'` record: the ten readings SPEC §6.2/§10.3 name,
 * plus the two every journal entry carries by construction (`at`, `connectionId`) and the
 * discriminator itself. Sorted, because the assertion compares sorted key lists.
 */
const INTERRUPT_RECORD_FIELDS = [
  'at',
  'by',
  'connectionId',
  'heard',
  'inFlightTool',
  'intent',
  'intentMissing',
  'kind',
  'noteCarried',
  'outcome',
  'queuedStillPending',
  'runId',
  'triggerSeq',
].sort();

/** One `kind: 'interrupt'` record, as this file reads it. */
type InterruptRecord = Extract<VoiceRealtimeLogEntry, { kind: 'interrupt' }>;

// ── the fake browser socket and the recording executor ───────────────────────────────────────

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses. The same shape the other stop criteria drive.
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

/** The interrupt behaviour one case wants, so the refusal path can be driven as well as the abort. */
type InterruptBehaviour = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * The fake base executor every case is driven over.
 *
 * It is the stand-in for the LIVE executor (`voice-realtime-live-executor.ts`), which in production
 * is what `seams.createExecutor` returns: `session_send` reports a run, and `session_interrupt`
 * either aborts or — for the refusal case — throws the same argument error the live route throws.
 * `interrupts` records every call the proxy carried through, so a case can read what the plane did
 * with the arguments as well as what it wrote about them.
 */
function createAuditExecutor(interrupt: InterruptBehaviour): {
  interrupts: Array<Record<string, unknown>>;
  executor: RealtimeToolExecutor;
} {
  const interrupts: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async () => ({ ok: true, queued: false, runId: RUN_ID, queuedMessageUuid: null }),
    session_interrupt: async (args: Record<string, unknown>) => {
      interrupts.push(args);
      return interrupt(args);
    },
  };
  return { interrupts, executor };
}

/** The abort answer the live route's gateway handler gives for a run that was in flight. */
const ABORTS = async (): Promise<unknown> => ({ aborted: true });

/** Delivers one `function_call` event from the fake upstream. */
function deliverFunctionCall(transport: FakeTransport, callId: string, name: string, args: unknown): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name,
    callId,
    arguments: JSON.stringify(args),
  };
  transport.peerSend(call);
}

/** Delivers one FINAL transcription of the user's own audio, as the endpoint reports it. */
function deliverTranscript(transport: FakeTransport, itemId: string, transcript: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

/**
 * One fresh proxy connection over a fake browser socket, a fake transport, and the SHIPPING recorder
 * as the `log` seam — exactly the pairing `server/index.ts` builds — so what a case reads back is the
 * journal the deployment would have written, not a fake of it.
 */
function wireAuditConnection(options: {
  executor: RealtimeToolExecutor;
  directory: string;
}): { socket: FakeBrowserSocket; transport: FakeTransport } {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const recorder = createVoiceRealtimeRecorder({
    store: createVoiceRealtimeLogStore({ directory: options.directory }),
    connectionId: CONNECTION_ID,
    sessionId: BOUND_SESSION,
    tag: BOUND_SESSION,
    mode: 'segmented',
    // The recorder's own stdout line is not this file's subject; keep the run silent.
    stdout: () => {},
  });
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => options.executor,
    instructions: 'test instructions',
    log: recorder.log,
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    BOUND_SESSION,
    seams,
  );
  return { socket, transport };
}

/** Every entry this connection's journal holds so far. An absent file is "nothing written yet". */
function journalEntries(directory: string): VoiceRealtimeLogEntry[] {
  const file = path.join(directory, `${CONNECTION_ID}.jsonl`);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as VoiceRealtimeLogEntry];
      } catch {
        return [];
      }
    });
}

/** The interrupt records this connection's journal holds, in the order they were written. */
function interruptRecords(directory: string): InterruptRecord[] {
  return journalEntries(directory).filter((entry): entry is InterruptRecord => entry.kind === 'interrupt');
}

/** A temp journal directory, removed by the case that made it. */
function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'voice-interrupt-audit-'));
}

/**
 * The assertion AC1 states: a record's field set is EXACTLY the eight readings (plus `at`,
 * `connectionId`, `kind`). It is one function so the false form below can be run against it.
 */
function assertInterruptRecordFields(record: unknown): void {
  assert.deepEqual(
    Object.keys(record as Record<string, unknown>).sort(),
    INTERRUPT_RECORD_FIELDS,
    'an interrupt record carries the eight readings and nothing else',
  );
}

// ── AC1: the record exists, and its field set is exactly the eight readings ───────────────────

test('AC1: a model stop writes one kind:interrupt record carrying exactly the eight readings', async () => {
  const directory = tempDir();
  const base = createAuditExecutor(ABORTS);
  const { socket, transport } = wireAuditConnection({ executor: base.executor, directory });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

    // A run this connection knows about, so the record has a real run id to name rather than a null
    // that would pass for the wrong reason.
    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'do the long thing' });
    await waitFor(() => transport.sent.some((message) => message.type === 'function_call_output' && message.callId === 'call-send'));

    // The model stops, stating why and what it heard.
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      intent: 'the user said stop',
      heard: 'never mind, stop',
    });
    await waitFor(() => interruptRecords(directory).length === 1);

    const record = interruptRecords(directory)[0]!;

    // ── AC1's FIRST assertion: the field SET, exactly. ──
    assertInterruptRecordFields(record);

    // ── the false form AC1 names: deleting ANY one field reddens that same assertion. ──
    // Run against the assertion itself rather than against the record, so what is proven is that the
    // READING is tight — a record that lost a field could not pass it.
    for (const field of INTERRUPT_RECORD_FIELDS) {
      const mutilated: Record<string, unknown> = { ...record };
      delete mutilated[field];
      assert.throws(
        () => assertInterruptRecordFields(mutilated),
        `deleting "${field}" must redden the field-set assertion`,
      );
    }

    // ── and the readings themselves, on the positive path. ──
    assert.equal(record.kind, 'interrupt');
    assert.equal(record.connectionId, CONNECTION_ID);
    assert.equal(record.by, 'model', 'the voice tool surface has no other caller (D-2)');
    assert.equal(record.outcome, 'aborted', 'the abort ended a run');
    assert.equal(record.runId, RUN_ID, 'the run the aggregator was reporting when the stop arrived');
    assert.equal(record.intent, 'the user said stop');
    assert.equal(record.intentMissing, false, 'the model stated a reason, so nothing is flagged missing');
    assert.equal(record.heard, 'never mind, stop');
    assert.equal(record.queuedStillPending, 0, 'nothing was waiting behind this stop');
    assert.equal(
      record.triggerSeq,
      null,
      'no final transcription arrived on this connection, so there is no utterance to name — 0 would read as "the first one"',
    );
    assert.equal(
      record.inFlightTool,
      null,
      'the proxy holds no window onto the tool in hand, so the record says null rather than guessing',
    );
    assert.ok(typeof record.at === 'string' && !Number.isNaN(Date.parse(record.at)), 'the record is stamped');

    // ── the receipt the model reads back: the gateway`s payload plus the same three readings. ──
    const receipt = transport.sent.find(
      (message): message is { type: 'function_call_output'; callId: string; output: Record<string, unknown> } =>
        message.type === 'function_call_output' && message.callId === 'call-stop',
    );
    assert.ok(receipt, 'the stop must answer the model');
    assert.deepEqual(receipt.output, {
      aborted: true,
      runId: RUN_ID,
      triggerSeq: null,
      queuedStillPending: 0,
    });
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC2: the model's own fields, absent or present, and a REFUSED stop is recorded too ───────

test('AC2: an omitted `heard` is null, a stop with no `intent` is flagged intentMissing, and a refused stop is recorded', async () => {
  const directory = tempDir();
  // The refusal the live route STILL has after this change: a call naming a session other than the
  // bound one (the voice plane's whitelist — `voice-realtime-live-executor.ts`'s `assertBoundSession`
  // — pinned in `voice-realtime-live-executor.test.ts`). It stands in for the whole class of
  // refusals a stop can still meet; the reading this case is after is the same for any of them.
  const base = createAuditExecutor(async (args) => {
    if (typeof args.session === 'string' && args.session !== BOUND_SESSION) {
      throw new Error(`session_interrupt may only act on the bound session "${BOUND_SESSION}"`);
    }
    return { aborted: true };
  });
  const { socket, transport } = wireAuditConnection({ executor: base.executor, directory });
  try {
    await waitFor(() => transport.openCalls >= 1);

    // A stop with an `intent` and no `heard`: the model judged without quoting a transcript. The
    // field is optional (SPEC §6.2) and its absence is a READING, so the record says `null` — it does
    // not drop the field and it does not invent the last thing transcribed.
    deliverFunctionCall(transport, 'call-stop-1', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => interruptRecords(directory).length === 1);
    const withoutHeard = interruptRecords(directory)[0]!;
    assertInterruptRecordFields(withoutHeard);
    assert.equal(withoutHeard.heard, null, 'an omitted `heard` is recorded as null, not dropped or invented');
    assert.equal(withoutHeard.intent, 'the user said stop');
    assert.equal(withoutHeard.intentMissing, false, 'an intent WAS given, so nothing is flagged');
    assert.equal(withoutHeard.outcome, 'aborted');

    // A stop with NEITHER `intent` NOR `heard` — this task's whole form (journal `b5d01c21`). The
    // model forgot the reason but it still meant to stop, so the stop RUNS: the record says
    // `intent: null` with `intentMissing: true`, and nothing is fabricated. Refusing it (the old
    // behaviour) is what dropped that stop AND its `message` together.
    deliverFunctionCall(transport, 'call-stop-2', 'session_interrupt', {});
    await waitFor(() => interruptRecords(directory).length === 2);
    const noIntent = interruptRecords(directory)[1]!;
    assertInterruptRecordFields(noIntent);
    assert.equal(noIntent.intent, null, 'a stop that named no reason records null, never an invented one');
    assert.equal(noIntent.intentMissing, true, 'and the flag says the reason was absent');
    assert.equal(noIntent.outcome, 'aborted', 'the stop still ran — a missing reason is not a refusal');
    assert.equal(base.interrupts.length, 2, 'both stops reached the plane; neither was turned away');

    // A stop the plane REFUSES — here a call naming a FOREIGN session, the whitelist's own error (in
    // production the same class of refusal a forbidden verb or a throwing plane would produce). The
    // record is written BEFORE the refusal is rethrown, so the attempt is on disk even though no abort
    // happened: that is the stop C-3 most needs to audit.
    deliverFunctionCall(transport, 'call-stop-3', 'session_interrupt', {
      session: 'some-other-session',
      intent: 'the user said stop',
    });
    await waitFor(() => interruptRecords(directory).length === 3);

    const refused = interruptRecords(directory)[2]!;
    assertInterruptRecordFields(refused);
    assert.equal(refused.outcome, 'refused', 'a stop that never reached the abort is recorded as refused');
    assert.equal(refused.intent, 'the user said stop', 'the reason the model gave survives the refusal');
    assert.equal(refused.intentMissing, false);
    assert.equal(refused.runId, null, 'no run had been reported on this connection');

    // The refusal still reaches the model as a failed tool call, naming the reason — the audit does
    // not replace the error, it goes beside it.
    const errorFrame = socket.outbound.find(
      (frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'error' }> => frame.type === 'error',
    );
    assert.ok(errorFrame, 'a refused stop must be reported to the browser');
    assert.equal(errorFrame.code, 'TOOL_EXECUTION_FAILED');
    assert.match(errorFrame.message, /bound session/, 'the model is told why the call was refused');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC3: `triggerSeq` names the utterance the model stopped FOR ───────────────────────────────

test('AC3: `triggerSeq` is the last NON-EMPTY utterance`s seq; an empty transcription does not advance it', async () => {
  const directory = tempDir();
  const base = createAuditExecutor(ABORTS);
  const { socket, transport } = wireAuditConnection({ executor: base.executor, directory });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

    // Two spoken sentences. The count starts at 1, so the second one's `utteranceSeq` is 2.
    deliverTranscript(transport, 'item-1', 'open the failing test');
    deliverTranscript(transport, 'item-2', 'actually never mind, stop');
    // …and a segment the endpoint closed with ZERO words: a door, a cough, a silence. It is not an
    // utterance, so it must not push the count to 3.
    deliverTranscript(transport, 'item-3', '   ');

    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      intent: 'the user took back the last instruction',
      heard: 'actually never mind, stop',
    });
    await waitFor(() => interruptRecords(directory).length === 1);

    const record = interruptRecords(directory)[0]!;
    assertInterruptRecordFields(record);
    // ── AC3's reading: 2, not 3 and not 1. ──
    assert.equal(
      record.triggerSeq,
      2,
      'the stop names the SECOND sentence: two non-empty transcriptions arrived and the empty one did not count',
    );
    assert.equal(record.heard, 'actually never mind, stop', 'the record carries what the model says it heard');
    assert.equal(record.outcome, 'aborted');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── DoD: the same stop, over the REAL transport and proxy, read back off the journal FILE ────

test('DoD: over the real transport and proxy, a model stop leaves the full kind:interrupt line on disk', async (t) => {
  const directory = tempDir();
  // The REAL DashScope transport over a scripted stand-in, dialling an unroutable host: the round
  // trip the audit is written from is the shipping one, and nothing can leave the machine.
  const upstream = createScriptedUpstream();
  const socket = new FakeBrowserSocket();
  const base = createAuditExecutor(ABORTS);
  const recorder = createVoiceRealtimeRecorder({
    store: createVoiceRealtimeLogStore({ directory }),
    connectionId: CONNECTION_ID,
    sessionId: BOUND_SESSION,
    tag: BOUND_SESSION,
    mode: 'segmented',
    stdout: () => {},
  });
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    BOUND_SESSION,
    {
      createTransport: (report) =>
        createDashscopeTransport({
          apiKey: '',
          endpoint: SCRIPTED_ENDPOINT_URL,
          socketFactory: upstream.socketFactory,
          onError: report,
          observer: recorder.observe,
        }),
      createExecutor: () => base.executor,
      instructions: 'test instructions',
      log: recorder.log,
    },
  );

  try {
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
    // One spoken sentence, then the model stops for it — both as real endpoint frames.
    upstream.emit(captionCompleted('item-1', 'open the failing test'));
    upstream.emit(
      functionCall('session_interrupt', { intent: 'the user said stop', heard: 'open the failing test' }, 'call-stop'),
    );
    await waitFor(() => interruptRecords(directory).length === 1);

    // ── The DoD reading: the RAW LINE, as it sits in the journal file. ──
    const raw = readFileSync(path.join(directory, `${CONNECTION_ID}.jsonl`), 'utf8')
      .split('\n')
      .find((line) => line.includes('"kind":"interrupt"'));
    assert.ok(raw, 'the journal file must hold a kind:interrupt line');
    t.diagnostic(`DoD journal line: ${raw}`);

    // The line is the whole record — the eight readings parsed straight off disk.
    const onDisk = JSON.parse(raw) as InterruptRecord;
    assertInterruptRecordFields(onDisk);
    assert.equal(onDisk.connectionId, CONNECTION_ID);
    assert.equal(onDisk.by, 'model');
    assert.equal(onDisk.outcome, 'aborted');
    assert.equal(onDisk.intent, 'the user said stop');
    assert.equal(onDisk.heard, 'open the failing test');
    assert.equal(onDisk.triggerSeq, 1, 'the one sentence that was spoken');

    // ── And the receipt the model got back, read off the wire the transport wrote. ──
    const outputFrame = upstream.clientFrames.find((frame) => {
      if (frame.type !== 'conversation.item.create') return false;
      const item = frame.item as Record<string, unknown> | undefined;
      return item?.type === 'function_call_output' && item?.call_id === 'call-stop';
    });
    assert.ok(outputFrame, 'the stop`s result must reach the endpoint');
    const receipt = JSON.parse(String((outputFrame.item as Record<string, unknown>).output)) as Record<string, unknown>;
    assert.deepEqual(receipt, { aborted: true, runId: null, triggerSeq: 1, queuedStillPending: 0 });

    // ── Zero cloud calls: the only address dialled is the unroutable scripted one. ──
    assert.ok(
      upstream.dialedUrl?.startsWith(SCRIPTED_ENDPOINT_URL),
      `the run must dial the scripted stand-in and nothing else, got ${String(upstream.dialedUrl)}`,
    );
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
