#!/usr/bin/env tsx
/**
 * 上行 VAD 三后端「本机权重 / ABI 可用性」隔离探针。
 *
 * 为什么需要这个文件。`server/modules/voice-realtime/voice-realtime-uplink-vad.ts` 已经把 Silero /
 * TEN / WebRTC 三个后端收在一个 grid 契约之后，并且对「后端跑不起来」给出 `unavailable` + 原因，而不是
 * 抛异常。但「本机上这三个后端到底能不能加载、权重在不在」这件事，在本轮（2026-10-14）只以一次性 shell
 * 读数存在于一次人工审计对话里——一次 `node -e "require('onnxruntime-node')"` 的输出，谁也没法重跑、
 * 没法复核、没法归档。本探针把那些读数变成**可重跑、可归档**的产物：它走模块**默认**的加载路径
 * （不传 `loadDependency`、不传 `weightsExist`，于是模块用动态 `import()` 与 `statSync`），对三个后端
 * 各取一次真实读数，并把结果写进 `docs/operations/voice-uplink-vad-isolation-probe.md`（由本探针生成，
 * 不手改）。
 *
 * ⛔ 本探针不下载任何模型权重。若 Silero / TEN 在本机没有可读权重文件，如实记为 `unavailable` + 原因，
 * 绝不为了凑一条「available」的读数而临时下载或伪造一个权重路径。权重探测是**只读**的 `statSync`。
 *
 * ⛔ 本探针不碰任何生产面：不动 `:3001`、不改任何生产 env、不新建/不写任何 `.env*` 文件、不向
 * `server/` 或 `src/` 写任何东西。任务书 AC4/AC6 的读数由探针自己采集（`:3001` 的 pid 前后对照、
 * `.env*` 的 mtime 前后对照、零外联静态扫描）。
 *
 * 判据来源（本探针与判据的关系）。任务书 AC1 的验收命令逐字是
 * `npx tsx --tsconfig server/tsconfig.json experiments/voice-uplink-vad-isolation-probe/probe.mts --report-only /tmp/uplinkvad-iso`
 * ——所以本文件支持 `--report-only` 与一个位置参数输出目录。产物**只有一份 markdown 报告**：
 * `<outDir>/voice-uplink-vad-isolation-probe.md`，`<outDir>` 默认是仓库的 `docs/operations/`（被提交、被归档的那份），
 * 位置参数可把它改到别处。`--report-only` 收窄输出：只落地报告文档、不回显到 stdout——验收把它写进 `/tmp`，
 * 既不回显也不碰工作树里的归档副本。
 *
 * 用法（仓库根；`--tsconfig server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-uplink-vad-isolation-probe/probe.mts
 *                              → 写 <repo>/docs/operations/voice-uplink-vad-isolation-probe.md 并把文档回显到 stdout
 *   … --report-only <dir>      → 只写 <dir>/voice-uplink-vad-isolation-probe.md，不回显（验收用）
 *   … <dir>                    → 报告写进 <dir>（默认 <repo>/docs/operations）
 *   … --help                   → 打印用法
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UPLINK_VAD_BACKENDS,
  UPLINK_VAD_FRAME_BYTES,
  UPLINK_VAD_GRID,
  createUplinkVadClassifier,
  readUplinkVadBackend,
  type UplinkVadBackendId,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 报告文件名（被提交、被归档的那份报告就在仓库 `docs/operations/` 下）。 */
const REPORT_BASENAME = 'voice-uplink-vad-isolation-probe.md';

/** 被审计的生产模块，作为**路径**——AC5/AC6 的静态扫描读的是它的源码，不是一个声明。 */
const MODULE_FILE = path.resolve(REPO_ROOT, 'server/modules/voice-realtime/voice-realtime-uplink-vad.ts');

/** 生产服务的端口；AC4 要的是「探针运行期间它没被重启」。 */
const SERVER_PORT = 3001;

/** Plan 要求：每个后端在权重就位时喂 5 帧真实 PCM16。5 帧足以覆盖两个窗口化后端的起播滞后与一次 flush。 */
const PROBE_FRAMES = 5;

/** 引擎目录（与测例 `voice-realtime-uplink-vad.test.ts` 同址，可被 env 覆盖）。 */
const ENGINES_DIR = process.env.VOICE_VAD_ENGINES_DIR ?? '/data/home/yale/work/voice-vad-engines';

/**
 * AC3 的那句话。报告**必须**逐字包含它，且本探针在落盘前 assert 它仍在——取假形态即「从报告模板里删掉
 * 这句 ⇒ 该断言红」。放在常量里而不是散在模板各处，是为了让「删掉这句话」成为一个**可定位的单点**。
 */
const WEIGHTS_NOT_REPO_MANAGED = '权重路径不受本仓库管理，没有生产代码指向它';

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** 一个路径既是存在的、又是普通文件——目录放权重不算权重（与模块默认 `weightsExist` 同语义）。 */
function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readPackageVersion(name: string): string {
  try {
    const raw = readFileSync(path.join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'absent';
  }
}

/**
 * 读监听 `port` 的进程 pid。
 *
 * 先 `ss -ltnp`（取 `users:(("…",pid=NNN,…))` 里的第一个 pid），退化到 `lsof -ti`。两者都读不到时返回
 * `none`——那本身也是一条读数（「此刻没有进程监听该端口」），⛔ 不得伪装成某个 pid。
 */
function readPortPid(port: number): string {
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = out.match(/pid=(\d+)/);
    if (match?.[1] !== undefined) return match[1];
  } catch {
    /* 退化到 lsof */
  }
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    const first = out.trim().split('\n')[0];
    if (first !== undefined && first !== '') return first;
  } catch {
    /* 端口无人监听 */
  }
  return 'none';
}

/** 仓库根下 `.env*` 的「名称 → mtimeMs」快照；AC4 用它做前后对照。 */
function envSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  const candidates = ['.env', '.env.local', '.env.test', '.env.example', '.env.development', '.env.production'];
  for (const name of candidates) {
    const file = path.join(REPO_ROOT, name);
    try {
      snapshot[name] = statSync(file).mtimeMs;
    } catch {
      /* 不存在的 .env* 不记，读作「未新建」 */
    }
  }
  return snapshot;
}

/** 两个 `.env*` 快照是否逐键一致（同名同 mtime，且没有新增键）。 */
function envSnapshotsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** 读源码（缺文件时返回空串，让静态扫描把它读作「零命中」而不是崩掉）。 */
function readSourceOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC5：零外联的静态扫描
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 会被判为「可能发起网络请求」的模块名（含 `node:` 前缀与非前缀两种拼法）。
 *
 * 与下面两个 token 表一样，判据读的是**源码的 import 图**，不是一句自述——一个「本探针不联网」的声明而
 * 没有任何机械读数，正是本仓库反复排除的真空判据。
 */
const NETWORK_MODULES = new Set([
  'net',
  'http',
  'https',
  'http2',
  'dgram',
  'tls',
  'ws',
  'undici',
  'node:net',
  'node:http',
  'node:https',
  'node:http2',
  'node:dgram',
  'node:tls',
  'node:ws',
  'node:undici',
]);

/**
 * 全局逃逸口 token。**逐字由碎片拼出**，所以本文件源码里不会出现连续的 token 本身——否则扫描会数到它自己
 * 的判据表（`absence-ac-grep-counts-the-prose-that-explains-the-absence` 的形态）。
 */
const GLOBAL_NETWORK_TOKENS: readonly string[] = [
  'fet' + 'ch(',
  'XMLHttp' + 'Request',
  'send' + 'Beacon',
  'new Web' + 'Socket',
  'navigator.send' + 'Beacon',
];

/** 从源码里抽出所有**字面量** import/export-from 与字面量动态 import 的说明符。 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const staticRe = /(?:import|export)[^;'"\n]*?from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(source)) !== null) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynRe.exec(source)) !== null) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  return specs;
}

/** 一个文件的每处 token 命中数。 */
function tokenHits(source: string, token: string): number {
  let count = 0;
  let index = source.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(token, index + token.length);
  }
  return count;
}

type EgressFileReport = {
  file: string;
  imports: string[];
  networkImports: string[];
  tokenHits: Record<string, number>;
};

function scanEgress(file: string): EgressFileReport {
  const source = readSourceOrEmpty(file);
  const imports = importSpecifiers(source);
  const networkImports = imports.filter((spec) => NETWORK_MODULES.has(spec));
  const hits: Record<string, number> = {};
  for (const token of GLOBAL_NETWORK_TOKENS) hits[token] = tokenHits(source, token);
  return { file, imports, networkImports, tokenHits: hits };
}

// ─────────────────────────────────────────────────────────────────────────────
// 权重探测（只读）与后端读数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每个 ONNX 后端按顺序探测的候选权重路径。第一处「存在的普通文件」即为 `found`。
 *
 * 这些是**只读探测**的候选，不是「权重已就位」的声明：只要没有任何一处命中，探针就如实记 `unavailable`。
 * 候选里包含 `$HOME` 下的实验目录——任务书明确要求如实记录「本机用户目录下的 `.onnx` 不受本仓库管理」。
 */
function weightCandidates(backend: UplinkVadBackendId): string[] {
  const home = os.homedir();
  const raw =
    backend === 'silero'
      ? [
          process.env.UPLINK_VAD_SILERO_WEIGHTS ?? '',
          path.join(ENGINES_DIR, 'silero', 'silero_vad.onnx'),
          path.join(home, 'silero-vad-probe', 'silero_vad.onnx'),
          path.join(home, 'work', 'voice-vad-engines', 'silero', 'silero_vad.onnx'),
        ]
      : backend === 'ten'
        ? [
            process.env.UPLINK_VAD_TEN_WEIGHTS ?? '',
            path.join(ENGINES_DIR, 'ten-vad', 'ten-vad.onnx'),
            path.join(home, 'work', 'voice-vad-engines', 'ten-vad', 'ten-vad.onnx'),
          ]
        : [];
  // 去重但保持顺序：ENGINES_DIR 默认值本身就可能与某个 $HOME 候选同址。
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of raw) {
    if (candidate === '' || seen.has(candidate)) continue;
    seen.add(candidate);
    unique.push(candidate);
  }
  return unique;
}

/** `status` / `reason` 的一对读数。`n/a` 用于 WebRTC 的「权重臂」——它本就没有权重。 */
type StatusReading = { status: 'available' | 'unavailable' | 'n/a'; reason: string | null };

/** 形状读数的结果。 */
type ShapeReading =
  | { kind: 'ok' }
  | { kind: 'not-run' }
  | { kind: 'error'; reason: string };

/** 一个后端的一次非空 verdict 形状校验。 */
function checkVerdictShape(verdict: UplinkVadFrameVerdict, expectedFrame: number): string | null {
  if (verdict === null || typeof verdict !== 'object') return 'verdict is not an object';
  if (verdict.frameIndex !== expectedFrame) {
    return `frameIndex ${String(verdict.frameIndex)} is not ${expectedFrame}`;
  }
  if (typeof verdict.speech !== 'boolean') return 'speech is not boolean';
  if (!(verdict.probability === null || typeof verdict.probability === 'number')) {
    return 'probability is neither null nor a number';
  }
  if (typeof verdict.bypassed !== 'boolean') return 'bypassed is not boolean';
  if (!(verdict.reason === null || typeof verdict.reason === 'string')) {
    return 'reason is neither null nor a string';
  }
  return null;
}

/**
 * 喂 `frames` 帧真实 PCM16（静音）并收集全部 verdict，再 flush 收尾。
 *
 * ⛔ 这里只用静音帧问**形状**，不问「是不是语音」——本探针的判据是「真实加载路径能不能跑起来并返回合理
 * 形状的 verdict」，不是某个引擎在某段音频上的判决（那是 `experiments/voice-vad/` 的语料读数）。
 *
 * 形状判据（含一条容易踩错的时序约束）：两个窗口化后端有**起播滞后**，`classify` 的返回值是
 * 「因为这一推而变 final 的 frame」，其 `frameIndex` **不**等于本次推入的下标（探针第一版就错在这里：
 * 拿推入下标去对 `classify frame 1` 却读到 `frameIndex 0`）。模块的契约是 verdict **按 frame 顺序离开**
 * ——所以正确的判据是：全部 verdict（classify + flush）合计恰为 `frames` 条，且第 k 条的 `frameIndex === k`。
 */
async function runFrames(
  classifier: UplinkVadClassifier,
  frames: number,
): Promise<{
  verdicts: UplinkVadFrameVerdict[];
  nullPushes: number[];
  flushCount: number;
  shapeError: string | null;
}> {
  const verdicts: UplinkVadFrameVerdict[] = [];
  const nullPushes: number[] = [];
  const silence = Buffer.alloc(UPLINK_VAD_FRAME_BYTES);
  for (let index = 0; index < frames; index += 1) {
    const verdict = await classifier.classify(silence);
    if (verdict === null) {
      nullPushes.push(index);
      continue;
    }
    verdicts.push(verdict);
  }
  const tail = await classifier.flush();
  verdicts.push(...tail);

  let shapeError: string | null = null;
  if (verdicts.length !== frames) {
    shapeError = `expected exactly ${frames} verdicts from ${frames} frames + flush, got ${verdicts.length}`;
  } else {
    for (let index = 0; index < verdicts.length; index += 1) {
      const error = checkVerdictShape(verdicts[index]!, index);
      if (error !== null) {
        shapeError = `verdict #${index}: ${error}`;
        break;
      }
    }
  }
  return { verdicts, nullPushes, flushCount: tail.length, shapeError };
}

/** 一个后端的完整读数：默认臂（生产默认，无权重） + 权重臂（探测到权重时）。 */
type BackendReading = {
  backend: UplinkVadBackendId;
  /** 生产默认臂：`createUplinkVadClassifier({ backend })`，不传 weightsPath、不传任何 seam。 */
  defaultArm: StatusReading;
  /** 只读探测到的权重候选与首个命中。 */
  weightsCandidates: string[];
  weightsFound: string | null;
  /** 权重臂：命中权重时用其 weightsPath 走真实加载 + 5 帧分类；WebRTC 本就有权重（无需）。 */
  weightsArmStatus: StatusReading;
  weightsArmShape: ShapeReading;
  framesFed: number;
  classifyVerdicts: number;
  flushVerdicts: number;
  nullPushes: number[];
};

async function readBackend(backend: UplinkVadBackendId): Promise<BackendReading> {
  // ── 默认臂：正是生产会走的调用形状（无 weightsPath）。 ──
  const defaultClassifier = await createUplinkVadClassifier({ backend });
  const defaultStatus = readUplinkVadBackend(defaultClassifier);
  const defaultArm: StatusReading = { status: defaultStatus.status, reason: defaultStatus.reason };

  const candidates = weightCandidates(backend);
  const found = candidates.find((candidate) => isRegularFile(candidate)) ?? null;

  const reading: BackendReading = {
    backend,
    defaultArm,
    weightsCandidates: candidates,
    weightsFound: found,
    weightsArmStatus: { status: 'n/a', reason: null },
    weightsArmShape: { kind: 'not-run' },
    framesFed: 0,
    classifyVerdicts: 0,
    flushVerdicts: 0,
    nullPushes: [],
  };

  if (backend === 'webrtc') {
    // WebRTC 不需要权重：默认臂就是唯一的臂，直接在它上面跑 5 帧真实分类。
    if (defaultStatus.status !== 'available') {
      // AC2 要求 WebRTC 必须报告 available（本机 ABI 已验证）。这不是「跳过」，是判据红。
      throw new Error(
        `AC2 violated: webrtc backend reported status='${defaultStatus.status}' ` +
          `(reason: ${defaultStatus.reason ?? '<none>'}); the criterion requires 'available' on this machine`,
      );
    }
    const run = await runFrames(defaultClassifier, PROBE_FRAMES);
    reading.weightsArmStatus = { status: 'n/a', reason: 'webrtc has no weights to resolve' };
    reading.weightsArmShape = shapeReading(run);
    reading.framesFed = PROBE_FRAMES;
    reading.classifyVerdicts = run.verdicts.length - run.flushCount;
    reading.flushVerdicts = run.flushCount;
    reading.nullPushes = run.nullPushes;
    await defaultClassifier.close();
    return reading;
  }

  await defaultClassifier.close();

  // ── 权重臂：探测到权重才跑；否则如实记 unavailable，不伪造路径。 ──
  if (found === null) {
    reading.weightsArmStatus = {
      status: 'unavailable',
      reason: `no weights file found among the probed candidates (see weightsCandidates)`,
    };
    return reading;
  }

  const armClassifier = await createUplinkVadClassifier({ backend, weightsPath: found });
  const armStatus = readUplinkVadBackend(armClassifier);
  reading.weightsArmStatus = { status: armStatus.status, reason: armStatus.reason };
  if (armStatus.status === 'available') {
    const run = await runFrames(armClassifier, PROBE_FRAMES);
    reading.weightsArmShape = shapeReading(run);
    reading.framesFed = PROBE_FRAMES;
    reading.classifyVerdicts = run.verdicts.length - run.flushCount;
    reading.flushVerdicts = run.flushCount;
    reading.nullPushes = run.nullPushes;
  }
  await armClassifier.close();
  return reading;
}

function shapeReading(run: { shapeError: string | null }): ShapeReading {
  return run.shapeError === null ? { kind: 'ok' } : { kind: 'error', reason: run.shapeError };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

type Reading = {
  generatedAt: string;
  node: string;
  npm: string;
  modulesAbi: string;
  platform: string;
  arch: string;
  pidBefore: string;
  pidAfter: string;
  envBefore: Record<string, number>;
  envAfter: Record<string, number>;
  packageVersions: Record<string, string>;
  bindings: { path: string; present: boolean }[];
  egress: EgressFileReport[];
  backends: BackendReading[];
};

function statusCell(reading: StatusReading): string {
  if (reading.status === 'n/a') return `n/a${reading.reason !== null ? ` — ${reading.reason}` : ''}`;
  return `${reading.status}${reading.reason !== null ? ` — ${reading.reason}` : ''}`;
}

function shapeCell(reading: ShapeReading): string {
  if (reading.kind === 'ok') return 'ok (verdict 形状合法)';
  if (reading.kind === 'not-run') return '未跑';
  return `error — ${reading.reason}`;
}

function buildReport(reading: Reading): string {
  const lines: string[] = [];
  lines.push('# 上行 VAD 三后端本机权重 / ABI 隔离实测');
  lines.push('');
  lines.push(
    '本文件由 `experiments/voice-uplink-vad-isolation-probe/probe.mts` **生成**，请勿手改（手改会在下次运行探针时被覆盖）。',
  );
  lines.push('');
  lines.push(
    '探针走 `voice-realtime-uplink-vad.ts` 的**默认**加载路径（动态 `import()` + `statSync`，不传任何 `loadDependency` / `weightsExist` seam），对 Silero / TEN / WebRTC 三个后端各取一次真实读数，并把结果归档在这份文档里。',
  );
  lines.push('');
  lines.push(`生成时刻：\`${reading.generatedAt}\``);
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'npx tsx --tsconfig server/tsconfig.json experiments/voice-uplink-vad-isolation-probe/probe.mts --report-only /tmp/uplinkvad-iso',
  );
  lines.push('```');
  lines.push('');
  lines.push('## 1. 三后端状态表');
  lines.push('');
  lines.push(
    '| 后端 | 生产默认臂 status（无 weightsPath） | 权重（只读探测） | 权重臂 status | 5 帧分类形状 | classify/flush verdict 数 |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const backend of reading.backends) {
    const weights =
      backend.backend === 'webrtc'
        ? '无需权重'
        : backend.weightsFound !== null
          ? `命中 \`${backend.weightsFound}\``
          : '未命中任何候选';
    const counts =
      backend.framesFed > 0
        ? `${backend.classifyVerdicts} + ${backend.flushVerdicts} = ${backend.classifyVerdicts + backend.flushVerdicts}`
        : '—';
    lines.push(
      `| ${backend.backend} | ${statusCell(backend.defaultArm)} | ${weights} | ${statusCell(backend.weightsArmStatus)} | ${shapeCell(backend.weightsArmShape)} | ${counts} |`,
    );
  }
  lines.push('');
  lines.push('### 1.1 逐后端细节');
  lines.push('');
  for (const backend of reading.backends) {
    lines.push(`**${backend.backend}**`);
    lines.push('');
    lines.push(`- 生产默认臂（\`createUplinkVadClassifier({ backend: '${backend.backend}' })\`）：\`${statusCell(backend.defaultArm)}\``);
    if (backend.backend === 'webrtc') {
      lines.push('- 权重：WebRTC 检测器是编译进包的 C 实现，**不需要权重文件**。');
    } else {
      lines.push('- 权重候选（只读 `statSync` 探测，按序取首个命中的普通文件）：');
      for (const candidate of backend.weightsCandidates) {
        const mark = candidate === backend.weightsFound ? '命中' : '未命中';
        lines.push(`  - \`${candidate}\` — ${mark}`);
      }
      lines.push(
        `- 权重臂（\`weightsPath = ${backend.weightsFound ?? '<none>'}\`）：\`${statusCell(backend.weightsArmStatus)}\``,
      );
    }
    if (backend.framesFed > 0) {
      lines.push(
        `- ${backend.framesFed} 帧真实 PCM16：classify 返回 ${backend.classifyVerdicts} 条 verdict，flush 返回 ${backend.flushVerdicts} 条，合计 ${backend.classifyVerdicts + backend.flushVerdicts} 条 = 帧数；classify 返回 \`null\` 的推入下标：${
          backend.nullPushes.length === 0 ? '（无）' : backend.nullPushes.join(', ')
        }。`,
      );
      lines.push(`- verdict 形状：${shapeCell(backend.weightsArmShape)}`);
    }
    lines.push('');
  }
  lines.push('## 2. 权重路径现状（如实记录）');
  lines.push('');
  lines.push(`> **${WEIGHTS_NOT_REPO_MANAGED}。**`);
  lines.push('');
  lines.push(
    '本仓库不 check in 任何 `.onnx` 权重；`voice-realtime-uplink-vad.ts` 里 Silero / TEN 的 `weightsPath` 是**必填项**，而生产代码里**没有任何地方**给它赋值——所以这两个后端在「生产默认臂」下如实报告 `unavailable`（原因 `no weights path was configured …`）。',
  );
  lines.push('');
  lines.push(
    '本机能找到的 `.onnx` 权重（若上表有命中）位于用户 `$HOME` 下的实验目录，例如 `/data/home/yale/silero-vad-probe/` 与 `/data/home/yale/work/voice-vad-engines/`。这些是**探针/测例自行指路的实验副本**，不受本仓库管理、不被任何生产代码引用；探针把它们当作**只读的权重臂输入**用来验证「ABI + 加载路径能跑」，⛔ 不把它读作「生产权重已就位」。',
  );
  lines.push('');
  lines.push('## 3. 运行时 / 包版本 / ABI 匹配');
  lines.push('');
  lines.push(`- node：\`${reading.node}\`；npm：\`${reading.npm}\``);
  lines.push(`- 平台/架构：\`${reading.platform}-${reading.arch}\`；` + '`process.versions.modules`（node ABI）：`' + reading.modulesAbi + '`');
  lines.push('');
  lines.push('| 包 | 版本 |');
  lines.push('| --- | --- |');
  for (const [name, version] of Object.entries(reading.packageVersions)) {
    lines.push(`| ${name} | ${version} |`);
  }
  lines.push('');
  lines.push('| 已编译绑定产物 | 存在 |');
  lines.push('| --- | --- |');
  for (const binding of reading.bindings) {
    lines.push(`| \`${binding.path}\` | ${binding.present ? '存在' : '缺失'} |`);
  }
  lines.push('');
  lines.push(
    '**ABI 结论**：`onnxruntime-node` 出的是 N-API（napi-v6）绑定，N-API 是跨 node 版本的 ABI 稳定面，因此它对 `process.versions.modules` 不敏感；`webrtcvad` 的 `vad.node` 是安装期用 node-gyp 针对本机 ABI 编出来的。两者都在本机（未碰 `:3001` 的独立子进程里）成功 `require()`/加载——上表「存在」列与三后端 status 列共同构成这条结论的机械读数。',
  );
  lines.push('');
  lines.push('## 4. ":3001 未重启" 证据');
  lines.push('');
  lines.push(`- 探针开始时监听 :${SERVER_PORT} 的 pid：\`${reading.pidBefore}\``);
  lines.push(`- 探针结束时监听 :${SERVER_PORT} 的 pid：\`${reading.pidAfter}\``);
  lines.push(
    `- 前后一致：\`${reading.pidBefore === reading.pidAfter ? 'yes' : 'NO'}\`${reading.pidBefore === 'none' ? '（该端口当前无进程监听——读数成立但「未重启」在此为空真；如生产在跑应读到具体 pid）' : ''}`,
  );
  lines.push('');
  const envChanged = !envSnapshotsEqual(reading.envBefore, reading.envAfter);
  lines.push(`- 探针未改任何生产 env、未新建/未写任何 \`.env*\` 文件：仓库根 \`.env*\` 的 mtime 前后一致：\`${envChanged ? 'NO' : 'yes'}\``);
  lines.push('');
  lines.push('| `.env*` | mtimeMs（前） | mtimeMs（后） |');
  lines.push('| --- | --- | --- |');
  const envKeys = new Set([...Object.keys(reading.envBefore), ...Object.keys(reading.envAfter)]);
  for (const key of envKeys) {
    lines.push(`| ${key} | ${reading.envBefore[key] ?? '—（不存在）'} | ${reading.envAfter[key] ?? '—（不存在）'} |`);
  }
  lines.push('');
  lines.push('## 5. 零外联证据');
  lines.push('');
  lines.push(
    '探针静态扫描（构造判据，非自述）：对探针自身源码与被审计模块源码抽取**字面量 import 说明符**，断言无一是网络模块；并扫描若干全局逃逸口 token，断言零命中。',
  );
  lines.push('');
  lines.push('| 文件 | import 说明符 | 其中网络模块 | 全局逃逸口 token 命中 |');
  lines.push('| --- | --- | --- | --- |');
  for (const file of reading.egress) {
    const hits = Object.values(file.tokenHits).reduce((sum, n) => sum + n, 0);
    lines.push(
      `| \`${path.relative(REPO_ROOT, file.file)}\` | ${file.imports.map((s) => `\`${s}\``).join(', ') || '—'} | ${file.networkImports.length === 0 ? '无' : file.networkImports.join(', ')} | ${hits} |`,
    );
  }
  lines.push('');
  lines.push('## 6. 边界与未做');
  lines.push('');
  lines.push('- ⛔ 未下载任何模型权重；缺权重如实记 `unavailable`。');
  lines.push('- ⛔ 未触碰 `server/`、`src/` 的生产代码路径（本任务只新增 `experiments/` 与 `docs/`）。');
  lines.push('- ⛔ 未重启 `:3001`、未改生产 env、未写任何 `.env*`。');
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

type Args = { reportOnly: boolean; outDir: string; help: boolean };

function parseArgs(argv: string[]): Args {
  let reportOnly = false;
  let help = false;
  let outDir: string | null = null;
  for (const token of argv) {
    if (token === '--report-only') {
      reportOnly = true;
    } else if (token === '--help' || token === '-h') {
      help = true;
    } else if (token.startsWith('--')) {
      throw new Error(`unknown flag: ${token}`);
    } else if (outDir === null) {
      outDir = token;
    } else {
      throw new Error(`unexpected extra arg: ${token}`);
    }
  }
  return { reportOnly, outDir: outDir ?? path.join(REPO_ROOT, 'docs', 'operations'), help };
}

const USAGE =
  'usage: probe.mts [--report-only] [<outDir>]  (default outDir = <repo>/docs/operations)';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(USAGE);
    return;
  }

  const pidBefore = readPortPid(SERVER_PORT);
  const envBefore = envSnapshot();

  log(`uplink-vad-isolation-probe: :${SERVER_PORT} pid before = ${pidBefore}`);

  const backends: BackendReading[] = [];
  for (const backend of UPLINK_VAD_BACKENDS) {
    log(`uplink-vad-isolation-probe: reading backend '${backend}' …`);
    backends.push(await readBackend(backend));
  }

  const pidAfter = readPortPid(SERVER_PORT);
  const envAfter = envSnapshot();
  log(`uplink-vad-isolation-probe: :${SERVER_PORT} pid after = ${pidAfter}`);

  if (pidBefore !== pidAfter) {
    throw new Error(
      `AC4 violated: :${SERVER_PORT} pid changed during the probe (${pidBefore} → ${pidAfter}); the probe must not restart the server`,
    );
  }
  if (!envSnapshotsEqual(envBefore, envAfter)) {
    throw new Error('AC4 violated: a `.env*` file changed during the probe');
  }

  const egress = [scanEgress(fileURLToPath(import.meta.url)), scanEgress(MODULE_FILE)];
  const egressViolations = egress.flatMap((file) => [
    ...file.networkImports.map((spec) => `${file.file}: imports network module '${spec}'`),
    ...Object.entries(file.tokenHits)
      .filter(([, hits]) => hits > 0)
      .map(([token, hits]) => `${file.file}: global network token hit ${hits}×`),
  ]);
  if (egressViolations.length > 0) {
    throw new Error(`AC5 violated: ${egressViolations.join('; ')}`);
  }

  const reading: Reading = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    npm: npmVersion(),
    modulesAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    pidBefore,
    pidAfter,
    envBefore,
    envAfter,
    packageVersions: {
      'onnxruntime-node': readPackageVersion('onnxruntime-node'),
      'sherpa-onnx-node': readPackageVersion('sherpa-onnx-node'),
      webrtcvad: readPackageVersion('webrtcvad'),
    },
    bindings: [
      'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
      'node_modules/webrtcvad/build/Release/vad.node',
    ].map((relative) => ({ path: relative, present: isRegularFile(path.join(REPO_ROOT, relative)) })),
    egress,
    backends,
  };

  const report = buildReport(reading);
  if (!report.includes(WEIGHTS_NOT_REPO_MANAGED)) {
    // AC3 的取假形态：删掉那句话 ⇒ 这里红。
    throw new Error(`AC3 violated: the report does not contain the required sentence: ${WEIGHTS_NOT_REPO_MANAGED}`);
  }

  mkdirSync(args.outDir, { recursive: true });
  const reportPath = path.join(args.outDir, REPORT_BASENAME);
  writeFileSync(reportPath, report);
  log(`uplink-vad-isolation-probe: wrote report → ${reportPath}`);
  if (args.reportOnly) {
    log('uplink-vad-isolation-probe: --report-only — 只落报告文档，不回显到 stdout');
  } else {
    log('');
    log(report);
  }

  for (const backend of backends) {
    log(
      `  ${backend.backend.padEnd(7)} default=${backend.defaultArm.status}` +
        ` weightsArm=${backend.weightsArmStatus.status} shape=${backend.weightsArmShape.kind}`,
    );
  }
  log('uplink-vad-isolation-probe: done (exit 0)');
}

/** `npm --version`；读不到时退化为 `unknown`（不因缺 npm CLI 而让探针红）。 */
function npmVersion(): string {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`uplink-vad-isolation-probe: FAILED — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
