#!/usr/bin/env tsx
/**
 * 「模型是笔，不是代理人」(a) 模式的真实上游回放 —— 只报读数，不改实现（2026-10-14）。
 *
 * 问题。2026-10-14 第二次实测（journal `e650117b`）丢了 4 段话，全在 Claude 忙时：模型回文本
 * 「No response requested.」、或调用被 `turn_detected` 截断后不再重发、或打断只带 `intent`。人裁定倾向
 * (a)：realtime 模型只整理并转发，不做「转不转」的取舍；暂不做机械兜底，先看模型能力。本脚本把最近几次
 * 真实对话的**原始麦克风音频**按实时节奏重新喂给真实 `qwen3.8-omni-flash-realtime`，比较三臂：
 *
 *   B   出货基线：`VOICE_REALTIME_INSTRUCTIONS` + 三个工具（send / interrupt / status）+ 收尾 response.create。
 *   A   (a) 模式：新 prompt（删 CONTINUE 免调用臂；打断时 message 必带原话）+ 两个工具（去 session_status）
 *       + 收尾 response.create。
 *   AN  同 A，但工具结果后**不**发收尾 response.create（Q4：「OK」还要不要）。
 *
 * 驱动的是**出货**的 transport + bridge（in-process），执行器是只记录的替身，返回值与出货代理逐字同形
 * （`session_send` 的 `{accepted, instruction}`）。忙闲状态按原 journal 的 `status injected` 时间线重放进
 * instructions（与出货 `composeVoiceRealtimeInstructions` 同构），所以模型看到的「Claude 在跑」与当时一致。
 * 不起第二实例、不连 :3001、不向任何会话投递。
 *
 * 用法（仓库根）：
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-relay-mode-replay/run.mts \
 *     --capture e650117b --arm A --rep 1 --out /tmp/relay-mode-replay
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SESSION_DEFAULTS,
  VOICE_REALTIME_INSTRUCTIONS,
  VOICE_REALTIME_TOOLS,
  connect,
  createDashscopeTransport,
  estimateRealtimeCostCny,
  type RealtimeToolExecutor,
} from '../../server/modules/voice-realtime/index.js';
import {
  VOICE_REALTIME_STATUS_HEADER,
  VOICE_REALTIME_STATUS_STALENESS_RULE,
} from '../../server/modules/voice-realtime/voice-realtime-settings.js';

type Arm = 'B' | 'A' | 'AN';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
}

const CAPTURE_PREFIX = arg('capture');
const ARM = arg('arm') as Arm;
const REP = arg('rep', '1');
const OUT = arg('out', path.join(os.tmpdir(), 'relay-mode-replay'));
const CAP_CNY = Number(arg('cap', '0.6'));
const TAIL_MS = 10_000;
const CHUNK_MS = 40;
const MAX_MS = Number(arg('max-ms', '0'));

if (!['B', 'A', 'AN'].includes(ARM)) throw new Error(`bad --arm ${ARM}`);

const HOME = os.homedir();
const CAPTURE_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-capture');
const LOG_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-log');
const captureId = readdirSync(CAPTURE_DIR).find((f) => f.startsWith(CAPTURE_PREFIX) && f.endsWith('.wav'))!.replace(/\.wav$/, '');

// ── (a) 模式的 prompt：只改「转不转」与打断带原话两处，其余措辞尽量沿用出货 ──
const A_INSTRUCTIONS = [
  'You are a voice relay for one Claude Code session: you tidy up what the user says and pass it on.',
  'You are not a participant. You never answer, comment, judge or reason about what was said, and you never reply in text.',
  'EVERY utterance of the user — instructions, questions, remarks, feedback, acknowledgements, complaints,',
  'even a single word — must reach the session. There is no case in which you call no function:',
  'deciding that something does not need to be passed on is never your call.',
  'Pass it on by calling the `session_send` function with `{ message }`, where message is what the user said,',
  'kept in their own words (fix obvious speech-recognition slips and join the fragments of one sentence;',
  'do not paraphrase, summarise or add anything).',
  'The ONE choice you make is HOW it is delivered. While work is running (see the status below), judge for',
  'yourself whether the user wants that running work stopped, or taken a different way — reading what they',
  'MEANT rather than looking for any particular word; such a wish is very often wrapped inside new words the',
  'person is adding. When they do, call `session_interrupt` instead of `session_send`, with their words in',
  '`message` (kept exactly as you would for `session_send`, always present, even if it is only "stop") and',
  'the reason you read it that way in `intent`; their words are delivered to the session right after the stop.',
  'Otherwise call `session_send`: words said while the work runs are queued for it, which is fine.',
  'After a function result, reply with the single word OK and say nothing else.',
  'The session is fixed by the connection; never name one.',
].join(' ');

const A_STALENESS_RULE = '该行的 ageMs 是这条状态的年龄；ageMs > 4000 的状态已过期，不得当作现状复述。';

const baseInstructions = ARM === 'B' ? VOICE_REALTIME_INSTRUCTIONS : A_INSTRUCTIONS;
const stalenessRule = ARM === 'B' ? VOICE_REALTIME_STATUS_STALENESS_RULE : A_STALENESS_RULE;
const tools =
  ARM === 'B'
    ? VOICE_REALTIME_TOOLS
    : VOICE_REALTIME_TOOLS.filter((tool) => tool.name !== 'session_status').map((tool) =>
        tool.name === 'session_interrupt'
          ? { ...tool, description: 'Stop the run, then deliver `message` (the user\'s words); `intent` = why.' }
          : tool,
      );

// ── 音频与原 journal 的状态时间线 ──
const wav = readFileSync(path.join(CAPTURE_DIR, `${captureId}.wav`));
const dataAt = wav.indexOf(Buffer.from('data')) + 8;
const pcmFull = wav.subarray(dataAt);
const pcm = MAX_MS > 0 ? pcmFull.subarray(0, MAX_MS * 32) : pcmFull;
const timeline = readFileSync(path.join(CAPTURE_DIR, `${captureId}.timeline.jsonl`), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const originAtMs = Date.parse(timeline.find((e) => e.kind === 'origin').at);

type StatusPoint = { offsetMs: number; seq: number; phase: string; items: number; bytes: number };
const statusPoints: StatusPoint[] = [];
for (const line of readFileSync(path.join(LOG_DIR, `${captureId}.jsonl`), 'utf8').trim().split('\n')) {
  const rec = JSON.parse(line);
  const m = /^status injected seq=(\d+) phase=(\S+) queued=(\d+)\/(\d+)B/.exec(rec.line ?? '');
  if (m) {
    statusPoints.push({
      offsetMs: Date.parse(rec.at) - originAtMs,
      seq: Number(m[1]),
      phase: m[2]!,
      items: Number(m[3]),
      bytes: Number(m[4]),
    });
  }
}

const runDir = path.join(OUT, `${CAPTURE_PREFIX}-${ARM}-r${REP}`);
mkdirSync(runDir, { recursive: true });
const eventsPath = path.join(runDir, 'events.jsonl');
writeFileSync(eventsPath, '');
let t0 = 0;
const rec = (kind: string, data: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify({ t: Date.now() - t0, kind, ...data })}\n`);
};

let currentStatus: StatusPoint | null = null;
let runStartedAt = 0;
const composeInstructions = (): string => {
  if (currentStatus === null) return baseInstructions;
  const now = Date.now();
  const at = now - 1000;
  const run = currentStatus.phase === 'idle' && currentStatus.seq === 0 ? '-' : 'replay-run';
  const line =
    `[exec] phase=${currentStatus.phase} run=${run} statusSeq=${currentStatus.seq} ` +
    `elapsed=${runStartedAt === 0 ? 0 : Math.round((now - runStartedAt) / 1000)}s ` +
    `queued=${currentStatus.items}/${currentStatus.bytes}B pending=- at=${at} ageMs=${now - at}`;
  return `${baseInstructions}\n\n${VOICE_REALTIME_STATUS_HEADER}\n${stalenessRule}\n${line}`;
};

const executor: RealtimeToolExecutor = {
  session_send: (args) => {
    rec('exec', { tool: 'session_send', args });
    return {
      accepted: true,
      instruction:
        'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
    };
  },
  session_interrupt: (args) => {
    rec('exec', { tool: 'session_interrupt', args });
    return { aborted: true, runId: 'replay-run', triggerSeq: null, queuedStillPending: 0 };
  },
  session_status: (args) => {
    rec('exec', { tool: 'session_status', args });
    const s = currentStatus;
    return {
      sessionId: 'replay-session',
      phase: s?.phase ?? 'idle',
      runId: s && s.phase !== 'idle' ? 'replay-run' : null,
      elapsedMs: runStartedAt === 0 ? null : Date.now() - runStartedAt,
      startedAt: runStartedAt === 0 ? null : runStartedAt,
      queuedItems: s?.items ?? 0,
      queuedBytes: s?.bytes ?? 0,
      maxBytes: 65536,
      lastDelivery: null,
      pendingInteraction: null,
      statusSeq: s?.seq ?? 0,
      at: Date.now(),
      covers: null,
      queuedNotStarted: null,
      lastCliActivity: null,
      freshness: null,
    };
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let costCny = 0;

const transport = createDashscopeTransport({
  sessionDefaults: DEFAULT_SESSION_DEFAULTS,
  respondToToolOutputs: ARM !== 'AN',
  spendGuard: { maxCnyTotal: CAP_CNY, windowMs: 30_000, maxCnyPerWindow: CAP_CNY },
  observer: ({ direction, wire }) => {
    const w = wire as Record<string, unknown>;
    const type = String(w.type ?? '');
    if (type === 'input_audio_buffer.append' || type.endsWith('.delta')) return;
    if (direction === 'sent' && type === 'session.update') {
      rec('wire', { dir: 'sent', type });
      return;
    }
    if (type === 'response.done') {
      const usage = (w.response as { usage?: unknown } | undefined)?.usage;
      costCny += estimateRealtimeCostCny(usage);
    }
    rec('wire', { dir: direction, wire: w });
  },
  onError: (error) => rec('transport_error', { error: JSON.stringify(error).slice(0, 400) }),
  log: (line) => rec('transport_log', { line }),
});

const bridge = connect(transport, tools, executor, {
  maxConnectAttempts: 1,
  hooks: {
    onError: (error) => rec('bridge_error', { error: JSON.stringify(error).slice(0, 600) }),
    onCaption: (caption) => {
      if (caption.final) rec('caption', { itemId: caption.itemId, text: caption.text });
    },
  },
});

async function main(): Promise<void> {
  t0 = Date.now();
  rec('meta', {
    captureId,
    arm: ARM,
    rep: REP,
    instructionsChars: baseInstructions.length,
    tools: tools.map((t) => t.name),
    respondToToolOutputs: ARM !== 'AN',
    statusPoints: statusPoints.length,
    audioMs: Math.round((pcm.length / 32000) * 1000),
  });
  await Promise.race([bridge.whenConnected(), sleep(15_000)]);
  if (bridge.state !== 'open') throw new Error(`bridge not open: ${bridge.state}`);
  bridge.sendSessionUpdate(composeInstructions());
  await sleep(500);

  const startedAt = Date.now();
  rec('audio_start', {});
  const chunkBytes = (32000 * CHUNK_MS) / 1000;
  let nextStatus = 0;
  for (let off = 0, i = 0; off < pcm.length; off += chunkBytes, i += 1) {
    const offsetMs = i * CHUNK_MS;
    while (nextStatus < statusPoints.length && statusPoints[nextStatus]!.offsetMs <= offsetMs) {
      const point = statusPoints[nextStatus]!;
      if (point.phase === 'running' && (currentStatus === null || currentStatus.phase !== 'running')) {
        runStartedAt = Date.now();
      }
      currentStatus = point;
      rec('status', { ...point });
      bridge.sendSessionUpdate(composeInstructions());
      nextStatus += 1;
    }
    bridge.sendAudioFrame(pcm.subarray(off, off + chunkBytes).toString('base64'));
    const due = startedAt + (i + 1) * CHUNK_MS;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }
  rec('audio_end', {});
  await sleep(TAIL_MS);
  rec('done', { costCny });
  await bridge.close();
}

main()
  .catch((error) => {
    rec('fatal', { error: String(error?.stack ?? error) });
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(), 1000);
  });
