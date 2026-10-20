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
 *  - the injected text carries the remaining readings: no Markdown, `verbatimTail ≤ 6`. LENGTH is
 *    no longer a refusal (2026-10-20): `qwen-flash` answers 42–44 chars, and a 45-char plain
 *    summary must be injected;
 *  - a narrator answer that breaks the Markdown or verbatim reading is REFUSED rather than voiced,
 *    each violation attributable in its own leg;
 *  - the run-end ACK (`VOICE_REALTIME_RUN_END_ACK`) is spoken at the transition, BEFORE the settle
 *    timer and independently of the summary — empty pack, `null` answer or refused summary all
 *    leave it in the queue, with its own `run-end-ack-N` id. Unset means no ack.
 *  - a user utterance stops and drops BOTH the ack and the summary through the existing duplex rule.
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
  RUN_END_SUMMARY_MAX_VERBATIM_TAIL,
  handleVoiceRealtimeConnection,
  readVoiceRealtimeSummaryQuality,
  VOICE_REALTIME_INSTRUCTIONS,
  type VoiceRealtimeNarratorTtsSeam,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import {
  VOICE_REALTIME_RUN_END_ACK_ENV,
  buildVoiceRealtimeNarratorWiring,
  pickVoiceRealtimeRunEndAck,
  resolveVoiceRealtimeRunEndAckCandidates,
} from '../voice-realtime-narrator.js';

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

/** 45 chars, plain, and not the output's tail — what `qwen-flash` really answers (and the old gate refused). */
const LONG_SUMMARY =
  '已修改登录页和鉴权逻辑，十二个单元测试全部通过，接口联调也没有问题，最后只差人工确认样式。';

/** Markdown glyphs only: short and not the tail, so its refusal can only be the Markdown gate. */
const MARKDOWN_SUMMARY = '已改好**登录页**。';

/** Short and plain, but it ends with the source's own tail — only the verbatim gate can refuse it. */
const VERBATIM_SUMMARY = '结论：接下来还需要人工确认视觉细节。';

/** The ack fixture: three distinct sentences, so first/last picks are observable. */
const ACK_CANDIDATES = ['处理完了。', '完成了。', '这次做完了。'];

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

/** The timer surface the narrated helpers drive; `t.mock.timers` satisfies it. */
type Timers = { tick(ms: number): void };

type NarratedHarness = Harness & {
  /** `narrator_speak` frames the page received, in emission order. */
  spoken(): Array<{ utteranceId: string; text: string }>;
  /** Utterance ids the TTS leaf was asked to synthesize, in order. */
  ttsCalls(): string[];
  /** Every text the summarizer was asked to summarize. */
  asked: Array<{ context: string; runId: string | null }>;
  /** Every journal line the proxy wrote. */
  logs: string[];
};

/**
 * One connection wired through the REAL narrator wiring and queue.
 *
 * The other harness injects `runEndSummary` directly, which is right for the proxy's own timing.
 * THIS one is for the producers the composition root owns: candidate selection, the `run-end-ack-N`
 * id family, the queue's pacing/duplex rule, and the TTS seam the queue speaks through. A fake TTS
 * leaf records what would have been synthesized, so "entered TTS" is a reading rather than an
 * assumption about wiring.
 */
function wireNarrated(options: {
  ack?: readonly string[];
  random?: () => number;
  summarize?: (input: { context: string; runId: string | null }) => Promise<string | null>;
  settleMs?: number;
  pollMs?: number;
}): NarratedHarness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  let busy = false;
  const asked: Array<{ context: string; runId: string | null }> = [];
  const logs: string[] = [];
  const ttsCalls: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async () => ({ runId: 'run-1', queued: false }),
  };
  const wiring = buildVoiceRealtimeNarratorWiring({
    closingTurn: 'silent',
    summarizeRunEnd: async (input) => {
      asked.push(input);
      return options.summarize === undefined ? SUMMARY : options.summarize(input);
    },
    runEndAck: options.ack ?? [],
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  assert.ok(wiring !== null, 'a narrator producer must keep the wiring alive');
  const summarySeam = wiring.runEndSummary;
  assert.ok(summarySeam !== undefined);
  const tts: VoiceRealtimeNarratorTtsSeam = {
    speak: async (input) => {
      ttsCalls.push(input.utteranceId);
      return { ok: true, frames: 0, bytes: 0, durationMs: 0, characters: input.text.length };
    },
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: false,
    coalesceMs: 0,
    stallMs: 0,
    statusRateMs: 60_000,
    browserKeepaliveMs: 0,
    hostRunActivity: () => ({ inFlightTool: null, busy }),
    log: (line: string) => logs.push(line),
    narrator: { ...wiring.narrator, tts },
    ...(wiring.runEndAck === undefined ? {} : { runEndAck: wiring.runEndAck }),
    runEndSummary: {
      ...summarySeam,
      settleMs: options.settleMs ?? 100,
      pollMs: options.pollMs ?? 50,
    },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'run-end-summary-narrated-session',
    seams,
  );
  return {
    socket,
    transport,
    setBusy: (next: boolean) => {
      busy = next;
    },
    spoken: () =>
      socket.outbound
        .filter(
          (frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_speak' }> =>
            frame.type === 'narrator_speak',
        )
        .map((frame) => ({ utteranceId: frame.utteranceId, text: frame.text })),
    ttsCalls: () => [...ttsCalls],
    asked,
    logs,
  };
}

/**
 * Drives one connection from idle to the `running → idle` transition.
 *
 * `context === null` sends no pack at all (AC4's "empty context" leg). The host poll is ticked once
 * while busy and once after the flip, exactly as the other harness does.
 */
async function driveToRunEnd(
  h: NarratedHarness,
  timers: Timers,
  context: string | null,
): Promise<void> {
  await flush();
  assert.ok(h.transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');
  if (context !== null) sendContext(h.socket, context);
  deliverSessionSend(h.transport, 'call-1');
  await flush();
  h.setBusy(true);
  timers.tick(50); // a live-run sample: the narrator is not asked yet
  await flush();
  h.setBusy(false);
  timers.tick(50); // the run-end sample folds the transition
  await flush();
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

  // The remaining readings, re-read from the injected text with the SAME function the gate used.
  const quality = readVoiceRealtimeSummaryQuality(injected[0]?.text ?? '', CONTEXT_AFTER_RUN);
  assert.equal(quality.chars, SUMMARY.length, 'length is a logged reading, not a gate');
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
  assert.equal(injected.length, 0, 'a summary carrying Markdown or reading the output back is not injected');
  socket.close();
});

// ── AC2: length is a reading, not a refusal ───────────────────────────────────────────────────────

test('a 45-character plain summary that does not read the output back is injected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  const logs: string[] = [];
  const { socket, transport, setBusy } = wire({
    injected,
    asked,
    logs,
    settleMs: 100,
    pollMs: 50,
    summarize: async () => LONG_SUMMARY,
  });
  await flush();
  assert.ok(transport.openCalls >= 1);

  sendContext(socket, CONTEXT_AFTER_RUN);
  deliverSessionSend(transport, 'call-1');
  await flush();
  setBusy(true);
  t.mock.timers.tick(50);
  await flush();
  setBusy(false);
  t.mock.timers.tick(50);
  await flush();
  t.mock.timers.tick(100);
  await flush();

  const quality = readVoiceRealtimeSummaryQuality(LONG_SUMMARY, CONTEXT_AFTER_RUN);
  assert.ok(quality.chars > 40, `chars=${quality.chars} — this is the length the old gate refused`);
  assert.deepEqual(quality.markdown, []);
  assert.ok(quality.verbatimTail <= RUN_END_SUMMARY_MAX_VERBATIM_TAIL, `verbatimTail=${quality.verbatimTail}`);
  assert.equal(injected.length, 1, 'length alone must not refuse a summary');
  assert.equal(injected[0]?.text, LONG_SUMMARY);
  assert.ok(
    logs.includes(
      `run-end summary injected chars=${quality.chars} verbatimTail=${quality.verbatimTail} run=run-1`,
    ),
    'the injection is logged with the length reading',
  );
  socket.close();
});

test('a Markdown violation alone is still refused, and the log says why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  const logs: string[] = [];
  const { socket, transport, setBusy } = wire({
    injected,
    asked,
    logs,
    settleMs: 100,
    pollMs: 50,
    summarize: async () => MARKDOWN_SUMMARY,
  });
  await flush();
  assert.ok(transport.openCalls >= 1);

  sendContext(socket, CONTEXT_AFTER_RUN);
  deliverSessionSend(transport, 'call-1');
  await flush();
  setBusy(true);
  t.mock.timers.tick(50);
  await flush();
  setBusy(false);
  t.mock.timers.tick(50);
  await flush();
  t.mock.timers.tick(100);
  await flush();

  const quality = readVoiceRealtimeSummaryQuality(MARKDOWN_SUMMARY, CONTEXT_AFTER_RUN);
  assert.ok(quality.chars <= 40, 'short: only the Markdown gate can explain this refusal');
  assert.ok(quality.markdown.length > 0);
  assert.ok(quality.verbatimTail <= RUN_END_SUMMARY_MAX_VERBATIM_TAIL, 'not the tail either');
  assert.equal(injected.length, 0, 'a marked-up summary is not voiced');
  assert.ok(
    logs.some((line) =>
      line.startsWith(
        `run-end summary refused: chars=${quality.chars} markdown=[${quality.markdown.join('')}]`,
      ),
    ),
    'the refusal names the Markdown glyphs',
  );
  socket.close();
});

test('a verbatim-tail violation alone is still refused, and the log says why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const injected: InjectedSummary[] = [];
  const asked: Array<{ context: string; runId: string | null }> = [];
  const logs: string[] = [];
  const { socket, transport, setBusy } = wire({
    injected,
    asked,
    logs,
    settleMs: 100,
    pollMs: 50,
    summarize: async () => VERBATIM_SUMMARY,
  });
  await flush();
  assert.ok(transport.openCalls >= 1);

  sendContext(socket, CONTEXT_AFTER_RUN);
  deliverSessionSend(transport, 'call-1');
  await flush();
  setBusy(true);
  t.mock.timers.tick(50);
  await flush();
  setBusy(false);
  t.mock.timers.tick(50);
  await flush();
  t.mock.timers.tick(100);
  await flush();

  const quality = readVoiceRealtimeSummaryQuality(VERBATIM_SUMMARY, CONTEXT_AFTER_RUN);
  assert.ok(quality.chars <= 40, 'short: only the verbatim gate can explain this refusal');
  assert.deepEqual(quality.markdown, [], 'plain: not the Markdown gate either');
  assert.ok(quality.verbatimTail > RUN_END_SUMMARY_MAX_VERBATIM_TAIL);
  assert.equal(injected.length, 0, 'reading the output back is not voiced');
  assert.ok(
    logs.some((line) => line.startsWith('run-end summary refused:') && line.includes('markdown=[]')),
    'the refusal says the Markdown reading was clean',
  );
  assert.ok(
    logs.some((line) => line.includes(`verbatimTail=${quality.verbatimTail}/${RUN_END_SUMMARY_MAX_VERBATIM_TAIL}`)),
    'and names the tail that explained it',
  );
  socket.close();
});

// ── AC3: the run-end ack's configuration and picker ───────────────────────────────────────────────

test('run-end ack candidates split on |, and the injected random names the first and the last', () => {
  assert.deepEqual(resolveVoiceRealtimeRunEndAckCandidates({}), []);
  assert.deepEqual(
    resolveVoiceRealtimeRunEndAckCandidates({ [VOICE_REALTIME_RUN_END_ACK_ENV]: '   ' }),
    [],
    'blank is the same as unset: no ack',
  );
  assert.deepEqual(
    resolveVoiceRealtimeRunEndAckCandidates({ [VOICE_REALTIME_RUN_END_ACK_ENV]: ' 甲 | 乙 || 丙 ' }),
    ['甲', '乙', '丙'],
    'surrounding whitespace is trimmed and empty segments are dropped',
  );

  assert.equal(pickVoiceRealtimeRunEndAck(ACK_CANDIDATES, () => 0), '处理完了。', 'random=0 is the first');
  assert.equal(
    pickVoiceRealtimeRunEndAck(ACK_CANDIDATES, () => 0.999_999),
    '这次做完了。',
    'a random near 1 is the last',
  );
  assert.equal(
    pickVoiceRealtimeRunEndAck(ACK_CANDIDATES, () => 1),
    '这次做完了。',
    'a hostile exact 1 is clamped, never an undefined utterance',
  );
  assert.equal(pickVoiceRealtimeRunEndAck([], Math.random), null, 'no candidates, nothing to say');
  for (let i = 0; i < 50; i += 1) {
    assert.ok(ACK_CANDIDATES.includes(pickVoiceRealtimeRunEndAck(ACK_CANDIDATES, Math.random)!));
  }
});

// ── AC3: the ack is spoken at the transition, before the settle timer ────────────────────────────

test('the ack speaks at the transition and the summary queues behind it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const h = wireNarrated({ ack: ACK_CANDIDATES, random: () => 0, settleMs: 100, pollMs: 50 });
  await driveToRunEnd(h, t.mock.timers, CONTEXT_AFTER_RUN);

  // The transition alone put the ack on the wire — no settle wait, no summarizer call yet.
  assert.equal(h.asked.length, 0, 'the summary still waits out its settle window');
  assert.deepEqual(h.spoken(), [{ utteranceId: 'run-end-ack-0', text: '处理完了。' }]);
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0'], 'the ack entered TTS immediately');
  assert.ok(h.logs.some((line) => line.startsWith('run-end ack ')), 'the journal names the ack');

  t.mock.timers.tick(99);
  await flush();
  assert.equal(h.asked.length, 0, 'inside the settle window nothing is asked');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.asked.length, 1, 'the settle window elapses and the summarizer is asked once');
  assert.equal(h.asked[0]?.context, CONTEXT_AFTER_RUN);
  assert.equal(h.spoken().length, 1, 'the summary is QUEUED behind the playing ack — pacing holds');
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0']);

  h.socket.receive({ type: 'narrator_done', utteranceId: 'run-end-ack-0' });
  await flush();
  assert.deepEqual(
    h.spoken().map((frame) => frame.utteranceId),
    ['run-end-ack-0', 'run-end-summary-0'],
    'the summary follows the ack, in that order',
  );
  assert.equal(h.spoken()[1]?.text, SUMMARY);
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0', 'run-end-summary-0']);
  h.socket.close();
});

test('with VOICE_REALTIME_RUN_END_ACK unset or empty the transition speaks no ack', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const h = wireNarrated({ ack: resolveVoiceRealtimeRunEndAckCandidates({}) });
  await driveToRunEnd(h, t.mock.timers, CONTEXT_AFTER_RUN);
  assert.deepEqual(h.spoken(), [], 'the pre-ack wire: the transition injects nothing');
  assert.deepEqual(h.ttsCalls(), []);
  assert.ok(!h.logs.some((line) => line.startsWith('run-end ack ')), 'nothing is logged either');

  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(
    h.spoken().map((frame) => frame.utteranceId),
    ['run-end-summary-0'],
    'the summary still speaks exactly as before',
  );
  h.socket.close();
});

// ── AC4: the ack is independent of the summary ───────────────────────────────────────────────────

test('an empty context pack still speaks the ack (the summary has nothing to ask about)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const h = wireNarrated({ ack: ACK_CANDIDATES, random: () => 0 });
  await driveToRunEnd(h, t.mock.timers, null);
  assert.deepEqual(h.spoken(), [{ utteranceId: 'run-end-ack-0', text: '处理完了。' }]);

  t.mock.timers.tick(100);
  await flush();
  assert.equal(h.asked.length, 0, 'no pack means no summarizer call');
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0'], 'the ack alone reached TTS');
  assert.ok(h.logs.includes('run-end summary skipped: no context pack to summarize'));
  h.socket.close();
});

test('a null summary answer still speaks the ack', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const h = wireNarrated({ ack: ACK_CANDIDATES, random: () => 0, summarize: async () => null });
  await driveToRunEnd(h, t.mock.timers, CONTEXT_AFTER_RUN);
  t.mock.timers.tick(100);
  await flush();

  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.spoken(), [{ utteranceId: 'run-end-ack-0', text: '处理完了。' }]);
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0']);
  assert.ok(h.logs.includes('run-end summary skipped: the narrator returned nothing'));
  h.socket.close();
});

test('a summary refused by the quality gate still speaks the ack', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const h = wireNarrated({ ack: ACK_CANDIDATES, random: () => 0, summarize: async () => MARKDOWN_SUMMARY });
  await driveToRunEnd(h, t.mock.timers, CONTEXT_AFTER_RUN);
  t.mock.timers.tick(100);
  await flush();

  assert.equal(h.asked.length, 1);
  assert.ok(h.logs.some((line) => line.startsWith('run-end summary refused:')));
  assert.deepEqual(h.spoken(), [{ utteranceId: 'run-end-ack-0', text: '处理完了。' }]);
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0'], 'the refused summary never reached TTS; the ack did');
  h.socket.close();
});

// ── AC5: the existing duplex rule stops and drops BOTH ───────────────────────────────────────────

test('a user utterance stops the ack and drops the queued summary through the existing rule', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const h = wireNarrated({ ack: ACK_CANDIDATES, random: () => 0, settleMs: 100, pollMs: 50 });
  await driveToRunEnd(h, t.mock.timers, CONTEXT_AFTER_RUN);
  t.mock.timers.tick(100); // the summary is now queued behind the playing ack
  await flush();
  assert.deepEqual(h.spoken().map((frame) => frame.utteranceId), ['run-end-ack-0']);
  assert.equal(h.asked.length, 1);

  // THE PERSON OPENS THEIR MOUTH. No new path: the endpoint's precise boundary reaches the queue.
  h.transport.peerSend({ type: 'input_audio_buffer.speech_started' } as RealtimeServerMessage);
  await flush();

  const stops = h.socket.outbound.filter(
    (frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_stop' }> =>
      frame.type === 'narrator_stop',
  );
  assert.deepEqual(stops, [{ type: 'narrator_stop', utteranceId: 'run-end-ack-0', reason: 'user-spoke' }]);
  assert.ok(
    h.logs.includes('narrator cleared reason=user-spoke dropped=2'),
    'the playing ack and the queued summary are both dropped',
  );

  // A late `narrator_done` from the page must not resurrect the queued summary.
  h.socket.receive({ type: 'narrator_done', utteranceId: 'run-end-ack-0' });
  await flush();
  assert.deepEqual(h.spoken().map((frame) => frame.utteranceId), ['run-end-ack-0']);
  assert.deepEqual(h.ttsCalls(), ['run-end-ack-0'], 'the dropped summary was never synthesized');
  assert.deepEqual(
    h.socket.outbound.filter((frame) => frame.type === 'error'),
    [],
    'an interruption is conversation, not an error',
  );
  h.socket.close();
});
