/**
 * AC-311's criterion: the Realtime connection's reconnect and response-concurrency
 * resilience, regressed against the race the live run ACTUALLY hit.
 *
 * The evidence is not invented here. `experiments/voice-realtime-ambiguity/
 * real-trace/qwen38-omni-realtime-trace.json` is a real capture of the adopted
 * target model (`qwen3.8-omni-flash-realtime`) in which the endpoint's server-side
 * VAD started a response at the same moment the client resumed the turn after a
 * tool result, and the endpoint answered:
 *
 *     {"type":"error","error":{"type":"invalid_request_error",
 *      "message":"Conversation already has an active response"}}
 *
 * Every frame this file feeds is extracted from that trace BY PREDICATE (never by
 * index, so a re-captured trace cannot silently shift what is being replayed), and
 * the extraction asserts each frame was found and that the error frame lands AFTER
 * the response it complains about — which is exactly why absorption cannot be
 * gated on "a response is in flight".
 *
 * The six readings:
 *
 *  - AC1: the transport exposes a NAMED in-flight-response state
 *    (`responseConcurrency`) and consults it — a resume synthesized for a tool
 *    result is HELD while the endpoint has a response in flight and flushed, once,
 *    when that response completes.
 *  - AC2: replaying the recorded race through the new code path leaves the
 *    connection open and the error frame ABSORBED (reported as the attributable
 *    `RESPONSE_CONCURRENCY_CONFLICT`, never surfaced as an unexplained event and
 *    never an uncaught throw).
 *  - AC3: the same replay against a copy with the state tracking removed must
 *    redden on that error frame — the endpoint reproduces it.
 *  - AC4: a simulated drop + reconnect resumes the SAME logical session: the tool
 *    result the endpoint never acknowledged is replayed once, an acknowledged one
 *    is not re-sent, no executor runs twice, and the session is re-advertised on
 *    the new socket.
 *  - AC5: `npm run typecheck` / `npm run lint` are the static gate — no test here.
 *
 * The D-section below is the FAULT-INJECTION leg of the Live Voice double-drop gap (journal
 * `e22ac831`), on the same real proxy, bridge and transport: the scripted endpoint is driven by the
 * journal`s own dial-by-dial plan, and D1–D6 read six properties that sequence has to keep. Five of
 * them are FALSE against the shipping code — each fails with the recorded signature and is wrapped in
 * `expectKnownDefect`, naming the task whose landing retires the wrapper
 * (`gap-live-voice-reconnect-epoch-scoped-commit-pairing`) — and D3 already holds, so it is asserted
 * directly.
 *
 * The AC3 mutant is a copy of the shipping transport written BESIDE it (its
 * relative imports resolve there), named with `__criterion-falsify-` so
 * `server/tsconfig.json` excludes it from the typecheck program — the same
 * convention the voice criteria's false forms use — and removed in a `finally`. A
 * closing case proves this process left none of its own copies behind.
 *
 * Provenance (goal record AC-311): this file is the one file the criterion names.
 * The server tree is TS-ESM — source imports use `.js` specifiers that resolve to
 * same-named `.ts` files — and Node's type-stripping does NOT remap `.js` → `.ts`,
 * so it MUST be run with THIS repo's runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <this file>
 *
 * Consumers: the quay worker's AC state for AC-311.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  connect,
  createDashscopeTransport,
  handleVoiceRealtimeConnection,
  REALTIME_TOOLS,
  VOICE_REALTIME_INSTRUCTIONS,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeTransport,
  type DashscopeTransportError,
  type DashscopeTransportOptions,
  type RealtimeBridgeError,
  type RealtimeToolExecutor,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
} from '../index.js';

import { readRealtimeTrace, type RealtimeTrace } from './voice-realtime-dashscope-harness.js';
import { expectKnownDefect } from './voice-realtime-known-defect.js';
import { waitFor } from './realtime-bridge-harness.js';
import {
  createScriptedUpstream,
  type ScriptedFaultPlan,
  type ScriptedProtocolOptions,
  type ScriptedUpstream,
} from './voice-realtime-scripted-upstream.js';

/** The preserved live capture the recorded race is extracted from. */
const TRACE_FILE = 'qwen38-omni-realtime-trace.json';
/** A key that is obviously not a real credential, so a leak would be unmistakable. */
const TEST_KEY = 'test-key-not-a-real-credential';
/** The session every proxy connection in this file is bound to (see the D-section's wiring). */
const BOUND_SESSION = 'session-under-test';

// ── the recorded race, extracted by predicate ─────────────────────────────────────────────────

/** One raw wire frame as the trace records it. */
type Wire = Record<string, unknown>;

/** The `response.id` a `response.created` / `response.done` frame carries, or `null`. */
function responseIdIn(wire: Wire): string | null {
  const response = wire.response as { id?: unknown } | undefined;
  return typeof response?.id === 'string' ? response.id : null;
}

/**
 * The frames of the recorded race, pulled out of the live trace by SHAPE.
 *
 * Named rather than indexed so the criterion says what it replays: a re-captured
 * trace that reordered or renumbered its exchange array cannot silently change
 * which frames are under test.
 */
type RecordedRace = {
  /** The endpoint's `response.created` for the response the raced tool call belongs to. */
  responseCreated: Wire;
  /** The tool call the model emitted inside that response. */
  functionCallArgumentsDone: Wire;
  /** The same call's `response.output_item.done` (the dialect's second delivery). */
  outputItemDone: Wire;
  /** The endpoint completing that same response. */
  responseDone: Wire;
  /** The endpoint acknowledging the tool result (`conversation.item.created`). */
  acknowledgedItem: Wire;
  /** The recorded `"Conversation already has an active response"` error frame. */
  conflictError: Wire;
  /** The endpoint's next `response.created` — it resumed on its own after the conflict. */
  laterResponseCreated: Wire;
  /** The id of the response the race happened inside. */
  responseId: string;
  /** The call id of the raced tool call. */
  callId: string;
};

/**
 * Reads the race out of the live trace, asserting every frame is present.
 *
 * The ordering assertions are the point: the error frame is recorded AFTER the
 * response it complains about was completed, so the absorption in the transport
 * cannot be conditioned on "a response is in flight" without missing it.
 */
function extractRecordedRace(trace: RealtimeTrace): RecordedRace {
  const received = trace.exchange.filter((entry) => entry.direction === 'received').map((entry) => entry.wire);

  const functionCallArgumentsDone = received.find(
    (wire) =>
      wire.type === 'response.function_call_arguments.done' &&
      wire.name === 'ui_visible_context' &&
      typeof wire.call_id === 'string',
  );
  assert.ok(functionCallArgumentsDone, 'the trace must record the model`s ui_visible_context call');
  const responseIdValue = functionCallArgumentsDone.response_id;
  const callIdValue = functionCallArgumentsDone.call_id;
  assert.equal(typeof responseIdValue, 'string', 'the recorded call must name the response it belongs to');
  assert.equal(typeof callIdValue, 'string', 'the recorded call must carry a call id');
  const responseId = responseIdValue as string;
  const callId = callIdValue as string;

  const responseCreated = received.find(
    (wire) => wire.type === 'response.created' && responseIdIn(wire) === responseId,
  );
  assert.ok(responseCreated, 'the trace must record the response.created the call belongs to');

  const outputItemDone = received.find(
    (wire) =>
      wire.type === 'response.output_item.done' &&
      (wire.item as { call_id?: unknown } | undefined)?.call_id === callId,
  );
  assert.ok(outputItemDone, 'the trace must record the call`s output_item.done delivery');

  const responseDone = received.find(
    (wire) => wire.type === 'response.done' && responseIdIn(wire) === responseId,
  );
  assert.ok(responseDone, 'the trace must record that response completing');

  const acknowledgedItem = received.find(
    (wire) =>
      wire.type === 'conversation.item.created' &&
      (wire.item as { type?: unknown; call_id?: unknown } | undefined)?.type === 'function_call_output' &&
      (wire.item as { call_id?: unknown } | undefined)?.call_id === callId,
  );
  assert.ok(acknowledgedItem, 'the trace must record the endpoint acknowledging the tool result');

  const conflictError = received.find(
    (wire) =>
      wire.type === 'error' &&
      /already has an active response/i.test(String((wire.error as { message?: unknown } | undefined)?.message)),
  );
  assert.ok(conflictError, 'the trace must record the "already has an active response" error frame');

  const laterResponseCreated = received.find(
    (wire) => wire.type === 'response.created' && responseIdIn(wire) !== responseId,
  );
  assert.ok(laterResponseCreated, 'the trace must record the endpoint resuming on its own afterwards');

  // The evidence the absorption rests on: the error arrives AFTER the response it
  // complains about had already completed, so "is a response in flight?" is the
  // wrong question to gate on.
  assert.ok(
    received.indexOf(conflictError) > received.indexOf(responseDone),
    'the recorded conflict error must land after the response it complains about',
  );

  return {
    responseCreated,
    functionCallArgumentsDone,
    outputItemDone,
    responseDone,
    acknowledgedItem,
    conflictError,
    laterResponseCreated,
    responseId,
    callId,
  };
}

// ── the in-test fake endpoint ─────────────────────────────────────────────────────────────────

/**
 * A fake realtime endpoint that reproduces the endpoint's side of the race.
 *
 * It tracks its OWN response lifecycle (fed by {@link RaceEndpoint.peerSend}, the
 * same way the real server would announce it) and, when a client `response.create`
 * arrives while it has a response in flight, it answers with the RECORDED error
 * frame verbatim. That is the mutation detector: the shipping transport's gate
 * keeps that create off the wire, so the endpoint never gets to emit the frame.
 *
 * It also acknowledges `conversation.item.created` for exactly the call ids it was
 * told to, which is what makes AC4's "acked once, unacked replayed" observable.
 */
type RaceEndpoint = {
  readonly socketFactory: DashscopeSocketFactory;
  /** Every client frame the transport sent, in order. */
  readonly sent: Wire[];
  /** Every server frame this endpoint emitted. */
  readonly emitted: Wire[];
  /** How many sockets the transport dialled. */
  readonly openCalls: number;
  /** The endpoint announcers a server frame (and updates its own view of the lifecycle). */
  peerSend(wire: Wire): void;
  /** The peer drops the socket — an UNEXPECTED close, the bridge's reconnect trigger. */
  dropSocket(): void;
  /** `response.create`s this endpoint received while it had a response in flight. */
  readonly prematureCreates: number;
  /** How many times it answered such a race with the recorded error frame. */
  readonly conflictFrames: number;
  /** Every client frame of one wire `type`. */
  framesOfType(type: string): Wire[];
};

function createRaceEndpoint(options: {
  /** The recorded error frame, answered verbatim to a premature `response.create`. */
  conflictError: Wire;
  /** Call ids the endpoint acknowledges with a `conversation.item.created`. */
  acknowledgedCallIds?: readonly string[];
}): RaceEndpoint {
  const sent: Wire[] = [];
  const emitted: Wire[] = [];
  const acknowledged = new Set<string>(options.acknowledgedCallIds ?? []);
  let socket: DashscopeSocket | null = null;
  let openCalls = 0;
  let responseInFlight = false;
  let prematureCreates = 0;
  let conflictFrames = 0;

  function emit(wire: Wire): void {
    emitted.push(wire);
    socket?.onmessage?.({ data: JSON.stringify(wire) });
  }

  /** The endpoint's answer to one client frame. */
  function react(frame: Wire): void {
    if (frame.type === 'response.create' && responseInFlight) {
      prematureCreates += 1;
      conflictFrames += 1;
      emit(options.conflictError);
      return;
    }
    if (frame.type === 'conversation.item.create') {
      const item = frame.item as { type?: unknown; call_id?: unknown } | undefined;
      if (item?.type === 'function_call_output' && typeof item.call_id === 'string' && acknowledged.has(item.call_id)) {
        emit({ type: 'conversation.item.created', item: { type: 'function_call_output', call_id: item.call_id } });
      }
    }
  }

  const socketFactory: DashscopeSocketFactory = () => {
    openCalls += 1;
    const active: DashscopeSocket = {
      send(data: string) {
        const frame = JSON.parse(data) as Wire;
        sent.push(frame);
        react(frame);
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
    // The transport attaches its handlers synchronously after the factory returns.
    queueMicrotask(() => active.onopen?.({}));
    return active;
  };

  return {
    socketFactory,
    sent,
    emitted,
    get openCalls(): number {
      return openCalls;
    },
    peerSend(wire: Wire): void {
      if (wire.type === 'response.created') responseInFlight = true;
      else if (wire.type === 'response.done') responseInFlight = false;
      emit(wire);
    },
    dropSocket(): void {
      socket?.onclose?.({ code: 1006, reason: 'fixture dropped the socket' });
    },
    get prematureCreates(): number {
      return prematureCreates;
    },
    get conflictFrames(): number {
      return conflictFrames;
    },
    framesOfType(type: string): Wire[] {
      return sent.filter((frame) => frame.type === type);
    },
  };
}

/** The shape the shipping (and copied) factory exposes. */
type CreateTransportFn = (options?: DashscopeTransportOptions) => DashscopeTransport;

// ── AC1: the named in-flight-response state, and the gate that consults it ────────────────────

test('AC1: the transport names the in-flight response and holds the resume behind it', async () => {
  const race = extractRecordedRace(readRealtimeTrace(TRACE_FILE));
  const endpoint = createRaceEndpoint({ conflictError: race.conflictError });
  const transport = createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: endpoint.socketFactory });
  const bridge = connect(transport, REALTIME_TOOLS, { ui_visible_context: () => ({ devices: [] }) }, {});
  await bridge.whenConnected();
  bridge.sendSessionUpdate('go');

  // Idle to start with: nothing in flight, nothing held.
  assert.deepEqual(transport.responseConcurrency, { activeResponseId: null, deferredResponseCreates: 0 });

  // The endpoint starts a response (its server VAD can do this at any moment).
  endpoint.peerSend(race.responseCreated);
  assert.equal(transport.responseConcurrency.activeResponseId, race.responseId);

  // The tool result is resolved while that response is in flight. The item is sent;
  // the synthesized `response.create` is HELD — no resume may race the endpoint.
  endpoint.peerSend(race.functionCallArgumentsDone);
  assert.equal(transport.responseConcurrency.deferredResponseCreates, 1, 'the resume must be held');
  assert.equal(endpoint.framesOfType('conversation.item.create').length, 1, 'the tool result itself is not held');
  assert.equal(endpoint.framesOfType('response.create').length, 0, 'the resume must not have reached the wire');

  // The response completes: the state clears and the held resume flushes, exactly once.
  endpoint.peerSend(race.responseDone);
  assert.deepEqual(transport.responseConcurrency, { activeResponseId: null, deferredResponseCreates: 0 });
  assert.equal(endpoint.framesOfType('response.create').length, 1, 'the held resume flushes exactly once');

  await bridge.close();
});

// ── AC2 + AC3: the recorded error frame, fed to the new path and to a mutant ──────────────────

/** What one replay of the recorded race produced. */
type RaceReading = {
  /** Labels for feeds whose delivery threw — anything here is an uncaught escape. */
  escaped: string[];
  transportState: string;
  bridgeState: string;
  /** Premature `response.create`s the endpoint received (the race itself). */
  prematureCreates: number;
  /** The recorded error frames the ENDPOINT had to emit (the red AC3 reads). */
  conflictFrames: number;
  /** The recorded error frame the transport attributed and absorbed. */
  absorbedConflicts: number;
  /** The `eventType` of every unknown event the bridge saw — an absorbed race must not appear. */
  bridgeUnknownEvents: string[];
  /** `response.create`s the endpoint received in total. */
  responseCreatesSent: number;
};

/**
 * Replays the recorded race over one transport implementation.
 *
 * The order is the trace's own: the endpoint starts a response, the model calls the
 * tool, the transport synthesizes the resume, the response completes, the endpoint
 * acknowledges the result, and THEN the recorded error frame arrives. A drop-free
 * replay, so `bridgeState === 'open'` at the end means the race did not kill the
 * connection.
 */
async function replayRecordedRace(
  createTransport: CreateTransportFn,
  race: RecordedRace,
): Promise<RaceReading> {
  const endpoint = createRaceEndpoint({ conflictError: race.conflictError });
  const transportErrors: DashscopeTransportError[] = [];
  const bridgeErrors: RealtimeBridgeError[] = [];
  const transport = createTransport({
    apiKey: TEST_KEY,
    socketFactory: endpoint.socketFactory,
    onError: (error) => transportErrors.push(error),
  });
  const bridge = connect(transport, REALTIME_TOOLS, { ui_visible_context: () => ({ devices: [] }) }, {
    hooks: { onError: (error) => bridgeErrors.push(error) },
  });
  await bridge.whenConnected();
  bridge.sendSessionUpdate('go');

  const escaped: string[] = [];
  const feed = (label: string, wire: Wire): void => {
    try {
      endpoint.peerSend(wire);
    } catch {
      escaped.push(label);
    }
  };

  feed('response.created', race.responseCreated);
  feed('response.function_call_arguments.done', race.functionCallArgumentsDone);
  feed('response.output_item.done', race.outputItemDone);
  feed('response.done', race.responseDone);
  feed('conversation.item.created', race.acknowledgedItem);
  feed('error', race.conflictError);
  feed('later response.created', race.laterResponseCreated);

  const reading: RaceReading = {
    escaped,
    transportState: transport.state,
    bridgeState: bridge.state,
    prematureCreates: endpoint.prematureCreates,
    conflictFrames: endpoint.conflictFrames,
    absorbedConflicts: transportErrors.filter((error) => error.code === 'RESPONSE_CONCURRENCY_CONFLICT').length,
    bridgeUnknownEvents: bridgeErrors
      .filter((error): error is Extract<RealtimeBridgeError, { code: 'UNKNOWN_EVENT' }> => error.code === 'UNKNOWN_EVENT')
      .map((error) => error.eventType),
    responseCreatesSent: endpoint.framesOfType('response.create').length,
  };
  await bridge.close();
  return reading;
}

test('AC2: the recorded "already has an active response" frame is absorbed, not fatal', async () => {
  const race = extractRecordedRace(readRealtimeTrace(TRACE_FILE));

  // The extraction is only meaningful if this really is the race being replayed: the
  // error frame is recorded after the response it complains about completed.
  assert.match(String((race.conflictError.error as { message?: unknown }).message), /already has an active response/i);

  const reading = await replayRecordedRace(createDashscopeTransport, race);

  assert.deepEqual(reading.escaped, [], 'nothing may escape uncaught');
  assert.equal(reading.transportState, 'open', 'the transport must survive the recorded race');
  assert.equal(reading.bridgeState, 'open', 'the bridge must survive the recorded race');
  assert.equal(reading.prematureCreates, 0, 'the transport must not let a resume race the in-flight response');
  assert.equal(reading.conflictFrames, 0, 'so the endpoint never has to reproduce the recorded error frame');
  assert.equal(reading.absorbedConflicts, 1, 'the recorded error frame must be attributed and absorbed');
  assert.equal(reading.responseCreatesSent, 1, 'the resume is held then flushed — exactly once');
  assert.ok(
    !reading.bridgeUnknownEvents.includes('error'),
    'the race must be absorbed by the transport, never surfaced to the bridge as an unexplained event',
  );
});

// ── the AC3 mutant ────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping transport: what the AC3 mutation copies. */
const SHIPPING_TRANSPORT_MODULE = path.join(MODULE_DIR, 'voice-realtime-dashscope-transport.ts');
/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Imports a transport module by path. The specifier is dynamic, so TS types it structurally here. */
async function importTransport(modulePath: string): Promise<CreateTransportFn> {
  const module = (await import(pathToFileURL(modulePath).href)) as { createDashscopeTransport: CreateTransportFn };
  return module.createDashscopeTransport;
}

/**
 * The anchor: the line that records the endpoint's in-flight response.
 *
 * Removing the state tracking means this assignment no longer STICKS — the gate in
 * `sendClientFrames` then never holds a resume back.
 */
const TRACK_ANCHOR = '        activeResponseId = responseIdIn(event);';
/** The mutation: the in-flight state is never recorded, so the gate is inert. */
const TRACK_DROPPED = '        activeResponseId = null;';

test('AC3 false form: removing the state tracking makes the replay red on that error frame', async () => {
  const race = extractRecordedRace(readRealtimeTrace(TRACE_FILE));
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, TRACK_ANCHOR), 1, 'the tracking anchor must occur exactly once');

  const basePath = ownCopy('no-response-tracking-base');
  const mutPath = ownCopy('no-response-tracking-mut');
  const mutated = source.replace(TRACK_ANCHOR, TRACK_DROPPED);
  assert.notEqual(mutated, source, 'the mutation must actually change the source');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, mutated, 'utf8');
    const base = await importTransport(basePath);
    const mutant = await importTransport(mutPath);

    // Unmutated: the same replay the AC2 reading asserts — green.
    const green = await replayRecordedRace(base, race);
    assert.equal(green.prematureCreates, 0);
    assert.equal(green.conflictFrames, 0);
    assert.equal(green.transportState, 'open');

    // Mutated: the resume reaches the endpoint while it has a response in flight, so
    // the endpoint reproduces the recorded error frame — the AC2 reading reddens HERE.
    const red = await replayRecordedRace(mutant, race);
    assert.equal(red.prematureCreates, 1, 'with the state tracking gone the resume races the in-flight response');
    assert.equal(red.conflictFrames, 1, 'and the endpoint answers with the recorded error frame');
    assert.notEqual(red.conflictFrames, green.conflictFrames, 'the reading must discriminate the two');
    // Even then the frame is still ABSORBED (that half of the fix is untouched): the
    // red is the race reappearing, not a crash — which is exactly what the state
    // tracking exists to prevent.
    assert.equal(red.transportState, 'open');
    assert.equal(red.absorbedConflicts, 2, 'the fed frame plus the one the endpoint had to emit');
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC4: a reconnect resumes the same logical session ─────────────────────────────────────────

test('AC4: a reconnect replays the unacknowledged tool result once, and re-advertises the session', async () => {
  const race = extractRecordedRace(readRealtimeTrace(TRACE_FILE));
  // The endpoint acknowledges `call_A` only: `call_B` stays unacknowledged across the drop.
  const endpoint = createRaceEndpoint({ conflictError: race.conflictError, acknowledgedCallIds: ['call_A'] });
  const transport = createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: endpoint.socketFactory });
  const ran: string[] = [];
  const executor: RealtimeToolExecutor = {
    ui_visible_context: (args) => {
      ran.push(String(args.client));
      return { devices: [] };
    },
  };
  const bridge = connect(transport, REALTIME_TOOLS, executor, { maxConnectAttempts: 3 });
  await bridge.whenConnected();
  bridge.sendSessionUpdate('session config v1');

  const call = (callId: string, client: string): Wire => ({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name: 'ui_visible_context',
    arguments: JSON.stringify({ client }),
  });

  // Two tool results on the wire: A is acknowledged by the endpoint, B is not.
  endpoint.peerSend(call('call_A', 'A'));
  endpoint.peerSend(call('call_B', 'B'));
  assert.deepEqual(ran, ['A', 'B'], 'each call runs its executor exactly once');
  assert.equal(endpoint.framesOfType('session.update').length, 1);

  // The socket drops. The bridge reconnects on its own.
  endpoint.dropSocket();
  await waitFor(() => bridge.state === 'open' && endpoint.openCalls === 2);

  // …and resumes the SAME logical session: the acknowledged result is NOT re-sent,
  // the unacknowledged one IS — once — and the session is re-advertised on the new socket.
  const itemCreates = endpoint.framesOfType('conversation.item.create');
  const createsFor = (callId: string): number =>
    itemCreates.filter((frame) => (frame.item as { call_id?: unknown }).call_id === callId).length;
  assert.equal(createsFor('call_A'), 1, 'an acknowledged result must never be replayed');
  assert.equal(createsFor('call_B'), 2, 'an unacknowledged result is sent, then replayed exactly once after the drop');
  assert.deepEqual(ran, ['A', 'B'], 'a replay must not make the executor process a result twice');

  const sessionUpdates = endpoint.framesOfType('session.update');
  assert.equal(sessionUpdates.length, 2, 'the new socket must be told what the session is');
  const readvertised = sessionUpdates[1].session as { instructions?: unknown; tools?: unknown[] };
  assert.equal(readvertised.instructions, 'session config v1', 'the advertised instructions must be the caller`s own');
  assert.equal(readvertised.tools?.length, REALTIME_TOOLS.length, 'and the tool declarations must come back with them');

  await bridge.close();
});

// ── D1–D6: the 2026-10-12 double drop, replayed offline ───────────────────────────────────────
//
// WHAT THIS SECTION IS. The 2026-10-12 journal (`e22ac831`) is a real session's whole lifecycle, and
// it is the sequence every reading below is written against:
//
//     seq0  delivered.                          seq1  the endpoint reported NO WORDS for it
//     seq2  commit, then CONNECTION_LOST with the commit in flight; the reconnect REPLAYED it and
//           the second dial lost every event it was told, then dropped 1.15 s later; the replay is
//           suppressed (a segment is replayed once), so seq2 was never transcribed at all.
//     seq3  delivered.                          seq4  empty, but reported as "segment 2 dropped".
//     seq5  delivered.                          seq6  the third loss exhausted the reconnect
//                                                     budget, and the connection closed for good.
//     seq7–12  `segment_ack committed` for every one of them, with NOTHING on the wire.
//
// Six readings are taken from ONE scenario built out of that sequence — the REAL bridge, the REAL
// transport and the REAL ws proxy, with the scripted stand-in's fault plan (`F1`–`F6`) as the
// endpoint and an in-process EventEmitter as the browser. Five of them (D1, D2, D4, D5, D6) describe
// defects that are STILL SHIPPING, so each is wrapped in `expectKnownDefect` against the task that
// owns the fix; D3 is green against today's code and is asserted directly.
//
// WHY A KNOWN DEFECT AND NOT A PLAIN FAILING ASSERTION. See `voice-realtime-known-defect.ts`: a
// criterion for the EVIDENCE has to state something currently false, and the wrapper is what keeps
// that statement from being indistinguishable from a broken test — in both directions.

/** The task whose landing should retire every known-defect wrapper below. */
const FIX_TASK = 'gap-live-voice-reconnect-epoch-scoped-commit-pairing';

/**
 * The browser socket, with a hook the readings can snapshot from.
 *
 * `onSend` runs BEFORE the frame is recorded, which is what makes D6's reading possible: the number
 * of commits the endpoint had answered is a fact about the moment THIS frame was written, and it is
 * gone by the time the scenario can look.
 */
class ScriptedBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  onSend: ((frame: VoiceRealtimeOutboundFrame) => void) | null = null;

  send(data: string): void {
    const frame = JSON.parse(data) as VoiceRealtimeOutboundFrame;
    this.onSend?.(frame);
    this.outbound.push(frame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
}

/** A `segment_ack` frame, as the readings narrow on it. */
type AckFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }>;
/** A final `caption` frame. */
type CaptionFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }>;

/** What one scripted connection exposes to a D-scenario. */
type ScriptedWire = {
  readonly socket: ScriptedBrowserSocket;
  readonly upstream: ScriptedUpstream;
  /** Every `session_send` a model call actually reached the executor with, in order. */
  readonly calls: Array<Record<string, unknown>>;
  /** Hands one browser frame to the proxy, exactly as the page`s socket would. */
  fromBrowser(frame: VoiceRealtimeInboundFrame): void;
  /** Speaks segment `seq`: open it, one PCM frame, close it. */
  speak(seq: number): void;
  /** Whether the connection was said to be `open` at ANY point. */
  opened(): boolean;
  /** The connection`s state as the page last read it, or `undefined` before any state frame. */
  state(): string | undefined;
  /** Every `segment_ack` the page was sent, in order. */
  acks(): AckFrame[];
  /** The `seq` of every FINAL caption, in the order the page received them. */
  captionSeqs(): Array<number | null>;
  /** For each `committed` ack, how many upstream `input_audio_buffer.committed` it had behind it. */
  readonly commitsBehindEachCommittedAck: number[];
  /** Lets every held tool call finish, so nothing is left awaiting at teardown (see `holdToolCalls`). */
  releaseToolCalls(): void;
  close(): Promise<void>;
};

/**
 * The two things a REAL socket does that the in-process stand-in does not, modelled in one place: it
 * delivers an inbound frame a turn LATER, and it is DEAD once it has closed.
 *
 * WHY THE DELAY. `createScriptedUpstream` answers a client frame SYNCHRONOUSLY inside `send`, so the
 * endpoint`s event is dispatched while the writer is still inside its own `transport.send(...)` call.
 * A real socket answers a round trip later. That difference is load-bearing for every reading below:
 * `writeSegmentClose` writes the commit and only THEN pushes the segment`s `seq` onto
 * `pendingCommitSeqs`, so under a synchronous answer the endpoint`s own
 * `input_audio_buffer.committed` is paired BEFORE the `seq` is on the queue — `shift()` finds
 * nothing, every item id pairs with `null`, no item id can be attributed to a `seq`, and the
 * cross-epoch mis-attribution these scenarios exist to pin is unobservable. One microtask of
 * delivery latency restores the order a socket has.
 *
 * WHY THE DEAD WRITE. The stand-in answers whatever is written to it, whenever it is written —
 * including the frames a dying dial was still closing, which a real socket discards and the endpoint
 * behind it never sees. No reading below waits on those answers, so this half is fidelity rather than
 * load-bearing: it is here because the alternative is an endpoint answering a request that no live
 * connection ever carried, and a scenario that later DOES read one of those answers would be reading
 * a fiction.
 *
 * Neither model changes what the scenario ARMS; both are properties of the transport`s socket, which
 * is why they live here rather than in the stand-in every other criterion reads.
 */
function instrumentEndpoint(factory: DashscopeSocketFactory): DashscopeSocketFactory {
  return (url, headers) => {
    const raw = factory(url, headers);
    let closed = false;
    let inbound: DashscopeSocket['onmessage'] = null;
    let onClose: DashscopeSocket['onclose'] = null;
    const rawSend = raw.send.bind(raw);
    const rawClose = raw.close.bind(raw);
    // The stand-in emits as the endpoint, so its emissions take the delay rather than the write.
    raw.onmessage = (event) => {
      const handler = inbound;
      if (handler !== null) queueMicrotask(() => handler(event));
    };
    raw.onclose = (event) => {
      closed = true;
      onClose?.(event);
    };
    return {
      send: (data) => {
        if (closed) return;
        rawSend(data);
      },
      close: (code, reason) => rawClose(code, reason),
      get onopen() {
        return raw.onopen;
      },
      set onopen(handler) {
        raw.onopen = handler;
      },
      get onmessage() {
        return inbound;
      },
      set onmessage(handler) {
        inbound = handler;
      },
      get onerror() {
        return raw.onerror;
      },
      set onerror(handler) {
        raw.onerror = handler;
      },
      get onclose() {
        return onClose;
      },
      set onclose(handler) {
        onClose = handler;
      },
      get bufferedAmount() {
        return raw.bufferedAmount;
      },
    };
  };
}

/**
 * Wires one browser connection over the real proxy, the real bridge and the real transport, against
 * the scripted endpoint.
 *
 * `segmentCommit: 'manual'` and `segmentedRelay: true` are the segmented relay`s own two seams, set
 * the way a criterion sets them (a deployment sets them from the environment); everything else is
 * the shipping default.
 */
function connectScriptedWire(options: {
  protocol: ScriptedProtocolOptions;
  faults?: ScriptedFaultPlan;
  transcriptGraceMs?: number;
  /** Hold every tool call in flight until {@link ScriptedWire.releaseToolCalls} — see D3. */
  holdToolCalls?: boolean;
}): ScriptedWire {
  const socket = new ScriptedBrowserSocket();
  const upstream = createScriptedUpstream({
    protocol: options.protocol,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  const calls: Array<Record<string, unknown>> = [];
  /** Resolvers of the tool calls a scenario asked to hold in flight (see `holdToolCalls`). */
  const heldToolCalls: Array<() => void> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push(args);
      // A session dispatch takes real time: the call is still running when the dial dies, so its
      // result never reaches the endpoint. Held only where a scenario asks for it — see D3.
      if (options.holdToolCalls === true) {
        await new Promise<void>((resolve) => heldToolCalls.push(resolve));
      }
      return { runId: 'run-scripted', queued: false };
    },
  };
  const commitsBehindEachCommittedAck: number[] = [];
  socket.onSend = (frame) => {
    if (frame.type !== 'segment_ack' || frame.state !== 'committed') return;
    commitsBehindEachCommittedAck.push(
      upstream.endpointFrames.filter((emitted) => emitted.type === 'input_audio_buffer.committed').length,
    );
  };

  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    createTransport: (report) =>
      createDashscopeTransport({
        apiKey: TEST_KEY,
        socketFactory: instrumentEndpoint(upstream.socketFactory),
        onError: report,
      }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    segmentCommit: 'manual',
    segmentedRelay: true,
    ...(options.transcriptGraceMs === undefined ? {} : { transcriptGraceMs: options.transcriptGraceMs }),
  });

  const stateFrames = (): Array<Extract<VoiceRealtimeOutboundFrame, { type: 'state' }>> =>
    socket.outbound.filter(
      (frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'state' }> => frame.type === 'state',
    );
  const acks = (): AckFrame[] =>
    socket.outbound.filter((frame): frame is AckFrame => frame.type === 'segment_ack');

  return {
    socket,
    upstream,
    calls,
    fromBrowser: (frame) => socket.emit('message', JSON.stringify(frame)),
    speak(seq) {
      // Distinct audio per `seq`, so a replay is recognizable as one and D3`s drop-on-replay
      // fingerprint has something to recognize.
      const audio = Buffer.from([seq & 0xff, (seq >> 8) & 0xff, 7, 7]).toString('base64');
      socket.emit('message', JSON.stringify({ type: 'segment_start', seq, startedAtMs: seq * 1000 }));
      socket.emit('message', JSON.stringify({ type: 'audio', audio, seq }));
      socket.emit('message', JSON.stringify({ type: 'segment_end', seq, durationMs: 800 }));
    },
    opened: () => stateFrames().some((frame) => frame.state === 'open'),
    state: () => stateFrames()[stateFrames().length - 1]?.state,
    acks,
    captionSeqs: () =>
      socket.outbound
        .filter((frame): frame is CaptionFrame => frame.type === 'caption' && frame.final)
        .map((frame) => frame.seq),
    commitsBehindEachCommittedAck,
    releaseToolCalls() {
      for (const resolve of heldToolCalls.splice(0)) resolve();
    },
    async close() {
      socket.close();
      await settle();
    },
  };
}

/** Lets every delivery the last frame started run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Waits until `predicate` holds, or `timeoutMs` passes.
 *
 * The bounded wait a D-scenario needs where the connection may EITHER recover (the reading) or give
 * up (the defect): both are answers, and only one of them is a green one, so waiting for the
 * recovery alone would turn a connection that never came back into a timeout instead of a reading.
 */
async function settleUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** How many `input_audio_buffer.commit` frames the app has put on the wire, across every dial. */
function commitsOnTheWire(wire: ScriptedWire): number {
  return wire.upstream.clientFrames.filter((frame) => frame.type === 'input_audio_buffer.commit').length;
}

/** How many `function_call` frames the endpoint has said, across every dial. */
function callsOnTheWire(wire: ScriptedWire): number {
  return wire.upstream.endpointFrames.filter((frame) => frame.type === 'response.function_call_arguments.done').length;
}

/** The verdicts the page was given for one `seq`, as `<state>` or `<state>:<reason>` labels. */
function verdictsFor(wire: ScriptedWire, seq: number): string[] {
  return wire.acks()
    .filter((ack) => ack.seq === seq)
    .map((ack) => (ack.reason === undefined ? ack.state : `${ack.state}:${ack.reason}`));
}

// ── the known-defect wrapper`s own three branches ─────────────────────────────────────────────

test('expectKnownDefect: a scenario failing with the recorded signature passes', async () => {
  await expectKnownDefect(
    () => {
      throw new Error('segment 2 dropped: the endpoint reported no words for it');
    },
    { fixTask: FIX_TASK, signature: 'segment 2 dropped: the endpoint reported no words for it' },
  );
});

test('expectKnownDefect: a scenario failing any other way is `unexpected failure signature`', async () => {
  await assert.rejects(
    expectKnownDefect(
      () => {
        throw new Error('third commit arrived while the endpoint was not answering');
      },
      { fixTask: FIX_TASK, signature: 'segment 2 dropped: the endpoint reported no words for it' },
    ),
    /unexpected failure signature/,
  );
});

test('expectKnownDefect: a scenario that stops failing is `defect no longer reproduces`', async () => {
  await assert.rejects(
    expectKnownDefect(() => undefined, {
      fixTask: FIX_TASK,
      signature: 'segment 2 dropped: the endpoint reported no words for it',
    }),
    /defect no longer reproduces/,
  );
});

// ── the one scenario D1 and D2 read ───────────────────────────────────────────────────────────

/**
 * The journal`s own double drop, as a scenario: three segments on dial #1, its third commit dropped
 * BEFORE it is answered; the reconnect replays that segment on dial #2, which is told nothing (its
 * events are lost) and dropped 1.15 s later; dial #3 is where the user`s next three segments are
 * spoken.
 *
 * ONE protocol config serves all three dials, because the machine is rebuilt per dial: dial #1 reads
 * it as seq0/seq1/seq2 and dial #3 (a fresh machine) reads the SAME three entries as seq3/seq4/seq5 —
 * which is exactly the shape of the journal, where the two adjacent segments after the drop carry
 * the same pair of transcripts.
 */
async function doubleDropScenario(): Promise<ScriptedWire> {
  const wire = connectScriptedWire({
    protocol: {
      // The bridge takes the endpoint`s own detector OFF for the segmented wire, and a machine that
      // started with it ON would refuse every manual commit.
      initialTurnDetection: null,
      commits: [
        { itemId: 'item_0', transcript: { kind: 'on-time', text: '第一段' } },
        { itemId: 'item_1', transcript: { kind: 'on-time', text: '' } },
        { itemId: 'item_2', transcript: { kind: 'on-time', text: '第三段' } },
      ],
    },
    faults: {
      dials: [
        // dial #1 — the third commit arrives and the endpoint never answers it: the socket is gone
        // (the journal`s 54.991 → 55.195 ms pair).
        { dropBeforeCommit: 3 },
        // dial #2 — the replay is PROCESSED and answered with nothing, and the endpoint drops the
        // socket 1.15 s later (the journal`s second CONNECTION_LOST, 1.15 s after the first).
        { loseEventsOfCommit: 1, dropAfterCommitMs: { ordinal: 1, ms: 1150 } },
        // dial #3 — ordinary: the user`s next three segments are spoken here.
        {},
      ],
    },
    transcriptGraceMs: 25,
  });

  await waitFor(() => wire.opened());
  // ONE SEGMENT AT A TIME, each settled before the next: a real session speaks its segments seconds
  // apart, so every delivery a segment starts has landed before the next one begins. Speaking them
  // back to back would instead leave a segment`s `response.done` in flight while the next segment
  // has already claimed `committedSegment` — a stale completion clearing a LIVE segment`s marker,
  // which is a real hazard of the synchronous stand-in and not the reading these scenarios are for.
  for (const seq of [0, 1, 2]) {
    wire.speak(seq);
    await waitFor(() => commitsOnTheWire(wire) === seq + 1, 3_000);
    await settle();
  }
  // The replay is the only commit dial #2 receives; its drop is on the INJECTED clock, so the
  // scenario says when the 1.15 s have passed rather than waiting for them.
  await waitFor(() => commitsOnTheWire(wire) === 4, 3_000);
  wire.upstream.tick(1150);
  await waitFor(() => wire.upstream.faults.dials() === 3, 3_000);
  for (const seq of [3, 4, 5]) {
    // `dials()` counts an ATTEMPTED dial; the socket is not writable until the bridge has opened it,
    // and a segment closed in between is silently dropped by `writeSegmentClose` (the proxy does not
    // wait for the bridge). The state is what says the new socket is ready for them.
    await waitFor(() => wire.state() === 'open', 3_000);
    wire.speak(seq);
    await waitFor(() => commitsOnTheWire(wire) === seq + 2, 3_000);
    await settle();
  }
  return wire;
}

// ── D1: seq2`s fate must not be the empty-transcript verdict ──────────────────────────────────

/**
 * The signature D1 fails with today — and the assert`s own message, so the scenario failing any
 * OTHER way (a throw, a timeout, a different assert) is reported as an unexpected signature instead
 * of being read as this defect.
 */
const D1_SIGNATURE =
  'seq2 must not be answered `dropped:empty-transcript`: its commit was lost with the socket on dial #1, and no dial ever transcribed it';

test('D1 seq2 is not answered `dropped:empty-transcript` for a commit lost with the socket', async () => {
  await expectKnownDefect(
    async () => {
      const wire = await doubleDropScenario();
      try {
        const verdicts = verdictsFor(wire, 2);
        // The AC`s other half: losing a segment must be REPORTED, not merely not-mis-reported. A fix
        // that keeps the epoch pairing honest but leaves seq2 with nothing to say would leave the
        // page waiting on a segment that can never arrive.
        assert.ok(
          verdicts.length > 0,
          'seq2 must be given an explicit undelivered/lost disposition: the page is owed the fate of a segment whose commit died with the socket',
        );
        assert.deepEqual(verdicts.filter((verdict) => verdict === 'dropped:empty-transcript'), [], D1_SIGNATURE);
      } finally {
        await wire.close();
      }
    },
    {
      fixTask: FIX_TASK,
      signature: D1_SIGNATURE,
      note: 'journal e22ac831: the 1.15 s dial lost every event, the replay is suppressed, so seq2 was never transcribed — yet the page is told its words were empty',
    },
  );
});

// ── D2: no caption may be attributed to another epoch`s seq ───────────────────────────────────

/** The signature D2 fails with today — the same constant is the assert`s message, by construction. */
const D2_SIGNATURE =
  'the six final transcripts must land on seqs 0-5: seq4`s empty one landed on seq2, which is what makes the journal report "segment 2 dropped"';

test('D2 the six final transcripts land on their own seqs, never across the reconnect', async () => {
  await expectKnownDefect(
    async () => {
      const wire = await doubleDropScenario();
      try {
        assert.deepEqual(wire.captionSeqs(), [0, 1, 2, 3, 4, 5], D2_SIGNATURE);
      } finally {
        await wire.close();
      }
    },
    {
      fixTask: FIX_TASK,
      signature: D2_SIGNATURE,
      note: 'journal e22ac831: dial #1 left its third commit in pendingCommitSeqs, dial #2`s replay pushed it again, so dial #3`s commits shifted the WRONG seqs and seq4`s empty transcript was attributed to seq2',
    },
  );
});

// ── D3: the replay`s second call must not be delivered (green today — asserted directly) ──────

/**
 * The one D-reading that is GREEN against today`s code, and the only one asserted directly: the
 * transport already refuses to hand the bridge a call id it has delivered (the replay mints the
 * same id, because the reconnected dial`s machine starts its own response numbering over). What this
 * asserts is therefore the property, not the mechanism: however the suppression is achieved, the
 * session must not receive one utterance`s instruction twice.
 *
 * THE TOOL CALL IS HELD IN FLIGHT (`holdToolCalls`), because that is the only way the replay is
 * reached at all: the dial dies while the session dispatch is still running, so the tool result for
 * the call never reaches the endpoint — and it is the endpoint`s `response.done` for that result
 * that would otherwise SETTLE the committed segment and leave the reconnect with nothing to replay.
 * A call that resolved instantly would therefore read green about a sequence the defect cannot even
 * produce, which is the vacuity the non-vacuity wait below exists to rule out.
 */
test('D3 a tool call the dropped dial already delivered is not delivered again by the replay', async () => {
  const wire = connectScriptedWire({
    protocol: {
      initialTurnDetection: null,
      commits: [
        {
          itemId: 'item_0',
          transcript: { kind: 'on-time', text: '把超时改成三十秒' },
          answer: { kind: 'function_call', name: 'session_send', args: { message: '把超时改成三十秒' } },
        },
      ],
    },
    // F3`s second shape: dial #1 answers up to and including the model`s call and THEN dies, so the
    // call really was delivered and the reconnect really does replay the segment it came from.
    faults: { dials: [{ dropAfterFunctionCall: true }] },
    transcriptGraceMs: 25,
    holdToolCalls: true,
  });
  try {
    await waitFor(() => wire.opened());
    wire.speak(0);
    await settle();
    // Non-vacuity first: the endpoint must have said the call ONCE PER DIAL — otherwise there is no
    // second delivery to suppress and the reading below would be green about nothing.
    await waitFor(() => callsOnTheWire(wire) === 2 && wire.upstream.faults.dials() === 2, 3_000);
    await waitFor(() => wire.calls.length === 1, 3_000);
    assert.equal(
      wire.calls.length,
      1,
      'the replay of a segment whose tool call was already delivered must not deliver it a second time',
    );
  } finally {
    wire.releaseToolCalls();
    await wire.close();
  }
});

// ── D4: three independent drops, each reconnected ─────────────────────────────────────────────

/** The signature D4 fails with today. */
const D4_SIGNATURE =
  'three independent drops must each be reconnected: the reconnect budget is spent per connection, not carried across the whole session';

test('D4 three independent drops each reconnect (the budget is per connection, not per session)', async () => {
  await expectKnownDefect(
    async () => {
      const wire = connectScriptedWire({ protocol: { initialTurnDetection: null }, faults: { dials: [] } });
      try {
        await waitFor(() => wire.opened());
        for (let drop = 1; drop <= 3; drop += 1) {
          wire.upstream.drop();
          // Either it comes back (the reading) or it gives up (the defect); both are bounded.
          await settleUntil(() => wire.state() === 'open' || wire.state() === 'closed');
        }
        assert.equal(wire.upstream.faults.dials(), 4, D4_SIGNATURE);
      } finally {
        await wire.close();
      }
    },
    {
      fixTask: FIX_TASK,
      signature: D4_SIGNATURE,
      note: 'journal e22ac831: the session survived two drops, and the THIRD one exhausted a budget that counted every dial the session had ever made instead of the ones this connection has needed',
    },
  );
});

// ── D5: nothing may be answered `committed` once the upstream is gone ─────────────────────────

/** The signature D5 fails with today. */
const D5_SIGNATURE =
  'a segment closed after the reconnect budget is spent must not be answered `committed`: nothing about it reached the endpoint';

test('D5 a segment closed after the reconnect budget is spent is not answered `committed`', async () => {
  await expectKnownDefect(
    async () => {
      const wire = connectScriptedWire({
        protocol: { initialTurnDetection: null },
        faults: { dials: [{}, { disposition: { action: 'refuse' } }, { disposition: { action: 'refuse' } }] },
      });
      try {
        await waitFor(() => wire.opened());
        // One real drop, then two dials the endpoint refuses: the budget is spent and the bridge
        // settles on `closed` — while the PAGE`s socket is still open, which is what makes this
        // reading possible at all.
        wire.upstream.drop();
        await settleUntil(() => wire.state() === 'closed', 3_000);
        assert.equal(wire.state(), 'closed', 'the scenario needs the connection to have given up');
        const spoken = [10, 11, 12];
        for (const seq of spoken) wire.speak(seq);
        await settle();
        const committed = wire
          .acks()
          .filter((ack) => ack.state === 'committed' && spoken.includes(ack.seq))
          .map((ack) => ack.seq);
        assert.deepEqual(committed, [], D5_SIGNATURE);
      } finally {
        await wire.close();
      }
    },
    {
      fixTask: FIX_TASK,
      signature: D5_SIGNATURE,
      note: 'journal e22ac831: after the third loss the connection was closed for good, and seqs 7-12 were each answered `segment_ack committed` with nothing on the wire',
    },
  );
});

// ── D6: `committed` may only be answered behind the endpoint`s own commit ─────────────────────

/** The signature D6 fails with today. */
const D6_SIGNATURE =
  'a manual-mode segment may be answered `committed` only behind the endpoint`s own input_audio_buffer.committed for it';

test('D6 `segment_ack committed` follows the endpoint`s own `input_audio_buffer.committed`', async () => {
  await expectKnownDefect(
    async () => {
      const wire = connectScriptedWire({
        protocol: {
          initialTurnDetection: null,
          commits: [
            { itemId: 'item_0', transcript: { kind: 'on-time', text: '第一段' } },
            { itemId: 'item_1', transcript: { kind: 'on-time', text: '第二段' } },
            { itemId: 'item_2', transcript: { kind: 'on-time', text: '第三段' } },
          ],
        },
        // The third commit never reaches the endpoint`s answer path: it dies with the socket.
        faults: { dials: [{ dropBeforeCommit: 3 }] },
        transcriptGraceMs: 25,
      });
      try {
        await waitFor(() => wire.opened());
        wire.speak(0);
        wire.speak(1);
        wire.speak(2);
        await settle();
        // Each `committed` ack owes at least one more upstream commit than the acks before it: the
        // nth ack is only earned by the nth commit the endpoint actually answered.
        const uncovered = wire.commitsBehindEachCommittedAck
          .map((commits, index) => (commits <= index ? index : -1))
          .filter((index) => index >= 0);
        assert.deepEqual(uncovered, [], D6_SIGNATURE);
      } finally {
        await wire.close();
      }
    },
    {
      fixTask: FIX_TASK,
      signature: D6_SIGNATURE,
      note: 'journal e22ac831: seqs 7-12 were acked `committed` while the connection had no upstream at all; the ack is sent from the close path, which never checks what the endpoint answered',
    },
  );
});

// ── residue ───────────────────────────────────────────────────────────────────────────────────

test('the AC3 false form leaves none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
