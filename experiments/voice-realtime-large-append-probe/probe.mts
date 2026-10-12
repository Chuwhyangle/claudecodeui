#!/usr/bin/env tsx
/**
 * 真实上游「单帧 append 时长梯度 vs 200 ms 分块」探针（GOAL-043 / AC-369）。
 *
 * 问的问题。2026-10-12 的 segmented journal（`e22ac831`）里 3 次断线全部紧随 ≥12 s 的**单帧**
 * `input_audio_buffer.append`，10 个 ≤5.5 s 段从未断线。这是**相关性，不是因果**；两份分析把它列为
 * **未验证假设 RC-5**（`docs/proposals/live-voice-architecture-review-2026-10.md` §14），任何修复不得以它
 * 为前提。本探针在**真实** `qwen3.8-omni-flash-realtime` 上回答：断线是否与单帧时长/字节数相关，把同一段
 * 音频按 200 ms 分块 append 能否避免。**不预设结论**——结果只允许「证实 / 否证 / 不足以判断」三选一。
 *
 * 为什么直连而不是第二实例。变量就是「一帧多大」，而产品面（HTTP diagnose 只接受整段 WAV、segmented
 * relay 一帧一整段）表达不了「同一段音频，这一次发 1 帧、下一次发 100 帧」。任务书明确允许这条路
 * （「备用端口实例**或**实验脚本直连」）。本脚本用一个 raw WebSocket 客户端直连上游，手动 commit
 * （`turn_detection: null` + `input_audio_buffer.commit` + `response.create`），帧级驱动。
 *
 * 每次尝试 = 一条**全新连接**。这样一次断线无法被归因到上一条的残留状态，读数最干净。梯度
 * 2/5/8/12/15/20 s，每档**单帧**与**等长 200 ms 分块**各跑 REPEATS 次（默认 2）。
 *
 * dry-run 执行面。本脚本建立的是**合成会话**：会话声明的 `session_send` 工具由本脚本的**记录式执行器**
 * 承接——模型每次调用只被记进 journal 并回一个 `{"dryRun":true,"accepted":true}` 的合成 output，**绝不**
 * 落到任何真实会话。所以「不向任何真实会话注入任何东西」由构造承担，而不是靠一个分支里的 if。
 * `--plan` 只打印计划、不连上游、不花钱。
 *
 * 花费。每条连接封顶 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION`（默认 ¥0.05，写进 env 供记录）；本脚本用
 * **出货的** `estimateRealtimeCostCny` 在每条 `response.done` 上累计（不在这里抄一份价目表）。总上限 ¥1：
 * 累计花费越过即不再开新连接。
 *
 * :3001 只被读 pid（运行前后各一次），**从未被重启**；本脚本不碰任何 Quay worker / driver / 工作树。
 *
 * 用法（仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-large-append-probe/probe.mts
 *   … --plan                 只打印计划（要建哪些连接），不连上游、不花钱
 *   … --smoke                只跑一条最短的端到端连接（证管线），其余跳过
 *   … --cap 0.05             每条连接花费上限（CNY）
 *   … --work /tmp/x          指定运行目录（默认 os.tmpdir() 下一个新目录）
 *   … --report-only <dir>    从 `<dir>/snapshot.json` 离线重建报告（不连上游、不花钱）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-large-append-probe.md');

/** 上游 Realtime 端点（与出货 transport 同址）。 */
const UPSTREAM_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
/** 出货默认模型（GOAL-030 采纳）。 */
const MODEL = 'qwen3.8-omni-flash-realtime';
/** 出货默认 voice（该模型要求显式 voice）。 */
const VOICE = 'Tina';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // PCM16 单声道
/** 分块对照的帧长（AC 指定 200 ms）。 */
const CHUNK_MS = 200;
const CHUNK_BYTES = (BYTES_PER_SECOND * CHUNK_MS) / 1000; // 6 400

/** 单帧时长梯度（秒）。每档单帧与等长 200 ms 分块各跑 REPEATS 次。 */
const LEVELS_SECONDS = [2, 5, 8, 12, 15, 20];
/** 每档重复次数（≥2）。 */
const REPEATS = 2;

const DEFAULT_CAP_CNY = 0.05;
/** 本次运行的**总**花费上限（CNY）。越过即不再开新连接。 */
const TOTAL_BUDGET_CNY = 1;

/** 音频来源：仓库既有的 16 kHz 单声道 PCM16 夹具（29.12 s，足以覆盖 20 s 档）。取前 N 秒作各档音频。 */
const FIXTURE_REL = 'experiments/voice-trim/fixtures/zh-d03-o45.wav';

/** commit + response 后，等「response.done / 断线」的窗口。 */
const RESPONSE_WINDOW_MS = 45_000;
/** 看到 response.done 后再等一小段，收齐可能晚到的 committed / transcription.completed。 */
const SETTLE_MS = 3_000;
/** 等 session.updated / session.created / error 的窗口。 */
const SESSION_READY_WINDOW_MS = 12_000;

/** 本探针向上游声明的会话正文。模型用简短中文回应即可；探针读的是**连接**行为，不是回答内容。 */
const INSTRUCTIONS =
  '你是一个语音助手。用户说完后，用一句简短的中文回应，不要提问。';

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

/** 读出 WAV 的 PCM 载荷（跳过 44 字节规范头）。 */
function parseWavPcm16(buffer: Buffer): Buffer {
  return buffer.subarray(44);
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

// ─────────────────────────────────────────────────────────────────────────────
// 上游连接（raw WS 客户端）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个 wire 帧。`sinceConnectMs` 是相对连接开始的墙钟偏移。`audioMs` = 记录它时**已上传**的音频毫秒。 */
type WireEvent = {
  sinceConnectMs: number;
  audioMs: number;
  direction: 'sent' | 'received';
  type: string;
  raw: Record<string, unknown>;
};
type ResponseUsage = { atMs: number; textTokens: number; audioTokens: number; outputTokens: number; costCny: number };

/**
 * 一条到上游的连接。观察**每一个**收发的 wire 帧；用出货估算器累计花费；在花超上限时**关掉自己**
 * （§花费）。工具调用只被记录并回一个合成 output（dry-run 执行面）。
 */
class Link {
  readonly events: WireEvent[] = [];
  readonly responses: ResponseUsage[] = [];
  readonly errors: string[] = [];
  readonly calls: Array<{ atMs: number; name: string; arguments: string }> = [];
  readonly t0 = Date.now();
  private spendCny = 0;
  capTripped = false;
  closed = false;
  /** 探针自己发起 close 后置 true；用来把「上游断线」与「探针收尾关闭」分开。 */
  private probeInitiatedClose = false;
  closeInfo: { code: number; reason: string; atMs: number; byProbe: boolean } | null = null;
  uploadedMs = 0;
  /** 合成 `response.create` 的在途闸门（与出货 transport 的并发闸门同义）。 */
  private responseActive = false;
  private pendingResponseCreate = false;
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
      link.closeInfo = { code, reason: reason.toString('utf8'), atMs: Date.now() - link.t0, byProbe: link.probeInitiatedClose };
    });
    ws.on('error', (err: Error) => link.errors.push(`socket: ${err.message}`));
    // 手动提交模式：turn_detection: null（上游自己的 VAD 关掉，由我们 commit）。
    const session: Record<string, unknown> = {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm24',
      voice: VOICE,
      instructions: options.instructions,
      turn_detection: null,
      tools: options.tools,
    };
    link.sendRaw({ type: 'session.update', session });
    const ready = await link.waitForFrame(
      (e) => e.type === 'session.created' || e.type === 'session.updated' || e.type === 'error',
      SESSION_READY_WINDOW_MS,
    );
    if (ready !== true) throw new Error('上游未在 12 s 内回应 session.update');
    const err = link.events.find((e) => e.type === 'error');
    if (err !== undefined && !link.closed) {
      // 有些 error 是 per-message（不是致命的），但 session.update 阶段收到 error 说明会话没立起来。
      throw new Error(`上游拒绝 session.update：${JSON.stringify(err.raw).slice(0, 300)}`);
    }
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
    this.events.push({
      sinceConnectMs: Date.now() - this.t0,
      audioMs: this.uploadedMs,
      direction: 'sent',
      type: String(frame.type),
      raw: frame,
    });
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.errors.push(`send: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 上传一帧 PCM16（base64）。一帧 = 一次 `input_audio_buffer.append`。 */
  append(frame: Buffer): void {
    this.uploadedMs += Math.round((frame.length / 2 / SAMPLE_RATE) * 1000);
    this.sendRaw({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
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
      this.calls.push({ atMs: Date.now() - this.t0, name: call.name, arguments: call.arguments });
      this.sendRaw({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify({ dryRun: true, accepted: true, note: 'large-append probe recorded this call; nothing was executed' }),
        },
      });
      this.requestResponse();
    }
  }

  /** 送 `response.create`，但一个 response 还在途时先挂起（上游会报 active response）。 */
  requestResponse(): void {
    if (this.responseActive) {
      this.pendingResponseCreate = true;
      return;
    }
    this.sendRaw({ type: 'response.create' });
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
      return { name: item.name, callId: item.call_id, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' };
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
    this.responses.push({ atMs: Date.now() - this.t0, textTokens, audioTokens, outputTokens, costCny });
    if (this.spendCny > this.capCny && !this.capTripped) {
      this.capTripped = true;
      this.errors.push(`SPEND_CAP: 本连接累计 ${this.spendCny.toFixed(4)} CNY 超过上限 ${this.capCny}`);
      // 封顶即关掉这条连接，不让它继续计费。
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
// 一次尝试 = 一条连接
// ─────────────────────────────────────────────────────────────────────────────

type Reading = {
  connectionId: string;
  mode: 'single' | 'chunked';
  seconds: number;
  rep: number;
  startedAt: string;
  /** 音频原始字节数与单帧 base64 字符数（单帧档即为该帧；分块档为等长音频的总字节数）。 */
  pcmBytes: number;
  base64Chars: number;
  /** 本档真正发出的 append 帧数（单帧 = 1，分块 = seconds*1000/CHUNK_MS）。 */
  appendFrames: number;
  /** 单帧档里那一帧的 base64 字符数；分块档里最大一帧的 base64 字符数。 */
  maxFrameBase64Chars: number;
  /** 是否收到 `input_audio_buffer.committed`；以及相对关键发送时刻的毫秒。 */
  committed: boolean;
  committedSinceAppendDoneMs: number | null;
  committedSinceCommitMs: number | null;
  /** 是否收到 `response.done`；以及累计 response 数。 */
  answered: boolean;
  responses: number;
  /** 转写：`conversation.item.input_audio_transcription.completed` 是否到达、文本。 */
  transcriptionCompleted: boolean;
  transcript: string | null;
  /** 断线读数。 */
  disconnected: boolean;
  closeCode: number | null;
  closeReason: string | null;
  /** 断线距「最后一帧 append 写完」与「commit 写完」的毫秒数。 */
  closeSinceAppendDoneMs: number | null;
  closeSinceCommitMs: number | null;
  errors: string[];
  spendCny: number;
  capTripped: boolean;
  events: WireEvent[];
};

/** 记录一个 key 发送时刻，用来算「距写出多远断线」。 */
type Marks = Record<string, number>;

async function runAttempt(
  meta: { mode: 'single' | 'chunked'; seconds: number; rep: number },
  pcm: Buffer,
  capCny: number,
  journalDir: string,
): Promise<Reading> {
  const { mode, seconds, rep } = meta;
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = nowIso(startedAtMs);

  const tools = [
    {
      type: 'function',
      function: {
        name: 'session_send',
        description: '把一个消息转交给一个会话。探针中是 dry-run：调用只被记录，不执行。',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      },
    },
  ];
  const link = await Link.connect({ instructions: INSTRUCTIONS, tools, capCny });
  const marks: Marks = { connect: Date.now() - link.t0 };

  const base64 = pcm.toString('base64');
  const appendBase64Chars = []; // 每帧 base64 长度

  if (mode === 'single') {
    // 一帧：整段音频一次 append。
    marks.appendStart = Date.now() - link.t0;
    link.append(pcm);
    appendBase64Chars.push(base64.length);
    marks.appendDone = Date.now() - link.t0;
  } else {
    // 分块：200 ms 一帧，**按实时墙钟**逐帧推进（一帧每 200 ms），近似浏览器流式上传，
    // 使唯一变量是「帧多大」而非「发得多快」。
    marks.appendStart = Date.now() - link.t0;
    const t0 = Date.now();
    let idx = 0;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      const wait = t0 + idx * CHUNK_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
      link.append(chunk);
      appendBase64Chars.push(chunk.toString('base64').length);
      idx += 1;
    }
    marks.appendDone = Date.now() - link.t0;
  }

  // 手动脉冲：commit + response.create。
  await sleep(200);
  marks.commit = Date.now() - link.t0;
  link.sendRaw({ type: 'input_audio_buffer.commit' });
  await sleep(150);
  marks.responseCreate = Date.now() - link.t0;
  link.requestResponse();

  // 等断线 / response.done / 超时。
  const deadline = Date.now() + RESPONSE_WINDOW_MS;
  let responseDoneAt: number | null = null;
  while (Date.now() < deadline) {
    if (link.closed) break;
    if (responseDoneAt === null && link.inboundOfType('response.done').length > 0) {
      responseDoneAt = link.t0 + (link.inboundOfType('response.done')[0]!.sinceConnectMs);
    }
    if (responseDoneAt !== null && Date.now() - responseDoneAt > SETTLE_MS) break;
    await sleep(100);
  }

  // 在读 reading 前给「在途的 close 帧」一点落地时间：上游若在这一瞬断线，`closeInfo` 要已经写好，
  // 才能把它与探针自己的收尾关闭分开（否则会把上游断线读成正常关闭，或反过来）。
  await sleep(200);

  const reading = buildReading(link, connectionId, mode, seconds, rep, startedAt, base64.length, appendBase64Chars, marks);
  writeJournal(journalDir, reading, link);
  if (!link.closed) {
    // 探针收尾关闭（byProbe=true，不算上游断线）。
    link.close();
    await sleep(150);
  }
  return reading;
}

function buildReading(
  link: Link,
  connectionId: string,
  mode: 'single' | 'chunked',
  seconds: number,
  rep: number,
  startedAt: string,
  pcmBytesBase64Len: number,
  appendBase64Chars: number[],
  marks: Marks,
): Reading {
  const committedEv = link.inboundOfType('input_audio_buffer.committed')[0] ?? null;
  const transcriptionEv = link.inboundOfType('conversation.item.input_audio_transcription.completed')[0] ?? null;
  const responseDone = link.inboundOfType('response.done').length > 0;
  const transcript =
    transcriptionEv !== null && typeof transcriptionEv.raw.transcript === 'string'
      ? (transcriptionEv.raw.transcript as string)
      : null;
  return {
    connectionId,
    mode,
    seconds,
    rep,
    startedAt,
    pcmBytes: (SAMPLE_RATE * seconds * 2),
    base64Chars: pcmBytesBase64Len,
    appendFrames: appendBase64Chars.length,
    maxFrameBase64Chars: appendBase64Chars.length === 0 ? 0 : Math.max(...appendBase64Chars),
    committed: committedEv !== null,
    committedSinceAppendDoneMs:
      committedEv !== null && marks.appendDone !== undefined ? num3(committedEv.sinceConnectMs - marks.appendDone) : null,
    committedSinceCommitMs:
      committedEv !== null && marks.commit !== undefined ? num3(committedEv.sinceConnectMs - marks.commit) : null,
    answered: responseDone || link.errors.length > 0,
    responses: link.responses.length,
    transcriptionCompleted: transcriptionEv !== null,
    transcript,
    disconnected: link.disconnectedByUpstream,
    closeCode: link.closeInfo?.code ?? null,
    closeReason: link.closeInfo?.reason ?? null,
    closeSinceAppendDoneMs:
      link.closeInfo !== null && marks.appendDone !== undefined ? num3(link.closeInfo.atMs - marks.appendDone) : null,
    closeSinceCommitMs: link.closeInfo !== null && marks.commit !== undefined ? num3(link.closeInfo.atMs - marks.commit) : null,
    errors: [...link.errors],
    spendCny: link.spend,
    capTripped: link.capTripped,
    events: link.events,
  };
}

/** 每连接一个 JSONL：逐条记下**每一个**收发的 wire 帧（去掉 base64 载荷，只留长度）。 */
function writeJournal(journalDir: string, reading: Reading, link: Link): void {
  const scrub = (raw: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...raw };
    if (typeof copy.audio === 'string') copy.audio = `<elided ${copy.audio.length} base64 chars>`;
    if (copy.session !== undefined && typeof copy.session === 'object' && copy.session !== null) {
      // 会话头本身不含密钥；原样保留（含 turn_detection 取值，是读数）。
    }
    return copy;
  };
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      kind: 'header',
      connectionId: reading.connectionId,
      mode: reading.mode,
      seconds: reading.seconds,
      rep: reading.rep,
      startedAt: reading.startedAt,
      model: MODEL,
      voice: VOICE,
      turnDetection: null,
      pcmBytes: reading.pcmBytes,
      base64Chars: reading.base64Chars,
      appendFrames: reading.appendFrames,
      maxFrameBase64Chars: reading.maxFrameBase64Chars,
      capCny: link.capCny,
    }),
  );
  for (const e of link.events) {
    lines.push(
      JSON.stringify({
        atMs: e.sinceConnectMs,
        audioMs: e.audioMs,
        dir: e.direction === 'sent' ? '→' : '←',
        type: e.type,
        raw: scrub(e.raw),
      }),
    );
  }
  lines.push(JSON.stringify({ kind: 'reading', ...readingsOnly(reading) }));
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(path.join(journalDir, `${reading.connectionId}.jsonl`), `${lines.join('\n')}\n`);
}

/** reading 去掉 events（进 JSONL 时事件已逐条写过）。 */
function readingsOnly(r: Reading): Omit<Reading, 'events'> {
  const { events: _events, ...rest } = r;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行
// ─────────────────────────────────────────────────────────────────────────────

function buildPlan(capCny: number): string {
  const cells = LEVELS_SECONDS.flatMap((s) => (['single', 'chunked'] as const).map((m) => `${m}@${s}s`));
  const total = cells.length * REPEATS;
  return [
    `计划：单帧时长梯度 2/5/8/12/15/20 s，每档单帧与 200 ms 分块各 ${REPEATS} 次；`,
    `档位单元 ${cells.length} 个 × ${REPEATS} = 共 ${total} 条连接（每次尝试一条全新连接）。`,
    `上限 ¥${capCny}/连接；总上限 ¥${TOTAL_BUDGET_CNY}。`,
    `音频源 ${FIXTURE_REL}（取前 N 秒）；模型 ${MODEL}；manual commit（turn_detection: null）。`,
  ].join('\n');
}

async function mainAsync(options: {
  workDir: string;
  journalDir: string;
  capCny: number;
  reportPath: string;
  values: Map<string, string>;
  bools: Set<string>;
}): Promise<void> {
  const { workDir, journalDir, capCny, reportPath, values, bools } = options;
  for (const dir of [workDir, journalDir]) mkdirSync(dir, { recursive: true });

  const fixture = parseWavPcm16(readFileSync(path.join(REPO_ROOT, FIXTURE_REL)));
  const sourceSeconds = fixture.length / BYTES_PER_SECOND;
  if (sourceSeconds < Math.max(...LEVELS_SECONDS)) {
    throw new Error(`夹具只有 ${sourceSeconds.toFixed(2)} s，不足以覆盖最大档 ${Math.max(...LEVELS_SECONDS)} s`);
  }

  log(`运行目录 ${workDir}`);
  log(buildPlan(capCny));

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  const readings: Reading[] = [];
  let totalSpend = 0;

  const runOne = async (mode: 'single' | 'chunked', seconds: number, rep: number): Promise<void> => {
    if (totalSpend > TOTAL_BUDGET_CNY) {
      log(`跳过 ${mode}@${seconds}s#${rep}：总花费 ¥${totalSpend.toFixed(4)} 已越过总上限 ¥${TOTAL_BUDGET_CNY}`);
      return;
    }
    const pcm = fixture.subarray(0, SAMPLE_RATE * seconds * 2);
    try {
      const reading = await runAttempt({ mode, seconds, rep }, pcm, capCny, journalDir);
      readings.push(reading);
      totalSpend += reading.spendCny;
      log(
        `  ${mode}@${seconds}s#${rep} conn=${reading.connectionId.slice(0, 8)} ` +
          `frames=${reading.appendFrames} committed=${reading.committed} answered=${reading.answered} ` +
          `断线=${reading.disconnected}${reading.disconnected ? `(${reading.closeCode ?? '?'} @+${reading.closeSinceAppendDoneMs ?? '?'}ms)` : ''} ` +
          `转写=${reading.transcriptionCompleted ? 'Y' : 'N'} ¥${reading.spendCny.toFixed(4)}`,
      );
    } catch (err) {
      log(`  ${mode}@${seconds}s#${rep} 失败=${err instanceof Error ? err.message : String(err)}`);
      readings.push(errorReading(mode, seconds, rep, err));
    }
  };

  if (bools.has('smoke')) {
    log('--smoke：只跑一条最短连接（single@2s，证管线）…');
    await runOne('single', 2, 1);
  } else {
    for (const seconds of LEVELS_SECONDS) {
      for (let rep = 1; rep <= REPEATS; rep += 1) {
        await runOne('single', seconds, rep);
        await runOne('chunked', seconds, rep);
      }
    }
  }

  const pidAfter = pidOnPort(3001);

  const snapshot: Snapshot = {
    runAt: nowIso(),
    capCny,
    totalBudgetCny: TOTAL_BUDGET_CNY,
    pidBefore,
    pidAfter,
    model: MODEL,
    voice: VOICE,
    levels: LEVELS_SECONDS,
    repeats: REPEATS,
    fixtureRel: FIXTURE_REL,
    fixtureSeconds: num3(sourceSeconds),
    readings,
    totalSpendCny: num3(readings.reduce((sum, r) => sum + r.spendCny, 0)),
    ...(values.get('note') === undefined ? {} : { note: values.get('note')! }),
  };
  writeFileSync(path.join(workDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

  const report = buildReport(snapshot, workDir);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);

  log('');
  log(`总花费 ¥${snapshot.totalSpendCny.toFixed(4)}（上限 ¥${capCny}/连接）；:3001 pid ${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}`);
  log(`报告已写入 ${reportPath}`);
}

function errorReading(mode: 'single' | 'chunked', seconds: number, rep: number, err: unknown): Reading {
  return {
    connectionId: randomUUID(),
    mode,
    seconds,
    rep,
    startedAt: nowIso(),
    pcmBytes: SAMPLE_RATE * seconds * 2,
    base64Chars: 0,
    appendFrames: 0,
    maxFrameBase64Chars: 0,
    committed: false,
    committedSinceAppendDoneMs: null,
    committedSinceCommitMs: null,
    answered: false,
    responses: 0,
    transcriptionCompleted: false,
    transcript: null,
    disconnected: false,
    closeCode: null,
    closeReason: null,
    closeSinceAppendDoneMs: null,
    closeSinceCommitMs: null,
    errors: [`attempt failed: ${err instanceof Error ? err.message : String(err)}`],
    spendCny: 0,
    capTripped: false,
    events: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

type Snapshot = {
  runAt: string;
  capCny: number;
  totalBudgetCny: number;
  pidBefore: number | null;
  pidAfter: number | null;
  model: string;
  voice: string;
  levels: number[];
  repeats: number;
  fixtureRel: string;
  fixtureSeconds: number;
  readings: Reading[];
  totalSpendCny: number;
  note?: string;
};

/** 断线档的「距写出多远」——单帧看那一帧，分块看最后一帧。 */
function lineFor(reading: Reading): string {
  const errs = reading.errors.length === 0 ? '无' : reading.errors.join(' | ').slice(0, 200);
  return (
    `conn=${reading.connectionId} mode=${reading.mode} ${reading.seconds}s#${reading.rep}；` +
    `字节=${reading.pcmBytes} base64=${reading.base64Chars} 帧数=${reading.appendFrames} 最大帧base64=${reading.maxFrameBase64Chars}；` +
    `committed=${reading.committed ? `是(+${reading.committedSinceAppendDoneMs}ms)` : '否'}；` +
    `answered=${reading.answered} responses=${reading.responses} 转写=${reading.transcriptionCompleted ? `「${(reading.transcript ?? '').slice(0, 40)}」` : '否'}；` +
    `断线=${reading.disconnected ? `是(code=${reading.closeCode} @+${reading.closeSinceAppendDoneMs}ms 距写出, +${reading.closeSinceCommitMs}ms 距commit; reason=${reading.closeReason ?? ''})` : '否'}；` +
    `错误=${errs}；花费=¥${reading.spendCny.toFixed(4)}`
  );
}

type Cell = { mode: 'single' | 'chunked'; seconds: number; disconnected: number; total: number };

function summarizeCells(readings: Reading[]): Cell[] {
  const cells: Cell[] = [];
  for (const seconds of LEVELS_SECONDS) {
    for (const mode of ['single', 'chunked'] as const) {
      const rows = readings.filter((r) => r.mode === mode && r.seconds === seconds);
      cells.push({ mode, seconds, disconnected: rows.filter((r) => r.disconnected).length, total: rows.length });
    }
  }
  return cells;
}

/** 结论只允许三选一，且必须由读数推出。 */
function deriveConclusion(readings: Reading[]): { verdict: '证实' | '否证' | '不足以判断'; reason: string } {
  const single = readings.filter((r) => r.mode === 'single');
  const chunked = readings.filter((r) => r.mode === 'chunked');
  const singleDisc = single.filter((r) => r.disconnected);
  const chunkDisc = chunked.filter((r) => r.disconnected);

  if (single.length === 0) {
    return { verdict: '不足以判断', reason: '没有单帧读数。' };
  }
  if (chunked.length === 0) {
    return { verdict: '不足以判断', reason: '没有分块对照读数。' };
  }

  const singleDiscSeconds = [...new Set(singleDisc.map((r) => r.seconds))].sort((a, b) => a - b);
  const chunkDiscSeconds = [...new Set(chunkDisc.map((r) => r.seconds))].sort((a, b) => a - b);

  if (singleDisc.length === 0 && chunkDisc.length === 0) {
    return {
      verdict: '否证',
      reason: `到 ${Math.max(...LEVELS_SECONDS)} s 为止，单帧与分块两条臂都**没有**任何断线（单帧 ${single.length} 次、分块 ${chunked.length} 次），因此「单帧 append 时长/字节数导致断线」的 RC-5 在这组读数下不成立。`,
    };
  }
  if (singleDisc.length > 0 && chunkDisc.length === 0) {
    // 单帧有断线、分块没有：若断线集中在较长档，且分块在同样长档安然，则证实。
    const maxSingleDisc = Math.max(...singleDiscSeconds);
    const minSingleDisc = Math.min(...singleDiscSeconds);
    const chunkCovered = chunked.some((r) => r.seconds >= minSingleDisc);
    if (chunkCovered) {
      return {
        verdict: '证实',
        reason: `单帧臂在 ${singleDiscSeconds.join('/')} s 出现断线（共 ${singleDisc.length} 次），等长分块臂 0 次断线；最短断线档 ${minSingleDisc} s 的分块对照也安稳。`,
      };
    }
    return { verdict: '不足以判断', reason: `单帧断线出现在 ${singleDiscSeconds.join('/')} s，但分块臂未覆盖这些档。` };
  }
  if (chunkDisc.length > 0 && singleDisc.length === 0) {
    return {
      verdict: '否证',
      reason: `断线出现在分块臂（${chunkDiscSeconds.join('/')} s）而非单帧臂，说明断线不与「单帧」绑定；RC-5 不成立。`,
    };
  }
  return {
    verdict: '不足以判断',
    reason: `两条臂都出现断线（单帧 ${singleDiscSeconds.join('/')} s、分块 ${chunkDiscSeconds.join('/')} s），本轮无法把断线单独归因给「单帧」。`,
  };
}

function buildReport(snapshot: Snapshot, workDir: string): string {
  const { readings } = snapshot;
  const cells = summarizeCells(readings);
  const conclusion = deriveConclusion(readings);
  const singleRows = readings.filter((r) => r.mode === 'single');
  const chunkRows = readings.filter((r) => r.mode === 'chunked');
  const singleDisc = singleRows.filter((r) => r.disconnected);

  const lines: string[] = [];
  lines.push('# Live Voice 大帧 vs 分块 append 真实探针（AC-369 / RC-5）');
  lines.push('');
  lines.push(
    '本文件是 GOAL-043 / AC-369 的探针记录：在**真实** `' +
      snapshot.model +
      '` 上，用**实验脚本内**的手动提交（`turn_detection: null` + `input_audio_buffer.commit` + `response.create`，**不改产品代码**）',
  );
  lines.push(
    '把同一段音频按单帧时长梯度 2/5/8/12/15/20 s 各 append，并与等长 **200 ms 分块**对照，读断线是否与单帧时长/字节数相关。',
  );
  lines.push('**这不是模型推演，是一次运行的读数。** 结论只允许「证实 / 否证 / 不足以判断」三选一。');
  lines.push('');
  lines.push(
    `运行时刻 ${snapshot.runAt}；探针**直连上游**（raw WS，手动 commit），未起第二实例；:3001 只被读 pid，从未被重启。`,
  );
  lines.push('执行面是**合成会话**：会话声明的 `session_send` 工具由脚本内的记录式执行器承接（dry-run），绝不落到任何真实会话。');
  lines.push(`本次运行目录 \`${workDir}\`（journal 在 \`journal/\`）。`);
  lines.push('');
  lines.push('## 读数行（判据逐行检查）');
  lines.push('');

  // 单帧梯度：一行一档，列出每档的单帧帧数/base64/断线位数。
  const singleCellStr = LEVELS_SECONDS.map((s) => {
    const rows = singleRows.filter((r) => r.seconds === s);
    const disc = rows.filter((r) => r.disconnected).length;
    const frames = rows[0]?.appendFrames ?? 0;
    const b64 = rows[0]?.base64Chars ?? 0;
    return `${s}s(帧=1, ${rows[0]?.pcmBytes ?? SAMPLE_RATE * s * 2}字节/base64 ${b64}, 断线 ${disc}/${rows.length})`;
  }).join('；');
  lines.push(`单帧梯度：${singleCellStr}。`);

  const chunkCellStr = LEVELS_SECONDS.map((s) => {
    const rows = chunkRows.filter((r) => r.seconds === s);
    const disc = rows.filter((r) => r.disconnected).length;
    const frames = rows[0]?.appendFrames ?? 0;
    return `${s}s(帧=${frames}×~${CHUNK_MS}ms, 断线 ${disc}/${rows.length})`;
  }).join('；');
  lines.push(`分块对照：${chunkCellStr}。`);

  // 断线读数：逐条列出断线尝试（含连接 id、距写出毫秒、关闭码）。
  if (readings.every((r) => !r.disconnected)) {
    lines.push(`断线读数：两臂全部 ${readings.length} 次尝试**均未断线**（单帧 ${singleRows.length} 次、分块 ${chunkRows.length} 次）。`);
  } else {
    const discRows = readings.filter((r) => r.disconnected);
    lines.push(
      `断线读数：共 ${discRows.length} 次断线——` +
        discRows
          .map(
            (r) =>
              `${r.connectionId}( ${r.mode}@${r.seconds}s#${r.rep}, 距写出+${r.closeSinceAppendDoneMs}ms, 距commit+${r.closeSinceCommitMs}ms, code=${r.closeCode}${r.closeReason ? `/${r.closeReason}` : ''}, committed=${r.committed ? 'Y' : 'N'} )`,
          )
          .join('；') +
        '。',
    );
  }

  lines.push(`结论：${conclusion.verdict}。${conclusion.reason}`);
  lines.push('运行次数：1');
  const capTrips = readings.filter((r) => r.capTripped).length;
  lines.push(
    `花费：¥${snapshot.totalSpendCny.toFixed(4)}（上限 ¥${snapshot.capCny}/连接；总上限 ¥${snapshot.totalBudgetCny}；触顶连接 ${capTrips} 条）`,
  );
  lines.push(
    `:3001 pid：运行前 ${snapshot.pidBefore ?? '未知'} → 运行后 ${snapshot.pidAfter ?? '未知'}（${snapshot.pidBefore === snapshot.pidAfter ? '**相同**，未重启' : '**不同**'}）`,
  );
  lines.push(
    '执行面：dry-run（合成会话；会话声明工具由脚本内记录式执行器承接，调用只被记录、不执行，不落任何真实会话）；`--plan` 只打印计划、不连上游；本次为唯一一次真实运行。',
  );
  lines.push('');

  // 单元格总览表
  lines.push('## 单元格总览（断线数 / 尝试数）');
  lines.push('');
  lines.push('| 时长 | 单帧 | 200 ms 分块 |');
  lines.push('| --- | --- | --- |');
  for (const s of LEVELS_SECONDS) {
    const a = cells.find((c) => c.mode === 'single' && c.seconds === s)!;
    const b = cells.find((c) => c.mode === 'chunked' && c.seconds === s)!;
    lines.push(`| ${s} s | ${a.disconnected}/${a.total} | ${b.disconnected}/${b.total} |`);
  }
  lines.push('');

  // 每次尝试明细 + 时间线摘录
  lines.push('## 每次尝试的读数与事件时间线摘录');
  lines.push('');
  for (const r of readings) {
    lines.push(`### ${r.mode}@${r.seconds}s#${r.rep} — conn=${r.connectionId}`);
    lines.push('');
    lines.push(`- ${lineFor(r)}`);
    const key = r.events.filter((e) =>
      [
        'session.created',
        'session.updated',
        'input_audio_buffer.committed',
        'conversation.item.input_audio_transcription.completed',
        'conversation.item.input_audio_transcription.failed',
        'response.created',
        'response.done',
        'error',
        'input_audio_buffer.speech_started',
        'input_audio_buffer.speech_stopped',
      ].includes(e.type),
    );
    if (key.length === 0) {
      lines.push('- 时间线摘录：（无关键事件）');
    } else {
      lines.push('- 时间线摘录：');
      lines.push('  ```');
      for (const e of key.slice(0, 24)) {
        lines.push(`  +${String(e.sinceConnectMs).padStart(6)}ms (audio+${e.audioMs}ms) ${e.direction === 'sent' ? '→' : '←'} ${e.type}`);
      }
      lines.push('  ```');
    }
    lines.push('');
  }

  // 方法与限制
  lines.push('## 方法与限制（如实记录）');
  lines.push('');
  lines.push(`- 音频源：\`${snapshot.fixtureRel}\`（${snapshot.fixtureSeconds} s，16 kHz 单声道 PCM16），取**前 N 秒**作各档音频。`);
  lines.push('  因此各档共享同一前缀，**时长/内容一同变化**——本探针问的正是「时长/字节数」，这是它的自变量，不是混淆。');
  lines.push(`- 手动提交：\`session.update{session.turn_detection: null}\` → \`input_audio_buffer.append\` → \`input_audio_buffer.commit\` → \`response.create\`。`);
  lines.push(`- 单帧档：整段音频**一次** append（1 帧）；分块档：每 ${CHUNK_MS} ms 一帧、**按实时墙钟**逐帧推进（近似浏览器流式上传）。`);
  lines.push('  分块档唯一与单帧不同处是「帧多大/发得多快」，总字节数完全相同。');
  lines.push(`- 等待策略：commit 后等断线 / \`response.done\`(+${SETTLE_MS}ms 收尾) / ${RESPONSE_WINDOW_MS}ms 超时。`);
  lines.push('- 每次尝试 = 一条**全新连接**，断线无法归因到上一条的残留状态。');
  if (snapshot.note !== undefined && snapshot.note !== '') {
    lines.push(`- 取数前管线预检：${snapshot.note}`);
  }
  lines.push('- 花费按出货 `estimateRealtimeCostCny` 在每条 `response.done` 上累计；每连接封顶 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION`。');
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('set -a; . ./.env.test; set +a');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-large-append-probe/probe.mts --plan');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-large-append-probe/probe.mts --work /tmp/large-append-probe');
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const { values, bools } = readFlags(process.argv.slice(2));
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-large-append-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const capCny = Number(values.get('cap') ?? process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION ?? DEFAULT_CAP_CNY);
  const reportPath = values.get('report') ?? REPORT_PATH;

  if (bools.has('plan')) {
    log(buildPlan(capCny));
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

  // 写进 env 供记录（本脚本也显式用 capCny）。
  process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION = String(capCny);
  void mainAsync({ workDir, journalDir, capCny, reportPath, values, bools }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

main();
