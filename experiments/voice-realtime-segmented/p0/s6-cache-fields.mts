/**
 * S6 — does the upstream bill tell us anything about prompt caching?
 *
 * THE QUESTION. The SPEC's cost model assumes a long, stable context pack rides in `instructions`
 * and is re-sent on every turn. If the endpoint caches that prompt prefix, the per-turn price falls
 * with no design change; if it does not, the pack is re-billed in full every turn and the cost model
 * has to be sized for that. The only place the service could say so is the `usage` object of a
 * `response.done`, so the question reduces to: after more than one response on the SAME long prefix,
 * does `usage` carry a cache-shaped field, and if so does it show a discount?
 *
 * WHY TWO RESPONSES AND NOT ONE. A cache hit is by definition a reading about the SECOND and later
 * turns on a prefix; a first response cannot distinguish "no cache field" from "not cached yet". The
 * probe therefore answers the same session twice with the long context already in its history, and
 * keeps BOTH raw `usage` objects verbatim — the record is the endpoint's own bytes, not a summary.
 *
 * WHAT IS READ:
 *   - `cacheFieldPresent` — whether ANY key in either `usage`, at any depth, is cache-shaped
 *     (`cached*`, `*cache*`). The walker records every key path it saw, so a `false` is backed by
 *     the list of fields that WERE present rather than by a guess.
 *   - `discountObserved` — whether a cache-shaped field carried a positive token count, i.e. the
 *     bill actually reflects a cache hit. A field that is present and zero is not a discount.
 *   - each response's own `estimateRealtimeCostCny`, so the trace shows the bill the shipping
 *     estimator derives from the very usage objects recorded here.
 *
 * Verdict, derived from the trace by `scripts/voice-realtime-p0-record-check.mjs`:
 *   supported     a cache-shaped field is present AND carries a positive count
 *   unsupported   no cache-shaped field anywhere in either usage object
 *   inconclusive  a cache-shaped field is present but never positive
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s6-cache-fields.mts
 */
import {
  SESSION_SEND_TOOL,
  countSessionErrors,
  createRun,
  estimateRealtimeCostCny,
  openSession,
  readApiKey,
  sessionBody,
  sleep,
  summarizeExchange,
  writeTrace,
  type P0Session,
  type ProbeEvent,
} from './probe-lib.mts';

import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/index.js';

/**
 * The stage budget. Two responses that each re-read the 2,000-character prefix: on the measured
 * per-response arithmetic (¥0.00086 fixed + ~¥0.0013 of prefix text at the endpoint's measured
 * ~0.58 tokens/char) that is ≈ ¥0.0050, and the headroom is there so a longer-than-usual reply
 * cannot trip the guard and void the run.
 */
const BUDGET_CNY = 0.006;
const RESPONSE_WINDOW_MS = 45_000;

/**
 * The long, stable prefix whose second-and-later turns are the cache question. Kept deterministic
 * so the two responses provably share it byte for byte.
 */
const STABLE_PREFIX = (
  '项目约定：后端改动只在 server/ 下，前端改动只在 src/ 下，测试从不在会话里跑完整套件。' +
  'voice-realtime 的传输层默认动作是转发，不是回答。'
)
  .repeat(40)
  .slice(0, 2000);

/** The two short turns whose responses both ride on top of {@link STABLE_PREFIX}. */
const TURN_ONE = '把 server 里的超时改成三十秒。';
const TURN_TWO = '再顺手确认一下缓存开关是打开的。';

/** A cache-shaped key, by the only rule that can be applied without knowing the schema. */
const CACHE_KEY = /cache/i;

/** Every `a.b.c` key path under `value`, with the scalar it reached. Arrays are walked by index. */
function walkKeys(value: unknown, prefix: string, into: Array<{ path: string; value: unknown }>): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      into.push({ path, value: child });
      walkKeys(child, path, into);
    } else if (Array.isArray(child)) {
      into.push({ path, value: child });
      child.forEach((entry, index) => walkKeys(entry, `${path}[${index}]`, into));
    } else {
      into.push({ path, value: child });
    }
  }
}

/** `usage.input_tokens` / `output_tokens`, or `null`, for the cost-per-turn arithmetic. */
function numberField(usage: unknown, key: string): number | null {
  if (usage === null || typeof usage !== 'object') return null;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });
  const events: ProbeEvent[] = [];
  const session: P0Session = await openSession({
    run,
    label: 's6-cache-fields',
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody({ turn_detection: null }),
    executor: { session_send: (args) => ({ queued: true, message: args.message ?? null }) },
    respondToToolOutputs: false,
    onEvent: (event) => events.push(event),
  });

  const warm = await session.waitFor(() => session.updatedMs !== null, 20_000);
  if (!warm) throw new Error('S6: the session never became usable (no session.updated)');

  // The stable prefix, sent once and never repeated — both responses below must read it in full.
  session.sendRaw({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: STABLE_PREFIX }] },
  });
  await sleep(400);

  const turns: Array<{ label: string; text: string; usage: unknown; spendCny: number }> = [];
  for (const [index, turn] of [TURN_ONE, TURN_TWO].entries()) {
    const before = session.responses.length;
    session.sendRaw({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn }] },
    });
    await sleep(200);
    session.sendRaw({ type: 'response.create' });
    const answered = await session.waitFor(
      () => session.responses.length > before || session.errors.length > 0,
      RESPONSE_WINDOW_MS,
    );
    await sleep(400);
    const response = session.responses[session.responses.length - 1];
    turns.push({
      label: `turn${index + 1}`,
      text: turn,
      usage: response?.usage ?? null,
      spendCny: response?.spendCny ?? 0,
    });
    if (!answered) break;
  }

  // ── the cache reading, from the recorded usage objects themselves ────────────────────────────
  const keyPaths = turns.flatMap((turn) => {
    const into: Array<{ path: string; value: unknown }> = [];
    walkKeys(turn.usage, '', into);
    return into.map((entry) => ({ turn: turn.label, ...entry }));
  });
  const cachePaths = keyPaths.filter((entry) => CACHE_KEY.test(entry.path));
  const positiveCacheValue = (value: unknown): boolean => {
    if (typeof value === 'number') return value > 0;
    if (Array.isArray(value)) return value.some(positiveCacheValue);
    if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(positiveCacheValue);
    return false;
  };
  const cacheFieldPresent = cachePaths.length > 0;
  const discountObserved = cachePaths.some((entry) => positiveCacheValue(entry.value));

  const evidence = {
    responsesSeen: turns.length,
    cacheFieldPresent,
    discountObserved,
    cacheKeys: [...new Set(cachePaths.map((entry) => entry.path))],
    inputTokens: turns.map((turn) => numberField(turn.usage, 'input_tokens')),
    outputTokens: turns.map((turn) => numberField(turn.usage, 'output_tokens')),
    spendPerTurnCny: turns.map((turn) => turn.spendCny),
    errorFrames: countSessionErrors(events, session.errors),
  };

  const verdict = cacheFieldPresent
    ? discountObserved
      ? 'supported'
      : 'inconclusive'
    : 'unsupported';

  const trace = {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S6',
    stageTitle: '用量里的缓存字段（两次响应在同一段长前缀上，是否出现 cache 字段与折扣）',
    question: '同一段长稳定前缀上跑两次响应后，`usage` 里是否出现缓存类字段，出现时是否体现为折扣？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    instructionsChars: VOICE_REALTIME_INSTRUCTIONS.length,
    tool: SESSION_SEND_TOOL.name,
    stablePrefixChars: STABLE_PREFIX.length,
    turns,
    usageKeyPaths: keyPaths,
    cacheKeys: evidence.cacheKeys,
    // The RAW frames, kept so `scripts/voice-realtime-p0-record-check.mjs` can pull both
    // `response.done` usage objects out of the wire and re-walk them for cache-shaped keys itself.
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
    `responses=${turns.length} cacheFieldPresent=${cacheFieldPresent} discountObserved=${discountObserved} | ` +
    `cacheKeys=[${evidence.cacheKeys.join(', ')}] | ` +
    `input_tokens=[${evidence.inputTokens.join(', ')}] spend/turn=[${evidence.spendPerTurnCny.map((cny) => `¥${cny.toFixed(6)}`).join(', ')}] | ` +
    `spend=¥${run.spendCny.toFixed(6)}`;

  // The shipping estimator, re-run here from the SAME usage objects, so the trace states the bill
  // its own reader will independently derive.
  trace.notes += ` | estimator=${turns.map((turn) => `¥${estimateRealtimeCostCny(turn.usage).toFixed(6)}`).join(', ')}`;

  const written = writeTrace('s6-cache-fields.json', trace, apiKey);
  console.log(`S6 verdict=${verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  console.log(`  ${trace.notes}`);
  console.log(`  ${written.file} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  await session.close();
  process.exit(0);
}

main().catch((error) => {
  console.error('S6 probe failed:', error);
  process.exit(1);
});
