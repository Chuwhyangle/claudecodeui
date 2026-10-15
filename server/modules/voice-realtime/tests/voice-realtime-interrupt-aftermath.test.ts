/**
 * The HONEST AFTERMATH of a Live Voice stop (GOAL-041 / AC-344, SPEC §0.3 D-8/D-9, §18.5, §11.4).
 *
 * WHAT THIS FILE IS FOR. An interrupt ends the run, not its side effects. The 2026-10-12 transcript
 * `c6493eb6` has round 1 write `/tmp/voice-watch.sh` and start it with `nohup … & disown`: the stop
 * button cuts the turn off, and the listener the turn started keeps running. So after a stop three
 * things have to be true, and each one is a way an implementation can lie:
 *
 *   · AC1 — THE BOUNDARY. Stopping a RUN is not stopping the SESSION's work. The interrupt path must
 *     not reach `session_background`'s `stopTask` verb, must leave the session's lease listing
 *     identical, and must not end the process standing in for the background task / Quay worker
 *     (SPEC §0.3 D-9). The file's FIRST group drives a REAL interrupt through the REAL live executor
 *     and reads all three; its false form drives the SAME readings with an executor whose interrupt
 *     handler also reaches `stopTask`, so the assertion is proven to redden on exactly the violation
 *     the criterion names — and each of the three clauses is shown to be load-bearing on its own.
 *   · AC2 — ONE SOURCE. The `stopped` frame's `depth`, the S-A injected line's `queued=` and
 *     `session_status.queuedItems` are the SAME post-stop host sample (AC-338's reconciliation),
 *     and the frame carries the `runId` the stop ended. Proven against a 3→1 drain the host really
 *     performs at the abort, so a reading carried over from before the stop would disagree.
 *   · AC3/AC4 — THE NEXT TURN'S NOTE. The first message into the CLI after the interruption names
 *     the tool the interrupted turn was in the middle of and says partial changes may remain — and
 *     says nothing about undoing them (§11.4: no `revert`/`rollback`/`undo`/「撤销」/「回滚」). When
 *     the in-flight tool cannot be read the note is the tool-free form and the journal records
 *     `inFlightTool: null` rather than guessing.
 *   · WHICH MESSAGE THE NOTE RIDES (ruling 2026-10-16,
 *     `gap-live-voice-interrupt-aftermath-note-rides-the-correction`). A stop that carries a
 *     CORRECTION arms the note before the correction is enqueued, so the correction — the message the
 *     stop's own words go in on, and the one the abort delivers into the interrupt-closing turn (G1)
 *     — is what carries the explanation; the message after it is the person's words alone. A stop
 *     with no correction keeps the older shape (armed after the abort, riding whatever goes in next).
 *     The cases that pin it are the correction form, the stop with no correction (the older shape),
 *     the enqueue that never happened (nothing carries the note, nothing left armed), the correction
 *     handed over but not confirmed (the note is out and cannot be recalled — the reading the audit's
 *     `noteCarried` exists for), and the FENCE's `covered` repeat (nothing armed at all).
 *
 * The DoD walks the same stop over the REAL DashScope transport and the scripted stand-in endpoint,
 * with the fake resident host as the only host, and reads the next turn's actual CLI input text, the
 * raw `kind:'interrupt'` journal line and the stand-in process's aliveness off disk and off the test
 * process — zero cloud calls (the only address dialled is `ws://scripted.invalid`). Its second half
 * does the same for a stop that CARRIES a correction, and prints the three texts this task's Notes
 * carry verbatim.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files; Node's own type-stripping does not remap that):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-interrupt-aftermath.test.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  buildSessionBackground,
  type McpPrincipal,
  type McpSessionBackgroundDeps,
  type McpSessionInterruptDeps,
  type McpSessionSendDeps,
  type SessionBackgroundPayload,
} from '@/modules/mcp-gateway/index.js';

import {
  createDashscopeTransport,
  createVoiceRealtimeLiveExecutor,
  createVoiceRealtimeLogStore,
  createVoiceRealtimeRecorder,
  handleVoiceRealtimeConnection,
  type RealtimeServerMessage,
  type RealtimeToolExecutor,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../index.js';
import {
  buildInterruptAftermathNote,
  type HostQueueReading,
  type HostRunActivityReading,
  type VoiceRealtimeExecStatusReading,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import {
  captionCompleted,
  createScriptedUpstream,
  functionCall,
  SCRIPTED_ENDPOINT_URL,
} from './voice-realtime-scripted-upstream.js';

// ── the fixture constants ────────────────────────────────────────────────────────────────────

/** The connection this file's journal goes under. Any stable id: the journal is named from it. */
const CONNECTION_ID = 'conn-aftermath';
/** The session the connection is bound to — the only session the executor may act on. */
const BOUND_SESSION = 'session-aftermath';
/** The run the fake `session_send` reports, so the stop has a run to name. */
const RUN_ID = 'run-1';
/** The background task the fake resident host holds a lease for — the work a stop must NOT end. */
const BG_TASK_ID = 'bg-task-1';
/** The first-party user the connection acts as. */
const USER_ID = 7;
/** The scope the connection carries. */
const SCOPE = 'cloudcli:read';
/** The words the person says after the stop — the current instruction the note precedes. */
const NEXT_MESSAGE = 'now do the small thing instead';

/** A `{}` cast to a deps type a case never reaches. */
const never = <T>(): T => ({}) as unknown as T;

// ── the fake browser socket ──────────────────────────────────────────────────────────────────

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses. The same shape the other stop criteria drive.
 */
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

  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** Delivers one `function_call` event from the fake upstream. */
function deliverFunctionCall(transport: FakeTransport, callId: string, name: string, args: unknown): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name,
    callId,
    arguments: JSON.stringify(args),
  };
  transport.peerSend(call);
}

/**
 * Delivers one FINAL utterance transcription from the fake upstream.
 *
 * What raises the connection's `utteranceSeq` (see `onCaption`): the fence needs a non-null
 * `triggerSeq` before "the same triggerSeq repeated" is a state it can reach at all, and an empty
 * transcript never advances the count — so the text here is real words.
 */
function deliverTranscript(transport: FakeTransport, itemId: string, transcript: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

/** Every `session.update` body's `instructions`, in the order the transport put them on the wire. */
const instructionTexts = (transport: FakeTransport): string[] =>
  transport.sent.flatMap((message) =>
    message.type === 'session.update' ? [message.session.instructions] : [],
  );

/** Only the updates that CARRIED an S-A status line. */
const statusLines = (transport: FakeTransport): string[] =>
  instructionTexts(transport).filter((text) => text.includes('[exec] phase='));

/** Waits until the proxy has reported the upstream session open to the browser. */
const waitForOpen = (socket: FakeBrowserSocket): Promise<void> =>
  waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

const framesOf = <T extends VoiceRealtimeOutboundFrame>(socket: FakeBrowserSocket, type: T['type']): T[] =>
  socket.outbound.filter((frame): frame is T => frame.type === type);

const functionCallOutput = (transport: FakeTransport, callId: string) =>
  transport.sent.find(
    (message): message is { type: 'function_call_output'; callId: string; output: unknown } =>
      message.type === 'function_call_output' && message.callId === callId,
  );

// ── the stand-in process ─────────────────────────────────────────────────────────────────────

/**
 * A REAL child process standing in for the background task / Quay worker a stop must not signal.
 *
 * It is a real process on purpose: "the interrupt path did not end it" is only a reading if there is
 * something that can actually be ended. It announces `ready` on stdout once its signal handlers are
 * installed (so a case never races node's own boot — the false form's `stopTask` must find handlers
 * in place, or its kill would be a race rather than a reading), exits 9 on `SIGTERM`/`SIGHUP`, and
 * otherwise idles. `alive()` asks the OS (`kill(pid, 0)`) rather than trusting a flag the test set.
 */
type StandIn = {
  pid: number;
  ready(): Promise<void>;
  alive(): boolean;
  kill(): void;
  waitForExit(): Promise<void>;
  dispose(): void;
};

function spawnStandIn(): StandIn {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => process.exit(9));process.on('SIGHUP', () => process.exit(9));process.stdout.write('ready\\n');setInterval(() => {}, 1000);",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  assert.ok(typeof child.pid === 'number', 'the stand-in process must have a pid');
  const readySeen = new Promise<void>((resolve) => {
    child.stdout?.once('data', () => resolve());
  });
  const api: StandIn = {
    pid: child.pid,
    ready: () => readySeen,
    alive(): boolean {
      if (child.exitCode !== null || child.signalCode !== null) {
        return false;
      }
      try {
        process.kill(child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill(): void {
      child.kill('SIGTERM');
    },
    async waitForExit(): Promise<void> {
      await waitFor(() => !api.alive(), 5000);
    },
    dispose(): void {
      if (api.alive()) {
        child.kill('SIGKILL');
      }
    },
  };
  return api;
}

// ── the fake resident host ───────────────────────────────────────────────────────────────────

/** One lease the fake host holds. Structurally a `HostLease` of the two kinds this file uses. */
type TestLease = { kind: 'background-task' | 'cron'; id: string; recurring?: boolean };

/**
 * The fake RESIDENT host: the two facts `session_background` reports about the host itself, plus the
 * binding table whose leases are the listing. Exactly the shape the gateway's `session_background`
 * reads (`{state, pid, bindings}`), so the reading this file compares is the shipping one.
 */
type FakeHost = {
  state: string;
  pid: number | null;
  bindings: Map<string, { leases: TestLease[] }>;
};

function createFakeHost(options: { pid: number | null; leases: TestLease[] }): FakeHost {
  return {
    state: 'live',
    pid: options.pid,
    bindings: new Map([[BOUND_SESSION, { leases: [...options.leases] }]]),
  };
}

// ── the executor harness ─────────────────────────────────────────────────────────────────────

/** The three boundary readings AC1 is made of, in one object so one assertion can hold all three. */
type BoundaryReading = {
  /** How many times the control service's background-task stop verb was reached. */
  stopTaskCalls: number;
  /** The `session_background` listing BEFORE the interrupt. */
  leaseBefore: SessionBackgroundPayload;
  /** The `session_background` listing AFTER it. */
  leaseAfter: SessionBackgroundPayload;
  /** Whether the stand-in process is still running. */
  standInAlive: boolean;
};

/**
 * AC1's assertion, as ONE function so the false form below can run it against a violated reading.
 *
 * Three clauses, and each is the criterion's own words: the interrupt path (1) does not call
 * `stopTask`, (2) leaves the `session_background` lease listing identical, (3) signals no process
 * outside the bound session's run — read here as the stand-in still being alive.
 */
function assertInterruptBoundary(reading: BoundaryReading): void {
  assert.equal(reading.stopTaskCalls, 0, 'the interrupt path must not call the background-task stop verb');
  assert.deepEqual(
    reading.leaseAfter,
    reading.leaseBefore,
    'the interrupt path must leave the session_background lease listing identical',
  );
  assert.equal(
    reading.standInAlive,
    true,
    'the stand-in process standing in for the background task / Quay worker must still be alive',
  );
}

/** Everything one case needs to drive the proxy and read what it did. */
type Harness = {
  /** The executor the proxy's `session_send` / `session_interrupt` routes reach. */
  executor: RealtimeToolExecutor;
  /** Every payload the proxy composed and handed to `session_send` — the CLI's own input text. */
  sends: Array<Record<string, unknown>>;
  /** Every `stopTask` the control service was asked for. Empty is the boundary this file pins. */
  stopTaskCalls: Array<{ sessionId: string; taskId: string }>;
  /** The gateway's own `session_background` listing, read fresh each call. */
  listing: () => Promise<SessionBackgroundPayload>;
  /** The most recent S-A reading the proxy published (what `session_status` answers from). */
  latest: () => VoiceRealtimeExecStatusReading | null;
  /** Files the reading the proxy published beside a status line, as the composition root does. */
  noteReading: (reading: VoiceRealtimeExecStatusReading) => void;
  /** A REAL `session_status` answer over the executor's own route. */
  sessionStatus: () => Promise<Record<string, unknown>>;
};

/** The gateway principal the executor's first-party caller adapts onto. */
function principal(): McpPrincipal {
  return { userId: USER_ID, tokenId: 0, clientId: null, scopes: [SCOPE] };
}

/**
 * Builds the executor harness: a REAL live executor (the voice plane's own route table, over the
 * gateway's `buildSessionInterrupt` / `buildSessionBackground` and their injected services) with
 * `session_send` recorded so a case can read the exact text that crossed into the CLI.
 *
 * `onAbort` is what the host does when the abort lands — the CLI delivering the backlog into the
 * interrupt-closing turn. `onStopTask` is what the control service's stop verb does in the world —
 * the false form uses it to end the stand-in process, which is how the false form's third reading
 * becomes a real death rather than a flag.
 */
function createHarness(
  host: FakeHost,
  options: {
    onAbort?: () => void;
    onStopTask?: (input: { sessionId: string; taskId: string }) => void;
    /** Models the violation AC1's false form is about: the interrupt path also reaching `stopTask`. */
    callStopTaskToo?: boolean;
    /**
     * What a `session_send` reach ANSWERS, given its 1-based call number — the default is the
     * confirmed enqueue every case needs to let G1 abort. A case about an enqueue that is NOT
     * confirmed answers something else instead: throwing a `SESSION_BUSY` error on the first call
     * parks that delivery in the busy wait, which is one of the two states where a stop's correction
     * can be handed over and come back unconfirmed (`deliverSessionSend`).
     */
    sendResult?: (args: Record<string, unknown>, call: number) => unknown;
  } = {},
): Harness {
  const sends: Array<Record<string, unknown>> = [];
  const stopTaskCalls: Array<{ sessionId: string; taskId: string }> = [];
  let latest: VoiceRealtimeExecStatusReading | null = null;

  const stopTask = async (_caller: unknown, input: { sessionId: string; taskId: string }) => {
    stopTaskCalls.push(input);
    const binding = host.bindings.get(input.sessionId);
    if (binding) {
      binding.leases = binding.leases.filter((lease) => lease.id !== input.taskId);
    }
    options.onStopTask?.(input);
    return 'requested' as const;
  };

  const sessionBackground = {
    sessions: {
      getSessionById: (sessionId: string) => (sessionId === BOUND_SESSION ? { provider: 'claude' } : null),
    },
    hosts: { liveHostForSession: (sessionId: string) => (sessionId === BOUND_SESSION ? host : null) },
    control: { stopTask },
  } as unknown as McpSessionBackgroundDeps;

  const sessionInterrupt = {
    control: {
      abort: async () => {
        options.onAbort?.();
        return { ok: true, aborted: true };
      },
    },
  } as unknown as McpSessionInterruptDeps;

  const sessionSend = {
    control: { send: async () => ({ ok: true, runId: RUN_ID, queued: false, queuedMessageUuid: null }) },
    runs: { getRun: () => ({ runId: RUN_ID, source: 'mcp', status: 'running' }) },
    runGet: { deps: {}, build: async () => ({}) },
  } as unknown as McpSessionSendDeps;

  const base = createVoiceRealtimeLiveExecutor({
    boundSessionId: BOUND_SESSION,
    caller: { userId: USER_ID, scopes: [SCOPE] },
    visibleContext: never(),
    readTools: never(),
    runGet: never(),
    approvals: never(),
    sessionBackground,
    sessionSend,
    sessionInterrupt,
    onSessionRefusal: () => undefined,
    sessionStatus: { reading: () => latest },
  });

  const executor: RealtimeToolExecutor = {
    ...base,
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      if (options.sendResult !== undefined) {
        return options.sendResult(args, sends.length);
      }
      return { ok: true, queued: true, runId: RUN_ID, queuedMessageUuid: 'uuid-1' };
    },
    // The false form's stand-in: the SAME real interrupt route, but reached through a handler that
    // ALSO asks the control service to stop the session's background task. That is the violation.
    ...(options.callStopTaskToo === true
      ? {
          session_interrupt: async (args: Record<string, unknown>) => {
            await stopTask({ userId: USER_ID, via: 'mcp' }, { sessionId: BOUND_SESSION, taskId: BG_TASK_ID });
            return base.session_interrupt!(args);
          },
        }
      : {}),
  };

  return {
    executor,
    sends,
    stopTaskCalls,
    listing: () => buildSessionBackground({ session: BOUND_SESSION }, { principal: principal() }, sessionBackground),
    latest: () => latest,
    noteReading: (reading) => {
      latest = reading;
    },
    sessionStatus: async () => (await base.session_status!({})) as Record<string, unknown>,
  };
}

// ── the proxy connection ─────────────────────────────────────────────────────────────────────

/** Wires one fresh proxy connection over a fake browser socket and a fake transport. */
function connect(options: {
  executor: RealtimeToolExecutor;
  socket: FakeBrowserSocket;
  transport?: FakeTransport;
  statusRateMs?: number;
  hostQueueReading?: (sessionId: string) => HostQueueReading | null;
  hostRunActivity?: (sessionId: string) => HostRunActivityReading | null;
  onExecStatus?: (reading: VoiceRealtimeExecStatusReading) => void;
  log?: (line: string) => void;
  createTransport?: VoiceRealtimeProxySeams['createTransport'];
}): void {
  const { transport } = options;
  const seams: VoiceRealtimeProxySeams = {
    createTransport: options.createTransport ?? (() => transport!),
    createExecutor: () => options.executor,
    instructions: 'aftermath instructions',
    ...(options.statusRateMs === undefined ? {} : { statusRateMs: options.statusRateMs }),
    ...(options.hostQueueReading === undefined ? {} : { hostQueueReading: options.hostQueueReading }),
    ...(options.hostRunActivity === undefined ? {} : { hostRunActivity: options.hostRunActivity }),
    ...(options.onExecStatus === undefined ? {} : { onExecStatus: options.onExecStatus }),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  handleVoiceRealtimeConnection(
    options.socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    BOUND_SESSION,
    seams,
  );
}

// ── the journal ──────────────────────────────────────────────────────────────────────────────

type InterruptRecord = Extract<VoiceRealtimeLogEntry, { kind: 'interrupt' }>;

/** Every entry this connection's journal holds so far. An absent file is "nothing written yet". */
function journalEntries(directory: string): VoiceRealtimeLogEntry[] {
  const file = path.join(directory, `${CONNECTION_ID}.jsonl`);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as VoiceRealtimeLogEntry];
      } catch {
        return [];
      }
    });
}

/** The interrupt records this connection's journal holds, in the order they were written. */
function interruptRecords(directory: string): InterruptRecord[] {
  return journalEntries(directory).filter((entry): entry is InterruptRecord => entry.kind === 'interrupt');
}

/** The shipping recorder, exactly the pairing `server/index.ts` builds. */
function shippingRecorder(directory: string) {
  return createVoiceRealtimeRecorder({
    store: createVoiceRealtimeLogStore({ directory }),
    connectionId: CONNECTION_ID,
    sessionId: BOUND_SESSION,
    tag: BOUND_SESSION,
    mode: 'segmented',
    // The recorder's own stdout line is not this file's subject; keep the runs silent.
    stdout: () => {},
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── AC1, THE FILE'S FIRST GROUP: the interrupt boundary ──────────────────────────────────────

/**
 * Drives one REAL interrupt through the proxy and reads the three boundary readings around it.
 *
 * The listing is taken through the gateway's own `session_background` build (the shipping reading,
 * not a hand-inspected map), and the stand-in's aliveness is read off the OS.
 */
async function driveBoundaryInterrupt(harness: Harness, standIn: StandIn): Promise<BoundaryReading> {
  await standIn.ready();
  const leaseBefore = await harness.listing();
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostQueueReading: () => ({ items: 0, bytes: 0 }),
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => functionCallOutput(transport, 'call-stop') !== undefined);

    const leaseAfter = await harness.listing();
    // A case whose stop DID reach the verb must let that verb's consequence land before reading the
    // process, so the death is observed rather than raced.
    if (harness.stopTaskCalls.length > 0) {
      await standIn.waitForExit();
    }
    return {
      stopTaskCalls: harness.stopTaskCalls.length,
      leaseBefore,
      leaseAfter,
      standInAlive: standIn.alive(),
    };
  } finally {
    socket.close();
  }
}

test('AC1 false form: an interrupt path that calls stopTask reddens all three boundary readings', async () => {
  const standIn = spawnStandIn();
  try {
    const host = createFakeHost({ pid: standIn.pid, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
    // THE VIOLATION: the interrupt route also asks the control service to stop the background task.
    const harness = createHarness(host, { callStopTaskToo: true, onStopTask: () => standIn.kill() });

    const reading = await driveBoundaryInterrupt(harness, standIn);

    // Each clause of the boundary reading really moved, read one by one so the reds are named.
    assert.equal(reading.stopTaskCalls, 1, 'the violated interrupt path DID reach the background-task verb');
    assert.notDeepEqual(reading.leaseAfter, reading.leaseBefore, 'the violated path DID drop the lease');
    assert.equal(reading.standInAlive, false, 'the violated path DID end the stand-in process');

    // And the ONE assertion the true form shares reddens — clause by clause, so no clause can be
    // satisfied by the other two being satisfied (a reading that only ever looked at one of the
    // three would pass this form).
    assert.throws(
      () => assertInterruptBoundary(reading),
      /must not call the background-task stop verb/,
      'the stopTask clause must be the one that catches this violation first',
    );
    assert.throws(
      () => assertInterruptBoundary({ ...reading, stopTaskCalls: 0 }),
      /leave the session_background lease listing identical/,
      'the lease clause must be load-bearing on its own',
    );
    assert.throws(
      () => assertInterruptBoundary({ ...reading, stopTaskCalls: 0, leaseAfter: reading.leaseBefore }),
      /must still be alive/,
      'the process clause must be load-bearing on its own',
    );
  } finally {
    standIn.dispose();
  }
});

test('AC1 true form: a real interrupt calls stopTask zero times, leaves the lease identical and the stand-in alive', async () => {
  const standIn = spawnStandIn();
  try {
    const host = createFakeHost({ pid: standIn.pid, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
    // A real interrupt: the shipping live executor route, no extra control verb reached.
    const harness = createHarness(host, { onStopTask: () => standIn.kill() });

    const reading = await driveBoundaryInterrupt(harness, standIn);

    // The stop really happened — otherwise the boundary would be trivially satisfied by a stop that
    // never ran at all.
    assert.equal(reading.leaseBefore.ok, true, 'the gateway listing must have answered');
    assert.equal(reading.leaseBefore.tasks.length, 1, 'the host must hold the one background-task lease');
    assert.equal(reading.leaseBefore.tasks[0]!.id, BG_TASK_ID);
    assert.equal(reading.standInAlive, true, 'the stand-in must still be running when the readings are taken');

    assertInterruptBoundary(reading);
  } finally {
    standIn.dispose();
  }
});

// ── AC2: one source — the stopped frame, the S-A line and session_status ─────────────────────

test('AC2: the stopped frame, the S-A line and session_status.queuedItems are one post-stop host reading', async () => {
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  // The host's own queue. It holds three of the person's messages when the stop arrives, and the
  // abort — the CLI delivering the backlog into the interrupt-closing turn — drains two of them.
  // That 3→1 move is what makes "the reported depth is a FRESH sample" a reading rather than a hope.
  const queue = { items: 3, bytes: 30 };
  const harness = createHarness(host, {
    onAbort: () => {
      queue.items = 1;
      queue.bytes = 10;
    },
  });
  const readings: VoiceRealtimeExecStatusReading[] = [];
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    statusRateMs: 20,
    hostQueueReading: () => ({ items: queue.items, bytes: queue.bytes }),
    onExecStatus: (reading) => {
      readings.push(reading);
      harness.noteReading(reading);
    },
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    // A run this connection is on, so the stop has a run to name and the host has a pre-stop sample.
    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long thing' });
    await waitFor(() => harness.sends.length === 1);
    await waitFor(() => statusLines(transport).some((line) => line.includes('queued=3/30B')));

    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => framesOf<StoppedFrame>(socket, 'stopped').length === 1);
    await waitFor(() => statusLines(transport).some((line) => line.includes('queued=1/10B')));

    const stopped = framesOf<StoppedFrame>(socket, 'stopped')[0]!;
    // The frame names the run the stop ENDED, not a null that would pass for the wrong reason.
    assert.equal(stopped.aborted, true);
    assert.equal(stopped.runId, RUN_ID, 'the frame must carry the runId the stop ended');

    const line = statusLines(transport).find((candidate) => candidate.includes('queued=1/10B'))!;
    const match = /queued=(\d+)\/(\d+)B/.exec(line);
    assert.ok(match, `the injected line must carry a numeric queued=<items>/<bytes>B reading: ${line}`);

    const status = await harness.sessionStatus();
    const reading = harness.latest();
    assert.ok(reading, 'the proxy must have published the post-stop reading');

    // ── The one sample point, printed whole: all four surfaces, and the host's real value. ──
    const surfaces = {
      stoppedDepth: stopped.depth,
      lineItems: Number(match![1]),
      lineBytes: Number(match![2]),
      statusItems: Number(status['queuedItems']),
      statusBytes: Number(status['queuedBytes']),
      statusRunId: status['runId'],
      readingItems: reading!.queuedItems,
      readingBytes: reading!.queuedBytes,
      hostItems: queue.items,
      hostBytes: queue.bytes,
    };
    assert.deepEqual(
      surfaces,
      {
        stoppedDepth: 1,
        lineItems: 1,
        lineBytes: 10,
        statusItems: 1,
        statusBytes: 10,
        statusRunId: RUN_ID,
        readingItems: 1,
        readingBytes: 10,
        hostItems: 1,
        hostBytes: 10,
      },
      `the stopped frame, the S-A line, session_status and the host must be one reading: ${JSON.stringify(surfaces)}`,
    );

    // ── The contrast: the pre-stop value really was 3, so a reading carried over would have said 3. ──
    assert.notEqual(stopped.depth, 3, 'the depth must be a fresh POST-stop sample, not the pre-stop 3');
    assert.ok(
      readings.some((entry) => entry.queuedItems === 3),
      'the pre-stop sample of 3 must have been published — otherwise the contrast above is vacuous',
    );
  } finally {
    socket.close();
  }
});

// ── AC3: the next turn's note names the in-flight tool and forbids nothing ───────────────────

test('AC3: the first message into the CLI after the interrupt names the in-flight tool and warns of partial changes', async () => {
  const directory = tempDir('voice-aftermath-');
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const harness = createHarness(host);
  const recorder = shippingRecorder(directory);
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    // Round 1: a run that is executing a long `Bash` tool when the stop arrives.
    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long bash thing' });
    await waitFor(() => harness.sends.length === 1);
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => interruptRecords(directory).length === 1);

    // The next turn: the first message that enters the CLI after the interruption.
    deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
    await waitFor(() => harness.sends.length === 2);

    const delivered = String(harness.sends[1]!.message);

    // ── AC3's reading: the note names the tool and warns of partial changes… ──
    assert.match(delivered, /`Bash`/, 'the note must name the tool the interrupted turn was running');
    assert.match(delivered, /partial changes/i, 'the note must say partial changes may remain');
    assert.match(delivered, /interrupted/i, 'the note must say the previous turn was interrupted');
    // ── …and the person's own words are intact, after the note. ──
    assert.ok(delivered.endsWith(NEXT_MESSAGE), `the current instruction must follow the note: ${delivered}`);
    assert.ok(
      delivered.startsWith('[The previous turn was interrupted'),
      `the note must be a fixed prefix, not woven into the person's words: ${delivered}`,
    );

    // ── §11.4: the full text of what entered the CLI names no undo of any kind. ──
    assert.doesNotMatch(
      delivered,
      /revert|rollback|undo|撤销|回滚/i,
      '§11.4 forbids the interruption path from claiming it undid anything',
    );

    // ── The journal says the same tool, from the one reading taken at the stop. ──
    const record = interruptRecords(directory)[0]!;
    assert.equal(record.outcome, 'aborted');
    assert.equal(record.inFlightTool, 'Bash', 'the audit line must name the same tool the note names');
    assert.equal(record.runId, RUN_ID);

    // ── The fixed sentence itself: one note, spent on ONE message. ──
    deliverFunctionCall(transport, 'call-next-2', 'session_send', { message: 'and one more thing' });
    await waitFor(() => harness.sends.length === 3);
    assert.doesNotMatch(
      String(harness.sends[2]!.message),
      /interrupted/i,
      'the note belongs to the FIRST message of the next turn, not to every later one',
    );

    // ── The builder's own two properties, read directly: the tool form, and no undo words. ──
    const note = buildInterruptAftermathNote('Bash');
    assert.match(note, /`Bash`/);
    assert.match(note, /partial changes/i);
    assert.doesNotMatch(note, /revert|rollback|undo|撤销|回滚/i);
    assert.notEqual(
      note,
      buildInterruptAftermathNote(null),
      'the tool form and the tool-free form are different sentences',
    );
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── AC4: an unreadable in-flight tool must not be guessed ────────────────────────────────────

test('AC4: an unreadable in-flight tool gives the tool-free note and a null journal reading', async () => {
  // The three ways the reading can be unavailable, all ONE answer (C-3): no seam at all, a seam
  // with no reading, and a seam that throws.
  const forms = ['absent', 'null', 'throws'] as const;
  for (const form of forms) {
    const directory = tempDir('voice-aftermath-unreadable-');
    const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
    const harness = createHarness(host);
    const recorder = shippingRecorder(directory);
    const socket = new FakeBrowserSocket();
    const transport = createFakeTransport();
    connect({
      executor: harness.executor,
      transport,
      socket,
      ...(form === 'null' ? { hostRunActivity: () => null } : {}),
      ...(form === 'throws'
        ? {
            hostRunActivity: () => {
              throw new Error('the host activity record is not readable');
            },
          }
        : {}),
      log: recorder.log,
    });
    try {
      await waitFor(() => transport.openCalls >= 1);
      await waitForOpen(socket);

      deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long thing' });
      await waitFor(() => harness.sends.length === 1);
      deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
      await waitFor(() => interruptRecords(directory).length === 1);

      deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
      await waitFor(() => harness.sends.length === 2);

      const delivered = String(harness.sends[1]!.message);

      // ── AC4's reading: the tool-free form, and no tool named anywhere in it. ──
      assert.match(
        delivered,
        /The previous turn was interrupted before it finished\./,
        `${form}: an unreadable tool must give the tool-free sentence`,
      );
      assert.ok(!delivered.includes('`'), `${form}: the tool-free note must not name a tool in backticks`);
      assert.ok(!delivered.includes('that tool'), `${form}: the tool-free note must not refer to "that tool"`);
      assert.match(delivered, /partial changes/i, `${form}: the warning about partial changes survives`);
      assert.doesNotMatch(delivered, /revert|rollback|undo|撤销|回滚/i, `${form}: §11.4 still holds`);

      // ── The journal records the unreadable reading as `null`, never as a guess. ──
      const record = interruptRecords(directory)[0]!;
      assert.equal(record.outcome, 'aborted');
      assert.equal(record.inFlightTool, null, `${form}: the audit line must say null rather than guess`);
      assert.equal(record.runId, RUN_ID);
    } finally {
      socket.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

// ── WHICH MESSAGE THE NOTE RIDES: the stop's own correction, or whatever follows ──────────────

/**
 * The one note the proxy prefixes to the first message after a stop, read from the builder the
 * proxy itself calls — so a case asserts on the sentence the deployment ships, not on a copy of it.
 */
const NOTE_PREFIX = '[The previous turn was interrupted';

test('the note rides the stop`s own correction: that correction carries it, and the next message is the person`s alone', async () => {
  const directory = tempDir('voice-aftermath-correction-');
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const harness = createHarness(host);
  const recorder = shippingRecorder(directory);
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    // Round 1: a run executing a long `Bash` tool when the stop arrives.
    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long bash thing' });
    await waitFor(() => harness.sends.length === 1);

    // The stop CARRIES the correction — the words that answer the interruption (D-6).
    const correction = 'stop that and list the files in the current directory instead';
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      intent: 'the user changed direction',
      message: correction,
    });
    await waitFor(() => interruptRecords(directory).length === 1);

    // ── THE READING: the correction is the message the note rides ──
    // Delivered through the SAME `session_send` reach the person's own words use, BEFORE the abort
    // (G1), so this text is exactly what the interrupt-closing turn is handed.
    assert.equal(harness.sends.length, 2, 'the correction is delivered as a session_send of its own');
    const deliveredCorrection = String(harness.sends[1]!.message);
    assert.ok(
      deliveredCorrection.startsWith(NOTE_PREFIX),
      `the note must ride the correction, not a later message: ${deliveredCorrection}`,
    );
    assert.ok(
      deliveredCorrection.endsWith(correction),
      `the correction's own words must close the delivered text, verbatim: ${deliveredCorrection}`,
    );
    assert.match(deliveredCorrection, /`Bash`/, 'and the note still names the tool the interrupted run was in');

    // ── AND THE NEXT ORDINARY MESSAGE IS NOT ITS CARRIER ──
    // The defect this replaces: the note was armed after the abort and landed on whatever the person
    // said next, where "the previous turn was interrupted" describes the run that already answered
    // the correction, and "everything after this note takes precedence" demotes the correction.
    deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
    await waitFor(() => harness.sends.length === 3);
    const deliveredNext = String(harness.sends[2]!.message);
    assert.equal(
      deliveredNext,
      NEXT_MESSAGE,
      'the message after the correction carries no note — the note was spent on the correction',
    );
    assert.ok(!deliveredNext.includes('previous turn was interrupted'));

    // ── The audit records the same fact from the delivery's own side. ──
    const record = interruptRecords(directory)[0]!;
    assert.equal(record.outcome, 'aborted');
    assert.equal(record.inFlightTool, 'Bash', 'the journal names the same tool the note names');
    assert.equal(record.noteCarried, true, 'the audit says this stop`s note rode its own correction');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a stop with NO correction keeps the older shape: the note is armed for the next message, and the audit says so', async () => {
  const directory = tempDir('voice-aftermath-bare-');
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const harness = createHarness(host);
  const recorder = shippingRecorder(directory);
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long bash thing' });
    await waitFor(() => harness.sends.length === 1);
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', { intent: 'the user said stop' });
    await waitFor(() => interruptRecords(directory).length === 1);

    deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
    await waitFor(() => harness.sends.length === 2);
    assert.ok(
      String(harness.sends[1]!.message).startsWith(NOTE_PREFIX),
      'a bare stop`s note still rides the next message — that behaviour is unchanged',
    );

    const record = interruptRecords(directory)[0]!;
    assert.equal(record.outcome, 'aborted');
    assert.equal(
      record.noteCarried,
      false,
      'no correction means no message of its own: the note was not carried by this stop`s delivery',
    );
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an enqueue that never happened revokes the note: neither the correction nor what follows carries one', async () => {
  const directory = tempDir('voice-aftermath-refused-');
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  // The first reach is PARKED: `sessionInterrupt` reads the single-flight `sending` flag BEFORE it
  // reaches `deliverSessionSend`, so a stop arriving while a delivery is in flight never hands its
  // correction over — that is the first of the two ways the enqueue goes unconfirmed, and the only
  // one in which the note has no message to ride.
  let releaseFirst: () => void = () => undefined;
  const firstParked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const harness = createHarness(host, {
    sendResult: async (_args, call) => {
      if (call === 1) {
        await firstParked;
      }
      return { ok: true, queued: true, runId: RUN_ID, queuedMessageUuid: `uuid-${call}` };
    },
  });
  const recorder = shippingRecorder(directory);
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long bash thing' });
    await waitFor(() => harness.sends.length === 1);

    const correction = 'stop that and list the files instead';
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      intent: 'the user changed direction',
      message: correction,
    });
    await waitFor(() => interruptRecords(directory).length === 1);
    const receipt = functionCallOutput(transport, 'call-stop')!.output as Record<string, unknown>;
    assert.equal(receipt['stopped'], false, 'an unconfirmed enqueue must not claim a stop');
    assert.equal(receipt['reason'], 'revision-not-enqueued');

    // ── NEITHER THE CORRECTION NOR WHAT FOLLOWS CARRIES A NOTE ──
    // The correction never reached the CLI (nothing to carry a note), and the note armed for it was
    // REVOKED rather than left standing — so the next message is the person's words alone.
    assert.equal(harness.sends.length, 1, 'the correction was never handed to the session');
    releaseFirst();
    await waitFor(() => framesOf(socket, 'sent').length === 1);
    deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
    await waitFor(() => harness.sends.length === 2);
    assert.equal(
      String(harness.sends[1]!.message),
      NEXT_MESSAGE,
      'the note was revoked with the unconfirmed enqueue, not deferred onto the next message',
    );

    const record = interruptRecords(directory)[0]!;
    assert.equal(record.outcome, 'refused', 'the refused stop is recorded');
    assert.equal(record.noteCarried, false, 'and it records that no note went out with this correction');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('LIMIT: a correction handed over and NOT confirmed carries the note anyway, and the audit records noteCarried', async () => {
  // THE HONEST LIMIT OF "REVOKE". The note is armed BEFORE the enqueue (that is the whole mechanism
  // by which it rides the correction), so on the SECOND way the enqueue goes unconfirmed — the
  // delivery is made and the session does not confirm the message entered its queue — the note has
  // already crossed into the CLI and CANNOT be recalled. The implementation records that instead of
  // pretending: `noteCarried: true` beside `outcome: 'refused'` is the pair that makes "an
  // interruption note was delivered for a stop that did not happen" measurable (see the open
  // question in `## Notes`). What IS guaranteed is the other half: the note is spent, so it does not
  // come back on the next message.
  const directory = tempDir('voice-aftermath-unconfirmed-');
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const harness = createHarness(host, {
    // The stop's own reach (call 2) answers WITHOUT the queue confirmation: nothing waiting took it.
    sendResult: (_args, call) =>
      call === 2
        ? { ok: true, queued: false, runId: null, queuedMessageUuid: null }
        : { ok: true, queued: true, runId: RUN_ID, queuedMessageUuid: `uuid-${call}` },
  });
  const recorder = shippingRecorder(directory);
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long bash thing' });
    await waitFor(() => harness.sends.length === 1);

    const correction = 'stop that and list the files instead';
    deliverFunctionCall(transport, 'call-stop', 'session_interrupt', {
      intent: 'the user changed direction',
      message: correction,
    });
    await waitFor(() => interruptRecords(directory).length === 1);
    const receipt = functionCallOutput(transport, 'call-stop')!.output as Record<string, unknown>;
    assert.equal(receipt['stopped'], false);
    assert.equal(receipt['reason'], 'revision-not-enqueued');

    // The correction was handed over, note and all — the delivery happened even though the queue
    // confirmation did not.
    assert.equal(harness.sends.length, 2, 'the correction was handed to the session');
    const delivered = String(harness.sends[1]!.message);
    assert.ok(delivered.startsWith(NOTE_PREFIX), `the note is on it and cannot be recalled: ${delivered}`);
    assert.ok(delivered.endsWith(correction));

    // The OTHER half holds: it was SPENT, so it does not reappear on the next message.
    deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
    await waitFor(() => harness.sends.length === 3);
    assert.equal(String(harness.sends[2]!.message), NEXT_MESSAGE, 'the note is spent, never re-sent');

    const record = interruptRecords(directory)[0]!;
    assert.equal(record.outcome, 'refused');
    assert.equal(record.noteCarried, true, 'the audit says the note left with this stop`s correction');
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a stop the fence answers `covered` arms no note and sends nothing', async () => {
  const directory = tempDir('voice-aftermath-covered-');
  const host = createFakeHost({ pid: null, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const harness = createHarness(host);
  const recorder = shippingRecorder(directory);
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  connect({
    executor: harness.executor,
    transport,
    socket,
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
  });
  try {
    await waitFor(() => transport.openCalls >= 1);
    await waitForOpen(socket);

    // ONE spoken sentence, relayed — the `utteranceSeq` both stops below are for. Until it is
    // relayed the fence has no `triggerSeq` and would never answer `covered`.
    deliverTranscript(transport, 'item-1', 'run the long bash thing');
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'caption'));
    deliverFunctionCall(transport, 'call-send', 'session_send', { message: 'run the long bash thing' });
    await waitFor(() => harness.sends.length === 1);

    // The first stop for that sentence really runs: it aborts, and its note rides its own correction.
    const correction = 'stop that and list the files instead';
    deliverFunctionCall(transport, 'call-stop-1', 'session_interrupt', {
      intent: 'the user changed direction',
      message: correction,
    });
    await waitFor(() => interruptRecords(directory).length === 1);
    assert.equal(interruptRecords(directory)[0]!.outcome, 'aborted');
    const sendsAfterFirst = harness.sends.length;
    assert.equal(
      sendsAfterFirst,
      2,
      `the correction went in as the stop\`s own message: ${JSON.stringify(harness.sends.map((s) => s.message))}`,
    );

    // The SAME triggerSeq again, carrying a correction: the fence answers `covered` (SPEC §18.4 G2).
    // It returns BEFORE anything is armed, so this stop has no message to carry a note and none is
    // left armed — the correction is not delivered at all.
    deliverFunctionCall(transport, 'call-stop-2', 'session_interrupt', {
      intent: 'the user changed direction',
      message: 'and this correction must not be delivered either',
    });
    await waitFor(() => interruptRecords(directory).length === 2);
    const covered = interruptRecords(directory)[1]!;
    assert.equal(covered.outcome, 'covered');
    assert.equal(
      harness.sends.length,
      sendsAfterFirst,
      'a covered stop delivers nothing — its correction never reaches the session',
    );
    assert.equal(covered.noteCarried, false, 'and it arms no note for a later message to carry');

    // ── the reading that makes the arming observable: the next ordinary message carries no note ──
    // Had the covered stop armed one, it would be sitting armed right now and would ride this message.
    deliverFunctionCall(transport, 'call-next', 'session_send', { message: NEXT_MESSAGE });
    await waitFor(() => harness.sends.length === sendsAfterFirst + 1);
    assert.equal(
      String(harness.sends[sendsAfterFirst]!.message),
      NEXT_MESSAGE,
      'no note was armed by the covered stop',
    );
  } finally {
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── DoD: the same stop over the REAL transport, read back off the journal file ───────────────
test('DoD: over the real transport and proxy, round 1 stops on a long Bash tool and the next turn is told so', async (t) => {
  const directory = tempDir('voice-aftermath-dod-');
  const standIn = spawnStandIn();
  const host = createFakeHost({ pid: standIn.pid, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const queue = { items: 2, bytes: 20 };
  const harness = createHarness(host, {
    onAbort: () => {
      queue.items = 0;
      queue.bytes = 0;
    },
    onStopTask: () => standIn.kill(),
  });
  const recorder = shippingRecorder(directory);
  // The REAL DashScope transport over the scripted stand-in, dialling an unroutable host: the round
  // trip the readings are taken from is the shipping one, and nothing can leave the machine.
  const upstream = createScriptedUpstream();
  const socket = new FakeBrowserSocket();
  connect({
    executor: harness.executor,
    socket,
    statusRateMs: 20,
    hostQueueReading: () => ({ items: queue.items, bytes: queue.bytes }),
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
    createTransport: (report) =>
      createDashscopeTransport({
        apiKey: '',
        endpoint: SCRIPTED_ENDPOINT_URL,
        socketFactory: upstream.socketFactory,
        onError: report,
        observer: recorder.observe,
      }),
  });

  try {
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

    // ── Round 1: a spoken instruction, and the run it starts is executing a long `Bash` tool. ──
    upstream.emit(captionCompleted('item-1', 'run the long bash thing'));
    upstream.emit(functionCall('session_send', { message: 'run the long bash thing' }, 'call-send'));
    await waitFor(() => harness.sends.length === 1);

    // ── The stop, then the next turn's first words. ──
    upstream.emit(
      functionCall('session_interrupt', { intent: 'the user said stop', heard: 'run the long bash thing' }, 'call-stop'),
    );
    await waitFor(() => interruptRecords(directory).length === 1);
    upstream.emit(functionCall('session_send', { message: NEXT_MESSAGE }, 'call-next'));
    await waitFor(() => harness.sends.length === 2);

    // ── Reading 1: the ACTUAL text of the next turn's CLI input. ──
    const nextTurnInput = String(harness.sends[1]!.message);
    t.diagnostic(`DoD next-turn CLI input: ${JSON.stringify(nextTurnInput)}`);
    assert.match(nextTurnInput, /`Bash`/);
    assert.match(nextTurnInput, /partial changes/i);
    assert.doesNotMatch(nextTurnInput, /revert|rollback|undo|撤销|回滚/i);

    // ── Reading 2: the raw `kind:'interrupt'` line, as it sits in the journal FILE. ──
    const raw = readFileSync(path.join(directory, `${CONNECTION_ID}.jsonl`), 'utf8')
      .split('\n')
      .find((line) => line.includes('"kind":"interrupt"'));
    assert.ok(raw, 'the journal file must hold a kind:interrupt line');
    t.diagnostic(`DoD journal interrupt line: ${raw}`);
    const onDisk = JSON.parse(raw!) as InterruptRecord;
    assert.equal(onDisk.kind, 'interrupt');
    assert.equal(onDisk.by, 'model');
    assert.equal(onDisk.outcome, 'aborted');
    assert.equal(onDisk.runId, RUN_ID);
    assert.equal(onDisk.inFlightTool, 'Bash', 'the journal must name the tool the interrupted run was in');

    // ── Reading 3: the stand-in process standing in for the background task / Quay worker. ──
    t.diagnostic(`DoD stand-in process pid=${standIn.pid} alive=${String(standIn.alive())}`);
    assert.equal(standIn.alive(), true, 'the interrupt must not have ended the background task process');
    assert.equal(harness.stopTaskCalls.length, 0, 'the interrupt must not have reached the stop-task verb');

    // ── Zero cloud calls: the only address the transport dialled is the scripted stand-in. ──
    assert.ok(
      upstream.dialedUrl !== null && upstream.dialedUrl.startsWith(SCRIPTED_ENDPOINT_URL),
      `nothing but the scripted stand-in may be dialled: ${String(upstream.dialedUrl)}`,
    );
  } finally {
    socket.close();
    standIn.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * THE DoD FOR THE CORRECTION FORM, over the SAME real transport and fake resident host — zero cloud
 * calls (the only address dialled is `ws://scripted.invalid`).
 *
 * The three readings this task's `## Notes` carries verbatim come from here: the full text of the
 * correction as it entered the CLI, the full text of the message that followed it, and the raw
 * `kind:'interrupt'` line as it sits in the journal FILE — that last one being where `noteCarried`
 * has to be readable, not merely asserted on in memory.
 */
test('DoD(correction): over the real transport, a stop carrying a correction puts the note ON the correction and records noteCarried', async (t) => {
  const directory = tempDir('voice-aftermath-dod-correction-');
  const standIn = spawnStandIn();
  const host = createFakeHost({ pid: standIn.pid, leases: [{ kind: 'background-task', id: BG_TASK_ID }] });
  const queue = { items: 2, bytes: 20 };
  const harness = createHarness(host, {
    onAbort: () => {
      queue.items = 0;
      queue.bytes = 0;
    },
    onStopTask: () => standIn.kill(),
  });
  const recorder = shippingRecorder(directory);
  const upstream = createScriptedUpstream();
  const socket = new FakeBrowserSocket();
  connect({
    executor: harness.executor,
    socket,
    statusRateMs: 20,
    hostQueueReading: () => ({ items: queue.items, bytes: queue.bytes }),
    hostRunActivity: () => ({ inFlightTool: 'Bash' }),
    log: recorder.log,
    createTransport: (report) =>
      createDashscopeTransport({
        apiKey: '',
        endpoint: SCRIPTED_ENDPOINT_URL,
        socketFactory: upstream.socketFactory,
        onError: report,
        observer: recorder.observe,
      }),
  });

  try {
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

    // ── Round 1: a spoken instruction, and the run it starts is executing a long `Bash` tool. ──
    upstream.emit(captionCompleted('item-1', 'run the long bash thing'));
    upstream.emit(functionCall('session_send', { message: 'run the long bash thing' }, 'call-send'));
    await waitFor(() => harness.sends.length === 1);

    // ── The stop, CARRYING the correction, then the message after it. ──
    const correction = 'stop the bash run and list the current directory instead';
    upstream.emit(
      functionCall(
        'session_interrupt',
        { intent: 'the user changed direction', heard: 'run the long bash thing', message: correction },
        'call-stop',
      ),
    );
    await waitFor(() => interruptRecords(directory).length === 1);
    upstream.emit(functionCall('session_send', { message: NEXT_MESSAGE }, 'call-next'));
    await waitFor(() => harness.sends.length === 3);

    // ── Reading 1: the ACTUAL text of the correction as it entered the CLI. ──
    const correctionInput = String(harness.sends[1]!.message);
    t.diagnostic(`DoD correction CLI input: ${JSON.stringify(correctionInput)}`);
    assert.ok(correctionInput.startsWith('[The previous turn was interrupted'), 'the note rides the correction');
    assert.ok(correctionInput.endsWith(correction), 'and the correction`s own words close it, verbatim');
    assert.match(correctionInput, /`Bash`/);
    assert.match(correctionInput, /partial changes/i);
    assert.doesNotMatch(correctionInput, /revert|rollback|undo|撤销|回滚/i);

    // ── Reading 2: the ACTUAL text of the message that followed it — the person's words, alone. ──
    const afterInput = String(harness.sends[2]!.message);
    t.diagnostic(`DoD following-message CLI input: ${JSON.stringify(afterInput)}`);
    assert.equal(afterInput, NEXT_MESSAGE, 'the note was spent on the correction, not deferred here');

    // ── Reading 3: the raw `kind:'interrupt'` line as it sits in the journal FILE. ──
    const raw = readFileSync(path.join(directory, `${CONNECTION_ID}.jsonl`), 'utf8')
      .split('\n')
      .find((line) => line.includes('"kind":"interrupt"'));
    assert.ok(raw, 'the journal file must hold a kind:interrupt line');
    t.diagnostic(`DoD journal interrupt line: ${raw}`);
    const onDisk = JSON.parse(raw!) as InterruptRecord;
    assert.equal(onDisk.kind, 'interrupt');
    assert.equal(onDisk.outcome, 'aborted');
    assert.equal(onDisk.runId, RUN_ID);
    assert.equal(onDisk.inFlightTool, 'Bash');
    assert.equal(onDisk.noteCarried, true, 'the journal line must say the note rode this stop`s correction');

    // ── The stop still did not touch the background task's process or verb. ──
    t.diagnostic(`DoD stand-in process pid=${standIn.pid} alive=${String(standIn.alive())}`);
    assert.equal(standIn.alive(), true);
    assert.equal(harness.stopTaskCalls.length, 0);

    // ── Zero cloud calls. ──
    assert.ok(
      upstream.dialedUrl !== null && upstream.dialedUrl.startsWith(SCRIPTED_ENDPOINT_URL),
      `nothing but the scripted stand-in may be dialled: ${String(upstream.dialedUrl)}`,
    );
  } finally {
    socket.close();
    standIn.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The frame shapes this file reads; `Extract` keeps them exact members of the union. */
type StoppedFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'stopped' }>;
