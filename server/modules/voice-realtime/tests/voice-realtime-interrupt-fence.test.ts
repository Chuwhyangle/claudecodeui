/**
 * The interrupt FENCE — `runId` + `utteranceSeq`, idempotent and cover-aware (SPEC §0.3 D-7 / §18.4
 * G2, GOAL-041 AC-343).
 *
 * WHAT THIS FILE IS FOR. The relay model can call `session_interrupt` for a sentence whose command
 * the CURRENT run has already dequeued into its turn — an E-2 self-answer, or a retry after the
 * bridge's `TOOL_LOOP_GUARD` — and stopping a run for an utterance it is already answering is the
 * repeat-interrupt thrash D-7 forbids. Before this change the stop path had no fence at all: only
 * "there is no run ⇒ `no-run`" was idempotent, and two calls for the same sentence aborted twice.
 * This file drives `handleVoiceRealtimeConnection` — the real proxy, offline, over the same fake
 * browser socket and fake transport the other stop criteria use — with a scripted resident host
 * standing in for the CLI's own queue, and pins four readings:
 *
 *   · AC1 — THE FENCE, WITH ITS FALSE FORM FIRST. The file OPENS with the false form that must
 *     redden: with the fence's two guards neutralized (`coveredSeqs` empty, `abortedTriggerSeq`
 *     null) `decideModelInterrupt` decides `abort` for the same input EVERY time — the two aborts
 *     removing the fence would produce. It then shows each guard singly flips that decision to
 *     `covered`, and drives the real proxy for the true form: the SAME sentence interrupted twice
 *     aborts once and answers `covered` once.
 *   · AC2 — COVERED. When the host reports the trigger sentence's command `started` (the CLI
 *     dequeued it into the current run), the interrupt is a no-op: no call reaches the session, the
 *     journal records `outcome: 'covered'`.
 *   · AC3 — THE UI STOP KEY IS NOT FENCED. The fence lives in the voice proxy's `session_interrupt`
 *     wrapper only; the browser's stop button / Esc reach the control service's abort directly over
 *     `chat.abort` and never pass through it. In the very state where the model's call is `covered`,
 *     the underlying abort still stops the run.
 *   · AC4 — AT MOST ONE EFFECTIVE MODEL INTERRUPT PER RUN. Five model calls for the same utterance
 *     reach the session exactly once; the other four are `covered`.
 *
 * The DoD half is the same shape over the REAL DashScope transport and a scripted upstream, reading
 * the `kind:interrupt` lines back off the journal FILE — zero cloud calls.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt-fence.test.ts
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
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeOutboundFrame,
} from '../index.js';
import {
  decideModelInterrupt,
  handleVoiceRealtimeConnection,
  type HostCommandLifecycleReading,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import {
  captionCompleted,
  createScriptedUpstream,
  functionCall,
  SCRIPTED_ENDPOINT_URL,
} from './voice-realtime-scripted-upstream.js';

// ── the fixture constants ────────────────────────────────────────────────────────────────────

/** The connection this file records under. Any stable id: the journal is named from it. */
const CONNECTION_ID = 'conn-fence';
/** The session the connection is bound to. */
const BOUND_SESSION = 'session-under-test';

/** One `kind: 'interrupt'` record, as this file reads it. */
type InterruptRecord = Extract<VoiceRealtimeLogEntry, { kind: 'interrupt' }>;

/** One `session_interrupt` receipt the proxy answered the model with. */
type StopReceipt = {
  aborted?: boolean;
  stopped?: boolean;
  reason?: string;
  runId: string | null;
  triggerSeq: number | null;
  queuedStillPending: number;
};

// ── the scripted resident host ───────────────────────────────────────────────────────────────

/**
 * A scripted stand-in for the CLI's own command queue and its `command_lifecycle`.
 *
 * `accept` is the CLI taking a message into its queue (`queuedMessageUuid`); `start` is the CLI
 * DEQUEUING it into a turn, which is the only event that can put an utterance into the current run's
 * `covers` (SPEC §18.3). The relay samples this host through the `hostCommandLifecycle` seam, exactly
 * as it samples the deployed host through the composition root's own reading.
 */
type ScriptedHost = {
  accept(uuid: string): void;
  start(uuid: string): void;
  reading(): HostCommandLifecycleReading;
};

function createScriptedHost(): ScriptedHost {
  const queued: string[] = [];
  const started: string[] = [];
  return {
    accept(uuid: string): void {
      queued.push(uuid);
    },
    start(uuid: string): void {
      const at = queued.indexOf(uuid);
      if (at >= 0) {
        queued.splice(at, 1);
      }
      started.push(uuid);
    },
    reading(): HostCommandLifecycleReading {
      return { started: [...started] };
    },
  };
}

// ── the fake browser socket and the recording executor ───────────────────────────────────────

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

/**
 * The fake LIVE executor the fence is driven over.
 *
 * `session_send` accepts each message into the scripted host's own queue and answers with a
 * `queuedMessageUuid` — the identity the fence joins to a later `started` event. `session_interrupt`
 * records EVERY call it is reached with and always reports a stopped run, so a case can prove the
 * fence stopped the call BEFORE the session (the list stays short) as well as that an unfenced call
 * would have aborted.
 */
function createFenceExecutor(host: ScriptedHost): {
  interrupts: Array<Record<string, unknown>>;
  sends: string[];
  executor: RealtimeToolExecutor;
} {
  const interrupts: Array<Record<string, unknown>> = [];
  const sends: string[] = [];
  let calls = 0;
  const executor: RealtimeToolExecutor = {
    session_send: async () => {
      calls += 1;
      const uuid = `cmd-${calls}`;
      sends.push(uuid);
      host.accept(uuid);
      return { ok: true, queued: true, runId: `run-${calls}`, queuedMessageUuid: uuid };
    },
    session_interrupt: async (args: Record<string, unknown>) => {
      interrupts.push(args);
      return { aborted: true };
    },
  };
  return { interrupts, sends, executor };
}

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

function functionCallOutputs(transport: FakeTransport, callId: string) {
  return transport.sent.filter(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && message.callId === callId,
  );
}

function stopReceipt(transport: FakeTransport, callId: string): StopReceipt {
  const outputs = functionCallOutputs(transport, callId);
  assert.equal(outputs.length, 1, `expected exactly one receipt for ${callId}`);
  return outputs[0]!.output as StopReceipt;
}

/**
 * One fresh proxy connection over a fake browser socket, a fake transport, the SHIPPING recorder as
 * the `log` seam, and the scripted host behind the `hostCommandLifecycle` seam — the same pairing
 * `server/index.ts` builds for the resident path.
 */
function wireFenceConnection(options: {
  executor: RealtimeToolExecutor;
  host: ScriptedHost;
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
    stdout: () => {},
  });
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => options.executor,
    instructions: 'test instructions',
    log: recorder.log,
    hostCommandLifecycle: () => options.host.reading(),
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
  return mkdtempSync(path.join(os.tmpdir(), 'voice-interrupt-fence-'));
}

/** Waits for the upstream to be announced open, so tool calls are handled rather than dropped. */
async function waitForOpen(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

// ── AC1: the fence decision — false form first, then each guard, then the real proxy ──────────

test('AC1 false form: with both fences neutralized the same input decides `abort` every time', () => {
  // This is the whole file's red-proof, first. `decideModelInterrupt` IS the fence; driven with the
  // state a fence-less proxy would be in — nothing covered, nothing previously interrupted — the same
  // interrupt decides `abort` again and again. Removing the fence therefore aborts a sentence twice,
  // which is exactly the SPEC §18.7 F3 false form this criterion exists to redden.
  const unfenced = { triggerSeq: 3, coveredSeqs: new Set<number>(), abortedTriggerSeq: null };
  assert.equal(decideModelInterrupt(unfenced), 'abort', 'the first call runs');
  assert.equal(decideModelInterrupt(unfenced), 'abort', 'and so does the second — two aborts, the false form');

  // Each of the fence's two guards, ALONE, flips that same call to `covered` — so neither is dead code.
  assert.equal(
    decideModelInterrupt({ ...unfenced, abortedTriggerSeq: 3 }),
    'covered',
    'the idempotent guard: the same triggerSeq already ran',
  );
  assert.equal(
    decideModelInterrupt({ ...unfenced, coveredSeqs: new Set([3]) }),
    'covered',
    'the covers guard: the current run already covers the trigger utterance',
  );
  // A LOWER covered seq never stands in for a higher trigger: covers is a max, not a membership test.
  assert.equal(
    decideModelInterrupt({ ...unfenced, coveredSeqs: new Set([1, 2]) }),
    'abort',
    'a previous sentence being covered does not cover a later one',
  );
  // Nothing heard yet: there is no utterance to fence on, so a bare stop still runs.
  assert.equal(
    decideModelInterrupt({ triggerSeq: null, coveredSeqs: new Set(), abortedTriggerSeq: null }),
    'abort',
    'no utterance ⇒ no fence',
  );
});

test('AC1 true form: the same sentence interrupted twice aborts once and answers `covered` once', async () => {
  const directory = tempDir();
  const host = createScriptedHost();
  const base = createFenceExecutor(host);
  const { socket, transport } = wireFenceConnection({ executor: base.executor, host, directory });
  try {
    await waitForOpen(socket, transport);

    // One spoken sentence: the model's stop is FOR this utterance.
    deliverTranscript(transport, 'item-1', 'open the failing test');
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'caption'));

    // First stop: the run is in flight and nothing in it covers the sentence ⇒ it runs.
    deliverFunctionCall(transport, 'stop-1', 'session_interrupt', { intent: 'the user changed their mind' });
    await waitFor(() => interruptRecords(directory).length === 1);
    assert.equal(base.interrupts.length, 1, 'the first stop must reach the session');
    const first = stopReceipt(transport, 'stop-1');
    assert.equal(first.aborted, true, 'the first stop is an abort');
    assert.equal(first.triggerSeq, 1, 'it names the one sentence that was spoken');

    // Second stop, SAME sentence: the fence answers it without a second abort.
    deliverFunctionCall(transport, 'stop-2', 'session_interrupt', { intent: 'the user changed their mind' });
    await waitFor(() => interruptRecords(directory).length === 2);
    assert.equal(base.interrupts.length, 1, 'the repeated stop must NOT reach the session');
    const second = stopReceipt(transport, 'stop-2');
    assert.equal(second.stopped, false, 'the second call is answered as a no-op');
    assert.equal(second.reason, 'covered');
    assert.equal(second.triggerSeq, 1, 'it still names the utterance it was for');
    // No second `stopped` frame: the fence's no-op must not add noise the page would read as a stop.
    assert.equal(
      socket.outbound.filter((frame) => frame.type === 'stopped').length,
      1,
      'exactly one `stopped` frame for the one abort',
    );

    // ── The journal's reading: one abort, one covered, in that order. ──
    const records = interruptRecords(directory);
    assert.equal(records.length, 2, 'each call leaves exactly one audit line');
    assert.equal(records[0]!.outcome, 'aborted');
    assert.equal(records[1]!.outcome, 'covered');
    assert.equal(records[1]!.by, 'model', 'both lines are the model-facing path');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC2: an utterance the current run already covers is a no-op ───────────────────────────────

test('AC2: when the current run already covers the trigger sentence, the interrupt is a covered no-op', async () => {
  const directory = tempDir();
  const host = createScriptedHost();
  const base = createFenceExecutor(host);
  const { socket, transport } = wireFenceConnection({ executor: base.executor, host, directory });
  try {
    await waitForOpen(socket, transport);

    // A sentence is spoken, then relayed: the session accepts it into its queue and acknowledges the
    // command. Nothing entered a turn yet.
    deliverTranscript(transport, 'item-1', 'open the failing test');
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'caption'));
    deliverFunctionCall(transport, 'send-1', 'session_send', { message: 'open the failing test' });
    await waitFor(() => functionCallOutputs(transport, 'send-1').length === 1);
    // The CLI DEQUEUES it into the current turn — the `command_lifecycle` `started` the fence reads.
    host.start('cmd-1');

    // The model now stops for that very sentence. The run already carries it, so there is nothing to
    // stop: no call reaches the session and the journal records the reading.
    deliverFunctionCall(transport, 'stop-1', 'session_interrupt', { intent: 'the user took it back' });
    await waitFor(() => interruptRecords(directory).length === 1);
    assert.equal(base.interrupts.length, 0, 'a covered stop must not reach the session');
    assert.equal(
      socket.outbound.filter((frame) => frame.type === 'stopped').length,
      0,
      'a covered stop sends no `stopped` frame',
    );

    const receipt = stopReceipt(transport, 'stop-1');
    assert.equal(receipt.stopped, false);
    assert.equal(receipt.reason, 'covered');

    const record = interruptRecords(directory)[0]!;
    assert.equal(record.outcome, 'covered', 'the journal records the covered reading');
    assert.equal(record.triggerSeq, 1, 'the utterance the model stopped for');
    assert.equal(record.by, 'model');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC3: the UI stop key is not fenced ────────────────────────────────────────────────────────

test('AC3: in the state where the model`s stop is covered, the UI stop key still aborts', async () => {
  const directory = tempDir();
  const host = createScriptedHost();
  const base = createFenceExecutor(host);
  const { socket, transport } = wireFenceConnection({ executor: base.executor, host, directory });
  try {
    await waitForOpen(socket, transport);

    deliverTranscript(transport, 'item-1', 'open the failing test');
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'caption'));
    deliverFunctionCall(transport, 'send-1', 'session_send', { message: 'open the failing test' });
    await waitFor(() => functionCallOutputs(transport, 'send-1').length === 1);
    host.start('cmd-1');

    // The model's stop is fenced here — no call reaches the session.
    deliverFunctionCall(transport, 'stop-1', 'session_interrupt', { intent: 'the user took it back' });
    await waitFor(() => interruptRecords(directory).length === 1);
    assert.equal(base.interrupts.length, 0, 'the model`s stop is covered');

    // The UI stop key / Esc does NOT come through this proxy: it reaches the control service`s abort
    // directly over `chat.abort` (the SAME executor this connection wraps). Proven by calling that
    // abort directly in the very state the fence refused the model — it still stops the run.
    const ui = (await base.executor.session_interrupt({})) as { aborted?: boolean };
    assert.equal(ui.aborted, true, 'the browser`s own stop is unfenced and still aborts');
    assert.equal(base.interrupts.length, 1, 'the UI stop is what reached the session, exactly once');
    // …and the UI stop is not the voice path, so it writes no `kind:interrupt` audit line of its own.
    assert.equal(interruptRecords(directory).length, 1, 'the UI stop left the model`s one audit line alone');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC4: at most one effective model interrupt per run ────────────────────────────────────────

test('AC4: five model interrupts for one run reach the session exactly once', async () => {
  const directory = tempDir();
  const host = createScriptedHost();
  const base = createFenceExecutor(host);
  const { socket, transport } = wireFenceConnection({ executor: base.executor, host, directory });
  try {
    await waitForOpen(socket, transport);

    deliverTranscript(transport, 'item-1', 'stop and do something else');
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'caption'));

    // Five calls for the one utterance, as a thrashing model would emit them.
    for (let i = 1; i <= 5; i += 1) {
      deliverFunctionCall(transport, `stop-${i}`, 'session_interrupt', { intent: `attempt ${i}` });
      await waitFor(() => interruptRecords(directory).length === i);
    }

    assert.equal(base.interrupts.length, 1, 'exactly ONE of the five reached the session');
    const records = interruptRecords(directory);
    assert.equal(records.length, 5, 'each call still leaves its one audit line');
    assert.equal(records.filter((r) => r.outcome === 'aborted').length, 1, 'one abort');
    assert.equal(records.filter((r) => r.outcome === 'covered').length, 4, 'four covered no-ops');
    assert.equal(
      socket.outbound.filter((frame) => frame.type === 'stopped').length,
      1,
      'one `stopped` frame, not five',
    );
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── DoD: over the REAL transport and proxy, the covered lines land on the journal FILE ─────────

test('DoD: over the real transport, a thrice-repeated model stop leaves one abort and two covered lines', async (t) => {
  const directory = tempDir();
  const host = createScriptedHost();
  const base = createFenceExecutor(host);
  const socket = new FakeBrowserSocket();
  const recorder = createVoiceRealtimeRecorder({
    store: createVoiceRealtimeLogStore({ directory }),
    connectionId: CONNECTION_ID,
    sessionId: BOUND_SESSION,
    tag: BOUND_SESSION,
    mode: 'segmented',
    stdout: () => {},
  });
  // The REAL DashScope transport over a scripted stand-in, dialling an unroutable host: the round
  // trip the audit is written from is the shipping one, and nothing can leave the machine.
  const upstream = createScriptedUpstream();
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
      hostCommandLifecycle: () => host.reading(),
    },
  );

  try {
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

    // One sentence, relayed to the session, then the model interrupts for it THREE times.
    upstream.emit(captionCompleted('item-1', 'open the failing test'));
    upstream.emit(functionCall('session_send', { message: 'open the failing test' }, 'call-send'));
    // The relay delivered; the CLI has accepted the command (it is in the queue, not yet a turn).
    await waitFor(() => base.sends.length === 1);
    upstream.emit(functionCall('session_interrupt', { intent: 'user changed their mind' }, 'stop-1'));
    await waitFor(() => interruptRecords(directory).length === 1);
    // The abort released the revision into a turn: the CLI dequeues it. The next two stops are then
    // for a sentence the current run already carries.
    host.start('cmd-1');
    upstream.emit(functionCall('session_interrupt', { intent: 'user changed their mind' }, 'stop-2'));
    await waitFor(() => interruptRecords(directory).length === 2);
    upstream.emit(functionCall('session_interrupt', { intent: 'user changed their mind' }, 'stop-3'));
    await waitFor(() => interruptRecords(directory).length === 3);

    // ── The DoD reading: the RAW `kind:interrupt` lines, as they sit in the journal file. ──
    const rawLines = readFileSync(path.join(directory, `${CONNECTION_ID}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"kind":"interrupt"'));
    assert.equal(rawLines.length, 3, 'three stops, three audit lines');
    t.diagnostic(`DoD covered journal lines:\n${rawLines.join('\n')}`);

    const onDisk = rawLines.map((line) => JSON.parse(line) as InterruptRecord);
    assert.deepEqual(
      onDisk.map((r) => r.outcome),
      ['aborted', 'covered', 'covered'],
      'one abort and two covered, in the order the model called them',
    );
    assert.deepEqual(
      onDisk.map((r) => r.triggerSeq),
      [1, 1, 1],
      'all three name the one sentence that was spoken',
    );

    // The session itself was reached exactly once.
    assert.equal(base.interrupts.length, 1, 'only the first of the three stops reached the session');
    assert.equal(
      socket.outbound.filter((frame) => frame.type === 'stopped').length,
      1,
      'one `stopped` frame for the one abort',
    );

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
