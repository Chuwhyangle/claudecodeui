/**
 * Criterion for the resident host's COLD team-head — a round armed while no turn
 * was in flight.
 *
 * The driver tells two rounds apart by where they sit, and the CLI settles one
 * turn at a time. A round armed while the process is BUSY is a queue entry: the
 * CLI states its turn at the dequeue (`command_lifecycle started`), and that
 * statement is what groups the rounds the CLI folded into one turn under the one
 * `result` that ends it (see `claude-resident-merged-queued-turn.test.ts`, which
 * is the criterion for that grouping).
 *
 * A round armed while the process is IDLE is not a queue entry — it is the work
 * the CLI is about to pick up — so it is never dequeued and no `started` will
 * ever name it. The driver used to leave that round's `resultsSeenAtStart` at
 * `null`, which made the merge scan at its own `result` skip it entirely: only
 * the front round was settled, and if the CLI had folded later sends into that
 * round's turn they stayed in the FIFO forever. The offset never healed — every
 * later send kept one more round waiting on a `result` that had already arrived
 * — so the newest run stayed `running` with its `turn` lease held, which is the
 * `Working…` a finished turn left on screen (session `fdd3e920`, measured
 * 1h59m).
 *
 * The criterion replays that session's frame sequence against a scripted process
 * seam and the REAL `ClaudeResidentHostDriver`. Three legs, all on the driver's
 * own readings:
 *
 * (a) Cold M1 in flight; M2 and M3 written while it runs; both dequeued
 *     (`started`) *before* the single `result` — so the CLI folded them into
 *     M1's turn — reads an empty round FIFO, no leaked `turn` lease, and one
 *     terminal `complete` on each of M1, M2 and M3.
 * (b) Two idle sends afterwards (M4, M5), each dequeued into a turn of its own,
 *     read that the offset did NOT persist: every send settles its own writer,
 *     never the writer of the send before it, and the FIFO is empty after each.
 * (c) The counterexample, so a fix that just clears the FIFO on any `result`
 *     cannot pass: A in flight, B and C drained into a LATER turn. A's `result`
 *     settles A alone (`roundsOpenAfterFirstResult=2`); the merged `result`
 *     after B and C were started settles exactly those two.
 *
 * Red lines:
 * - Every reading is taken before anything is asserted, so a red lands on the
 *   reading that is wrong rather than on a timeout or on an earlier leg.
 * - Every leg reads the same named quantity — a per-writer `complete` count —
 *   so "any result clears the whole FIFO" cannot pass (a) and be caught only by
 *   (c).
 * - The process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, as in the sibling resident criteria.
 * - No real `claude` binary is started: the seam is the injected `createProcess`
 *   factory and nothing else.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION_ID = 'claude-resident-cold-head-merge-session';

/** The provider-native id the scripted arm keys its frames by. */
const PROVIDER_SESSION_ID = 'fdd3e920-2b90-4af5-abf5-fe69559e1b9d';

/** The pid the scripted seam reports; it is read and never acted on. */
const PROCESS_PID = 4242;

/**
 * The bound the criterion reports the whole run against.
 *
 * The AC budgets one run of this file at 20s wall clock; the guard is the
 * process-level kill that turns a resident lifecycle that hangs into its own
 * reading (`exit 3`), not a per-case failure.
 */
const RUN_BUDGET_MS = 20_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the cold-head-merge criterion did not finish ` +
      `inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, RUN_BUDGET_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// Scripted-process arm
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this arm is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * A resident process the arm owns: a stream it pushes into, in order, plus the
 * driver's own write side read back off the queue it seeds and writes.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every reading
 * into a reading of a dead process.
 *
 * `pushed` is the other half and it is why the factory is not a bare constant:
 * the driver hands the process an input queue as `prompt`, and the uuids it
 * stamps on the frames are only readable there. An idle round has no
 * `queuedInputs` entry (that list is exactly "frames written while busy"), so
 * without the write side the arm could not name the message it is driving.
 */
function createFakeProcess(): {
  factory: ClaudeResidentProcessFactory;
  emit(frame: AnyRecord): void;
  pushed(): AnyRecord[];
} {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  const pushed: AnyRecord[] = [];

  const push = (frame: AnyRecord): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    pending.push(frame);
  };

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
      });
    },
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  const factory: ClaudeResidentProcessFactory = (input) => {
    // One reader, for the process's whole life: every frame the driver writes
    // is recorded in write order, which is the order the arm reads uuids in.
    void (async () => {
      for await (const frame of input.prompt) {
        pushed.push(frame);
      }
    })();
    return { query, pid: PROCESS_PID } satisfies ClaudeResidentProcess;
  };

  return { factory, emit: push, pushed: () => pushed };
}

/** The runtime's own turn inputs, stubbed to the facts this arm's driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // The frame pipeline has its own criteria; this arm measures settlement, and
  // an empty normalizer keeps the recording writers free of forwarded frames.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

/** A writer that records every frame it is handed, so a run's `complete` is countable. */
function createRecordingWriter(): {
  writer: ProviderRuntimeWriter;
  frames: AnyRecord[];
  completeCount(): number;
} {
  const frames: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (message) => {
      frames.push(message as AnyRecord);
    },
    setSessionId: () => undefined,
    userId: 1,
  };
  return { writer, frames, completeCount: () => frames.filter((frame) => frame.kind === 'complete').length };
}

/** The turn's terminal `result`, keyed by the provider id. */
function resultFrame(): AnyRecord {
  return { type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID };
}

/** The CLI's own account of dequeuing one message into a turn. */
function startedFrame(commandUuid: string): AnyRecord {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state: 'started' };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 200; hop += 1) {
    await Promise.resolve();
  }
}

/** How many `turn` leases the manager is holding for one session's binding. */
function turnLeaseCount(manager: SessionHostManager, sessionId: string): number {
  for (const host of manager.snapshot()) {
    const binding = host.bindings.get(sessionId);
    if (binding) {
      return binding.leases.filter((lease) => lease.kind === 'turn').length;
    }
  }
  return 0;
}

/** Polls until the driver has handed the process `count` frames, or the budget runs out. */
async function waitForPushed(
  process: { pushed(): AnyRecord[] },
  count: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.pushed().length >= count) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  return false;
}

/** One arm: a real driver over a scripted process, plus a per-round writer. */
type Harness = {
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: { emit(frame: AnyRecord): void; pushed(): AnyRecord[] };
};

function createHarness(): Harness {
  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => 1_700_000_000_000,
  });
  return { manager, driver, process };
}

/**
 * Dispatches one turn and waits until the driver has written it to the process.
 *
 * `run` is not awaited — a round settles only once this arm has pushed its
 * frames, so awaiting it here would deadlock. The push is the wait: it happens
 * inside `armRound` in the same synchronous block that arms the lease, so it is
 * a stricter signal than polling the lease count (which a leaked lease from an
 * earlier leg would satisfy one round early) and it is the only signal that is
 * the same in both the fixed and the broken build.
 */
async function send(
  harness: Harness,
  command: string,
  pushedAfter: number,
  rounds: Promise<void>[],
): Promise<ReturnType<typeof createRecordingWriter>> {
  const recording = createRecordingWriter();
  rounds.push(harness.driver.run(SESSION_ID, { command, options: {} }, recording.writer, CONTEXT));
  assert.ok(
    await waitForPushed(harness.process, pushedAfter, 5_000),
    `the resident host must hand the process the frame for "${command}" (waited for ${pushedAfter})`,
  );
  return recording;
}

/** The uuids the driver stamped on the frames it wrote, in write order. */
function pushedUuids(harness: Harness): string[] {
  return harness.process.pushed().map((frame) => (typeof frame.uuid === 'string' ? frame.uuid : ''));
}

// ---------------------------------------------------------------------------
// Legs (a) and (b): the cold head, and the offset that must not persist
// ---------------------------------------------------------------------------

test('AC-377 (a)(b) a cold-head round settles the turn the CLI folds later sends into, and the offset does not persist', async () => {
  const harness = createHarness();
  const rounds: Promise<void>[] = [];

  // --- (a) cold M1 in flight, M2 and M3 folded into its turn -------------------
  const m1 = await send(harness, 'M1 cold head', 1, rounds);
  const m2 = await send(harness, 'M2 written while M1 runs', 2, rounds);
  const m3 = await send(harness, 'M3 written while M1 runs', 3, rounds);

  const armed = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(armed, 'the resident host must be readable once three rounds are armed');
  assert.strictEqual(
    armed.queuedInputs.length,
    2,
    `M2 and M3 are the only queue entries; the cold M1 is not one (read ${armed.queuedInputs.length})`,
  );
  const uuids = pushedUuids(harness);
  const [m2Uuid, m3Uuid] = [armed.queuedInputs[0].uuid, armed.queuedInputs[1].uuid];
  assert.strictEqual(m2Uuid, uuids[1], 'M2\'s queue record must name the uuid the driver actually wrote');
  assert.strictEqual(m3Uuid, uuids[2], 'M3\'s queue record must name the uuid the driver actually wrote');

  // The CLI's own order at a turn boundary it merges at: both queued entries are
  // dequeued (`started`) *before* the single `result` that ends the turn they
  // were folded into. Read before the result, the dequeues see zero ended turns,
  // which is the count the cold head was stamped with at arm time.
  harness.process.emit(startedFrame(m2Uuid));
  harness.process.emit(startedFrame(m3Uuid));
  await settle();
  harness.process.emit(resultFrame());
  await settle();

  const afterA = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(afterA, 'the resident host must still be readable at rest');
  // Every reading taken before anything is asserted, so a red lands on the wrong
  // reading rather than on a timeout or on an earlier leg.
  const resultsObserved = afterA.resultTimes.length;
  const completesA = [m1, m2, m3].map((recording) => recording.completeCount());
  const roundsOpenA = afterA.roundsOpen;
  const turnLeasesOpenA = turnLeaseCount(harness.manager, SESSION_ID);
  console.log(
    `coldHeadMerge: resultsObserved=${resultsObserved} roundsOpen=${roundsOpenA} ` +
      `turnLeasesOpen=${turnLeasesOpenA} completes=M1:${completesA[0]} M2:${completesA[1]} M3:${completesA[2]}`,
  );

  assert.strictEqual(resultsObserved, 1, 'the CLI sent one result for the turn it folded M2 and M3 into');
  assert.strictEqual(completesA[0], 1, 'M1 must receive exactly one terminal complete');
  assert.strictEqual(completesA[1], 1, 'M2 must receive exactly one terminal complete');
  assert.strictEqual(completesA[2], 1, 'M3 must receive exactly one terminal complete');
  assert.strictEqual(roundsOpenA, 0, `the round FIFO must be empty at rest (read ${roundsOpenA})`);
  assert.strictEqual(turnLeasesOpenA, 0, `no turn lease may be leaked (read ${turnLeasesOpenA})`);

  // --- (b) two idle sends, each settling on its own writer ---------------------
  const m4 = await send(harness, 'M4 idle send', 4, rounds);
  const m4Uuid = pushedUuids(harness)[3];
  harness.process.emit(startedFrame(m4Uuid));
  await settle();
  harness.process.emit(resultFrame());
  await settle();

  const afterM4 = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(afterM4, 'the resident host must still be readable after the first idle send');
  const roundsOpenM4 = afterM4.roundsOpen;
  const completesM4 = [m1, m2, m3, m4].map((recording) => recording.completeCount());
  console.log(
    `idleSendM4: roundsOpen=${roundsOpenM4} completes=M1:${completesM4[0]} M2:${completesM4[1]} ` +
      `M3:${completesM4[2]} M4:${completesM4[3]}`,
  );

  assert.strictEqual(roundsOpenM4, 0, `the FIFO must be empty after M4's own result (read ${roundsOpenM4})`);
  assert.strictEqual(completesM4[3], 1, 'M4 must receive exactly one terminal complete');
  assert.strictEqual(completesM4[2], 1, 'M4\'s complete must not land on M3\'s writer');

  const m5 = await send(harness, 'M5 idle send', 5, rounds);
  const m5Uuid = pushedUuids(harness)[4];
  harness.process.emit(startedFrame(m5Uuid));
  await settle();
  harness.process.emit(resultFrame());
  await settle();

  const afterM5 = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(afterM5, 'the resident host must still be readable after the second idle send');
  const roundsOpenM5 = afterM5.roundsOpen;
  const completesM5 = [m1, m2, m3, m4, m5].map((recording) => recording.completeCount());
  const turnLeasesOpenM5 = turnLeaseCount(harness.manager, SESSION_ID);
  console.log(
    `idleSendM5: roundsOpen=${roundsOpenM5} completes=M1:${completesM5[0]} M2:${completesM5[1]} ` +
      `M3:${completesM5[2]} M4:${completesM5[3]} M5:${completesM5[4]}`,
  );

  assert.strictEqual(roundsOpenM5, 0, `the FIFO must be empty after M5's own result (read ${roundsOpenM5})`);
  assert.strictEqual(completesM5[4], 1, 'M5 must receive exactly one terminal complete');
  assert.strictEqual(completesM5[3], 1, 'M5\'s complete must not land on M4\'s writer');
  assert.strictEqual(turnLeasesOpenM5, 0, 'no turn lease may be leaked once every send has settled');

  const leftovers = await Promise.allSettled(rounds);
  assert.deepStrictEqual(
    leftovers.map((result) => result.status),
    ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
    'every dispatched run must settle',
  );
});

// ---------------------------------------------------------------------------
// Leg (c): the counterexample — a LATER drain is not the cold head's turn
// ---------------------------------------------------------------------------

test('AC-377 (c) a round the CLI drains into a later turn is not settled by the previous result', async () => {
  const harness = createHarness();
  const rounds: Promise<void>[] = [];

  const a = await send(harness, 'A cold head', 1, rounds);
  const b = await send(harness, 'B written while A runs', 2, rounds);
  const c = await send(harness, 'C written while A runs', 3, rounds);

  const armed = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(armed, 'the resident host must be readable once three rounds are armed');
  assert.strictEqual(armed.queuedInputs.length, 2, 'B and C are the only queue entries');
  const [bUuid, cUuid] = [armed.queuedInputs[0].uuid, armed.queuedInputs[1].uuid];

  // A's turn ends first. B and C have NOT been dequeued yet, so they belong to a
  // turn the CLI has not started — the later drain — and this result must settle
  // A and nobody else. This is the leg that catches "clear the whole FIFO on any
  // result": such a fix passes (a) and reds here.
  harness.process.emit(resultFrame());
  await settle();

  const afterFirstResult = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(afterFirstResult, 'the resident host must still be readable after A\'s result');
  const completesAfterFirst = [a, b, c].map((recording) => recording.completeCount());
  const roundsOpenAfterFirstResult = afterFirstResult.roundsOpen;
  console.log(
    `laterDrainMerge: roundsOpenAfterFirstResult=${roundsOpenAfterFirstResult} ` +
      `completes=A:${completesAfterFirst[0]} B:${completesAfterFirst[1]} C:${completesAfterFirst[2]}`,
  );

  assert.strictEqual(roundsOpenAfterFirstResult, 2, 'B and C must still be waiting for their own turn');
  assert.strictEqual(completesAfterFirst[0], 1, 'A\'s result settles A alone');
  assert.strictEqual(completesAfterFirst[1], 0, 'B has not run yet and must not be settled');
  assert.strictEqual(completesAfterFirst[2], 0, 'C has not run yet and must not be settled');

  // Now the CLI drains B and C together into one later turn, under one result.
  harness.process.emit(startedFrame(bUuid));
  harness.process.emit(startedFrame(cUuid));
  await settle();
  harness.process.emit(resultFrame());
  await settle();

  const afterMergedResult = harness.driver.busyInputReading(SESSION_ID);
  assert.ok(afterMergedResult, 'the resident host must still be readable at rest');
  const completesAfterMerged = [a, b, c].map((recording) => recording.completeCount());
  const roundsOpenAfterMergedResult = afterMergedResult.roundsOpen;
  const turnLeasesAfterMergedResult = turnLeaseCount(harness.manager, SESSION_ID);
  console.log(
    `laterDrainMerge: roundsOpen=${roundsOpenAfterMergedResult} turnLeasesOpen=${turnLeasesAfterMergedResult} ` +
      `completes=A:${completesAfterMerged[0]} B:${completesAfterMerged[1]} C:${completesAfterMerged[2]}`,
  );

  assert.strictEqual(completesAfterMerged[1], 1, 'B must receive exactly one terminal complete from the merged turn');
  assert.strictEqual(completesAfterMerged[2], 1, 'C must receive exactly one terminal complete from the merged turn');
  assert.strictEqual(roundsOpenAfterMergedResult, 0, `the round FIFO must be empty at rest (read ${roundsOpenAfterMergedResult})`);
  assert.strictEqual(turnLeasesAfterMergedResult, 0, 'no turn lease may be leaked at rest');

  const leftovers = await Promise.allSettled(rounds);
  assert.deepStrictEqual(
    leftovers.map((result) => result.status),
    ['fulfilled', 'fulfilled', 'fulfilled'],
    'every dispatched run must settle',
  );
});
