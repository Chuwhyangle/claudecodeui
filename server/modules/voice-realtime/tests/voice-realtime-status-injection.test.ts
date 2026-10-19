/**
 * S-A: the ONE compact execution-status line folded into a live voice session's instructions
 * (`docs/proposals/voice-realtime-persistent-control-SPEC.md` §8.3/§8.4, Draft-2) — and the four
 * constraints the human ruling D-1 put on it.
 *
 * WHY THIS FILE EXISTS. The 2026-10-11 journal (`c8b0ee15`) recorded a user saying seven things and
 * the Realtime model answering six of them with the text "OK" INSTEAD OF calling the tool: nothing had
 * told it Claude was busy, and the only execution-plane reading the model ever got was the C2 context
 * pack, read ONCE per connection and stale for the whole of a long turn. S-A is the fix: a state line
 * that changes when the execution plane does.
 *
 * HOW IT RUNS. The REAL transport and the REAL proxy — `createDashscopeTransport` and
 * `handleVoiceRealtimeConnection`, the same two functions `server/index.ts` wires — over
 * `createScriptedUpstream`, with `apiKey: ''` and the stand-in's socket factory. The two together are
 * what make the run offline BY CONSTRUCTION (see the isolation control at the end of this file), so
 * every `session.update` the assertions read is one the stand-in actually received. No credential is
 * read and nothing dials out.
 *
 * WHAT IS ASSERTED IS THE WIRE, NOT A RETURN VALUE. Each criterion reads
 * `upstream.clientFrames` — the frames the transport emitted — and pulls the status line out of the
 * `session.update` body's `instructions`. The `onExecStatus` seam supplies the other side of the
 * single-source comparison (AC6) and the `log` seam says what the injection decided.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import {
  createVoiceRealtimeExecStatus,
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  VOICE_REALTIME_STATUS_MAX_BYTES,
  VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN,
  VOICE_REALTIME_STATUS_RATE_MS,
  type VoiceRealtimeExecStatusReading,
  type VoiceRealtimeOutboundFrame,
} from '../voice-realtime-ws-proxy.service.js';
import {
  VOICE_REALTIME_STATUS_HEADER,
  VOICE_REALTIME_STATUS_STALE_MS,
  VOICE_REALTIME_STATUS_STALENESS_RULE,
} from '../voice-realtime-settings.js';

import { waitFor } from './realtime-bridge-harness.js';
import {
  captionCompleted,
  createScriptedUpstream,
  functionCall,
  SCRIPTED_ENDPOINT_URL,
  type ScriptedUpstream,
} from './voice-realtime-scripted-upstream.js';

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

type StatusScenario = {
  readonly upstream: ScriptedUpstream;
  readonly socket: FakeBrowserSocket;
  /** Every aggregator reading the proxy handed out BESIDE an injection, in order (AC6). */
  readonly readings: VoiceRealtimeExecStatusReading[];
  /** Every log line the proxy wrote for this connection. */
  readonly logLines: string[];
  /** How many times the executor was called at all. */
  readonly calls: () => number;
};

/**
 * Boots one scenario: the real transport over the scripted stand-in, the real proxy, a stub executor.
 *
 * The executor hands back `results[n]` for the n-th call (the LAST entry repeats), so a scenario
 * controls the one reading S-A is driven by — the session's own `session_send` result.
 */
function startStatusScenario(options: {
  results: Array<Record<string, unknown>>;
  statusRateMs?: number;
  coalesceMs?: number;
}): StatusScenario {
  const upstream = createScriptedUpstream();
  const readings: VoiceRealtimeExecStatusReading[] = [];
  const logLines: string[] = [];
  let calls = 0;
  const executor: RealtimeToolExecutor = {
    session_send: async () => {
      const result = options.results[Math.min(calls, options.results.length - 1)] ?? { runId: 'r-1' };
      calls += 1;
      return result;
    },
    session_interrupt: async () => ({ aborted: true }),
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'status-session',
    {
      createTransport: (report) =>
        createDashscopeTransport({
          apiKey: '',
          endpoint: SCRIPTED_ENDPOINT_URL,
          socketFactory: upstream.socketFactory,
          onError: report,
        }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
      ...(options.statusRateMs === undefined ? {} : { statusRateMs: options.statusRateMs }),
      ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
      onExecStatus: (reading) => readings.push(reading),
      log: (line) => logLines.push(line),
    },
  );
  return { upstream, socket, readings, logLines, calls: () => calls };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once the proxy has reported the upstream session open to the browser. */
const openSession = (scenario: StatusScenario): Promise<void> =>
  waitFor(() => scenario.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

/** Every `session.update` body's `instructions`, in the order the transport put them on the wire. */
const instructionTexts = (scenario: StatusScenario): string[] =>
  scenario.upstream.clientFrames
    .filter((frame) => frame.type === 'session.update')
    .map((frame) => String((frame.session as Record<string, unknown> | undefined)?.instructions ?? ''));

/** Only the updates that CARRIED a status line — the S-A injections, and nothing else. */
const statusLines = (scenario: StatusScenario): string[] =>
  instructionTexts(scenario).filter((text) => text.includes('[exec] phase='));

/** The `[exec] …` line out of a composed `instructions` body. */
function execLineOf(text: string): string {
  const at = text.indexOf('[exec] ');
  assert.ok(at >= 0, `no [exec] line in: ${JSON.stringify(text)}`);
  return text.slice(at).split('\n')[0] ?? '';
}

const lastStatusLine = (scenario: StatusScenario): string => {
  const lines = statusLines(scenario);
  assert.ok(lines.length > 0, 'no status line was injected at all');
  return execLineOf(lines[lines.length - 1] ?? '');
};

/** The `queued=<items>/<bytes>B` reading, which is the one field of the line that is not `name=value`. */
function queuedReading(line: string): [number, number] {
  const match = /queued=(-?\d+)\/(-?\d+)B/.exec(line);
  assert.ok(match, `the line must carry queued=<items>/<bytes>B: ${line}`);
  return [Number(match[1]), Number(match[2])];
}

/** One numeric field of the line, by name. Throws where the field is missing rather than returning 0. */
function numField(line: string, name: string): number {
  const match = new RegExp(`(?:^|\\s)${name}=(-?\\d+)`).exec(line);
  assert.ok(match, `the line must carry ${name}=<int>: ${line}`);
  return Number(match[1]);
}

/**
 * Says one thing to the model, exactly as the endpoint would: the user's own utterance, transcribed,
 * and then the `session_send` tool call the model emits for it.
 *
 * The transcription event is not decoration. The bridge's `TOOL_LOOP_GUARD` counts tool calls SINCE
 * THE LAST UTTERANCE (`voice-realtime-bridge.service.ts`, `MAX_CALLS_PER_UTTERANCE = 6`) and resets
 * the count on `conversation.item.input_audio_transcription.completed` — a relay of twelve spoken
 * things is twelve utterances, not a tool loop, and driving only the tool calls would have the guard
 * stop the run at the seventh.
 */
const deliver = (scenario: StatusScenario, message: string, callId: string): void => {
  scenario.upstream.emit(captionCompleted(`item-${callId}`, message));
  scenario.upstream.emit(functionCall('session_send', { message }, callId));
};

// ---------------------------------------------------------------------------------------------
// AC1. The dedup gate — THE FIRST ASSERTION OF THIS FILE, because it is the one that was false
// before S-A: without it every event re-sent the whole instruction block.
// ---------------------------------------------------------------------------------------------

test('AC1: an unchanged execution state is never injected twice; a changed one is', async () => {
  // THE FIRST ASSERTION OF THIS FILE — the dedup gate itself, on its own, before a socket exists.
  // This is the property that was FALSE before S-A: every event re-sent the whole instruction block,
  // so the gate is checked here at the mechanism and then again below at the wire (SPEC §8.3 row 1).
  const gate = createVoiceRealtimeExecStatus();
  assert.equal(
    gate.update({ phase: 'running', runId: 'r-1', queuedItems: 0, queuedBytes: 0 }).changed,
    true,
    'the first observation of a state IS a change',
  );
  assert.equal(
    gate.update({ phase: 'running', runId: 'r-1', queuedItems: 0, queuedBytes: 0 }).changed,
    false,
    'the SAME dedup key is not a change, so nothing would be injected for it',
  );
  assert.equal(gate.reading().statusSeq, 1, 'and the unchanged state did not advance statusSeq');

  const scenario = startStatusScenario({
    // c1 and c2 hand back the SAME result; c3 hands back one that moves the queue.
    results: [{ runId: 'r-1', queued: false }, { runId: 'r-1', queued: false }, { runId: 'r-1', queued: true }],
    statusRateMs: 20,
  });
  await openSession(scenario);

  deliver(scenario, '把超时改成三十秒', 'c1');
  await waitFor(() => statusLines(scenario).length >= 1, 4_000);

  // The SAME state once more: same run, same queue, same bytes. The dedup key
  // (phase, runId, queuedItems, queuedBytes, pendingInteraction.requestId) did not move, so a correct
  // S-A sends NOTHING — not a re-send of the same line, not a no-op frame.
  deliver(scenario, '再确认一下', 'c2');
  await waitFor(() => scenario.calls() === 2, 4_000);
  // Several rate windows' worth of wall-clock, so a stray timer would have fired by now.
  await sleep(150);

  assert.equal(
    statusLines(scenario).length,
    1,
    'the same dedup key must not produce a second injection',
  );

  // The positive control: the state change that DID happen did reach the upstream, as one more
  // `session.update` whose instructions carry the line (SPEC §8.3's first row, event-driven).
  const updates = instructionTexts(scenario);
  assert.equal(updates.length, 2, 'the open advert plus exactly one injection');
  assert.ok(instructionTexts(scenario).some((text) => text.includes('[exec] phase=running run=r-1')), 'the injected instructions carry the state line');
  assert.ok(
    scenario.logLines.some((line) => line.startsWith('status injected')),
    'the injection says so on the browser-side log',
  );

  // A state that DOES move injects again — otherwise the criterion would be satisfied by an
  // implementation that never injects at all.
  deliver(scenario, '还在忙吗', 'c3');
  await waitFor(() => scenario.calls() === 3, 4_000);
  await waitFor(() => statusLines(scenario).length === 2, 4_000);
  assert.ok(scenario.calls() === 3);

  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// AC2. Rate limiting and coalescing: five changes inside one real 2 s window cost ONE update, and
// the one that goes out is the LATEST state, not the first.
// ---------------------------------------------------------------------------------------------

test('AC2: five state changes inside the shipped 2 s window collapse to one injection carrying the latest', async (t) => {
  // NO statusRateMs: this criterion is about the number that SHIPS (SPEC §8.3: 最多 1 次 / 2 s).
  const results: Array<Record<string, unknown>> = [{ runId: 'r-1', queued: false }];
  for (let i = 0; i < 4; i += 1) {
    results.push({ runId: 'r-1', queued: true });
  }
  const scenario = startStatusScenario({ results });
  await openSession(scenario);

  // Five distinct states, driven back to back — all inside the window the first change opens.
  for (let i = 0; i < 5; i += 1) {
    deliver(scenario, 'x'.repeat(30), `c${i}`);
    await waitFor(() => scenario.calls() === i + 1, 4_000);
  }
  assert.equal(statusLines(scenario).length, 0, 'nothing is injected mid-window: the edge is TRAILING');

  await waitFor(() => statusLines(scenario).length === 1, 6_000);
  // Long enough that a queued second injection would have landed.
  await sleep(2_500);

  const lines = statusLines(scenario);
  assert.equal(lines.length, 1, 'five changes inside 2 s are ONE session.update, not five');

  // The content reading: the line is the LATEST state (the fourth queued delivery: 4 waiting, 120 B).
  const line = lastStatusLine(scenario);
  assert.match(line, /phase=queued/, `the line must carry the latest phase: ${line}`);
  assert.ok(line.includes('queued=4/120B'), `queued=4/120B expected in: ${line}`);
  assert.equal(scenario.readings.length, 1, 'the collapse is one injection on BOTH sides of the seam');

  t.diagnostic(`AC2: 5 changes / 1 session.update; injected line: ${line}`);
  t.diagnostic(`AC2: source window = ${VOICE_REALTIME_STATUS_RATE_MS} ms (shipped default, not a seam)`);
  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// AC3. The per-run cap: more than eight changes in one run is still eight injections, and the
// eighth says so in the line.
// ---------------------------------------------------------------------------------------------

test('AC3: more than eight changes in one run is exactly eight injections, the eighth carrying the marker', async (t) => {
  const results: Array<Record<string, unknown>> = [{ runId: 'r-1', queued: false }];
  for (let i = 0; i < 11; i += 1) {
    results.push({ runId: 'r-1', queued: true });
  }
  // The thirteenth call is a NEW run — the cap is a property of a run, so this starts counting again.
  results.push({ runId: 'r-2', queued: false });
  const scenario = startStatusScenario({ results, statusRateMs: 20 });
  await openSession(scenario);

  // Twelve distinct states in ONE run, each observed after its own window closes, so each would be
  // its own injection if the cap did not exist.
  for (let i = 0; i < 12; i += 1) {
    deliver(scenario, 'x'.repeat(30), `c${i}`);
    await waitFor(() => scenario.calls() === i + 1, 4_000);
    const expected = Math.min(i + 1, VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN);
    await waitFor(() => statusLines(scenario).length >= expected, 4_000);
  }
  await sleep(200);

  const lines = statusLines(scenario);
  assert.equal(lines.length, VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN, 'exactly the cap, not one more');
  assert.equal(lines.length, 8, 'the shipped cap is eight per run');

  const seventh = execLineOf(lines[6] ?? '');
  const eighth = execLineOf(lines[7] ?? '');
  assert.ok(!/\(\+\d+ more\)/.test(seventh), `the seventh line is a normal one: ${seventh}`);
  assert.match(eighth, /\(\+\d+ more\)/, `the eighth line carries the marker: ${eighth}`);
  assert.match(eighth, /\(\+1 more\)/, `twelve changes minus eight injections leaves the rest: ${eighth}`);
  assert.ok(
    scenario.logLines.some((line) => line.includes('more=1')),
    'the cap notice says how many changes it is not going to send',
  );
  t.diagnostic(`AC3: 12 changes in run r-1 → ${lines.length} injections; last: ${eighth}`);

  // The cap is a property of a RUN, so a new run gets its own eight. Without this the criterion
  // would also be satisfied by a connection-level cap that never lets another line out.
  deliver(scenario, 'x', 'c-new-run');
  await waitFor(() => statusLines(scenario).length === 9, 4_000);
  const ninth = execLineOf(statusLines(scenario)[8] ?? '');
  assert.match(ninth, /run=r-2/, `a new run injects again: ${ninth}`);
  assert.ok(!/\(\+\d+ more\)/.test(ninth), `and it is not a cap notice: ${ninth}`);
  t.diagnostic(`AC3: run r-2 resets the cap → injection 9: ${ninth}`);

  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// AC4. Staleness: `at` is the instant the state changed, `ageMs` is measured from it at the render,
// and the instruction layer states the rule that makes an old line unusable as the present.
// ---------------------------------------------------------------------------------------------

test('AC4: at/ageMs agree with the injection instant, and the instructions carry the ageMs > 4000 rule', async () => {
  const scenario = startStatusScenario({
    results: [{ runId: 'r-1', queued: false }, { runId: 'r-1', queued: true }],
    statusRateMs: 300,
  });
  await openSession(scenario);

  const before1 = Date.now();
  deliver(scenario, '开始了吗', 'c1');
  await waitFor(() => statusLines(scenario).length === 1, 4_000);
  const after1 = Date.now();

  const line1 = lastStatusLine(scenario);
  const at1 = numField(line1, 'at');
  const age1 = numField(line1, 'ageMs');
  assert.ok(at1 >= before1 - 5 && at1 <= after1 + 5, `at must be the change instant (${before1}..${after1} vs ${at1})`);
  assert.ok(age1 >= 0, `ageMs is never negative: ${age1}`);
  assert.ok(after1 - at1 - age1 <= 200, `ageMs must be this line's age at render: at=${at1} ageMs=${age1} now=${after1}`);

  // A SECOND reading, so the pair is a relation the code maintains and not one lucky sample.
  deliver(scenario, '还在忙吗', 'c2');
  await waitFor(() => statusLines(scenario).length === 2, 4_000);
  const after2 = Date.now();
  const line2 = lastStatusLine(scenario);
  const at2 = numField(line2, 'at');
  const age2 = numField(line2, 'ageMs');
  assert.ok(at2 > at1, `a later change is a later instant: ${at1} then ${at2}`);
  assert.ok(after2 - at2 - age2 <= 200, `the second line holds the same relation: at=${at2} ageMs=${age2}`);
  assert.ok(age2 >= 0);

  // The TEXT requirement (SPEC §8.3's last row): an instruction body that carries a status line must
  // also carry the rule that an old one is not the present.
  const withStatus = instructionTexts(scenario).find((text) => text.includes('[exec] phase='));
  assert.ok(withStatus, 'an instruction body with a status line');
  assert.ok(withStatus.includes(VOICE_REALTIME_STATUS_HEADER), 'the line is introduced');
  assert.ok(withStatus.includes(VOICE_REALTIME_STATUS_STALENESS_RULE), 'the staleness rule travels with it');
  assert.match(withStatus, /ageMs > 4000/, 'the rule names the threshold literally');
  assert.equal(
    withStatus.includes('session_status'),
    false,
    'session_status is withdrawn (2026-10-14 ruling): the rule no longer points at it',
  );
  assert.equal(VOICE_REALTIME_STATUS_STALE_MS, 4000, 'the code-side constant is the same number');

  // The no-status bodies stay byte-for-byte the pre-S-A prompt: the base instructions alone.
  const openAdvert = instructionTexts(scenario)[0] ?? '';
  assert.equal(openAdvert, VOICE_REALTIME_INSTRUCTIONS, 'a connection with no state sends the bare prompt');

  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// AC5. Bounded and leak-free: ≤ 200 bytes, no CJK, and no path.
// ---------------------------------------------------------------------------------------------

test('AC5: every injected line is under the byte cap and carries neither the user text nor a path', async () => {
  const userText =
    '请把 /data/home/yale/work/claudecodeui/server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts 里的逻辑改掉，暗号是蓝色鲸鱼';
  const scenario = startStatusScenario({
    results: [{ runId: 'r-8f21', queued: false }, { runId: 'r-8f21', queued: true }],
    statusRateMs: 20,
  });
  await openSession(scenario);

  // The message reaches the executor — so the absence assertions below are about the INJECTION, not
  // about a message that never went anywhere.
  deliver(scenario, userText, 'c1');
  await waitFor(() => scenario.calls() === 1, 4_000);
  await waitFor(() => statusLines(scenario).length === 1, 4_000);
  deliver(scenario, userText, 'c2');
  await waitFor(() => scenario.calls() === 2, 4_000);
  await waitFor(() => statusLines(scenario).length === 2, 4_000);

  const lines = statusLines(scenario).map(execLineOf);
  assert.ok(lines.length >= 2, 'the sampled text is the injected set');
  for (const line of lines) {
    assert.ok(
      Buffer.byteLength(line, 'utf8') <= VOICE_REALTIME_STATUS_MAX_BYTES,
      `the line must be ≤ ${VOICE_REALTIME_STATUS_MAX_BYTES} bytes: ${line}`,
    );
    assert.equal(line.includes(userText), false, 'never the user text');
    assert.equal(/[　-鿿＀-￯]/.test(line), false, `never CJK from the message: ${line}`);
    assert.equal(line.includes('/data/'), false, `never a path: ${line}`);
    assert.equal(line.includes('.ts'), false, `never a file name: ${line}`);
    // The ONE `/` the shape allows is the queued=N/MB reading; with that removed, nothing is left
    // that could be a separator.
    const withoutQueueReading = line.replace(/queued=\d+\/\d+B/, 'queued=…');
    assert.equal(withoutQueueReading.includes('/'), false, `no path separator in any field: ${line}`);
    assert.equal(withoutQueueReading.includes('\\'), false, `no Windows path separator either: ${line}`);
  }
  assert.match(lines[lines.length - 1] ?? '', /queued=1\/\d+B/, 'the sampled lines are the real shape');

  // The field-level defence, exercised directly on the aggregator: a run id that IS a path comes out
  // of the sanitizer as an opaque token with no separators left, so a path cannot be carried even if
  // some future event source hands the status one.
  const hostile = createVoiceRealtimeExecStatus();
  hostile.update({ phase: 'running', runId: '/data/home/yale/secret.ts', queuedItems: 0, queuedBytes: 0 });
  const hostileLine = hostile.render(Date.now()).text;
  assert.ok(hostileLine.startsWith('[exec] '), hostileLine);
  // The ONE `/` the shape allows is the `queued=<items>/<bytes>B` reading (here `0/0B`); with that
  // removed, nothing left in the line can be a separator — and the `run=` field specifically, which is
  // the field the hostile value went into, must hold no trace of the path.
  const hostileWithoutQueue = hostileLine.replace(/queued=\d+\/\d+B/, 'queued=…');
  assert.equal(hostileWithoutQueue.includes('/'), false, `a path-shaped run is stripped of its separators: ${hostileLine}`);
  const hostileRun = /(?:^|\s)run=(\S+)/.exec(hostileLine)?.[1] ?? '';
  assert.equal(hostileRun.includes('/'), false, `the run field holds no separator: ${hostileLine}`);

  // The byte cap and the cap NOTICE have to hold together: the marker is the last thing a run says,
  // so it must never be the part the truncation eats. A maximal line (a 16-char run, a pending
  // interaction, five-digit counters) plus the marker is still inside the bound.
  const maximal = createVoiceRealtimeExecStatus();
  maximal.update({
    phase: 'queued',
    runId: 'r-0123456789abcdef',
    queuedItems: 9999,
    queuedBytes: 99999999,
    pendingInteraction: { requestId: 'req-0123456789abcdef', toolName: 'AskUserQuestion' },
  });
  const maximalLine = maximal.render(Date.now(), { more: 12345 }).text;
  assert.ok(
    Buffer.byteLength(maximalLine, 'utf8') <= VOICE_REALTIME_STATUS_MAX_BYTES,
    `even a maximal line stays inside the cap: ${Buffer.byteLength(maximalLine, 'utf8')} B — ${maximalLine}`,
  );
  assert.match(maximalLine, /\(\+12345 more\)$/, maximalLine);
  assert.equal(/[　-鿿＀-￯]/.test(hostileLine), false, hostileLine);

  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// AC6. Single source: the line's statusSeq is the aggregator's own number, not a second computation.
// ---------------------------------------------------------------------------------------------

test('AC6: the line carries the aggregator reading status for status (statusSeq included)', async (t) => {
  const scenario = startStatusScenario({
    results: [{ runId: 'r-1', queued: false }, { runId: 'r-1', queued: true }, { runId: 'r-1', queued: true }],
    statusRateMs: 20,
  });
  await openSession(scenario);

  for (let i = 0; i < 3; i += 1) {
    deliver(scenario, 'x'.repeat(30), `c${i}`);
    await waitFor(() => scenario.calls() === i + 1, 4_000);
    await waitFor(() => statusLines(scenario).length === i + 1, 4_000);
  }

  const lines = statusLines(scenario).map(execLineOf);
  assert.equal(lines.length, 3, 'three distinct states, three injections');
  assert.equal(
    scenario.readings.length,
    lines.length,
    'every injection handed out exactly one reading — the pairing is 1:1',
  );

  const seqs = scenario.readings.map((reading) => reading.statusSeq);
  assert.ok(seqs[0]! < seqs[1]! && seqs[1]! < seqs[2]!, `statusSeq increases with each change: ${seqs.join(',')}`);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const reading = scenario.readings[i]!;
    assert.equal(
      numField(line, 'statusSeq'),
      reading.statusSeq,
      `injection ${i + 1} must carry the reading's OWN statusSeq: ${line}`,
    );
    // The rest of the line is the same reading, field for field — one render, not a re-derivation.
    assert.equal(numField(line, 'at'), reading.at, line);
    assert.match(line, new RegExp(`phase=${reading.phase}`), line);
    const [items, bytes] = queuedReading(line);
    assert.equal(items, reading.queuedItems, line);
    assert.equal(bytes, reading.queuedBytes, line);
    assert.equal(numField(line, 'elapsed'), Math.round(reading.elapsedMs / 1000), line);
  }

  t.diagnostic(`AC6: line/reading statusSeq pairs: ${lines.map((line) => numField(line, 'statusSeq')).join(',')}`);
  t.diagnostic(`AC6: aggregator readings:           ${seqs.join(',')}`);
  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// AC7. Offline, and the stand-in's own view of the `session.update` sequence.
// ---------------------------------------------------------------------------------------------

test('AC7: the injection run is offline by construction and the stand-in saw the whole sequence', async (t) => {
  const scenario = startStatusScenario({
    results: [{ runId: 'r-1', queued: false }, { runId: 'r-1', queued: true }],
    statusRateMs: 20,
  });
  await openSession(scenario);
  deliver(scenario, '第一句', 'c1');
  await waitFor(() => statusLines(scenario).length === 1, 4_000);
  deliver(scenario, '第二句', 'c2');
  await waitFor(() => statusLines(scenario).length === 2, 4_000);

  // The address the transport dialled is the stand-in's OWN, so every frame read above came from the
  // script and not from anything on the network (the transport appends `?model=…`, so the equality is
  // on the address, not the query).
  const dialed = scenario.upstream.dialedUrl ?? '';
  assert.equal(dialed.split('?')[0], SCRIPTED_ENDPOINT_URL, `dialled ${dialed}`);

  // And it is enforced, not merely intended: the SAME parameters WITHOUT the stand-in refuse rather
  // than dial a real endpoint with an empty credential. That refusal is what makes `apiKey: ''` a
  // statement about this run and not a wish.
  const cloudless = createDashscopeTransport({ apiKey: '', endpoint: SCRIPTED_ENDPOINT_URL });
  await assert.rejects(
    () => cloudless.open(),
    /a DashScope key is required to open the real DashScope realtime transport/,
  );

  const sequence = instructionTexts(scenario).map((text, index) => ({
    update: index + 1,
    status: text.includes('[exec] phase=') ? execLineOf(text) : '<no status line>',
  }));
  t.diagnostic(`AC7: session.update sequence seen by the fake upstream: ${JSON.stringify(sequence)}`);
  assert.equal(sequence.length, 3, 'the open advert plus two injections');
  assert.equal(sequence[0]?.status, '<no status line>', 'the open advert carries the bare prompt');

  scenario.socket.close();
});

// ---------------------------------------------------------------------------------------------
// DoD. One long turn, end to end, over the real transport: what the upstream ACTUALLY received,
// after dedup, rate limiting and the cap, plus the suppressed count and the single-source check.
// ---------------------------------------------------------------------------------------------

test('DoD: a long turn over the real transport — the upstream sequence is what dedup/rate/cap leave', async (t) => {
  const message = 'x'.repeat(30); // 30 bytes each, so the byte readings are predictable
  const results: Array<Record<string, unknown>> = [{ runId: 'r-long', queued: false }];
  for (let i = 0; i < 10; i += 1) {
    results.push({ runId: 'r-long', queued: true });
  }
  // A fresh run on the twelfth delivery, so the turn also shows the cap being a property of a run.
  results.push({ runId: 'r-long-2', queued: false });

  const scenario = startStatusScenario({ results, statusRateMs: 150 });
  await openSession(scenario);

  // Twelve deliveries, and (because the session's own queue grows with each one) twelve state changes.
  // Injections one through eight cover the first eight; the ninth, tenth and eleventh changes are what
  // the cap suppresses; the twelfth opens a new run, which starts counting again.
  const expectedAfter = [1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 9];
  const injectedAt: number[] = [];
  for (let i = 0; i < expectedAfter.length; i += 1) {
    deliver(scenario, message, `long-${i}`);
    await waitFor(() => scenario.calls() === i + 1, 4_000);
    await waitFor(() => statusLines(scenario).length >= (expectedAfter[i] ?? 8), 4_000);
    injectedAt.push(Date.now());
  }
  await sleep(400);

  const lines = statusLines(scenario).map(execLineOf);
  assert.equal(lines.length, 9, 'eight in the first run (the last being the cap notice) plus one in the new run');

  // The upstream's actual sequence — the DoD's own reading, each injection with its instant.
  const sequence = lines.map((line, index) => ({
    n: index + 1,
    atMs: injectedAt[index] ?? 0,
    line,
    statusSeq: numField(line, 'statusSeq'),
  }));
  t.diagnostic(`DoD: upstream received ${sequence.length} status injections`);
  for (const entry of sequence) {
    t.diagnostic(`DoD:   #${entry.n} @${entry.atMs} statusSeq=${entry.statusSeq} ${entry.line}`);
  }

  const suppressed = 12 - sequence.length;
  assert.equal(suppressed, 3, 'twelve changes minus nine injections');
  t.diagnostic(`DoD: 12 state changes → ${sequence.length} injections, ${suppressed} suppressed`);
  assert.match(sequence[7]?.line ?? '', /\(\+1 more\)/, 'the eighth is the cap notice');
  assert.equal(sequence[7]?.statusSeq, 8, 'and it reports the eighth change');

  // statusSeq ↔ aggregator: same numbers on both sides of the seam, in the same order.
  assert.equal(
    scenario.readings.length,
    sequence.length,
    'one reading per injection, no more and no fewer',
  );
  assert.deepEqual(
    sequence.map((entry) => entry.statusSeq),
    scenario.readings.map((reading) => reading.statusSeq),
    'the line and the aggregator reading agree status for status',
  );

  // Zero cloud calls: the only endpoint dialled is the stand-in's own.
  assert.equal((scenario.upstream.dialedUrl ?? '').split('?')[0], SCRIPTED_ENDPOINT_URL);
  assert.ok(scenario.upstream.clientFrames.length > 0, 'the fake upstream saw the frames, so it was the endpoint');

  scenario.socket.close();
});
