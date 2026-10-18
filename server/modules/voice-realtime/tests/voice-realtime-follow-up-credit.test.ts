/**
 * The follow-up-credit criterion: the bridge's "the model will speak once more about
 * a tool result" credit must track the synthesized `response.create` that ACTUALLY
 * left the socket, never the tool result alone.
 *
 * THE DEFECT THIS PINS. `sendFunctionCallOutput` used to bump the credit
 * unconditionally. At the time the transport could drop the synthesized
 * `response.create` whole (`respondToToolOutputs: false`), so the credit was a claim
 * about a frame that was never sent: the NEXT `response.created` — a real user reply —
 * consumed it and had its non-empty text TOLERATED instead of surfacing
 * `MODEL_TEXT_REPLY`. The bridge now accrues the credit only from the transport's
 * actual-send hook, so "credit > 0 ⇒ a synthesized create this session sent is still
 * outstanding" holds by construction.
 *
 * 2026-10-18 UPDATE. The transport no longer has a configuration that suppresses the
 * tool resume: skipping it left one unconsumed turn in the endpoint's turn queue per
 * tool result, and the ninth user turn overflowed (`Turn queue overflow: capacity=8`);
 * see `voice-realtime-tool-resume-always-sent.test.ts`. BOTH closing-turn values now
 * send exactly one resume per tool result. The credit and its invariants are unchanged;
 * the `respond: false` arm below now reads like the ON arm, because the frame it tracks
 * is genuinely sent.
 *
 * HOW IT IS DRIVEN. The bridge runs over the REAL DashScope transport (so the credit is
 * granted by the transport's own decision, not a re-implementation), whose socket is a
 * small scripted stand-in that records every frame the transport wrote and lets the test
 * deliver server frames by hand. That explicit control is what makes the in-flight
 * (deferred-create) case reachable: the shared harness answers a tool result with
 * `response.done` synchronously, which clears the in-flight state before the synthesized
 * create is even considered.
 *
 * Provenance (goal record AC-321 / this task's AC1): run with THIS repo's runner —
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 *
 * The server tree is TS-ESM (`.js` specifiers resolve to same-named `.ts` files);
 * `node --test` does not remap them and dies on `../index.js`.
 *
 * Consumers: the quay worker's AC state for
 * `gap-voice-realtime-followup-credit-blind-consumption`, and for
 * `gap-voice-realtime-silent-closing-orphans-tool-resume-overflow` (the resume is
 * unconditional, so the silent arm can no longer starve the credit).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connect,
  createDashscopeTransport,
  REALTIME_TOOLS,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type RealtimeBridge,
  type RealtimeToolExecutor,
} from '../index.js';

/** An obviously fake credential, so a leak would be unmistakable. */
const TEST_KEY = 'test-key-not-a-real-credential';

/** The tool the scripted endpoint claims the model chose — one of {@link REALTIME_TOOLS}. */
const TOOL_NAME = 'ui_visible_context';

/**
 * AC5's golden: the ON-config client-frame sequence, captured from the PRE-FIX bridge
 * (a throwaway probe run against the unmodified code before this change). The fix
 * neither adds nor removes a frame on the shipping path, so this must hold byte-for-byte.
 */
const ON_GOLDEN_FRAMES = ['session.update', 'conversation.item.create', 'response.create'] as const;

/** One sampled reading of the credit and the create traffic it must track. */
type CreditSample = {
  label: string;
  /** The bridge's outstanding follow-up credit. */
  credit: number;
  /** Synthesized `response.create`s the transport has written so far. */
  createsSent: number;
};

/** Everything one scripted run produced. */
type RunResult = {
  /** Every client frame the transport wrote, by wire `type`, in order. */
  frames: string[];
  /** `onError` codes from BOTH the transport and the bridge, in order. */
  errors: string[];
  /** Per-point credit readings. */
  samples: CreditSample[];
  /** The credit immediately after the tool result was backfilled. */
  creditAfterToolOutput: number;
};

/** A scripted stand-in for the DashScope endpoint: records frames, delivers frames on demand. */
type ScriptedUpstream = {
  readonly socketFactory: DashscopeSocketFactory;
  /** Every client frame the transport wrote (parsed), in order. */
  readonly sent: Array<Record<string, unknown>>;
  /** Deliver one server frame to the connected socket, as the peer would. */
  emit(wire: Record<string, unknown>): void;
};

/**
 * Builds the scripted endpoint.
 *
 * Unlike `voice-realtime-dashscope-harness.ts`'s fixture, this one reacts to NOTHING:
 * the test decides every server frame. That is deliberate — the deferred-create case
 * needs the in-flight response to still be open at the moment the tool result is
 * backfilled, and an auto-answering fixture closes it too early to observe.
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
    // The transport attaches its handlers synchronously after the factory returns,
    // so opening on the next microtask is after they exist.
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

/** Lets the bridge's synchronous dispatch settle before the next reading. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Drives one multi-round conversation and returns its readings.
 *
 * The script: advertise the session, (optionally) open an in-flight response, let the
 * model call a tool, (optionally) let that in-flight response complete — which is when
 * a held create is flushed — then start the NEXT response and close it with non-empty
 * text. In the `respond: false` config that next response is still a follow-up: the
 * transport resumed the turn with a real create, so the credit is genuinely outstanding.
 */
async function drive(
  respond: boolean,
  options: { deferCreate?: boolean } = {},
): Promise<RunResult> {
  const upstream = createScriptedUpstream();
  const errors: string[] = [];
  const executor: RealtimeToolExecutor = { [TOOL_NAME]: () => ({ ok: true }) };
  const transport = createDashscopeTransport({
    apiKey: TEST_KEY,
    socketFactory: upstream.socketFactory,
    respondToToolOutputs: respond,
    onError: (error) => errors.push(error.code),
  });
  const bridge: RealtimeBridge = connect(transport, REALTIME_TOOLS, executor, {
    hooks: { onError: (error) => errors.push(error.code) },
  });

  const samples: CreditSample[] = [];
  let creditAfterToolOutput = -1;
  // `followUpResponsesExpected` is optional on the interface (a facade may omit it) but the
  // concrete bridge always exposes it; `?? 0` keeps the reading honest either way.
  const creditOf = (): number => bridge.followUpResponsesExpected ?? 0;
  const sample = (label: string): void => {
    samples.push({
      label,
      credit: creditOf(),
      createsSent: upstream.sent.filter((frame) => frame.type === 'response.create').length,
    });
  };

  await bridge.whenConnected();
  sample('connected');
  bridge.sendSessionUpdate('relay everything the user says; never reply in text');
  await tick();
  sample('session-advertised');

  if (options.deferCreate === true) {
    // A response is already in flight, so the synthesized create will be HELD.
    upstream.emit({ type: 'response.created', response: { id: 'resp_inflight' } });
    await tick();
    sample('inflight-response-created');
  }

  upstream.emit({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    name: TOOL_NAME,
    arguments: '{}',
  });
  await tick();
  creditAfterToolOutput = creditOf();
  sample('after-tool-output');

  if (options.deferCreate === true) {
    // The in-flight response completes; the held create is flushed and ONLY NOW is a
    // real, credited create sent — the point the hook must be pinned to.
    upstream.emit({ type: 'response.done', response: { id: 'resp_inflight' } });
    await tick();
    sample('after-deferred-flush');
  }

  // The next response the endpoint starts. Suppressed, this is a REAL user reply that
  // the blind credit used to swallow.
  upstream.emit({ type: 'response.created', response: { id: 'resp_next' } });
  await tick();
  sample('next-response-created');

  upstream.emit({ type: 'response.text.done', response_id: 'resp_next', text: respond ? 'OK' : '我听到了，请继续。' });
  await tick();
  sample('next-response-text');

  const frames = upstream.sent.map((frame) => String(frame.type));
  await bridge.close();
  return { frames, errors, samples, creditAfterToolOutput };
}

test('AC2: the silent closing turn sends the resume too, so its follow-up is credited and claimed', async () => {
  const result = await drive(false);

  // The resume is protocol-mandatory: `respond: false` asks for silence, not for a missing frame.
  assert.equal(
    result.frames.filter((frame) => frame === 'response.create').length,
    1,
    'respondToToolOutputs:false must still send the synthesized response.create',
  );
  assert.equal(result.creditAfterToolOutput, 1, 'the sent create must grant exactly one credit');
  // ...and the follow-up response claims it, leaving none outstanding.
  assert.equal(
    result.samples.find((s) => s.label === 'next-response-created')?.credit,
    0,
    'the follow-up response must claim the credit',
  );
  // The credit is real, so the follow-up's non-empty text is tolerated rather than misreported.
  assert.equal(
    result.errors.some((code) => code === 'MODEL_TEXT_REPLY'),
    false,
    `the credited follow-up must stay tolerated, got ${JSON.stringify(result.errors)}`,
  );
});

test('AC3: the ON config still tolerates the follow-up it actually asked for (negative control)', async () => {
  const result = await drive(true);

  assert.equal(
    result.frames.filter((frame) => frame === 'response.create').length,
    1,
    'the ON config must send the synthesized follow-up create',
  );
  assert.equal(result.creditAfterToolOutput, 1, 'the sent create must grant exactly one credit');
  assert.equal(
    result.errors.some((code) => code === 'MODEL_TEXT_REPLY'),
    false,
    `the follow-up remark ("OK") must stay tolerated, got ${JSON.stringify(result.errors)}`,
  );
  // The follow-up's own response.created claims the credit, leaving none outstanding.
  const afterClaim = result.samples.find((s) => s.label === 'next-response-created');
  assert.equal(afterClaim?.credit, 0, 'the follow-up response must claim the credit');
});

test('AC4: credit > 0 only while a synthesized create is genuinely in flight', async () => {
  // Both closing-turn values send the resume now; the invariant is about the SEND, not the flag.
  for (const respond of [false, true]) {
    for (const deferCreate of [false, true]) {
      const result = await drive(respond, { deferCreate });
      const where = `respondToToolOutputs=${respond} deferCreate=${deferCreate}`;
      for (const point of result.samples) {
        assert.ok(point.credit >= 0, `${where} ${point.label}: credit must never go negative`);
        assert.ok(
          !(point.credit > 0 && point.createsSent === 0),
          `${where} ${point.label}: credit > 0 with NO synthesized create sent — the blind-credit window`,
        );
      }
    }
  }
});

test('AC4b: a DEFERRED create grants its credit only at the flush, never where it is merely planned', async () => {
  const result = await drive(true, { deferCreate: true });
  const at = (label: string): CreditSample => {
    const point = result.samples.find((s) => s.label === label);
    assert.ok(point !== undefined, `sample ${label} missing`);
    return point;
  };

  // Held behind the in-flight response: nothing sent, and — the point of the AC — no credit yet.
  assert.equal(at('after-tool-output').createsSent, 0, 'the held create must not be on the wire yet');
  assert.equal(at('after-tool-output').credit, 0, 'a held create must not grant credit before it is sent');
  // The flush is the real send, and it is what grants the credit.
  assert.equal(at('after-deferred-flush').createsSent, 1, 'the flush must put the synthesized create on the wire');
  assert.equal(at('after-deferred-flush').credit, 1, 'the flushed create must grant exactly one credit');
  // ...and the follow-up response then claims it.
  assert.equal(at('next-response-created').credit, 0, 'the follow-up response must claim the flushed credit');
});

test('AC5: the ON config is frame-for-frame unchanged (the shipping path)', async () => {
  const result = await drive(true);
  assert.deepEqual(result.frames, [...ON_GOLDEN_FRAMES], 'the ON client-frame sequence must be unchanged');
  // The functional trailer the AC names: the synthesized create immediately follows the tool result.
  assert.deepEqual(
    result.frames,
    ['session.update', 'conversation.item.create', 'response.create'],
    'function_call_output frames must be conversation.item.create then response.create',
  );
});
