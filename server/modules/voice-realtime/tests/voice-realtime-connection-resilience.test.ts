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
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  connect,
  createDashscopeTransport,
  REALTIME_TOOLS,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type DashscopeTransport,
  type DashscopeTransportError,
  type DashscopeTransportOptions,
  type RealtimeBridgeError,
  type RealtimeToolExecutor,
} from '../index.js';

import { readRealtimeTrace, type RealtimeTrace } from './voice-realtime-dashscope-harness.js';
import { waitFor } from './realtime-bridge-harness.js';

/** The preserved live capture the recorded race is extracted from. */
const TRACE_FILE = 'qwen38-omni-realtime-trace.json';
/** A key that is obviously not a real credential, so a leak would be unmistakable. */
const TEST_KEY = 'test-key-not-a-real-credential';

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

// ── residue ───────────────────────────────────────────────────────────────────────────────────

test('the AC3 false form leaves none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
