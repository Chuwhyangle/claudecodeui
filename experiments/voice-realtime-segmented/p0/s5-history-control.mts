/**
 * S5 — conversation control: can the relay INSERT an assistant item, and can it DELETE one?
 *
 * THE QUESTION. The segmentation design wants two levers on the upstream conversation that are not
 * "send audio" and not "send a user message":
 *
 *   1. INSERT — after a segment has been forwarded to the Claude Code session, the relay writes an
 *      assistant turn into the upstream conversation so the model knows the tool call landed. The
 *      SPEC calls this the assistant `OK` item, and it is what lets the next segment stop
 *      re-forwarding the previous one (成本模型 r=2 → 1).
 *   2. DELETE — when a segment is settled, its upstream history is dead weight that re-bills as
 *      input on every later turn. `conversation.item.delete` is the only lever for dropping it, so
 *      the SPEC's cost model depends on it actually working.
 *
 * WHAT IS SENT, on ONE session (`turn_detection: null`, so the probe owns every response window):
 *   a. a long user item — the "settled segment" history that delete should be able to drop;
 *   b. the assistant `OK` item, inserted while that history is still present;
 *   c. the NEXT segment as a user item, then `response.create` → the forward this stage is about;
 *   d. `conversation.item.delete` for the long item, then one more `response.create`.
 *
 * WHAT IS READ, all from the frames:
 *   - whether the assistant item was ACCEPTED (`conversation.item.created` came back, and with which
 *     id), or rejected;
 *   - whether the next segment was FORWARDED (the call_id-deduplicated `session_send` reader);
 *   - whether the delete was ACCEPTED (`conversation.item.deleted`) or refused (the `error` original
 *     text), and
 *   - `usage.input_tokens` on the response BEFORE the delete and on the response AFTER it. This is
 *     the only reading that tells an accepted-and-effective delete from an accepted-and-inert one:
 *     measured 2026-10-10, the endpoint returns `conversation.item.deleted` even for an id that never
 *     existed, so acceptance alone proves nothing (the same non-discriminating-echo trap as S4).
 *
 * Verdict, derived from the trace by `scripts/voice-realtime-p0-record-check.mjs`:
 *   supported     the assistant item was accepted, the next segment forwarded, and the delete both
 *                 accepted and followed by a DROP in input_tokens
 *   unsupported   the assistant item or the delete was refused
 *   inconclusive  both accepted, but the delete left input_tokens no lower than before
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s5-history-control.mts
 */
import {
  SESSION_SEND_TOOL,
  countSessionErrors,
  createRun,
  openSession,
  readApiKey,
  sessionBody,
  sessionSendFrames,
  sleep,
  summarizeExchange,
  writeTrace,
  type P0Session,
  type ProbeEvent,
} from './probe-lib.mts';

import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/index.js';

const BUDGET_CNY = 0.004;
/** One response window. The endpoint answers a text turn in well under a second; this is the watchdog. */
const RESPONSE_WINDOW_MS = 45_000;

/**
 * The settled history the delete is asked to drop. Deterministic prose rather than random bytes so
 * the trace's token arithmetic is reproducible, and long enough that a real delete has to move the
 * input_tokens number by more than the noise of the OK/next-segment items added alongside it.
 */
const SETTLED_HISTORY =
  ('早前这个会话已经处理过一轮：把 server 里的超时改成三十秒，并且在返回之前先刷新一次缓存。' +
    '那一轮已经用 session_send 转交给 Claude Code，并收到了完成回执。'.repeat(12)).slice(0, 1100);

/** The next segment — the one whose forward result this stage records. */
const NEXT_SEGMENT = '现在把超时改回六十秒，并且加上一个重试上限。';

/** The assistant acknowledgement the relay writes after a forward lands. */
const ASSISTANT_OK = 'OK';

/** A `{type, text}` pair for a role: the endpoint wants `input_text` for user, `text` for assistant. */
function messageItem(role: 'user' | 'assistant', text: string): Record<string, unknown> {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'text', text }],
  };
}

/** The endpoint's refusal text for an `error` frame, however it nests it. */
function errorTextOf(wire: Record<string, unknown>): string {
  const error = (wire.error ?? {}) as Record<string, unknown>;
  for (const key of ['message', 'msg', 'code', 'type']) {
    if (typeof error[key] === 'string') return error[key] as string;
  }
  return JSON.stringify(wire.error ?? wire).slice(0, 300);
}

/** The first received frame of one type at or after `fromIndex`, with its index; `null` if none. */
function firstFrame(
  events: readonly ProbeEvent[],
  type: string,
  fromIndex: number,
): { index: number; wire: Record<string, unknown> } | null {
  for (let index = fromIndex; index < events.length; index += 1) {
    const event = events[index] as ProbeEvent;
    if (event.direction === 'received' && event.wire.type === type) return { index, wire: event.wire };
  }
  return null;
}

/** `usage.input_tokens` from a `response.done` frame, or `null` when the frame carried no usage. */
function inputTokensOf(wire: Record<string, unknown> | null): number | null {
  if (wire === null) return null;
  const response = (wire.response ?? {}) as Record<string, unknown>;
  const usage = (response.usage ?? {}) as Record<string, unknown>;
  return typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
}

/** The usage object of a `response.done` frame, verbatim — the record keeps the endpoint's own bytes. */
function usageOf(wire: Record<string, unknown> | null): unknown {
  if (wire === null) return null;
  const response = (wire.response ?? {}) as Record<string, unknown>;
  return response.usage ?? null;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });
  const events: ProbeEvent[] = [];
  const session: P0Session = await openSession({
    run,
    label: 's5-history-control',
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody({ turn_detection: null }),
    executor: { session_send: (args) => ({ queued: true, message: args.message ?? null }) },
    respondToToolOutputs: false,
    onEvent: (event) => events.push(event),
  });

  const warm = await session.waitFor(() => session.updatedMs !== null, 20_000);
  if (!warm) throw new Error('S5: the session never became usable (no session.updated)');

  // a. the settled history, whose item id is what the delete will name.
  const historyFrom = events.length;
  session.sendRaw({ type: 'conversation.item.create', item: messageItem('user', SETTLED_HISTORY) });
  const historyCreated = await session.waitFor(() => firstFrame(events, 'conversation.item.created', historyFrom) !== null, 15_000);
  const historyItem = firstFrame(events, 'conversation.item.created', historyFrom);
  const historyItemId = typeof historyItem?.wire.item === 'object' && historyItem?.wire.item !== null
    ? ((historyItem.wire.item as Record<string, unknown>).id as string | undefined) ?? null
    : null;
  await sleep(250);

  // b. the assistant OK item, inserted while the settled history is still present.
  const okFrom = events.length;
  session.sendRaw({ type: 'conversation.item.create', item: messageItem('assistant', ASSISTANT_OK) });
  const okCreated = await session.waitFor(() => firstFrame(events, 'conversation.item.created', okFrom) !== null, 15_000);
  const okFrame = firstFrame(events, 'conversation.item.created', okFrom);
  const okItemId = typeof okFrame?.wire.item === 'object' && okFrame?.wire.item !== null
    ? ((okFrame.wire.item as Record<string, unknown>).id as string | undefined) ?? null
    : null;
  await sleep(250);

  // c. the next segment, then the response that should forward it.
  const beforeFrom = events.length;
  session.sendRaw({ type: 'conversation.item.create', item: messageItem('user', NEXT_SEGMENT) });
  await sleep(250);
  session.sendRaw({ type: 'response.create' });
  const beforeDone = await session.waitFor(
    () => session.responses.length >= 1 || session.errors.length > 0,
    RESPONSE_WINDOW_MS,
  );
  await sleep(500);
  const beforeFrame = firstFrame(events, 'response.done', beforeFrom);
  const forwardCalls = sessionSendFrames(events.slice(beforeFrom, firstFrame(events, 'response.done', beforeFrom)?.index ?? events.length));

  // d. delete the settled history, then one more response to read input_tokens after it.
  const deleteFrom = events.length;
  session.sendRaw({ type: 'conversation.item.delete', item_id: historyItemId ?? 'item_nonexistent_s5' });
  const deleteSettled = await session.waitFor(
    () =>
      firstFrame(events, 'conversation.item.deleted', deleteFrom) !== null ||
      firstFrame(events, 'error', deleteFrom) !== null,
    15_000,
  );
  await sleep(250);
  const deletedFrame = firstFrame(events, 'conversation.item.deleted', deleteFrom);
  const deleteErrorFrame = firstFrame(events, 'error', deleteFrom);
  const deleteAccepted = deletedFrame !== null;
  const deleteErrorText = deleteErrorFrame === null ? null : errorTextOf(deleteErrorFrame.wire);
  const deletedItemId = deletedFrame === null
    ? null
    : typeof deletedFrame.wire.item_id === 'string'
      ? (deletedFrame.wire.item_id as string)
      : typeof deletedFrame.wire.item === 'object' && deletedFrame.wire.item !== null
        ? (((deletedFrame.wire.item as Record<string, unknown>).id as string | undefined) ?? null)
        : null;

  const afterFrom = events.length;
  session.sendRaw({ type: 'response.create' });
  const afterDone = await session.waitFor(
    () => session.responses.length >= 2 || session.errors.length > 0,
    RESPONSE_WINDOW_MS,
  );
  await sleep(500);
  const afterFrame = firstFrame(events, 'response.done', afterFrom);

  // ── readings, all from the frames ────────────────────────────────────────────────────────────
  const assistantItemAccepted = okCreated;
  const nextSegmentForwarded = forwardCalls.length >= 1;
  const inputTokensBefore = inputTokensOf(beforeFrame?.wire ?? null);
  const inputTokensAfter = inputTokensOf(afterFrame?.wire ?? null);
  const deleteDroppedTokens =
    inputTokensBefore !== null && inputTokensAfter !== null && inputTokensAfter < inputTokensBefore;

  // Exactly the keys `scripts/voice-realtime-p0-record-check.mjs` re-derives from the frames below.
  const evidence = {
    historyItemCreated: historyCreated,
    assistantItemAccepted,
    nextSegmentForwarded,
    nextSegmentCallCount: forwardCalls.length,
    deleteAccepted,
    deleteDroppedTokens,
    inputTokensBefore,
    inputTokensAfter,
    errorFrames: countSessionErrors(events, session.errors),
  };

  const verdict = !assistantItemAccepted || !deleteAccepted
    ? 'unsupported'
    : deleteDroppedTokens
      ? 'supported'
      : 'inconclusive';

  const trace = {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S5',
    stageTitle: '会话控制（助手 OK 条目插入、下一段转发、conversation.item.delete 与 input_tokens 前/后）',
    question:
      '中继能否向上游会话插入一条助手 `OK` 条目？`conversation.item.delete` 是被接受还是被拒绝，接受之后 input_tokens 是否真的下降？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    instructionsChars: VOICE_REALTIME_INSTRUCTIONS.length,
    tool: SESSION_SEND_TOOL.name,
    settledHistoryChars: SETTLED_HISTORY.length,
    nextSegmentChars: NEXT_SEGMENT.length,
    history: {
      request: { type: 'conversation.item.create', role: 'user', content: 'input_text', chars: SETTLED_HISTORY.length },
      created: historyCreated,
      itemId: historyItemId,
    },
    assistantItem: {
      request: { type: 'conversation.item.create', role: 'assistant', content: 'text', text: ASSISTANT_OK },
      created: assistantItemAccepted,
      itemId: okItemId,
    },
    forward: {
      segment: 'next',
      responded: beforeDone,
      responseDone: beforeFrame !== null,
      callCount: forwardCalls.length,
      calls: forwardCalls,
      forwarded: nextSegmentForwarded,
    },
    del: {
      request: { type: 'conversation.item.delete', item_id: historyItemId ?? 'item_nonexistent_s5' },
      responded: deleteSettled,
      accepted: deleteAccepted,
      responseType: deleteAccepted ? 'conversation.item.deleted' : deleteErrorFrame === null ? null : 'error',
      responseItemId: deletedItemId,
      errorText: deleteErrorText,
    },
    tokens: {
      before: { responded: beforeDone, inputTokens: inputTokensBefore, usage: usageOf(beforeFrame?.wire ?? null) },
      after: { responded: afterDone, inputTokens: inputTokensAfter, usage: usageOf(afterFrame?.wire ?? null) },
      dropped: deleteDroppedTokens,
    },
    exchange: summarizeExchange(events),
    // The RAW frames, kept so `scripts/voice-realtime-p0-record-check.mjs` can re-derive every
    // reading above instead of trusting the summary — including the split at the SENT
    // `conversation.item.delete` that separates the before/after token windows.
    events,
    errors: session.errors,
    evidence,
    verdict,
    spendCny: run.spendCny,
    budgetCny: BUDGET_CNY,
    guardTriggered: run.guardTriggered,
    notes: '',
  };

  trace.notes =
    `assistantOK accepted=${assistantItemAccepted} | nextSegment forwarded=${nextSegmentForwarded} (calls=${forwardCalls.length}) | ` +
    `delete accepted=${deleteAccepted}${deleteErrorText === null ? '' : ` error="${deleteErrorText}"`} | ` +
    `input_tokens ${inputTokensBefore}→${inputTokensAfter} dropped=${deleteDroppedTokens} | ` +
    `spend=¥${run.spendCny.toFixed(6)}`;

  const written = writeTrace('s5-history-control.json', trace, apiKey);
  console.log(`S5 verdict=${verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  console.log(`  ${trace.notes}`);
  console.log(`  ${written.file} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  await session.close();
  process.exit(0);
}

main().catch((error) => {
  console.error('S5 probe failed:', error);
  process.exit(1);
});
