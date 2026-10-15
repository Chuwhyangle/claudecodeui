/**
 * THE STOP THE MODEL SENT WITHOUT AN `intent` — `gap-live-voice-interrupt-missing-intent-drops-stop`.
 *
 * WHAT HAPPENED (journal `b5d01c21`, build `cc92c094f`, 2026-10-14). The person spoke a correction,
 * the relay model judged it a change of direction and called `session_interrupt` with the corrected
 * instruction and NO `intent`:
 *
 *     session_interrupt {"message":"停止前面的操作，处理我现在说的这句话。"}
 *
 * The voice plane had declared `intent` as a REQUIRED field of the advertised schema, so the
 * DashScope transport refused the whole call at its own validation (`TOOL_ARGUMENT_SCHEMA_VIOLATION`)
 * before the bridge or the executor ever saw it. Two losses in one frame, and the second is the
 * worse one:
 *
 *   1. the running turn was NOT aborted — the stop the person asked for did not happen;
 *   2. the `message` that carried the corrected instruction was NOT diverted to `session_send` — the
 *      words the person had just said were dropped with it.
 *
 * WHAT THIS FILE PINS. The fix is a schema change (`intent` → optional) plus the audit reading that
 * a missing reason is recorded rather than refused. The criteria:
 *
 *   · AC1 — THE VERBATIM b5d01c21 CALL IS ACCEPTED BY THE REAL TRANSPORT. Driving the exact frame
 *     over the REAL DashScope transport and the REAL proxy (the same assembly `server/index.ts`
 *     builds), the call is NOT rejected with `TOOL_ARGUMENT_SCHEMA_VIOLATION`, the execution plane
 *     receives the abort, and the `message` is confirmed-enqueued BEFORE the abort. The false form
 *     that must redden it — `intent` made required again — is run below against the advertised
 *     schema itself, and is ALSO what reverting `voice-realtime-tools.ts` does to this very case.
 *   · AC2 — A MISSING `intent` IS RECORDED, NOT REFUSED. The audit writes exactly ONE `kind:interrupt`
 *     record with `intent === null` and `intentMissing === true`, never `''` and never a fabricated
 *     reason; a call that DID state one is recorded as before (`intentMissing === false`).
 *   · AC3 — NO REFUSED STOP SILENTLY DROPS ITS `message`. A stop the plane STILL refuses (a call
 *     naming a foreign session) with a non-empty `message` delivers that text via `session_send`
 *     exactly once — G1's enqueue-then-abort runs BEFORE the abort, so the correction reaches the
 *     session even when the abort is turned away. The false form (delete G1's enqueue) reddens it.
 *
 * The bounded reverse (`intent` still required at the MCP gateway; the voice fields stripped before
 * the gateway's reader) is pinned in `voice-realtime-live-executor.test.ts`, and the advertised
 * shape's live reading is in `voice-realtime-interrupt.test.ts`'s AC1.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt-missing-intent.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';
import { z } from 'zod';

import {
  createDashscopeTransport,
  createVoiceRealtimeLogStore,
  createVoiceRealtimeRecorder,
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_TOOLS,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import { buildInterruptAftermathNote } from '../voice-realtime-ws-proxy.service.js';
import { createScriptedUpstream, functionCall, SCRIPTED_ENDPOINT_URL } from './voice-realtime-scripted-upstream.js';

// ── the fixture constants ────────────────────────────────────────────────────────────────────

/** The connection this file records under. The journal is named from it. */
const CONNECTION_ID = 'conn-missing-intent';
/** The session the connection is bound to. */
const BOUND_SESSION = 'session-under-test';
/** The run the fake `session_send` reports, so the audit can name a run that really was reported. */
const RUN_ID = 'run-7';

/**
 * The text a CORRECTION reaches the CLI as, once the proxy is done with it.
 *
 * The stop's aftermath note rides the correction (ruling 2026-10-16): it is armed before the enqueue,
 * so the message the stop's own words go in on is the one carrying the explanation of the
 * interruption. This file wires no `hostRunActivity` seam, so the note is the TOOL-FREE form — the
 * proxy has no reading for an in-flight tool and never guesses one (C-3).
 */
const withAftermathNote = (text: string): string => `${buildInterruptAftermathNote(null)}\n\n${text}`;

/**
 * THE VERBATIM FRAME (journal `b5d01c21`): the model's own arguments, byte-for-byte. No `intent`,
 * and a `message` carrying the corrected instruction. Everything this file proves is about THIS
 * object; a test that quietly rounded it to `{}` would be proving something else.
 */
const B5D01C21_ARGS: Record<string, unknown> = { message: '停止前面的操作，处理我现在说的这句话。' };
/** The corrected instruction inside {@link B5D01C21_ARGS}, named once for the delivery assertions. */
const CORRECTION = B5D01C21_ARGS.message as string;

// ── the fake browser socket and the recording executor ───────────────────────────────────────

/** A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly what the proxy uses. */
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
 * The fake base executor the cases here are driven over.
 *
 * It is the stand-in for the LIVE executor (`voice-realtime-live-executor.ts`): `session_send`
 * reports a CONFIRMED enqueue (`queued: true` with a `queuedMessageUuid`, the two shapes
 * `enqueueConfirmed` accepts), so G1's enqueue-then-abort proceeds to the abort. `session_interrupt`
 * aborts — unless the call names a session other than the bound one, in which case it throws the same
 * argument error the live route throws (`assertBoundSession`), which is the refusal AC3 reads.
 *
 * `sequence` records the two plane calls in the order they were reached, so a case can prove the
 * enqueue really came BEFORE the abort rather than merely having happened at all.
 */
function createStopExecutor(options: { refuseForeignSession?: boolean } = {}): {
  sends: Array<Record<string, unknown>>;
  interrupts: Array<Record<string, unknown>>;
  sequence: string[];
  executor: RealtimeToolExecutor;
} {
  const sends: Array<Record<string, unknown>> = [];
  const interrupts: Array<Record<string, unknown>> = [];
  const sequence: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      sequence.push('session_send');
      // `queued: true` + a `queuedMessageUuid`: the two fields `enqueueConfirmed` reads as "the
      // correction entered the session's queue". With either absent G1 would refuse to abort.
      return { ok: true, queued: true, runId: RUN_ID, queuedMessageUuid: `uuid-${sends.length}` };
    },
    session_interrupt: async (args: Record<string, unknown>) => {
      interrupts.push(args);
      sequence.push('session_interrupt');
      if (
        options.refuseForeignSession !== false &&
        typeof args.session === 'string' &&
        args.session !== BOUND_SESSION
      ) {
        throw new Error(`session_interrupt may only act on the bound session "${BOUND_SESSION}"`);
      }
      return { aborted: true };
    },
  };
  return { sends, interrupts, sequence, executor };
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

/** The interrupt records this connection's journal holds, in the order they were written. */
type InterruptRecord = Extract<VoiceRealtimeLogEntry, { kind: 'interrupt' }>;

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
  return mkdtempSync(path.join(os.tmpdir(), 'voice-interrupt-missing-intent-'));
}

/** The `session_interrupt` advertised to the relay model, as the endpoint validates calls against it. */
function advertisedInterruptSchema(): z.ZodObject<z.ZodRawShape> {
  const tool = VOICE_REALTIME_TOOLS.find((candidate) => candidate.name === 'session_interrupt');
  assert.ok(tool, 'the relay surface must offer the stop tool');
  return z.object(tool.inputSchema);
}

/** The control frame shapes this file reads; `Extract` keeps them exact members of the union. */
type ErrorFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'error' }>;
const errorFrames = (socket: FakeBrowserSocket, code: string): ErrorFrame[] =>
  socket.outbound.filter((frame): frame is ErrorFrame => frame.type === 'error' && frame.code === code);

// ── AC1: the verbatim b5d01c21 call is accepted by the REAL transport ─────────────────────────

test('AC1: the verbatim b5d01c21 stop (no `intent`, a `message`) is not rejected — the abort runs and the message is enqueued first', async (t) => {
  const directory = tempDir();
  // The REAL DashScope transport over a scripted stand-in, dialling an unroutable host: this is the
  // ACTUAL validation path (`validateDeclaredCall` → `argumentSchemaViolation`) — the one that
  // refused the call in journal `b5d01c21` — not a re-derivation of it. Nothing can leave the host.
  const upstream = createScriptedUpstream();
  const socket = new FakeBrowserSocket();
  const base = createStopExecutor();
  const logs: string[] = [];
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
      log: (line: string) => {
        logs.push(line);
        recorder.log(line);
      },
    } satisfies VoiceRealtimeProxySeams,
  );

  try {
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

    // ── the advertised schema, read the way the endpoint reads it. ──
    // The upstream advertises the transport's `session.update`; parsing the SAME shape is the
    // reading behind the wire behaviour below, and it is taken here so a reader can see the accepted
    // form beside the rejected one.
    const advertised = advertisedInterruptSchema();
    assert.equal(
      advertised.safeParse(B5D01C21_ARGS).success,
      true,
      'the verbatim b5d01c21 args MUST parse against the advertised schema — a schema that rejects them is the bug',
    );

    // ── THE FALSE FORM AC1 NAMES: with `intent` made REQUIRED again, the very same args go red. ──
    // Run against the advertised shape, so what is proven is that the acceptance above is caused by
    // the OPTIONALITY and not by the args being lenient. This is exactly the shape
    // `voice-realtime-tools.ts` declared before this task, and exactly what reverting it does to the
    // live case below: the transport would reject the call and the executor would never be reached.
    const requiredIntentShape = z.object({ ...advertisedInterruptSchema().shape, intent: z.string() });
    assert.equal(
      requiredIntentShape.safeParse(B5D01C21_ARGS).success,
      false,
      'with `intent` required, the same b5d01c21 args fail — the accepted form is load-bearing',
    );

    // ── the verbatim frame, as a real endpoint would say it. ──
    upstream.emit(functionCall('session_interrupt', B5D01C21_ARGS, 'call-stop'));
    await waitFor(() => interruptRecords(directory).length === 1);
    await waitFor(() => base.interrupts.length === 1);

    // ── AC1(a): NO transport-level rejection. The reading the bug produced must be absent. ──
    assert.equal(
      errorFrames(socket, 'TOOL_ARGUMENT_SCHEMA_VIOLATION').length,
      0,
      'the verbatim call must NOT be rejected with TOOL_ARGUMENT_SCHEMA_VIOLATION',
    );

    // ── AC1(b): the execution plane RECEIVED the abort (it did not in `b5d01c21`). ──
    assert.equal(base.interrupts.length, 1, 'the stop reached the execution plane exactly once');
    assert.equal(base.interrupts[0]!.message, CORRECTION, 'the plane reads the same message the model sent');

    // ── AC1(c): the `message` was confirmed-enqueued via `session_send` BEFORE the abort. ──
    assert.deepEqual(
      base.sequence,
      ['session_send', 'session_interrupt'],
      'G1: the correction enters the session`s queue BEFORE the run it corrects is aborted',
    );
    assert.equal(base.sends.length, 1, 'the message is delivered exactly once');
    // …as the stop's OWN message: the interruption's note rides it, and the corrected instruction is
    // intact at the end of it (the note is a prefix — the correction's own words are untouched).
    assert.equal(base.sends[0]!.message, withAftermathNote(CORRECTION));
    assert.ok(
      String(base.sends[0]!.message).endsWith(CORRECTION),
      'the delivered text ends with the corrected instruction, verbatim',
    );
    // The audit says the same thing from the other side: this stop's note left on its own correction.
    assert.equal(
      interruptRecords(directory)[0]!.noteCarried,
      true,
      'the audit records that the note rode this correction',
    );
    // The operator line for the ordering G1 guarantees, read off the same run's log.
    const deliveredAt = logs.findIndex((line) => line.includes('session_send delivered in'));
    const abortingAt = logs.findIndex((line) => line.includes('session_interrupt: correction enqueued; aborting'));
    assert.ok(deliveredAt >= 0, 'the delivery is logged');
    assert.ok(abortingAt >= 0, 'the abort is logged');
    assert.ok(deliveredAt < abortingAt, 'the enqueue is logged before the abort');

    // ── the receipt the model reads back: the abort result plus the audit readings. ──
    const outputFrame = upstream.clientFrames.find((frame) => {
      if (frame.type !== 'conversation.item.create') return false;
      const item = frame.item as Record<string, unknown> | undefined;
      return item?.type === 'function_call_output' && item?.call_id === 'call-stop';
    });
    assert.ok(outputFrame, 'the stop`s result must reach the endpoint');
    const receipt = JSON.parse(String((outputFrame.item as Record<string, unknown>).output)) as Record<string, unknown>;
    assert.equal(receipt.aborted, true, 'the receipt reports the abort the plane performed');

    // ── zero cloud calls: the only address dialled is the unroutable scripted one. ──
    assert.ok(
      upstream.dialedUrl?.startsWith(SCRIPTED_ENDPOINT_URL),
      `the run must dial the scripted stand-in and nothing else, got ${String(upstream.dialedUrl)}`,
    );
    t.diagnostic(`AC1 receipt: ${JSON.stringify(receipt)}`);
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC2: a missing `intent` is RECORDED as null + intentMissing, never refused ────────────────

test('AC2: a stop with no `intent` writes ONE kind:interrupt record with `intent: null` and `intentMissing: true`', async () => {
  const directory = tempDir();
  const base = createStopExecutor();
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
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
    { createTransport: () => transport, createExecutor: () => base.executor, instructions: 'test instructions', log: recorder.log },
  );

  try {
    await waitFor(() => transport.openCalls >= 1);

    // ── the verbatim b5d01c21 frame, over the fake transport so the journal is readable. ──
    deliverFunctionCall(transport, 'call-stop-1', 'session_interrupt', B5D01C21_ARGS);
    await waitFor(() => interruptRecords(directory).length === 1);
    const noIntent = interruptRecords(directory)[0]!;

    // AC2's core reading: NULL, and the flag that says so — never `''`, never invented, never a
    // refusal. The stop still RAN (the plane saw it; the record says `aborted`).
    assert.equal(noIntent.kind, 'interrupt');
    assert.equal(noIntent.intent, null, 'a stop that named no reason records null — never an empty string and never an invented one');
    assert.equal(noIntent.intentMissing, true, 'and the flag says the reason was absent');
    assert.equal(noIntent.outcome, 'aborted', 'a missing reason is NOT a refusal: the stop ran');
    assert.equal(base.interrupts.length, 1, 'the stop reached the plane; it was not turned away');
    assert.equal(noIntent.by, 'model', 'the voice tool surface has no other caller (D-2)');

    // ── a stop that DID state an `intent` is recorded as before (AC2's second half). ──
    deliverFunctionCall(transport, 'call-stop-2', 'session_interrupt', { intent: 'the user changed direction' });
    await waitFor(() => interruptRecords(directory).length === 2);
    const withIntent = interruptRecords(directory)[1]!;
    assert.equal(withIntent.intent, 'the user changed direction', 'a stated reason is carried verbatim');
    assert.equal(withIntent.intentMissing, false, 'and the flag says it was present');
    assert.equal(withIntent.outcome, 'aborted');

    // One record per stop, and no record invented a second time for the same call.
    assert.equal(interruptRecords(directory).length, 2, 'exactly one record per stop call');

    socket.close();
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC3: a refused stop with a `message` still delivers that message exactly once ─────────────

test('AC3: a stop the plane REFUSES (foreign session) with a `message` still delivers it via session_send, exactly once', async () => {
  const directory = tempDir();
  const base = createStopExecutor();
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const logs: string[] = [];
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
      createTransport: () => transport,
      createExecutor: () => base.executor,
      instructions: 'test instructions',
      log: (line: string) => {
        logs.push(line);
        recorder.log(line);
      },
    },
  );

  try {
    await waitFor(() => transport.openCalls >= 1);

    // ── THE FALSE-FORM SIDE OF AC3: the SAME refusal with NO `message` delivers nothing. ──
    // A refused stop that carries no correction must not send anything — this is the arm that makes
    // the delivery below a reading of the `message` and not of an unconditional send. Delete G1's
    // enqueue and the WITH-message case below delivers nothing either, and its assertion reds.
    deliverFunctionCall(transport, 'call-refused-bare', 'session_interrupt', { session: 'some-other-session' });
    await waitFor(() => interruptRecords(directory).length === 1);
    assert.equal(base.sends.length, 0, 'a refused stop with NO message delivers nothing — the send is caused by the message');
    assert.equal(interruptRecords(directory)[0]!.outcome, 'refused');

    // A stop that names a FOREIGN session AND carries a correction. The abort is turned away by the
    // voice plane's whitelist (`assertBoundSession`), but the corrected instruction must NOT vanish
    // with it: G1 enqueues the `message` BEFORE the abort is attempted, so the words reach the
    // session even though the run was never stopped.
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      session: 'some-other-session',
      message: 'do this instead',
    });
    await waitFor(() => interruptRecords(directory).length === 2);

    // ── AC3: the message is delivered via `session_send` exactly ONCE. ──
    assert.equal(base.sends.length, 1, 'the refused stop`s message reached the session exactly once');
    assert.equal(
      base.sends[0]!.message,
      withAftermathNote('do this instead'),
      'and it is the corrected instruction, verbatim, under the stop`s own aftermath note',
    );
    assert.equal(
      logs.filter((line) => line.includes('session_send delivered in')).length,
      1,
      'exactly one logged delivery — the refused stop did not double-send or silently drop the text',
    );
    // The abort WAS attempted (the plane saw the interrupt) and refused by the whitelist — for both
    // calls, the bare one and the one carrying the message.
    assert.equal(base.interrupts.length, 2, 'each refused stop reached the plane, then was refused');

    // ── the audit records the REFUSED stop, with the reason the model gave. ──
    const refused = interruptRecords(directory)[1]!;
    assert.equal(refused.outcome, 'refused', 'a stop that never reached the abort is recorded as refused');
    assert.equal(refused.intentMissing, true, 'this call omitted `intent` too, and that is recorded, not invented');
    // ── AND THE NOTE IT COULD NOT RECALL (resolved open question) ──
    // The whitelist that refuses this stop lives INSIDE the executor's own `session_interrupt`, which
    // the proxy calls BELOW the enqueue — so the correction, and the note riding it, were already in
    // the CLI when the refusal landed. The record says so rather than pretending the note never left:
    // `noteCarried: true` beside `outcome: 'refused'` is exactly the pair that makes "an interruption
    // note was delivered for a stop that did not happen" measurable instead of invisible.
    assert.equal(
      refused.noteCarried,
      true,
      'the note rode the correction out before the refusal, and the audit records it',
    );
    // The BARE refused stop — no message, so no delivery and no note — records the other reading.
    assert.equal(interruptRecords(directory)[0]!.noteCarried, false, 'a stop with no correction carries no note');

    // The refusal still reaches the model as a failed call, naming the reason — the delivery does not
    // replace the error, it goes beside it. Both refused stops are reported; the message's arrival is
    // a delivery, not an error, so it is not among these frames.
    const refusalFrames = errorFrames(socket, 'TOOL_EXECUTION_FAILED');
    assert.equal(refusalFrames.length, 2, 'each refused stop is reported to the browser as a failed call');
    for (const errorFrame of refusalFrames) {
      assert.match(errorFrame.message, /bound session/, 'the model is told why the call was refused');
    }

    socket.close();
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
