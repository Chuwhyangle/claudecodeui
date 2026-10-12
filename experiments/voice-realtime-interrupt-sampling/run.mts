#!/usr/bin/env tsx
/**
 * 语义中断抽样 F7 —— 一次**真实** Realtime 运行，只报读数（SPEC §18.7 / GOAL-041 AC-346）。
 *
 * 现场。中断由 Realtime 模型**语义**判断（SPEC §0.3 C-2 / D-6），没有关键词表可依；离线 scripted
 * fake 只能证明「模型调了中断时管线对不对」，证明不了「真模型会不会在该中断时中断」。本文件跑那条
 * 真实的路：**第二实例**（备用端口，不动 :3001）、**dry-run 执行面**（`server/index.ts` 的 `dryRun`
 * 分支：`session_send` / `session_interrupt` 只被记录、不执行）、**每条连接花费上限**，把语料喂给
 * 真实上游 `qwen3.8-omni-flash-realtime`，读它到底调了哪个工具、带什么 `intent`。
 *
 * 执行面为什么必须是 dry-run。一次测量不该往任何真实会话里注入消息；更不该真的把它人的 run 停掉。
 * `dryRun:true` 走的是 HTTP 诊断路由（`POST /api/voice-realtime/diagnose`）在组装点换上的替身执行器，
 * 所以本脚本驱动的**就是**出货的代理路径（`handleVoiceRealtimeConnection` + 出货 transport），只把
 * 执行器换成记录器。DoD 要求的那句「未向任何真实会话注入消息或中断」由这一行开关承担。
 *
 * 每条语料一条连接。抽样要的是「逐条归因」：这条措辞模型到底怎么判？一条长连接里 24 句话共享一份
 * 上下文与一个 `triggerSeq` 序列，归因要穿过 VAD 提交与打断栅栏（F2/G2），而真实付费只此一次
 * （见记忆：勿反复真实上游测量），读错就没有第二次。所以每条语料各起一条独立连接，读数逐条贴回，
 * 代价是 24 条连接而不是 1 条——这**不**是 24 次实验（见报告「运行次数」一节）。
 *
 * 证据落在哪。出货的 relay journal（`voice-realtime-log.ts`）**只由浏览器 socket 的 recorder 写**
 * （`server/index.ts` 的 `voiceRealtime` handler）；HTTP dry-run 面拿到的是同一条观察流（
 * `buildVoiceRealtimeSeams` 的 `observe`），但它被送进**诊断报告**而不是 journal 文件。本脚本因此把
 * 每条连接的记录按同一「一条连接一个 JSONL」的形状落到运行目录 `<work>/journal/<连接 id>.jsonl`，
 * 并原样保存该次诊断报告 `<连接 id>.report.json`；报告里的每一行都引用这条连接 id 与这一刻的时间戳。
 *
 * 用法（在仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-interrupt-sampling/run.mts
 *   … --cap 0.05       每条连接的花费上限（CNY，写进 VOICE_REALTIME_MAX_CNY_PER_CONNECTION）
 *   … --port 3311      第二实例端口（默认 3311；:3001 只被读 pid，绝不被重启）
 *   … --only int-01    只跑语料里的一条（冒烟用）
 *   … --work /tmp/x    指定运行目录（默认 os.tmpdir() 下一个新目录）
 *   … --boot-only      只起第二实例、验路由与鉴权，**不调上游、不花钱**（取数前证管线）
 *   … --preflight-note "…"  把取数前那次管线预检的口径逐字写进报告「方法与限制」（花费不藏）
 *   … --report-only <运行目录>  从 `<运行目录>/snapshot.json` 离线重建报告（不调上游、不花钱）
 *
 * 边界（GOAL-041 全体任务共用，逐条对齐）：⛔ 不重启 :3001、不发布；⛔ 不触碰任何 Quay worker / driver
 * 进程或工作树；⛔ 第二实例带 `CLAUDE_SESSION_SCOPE_SWEEP=off`——启动清扫是**全机**的，一个临时实例
 * 不该去收割不是它开的 Claude 会话 scope；⛔ 不向任何真实会话注入（dry-run 执行面 + 一个**任何库里都
 * 不存在**的 `sessionId`，所以连「万一 dry-run 分支有洞」这条路也走不通）。
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
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'operations', 'voice-realtime-interrupt-sampling.md');

/** 第二实例的默认端口。刻意远离 3001，也避开 5173（VITE）。:3001 只被 `pidOnPort` 读。 */
const DEFAULT_PORT = 3311;
/** 默认的每条连接花费上限，CNY。SPEC §18.6 阶段 1e 要求「有花费上限」。 */
const DEFAULT_CAP_CNY = 0.05;
/** 上游静默多久算说完了一句。诊断路由默认 5000；4000 够模型答完，也少等一截。 */
const QUIET_MS = 4_000;
/** 单条连接的硬上限（诊断路由的 `maxMs`），留足上游慢答的余地。 */
const MAX_MS = 120_000;
/** HTTP 客户端的兜底超时，比 `maxMs` 宽。 */
const CLIENT_TIMEOUT_MS = 180_000;
/** 第二实例启动的等待上限。真机冷启动要装插件、挂 MCP 网关。 */
const BOOT_TIMEOUT_MS = 240_000;
/** TTS 的出货模型与音色（2026-10-12 实测可用；Edge `msedge-tts` 这条路当天 403）。 */
const TTS_MODEL = 'qwen3-tts-flash';
const TTS_VOICE = 'Cherry';
const TTS_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

type Expect = 'interrupt' | 'append';
type Actual = 'interrupt' | 'append' | 'none';

type CorpusItem = {
  id: string;
  expect: Expect;
  text: string;
  source?: string;
};

type WireEntry = { atMs: number; direction: 'sent' | 'received'; summary: string };

/** 诊断报告里我们真正读的字段。其余字段原样留在 `<连接 id>.report.json`。 */
type DiagnosisReport = {
  ok: boolean;
  heard: boolean;
  answered: boolean;
  elapsedMs: number;
  captions: string[];
  audioSecondsUpstream: number;
  usage: { responses: number; inputTokens: number; outputTokens: number };
  turns: Array<{ index: number; heard: boolean; answered: boolean; captions: string[]; sentMessages: string[]; modelText: string[]; errors: string[] }>;
  frames: Array<Record<string, unknown>>;
  wire: WireEntry[];
  problems: string[];
};

/** 一次 function_call 的读数：模型调了哪个工具、参数是什么、什么时候。 */
type CallReading = { atMs: number; name: string; args: Record<string, unknown>; raw: string; parsed: boolean };

/** 一条语料的全部读数。报告逐条表与 journal 都由它生成。 */
type ItemReading = {
  item: CorpusItem;
  connectionId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  audioSeconds: number;
  report: DiagnosisReport;
  calls: CallReading[];
  actual: Actual;
  intent: string | null;
  heard: string | null;
  message: string | null;
  modelText: string[];
  captions: string[];
  costCny: number;
  error: string | null;
};

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const nowIso = (ms: number = Date.now()): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

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

function loadCorpus(only: string | undefined): CorpusItem[] {
  const parsed = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { items?: CorpusItem[] };
  const items = parsed.items ?? [];
  if (items.length === 0) throw new Error(`语料为空：${CORPUS_PATH}（空读数不是读数）`);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`语料 id 重复：${item.id}`);
    seen.add(item.id);
    if (item.expect !== 'interrupt' && item.expect !== 'append') {
      throw new Error(`语料 ${item.id} 的 expect 只能是 interrupt / append，读到了 ${String(item.expect)}`);
    }
  }
  const interrupts = items.filter((i) => i.expect === 'interrupt').length;
  const appends = items.length - interrupts;
  if (interrupts < 10 || appends < 10) {
    throw new Error(`语料不足：interrupt=${interrupts} append=${appends}（SPEC 要求各 ≥10）`);
  }
  const ORIGINAL = '你应当能够更主动地去取消已经在执行的这些动作，以更快地推进后面的操作';
  if (!items.some((i) => i.text.includes(ORIGINAL))) {
    throw new Error('语料缺少 2026-10-12 原句（SPEC F-5）：报告要求含原句');
  }
  if (only === undefined) return items;
  const picked = items.filter((i) => i.id === only);
  if (picked.length === 0) throw new Error(`--only ${only} 不在语料里`);
  return picked;
}

// ─────────────────────────────────────────────────────────────────────────────
// 音频：DashScope TTS（qwen3-tts-flash）→ ffmpeg → 16 kHz 单声道 PCM16 WAV
// ─────────────────────────────────────────────────────────────────────────────

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
  // 24 kHz 单声道 → 16 kHz 单声道 PCM16，正是 Realtime 的 `pcm16` 输入与 `parseWavPcm16` 的准入条件。
  execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', tempPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function ensureAudio(items: CorpusItem[], audioDir: string): Promise<void> {
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
  // 采集默认关；显式写死，免得环境里有什么意外开着。
  env.VOICE_REALTIME_CAPTURE = 'off';
  // 启动清扫是**全机**的（见 server/index.ts 的注释）。一个临时实例绝不收割别人的 scope。
  env.CLAUDE_SESSION_SCOPE_SWEEP = 'off';
  // 平台模式会跳过 JWT（走 getFirstUser），那不是出货路径；点名删掉。
  delete env.VITE_IS_PLATFORM;
  // 替身上游开关：存在即「不连真实端点」。本次要的是真实上游，必须没有它。
  delete env.VOICE_REALTIME_ENDPOINT;
  // 会话池会让每条连接多开一条上游 standby（SPEC §C3）；抽样要的是每条连接一条上游。
  delete env.VOICE_REALTIME_IDLE_ROTATE_MS;

  const logPath = path.join(options.workDir, 'second-instance.log');
  const child = spawn(tsxBin, ['--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const readyLog: string[] = [];
  const tee = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    readyLog.push(text);
    if (readyLog.length > 400) readyLog.shift();
  };
  child.stdout?.on('data', tee);
  child.stderr?.on('data', tee);
  let exited = false;
  let exitNote = '';
  child.on('exit', (code, signal) => {
    exited = true;
    exitNote = `第二实例退出 code=${String(code)} signal=${String(signal)}`;
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
  throw new Error(`第二实例 ${BOOT_TIMEOUT_MS} ms 内没起来（日志：${logPath}）`);
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

/** 从 `wire[]` 里读出模型发起的每一次 function_call 及其参数（summary 的格式见 `summarizeWireObservation`）。 */
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
        // 参数解析不了：两种来源都真实存在——300 字 `clip` 截断，以及上游自己发出的畸形
        // `arguments`（实测：一次 `{"message": "` 触发 recoverable MALFORMED_FUNCTION_CALL，
        // 模型随即重发一条完整的）。原样留着，读数如实记，不猜。
        args = { __unparsed: raw };
      }
    }
    calls.push({ atMs: entry.atMs, name: match[1] ?? '', args, raw, parsed });
  }
  return calls;
}

/** 每个 `response.done` 的 token 与估算花费。用**出货的**公式，不在本文件里抄一份价目表。 */
function readResponseCosts(wire: WireEntry[]): Array<{ atMs: number; inputTokens: number; outputTokens: number; audioTokens: number; costCny: number }> {
  const rows: Array<{ atMs: number; inputTokens: number; outputTokens: number; audioTokens: number; costCny: number }> = [];
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
      costCny: estimateRealtimeCostCny({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        input_tokens_details: { audio_tokens: audioTokens },
      }),
    });
  }
  return rows;
}

type Verdict = {
  actual: Actual;
  intent: string | null;
  heard: string | null;
  message: string | null;
};

function classify(calls: CallReading[]): Verdict {
  const pick = (name: string): CallReading | undefined => {
    const list = calls.filter((c) => c.name === name);
    if (list.length === 0) return undefined;
    // 同名可能被调用多次（实测：一条畸形 `arguments` 之后模型重发一条完整的）。取**最后一个参数
    // 解析得出**的那次——读数要的是模型最终说了什么，不是一个被截断的中途帧。若全都没解析出来，
    // 取最后一次，并把「参数不可读」如实带出去。
    const readable = list.filter((c) => c.parsed);
    return readable.length > 0 ? readable[readable.length - 1] : list[list.length - 1];
  };
  const interrupt = pick('session_interrupt');
  const send = pick('session_send');
  const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
  const hasInterrupt = calls.some((c) => c.name === 'session_interrupt');
  const hasSend = calls.some((c) => c.name === 'session_send');
  return {
    actual: hasInterrupt ? 'interrupt' : hasSend ? 'append' : 'none',
    intent: interrupt === undefined ? null : str(interrupt.args.intent),
    heard: interrupt === undefined ? null : str(interrupt.args.heard),
    message: send === undefined ? null : str(send.args.message),
  };
}

/** 一条连接的全部读数：报告 + 调用 + 花费 + journal。 */
async function runItem(options: {
  item: CorpusItem;
  port: number;
  token: string;
  journalDir: string;
  audioDir: string;
  sessionId: string;
}): Promise<ItemReading> {
  const { item } = options;
  const audioPath = path.join(options.audioDir, `${item.id}.wav`);
  const audioBase64 = readFileSync(audioPath).toString('base64');
  const connectionId = randomUUID();
  const startedAtMs = Date.now();
  const startedAt = nowIso(startedAtMs);

  let report: DiagnosisReport | null = null;
  let error: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${options.port}/api/voice-realtime/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({
        sessionId: options.sessionId,
        audioBase64,
        format: 'wav',
        // 执行面：dry-run。`session_send` / `session_interrupt` 只被记录。
        dryRun: true,
        speed: 1,
        quietMs: QUIET_MS,
        maxMs: MAX_MS,
      }),
      signal: controller.signal,
    });
    const body = (await response.json()) as DiagnosisReport & { error?: string };
    if (!response.ok) error = `HTTP ${response.status}: ${body.error ?? JSON.stringify(body).slice(0, 200)}`;
    else report = body;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    clearTimeout(timer);
  }

  const finishedAt = nowIso();
  const empty: DiagnosisReport = {
    ok: false,
    heard: false,
    answered: false,
    elapsedMs: 0,
    captions: [],
    audioSecondsUpstream: 0,
    usage: { responses: 0, inputTokens: 0, outputTokens: 0 },
    turns: [],
    frames: [],
    wire: [],
    problems: error === null ? [] : [error],
  };
  const effective = report ?? empty;
  const calls = readCalls(effective.wire);
  const verdict = classify(calls);
  const costs = readResponseCosts(effective.wire);
  const costCny = costs.reduce((sum, row) => sum + row.costCny, 0);
  const modelText = effective.turns.flatMap((turn) => turn.modelText ?? []);

  const reading: ItemReading = {
    item,
    connectionId,
    sessionId: options.sessionId,
    startedAt,
    finishedAt,
    audioSeconds: effective.audioSecondsUpstream,
    report: effective,
    calls,
    actual: verdict.actual,
    intent: verdict.intent,
    heard: verdict.heard,
    message: verdict.message,
    modelText,
    captions: effective.captions,
    costCny,
    error,
  };

  // ── 这条连接的 journal：一条连接一个 JSONL，按出货 journal 的形状命名与放置（见文件头）。
  const at = (ms: number): string => nowIso(startedAtMs + ms);
  const entries: Array<Record<string, unknown>> = [
    {
      journal: 'voice-realtime-interrupt-sampling',
      kind: 'run.connection',
      at: startedAt,
      connectionId,
      itemId: item.id,
      sessionId: options.sessionId,
      expect: item.expect,
      text: item.text,
      source: item.source ?? null,
      dryRun: true,
    },
  ];
  for (const call of calls) {
    entries.push({
      journal: 'voice-realtime-interrupt-sampling',
      kind: 'run.call',
      at: at(call.atMs),
      atMs: call.atMs,
      connectionId,
      name: call.name,
      arguments: call.args,
      raw: call.raw,
      // `false` = 上游 `arguments` 没解析出来（截断或畸形），`arguments` 里是 `{__unparsed: …}`。
      parsed: call.parsed,
    });
  }
  costs.forEach((row, index) => {
    entries.push({
      journal: 'voice-realtime-interrupt-sampling',
      kind: 'run.response',
      at: at(row.atMs),
      connectionId,
      index,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      audioTokens: row.audioTokens,
      costCny: row.costCny,
    });
  });
  entries.push({
    journal: 'voice-realtime-interrupt-sampling',
    kind: 'run.usage',
    at: finishedAt,
    connectionId,
    responses: effective.usage.responses,
    costCny,
    reportUsage: effective.usage,
    reportProblems: effective.problems,
  });
  entries.push({
    journal: 'voice-realtime-interrupt-sampling',
    kind: 'run.verdict',
    at: finishedAt,
    connectionId,
    expect: item.expect,
    actual: reading.actual,
    intent: reading.intent,
    heard: reading.heard,
    message: reading.message,
    captions: reading.captions,
  });
  writeFileSync(
    path.join(options.journalDir, `${connectionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(options.journalDir, `${connectionId}.report.json`), `${JSON.stringify(effective, null, 2)}\n`, { mode: 0o600 });

  return reading;
}

// ─────────────────────────────────────────────────────────────────────────────
// 指标与报告
// ─────────────────────────────────────────────────────────────────────────────

type Metrics = {
  total: number;
  interruptExpected: number;
  appendExpected: number;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  truth: { interrupt: number; append: number; none: number };
  actual: { interrupt: number; append: number; none: number };
  recall: number | null;
  precision: number | null;
  spendCny: number;
  capCny: number;
  capped: number;
};

function computeMetrics(readings: ItemReading[], capCny: number): Metrics {
  const interruptExpected = readings.filter((r) => r.item.expect === 'interrupt');
  const appendExpected = readings.filter((r) => r.item.expect === 'append');
  const tp = interruptExpected.filter((r) => r.actual === 'interrupt').length;
  const fn = interruptExpected.length - tp;
  const fp = appendExpected.filter((r) => r.actual === 'interrupt').length;
  const tn = appendExpected.length - fp;
  const tally = (list: ItemReading[]): { interrupt: number; append: number; none: number } => ({
    interrupt: list.filter((r) => r.actual === 'interrupt').length,
    append: list.filter((r) => r.actual === 'append').length,
    none: list.filter((r) => r.actual === 'none').length,
  });
  return {
    total: readings.length,
    interruptExpected: interruptExpected.length,
    appendExpected: appendExpected.length,
    tp,
    fn,
    fp,
    tn,
    truth: tally(readings),
    actual: {
      interrupt: readings.filter((r) => r.actual === 'interrupt').length,
      append: readings.filter((r) => r.actual === 'append').length,
      none: readings.filter((r) => r.actual === 'none').length,
    },
    recall: interruptExpected.length === 0 ? null : tp / interruptExpected.length,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    spendCny: readings.reduce((sum, r) => sum + r.costCny, 0),
    capCny,
    capped: readings.filter((r) => r.report.problems.some((p) => /spend|budget|cap/i.test(p))).length,
  };
}

const pct = (value: number | null): string => (value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`);
/** 表格单元格里的竖线会破表；换行拉平。 */
const cell = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const cny = (value: number): string => `¥${value.toFixed(4)}`;

function activeCell(reading: ItemReading): string {
  if (reading.error !== null) return `（本连接失败：${cell(reading.error)}）`;
  if (reading.actual === 'interrupt') return '`session_interrupt`';
  if (reading.actual === 'append') return '`session_send`';
  return reading.modelText.length > 0 ? '（未调工具，模型用文本回答）' : '（未调工具）';
}

function intentCell(reading: ItemReading): string {
  if (reading.actual === 'interrupt') {
    const parts = [reading.intent === null ? '`intent` 缺失' : `intent=「${cell(reading.intent)}」`];
    if (reading.heard !== null) parts.push(`heard=「${cell(reading.heard)}」`);
    return parts.join('；');
  }
  if (reading.actual === 'append') return reading.message === null ? '（`message` 缺失）' : `message=「${cell(reading.message)}」`;
  return '—';
}

function buildReport(options: {
  readings: ItemReading[];
  metrics: Metrics;
  workDir: string;
  journalDir: string;
  pidBefore: number | null;
  pidAfter: number | null;
  port: number;
  runAt: string;
  /**
   * 取数之前做过的一次性管线预检（若有），逐字进报告。
   *
   * 为什么要有这个口子：这一项的整个价值建立在「只花一次钱」上，所以在正式取数前先用一条语料把
   * 「起实例 → 鉴权 → 上游 → 读报告」整条链走通是必要的（见 `experiments/voice-realtime-ambiguity/run-real.mjs`
   * 的 `--probe` 先例）。但那次预检**也**碰到了真实上游、**也**产生了花费。花费不藏：由调用方
   * 把口径写清楚，本脚本逐字落进「方法与限制」，不替它归纳。
   */
  preflightNote?: string;
}): string {
  const { metrics, readings, workDir, journalDir } = options;
  const lines: string[] = [];
  const original = readings.find((r) => r.item.id === 'int-01');

  lines.push('# Live Voice 语义中断抽样（F7 / 阶段 1e）—— 一次真实 Realtime 运行');
  lines.push('');
  lines.push(`本文件是 GOAL-041 / AC-346 的抽样记录：把 ${metrics.total} 条中文语料喂给**真实**的 Qwen Realtime 上游`);
  lines.push('（`qwen3.8-omni-flash-realtime`，出货默认模型与 voice），读模型**自己**把每一句判成「中断」');
  lines.push('（`session_interrupt`）还是「仅追加」（`session_send`）。**这不是模型推演，是一次运行的读数。**');
  lines.push('');
  lines.push(`运行时刻 ${options.runAt}；第二实例端口 ${options.port}；:3001 只被读 pid，从未被重启。`);
  lines.push('');
  lines.push('## 怎么跑的');
  lines.push('');
  lines.push(
    `- **语料**：\`experiments/voice-realtime-interrupt-sampling/corpus.json\`，语义取消/改向 ${metrics.interruptExpected} 条 + 仅追加 ${metrics.appendExpected} 条；`,
  );
  lines.push('  首条 `int-01` 是 2026-10-12 F-5 的原句，逐字保留。音频由 DashScope `qwen3-tts-flash` 合成后经 ffmpeg');
  lines.push('  转成 16 kHz 单声道 PCM16 WAV（Realtime 的 `pcm16` 输入）。');
  lines.push('- **执行面**：`POST /api/voice-realtime/diagnose`，`dryRun:true` —— 走 `server/index.ts` 的 `dryRun` 分支，');
  lines.push('  `session_send` / `session_interrupt` **只被记录，不执行**。没有任何消息或中断进入任何真实会话。');
  lines.push('- **连接**：每条语料各建立一条独立的上游连接，`sessionId` 是一个**任何库里都不存在**的合成 id，');
  lines.push('  所以哪怕 dry-run 分支有洞，也没有一条路能落到真实会话上。');
  lines.push(`- **花费上限**：第二实例带 \`VOICE_REALTIME_MAX_CNY_PER_CONNECTION=${metrics.capCny}\`，每条连接独立封顶。`);
  lines.push('- **边界**：不重启 :3001、不发布、不触碰任何 Quay worker / driver；第二实例带');
  lines.push('  `CLAUDE_SESSION_SCOPE_SWEEP=off`（启动清扫是全机的，临时实例不收割别人的 scope）。');
  lines.push('');
  lines.push('## 读数');
  lines.push('');
  lines.push(
    `样本：${metrics.total} 条（语义取消/改向 ${metrics.interruptExpected} 条 + 仅追加 ${metrics.appendExpected} 条）；` +
      `读到最终转写 ${readings.filter((r) => r.captions.length > 0).length} 条。`,
  );
  lines.push(
    `召回率：${pct(metrics.recall)}（TP=${metrics.tp}，FN=${metrics.fn}；分母 ${metrics.interruptExpected} 条应中断）` +
      (metrics.recall === null ? '——语料里没有应中断的条目' : ''),
  );
  lines.push(
    `精确率：${pct(metrics.precision)}（TP=${metrics.tp}，FP=${metrics.fp}；分母 ${metrics.tp + metrics.fp} 次中断调用）` +
      (metrics.precision === null ? '——本运行没有出现过任何 `session_interrupt` 调用' : ''),
  );
  lines.push(
    `花费：${cny(metrics.spendCny)}（上限 ${cny(metrics.capCny)} / 连接 × ${metrics.total} 条连接；` +
      `触顶 / 被花费守卫拦下的连接 ${metrics.capped} 条）`,
  );
  lines.push('运行次数：1');
  const pidKnown = options.pidBefore !== null && options.pidAfter !== null;
  lines.push(
    `:3001 pid：运行前 ${options.pidBefore ?? '未知'} → 运行后 ${options.pidAfter ?? '未知'}` +
      (!pidKnown
        ? '（至少一侧读不到 pid——AC3 要的是「相同」，这一条需要人工复核）'
        : options.pidBefore === options.pidAfter
          ? '（相同，未重启）'
          : '（**不同**——需要人工复核）'),
  );
  lines.push('');
  lines.push(
    '**「运行次数：1」指的是这一次抽样实验整体只执行了一回**（SPEC §18.7「单次付费运行」，见记忆：勿反复真实上游测量），',
  );
  lines.push(
    `没有重复取数、没有二轮。换来的是逐条可归因：${metrics.total} 条语料各自建立**一条独立的上游 Realtime 连接**（见下表「连接 id」列，共 ${metrics.total} 条），`,
  );
  lines.push(`一条连接的读数只由这一句措辞产生。这不是 ${metrics.total} 次实验。`);
  lines.push('');
  lines.push('**本表不设门槛。** 召回率 / 精确率只报读数——SPEC §18.7 F7 明确此项为抽样，不为它立通过线。');
  lines.push('');
  lines.push('### 混淆矩阵');
  lines.push('');
  lines.push('| 期望 \\ 实际 | `session_interrupt` | `session_send` | 未调工具 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| 应中断（${metrics.interruptExpected}） | ${metrics.tp} | ${metrics.interruptExpected - metrics.tp - readings.filter((r) => r.item.expect === 'interrupt' && r.actual === 'none').length} | ${readings.filter((r) => r.item.expect === 'interrupt' && r.actual === 'none').length} |`);
  lines.push(`| 仅追加（${metrics.appendExpected}） | ${metrics.fp} | ${readings.filter((r) => r.item.expect === 'append' && r.actual === 'append').length} | ${readings.filter((r) => r.item.expect === 'append' && r.actual === 'none').length} |`);
  lines.push('');
  lines.push('## 逐条读数');
  lines.push('');
  lines.push(
    '「连接 id」是本次为该条语料建立的那条诊断连线的 id（与浏览器连线的 journal 文件名同一形态）；',
  );
  lines.push(
    '「时间戳」是模型发出该次 `function_call` 的墙钟时刻（UTC）= 该连接开始时刻 + 报告 `wire[].atMs`。',
  );
  lines.push(
    `每条连接自己的读数落在运行目录的 \`${journalDir.replace(workDir, '<运行目录>')}/<连接 id>.jsonl\`，原始诊断报告在 \`<连接 id>.report.json\`。`,
  );
  lines.push('');
  lines.push('| # | 措辞 | 期望 | 实际调用 | intent / message | 连接 id | 时间戳（UTC） |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  readings.forEach((reading, index) => {
    // 时间戳定位到**判成这次读数**的那次调用：判成中断就找 `session_interrupt`，判成仅追加就找
    // `session_send`。一条连接里模型先追加后中断（或反过来）时，随手取「第一个工具调用」会把时间戳
    // 指到另一个工具上。都没调工具时退回连接结束时刻。
    const wanted =
      reading.actual === 'interrupt' ? 'session_interrupt' : reading.actual === 'append' ? 'session_send' : null;
    const call = wanted === null ? undefined : reading.calls.find((c) => c.name === wanted);
    const stamp = call === undefined ? reading.finishedAt : nowIso(Date.parse(reading.startedAt) + call.atMs);
    const text = reading.item.source === undefined ? reading.item.text : `${reading.item.text}（${reading.item.source}）`;
    lines.push(
      `| ${index + 1} | ${cell(text)} | ${reading.item.expect === 'interrupt' ? '中断' : '仅追加'} | ${activeCell(reading)} | ${intentCell(reading)} | \`${reading.connectionId}\` | ${stamp} |`,
    );
  });
  lines.push('');
  if (original !== undefined) {
    lines.push('### 原句读数（`int-01`，SPEC F-5 2026-10-12 原句）');
    lines.push('');
    lines.push(`> ${original.item.text}`);
    lines.push('');
    lines.push(
      `模型判：**${activeCell(original)}**；${intentCell(original)}。连接 \`${original.connectionId}\`，` +
        `起始 ${original.startedAt}，最终转写 ${original.captions.length === 0 ? '（无）' : `「${cell(original.captions.join(' / '))}」`}。`,
    );
    lines.push('');
  }
  // 漏判（FN）单独拎出来：这是唯一能被「召回率」一个数字盖住的东西，而它恰恰是这项抽样最想让人看见的
  // 一处。只记可观测事实——最终转写、模型实际调的工具与参数；上游不回 rational，模型「为什么」这么判
  // 本运行读不到，不替它编。
  const missed = readings.filter((r) => r.item.expect === 'interrupt' && r.actual !== 'interrupt');
  if (missed.length > 0) {
    lines.push(`### 漏判（应中断但没中断，${missed.length} 条）`);
    lines.push('');
    lines.push(
      '下面每条的全文都在上表里；这里只补两样可观测的东西：**上游最终转写出的话**，以及**模型实际发出的调用参数原文**。',
    );
    lines.push('模型「为什么这样判」本运行读不到（上游不返回理由字段），不推测。');
    lines.push('');
    for (const reading of missed) {
      lines.push(`- **${reading.item.id}** —— 「${cell(reading.item.text)}」`);
      lines.push(
        `  - 实际调用：**${activeCell(reading)}**；${intentCell(reading)}。连接 \`${reading.connectionId}\`，` +
          `调用时刻 ${reading.calls.length === 0 ? '（无调用）' : nowIso(Date.parse(reading.startedAt) + reading.calls[reading.calls.length - 1]!.atMs)}。`,
      );
      lines.push(
        `  - 最终转写：${reading.captions.length === 0 ? '（无）' : `「${cell(reading.captions.join(' / '))}」`}` +
          `；` +
          `模型发的原始参数：\`${cell(reading.calls.find((c) => c.name === (reading.actual === 'append' ? 'session_send' : 'session_interrupt'))?.raw ?? '（无）')}\``,
      );
    }
    lines.push('');
  }
  lines.push('## 方法与限制（如实记录）');
  lines.push('');
  lines.push(
    '1. **证据落在哪**。出货的 relay journal（`voice-realtime-log.ts`）目前**只由浏览器 socket 的 recorder 写**',
  );
  lines.push(
    '   （`server/index.ts` 的 `voiceRealtime` handler）；HTTP dry-run 面拿到的是**同一条观察流**，但它被送进诊断报告',
  );
  lines.push(
    '   而不是 journal 文件。所以本次每条连接的记录由本脚本按同一「一条连接一个 JSONL」的形状落到运行目录，',
  );
  lines.push(
    '   字段取自诊断报告（模型的原始 `function_call` 参数、转写、每个 `response.done` 的 token 与估算花费），',
  );
  lines.push('   原始报告原样另存。表里每一行引用的连接 id 与时间戳都能在这两个文件里对上。');
  lines.push(
    '2. **「运行次数」的口径**见上：一次实验，逐条连接。若读者要的是「一条长连接上的连续对话」，那是一份不同的读数',
  );
  lines.push('   （归因要穿过 VAD 提交与打断栅栏 F2/G2），本轮没有取。');
  lines.push(
    '3. **花费是估算**。`estimateRealtimeCostCny` 是出货的估算公式（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY / 1k token），',
  );
  lines.push('   账单以官方为准；这里报的是与出货花费守卫**同一个**读数，不是发票。');
  lines.push(
    '4. **模型可能不调工具**。「未调工具」是一个真实读数（上游并不保证每轮都调工具，见 transport 头部 KNOWN LIMITATION），',
  );
  lines.push('   本脚本不重试、不挑输入，如实记下模型当时的选择。');
  if (options.preflightNote !== undefined && options.preflightNote.trim() !== '') {
    lines.push(`5. **取数前的管线预检**。${options.preflightNote.trim()}`);
  }
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-interrupt-sampling/run.mts');
  lines.push('```');
  lines.push('');
  lines.push(`本次运行目录：\`${workDir}\`（journal 在 \`${journalDir}\`，第二实例日志在 \`second-instance.log\`）。`);
  lines.push('运行目录是临时的：它不随提交保留，表本身就是读数。');
  lines.push('');
  return `${lines.join('\n')}`;
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
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `voice-realtime-interrupt-sampling-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const audioDir = path.join(workDir, 'audio');
  const homeDir = path.join(workDir, 'home');
  const databasePath = path.join(workDir, 'auth.db');
  const jwtSecret = `sampling-${randomUUID()}`;

  if (!Number.isFinite(port) || port <= 0) throw new Error(`--port 不合法：${String(port)}`);
  if (!Number.isFinite(capCny) || capCny <= 0) throw new Error(`--cap 不合法：${String(capCny)}`);
  if (port === 3001) throw new Error('--port 不能是 3001：本任务禁止重启 / 占用 :3001');

  // `--report-only <运行目录>`：从一次**已经跑过**的取数里重建报告，不起实例、不调上游、不花钱。
  // 这不是可有可无的便利：真实付费只此一次（见记忆），取数已经落进 `snapshot.json` 之后，报告侧的
  // 任何返工都不该再碰上游一次。也是 buildReport 崩溃后的唯一补救路。
  const reportOnly = values.get('report-only');
  if (reportOnly !== undefined) {
    const snapshotPath = path.join(reportOnly, 'snapshot.json');
    if (!existsSync(snapshotPath)) throw new Error(`--report-only 找不到 ${snapshotPath}`);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      capCny: number;
      port: number;
      pidBefore: number | null;
      pidAfter: number | null;
      readings: ItemReading[];
    };
    const metrics = computeMetrics(snapshot.readings, snapshot.capCny);
    const rebuilt = buildReport({
      readings: snapshot.readings,
      metrics,
      workDir: reportOnly,
      journalDir: path.join(reportOnly, 'journal'),
      pidBefore: snapshot.pidBefore,
      pidAfter: snapshot.pidAfter,
      port: snapshot.port,
      runAt: nowIso(),
      ...(values.get('preflight-note') === undefined ? {} : { preflightNote: values.get('preflight-note')! }),
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, rebuilt);
    log(`（--report-only）从 ${reportOnly} 重建报告；未调用上游，未产生花费。`);
    log(`报告已写入 ${reportPath}`);
    return;
  }

  for (const dir of [workDir, journalDir, audioDir, homeDir]) mkdirSync(dir, { recursive: true });

  const items = loadCorpus(only);
  log(`语料 ${items.length} 条（interrupt ${items.filter((i) => i.expect === 'interrupt').length} / append ${items.filter((i) => i.expect === 'append').length}）`);
  log(`运行目录 ${workDir}`);

  // 数据库：拷贝一份，第二实例与本次运行都不碰真的那个。
  const sourceDb = path.join(os.homedir(), '.cloudcli', 'auth.db');
  if (!existsSync(sourceDb)) throw new Error(`找不到 ${sourceDb}（第二实例需要一个有用户的库）`);
  writeFileSync(databasePath, readFileSync(sourceDb));
  let userId = 1;
  let username = 'sampling';
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

  log('合成语料音频 …');
  await ensureAudio(items, audioDir);

  log(`起第二实例（端口 ${port}，dry-run 执行面，上限 ¥${capCny}/连接）…`);
  const instance = await bootSecondInstance({ port, workDir, homeDir, databasePath, journalDir, capCny, jwtSecret });
  log(`第二实例就绪（pid ${instance.child.pid ?? '?'}）`);

  // `--boot-only`：只验证第二实例能起来、路由挂着、鉴权通得过，**不调上游、不花钱**。
  // 与 `experiments/voice-realtime-ambiguity/run-real.mjs` 的 `--probe` 同一个用法：取数之前先证管线。
  if (bools.has('boot-only')) {
    await stopSecondInstance(instance);
    log('--boot-only：第二实例起来了，路由与鉴权都通；未调用真实上游，未产生花费。');
    return;
  }

  // 一个任何库里都不存在的 sessionId：dry-run 之外还有一层「落不到真实会话」的保险。
  const sessionId = `sampling-${randomUUID()}`;

  const readings: ItemReading[] = [];
  try {
    for (const [index, item] of items.entries()) {
      process.stdout.write(`  [${index + 1}/${items.length}] ${item.id} 期望=${item.expect} … `);
      const reading = await runItem({ item, port, token, journalDir, audioDir, sessionId });
      readings.push(reading);
      log(`${activeCell(reading)} ${cny(reading.costCny)}${reading.error === null ? '' : ` 错误=${reading.error}`}`);
    }
  } finally {
    await stopSecondInstance(instance);
  }

  const pidAfter = pidOnPort(3001);

  // 付费取数一结束就落盘：报告的每一次返工都必须能离线重放（`--report-only`），
  // 而不是把「再跑一次真实上游」当成修复手段。
  writeFileSync(
    path.join(workDir, 'snapshot.json'),
    JSON.stringify({ capCny, port, pidBefore, pidAfter, readings }, null, 2),
  );

  const metrics = computeMetrics(readings, capCny);
  const report = buildReport({
    readings,
    metrics,
    workDir,
    journalDir,
    pidBefore,
    pidAfter,
    port,
    runAt: nowIso(),
    ...(values.get('preflight-note') === undefined ? {} : { preflightNote: values.get('preflight-note')! }),
  });
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);

  log('');
  log(`样本：${metrics.total}  召回率：${pct(metrics.recall)}  精确率：${pct(metrics.precision)}  花费：${cny(metrics.spendCny)}`);
  log(`:3001 pid：${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}`);
  log(`报告已写入 ${reportPath}`);

  // 单条连接的失败不再吞：一条连接读空（error）也算读数，如实进报告；但整个实验一条都没读到
  // 才是真的失败。（报告已经写盘，要重出报告走 `--report-only <运行目录>`，不重跑上游。）
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
