#!/usr/bin/env node
/**
 * Voice-realtime 歧义 / world-model：**真实音频、真实模型、同一次运行**上的 paired 对比（一份读数，不是闸）。
 *
 * 现场。GOAL-029/AC-306 已经冻结了四类场景的语料、标准答案、打分口径与负对照
 * （`PREREG.md` + `fixtures/`，**只读**），并由 `run.mjs` 在一次**离线确定性**读数里量到了「两条通路的
 * 结构差」：Arm A 结构上没有工具/上下文通道，Arm B 有。那份读数明确**不**宣称真实模型的优势——
 * 「替身在拿到证据后是完美读者」。本文件就是那条 `--live` 的路：同一段**真实音频**分别喂给
 *
 *   Arm A  ASR→文本基线：`shared/asr/asrRegistry.ts#resolve('dashscope-omni')` →
 *          `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe`，
 *          `fetchImpl` 就是全局 `fetch`（真实 DashScope `compatible-mode` 端点，联网 + 凭据 + 花钱）。
 *          这条臂的通道里没有工具、没有 UI 上下文（`capabilities.honors.context === false`，从出货声明读出）。
 *   Arm B  真实 Realtime：AC-308 落地的 `createDashscopeTransport`（`qwen3.8-omni-flash-realtime`，
 *          `voice: "Tina"`，`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`）驱动出货 bridge
 *          `connect()`；模型**自主**对 `REALTIME_TOOLS` 的只读工具发起 function_call，executor 回填
 *          GOAL-029 冻结的**夹具数据**（不是真的 `ChatControlService`）。
 *
 * 每条语料重复 `--reps`（默认 3）次，取基本离散度。**同一次运行**：全部读数带同一个 run id。
 *
 * 打分**复用** GOAL-029 冻结的口径（`run.mjs` 导出的 `scoreEntry` / `applyBias` / `readControl` /
 * `controlVerdict` / `printControls` / `straddle` / `assertSingleRun` / `DISCLAIMER`），一行都不改。
 * 真实输出 → `decision` 的映射由本文件里一个**声明的机械读取器**给出（`readDecision`）：机器只做
 * 子串/结构性子检查，**语义等价那一半是人读**（记录里逐条贴出模型的原始输出供复核）。
 *
 * 约定（沿用 `experiments/voice-dashscope-omni-paired-quality/run.mjs` 与 ADR-004 决策 8）：
 *   node .../run-real.mjs               # 默认：读冻结快照 `fixtures/real-paired.json` 离线重算，退出 0
 *   node .../run-real.mjs --live        # 真实付费取数（联网 + 凭据），落 `out/real-paired-cache.json`
 *   node .../run-real.mjs --live --fresh# 忽略旧缓存，从零取数
 *   node .../run-real.mjs --freeze      # 把缓存冻成 `fixtures/real-paired.json`
 *   node .../run-real.mjs --probe       # 只打印所驱动的出货模块
 *
 * 自检用的变异（都应当**非零退出**）：
 *   --corpus=empty     语料为空（n=0，空读数不是绿读数）
 *   --control=inverted 至少一条负对照朝预测的反方向移动
 *   --runs=straddle    一条读数被挪到另一个 run id（配对跨运行）
 *
 * AC7：若任一语料条目的 ≥3 次重复在**延迟与模型输出**上完全同质（零方差），runner 标记
 * `SUSPECTED_STAND_IN`——一个真实端点不产生字节相同的读数，出现即怀疑这条读数不是真的。
 *
 * 本文件的末行与它输出的末行是同一句话（`DISCLAIMER`），两种读法都满足 AC9。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';
import { WebSocket } from 'ws';

// tsx 的 register 必须先跑：出货适配器/出货 bridge 内部按 `.js` 拼 specifier 引用兄弟模块（tsx 把它们
// 映到 .ts），而 `register()` 对**静态** import 已经太晚——所以对 .ts 一律用动态 import。
register();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURES_DIR = join(HERE, 'fixtures');
const AUDIO_DIR = join(FIXTURES_DIR, 'audio');
const OUT_DIR = join(HERE, 'out');
const CACHE_PATH = join(OUT_DIR, 'real-paired-cache.json');
const FROZEN_PATH = join(FIXTURES_DIR, 'real-paired.json');

/** 本次读数的运行 id。两条臂、每一条读数都带它——配对不跨运行。 */
const RUN_ID = 'run-voice-realtime-paired-live-1';
/** `--runs=straddle` 变异体把一条读数挪到的另一个 run id。 */
const STRADDLE_RUN_ID = '1970-01-01T00:00:00.000Z';

const DEFAULT_REPS = 3;
const ASR_TIMEOUT_MS = 60_000;
/** One realtime session's whole budget (connect + audio + tool round-trip + answer). */
const SESSION_TIMEOUT_MS = 45_000;
/** Quiet time after the last wire event before a session counts as settled. */
const SETTLE_MS = 1_600;

const DISCLAIMER = 'quality numbers are a reading and are NOT a criterion';

const MODULE_PATHS = {
  registry: fileURLToPath(new URL('../../shared/asr/asrRegistry.ts', import.meta.url)),
  baseline: fileURLToPath(
    new URL('../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts', import.meta.url),
  ),
  bridgeBarrel: fileURLToPath(new URL('../../server/modules/voice-realtime/index.ts', import.meta.url)),
  bridge: fileURLToPath(
    new URL('../../server/modules/voice-realtime/voice-realtime-bridge.service.ts', import.meta.url),
  ),
  transport: fileURLToPath(
    new URL('../../server/modules/voice-realtime/voice-realtime-dashscope-transport.ts', import.meta.url),
  ),
};
const REGISTRY_SPECIFIER = pathToFileURL(MODULE_PATHS.registry).href;
const BRIDGE_SPECIFIER = pathToFileURL(MODULE_PATHS.bridgeBarrel).href;

const pad = (value, width) => String(value).padEnd(width);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

// ===========================================================================
// 冻结口径（GOAL-029/AC-306）——**只读**，通过 run.mjs 的导出复用，一行都不改
// ===========================================================================

const frozen = await import(pathToFileURL(join(HERE, 'run.mjs')).href);
const {
  loadCorpus,
  corpusFailures,
  assertExpectationsBacked,
  decide,
  scoreEntry,
  applyBias,
  readControl,
  controlVerdict,
  printControls,
  straddle,
  assertSingleRun,
  baselineCapabilities,
} = frozen;

/** 出货模块（真实的两条臂），经出货 tree 的入口解析——不是本工装里的等价物。 */
const bridgeModule = await import(BRIDGE_SPECIFIER);
const registry = await import(REGISTRY_SPECIFIER);

// ===========================================================================
// 负对照表：**逐字**照抄 GOAL-029 `run.mjs` 的冻结表（同一组 id / class / kind / bias / 方向 / 预注册
// 预测文本 / 打分用的综合 entry）。取数时与本仓 `fixtures/` 里冻结的对照 id 集合交叉校验，id 对不上即红。
//
// 口径说明（重要）：负对照被测的是**打分器 + 那个命名启发式变换**本身，GOAL-029 已经把这层冻住了。
// 所以这一层**不改**：无偏置那侧走冻结替身读取器 `decide(entry, bridgeCaps, readFixture)`，偏置那侧
// 只多一次 `applyBias`——位移是单变量的。真实音频带来的新东西在**上面 24 条语料**上（真 ASR / 真
// Realtime），不在对照层；把对照层也换成真实模型会把被测对象从「打分器是否可证伪」挪成「模型的对照
// 条目答不答得对」，那是另一件事，且会让默认读数变红。
// ===========================================================================

const CONTROL_TABLE = [
  {
    id: 'hom-neg-01',
    classKey: 'homophone-entity-ambiguity',
    kind: 'repo-entity-prior-bias',
    bias: 'repo-entity-prior',
    direction: 'down',
    prediction:
      '一个带『仓库实体先验』（总是偏好 Quay）的解析器会把这里的 key 解析成 Quay，并因此判错；该臂在这一条上必须读出负效应。',
    entry: {
      id: 'hom-neg-01',
      classKey: 'homophone-entity-ambiguity',
      script: '这段代码里那个变量名 key 太含糊了，改成 apiKey。',
      fixtureStateRef: 'ctx-code-diff-key-variable',
      gold: { resolution: 'code-identifier' },
    },
  },
  {
    id: 'sc-neg-01',
    classKey: 'self-correction',
    kind: 'last-wins-without-retraction',
    bias: 'last-wins',
    direction: 'down',
    prediction: '一个『只看最后一个 改成、丢掉前面的』的 last-wins 启发式会丢掉第一个改动（A→B），在此条上必须读出负效应。',
    entry: {
      id: 'sc-neg-01',
      classKey: 'self-correction',
      script: '把 A 改成 B，另外把 C 改成 D。',
      fixtureStateRef: null,
    },
  },
  {
    id: 'sc-neg-02',
    classKey: 'self-correction',
    kind: 'negated-command-nearmiss',
    bias: 'delete-on-delete-word',
    direction: 'down',
    prediction: '一个『见到 删掉 就当撤回命令』的启发式会错误地把该逻辑删除，必须读出负效应。',
    entry: {
      id: 'sc-neg-02',
      classKey: 'self-correction',
      script: '要不要把这个逻辑删掉？不用，留着。',
      fixtureStateRef: null,
    },
  },
  {
    id: 'co-neg-01',
    classKey: 'coreference',
    kind: 'no-selection-fabrication',
    bias: 'always-resolve',
    direction: 'down',
    prediction: '一个『总是把 这一段 解析到某个对象』的启发式会凭空编造一个 referent，必须读出负效应。',
    entry: {
      id: 'co-neg-01',
      classKey: 'coreference',
      script: '把这一段改成 async 的。',
      fixtureStateRef: 'ui-no-selection',
      requiredReads: ['ui_selected_text'],
    },
  },
  {
    id: 'co-neg-02',
    classKey: 'coreference',
    kind: 'withheld-scope-fabrication',
    bias: 'withheld-as-text',
    direction: 'down',
    prediction: '一个把 withheld 当作「有文本」照常作答的系统会编造内容，必须读出负效应。',
    entry: {
      id: 'co-neg-02',
      classKey: 'coreference',
      script: '这一段是什么？',
      fixtureStateRef: 'ui-withheld',
      requiredReads: ['ui_selected_text'],
    },
  },
  {
    id: 'wm-neg-01',
    classKey: 'world-model',
    kind: 'run-present-implies-running',
    bias: 'run-present-implies-running',
    direction: 'down',
    prediction: '一个『只要有 run 行就答 还在跑』的启发式会答『还在跑』，必须读出负效应。',
    entry: {
      id: 'wm-neg-01',
      classKey: 'world-model',
      script: '刚才那个还在跑吗？',
      fixtureStateRef: 'run-aborted',
      requiredReads: ['run_get'],
      subcase: 'has-answer',
      expect: 'aborted',
    },
  },
  {
    id: 'wm-neg-02',
    classKey: 'world-model',
    kind: 'all-nonempty-answers-are-correct',
    bias: 'all-nonempty-answers-are-correct',
    direction: 'down',
    prediction:
      '一个『凡是非空回答都算对』的打分器会把 wm-06/07/08 的编造记成 pass（错误方向），口径必须拒绝它 —— 诚实打分器必须给编造记 0。',
    scorerLevel: true,
  },
];

function loadFrozenControls() {
  const docs = ['homophone.json', 'self-correction.json', 'coreference.json', 'world-model.json'];
  const out = [];
  for (const file of docs) {
    const doc = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
    for (const control of doc.negativeControls ?? []) {
      out.push({ ...control, classKey: doc.class, predictedDirection: control.predictedDirection ?? '' });
    }
  }
  return out;
}

const CONTROL_ORDER = CONTROL_TABLE.map((c) => c.id);

// ===========================================================================
// 真实音频（`fixtures/audio/*.wav`，由 TTS 合成并提交；runner 只读）
// ===========================================================================

function audioPathFor(entry) {
  return join(AUDIO_DIR, `${entry.id}.wav`);
}

const audioCache = new Map();
function loadAudio(entry) {
  const id = entry.id;
  if (audioCache.has(id)) return audioCache.get(id);
  const path = audioPathFor(entry);
  if (!existsSync(path)) throw new Error(`missing audio for ${id}: ${path} — the real run needs every entry's wav`);
  const wav = readFileSync(path);
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const record = { path, wav, pcm: wav.subarray(44), sha256, seconds: Number(((wav.length - 44) / 2 / 16000).toFixed(3)) };
  audioCache.set(id, record);
  return record;
}

// ===========================================================================
// Arm B 的 executor：回填 GOAL-029 冻结的夹具数据（数据搬运，不是路由——路由是 bridge 的）
// ===========================================================================

function fixtureExecutor(state) {
  const pick = (tool) => () => {
    if (!state) return { error: { code: 'NOT_IN_FIXTURE' } };
    if (state.tool === tool) return state.error ?? state.reading;
    return { error: { code: 'NOT_IN_FIXTURE' } };
  };
  return {
    ui_visible_context: () => state?.uiVisibleContext ?? { devices: [], navigations: [] },
    ui_selected_text: () => state?.uiSelectedText ?? { devices: [] },
    session_get: pick('session_get'),
    run_get: pick('run_get'),
    approvals_list: pick('approvals_list'),
    session_background: pick('session_background'),
    session_send: () => ({ ok: false, code: 'NOT_MEASURED_IN_THIS_READING' }),
  };
}

// ===========================================================================
// 机械读取器：真实输出 → 冻结 `decision` 形状（机器只做子串/结构性子检查；语义那一半是人读）
// ===========================================================================

/** 读一段文本里的「诚实说不知道」措辞（no-info 子例的 pass 条件）。 */
const UNKNOWN_PATTERNS =
  /读不到|看不到|查不到|不知道|不清楚|不确定|无法确定|无法获知|无法查看|没有(这个|相关|这条)?记录|未找到|没有队列|不能确定|无法判断|无法看到|看不到别的|不掌握|没有接口|无法读取|无法查询/;

/** 读文本里的延迟/状态 token → world-model 的冻结期望状态。 */
function readStateToken(text) {
  if (/已中止|中止|中断|aborted|被打断/.test(text)) return 'aborted';
  if (/还在跑|正在跑|运行中|正在运行|running/.test(text)) return 'running';
  if (/已完成|完成了|已经完成|completed|跑完了/.test(text)) return 'completed';
  if (/审批|批准|approval/.test(text)) return 'approval';
  if (/后台任务|后台的?任务|background/.test(text)) return 'background';
  return null;
}

/** 读文本里的指代对象 → coreference 的 referent。 */
function readReferent(text) {
  const file = /[\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|go|java)\b/.exec(text);
  if (file) return file[0];
  const session = /session-[\w-]+/.exec(text);
  if (session) return session[0];
  const fn = /\b(sendMessage|createSession|updateSession)\b/.exec(text);
  if (fn) return fn[1];
  return null;
}

/** 读文本里的易混词解析 → homophone 的 resolution（与冻结 gold 的 token 同一套词汇）。 */
function readResolution(text) {
  if (/quay/i.test(text) || /任务库/.test(text)) return 'Quay';
  if (/claude/i.test(text)) return 'Claude';
  if (/令牌|token|PAT|apiKey|api[_ ]?key|密钥|访问凭证/.test(text)) return 'access-token';
  if (/变量名|标识符|局部变量|代码里/.test(text)) return 'code-identifier';
  return null;
}

/**
 * Arm A 的读取器：出货适配器返回的**一句话面指令**。这条臂结构上没有工具/上下文通道，所以
 *   - 同音：无从锁定具体实体 ⇒ 只能提问（这正是冻结口径里 ambiguous 的 pass 条件）；
 *   - 自我更正：`finalIntent` = **真实的**适配器输出（适配器自己带 de-disfluency / self-correction）；
 *   - 指代：没有读工具通道 ⇒ 诚实说读不到；
 *   - world-model：需要读工具的一律读不到；不需要读工具的（no-info）诚实说读不到。
 * 这三条不依赖转写内容——它们是这条臂的**结构事实**（与 `capabilities` 一致），如实登记。
 */
function readDecisionA(entry, output) {
  const text = output?.transcript ?? '';
  const base = {
    arm: 'A',
    asked: false,
    calls: [],
    evidenceReads: [],
    resolution: null,
    referent: null,
    honestUnknown: false,
    state: null,
    finalIntent: '',
    retracted: [],
    deleted: false,
    blocked: [],
    text,
  };
  switch (entry.classKey) {
    case 'homophone-entity-ambiguity':
      return { ...base, asked: true, text: text || '（无上下文通道，需澄清）' };
    case 'self-correction':
      return { ...base, finalIntent: text };
    case 'coreference':
      return { ...base, honestUnknown: true };
    case 'world-model':
      return { ...base, honestUnknown: (entry.requiredReads ?? []).length === 0 };
    default:
      return base;
  }
}

/**
 * Arm B 的读取器：真实 Realtime 会话的 `function_call`（bridge 路由过）与其后的最终文本。
 * `output.calls` 是模型**实际**发起的调用；`output.text` 是会话收敛后的文本。
 */
function readDecisionB(entry, output) {
  const calls = (output?.calls ?? []).map((call) => ({ name: call.name, args: call.args ?? {} }));
  const text = output?.text ?? '';
  const base = {
    arm: 'B',
    asked: false,
    calls,
    evidenceReads: calls.map((call) => call.name),
    resolution: null,
    referent: null,
    honestUnknown: false,
    state: null,
    finalIntent: '',
    retracted: [],
    deleted: false,
    blocked: [],
    text,
  };
  switch (entry.classKey) {
    case 'homophone-entity-ambiguity': {
      const resolution = readResolution(text);
      return { ...base, resolution, asked: resolution === null && calls.length === 0 };
    }
    case 'self-correction':
      return { ...base, finalIntent: text, deleted: /已删|删掉了|将删除|已移除|已删除/.test(text) };
    case 'coreference':
      return {
        ...base,
        referent: readReferent(text),
        honestUnknown: UNKNOWN_PATTERNS.test(text),
      };
    case 'world-model': {
      const state = readStateToken(text);
      const honestUnknown = state === null && UNKNOWN_PATTERNS.test(text);
      return { ...base, state, honestUnknown };
    }
    default:
      return base;
  }
}

function readDecision(reading) {
  return reading.arm === 'A' ? readDecisionA(reading.entry, reading.output) : readDecisionB(reading.entry, reading.output);
}

// ===========================================================================
// 工具调用行为（AC5）：与最终答案正确率**分开**统计
// ===========================================================================

const HALLUCINATION_CODES = new Set([
  'UNDECLARED_TOOL',
  'TOOL_ARGUMENT_SCHEMA_VIOLATION',
  'UNKNOWN_TOOL',
  'MALFORMED_FUNCTION_CALL',
]);

function classifyToolBehavior(entry, output) {
  const expected = entry.requiredReads ?? [];
  const actual = (output?.calls ?? []).map((call) => call.name);
  const rejections = output?.rejections ?? [];
  const hallucinated = rejections.filter((r) => HALLUCINATION_CODES.has(r.code));
  if (hallucinated.length) {
    return {
      category: 'tool_or_param_hallucination',
      expected,
      actual,
      detail: hallucinated.map((r) => `${r.code}${r.tool ? `:${r.tool}` : ''}${r.reason ? `(${r.reason})` : ''}`).join('; '),
    };
  }
  if (expected.length === 0) {
    return { category: actual.length ? 'called_but_not_required' : 'no_call_needed', expected, actual, detail: '' };
  }
  const missing = expected.filter((tool) => !actual.includes(tool));
  if (missing.length === 0) return { category: 'called_as_required', expected, actual, detail: '' };
  if (actual.length === 0) return { category: 'not_called_as_required', expected, actual, detail: `missing ${missing.join(', ')}` };
  return { category: 'called_wrong_tool', expected, actual, detail: `missing ${missing.join(', ')}` };
}

// ===========================================================================
// Arm A：真实 ASR（联网 + 凭据）
// ===========================================================================

async function runArmA(ctx, entry, rep) {
  const audio = loadAudio(entry);
  const started = nowMs();
  const result = await ctx.baseline.transcribe(
    { audio: { bytes: new Uint8Array(audio.pcm), mimeType: 'audio/wav', fileName: `${entry.id}.wav` } },
    {
      baseUrl: 'https://dashscope.aliyuncs.com',
      apiKey: ctx.apiKey,
      model: ctx.baseline.credentials?.defaultModel ?? ctx.baseline.DEFAULT_MODEL,
      timeoutMs: ASR_TIMEOUT_MS,
      fetchImpl: fetch,
    },
  );
  const latencyMs = nowMs() - started;
  if (!result.ok) {
    throw new Error(`Arm A failed for ${entry.id} rep ${rep}: ${result.code} (${result.message})`);
  }
  return {
    run: RUN_ID,
    id: entry.id,
    classKey: entry.classKey,
    arm: 'A',
    rep,
    entry,
    output: {
      transcript: result.text,
      providerId: result.providerId,
      style: result.style,
      error: null,
    },
    // Arm A 结构上只有一个节点（适配器的一次往返）；function-call 节点不存在（无工具通道）。
    latencies: { firstResponse: latencyMs, functionCall: null, finalIntent: latencyMs },
    toolBehavior: null,
  };
}

// ===========================================================================
// Arm B：真实 Realtime transport + bridge（联网 + 凭据 + 花钱）
// ===========================================================================

const INSTRUCTIONS = [
  '你是编程工作区的语音控制面。用户说一句简短中文指令。',
  '如果回答需要知道屏幕上显示/选中了什么、或某个会话/run/审批/后台任务的状态，你必须先调用合适的只读工具',
  '（ui_visible_context / session_get / run_get / approvals_list / session_background），并依据它返回的内容作答。',
  '若某个需要的工具调用不到，就如实说明读不到，不要凭猜测编造。',
  '如果这个指令本来就不需要工具，直接给出最终要执行的指令即可。',
  '用中文回答，一到两句话。',
].join('');

async function runArmB(ctx, entry, rep) {
  const audio = loadAudio(entry);
  const state = entry.fixtureStateRef ? entry.fixtureStates?.[entry.fixtureStateRef] : null;
  const executor = fixtureExecutor(state);
  const events = [];
  const calls = [];
  const rejections = [];
  const seenCallIds = new Set();
  let deltaText = '';
  let doneText = '';
  let routedOutputs = 0;
  let openedAt = 0;

  const noteCall = (callId, name, args) => {
    if (typeof callId !== 'string' || seenCallIds.has(callId)) return;
    seenCallIds.add(callId);
    calls.push({ name: String(name ?? ''), args: safeJson(args), source: 'model', at: nowMs() });
  };

  const record = (wire) => {
    events.push({ at: nowMs(), type: String(wire?.type ?? '') });
    if (wire?.type === 'response.function_call_arguments.done') noteCall(wire.call_id, wire.name, wire.arguments);
    if (wire?.type === 'response.output_item.done' && wire.item?.type === 'function_call') {
      noteCall(wire.item.call_id, wire.item.name, wire.item.arguments);
    }
    const type = String(wire?.type ?? '');
    if (/(^|\.)(text|audio_transcript|output_text)\.delta$/.test(type) && typeof wire.delta === 'string') {
      deltaText += wire.delta;
    }
    if (type === 'response.done' || type === 'response.completed') {
      const parts = [];
      for (const item of wire.response?.output ?? []) {
        if (item?.type === 'message') for (const content of item.content ?? []) if (typeof content?.text === 'string') parts.push(content.text);
      }
      if (parts.length) doneText = parts.join('');
    }
  };

  const factory = (url, headers) => {
    const ws = new WebSocket(url, { headers });
    const socket = {
      send(data) {
        try {
          const wire = JSON.parse(String(data));
          if (wire?.item?.type === 'function_call_output') routedOutputs += 1;
        } catch {
          /* a non-JSON frame is not a routed output */
        }
        ws.send(data);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    ws.on('open', () => {
      openedAt = nowMs();
      socket.onopen?.({});
    });
    ws.on('message', (data) => {
      let wire;
      try {
        wire = JSON.parse(data.toString());
      } catch {
        return;
      }
      record(wire);
      socket.onmessage?.({ data: data.toString() });
    });
    ws.on('error', () => socket.onerror?.({}));
    ws.on('close', (code, reason) => socket.onclose?.({ code, reason: String(reason) }));
    return socket;
  };

  const transport = bridgeModule.createDashscopeTransport({
    model: ctx.model,
    voice: ctx.voice,
    socketFactory: factory,
    onError: (error) => rejections.push(error),
  });
  const bridge = bridgeModule.connect(transport, bridgeModule.REALTIME_TOOLS, executor, {
    maxConnectAttempts: 1,
    hooks: { onError: (error) => rejections.push(error) },
  });

  const started = nowMs();
  let latencies = { firstResponse: null, functionCall: null, finalIntent: null };
  try {
    await withTimeout(bridge.whenConnected(), SESSION_TIMEOUT_MS, `connect ${entry.id}`);
    bridge.sendSessionUpdate(INSTRUCTIONS);
    await sleep(600);
    const audioSentAt = nowMs();
    bridge.sendAudioFrame(audio.pcm.toString('base64'));

    const deadline = audioSentAt + SESSION_TIMEOUT_MS;
    let lastEventAt = audioSentAt;
    let settledFor = 0;
    let lastSeen = events.length;
    while (nowMs() < deadline) {
      await sleep(100);
      if (events.length !== lastSeen) {
        lastSeen = events.length;
        lastEventAt = nowMs();
        settledFor = 0;
      } else {
        settledFor = nowMs() - lastEventAt;
      }
      if (latencies.firstResponse === null && events.some((e) => e.at >= audioSentAt)) {
        latencies.firstResponse = firstEventAt(events, audioSentAt) - audioSentAt;
      }
      if (latencies.functionCall === null && calls.length) {
        latencies.functionCall = calls[0].at - audioSentAt;
      }
      const sawResponseDone = events.some((e) => e.type === 'response.done' || e.type === 'response.completed');
      // Settle: a completed response AND quiet, or a long quiet with calls already answered.
      if (settledFor >= SETTLE_MS && (sawResponseDone || calls.length > 0)) break;
    }
    latencies.finalIntent = nowMs() - audioSentAt;
    if (latencies.firstResponse === null) latencies.firstResponse = latencies.finalIntent;
  } finally {
    try {
      await bridge.close();
    } catch {
      /* closing a dead socket is not a reading */
    }
    await sleep(150);
  }

  return {
    run: RUN_ID,
    id: entry.id,
    classKey: entry.classKey,
    arm: 'B',
    rep,
    entry,
    output: {
      text: (deltaText || doneText).trim(),
      calls: calls.map((call) => ({ name: call.name, args: call.args })),
      rejections: rejections.map((r) => ({ code: r.code, tool: r.tool, reason: r.reason })),
      routedOutputs,
      model: ctx.model,
    },
    latencies,
    toolBehavior: classifyToolBehavior(entry, { calls, rejections }),
    openedInMs: openedAt ? openedAt - started : null,
  };
}

function safeJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { __unparsed: String(raw).slice(0, 200) };
  }
}

function firstEventAt(events, since) {
  for (const event of events) if (event.at >= since) return event.at;
  return since;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

// ===========================================================================
// 取数 / 冻结 / 离线重算
// ===========================================================================

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 把一条读数压成不含 `entry`（在重算时从冻结 fixtures 恢复）的可序列化记录。 */
function serializeReading(reading) {
  return {
    run: reading.run,
    id: reading.id,
    classKey: reading.classKey,
    arm: reading.arm,
    rep: reading.rep,
    output: reading.output,
    latencies: reading.latencies,
    toolBehavior: reading.toolBehavior,
  };
}

function writeCache(readings, meta) {
  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    schema: 'voice-realtime-real-paired/1',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    ...meta,
    readings: readings.map(serializeReading),
  };
  writeFileSync(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function collect(ctx, corpus, targets, { fresh = false } = {}) {
  const previous = fresh ? null : readJsonIfExists(CACHE_PATH);
  const done = new Map();
  if (previous) for (const reading of previous.readings ?? []) done.set(`${reading.id}|${reading.arm}|${reading.rep}`, reading);
  const readings = [...done.values()];
  const meta = {
    model: ctx.model,
    voice: ctx.voice,
    baseline: { providerId: 'dashscope-omni', model: ctx.baseline.credentials?.defaultModel ?? ctx.baseline.DEFAULT_MODEL },
    endpoint: bridgeModule.DASHSCOPE_REALTIME_ENDPOINT,
    reps: ctx.reps,
    audio: {
      voice: process.env.TTS_VOICE ?? 'zh-CN-XiaoxiaoNeural',
      files: targets.map((entry) => ({ id: entry.id, sha256: loadAudio(entry).sha256, seconds: loadAudio(entry).seconds })),
    },
  };

  console.log(
    `live collection: ${targets.length} target(s) × 2 arm(s) × ${ctx.reps} rep(s) = ${targets.length * 2 * ctx.reps} real call(s)`,
  );
  for (const entry of targets) {
    for (let rep = 1; rep <= ctx.reps; rep += 1) {
      for (const [arm, runner] of [
        ['A', runArmA],
        ['B', runArmB],
      ]) {
        const key = `${entry.id}|${arm}|${rep}`;
        if (done.has(key)) continue;
        let reading = null;
        let lastError = null;
        // 一条真实读数会因网络抖动失败；重试两次，仍失败才记缺。缺了会被上面的 [n] 检查抓住。
        for (let attempt = 1; attempt <= 3 && reading === null; attempt += 1) {
          try {
            reading = await runner(ctx, entry, rep);
          } catch (error) {
            lastError = error;
            if (attempt < 3) await sleep(700);
          }
        }
        if (reading === null) {
          console.error(`  !! ${key} failed after 3 attempts: ${lastError?.message ?? lastError}`);
          continue;
        }
        readings.push(serializeReading(reading));
        done.set(key, reading);
        await sleep(200);
        console.log(
          `  ${pad(key, 28)} ${arm === 'A' ? `asr ${reading.latencies.firstResponse}ms` : `first ${reading.latencies.firstResponse}ms fc ${reading.latencies.functionCall ?? '-'}ms`}` +
            `  ${(reading.output.text ?? reading.output.transcript ?? '').slice(0, 48)}`,
        );
      }
    }
    // Incremental save so a long live run survives an interruption.
    writeCache(readings, meta);
  }
  return readings;
}

function freeze(readings, meta) {
  const payload = {
    schema: 'voice-realtime-real-paired/1',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    provenance: 'captured by run-real.mjs --live against the real DashScope endpoints; frozen here for offline re-scoring',
    ...meta,
    readings,
  };
  writeFileSync(FROZEN_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`froze ${readings.length} reading(s) to ${FROZEN_PATH}`);
}

// ===========================================================================
// 报告（延迟 / 工具行为 / AC7 零方差）
// ===========================================================================

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function printLatency(rows) {
  console.log('\nlatency (ms) — three nodes, per arm (a reading, not a gate):');
  const nodes = ['firstResponse', 'functionCall', 'finalIntent'];
  for (const arm of ['A', 'B']) {
    const armRows = rows.filter((row) => row.arm === arm);
    for (const node of nodes) {
      const values = armRows.map((row) => row.latencies[node]).filter((v) => typeof v === 'number');
      if (!values.length) {
        console.log(`  arm ${arm} ${pad(node, 14)} (no reading — this arm has no such node)`);
        continue;
      }
      console.log(
        `  arm ${arm} ${pad(node, 14)} p50=${pad(percentile(values, 50), 6)} p90=${pad(percentile(values, 90), 6)} max=${Math.max(...values)}  (n=${values.length})`,
      );
    }
  }
}

function printToolBehavior(rows) {
  console.log('\ntool-call behaviour (Arm B) — reported SEPARATELY from final-answer correctness:');
  const order = [
    'called_as_required',
    'not_called_as_required',
    'called_wrong_tool',
    'tool_or_param_hallucination',
    'called_but_not_required',
    'no_call_needed',
  ];
  const tally = new Map(order.map((k) => [k, 0]));
  const bRows = rows.filter((row) => row.arm === 'B' && row.toolBehavior);
  for (const row of bRows) tally.set(row.toolBehavior.category, (tally.get(row.toolBehavior.category) ?? 0) + 1);
  for (const key of order) console.log(`  ${pad(key, 28)} ${tally.get(key) ?? 0}`);
  const needsTool = bRows.filter((row) => (row.entry.requiredReads ?? []).length > 0);
  if (needsTool.length) {
    const missed = needsTool.filter((row) => row.toolBehavior.category === 'not_called_as_required').length;
    const halluc = bRows.filter((row) => row.toolBehavior.category === 'tool_or_param_hallucination').length;
    console.log(
      `  → among ${needsTool.length} reading(s) that REQUIRED a tool: not-called-as-required=${missed}; tool/param hallucination=${halluc}`,
    );
    if (missed === 0) console.log('     (未按要求调用的风险：本次读数里未观察到)');
    if (halluc === 0) console.log('     (工具/参数幻觉的风险：本次读数里未观察到)');
  }
  const otherErrors = bRows.flatMap((row) => (row.output.rejections ?? []).filter((r) => !HALLUCINATION_CODES.has(r.code)));
  if (otherErrors.length) {
    const byCode = new Map();
    for (const error of otherErrors) byCode.set(error.code, (byCode.get(error.code) ?? 0) + 1);
    console.log(`  transport/connection errors (NOT counted as tool behaviour): ${[...byCode].map(([code, n]) => `${code}×${n}`).join(', ')}`);
  }

  console.log('\n  per-entry (Arm B):');
  for (const row of bRows) {
    const t = row.toolBehavior;
    console.log(
      `    ${pad(row.id, 12)} rep${row.rep} exp=[${t.expected.join(',')}] got=[${t.actual.join(',')}] ${pad(t.category, 26)}${t.detail ? ` ${t.detail}` : ''}`,
    );
  }
}

/** AC7：一条 entry 的 ≥reps 次重复若在延迟与输出上完全同质 ⇒ SUSPECTED_STAND_IN。 */
function standInSuspects(rows, reps) {
  const suspects = [];
  const byEntry = new Map();
  for (const row of rows) {
    if (!byEntry.has(row.id)) byEntry.set(row.id, []);
    byEntry.get(row.id).push(row);
  }
  for (const [id, entryRows] of byEntry) {
    for (const arm of ['A', 'B']) {
      const armRows = entryRows.filter((row) => row.arm === arm);
      // 少于 2 个读数时「同质」是退化命题（1 个样本的集合当然只有一个指纹），不作 AC7 的判据。
      if (armRows.length < Math.max(reps, 2)) continue;
      const fingerprints = new Set(armRows.map((row) => `${JSON.stringify(row.latencies)}|${JSON.stringify(row.output)}`));
      if (fingerprints.size === 1) suspects.push({ id, arm, reps: armRows.length });
    }
  }
  return suspects;
}

// ===========================================================================
// probe：AC4 的机检形态
// ===========================================================================

const FORBIDDEN_LITERALS = [`input${'_audio'}`, `compatible-mode/v1/${'chat/completions'}`];

function selfSourceFailures() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const failures = [];
  for (const literal of FORBIDDEN_LITERALS) {
    if (source.includes(literal)) {
      failures.push(`this harness builds a second ASR request itself (its own source carries '${literal}')`);
    }
  }
  return failures;
}

function assertShippingModules(registryError) {
  const failures = [];
  const inside = (path) => path === REPO_ROOT || path.startsWith(`${REPO_ROOT}/`);
  const inHarness = (path) => path === HERE || path.startsWith(`${HERE}/`);
  const declared = [
    ['registry', MODULE_PATHS.registry, 'export function resolve'],
    ['baseline', MODULE_PATHS.baseline, 'export async function transcribe'],
    ['bridgeBarrel', MODULE_PATHS.bridgeBarrel, 'export {'],
    ['bridge', MODULE_PATHS.bridge, 'export function connect'],
    ['transport', MODULE_PATHS.transport, 'export function createDashscopeTransport'],
  ];
  for (const [label, path, signature] of declared) {
    if (!existsSync(path)) {
      failures.push(`${label}: ${path} does not exist`);
      continue;
    }
    if (!inside(path)) failures.push(`${label}: ${path} is outside the shipping tree (${REPO_ROOT})`);
    if (inHarness(path)) failures.push(`${label}: ${path} is inside this harness — a second implementation`);
    if (!readFileSync(path, 'utf8').includes(signature)) failures.push(`${label}: ${path} does not carry "${signature}"`);
  }
  if (registryError !== null) failures.push(`the registry could not be loaded: ${registryError}`);
  for (const failure of selfSourceFailures()) failures.push(failure);
  return failures;
}

function printProbe(corpus) {
  console.log('probe (the shipping modules this run drives — absolute paths, all inside the shipping tree):');
  console.log(`  tree        ${REPO_ROOT}`);
  console.log(`  arm A       ${MODULE_PATHS.baseline}#transcribe (via ${MODULE_PATHS.registry}#resolve('dashscope-omni'), fetchImpl = global fetch)`);
  console.log(`  arm B       ${MODULE_PATHS.bridgeBarrel}#connect → ${MODULE_PATHS.bridge}`);
  console.log(`  arm B wire  ${MODULE_PATHS.transport}#createDashscopeTransport (model=${bridgeModule.DEFAULT_DASHSCOPE_REALTIME_MODEL}, voice=${bridgeModule.DEFAULT_DASHSCOPE_REALTIME_VOICE})`);
  console.log(`  harness     ${HERE} (declared: no second ASR request construction, no second bridge, no second transport)`);
  if (corpus) {
    const advertised = new Set(bridgeModule.REALTIME_TOOLS.map((tool) => tool.name));
    const required = new Set();
    for (const entry of corpus.entries) for (const tool of entry.requiredReads ?? []) required.add(tool);
    const missing = [...required].filter((tool) => !advertised.has(tool)).sort();
    console.log('\nread-tool coverage (a finding, not a criterion):');
    console.log(`  entries require: ${[...required].sort().join(', ') || '(none)'}`);
    console.log(`  bridge advertises: ${[...advertised].sort().join(', ')}`);
    console.log(`  NOT advertised: ${missing.join(', ') || '(none)'}`);
  }
}

// ===========================================================================
// main
// ===========================================================================

export async function main(argv = process.argv.slice(2)) {
  const flag = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const value = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const finish = (code) => {
    console.log(`\n${DISCLAIMER}`);
    return code;
  };
  const failures = [];

  console.log('voice-realtime-ambiguity REAL paired reading — same real audio, both real arms, one run (a reading, not a gate)');

  const corpus = loadCorpus();
  for (const failure of corpusFailures(corpus)) failures.push(`[corpus] ${failure}`);
  for (const failure of assertExpectationsBacked(corpus)) failures.push(`[expectation] ${failure}`);

  let registryError = null;
  let baseline = null;
  try {
    baseline = registry.resolve('dashscope-omni');
  } catch (error) {
    registryError = error?.message ?? String(error);
  }
  if (registryError === null && baseline === null) {
    failures.push("[probe] the shipping registry does not hand out 'dashscope-omni'");
  }

  for (const failure of assertShippingModules(registryError)) failures.push(`[probe] ${failure}`);
  printProbe(flag('probe') ? corpus : null);

  // JSON 里不许出现凭据（AC10）。
  const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
  const baselineCaps = baselineCapabilities(baseline);
  if (baselineCaps.canSeeContext || baselineCaps.canReadTools) {
    failures.push(`[probe] the baseline arm is not structurally text-only (context=${baselineCaps.canSeeContext}, tools=${baselineCaps.canReadTools})`);
  }

  if (flag('probe')) {
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    return finish(failures.length ? 1 : 0);
  }

  const reps = Number(value('reps') ?? DEFAULT_REPS);
  const ctx = {
    baseline,
    apiKey,
    reps,
    model: bridgeModule.DEFAULT_DASHSCOPE_REALTIME_MODEL,
    voice: bridgeModule.DEFAULT_DASHSCOPE_REALTIME_VOICE,
  };

  const controls = loadFrozenControls();
  const frozenControlIds = new Set(controls.map((control) => control.id));
  for (const id of CONTROL_ORDER) if (!frozenControlIds.has(id)) failures.push(`[control] "${id}" is in this table but not frozen in the fixtures`);
  for (const id of frozenControlIds) if (!CONTROL_ORDER.includes(id)) failures.push(`[control] "${id}" is frozen but has no reading here`);

  const targets = [];
  const entries = flag('corpus') && value('corpus') === 'empty' ? [] : corpus.entries;
  for (const entry of entries) targets.push(entry);
  // 有音频的负对照也走真实两臂（对照必须是真的读数，不是代码里编的）。
  const controlEntries = [];
  for (const control of CONTROL_TABLE) {
    if (control.scorerLevel || !control.entry) continue;
    const frozenControl = controls.find((candidate) => candidate.id === control.id);
    if (!frozenControl || typeof frozenControl.audio !== 'string' || !frozenControl.audio) continue;
    controlEntries.push({ ...control.entry, fixtureStates: corpus.classes.find((cls) => cls.key === control.classKey)?.fixtureStates ?? {} });
  }
  targets.push(...controlEntries);

  // `--only=a,b` 是**冒烟**用的取数子集（先拿一条验通再跑全量），不改变默认全量读数。
  const only = (value('only') ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  const selected = only.length ? targets.filter((entry) => only.includes(entry.id)) : targets;

  // ── 读数：真实取数 / 冻结快照 ──────────────────────────────────────────────
  let payload = null;
  const metaCommon = {
    model: ctx.model,
    voice: ctx.voice,
    baseline: { providerId: 'dashscope-omni', model: baseline?.credentials?.defaultModel ?? null },
    endpoint: bridgeModule.DASHSCOPE_REALTIME_ENDPOINT,
    reps,
  };
  if (flag('live')) {
    if (apiKey === '') {
      console.error('DASHSCOPE_API_KEY is not set; source .env.test with `set -a` first.');
      return finish(2);
    }
    console.log(`\n[LIVE] real paid collection against ${bridgeModule.DASHSCOPE_REALTIME_ENDPOINT} and https://dashscope.aliyuncs.com`);
    const readings = await collect(ctx, corpus, selected, { fresh: flag('fresh') });
    payload = { runId: RUN_ID, ...metaCommon, readings };
    if (flag('freeze')) freeze(readings, metaCommon);
  } else if (flag('freeze')) {
    const cache = readJsonIfExists(CACHE_PATH);
    if (!cache) {
      console.error(`no live cache at ${CACHE_PATH} — run --live before --freeze`);
      return finish(2);
    }
    freeze(cache.readings, metaCommon);
    const saved = readJsonIfExists(FROZEN_PATH);
    payload = { runId: RUN_ID, ...metaCommon, readings: saved.readings };
  } else {
    const saved = readJsonIfExists(FROZEN_PATH);
    if (!saved) {
      console.error(`no frozen snapshot at ${FROZEN_PATH} — run --live then --freeze first`);
      return finish(2);
    }
    payload = saved;
  }

  // 快照里的读数 → 带 entry 的读数（entry 从冻结 fixtures 原地恢复）。
  const entryById = new Map();
  for (const entry of corpus.entries) entryById.set(entry.id, entry);
  for (const control of CONTROL_TABLE) {
    if (!control.entry) continue;
    entryById.set(control.entry.id, { ...control.entry, fixtureStates: corpus.classes.find((cls) => cls.key === control.classKey)?.fixtureStates ?? {} });
  }
  const rows = [];
  for (const reading of payload.readings ?? []) {
    if (entries.length === 0) break;
    const entry = entryById.get(reading.id);
    if (!entry) continue;
    const row = { ...reading, entry };
    row.decision = readDecision(row);
    row.verdict = scoreEntry(entry, row.decision);
    rows.push(row);
  }

  // ── n / run ────────────────────────────────────────────────────────────────
  const corpusRows = rows.filter((row) => entries.some((entry) => entry.id === row.id));
  const readingIds = new Set(corpusRows.map((row) => row.id));
  console.log(`\ncorpus: ${entries.length} entr(ies) across ${corpus.classes.length} class(es)`);
  console.log(`n=${entries.length} × 2 arm(s) × ${reps} rep(s) = ${entries.length * 2 * reps} reading(s) expected`);
  console.log(`  read: ${readingIds.size} entr(ies) × 2 arm(s) × up to ${reps} rep(s) = ${corpusRows.length} actual reading(s)`);
  if (!entries.length) failures.push('[n] the corpus is EMPTY — n=0 × 2 arm(s) = 0 readings, and an empty reading is not a green one');
  if (readingIds.size !== entries.length && entries.length) {
    failures.push(`[n] only ${readingIds.size}/${entries.length} entries have a real reading in ${flag('live') ? 'this live run' : 'the frozen snapshot'}`);
  }
  const runs = [...new Set(rows.map((row) => row.run))];
  console.log(`run: ${runs.join(', ') || '(none)'} — ${runs.length <= 1 ? 'single run, so the pairing does not straddle runs' : 'MORE THAN ONE RUN'}`);

  // ── 四类读数（按 arm 汇总，跨 rep） ────────────────────────────────────────
  if (entries.length) {
    console.log('\nper-class readings (a reading, not a gate — the two arms saw the same real audio in one run):');
    for (const cls of corpus.classes) {
      const clsRows = corpusRows.filter((row) => row.classKey === cls.key);
      if (!clsRows.length) continue;
      const arms = ['A', 'B'].map((arm) => {
        const armRows = clsRows.filter((row) => row.arm === arm);
        const passed = armRows.filter((row) => row.verdict.pass).length;
        return `arm ${arm} ${passed}/${armRows.length}`;
      });
      console.log(`  ${pad(cls.key, 28)} ${arms.join('   ')}`);
    }
    const overall = ['A', 'B'].map((arm) => {
      const armRows = corpusRows.filter((row) => row.arm === arm);
      const passed = armRows.filter((row) => row.verdict.pass).length;
      return `arm ${arm} ${passed}/${armRows.length}`;
    });
    console.log(`  ${pad('TOTAL', 28)} ${overall.join('   ')}`);

    console.log('\npaired outputs (Arm B is the model with tools; whether an answer is *semantically* right is the human half):');
    for (const cls of corpus.classes) {
      for (const entry of entries.filter((e) => e.classKey === cls.key)) {
        const a = corpusRows.find((row) => row.id === entry.id && row.arm === 'A');
        const b = corpusRows.find((row) => row.id === entry.id && row.arm === 'B');
        console.log(`  [${entry.id}] ${entry.classKey}`);
        console.log(`      A ${a ? `${a.verdict.pass ? 'pass' : 'fail'} "${(a.output.transcript ?? '').slice(0, 70)}"` : '(no reading)'}`);
        console.log(
          `      B ${b ? `${b.verdict.pass ? 'pass' : 'fail'} tools=[${(b.output.calls ?? []).map((c) => c.name).join(', ')}] "${(b.output.text ?? '').slice(0, 70)}"` : '(no reading)'}`,
        );
      }
    }

    // 负对照条目的**真实**读数：它们不参与对照判词（那一层走冻结替身，见上），但它们是真花的钱，
    // 所以把「真实模型在这些对照条目上答得怎样」也读出来——这是关于模型的一件事，不是关于打分器的。
    const controlRows = rows.filter((row) => controlEntries.some((entry) => entry.id === row.id));
    if (controlRows.length) {
      console.log('\nnegative-control entries, read for real (a reading about the MODEL, not about the scorer):');
      for (const entry of controlEntries) {
        const a = controlRows.find((row) => row.id === entry.id && row.arm === 'A');
        const b = controlRows.find((row) => row.id === entry.id && row.arm === 'B');
        console.log(
          `  [${entry.id}] A ${a ? (a.verdict.pass ? 'pass' : 'fail') : '(none)'}   B ${b ? (b.verdict.pass ? 'pass' : 'fail') : '(none)'} tools=[${(b?.output.calls ?? []).map((c) => c.name).join(', ')}]`,
        );
      }
    }

    printToolBehavior(corpusRows);
    printLatency(corpusRows);

    // AC4 的**运行时**证据：每一条读数都得**来自**出货模块。Arm A 每行的 `providerId` 由出货运维器
    // 自己盖章；Arm B 每一次 function_call 都由 bridge 自己查表路由成 `function_call_output`。
    const armARows = corpusRows.filter((row) => row.arm === 'A');
    const armBRows = corpusRows.filter((row) => row.arm === 'B');
    const wrongProvider = armARows.filter((row) => row.output.providerId !== 'dashscope-omni');
    const styles = [...new Set(armARows.map((row) => row.output.style))];
    const plannedCalls = armBRows.reduce((total, row) => total + (row.output.calls?.length ?? 0), 0);
    const routedOutputs = armBRows.reduce((total, row) => total + (row.output.routedOutputs ?? 0), 0);
    // 只有**工具相关**的拒绝（模型调了没广告的工具、参数不符 schema……）才抵消一次没被路由的调用。
    // `rejections` 里绝大多数是 `UNKNOWN_EVENT`——传输层不认识的**服务端事件**，跟「这次 function_call
    // 有没有被 bridge 处理」无关；把它们算进错误数会让 `routed < issued - errors` 恒假，检查形同虚设。
    const callErrorCount = (row) => (row.output.rejections ?? []).filter((r) => HALLUCINATION_CODES.has(r.code)).length;
    const rejected = armBRows.reduce((total, row) => total + callErrorCount(row), 0);
    // 每一条模型调用要么被 bridge 路由成 function_call_output，要么带着一条工具相关错误（例如模型漏了参数
    // 被 schema 拒掉）。**没有第三条出口**：既没被路由、又没被工具相关错误解释的调用，才是 AC4 要抓的。
    const unreconciled = armBRows.filter((row) => {
      const issued = row.output.calls?.length ?? 0;
      const routed = row.output.routedOutputs ?? 0;
      return routed > issued || routed + callErrorCount(row) < issued;
    });
    console.log('\nevidence that the shipping modules ran (not a re-implementation):');
    console.log(`  arm A: ${armARows.length} row(s) stamped by the shipping adapter (providerId=dashscope-omni; style seen: ${styles.join(', ') || '(none)'})`);
    console.log(`  arm B: ${routedOutputs} function_call_output(s) for ${plannedCalls} model-issued call(s) (${rejected} rejected by transport/bridge), all either routed by the bridge itself or accounted for by an error`);
    if (wrongProvider.length) {
      failures.push(`[AC4] ${wrongProvider.length} Arm A row(s) were not produced by the shipping adapter (providerId ≠ dashscope-omni)`);
    }
    if (unreconciled.length) {
      failures.push(`[AC4] ${unreconciled.length} Arm B row(s) had a call neither routed nor errored — the runner swallowed it instead of the bridge handling it`);
    }

    // AC7
    const suspects = standInSuspects(corpusRows, reps);
    console.log('\nAC7 — zero-variance check (a real endpoint does not produce byte-identical readings):');
    if (!suspects.length) {
      console.log(`  no entry's ${reps} rep(s) were identical in both latency and model output — no SUSPECTED_STAND_IN`);
    } else {
      for (const suspect of suspects) {
        console.log(`  SUSPECTED_STAND_IN ${suspect.id} arm ${suspect.arm} (${suspect.reps} identical reps)`);
      }
    }
  }

  // ── 负对照：冻结替身读取器 + 一次命名启发式变换（口径与 GOAL-029 一字不改） ──
  const advertisedTools = new Set(bridgeModule.REALTIME_TOOLS.map((tool) => tool.name));
  const bridgeCaps = {
    canReadTools: true,
    canSeeContext: advertisedTools.has('ui_visible_context'),
    advertised: advertisedTools,
  };
  const decisionsByEntry = new Map();
  const controlCtx = { decisionsByEntry };
  if (entries.length) {
    for (const control of CONTROL_TABLE) {
      if (control.scorerLevel) continue;
      const controlEntry = withFixtures(corpus, control.entry);
      const state = controlEntry.fixtureStateRef ? controlEntry.fixtureStates?.[controlEntry.fixtureStateRef] : null;
      const executor = fixtureExecutor(state);
      const readFixture = (tool) => (executor[tool] ? executor[tool]({}) : { error: { code: 'NOT_IN_FIXTURE' } });
      const unbiased = decide(controlEntry, bridgeCaps, readFixture);
      decisionsByEntry.set(`${control.entry.id}|`, unbiased);
      decisionsByEntry.set(`${control.entry.id}|${control.bias}`, applyBias(control.bias, controlEntry, unbiased));
    }
  }
  let controlReadings = [];
  let invertedVerdicts = [];
  if (entries.length) {
    controlReadings = CONTROL_TABLE.map((control) => readControl(controlCtx, control));
    printControls(controlReadings);
    const verdicts = controlReadings.map(controlVerdict);
    const moved = verdicts.filter((verdict) => verdict.status === 'moved').length;
    if (moved !== verdicts.length) {
      failures.push(`[control] only ${moved}/${verdicts.length} control(s) moved in the predicted direction`);
      for (const verdict of verdicts) if (verdict.status !== 'moved') failures.push(`[control] ${verdict.detail}`);
    }
    invertedVerdicts = CONTROL_TABLE.map((control) =>
      controlVerdict(readControl(controlCtx, control, { inverted: true })),
    );
  }

  // ── 自检变异 ───────────────────────────────────────────────────────────────
  console.log('\nfalsifiers (each must red for the stated reason; the default reading must be green):');
  const summary = [];
  if (entries.length) {
    summary.push(`real=${controlReadings.map(controlVerdict).filter((v) => v.status === 'moved').length}/${controlReadings.length} moved`);
    if (invertedVerdicts.some((v) => v.status === 'moved')) {
      failures.push('[falsifier] control=inverted: the reversed control still reported as moved — the direction assertion is blind');
    } else if (!invertedVerdicts.every((v) => v.status === 'against')) {
      failures.push(`[falsifier] control=inverted: red for the wrong reason (${invertedVerdicts.map((v) => v.status).join(', ')})`);
    } else {
      summary.push('control=inverted=against');
    }
    const straddles = assertSingleRun(straddle(rows));
    if (!straddles.length) failures.push('[falsifier] runs=straddle: expected the pairing check to red, got nothing');
    else if (!straddles.some((f) => f.includes(STRADDLE_RUN_ID))) failures.push('[falsifier] runs=straddle: red for the wrong reason');
    else summary.push('runs=straddle=red');
  } else {
    summary.push('control=inverted=(no corpus)');
  }
  if (flag('control') && value('control') === 'inverted') {
    for (const verdict of invertedVerdicts) if (verdict.status !== 'moved') failures.push(`[control] --control=inverted ${verdict.detail}`);
  }
  if (flag('control') && value('control') === 'absent') {
    failures.push('[control] --control=absent: every negative control was removed from the table, so nothing in this run was falsifiable');
  }
  if (flag('runs') && value('runs') === 'straddle') {
    for (const failure of assertSingleRun(straddle(rows))) failures.push(`[pairing] ${failure}`);
  }
  if (entries.length) {
    for (const failure of assertSingleRun(rows)) failures.push(`[pairing] ${failure}`);
  }
  console.log(`  ${summary.join('  ')}`);

  // AC10：快照里不得有凭据。
  if (apiKey && JSON.stringify(payload).includes(apiKey)) {
    failures.push('[AC10] the reading payload contains the credential literal');
  }

  if (failures.length) {
    process.stderr.write(`\nvoice-realtime-ambiguity REAL paired reading: ${failures.length} failure(s)\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    return finish(1);
  }

  console.log(
    `\nvoice-realtime-ambiguity REAL paired reading: OK — n=${entries.length} × 2 arm(s) × ${reps} rep(s); ${DISCLAIMER}`,
  );
  return finish(0);
}

function withFixtures(corpus, entry) {
  return { ...entry, fixtureStates: corpus.classes.find((cls) => cls.key === entry.classKey)?.fixtureStates ?? {} };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`FAIL: ${error?.message ?? error}\n${error?.stack ?? ''}\n`);
      process.exit(1);
    },
  );
}

// 本文件的末行与它输出的末行是同一句话。上面那些数字无论将来跑到多少，都是一份读数**不是**判据。
// quality numbers are a reading and are NOT a criterion
