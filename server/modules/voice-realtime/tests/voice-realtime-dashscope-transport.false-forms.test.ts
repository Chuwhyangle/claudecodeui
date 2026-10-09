/**
 * AC-308's false forms — the mutation each criterion must CATCH.
 *
 * Each case here drives the
 * UNMUTATED code (green) and then a MUTATED copy (red), so the reading is shown
 * to be load-bearing rather than green for a reason of its own. The first four
 * (AC6) cover the transport's translation, routing, error guard, and the
 * non-determinism of the preserved live trace; forms 5 and 6 (AC10) cover the
 * tool whitelist and the declared-parameter-schema check:
 *
 *  - form 1 — retype a field of the outbound tool translation: the shipped
 *    `session.update` must name the tool the bridge advertised; a mutated copy
 *    that sends the description as the name must be caught by that assertion.
 *  - form 2 — hard-code the routing key on the inbound normaliser: a call the
 *    model made for `ui_visible_context` must reach THAT tool's executor; a copy
 *    that rewrites the name must send it to another tool.
 *  - form 3 — delete the inbound error guard: a malformed frame must be REPORTED
 *    and survive; a copy without the guard must let the parse throw escape.
 *  - form 4 — replay the preserved live trace through the SAME fixture: the
 *    fixture's deterministic output must differ from the real endpoint's on at
 *    least one real-only field (`session.id`, latency). A fixture configured to
 *    claim the real id would reproduce it byte-for-byte and must be flagged
 *    `SUSPECTED_STAND_IN`.
 *  - form 5 (AC10) — remove the inbound tool-whitelist check: a hallucinated tool
 *    name must be REPORTED and withheld; a copy without the check routes it to
 *    the executor instead.
 *  - form 6 (AC10) — the same check against the declared parameter SHAPE:
 *    arguments that violate a declared tool's schema must be REPORTED and
 *    withheld; the copy without the check routes them to the executor instead.
 *
 * The form 1-3 and 5-6 mutants are copies of the shipping module written BESIDE it (their
 * relative imports resolve there), named with `__criterion-falsify-` so
 * `server/tsconfig.json` excludes them from the typecheck program — the same
 * convention the voice criteria's false forms use — and removed in a `finally`.
 * A closing case proves this process left none of its own copies behind.
 *
 * Provenance (goal record AC-308): this file is the second of the two files the
 * criterion names. Run with THIS repo's runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test <the .test sibling> <this file>
 *
 * Consumers: the quay worker's AC state for AC-308; the proof that each reading
 * above can go red.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  connect,
  REALTIME_TOOLS,
  type DashscopeTransportError,
  type DashscopeTransportOptions,
  type DashscopeTransport,
  type RealtimeToolExecutor,
} from '../index.js';

import {
  createFakeDashscopeServer,
  readRealtimeTrace,
  replayTraceThroughFixture,
  sessionIdIn,
  type RealtimeTrace,
} from './voice-realtime-dashscope-harness.js';

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping transport: what the form 1-3 mutations copy. */
const SHIPPING_TRANSPORT_MODULE = path.join(MODULE_DIR, 'voice-realtime-dashscope-transport.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The signature the shipping (and copied) factory exposes. */
type CreateTransportFn = (options?: DashscopeTransportOptions) => DashscopeTransport;

/** Imports a transport module by path. The specifier is dynamic, so TS types it structurally here. */
async function importTransport(modulePath: string): Promise<{ createDashscopeTransport: CreateTransportFn }> {
  return (await import(pathToFileURL(modulePath).href)) as { createDashscopeTransport: CreateTransportFn };
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Writes a base copy and a mutated copy of the shipping transport and imports both. */
async function importBaseAndMutant(
  label: string,
  replace: (source: string) => string,
): Promise<{ base: CreateTransportFn; mutant: CreateTransportFn; cleanup: () => void }> {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  const basePath = ownCopy(`${label}-base`);
  const mutPath = ownCopy(`${label}-mut`);
  const mutated = replace(source);
  assert.notEqual(mutated, source, 'the mutation must actually change the source');
  writeFileSync(basePath, source, 'utf8');
  writeFileSync(mutPath, mutated, 'utf8');
  const base = (await importTransport(basePath)).createDashscopeTransport;
  const mutant = (await importTransport(mutPath)).createDashscopeTransport;
  return {
    base,
    mutant,
    cleanup: () => {
      rmSync(basePath, { force: true });
      rmSync(mutPath, { force: true });
    },
  };
}

// ── form 1: an outbound field drift ──────────────────────────────────────────────────────────

/** The anchor: the tool NAME the translation nests for the wire. */
const TOOL_NAME_ANCHOR = '      name: declaration.name,';
/** The mutation: the tool's name is taken from its DESCRIPTION instead. */
const TOOL_NAME_DRIFT = '      name: declaration.description,';

test('form 1: sending the wrong field as a tool name is caught on the wire', async () => {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, TOOL_NAME_ANCHOR), 1, 'the tool-name anchor must occur exactly once');

  const { base, mutant, cleanup } = await importBaseAndMutant('tool-name-drift', (source) =>
    source.replace(TOOL_NAME_ANCHOR, TOOL_NAME_DRIFT),
  );
  try {
    /** Opens one transport, sends a session update, returns the tool names it put on the wire. */
    const wireToolNames = async (createTransport: CreateTransportFn): Promise<string[]> => {
      const server = createFakeDashscopeServer();
      const transport = createTransport({ apiKey: 'k', socketFactory: server.socketFactory });
      const bridge = connect(transport, REALTIME_TOOLS, {}, {});
      await bridge.whenConnected();
      bridge.sendSessionUpdate('go');
      const update = server.sent.find((frame) => frame.type === 'session.update');
      const session = update?.session as Record<string, unknown> | undefined;
      const tools = (session?.tools ?? []) as Array<{ function: { name: string } }>;
      await bridge.close();
      return tools.map((tool) => tool.function.name);
    };

    // Unmutated: every advertised tool reaches the wire under its own name (green).
    assert.deepEqual(await wireToolNames(base), REALTIME_TOOLS.map((tool) => tool.name));
    // Mutated: the wire carries descriptions, so the assertion above would redden.
    const drifted = await wireToolNames(mutant);
    assert.notDeepEqual(drifted, REALTIME_TOOLS.map((tool) => tool.name));
    assert.equal(drifted[0], REALTIME_TOOLS[0].description);
  } finally {
    cleanup();
  }
});

// ── form 2: a fixed routing key on the inbound path ──────────────────────────────────────────

/** The anchor: the normaliser forwards the model's chosen NAME. */
const ROUTE_ANCHOR =
  "    return { type: 'function_call', callId: frame.call_id, name: frame.name, arguments: frame.arguments };";
/** The mutation: every call is routed as if the model asked for `session_send`. */
const ROUTE_FIXED =
  "    return { type: 'function_call', callId: frame.call_id, name: 'session_send', arguments: frame.arguments };";

test('form 2: hard-coding the routing key sends a tool`s call to another tool', async () => {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, ROUTE_ANCHOR), 1, 'the routing anchor must occur exactly once');

  const { base, mutant, cleanup } = await importBaseAndMutant('route-fixed', (source) =>
    source.replace(ROUTE_ANCHOR, ROUTE_FIXED),
  );
  try {
    /** Drives one `ui_visible_context` call, returning the executors that actually ran. */
    const routeOneCall = async (createTransport: CreateTransportFn): Promise<string[]> => {
      const server = createFakeDashscopeServer();
      const transport = createTransport({ apiKey: 'k', socketFactory: server.socketFactory });
      const ran: string[] = [];
      const executor: RealtimeToolExecutor = {
        session_send: () => {
          ran.push('session_send');
          return 'sent';
        },
        ui_visible_context: () => {
          ran.push('ui_visible_context');
          return { devices: [] };
        },
      };
      const bridge = connect(transport, REALTIME_TOOLS, executor, {});
      await bridge.whenConnected();
      server.peerSend({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'ui_visible_context', arguments: '{}' });
      await bridge.close();
      return ran;
    };

    // Unmutated: the call reaches the executor the model named (green).
    assert.deepEqual(await routeOneCall(base), ['ui_visible_context']);
    // Mutated: the same call is rewritten to `session_send` — the wrong tool (red).
    assert.deepEqual(await routeOneCall(mutant), ['session_send']);
  } finally {
    cleanup();
  }
});

// ── form 3: the inbound error guard deleted ──────────────────────────────────────────────────

/** The guard's catch body — the block the form 3 mutation removes. */
const INBOUND_CATCH = "    } catch (cause) {\n      emitError({ code: 'MALFORMED_SERVER_FRAME', cause });\n    }";

test('form 3: deleting the inbound guard lets a malformed frame escape uncaught', async () => {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, INBOUND_CATCH), 1, 'the inbound-guard anchor must occur exactly once');

  const { base, mutant, cleanup } = await importBaseAndMutant('no-inbound-guard', (source) =>
    source.replace(INBOUND_CATCH, '    } catch (cause) {\n      throw cause;\n    }'),
  );
  try {
    /** Feeds one malformed frame, returning whether it ESCAPED uncaught plus what was reported. */
    const driveMalformed = async (
      createTransport: CreateTransportFn,
    ): Promise<{ escaped: boolean; reported: DashscopeTransportError['code'][] }> => {
      const server = createFakeDashscopeServer();
      const errors: DashscopeTransportError[] = [];
      const transport = createTransport({ apiKey: 'k', socketFactory: server.socketFactory, onError: (e) => errors.push(e) });
      const bridge = connect(transport, REALTIME_TOOLS, {}, {});
      await bridge.whenConnected();
      let escaped = false;
      try {
        server.peerSendRaw('{ not json at all');
      } catch {
        escaped = true;
      }
      await bridge.close();
      return { escaped, reported: errors.map((error) => error.code) };
    };

    // Unmutated: the malformed frame is reported and survives (green).
    const guarded = await driveMalformed(base);
    assert.equal(guarded.escaped, false);
    assert.ok(guarded.reported.includes('MALFORMED_SERVER_FRAME'));

    // Mutated: the parse error escapes the socket handler (red).
    const unguarded = await driveMalformed(mutant);
    assert.equal(unguarded.escaped, true, 'with the guard gone, a malformed frame must escape uncaught');
  } finally {
    cleanup();
  }
});

// ── form 4: the preserved live trace is not reproducible by the fixture ────────────────────────

/** What one fixture replay produced. */
type Replay = { emitted: Array<Record<string, unknown>>; latenciesMs: number[] };

/**
 * The real-only fields a fixture cannot reproduce, named so the red says which
 * one it caught. `SUSPECTED_STAND_IN` is this list being EMPTY: it means every
 * field a real endpoint owns came back identical from a deterministic stand-in.
 */
function realOnlyDifferences(replay: Replay, trace: RealtimeTrace): string[] {
  const differences: string[] = [];
  if (sessionIdIn(replay.emitted) !== trace.session.id) differences.push('session.id');
  // A fixture answers in process, so its "latencies" are function-call time; a real
  // endpoint's are milliseconds over a wire. Their ranges cannot overlap.
  if (replay.latenciesMs.length > 0 && trace.latenciesMs.length > 0) {
    const fixtureMax = Math.max(...replay.latenciesMs);
    const realMin = Math.min(...trace.latenciesMs);
    if (fixtureMax < realMin) differences.push('latency');
  }
  // The model's call id is endpoint-assigned, not a fixture constant.
  const fixtureCallIds = replay.emitted
    .filter((frame) => frame.type === 'response.function_call_arguments.done' && typeof frame.call_id === 'string')
    .map((frame) => frame.call_id as string);
  if (fixtureCallIds.length > 0 && trace.functionCalls.every((call) => !fixtureCallIds.includes(call.callId))) {
    differences.push('call_id');
  }
  return differences;
}

test('form 4: the preserved live trace is NOT byte-replayable by the fixture (else SUSPECTED_STAND_IN)', () => {
  const trace = readRealtimeTrace('function-call-trace.json');

  // The trace must BE a real trace before its non-reproducibility means anything.
  assert.match(trace.session.id, /^sess_/, 'the preserved trace must carry a real endpoint session id');
  assert.ok(trace.latenciesMs.length > 0, 'the preserved trace must record real round trips');
  assert.ok(
    trace.latenciesMs.every((ms) => ms > 0),
    'every preserved latency must be a real non-zero round trip',
  );
  assert.ok(new Set(trace.latenciesMs).size > 1, 'real latencies must vary');
  const modelCalls = trace.functionCalls.filter((call) => call.source === 'model');
  assert.ok(modelCalls.length > 0, 'the preserved trace must contain a model-initiated function call');

  // Replay the trace's client frames through the SAME fixture.
  const replay = replayTraceThroughFixture(trace);

  // Unmutated fixture (its own constant ids): the fixture CANNOT reproduce the trace.
  const differences = realOnlyDifferences(replay, trace);
  assert.ok(
    differences.length > 0,
    'SUSPECTED_STAND_IN: the fixture reproduced the real trace byte-for-byte (no real-only field differed)',
  );

  // Load-bearing: a fixture configured to CLAIM the real session id and call id
  // reproduces them, and the same check then drops those two fields — so the
  // difference list is exactly what is keeping this trace from being a stand-in.
  const impostor = replayTraceThroughFixture(trace, {
    sessionId: trace.session.id,
    callId: modelCalls[0].callId,
  });
  assert.equal(sessionIdIn(impostor.emitted), trace.session.id, 'the impostor fixture must claim the real session id');
  const impostorDifferences = realOnlyDifferences(impostor, trace);
  assert.ok(
    !impostorDifferences.includes('session.id') && !impostorDifferences.includes('call_id'),
    'when the fixture claims the real ids, those fields stop differing — the check is what keeps the trace honest',
  );
  assert.deepEqual(
    differences.filter((field) => field !== 'latency').sort(),
    ['call_id', 'session.id'],
    'the honest fixture must differ on every identity field, not only latency',
  );
});

// ── form 5: the inbound tool whitelist ───────────────────────────────────────────────────────

/** The inbound whitelist/schema check the form 5-6 mutations remove. */
const VALIDATE_BLOCK =
  "        const rejection = validateDeclaredCall(event as RealtimeFunctionCall);\n" +
  "        if (rejection !== null) {\n" +
  "          emitError(rejection);\n" +
  "          return;\n" +
  "        }";

test('form 5: a hallucinated tool name is rejected, never routed to an executor', async () => {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, VALIDATE_BLOCK), 1, 'the validation anchor must occur exactly once');

  const { base, mutant, cleanup } = await importBaseAndMutant('tool-whitelist', (source) =>
    source.replace(VALIDATE_BLOCK, ''),
  );
  try {
    /** Advertises the six real tools, then has the "model" ask for one that was never advertised. */
    const driveHallucinated = async (
      createTransport: CreateTransportFn,
    ): Promise<{ ran: string[]; reported: DashscopeTransportError['code'][] }> => {
      const server = createFakeDashscopeServer();
      const errors: DashscopeTransportError[] = [];
      const transport = createTransport({ apiKey: 'k', socketFactory: server.socketFactory, onError: (e) => errors.push(e) });
      const ran: string[] = [];
      // An executor that WOULD answer the hallucinated name — so a silent route is observable.
      const executor: RealtimeToolExecutor = {
        hallucinated_tool: () => {
          ran.push('hallucinated_tool');
          return {};
        },
      };
      const bridge = connect(transport, REALTIME_TOOLS, executor, {});
      await bridge.whenConnected();
      bridge.sendSessionUpdate('go'); // declares the six real tools, so the whitelist is live
      server.peerSend({
        type: 'response.function_call_arguments.done',
        call_id: 'c_hall',
        name: 'hallucinated_tool',
        arguments: '{}',
      });
      await bridge.close();
      return { ran, reported: errors.map((error) => error.code) };
    };

    // Unmutated: the unadvertised name is reported and never reaches an executor (green).
    const guarded = await driveHallucinated(base);
    assert.deepEqual(guarded.ran, []);
    assert.ok(guarded.reported.includes('UNDECLARED_TOOL'));

    // Mutated: with the check removed, the same call IS routed — proving it is load-bearing (red).
    const unguarded = await driveHallucinated(mutant);
    assert.deepEqual(unguarded.ran, ['hallucinated_tool']);
  } finally {
    cleanup();
  }
});

// ── form 6: the declared-parameter-schema check ──────────────────────────────────────────────

test('form 6: arguments violating the declared schema are rejected, never routed', async () => {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(countOccurrences(source, VALIDATE_BLOCK), 1, 'the validation anchor must occur exactly once');

  const { base, mutant, cleanup } = await importBaseAndMutant('arg-schema', (source) =>
    source.replace(VALIDATE_BLOCK, ''),
  );
  try {
    /** Advertises the tools, then has the "model" call a declared tool with invalid arguments. */
    const driveBadArgs = async (
      createTransport: CreateTransportFn,
    ): Promise<{ ran: string[]; reported: DashscopeTransportError['code'][] }> => {
      const server = createFakeDashscopeServer();
      const errors: DashscopeTransportError[] = [];
      const transport = createTransport({ apiKey: 'k', socketFactory: server.socketFactory, onError: (e) => errors.push(e) });
      const ran: string[] = [];
      const executor: RealtimeToolExecutor = {
        session_send: () => {
          ran.push('session_send');
          return { runId: 'r', queued: false, queuedMessageUuid: null, source: 'test' };
        },
      };
      const bridge = connect(transport, REALTIME_TOOLS, executor, {});
      await bridge.whenConnected();
      bridge.sendSessionUpdate('go');
      // `session_send` declares `{ session: string; message: string }`: this call
      // gives `session` the wrong type AND omits the required `message`.
      server.peerSend({
        type: 'response.function_call_arguments.done',
        call_id: 'c_bad',
        name: 'session_send',
        arguments: '{"session":42}',
      });
      await bridge.close();
      return { ran, reported: errors.map((error) => error.code) };
    };

    // Unmutated: the schema violation is reported and never reaches the executor (green).
    const guarded = await driveBadArgs(base);
    assert.deepEqual(guarded.ran, []);
    assert.ok(guarded.reported.includes('TOOL_ARGUMENT_SCHEMA_VIOLATION'));

    // Mutated: with the check removed, the violating call IS routed — load-bearing (red).
    const unguarded = await driveBadArgs(mutant);
    assert.deepEqual(unguarded.ran, ['session_send']);
  } finally {
    cleanup();
  }
});

// ── residue ────────────────────────────────────────────────────────────────────────────────────

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
