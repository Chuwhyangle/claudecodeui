#!/usr/bin/env tsx
/**
 * 真实上游「连接历史 + 空闲间隔」断线探针（追加 AC-369 / RC-5 之后的诊断）。
 *
 * 问的问题。AC-369 在**全新连接**上测过「单帧 append 时长/字节数」，2–20 s 单帧 24 次尝试 0 次断线，
 * RC-5（帧大小导致断线）被否证。但 2026-10-13 第三次语音测试的真实 journal（`0d2e6d93…`）里，4 段
 * 17–20 s 的**单帧** commit 全部断线——且全部发生在**已经处理过至少一轮**、且前面有 ~17–19 s **空闲**
 * 的连接上，不是全新连接。AC-369 从未变过「连接历史 / 空闲间隔」这个自变量。本探针把它单独测出来：
 * 同一条连接先做一轮短对话（像真实 segment 0/1），空闲 IDLE_MS，再 append 一个大单帧并 commit（像真实
 * seq=2/3/7），对照一条**全新**连接直接 append 同样大小的单帧（= AC-369 的方法论，作为本次运行内的对照臂）。
 * **不预设结论**——结果只允许「证实 / 否证 / 不足以判断」三选一。
 *
 * 为什么直连而不是产品代码。变量是「连接的历史/空闲」，产品面没有旋钮能在同一条连接上先对话、空闲、
 * 再发大段而不经过 VAD/分段逻辑。本脚本像 AC-369 一样用 raw WebSocket 直连上游，手动提交
 * （`turn_detection: null` + `input_audio_buffer.commit` + `response.create`）。
 *
 * dry-run 执行面：会话声明的 `session_send` 工具由脚本内记录式执行器承接，调用只被记进 journal、回一个
 * 合成 output，绝不落到任何真实会话。`--plan` 只打印计划、不连上游、不花钱。
 *
 * 花费：每条连接封顶 `--cap`（默认 ¥0.05）；总上限 ¥1，越过即不再开新连接。:3001 只被读 pid，从未被
 * 重启；本脚本不碰任何 Quay worker / driver / 工作树。
 *
 * 用法（仓库根）：
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-idle-history-probe/probe.mts --plan
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-idle-history-probe/probe.mts --work /tmp/idle-history-probe
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
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-idle-history-probe.md');

const UPSTREAM_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const MODEL = 'qwen3.8-omni-flash-realtime';
const VOICE = 'Tina';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // PCM16 单声道

/** 第一轮（热身，像真实 segment 0/1）的时长：AC-369 里这个时长 0/2 断线，是已知安全点。 */
const FIRST_TURN_SECONDS = 2;
/** 第二段（真正观测的大单帧）的时长：落在真实 journal 4 次断线（17.06/19.66/18.12/10.52 s）的区间内。 */
const SECOND_SEGMENT_SECONDS = 18;
/** 第一轮结束到第二段开始之间的空闲毫秒：真实 journal 里四次断线前的空闲分别是 ~18.8/~19.4/~19.4/~16.7 s。 */
const IDLE_MS = 18_000;
/** 每臂重复次数。 */
const REPEATS = 3;

const DEFAULT_CAP_CNY = 0.05;
const TOTAL_BUDGET_CNY = 1;

const FIXTURE_REL = 'experiments/voice-trim/fixtures/zh-d03-o45.wav';

const RESPONSE_WINDOW_MS = 45_000;
const SETTLE_MS = 3_000;
const SESSION_READY_WINDOW_MS = 12_000;

const INSTRUCTIONS = '你是一个语音助手。用户说完后，用一句简短的中文回应，不要提问。';

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
// 上游连接（raw WS 客户端）—— 与 AC-369 探针同一套 Link 实现
// ─────────────────────────────────────────────────────────────────────────────

type WireEvent = {
  sinceConnectMs: number;
  audioMs: number;
  direction: 'sent' | 'received';
  type: string;
  raw: Record<string, unknown>;
};
type ResponseUsage = { atMs: number; textTokens: number; audioTokens: number; outputTokens: number; costCny: number };

class Link {
  readonly events: WireEvent[] = [];
  readonly responses: ResponseUsage[] = [];
  readonly errors: string[] = [];
  readonly calls: Array<{ atMs: number; name: string; arguments: string }> = [];
  readonly t0 = Date.now();
  private spendCny = 0;
  capTripped = false;
  closed = false;
  private probeInitiatedClose = false;
  closeInfo: { code: number; reason: string; atMs: number; byProbe: boolean } | null = null;
  uploadedMs = 0;
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

  static async connect(options: { instructions: string; tools: unknown[]; capCny: number }): Promise<Link> {
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

  waitForFrame(predicate: (e: WireEvent) => boolean, timeoutMs: number): Promise<boolean> {
    if (this.events.some(predicate)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        if (this.events.some(predicate)) return resolve(true);
        if (this.closed) return resolve(false);
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
    this.events.push({ sinceConnectMs: Date.now() - this.t0, audioMs: this.uploadedMs, direction: 'received', type, raw });

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

    const call = this.readCall(raw);
    if (call !== null && !this.answeredCalls.has(call.callId)) {
      this.answeredCalls.add(call.callId);
      this.calls.push({ atMs: Date.now() - this.t0, name: call.name, arguments: call.arguments });
      this.sendRaw({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: JSON.stringify({ dryRun: true, accepted: true, note: 'idle-history probe recorded this call; nothing was executed' }),
        },
      });
      this.requestResponse();
    }
  }

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
// 一次尝试 = 一条连接，两条臂：fresh（AC-369 式对照）/ history（先一轮+空闲）
// ─────────────────────────────────────────────────────────────────────────────

type Arm = 'fresh' | 'history';

type Reading = {
  connectionId: string;
  arm: Arm;
  rep: number;
  startedAt: string;
  /** history 臂才有：第一轮是否 committed/answered。 */
  firstTurnCommitted: boolean | null;
  firstTurnAnswered: boolean | null;
  /** 第二段（本次观测对象）的读数。 */
  secondAppendFrames: number;
  secondCommitted: boolean;
  secondAnswered: boolean;
  secondTranscriptionCompleted: boolean;
  secondTranscript: string | null;
  /** 断线读数：是否断线、在哪个阶段断的。 */
  disconnected: boolean;
  disconnectedDuringIdle: boolean | null;
  closeCode: number | null;
  closeReason: string | null;
  closeSinceSecondAppendDoneMs: number | null;
  closeSinceSecondCommitMs: number | null;
  errors: string[];
  spendCny: number;
  capTripped: boolean;
  events: WireEvent[];
};

type Marks = Record<string, number>;

async function runAttempt(arm: Arm, rep: number, firstPcm: Buffer, secondPcm: Buffer, capCny: number, journalDir: string): Promise<Reading> {
  const connectionId = randomUUID();
  const startedAt = nowIso();

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
  const marks: Marks = {};

  let firstTurnCommitted: boolean | null = null;
  let firstTurnAnswered: boolean | null = null;
  let disconnectedDuringIdle: boolean | null = null;

  if (arm === 'history') {
    // 第一轮：短对话，像真实 segment 0/1。
    link.append(firstPcm);
    await sleep(200);
    link.sendRaw({ type: 'input_audio_buffer.commit' });
    await sleep(150);
    link.requestResponse();
    const firstDeadline = Date.now() + RESPONSE_WINDOW_MS;
    while (Date.now() < firstDeadline && !link.closed) {
      if (link.inboundOfType('response.done').length > 0) break;
      await sleep(100);
    }
    firstTurnCommitted = link.inboundOfType('input_audio_buffer.committed').length > 0;
    firstTurnAnswered = link.inboundOfType('response.done').length > 0;
    await sleep(300);

    // 空闲：不发任何帧，像真实「说完一句等了快 20 s 才再开口」。
    marks.idleStart = Date.now() - link.t0;
    const idleDeadline = Date.now() + IDLE_MS;
    while (Date.now() < idleDeadline) {
      if (link.closed) break;
      await sleep(200);
    }
    marks.idleEnd = Date.now() - link.t0;
    disconnectedDuringIdle = link.closed;
  }

  // 第二段：真正观测的大单帧。history 臂若已在空闲期断线，这里的 append 会失败/无效——如实记录，不假装它发生了。
  marks.secondAppendStart = Date.now() - link.t0;
  link.append(secondPcm);
  marks.secondAppendDone = Date.now() - link.t0;
  await sleep(200);
  marks.secondCommit = Date.now() - link.t0;
  link.sendRaw({ type: 'input_audio_buffer.commit' });
  await sleep(150);
  link.requestResponse();

  const deadline = Date.now() + RESPONSE_WINDOW_MS;
  let responseDoneAt: number | null = null;
  while (Date.now() < deadline) {
    if (link.closed) break;
    const doneEvents = link.inboundOfType('response.done');
    // history 臂有两轮 response.done：只认第二轮（在 idleEnd 之后到达的）。
    const secondDone = doneEvents.find((e) => marks.idleEnd === undefined || e.sinceConnectMs > marks.idleEnd);
    if (responseDoneAt === null && secondDone !== undefined) {
      responseDoneAt = link.t0 + secondDone.sinceConnectMs;
    }
    if (responseDoneAt !== null && Date.now() - responseDoneAt > SETTLE_MS) break;
    await sleep(100);
  }
  await sleep(200);

  const reading = buildReading(link, connectionId, arm, rep, startedAt, marks, firstTurnCommitted, firstTurnAnswered, disconnectedDuringIdle);
  writeJournal(journalDir, reading, link);
  if (!link.closed) {
    link.close();
    await sleep(150);
  }
  return reading;
}

function buildReading(
  link: Link,
  connectionId: string,
  arm: Arm,
  rep: number,
  startedAt: string,
  marks: Marks,
  firstTurnCommitted: boolean | null,
  firstTurnAnswered: boolean | null,
  disconnectedDuringIdle: boolean | null,
): Reading {
  const committedEvents = link.inboundOfType('input_audio_buffer.committed');
  const secondCommittedEv = committedEvents.find((e) => marks.idleEnd === undefined || e.sinceConnectMs > marks.idleEnd) ?? null;
  const transcriptionEvents = link.inboundOfType('conversation.item.input_audio_transcription.completed');
  const secondTranscriptionEv = transcriptionEvents.find((e) => marks.idleEnd === undefined || e.sinceConnectMs > marks.idleEnd) ?? null;
  const responseDoneEvents = link.inboundOfType('response.done');
  const secondAnswered = responseDoneEvents.some((e) => marks.idleEnd === undefined || e.sinceConnectMs > marks.idleEnd);
  const transcript =
    secondTranscriptionEv !== null && typeof secondTranscriptionEv.raw.transcript === 'string'
      ? (secondTranscriptionEv.raw.transcript as string)
      : null;

  return {
    connectionId,
    arm,
    rep,
    startedAt,
    firstTurnCommitted,
    firstTurnAnswered,
    secondAppendFrames: 1,
    secondCommitted: secondCommittedEv !== null,
    secondAnswered,
    secondTranscriptionCompleted: secondTranscriptionEv !== null,
    secondTranscript: transcript,
    disconnected: link.disconnectedByUpstream,
    disconnectedDuringIdle,
    closeCode: link.closeInfo?.code ?? null,
    closeReason: link.closeInfo?.reason ?? null,
    closeSinceSecondAppendDoneMs:
      link.closeInfo !== null && marks.secondAppendDone !== undefined ? num3(link.closeInfo.atMs - marks.secondAppendDone) : null,
    closeSinceSecondCommitMs:
      link.closeInfo !== null && marks.secondCommit !== undefined ? num3(link.closeInfo.atMs - marks.secondCommit) : null,
    errors: [...link.errors],
    spendCny: link.spend,
    capTripped: link.capTripped,
    events: link.events,
  };
}

function writeJournal(journalDir: string, reading: Reading, link: Link): void {
  const scrub = (raw: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...raw };
    if (typeof copy.audio === 'string') copy.audio = `<elided ${copy.audio.length} base64 chars>`;
    return copy;
  };
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      kind: 'header',
      connectionId: reading.connectionId,
      arm: reading.arm,
      rep: reading.rep,
      startedAt: reading.startedAt,
      model: MODEL,
      voice: VOICE,
      firstTurnSeconds: reading.arm === 'history' ? FIRST_TURN_SECONDS : null,
      idleMs: reading.arm === 'history' ? IDLE_MS : null,
      secondSegmentSeconds: SECOND_SEGMENT_SECONDS,
      capCny: link.capCny,
    }),
  );
  for (const e of link.events) {
    lines.push(JSON.stringify({ atMs: e.sinceConnectMs, audioMs: e.audioMs, dir: e.direction === 'sent' ? '→' : '←', type: e.type, raw: scrub(e.raw) }));
  }
  const { events: _events, ...rest } = reading;
  lines.push(JSON.stringify({ kind: 'reading', ...rest }));
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(path.join(journalDir, `${reading.connectionId}.jsonl`), `${lines.join('\n')}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行
// ─────────────────────────────────────────────────────────────────────────────

function buildPlan(capCny: number): string {
  const total = REPEATS * 2;
  return [
    `计划：两条臂各 ${REPEATS} 次——`,
    `  fresh：全新连接直接 append+commit 一个 ${SECOND_SEGMENT_SECONDS} s 单帧（= AC-369 方法论，本次运行内的对照）；`,
    `  history：同一条连接先做 ${FIRST_TURN_SECONDS} s 的一轮对话，空闲 ${IDLE_MS} ms，再 append+commit 同样 ${SECOND_SEGMENT_SECONDS} s 单帧（像真实 journal 的 seq=2/3/7）。`,
    `共 ${total} 条连接；上限 ¥${capCny}/连接；总上限 ¥${TOTAL_BUDGET_CNY}。`,
    `音频源 ${FIXTURE_REL}；模型 ${MODEL}；manual commit（turn_detection: null）。`,
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
  const needed = FIRST_TURN_SECONDS + SECOND_SEGMENT_SECONDS;
  if (sourceSeconds < needed) {
    throw new Error(`夹具只有 ${sourceSeconds.toFixed(2)} s，不足以切出 ${FIRST_TURN_SECONDS}+${SECOND_SEGMENT_SECONDS} s`);
  }
  // 两段取自夹具不重叠的前缀区间：[0, FIRST_TURN_SECONDS) 给第一轮，[FIRST_TURN_SECONDS, needed) 给第二段。
  const firstPcm = fixture.subarray(0, SAMPLE_RATE * FIRST_TURN_SECONDS * 2);
  const secondPcm = fixture.subarray(SAMPLE_RATE * FIRST_TURN_SECONDS * 2, SAMPLE_RATE * needed * 2);

  log(`运行目录 ${workDir}`);
  log(buildPlan(capCny));

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  const readings: Reading[] = [];
  let totalSpend = 0;

  const runOne = async (arm: Arm, rep: number): Promise<void> => {
    if (totalSpend > TOTAL_BUDGET_CNY) {
      log(`跳过 ${arm}#${rep}：总花费 ¥${totalSpend.toFixed(4)} 已越过总上限 ¥${TOTAL_BUDGET_CNY}`);
      return;
    }
    try {
      const reading = await runAttempt(arm, rep, firstPcm, secondPcm, capCny, journalDir);
      readings.push(reading);
      totalSpend += reading.spendCny;
      log(
        `  ${arm}#${rep} conn=${reading.connectionId.slice(0, 8)} ` +
          `secondCommitted=${reading.secondCommitted} secondAnswered=${reading.secondAnswered} ` +
          `断线=${reading.disconnected}${reading.disconnected ? `(code=${reading.closeCode ?? '?'} 距第二次写出+${reading.closeSinceSecondAppendDoneMs ?? '?'}ms idle中断=${reading.disconnectedDuringIdle})` : ''} ` +
          `转写=${reading.secondTranscriptionCompleted ? 'Y' : 'N'} ¥${reading.spendCny.toFixed(4)}`,
      );
    } catch (err) {
      log(`  ${arm}#${rep} 失败=${err instanceof Error ? err.message : String(err)}`);
      readings.push(errorReading(arm, rep, err));
    }
  };

  if (bools.has('smoke')) {
    log('--smoke：只跑一条 fresh（证管线）…');
    await runOne('fresh', 1);
  } else {
    for (let rep = 1; rep <= REPEATS; rep += 1) {
      await runOne('fresh', rep);
    }
    for (let rep = 1; rep <= REPEATS; rep += 1) {
      await runOne('history', rep);
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
    firstTurnSeconds: FIRST_TURN_SECONDS,
    idleMs: IDLE_MS,
    secondSegmentSeconds: SECOND_SEGMENT_SECONDS,
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

function errorReading(arm: Arm, rep: number, err: unknown): Reading {
  return {
    connectionId: randomUUID(),
    arm,
    rep,
    startedAt: nowIso(),
    firstTurnCommitted: null,
    firstTurnAnswered: null,
    secondAppendFrames: 0,
    secondCommitted: false,
    secondAnswered: false,
    secondTranscriptionCompleted: false,
    secondTranscript: null,
    disconnected: false,
    disconnectedDuringIdle: null,
    closeCode: null,
    closeReason: null,
    closeSinceSecondAppendDoneMs: null,
    closeSinceSecondCommitMs: null,
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
  firstTurnSeconds: number;
  idleMs: number;
  secondSegmentSeconds: number;
  repeats: number;
  fixtureRel: string;
  fixtureSeconds: number;
  readings: Reading[];
  totalSpendCny: number;
  note?: string;
};

function lineFor(r: Reading): string {
  const errs = r.errors.length === 0 ? '无' : r.errors.join(' | ').slice(0, 200);
  return (
    `conn=${r.connectionId} arm=${r.arm}#${r.rep}；` +
    (r.arm === 'history' ? `第一轮 committed=${r.firstTurnCommitted} answered=${r.firstTurnAnswered}；` : '') +
    `第二段 committed=${r.secondCommitted} answered=${r.secondAnswered} 转写=${r.secondTranscriptionCompleted ? `「${(r.secondTranscript ?? '').slice(0, 40)}」` : '否'}；` +
    `断线=${r.disconnected ? `是(code=${r.closeCode} 距第二段写出+${r.closeSinceSecondAppendDoneMs}ms, 距第二段commit+${r.closeSinceSecondCommitMs}ms, idle中断=${r.disconnectedDuringIdle}, reason=${r.closeReason ?? ''})` : '否'}；` +
    `错误=${errs}；花费=¥${r.spendCny.toFixed(4)}`
  );
}

function deriveConclusion(readings: Reading[]): { verdict: '证实' | '否证' | '不足以判断'; reason: string } {
  const fresh = readings.filter((r) => r.arm === 'fresh');
  const history = readings.filter((r) => r.arm === 'history');
  const freshDisc = fresh.filter((r) => r.disconnected);
  const historyDisc = history.filter((r) => r.disconnected);

  if (fresh.length === 0) return { verdict: '不足以判断', reason: '没有 fresh 臂读数。' };
  if (history.length === 0) return { verdict: '不足以判断', reason: '没有 history 臂读数。' };

  if (historyDisc.length > 0 && freshDisc.length === 0) {
    return {
      verdict: '证实',
      reason: `history 臂（先一轮+空闲 ${IDLE_MS}ms 再发 ${SECOND_SEGMENT_SECONDS}s 单帧）出现 ${historyDisc.length}/${history.length} 次断线，fresh 臂（全新连接直接发同样大小单帧）0/${fresh.length} 次断线——同样大小的单帧在「有历史+空闲」的连接上断线、在全新连接上不断线，说明断线与连接的历史/空闲状态相关，不是帧大小本身。`,
    };
  }
  if (historyDisc.length === 0 && freshDisc.length === 0) {
    return {
      verdict: '否证',
      reason: `两条臂共 ${readings.length} 次尝试均未断线（fresh ${fresh.length} 次、history ${history.length} 次），本轮读数不支持「连接历史+空闲导致断线」。`,
    };
  }
  if (freshDisc.length > 0 && historyDisc.length === 0) {
    return {
      verdict: '否证',
      reason: `断线出现在 fresh 臂（${freshDisc.length}/${fresh.length}）而不是 history 臂（0/${history.length}），说明断线与「连接历史+空闲」无关，可能是单帧大小本身（与 AC-369 的 0/24 矛盾，需要复核）。`,
    };
  }
  return {
    verdict: '不足以判断',
    reason: `两条臂都出现断线（fresh ${freshDisc.length}/${fresh.length}、history ${historyDisc.length}/${history.length}），本轮无法把断线单独归因给「连接历史+空闲」。`,
  };
}

function buildReport(snapshot: Snapshot, workDir: string): string {
  const { readings } = snapshot;
  const conclusion = deriveConclusion(readings);
  const fresh = readings.filter((r) => r.arm === 'fresh');
  const history = readings.filter((r) => r.arm === 'history');

  const lines: string[] = [];
  lines.push('# Live Voice 连接历史 + 空闲间隔真实探针（AC-369 / RC-5 之后的诊断）');
  lines.push('');
  lines.push(
    `本文件是对 2026-10-13 第三次语音测试里 4 段真实断线（journal \`0d2e6d93…\`/\`10f039d0…\`，17.06/19.66/18.12/10.52 s，` +
      '全部发生在已处理过至少一轮、且前面有 ~17–19 s 空闲的连接上）的诊断探针，在**真实** `' +
      snapshot.model +
      '` 上跑。',
  );
  lines.push(
    'AC-369 已经在**全新连接**上否证「单帧 append 时长/字节数导致断线」（RC-5，2–20 s 单帧 24 次 0 断线）。' +
      '本探针变的是 AC-369 没变过的那个量——连接的历史/空闲——对照 fresh（全新连接直发大单帧，= AC-369 方法论）与 history（先一轮+空闲再发同样大小单帧）。',
  );
  lines.push('**这不是模型推演，是一次运行的读数。** 结论只允许「证实 / 否证 / 不足以判断」三选一。');
  lines.push('');
  lines.push(`运行时刻 ${snapshot.runAt}；探针**直连上游**（raw WS，手动 commit），未起第二实例；:3001 只被读 pid，从未被重启。`);
  lines.push('执行面是**合成会话**：会话声明的 `session_send` 工具由脚本内的记录式执行器承接（dry-run），绝不落到任何真实会话。');
  lines.push(`本次运行目录 \`${workDir}\`（journal 在 \`journal/\`）。`);
  lines.push('');
  lines.push('## 读数行（判据逐行检查）');
  lines.push('');
  const freshDisc = fresh.filter((r) => r.disconnected).length;
  const historyDisc = history.filter((r) => r.disconnected).length;
  lines.push(`fresh 臂（全新连接，直发 ${snapshot.secondSegmentSeconds}s 单帧）：断线 ${freshDisc}/${fresh.length}。`);
  lines.push(
    `history 臂（先 ${snapshot.firstTurnSeconds}s 一轮，空闲 ${snapshot.idleMs}ms，再发 ${snapshot.secondSegmentSeconds}s 单帧）：断线 ${historyDisc}/${history.length}` +
      (history.some((r) => r.disconnectedDuringIdle === true) ? `（其中 ${history.filter((r) => r.disconnectedDuringIdle).length} 次在空闲期本身就断了，不到第二段）` : '') +
      '。',
  );
  lines.push(`结论：${conclusion.verdict}。${conclusion.reason}`);
  lines.push('运行次数：1');
  const capTrips = readings.filter((r) => r.capTripped).length;
  lines.push(`花费：¥${snapshot.totalSpendCny.toFixed(4)}（上限 ¥${snapshot.capCny}/连接；总上限 ¥${snapshot.totalBudgetCny}；触顶连接 ${capTrips} 条）`);
  lines.push(
    `:3001 pid：运行前 ${snapshot.pidBefore ?? '未知'} → 运行后 ${snapshot.pidAfter ?? '未知'}（${snapshot.pidBefore === snapshot.pidAfter ? '**相同**，未重启' : '**不同**'}）`,
  );
  lines.push('执行面：dry-run（合成会话；会话声明工具由脚本内记录式执行器承接，调用只被记录、不执行，不落任何真实会话）；`--plan` 只打印计划、不连上游；本次为唯一一次真实运行。');
  lines.push('');

  lines.push('## 每次尝试的读数与事件时间线摘录');
  lines.push('');
  for (const r of readings) {
    lines.push(`### ${r.arm}#${r.rep} — conn=${r.connectionId}`);
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
      ].includes(e.type),
    );
    if (key.length === 0) {
      lines.push('- 时间线摘录：（无关键事件）');
    } else {
      lines.push('- 时间线摘录：');
      lines.push('  ```');
      for (const e of key.slice(0, 30)) {
        lines.push(`  +${String(e.sinceConnectMs).padStart(6)}ms (audio+${e.audioMs}ms) ${e.direction === 'sent' ? '→' : '←'} ${e.type}`);
      }
      lines.push('  ```');
    }
    lines.push('');
  }

  lines.push('## 方法与限制（如实记录）');
  lines.push('');
  lines.push(`- 音频源：\`${snapshot.fixtureRel}\`（${snapshot.fixtureSeconds} s，16 kHz 单声道 PCM16）；第一轮取 [0, ${snapshot.firstTurnSeconds}s)，第二段取 [${snapshot.firstTurnSeconds}s, ${snapshot.firstTurnSeconds + snapshot.secondSegmentSeconds}s)——两段互不重叠。`);
  lines.push('- 手动提交：`session.update{session.turn_detection: null}` → `input_audio_buffer.append` → `input_audio_buffer.commit` → `response.create`。');
  lines.push(`- history 臂的空闲窗口（${snapshot.idleMs}ms）里不发任何帧，也不发任何控制帧——与真实「用户说完一句、隔了快 20 s 才再开口」逐帧一致。`);
  lines.push('- 每条尝试 = 一条全新连接（fresh 与 history 各自独立起新连接，不复用）。');
  lines.push('- 花费按出货 `estimateRealtimeCostCny` 在每条 `response.done` 上累计；每连接封顶 `--cap`。');
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('set -a; . ./.env.test; set +a');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-idle-history-probe/probe.mts --plan');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-idle-history-probe/probe.mts --work /tmp/idle-history-probe');
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const { values, bools } = readFlags(process.argv.slice(2));
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-idle-history-${Date.now()}`);
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

  process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION = String(capCny);
  void mainAsync({ workDir, journalDir, capCny, reportPath, values, bools }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

main();
