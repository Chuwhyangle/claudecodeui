/**
 * AC-232 criterion — the five control verbs (`send`, `abort`, `cancelQueued`,
 * `stopTask`, `backgroundTask`) go through **one** injectable access entry, and
 * an unauthenticated caller is refused on all five with zero driver calls.
 *
 * The claim is read directly against `createChatControlService(deps)` — no
 * socket is ever constructed, and the file ends by asserting its own source
 * carries none. The fixture mirrors `chat-control-send.test.ts` (a temporary
 * `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` with an
 * injected fake runtime), minus its parked-run machinery: nothing here needs the
 * provider to stay in flight.
 *
 * Readings:
 *   (a) with a counting spy injected as `deps.assertSessionAccess` — delegating
 *       to the production entry, so the verdict is the real ownership answer —
 *       an authenticated caller drives all five verbs once: the spy is hit
 *       exactly five times, one increment per verb, and the same call also
 *       reaches each driver (`run`, `abort`, `cancelQueuedInput`,
 *       `controlStopTask`, `controlBackgroundTask` each exactly once), which is
 *       what shows the five hits are not a blanket refusal after the entry;
 *   (b) an unauthenticated caller (`userId` `null`, and the empty string `''`)
 *       is `FORBIDDEN` on all five, and every one of the five driver verbs is
 *       called zero times;
 *   (c) with **no** spy injected — the production `assertSessionAccess` default
 *       — the same five unauthenticated calls are refused and touch no driver,
 *       so the criterion does not pass on a double of its own;
 *   (AC5) the file neither imports `ws` nor constructs a socket.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// Same-module service imports (this criterion lives in the websocket module);
// `assertSessionAccess` is the shared entry and lives on the chat gateway service.
import { createChatControlService } from '@/modules/websocket/services/dispatch/chat-control.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { assertSessionAccess } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

const SESSION_ID = 'control-access-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-access ${line}`);
}

/** The caller shape the five verbs take: an authenticated WebSocket front end. */
type ProbeCaller = { userId: string | number | null; via: 'websocket' };

const AUTHENTICATED: ProbeCaller = { userId: 1, via: 'websocket' };

/** The five driver verbs whose call counts the criterion grades on. */
type DriverTally = {
  run: number;
  abort: number;
  cancelQueuedInput: number;
  controlStopTask: number;
  controlBackgroundTask: number;
};

const ZERO_TALLY: DriverTally = {
  run: 0,
  abort: 0,
  cancelQueuedInput: 0,
  controlStopTask: 0,
  controlBackgroundTask: 0,
};

type CountingRuntime = {
  readonly tally: DriverTally;
  runtime: ProviderRuntimeGateway;
};

/**
 * A runtime gateway that records every driver call, so "was the driver reached?"
 * is an observed count and never a guess. `hasRuntime` is always true, so a
 * refusal recorded below can only come from the access entry, not from an
 * unsupported provider.
 */
function createCountingRuntime(): CountingRuntime {
  const tally: DriverTally = { ...ZERO_TALLY };
  return {
    tally,
    runtime: {
      hasRuntime: () => true,
      run: async (_provider: LLMProvider, _command: string, _options: AnyRecord) => {
        tally.run += 1;
        return undefined;
      },
      abort: async (_provider: LLMProvider, _sessionId: string) => {
        tally.abort += 1;
        return true;
      },
      cancelQueuedInput: async () => {
        tally.cancelQueuedInput += 1;
        return 'withdrawn';
      },
      controlStopTask: async () => {
        tally.controlStopTask += 1;
        return 'requested';
      },
      controlBackgroundTask: async () => {
        tally.controlBackgroundTask += 1;
        return 'requested';
      },
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    },
  };
}

/** The context every reading runs against. */
type HarnessContext = {
  control: ReturnType<typeof createChatControlService>;
  runtime: CountingRuntime;
};

/**
 * Boots the control service against an isolated database with one session row
 * and the counting runtime. `options.assertSessionAccess`, when given, is
 * injected as the deps' access seam — otherwise the production default runs.
 * No socket is created anywhere in this file.
 */
async function withHarness(
  options: { assertSessionAccess?: (userId: unknown, session: unknown) => boolean },
  run: (context: HarnessContext) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-control-access-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Control access session', now, now, null);

    const runtime = createCountingRuntime();
    const control = options.assertSessionAccess
      ? createChatControlService({
          runtime: runtime.runtime,
          assertSessionAccess: options.assertSessionAccess as never,
        })
      : createChatControlService({ runtime: runtime.runtime });

    await run({ control, runtime });
  } finally {
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

/** The per-verb delta of a driver tally between two snapshots. */
function deltaOf(tally: DriverTally, before: DriverTally): DriverTally {
  return {
    run: tally.run - before.run,
    abort: tally.abort - before.abort,
    cancelQueuedInput: tally.cancelQueuedInput - before.cancelQueuedInput,
    controlStopTask: tally.controlStopTask - before.controlStopTask,
    controlBackgroundTask: tally.controlBackgroundTask - before.controlBackgroundTask,
  };
}

/**
 * Reads any control verb's result as the single word this criterion grades on.
 *
 * `send` and `abort` answer a structured value whose `code` states a refusal;
 * the other three answer the word directly. One reader, so a red lands on the
 * verb and not on the shape a particular verb happens to answer in.
 */
function verdictOf(result: unknown): string {
  if (typeof result === 'string') {
    return result.toUpperCase();
  }
  if (result && typeof result === 'object') {
    const value = result as { ok?: boolean; code?: string };
    return value.ok === true ? 'OK' : (value.code ?? 'NO-CODE');
  }
  return 'NO-VERDICT';
}

/** The verdicts of the five verbs, as the one word each is graded on. */
type FiveVerdicts = {
  send: string;
  abort: string;
  cancelQueued: string;
  stopTask: string;
  backgroundTask: string;
};

const FORBIDDEN_FIVE: FiveVerdicts = {
  send: 'FORBIDDEN',
  abort: 'FORBIDDEN',
  cancelQueued: 'FORBIDDEN',
  stopTask: 'FORBIDDEN',
  backgroundTask: 'FORBIDDEN',
};

/** Drives all five control verbs once for one caller, in a fixed order. */
async function driveAll(
  control: ReturnType<typeof createChatControlService>,
  caller: ProbeCaller,
): Promise<FiveVerdicts> {
  const send = await control.send(caller, { sessionId: SESSION_ID, content: 'access-probe' });
  const abort = await control.abort(caller, { sessionId: SESSION_ID });
  const cancelQueued = await control.cancelQueued(caller, {
    sessionId: SESSION_ID,
    messageUuid: 'msg-probe',
  });
  const stopTask = await control.stopTask(caller, { sessionId: SESSION_ID, taskId: 'task-probe' });
  const backgroundTask = await control.backgroundTask(caller, {
    sessionId: SESSION_ID,
    toolUseId: 'tool-probe',
  });
  return {
    send: verdictOf(send),
    abort: verdictOf(abort),
    cancelQueued: verdictOf(cancelQueued),
    stopTask: verdictOf(stopTask),
    backgroundTask: verdictOf(backgroundTask),
  };
}

// ------------------------------------------------------- AC2 (a) --------------
test('(a) all five control verbs share one injected access entry, then reach their drivers', async () => {
  // The counting spy: delegates to the production entry (so its verdict is the
  // real ownership answer) and records every call, so the five verbs can be
  // shown to hit the SAME function exactly once each.
  const entryCalls: Array<{ userId: unknown; sessionId: unknown }> = [];
  await withHarness(
    {
      assertSessionAccess: (userId, session) => {
        entryCalls.push({
          userId,
          sessionId: (session as AnyRecord | null)?.session_id ?? null,
        });
        return assertSessionAccess(userId as never, session as never);
      },
    },
    async ({ control, runtime }) => {
      const before = entryCalls.length;

      await control.send(AUTHENTICATED, { sessionId: SESSION_ID, content: 'access-probe' });
      const afterSend = entryCalls.length;
      await control.abort(AUTHENTICATED, { sessionId: SESSION_ID });
      const afterAbort = entryCalls.length;
      await control.cancelQueued(AUTHENTICATED, { sessionId: SESSION_ID, messageUuid: 'msg-probe' });
      const afterCancel = entryCalls.length;
      await control.stopTask(AUTHENTICATED, { sessionId: SESSION_ID, taskId: 'task-probe' });
      const afterStop = entryCalls.length;
      await control.backgroundTask(AUTHENTICATED, { sessionId: SESSION_ID, toolUseId: 'tool-probe' });
      const afterBackground = entryCalls.length;

      const increments = {
        send: afterSend - before,
        abort: afterAbort - afterSend,
        cancelQueued: afterCancel - afterAbort,
        stopTask: afterStop - afterCancel,
        backgroundTask: afterBackground - afterStop,
        total: afterBackground - before,
      };
      const reading = {
        increments,
        sessionIds: entryCalls.map((call) => call.sessionId),
        drivers: { ...runtime.tally },
      };
      say(`(a) ${JSON.stringify(reading)}`);

      // Each verb hit the one entry exactly once, carrying this session (so the
      // five calls are the five verbs' own checks).
      assert.deepEqual(increments, {
        send: 1,
        abort: 1,
        cancelQueued: 1,
        stopTask: 1,
        backgroundTask: 1,
        total: 5,
      });
      assert.deepEqual(reading.sessionIds, [SESSION_ID, SESSION_ID, SESSION_ID, SESSION_ID, SESSION_ID]);

      // The positive control: the same authenticated calls really went past the
      // entry to each driver, so the five hits are not a blanket refusal.
      assert.deepEqual(reading.drivers, {
        run: 1,
        abort: 1,
        cancelQueuedInput: 1,
        controlStopTask: 1,
        controlBackgroundTask: 1,
      });
    },
  );
});

// ------------------------------------------------------- AC3 (b) --------------
test('(b) an unauthenticated caller is FORBIDDEN on all five, reaching no driver', async () => {
  const entryCalls: unknown[] = [];
  await withHarness(
    {
      assertSessionAccess: (userId, session) => {
        entryCalls.push(userId);
        return assertSessionAccess(userId as never, session as never);
      },
    },
    async ({ control, runtime }) => {
      const callers: Array<{ label: string; caller: ProbeCaller }> = [
        { label: 'null', caller: { userId: null, via: 'websocket' } },
        { label: 'empty-string', caller: { userId: '', via: 'websocket' } },
      ];

      for (const { label, caller } of callers) {
        const before = { ...runtime.tally };
        const verdicts = await driveAll(control, caller);
        const drivers = deltaOf(runtime.tally, before);
        say(`(b) caller=${label} verdicts=${JSON.stringify(verdicts)} drivers=${JSON.stringify(drivers)}`);

        assert.deepEqual(verdicts, FORBIDDEN_FIVE, `caller ${label} must be refused on all five`);
        assert.deepEqual(drivers, ZERO_TALLY, `caller ${label} must reach no driver`);
      }

      say(`(b) entryCalls=${entryCalls.length}`);
      assert.equal(entryCalls.length, 10, 'each of the two unauthenticated callers hits the one entry five times');
    },
  );
});

// ------------------------------------------------------- AC4 (c) --------------
test('(c) the production default entry refuses the same five calls with no injected spy', async () => {
  // No `assertSessionAccess` is injected: this arm runs the shipped
  // `assertSessionAccess` default, so the refusal cannot come from a double.
  await withHarness({}, async ({ control, runtime }) => {
    const before = { ...runtime.tally };
    const verdicts = await driveAll(control, { userId: null, via: 'websocket' });
    const drivers = deltaOf(runtime.tally, before);
    say(`(c) verdicts=${JSON.stringify(verdicts)} drivers=${JSON.stringify(drivers)}`);

    assert.deepEqual(verdicts, FORBIDDEN_FIVE, 'the production entry must refuse all five');
    assert.deepEqual(drivers, ZERO_TALLY, 'the production entry refusal must reach no driver');
  });
});

// -------------------------------------------------------------- AC5 -----------
test('(AC5) the criterion file itself neither imports ws nor constructs a socket', async () => {
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

  say(`(AC5) socketReferences=${JSON.stringify(needles.map((needle) => needle.label))}`);
  assert.deepEqual(
    needles.map((needle) => needle.label),
    [],
    'the criterion must import no ws, construct no socket, and build no emitter to stand in for one',
  );
});
