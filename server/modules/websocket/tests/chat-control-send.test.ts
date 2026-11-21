/**
 * AC-230 criterion — `ChatControlService.send` returns the registered run's id
 * immediately, from a control service that never touches a socket.
 *
 * The claim has three halves, and the readings are ordered so each is a *state*
 * observation rather than a timing guess:
 *
 *   (a) `send` resolves while the provider run is still in flight. The fake
 *       runtime parks on a promise the test releases by hand, so the ordering is
 *       read as `released === false` at the moment `send` returns — never as
 *       "it came back within N ms";
 *   (b) the id it returned is the run `chatRunRegistry` is holding, and that run
 *       is `running`;
 *   (c) once released, the run completes normally and the whole criterion
 *       produces zero `unhandledRejection` events;
 *   (d) an unknown session and a provider with no runtime each answer a stable
 *       code and leave the registry empty;
 *   (e) the file itself imports no `ws`, constructs no socket and builds no
 *       emitter — (a)–(d) are all read without one.
 *
 * No `WebSocket` is ever built: the transport-agnostic entry is exercised
 * directly. The fixture otherwise mirrors `chat-control-ownership.test.ts` — a
 * temporary `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession`
 * with an injected fake runtime — minus that file's socket harness.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// Same-module service import (this criterion lives in the websocket module); the
// cross-module imports above go through their barrels.
import { createChatControlService } from '@/modules/websocket/services/dispatch/chat-control.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

const SESSION_ID = 'control-send-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-send ${line}`);
}

/** The caller shape `send` takes: an authenticated user over the WebSocket front end. */
const CALLER = { userId: 1, via: 'websocket' as const };

type RunCall = { provider: string; command: string; options: AnyRecord };

/**
 * A runtime gateway whose single `run` parks until the test releases it, so
 * "still in flight" is a fact the test controls rather than a race it hopes for.
 * `hasRuntime` is switchable so the unsupported-provider arm can be driven.
 */
type ControlledRuntime = {
  /** True once the fake `run` has been entered. */
  called: boolean;
  /** True once the test has released the parked run. */
  released: boolean;
  release(): void;
  setHasRuntime(value: boolean): void;
  readonly runCalls: RunCall[];
  runtime: ProviderRuntimeGateway;
};

function createControlledRuntime(initialHasRuntime = true): ControlledRuntime {
  let releaseParked: ((value?: unknown) => void) | null = null;
  let hasRuntime = initialHasRuntime;

  const state: ControlledRuntime = {
    called: false,
    released: false,
    runCalls: [],
    release: () => {
      state.released = true;
      releaseParked?.();
    },
    setHasRuntime: (value) => {
      hasRuntime = value;
    },
    runtime: null as unknown as ProviderRuntimeGateway,
  };

  state.runtime = {
    hasRuntime: () => hasRuntime,
    run: (provider: LLMProvider, command: string, options: AnyRecord) => {
      state.called = true;
      state.runCalls.push({ provider, command, options });
      return new Promise<unknown>((resolve) => {
        releaseParked = resolve;
      });
    },
    abort: async () => false,
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
  run: (context: { control: ReturnType<typeof createChatControlService>; runtime: ControlledRuntime }) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-control-send-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  let runtime: ControlledRuntime | undefined;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Control send session', now, now, null);

    runtime = createControlledRuntime();
    const control = createChatControlService({ runtime: runtime.runtime });

    await run({ control, runtime });
  } finally {
    // Release any run still parked so no promise is left pending for the rest
    // of the file (the ordering case deliberately leaves one parked).
    runtime?.release();
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

/** Bounded poll that reports the wait timing out instead of failing the case, so a red lands on the reading. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  say(`waitFor timed out: ${label}`);
  return false;
}

/**
 * Awaits `promise`, failing with a named line if it has not settled inside
 * `timeoutMs`.
 *
 * The bound is a failure guard, never the synchronisation: the reading below is
 * `released === false` at the instant `send` returned, which is an ordering
 * fact. The guard only turns a `send` that *cannot* return (one mutated to wait
 * for the run itself) into a failure line instead of a hang, so the
 * falsification for this reading is a red rather than a deadlock.
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

// ---------------------------------------------------------- AC2 / AC3 ---------
test('send returns the registered runId while the run is still in flight', async () => {
  await withHarness(async ({ control, runtime }) => {
    const result = await settleWithin(
      control.send(CALLER, { sessionId: SESSION_ID, content: 'hello' }),
      2_000,
      'send to return without the run ending',
    );

    // (a) The ordering reading: at the instant `send` resolved, the parked
    // provider run had not been released. This is a state assertion, not a
    // "returned within N ms" timing assertion.
    say(`(a) releasedAtReturn=${runtime.released} runCalledAtReturn=${runtime.called} result=${JSON.stringify(result)}`);
    assert.equal(runtime.released, false, 'send must resolve before the provider run is released');
    assert.ok(result.ok, `send must report the registered run (got ${JSON.stringify(result)})`);

    // The dispatched run really is in flight — the fake runtime is entered, and
    // releasing is still the test's to do.
    const entered = await waitFor(() => runtime.called, 1_000, 'the provider run to be entered');
    assert.equal(entered, true, 'the provider run is dispatched in the background');
    assert.equal(runtime.released, false, 'the run is still parked after send returned');
    assert.equal(runtime.runCalls.length, 1);
    assert.equal(runtime.runCalls[0].command, 'hello');

    // (b) The id is the registry's run, and that run is running.
    const run = chatRunRegistry.getRun(SESSION_ID);
    say(`(b) returnedRunId=${result.runId} registryRunId=${run?.runId} status=${run?.status}`);
    assert.equal(run?.runId, result.runId, 'the returned runId is the registered run');
    assert.equal(run?.status, 'running', 'the registered run is running');
  });
});

// ------------------------------------------------------------- AC4 -------------
test('releasing the run lets it complete, with no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    await withHarness(async ({ control, runtime }) => {
      const result = await settleWithin(
        control.send(CALLER, { sessionId: SESSION_ID, content: 'hello' }),
        2_000,
        'send to return without the run ending',
      );
      assert.ok(result.ok);
      await waitFor(() => runtime.called, 1_000, 'the provider run to be entered');

      runtime.release();
      const completed = await waitFor(
        () => chatRunRegistry.getRun(SESSION_ID)?.status === 'completed',
        1_000,
        'the run to complete after release',
      );

      // Give any rejection scheduled by the settlement a turn to surface.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      const status = chatRunRegistry.getRun(SESSION_ID)?.status;
      say(`(c) statusAfterRelease=${status} unhandledRejections=${unhandled.length}`);
      assert.equal(completed, true, 'the run completes after the provider releases');
      assert.equal(status, 'completed');
      assert.equal(unhandled.length, 0, 'no unhandled rejection is produced by the background run');
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ------------------------------------------------------------- AC5 -------------
test('an unknown session and a runtime-less provider are refused without registering a run', async () => {
  await withHarness(async ({ control, runtime }) => {
    // Unknown session => SESSION_NOT_FOUND, and nothing is registered under it.
    const missing = await control.send(CALLER, { sessionId: 'no-such-session', content: 'hello' });
    const missingRun = chatRunRegistry.getRun('no-such-session');
    say(`(d) missingSession=${JSON.stringify(missing)} missingGetRun=${String(missingRun)}`);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.code, 'SESSION_NOT_FOUND');
    }
    assert.equal(missingRun, undefined, 'an unknown session must register no run');

    // Provider with no runtime => UNSUPPORTED_PROVIDER, no run, no dispatch.
    runtime.setHasRuntime(false);
    const unsupported = await control.send(CALLER, { sessionId: SESSION_ID, content: 'hello' });
    const unsupportedRun = chatRunRegistry.getRun(SESSION_ID);
    say(`(d) unsupportedProvider=${JSON.stringify(unsupported)} unsupportedGetRun=${String(unsupportedRun)} runCalled=${runtime.called}`);
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) {
      assert.equal(unsupported.code, 'UNSUPPORTED_PROVIDER');
    }
    assert.equal(unsupportedRun, undefined, 'an unsupported provider must register no run');
    assert.equal(runtime.called, false, 'an unsupported provider must not reach the driver');
  });
});

// ------------------------------------------------------------- AC6 -------------
test('(e) the criterion file itself neither imports ws nor constructs a socket', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');

  // The needles are assembled from fragments so this guard's own source does
  // not contain the literals it searches for (a self-match would be a
  // permanent false positive, not a detection).
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
