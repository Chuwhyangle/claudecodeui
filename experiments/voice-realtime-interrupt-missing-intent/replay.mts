#!/usr/bin/env tsx
/**
 * 缺 `intent` 的停止被整次拒收 —— 一次**真实**上游回放，只报读数
 * （`gap-live-voice-interrupt-missing-intent-drops-stop`，AC6）。
 *
 * 现场。2026-10-13 23:58:06 的真实 live voice（journal `b5d01c21-3f53-4228-a28e-d18b7cb967f7`）
 * 里，Realtime 模型**语义判断正确**、调用了 `session_interrupt`，只是没带 `intent`：
 *
 *   << function_call session_interrupt {"message": "停止前面的操作，处理我现在说的这句话。"}
 *   to-browser error TOOL_ARGUMENT_SCHEMA_VIOLATION (recoverable) …
 *       (intent: Invalid input: expected string, received undefined)
 *
 * 出站校验（`voice-realtime-dashscope-transport.ts` 的 `validateDeclaredCall`）按当时 `intent` 必填的
 * `inputSchema` 把这一次调用整个拦下——在跑的回合**没有被中止**，`message`（修正文本）**也没有改走
 * `session_send`**。人最想表达的那句「停止」从会话侧完全看不见。
 *
 * 本文件把**那一段真实麦克风音频**（capture `b5d01c21….wav` 里 offsetMs 覆盖 15:58:02.695–15:58:06.577
 * 的窗口，正是 timeline 里 speech_started → committed）重新喂给**真实**上游 `qwen3.8-omni-flash-realtime`，
 * 读三件事：模型这次**有没有**再调 `session_interrupt`、参数里**有没有** `intent`、出货的**校验+执行面**
 * **接不接受**它（有没有再出现 `TOOL_ARGUMENT_SCHEMA_VIOLATION`）。修复合入后，缺 `intent` 的停止应当不再
 * 被拦，`{"message": …}` 这种**只有 message** 的形态应当被执行面接受。
 *
 * 这是**读数**，不是门槛。模型是有变量（上游不保证每轮都调工具），所以本脚本对它读到的东西如实记录；
 * 一次回放没复现出那次调用，不等于修复无效——它只说明这一次没读到（任务 AC6 的原话：「读数不足时写
 * 「不足以判断」」）。
 *
 * 执行面是 **dry-run**（同 `experiments/voice-realtime-interrupt-sampling/run.mts` 的头注：HTTP 诊断路由
 * 在组装点把 `session_send`/`session_interrupt` 换成只记录的替身）。驱动的是**出货的代理路径**
 * （`handleVoiceRealtimeConnection` + 出货 transport），只把执行器换成记录器，所以本脚本绝不会向任何真实
 * 会话注入消息、也不会真的把别人的 run 停掉。
 *
 * 用法（在仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-interrupt-missing-intent/replay.mts
 *   … --port 3911              第二实例端口（默认 3911；:3001 只被读 pid，绝不被重启）
 *   … --cap 0.1                每条连接的花费上限（CNY，写进 VOICE_REALTIME_MAX_CNY_PER_CONNECTION）
 *   … --from 102800            截取窗口起点（capture 内 offsetMs；默认含首句起始前的余量）
 *   … --to 106900              截取窗口终点（capture 内 offsetMs；默认含末句 committed 后的余量）
 *   … --speed 1                回放倍速（1 = 实时，像麦克风）
 *   … --work /tmp/x            运行目录（默认 os.tmpdir() 下一个新目录）
 *   … --boot-only              只起第二实例、验路由与鉴权，**不调上游、不花钱**
 *
 * 边界（与 GOAL-041 / sampling 一致，逐条对齐）：⛔ 不重启 :3001、不发布；⛔ 不触碰任何 Quay worker /
 * driver 进程或工作树；⛔ 第二实例带 `CLAUDE_SESSION_SCOPE_SWEEP=off`（启动清扫是全机的，临时实例不收割
 * 别人的 scope）；⛔ 不向任何真实会话注入（dry-run 执行面 + 一个**任何库里都不存在**的 `sessionId`）。
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** 那次现场 capture 的 id 与前缀。任务正文把 sha256 前缀钉成 `0f2bd51fbbb28c9f`。 */
const CAPTURE_ID = 'b5d01c21-3f53-4228-a28e-d18b7cb967f7';
const CAPTURE_SHA256_PREFIX = '0f2bd51fbbb28c9f';
const DEFAULT_CAPTURE = path.join(os.homedir(), '.cloudcli', 'voice-realtime-capture', `${CAPTURE_ID}.wav`);

/** 第二实例默认端口。避开 3001（出货）与 5173（VITE），也避开 sampling 的 3311。 */
const DEFAULT_PORT = 3911;
/** 每条连接的花费上限，CNY。任务 Plan 步骤 6 要求「花费上限 ¥0.1」。 */
const DEFAULT_CAP_CNY = 0.1;
/** 截取窗口默认覆盖 15:58:02.695（首句 speech_started）→ 15:58:06.577（末句 transcription.completed）。 */
const DEFAULT_FROM_MS = 102_800;
const DEFAULT_TO_MS = 106_900;
/** 上游静默多久算说完了一句（诊断路由默认 5000；4000 够模型答完）。 */
const QUIET_MS = 4_000;
/** 单条连接的硬上限（诊断路由的 `maxMs`）。窗口很短，60 s 绰绰有余。 */
const MAX_MS = 60_000;
const CLIENT_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 240_000;

type WireEntry = { atMs: number; direction: 'sent' | 'received'; summary: string };
type OutboundFrame = { type?: unknown; [key: string]: unknown };

/** 诊断报告里我们真正读的字段。其余字段原样留在 `<run>/report.json`。 */
type DiagnosisReport = {
  ok: boolean;
  heard: boolean;
  answered: boolean;
  elapsedMs: number;
  captions: string[];
  audioSecondsUpstream: number;
  usage: { responses: number; inputTokens: number; outputTokens: number };
  turns: Array<{ index: number; heard: boolean; answered: boolean; captions: string[]; sentMessages: string[]; modelText: string[]; errors: string[] }>;
  frames: OutboundFrame[];
  wire: WireEntry[];
  problems: string[];
};

type CallReading = { atMs: number; name: string; args: Record<string, unknown>; raw: string; parsed: boolean };

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

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

/**
 * 从 capture WAV 截取 [fromMs, toMs) 的音频，返回**裸** 16 kHz 单声道 PCM16。
 *
 * 走 ffmpeg 解码到 `s16le` 而不是 `-c copy`：切片落在采样中间时 `-c copy` 会把整段 PCM 的字节偏移当
 * 容器头写出去，裸流则只含纯粹样本。诊断路由支持 `format:"pcm16"`，正好接这一段。
 */
function slicePcm16(capturePath: string, fromMs: number, toMs: number, outPath: string): Buffer {
  execFileSync(
    '/usr/bin/ffmpeg',
    ['-y', '-loglevel', 'error', '-ss', String(fromMs / 1000), '-to', String(toMs / 1000), '-i', capturePath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', outPath],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return readFileSync(outPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二实例（同 sampling run.mts：快照库 + 铸 JWT，走**出货**的 JWT 路径）
// ─────────────────────────────────────────────────────────────────────────────

type SecondInstance = { child: ChildProcess; port: number; logPath: string; readyLog: string[] };

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
  // 采集默认关；本回放不写任何 capture。
  env.VOICE_REALTIME_CAPTURE = 'off';
  // 启动清扫是全机的（见 server/index.ts 的注释）。一个临时实例绝不收割别人的 scope。
  env.CLAUDE_SESSION_SCOPE_SWEEP = 'off';
  // 平台模式会跳过 JWT（走 getFirstUser），那不是出货路径；点名删掉。
  delete env.VITE_IS_PLATFORM;
  // 替身上游开关：存在即「不连真实端点」。本次要的是真实上游，必须没有它。
  delete env.VOICE_REALTIME_ENDPOINT;
  // 会话池会让每条连接多开一条上游 standby（SPEC §C3）；本次要的是每条连接一条上游。
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
// 读报告
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
        args = { __unparsed: raw };
      }
    }
    calls.push({ atMs: entry.atMs, name: match[1] ?? '', args, raw, parsed });
  }
  return calls;
}

/** 每个 `response.done` 的 token 与估算花费。用**出货的**公式，不在本文件里抄一份价目表。 */
function readResponseCosts(wire: WireEntry[]): Array<{ costCny: number }> {
  const rows: Array<{ costCny: number }> = [];
  for (const entry of wire) {
    const match = /^response\.done\s+status=(\S+)\s+in=(\d+)\s+out=(\d+)(?:\s+audio=(\d+))?/.exec(entry.summary);
    if (match === null) continue;
    rows.push({
      costCny: estimateRealtimeCostCny({
        input_tokens: Number(match[2]),
        output_tokens: Number(match[3]),
        input_tokens_details: { audio_tokens: match[4] === undefined ? 0 : Number(match[4]) },
      }),
    });
  }
  return rows;
}

/** 出站（去浏览器）的错误帧，`TOOL_ARGUMENT_SCHEMA_VIOLATION` 应当是 0 条。 */
function errorFrames(report: DiagnosisReport): OutboundFrame[] {
  return report.frames.filter((frame) => frame.type === 'error');
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, bools } = readFlags(process.argv.slice(2));
  const port = Number(values.get('port') ?? DEFAULT_PORT);
  const capCny = Number(values.get('cap') ?? DEFAULT_CAP_CNY);
  const capturePath = values.get('capture') ?? DEFAULT_CAPTURE;
  const fromMs = Number(values.get('from') ?? DEFAULT_FROM_MS);
  const toMs = Number(values.get('to') ?? DEFAULT_TO_MS);
  const speed = Number(values.get('speed') ?? 1);
  const workDir = values.get('work') ?? path.join(os.tmpdir(), `vmni-replay-${Date.now()}`);
  const journalDir = path.join(workDir, 'journal');
  const homeDir = path.join(workDir, 'home');
  const databasePath = path.join(workDir, 'auth.db');
  const jwtSecret = `vmni-${randomUUID()}`;

  if (!Number.isFinite(port) || port <= 0) throw new Error(`--port 不合法：${String(port)}`);
  if (!Number.isFinite(capCny) || capCny <= 0) throw new Error(`--cap 不合法：${String(capCny)}`);
  if (port === 3001) throw new Error('--port 不能是 3001：本任务禁止重启 / 占用 :3001');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error(`窗口不合法：from=${String(fromMs)} to=${String(toMs)}`);
  }
  if (!existsSync(capturePath)) throw new Error(`找不到 capture：${capturePath}`);

  for (const dir of [workDir, journalDir, homeDir]) mkdirSync(dir, { recursive: true });

  // ── 先证 capture 就是任务正文钉住的那一份（sha256 前缀），再读窗口。
  const captured = readFileSync(capturePath);
  const sha256 = createHash('sha256').update(captured).digest('hex');
  const sha256Prefix = sha256.slice(0, CAPTURE_SHA256_PREFIX.length);
  const hashOk = sha256Prefix === CAPTURE_SHA256_PREFIX;
  log(`capture：${capturePath}`);
  log(`  sha256=${sha256.slice(0, 16)}…（任务钉 ${CAPTURE_SHA256_PREFIX}；${hashOk ? '一致' : '**不一致**'}，${captured.length} 字节）`);
  if (!hashOk) {
    throw new Error(`capture sha256 前缀不符（读到 ${sha256Prefix}，期望 ${CAPTURE_SHA256_PREFIX}）——换错文件了，中止`);
  }

  const pcm16 = slicePcm16(capturePath, fromMs, toMs, path.join(workDir, 'window.pcm'));
  log(`窗口：offsetMs ${fromMs}–${toMs}（${((toMs - fromMs) / 1000).toFixed(1)} s）→ PCM16 ${pcm16.length} 字节（${(pcm16.length / 2 / 16000).toFixed(2)} s 音频）`);

  // 数据库：拷贝一份，第二实例与本次运行都不碰真的那个。
  const sourceDb = path.join(os.homedir(), '.cloudcli', 'auth.db');
  if (!existsSync(sourceDb)) throw new Error(`找不到 ${sourceDb}（第二实例需要一个有用户的库）`);
  writeFileSync(databasePath, readFileSync(sourceDb));
  let userId = 1;
  let username = 'vmni-replay';
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

  const pidBefore = pidOnPort(3001);
  log(`:3001 pid（运行前）= ${pidBefore ?? '未知'}`);

  log(`起第二实例（端口 ${port}，dry-run 执行面，上限 ¥${capCny}/连接）…`);
  const instance = await bootSecondInstance({ port, workDir, homeDir, databasePath, journalDir, capCny, jwtSecret });
  log(`第二实例就绪（pid ${instance.child.pid ?? '?'}）`);

  if (bools.has('boot-only')) {
    await stopSecondInstance(instance);
    log('--boot-only：第二实例起来了，路由与鉴权都通；未调用真实上游，未产生花费。');
    return;
  }

  // 一个任何库里都不存在的 sessionId：dry-run 之外还有一层「落不到真实会话」的保险。
  const sessionId = `vmni-${randomUUID()}`;
  const startedAtMs = Date.now();
  const startedAt = nowIso(startedAtMs);

  let report: DiagnosisReport | null = null;
  let error: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/voice-realtime/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId,
        audioBase64: pcm16.toString('base64'),
        format: 'pcm16',
        // 执行面：dry-run。`session_send` / `session_interrupt` 只被记录。
        dryRun: true,
        speed,
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
  await stopSecondInstance(instance);
  const pidAfter = pidOnPort(3001);
  const finishedAt = nowIso();

  const empty: DiagnosisReport = {
    ok: false, heard: false, answered: false, elapsedMs: 0, captions: [], audioSecondsUpstream: 0,
    usage: { responses: 0, inputTokens: 0, outputTokens: 0 }, turns: [], frames: [], wire: [],
    problems: error === null ? [] : [error],
  };
  const effective = report ?? empty;
  const calls = readCalls(effective.wire);
  const errFrames = errorFrames(effective);
  const schemaViolations = errFrames.filter((frame) => JSON.stringify(frame).includes('TOOL_ARGUMENT_SCHEMA_VIOLATION'));
  const interruptCalls = calls.filter((call) => call.name === 'session_interrupt');
  const costCny = readResponseCosts(effective.wire).reduce((sum, row) => sum + row.costCny, 0);

  const lastInterrupt = interruptCalls.length === 0 ? null : interruptCalls[interruptCalls.length - 1]!;
  const intentValue = lastInterrupt === null ? null : str(lastInterrupt.args.intent);
  const messageValue = lastInterrupt === null ? null : str(lastInterrupt.args.message);

  // ── 落盘：一条连接一个 JSONL（同出货 journal 的形状）+ 原始报告。
  const entries: Array<Record<string, unknown>> = [
    {
      journal: 'voice-realtime-interrupt-missing-intent-replay',
      kind: 'run.connection',
      at: startedAt,
      connectionId: CAPTURE_ID,
      captureSha256: sha256,
      fromMs,
      toMs,
      speed,
      dryRun: true,
    },
  ];
  for (const call of calls) {
    entries.push({
      journal: 'voice-realtime-interrupt-missing-intent-replay',
      kind: 'run.call',
      at: nowIso(startedAtMs + call.atMs),
      atMs: call.atMs,
      name: call.name,
      arguments: call.args,
      raw: call.raw,
      parsed: call.parsed,
    });
  }
  for (const frame of errFrames) {
    entries.push({ journal: 'voice-realtime-interrupt-missing-intent-replay', kind: 'run.error-frame', at: finishedAt, frame });
  }
  entries.push({
    journal: 'voice-realtime-interrupt-missing-intent-replay',
    kind: 'run.verdict',
    at: finishedAt,
    connectionId: CAPTURE_ID,
    heard: effective.heard,
    captions: effective.captions,
    interrupted: interruptCalls.length > 0,
    interruptIntent: intentValue,
    interruptMessage: messageValue,
    schemaViolations: schemaViolations.length,
    costCny,
    reportProblems: effective.problems,
  });
  writeFileSync(path.join(workDir, `${CAPTURE_ID}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 });
  writeFileSync(path.join(workDir, 'report.json'), `${JSON.stringify(effective, null, 2)}\n`, { mode: 0o600 });

  // ── 读数。
  log('');
  log('── 回放读数 ──');
  log(`heard=${String(effective.heard)}  captions=${JSON.stringify(effective.captions)}`);
  log(`模型调用：${calls.length === 0 ? '（未调工具）' : calls.map((c) => `${c.name} ${c.raw}`).join(' | ')}`);
  log(`session_interrupt 调用：${interruptCalls.length} 次`);
  if (lastInterrupt !== null) {
    log(`  最后一次参数：${lastInterrupt.raw}`);
    log(`  intent=${intentValue === null ? '（缺失）' : `「${intentValue}」`}  message=${messageValue === null ? '（缺失）' : `「${messageValue}」`}`);
  }
  log(`TOOL_ARGUMENT_SCHEMA_VIOLATION 帧：${schemaViolations.length} 条`);
  log(`出站错误帧合计：${errFrames.length} 条；报告 problems：${effective.problems.length === 0 ? '（无）' : effective.problems.join(' / ')}`);
  log(`花费（出货估算公式）：¥${costCny.toFixed(4)}（上限 ¥${capCny}）`);
  log(`:3001 pid：${pidBefore ?? '未知'} → ${pidAfter ?? '未知'}（${pidBefore !== null && pidBefore === pidAfter ? '相同，未重启' : '需人工复核'}）`);
  log(`运行目录：${workDir}（journal ${CAPTURE_ID}.jsonl；原始报告 report.json；第二实例日志 second-instance.log）`);

  if (error !== null) {
    log(`**本连接失败**：${error}`);
    process.exitCode = 1;
  }
}

main().catch((thrown: unknown) => {
  console.error(thrown instanceof Error ? thrown.stack ?? thrown.message : String(thrown));
  process.exitCode = 1;
});
