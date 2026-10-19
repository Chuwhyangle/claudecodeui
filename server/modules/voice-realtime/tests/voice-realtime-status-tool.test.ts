/**
 * S-B: the `session_status` tool — the FULL-status side of the human ruling D-1
 * (`docs/proposals/voice-realtime-persistent-control-SPEC.md` §6.3), and the ONE reading it must
 * answer from.
 *
 * WHY THIS FILE EXISTS. S-A injects a COMPACT status line into every response's instructions (§8.4):
 * it is paid for on every response, so it carries the gist, not the detail. When the human asks "what
 * is it actually doing?", the model needs the whole state (§6.3's shape) without re-deriving it. This
 * file is the criterion that the tool exists and — the load-bearing part — answers from the SAME L3
 * aggregator reading the injected line came from, so the two can never disagree (§6.3's first bullet,
 * §8.2's single-source rule).
 *
 * WITHDRAWN FROM THE ADVERTISEMENT (2026-10-14 ruling, journal `e650117b`; replay in
 * `experiments/voice-realtime-relay-mode-replay/`). The model was re-scoped to a pen — it tidies the
 * person's words and passes them on — so choosing when to ask for a fresh reading is no longer its
 * job and `session_status` is no longer advertised. The route is NOT deleted: the descriptor, the
 * whitelist, the executor's `session_status` implementation and the proxy's reading all stay, and
 * AC2/AC3/AC4/AC7 below still drive that retained route. AC1 now asserts the advertisement it is
 * absent from, which is the fact the ruling changed.
 *
 * HOW IT RUNS. Three layers, each the narrowest that can prove its point:
 *
 *  - AC1, AC6 are pure reads of the advertised tool list (the set and the §6.3 tool budget).
 *  - AC2, AC4 drive the REAL `createVoiceRealtimeLiveExecutor` over stand-in gateway bags — the
 *    whitelist and the field mapping are the executor's own code, not a re-implementation here.
 *  - AC3, AC7 and the DoD boot the REAL transport and the REAL proxy — `createDashscopeTransport`
 *    and `handleVoiceRealtimeConnection`, the same two functions `server/index.ts` wires — over
 *    `createScriptedUpstream`, with `apiKey: ''`, replicating `server/index.ts`'s `onExecStatus` →
 *    `sessionStatus` wiring EXACTLY, so the single-source reading is the production wiring and not a
 *    hand-rolled shortcut.
 *
 * Consumers: the quay worker's AC state for `gap-live-voice-status-tool`; the mirror invariant beside
 * it in `voice-realtime-bridge.test.ts` keeps the widened voice tool list from disturbing AC-2.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  VOICE_REALTIME_TOOLS,
  VoiceRealtimeSessionRefusalError,
  createDashscopeTransport,
  createVoiceRealtimeLiveExecutor,
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  type RealtimeToolExecutor,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeSessionRefusal,
} from '../index.js';
import {
  VOICE_QUEUE_MAX_BYTES,
  type VoiceRealtimeExecStatusReading,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import {
  captionCompleted,
  createScriptedUpstream,
  functionCall,
  SCRIPTED_ENDPOINT_URL,
  type ScriptedUpstream,
} from './voice-realtime-scripted-upstream.js';

/** The exact §6.3 output field set, in the order §6.3 declares them, plus §12.5's RunDigest fields. */
const SPEC_63_FIELDS = [
  'sessionId',
  'phase',
  'runId',
  'elapsedMs',
  'startedAt',
  'queuedItems',
  'queuedBytes',
  'maxBytes',
  'lastDelivery',
  'pendingInteraction',
  'statusSeq',
  'at',
  // SPEC §12.5's RunDigest, appended after §6.3's set: the content-level reading the model evaluates
  // the run on. `gap-live-voice-run-digest-evaluation-signal` adds them; they are part of the answer.
  'covers',
  'queuedNotStarted',
  'lastCliActivity',
  'freshness',
] as const;

/** A `{}` cast to a deps type the criterion never reaches — the executor's other seams stay inert. */
const never = <T>(): T => ({}) as unknown as T;

const BOUND_SESSION = 'sess-bound';

/**
 * Builds a REAL live executor whose `session_status` reads the cell the passed getter names, and
 * whose `session_send` is a stub so a scenario controls the run/queue state the proxy observes.
 *
 * The gateway bags other than `sessionStatus` are `{}` casts: `session_status` never touches them
 * (it reads the aggregator reading and nothing else), so reaching one would be a bug this file wants
 * to surface as a `TypeError`, not paper over with a fake.
 */
function buildStatusExecutor(
  reading: () => VoiceRealtimeExecStatusReading | null,
  refusals: VoiceRealtimeSessionRefusal[],
  send: () => Record<string, unknown>,
): RealtimeToolExecutor {
  const base = createVoiceRealtimeLiveExecutor({
    boundSessionId: BOUND_SESSION,
    caller: { userId: 7, scopes: ['cloudcli:read'] },
    visibleContext: never(),
    readTools: never(),
    runGet: never(),
    approvals: never(),
    sessionBackground: never(),
    sessionSend: never(),
    sessionInterrupt: never(),
    onSessionRefusal: (refusal) => refusals.push(refusal),
    sessionStatus: { reading },
  });
  return { ...base, session_send: async () => send() };
}

// ---------------------------------------------------------------------------------------------
// AC1. The advertised set — THE FIRST ASSERTION OF THIS FILE, because it is the fact the 2026-10-14
// ruling changed: `session_status` used to be advertised beside the send and the interrupt, and is
// now withdrawn (the model is a pen, not an agent — see `VOICE_REALTIME_TOOLS`).
// ---------------------------------------------------------------------------------------------

test('AC1: the voice plane advertises exactly session_send and session_interrupt, not session_status', () => {
  // THE FIRST ASSERTION OF THIS FILE: the exact advertised name set (the two tools the pen needs).
  assert.deepEqual([...VOICE_REALTIME_TOOLS.map((tool) => tool.name)].sort(), [
    'session_interrupt',
    'session_send',
  ]);

  // The declaration order is the same two, so a reader comparing this to the source sees the list.
  assert.deepEqual(
    VOICE_REALTIME_TOOLS.map((tool) => tool.name),
    ['session_send', 'session_interrupt'],
  );
  assert.equal(VOICE_REALTIME_TOOLS.length, 2, 'exactly two tools, not three');

  // The withdrawn tool is NOT among them — the ruling's whole point, and the assertion that reds if
  // a future edit re-advertises it.
  assert.equal(
    VOICE_REALTIME_TOOLS.some((tool) => tool.name === 'session_status'),
    false,
    'session_status is withdrawn from the advertisement',
  );

  // The SIX-tool mirror list is untouched: widening the VOICE plane must not move the AC-2 mirror.
  assert.deepEqual([...REALTIME_TOOLS.map((tool) => tool.name)].sort(), [
    'approvals_list',
    'run_get',
    'session_background',
    'session_get',
    'session_send',
    'ui_visible_context',
  ]);
  assert.equal(REALTIME_TOOLS.length, 6, 'the mirror list is still six descriptors');
  assert.ok(
    REALTIME_TOOLS_BY_NAME['session_status'].description.includes('status'),
    'the descriptor is registered by name in the routing table',
  );
});

// ---------------------------------------------------------------------------------------------
// AC2. The §6.3 field set, and the idle reading: no run means runId/elapsedMs null, queue zero.
// ---------------------------------------------------------------------------------------------

test('AC2: session_status returns every §6.3 field, and an idle plane reads runId=null, elapsedMs=null, queuedItems=0', async () => {
  // No reading published yet — the tool must report the idle plane honestly, not invent one.
  const executor = buildStatusExecutor(
    () => null,
    [],
    () => ({ runId: 'unused', queued: false }),
  );

  const reading = (await executor['session_status']!({})) as Record<string, unknown>;
  assert.deepEqual(Object.keys(reading).sort(), [...SPEC_63_FIELDS].sort(), 'the output carries exactly §6.3’s fields');
  for (const field of SPEC_63_FIELDS) {
    assert.ok(field in reading, `${field} must be present`);
  }

  assert.equal(reading['sessionId'], BOUND_SESSION, 'the tool names the bound session');
  assert.equal(reading['phase'], 'idle');
  assert.equal(reading['runId'], null, 'no run ⇒ runId null');
  assert.equal(reading['elapsedMs'], null, 'no run ⇒ elapsedMs null');
  assert.equal(reading['startedAt'], null, 'the aggregator carries no start stamp, so none is invented');
  assert.equal(reading['queuedItems'], 0);
  assert.equal(reading['queuedBytes'], 0);
  assert.equal(reading['maxBytes'], VOICE_QUEUE_MAX_BYTES, 'the queue budget defaults to VOICE_QUEUE_MAX_BYTES');
  assert.equal(reading['lastDelivery'], null);
  assert.equal(reading['pendingInteraction'], null);
  assert.equal(reading['statusSeq'], 0);
  assert.equal(reading['at'], 0);
  // No digest sampled yet: the four §12.5 fields answer `null`, never a fabricated "0 covered / 0 waiting".
  assert.equal(reading['covers'], null);
  assert.equal(reading['queuedNotStarted'], null);
  assert.equal(reading['lastCliActivity'], null);
  assert.equal(reading['freshness'], null);

  // A RUNNING reading: the fields the aggregator DOES carry come through verbatim, and the three it
  // cannot are null/'' rather than a second computation (SPEC §6.3's first bullet).
  const live: VoiceRealtimeExecStatusReading = {
    phase: 'queued',
    runId: 'r-1',
    elapsedMs: 2500,
    queuedItems: 2,
    queuedBytes: 42,
    pendingInteraction: { requestId: 'req-1', toolName: 'AskUserQuestion' },
    // A populated RunDigest (§12.5), so the tool's pass-through of it is read, not assumed.
    digest: {
      covers: { count: 2, last: 'deploy the change' },
      queuedNotStarted: { count: 1, last: 'and then run the tests' },
      lastCliActivity: { tool: 'Bash' },
      freshness: 120,
    },
    statusSeq: 9,
    at: 1_700_000_000_000,
  };
  const busy = (await buildStatusExecutor(
    () => live,
    [],
    () => ({ runId: 'unused', queued: false }),
  )['session_status']!({})) as Record<string, unknown>;

  assert.equal(busy['phase'], 'queued');
  assert.equal(busy['runId'], 'r-1');
  assert.equal(busy['elapsedMs'], 2500, 'a run makes elapsedMs the aggregator’s own reading');
  assert.equal(busy['startedAt'], null);
  assert.equal(busy['queuedItems'], 2);
  assert.equal(busy['queuedBytes'], 42);
  assert.equal(busy['statusSeq'], 9);
  assert.equal(busy['at'], 1_700_000_000_000);
  assert.deepEqual(busy['pendingInteraction'], { requestId: 'req-1', toolName: 'AskUserQuestion', inputSummary: '' });
  // The RunDigest comes through WHOLE from the same reading (SPEC §12.5): the line carries only a
  // truncated, sanitized tail of it, so this is where the model reads the full summaries.
  assert.deepEqual(busy['covers'], { count: 2, last: 'deploy the change' });
  assert.deepEqual(busy['queuedNotStarted'], { count: 1, last: 'and then run the tests' });
  assert.deepEqual(busy['lastCliActivity'], { tool: 'Bash' });
  assert.equal(busy['freshness'], 120);

  // A queued-ONLY plane (no run in flight): runId null ⇒ elapsedMs null even though the aggregator’s
  // elapsedMs field is a non-null number.
  const queuedOnly = (await buildStatusExecutor(
    () => ({ ...live, phase: 'queued', runId: null, elapsedMs: 0 }),
    [],
    () => ({ runId: 'unused', queued: false }),
  )['session_status']!({})) as Record<string, unknown>;
  assert.equal(queuedOnly['runId'], null);
  assert.equal(queuedOnly['elapsedMs'], null, 'no run ⇒ elapsedMs null even if the reading carries a number');
});

// ---------------------------------------------------------------------------------------------
// AC4. The whitelist: a foreign session is refused and recorded; an omitted session answers the bound
// one. `session_status` is bounded to the connection's own session like the other two tools.
// ---------------------------------------------------------------------------------------------

test('AC4: a foreign session is refused and recorded; an omitted session answers the bound one', async () => {
  const refusals: VoiceRealtimeSessionRefusal[] = [];
  const live: VoiceRealtimeExecStatusReading = {
    phase: 'running',
    runId: 'r-1',
    elapsedMs: 10,
    queuedItems: 0,
    queuedBytes: 0,
    pendingInteraction: null,
    digest: null,
    statusSeq: 3,
    at: 1,
  };
  const executor = buildStatusExecutor(() => live, refusals, () => ({ runId: 'unused', queued: false }));

  // Omitting `session` answers the BOUND session — the instructions tell the model never to name one,
  // so this is the path the real transport exercises on every call.
  const omitted = (await executor['session_status']!({})) as Record<string, unknown>;
  assert.equal(omitted['sessionId'], BOUND_SESSION);

  // Naming the bound session is likewise allowed.
  const named = (await executor['session_status']!({ session: BOUND_SESSION })) as Record<string, unknown>;
  assert.equal(named['sessionId'], BOUND_SESSION);

  // Naming a DIFFERENT session is refused with the executor's own error, and recorded.
  let thrown: unknown = null;
  try {
    await executor['session_status']!({ session: 'sess-other' });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof VoiceRealtimeSessionRefusalError, 'a foreign session is refused by throwing');
  assert.equal(thrown.refusal.tool, 'session_status');
  assert.equal(thrown.refusal.boundSessionId, BOUND_SESSION);
  assert.equal(thrown.refusal.requestedSession, 'sess-other');
  assert.deepEqual(thrown.refusal.rawArguments, { session: 'sess-other' });

  // The throw and the sink carry the SAME record: the refusal is recorded, not merely reported.
  assert.equal(refusals.length, 1, 'the attempt is recorded, not only refused');
  assert.deepEqual(refusals[0], thrown.refusal, 'the recorded refusal is the one that was thrown');
});

// ---------------------------------------------------------------------------------------------
// AC6. The §6.3 tool budget: the advertised descriptions together stay within twice one session_send.
// ---------------------------------------------------------------------------------------------

test('AC6: the two voice descriptions together fit inside twice one session_send description', (t) => {
  const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
  const byName = new Map(VOICE_REALTIME_TOOLS.map((tool) => [tool.name, tool.description]));
  const send = byName.get('session_send');
  assert.ok(send, 'session_send must be advertised');
  const budget = 2 * bytes(send);
  const perTool = VOICE_REALTIME_TOOLS.map((tool) => `${tool.name}=${bytes(tool.description)}B`);
  const total = VOICE_REALTIME_TOOLS.reduce((sum, tool) => sum + bytes(tool.description), 0);

  t.diagnostic(`AC6: per-tool description bytes: ${perTool.join(', ')}`);
  t.diagnostic(`AC6: total=${total}B  budget=2×session_send=${budget}B`);
  assert.ok(total <= budget, `the advertised descriptions are ${total}B, over the ${budget}B budget (SPEC §6.3)`);
});

// ---------------------------------------------------------------------------------------------
// AC3, AC7, DoD. Over the REAL transport and proxy: the tool answers from the SAME aggregator
// reading the injected line came from (statusSeq equal), and nothing leaves the host.
// ---------------------------------------------------------------------------------------------

/** The browser end of the socket, driven directly — the stand-in the other proxy criteria use. */
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

type StatusToolScenario = {
  readonly upstream: ScriptedUpstream;
  readonly socket: FakeBrowserSocket;
  /** Every aggregator reading the proxy published beside an injection, in order. */
  readonly published: VoiceRealtimeExecStatusReading[];
  readonly refusals: VoiceRealtimeSessionRefusal[];
  /** Queue the n-th `session_send` result (last entry repeats). */
  readonly sendResults: Array<Record<string, unknown>>;
  calls: number;
};

/**
 * Boots the real transport + real proxy with the production `onExecStatus` → `sessionStatus` wiring,
 * and a stub `session_send` that hands back the scripted results.
 */
function startStatusToolScenario(sendResults: Array<Record<string, unknown>>): StatusToolScenario {
  const upstream = createScriptedUpstream();
  const published: VoiceRealtimeExecStatusReading[] = [];
  const refusals: VoiceRealtimeSessionRefusal[] = [];
  const scenario: StatusToolScenario = {
    upstream,
    socket: new FakeBrowserSocket(),
    published,
    refusals,
    sendResults,
    calls: 0,
  };

  // THIS is `server/index.ts`'s wiring, verbatim: the proxy publishes each injected line's reading
  // into a per-connection cell, and the executor's `session_status` reads that cell.
  let latest: VoiceRealtimeExecStatusReading | null = null;
  const executor = buildStatusExecutor(
    () => latest,
    refusals,
    () => scenario.sendResults[Math.min(scenario.calls, scenario.sendResults.length - 1)] ?? { runId: 'r-1', queued: false },
  );
  const countingExecutor: RealtimeToolExecutor = {
    ...executor,
    session_send: async (args) => {
      const result = await executor['session_send']!(args);
      scenario.calls += 1;
      return result;
    },
  };

  handleVoiceRealtimeConnection(
    scenario.socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    BOUND_SESSION,
    {
      createTransport: (report) =>
        createDashscopeTransport({
          apiKey: '',
          endpoint: SCRIPTED_ENDPOINT_URL,
          socketFactory: upstream.socketFactory,
          onError: report,
        }),
      createExecutor: () => countingExecutor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
      statusRateMs: 20,
      onExecStatus: (reading) => {
        latest = reading;
        published.push(reading);
      },
      log: () => {},
    },
  );
  return scenario;
}

/** Resolves once the proxy has reported the upstream session open to the browser. */
const openSession = (scenario: StatusToolScenario): Promise<void> =>
  waitFor(() => scenario.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

/** Every `session.update` body's `instructions`, in the order the transport put them on the wire. */
const instructionTexts = (scenario: StatusToolScenario): string[] =>
  scenario.upstream.clientFrames
    .filter((frame) => frame.type === 'session.update')
    .map((frame) => String((frame.session as Record<string, unknown> | undefined)?.instructions ?? ''));

/** Only the updates that CARRIED a status line — the S-A injections, and nothing else. */
const statusLines = (scenario: StatusToolScenario): string[] =>
  instructionTexts(scenario).filter((text) => text.includes('[exec] phase='));

/** The last injected `[exec] …` line, or a failure. */
const lastStatusLine = (scenario: StatusToolScenario): string => {
  const lines = statusLines(scenario);
  assert.ok(lines.length > 0, 'no status line was injected at all');
  const text = lines[lines.length - 1] ?? '';
  return text.slice(text.indexOf('[exec] ')).split('\n')[0] ?? '';
};

/** One numeric field of an `[exec]` line, by name. Throws where the field is missing. */
function numField(line: string, name: string): number {
  const match = new RegExp(`(?:^|\\s)${name}=(-?\\d+)`).exec(line);
  assert.ok(match, `the line must carry ${name}=<int>: ${line}`);
  return Number(match[1]);
}

/**
 * The `session_status` tool result the endpoint ACTUALLY received, read off the wire.
 *
 * The transport maps a bridge `function_call_output` onto a `conversation.item.create` whose
 * `item.output` is the JSON-stringified result (see `voice-realtime-dashscope-transport.ts`), so this
 * reads the same bytes the model would.
 */
function statusResultFor(scenario: StatusToolScenario, callId: string): Record<string, unknown> {
  const frame = scenario.upstream.clientFrames.find((candidate) => {
    if (candidate.type !== 'conversation.item.create') return false;
    const item = candidate.item as Record<string, unknown> | undefined;
    return item?.type === 'function_call_output' && item?.call_id === callId;
  });
  assert.ok(frame, `no tool output reached the endpoint for ${callId}`);
  const item = frame.item as Record<string, unknown>;
  return JSON.parse(String(item.output)) as Record<string, unknown>;
}

/** Says one thing to the model: the transcription and then the `session_send` tool call for it. */
const deliver = (scenario: StatusToolScenario, message: string, callId: string): void => {
  scenario.upstream.emit(captionCompleted(`item-${callId}`, message));
  scenario.upstream.emit(functionCall('session_send', { message }, callId));
};

/** The model asking for the full status, with no `session` (the instructions tell it never to name one). */
const askStatus = (scenario: StatusToolScenario, callId: string): void => {
  scenario.upstream.emit(functionCall('session_status', {}, callId));
};

// The 2026-10-14 ruling withdrew `session_status` from the advertised set, and the transport enforces
// that set as its whitelist (a call for a tool it never advertised is withheld as `UNDECLARED_TOOL`).
// So the tool is unreachable end-to-end — which is the ruling's point — while the executor ROUTE and
// its single-source reading are retained (asserted below at the executor level).
test('AC3 + DoD: the withdrawn session_status is withheld over the real transport; the retained route reads the injected line’s own source', async (t) => {
  // A run starts on the first delivery, then two deliveries queue behind it: phase queued, 2 waiting.
  const scenario = startStatusToolScenario([
    { runId: 'r-live', queued: false },
    { runId: 'r-live', queued: true },
    { runId: 'r-live', queued: true },
  ]);
  await openSession(scenario);

  deliver(scenario, '先跑这个', 'd1');
  await waitFor(() => scenario.calls === 1, 4_000);
  await waitFor(() => statusLines(scenario).length === 1, 4_000);

  // A second delivery that QUEUES behind the run, so the session is "running with items queued".
  deliver(scenario, '再做这个', 'd2');
  await waitFor(() => scenario.calls === 2, 4_000);
  await waitFor(() => statusLines(scenario).length === 2, 4_000);

  const line = lastStatusLine(scenario);
  const lineSeq = numField(line, 'statusSeq');
  assert.match(line, /phase=queued run=r-live/, `the injected line names the queued run: ${line}`);
  assert.match(line, /queued=1\/\d+B/, `one queued delivery is on the line: ${line}`);

  // THE RULING'S EFFECT, over the real transport: the model's call for the withdrawn tool is refused
  // before it can reach the executor — the transport's whitelist IS the advertised set, so a call for
  // a tool that was never advertised is reported `UNDECLARED_TOOL`, and no result goes back.
  askStatus(scenario, 'status-1');
  await waitFor(
    () => scenario.socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'UNDECLARED_TOOL'),
    4_000,
  );
  assert.equal(
    scenario.upstream.clientFrames.some(
      (candidate) => (candidate.item as Record<string, unknown> | undefined)?.call_id === 'status-1',
    ),
    false,
    'no result for the withdrawn tool may reach the endpoint',
  );
  t.diagnostic('AC3/DoD: the withdrawn session_status call was withheld as UNDECLARED_TOOL');

  // THE RETAINED ROUTE, at the executor level: the SAME reading the injected line was rendered from is
  // what the retained `session_status` implementation answers, field for field (SPEC §6.3’s
  // single-source rule). The reading is the one the proxy published beside that line.
  const reading = scenario.published[scenario.published.length - 1]!;
  assert.equal(reading.statusSeq, lineSeq, 'the last published reading is the one the last line was rendered from');
  const routeExecutor = buildStatusExecutor(
    () => reading,
    [],
    () => ({ runId: 'unused', queued: false }),
  );
  const result = (await routeExecutor['session_status']!({})) as Record<string, unknown>;

  // AC3, the load-bearing assertion: the route's statusSeq IS the injected line's statusSeq.
  assert.equal(
    result['statusSeq'],
    lineSeq,
    `the retained route and the line must be ONE source (route=${result['statusSeq']} line=${lineSeq})`,
  );

  // And the rest of the §6.3 reading agrees with the reading, field for field.
  assert.equal(result['statusSeq'], reading.statusSeq);
  assert.equal(result['at'], reading.at);
  assert.equal(result['phase'], reading.phase, 'phase is the reading’s own, verbatim');
  assert.equal(result['runId'], reading.runId);
  assert.equal(result['queuedItems'], reading.queuedItems);
  assert.equal(result['queuedBytes'], reading.queuedBytes);
  assert.equal(result['elapsedMs'], reading.runId === null ? null : reading.elapsedMs);
  assert.equal(result['sessionId'], BOUND_SESSION);
  assert.equal(result['maxBytes'], 1000);

  t.diagnostic(`AC3/DoD: injected line: ${line}`);
  t.diagnostic(`AC3/DoD: retained route result: ${JSON.stringify(result)}`);

  scenario.socket.close();
});

/** Waits until the tool output for `callId` has reached the endpoint, then returns it. */
async function waitForResult(scenario: StatusToolScenario, callId: string): Promise<Record<string, unknown>> {
  await waitFor(
    () =>
      scenario.upstream.clientFrames.some((candidate) => {
        const item = candidate.item as Record<string, unknown> | undefined;
        return candidate.type === 'conversation.item.create' && item?.call_id === callId;
      }),
    4_000,
  );
  return statusResultFor(scenario, callId);
}

test('AC7: the status-tool run is offline by construction — empty credential and the stand-in’s own address', async () => {
  const scenario = startStatusToolScenario([{ runId: 'r-1', queued: false }]);
  await openSession(scenario);
  deliver(scenario, 'x', 'd1');
  await waitFor(() => statusLines(scenario).length === 1, 4_000);
  // The delivery's tool result reaching the endpoint is what proves the frames came from the stand-in
  // (`session_status` itself is withdrawn and withheld, so it is the send that is read here).
  await waitForResult(scenario, 'd1');

  // Every frame read came from the script: the address dialled is the stand-in's own.
  assert.equal((scenario.upstream.dialedUrl ?? '').split('?')[0], SCRIPTED_ENDPOINT_URL);

  // And it is enforced, not merely intended: the SAME parameters WITHOUT the stand-in refuse rather
  // than dial a real endpoint with an empty credential.
  const cloudless = createDashscopeTransport({ apiKey: '', endpoint: SCRIPTED_ENDPOINT_URL });
  await assert.rejects(
    () => cloudless.open(),
    /a DashScope key is required to open the real DashScope realtime transport/,
  );

  assert.ok(scenario.upstream.clientFrames.length > 0, 'the stand-in saw the frames, so it was the endpoint');
  scenario.socket.close();
});
