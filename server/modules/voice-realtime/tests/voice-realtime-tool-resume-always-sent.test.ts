/**
 * The tool-resume-always-sent criterion: a tool result MUST be followed by a synthesized
 * `response.create`, whatever the deployment says about the model speaking.
 *
 * THE DEFECT THIS PINS (2026-10-18). The shipping closing turn (`silent`) passed
 * `respondToToolOutputs: false`, and the transport read that as "skip the synthesized
 * `response.create` whole". But DashScope requires that frame to resume the turn after a
 * `function_call_output`; skipping it left one unconsumed turn per delivered `session_send`.
 * The endpoint's turn queue holds 8, so the ninth user turn was refused with
 * `Turn queue overflow: capacity=8` and the session produced no transcription and no
 * delivery afterwards, with no self-healing. Two operator sessions were byte-identical at
 * that boundary (8 delivered, then overflow; 0 in-session `response.create`).
 *
 * WHAT THE FIX SEPARATES. "Resume this turn" (protocol traffic, always sent) from "ask the
 * model to say OK" (prompt wording, chosen by `VOICE_REALTIME_CLOSING_TURN`). The wording
 * half is asserted here too, so the fix cannot silently turn `silent` back into the 46%-cost
 * `respond` arm.
 *
 * HOW IT IS DRIVEN. The real transport runs over a scripted socket that records every frame
 * and delivers server frames on demand — no network. The script reacts to nothing, which is
 * what lets the in-flight-response arm hold a resume long enough to observe the gate.
 *
 * Provenance (goal record / this task's AC1 and AC2): run with THIS repo's runner —
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 *
 * The server tree is TS-ESM (`.js` specifiers resolve to same-named `.ts` files);
 * `node --test` does not remap them and dies on `../index.js`.
 *
 * Consumers: the quay worker's AC state for
 * `gap-voice-realtime-silent-closing-orphans-tool-resume-overflow`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDashscopeTransport,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeTransport,
} from '../index.js';
import {
  acceptedResultTail,
  afterStopSentence,
  resolveVoiceRealtimeClosingTurn,
} from '../voice-realtime-closing-turn.js';

/** An obviously fake credential, so a leak would be unmistakable. */
const TEST_KEY = 'test-key-not-a-real-credential';

/** A scripted stand-in for the DashScope endpoint: records frames, delivers frames on demand. */
type ScriptedUpstream = {
  readonly socketFactory: DashscopeSocketFactory;
  /** Every client frame the transport wrote (parsed), in order. */
  readonly sent: Array<Record<string, unknown>>;
  /** Deliver one server frame to the connected socket, as the peer would. */
  emit(wire: Record<string, unknown>): void;
};

/**
 * Builds the scripted endpoint. It reacts to NOTHING: every server frame is delivered by the
 * test, so the in-flight arm can keep a response open at the exact moment a result is sent.
 */
function createScriptedUpstream(): ScriptedUpstream {
  const sent: Array<Record<string, unknown>> = [];
  let socket: DashscopeSocket | null = null;

  const socketFactory: DashscopeSocketFactory = () => {
    const active: DashscopeSocket = {
      send(data: string) {
        sent.push(JSON.parse(data) as Record<string, unknown>);
      },
      close() {
        active.onclose?.({ code: 1000, reason: 'client closed' });
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    socket = active;
    // The transport attaches its handlers synchronously after the factory returns, so
    // opening on the next microtask is after they exist.
    queueMicrotask(() => active.onopen?.({}));
    return active;
  };

  return {
    socketFactory,
    sent,
    emit(wire: Record<string, unknown>): void {
      socket?.onmessage?.({ data: JSON.stringify(wire) });
    },
  };
}

/** Wire `type`s, in order. */
const wireTypes = (frames: ReadonlyArray<Record<string, unknown>>): string[] =>
  frames.map((frame) => String(frame.type));

/** Opens one transport over a fresh scripted endpoint. */
async function openTransport(
  respondToToolOutputs: boolean,
): Promise<{ transport: DashscopeTransport; upstream: ScriptedUpstream }> {
  const upstream = createScriptedUpstream();
  const transport = createDashscopeTransport({
    apiKey: TEST_KEY,
    socketFactory: upstream.socketFactory,
    respondToToolOutputs,
  });
  await transport.open();
  return { transport, upstream };
}

test('AC1: respondToToolOutputs=false (silent) sends one synthesized response.create per tool result', async () => {
  for (const respondToToolOutputs of [false, true]) {
    const { transport, upstream } = await openTransport(respondToToolOutputs);
    const where = `respondToToolOutputs=${respondToToolOutputs}`;

    // The endpoint's turn queue holds 8: eight delivered `session_send` results were exactly
    // the boundary at which a skipped resume made the ninth user turn overflow.
    for (let index = 0; index < 8; index += 1) {
      transport.send({ type: 'function_call_output', callId: `call-${index}`, output: { ok: true } });
    }

    const items = upstream.sent.filter((frame) => frame.type === 'conversation.item.create');
    const creates = upstream.sent.filter((frame) => frame.type === 'response.create');
    assert.equal(items.length, 8, `${where}: every tool result must be written into the conversation`);
    assert.equal(
      creates.length,
      8,
      `${where}: every function_call_output must be resumed — skipping it leaves an unconsumed turn upstream`,
    );

    // The resume FOLLOWS its result, one-for-one. An order inversion would resume the wrong turn.
    const expected = Array.from({ length: 8 }, () => ['conversation.item.create', 'response.create']).flat();
    assert.deepEqual(wireTypes(upstream.sent), expected, `${where}: item/resume pairs, in order`);

    await transport.close();
  }
});

test('AC1b: the duplicate-delivery guard still suppresses its resume (the negative control)', async () => {
  const { transport, upstream } = await openTransport(false);

  // `resume: false` is the bridge's own "already delivered, do not invite another call" arm —
  // a different decision from the closing-turn wording, and it must keep suppressing the frame.
  transport.send({ type: 'function_call_output', callId: 'dup-1', output: { duplicate: true }, resume: false });

  assert.equal(
    upstream.sent.filter((frame) => frame.type === 'conversation.item.create').length,
    1,
    'the duplicate result is still written into the conversation',
  );
  assert.equal(
    upstream.sent.filter((frame) => frame.type === 'response.create').length,
    0,
    '`resume: false` must still suppress the synthesized resume',
  );

  await transport.close();
});

test('AC1c: the in-flight gate still holds a silent resume and flushes it once', async () => {
  const { transport, upstream } = await openTransport(false);

  // A response is already in flight (server VAD can start one), so the synthesized resume must
  // wait rather than race it.
  upstream.emit({ type: 'response.created', response: { id: 'resp_inflight' } });
  transport.send({ type: 'function_call_output', callId: 'held-1', output: { ok: true } });
  assert.equal(
    upstream.sent.filter((frame) => frame.type === 'response.create').length,
    0,
    'the resume must not race an in-flight response',
  );
  assert.equal(transport.responseConcurrency.deferredResponseCreates, 1, 'the resume must be held, not dropped');

  upstream.emit({ type: 'response.done', response: { id: 'resp_inflight' } });
  assert.equal(
    upstream.sent.filter((frame) => frame.type === 'response.create').length,
    1,
    'the held resume must flush exactly once when the response completes',
  );

  await transport.close();
});

test('AC2: the default closing turn stays silent and its wording asks for silence', () => {
  // Unset environment: the shipped default is still `silent`, never the 46%-cost `respond` arm.
  assert.deepEqual(resolveVoiceRealtimeClosingTurn({}), { closingTurn: 'silent', invalid: null });

  for (const [name, sentence] of [
    ['acceptedResultTail', acceptedResultTail('silent')],
    ['afterStopSentence', afterStopSentence('silent')],
  ] as const) {
    assert.match(sentence, /say nothing/i, `${name}('silent') must ask for silence: ${sentence}`);
    assert.ok(
      !sentence.includes('Reply with the single word OK'),
      `${name}('silent') must not ask for the "OK" remark: ${sentence}`,
    );
  }
});
