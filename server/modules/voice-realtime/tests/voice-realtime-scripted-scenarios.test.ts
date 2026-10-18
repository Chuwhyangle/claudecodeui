/**
 * The scripted-endpoint scenario suite: what the BROWSER is told, for a script we chose.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DID. Three of the failures below were found only in
 * production journals, because no stand-in could say them: the endpoint's own `error`, the
 * model REPLYING IN TEXT instead of calling the tool (`MODEL_TEXT_REPLY` — the 2026-10-11
 * mobile session lost six of seven utterances this way), and a session whose queue is
 * holding work while the person keeps talking. A fourth class was covered only by accident of
 * a recording.
 *
 * HOW IT RUNS. The real transport and the REAL proxy — `createDashscopeTransport` and
 * `handleVoiceRealtimeConnection`, the same functions production wires in `server/index.ts` —
 * driven by `createScriptedUpstream`, which never opens a socket and never reads a credential.
 * Only the executor is a stub, so the assertions are about the relay's own contract rather
 * than about a session's contents. The shape is the one `voice-realtime-replay.test.ts`
 * proved: the assertion that matters most comes first, and it is that a healthy session tells
 * the browser about no failure at all.
 *
 * `afterMs` waits are real macrotasks, so a delivery the previous event started has settled
 * before the next is announced: the assertions read a sequence, not a race.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  createDashscopeTransport,
  createVoiceRealtimeLiveExecutor,
  type OmissionFillParams,
  type RealtimeToolExecutor,
} from '../index.js';
import {
  buildInterruptAftermathNote,
  handleVoiceRealtimeConnection,
  normalizeRelayText,
  relayRestatesDelivery,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeExecStatusReading,
  type VoiceRealtimeOutboundFrame,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { expectKnownDefect } from './voice-realtime-known-defect.js';
import {
  createScriptedCliHost,
  DEFAULT_STALE_WINDOW_MS,
  type CliTurn,
  type ScriptedCliHost,
} from './voice-realtime-scripted-cli-host.js';
import {
  captionCompleted,
  captionDelta,
  createScriptedUpstream,
  endpointError,
  functionCall,
  modelTextReply,
  SCRIPTED_ENDPOINT_URL,
  transcriptionFailed,
  type ScriptedUpstream,
  type ScriptedVadTurn,
} from './voice-realtime-scripted-upstream.js';

/** The browser end of the socket, driven directly — the same stand-in the replay criterion uses. */
class FakeBrowserSocket extends EventEmitter {  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }
  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type Scenario = {
  readonly upstream: ScriptedUpstream;
  readonly socket: FakeBrowserSocket;
  /** Every message the executor was handed, in order. */
  readonly delivered: string[];
  /** How many times the executor was called at all. */
  readonly calls: () => number;
};

/**
 * The text a CORRECTION reaches the CLI as, once the proxy is done with it.
 *
 * The stop's aftermath note rides the correction (ruling 2026-10-16): it is armed before the enqueue,
 * so the message the stop's own words go in on is the one that carries the explanation of the
 * interruption. The scenarios below compare against the text the CLI REALLY received rather than
 * against the words alone — "the correction is queued before the abort" is a claim about that text.
 *
 * The tool-free form: a scenario that never calls `setInFlightTool` leaves the host's activity
 * reading at `null`, and the proxy never guesses a tool it could not read (C-3).
 */
const withAftermathNote = (text: string): string => `${buildInterruptAftermathNote(null)}\n\n${text}`;

/**
 * Boots one scenario: the real transport, the real proxy, a stub executor.
 *
 * `queuedForFirst` makes the session's own queue accept the first N calls (`queued: true`) —
 * the "busy session" a person talks into while Claude is still working.
 */
function startScenario(options: { queuedForFirst?: number } = {}): Scenario {
  const upstream = createScriptedUpstream();
  const delivered: string[] = [];
  let calls = 0;
  const queuedForFirst = options.queuedForFirst ?? 0;
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls += 1;
      delivered.push(String(args.message));
      return { runId: `run_${calls}`, queued: calls <= queuedForFirst };
    },
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'scripted-scenario-session',
    {
      // No credential and a stand-in factory: the two together are what make this run
      // offline by construction. The endpoint address is the stand-in's own, so the address
      // the transport dialled is checkable (see the isolation test below).
      createTransport: (report) =>
        createDashscopeTransport({ apiKey: '', endpoint: SCRIPTED_ENDPOINT_URL, socketFactory: upstream.socketFactory, onError: report }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
      // Pinned to the segmented wire, not read from the environment: this file's MODEL_TEXT_REPLY
      // case (decision doc §12.6 B-8) is specifically about the segmented wire's error-reporting
      // contract — under continuous the same error is "heard, not forwarded" and never reaches the
      // browser — so it must not drift with whichever mode the deployment defaults to.
      segmentedRelay: true,
    },
  );
  return { upstream, socket, delivered, calls: () => calls };
}

/** Resolves once the proxy has reported the upstream session open to the browser. */
const openSession = async (scenario: {
  readonly socket: FakeBrowserSocket;
  readonly upstream: ScriptedUpstream;
}): Promise<void> => {
  await waitFor(() => scenario.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
  // Every scenario in this file, continuous or scripted, reads its egress here — so "zero outbound
  // network" is a fact taken at the one moment a dial could have happened, not an intention.
  assertNoEgress(scenario);
};

/** The failure frame, narrowed — the codes the assertions below read live only on this member. */
type ErrorFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'error' }>;

/**
 * The FOUR readings below are all taken off one socket, so that is all they ask for. Every scenario
 * in this file — the protocol-scripted ones and the continuous ones — has one, and neither has to
 * satisfy the other's shape to be read.
 */
type SocketReader = { readonly socket: FakeBrowserSocket };

const errorsOf = (scenario: SocketReader): ErrorFrame[] =>
  scenario.socket.outbound.filter((frame): frame is ErrorFrame => frame.type === 'error');

const finalsOf = (scenario: SocketReader): string[] =>
  scenario.socket.outbound
    .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption' && frame.final)
    .map((frame) => frame.text);

const interimsOf = (scenario: SocketReader): string[] =>
  scenario.socket.outbound
    .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption' && !frame.final)
    .map((frame) => frame.text);

/** The waiting depth the proxy reported on each delivery, in order. */
const sentDepths = (scenario: SocketReader): number[] =>
  scenario.socket.outbound
    .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }> => frame.type === 'sent')
    .map((frame) => (typeof frame.depth === 'number' ? frame.depth : -1));

test('a healthy script: what was heard and sent reaches the browser once each, in order, with no error at all', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  await scenario.upstream.runScript([
    { wire: captionDelta('item_a', '把 server 的') },
    { wire: captionDelta('item_a', '把 server 的日志贴出来') },
    { wire: captionCompleted('item_a', '把 server 的日志贴出来') },
    { wire: functionCall('session_send', { message: '把 server 的日志贴出来' }, 'call_a') },
  ]);
  await waitFor(() => scenario.delivered.length === 1);

  // The falsifiable core of this file, and the reason the real-endpoint recording asserted it
  // first: a session that worked told the browser about NO failure. Everything below reads a
  // sequence this assertion has already declared clean.
  assert.deepEqual(errorsOf(scenario), [], 'a healthy script must produce no error frames');

  assert.deepEqual(finalsOf(scenario), ['把 server 的日志贴出来'], 'one item, one final caption');
  assert.deepEqual(scenario.delivered, ['把 server 的日志贴出来'], 'the call reached the executor exactly once');
  assert.equal(scenario.calls(), 1);
  scenario.socket.close();
});

test('an interim caption never becomes a final with no words', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  // The real endpoint's asymmetry: a `delta` carries its running words in `stash` while its
  // `text` field is EMPTY. A relay that read `text` would blank the person's row on every
  // interim event, and would close an utterance carrying nothing.
  await scenario.upstream.runScript([
    { wire: captionDelta('item_b', '第一句') },
    { wire: captionDelta('item_b', '第一句完整') },
    { wire: captionCompleted('item_b', '第一句完整') },
    { wire: captionDelta('item_c', '第二句') },
    { wire: captionCompleted('item_c', '第二句') },
  ]);
  await waitFor(() => finalsOf(scenario).length === 2);

  assert.deepEqual(finalsOf(scenario), ['第一句完整', '第二句'], 'finals follow the script, in order');
  assert.deepEqual(interimsOf(scenario), ['第一句', '第一句完整', '第二句'], 'the interim words came from `stash`');
  const blank = scenario.socket.outbound.filter(
    (frame) => frame.type === 'caption' && frame.final && frame.text.trim() === '',
  );
  assert.deepEqual(blank, [], 'no final caption may carry no words');
  scenario.socket.close();
});

test('a delay between two utterances reorders nothing and loses nothing', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  await scenario.upstream.runScript([
    { wire: captionCompleted('item_d', '先说的') },
    { wire: functionCall('session_send', { message: '先说的' }, 'call_d') },
    { wire: captionCompleted('item_e', '后说的'), afterMs: 50 },
    { wire: functionCall('session_send', { message: '后说的' }, 'call_e') },
  ]);
  await waitFor(() => scenario.delivered.length === 2, 4_000);

  assert.deepEqual(errorsOf(scenario), []);
  assert.deepEqual(scenario.delivered, ['先说的', '后说的'], 'the order spoken is the order delivered');
  scenario.socket.close();
});

test("the endpoint's own error reaches the browser as a failure, not as silence", async () => {
  const scenario = startScenario();
  await openSession(scenario);

  await scenario.upstream.runScript([{ wire: endpointError('InvalidParameter', 'the endpoint rejected the session') }]);
  await waitFor(() => errorsOf(scenario).length > 0);

  const first = errorsOf(scenario)[0];
  assert.equal(first?.type, 'error');
  assert.equal(first?.code, 'UPSTREAM_ERROR', 'the fault code is the endpoint error, not a generic one');
  assert.equal(scenario.calls(), 0, 'the endpoint failed before any call, so the session was never touched');
  scenario.socket.close();
});

test('the model answering instead of calling the tool is reported, not silently accepted', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  // The 2026-10-11 mobile session, in one frame: seven utterances spoken, six of them answered
  // with the word "OK" and never relayed. The person was told nothing and their words were
  // never sent, so this shape has to be sayable by a stand-in.
  await scenario.upstream.runScript([{ wire: modelTextReply('OK') }]);
  await waitFor(() => errorsOf(scenario).length > 0);

  const first = errorsOf(scenario)[0];
  assert.equal(first?.code, 'MODEL_TEXT_REPLY', 'the model answering itself is its own code');
  assert.equal(scenario.calls(), 0, 'no tool call was made, so the session was never touched');
  assert.deepEqual(scenario.delivered, []);
  scenario.socket.close();
});

test('a spoken segment the endpoint could not transcribe is reported too', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  await scenario.upstream.runScript([{ wire: transcriptionFailed('item_f', 'the audio could not be transcribed') }]);
  await waitFor(() => errorsOf(scenario).length > 0);

  assert.equal(errorsOf(scenario)[0]?.code, 'TRANSCRIPTION_FAILED');
  assert.equal(scenario.calls(), 0);
  scenario.socket.close();
});

test('a busy session admits every utterance in order and says how much it is holding', async () => {
  // The executor accepts (queued: true) rather than starts a run, so the session holds the
  // person's words instead of draining them: this is the "busy session" a person talks into
  // while Claude is still working. Every accepted call is one the queue is holding, so the
  // reported depth may only rise across the three.
  const scenario = startScenario({ queuedForFirst: 3 });
  await openSession(scenario);

  await scenario.upstream.runScript([
    { wire: functionCall('session_send', { message: '第一句' }, 'call_1') },
    { wire: functionCall('session_send', { message: '第二句' }, 'call_2') },
    { wire: functionCall('session_send', { message: '第三句' }, 'call_3') },
  ]);
  await waitFor(() => scenario.delivered.length === 3, 4_000);

  assert.deepEqual(errorsOf(scenario), [], 'talking into a working session is not an error');
  assert.deepEqual(scenario.delivered, ['第一句', '第二句', '第三句'], 'every utterance was admitted, in order');

  // The depth is a READING the person's row is built from, and the criterion is only that it was
  // reported and did not fall while the queue held work. Its numeric values are NOT pinned: the
  // axis the bound is measured on (count vs bytes) is being changed by another task, and a
  // scenario must not collide with that decision.
  const depths = sentDepths(scenario);
  assert.equal(depths.length, 3, 'each delivery reported a depth');
  assert.ok(depths[0]! >= 1, `an accepted call is held, so the first depth is at least one: ${JSON.stringify(depths)}`);
  for (let i = 1; i < depths.length; i += 1) {
    assert.ok(
      depths[i]! >= depths[i - 1]!,
      `the depth must not fall while the queue keeps holding work: ${JSON.stringify(depths)}`,
    );
  }
  scenario.socket.close();
});

test('the stand-in is the only endpoint a scenario can reach', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  // The address the transport dialled is the stand-in's own — so the frames asserted above
  // came from the script and not from anything on the network. The transport appends
  // `?model=<model>`, so the equality to hold is on the address itself, not the query.
  const dialed = scenario.upstream.dialedUrl ?? '';
  assert.equal(
    dialed.split('?')[0],
    SCRIPTED_ENDPOINT_URL,
    `the transport must dial the stand-in's own address: ${dialed}`,
  );

  // And the isolation is enforced, not merely intended: the SAME parameters WITHOUT the
  // stand-in refuse outright instead of dialling a real endpoint with no credential.
  const cloudless = createDashscopeTransport({ apiKey: '', endpoint: SCRIPTED_ENDPOINT_URL });
  await assert.rejects(
    () => cloudless.open(),
    /DASHSCOPE_API_KEY is required/,
    'a transport with neither a key nor a stand-in must refuse rather than dial',
  );
  scenario.socket.close();
});

// =================================================================================================
// B-1..B-9: CONTINUOUS MODE. The browser never segments and never gates; 20 ms PCM frames go up
// including the silence, and the endpoint's own `server_vad` is the only thing that ends an
// utterance. What the person said, what the model decided, and what the CLI did with it are then
// three separate readings — the model's decision is SCRIPTED, so these criteria read the pipeline's
// behaviour under a decision, never the quality of the decision itself (decision doc §12.5).
//
// The CLI is `voice-realtime-scripted-cli-host.ts`, whose five semantics have their own self-tests
// below (AC2). The endpoint is `createScriptedVad` over the real DashScope transport — it decodes the
// PCM this file appends and closes an utterance on its own silence, so "the person stopped talking"
// is a fact about the audio rather than a frame this file asserted.
// =================================================================================================

/** The session every continuous scenario is bound to. */
const CONTINUOUS_SESSION = 'scripted-continuous-session';

/** The 20 ms cadence the real capture uploads at, and its two amplitudes. */
const FRAME_MS = 20;
/** Base64 PCM16 for `ms` of a 16 kHz tone at `amplitude` (0..1). */
function pcm16(ms: number, amplitude: number): string {
  const samples = Math.round((16_000 * ms) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index / 8) * amplitude * 32_767), index * 2);
  }
  return buffer.toString('base64');
}
/** Above the endpoint's `threshold` (0.5): a frame the detector hears as speech. */
const SPOKEN_FRAME = pcm16(FRAME_MS, 0.9);
/** Silence, carried with the speech and never gated out — the whole point of the continuous wire. */
const SILENCE_FRAME = pcm16(FRAME_MS, 0);

/** A `{}` cast to a live-executor dep this file never reaches — `session_status` touches none of them. */
const never = <T>(): T => ({}) as unknown as T;

type SentFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }>;
type StoppedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'stopped' }>;

const sentFrames = (scenario: ContinuousScenario): SentFrame[] =>
  scenario.socket.outbound.filter((frame): frame is SentFrame => frame.type === 'sent');

const stoppedFrames = (scenario: ContinuousScenario): StoppedFrame[] =>
  scenario.socket.outbound.filter((frame): frame is StoppedFrame => frame.type === 'stopped');

/**
 * The egress reading every scenario carries (AC4's 零外联), asserted at the moment the connection is
 * up: the ONLY address the transport ever dialled is the stand-in's own, and it carried no
 * credential — `apiKey: ''` means the header map is empty by construction, so its emptiness is the
 * proof that nothing here could have reached a real endpoint even if the stand-in had let it.
 *
 * The transport appends `?model=<model>`, so the equality to hold is on the address, not the query.
 */
function assertNoEgress(scenario: { readonly upstream: ScriptedUpstream }): void {
  const dialed = scenario.upstream.dialedUrl ?? '';
  assert.equal(
    dialed.split('?')[0],
    SCRIPTED_ENDPOINT_URL,
    `this scenario dialled something other than the stand-in: ${dialed}`,
  );
  const headers = scenario.upstream.dialedHeaders ?? {};
  assert.equal(
    Object.keys(headers).length,
    0,
    `the dial carried a credential: ${JSON.stringify(Object.keys(headers))}`,
  );
}

/** The tool receipts the app returned upstream for one call id, parsed, in order. */
function upstreamReceipts(upstream: ScriptedUpstream, callId: string): Array<Record<string, unknown>> {
  return upstream.clientFrames
    .filter((frame) => {
      if (frame.type !== 'conversation.item.create') return false;
      const item = frame.item as Record<string, unknown> | undefined;
      return item?.type === 'function_call_output' && item.call_id === callId;
    })
    .map((frame) => JSON.parse(String((frame.item as Record<string, unknown>).output)) as Record<string, unknown>);
}

type ContinuousScenario = {
  readonly upstream: ScriptedUpstream;
  readonly socket: FakeBrowserSocket;
  readonly host: ScriptedCliHost;
  /** Every message the executor was handed, in order. */
  readonly delivered: string[];
  /** Every `session_interrupt` the executor was reached with, in order. */
  readonly interrupts: Array<Record<string, unknown>>;
  /** Every reading the proxy published beside a status line, in order. */
  readonly readings: VoiceRealtimeExecStatusReading[];
  /**
   * The connection's own journal — the `log` seam `server/index.ts` wires to
   * `voice-realtime-log.ts`. Read by the legs that assert on a line the operator reads
   * (`session_send not-delivered (…)`) rather than only on what reached the executor.
   */
  readonly logs: string[];
  /** The most recently published reading — the cell a `session_status` call answers from. */
  latest(): VoiceRealtimeExecStatusReading | null;
  /** A REAL `session_status` answer over the live executor this connection was built with. */
  sessionStatus(): Promise<Record<string, unknown>>;
};

type ContinuousOptions = {
  readonly host: ScriptedCliHost;
  readonly turns: readonly ScriptedVadTurn[];
  /**
   * `'busy'` (the default) keeps the run in flight, so later messages are QUEUED behind it — the
   * "person talks while Claude is still working" shape. `'drain'` finishes the previous run first,
   * so every message starts a turn of its own.
   */
  readonly mode?: 'busy' | 'drain';
  readonly silenceDurationMs?: number;
  /**
   * The proxy the connection is opened through. Defaults to the shipping
   * `handleVoiceRealtimeConnection`; the rename-resend leg's false form hands in a transient copy of
   * the module with its criterion mutated, so the whole leg can be re-run against the retired rule
   * rather than only its predicate.
   */
  readonly module?: { handleVoiceRealtimeConnection: typeof handleVoiceRealtimeConnection };
  /**
   * The omission-fill planner's windows, or `null`/absent to DISABLE the producer. Most legs are
   * about other relay behaviour; leg B passes shrunk windows so its fills are observable in-test.
   */
  readonly omissionFillParams?: Partial<OmissionFillParams> | null;
};

/**
 * Boots one continuous scenario: the real transport, the real proxy, the scripted CLI host behind the
 * three host seams, and the endpoint's own acoustic detector.
 *
 * `stallMs: 0` and `hostQueueTurnBoundaryRefresh: false` are deliberate: this file asserts on the
 * readings taken at the points the relay REPORTS a depth, and a watchdog timer and a drain poll
 * would both put readings in between that no scenario asked for — turning a sequence into a race.
 */
function startContinuous(options: ContinuousOptions): ContinuousScenario {
  const upstream = createScriptedUpstream({
    vad: {
      timeBase: 'audio-time',
      silenceDurationMs: options.silenceDurationMs ?? 400,
      threshold: 0.5,
      turns: options.turns,
    },
  });
  const socket = new FakeBrowserSocket();
  const delivered: string[] = [];
  const interrupts: Array<Record<string, unknown>> = [];
  const readings: VoiceRealtimeExecStatusReading[] = [];
  const logs: string[] = [];
  let latest: VoiceRealtimeExecStatusReading | null = null;
  const mode = options.mode ?? 'busy';

  const base = createVoiceRealtimeLiveExecutor({
    boundSessionId: CONTINUOUS_SESSION,
    caller: { userId: 7, scopes: ['cloudcli:read'] },
    visibleContext: never(),
    readTools: never(),
    runGet: never(),
    approvals: never(),
    sessionBackground: never(),
    sessionSend: never(),
    sessionInterrupt: never(),
    onSessionRefusal: () => undefined,
    sessionStatus: { reading: () => latest },
  });

  const executor: RealtimeToolExecutor = {
    ...base,
    session_send: async (args: Record<string, unknown>) => {
      const text = typeof args.message === 'string' ? args.message : '';
      if (mode === 'drain') {
        // The previous turn finished before the CLI was handed this one.
        options.host.complete();
      }
      delivered.push(text);
      const { uuid } = options.host.accept(text);
      const inFlight = options.host.inFlight();
      if (inFlight === null) {
        const [opened] = options.host.advanceTurn();
        return { ok: true, queued: false, runId: opened!.id, queuedMessageUuid: uuid };
      }
      return { ok: true, queued: true, runId: inFlight.id, queuedMessageUuid: uuid };
    },
    session_interrupt: async (args: Record<string, unknown>) => {
      interrupts.push(args);
      const { aborted } = options.host.abort();
      return { aborted, runId: null };
    },
  };

  (options.module ?? { handleVoiceRealtimeConnection }).handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    CONTINUOUS_SESSION,
    {
      createTransport: (report) =>
        createDashscopeTransport({ apiKey: '', endpoint: SCRIPTED_ENDPOINT_URL, socketFactory: upstream.socketFactory, onError: report }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
      statusRateMs: 1,
      stallMs: 0,
      segmentedRelay: false,
      omissionFillParams: options.omissionFillParams ?? null,
      hostQueueTurnBoundaryRefresh: false,
      log: (line) => logs.push(line),
      onExecStatus: (reading) => {
        latest = reading;
        readings.push(reading);
      },
      hostQueueReading: () => options.host.reading(),
      hostCommandLifecycle: () => options.host.commandLifecycle(),
      hostRunActivity: () => options.host.runActivity(),
    },
  );

  return {
    upstream,
    socket,
    host: options.host,
    delivered,
    interrupts,
    readings,
    logs,
    latest: () => latest,
    sessionStatus: async () => (await base['session_status']!({})) as Record<string, unknown>,
  };
}

/** Uploads `ms` of one amplitude in the 20 ms frames the real capture sends. */
function upload(scenario: ContinuousScenario, ms: number, amplitude: 'speech' | 'silence'): void {
  const frame = amplitude === 'speech' ? SPOKEN_FRAME : SILENCE_FRAME;
  for (let sent = 0; sent < ms; sent += FRAME_MS) {
    scenario.socket.receive({ type: 'audio', audio: frame });
  }
}

/**
 * Speaks one utterance and waits until its scripted decision has reached the executor.
 *
 * The trailing silence is longer than `silence_duration_ms`, so the close is the ENDPOINT's — this
 * helper never sends a commit, and a scenario that forced one would be measuring itself.
 */
async function speakTurn(scenario: ContinuousScenario, decisions: number, ms = 300): Promise<void> {
  upload(scenario, ms, 'speech');
  upload(scenario, 500, 'silence');
  await waitFor(() => scenario.delivered.length + scenario.interrupts.length >= decisions, 4_000);
}

/** Lets every already-scheduled macrotask run, for a decision that produces no tool call at all. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * A known-defect signature built FROM the observed failure text rather than written beside it.
 *
 * `expectKnownDefect` takes a `RegExp` and matches it against the first failure line, so the observed
 * values (the field set, the error code, the fabricated words) have to be escaped to travel through
 * one. Escaping here, once, is what lets each signature below be an ANCHORED copy of the very message
 * its leg asserts — a signature that cannot silently stop describing its own defect.
 */
const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Waits until `count` stops have reached the session.
 *
 * A stop is a correction's LAST step, not its first (G1: enqueue, then abort), so waiting on the
 * delivery alone would sample the abort before it happened — the correction is in the CLI's queue
 * while the abort is still a microtask away.
 */
const waitForInterrupts = (scenario: ContinuousScenario, count: number): Promise<void> =>
  waitFor(() => scenario.interrupts.length >= count, 4_000);

// ── the CLI host's five semantics, self-tested (AC2) ─────────────────────────────────────────────

test('cli-host: a turn boundary aggregates everything waiting into ONE request, in push order', () => {
  const host = createScriptedCliHost();
  host.accept('第一句');
  host.accept('第二句');
  host.accept('第三句');
  const turns = host.advanceTurn({ atMs: 1 });

  assert.equal(turns.length, 1, 'three waiting commands are ONE request, not three');
  assert.deepEqual(turns[0]!.uuids.length, 3);
  assert.equal(turns[0]!.message, '第一句第二句第三句', 'in the order they were pushed');
  assert.equal(host.queuedNotStarted(), 0, 'the boundary drains what it boarded');
  assert.equal(host.inFlight()?.id, turns[0]!.id, 'and the CLI is now busy with it');
});

test('cli-host: an abort never discards the queue, and the abort-closing turn still delivers it', () => {
  const host = createScriptedCliHost();
  host.accept('正在做的');
  host.advanceTurn({ atMs: 1 });
  host.accept('补充一');
  host.accept('补充二');
  assert.deepEqual(host.reading(), { items: 2, bytes: Buffer.byteLength('补充一补充二', 'utf8') });

  const stopped = host.abort({ atMs: 2 });
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.keptQueued, 2, 'both waiting commands survived the abort');
  assert.equal(host.queuedNotStarted(), 2, 'and they are still queued, not thrown away');

  const closing = host.advanceTurn({ atMs: 3 });
  assert.equal(closing.length, 1, 'the turn the abort closed still collected them');
  assert.deepEqual(closing[0]!.uuids.length, 2);
});

test('cli-host: the stale-first window is exactly 50 ms — 49 boards, 50 waits a turn', () => {
  const host = createScriptedCliHost();
  host.accept('正在做的', { atMs: 0 });
  host.advanceTurn({ atMs: 0 });
  host.abort({ atMs: 100 });

  // Δ=49 ms: still inside the window the abort-closing turn collects.
  const inTime = host.accept('赶上了', { atMs: 100 + DEFAULT_STALE_WINDOW_MS - 1 });
  // Δ=50 ms: one millisecond later, and it misses that turn entirely — E10/U2's stale-first window.
  const late = host.accept('晚了', { atMs: 100 + DEFAULT_STALE_WINDOW_MS });

  const closing = host.advanceTurn({ atMs: 200 });
  assert.equal(closing.length, 1);
  assert.deepEqual(closing[0]!.uuids, [inTime.uuid], 'only the in-window command rode the closing turn');

  // The CLI is now BUSY with that closing turn, so the late command cannot board anything until the
  // closing turn finishes — which is precisely what "a whole turn late" means: it is still waiting
  // while the sentence it should have corrected is being worked on.
  assert.equal(host.queuedNotStarted(), 1, 'the late command is still waiting while the closing turn runs');
  host.complete({ atMs: 250 });

  const after = host.advanceTurn({ atMs: 300 });
  assert.equal(after.length, 1);
  assert.deepEqual(after[0]!.uuids, [late.uuid], 'the late one landed on the turn AFTER it — a whole turn late');
});

test('cli-host: withdrawal is by uuid and reaches a command that is not the newest', () => {
  const host = createScriptedCliHost();
  const first = host.accept('甲');
  const middle = host.accept('乙');
  const last = host.accept('丙');

  assert.equal(host.withdraw(middle.uuid), true, 'a command behind the tail can be withdrawn');
  assert.equal(host.withdraw('no-such-uuid'), false, 'an unknown uuid withdraws nothing');

  const turns = host.advanceTurn({ atMs: 1 });
  assert.deepEqual(turns[0]!.uuids, [first.uuid, last.uuid], 'the withdrawn command is gone, the others are not');
  assert.deepEqual(
    host.lifecycle().filter((entry) => entry.event === 'cancelled').map((entry) => entry.uuid),
    [middle.uuid],
    'and the withdrawal is on the lifecycle log',
  );
});

test('cli-host: command_lifecycle records queued, started, completed and cancelled in one order', () => {
  const host = createScriptedCliHost();
  host.accept('做的');
  host.advanceTurn({ atMs: 1 });
  const withdrawn = host.accept('撤回的');
  host.withdraw(withdrawn.uuid);
  host.complete({ atMs: 2 });

  assert.deepEqual(
    host.lifecycle().map((entry) => entry.event),
    ['queued', 'started', 'queued', 'cancelled', 'completed'],
    'every command event lands on the one log, in the order it happened',
  );
  // The sequence counter is the ordering the criteria read: it is total and cannot tie.
  const seqs = host.lifecycle().map((entry) => entry.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('cli-host false form: without turn-boundary aggregation the same three commands become three requests', () => {
  const host = createScriptedCliHost({ aggregateAtTurnBoundary: false });
  host.accept('第一句');
  host.accept('第二句');
  host.accept('第三句');
  const turns = host.advanceTurn({ atMs: 1 });

  assert.equal(turns.length, 3, 'the false form is one request per command — this is what reddens B1');
  assert.notEqual(turns.length, 1);
});

// ── B1: 持续补充 — a supplement to a run in progress ──────────────────────────────────────────────

const B1_TEXTS = ['把 server 的日志贴出来', '还有 tail -f 那段', '从十分钟前开始'];

type B1Reading = {
  readonly delivered: string[];
  readonly depths: number[];
  readonly stopped: number;
  readonly errors: number;
  readonly queuedBeforeBoundary: number;
  readonly boarded: readonly CliTurn[];
};

/** Everything B1 reads, taken after the run's own turn boundary. */
function readB1(scenario: ContinuousScenario): B1Reading {
  const queuedBeforeBoundary = scenario.host.queuedNotStarted();
  // The run the person is supplementing finishes; the CLI's next turn boundary is what follows.
  scenario.host.complete();
  const boarded = scenario.host.advanceTurn({ atMs: 1_000 });
  return {
    delivered: [...scenario.delivered],
    depths: sentFrames(scenario).map((frame) => (typeof frame.depth === 'number' ? frame.depth : -1)),
    stopped: stoppedFrames(scenario).length,
    errors: errorsOf(scenario).length,
    queuedBeforeBoundary,
    boarded,
  };
}

function assertB1(reading: B1Reading): void {
  assert.equal(reading.errors, 0, 'B1: supplementing a run in progress is not a failure');
  assert.equal(reading.stopped, 0, 'B1: a supplement must not interrupt the run it supplements');
  assert.deepEqual(reading.delivered, B1_TEXTS, 'B1: each utterance reached the session exactly once, in order');
  assert.deepEqual(reading.depths, [0, 1, 2], 'B1: the two supplements wait behind the run, and the depth says so');
  assert.equal(reading.queuedBeforeBoundary, 2, 'B1: the supplements are queued, not started');
  assert.equal(reading.boarded.length, 1, 'B1: the turn boundary aggregates the queue into ONE request');
  assert.equal(reading.boarded[0]!.uuids.length, 2);
  assert.equal(reading.boarded[0]!.message, B1_TEXTS[1]! + B1_TEXTS[2]!, 'B1: the aggregate is in push order');
}

test('B1 持续补充: a supplement to a run in progress is queued behind it and aggregated at the boundary', async () => {
  const scenario = startContinuous({
    host: createScriptedCliHost(),
    turns: B1_TEXTS.map((text) => ({ text, policy: 'forward' })),
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    await speakTurn(scenario, 2);
    await speakTurn(scenario, 3);
    assertB1(readB1(scenario));
  } finally {
    scenario.socket.close();
  }
});

test('B1 false form: with the turn boundary NOT aggregating, B1`s own assertion reddens', async () => {
  const scenario = startContinuous({
    host: createScriptedCliHost({ aggregateAtTurnBoundary: false }),
    turns: B1_TEXTS.map((text) => ({ text, policy: 'forward' })),
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    await speakTurn(scenario, 2);
    await speakTurn(scenario, 3);
    assert.throws(
      () => assertB1(readB1(scenario)),
      /B1: the turn boundary aggregates the queue into ONE request/,
      'the aggregation is load-bearing: remove it and B1 must fail',
    );
  } finally {
    scenario.socket.close();
  }
});

// ── B2: 细化 — an added constraint, and a change of direction ────────────────────────────────────

test('B2 细化: an appending constraint queues behind the run, a change of direction aborts and corrects', async () => {
  // ── 追加: the person adds a constraint to the run in progress. The script's decision is a plain
  // forward, so the pipeline must queue it — no interruption anywhere.
  const appendHost = createScriptedCliHost();
  const append = startContinuous({
    host: appendHost,
    turns: [
      { text: '重构 parser', policy: 'forward' },
      { text: '不过要保留旧接口', policy: 'forward' },
    ],
  });
  try {
    await openSession(append);
    await speakTurn(append, 1);
    await speakTurn(append, 2);

    assert.deepEqual(append.interrupts, [], '细化 does not abort anything');
    assert.equal(stoppedFrames(append).length, 0);
    assert.deepEqual(append.delivered, ['重构 parser', '不过要保留旧接口'], 'both reached the session, in order');
    assert.equal(appendHost.queuedNotStarted(), 1, 'the constraint waits behind the run');
    appendHost.complete();
    const boarded = appendHost.advanceTurn({ atMs: 1 });
    assert.equal(boarded[0]!.message, '不过要保留旧接口', 'and rides the next turn');
  } finally {
    append.socket.close();
  }

  // ── 改方向: the same shape of utterance, but the script's decision is an interrupt carrying the
  // corrected instruction. The pipeline's outcome has to be that decision: an abort, and the
  // correction in the CLI's queue.
  const correctHost = createScriptedCliHost();
  const correct = startContinuous({
    host: correctHost,
    turns: [
      { text: '重构 parser', policy: 'forward' },
      { text: '不, 先加测试', policy: 'interrupt', intent: '用户改了方向', correction: '不, 先加测试' },
    ],
  });
  try {
    await openSession(correct);
    await speakTurn(correct, 1);
    await speakTurn(correct, 2);
    await waitForInterrupts(correct, 1);

    assert.equal(correct.interrupts.length, 1, 'the change of direction reached the session as a stop');
    assert.equal(stoppedFrames(correct).length, 1);
    assert.deepEqual(
      correct.delivered,
      ['重构 parser', withAftermathNote('不, 先加测试')],
      'the corrected words did reach the CLI — with the stop`s own aftermath note in front of them',
    );
    assert.ok(correctHost.lastAbortSeq() !== null, 'and the run was aborted');
    assert.equal(correctHost.queuedNotStarted(), 1, 'the correction is the queued command');
  } finally {
    correct.socket.close();
  }
});

// ── B3: 改方向 — the correction is queued BEFORE the abort, and does not go stale ────────────────

const B3_CORRECTION = '不对, 改成只跑失败的那个';

test('B3 改方向: the correction enters the CLI queue before the abort, and the closing turn carries it', async () => {
  const host = createScriptedCliHost();
  const scenario = startContinuous({
    host,
    turns: [
      { text: '先把回归跑一遍', policy: 'forward' },
      { text: B3_CORRECTION, policy: 'interrupt', intent: '用户改了方向', correction: B3_CORRECTION },
    ],
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    await speakTurn(scenario, 2);
    await waitForInterrupts(scenario, 1);

    // G1, read off the host's own sequence counter: the correction was ACCEPTED into the queue at a
    // sequence number strictly below the abort's. Enqueued after the abort it would land a whole
    // turn late (E10/U2) — the stale-first defect SPEC §18.4 G1 exists to remove.
    // Matched by CONTAINMENT: the correction arrives as the stop's own message, with the aftermath
    // note prefixed (see `withAftermathNote`), so the correction's own words identify the entry.
    const queued = host
      .lifecycle()
      .find((entry) => entry.event === 'queued' && entry.text.includes(B3_CORRECTION));
    const abortSeq = host.lastAbortSeq();
    assert.ok(queued !== undefined, 'the correction entered the CLI queue');
    assert.ok(abortSeq !== null, 'the run it corrects was aborted');
    assert.ok(
      queued.seq < abortSeq,
      `the correction must be IN THE QUEUE before the abort: queued@${queued.seq} vs abort@${abortSeq}`,
    );

    // The queue survived the abort, and the correction boards the FIRST boundary after it: the
    // stale-first window contributes nothing here, so `stale-first = 0`.
    assert.equal(host.queuedNotStarted(), 1, 'the correction is still waiting after the abort');
    const closing = host.advanceTurn({ atMs: 10 });
    assert.equal(closing.length, 1, 'the interrupt-closing turn collected it');
    assert.deepEqual(closing[0]!.uuids, [queued.uuid]);
    assert.equal(
      closing[0]!.message,
      withAftermathNote(B3_CORRECTION),
      'the next turn is the correction itself, not a stale restatement',
    );
  } finally {
    scenario.socket.close();
  }
});

// ── B4: 主动中断 — a bare cancel, with the queue kept and reported honestly ──────────────────────

test('B4 主动中断: a bare cancel keeps the queue, and the depth it reports is the depth that is left', async () => {
  const host = createScriptedCliHost();
  const scenario = startContinuous({
    host,
    turns: [
      { text: '甲', policy: 'forward' },
      { text: '乙', policy: 'forward' },
      { text: '丙', policy: 'forward' },
      { text: '算了', policy: 'interrupt', intent: '用户取消了' },
    ],
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    await speakTurn(scenario, 2);
    await speakTurn(scenario, 3);
    assert.equal(host.queuedNotStarted(), 2, '乙 and 丙 wait behind 甲`s run');
    await speakTurn(scenario, 4);
    await waitForInterrupts(scenario, 1);

    // No correction was carried, so nothing was enqueued for it: the abort is the whole effect.
    assert.equal(scenario.interrupts.length, 1);
    assert.equal(scenario.interrupts[0]!.message, undefined, 'a bare cancel carries no correction');
    assert.deepEqual(scenario.delivered, ['甲', '乙', '丙'], 'the cancel did not re-deliver anything');

    // WHAT THE STOP DID NOT THROW AWAY. The queue is untouched by the abort — and both readings the
    // browser gets say the same number, taken from the same post-stop host sample.
    assert.equal(host.queuedNotStarted(), 2, 'the abort discarded nothing');
    const stopped = stoppedFrames(scenario);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]!.depth, 2, 'the `stopped` frame reports what is still waiting');
    const receipt = upstreamReceipts(scenario.upstream, 'call_vad_3')[0]!;
    assert.equal(receipt.queuedStillPending, 2, 'and the model`s receipt agrees with the frame');

    // The two commands still reach the CLI, in one turn, in the order they were said.
    const closing = host.advanceTurn({ atMs: 10 });
    assert.equal(closing.length, 1, 'nothing was lost: the next boundary still collects both');
    assert.equal(closing[0]!.message, '乙丙');
  } finally {
    scenario.socket.close();
  }
});

// ── B5: 保留仍必要的 run — no interrupt, and a repeat of the same sentence is fenced ─────────────

test('B5 保留仍必要的 run: a non-conflicting supplement does not stop the run, and a repeat stop is covered', async () => {
  const host = createScriptedCliHost();
  const scenario = startContinuous({
    host,
    turns: [
      { text: '继续做那件事', policy: 'forward' },
      { text: '顺便加个注释', policy: 'forward' },
    ],
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    assert.deepEqual(host.commandLifecycle().started.length, 1, 'the CLI has dequeued the first sentence into its turn');

    // The SAME sentence is stopped for a second time. The run already carries it, so the fence must
    // answer `covered`: no second abort, no `stopped` frame.
    scenario.upstream.emit(functionCall('session_interrupt', { intent: '重复的停止' }, 'stop-repeat'));
    await waitFor(() => upstreamReceipts(scenario.upstream, 'stop-repeat').length === 1, 4_000);
    const repeat = upstreamReceipts(scenario.upstream, 'stop-repeat')[0]!;
    assert.equal(repeat.stopped, false);
    assert.equal(repeat.reason, 'covered', 'the run already covers the sentence the model stopped for');
    assert.deepEqual(scenario.interrupts, [], 'a covered stop never reaches the session');
    assert.equal(stoppedFrames(scenario).length, 0, 'and it adds no stop the page would read as one');

    // The supplement still does not stop anything…
    await speakTurn(scenario, 2);
    assert.deepEqual(scenario.interrupts, []);
    assert.equal(stoppedFrames(scenario).length, 0);

    // …and the run finishes normally, on the host`s own record.
    host.complete({ atMs: 10 });
    assert.deepEqual(
      host.lifecycle().filter((entry) => entry.event === 'cancelled'),
      [],
      'nothing was cancelled: the run was preserved',
    );
    assert.ok(
      host.lifecycle().some((entry) => entry.event === 'completed'),
      'and it completed',
    );
  } finally {
    scenario.socket.close();
  }
});

// ── B6: 不重复交付 — one sentence in two endpoint items, and a replayed call ─────────────────────

test('B6 不重复交付: every utterance reaches the session once, and a replayed call is not delivered again', async () => {
  const sentence = '打开失败的那个测试';
  const scenario = startContinuous({
    host: createScriptedCliHost(),
    turns: [
      // The endpoint chopped ONE spoken sentence into two items, as `server_vad` does on a pause.
      { text: sentence, policy: 'forward' },
      { text: sentence, policy: 'forward' },
    ],
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    // The relay of item 1 ends in a tool output that has to travel BACK up the transport, and the
    // transport only accepts it while no newer user turn has started (the endpoint ends its
    // willingness to accept an earlier call's output at the next `speech_started`). The harness
    // pumps a turn's frames synchronously, so speaking item 2 first would let `speech_started`
    // land in front of a tool output that was already on its way — a shape a real socket cannot
    // produce, because the executor's result and the inbound frame are ordered by the event loop,
    // not by the test's loop. Awaiting the first receipt restores that order.
    await waitFor(() => upstreamReceipts(scenario.upstream, 'call_vad_0').length === 1, 4_000);
    await speakTurn(scenario, 2);
    assert.deepEqual(scenario.delivered, [sentence, sentence], 'both endpoint items were relayed — nothing lost');

    // ── LAYER 1: the SAME call id. The endpoint re-delivers the first item`s opportunity and the
    // model replays its call VERBATIM. The identity the decision doc §12.6 names — `(responseId,
    // callId)` — is held by the TRANSPORT: a `function_call` whose call id it has already delivered
    // is dropped before the bridge ever sees it, so not even a receipt is produced for it. This is
    // the strongest form of "not delivered twice": the call does not exist a second time.
    const firstCallReceipts = upstreamReceipts(scenario.upstream, 'call_vad_0');
    assert.equal(firstCallReceipts.length, 1, 'the first dispatch of that call id was answered once');
    scenario.upstream.emit(functionCall('session_send', { message: sentence }, 'call_vad_0'));
    await settle();
    assert.equal(
      upstreamReceipts(scenario.upstream, 'call_vad_0').length,
      1,
      'a replayed call id never re-enters the bridge, so it produces no second receipt',
    );
    assert.equal(scenario.delivered.length, 2, 'and nothing was delivered for it');

    // ── LAYER 2: a NEW call id, the same words, and no new user audio since the last delivery. That
    // is the shape SPEC §18.4 exists for — the model re-sending ONE utterance it already sent — and
    // it is the RELAY's guard, keyed on the endpoint's item identity rather than on text alone.
    scenario.upstream.emit(functionCall('session_send', { message: sentence }, 'call_repeat'));
    await waitFor(() => upstreamReceipts(scenario.upstream, 'call_repeat').length === 1, 4_000);
    assert.equal(
      scenario.delivered.length,
      2,
      `a no-audio repeat of an already-delivered sentence must not become a second delivery: ${JSON.stringify(scenario.delivered)}`,
    );
    const repeat = upstreamReceipts(scenario.upstream, 'call_repeat')[0]!;
    assert.equal(repeat.accepted, true, 'and the model is answered as if it had landed, so it does not retry');

    // The guard is scoped to the CONTINUOUS path and to "no new audio": the person saying the same
    // sentence again after a fresh utterance is a delivery, not an echo — which is why the two
    // relaid items above were both delivered.
    assert.deepEqual(scenario.delivered, [sentence, sentence]);
  } finally {
    scenario.socket.close();
  }
});

/** Whether a `response.create` went upstream after the `function_call_output` for `callId`. */
function resumedAfterReceipt(upstream: ScriptedUpstream, callId: string): boolean {
  const at = upstream.clientFrames.findIndex((frame) => {
    const item = frame.item as Record<string, unknown> | undefined;
    return frame.type === 'conversation.item.create' && item?.type === 'function_call_output' && item.call_id === callId;
  });
  assert.ok(at !== -1, `no function_call_output for ${callId}`);
  return upstream.clientFrames.slice(at + 1).some((frame) => frame.type === 'response.create');
}

// Live test 2026-10-15 (connection 71e53da5): a second response for one utterance re-sent the sentence;
// every duplicate answer was followed by a tool-resume response.create, and the model re-called
// session_send on each one until TOOL_LOOP_GUARD stopped it at 7 calls.
test('a duplicate session_send is answered without a tool-resume, so it cannot loop', async () => {
  const sentence = '现在跑一个耗时较长的前台任务';
  const scenario = startContinuous({
    host: createScriptedCliHost(),
    turns: [{ text: sentence, policy: 'forward' }],
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    await waitFor(() => upstreamReceipts(scenario.upstream, 'call_vad_0').length === 1, 4_000);
    await settle();
    assert.ok(
      resumedAfterReceipt(scenario.upstream, 'call_vad_0'),
      'a delivered call keeps its tool-resume (the model needs that closing turn)',
    );

    scenario.upstream.emit(functionCall('session_send', { message: sentence }, 'call_repeat'));
    await waitFor(() => upstreamReceipts(scenario.upstream, 'call_repeat').length === 1, 4_000);
    await settle();
    assert.deepEqual(scenario.delivered, [sentence], 'the repeat was not delivered');
    assert.equal(
      resumedAfterReceipt(scenario.upstream, 'call_repeat'),
      false,
      'no response.create follows a duplicate\'s answer — that resume is what the model looped on',
    );
  } finally {
    scenario.socket.close();
  }
});

// =================================================================================================
// THE REWRITTEN-RESEND DEFECT — `gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard`
//
// Live 2026-10-16 01:04–01:07 (journal `cae49fed`), the sequence these two legs replay:
//
//   17:05:59.648  the endpoint transcribes A (a long question with filler words in it)
//   17:06:03.830  the endpoint transcribes B ("统计最近对于费用的优化是不是起作用了？")
//   17:06:04.080  the model calls `session_send` with B ONLY; at the time the relay's span guard
//                 prepended A verbatim, so ONE message "A B" reached the session (that guard is
//                 DELETED — 2026-10-16, see below)
//   17:06:05.083  …delivered. Then 44 s of nothing: zero `speech_started`, zero transcriptions,
//                 zero frames released by the uplink gate.
//   17:06:49.047  the browser sends its close frame.
//   17:06:49.758  the model calls `session_send` again, with A REWRITTEN — filler words dropped,
//                 punctuation added, one phrase reworded — and it was DELIVERED, because the old
//                 guard compared text literally and a rewrite is neither equal to nor contained in
//                 "A B". A second message the person never said reached the session.
//
// WHAT THE 2026-10-16 RULING CHANGES ABOUT THIS REPLAY (task
// `gap-live-voice-one-text-per-segment-prefer-response`: 每个语音片段只应有一次文本进入 CLI；优先用
// response；仅在确认一段音频没有 response 时才 fallback 到 transcript). The span guard is deleted, so
// the `17:06:04` call delivers B ALONE — segment A's transcript no longer rides segment B's response.
//
// WHAT THE 2026-10-17 SETTLE PRODUCER CHANGES AGAIN (task
// `gap-live-voice-stream-delivery-not-command`). Delivery is no longer the model's decision: a final
// transcription arms a settle window, and if no response covers the span by the deadline the
// endpoint's own words go verbatim. So in these legs, where the model says NOTHING, each heard
// utterance is delivered by its own boundary — A and B, once each, in order. A model call arriving
// after that has no new speech behind it and is refused by the WATERMARK (`speechEpoch`), which is
// the dedup rule that replaced the text comparison. The retired equality/containment false form is
// gone with the criterion it falsified: the watermark does not inspect words, so there is nothing
// for that mutation to change.
//
// The texts below are the journal's own, character for character, so a reader can align this replay
// with the live record.
// =================================================================================================

/** The long first utterance of journal `cae49fed`, verbatim — filler words included. */
const PHANTOM_A =
  '检查一下本会话到现在为止已经嗯发出的嗯采集到的语音已经发给 real time 服模型的语音的长度以及相应的费用。';
/** The short second utterance, whose relay is what carried A in front of it. */
const PHANTOM_B = '统计最近对于费用的优化是不是起作用了？';
/** The model's REWRITE of A, delivered 44 s later as a second, unasked-for message. */
const PHANTOM_A_REWRITTEN =
  '检查本会话现在为止，已经采集的语音、已经发给 realtime 模型的语音长度以及相应的费用。';
/**
 * The same rewrite with ONE interior character elided (`相应的费用` → `相应费用`) — the shape a model
 * RETYPING a sentence it read produces. Kept as the journal's text; under the settle producer it is
 * refused by the watermark (no new speech), so the elision no longer has to be judged at all.
 */
const PHANTOM_A_REWRITTEN_ELIDED =
  '检查本会话现在为止，已经采集的语音、已经发给 realtime 模型的语音长度以及相应费用。';

/**
 * Speaks one utterance and waits for the endpoint to have TRANSCRIBED it — the reading a leg needs
 * when the model does not forward at that opportunity (`policy: 'silent'` / `'text'`), so
 * `speakTurn`'s wait on a delivery would never come true.
 */
async function speakHeardTurn(scenario: ContinuousScenario, utterance: number, ms = 300): Promise<void> {
  const finalsBefore = finalsOf(scenario).length;
  upload(scenario, ms, 'speech');
  upload(scenario, 500, 'silence');
  await waitFor(() => finalsOf(scenario).length > finalsBefore, 4_000);
  assert.equal(finalsOf(scenario).length, utterance, 'each spoken turn is one transcribed item');
}

/**
 * THE LEG'S OWN CHECK, named so every case that reuses it runs the SAME one: an ECHO — a call with
 * nothing new heard since the last settled delivery — must not become a second delivery. The
 * criterion is the watermark's, not a comparison's: whether the call restates the last delivery's
 * words is not asked.
 *
 * TAKES THE COUNT TO READ AGAINST, because the leg above pins TWO deliveries after the ruling of
 * 2026-10-16 (segment B's call, then segment A's late response). A single hard-coded `1` would have to
 * be edited by every case that reuses this check, which is how a check stops being the same check.
 */
function assertEchoNotDelivered(scenario: ContinuousScenario, deliveredSoFar: number): void {
  assert.equal(
    scenario.delivered.length,
    deliveredSoFar,
    `a call with nothing new heard that restates what the session has must not become a second delivery: ${JSON.stringify(scenario.delivered)}`,
  );
}

/** Answers one model `session_send` upstream and waits for its receipt, as the model's own turn would. */
async function emitSessionSend(scenario: ContinuousScenario, message: string, callId: string): Promise<void> {
  scenario.upstream.emit(functionCall('session_send', { message }, callId));
  await waitFor(() => upstreamReceipts(scenario.upstream, callId).length === 1, 4_000);
  await settle();
}

test('leg B: the omission-fill rule delivers each unanswered utterance once and refuses a late restatement', async () => {
  const scenario = startContinuous({
    host: createScriptedCliHost(),
    // Millisecond-scale windows: the arm this leg is about is the model saying NOTHING for a heard
    // utterance (journal `764f0c7a`), which rule v2 delivers at its own decision time.
    omissionFillParams: { hMs: 300, gMs: 60, silenceMs: 80 },
    turns: [
      { text: PHANTOM_A, policy: 'silent' },
      { text: PHANTOM_B, policy: 'silent' },
    ],
  });
  try {
    await openSession(scenario);

    // (1) A is heard and the model relays nothing. Its decision time arrives and the endpoint's
    // own words go — the input the old producer lost.
    await speakHeardTurn(scenario, 1);
    await waitFor(() => scenario.delivered.length === 1, 4_000);
    assert.deepEqual(
      scenario.delivered,
      [PHANTOM_A],
      `an unanswered utterance is delivered verbatim at its decision time: ${JSON.stringify(scenario.delivered)}`,
    );

    // (2) B likewise: each span is its own delivery, in spoken order.
    await speakHeardTurn(scenario, 2);
    await waitFor(() => scenario.delivered.length === 2, 4_000);
    assert.deepEqual(
      scenario.delivered,
      [PHANTOM_A, PHANTOM_B],
      `every heard span is delivered once, in order: ${JSON.stringify(scenario.delivered)}`,
    );

    // (3) A model response arriving after both spans are settled has NO new speech behind it. It is
    // a restatement of what the session already holds, refused on the WATERMARK — not by comparing
    // its words. The span the old guard compared against no longer exists, which is the whole
    // simplification this task makes.
    await emitSessionSend(scenario, PHANTOM_B, 'call_span');
    assertEchoNotDelivered(scenario, 2);
    assert.ok(
      scenario.logs.some((line) => line.includes('session_send not-delivered (duplicate: no new speech since the last settled delivery')),
      `the non-delivery must be recorded where the operator reads it: ${scenario.logs.filter((l) => l.includes('not-delivered')).join(' | ')}`,
    );
    const receipt = upstreamReceipts(scenario.upstream, 'call_span')[0]!;
    assert.equal(receipt.accepted, true, 'the model is answered as if it had landed, so it does not retry');
    assert.equal(
      resumedAfterReceipt(scenario.upstream, 'call_span'),
      false,
      'and no tool-resume follows: that resume is what the model re-called the tool on',
    );

    // (4) The elided rewrite is refused for the SAME reason. A text-side criterion would have to
    // decide whether this is a restatement; the watermark does not ask.
    await emitSessionSend(scenario, PHANTOM_A_REWRITTEN_ELIDED, 'call_echo');
    assertEchoNotDelivered(scenario, 2);
  } finally {
    scenario.socket.close();
  }
});

test('leg B shape preserved: a model response that covers the utterance is its one delivery', async () => {
  // (a) The model answers a fresh span. Rule v2 compares GRAMS: the rewrite covers the utterance,
  // so no verbatim copy follows it. The long window keeps the decision time out of this arm, which
  // is about the model's response being the delivery.
  const fresh = startContinuous({
    host: createScriptedCliHost(),
    omissionFillParams: { hMs: 60_000, gMs: 1_000, silenceMs: 60_000 },
    turns: [
      { text: PHANTOM_A, policy: 'silent' },
      { text: PHANTOM_B, policy: 'silent' },
    ],
  });
  try {
    await openSession(fresh);
    await speakHeardTurn(fresh, 1);
    await speakHeardTurn(fresh, 2);
    assert.deepEqual(fresh.delivered, [], 'nothing settles while the window is open and the model is silent');

    await emitSessionSend(fresh, PHANTOM_A_REWRITTEN, 'call_late');
    assert.deepEqual(
      fresh.delivered,
      [PHANTOM_A_REWRITTEN],
      `the model's response is the span's one delivery: ${JSON.stringify(fresh.delivered)}`,
    );
    assert.equal(
      fresh.logs.some((line) => line.includes('session_send not-delivered (duplicate')),
      false,
      `nothing here is an echo: ${fresh.logs.filter((l) => l.includes('not-delivered')).join(' | ')}`,
    );
  } finally {
    fresh.socket.close();
  }

  // (b) The live late-forward shape (2026-10-15 01:13, journal `b33412ea`): the model answers in TEXT
  // instead of relaying. The relay's text-reply net delivers the sentence and closes the planner's
  // candidate, so the rule does not deliver it a second time; the model's later restatement has no
  // new speech behind it and is refused.
  const late = startContinuous({
    host: createScriptedCliHost(),
    omissionFillParams: { hMs: 300, gMs: 60, silenceMs: 80 },
    turns: [
      { text: PHANTOM_A, policy: 'silent' },
      { text: PHANTOM_B, policy: 'text' },
    ],
  });
  try {
    await openSession(late);
    await speakHeardTurn(late, 1);
    await waitFor(() => late.delivered.length === 1, 4_000);
    assert.equal(late.delivered[0], PHANTOM_A, 'the first silent utterance is its own delivery');

    await speakHeardTurn(late, 2);
    await waitFor(() => late.delivered.length === 2, 4_000);
    assert.ok(
      late.delivered[1]!.includes(PHANTOM_B),
      `the second sentence is delivered exactly once: ${JSON.stringify(late.delivered)}`,
    );

    await emitSessionSend(late, PHANTOM_A_REWRITTEN, 'call_late');
    assert.equal(
      late.delivered.length,
      2,
      `a late restatement with no new speech must not become a third delivery: ${JSON.stringify(late.delivered)}`,
    );
  } finally {
    late.socket.close();
  }
});

// =================================================================================================
// THE RETIRED KNOWN-DEFECT LEGS (AC3). B7's RunDigest and both of B8's dispositions shipped as
// known defects; `gap-live-voice-run-digest-evaluation-signal` fixed them, so each leg now asserts
// its contract DIRECTLY through a named assertion function. Each leg's false form runs the SAME
// function against a fixture broken on purpose, and requires it to redden on the assertion's own
// message: a check with no false form could pass while matching nothing, and one that matched
// everything could pass while the pipeline broke in a way nobody recorded. The field set below was
// measured off this file's own B7 run, not guessed.
// =================================================================================================

/** Everything the retained `session_status` route answers with today (measured on this file's B7). */
const B7_STATUS_FIELDS = [
  'at',
  'elapsedMs',
  'lastDelivery',
  'maxBytes',
  'pendingInteraction',
  'phase',
  'queuedBytes',
  'queuedItems',
  'runId',
  'sessionId',
  'startedAt',
  'statusSeq',
] as const;

/** What a reading that could support "continue / modify / cancel / nothing to do" has to carry. */
const B7_DIGEST_FIELDS = ['covers', 'queuedNotStarted', 'lastCliActivity', 'freshness'] as const;

/** B7`s failure line, as a function of what was read — the assertion`s own message. */
const b7Message = (fields: readonly string[], missing: readonly string[]): string =>
  `B7: the model-visible reading has no RunDigest field: field set = ${JSON.stringify(fields)}, missing ${missing.join('+')}`;

/** B8/A`s failure line: the page was told the model answered rather than calling the tool. */
const b8TextMessage = (codes: readonly string[]): string =>
  `B8: a model reply in place of a tool call is reported to the browser as an error: ${JSON.stringify(codes)}`;

/** B8/B`s failure line: words nobody said reached the CLI. */
const b8FabricatedMessage = (delivered: readonly string[]): string =>
  `B8: a session_send fabricated on an item the endpoint transcribed as empty reached the CLI: ${JSON.stringify(delivered)}`;

// The three legs' assertions, named so each leg and its false form run the SAME function: a false
// form reddens ON THIS MESSAGE, which is what makes "it passed" mean "the contract holds" rather
// than "something threw".
function assertRunDigestPresent(status: Record<string, unknown>): void {
  const keys = Object.keys(status).sort();
  const missing = B7_DIGEST_FIELDS.filter((field) => !(field in status));
  assert.deepEqual(missing, [], b7Message(keys, missing));
}

function assertNoModelTextErrorFrame(codes: readonly string[]): void {
  assert.deepEqual(codes, [], b8TextMessage(codes));
}

function assertFabricatedNotDelivered(delivered: readonly string[]): void {
  assert.deepEqual(delivered, [], b8FabricatedMessage(delivered));
}

// The wrapper-refusal test below still exercises `expectKnownDefect` itself, so this signature stays
// as its fixture.
const B8_TEXT_SIGNATURE = new RegExp(`^${escapeForRegExp(b8TextMessage(['MODEL_TEXT_REPLY']))}$`);

// ── B7: 真实进度 — the browser reading and the model reading, and the digest they must carry ─────

test('B7 真实进度: the browser`s reading and the model`s reading are one source, and carry the digest', async () => {
  const host = createScriptedCliHost();
  const scenario = startContinuous({
    host,
    turns: [
      { text: '把日志贴出来', policy: 'forward' },
      { text: '只要最后二十行', policy: 'forward' },
    ],
  });
  try {
    await openSession(scenario);
    await speakTurn(scenario, 1);
    await speakTurn(scenario, 2);
    await waitFor(() => scenario.latest() !== null, 4_000);

    // The reading the model USED TO ask for over the wire. `session_status` is no longer advertised
    // to the model (2026-10-14 ruling — the model is a pen, not an agent), so a wire call would be
    // withheld by the transport as UNDECLARED_TOOL; the route is RETAINED, and this reads exactly
    // what it answers from the connection's own cell.
    const status = await scenario.sessionStatus();
    const latest = scenario.latest()!;
    const sent = sentFrames(scenario).at(-1)!;
    const real = host.reading();

    // ONE SOURCE. The line that went into the session and the answer the retained route reads back
    // are the same aggregator read twice, so they cannot disagree (SPEC §8.3 / AC6).
    assert.equal(status.phase, latest.phase, 'the model`s phase is the one that was injected');
    assert.equal(status.queuedItems, latest.queuedItems, 'the model`s depth is the injected depth');
    assert.equal(status.queuedBytes, latest.queuedBytes);
    assert.equal(status.statusSeq, latest.statusSeq, 'and it is the same reading, not a later one');

    // TRUE TO THE CLI. The frame the browser is given carries the CLI`s own waiting count.
    assert.equal(sent.depth, real.items, 'the browser frame reports the CLI`s real waiting count');
    assert.equal(sent.bytes, real.bytes, 'and its real byte count');
    assert.equal(status.queuedItems, real.items, 'and so does the reading the model sees');

    // ── THE DIGEST IS PRESENT (SPEC §12.5, decision doc §12.5; the known defect retired by
    // gap-live-voice-run-digest-evaluation-signal). The reading now says which deliveries the
    // current run COVERS, which commands are queued and NOT started, what the CLI last did, and how
    // fresh the sample is — so "continue", "modify", "cancel" and "nothing to do" are representable
    // rather than guessed off a count.
    assertRunDigestPresent(status);
  } finally {
    scenario.socket.close();
  }
});

// ── B8: 无需动作 — the model answers, or fabricates a delivery on an empty item ──────────────────

test('B8 无需动作: a model reply, and a delivery fabricated on an item the endpoint heard nothing in', async () => {
  // ── A: the model answers the person in text instead of calling the tool. It must NOT reach the
  // page as a failure, and the person's words still reach the session.
  const noop = startContinuous({ host: createScriptedCliHost(), turns: [{ text: '在吗', policy: 'text' }] });
  try {
    await openSession(noop);
    // No tool call is scripted, so there is nothing to wait for: give the frame path its turn.
    upload(noop, 300, 'speech');
    upload(noop, 500, 'silence');
    await settle();

    // Every finished sentence reaches the session (ruling 2026-10-14, "a pen, not an agent"; live
    // 2026-10-15): the model answering in text no longer sets the words aside — the relay delivers them.
    assert.deepEqual(noop.delivered, ['在吗'], 'a text answer still delivers the person`s words verbatim');
    assert.deepEqual(finalsOf(noop), ['在吗'], 'the person is still shown as heard');
    // A model reply in text is "no action needed", not a failure: the MODEL_TEXT_REPLY error frame
    // the retired defect sent to the page never leaves the proxy on the continuous relay.
    assertNoModelTextErrorFrame(errorsOf(noop).map((frame) => frame.code));
  } finally {
    noop.socket.close();
  }

  // ── B: the endpoint transcribed an item as NOTHING, and the model invents a delivery for words
  // nobody said. The continuous wire carries no segment, so there is no transcript to refuse it
  // against by sequence — the guard keys on the item's OWN transcript reading instead, and refuses.
  const fabricated = startContinuous({ host: createScriptedCliHost(), turns: [] });
  try {
    await openSession(fabricated);
    fabricated.upstream.emit(captionCompleted('item_empty', ''));
    fabricated.upstream.emit(functionCall('session_send', { message: '（无语音内容）' }, 'call_fab'));
    await settle();

    assertFabricatedNotDelivered(fabricated.delivered);
  } finally {
    fabricated.socket.close();
  }
});

// ── B9: 长句 — 45 s of continuous speech, with the person`s own 1–3 s pauses ────────────────────

test('B9 长句: 45 s of speech with 1-3 s pauses is never force-cut and never one oversized append', async () => {
  const scenario = startContinuous({
    host: createScriptedCliHost(),
    // Four stretches of speech, so four utterances: the person`s own pauses are the only boundaries.
    turns: [0, 1, 2, 3].map(() => ({ policy: 'forward' as const })),
    mode: 'drain',
  });
  try {
    await openSession(scenario);

    // The person`s own timeline: 45 s of words in four stretches, separated by the pauses they took,
    // and one last breath so the final stretch closes. Every millisecond of it goes up the wire —
    // including the pauses, which the retired silence gate would have dropped.
    //
    // ONE STRETCH AT A TIME, each waited out before the next. The wire carries 20 ms of audio per
    // frame spread over 45 real seconds; uploading the whole timeline in one synchronous burst would
    // put four deliveries in flight at once, which the relay`s single-flight guard refuses outright
    // ("A previous voice instruction is still being sent") — a fact about this harness`s clock, not
    // about the behaviour under test. The barrier is the delivery`s own `sent` frame plus one
    // macrotask, after which nothing of that delivery is still held.
    const stretches = [14_000, 14_000, 14_000, 3_000];
    const pauses = [1_000, 2_000, 3_000, 500];
    for (let index = 0; index < stretches.length; index += 1) {
      upload(scenario, stretches[index]!, 'speech');
      upload(scenario, pauses[index]!, 'silence');
      const delivered = index + 1;
      await waitFor(() => sentFrames(scenario).length >= delivered, 4_000);
      await settle();
    }

    const detector = scenario.upstream.vad;
    assert.ok(detector !== null, 'the endpoint`s own detector was armed');

    // NO FORCED CUT: the person made four utterances, and it is the person`s pauses that ended them.
    assert.equal(detector.speechStopped, 4, 'the four stretches the person spoke are the four the endpoint closed');
    assert.deepEqual(
      scenario.upstream.clientFrames.filter((frame) => frame.type === 'input_audio_buffer.commit'),
      [],
      'the relay must never commit for the person: that is the forced cut the continuous wire removes',
    );
    assert.deepEqual(errorsOf(scenario), []);
    assert.deepEqual(stoppedFrames(scenario), []);

    // NO SINGLE OVERSIZED APPEND: every frame the relay put on the wire carries at most 100 ms of
    // PCM16, so the endpoint keeps hearing at the granularity the capture produced.
    const appends = scenario.upstream.clientFrames.filter((frame) => frame.type === 'input_audio_buffer.append');
    assert.ok(appends.length > 2_000, `45 s at 20 ms is thousands of appends, got ${appends.length}`);
    const oversized = appends.filter(
      (frame) => Buffer.from(String(frame.audio), 'base64').length > 100 * 2 * 16,
    );
    assert.deepEqual(oversized, [], 'no single append may carry more than 100 ms of audio');

    // EVERY ENDPOINT ITEM IS ACCOUNTED FOR: each one was either delivered to the CLI or left unforwarded
    // — never silently dropped between the two.
    assert.equal(detector.records.length, 4);
    for (const record of detector.records) {
      assert.ok(
        record.disposition === 'forwarded' || record.disposition === 'unforwarded',
        `item ${record.itemId} was disposed ${record.disposition}, which is neither delivered nor heard-but-not-forwarded`,
      );
    }
    assert.equal(
      detector.records.filter((record) => record.disposition === 'forwarded').length,
      scenario.delivered.length,
      'every item the model forwarded is an item the CLI received',
    );
  } finally {
    scenario.socket.close();
  }
});

// ── each retired leg`s own false form (AC3) ──────────────────────────────────────────────────────

const FIX_TASK = 'gap-live-voice-run-digest-evaluation-signal';

/**
 * Each false form runs the leg's OWN named assertion against a reading shaped like the retired
 * defect, and requires it to redden on that assertion's message. The reading genuinely differs from
 * the leg's own: the defect's shape, not a relabelled copy of the healthy one. That is what makes a
 * green leg mean "the contract holds" rather than "the assertion happened to throw".
 */

test('known-defect false form B7 (RunDigest present): the assertion reddens on its own message', () => {
  // A reading with every field the pre-fix answer carried and none of the digest.
  const withoutDigest: Record<string, string> = {};
  for (const field of B7_STATUS_FIELDS) withoutDigest[field] = 'x';
  assert.throws(
    () => assertRunDigestPresent(withoutDigest),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.split('\n')[0] === b7Message(B7_STATUS_FIELDS, B7_DIGEST_FIELDS),
  );
});

test('known-defect false form B8 (model text reply): the assertion reddens on its own message', () => {
  // The code the retired defect left on the wire: the page was told the model`s text reply was an
  // error.
  assert.throws(
    () => assertNoModelTextErrorFrame(['MODEL_TEXT_REPLY']),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.split('\n')[0] === b8TextMessage(['MODEL_TEXT_REPLY']),
  );
});

test('known-defect false form B8 (fabricated delivery): the assertion reddens on its own message', () => {
  // The words nobody said, delivered by the retired defect.
  assert.throws(
    () => assertFabricatedNotDelivered(['（无语音内容）']),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.split('\n')[0] === b8FabricatedMessage(['（无语音内容）']),
  );
});

test('known-defect wrappers: an outlived defect and a wildcard signature are both refused', async () => {
  // A scenario that stops failing: the wrapper must FAIL, telling its reader to retire it rather
  // than leaving a wrapper nobody will notice has become vacuous.
  await assert.rejects(
    () => expectKnownDefect(() => undefined, { fixTask: FIX_TASK, signature: B8_TEXT_SIGNATURE }),
    /defect no longer reproduces/,
    'a known-defect wrapper that its defect has outlived is a liability, not a pass',
  );

  // A wildcard signature is refused outright, so a wrapper cannot be made to look load-bearing.
  await assert.rejects(
    () => expectKnownDefect(() => undefined, { fixTask: FIX_TASK, signature: /^.*$/ }),
    /cannot tell this defect apart from a broken test/,
  );
});
