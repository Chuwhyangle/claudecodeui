/**
 * The budget guard's unit case, driven against a FAKE upstream.
 *
 * WHY IT IS NOT PART OF THE THREE PROBES. S1–S3 need a live credential and a network; a guard that
 * only ever runs when someone remembers to spend money is a guard nobody has tested. This case
 * replaces the transport's `socketFactory` with an in-process fake that answers every
 * `response.create` with a `response.done` whose usage is far over the run's budget, and then reads
 * what actually happened: the guard tripped, the sockets went down, and the record says so.
 *
 * WHAT IT PROVES, exactly:
 *   · the running total is priced with the SHIPPING `estimateRealtimeCostCny` — the fake's usage is
 *     priced by the same function production uses, not by the case's own arithmetic;
 *   · the guard closes every open connection on the crossing, not on the next tick or the next frame;
 *   · `guardTriggered: true` reaches the RECORD that would be written for a real run — the flag is
 *     asserted on the serialized bytes, not on the in-memory object.
 *
 * Run:  npx tsx --tsconfig server/tsconfig.json --test experiments/voice-realtime-segmented/p0/guard-case.mts
 * The `--tsconfig` is not optional: `probe-lib.mts` reaches the shipping transport through the
 * `@/modules` alias, which only that tsconfig resolves — bare `tsx` dies with ERR_MODULE_NOT_FOUND.
 * It prints `record=<path> guardTriggered=… closedSockets=… spendCny=…` so the criterion in
 * `scripts/voice-realtime-p0-record-check.test.mjs` can assert on the same reading.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sleep, createRun, estimateRealtimeCostCny, openSession, sessionBody, SESSION_SEND_TOOL } from './probe-lib.mts';
import type { DashscopeSocket, DashscopeSocketFactory } from './probe-lib.mts';

const RECORD_DIR = path.join(os.tmpdir(), 'voice-realtime-p0-guard-case');

/** One `response.done` whose usage alone is several times the case's budget. */
const OVER_BUDGET_USAGE = { input_tokens: 1200, output_tokens: 900, input_tokens_details: { audio_tokens: 0, text_tokens: 1200 } };

/**
 * A fake upstream that answers anything with the over-budget response. It records its own closures,
 * because "the guard closed the connection" has to be a reading rather than an inference from the
 * fact that nobody sent anything afterwards.
 */
function fakeUpstream(): { factory: DashscopeSocketFactory; closes: () => number; emits: () => number } {
  let closes = 0;
  let emits = 0;
  const factory: DashscopeSocketFactory = () => {
    const socket: DashscopeSocket = {
      send(data: string) {
        const frame = JSON.parse(data) as { type?: string };
        if (frame.type === 'session.update') {
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'session.updated', session: { id: 'fake-session' } }) }));
        }
        if (frame.type === 'response.create') {
          emits += 1;
          // Every response is over budget on its own, so ONE is enough to prove the crossing.
          queueMicrotask(() =>
            socket.onmessage?.({
              data: JSON.stringify({
                type: 'response.done',
                response: { id: `fake-response-${emits}`, status: 'completed', usage: OVER_BUDGET_USAGE },
              }),
            }),
          );
        }
      },
      close() {
        closes += 1;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify({ type: 'session.created', session: { id: 'fake-session' } }) });
    });
    return socket;
  };
  return { factory, closes: () => closes, emits: () => emits };
}

test('the guard prices each response.done with the shipping estimator', () => {
  const priced = estimateRealtimeCostCny(OVER_BUDGET_USAGE);
  assert.ok(priced > 0, 'the shipping estimator must price this usage above zero');
  assert.ok(priced > 0.001, `one fake response must exceed the case budget on its own (got ${priced})`);
});

test('an over-budget response sequence closes every open socket and records guardTriggered', async () => {
  const upstream = fakeUpstream();
  const run = createRun({ budgetCny: 0.001, apiKey: 'not-a-real-key' });
  const session = await openSession({
    run,
    label: 'guard-case',
    instructions: 'relay',
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody(),
    socketFactory: upstream.factory,
    executor: { session_send: () => ({ queued: true }) },
  });

  // The session is up before anything is spent — otherwise "the guard closed it" would be
  // indistinguishable from "it never opened".
  assert.equal(session.sessionId, 'fake-session');
  assert.equal(run.spendCny, 0, 'nothing has been spent before the first response');
  assert.equal(run.guardTriggered, false, 'the guard must not be tripped by an empty session');

  session.sendRaw({ type: 'response.create' });
  const tripped = await session.waitFor(() => run.guardTriggered, 5_000);
  assert.ok(tripped, 'the guard must trip on the over-budget response');
  await sleep(50);

  const spendCny = run.spendCny;
  const record = {
    schema: 'voice-realtime-p0-guard-case/1',
    ranAt: new Date().toISOString(),
    upstream: 'fake (in-process socketFactory)',
    budgetCny: run.guard.budgetCny,
    spendCny,
    guardTriggered: run.guardTriggered,
    guardTrippedAt: run.guard.trippedAt,
    closedSockets: upstream.closes(),
    guardClosedSessions: run.guardClosedSessions,
    responsesObserved: session.responses.length,
  };

  mkdirSync(RECORD_DIR, { recursive: true });
  const file = path.join(RECORD_DIR, 'record.json');
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  assert.equal(run.guardTriggered, true);
  assert.ok(spendCny > run.guard.budgetCny, `spend ${spendCny} must exceed the budget ${run.guard.budgetCny}`);
  assert.equal(upstream.closes(), 1, 'the guard must have closed the one open socket');
  assert.equal(run.guardClosedSessions, 1);
  assert.equal(session.closed, true, 'the session reports itself closed after the guard acted');

  // The flag has to survive to the RECORD — the bytes that a real run would leave behind.
  const written = JSON.parse(readFileSync(file, 'utf8')) as { guardTriggered?: boolean; spendCny?: number };
  assert.equal(written.guardTriggered, true);
  assert.ok((written.spendCny ?? 0) > run.guard.budgetCny);

  console.log(`record=${file} guardTriggered=${written.guardTriggered} closedSockets=${upstream.closes()} spendCny=${written.spendCny}`);
  await session.close();
});
