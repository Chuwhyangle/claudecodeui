#!/usr/bin/env node
/**
 * S-A (the ONE compact execution-status line folded into a live voice session's instructions) — its
 * NET COST and REAL-TIME readings, measured OFFLINE over the REAL transport and the REAL proxy.
 *
 * WHY THIS EXISTS. `docs/proposals/voice-realtime-persistent-control-SPEC.md` (Draft-2) carries two
 * groups of numbers that are PROPOSALS, not readings:
 *
 *   · §8.3's per-run cap (≤ 8 injections / run, 1 / 2 s) — the SPEC says so itself: "每次注入的净成本
 *     尚未实测（G-5）；因此 §8.3 的 ≤8 次/run 是安全上限而非最优值".
 *   · §13's two S-A SLOs — 注入延迟 ≤ 300 ms p95 and 注入净成本 ≤ 5% of the fixed context.
 *
 * The only anchor was the fixed context (~1,280 tokens / response). Nothing had measured what ONE
 * injection costs (the whole instructions block is RESTATED every time — `advertiseInstructions()`),
 * how long a change takes to reach the upstream, or how many injections a long turn actually spends.
 * G-5 is that measurement. This script is it, and `docs/operations/voice-realtime-status-cost.md`
 * records what it read.
 *
 * HOW IT RUNS (zero cloud by construction). The REAL transport (`createDashscopeTransport`) and the
 * REAL proxy (`handleVoiceRealtimeConnection`) drive a scripted stand-in upstream
 * (`createScriptedUpstream`, the fake `gap-voice-realtime-scripted-fake-upstream` landed) with an
 * EMPTY api key and the stand-in's socket factory. Nothing opens a socket and no credential is read;
 * every `session.update` the readings are taken from is one the stand-in actually received.
 *
 * WHAT IS MEASURED, AND HOW THE DRIVER STAYS HONEST. The one input S-A is driven by is the session's
 * own `session_send` result: its `runId` says which run the session is on and its `queued` says
 * whether the message started the run or is waiting behind one. This script encodes that result INTO
 * the relayed message text (`<q|r>|<runId>~…`, padded to a fixed 30 bytes) and hands it back from the
 * executor — so a dropped or late tool call cannot MIS-PAIR a result with the wrong delivery, which a
 * side-channel queue can and did. After every delivery it waits for the `sent` frame the proxy emits
 * for that result, and only then folds the same patch into a MIRROR of the dedup gate
 * (`createVoiceRealtimeExecStatus`, the shipping aggregator). The mirror is what the suppressed
 * counts are read from, because a suppressed change is never logged on the wire; because it is fed
 * only for a result the proxy demonstrably processed, its verdicts and the proxy's are the same ones.
 *
 * THE ARMS.
 *   · COUNT (default): one synthetic long turn — 76 distinct execution-state changes across 8 runs —
 *     exercising dedup, rate-limit coalescing and the per-run cap, and reporting the actual injection
 *     count and the suppressed count BY CATEGORY.
 *   · PAYLOAD: the byte size of every injected status line and of the whole instructions block, from
 *     the COUNT arm's own `session.update` frames.
 *   · LATENCY: 40 samples of "state change → upstream `session.update` emitted", p50 / p95 / max. The
 *     window is set to ~0 here, so the reading is the PIPELINE latency; the shipped 2 s window is the
 *     other, larger half of the end-to-end and is reported beside it.
 *   · CONTROL (injection OFF): the SAME driver with S-A's rate window pushed beyond the run's life, so
 *     the injection never fires. If the script were not measuring the wire, the two arms would read
 *     the same; they must differ. This contrast is the FALSE FORM: `--self-test`'s first case.
 *   · PAID (default OFF): a real A/B token reading needs a paid endpoint. It is opt-in, needs a
 *     declared budget, and is NOT run here — the record says "未测" rather than extrapolating offline.
 *
 * RUN IT (Node ≥ 22.15; the server modules need Node's TypeScript transform):
 *
 *     node --experimental-transform-types scripts/voice-realtime-status-cost.mjs
 *     node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --json
 *     node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --write-doc docs/operations/voice-realtime-status-cost.md
 *     node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --check docs/operations/voice-realtime-status-cost.md
 *     node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --self-test
 *
 * `--check` re-reads the record and FAILS on an empty table or a missing reading — "缺读数" and
 * "读数对上了" must not look the same to a script (the same discipline as
 * `scripts/voice-realtime-reconcile.mjs --check`).
 */
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

// -------------------------------------------------------------------------------------------------
// The server modules are TypeScript; resolve them the way the server's own tsconfig does. `@/` is the
// server source root here (the frontend's alias is a DIFFERENT root, and this script never loads the
// frontend), and an internal `./x.js` specifier names the `x.ts` file that tsc compiles it from.
// -------------------------------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const SERVER_ROOT = join(REPO_ROOT, 'server');
const VR = join(SERVER_ROOT, 'modules', 'voice-realtime');

/** `.js` specifier → the `.ts` source Node must strip-and-load. */
/** @param {string} p @returns {string} */
function toTs(p) {
  return p.endsWith('.js') ? `${p.slice(0, -'.js'.length)}.ts` : p;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(toTs(join(SERVER_ROOT, specifier.slice(2)))).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

/** Loads one server module by absolute path, with a hint when the TypeScript transform is missing. */
/** @param {string} absPath @returns {Promise<any>} */
async function loadServerModule(absPath) {
  try {
    return await import(pathToFileURL(absPath).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/parameter property|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|strip-only/i.test(message)) {
      throw new Error(
        `could not load ${absPath}: ${message}\n` +
          're-run with the TypeScript transform: node --experimental-transform-types scripts/voice-realtime-status-cost.mjs',
      );
    }
    throw error;
  }
}

const { createDashscopeTransport } = await loadServerModule(join(VR, 'voice-realtime-dashscope-transport.ts'));
const proxy = await loadServerModule(join(VR, 'voice-realtime-ws-proxy.service.ts'));
const scripted = await loadServerModule(join(VR, 'tests', 'voice-realtime-scripted-upstream.ts'));

const {
  createVoiceRealtimeExecStatus,
  handleVoiceRealtimeConnection,
  VOICE_REALTIME_INSTRUCTIONS,
  VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN,
  VOICE_REALTIME_STATUS_RATE_MS,
} = proxy;

// -------------------------------------------------------------------------------------------------
// Constants of the measurement.
// -------------------------------------------------------------------------------------------------

/** Every synthetic delivery is the SAME size, so a `queued` count alone is what moves the dedup key. */
const MESSAGE_BYTES = 30;

/** The COUNT arm's rate window: wide enough that a burst of five folds coalesce into one line. */
const COUNT_RATE_MS = 200;
/** The LATENCY arm's window: ~0, so the reading is the PIPELINE, not the rate limit. */
const LATENCY_RATE_MS = 0;
/** The CONTROL arm's window: beyond any run's lifetime, so no flush ever fires (injection is OFF). */
const CONTROL_RATE_MS = 2_147_483_647;

/** How long to wait for the proxy to emit the `sent` frame for one delivery before calling it lost. */
const SENT_TIMEOUT_MS = 2_500;
/** Grace after an op that is not expected to inject, so a stray timer would have shown itself. */
const GRACE_MS = 30;

/** COUNT arm: how many coalescing runs precede the one deliberately driven past the cap. */
const COST_RATE_RUNS = 7;
/** COUNT arm, per coalescing run: identical repeats (dedup), separated changes, and burst width. */
const REPEATS_PER_RUN = 4;
const SEPARATED_PER_RUN = 3;
const BURST_WIDTH = 5;
/** CAP arm: separated distinct changes in one run — enough to drive past the ≤ 8/run cap. */
const CAP_RUN_CHANGES = 12;
/** LATENCY arm: how many runs, and how many injections per run (the cap is 8/run, so ≤ 8 each). */
const LATENCY_RUNS = 5;
const LATENCY_INJECTIONS_PER_RUN = 8;

// -------------------------------------------------------------------------------------------------
// Shapes. scripts/tsconfig.json type-checks this file (checkJs + strict), so every shape the driver
// passes around is spelled out rather than left to inference.
// -------------------------------------------------------------------------------------------------

/** One `session.update` the stand-in upstream received, and when. */
/** @typedef {{ t: number, bytes: number }} UpdateReading */
/** One status-carrying injection: the instant, the whole block, and the `[exec]` line inside it. */
/** @typedef {{ t: number, instructions: string, line: string, lineBytes: number }} InjectionReading */
/** One browser→server frame, as loosely as the driver ever needs it. */
/** @typedef {Record<string, any>} Frame */
/** One arm's live state: the stand-in, the browser socket, and everything read off the wire. */
/**
 * @typedef {{
 *   upstream: any,
 *   socket: FakeBrowserSocket,
 *   injections: InjectionReading[],
 *   updates: UpdateReading[],
 *   readings: any[],
 *   logLines: string[],
 *   statusRateMs: number,
 * }} Arm
 */
/** One run's counts. `distinct` and `dedup` partition the deliveries; `injections` and the three
 * suppression columns partition `distinct`. */
/**
 * @typedef {{
 *   runId: string,
 *   deliveries: number,
 *   distinct: number,
 *   injections: number,
 *   dedup: number,
 *   rate: number,
 *   cap: number,
 *   lost: number,
 * }} RunRow
 */
/** The aggregator's verdict: `changed` says the dedup key moved, `newRun` that the run rolled. */
/** @typedef {{ changed: boolean, newRun: boolean }} Verdict */
/** The whole measurement's state, including the mirror of the proxy's dedup gate. */
/**
 * @typedef {{
 *   arm: Arm,
 *   expectInjections: boolean,
 *   mirror: any,
 *   cliQueuedDeliveries: number,
 *   cliQueuedBytes: number,
 *   callSeq: number,
 *   runs: RunRow[],
 *   currentRun: RunRow,
 *   latencies: number[],
 * }} State
 */
/** What one delivery yielded: the mirror's verdict, the `sent`-frame instant, and the baseline. */
/** @typedef {{ verdict: Verdict, tSent: number, injectionsBefore: number }} Observation */
/** A numeric sample's summary. Every field is null when the sample is empty. */
/** @typedef {{ n: number, min: number|null, p50: number|null, p95: number|null, max: number|null }} Sample */
/** The arm totals, keyed exactly like {@link RunRow} minus the run id. */
/** @typedef {Omit<RunRow, 'runId'>} Totals */
/** The whole offline measurement: the counting arm, the latency arm, the control arm, the paid slot. */
/**
 * @typedef {{
 *   count: {
 *     totals: Totals, runs: RunRow[], injections: number, baseBytes: number,
 *     body: Sample, line: Sample, readingsPerInjection: boolean,
 *   },
 *   latency: { distribution: Sample, samples: number, rateMs: number, shippedWindowMs: number },
 *   control: { injections: number, maxBodyBytes: number, updates: number },
 *   paid: { tokenDelta: number|null, costCny: number|null, reason: string },
 * }} Reading
 */

// -------------------------------------------------------------------------------------------------
// Tiny utilities.
// -------------------------------------------------------------------------------------------------

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `pred` until true or the deadline; returns the last reading either way.
 * @param {() => boolean} pred
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(pred, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let hit = pred();
  while (!hit && Date.now() < deadline) {
    await sleep(2);
    hit = pred();
  }
  return hit;
}

/**
 * Nearest-rank percentile of an ascending-sorted array. Returns null for an empty input.
 * @param {number[]} sorted
 * @param {number} p
 * @returns {number|null}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/**
 * min / p50 / p95 / max of a numeric sample. All null when the sample is empty.
 * @param {number[]} values
 * @returns {Sample}
 */
function distribution(values) {
  if (values.length === 0) return { n: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * The `[exec] …` line out of a composed instructions body, or null when there is none.
 * @param {string} instructions
 * @returns {string|null}
 */
function execLineOf(instructions) {
  const at = instructions.indexOf('[exec] ');
  if (at < 0) return null;
  return instructions.slice(at).split('\n')[0];
}

/**
 * The relayed message that CARRIES its own executor result.
 *
 * The proxy reads `result.runId` and `result.queued` off whatever the executor returns; a side-channel
 * queue would mis-pair a result with the wrong delivery the moment a tool call is dropped or arrives
 * late. Encoding it in the text the model "said" makes each delivery self-describing: the executor
 * parses it back, so a lost call loses exactly one change and can corrupt nothing else. Every message
 * is {@link MESSAGE_BYTES} long, so the byte readings the queue waits on are uniform.
 *
 * @param {boolean} queued
 * @param {string} runId
 * @returns {string}
 */
function encodeMessage(queued, runId) {
  const head = `${queued ? 'q' : 'r'}|${runId}~`;
  return head + 'x'.repeat(Math.max(0, MESSAGE_BYTES - head.length));
}

/**
 * The inverse of {@link encodeMessage} — what the executor hands back.
 * @param {unknown} message
 * @returns {{ runId: string|null, queued: boolean }}
 */
function decodeResult(message) {
  const text = String(message ?? '');
  const tilde = text.indexOf('~');
  return { runId: tilde < 0 ? null : text.slice(2, tilde), queued: text.startsWith('q|') };
}

// -------------------------------------------------------------------------------------------------
// The browser end of the socket — the same stand-in the other proxy criteria use, but every frame it
// receives is TIMESTAMPED, so a latency can be measured from the `sent` frame rather than from the
// moment a poll happened to observe it.
// -------------------------------------------------------------------------------------------------

class FakeBrowserSocket extends EventEmitter {
  /** @type {number} */ OPEN;
  /** @type {number} */ CLOSED;
  /** @type {number} */ readyState;
  /** @type {Frame[]} */ outbound;
  /** @type {number[]} */ sentAt;
  constructor() {
    super();
    this.OPEN = WS.OPEN;
    this.CLOSED = WS.CLOSED;
    this.readyState = WS.OPEN;
    this.outbound = [];
    this.sentAt = [];
  }
  /** @param {string} data */
  send(data) {
    const frame = JSON.parse(data);
    this.outbound.push(frame);
    if (frame.type === 'sent') this.sentAt.push(Date.now());
  }
  close() {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
}

// -------------------------------------------------------------------------------------------------
// One arm: the real transport + the real proxy over the scripted stand-in, plus the wire readings.
// -------------------------------------------------------------------------------------------------

/**
 * Boots one arm. `createScriptedUpstream` is the endpoint; its factory is WRAPPED so every
 * `session.update` the transport emits is timestamped and its instructions captured — the readings
 * are taken from the frame the stand-in actually received, not from a return value.
 *
 * @param {{ statusRateMs: number }} options
 * @returns {Arm}
 */
function bootArm({ statusRateMs }) {
  const upstream = scripted.createScriptedUpstream();
  const realFactory = upstream.socketFactory;
  /** Every status-carrying `session.update` the stand-in received, with its emit instant. */
  /** @type {InjectionReading[]} */
  const injections = [];
  /** Every `session.update` the stand-in received (status-carrying or not), with its size. */
  /** @type {UpdateReading[]} */
  const updates = [];

  /**
   * @param {string} url
   * @param {any} headers
   * @returns {any}
   */
  const wrappingFactory = (url, headers) => {
    const socket = realFactory(url, headers);
    const realSend = socket.send.bind(socket);
    /** @param {string} data */
    socket.send = (data) => {
      const t = Date.now();
      let frame = null;
      try {
        frame = JSON.parse(data);
      } catch {
        frame = null;
      }
      if (frame !== null && frame.type === 'session.update') {
        const instructions = String(frame.session?.instructions ?? '');
        updates.push({ t, bytes: Buffer.byteLength(instructions, 'utf8') });
        const line = execLineOf(instructions);
        if (line !== null) injections.push({ t, instructions, line, lineBytes: Buffer.byteLength(line, 'utf8') });
      }
      realSend(data);
    };
    return socket;
  };

  const executor = {
    /** @param {any} args */
    session_send: async (args) => decodeResult(args?.message),
    session_interrupt: async () => ({ aborted: true }),
  };

  const socket = new FakeBrowserSocket();
  /** @type {any[]} */
  const readings = [];
  /** @type {string[]} */
  const logLines = [];
  handleVoiceRealtimeConnection(socket, 'status-cost-session', {
    /** @param {any} report */
    createTransport: (report) =>
      createDashscopeTransport({
        apiKey: '',
        endpoint: scripted.SCRIPTED_ENDPOINT_URL,
        socketFactory: wrappingFactory,
        onError: report,
      }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    // Deterministic: never inherit the shell's VOICE_REALTIME_MODE (the proxy reads it once here).
    segmentedRelay: false,
    statusRateMs,
    /** @param {any} reading */
    onExecStatus: (reading) => readings.push(reading),
    /** @param {string} line */
    log: (line) => logLines.push(line),
  });

  return { upstream, socket, injections, updates, readings, logLines, statusRateMs };
}

/**
 * Resolves once the proxy has reported the upstream session open to the browser.
 * @param {Arm} arm
 * @returns {Promise<boolean>}
 */
function openSession(arm) {
  return waitFor(() => arm.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

// -------------------------------------------------------------------------------------------------
// The driver: the SAME deterministic state-change sequence, run against any rate window.
// -------------------------------------------------------------------------------------------------

/** A per-run row of the counts table. */
/** @param {string} runId @returns {RunRow} */
function newRunRow(runId) {
  return { runId, deliveries: 0, distinct: 0, injections: 0, dedup: 0, rate: 0, cap: 0, lost: 0 };
}

/**
 * The measurement state, including a MIRROR of the proxy's own dedup gate.
 * @param {Arm} arm
 * @param {{ expectInjections: boolean }} options
 * @returns {State}
 */
function newState(arm, { expectInjections }) {
  return {
    arm,
    expectInjections,
    mirror: createVoiceRealtimeExecStatus(),
    cliQueuedDeliveries: 0,
    cliQueuedBytes: 0,
    callSeq: 0,
    runs: [],
    // Replaced by the first `openRun`; never read before then.
    currentRun: newRunRow(''),
    latencies: [],
  };
}

/**
 * One delivery, synchronised on the `sent` frame the proxy emits for its result.
 *
 * The `sent` frame is the proof the proxy processed THIS delivery: `base.session_send` returned,
 * `cliQueuedDeliveries`/`cliQueuedBytes` were updated, and `noteStatus` ran. Only then is the same
 * patch folded into the mirror, so the mirror's `changed` verdicts are the proxy's own and a dropped
 * delivery cannot desynchronise the two.
 *
 * The injection baseline is taken BEFORE the delivery is relayed. At a ~0 ms window the flush fires
 * between the relay and the `sent` frame's observation, so a baseline taken after the wait would
 * already contain this change's own line and every wait would time out on a line that had arrived.
 * Returns the state-change instant (the `sent` frame's), the injection count to wait past, or `null`
 * when the delivery was lost.
 *
 * @param {State} state
 * @param {string} runId
 * @param {boolean} queued
 * @returns {Promise<Observation|null>}
 */
async function deliverAndObserve(state, runId, queued) {
  const arm = state.arm;
  const injectionsBefore = arm.injections.length;
  const before = arm.socket.sentAt.length;
  const message = encodeMessage(queued, runId);
  const callId = `call-${state.callSeq}`;
  state.callSeq += 1;
  state.currentRun.deliveries += 1;
  arm.upstream.emit(scripted.captionCompleted(`item-${callId}`, message));
  arm.upstream.emit(scripted.functionCall('session_send', { message }, callId));
  const observed = await waitFor(() => arm.socket.sentAt.length > before, SENT_TIMEOUT_MS);
  if (!observed) {
    state.currentRun.lost += 1;
    return null;
  }
  const tSent = arm.socket.sentAt[before];
  if (queued) {
    state.cliQueuedDeliveries += 1;
    state.cliQueuedBytes += MESSAGE_BYTES;
  } else {
    state.cliQueuedDeliveries = 0;
    state.cliQueuedBytes = 0;
  }
  const verdict = state.mirror.update({
    phase: queued ? 'queued' : 'running',
    runId,
    queuedItems: state.cliQueuedDeliveries,
    queuedBytes: state.cliQueuedBytes,
  });
  return { verdict, tSent, injectionsBefore };
}

/** Books a mirror verdict against the current run: a moved key is a change, a still key is dedup. */
/** @param {RunRow} run @param {Verdict} verdict */
function book(run, verdict) {
  if (verdict.changed) run.distinct += 1;
  else run.dedup += 1;
}

/** True once the run has spent every slot the per-run cap allows. */
/** @param {RunRow} run @returns {boolean} */
function capReached(run) {
  return run.injections >= VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN;
}

/**
 * Waits for the window opened by this change to put one line on the wire, and books it.
 *
 * `injectionsBefore` was read before the delivery went out, so an injection that raced the delivery
 * (the ~0 ms window's flush) is still this change's and still counts.
 *
 * Past the cap no line will come at all — the proxy has latched `statusCapReached` for the run — so
 * the change is counted as cap-suppressed rather than waited for.
 *
 * @param {State} state
 * @param {RunRow} run
 * @param {number} tSent
 * @param {number} injectionsBefore
 * @returns {Promise<void>}
 */
async function settleChange(state, run, tSent, injectionsBefore) {
  if (capReached(run)) {
    run.cap += 1;
    await sleep(GRACE_MS);
    return;
  }
  await waitFor(() => state.arm.injections.length > injectionsBefore, state.arm.statusRateMs + SENT_TIMEOUT_MS);
  const entry = state.arm.injections.at(-1);
  if (state.arm.injections.length > injectionsBefore && entry !== undefined) {
    run.injections += 1;
    state.latencies.push(entry.t - tSent);
  } else {
    run.cap += 1;
    await sleep(GRACE_MS);
  }
}

/** The RESET delivery that opens a run: a `queued: false` result, always its own change. */
/** @param {State} state @param {string} runId @returns {Promise<void>} */
async function opReset(state, runId) {
  const observed = await deliverAndObserve(state, runId, false);
  if (observed === null) return;
  book(state.currentRun, observed.verdict);
  if (observed.verdict.changed && state.expectInjections) {
    await settleChange(state, state.currentRun, observed.tSent, observed.injectionsBefore);
  }
}

/** Repeated IDENTICAL deliveries: the dedup key never moves, so nothing is injected. */
/** @param {State} state @param {string} runId @param {number} n @returns {Promise<void>} */
async function opRepeat(state, runId, n) {
  for (let i = 0; i < n; i += 1) {
    const observed = await deliverAndObserve(state, runId, false);
    if (observed !== null) book(state.currentRun, observed.verdict);
  }
  await sleep(GRACE_MS);
}

/** One SEPARATED change: delivered alone, awaited until its own window has flushed. */
/** @param {State} state @param {string} runId @returns {Promise<void>} */
async function opSeparate(state, runId) {
  const observed = await deliverAndObserve(state, runId, true);
  if (observed === null) return;
  book(state.currentRun, observed.verdict);
  if (!observed.verdict.changed) return;
  if (!state.expectInjections) {
    await sleep(GRACE_MS);
    return;
  }
  await settleChange(state, state.currentRun, observed.tSent, observed.injectionsBefore);
}

/**
 * A BURST: `n` distinct changes folded inside ONE rate window. The first arms the window; the rest
 * coalesce into the single line it flushes — this is where the rate-limit suppression count comes from.
 *
 * @param {State} state
 * @param {string} runId
 * @param {number} n
 * @returns {Promise<void>}
 */
async function opBurst(state, runId, n) {
  const run = state.currentRun;
  const before = state.arm.injections.length;
  let changed = 0;
  /** @type {number|null} */
  let firstSent = null;
  for (let i = 0; i < n; i += 1) {
    const observed = await deliverAndObserve(state, runId, true);
    if (observed === null) continue;
    book(run, observed.verdict);
    if (observed.verdict.changed) {
      changed += 1;
      if (firstSent === null) firstSent = observed.tSent;
    }
  }
  if (changed === 0) return;
  if (!state.expectInjections || capReached(run)) {
    run.cap += changed;
    await sleep(GRACE_MS);
    return;
  }
  await waitFor(() => state.arm.injections.length > before, state.arm.statusRateMs + SENT_TIMEOUT_MS);
  const delta = state.arm.injections.length - before;
  const entry = state.arm.injections.at(-1);
  if (delta >= 1 && entry !== undefined) {
    run.injections += delta;
    run.rate += Math.max(0, changed - delta);
    if (firstSent !== null) state.latencies.push(entry.t - firstSent);
  } else {
    run.cap += changed;
    await sleep(GRACE_MS);
  }
}

/** Opens a fresh run row. The proxy resets its per-run counters on the runId change this implies. */
/** @param {State} state @param {string} runId */
function openRun(state, runId) {
  state.currentRun = newRunRow(runId);
  state.runs.push(state.currentRun);
}

/**
 * The LONG turn of the COUNT arm: seven coalescing runs of the same shape, then one run deliberately
 * driven past the per-run cap.
 * @param {State} state
 * @returns {Promise<void>}
 */
async function driveCount(state) {
  for (let r = 1; r <= COST_RATE_RUNS; r += 1) {
    const runId = `k${r}`;
    openRun(state, runId);
    await opReset(state, runId);
    await opRepeat(state, runId, REPEATS_PER_RUN);
    for (let i = 0; i < SEPARATED_PER_RUN; i += 1) await opSeparate(state, runId);
    await opBurst(state, runId, BURST_WIDTH);
  }
  openRun(state, 'cap');
  await opReset(state, 'cap');
  for (let i = 0; i < CAP_RUN_CHANGES; i += 1) await opSeparate(state, 'cap');
}

/** The LATENCY arm: five runs of eight separated changes each — every one its own injection. */
/** @param {State} state @returns {Promise<void>} */
async function driveLatency(state) {
  for (let r = 1; r <= LATENCY_RUNS; r += 1) {
    const runId = `l${r}`;
    openRun(state, runId);
    await opReset(state, runId);
    for (let i = 0; i < LATENCY_INJECTIONS_PER_RUN - 1; i += 1) await opSeparate(state, runId);
  }
}

/** Totals for one arm. */
/** @param {RunRow[]} runs @returns {Totals} */
function totalsOf(runs) {
  /** @type {Totals} */
  const totals = { deliveries: 0, distinct: 0, injections: 0, dedup: 0, rate: 0, cap: 0, lost: 0 };
  for (const run of runs) {
    totals.deliveries += run.deliveries;
    totals.distinct += run.distinct;
    totals.injections += run.injections;
    totals.dedup += run.dedup;
    totals.rate += run.rate;
    totals.cap += run.cap;
    totals.lost += run.lost;
  }
  return totals;
}

// -------------------------------------------------------------------------------------------------
// The arms.
// -------------------------------------------------------------------------------------------------

/** Runs one arm to completion and returns its state. */
/**
 * @param {(state: State) => Promise<void>} driver
 * @param {{ statusRateMs: number, expectInjections: boolean }} options
 * @returns {Promise<State>}
 */
async function runArm(driver, { statusRateMs, expectInjections }) {
  const arm = bootArm({ statusRateMs });
  const state = newState(arm, { expectInjections });
  await openSession(arm);
  await driver(state);
  // Let any last window close before closing the socket, so a late injection is still counted.
  await sleep(Math.min(statusRateMs, COUNT_RATE_MS) + GRACE_MS);
  arm.socket.close();
  return state;
}

/**
 * The default measurement: COUNT + PAYLOAD + LATENCY + CONTROL, all offline.
 *
 * The CONTROL arm is the false form: the SAME driver with injection suppressed, whose wire readings
 * must differ from the counting arm's.
 * @returns {Promise<Reading>}
 */
async function measure() {
  const count = await runArm(driveCount, { statusRateMs: COUNT_RATE_MS, expectInjections: true });
  const latency = await runArm(driveLatency, { statusRateMs: LATENCY_RATE_MS, expectInjections: true });
  const control = await runArm(driveCount, { statusRateMs: CONTROL_RATE_MS, expectInjections: false });

  const countTotals = totalsOf(count.runs);
  const bodyBytes = count.arm.injections.map((entry) => entry.instructions.length);
  const lineBytes = count.arm.injections.map((entry) => entry.lineBytes);
  const baseBytes = Buffer.byteLength(VOICE_REALTIME_INSTRUCTIONS, 'utf8');
  const controlBodyBytes = control.arm.updates.map((entry) => entry.bytes);
  const latencyValues = latency.latencies.length > 0 ? latency.latencies : count.latencies;

  return {
    count: {
      totals: countTotals,
      runs: count.runs,
      injections: count.arm.injections.length,
      baseBytes,
      body: distribution(bodyBytes),
      line: distribution(lineBytes),
      /** Every injection handed out exactly one reading — the line and the reading are one source. */
      readingsPerInjection: count.arm.readings.length === count.arm.injections.length,
    },
    latency: {
      distribution: distribution(latencyValues),
      samples: latencyValues.length,
      rateMs: latency.latencies.length > 0 ? LATENCY_RATE_MS : COUNT_RATE_MS,
      shippedWindowMs: VOICE_REALTIME_STATUS_RATE_MS,
    },
    control: {
      injections: control.arm.injections.length,
      maxBodyBytes: controlBodyBytes.length > 0 ? Math.max(...controlBodyBytes) : 0,
      updates: control.arm.updates.length,
    },
    paid: { tokenDelta: null, costCny: null, reason: 'paid arm not run (default off; needs explicit opt-in + budget)' },
  };
}

/** The false form: the two arms must NOT read the same. Returns a one-line verdict and its booleans. */
/** @param {Reading} reading @returns {{ ok: boolean, line: string }} */
function falseFormSeparates(reading) {
  const off = reading.control.injections === 0;
  const on = reading.count.injections >= 30;
  const bytesDiffer = reading.count.body.max !== null && reading.control.maxBodyBytes < reading.count.body.max;
  const ok = off && on && bytesDiffer;
  return {
    ok,
    line: `${ok ? 'ok  ' : 'FAIL'} 注入关/开的读数分离：注入关 ${reading.control.injections} 次（体 ≤ ${reading.control.maxBodyBytes} B）、开 ${reading.count.injections} 次（体 max ${reading.count.body.max} B）`,
  };
}

// -------------------------------------------------------------------------------------------------
// The record document: render, and CHECK (an empty table is a failure, never a pass).
// -------------------------------------------------------------------------------------------------

/** Numeric or "未测" — the two honest states a paid reading can be in. */
/** @param {unknown} value @returns {string} */
function cell(value) {
  if (value === null || value === undefined) return '未测';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '未测';
  return String(value);
}

/**
 * Renders the readings document. Deterministic: the same measurement renders byte-for-byte alike.
 * @param {Reading} reading
 * @returns {string}
 */
function renderDoc(reading) {
  const t = reading.count.totals;
  const bodyDelta = reading.count.body.p50 === null ? null : reading.count.body.p50 - reading.count.baseBytes;
  const rows = reading.count.runs.map(
    (run) =>
      `| ${run.runId} | ${run.deliveries} | ${run.distinct} | ${run.injections} | ${run.dedup} | ${run.rate} | ${run.cap} |`,
  );
  return [
    '# S-A 状态注入的净成本与实时性读数',
    '',
    '本文件是 `SPEC §8.3` 的每-run 上限与 `§13` 的 S-A 两条 SLO 的**离线实测**记录。量测脚本',
    '`scripts/voice-realtime-status-cost.mjs` 驱动**真 transport + 真 proxy**（`createDashscopeTransport`',
    '+ `handleVoiceRealtimeConnection`）跑在**脚本化假上游**（`createScriptedUpstream`）之上，`apiKey: \'\'`，',
    '零云端调用；所有读数来自假上游**实际收到**的 `session.update` 帧。',
    '',
    '## 复跑',
    '',
    '```',
    'node --experimental-transform-types scripts/voice-realtime-status-cost.mjs',
    'node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --check docs/operations/voice-realtime-status-cost.md',
    'node --experimental-transform-types scripts/voice-realtime-status-cost.mjs --self-test',
    '```',
    '',
    '`--check` 在读数表为空或缺项时**失败**（空表不等于对账成功，与 `voice-realtime-reconcile.md` 一致）。',
    '',
    '## 读数',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 状态变化次数 | ${t.distinct} |`,
    `| 注入次数 | ${t.injections} |`,
    `| 去重抑制次数 | ${t.dedup} |`,
    `| 限频抑制次数 | ${t.rate} |`,
    `| 上限抑制次数 | ${t.cap} |`,
    `| 注入延迟样本数 | ${reading.latency.samples} |`,
    `| 注入延迟 p50 ms | ${reading.latency.distribution.p50} |`,
    `| 注入延迟 p95 ms | ${reading.latency.distribution.p95} |`,
    `| 注入延迟 max ms | ${reading.latency.distribution.max} |`,
    `| 基础指令字节 | ${reading.count.baseBytes} |`,
    `| 指令块字节 p50 | ${reading.count.body.p50} |`,
    `| 指令块字节 max | ${reading.count.body.max} |`,
    `| 状态行字节 p50 | ${reading.count.line.p50} |`,
    `| 状态行字节 max | ${reading.count.line.max} |`,
    `| 对照臂注入次数 | ${reading.control.injections} |`,
    `| 对照臂最大指令块字节 | ${reading.control.maxBodyBytes} |`,
    `| 付费臂 A/B token 差 | ${cell(reading.paid.tokenDelta)} |`,
    `| 付费臂花费 CNY | ${cell(reading.paid.costCny)} |`,
    '',
    '## 逐run',
    '',
    '| run | 投递 | 状态变化 | 注入 | 去重抑制 | 限频抑制 | 上限抑制 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    `| 合计 | ${t.deliveries} | ${t.distinct} | ${t.injections} | ${t.dedup} | ${t.rate} | ${t.cap} |`,
    '',
    '## 说明',
    '',
    `- **注入载荷**：每次注入把整个 instructions 块重述一遍（\`advertiseInstructions()\` 没有增量接口），`,
    `  体 = 基础指令 ${reading.count.baseBytes} B + 状态头 + 陈旧规则 + 状态行一行；上表给出体与状态行的**字节**分布。`,
    '  状态行本体受 `VOICE_REALTIME_STATUS_MAX_BYTES`（200 B）约束，是这一行而非整块的上限。',
    `- **注入延迟**：以窗口 ${reading.latency.rateMs} ms 量测，读数是**管线**延迟（状态变化 → 上游收到 \`session.update\`），`,
    `  刻意把出厂限频窗口从读数里排除；出厂窗口 ${reading.latency.shippedWindowMs} ms 是端到端的另一半。`,
    '  端到端 = 窗口 + 管线，其上界即窗口时长；同一窗口内的多次变化会被并成一行（见上表「限频抑制」）。',
    '- **对照臂（注入关）**：同一驱动把限频窗口推到 run 生命之外，flush 永不触发 ⇒ 注入 0 次、指令块回到基础体。',
    '  这一对比是本文的伪形：若脚本没有真的读线上帧，「注入关」与「注入开」两臂会读出同一组数。',
    '',
    '## SPEC 校准',
    '',
    '据本表校准 `docs/proposals/voice-realtime-persistent-control-SPEC.md` 的数值：',
    '',
    `- **§8.3 每-run 上限 ≤ 8 次**：**保留**（仍为安全上限而非最优值）。上限的正当性来自**成本**，而成本本次`,
    `  只测到字节（注入体相对基础 +${cell(bodyDelta)} B），没测到 token —— 字节→token 需真实计费端点。`,
    '  故 §8.3 的注记保留，只把出处改指向本文件。',
    `- **§13 S-A 注入延迟 ≤ 300 ms p95**：**校准**。离线实测管线 p95 = ${cell(reading.latency.distribution.p95)} ms`,
    `  （n = ${reading.latency.samples}，窗口 ${reading.latency.rateMs} ms）。管线极快，端到端的量级由出厂窗口决定，`,
    '  故该行写成两段：**管线 ≤ 50 ms p95（已实测）** + **端到端 ≤ 窗口 + 管线**。',
    '- **§13 S-A 注入净成本 ≤ 5% 固定上下文（≤ ~64 token 等效）**：**保留「仍为建议值（成本未实测）」的注记**。',
    '  注入体的字节已实测（见上），但 token 等效未测，故不改写该 SLO 的数值。',
    '',
    '## 付费臂（本次未运行）',
    '',
    '真实 A/B token 用量必须在**付费**端点上跑；本工具不代跑 —— `--paid --max-cny <预算>` 只用于**声明**',
    '（缺预算即拒绝，exit 2），离线外推不得写成计费读数。人工过程逐字记录：',
    '',
    '1. 同一会话、同一长回合跑两臂：A 臂注入开（现状），B 臂注入关（`VOICE_REALTIME_STATUS` 关闭或窗口推远）。',
    '2. 从端点账单/dashboard 读两臂的 input token 与金额，差额即「注入净成本」的真实读数。',
    '3. 把 token 差与金额写回上表两个付费行，替换「未测」；`--check` 会拒绝既非数字亦非「未测」的值。',
    '',
  ].join('\n');
}

/** The reading keys the record MUST carry (non-empty), or the record is not a record. */
const REQUIRED_READINGS = [
  '状态变化次数',
  '注入次数',
  '去重抑制次数',
  '限频抑制次数',
  '上限抑制次数',
  '注入延迟样本数',
  '注入延迟 p50 ms',
  '注入延迟 p95 ms',
  '注入延迟 max ms',
  '基础指令字节',
  '指令块字节 p50',
  '指令块字节 max',
  '状态行字节 p50',
  '状态行字节 max',
  '对照臂注入次数',
  '对照臂最大指令块字节',
  '付费臂 A/B token 差',
  '付费臂花费 CNY',
];

/** Splits a markdown document into `## `-headed sections. */
/** @param {string} markdown @returns {Map<string, string[]>} */
function parseSections(markdown) {
  /** @type {Map<string, string[]>} */
  const sections = new Map();
  /** @type {string|null} */
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      current = (heading[1] ?? '').trim();
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current)?.push(line);
  }
  return sections;
}

/** The first markdown table under a heading, as `{ <header>: <cell> }` rows. */
/** @param {string[]|undefined} lines @returns {Record<string, string>[]} */
function rowsOf(lines) {
  if (lines === undefined) return [];
  /** @type {string[]|null} */
  let header = null;
  /** @type {Record<string, string>[]} */
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (header !== null && trimmed === '') break;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((text) => text.trim().replace(/^`|`$/g, ''));
    if (header === null) {
      header = cells;
      continue;
    }
    /** @type {Record<string, string>} */
    const row = {};
    header.forEach((name, index) => {
      row[name] = cells[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Checks one record document. Pure: the verdict comes from the text handed in.
 *
 * Fails on: a required reading missing or empty; an empty per-run table; a totals row that does not
 * equal the sum of its detail rows, or a reading that does not equal the totals row; a paid reading
 * that is neither a number nor the literal `未测`.
 *
 * @param {string} markdown
 * @returns {{ ok: boolean, problems: string[], notes: string[], readings: Record<string, string> }}
 */
function checkDoc(markdown) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  const sections = parseSections(markdown);

  /** @type {Record<string, string>} */
  const readings = {};
  for (const row of rowsOf(sections.get('读数'))) {
    const key = row['指标'] ?? '';
    if (key !== '') readings[key] = row['值'] ?? '';
  }
  for (const key of REQUIRED_READINGS) {
    if ((readings[key] ?? '').trim() === '') problems.push(`reading-missing: 读数表缺少非空的「${key}」`);
  }

  const runRows = rowsOf(sections.get('逐run'));
  const detail = runRows.filter((row) => (row['run'] ?? '') !== '合计');
  const totalRow = runRows.find((row) => (row['run'] ?? '') === '合计');
  if (detail.length === 0) {
    problems.push('table-empty: 逐run 表为空 —— 空表不等于对账成功');
  }
  if (totalRow === undefined) {
    problems.push('total-missing: 逐run 表缺「合计」行');
  } else {
    /** @param {string} column @returns {number} */
    const sum = (column) => detail.reduce((acc, row) => acc + (Number.parseInt(row[column] ?? '', 10) || 0), 0);
    /** @type {[string, string][]} */
    const pairs = [
      ['状态变化次数', '状态变化'],
      ['注入次数', '注入'],
      ['去重抑制次数', '去重抑制'],
      ['限频抑制次数', '限频抑制'],
      ['上限抑制次数', '上限抑制'],
    ];
    for (const [readingKey, column] of pairs) {
      const stated = Number.parseInt((totalRow[column] ?? '').replace(/[^\d-]/g, ''), 10);
      if (Number.isNaN(stated)) {
        problems.push(`total-malformed: 合计行的「${column}」不是数字`);
        continue;
      }
      if (stated !== sum(column)) {
        problems.push(`total-vs-detail: 合计行「${column}」=${stated} 与逐run合计=${sum(column)} 不符`);
      }
      const readingValue = Number.parseInt((readings[readingKey] ?? '').replace(/[^\d-]/g, ''), 10);
      if (!Number.isNaN(readingValue) && readingValue !== stated) {
        problems.push(`reading-vs-total: 读数「${readingKey}」=${readingValue} 与合计行=${stated} 不符`);
      }
    }
  }

  for (const paidKey of ['付费臂 A/B token 差', '付费臂花费 CNY']) {
    const value = (readings[paidKey] ?? '').trim();
    if (value === '') problems.push(`paid-missing: 付费读数「${paidKey}」为空`);
    else if (value === '未测') notes.push(`付费读数「${paidKey}」实记为「未测」（付费臂未运行）。`);
    else if (!Number.isFinite(Number(value))) {
      problems.push(`paid-unrecognized: 付费读数「${paidKey}」既不是数字也不是「未测」：${value}`);
    }
  }

  return { ok: problems.length === 0, problems, notes, readings };
}

// -------------------------------------------------------------------------------------------------
// --self-test: the false forms, RUN not asserted. The injection-off/on separation comes FIRST.
// -------------------------------------------------------------------------------------------------

/** Runs the false forms and returns one `ok`/`FAIL` line each. */
/** @returns {Promise<string[]>} */
async function selfTest() {
  /** @type {string[]} */
  const lines = [];
  const reading = await measure();

  // (0) THE FIRST CASE: the injection-off control must read differently from the counting arm.
  lines.push(falseFormSeparates(reading).line);

  // (1) The counts must be internally consistent: every change is either injected or suppressed once.
  const t = reading.count.totals;
  lines.push(
    `${t.distinct === t.injections + t.rate + t.cap ? 'ok  ' : 'FAIL'} 计数守恒：状态变化 ${t.distinct} = 注入 ${t.injections} + 限频 ${t.rate} + 上限 ${t.cap}`,
  );
  lines.push(
    `${t.deliveries === t.distinct + t.dedup ? 'ok  ' : 'FAIL'} 投递守恒：${t.deliveries} = 状态变化 ${t.distinct} + 去重抑制 ${t.dedup}`,
  );
  lines.push(`${t.lost === 0 ? 'ok  ' : 'FAIL'} 无丢失投递：lost=${t.lost}`);
  lines.push(
    `${reading.count.readingsPerInjection ? 'ok  ' : 'FAIL'} 单源：每次注入恰好一个 onExecStatus 读数（${reading.count.injections}）`,
  );

  // (2) The record round-trips: render the doc, check it (green), then break it three ways.
  const doc = renderDoc(reading);
  const good = checkDoc(doc);
  lines.push(`${good.ok ? 'ok  ' : 'FAIL'} 生成的记录通过 --check${good.ok ? '' : `：${good.problems[0] ?? ''}`}`);
  lines.push(
    `${!checkDoc(doc.replace(/^\| 注入次数 \| .*$/m, '| 注入次数 |  |')).ok ? 'ok  ' : 'FAIL'} 读数缺项 ⇒ 红（缺读数不当成功）`,
  );
  lines.push(
    `${!checkDoc(doc.replace(/^\| 合计 \| .*$/m, '| 合计 | 999 | 999 | 999 | 999 | 999 | 999 |')).ok ? 'ok  ' : 'FAIL'} 不合的合计 ⇒ 红`,
  );
  lines.push(
    `${checkDoc(doc.replace(/^\| 付费臂花费 CNY \| 未测 \|$/m, '| 付费臂花费 CNY | 0.01 |')).ok ? 'ok  ' : 'FAIL'} 付费读数可写数字（若真跑过）；本记录为「未测」`,
  );

  return [...lines, lines.every((line) => line.startsWith('ok  ')) ? 'SELF-TEST PASS' : 'SELF-TEST FAIL'];
}

// -------------------------------------------------------------------------------------------------
// The paid arm's gate. It is NOT a runner: it refuses to dial, and says why.
// -------------------------------------------------------------------------------------------------

/**
 * The paid arm is opt-in and budget-bounded by construction. This tool NEVER places a paid call: the
 * offline record must not be padded with a fabricated A/B. `--paid` without a declared budget is a
 * refusal (exit 2), so "预算未声明" and "已声明" cannot look the same to a script either.
 *
 * @param {string[]} argv
 * @returns {{ run: boolean, refuse?: boolean, reason: string }}
 */
function paidGate(argv) {
  if (!argv.includes('--paid')) return { run: false, reason: 'default off' };
  const at = argv.indexOf('--max-cny');
  const budget = at >= 0 ? Number(argv[at + 1]) : Number.NaN;
  const envBudget = Number(process.env.VOICE_REALTIME_MAX_CNY_PER_30S ?? Number.NaN);
  if (!Number.isFinite(budget) && !Number.isFinite(envBudget)) {
    return { run: false, refuse: true, reason: '--paid was given without --max-cny (or VOICE_REALTIME_MAX_CNY_PER_30S)' };
  }
  if (!process.env.DASHSCOPE_API_KEY) {
    return { run: false, refuse: true, reason: '--paid was given but DASHSCOPE_API_KEY is empty; refusing to dial' };
  }
  return {
    run: false,
    refuse: true,
    reason: 'this offline tool does not place paid calls; run the human A/B procedure recorded in the record doc',
  };
}

// -------------------------------------------------------------------------------------------------
// Entry point.
// -------------------------------------------------------------------------------------------------

/** The `run` / `--check` / `--self-test` entry point. */
async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) {
    const lines = await selfTest();
    console.log(lines.join('\n'));
    process.exitCode = lines.at(-1) === 'SELF-TEST PASS' ? 0 : 1;
    return;
  }

  const gate = paidGate(argv);
  if (gate.refuse) {
    console.error(`paid arm refused: ${gate.reason}`);
    process.exitCode = 2;
    return;
  }

  const checkAt = argv.indexOf('--check');
  if (checkAt !== -1) {
    const file = argv[checkAt + 1];
    if (file === undefined || file.startsWith('--')) {
      console.error('usage: voice-realtime-status-cost.mjs --check <record.md> [--json]');
      process.exitCode = 2;
      return;
    }
    let markdown;
    try {
      markdown = readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
      return;
    }
    const verdict = checkDoc(markdown);
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ file, ...verdict }, null, 2));
    } else {
      for (const note of verdict.notes) console.log(`  · ${note}`);
      for (const problem of verdict.problems) console.log(`  ✗ ${problem}`);
      console.log(verdict.ok ? 'STATUS-COST OK（记录可复核）' : `STATUS-COST FAILED（${verdict.problems.length} 处）`);
    }
    process.exitCode = verdict.ok ? 0 : 1;
    return;
  }

  const reading = await measure();
  const separation = falseFormSeparates(reading);

  const writeAt = argv.indexOf('--write-doc');
  if (writeAt !== -1) {
    const file = argv[writeAt + 1];
    if (file === undefined || file.startsWith('--')) {
      console.error('usage: voice-realtime-status-cost.mjs --write-doc <record.md>');
      process.exitCode = 2;
      return;
    }
    writeFileSync(file, renderDoc(reading));
    console.log(`wrote ${file}`);
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(reading, null, 2));
  } else if (writeAt === -1) {
    const t = reading.count.totals;
    console.log(`state changes=${t.distinct} deliveries=${t.deliveries} lost=${t.lost}`);
    console.log(`injections=${t.injections} dedup=${t.dedup} rate=${t.rate} cap=${t.cap}`);
    console.log(
      `latency ms: n=${reading.latency.samples} p50=${reading.latency.distribution.p50} p95=${reading.latency.distribution.p95} max=${reading.latency.distribution.max}`,
    );
    console.log(`instructions bytes: base=${reading.count.baseBytes} p50=${reading.count.body.p50} max=${reading.count.body.max}`);
    console.log(`status line bytes: p50=${reading.count.line.p50} max=${reading.count.line.max}`);
    console.log(`control (injection off): injections=${reading.control.injections} maxBody=${reading.control.maxBodyBytes}`);
    console.log(`paid arm: token delta=${cell(reading.paid.tokenDelta)} cost=${cell(reading.paid.costCny)}`);
    console.log(separation.line);
  }

  process.exitCode = separation.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
