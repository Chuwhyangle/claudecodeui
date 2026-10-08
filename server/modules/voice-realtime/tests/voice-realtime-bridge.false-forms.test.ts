/**
 * AC-305's three false forms — one each for AC2, AC3 and AC4.
 *
 * A false form is the mutation a criterion must CATCH. Each case here drives the
 * UNMUTATED code (green) and then a MUTATED copy (red), so the reading is shown
 * to be load-bearing rather than to be green for a reason of its own. The three:
 *
 *  - AC2 — retype / drop / add a field in a mirrored schema: the field-by-field
 *    comparison against the gateway must redden AND name the field.
 *  - AC3 — replace the routing lookup with a fixed tool: the call for one tool
 *    must land on another tool's executor, which the routing reading then flags.
 *  - AC4 — delete the two error guards: an unknown event, an executor throw and a
 *    refused connection must each escape UNCAUGHT, where the guarded code reports
 *    them through `onError` and survives.
 *
 * The AC3/AC4 mutants are copies of the shipping module written BESIDE it (their
 * only import is a type, so a copy resolves), named with `__criterion-falsify-`
 * so `server/tsconfig.json` excludes them from the typecheck program — the same
 * convention the voice criteria's false forms use — and removed in a `finally`.
 * A closing case proves this process left none of its own copies behind.
 *
 * Consumers: the quay worker's AC state for AC-305; the proof that AC2/AC3/AC4's
 * readings can go red.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  diffToolDescriptors,
  REALTIME_TOOLS,
  REALTIME_TOOLS_BY_NAME,
  type connect,
  type RealtimeBridgeError,
  type RealtimeToolExecutor,
} from '../index.js';

import { captureMcpToolSchemas, createFakeTransport } from './realtime-bridge-harness.js';

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a mutant copy must sit so its relative imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping bridge: what the AC3/AC4 mutations copy. */
const SHIPPING_BRIDGE_MODULE = path.join(MODULE_DIR, 'voice-realtime-bridge.service.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The signature the shipping (and copied) `connect` exposes. */
type ConnectFn = typeof connect;

/** Imports a bridge module by path. The specifier is dynamic, so TS types it structurally here. */
async function importBridge(modulePath: string): Promise<{ connect: ConnectFn }> {
  return (await import(pathToFileURL(modulePath).href)) as { connect: ConnectFn };
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ── AC2 false form: a mutated schema field ─────────────────────────────────────────────────────

test('AC2 false form: a retyped, dropped or added field is caught and named', async () => {
  const captured = await captureMcpToolSchemas();
  const oracle = captured.session_send;
  const mirror = REALTIME_TOOLS_BY_NAME.session_send;

  // Unmutated: the mirror agrees with the gateway field for field (green).
  assert.deepEqual(diffToolDescriptors(oracle, mirror), []);

  // Retyped: `message` goes from string to number.
  const retyped = { ...mirror, inputSchema: { ...mirror.inputSchema, message: z.number() } };
  const retypedField = diffToolDescriptors(oracle, retyped).find(
    (mismatch) => mismatch.section === 'input' && mismatch.field === 'message',
  );
  assert.ok(retypedField, 'retyping `message` must be caught');
  assert.equal(retypedField.kind, 'shape');

  // Dropped: `message` is removed entirely.
  const withoutMessage = { ...mirror.inputSchema };
  delete withoutMessage.message;
  const droppedField = diffToolDescriptors(oracle, { ...mirror, inputSchema: withoutMessage }).find(
    (mismatch) => mismatch.section === 'input' && mismatch.field === 'message',
  );
  assert.ok(droppedField, 'dropping `message` must be caught');
  assert.equal(droppedField.kind, 'missing');

  // Added: a field the gateway never declared appears.
  const withExtra = { ...mirror, inputSchema: { ...mirror.inputSchema, bogus: z.string() } };
  const addedField = diffToolDescriptors(oracle, withExtra).find(
    (mismatch) => mismatch.section === 'input' && mismatch.field === 'bogus',
  );
  assert.ok(addedField, 'adding a field must be caught');
  assert.equal(addedField.kind, 'unexpected');
});

// ── AC3 false form: a fixed dispatch ───────────────────────────────────────────────────────────

/** The routing lookup the AC3 mutation replaces: the executor is chosen by the tool NAME. */
const DISPATCH_ANCHOR = '    const handler = executor[call.name];';
/** The mutation: every call is dispatched to `session_send`, whatever the model asked for. */
const FIXED_DISPATCH = "    const handler = executor['session_send'];";

/** Drives one function call over `connectFn`, returning the executors that actually ran. */
async function routeOneCall(connectFn: ConnectFn, toolName: string): Promise<string[]> {
  const transport = createFakeTransport();
  const ran: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: () => {
      ran.push('session_send');
      return 'send';
    },
    session_get: () => {
      ran.push('session_get');
      return 'get';
    },
    ui_visible_context: () => {
      ran.push('ui_visible_context');
      return 'ui';
    },
  };
  const bridge = connectFn(transport, REALTIME_TOOLS, executor, {});
  await bridge.whenConnected();
  // A call for `session_get`: it must reach session_get's executor and no other.
  transport.peerSend({ type: 'function_call', callId: 'c1', name: toolName, arguments: '{"session":"s"}' });
  return ran;
}

test('AC3 false form: a fixed dispatch sends one tool`s call to another tool`s executor', async () => {
  const source = readFileSync(SHIPPING_BRIDGE_MODULE, 'utf8');
  assert.equal(countOccurrences(source, DISPATCH_ANCHOR), 1, 'the dispatch anchor must occur exactly once');

  const basePath = ownCopy('fixed-dispatch-base');
  const mutPath = ownCopy('fixed-dispatch-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(DISPATCH_ANCHOR, FIXED_DISPATCH), 'utf8');
    const base = await importBridge(basePath);
    const mut = await importBridge(mutPath);

    // Unmutated: the call reaches the executor named by the tool (green).
    assert.deepEqual(await routeOneCall(base.connect, 'session_get'), ['session_get']);
    // Mutated: the same call lands on session_send's executor — the wrong one (red).
    assert.deepEqual(await routeOneCall(mut.connect, 'session_get'), ['session_send']);
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC4 false form: the error guards deleted ───────────────────────────────────────────────────

/** The synchronous guard's body — the block the AC4 mutation removes. */
const SYNC_GUARD = '  try {\n    body();\n  } catch (error) {\n    onError(error);\n  }';
/** The asynchronous guard's body — the block the AC4 mutation removes. */
const ASYNC_GUARD = '  try {\n    await body();\n  } catch (error) {\n    onError(error);\n  }';

/** Runs the two message-driven failures, reporting whether each ESCAPED uncaught. */
async function driveMessageFailures(connectFn: ConnectFn): Promise<{ escaped: string[]; reported: string[] }> {
  const transport = createFakeTransport();
  const errors: RealtimeBridgeError[] = [];
  const executor: RealtimeToolExecutor = {
    boom: () => {
      throw new Error('executor exploded');
    },
  };
  const bridge = connectFn(transport, REALTIME_TOOLS, executor, { hooks: { onError: (error) => errors.push(error) } });
  await bridge.whenConnected();

  const escaped: string[] = [];
  try {
    transport.peerSend({ type: 'an_event_the_bridge_does_not_know' });
  } catch {
    escaped.push('unknown_event');
  }
  try {
    transport.peerSend({ type: 'function_call', callId: 'c1', name: 'boom', arguments: '{}' });
  } catch {
    escaped.push('executor_throw');
  }
  return { escaped, reported: errors.map((error) => error.code) };
}

/** Runs the connection failure, reporting whether `whenConnected()` REJECTED. */
async function driveConnectionFailure(connectFn: ConnectFn): Promise<{ rejected: boolean; state: string }> {
  const transport = createFakeTransport({ failOpens: Number.POSITIVE_INFINITY });
  const bridge = connectFn(transport, REALTIME_TOOLS, {}, { maxConnectAttempts: 2 });
  let rejected = false;
  try {
    await bridge.whenConnected();
  } catch {
    rejected = true;
  }
  return { rejected, state: bridge.state };
}

test('AC4 false form: deleting the error guards lets each failure escape uncaught', async () => {
  const source = readFileSync(SHIPPING_BRIDGE_MODULE, 'utf8');
  assert.equal(countOccurrences(source, SYNC_GUARD), 1, 'the sync-guard anchor must occur exactly once');
  assert.equal(countOccurrences(source, ASYNC_GUARD), 1, 'the async-guard anchor must occur exactly once');
  const mutatedSource = source.replace(SYNC_GUARD, '  body();').replace(ASYNC_GUARD, '  await body();');

  const basePath = ownCopy('no-error-guards-base');
  const mutPath = ownCopy('no-error-guards-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, mutatedSource, 'utf8');
    const base = await importBridge(basePath);
    const mut = await importBridge(mutPath);

    // Unmutated: both message failures are caught and reported; the refused
    // connection resolves (the guard turns it into `closed`, never a rejection).
    const baseMessages = await driveMessageFailures(base.connect);
    assert.deepEqual(baseMessages.escaped, []);
    assert.deepEqual(baseMessages.reported, ['UNKNOWN_EVENT', 'TOOL_EXECUTION_FAILED']);
    const baseConnection = await driveConnectionFailure(base.connect);
    assert.equal(baseConnection.rejected, false);
    assert.equal(baseConnection.state, 'closed');

    // Mutated: both message failures escape, and the refused connection rejects.
    const mutMessages = await driveMessageFailures(mut.connect);
    assert.deepEqual(
      mutMessages.escaped,
      ['unknown_event', 'executor_throw'],
      'with the sync guard gone, the unknown event and the executor throw must escape uncaught',
    );
    const mutConnection = await driveConnectionFailure(mut.connect);
    assert.equal(
      mutConnection.rejected,
      true,
      'with the async guard gone, a refused connection must reject `whenConnected()`',
    );
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── residue ────────────────────────────────────────────────────────────────────────────────────

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
