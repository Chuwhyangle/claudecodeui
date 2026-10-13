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
 *   … --excerpt-ms 90000         excerpt 长度（毫秒，⛔ 上限 90000）
 *   … --start-ms 0               excerpt 在源音频内的起点（毫秒，三臂共用）
 *   … --arm A                    只跑某一臂（返工用；默认三臂全跑）
 *   … --report-only <dir>        从 `<dir>/snapshot.json` 离线重建报告（不连上游、不花钱）
 *   … --falsify-forward-truth=cli-transcript   取假形态：改用 CLI/UI caption 流作转发真值 ⇒ S1 红
 *   … --falsify-c-suppresses                    取假形态：让 C 也裁剪（额外吞掉前导 500 ms）⇒ AC3 红
 *   … --falsify-b-boundary-response-create      取假形态：让 B 臂的边界事件驱动一次 response.create ⇒ AC1 红
 *   … --falsify-hide-keepalive-conflict         取假形态：报告隐去 keepalive 与节流目标的冲突 ⇒ AC5 红
 *   … --falsify-unannotated-bypass              取假形态：报告省略「既有旁路」标注 ⇒ AC6 红
 *   … --report <path>            报告写到别处（取假形态跑的时候用，免得盖掉定稿报告）
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
const DEFAULT_EXCERPT_MS = 90_000;
const DEFAULT_START_MS = 0;

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
  /** 出货解析器给出的 `turn_detection`（三臂共用）—— AC1 用它做「没被本功能改动」的比对基准。 */
  turnDetection: unknown;
  /**
   * **同一份快照渲染出来的报告正文**（断言表留空的那一版）。AC5 / AC6 直接在这段文字上判标记串，
   * 而不是判开关 —— 详见 `KEEPALIVE_CONFLICT_MARKER` 的注释。
   */
  reportText: string;
}): Assertion[] {
  const { source, rows, readings, options, pidBefore, pidAfter, actualExcerptMs, turnDetection, reportText } = input;
  const byArm = new Map(readings.map((r) => [r.arm, r]));
  const a = byArm.get('A');
  const b = byArm.get('B');
  const c = byArm.get('C');
  const assertions: Assertion[] = [];
  const corr = source.correspondence;

  // ── AC1 职责边界是判据 ──
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
  const ac1 = forbiddenSent.length === 0 && boundaryDriven.length === 0 && turnDetectionSame && readings.length > 0;
  assertions.push({
    id: 'AC1',
    ok: ac1,
    detail:
      `职责边界：三臂都只发 session.update ×1 + input_audio_buffer.append；` +
      `禁用帧（${FORBIDDEN_SENT.join(' / ')}）共 ${forbiddenSent.length} 处${forbiddenSent.length > 0 ? `（${forbiddenSent.join('、')}）` : ''}；` +
      `由边界事件驱动的 response.create ${boundaryDriven.reduce((s, r) => s + r.boundaryResponseCreateSent, 0)} 次；` +
      `三臂 session.update 里的 turn_detection 与出货解析器输出一致=${turnDetectionSame}（${JSON.stringify(turnDetection)}）`,
  });

  // ── S1 支撑材料：转发真值必须取自 journal 的 session_send ──
  // 这不是新 AC 集里的一条 AC，而是 AC4「转发保真」那一列的**分母来源**：若真值换成 CLI/UI caption 流
  // （那是「用户看到了什么」，不是「转发出去的是什么」），保真读数就换了参照系、整列失效。
  // 它必须是一条**会红的断言**，否则 `--falsify-forward-truth=cli-transcript` 这条假形态就没有靶子，
  // 会静默地跑成绿色。
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

  // ── AC2 ──
  const sameWindow =
    readings.length > 0 &&
    readings.length === options.arms.length &&
    readings.every((r) => r.excerptMs === actualExcerptMs);
  assertions.push({
    id: 'AC2',
    ok: sameWindow,
    detail:
      `同源同起点同长度：源 ${options.sessionId}、起点 ${options.startMs} ms、excerpt ${actualExcerptMs} ms；` +
      `实跑臂 ${readings.map((r) => r.arm).join('/') || '（无）'}；退出码 0 且写 snapshot.json`,
  });

  // ── AC3 C 臂证明「只观察」（原 AC4 的语义，新编号下是 AC3） ──
  const ac4 =
    a !== undefined &&
    c !== undefined &&
    c.uploadedFrames === a.uploadedFrames &&
    c.uploadedBytes === a.uploadedBytes &&
    c.uploadedMs === a.uploadedMs &&
    c.gate !== null &&
    a.gate === null &&
    c.gate.decisionsRecorded === c.uploadedFrames;
  assertions.push({
    id: 'AC3',
    ok: ac4,
    detail:
      a === undefined || c === undefined
        ? 'A/C 两臂未同时跑，无法对照'
        : `C 上传 帧 ${c.uploadedFrames} / 字节 ${c.uploadedBytes} / 毫秒 ${c.uploadedMs} vs A 上传 帧 ${a.uploadedFrames} / 字节 ${a.uploadedBytes} / 毫秒 ${a.uploadedMs}；` +
          `C 记录决策 ${c.gate?.decisionsRecorded ?? '—'} 条（应 == C 上传帧数）；` +
          (c.gate !== null && c.gate.falsifyWithheldFrames > 0
            ? `⚠️ 取假形态 F2 生效：C 因 --falsify-c-suppresses 吞掉 ${c.gate.falsifyWithheldFrames} 帧` +
              `（${c.gate.falsifyWithheldFrames * FRAME_MS} ms）—— 上传不再等于 A，且决策数不再等于上传帧数`
            : `C 本会裁掉 ${c.gate?.withheldMs ?? '—'} ms 但一帧未裁（ignoredSuppressions=${c.gate?.ignoredSuppressions ?? '—'}）`),
  });

  // ── AC4 六项指标齐备 × 三臂 ──
  // 上行发送帧/字节、误删语音（对源 timeline 的 speech 区间）、前滚保留、时延、转发保真、连接存活。
  const metricGaps: string[] = [];
  for (const r of readings) {
    const miss: string[] = [];
    if (r.uploadedFrames === 0) miss.push('上行发送帧/字节');
    if (r.speechWithheldMs === null || r.sourceSpeechMsInWindow === null) miss.push('误删语音');
    if (r.firstTokenLatencyMs === null || r.firstFunctionCallLatencyMs === null) miss.push('时延');
    if (r.forwardingFidelity === null) miss.push('转发保真');
    if (r.survivedToEnd === undefined) miss.push('连接存活');
    // 前滚保留只对**有 gate 的臂**有意义：A 臂没有门控，这一项按「不适用」记，不算缺项。
    if (r.gate !== null && r.gate.prerollMaxFrames === undefined) miss.push('前滚保留');
    if (miss.length > 0) metricGaps.push(`${r.arm}（缺 ${miss.join('/')}）`);
  }
  const ac4Six = readings.length > 0 && metricGaps.length === 0;
  assertions.push({
    id: 'AC4',
    ok: ac4Six,
    detail: ac4Six
      ? `三臂六项指标齐备：` +
        readings
          .map(
            (r) =>
              `${r.arm} 上行 ${r.uploadedFrames} 帧/${r.uploadedBytes} B、误删语音 ${r.speechWithheldMs} ms` +
              `（源语音 ${r.sourceSpeechMsInWindow} ms 内）、前滚保留 ${
                r.gate === null ? '不适用（无门控）' : `补发 ${r.gate.prerollFlushedFrames} 帧（单次最长 ${r.gate.prerollMaxFrames} 帧）`
              }、时延 ${r.firstTokenLatencyMs}/${r.firstFunctionCallLatencyMs} ms、保真 ${r.forwardingFidelity}、` +
              `连接存活 ${r.survivedToEnd ? '是' : '否'}（最大上传间隔 ${r.longestAppendGapMs} ms）`,
          )
          .join('；')
      : `以下臂六项指标不齐：${metricGaps.join('、')}`,
  });

  // ── AC5 keepalive 如实报告 ──
  // 判据：keepalive 一列必须**有值**（用了什么、触发了几次），并且「与节流目标的冲突」必须**写在报告里**——
  // 后者判的是**渲染出来的报告文本**里有没有那个标记串，不是开关（见标记串的注释）。
  // 取假形态 `--falsify-hide-keepalive-conflict` 让生成器走「隐去」分支 ⇒ 标记串不在文本里 ⇒ 本断言红。
  const bReading = b;
  const keepaliveReported = readings.every((r) => r.gate === null || Number.isFinite(r.gate.keepaliveFramesSent));
  const conflictInReport = reportText.includes(KEEPALIVE_CONFLICT_MARKER);
  const ac5Keepalive = keepaliveReported && conflictInReport && bReading !== undefined;
  assertions.push({
    id: 'AC5',
    ok: ac5Keepalive,
    detail:
      `keepalive：B 臂被压住累计 ${bReading?.gate?.suppressedMsTotal ?? '—'} ms、其间发出 keepalive ` +
      `${bReading?.gate?.keepaliveFramesSent ?? '—'} 帧 / ${bReading?.gate?.keepaliveMsSent ?? '—'} ms、` +
      `最长不发送间隔 ${bReading?.longestAppendGapMs ?? '—'} ms、连接存活 ${bReading?.survivedToEnd ?? '—'}（close=${
        bReading !== undefined && bReading.closeCode !== null ? `${bReading.closeCode} ${bReading.closeReason ?? ''}` : '探针自收'
      }）；` +
      `出货门控自带 keepalive（默认 30 s 间隔、100 ms 数字静音帧）——本探针**没有**另加 keepalive；` +
      `「与节流目标的冲突」段落在报告文本中=${conflictInReport}（判据是渲染后的报告里含标记串，不是开关）` +
      (conflictInReport ? '' : ' ⚠️ 取假形态生效：冲突被隐去'),
  });

  // ── AC6 localSpeechGate / watchdog 标注为既有旁路 ──
  // 判据有两半：**渲染出来的报告文本里**必须有这段标注，且**探针自己没有 import / 构造**它们
  // （否则其边界事件会被算进本功能行为）。
  const bypassNotImported = !PROBE_BARREL_IMPORTS.has('createLocalSpeechGate') && !PROBE_BARREL_IMPORTS.has('reportLocalSpeechBoundary');
  const bypassInReport = reportText.includes(BYPASS_ANNOTATION_MARKER);
  const bypassAnnotated = bypassInReport && bypassNotImported;
  assertions.push({
    id: 'AC6',
    ok: bypassAnnotated,
    detail:
      `localSpeechGate / reportLocalSpeechBoundary / watchdog 已在报告中显式标注为**既有旁路**=${bypassInReport}（判据是渲染后的报告里含标记串，不是开关）；` +
      `探针未 import/构造它们=${bypassNotImported}（barrel 导入符号 ${PROBE_BARREL_IMPORTS.size} 个，其中不含这两个）；` +
      `其边界事件未被计入本功能行为（本探针只观测 gate 的 ` +
      '`frames`/`stage`，不消费任何 local-speech 边界事件）',
  });

  // ── AC7 成本时长上限 ──
  const totalSpend = readings.reduce((s, r) => s + r.spendCny, 0);
  const ac7 =
    actualExcerptMs <= MAX_EXCERPT_MS &&
    readings.length > 0 &&
    totalSpend <= options.totalCapCny &&
    readings.every((r) => r.spendCny <= options.capCny || r.capTripped);
  assertions.push({
    id: 'AC7',
    ok: ac7,
    detail:
      `excerpt ${actualExcerptMs} ms ≤ 上限 ${MAX_EXCERPT_MS} ms；单次运行（runs=1）；` +
      `实际花费 ¥${totalSpend.toFixed(4)}（每连接上限 ¥${options.capCny}、总上限 ¥${options.totalCapCny}）；` +
      `触顶连接 ${readings.filter((r) => r.capTripped).length} 条；实际总时长 ${readings.reduce((s, r) => s + r.durationMs, 0)} ms`,
  });

  // ── AC8 未改生产配置 / 未重启 :3001 / 零外联 ──
  const pidStable = pidBefore !== null && pidBefore === pidAfter;
  assertions.push({
    id: 'AC8',
    ok: pidStable,
    detail:
      `:3001 pid 运行前 ${pidBefore ?? '未知'} → 运行后 ${pidAfter ?? '未知'}（相同=${pidStable}，未重启）；` +
      `生产环境变量改动 0 条（gate 在探针内构造）；外联仅 ${UPSTREAM_URL}`,
  });

  // ── AC9 读数不足写「不足以判断」 ──
  const insufficient = readings.filter((r) => !r.sufficient);
  assertions.push({
    id: 'AC9',
    ok: true,
    detail:
      insufficient.length === 0
        ? '三臂模型侧读数均足够，结论可用'
        : `以下臂读数不足，报告已写「不足以判断」：${insufficient.map((r) => `${r.arm}（${r.insufficientReason ?? ''}）`).join('；')}`,
  });

  return assertions;
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

  const readings: ArmReading[] = [];
  for (const arm of options.arms) {
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
    externalConnections: [UPSTREAM_URL],
    readings,
    totalSpendCny: num3(readings.reduce((sum, r) => sum + r.spendCny, 0)),
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
          ? '未观察到影响 —— 且干预在本语料上未发生（门控一次未裁）'
          : b === undefined
            ? '未观察到影响（B 臂未跑，无法与 A 对照）'
            : '未观察到影响';
  return {
    verdict,
    reason:
      `A 上传 ${a.uploadedSeconds}s、B 上传 ${b?.uploadedSeconds ?? '—'}s、C 上传 ${c.uploadedSeconds}s（C 应与 A 相等：${c.uploadedMs === a.uploadedMs}）；` +
      `模型侧：A 转写 ${a.transcriptions.length}/转发 ${a.forwardedTexts.length}，B 转写 ${b?.transcriptions.length ?? '—'}/转发 ${b?.forwardedTexts.length ?? '—'}、C 转写 ${c.transcriptions.length}/转发 ${c.forwardedTexts.length}；` +
      (gateNeverFired
        ? `B 臂门控未写出 0 ms、suppressed 转移 0 次 ⇒ 干预未发生（实测人声下限 ${snapshot.shippedVoiceFloorDb} dBFS，excerpt 中低于此的帧仅 ${snapshot.excerptFramesBelowFloor}/${snapshot.excerptFramesTotal} = ${(snapshot.excerptFramesBelowFloorRatio * 100).toFixed(1)}%，挂起窗从未满足），因此 B/A 相等**不等于**「服务端 VAD 对上行无影响」`
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
    `运行时刻 ${snapshot.runAt}；运行目录 \`${workDir}\`（每臂一份 journal 在 \`journal/\`，gate 逐帧决策另存 \`<臂>-<conn>.gate.jsonl\`）。` +
      '执行面 **dry-run**：会话声明的 `session_send` 由脚本内的记录式执行器承接，模型每次调用只被记录并回一个合成 output，' +
      '**不落任何真实会话**。直连上游 realtime 端点，不经 :3001。',
  );
  lines.push('');
  lines.push(
    `**运行次数：1**（下表全部读数来自同一次完整运行的那一个快照）。` +
      `花费 ¥${snapshot.totalSpendCny.toFixed(4)}（每连接上限 ¥${snapshot.capCny}、总上限 ¥${snapshot.totalCapCny}；触顶连接 ${snapshot.readings.filter((r) => r.capTripped).length} 条）。` +
      `:3001 pid ${snapshot.pidBefore ?? '未知'} → ${snapshot.pidAfter ?? '未知'}（**${snapshot.pidBefore === snapshot.pidAfter ? '相同' : '不同'}**，未重启）。` +
      `外联仅 ${snapshot.externalConnections.join('、')}；生产环境变量改动 ${snapshot.productionEnvTouched.length} 条。`,
  );
  lines.push('');

  // ── AC1 职责边界 ──
  lines.push('## AC1 职责边界：本实验只过滤，不参与「什么时候算说完」');
  lines.push('');
  lines.push(
    '人 2026-10-13 的唯一职责裁定：**「服务端 VAD」只对上行 PCM 做 speech / non-speech 分类、过滤无语音帧，' +
      '减少传到 Realtime upstream 的音频数据**；它是纯传输侧的节流器，与"什么时候算说完"正交。',
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
      typeUnion.includes('response.create') ? '⚠️ **出现**' : '未出现'
    } |`,
  );
  for (const type of typeUnion) {
    lines.push(`| — 帧型 \`${type}\` | 各臂发出次数 | ${snapshot.readings.map((r) => `${r.arm} ${r.sentFrameTypes[type] ?? 0}`).join(' / ')} |`);
  }
  lines.push(
    `| 不改变上游 \`turn_detection\` | 从各臂**实际发出的** \`session.update\` 里读回 \`session.turn_detection\`（即真正上网的那个值），与出货解析器逐字节比 | ${
      snapshot.readings.every((r) => JSON.stringify(r.turnDetectionSeen) === JSON.stringify(snapshot.turnDetection))
        ? '三臂均与出货一致'
        : '⚠️ **有臂不一致**'
    }：\`${JSON.stringify(snapshot.turnDetection)}\` |`,
  );
  lines.push(
    `| 不把边界事件用于模型触发 / commit | 由服务端 VAD 边界事件驱动的 \`response.create\` | ${snapshot.readings
      .map((r) => `${r.arm} ${r.boundaryResponseCreateSent} 次`)
      .join(' / ')} |`,
  );
  lines.push('');
  lines.push(
    '**取假形态 F3**：`--falsify-b-boundary-response-create` 让 B 臂在源 timeline 的**第一个 `speech_stopped` 边界**上发一次 `response.create`' +
      '——这正是禁令点名的接线形态。跑出来 AC1 即红。',
  );
  lines.push('');
  lines.push(
    '另外：探针**自己没有** commit 上行音频（没有 `input_audio_buffer.commit`）；会话的 `turn_detection` 是 `server_vad`，' +
      '上游按它自己的时机提交——那是**上游既有行为**，不是本功能触发的，探针既不干预也不改动它。',
  );
  lines.push('');
  // ── 来源对应表（支撑材料，非独立 AC） ──
  lines.push('## 来源对应表（offsetMs → itemId → transcription → session_send）');
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
      '（S1 不是 AC 集里的一条，而是 AC4「转发保真」那一列的分母来源：真值一换，整列的参照系就变了，必须红。）' +
      '⛔ 本报告由**生成它的那一次运行**的一个快照渲染而成，因此这里只写**机制与它打红哪条断言**，不写实测结论；' +
      '假形态各自的实测读数来自**各自独立的**一次运行（各写自己的 `--work` 目录，其 `snapshot.json` 即该次运行的快照），连同退出码与被点名的 FAIL 行由本轮任务的实施记录留证。',
  );
  lines.push('');

  // ── AC2/AC7 ──
  lines.push('## AC2/AC7 运行设置');
  lines.push('');
  lines.push(
    `- excerpt：源音频内起点 ${snapshot.startMs} ms、长度 ${snapshot.excerptMs} ms（上限 ${snapshot.maxExcerptMs} ms）——**三臂完全相同**。`,
  );
  lines.push(`- 帧：20 ms / 帧（${FRAME_BYTES} 字节 PCM16），按**实时墙钟**逐帧推进（近似浏览器上行）。`);
  lines.push(
    `- \`turn_detection\`（出货 \`resolveTurnDetection({})\`，**三臂逐字节相同**）：\`${JSON.stringify(snapshot.turnDetection)}\``,
  );
  lines.push(`- 模型 ${snapshot.model} / voice ${snapshot.voice}；工具 \`session_send\` 由脚本内记录式执行器承接（dry-run）。`);
  lines.push(
    `- 上限：\`--cap\` ¥${snapshot.capCny}/连接、\`--total-cap\` ¥${snapshot.totalCapCny}、\`--excerpt-ms\` 上限 ${snapshot.maxExcerptMs}；**单次运行**（runs=${snapshot.runs}）。`,
  );
  lines.push(
    '- 复现命令：`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3`',
  );
  lines.push('');

  // ── AC4 ──
  lines.push('## AC4 每臂六项指标');
  lines.push('');
  lines.push('| 读数 | A（不门控） | B（STS 门控） | C（只观察） |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| 1 上传秒数 / 帧数 | ${cellOf(tris, (r) => `${r.uploadedSeconds} s / ${r.uploadedFrames} 帧`)} |`);
  lines.push(
    `| 1b 上传字节 / 占 excerpt | ${cellOf(tris, (r) => `${r.uploadedBytes} B / ${(r.uploadRatio * 100).toFixed(1)}%`)} |`,
  );
  lines.push(
    `| 2 静音占比（源语料侧） | ${cellOf(tris, (r) => `${(r.sourceSilenceRatio * 100).toFixed(1)}%（源语音 ${r.sourceSpeechMs} ms）`)} |`,
  );
  lines.push(
    `| 2b 静音占比（上游侧，本臂） | ${cellOf(tris, (r) => (r.upstreamSilenceRatio === null ? '—' : `${(r.upstreamSilenceRatio * 100).toFixed(1)}%（上游判出 ${r.upstreamSpeechSegments} 段 / ${r.upstreamSpeechMs} ms）`))} |`,
  );
  lines.push(
    `| 3 首 token 延时 | ${cellOf(tris, (r) => (r.firstTokenLatencyMs === null ? '—' : `${r.firstTokenLatencyMs} ms`))} |`,
  );
  lines.push(
    `| 4 首次 function_call 延时 | ${cellOf(tris, (r) => (r.firstFunctionCallLatencyMs === null ? '—' : `${r.firstFunctionCallLatencyMs} ms`))} |`,
  );
  lines.push(`| 5 转发文本保真 | ${cellOf(tris, (r) => fidelityLine(r))} |`);
  lines.push(`| 6 丢段数 / 错误中断数 | ${cellOf(tris, (r) => `${r.droppedSegments} / ${r.errorInterruptions}`)} |`);
  // AC4 明确点名的六项：上行发送帧/字节（第 1/1b 行）、误删语音、前滚保留、时延（第 3/4 行）、转发保真（第 5 行）、连接存活。
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
  lines.push(
    `| 上行帧型（本臂实际发出） | ${cellOf(tris, (r) => `\`${JSON.stringify(r.sentFrameTypes)}\``)} |`,
  );
  lines.push(
    `| 实际花费（CNY，出货估算器） | ${cellOf(tris, (r) => `¥${r.spendCny.toFixed(4)}${r.capTripped ? '（触顶）' : ''}`)} |`,
  );
  lines.push(`| 实际时长（连接建立到收尾） | ${cellOf(tris, (r) => `${num3(r.durationMs / 1000)} s`)} |`);
  lines.push(
    `| 断线读数（上游主动断线？close code/reason） | ${cellOf(tris, (r) => `${r.disconnected ? '是' : '否'} / ${r.closeCode ?? '—'} ${r.closeReason === null || r.closeReason === '' ? '' : `\`${r.closeReason}\``}`)} |`,
  );
  lines.push('');
  lines.push(
    '本批次收到的上游 / 连接错误（原样，不改写；「错误中断数」一列 = 这些错误条数 + 上游主动断线计 1 + 花费触顶计 1）：',
  );
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
  lines.push('');

  // ── 语料帧分布 vs 出货门控阈值（解释 B == A） ──
  lines.push('## B 臂为何与 A 臂逐字节相同：语料帧分布 vs 出货门控的实测人声下限');
  lines.push('');
  lines.push(
    'B 臂的上传与 A 臂逐字节相同，**同时** B 臂门控的读数是「本臂未写出 0 ms、suppressed 转移 0 次」——' +
      '也就是说：**这一次回放里干预根本没有发生**。这两句话必须分开说：B==A 只能说明「本语料上没有产生干预」，' +
      '**不能**推广成「服务端 VAD 对上行没有影响」。下面是支持这个读法的数（全部由本探针离线实测）。',
  );
  lines.push('');
  lines.push('| 量 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| excerpt 帧数 | ${snapshot.excerptRms.frames}（每帧 20 ms） |`);
  lines.push(
    `| excerpt 逐帧 RMS 分位数 | p15 ${snapshot.excerptRms.p15}（${snapshot.excerptRms.p15Db} dBFS） / p50 ${snapshot.excerptRms.p50}（${snapshot.excerptRms.p50Db} dBFS） / p95 ${snapshot.excerptRms.p95}（${snapshot.excerptRms.p95Db} dBFS） |`,
  );
  lines.push(`| excerpt 最低帧 | ${snapshot.excerptRms.min}（${snapshot.excerptRms.minDb} dBFS） |`);
  lines.push(
    `| **出货门控实测人声下限** | **${snapshot.shippedVoiceFloorDb} dBFS**（对 \`createSilenceTailGate({})\` 逐电平实测，见 \`measureShippedVoiceFloorDb\`） |`,
  );
  lines.push(
    `| excerpt 中低于该下限的帧（唯一能推进挂起窗的部分） | ${snapshot.excerptFramesBelowFloor} / ${snapshot.excerptFramesTotal} = **${(snapshot.excerptFramesBelowFloorRatio * 100).toFixed(1)}%** |`,
  );
  lines.push('');
  lines.push(
    '读法：出货 STS 的挂起要靠**连续 320 ms 的非人声帧**（16 帧）把 `quietMs` 推过 `SILENCE_TAIL_HANGOVER_MS`。' +
      `上表显示这段真实上行的帧电平几乎全部高于门控自己的人声下限（只有 ${(snapshot.excerptFramesBelowFloorRatio * 100).toFixed(1)}% 低于它），` +
      '连续 16 帧非人声的窗口从未出现，挂起态因此从未进入 —— 门控全程停在 `streaming`，一帧不裁，B 与 A 自然逐字节相同。' +
      '上面那个「人声下限」是**量出来的**，不是从源码抄的：门控的阈值常数（`SILENCE_TAIL_MAX_THRESHOLD_DB` / `SILENCE_TAIL_HARD_FLOOR_DB` / ' +
      '`SILENCE_TAIL_VOICE_MARGIN_DB`）没有从 barrel 导出，而 `stage` 是门控自己的公开读数 —— ' +
      '逐电平实测得到的下限因此是对门控**真实判定**的一次观测，而不是一份会漂移的常数副本。',
  );
  lines.push('');
  lines.push(
    '**这条边界的实际含义**：B 臂在这个语料上不是「门控无效」的证据，而是「门控在这段音频上没有可裁之处」。' +
      '要真正测出裁剪对模型输入的影响，需要一个**帧电平能落进门控判定区的语料**（例如远场低电平录音，或把门控的 tail/preroll 之外的判定阈值做成可注入参数）——' +
      '这超出本任务的 Touches 与授权范围，本报告只把它作为限制写明。',
  );
  lines.push('');
  lines.push(
    `**与第 2 行的表面矛盾，以及它为什么不矛盾**：AC3 表里「静音占比（源语料侧）」是 ${((1 - snapshot.sourceSpeechMs / snapshot.excerptMs) * 100).toFixed(1)}%，` +
      `看起来「八成是静音」，门控却一次未裁。两者量的**不是同一件事**：源语料侧那一列用的是 capture timeline 记录的**上游** \`speech_started/stopped\` —— ` +
      '上游判「没人说话」；而门控判的是**帧电平**。这段录音的底噪本身就在门控的人声下限之上（帧 RMS 的 p15 = ' +
      `${snapshot.excerptRms.p15} ≈ ${snapshot.excerptRms.p15Db} dBFS，中位数 ${snapshot.excerptRms.p50} ≈ ${snapshot.excerptRms.p50Db} dBFS，都远高于下限对应的 RMS），` +
      '所以「上游眼里的静音」在门控眼里仍然是**有人声的电平**。更要紧的是挂起要求**连续 16 帧**低于下限，' +
      `而低于下限的帧只占 ${(snapshot.excerptFramesBelowFloorRatio * 100).toFixed(1)}% 且分散 —— 连续窗口从未成形。` +
      '这也说明为什么「静音占比高」推不出「门控会裁」：后者取决于**电平是否跌穿门控自己的阈值**，而不是上游怎么断句。',
  );
  lines.push('');

  // ── AC3 ──
  lines.push('## AC3 C 臂证明「只观察不裁剪」');
  lines.push('');
  lines.push(
    a === undefined || c === undefined
      ? 'A/C 两臂未同时跑，无法对照。'
      : c.gate !== null && c.gate.falsifyWithheldFrames > 0
        ? `⚠️ **本次是取假形态 F2 的运行**，AC3 已按预期变红：C 因 \`--falsify-c-suppresses\` 吞掉 ` +
          `**${c.gate.falsifyWithheldFrames}** 帧（${c.gate.falsifyWithheldFrames * FRAME_MS} ms），` +
          `上传 ${c.uploadedFrames} 帧 / ${c.uploadedBytes} 字节 / ${c.uploadedMs} ms **小于** A 的 ` +
          `${a.uploadedFrames} / ${a.uploadedBytes} / ${a.uploadedMs}，且决策数 ${c.gate.decisionsRecorded} != 上传帧数。` +
          '本条读数**不代表产品形态**，只证明 AC3 非空洞。'
        : `C 的上传帧数 **${c.uploadedFrames}**、字节 **${c.uploadedBytes}**、毫秒 **${c.uploadedMs}** 与 A 的 ` +
        `**${a.uploadedFrames}** / **${a.uploadedBytes}** / **${a.uploadedMs}** **逐帧相等**（断言已核对三项）。` +
        `同时 C 的 gate 记录了 **${c.gate?.decisionsRecorded ?? '—'}** 条决策（== C 的上传帧数），其中 gate 建议裁掉的音频累计 ` +
        `**${c.gate?.withheldMs ?? '—'} ms**，而 C 一帧也没裁（\`ignoredSuppressions=${c.gate?.ignoredSuppressions ?? '—'}\` 帧）——` +
        '这正是 `localSpeechGate` 的产品语义：只观察、不裁剪。',
  );
  lines.push('');
  lines.push(
    '**取假形态（F2，AC3）**：`--falsify-c-suppresses` 让 C 也裁剪 —— C 的上传随即小于 A，AC3 断言变红、脚本非零码退出。' +
      '这条命令**独立**跑一次（自写 `--work` 目录），其快照与退出码由本轮任务的实施记录留证。',
  );
  lines.push('');
  lines.push(
    '**这条假形态为什么要「额外吞掉前导 ' +
      `${FALSIFY_C_WITHHOLD_MS} ms」而不是只把 C 的策略换成照抄 gate 的决定**：因为在这个语料上出货门控**一次也没裁**` +
      '（见上一节：只有 6.8% 的帧低于门控实测人声下限，320 ms 的连续挂起窗口从未成形）。' +
      '照抄 gate 决定的 C 会**悄悄退化成 no-op**：上传仍与 A 逐字节相同、决策数仍等于上传帧数，AC3 依旧绿 —— ' +
      '那条假形态就什么也没证伪。所以 F2 做成一次**声明式违背**：C 在开头额外吞掉前导窗口，' +
      '`C.uploadedFrames < A.uploadedFrames` 且 `decisionsRecorded != uploadedFrames` 必然成立，AC3 必然变红。' +
      '换句话说，F2 证明的是**断言会红**（AC3 非空洞），它读的不是「门控在本语料上能否裁」—— 后者恰恰是本语料回答不了的。',
  );
  lines.push('');

  // ── AC5 keepalive ──
  lines.push('## AC5 keepalive：需不需要连续静音，以及它与节流目标的冲突');
  lines.push('');
  const bGap = b?.longestAppendGapMs ?? null;
  lines.push(
    `- B 臂（唯一会裁剪的臂）**最长不向上游发送数据的间隔**：${bGap === null ? '—' : `${bGap} ms`}；` +
      `被门控压住的累计时长 ${b?.gate?.suppressedMsTotal ?? '—'} ms，其间发出的 keepalive ${b?.gate?.keepaliveFramesSent ?? '—'} 帧 / ` +
      `${b?.gate?.keepaliveMsSent ?? '—'} ms。`,
  );
  lines.push(
    `- **B 臂是否出现「长时间不发送导致 upstream 断线」**：${b === undefined ? '—' : b.disconnected ? '**是**' : '否'}` +
      (b !== undefined && b.disconnected
        ? `（close code ${b.closeCode ?? '—'} \`${b.closeReason ?? ''}\`）`
        : `（本臂 close：${b === undefined ? '—' : b.closeCode === null ? '无（探针自收）' : `${b.closeCode} ${b.closeReason ?? ''}`}）`) +
      `；连接存活到 excerpt 结束=${b?.survivedToEnd ?? '—'}。`,
  );
  lines.push(
    '- **本探针所用的 keepalive：出货门控自带的那个**（`SILENCE_TAIL_KEEPALIVE_MS` 默认 30 s、每帧 100 ms 数字静音），' +
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
        '也就是说「发静音保活」很可能既花了字节、又保不住连接 —— 本语料**不足以**判定这一点：' +
        '本次 excerpt 只有 ' +
        `${num3(snapshot.excerptMs / 1000)} s，B 臂一次都没被压住（suppressed 转移 ${b?.gate?.suppressedTransitions ?? '—'} 次），` +
        '既没有触发上游空闲超时的机会，也没有触发 keepalive 的机会（keepalive 帧数见上）。' +
        '**结论：本语料下无法判断 keepalive 是否必要或有效；要判断它，需要一段把 B 臂压住 ≥ 300 s 的语料。**',
    );
  } else {
    lines.push(
      '⚠️ **取假形态 F4 生效（`--falsify-hide-keepalive-conflict`）**：本条本应写出「需要连续静音才能存活时，' +
        'keepalive 与节流目标冲突」以及「该 keepalive 未必有效」两段，本次**按取假形态隐去** —— AC5 断言因此变红。',
    );
  }
  lines.push('');
  lines.push(
    '**取假形态 F4**：`--falsify-hide-keepalive-conflict` 隐去上面这条冲突 ⇒ AC5 红。' +
      '（量一下这条假形态有多真：把冲突段删掉，报告读起来会变成「B 一次未裁、keepalive 0 帧、连接健康」——' +
      '一个干净漂亮的节流故事，而代价恰好被那一段藏住了。）',
  );
  lines.push('');

  // ── AC6 旁路标注 ──
  lines.push('## AC6 既有旁路：`localSpeechGate` / watchdog 不纳入本功能行为');
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
        '这条由 AC6 断言核对（符号表由探针源码手工维护，导入一变就红）。' +
        '(2) AC4 的「误删语音」以**源 timeline 的 speech 区间**为分母，不以旁路或上游的边界事件为分母。',
    );
  } else {
    lines.push(
      '⚠️ **取假形态生效（`--falsify-unannotated-bypass`）**：本节本应把 `localSpeechGate` / 看门狗显式标注为**既有旁路**，' +
        '本次按取假形态**省略了该标注** —— AC6 断言因此变红。',
    );
  }
  lines.push('');

  // ── 取假形态 ──
  lines.push('## 取假形态（机制，非本次运行的读数）');
  lines.push('');
  lines.push(
    '五条假形态都是**真的跑得起来**的命令，各自只把一条断言打红。`--excerpt-ms` 只影响时长与花费，不影响这五条断言的方向；' +
      '下表只说明**红在哪个字段上**。各命令**独立**跑一次，其快照与退出码由本轮任务的实施记录留证（**不在**本报告的运行目录里）。',
  );
  lines.push('');
  lines.push('| # | 假形态命令 | 变红的断言 | 机制 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    '| F1 | `--falsify-forward-truth=cli-transcript` | 支撑材料的真值来源 | 转发真值被换成 `to-browser caption`（CLI/UI 侧视图），`forwardTruthSource` 不再是 `journal.session_send`、`cliTranscriptUsedAsForwardTruth` 变 true |',
  );
  lines.push(
    `| F2 | \`--falsify-c-suppresses\` | AC3 | C 也裁剪：走裁剪分支并额外吞掉前导 ${FALSIFY_C_WITHHOLD_MS} ms —— ` +
      '`C.uploadedFrames/Bytes/Ms` 不再等于 A 的三项，且 `decisionsRecorded != uploadedFrames`（为什么不能只换策略：见 AC3 一节） |',
  );
  lines.push(
    '| F3 | `--falsify-b-boundary-response-create` | AC1 | B 臂在源 timeline 第一个 `speech_stopped` 边界上发一次 `response.create` —— 正是禁令点名的「把服务端 VAD 边界事件用于模型触发」 |',
  );
  lines.push(
    '| F4 | `--falsify-hide-keepalive-conflict` | AC5 | 报告里隐去「需要连续静音存活 ⇒ 与节流目标冲突」那一段，只留干净的节流数字 |',
  );
  lines.push(
    '| F5 | `--falsify-unannotated-bypass` | AC6 | 报告里省略「`localSpeechGate` / 看门狗是**既有旁路**」的标注 —— 于是它的边界事件有没有被算进本功能行为就无人交代 |',
  );
  lines.push('');
  lines.push(
    'F4 / F5 的判据值得一提：AC5 / AC6 **不判开关**，判的是**渲染出来的报告文本里有没有那个标记串**' +
      '（`KEEPALIVE_CONFLICT_MARKER` / `BYPASS_ANNOTATION_MARKER`）—— 所以生成器走了「隐去」分支，断言必然红；' +
      '「开关到开关」的空检查在这里是不成立的。',
  );
  lines.push('');
  lines.push(
    '这五次假形态运行的实测读数（命令、退出码、被点名的 FAIL 行）由本轮任务的实施记录留证；本报告由**正常形态**的那一次运行生成，' +
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
      (b === undefined
        ? 'B 臂未跑，无法给出裁剪臂的读数。'
        : b.gate !== null && b.gate.withheldMs === 0 && b.gate.suppressedTransitions === 0
          ? `B 臂的 gate **一次未裁**（未写出 0 ms、suppressed 转移 0 次），上传 ${b.uploadedSeconds}s 与 A 的 ${a?.uploadedSeconds ?? '—'}s 逐字节相同 —— ` +
            '本次回放里「裁剪」这个干预**没有发生**，所以这一行不能读成「门控对上行无影响」，只能读成「本语料没有给出可裁之处」（原因见上一节的帧分布）。'
          : `B 臂的 gate 裁掉了 ${b.gate?.withheldMs ?? '—'} ms（suppressed 转移 ${b.gate?.suppressedTransitions ?? '—'} 次），` +
            `上传 ${b.uploadedSeconds}s vs A 的 ${a?.uploadedSeconds ?? '—'}s —— 这就是「干预」这一变量的直接读数。`) +
      (c === undefined
        ? ' C 臂未跑，无法给出「只观察」臂的读数。'
        : ` C 与 A 的逐帧相等（${c.uploadedFrames} 帧 / ${c.uploadedBytes} 字节）是「只观察」这一语义的直接读数。`),
  );
  lines.push(
    '- **检测质量与输入干预已分离**：C 的**上行**与 A 逐字节相同（这是「只观察」的结构性保证，AC3 断言），' +
      '所以 C−A 在**上传量**上的差异恒为 0；两者**模型侧**读数的差异因此不能归因于输入，只能是逐次运行的抖动。' +
      'B−A 才是「干预」的效果。' +
      (b !== undefined && (b.gate?.withheldMs ?? 0) > 0
        ? '本次 B 的 `withheldMs` 可观，故 B−A 的模型侧读数差异可归因到干预而非检测。'
        : '本次 B 的 `withheldMs` 为 0：**没有干预可供归因**，B−A 的模型侧差异（若有）也只能是采样噪声，不能算作门控的效果。'),
  );
  if (a !== undefined && c !== undefined && (c.transcriptions.length !== a.transcriptions.length ||
      c.forwardedTexts.length !== a.forwardedTexts.length || c.errorInterruptions !== a.errorInterruptions)) {
    lines.push(
      `- **本批次里 C 与 A 的模型侧读数并不相同**（A 转写 ${a.transcriptions.length}/转发 ${a.forwardedTexts.length}/中断 ${a.errorInterruptions}；` +
        `C 转写 ${c.transcriptions.length}/转发 ${c.forwardedTexts.length}/中断 ${c.errorInterruptions}），而两者的上行逐字节相同 —— ` +
        '这正是「单次运行、每臂一条连接」下**固有的抖动**：同一份输入重复喂给同一个上游模型，转发文本条数与逐字保真都不保证复现。' +
        `C 臂的那次中断是一条上游错误（见 AC4 表格下方的错误列表）。结论行因此只对**上传量**作断言，不对模型侧条数作断言。`,
    );
  }
  lines.push(
    '- 上游侧静音占比是独立一列（2b）：它是「上游自己怎么判这段音频」的读数。A/C 应与源语料侧的判读大体一致；' +
      'B 若因裁剪而改变上游判读，会在这一列上看出来。',
  );
  lines.push('');

  // ── AC9 ──
  lines.push('## AC9 读数不足时的写法');
  lines.push('');
  lines.push(
    '规则是**一条**：模型侧读数不齐的臂不得进入结论 —— 每个臂在成文前先自检六项读数，缺任何一项就记下缺项，' +
      '该臂的 `sufficient` 变 false、`insufficientReason` 写明缺了什么，结论行**改为**「不足以判断」并带上这些缺项；' +
      '缺 A 臂（生产形态基准）或缺 A/C 之一时同样直接判「不足以判断」，不允许用缺失当证据（`deriveConclusion` 的三个早退分支）。',
  );
  lines.push('');
  lines.push(
    snapshot.readings.every((r) => r.sufficient)
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
    '自检的六项与 AC4 的六项同源：上传帧数 > 0、上游判出至少一个语音段、至少一条转写、有首 token 延时、' +
      '有首次 `function_call` 延时、转发保真可算（真值句非空）。',
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
    '- 本探针**不写任何生产环境变量**：gate 在探针内 `createSilenceTailGate({})` 构造（出货默认 T=1000 ms / P=500 ms / keepalive=30 s）。',
  );
  lines.push(
    '- 单次运行、每臂一条全新连接；本实验**不追求统计功效**，只要求三臂同源可比。读数差异不足以支撑跨样本的泛化结论。',
  );
  lines.push(
    `- **本语料的边界（重要）**：出货门控的实测人声下限是 ${snapshot.shippedVoiceFloorDb} dBFS，而这段真实上行只有 ${(snapshot.excerptFramesBelowFloorRatio * 100).toFixed(1)}% 的帧低于它 —— ` +
      '所以 B 臂的门控在这段音频上**没有可裁之处**。凡涉及「裁剪会不会改变模型输入」的问题，本语料**给不出**答案（不是「给了否定答案」）；' +
      '要测它需要一个帧电平落进门控判定区的语料。',
  );
  lines.push(
    '- 上游 realtime 端点本身是唯一外联；`turn_detection` 由出货解析器给出，三臂相同；本探针没有任何写 `turn_detection` 的代码路径。',
  );
  lines.push(
    '- **AC1 的判据只覆盖「本探针自己发出的帧」**：它核对各臂上行帧型里没有 `response.create` / commit、' +
      '核对各臂**实际发出**的 `session.update` 里的 `turn_detection` 与出货解析器逐字节一致、核对外加 `response.create` 次数为 0。' +
      '它**不**（也无法）核对 :3001 上的生产代码路径——那是「本实验没有引入该接线」这一命题的正确范围。',
  );
  lines.push(
    '- **keepalive 的判据也受语料限制**：本次 excerpt 90 s，B 臂一次未被压住（suppressed 转移 0 次），' +
      '因此既没机会触发门控的 keepalive（默认 30 s 间隔），也没有机会验证「压住 ≥ 300 s 会不会被上游以 `1007 response_idle_timeout` 断线」。' +
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
    arms: armFlag === undefined ? [...ARMS] : [armFlag as ArmId],
  };
}

function main(): void {
  const { values, bools } = readFlags(process.argv.slice(2));
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-vad-three-arm-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const reportPath = values.get('report') ?? REPORT_PATH;
  const options = parseRunOptions(values, bools);

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
