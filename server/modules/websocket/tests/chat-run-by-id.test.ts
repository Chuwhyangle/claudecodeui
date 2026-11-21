/**
 * AC-235 criterion — a run is addressable by its own `runId`, not only by its
 * session. Where `chat-control-busy.test.ts` proves the *control plane* hands a
 * caller two run ids, this proves the *registry* can answer for each of them:
 * the superseded run and the current run are both reachable, a run's summary is
 * a fixed seven-field read-only projection, an aborted run reads back
 * `aborted` (not `completed`), and the retention window and clock are
 * injectable so `expired` is reachable by moving a fake clock rather than
 * waiting.
 *
 * The claim has five readings, each a *state* observation against an isolated
 * registry built with `createChatRunRegistry({ retentionMs, now })` — never the
 * process-wide singleton:
 *
 *   (a) the same session's first run (superseded) and its second run are both
 *       reachable through `getRunById`, each under its own id and status;
 *   (b) a run completed with `aborted: true` reads back `status: 'aborted'`
 *       with exactly the seven summary fields;
 *   (c) the injected clock moves a completed run from a readable summary to
 *       `{ status: 'unknown', reason: 'expired' }`, while an id that was never
 *       handed out answers `{ status: 'unknown', reason: 'unknown' }`;
 *   (d) `getRun(sessionId)` still follows the session and returns the newest
 *       run after a supersede;
 *   (e) `replayEvents(sessionId, afterSeq, runId)` is byte-for-byte the same
 *       frame sequence it was before this task, checked against a fixed
 *       expected array.
 *
 * The fixture mirrors `chat-control-busy.test.ts` — a temporary `DATABASE_PATH`
 * + `initializeDatabase` + `sessionsDb.createSession` — minus any socket
 * harness: nothing here constructs a `WebSocket`, an `EventEmitter`, or any
 * stand-in for the transport.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// Same-module service import (this criterion lives in the websocket module).
import {
  createChatRunRegistry,
  type ChatRunLookupResult,
  type ChatRunSummary,
} from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';

const SESSION_ID = 'run-by-id-session';
const PROVIDER = 'claude';
const NATIVE_SESSION_ID = 'native-run-by-id';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`run-by-id ${line}`);
}

/**
 * True only for a summary result. The summary carries `runId`; the miss shape
 * does not, so `in` is a sufficient and stable discriminator.
 */
function isSummary(result: ChatRunLookupResult | undefined): result is ChatRunSummary {
  return result !== undefined && 'runId' in result;
}

/** The registry instance type this criterion drives (one per case). */
type Registry = ReturnType<typeof createChatRunRegistry>;

/**
 * Boots an isolated database and an isolated registry, runs `run`, and tears
 * both down. No socket is created anywhere in this file.
 */
async function withRegistry(
  options: { retentionMs?: number; now?: () => number },
  run: (registry: Registry) => void | Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-run-by-id-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, PROVIDER, tempDirectory, 'Run by id session', now, now, null);

    await run(createChatRunRegistry(options));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Starts a run on `registry`, failing loudly rather than returning null. */
function startRun(
  registry: Registry,
  overrides: { source?: ChatRunSummary['source']; supersedeRunning?: boolean } = {},
): NonNullable<ReturnType<Registry['startRun']>> {
  const run = registry.startRun({
    appSessionId: SESSION_ID,
    provider: PROVIDER,
    providerSessionId: null,
    connection: null,
    userId: null,
    ...overrides,
  });
  assert.ok(run, 'startRun must register a run');
  return run;
}

// ---------------------------------------------------------- AC2 (a) -----------
test('(a) a superseded run and the current run are both addressable by their ids', async () => {
  const clock = 1_000_000;
  await withRegistry({ now: () => clock }, (registry) => {
    const run1 = startRun(registry, { source: 'user' });
    const run2 = startRun(registry, { source: 'user', supersedeRunning: true });
    assert.notEqual(run1.runId, run2.runId, 'the second run is a run of its own');

    const byId1 = registry.getRunById(run1.runId);
    const byId2 = registry.getRunById(run2.runId);
    say(`(a) getRunById(runId1)=${JSON.stringify(byId1)} getRunById(runId2)=${JSON.stringify(byId2)}`);

    assert.ok(isSummary(byId1), `runId1 must still be addressable (got ${JSON.stringify(byId1)})`);
    assert.ok(isSummary(byId2), `runId2 must be addressable (got ${JSON.stringify(byId2)})`);
    assert.equal(byId1.runId, run1.runId, 'runId1 resolves to run 1');
    assert.equal(byId2.runId, run2.runId, 'runId2 resolves to run 2');
    // The superseded run keeps its own status: it was never completed by the
    // supersede, so both are still running, independently.
    assert.equal(byId1.status, 'running', 'the superseded run is not marked terminal by the replacement');
    assert.equal(byId2.status, 'running', 'the current run is running');
  });
});

// ---------------------------------------------------------- AC3 (b) -----------
test('(b) an aborted run reads back aborted with exactly the seven summary fields', async () => {
  let clock = 5_000;
  await withRegistry({ now: () => clock }, (registry) => {
    startRun(registry, { source: 'user' });
    const run2 = startRun(registry, { source: 'user', supersedeRunning: true });

    clock = 5_500;
    // The abort path's synthetic terminal event: `completeRun(..., aborted: true)`
    // becomes a `complete` message carrying `aborted: true`.
    registry.completeRun(SESSION_ID, { exitCode: 1, aborted: true });

    const summary = registry.getRunById(run2.runId);
    say(`(b) summary=${JSON.stringify(summary)}`);
    assert.ok(isSummary(summary), `runId2 must read back a summary (got ${JSON.stringify(summary)})`);

    // Exactly the seven fields, sorted for an order-independent read.
    assert.deepEqual(
      Object.keys(summary).sort(),
      ['completedAt', 'lastSeq', 'runId', 'sessionId', 'source', 'startedAt', 'status'],
    );
    assert.equal(summary.runId, run2.runId);
    assert.equal(summary.sessionId, SESSION_ID);
    assert.equal(summary.source, 'user');
    assert.equal(summary.status, 'aborted', 'a cancelled run must not be flattened to completed');
    assert.equal(summary.startedAt, 5_000, 'startedAt comes from the injected clock at startRun');
    assert.equal(summary.completedAt, 5_500, 'completedAt comes from the injected clock at completion');
    assert.equal(typeof summary.completedAt, 'number');
    assert.equal(summary.lastSeq, 1, 'the terminal complete was the run\'s first sequenced event');
  });
});

// ---------------------------------------------------------- AC4 (c) -----------
test('(c) the injected clock moves a run from a summary to expired, and unknown is separate', async () => {
  const retentionMs = 1_000;
  let clock = 100_000;
  await withRegistry({ retentionMs, now: () => clock }, (registry) => {
    const run = startRun(registry, { source: 'user' });
    registry.completeRun(SESSION_ID, { exitCode: 0 });
    const completedAt = clock;
    say(`(c) injected retentionMs=${retentionMs} clockAtCompletion=${completedAt}`);

    // Inside the window (the boundary is `> retentionMs`, so exactly at the
    // edge is still a hit).
    clock = completedAt + retentionMs;
    const within = registry.getRunById(run.runId);

    // Past the window: the same id, on the same registry, now misses as expired.
    clock = completedAt + retentionMs + 1;
    const expired = registry.getRunById(run.runId);

    // An id that was never handed out is a different miss.
    const never = randomUUID();
    const unknown = registry.getRunById(never);
    say(`(c) clockWithin=${completedAt + retentionMs} within=${JSON.stringify(within)} ` +
      `clockPast=${clock} expired=${JSON.stringify(expired)} ` +
      `never=${never} unknown=${JSON.stringify(unknown)}`);

    assert.ok(isSummary(within), 'a completed run is readable inside the retention window');
    assert.equal(within.status, 'completed');
    assert.deepEqual(expired, { status: 'unknown', reason: 'expired' });
    assert.deepEqual(unknown, { status: 'unknown', reason: 'unknown' });
  });
});

// ---------------------------------------------------------- AC5 (d) -----------
test('(d) one current run per session is unchanged: getRun returns the newest run', async () => {
  const clock = 2_000_000;
  await withRegistry({ now: () => clock }, (registry) => {
    const run1 = startRun(registry, { source: 'user' });
    const run2 = startRun(registry, { source: 'user', supersedeRunning: true });

    const current = registry.getRun(SESSION_ID);
    say(`(d) currentRunId=${current?.runId} run1=${run1.runId} run2=${run2.runId}`);
    assert.equal(current?.runId, run2.runId, 'the session slot follows the newest run');
  });
});

// ---------------------------------------------------------- AC6 (e) -----------
test('(e) replayEvents returns the same frames it did before this task', async () => {
  const clock = 3_000_000;
  await withRegistry({ now: () => clock }, (registry) => {
    const run = startRun(registry, { source: 'user' });

    // Explicit ids/timestamps so the frames are deterministic: the writer
    // spreads the message it is handed and only overwrites sessionId/seq/runId.
    run.writer.send({ id: 'm1', timestamp: '2026-01-01T00:00:00.000Z', kind: 'stream_delta', provider: PROVIDER, sessionId: NATIVE_SESSION_ID, content: 'e1' });
    run.writer.send({ id: 'm2', timestamp: '2026-01-01T00:00:01.000Z', kind: 'text', provider: PROVIDER, sessionId: NATIVE_SESSION_ID, content: 'e2' });
    run.writer.send({ id: 'm3', timestamp: '2026-01-01T00:00:02.000Z', kind: 'stream_delta', provider: PROVIDER, sessionId: NATIVE_SESSION_ID, content: 'e3' });

    const fromStart = registry.replayEvents(SESSION_ID, 0, run.runId);
    const fromOne = registry.replayEvents(SESSION_ID, 1, run.runId);
    say(`(e) fromStart=${JSON.stringify(fromStart)} fromOne=${JSON.stringify(fromOne)}`);

    const expectedAll = [
      { id: 'm1', timestamp: '2026-01-01T00:00:00.000Z', kind: 'stream_delta', provider: PROVIDER, sessionId: SESSION_ID, content: 'e1', seq: 1, runId: run.runId },
      { id: 'm2', timestamp: '2026-01-01T00:00:01.000Z', kind: 'text', provider: PROVIDER, sessionId: SESSION_ID, content: 'e2', seq: 2, runId: run.runId },
      { id: 'm3', timestamp: '2026-01-01T00:00:02.000Z', kind: 'stream_delta', provider: PROVIDER, sessionId: SESSION_ID, content: 'e3', seq: 3, runId: run.runId },
    ];

    assert.deepEqual(fromStart, expectedAll);
    assert.deepEqual(fromOne, expectedAll.slice(1));
  });
});

// ---------------------------------------------------------- AC7 (f) -----------
test('(f) retention comes from CHAT_RUN_RETENTION_MS when unset on the option, else the 5-minute default', async () => {
  const previousRetention = process.env.CHAT_RUN_RETENTION_MS;
  try {
    // No `retentionMs` option: the window is read from the environment instead,
    // and the injected clock still decides expiry.
    process.env.CHAT_RUN_RETENTION_MS = '1000';
    let clock = 10_000;
    await withRegistry({ now: () => clock }, (registry) => {
      const run = startRun(registry, { source: 'user' });
      registry.completeRun(SESSION_ID, { exitCode: 0 });
      clock = 10_000 + 1_001;
      const expired = registry.getRunById(run.runId);
      say(`(f) env CHAT_RUN_RETENTION_MS=1000 clock=${clock} expired=${JSON.stringify(expired)}`);
      assert.deepEqual(expired, { status: 'unknown', reason: 'expired' });
    });

    // Neither option nor env: the default 5-minute window applies.
    delete process.env.CHAT_RUN_RETENTION_MS;
    let clock2 = 20_000;
    await withRegistry({ now: () => clock2 }, (registry) => {
      const run = startRun(registry, { source: 'user' });
      registry.completeRun(SESSION_ID, { exitCode: 0 });
      clock2 = 20_000 + 60_000;
      const within = registry.getRunById(run.runId);
      clock2 = 20_000 + 5 * 60 * 1000 + 1;
      const expired = registry.getRunById(run.runId);
      say(`(f) default clockWithin=${20_000 + 60_000} within=${JSON.stringify(within)} ` +
        `clockPast=${clock2} expired=${JSON.stringify(expired)}`);
      assert.ok(isSummary(within), 'a run is still readable one minute after completing');
      assert.equal(within.status, 'completed');
      assert.deepEqual(expired, { status: 'unknown', reason: 'expired' }, 'the default window is five minutes');
    });
  } finally {
    if (previousRetention === undefined) {
      delete process.env.CHAT_RUN_RETENTION_MS;
    } else {
      process.env.CHAT_RUN_RETENTION_MS = previousRetention;
    }
  }
});
