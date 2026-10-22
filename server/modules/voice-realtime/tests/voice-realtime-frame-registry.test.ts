/**
 * Criterion — the `/voice-realtime` proxy's inbound-frame extension point.
 *
 * `voice-realtime-ws-proxy.service.ts` used to route every inbound frame from one
 * `socket.on('message')` callback with an inline `if (frame.type === …)` arm per kind,
 * so adding a frame meant editing the 6.7k-line centre. This criterion holds the
 * replacement — a registry (`voice-realtime-frame-registry.ts`) plus a sibling handler
 * file (`voice-realtime-frame-handlers.ts`) — to four readings:
 *
 * (b) POSITIVE ARM — a handler registered from a file that is NOT the proxy is what a
 *     real connection dispatches on its frame. The probe below is registered from THIS
 *     file over `context`, the proxy is handed that registry through its `frameRegistry`
 *     seam, and the connection's own message handler answers the probe. The printed
 *     reading names the handler, its source path and the proxy's path, and the two paths
 *     must differ.
 *
 * (c) NEGATIVE CONTROL — an unregistered handler is not invoked. The same assertion
 *     function (`assertUnregisteredFrameHandlerNotInvoked`) is driven by the real
 *     registry (green: unregister, send the frame, probe body never runs) and by an
 *     in-memory injection form — a dispatcher with the registration check removed, which
 *     calls the probe anyway. The injection form must make that same function throw, so
 *     the assertion is proven to have teeth rather than passing because nothing was
 *     watching. The red reading is printed, then the shipped handler is restored and the
 *     arm is green again.
 *
 * (d) BEHAVIOUR IS UNCHANGED — the shipped handlers are the old branch bodies moved
 *     verbatim; the spot assertions drive each one through the registry and compare its
 *     effects with the effects the old arms produced (a context pack stored and
 *     advertised, the narrator ack forwarded, a matching run-output answer summarized, a
 *     segment opened, a continuous frame forwarded byte-for-byte, an unknown segment end
 *     refused, a close frame tearing down, and a segmented offer declared).
 *
 * Every reading is printed before it is asserted, so a red lands on the reading that is
 * wrong.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import type { RealtimeBridge } from '../voice-realtime-bridge.service.js';
import type { LocalSpeechBoundary, LocalSpeechGate } from '../voice-realtime-local-speech.js';
import type { SilenceTailGate } from '../voice-realtime-silence-tail.js';
import type { UplinkVadGate } from '../voice-realtime-uplink-vad-gate.js';
import {
  VOICE_REALTIME_FRAME_HANDLERS,
  createDefaultVoiceRealtimeFrameRegistry,
} from '../voice-realtime-frame-handlers.js';
import {
  VoiceRealtimeFrameRegistry,
  type VoiceRealtimeFrameConnectionState,
  type VoiceRealtimeFrameContext,
  type VoiceRealtimeFrameHandler,
} from '../voice-realtime-frame-registry.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport } from './realtime-bridge-harness.js';

/** The file this criterion — the "non-proxy file" of the positive arm — is. */
const TEST_SOURCE = fileURLToPath(import.meta.url);

/** The proxy's own file, for the "the handler did not come from there" readings. */
const WS_PROXY_SOURCE = fileURLToPath(new URL('../voice-realtime-ws-proxy.service.ts', import.meta.url));

/** The handlers file, for the "every shipped handler is registered from there" reading. */
const HANDLERS_REL = 'server/modules/voice-realtime/voice-realtime-frame-handlers.ts';

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses (`readyState`, `send`, `close`,
 * `on('message' | 'close', …)`). Driven over `EventEmitter` rather than a real socket
 * pair, so the whole proxy runs in-process.
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

/** Wires one real proxy connection over a fake browser socket, with `registry` as its dispatch table. */
function wireConnection(registry: VoiceRealtimeFrameRegistry): FakeBrowserSocket {
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
    frameRegistry: registry,
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return socket;
}

/** The shipped handler for a kind, so an arm can restore what it unregistered. */
function shippedHandler(name: VoiceRealtimeFrameHandler['name']): VoiceRealtimeFrameHandler {
  const handler = VOICE_REALTIME_FRAME_HANDLERS.find((candidate) => candidate.name === name);
  assert.ok(handler, `the shipped set must register ${name}`);
  return handler;
}

/**
 * THE NEGATIVE-CONTROL ASSERTION, used by both arms.
 *
 * Runs `dispatch` and asserts the handler body was not invoked. `invocations` is read
 * around the call rather than trusted from the handler's own closure so this function is
 * the one place the "not triggered" rule lives — the real arm and the injected arm both
 * go through it, which is what makes the injected red evidence that this function can
 * fail.
 */
function assertUnregisteredFrameHandlerNotInvoked(
  dispatch: () => void,
  invocations: () => number,
  label: string,
): void {
  const before = invocations();
  dispatch();
  const after = invocations();
  assert.equal(after, before, `unregistered frame handler ${label} was invoked (${before} -> ${after})`);
}

/** A probe handler defined in THIS file — the "registered from a non-proxy file" subject. */
function makeProbe(invocations: { count: number; frames: VoiceRealtimeInboundFrame[] }): VoiceRealtimeFrameHandler {
  return {
    name: 'context',
    label: 'criterion.probe.context',
    source: TEST_SOURCE,
    handle: (_context, _state, frame) => {
      invocations.count += 1;
      invocations.frames.push(frame as VoiceRealtimeInboundFrame);
    },
  };
}

const CONTEXT_FRAME: VoiceRealtimeInboundFrame = { type: 'context', text: 'the plan', chars: 8, rows: 1 };

/**
 * THE IN-MEMORY INJECTION FORM.
 *
 * A dispatcher of the same call shape with the registration check removed: it calls the
 * handler it was handed whether or not it is registered. It is not the registry — it is
 * the mutant the negative-control assertion exists to catch.
 */
function injectedLeakyDispatch(handler: VoiceRealtimeFrameHandler): () => void {
  return () => {
    handler.handle(makeFrameContext(), makeFrameState(), CONTEXT_FRAME);
  };
}

// ---------------------------------------------------------------------------
// Fixtures for the registry-level (behaviour) arms
// ---------------------------------------------------------------------------

type BridgeCalls = {
  audio: string[];
  segmentAudio: Array<{ seq: number; audio: string }>;
  started: number[];
  ended: number[];
  localStart: number;
  localEnd: number;
  localActivity: number;
};

function makeBridge(): { bridge: RealtimeBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = {
    audio: [],
    segmentAudio: [],
    started: [],
    ended: [],
    localStart: 0,
    localEnd: 0,
    localActivity: 0,
  };
  const bridge = {
    state: 'open',
    sendAudioFrame: (audio: string) => calls.audio.push(audio),
    sendSegmentAudio: (seq: number, audio: string) => calls.segmentAudio.push({ seq, audio }),
    startSegment: (seq: number) => calls.started.push(seq),
    endSegment: (seq: number) => calls.ended.push(seq),
    noteLocalUtteranceStart: () => {
      calls.localStart += 1;
    },
    noteLocalUtteranceEnd: () => {
      calls.localEnd += 1;
    },
    noteLocalActivity: () => {
      calls.localActivity += 1;
    },
    sendSessionUpdate: () => undefined,
  } as unknown as RealtimeBridge;
  return { bridge, calls };
}

type ContextCalls = {
  sent: VoiceRealtimeOutboundFrame[];
  logs: string[];
  advertised: number;
  cleared: number;
  summarized: Array<{ generation: number; runId: string | null; output: string }>;
  narratorDone: string[];
  boundary: Array<LocalSpeechBoundary | null>;
  enqueued: string[];
  teardowns: number;
  exits: number;
  audioCaptureFrames: string[];
};

/**
 * Every seam a shipped handler may reach, inert by default.
 *
 * `localSpeechGate` is a one-method stand-in: the audio branch only calls `observe`
 * and hands the answer to `reportLocalSpeechBoundary`, so the fixture can read both
 * sides without building a real gate.
 */
function makeFrameContext(
  overrides: Partial<VoiceRealtimeFrameContext> = {},
): VoiceRealtimeFrameContext & { calls: ContextCalls } {
  const calls: ContextCalls = {
    sent: [],
    logs: [],
    advertised: 0,
    cleared: 0,
    summarized: [],
    narratorDone: [],
    boundary: [],
    enqueued: [],
    teardowns: 0,
    exits: 0,
    audioCaptureFrames: [],
  };
  const { bridge } = makeBridge();
  const context = {
    seams: {
      instructions: '',
      createTransport: () => createFakeTransport(),
      createExecutor: () => ({}),
      log: (line: string) => calls.logs.push(line),
      audioCapture: { frame: (audio: string) => calls.audioCaptureFrames.push(audio) },
    } as unknown as VoiceRealtimeProxySeams,
    send: (frame: VoiceRealtimeOutboundFrame) => calls.sent.push(frame),
    segmentedRelay: false,
    contextMaxChars: 2_000,
    bridge,
    narratorQueue: {
      completed: (utteranceId: string) => calls.narratorDone.push(utteranceId),
    } as unknown as VoiceRealtimeFrameContext['narratorQueue'],
    advertiseInstructions: () => {
      calls.advertised += 1;
      return true;
    },
    clearRunOutputRequest: () => {
      calls.cleared += 1;
    },
    summarizeRunOutput: async (generation: number, runId: string | null, output: string) => {
      calls.summarized.push({ generation, runId, output });
    },
    segmentFrameCounts: new Map<number, number>(),
    endedSegmentSeqs: new Set<number>(),
    noteUserSpokeForNarrator: () => undefined,
    speakerWindows: null,
    localSpeechGate: { observe: () => null } as unknown as LocalSpeechGate,
    reportLocalSpeechBoundary: (boundary: LocalSpeechBoundary | null) => calls.boundary.push(boundary),
    silenceTail: null as SilenceTailGate | null,
    silenceTailOptions: null,
    uplinkVad: null as UplinkVadGate | null,
    enqueueUplinkVad: (audio: string) => calls.enqueued.push(audio),
    teardown: () => {
      calls.teardowns += 1;
    },
    exitUplinkVad: async () => {
      calls.exits += 1;
    },
    ...overrides,
  } as VoiceRealtimeFrameContext & { calls: ContextCalls };
  Object.defineProperty(context, 'calls', { value: calls, enumerable: false });
  return context;
}

function makeFrameState(
  overrides: Partial<VoiceRealtimeFrameConnectionState> = {},
): VoiceRealtimeFrameConnectionState {
  return {
    contextText: '',
    contextChars: 0,
    contextRows: 0,
    audioFramesFromBrowser: 0,
    speakerObserveFailureLogged: false,
    runOutputPending: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (b) positive arm — a handler from outside the proxy is what a connection dispatches
// ---------------------------------------------------------------------------

test('positive arm: a frame handler registered from a non-proxy file is triggered by a real connection', () => {
  const registry = createDefaultVoiceRealtimeFrameRegistry();
  const invocations = { count: 0, frames: [] as VoiceRealtimeInboundFrame[] };
  const probe = makeProbe(invocations);
  registry.register(probe);
  const socket = wireConnection(registry);

  try {
    socket.receive(CONTEXT_FRAME);

    console.log(
      `(b) positive-arm: frame=context handler=${probe.label} source=${probe.source} ` +
        `wsProxySource=${WS_PROXY_SOURCE}`,
    );
    console.log(
      `(b) positive-arm: triggered=${invocations.count} frameText=${invocations.frames[0]?.type === 'context' ? invocations.frames[0].text : '<none>'}`,
    );

    assert.equal(invocations.count, 1, 'the registered probe must be called exactly once');
    assert.deepEqual(invocations.frames[0], CONTEXT_FRAME, 'the connection must pass the parsed frame');
    assert.notEqual(probe.source, WS_PROXY_SOURCE, 'the handler source must not be the proxy file');
    assert.ok(
      probe.source.endsWith('voice-realtime-frame-registry.test.ts'),
      `the probe source must be this criterion file, got ${probe.source}`,
    );
  } finally {
    socket.close();
  }
});

test('the shipped handler set is all registered from the sibling handlers file, not the proxy', () => {
  const registry = createDefaultVoiceRealtimeFrameRegistry();
  console.log(`(b) shipped-handlers: count=${registry.names().length}`);
  for (const handler of VOICE_REALTIME_FRAME_HANDLERS) {
    console.log(`(b) shipped-handler: ${handler.name}<-${handler.label}@${handler.source}`);
  }

  assert.deepEqual(
    VOICE_REALTIME_FRAME_HANDLERS.map((handler) => handler.name).sort(),
    ['audio', 'close', 'context', 'hello', 'narrator_done', 'run_output', 'segment_end', 'segment_start'],
    'the shipped set must cover every inbound frame kind',
  );
  assert.deepEqual(
    registry.names().sort(),
    VOICE_REALTIME_FRAME_HANDLERS.map((handler) => handler.name).sort(),
  );
  for (const handler of VOICE_REALTIME_FRAME_HANDLERS) {
    assert.notEqual(handler.source, WS_PROXY_SOURCE, `${handler.name} must not be defined in the proxy`);
    assert.ok(
      handler.source.endsWith('voice-realtime-frame-handlers.ts'),
      `${handler.name} must be defined in ${HANDLERS_REL}, got ${handler.source}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) negative control — unregistered means not invoked, on the SAME assertion
// ---------------------------------------------------------------------------

test('negative control: unregistered not invoked; an injected leaky dispatch reds the same assertion', () => {
  const registry = createDefaultVoiceRealtimeFrameRegistry();
  const invocations = { count: 0, frames: [] as VoiceRealtimeInboundFrame[] };
  const probe = makeProbe(invocations);
  registry.register(probe);
  const socket = wireConnection(registry);

  try {
    // The real arm: the probe is unregistered, the connection still receives the frame,
    // and the probe body must not run.
    registry.unregister('context');
    assertUnregisteredFrameHandlerNotInvoked(
      () => {
        socket.receive(CONTEXT_FRAME);
      },
      () => invocations.count,
      probe.label,
    );
    console.log(
      `(c) negative-arm(registry): triggered=${invocations.count} handlerRegistered=${registry.has('context')}`,
    );
    assert.equal(invocations.count, 0, 'the unregistered probe must not run');
  } finally {
    socket.close();
  }

  // The injection form: the same assertion function, driven by a dispatcher that ignores
  // registration. It must throw — that red is the proof the assertion has teeth, and it is
  // printed before being asserted.
  let injectedRed: Error | null = null;
  try {
    assertUnregisteredFrameHandlerNotInvoked(
      injectedLeakyDispatch(probe),
      () => invocations.count,
      probe.label,
    );
  } catch (error) {
    injectedRed = error as Error;
  }
  console.log(
    `(c) negative-arm(injected): red=${injectedRed ? 'yes' : 'no'} triggered=${invocations.count} ` +
      `message=${injectedRed?.message ?? '<none>'}`,
  );
  assert.ok(injectedRed, 'the in-memory injection form must red the negative-control assertion');
  assert.match(
    injectedRed.message,
    /unregistered frame handler criterion\.probe\.context was invoked/,
  );

  // Restore the shipped handler and take the green reading again: the probe is STILL
  // unregistered, so the restored arm must not call it either.
  registry.register(shippedHandler('context'));
  const restoredSocket = wireConnection(registry);
  try {
    assertUnregisteredFrameHandlerNotInvoked(
      () => {
        restoredSocket.receive(CONTEXT_FRAME);
      },
      () => invocations.count,
      probe.label,
    );
  } finally {
    restoredSocket.close();
  }
  console.log(
    `(c) negative-arm(restored): triggered=${invocations.count} handlerRegistered=${registry.has('context')}`,
  );
  assert.equal(invocations.count, 1, 'the only invocation must be the injected red, none from either real arm');
});

// ---------------------------------------------------------------------------
// (d) behaviour is unchanged — spot readings against the moved bodies
// ---------------------------------------------------------------------------

test('behaviour preserved: the shipped handlers answer the old frames', () => {
  const registry = createDefaultVoiceRealtimeFrameRegistry();

  // hello (segmented): the exact token is echoed.
  const hello = makeFrameContext({ segmentedRelay: true });
  registry.dispatch('hello', hello, makeFrameState(), { type: 'hello', protocol: 'segmented-v1' });
  console.log(`(d) hello: sent=${JSON.stringify(hello.calls.sent)} logs=${JSON.stringify(hello.calls.logs)}`);

  // context: the pack is stored (not trimmed) and the instructions are re-advertised.
  const context = makeFrameContext();
  const contextState = makeFrameState();
  registry.dispatch('context', context, contextState, CONTEXT_FRAME);
  console.log(
    `(d) context: text=${JSON.stringify(contextState.contextText)} chars=${contextState.contextChars} ` +
      `rows=${contextState.contextRows} advertised=${context.calls.advertised}`,
  );

  // context over the cap: refused whole, state untouched.
  const overCap = makeFrameContext({ contextMaxChars: 4 });
  const overCapState = makeFrameState();
  registry.dispatch('context', overCap, overCapState, { type: 'context', text: 'toolong', chars: 7, rows: 1 });
  console.log(`(d) context-over-cap: text=${JSON.stringify(overCapState.contextText)} logs=${JSON.stringify(overCap.calls.logs)}`);

  // narrator_done: the ack goes to the queue.
  const narrator = makeFrameContext();
  registry.dispatch('narrator_done', narrator, makeFrameState(), { type: 'narrator_done', utteranceId: 'u-1' });
  console.log(`(d) narrator_done: completed=${JSON.stringify(narrator.calls.narratorDone)}`);

  // run_output: a stale id is ignored; the standing one is cleared and summarized.
  const runOutput = makeFrameContext();
  const staleState = makeFrameState({ runOutputPending: { requestId: 'run-output-1', generation: 2, runId: 'r' } });
  registry.dispatch('run_output', runOutput, staleState, { type: 'run_output', requestId: 'run-output-0', text: 'old' });
  const staleReading = { cleared: runOutput.calls.cleared, summarized: runOutput.calls.summarized.length };
  const liveState = makeFrameState({ runOutputPending: { requestId: 'run-output-1', generation: 2, runId: 'r' } });
  registry.dispatch('run_output', runOutput, liveState, { type: 'run_output', requestId: 'run-output-1', text: 'the answer' });
  console.log(
    `(d) run_output: stale=${JSON.stringify(staleReading)} live=${JSON.stringify(runOutput.calls.summarized)}`,
  );

  // segment_start: the seq is counted, the narration cleared and the watchdog armed.
  const segmentStartBridge = makeBridge();
  const segmentStart = makeFrameContext({ bridge: segmentStartBridge.bridge });
  registry.dispatch('segment_start', segmentStart, makeFrameState(), {
    type: 'segment_start',
    seq: 4,
  });
  console.log(
    `(d) segment_start: seqZero=${segmentStart.segmentFrameCounts.get(4)} ` +
      `bridgeStarted=${JSON.stringify(segmentStartBridge.calls.started.length)}`,
  );

  // audio (continuous, no gates): forwarded byte-for-byte with the watchdog fed first.
  const audioContext = makeFrameContext();
  const audioState = makeFrameState();
  registry.dispatch('audio', audioContext, audioState, { type: 'audio', audio: 'AAA=' });
  console.log(
    `(d) audio: frames=${audioState.audioFramesFromBrowser} captured=${JSON.stringify(audioContext.calls.audioCaptureFrames)} ` +
      `boundary=${JSON.stringify(audioContext.calls.boundary)}`,
  );

  // segment_end for an unknown seq: dropped with the ack, never committed.
  const segmentEnd = makeFrameContext();
  registry.dispatch('segment_end', segmentEnd, makeFrameState(), { type: 'segment_end', seq: 9 });
  console.log(`(d) segment_end-unknown: sent=${JSON.stringify(segmentEnd.calls.sent)}`);

  // close with no uplink VAD: the default teardown.
  const close = makeFrameContext();
  const closeState = makeFrameState({ audioFramesFromBrowser: 3 });
  registry.dispatch('close', close, closeState, { type: 'close' });
  console.log(`(d) close: teardowns=${close.calls.teardowns} logs=${JSON.stringify(close.calls.logs)}`);

  // ---- assertions ----
  assert.deepEqual(hello.calls.sent, [{ type: 'ready', protocol: 'segmented-v1' }]);
  assert.equal(contextState.contextText, 'the plan');
  assert.equal(contextState.contextChars, 8);
  assert.equal(contextState.contextRows, 1);
  assert.equal(context.calls.advertised, 1);
  assert.equal(overCapState.contextText, '', 'an over-cap pack must be refused whole, not trimmed');
  assert.equal(overCap.calls.logs.length, 1);
  assert.deepEqual(narrator.calls.narratorDone, ['u-1']);
  assert.deepEqual(staleReading, { cleared: 0, summarized: 0 }, 'a stale run-output answer must be ignored');
  assert.deepEqual(runOutput.calls.summarized, [{ generation: 2, runId: 'r', output: 'the answer' }]);
  assert.equal(runOutput.calls.cleared, 1);
  assert.equal(segmentStart.segmentFrameCounts.get(4), 0);
  assert.equal(segmentStartBridge.calls.started.length, 1);
  assert.equal(audioState.audioFramesFromBrowser, 1);
  assert.deepEqual(audioContext.calls.audioCaptureFrames, ['AAA=']);
  assert.deepEqual(audioContext.calls.boundary, [null]);
  assert.deepEqual(segmentEnd.calls.sent, [
    { type: 'segment_ack', seq: 9, state: 'dropped', reason: 'unknown-segment' },
  ]);
  assert.equal(close.calls.teardowns, 1);
  assert.match(close.calls.logs[0], /audio frames received=3/);
});
