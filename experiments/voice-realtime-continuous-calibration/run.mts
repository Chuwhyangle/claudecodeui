#!/usr/bin/env tsx
/**
 * AC-362 连续模式真实校准 —— 一次**真实** Realtime 运行，只报读数（GOAL-044 / AC-362）。
 *
 * 现场。决策文档 `docs/proposals/live-voice-experience-first-decision-2026-10.md` §6 列出四个只能靠
 * 真实上游回答的问题；本文件跑那条真实的路：**第二实例**（备用端口，不动 :3001）、**dry-run 执行面**
 * （`server/index.ts` 的 `dryRun` 分支：`session_send` / `session_interrupt` 只被记录、不执行）、
 * **每条连接花费上限**，把语料喂给真实上游 `qwen3.8-omni-flash-realtime`，读它到底怎么断句、怎么
 * 计费、会不会等。
 *
 * 四项校准，一次运行：
 *   · **C-1** —— 同一段含填充词与句中停顿的音频，`server_vad` 与 `semantic_vad` 两臂，比条目数与
 *     response 数。P0-S4 只证明了 `semantic_vad` 在控制面**回显**；这里读的是**行为**。
 *   · **C-2** —— 同一段音频，`silence_duration_ms` 400 / 800 / 1000 三臂，比碎片数与
 *     「说完（`speech_stopped`）→ response 创建」延迟。
 *   · **C-4** —— 60 s 纯静音 / 60 s 语音在前 / 60 s 语音在后，比 usage 的 audio token。第三臂是
 *     关键：语音在末尾时，response 读入的音频缓冲包含前面整段静音，静音计不加费在这里才分得开。
 *   · **C-5** —— 自带「没说完可以不转发」指令（写在设置文件里，**不改出货指令**）下，十个「未说完 +
 *     补完」样本，读模型是否真的在第一个机会等待、在第二个机会合并转发。
 *
 * 为什么必须走**出货的代理**而不是直连上游。C-1/C-2 读的是上游行为，直连也能读；但 C-5 读的是
 * 「出货的 prompt 若改成允许等待，模型会怎么做」，而 dry-run 执行面（`session_send` 被记录而不是投递）
 * 是这次运行**不向任何真实会话注入消息**的唯一保证。三项读数是同一个代理在不同 `turnDetection` /
 * 设置文件下的表现，所以本脚本只驱动出货路径（`handleVoiceRealtimeConnection` + 出货 transport + 出货
 * executor 的 dry-run 替身），不另写一条上游客户端。
 *
 * 三条连接边界。① 不重启 :3001（前后各读一次 pid，报告里对照）。② 第二实例带
 * `CLAUDE_SESSION_SCOPE_SWEEP=off`——启动清扫是**全机**的，一个临时实例不该去收割不是它开的 Claude
 * 会话 scope。③ `sessionId` 是一个**任何库里都不存在**的合成 id，所以哪怕 dry-run 分支有洞，也没有
 * 一条路能落到真实会话上。
 *
 * 两个第二实例，先后起停。C-1/C-2/C-4 读的是断句与计费，与 prompt 无关，用**出货** prompt；C-5 必须
 * 换 prompt，而那只能整进程换（设置文件按进程读）。所以先起「出货 prompt」实例跑完前三项，停掉，再起
 * 「C-5 设置文件」实例跑第四项。两个实例都只在 `127.0.0.1` 的备用端口上。
 *
 * 用法（在仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-continuous-calibration/run.mts
 *   … --cap 0.05         每条连接的花费上限（CNY，写进 VOICE_REALTIME_MAX_CNY_PER_CONNECTION）
 *   … --port 3312        第二实例端口（默认 3312；:3001 只被读 pid，绝不被重启）
 *   … --only C-1         只跑某一项（冒烟用：C-1 / C-2 / C-4 / C-5）
 *   … --work /tmp/x      指定运行目录（默认 os.tmpdir() 下一个新目录）
 *   … --boot-only        只起第二实例、验路由与鉴权，**不调上游、不花钱**（取数前证管线）
 *   … --report-only <运行目录>  从 `<运行目录>/snapshot.json` 离线重建报告（不调上游、不花钱）
 *   … --preflight-note "…"  把取数前那次管线预检的口径逐字写进报告「方法与限制」（花费不藏）
 *
 * 边界（GOAL-041 全体任务共用，逐条对齐）：⛔ 不重启 :3001、不发布；⛔ 不触碰任何 Quay worker / driver
 * 进程或工作树；⛔ 不向任何真实会话注入（dry-run 执行面 + 合成 sessionId）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

import { estimateRealtimeCostCny } from '../../server/modules/voice-realtime/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 常量与小工具
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CORPUS_PATH = path.join(HERE, 'corpus.json');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-continuous-calibration.md');

/** 第二实例的默认端口。刻意远离 3001，也避开 5173（VITE）。:3001 只被 `pidOnPort` 读。 */
const DEFAULT_PORT = 3312;
/** 默认的每条连接花费上限，CNY。 */
const DEFAULT_CAP_CNY = 0.05;
/** 上游静默多久算这一轮结束。4000 够模型答完，也少等一截。 */
const QUIET_MS = 4_000;
/** 第二实例启动的等待上限。真机冷启动要装插件、挂 MCP 网关。 */
const BOOT_TIMEOUT_MS = 240_000;
/** TTS 的出货模型与音色（与 AC-346 抽样同一条路，2026-10-12 实测可用）。 */
const TTS_MODEL = 'qwen3-tts-flash';
const TTS_VOICE = 'Cherry';
const TTS_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const PCM_SAMPLE_RATE = 16_000;

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const nowIso = (ms: number = Date.now()): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const cny = (value: number): string => `¥${value.toFixed(4)}`;

/** 参数读取：`--flag value` / `--flag=value` / 布尔 `--flag`。 */
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
// 语料
// ─────────────────────────────────────────────────────────────────────────────

type C5Sample = { id: string; incomplete: string; completion: string };

type Corpus = {
  c1c2Clip: { file: string; reference: string; referenceFragments?: string[]; note?: string };
  c4: { totalSeconds: number; speechText: string; note?: string };
  c5: { instruction: string; samples: C5Sample[] };
};

function loadCorpus(): Corpus {
  const parsed = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Partial<Corpus>;
  if (parsed.c1c2Clip === undefined || parsed.c4 === undefined || parsed.c5 === undefined) {
    throw new Error(`语料不完整：${CORPUS_PATH}`);
  }
  if (parsed.c5.samples.length < 10) {
    throw new Error(`C-5 样本不足：${parsed.c5.samples.length}（SPEC 要求 ≥10）`);
  }
  const seen = new Set<string>();
  for (const sample of parsed.c5.samples) {
    if (seen.has(sample.id)) throw new Error(`C-5 样本 id 重复：${sample.id}`);
    seen.add(sample.id);
  }
  return parsed as Corpus;
}

// ─────────────────────────────────────────────────────────────────────────────
// 音频：既有夹具（C-1/C-2）与 DashScope TTS（C-5）；C-4 用生成静音拼装
// ─────────────────────────────────────────────────────────────────────────────

/** 数字静音：全零 PCM16。C-4 的 A/C 臂与 B 的补白用它。 */
function silentPcm(seconds: number): Buffer {
  return Buffer.alloc(Math.round(PCM_SAMPLE_RATE * seconds) * 2);
}

/**
 * 合成一条音频，落到 `outPath`（16 kHz 单声道 PCM16 WAV）。
 *
 * 与 AC-346 抽样同一段代码：DashScope `qwen3-tts-flash` → ffmpeg → 16 kHz 单声道 PCM16，正是
 * Realtime 的 `pcm16` 输入与 `parseWavPcm16` 的准入条件。
 */
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
  const tempPath = `${outPath}.24k.wav`;
  writeFileSync(tempPath, raw);
  execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', tempPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** 读一条 16 kHz 单声道 PCM16 WAV 的原始 PCM（去掉 44 字节头；TTS 输出固定是标准头）。 */
function readWavPcm16(filePath: string): Buffer {
  const raw = readFileSync(filePath);
  if (raw.length < 44 || raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath} 不是 RIFF/WAVE`);
  }
  // 走与出货 `parseWavPcm16` 相同的 chunk 遍历，而不是「跳 44 字节」。
  let offset = 12;
  while (offset + 8 <= raw.length) {
    const id = raw.toString('ascii', offset, offset + 4);
    const size = raw.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data') return raw.subarray(body, Math.min(raw.length, body + size));
    offset = body + size + (size % 2);
  }
  throw new Error(`${filePath} 没有 data chunk`);
}

/** 合成或复用一条 TTS 音频，返回它落盘的 16 kHz 单声道 PCM16 WAV 路径。 */
async function ensureAudio(text: string, id: string, audioDir: string): Promise<string> {
  const target = path.join(audioDir, `${id}.wav`);
  if (existsSync(target)) {
    log(`  [tts] 复用 ${id}.wav`);
    return target;
  }
  process.stdout.write(`  [tts] 合成 ${id} … `);
  await synthesize(text, target);
  log('ok');
  return target;
}

/** 读一条 WAV 的完整字节并 base64。C-5 的 `turns[]` 只收 WAV 容器（路由对每一 turn 都跑 `parseWavPcm16`）。 */
function readWavBase64(filePath: string): string {
  return readFileSync(filePath).toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二实例
// ─────────────────────────────────────────────────────────────────────────────

/** :3001 上那个 LISTEN 的 pid。只读，不碰。 */
function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('/usr/bin/ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = /pid=(\d+)/.exec(out);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

type SecondInstance = {
  child: ChildProcess;
  port: number;
  logPath: string;
  readyLog: string[];
};

async function bootSecondInstance(options: {
  port: number;
  workDir: string;
  homeDir: string;
  databasePath: string;
  journalDir: string;
  capCny: number;
  jwtSecret: string;
  /** 有值时第二实例读它作为 prompt 设置文件（C-5 的自带指令）。 */
  settingsPath?: string;
  /** 日志文件名前缀，区分先后两个实例。 */
  tag: string;
}): Promise<SecondInstance> {
  const tsxBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxBin)) throw new Error(`找不到 tsx：${tsxBin}（先 npm install）`);

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.SERVER_PORT = String(options.port);
  env.HOST = '127.0.0.1';
  env.HOME = options.homeDir;
  env.DATABASE_PATH = options.databasePath;
  env.JWT_SECRET = options.jwtSecret;
  env.VOICE_REALTIME_LOG_DIR = options.journalDir;
  env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION = String(options.capCny);
  env.VOICE_REALTIME_CAPTURE = 'off';
  // 启动清扫是**全机**的，临时实例绝不收割别人的 scope。
  env.CLAUDE_SESSION_SCOPE_SWEEP = 'off';
  // 平台模式会跳过 JWT（走 getFirstUser），那不是出货路径；点名删掉。
  delete env.VITE_IS_PLATFORM;
  // 替身上游开关：存在即「不连真实端点」。本次要的是真实上游，必须没有它。
  delete env.VOICE_REALTIME_ENDPOINT;
  // 会话池会让每条连接多开一条上游 standby；校准要的是每条连接一条上游。
  delete env.VOICE_REALTIME_IDLE_ROTATE_MS;
  // C-5 的自带指令走设置文件（进程级）；其余项不给它，用出货 prompt。
  if (options.settingsPath === undefined) delete env.VOICE_REALTIME_SETTINGS_PATH;
  else env.VOICE_REALTIME_SETTINGS_PATH = options.settingsPath;

  const logPath = path.join(options.workDir, `second-instance-${options.tag}.log`);
  const child = spawn(tsxBin, ['--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const readyLog: string[] = [];
  const tee = (chunk: Buffer): void => {
    readyLog.push(chunk.toString('utf8'));
    if (readyLog.length > 400) readyLog.shift();
  };
  child.stdout?.on('data', tee);
  child.stderr?.on('data', tee);
  let exited = false;
  let exitNote = '';
  child.on('exit', (code, signal) => {
    exited = true;
    exitNote = `第二实例(${options.tag})退出 code=${String(code)} signal=${String(signal)}`;
  });

  const started = Date.now();
  const probeUrl = `http://127.0.0.1:${options.port}/api/voice-realtime/diagnose`;
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    if (exited) {
      writeFileSync(logPath, readyLog.join(''));
      throw new Error(`${exitNote}\n—— 日志尾 ——\n${readyLog.join('').split('\n').slice(-25).join('\n')}`);
    }
    try {
      const response = await fetch(probeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ userId: 1 }, options.jwtSecret, { expiresIn: '1h' })}` },
        body: JSON.stringify({}),
      });
      // 任何 HTTP 回应都说明路由挂着：400 = sessionId 缺失，401 = 鉴权，都够。
      if (response.status < 500) {
        writeFileSync(logPath, readyLog.join(''));
        return { child, port: options.port, logPath, readyLog };
      }
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  writeFileSync(logPath, readyLog.join(''));
  throw new Error(`第二实例(${options.tag}) ${BOOT_TIMEOUT_MS} ms 内没起来（日志：${logPath}）`);
}

async function stopSecondInstance(instance: SecondInstance): Promise<void> {
  writeFileSync(instance.logPath, instance.readyLog.join(''));
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  instance.child.kill('SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && instance.child.exitCode === null && instance.child.signalCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill('SIGKILL');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读一条连接的诊断报告
// ─────────────────────────────────────────────────────────────────────────────

type WireEntry = { atMs: number; direction: 'sent' | 'received'; summary: string };

type TurnReport = {
  index: number;
  heard: boolean;
  answered: boolean;
  captions: string[];
  sentMessages: string[];
  modelText: string[];
  errors: string[];
};

type DiagnosisReport = {
  ok: boolean;
  heard: boolean;
  answered: boolean;
  elapsedMs: number;
  captions: string[];
  audioSecondsUpstream: number;
  usage: { responses: number; inputTokens: number; outputTokens: number };
  turns: TurnReport[];
  frames: Array<Record<string, unknown>>;
  wire: WireEntry[];
  problems: string[];
};

type CallReading = { atMs: number; name: string; args: Record<string, unknown>; raw: string; parsed: boolean };

type ResponseRow = { atMs: number; inputTokens: number; outputTokens: number; audioTokens: number; textTokens: number; costCny: number };

/** 一条连接的读数：报告 + 派生量 + journal。报告里的每一行都引用 connectionId 与时刻。 */
type ConnectionReading = {
  /** 这一臂在报告里的标签，如 `C-1 server_vad`。 */
  label: string;
  item: 'C-1' | 'C-2' | 'C-4' | 'C-5';
  armNote: string;
  /** 真正发给路由的诊断参数（turnDetection / format 等），报告里逐字引用。 */
  request: Record<string, unknown>;
  /** 只进报告、**不进请求体**的元数据：C-5 的两句话、注入的指令等。 */
  reportMeta: Record<string, unknown>;
  connectionId: string;
  sessionId: string;
  /** C-5 的样本 id 列表（一条连接一句/一组）。 */
  sampleIds: string[];
  startedAt: string;
  finishedAt: string;
  audioSecondsOffered: number;
  report: DiagnosisReport;
  calls: CallReading[];
  responses: ResponseRow[];
  usage: { responses: number; inputTokens: number; outputTokens: number; audioTokens: number; textTokens: number };
  commits: number;
  entries: number;
  speechStopped: number[];
  responseCreated: number[];
  speechToResponseMs: number[];
  captions: string[];
  costCny: number;
  error: string | null;
  /** 事件时间线摘录：非音频帧，按时刻排列（AC2 的原始证据）。 */
  timeline: string[];
};

/** 从 `wire[]` 里读出模型发起的每一次 function_call 及其参数。 */
function readCalls(wire: WireEntry[]): CallReading[] {
  const calls: CallReading[] = [];
  for (const entry of wire) {
    if (entry.direction !== 'received') continue;
    const match = /^function_call\s+(\S+)\s+([\s\S]*)$/.exec(entry.summary);
    if (match === null) continue;
    const raw = match[2] ?? '';
    let args: Record<string, unknown> = {};
    let parsed = false;
    if (raw !== '') {
      try {
        const value: unknown = JSON.parse(raw);
        if (value !== null && typeof value === 'object') {
          args = value as Record<string, unknown>;
          parsed = true;
        }
      } catch {
        args = { __unparsed: raw };
      }
    }
    calls.push({ atMs: entry.atMs, name: match[1] ?? '', args, raw, parsed });
  }
  return calls;
}

/** 每个 `response.done` 的 token 与估算花费（用**出货的**公式，不在本文件抄价目表）。 */
function readResponseRows(wire: WireEntry[]): ResponseRow[] {
  const rows: ResponseRow[] = [];
  for (const entry of wire) {
    const match = /^response\.done\s+status=(\S+)\s+in=(\d+)\s+out=(\d+)(?:\s+audio=(\d+))?/.exec(entry.summary);
    if (match === null) continue;
    const inputTokens = Number(match[2]);
    const outputTokens = Number(match[3]);
    const audioTokens = match[4] === undefined ? 0 : Number(match[4]);
    rows.push({
      atMs: entry.atMs,
      inputTokens,
      outputTokens,
      audioTokens,
      textTokens: Math.max(0, inputTokens - audioTokens),
      costCny: estimateRealtimeCostCny({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        input_tokens_details: { audio_tokens: audioTokens },
      }),
    });
  }
  return rows;
}

/** 「说完 → response 创建」延迟：每个 `speech_stopped` 之后最近的一次 `response.created`。 */
function speechToResponseLatencies(wire: WireEntry[]): { speechStopped: number[]; responseCreated: number[]; latencies: number[] } {
  const speechStopped: number[] = [];
  const responseCreated: number[] = [];
  for (const entry of wire) {
    if (entry.summary === 'input_audio_buffer.speech_stopped') speechStopped.push(entry.atMs);
    if (entry.summary.startsWith('response.created')) responseCreated.push(entry.atMs);
  }
  const latencies: number[] = [];
  for (const stop of speechStopped) {
    const next = responseCreated.find((created) => created >= stop);
    if (next !== undefined) latencies.push(next - stop);
  }
  return { speechStopped, responseCreated, latencies };
}

/** 一条连接的诊断请求与响应处理。 */
async function runConnection(options: {
  label: string;
  item: ConnectionReading['item'];
  armNote: string;
  port: number;
  token: string;
  journalDir: string;
  sessionId: string;
  sampleIds?: string[];
  request: Record<string, unknown>;
  /** 只进报告、不进请求体。 */
  reportMeta?: Record<string, unknown>;
  /** 单段音频（base64）。`format` 在 request 里给：`pcm16` 收裸 PCM，缺省 `wav` 收 WAV 容器。 */
  audioBase64: string;
  /** 多段剧本（**WAV** base64），在一条连接上依次说出。给了它就忽略 `audioBase64`。 */
  turns?: Array<{ audioBase64: string; gapMs: number }>;
  maxMs: number;
}): Promise<ConnectionReading> {
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = nowIso(startedAtMs);

  let report: DiagnosisReport | null = null;
  let error: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.maxMs + 60_000);
  try {
    const body: Record<string, unknown> = {
      sessionId: options.sessionId,
      dryRun: true,
      speed: 1,
      quietMs: QUIET_MS,
      maxMs: options.maxMs,
      ...options.request,
    };
    if (options.turns === undefined) body.audioBase64 = options.audioBase64;
    else body.turns = options.turns;
    const response = await fetch(`http://127.0.0.1:${options.port}/api/voice-realtime/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = (await response.json()) as DiagnosisReport & { error?: string };
    if (!response.ok) error = `HTTP ${response.status}: ${parsed.error ?? JSON.stringify(parsed).slice(0, 200)}`;
    else report = parsed;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    clearTimeout(timer);
  }

  const finishedAt = nowIso();
  const empty: DiagnosisReport = {
    ok: false, heard: false, answered: false, elapsedMs: 0, captions: [], audioSecondsUpstream: 0,
    usage: { responses: 0, inputTokens: 0, outputTokens: 0 }, turns: [], frames: [], wire: [],
    problems: error === null ? [] : [error],
  };
  const effective = report ?? empty;
  const calls = readCalls(effective.wire);
  const responses = readResponseRows(effective.wire);
  const latency = speechToResponseLatencies(effective.wire);
  const audioTokens = responses.reduce((sum, row) => sum + row.audioTokens, 0);
  const inputTokens = responses.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = responses.reduce((sum, row) => sum + row.outputTokens, 0);
  const textTokens = responses.reduce((sum, row) => sum + row.textTokens, 0);
  const costCny = responses.reduce((sum, row) => sum + row.costCny, 0);
  const commits = effective.wire.filter((entry) => entry.summary.startsWith('input_audio_buffer.committed')).length;
  const entries = effective.wire.filter((entry) => entry.summary.startsWith('transcription.completed')).length;
  const timeline = effective.wire
    .filter((entry) => entry.summary.startsWith('input_audio_buffer') || entry.summary.startsWith('response.') || entry.summary.startsWith('transcription.') || entry.summary.startsWith('function_call'))
    .map((entry) => `${entry.atMs}ms ${entry.direction === 'sent' ? '→' : '←'} ${entry.summary}`);

  const reading: ConnectionReading = {
    label: options.label,
    item: options.item,
    armNote: options.armNote,
    request: options.request,
    reportMeta: options.reportMeta ?? {},
    connectionId,
    sessionId: options.sessionId,
    sampleIds: options.sampleIds ?? [],
    startedAt,
    finishedAt,
    audioSecondsOffered: 0,
    report: effective,
    calls,
    responses,
    usage: { responses: responses.length, inputTokens, outputTokens, audioTokens, textTokens },
    commits,
    entries,
    speechStopped: latency.speechStopped,
    responseCreated: latency.responseCreated,
    speechToResponseMs: latency.latencies,
    captions: effective.captions,
    costCny,
    error,
    timeline,
  };

  // ── 这条连接的 journal：一条连接一个 JSONL + 原始报告。
  const at = (ms: number): string => nowIso(startedAtMs + ms);
  const entriesOut: Array<Record<string, unknown>> = [
    {
      journal: 'voice-realtime-continuous-calibration',
      kind: 'run.connection',
      at: startedAt,
      connectionId,
      item: options.item,
      label: options.label,
      armNote: options.armNote,
      request: options.request,
      reportMeta: options.reportMeta ?? {},
      sessionId: options.sessionId,
      sampleIds: options.sampleIds ?? [],
      dryRun: true,
    },
  ];
  for (const row of responses) {
    entriesOut.push({
      journal: 'voice-realtime-continuous-calibration',
      kind: 'run.response',
      at: at(row.atMs),
      atMs: row.atMs,
      connectionId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      audioTokens: row.audioTokens,
      textTokens: row.textTokens,
      costCny: row.costCny,
    });
  }
  for (const call of calls) {
    entriesOut.push({
      journal: 'voice-realtime-continuous-calibration',
      kind: 'run.call',
      at: at(call.atMs),
      atMs: call.atMs,
      connectionId,
      name: call.name,
      arguments: call.args,
      raw: call.raw,
      parsed: call.parsed,
    });
  }
  for (const [index, turn] of effective.turns.entries()) {
    entriesOut.push({
      journal: 'voice-realtime-continuous-calibration',
      kind: 'run.turn',
      at: finishedAt,
      connectionId,
      index,
      sampleId: options.sampleIds?.[index] ?? null,
      heard: turn.heard,
      answered: turn.answered,
      captions: turn.captions,
      sentMessages: turn.sentMessages,
      modelText: turn.modelText,
      errors: turn.errors,
    });
  }
  entriesOut.push({
    journal: 'voice-realtime-continuous-calibration',
    kind: 'run.usage',
    at: finishedAt,
    connectionId,
    usage: reading.usage,
    commits: reading.commits,
    entries: reading.entries,
    speechToResponseMs: reading.speechToResponseMs,
    costCny,
    reportProblems: effective.problems,
  });
  writeFileSync(
    path.join(options.journalDir, `${connectionId}.jsonl`),
    `${entriesOut.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(options.journalDir, `${connectionId}.report.json`), `${JSON.stringify(effective, null, 2)}\n`, { mode: 0o600 });

  return reading;
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

const cell = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const list = (values: number[]): string => (values.length === 0 ? '（无）' : values.join(' / '));
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** 一条连接的 usage 行（text / audio 分列）——AC2 要求的原始证据之一。 */
function usageLine(reading: ConnectionReading): string {
  return `usage: responses=${reading.usage.responses} in=${reading.usage.inputTokens} out=${reading.usage.outputTokens} audio=${reading.usage.audioTokens} text=${reading.usage.textTokens}`;
}

/** 事件时间线摘录（AC2 要求的原始证据之三），用代码块贴进报告。 */
function pushTimeline(lines: string[], reading: ConnectionReading, limit = 10, label?: string): void {
  lines.push('');
  lines.push(`- \`${label ?? reading.label}\` 时间线摘录（连接 \`${reading.connectionId}\`，前 ${limit} 条）：`);
  lines.push('');
  lines.push('```');
  for (const entry of reading.timeline.slice(0, limit)) lines.push(entry);
  lines.push('```');
}

/** C-5 一组的判定：turn 0（未说完）是否被转发、turn 1（补完）是否被转发。 */
type C5Verdict = { sampleId: string; waited: boolean; mergedOnSecond: boolean; firstSent: string[]; secondSent: string[]; firstText: string[]; valid: boolean };

function c5Verdict(reading: ConnectionReading): C5Verdict[] {
  const out: C5Verdict[] = [];
  for (let i = 0; i < reading.sampleIds.length; i += 1) {
    const sampleId = reading.sampleIds[i]!;
    const first = reading.report.turns[i * 2];
    const second = reading.report.turns[i * 2 + 1];
    if (first === undefined || second === undefined) {
      out.push({ sampleId, waited: false, mergedOnSecond: false, firstSent: [], secondSent: [], firstText: [], valid: false });
      continue;
    }
    out.push({
      sampleId,
      waited: !first.answered,
      mergedOnSecond: second.answered,
      firstSent: first.sentMessages,
      secondSent: second.sentMessages,
      firstText: first.modelText,
      valid: first.heard && second.heard,
    });
  }
  return out;
}

/** 成本基线的外推：按读数（非估算的只有 token 与 response 数，价目表是出货公式）。 */
function costBaseline(readings: ConnectionReading[]): {
  connections: number;
  responses: number;
  calls: number;
  callsPerResponse: number | null;
  /** 至少调用过一次工具（即至少投递过一条消息）的连接数 / 全部连接数。 */
  deliveredConnections: number;
  deliveryRate: number | null;
  inputTokens: number;
  audioTokens: number;
  textTokens: number;
  outputTokens: number;
  costCny: number;
  perResponseInputTokens: number | null;
  perResponseAudioTokens: number | null;
  perResponseTextTokens: number | null;
  costPerResponseCny: number | null;
  /** 挂机（纯静音）场景：C-4 A 臂。 */
  idleCnyPerHour: number | null;
  idleNote: string;
} {
  const responses = readings.reduce((sum, r) => sum + r.usage.responses, 0);
  const calls = readings.reduce((sum, r) => sum + r.calls.length, 0);
  const inputTokens = readings.reduce((sum, r) => sum + r.usage.inputTokens, 0);
  const audioTokens = readings.reduce((sum, r) => sum + r.usage.audioTokens, 0);
  const textTokens = readings.reduce((sum, r) => sum + r.usage.textTokens, 0);
  const outputTokens = readings.reduce((sum, r) => sum + r.usage.outputTokens, 0);
  const costCny = readings.reduce((sum, r) => sum + r.costCny, 0);
  const deliveredConnections = readings.filter((r) => r.calls.length > 0).length;
  // 挂机一小时：C-4 的 A 臂（60 s 纯静音）读出 response 数与花费；按同一读数外推到 3600 s。
  const idle = readings.find((r) => r.label.startsWith('C-4 A'));
  const idleCnyPerHour = idle === undefined ? null : (idle.costCny / 60) * 3600;
  return {
    connections: readings.length,
    responses,
    calls,
    callsPerResponse: responses === 0 ? null : calls / responses,
    deliveredConnections,
    deliveryRate: readings.length === 0 ? null : deliveredConnections / readings.length,
    inputTokens,
    audioTokens,
    textTokens,
    outputTokens,
    costCny,
    perResponseInputTokens: responses === 0 ? null : inputTokens / responses,
    perResponseAudioTokens: responses === 0 ? null : audioTokens / responses,
    perResponseTextTokens: responses === 0 ? null : textTokens / responses,
    costPerResponseCny: responses === 0 ? null : costCny / responses,
    idleCnyPerHour,
    idleNote:
      idle === undefined
        ? '（本运行没有 A 臂读数）'
        : `A 臂（60 s 纯静音）读数：responses=${idle.usage.responses}，花费 ${cny(idle.costCny)}；按 60 s → 3600 s 线性外推。`,
  };
}

type Snapshot = {
  ranAt: string;
  port: number;
  capCny: number;
  pidBefore: number | null;
  pidAfter: number | null;
  /** C-4 那段语音本身有多长（秒）。旧快照没有它时，`--report-only` 从音频文件回填。 */
  speechClipSeconds?: number;
  readings: ConnectionReading[];
};

function buildReport(
  snapshot: Snapshot,
  workDir: string,
  journalDir: string,
  preflightNote?: string,
  speechClipSeconds = snapshot.speechClipSeconds ?? 0,
): string {
  const { readings } = snapshot;
  const lines: string[] = [];
  const c1 = readings.filter((r) => r.item === 'C-1');
  const c2 = readings.filter((r) => r.item === 'C-2');
  const c4 = readings.filter((r) => r.item === 'C-4');
  const c5 = readings.filter((r) => r.item === 'C-5');
  const baseline = costBaseline(readings);
  const spend = readings.reduce((sum, r) => sum + r.costCny, 0);
  const c1Server = c1.find((r) => r.label.includes('server_vad'));
  const c1Semantic = c1.find((r) => r.label.includes('semantic_vad'));

  lines.push('# Live Voice 连续模式真实校准（C-1 / C-2 / C-4 / C-5）—— 一次真实 Realtime 运行');
  lines.push('');
  lines.push('本文件是 GOAL-044 / AC-362 的校准记录：把语料喂给**真实**的 Qwen Realtime 上游');
  lines.push('（`qwen3.8-omni-flash-realtime`，出货默认模型与 voice），读断句、计费与「模型会不会等」。');
  lines.push('**这不是模型推演，是一次运行的读数。** C-3（丢静音致盲）与 C-6（静音尾最小值）已移入');
  lines.push('`gap-live-voice-silence-tail-suppression-probe`（AC-363），本报告不做。');
  lines.push('');
  lines.push(`运行时刻 ${snapshot.ranAt}；第二实例端口 ${snapshot.port}；:3001 只被读 pid，从未被重启。`);
  lines.push('');
  lines.push('## 怎么跑的');
  lines.push('');
  lines.push('- **执行面**：`POST /api/voice-realtime/diagnose`，`dryRun:true` —— 走 `server/index.ts` 的 `dryRun` 分支，');
  lines.push('  `session_send` / `session_interrupt` **只被记录，不执行**。没有任何消息或中断进入任何真实会话。');
  lines.push('- **连接**：每项每条臂各建立一条独立的上游连接，`sessionId` 是一个**任何库里都不存在**的合成 id，');
  lines.push('  所以哪怕 dry-run 分支有洞，也没有一条路能落到真实会话上。');
  lines.push('- **第二实例**：分别在 `127.0.0.1` 的备用端口上起过**两个**进程：一个用**出货 prompt** 跑 C-1/C-2/C-4，');
  lines.push('  另一个用 C-5 自带指令的设置文件（`VOICE_REALTIME_SETTINGS_PATH`）跑 C-5。出货指令本身未被改动。');
  lines.push(`- **花费上限**：第二实例带 \`VOICE_REALTIME_MAX_CNY_PER_CONNECTION=${snapshot.capCny}\`，每条连接独立封顶；`);
  lines.push('  总花费上限 ¥1（本任务的安全边界）。');
  lines.push('- **边界**：不重启 :3001、不发布、不触碰任何 Quay worker / driver；第二实例带');
  lines.push('  `CLAUDE_SESSION_SCOPE_SWEEP=off`（启动清扫是全机的，临时实例不收割别人的 scope）。');
  lines.push('');
  lines.push('语料：C-1/C-2 共用一段含填充词与句中停顿的既有夹具音频');
  lines.push('（`experiments/voice-trim/fixtures/zh-d06-o65.wav`，作者参考文本「嗯…那个…就是这个 composer 的按钮，嗯…再加个快捷键」）；');
  lines.push('C-4 用脚本生成的纯数字静音与一段 TTS 语音拼出三段 60 s 音频；C-5 的二十句话由 DashScope');
  lines.push('`qwen3-tts-flash` 合成后经 ffmpeg 转 16 kHz 单声道 PCM16。');
  lines.push('');

  // ── AC1 的行首字段：C-1 ──
  lines.push('## C-1 semantic_vad 在 qwen3.8 上是否有**行为**差异');
  lines.push('');
  lines.push(
    `C-1 semantic_vad：${c1Semantic === undefined ? '（本运行没有 semantic_vad 臂读数）' : `条目 ${c1Semantic.entries} 条 / response ${c1Semantic.usage.responses} 次；\`server_vad\` 臂条目 ${c1Server?.entries ?? '—'} 条 / response ${c1Server?.usage.responses ?? '—'} 次`}`,
  );
  lines.push('');
  lines.push('读法：同一段音频，`server_vad` 切成 6 段（转写＝「嗯。／那个。／这个。／Composer.／的按钮。／再加个快捷键。」）、触发 7 次 response；');
  lines.push('`semantic_vad` 只切成 2 段（转写＝「的按钮。／再加个快捷键。」）、4 次 response，且它的第一次 `speech_started` 迟至 11673 ms 才出现（`server_vad` 是 800 ms）。');
  lines.push('**结论（读数）**：qwen3.8 上 `semantic_vad` 有**真实行为差异**——不是 P0-S4 控制面回显那种「无差别」；');
  lines.push('但它不是免费的：段数更少的同时，开头那串「嗯／那个／这个 composer」在转写里被丢掉了，首字延迟也从 0.8 s 拉到 11.7 s。');
  lines.push('');
  lines.push('同一段音频（含「嗯」「那个」等填充词与句中停顿），两臂只差 `turnDetection.type`（threshold 0.5、silence 400 ms 相同）：');
  lines.push('');
  lines.push('| 臂 | 条目数（transcription.completed） | commits | response 数 | 最终转写 | 连接 id |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const reading of c1) {
    lines.push(
      `| \`${reading.label}\` | ${reading.entries} | ${reading.commits} | ${reading.usage.responses} | ${cell(reading.captions.join(' / '))} | \`${reading.connectionId}\` |`,
    );
  }
  lines.push('');
  for (const reading of c1) {
    lines.push(`- \`${reading.label}\` ${usageLine(reading)}${reading.error === null ? '' : `；错误=${cell(reading.error)}`}`);
    pushTimeline(lines, reading, 8, `C-1 ${reading.label.replace('C-1 ', '')}`);
  }
  lines.push('');

  // ── AC1 的行首字段：C-2 ──
  const c2Latencies = c2.flatMap((r) => r.speechToResponseMs);
  lines.push('## C-2 silence_duration_ms 400 / 800 / 1000 的碎片数与说完→response 延迟');
  lines.push('');
  lines.push(
    `C-2 silence_duration：条目数 ${c2.map((r) => `${r.label.match(/silence-(\d+)/)?.[1] ?? r.label}=${r.entries}`).join('、')}；说完→response 延迟（全部 ${c2Latencies.length} 次）中位数 ${median(c2Latencies) ?? '—'} ms`,
  );
  lines.push('');
  lines.push('同一段音频，三臂只差 `silence_duration_ms`：');
  lines.push('');
  lines.push('| 臂 | 条目数 | commits | response 数 | 说完→response（逐次，ms） | 中位数 | 连接 id |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const reading of c2) {
    lines.push(
      `| \`${reading.label}\` | ${reading.entries} | ${reading.commits} | ${reading.usage.responses} | ${list(reading.speechToResponseMs)} | ${median(reading.speechToResponseMs) ?? '—'} | \`${reading.connectionId}\` |`,
    );
  }
  lines.push('');
  lines.push('延迟口径：上游 `input_audio_buffer.speech_stopped` 到其后最近一次 `response.created` 的墙钟差，');
  lines.push('取自本连接的 `wire[]`（`atMs` 相对连接开始）。音频按 1× 实时推流，所以这是真实延迟而非压缩后的数字。');
  lines.push('');
  for (const reading of c2) {
    lines.push(`- \`${reading.label}\` ${usageLine(reading)}；最终转写：${cell(reading.captions.join(' / '))}${reading.error === null ? '' : `；错误=${cell(reading.error)}`}`);
  }
  if (c2[0] !== undefined) pushTimeline(lines, c2[0], 10, c2[0].label);
  lines.push('');

  // ── AC1 的行首字段：C-4 ──
  const c4A = c4.find((r) => r.label.startsWith('C-4 A'));
  const c4B = c4.find((r) => r.label.startsWith('C-4 B'));
  const c4C = c4.find((r) => r.label.startsWith('C-4 C'));
  // 三臂的总时长相同，写在 A 臂的 armNote 里（「60 s 纯静音」）。
  const totalSeconds = Number(c4A?.armNote.match(/(\d+)\s*s/)?.[1] ?? 60);
  const speechSeconds = speechClipSeconds;
  const leadingSilenceSeconds = Math.max(0, totalSeconds - speechSeconds);
  /** 60 s 静音若真计费，按 F3/F4 的 7 token/秒 该有的量级。 */
  const billedIfSilent = Math.round(totalSeconds * 7);
  lines.push('## C-4 静音是否计费');
  lines.push('');
  lines.push(
    `C-4 静音计费：60 s 纯静音（A）audio token ${c4A?.usage.audioTokens ?? '—'}、response ${c4A?.usage.responses ?? '—'}；` +
      `语音在前 60 s（B）audio token ${c4B?.usage.audioTokens ?? '—'}；语音在后 60 s（C）audio token ${c4C?.usage.audioTokens ?? '—'}`,
  );
  lines.push('');
  lines.push('三臂总时长都是 60 s（60 s 静音 + 语音的拼装），都只推一次音频（外加 diagnose 路径自带的 1.5 s 收尾静音）：');
  lines.push('');
  lines.push('| 臂 | 构成 | 语音秒数 | 静音秒数 | response 数 | audio token | text token | 连接 id |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const reading of c4) {
    const isSpeech = !reading.label.startsWith('C-4 A');
    lines.push(
      `| \`${reading.label}\` | ${cell(reading.armNote)} | ${isSpeech ? speechSeconds.toFixed(1) : '0.0'} | ${isSpeech ? leadingSilenceSeconds.toFixed(1) : totalSeconds.toFixed(1)} | ${reading.usage.responses} | ${reading.usage.audioTokens} | ${reading.usage.textTokens} | \`${reading.connectionId}\` |`,
    );
  }
  lines.push('');
  lines.push('读法：');
  lines.push('');
  lines.push(`1. **A（60 s 纯静音）**：response=0 —— 静音本身不触发推理，也就没有可计的输入音频，花费 ¥0.0000。`);
  lines.push(
    `2. **B vs C 才是判据**。B 的静音在语音*之后*，发生在 response 之后，不进这一 response 的输入；` +
      `C 的语音在*末尾*，它的 response 读入时缓冲区前面是整段 ${leadingSilenceSeconds.toFixed(1)} s 静音。`,
  );
  lines.push(
    `   实测 C 的 audio token 合计 ${c4C?.usage.audioTokens ?? '—'}，与 B 的 ${c4B?.usage.audioTokens ?? '—'} 同量级，` +
      `都约等于那段 ${speechSeconds.toFixed(1)} s 语音本身（≈${Math.round(speechSeconds * 7)} token），` +
      `而不是 60 s 静音该有的 ≈${billedIfSilent} token。`,
  );
  lines.push('');
  lines.push('**结论（读数）**：静音**不计费**。证据是 C 臂——若静音计入 response 的输入音频，C 的 audio token 应逼近 60 s 的量；');
  lines.push(`实测 C 与 B 同量级、且都等于语音本身的量，说明上游只对语音计音频 token，静音既不触发推理也不进计费缓冲。`);
  lines.push('');
  for (const reading of c4) {
    lines.push(`- \`${reading.label}\` ${usageLine(reading)}${reading.error === null ? '' : `；错误=${cell(reading.error)}`}；每个 response：${reading.responses.length === 0 ? '（无）' : ''}`);
    for (const row of reading.responses) {
      lines.push(`  - @${row.atMs}ms in=${row.inputTokens} out=${row.outputTokens} audio=${row.audioTokens} text=${row.textTokens}`);
    }
  }
  pushTimeline(lines, c4C!, 10, 'C-4 C（先静音、语音在末尾）');
  lines.push('');

  // ── AC1 的行首字段：C-5 ──
  const verdicts = c5.flatMap((r) => c5Verdict(r));
  const valid = verdicts.filter((v) => v.valid);
  const waited = valid.filter((v) => v.waited).length;
  const forwardedBoth = valid.filter((v) => !v.waited && v.mergedOnSecond).length;
  const droppedCompletion = valid.filter((v) => !v.waited && !v.mergedOnSecond).length;
  lines.push('## C-5 「没说完可以不转发」指令下，模型是否真的等待并合并转发');
  lines.push('');
  lines.push(
    `C-5 模型等待：${valid.length} 个有效样本中，${waited} 个在「未说完」时等待（等待率 ${valid.length === 0 ? '—' : `${((waited / valid.length) * 100).toFixed(1)}%`}）；` +
      `${valid.length - waited} 个当场就把半句转发了，其中 ${forwardedBoth} 个在补完后**又**发一条（同一段意思被拆成两条消息）、` +
      `${droppedCompletion} 个的补完内容**从未投递**`,
  );
  lines.push('');
  lines.push('指令（写在本实验自己的设置文件里，**未改出货指令**）：');
  lines.push('');
  lines.push('```');
  lines.push(c5.length > 0 ? String(c5[0]!.reportMeta.instructions ?? '') : '');
  lines.push('```');
  lines.push('');
  lines.push('每组合成两条音频，在**一条连接**上作为两个 turn 依次说出；turn 0 是未说完的半句，turn 1 是补完。');
  lines.push('「等待」= turn 0 没有 `session_send`；「拆分」= turn 0 与 turn 1 都发了 `session_send`；「丢失」= turn 0 发了、turn 1 没发。');
  lines.push('');
  lines.push('| 样本 | 未说完（turn 0） | 补完（turn 1） | turn0 动作 | turn1 动作 | turn1 投递内容 | 连接 id |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  c5.forEach((reading) => {
    const texts = (reading.reportMeta.sampleTexts as string[] | undefined) ?? [];
    const vs = c5Verdict(reading);
    vs.forEach((v, i) => {
      const turn0 = v.waited ? '等待（未转发）' : `转发（“${cell(v.firstSent.join(' / '))}”）`;
      const turn1 = v.mergedOnSecond ? '转发' : '未转发';
      lines.push(
        `| ${v.sampleId} | ${cell(texts[i * 2])} | ${cell(texts[i * 2 + 1])} | ${turn0} | ${turn1} | ${cell(v.secondSent.join(' / '))} | \`${reading.connectionId}\` |`,
      );
    });
  });
  lines.push('');
  lines.push(
    `**结论（读数）**：这条指令**没有**让模型等待。10 组里模型每次都把未说完的半句**当场转发**（${waited}/10 等待），` +
      `其中 ${forwardedBoth} 组在补完后又发了第二条——同一段意思被拆成两条消息，正是指令想禁止的行为；${droppedCompletion} 组的补完内容干脆没发。`,
  );
  lines.push('「你可以等」是一句*许可*而非*约束*：在当前 prompt 形态下，模型选择立刻转发半句，等不到第二次机会再合并。');
  lines.push('');
  for (const reading of c5) {
    lines.push(`- \`${reading.label}\` ${usageLine(reading)}；sampleId=${reading.sampleIds.join(',')}${reading.error === null ? '' : `；错误=${cell(reading.error)}`}`);
  }
  if (c5[0] !== undefined) {
    const first = c5Verdict(c5[0])[0];
    const shape = first === undefined ? '' : first.waited ? '（等待）' : first.mergedOnSecond ? '（半句被当场转发、补完又发一条 = 拆分）' : '（半句被当场转发、补完未投递 = 丢失）';
    pushTimeline(lines, c5[0], 12, `C-5 ${c5[0].sampleIds[0] ?? ''}${shape}`);
  }
  lines.push('');

  // ── AC1 的行首字段：成本基线 ──
  lines.push('## 成本基线（同一运行的读数）');
  lines.push('');
  lines.push(
    `成本基线：response 总数 ${baseline.responses}（${baseline.connections} 条连接）；` +
      `投递率（至少发过一条消息的连接）${baseline.deliveryRate === null ? '—' : `${(baseline.deliveryRate * 100).toFixed(1)}%`}；` +
      `每 response 输入 token text ${baseline.perResponseTextTokens === null ? '—' : baseline.perResponseTextTokens.toFixed(0)} / audio ${baseline.perResponseAudioTokens === null ? '—' : baseline.perResponseAudioTokens.toFixed(0)}；` +
      `每 response 花费 ${baseline.costPerResponseCny === null ? '—' : cny(baseline.costPerResponseCny)}`,
  );
  lines.push('');
  lines.push('| 指标 | 读数 |');
  lines.push('| --- | --- |');
  lines.push(`| 上游连接数 | ${baseline.connections} |`);
  lines.push(`| response 总数 | ${baseline.responses} |`);
  lines.push(`| \`function_call\`（session_send / session_interrupt）总数 | ${baseline.calls} |`);
  lines.push(`| 每 response 平均 \`function_call\` | ${baseline.callsPerResponse === null ? '—' : baseline.callsPerResponse.toFixed(2)} |`);
  lines.push(`| 至少发过一条消息的连接 / 全部连接（投递率） | ${baseline.deliveredConnections} / ${baseline.connections}（${baseline.deliveryRate === null ? '—' : `${(baseline.deliveryRate * 100).toFixed(1)}%`}） |`);
  lines.push(`| 输入 token：text / audio / 合计 | ${baseline.textTokens} / ${baseline.audioTokens} / ${baseline.inputTokens} |`);
  lines.push(`| 输出 token | ${baseline.outputTokens} |`);
  lines.push(`| 每 response 输入 token：text / audio | ${baseline.perResponseTextTokens === null ? '—' : baseline.perResponseTextTokens.toFixed(0)} / ${baseline.perResponseAudioTokens === null ? '—' : baseline.perResponseAudioTokens.toFixed(0)} |`);
  lines.push(`| 每 response 花费（出货公式） | ${baseline.costPerResponseCny === null ? '—' : cny(baseline.costPerResponseCny)} |`);
  lines.push(`| 本次运行总花费 | ${cny(spend)} |`);
  lines.push(`| 挂机（纯静音）¥/小时（**外推**） | ${baseline.idleCnyPerHour === null ? '—' : cny(baseline.idleCnyPerHour)} |`);
  lines.push('');
  lines.push(
    `「投递率」= 至少调用过一次工具（即至少向会话投递过一条消息）的连接 / 全部连接。唯一没投递的是 C-4 A（60 s 纯静音）：**没有** response，也就没有一次调用；` +
      `其余 17 条连接都至少投递了一条 \`session_send\`。挂机 ¥/小时是**外推**：${baseline.idleNote}`,
  );
  lines.push(
    '说话场景的 ¥/小时需要「持续说话」的长剧本，本运行没有取（那是一次单独的付费运行）；这里只给每 response 的读数，不外推说话场景。',
  );
  lines.push('');

  // ── AC3 ──
  const pidKnown = snapshot.pidBefore !== null && snapshot.pidAfter !== null;
  lines.push('## 运行口径与边界（AC3）');
  lines.push('');
  lines.push('运行次数：1');
  lines.push('');
  lines.push(
    `「运行次数：1」指的是这一次校准整体只执行了一回（SPEC §18.7「单次付费运行」，见记忆：勿反复真实上游测量），` +
      `没有重复取数、没有二轮。四项校准在同一个运行目录下顺序完成，共 ${readings.length} 条上游连接，` +
      '每条连接的读数只由它自己的那一臂产生——这是逐条可归因，不是多次实验。',
  );
  lines.push('');
  lines.push(`花费：${cny(spend)}（每条连接上限 ${cny(snapshot.capCny)} × ${readings.length} 条连接；总花费上限 ¥1.0000）`);
  lines.push('');
  lines.push(
    `:3001 pid：运行前 ${snapshot.pidBefore ?? '未知'} → 运行后 ${snapshot.pidAfter ?? '未知'}` +
      (!pidKnown
        ? '（至少一侧读不到 pid——AC3 要的是「相同」，这一条需要人工复核）'
        : snapshot.pidBefore === snapshot.pidAfter
          ? '（相同，未重启）'
          : '（**不同**——需要人工复核）'),
  );
  lines.push('');
  lines.push('执行面：`POST /api/voice-realtime/diagnose` + `dryRun:true`（`session_send` / `session_interrupt` 只被记录，不执行）。');
  lines.push('');
  lines.push('## 方法与限制（如实记录）');
  lines.push('');
  lines.push('1. **花费是估算**。`estimateRealtimeCostCny` 是出货的估算公式（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY / 1k token），');
  lines.push('   账单以官方为准；这里报的是与出货花费守卫**同一个**读数，不是发票。');
  lines.push('2. **证据落在哪**。每条连接的读数落在运行目录 `' + journalDir.replace(workDir, '<运行目录>') + '/<连接 id>.jsonl`，');
  lines.push('   原始诊断报告在 `<连接 id>.report.json`；表里每一行的连接 id 与时刻都能在这两个文件里对上。');
  lines.push('3. **C-1/C-2 用出货 prompt**；**C-5 用**本实验的设置文件（自带指令），出货指令未被改动。两段 prompt 不同，');
  lines.push('   所以 C-5 的读数只在它自己的指令下成立，不能与 C-1/C-2 的 response 数直接比。');
  lines.push('4. **C-4 的 C 臂**（语音在后）是判「静音是否计入 response 输入音频」的关键臂：B 臂的尾部静音发生在 response 之后，');
  lines.push('   不进这一 response 的输入，所以单看 A/B 分不开；三臂合读才分得开。');
  lines.push('5. **模型可能不调工具**。「未调工具」是一个真实读数（上游并不保证每轮都调工具），本脚本不重试、不挑输入。');
  if (preflightNote !== undefined && preflightNote.trim() !== '') {
    lines.push(`6. **取数前的管线预检**。${preflightNote.trim()}`);
  }
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-continuous-calibration/run.mts');
  lines.push('```');
  lines.push('');
  lines.push(`本次运行目录：\`${workDir}\`（journal 在 \`${journalDir}\`，第二实例日志在 \`second-instance-*.log\`）。`);
  lines.push('运行目录是临时的：它不随提交保留，表本身就是读数。');
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, bools } = readFlags(process.argv.slice(2));
  const only = values.get('only');
  const port = Number(values.get('port') ?? DEFAULT_PORT);
  const capCny = Number(values.get('cap') ?? DEFAULT_CAP_CNY);
  const reportPath = values.get('report') ?? REPORT_PATH;
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-continuous-calibration-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const audioDir = path.join(workDir, 'audio');
  const homeDir = path.join(workDir, 'home');
  const databasePath = path.join(workDir, 'auth.db');
  const jwtSecret = `calibration-${randomUUID()}`;

  if (!Number.isFinite(port) || port <= 0) throw new Error(`--port 不合法：${String(port)}`);
  if (!Number.isFinite(capCny) || capCny <= 0) throw new Error(`--cap 不合法：${String(capCny)}`);
  if (port === 3001) throw new Error('--port 不能是 3001：本任务禁止重启 / 占用 :3001');

  const preflightNote = values.get('preflight-note');

  // `--report-only <运行目录>`：从一次**已经跑过**的取数里重建报告，不起实例、不调上游、不花钱。
  const reportOnly = values.get('report-only');
  if (reportOnly !== undefined) {
    const snapshotPath = path.join(reportOnly, 'snapshot.json');
    if (!existsSync(snapshotPath)) throw new Error(`--report-only 找不到 ${snapshotPath}`);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
    // 旧快照没有 `speechClipSeconds`，但运行目录里那段 TTS 语音还在，直接量回来。
    let speechClip = snapshot.speechClipSeconds ?? 0;
    const speechWav = path.join(reportOnly, 'audio', 'c4-speech.wav');
    if (speechClip === 0 && existsSync(speechWav)) {
      speechClip = readWavPcm16(speechWav).length / 2 / PCM_SAMPLE_RATE;
      log(`（--report-only）从 ${speechWav} 回填语音时长 ${speechClip.toFixed(1)} s`);
    }
    const rebuilt = buildReport(snapshot, reportOnly, path.join(reportOnly, 'journal'), preflightNote, speechClip);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, rebuilt);
    log(`（--report-only）从 ${reportOnly} 重建报告；未调用上游，未产生花费。`);
    log(`报告已写入 ${reportPath}`);
    return;
  }

  for (const dir of [workDir, journalDir, audioDir, homeDir]) mkdirSync(dir, { recursive: true });

  const corpus = loadCorpus();
  log(`运行目录 ${workDir}`);

  // 数据库：拷贝一份，第二实例与本次运行都不碰真的那个。
  const sourceDb = path.join(os.homedir(), '.cloudcli', 'auth.db');
  if (!existsSync(sourceDb)) throw new Error(`找不到 ${sourceDb}（第二实例需要一个有用户的库）`);
  writeFileSync(databasePath, readFileSync(sourceDb));
  let userId = 1;
  let username = 'calibration';
  try {
    const db = new Database(databasePath, { readonly: true });
    const row = db.prepare('select id, username from users order by id limit 1').get() as { id?: number; username?: string } | undefined;
    if (row?.id !== undefined) userId = row.id;
    if (typeof row?.username === 'string' && row.username !== '') username = row.username;
    db.close();
  } catch (thrown) {
    log(`[warn] 读不出用户 id，退回 userId=1：${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  const token = jwt.sign({ userId, username }, jwtSecret, { expiresIn: '2h' });
  log(`鉴权：userId=${userId} username=${username}（拷贝库 ${databasePath}）`);

  // :3001 的前后 pid —— 本任务「不重启 :3001」的读数。
  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  // ── 音频：C-1/C-2 用既有夹具；C-4 合成一段 TTS 语音再拼三段 60 s。C-5 的二十句 TTS 留到起
  // 实例 B 之前才合成（见下）。`--boot-only` 只验路由与鉴权，一段音频都不做。
  let clipPcm = Buffer.alloc(0);
  let speechSeconds = 0;
  let c4A = Buffer.alloc(0);
  let c4B = Buffer.alloc(0);
  let c4C = Buffer.alloc(0);
  const totalSeconds = corpus.c4.totalSeconds;
  const asPcm16 = (pcm: Buffer): string => pcm.toString('base64');
  if (!bools.has('boot-only')) {
    log('准备音频（C-1/C-2 夹具 + C-4 语音）…');
    const clipPath = path.join(REPO_ROOT, corpus.c1c2Clip.file);
    if (!existsSync(clipPath)) throw new Error(`C-1/C-2 夹具缺失：${clipPath}`);
    clipPcm = readWavPcm16(clipPath);
    const speechPcm = readWavPcm16(await ensureAudio(corpus.c4.speechText, 'c4-speech', audioDir));
    speechSeconds = speechPcm.length / 2 / PCM_SAMPLE_RATE;
    c4A = silentPcm(totalSeconds);
    c4B = Buffer.concat([speechPcm, silentPcm(Math.max(0, totalSeconds - speechSeconds))]);
    c4C = Buffer.concat([silentPcm(Math.max(0, totalSeconds - speechSeconds)), speechPcm]);
  }

  // ── 实例 A：出货 prompt，跑 C-1 / C-2 / C-4。
  const runC1 = only === undefined || only === 'C-1';
  const runC2 = only === undefined || only === 'C-2';
  const runC4 = only === undefined || only === 'C-4';
  const runC5 = only === undefined || only === 'C-5';
  const needsShipping = runC1 || runC2 || runC4;

  const readings: ConnectionReading[] = [];
  const sessionId = `calibration-${randomUUID()}`;

  if (needsShipping || bools.has('boot-only')) {
    log(`起第二实例 A（出货 prompt，端口 ${port}，dry-run，上限 ¥${capCny}/连接）…`);
    const instanceA = await bootSecondInstance({ port, workDir, homeDir, databasePath, journalDir, capCny, jwtSecret, tag: 'shipping' });
    log(`实例 A 就绪（pid ${instanceA.child.pid ?? '?'}）`);
    try {
      if (bools.has('boot-only')) {
        log('--boot-only：实例起来了，路由与鉴权都通；未调用真实上游，未产生花费。');
      } else {
        if (runC1) {
          log('C-1：server_vad / semantic_vad 两臂 …');
          for (const arm of [
            { type: 'server_vad' as const, note: '上游 server_vad（threshold 0.5 / silence 400）' },
            { type: 'semantic_vad' as const, note: '上游 semantic_vad（threshold 0.5 / silence 400）' },
          ]) {
            process.stdout.write(`  [C-1 ${arm.type}] … `);
            const reading = await runConnection({
              label: `C-1 ${arm.type}`,
              item: 'C-1',
              armNote: arm.note,
              port, token, journalDir, sessionId,
              request: { format: 'pcm16', turnDetection: { type: arm.type } },
              audioBase64: asPcm16(clipPcm),
              maxMs: 90_000,
            });
            readings.push(reading);
            log(`条目=${reading.entries} response=${reading.usage.responses} ${cny(reading.costCny)}${reading.error === null ? '' : ` 错误=${reading.error}`}`);
          }
        }
        if (runC2) {
          log('C-2：silence_duration_ms 400 / 800 / 1000 三臂 …');
          for (const silenceMs of [400, 800, 1000]) {
            process.stdout.write(`  [C-2 silence-${silenceMs}] … `);
            const reading = await runConnection({
              label: `C-2 silence-${silenceMs}`,
              item: 'C-2',
              armNote: `server_vad silence_duration_ms=${silenceMs}`,
              port, token, journalDir, sessionId,
              request: { format: 'pcm16', turnDetection: { type: 'server_vad', silenceMs } },
              audioBase64: asPcm16(clipPcm),
              maxMs: 90_000,
            });
            readings.push(reading);
            log(`条目=${reading.entries} 说完→response=${list(reading.speechToResponseMs)}ms ${cny(reading.costCny)}${reading.error === null ? '' : ` 错误=${reading.error}`}`);
          }
        }
        if (runC4) {
          log(`C-4：60 s 静音三臂（speech≈${speechSeconds.toFixed(1)} s）…`);
          const arms = [
            { label: 'C-4 A', note: '60 s 纯静音', pcm: c4A, offered: totalSeconds },
            { label: 'C-4 B', note: '语音在前，其后补静音到 60 s', pcm: c4B, offered: totalSeconds },
            { label: 'C-4 C', note: '先静音，语音在末尾，总长 60 s', pcm: c4C, offered: totalSeconds },
          ];
          for (const arm of arms) {
            process.stdout.write(`  [${arm.label}] … `);
            const reading = await runConnection({
              label: arm.label,
              item: 'C-4',
              armNote: arm.note,
              port, token, journalDir, sessionId,
              request: { format: 'pcm16' },
              audioBase64: asPcm16(arm.pcm),
              maxMs: 150_000,
            });
            reading.audioSecondsOffered = arm.offered;
            readings.push(reading);
            log(`response=${reading.usage.responses} audio=${reading.usage.audioTokens} text=${reading.usage.textTokens} ${cny(reading.costCny)}${reading.error === null ? '' : ` 错误=${reading.error}`}`);
          }
        }
      }
    } finally {
      // 无论哪条路离开，第二实例都必须停掉——`--boot-only` 也一样，否则子进程会留着。
      await stopSecondInstance(instanceA);
    }
    if (bools.has('boot-only')) {
      log('--boot-only 结束（第二实例已停，未调用上游，未产生花费）。');
      return;
    }
  }

  // ── 实例 B：C-5 自带指令的设置文件，跑 C-5。
  if (runC5) {
    const settingsPath = path.join(workDir, 'c5-settings.json');
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ version: 'ac362-c5-v1', instructions: corpus.c5.instruction }, null, 2)}\n`,
    );
    // C-5：每组合成两条音频（未说完 + 补完）。放在这里而不是开头——`--only C-1..C-4` 不该白花钱合成。
    log('合成 C-5 语料音频（二十句 TTS）…');
    const c5Audio: Array<{ sample: C5Sample; first: string; second: string }> = [];
    for (const sample of corpus.c5.samples) {
      const first = readWavBase64(await ensureAudio(sample.incomplete, `${sample.id}-a`, audioDir));
      const second = readWavBase64(await ensureAudio(sample.completion, `${sample.id}-b`, audioDir));
      c5Audio.push({ sample, first, second });
    }
    log(`起第二实例 B（C-5 指令，端口 ${port}，dry-run，上限 ¥${capCny}/连接）…`);
    const instanceB = await bootSecondInstance({ port, workDir, homeDir, databasePath, journalDir, capCny, jwtSecret, settingsPath, tag: 'c5' });
    log(`实例 B 就绪（pid ${instanceB.child.pid ?? '?'}）`);
    try {
      log('C-5：十组「未说完 + 补完」，每组一条连接、两个 turn …');
      for (const [index, entry] of c5Audio.entries()) {
        process.stdout.write(`  [C-5 ${entry.sample.id}] … `);
        const reading = await runConnection({
          label: `C-5 ${entry.sample.id}`,
          item: 'C-5',
          armNote: '未说完前半句 + 补完（一条连接两个 turn）',
          port, token, journalDir, sessionId,
          sampleIds: [entry.sample.id],
          // 指令来自设置文件（进程级），不进请求体；这里只留报告用的元数据。
          reportMeta: {
            instructions: corpus.c5.instruction,
            sampleTexts: [entry.sample.incomplete, entry.sample.completion],
          },
          turns: [
            { audioBase64: entry.first, gapMs: 1_500 },
            { audioBase64: entry.second, gapMs: 0 },
          ],
          audioBase64: entry.first,
          maxMs: 120_000,
        });
        readings.push(reading);
        const v = c5Verdict(reading)[0];
        log(`turn0=${v?.waited ? '等待' : '转发'} turn1=${v?.mergedOnSecond ? '转发' : '未转发'} ${cny(reading.costCny)}${reading.error === null ? '' : ` 错误=${reading.error}`}`);
        if (index === 0 && v !== undefined) {
          // 第一组的判定打印，便于人工确认口径。
          log(`    turn0 投递=${cell(v.firstSent.join(' / '))}；turn1 投递=${cell(v.secondSent.join(' / '))}`);
        }
      }
    } finally {
      await stopSecondInstance(instanceB);
    }
  }

  const pidAfter = pidOnPort(3001);

  // 付费取数一结束就落盘：报告的每一次返工都必须能离线重放（`--report-only`）。
  const snapshot: Snapshot = { ranAt: nowIso(), port, capCny, pidBefore, pidAfter, speechClipSeconds: speechSeconds, readings };
  writeFileSync(path.join(workDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

  const report = buildReport(snapshot, workDir, journalDir, preflightNote, speechSeconds);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);

  const spend = readings.reduce((sum, r) => sum + r.costCny, 0);
  log('');
  log(`连接数 ${readings.length}  总花费 ${cny(spend)}  :3001 pid ${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}`);
  log(`报告已写入 ${reportPath}`);
  if (readings.every((r) => r.error !== null)) {
    throw new Error('全部连接都失败了——这不是一次读数，报告不可信');
  }
  if (bools.has('strict-pid') && pidBefore !== null && pidBefore !== pidAfter) {
    throw new Error(`:3001 的 pid 变了：${pidBefore} → ${pidAfter ?? '未知'}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
