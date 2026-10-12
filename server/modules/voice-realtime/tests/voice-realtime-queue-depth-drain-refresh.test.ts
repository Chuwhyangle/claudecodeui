/**
 * AC-344 criterion: the Live Voice queue depth is refreshed ON THE TURN BOUNDARY itself, so a drain
 * that NO voice event announces still zeroes the S-A injected line and `session_status` (GOAL-041).
 *
 * WHAT THIS FILE IS FOR — THE RESIDUE AC-338 LEFT. `gap-live-voice-queue-depth-host-lifecycle-truth`
 * (AC-338, done) made the CLI queue term read the host's own `command_lifecycle`, but the relay only
 * SAMPLES that host at the events it already handles (a delivery result, a stop, before a status
 * line). The CLI drains its queue at a TURN BOUNDARY nothing tells the relay about; when the person
 * then stops talking, no further voice event fires, so the reported depth stays at its last value —
 * the S-A line and `session_status` keep saying `queued=3` while the CLI holds zero. SPEC §18.5's
 * 「回合边界深度误差 = 0」 is violated for exactly as long as the silence lasts.
 *
 * HOW IT IS PROVEN — A SCRIPTED HOST BEHIND THE REAL GATEWAY, TWO FORMS OF ONE CONNECTION:
 *
 *   · FALSE FORM (the file's FIRST test): the proxy is built with `hostQueueTurnBoundaryRefresh:
 *     false` — the host is sampled only at the events the relay already handles, which is what the
 *     relay did before this task. Three messages are enqueued, the host drains them at a turn
 *     boundary, and then NO voice event fires: the last published reading stays at 3 and no
 *     `queued=0` line is ever injected. This is the red the boundary refresh must fix.
 *   · TRUE FORM: the same timeline, with the refresh enabled (the deployed default). The drain is
 *     sampled inside the S-A rate window, folded through the SAME dedup+cap path every other change
 *     uses, and the S-A line reads `queued=0/0B` while `session_status.queuedItems` reads 0 — with
 *     no further voice event in between.
 *
 * AC2 then holds the depth STILL (no drain) and proves no periodic no-change injection appears,
 * giving the injection count, and AC3/AC4 are the sibling criteria this seam must not disturb.
 *
 * The host is a FAKE resident driver read through the REAL `createProviderRuntimeService()` — the
 * same reconciliation path `server/index.ts` assembles — so the reading under test is the deployed
 * one, not a stand-in. No cloud call is made: the relay runs over a fake transport.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-queue-depth-drain-refresh.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { IProvider } from '@/shared/interfaces.js';
import type { HostPendingQueuedInputs, LLMProvider, ProcessHost } from '@/shared/types.js';
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';

import {
  createVoiceRealtimeLiveExecutor,
  handleVoiceRealtimeConnection,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type VoiceRealtimeOutboundFrame,
} from '../index.js';
import type { HostQueueReading, VoiceRealtimeExecStatusReading } from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/** The bound session every connection in this file acts for. */
const BOUND_SESSION = 'queue-depth-drain-refresh-session';

/** The S-A rate window this file runs at: short enough that each window lands inside the test. */
const WINDOW_MS = 10;

/** How many messages are enqueued before the turn boundary — the AC's "入队 3 条". */
const ENQUEUED = 3;

/** A `{}` cast to a deps type the criterion never reaches — `session_status` touches none of them. */
const never = <T>(): T => ({}) as unknown as T;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// The scripted host: the CLI's own queue, advanced by the test, read through the REAL gateway.
// ---------------------------------------------------------------------------------------------

type ScriptedHost = {
  /** The CLI accepted a message into its own queue (a `queued:true` send). */
  accepted(bytes: number): void;
  /** A turn boundary drained `count` oldest entries together — no voice event follows. */
  drain(count: number): void;
  /** The CLI's own queue reading, as the driver would report it. */
  reading(): HostPendingQueuedInputs;
};

function createScriptedHost(): ScriptedHost {
  const pending: number[] = [];
  return {
    accepted(bytes: number): void {
      pending.push(bytes);
    },
    drain(count: number): void {
      pending.splice(0, count);
    },
    reading(): HostPendingQueuedInputs {
      return { items: pending.length, bytes: pending.reduce((sum, bytes) => sum + bytes, 0) };
    },
  };
}

/**
 * Wires {@link VoiceRealtimeProxySeams.hostQueueReading} through the REAL runtime gateway — the same
 * object `server/index.ts` builds — over a fake RESIDENT host driver that reads the scripted queue.
 */
function hostQueueReadingOverGateway(host: ScriptedHost): (sessionId: string) => HostQueueReading | null {
  const fakeDriver = {
    async run(): Promise<undefined> {
      return undefined;
    },
    pendingQueuedInputs(sessionId: string): HostPendingQueuedInputs | null {
      return sessionId === BOUND_SESSION ? host.reading() : null;
    },
  };
  const provider = { id: 'claude', hostDriver: fakeDriver } as unknown as IProvider;
  const runtime = createProviderRuntimeService({
    resolveProvider: () => provider,
    resolveSessionLifecycleMode: () => 'resident',
    sessionHostManager: {
      liveHostForSession: (sessionId: string): ProcessHost | null =>
        sessionId === BOUND_SESSION ? ({} as ProcessHost) : null,
    } as unknown as SessionHostManager,
  });
  return (sessionId: string) => runtime.pendingQueuedInputs('claude' as LLMProvider, sessionId);
}

// ---------------------------------------------------------------------------------------------
// The browser socket and the connection under test.
// ---------------------------------------------------------------------------------------------

class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
}

/** Every `session.update` body's `instructions`, in the order the transport put them on the wire. */
const instructionTexts = (transport: FakeTransport): string[] =>
  transport.sent
    .filter((message) => message.type === 'session.update')
    .map((message) => message.session.instructions ?? '');

/** Only the updates that CARRIED an S-A status line. */
const statusLines = (transport: FakeTransport): string[] =>
  instructionTexts(transport).filter((text) => text.includes('[exec] phase='));

/** Delivers one `function_call` event from the fake upstream for `session_send`. */
function deliverSessionSendCall(transport: FakeTransport, callId: string, message: string): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  };
  transport.peerSend(call);
}

/**
 * The endpoint closes one piece of the person's speech.
 *
 * Delivered between messages because the bridge's `TOOL_LOOP_GUARD` ends a session after six tool
 * calls with no new utterance, and the continuous-mode duplicate guard keys on the same event.
 */
function commitUserUtterance(transport: FakeTransport): void {
  transport.peerSend({ type: 'input_audio_buffer.committed' } as RealtimeServerMessage);
  transport.peerSend({ type: 'conversation.item.input_audio_transcription.completed' } as RealtimeServerMessage);
}

type Connection = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  host: ScriptedHost;
  /** Every reading the proxy published with a status line, in order — the injection count. */
  readings: VoiceRealtimeExecStatusReading[];
  /** The most recently published reading — the cell a `session_status` call answers from. */
  latest: () => VoiceRealtimeExecStatusReading | null;
  /** A REAL `session_status` answer over the live executor this connection was built with. */
  sessionStatus: () => Promise<Record<string, unknown>>;
};

function wireConnection(options: {
  host: ScriptedHost;
  hostQueueReading?: (sessionId: string) => HostQueueReading | null;
  /** `false` builds the FALSE FORM (no turn-boundary refresh); omitted is the deployed default. */
  turnBoundaryRefresh?: boolean;
}): Connection {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const readings: VoiceRealtimeExecStatusReading[] = [];
  let latest: VoiceRealtimeExecStatusReading | null = null;
  let calls = 0;

  const base = createVoiceRealtimeLiveExecutor({
    boundSessionId: BOUND_SESSION,
    caller: { userId: 7, scopes: ['cloudcli:read'] },
    visibleContext: never(),
    readTools: never(),
    runGet: never(),
    approvals: never(),
    sessionBackground: never(),
    sessionSend: never(),
    sessionInterrupt: never(),
    onSessionRefusal: () => undefined,
    sessionStatus: { reading: () => latest },
  });

  const executor: RealtimeToolExecutor = {
    ...base,
    session_send: async (args: Record<string, unknown>) => {
      const text = typeof args.message === 'string' ? args.message : '';
      calls += 1;
      // The CLI accepts the message into its own queue BEFORE the send resolves (`queued:true`), so
      // the host reading the relay samples right after the result already holds this entry.
      options.host.accepted(Buffer.byteLength(text, 'utf8'));
      return { ok: true, queued: true, runId: `run-${calls}`, queuedMessageUuid: `uuid-${calls}` };
    },
  };

  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    BOUND_SESSION,
    {
      createTransport: () => transport,
      createExecutor: () => executor,
      instructions: 'queue-depth-drain-refresh instructions',
      statusRateMs: WINDOW_MS,
      onExecStatus: (reading) => {
        latest = reading;
        readings.push(reading);
      },
      ...(options.hostQueueReading === undefined ? {} : { hostQueueReading: options.hostQueueReading }),
      ...(options.turnBoundaryRefresh === undefined
        ? {}
        : { hostQueueTurnBoundaryRefresh: options.turnBoundaryRefresh }),
    },
  );

  return {
    socket,
    transport,
    host: options.host,
    readings,
    latest: () => latest,
    sessionStatus: async () => (await base['session_status']!({})) as Record<string, unknown>,
  };
}

/** Enqueues `ENQUEUED` messages one at a time, each acknowledged as a queued delivery. */
async function enqueue(connection: Connection): Promise<number[]> {
  await waitFor(() => connection.transport.openCalls >= 1);
  const depths: number[] = [];
  const delivered = (): Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }>[] =>
    connection.socket.outbound.filter(
      (frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }> => frame.type === 'sent',
    );
  for (let i = 1; i <= ENQUEUED; i += 1) {
    commitUserUtterance(connection.transport);
    deliverSessionSendCall(connection.transport, `call-${i}`, `drain-refresh message number ${i}`);
    await waitFor(() => delivered().length === i);
    depths.push(delivered()[i - 1]!.depth);
  }
  return depths;
}

/** The `queued=<items>/<bytes>B` a line carries, or `null`. */
function lineDepth(line: string): { items: number; bytes: number } | null {
  const match = /queued=(\d+)\/(\d+)B/.exec(line);
  return match === null ? null : { items: Number(match[1]), bytes: Number(match[2]) };
}

// ── AC1 (false form), THE FILE'S FIRST ASSERTION: with the turn-boundary refresh removed, a drain
// no event announces leaves the reading at its old value — the residue this task closes. ─────────

test('AC1 false form: without the turn-boundary refresh the reading stays at 3 after the drain', async () => {
  const host = createScriptedHost();
  const connection = wireConnection({
    host,
    hostQueueReading: hostQueueReadingOverGateway(host),
    turnBoundaryRefresh: false,
  });
  const depths = await enqueue(connection);
  assert.deepEqual(depths, [1, 2, 3], 'each queued delivery must report the growing real depth');

  // The reading at depth 3 has reached the wire, so the false form starts from a settled sample.
  await waitFor(() => statusLines(connection.transport).some((line) => lineDepth(line)?.items === 3));
  const injectionsBeforeDrain = connection.readings.length;

  // The turn boundary: the CLI drains its queue, and NOTHING tells the relay. No voice event follows.
  connection.host.drain(ENQUEUED);
  await sleep(WINDOW_MS * 20);

  assert.equal(
    connection.latest()?.queuedItems,
    ENQUEUED,
    'without the boundary refresh the published reading stays at its old value — the red to fix',
  );
  assert.equal(
    connection.readings.length,
    injectionsBeforeDrain,
    'and no further line is injected, because no event and no boundary sample occurred',
  );
  assert.ok(
    !statusLines(connection.transport).some((line) => lineDepth(line)?.items === 0),
    'the false form must never show the drained depth',
  );
  connection.socket.close();
});

// ── AC1 (true form): the drain no event announces is sampled on the boundary, and within the rate
// window the S-A line and `session_status` both read zero. ───────────────────────────────────────

test('AC1 true form: a silent drain zeroes the S-A line and session_status within the window', async () => {
  const host = createScriptedHost();
  const connection = wireConnection({ host, hostQueueReading: hostQueueReadingOverGateway(host) });
  const depths = await enqueue(connection);
  assert.deepEqual(depths, [1, 2, 3], 'each queued delivery must report the growing real depth');

  await waitFor(() => statusLines(connection.transport).some((line) => lineDepth(line)?.items === 3));

  // The turn boundary drains the whole queue; from here on there is NO further voice event.
  connection.host.drain(ENQUEUED);
  const drainedAt = Date.now();
  await waitFor(() => connection.latest()?.queuedItems === 0);
  const refreshLatencyMs = Date.now() - drainedAt;

  // The S-A line the model reads says zero, and it says it within the S-A rate window (+ pipeline).
  const zeroLine = statusLines(connection.transport).find((line) => lineDepth(line)?.items === 0);
  assert.ok(zeroLine, `the injected line must read queued=0 after the drain: ${statusLines(connection.transport).join(' | ')}`);
  assert.deepEqual(lineDepth(zeroLine!), { items: 0, bytes: 0 }, 'a drained queue holds zero items and zero bytes');

  // `session_status` reads the SAME published reading, so it cannot disagree with the line (§8.2).
  const status = await connection.sessionStatus();
  assert.equal(Number(status['queuedItems']), 0, 'session_status.queuedItems must read zero after the drain');

  // The refresh lands inside SPEC §18.5's "≤ 2 s" bound (one S-A window + the pipeline), measured
  // from the drain with no event in between.
  assert.ok(
    refreshLatencyMs < 2000,
    `the boundary refresh must land within the window + pipeline, took ${refreshLatencyMs} ms`,
  );
  connection.socket.close();
});

// ── AC2: a poll over an UNCHANGED depth injects nothing — the dedup still holds, and §8.3's
// event-driven rule (no periodic no-change injection) is untouched. ─────────────────────────────

test('AC2: an unchanged depth across many windows produces no new injection', async () => {
  const host = createScriptedHost();
  const connection = wireConnection({ host, hostQueueReading: hostQueueReadingOverGateway(host) });
  await enqueue(connection);
  await waitFor(() => statusLines(connection.transport).some((line) => lineDepth(line)?.items === 3));

  // Let the reading settle, then hold the depth STILL for many windows with the poll armed.
  const settledInjections = connection.readings.length;
  const settledLines = statusLines(connection.transport).length;
  await sleep(WINDOW_MS * 20);

  assert.equal(
    connection.readings.length,
    settledInjections,
    `a still queue must not be re-injected: ${connection.readings.length} readings vs ${settledInjections} settled`,
  );
  assert.equal(statusLines(connection.transport).length, settledLines, 'no new S-A line for an unchanged depth');
  assert.equal(connection.latest()?.queuedItems, 3, 'the reading stays at the queue it actually holds');
  connection.socket.close();
});
