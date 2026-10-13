/**
 * Criterion for a resident host settling a turn the CLI MERGED from several
 * queued messages.
 *
 * A resident Claude host holds one CLI across turns, and that CLI owns its own
 * input queue. The queue is drained at a turn boundary, and every entry it
 * drains at that boundary is merged into ONE turn: measured 2026-10-13
 * (session `74ba573d`), two busily-queued voice sends produced two `enqueue`
 * rows, two `dequeue` rows in the same millisecond, and a single user message
 * carrying both texts — so the CLI emitted ONE `result` for the two of them.
 *
 * The driver used to settle one round per `result` (`state.rounds.shift()`), so
 * a merged turn left every round but the front one in the FIFO forever: its run
 * never received a terminal `complete` and stayed `running` in
 * `/api/providers/sessions/running`. The offset never healed — every later busy
 * send left one more round waiting on a `result` that had already arrived — so
 * the newest run, keyed by the busy send's own moment as `startedAt`, stayed
 * `running` for good. This criterion is that reading: a resident host must
 * settle every round the CLI merged into the turn that one `result` ends, and
 * must NOT settle a round the CLI runs as a turn of its own afterwards.
 *
 * The criterion has two arms:
 *
 * 1. A scripted-process arm (the injected `createProcess` seam) driven through
 *    the real `run` entry and the real private message-fold loop (`observe`),
 *    so what is measured is the driver's own settlement path rather than a copy
 *    of it. It feeds a CLI-shaped frame sequence — `A.result`, the dequeue
 *    (`command_lifecycle started`) of the two busily-queued messages B and C,
 *    then the single merged `result` — and reads, per run, exactly one terminal
 *    `complete`, an empty round FIFO, and no leaked `turn` lease. Its negative
 *    leg feeds B and C as two separate turns and reads that B's `result` settles
 *    B alone.
 * 2. A real-`claude`-binary arm (a real `claude` binary, an Anthropic-compatible
 *    endpoint standing in for the model, a temporary `DATABASE_PATH` /
 *    `CLAUDE_CONFIG_DIR`) that keeps one long `Bash` turn in flight, pushes two
 *    commands while it runs, and reads that the CLI merged them into one turn
 *    and that `listRunningRuns()` is empty once it settles. If the CLI does NOT
 *    merge (two turns), the criterion prints `cliMergedIntoOneTurn=false` and
 *    reds rather than treating the absence of a merge as green.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, so a resident lifecycle that hangs is a budget kill
 *   with its own reading, as in the sibling resident criteria.
 * - Every reading is taken before anything is asserted, so a red lands on the
 *   reading that is wrong rather than on a timeout or on an earlier leg.
 * - The negative leg drives the SAME named readings the positive leg does, so a
 *   fix that simply "cleared the whole FIFO on any result" would pass the
 *   positive leg and red the negative one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  providerModelsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  providerRoutes,
  providerRegistry,
  createProviderRuntimeService,
} from '@/modules/providers/index.js';
import { createSessionHostsRouter, createSessionHostManager, sessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import {
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  AnyRecord,
  ProviderModelEnvRow,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION_ID = 'claude-resident-merged-queued-turn-session';
/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-merged-queued-custom-model';
const MODEL_SECRET = 'resident-merged-queued-model-row-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** The provider-native id the scripted arm keys its frames by. */
const PROVIDER_SESSION_ID = 'b827aab6-2114-4fe2-b1af-991a6c2285e1';

/** How long the real-`claude` arm gives one turn to reach rest. */
const TURN_TIMEOUT_MS = 20_000;
/** The bound the criterion itself reports the whole run against. */
const ELAPSED_LIMIT_MS = 60_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the merged-queued-turn criterion did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, ELAPSED_LIMIT_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// Scripted-process arm
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this arm is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * A resident process the arm owns: a stream it pushes into, in order.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every reading
 * into a reading of a dead process.
 */
function createFakeProcess(): { factory: ClaudeResidentProcessFactory; emit(frame: AnyRecord): void } {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];

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

  return {
    factory: () => ({ query, pid: 4242 }) satisfies ClaudeResidentProcess,
    emit: push,
  };
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

/** The CLI's own account of dequeuing one queued message into a turn. */
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

/** Polls the manager's lease reading, letting the async `run` entry make progress. */
async function waitForTurnLeases(
  manager: SessionHostManager,
  sessionId: string,
  count: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (turnLeaseCount(manager, sessionId) >= count) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  return false;
}

/**
 * Builds the scripted arm's driver and manager, and arms three rounds: a cold A
 * in flight, and B and C queued behind it.
 *
 * `run` is not awaited — a round settles only once this arm has pushed its
 * frames, so awaiting it here would deadlock. The promises are returned so the
 * caller can drain them at the end.
 */
async function armThreeRounds(): Promise<{
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: { emit(frame: AnyRecord): void };
  writers: { a: ReturnType<typeof createRecordingWriter>; b: ReturnType<typeof createRecordingWriter>; c: ReturnType<typeof createRecordingWriter> };
  rounds: Promise<void>[];
}> {
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

  const a = createRecordingWriter();
  const roundA = driver.run(SESSION_ID, { command: 'A in flight', options: {} }, a.writer, CONTEXT);
  assert.ok(await waitForTurnLeases(manager, SESSION_ID, 1, 5_000), 'the cold round A must arm its turn lease');

  const b = createRecordingWriter();
  const roundB = driver.run(SESSION_ID, { command: 'B queued', options: {} }, b.writer, CONTEXT);
  assert.ok(await waitForTurnLeases(manager, SESSION_ID, 2, 5_000), 'the busy round B must arm its turn lease');

  const c = createRecordingWriter();
  const roundC = driver.run(SESSION_ID, { command: 'C queued', options: {} }, c.writer, CONTEXT);
  assert.ok(await waitForTurnLeases(manager, SESSION_ID, 3, 5_000), 'the busy round C must arm its turn lease');

  return { manager, driver, process, writers: { a, b, c }, rounds: [roundA, roundB, roundC] };
}

test('AC2 a merged queued turn settles every round it merged, not just the front one', async () => {
  const { manager, driver, process, writers, rounds } = await armThreeRounds();

  // The two busily-queued messages, in the order they were written.
  const reading = driver.busyInputReading(SESSION_ID);
  assert.ok(reading, 'the resident host must be readable once three rounds are armed');
  assert.strictEqual(reading.queuedInputs.length, 2, `B and C must each have a queue record (read ${reading.queuedInputs.length})`);
  const [bInput, cInput] = reading.queuedInputs;

  // The CLI-shaped sequence: A ends, then B and C are dequeued together (one
  // dequeue, so one merged turn), then the single `result` that ends it.
  process.emit(resultFrame());
  await settle();
  process.emit(startedFrame(bInput.uuid));
  process.emit(startedFrame(cInput.uuid));
  await settle();
  process.emit(resultFrame());
  await settle();

  const after = driver.busyInputReading(SESSION_ID);
  assert.ok(after, 'the resident host must still be readable at rest');
  const roundsPushed = 3;
  const resultsObserved = after.resultTimes.length;
  const completeFrames = writers.a.completeCount() + writers.b.completeCount() + writers.c.completeCount();
  const roundsOpen = after.roundsOpen;
  const turnLeasesOpen = turnLeaseCount(manager, SESSION_ID);
  console.log(
    `roundsPushed=${roundsPushed} resultsObserved=${resultsObserved} completeFrames=${completeFrames} ` +
      `roundsOpen=${roundsOpen} turnLeasesOpen=${turnLeasesOpen}`,
  );
  console.log(
    `completeCount: A=${writers.a.completeCount()} B=${writers.b.completeCount()} C=${writers.c.completeCount()}`,
  );

  assert.strictEqual(resultsObserved, 2, 'the CLI sent two results (A, then the merged B+C turn)');
  assert.strictEqual(writers.a.completeCount(), 1, 'A received exactly one terminal complete');
  assert.strictEqual(writers.b.completeCount(), 1, 'B received exactly one terminal complete');
  assert.strictEqual(writers.c.completeCount(), 1, 'C received exactly one terminal complete');
  assert.strictEqual(completeFrames, 3, `every round got a terminal frame (read ${completeFrames})`);
  assert.strictEqual(roundsOpen, 0, `the round FIFO must be empty at rest (read ${roundsOpen})`);
  assert.strictEqual(turnLeasesOpen, 0, `no turn lease may be leaked (read ${turnLeasesOpen})`);

  await Promise.allSettled(rounds);
});

test('AC3 a queued round the CLI runs as its own turn is not settled by the previous result', async () => {
  const { manager, driver, process, writers, rounds } = await armThreeRounds();

  const reading = driver.busyInputReading(SESSION_ID);
  assert.ok(reading, 'the resident host must be readable once three rounds are armed');
  const [bInput, cInput] = reading.queuedInputs;

  // A ends; B is dequeued and runs as its own turn; only then is C dequeued.
  process.emit(resultFrame());
  await settle();
  process.emit(startedFrame(bInput.uuid));
  await settle();

  const completesBeforeFirstResult = writers.a.completeCount() + writers.b.completeCount() + writers.c.completeCount();
  process.emit(resultFrame()); // ends B's turn
  await settle();

  const completesAfterFirstResult = writers.a.completeCount() + writers.b.completeCount() + writers.c.completeCount();
  const settledAfterFirstResult = completesAfterFirstResult - completesBeforeFirstResult;
  const roundsOpenAfterFirstResult = driver.busyInputReading(SESSION_ID)?.roundsOpen ?? -1;
  console.log(`settledAfterFirstResult=${settledAfterFirstResult} roundsOpenAfterFirstResult=${roundsOpenAfterFirstResult}`);
  assert.strictEqual(settledAfterFirstResult, 1, 'B\'s result settles B alone, not the not-yet-started C');
  assert.strictEqual(roundsOpenAfterFirstResult, 1, 'C must still be waiting for its own result');

  // C is dequeued and runs as a turn of its own; its own result settles it.
  process.emit(startedFrame(cInput.uuid));
  await settle();
  process.emit(resultFrame());
  await settle();

  const roundsOpenAfterSecondResult = driver.busyInputReading(SESSION_ID)?.roundsOpen ?? -1;
  console.log(`roundsOpenAfterSecondResult=${roundsOpenAfterSecondResult}`);
  assert.strictEqual(roundsOpenAfterSecondResult, 0, 'C is settled by its own result');
  assert.strictEqual(writers.c.completeCount(), 1, 'C received exactly one terminal complete');
  assert.strictEqual(turnLeaseCount(manager, SESSION_ID), 0, 'no turn lease may be leaked at rest');

  await Promise.allSettled(rounds);
});

// ---------------------------------------------------------------------------
// Real-`claude`-binary arm
// ---------------------------------------------------------------------------

type Received = { url: string; body: string; authorization: string | undefined; apiKey: string | undefined };

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  agentRequests(): number;
  close(): Promise<void>;
};

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A minimal valid streaming `/v1/messages` reply carrying `text`. */
function textStream(text: string): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** A reply that asks for one foreground `Bash` call. */
function bashToolStream(command: string): string {
  const partial = JSON.stringify({ command, run_in_background: false, description: 'hold the turn open' });
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_tool', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_merged_1', name: 'Bash', input: {} },
    }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** How long the in-flight Bash turn stays busy, so the two pushes land behind it. */
const IN_FLIGHT_BASH = 'sleep 8; echo MERGED_ARM_IN_FLIGHT_DONE';

/**
 * An Anthropic-compatible endpoint that answers the conversation this arm drives.
 *
 * A request is an *agent* request when its body declares tool schemas (the SDK's
 * auxiliary title/small-model prompts carry none on the same path with the same
 * credential). Answered by position: the first asks for the long in-flight
 * `Bash`, and everything after it — the close-out of that turn and the merged
 * turn's own turn — streams a short text.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  let agentCount = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({
        url,
        body,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      });

      const answer = (payload: string) => {
        if (response.writableEnded || response.destroyed) {
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(payload);
      };

      if (url.split('?')[0] !== '/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }

      if (!body.includes('"input_schema"')) {
        answer(textStream('aux ok'));
        return;
      }

      agentCount += 1;
      if (agentCount === 1) {
        answer(bashToolStream(IN_FLIGHT_BASH));
        return;
      }
      answer(textStream('turn closed'));
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${address.port}`,
    agentRequests: () => agentCount,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

type FakeSocket = EventEmitter & {
  readyState: number;
  OPEN: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.OPEN = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  };
  socket.close = () => { socket.readyState = 3; };
  return socket;
}

/** Polls a predicate and answers whether it held, without failing the case. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  console.log(`[readings] waitFor timed out after ${timeoutMs}ms: ${label}`);
  return false;
}

/** The model entry that points the CLI at the mock endpoint. */
function modelRows(baseUrl: string): ProviderModelEnvRow[] {
  return [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
}

/** The host driver this arm reads its readings off. */
function residentDriver(): ClaudeResidentHostDriver {
  return providerRegistry.resolveProvider('claude').hostDriver as unknown as ClaudeResidentHostDriver;
}

/** Resolves the real `claude` binary, or null — the arm must not skip or run empty. */
function claudeBinaryPath(): string | null {
  const found = spawnSync('which', ['claude'], { encoding: 'utf8' });
  const resolved = found.status === 0 ? found.stdout.trim() : '';
  return resolved.length > 0 ? resolved : null;
}

/** Sends one `chat.send` without waiting for it — the busy pushes are what this arm times. */
function sendChat(socket: FakeSocket, content: string, cwd: string): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: SESSION_ID,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'bypassPermissions' },
  }));
}

test('AC5 the real CLI merges two busily-queued commands into one turn and the runs settle', { timeout: 120_000 }, async () => {
  const binary = claudeBinaryPath();
  console.log(`claudeBinary=${binary ?? ''}`);
  assert.ok(binary, 'the real `claude` binary must be resolvable — the real arm may not skip or run empty');

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-merged-'));
  const configDir = path.join(tempDirectory, 'claude-config');
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  const mock = await startMockAnthropic();
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use('/api/session-hosts', createSessionHostsRouter({ sessionHostManager }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // A dead host endpoint, so a run that ignored the model entry can never
    // reach the mock: reaching it is evidence that the entry was consulted.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    await initializeDatabase();
    const user = userDb.createUser('claude-resident-merged', 'unused-hash');

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Resident merged queued turn', now, now, null);
    // An app-created row carries its own id as the provider id until a real
    // provider session exists. Nulled so the host launches a fresh CLI rather
    // than resuming a session that never was (`--resume` rejects a non-UUID).
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', {
      id: MODEL_ID,
      model: MODEL_ID,
      config: { env: modelRows(mock.baseUrl) },
    });
    assert.strictEqual(sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident'), true);
    assert.strictEqual(sessionsDb.getSessionLifecycleMode(SESSION_ID), 'resident');

    chatRunRegistry.clearAll();
    const socket = createFakeSocket();
    const runtime = createProviderRuntimeService();
    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    // A long foreground `Bash` turn is in flight …
    sendChat(socket, 'AC-MERGED start a long in-flight Bash turn', tempDirectory);
    const inFlight = await waitFor(
      () => chatRunRegistry.isProcessing(SESSION_ID) && mock.agentRequests() >= 1,
      TURN_TIMEOUT_MS,
      'the in-flight Bash turn to start',
    );
    if (!inFlight) {
      // Taken without asserting, so a red lands on the reading that is wrong:
      // whether the CLI ever started, what the mock was asked for, and how many
      // hosts exist are the three facts that tell a startup failure from a
      // settlement failure.
      console.log(
        `[readings] the in-flight turn never started: isProcessing=${chatRunRegistry.isProcessing(SESSION_ID)} ` +
          `agentRequests=${mock.agentRequests()} received=${mock.received.length} ` +
          `urls=${JSON.stringify(mock.received.map((r) => r.url))} ` +
          `hosts=${sessionHostManager.snapshot().length} ` +
          `frames=${JSON.stringify(socket.frames.map((f) => (f.kind as string) ?? (f.type as string) ?? 'unknown'))}`,
      );
    }
    assert.ok(inFlight, 'the long Bash turn must be in flight before the two pushes');

    // … and two commands are pushed while it runs. Each is a superseding run.
    sendChat(socket, 'AC-MERGED first queued command', tempDirectory);
    sendChat(socket, 'AC-MERGED second queued command', tempDirectory);

    const atRest = await waitFor(
      () => chatRunRegistry.listRunningRuns().length === 0,
      TURN_TIMEOUT_MS * 2,
      'every run to settle once the merged turn ends',
    );

    const driver = residentDriver();
    const reading = driver.busyInputReading(SESSION_ID);
    assert.ok(reading, 'the resident host must be readable');
    const totalResults = reading.resultTimes.length;
    // The in-flight turn is one result; everything above that is what the two
    // pushed commands cost. A CLI that merged them costs exactly one more.
    const resultsObserved = totalResults - 1;
    const cliMergedIntoOneTurn = resultsObserved === 1;
    const runsOpenAtRest = chatRunRegistry.listRunningRuns().length;
    const roundsOpenAtRest = reading.roundsOpen;
    console.log(
      `cliMergedIntoOneTurn=${cliMergedIntoOneTurn} resultsObserved=${resultsObserved} runsOpenAtRest=${runsOpenAtRest} ` +
        `roundsOpenAtRest=${roundsOpenAtRest} totalResults=${totalResults} agentRequests=${mock.agentRequests()}`,
    );

    assert.ok(atRest, `every run must settle (runsOpenAtRest=${runsOpenAtRest})`);
    assert.strictEqual(runsOpenAtRest, 0, 'listRunningRuns() must be empty once the merged turn settles');
    assert.deepStrictEqual(
      chatRunRegistry.listRunningRuns(),
      [],
      'listRunningRuns() must be an empty array at rest',
    );
    assert.strictEqual(
      cliMergedIntoOneTurn,
      true,
      `the CLI must merge the two busily-queued commands into one turn (resultsObserved=${resultsObserved})`,
    );
    assert.strictEqual(roundsOpenAtRest, 0, 'no round may be left in the FIFO at rest');

    connectedClients.clear();
  } finally {
    for (const host of sessionHostManager.snapshot()) {
      if (host.state !== 'closed') {
        sessionHostManager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    for (const host of sessionHostManager.snapshot()) {
      if (host.pid) {
        try {
          process.kill(host.pid, 'SIGKILL');
        } catch {
          // Already gone between the check and the kill.
        }
      }
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    await mock.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the criterion finished inside its wall-clock budget', () => {
  const elapsed = Date.now() - STARTED_AT;
  console.log(`[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=0`);
  assert.ok(elapsed < ELAPSED_LIMIT_MS, `the criterion finished in ${elapsed}ms, under its ${ELAPSED_LIMIT_MS}ms budget`);
});
