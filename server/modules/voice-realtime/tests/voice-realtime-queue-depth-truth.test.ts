/**
 * AC-338 criterion: the Live Voice queue depth is reconciled against the host's OWN
 * `command_lifecycle`, so a turn boundary drains the reported depth to zero.
 *
 * WHAT THIS FILE IS FOR. The relay counted its own accepted deliveries and could only ever grow
 * (`cliQueuedDeliveries` reset to 0 only on a `queued:false` result). Measured 2026-10-12 (journal
 * `99df08d8` x Claude transcript `c6493eb6`, SPEC §18.1 F-1..F-3): the CLI dequeued seven entries in
 * ONE millisecond at 01:26:18 and joined them into a single turn, while the relay reported
 * `queued=8→9→10` — a real depth that had peaked at 7 and then fallen to ≤2. Every consumer of that
 * number (the `sent` frame, the S-A injected line, `session_status`) therefore said the wrong thing.
 *
 * HOW IT IS PROVEN. `server/modules/voice-realtime/tests/fixtures/live-voice-2026-10-12-timeline.json`
 * is the 2026-10-12 timeline sanitized to relative order, per-entry byte sizes and dequeue batch
 * sizes (no spoken words — AC5 pins that). Two legs replay it through the REAL proxy
 * (`handleVoiceRealtimeConnection`) over a fake browser socket and a fake transport:
 *
 *   · FALSE FORM (the file's FIRST test): with the host reconciliation removed — the proxy built with
 *     no `hostQueueReading` seam, which is what the relay did before this task — the reported depths
 *     are the fixture's `relayReported` (8/9/10). This is the red the reconciliation must fix.
 *   · TRUE FORM: with the seam wired to a REAL `createProviderRuntimeService().pendingQueuedInputs`
 *     over a fake resident host driver that walks the fixture's lifecycle, every reported depth and
 *     byte count equals the fixture's own `pendingAfter`/`pendingBytesAfter`, the peak is 7, and
 *     nothing after the first dequeue batch exceeds 2.
 *
 * AC2 then checks the three surfaces of one sample point agree; AC4 checks the explicit degradation
 * when the host cannot be read; AC5 checks the fixture carries no speech.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// ---------------------------------------------------------------------------------------------
// The fixture — the sanitized 2026-10-12 timeline, read from disk so AC5 can scan the real file.
// ---------------------------------------------------------------------------------------------

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/live-voice-2026-10-12-timeline.json', import.meta.url));

type FixtureStep =
  | { kind: 'delivery'; bytes: number; pendingAfter: number; pendingBytesAfter: number }
  | { kind: 'dequeue'; count: number };

type Fixture = {
  steps: FixtureStep[];
  peakPending: number;
  afterFirstBatchMaxPending: number;
  relayReported: number[];
};

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

/** The bound session every connection in this file acts for. */
const BOUND_SESSION = 'queue-depth-truth-session';

/** A `{}` cast to a deps type the criterion never reaches — `session_status` touches none of them. */
const never = <T>(): T => ({}) as unknown as T;

// ---------------------------------------------------------------------------------------------
// The scripted host: the CLI's own queue, advanced by the fixture, read through the real gateway.
// ---------------------------------------------------------------------------------------------

type ScriptedHost = {
  /** The CLI accepted a message of `bytes` into its own queue (a `queued:true` send). */
  accepted(bytes: number): void;
  /** A turn boundary drained the oldest `count` entries together. */
  dequeue(count: number): void;
  reading(): HostPendingQueuedInputs;
};

function createScriptedHost(): ScriptedHost {
  const pending: number[] = [];
  return {
    accepted(bytes: number): void {
      pending.push(bytes);
    },
    dequeue(count: number): void {
      // Oldest first — the CLI drains its command queue in order.
      pending.splice(0, count);
    },
    reading(): HostPendingQueuedInputs {
      return { items: pending.length, bytes: pending.reduce((sum, bytes) => sum + bytes, 0) };
    },
  };
}

/**
 * Wires the seam the relay samples through the REAL runtime gateway.
 *
 * The gateway is `createProviderRuntimeService` — the same object `server/index.ts` builds — over a
 * fake provider whose `hostDriver` walks the scripted host. `resident` decides whether the gateway
 * resolves a resident driver at all: `true` is the deployed shape, `false` is the per-run session a
 * host reading must be reported UNKNOWN for.
 */
function hostQueueReadingOverGateway(
  host: ScriptedHost,
  options: { resident: boolean },
): (sessionId: string) => HostQueueReading | null {
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
    resolveSessionLifecycleMode: () => (options.resident ? 'resident' : 'per-run'),
    sessionHostManager: {
      liveHostForSession: (sessionId: string): ProcessHost | null =>
        options.resident && sessionId === BOUND_SESSION ? ({} as ProcessHost) : null,
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

type SentFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }>;

const sentFrames = (socket: FakeBrowserSocket): SentFrame[] =>
  socket.outbound.filter((frame): frame is SentFrame => frame.type === 'sent');

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
 * Delivered between messages because the timeline IS a person talking into a busy session: the
 * bridge's `TOOL_LOOP_GUARD` ends a session after six tool calls with no new utterance, and the
 * continuous-mode duplicate guard keys on the same event. Modeling the utterances the person really
 * made is what lets ten deliveries stand on one connection.
 */
function commitUserUtterance(transport: FakeTransport): void {
  // The endpoint commits the audio (`input_audio_buffer.committed` — the proxy's "a new utterance
  // landed" signal), then reports its transcription settled, which is what the bridge's loop guard
  // counts from.
  transport.peerSend({ type: 'input_audio_buffer.committed' } as RealtimeServerMessage);
  transport.peerSend({ type: 'conversation.item.input_audio_transcription.completed' } as RealtimeServerMessage);
}

type Connection = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  host: ScriptedHost;
  /** Every reading the proxy published with a status line, in order. */
  readings: VoiceRealtimeExecStatusReading[];
  /** The most recently published reading — the cell a `session_status` call answers from. */
  latest: () => VoiceRealtimeExecStatusReading | null;
  /** A REAL `session_status` answer over the live executor this connection was built with. */
  sessionStatus: () => Promise<Record<string, unknown>>;
};

function wireConnection(options: {
  host: ScriptedHost;
  hostQueueReading?: (sessionId: string) => HostQueueReading | null;
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
      instructions: 'queue-depth-truth instructions',
      // A window short enough that each delivery's reading reaches the wire inside the test.
      statusRateMs: 1,
      onExecStatus: (reading) => {
        latest = reading;
        readings.push(reading);
      },
      ...(options.hostQueueReading === undefined ? {} : { hostQueueReading: options.hostQueueReading }),
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

// ---------------------------------------------------------------------------------------------
// The replay: walk the fixture's steps, delivering one message per `delivery` step and advancing the
// host's own queue per step. The message text is exactly `bytes` UTF-8 bytes so the host reading and
// the fixture's byte counts are the same number.
// ---------------------------------------------------------------------------------------------

type Sample = { delivery: number; depth: number; bytes: number; step: Extract<FixtureStep, { kind: 'delivery' }> };

/**
 * One delivery's text: exactly `bytes` UTF-8 bytes, and DISTINCT from every other delivery's.
 *
 * Distinct on purpose: the continuous-mode duplicate guard drops a relay whose normalized text is
 * contained in the previous delivery's, so a run of pure padding would have every later message
 * read as a repeat and never reach the executor. A per-delivery prefix keeps the byte length exact
 * (ASCII, one byte per character) while making each text its own.
 */
function deliveryText(delivery: number, bytes: number): string {
  const tag = `${delivery}z`;
  return tag.length >= bytes ? tag.slice(0, bytes) : tag + 'q'.repeat(bytes - tag.length);
}

async function replay(connection: Connection): Promise<Sample[]> {
  await waitFor(() => connection.transport.openCalls >= 1);
  const samples: Sample[] = [];
  let delivery = 0;
  for (const step of FIXTURE.steps) {
    if (step.kind === 'dequeue') {
      connection.host.dequeue(step.count);
      continue;
    }
    delivery += 1;
    commitUserUtterance(connection.transport);
    deliverSessionSendCall(connection.transport, `call-${delivery}`, deliveryText(delivery, step.bytes));
    await waitFor(() => sentFrames(connection.socket).length === delivery);
    const sent = sentFrames(connection.socket)[delivery - 1]!;
    samples.push({ delivery, depth: sent.depth, bytes: sent.bytes, step });
  }
  return samples;
}

// ── AC1 (false form), THE FILE'S FIRST ASSERTION: with the reconciliation removed, the relay still
// reports the cumulative count — 8/9/10 — which is the defect this task fixes. ─────────────────────

test('AC1 false form: without host reconciliation the relay reports the cumulative 8/9/10', async () => {
  const host = createScriptedHost();
  // No `hostQueueReading` seam: exactly what the relay did before this task.
  const connection = wireConnection({ host });
  const samples = await replay(connection);

  const reported = samples.slice(-FIXTURE.relayReported.length).map((sample) => sample.depth);
  assert.deepEqual(
    reported,
    FIXTURE.relayReported,
    'a relay that counts only its own deliveries reports the fixture\'s 8/9/10 — the red the reconciliation must fix',
  );
  // The false form runs the SAME timeline, so its peak is the delivery count, not the real 7.
  assert.equal(Math.max(...samples.map((sample) => sample.depth)), 10, 'the unreconciled depth grows without bound');
  connection.socket.close();
});

// ── AC1 (true form): every reported reading equals the fixture's real depth, the peak is 7, and
// nothing after the first dequeue batch exceeds 2. ───────────────────────────────────────────────

test('AC1 true form: the reconciled depth equals the fixture at every sample, peak 7, ≤2 after the drain', async () => {
  const host = createScriptedHost();
  const connection = wireConnection({ host, hostQueueReading: hostQueueReadingOverGateway(host, { resident: true }) });
  const samples = await replay(connection);

  for (const sample of samples) {
    assert.equal(
      sample.depth,
      sample.step.pendingAfter,
      `delivery ${sample.delivery}: the reported depth must be the CLI's real depth`,
    );
    assert.equal(
      sample.bytes,
      sample.step.pendingBytesAfter,
      `delivery ${sample.delivery}: the reported byte count must be the CLI's real byte count`,
    );
  }

  assert.equal(
    Math.max(...samples.map((sample) => sample.depth)),
    FIXTURE.peakPending,
    'the peak the relay reports is the CLI\'s real peak (7), not the delivery count',
  );

  const firstDequeueAt = FIXTURE.steps.findIndex((step) => step.kind === 'dequeue');
  const deliveriesAfterFirstBatch = samples.filter(
    (sample) => FIXTURE.steps.indexOf(sample.step) > firstDequeueAt,
  );
  assert.ok(deliveriesAfterFirstBatch.length > 0, 'the fixture must have deliveries after the first drain');
  assert.ok(
    deliveriesAfterFirstBatch.every((sample) => sample.depth <= FIXTURE.afterFirstBatchMaxPending),
    'after the 01:26:18 drain the real depth is ≤2, and every reading must say so',
  );

  connection.socket.close();
});

// ── AC2: the three surfaces of ONE sample point agree — the `sent` frame's depth, the S-A injected
// line's `queued=`, and `session_status.queuedItems`. ────────────────────────────────────────────

test('AC2: sent.depth, the injected line and session_status.queuedItems are one reading', async () => {
  const host = createScriptedHost();
  const connection = wireConnection({ host, hostQueueReading: hostQueueReadingOverGateway(host, { resident: true }) });
  const samples = await replay(connection);
  const last = samples[samples.length - 1]!;

  // The status line for that reading must reach the wire (the window is 1 ms).
  await waitFor(() =>
    statusLines(connection.transport).some((line) => line.includes(`queued=${last.depth}/${last.bytes}B`)),
  );
  const line = statusLines(connection.transport).find((candidate) =>
    candidate.includes(`queued=${last.depth}/${last.bytes}B`),
  )!;
  const match = /queued=(\d+)\/(\d+)B/.exec(line);
  assert.ok(match, `the injected line must carry a numeric queued=<items>/<bytes>B reading: ${line}`);
  const lineItems = Number(match![1]);
  const lineBytes = Number(match![2]);

  const status = await connection.sessionStatus();
  const statusItems = Number(status['queuedItems']);

  // The one sample point, printed whole so a reader can compare across the three surfaces.
  const readings = { sentDepth: last.depth, sentBytes: last.bytes, lineItems, lineBytes, statusItems };
  assert.deepEqual(
    readings,
    { sentDepth: last.depth, sentBytes: last.bytes, lineItems: last.depth, lineBytes: last.bytes, statusItems: last.depth },
    `the sent frame, the injected line and session_status must be one reading: ${JSON.stringify(readings)}`,
  );
  connection.socket.close();
});

// ── AC4: when the host cannot be read (a per-run session), the status line degrades EXPLICITLY —
// the unknown marker appears, and no stale count does. ───────────────────────────────────────────

test('AC4: an unreadable host queue degrades the status line to unknown, not an old count', async () => {
  const host = createScriptedHost();
  // A per-run session: the gateway resolves no resident driver, so the reading is `null`.
  const connection = wireConnection({ host, hostQueueReading: hostQueueReadingOverGateway(host, { resident: false }) });
  const samples = await replay(connection);

  await waitFor(() => statusLines(connection.transport).length > 0);
  const lines = statusLines(connection.transport);
  const last = lines[lines.length - 1]!;

  assert.match(last, /queued=unknown/, `the line must state the unknown depth explicitly: ${last}`);
  assert.ok(
    !/queued=\d/.test(last),
    `the line must not present a stale numeric count while the host cannot be read: ${last}`,
  );
  // The reading says the same thing, so a consumer of the reading (session_status) cannot claim a
  // number the line refuses to give.
  assert.equal(connection.latest()?.queuedKnown, false, 'the published reading must mark the CLI term unknown');
  // The unknown CLI term contributes NOTHING to the numbers — the reported depth is the L3 remainder
  // (here zero) — and the relay's own optimistic count is never presented in its place.
  assert.deepEqual(
    [...new Set(samples.map((sample) => sample.depth))],
    [0],
    'an unreadable host contributes no depth; the reading must not fall back to a local count',
  );
  assert.notDeepEqual(
    samples.slice(-FIXTURE.relayReported.length).map((sample) => sample.depth),
    FIXTURE.relayReported,
    'an unreadable host must NOT fall back to the cumulative 8/9/10',
  );
  connection.socket.close();
});

// ── AC5: the fixture carries no speech — no `message` / `content` / `text` field anywhere. ───────

test('AC5: the timeline fixture has no message/content/text field', () => {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
  const banned = new Set(['message', 'content', 'text']);
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (banned.has(key)) {
          offenders.push(`${path}.${key}`);
        }
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(parsed, '$');

  assert.deepEqual(offenders, [], 'the fixture must carry no field that could hold a session body');
  // The raw file must make the same promise: a reader grepping the fixture for speech finds none.
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  for (const word of banned) {
    assert.ok(!new RegExp(`"${word}"`).test(raw), `the fixture must not declare a "${word}" field`);
  }
});
