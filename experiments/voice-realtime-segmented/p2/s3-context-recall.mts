/**
 * P2 — the DoD's real-upstream check for AC-320's ContextPack: with a pack in `instructions`, does
 * the relay's RENDERING of an utterance that points at the pack carry the fact the pack holds?
 *
 * THE QUESTION THE DoD ASKS. `tasks/gap-voice-realtime-context-pack-and-hot-settings.md`:
 * 「用 P0a 的 S3 脚本在真实上游上跑一次（预算 ≤ ¥0.02）：包里放一条能区分「看过上下文」的事实，问一句
 * 依赖它的话，报告里模型的转述体现了该事实；结果落到 …/p2/RESULT.json。」 S3 answered "does the
 * relay still forward at all, once a pack is in the prompt" (it does, 12/12). This stage asks the
 * next thing: is the pack READ — does an utterance whose referent lives only in the pack come out
 * the far side carrying it?
 *
 * WHY THE FACT IS A REFERENT AND NOT A TRIVIA ANSWER. The shipped relay prompt is explicit: "You
 * never answer, comment or reason yourself, and you never reply in text. EVERYTHING the user says …
 * must be passed on by calling the `session_send` function." A relay that OBEYS that cannot answer
 * a question from the pack. What it can do — and what the pack exists to enable, per
 * `src/modules/chat/utils/voiceContextPack.ts`'s own header ("a turn like 「把那个改成三十秒」 reached
 * Claude with no referent") — is RENDER a deictic turn into a self-contained one.
 *
 * WHY THE UTTERANCE NAMES NO REFERENT. The DoD asks for 「一句依赖它【上下文】的话」, and an utterance
 * that already says WHICH timeout is being asked about does not depend on the pack — the downstream
 * Claude Code session can answer it on its own, so the relay never has a reason to look anything up.
 * So the utterance below says 「那条改动的超时」 and nothing more: its referent lives only in the pack,
 * and a relay that read the pack can only forward it by naming that referent (which drags the fact's
 * value along with it). The control leg is what makes it a reading instead of a claim: the SAME
 * utterance on a session with NO pack cannot produce the token by any route.
 *
 * WHAT IS SENT. Three fresh sessions, one user turn and one response each:
 *   1. with-pack           the SHIPPED composition (`loadVoiceRealtimeSettings` + `composeVoiceRealtimeInstructions`,
 *                          the exact pair `voice-realtime-ws-proxy.service.ts` calls) over the pack;
 *   2. control-no-pack     the same composition with an empty pack — byte-identical to the base prompt;
 *   3. diagnostic          the same pack, the one relay sentence replaced by one that permits answering.
 * Legs 1–2 are the verdict. Leg 3 is never an input to it: it exists so an `unsupported` verdict can
 * say WHETHER the pack was unusable or merely suppressed by the "never answer" rule, which is the
 * observation 「若表现不佳只记录观察」 asks for.
 *
 * WHAT IS READ, per leg, off the FRAMES (never off the executor — see `sessionSendFrames`):
 *   forwardedMessages  every `session_send` message the model asked to deliver
 *   modelText          every text fragment the endpoint sent back, whichever dialect it used
 *   produced           the union of the two — what the model actually emitted for this turn
 *   factReflected      does `produced` carry a token that only the pack could supply
 *   priorReflected     does it carry the token's PREVIOUS value (a wrong guess, still "read it")
 *
 * VERDICT, derived here and re-derivable from the file:
 *   supported             the pack leg carried the fact and the control leg did not
 *   control-contaminated  BOTH legs carried it, so the token is guessable and proves nothing
 *   unsupported           the run completed and the pack leg did not carry the fact
 *   inconclusive          no response completed at all (upstream refused / network)
 *
 * The DoD anticipates the third outcome explicitly — 「如何使用上下文不做约束，若表现不佳只记录观察，不在
 * 本任务里追加规则」 — so an `unsupported` verdict is RECORDED and not repaired: this file writes no
 * new prompt rule, it reports what the live model did with the one that ships.
 *
 * Run (from the repo root, on a machine with egress and a live key — `--tsconfig server/tsconfig.json`
 * is REQUIRED, exactly as `scripts/voice-realtime-p0-record-check.test.mjs` spawns the p0 probes: the
 * server modules import through the backend's `@/*` alias, which only that config maps):
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p2/s3-context-recall.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/index.js';
import {
  composeVoiceRealtimeInstructions,
  loadVoiceRealtimeSettings,
} from '../../../server/modules/voice-realtime/voice-realtime-settings.js';

import {
  P0_DIR,
  SESSION_SEND_TOOL,
  countSessionErrors,
  createRun,
  openSession,
  readApiKey,
  scrubSecrets,
  sessionBody,
  sessionSendFrames,
  sleep,
  summarizeExchange,
  type P0Session,
  type ProbeEvent,
} from '../p0/probe-lib.mts';

/** The DoD's ceiling. Two single-turn sessions price far below it; the guard is what makes it a ceiling. */
const BUDGET_CNY = 0.02;
const RESPONSE_WINDOW_MS = 45_000;

/** `…/p2/` — beside the probe, as the DoD names it. */
const P2_DIR = path.join(path.dirname(P0_DIR), 'p2');
const RESULT_FILE = path.join(P2_DIR, 'RESULT.json');

/**
 * The pack, rendered the way `buildVoiceContextPack` renders one: `角色：文本` lines, oldest first,
 * newest last, each row's text verbatim from the session. Hand-written here rather than built from
 * a transcript for the same reason S3 reads a frozen fixture — the fact has to be OURS to choose,
 * and the builder's own rules are already covered by that module's suites.
 *
 * The distinguishing fact is the SECOND row: the timeout's new value. Nothing else in the pack
 * states it, and no row implies it.
 */
const PACK_ROWS: ReadonlyArray<{ role: '用户' | '助手'; minutesAgo: number; text: string }> = [
  { role: '用户', minutesAgo: 4, text: '语音转写的静音超时太短了，经常我还没说完就断了。' },
  { role: '助手', minutesAgo: 3, text: '我把 `voice-realtime` 的静音超时从十五秒改成了五十秒。' },
  { role: '用户', minutesAgo: 2, text: '好，先这样。' },
  { role: '助手', minutesAgo: 1, text: '还有一个待办：Mute 的时候不要关掉连接。' },
];

/** The fact the pack carries, as the tokens a paraphrase of it would have to contain. */
const FACT_TOKENS: readonly string[] = ['五十', '50'];
/** The value the fact REPLACED — a leg that guessed instead of read would surface this one. */
const PRIOR_TOKENS: readonly string[] = ['十五', '15'];

/**
 * The utterance: a question whose REFERENT lives only in the pack. It names no file, no subsystem
 * and no value — 「那条改动的超时」 is resolvable from the pack's second row and from nowhere else — so
 * a forward that carries the answer can only have been rendered out of the pack.
 */
const UTTERANCE = '我们刚才那条改动，超时现在到底是多少秒？把这个数直接发给会话。';

/** The pack text the browser would have sent in a `context` frame. */
function renderPack(): string {
  return PACK_ROWS.map((row) => `${row.role}（${row.minutesAgo} 分钟前）：${row.text}`).join('\n');
}

/**
 * The shipped reading, read the way the server reads it. `settingsPath: undefined` makes the probe
 * ignore any `VOICE_REALTIME_SETTINGS_PATH` in the environment, so the run reports the SHIPPED
 * prompt rather than whatever a deployment happens to have pointed the variable at.
 */
function shippedSettings(): ReturnType<typeof loadVoiceRealtimeSettings> {
  const settings = loadVoiceRealtimeSettings({ baseInstructions: VOICE_REALTIME_INSTRUCTIONS, settingsPath: undefined });
  if (settings.problems.length > 0) {
    // The defaults are what the settings hold when a file is refused, so a problem here still
    // composes; naming it keeps a surprising environment from looking like a designed reading.
    console.error(`settings problems (falling back to the defaults): ${settings.problems.join('; ')}`);
  }
  return settings;
}

/** The `instructions` a connection is opened with — the SHIPPED composition, not a copy of it. */
function instructionsFor(contextText: string): string {
  return composeVoiceRealtimeInstructions(shippedSettings(), contextText);
}

/**
 * The DIAGNOSTIC composition: the same pack, under a prompt that does not forbid answering.
 *
 * WHAT IT IS FOR. The shipped relay prompt instructs the model to never answer and never reply in
 * text. That rule makes an `unsupported` verdict ambiguous on its own — it cannot separate "the pack
 * is not usable" from "the pack is fine and the rule is what stops it being used". This leg removes
 * only the rule and changes nothing else, so the two readings together say WHICH of the two happened.
 *
 * It is NEVER an input to the verdict: the verdict is about what ships. The DoD licenses the leg —
 * 「如何使用上下文不做约束，若表现不佳只记录观察」 — and the observation it produces is the point.
 */
function answerAllowedInstructions(contextText: string): string {
  const settings = shippedSettings();
  return composeVoiceRealtimeInstructions(
    { ...settings, instructions: '你是这个 Claude Code 会话的语音助手，可以直接回答用户关于会话内容的问题。' },
    contextText,
  );
}

/**
 * Every text fragment the endpoint sent back for one leg, across the dialects it uses.
 *
 * `response.function_call_arguments.*` is deliberately EXCLUDED: its `delta` is a fragment of the
 * `session_send` call's JSON, which `sessionSendFrames` already reads as a message. Counting it here
 * too would put the forwarded text into "what the model said" a second time — and, worse, would let a
 * token that only ever appeared as a tool ARGUMENT masquerade as spoken text.
 */
function collectModelText(events: readonly ProbeEvent[]): string[] {
  const found: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') found.push(value);
  };
  const harvestContent = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (typeof part === 'object' && part !== null) push((part as Record<string, unknown>).text);
    }
  };
  for (const event of events) {
    if (event.direction !== 'received') continue;
    const wire = event.wire;
    const type = String(wire.type ?? '');
    if (!type.startsWith('response.') || type.startsWith('response.function_call_arguments')) continue;
    push(wire.delta);
    push(wire.text);
    push(wire.transcript);
    const item = wire.item as Record<string, unknown> | undefined;
    if (item) harvestContent(item.content);
    const response = wire.response as Record<string, unknown> | undefined;
    if (response && Array.isArray(response.output)) {
      for (const output of response.output) {
        if (typeof output === 'object' && output !== null) {
          harvestContent((output as Record<string, unknown>).content);
        }
      }
    }
  }
  return found;
}

const carriesAny = (text: string, tokens: readonly string[]): boolean => tokens.some((token) => text.includes(token));

type LegRecord = {
  id: string;
  /** Which relay rules the leg was opened under — the shipped ones, or the diagnostic's. */
  relayRules: 'shipped' | 'answer-allowed';
  withPack: boolean;
  sessionId: string | null;
  instructionsChars: number;
  completed: boolean;
  responseId: string | null;
  status: string | null;
  forwarded: boolean;
  forwardedMessages: string[];
  produced: string;
  modelTextChars: number;
  factReflected: boolean;
  priorReflected: boolean;
  inputTokens: number | null;
  spendCny: number;
  timedOut: boolean;
  errorFrames: number;
  exchange: ReturnType<typeof summarizeExchange>;
};

async function runLeg(
  run: ReturnType<typeof createRun>,
  leg: { id: string; relayRules: LegRecord['relayRules']; withPack: boolean; instructions: string },
): Promise<LegRecord> {
  const { id, instructions } = leg;
  const events: ProbeEvent[] = [];
  const session: P0Session = await openSession({
    run,
    label: id,
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
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: UTTERANCE }] },
    });
    session.sendRaw({ type: 'response.create' });
    const answered = await session.waitFor(
      () => session.responses.length > 0 || session.errors.length > 0,
      RESPONSE_WINDOW_MS,
    );
    timedOut = !answered;
  }
  // The endpoint sometimes trails its last text frame behind `response.done`; the window is short
  // and this run has exactly one turn, so waiting a beat is cheaper than an under-read.
  await sleep(1_000);

  const sends = sessionSendFrames(events);
  const forwardedMessages = sends
    .map((send) => send.message)
    .filter((message): message is string => message !== null);
  const modelText = collectModelText(events);
  const produced = [...forwardedMessages, ...modelText].join('\n');
  const response = session.responses[0] ?? null;
  const usage = (response?.usage ?? null) as Record<string, unknown> | null;

  const record: LegRecord = {
    id,
    relayRules: leg.relayRules,
    withPack: leg.withPack,
    sessionId: session.sessionId,
    instructionsChars: instructions.length,
    completed: response !== null,
    responseId: response?.id ?? null,
    status: response?.status ?? null,
    forwarded: sends.length > 0,
    forwardedMessages,
    produced,
    modelTextChars: modelText.join('').length,
    factReflected: carriesAny(produced, FACT_TOKENS),
    priorReflected: carriesAny(produced, PRIOR_TOKENS),
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : null,
    spendCny: session.spendCny,
    timedOut: timedOut && session.responses.length === 0,
    errorFrames: countSessionErrors(events, session.errors),
    exchange: summarizeExchange(events),
  };
  await session.close();
  console.log(
    `  ${id}: completed=${record.completed} forwarded=${record.forwarded} ` +
      `fact=${record.factReflected} prior=${record.priorReflected} chars=${record.instructionsChars}`,
  );
  return record;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const pack = renderPack();
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });

  console.log(`P2 context-recall: budget=¥${BUDGET_CNY} pack=${pack.length} chars`);
  const withPack = await runLeg(run, {
    id: 'with-pack',
    relayRules: 'shipped',
    withPack: true,
    instructions: instructionsFor(pack),
  });
  const control = await runLeg(run, {
    id: 'control-no-pack',
    relayRules: 'shipped',
    withPack: false,
    instructions: instructionsFor(''),
  });
  const diagnostic = await runLeg(run, {
    id: 'diagnostic-answer-allowed',
    relayRules: 'answer-allowed',
    withPack: true,
    instructions: answerAllowedInstructions(pack),
  });

  // The verdict's inputs are the two SHIPPED legs only; the diagnostic leg is read separately below.
  const legs = [withPack, control];
  const completed = legs.filter((leg) => leg.completed);

  const verdict =
    completed.length === 0
      ? 'inconclusive'
      : withPack.factReflected && control.factReflected
        ? 'control-contaminated'
        : withPack.factReflected
          ? 'supported'
          : 'unsupported';

  // The observation the DoD asks for when the live model does not use the pack the way the design
  // hoped. Written from the legs' own text, never from a re-reading of them by hand.
  const observations: string[] = [];
  if (verdict === 'supported') {
    observations.push(
      `带上上下文包的一腿把事实带过了河：转发的消息里含 ${FACT_TOKENS.join('/')}；无包的一腿没有，` +
        `所以这个 token 只可能来自包。`,
    );
  } else if (verdict === 'unsupported') {
    observations.push(
      `带包的一腿完成了，但转出的内容里没有 ${FACT_TOKENS.join('/')}：模型把这句话原样转发了（转述并未落定指代），` +
        `而不是用包里的指代把它说完整。按 DoD「若表现不佳只记录观察」，这里只记录，不在本任务里追加任何提示词规则。`,
    );
    if (control.priorReflected || withPack.priorReflected) {
      observations.push(`有一腿出现了旧值 ${PRIOR_TOKENS.join('/')} —— 那同样是「读过包」的信号，但不是本次要测的事实。`);
    }
  } else if (verdict === 'control-contaminated') {
    observations.push(
      `两腿都出现了 ${FACT_TOKENS.join('/')}，所以这个 token 可以被猜中，本轮的「看过上下文」读不出来（证据无效）。`,
    );
  } else {
    observations.push('没有任何一条响应完成，上游没有给出可读的转述；本轮的判据无法判定。');
  }
  // The pack's PRESENCE in the prompt is a separate, cheaper reading than its USE: `input_tokens` is
  // the `response.done` frame's own count of what the session actually read in. When the two legs
  // differ by the pack, the pack reached the model — which is what keeps an `unsupported` verdict
  // above from being confused with "the frame never arrived".
  const tokenDelta =
    withPack.inputTokens !== null && control.inputTokens !== null
      ? withPack.inputTokens - control.inputTokens
      : null;
  if (verdict === 'unsupported' && tokenDelta !== null) {
    observations.push(
      `包确实进了 prompt：带包一腿 input_tokens=${withPack.inputTokens}，无包一腿 ${control.inputTokens}，` +
        `差 ${tokenDelta} —— 读进了上下文，只是转发时没用它。`,
    );
  }
  // The diagnostic leg is what separates the two ways an `unsupported` verdict can come about. It is
  // reported either way, never used to edit the verdict and never turned into a shipped rule.
  if (verdict === 'unsupported' && diagnostic.completed) {
    observations.push(
      diagnostic.factReflected
        ? `把「只转发、不许回答」这条规则换成允许回答（其余不变）后，同一句话就带出了 ` +
            `${FACT_TOKENS.join('/')}（"${diagnostic.forwardedMessages[0] ?? diagnostic.produced.slice(0, 60)}"）：` +
            `包是可读、可用的，压住它的是中继规则本身。本轮只记录，不改规则。`
        : `连允许回答的那一腿也没带出 ${FACT_TOKENS.join('/')}：这句问话模型在任何规则下都没拿包里的值来说话，` +
            `所以这不只是「只转发」规则造成的。`,
    );
  }
  const interrupted = legs.filter((leg) => leg.errorFrames > 0 || leg.timedOut);
  if (interrupted.length > 0) {
    observations.push(
      `运行期间有 ${interrupted.length} 腿报了错或超时（${interrupted.map((leg) => leg.id).join(', ')}）。`,
    );
  }
  observations.push(`上游花费 ¥${run.spendCny.toFixed(6)}（预算 ¥${BUDGET_CNY}，guard=${run.guardTriggered}）。`);

  const result = {
    schema: 'voice-realtime-p2-result/1',
    stage: 'P2',
    ac: 'AC-320',
    title: '上下文包是否被读进去：指代不明的一句问话，转出去时是否带上了包里的事实',
    question: 'instructions 里带上上下文包之后，模型转述一句依赖包里指代的话时，是否把包里的事实带出来？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    tool: SESSION_SEND_TOOL.name,
    // The composition is the SHIPPED one — these are the exact bytes the server opens a session with.
    composition: {
      settingsSource: 'default',
      packChars: pack.length,
      packRows: PACK_ROWS.length,
      withPackInstructionsChars: withPack.instructionsChars,
      controlInstructionsChars: control.instructionsChars,
      deltaChars: withPack.instructionsChars - control.instructionsChars,
    },
    pack: { rows: PACK_ROWS, text: pack },
    utterance: UTTERANCE,
    fact: { tokens: FACT_TOKENS, priorTokens: PRIOR_TOKENS, sourceRow: 1 },
    legs,
    // Not part of the verdict: the same pack under a prompt that permits answering, so the record
    // says WHY the shipped legs read the way they do. See `answerAllowedInstructions`.
    diagnosticLeg: diagnostic,
    evidence: {
      legsCompleted: completed.length,
      diagnosticFactReflected: diagnostic.factReflected,
      diagnosticForwarded: diagnostic.forwarded,
      withPackFactReflected: withPack.factReflected,
      controlFactReflected: control.factReflected,
      withPackForwarded: withPack.forwarded,
      controlForwarded: control.forwarded,
      withPackInputTokens: withPack.inputTokens,
      controlInputTokens: control.inputTokens,
      inputTokenDelta: tokenDelta,
    },
    verdict,
    observations,
    spendCny: Number(run.spendCny.toFixed(6)),
    budgetCny: BUDGET_CNY,
    guardTriggered: run.guardTriggered,
  };

  // The same scrub `writeTrace` applies, on the bytes that reach disk, and the same refusal: a
  // credential-shaped string surviving the scrub means a field started echoing the key.
  const { text, scrubbed } = scrubSecrets(`${JSON.stringify(result, null, 2)}\n`, apiKey);
  if (/sk-[A-Za-z0-9_-]{16,}/.test(text) || /Authorization/i.test(text)) {
    throw new Error('refusing to write RESULT.json: a credential-shaped string survived scrubbing');
  }
  mkdirSync(P2_DIR, { recursive: true });
  writeFileSync(RESULT_FILE, text, 'utf8');

  console.log(`P2 verdict=${verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  for (const observation of observations) console.log(`  ${observation}`);
  console.log(`  ${RESULT_FILE} (${Buffer.byteLength(text, 'utf8')} bytes, scrubbed=${scrubbed})`);
  process.exit(0);
}

main().catch((error) => {
  console.error('P2 probe failed:', error);
  process.exit(1);
});
