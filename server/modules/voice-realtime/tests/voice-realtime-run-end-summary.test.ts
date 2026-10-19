/**
 * AC-404 — a run END asks the narrator for one short spoken summary (TEXT layer only).
 *
 * WHAT THIS FILE PINS. The relay is the "pen": it forwards words and reports execution, and it must
 * not moonlight as the summarizer. The summary comes from a SIDE text model (injected here), and
 * this file reads the relay's own contract around it:
 *
 *  - `running → idle` asks the narrator EXACTLY once, and injects exactly one text;
 *  - an initial `idle` connection never asks and never injects, however long the clock runs;
 *  - a run that never ends (the host keeps saying `busy: true`) never asks — the transition, not
 *    time passing, is the trigger;
 *  - the summarizer is asked `settleMs` AFTER the transition and reads the context pack standing
 *    THEN: a pack that catches up during the settle window is the one summarized (the timing point
 *    the proposal calls the mechanism's most fragile);
 *  - the injected text carries the B-1 readings: ≤ 40 chars, no Markdown, `verbatimTail ≈ 0`;
 *  - a narrator answer that breaks those readings is REFUSED rather than voiced.
 *
 * WHY A FAKE CLOCK. The settle wait and the host poll are the two timings under test. Mocked timers
 * make them exact — "at 99 ms nothing, at 100 ms the summary" — instead of a tolerance around real
 * sleeps, and the assertions become a sequence rather than a race.
 *
 * The transport is the shared fake `RealtimeTransport`; the browser socket is an EventEmitter. No
 * network, no microphone, no real clock.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  RUN_END_SUMMARY_MAX_CHARS,
  RUN_END_SUMMARY_MAX_VERBATIM_TAIL,
  handleVoiceRealtimeConnection,
  readVoiceRealtimeSummaryQuality,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, type FakeTransport } from './realtime-bridge-harness.js';

/** A fixed epoch: every deadline below is absolute and reproducible. */
const B = 1_760_000_000_000;

/** The context pack standing when the run STARTS — deliberately missing the run's last output. */
const CONTEXT_BEFORE_RUN =
  '用户：把登录页改一下。\n助手：我先看一下当前实现，再决定改哪里。';

/** The same pack once the run's output has landed (sent DURING the settle wait). */
const CONTEXT_AFTER_RUN =
  '用户：把登录页改一下。\n助手：已修改 Login.tsx 和 auth.ts，单元测试 12/12 通过，接下来还需要人工确认视觉细节。';

/** A compliant spoken summary: short, plain, and not the output's own tail. */
const SUMMARY = '已完成登录页改版，测试全部通过。';

/** A minimal stand-in for the browser's `ws.WebSocket` (the surface the proxy uses). */
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

  /** Delivers one inbound browser frame, as the real socket's `'message'` event would. */
  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** What the narrator's text queue was handed. */
type InjectedSummary = { text: string; runId: string | null };

/**
 * Wires one proxy connection over the fake browser socket and the fake upstream transport.
 *
 * The host's `busy` reading is a mutable closure. A scenario starts the run with the session IDLE
 * (the delivery then reaches the executor and starts the run), flips `busy` to `true` while the run
 * is in flight, and flips it back with {@link Harness.endRun} — the only way the relay can learn a
 * run ended.
 */
function wire(options: {
  injected: InjectedSummary[];
  asked: Array<{ context: string; runId: string | null }>;
  summarize?: (input: { context: string; runId: string | null }) => Promise<string | null>;
  settleMs?: number;
  pollMs?: number;
  logs?: string[];
}): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  // A delivery into an IDLE session starts a run. Starting `busy: true` would route the delivery
  // into the busy hold instead (and the run would never start), which is a different feature.
  let busy = false;
  const executor: RealtimeToolExecutor = {
    session_send: async () => ({ runId: 'run-1', queued: false }),
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    // The relay machinery this file is NOT testing is kept quiet, so its timers cannot fire inside
    // a `tick` the criterion owns.
    segmentedRelay: false,
    coalesceMs: 0,
    stallMs: 0,
    statusRateMs: 60_000,
    browserKeepaliveMs: 0,
    hostRunActivity: () => ({ inFlightTool: null, busy }),
    ...(options.logs === undefined ? {} : { log: (line: string) => options.logs!.push(line) }),
    runEndSummary: {
      summarize: async (input) => {
        options.asked.push(input);
        return options.summarize === undefined ? SUMMARY : options.summarize(input);
      },
      inject: (text, meta) => options.injected.push({ text, runId: meta.runId }),
      settleMs: options.settleMs ?? 100,
      pollMs: options.pollMs ?? 50,
    },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'run-end-summary-session',
    seams,
  );
  return {
    socket,
    transport,
    setBusy: (next: boolean) => {
      busy = next;
    },
  };
}

type Harness = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  /** Flips the host's own `busy` reading — the only event that says "the run ended". */
  setBusy(next: boolean): void;
};

/** Delivers one model `session_send` call, which starts a run through the executor's result. */
function deliverSessionSend(transport: FakeTransport, callId: string): void {
  const call: RealtimeServerMessage = {
    type: 'function_call',
    name: 'session_send',
    callId,
    arguments: JSON.stringify({ message: '把登录页改一下。' }),
  };
  transport.peerSend(call);
}

/** Lets every microtask and every already-resolved promise run (no timer involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Sends the browser's context pack, exactly as the page's `context` frame does. */
function sendContext(socket: FakeBrowserSocket, text: string): void {
  socket.receive({ type: 'context', text, chars: text.length, rows: 2 });
}

test('running → idle injects ONE summary, asked after the settle wait with the settled context', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  const { socket, transport, setBusy } = wire({ injected, asked, settleMs: 100, pollMs: 50 });
  await flush();
  assert.ok(transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');

  sendContext(socket, CONTEXT_BEFORE_RUN);
  deliverSessionSend(transport, 'call-1');
  await flush();
  // The delivery started the run: the host now says a turn is in flight.
  setBusy(true);

  // A live run: the watcher samples the host and finds it busy, so the narrator is not asked.
  t.mock.timers.tick(50);
  await flush();
  assert.equal(asked.length, 0, 'the narrator is not asked while the run is live');
  assert.equal(injected.length, 0, 'nothing is injected while the run is live');

  // The run ends. The context pack catches up DURING the settle wait — the exact timing the
  // mechanism exists for: the pack at the transition is already stale.
  setBusy(false);
  t.mock.timers.tick(50); // the next host poll sees `busy: false` and folds the transition
  await flush();
  sendContext(socket, CONTEXT_AFTER_RUN);

  // The transition alone asks nothing: the narrator waits out its settle window.
  assert.equal(asked.length, 0, 'the summary must wait for the output to land');
  assert.equal(injected.length, 0);

  t.mock.timers.tick(99);
  await flush();
  assert.equal(asked.length, 0, 'still inside the settle window: nothing is asked');

  t.mock.timers.tick(1);
  await flush();

  assert.equal(asked.length, 1, 'the transition asks the side model exactly once');
  assert.equal(asked[0]?.context, CONTEXT_AFTER_RUN, 'the summarizer reads the pack standing at settle time');
  assert.equal(asked[0]?.runId, 'run-1', 'the ask names the run that just ended');
  assert.equal(injected.length, 1, 'exactly one summary is injected');
  assert.equal(injected[0]?.text, SUMMARY);
  assert.equal(injected[0]?.runId, 'run-1');

  // The B-1 readings, re-read from the injected text with the SAME function the gate used.
  const quality = readVoiceRealtimeSummaryQuality(injected[0]?.text ?? '', CONTEXT_AFTER_RUN);
  assert.ok(quality.chars <= RUN_END_SUMMARY_MAX_CHARS, `chars=${quality.chars}`);
  assert.deepEqual(quality.markdown, [], 'a spoken summary carries no Markdown');
  assert.ok(
    quality.verbatimTail <= RUN_END_SUMMARY_MAX_VERBATIM_TAIL,
    `verbatimTail=${quality.verbatimTail} — the output must not be read back`,
  );

  // Nothing else arrives however long the connection then lives.
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(injected.length, 1, 'one transition injects one summary, not a repeating announcement');
  socket.close();
});

test('an initial idle connection never asks the narrator, however long the clock runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  const { socket, transport } = wire({ injected, asked, settleMs: 100, pollMs: 50 });
  await flush();
  assert.ok(transport.openCalls >= 1);

  sendContext(socket, CONTEXT_AFTER_RUN);
  t.mock.timers.tick(30_000);
  await flush();

  assert.equal(asked.length, 0, 'there was no running → idle transition to trigger a summary');
  assert.equal(injected.length, 0);
  socket.close();
});

test('a run that never ends (the host keeps saying busy) injects nothing — the transition is the trigger', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  const { socket, transport, setBusy } = wire({ injected, asked, settleMs: 100, pollMs: 50 });
  await flush();
  assert.ok(transport.openCalls >= 1);

  sendContext(socket, CONTEXT_AFTER_RUN);
  deliverSessionSend(transport, 'call-1');
  await flush();
  setBusy(true);

  // Time passes and the poll runs over and over; `busy` never becomes false.
  t.mock.timers.tick(5_000);
  await flush();

  assert.equal(asked.length, 0, 'a run that is still live has nothing to summarize');
  assert.equal(injected.length, 0);
  socket.close();
});

test('a narrator answer that breaks the readings is refused, not voiced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  // 41 chars, Markdown glyphs and the output's own tail: every reading at once.
  const { socket, transport, setBusy } = wire({
    injected,
    asked,
    settleMs: 100,
    pollMs: 50,
    summarize: async () => `## 结果\n${'很长的总结'.repeat(7)}人工确认视觉细节。`,
  });
  await flush();
  assert.ok(transport.openCalls >= 1);

  sendContext(socket, CONTEXT_AFTER_RUN);
  deliverSessionSend(transport, 'call-1');
  await flush();
  setBusy(true);
  t.mock.timers.tick(50); // a live-run sample
  await flush();
  setBusy(false);
  t.mock.timers.tick(50); // the run-end sample folds the transition
  await flush();
  t.mock.timers.tick(100); // the settle wait elapses and the narrator answers
  await flush();

  assert.equal(asked.length, 1, 'the narrator was asked once');
  assert.equal(injected.length, 0, 'a summary that is long, marked-up or read back is not injected');
  socket.close();
});
