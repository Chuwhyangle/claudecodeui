/**
 * S3 — with a ~2,000-character context pack in `instructions`, does the relay still forward every
 * utterance, and what does each response then read in?
 *
 * THE QUESTION. The SPEC's ContextPack puts the recent conversation into the session's `instructions`
 * so the model can answer "what were we doing" questions. The cost of that idea is not the money —
 * text is cheap — it is that `instructions` is re-read on EVERY response, and the risk is that a
 * prompt full of Chinese prose about this repo's code changes what the model does with a user turn:
 * it may answer the question itself instead of forwarding it.
 *
 * WHAT IS SENT. Six utterances, each run TWICE on a FRESH session (12 responses), because the SPEC's
 * rotation design gives each response a fresh session and because a repeat is what separates "this
 * utterance failed" from "this shape fails". Two of the six carry identifier-shaped tokens
 * (`MessageComponent.tsx`, a commit SHA) so pass-through is read, not assumed.
 *
 * WHAT IS READ, per response:
 *   forwarded        did the model call `session_send` at all — read from the FRAMES, both dialects
 *   forwardedMessage what it asked to send
 *   editDistance     normalized (0–1) distance from the utterance, so "forwarded but rewritten" is
 *                    visible as a number rather than argued about
 *   identifierHit    every identifier-shaped token in the utterance survived into the message
 *                    (`null` when the utterance carried none — the key is always present)
 *   usage            the `response.done` frame's own usage object; `usage.input_tokens` is what one
 *                    response actually read in, and the criterion names that path, not a copy of it
 *
 * Verdict, derived from the trace by `scripts/voice-realtime-p0-record-check.mjs`:
 *   supported     every completed response forwarded
 *   unsupported   some response completed without forwarding
 *   inconclusive  no response completed at all
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx experiments/voice-realtime-segmented/p0/s3-context-injection.mts
 *     npx tsx experiments/voice-realtime-segmented/p0/s3-context-injection.mts --limit=1   # calibration
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/index.js';

import {
  FIXTURES_DIR,
  SESSION_SEND_TOOL,
  countSessionErrors,
  createRun,
  elideAudio,
  extractIdentifiers,
  normalizedEditDistance,
  openSession,
  percentiles,
  readApiKey,
  sessionBody,
  sessionSendFrames,
  sleep,
  summarizeExchange,
  writeTrace,
  type P0Session,
  type ProbeEvent,
} from './probe-lib.mts';

const BUDGET_CNY = 0.025;
const RESPONSE_WINDOW_MS = 60_000;
/** How many times each utterance is run. The AC's "6 句 × 2 次 = 12 条响应记录". */
const REPEATS = 2;

/**
 * Six utterances: four carried over verbatim from `experiments/voice-realtime-prompt/prompt-probe.mts`
 * so this stage is comparable with the pack-free probe that already passed, and two that carry the
 * identifier shapes the SPEC's F4 handover has to survive.
 */
const UTTERANCES: ReadonlyArray<{ id: string; text: string; source: string }> = [
  { id: 'u1', text: '所以你听见我说什么了，对不对？', source: 'prompt-probe' },
  { id: 'u2', text: '你看，第二次推理就出不来了。', source: 'prompt-probe' },
  { id: 'u3', text: '为什么没有输出？', source: 'prompt-probe' },
  { id: 'u4', text: '把 server 里的超时改成三十秒。', source: 'prompt-probe' },
  { id: 'u5', text: '你把 MessageComponent.tsx 里那个 fork 按钮改一下吧。', source: 'identifier' },
  { id: 'u6', text: '再看看 7fe72e71 那个提交改了什么。', source: 'identifier' },
];

type ContextSample = { chars: number; rows: Array<{ role: string; text: string }>; pack: string };

type ResponseRecord = {
  utteranceId: string;
  utterance: string;
  source: string;
  repeat: number;
  label: string;
  sessionId: string | null;
  sessionUpdatedMs: number | null;
  responseId: string | null;
  /** Whether a `session_send` call reached the FRAMES. */
  forwarded: boolean;
  forwardedMessage: string | null;
  forwardedAtMs: number | null;
  /** 0 = identical to the utterance, 1 = nothing shared. `null` when nothing was forwarded. */
  editDistance: number | null;
  identifiers: string[];
  /** `null` when the utterance carried no identifier-shaped token. */
  identifierHit: boolean | null;
  /** The `response.done` frame's own usage object, verbatim: the criterion reads `usage.input_tokens`. */
  usage: Record<string, unknown> | null;
  inputTokens: number | null;
  status: string | null;
  spendCny: number;
  /** Every error the session recorded, INCLUDING the transport errors that never were frames. */
  errors: P0Session['errors'];
  timedOut: boolean;
  exchange: ReturnType<typeof summarizeExchange>;
  events: ProbeEvent[];
};

/** The pack goes into `instructions` after the relay's own rules, framed as what it is. */
function buildInstructions(pack: string): string {
  return `${VOICE_REALTIME_INSTRUCTIONS}\n\n以下是当前 Claude Code 会话的上下文（用户看得见的内容，最新在后）。\n\n${pack}`;
}

async function runOne(
  run: ReturnType<typeof createRun>,
  utterance: (typeof UTTERANCES)[number],
  repeat: number,
  instructions: string,
): Promise<ResponseRecord> {
  const label = `${utterance.id}-r${repeat}`;
  const events: ProbeEvent[] = [];
  const session: P0Session = await openSession({
    run,
    label,
    instructions,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody(),
    executor: { session_send: (args) => ({ queued: true, message: args.message ?? null }) },
    // A tool result must not re-read the whole session: the relay has nothing to say about it.
    respondToToolOutputs: false,
    onEvent: (event) => events.push(event),
  });

  const warm = await session.waitFor(() => session.updatedMs !== null, 20_000);
  let timedOut = false;
  if (warm) {
    session.sendRaw({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: utterance.text }] },
    });
    session.sendRaw({ type: 'response.create' });
    const answered = await session.waitFor(
      () => session.responses.length > 0 || session.errors.length > 0,
      RESPONSE_WINDOW_MS,
    );
    timedOut = !answered;
  }
  await sleep(200);

  // The forward is read off the FRAMES, not off the executor: the transport de-duplicates on
  // `call_id` and rejects before routing, so a delivery the frames carry can be one the executor
  // never saw, and a call the transport rejected is in neither. `sessionSendFrames` is the same
  // reader `deriveS3` in scripts/voice-realtime-p0-record-check.mjs applies to this trace.
  const sends = sessionSendFrames(events);
  const lastSend = sends.length === 0 ? null : sends[sends.length - 1];
  const forwardedMessage = lastSend === null ? null : lastSend.message;
  const identifiers = extractIdentifiers(utterance.text);
  const response = session.responses[0] ?? null;
  const usage = (response?.usage ?? null) as Record<string, unknown> | null;

  const record: ResponseRecord = {
    utteranceId: utterance.id,
    utterance: utterance.text,
    source: utterance.source,
    repeat,
    label,
    sessionId: session.sessionId,
    sessionUpdatedMs: session.updatedMs,
    responseId: response?.id ?? null,
    forwarded: lastSend !== null,
    forwardedMessage,
    forwardedAtMs: lastSend?.atMs ?? null,
    editDistance: forwardedMessage === null ? null : normalizedEditDistance(utterance.text, forwardedMessage),
    identifiers,
    identifierHit:
      identifiers.length === 0 || forwardedMessage === null
        ? null
        : identifiers.every((token) => forwardedMessage.includes(token)),
    usage,
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : null,
    status: response?.status ?? null,
    spendCny: session.spendCny,
    errors: session.errors,
    timedOut: timedOut && session.responses.length === 0,
    exchange: summarizeExchange(session.events),
    events: elideAudio(events),
  };
  await session.close();
  return record;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Number.POSITIVE_INFINITY;

  const sample = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'context-sample.json'), 'utf8')) as ContextSample;
  const instructions = buildInstructions(sample.pack);
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });

  const planned: Array<{ utterance: (typeof UTTERANCES)[number]; repeat: number }> = [];
  for (const utterance of UTTERANCES) {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) planned.push({ utterance, repeat });
  }

  const records: ResponseRecord[] = [];
  for (const item of planned) {
    if (run.guardTriggered || records.length >= limit) break;
    records.push(await runOne(run, item.utterance, item.repeat, instructions));
  }

  const completed = records.filter((record) => record.responseId !== null);
  // Both counts run over EVERY record, exactly as `deriveS3` computes them: a record that never
  // completed is not a forward, so counting only the completed ones would hide a short run.
  const forwardedCount = records.filter((record) => record.forwarded).length;
  const distances = completed.filter((record) => record.editDistance !== null).map((record) => record.editDistance as number);
  const tokens = completed.filter((record) => record.inputTokens !== null).map((record) => record.inputTokens as number);
  const identifierBearing = completed.filter((record) => record.identifierHit !== null);

  const evidence = {
    plannedResponses: planned.length,
    responsesRecorded: records.length,
    responsesCompleted: completed.length,
    forwarded: forwardedCount,
    forwardRate: records.length === 0 ? 0 : Number((forwardedCount / records.length).toFixed(4)),
    identifierBearingResponses: identifierBearing.length,
    identifierHits: identifierBearing.filter((record) => record.identifierHit === true).length,
    // Received `error` frames PLUS the transport errors that never were frames — the one rule the
    // criterion applies to these same records.
    errorFrames: records.reduce((sum, record) => sum + countSessionErrors(record.events, record.errors), 0),
    timedOut: records.filter((record) => record.timedOut).length,
    contextChars: sample.chars,
    instructionsChars: instructions.length,
    inputTokens: percentiles(tokens),
    editDistance: {
      mean:
        distances.length === 0
          ? null
          : Number((distances.reduce((sum, value) => sum + value, 0) / distances.length).toFixed(4)),
      ...percentiles(distances),
    },
  };

  const trace = {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S3',
    stageTitle: '上下文注入（~2,000 字符上下文包进 instructions，6 句 × 2 次）',
    question: 'instructions 里带上上下文包之后，模型是否仍然逐句转发？每条响应读入多少？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    context: {
      fixture: 'experiments/voice-realtime-segmented/p0/fixtures/context-sample.json',
      chars: sample.chars,
      rows: sample.rows.length,
      budgetChars: 2000,
    },
    instructionsChars: instructions.length,
    tool: SESSION_SEND_TOOL.name,
    utterances: UTTERANCES,
    responses: records,
    evidence,
    // The SAME rule the criterion applies to this trace. Written here so the file reads on its own;
    // `deriveS3` in scripts/voice-realtime-p0-record-check.mjs re-derives it and reds on a
    // disagreement, which is what makes it a reading rather than a claim.
    verdict:
      completed.length === 0 ? 'inconclusive' : forwardedCount === completed.length ? 'supported' : 'unsupported',
    spendCny: run.spendCny,
    budgetCny: BUDGET_CNY,
    guardTriggered: run.guardTriggered,
    notes: '',
  };
  trace.notes =
    `responses=${completed.length}/${planned.length} forwarded=${forwardedCount} ` +
    `mean_edit=${evidence.editDistance.mean} ` +
    `input_tokens p50=${evidence.inputTokens.p50} max=${evidence.inputTokens.max} ` +
    `identifiers ${evidence.identifierHits}/${evidence.identifierBearingResponses} | ` +
    `context=${sample.chars} chars, instructions=${instructions.length} chars, spend=¥${run.spendCny.toFixed(6)}`;

  const written = writeTrace('s3-context-injection.json', trace, apiKey);
  console.log(`S3 verdict=${trace.verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  console.log(`  ${trace.notes}`);
  console.log(`  ${written.file} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  process.exit(0);
}

main().catch((error) => {
  console.error('S3 probe failed:', error);
  process.exit(1);
});
