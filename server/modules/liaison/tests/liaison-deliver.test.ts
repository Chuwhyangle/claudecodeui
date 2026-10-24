/**
 * M3 liaison delivery — the criterion for `server/modules/liaison/`.
 *
 * Every reading is taken over the REAL service (`createLiaisonDeliveryService`), with only
 * the two seams the AC names stubbed:
 *
 *   · the fleet CLI runner (the "stub fleet registry"),
 *   · the host registry's liveness read (the "stub resident registry").
 *
 * The send seam is a recording stub standing in for the existing session send service, so
 * "delivered exactly once" is the number of calls it saw, and the inbox is the real
 * in-memory store. The disk store gets its own round trip at the end, because the production
 * inbox must survive a restart to be an inbox at all.
 *
 * AC1: resolved+live → one send with prefix; dead → inbox and no send; ambiguous → refused
 *      with a report; recovery → redelivery, never twice.
 * AC2: fleet CLI unavailable → an explicit error AND the message retained locally.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFileLiaisonStore,
  createLiaisonDeliveryService,
  createMemoryLiaisonStore,
  initiativeUri,
  liaisonPrefix,
  resolveLiaisonSession,
  type LiaisonFleetResult,
  type LiaisonFleetRun,
  type LiaisonSendInput,
  type LiaisonSendResult,
} from '@/modules/liaison/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INITIATIVE = 'fleet-ui';
const TARGET = 'alpha';
const FROM = 'claudecodeui';
const MESSAGE = 'the alpha board is ready for review';

type RegistryRow = { initiative: string; project: string; sessionId: string };

/** The stub fleet registry: answers one fixed `liaisonSessions` list for every read. */
function registryStub(rows: RegistryRow[]): LiaisonFleetRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: readonly string[]): Promise<LiaisonFleetResult> => {
    calls.push([...args]);
    return { ok: true, stdout: JSON.stringify({ ok: true, liaisonSessions: rows }) };
  }) as LiaisonFleetRun & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** A runner that answers with whatever document the case wants (including failures). */
function rawRunner(answer: LiaisonFleetResult | (() => Promise<LiaisonFleetResult>)): LiaisonFleetRun {
  return async () => (typeof answer === 'function' ? answer() : answer);
}

/** The recording send service. */
function sendStub(results: LiaisonSendResult[] = []): {
  calls: LiaisonSendInput[];
  send: (input: LiaisonSendInput) => Promise<LiaisonSendResult>;
} {
  const calls: LiaisonSendInput[] = [];
  return {
    calls,
    send: async (input) => {
      calls.push(input);
      return results.shift() ?? { ok: true, deliveryId: `sent-${calls.length}`, runId: `run-${calls.length}` };
    },
  };
}

/** The stub resident registry: exactly the ids in the set are live. */
function liveRegistry(ids: string[]): (sessionId: string) => boolean {
  const live = new Set(ids);
  return (sessionId) => live.has(sessionId);
}

function serviceOver(options: {
  runFleet: LiaisonFleetRun;
  live?: string[];
  send?: ReturnType<typeof sendStub>;
  store?: ReturnType<typeof createMemoryLiaisonStore>;
}) {
  const store = options.store ?? createMemoryLiaisonStore();
  const send = options.send ?? sendStub();
  const service = createLiaisonDeliveryService({
    runFleet: options.runFleet,
    isSessionLive: liveRegistry(options.live ?? []),
    sendMessage: send.send,
    store,
    now: () => Date.parse('2026-10-24T12:00:00.000Z'),
    newDeliveryId: (() => {
      let counter = 0;
      return () => `delivery-${++counter}`;
    })(),
  });
  return { service, store, send };
}

// ---------------------------------------------------------------------------
// AC1 — resolved + live
// ---------------------------------------------------------------------------

test('AC1 resolved + live: exactly one send through the session send service, prefixed with the initiative and sender', async () => {
  const registry = registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]);
  const { service, store, send } = serviceOver({ runFleet: registry, live: ['session-b'] });

  const outcome = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.outcome, 'delivered');
  assert.equal(send.calls.length, 1, 'the message must be sent exactly once');
  const [call] = send.calls;
  assert.ok(call, 'the send service must have been called');
  assert.equal(call.sessionId, 'session-b', 'the send must address the registry-resolved session');
  assert.ok(
    call.content.startsWith(`${liaisonPrefix(INITIATIVE, FROM)} `),
    `the delivered text must start with the liaison prefix; got ${call.content}`,
  );
  assert.ok(
    call.content.includes(initiativeUri(INITIATIVE)),
    `the delivered text must carry the initiative URI; got ${call.content}`,
  );
  assert.ok(call.content.includes(MESSAGE), 'the sender’s message must travel verbatim');
  assert.equal(call.deliveryId, outcome.deliveryId);

  // The record is queryable: who, when, which initiative, result.
  assert.deepEqual(
    store.listDeliveries().map((record) => ({
      initiative: record.initiative,
      project: record.project,
      from: record.from,
      outcome: record.outcome,
      sessionId: record.sessionId,
    })),
    [{ initiative: INITIATIVE, project: TARGET, from: FROM, outcome: 'delivered', sessionId: 'session-b' }],
  );
  assert.equal(store.pendingInbox().length, 0, 'a delivered message must not also be queued');
});

// ---------------------------------------------------------------------------
// AC1 — dead
// ---------------------------------------------------------------------------

test('AC1 dead: an unregistered pair is written to the initiative inbox and the send service is not called', async () => {
  const registry = registryStub([]);
  const { service, store, send } = serviceOver({ runFleet: registry, live: ['session-b'] });

  const outcome = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.outcome, 'inbox');
  assert.equal(send.calls.length, 0, 'a dead address must never reach the send service');
  const inbox = store.pendingInbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.message, MESSAGE, 'the queued entry must keep the message verbatim');
  assert.equal(inbox[0]?.cause, 'liaison-dead');
});

test('AC1 dead: a registered-but-not-live session is queued against its id, and still not sent to', async () => {
  const registry = registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]);
  const { service, store, send } = serviceOver({ runFleet: registry, live: [] });

  const outcome = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });

  assert.equal(outcome.ok && outcome.outcome, 'inbox');
  assert.equal(send.calls.length, 0);
  assert.equal(store.pendingInbox()[0]?.sessionId, 'session-b', 'the queued entry must remember which session it waits for');
});

// ---------------------------------------------------------------------------
// AC1 — ambiguous
// ---------------------------------------------------------------------------

test('AC1 ambiguous: two candidates refuse the delivery, report every candidate, and queue nothing', async () => {
  const registry = registryStub([
    { initiative: INITIATIVE, project: TARGET, sessionId: 'session-b1' },
    { initiative: INITIATIVE, project: TARGET, sessionId: 'session-b2' },
  ]);
  const { service, store, send } = serviceOver({ runFleet: registry, live: ['session-b1', 'session-b2'] });

  const outcome = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.code, 'ambiguous-liaison');
  assert.deepEqual(!outcome.ok && outcome.code === 'ambiguous-liaison' ? outcome.candidates : null, ['session-b1', 'session-b2']);
  assert.equal(send.calls.length, 0, 'an ambiguous address must not be guessed at');
  assert.equal(store.pendingInbox().length, 0, 'an ambiguous address must not be queued as if it were dead');

  // The report: the delivery log names the candidates, so "why did nothing arrive" is readable.
  const reports = store.listDeliveries().filter((record) => record.outcome === 'ambiguous');
  assert.equal(reports.length, 1, 'an ambiguous delivery must produce exactly one report');
  assert.match(reports[0]?.detail ?? '', /session-b1/);
  assert.match(reports[0]?.detail ?? '', /session-b2/);
});

// ---------------------------------------------------------------------------
// AC1 — recovery
// ---------------------------------------------------------------------------

test('AC1 recovery: the inbox is drained when the session becomes live, and a second event never resends', async () => {
  const store = createMemoryLiaisonStore();
  // Phase 1: registered but not live → inbox.
  const before = serviceOver({
    runFleet: registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]),
    live: [],
    store,
  });
  const queued = await before.service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
    userId: 7,
  });
  assert.equal(queued.ok && queued.outcome, 'inbox');
  assert.equal(before.send.calls.length, 0);
  const queuedId = queued.deliveryId;
  assert.equal(
    store.pendingInbox()[0]?.userId,
    7,
    'the queued entry must carry the caller the delivery was made for — a recovery has no caller of its own',
  );

  // Phase 2: the session is live now; the recovery event drains the entry exactly once.
  const after = serviceOver({
    runFleet: registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]),
    live: ['session-b'],
    store,
  });
  const recovery = await after.service.handleSessionRecovered('session-b');
  assert.deepEqual(recovery.delivered, [queuedId]);
  assert.equal(after.send.calls.length, 1, 'the queued message must be sent once on recovery');
  assert.equal(after.send.calls[0]?.userId, 7, 'the recovery must be made as the caller the delivery was queued for');
  assert.ok(after.send.calls[0]?.content.startsWith(`${liaisonPrefix(INITIATIVE, FROM)} `));
  assert.equal(store.pendingInbox().length, 0, 'a redelivered message must leave the inbox');

  // Phase 3: a second recovery event for the same session is a no-op (no duplicates).
  const second = await after.service.handleSessionRecovered('session-b');
  assert.deepEqual(second.delivered, []);
  assert.equal(after.send.calls.length, 1, 'recovery must not resend an already-delivered message');
});

test('AC1 recovery: an entry queued while the registry was empty is drained once its address resolves to the recovered session', async () => {
  const store = createMemoryLiaisonStore();
  const empty = serviceOver({ runFleet: registryStub([]), live: [], store });
  const queued = await empty.service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });
  assert.equal(queued.ok && queued.outcome, 'inbox');

  const nowRegistered = serviceOver({
    runFleet: registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]),
    live: ['session-b'],
    store,
  });
  const recovery = await nowRegistered.service.handleSessionRecovered('session-b');
  assert.deepEqual(recovery.delivered, [queued.deliveryId]);
  assert.equal(nowRegistered.send.calls.length, 1);

  // And recovery for an unrelated live session leaves it queued.
  const unrelatedStore = createMemoryLiaisonStore();
  const dead = serviceOver({ runFleet: registryStub([]), live: [], store: unrelatedStore });
  const stillQueued = await dead.service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });
  const otherSession = serviceOver({
    runFleet: registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]),
    live: ['session-x'],
    store: unrelatedStore,
  });
  const notDrained = await otherSession.service.handleSessionRecovered('session-x');
  assert.deepEqual(notDrained.delivered, []);
  assert.equal(otherSession.send.calls.length, 0);
  assert.equal(unrelatedStore.pendingInbox()[0]?.deliveryId, stillQueued.deliveryId);
});

// ---------------------------------------------------------------------------
// AC1 — exactly once by delivery id
// ---------------------------------------------------------------------------

test('AC1 exactly once: re-submitting a delivered delivery id is reported, never sent a second time', async () => {
  const registry = registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]);
  const { service, send } = serviceOver({ runFleet: registry, live: ['session-b'] });

  const first = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
    deliveryId: 'fixed-id',
  });
  const second = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
    deliveryId: 'fixed-id',
  });

  assert.equal(first.ok && first.outcome, 'delivered');
  assert.equal(second.ok && second.outcome, 'already-delivered');
  assert.equal(send.calls.length, 1, 'one delivery id is sent at most once');
});

// ---------------------------------------------------------------------------
// AC2 — the fleet CLI is unavailable
// ---------------------------------------------------------------------------

test('AC2 fleet CLI unavailable: an explicit error, and the message is retained in the local pending queue', async () => {
  const runner = rawRunner({ ok: false, reason: 'quay-fleet was not found: /nonexistent/quay-fleet' });
  const { service, store, send } = serviceOver({ runFleet: runner, live: ['session-b'] });

  const outcome = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });

  assert.equal(outcome.ok, false, 'an unavailable fleet must not read as a successful delivery');
  assert.equal(!outcome.ok && outcome.code, 'registry-unavailable');
  assert.match(!outcome.ok ? outcome.message : '', /queued locally/);
  assert.equal(send.calls.length, 0);
  assert.equal(store.pendingInbox().length, 1, 'the message must be retained, not silently dropped');
  assert.equal(store.pendingInbox()[0]?.message, MESSAGE);
  assert.equal(store.pendingInbox()[0]?.cause, 'registry-unavailable');
  assert.equal(
    store.listDeliveries().filter((record) => record.outcome === 'registry-unavailable').length,
    1,
    'the failure must be on the record',
  );
});

test('AC2 negative control: a non-JSON and a refusing registry document are unavailable, never "dead"', async () => {
  for (const answer of [
    { ok: true, stdout: 'not json at all' },
    { ok: true, stdout: JSON.stringify({ ok: false, reason: 'corrupt-registry' }) },
    { ok: true, stdout: JSON.stringify({ ok: true }) },
  ] satisfies Array<LiaisonFleetResult>) {
    const { service, store } = serviceOver({ runFleet: rawRunner(answer), live: [] });
    const outcome = await service.deliver({
      initiative: INITIATIVE,
      project: TARGET,
      from: FROM,
      message: MESSAGE,
    });
    assert.equal(outcome.ok, false, `an unreadable registry must be an error: ${JSON.stringify(answer)}`);
    assert.equal(!outcome.ok && outcome.code, 'registry-unavailable');
    assert.equal(store.pendingInbox()[0]?.cause, 'registry-unavailable', 'not queued as a dead address');
  }

  // Positive control for the same fixture: a well-formed empty list IS dead (queued for the session).
  const reading = await resolveLiaisonSession(
    rawRunner({ ok: true, stdout: JSON.stringify({ ok: true, liaisonSessions: [] }) }),
    { initiative: INITIATIVE, project: TARGET },
  );
  assert.deepEqual(reading, { state: 'dead', reason: 'unregistered' });
});

test('AC2: a runner that throws is unavailable, not a crash', async () => {
  const { service, store } = serviceOver({
    runFleet: async () => {
      throw new Error('spawn EACCES');
    },
    live: [],
  });
  const outcome = await service.deliver({
    initiative: INITIATIVE,
    project: TARGET,
    from: FROM,
    message: MESSAGE,
  });
  assert.equal(!outcome.ok && outcome.code, 'registry-unavailable');
  assert.match(!outcome.ok ? outcome.message : '', /spawn EACCES/);
  assert.equal(store.pendingInbox().length, 1);
});

// ---------------------------------------------------------------------------
// The service's own refusals, and the store that survives a restart
// ---------------------------------------------------------------------------

test('the delivery request is validated before any seam is touched', async () => {
  const registry = registryStub([{ initiative: INITIATIVE, project: TARGET, sessionId: 'session-b' }]);
  const { service, send } = serviceOver({ runFleet: registry, live: ['session-b'] });

  const outcome = await service.deliver({ initiative: '', project: TARGET, from: FROM, message: MESSAGE });
  assert.equal(!outcome.ok && outcome.code, 'invalid-request');
  assert.equal(send.calls.length, 0);
  assert.equal(registry.calls.length, 0, 'a malformed request must not even be asked about');
});

test('the disk inbox survives a new store instance and keeps queued/delivered apart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'liaison-store-'));
  try {
    const first = createFileLiaisonStore({ directory });
    first.enqueue({
      deliveryId: 'queued-1',
      initiative: INITIATIVE,
      project: TARGET,
      from: FROM,
      message: MESSAGE,
      enqueuedAt: '2026-10-24T12:00:00.000Z',
      cause: 'liaison-dead',
      sessionId: 'session-b',
      detail: null,
      userId: 7,
    });
    first.recordDelivery({
      deliveryId: 'queued-1',
      initiative: INITIATIVE,
      project: TARGET,
      from: FROM,
      at: '2026-10-24T12:00:00.000Z',
      outcome: 'inbox',
      sessionId: 'session-b',
      detail: null,
    });

    const second = createFileLiaisonStore({ directory });
    assert.equal(second.pendingInbox().length, 1, 'a queued message must survive a restart');
    assert.equal(second.wasDelivered('queued-1'), false);
    second.markDelivered('queued-1', { at: '2026-10-24T12:01:00.000Z', sessionId: 'session-b', via: 'recovery' });

    const third = createFileLiaisonStore({ directory });
    assert.equal(third.pendingInbox().length, 0, 'a delivered mark must survive a restart');
    assert.equal(third.wasDelivered('queued-1'), true);
    assert.equal(third.listDeliveries().length, 1);

    // Negative control: an unreadable carrier is corrupt, never "an empty inbox".
    fs.writeFileSync(path.join(directory, 'inbox.jsonl'), '{not json}\n');
    assert.throws(() => third.pendingInbox(), /liaison store is corrupt/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
