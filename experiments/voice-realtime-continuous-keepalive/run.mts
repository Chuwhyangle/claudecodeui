#!/usr/bin/env tsx
/**
 * Continuous 小额真实校准 —— R-1 / R-2 / R-3，一次真实 Realtime 运行（GOAL-044 / AC-372）。
 *
 * 现场。人 yale 2026-10-13 裁定（决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md`
 * §11–§12）：Live Voice 改成 **continuous 传输**——音频持续 20 ms PCM（含静音），不分段、不门控；上游
 * `server_vad`（或 `semantic_vad`）保留作评估触发。这件事有四个**只能实测**的洞：
 *   R-1 持续上传（含 12 min 静音）连接是否存活？期间是否计费？——AC-363 V-2 量到的是**停传**约 300 s
 *       被上游 1007 关闭；持续上传是另一条路，读数不通用。
 *   R-2 30–60 s 连续口述在 `server_vad`(silence 800) 与 `semantic_vad` 下切出几个条目、碎成几段、
 *       说完多久出 response、转写丢不丢字——AC-374 的默认值与 AC-373 的指令措辞要引用这三个读数。
 *   R-3 模型带着 RunDigest 草案（模拟正在执行的 run）听四类执行中语料（补充/细化/改方向/取消），
 *       决策分布如何——只报读数，不设门槛。
 *
 * 为什么直连上游而不是第二实例。R-1 的变量是「**持续**上传 12 min」这一件事本身，R-2 需要一整段连续
 * 口述的帧级时间线，R-3 需要每类语料一条独立连接与自定义指令——HTTP diagnose 面（整段 WAV 投喂）表达
 * 不了「帧级持续」也难表达「每句一条连接」。本脚本用一个 raw WebSocket 客户端直连上游，帧级驱动；任务书
 * 明确允许这条路（「备用端口第二实例**或**直接用实验脚本连上游」）。
 *
 * dry-run 执行面。本脚本建立的是**合成会话**：`sessionId` 在脚本里生成（R-3 用固定占位串 "current"），
 * 任何库里都不存在。会话声明的 `session_send` / `session_interrupt` 由本脚本的**记录式执行器**承接：
 * 模型每次调用只被记进 journal 并回一个 `{"dryRun":true,...}` 的合成 output，绝不落到任何真实会话。
 * 所以「不向任何真实会话注入任何东西」由构造承担，而不是靠一个分支里的 if。
 *
 * 证据落在哪。每条连接一个 JSONL：`<运行目录>/journal/<连接 id>.jsonl`，逐条记下每一个**收**到的 wire
 * 帧、每一个**发**出的控制帧（`session.update` / `response.create` / `conversation.item.create`）与本次
 * 判读；音频帧（`input_audio_buffer.append`）逐帧发送但**不逐帧留帧**——它们只以 `uploadedMs` 汇总（帧长
 * 恒 20 ms、按墙钟截止时刻发出），否则 12 min 就是 36000 条无信息量的记录。原始帧另存
 * `<连接 id>.frames.json`。报告里每一行引用的连接 id、时刻、事件都能在这两个文件里对上。
 *
 * 花费。每条连接封顶 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION`（默认 ¥0.05，写进 env 供记录）；本脚本用
 * **出货的** `estimateRealtimeCostCny` 在每条 `response.done` 上累计（不在这里抄一份价目表）。总花费上限
 * ¥1.5 由分段运行 + 每条封顶共同保证；连接数在 `--plan` 里先算出来。
 *
 * 用法（仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-continuous-keepalive/run.mts
 *   … --plan                 只打印计划（要建哪些连接、几个 TTS），不连上游、不花钱
 *   … --smoke                只跑一条最短的 R-3 连接（证管线），报告写到 <运行目录>/report.md，不碰交付物
 *   … --sections r1,r2,r3    只跑指定分段（冒烟 / 返工用）
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
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-continuous-keepalive-calibration.md');

/** 上游 Realtime 端点（与出货 transport 同址）。 */
const UPSTREAM_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
/** 出货默认模型（GOAL-030 采纳）。 */
const MODEL = 'qwen3.8-omni-flash-realtime';
/** 出货默认 voice（该模型要求显式 voice）。 */
const VOICE = 'Tina';

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_BYTES = ((SAMPLE_RATE * FRAME_MS) / 1000) * 2; // 640

const DEFAULT_CAP_CNY = 0.05;
/** 长静音用的底噪床长度：60 s 循环（避免为 12 min 生成 23 MB 缓冲；循环不改变「持续上传」这一事实）。 */
const NOISE_BED_MS = 60_000;

/** TTS 的出货模型与音色（沿用 interrupt-sampling / STS 2026-10-12 实测可用的那条路）。 */
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

type CorpusTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };
type TurnDetection = Record<string, unknown>;
type SpeechItem = { id: string; text: string };

type R1Corpus = {
  note: string;
  instructions: string;
  tools: CorpusTool[];
  turnDetection: TurnDetection;
  speechBefore: SpeechItem[];
  speechAfter: SpeechItem[];
  silenceMs: number;
  tailMs: number;
};
type R2Arm = { id: string; turnDetection: TurnDetection };
type R2Corpus = {
  note: string;
  instructions: string;
  tools: CorpusTool[];
  arms: R2Arm[];
  phrases: SpeechItem[];
  pausesMs: number[];
};
type R3Item = { id: string; kind: string; text: string };
type R3Corpus = {
  note: string;
  sessionId: string;
  instructions: string;
  tools: CorpusTool[];
  turnDetection: TurnDetection;
  items: R3Item[];
};
type Corpus = { version: number; note: string[]; r1: R1Corpus; r2: R2Corpus; r3: R3Corpus };

function loadCorpus(): Corpus {
  const parsed = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
  if (!Array.isArray(parsed.r2?.phrases) || parsed.r2.phrases.length === 0) throw new Error(`语料为空：${CORPUS_PATH}`);
  const ids = new Set<string>();
  const all: SpeechItem[] = [
    ...parsed.r1.speechBefore,
    ...parsed.r1.speechAfter,
    ...parsed.r2.phrases,
    ...parsed.r3.items,
  ];
  for (const item of all) {
    if (ids.has(item.id)) throw new Error(`语料 id 重复：${item.id}`);
    ids.add(item.id);
  }
  return parsed;
}

/** 合成一条语料的音频（DashScope TTS → ffmpeg → 16 kHz 单声道 PCM16 WAV）。沿用 interrupt-sampling / STS。 */
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
  const args = ['-y', '-loglevel', 'error', '-i', rawPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', outPath];
  execFileSync('/usr/bin/ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function ensureAudio(items: SpeechItem[], audioDir: string): Promise<void> {
  for (const item of items) {
    const target = path.join(audioDir, `${item.id}.wav`);
    if (existsSync(target)) {
      log(`  [tts] 复用 ${item.id}.wav`);
      continue;
    }
    process.stdout.write(`  [tts] 合成 ${item.id} … `);
    await synthesize(item.text, target);
    log('ok');
  }
}

/** 读一条 16 kHz 单声道 PCM16 WAV 的 data chunk。 */
function parseWavPcm16(buffer: Buffer): Buffer {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data') return buffer.subarray(body, Math.min(buffer.length, body + size));
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** 去掉尾部由 TTS 留给的过长静音（保留 ≤ 150 ms 尾巴，免得整轨拖长）。 */
function trimTrailingSilence(pcm: Buffer, threshold = 220, keepMs = 150): Buffer {
  const samples = Math.floor(pcm.length / 2);
  let last = samples - 1;
  while (last > 0 && Math.abs(pcm.readInt16LE(last * 2)) < threshold) last -= 1;
  const keep = Math.floor((keepMs / 1000) * SAMPLE_RATE);
  const end = Math.min(samples, last + keep + 1);
  return pcm.subarray(0, end * 2);
}

function loadClip(audioDir: string, id: string): Buffer {
  return trimTrailingSilence(parseWavPcm16(readFileSync(path.join(audioDir, `${id}.wav`))));
}

// ─────────────────────────────────────────────────────────────────────────────
// stand-in 音频：底噪（合成，不是真人录音）
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

function frameCount(pcm: Buffer): number {
  return Math.ceil(pcm.length / FRAME_BYTES);
}
function frameAt(pcm: Buffer, index: number): Buffer {
  return pcm.subarray(index * FRAME_BYTES, Math.min(pcm.length, (index + 1) * FRAME_BYTES));
}

// ─────────────────────────────────────────────────────────────────────────────
// 上游连接
// ─────────────────────────────────────────────────────────────────────────────

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
  /** 本地驱动结束时的连接相对墙钟（不受 close 影响）。 */
  driverEndAtMs = 0;
  private readonly advertisedTools: Set<string>;
  /** 已回过的 tool call id：上游把同一个调用报两次（`…arguments.done` 与 `output_item.done`）。 */
  private readonly answeredCalls = new Set<string>();
  /** 合成 `response.create` 的在途闸门（一个 response 未结束时再送会被拒）。 */
  private responseActive = false;
  private pendingResponseCreate = false;

  private constructor(ws: WebSocket, capCny: number, advertisedTools: Set<string>) {
    this.ws = ws;
    this.capCny = capCny;
    this.advertisedTools = advertisedTools;
  }

  static async connect(options: {
    instructions: string;
    tools: CorpusTool[];
    turnDetection: TurnDetection;
    capCny: number;
    sessionExtra?: Record<string, unknown>;
  }): Promise<UpstreamLink> {
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
      link.closeInfo = { code, reason: reason.toString('utf8'), atMs: link.nowMs() };
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

  /** 连接相对墙钟（与 events 的 atMs 同一时间基）。 */
  nowMs(): number {
    return Date.now() - this.t0;
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

  /** 记下并发出一个控制帧（`session.update` / `response.create` / `conversation.item.create`）。 */
  private sendRaw(frame: Record<string, unknown>): void {
    this.events.push({ atMs: this.nowMs(), atAudioMs: this.uploadedMs, direction: 'sent', type: String(frame.type), raw: frame });
    this.safeSend(JSON.stringify(frame));
  }

  private safeSend(payload: string): void {
    try {
      this.ws.send(payload);
    } catch (err) {
      this.errors.push(`send: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 上传一帧 PCM16（base64）。`record=false` 时**不发事件**（音频帧逐帧留帧只会把 12 min 变成 36000 条
   * 无信息量的记录）；`uploadedMs` 与收到帧的 `atAudioMs` 不受影响。
   */
  append(frame: Buffer, record = true): void {
    this.uploadedMs += Math.round((frame.length / 2 / SAMPLE_RATE) * 1000);
    const audio = frame.toString('base64');
    if (record) {
      this.sendRaw({ type: 'input_audio_buffer.append', audio });
      return;
    }
    this.safeSend(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
  }

  private handle(text: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(raw.type ?? 'unknown');
    this.events.push({ atMs: this.nowMs(), atAudioMs: this.uploadedMs, direction: 'received', type, raw });

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
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify({ dryRun: true, accepted: true, note: 'continuous-keepalive calibration recorded this call; nothing was executed' }),
        },
      });
      this.requestResponse();
    }
  }

  /** 送 `response.create`，但一个 response 还在途时先挂起。 */
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
      return { atMs: this.nowMs(), name, args: safeParse(rawArgs), raw: rawArgs, callId };
    }
    if (t === 'response.output_item.done') {
      const item = raw.item as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown } | undefined;
      if (item?.type !== 'function_call' || typeof item.name !== 'string' || typeof item.call_id !== 'string') return null;
      if (!this.advertisedTools.has(item.name)) return null;
      const rawArgs = typeof item.arguments === 'string' ? item.arguments : '{}';
      return { atMs: this.nowMs(), name: item.name, args: safeParse(rawArgs), raw: rawArgs, callId: item.call_id };
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
    this.responses.push({ atMs: this.nowMs(), inputTokens, outputTokens, textTokens, audioTokens, costCny });
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

  /** 收到的 `response.done` 帧的 usage 原文（按时间顺序）。 */
  rawUsages(): Array<{ atMs: number; usage: unknown }> {
    return this.inboundOfType('response.done').map((e) => ({
      atMs: e.atMs,
      usage: (e.raw.response as { usage?: unknown } | undefined)?.usage ?? null,
    }));
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
 * 按**墙钟截止时刻**播放，而不是每帧 `await sleep(20)` 累加——后者会把每帧的调度开销累积成漂移，
 * 让「第 N 帧在墙钟第几毫秒」不再可推理。截止时刻法把漂移钉死在单帧调度误差上。
 */
async function pace(deadlineMs: number): Promise<void> {
  const wait = deadlineMs - Date.now();
  if (wait > 0) await sleep(wait);
}

/** 持续逐帧上传一段 PCM（`record=false` 的音频不留帧）。`shouldStop` 为真时提前收手（用于上游已断）。 */
async function playPcm(
  link: UpstreamLink,
  pcm: Buffer,
  opts: { record?: boolean; shouldStop?: () => boolean; onProgress?: (sentFrames: number, elapsedMs: number) => void } = {},
): Promise<number> {
  const frames = frameCount(pcm);
  const t0 = Date.now();
  let sent = 0;
  for (let i = 0; i < frames; i += 1) {
    if (opts.shouldStop !== undefined && opts.shouldStop()) break;
    await pace(t0 + i * FRAME_MS);
    link.append(frameAt(pcm, i), opts.record ?? true);
    sent += 1;
    if (opts.onProgress !== undefined && sent % 3000 === 0) opts.onProgress(sent, Date.now() - t0);
  }
  return sent;
}

/** 持续上传一段 60 s 底噪床，凑满 `totalMs`（循环使用同一床；这是 R-1 的「持续上传」本体）。 */
async function playNoiseBed(link: UpstreamLink, bed: Buffer, totalMs: number, shouldStop: () => boolean): Promise<number> {
  const bedFrames = frameCount(bed);
  const frames = Math.floor(totalMs / FRAME_MS);
  const t0 = Date.now();
  let sent = 0;
  for (let i = 0; i < frames; i += 1) {
    if (shouldStop()) break;
    await pace(t0 + i * FRAME_MS);
    link.append(frameAt(bed, i % bedFrames), false);
    sent += 1;
    if (sent % 15_000 === 0) log(`    … 已持续上传 ${Math.round((Date.now() - t0) / 1000)} s（${sent} 帧），连接${link.closed ? '已断' : '存活'}`);
  }
  return sent;
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
    const gotResponse = link.responses.length > 0;
    if (gotResponse && Date.now() - quietSince > 2_500) return;
    if (!gotResponse && Date.now() - quietSince > maxMs / 2) return;
    await sleep(250);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读数
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
  usage: { textTokens: number; audioTokens: number; outputTokens: number; cumulative: boolean; responsesCounted: number };
  inputTranscripts: string[];
  inputItems: Array<{ atMs: number; text: string }>;
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
  // `usage.input_tokens_details` 是**整条连接的累计值**（出货 transport 头注确认：不是每次 response 的
  // 增量，已对过真实账单行）。所以本连接的 token 读数是**最后一次** response.done 的值，不是各次求和。
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
    connectedMs: link.driverEndAtMs || Date.now() - startedAtMs,
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

function writeJournal(journalDir: string, reading: ConnReading, link: UpstreamLink): void {
  const entries: Array<Record<string, unknown>> = [
    {
      journal: 'voice-realtime-continuous-keepalive',
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
      journal: 'voice-realtime-continuous-keepalive',
      kind: e.direction === 'sent' ? 'run.sent' : 'run.received',
      at: reading.startedAt,
      atMs: e.atMs,
      connectionId: reading.connectionId,
      type: e.type,
      raw: e.raw,
    });
  }
  entries.push({
    journal: 'voice-realtime-continuous-keepalive',
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
  link.driverEndAtMs = link.nowMs();
  const reading = buildReading(link, connectionId, label, section, startedAtMs, nowIso(startedAtMs));
  reading.errors.push(err instanceof Error ? err.message : String(err));
  return reading;
}

function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('/usr/bin/ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = /pid=(\d+)/.exec(out);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-1：持续上传含 12 min 静音
// ─────────────────────────────────────────────────────────────────────────────

type UsageDelta = { inputTokens: number; textTokens: number; audioTokens: number; outputTokens: number };
type R1Out = {
  reading: ConnReading;
  alive: boolean;
  closedCode: number | null;
  closedReason: string | null;
  silenceStartMs: number;
  silenceEndMs: number;
  silenceRequestedMs: number;
  silenceUploadedMs: number;
  silenceSentFrames: number;
  tailMs: number;
  responsesBeforeSilence: number;
  responsesDuringSilence: number;
  responsesAfterSilence: number;
  usageLastBefore: UsageDelta | null;
  usageLastInSilence: UsageDelta | null;
  usageDelta: UsageDelta;
  rawUsageDuringSilence: Array<{ atMs: number; usage: unknown }>;
  rawUsageLastBefore: unknown;
  transcriptsBeforeSilence: string[];
  transcriptsAfterSilence: string[];
  recoveryFirstTranscriptLatencyMs: number | null;
  recoveryFirstResponseLatencyMs: number | null;
  speechStoppedMs: number[];
  speechBeforeCount: number;
  speechAfterCount: number;
};

async function runR1(corpus: Corpus, clips: Map<string, Buffer>, noiseBed: Buffer, capCny: number, journalDir: string): Promise<R1Out> {
  const r1 = corpus.r1;
  const label = 'R-1/continuous-12min';
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  const link = await UpstreamLink.connect({
    instructions: r1.instructions,
    tools: r1.tools,
    turnDetection: r1.turnDetection,
    capCny,
  });
  try {
    // 第一段语音：两句 + 尾随真实静音（不发静音音频上游不会断句）。
    const before = Buffer.concat(r1.speechBefore.map((s) => clips.get(s.id)!).concat([noiseFloor(r1.tailMs)]));
    await playPcm(link, before, { record: false });
    await waitForQuiet(link, 20_000);

    const silenceStartMs = link.nowMs();
    const responsesBeforeSilence = link.responses.length;
    const transcriptsBeforeSilence = link.inboundOfType('conversation.item.input_audio_transcription.completed').length;
    const uploadedBeforeSilence = link.uploadedMs;

    // 持续上传：底噪 12 min，一帧不停（这才是 R-1 的本体）。上游断链或触到花费上限时提前收手。
    const silenceSentFrames = await playNoiseBed(link, noiseBed, r1.silenceMs, () => link.closed || link.capTripped);
    const silenceEndMs = link.nowMs();
    const silenceUploadedMs = link.uploadedMs - uploadedBeforeSilence;
    const alive = !link.closed;

    const responsesDuringSilence = link.responses.filter((r) => r.atMs > silenceStartMs && r.atMs <= silenceEndMs).length;
    const rawUsageDuringSilence = link.rawUsages().filter((u) => u.atMs > silenceStartMs && u.atMs <= silenceEndMs);
    const rawUsageLastBefore = link.rawUsages().filter((u) => u.atMs <= silenceStartMs).at(-1)?.usage ?? null;

    // 恢复：第二段语音两两。
    const speechStoppedMs: number[] = [];
    let recoveryFirstTranscriptLatencyMs: number | null = null;
    let recoveryFirstResponseLatencyMs: number | null = null;
    let transcriptsAfterSilence: string[] = [];
    if (alive) {
      const resumeAtMs = link.nowMs();
      const after = Buffer.concat(r1.speechAfter.map((s) => clips.get(s.id)!).concat([noiseFloor(r1.tailMs)]));
      await playPcm(link, after, { record: false });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (link.inboundOfType('conversation.item.input_audio_transcription.completed').length > transcriptsBeforeSilence) break;
        await sleep(200);
      }
      const afterItems = link.inboundOfType('conversation.item.input_audio_transcription.completed').slice(transcriptsBeforeSilence);
      transcriptsAfterSilence = afterItems.map((e) => String(e.raw.transcript ?? ''));
      const firstTranscript = afterItems[0] ?? null;
      if (firstTranscript !== null) recoveryFirstTranscriptLatencyMs = Math.max(0, firstTranscript.atMs - resumeAtMs);
      const firstResponse = link.inboundOfType('response.created').find((e) => e.atMs >= resumeAtMs) ?? null;
      if (firstResponse !== null) recoveryFirstResponseLatencyMs = Math.max(0, firstResponse.atMs - resumeAtMs);
      for (const e of link.inboundOfType('input_audio_buffer.speech_stopped')) {
        if (e.atMs >= resumeAtMs) speechStoppedMs.push(e.atMs - resumeAtMs);
      }
      await waitForQuiet(link, 15_000);
    }

    link.driverEndAtMs = link.nowMs();
    const reading = buildReading(link, connectionId, label, 'R-1', startedAtMs, nowIso(startedAtMs));

    const lastBefore = link.responses.filter((r) => r.atMs <= silenceStartMs).at(-1) ?? null;
    const lastIn = link.responses.filter((r) => r.atMs > silenceStartMs && r.atMs <= silenceEndMs).at(-1) ?? null;
    const toDelta = (r: ResponseUsage | null): UsageDelta | null =>
      r === null ? null : { inputTokens: r.inputTokens, textTokens: r.textTokens, audioTokens: r.audioTokens, outputTokens: r.outputTokens };
    const lastInSilenceAt = lastIn?.atMs ?? silenceStartMs;
    const base = link.responses.filter((r) => r.atMs <= lastInSilenceAt && r !== lastIn).at(-1) ?? null;
    // 窗口内一次 response 都没有 ⇒ 增量为 0（不是「最后的累计值取负」——累计值本来就没动）。
    const usageDelta: UsageDelta =
      lastIn === null
        ? { inputTokens: 0, textTokens: 0, audioTokens: 0, outputTokens: 0 }
        : {
            inputTokens: lastIn.inputTokens - (base?.inputTokens ?? 0),
            textTokens: lastIn.textTokens - (base?.textTokens ?? 0),
            audioTokens: lastIn.audioTokens - (base?.audioTokens ?? 0),
            outputTokens: lastIn.outputTokens - (base?.outputTokens ?? 0),
          };

    const note = {
      alive,
      closedCode: reading.closedCode,
      closedReason: link.closeInfo?.reason ?? null,
      silenceStartMs,
      silenceEndMs,
      silenceRequestedMs: r1.silenceMs,
      silenceUploadedMs,
      silenceSentFrames,
      responsesBeforeSilence,
      responsesDuringSilence,
      rawUsageDuringSilence,
      recoveryFirstTranscriptLatencyMs,
      recoveryFirstResponseLatencyMs,
      speechStoppedMs,
    };
    reading.note = JSON.stringify(note);
    writeJournal(journalDir, reading, link);
    log(
      `  [R-1] 持续上传 ${Math.round(silenceUploadedMs / 1000)}s（${silenceSentFrames} 帧）：${alive ? '存活' : `关闭(code=${reading.closedCode})`}；` +
        `静音期间 response=${responsesDuringSilence}，恢复后新转写=${transcriptsAfterSilence.length} 条` +
        `${recoveryFirstTranscriptLatencyMs === null ? '' : `（首条 +${recoveryFirstTranscriptLatencyMs} ms）`}，花费=¥${reading.spendCny.toFixed(4)}`,
    );

    return {
      reading,
      alive,
      closedCode: reading.closedCode,
      closedReason: link.closeInfo?.reason ?? null,
      silenceStartMs,
      silenceEndMs,
      silenceRequestedMs: r1.silenceMs,
      silenceUploadedMs,
      silenceSentFrames,
      tailMs: r1.tailMs,
      responsesBeforeSilence,
      responsesDuringSilence,
      responsesAfterSilence: reading.responses - responsesBeforeSilence - responsesDuringSilence,
      usageLastBefore: toDelta(lastBefore),
      usageLastInSilence: toDelta(lastIn),
      usageDelta,
      rawUsageDuringSilence,
      rawUsageLastBefore,
      transcriptsBeforeSilence: reading.inputItems.filter((i) => i.atMs <= silenceStartMs).map((i) => i.text),
      transcriptsAfterSilence,
      recoveryFirstTranscriptLatencyMs,
      recoveryFirstResponseLatencyMs,
      speechStoppedMs,
      speechBeforeCount: r1.speechBefore.length,
      speechAfterCount: r1.speechAfter.length,
    };
  } finally {
    link.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-2：两臂长口述
// ─────────────────────────────────────────────────────────────────────────────

type R2Out = {
  reading: ConnReading;
  arm: string;
  turnDetection: TurnDetection;
  phraseCount: number;
  entries: number;
  commits: number;
  responses: number;
  fragments: number;
  dictationMs: number;
  latenciesMs: number[];
  transcripts: string[];
  inputItems: Array<{ atMs: number; text: string }>;
  referenceTexts: string[];
  joinedEqual: boolean;
  missingPhrases: string[];
  commonPrefix: number;
  commonSuffix: number;
  refJoinedLen: number;
  hypJoinedLen: number;
};

/** 忽略标点与空白的归一化（用于转写 vs 原稿的差异读数）。 */
function normalizeForCompare(s: string): string {
  return s.replace(/[\s　，。、？！；：,.;:?!…—–\-「」『』“”"'（）()《》]/g, '');
}

function phraseCoverage(transcripts: string[], referenceTexts: string[]): { joinedEqual: boolean; missing: string[]; commonPrefix: number; commonSuffix: number; refLen: number; hypLen: number } {
  const hyp = normalizeForCompare(transcripts.join(''));
  const ref = normalizeForCompare(referenceTexts.join(''));
  const missing = referenceTexts.filter((p) => !hyp.includes(normalizeForCompare(p)));
  let prefix = 0;
  while (prefix < Math.min(hyp.length, ref.length) && hyp[prefix] === ref[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < Math.min(hyp.length, ref.length) - prefix && hyp[hyp.length - 1 - suffix] === ref[ref.length - 1 - suffix]) suffix += 1;
  return { joinedEqual: hyp === ref, missing, commonPrefix: prefix, commonSuffix: suffix, refLen: ref.length, hypLen: hyp.length };
}

/** 每个 `speech_stopped` 到其后第一个 `response.created` 的间隔（说完了多久出 response）。 */
function speechToResponseLatencies(events: WireEvent[]): number[] {
  const stopped = events.filter((e) => e.direction === 'received' && e.type === 'input_audio_buffer.speech_stopped').map((e) => e.atMs);
  const created = events.filter((e) => e.direction === 'received' && e.type === 'response.created').map((e) => e.atMs);
  const out: number[] = [];
  for (const t of stopped) {
    const next = created.find((c) => c >= t);
    if (next !== undefined) out.push(next - t);
  }
  return out;
}

async function runR2Arm(corpus: Corpus, arm: R2Arm, clips: Map<string, Buffer>, noiseBed: Buffer, capCny: number, journalDir: string): Promise<R2Out> {
  const r2 = corpus.r2;
  const label = `R-2/${arm.id}`;
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  const link = await UpstreamLink.connect({
    instructions: r2.instructions,
    tools: r2.tools,
    turnDetection: arm.turnDetection,
    capCny,
  });
  try {
    // 一整段连续口述：句 + 句间 1–3 s 底噪停顿（真实背景，不是数字零），末尾再补一段底噪收尾。
    const parts: Buffer[] = [];
    r2.phrases.forEach((p, i) => {
      parts.push(clips.get(p.id)!);
      const pause = r2.pausesMs[i];
      if (pause !== undefined) parts.push(noiseBed.subarray(0, Math.floor((SAMPLE_RATE * pause) / 1000) * 2));
    });
    parts.push(noiseBed.subarray(0, Math.floor((SAMPLE_RATE * 1_000) / 1000) * 2));
    const dictation = Buffer.concat(parts);
    await playPcm(link, dictation, { record: false });
    await waitForQuiet(link, 25_000);
    link.driverEndAtMs = link.nowMs();
    const reading = buildReading(link, connectionId, label, 'R-2', startedAtMs, nowIso(startedAtMs));

    const entries = link.inboundOfType('conversation.item.input_audio_transcription.completed').length;
    const commits = link.inboundOfType('input_audio_buffer.committed').length;
    const coverage = phraseCoverage(reading.inputTranscripts, r2.phrases.map((p) => p.text));
    const out: R2Out = {
      reading,
      arm: arm.id,
      turnDetection: arm.turnDetection,
      phraseCount: r2.phrases.length,
      entries,
      commits,
      responses: reading.responses,
      fragments: Math.max(0, entries - r2.phrases.length),
      dictationMs: Math.round((dictation.length / 2 / SAMPLE_RATE) * 1000),
      latenciesMs: speechToResponseLatencies(link.events),
      transcripts: reading.inputTranscripts,
      inputItems: reading.inputItems,
      referenceTexts: r2.phrases.map((p) => p.text),
      joinedEqual: coverage.joinedEqual,
      missingPhrases: coverage.missing,
      commonPrefix: coverage.commonPrefix,
      commonSuffix: coverage.commonSuffix,
      refJoinedLen: coverage.refLen,
      hypJoinedLen: coverage.hypLen,
    };
    reading.note = JSON.stringify({
      arm: arm.id,
      turnDetection: arm.turnDetection,
      dictationMs: out.dictationMs,
      entries,
      commits,
      fragments: out.fragments,
      latenciesMs: out.latenciesMs,
      joinedEqual: out.joinedEqual,
      missingPhrases: out.missingPhrases,
    });
    writeJournal(journalDir, reading, link);
    log(
      `  [R-2] ${arm.id}：口述 ${(out.dictationMs / 1000).toFixed(1)}s，条目=${entries}，碎片=${out.fragments}，response=${out.responses}，` +
        `说完→response=${out.latenciesMs.length === 0 ? '无' : out.latenciesMs.join('/')}ms，转写${out.joinedEqual ? '逐字一致' : `缺 ${out.missingPhrases.length} 句`}，花费=¥${reading.spendCny.toFixed(4)}`,
    );
    return out;
  } catch (err) {
    const reading = errorReading(link, connectionId, label, 'R-2', startedAtMs, err);
    reading.note = JSON.stringify({ arm: arm.id, error: err instanceof Error ? err.message : String(err) });
    writeJournal(journalDir, reading, link);
    log(`  [R-2] ${arm.id}：错误=${err instanceof Error ? err.message : String(err)}`);
    return {
      reading,
      arm: arm.id,
      turnDetection: arm.turnDetection,
      phraseCount: corpus.r2.phrases.length,
      entries: 0,
      commits: 0,
      responses: 0,
      fragments: 0,
      dictationMs: 0,
      latenciesMs: [],
      transcripts: [],
      inputItems: [],
      referenceTexts: corpus.r2.phrases.map((p) => p.text),
      joinedEqual: false,
      missingPhrases: [],
      commonPrefix: 0,
      commonSuffix: 0,
      refJoinedLen: 0,
      hypJoinedLen: 0,
    };
  } finally {
    link.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-3：执行中决策分布
// ─────────────────────────────────────────────────────────────────────────────

type Decision = '继续' | '补充' | '改方向' | '取消';
type R3Out = {
  reading: ConnReading;
  itemId: string;
  kind: string;
  text: string;
  decision: Decision;
  callNames: string[];
  interruptIntent: string | null;
  interruptMessage: string | null;
  sendMessage: string | null;
  modelTexts: string[];
  transcript: string | null;
};

/** 从模型这一句的工具调用读出决策：interrupt 优先，带 message 是改方向、不带是取消；只有 send 是补充；无调用是继续。 */
function classifyDecision(calls: CallReading[]): { decision: Decision; callNames: string[]; intent: string | null; message: string | null; send: string | null } {
  const callNames = calls.map((c) => c.name);
  const interrupts = calls.filter((c) => c.name === 'session_interrupt');
  if (interrupts.length > 0) {
    const withMessage = interrupts.find((c) => typeof c.args.message === 'string' && String(c.args.message).trim() !== '');
    const first = interrupts[0]!;
    const intent = typeof first.args.intent === 'string' ? first.args.intent : null;
    if (withMessage !== undefined) {
      return { decision: '改方向', callNames, intent, message: String(withMessage.args.message), send: null };
    }
    return { decision: '取消', callNames, intent, message: null, send: null };
  }
  const sends = calls.filter((c) => c.name === 'session_send');
  if (sends.length > 0) {
    const msg = typeof sends[0]!.args.message === 'string' ? String(sends[0]!.args.message) : null;
    return { decision: '补充', callNames, intent: null, message: null, send: msg };
  }
  return { decision: '继续', callNames, intent: null, message: null, send: null };
}

async function runR3Item(corpus: Corpus, item: R3Item, clip: Buffer, noiseBed: Buffer, capCny: number, journalDir: string): Promise<R3Out> {
  const r3 = corpus.r3;
  const label = `R-3/${item.kind}/${item.id}`;
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  const link = await UpstreamLink.connect({
    instructions: r3.instructions,
    tools: r3.tools,
    turnDetection: r3.turnDetection,
    capCny,
  });
  try {
    const tail = noiseBed.subarray(0, Math.floor((SAMPLE_RATE * 1_000) / 1000) * 2);
    await playPcm(link, Buffer.concat([clip, tail]), { record: false });
    await waitForQuiet(link, 20_000);
    link.driverEndAtMs = link.nowMs();
    const reading = buildReading(link, connectionId, label, 'R-3', startedAtMs, nowIso(startedAtMs));
    const c = classifyDecision(link.calls);
    const transcript = reading.inputTranscripts[0] ?? null;
    reading.note = JSON.stringify({
      itemId: item.id,
      kind: item.kind,
      decision: c.decision,
      callNames: c.callNames,
      interruptIntent: c.intent,
      interruptMessage: c.message,
      sendMessage: c.send,
    });
    writeJournal(journalDir, reading, link);
    log(`  [R-3] ${item.kind}/${item.id}：决策=${c.decision}（calls=${c.callNames.join(',') || '无'}；intent=${c.intent ?? '—'}）`);
    return {
      reading,
      itemId: item.id,
      kind: item.kind,
      text: item.text,
      decision: c.decision,
      callNames: c.callNames,
      interruptIntent: c.intent,
      interruptMessage: c.message,
      sendMessage: c.send,
      modelTexts: reading.modelTexts,
      transcript,
    };
  } catch (err) {
    const reading = errorReading(link, connectionId, label, 'R-3', startedAtMs, err);
    reading.note = JSON.stringify({ itemId: item.id, kind: item.kind, error: err instanceof Error ? err.message : String(err) });
    writeJournal(journalDir, reading, link);
    log(`  [R-3] ${item.kind}/${item.id}：错误=${err instanceof Error ? err.message : String(err)}`);
    return {
      reading,
      itemId: item.id,
      kind: item.kind,
      text: item.text,
      decision: '继续',
      callNames: [],
      interruptIntent: null,
      interruptMessage: null,
      sendMessage: null,
      modelTexts: [],
      transcript: null,
    };
  } finally {
    link.close();
  }
}

async function runR3(corpus: Corpus, clips: Map<string, Buffer>, noiseBed: Buffer, capCny: number, journalDir: string): Promise<R3Out[]> {
  const out: R3Out[] = [];
  for (const item of corpus.r3.items) {
    out.push(await runR3Item(corpus, item, clips.get(item.id)!, noiseBed, capCny, journalDir));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 快照与报告
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = {
  runAt: string;
  workDir: string;
  capCny: number;
  totalCapCny: number;
  pidBefore: number | null;
  pidAfter: number | null;
  dryRun: boolean;
  scopeSweep: string | null;
  smoke: boolean;
  r1: R1Out | null;
  r2: R2Out[];
  r3: R3Out[];
  ttsItems: number;
};

const CNY = (v: number): string => `¥${v.toFixed(4)}`;
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function totalSpend(snapshot: Snapshot): number {
  let total = snapshot.r1?.reading.spendCny ?? 0;
  for (const r of snapshot.r2) total += r.reading.spendCny;
  for (const r of snapshot.r3) total += r.reading.spendCny;
  return total;
}
function connectionCount(snapshot: Snapshot): number {
  return (snapshot.r1 === null ? 0 : 1) + snapshot.r2.length + snapshot.r3.length;
}

function buildReport(snapshot: Snapshot): string {
  const lines: string[] = [];
  const total = totalSpend(snapshot);
  const conns = connectionCount(snapshot);

  lines.push('# Live Voice Continuous 传输小额真实校准（R-1 / R-2 / R-3）—— 一次真实 Realtime 运行');
  lines.push('');
  lines.push(
    '本文件是 GOAL-044 / AC-372 的校准记录：把语料喂给**真实**的 Qwen Realtime 上游（`' +
      MODEL +
      '`，出货默认模型与 voice），读 continuous 传输（持续 20 ms PCM，含静音）在三个问题上的读数：长静音存活与计费（R-1）、长口述两臂切分（R-2）、执行中决策分布（R-3）。**这不是模型推演，是一次运行的读数。**',
  );
  lines.push('');
  if (snapshot.smoke) {
    lines.push('> ⚠️ **本文件来自 `--smoke` 冒烟运行**（只跑最短管线，不是交付读数）。交付报告来自不带 `--smoke` 的完整运行。');
    lines.push('');
  }
  lines.push(`运行时刻 ${snapshot.runAt}；连接数 ${conns}；:3001 只被读 pid，从未被重启。`);
  lines.push('');

  // ── 结论（行首字段，AC1/AC-372 判据逐行匹配） ────────────────────────────────
  lines.push('## 结论（读数）');
  lines.push('');
  lines.push(r1AliveLine(snapshot));
  lines.push(r1BillingLine(snapshot));
  lines.push(r2EntriesLine(snapshot));
  lines.push(r2LatencyLine(snapshot));
  lines.push(r2TranscriptLine(snapshot));
  lines.push(r3DecisionLine(snapshot));
  lines.push('运行次数：1');
  lines.push(
    `花费：${CNY(total)}（每条连接上限 ${CNY(snapshot.capCny)} × ${conns} 条连接；总花费上限 ${CNY(snapshot.totalCapCny)}。` +
      `这是出货估算公式的读数（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY/1k token），账单以官方为准；TTS 合成语料的费用不计入实时上限）`,
  );
  lines.push('');
  lines.push('「运行次数：1」指的是这一次校准整体只执行了一回（SPEC §18.7「单次付费运行」），没有重复取数、没有二轮。');
  lines.push('');

  // ── 怎么跑的 ────────────────────────────────────────────────────────────────
  lines.push('## 怎么跑的');
  lines.push('');
  lines.push('- **执行面**：实验脚本直连上游（任务书允许「备用端口第二实例**或**直接用实验脚本连上游」），raw WebSocket，逐 20 ms 帧驱动。`session_send` 与 `session_interrupt` 由脚本的**记录式执行器**承接：调用只被记进 journal 并回一个 `{"dryRun":true}` 的合成 output，**不执行**。');
  lines.push(`- **连接**：R-1 ${snapshot.r1 === null ? 0 : 1} 条、R-2 ${snapshot.r2.length} 条（两臂各一条）、R-3 ${snapshot.r3.length} 条（每句一条）。\`sessionId\` 是脚本里生成的合成 id（R-3 用固定占位串 \`current\`），任何库里都不存在——所以哪怕执行面有洞，也没有一条路能落到真实会话上。`);
  lines.push(`- **dry-run**：是（记录式执行器）。\`CLAUDE_SESSION_SCOPE_SWEEP=${snapshot.scopeSweep ?? 'off'}\`（本脚本不起任何服务进程，该变量只为与安全边界一致而设）。`);
  lines.push(`- **花费上限**：\`VOICE_REALTIME_MAX_CNY_PER_CONNECTION=${snapshot.capCny.toFixed(2)}\`，每条连接独立封顶；总花费上限 ${CNY(snapshot.totalCapCny)}。`);
  lines.push(`- **:3001 pid**：运行前 ${snapshot.pidBefore ?? '未知'} → 运行后 ${snapshot.pidAfter ?? '未知'}${snapshot.pidBefore !== null && snapshot.pidBefore === snapshot.pidAfter ? '（相同，未重启）' : '（**注意**：前后不同或不可读）'}。`);
  lines.push('- **边界**：不重启 :3001、不发布、不触碰任何 Quay worker / driver 进程或工作树。');
  lines.push('');
  lines.push(
    '语料：由 DashScope `qwen3-tts-flash`（voice Cherry）合成后经 ffmpeg 转 16 kHz 单声道 PCM16 WAV，共 ' +
      `${snapshot.ttsItems} 条。长静音与句间停顿**不是数字零**，是脚本现场生成的确定性低幅粉噪 stand-in（−46 dBFS 量级），上游应判为静音——**这是合成的 stand-in，不是真人环境录音**。`,
  );
  lines.push('');

  // ── R-1 ────────────────────────────────────────────────────────────────────
  const r1Min = snapshot.r1 === null ? 12 : Math.round(snapshot.r1.silenceRequestedMs / 60_000);
  lines.push(`## R-1 持续上传含 ${r1Min} min 静音：连接是否存活、期间是否计费`);
  lines.push('');
  renderR1(lines, snapshot);
  lines.push('');

  // ── R-2 ────────────────────────────────────────────────────────────────────
  lines.push('## R-2 30–60 s 连续口述：server_vad(silence 800) vs semantic_vad');
  lines.push('');
  renderR2(lines, snapshot);
  lines.push('');

  // ── R-3 ────────────────────────────────────────────────────────────────────
  lines.push('## R-3 执行中决策分布（补充 / 细化 / 改方向 / 取消）');
  lines.push('');
  renderR3(lines, snapshot);
  lines.push('');

  // ── 方法与限制 ──────────────────────────────────────────────────────────────
  lines.push('## 方法与限制（如实记录）');
  lines.push('');
  lines.push('1. **花费是估算**。`estimateRealtimeCostCny` 是出货的估算公式（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY / 1k token），账单以官方为准；这里报的是与出货花费守卫**同一个**读数，不是发票。');
  lines.push('2. **音频是合成语料**。长静音/停顿是低幅粉噪 stand-in，不是真人环境录音；现实环境的底噪频谱、非平稳噪声（键盘、空调、人声）都可能被上游 VAD 判为语音，本运行**没有**覆盖那些。');
  lines.push('3. **`usage.input_tokens_details` 是整条连接的累计值**（出货 transport 头注确认，已对过真实账单行），不是每次 response 的增量。所以「静音期间 token」报的是窗口内最后一次减去窗口前最后一次的**差值**，并附上窗口内 `response.done` 的 usage 原文供核对。');
  lines.push('4. **上游抽样**。真实上游逐条只跑一次，条目边界与工具调用存在非确定性（同一段音频两臂读数本来就不同是读数的内容之一，不是噪声）。');
  lines.push('5. **R-3 只报读数，不设门槛**。「决策分布」是模型在带 RunDigest 草案指令下的行为，不构成对错判断；指令措辞见 `experiments/voice-realtime-continuous-keepalive/corpus.json` 的 `r3.instructions`。');
  lines.push('');
  lines.push(`原始帧与逐条判读在运行目录的 \`journal/<连接 id>.jsonl\` 与 \`<连接 id>.frames.json\`；本报告的每一行都能在那两个文件里对上。运行目录：\`${snapshot.workDir}\`。`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function r1AliveLine(snapshot: Snapshot): string {
  const r1 = snapshot.r1;
  if (r1 === null) return 'R-1 存活：未运行（本快照没有 R-1 读数）。';
  const mins = (r1.silenceUploadedMs / 60_000).toFixed(1);
  const code = r1.closedCode === null ? '未关闭（无 close code）' : `被关闭 code=${r1.closedCode}${r1.closedReason ? `（${r1.closedReason}）` : ''}`;
  return `R-1 存活：${r1.alive ? '存活' : '断开'}——connectionId=${r1.reading.connectionId}，持续上传 ${mins} min（${r1.silenceSentFrames} 帧 / 请求 ${Math.round(r1.silenceRequestedMs / 60_000)} min），连接${code}。对照 AC-363 V-2：**停传**约 300 s 被 1007 关闭；本次是**持续上传**同一时长量级，读数见上。`;
}
function r1BillingLine(snapshot: Snapshot): string {
  const r1 = snapshot.r1;
  if (r1 === null) return 'R-1 计费：未运行。';
  const d = r1.usageDelta;
  return `R-1 计费：静音期间 response 次数=${r1.responsesDuringSilence}；窗口内 usage 增量 audio=${d.audioTokens} / text=${d.textTokens} / input=${d.inputTokens} / output=${d.outputTokens} token（上游无 response 即零增量 ⇒ 该期间花费 ¥0.0000）。usage 原文见下方 R-1 节。`;
}
function r2EntriesLine(snapshot: Snapshot): string {
  if (snapshot.r2.length === 0) return 'R-2 条目：未运行。';
  const parts = snapshot.r2.map((r) => `${r.arm} 条目=${r.entries}（碎片=${r.fragments}）`);
  return `R-2 条目：同一 ${snapshot.r2[0]!.phraseCount} 句、${(snapshot.r2[0]!.dictationMs / 1000).toFixed(1)} s 连续口述——${parts.join('；')}。碎片 = max(0, 条目 − ${snapshot.r2[0]!.phraseCount})。`;
}
function r2LatencyLine(snapshot: Snapshot): string {
  if (snapshot.r2.length === 0) return 'R-2 延迟：未运行。';
  const parts = snapshot.r2.map((r) => {
    const m = median(r.latenciesMs);
    return `${r.arm} 中位 ${m === null ? '无' : `${m} ms`}（[${r.latenciesMs.join(', ')}]）`;
  });
  return `R-2 延迟：说完（speech_stopped）→ response.created 的首个间隔——${parts.join('；')}。`;
}
function r2TranscriptLine(snapshot: Snapshot): string {
  if (snapshot.r2.length === 0) return 'R-2 转写：未运行。';
  const parts = snapshot.r2.map((r) => `${r.arm} ${r.joinedEqual ? '与原稿逐字一致' : `未逐字匹配的原稿句 ${r.missingPhrases.length}/${r.phraseCount}`}`);
  return `R-2 转写：转写拼接（忽略标点空白）与原稿的差异——${parts.join('；')}。逐条原文见下方 R-2 节。`;
}
function r3DecisionLine(snapshot: Snapshot): string {
  if (snapshot.r3.length === 0) return 'R-3 决策：未运行。';
  const kinds = [...new Set(snapshot.r3.map((r) => r.kind))];
  const parts = kinds.map((k) => {
    const bucket = snapshot.r3.filter((r) => r.kind === k);
    const counts = new Map<string, number>();
    for (const r of bucket) counts.set(r.decision, (counts.get(r.decision) ?? 0) + 1);
    const dist = [...counts.entries()].map(([d, n]) => `${d}×${n}`).join('、');
    return `${k}（${bucket.length} 句）→ ${dist}`;
  });
  return `R-3 决策：${parts.join('；')}。每句决策与模型 intent / message 原文见下方 R-3 节。`;
}

function renderR1(lines: string[], snapshot: Snapshot): void {
  const r1 = snapshot.r1;
  if (r1 === null) {
    lines.push('本快照没有 R-1 读数。');
    return;
  }
  lines.push(`做法：一条连接。先口述 ${r1.speechBeforeCount} 句 → **持续上传真实底噪 ${(r1.silenceUploadedMs / 60_000).toFixed(1)} min**（帧级不停）→ 再口述 ${r1.speechAfterCount} 句。`);
  lines.push('');
  lines.push('| 项 | 读数 |');
  lines.push('| --- | --- |');
  lines.push(`| 连接 id | \`${r1.reading.connectionId}\` |`);
  lines.push(`| 存活 | ${r1.alive ? '存活' : '断开'} |`);
  lines.push(`| close code | ${r1.closedCode === null ? '无（未关闭）' : `${r1.closedCode}${r1.closedReason ? ` — ${cell(r1.closedReason)}` : ''}`} |`);
  lines.push(`| 请求静音时长 / 实传 | ${Math.round(r1.silenceRequestedMs / 1000)} s / ${(r1.silenceUploadedMs / 1000).toFixed(1)} s（${r1.silenceSentFrames} 帧） |`);
  lines.push(`| 静音窗口（连接相对墙钟） | ${r1.silenceStartMs} → ${r1.silenceEndMs} ms |`);
  lines.push(`| 静音期间 response 数 | ${r1.responsesDuringSilence} |`);
  lines.push(`| 恢复后新转写 | ${r1.transcriptsAfterSilence.length} 条 |`);
  lines.push(`| 恢复后首句延迟（首条非空转写） | ${r1.recoveryFirstTranscriptLatencyMs === null ? '未恢复 / 无' : `${r1.recoveryFirstTranscriptLatencyMs} ms`} |`);
  lines.push(`| 恢复后首个 response.created | ${r1.recoveryFirstResponseLatencyMs === null ? '无' : `${r1.recoveryFirstResponseLatencyMs} ms`} |`);
  lines.push(`| 连接花费 | ${CNY(r1.reading.spendCny)} |`);
  lines.push('');
  lines.push('第一段（静音前）转写：' + (r1.transcriptsBeforeSilence.length === 0 ? '（无）' : ''));
  for (const t of r1.transcriptsBeforeSilence) lines.push(`- 「${cell(t)}」`);
  lines.push('');
  lines.push('第二段（恢复后）转写：' + (r1.transcriptsAfterSilence.length === 0 ? '（无）' : ''));
  for (const t of r1.transcriptsAfterSilence) lines.push(`- 「${cell(t)}」`);
  lines.push('');
  lines.push('**静音期间 usage 原文**（窗口内每条 `response.done` 的 `response.usage`）：');
  lines.push('');
  if (r1.rawUsageDuringSilence.length === 0) {
    lines.push('窗口内 **没有任何 `response.done`** ⇒ 上游在整段静音期间一次 response 都没有触发，也就没有任何 token 计费。原始帧见 journal（`' + r1.reading.connectionId + '.frames.json`）。');
  } else {
    lines.push('```json');
    lines.push(JSON.stringify(r1.rawUsageDuringSilence, null, 2));
    lines.push('```');
  }
  lines.push('');
  lines.push(
    `token 增量：窗口内最后一次 response 的 usage 减去窗口前最后一次（\`input_tokens_details\` 是连接级累计值，故取差）：` +
      `audio Δ${r1.usageDelta.audioTokens}、text Δ${r1.usageDelta.textTokens}、input Δ${r1.usageDelta.inputTokens}、output Δ${r1.usageDelta.outputTokens}。`,
  );
  lines.push(`窗口前最后一次 usage 原文：\`${JSON.stringify(r1.rawUsageLastBefore)}\`。`);
  lines.push('');
}

function renderR2(lines: string[], snapshot: Snapshot): void {
  if (snapshot.r2.length === 0) {
    lines.push('本快照没有 R-2 读数。');
    return;
  }
  lines.push('同一份连续口述（' + snapshot.r2[0]!.phraseCount + ' 句，句间 1–3 s 底噪停顿），两臂只差 `turnDetection`：`server_vad`（`silence_duration_ms: 800`）与 `semantic_vad`。');
  lines.push('');
  lines.push('| 臂 | turn_detection | 连接 id | 口述时长 | 条目数 | 碎片 | commits | response 数 | 说完→response (ms) | 工具调用 | 花费 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of snapshot.r2) {
    lines.push(
      `| ${r.arm} | \`${cell(JSON.stringify(r.turnDetection))}\` | \`${r.reading.connectionId}\` | ${(r.dictationMs / 1000).toFixed(1)} s | ${r.entries} | ${r.fragments} | ${r.commits} | ${r.responses} | ${r.latenciesMs.join(' / ') || '—'} | ${r.reading.calls} | ${CNY(r.reading.spendCny)} |`,
    );
  }
  lines.push('');
  lines.push(`「条目」= 上游 \`conversation.item.input_audio_transcription.completed\` 的条数；「碎片」= max(0, 条目 − ${snapshot.r2[0]!.phraseCount})，即比原稿句数多切出来的段。`);
  lines.push('');
  for (const r of snapshot.r2) {
    lines.push(`### ${r.arm}`);
    lines.push('');
    lines.push(`转写逐条（${r.transcripts.length} 条）：`);
    lines.push('');
    r.transcripts.forEach((t, i) => lines.push(`${i + 1}. 「${cell(t)}」`));
    if (r.transcripts.length === 0) lines.push('（无）');
    lines.push('');
    lines.push(
      `与原稿差异：拼接后（忽略标点空白）${r.joinedEqual ? '**逐字一致**' : `长度 原稿 ${r.refJoinedLen} / 转写 ${r.hypJoinedLen}（公共前缀 ${r.commonPrefix}、公共后缀 ${r.commonSuffix}），未逐字匹配的原稿句 ${r.missingPhrases.length} 条（可能是整句漏转，也可能是字符级差异，对照上面的逐条转写）：${r.missingPhrases.map((p) => `「${cell(p)}」`).join('、') || '（无）'}`}。`,
    );
    lines.push('');
  }
}

function renderR3(lines: string[], snapshot: Snapshot): void {
  if (snapshot.r3.length === 0) {
    lines.push('本快照没有 R-3 读数。');
    return;
  }
  const kinds = [...new Set(snapshot.r3.map((r) => r.kind))];
  lines.push('指令（`corpus.json` 的 `r3.instructions`）带 RunDigest 草案（覆盖投递 3 条、排队 1 条、最近活动 Edit — src/pages/Login.tsx）与四种决策词汇的语义描述；每类语料一条独立连接。');
  lines.push('');
  lines.push('| 语料类 | 句数 | 决策分布 |');
  lines.push('| --- | --- | --- |');
  for (const k of kinds) {
    const bucket = snapshot.r3.filter((r) => r.kind === k);
    const counts = new Map<string, number>();
    for (const r of bucket) counts.set(r.decision, (counts.get(r.decision) ?? 0) + 1);
    lines.push(`| ${k} | ${bucket.length} | ${[...counts.entries()].map(([d, n]) => `${d} × ${n}`).join('；')} |`);
  }
  lines.push('');
  lines.push('每句原文与模型决策（含 `intent` / `message` 原文）：');
  lines.push('');
  lines.push('| 语料类 | 连接 id | 说的话 | 决策 | 调用的工具 | intent 原文 | message 原文 | 模型文字 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of snapshot.r3) {
    const message = r.interruptMessage ?? r.sendMessage;
    lines.push(
      `| ${r.kind} | \`${r.reading.connectionId}\` | 「${cell(r.text)}」 | **${r.decision}** | ${r.callNames.join(', ') || '（无）'} | ${r.interruptIntent === null ? '—' : cell(r.interruptIntent)} | ${message === null ? '—' : cell(message)} | ${r.modelTexts.length === 0 ? '—' : cell(r.modelTexts.join(' / '))} |`,
    );
  }
  lines.push('');
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function plan(corpus: Corpus, capCny: number): void {
  const tts = corpus.r1.speechBefore.length + corpus.r1.speechAfter.length + corpus.r2.phrases.length + corpus.r3.items.length;
  const conns = 1 + corpus.r2.arms.length + corpus.r3.items.length;
  log(`计划（不连上游、不花钱）：`);
  log(`  R-1：1 条连接（持续上传 ${corpus.r1.silenceMs / 60_000} min 底噪，前后各 ${corpus.r1.speechBefore.length} 句）`);
  log(`  R-2：${corpus.r2.arms.length} 条连接（${corpus.r2.arms.map((a) => a.id).join(', ')}），同一 ${corpus.r2.phrases.length} 句口述`);
  log(`  R-3：${corpus.r3.items.length} 条连接（每句一条；${[...new Set(corpus.r3.items.map((i) => i.kind))].join('/')} 各 ${Math.round(corpus.r3.items.length / 4)} 句）`);
  log(`  TTS：${tts} 条语料音频`);
  log(`  连接总数 ${conns}；每条连接上限 ¥${capCny.toFixed(2)}；总上限 ¥1.50`);
  log(`  预计墙钟：R-1 ≈ ${Math.round(corpus.r1.silenceMs / 60000)} min + R-2 ≈ 3 min + R-3 ≈ ${Math.round((corpus.r3.items.length * 10) / 60)} min + TTS ≈ 2 min`);
}

async function mainAsync(options: {
  workDir: string;
  journalDir: string;
  audioDir: string;
  capCny: number;
  reportPath: string;
  values: Map<string, string>;
  bools: Set<string>;
  reportPathExplicit: boolean;
}): Promise<void> {
  const { workDir, journalDir, audioDir, capCny, values } = options;
  const smoke = options.bools.has('smoke');
  for (const dir of [workDir, journalDir, audioDir]) mkdirSync(dir, { recursive: true });
  const corpus = loadCorpus();
  if (smoke) corpus.r1.silenceMs = 6_000; // 冒烟把 12 min 缩到 6 s：走完整条 R-1 代码路径，不真等 12 min
  const requested = new Set((values.get('sections') ?? 'r1,r2,r3').split(',').map((s) => s.trim()));
  const sections = smoke ? new Set<string>(['r1', 'r3']) : requested;
  const reportPath = smoke && !options.reportPathExplicit ? path.join(workDir, 'report.md') : options.reportPath;

  log(`运行目录 ${workDir}`);
  if (smoke) log('冒烟模式：R-1 静音缩到 6 s、R-3 只跑 1 句，报告写到运行目录，不碰交付物');

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  const items: SpeechItem[] = smoke
    ? [...corpus.r1.speechBefore, ...corpus.r1.speechAfter, corpus.r3.items[0]!]
    : [
        ...corpus.r1.speechBefore,
        ...corpus.r1.speechAfter,
        ...corpus.r2.phrases,
        ...corpus.r3.items,
      ];
  log(`语料 ${items.length} 条；每条连接上限 ¥${capCny.toFixed(2)}；总上限 ¥1.50`);
  log('合成语料音频 …');
  await ensureAudio(items, audioDir);

  const clips = new Map<string, Buffer>();
  for (const item of items) clips.set(item.id, loadClip(audioDir, item.id));
  const noiseBed = noiseFloor(NOISE_BED_MS);
  log(`底噪床 ${NOISE_BED_MS / 1000} s 就绪；开始分区运行`);

  let r1: R1Out | null = null;
  let r2: R2Out[] = [];
  let r3: R3Out[] = [];

  if (sections.has('r1')) {
    log(`R-1 持续上传含长静音（${Math.round(corpus.r1.silenceMs / 1000)} s）…`);
    try {
      r1 = await runR1(corpus, clips, noiseBed, capCny, journalDir);
    } catch (err) {
      log(`  [R-1] 顶层错误=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!smoke && sections.has('r2')) {
    log('R-2 两臂长口述 …');
    for (const arm of corpus.r2.arms) {
      try {
        r2.push(await runR2Arm(corpus, arm, clips, noiseBed, capCny, journalDir));
      } catch (err) {
        log(`  [R-2] ${arm.id} 顶层错误=${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (sections.has('r3')) {
    log('R-3 执行中决策分布 …');
    const r3Items = smoke ? corpus.r3.items.slice(0, 1) : corpus.r3.items;
    for (const item of r3Items) {
      try {
        r3.push(await runR3Item(corpus, item, clips.get(item.id)!, noiseBed, capCny, journalDir));
      } catch (err) {
        log(`  [R-3] ${item.id} 顶层错误=${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const pidAfter = pidOnPort(3001);
  const snapshot: Snapshot = {
    runAt: nowIso(),
    workDir,
    capCny,
    totalCapCny: 1.5,
    pidBefore,
    pidAfter,
    dryRun: true,
    scopeSweep: process.env.CLAUDE_SESSION_SCOPE_SWEEP ?? null,
    smoke,
    r1,
    r2,
    r3,
    ttsItems: items.length,
  };
  writeFileSync(path.join(workDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  const report = buildReport(snapshot);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);

  log('');
  log(`总花费 ${CNY(totalSpend(snapshot))}（连接 ${connectionCount(snapshot)} 条，每条上限 ¥${capCny.toFixed(2)}，总上限 ¥1.50）`);
  log(`:3001 pid ${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}${pidBefore !== null && pidBefore === pidAfter ? '（相同，未重启）' : ''}`);
  log(`报告已写入 ${reportPath}`);
}

function main(): void {
  process.env.CLAUDE_SESSION_SCOPE_SWEEP = process.env.CLAUDE_SESSION_SCOPE_SWEEP ?? 'off';
  const { values, bools } = readFlags(process.argv.slice(2));
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-keepalive-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const audioDir = path.join(workDir, 'audio');
  const capCny = Number(values.get('cap') ?? process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION ?? DEFAULT_CAP_CNY);
  const reportPath = values.get('report') ?? REPORT_PATH;
  const reportPathExplicit = values.has('report');

  if (bools.has('plan')) {
    plan(loadCorpus(), capCny);
    return;
  }

  if (values.has('report-only')) {
    const dir = values.get('report-only')!;
    const snapshotPath = path.join(dir, 'snapshot.json');
    if (!existsSync(snapshotPath)) throw new Error(`--report-only 找不到 ${snapshotPath}`);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
    const report = buildReport(snapshot);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
    log(`（--report-only）从 ${dir} 重建报告；未连上游。报告已写入 ${reportPath}`);
    return;
  }

  mainAsync({ workDir, journalDir, audioDir, capCny, reportPath, values, bools, reportPathExplicit }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

main();
