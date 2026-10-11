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

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeOutboundFrame,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
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
} from './voice-realtime-scripted-upstream.js';

/** The browser end of the socket, driven directly — the same stand-in the replay criterion uses. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
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
    },
  );
  return { upstream, socket, delivered, calls: () => calls };
}

/** Resolves once the proxy has reported the upstream session open to the browser. */
const openSession = (scenario: Scenario): Promise<void> =>
  waitFor(() => scenario.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

/** The failure frame, narrowed — the codes the assertions below read live only on this member. */
type ErrorFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'error' }>;

const errorsOf = (scenario: Scenario): ErrorFrame[] =>
  scenario.socket.outbound.filter((frame): frame is ErrorFrame => frame.type === 'error');

const finalsOf = (scenario: Scenario): string[] =>
  scenario.socket.outbound
    .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption' && frame.final)
    .map((frame) => frame.text);

const interimsOf = (scenario: Scenario): string[] =>
  scenario.socket.outbound
    .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption' && !frame.final)
    .map((frame) => frame.text);

/** The waiting depth the proxy reported on each delivery, in order. */
const sentDepths = (scenario: Scenario): number[] =>
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
  const scenario = startScenario({ queuedForFirst: 2 });
  await openSession(scenario);

  await scenario.upstream.runScript([
    { wire: functionCall('session_send', { message: '第一句' }, 'call_1') },
    { wire: functionCall('session_send', { message: '第二句' }, 'call_2') },
    { wire: functionCall('session_send', { message: '第三句' }, 'call_3') },
  ]);
  await waitFor(() => scenario.delivered.length === 3, 4_000);

  assert.deepEqual(errorsOf(scenario), [], 'talking into a working session is not an error');
  assert.deepEqual(scenario.delivered, ['第一句', '第二句', '第三句'], 'every utterance was admitted, in order');

  // The depth is a READING, and this asserts only that it was reported as holding work — the
  // axis the bound is measured on (count vs bytes) is being changed by another task, and a
  // scenario must not pin that decision.
  const depths = sentDepths(scenario);
  assert.equal(depths.length, 3, 'each delivery reported a depth');
  assert.ok(
    depths.filter((depth) => depth > 0).length >= 2,
    `a session whose queue accepted two calls must say so: ${JSON.stringify(depths)}`,
  );
  scenario.socket.close();
});

test('the stand-in is the only endpoint a scenario can reach', async () => {
  const scenario = startScenario();
  await openSession(scenario);

  // The address the transport dialled is the stand-in's own — so the frames asserted above
  // came from the script and not from anything on the network.
  assert.ok(
    scenario.upstream.dialedUrl?.startsWith(SCRIPTED_ENDPOINT_URL),
    `the transport must dial the stand-in: ${String(scenario.upstream.dialedUrl)}`,
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
