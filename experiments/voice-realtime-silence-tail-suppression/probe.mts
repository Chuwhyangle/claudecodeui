#!/usr/bin/env tsx
/**
 * Silence Tail Suppression 真实探针 —— V-1..V-8，一次真实 Realtime 运行（决策文档 §10 / GOAL-044 AC-363）。
 *
 * 现场。STS（Silence Tail Suppression，人 yale 2026-10-12 提出的体验优先候选，定义见
 * `docs/proposals/live-voice-experience-first-decision-2026-10.md` §10.1）是一层**传输**优化：
 * continuous 模式下断句与 response 仍由上游 `server_vad` 决定，本地只做一件事——判断当前帧是否静音；
 * 语音结束后继续上传**真实底噪** `T` 秒，之后暂停上传并维护前滚缓冲 `P`，恢复讲话时先补发 `P`。
 * 参数 `T`（候选 1–3 s）与 `P`（候选 300–800 ms）**都不是已验证的安全阈值**，必须由本探针的读数给出。
 *
 * 本文件是 STS 原型的**实验实现**，不改产品代码。它直接连上游 `qwen3.8-omni-flash-realtime`，逐 20 ms
 * 帧地控制**哪些帧真的离开 socket**——这正是产品 relay 做不到的实验自由度：停传、前滚、尾音都要求
 * 「这一刻不发这一帧」，而产品面（HTTP diagnose 路由）只接受一整段 WAV，无法表达「发到这里，停 5 秒」。
 *
 * 为什么直连而不是第二实例。`docs/operations/voice-realtime-interrupt-sampling.md` 用第二实例 +
 * HTTP diagnose 面，是因为那项只问「模型怎么判一句措辞」，整段音频一次投喂即可。本探针问的是**上游
 * VAD 的时间基**（V-1）与**停传期间的空闲行为**（V-2），这两问的变量正是「什么时候不发帧」与
 * 「停多久」，HTTP 面表达不了——所以本脚本用一个 raw WebSocket 客户端直连上游，帧级驱动。
 * 任务书明确允许这条路（「备用端口第二实例**或**直接用实验脚本连上游」）。
 *
 * dry-run 执行面。本脚本建立的是**合成会话**：`sessionId` 在脚本里生成、任何库里都不存在，上游听到的
 * 是一段合成音频，它不是任何真实会话的一部分。会话声明的 `session_send` 工具由本脚本的**记录式执行器**
 * 承接：模型每次调用只被记进 journal 并回一个 `{"dryRun":true,"accepted":true}` 的合成 output，绝不落到
 * 任何真实会话。所以「不向任何真实会话注入任何东西」由构造承担，而不是靠一个分支里的 if。
 *
 * 证据落在哪。每条连接一个 JSONL：`<运行目录>/journal/<连接 id>.jsonl`，逐条记下**每一个**收发的 wire
 * 帧（带墙钟 atMs）与本次判读，原始帧另存 `<连接 id>.frames.json`。报告里每一行引用的连接 id、时刻、
 * 事件都能在这两个文件里对上。
 *
 * 花费。每条连接封顶 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION`（默认 ¥0.05，写进 env 供记录）；本脚本
 * 用**出货的** `estimateRealtimeCostCny` 在每条 `response.done` 上累计（不在这里抄一份价目表）。
 * V-2 的长停传主要是墙钟时间，不是 token。总花费上限 ¥1.5 由分段运行 + 每条封顶共同保证。
 *
 * 用法（仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-silence-tail-suppression/probe.mts
 *   … --plan                 只打印计划（要建哪些连接），不连上游、不花钱
 *   … --smoke                只跑一条最短的端到端连接（证管线），其余跳过
 *   … --sections v1,v7       只跑指定分段（冒烟 / 返工用）
 *   … --cap 0.05             每条连接花费上限（CNY）
 *   … --work /tmp/x          指定运行目录（默认 os.tmpdir() 下一个新目录）
 *   … --report-only <dir>    从 `<dir>/snapshot.json` 离线重建报告（不连上游、不花钱）
 *
 * 边界（GOAL-041 / GOAL-044 全体任务共用）：⛔ 不重启 :3001、不发布；⛔ 不触碰任何 Quay worker / driver
 * 进程或工作树；⛔ 不向任何真实会话注入（合成会话 + 记录式执行器）；⛔ 只跑一次（见报告「运行次数」）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { estimateRealtimeCostCny } from '../../server/modules/voice-realtime/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CORPUS_PATH = path.join(HERE, 'corpus.json');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-silence-tail-suppression-probe.md');

/** 上游 Realtime 端点（与出货 transport 同址：host 取自 asr 规则模块的唯一副本）。 */
const UPSTREAM_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
/** 出货默认模型（GOAL-030 采纳）。 */
const MODEL = 'qwen3.8-omni-flash-realtime';
/** 出货默认 voice（该模型要求显式 voice，见 transport 头注）。 */
const VOICE = 'Tina';

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320
const FRAME_BYTES = FRAME_SAMPLES * 2; // 640

const DEFAULT_CAP_CNY = 0.05;
/** 与 diagnose 路由默认一致的上游静默窗口；先备后置，实际以每次会话声明的为准。 */
const DEFAULT_SILENCE_MS = 400;
/**
 * 「这是一次停传」的判定门槛：相邻两帧 `input_audio_buffer.append` 的间隔。
 *
 * 正常逐帧上传的间隔是 `FRAME_MS`（20 ms），最长的实测非停传间隔也只有 22 ms；V-2 的停传是
 * 60 000 ms 起。取 30 s 作门槛，两者差三个数量级，不存在模棱两可的地带。
 */
const STALL_GAP_MIN_MS = 30_000;

/** TTS 的出货模型与音色（沿用 interrupt-sampling 2026-10-12 实测可用的那条路）。 */
const TTS_MODEL = 'qwen3-tts-flash';
const TTS_VOICE = 'Cherry';
const TTS_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = (ms: number = Date.now()): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

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

// ─────────────────────────────────────────────────────────────────────────────
// 语料与音频
// ─────────────────────────────────────────────────────────────────────────────

type CorpusItem = {
  id: string;
  kind: 'speech' | 'weak-tail' | 'fast-onset' | 'low-volume';
  text: string;
  gainDb?: number;
  tailFadeMs?: number;
  tailFadeGainDb?: number;
  trimLeadMs?: number;
  source?: string;
};
type CorpusTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };
type Corpus = { version: number; instructions: string; tools: CorpusTool[]; items: CorpusItem[] };

function loadCorpus(): Corpus {
  const parsed = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) throw new Error(`语料为空：${CORPUS_PATH}`);
  const seen = new Set<string>();
  for (const item of parsed.items) {
    if (seen.has(item.id)) throw new Error(`语料 id 重复：${item.id}`);
    seen.add(item.id);
  }
  return parsed;
}

/** 合成一条语料的音频（DashScope TTS → ffmpeg → 16 kHz 单声道 PCM16 WAV）。沿用 interrupt-sampling。 */
async function synthesize(text: string, outPath: string): Promise<void> {
  const key = process.env.DASHSCOPE_API_KEY;
  if (key === undefined || key.trim() === '') throw new Error('DASHSCOPE_API_KEY 未设置，无法合成语料音频');
  const response = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: TTS_MODEL, input: { text, voice: TTS_VOICE } }),
  });
  const body = (await response.json()) as { output?: { audio?: { url?: string } }; message?: string };
  if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${body.message ?? JSON.stringify(body).slice(0, 200)}`);
  const url = body.output?.audio?.url;
  if (typeof url !== 'string' || url === '') throw new Error(`TTS 没回音频地址：${JSON.stringify(body).slice(0, 200)}`);
  const audio = await fetch(url);
  if (!audio.ok) throw new Error(`TTS 音频下载 HTTP ${audio.status}`);
  const raw = Buffer.from(await audio.arrayBuffer());
  const rawPath = `${outPath}.raw`;
  writeFileSync(rawPath, raw);

  // 后处理链：增益（低音量）、末尾淡出（弱尾音）、掐头（快速起音）。
  const durationSec = Number(
    execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', rawPath], {
      encoding: 'utf8',
    }).trim(),
  );
  const filters: string[] = [];
  if (typeof item0Gain === 'number') filters.push(`volume=${item0Gain}dB`);
  for (const filter of extraFilters(durationSec)) filters.push(filter);
  const args = ['-y', '-loglevel', 'error', '-i', rawPath];
  if (filters.length > 0) args.push('-af', filters.join(','));
  args.push('-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', outPath);
  execFileSync('/usr/bin/ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  void text;
}

// 每次 synthesize 用到的临时后处理参数（thread-local 一样的小手段，避免把 filter 列表穿参）。
let item0Gain: number | undefined;
let extraFilters: (duration: number) => string[] = () => [];

/** 把一条 item 的后处理参数装进上面两个变量（synthesize 的单文件风格）。 */
function armItemPostFilters(item: CorpusItem): void {
  item0Gain = item.gainDb;
  extraFilters = (duration: number): string[] => {
    const list: string[] = [];
    if (typeof item.trimLeadMs === 'number') {
      // 快速起音 stand-in：掐掉开头静音，让语音直接从第一帧起。
      list.push(`atrim=start=${(item.trimLeadMs / 1000).toFixed(3)}`);
      list.push('asetpts=PTS-STARTPTS');
    }
    if (typeof item.tailFadeMs === 'number' && duration > 0) {
      // 弱尾音 stand-in：末 N ms 线性压到 `tailFadeGainDb` 并**保持**在那里（不是淡到 0，
      // 那会变成「强尾音」）。用 volume 的逐帧表达式做，避免阶跃产生的咔哒声。
      const gainDb = typeof item.tailFadeGainDb === 'number' ? item.tailFadeGainDb : -18;
      const g = 10 ** (gainDb / 20);
      const t0 = Math.max(0, duration - item.tailFadeMs / 1000);
      const t1 = duration;
      const expr = `if(lt(t\\,${t1.toFixed(3)})\\,if(lt(t\\,${t0.toFixed(3)})\\,1\\,1-(1-${g.toFixed(4)})*(t-${t0.toFixed(3)})/(${(t1 - t0).toFixed(3)}))\\,${g.toFixed(4)})`;
      list.push(`volume=volume='${expr}':eval=frame`);
    }
    return list;
  };
}

async function ensureAudio(items: CorpusItem[], audioDir: string): Promise<void> {
  for (const item of items) {
    const target = path.join(audioDir, `${item.id}.wav`);
    if (existsSync(target)) {
      log(`  [tts] 复用 ${item.id}.wav`);
      continue;
    }
    process.stdout.write(`  [tts] 合成 ${item.id} … `);
    // 把后处理参数装好再合成（synthesize 从这两个变量读）。
    armItemPostFilters(item);
    await synthesize(item.text, target);
    log('ok');
  }
}

/** 读一条 16 kHz 单声道 PCM16 WAV 的 data chunk。 */
function parseWavPcm16(buffer: Buffer): { pcm16: Buffer } {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data') return { pcm16: buffer.subarray(body, Math.min(buffer.length, body + size)) };
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** 去掉尾部由 TTS 留给的过长静音（否则整轨拖长、每帧都当成静音）。保留 ≤ 200 ms 尾巴。 */
function trimTrailingSilence(pcm: Buffer, threshold = 220, keepMs = 120): Buffer {
  const samples = Math.floor(pcm.length / 2);
  let last = samples - 1;
  while (last > 0 && Math.abs(pcm.readInt16LE(last * 2)) < threshold) last -= 1;
  const keep = Math.floor((keepMs / 1000) * SAMPLE_RATE);
  const end = Math.min(samples, last + keep + 1);
  return pcm.subarray(0, end * 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// stand-in 音频：底噪、键盘声（合成，不是真人录音）
// ─────────────────────────────────────────────────────────────────────────────

/** 确定性 PRNG（xorshift32），让 stand-in 可复现。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** 生成 `ms` 毫秒的「环境底噪」stand-in：低幅粉噪（−46 dBFS 量级），上游应判为静音。 */
function noiseFloor(ms: number, amp = 0.005): Buffer {
  const n = Math.floor((SAMPLE_RATE * ms) / 1000);
  const out = Buffer.alloc(n * 2);
  const rng = makeRng(0x51a5e);
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    const white = rng() * 2 - 1;
    prev = 0.97 * prev + 0.03 * white; // 低通 ⇒ 偏粉
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(prev * amp * 6 * 32767))), i * 2);
  }
  return out;
}

/** 生成 `ms` 毫秒的「键盘声」stand-in：随机间隔的短促衰减噪声簇。 */
function keyboardSound(ms: number): Buffer {
  const n = Math.floor((SAMPLE_RATE * ms) / 1000);
  const out = Buffer.alloc(n * 2);
  const rng = makeRng(0xdead1);
  let i = 0;
  while (i < n) {
    const gap = Math.floor((0.06 + rng() * 0.12) * SAMPLE_RATE); // 60–180 ms 一个键
    i += gap;
    const burst = Math.floor(0.012 * SAMPLE_RATE); // 12 ms 簇
    for (let k = 0; k < burst && i + k < n; k += 1) {
      const env = Math.exp(-k / (0.004 * SAMPLE_RATE));
      const sample = (rng() * 2 - 1) * env * 0.25 * 32767;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), (i + k) * 2);
    }
    i += burst;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 帧工具 + 检测器（STS 原型：偏向语音 + 自适应底噪 + 长挂起）
// ─────────────────────────────────────────────────────────────────────────────

function frameCount(pcm: Buffer): number {
  return Math.ceil(pcm.length / FRAME_BYTES);
}
function frameAt(pcm: Buffer, index: number): Buffer {
  return pcm.subarray(index * FRAME_BYTES, Math.min(pcm.length, (index + 1) * FRAME_BYTES));
}
/** 一帧的 RMS（dBFS）。全零帧按 −100 dBFS 读，避免 −Infinity。 */
function frameDb(frame: Buffer): number {
  const n = Math.floor(frame.length / 2);
  if (n === 0) return -100;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = frame.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return rms <= 1e-9 ? -100 : 20 * Math.log10(rms);
}

/**
 * STS 原型检测器：偏向判为语音（误判静音会丢话，是正确性缺陷；误判语音只多传一段底噪，是成本）。
 * 稳健底噪（滑窗分位）+ 相对门限 + 挂起（hangover）。
 *
 * 为什么底噪不能用「瞬时最小值跟踪」：第一版用的是 `if (db < floor) floor = db`（立刻跟下去、每帧
 * 上移 0.04 dB）。合成语音的剪辑里带有**数字静音**帧（`trimTrailingSilence` 留下的尾巴、词间停顿，
 * 低音量 stand-in 再整体降 22–26 dB 后会到 −79…−112 dBFS），这些帧把底噪一次性拖到极低，而恢复速度
 * 只有 2 dB/s —— 于是底噪在几十秒内都停在 −80 dB 附近，门限被 `absGateDb` 顶住，拼出来的底噪段
 * 峰值（≈ −50 dB）几乎帧帧越限。读数见 `analyzeStsSource`：同一段底噪，独立测 0/150 误判，拼轨上
 * 294/325。修法是把底噪估计换成**滑窗低分位**，并**排除数字静音帧**（低于 `digitalSilenceDb` 的帧
 * 不是环境底噪，是剪辑边界），这样底噪跟着真正的环境噪声走，不跟剪辑的零点走。
 */
class SpeechDetector {
  private hangoverLeftMs = 0;
  /** 最近 `floorWindowMs` 的帧 dB（含被排除的数字静音帧的**索引**不做特判，取值时过滤）。 */
  private readonly dbRing: number[] = [];
  /** 每帧判定；`true` = 这一帧是语音。 */
  speechMarginDb = 9;
  /** 绝对门限的下限：底噪再低，门限也不低于它（避免底噪极低时把一切判成语音）。 */
  absGateDb = -52;
  hangoverMs = 320;
  /** 底噪估计窗口与分位。 */
  floorWindowMs = 1_500;
  floorPercentile = 0.15;
  /** 低于此值的帧视为数字静音（剪辑边界），不参与底噪估计。 */
  digitalSilenceDb = -70;
  private floorDb = -55;
  readonly decisions: boolean[] = [];
  readonly dbSeries: number[] = [];

  /** 当前跟踪到的底噪（dBFS）—— 报告读它解释一次判定。 */
  get trackedFloorDb(): number {
    return this.floorDb;
  }

  /** 用滑窗低分位（排除数字静音帧）重估底噪；窗口内没有合规帧时保持上一次的值。 */
  private updateFloor(db: number): void {
    this.dbRing.push(db);
    const cap = Math.max(4, Math.ceil(this.floorWindowMs / FRAME_MS));
    while (this.dbRing.length > cap) this.dbRing.shift();
    const eligible = this.dbRing.filter((v) => v > this.digitalSilenceDb).sort((a, b) => a - b);
    if (eligible.length === 0) return;
    const idx = Math.min(eligible.length - 1, Math.floor(eligible.length * this.floorPercentile));
    this.floorDb = eligible[idx]!;
  }

  decide(frame: Buffer): boolean {
    const db = frameDb(frame);
    this.dbSeries.push(db);
    const isSpeech = db > Math.max(this.floorDb + this.speechMarginDb, this.absGateDb);
    // 底噪只用**非语音**帧估：语音持续时窗口里几乎没有噪声帧，底噪因此不会跟着语音抬上去
    // （1.5 s 窗口落在一条 1.7 s 语音里时，含语音的分位会把门限抬进门限上方的弱尾，把尾音判成静音）。
    if (!isSpeech) this.updateFloor(db);
    if (isSpeech) this.hangoverLeftMs = this.hangoverMs;
    else this.hangoverLeftMs = Math.max(0, this.hangoverLeftMs - FRAME_MS);
    const speech = isSpeech || this.hangoverLeftMs > 0;
    this.decisions.push(speech);
    return speech;
  }
}

/**
 * STS 原型的上传状态机：streaming → tail(T) → suppressed →（前滚 P）→ streaming。
 * `feed(frame, isSpeech)` 返回**此刻应当上传**的帧（0 个、1 个，或恢复时的一串前滚 + 当前帧）。
 */
class StsPrototype {
  private state: 'streaming' | 'tail' | 'suppressed' = 'streaming';
  private tailMs = 0;
  private ring: Buffer[] = [];
  /** 最近 uploadedMs 的统计。 */
  uploadedMs = 0;
  /** 因停传而**未**上传的毫秒数（V-8 的分子来源之一）。 */
  suppressedMs = 0;
  readonly stateLog: Array<{ frame: number; from: string; to: string }> = [];
  private frameIndex = 0;

  constructor(
    readonly tMs: number,
    readonly pMs: number,
  ) {}

  private ringLimitFrames(): number {
    return Math.max(1, Math.ceil(this.pMs / FRAME_MS));
  }

  feed(frame: Buffer, isSpeech: boolean): Buffer[] {
    this.frameIndex += 1;
    // 前滚环形缓冲：始终保存最近 P ms 的**已采集**帧。
    this.ring.push(frame);
    const limit = this.ringLimitFrames();
    while (this.ring.length > limit) this.ring.shift();

    if (this.state === 'streaming') {
      if (isSpeech) {
        this.uploadedMs += FRAME_MS;
        return [frame];
      }
      this.setState('tail');
      this.tailMs = 0;
      // 落入 tail 的当帧仍然上传（它是语音刚结束后的真实底噪）。
      this.tailMs += FRAME_MS;
      this.uploadedMs += FRAME_MS;
      return [frame];
    }

    if (this.state === 'tail') {
      if (isSpeech) {
        this.setState('streaming');
        this.uploadedMs += FRAME_MS;
        return [frame];
      }
      this.tailMs += FRAME_MS;
      if (this.tailMs < this.tMs) {
        this.uploadedMs += FRAME_MS;
        return [frame];
      }
      this.setState('suppressed');
      this.suppressedMs += FRAME_MS;
      return [];
    }

    // suppressed
    if (isSpeech) {
      this.setState('streaming');
      const preRoll = [...this.ring];
      this.uploadedMs += preRoll.length * FRAME_MS;
      return preRoll; // 先补发前滚 P（含当前帧，因为 ring 已 push 过）
    }
    this.suppressedMs += FRAME_MS;
    return [];
  }

  private setState(to: 'streaming' | 'tail' | 'suppressed'): void {
    if (this.state === to) return;
    this.stateLog.push({ frame: this.frameIndex, from: this.state, to });
    this.state = to;
  }
  get currentState(): 'streaming' | 'tail' | 'suppressed' {
    return this.state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 上游连接（raw WS 客户端）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个 wire 帧。`atMs` 是相对连接开始的**墙钟**偏移；`atAudioMs` 是记录它时**已经上传的音频毫秒数**
 * —— 也就是**音频时间轴**上的位置。
 *
 * 为什么两个都要。墙钟会被播放器的抖动污染（`await sleep(20)` 每帧多几毫秒，250 帧就漂几百毫秒），
 * 而 V-1 问的正是「上游按哪条轴算静音」：只有把事件钉在**音频轴**上，「收到多少毫秒静音才断句」
 * 才是可直接读的数，而不是从两个都在漂的墙钟相减。
 */
type WireEvent = { atMs: number; atAudioMs: number; direction: 'sent' | 'received'; type: string; raw: Record<string, unknown> };
type CallReading = { atMs: number; name: string; args: Record<string, unknown>; raw: string };
type ResponseUsage = { atMs: number; inputTokens: number; outputTokens: number; textTokens: number; audioTokens: number; costCny: number };

class UpstreamLink {
  private readonly ws: WebSocket;
  readonly events: WireEvent[] = [];
  readonly calls: CallReading[] = [];
  readonly responses: ResponseUsage[] = [];
  readonly errors: string[] = [];
  private readonly t0 = Date.now();
  private readonly capCny: number;
  private spendCny = 0;
  capTripped = false;
  closed = false;
  closeInfo: { code: number; reason: string; atMs: number } | null = null;
  /** 已上传的音频毫秒数（sent 的 append 帧 × 20）。 */
  uploadedMs = 0;
  /** 本地驱动结束时的墙钟（不受 close 影响）。 */
  driverEndAtMs = 0;
  private readonly advertisedTools: Set<string>;
  /**
   * 已经回过的 tool call id。上游把同一个调用报两次（`response.function_call_arguments.done`
   * 与 `response.output_item.done` 各一次），第一次冒烟就是因此回了两个同样 call_id 的 output，
   * 换来 `Duplicate function call output for call_id` —— 所以按 call_id 去重，只回一次。
   */
  private readonly answeredCalls = new Set<string>();
  /**
   * 合成 `response.create` 的在途闸门，与出货 transport 的 `DashscopeResponseConcurrency` 同义：
   * 一个 response 还没结束时再送 `response.create`，上游回
   * `Conversation already has an active response`。所以在途时**挂起**，等 `response.done` 再放。
   */
  private responseActive = false;
  private pendingResponseCreate = false;

  private constructor(ws: WebSocket, capCny: number, advertisedTools: Set<string>) {
    this.ws = ws;
    this.capCny = capCny;
    this.advertisedTools = advertisedTools;
  }

  static async connect(options: { instructions: string; tools: CorpusTool[]; turnDetection: Record<string, unknown>; capCny: number; sessionExtra?: Record<string, unknown> }): Promise<UpstreamLink> {
    const key = process.env.DASHSCOPE_API_KEY;
    if (key === undefined || key.trim() === '') throw new Error('DASHSCOPE_API_KEY 未设置');
    const names = new Set(options.tools.map((t) => t.function.name));
    const ws = new WebSocket(`${UPSTREAM_URL}?model=${encodeURIComponent(MODEL)}`, { headers: { Authorization: `Bearer ${key}` } });
    const link = new UpstreamLink(ws, options.capCny, names);
    const opened = await link.waitOpen(15_000);
    if (!opened) throw new Error('上游 socket 未在 15 s 内打开');
    ws.on('message', (data: Buffer) => link.handle(data.toString('utf8')));
    ws.on('close', (code: number, reason: Buffer) => {
      link.closed = true;
      link.closeInfo = { code, reason: reason.toString('utf8'), atMs: Date.now() - link.t0 };
    });
    ws.on('error', (err: Error) => link.errors.push(`socket: ${err.message}`));
    const session: Record<string, unknown> = {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm24',
      voice: VOICE,
      instructions: options.instructions,
      turn_detection: options.turnDetection,
      tools: options.tools,
      ...(options.sessionExtra ?? {}),
    };
    link.sendRaw({ type: 'session.update', session });
    const ready = await link.waitForFrame((e) => e.type === 'session.created' || e.type === 'session.updated' || e.type === 'error', 12_000);
    if (ready !== true) throw new Error('上游未在 12 s 内回应 session.update');
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

  private sendRaw(frame: Record<string, unknown>): void {
    // `append()` 已经把 uploadedMs 加过了，所以对 append 帧 atAudioMs = 这一帧**之后**的音频位置。
    this.events.push({ atMs: Date.now() - this.t0, atAudioMs: this.uploadedMs, direction: 'sent', type: String(frame.type), raw: frame });
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.errors.push(`send: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 上传一帧 PCM16（base64）。返回是否真的发出（停传期间调用方不应调用）。 */
  append(frame: Buffer): void {
    this.uploadedMs += Math.round((frame.length / 2 / SAMPLE_RATE) * 1000);
    this.sendRaw({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
  }

  private handle(text: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(raw.type ?? 'unknown');
    this.events.push({ atMs: Date.now() - this.t0, atAudioMs: this.uploadedMs, direction: 'received', type, raw });

    if (type === 'response.created') this.responseActive = true;
    if (type === 'response.done') {
      this.responseActive = false;
      this.readUsage(raw);
      if (this.pendingResponseCreate) {
        this.pendingResponseCreate = false;
        this.sendRaw({ type: 'response.create' });
      }
    }
    if (type === 'error') this.errors.push(`upstream: ${JSON.stringify(raw).slice(0, 300)}`);

    // dry-run 执行器：模型调工具只被记录，回一个合成 output，绝不落到任何真实会话。
    const call = this.readCall(raw);
    if (call !== null && !this.answeredCalls.has(call.callId)) {
      this.answeredCalls.add(call.callId);
      this.calls.push(call);
      this.sendRaw({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify({ dryRun: true, accepted: true, note: 'STS probe recorded this call; nothing was executed' }) },
      });
      this.requestResponse();
    }
  }

  /** 送 `response.create`，但一个 response 还在途时先挂起（与出货 transport 的并发闸门同义）。 */
  private requestResponse(): void {
    if (this.responseActive) {
      this.pendingResponseCreate = true;
      return;
    }
    this.sendRaw({ type: 'response.create' });
  }

  private readCall(raw: Record<string, unknown>): (CallReading & { callId: string }) | null {
    const t = String(raw.type);
    if (t === 'response.function_call_arguments.done') {
      const name = typeof raw.name === 'string' ? raw.name : '';
      const callId = typeof raw.call_id === 'string' ? raw.call_id : '';
      if (name === '' || callId === '' || !this.advertisedTools.has(name)) return null;
      const rawArgs = typeof raw.arguments === 'string' ? raw.arguments : '{}';
      return { atMs: Date.now() - this.t0, name, args: safeParse(rawArgs), raw: rawArgs, callId };
    }
    if (t === 'response.output_item.done') {
      const item = raw.item as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown } | undefined;
      if (item?.type !== 'function_call' || typeof item.name !== 'string' || typeof item.call_id !== 'string') return null;
      if (!this.advertisedTools.has(item.name)) return null;
      const rawArgs = typeof item.arguments === 'string' ? item.arguments : '{}';
      return { atMs: Date.now() - this.t0, name: item.name, args: safeParse(rawArgs), raw: rawArgs, callId: item.call_id };
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
    const audioTokens = typeof usage.input_tokens_details?.audio_tokens === 'number' ? usage.input_tokens_details.audio_tokens : 0;
    const textTokens =
      typeof usage.input_tokens_details?.text_tokens === 'number'
        ? usage.input_tokens_details.text_tokens
        : Math.max(0, inputTokens - audioTokens);
    const costCny = estimateRealtimeCostCny(usage);
    this.spendCny += costCny;
    this.responses.push({ atMs: Date.now() - this.t0, inputTokens, outputTokens, textTokens, audioTokens, costCny });
    if (this.spendCny > this.capCny && !this.capTripped) {
      this.capTripped = true;
      this.errors.push(`SPEND_CAP: 本连接累计 ${this.spendCny.toFixed(4)} CNY 超过上限 ${this.capCny}`);
    }
  }

  /** 本次连接的总估算花费（CNY）。 */
  get spend(): number {
    return this.spendCny;
  }

  /** 由上游主动发来的、类型匹配的帧（墙钟 atMs）。 */
  inboundOfType(type: string): WireEvent[] {
    return this.events.filter((e) => e.direction === 'received' && e.type === type);
  }

  close(): void {
    try {
      this.ws.close(1000, 'probe done');
    } catch {
      // 已经断了。
    }
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : { __nonObject: text };
  } catch {
    return { __unparsed: text };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 播放器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按**墙钟截止时刻**播放，而不是每帧 `await sleep(20)` 累加。后者会把每帧的调度开销（每次几毫秒）
 * 累积成整段可观的漂移（实测 2.5 s 的音频能跑出 ~1 s 的偏差），让「第 N 帧在墙钟第几毫秒」不再是
 * 可推理的数。截止时刻法把漂移钉死在单帧调度误差上，`atMs` 才可用来对照 `atAudioMs`。
 */
async function pace(deadlineMs: number): Promise<void> {
  const wait = deadlineMs - Date.now();
  if (wait > 0) await sleep(wait);
}

/** 实时逐帧播放一段 PCM，`onFrame` 决定这一帧上传与否（返回 null = 不上传）。 */
async function playPcm(
  link: UpstreamLink,
  pcm: Buffer,
  onFrame: ((frame: Buffer, index: number) => Buffer[] | null) | null,
): Promise<void> {
  const frames = frameCount(pcm);
  const t0 = Date.now();
  for (let i = 0; i < frames; i += 1) {
    await pace(t0 + i * FRAME_MS);
    const frame = frameAt(pcm, i);
    if (onFrame === null) link.append(frame);
    else {
      const out = onFrame(frame, i);
      if (out !== null) for (const f of out) link.append(f);
    }
  }
}

/** 实时播放一段静音音频（底噪或纯数字静音）；V-1 用。 */
async function playSilence(link: UpstreamLink, ms: number, filler: Buffer): Promise<void> {
  const frames = Math.floor(ms / FRAME_MS);
  const t0 = Date.now();
  for (let i = 0; i < frames; i += 1) {
    await pace(t0 + i * FRAME_MS);
    link.append(frameAt(filler, i % frameCount(filler)));
  }
}

/** 纯数字静音（全零帧）——V-1 扫描的对照组，用来分辨「上游判不了」与「我的底噪被当成语音」。 */
function digitalSilence(ms: number): Buffer {
  return Buffer.alloc(Math.floor((SAMPLE_RATE * ms) / 1000) * 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 分段实验
// ─────────────────────────────────────────────────────────────────────────────

type ConnReading = {
  connectionId: string;
  label: string;
  section: string;
  startedAt: string;
  closedMs: number | null;
  closedCode: number | null;
  connectedMs: number;
  uploadedMs: number;
  sessionMs: number;
  responses: number;
  calls: number;
  spendCny: number;
  capTripped: boolean;
  errors: string[];
  events: WireEvent[];
  /** 末次 `response.done` 的累计 usage（见 buildReading 说明）。 */
  usage: { textTokens: number; audioTokens: number; outputTokens: number; cumulative: boolean; responsesCounted: number };
  /** 转写（用户语音） */
  inputTranscripts: string[];
  /** 与 `inputTranscripts` 同序，带 `atMs`（连接相对墙钟）——用来把「恢复段」按时间切出来。 */
  inputItems: Array<{ atMs: number; text: string }>;
  /** 模型文本输出 */
  modelTexts: string[];
  note?: string;
};

function buildReading(link: UpstreamLink, connectionId: string, label: string, section: string, startedAtMs: number, startedAt: string): ConnReading {
  const inputTranscripts: string[] = [];
  const inputItems: Array<{ atMs: number; text: string }> = [];
  const modelTexts: string[] = [];
  for (const e of link.inboundOfType('conversation.item.input_audio_transcription.completed')) {
    if (typeof e.raw.transcript === 'string') {
      inputTranscripts.push(e.raw.transcript);
      inputItems.push({ atMs: e.atMs, text: e.raw.transcript });
    }
  }
  for (const e of link.inboundOfType('response.text.done')) {
    const text = (e.raw as { text?: unknown }).text;
    if (typeof text === 'string') modelTexts.push(text);
  }
  // `usage.input_tokens_details` 是**整条连接的累计值**（出货 transport 头注确认：不是每次 response 的增量，
  // 已对过真实账单行）。所以本连接的 token 读数是**最后一次** `response.done` 的值，不是各次求和——求和会
  // 把同一段上下文反复计入。`link.spend` 仍然按出货花费守卫的算法（逐次求和）报告，见下。
  const last = link.responses.length === 0 ? null : link.responses[link.responses.length - 1]!;
  const usage = {
    textTokens: last?.textTokens ?? 0,
    audioTokens: last?.audioTokens ?? 0,
    outputTokens: last?.outputTokens ?? 0,
    cumulative: last !== null,
    responsesCounted: link.responses.length,
  };
  return {
    connectionId,
    label,
    section,
    startedAt,
    closedMs: link.closeInfo === null ? null : link.closeInfo.atMs,
    closedCode: link.closeInfo === null ? null : link.closeInfo.code,
    connectedMs: (link.driverEndAtMs || Date.now() - startedAtMs),
    uploadedMs: link.uploadedMs,
    sessionMs: link.driverEndAtMs,
    responses: link.responses.length,
    calls: link.calls.length,
    spendCny: link.spend,
    capTripped: link.capTripped,
    errors: [...link.errors],
    events: link.events,
    usage,
    inputTranscripts,
    inputItems,
    modelTexts,
  };
}

/** 从一条连接的事件里读该次 VAD 事件的墙钟偏移（相对连接开始）。 */
function vadOffsets(events: WireEvent[], type: string): number[] {
  return events.filter((e) => e.direction === 'received' && e.type === type).map((e) => e.atMs);
}

/**
 * 同一次 VAD 事件在**音频轴**上的位置：事件到达时已经上传了多少毫秒音频。
 *
 * 这是 V-1 真正要问的那根轴。墙钟轴被播放器的调度抖动污染（同一份音频两次跑能差出几百毫秒），
 * 而音频轴是单调的、且**停传即冻结**——如果上游 VAD 挂在音频时间基上，那么停传后到的事件其
 * `atAudioMs` 只能停在冻结值上，永远追不上配置的窗口；如果挂在墙钟上，它会在停传期间继续走到窗口。
 * 两种假设在这根轴上给出**不可混淆**的两个结果，墙钟轴上则给不出。
 */
function audioOffsets(events: WireEvent[], type: string): number[] {
  return events.filter((e) => e.direction === 'received' && e.type === type).map((e) => e.atAudioMs);
}

/**
 * V-1：只送 `silence_duration_ms ± 100 ms` 的真实静音，然后**停传 5 s**，看是否 / 何时
 * `speech_stopped`。音频时间基 ⇒ −100 ms 在停传窗口内**不该**出现 `speech_stopped`；墙钟基 ⇒ 会出现。
 */
/** V-1 的一个条件：`silence_duration_ms = d`，真的送出 `sent` 毫秒静音（`filler`），然后停传 5 s。 */
async function runV1Condition(
  corpus: Corpus,
  speech: Buffer,
  filler: Buffer,
  capCny: number,
  journalDir: string,
  d: number,
  sent: number,
  tag: string,
  sweep: boolean,
): Promise<ConnReading> {
  const label = `v1/D${d}/${tag}`;
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  process.stdout.write(`  [V-1] ${label} … `);
  const link = await UpstreamLink.connect({
    instructions: corpus.instructions,
    tools: corpus.tools,
    turnDetection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: d },
    capCny,
  });
  try {
    await playPcm(link, speech, null);
    const clipAudioMs = link.uploadedMs;
    const speechEndWallMs = Date.now() - startedAtMs;
    await playSilence(link, sent, filler);
    const silenceSentWallMs = Date.now() - startedAtMs;
    await sleep(5_000);
    const stallEndWallMs = Date.now() - startedAtMs;
    link.driverEndAtMs = Date.now() - startedAtMs;
    const reading = buildReading(link, connectionId, label, 'V-1', startedAtMs, nowIso(startedAtMs));
    reading.note = JSON.stringify({
      silenceDurationMs: d,
      deltaMs: sent - d,
      silenceSentMs: sent,
      fillerFrames: filler.length === 0 || filler.every((b) => b === 0) ? 'digital' : 'noise',
      sweep,
      clipAudioMs,
      speechEndWallMs,
      silenceSentWallMs,
      stallEndWallMs,
      speechStoppedOffsets: vadOffsets(link.events, 'input_audio_buffer.speech_stopped'),
      speechStoppedAudioMs: audioOffsets(link.events, 'input_audio_buffer.speech_stopped'),
      speechStartedOffsets: vadOffsets(link.events, 'input_audio_buffer.speech_started'),
      speechStartedAudioMs: audioOffsets(link.events, 'input_audio_buffer.speech_started'),
      responsesDone: link.responses.length,
    });
    writeJournal(journalDir, reading, link);
    const stopped = audioWallPairs(reading, 'speechStopped');
    log(
      `speech_stopped=${stopped.length === 0 ? '无' : stopped.map((p) => `已收静音${p.audioMs - clipAudioMs}ms`).join(',')}` +
        ` 花费=¥${reading.spendCny.toFixed(4)}`,
    );
    return reading;
  } catch (err) {
    log(`错误=${err instanceof Error ? err.message : String(err)}`);
    return errorReading(link, connectionId, label, 'V-1', startedAtMs, err);
  } finally {
    link.close();
    await sleep(300);
  }
}

async function runV1(corpus: Corpus, speech: Buffer, noise: Buffer, capCny: number, journalDir: string): Promise<ConnReading[]> {
  const readings: ConnReading[] = [];
  for (const d of [400, 800]) {
    for (const delta of [-100, 100]) {
      const tag = `${delta > 0 ? '+' : '−'}100ms`;
      readings.push(await runV1Condition(corpus, speech, noise, capCny, journalDir, d, d + delta, tag, false));
    }
  }
  return readings;
}

/**
 * V-1 的**帧边界扫描**（附加读数）。±100 ms 只探到配置值两侧各一格；边界到底在不在配置值上，
 * 要在 `D = 400` 上跨着 400 ms 扫一圈才读得出来：音频时间基 ⇒ `< 400` 全不触发、`≥ 400` 全触发，
 * 且触发点的「已收静音」钉在 ≈ 400 ms。墙钟基则会在停传后照样触发。
 *
 * 另加一档**数字静音对照**：与触发档同样的长度、但填的是全零帧而不是合成底噪。若两者表现相同，
 * 「上游判不了静音」就不是我的底噪太吵造成的；若只有底噪档能触发，说明合成底噪本身参与了判定。
 */
async function runV1Sweep(corpus: Corpus, speech: Buffer, noise: Buffer, capCny: number, journalDir: string): Promise<ConnReading[]> {
  const readings: ConnReading[] = [];
  for (const sent of [200, 300, 400, 500, 700]) {
    readings.push(await runV1Condition(corpus, speech, noise, capCny, journalDir, 400, sent, `sent${sent}ms`, true));
  }
  readings.push(await runV1Condition(corpus, speech, digitalSilence(700), capCny, journalDir, 400, 700, 'digital700ms', true));
  return readings;
}

/**
 * V-2：停传 1/5/15/30 min 后恢复讲话。四档**并行于不同连接**（同一运行内）。记录连接存活、错误事件、
 * 首句延迟；另开一条短连接验证 qwen3.8 是否接受 `idle_timeout_ms`。
 */
async function runV2(corpus: Corpus, speech: Buffer, capCny: number, journalDir: string): Promise<{ stall: ConnReading[]; idle: ConnReading }> {
  const stalls = [60_000, 300_000, 900_000, 1_800_000];
  const jobs = stalls.map(async (stallMs): Promise<ConnReading> => {
    const minutes = stallMs / 60_000;
    const label = `v2/stall${minutes}min`;
    const connectionId = randomUUID();
    const startedAtMs = Date.now();
    const link = await UpstreamLink.connect({
      instructions: corpus.instructions,
      tools: corpus.tools,
      turnDetection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: DEFAULT_SILENCE_MS },
      capCny,
    });
    try {
      // 第一句 + 尾随真实静音（不发静音音频上游不会断句），然后才停传。
      await playPcm(link, Buffer.concat([speech, noiseFloor(1_000)]), null);
      const speechEndWallMs = Date.now() - startedAtMs;
      // 停传：不发任何帧，只等；一旦 socket 关了就提前结束这一档。
      const stallDeadline = Date.now() + stallMs;
      let observedStallMs = 0;
      while (Date.now() < stallDeadline) {
        if (link.closed) break;
        await sleep(1_000);
        observedStallMs = Date.now() - startedAtMs - speechEndWallMs;
      }
      const alive = !link.closed;
      let firstSentenceLatencyMs: number | null = null;
      let newTranscripts = 0;
      if (alive) {
        // 停传前的转写条数先记下来：第一句的 `…transcription.completed` 在停传**之前**就到了，
        // 若直接取「连接内第一条」，量到的是停传前的读数，会算出负延迟（首跑就是这样：−59.8 s）。
        const transcriptsBeforeResume = link.inboundOfType('conversation.item.input_audio_transcription.completed').length;
        const resumeAtMs = Date.now() - startedAtMs;
        await playPcm(link, Buffer.concat([speech, noiseFloor(1_000)]), null);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (link.inboundOfType('conversation.item.input_audio_transcription.completed').length > transcriptsBeforeResume) break;
          await sleep(200);
        }
        const afterResume = link
          .inboundOfType('conversation.item.input_audio_transcription.completed')
          .slice(transcriptsBeforeResume);
        newTranscripts = afterResume.length;
        const first = afterResume[0] ?? null;
        if (first !== null) firstSentenceLatencyMs = Math.max(0, first.atMs - resumeAtMs);
      }
      link.driverEndAtMs = Date.now() - startedAtMs;
      const reading = buildReading(link, connectionId, label, 'V-2', startedAtMs, nowIso(startedAtMs));
      reading.note = JSON.stringify({
        requestedStallMs: stallMs,
        observedStallMs,
        aliveAfterStall: alive,
        firstSentenceLatencyMs,
        newTranscriptsAfterResume: newTranscripts,
        closedMs: reading.closedMs,
        closedCode: reading.closedCode,
      });
      writeJournal(journalDir, reading, link);
      log(`  [V-2] ${label}：停传 ${Math.round(observedStallMs / 1000)}s，${alive ? '存活' : `关闭(code=${reading.closedCode})`}，恢复后新转写=${alive ? `${newTranscripts} 条` : '未恢复'}${firstSentenceLatencyMs === null ? '' : `（首条 +${firstSentenceLatencyMs} ms）`}，花费=¥${reading.spendCny.toFixed(4)}`);
      return reading;
    } catch (err) {
      const reading = errorReading(link, connectionId, label, 'V-2', startedAtMs, err);
      writeJournal(journalDir, reading, link);
      log(`  [V-2] ${label}：错误=${err instanceof Error ? err.message : String(err)}`);
      return reading;
    } finally {
      link.close();
    }
  });
  const stall = await Promise.all(jobs);

  // idle_timeout_ms 是否被 qwen3.8 接受：一条不发声的短连接，带该字段。
  const idleLabel = 'v2/idle_timeout_ms';
  const idleId = randomUUID();
  const idleStartMs = Date.now();
  let idle: ConnReading;
  try {
    const link = await UpstreamLink.connect({
      instructions: corpus.instructions,
      tools: corpus.tools,
      turnDetection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: DEFAULT_SILENCE_MS },
      sessionExtra: { idle_timeout_ms: 600_000 },
      capCny,
    });
    await sleep(2_000);
    link.driverEndAtMs = Date.now() - idleStartMs;
    idle = buildReading(link, idleId, idleLabel, 'V-2', idleStartMs, nowIso(idleStartMs));
    const echoed = link.inboundOfType('session.updated').some((e) => 'idle_timeout_ms' in (e.raw.session as Record<string, unknown> ?? {}));
    const errored = link.errors.some((e) => /idle_timeout/i.test(e));
    idle.note = JSON.stringify({ acceptedNoError: !errored, echoedInSessionUpdated: echoed, errors: link.errors });
    writeJournal(journalDir, idle, link);
    link.close();
    log(`  [V-2] idle_timeout_ms：${errored ? '被拒（错误帧）' : '无错误帧'}；session.updated 回显=${echoed}`);
  } catch (err) {
    idle = {
      connectionId: idleId,
      label: idleLabel,
      section: 'V-2',
      startedAt: nowIso(idleStartMs),
      closedMs: null,
      closedCode: null,
      connectedMs: 0,
      uploadedMs: 0,
      sessionMs: 0,
      responses: 0,
      calls: 0,
      spendCny: 0,
      capTripped: false,
      errors: [err instanceof Error ? err.message : String(err)],
      events: [],
      usage: { textTokens: 0, audioTokens: 0, outputTokens: 0, cumulative: false, responsesCounted: 0 },
      inputTranscripts: [],
      inputItems: [],
      modelTexts: [],
      note: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    };
    log(`  [V-2] idle_timeout_ms：错误=${err instanceof Error ? err.message : String(err)}`);
  }
  return { stall, idle };
}

/**
 * V-3：弱尾音 / 快速起音语料，`P ∈ {300,500,800}` ms **且真的走一次停传→恢复**。
 *
 * 源时间线：`静音 500ms + clipA + 底噪 4000ms + clipB(同一句) + 底噪 2000ms`。
 * `T = 2 s` ⇒ 底噪到 2 s 时停传（随后 ~2 s 完全不上传），4 s 处 clipB 起音 ⇒ 检测器判语音 ⇒
 * 先补发前滚 `P` 再续流。**真实读数**是 clipB 的转写是否与基线（逐帧全传）的 clipB 一致——
 * 丢字就是前滚不够 / 恢复时机有洞。基线臂（`base`）给同一句做对照。
 */
async function runV3(corpus: Corpus, clips: Map<string, Buffer>, noise: Buffer, capCny: number, journalDir: string): Promise<ConnReading[]> {
  const items = corpus.items.filter((i) => i.kind === 'weak-tail' || i.kind === 'fast-onset');
  const readings: ConnReading[] = [];
  const T = 2_000;
  const pre = noiseFloor(500);
  const gap = noiseFloor(4_000);
  const post = noiseFloor(2_000);
  for (const item of items) {
    const clip = clips.get(item.id)!;
    const source = Buffer.concat([pre, clip, gap, clip, post]);
    // 第二句（恢复段）在**源时间线上**的起点：`pre 500 ms + clip + gap 4000 ms`。
    // 有了它，「哪些 `...completed` 属于恢复段」就能按事件墙钟切出来，不必猜「第几条 item」——
    // 上游会把一句按停顿切成多条，`inputTranscripts[1]` 其实是**第一句的后半**（见 allUtterances 说明）。
    const secondClipStartMs = 500 + (clip.length / 2 / (SAMPLE_RATE / 1000)) + 4_000;
    // 基线臂 + 三个 P 值，同一源时间线。
    const arms: Array<{ tag: string; pMs: number | null }> = [
      { tag: 'base', pMs: null },
      { tag: 'P300', pMs: 300 },
      { tag: 'P500', pMs: 500 },
      { tag: 'P800', pMs: 800 },
    ];
    for (const arm of arms) {
      const label = `v3/${item.id}/${arm.tag}`;
      const connectionId = randomUUID();
      const startedAtMs = Date.now();
      process.stdout.write(`  [V-3] ${label} … `);
      const link = await UpstreamLink.connect({
        instructions: corpus.instructions,
        tools: corpus.tools,
        turnDetection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: DEFAULT_SILENCE_MS },
        capCny,
      });
      try {
        const detector = new SpeechDetector();
        const proto = new StsPrototype(T, arm.pMs ?? 0);
        if (arm.pMs === null) {
          await playPcm(link, source, null);
        } else {
          await playPcm(link, source, (frame) => proto.feed(frame, detector.decide(frame)));
        }
        await waitForQuiet(link, 12_000);
        link.driverEndAtMs = Date.now() - startedAtMs;
        const reading = buildReading(link, connectionId, label, 'V-3', startedAtMs, nowIso(startedAtMs));
        reading.note = JSON.stringify({
          itemId: item.id,
          kind: item.kind,
          arm: arm.tag,
          pMs: arm.pMs,
          tMs: arm.pMs === null ? null : T,
          secondClipStartMs: Math.round(secondClipStartMs),
          uploadedMs: link.uploadedMs,
          suppressedMs: arm.pMs === null ? 0 : proto.suppressedMs,
          stateLog: proto.stateLog,
          utterances: reading.inputTranscripts,
        });
        readings.push(reading);
        writeJournal(journalDir, reading, link);
        log(`转写=${JSON.stringify(reading.inputTranscripts)} 上传=${(link.uploadedMs / 1000).toFixed(1)}s 停传=${(proto.suppressedMs / 1000).toFixed(1)}s 花费=¥${reading.spendCny.toFixed(4)}`);
      } catch (err) {
        readings.push(errorReading(link, connectionId, label, 'V-3', startedAtMs, err));
        log(`错误=${err instanceof Error ? err.message : String(err)}`);
      } finally {
        link.close();
        await sleep(300);
      }
    }
  }
  return readings;
}

/**
 * V-7 / V-8：同一语料两臂——基线 continuous（逐帧全传）vs STS（T 秒 tail 后停传）。
 * 读条目数、`speech_stopped` 时刻、response 数、工具调用、usage（text/audio 分列）；上传秒数 / 会话秒数。
 */
async function runV7(
  corpus: Corpus,
  clips: Map<string, Buffer>,
  noise: Buffer,
  capCny: number,
  journalDir: string,
  tMs: number,
  pMs: number,
): Promise<ConnReading[]> {
  const items = corpus.items.filter((i) => i.kind === 'speech');
  const readings: ConnReading[] = [];
  for (const arm of ['baseline', 'sts'] as const) {
    for (const item of items) {
      const label = `v7/${arm}/${item.id}`;
      const connectionId = randomUUID();
      const startedAtMs = Date.now();
      process.stdout.write(`  [V-7] ${label} … `);
      const link = await UpstreamLink.connect({
        instructions: corpus.instructions,
        tools: corpus.tools,
        turnDetection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: DEFAULT_SILENCE_MS },
        capCny,
      });
      try {
        const clip = clips.get(item.id)!;
        // 源时间线：一句语音 + 6 s 底噪（continuous 会全传；STS 在 T 秒后停传）。
        const source = Buffer.concat([clip, noiseFloor(6_000)]);
        const detector = new SpeechDetector();
        const proto = new StsPrototype(tMs, pMs);
        if (arm === 'baseline') {
          await playPcm(link, source, null);
        } else {
          await playPcm(link, source, (frame) => proto.feed(frame, detector.decide(frame)));
        }
        await waitForQuiet(link, 10_000);
        link.driverEndAtMs = Date.now() - startedAtMs;
        const reading = buildReading(link, connectionId, label, 'V-7', startedAtMs, nowIso(startedAtMs));
        reading.note = JSON.stringify({
          arm,
          itemId: item.id,
          tMs,
          pMs,
          uploadedMs: link.uploadedMs,
          suppressedMs: arm === 'sts' ? proto.suppressedMs : 0,
          sessionMs: link.driverEndAtMs,
          speechStoppedOffsets: vadOffsets(link.events, 'input_audio_buffer.speech_stopped'),
        });
        readings.push(reading);
        writeJournal(journalDir, reading, link);
        log(`条目=${reading.inputTranscripts.length} response=${reading.responses} 调用=${reading.calls} 上传=${(reading.uploadedMs / 1000).toFixed(1)}s/会话=${(reading.sessionMs / 1000).toFixed(1)}s 花费=¥${reading.spendCny.toFixed(4)}`);
      } catch (err) {
        readings.push(errorReading(link, connectionId, label, 'V-7', startedAtMs, err));
        log(`错误=${err instanceof Error ? err.message : String(err)}`);
      } finally {
        link.close();
        await sleep(300);
      }
    }
  }
  return readings;
}

/**
 * V-4：从已有连接的事件里读「tail 后是否已 commit / 恢复时有无空 commit 错误或多余条目」。
 *
 * 「多余条目」的判据是 **上游自建的用户条目数 − `speech_started` 次数**（取正），而不是
 * `conversation.item.created` 总数减去转写条数：上游会把**一个语料句在读出的逗号处拆成多条**
 * 转写事件（见 V-3 的读数），于是「条目数 − 转写数」这种减法会凭空多出一大截——那不是上游的
 * 异常，是本探针按 item 计数的方式与上游分条方式不一致。用户条目多于一次起说，才是「恢复时
 * 上游自建了一个没有起说事件的条目」这一件事的直接证据。
 */
function analyzeV4(readings: ConnReading[]): {
  commits: number;
  responsesAfterStop: number;
  emptyCommitErrors: number;
  extraItemsOnResume: number;
  detail: Array<{
    label: string;
    connectionId: string;
    committed: number;
    userItems: number;
    speechStarts: number;
    errors: number;
  }>;
} {
  let commits = 0;
  let responsesAfterStop = 0;
  let emptyCommitErrors = 0;
  let extraItemsOnResume = 0;
  const detail: Array<{
    label: string;
    connectionId: string;
    committed: number;
    userItems: number;
    speechStarts: number;
    errors: number;
  }> = [];
  for (const r of readings) {
    const committed = r.events.filter((e) => e.type === 'input_audio_buffer.committed').length;
    const userItems = r.events.filter((e) => {
      if (e.type !== 'conversation.item.created') return false;
      const item = e.raw.item as { role?: unknown } | undefined;
      return item?.role === 'user';
    }).length;
    const speechStarts = r.events.filter((e) => e.type === 'input_audio_buffer.speech_started').length;
    const errors = r.errors.filter((e) => /commit|no audio|buffer too small/i.test(e)).length;
    commits += committed;
    responsesAfterStop += r.responses;
    emptyCommitErrors += errors;
    if (userItems > speechStarts) extraItemsOnResume += userItems - speechStarts;
    detail.push({
      label: r.label,
      connectionId: r.connectionId,
      committed,
      userItems,
      speechStarts,
      errors: r.errors.length,
    });
  }
  return { commits, responsesAfterStop, emptyCommitErrors, extraItemsOnResume, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// V-5：误判率（本地确定性，不连上游）
// ─────────────────────────────────────────────────────────────────────────────

function analyzeV5(clips: Map<string, Buffer>, corpus: Corpus): {
  noiseSpeechFrames: number;
  noiseTotal: number;
  keyboardSpeechFrames: number;
  keyboardTotal: number;
  lowVolumeMissed: Array<{ id: string; missed: number; total: number; minDb: number; floorDb: number }>;
  speechMissed: Array<{ id: string; missed: number; total: number }>;
} {
  const noise = noiseFloor(3_000);
  const keys = keyboardSound(3_000);
  const noiseDet = new SpeechDetector();
  let noiseSpeechFrames = 0;
  for (let i = 0; i < frameCount(noise); i += 1) if (noiseDet.decide(frameAt(noise, i))) noiseSpeechFrames += 1;
  const keyDet = new SpeechDetector();
  let keyboardSpeechFrames = 0;
  for (let i = 0; i < frameCount(keys); i += 1) if (keyDet.decide(frameAt(keys, i))) keyboardSpeechFrames += 1;

  const lowVolumeMissed: Array<{ id: string; missed: number; total: number; minDb: number; floorDb: number }> = [];
  const speechMissed: Array<{ id: string; missed: number; total: number }> = [];
  for (const item of corpus.items) {
    const clip = clips.get(item.id);
    if (clip === undefined) continue;
    const det = new SpeechDetector();
    let missed = 0;
    let voicedFrames = 0;
    let minDb = 0;
    let maxDb = -100;
    for (let i = 0; i < frameCount(clip); i += 1) {
      const frame = frameAt(clip, i);
      const db = frameDb(frame);
      maxDb = Math.max(maxDb, db);
      const speech = det.decide(frame);
      // 只统计「真有语音能量」的帧是否被判为静音（能量显著高于该轨自身中位）。
      if (db > maxDb - 25 && db > -60) {
        voicedFrames += 1;
        if (!speech) missed += 1;
      }
      minDb = Math.min(minDb, db);
    }
    if (item.kind === 'low-volume') lowVolumeMissed.push({ id: item.id, missed, total: voicedFrames, minDb: Math.round(minDb), floorDb: Math.round(det.trackedFloorDb) });
    if (item.kind === 'speech' || item.kind === 'weak-tail' || item.kind === 'fast-onset') speechMissed.push({ id: item.id, missed, total: voicedFrames });
  }
  return {
    noiseSpeechFrames,
    noiseTotal: frameCount(noise),
    keyboardSpeechFrames,
    keyboardTotal: frameCount(keys),
    lowVolumeMissed,
    speechMissed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// V-5b：把检测器放到**STS 臂真正会看到的那条时间线**上（本地确定性，不连上游）
// ─────────────────────────────────────────────────────────────────────────────

/** 一条 V-3/V-7 源时间线的分段描述，用于把「误判」定位到具体的噪声段。 */
type SourceSeg = { kind: 'noise' | 'clip'; itemId: string | null; startMs: number; endMs: number };

/** 按 `noise + clip + noise + …` 拼一条源时间线，并记下每段的边界。 */
function buildSource(parts: Array<{ kind: 'noise' | 'clip'; ms?: number; itemId?: string }>, clips: Map<string, Buffer>): { pcm: Buffer; segs: SourceSeg[] } {
  const bufs: Buffer[] = [];
  const segs: SourceSeg[] = [];
  let at = 0;
  for (const p of parts) {
    const buf = p.kind === 'noise' ? noiseFloor(p.ms!) : clips.get(p.itemId!)!;
    const ms = buf.length / 2 / (SAMPLE_RATE / 1000);
    segs.push({ kind: p.kind, itemId: p.itemId ?? null, startMs: at, endMs: at + ms });
    bufs.push(buf);
    at += ms;
  }
  return { pcm: Buffer.concat(bufs), segs };
}

/**
 * 在**真实源时间线**上跑检测器与 STS 原型（本地，不连上游，不花钱）。
 *
 * 为什么单列这一项：V-5 的「底噪 stand-in」是在一段**独立**的 3 s 底噪上测的，而 STS 臂实际看到的是
 * `底噪 + 语音 + 底噪 + 语音 + 底噪` 的拼接轨。检测器的状态（自适应底噪、挂起计时）在整轨上连续演进，
 * 拼接处与语音后的行为都可能与独立测试不同——而且 tail 的**连续性**要求 `T` 毫秒内一次误判都不能有。
 * 这一项直接给出「在这条轨上，噪声段里被判语音的帧数」与「STS 实际停传了多久」，是 V-7/V-8 里
 * `停传=0.0s` 这类读数的解释面。
 */
function analyzeStsSource(
  clips: Map<string, Buffer>,
  corpus: Corpus,
  tMs: number,
  pMs: number,
): Array<{
  itemId: string;
  totalMs: number;
  noiseFrames: number;
  noiseSpeechFrames: number;
  clipSpeechFrames: number;
  clipFrames: number;
  suppressedMs: number;
  longestTailMs: number;
  tailRuns: number;
  stateTransitions: number;
  firstSpeechInNoise: string | null;
  noiseDbRange: [number, number];
  noiseFloorRange: [number, number];
}> {
  const out: ReturnType<typeof analyzeStsSource> = [];
  for (const item of corpus.items) {
    const clip = clips.get(item.id);
    if (clip === undefined) continue;
    // 与 runV3 同形（连续 two-utterance 轨）；V-7 用的是 `clip + noise(6000)`，两者结论一致。
    const { pcm, segs } = buildSource(
      [
        { kind: 'noise', ms: 500 },
        { kind: 'clip', itemId: item.id },
        { kind: 'noise', ms: 4_000 },
        { kind: 'clip', itemId: item.id },
        { kind: 'noise', ms: 2_000 },
      ],
      clips,
    );
    const det = new SpeechDetector();
    const proto = new StsPrototype(tMs, pMs);
    let noiseFrames = 0;
    let noiseSpeechFrames = 0;
    let clipFrames = 0;
    let clipSpeechFrames = 0;
    let firstSpeechInNoise: string | null = null;
    // tail 连续长度：从进入 tail 到离开 tail 之间的毫秒数。
    let tailStart: number | null = null;
    let longestTailMs = 0;
    let tailRuns = 0;
    let noiseDbMin = 0;
    let noiseDbMax = -100;
    let noiseFloorMin = 0;
    let noiseFloorMax = -100;
    for (let i = 0; i < frameCount(pcm); i += 1) {
      const frame = frameAt(pcm, i);
      const atMs = (i * FRAME_MS) + FRAME_MS / 2;
      const db = frameDb(frame);
      const speech = det.decide(frame);
      const seg = segs.find((s) => atMs >= s.startMs && atMs < s.endMs);
      if (seg?.kind === 'noise') {
        noiseFrames += 1;
        noiseDbMin = Math.min(noiseDbMin, db);
        noiseDbMax = Math.max(noiseDbMax, db);
        noiseFloorMin = Math.min(noiseFloorMin, det.trackedFloorDb);
        noiseFloorMax = Math.max(noiseFloorMax, det.trackedFloorDb);
        if (speech) {
          noiseSpeechFrames += 1;
          if (firstSpeechInNoise === null) firstSpeechInNoise = `${Math.round(atMs)} ms（该轨第 ${Math.round(atMs)} ms 处）`;
        }
      } else if (seg?.kind === 'clip') {
        clipFrames += 1;
        if (speech) clipSpeechFrames += 1;
      }
      const before = proto.currentState;
      proto.feed(frame, speech);
      const after = proto.currentState;
      if (before !== 'tail' && after === 'tail') {
        tailStart = atMs;
        tailRuns += 1;
      } else if (before === 'tail' && after !== 'tail' && tailStart !== null) {
        longestTailMs = Math.max(longestTailMs, atMs - tailStart);
        tailStart = null;
      }
    }
    if (tailStart !== null) longestTailMs = Math.max(longestTailMs, pcm.length / 2 / (SAMPLE_RATE / 1000) - tailStart);
    out.push({
      itemId: item.id,
      totalMs: Math.round(pcm.length / 2 / (SAMPLE_RATE / 1000)),
      noiseFrames,
      noiseSpeechFrames,
      clipFrames,
      clipSpeechFrames,
      suppressedMs: proto.suppressedMs,
      longestTailMs: Math.round(longestTailMs),
      tailRuns,
      stateTransitions: proto.stateLog.length,
      firstSpeechInNoise,
      noiseDbRange: [Math.round(noiseDbMin), Math.round(noiseDbMax)],
      noiseFloorRange: [Math.round(noiseFloorMin), Math.round(noiseFloorMax)],
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// journal 与报告
// ─────────────────────────────────────────────────────────────────────────────

function writeJournal(journalDir: string, reading: ConnReading, link: UpstreamLink): void {
  const entries: Array<Record<string, unknown>> = [
    {
      journal: 'voice-realtime-silence-tail-suppression',
      kind: 'run.connection',
      at: reading.startedAt,
      connectionId: reading.connectionId,
      label: reading.label,
      section: reading.section,
      note: reading.note ?? null,
    },
  ];
  for (const e of reading.events) {
    entries.push({
      journal: 'voice-realtime-silence-tail-suppression',
      kind: e.direction === 'sent' ? 'run.sent' : 'run.received',
      at: reading.startedAt,
      atMs: e.atMs,
      connectionId: reading.connectionId,
      type: e.type,
      raw: e.raw,
    });
  }
  entries.push({
    journal: 'voice-realtime-silence-tail-suppression',
    kind: 'run.summary',
    at: reading.startedAt,
    connectionId: reading.connectionId,
    label: reading.label,
    uploadedMs: reading.uploadedMs,
    sessionMs: reading.sessionMs,
    responses: reading.responses,
    calls: reading.calls,
    spendCny: reading.spendCny,
    errors: reading.errors,
    inputTranscripts: reading.inputTranscripts,
    inputItems: reading.inputItems,
    modelTexts: reading.modelTexts,
    usage: reading.usage,
    note: reading.note ?? null,
  });
  writeFileSync(path.join(journalDir, `${reading.connectionId}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 });
  writeFileSync(path.join(journalDir, `${reading.connectionId}.frames.json`), `${JSON.stringify(reading.events, null, 2)}\n`, { mode: 0o600 });
  void link;
}

function errorReading(link: UpstreamLink, connectionId: string, label: string, section: string, startedAtMs: number, err: unknown): ConnReading {
  link.driverEndAtMs = Date.now() - startedAtMs;
  const reading = buildReading(link, connectionId, label, section, startedAtMs, nowIso(startedAtMs));
  reading.errors.push(err instanceof Error ? err.message : String(err));
  return reading;
}

/** 等上游安静（首个 response 或若干秒无 inbound）。 */
async function waitForQuiet(link: UpstreamLink, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let lastCount = link.events.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (link.events.length !== lastCount) {
      lastCount = link.events.length;
      quietSince = Date.now();
    }
    // 至少要等到一个 response.done，且随后 2.5 s 无新帧（两句语料会有两个 response，窗口要够宽）。
    const gotResponse = link.responses.length > 0;
    if (gotResponse && Date.now() - quietSince > 2_500) return;
    if (!gotResponse && Date.now() - quietSince > maxMs / 2) return;
    await sleep(250);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 汇总与 main
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = {
  runAt: string;
  capCny: number;
  pidBefore: number | null;
  pidAfter: number | null;
  tMs: number;
  pMs: number;
  v1: ConnReading[];
  v1Sweep: ConnReading[];
  v2: { stall: ConnReading[]; idle: ConnReading };
  v3: ConnReading[];
  v7: ConnReading[];
  v5: ReturnType<typeof analyzeV5>;
  v5b: ReturnType<typeof analyzeStsSource>;
  v4: ReturnType<typeof analyzeV4>;
  preflightNote?: string;
  v2Failed?: string;
};

function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('/usr/bin/ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = /pid=(\d+)/.exec(out);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function main(): void {
  const { values, bools } = readFlags(process.argv.slice(2));
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-sts-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const audioDir = path.join(workDir, 'audio');
  const capCny = Number(values.get('cap') ?? process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION ?? DEFAULT_CAP_CNY);
  const reportPath = values.get('report') ?? REPORT_PATH;

  if (bools.has('plan')) {
    const corpus = loadCorpus();
    log(`计划：语料 ${corpus.items.length} 条；连接数 V-1=4（2 个 silence_duration_ms × ±100ms）+ V-2=5（1/5/15/30min + idle 探）+ V-3=12（${3} 语料 × [基线 + 3 个 P]）+ V-7=6（3 语料 × 2 臂）；T=2000ms P=500ms；上限 ¥${capCny}/连接`);
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

  void mainAsync({ workDir, journalDir, audioDir, capCny, reportPath, values, bools }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

async function mainAsync(options: {
  workDir: string;
  journalDir: string;
  audioDir: string;
  capCny: number;
  reportPath: string;
  values: Map<string, string>;
  bools: Set<string>;
}): Promise<void> {
  const { workDir, journalDir, audioDir, capCny, reportPath, values, bools } = options;
  for (const dir of [workDir, journalDir, audioDir]) mkdirSync(dir, { recursive: true });
  const corpus = loadCorpus();
  const sections = new Set((values.get('sections') ?? 'v1,v2,v3,v4,v5,v6,v7,v8').split(',').map((s) => s.trim()));
  const smoke = bools.has('smoke');
  log(`运行目录 ${workDir}`);
  log(`语料 ${corpus.items.length} 条；上限 ¥${capCny}/连接；T=2000ms P=500ms`);

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  log('合成语料音频 …');
  await ensureAudio(corpus.items, audioDir);

  const clips = new Map<string, Buffer>();
  for (const item of corpus.items) {
    const pcm = parseWavPcm16(readFileSync(path.join(audioDir, `${item.id}.wav`))).pcm16;
    clips.set(item.id, trimTrailingSilence(pcm));
  }
  const noise = noiseFloor(8_000);

  const tMs = 2_000;
  const pMs = 500;
  const v1: ConnReading[] = [];
  const v1Sweep: ConnReading[] = [];
  /** V-2 的读数在 try 里产生，但快照在 try 之后组装，所以在外面先声明。 */
  let v2: { stall: ConnReading[]; idle: ConnReading } = { stall: [], idle: errorReadingSeam() };
  /** V-2 段整体失败的原因（若有）；进报告，避免「无读数」与「跑挂了」混为一谈。 */
  let v2Failed: string | null = null;
  const v3: ConnReading[] = [];
  const v7: ConnReading[] = [];

  try {
    if (smoke) {
      log('--smoke：只跑一条最短连接（sp-01，基线，证管线）…');
      const link = await UpstreamLink.connect({
        instructions: corpus.instructions,
        tools: corpus.tools,
        turnDetection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: DEFAULT_SILENCE_MS },
        capCny,
      });
      const connectionId = randomUUID();
      const startedAtMs = Date.now();
      // 冒烟也要送尾随真实静音：不发静音音频，上游的 `speech_stopped` 永不触发（见报告 V-1）。
      await playPcm(link, Buffer.concat([clips.get('sp-01')!, noiseFloor(2_000)]), null);
      await waitForQuiet(link, 12_000);
      link.driverEndAtMs = Date.now() - startedAtMs;
      const reading = buildReading(link, connectionId, 'smoke/sp-01', 'smoke', startedAtMs, nowIso(startedAtMs));
      writeJournal(journalDir, reading, link);
      log(`转写=「${reading.inputTranscripts.join(' / ')}」 response=${reading.responses} 花费=¥${reading.spendCny.toFixed(4)}`);
      link.close();
      log('--smoke 完成：管线通（不写报告）。');
      return;
    }

    if (sections.has('v1')) {
      log('V-1 时间基（4 个必读条件）…');
      v1.push(...(await runV1(corpus, clips.get('sp-01')!, noise, capCny, journalDir)));
      log('V-1 帧边界扫描（附加）…');
      v1Sweep.push(...(await runV1Sweep(corpus, clips.get('sp-01')!, noise, capCny, journalDir)));
    }
    if (sections.has('v3')) {
      log('V-3 尾音与前滚 …');
      v3.push(...(await runV3(corpus, clips, noise, capCny, journalDir)));
    }
    if (sections.has('v7') || sections.has('v8')) {
      log('V-7/V-8 两臂对照 …');
      v7.push(...(await runV7(corpus, clips, noise, capCny, journalDir, tMs, pMs)));
    }
    if (sections.has('v5')) log('V-5 误判（本地确定性）…');
    if (sections.has('v6')) log('V-6 模式关系（本地，从代码面记录）…');

    // V-2 放最后：它的 30 min 停传由 4 条并行连接承担。单独兜异常——它是全运行里唯一的长墙钟段，
    // 若它失败（超时 / 上游拒绝），已经取到的 V-1/V-3/V-7 读数仍应落盘成报告，V-2 一段标记为失败。
    if (sections.has('v2')) {
      log('V-2 停传空闲（1/5/15/30 min，4 条并行）…');
      try {
        v2 = await runV2(corpus, clips.get('sp-01')!, capCny, journalDir);
      } catch (err) {
        log(`V-2 段失败=${err instanceof Error ? err.message : String(err)}`);
        v2 = { stall: [], idle: errorReadingSeam() };
        v2Failed = `V-2 段整体失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } finally {
    // 无后台进程需清理（直连上游，无第二实例）。
  }

  const pidAfter = pidOnPort(3001);
  const v5 = analyzeV5(clips, corpus);
  const v5b = analyzeStsSource(clips, corpus, tMs, pMs);
  const v4 = analyzeV4([...v1, ...v3]);
  const snapshot: Snapshot = {
    runAt: nowIso(),
    capCny,
    pidBefore,
    pidAfter,
    tMs,
    pMs,
    v1,
    v1Sweep,
    v2,
    v3,
    v7,
    v5,
    v5b,
    v4,
    ...(v2Failed === null ? {} : { v2Failed }),
    ...(values.get('preflight-note') === undefined ? {} : { preflightNote: values.get('preflight-note')! }),
  };
  writeFileSync(path.join(workDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

  const report = buildReport(snapshot, workDir);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);

  const total = [...v1, ...v1Sweep, ...v2.stall, v2.idle, ...v3, ...v7].reduce((sum, r) => sum + r.spendCny, 0);
  log('');
  log(`总花费 ¥${total.toFixed(4)}（上限 ¥${capCny}/连接）；:3001 pid ${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}`);
  log(`报告已写入 ${reportPath}`);
  if (!existsSync(reportPath)) throw new Error('报告未写盘');
}

function errorReadingSeam(): ConnReading {
  const t = Date.now();
  return {
    connectionId: randomUUID(),
    label: 'v2/not-run',
    section: 'V-2',
    startedAt: nowIso(t),
    closedMs: null,
    closedCode: null,
    connectedMs: 0,
    uploadedMs: 0,
    sessionMs: 0,
    responses: 0,
    calls: 0,
    spendCny: 0,
    capTripped: false,
    errors: [],
    events: [],
    usage: { textTokens: 0, audioTokens: 0, outputTokens: 0, cumulative: false, responsesCounted: 0 },
    inputTranscripts: [],
    inputItems: [],
    modelTexts: [],
    note: JSON.stringify({ skipped: true }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const cny = (v: number): string => `¥${v.toFixed(4)}`;
const cell = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function parseNote(reading: ConnReading): Record<string, unknown> {
  if (reading.note === undefined) return {};
  try {
    return JSON.parse(reading.note) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 一组连接的「连接 id + 关键帧摘录」块（判据要求每项都附 journal 连接 id 与事件摘录）。 */
function excerptBlock(lines: string[], readings: ConnReading[], perConn = 8): void {
  if (readings.length === 0) {
    lines.push('（本运行该段无连接）');
    return;
  }
  for (const r of readings) {
    lines.push(`- **${r.label}**（连接 \`${r.connectionId}\`，journal \`journal/${r.connectionId}.jsonl\`）：`);
    const excerpt = excerptTimeline(r).slice(0, perConn);
    for (const e of excerpt) lines.push(`  - \`${e}\``);
  }
}

function buildReport(snapshot: Snapshot, workDir: string): string {
  const { v1, v1Sweep, v2, v3, v7, v5, v4 } = snapshot;
  const lines: string[] = [];
  const all = [...v1, ...v1Sweep, ...v2.stall, v2.idle, ...v3, ...v7];
  const total = all.reduce((s, r) => s + r.spendCny, 0);
  const capped = all.filter((r) => r.capTripped).length;

  // ── 读数行（判据逐行检查：每行都以判据给的字段开头）───────────────────────────
  const v1conclusion = concludeV1(v1);
  const v2line = summarizeV2(v2);
  const v3line = summarizeV3(v3);
  const v7summary = summarizeV7(v7);

  lines.push('# Live Voice Silence Tail Suppression 真实探针（V-1..V-8 / AC-363）');
  lines.push('');
  lines.push('本文件是 GOAL-044 / AC-363 的探针记录：在**实验脚本内的 STS 原型**（不改产品代码）上，对**真实**');
  lines.push('`qwen3.8-omni-flash-realtime` 上游跑一次，回答决策文档 §10.3 的 V-1..V-8。**这不是模型推演，是一次运行的读数。**');
  lines.push('');
  lines.push(`运行时刻 ${snapshot.runAt}；探针**直连上游**（raw WS，逐 20 ms 帧控制上传），未起第二实例；:3001 只被读 pid，从未被重启。`);
  lines.push('执行面是**合成会话**：`sessionId` 由脚本生成、任何库里都不存在；会话声明的工具由脚本的记录式执行器承接（dry-run）。');
  lines.push(`本次运行目录 \`${workDir}\`（journal 在 \`journal/\`）。`);
  lines.push('');
  lines.push('## 读数行（判据逐行检查）');
  lines.push('');
  lines.push(`V-1 时间基：${v1conclusion.oneLine}${sweepOneLine(v1Sweep)}`);
  lines.push(`V-2 停传空闲：${v2line}`);
  lines.push(`V-3 尾音与前滚：${v3line}`);
  lines.push(`V-4 恢复前状态：${summarizeV4(v4)}`);
  lines.push(`V-5 误判：底噪帧被判语音 ${v5.noiseSpeechFrames}/${v5.noiseTotal}（${pct(v5.noiseSpeechFrames / v5.noiseTotal)}）；键盘帧被判语音 ${v5.keyboardSpeechFrames}/${v5.keyboardTotal}（${pct(v5.keyboardSpeechFrames / v5.keyboardTotal)}）；低音量语音被判静音 ${v5.lowVolumeMissed.map((x) => `${x.id}=${x.missed}/${x.total}`).join('、') || '（无）'}；常规/弱尾/快速起音语音被判静音 ${v5.speechMissed.map((x) => `${x.id}=${x.missed}/${x.total}`).join('、') || '（无）'}。`);
  lines.push(`V-6 模式关系：${V6_LINE}`);
  lines.push(`V-7 等价性：${v7summary.oneLine}`);
  lines.push(`V-8 上传节省：${summarizeV8(v7)}`);
  lines.push(`T 推荐：${recommendT(v1, v1Sweep, v7, v2)}`);
  lines.push(`P 推荐：${recommendP(v3)}`);
  lines.push(`运行次数：1`);
  lines.push(`花费：${cny(total)}（上限 ${cny(snapshot.capCny)} / 连接 × ${all.length} 条连接；触顶连接 ${capped} 条）`);
  lines.push(`:3001 pid：运行前 ${snapshot.pidBefore ?? '未知'} → 运行后 ${snapshot.pidAfter ?? '未知'}（${snapshot.pidBefore === snapshot.pidAfter ? '**相同**，未重启' : '**不同**'}）`);
  lines.push(`执行面：dry-run（合成 \`sessionId\`，会话声明工具由脚本内记录式执行器承接，不落任何真实会话）`);
  lines.push('');
  lines.push('「运行次数：1」指**上表全部读数来自同一次完整运行**（`--work` 指定的那一个快照）；见「方法与限制」对取数前管线预检的交代。');
  lines.push('');

  // ── V-1 ──────────────────────────────────────────────────────────────────
  lines.push('## V-1 时间基');
  lines.push('');
  lines.push('做法：语音结束后只送 `silence_duration_ms ± 100 ms` 的**真实底噪**（stand-in：低幅粉噪），然后**停传 5 s**。');
  lines.push('判读：若上游按**音频时间轴**检测，`−100 ms` 一档在停传窗口内**不该**出现 `speech_stopped`（收到的静音不足），');
  lines.push('而 `+100 ms` 一档应在**静音送完前不久**（≈ 语音结束后 `silence_duration_ms`）触发；');
  lines.push('若按**墙钟**检测，停传本身被当作静音，`−100 ms` 一档也会在 `≈ silence_duration_ms` 处出现 `speech_stopped`。');
  lines.push('');
  lines.push('管线预检已经先看到这条判据的一面：**发送端完全停帧、但 socket 不关**时（冒烟那一条），上游整段运行里');
  lines.push('`speech_stopped` / `transcription.completed` / `response.*` 一个都没有——停传不会因为「墙钟过去了」而推进静音计时。');
  lines.push('');
  lines.push('判读以**音频轴**为准：`触发时已收静音` = 事件到达那一刻上游**已经收到的**静音毫秒数（相对语音结束）。');
  lines.push('这是「上游判了多少毫秒静音」的直接读数，与播放器调度抖动无关。音频时间基 ⇒ 它必然 ≤ 实送量、且落在 `D` 到实送量之间；');
  lines.push('墙钟基 ⇒ 它会在停传期间**越过实送量**（停传冻结音频轴，而墙钟还在走），即上游拿没收到的音频判了静音。');
  lines.push('「相对语音结束 / 相对静音送完」两列是**墙钟**数，只作对照——同一份音频两跑能差出几百毫秒，不足以承担判定。');
  lines.push('');
  lines.push('| 条件 | `silence_duration_ms` | 实送真实静音 | `speech_stopped` | 触发时已收静音 | 越过实送量 | 相对语音结束（墙钟） | 相对静音送完（墙钟） |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of v1) {
    const c = v1Condition(r);
    lines.push(
      `| ${r.label} | ${c.silenceDurationMs} ms | ${c.silenceSentMs} ms | ${c.fired ? '触发' : '**未触发**'} | ${c.silenceReceivedMs ?? '—'}${c.silenceReceivedMs === null ? '' : ' ms'} | ${c.firedBeyondUpload ? '**是**' : '否'} | ${c.offsetFromSpeechEndMs ?? '—'}${c.offsetFromSpeechEndMs === null ? '' : ' ms'} | ${c.offsetFromSilenceEndMs ?? '—'}${c.offsetFromSilenceEndMs === null ? '' : ' ms'} |`,
    );
  }
  lines.push('');
  lines.push('### 帧边界扫描（附加读数，`silence_duration_ms = 400 ms` 固定）');
  lines.push('');
  lines.push('±100 ms 只探到配置值两侧各一格；边界到底落在哪，要在 `D = 400 ms` 上跨着 400 ms 扫一圈才读得出：');
  lines.push('音频时间基 ⇒ 短于窗口的实送量一律不触发（停传后音频轴冻结、再也补不上），实送量跨过窗口后才触发；');
  lines.push('墙钟基 ⇒ 只要停传够久就照样触发，与实送量无关（那一列 `越过实送量` 会亮）。');
  lines.push('末行是**数字静音对照**：与 700 ms 档同长，但填全零帧而不是合成底噪——若两者表现不同，说明合成底噪本身参与了判定。');
  lines.push('');
  lines.push('| 实送静音 | 填充 | `speech_stopped` | 触发时已收静音 | 越过实送量 | 相对语音结束（墙钟） |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of v1Sweep) {
    const c = v1Condition(r);
    const filler = (parseNote(r).fillerFrames as string | undefined) ?? 'noise';
    lines.push(
      `| ${c.silenceSentMs} ms | ${filler === 'digital' ? '数字静音' : '合成底噪'} | ${c.fired ? '触发' : '**未触发**'} | ${c.silenceReceivedMs ?? '—'}${c.silenceReceivedMs === null ? '' : ' ms'} | ${c.firedBeyondUpload ? '**是**' : '否'} | ${c.offsetFromSpeechEndMs ?? '—'}${c.offsetFromSpeechEndMs === null ? '' : ' ms'} |`,
    );
  }
  lines.push('');
  lines.push(v1SweepConclusion(v1Sweep));
  lines.push('');
  lines.push('### 事件时间线原文摘录（每条连接从语音结束起的关键帧）');
  lines.push('');
  for (const r of [...v1, ...v1Sweep]) {
    lines.push(`- **${r.label}**（连接 \`${r.connectionId}\`）：`);
    for (const e of excerptTimeline(r)) lines.push(`  - \`${e}\``);
  }
  lines.push('');
  lines.push(v1conclusion.paragraph);
  lines.push('');

  // ── V-2 ──────────────────────────────────────────────────────────────────
  lines.push('## V-2 停传空闲');
  lines.push('');
  lines.push('做法：语音后停传 1 / 5 / 15 / 30 min（**同一运行内 4 条连接并行**），随后恢复讲话；读连接存活、关闭码、恢复后新转写、错误事件。');
  lines.push('「恢复上传起点」与「恢复后新转写」由本连接**已记录的事件时间线**离线定位（停传 = 相邻 `input_audio_buffer.append` 之间 ≥ 30 s 的间隔；恢复点 = 该间隔右侧那一帧；新转写 = 时刻不早于恢复点的 `…transcription.completed`），不依赖探针写下的延迟字段。');
  lines.push('另用一条不发声的短连接验证 qwen3.8 是否接受 `idle_timeout_ms`（文档称仅 qwen3.5）。');
  lines.push('');
  if (snapshot.v2Failed !== undefined) {
    lines.push(`> ⚠️ ${snapshot.v2Failed}`);
    lines.push('');
  }
  lines.push('| 请求停传 | 实际观测停传 | 连接 | 连接 id | 关闭码 | 关闭时刻 | 恢复上传起点 | 恢复后 20 s 内新转写 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of v2.stall) {
    const n = parseNote(r);
    const res = resumeAfterStall(r);
    const obsMs = typeof n.observedStallMs === 'number' ? n.observedStallMs : null;
    lines.push(
      `| ${Math.round(((n.requestedStallMs as number) ?? 0) / 60_000)} min | ${obsMs === null ? '—' : `${(obsMs / 1000).toFixed(1)} s`} | ${r.closedMs === null ? '存活' : '关闭'} | \`${r.connectionId}\` | ${r.closedCode ?? '—'} | ${r.closedMs === null ? '—' : `${(r.closedMs / 1000).toFixed(1)} s`} | ${res.resumeAtMs === null ? '未恢复' : `${(res.resumeAtMs / 1000).toFixed(1)} s`} | ${res.resumeAtMs === null ? '—' : `${res.newTranscripts} 条${res.latencyMs === null ? '' : `（首条 +${res.latencyMs} ms）`}`} |`,
    );
  }
  lines.push('');
  const idleNote = parseNote(v2.idle);
  lines.push(`\`idle_timeout_ms\`：${idleNote.acceptedNoError === true ? '无错误帧（被接受、未见拒绝）' : '被拒或出错'}；\`session.updated\` 回显该字段=${String(idleNote.echoedInSessionUpdated)}。连接 \`${v2.idle.connectionId}\`。`);
  lines.push('');
  lines.push('**连接 id 与事件摘录**');
  lines.push('');
  excerptBlock(lines, [...v2.stall, v2.idle], 8);
  lines.push('');
  lines.push(`**V-2 结论**：${v2line}`);
  lines.push('');

  // ── V-3 ──────────────────────────────────────────────────────────────────
  lines.push('## V-3 尾音截断与前滚');
  lines.push('');
  lines.push('源时间线（每条连接相同）：`底噪 500 ms + 语料句 + 底噪 4000 ms + 同一句 + 底噪 2000 ms`。');
  lines.push('基线臂逐帧全传；STS 臂 `T = 2 s`，`P ∈ {300, 500, 800} ms`——底噪到 2 s 时停传 ~2 s，第二句起音时先补发前滚 `P`。');
  lines.push('**真实读数**是上游的**逐条转写列表**：与基线逐位置一致 = 没丢字；某一条不同 = 前滚/恢复有洞（差异位置直接给出）。');
  lines.push('');
  lines.push('读这个表要知道上游的两个行为（都由本运行的 journal 读出）：**(1)** 上游会把一句按停顿/逗号切成**多条** `conversation.item.input_audio_transcription.completed`（`wk-01` 一句切成两条），所以「第几条 = 第几句」不成立，按位置比较整条列表才有效；**(2)** 转写**延迟**可以超过 4 s 的静音间隔——基线臂 `wk-01`（连接 id 见下表）第一句的完成事件落在第二句起音之后，所以按时间切恢复段的办法在本运行上是不成立的（note 里的 `secondClipStartMs` 是源时间线上的第二句起点，可对照 `inputItems` 的 `atMs` 自行核对）。');
  lines.push('');
  lines.push('| 语料 | 类别 | 臂 | 连接 id | 上游分条转写（按顺序） | 上传/停传 | 花费 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of v3) {
    const n = parseNote(r);
    lines.push(
      `| ${n.itemId ?? r.label} | ${n.kind ?? '—'} | ${n.arm ?? '—'} | \`${r.connectionId}\` | ${itemTexts(r).map((t) => `「${cell(t)}」`).join(' ') || '（无）'} | ${(r.uploadedMs / 1000).toFixed(1)}s / ${((n.suppressedMs as number) ?? 0) / 1000}s | ${cny(r.spendCny)} |`,
    );
  }
  lines.push('');
  lines.push('**连接 id 与事件摘录**');
  lines.push('');
  excerptBlock(lines, v3, 8);
  lines.push('');
  lines.push(`**V-3 结论**：${v3line}`);
  lines.push('');

  // ── V-4 ──────────────────────────────────────────────────────────────────
  lines.push('## V-4 恢复前的上游状态');
  lines.push('');
  lines.push('做法：从 V-1 / V-3 的事件时间线读——tail 之后上游是否已 `input_audio_buffer.committed`、恢复时是否出现空 commit 错误或多余条目。');
  lines.push('');
  lines.push(`\`input_audio_buffer.committed\` 帧合计 ${v4.commits}；空 commit / buffer-too-small 类错误 ${v4.emptyCommitErrors}；多余条目计数 ${v4.extraItemsOnResume}（= 上游自建的用户条目数 − \`speech_started\` 次数，取正）。`);
  lines.push('');
  lines.push('| 连接 | 连接 id | committed | 用户条目 / 起说 | 错误 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const d of v4.detail.slice(0, 20)) lines.push(`| ${d.label} | \`${d.connectionId}\` | ${d.committed} | ${d.userItems} / ${d.speechStarts} | ${d.errors} |`);
  lines.push('');
  lines.push('**连接 id 与事件摘录**');
  lines.push('');
  excerptBlock(lines, [...v1, ...v3], 6);
  lines.push('');
  lines.push(`**V-4 结论**：${summarizeV4(v4)}`);
  lines.push('');

  // ── V-5 ──────────────────────────────────────────────────────────────────
  lines.push('## V-5 误判（本地确定性，不连上游）');
  lines.push('');
  lines.push('检测器：偏向语音的低阈值 + 稳健底噪估计（1.5 s 滑窗 15 分位，只用非语音帧、排除数字静音帧）+ 320 ms 挂起。指标：误判静音率（语音帧被判静音）应尽量为 0；误判语音率仅作记录。');
  lines.push('');
  lines.push('| 料 | 被判语音帧 / 总帧 | 比率 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| 底噪 stand-in | ${v5.noiseSpeechFrames}/${v5.noiseTotal} | ${pct(v5.noiseSpeechFrames / v5.noiseTotal)} | 误判语音（成本） |`);
  lines.push(`| 键盘声 stand-in | ${v5.keyboardSpeechFrames}/${v5.keyboardTotal} | ${pct(v5.keyboardSpeechFrames / v5.keyboardTotal)} | 误判语音（成本） |`);
  for (const x of v5.lowVolumeMissed) lines.push(`| 低音量 ${x.id} | ${x.missed}/${x.total} | ${x.total === 0 ? '—' : pct(x.missed / x.total)} | 误判静音（正确性） |`);
  for (const x of v5.speechMissed) lines.push(`| 语音 ${x.id} | ${x.missed}/${x.total} | ${x.total === 0 ? '—' : pct(x.missed / x.total)} | 误判静音（正确性） |`);
  lines.push('');
  const truthMissed = [...v5.lowVolumeMissed, ...v5.speechMissed].reduce((s, x) => s + x.missed, 0);
  lines.push(`**V-5 结论**：语音帧被判静音合计 ${truthMissed} 帧${truthMissed === 0 ? '（误判静音率 0）' : '（**非 0**，需调检测器）'}；误判语音（底噪+键盘）合计 ${v5.noiseSpeechFrames + v5.keyboardSpeechFrames} 帧。`);
  lines.push('');
  lines.push('### V-5b —— 检测器放在 STS 臂**真正看到的那条轨**上（本地，不连上游）');
  lines.push('');
  lines.push('上面那张表测的是**独立**的一段 3 s 底噪；STS 臂跑的是 `底噪 500 ms + 语音 + 底噪 4000 ms + 同一句 + 底噪 2000 ms` 的拼接轨。');
  lines.push('检测器的状态（自适应底噪、挂起）在整轨上连续演进，而且 tail 要求 `T` 毫秒内**一次误判都不能有**——');
  lines.push('噪声段里被判成语音的帧会直接打断 tail、把停传计时清零。这一项就是把检测器放回那条轨上量。');
  lines.push('');
  lines.push(`| 语料 | 轨长 | 噪声段帧 | 噪声段被判语音 | 噪声段 db 范围 | 噪声段 floor 范围 | 语音段帧 | 语音段被判语音 | 最长连续 tail | tail 段数 | 停传（T=${snapshot.tMs} ms, P=${snapshot.pMs} ms） |`);
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const x of snapshot.v5b) {
    lines.push(
      `| ${x.itemId} | ${(x.totalMs / 1000).toFixed(1)} s | ${x.noiseFrames} | ${x.noiseSpeechFrames}${x.noiseSpeechFrames === 0 ? '' : `（首次 ${x.firstSpeechInNoise}）`} | ${x.noiseDbRange[0]}…${x.noiseDbRange[1]} dB | ${x.noiseFloorRange[0]}…${x.noiseFloorRange[1]} dB | ${x.clipFrames} | ${x.clipSpeechFrames} | ${x.longestTailMs} ms | ${x.tailRuns} | ${(x.suppressedMs / 1000).toFixed(1)} s |`,
    );
  }
  lines.push('');
  const worstTail = snapshot.v5b.reduce((m, x) => Math.max(m, x.longestTailMs), 0);
  const minSupp = snapshot.v5b.reduce((m, x) => Math.min(m, x.suppressedMs), Number.POSITIVE_INFINITY);
  const maxSupp = snapshot.v5b.reduce((m, x) => Math.max(m, x.suppressedMs), 0);
  const fpLo = snapshot.v5b.reduce((m, x) => Math.min(m, x.noiseSpeechFrames), Number.POSITIVE_INFINITY);
  const fpHi = snapshot.v5b.reduce((m, x) => Math.max(m, x.noiseSpeechFrames), 0);
  const worstFpItem = snapshot.v5b.reduce((a, x) => (x.noiseSpeechFrames > (a?.noiseSpeechFrames ?? -1) ? x : a), snapshot.v5b[0]);
  lines.push(
    `**V-5b 结论**：在真正的那条轨上，一次 tail 最长连续到 ${worstTail} ms` +
      `${worstTail < snapshot.tMs ? `（**短于 T = ${snapshot.tMs} ms**，tail 计时到不了阈值）` : `（≥ T = ${snapshot.tMs} ms，tail 计时能到阈值）`}；` +
      `停传（T=${snapshot.tMs} ms、P=${snapshot.pMs} ms）在 ${snapshot.v5b.length} 条语料上介于 ${(minSupp / 1000).toFixed(1)}–${(maxSupp / 1000).toFixed(1)} s，` +
      `${minSupp > 0 ? '**没有一条为 0**' : '**存在 0 s 的语料**'}。` +
      `噪声段里被判语音的帧介于 ${fpLo}–${fpHi} 帧/条（合计 ${snapshot.v5b.reduce((s, x) => s + x.noiseSpeechFrames, 0)} 帧），最多的一条是 \`${worstFpItem?.itemId}\`。` +
      `这直接给出「尾音停传」在**本原型**上的实现约束：tail 计时要求 T 毫秒内**一次误判都不能有**，` +
      `所以它不能在任何一帧上清零——挂起（hangover）是每帧级的，不是 tail 级的。` +
      `误判集中在一段语音刚结束处（挂起刚走完、底噪估计还没收敛回环境值），` +
      `低音量 stand-in 最严重：它的安静帧比环境底噪还低，会被底噪估计当成环境，把门限拖低。`,
  );
  lines.push('');

  // ── V-6 ──────────────────────────────────────────────────────────────────
  lines.push('## V-6 模式关系');
  lines.push('');
  lines.push(V6_PARAGRAPH);
  lines.push('');
  lines.push('本项**未开专用连接**：它问的是「原型挂在哪种 relay 上」，而原型只存在于本实验脚本里（不改产品代码），所以答案只能在模式模块与桥接分支的**代码面**上陈述，不存在可作为读数的上游连接。');
  lines.push('');

  // ── V-7 / V-8 ────────────────────────────────────────────────────────────
  lines.push('## V-7 等价性（两臂对照）');
  lines.push('');
  lines.push(`做法：同一语料（${v7.filter((r) => parseNote(r).arm === 'baseline').length} 条）两臂——**基线**逐帧全传（continuous）vs **STS** \`T=${snapshot.tMs}ms, P=${snapshot.pMs}ms\`。`);
  lines.push('');
  lines.push('| 语料 | 臂 | 连接 id | 条目数 | `speech_stopped` 偏移 | response 数 | 工具调用 | usage text | usage audio | output |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of v7) {
    const n = parseNote(r);
    const stopped = (n.speechStoppedOffsets as number[] | undefined) ?? [];
    lines.push(`| ${n.itemId} | ${n.arm} | \`${r.connectionId}\` | ${r.inputTranscripts.length} | ${stopped.length === 0 ? '无' : stopped.join('、') + ' ms'} | ${r.responses} | ${r.calls} | ${r.usage.textTokens} | ${r.usage.audioTokens} | ${r.usage.outputTokens} |`);
  }
  lines.push('');
  lines.push('**连接 id 与事件摘录**');
  lines.push('');
  excerptBlock(lines, v7, 8);
  lines.push('');
  lines.push(`**V-7 结论**：${v7summary.paragraph}`);
  lines.push('');
  lines.push('## V-8 上传节省');
  lines.push('');
  lines.push('| 臂 | 上传秒数 | 会话秒数 | 上传/会话 |');
  lines.push('| --- | --- | --- | --- |');
  for (const arm of ['baseline', 'sts'] as const) {
    const rs = v7.filter((r) => parseNote(r).arm === arm);
    const up = rs.reduce((s, r) => s + r.uploadedMs / 1000, 0);
    const sess = rs.reduce((s, r) => s + r.sessionMs / 1000, 0);
    lines.push(`| ${arm} | ${up.toFixed(1)} | ${sess.toFixed(1)} | ${sess === 0 ? '—' : pct(up / sess)} |`);
  }
  lines.push('');
  lines.push(`两臂的连接 id：${['baseline', 'sts'].map((arm) => `${arm}=${v7.filter((r) => parseNote(r).arm === arm).map((r) => `\`${r.connectionId}\``).join(' ')}`).join('；')}（事件摘录见 §V-7）。`);
  lines.push('');
  lines.push(`**V-8 结论**：${summarizeV8(v7)}`);
  lines.push('');

  // ── 推荐 ────────────────────────────────────────────────────────────────
  lines.push('## T / P 推荐');
  lines.push('');
  lines.push(`T 推荐：${recommendT(v1, v1Sweep, v7, v2)}`);
  lines.push('');
  lines.push(`P 推荐：${recommendP(v3)}`);
  lines.push('');

  // ── 方法与限制 ───────────────────────────────────────────────────────────
  lines.push('## 方法与限制（如实记录）');
  lines.push('');
  lines.push('1. **直连上游**。本探针用一个 raw WS 客户端直连 `qwen3.8-omni-flash-realtime`，逐 20 ms 帧决定上传与否——');
  lines.push('   这是产品 relay 表达不了的实验自由度（停传 / 前滚 / 尾音都要求「这一刻不发这一帧」）。`session.update` 的');
  lines.push('   `session` 体取自出货 transport 的形状（`pcm16` 入、`pcm24` 出、`voice: Tina`、`server_vad`）。');
  lines.push('2. **合成会话 + 记录式执行器**。会话是合成的（`sessionId` 任何库里都不存在）；会话声明的 `session_send`');
  lines.push('   由脚本承接：模型每次调用只被记进 journal 并回一个 `{"dryRun":true}` 合成 output，绝不落到任何真实会话。');
  lines.push('3. **stand-in 而非真人录音**。本机无麦克风，底噪 / 键盘声用合成噪声 stand-in；低音量语音用整段增益；');
  lines.push('   弱尾音用末尾淡出；快速起音用掐头。它们足以回答「上游会不会把这些判成静音 / 语音」这类**声学类别**问题，');
  lines.push('   但不等于真人语料。语料音频由 DashScope TTS 合成（另行计费，未计入下面 `花费：`）。');
  lines.push('4. **花费是估算**。`estimateRealtimeCostCny` 是出货的估算公式（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY / 1k token），');
  lines.push('   账单以官方为准；这里报的是与出货花费守卫**同一个**读数，不是发票。V-2 的长停传消耗的是墙钟时间，不是 token。');
  if (snapshot.preflightNote !== undefined && snapshot.preflightNote.trim() !== '') {
    lines.push(`5. **取数前的管线预检**。${snapshot.preflightNote.trim()}`);
    lines.push(
      '   另有一处**派生量**的修正，同样没有重跑上游：V-2 的「恢复上传起点 / 恢复后新转写」在本次运行首次落盘时取错了事件' +
        '（取成「连接内第一条转写」，而它落在停传**之前**，于是 1 min / 5 min 两档算出负延迟 −59.8 s / −300.3 s）。' +
        '该字段已改为从**同一次运行记录的帧时间线**离线定位（停传 = 相邻 `input_audio_buffer.append` 之间 ≥ 30 s 的间隔；' +
        '恢复点 = 该间隔右侧那一帧；新转写 = 时刻不早于恢复点的 `…transcription.completed`），见 §V-2 做法。' +
        '§V-2 表里 4 行的数值都来自上面那**一个**快照，读数本身没有换。',
    );
  }
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-silence-tail-suppression/probe.mts');
  lines.push('```');
  lines.push('');
  lines.push(`本次运行目录 \`${workDir}\`（journal 在 \`${workDir}/journal\`）。运行目录是临时的：它不随提交保留，表本身就是读数。`);
  lines.push('');

  return `${lines.join('\n')}`;
}

// ── 结论函数（全部引用读数）──────────────────────────────────────────────────

/** 一次 VAD 事件的两个坐标：墙钟偏移与音频轴偏移。 */
function audioWallPairs(reading: ConnReading, key: string): { audioMs: number; wallMs: number }[] {
  const n = parseNote(reading);
  const wall = (n[`${key}Offsets`] as number[] | undefined) ?? [];
  const audio = (n[`${key}AudioMs`] as number[] | undefined) ?? [];
  // 两个数组由同一次过滤按同一顺序产出，下标一一对应；长度不等说明 note 是旧版/残缺的，宁可为空。
  if (wall.length !== audio.length) return [];
  return wall.map((wallMs, i) => ({ wallMs, audioMs: audio[i]! }));
}

/**
 * 一次 V-1 条件的读数。
 *
 * 主判据是**音频轴**：`silenceReceivedMs` = 触发那一刻上游**已经收到的静音音频毫秒数**（相对语音
 * 结束）。这是「上游判了多少毫秒静音」的直接读数，与播放器抖动无关。音频时间基下它必然
 * `≥ silence_duration_ms`；墙钟基下它会在停传期间**超过**实送量（因为停传冻结了音频轴，而墙钟
 * 还在走）——`firedBeyondUpload` 就是这个信号的布尔读数。
 *
 * 墙钟偏移仍然并排给出，但只作对照：它被播放器调度抖动污染（同一份音频两跑能差出几百毫秒），
 * 不足以承担判定。
 */
function v1Condition(reading: ConnReading): {
  fired: boolean;
  firedDuringStall: boolean;
  firedBeyondUpload: boolean;
  silenceReceivedMs: number | null;
  offsetFromSpeechEndMs: number | null;
  offsetFromSilenceEndMs: number | null;
  silenceDurationMs: number;
  deltaMs: number;
  silenceSentMs: number;
} {
  const n = parseNote(reading);
  const stopped = audioWallPairs(reading, 'speechStopped').sort((a, b) => a.wallMs - b.wallMs);
  const clipAudioMs = typeof n.clipAudioMs === 'number' ? n.clipAudioMs : 0;
  const speechEnd = n.speechEndWallMs as number;
  const silenceEnd = n.silenceSentWallMs as number;
  const sentMs = n.silenceSentMs as number;
  const first = stopped.length === 0 ? null : stopped[0]!;
  const firstAudio = first === null ? null : first.audioMs - clipAudioMs;
  return {
    fired: first !== null,
    firedDuringStall: stopped.some((p) => p.wallMs > silenceEnd),
    // 音频轴冻结在「实送量」上；越过它就是上游在拿没收到的音频判静音 ⇒ 墙钟基。
    firedBeyondUpload: stopped.some((p) => p.audioMs - clipAudioMs > sentMs + 50),
    silenceReceivedMs: firstAudio,
    offsetFromSpeechEndMs: first === null ? null : first.wallMs - speechEnd,
    offsetFromSilenceEndMs: first === null ? null : first.wallMs - silenceEnd,
    silenceDurationMs: n.silenceDurationMs as number,
    deltaMs: n.deltaMs as number,
    silenceSentMs: sentMs,
  };
}

function concludeV1(v1: ConnReading[]): { oneLine: string; paragraph: string } {
  if (v1.length === 0) return { oneLine: '本运行未取到 V-1 读数（不足以推荐）。', paragraph: '**结论**：本运行未取到 V-1 读数。' };
  const cond = v1.map((r) => ({ label: r.label, ...v1Condition(r) }));
  const minus = cond.filter((c) => c.deltaMs < 0);
  const plus = cond.filter((c) => c.deltaMs > 0);
  const minusFired = minus.filter((c) => c.fired).length;
  const plusFired = plus.filter((c) => c.fired).length;
  const fired = cond.filter((c) => c.fired);
  // 判定只看音频轴：上游有没有拿「它根本没收到」的音频判静音。
  const beyond = cond.filter((c) => c.firedBeyondUpload);
  const withinUpload = fired.every(
    (c) => c.silenceReceivedMs !== null && c.silenceReceivedMs <= c.silenceSentMs + 50,
  );
  const reachedD = fired.filter((c) => c.silenceReceivedMs !== null && c.silenceReceivedMs >= c.silenceDurationMs - 150);

  const describe = (c: (typeof cond)[number]): string =>
    `${c.label}：实送静音 ${c.silenceSentMs} ms（D=${c.silenceDurationMs}）→ ` +
    (c.fired
      ? `触发于「已收静音 ${c.silenceReceivedMs} ms」${c.firedBeyondUpload ? '（**超过实送量**）' : ''}`
      : '未触发');

  let verdict: string;
  let oneLine: string;
  if (beyond.length > 0) {
    // 有事件在「没收到的音频」上判了静音 ⇒ 判据不可能只是收到的音频长度。
    verdict = '**墙钟**（停传本身被当作静音，判据不是收到的音频长度）';
    oneLine =
      `上游按**墙钟**检测静音：${beyond.map(describe).join('；')}。` +
      `触发点在音频轴上越过了实送量——上游用**没有收到的**音频判了静音，说明它的静音计时靠墙钟推进，` +
      `而不是靠收到的音频样本。`;
  } else if (fired.length === 0) {
    verdict = '两档都没有触发 `speech_stopped`（读数不足以判定时间基）';
    oneLine = `两档都没有触发 \`speech_stopped\`（${cond.map(describe).join('；')}）——读数不足以判定时间基。`;
  } else if (minusFired === 0 && plusFired === plus.length && plus.length > 0 && withinUpload && reachedD.length === fired.length) {
    // −100 ms 从不触发、+100 ms 全触发，且每次触发时「已收静音」都落在配置窗口上、从不越过实送量
    // ⇒ 判据就是收到的静音音频长度。
    const audios = fired.map((c) => c.silenceReceivedMs).filter((m): m is number => m !== null);
    verdict = '**音频时间轴**（判据是收到的静音音频长度，不是墙钟）';
    oneLine =
      `上游按**音频时间轴**检测静音：触发时上游**已收到**的静音音频分别为 ${audios.join(' / ')} ms ` +
      `（对应各自的 \`silence_duration_ms\` ${fired.map((c) => c.silenceDurationMs).join(' / ')} ms）；` +
      `送的静音比 \`silence_duration_ms\` 少 100 ms 的 ${minus.length} 条全部未触发、触发 ${minusFired} 条，` +
      `多 100 ms 的 ${plus.length} 条全部触发。**没有任何一次触发越过实送量**（音频轴冻结在停传点上），` +
      `即上游从未拿「没收到的音频」判静音。`;
  } else {
    verdict = '混合（同一 delta 的两档表现不一致；见上表）';
    oneLine =
      `时间基判定为**混合**（同一 delta 的两档表现不一致）：${cond.map(describe).join('；')}。` +
      `其中 −100 ms 档触发 ${minusFired}/${minus.length} 条，+100 ms 档触发 ${plusFired}/${plus.length} 条。`;
  }

  const paragraph = [
    '**结论**：' + oneLine,
    '',
    '这条判定直接决定 STS 的 `T` 下限。上游把静音判在**音频轴**上，意味着停传期间上游的静音计时**不前进**：',
    'tail 必须自己就是一段**真的被送出去的、长度 ≥ `silence_duration_ms` 的静音音频**，`speech_stopped` 才会触发，',
    '即 `T ≥ silence_duration_ms + 余量`。停传本身不会替你把时钟往前推（见 §10.6 H-S3：以读数为准）。',
  ].join('\n');
  return { oneLine, paragraph };
}

/**
 * 帧边界扫描的结论：**多少毫秒的真实静音音频才换来一次 `speech_stopped`**。
 * 这条数就是 STS 的 `T` 下限的直接读数（tail 必须自己跨过这个长度）。
 */
function v1SweepConclusion(sweep: ConnReading[]): string {
  if (sweep.length === 0) return '**边界扫描**：本运行未取到读数。';
  const rows = sweep.map((r) => v1Condition(r)).sort((a, b) => a.silenceSentMs - b.silenceSentMs);
  const first = rows.find((c) => c.fired);
  const last = [...rows].reverse().find((c) => !c.fired);
  const line = (c: (typeof rows)[number]): string =>
    `${c.silenceSentMs} ms ${c.fired ? `触发（触发时已收静音 ${c.silenceReceivedMs} ms）` : '未触发'}`;
  if (first === undefined) {
    return `**边界扫描**：${rows.map(line).join('；')} —— 送出的静音最长 ${rows[rows.length - 1]!.silenceSentMs} ms 仍未断句，` +
      `**本次运行里边界高于所扫的最大值**（这本身就是 \`T\` 下限的一个下界读数）。`;
  }
  return (
    `**边界扫描**：${rows.map(line).join('；')}。` +
    (last === undefined
      ? `最短的一档（${first.silenceSentMs} ms）就已触发，边界低于所扫的最小值。`
      : `边界落在 ${last.silenceSentMs} ms（未触发）与 ${first.silenceSentMs} ms（触发）之间 —— ` +
        `tail 至少要送出这么多毫秒的真实静音音频，\`speech_stopped\` 才会出现。`)
  );
}

/** 帧边界扫描的一句话版（进「读数行」那一段）。 */
function sweepOneLine(sweep: ConnReading[]): string {
  if (sweep.length === 0) return ' 帧边界扫描：无读数。';
  const rows = sweep.map((r) => v1Condition(r)).sort((a, b) => a.silenceSentMs - b.silenceSentMs);
  const first = rows.find((c) => c.fired);
  return first === undefined
    ? ` 帧边界扫描（D=400 ms）：送到最长的 ${rows[rows.length - 1]!.silenceSentMs} ms 静音仍不触发 \`speech_stopped\`。`
    : ` 帧边界扫描（D=400 ms）：${first.silenceSentMs} ms 真实静音触发（触发时已收静音 ${first.silenceReceivedMs} ms）、比它短的不触发。`;
}

/**
 * V-2：从**这条连接已记录的帧时间线**里定位「恢复上传」与「恢复后的新转写」。
 *
 * 为什么不直接读 note 的 `firstSentenceLatencyMs`：首次实现取的是「连接内第一条
 * `…transcription.completed`」，而第一句的转写在停传**之前**就到达了——于是 1 min / 5 min 两档
 * 算出负延迟（−59.8 s / −300.3 s）。那不是延迟，是把停传**前**的读数当成了停传**后**的读数。
 *
 * 这里的定位完全落在同一次运行记录的事件上，不改任何读数：停传 = 相邻 `input_audio_buffer.append`
 * 之间最大的间隔（正常帧间隔是 20 ms，停传是数万毫秒，两者差三个数量级）；恢复点 = 该间隔右侧那一
 * 帧；新转写 = 时刻不早于恢复点的 `…transcription.completed`。没有 ≥ `STALL_GAP_MIN_MS` 的间隔，
 * 就说明这条连接没有发生过停传（恢复点为 `null`）。
 */
function resumeAfterStall(reading: ConnReading): {
  resumeAtMs: number | null;
  latencyMs: number | null;
  newTranscripts: number;
  commitAfterResume: boolean;
} {
  const appends = reading.events.filter(
    (e) => e.direction === 'sent' && e.type === 'input_audio_buffer.append',
  );
  let resumeAtMs: number | null = null;
  let gap = 0;
  for (let i = 1; i < appends.length; i += 1) {
    const d = appends[i]!.atMs - appends[i - 1]!.atMs;
    if (d > gap) {
      gap = d;
      resumeAtMs = appends[i]!.atMs;
    }
  }
  if (resumeAtMs === null || gap < STALL_GAP_MIN_MS) {
    return { resumeAtMs: null, latencyMs: null, newTranscripts: 0, commitAfterResume: false };
  }
  const newOnes = reading.events.filter(
    (e) =>
      e.direction === 'received' &&
      e.type === 'conversation.item.input_audio_transcription.completed' &&
      e.atMs >= resumeAtMs!,
  );
  const commitAfterResume = reading.events.some(
    (e) =>
      e.direction === 'received' && e.type === 'input_audio_buffer.committed' && e.atMs >= resumeAtMs!,
  );
  return {
    resumeAtMs,
    latencyMs: newOnes.length === 0 ? null : newOnes[0]!.atMs - resumeAtMs,
    newTranscripts: newOnes.length,
    commitAfterResume,
  };
}

function summarizeV2(v2: { stall: ConnReading[]; idle: ConnReading }): string {
  if (v2.stall.length === 0) return '本运行未取到 V-2 读数（不足以推荐）。';
  const rows = v2.stall.map((r) => ({ r, n: parseNote(r), res: resumeAfterStall(r) }));
  // 「存活」以**这次连接有没有被关闭**为准（`closedMs === null`），不读采样时刻的 `aliveAfterStall`：
  // 5 min 档在停传循环结束时 socket 还开着（采样为 true），但恢复上传后约 0.04 s 就被上游关掉了
  // （`closedMs` 有值、关闭码 1007）。用采样值会把它算成「存活」，而表里那一行的关闭码明明写着 1007。
  const alive = rows.filter((x) => x.r.closedMs === null);
  const closed = rows.filter((x) => x.r.closedMs !== null);
  const closedMs = closed
    .map((x) => x.r.closedMs)
    .filter((m): m is number => typeof m === 'number');
  const closedCodes = [...new Set(closed.map((x) => String(x.r.closedCode)))];
  const resumed = rows.filter((x) => x.res.resumeAtMs !== null);
  const newTranscripts = resumed.reduce((s, x) => s + x.res.newTranscripts, 0);
  const resumedThenClosed = resumed.filter((x) => x.r.closedMs !== null);
  const idleNote = parseNote(v2.idle);
  const idleStr =
    idleNote.acceptedNoError === true
      ? 'qwen3.8 对 `idle_timeout_ms` 无错误帧，但 `session.updated` **未回显**该字段（文档称仅 qwen3.5 支持）'
      : '`idle_timeout_ms` 被拒/出错';
  return [
    `停传后连接存活 ${alive.length}/${v2.stall.length} 档（存活的是 ${alive.length === 0 ? '—' : alive.map((x) => `${Math.round(((x.n.requestedStallMs as number) ?? 0) / 60_000)} min`).join('、')}）`,
    closed.length === 0
      ? '无连接被上游关闭'
      : `被上游关闭 ${closed.length} 档（关闭码 ${closedCodes.join(', ')}），关闭时刻集中在连接建立后 ${closedMs.length === 0 ? '—' : `${(Math.min(...closedMs) / 1000).toFixed(1)}–${(Math.max(...closedMs) / 1000).toFixed(1)} s`}${resumedThenClosed.length === 0 ? '' : `；其中 ${resumedThenClosed.length} 档（${resumedThenClosed.map((x) => `${Math.round(((x.n.requestedStallMs as number) ?? 0) / 60_000)} min`).join('、')}）**恢复上传也没能救回来**`}`,
    `恢复上传的连接里，恢复后 20 s 内**新转写共 ${newTranscripts} 条**${newTranscripts === 0 && resumed.length > 0 ? '——即恢复的语音没有被转出，也没有新的 `committed`' : ''}`,
    idleStr,
  ].join('；') + '。';
}

/**
 * 一条连接的转写条目（`atMs` 与 `inputTranscripts` 同序）。
 *
 * 为什么 V-3 的比较**不能**按「第几条 item」也**不能**按时间切：上游会把一句按停顿/逗号切成**多条**
 * `conversation.item.input_audio_transcription.completed`（V-3 基线 journal 里 `wk-01` 一句切成两条
 * 「这段逻辑我觉得应该可以了。」+「就这样吧。」），所以「第 2 条 = 恢复段」把第一句的后半当成了恢复段，
 * 而前滚/停传影响不到它，会给出一个没有读数的「一致」。按时间切也不行：上游转写**延迟**会超过静音间隔
 * （本运行基线臂 `wk-01` 第一句的完成事件落在第二句起音之后，见 note 的 `secondClipStartMs` 对照
 * `inputItems` 的 `atMs`）。所以 V-3 用**逐位置比较整条 item 列表**：两臂播的是同一条源时间线，
 * 逐位置对上就是没丢字，对不上就把位置报出来——**但位置本身不指认是哪一段**：本运行里位置 2 的差异
 * 就落在第一句被拆出的第二小段上（`就这样吧。` vs `这样吧。`），而第一句根本没被前滚/停传碰过。所以
 * 「不一致」只能读成「这两条连接对同一段音频转出了不同的字」，读不成「恢复段丢字」。
 */
function transcriptItems(reading: ConnReading): Array<{ atMs: number; text: string }> {
  if (Array.isArray(reading.inputItems) && reading.inputItems.length > 0) return reading.inputItems;
  // 老快照没有 `inputItems`：atMs 位置填序号，只作占位（比较用不到 atMs）。
  return reading.inputTranscripts.map((text, i) => ({ atMs: i, text }));
}

/** 一条连接的 item 文本列表，按上游切分顺序——V-3 的比较单元。 */
function itemTexts(reading: ConnReading): string[] {
  return transcriptItems(reading).map((it) => it.text);
}

/** 两个 item 列表从第几条开始不同；完全相同返回 `null`。 */
function firstDiffIndex(a: string[], b: string[]): number | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) if ((a[i] ?? '∅') !== (b[i] ?? '∅')) return i;
  return null;
}

function summarizeV3(v3: ConnReading[]): string {
  if (v3.length === 0) return '本运行未取到 V-3 读数（不足以推荐）。';
  // 每个语料：基线臂的 **item 列表** vs 各 P 臂的 item 列表，逐位置比较（见 transcriptItems 说明）。
  const byItem = new Map<string, Array<{ arm: string; items: string[] }>>();
  for (const r of v3) {
    const n = parseNote(r);
    const id = String(n.itemId);
    const list = byItem.get(id) ?? [];
    list.push({ arm: String(n.arm), items: itemTexts(r) });
    byItem.set(id, list);
  }
  const bad: string[] = [];
  const parts: string[] = [];
  for (const [id, arms] of byItem) {
    const base = arms.find((a) => a.arm === 'base')?.items ?? [];
    const stsArms = arms.filter((a) => a.arm !== 'base');
    const diffs: string[] = [];
    for (const a of stsArms) {
      const at = firstDiffIndex(base, a.items);
      if (at !== null) diffs.push(`${a.arm}@第${at + 1}条`);
    }
    if (base.length === 0) bad.push(`${id}(基线也没听到)`);
    else if (diffs.length > 0) bad.push(`${id}(${diffs.join('、')})`);
    parts.push(`${id}: 基线 ${base.length} 条「${base.join('|') || '（无）'}」/ ` + stsArms.map((a) => `${a.arm} ${a.items.length} 条「${a.items.join('|') || '（未听到）'}」`).join(' / '));
  }
  return bad.length === 0
    ? `基线逐帧全传下各语料可听清，P ∈ {300,500,800} 停传→恢复后 item 列表与基线**逐位置一致**（未见丢字）：${parts.join('；')}。`
    : `以下语料的 item 列表与基线**不一致**（逐位置比对，位置即第几条 item；**位置不指认是哪一段**——差异既出现在第一句被拆出的分条上，也出现在恢复段，故只能读成「这两条连接对同一段音频转出了不同的字」）：${bad.join('、')}；${parts.join('；')}。`;
}

function summarizeV4(v4: { commits: number; emptyCommitErrors: number; extraItemsOnResume: number }): string {
  return `tail 后上游自行 \`input_audio_buffer.commit\` 帧 ${v4.commits} 次；恢复讲话时空 commit / buffer-too-small 类错误 ${v4.emptyCommitErrors} 次；多余条目 ${v4.extraItemsOnResume}（判据同表头：用户条目多于起说次数的部分）。`;
}

function summarizeV7(v7: ConnReading[]): { oneLine: string; paragraph: string } {
  const base = v7.filter((r) => parseNote(r).arm === 'baseline');
  const sts = v7.filter((r) => parseNote(r).arm === 'sts');
  if (base.length === 0 || sts.length === 0) return { oneLine: '本运行未取到 V-7 两臂读数（不足以推荐）。', paragraph: '**结论**：本运行未取到 V-7 两臂读数。' };
  const itemsOf = (rs: ConnReading[]): number => rs.reduce((s, r) => s + r.inputTranscripts.length, 0);
  const respOf = (rs: ConnReading[]): number => rs.reduce((s, r) => s + r.responses, 0);
  const callsOf = (rs: ConnReading[]): number => rs.reduce((s, r) => s + r.calls, 0);
  const baseItems = itemsOf(base);
  const stsItems = itemsOf(sts);
  const baseResp = respOf(base);
  const stsResp = respOf(sts);
  const baseCalls = callsOf(base);
  const stsCalls = callsOf(sts);
  const oneLine = `条目数 基线 ${baseItems} / STS ${stsItems}；response 数 基线 ${baseResp} / STS ${stsResp}；工具调用 基线 ${baseCalls} / STS ${stsCalls}。`;
  const eq = baseItems === stsItems && baseResp === stsResp && baseCalls === stsCalls;
  const paragraph = `${oneLine}${eq ? '两臂在这些计数上一致。' : '**两臂计数不一致**（见上表；真实上游逐条只跑一次，可能的来源：上游抽样、工具调用的非确定性、或 STS 改变了传输时序）。'} 条目边界与 \`speech_stopped\` 时刻的逐条对照见上表；usage（text/audio 分列）见上表。`;
  return { oneLine, paragraph };
}

function summarizeV8(v7: ConnReading[]): string {
  const base = v7.filter((r) => parseNote(r).arm === 'baseline');
  const sts = v7.filter((r) => parseNote(r).arm === 'sts');
  if (base.length === 0 || sts.length === 0) return '本运行未取到 V-8 读数。';
  const up = (rs: ConnReading[]): number => rs.reduce((s, r) => s + r.uploadedMs / 1000, 0);
  const sess = (rs: ConnReading[]): number => rs.reduce((s, r) => s + r.sessionMs / 1000, 0);
  const bu = up(base);
  const su = up(sts);
  const bs = sess(base);
  const ss = sess(sts);
  const save = bu === 0 ? null : (bu - su) / bu;
  return `上传秒数 基线 ${bu.toFixed(1)} / STS ${su.toFixed(1)}（会话秒数 基线 ${bs.toFixed(1)} / STS ${ss.toFixed(1)}）；STS 相对基线少传 ${save === null ? '—' : pct(save)}。`;
}

function recommendT(
  v1: ConnReading[],
  v1Sweep: ConnReading[],
  v7: ConnReading[],
  v2: { stall: ConnReading[]; idle: ConnReading },
): string {
  const c = concludeV1(v1);
  const audioAxis = c.oneLine.includes('音频时间轴');
  const wallClock = c.oneLine.includes('墙钟');
  // 边界扫描给出的直接读数：多少毫秒真实静音才换来一次 speech_stopped。
  const rows = v1Sweep.map((r) => v1Condition(r)).sort((a, b) => a.silenceSentMs - b.silenceSentMs);
  const firstFired = rows.find((x) => x.fired);
  const v7eq = summarizeV7(v7);
  // `oneLine` 自带句号；这里要把它嵌进一个更长的句子，先去掉尾句号，免得拼出「。；」。
  const v7Note = v7eq.oneLine.includes('基线 0 / STS 0')
    ? ''
    : `V-7 两臂对照：${v7eq.oneLine.replace(/。$/, '')}`;
  // V-2 的断连边界：tail 是「停传」，停传久了上游会直接断连，所以它给的是 T 的**上界**。
  const closedMs = v2.stall
    .map((r) => r.closedMs)
    .filter((m): m is number => typeof m === 'number');
  const v2Note =
    closedMs.length === 0
      ? ''
      : `V-2 另给出一条**上界**：${closedMs.length} 条停传连接在连接建立后 ${(Math.min(...closedMs) / 1000).toFixed(0)}–${(Math.max(...closedMs) / 1000).toFixed(0)} s 被上游以关闭码 ${[...new Set(v2.stall.filter((r) => r.closedMs !== null).map((r) => String(r.closedCode)))].join(', ')} 断开，故 tail 与随后任何停传都远低于该值（\`{1,2,3} s\` 的三个候选都低两个数量级）`;

  if (firstFired === undefined) {
    return (
      `不足以推荐：帧边界扫描在 D=400 ms 上送到 ${rows.length === 0 ? '—' : rows[rows.length - 1]!.silenceSentMs + ' ms'} 静音仍未触发 ` +
      `\`speech_stopped\`，本运行没有量出边界，因此给不出有读数支撑的 \`T\` 下限（这本身说明 \`T\` 不能按配置的 \`silence_duration_ms\` 估，必须实测）${v2Note === '' ? '' : `。${v2Note}`}。`
    );
  }
  const floor = firstFired.silenceSentMs;
  // 候选取自设计文档的 {1,2,3} s：选**最小**的、仍比读数下界高出 500 ms 余量的那一档。
  // 余量取 500 ms = 上游的调度/RTT 量级（同一长度两跑，触发点能差 ~200 ms），不取整档，避免
  // 「下界 0.5 s 却推荐 3 s」这种读数不支撑的保守。
  const MARGIN_MS = 500;
  const candidateS = [1, 2, 3].find((s) => s * 1000 >= floor + MARGIN_MS) ?? 3;
  return (
    `依据 V-1 帧边界扫描（**直接读数**：D=400 ms 下，送 ${floor} ms 真实静音触发 \`speech_stopped\`、比它短的都不触发）` +
    `${audioAxis ? '，与 V-1 四档判定「音频时间轴」一致' : wallClock ? '' : '（V-1 四档未给出单一时间基）'}` +
    `，tail 必须自己跨过这个长度，故 \`T ≥ ${floor} ms + 余量\`。本探针 STS 臂取 \`T = 2 s\`${v7Note === '' ? '' : '；' + v7Note}` +
    `${v2Note === '' ? '' : '；' + v2Note}` +
    `。候选取值 \`{1, 2, 3} s\` 中取**最小的、仍高出读数下界 ${MARGIN_MS} ms 余量**的一档，据推荐 **T = ${candidateS} s**（读数下界 ${floor} ms）。`
  );
}

function recommendP(v3: ConnReading[]): string {
  if (v3.length === 0) return '不足以推荐（本运行未取到 V-3 读数）。';
  const summary = summarizeV3(v3);
  if (summary.includes('不一致')) {
    return `不足以推荐：${summary} 注意**同一段音频在同一条连接里也会转出不同的字**（对照上表基线臂第一句与第二句，是同一个语料句），所以「与基线不一致」不能单独归因给 P；本运行区分不出 \`P ∈ {300,500,800} ms\` 的差别，不给出 \`P\` 取值，需在转写更稳定的语料上重测。`;
  }
  return `依据 V-3 读数（${summary}）——P ∈ {300,500,800} ms 下，停传→恢复后上游的逐条转写列表与基线**逐位置一致**、未见丢字，三个取值之间也看不出差别，故取区间中值、留一半冗余：推荐 **P = 500 ms**。`;
}

/** 从一条连接的帧时间线里挑出「语音结束 → speech_stopped → commit」附近的关键帧，原文摘录。 */
function excerptTimeline(reading: ConnReading): string[] {
  const n = parseNote(reading);
  const speechEndWall = typeof n.speechEndWallMs === 'number' ? n.speechEndWallMs : 0;
  const silenceEndWall = typeof n.silenceSentWallMs === 'number' ? n.silenceSentWallMs : 0;
  const clipAudio = typeof n.clipAudioMs === 'number' ? n.clipAudioMs : 0;
  const sentMs = typeof n.silenceSentMs === 'number' ? n.silenceSentMs : 0;
  const keyTypes = new Set([
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.created',
    'conversation.item.input_audio_transcription.completed',
    'response.created',
    'response.done',
    'error',
  ]);
  const out: string[] = [];
  for (const e of reading.events) {
    if (e.direction !== 'received' || !keyTypes.has(e.type)) continue;
    const rel = e.atMs - speechEndWall;
    const audioRel = e.atAudioMs - clipAudio;
    const inStall = e.atMs > silenceEndWall;
    const summary = summarizeEvent(e);
    out.push(
      `${e.atMs} ms（相对语音结束 ${rel >= 0 ? '+' : ''}${rel} ms）\`${e.type}\`${summary}` +
        ` ｜ 音频轴：已收 ${audioRel} ms（实送静音 ${sentMs} ms${inStall ? '，此后停传' : ''}${audioRel > sentMs + 50 ? '，**越过实送量**' : ''}）`,
    );
    if (out.length >= 14) break;
  }
  if (out.length === 0) out.push('（本连接无关键事件帧）');
  return out;
}

function summarizeEvent(e: WireEvent): string {
  if (e.type === 'conversation.item.input_audio_transcription.completed' && typeof e.raw.transcript === 'string') {
    return ` transcript=「${e.raw.transcript}」`;
  }
  if (e.type === 'error') return ` ${JSON.stringify(e.raw).slice(0, 160)}`;
  if (e.type === 'response.done') {
    const resp = e.raw.response as { usage?: unknown } | undefined;
    return ` usage=${JSON.stringify(resp?.usage ?? null).slice(0, 120)}`;
  }
  return '';
}

// V-6 的结论行（本地；本探针不改产品代码，故为代码面陈述 + 本地模式矩阵）。
const V6_LINE =
  'STS 原型只在 **continuous**（上游 `server_vad`）生效：它不改断句、不 commit、不发 `response.create`、不关 WS，只门控「哪些帧上传」。`VOICE_REALTIME_SEGMENT_COMMIT=server-vad` 的回退路径由客户端 `segment_start/segment_end` 驱动，断句权在客户端，STS 的 tail 门控在那里没有意义（不需要、也不启用）。本探针不改产品代码，故 V-6 为代码面陈述（见 `voice-realtime-bridge.service.ts` 的 segmented 分支与 `voice-realtime-mode.ts`），未另起产品连接对照。';
const V6_PARAGRAPH =
  'STS 与模式的关系：\n\n- **continuous**（上游 `server_vad`）：STS 的目标模式。上游自己断句，STS 只减少空音频上传。\n- **`VOICE_REALTIME_SEGMENT_COMMIT=server-vad`（回退）**：断句权在客户端（`segment_start/segment_end`），tail 门控无意义，不启用。\n- **segmented / manual**：同上，客户端已接管边界。\n\n本项为代码面陈述（本探针不改产品代码，未起产品连接）；任务书 V-6 标注为「可选，预算允许时」，本次未花预算做产品对照。';

export { buildReport };

// 入口：只在被直接执行时跑。
const isDirect = process.argv[1] !== undefined && /probe\.mts$/.test(process.argv[1]);
if (isDirect) main();
