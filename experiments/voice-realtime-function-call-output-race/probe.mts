#!/usr/bin/env tsx
/**
 * 真实上游「工具调用后用户再开口 → function_call_output 被拒」探针。
 *
 * 问的问题。2026-10-13 的真实 journal（`b5d01c21`）里，一条连接出现 8 组**成对**的上游错误：
 * `invalid_request_error "Unknown function call id: call_…"` 紧跟
 * `invalid_request_error "Cannot create response after rejected function_call_output; …"`。
 * 该 journal 的机械计数：17 次 output 发出、9 次被接受（`item.created type=function_call_output`）、
 * 8 次被拒。相关关系是 12/12 完美分离：只要 `input_audio_buffer.speech_started`（用户又开口）
 * 落在「我们发出 output」到「上游回 `conversation.item.created(type=function_call_output)` 回执」
 * 之间，这次 output 就**必被拒**（6/6）；其间没有 speech_started 的 6/6 全部成功。
 *
 * **相关不等于因果。** 本探针在**真实** `qwen3.8-omni-flash-realtime` 上回答：把同一段真实语音
 * （取自那份 journal 的同源音频捕获）推进「工具调用已发生、回执未到」的窗口，能否重现拒绝；
 * 不推语音的对照臂是否一次都不出现。结论只允许「证实 / 否证 / 不足以判断」三选一，并在
 * `docs/operations/voice-realtime-function-call-output-race.md` 里逐行给出读数。
 *
 * 为什么驱动**出货**的 transport + bridge，而不是裸 WS 客户端。被测量的是「浏览器会不会收到
 * UPSTREAM_ERROR」，而那条路径是 出货 transport 的 `handleInbound` → bridge 的
 * `UPSTREAM_ERROR` → proxy 的 error 帧。手搓协议只能证明上游会拒，证明不了这条链路的读数，
 * 也就无法为修复前后的同读数对比（AC5）提供基线。只有 `session.update` 正文里那段「强制调用
 * 工具」的 instructions 与那个纯文本 user turn 是 bridge 表达不了的，它们作为原始帧附加，
 * 与捕获脚本同样的做法。
 *
 * 三臂，各自一条**全新连接**（一次拒绝无法被归因到上一条的残留）：
 *   - R（重现）：执行器拿到 `function_call` 后**压住**结果，其间把真实语音段按 200 ms 分块推进
 *     （实时节奏）；压到 `--hold` 结束才返回，bridge 这才发出 `function_call_output`。
 *     —— 语音段**先于** output 发出。
 *   - C（对照）：除**不推任何语音**外与 R 完全相同（压住同样的时长）。
 *   - A（journal 原序）：执行器**立即**返回（output 一发出就推语音段），重现 `b5d01c21` 里那 8 次
 *     拒绝的真实相对次序——先发 output、**其后**用户才开口（逐条配对实测：发出→其后首句
 *     `speech_started` 为 1 ms–2.97 s，8/8 都是这个方向，其中两次仅 1–8 ms）。这一臂是承重的：
 *     任何「在已知被拒状态下不发送」的预防式守卫都**覆盖不到**它（发送已经发生），只有吸收式
 *     状态机能救。journal 的 8 次拒绝**全部**属于这个次序。
 *
 * 臂 A 与臂 R 的差别不是装饰。任务书 Plan 写的是 R 的次序（延迟发送、其间推入语音），而
 * journal 的 8 次拒绝是 A 的次序。两臂都跑，才能说清「修复靠哪一半承重」。
 *
 * 执行面是**合成会话**：会话声明的 `ui_visible_context` 由本脚本的记录式执行器承接，回一个常量
 * 快照，**绝不**落到任何真实会话、不触发任何真实工具。`--plan` 只打印计划、不连上游、不花钱。
 *
 * 花费。用**出货的** `estimateRealtimeCostCny` 在每条 `response.done` 上累计；两臂合计越过
 * `--cap`（默认 ¥0.30）即不再开新连接。
 *
 * :3001 只被读 pid（运行前后各一次），**从未被重启**；本脚本不碰任何 Quay worker / driver / 工作树。
 *
 * 用法（仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-function-call-output-race/probe.mts
 *   … --arm R|C|A|all        只跑某一臂（默认 all）
 *   … --hold 6000            执行器压住结果的时长（ms，默认 6000）
 *   … --slice 3              用捕获里第几条语音段（默认 3）
 *   … --cap 0.30             两臂合计花费上限（CNY）
 *   … --phase pre|post       按修复前/修复后的判据形态判读（默认 pre）
 *   … --work /tmp/x          指定运行目录（默认 os.tmpdir() 下一个新目录）
 *   … --plan                 只打印计划，不连上游、不花钱
 *
 * `--phase` 换的是**退出判据**，不是行为。修复前要的是「重现」：臂 R 至少一次
 * `Unknown function call id`、臂 C 零次。修复后要的是「不再发生」：臂 R 的拒绝与浏览器错误都是
 * 零、且这个零**来自回执状态机真的把结果拦下**（`output发出=0` 且日志里有 `state=superseded`），
 * 而臂 C 的常规路径一字未动（结果发出并被回执）。少了后半条，一个「碰巧没重现」的连接也会被判成
 * 绿——那正是这个探针要避免的读法。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import {
  DASHSCOPE_REALTIME_ENDPOINT,
  REALTIME_TOOLS,
  connect,
  createDashscopeTransport,
  estimateRealtimeCostCny,
  type DashscopeSocket,
  type RealtimeToolExecutor,
} from '../../server/modules/voice-realtime/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 上游 Realtime 端点（与出货 transport 同址）。 */
const UPSTREAM_URL = DASHSCOPE_REALTIME_ENDPOINT;
/** 出货默认模型（GOAL-030 采纳）。 */
const MODEL = 'qwen3.8-omni-flash-realtime';
/** 该模型要求显式 voice（见 DEFAULT_DASHSCOPE_REALTIME_VOICE 的长注释）。 */
const VOICE = 'Tina';

/** 同源音频捕获：那条 journal 的浏览器侧原始音频（16 kHz 单声道 PCM16）。 */
const CAPTURE_WAV = path.join(os.homedir(), '.cloudcli/voice-realtime-capture/b5d01c21-3f53-4228-a28e-d18b7cb967f7.wav');
const CAPTURE_TIMELINE = path.join(os.homedir(), '.cloudcli/voice-realtime-capture/b5d01c21-3f53-4228-a28e-d18b7cb967f7.timeline.jsonl');
/** AC1 要求写进文档的捕获 sha256 前缀。 */
const CAPTURE_SHA_PREFIX = '0f2bd51fbbb28c9f';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** 语音段按 200 ms 分块推进（与出货 relay 的分块粒度一致）。 */
const CHUNK_MS = 200;
const CHUNK_BYTES = (BYTES_PER_SECOND * CHUNK_MS) / 1000;

/** 语音段前后各留的口沿静音，让服务端 VAD 干净地看到一段「有人说话」。 */
const SLICE_LEAD_MS = 300;
const SLICE_TAIL_MS = 500;
/** 进入执行器后、开始推语音前的等待（让 ownership 的 response 先走完）。 */
const INTERRUPT_LEAD_MS = 200;

const DEFAULT_HOLD_MS = 6_000;
const DEFAULT_CAP_CNY = 0.3;
/** 发出 output 之后，等回执 / 拒绝错误的最大窗口。journal 里最晚的一次拒绝在发出后 7.2 s。 */
const SETTLE_MS = 12_000;
/** 等模型发起 function_call 的窗口。 */
const CALL_WINDOW_MS = 25_000;
/** 连接建立 / session.update 生效的窗口。 */
const READY_WINDOW_MS = 12_000;

/**
 * 会话正文：强制模型先调工具而不是直接回答。照抄自捕获脚本
 * （`experiments/voice-realtime-ambiguity/real-trace/capture-live.ts`）——那段正文已被证明能让
 * 真实模型稳定发起一次 `ui_visible_context` 调用，是这条链路上**确定性**触发工具调用的唯一手段。
 */
const INSTRUCTIONS =
  'You are a voice UI controller for a coding workspace. You cannot answer directly: whenever the user asks anything about the screen or the session, you MUST call the ui_visible_context tool instead of replying in text.';
/** 纯文本 user turn：确定性触发一次模型发起的工具调用。 */
const TEXT_TURN = '现在屏幕上有什么？请调用工具查看。';

/** 上游拒绝的两种报文（成对出现）。 */
const UNKNOWN_CALL_ID = /Unknown function call id/i;
const REJECTED_OUTPUT = /Cannot create response after rejected function_call_output/i;

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hrMs = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;

function readFlags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      values.set(token.slice(2), 'true');
      continue;
    }
    values.set(token.slice(2), next);
    index += 1;
  }
  return values;
}

/** :3001 的监听 pid，或 null。只读，从不重启。 */
function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('/usr/bin/ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = /pid=(\d+)/.exec(out);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** 一条语音段：捕获里的 offsetMs 区间（含前导/尾随口沿）。 */
type SpeechSlice = { index: number; startMs: number; endMs: number; sampleFrom: number; sampleTo: number };

/** 从捕获的 timeline 里列出全部 speech_started→stopped 区间，并切出第 `index` 条。 */
function readSpeechSlice(index: number): { slice: SpeechSlice; pcm: Buffer; wavSha256: string } {
  const rows = readFileSync(CAPTURE_TIMELINE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string; offsetMs: number });
  const intervals: Array<{ startMs: number; endMs: number }> = [];
  let open: number | null = null;
  for (const row of rows) {
    if (row.kind === 'speech_started') open = row.offsetMs;
    else if (row.kind === 'speech_stopped' && open !== null) {
      intervals.push({ startMs: open, endMs: row.offsetMs });
      open = null;
    }
  }
  const chosen = intervals[index];
  if (chosen === undefined) throw new Error(`捕获里没有第 ${index} 条语音段（共 ${intervals.length} 条）`);
  const wav = readFileSync(CAPTURE_WAV);
  const pcm = wav.subarray(44); // 44 字节 WAV 头
  const startMs = Math.max(0, chosen.startMs - SLICE_LEAD_MS);
  const endMs = chosen.endMs + SLICE_TAIL_MS;
  return {
    slice: { index, startMs, endMs, sampleFrom: Math.floor((startMs * BYTES_PER_SECOND) / 1000), sampleTo: Math.floor((endMs * BYTES_PER_SECOND) / 1000) },
    pcm: pcm.subarray(Math.floor((startMs * BYTES_PER_SECOND) / 1000), Math.floor((endMs * BYTES_PER_SECOND) / 1000)),
    wavSha256: createHash('sha256').update(wav).digest('hex'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 一臂的运行
// ─────────────────────────────────────────────────────────────────────────────

type WireEvent = { atMs: number; sinceOpenMs: number; direction: 'sent' | 'received'; raw: Record<string, unknown> };

type ArmName = 'R' | 'C' | 'A';

type ArmReport = {
  arm: ArmName;
  startedAt: string;
  holdMs: number;
  interrupted: boolean;
  slice: SpeechSlice | null;
  captureSha256Prefix: string;
  connected: boolean;
  sessionId: string | null;
  events: WireEvent[];
  transportErrors: Array<{ atMs: number; code: string; message: string }>;
  bridgeErrors: Array<{ atMs: number; code: string; message: string }>;
  /** transport 的 `log` 通道（出货时与 journal 同一 sink）。修复后会在这里出现回执行。 */
  transportLog: string[];
  readings: {
    functionCalls: Array<{ callId: string; name: string; atMs: number }>;
    outputsSent: Array<{ callId: string | null; atMs: number }>;
    outputsAcked: Array<{ callId: string | null; atMs: number }>;
    speechStarted: number[];
    speechStopped: number[];
    responseDone: Array<{ responseId: string | null; status: string | null; atMs: number }>;
    errorFrames: Array<{ kind: 'unknown-call-id' | 'after-rejected-output' | 'other'; message: string; callId: string | null; atMs: number }>;
  };
  spendCny: number;
  verdict: {
    unknownCallIdCount: number;
    afterRejectedOutputCount: number;
    browserUpstreamErrors: number;
    pairs: number;
    cause: {
      newUserTurnInsideWindow: boolean;
      /** 新用户回合是否在 output **发出之前**就已开始（臂 R）而不是发出之后（臂 A / journal 原序）。 */
      newUserTurnBeforeSend: boolean;
      owningResponseCancelled: boolean;
      synthesizedCreateCollision: boolean;
    };
    conclusion: '证实' | '否证' | '不足以判断';
    note: string;
  };
};

/** 一个上游拒绝的判定所需的窄化工具。 */
function frameMessage(frame: Record<string, unknown>): string {
  const error = frame.error as Record<string, unknown> | undefined;
  if (typeof error?.message === 'string') return error.message;
  if (typeof frame.message === 'string') return frame.message;
  return '';
}

type ArmOptions = { holdMs: number; capCny: number; workDir: string; sliceIndex: number };

async function runArm(arm: ArmName, options: ArmOptions): Promise<ArmReport> {
  const key = process.env.DASHSCOPE_API_KEY ?? '';
  if (key === '') throw new Error('DASHSCOPE_API_KEY 未设置；先 `set -a; . ./.env.test; set +a`。');

  const interrupted = arm !== 'C';
  const { slice, pcm, wavSha256 } = interrupted ? readSpeechSlice(options.sliceIndex) : { slice: null, pcm: Buffer.alloc(0), wavSha256: '' };
  /** 有效压住时长：臂 A 不压（output 立即发出，语音段在发送**之后**才开始推）。 */
  const holdMs = arm === 'A' ? 0 : options.holdMs;

  const events: WireEvent[] = [];
  const transportErrors: ArmReport['transportErrors'] = [];
  const bridgeErrors: ArmReport['bridgeErrors'] = [];
  const transportLog: string[] = [];
  const responseDone: ArmReport['readings']['responseDone'] = [];
  let spendCny = 0;
  let socket: WebSocket | null = null;
  let openedAt = 0;
  let sessionId: string | null = null;
  let connected = false;
  /** 执行器进入 / 返回的墙钟，用于把「压住窗口」写进报告。 */
  let executorEnteredAt = 0;
  let executorReturnedAt = 0;
  /** 臂 A：语音段是否已经因 output 发出而启动（只启动一次）。 */
  let interruptStarted = false;

  const recordingFactory = (url: string, headers: Readonly<Record<string, string>>): DashscopeSocket => {
    const ws = new WebSocket(url, { headers });
    socket = ws;
    const handle: DashscopeSocket = {
      send(data: string) {
        const raw = JSON.parse(data) as Record<string, unknown>;
        events.push({ atMs: Date.now(), sinceOpenMs: Date.now() - openedAt, direction: 'sent', raw });
        ws.send(data);
        // 臂 A：output 一离开本机就开始推语音段——journal 里那 8 次拒绝的真实次序。
        const item = raw.item as Record<string, unknown> | undefined;
        if (arm === 'A' && raw.type === 'conversation.item.create' && item?.type === 'function_call_output' && !interruptStarted) {
          interruptStarted = true;
          void pushInterruptAudio();
        }
      },
      close(code?: number, reason?: string) {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    ws.on('open', () => {
      openedAt = Date.now();
      handle.onopen?.({});
    });
    ws.on('message', (data) => {
      const text = data.toString();
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      const atMs = Date.now();
      events.push({ atMs, sinceOpenMs: atMs - openedAt, direction: 'received', raw });
      if (raw.type === 'session.created' || raw.type === 'session.updated') {
        const session = raw.session as Record<string, unknown> | undefined;
        if (typeof session?.id === 'string') sessionId = session.id;
      }
      if (raw.type === 'response.done') {
        const response = raw.response as Record<string, unknown> | undefined;
        responseDone.push({
          responseId: typeof response?.id === 'string' ? response.id : null,
          status: typeof response?.status === 'string' ? response.status : null,
          atMs,
        });
        const cost = estimateRealtimeCostCny(response?.usage);
        spendCny += cost;
      }
      handle.onmessage?.({ data: text });
    });
    ws.on('error', (error) => handle.onerror?.(error));
    ws.on('close', (code, reason) => handle.onclose?.({ code, reason: String(reason) }));
    return handle;
  };

  /**
   * bridge 的 `sendAudioFrame` 通道。执行器先于 bridge 构造（bridge 需要它），所以经这个
   * 可变引用转发，而不是把 bridge 提前构造。
   */
  let sendAudioFrame: (audio: string) => void = () => {};

  /** 把真实语音段按 200 ms 分块、按实时节奏推进上游。 */
  const pushInterruptAudio = async (): Promise<void> => {
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
      const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
      sendAudioFrame(chunk.toString('base64'));
      await sleep(CHUNK_MS);
    }
  };

  const executor: RealtimeToolExecutor = {
    ui_visible_context: async () => {
      executorEnteredAt = Date.now();
      if (arm === 'R') {
        await sleep(INTERRUPT_LEAD_MS);
        await pushInterruptAudio();
      }
      const spent = Date.now() - executorEnteredAt;
      await sleep(Math.max(0, holdMs - spent));
      executorReturnedAt = Date.now();
      return {
        devices: [
          {
            deviceId: 'probe-device-0001',
            deviceName: 'probe',
            lastFocusedAt: Date.now(),
            tabs: [],
          },
        ],
        navigations: [],
      };
    },
  };

  const transport = createDashscopeTransport({
    model: MODEL,
    voice: VOICE,
    socketFactory: recordingFactory,
    onError: (error) => transportErrors.push({ atMs: Date.now(), code: error.code, message: JSON.stringify(error).slice(0, 600) }),
    log: (line) => transportLog.push(line),
    spendGuard: { maxCnyTotal: options.capCny, windowMs: 60_000, maxCnyPerWindow: options.capCny },
  });
  const bridge = connect(transport, REALTIME_TOOLS, executor, {
    maxConnectAttempts: 1,
    hooks: {
      onError: (error) =>
        bridgeErrors.push({
          atMs: Date.now(),
          code: error.code,
          message: 'message' in error ? String(error.message) : JSON.stringify(error).slice(0, 600),
        }),
    },
  });
  sendAudioFrame = (audio) => bridge.sendAudioFrame(audio);

  const waitUntil = async (predicate: () => boolean, windowMs: number): Promise<boolean> => {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(50);
    }
    return predicate();
  };

  try {
    await Promise.race([bridge.whenConnected(), sleep(READY_WINDOW_MS)]);
    connected = bridge.state === 'open';
    if (!connected) throw new Error(`bridge 未进入 open（state=${bridge.state}）`);
    bridge.sendSessionUpdate(INSTRUCTIONS);
    await sleep(1_500);

    // 纯文本 user turn + response.create：bridge 表达不了的确定性工具调用触发器。
    for (const wire of [
      { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: TEXT_TURN }] } },
      { type: 'response.create' },
    ]) {
      const atMs = Date.now();
      events.push({ atMs, sinceOpenMs: atMs - openedAt, direction: 'sent', raw: wire as Record<string, unknown> });
      (socket as WebSocket).send(JSON.stringify(wire));
    }

    const gotCall = await waitUntil(() => executorEnteredAt > 0, CALL_WINDOW_MS);
    if (!gotCall) throw new Error('窗口内模型没有发起 function_call');
    // 等执行器返回（= bridge 发出 function_call_output）+ 回执/拒绝窗口。
    await waitUntil(() => executorReturnedAt > 0, holdMs + 5_000);
    await sleep(SETTLE_MS);
  } finally {
    try {
      await bridge.close();
    } catch {
      /* 关闭失败不影响读数 */
    }
    await sleep(300);
  }

  // ── 读数整理 ────────────────────────────────────────────────────────────────
  const functionCalls: ArmReport['readings']['functionCalls'] = [];
  const outputsSent: ArmReport['readings']['outputsSent'] = [];
  const outputsAcked: ArmReport['readings']['outputsAcked'] = [];
  const speechStarted: number[] = [];
  const speechStopped: number[] = [];
  const errorFrames: ArmReport['readings']['errorFrames'] = [];

  for (const event of events) {
    const raw = event.raw;
    const type = String(raw.type ?? '');
    if (event.direction === 'received') {
      if (type === 'response.function_call_arguments.done') {
        functionCalls.push({ callId: String(raw.call_id ?? ''), name: String(raw.name ?? ''), atMs: event.atMs });
      }
      if (type === 'response.output_item.done') {
        const item = raw.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call' && typeof item.call_id === 'string') {
          functionCalls.push({ callId: item.call_id, name: String(item.name ?? ''), atMs: event.atMs });
        }
      }
      if (type === 'conversation.item.created') {
        const item = raw.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call_output') {
          outputsAcked.push({ callId: typeof item.call_id === 'string' ? item.call_id : null, atMs: event.atMs });
        }
      }
      if (type === 'input_audio_buffer.speech_started') speechStarted.push(event.atMs);
      if (type === 'input_audio_buffer.speech_stopped') speechStopped.push(event.atMs);
      if (type === 'error') {
        const message = frameMessage(raw);
        const callMatch = /call_\w+/.exec(message);
        errorFrames.push({
          kind: UNKNOWN_CALL_ID.test(message) ? 'unknown-call-id' : REJECTED_OUTPUT.test(message) ? 'after-rejected-output' : 'other',
          message: message.slice(0, 400),
          callId: callMatch === null ? null : callMatch[0],
          atMs: event.atMs,
        });
      }
    } else if (type === 'conversation.item.create') {
      const item = raw.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call_output') {
        outputsSent.push({ callId: typeof item.call_id === 'string' ? item.call_id : null, atMs: event.atMs });
      }
    }
  }

  // 同一次调用上游会发两次（`response.function_call_arguments.done` 与
  // `response.output_item.done(item.type=function_call)`），按 call_id 去重。
  const uniqueCalls = functionCalls.filter((call, index) => functionCalls.findIndex((other) => other.callId === call.callId) === index);

  const unknownCallIdCount = errorFrames.filter((frame) => frame.kind === 'unknown-call-id').length;
  const afterRejectedOutputCount = errorFrames.filter((frame) => frame.kind === 'after-rejected-output').length;
  const browserUpstreamErrors = bridgeErrors.filter((error) => error.code === 'UPSTREAM_ERROR').length;

  // ── 归因：拒绝的原因三选一（或「不足以判断」） ──────────────────────────────
  const firstRejection = errorFrames.find((frame) => frame.kind === 'unknown-call-id') ?? null;
  const firstCall = uniqueCalls[0] ?? null;
  const firstSend = outputsSent[0] ?? null;
  const windowEnd = firstRejection?.atMs ?? Infinity;
  const windowStart = firstCall?.atMs ?? 0;
  // (a) 窗口内出现了新的用户回合：speech_started，或一条 role=user 的新 item。
  const userItemInsideWindow = events.some((event) => {
    if (event.direction !== 'received' || event.atMs < windowStart || event.atMs > windowEnd) return false;
    const item = event.raw.item as Record<string, unknown> | undefined;
    return event.raw.type === 'conversation.item.created' && item?.type === 'message' && item?.role === 'user';
  });
  const newUserTurnInsideWindow = speechStarted.some((atMs) => atMs >= windowStart && atMs <= windowEnd) || userItemInsideWindow;
  // 次序：新回合是在 output 发出**之前**开始的吗？（决定修复的哪一半承重。）
  const sendAt = firstSend?.atMs ?? Number.POSITIVE_INFINITY;
  const newUserTurnBeforeSend = speechStarted.some((atMs) => atMs >= windowStart && atMs <= sendAt);
  // (b) ownership 的 response 被取消。
  const owningResponseCancelled = responseDone.some((entry) => entry.status === 'cancelled' && entry.atMs >= windowStart && entry.atMs <= windowEnd);
  // (c) 合成 response.create 撞上在飞 response（transport 已有的吸收机制）。
  const synthesizedCreateCollision = transportErrors.some((error) => error.code === 'RESPONSE_CONCURRENCY_CONFLICT');

  const pairs = Math.min(unknownCallIdCount, afterRejectedOutputCount);
  let conclusion: ArmReport['verdict']['conclusion'];
  let note: string;
  if (unknownCallIdCount === 0) {
    conclusion = '否证';
    note = '本次连接没有出现 `Unknown function call id`：该臂没有重现拒绝。';
  } else if (newUserTurnInsideWindow && !owningResponseCancelled && !synthesizedCreateCollision) {
    conclusion = '证实';
    note =
      '窗口内出现新的用户回合（speech_started / 新 user item），ownership 的 response 未被取消、合成 response.create 未撞车。' +
      `新回合开始于 output 发出之${newUserTurnBeforeSend ? '前' : '后'}。`;
  } else {
    conclusion = '不足以判断';
    note =
      `窗口内新用户回合=${newUserTurnInsideWindow}、ownership response 被取消=${owningResponseCancelled}、` +
      `合成 response.create 撞车=${synthesizedCreateCollision}：三者不能互相排除。`;
  }

  return {
    arm,
    startedAt: new Date().toISOString(),
    holdMs,
    interrupted,
    slice,
    captureSha256Prefix: wavSha256.slice(0, 16),
    connected,
    sessionId,
    events,
    transportErrors,
    bridgeErrors,
    transportLog,
    readings: { functionCalls: uniqueCalls, outputsSent, outputsAcked, speechStarted, speechStopped, responseDone, errorFrames },
    spendCny: Number(spendCny.toFixed(6)),
    verdict: {
      unknownCallIdCount,
      afterRejectedOutputCount,
      browserUpstreamErrors,
      pairs,
      cause: { newUserTurnInsideWindow, newUserTurnBeforeSend, owningResponseCancelled, synthesizedCreateCollision },
      conclusion,
      note,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2));
  const armFlag = flags.get('arm') ?? 'both';
  const holdMs = Number(flags.get('hold') ?? DEFAULT_HOLD_MS);
  const capCny = Number(flags.get('cap') ?? DEFAULT_CAP_CNY);
  const sliceIndex = Number(flags.get('slice') ?? 3);
  const phase = flags.get('phase') === 'post' ? 'post' : 'pre';
  const plan = flags.has('plan');
  const workDir = flags.get('work') ?? path.join(os.tmpdir(), `voice-fn-output-race-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const arms: ArmName[] = /^(all|both)$/.test(armFlag) ? ['R', 'C', 'A'] : [armFlag === 'C' ? 'C' : armFlag === 'A' ? 'A' : 'R'];
  const { slice, wavSha256 } = readSpeechSlice(sliceIndex);
  const shaOk = wavSha256.startsWith(CAPTURE_SHA_PREFIX);

  log(`上游 ${UPSTREAM_URL}`);
  log(`模型 ${MODEL} / voice ${VOICE}`);
  log(`捕获 ${CAPTURE_WAV}`);
  log(`  sha256=${wavSha256}（前缀命中 AC1 的 ${CAPTURE_SHA_PREFIX}：${shaOk ? '是' : '否'}）`);
  log(`  语音段 #${slice.index}：捕获 offset ${slice.startMs}–${slice.endMs} ms（${((slice.endMs - slice.startMs) / 1000).toFixed(2)} s，含口沿）`);
  log(`两臂：${arms.join(' / ')}；压住 ${holdMs} ms；花费上限 ¥${capCny}；判据 phase=${phase}；运行目录 ${workDir}`);

  if (plan) {
    log('--plan：只打印计划，不连上游、不花钱。');
    return;
  }

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  const reports: ArmReport[] = [];
  let totalSpend = 0;
  for (const arm of arms) {
    if (totalSpend > capCny) {
      log(`跳过臂 ${arm}：累计花费 ¥${totalSpend.toFixed(4)} 已越过上限 ¥${capCny}`);
      continue;
    }
    log(`\n── 臂 ${arm}（${arm === 'R' ? '压住期间推入真实语音段（语音先于 output）' : arm === 'A' ? 'output 发出后立即推入真实语音段（journal 原序）' : '对照：不推语音'}） ──`);
    const report = await runArm(arm, { holdMs, capCny: capCny - totalSpend, workDir, sliceIndex });
    reports.push(report);
    totalSpend += report.spendCny;
    writeFileSync(path.join(workDir, `arm-${arm}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`  session=${report.sessionId} 花费 ¥${report.spendCny.toFixed(4)}`);
    log(`  function_call=${report.readings.functionCalls.length} output发出=${report.readings.outputsSent.length} 回执=${report.readings.outputsAcked.length}`);
    log(`  speech_started=${report.readings.speechStarted.length} 错误帧=${report.readings.errorFrames.length}`);
    log(`  Unknown-function-call-id=${report.verdict.unknownCallIdCount} 配对后帧=${report.verdict.afterRejectedOutputCount}`);
    log(`  浏览器侧 UPSTREAM_ERROR=${report.verdict.browserUpstreamErrors}`);
    log(`  归因：${report.verdict.conclusion} —— ${report.verdict.note}`);
    // 逐事件时间线（相对连接开始）。
    const marks = report.readings;
    const timeline: string[] = [];
    for (const call of marks.functionCalls) timeline.push(`function_call ${call.callId} ${call.name}`);
    for (const atMs of marks.speechStarted) timeline.push(`speech_started @${atMs}`);
    for (const atMs of marks.speechStopped) timeline.push(`speech_stopped @${atMs}`);
    for (const sent of marks.outputsSent) timeline.push(`>> function_call_output ${sent.callId ?? '?'}`);
    for (const ack of marks.outputsAcked) timeline.push(`<< item.created(function_call_output) ${ack.callId ?? '?'}`);
    for (const done of marks.responseDone) timeline.push(`response.done ${done.responseId ?? '?'} status=${done.status ?? '?'}`);
    for (const frame of marks.errorFrames) timeline.push(`<< error [${frame.kind}] ${frame.callId ?? ''} ${frame.message.slice(0, 90)}`);
    for (const line of report.transportLog) timeline.push(`log ${line}`);
    log(`  时间线（按事件顺序）：\n    ${timeline.join('\n    ')}`);
  }

  const pidAfter = pidOnPort(3001);
  log(`\n:3001 pid（运行后）= ${pidAfter ?? '未知'}（${pidBefore === pidAfter ? '相同，未重启' : '不同——发生了重启'}）`);
  log(`总花费 ¥${totalSpend.toFixed(4)}（上限 ¥${capCny}）`);
  writeFileSync(
    path.join(workDir, 'summary.json'),
    `${JSON.stringify({ capture: { path: CAPTURE_WAV, sha256: wavSha256, slice }, pidBefore, pidAfter, totalSpend, reports: reports.map((report) => ({ arm: report.arm, verdict: report.verdict, spendCny: report.spendCny })) }, null, 2)}\n`,
    'utf8',
  );
  log(`写盘：${workDir}`);

  // 臂 R 有拒绝且臂 C 没有 —— 修复前（AC1）的判据形态。
  const r = reports.find((report) => report.arm === 'R');
  const c = reports.find((report) => report.arm === 'C');
  const a = reports.find((report) => report.arm === 'A');
  if (r !== undefined && c !== undefined) {
    if (phase === 'post') {
      // 修复后：拒绝与浏览器错误都是零，且这个零来自**回执状态机真的拦下了结果** ——
      // 结果根本没上线（`output发出=0`）且日志里留下 `state=superseded`。对照臂必须一字未动。
      const skipped = r.readings.outputsSent.length === 0;
      const receipted = r.transportLog.some((line) => line.includes('state=superseded'));
      const controlIntact = c.verdict.unknownCallIdCount === 0 && c.readings.outputsAcked.length === 1;
      const clean =
        r.verdict.unknownCallIdCount === 0 && r.verdict.browserUpstreamErrors === 0 && skipped && receipted;
      log(
        `修复后形态（臂 R 零拒绝、零浏览器错误，且结果被回执拦下：拦下=${skipped} 日志=${receipted}；` +
          `臂 C 常规路径未变=${controlIntact}）：${clean && controlIntact ? '满足' : '不满足'}` +
          `（R=${r.verdict.unknownCallIdCount}/err${r.verdict.browserUpstreamErrors}/sent${r.readings.outputsSent.length}` +
          `, C=${c.verdict.unknownCallIdCount}/ack${c.readings.outputsAcked.length}` +
          `${a === undefined ? '' : `, A=${a.verdict.unknownCallIdCount}/err${a.verdict.browserUpstreamErrors}`}）`,
      );
      process.exitCode = clean && controlIntact ? 0 : 1;
      return;
    }
    const ok = r.verdict.unknownCallIdCount >= 1 && c.verdict.unknownCallIdCount === 0;
    log(
      `AC1 形态（R≥1 且 C=0）：${ok ? '满足' : '不满足'}（R=${r.verdict.unknownCallIdCount}, C=${c.verdict.unknownCallIdCount}` +
        `${a === undefined ? '' : `, A=${a.verdict.unknownCallIdCount}`}）`,
    );
    process.exitCode = ok ? 0 : 1;
  }
}

main().catch((error) => {
  console.error('probe 失败：', error);
  process.exit(1);
});
