/**
 * The busy hold's SECOND way out: the quiet window, and the tier it releases under (X3' replay, 2026-10-15).
 *
 * WHAT THIS FILE PINS. Until this task the ONE way a merged message held for a busy session could leave
 * was the run ENDING (`pollBusy`, ruling 2026-10-14). The replay in `experiments/voice-now-priority/`
 * measured what that costs: on 84 valid readings the delivery delay's p90 was 18.5 s (arm A) / 10.8 s
 * (arm B), the first reaction's p90 22.5 s (over budget) / 14.0 s, and in 4/4 of the A/B runs a
 * `[DUP+REMARK]` pair buffered to the turn end landed AFTER the model had already answered it — buying a
 * whole duplicated turn for an instruction the model then read twice. Arm D changed exactly two things:
 * the release point (the upstream quiet for 2 s, floored at 800 ms after the last piece, capped at 20 s
 * from the first) and the tier the frame is written under (`next` instead of `later`). Same 84 readings:
 * p90 delivery 1.6 s, p90 first reaction 8.4 s, 9/16 runs with background work — and zero of the
 * duplicated turns. This file pins both changes, and pins that only the release carries them.
 *
 * WHAT IS DRIVEN. `handleVoiceRealtimeConnection` — the real proxy — over the fake browser socket and
 * fake transport the other continuous-mode criteria use, with the SCRIPTED CLI HOST behind the executor
 * so a delivery is a real command in a real queue. Two seams are hand-built: `hostRunActivity`, whose
 * `busy` field is the host's answer to "is a turn in flight" (a test flips it to end the run), and the
 * three quiet-window numbers, shrunk where a case needs the release observable in milliseconds rather
 * than in seconds.
 *
 * The upstream's own turn reporting is driven the way the real endpoint drives it — a
 * `input_audio_buffer.speech_stopped` frame delivered through the transport, which is what the bridge
 * routes to `onUpstreamTurn(false)` and therefore what the window counts its 2 s from.
 *
 *   · AC1 — the release lands at `max(piece + 800 ms, stop + 2000 ms)`, and BEFORE the run ends.
 *   · AC2 — an upstream that never closes its turn (the person talks over the whole window) releases at
 *     the cap instead, counted from the hold's first piece; and the shipped cap is the 20 s the replay
 *     measured, not the seam's scaled value.
 *   · AC3 — the released frame is written under `next`, read off the argument bag the executor is
 *     reached with, and the run-ending release still carries no tier at all.
 *   · AC5's two false forms are the sibling criteria's reds (see `## Notes` in the task): with the
 *     release's tier forced back to `later` AC3 reds; with the window widened to infinity AC1 reds.
 *
 * Run:
 *   npx tsx --tsconfig=server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-busy-quiet-window.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { type RealtimeServerMessage, type RealtimeToolExecutor } from '../index.js';
import {
  composeHostRunActivityReading,
  handleVoiceRealtimeConnection,
  VOICE_BUSY_QUIET_CAP_MS,
  VOICE_BUSY_QUIET_SINCE_PIECE_MS,
  VOICE_BUSY_QUIET_WINDOW_MS,
  VOICE_BUSY_RELEASE_PRIORITY,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import { createScriptedCliHost } from './voice-realtime-scripted-cli-host.js';

type Handler = typeof handleVoiceRealtimeConnection;
type PendingFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'pending' }>;

/**
 * How far a release may land from the deadline it was computed at.
 *
 * A WINDOW, not a tick, and deliberately asymmetric. `setTimeout` never fires EARLY, so the lower
 * bound is only a millisecond of rounding; the upper bound is load headroom — this criterion runs in
 * the same suite as everything else and a late timer is not a wrong deadline. The gap it has to close
 * is enormous on purpose: the two deadlines the criterion distinguishes are 800 ms/2 s apart from each
 * other and 20 s from the cap, so headroom of a few hundred milliseconds cannot make a wrong deadline
 * read as the right one.
 */
const DEADLINE_SLACK_MS = 25;
const DEADLINE_HEADROOM_MS = 500;

/**
 * The replay's own three numbers, written as LITERALS — deliberately not read from the module's
 * constants, which is the trap this file has to avoid being caught by.
 *
 * The case drives the connection with the SHIPPED constants (they are the seams' values), so that a
 * constant moved off these numbers changes what the relay does and the criterion sees it. If the
 * criterion then computed its own deadline from the same constant, the expectation would move with the
 * defect and the case would stay green: a window widened to infinity would give `expected = Infinity`,
 * and the assertion would red on `Infinity` arithmetic rather than on "the release did not land". Two
 * independent statements, then — the shipped numbers are pinned in AC2 against the same literals, and
 * the arithmetic here is judged against them.
 */
const REPLAY_QUIET_WINDOW_MS = 2000;
const REPLAY_QUIET_SINCE_PIECE_MS = 800;
const REPLAY_QUIET_CAP_MS = 20_000;

/** The minimal `ws.WebSocket` surface the proxy uses, driven over an EventEmitter. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

const framesOf = <T extends VoiceRealtimeOutboundFrame>(socket: FakeBrowserSocket, type: T['type']): T[] =>
  socket.outbound.filter((frame): frame is T => frame.type === type);

/** One `session_send` reach, with the argument bag the relay actually handed the executor. */
type SendReach = {
  /** The frame's text. */
  message: string;
  /** When the executor was reached, on the same clock the criterion's readings use. */
  at: number;
  /** The tier the bag named, or `undefined` when it named none. */
  priority: unknown;
};

type Harness = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  /** Every `session_send` reach, in order — the readings the timing and the tier are taken from. */
  sends: SendReach[];
  /** Every journal line the proxy wrote. */
  logs: string[];
  setBusy: (busy: boolean) => void;
};

/**
 * One continuous connection with a short coalescing window, a short hold poll, and the quiet window's
 * three numbers supplied by the case. The scripted CLI host sits behind the executor, so a delivery is
 * a real command in its queue.
 */
function wire(
  options: { coalesceMs?: number; quietWindowMs: number; quietSincePieceMs: number; quietCapMs: number },
): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const host = createScriptedCliHost();
  const sends: SendReach[] = [];
  const logs: string[] = [];
  // The host's own rounds saying "a turn is in flight", held apart from the activity phase so the
  // reading is driven from the same source the deployed composition prefers (`server/index.ts`).
  let roundsBusy = false;
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      const message = typeof args.message === 'string' ? args.message : '';
      sends.push({ message, at: Date.now(), priority: args.priority });
      return host.accept(message);
    },
    session_interrupt: async () => host.abort(),
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    coalesceMs: options.coalesceMs ?? 20,
    busyPollMs: 5,
    busyQuietWindowMs: options.quietWindowMs,
    busyQuietSincePieceMs: options.quietSincePieceMs,
    busyQuietCapMs: options.quietCapMs,
    log: (line) => logs.push(line),
    hostRunActivity: () =>
      composeHostRunActivityReading({
        roundsBusy,
        turn: { phase: 'idle', toolName: host.runActivity().inFlightTool },
      }),
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<Handler>[0], 'session-under-test', seams);
  return {
    socket,
    transport,
    sends,
    logs,
    setBusy: (next) => (roundsBusy = next),
  };
}

async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** One relayed instruction, as the real wire reports it. */
function relay(transport: FakeTransport, callId: string, message: string): void {
  transport.peerSend({
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message }),
  } as RealtimeServerMessage);
}

/** The endpoint's own turn opening — the reading that says the person is still talking. */
function upstreamSpeechStarted(transport: FakeTransport): void {
  transport.peerSend({ type: 'input_audio_buffer.speech_started' } as RealtimeServerMessage);
}

/** The endpoint's own turn closing — the instant the quiet window's 2 s is counted from. */
function upstreamSpeechStopped(transport: FakeTransport): void {
  transport.peerSend({ type: 'input_audio_buffer.speech_stopped' } as RealtimeServerMessage);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for `condition` until `deadlineAt`, and answers whether it ever became true.
 *
 * A DEADLINE-shaped wait rather than the harness's fixed-bound `waitFor`: the criterion's claim is
 * "the release lands by this deadline", so the assertion that reds when it does not has to be the one
 * NAMING the deadline. Under `waitFor` the false form (a window that never closes) would red as a
 * helper timeout, which says a wait expired rather than which release point was wrong.
 */
async function holdsBy(deadlineAt: number, condition: () => boolean): Promise<boolean> {
  while (Date.now() <= deadlineAt) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

/**
 * AC1 — THE RELEASE LANDS ON THE QUIET WINDOW, NOT ON THE RUN'S END.
 *
 * One held piece is relayed at `t0`, the endpoint closes its turn at `t1`, and the merged message must
 * leave at `max(t0 + 800 ms, t1 + 2000 ms)` — the replay's own arithmetic — while the host STILL says a
 * turn is in flight. The run is deliberately never ended before the delivery: the whole point of the
 * change is that the words no longer wait for it, and the release's own journal line carries the
 * `busy` reading it was made under, so "before the run ended" is a reading rather than an absence.
 */
test('AC1: a busy hold leaves on the quiet window — max(piece+800ms, stop+2000ms) — before the run ends', async () => {
  // The SHIPPED constants, so the relay is driven by the numbers a deployment would use.
  const h = wire({
    quietWindowMs: VOICE_BUSY_QUIET_WINDOW_MS,
    quietSincePieceMs: VOICE_BUSY_QUIET_SINCE_PIECE_MS,
    quietCapMs: VOICE_BUSY_QUIET_CAP_MS,
  });
  await open(h.socket, h.transport);
  h.setBusy(true);

  // The endpoint's turn is open while the person speaks; the model relays a piece into the hold.
  upstreamSpeechStarted(h.transport);
  const t0 = Date.now();
  relay(h.transport, 'call-1', 'the held words');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 1);
  assert.deepEqual(h.sends, [] as SendReach[], 'a busy session holds the piece; nothing is delivered yet');

  // The person stops: the endpoint closes its turn, and the window starts counting from here.
  await sleep(40);
  const t1 = Date.now();
  upstreamSpeechStopped(h.transport);

  // Still nothing at t1 + 1200 ms: the window is 2000 ms from the stop, so a release here would be the
  // old behaviour reached by a shorter path rather than this feature.
  await sleep(1200);
  assert.deepEqual(
    h.sends,
    [] as SendReach[],
    'the window is 2000 ms from the turn close; a release inside it is not this release',
  );

  const expected = Math.max(t0 + REPLAY_QUIET_SINCE_PIECE_MS, t1 + REPLAY_QUIET_WINDOW_MS);
  const landed = await holdsBy(expected + DEADLINE_HEADROOM_MS, () => h.sends.length === 1);
  assert.ok(
    landed,
    `the release must land on the quiet window (by ${expected + DEADLINE_HEADROOM_MS} ms) rather than waiting for the run to end`,
  );
  const releasedAt = h.sends[0]!.at;
  assert.ok(
    releasedAt >= expected - DEADLINE_SLACK_MS,
    `released ${releasedAt - expected} ms BEFORE max(piece+800, stop+2000): expected >= ${expected}, got ${releasedAt}`,
  );
  assert.ok(
    releasedAt <= expected + DEADLINE_HEADROOM_MS,
    `released ${releasedAt - expected} ms after max(piece+800, stop+2000): expected <= ${expected}, got ${releasedAt}`,
  );

  // The held words went in whole, and the run had NOT ended when they did: the release line samples the
  // host's own `busy` reading at the flush, and it still says `true`.
  assert.equal(h.sends[0]!.message, 'the held words');
  const release = h.logs.find((line) => line.includes('busy quiet window released'));
  assert.ok(release, `the release is journaled, got ${JSON.stringify(h.logs)}`);
  assert.ok(
    release!.includes('busy=true'),
    `the words left before the run ended, got ${JSON.stringify(release)}`,
  );
  assert.ok(
    release!.includes('busy hold released') === false,
    'the quiet window has its own release line rather than the run-ending one',
  );

  // The run ending afterwards must not deliver the same words a second time.
  h.setBusy(false);
  await sleep(50);
  assert.equal(h.sends.length, 1, 'the release spends the buffer: the run ending has nothing left to send');
});

/**
 * AC2 — AN UPSTREAM THAT NEVER CLOSES ITS TURN IS BOUNDED BY THE CAP.
 *
 * The window is only as good as the upstream's turn reporting, and the 2026-10-15 00:08 reading
 * recorded an endpoint that stalls without ever closing its turn. The person talking over the entire
 * window is the same shape from this side: `speech_started` and no `speech_stopped`, so the window's
 * own term never becomes available and the hold would sit until the run ended. The cap — counted from
 * the hold's FIRST piece, not from its latest — is what releases it instead.
 *
 * The cap's own shipped value is pinned here rather than driven, because 20 s of wall clock is not a
 * criterion's to spend: the seam scales the SAME arithmetic, and the assertion below is what says the
 * number that ships is the replay's.
 */
test('AC2: with the endpoint still talking, the hold leaves at the cap counted from its first piece', async () => {
  const scaledCapMs = 400;
  const h = wire({ quietWindowMs: 60_000, quietSincePieceMs: REPLAY_QUIET_SINCE_PIECE_MS, quietCapMs: scaledCapMs });
  await open(h.socket, h.transport);
  h.setBusy(true);

  // The person is still talking: the endpoint's turn opened and never closed.
  upstreamSpeechStarted(h.transport);
  const t0 = Date.now();
  relay(h.transport, 'call-1', 'first piece');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 1);
  // A second piece, mid-window: it moves the floor but must NOT move the cap.
  await sleep(120);
  relay(h.transport, 'call-2', 'second piece');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 2);

  const landed = await holdsBy(t0 + scaledCapMs + DEADLINE_HEADROOM_MS, () => h.sends.length === 1);
  assert.ok(
    landed,
    `an endpoint that never closes its turn must still be released at the cap (by ${t0 + scaledCapMs} ms)`,
  );
  const releasedAt = h.sends[0]!.at;
  assert.ok(
    releasedAt >= t0 + scaledCapMs - DEADLINE_SLACK_MS,
    `released before the cap: expected >= ${t0 + scaledCapMs}, got ${releasedAt}`,
  );
  assert.ok(
    releasedAt <= t0 + scaledCapMs + DEADLINE_HEADROOM_MS,
    `the cap is counted from the FIRST piece and a later piece must not push it out: expected <= ${t0 + scaledCapMs}, got ${releasedAt}`,
  );
  assert.equal(h.sends[0]!.message, 'first piece second piece', 'the whole hold goes in as one message');

  // THE SHIPPED NUMBERS, which the scaled seams above deliberately hide. 20 s / 2 s / 800 ms are the
  // replay's own (`x3-replay.mts`: `buf[0] + 20_000`, `lastStop + 2000`, `lastPiece + 800`), and a
  // deployment that shipped different ones would satisfy every timing assertion above.
  assert.equal(VOICE_BUSY_QUIET_CAP_MS, REPLAY_QUIET_CAP_MS, 'the cap that ships is the replay\'s 20 s');
  assert.equal(VOICE_BUSY_QUIET_WINDOW_MS, REPLAY_QUIET_WINDOW_MS, 'the window that ships is the replay\'s 2 s');
  assert.equal(VOICE_BUSY_QUIET_SINCE_PIECE_MS, REPLAY_QUIET_SINCE_PIECE_MS, 'the floor that ships is the replay\'s 800 ms');
});

/**
 * AC3 — THE RELEASE IS WRITTEN UNDER `next`, AND ONLY THE RELEASE IS.
 *
 * The tier is the other half of the measurement: the replay's C, D and E arms shared one window and
 * differed only in priority, and `later` — the tier every OTHER busy write carries, and the right one
 * for a person typing during someone else's turn — is what made the running turn finish without ever
 * having heard the instruction. `now` is the arm that pre-empted the turn (2/16
 * `error_during_execution`, both zero-output turns) and is not used.
 *
 * Read off the argument bag the executor is reached with, which is the frame the relay hands the host
 * (`HostInputTurn`'s options carry it on to the resident driver's `state.queuedInputs[].priority`); the
 * run-ending release is read the same way in the second half, so "only this path" is a reading too.
 */
test('AC3: the quiet-window release carries priority=next, and the run-ending release carries none', async () => {
  const h = wire({ quietWindowMs: 150, quietSincePieceMs: 0, quietCapMs: 5000 });
  await open(h.socket, h.transport);
  h.setBusy(true);

  upstreamSpeechStarted(h.transport);
  relay(h.transport, 'call-1', 'spoken while busy');
  await waitFor(() => framesOf<PendingFrame>(h.socket, 'pending').length === 1);
  upstreamSpeechStopped(h.transport);
  await waitFor(() => h.sends.length === 1);

  // Asserted against the LITERAL, not against the constant: `VOICE_BUSY_RELEASE_PRIORITY` is what
  // writes this frame, so a claim that compared the two would still hold if the constant were moved
  // back to `later` — which is exactly the false form this criterion is graded on.
  assert.equal(
    h.sends[0]!.priority,
    'next',
    'the released frame is written under `next`: merged at the next tool boundary, neither waiting the turn out nor cutting it',
  );
  assert.equal(VOICE_BUSY_RELEASE_PRIORITY, 'next', 'and that tier is what the constant ships');
  const release = h.logs.find((line) => line.includes('busy quiet window released'));
  assert.ok(release!.includes('priority=next'), `the release names its tier, got ${JSON.stringify(release)}`);

  // THE CONTROL: a hold released by the RUN ENDING keeps the default. The tier is a statement about a
  // queue, and this release is the one the relay left alone — a frame written with no tier is what
  // every busy write carried before this feature, so nothing but the quiet window changes.
  //
  // The endpoint's turn is reopened first, deliberately: it puts this hold on the cap instead of on a
  // quiet window (nothing has gone quiet — the person is talking), so the release under test is the run
  // ending and not a second quiet one racing the assertion.
  upstreamSpeechStarted(h.transport);
  relay(h.transport, 'call-2', 'held until the turn ends');
  await waitFor(
    () => framesOf<PendingFrame>(h.socket, 'pending').at(-1)?.text === 'held until the turn ends',
  );
  assert.equal(h.sends.length, 1, 'the second piece is held while the run is in flight');
  h.setBusy(false);
  await waitFor(() => h.sends.length === 2);
  assert.equal(h.sends[1]!.priority, undefined, 'the run-ending release names no tier');
  const ended = h.logs.find((line) => line.includes('busy hold released'));
  assert.ok(ended, 'the run-ending release is still the `busy hold released` line');
  assert.ok(!ended!.includes('priority='), `the run-ending release names no tier, got ${JSON.stringify(ended)}`);
});
