/**
 * AC-310's false forms — the mutation each of AC1 and AC3 must CATCH.
 *
 * A false form drives the UNMUTATED code (green) and then a MUTATED copy (red),
 * so the reading is shown to be load-bearing rather than green for a reason of
 * its own. Both mutants are copies of the shipping executor written BESIDE it
 * (its only non-gateway import is a type, so a copy resolves), named with
 * `__criterion-falsify-` so `server/tsconfig.json` excludes them from the
 * typecheck program, and removed in a `finally`. The two:
 *
 *  - AC1 — a route that stops delegating: `session_send` is replaced by a
 *    handler that returns a hard-coded payload. The payload can be made EQUAL to
 *    what the real build function returns, so a value-only reading would miss it;
 *    what reddens is the DELEGATION reading — the mutant touches no service,
 *    where the shipping route reaches the control seam. That is exactly why AC1
 *    compares the recorded service interactions and not only the returned value.
 *  - AC3 — the whitelist guard neutralized (`if (false)`): a call naming another
 *    session is no longer refused or recorded; it is silently coerced onto the
 *    bound session. The refusal reading reddens (no throw, no record) and the
 *    foreign-session send is silently absorbed — the failure mode AC3 forbids.
 *
 * A closing case proves this process left none of its own copies behind.
 *
 * Consumers: the quay worker's AC state for AC-310; the proof that AC1's and
 * AC3's readings can go red.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { RealtimeToolExecutor } from '../index.js';

// ── where things are ─────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This module's directory — where a mutant copy must sit so its imports resolve. */
const MODULE_DIR = path.resolve(HERE, '..');
/** The shipping executor: what the mutants copy. */
const SHIPPING_EXECUTOR_MODULE = path.join(MODULE_DIR, 'voice-realtime-live-executor.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
/** A copy this process owns: prefixed AND pid-tagged, so a sibling's copy is never mistaken for ours. */
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The bound session the copies under test are built for. */
const BOUND_SESSION = 'sess-bound';
/** The first-party user the copies act as. */
const USER_ID = 7;

/** The signature a copied/shipped executor module exposes. */
type ExecutorModule = { createVoiceRealtimeLiveExecutor: (deps: unknown) => RealtimeToolExecutor };

/** Imports an executor module by path. The specifier is dynamic, so TS types it structurally here. */
async function importExecutor(modulePath: string): Promise<ExecutorModule> {
  return (await import(pathToFileURL(modulePath).href)) as ExecutorModule;
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Reads one handler off a routing table, failing loudly if the route is missing. */
function route(executor: RealtimeToolExecutor, name: string) {
  const handler = executor[name];
  if (handler === undefined) throw new Error(`the executor routes no "${name}" handler`);
  return handler;
}

// ── the minimal session_send fakes ───────────────────────────────────────────────────────────

/** One send the fake control seam recorded. */
type SendCall = { caller: unknown; input: unknown };

/**
 * Builds an executor over a fake service set for the `session_send` route only
 * (the other five bags stay unread by these forms), wiring the caller's own
 * `refusals` and `sends` arrays in as the observables.
 */
function buildSendExecutor(
  create: ExecutorModule['createVoiceRealtimeLiveExecutor'],
  refusals: unknown[],
  sends: SendCall[],
): RealtimeToolExecutor {
  return create({
    boundSessionId: BOUND_SESSION,
    caller: { userId: USER_ID, scopes: ['cloudcli:read'] },
    visibleContext: {},
    readTools: {},
    runGet: {},
    approvals: {},
    sessionBackground: {},
    sessionSend: {
      control: {
        send: async (caller: unknown, input: unknown) => {
          sends.push({ caller, input });
          return { ok: true, runId: 'run-1', queued: false, queuedMessageUuid: null };
        },
      },
      runs: { getRun: () => ({ runId: 'run-1', source: 'mcp', status: 'running' }) },
      runGet: { deps: {}, build: async () => ({}) },
    },
    onSessionRefusal: (refusal: unknown) => refusals.push(refusal),
  });
}

// ── AC3 false form: the whitelist guard neutralized ──────────────────────────────────────────

/** The whitelist guard the AC3 mutation neutralizes. */
const GUARD_ANCHOR = 'if (args.session !== undefined && args.session !== deps.boundSessionId) {';
/** The mutation: the guard never fires, so a foreign session is silently coerced. */
const GUARD_NEUTERED = 'if (false) {';

test('AC3 false form: neutralizing the whitelist silently coerces a foreign session', async () => {
  const source = readFileSync(SHIPPING_EXECUTOR_MODULE, 'utf8');
  assert.equal(countOccurrences(source, GUARD_ANCHOR), 1, 'the whitelist guard must occur exactly once');

  const basePath = ownCopy('no-whitelist-base');
  const mutPath = ownCopy('no-whitelist-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(GUARD_ANCHOR, GUARD_NEUTERED), 'utf8');
    const base = await importExecutor(basePath);
    const mut = await importExecutor(mutPath);

    // Unmutated: a foreign session is refused AND recorded, and the control seam
    // is never reached.
    const baseRefusals: unknown[] = [];
    const baseSends: SendCall[] = [];
    const baseExecutor = buildSendExecutor(base.createVoiceRealtimeLiveExecutor, baseRefusals, baseSends);
    let baseThrew = false;
    try {
      await route(baseExecutor, 'session_send')({ session: 'sess-someone-else', message: 'nope' });
    } catch (error) {
      baseThrew = true;
      const refusal = (error as { refusal?: { requestedSession?: unknown } }).refusal;
      assert.equal(refusal?.requestedSession, 'sess-someone-else');
    }
    assert.equal(baseThrew, true, 'the shipping executor must refuse a foreign session');
    assert.equal(baseRefusals.length, 1, 'the shipping executor must record the refusal');
    assert.equal(baseSends.length, 0, 'the shipping executor must not reach the control seam');

    // Mutated: no refusal, no record, and the foreign call is silently sent to
    // the bound session — the failure AC3 forbids.
    const mutRefusals: unknown[] = [];
    const mutSends: SendCall[] = [];
    const mutExecutor = buildSendExecutor(mut.createVoiceRealtimeLiveExecutor, mutRefusals, mutSends);
    await route(mutExecutor, 'session_send')({ session: 'sess-someone-else', message: 'nope' });
    assert.equal(mutRefusals.length, 0, 'with the guard gone the refusal is no longer recorded');
    assert.equal(mutSends.length, 1, 'with the guard gone the foreign call is silently sent anyway');
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC1 false form: a route that stops delegating ────────────────────────────────────────────

/** The `session_send` route line the AC1 mutation replaces with a hard-coded handler. */
const ROUTE_ANCHOR = '    session_send: sessionSend,';
/** The mutation: no delegation — a fixed payload that EQUALS what the real build returns. It
 *  carries EVERY field the shipping `session_send` payload does, `blockedBy` and the AC-385
 *  `deliveryId` included, so the mutant stays value-equal and only the DELEGATION reading (not
 *  the value) can redden it. `deliveryId: null` is what the real build answers HERE because the
 *  fake control seam below returns no `deliveryId` and `RESIDENT_RUN_IS_TURN` is unset — the
 *  payload field is present either way (SPEC §8.1), so a mutant without it stops being
 *  value-equal and the deepEqual would red for the wrong reason. */
const ROUTE_HARDCODED =
  "    session_send: async () => ({ deliveryId: null, runId: 'run-1', queued: false, queuedMessageUuid: null, source: 'mcp', blockedBy: null }),";

test('AC1 false form: a non-delegating route reaches no service, which the delegation reading catches', async () => {
  const source = readFileSync(SHIPPING_EXECUTOR_MODULE, 'utf8');
  assert.equal(countOccurrences(source, ROUTE_ANCHOR), 1, 'the session_send route anchor must occur exactly once');

  const basePath = ownCopy('no-delegation-base');
  const mutPath = ownCopy('no-delegation-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(ROUTE_ANCHOR, ROUTE_HARDCODED), 'utf8');
    const base = await importExecutor(basePath);
    const mut = await importExecutor(mutPath);

    const baseSends: SendCall[] = [];
    const baseExecutor = buildSendExecutor(base.createVoiceRealtimeLiveExecutor, [], baseSends);
    const baseResult = await route(baseExecutor, 'session_send')({ session: BOUND_SESSION, message: 'hello' });

    const mutSends: SendCall[] = [];
    const mutExecutor = buildSendExecutor(mut.createVoiceRealtimeLiveExecutor, [], mutSends);
    const mutResult = await route(mutExecutor, 'session_send')({ session: BOUND_SESSION, message: 'hello' });

    // The VALUES are equal — so a value-only reading would pass the mutant. This
    // is the point: the delegation reading is what must catch it.
    assert.deepEqual(mutResult, baseResult, 'the mutant is crafted to return an equal payload');

    // The shipping route reaches the control seam; the mutant reaches nothing.
    assert.equal(baseSends.length, 1, 'the shipping route must delegate to the control seam');
    assert.equal(mutSends.length, 0, 'a non-delegating route must reach no service — the red the delegation reading catches');
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── residue ──────────────────────────────────────────────────────────────────────────────────

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
