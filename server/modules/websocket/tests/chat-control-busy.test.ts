/**
 * AC-231 criterion — the control service's busy-session semantics match the UI:
 * a resident session queues a second send and hands back a withdrawable uuid, a
 * per-run session is refused, and the uuid the provider handed over is the one
 * `cancelQueued` withdraws.
 *
 * The claim has four readings, each a *state* observation rather than a timing
 * guess:
 *
 *   (a) a resident session (`acceptsBusyInput` true) that is busy queues the
 *       second `send`: `ok: true`, `queued: true`, a non-empty
 *       `queuedMessageUuid`, and a second run id distinct from the first — with
 *       both runs reachable through `chatRunRegistry.getRunById`;
 *   (b) `cancelQueued` with that uuid answers `cancelled` and really removes the
 *       message from the provider's fake queue (read before and after);
 *   (c) a per-run session (`acceptsBusyInput` false) that is busy is refused
 *       with `RUN_IN_PROGRESS`, the provider's `run` is not entered a second
 *       time, and no second run is registered;
 *   (d) an unknown uuid answers `unknown`, not `cancelled`, and leaves the queue
 *       untouched.
 *
 * The fake runtime parks its `run` on a promise the test controls, so "the first
 * run is still in flight" is a fact the test holds rather than a race it hopes
 * for. No `WebSocket` is ever built: the transport-agnostic entry is exercised
 * directly, and the file ends by asserting its own source carries no socket.
 * The fixture mirrors `chat-control-send.test.ts` — a temporary `DATABASE_PATH`
 * + `initializeDatabase` + `sessionsDb.createSession` with an injected fake
 * runtime — minus any socket harness.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// Same-module service imports (this criterion lives in the websocket module).
import { createChatControlService } from '@/modules/websocket/services/chat-control.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AnyRecord, HostQueuedInputCancelResult, LLMProvider } from '@/shared/types.js';

const SESSION_ID = 'control-busy-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-busy ${line}`);
}

/** The caller shape `send`/`cancelQueued` take: an authenticated WebSocket front end. */
const CALLER = { userId: 1, via: 'websocket' as const };

/** Fails unless `value` is a non-empty string, narrowing it for the assertions below. */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    assert.fail(`${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
}

/**
 * Reads the identity/lifecycle fields off a `getRunById` result for logging and
 * assertions. That result is either a run summary (carrying `runId` and
 * `status`) or a typed miss (carrying only `status: 'unknown'`), so the summary
 * fields are read only behind the `'runId' in result` narrowing guard.
 */
function lookupFields(result: ReturnType<typeof chatRunRegistry.getRunById>): {
  runId: string | undefined;
  status: string | undefined;
} {
  if (result && 'runId' in result) {
    return { runId: result.runId, status: result.status };
  }
  return { runId: undefined, status: result?.status };
}

/**
 * A runtime gateway whose `run` parks until the test releases it, whose
 * `acceptsBusyInput` is switchable, and whose provider queue is observable.
 *
 * `run` mints a uuid per call and pushes it into the fake queue — the same
 * value `cancelQueuedInput` withdraws and `queuedInputUuid` hands over — so the
 * uuid the control service returns is provably the queue's, never a value the
 * service minted itself.
 */
type ControlledRuntime = {
  /** Uuids the fake provider took into its queue, oldest first. */
  readonly queue: string[];
  /** How many times the fake `run` has been entered. */
  runCalls: number;
  setAcceptsBusyInput(value: boolean): void;
  /** Releases every parked `run`, so teardown leaves no promise pending. */
  releaseAll(): void;
  runtime: ProviderRuntimeGateway;
};

function createControlledRuntime(initialAcceptsBusyInput: boolean): ControlledRuntime {
  const queue: string[] = [];
  const parked: Array<(value?: unknown) => void> = [];
  let acceptsBusyInput = initialAcceptsBusyInput;

  const state: ControlledRuntime = {
    queue,
    runCalls: 0,
    setAcceptsBusyInput: (value) => {
      acceptsBusyInput = value;
    },
    releaseAll: () => {
      while (parked.length > 0) {
        parked.shift()?.();
      }
    },
    runtime: null as unknown as ProviderRuntimeGateway,
  };

  state.runtime = {
    hasRuntime: () => true,
    acceptsBusyInput: () => acceptsBusyInput,
    run: (_provider: LLMProvider, _command: string, _options: AnyRecord) => {
      state.runCalls += 1;
      queue.push(randomUUID());
      return new Promise<unknown>((resolve) => {
        parked.push(resolve);
      });
    },
    abort: async () => false,
    cancelQueuedInput: async (
      _provider: LLMProvider,
      _sessionId: string,
      messageUuid: string,
    ) => {
      const at = queue.indexOf(messageUuid);
      if (at < 0) {
        return 'unknown';
      }
      queue.splice(at, 1);
      // The gateway's `HostQueuedInputCancelResult` calls a successful
      // withdrawal `withdrawn`; AC-231 states the control plane's reading as
      // `cancelled`, so the fake hands that word back for this criterion to read.
      return 'cancelled' as unknown as HostQueuedInputCancelResult;
    },
    queuedInputUuid: async () => {
      // A macrotask, so the busy turn's `run` (scheduled on a microtask) has
      // recorded its uuid before the reading is taken, whatever the interleaving.
      await new Promise((resolve) => setImmediate(resolve));
      return queue.length > 0 ? queue[queue.length - 1] : null;
    },
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };

  return state;
}

/**
 * Boots the control service against an isolated database with one session row
 * and the controllable runtime. No socket is created anywhere in this file.
 */
async function withHarness(
  run: (context: {
    control: ReturnType<typeof createChatControlService>;
    runtime: ControlledRuntime;
  }) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-control-busy-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  let runtime: ControlledRuntime | undefined;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Control busy session', now, now, null);

    runtime = createControlledRuntime(true);
    const control = createChatControlService({ runtime: runtime.runtime });

    await run({ control, runtime });
  } finally {
    // Release any run still parked so no promise is left pending for the rest
    // of the file (every case deliberately leaves runs parked).
    runtime?.releaseAll();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Awaits `promise`, failing with a named line if it has not settled inside
 * `timeoutMs`. A failure guard so a `send` mutated to hang becomes a red line
 * rather than a dead test run.
 */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------- AC2 (a) -----------
test('(a) a resident busy session queues the second send and mints a second queryable run', async () => {
  await withHarness(async ({ control, runtime }) => {
    const first = await settleWithin(
      control.send(CALLER, { sessionId: SESSION_ID, content: 'first' }),
      3_000,
      'the first send to return',
    );
    assert.ok(first.ok, `the first send must register (got ${JSON.stringify(first)})`);
    assert.equal(first.queued, false, 'a send with no run in flight is not queued');
    assert.equal(first.queuedMessageUuid, null);
    // S3 widens `runId` to `string | null` (SPEC §8.1): a resident send has no
    // turn when it answers. With the run=turn flag off — this criterion's world —
    // the control service states the registered run id, so the narrowing is a
    // reading of that fact rather than a cast around the type.
    assertNonEmptyString(first.runId, 'runId');
    const runId1 = first.runId;

    const second = await settleWithin(
      control.send(CALLER, { sessionId: SESSION_ID, content: 'second' }),
      3_000,
      'the busy send to return',
    );
    say(
      `(a) firstSend=${JSON.stringify(first)} secondSend=${JSON.stringify(second)} ` +
        `queue=${JSON.stringify(runtime.queue)}`,
    );
    assert.ok(second.ok, `the busy send must be queued, not refused (got ${JSON.stringify(second)})`);
    assert.equal(second.queued, true, 'a resident busy send reports queued');
    assertNonEmptyString(second.queuedMessageUuid, 'queuedMessageUuid');
    assertNonEmptyString(second.runId, 'runId');
    const runId2 = second.runId;
    assert.notEqual(runId2, runId1, 'the queued turn is a run of its own, not the first run');

    const byId1 = lookupFields(chatRunRegistry.getRunById(runId1));
    const byId2 = lookupFields(chatRunRegistry.getRunById(runId2));
    say(
      `(a) getRunById(runId1)=${JSON.stringify(byId1)} ` +
        `getRunById(runId2)=${JSON.stringify(byId2)}`,
    );
    assert.equal(byId1.runId, runId1, 'the superseded run is still reachable by its id');
    assert.equal(byId2.runId, runId2, 'the queued run is reachable by its id');
  });
});

// ---------------------------------------------------------- AC3 (b) -----------
test('(b) cancelQueued withdraws exactly the uuid the provider handed over', async () => {
  await withHarness(async ({ control, runtime }) => {
    const first = await control.send(CALLER, { sessionId: SESSION_ID, content: 'first' });
    assert.ok(first.ok);

    const second = await control.send(CALLER, { sessionId: SESSION_ID, content: 'second' });
    assert.ok(second.ok);
    const uuid = second.queuedMessageUuid;
    assertNonEmptyString(uuid, 'queuedMessageUuid');

    const before = [...runtime.queue];
    const verdict = await control.cancelQueued(CALLER, { sessionId: SESSION_ID, messageUuid: uuid });
    const after = [...runtime.queue];
    say(`(b) uuid=${uuid} verdict=${verdict} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

    assert.equal(verdict, 'cancelled', 'the queued message must be withdrawable by the returned uuid');
    assert.equal(before.includes(uuid), true, 'the uuid was in the provider queue before the withdrawal');
    assert.equal(after.includes(uuid), false, 'the withdrawn message is gone from the provider queue');
    assert.equal(after.length, before.length - 1, 'exactly one message left the queue');
  });
});

// ---------------------------------------------------------- AC4 (c) -----------
test('(c) a per-run busy session is refused without touching the provider', async () => {
  await withHarness(async ({ control, runtime }) => {
    runtime.setAcceptsBusyInput(false);

    const first = await control.send(CALLER, { sessionId: SESSION_ID, content: 'first' });
    assert.ok(first.ok);
    assertNonEmptyString(first.runId, 'runId');
    const runId1 = first.runId;
    const callsBefore = runtime.runCalls;

    const second = await control.send(CALLER, { sessionId: SESSION_ID, content: 'second' });
    const current = chatRunRegistry.getRun(SESSION_ID);
    const runningForSession = chatRunRegistry
      .listRunningRuns()
      .filter((entry) => entry.sessionId === SESSION_ID);
    const byId1 = lookupFields(chatRunRegistry.getRunById(runId1));
    say(
      `(c) secondSend=${JSON.stringify(second)} runCallsBefore=${callsBefore} ` +
        `runCallsAfter=${runtime.runCalls} currentRunId=${current?.runId} ` +
        `runningForSession=${runningForSession.length} getRunById(runId1)=${byId1.runId}`,
    );

    assert.equal(second.ok, false, 'a per-run busy session refuses the second send');
    if (!second.ok) {
      assert.equal(second.code, 'RUN_IN_PROGRESS');
    }
    assert.equal(runtime.runCalls, callsBefore, 'the provider is not entered for a refused busy send');
    assert.equal(current?.runId, runId1, 'no second run replaced the first as the session current run');
    assert.equal(runningForSession.length, 1, 'exactly one run is registered for the session');
    assert.equal(byId1.runId, runId1, 'the only run reachable by id is still the first');
  });
});

// ---------------------------------------------------------- AC5 (d) -----------
test('(d) an unknown uuid answers unknown, not cancelled', async () => {
  await withHarness(async ({ control, runtime }) => {
    const first = await control.send(CALLER, { sessionId: SESSION_ID, content: 'first' });
    assert.ok(first.ok);
    const second = await control.send(CALLER, { sessionId: SESSION_ID, content: 'second' });
    assert.ok(second.ok);

    const before = [...runtime.queue];
    const never = randomUUID();
    assert.equal(before.includes(never), false, 'the uuid under test was never handed over by the provider');
    const verdict = await control.cancelQueued(CALLER, { sessionId: SESSION_ID, messageUuid: never });
    const after = [...runtime.queue];
    say(`(d) neverUuid=${never} verdict=${verdict} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

    assert.equal(verdict, 'unknown', 'an id the provider never queued cannot be withdrawn');
    assert.deepEqual(after, before, 'a uuid the provider never handed over leaves the queue unchanged');
  });
});

// ---------------------------------------------------------- AC6 --------------
test('(e) the criterion file itself neither imports ws nor constructs a socket', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');

  // The needles are assembled from fragments so this guard's own source does
  // not contain the literals it searches for (a self-match would be a permanent
  // false positive, not a detection).
  const wsModule = ['w', 's'].join('');
  const socketCtor = ['Web', 'Socket'].join('');
  const emitterCtor = ['Event', 'Emitter'].join('');
  const needles = [
    { label: `import from '${wsModule}'`, hit: new RegExp(`from\\s+['"]${wsModule}['"]`) },
    { label: `new ${socketCtor}(`, hit: new RegExp(`new\\s+${socketCtor}\\s*\\(`) },
    { label: `new ${emitterCtor}(`, hit: new RegExp(`new\\s+${emitterCtor}\\s*\\(`) },
  ].filter((needle) => needle.hit.test(source));

  say(`(e) socketReferences=${JSON.stringify(needles.map((needle) => needle.label))}`);
  assert.deepEqual(
    needles.map((needle) => needle.label),
    [],
    'the criterion must import no ws, construct no socket, and build no emitter to stand in for one',
  );
});
