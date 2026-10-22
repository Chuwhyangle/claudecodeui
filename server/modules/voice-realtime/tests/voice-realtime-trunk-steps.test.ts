/**
 * Criterion — the `/voice-realtime` proxy's CONNECTION-LIFECYCLE extension point.
 *
 * `handleVoiceRealtimeConnection` used to run every cross-cutting lifecycle concern inline:
 * the upstream handshake's `whenConnected` body, the parse in front of each inbound frame,
 * the interrupt fence, the `session.update` that carries the instructions, and the capture's
 * finalize on the way out. This criterion holds the replacement — an ORDERED step table
 * (`voice-realtime-trunk-steps.ts`) plus a sibling step file
 * (`voice-realtime-trunk-step-handlers.ts`) — to four readings:
 *
 * (b) POSITIVE ARM — a step registered from a file that is NOT the proxy is what a real
 *     connection runs at that timing, EXACTLY ONCE. Probes are registered from THIS file at
 *     `after-handshake`, `before-frame`, `after-frame`, `status-injection` and `before-close`;
 *     the connection is handed that table through its `trunkSteps` seam; one real connection
 *     is driven (a frame in, the socket closed) and every probe's count is printed and then
 *     asserted to be 1. The print names each probe's source path and the proxy's path, and
 *     the two must differ.
 *
 * (c) NEGATIVE CONTROL — an unregistered step is not invoked. The same assertion function
 *     (`assertTrunkStepNotInvoked`) is driven by the real table (green: unregister the probe,
 *     drive the connection, the probe body never runs) and by an in-memory injection form — a
 *     dispatcher with the registration check removed, which calls the probe anyway. The
 *     injection form must make that same function throw, so the assertion is proven to have
 *     teeth rather than passing because nothing was watching. The red reading is printed, then
 *     the arm is taken again and the count proves nothing but the injected call happened.
 *
 * (d) SHIPPED STEPS — the table is REGISTRATION DATA, not one callback per timing, and the
 *     shipped bodies are the old inline code moved verbatim: two steps registered at one timing
 *     run in registration order; every shipped step is defined in the sibling file, never the
 *     proxy; and each body's effect is compared with what the old site produced (a failed
 *     handshake answers `TRANSPORT` and tears down, a good one advertises; the parse accepts a
 *     real frame and drops garbage; the fence decides `covered`/`abort` by the old rule; the
 *     injection puts the composed text on the wire; the exit finalizes the capture).
 *
 * Every reading is printed before it is asserted, so a red lands on the reading that is wrong.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import type { RealtimeBridge } from '../voice-realtime-bridge.service.js';
import {
  VOICE_REALTIME_TRUNK_STEPS,
  createDefaultVoiceRealtimeTrunkSteps,
} from '../voice-realtime-trunk-step-handlers.js';
import {
  VOICE_REALTIME_TRUNK_TIMINGS,
  VoiceRealtimeTrunkStepRegistry,
  type VoiceRealtimeTrunkContext,
  type VoiceRealtimeTrunkPayloads,
  type VoiceRealtimeTrunkStep,
  type VoiceRealtimeTrunkTiming,
} from '../voice-realtime-trunk-steps.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor } from './realtime-bridge-harness.js';

/** The file this criterion — the "non-proxy file" of the positive arm — is. */
const TEST_SOURCE = fileURLToPath(import.meta.url);

/** The proxy's own file, for the "the step did not come from there" readings. */
const WS_PROXY_SOURCE = fileURLToPath(new URL('../voice-realtime-ws-proxy.service.ts', import.meta.url));

/** The step file, for the "every shipped step is registered from there" reading. */
const STEPS_REL = 'server/modules/voice-realtime/voice-realtime-trunk-step-handlers.ts';
/** Its basename as a definite string — `split('/').pop()` is `string | undefined` under strict. */
const STEPS_BASENAME = STEPS_REL.slice(STEPS_REL.lastIndexOf('/') + 1);

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses (`readyState`, `send`, `close`,
 * `on('message' | 'close' | 'pong', …)`). Driven over `EventEmitter` rather than a real
 * socket pair, so the whole proxy runs in-process.
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

/** How many times each probe ran, by timing. */
type ProbeCounts = Record<VoiceRealtimeTrunkTiming, number>;

function emptyCounts(): ProbeCounts {
  return {
    'after-handshake': 0,
    'before-frame': 0,
    'after-frame': 0,
    'interrupt-decision': 0,
    'status-injection': 0,
    'before-close': 0,
  };
}

/** Wires one real proxy connection over a fake browser socket, with `table` as its step table. */
function wireConnection(
  table: VoiceRealtimeTrunkStepRegistry,
  extraSeams: Partial<VoiceRealtimeProxySeams> = {},
): FakeBrowserSocket {
  const socket = new FakeBrowserSocket();
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => createFakeTransport(),
    createExecutor: () => ({
      session_send: async () => ({ ok: true }),
      session_interrupt: async () => ({ aborted: false, runId: null }),
    }),
    instructions: 'criterion instructions',
    // Absent means OFF here, not "use the locked file": this criterion is not the fill's.
    omissionFillParams: null,
    trunkSteps: table,
    ...extraSeams,
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return socket;
}

/**
 * A probe defined in THIS file — the "registered from a non-proxy file" subject.
 *
 * It records the timing it was invoked at and the payload it was handed, so the reading a
 * red lands on can say WHICH timing fired and WHAT it saw.
 */
function makeProbe(
  timing: VoiceRealtimeTrunkTiming,
  counts: ProbeCounts,
  seen: Array<{ timing: VoiceRealtimeTrunkTiming; payload: unknown }>,
): VoiceRealtimeTrunkStep {
  return {
    timing,
    name: `criterion.probe.${timing}`,
    label: `criterion.probe.${timing}`,
    source: TEST_SOURCE,
    run: (context) => {
      counts[context.timing] += 1;
      seen.push({ timing: context.timing, payload: context.payload });
    },
  };
}

/**
 * THE NEGATIVE-CONTROL ASSERTION, used by both arms.
 *
 * Runs `run` and asserts the step body was not invoked. `invocations` is read around the call
 * rather than trusted from the step's own closure so this function is the one place the "not
 * triggered" rule lives — the real arm and the injected arm both go through it, which is what
 * makes the injected red evidence that this function can fail.
 */
function assertTrunkStepNotInvoked(run: () => void, invocations: () => number, label: string): void {
  const before = invocations();
  run();
  const after = invocations();
  assert.equal(after, before, `unregistered trunk step ${label} was invoked (${before} -> ${after})`);
}

/**
 * THE IN-MEMORY INJECTION FORM.
 *
 * A dispatcher of the same call shape with the registration check removed: it runs the step it
 * was handed whether or not it is registered. It is not the table — it is the mutant the
 * negative-control assertion exists to catch.
 */
function injectedLeakyRun(step: VoiceRealtimeTrunkStep, context: VoiceRealtimeTrunkContext): () => void {
  return () => {
    step.run(context);
  };
}

// ---------------------------------------------------------------------------
// Fixtures for the shipped-step arms
// ---------------------------------------------------------------------------

type TrunkCalls = {
  sent: VoiceRealtimeOutboundFrame[];
  advertised: number;
  teardowns: number;
  sessionUpdates: string[];
  captureFinalized: number;
};

/**
 * A context whose every port is inert and counted.
 *
 * `bridge` is a one-field stand-in: the only thing a shipped step does with it is
 * `sendSessionUpdate`, so the fixture records the text and nothing else.
 */
function makeTrunkContext<T extends VoiceRealtimeTrunkTiming>(
  timing: T,
  payload: VoiceRealtimeTrunkPayloads[T],
): VoiceRealtimeTrunkContext<T> & { calls: TrunkCalls } {
  const calls: TrunkCalls = { sent: [], advertised: 0, teardowns: 0, sessionUpdates: [], captureFinalized: 0 };
  const context = {
    timing,
    seams: {
      instructions: '',
      createTransport: () => createFakeTransport(),
      createExecutor: () => ({}),
      audioCapture: {
        frame: () => undefined,
        finalize: () => {
          calls.captureFinalized += 1;
        },
      },
    } as unknown as VoiceRealtimeProxySeams,
    send: (frame: VoiceRealtimeOutboundFrame) => calls.sent.push(frame),
    bridge: {
      sendSessionUpdate: (text: string) => calls.sessionUpdates.push(text),
    } as unknown as RealtimeBridge,
    teardown: () => {
      calls.teardowns += 1;
    },
    advertiseInstructions: () => {
      calls.advertised += 1;
      return true;
    },
    uplinkVad: null,
    payload,
    ...payload,
  } as unknown as VoiceRealtimeTrunkContext<T> & { calls: TrunkCalls };
  Object.defineProperty(context, 'calls', { value: calls, enumerable: false });
  return context;
}

// ---------------------------------------------------------------------------
// (b) positive arm — steps from outside the proxy run, exactly once, at their timing
// ---------------------------------------------------------------------------

test('positive arm: steps registered from a non-proxy file run exactly once at each timing', async () => {
  const table = createDefaultVoiceRealtimeTrunkSteps();
  const counts = emptyCounts();
  const seen: Array<{ timing: VoiceRealtimeTrunkTiming; payload: unknown }> = [];
  const probes = [
    makeProbe('after-handshake', counts, seen),
    makeProbe('before-frame', counts, seen),
    makeProbe('after-frame', counts, seen),
    makeProbe('status-injection', counts, seen),
    makeProbe('before-close', counts, seen),
  ];
  for (const probe of probes) {
    table.register(probe);
  }
  const socket = wireConnection(table);

  // The upstream settles (the fake transport opens on the first try), which is what fires
  // `after-handshake` — and the shipped step's `advertiseInstructions` is what fires
  // `status-injection`, so the connection has to reach the open state before either is read.
  await waitFor(() => counts['after-handshake'] === 1 && counts['status-injection'] === 1);

  // One inbound frame: the parse step (`before-frame`) and the post-routing reading
  // (`after-frame`) each fire once, and this frame asks for no instructions, so
  // `status-injection` stays at its one handshake reading.
  socket.receive({ type: 'narrator_done', utteranceId: 'u-1' });
  // The connection's way out.
  socket.close();

  console.log(
    `(b) positive-arm: wsProxySource=${WS_PROXY_SOURCE} testSource=${TEST_SOURCE} ` +
      `steps=${probes.length} tableTimings=${VOICE_REALTIME_TRUNK_TIMINGS.length}`,
  );
  for (const probe of probes) {
    const label = probe.label;
    console.log(
      `(b) positive-arm: timing=${probe.timing} step=${label} source=${probe.source} triggered=${counts[probe.timing]}`,
    );
  }
  console.log(
    `(b) positive-arm: statusInjections=${JSON.stringify(
      (seen.find((entry) => entry.timing === 'status-injection')?.payload as
        | VoiceRealtimeTrunkPayloads['status-injection']
        | undefined)?.instructions.length,
    )} chars`,
  );

  for (const probe of probes) {
    assert.equal(counts[probe.timing], 1, `the ${probe.timing} probe must be called exactly once`);
    assert.notEqual(probe.source, WS_PROXY_SOURCE, 'the step source must not be the proxy file');
    assert.equal(probe.source, TEST_SOURCE, 'the step source must be this criterion file');
  }
  // The payloads the steps saw are the connection's own readings, not a copy.
  const afterFrame = seen.find((entry) => entry.timing === 'after-frame')?.payload as
    | VoiceRealtimeTrunkPayloads['after-frame']
    | undefined;
  assert.deepEqual(afterFrame?.frame, { type: 'narrator_done', utteranceId: 'u-1' });
  const injected = seen.find((entry) => entry.timing === 'status-injection')?.payload as
    | VoiceRealtimeTrunkPayloads['status-injection']
    | undefined;
  assert.equal(injected?.sent, true, 'the shipped injection step runs before the probe appended after it');
  assert.ok(
    typeof injected?.instructions === 'string' && injected.instructions.includes('criterion instructions'),
    'the probe must see the composed instruction text the connection put upstream',
  );
});

// ---------------------------------------------------------------------------
// (c) negative control — unregistered means not invoked, on the SAME assertion
// ---------------------------------------------------------------------------

test('negative control: an unregistered step is not run; an injected leaky dispatch reds the same assertion', async () => {
  const table = createDefaultVoiceRealtimeTrunkSteps();
  const counts = emptyCounts();
  const seen: Array<{ timing: VoiceRealtimeTrunkTiming; payload: unknown }> = [];
  const probe = makeProbe('after-frame', counts, seen);
  table.register(probe);
  const socket = wireConnection(table);

  try {
    // The real arm: the probe is unregistered, the connection still receives a frame, and the
    // probe body must not run.
    table.unregister('after-frame', probe.name);
    assertTrunkStepNotInvoked(
      () => {
        socket.receive({ type: 'narrator_done', utteranceId: 'u-2' });
      },
      () => counts['after-frame'],
      probe.label,
    );
    console.log(
      `(c) negative-arm(table): triggered=${counts['after-frame']} registered=${table.names('after-frame').includes(probe.name)}`,
    );
    assert.equal(counts['after-frame'], 0, 'the unregistered probe must not run');
  } finally {
    socket.close();
  }

  // The injection form: the same assertion function, driven by a dispatcher that ignores
  // registration. It must throw — that red is the proof the assertion has teeth.
  const context = makeTrunkContext('after-frame', { frame: { type: 'close' } });
  let injectedRed: Error | null = null;
  try {
    assertTrunkStepNotInvoked(
      injectedLeakyRun(probe, context as unknown as VoiceRealtimeTrunkContext),
      () => counts['after-frame'],
      probe.label,
    );
  } catch (error) {
    injectedRed = error as Error;
  }
  console.log(
    `(c) negative-arm(injected): red=${injectedRed ? 'yes' : 'no'} triggered=${counts['after-frame']} ` +
      `message=${injectedRed?.message ?? '<none>'}`,
  );
  assert.ok(injectedRed, 'the in-memory injection form must red the negative-control assertion');
  assert.match(injectedRed.message, /unregistered trunk step criterion\.probe\.after-frame was invoked/);

  // And the green arm again on a fresh table: registered, one frame, exactly one call.
  const restoredTable = createDefaultVoiceRealtimeTrunkSteps();
  restoredTable.register(probe);
  const restoredSocket = wireConnection(restoredTable);
  try {
    restoredSocket.receive({ type: 'narrator_done', utteranceId: 'u-3' });
  } finally {
    restoredSocket.close();
  }
  console.log(
    `(c) negative-arm(restored): triggered=${counts['after-frame']} registered=${restoredTable.names('after-frame').includes(probe.name)}`,
  );
  // 1 from the injected red, 1 from the restored arm; nothing from the unregistered arm.
  assert.equal(counts['after-frame'], 2, 'the only table-driven call must be the restored arm');
});

// ---------------------------------------------------------------------------
// (d) shipped steps — the table is ordered registration data; the bodies are the old code
// ---------------------------------------------------------------------------

test('the table is ordered: two steps at one timing run in registration order', () => {
  const table = new VoiceRealtimeTrunkStepRegistry();
  const order: string[] = [];
  const step = (name: string): VoiceRealtimeTrunkStep => ({
    timing: 'after-frame',
    name,
    label: `criterion.order.${name}`,
    source: TEST_SOURCE,
    run: () => order.push(name),
  });
  table.register(step('first')).register(step('second')).register(step('third'));
  // Re-registering an existing name replaces it IN PLACE, so the order is the registration's.
  table.register({ ...step('second'), run: () => order.push('second-again') });

  const ran = table.run('after-frame', makeTrunkContext('after-frame', { frame: { type: 'close' } }));
  console.log(`(d) order: registered=${JSON.stringify(table.names('after-frame'))} ran=${JSON.stringify(order)}`);
  assert.deepEqual(table.names('after-frame'), ['first', 'second', 'third']);
  assert.deepEqual(order, ['first', 'second-again', 'third']);
  assert.equal(ran.length, 3, 'every registered step at the timing runs, not just one');

  // An EMPTY timing runs nothing and reports it — no throw, no built-in fallback.
  const empty = new VoiceRealtimeTrunkStepRegistry();
  const none = empty.run('after-frame', makeTrunkContext('after-frame', { frame: { type: 'close' } }));
  console.log(`(d) empty-timing: ran=${none.length}`);
  assert.equal(none.length, 0);
});

test('every shipped step is registered from the sibling step file, not the proxy', () => {
  console.log(`(d) shipped-steps: count=${VOICE_REALTIME_TRUNK_STEPS.length}`);
  for (const step of VOICE_REALTIME_TRUNK_STEPS) {
    console.log(`(d) shipped-step: ${step.timing}/${step.name}<-${step.label}@${step.source}`);
    assert.notEqual(step.source, WS_PROXY_SOURCE, `${step.name} must not be defined in the proxy`);
    assert.ok(step.source.endsWith(STEPS_BASENAME), `${step.name} must be defined in ${STEPS_REL}`);
  }
  const table = createDefaultVoiceRealtimeTrunkSteps();
  const registered: string[] = [];
  for (const timing of VOICE_REALTIME_TRUNK_TIMINGS) {
    for (const name of table.names(timing)) {
      registered.push(`${timing}/${name}`);
    }
  }
  console.log(`(d) shipped-table: ${JSON.stringify(registered)}`);
  assert.deepEqual(
    registered,
    VOICE_REALTIME_TRUNK_STEPS.map((step) => `${step.timing}/${step.name}`),
    'the default table must hold the shipped steps in the order they are declared',
  );
});

test('behaviour preserved: the shipped bodies answer the old sites', () => {
  const table = createDefaultVoiceRealtimeTrunkSteps();

  // after-handshake, upstream NOT open: the page is told TRANSPORT and the connection ends.
  const failed = makeTrunkContext('after-handshake', { connected: false });
  table.run('after-handshake', failed);
  console.log(`(d) after-handshake(failed): sent=${JSON.stringify(failed.calls.sent)} teardowns=${failed.calls.teardowns}`);
  // after-handshake, open: the instructions as they stand are advertised.
  const opened = makeTrunkContext('after-handshake', { connected: true });
  table.run('after-handshake', opened);
  console.log(`(d) after-handshake(open): advertised=${opened.calls.advertised} teardowns=${opened.calls.teardowns}`);

  // before-frame: a real frame parses, a malformed one is dropped.
  const parsed = makeTrunkContext('before-frame', { raw: JSON.stringify({ type: 'close' }), frame: null });
  table.run('before-frame', parsed);
  const dropped = makeTrunkContext('before-frame', { raw: 'not json at all', frame: null });
  table.run('before-frame', dropped);
  const buffered = makeTrunkContext('before-frame', {
    raw: Buffer.from(JSON.stringify({ type: 'context', text: 'hi', chars: 2, rows: 1 }), 'utf8'),
    frame: null,
  });
  table.run('before-frame', buffered);
  console.log(
    `(d) before-frame: parsed=${JSON.stringify(parsed.payload.frame)} dropped=${JSON.stringify(dropped.payload.frame)} ` +
      `buffered=${JSON.stringify(buffered.payload.frame)}`,
  );

  // interrupt-decision: the fence's two guards, and the neutralized form that must abort.
  const covered = makeTrunkContext('interrupt-decision', {
    triggerSeq: 3,
    coveredSeqs: new Set([1, 3]),
    abortedTriggerSeq: null,
    decision: null,
  });
  table.run('interrupt-decision', covered);
  const repeated = makeTrunkContext('interrupt-decision', {
    triggerSeq: 5,
    coveredSeqs: new Set(),
    abortedTriggerSeq: 5,
    decision: null,
  });
  table.run('interrupt-decision', repeated);
  const unfenced = makeTrunkContext('interrupt-decision', {
    triggerSeq: 5,
    coveredSeqs: new Set(),
    abortedTriggerSeq: null,
    decision: null,
  });
  table.run('interrupt-decision', unfenced);
  console.log(
    `(d) interrupt-decision: covered=${covered.payload.decision} repeated=${repeated.payload.decision} ` +
      `unfenced=${unfenced.payload.decision}`,
  );

  // status-injection: the composed text goes on the wire and `sent` says so.
  const injected = makeTrunkContext('status-injection', { instructions: 'composed instructions', sent: false });
  table.run('status-injection', injected);
  console.log(`(d) status-injection: updates=${JSON.stringify(injected.calls.sessionUpdates)} sent=${injected.payload.sent}`);

  // before-close: the capture is finalized once.
  const closing = makeTrunkContext('before-close', { audioFramesFromBrowser: 4 });
  table.run('before-close', closing);
  console.log(`(d) before-close: captureFinalized=${closing.calls.captureFinalized}`);

  // ---- assertions ----
  assert.deepEqual(failed.calls.sent, [
    { type: 'error', code: 'TRANSPORT', message: 'The Realtime upstream could not be reached.' },
  ]);
  assert.equal(failed.calls.teardowns, 1);
  assert.equal(failed.calls.advertised, 0);
  assert.equal(opened.calls.advertised, 1);
  assert.equal(opened.calls.teardowns, 0);
  assert.deepEqual(parsed.payload.frame, { type: 'close' });
  assert.equal(dropped.payload.frame, null);
  assert.deepEqual(buffered.payload.frame, { type: 'context', text: 'hi', chars: 2, rows: 1 });
  assert.equal(covered.payload.decision, 'covered');
  assert.equal(repeated.payload.decision, 'covered');
  assert.equal(unfenced.payload.decision, 'abort', 'with both guards neutralized the stop aborts');
  assert.deepEqual(injected.calls.sessionUpdates, ['composed instructions']);
  assert.equal(injected.payload.sent, true);
  assert.equal(closing.calls.captureFinalized, 1);
});
