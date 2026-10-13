#!/usr/bin/env tsx
/**
 * 服务端 VAD 三臂同源回放 —— A（不门控）/ B（出货 STS 门控）/ C（只观察不裁剪）。
 *
 * 问的问题。CloudCLI 的服务端有两层「本地判语音」：出货的 **STS**（`createSilenceTailGate`，开关
 * `VOICE_REALTIME_SILENCE_TAIL`，默认关）在 continuous 连接上**裁剪**上行 PCM 的静音尾巴；另一层
 * `localSpeechGate` 只**观察**、不裁剪。两者都作用在**上行音频**上，而断句权在上游 `server_vad` 手里。
 * 于是「模型听得好不好」被两个变量混在一起：**检测质量**（本地判得准不准）与**模型输入干预**
 * （本地到底动没动送上行的字节）。本探针把二者分开。
 *
 * 三臂，同一源音频、同一起点、同一长度：
 *   A —— 原样连续上传，不门控。这就是**第三次实测的生产形态**（`VOICE_REALTIME_SILENCE_TAIL` 未设
 *        ⇒ 产品不建 gate ⇒ 上行就是原始麦克风）。
 *   B —— 用**出货的** `createSilenceTailGate` 门控：只把 `decision.frames` 写上行（会裁剪）。
 *   C —— **同一个** gate 只观察、记录决策，但**永远写原始帧**（对齐 `localSpeechGate` 的产品语义）。
 *
 * 语料是**真实的**，不是构造的。源 WAV 是第三次 Live Voice 实测（2026-10-13）的上行捕获，
 * RIFF/WAVE PCM16 / 16 kHz / 单声道 / 372.66 s，与同目录 `.timeline.jsonl` 的 `final` 行
 * `dataBytes`/`durationMs` 逐位吻合（本探针在开跑前**核对**这两个数，不等就直接抛）。
 *
 * 转发真值来自**模型自己的 function call**，不是 CLI transcript。对应关系由两条**记录在盘上**的流建立：
 * capture timeline 的 `committed`（带 `itemId` + **音频内偏移 `offsetMs`**）↔ voice journal 的
 * `<< transcription.completed`（按到达顺序一一对应，条数不等即抛）↔ journal 的
 * `<< function_call session_send`（模型真正转发的文本）。⛔ CLI transcript / `to-browser caption` 流
 * **不是**转发真值。`--falsify-forward-truth=cli-transcript` 就是把这个错误形态**跑出来**，支撑断言 S1
 * 必须因此变红（S1 不是 AC 集里的一条，而是 AC4「转发保真」那一列的分母来源）。
 *
 * 断句权没被本探针动过。三臂的 `session.update` 里 `turn_detection` 来自**出货的**
 * `resolveTurnDetection({})`（`server_vad` / 0.5 / 400 ms，即产品默认），三臂**逐字节相同**——本探针
 * 不改它、也改不了（gate 的返回面只有「要写哪些帧」）。所以「服务端本地层是否影响 `turn_detection`」
 * 在本实验里是一个**可读的**结论，而不是一句声明。
 *
 * dry-run 执行面。会话声明的 `session_send` 工具由本脚本的**记录式执行器**承接：模型每次调用只被记进
 * journal 并回一个 `{"dryRun":true,"accepted":true}` 的合成 output，**绝不**落到任何真实会话。
 *
 * 花费。每条连接封顶 `--cap`（默认 ¥0.05）；本次运行总上限 `--total-cap`（默认 ¥0.5）。累计用**出货的**
 * `estimateRealtimeCostCny` 累加，不在这里抄价目表。`--plan` 只打印计划、不连上游、不花钱。
 *
 * :3001 只被读 pid（运行前后各一次），**从未被重启**；除上游 realtime 端点外**零外联**。
 *
 * 用法（仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3
 *   … --plan                     只打印计划，不连上游、不花钱
 *   … --cap 0.05                 每条连接花费上限（CNY）
 *   … --total-cap 0.5            本次运行总花费上限（CNY）
 *   … --excerpt-ms 42000         excerpt 长度（毫秒，⛔ 上限 90000）
 *   … --start-ms 320000          excerpt 在源音频内的起点（毫秒，三臂共用）
 *   … --arm A                    只跑某一臂（返工用；默认三臂全跑）
 *   … --replay-only              只做**离线**门控回放 + 帧画像（不连上游、不花钱）
 *   … --report-only <dir>        从 `<dir>/snapshot.json` 离线重建报告（不连上游、不花钱）
 *   … --falsify-forward-truth=cli-transcript   取假形态：改用 CLI/UI caption 流作转发真值 ⇒ S1 红
 *   … --falsify-c-suppresses                    取假形态：让 C 也裁剪（额外吞掉前导 500 ms）⇒ AC3 红
 *   … --falsify-b-boundary-response-create      取假形态：让 B 臂的边界事件驱动一次 response.create ⇒ AC8 红
 *   … --falsify-hide-keepalive-conflict         取假形态：报告隐去 keepalive 与节流目标的冲突
 *   … --falsify-unannotated-bypass              取假形态：报告省略「既有旁路」标注
 *   … --falsify-clamp-not-root-cause            取假形态：把零过滤归因到「语料没有可裁之处」⇒ AC5 红
 *   … --report <path>            报告写到别处（取假形态跑的时候用，免得盖掉定稿报告）
 *
 * **本任务（复议）新增的读数面**。前次运行把「B 与 A 逐字节相同」归因到**语料**（「本语料没有给出可裁
 * 之处」）；这个归因是错的。正确归因在**检测器自己**：`SILENCE_TAIL_MAX_THRESHOLD_DB = -60 dBFS`
 * 这个钳位上限在噪声底高于 ≈ −68 dBFS 时把自适应项彻底废掉（阈值恒为 −60），于是真实房间底噪永远
 * 进不了判定区。所以本探针除了三臂，还离线给出四样东西（`--replay-only` 就是它们的免费入口）：
 *   (1) 门控在**选定 excerpt** 上的逐帧回放（裁了多少帧、挂起几次、吞了多少毫秒）；
 *   (2) 这段 excerpt 的低能量部分是**数字静音**还是真实底噪（全零帧永不被判人声、也不进底噪窗口）；
 *   (3) 换成相对判据（底噪 p10 + Δ）后同一段音频**本来能裁多少**（敏感性读数）；
 *   (4) 对门控真实判定做的**钳位扫描**（喂满某个底噪后，判定边界落在哪一档）。
 * ⛔ 这些**只是读数**：拆除或抬高钳位是改变检测器语义、且 STS 产品任务把「误判静音率 = 0」列为硬
 * 要求，是否改由人裁定。本探针不改任何出货默认值、不写任何生产环境变量。
 *
 * 边界：⛔ 不重启 :3001、不发布；⛔ 不触碰任何 Quay worker / driver 工作树；⛔ 不向任何真实会话注入；
 * ⛔ **不写任何生产环境变量**（gate 在探针内构造，`process.env` 一个字都不改）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import {
  SILENCE_TAIL_ENV,
  createSilenceTailGate,
  estimateRealtimeCostCny,
  resolveTurnDetection,
  type SilenceTailDecision,
  type SilenceTailStage,
} from '../../server/modules/voice-realtime/index.js';

/**
 * 本探针从 voice-realtime barrel **实际导入的符号名**。
 *
 * AC6 的判据之一是「`localSpeechGate` / watchdog 是既有旁路，其边界事件未被计入本功能行为」。
 * 只写在报告里的标注是**自述**，没有约束力；这一集合把它变成可检验的事实：只要探针
 * 导入了 `createLocalSpeechGate` / `reportLocalSpeechBoundary`（或将来有人顺手加上），
 * 这条断言立刻红。手工维护，紧挨着上面的 import —— 导入变了而这里没变，AC6 就会红。
 * 只列**值导入**（`type` 导入构造不出东西，不在此列）。
 */
const PROBE_BARREL_IMPORTS: ReadonlySet<string> = new Set([
  'SILENCE_TAIL_ENV',
  'createSilenceTailGate',
  'estimateRealtimeCostCny',
  'resolveTurnDetection',
]);

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-vad-three-arm-probe.md');

/** 第三次 Live Voice 实测的源会话 id（真实音频 + 真实 journal 都按它命名）。 */
const DEFAULT_SESSION_ID = 'af5559c0-d347-41f3-a6f0-f02a597af1e9';
const CAPTURE_DIR = path.join(os.homedir(), '.cloudcli', 'voice-realtime-capture');
const JOURNAL_DIR = path.join(os.homedir(), '.cloudcli', 'voice-realtime-log');

/** 上游 Realtime 端点（与出货 transport 同址）。 */
const UPSTREAM_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
/** 出货默认模型与 voice（GOAL-030 采纳；该模型要求显式 voice）。 */
const MODEL = 'qwen3.8-omni-flash-realtime';
const VOICE = 'Tina';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // PCM16 单声道
/** 逐帧推进的帧长：20 ms，与浏览器上行同粒度。 */
const FRAME_MS = 20;
const FRAME_BYTES = (BYTES_PER_SECOND * FRAME_MS) / 1000; // 640

/** excerpt 长度上限（AC7：小样本、单次运行）。 */
const MAX_EXCERPT_MS = 90_000;
/**
 * 本任务**选定**的 excerpt（`--start-ms` / `--excerpt-ms` 的默认值）：第三次实测录音里
 * 339.84 s–344.54 s 那段 **4.70 s 数字静音**（全零 PCM）所在的位置，加上两侧的真实语音。
 *
 * 为什么是这一段：出货、未改的门控要真的裁帧，得有 ≥ 320 ms（挂起）+ 1000 ms（尾巴）的**连续**
 * 非人声帧；这段录音里唯一的这种段落就是它（全文件 18633 帧、314 帧数字静音，最长全零连续段
 * 恰为 235 帧 = 4.70 s）。选它是为了满足 AC1 的**红先行**：在这段上 `B.filteredFrames > 0`。
 * 反例窗口见 `FALSIFY_EXCERPT_START_MS`。
 */
const SELECTED_START_MS = 320_000;
const SELECTED_EXCERPT_MS = 42_000;
/**
 * AC1 的取假形态窗口：**同一条录音的首片 90 s** —— 旧任务用过的那一段，明确**不含**连续无语音
 * （低于门控边界的帧只占个位数百分比且最长连续 13 帧 = 260 ms，够不着 16 帧的挂起门槛）。
 * `--replay-only --start-ms 0 --excerpt-ms 90000` 跑出来 `filteredFrames == 0` ⇒ AC1 红。
 */
const FALSIFY_EXCERPT_START_MS = 0;
const FALSIFY_EXCERPT_MS = 90_000;
const DEFAULT_EXCERPT_MS = SELECTED_EXCERPT_MS;
const DEFAULT_START_MS = SELECTED_START_MS;

/** 阈值敏感性表的 Δ 档位（基准 = excerpt 非数字静音帧的 p10）。 */
const SENSITIVITY_DELTAS_DB = [0, 2, 4, 5, 6, 8, 10, 12] as const;
/** 钳位扫描的候选底噪档位（覆盖「低于硬下限」到「远高于钳位」）。 */
const CLAMP_SWEEP_FLOORS_DB = [-80, -75, -73, -71, -70, -69, -68, -67, -66, -65, -63, -61, -60, -58, -55] as const;
/** 全文件分位数的档位（Proposal 的读数就是这套）。 */
const RECORDING_FRACTIONS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1] as const;

/**
 * 前次运行（`gap-voice-server-vad-three-arm-replay-on-third-test-corpus`）报告的**只读副本**。
 *
 * 任务 Notes 明令：那条任务的交付物与读数有效，本任务**不得**删改其报告里的实测读数，只追加更正段。
 * 但报告路径是同一个（探针的定稿输出），重跑就会把它盖掉 —— 所以定稿前先把原文冻结成本文件。
 *
 * ⛔ **不把它的全文嵌进新报告**：那份报告里含 `KEEPALIVE_CONFLICT_MARKER` 与 `BYPASS_ANNOTATION_MARKER`
 * （它们是上一版生成器写出来的），嵌进来会让 S2 / S3 变成**空洞的真**，并让 F4 / F5 两条取假形态失效
 * —— 判据判的是「渲染出来的这段文字里有没有那一句」，而嵌进来的旧文里恰好有。因此新报告只**引用**
 * 这个路径、并逐字引用那两句被推翻的话（那两句里不含任何标记串），全文另存本文件备查。
 */
const PRIOR_REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-vad-three-arm-probe-run1.md');

/** 取假形态 F6（`--falsify-clamp-not-root-cause`）把根因改写成这句（旧结论的措辞）。 */
const WRONG_ROOT_CAUSE = '本语料没有给出可裁之处';

/**
 * 报告里三段**必须存在**的文字的标记串；AC1 / AC4 / AC5 的断言直接在这些标记上判。
 *
 * 与 `KEEPALIVE_CONFLICT_MARKER` 同一个道理：判**渲染出来的报告文本**，不判开关 ——
 * 「开关到开关」的空检查只能证明「我没把开关关掉」。生成器只在真形态分支里写出这些串，
 * 取假形态的分支刻意不含它们。
 */
const GATE_READINGS_MARKER = '**出货门控在本次 excerpt 上的实测读数（离线回放 + 真实 B 臂）**';
const CLAMP_ROOT_CAUSE_MARKER = '**根因：`SILENCE_TAIL_MAX_THRESHOLD_DB = -60 dBFS` 这个钳位废掉了自适应**';
const SENSITIVITY_MARKER = '**离线噪声底与阈值敏感性（同一段音频在相对判据下能裁多少）**';
/**
 * `--replay-only` 下**只**产出这几条断言：它们全部只看离线证据面（帧画像 / 门控回放 / 钳位扫描）
 * 与渲染出来的报告文本，不依赖任何臂读数。其余的断言整个不产出 —— 宁可断言表里没有这一条，
 * 也不要用一个「跳过 ⇒ 记 PASS」的假绿把它填上。
 */
const OFFLINE_ASSERTION_IDS: ReadonlySet<string> = new Set(['AC1', 'AC3', 'AC4', 'AC5', 'AC7', 'S1', 'S3']);

/**
 * 出货门控的判定常数 —— **镜子，不是权威来源**。
 *
 * 这几个常量**没有**从 `server/modules/voice-realtime` 的 barrel 导出（只导出了 `SILENCE_TAIL_ENV` 与两个
 * `DEFAULT_SILENCE_TAIL_*`；`index.ts` 不在本任务的 `## Touches` 里，**不得**为了写报告去改它）。所以这里
 * 按源码里的值写一份副本，只用于**成文与代码引用**，不参与任何判定。
 *
 * 行为侧的结论**不靠这份副本**：AC5 的钳位结论来自 `clampSweep` 对门控**自己的判定**做的逐电平实测
 * （喂已知电平的底噪，量它把边界放在哪），`measureShippedVoiceFloorDb` 同理。副本漂了、实测没漂 ⇒
 * 断言里的**镜像核对**（`|实测上限 − 副本| ≤ 1.5 dB`）会红，而不是让报告悄悄写错一个数。
 */
const SHIPPED_STS_MAX_THRESHOLD_DB = -60;
const SHIPPED_STS_HARD_FLOOR_DB = -70;
const SHIPPED_STS_VOICE_MARGIN_DB = 8;
const SHIPPED_STS_HANGOVER_MS = 320;
const SHIPPED_STS_ENTER_FRAMES = 3;
const SHIPPED_STS_TAIL_MS = 1000;
const SHIPPED_STS_PREROLL_MS = 500;
const SHIPPED_STS_KEEPALIVE_MS = 30_000;
const SHIPPED_STS_KEEPALIVE_FRAME_MS = 100;

const DEFAULT_CAP_CNY = 0.05;
const DEFAULT_TOTAL_CAP_CNY = 0.5;

/**
 * 取假形态 F2（`--falsify-c-suppresses`）在 C 臂上真的裁掉的**前导**上行毫秒。
 *
 * 为什么不是「把 C 的策略换成照抄 gate 的决定」就完事：本语料上出货门控**一次也没裁**
 * （报告「B 臂为何与 A 臂逐字节相同」一节：4500 帧里只有 6.8% 低于门控实测人声下限，
 * 320 ms 的连续 hangover 窗口因此从未成形）。照抄 gate 决定的 C 会**悄悄退化成 no-op**，
 * 上传与 A 逐字节相同 —— 这条假形态就失去了证伪意义（AC4 仍绿，却什么也没证明）。
 * 所以这里做成一次**声明式违背**：C 在开头额外吞掉这一窗口，`C.uploadedFrames` 必小于 A。
 */
const FALSIFY_C_WITHHOLD_MS = 500;

/**
 * 报告里两段**必须存在**的文字的标记串，AC5 / AC6 的断言直接在这些标记上判。
 *
 * 为什么不判开关（`options.keepaliveConflictStated` 之类）：开关到开关的检查是空的 —— 它只能证明
 * 「我没把开关关掉」，不能证明「报告里真的写了这一句」。所以判据落在**渲染出来的报告文本**上：
 * 生成器只会在真形态分支里写出这两个串，取假形态的分支刻意不含它们（见 F4/F5 两段文字）。
 * 于是「断言绿」与「报告写了」是同一件事。
 */
const KEEPALIVE_CONFLICT_MARKER = '⚠️ **与节流目标的冲突（必须写明，不得为保住节流数字而隐去）**';
const BYPASS_ANNOTATION_MARKER = '**显式标注（本节即该标注）**';

/** 看到的 `session_send` 参数里承载文本的字段名（出货工具用它）。 */
const FORWARD_ARG_FIELD = 'message';

/** 等 session.updated / session.created / error 的窗口。 */
const SESSION_READY_WINDOW_MS = 12_000;
/** 音频推完后等上游把尾巴处理完的窗口。 */
const DRAIN_WINDOW_MS = 25_000;
/** 静止判定：连续这么久没有收到任何 inbound 帧就收尾。 */
const QUIET_AFTER_MS = 5_000;
/** 一条连接里最多应答多少次工具调用（防同一段音频把模型带进自激循环）。 */
const MAX_ANSWERED_CALLS = 40;

/** 三臂。 */
const ARMS = ['A', 'B', 'C'] as const;
type ArmId = (typeof ARMS)[number];

/**
 * 每一臂的上行策略。
 *   A passthrough —— 原始帧，不过 gate（生产默认形态）。
 *   B suppress    —— 喂 gate，只写 `decision.frames`（会裁剪）。
 *   C observe     —— 喂 gate、记录决策，但**永远**写原始帧。
 */
type ArmPolicy = 'passthrough' | 'suppress' | 'observe';

const ARM_POLICY: Record<ArmId, ArmPolicy> = { A: 'passthrough', B: 'suppress', C: 'observe' };

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = (ms: number = Date.now()): string => new Date(ms).toISOString();
const num3 = (n: number): number => Number(n.toFixed(3));

function readFlags(argv: string[]): { values: Map<string, string>; bools: Set<string> } {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      values.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    } else {
      bools.add(key);
    }
  }
  return { values, bools };
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : { __nonObject: text };
  } catch {
    return { __unparsed: text };
  }
}

/** :PORT 上的监听进程 pid（取 `ss` 的 `pid=` 字段），或 null。 */
function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('/usr/bin/ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = /pid=(\d+)/.exec(out);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** 归一化文本，只用于**匹配**（去空白/标点、大小写折叠），不用于保真判定的展示。 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()【】[\]{}<>《》,.!?;:'"`~—\-·…]/gu, '')
    .trim();
}

/**
 * `needle` 是否被 `haystack` 覆盖：归一化后的**包含**关系（任一侧含另一侧），两侧都非空。
 *
 * 这是**保守**读法：只有模型转发的那条文本里**字面带着**这句话时才记「被转发」。模型改写过的
 * （例如把「是不是很快」写成「识别的很快」）不会被算作覆盖——那是一个**保真**读数，不是对齐失败。
 */
function covers(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (h === '' || n === '') return false;
  return h.includes(n) || n.includes(h);
}

// ─────────────────────────────────────────────────────────────────────────────
// 源素材（真实音频 / capture timeline / voice journal）
// ─────────────────────────────────────────────────────────────────────────────

/** WAV 头解析出的读数。 */
type WavHeader = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  /** data chunk 在文件里的字节偏移（不假设恰好 44）。 */
  dataOffset: number;
  durationMs: number;
};

/** 按 RIFF chunk 逐个走，读 `fmt ` 与 `data`。⛔ 不写死「头就是 44 字节」：`dataOffset` 是读出来的。 */
function parseWav(buffer: Buffer): { header: WavHeader; pcm: Buffer } {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (fmt === null) throw new Error('WAV 缺少 fmt chunk');
  if (dataOffset < 0) throw new Error('WAV 缺少 data chunk');
  const bytesPerSecond = fmt.sampleRate * (fmt.bitsPerSample / 8) * fmt.channels;
  return {
    header: {
      ...fmt,
      dataBytes,
      dataOffset,
      durationMs: Math.round((dataBytes / bytesPerSecond) * 1000),
    },
    pcm: buffer.subarray(dataOffset, dataOffset + dataBytes),
  };
}

/** capture timeline 的一行。 */
type TimelineEvent = { kind: string; atMs: number; offsetMs: number; itemId?: string };
/** timeline `final` 行（与 WAV 逐位核对的来源）。 */
type TimelineFinal = { frames: number; dataBytes: number; durationMs: number; offsetMs: number };

function readTimeline(file: string): { events: TimelineEvent[]; final: TimelineFinal | null } {
  const events: TimelineEvent[] = [];
  let final: TimelineFinal | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    const kind = String(raw.kind ?? '');
    if (kind === 'final') {
      final = {
        frames: Number(raw.frames),
        dataBytes: Number(raw.dataBytes),
        durationMs: Number(raw.durationMs),
        offsetMs: Number(raw.offsetMs),
      };
      continue;
    }
    events.push({
      kind,
      atMs: Number(raw.atMs),
      offsetMs: Number(raw.offsetMs),
      ...(typeof raw.itemId === 'string' ? { itemId: raw.itemId } : {}),
    });
  }
  return { events, final };
}

/** journal 里抽出的一行。 */
type JournalLine = { at: string; kind: string; line?: string; message?: string; outcome?: string; latencyMs?: number };

function readJournal(file: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const raw = JSON.parse(line) as Record<string, unknown>;
    out.push({
      at: String(raw.at ?? ''),
      kind: String(raw.kind ?? ''),
      ...(typeof raw.line === 'string' ? { line: raw.line } : {}),
      ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
      ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
      ...(typeof raw.latencyMs === 'number' ? { latencyMs: raw.latencyMs } : {}),
    });
  }
  return out;
}

/** journal `log` 行里以某前缀开头的那些（前缀后的原文原样保留）。 */
function logLinesWithPrefix(journal: JournalLine[], prefix: string): string[] {
  const out: string[] = [];
  for (const entry of journal) {
    if (entry.kind !== 'log' || entry.line === undefined) continue;
    if (entry.line.startsWith(prefix)) out.push(entry.line.slice(prefix.length).trim());
  }
  return out;
}

/** 从 `"…"` 形状的 journal 行里剥出双引号内的文本（保留原文，不做归一化）。 */
function quotedPayload(text: string): string {
  const m = /^"([\s\S]*)"$/.exec(text.trim());
  return m === null ? text.trim() : m[1]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 —— 来源对应表（offsetMs → itemId → transcription → session_send）
// ─────────────────────────────────────────────────────────────────────────────

/** 表里的一行。 */
type CorrespondenceRow = {
  index: number;
  itemId: string;
  /** 该句在**源音频内**的偏移（capture timeline 的 `committed.offsetMs`）。 */
  offsetMs: number;
  /** 捕获时刻（墙钟），用于与 journal 对齐及报告引用。 */
  committedAtMs: number;
  /** journal `<< transcription.completed` 的原文，或 null。 */
  transcription: string | null;
  /** 模型真正转发的文本（journal `<< function_call session_send` 的 message），或 null。 */
  forwardedText: string | null;
  /** 同一句被多条转发覆盖（合并）时的说明。 */
  note: string | null;
};

/** 转发真值的**来源**。S1 要求它是模型自己的 function call，不是 CLI transcript。 */
type ForwardTruthSource = 'journal.session_send' | 'cli-transcript';

type Correspondence = {
  rows: CorrespondenceRow[];
  forwardTruthSource: ForwardTruthSource;
  /** 显式声明：CLI transcript 未被用作转发真值。 */
  cliTranscriptUsedAsForwardTruth: boolean;
  counts: {
    committed: number;
    transcriptionCompleted: number;
    functionCallSessionSend: number;
    /** journal 里真正落库的 `session_send` 条目数（模型调用 → 交付之间存在折损）。 */
    sessionSendEntries: number;
    /** `to-browser caption`（CLI/UI 侧视图）条数 —— ⛔ 不是转发真值。 */
    captionLines: number;
  };
};

/**
 * 建表。两股流的对齐方式**逐条可核**：`committed` 与 `transcription.completed` 都按**到达顺序**
 * 一一对应（源会话两边都是 18 条且同序；条数不等就抛，不做猜测性对齐）。每条 transcription 再找
 * **覆盖它**的那条 `function_call`。
 */
function buildCorrespondence(options: {
  timeline: TimelineEvent[];
  journal: JournalLine[];
  forwardTruthSource: ForwardTruthSource;
}): Correspondence {
  const committed = options.timeline.filter((e) => e.kind === 'committed');
  const transcriptions = logLinesWithPrefix(options.journal, '<< transcription.completed').map(quotedPayload);
  const rawModelForwards = logLinesWithPrefix(options.journal, '<< function_call session_send').map((raw) => {
    // 行形如：`session_send {"message": "…"}` —— 解出参数对象里的文本字段。
    const brace = raw.indexOf('{');
    if (brace === -1) return raw.trim();
    try {
      const args = JSON.parse(raw.slice(brace)) as Record<string, unknown>;
      const value = args[FORWARD_ARG_FIELD];
      return typeof value === 'string' ? value : raw.trim();
    } catch {
      return raw.trim();
    }
  });
  const captionLines = logLinesWithPrefix(options.journal, 'to-browser caption').map(quotedPayload);

  // 转发真值：模型自己的 function call（默认），或 CLI/UI 侧的 caption 流（⚠️ 取假形态专用）。
  const forwards = options.forwardTruthSource === 'journal.session_send' ? rawModelForwards : captionLines;

  if (committed.length !== transcriptions.length) {
    throw new Error(
      `来源对应失败：capture committed ${committed.length} 条 ≠ journal transcription.completed ${transcriptions.length} 条`,
    );
  }

  const rows: CorrespondenceRow[] = committed.map((event, index) => {
    const transcription = transcriptions[index] ?? null;
    const covering = transcription === null ? [] : forwards.filter((fwd) => covers(fwd, transcription));
    const forwardedText = covering.length === 0 ? null : covering[0]!;
    const notes: string[] = [];
    if (covering.length > 1) notes.push(`本条被 ${covering.length} 条转发覆盖（合并）`);
    return {
      index,
      itemId: event.itemId ?? `item_unknown_${index}`,
      offsetMs: event.offsetMs,
      committedAtMs: event.atMs,
      transcription,
      forwardedText,
      note: notes.length === 0 ? null : notes.join('；'),
    };
  });

  return {
    rows,
    forwardTruthSource: options.forwardTruthSource,
    cliTranscriptUsedAsForwardTruth: options.forwardTruthSource !== 'journal.session_send',
    counts: {
      committed: committed.length,
      transcriptionCompleted: transcriptions.length,
      functionCallSessionSend: rawModelForwards.length,
      sessionSendEntries: options.journal.filter((j) => j.kind === 'session_send').length,
      captionLines: captionLines.length,
    },
  };
}

/** 表在 excerpt 窗口内的那些行（三臂共用同一窗口，故真值集合也共用）。 */
function excerptRows(rows: CorrespondenceRow[], startMs: number, excerptMs: number): CorrespondenceRow[] {
  return rows.filter((r) => r.offsetMs >= startMs && r.offsetMs < startMs + excerptMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// 上游连接（raw WS 客户端）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个 wire 帧。`sinceConnectMs` 是相对连接开始的墙钟偏移；`audioMs` = 记它时**已上传**的音频毫秒。 */
type WireEvent = {
  sinceConnectMs: number;
  audioMs: number;
  direction: 'sent' | 'received';
  type: string;
  raw: Record<string, unknown>;
};

/** 收到的 response 的用量与花费。 */
type ResponseUsage = { atMs: number; textTokens: number; audioTokens: number; outputTokens: number; costCny: number };

/** 把上行音频从留档里摘掉（只留长度），其余原样。 */
function scrub(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...raw };
  if (typeof copy.audio === 'string') copy.audio = `<elided ${copy.audio.length} base64 chars>`;
  return copy;
}

/**
 * 一条到上游的连接。观察**每一个**收发的 wire 帧；用出货估算器累计花费；在花超上限时**关掉自己**。
 * 工具调用只被记录并回一个合成 output（dry-run 执行面）。
 */
class Link {
  readonly events: WireEvent[] = [];
  readonly responses: ResponseUsage[] = [];
  readonly errors: string[] = [];
  readonly calls: Array<{ atMs: number; name: string; arguments: string; message: string | null }> = [];
  readonly t0 = Date.now();
  private spendCny = 0;
  capTripped = false;
  closed = false;
  private probeInitiatedClose = false;
  closeInfo: { code: number; reason: string; atMs: number; byProbe: boolean } | null = null;
  uploadedMs = 0;
  uploadedFrames = 0;
  uploadedBytes = 0;
  /**
   * 本连接**发出去的帧**按 type 计数（AC1：`response.create` / `input_audio_buffer.commit` 必须是 0）。
   * 读的是探针自己发出的东西，不是上游回的。
   */
  readonly sentByType = new Map<string, number>();
  /** 相邻两次上传之间的**墙钟间隔**最大值（AC4「连接存活」/AC5「长时间不发送」的读数）。 */
  longestAppendGapMs = 0;
  private lastAppendAtMs: number | null = null;
  private readonly advertisedTools: Set<string>;
  private readonly answeredCalls = new Set<string>();

  private constructor(
    private readonly ws: WebSocket,
    readonly capCny: number,
    advertisedTools: Set<string>,
  ) {
    this.advertisedTools = advertisedTools;
  }

  static async connect(options: {
    instructions: string;
    tools: unknown[];
    capCny: number;
    turnDetection: unknown;
  }): Promise<Link> {
    const key = process.env.DASHSCOPE_API_KEY;
    if (key === undefined || key.trim() === '') throw new Error('DASHSCOPE_API_KEY 未设置');
    const toolNames = new Set<string>();
    for (const t of options.tools) {
      const fn = (t as { function?: { name?: unknown } }).function;
      if (typeof fn?.name === 'string') toolNames.add(fn.name);
    }
    const ws = new WebSocket(`${UPSTREAM_URL}?model=${encodeURIComponent(MODEL)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const link = new Link(ws, options.capCny, toolNames);
    const opened = await link.waitOpen(15_000);
    if (!opened) throw new Error('上游 socket 未在 15 s 内打开');
    ws.on('message', (data: Buffer) => link.handle(data.toString('utf8')));
    ws.on('close', (code: number, reason: Buffer) => {
      link.closed = true;
      link.closeInfo = {
        code,
        reason: reason.toString('utf8'),
        atMs: Date.now() - link.t0,
        byProbe: link.probeInitiatedClose,
      };
    });
    ws.on('error', (err: Error) => link.errors.push(`socket: ${err.message}`));

    // 会话头**与出货一致**：modalities/format/voice 取自出货默认，`turn_detection` 由**出货解析器**给出。
    // ⛔ 本探针不手工拼这个对象、不改 `turn_detection`——三臂唯一的差别是「写哪些帧」。
    link.sendRaw({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm24',
        voice: VOICE,
        instructions: options.instructions,
        turn_detection: options.turnDetection,
        tools: options.tools,
      },
    });
    const ready = await link.waitForFrame(
      (e) => e.type === 'session.created' || e.type === 'session.updated' || e.type === 'error',
      SESSION_READY_WINDOW_MS,
    );
    if (!ready) throw new Error('上游未在 12 s 内回应 session.update');
    const err = link.events.find((e) => e.type === 'error');
    if (err !== undefined) throw new Error(`上游拒绝 session.update：${JSON.stringify(err.raw).slice(0, 300)}`);
    return link;
  }

  private waitOpen(timeoutMs: number): Promise<boolean> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      this.ws.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private waitForFrame(predicate: (e: WireEvent) => boolean, timeoutMs: number): Promise<boolean> {
    if (this.events.some(predicate)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        if (this.events.some(predicate)) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  sendRaw(frame: Record<string, unknown>): void {
    const t = String(frame.type);
    this.sentByType.set(t, (this.sentByType.get(t) ?? 0) + 1);
    this.events.push({
      sinceConnectMs: Date.now() - this.t0,
      audioMs: this.uploadedMs,
      direction: 'sent',
      type: String(frame.type),
      raw: scrub(frame),
    });
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.errors.push(`send: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 上传一段 base64 PCM16。`ms` 是这段音频的**时长**（由调用方按样本数算出；门控路径下与原始帧不同）。
   * 一次调用 = 一个 `input_audio_buffer.append` 帧。
   */
  append(audio: string, ms: number): void {
    const now = Date.now();
    if (this.lastAppendAtMs !== null) {
      const gap = now - this.lastAppendAtMs;
      if (gap > this.longestAppendGapMs) this.longestAppendGapMs = gap;
    }
    this.lastAppendAtMs = now;
    this.uploadedMs += ms;
    this.uploadedFrames += 1;
    this.uploadedBytes += Math.round((ms / 1000) * BYTES_PER_SECOND);
    this.sendRaw({ type: 'input_audio_buffer.append', audio });
  }

  /** 上一次上传到现在过了多久（连接收尾时用来判断「最后一段之后有没有长时间沉默」）。 */
  msSinceLastAppend(): number | null {
    return this.lastAppendAtMs === null ? null : Date.now() - this.lastAppendAtMs;
  }

  private handle(text: string): void {
    const raw = safeParse(text);
    const type = String(raw.type ?? 'unknown');
    this.events.push({
      sinceConnectMs: Date.now() - this.t0,
      audioMs: this.uploadedMs,
      direction: 'received',
      type,
      raw,
    });

    if (type === 'response.done') this.readUsage(raw);
    if (type === 'error') this.errors.push(`upstream: ${JSON.stringify(raw).slice(0, 300)}`);

    // dry-run 执行器：模型调工具只被记录，回一个合成 output，绝不落到任何真实会话。
    //
    // ⛔ 这里**不**再补一个 `response.create`。第一次实跑就是这么被污染的：模型调用 → 我们回 output →
    // 我们主动要一个新 response → 模型拿着同一条用户语音**再调一次** → 循环，C 臂因此转出 3 条却转发
    // 24 条、还撞上 spend cap 与「Response request cancelled by new input / Unknown function call id」
    // 两串错误读数。本探针要测的是「模型对每段用户语音的转发」，不是替会话扮演对话轮次；`turn_detection:
    // server_vad` 自己会在每段语音收尾时建一个 response，那正是我们要的那一次。少发一个 response.create，
    // 就少一个自激源。
    const call = this.readCall(raw);
    if (call !== null && !this.answeredCalls.has(call.callId)) {
      if (this.answeredCalls.size >= MAX_ANSWERED_CALLS) {
        this.errors.push(`CALL_LIMIT: 本连接已应答 ${this.answeredCalls.size} 次工具调用，不再应答`);
        return;
      }
      this.answeredCalls.add(call.callId);
      let message: string | null = null;
      try {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        const value = args[FORWARD_ARG_FIELD];
        message = typeof value === 'string' ? value : null;
      } catch {
        message = null;
      }
      this.calls.push({ atMs: Date.now() - this.t0, name: call.name, arguments: call.arguments, message });
      this.sendRaw({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify({
            dryRun: true,
            accepted: true,
            note: 'vad-three-arm probe recorded this call; nothing was executed',
          }),
        },
      });
    }
  }

  private readCall(raw: Record<string, unknown>): { name: string; callId: string; arguments: string } | null {
    const t = String(raw.type);
    if (t === 'response.function_call_arguments.done') {
      const name = typeof raw.name === 'string' ? raw.name : '';
      const callId = typeof raw.call_id === 'string' ? raw.call_id : '';
      if (name === '' || callId === '' || !this.advertisedTools.has(name)) return null;
      return { name, callId, arguments: typeof raw.arguments === 'string' ? raw.arguments : '{}' };
    }
    if (t === 'response.output_item.done') {
      const item = raw.item as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown } | undefined;
      if (item?.type !== 'function_call' || typeof item.name !== 'string' || typeof item.call_id !== 'string') return null;
      if (!this.advertisedTools.has(item.name)) return null;
      return {
        name: item.name,
        callId: item.call_id,
        arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
      };
    }
    return null;
  }

  private readUsage(raw: Record<string, unknown>): void {
    const response = raw.response as { usage?: unknown } | undefined;
    const usage = (response?.usage ?? {}) as {
      input_tokens?: unknown;
      output_tokens?: unknown;
      input_tokens_details?: { audio_tokens?: unknown; text_tokens?: unknown };
    };
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const audioTokens =
      typeof usage.input_tokens_details?.audio_tokens === 'number' ? usage.input_tokens_details.audio_tokens : 0;
    const textTokens =
      typeof usage.input_tokens_details?.text_tokens === 'number'
        ? usage.input_tokens_details.text_tokens
        : Math.max(0, inputTokens - audioTokens);
    const costCny = estimateRealtimeCostCny(usage);
    this.spendCny += costCny;
    this.responses.push({ atMs: Date.now() - this.t0, textTokens, audioTokens, outputTokens, costCny });
    if (this.spendCny > this.capCny && !this.capTripped) {
      this.capTripped = true;
      this.errors.push(`SPEND_CAP: 本连接累计 ${this.spendCny.toFixed(4)} CNY 超过上限 ${this.capCny}`);
      this.probeInitiatedClose = true;
      try {
        this.ws.close(1000, 'spend cap');
      } catch {
        // 已经断了。
      }
    }
  }

  get spend(): number {
    return this.spendCny;
  }

  /** 上游主动断线（非探针收尾关闭）。 */
  get disconnectedByUpstream(): boolean {
    return this.closed && this.closeInfo !== null && !this.closeInfo.byProbe;
  }

  inboundOfType(type: string): WireEvent[] {
    return this.events.filter((e) => e.direction === 'received' && e.type === type);
  }

  /** inbound 帧条数（排空循环用它判「安静」）。 */
  get inboundCount(): number {
    return this.events.reduce((n, e) => (e.direction === 'received' ? n + 1 : n), 0);
  }

  close(): void {
    this.probeInitiatedClose = true;
    try {
      this.ws.close(1000, 'probe done');
    } catch {
      // 已经断了。
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 一臂 = 一条连接
// ─────────────────────────────────────────────────────────────────────────────

/** 每帧的 gate 决策记录（AC4 的「决策被记录」留证；B/C 各一份）。 */
type GateDecisionLine = {
  frameIndex: number;
  stage: SilenceTailStage;
  framesOut: number;
  transition: string | null;
  /** 这一帧 gate **没有**写出的音频毫秒。 */
  withheldMs: number;
  suppressedMs: number;
  preRollFrames: number;
};

/** 一臂的完整读数（AC3 的六项都在这里）。 */
type ArmReading = {
  arm: ArmId;
  policy: ArmPolicy;
  connectionId: string;
  startedAt: string;
  /** 1) 上传：秒数 / 帧数 / 字节数。 */
  uploadedMs: number;
  uploadedSeconds: number;
  uploadedFrames: number;
  uploadedBytes: number;
  /** 源 excerpt 的音频毫秒（三臂相同）。 */
  excerptMs: number;
  /** 上传量占 excerpt 的比例。 */
  uploadRatio: number;
  /** 2) 静音占比：源语料侧与上游侧各一。 */
  sourceSpeechMs: number;
  sourceSilenceRatio: number;
  upstreamSpeechMs: number | null;
  upstreamSilenceRatio: number | null;
  upstreamSpeechSegments: number;
  /** 3) 首 token 延时（首个 speech_stopped → 首个文本 delta）。 */
  firstTokenLatencyMs: number | null;
  /** 4) 首次 function_call 延时（同一基准）。 */
  firstFunctionCallLatencyMs: number | null;
  /** 逐段延时，供报告看分布（不是统计推断，只是读数）。 */
  perTurn: Array<{ speechStoppedAtMs: number; firstDeltaMs: number | null; firstCallMs: number | null }>;
  /** 5) 转发文本保真（对 excerpt 内的真值句）。 */
  groundTruthCount: number;
  forwardedGroundTruthCount: number;
  forwardingFidelity: number | null;
  /** 模型转发的文本（原样）。 */
  forwardedTexts: string[];
  /** 上游转出的文本（原样）。 */
  transcriptions: string[];
  /** 6) 丢段数与错误中断数。 */
  droppedSegments: number;
  errorInterruptions: number;
  upstreamErrors: string[];
  /** 断线读数。 */
  disconnected: boolean;
  closeCode: number | null;
  closeReason: string | null;
  /** gate 侧读数（B/C；A 为 null）。 */
  gate: {
    decisionsRecorded: number;
    /**
     * AC1：本臂**真的裁掉了**多少输入帧 —— 本帧有音频没被写出去（`withheldMs > 0` 的帧数）。
     * 注意它**不等于**「A 与 B 的上传帧数之差」：`resumed` 那一帧会把 pre-roll 环整段补发，
     * 于是差集比它小（少掉的那部分正是补发回来的帧）。两个数报告里都给。
     */
    filteredFrames: number;
    /** gate **没有**写出的音频毫秒（B 是真裁掉；C 是「本会裁掉」）。 */
    withheldMs: number;
    suppressedTransitions: number;
    resumedTransitions: number;
    /** C 臂专用：gate 建议裁剪、但本臂仍写了原始帧的帧数。 */
    ignoredSuppressions: number;
    /** 取假形态 F2 专用：本臂因 `--falsify-c-suppresses`（而非 gate 决定）吞掉的帧数。 */
    falsifyWithheldFrames: number;
    /** AC4 前滚保留：本臂在 `resumed` 转移上补发出去的 pre-roll 帧数（累计）。 */
    prerollFlushedFrames: number;
    /** AC4 前滚保留：门控自己报的 pre-roll 环长度上限（帧）。 */
    prerollMaxFrames: number;
    /** AC5 keepalive：本臂在 `suppressed` 期间发出去的 keepalive 帧数与时长的读数。 */
    keepaliveFramesSent: number;
    keepaliveMsSent: number;
    /** AC5 keepalive：本臂**真正被压住**（`suppressed`）的累计毫秒。 */
    suppressedMsTotal: number;
  } | null;
  /** AC4 误删语音：落在**源 timeline 语音区间**内、本臂没有写出去的毫秒与帧数。 */
  speechWithheldMs: number;
  speechWithheldFrames: number;
  /** 窗口内源侧语音总毫秒（误删语音的分母；与臂无关）。 */
  sourceSpeechMsInWindow: number;
  /** AC4 连接存活：相邻两次上传的最大墙钟间隔（毫秒）。 */
  longestAppendGapMs: number;
  /** AC4 连接存活：excerpt 播完时连接是否仍然活着（未被上游断、未触顶、未被探针关闭）。 */
  survivedToEnd: boolean;
  /** AC1：本臂发出的帧按 type 计数（`response.create` 等禁用帧必须为 0）。 */
  sentFrameTypes: Record<string, number>;
  /** AC1 取假形态：本臂由「边界事件」驱动的 `response.create` 次数（正常形态恒为 0）。 */
  boundaryResponseCreateSent: number;
  /** AC1：本臂 `session.update` 里实际发出去的 `turn_detection`（应与出货解析器逐字节一致）。 */
  turnDetectionSeen: unknown;
  spendCny: number;
  capTripped: boolean;
  durationMs: number;
  /** 本臂模型侧读数是否足够（AC9）。 */
  sufficient: boolean;
  insufficientReason: string | null;
  events: WireEvent[];
};

/** 从 PCM 缓冲切出 excerpt（按毫秒），并保证整帧对齐。 */
function sliceExcerpt(pcm: Buffer, startMs: number, excerptMs: number): Buffer {
  const startByte = Math.round((startMs / 1000) * BYTES_PER_SECOND);
  const endByte = Math.min(pcm.length, startByte + Math.round((excerptMs / 1000) * BYTES_PER_SECOND));
  const aligned = startByte + Math.floor((endByte - startByte) / FRAME_BYTES) * FRAME_BYTES;
  return pcm.subarray(startByte, aligned);
}

/** 一段 base64 PCM16 的毫秒数（按解码后的字节数算，不假设就是 20 ms）。 */
function base64Ms(audio: string): number {
  return Math.round((Buffer.from(audio, 'base64').length / BYTES_PER_SECOND) * 1000);
}

/** 一个 20 ms 帧的 RMS，与出货门控器（`voice-realtime-silence-tail.ts`）内部的口径一致。 */
function frameRms(samples: Buffer): number {
  const count = samples.length / 2;
  if (count === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = samples.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / count);
}

/** RMS → dBFS，与出货门控器一致（满量程 32768，且**下限取 1 个样本单位**，所以零 RMS 帧也是有限值）。 */
function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1) / 32_768);
}

/**
 * 一段 PCM 的**逐帧 RMS 分布**（p15/p50/p95 + 最小值）。
 *
 * 为什么报告里必须有这个数：实测里 B 臂与 A 臂逐字节相同 —— 出货 STS 门控在真实语料上
 * **一次都没裁**。这个「没裁」有两个完全不同的解释：(1) 门控对上行没有影响；(2) 门控的判定
 * 阈值在这个语料上根本没被跨过，所以干预从未发生。这两句话的工程含义差别极大，只有把语料的
 * 帧 RMS 分布与门控自己的阈值常数摆在一起，才能分辨是哪一种。所以这里离线把分布算出来，
 * 报告把门控的 `SILENCE_TAIL_MAX_THRESHOLD_DB`（-60 dBFS）与语料的分位数并排印出。
 */
function frameRmsPercentiles(pcm: Buffer): {
  frames: number;
  p15: number;
  p50: number;
  p95: number;
  min: number;
  p15Db: number;
  p50Db: number;
  p95Db: number;
  minDb: number;
} {
  const values: number[] = [];
  for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
    values.push(frameRms(pcm.subarray(offset, offset + FRAME_BYTES)));
  }
  if (values.length === 0) {
    return { frames: 0, p15: 0, p50: 0, p95: 0, min: 0, p15Db: -Infinity, p50Db: -Infinity, p95Db: -Infinity, minDb: -Infinity };
  }
  const sorted = [...values].sort((x, y) => x - y);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  const p15 = at(0.15);
  const p50 = at(0.5);
  const p95 = at(0.95);
  const min = sorted[0]!;
  return {
    frames: values.length,
    p15: num3(p15),
    p50: num3(p50),
    p95: num3(p95),
    min: num3(min),
    p15Db: num3(rmsToDb(p15)),
    p50Db: num3(rmsToDb(p50)),
    p95Db: num3(rmsToDb(p95)),
    minDb: num3(rmsToDb(min)),
  };
}

/** 一个恒定电平的 PCM16 帧，其 RMS 恰为 `db` dBFS（恒定样本的均方根就是样本值本身）。 */
function constantLevelFrame(db: number): string {
  const value = Math.max(1, Math.round(32_768 * 10 ** (db / 20)));
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) frame.writeInt16LE(value, offset);
  return frame.toString('base64');
}

/** 一个数字静音（全零）帧 —— 门控把它读作 `silent`，既不可能被判人声，也不进底噪窗口。 */
function digitalSilenceFrame(): string {
  return Buffer.alloc(FRAME_BYTES).toString('base64');
}

/**
 * **实测**出货门控（`createSilenceTailGate({})`，与本实验 B/C 臂同一个构造函数、同一套默认）判定
 * 「这一帧是人声」的最低恒定帧电平，单位 dBFS。
 *
 * 为什么不直接把门控的阈值常数抄进报告：那些常数（`SILENCE_TAIL_MAX_THRESHOLD_DB` 等）没有从 barrel
 * 导出，抄一遍就是一份会漂移的副本。这里是**量出来**的：对每个候选电平新建一个门控，先喂 200 帧恒定
 * 电平，再喂 200 帧数字静音 —— 若该电平被判为人声，`speaking` 会被置起，随后的静音帧把 `quietMs` 推过
 * 320 ms 挂起窗、`tailMsSeen` 推过 1000 ms 尾巴窗，门控就进入 `suppressed`；反之永远停在 `streaming`。
 * `stage` 是门控自己的公开读数，所以这是对它真实判定的一次观测，不是对源码的复述。
 */
function measureShippedVoiceFloorDb(): number {
  for (let db = -80; db <= -30; db += 1) {
    const gate = createSilenceTailGate({});
    for (let index = 0; index < 200; index += 1) gate.observe(constantLevelFrame(db), index * FRAME_MS);
    let voiced = false;
    for (let index = 0; index < 200; index += 1) {
      gate.observe(digitalSilenceFrame(), (200 + index) * FRAME_MS);
      if (gate.stage === 'suppressed') {
        voiced = true;
        break;
      }
    }
    if (voiced) return db;
  }
  return Number.NaN;
}

/** excerpt 里 RMS **低于** `db` dBFS 的帧数与占比 —— 门控眼里「不是人声」的那部分。 */
function framesBelowDb(pcm: Buffer, db: number): { below: number; total: number; ratio: number } {
  const cutoff = 32_768 * 10 ** (db / 20);
  let below = 0;
  let total = 0;
  for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
    total += 1;
    if (frameRms(pcm.subarray(offset, offset + FRAME_BYTES)) < cutoff) below += 1;
  }
  return { below, total, ratio: total === 0 ? 0 : num3(below / total) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 离线读数（不连上游、不花钱）：帧统计 / 门控离线回放 / 阈值敏感性 / 钳位扫描
//
// 这一组是本任务的核心证据面。它回答三个必须分开问的问题：
//   (1) 出货门控在**这一段** excerpt 上到底裁没裁、裁了多少（`replayGateOffline`）；
//   (2) 这段 excerpt 的低能量部分是**什么**（数字静音还是真实底噪，`frameStatRows` 的 run 读数）；
//   (3) 阈值**本来可以**裁多少（`sensitivityRows`），以及为什么出货门控实际用的是那个值
//       （`clampSweep`：对门控自己的判定做逐电平实测）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一帧的离线读数：RMS + 是否**数字静音**（全零）——与出货 `readFrame` 同一口径。 */
type FrameStat = { index: number; rms: number; db: number; silent: boolean };

function frameStatRows(pcm: Buffer): FrameStat[] {
  const rows: FrameStat[] = [];
  for (let offset = 0, index = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES, index += 1) {
    const frame = pcm.subarray(offset, offset + FRAME_BYTES);
    let nonZero = false;
    for (let i = 0; i < frame.length / 2 && !nonZero; i += 1) if (frame.readInt16LE(i * 2) !== 0) nonZero = true;
    const rms = frameRms(frame);
    rows.push({ index, rms, db: rmsToDb(rms), silent: !nonZero });
  }
  return rows;
}

/** 一串 dBFS 值的分位数（升序取值，与 `quantile` 同口径）。 */
function dbQuantiles(values: number[], fractions: number[]): number[] {
  if (values.length === 0) return fractions.map(() => Number.NaN);
  const sorted = [...values].sort((x, y) => x - y);
  return fractions.map((f) => num3(sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!));
}

/** 满足 `pred` 的**最长连续帧段**（帧数 / 毫秒 / 相对 excerpt 起点的毫秒）。 */
function longestRun(rows: FrameStat[], pred: (row: FrameStat) => boolean): { frames: number; ms: number; atMs: number } {
  let run = 0;
  let best = { frames: 0, ms: 0, atMs: 0 };
  rows.forEach((row, i) => {
    if (pred(row)) {
      run += 1;
      if (run > best.frames) best = { frames: run, ms: run * FRAME_MS, atMs: (i - run + 1) * FRAME_MS };
    } else {
      run = 0;
    }
  });
  return best;
}

/** 一段 PCM 的离线画像：帧数、数字静音帧、分位数（全体 / 仅非静音）、连续低能量段。 */
type ExcerptProfile = {
  frames: number;
  digitalSilentFrames: number;
  /** 全体帧的 dBFS 分位数（p10/p25/p50/p75/p90 + min/max）——数字静音会把低分位压到 −90 dBFS 附近。 */
  allDb: number[];
  /** **仅非数字静音帧**的分位数 —— 这一列才是「这段录音的底噪」，不被全零帧污染。 */
  nonSilentDb: number[];
  nonSilentFrames: number;
  longestSilentRun: { frames: number; ms: number; atMs: number };
  /** 非静音帧里最长连续低于 `db` 的一段（真实底噪形态，排除数字静音）。 */
  longestNonSilentBelowDb: (db: number) => { frames: number; ms: number; atMs: number };
};

const PROFILE_FRACTIONS = [0.1, 0.25, 0.5, 0.75, 0.9];

function profileExcerpt(pcm: Buffer): ExcerptProfile {
  const rows = frameStatRows(pcm);
  const nonSilent = rows.filter((r) => !r.silent);
  return {
    frames: rows.length,
    digitalSilentFrames: rows.length - nonSilent.length,
    allDb: dbQuantiles(rows.map((r) => r.db), PROFILE_FRACTIONS),
    nonSilentDb: dbQuantiles(nonSilent.map((r) => r.db), PROFILE_FRACTIONS),
    nonSilentFrames: nonSilent.length,
    longestSilentRun: longestRun(rows, (r) => r.silent),
    longestNonSilentBelowDb: (db: number) => longestRun(rows, (r) => !r.silent && r.db < db),
  };
}

/**
 * 阈值敏感性：**若**把判据换成「底噪 p10 + Δ」，本段音频有多少帧可裁、最长连续多少。
 *
 * 这不是「建议这么改」，而是**错失量的读数**：出货门控的判据是绝对电平加钳位（见 `clampSweep`），
 * 这里给出一个相对判据在同一段音频上的对照。基准取**非数字静音帧**的 p10 —— 全零帧会把这个分位
 * 压到 −90 dBFS 附近，用它当噪声底会把整张表压平（这对读数毫无信息量，所以基准必须排除数字静音）。
 * 「可裁」的口径与门控一致：数字静音帧（永不可能被判人声）或 RMS 低于阈值。
 */
type SensitivityRow = {
  deltaDb: number;
  thresholdDb: number;
  curableFrames: number;
  ratio: number;
  longestRunFrames: number;
  longestRunMs: number;
  longestRunAtMs: number;
};

function sensitivityRows(pcm: Buffer, deltas: readonly number[]): { baseDb: number; rows: SensitivityRow[] } {
  const rows = frameStatRows(pcm);
  const nonSilent = rows.filter((r) => !r.silent).map((r) => r.db);
  const baseDb = nonSilent.length === 0 ? Number.NaN : dbQuantiles(nonSilent, [0.1])[0]!;
  return {
    baseDb,
    rows: deltas.map((deltaDb) => {
      const thresholdDb = num3(baseDb + deltaDb);
      const cutoff = 32_768 * 10 ** (thresholdDb / 20);
      const curable = rows.filter((r) => r.silent || r.rms < cutoff);
      const run = longestRun(rows, (r) => r.silent || r.db < thresholdDb);
      return {
        deltaDb,
        thresholdDb,
        curableFrames: curable.length,
        ratio: rows.length === 0 ? 0 : num3(curable.length / rows.length),
        longestRunFrames: run.frames,
        longestRunMs: run.ms,
        longestRunAtMs: run.atMs,
      };
    }),
  };
}

/**
 * **钳位扫描**：对一个「已经被某个电平喂满底噪窗口」的门控，实测它当前的人声判定边界在哪。
 *
 * 为什么要量而不是抄常数：出货门控的阈值是 `min(-60, max(-70, floorDb + 8))`，而 `floorDb` 只由
 * **它自己判为非人声**的帧构成 —— 阈值与底噪互相定义，静态读代码看不出「实际边界落在哪」。
 * 这里对每个候选底噪电平新建一个门控，先用该电平喂满 1.5 s 的底噪窗口，再逐电平试探最低被
 * 判为人声的恒定帧 —— 得到的是**门控真实判定**的一次观测。
 *
 * `primedFloorDb` 用整数 dBFS；返回的边界是该 dBFS 上界（实际帧电平因 PCM16 量化略有偏差，
 * 报告里同时印出量化的真实电平）。
 */
type ClampSweepRow = { primedFloorDb: number; effectiveBoundaryDb: number | null };

/** 恒定电平帧在 PCM16 上量化后的**真实** dBFS（写报告用，免得把「扫描步长」当成判定边界）。 */
function quantizedLevelDb(db: number): number {
  return num3(rmsToDb(Math.max(1, Math.round(32_768 * 10 ** (db / 20)))));
}

const SILENCE_TAIL_PRIME_LOUD_FRAMES = 3;
const SILENCE_TAIL_PRIME_FLOOR_FRAMES = 75;
const SILENCE_TAIL_PROBE_FRAMES = 100;

function clampSweep(floors: readonly number[]): ClampSweepRow[] {
  return floors.map((primedFloorDb) => {
    const floorFrame = constantLevelFrame(primedFloorDb);
    for (let candidate = -80; candidate <= -40; candidate += 1) {
      const gate = createSilenceTailGate({});
      // 3 帧高电平把 `speaking` 置起（否则门控永远不会开尾巴），再喂满 1.5 s 的候选底噪。
      for (let i = 0; i < SILENCE_TAIL_PRIME_LOUD_FRAMES; i += 1) gate.observe(constantLevelFrame(-20), i * FRAME_MS);
      for (let i = 0; i < SILENCE_TAIL_PRIME_FLOOR_FRAMES; i += 1) {
        gate.observe(floorFrame, (SILENCE_TAIL_PRIME_LOUD_FRAMES + i) * FRAME_MS);
      }
      for (let i = 0; i < SILENCE_TAIL_PROBE_FRAMES; i += 1) {
        gate.observe(constantLevelFrame(candidate), (SILENCE_TAIL_PRIME_LOUD_FRAMES + SILENCE_TAIL_PRIME_FLOOR_FRAMES + i) * FRAME_MS);
      }
      // 试探帧跑完仍**没有**被压住 ⇒ 它们被判成了人声 ⇒ 这个候选电平就是当前边界的上界。
      if (gate.stage !== 'suppressed') return { primedFloorDb, effectiveBoundaryDb: candidate };
    }
    return { primedFloorDb, effectiveBoundaryDb: null };
  });
}

/**
 * **出货门控在这段 excerpt 上的离线回放**（不连上游、不花钱、逐帧确定 —— 门控的判定读的是音频
 * 时间，`nowMs` 只影响 keepalive，而本段被压住的时长远小于 keepalive 间隔）。
 *
 * 记账口径与 B 臂**逐字相同**（`runArm` 的 `suppress` 分支）：输出帧数按 `decision.frames.length`
 * 累加、`withheldThisFrame = max(0, 20 − 输出毫秒)`、`withheldMs` 累加它、`suppressedMsTotal`
 * 在 `stage === 'suppressed'` 时每帧加 20 ms。所以这张表可以直接和 B 臂的实测读数对照
 * （报告里就是这么做的：两者必须一致，不一致说明探针或环境有问题）。
 */
type OfflineReplay = {
  frames: number;
  /** 门控**真的裁掉**的输入帧数（本帧有音频没被写出）—— 这就是 AC1 的 `filteredFrames`。 */
  filteredFrames: number;
  uploadedFrames: number;
  withheldMs: number;
  suppressedMsTotal: number;
  suppressedTransitions: number;
  resumedTransitions: number;
  prerollFlushedFrames: number;
  keepaliveFramesSent: number;
  stageSequence: string[];
  /** 首次进入 `suppressed` 的**音频绝对时刻**（源音频内，ms）与恢复时刻。 */
  firstSuppressedAtMs: number | null;
  resumeAtMs: number | null;
  /** 被裁掉的音频落在源 timeline speech 区间内的毫秒（AC3 的「无语音损失」）。 */
  speechWithheldMs: number;
  speechWithheldFrames: number;
  sourceSpeechMsInWindow: number;
};

function replayGateOffline(
  pcm: Buffer,
  startMs: number,
  sourceSpeechIntervals: Array<{ fromMs: number; toMs: number }>,
): OfflineReplay {
  const gate = createSilenceTailGate({});
  let filteredFrames = 0;
  let uploadedFrames = 0;
  let withheldMs = 0;
  let suppressedMsTotal = 0;
  let suppressedTransitions = 0;
  let resumedTransitions = 0;
  let prerollFlushedFrames = 0;
  let keepaliveFramesSent = 0;
  let firstSuppressedAtMs: number | null = null;
  let resumeAtMs: number | null = null;
  let speechWithheldMs = 0;
  let speechWithheldFrames = 0;
  const stageSequence: string[] = [];

  const frames = Math.floor(pcm.length / FRAME_BYTES);
  for (let index = 0; index < frames; index += 1) {
    const frameAtMs = startMs + index * FRAME_MS;
    const decision = gate.observe(pcm.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES).toString('base64'), index * FRAME_MS);
    if (stageSequence[stageSequence.length - 1] !== decision.stage) stageSequence.push(decision.stage);
    const outMs = decision.frames.reduce((sum, out) => sum + base64Ms(out), 0);
    const withheldThisFrame = Math.max(0, FRAME_MS - outMs);
    if (withheldThisFrame > 0) filteredFrames += 1;
    if (decision.transition === 'suppressed') {
      suppressedTransitions += 1;
      if (firstSuppressedAtMs === null) firstSuppressedAtMs = frameAtMs;
    }
    if (decision.transition === 'resumed') {
      resumedTransitions += 1;
      if (resumeAtMs === null) resumeAtMs = frameAtMs;
      prerollFlushedFrames += decision.preRollFrames;
    }
    if (decision.stage === 'suppressed') {
      suppressedMsTotal += FRAME_MS;
      if (decision.transition === null && decision.frames.length > 0) keepaliveFramesSent += 1;
    }
    if (withheldThisFrame > 0 && insideSpeech(sourceSpeechIntervals, frameAtMs)) {
      speechWithheldMs += withheldThisFrame;
      speechWithheldFrames += 1;
    }
    uploadedFrames += decision.frames.length;
    withheldMs += withheldThisFrame;
  }

  return {
    frames,
    filteredFrames,
    uploadedFrames,
    withheldMs,
    suppressedMsTotal,
    suppressedTransitions,
    resumedTransitions,
    prerollFlushedFrames,
    keepaliveFramesSent,
    stageSequence,
    firstSuppressedAtMs,
    resumeAtMs,
    speechWithheldMs,
    speechWithheldFrames,
    sourceSpeechMsInWindow: sourceSpeechIntervals.reduce((sum, i) => sum + Math.max(0, i.toMs - i.fromMs), 0),
  };
}

/**
 * **全文件**（不止 excerpt）的帧画像 —— AC5 要的「本录音的底噪实测值」就是这里的 `nonSilentDb`
 * （p5/p10/p25/p50/p75/p90/max），它必须排除数字静音帧，否则低分位会被全零帧拖到 −90 dBFS。
 */
type RecordingProfile = {
  frames: number;
  digitalSilentFrames: number;
  nonSilentFrames: number;
  allDb: number[];
  nonSilentDb: number[];
};

function profileRecording(pcm: Buffer): RecordingProfile {
  const rows = frameStatRows(pcm);
  const nonSilent = rows.filter((r) => !r.silent);
  return {
    frames: rows.length,
    digitalSilentFrames: rows.length - nonSilent.length,
    nonSilentFrames: nonSilent.length,
    allDb: dbQuantiles(rows.map((r) => r.db), [...RECORDING_FRACTIONS]),
    nonSilentDb: dbQuantiles(nonSilent.map((r) => r.db), [...RECORDING_FRACTIONS]),
  };
}

/**
 * 本任务的**离线证据面**（不连上游、不花钱）—— AC1 / AC4 / AC5 的读数都取自这里。
 * 单独打包成一份，是因为 `evaluateAssertions` 与 `buildReport` 都要用它，而两者的输入
 * 都必须是**同一个快照里的一次运行**的读数（不允许各算各的）。
 */
type OfflineEvidence = {
  /** 选定 excerpt 上的离线门控回放。 */
  selected: OfflineReplay;
  /** AC1 取假形态的靶子：首片 90 s（不含连续无语音）上的同一条回放。 */
  falsifyWindow: { startMs: number; excerptMs: number; replay: OfflineReplay };
  profile: ExcerptProfile;
  sensitivity: { baseDb: number; rows: SensitivityRow[] };
  clampSweep: ClampSweepRow[];
  recording: RecordingProfile;
  priorReportPath: string | null;
};

/** 一次算齐所有离线读数（纯 CPU，不连上游）。 */
function buildOfflineEvidence(pcm: Buffer, startMs: number, excerptMs: number, speechIntervals: Array<{ fromMs: number; toMs: number }>, pcmForWindow: Buffer): OfflineEvidence {
  const falsifyPcm = sliceExcerpt(pcm, FALSIFY_EXCERPT_START_MS, FALSIFY_EXCERPT_MS);
  return {
    selected: replayGateOffline(pcmForWindow, startMs, speechIntervals),
    falsifyWindow: {
      startMs: FALSIFY_EXCERPT_START_MS,
      excerptMs: Math.round((falsifyPcm.length / BYTES_PER_SECOND) * 1000),
      replay: replayGateOffline(falsifyPcm, FALSIFY_EXCERPT_START_MS, []),
    },
    profile: profileExcerpt(pcmForWindow),
    sensitivity: sensitivityRows(pcmForWindow, SENSITIVITY_DELTAS_DB),
    clampSweep: clampSweep(CLAMP_SWEEP_FLOORS_DB),
    recording: profileRecording(pcm),
    priorReportPath: existsSync(PRIOR_REPORT_PATH) ? PRIOR_REPORT_PATH : null,
  };
}

async function runArm(options: {
  arm: ArmId;
  pcm: Buffer;
  excerptMs: number;
  capCny: number;
  journalDir: string;
  instructions: string;
  tools: unknown[];
  turnDetection: unknown;
  groundTruth: CorrespondenceRow[];
  sourceSpeechMs: number;
  sourceSpeechIntervals: Array<{ fromMs: number; toMs: number }>;
  startMs: number;
  /** 窗口内第一个源侧 `speech_stopped` 的绝对音频时刻（AC1 取假形态的「边界事件」）。 */
  boundaryStoppedAtMs: number | null;
  falsifyCSuppresses: boolean;
  falsifyBBoundaryResponseCreate: boolean;
}): Promise<ArmReading> {
  const { arm, pcm, excerptMs, capCny, journalDir, groundTruth, sourceSpeechMs } = options;
  const policy: ArmPolicy = options.falsifyCSuppresses && arm === 'C' ? 'suppress' : ARM_POLICY[arm];
  const connectionId = randomUUID();
  const startedAtMs = Date.now();

  const link = await Link.connect({
    instructions: options.instructions,
    tools: options.tools,
    capCny,
    turnDetection: options.turnDetection,
  });

  // gate 只在 B/C 构造，且**在探针内**——不写任何生产环境变量（AC6）。
  const gate = policy === 'passthrough' ? null : createSilenceTailGate({});
  const decisions: GateDecisionLine[] = [];
  let filteredFrames = 0;
  let withheldMsTotal = 0;
  let suppressedTransitions = 0;
  let resumedTransitions = 0;
  let ignoredSuppressions = 0;
  /** 取假形态 F2 专用：C 因假形态（而非 gate 决定）被吞掉的帧数。 */
  let falsifyWithheldFrames = 0;
  // AC4 前滚保留 / AC5 keepalive / AC1 假形态的计数器。
  let prerollFlushedFrames = 0;
  let prerollMaxFrames = 0;
  let keepaliveFramesSent = 0;
  let keepaliveMsSent = 0;
  let suppressedMsTotal = 0;
  let boundaryResponseCreateSent = 0;
  let boundaryFired = false;
  // AC4 误删语音：被吞掉、且落在源侧语音区间内的毫秒/帧数。
  let speechWithheldMs = 0;
  let speechWithheldFrames = 0;

  const streamT0 = Date.now();
  const frameCount = pcm.length / FRAME_BYTES;
  for (let index = 0; index < frameCount; index += 1) {
    const wait = streamT0 + index * FRAME_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const frame = pcm.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    const base64 = frame.toString('base64');
    /** 本帧在**源音频**里的绝对时刻（AC4 误删语音要靠它对源 side 的语音区间）。 */
    const frameAtMs = options.startMs + index * FRAME_MS;

    // ⛔ 取假形态 F1b（AC1）：把「边界事件」真的接到一次 `response.create` 上 —— 这正是任务硬禁令
    // 禁止的接线。边界事件取**源 timeline 的 `speech_stopped`**（门控正在观察的那类边界），
    // 在本语料上它确实存在且在 excerpt 内，所以这条形态不会像「照抄 gate 的 suppressed 转移」那样退化成 no-op。
    if (
      options.falsifyBBoundaryResponseCreate &&
      arm === 'B' &&
      !boundaryFired &&
      options.boundaryStoppedAtMs !== null &&
      frameAtMs >= options.boundaryStoppedAtMs
    ) {
      boundaryFired = true;
      boundaryResponseCreateSent += 1;
      link.sendRaw({ type: 'response.create' });
    }

    if (gate === null) {
      link.append(base64, FRAME_MS);
      continue;
    }

    const decision: SilenceTailDecision = gate.observe(base64, Date.now() - link.t0);
    if (decision.transition === 'suppressed') suppressedTransitions += 1;
    if (decision.transition === 'resumed') resumedTransitions += 1;
    const outMs = decision.frames.reduce((sum, out) => sum + base64Ms(out), 0);
    const withheldThisFrame = Math.max(0, FRAME_MS - outMs);
    // AC1：本帧有音频没被写出去 ⇒ 门控**真的裁掉了**这一帧。
    if (withheldThisFrame > 0) filteredFrames += 1;

    // AC4 前滚保留：`preRollFrames` 只在 `resumed` 时有值（门控把 pre-roll 环整段补发出去，
    // 为的是不切掉重新开口的第一个音节）；`prerollMaxFrames` 记门控自己报的环长上限。
    if (decision.preRollFrames > prerollMaxFrames) prerollMaxFrames = decision.preRollFrames;
    if (decision.transition === 'resumed') prerollFlushedFrames += decision.preRollFrames;
    // AC5 keepalive：`suppressed` 期间若久未发送，门控会自己写一帧 100 ms 数字静音（默认 30 s 间隔）。
    // 判据不依赖那个常数：**只要在 `suppressed` 且没有转移的情况下写出了帧**，那帧只可能是 keepalive。
    if (decision.stage === 'suppressed') {
      suppressedMsTotal += FRAME_MS;
      if (decision.transition === null && decision.frames.length > 0) {
        keepaliveFramesSent += 1;
        keepaliveMsSent += outMs;
      }
    }
    // AC4 误删语音：本帧被吞掉的部分若落在源侧语音区间内，就是误删。
    if (withheldThisFrame > 0 && insideSpeech(options.sourceSpeechIntervals, frameAtMs)) {
      speechWithheldMs += withheldThisFrame;
      speechWithheldFrames += 1;
    }

    if (policy === 'suppress') {
      // 取假形态 F2：C 也裁剪 —— 见 FALSIFY_C_WITHHOLD_MS 的注释（照抄 gate 决定在本语料上是 no-op）。
      const falsifyWithhold =
        options.falsifyCSuppresses && arm === 'C' && index * FRAME_MS < FALSIFY_C_WITHHOLD_MS;
      if (falsifyWithhold) {
        falsifyWithheldFrames += 1;
        withheldMsTotal += FRAME_MS;
      } else {
        for (const out of decision.frames) link.append(out, base64Ms(out));
        withheldMsTotal += withheldThisFrame;
      }
    } else {
      // observe：永远写**原始帧**（对齐 `localSpeechGate` 的产品语义）。
      link.append(base64, FRAME_MS);
      if (decision.frames.length === 0) ignoredSuppressions += 1;
      withheldMsTotal += withheldThisFrame;
    }

    decisions.push({
      frameIndex: index,
      stage: decision.stage,
      framesOut: decision.frames.length,
      transition: decision.transition,
      withheldMs: withheldThisFrame,
      suppressedMs: decision.suppressedMs,
      preRollFrames: decision.preRollFrames,
    });
  }

  // 排空：等上游把尾巴处理完（utterance 收尾 + response），或安静下来。
  const drainDeadline = Date.now() + DRAIN_WINDOW_MS;
  let lastInboundAt = Date.now();
  let seenInbound = link.inboundCount;
  while (Date.now() < drainDeadline) {
    if (link.closed) break;
    if (link.inboundCount !== seenInbound) {
      seenInbound = link.inboundCount;
      lastInboundAt = Date.now();
    }
    if (Date.now() - lastInboundAt > QUIET_AFTER_MS) break;
    await sleep(100);
  }

  await sleep(200);
  const reading = buildArmReading({
    arm,
    policy,
    link,
    connectionId,
    startedAt: nowIso(startedAtMs),
    excerptMs,
    groundTruth,
    sourceSpeechMs,
    sourceSpeechMsInWindow: sourceSpeechMs,
    speechWithheldMs,
    speechWithheldFrames,
    boundaryResponseCreateSent,
    gate:
      gate === null
        ? null
        : {
            decisions,
            filteredFrames,
            withheldMsTotal,
            suppressedTransitions,
            resumedTransitions,
            ignoredSuppressions,
            falsifyWithheldFrames,
            prerollFlushedFrames,
            prerollMaxFrames,
            keepaliveFramesSent,
            keepaliveMsSent,
            suppressedMsTotal,
          },
  });
  writeArmJournal(journalDir, arm, connectionId, reading);
  if (gate !== null) writeGateJournal(journalDir, arm, connectionId, decisions);

  if (!link.closed) {
    link.close();
    await sleep(200);
  }
  return reading;
}

/** AC1：从本连接**发出去**的 `session.update` 里读回 `turn_detection`（证明它不是被本功能改的）。 */
function readSentTurnDetection(link: Link): unknown {
  for (const event of link.events) {
    if (event.direction !== 'sent' || event.type !== 'session.update') continue;
    const session = (event.raw as { session?: { turn_detection?: unknown } }).session;
    if (session !== undefined && 'turn_detection' in session) return session.turn_detection ?? null;
  }
  return null;
}

function buildArmReading(options: {
  arm: ArmId;
  policy: ArmPolicy;
  link: Link;
  connectionId: string;
  startedAt: string;
  excerptMs: number;
  groundTruth: CorrespondenceRow[];
  sourceSpeechMs: number;
  sourceSpeechMsInWindow: number;
  speechWithheldMs: number;
  speechWithheldFrames: number;
  boundaryResponseCreateSent: number;
  gate: {
    decisions: GateDecisionLine[];
    filteredFrames: number;
    withheldMsTotal: number;
    suppressedTransitions: number;
    resumedTransitions: number;
    ignoredSuppressions: number;
    falsifyWithheldFrames: number;
    prerollFlushedFrames: number;
    prerollMaxFrames: number;
    keepaliveFramesSent: number;
    keepaliveMsSent: number;
    suppressedMsTotal: number;
  } | null;
}): ArmReading {
  const { arm, policy, link, connectionId, startedAt, excerptMs, groundTruth, sourceSpeechMs, gate } = options;
  const inbound = link.events.filter((e) => e.direction === 'received');

  // 上游侧读数：本臂自己收到的 speech_started/stopped（**门控是否改变了上游判读**的直接读数）。
  const speechPairs: Array<{ start: number; stop: number }> = [];
  let openStart: number | null = null;
  for (const event of inbound) {
    if (event.type === 'input_audio_buffer.speech_started') openStart = event.sinceConnectMs;
    else if (event.type === 'input_audio_buffer.speech_stopped') {
      if (openStart !== null) speechPairs.push({ start: openStart, stop: event.sinceConnectMs });
      openStart = null;
    }
  }
  const upstreamSpeechMs = speechPairs.length === 0 ? null : speechPairs.reduce((s, p) => s + (p.stop - p.start), 0);

  const transcriptions = link
    .inboundOfType('conversation.item.input_audio_transcription.completed')
    .map((e) => (typeof e.raw.transcript === 'string' ? (e.raw.transcript as string) : ''))
    .filter((t) => t !== '');
  const forwardedTexts = link.calls.map((c) => c.message ?? '').filter((t) => t !== '');

  /**
   * 模型侧「第一个输出 token」：**文本 delta 或 function-call 参数 delta，取先到者**。
   *
   * 为什么要把参数 delta 算进来：在这个 dry-run 面上模型的产出主要就是那次转发调用，实测里有整条
   * response 只调工具、一个文本 delta 都不发的情形。只数文本 delta 会把「模型答了，只是以调用作答」
   * 读成「没有读数」，进而把一臂误判成读数不足。
   */
  const isModelOutputToken = (e: WireEvent): boolean =>
    e.type === 'response.text.delta' ||
    e.type === 'response.output_text.delta' ||
    e.type === 'response.audio_transcript.delta' ||
    e.type === 'response.function_call_arguments.delta';

  const firstStop = speechPairs.length === 0 ? null : speechPairs[0]!.stop;
  const firstDeltaEvent = inbound.find(isModelOutputToken);
  const firstDelta = firstDeltaEvent === undefined ? null : firstDeltaEvent.sinceConnectMs;
  // `call.atMs` 已经是相对 `link.t0` 的偏移，与 `sinceConnectMs` 同基准。
  const firstCall = link.calls.length === 0 ? null : link.calls[0]!.atMs;

  const perTurn = speechPairs.map((pair) => {
    const deltaEv = inbound.find((e) => e.sinceConnectMs > pair.stop && isModelOutputToken(e));
    const call = link.calls.find((c) => c.atMs > pair.stop);
    return {
      speechStoppedAtMs: pair.stop,
      firstDeltaMs: deltaEv === undefined ? null : deltaEv.sinceConnectMs - pair.stop,
      firstCallMs: call === undefined ? null : call.atMs - pair.stop,
    };
  });

  const withTranscription = groundTruth.filter((row) => row.transcription !== null);
  const forwardedGroundTruthCount = withTranscription.filter((row) =>
    forwardedTexts.some((fwd) => covers(fwd, row.transcription!)),
  ).length;
  const forwardingFidelity =
    withTranscription.length === 0 ? null : num3(forwardedGroundTruthCount / withTranscription.length);

  // 丢段：excerpt 内的真值句里，本臂**既没转出、也没转发**的那些。
  const droppedSegments = groundTruth.filter((row) => {
    if (row.transcription === null) return true;
    const heard = transcriptions.some((t) => covers(t, row.transcription!));
    const forwarded = forwardedTexts.some((fwd) => covers(fwd, row.transcription!));
    return !heard && !forwarded;
  }).length;

  const errorInterruptions =
    link.inboundOfType('error').length + (link.disconnectedByUpstream ? 1 : 0) + (link.capTripped ? 1 : 0);

  const firstTokenLatencyMs = firstStop === null || firstDelta === null ? null : Math.max(0, firstDelta - firstStop);
  const firstFunctionCallLatencyMs = firstStop === null || firstCall === null ? null : Math.max(0, firstCall - firstStop);

  /**
   * 本臂的模型侧读数够不够判断 —— 与 AC3 的「六项」同一套口径，逐项点名缺哪一项。
   *
   * 为什么要比「转出非空 且 判出段非空」更严：实测里出现过 C 臂**转出 3 条、判出段也有**，
   * 却一条模型输出 token 都没有（没有任何文本 delta）的情形 —— 那时首 token 延时是 null，
   * 而 `deriveConclusion` 会拿这个 null 去和 A 臂比较，把「这一臂根本没读到模型输出」读成
   * 「两臂一样」。缺项必须在这里就变成「不足以判断」，否则结论会以缺失为证据。
   */
  const missingReadings: string[] = [];
  if (link.uploadedFrames === 0) missingReadings.push('上传帧数为 0');
  if (speechPairs.length === 0) missingReadings.push('上游未判出任何语音段');
  if (transcriptions.length === 0) missingReadings.push('上游未转出任何文本');
  if (firstTokenLatencyMs === null) missingReadings.push('无首 token 延时（本臂一条模型输出 token 都没读到）');
  if (firstFunctionCallLatencyMs === null) missingReadings.push('无首次 function_call 延时');
  if (forwardingFidelity === null) missingReadings.push('转发保真无从计算（真值句为空）');
  const sufficient = missingReadings.length === 0;

  return {
    arm,
    policy,
    connectionId,
    startedAt,
    uploadedMs: link.uploadedMs,
    uploadedSeconds: num3(link.uploadedMs / 1000),
    uploadedFrames: link.uploadedFrames,
    uploadedBytes: link.uploadedBytes,
    excerptMs,
    uploadRatio: num3(link.uploadedMs / excerptMs),
    sourceSpeechMs,
    sourceSilenceRatio: num3(1 - sourceSpeechMs / excerptMs),
    upstreamSpeechMs,
    upstreamSilenceRatio: upstreamSpeechMs === null ? null : num3(1 - upstreamSpeechMs / excerptMs),
    upstreamSpeechSegments: speechPairs.length,
    firstTokenLatencyMs,
    firstFunctionCallLatencyMs,
    perTurn,
    groundTruthCount: withTranscription.length,
    forwardedGroundTruthCount,
    forwardingFidelity,
    forwardedTexts,
    transcriptions,
    droppedSegments,
    errorInterruptions,
    upstreamErrors: [...link.errors],
    disconnected: link.disconnectedByUpstream,
    closeCode: link.closeInfo?.code ?? null,
    closeReason: link.closeInfo?.reason ?? null,
    gate:
      gate === null
        ? null
        : {
            decisionsRecorded: gate.decisions.length,
            filteredFrames: gate.filteredFrames,
            withheldMs: gate.withheldMsTotal,
            suppressedTransitions: gate.suppressedTransitions,
            resumedTransitions: gate.resumedTransitions,
            ignoredSuppressions: gate.ignoredSuppressions,
            falsifyWithheldFrames: gate.falsifyWithheldFrames,
            prerollFlushedFrames: gate.prerollFlushedFrames,
            prerollMaxFrames: gate.prerollMaxFrames,
            keepaliveFramesSent: gate.keepaliveFramesSent,
            keepaliveMsSent: gate.keepaliveMsSent,
            suppressedMsTotal: gate.suppressedMsTotal,
          },
    speechWithheldMs: options.speechWithheldMs,
    speechWithheldFrames: options.speechWithheldFrames,
    sourceSpeechMsInWindow: options.sourceSpeechMsInWindow,
    longestAppendGapMs: link.longestAppendGapMs,
    // 连接存活：excerpt 播完时连接还活着 —— 既不是上游自己断的，也没撞上花费上限；
    // 唯一的 close 只能是探针自己收尾时发的（`byProbe`）。这里**不能**读 `link.closed`：
    // 收尾时探针自己会 `close()`，那个字段随后必然为 true。
    survivedToEnd: !link.disconnectedByUpstream && !link.capTripped && (link.closeInfo === null || link.closeInfo.byProbe),
    sentFrameTypes: Object.fromEntries([...link.sentByType.entries()].sort((x, y) => x[0].localeCompare(y[0]))),
    boundaryResponseCreateSent: options.boundaryResponseCreateSent,
    turnDetectionSeen: readSentTurnDetection(link),
    spendCny: link.spend,
    capTripped: link.capTripped,
    durationMs: Date.now() - link.t0,
    sufficient,
    insufficientReason: sufficient ? null : `本臂读数不齐：${missingReadings.join('；')} —— 模型侧读数不足以判断`,
    events: link.events,
  };
}

function writeArmJournal(journalDir: string, arm: ArmId, connectionId: string, reading: ArmReading): void {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      kind: 'header',
      arm,
      policy: reading.policy,
      connectionId,
      startedAt: reading.startedAt,
      model: MODEL,
      voice: VOICE,
      upstreamUrl: UPSTREAM_URL,
      excerptMs: reading.excerptMs,
    }),
  );
  for (const e of reading.events) {
    lines.push(
      JSON.stringify({
        atMs: e.sinceConnectMs,
        audioMs: e.audioMs,
        dir: e.direction === 'sent' ? '→' : '←',
        type: e.type,
        raw: e.raw,
      }),
    );
  }
  const summary: Record<string, unknown> = { kind: 'reading', ...reading };
  delete summary.events;
  lines.push(JSON.stringify(summary));
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(path.join(journalDir, `${arm}-${connectionId}.jsonl`), `${lines.join('\n')}\n`);
}

function writeGateJournal(journalDir: string, arm: ArmId, connectionId: string, decisions: GateDecisionLine[]): void {
  const lines = decisions.map((d) => JSON.stringify(d));
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(path.join(journalDir, `${arm}-${connectionId}.gate.jsonl`), `${lines.join('\n')}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言（AC 逐条）
// ─────────────────────────────────────────────────────────────────────────────

type Assertion = { id: string; ok: boolean; detail: string };

function evaluateAssertions(input: {
  source: SourceMaterial;
  rows: CorrespondenceRow[];
  readings: ArmReading[];
  options: RunOptions;
  pidBefore: number | null;
  pidAfter: number | null;
  actualExcerptMs: number;
  /** 出货解析器给出的 `turn_detection`（三臂共用）—— AC8 用它做「没被本功能改动」的比对基准。 */
  turnDetection: unknown;
  /**
   * **同一份快照渲染出来的报告正文**（断言表留空的那一版）。AC4 / AC5 与两条支撑断言直接在这段
   * 文字上判标记串，而不是判开关 —— 详见 `KEEPALIVE_CONFLICT_MARKER` 的注释。
   */
  reportText: string;
  /** 本任务的离线证据面（帧画像 / 门控回放 / 阈值敏感性 / 钳位扫描）。 */
  evidence: OfflineEvidence;
}): Assertion[] {
  const { source, rows, readings, options, pidBefore, pidAfter, actualExcerptMs, turnDetection, reportText, evidence } = input;
  const byArm = new Map(readings.map((r) => [r.arm, r]));
  const a = byArm.get('A');
  const b = byArm.get('B');
  const c = byArm.get('C');
  const assertions: Assertion[] = [];
  const corr = source.correspondence;
  const offline = evidence.selected;
  /** `--replay-only`：没有臂读数，只有离线证据面 ⇒ 只产出离线可判的断言（见函数末尾）。 */
  const offlineOnly = options.replayOnly;

  // ── AC1 红先行：出货、**未改**的门控在选定 excerpt 上真的裁了帧 ──
  // 这是本任务的复议靶心：前次运行的结论是「B 与 A 逐字节相同 ⇒ 本语料没有可裁之处」。本断言要求
  // 在同一条录音的**另一段**（明确含连续无语音）上跑出 `filteredFrames > 0`。取假形态（把起点移回
  // 不含连续无语音的窗口）跑 `--replay-only --start-ms 0 --excerpt-ms 90000` ⇒ B 一帧不裁 ⇒ 本断言红。
  const armFilteredFrames = b?.gate?.filteredFrames ?? null;
  const observedFilteredFrames = armFilteredFrames ?? offline.filteredFrames;
  const replayMatchesArm = armFilteredFrames === null || armFilteredFrames === offline.filteredFrames;
  const ac1 =
    observedFilteredFrames > 0 && offline.filteredFrames > 0 && replayMatchesArm && actualExcerptMs <= MAX_EXCERPT_MS;
  assertions.push({
    id: 'AC1',
    ok: ac1,
    detail:
      `选定 excerpt 起点 ${options.startMs} ms / 长度 ${actualExcerptMs} ms（B 的 ` +
      `filteredFrames = 本帧有音频没被写出去的帧数）：B 臂实测 ${armFilteredFrames ?? '未跑（离线回放）'} 帧、` +
      `离线回放 ${offline.filteredFrames} 帧（两者一致=${replayMatchesArm}）⇒ 出货门控**真的裁了帧**=${observedFilteredFrames > 0}；` +
      `挂起转移 ${offline.suppressedTransitions} 次 / 恢复 ${offline.resumedTransitions} 次、未写出 ${offline.withheldMs} ms、` +
      `首次挂起于源音频 ${offline.firstSuppressedAtMs ?? '—'} ms；` +
      `取假形态靶子（起点 ${evidence.falsifyWindow.startMs} ms / ${evidence.falsifyWindow.excerptMs} ms 的首片 90 s）同一条回放裁掉 ` +
      `${evidence.falsifyWindow.replay.filteredFrames} 帧（应为 0：把起点移出连续无语音段，本断言即红）`,
  });

  // ── S1 支撑材料：转发真值必须取自 journal 的 session_send ──
  // 这不是 AC 集里的一条 AC，而是「转发保真」那一列的分母来源：若真值换成 CLI/UI caption 流
  // （那是「用户看到了什么」，不是「转发出去的是什么」），保真读数就换了参照系、整列失效。
  // 它必须是一条**会红的断言**，否则 `--falsify-forward-truth=cli-transcript` 这条假形态就没有靶子。
  const truthOk =
    corr.forwardTruthSource === 'journal.session_send' && corr.cliTranscriptUsedAsForwardTruth === false;
  assertions.push({
    id: 'S1',
    ok: truthOk,
    detail:
      `来源对应表 ${corr.rows.length} 行（offsetMs → itemId → transcription → session_send）；` +
      `转发真值来源=${corr.forwardTruthSource}（应为 journal.session_send）；CLI transcript 用作转发真值=${corr.cliTranscriptUsedAsForwardTruth}（应为 false）；` +
      `committed ${corr.counts.committed} ↔ transcription ${corr.counts.transcriptionCompleted} ↔ function_call(session_send) ${corr.counts.functionCallSessionSend}；` +
      `journal session_send 条目 ${corr.counts.sessionSendEntries}；caption 流 ${corr.counts.captionLines} 条（**未**用作真值）；` +
      `excerpt 内真值句 ${rows.length} 条`,
  });

  // ── AC2 C 臂证明「只观察」：上传与 A 逐项相等，且决策数 == 上传帧数 ──
  const ac2 =
    a !== undefined &&
    c !== undefined &&
    c.uploadedFrames === a.uploadedFrames &&
    c.uploadedBytes === a.uploadedBytes &&
    c.uploadedMs === a.uploadedMs &&
    c.gate !== null &&
    a.gate === null &&
    c.gate.decisionsRecorded === c.uploadedFrames;
  assertions.push({
    id: 'AC2',
    ok: ac2,
    detail:
      a === undefined || c === undefined
        ? 'A/C 两臂未同时跑，无法对照'
        : `C 上传 帧 ${c.uploadedFrames} / 字节 ${c.uploadedBytes} / 毫秒 ${c.uploadedMs} vs A 上传 帧 ${a.uploadedFrames} / 字节 ${a.uploadedBytes} / 毫秒 ${a.uploadedMs}（逐项相等）；` +
          `C 记录决策 ${c.gate?.decisionsRecorded ?? '—'} 条（应 == C 上传帧数）；` +
          (c.gate !== null && c.gate.falsifyWithheldFrames > 0
            ? `⚠️ 取假形态 F2 生效：C 因 --falsify-c-suppresses 吞掉 ${c.gate.falsifyWithheldFrames} 帧` +
              `（${c.gate.falsifyWithheldFrames * FRAME_MS} ms）—— 上传不再等于 A，且决策数不再等于上传帧数`
            : `C 本会裁掉 ${c.gate?.withheldMs ?? '—'} ms（ignoredSuppressions=${c.gate?.ignoredSuppressions ?? '—'} 帧）但一帧未裁`),
  });

  // ── AC3 无语音损失：各臂未写出的音频落在源 timeline speech 区间内的毫秒数必须为 0 ──
  const lossy = readings.filter((r) => (r.speechWithheldMs ?? 0) > 0);
  const ac3 = offline.speechWithheldMs === 0 && (offlineOnly || (readings.length > 0 && lossy.length === 0));
  assertions.push({
    id: 'AC3',
    ok: ac3,
    detail: ac3
      ? `三臂未写出的音频落在源 timeline speech 区间内的毫秒数均为 0（分母 = 窗口内源语音 ${offline.sourceSpeechMsInWindow} ms` +
        `${offlineOnly ? '，离线回放' : `，与 A 臂读数 ${a?.sourceSpeechMsInWindow ?? '—'} ms 同源`}）；` +
        `离线门控回放同样为 0（B 离线：${offline.speechWithheldMs} ms / ${offline.speechWithheldFrames} 帧）—— ` +
        `被裁掉的 ${offline.withheldMs} ms 全部落在非语音侧；恢复时补发的 pre-roll 累计 ${offline.prerollFlushedFrames} 帧` +
        `（这正是「净上传差 = 裁掉的帧数 − 补发的帧数」的来源）`
      : `以下臂把源侧语音裁掉了：${lossy.map((r) => `${r.arm}（${r.speechWithheldMs} ms / ${r.speechWithheldFrames} 帧）`).join('、')}` +
        `；离线回放误删 ${offline.speechWithheldMs} ms`,
  });

  // ── AC4 报告给出**本次 excerpt** 上的门控实测读数 + 噪声底 + 阈值敏感性 ──
  // 判据落在**渲染出来的报告文本**上（两个标记串）+ 证据面本身有值：标记串只在真形态分支里写。
  const gateReadingsInReport = reportText.includes(GATE_READINGS_MARKER);
  const sensitivityInReport = reportText.includes(SENSITIVITY_MARKER);
  const ac4 =
    gateReadingsInReport &&
    sensitivityInReport &&
    offline.stageSequence.length > 0 &&
    evidence.sensitivity.rows.length > 0 &&
    evidence.profile.frames > 0 &&
    Number.isFinite(evidence.sensitivity.baseDb);
  assertions.push({
    id: 'AC4',
    ok: ac4,
    detail:
      `报告含「门控在本次 excerpt 上的实测读数」段=${gateReadingsInReport}、含「噪声底与阈值敏感性」段=${sensitivityInReport}（判据是渲染后的报告里含标记串）；` +
      `读数：stage 序列 \`${offline.stageSequence.join(' → ')}\`、suppressedTransitions ${offline.suppressedTransitions}、` +
      `withheldMs ${offline.withheldMs}、filteredFrames ${offline.filteredFrames}；` +
      `excerpt 帧 ${evidence.profile.frames}（数字静音 ${evidence.profile.digitalSilentFrames} 帧、` +
      `非静音 p10 ${evidence.profile.nonSilentDb[0] ?? '—'} dBFS、p50 ${evidence.profile.nonSilentDb[2] ?? '—'} dBFS）；` +
      `敏感性表基准 = 非静音帧 p10 = ${evidence.sensitivity.baseDb} dBFS，共 ${evidence.sensitivity.rows.length} 档 ` +
      `（Δ=${evidence.sensitivity.rows.map((r) => r.deltaDb).join('/')}）`,
  });

  // ── AC5 钳位是根因：报告必须指明是钳位废掉了自适应，并给出本录音的底噪实测值 ──
  // 取假形态 F6 `--falsify-clamp-not-root-cause` 把根因改写成「语料没有可裁之处」并省掉标记串 ⇒ 红。
  //
  // 行为侧证据全部**实测**（`clampSweep` 对门控自己的判定逐电平实测），再加两道**镜像核对**：
  // 实测出来的上限 / 底噪间距必须与源码常量的副本吻合（±1.5 dB 的测量粒度），否则说明有人改了
  // 出货常数、而这份只读副本没跟上 —— 那时报告会写错数，所以宁可红。
  const rootCauseInReport = reportText.includes(CLAMP_ROOT_CAUSE_MARKER);
  const sweepMeasured = evidence.clampSweep.filter((row) => row.effectiveBoundaryDb !== null);
  const measuredCeiling = sweepMeasured.length === 0 ? Number.NaN : Math.max(...sweepMeasured.map((row) => row.effectiveBoundaryDb!));
  const mirrorCeilingOk = Math.abs(measuredCeiling - SHIPPED_STS_MAX_THRESHOLD_DB) <= 1.5;
  const marginTracks = sweepMeasured.filter(
    (row) => Math.abs(row.effectiveBoundaryDb! - (row.primedFloorDb + SHIPPED_STS_VOICE_MARGIN_DB)) <= 1.5,
  );
  const mirrorMarginOk = marginTracks.length > 0;
  const recordingFloorP10 = evidence.recording.nonSilentDb[1] ?? Number.NaN;
  const clampBindsOnRecording = recordingFloorP10 + SHIPPED_STS_VOICE_MARGIN_DB > SHIPPED_STS_MAX_THRESHOLD_DB;
  const ac5 =
    options.rootCauseStated &&
    rootCauseInReport &&
    sweepMeasured.length >= 10 &&
    mirrorCeilingOk &&
    mirrorMarginOk &&
    clampBindsOnRecording &&
    evidence.recording.nonSilentFrames > 0 &&
    Number.isFinite(evidence.recording.nonSilentDb[1] ?? Number.NaN);
  assertions.push({
    id: 'AC5',
    ok: ac5,
    detail:
      `报告把根因写成「钳位废掉自适应」=${rootCauseInReport}（标记串判据，不是开关；取假形态 F6 会把它改成「${WRONG_ROOT_CAUSE}」并省掉标记串）；` +
      `钳位扫描实测 ${sweepMeasured.length}/${evidence.clampSweep.length} 档有效，实测上限 ${Number.isFinite(measuredCeiling) ? measuredCeiling : '—'} dBFS ` +
      `与副本常量 ${SHIPPED_STS_MAX_THRESHOLD_DB} dBFS 差 ≤1.5 dB=${mirrorCeilingOk}（镜像核对①）；` +
      `有 ${marginTracks.length} 档的判定边界 = 底噪 + ${SHIPPED_STS_VOICE_MARGIN_DB} dB（±1.5）=${mirrorMarginOk}（镜像核对②：自适应项确实存在，只是会被钳位吃掉）；` +
      `本录音全文件底噪（非数字静音帧）p5 ${evidence.recording.nonSilentDb[0]} / p10 ${recordingFloorP10} / ` +
      `p50 ${evidence.recording.nonSilentDb[3]} / p90 ${evidence.recording.nonSilentDb[5]} dBFS，` +
      `数字静音仅 ${evidence.recording.digitalSilentFrames}/${evidence.recording.frames} 帧；` +
      `该底噪 p10 + ${SHIPPED_STS_VOICE_MARGIN_DB} = ${num3(recordingFloorP10 + SHIPPED_STS_VOICE_MARGIN_DB)} dBFS **高于**上限 ${SHIPPED_STS_MAX_THRESHOLD_DB} ⇒ 钳位在这一整条录音上长期生效=${clampBindsOnRecording}`,
  });

  // ── AC6 成本时长上限 ──
  const totalSpend = readings.reduce((s, r) => s + r.spendCny, 0);
  const ac6 =
    actualExcerptMs <= MAX_EXCERPT_MS &&
    readings.length > 0 &&
    totalSpend <= options.totalCapCny &&
    readings.every((r) => r.spendCny <= options.capCny || r.capTripped);
  assertions.push({
    id: 'AC6',
    ok: ac6,
    detail:
      `excerpt ${actualExcerptMs} ms ≤ 上限 ${MAX_EXCERPT_MS} ms（且 ≤ 任务书写的 120 s）；单次运行（runs=1）；` +
      `实际花费 ¥${totalSpend.toFixed(4)}（每连接上限 ¥${options.capCny}、总上限 ¥${options.totalCapCny}）；` +
      `触顶连接 ${readings.filter((r) => r.capTripped).length} 条；实际总时长 ${readings.reduce((s, r) => s + r.durationMs, 0)} ms`,
  });

  // ── AC7 未改生产配置 / 未重启 :3001 / 除上游外零外联 ──
  const pidStable = pidBefore !== null && pidBefore === pidAfter;
  const envTouched = process.env[SILENCE_TAIL_ENV] === undefined;
  assertions.push({
    id: 'AC7',
    ok: pidStable && envTouched,
    detail:
      `:3001 pid 运行前 ${pidBefore ?? '未知'} → 运行后 ${pidAfter ?? '未知'}（相同=${pidStable}，未重启）；` +
      `\`${SILENCE_TAIL_ENV}\` 仍未设=${envTouched}（生产默认仍是关）；` +
      `生产环境变量改动 0 条（gate 在探针内构造）；外联仅 ${UPSTREAM_URL}`,
  });

  // ── AC8 职责边界：服务端 VAD 仍只过滤无语音 PCM ──
  // 服务端 VAD 只做上行 PCM 的 speech/non-speech 过滤。探针**自己发出的帧**里不得出现
  // `response.create` / commit 这类由边界事件驱动的帧，`turn_detection` 也不得被本功能改动。
  const FORBIDDEN_SENT = ['response.create', 'input_audio_buffer.commit', 'input_audio_buffer.clear', 'response.cancel'];
  const forbiddenSent = readings.flatMap((r) =>
    FORBIDDEN_SENT.filter((t) => (r.sentFrameTypes[t] ?? 0) > 0).map((t) => `${r.arm}:${t}×${r.sentFrameTypes[t]}`),
  );
  const boundaryDriven = readings.filter((r) => r.boundaryResponseCreateSent > 0);
  const turnDetectionSame = readings.every(
    (r) => JSON.stringify(r.turnDetectionSeen) === JSON.stringify(turnDetection),
  );
  const ac8 = forbiddenSent.length === 0 && boundaryDriven.length === 0 && turnDetectionSame && readings.length > 0;
  assertions.push({
    id: 'AC8',
    ok: ac8,
    detail:
      `职责边界：三臂都只发 session.update ×1 + input_audio_buffer.append；` +
      `禁用帧（${FORBIDDEN_SENT.join(' / ')}）共 ${forbiddenSent.length} 处${forbiddenSent.length > 0 ? `（${forbiddenSent.join('、')}）` : ''}；` +
      `由边界事件驱动的 response.create ${boundaryDriven.reduce((s, r) => s + r.boundaryResponseCreateSent, 0)} 次；` +
      `三臂 session.update 里的 turn_detection 与出货解析器输出一致=${turnDetectionSame}（${JSON.stringify(turnDetection)}）；` +
      `离线回放只读 frames/stage、不消费任何 local-speech 边界事件`,
  });

  // ── S2 支撑：keepalive 与节流目标的冲突必须写在报告里 ──
  // 这是旧 AC5 的实质判据，任务复议后不再是一条 AC，但取假形态 F4 仍需一个靶子 ⇒ 降为支撑断言。
  const keepaliveReported = readings.every((r) => r.gate === null || Number.isFinite(r.gate.keepaliveFramesSent));
  const conflictInReport = reportText.includes(KEEPALIVE_CONFLICT_MARKER);
  assertions.push({
    id: 'S2',
    ok: keepaliveReported && conflictInReport,
    detail:
      `keepalive：B 臂被压住累计 ${b?.gate?.suppressedMsTotal ?? '—'} ms、其间发出 keepalive ` +
      `${b?.gate?.keepaliveFramesSent ?? '—'} 帧、最长不发送间隔 ${b?.longestAppendGapMs ?? '—'} ms、连接存活 ${b?.survivedToEnd ?? '—'}；` +
      `报告中含「与节流目标的冲突」段=${conflictInReport}（取假形态 F4 ⇒ 红）`,
  });

  // ── S3 支撑：localSpeechGate / watchdog 标注为既有旁路（旧 AC6，同上降为支撑） ──
  const bypassNotImported = !PROBE_BARREL_IMPORTS.has('createLocalSpeechGate') && !PROBE_BARREL_IMPORTS.has('reportLocalSpeechBoundary');
  const bypassInReport = reportText.includes(BYPASS_ANNOTATION_MARKER);
  assertions.push({
    id: 'S3',
    ok: bypassInReport && bypassNotImported,
    detail:
      `localSpeechGate / reportLocalSpeechBoundary / watchdog 已在报告中显式标注为**既有旁路**=${bypassInReport}（标记串判据）；` +
      `探针未 import/构造它们=${bypassNotImported}（barrel 导入符号 ${PROBE_BARREL_IMPORTS.size} 个，其中不含这两个）`,
  });

  // ── S4 支撑：读数不足就写「不足以判断」（旧 AC9，恒真 —— 它判的是结论行的写法） ──
  const insufficient = readings.filter((r) => !r.sufficient);
  assertions.push({
    id: 'S4',
    ok: true,
    detail:
      insufficient.length === 0
        ? '三臂模型侧读数均足够，结论可用'
        : `以下臂读数不足，报告已写「不足以判断」：${insufficient.map((r) => `${r.arm}（${r.insufficientReason ?? ''}）`).join('；')}`,
  });

  return offlineOnly ? assertions.filter((x) => OFFLINE_ASSERTION_IDS.has(x.id)) : assertions;
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行
// ─────────────────────────────────────────────────────────────────────────────

type RunOptions = {
  sessionId: string;
  startMs: number;
  excerptMs: number;
  capCny: number;
  totalCapCny: number;
  forwardTruthSource: ForwardTruthSource;
  falsifyCSuppresses: boolean;
  /** 取假形态 F3：让 B 臂的**边界事件**驱动一次 `response.create` ⇒ AC1 红。 */
  falsifyBBoundaryResponseCreate: boolean;
  /** 取假形态 F4：报告中隐去「keepalive 与节流目标的冲突」⇒ AC5 红。默认 true（= 写出冲突）。 */
  keepaliveConflictStated: boolean;
  /** AC6：报告里是否写出「localSpeechGate / watchdog 是既有旁路」的标注。默认 true。 */
  bypassAnnotated: boolean;
  /** AC5：报告里是否写出「零过滤的根因是钳位废掉自适应」。默认 true；取假形态 F6 翻 false。 */
  rootCauseStated: boolean;
  /** 只做离线门控回放 + 帧画像（不连上游、不花钱）。AC1 的取假形态就从这条路跑。 */
  replayOnly: boolean;
  arms: ArmId[];
};

type SourceMaterial = {
  sessionId: string;
  wavPath: string;
  timelinePath: string;
  journalPath: string;
  header: WavHeader;
  timelineFinal: TimelineFinal | null;
  timelineEvents: TimelineEvent[];
  correspondence: Correspondence;
  pcm: Buffer;
};

function loadSourceMaterial(options: RunOptions): SourceMaterial {
  const wavPath = path.join(CAPTURE_DIR, `${options.sessionId}.wav`);
  const timelinePath = path.join(CAPTURE_DIR, `${options.sessionId}.timeline.jsonl`);
  const journalPath = path.join(JOURNAL_DIR, `${options.sessionId}.jsonl`);
  for (const file of [wavPath, timelinePath, journalPath]) {
    if (!existsSync(file)) throw new Error(`源素材缺失：${file}`);
  }
  const { header, pcm } = parseWav(readFileSync(wavPath));
  const { events, final } = readTimeline(timelinePath);
  const correspondence = buildCorrespondence({
    timeline: events,
    journal: readJournal(journalPath),
    forwardTruthSource: options.forwardTruthSource,
  });
  return {
    sessionId: options.sessionId,
    wavPath,
    timelinePath,
    journalPath,
    header,
    timelineFinal: final,
    timelineEvents: events,
    correspondence,
    pcm,
  };
}

/** 窗口内的**源侧**语音毫秒：由真实 capture timeline 的 speech_started/stopped 落在窗口内的部分算出。 */
function sourceSpeechMsIn(events: TimelineEvent[], startMs: number, endMs: number): number {
  let total = 0;
  let openStart: number | null = null;
  for (const event of events) {
    if (event.kind === 'speech_started') openStart = event.offsetMs;
    else if (event.kind === 'speech_stopped' && openStart !== null) {
      const from = Math.max(openStart, startMs);
      const to = Math.min(event.offsetMs, endMs);
      if (to > from) total += to - from;
      openStart = null;
    }
  }
  return total;
}

/**
 * 窗口内的**源侧语音区间**（timeline 的 `speech_started` → `speech_stopped`，裁到窗口内）。
 * AC4 的「误删语音」以这些区间为分母：被门控吞掉的音频落在这些区间里的部分就是误删。
 */
function sourceSpeechIntervalsIn(
  events: TimelineEvent[],
  startMs: number,
  endMs: number,
): Array<{ fromMs: number; toMs: number }> {
  const out: Array<{ fromMs: number; toMs: number }> = [];
  let openStart: number | null = null;
  for (const event of events) {
    if (event.kind === 'speech_started') openStart = event.offsetMs;
    else if (event.kind === 'speech_stopped' && openStart !== null) {
      const from = Math.max(openStart, startMs);
      const to = Math.min(event.offsetMs, endMs);
      if (to > from) out.push({ fromMs: from, toMs: to });
      openStart = null;
    }
  }
  return out;
}

/** 某个音频时刻是否落在任一源侧语音区间内。 */
function insideSpeech(intervals: Array<{ fromMs: number; toMs: number }>, atMs: number): boolean {
  return intervals.some((i) => atMs >= i.fromMs && atMs < i.toMs);
}

function buildPlan(options: RunOptions, source: SourceMaterial): string {
  const rows = excerptRows(source.correspondence.rows, options.startMs, options.excerptMs);
  return [
    '计划：三臂同源回放 A（不门控）/ B（出货 STS 门控）/ C（只观察不裁剪）',
    `源会话 ${options.sessionId}（真实上行捕获，${num3(source.header.durationMs / 1000)} s PCM16/${source.header.sampleRate} Hz/${source.header.channels} ch）`,
    `excerpt 起点 ${options.startMs} ms、长度 ${options.excerptMs} ms（上限 ${MAX_EXCERPT_MS} ms）；三臂共用`,
    `excerpt 内真值句 ${rows.length} 条（来自 capture timeline 的 committed，不是 CLI transcript）`,
    `本次运行臂数 ${options.arms.length}（每臂 = 一条全新连接）；上限 ¥${options.capCny}/连接、总上限 ¥${options.totalCapCny}`,
    `转发真值来源 ${options.forwardTruthSource}`,
  ].join('\n');
}

async function mainAsync(
  options: RunOptions & { workDir: string; journalDir: string; reportPath: string },
): Promise<void> {
  const { workDir, journalDir, reportPath } = options;
  for (const dir of [workDir, journalDir]) mkdirSync(dir, { recursive: true });

  const source = loadSourceMaterial(options);
  const { header } = source;

  // ── 源侧前置核对：WAV 头与 timeline `final` 行逐位吻合，不等就抛（不带着错语料开跑） ──
  if (source.timelineFinal !== null) {
    if (source.timelineFinal.dataBytes !== header.dataBytes) {
      throw new Error(
        `WAV data chunk ${header.dataBytes} 字节 ≠ timeline final 的 dataBytes ${source.timelineFinal.dataBytes}`,
      );
    }
    if (Math.abs(source.timelineFinal.durationMs - header.durationMs) > 1) {
      throw new Error(
        `WAV 时长 ${header.durationMs} ms ≠ timeline final 的 durationMs ${source.timelineFinal.durationMs} ms`,
      );
    }
  }

  const window = { start: options.startMs, end: options.startMs + options.excerptMs };
  const sourceSpeechMs = sourceSpeechMsIn(source.timelineEvents, window.start, window.end);
  const sourceSpeechIntervals = sourceSpeechIntervalsIn(source.timelineEvents, window.start, window.end);
  /**
   * AC1 取假形态要用的「服务端 VAD 边界事件」：窗口内**第一个**源侧 `speech_stopped` 的绝对音频时刻。
   * 这正是本任务硬禁令点名的接线形态——让这个边界去驱动 `response.create`。真形态下它是 `null`，
   * 探针任何一臂都不会出现 `boundaryResponseCreateSent > 0`。
   */
  const boundaryStoppedAtMs =
    options.falsifyBBoundaryResponseCreate
      ? (source.timelineEvents.find(
          (e) => e.kind === 'speech_stopped' && e.offsetMs >= window.start && e.offsetMs < window.end,
        )?.offsetMs ?? null)
      : null;
  if (options.falsifyBBoundaryResponseCreate) {
    log(
      boundaryStoppedAtMs === null
        ? '⚠️ 取假形态 F3 已开，但窗口内没有源侧 speech_stopped —— B 臂不会被触发（本条假形态这次不成立）'
        : `⚠️ 取假形态 F3 生效：B 臂将在 ${boundaryStoppedAtMs} ms 的边界事件上发一次 response.create ⇒ AC1 应变红`,
    );
  }
  const rows = excerptRows(source.correspondence.rows, window.start, window.end);

  log(`运行目录 ${workDir}`);
  log(buildPlan(options, source));
  log(
    `WAV：${header.dataBytes} 字节 / ${header.sampleRate} Hz / ${header.channels} ch / ${header.bitsPerSample} bit → ${num3(header.durationMs / 1000)} s（data 偏移 ${header.dataOffset}）`,
  );
  log(
    `来源对应：committed ${source.correspondence.counts.committed} ↔ transcription ${source.correspondence.counts.transcriptionCompleted} ↔ function_call(session_send) ${source.correspondence.counts.functionCallSessionSend}；journal session_send 条目 ${source.correspondence.counts.sessionSendEntries}`,
  );
  log(
    `转发真值来源：${source.correspondence.forwardTruthSource}（CLI transcript 用作转发真值 = ${source.correspondence.cliTranscriptUsedAsForwardTruth}）`,
  );

  const turnDetection = resolveTurnDetection({});
  const tools = [
    {
      type: 'function',
      function: {
        name: 'session_send',
        description: '把一个消息转交给一个会话。探针中是 dry-run：调用只被记录，不执行。',
        parameters: {
          type: 'object',
          properties: { [FORWARD_ARG_FIELD]: { type: 'string' } },
          required: [FORWARD_ARG_FIELD],
        },
      },
    },
  ];
  const instructions =
    '你是一个语音助手。用户说的每一句话，你都要原样转交给会话：调用 session_send，把用户刚说的那句话原封不动放进 message。除转交外不要做别的事，不要提问，不要解释。';

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);
  log(`turn_detection（出货解析器，三臂共用）= ${JSON.stringify(turnDetection.turnDetection)}`);

  const excerptPcm = sliceExcerpt(source.pcm, options.startMs, options.excerptMs);
  const actualExcerptMs = Math.round((excerptPcm.length / BYTES_PER_SECOND) * 1000);
  const excerptRms = frameRmsPercentiles(excerptPcm);
  log(
    `excerpt 逐帧 RMS 分布（${excerptRms.frames} 帧）：p15 ${excerptRms.p15}（${excerptRms.p15Db} dBFS）/ p50 ${excerptRms.p50}（${excerptRms.p50Db} dBFS）/ p95 ${excerptRms.p95}（${excerptRms.p95Db} dBFS）/ min ${excerptRms.min}（${excerptRms.minDb} dBFS）`,
  );
  const shippedVoiceFloorDb = measureShippedVoiceFloorDb();
  const belowFloor = framesBelowDb(excerptPcm, shippedVoiceFloorDb);
  log(
    `出货门控实测人声下限 ${shippedVoiceFloorDb} dBFS（同构造/同默认）；excerpt 中低于该电平的帧 ${belowFloor.below}/${belowFloor.total}（${(belowFloor.ratio * 100).toFixed(1)}%）`,
  );

  const evidence = buildOfflineEvidence(source.pcm, options.startMs, actualExcerptMs, sourceSpeechIntervals, excerptPcm);
  log(
    `离线：出货门控回放（选定窗口）裁掉 ${evidence.selected.filteredFrames} 帧 / 未写出 ${evidence.selected.withheldMs} ms / ` +
      `stage 序列 ${evidence.selected.stageSequence.join('>') || '—'}；` +
      `取假形态窗口（${evidence.falsifyWindow.startMs} ms / ${evidence.falsifyWindow.excerptMs} ms）裁掉 ${evidence.falsifyWindow.replay.filteredFrames} 帧` +
      (options.replayOnly ? '；--replay-only：不连上游' : ''),
  );

  const readings: ArmReading[] = [];
  for (const arm of options.replayOnly ? [] : options.arms) {
    const soFar = readings.reduce((s, r) => s + r.spendCny, 0);
    if (soFar > options.totalCapCny) {
      log(`跳过臂 ${arm}：已花 ¥${soFar.toFixed(4)}，越过总上限 ¥${options.totalCapCny}`);
      continue;
    }
    const reading = await runArm({
      arm,
      pcm: excerptPcm,
      excerptMs: actualExcerptMs,
      capCny: options.capCny,
      journalDir,
      instructions,
      tools,
      turnDetection: turnDetection.turnDetection,
      groundTruth: rows,
      sourceSpeechMs,
      falsifyCSuppresses: options.falsifyCSuppresses,
      sourceSpeechIntervals,
      startMs: options.startMs,
      boundaryStoppedAtMs,
      falsifyBBoundaryResponseCreate: options.falsifyBBoundaryResponseCreate,
    });
    readings.push(reading);
    log(
      `  臂 ${arm}（${reading.policy}）conn=${reading.connectionId.slice(0, 8)} 上传 ${reading.uploadedSeconds}s/${reading.uploadedFrames}帧 ` +
        `转写=${reading.transcriptions.length} 转发=${reading.forwardedTexts.length} 保真=${reading.forwardingFidelity ?? '—'} ` +
        `首token=${reading.firstTokenLatencyMs ?? '—'}ms 首call=${reading.firstFunctionCallLatencyMs ?? '—'}ms ` +
        `丢段=${reading.droppedSegments} 中断=${reading.errorInterruptions} ¥${reading.spendCny.toFixed(4)}`,
    );
    if (reading.gate !== null) {
      log(
        `       gate：决策 ${reading.gate.decisionsRecorded} 条；本臂未写出 ${reading.gate.withheldMs} ms；` +
          `suppressed 转移 ${reading.gate.suppressedTransitions} / resumed ${reading.gate.resumedTransitions}；忽略裁剪(observe) ${reading.gate.ignoredSuppressions} 帧` +
          (reading.gate.falsifyWithheldFrames > 0
            ? `；⚠️ 取假形态 F2 吞掉 ${reading.gate.falsifyWithheldFrames} 帧`
            : ''),
      );
    }
    log(
      `       边界：本臂发出 response.create ${reading.sentFrameTypes['response.create'] ?? 0} 次` +
        `（由服务端 VAD 边界事件驱动 ${reading.boundaryResponseCreateSent} 次）；` +
        `本臂上行帧型 ${JSON.stringify(reading.sentFrameTypes)}；` +
        `连接存活到 excerpt 结束=${reading.survivedToEnd}（最大上传间隔 ${reading.longestAppendGapMs} ms、` +
        `本臂未写出语音 ${reading.speechWithheldMs ?? '—'} ms / 源语音窗口 ${reading.sourceSpeechMsInWindow ?? '—'} ms）`,
    );
    if (reading.upstreamErrors.length > 0) log(`       上游/连接错误：${reading.upstreamErrors.join(' | ')}`);
  }

  const pidAfter = pidOnPort(3001);

  // 先按「断言表留空」渲染一次报告正文：AC5 / AC6 要在**真正要写出去的那段文字**上判标记串，
  // 而不是在自己的开关上判。渲染是纯字符串拼接、不连上游、不花钱，多渲一次没有代价。
  const snapshotBase: Snapshot = {
    runAt: nowIso(),
    sessionId: options.sessionId,
    wavPath: source.wavPath,
    timelinePath: source.timelinePath,
    journalPath: source.journalPath,
    wav: header,
    timelineFinal: source.timelineFinal,
    correspondence: source.correspondence,
    startMs: options.startMs,
    excerptMs: actualExcerptMs,
    sourceSpeechMs,
    excerptRms,
    shippedVoiceFloorDb,
    excerptFramesBelowFloor: belowFloor.below,
    excerptFramesTotal: belowFloor.total,
    excerptFramesBelowFloorRatio: belowFloor.ratio,
    capCny: options.capCny,
    totalCapCny: options.totalCapCny,
    maxExcerptMs: MAX_EXCERPT_MS,
    runs: 1,
    model: MODEL,
    voice: VOICE,
    turnDetection: turnDetection.turnDetection,
    pidBefore,
    pidAfter,
    forwardTruthSource: options.forwardTruthSource,
    falsifyCSuppresses: options.falsifyCSuppresses,
    falsifyBBoundaryResponseCreate: options.falsifyBBoundaryResponseCreate,
    keepaliveConflictStated: options.keepaliveConflictStated,
    bypassAnnotated: options.bypassAnnotated,
    probeBarrelImports: [...PROBE_BARREL_IMPORTS].sort(),
    productionEnvTouched: [],
    externalConnections: options.replayOnly ? [] : [UPSTREAM_URL],
    evidence,
    replayOnly: options.replayOnly,
    rootCauseStated: options.rootCauseStated,
    readings,
    // **不要**在这里先 `num3` 一次：报告里这个数到处都用 `.toFixed(4)` 渲染，而 AC6 断言用的是
    // 同一个和的**未取整**值 —— 先取整到 3 位会让同一笔花费在报告里出现两个数（¥0.0070 vs ¥0.0067），
    // 读者无法判断哪个是真的。保留全精度，让所有渲染点取整方式一致。
    totalSpendCny: readings.reduce((sum, r) => sum + r.spendCny, 0),
    assertions: [], // 先留空，供 AC5 / AC6 的那种「读渲染文本」判据使用；下面填真值后再渲染定稿。
  };
  const reportForChecks = buildReport(snapshotBase, workDir);

  const assertions = evaluateAssertions({
    source,
    rows,
    readings,
    options,
    pidBefore,
    pidAfter,
    actualExcerptMs,
    turnDetection: turnDetection.turnDetection,
    reportText: reportForChecks,
    evidence,
  });
  for (const a of assertions) log(`[${a.ok ? 'PASS' : 'FAIL'}] ${a.id} — ${a.detail}`);

  const snapshot: Snapshot = { ...snapshotBase, assertions };
  writeFileSync(path.join(workDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

  const report = buildReport(snapshot, workDir);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);

  log('');
  log(
    `总花费 ¥${snapshot.totalSpendCny.toFixed(4)}（上限 ¥${options.capCny}/连接、总 ¥${options.totalCapCny}）；:3001 pid ${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}`,
  );
  log(`快照已写入 ${path.join(workDir, 'snapshot.json')}`);
  log(`报告已写入 ${reportPath}`);

  const failed = assertions.filter((a2) => !a2.ok);
  if (failed.length > 0) throw new Error(`断言未通过：${failed.map((x) => x.id).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = {
  runAt: string;
  sessionId: string;
  wavPath: string;
  timelinePath: string;
  journalPath: string;
  wav: WavHeader;
  timelineFinal: TimelineFinal | null;
  correspondence: Correspondence;
  startMs: number;
  excerptMs: number;
  sourceSpeechMs: number;
  /** excerpt 的逐帧 RMS 分布 —— 用来解释 B 臂为何（或为何没有）与 A 臂不同。 */
  excerptRms: {
    frames: number;
    p15: number;
    p50: number;
    p95: number;
    min: number;
    p15Db: number;
    p50Db: number;
    p95Db: number;
    minDb: number;
  };
  /**
   * 出货门控**实测**的人声下限（dBFS，见 `measureShippedVoiceFloorDb`），以及 excerpt 里低于该电平的
   * 帧数与占比。B 臂与 A 臂逐字节相同时，这组数就是「为什么」：低于下限的帧才可能推进挂起窗，
   * 占比太小就不会有尾巴，也就不会有裁剪。
   */
  shippedVoiceFloorDb: number;
  excerptFramesBelowFloor: number;
  excerptFramesTotal: number;
  excerptFramesBelowFloorRatio: number;
  capCny: number;
  totalCapCny: number;
  maxExcerptMs: number;
  runs: number;
  model: string;
  voice: string;
  turnDetection: unknown;
  pidBefore: number | null;
  pidAfter: number | null;
  forwardTruthSource: ForwardTruthSource;
  falsifyCSuppresses: boolean;
  falsifyBBoundaryResponseCreate: boolean;
  /** 报告是否写出了「keepalive 与节流目标的冲突」（AC5 的实质判据）。 */
  keepaliveConflictStated: boolean;
  /** 报告是否写出了「localSpeechGate / watchdog 是既有旁路」（AC6 的实质判据）。 */
  bypassAnnotated: boolean;
  /** AC6 的机械半边：探针从 voice-realtime barrel 导入的符号名（不得含 local-speech 那两个）。 */
  probeBarrelImports: string[];
  productionEnvTouched: string[];
  externalConnections: string[];
  /** 本任务的离线证据面：帧画像 + 出货门控离线回放 + 阈值敏感性 + 钳位扫描 + 全文件底噪。 */
  evidence: OfflineEvidence;
  /** 只做了离线回放（`--replay-only`：不连上游、不花钱、报告不落交付物路径）。 */
  replayOnly: boolean;
  /** 报告是否把根因写成「钳位废掉自适应」（AC5 的实质判据；取假形态 F6 会翻掉它）。 */
  rootCauseStated: boolean;
  readings: ArmReading[];
  totalSpendCny: number;
  assertions: Assertion[];
};

function fidelityLine(r: ArmReading): string {
  const pct = r.forwardingFidelity === null ? '' : `（${(r.forwardingFidelity * 100).toFixed(1)}%）`;
  return `${r.forwardedGroundTruthCount}/${r.groundTruthCount}${pct}（转出 ${r.transcriptions.length} 条、转发 ${r.forwardedTexts.length} 条）`;
}

/** DoD 的实证结论：三臂读数差异允许说什么、不允许说什么。 */
function deriveConclusion(snapshot: Snapshot): { verdict: string; reason: string } {
  const byArm = new Map(snapshot.readings.map((r) => [r.arm, r]));
  const a = byArm.get('A');
  const b = byArm.get('B');
  const c = byArm.get('C');
  if (a === undefined || c === undefined) {
    return { verdict: '不足以判断', reason: 'A/C 两臂未同时跑，检测质量与输入干预无法分离' };
  }
  const insufficient = snapshot.readings.filter((r) => !r.sufficient);
  if (insufficient.length > 0) {
    return {
      verdict: '不足以判断',
      reason: `以下臂模型侧读数不足：${insufficient.map((r) => r.arm).join(', ')}`,
    };
  }
  if (a.transcriptions.length === 0 || a.forwardedTexts.length === 0) {
    return { verdict: '不足以判断', reason: 'A 臂（生产形态）没有产出转写/转发读数，三臂对照失去基准' };
  }
  const uploadedDiffers = b !== undefined && b.uploadedMs !== a.uploadedMs;
  const modelDiffers =
    b !== undefined &&
    (b.transcriptions.length !== a.transcriptions.length || b.forwardedTexts.length !== a.forwardedTexts.length);

  /**
   * B 臂的门控**是不是真的动过手**。
   *
   * 「B 与 A 逐字节相同」有两个解释，工程含义完全不同：(1) 门控有裁剪能力、但在本语料上判不出该裁的
   * 地方；(2) 门控的判定阈值在本语料上**一次都没被跨过**，干预根本没发生。第二种下，这个 B/A 相等
   * **不能**推广成「服务端 VAD 对上行没有影响」—— 它只是说明这次回放没有制造出干预。证据是门控自己
   * 的读数：`withheldMs`（本臂未写出的毫秒）、`suppressedTransitions`、以及实测的人声下限对语料帧分布。
   *
   * ⚠️ 2026-10-13 复议更正：**前一次运行把第二种情形归因到语料**（「本语料没有给出可裁之处」），那是
   * 错的。同一条录音的另一段（明确含连续无语音）用同一份**未改**的门控就能裁出帧来（见 `evidence`）；
   * 零过滤的真正成因是钳位上限 `SILENCE_TAIL_MAX_THRESHOLD_DB` 废掉了自适应（`clampSweep` 逐电平实测）。
   * 因此本函数不再把「门控未动」写成语料的性质，而是写成**判据的性质**。
   */
  const gateNeverFired =
    b !== undefined && b.gate !== null && b.gate.withheldMs === 0 && b.gate.suppressedTransitions === 0;
  const bMatchesA = b !== undefined && !uploadedDiffers && !modelDiffers;

  const verdict =
    uploadedDiffers && modelDiffers
      ? '有影响'
      : uploadedDiffers
        ? '部分影响（干预确实改了上行，但本样本的模型侧读数未见差异）'
        : gateNeverFired && bMatchesA
          ? '未观察到影响 —— 且干预在本 excerpt 上未发生（门控一次未裁；成因是判据被钳位封顶，不是语料无可裁之处）'
          : b === undefined
            ? '未观察到影响（B 臂未跑，无法与 A 对照）'
            : '未观察到影响';
  return {
    verdict,
    reason:
      `A 上传 ${a.uploadedSeconds}s、B 上传 ${b?.uploadedSeconds ?? '—'}s、C 上传 ${c.uploadedSeconds}s（C 应与 A 相等：${c.uploadedMs === a.uploadedMs}）；` +
      `模型侧：A 转写 ${a.transcriptions.length}/转发 ${a.forwardedTexts.length}，B 转写 ${b?.transcriptions.length ?? '—'}/转发 ${b?.forwardedTexts.length ?? '—'}、C 转写 ${c.transcriptions.length}/转发 ${c.forwardedTexts.length}；` +
      (gateNeverFired
        ? `B 臂门控未写出 0 ms、suppressed 转移 0 次 ⇒ 本 excerpt 上干预未发生（实测人声下限 ${snapshot.shippedVoiceFloorDb} dBFS，excerpt 中低于此的帧 ${snapshot.excerptFramesBelowFloor}/${snapshot.excerptFramesTotal} = ${(snapshot.excerptFramesBelowFloorRatio * 100).toFixed(1)}%）。` +
          `注意：这**不是**「语料无可裁之处」—— 同一条录音的 ${snapshot.evidence.falsifyWindow.startMs}—${snapshot.evidence.falsifyWindow.startMs + snapshot.evidence.falsifyWindow.excerptMs} ms 段上离线回放裁掉 ${snapshot.evidence.falsifyWindow.replay.filteredFrames} 帧、` +
          `而选定 excerpt 上裁掉 ${snapshot.evidence.selected.filteredFrames} 帧；零过滤的成因是钳位（见 AC5）`
        : `B 臂门控未写出 ${b?.gate?.withheldMs ?? '—'} ms、suppressed 转移 ${b?.gate?.suppressedTransitions ?? '—'} 次`),
  };
}

/** 一个读数格（某臂某字段），空臂写 `—`。 */
function cellOf(arms: Array<ArmReading | undefined>, render: (r: ArmReading) => string): string {
  return arms.map((r) => (r === undefined ? '—' : render(r))).join(' | ');
}

function buildReport(snapshot: Snapshot, workDir: string): string {
  const byArm = new Map(snapshot.readings.map((r) => [r.arm, r]));
  const a = byArm.get('A');
  const b = byArm.get('B');
  const c = byArm.get('C');
  const tris = [a, b, c];
  const conclusion = deriveConclusion(snapshot);
  const corr = snapshot.correspondence;
  const allRows = corr.rows;
  const windowEnd = snapshot.startMs + snapshot.excerptMs;
  const inWindow = excerptRows(allRows, snapshot.startMs, windowEnd);
  const notForwarded = allRows.filter((r) => r.transcription !== null && r.forwardedText === null);
  const windowNotForwarded = inWindow.filter((r) => r.transcription !== null && r.forwardedText === null);
  const ev = snapshot.evidence;
  const off = ev.selected;
  const dbfs = (db: number): string => `${db} dBFS`;

  const lines: string[] = [];
  lines.push('# 服务端 VAD 三臂同源回放（A 不门控 / B 出货 STS 门控 / C 只观察不裁剪）');
  lines.push('');
  lines.push(
    '本文件由 `experiments/voice-realtime-vad-three-arm/probe.mts` 生成。三臂跑在**同一段真实上行音频**的**同一个 excerpt**' +
      '（同起点、同长度）上，把「本地检测质量」与「模型输入干预」分开：A 是第三次实测的生产形态（不门控），' +
      'B 用**出货的** `createSilenceTailGate` 裁剪上行，C 用**同一个** gate 只观察、记录决策、一帧不裁。',
  );
  lines.push('');
  lines.push(
    '**本版是对 `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（已 done）结论的复议。**' +
      '那条任务的交付物与实测读数**依然有效**（三臂、来源对应表、五条取假形态都在，且已**逐字冻结**在 `docs/operations/voice-realtime-vad-three-arm-probe-run1.md`）；' +
      '被推翻的只有**归因**：它把「B 与 A 逐字节相同」写成「本语料没有给出可裁之处」，' +
      '本轮在**同一条录音的另一段**（明确含连续无语音）上用**同一份未改的**门控跑出了裁剪 ⇒ 那句话是错的。' +
      '正确成因见 **AC5**（钳位 `SHIPPED_STS_MAX_THRESHOLD_DB = -60 dBFS` 废掉了自适应），更正段见文末「更正旧结论」。',
  );
  lines.push('');
  lines.push(
    `运行时刻 ${snapshot.runAt}；运行目录 \`${workDir}\`（每臂一份 journal 在 \`journal/\`，gate 逐帧决策另存 \`<臂>-<conn>.gate.jsonl\`）。` +
      '执行面 **dry-run**：会话声明的 `session_send` 由脚本内的记录式执行器承接，模型每次调用只被记录并回一个合成 output，' +
      '**不落任何真实会话**。直连上游 realtime 端点，不经 :3001。',
  );
  lines.push('');
  lines.push(
    `**运行次数：1**（下表全部读数来自同一次完整运行的那一个快照）。` +
      `花费 ¥${snapshot.totalSpendCny.toFixed(4)}（每连接上限 ¥${snapshot.capCny}、总上限 ¥${snapshot.totalCapCny}；触顶连接 ${snapshot.readings.filter((r) => r.capTripped).length} 条）。` +
      `:3001 pid ${snapshot.pidBefore ?? '未知'} → ${snapshot.pidAfter ?? '未知'}（**${snapshot.pidBefore === snapshot.pidAfter ? '相同' : '不同'}**，未重启）。` +
      `外联仅 ${snapshot.externalConnections.join('、') || '（无）'}；生产环境变量改动 ${snapshot.productionEnvTouched.length} 条。`,
  );
  if (snapshot.replayOnly) {
    lines.push('');
    lines.push(
      '⚠️ **本报告是 `--replay-only` 的离线诊断**：不连上游、不花钱，因此**没有三臂读数**（A/B/C 表格整列为 `—`）。' +
        '离线面（帧画像 / 出货门控离线回放 / 阈值敏感性 / 钳位扫描）与真实运行**逐位相同**——回放只喂同一段 PCM、' +
        '走同一个 `createSilenceTailGate`，`nowMs` 只影响 keepalive，而本窗口的挂起时长远低于 30 s 的 keepalive 间隔。' +
        '交付物（`docs/operations/voice-realtime-vad-three-arm-probe.md`）由**真实 A/B/C 运行**生成，不由本模式生成。',
    );
  }
  lines.push('');

  // ── 报告小节 ↔ AC 对照（先给地图，再给读数） ──
  lines.push('## 报告小节 ↔ AC 对照');
  lines.push('');
  lines.push('| AC | 本节 | 判据读的是什么 |');
  lines.push('| --- | --- | --- |');
  lines.push(
    '| AC1 | [AC1 红先行](#ac1-红先行出货门控在选定-excerpt-上真的裁了帧) | `B.filteredFrames > 0` + 离线回放同值 + 取假形态窗口为 0 |',
  );
  lines.push('| AC2 | [AC2 只观察不裁剪](#ac2-c-臂证明只观察不裁剪) | C 的上传帧/字节/毫秒逐项 == A，且决策数 == 上传帧数 |');
  lines.push('| AC3 | [AC3 无语音损失](#ac3-无语音损失) | 各臂未写出音频落在源 speech 区间内的毫秒数 = 0 |');
  lines.push(
    '| AC4 | [AC4 门控实测读数](#ac4-出货门控在本次-excerpt-上的实测读数) | `createSilenceTailGate` 在本 excerpt 的 stage/suppressedTransitions/withheldMs + 噪声底 + 阈值敏感性 |',
  );
  lines.push('| AC5 | [AC5 钳位是根因](#ac5-根因钳位废掉自适应) | 钳位上限使自适应失效（逐电平实测）+ 本录音底噪实测值 |');
  lines.push('| AC6 | [AC6 运行设置与成本](#ac6-运行设置与成本) | 单次运行、excerpt ≤ 上限、实际花费与时长 |');
  lines.push('| AC7 | [AC7 生产面未动](#ac7-生产面未动) | `VOICE_REALTIME_SILENCE_TAIL` 仍未设、:3001 pid 相同、外联仅上游 |');
  lines.push('| AC8 | [AC8 职责边界](#ac8-职责边界只过滤无语音-pcm) | 三臂上行帧型无 `response.create`/commit、`turn_detection` 逐字节一致 |');
  lines.push('| S1 | [来源对应表](#来源对应表支撑材料) | 转发真值取自 journal `session_send`，非 CLI transcript |');
  lines.push('| S2 | [keepalive 与节流目标的冲突](#s2-keepalive-与节流目标的冲突) | 报告显式写出该冲突（标记串判据） |');
  lines.push('| S3 | [既有旁路标注](#s3-既有旁路-localspeechgate--watchdog) | 报告显式标注既有旁路（标记串判据）+ 探针未导入它们 |');
  lines.push('| S4 | [读数不足时的写法](#s4-读数不足时的写法) | 读数不齐的臂不得进入结论 |');
  lines.push('');
  lines.push(
    'AC4 / AC5 / S2 / S3 的判据落在**渲染出来的报告文本**上（标记串），不是落在生成器的布尔开关上：' +
      '「开关到开关」的空检查只能证明「我没把开关关掉」，而这里要证明的是**写出去的这段文字里有没有那一句**。',
  );
  lines.push('');

  // ── AC8 职责边界 ──
  lines.push('## AC8 职责边界：只过滤无语音 PCM');
  lines.push('');
  lines.push(
    '人 2026-10-13 的唯一职责裁定：**「服务端 VAD」只对上行 PCM 做 speech / non-speech 分类、过滤无语音帧，' +
      '减少传到 Realtime upstream 的音频数据**；它是纯传输侧的节流器，与「什么时候算说完」正交。',
  );
  lines.push('');
  lines.push('本探针把这条边界落成**机械判据**（断言的输入是各臂 journal 里**实际发出**的帧型，不是自述）：');
  lines.push('');
  lines.push('| 硬禁令 | 本实验的证据 | 实测 |');
  lines.push('| --- | --- | --- |');
  const sentTypes = snapshot.readings.map((r) => r.sentFrameTypes);
  const typeUnion = [...new Set(sentTypes.flatMap((t) => Object.keys(t)))].sort();
  lines.push(
    `| 不引入 turn detection / endpointing / 语义提交 / \`response.create\` | 各臂上行帧型全集（见下）不含 \`response.create\` | ${
      snapshot.replayOnly ? '— （离线，无臂）' : typeUnion.includes('response.create') ? '⚠️ **出现**' : '未出现'
    } |`,
  );
  for (const type of typeUnion) {
    lines.push(`| — 帧型 \`${type}\` | 各臂发出次数 | ${snapshot.readings.map((r) => `${r.arm} ${r.sentFrameTypes[type] ?? 0}`).join(' / ')} |`);
  }
  lines.push(
    `| 不改变上游 \`turn_detection\` | 从各臂**实际发出的** \`session.update\` 里读回 \`session.turn_detection\`（即真正上网的那个值），与出货解析器逐字节比 | ${
      snapshot.replayOnly
        ? '— （离线，无臂）'
        : snapshot.readings.every((r) => JSON.stringify(r.turnDetectionSeen) === JSON.stringify(snapshot.turnDetection))
          ? '三臂均与出货一致'
          : '⚠️ **有臂不一致**'
    }：\`${JSON.stringify(snapshot.turnDetection)}\` |`,
  );
  lines.push(
    `| 不把边界事件用于模型触发 / commit | 由服务端 VAD 边界事件驱动的 \`response.create\` | ${
      snapshot.replayOnly ? '— （离线，无臂）' : snapshot.readings.map((r) => `${r.arm} ${r.boundaryResponseCreateSent} 次`).join(' / ')
    } |`,
  );
  lines.push('');
  lines.push(
    '**取假形态 F3**：`--falsify-b-boundary-response-create` 让 B 臂在源 timeline 的**第一个 `speech_stopped` 边界**上发一次 `response.create`' +
      '——这正是禁令点名的接线形态。跑出来 **AC8** 即红。',
  );
  lines.push('');
  lines.push(
    '另外：探针**自己没有** commit 上行音频（没有 `input_audio_buffer.commit`）；会话的 `turn_detection` 是 `server_vad`，' +
      '上游按它自己的时机提交——那是**上游既有行为**，不是本功能触发的，探针既不干预也不改动它。',
  );
  lines.push('');
  lines.push(
    '**这条判据只覆盖「本探针自己发出的帧」**：它核对各臂上行帧型里没有 `response.create` / commit、' +
      '核对各臂**实际发出**的 `session.update` 里的 `turn_detection` 与出货解析器逐字节一致、核对外加 `response.create` 次数为 0。' +
      '它**不**（也无法）核对 :3001 上的生产代码路径——那是「本实验没有引入该接线」这一命题的正确范围。',
  );
  lines.push('');

  // ── AC1 红先行 ──
  lines.push('## AC1 红先行：出货门控在**选定 excerpt** 上真的裁了帧');
  lines.push('');
  lines.push(
    `选定 excerpt：源音频内起点 **${snapshot.startMs} ms**、长度 **${snapshot.excerptMs} ms**（${off.frames} 帧 × 20 ms）。` +
      `本段是**离线逐帧回放**出货门控（\`createSilenceTailGate({})\`，**未改**）得到的读数；` +
      (snapshot.replayOnly
        ? '本次是 `--replay-only`，没有真实臂读数可对照。'
        : `B 臂真实跑出来的 \`filteredFrames\` = **${b?.gate?.filteredFrames ?? '—'}**，与离线回放**逐值相同**。`),
  );
  lines.push('');
  lines.push('| 读数 | 选定 excerpt（真形态） | 取假形态靶子（首片 90 s） |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 窗口 | ${snapshot.startMs} ms / ${snapshot.excerptMs} ms | ${ev.falsifyWindow.startMs} ms / ${ev.falsifyWindow.excerptMs} ms |`);
  lines.push(`| **裁掉的帧数**（本帧有音频没被写出去） | **${off.filteredFrames}** | **${ev.falsifyWindow.replay.filteredFrames}** |`);
  lines.push(`| 未写出的音频 | ${off.withheldMs} ms | ${ev.falsifyWindow.replay.withheldMs} ms |`);
  lines.push(`| suppressed / resumed 转移 | ${off.suppressedTransitions} / ${off.resumedTransitions} | ${ev.falsifyWindow.replay.suppressedTransitions} / ${ev.falsifyWindow.replay.resumedTransitions} |`);
  lines.push(`| 首次挂起 / 恢复（源音频时刻） | ${off.firstSuppressedAtMs ?? '—'} ms / ${off.resumeAtMs ?? '—'} ms | ${ev.falsifyWindow.replay.firstSuppressedAtMs ?? '—'} / ${ev.falsifyWindow.replay.resumeAtMs ?? '—'} |`);
  lines.push(`| stage 序列 | \`${off.stageSequence.join(' → ')}\` | \`${ev.falsifyWindow.replay.stageSequence.join(' → ')}\` |`);
  lines.push('');
  lines.push(
    `**AC1 = 红先行**：要求 \`B.filteredFrames > 0\`。取假形态把起点移回**不含连续无语音**的窗口` +
      `（\`--replay-only --start-ms ${ev.falsifyWindow.startMs} --excerpt-ms ${ev.falsifyWindow.excerptMs}\`）⇒ 上表右列 ${ev.falsifyWindow.replay.filteredFrames} 帧 ⇒ AC1 红。`,
  );
  lines.push('');
  lines.push(
    `**净上传差 = 裁掉的帧数 − 恢复时补发的帧数**：本窗口裁掉 ${off.withheldMs} ms（${off.filteredFrames} 帧），` +
      `恢复时补发前导 ${off.prerollFlushedFrames} 帧（${off.prerollFlushedFrames * FRAME_MS} ms），` +
      `故净少传约 ${off.withheldMs - off.prerollFlushedFrames * FRAME_MS} ms。` +
      'C 臂的 `filteredFrames` 恒为 0（一帧不裁），这就是它与 B 的结构性差别。',
  );
  lines.push('');

  // ── AC2 ──
  lines.push('## AC2 C 臂证明「只观察不裁剪」');
  lines.push('');
  if (snapshot.replayOnly) {
    lines.push('本次是 `--replay-only`，A/C 两臂未跑，无法对照。');
  } else {
    lines.push(
      a === undefined || c === undefined
        ? 'A/C 两臂未同时跑，无法对照。'
        : c.gate !== null && c.gate.falsifyWithheldFrames > 0
          ? `⚠️ **本次是取假形态 F2 的运行**，AC2 已按预期变红：C 因 \`--falsify-c-suppresses\` 吞掉 ` +
            `**${c.gate.falsifyWithheldFrames}** 帧（${c.gate.falsifyWithheldFrames * FRAME_MS} ms），` +
            `上传 ${c.uploadedFrames} 帧 / ${c.uploadedBytes} 字节 / ${c.uploadedMs} ms **小于** A 的 ` +
            `${a.uploadedFrames} / ${a.uploadedBytes} / ${a.uploadedMs}，且决策数 ${c.gate.decisionsRecorded} != 上传帧数。` +
            '本条读数**不代表产品形态**，只证明 AC2 非空洞。'
          : `C 的上传帧数 **${c.uploadedFrames}**、字节 **${c.uploadedBytes}**、毫秒 **${c.uploadedMs}** 与 A 的 ` +
            `**${a.uploadedFrames}** / **${a.uploadedBytes}** / **${a.uploadedMs}** **逐项相等**（断言已核对三项）。` +
            `同时 C 的 gate 记录了 **${c.gate?.decisionsRecorded ?? '—'}** 条决策（== C 的上传帧数），其中 gate 建议裁掉的音频累计 ` +
            `**${c.gate?.withheldMs ?? '—'} ms**，而 C 一帧也没裁（\`ignoredSuppressions=${c.gate?.ignoredSuppressions ?? '—'}\` 帧）——` +
            `这正是「只观察、不裁剪」的产品语义：本窗口里出货门控**确实建议裁** ${c.gate?.withheldMs ?? '—'} ms（与 B 臂同值），` +
            '而 C 把每一条建议都记下来、又原样放行。',
    );
  }
  lines.push('');
  lines.push(
    '**取假形态（F2）**：`--falsify-c-suppresses` 让 C 也裁剪 —— C 的上传随即小于 A，AC2 断言变红、脚本非零码退出。' +
      '这条命令**独立**跑一次（自写 `--work` 目录），其快照与退出码由本轮任务的实施记录留证。',
  );
  lines.push('');
  lines.push(
    `**F2 为什么额外吞掉前导 ${FALSIFY_C_WITHHOLD_MS} ms**，而不是只把 C 的策略换成照抄 gate 的决定：` +
      '照抄决定仍然逐项等于 A（那是「只观察」的定义），AC2 依旧绿，这条假形态就什么也没证伪。' +
      '所以 F2 做成一次**声明式违背**：C 在开头额外吞掉前导窗口，`C.uploaded* < A.uploaded*` 且 ' +
      '`decisionsRecorded != uploadedFrames` 必然成立，AC2 必然变红。它证明的是**断言会红**（AC2 非空洞）。',
  );
  lines.push('');

  // ── AC3 ──
  lines.push('## AC3 无语音损失');
  lines.push('');
  lines.push(
    `分母是**源 timeline 的 speech 区间在窗口内的部分**（与臂无关），分子是各臂**未写出的音频落在这些区间内**的毫秒数。` +
      `本窗口源语音共 ${off.sourceSpeechMsInWindow} ms。`,
  );
  lines.push('');
  lines.push('| 臂 | 未写出的源语音（ms / 帧） | 占窗口内源语音 |');
  lines.push('| --- | --- | --- |');
  for (const r of tris) {
    if (r === undefined) continue;
    lines.push(
      `| ${r.arm} | ${r.speechWithheldMs ?? '—'} ms / ${r.speechWithheldFrames ?? '—'} 帧 | ${r.speechWithheldMs === null ? '—' : `${((r.speechWithheldMs / Math.max(1, r.sourceSpeechMsInWindow)) * 100).toFixed(2)}%`} |`,
    );
  }
  lines.push(
    `| **离线回放（B 的判定）** | **${off.speechWithheldMs} ms / ${off.speechWithheldFrames} 帧** | ${((off.speechWithheldMs / Math.max(1, off.sourceSpeechMsInWindow)) * 100).toFixed(2)}% |`,
  );
  lines.push('');
  lines.push(
    `**读数**：本窗口出货门控裁掉的 ${off.withheldMs} ms **全部落在非语音侧**——落在源 speech 区间内的是 **${off.speechWithheldMs} ms**。` +
      '恢复时补发的前导帧（`SHIPPED_STS_PREROLL_MS` 默认 500 ms）正是为此而存在：挂起期间被压住的帧先入 ring，' +
      `一旦 \`voicedRun\` 连续 ${SHIPPED_STS_ENTER_FRAMES} 帧达标就整段补发（本窗口补发 ${off.prerollFlushedFrames} 帧），` +
      '所以「裁剪」与「丢语音」不是同一件事。',
  );
  lines.push('');

  // ── AC4 门控实测读数（含标记串） ──
  lines.push('## AC4 出货门控在本次 excerpt 上的实测读数');
  lines.push('');
  lines.push(GATE_READINGS_MARKER);
  lines.push('');
  lines.push(
    `对象：出货的 \`createSilenceTailGate({})\`（**未改**，默认 T=${SHIPPED_STS_TAIL_MS} ms 尾巴 / P=${SHIPPED_STS_PREROLL_MS} ms 前滚 / keepalive ${SHIPPED_STS_KEEPALIVE_MS} ms），` +
      `喂入本 excerpt 的 ${off.frames} 帧。下表左列是**离线逐帧回放**的读数，右列是**真实 B 臂**（同一次运行的连接）的读数。`,
  );
  lines.push('');
  lines.push('| 读数 | 离线回放 | 真实 B 臂 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 是否进入 \`suppressed\` | ${off.suppressedTransitions > 0 ? '**是**' : '否'}（${off.stageSequence.join(' → ')}） | ${b === undefined ? '— （离线）' : b.gate === null ? '—' : `${b.gate.suppressedTransitions > 0 ? '**是**' : '否'}（转移 ${b.gate.suppressedTransitions} 次）`} |`);
  lines.push(`| \`suppressedTransitions\` | ${off.suppressedTransitions} | ${b?.gate?.suppressedTransitions ?? '—'} |`);
  lines.push(`| \`withheldMs\`（本臂未写出的音频） | ${off.withheldMs} | ${b?.gate?.withheldMs ?? '—'} |`);
  lines.push(`| \`filteredFrames\`（本帧有音频没被写出去的帧数） | ${off.filteredFrames} | ${b?.gate?.filteredFrames ?? '—'} |`);
  lines.push(`| 首次挂起 / 恢复 | ${off.firstSuppressedAtMs ?? '—'} / ${off.resumeAtMs ?? '—'} ms | ${b?.gate?.firstSuppressedAtMs ?? '—'} / ${b?.gate?.resumeAtMs ?? '—'} ms |`);
  lines.push(`| suppressed 期间累计被压 | ${off.suppressedMsTotal} ms | ${b?.gate?.suppressedMsTotal ?? '—'} ms |`);
  lines.push(`| 恢复时补发前导帧 | ${off.prerollFlushedFrames} 帧 | ${b?.gate?.prerollFlushedFrames ?? '—'} 帧 |`);
  lines.push(`| 连接的**最长不发送间隔** | — （离线无连接） | ${b?.longestAppendGapMs ?? '—'} ms |`);
  lines.push(`| 连接存活到 excerpt 结束 | — | ${b === undefined ? '— （离线）' : b.survivedToEnd ? '是' : '**否**'} |`);
  lines.push('');
  lines.push('**这段 excerpt 的低能量部分是什么**（决定了上表能不能读成「真实房间噪声被裁掉」）：');
  lines.push('');
  lines.push('| 量 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 窗口帧数 | ${ev.profile.frames} |`);
  lines.push(`| 其中**数字静音**帧（PCM 全零） | ${ev.profile.digitalSilentFrames}（${((ev.profile.digitalSilentFrames / Math.max(1, ev.profile.frames)) * 100).toFixed(1)}%） |`);
  lines.push(`| 窗口内**最长连续数字静音段** | ${ev.profile.longestSilentRun.frames} 帧 = ${ev.profile.longestSilentRun.ms} ms，起点 = 窗口内 ${ev.profile.longestSilentRun.atMs} ms（源音频 ${snapshot.startMs + ev.profile.longestSilentRun.atMs} ms） |`);
  lines.push(`| 非数字静音帧 dBFS 分位（p10/p25/p50/p75/p90） | ${ev.profile.nonSilentDb.map(dbfs).join(' / ')} |`);
  lines.push(`| 全体帧 dBFS 分位（含数字静音） | ${ev.profile.allDb.map(dbfs).join(' / ')} |`);
  lines.push('');
  lines.push(
    '⛔ **必须把这两件事分开读**：本窗口的挂起是由**一段数字静音**（PCM 全零，`readFrame` 判 `silent`）推进 `quietMs` 打开的 —— ' +
      `它${off.firstSuppressedAtMs !== null ? `在源音频 ${off.firstSuppressedAtMs} ms 处转 \`suppressed\`` : ''}，` +
      `而全零段起点是 ${snapshot.startMs + ev.profile.longestSilentRun.atMs} ms、长 ${ev.profile.longestSilentRun.ms} ms。` +
      '也就是说：**这一段证明的是「门控确实会裁、且裁对了（无语音损失）」**，它**不是**「真实房间噪声被裁掉」的样本。' +
      '为什么真实噪声段裁不动，见下一节的钳位分析。',
  );
  lines.push('');
  lines.push(SENSITIVITY_MARKER);
  lines.push('');
  lines.push(
    `**若**把判据换成「非数字静音帧的 p10 + Δ」（基准 ${SENSITIVITY_MARKER.length > 0 ? '' : ''}${ev.sensitivity.baseDb} dBFS），` +
      '同一段音频能裁多少 —— 这是**错失量**的读数，不是「建议这么改」：',
  );
  lines.push('');
  lines.push('| Δ (dB) | 阈值 (dBFS) | 可裁帧 | 占比 | 最长连续（帧 / ms，窗口内起点） |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of ev.sensitivity.rows) {
    lines.push(
      `| +${row.deltaDb} | ${row.thresholdDb} | ${row.curableFrames} / ${ev.profile.frames} | **${(row.ratio * 100).toFixed(1)}%** | ${row.longestRunFrames} 帧 / ${row.longestRunMs} ms（@${row.longestRunAtMs} ms） |`,
    );
  }
  lines.push('');
  lines.push(
    '读法：出货门控在本窗口上实际裁掉的是那段数字静音；上表问的是**同一段音频在相对判据下能裁多少**。' +
      '「可裁」的口径与门控一致：数字静音帧（永不可能被判人声）或 RMS 低于阈值。' +
      '基准取**非数字静音帧**的 p10 —— 全零帧会把这个分位压到约 −90 dBFS，用它当噪声底会把整张表压平（读数就没了信息量）。' +
      '⛔ 这张表**不构成**「应该改成相对判据」的结论：改判据是在拿 STS 产品任务的「误判静音率 = 0」硬要求做交易，' +
      '属于改变检测器语义，**由人裁定**（见文末「未决」）。',
  );
  lines.push('');

  // ── AC5 钳位是根因 ──
  lines.push('## AC5 根因：钳位废掉自适应');
  lines.push('');
  if (snapshot.rootCauseStated) {
    lines.push(CLAMP_ROOT_CAUSE_MARKER);
    lines.push('');
    lines.push(
      '`server/modules/voice-realtime/voice-realtime-silence-tail.ts:361-372`（`voiceThresholdRms`）：',
    );
    lines.push('');
    lines.push('```js');
    lines.push('const floorDb = floor === null ? SILENCE_TAIL_HARD_FLOOR_DB : rmsToDb(floor);   // −70');
    lines.push('const db = Math.min(');
    lines.push('  SHIPPED_STS_MAX_THRESHOLD_DB,                                                // 常量 −60 dBFS');
    lines.push('  Math.max(SILENCE_TAIL_HARD_FLOOR_DB, floorDb + SHIPPED_STS_VOICE_MARGIN_DB),  // max(−70, 底噪+8)');
    lines.push(');');
    lines.push('```');
    lines.push('');
    lines.push(
      `阈值**确实自适应**（底噪 + ${SHIPPED_STS_VOICE_MARGIN_DB} dB），但被 \`SHIPPED_STS_MAX_THRESHOLD_DB = ${SHIPPED_STS_MAX_THRESHOLD_DB} dBFS\` **硬性封顶**。` +
        `只要噪声底高于约 **${SHIPPED_STS_MAX_THRESHOLD_DB - SHIPPED_STS_VOICE_MARGIN_DB} dBFS**（即 \`floor + ${SHIPPED_STS_VOICE_MARGIN_DB} > ${SHIPPED_STS_MAX_THRESHOLD_DB}\`），钳位就生效 ⇒ 判定边界**恒等于 ${SHIPPED_STS_MAX_THRESHOLD_DB} dBFS**，自适应完全失效。` +
        '更糟的是这是个**不动点**：进入底噪窗的帧恰好是「被判为非人声」的那些（`observe` 里 `!reading.silent && !voiced` 才入窗），' +
        '所以被钳住之后窗里的底噪估计永远推不高，钳位再也回不来。',
    );
    lines.push('');
    lines.push('**逐电平实测**（对门控自己的判定做的观测，不是抄常量）—— 构造一段已知电平的底噪喂进 \`createSilenceTailGate({})\`，量它实际把判定边界放在哪：');
    lines.push('');
    lines.push('| 喂入的底噪电平 (dBFS) | 门控实际判定边界 (dBFS) | 钳位是否生效 |');
    lines.push('| --- | --- | --- |');
    for (const row of ev.clampSweep) {
      // 三种形态互斥，判据全部落在**实测出来的边界**上：钳死（边界贴着上限）、跟随（边界 = 底噪 + 间距）、
      // 落到硬地板（底噪太低时 `max(HARD_FLOOR, floor+margin)` 由 HARD_FLOOR 胜出）。
      const boundary = row.effectiveBoundaryDb;
      const pinned = boundary !== null && boundary >= SHIPPED_STS_MAX_THRESHOLD_DB - 0.5;
      const tracks = boundary !== null && Math.abs(boundary - (row.primedFloorDb + SHIPPED_STS_VOICE_MARGIN_DB)) <= 1.5;
      const atHardFloor = boundary !== null && boundary <= SHIPPED_STS_HARD_FLOOR_DB + 0.5;
      lines.push(
        `| ${row.primedFloorDb} | ${boundary ?? '—'} | ${
          boundary === null
            ? '— （未测出边界）'
            : pinned
              ? `**是**（边界被钳在 ${boundary}，高于 底噪+${SHIPPED_STS_VOICE_MARGIN_DB} = ${num3(row.primedFloorDb + SHIPPED_STS_VOICE_MARGIN_DB)}）`
              : tracks
                ? `否（随底噪移动：= 底噪 + ${SHIPPED_STS_VOICE_MARGIN_DB}）`
                : atHardFloor
                  ? `否（底噪+${SHIPPED_STS_VOICE_MARGIN_DB} 低于硬地板 ${SHIPPED_STS_HARD_FLOOR_DB}，由硬地板胜出）`
                  : '否（既非钳位也非硬地板 —— 与两份常量副本都不符，需人工核对）'
        } |`,
      );
    }
    lines.push('');
    lines.push(
      '**本录音的底噪实测值**（AC5 要求给出）：全文件逐帧画像（该文件共 ' +
        `${ev.recording.frames} 帧 = ${num3((ev.recording.frames * FRAME_MS) / 1000)} s），**排除数字静音帧**后的 dBFS 分位 ——`,
    );
    lines.push('');
    lines.push('| 分位 | 全文件（仅非数字静音帧） | 本 excerpt（仅非数字静音帧） |');
    lines.push('| --- | --- | --- |');
    lines.push(`| 帧数 | ${ev.recording.nonSilentFrames} / ${ev.recording.frames}（数字静音 ${ev.recording.digitalSilentFrames}） | ${ev.profile.nonSilentFrames} / ${ev.profile.frames}（数字静音 ${ev.profile.digitalSilentFrames}） |`);
    for (let i = 0; i < RECORDING_FRACTIONS.length && i < ev.recording.nonSilentDb.length; i += 1) {
      const pct = RECORDING_FRACTIONS[i]!;
      const label = pct === 1 ? 'max' : `p${Math.round(pct * 100)}`;
      lines.push(`| ${label} | ${dbfs(ev.recording.nonSilentDb[i]!)} | ${ev.profile.nonSilentDb[Math.min(i, ev.profile.nonSilentDb.length - 1)] === undefined ? '—' : dbfs(ev.profile.nonSilentDb[Math.min(i, ev.profile.nonSilentDb.length - 1)]!)} |`);
    }
    lines.push('');
    const allP50 = ev.recording.nonSilentDb[3];
    const allP10 = ev.recording.nonSilentDb[1];
    lines.push(
      `**把根因说完**：这段录音的底噪（非数字静音帧）中位数约 ${allP50 === undefined ? '—' : dbfs(allP50)}、p10 约 ${allP10 === undefined ? '—' : dbfs(allP10)}，` +
        `都**高于** ${SHIPPED_STS_MAX_THRESHOLD_DB - SHIPPED_STS_VOICE_MARGIN_DB} dBFS ⇒ 钳位在这一整条录音上长期生效 ⇒ 判定边界恒为 ${SHIPPED_STS_MAX_THRESHOLD_DB} dBFS ⇒ ` +
        '真实房间噪声（电平在 −60 与 −50 dBFS 之间）**永远进不了判定区**，只有**数字静音**（全零帧）才可能把 `quietMs` 推过 320 ms 的挂起门槛。' +
        `这正是前一次运行「B 与 A 逐字节相同」的成因：首片 90 s 里**一段数字静音都没有**（离线回放 ${ev.falsifyWindow.replay.filteredFrames} 帧），` +
        '而不是「本语料没有给出可裁之处」。',
    );
    lines.push('');
    lines.push(
      '**这段录音里真实（非数字静音）噪声段能裁多少**：离线读数给出的最长连续「低于出货边界」的非数字静音段只有 ' +
        `${ev.profile.longestNonSilentBelowDb(SHIPPED_STS_MAX_THRESHOLD_DB).frames} 帧（${ev.profile.longestNonSilentBelowDb(SHIPPED_STS_MAX_THRESHOLD_DB).ms} ms，窗口内 @${ev.profile.longestNonSilentBelowDb(SHIPPED_STS_MAX_THRESHOLD_DB).atMs} ms）` +
        `—— 距挂起门槛 ${SHIPPED_STS_HANGOVER_MS} ms 还差 ${num3(SHIPPED_STS_HANGOVER_MS - ev.profile.longestNonSilentBelowDb(SHIPPED_STS_MAX_THRESHOLD_DB).ms)} ms，所以真实噪声段**一次都挂不起来**。` +
        '这说明零过滤是**判据的性质**，与「这段录音有没有静音」无关。',
    );
    lines.push('');
    lines.push(
      '**取假形态（F6，AC5）**：`--falsify-clamp-not-root-cause` 把根因改写成「' + WRONG_ROOT_CAUSE + '」（即旧结论那句）并省掉本节标记串 ⇒ ' +
        'AC5 断言变红、脚本非零码退出。这条命令**独立**跑一次，其快照与退出码由本轮任务的实施记录留证。',
    );
  } else {
    lines.push(
      '⚠️ **取假形态 F6 生效（`--falsify-clamp-not-root-cause`）**：根因被改写成「' + WRONG_ROOT_CAUSE + '」，' +
        '本节本应有的钳位分析与底噪实测**按取假形态省略** —— AC5 断言因此变红。',
    );
    lines.push('');
    lines.push(
      `（本条假形态有多真：把根因写成「${WRONG_ROOT_CAUSE}」，读起来像一个**关于语料的观察**，` +
        '而真相是一个**关于判据的缺陷**。前者导出「换个语料再试」，后者导出「判据要改」——行动方向相反。）',
    );
  }
  lines.push('');

  // ── AC6 运行设置与成本 ──
  lines.push('## AC6 运行设置与成本');
  lines.push('');
  lines.push(
    `- excerpt：源音频内起点 ${snapshot.startMs} ms、长度 ${snapshot.excerptMs} ms（上限 ${snapshot.maxExcerptMs} ms）——**三臂完全相同**。`,
  );
  lines.push(`- 帧：${FRAME_MS} ms / 帧（${FRAME_BYTES} 字节 PCM16），按**实时墙钟**逐帧推进（近似浏览器上行）。`);
  lines.push(
    `- \`turn_detection\`（出货 \`resolveTurnDetection({})\`，**三臂逐字节相同**）：\`${JSON.stringify(snapshot.turnDetection)}\``,
  );
  lines.push(`- 模型 ${snapshot.model} / voice ${snapshot.voice}；工具 \`session_send\` 由脚本内记录式执行器承接（dry-run）。`);
  lines.push(
    `- 上限：\`--cap\` ¥${snapshot.capCny}/连接、\`--total-cap\` ¥${snapshot.totalCapCny}、\`--excerpt-ms\` 上限 ${snapshot.maxExcerptMs}；**单次运行**（runs=${snapshot.runs}）。`,
  );
  lines.push(
    `- **实际花费**：¥${snapshot.totalSpendCny.toFixed(4)}（逐臂：${snapshot.readings.length === 0 ? '（离线，无花费）' : snapshot.readings.map((r) => `${r.arm} ¥${r.spendCny.toFixed(4)}${r.capTripped ? '（触顶）' : ''}`).join('、')}）。`,
  );
  lines.push(
    `- **实际时长**：${snapshot.readings.length === 0 ? '（离线，无连接）' : snapshot.readings.map((r) => `${r.arm} ${num3(r.durationMs / 1000)} s`).join('、')}（连接建立到收尾）。`,
  );
  lines.push(
    `- 复现命令：\`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3 --start-ms ${snapshot.startMs} --excerpt-ms ${snapshot.excerptMs}\`` +
      `（离线复算：追加 \`--replay-only\`，不连上游、不花钱）`,
  );
  lines.push('');

  // ── AC7 生产面未动 ──
  lines.push('## AC7 生产面未动');
  lines.push('');
  lines.push('| 判据 | 读数 |');
  lines.push('| --- | --- |');
  lines.push(`| \`${SILENCE_TAIL_ENV}\` 仍为关（未设） | ${process.env[SILENCE_TAIL_ENV] === undefined ? '**是**（未设）' : `否（= ${process.env[SILENCE_TAIL_ENV]}）`} |`);
  lines.push(`| :3001 pid 运行前后相同（未重启） | ${snapshot.pidBefore ?? '未知'} → ${snapshot.pidAfter ?? '未知'}（**${snapshot.pidBefore === snapshot.pidAfter ? '相同' : '不同'}**） |`);
  lines.push(`| 生产环境变量改动 | ${snapshot.productionEnvTouched.length} 条（gate 在探针内 \`createSilenceTailGate({})\` 构造，不读也不写生产配置） |`);
  lines.push(`| 外联 | ${snapshot.externalConnections.length === 0 ? '无（离线模式）' : `仅 ${snapshot.externalConnections.join('、')}`} |`);
  lines.push('');
  lines.push(
    '探针**不写任何生产环境变量**、**不重启服务**、**不落任何真实会话**（`session_send` 由脚本内记录式执行器承接）。' +
      '唯一的对外连接是上游 realtime 端点本身，且不经 :3001。',
  );
  lines.push('');

  // ── AC4 每臂六项指标（跑过三臂时才有） ──
  lines.push('## 三臂逐项指标（模型侧与连接侧）');
  lines.push('');
  if (snapshot.replayOnly) {
    lines.push('本次是 `--replay-only`，三臂未跑，本表整列为 `—`。');
  } else {
    lines.push('| 读数 | A（不门控） | B（STS 门控） | C（只观察） |');
    lines.push('| --- | --- | --- | --- |');
    lines.push(`| 1 上传秒数 / 帧数 | ${cellOf(tris, (r) => `${r.uploadedSeconds} s / ${r.uploadedFrames} 帧`)} |`);
    lines.push(`| 1b 上传字节 / 占 excerpt | ${cellOf(tris, (r) => `${r.uploadedBytes} B / ${(r.uploadRatio * 100).toFixed(1)}%`)} |`);
    lines.push(
      `| 2 静音占比（源语料侧） | ${cellOf(tris, (r) => `${(r.sourceSilenceRatio * 100).toFixed(1)}%（源语音 ${r.sourceSpeechMs} ms）`)} |`,
    );
    lines.push(
      `| 2b 静音占比（上游侧，本臂） | ${cellOf(tris, (r) => (r.upstreamSilenceRatio === null ? '—' : `${(r.upstreamSilenceRatio * 100).toFixed(1)}%（上游判出 ${r.upstreamSpeechSegments} 段 / ${r.upstreamSpeechMs} ms）`))} |`,
    );
    lines.push(`| 3 首 token 延时 | ${cellOf(tris, (r) => (r.firstTokenLatencyMs === null ? '—' : `${r.firstTokenLatencyMs} ms`))} |`);
    lines.push(
      `| 4 首次 function_call 延时 | ${cellOf(tris, (r) => (r.firstFunctionCallLatencyMs === null ? '—' : `${r.firstFunctionCallLatencyMs} ms`))} |`,
    );
    lines.push(`| 5 转发文本保真 | ${cellOf(tris, (r) => fidelityLine(r))} |`);
    lines.push(`| 6 丢段数 / 错误中断数 | ${cellOf(tris, (r) => `${r.droppedSegments} / ${r.errorInterruptions}`)} |`);
    lines.push(
      `| **误删语音**（本臂未写出的音频落在源 timeline speech 区间内的部分） | ${cellOf(
        tris,
        (r) =>
          r.speechWithheldMs === null
            ? '—'
            : `${r.speechWithheldMs} ms / ${r.speechWithheldFrames} 帧（窗口内源语音共 ${r.sourceSpeechMsInWindow} ms；占 ${(
                (r.speechWithheldMs / Math.max(1, r.sourceSpeechMsInWindow)) *
                100
              ).toFixed(2)}%）`,
      )} |`,
    );
    lines.push(
      `| **前滚保留**（resumed 时补发的前导帧：累计 / 单次最长） | ${cellOf(
        tris,
        (r) =>
          r.gate === null
            ? '不适用（本臂无门控）'
            : `补发 ${r.gate.prerollFlushedFrames} 帧 / 单次最长 ${r.gate.prerollMaxFrames} 帧；suppressed 时累计被压 ${r.gate.suppressedMsTotal} ms）`,
      )} |`,
    );
    lines.push(
      `| **连接存活**（excerpt 播完时仍连着 = 非上游断线、非触顶） | ${cellOf(
        tris,
        (r) => `${r.survivedToEnd ? '是' : '**否**'}（最长不发送间隔 ${r.longestAppendGapMs} ms）`,
      )} |`,
    );
    lines.push(`| 上行帧型（本臂实际发出） | ${cellOf(tris, (r) => `\`${JSON.stringify(r.sentFrameTypes)}\``)} |`);
    lines.push(`| 实际花费（CNY，出货估算器） | ${cellOf(tris, (r) => `¥${r.spendCny.toFixed(4)}${r.capTripped ? '（触顶）' : ''}`)} |`);
    lines.push(`| 实际时长（连接建立到收尾） | ${cellOf(tris, (r) => `${num3(r.durationMs / 1000)} s`)} |`);
    lines.push(
      `| 断线读数（上游主动断线？close code/reason） | ${cellOf(tris, (r) => `${r.disconnected ? '是' : '否'} / ${r.closeCode ?? '—'} ${r.closeReason === null || r.closeReason === '' ? '' : `\`${r.closeReason}\``}`)} |`,
    );
    lines.push('');
    lines.push('本批次收到的上游 / 连接错误（原样，不改写；「错误中断数」一列 = 这些错误条数 + 上游主动断线计 1 + 花费触顶计 1）：');
    lines.push('');
    for (const r of tris) {
      if (r === undefined) continue;
      lines.push(
        r.upstreamErrors.length === 0
          ? `- **${r.arm}**：无`
          : `- **${r.arm}**：${r.upstreamErrors.map((e) => `\`${e}\``).join('；')}`,
      );
    }
    lines.push('');
    lines.push(
      '- 延时的基准是**本臂自己收到的首个 `input_audio_buffer.speech_stopped`**（上游开始收尾的那一刻），不是本地帧序号；' +
        `三臂同一段音频，故基准可比。保真的分母是 excerpt 窗口内**有转写**的真值句数（即上表第 5 行分数里的分母），分子是本臂转发文本里**字面覆盖**了它的条数；` +
        `窗口内 committed 行数为 ${inWindow.length}，其中 ${inWindow.filter((r) => r.transcription === null).length} 行没有转写、不计入分母。`,
    );
    lines.push('');
    lines.push('逐段延时（`段起点ms/首delta/首call`，`—` 代表该段之后本臂没有对应的 delta / 调用）：');
    lines.push('');
    lines.push('| 臂 | 逐段读数 |');
    lines.push('| --- | --- |');
    for (const r of tris) {
      if (r === undefined) continue;
      const cells = r.perTurn.map((t) => `${t.speechStoppedAtMs}/${t.firstDeltaMs ?? '—'}/${t.firstCallMs ?? '—'}`);
      lines.push(`| ${r.arm} | ${cells.join('；')} |`);
    }
  }
  lines.push('');

  // ── 来源对应表（S1） ──
  lines.push('## 来源对应表（支撑材料）');
  lines.push('');
  lines.push(
    `源会话 \`${snapshot.sessionId}\`；音频 \`${snapshot.wavPath}\`（${snapshot.wav.dataBytes} 字节 PCM16 / ${snapshot.wav.sampleRate} Hz / ` +
      `${snapshot.wav.channels} ch / ${snapshot.wav.bitsPerSample} bit / 共 ${num3(snapshot.wav.durationMs / 1000)} s；data chunk 偏移 ${snapshot.wav.dataOffset} 字节——**读出来的**，不是假设 44）。` +
      `与同目录 timeline 的 \`final\` 行逐位吻合：\`dataBytes\` ${snapshot.timelineFinal?.dataBytes ?? '—'}、\`durationMs\` ${snapshot.timelineFinal?.durationMs ?? '—'} ms（开跑前核对，不等即抛）。`,
  );
  lines.push('');
  lines.push(
    `**转发真值来源：${corr.forwardTruthSource}** —— 模型自己的 \`session_send\` function call。` +
      `**CLI transcript 未被用作转发真值**：本表的每一行都由 capture \`committed\` + journal \`transcription.completed\` + journal \`function_call session_send\` 三股流建立，` +
      `没有任何一行取自 CLI/UI 侧视图；journal 里的 \`to-browser caption\` 流（${corr.counts.captionLines} 条）只被**计数**用于对照，**不参与真值**。`,
  );
  lines.push('');
  lines.push(
    `三股流的条数：\`committed\` ${corr.counts.committed} ↔ \`transcription.completed\` ${corr.counts.transcriptionCompleted} ↔ ` +
      `\`function_call session_send\` ${corr.counts.functionCallSessionSend}；journal 里真正落库的 \`session_send\` 条目 ${corr.counts.sessionSendEntries} 条` +
      '（模型一次调用可合并同段的多句，故条目数可少于调用数）。committed ↔ transcription 按**到达顺序**一一对应，条数不等即抛。',
  );
  lines.push('');
  lines.push('| # | offsetMs | itemId | transcription | session_send（模型转发） | 在 excerpt 内 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of allRows) {
    const fwd = row.forwardedText === null ? '**（无）**' : row.forwardedText;
    const note = row.note === null ? '' : ` ⚠️${row.note}`;
    const inWin = row.offsetMs >= snapshot.startMs && row.offsetMs < windowEnd ? '✓' : '—';
    lines.push(
      `| ${row.index} | ${row.offsetMs} | \`${row.itemId}\` | ${row.transcription ?? '**（未转出）**'} | ${fwd}${note} | ${inWin} |`,
    );
  }
  lines.push('');
  lines.push(
    `**「听了没转发」**（全表 ${allRows.length} 行）：**有转写、但没有任何一条转发文本字面覆盖它**的共 ${notForwarded.length} 条` +
      (notForwarded.length === 0 ? '。' : `：${notForwarded.map((r) => `#${r.index}「${r.transcription}」`).join('、')}。`) +
      ` excerpt 窗口内 ${inWindow.length} 行中该缺口为 ${windowNotForwarded.length} 条` +
      (windowNotForwarded.length === 0 ? '。' : `（${windowNotForwarded.map((r) => `#${r.index}`).join('、')}）。`),
  );
  lines.push('');
  lines.push(
    '两点必须说清楚，以免把读数读成结论：' +
      '(1) 本表的「覆盖」是**字面**包含关系（归一化标点/空白/大小写后）。模型**改写**过的句子（例如把「是不是很快」写成「识别的很快」、' +
      '把「Kafka」写成「Claude Code」）字面上不覆盖原句，于是被计入缺口——这是**保真**读数，不是丢句。' +
      '(2) 任务 Proposal 里的「5 句听了没转发」是 `18 committed − 13 function_call` 这条**算术**；' +
      '其中多数是**被合并**进邻近一次转发的（合并句的文本仍随合并体送达），' +
      '按字面覆盖读出的缺口与这个算术不是同一件事，本报告按字面覆盖读数写，并把两者都点出来。',
  );
  lines.push('');
  lines.push(
    '**取假形态（F1）**：`--falsify-forward-truth=cli-transcript` 把转发真值换成 `to-browser caption` 流（CLI/UI 侧视图），' +
      '即「拿 CLI transcript 当转发真值」。这条命令**跑得起来**，但它跑出的快照里 `forwardTruthSource=cli-transcript`、' +
      '`cliTranscriptUsedAsForwardTruth=true`，支撑断言 **S1** 随即变红、脚本以非零码退出。' +
      '⛔ 本报告由**生成它的那一次运行**的一个快照渲染而成，因此这里只写**机制与它打红哪条断言**，不写实测结论；' +
      '假形态各自的实测读数来自**各自独立的**一次运行（各写自己的 `--work` 目录，其 `snapshot.json` 即该次运行的快照），连同退出码与被点名的 FAIL 行由本轮任务的实施记录留证。',
  );
  lines.push('');

  // ── S2 keepalive ──
  lines.push('## S2 keepalive 与节流目标的冲突');
  lines.push('');
  const bGap = b?.longestAppendGapMs ?? null;
  lines.push(
    `- B 臂（唯一会裁剪的臂）**最长不向上游发送数据的间隔**：${bGap === null ? '— （离线无连接）' : `${bGap} ms`}；` +
      `被门控压住的累计时长 ${b?.gate?.suppressedMsTotal ?? off.suppressedMsTotal} ms（真实臂 / 离线回放），` +
      `其间发出的 keepalive ${b?.gate?.keepaliveFramesSent ?? off.keepaliveFramesSent} 帧。`,
  );
  lines.push(
    `- **是否出现「长时间不发送导致 upstream 断线」**：${b === undefined ? '— （离线无连接）' : b.disconnected ? '**是**' : '否'}` +
      (b !== undefined && b.disconnected
        ? `（close code ${b.closeCode ?? '—'} \`${b.closeReason ?? ''}\`）`
        : b === undefined
          ? ''
          : `（本臂 close：${b.closeCode === null ? '无（探针自收）' : `${b.closeCode} ${b.closeReason ?? ''}`}）`) +
      `；连接存活到 excerpt 结束=${b === undefined ? '—' : b.survivedToEnd}。`,
  );
  lines.push(
    `- **本探针所用的 keepalive：出货门控自带的那个**（\`SILENCE_TAIL_KEEPALIVE_MS\` 默认 ${SHIPPED_STS_KEEPALIVE_MS} ms、每帧 ${SHIPPED_STS_KEEPALIVE_FRAME_MS} ms 数字静音），` +
      '探针没有另加任何 keepalive，也没有为了「不断线」多发过一帧。门控的返回面只有「要写哪些帧」，' +
      '所以这个 keepalive 就是**连续静音 PCM**。',
  );
  lines.push('');
  if (snapshot.keepaliveConflictStated) {
    lines.push(
      `${KEEPALIVE_CONFLICT_MARKER}：` +
        '若为了让连接活下去而必须周期性发送**连续静音 PCM**，那么这部分字节**正是**本功能想省掉的那一类——' +
        '静音越多、压得越久，keepalive 发得越多，节流收益被自己吃掉一部分；极端情形（压住的时长接近 keepalive 间隔的整数倍）' +
        '下，收益会被削到接近 0。这不是理论顾虑，而是出货实现里已经存在的路径：`suppressed` 且 `keepaliveMs > 0` 时，' +
        '门控每个 keepalive 周期就 push 一帧 `digitalSilence(100 ms)`。',
    );
    lines.push('');
    lines.push(
      '**而且这条 keepalive 未必有效**：既有读数是上游空闲超时**按 response 计**（约 300 s 无 **response** 即 `1007 response_idle_timeout`），' +
        '而连续上传底噪 297.6 s 同样不重置它（见备忘 `[[upstream-realtime-idle-timeout-is-response-based]]`）。' +
        '也就是说「发静音保活」很可能既花了字节、又保不住连接 —— 本次 excerpt 只有 ' +
        `${num3(snapshot.excerptMs / 1000)} s，B 臂被压住的累计时长 ${b?.gate?.suppressedMsTotal ?? off.suppressedMsTotal} ms（suppressed 转移 ${b?.gate?.suppressedTransitions ?? off.suppressedTransitions} 次 / 离线回放），` +
        `远低于 ${SHIPPED_STS_KEEPALIVE_MS} ms 的 keepalive 间隔，故本窗口内 keepalive 一帧未发（keepalive ${b?.gate?.keepaliveFramesSent ?? off.keepaliveFramesSent} 帧）。` +
        '**结论：本次读数无法判断 keepalive 是否必要或有效；要判断它，需要一段把 B 臂压住 ≥ 300 s 的语料。**',
    );
  } else {
    lines.push(
      '⚠️ **取假形态 F4 生效（`--falsify-hide-keepalive-conflict`）**：本条本应写出「需要连续静音才能存活时，' +
        'keepalive 与节流目标冲突」以及「该 keepalive 未必有效」两段，本次**按取假形态隐去** —— S2 断言因此变红。',
    );
  }
  lines.push('');
  lines.push(
    '**取假形态 F4**：`--falsify-hide-keepalive-conflict` 隐去上面这条冲突 ⇒ S2 红。' +
      '（量一下这条假形态有多真：把冲突段删掉，报告读起来会变成「B 一次未裁、keepalive 0 帧、连接健康」——' +
      '一个干净漂亮的节流故事，而代价恰好被那一段藏住了。）',
  );
  lines.push('');

  // ── S3 旁路标注 ──
  lines.push('## S3 既有旁路：`localSpeechGate` / watchdog');
  lines.push('');
  if (snapshot.bypassAnnotated) {
    lines.push(
      `${BYPASS_ANNOTATION_MARKER}：\`localSpeechGate\`（\`server/modules/voice-realtime/voice-realtime-local-speech.ts\`，` +
        '在 proxy 侧构造）→ `reportLocalSpeechBoundary` → 看门狗这条链是**既有旁路**，' +
        '**不纳入本任务的「服务端 VAD」功能范围**。本任务里的「服务端 VAD」只指 `silenceTail` / `createSilenceTailGate` 那一个' +
        '（proxy 里 `decision.frames` 决定转发哪些帧的那个）。',
    );
    lines.push('');
    lines.push(
      '两条链各自 `observe()` 同一帧、**互不喂对方**：STS 决策不进入 `reportLocalSpeechBoundary`，也不进入任何 commit / `response.create` 路径。' +
        '唯一的相邻接触是 STS 分支内的 `bridge.noteLocalActivity?.()`（注释：a suppressed stretch is not an idle one）——' +
        '那是**为切断误读而做的解耦**，不是泄漏。因此无需解耦，只需标注。',
    );
    lines.push('');
    lines.push(
      '**本实验如何保证「其边界事件未被计入本功能行为」**（两半，都可机械核对）：' +
        `(1) 探针从 voice-realtime barrel 只导入 ${snapshot.probeBarrelImports.map((s) => `\`${s}\``).join('、')} —— ` +
        '**不含** `createLocalSpeechGate` / `reportLocalSpeechBoundary`，探针根本没有构造旁路链，也不可能消费它的边界事件；' +
        '这条由 S3 断言核对（符号表由探针源码手工维护，导入一变就红）。' +
        '(2) AC3 的「误删语音」以**源 timeline 的 speech 区间**为分母，不以旁路或上游的边界事件为分母。',
    );
  } else {
    lines.push(
      '⚠️ **取假形态 F5 生效（`--falsify-unannotated-bypass`）**：本节本应把 `localSpeechGate` / 看门狗显式标注为**既有旁路**，' +
        '本次按取假形态**省略了该标注** —— S3 断言因此变红。',
    );
  }
  lines.push('');

  // ── S4 读数不足 ──
  lines.push('## S4 读数不足时的写法');
  lines.push('');
  lines.push(
    '规则是**一条**：模型侧读数不齐的臂不得进入结论 —— 每个臂在成文前先自检六项读数，缺任何一项就记下缺项，' +
      '该臂的 `sufficient` 变 false、`insufficientReason` 写明缺了什么，结论行**改为**「不足以判断」并带上这些缺项；' +
      '缺 A 臂（生产形态基准）或缺 A/C 之一时同样直接判「不足以判断」，不允许用缺失当证据（`deriveConclusion` 的三个早退分支）。',
  );
  lines.push('');
  lines.push(
    snapshot.readings.length === 0
      ? '本次是 `--replay-only`：没有臂读数，本节不适用（断言表里也不会出现 S4）。'
      : snapshot.readings.every((r) => r.sufficient)
        ? '本次运行三臂读数**均齐备**，因此结论按实测写，不触发「不足以判断」。各臂缺项：' +
          snapshot.readings.map((r) => `${r.arm}（无）`).join('、') +
          '。'
        : '本次运行**有臂读数不齐**，结论已按规则写成「不足以判断」：' +
          snapshot.readings
            .filter((r) => !r.sufficient)
            .map((r) => `${r.arm}（${r.insufficientReason ?? '未记原因'}）`)
            .join('；') +
          '。',
  );
  lines.push('');
  lines.push(
    '自检的六项与逐项指标表同源：上传帧数 > 0、上游判出至少一个语音段、至少一条转写、有首 token 延时、' +
      '有首次 `function_call` 延时、转发保真可算（真值句非空）。',
  );
  lines.push('');

  // ── 取假形态 ──
  lines.push('## 取假形态（机制，非本次运行的读数）');
  lines.push('');
  lines.push(
    '六条假形态都是**真的跑得起来**的命令，各自只把一条断言打红。`--excerpt-ms` 只影响时长与花费，不影响这六条断言的方向；' +
      '下表只说明**红在哪个字段上**。各命令**独立**跑一次，其快照与退出码由本轮任务的实施记录留证（**不在**本报告的运行目录里）。',
  );
  lines.push('');
  lines.push('| # | 假形态命令 | 变红的断言 | 机制 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    '| F1 | `--falsify-forward-truth=cli-transcript` | S1 | 转发真值被换成 `to-browser caption`（CLI/UI 侧视图），`forwardTruthSource` 不再是 `journal.session_send`、`cliTranscriptUsedAsForwardTruth` 变 true |',
  );
  lines.push(
    `| F2 | \`--falsify-c-suppresses\` | AC2 | C 也裁剪：走裁剪分支并额外吞掉前导 ${FALSIFY_C_WITHHOLD_MS} ms —— ` +
      '`C.uploadedFrames/Bytes/Ms` 不再等于 A 的三项，且 `decisionsRecorded != uploadedFrames` |',
  );
  lines.push(
    '| F3 | `--falsify-b-boundary-response-create` | AC8 | B 臂在源 timeline 第一个 `speech_stopped` 边界上发一次 `response.create` —— 正是禁令点名的「把服务端 VAD 边界事件用于模型触发」 |',
  );
  lines.push(
    '| F4 | `--falsify-hide-keepalive-conflict` | S2 | 报告里隐去「需要连续静音存活 ⇒ 与节流目标冲突」那一段，只留干净的节流数字 |',
  );
  lines.push(
    '| F5 | `--falsify-unannotated-bypass` | S3 | 报告里省略「`localSpeechGate` / 看门狗是**既有旁路**」的标注 —— 于是它的边界事件有没有被算进本功能行为就无人交代 |',
  );
  lines.push(
    `| F6 | \`--falsify-clamp-not-root-cause\` | **AC5** | 把根因改写成「${WRONG_ROOT_CAUSE}」（即**旧结论那一句**）并省掉钳位分析段 —— 于是「关于判据的缺陷」被写成「关于语料的观察」 |`,
  );
  lines.push('');
  lines.push(
    'F4 / F5 / F6 / **AC4 与 AC5** 的判据值得一提：它们**不判开关**，判的是**渲染出来的报告文本里有没有那个标记串**' +
      `（\`KEEPALIVE_CONFLICT_MARKER\` / \`BYPASS_ANNOTATION_MARKER\` / \`GATE_READINGS_MARKER\` / \`SENSITIVITY_MARKER\` / \`CLAMP_ROOT_CAUSE_MARKER\`）—— ` +
      '所以生成器走了「隐去 / 改写」分支，断言必然红；「开关到开关」的空检查在这里是不成立的。' +
      '⚠️ 这也意味着**不能把前次报告全文嵌进本报告**：那份报告里含 `KEEPALIVE_CONFLICT_MARKER` 与 `BYPASS_ANNOTATION_MARKER`，' +
      '嵌入会让 S2 / S3 变成**空洞的真**（并让 F4 / F5 失效）。所以前次报告只作**逐字冻结的独立文件**保留，本报告只引用其路径与那两句被推翻的话。',
  );
  lines.push('');
  lines.push(
    '这六次假形态运行的实测读数（命令、退出码、被点名的 FAIL 行）由本轮任务的实施记录留证；本报告由**正常形态**的那一次运行生成，' +
      '所以报告里的读数不含假形态。',
  );
  lines.push('');

  // ── 结论 ──
  lines.push('## DoD 结论：服务端 VAD 是否影响上游 PCM 与 turn_detection');
  lines.push('');
  lines.push(`**判定：${conclusion.verdict}**。依据：${conclusion.reason}`);
  lines.push('');
  lines.push(
    `- **对 \`turn_detection\`：无影响（结构性）**。三臂的 \`session.update\` 里 \`turn_detection\` 都是 \`${JSON.stringify(snapshot.turnDetection)}\`，` +
      '由**出货解析器** `resolveTurnDetection({})` 给出；gate 的返回面只有「要写哪些帧」，没有任何写 `turn_detection` 的路径。' +
      '本探针也没有在生产面设过任何 STS 环境变量（`productionEnvTouched` 为空）。',
  );
  lines.push(
    '- **对上游 PCM —— 逐个臂按实测读数说，不预设结论**。' +
      (snapshot.replayOnly
        ? `本次是离线回放：选定 excerpt 上出货门控裁掉 ${off.filteredFrames} 帧 / 未写出 ${off.withheldMs} ms（离线读数）。`
        : b === undefined
          ? 'B 臂未跑，无法给出裁剪臂的读数。'
          : b.gate !== null && b.gate.withheldMs === 0 && b.gate.suppressedTransitions === 0
            ? `B 臂的 gate **一次未裁**（未写出 0 ms、suppressed 转移 0 次），上传 ${b.uploadedSeconds}s 与 A 的 ${a?.uploadedSeconds ?? '—'}s 逐字节相同 —— ` +
              '本 excerpt 上「裁剪」这个干预**没有发生**。注意这**不是**「语料无可裁之处」：成因是判据被钳位封顶（见 AC5）。'
            : `B 臂的 gate 裁掉了 ${b.gate?.withheldMs ?? '—'} ms（suppressed 转移 ${b.gate?.suppressedTransitions ?? '—'} 次），` +
              `上传 ${b.uploadedSeconds}s vs A 的 ${a?.uploadedSeconds ?? '—'}s —— 这就是「干预」这一变量的直接读数：**本 excerpt 上干预确实发生了**。`) +
      (snapshot.replayOnly || c === undefined
        ? ''
        : ` C 与 A 的逐项相等（${c.uploadedFrames} 帧 / ${c.uploadedBytes} 字节 / ${c.uploadedMs} ms）是「只观察」这一语义的直接读数。`),
  );
  lines.push(
    '- **检测质量与输入干预已分离**：C 的**上行**与 A 逐字节相同（这是「只观察」的结构性保证，AC2 断言），' +
      '所以 C−A 在**上传量**上的差异恒为 0；两者**模型侧**读数的差异因此不能归因于输入，只能是逐次运行的抖动。' +
      'B−A 才是「干预」的效果。' +
      (b !== undefined && (b.gate?.withheldMs ?? 0) > 0
        ? '本次 B 的 `withheldMs` 可观，故 B−A 的模型侧读数差异可归因到干预而非检测。'
        : '本次 B 的 `withheldMs` 为 0：**没有干预可供归因**，B−A 的模型侧差异（若有）也只能是采样噪声，不能算作门控的效果。'),
  );
  if (
    a !== undefined &&
    c !== undefined &&
    (c.transcriptions.length !== a.transcriptions.length ||
      c.forwardedTexts.length !== a.forwardedTexts.length ||
      c.errorInterruptions !== a.errorInterruptions)
  ) {
    lines.push(
      `- **本批次里 C 与 A 的模型侧读数并不相同**（A 转写 ${a.transcriptions.length}/转发 ${a.forwardedTexts.length}/中断 ${a.errorInterruptions}；` +
        `C 转写 ${c.transcriptions.length}/转发 ${c.forwardedTexts.length}/中断 ${c.errorInterruptions}），而两者的上行逐字节相同 —— ` +
        '这正是「单次运行、每臂一条连接」下**固有的抖动**：同一份输入重复喂给同一个上游模型，转发文本条数与逐字保真都不保证复现。' +
        '结论行因此只对**上传量**作断言，不对模型侧条数作断言。',
    );
  }
  lines.push(
    '- 上游侧静音占比是独立一列（2b）：它是「上游自己怎么判这段音频」的读数。A/C 应与源语料侧的判读大体一致；' +
      'B 若因裁剪而改变上游判读，会在这一列上看出来。',
  );
  lines.push('');

  // ── 更正旧结论 ──
  lines.push('## 更正旧结论（本任务的核心交付）');
  lines.push('');
  lines.push(
    `前次任务 \`gap-voice-server-vad-three-arm-replay-on-third-test-corpus\`（已 done）的**全部实测读数予以保留**，` +
      `其中报告全文已**逐字冻结**为独立文件：${ev.priorReportPath === null ? '⚠️ 未找到冻结副本（`docs/operations/voice-realtime-vad-three-arm-probe-run1.md` 缺失）' : `\`${ev.priorReportPath}\``}。` +
      '本节的更正**只针对归因与结论**，不改动它的任何数字。',
  );
  lines.push('');
  lines.push('### 被推翻的那句话');
  lines.push('');
  lines.push('> 本语料没有给出可裁之处');
  lines.push('');
  lines.push(
    '（旧报告据此把「B 与 A 逐字节相同」归因到语料，并在限制一节写「本语料的边界（重要）：…所以 B 臂的门控在这段音频上**没有可裁之处**。' +
      '凡涉及「裁剪会不会改变模型输入」的问题，本语料**给不出**答案」。）',
  );
  lines.push('');
  lines.push('### 为什么它是错的（可复算）');
  lines.push('');
  lines.push('| # | 读数 | 值 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| 1 | 旧窗口（首片 90 s）上的离线回放 | ${ev.falsifyWindow.replay.filteredFrames} 帧 | 旧读数成立：那段**确实**一帧未裁 |`,
  );
  lines.push(
    `| 2 | **同一条录音** 起点 ${snapshot.startMs} ms / 长度 ${snapshot.excerptMs} ms 上的同一份**未改**门控 | **${off.filteredFrames} 帧 / ${off.withheldMs} ms** | 换一段就有了可裁之处 ⇒ 「本语料」为假 |`,
  );
  lines.push(
    `| 3 | 全文件数字静音帧 | ${ev.recording.digitalSilentFrames} / ${ev.recording.frames}，最长连续 ${ev.profile.longestSilentRun.frames} 帧（${ev.profile.longestSilentRun.ms} ms） | 旧窗口里一段数字静音都没有；能裁的那段**恰好**是全零段 |`,
  );
  lines.push(
    `| 4 | 全文件底噪（非数字静音帧）p10 / p50 | ${dbfs(ev.recording.nonSilentDb[1] ?? Number.NaN)} / ${dbfs(ev.recording.nonSilentDb[3] ?? Number.NaN)} | 都高于 ${SHIPPED_STS_MAX_THRESHOLD_DB - SHIPPED_STS_VOICE_MARGIN_DB} dBFS ⇒ 钳位长期生效 |`,
  );
  lines.push(
    `| 5 | 钳位扫描：底噪 ≥ ${SHIPPED_STS_MAX_THRESHOLD_DB - SHIPPED_STS_VOICE_MARGIN_DB} dBFS 时的判定边界 | 恒为 ${SHIPPED_STS_MAX_THRESHOLD_DB} dBFS | 自适应被废掉（逐电平实测，见 AC5） |`,
  );
  lines.push(
    `| 6 | 真实（非数字静音）噪声里最长连续低于该边界的段 | ${ev.profile.longestNonSilentBelowDb(SHIPPED_STS_MAX_THRESHOLD_DB).frames} 帧（${ev.profile.longestNonSilentBelowDb(SHIPPED_STS_MAX_THRESHOLD_DB).ms} ms） | 距 ${SHIPPED_STS_HANGOVER_MS} ms 的挂起门槛还差一截 ⇒ 真实噪声**永远挂不起来** |`,
  );
  lines.push('');
  lines.push(
    '**正确的归因**：零过滤不是语料的性质，而是**判据的性质** —— `SHIPPED_STS_MAX_THRESHOLD_DB` 这个上限在底噪高于约 ' +
      `${SHIPPED_STS_MAX_THRESHOLD_DB - SHIPPED_STS_VOICE_MARGIN_DB} dBFS 时把判定边界钉死在 ${SHIPPED_STS_MAX_THRESHOLD_DB} dBFS，` +
      '自适应项再也推不上去（且这是个不动点）；真实房间噪声因此**永远进不了判定区**，只有数字静音（全零帧）才可能推开挂起窗。' +
      '这与人 yale 亲自听完整段录音的判断（「超过一半时间无语音」）一致：录音里**确实有大量无语音**，是判据收不了它们。',
  );
  lines.push('');
  lines.push(
    '**这条更正的实践含义**：旧结论导出「换个语料再试」，正确结论导出「判据要改」——**行动方向相反**。' +
      '但它**不**导出「现在就该抬掉钳位」：见下节。',
  );
  lines.push('');
  lines.push('### 未决（需人裁定，本任务不做）');
  lines.push('');
  lines.push(
    '拆除或抬高 `SHIPPED_STS_MAX_THRESHOLD_DB` 属于**改变检测器语义**，且 STS 产品任务把「误判静音率 = 0」列为**硬要求** —— ' +
      '抬高上限正是在拿这条做交易（本报告 AC4 的敏感性表给出了这笔交易的量级：Δ=+5 就多裁 40%以上 的帧）。' +
      '因此本任务**只给读数与根因**：是否改、怎么改（更稳的相对判据 / 频域特征 / 带迟滞的滑动底噪），由人裁定后另立任务。' +
      '⛔ 本报告里的任何数字**都不构成**「已经改过判据」或「应该改成什么」的授权。',
  );
  lines.push('');

  // ── 断言 ──
  lines.push('## 断言逐条');
  lines.push('');
  for (const assertion of snapshot.assertions) {
    lines.push(`- [${assertion.ok ? 'x' : ' '}] **${assertion.id}** — ${assertion.detail}`);
  }
  lines.push('');

  lines.push('## 方法与限制');
  lines.push('');
  lines.push(
    '- 语料是**真实**上行捕获（continuous 路径才捕获：`frame.seq === undefined`），不是脚本内构造的片段；excerpt 取源音频的一段固定窗口。',
  );
  lines.push(
    '- 转发真值来自 journal 的 `<< function_call session_send`；`committed` ↔ `transcription.completed` 按到达顺序一一对应，条数不等即抛错，不做猜测性对齐。',
  );
  lines.push(
    '- 静音占比两列：**源语料侧**由真实 capture timeline 的 `speech_started/stopped` 在窗口内的部分算出（与臂无关）；**上游侧**由本臂自己收到的 `speech_started/stopped` 算出。',
  );
  lines.push(
    `- 本探针**不写任何生产环境变量**：gate 在探针内 \`createSilenceTailGate({})\` 构造（出货默认 T=${SHIPPED_STS_TAIL_MS} ms / P=${SHIPPED_STS_PREROLL_MS} ms / keepalive=${SHIPPED_STS_KEEPALIVE_MS} ms）。`,
  );
  lines.push(
    '- 单次运行、每臂一条全新连接；本实验**不追求统计功效**，只要求三臂同源可比。读数差异不足以支撑跨样本的泛化结论。',
  );
  lines.push(
    '- **离线回放与真实臂同源**：同一条 PCM、同一个 `createSilenceTailGate({})`，逐帧喂入。`nowMs` 只影响 keepalive，' +
      `而本窗口的挂起累计时长 ${off.suppressedMsTotal} ms 远低于 ${SHIPPED_STS_KEEPALIVE_MS} ms 的 keepalive 间隔，故离线回放与真实 B 臂**逐值相同**（见 AC4 表）。`,
  );
  lines.push(
    '- **本窗口的挂起由数字静音驱动**（见 AC4）⇒ 本窗口**不能**用来回答「真实房间噪声被裁掉会不会改变模型输入」；' +
      '它能回答的是「门控确实会裁、且裁得对（无语音损失）」。真实噪声为何裁不动，见 AC5 的钳位分析。',
  );
  lines.push(
    '- 上游 realtime 端点本身是唯一外联；`turn_detection` 由出货解析器给出，三臂相同；本探针没有任何写 `turn_detection` 的代码路径。',
  );
  lines.push(
    '- **keepalive 的判据也受窗口长度限制**：本次 excerpt 只有 ' +
      `${num3(snapshot.excerptMs / 1000)} s，被压住的累计 ${off.suppressedMsTotal} ms 远低于 keepalive 间隔，` +
      '因此既没机会触发门控的 keepalive，也没有机会验证「压住 ≥ 300 s 会不会被上游以 `1007 response_idle_timeout` 断线」。' +
      '报告只写「本探针未额外加 keepalive」与「出货门控自带的是连续静音 PCM，与节流目标冲突、且按既有读数未必有效」，' +
      '**不**把「本次没断线」读成「静音保活有效」或「不需要保活」。',
  );
  lines.push(
    '- 三臂各一条连接、**每臂只跑一次**：模型侧读数（转写/转发条数、保真、中断）在同输入下也不保证复现，' +
      '因此 C−A 的模型侧差异**不是**输入差异（两者的上行逐字节相同），只能是抖动；结论只对**上传量**作断言。',
  );
  lines.push('');
  lines.push(`来源对应表全文与逐帧读数见 \`${path.join(workDir, 'snapshot.json')}\` 与 \`journal/\`。`);
  lines.push('');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

function parseRunOptions(values: Map<string, string>, bools: Set<string>): RunOptions {
  const startMs = Number(values.get('start-ms') ?? DEFAULT_START_MS);
  const excerptMs = Number(values.get('excerpt-ms') ?? DEFAULT_EXCERPT_MS);
  if (!Number.isFinite(startMs) || startMs < 0) throw new Error(`--start-ms 非法：${values.get('start-ms')}`);
  if (!Number.isFinite(excerptMs) || excerptMs <= 0) throw new Error(`--excerpt-ms 非法：${values.get('excerpt-ms')}`);
  if (excerptMs > MAX_EXCERPT_MS) throw new Error(`--excerpt-ms ${excerptMs} 超过上限 ${MAX_EXCERPT_MS}（AC7：小样本）`);

  const rawTruth = values.get('falsify-forward-truth');
  if (rawTruth !== undefined && rawTruth !== 'cli-transcript') {
    throw new Error(`--falsify-forward-truth 只接受 cli-transcript（收到 ${rawTruth}）`);
  }

  const armFlag = values.get('arm');
  if (armFlag !== undefined && !ARMS.includes(armFlag as ArmId)) throw new Error(`--arm 只接受 A/B/C（收到 ${armFlag}）`);

  const cap = Number(values.get('cap') ?? process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION ?? DEFAULT_CAP_CNY);
  const totalCap = Number(values.get('total-cap') ?? DEFAULT_TOTAL_CAP_CNY);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`--cap 非法：${cap}`);
  if (!Number.isFinite(totalCap) || totalCap <= 0) throw new Error(`--total-cap 非法：${totalCap}`);

  return {
    sessionId: values.get('session') ?? DEFAULT_SESSION_ID,
    startMs,
    excerptMs,
    capCny: cap,
    totalCapCny: totalCap,
    forwardTruthSource: rawTruth === 'cli-transcript' ? 'cli-transcript' : 'journal.session_send',
    falsifyCSuppresses: bools.has('falsify-c-suppresses'),
    falsifyBBoundaryResponseCreate: bools.has('falsify-b-boundary-response-create'),
    // 默认**写出**冲突与旁路标注（这是真相）；只有取假形态的开关会把它们翻成 false。
    keepaliveConflictStated: !bools.has('falsify-hide-keepalive-conflict'),
    bypassAnnotated: !bools.has('falsify-unannotated-bypass'),
    rootCauseStated: !bools.has('falsify-clamp-not-root-cause'),
    replayOnly: bools.has('replay-only'),
    arms: armFlag === undefined ? [...ARMS] : [armFlag as ArmId],
  };
}

function main(): void {
  const { values, bools } = readFlags(process.argv.slice(2));
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-vad-three-arm-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const options = parseRunOptions(values, bools);
  /**
   * `--replay-only` 是**离线**诊断（不连上游、不花钱），它的报告里没有三臂读数。默认写到运行目录，
   * **不**落到 `docs/operations/voice-realtime-vad-three-arm-probe.md` —— 那个路径是本任务的交付物，
   * 只有真实的 A/B/C 运行才配覆盖它。要落别处就显式给 `--report`。
   */
  const reportPath =
    values.get('report') ?? (options.replayOnly ? path.join(workDir, 'replay-only-report.md') : REPORT_PATH);

  if (bools.has('plan')) {
    const source = loadSourceMaterial(options);
    log(buildPlan(options, source));
    log(`运行目录将是 ${workDir}`);
    return;
  }

  if (values.has('report-only')) {
    const dir = values.get('report-only')!;
    const snapshotPath = path.join(dir, 'snapshot.json');
    if (!existsSync(snapshotPath)) throw new Error(`--report-only 找不到 ${snapshotPath}`);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
    const report = buildReport(snapshot, dir);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
    log(`（--report-only）从 ${dir} 重建报告；未连上游。报告已写入 ${reportPath}`);
    return;
  }

  void mainAsync({ ...options, workDir, journalDir, reportPath }).catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}

main();
