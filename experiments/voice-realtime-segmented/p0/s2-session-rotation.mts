/**
 * S2 — how long does a fresh upstream session take to become usable, and can a warm standby take
 * over the segment right after the active session's `response.done`?
 *
 * THE QUESTION. SPEC F10 records connection setup swinging between 0.2 s and 9 s, and F1 records the
 * read-in growing with every response inside one session — which is why the design rotates to a new
 * session when the old one goes idle. Whether that rotation is INVISIBLE depends on two readings this
 * probe takes and nothing in this repository can answer:
 *
 *   timings     `socket open → session.updated` across n ≥ 5 consecutive establishments. Text-only:
 *               a session that produces no response costs nothing, so the distribution is cheap to
 *               measure and the sample can be as large as the setup time allows.
 *   handover    session A answers a segment; session B is opened and warmed WHILE A is answering;
 *               the next segment goes to B once A's `response.done` has landed. Whether B answers it
 *               (or says why not) is what P3's prewarm rule has to be built on.
 *
 * Verdict, derived from the trace by `scripts/voice-realtime-p0-record-check.mjs`:
 *   supported     B produced a response for the first segment after A completed
 *   unsupported   B produced an error frame instead
 *   inconclusive  neither, inside the window
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx experiments/voice-realtime-segmented/p0/s2-session-rotation.mts
 */
import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/index.js';

import {
  SESSION_SEND_TOOL,
  countSessionErrors,
  createRun,
  elideAudio,
  openSession,
  percentiles,
  readApiKey,
  sessionBody,
  sleep,
  summarizeExchange,
  writeTrace,
  type P0Session,
  type ProbeEvent,
} from './probe-lib.mts';

const BUDGET_CNY = 0.005;
/** How many establishments the timing distribution is drawn from. */
const TIMED_SESSIONS = 6;
/** How long one segment's answer may take before it counts as inconclusive. */
const ANSWER_WINDOW_MS = 45_000;

/** The text turn a segment becomes when there is no audio: the relay's own input shape. */
function sendTextTurn(session: P0Session, text: string): void {
  session.sendRaw({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  session.sendRaw({ type: 'response.create' });
}

type Timing = {
  label: string;
  sessionId: string | null;
  openToCreatedMs: number | null;
  openToUpdatedMs: number | null;
  closed: boolean;
};

/** Opens one session, times it to `session.updated`, closes it. No response is ever created. */
async function timeOneEstablishment(run: ReturnType<typeof createRun>, label: string): Promise<Timing> {
  const session = await openSession({
    run,
    label,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody(),
    executor: { session_send: () => ({ queued: true }) },
    respondToToolOutputs: false,
  });
  const became = await session.waitFor(() => session.updatedMs !== null, 30_000);
  const timing: Timing = {
    label,
    sessionId: session.sessionId,
    openToCreatedMs: session.createdMs,
    openToUpdatedMs: became ? session.updatedMs : null,
    closed: false,
  };
  await session.close();
  return { ...timing, closed: session.closed };
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });

  // ── the timing distribution ────────────────────────────────────────────────────────────────────
  const timings: Timing[] = [];
  for (let index = 0; index < TIMED_SESSIONS && !run.guardTriggered; index += 1) {
    timings.push(await timeOneEstablishment(run, `timer-${index}`));
  }

  // ── the handover ───────────────────────────────────────────────────────────────────────────────
  const activeEvents: ProbeEvent[] = [];
  const standbyEvents: ProbeEvent[] = [];
  const active = await openSession({
    run,
    label: 'active-A',
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody(),
    executor: { session_send: () => ({ queued: true }) },
    respondToToolOutputs: false,
    onEvent: (event) => activeEvents.push(event),
  });
  await active.waitFor(() => active.updatedMs !== null, 30_000);
  sendTextTurn(active, '第一段：把 server 里的超时改成三十秒。');

  // B is opened and warmed WHILE A is still answering — that is what "prewarm" means here, and
  // opening it after A's `response.done` would measure a cold start instead.
  const standby = await openSession({
    run,
    label: 'standby-B',
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody(),
    executor: { session_send: () => ({ queued: true }) },
    respondToToolOutputs: false,
    onEvent: (event) => standbyEvents.push(event),
  });
  const standbyWarm = await standby.waitFor(() => standby.updatedMs !== null, 30_000);

  const activeDone = await active.waitFor(() => active.responses.length > 0 || active.errors.length > 0, ANSWER_WINDOW_MS);
  const activeDoneAtMs = activeDone && active.responses.length > 0 ? (active.responses[0]?.atMs ?? null) : null;

  // Only now does B get a segment — after A has completed.
  const standbyBefore = standby.responses.length;
  sendTextTurn(standby, '第二段：顺便看一下 quay 的 gantt 接口。');
  const standbyAnswered = await standby.waitFor(
    () => standby.responses.length > standbyBefore || standby.errors.length > 0,
    ANSWER_WINDOW_MS,
  );
  await sleep(300);

  const standbyError = standby.errors[0] ?? null;
  const standbyErrorCount = countSessionErrors(standby.events, standby.errors);
  const standbyResult = standbyAnswered && standby.responses.length > standbyBefore;
  // "Warm BEFORE A finished" is a wall-clock comparison, not an intention: the standby's own open
  // stamp plus its relative `session.updated` has to land at or before A's `response.done`.
  const standbyWarmAtMs =
    standby.socketOpenMs !== null && standby.updatedMs !== null ? standby.socketOpenMs + standby.updatedMs : null;
  const warmedBeforeActiveDone =
    standbyWarmAtMs !== null && activeDoneAtMs !== null && standbyWarmAtMs <= activeDoneAtMs;
  const handover = {
    active: {
      label: active.label,
      sessionId: active.sessionId,
      responseDoneAtMs: activeDoneAtMs,
      responses: active.responses,
      errors: active.errors,
      functionCalls: active.functionCalls,
      spendCny: active.spendCny,
      exchange: summarizeExchange(active.events),
      events: elideAudio(activeEvents),
    },
    standby: {
      label: standby.label,
      sessionId: standby.sessionId,
      sessionUpdatedSeen: standbyWarm,
      warmAtMs: standbyWarmAtMs,
      warmedBeforeActiveDone,
      segmentSentAfterActiveDone: true,
      responses: standby.responses,
      errors: standby.errors,
      functionCalls: standby.functionCalls,
      spendCny: standby.spendCny,
      exchange: summarizeExchange(standby.events),
      events: elideAudio(standbyEvents),
    },
    // An answer outranks a complaint: if the standby both answered and reported an error, what the
    // design needs to know is that the handover PRODUCED a segment answer. `deriveS2` in
    // scripts/voice-realtime-p0-record-check.mjs resolves the same two readings in the same order.
    outcome: standbyResult ? 'ok' : standbyErrorCount > 0 ? 'error' : 'timeout',
    error: standbyError,
  };

  await standby.close();
  await active.close();

  const updatedSamples = timings.map((timing) => timing.openToUpdatedMs).filter((value): value is number => value !== null);
  const createdSamples = timings.map((timing) => timing.openToCreatedMs).filter((value): value is number => value !== null);
  const establishment = {
    n: timings.length,
    updatedMs: percentiles(updatedSamples),
    createdMs: percentiles(createdSamples),
    timings,
  };

  const trace = {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S2',
    stageTitle: '空闲上游会话切换（建立耗时分布 + 预热待命会话接手）',
    question: '新会话建立到 session.updated 的耗时分布如何？A 回完后由预热的 B 接手第一段是否正常？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    establishment,
    handover,
    evidence: {
      timedEstablishments: timings.length,
      establishmentsWithUpdated: updatedSamples.length,
      activeResponseDone: active.responses.length,
      standbyWarmedBeforeActiveDone: warmedBeforeActiveDone,
      standbyTookFirstSegment: handover.outcome === 'ok',
      // Received `error` frames PLUS the transport errors that never were frames — the one rule
      // `errorCount` in scripts/voice-realtime-p0-record-check.mjs applies to this same trace.
      standbyErrorFrames: standbyErrorCount,
    },
    verdict: handover.outcome === 'ok' ? 'supported' : handover.outcome === 'error' ? 'unsupported' : 'inconclusive',
    spendCny: run.spendCny,
    budgetCny: BUDGET_CNY,
    guardTriggered: run.guardTriggered,
    notes: '',
  };
  trace.notes =
    `n=${establishment.n} updated p50=${establishment.updatedMs.p50}ms p90=${establishment.updatedMs.p90}ms ` +
    `min=${establishment.updatedMs.min}ms max=${establishment.updatedMs.max}ms | ` +
    `handover=${handover.outcome} warmed_before_done=${warmedBeforeActiveDone} ` +
    `standby_session_send=${standby.functionCalls.length}`;

  const written = writeTrace('s2-session-rotation.json', trace, apiKey);
  console.log(`S2 verdict=${trace.verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  console.log(`  ${trace.notes}`);
  console.log(`  ${written.file} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  process.exit(0);
}

main().catch((error) => {
  console.error('S2 probe failed:', error);
  process.exit(1);
});
