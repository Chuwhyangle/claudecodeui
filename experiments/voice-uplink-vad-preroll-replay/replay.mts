#!/usr/bin/env tsx
/**
 * 上行 VAD 起音回补（pre-roll）的真实代码重放。
 *
 * 为什么需要这个文件。2026-10-14 傍晚第七次 Live Voice 实测（连接 `af12cbaf-9ca7-4218-b0c3-
 * d371ec16ee1d`）发现：上行门控（`voice-realtime-uplink-vad-gate.ts` 的 `createUplinkVadGate`）在每次语音
 * 起点前**没有回补**，silero 判晚的那几十毫秒被直接丢掉，31 次起音里有 3 次被削 80–100 ms。修法是加起音
 * 回补（保留最近 `P` 个被丢的帧，遇「上一帧被丢、本帧判为语音」时先补再发）。这个探针用**生产代码本身**
 * ——`createUplinkVadGate` + `createUplinkVadClassifier`（silero 后端）逐帧驱动那次实测的真实录音——
 * 给出基线与开启回补两组读数，证明修复真的接上了。
 *
 * ⛔ 不是另写一份实现。全部门控逻辑走 `server/modules/voice-realtime/` 的出货模块；本文件只负责：读 wav、
 * 把每帧 base64 喂进门控、收集 summary、并按起音把「起音前被丢的、高于 -45 dBFS 的帧」的时长读出来。
 * 逐帧动作（哪个 index 被丢/被补）是**从真分类器的 verdict 序列 + §5+preroll 规则推出的**，并且**在
 * 落读数前与真门控的累计 stats 逐项核对**（不一致即报错退出）——所以它只是给真门控的读数配一副放大镜，
 * 不是第二份门控。
 *
 * ⛔ 录音是人的语音数据，不复制进仓库，只以路径参数读取；文件不存在时**停手**，绝不拿合成音频凑数。
 *
 * ⛔ 不下载任何权重。silero 权重取自 `VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH`（本机已有），或用
 * `--weights-path` 显式指定；缺权重/加载不起来就报错退出，绝不伪造一份「available」读数。
 *
 * 判据来源（AC5）。任务书 AC5 的验收命令逐字是：
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-uplink-vad-preroll-replay/replay.mts <wav>
 * ⛔ 必须是 `--tsconfig=` 的**等号**形式（空格形式会静默不执行、退 0）。所以本文件支持位置参数 wav 路径与
 * `--preroll-ms N`；不带 `--preroll-ms` 时用出货默认 `P`（`UPLINK_VAD_PRE_ROLL_MS`）。任何情况下都先跑一遍
 * 基线 `P=0`，再跑「受检臂」，两条 summary 都打印。
 *
 * 用法（仓库根；`--tsconfig=server/tsconfig.json` 是因为出货模块内部按 `.js` 拼 specifier）：
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-uplink-vad-preroll-replay/replay.mts <wav>
 *                              → 基线 P=0 + 默认 P，并打印逐起音读数与 +12% 代价读数
 *   … <wav> --preroll-ms 0     → 只把基线当「受检臂」（AC5(a)：输出含 sent=3454 headKept=801 dropped=10230）
 *   … <wav> --preroll-ms 200   → 指定 P（毫秒）
 *   … --weights-path <onnx>    → 覆盖权重路径（默认 env VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH）
 *   … --help                   → 打印用法
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  UPLINK_VAD_FRAME_BYTES,
  UPLINK_VAD_GRID,
  createUplinkVadClassifier,
  readUplinkVadBackend,
  type UplinkVadClassifier,
  type UplinkVadFrameVerdict,
} from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import {
  UPLINK_VAD_FRAME_MS,
  UPLINK_VAD_PRE_ROLL_MS,
  createUplinkVadGate,
  type UplinkVadGate,
} from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';
import { DEFAULT_TURN_DETECTION } from '../../server/modules/voice-realtime/voice-realtime-turn-detection.js';

/** AC5 里点名的三次被削起音，按录音 offset（秒）——本轮修复的靶子。 */
const NAMED_ONSETS_S = [56.76, 66.78, 227.28];
/** 「高于 -45 dBFS」的门限：被丢的非零帧里，这一档才是削头。 */
const LOUD_DBFS = -45;
/** AC5(b) 的代价上限：受检臂的总发送帧数相对基线增加不超过 12%。 */
const MAX_COST_RATIO = 0.12;

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// ─────────────────────────────────────────────────────────────────────────────
// wav 读取（只读；支持额外 chunk）
// ─────────────────────────────────────────────────────────────────────────────

type Wav = { pcm: Buffer; sampleRate: number; channels: number; bitsPerSample: number };

/** 走 chunk 链读一个 RIFF/WAVE 的 `fmt ` 与 `data`，比「假定 44 字节头」更诚实。 */
function readWav(file: string): Wav {
  const buf = readFileSync(file);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (fmt === null || data === null) {
    throw new Error(`${file} has no fmt / data chunk`);
  }
  return { pcm: data, ...fmt };
}

/** One grid frame's PCM16 RMS, in dBFS — `-Infinity` for digital silence. */
function frameDbfs(pcm: Buffer, frameIndex: number): number {
  const start = frameIndex * UPLINK_VAD_FRAME_BYTES;
  let sumSquares = 0;
  const samples = UPLINK_VAD_FRAME_BYTES / 2;
  for (let sample = 0; sample < samples; sample += 1) {
    const value = pcm.readInt16LE(start + sample * 2);
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms / 32768);
}

// ─────────────────────────────────────────────────────────────────────────────
// 一个臂：真分类器 + 真门控，逐帧驱动
// ─────────────────────────────────────────────────────────────────────────────

type Stats = { sent: number; headKept: number; dropped: number; bypassed: number; preRoll: number };

type Arm = {
  prerollMs: number;
  stats: Stats;
  /** Verdict per grid frame, as the REAL classifier produced them (recorded through a pass-through wrap). */
  verdicts: Map<number, UplinkVadFrameVerdict>;
  aFrames: number;
  preRollFrames: number;
  /** Frames the gate let cross, in order (the caller's own base64). */
  wired: string[];
};

async function runArm(
  frames: readonly string[],
  weightsPath: string,
  prerollMs: number,
): Promise<Arm> {
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath });
  const reading = readUplinkVadBackend(classifier);
  if (reading.status !== 'available') {
    throw new Error(`silero backend is not available: ${reading.reason ?? '<no reason>'}`);
  }
  const verdicts = new Map<number, UplinkVadFrameVerdict>();
  const recording: UplinkVadClassifier = {
    backend: classifier.backend,
    status: classifier.status,
    reason: classifier.reason,
    async classify(frame: Buffer, declared = {}) {
      const verdict = await classifier.classify(frame, declared);
      if (verdict !== null) {
        verdicts.set(verdict.frameIndex, verdict);
      }
      return verdict;
    },
    async flush() {
      const tail = await classifier.flush();
      for (const verdict of tail) {
        verdicts.set(verdict.frameIndex, verdict);
      }
      return tail;
    },
    close: () => classifier.close(),
  };
  const gate: UplinkVadGate = createUplinkVadGate({
    classifier: recording,
    silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms,
    preRollMs: prerollMs,
  });
  const wired: string[] = [];
  let stats: Stats = { sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };
  for (const audio of frames) {
    const decision = await gate.observe(audio);
    wired.push(...decision.frames);
    stats = {
      sent: decision.sent,
      headKept: decision.headKept,
      dropped: decision.dropped,
      bypassed: decision.bypassed,
      preRoll: decision.preRoll,
    };
  }
  const tail = await gate.flush();
  wired.push(...tail.frames);
  stats = { sent: tail.sent, headKept: tail.headKept, dropped: tail.dropped, bypassed: tail.bypassed, preRoll: tail.preRoll };
  const arm: Arm = { prerollMs, stats, verdicts, aFrames: gate.aFrames, preRollFrames: gate.preRollFrames, wired };
  await gate.close();
  return arm;
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐帧动作的推导（真门控读数的放大镜），并与真 stats 逐项核对
// ─────────────────────────────────────────────────────────────────────────────

type Derived = {
  /** Grid-frame indices the gate withheld (the pre-roll's replays are NOT here — they crossed). */
  dropped: Set<number>;
  /** Grid-frame indices the pre-roll replayed, in replay order. */
  replayed: number[];
  stats: Stats;
};

/**
 * 按 §5 + pre-roll 规则在 **final verdict 序列**上推进一次，得到每个 index 的归属。
 *
 * 这不是第二份门控：规则与出货门控逐条相同（见 `createUplinkVadGate`），且结果必须与真门控的累计 stats
 * **逐项相等**，否则 `runArm` 之后的核对会报错退出。它的唯一用途是把「哪些帧被丢了」按 index 摊平，好让
 * 起音读数落在具体帧上。
 */
function deriveActions(arm: Arm, frameCount: number): Derived {
  const aFrames = arm.aFrames;
  const P = arm.preRollFrames;
  const dropped = new Set<number>();
  const replayed: number[] = [];
  const ring: number[] = [];
  const stats: Stats = { sent: 0, headKept: 0, dropped: 0, bypassed: 0, preRoll: 0 };
  let seenSpeech = false;
  let nonSpeechRunIndex = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const verdict = arm.verdicts.get(index);
    if (verdict === undefined) {
      throw new Error(`no verdict was recorded for grid frame ${index} — the recording is incomplete`);
    }
    const speech = verdict.bypassed || verdict.speech;
    let action: 'send-real' | 'send-head-kept' | 'drop';
    if (speech) {
      seenSpeech = true;
      nonSpeechRunIndex = 0;
      action = 'send-real';
    } else if (!seenSpeech) {
      action = 'drop';
    } else {
      const inHead = nonSpeechRunIndex < aFrames;
      nonSpeechRunIndex += 1;
      action = inHead ? 'send-head-kept' : 'drop';
    }
    if (verdict.bypassed) {
      stats.bypassed += 1;
    }
    if (action === 'drop') {
      stats.dropped += 1;
      dropped.add(index);
      if (P > 0) {
        ring.push(index);
        if (ring.length > P) {
          ring.shift();
        }
      }
    } else {
      if (action === 'send-real' && ring.length > 0) {
        for (const replayedIndex of ring) {
          dropped.delete(replayedIndex);
          replayed.push(replayedIndex);
          stats.dropped -= 1;
          stats.sent += 1;
          stats.preRoll += 1;
        }
      }
      ring.length = 0;
      if (action === 'send-head-kept') {
        stats.headKept += 1;
      }
      stats.sent += 1;
    }
  }
  return { dropped, replayed, stats };
}

/** 推导结果与真门控的累计 stats 逐项相等，否则这份放大镜读的不是它。 */
function checkDerived(label: string, arm: Arm, derived: Derived): void {
  for (const key of ['sent', 'headKept', 'dropped', 'bypassed', 'preRoll'] as const) {
    if (arm.stats[key] !== derived.stats[key]) {
      throw new Error(
        `${label}: the derived ${key}=${derived.stats[key]} disagrees with the gate's ${key}=${arm.stats[key]}; ` +
          'the per-onset lens does not describe this run',
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 起音读数
// ─────────────────────────────────────────────────────────────────────────────

type OnsetReading = {
  offsetS: number;
  frameIndex: number;
  /** Frames dropped immediately before this onset, counting only those above -45 dBFS. */
  loudDroppedMs: number;
  /** All frames dropped immediately before this onset (regardless of level). */
  droppedFrames: number;
  /** Frames the pre-roll replayed at this onset. */
  replayedFrames: number;
};

/** One onset per transition non-speech → speech, with the dropped run that precedes it. */
function readOnsets(arm: Arm, derived: Derived, pcm: Buffer, frameCount: number): OnsetReading[] {
  const speech: boolean[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const verdict = arm.verdicts.get(index);
    speech.push(verdict !== undefined && (verdict.bypassed || verdict.speech));
  }
  const readings: OnsetReading[] = [];
  for (let onset = 0; onset < frameCount; onset += 1) {
    if (!speech[onset] || (onset > 0 && speech[onset - 1])) {
      continue; // not the first frame of an utterance
    }
    let previous = onset - 1;
    while (previous >= 0 && !speech[previous]) {
      previous -= 1; // the run of non-speech frames immediately before this onset
    }
    let loudDroppedMs = 0;
    let droppedFrames = 0;
    let replayedFrames = 0;
    for (let index = previous + 1; index < onset; index += 1) {
      if (derived.dropped.has(index)) {
        droppedFrames += 1;
        if (frameDbfs(pcm, index) > LOUD_DBFS) {
          loudDroppedMs += UPLINK_VAD_FRAME_MS;
        }
      }
    }
    for (const replayedIndex of derived.replayed) {
      if (replayedIndex > previous && replayedIndex < onset) {
        replayedFrames += 1;
      }
    }
    readings.push({ offsetS: (onset * UPLINK_VAD_FRAME_MS) / 1000, frameIndex: onset, loudDroppedMs, droppedFrames, replayedFrames });
  }
  return readings;
}

function summaryLine(label: string, frameCount: number, arm: Arm): string {
  const s = arm.stats;
  return (
    `${label} uplink_vad summary: browserFrames=${frameCount} sent=${s.sent} headKept=${s.headKept} ` +
    `dropped=${s.dropped} bypassed=${s.bypassed} preRoll=${s.preRoll}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

type Args = { wav: string | null; prerollMs: number | null; weightsPath: string | null; allOnsets: boolean; help: boolean };

const USAGE =
  'usage: replay.mts <wav> [--preroll-ms N] [--weights-path <onnx>] [--all-onsets]\n' +
  '  default --preroll-ms = the shipped UPLINK_VAD_PRE_ROLL_MS\n' +
  '  default --weights-path = $VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH';

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { wav: null, prerollMs: null, weightsPath: null, allOnsets: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--all-onsets') {
      args.allOnsets = true;
    } else if (token === '--preroll-ms') {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error('--preroll-ms needs a non-negative integer (milliseconds)');
      }
      args.prerollMs = Number(value);
      index += 1;
    } else if (token.startsWith('--preroll-ms=')) {
      args.prerollMs = Number(token.slice('--preroll-ms='.length));
    } else if (token === '--weights-path') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--weights-path needs a path');
      }
      args.weightsPath = value;
      index += 1;
    } else if (token.startsWith('--weights-path=')) {
      args.weightsPath = token.slice('--weights-path='.length);
    } else if (token.startsWith('--')) {
      throw new Error(`unknown flag: ${token}`);
    } else if (args.wav === null) {
      args.wav = token;
    } else {
      throw new Error(`unexpected extra arg: ${token}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(USAGE);
    return;
  }
  if (args.wav === null) {
    throw new Error(`no wav given\n${USAGE}`);
  }
  const wavPath = args.wav.startsWith('~')
    ? path.join(process.env.HOME ?? '', args.wav.slice(1))
    : args.wav;
  statSync(wavPath); // throws if absent — the criterion forbids substituting synthetic audio

  const weightsPath = args.weightsPath ?? (process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ?? '');
  if (weightsPath === '') {
    throw new Error('no weights path: set VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH or pass --weights-path');
  }
  const testedPrerollMs = args.prerollMs ?? UPLINK_VAD_PRE_ROLL_MS;

  const wav = readWav(wavPath);
  if (wav.sampleRate !== UPLINK_VAD_GRID.sampleRate || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    throw new Error(
      `the recording is ${wav.channels}ch/${wav.sampleRate}Hz/${wav.bitsPerSample}-bit, not the ` +
        `${UPLINK_VAD_GRID.sampleRate}Hz mono PCM16 grid`,
    );
  }
  if (wav.pcm.length % UPLINK_VAD_FRAME_BYTES !== 0) {
    throw new Error(`the recording is ${wav.pcm.length} bytes — not a whole number of ${UPLINK_VAD_FRAME_BYTES}-byte frames`);
  }
  const frameCount = wav.pcm.length / UPLINK_VAD_FRAME_BYTES;
  const frames: string[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    frames.push(wav.pcm.subarray(index * UPLINK_VAD_FRAME_BYTES, (index + 1) * UPLINK_VAD_FRAME_BYTES).toString('base64'));
  }

  log(`voice-uplink-vad-preroll-replay: wav=${wavPath}`);
  log(`  frames=${frameCount} (${(frameCount * UPLINK_VAD_FRAME_MS) / 1000} s)  weights=${weightsPath}`);
  log(`  tested P=${testedPrerollMs} ms (${Math.round(testedPrerollMs / UPLINK_VAD_FRAME_MS)} frames); baseline P=0`);
  log('');

  // BASELINE: the pre-roll off — the reading the criterion reproduces the server's own summary with.
  const baseline = await runArm(frames, weightsPath, 0);
  const baselineDerived = deriveActions(baseline, frameCount);
  checkDerived('baseline', baseline, baselineDerived);

  // THE ARM UNDER TEST: the shipped default (or whatever --preroll-ms asked for).
  const tested = testedPrerollMs === 0 ? baseline : await runArm(frames, weightsPath, testedPrerollMs);
  const testedDerived = testedPrerollMs === 0 ? baselineDerived : deriveActions(tested, frameCount);
  if (tested !== baseline) {
    checkDerived(`P=${testedPrerollMs}`, tested, testedDerived);
  }

  log(summaryLine('[baseline]', frameCount, baseline));
  if (tested !== baseline) {
    log(summaryLine(`[P=${testedPrerollMs}]`, frameCount, tested));
  }
  log('');

  const onsets = readOnsets(tested, testedDerived, wav.pcm, frameCount);
  const baselineOnsets = tested === baseline ? onsets : readOnsets(baseline, baselineDerived, wav.pcm, frameCount);
  const stillClipped = onsets.filter((onset) => onset.loudDroppedMs > UPLINK_VAD_FRAME_MS).length;

  log(
    `onsets: ${onsets.length} (speech starts after a non-speech run); ` +
      `${stillClipped} still have >${UPLINK_VAD_FRAME_MS} ms of >${LOUD_DBFS} dBFS audio dropped before them`,
  );
  log('');

  if (args.allOnsets) {
    log('per-onset table:');
    log('  offset_s   baseline_loud_dropped_ms   tested_loud_dropped_ms   tested_replayed_frames');
    for (let index = 0; index < onsets.length; index += 1) {
      const reading = onsets[index] as OnsetReading;
      const base = baselineOnsets[index];
      log(
        `  ${reading.offsetS.toFixed(2).padStart(8)}   ${String(base?.loudDroppedMs ?? Number.NaN).padStart(22)}   ` +
          `${String(reading.loudDroppedMs).padStart(21)}   ${String(reading.replayedFrames).padStart(22)}`,
      );
    }
    log('');
  }

  log(`the three onsets the 7th live test clipped (baseline P=0 → tested P=${testedPrerollMs}):`);
  for (const offset of NAMED_ONSETS_S) {
    const nearestOf = (list: OnsetReading[]): OnsetReading | null => {
      let nearest: OnsetReading | null = null;
      for (const candidate of list) {
        if (nearest === null || Math.abs(candidate.offsetS - offset) < Math.abs(nearest.offsetS - offset)) {
          nearest = candidate;
        }
      }
      return nearest === null || Math.abs(nearest.offsetS - offset) > 0.05 ? null : nearest;
    };
    const testedOnset = nearestOf(onsets);
    const baselineOnset = nearestOf(baselineOnsets);
    if (testedOnset === null) {
      throw new Error(`no onset found near offset ${offset} s`);
    }
    log(
      `  onset @ ${offset.toFixed(2)} s (frame ${testedOnset.frameIndex}): ` +
        `baseline loud dropped ${baselineOnset?.loudDroppedMs ?? '?'} ms → tested ${testedOnset.loudDroppedMs} ms ` +
        `(${testedOnset.droppedFrames} dropped total, ${testedOnset.replayedFrames} replayed)`,
    );
    // AC5(b) is a statement ABOUT the pre-roll: it only binds when the tested arm actually replays.
    if (tested !== baseline && testedOnset.loudDroppedMs > UPLINK_VAD_FRAME_MS) {
      throw new Error(
        `AC5(b) violated: onset @ ${offset} s still has ${testedOnset.loudDroppedMs} ms of >${LOUD_DBFS} dBFS audio ` +
          `dropped before it (> ${UPLINK_VAD_FRAME_MS} ms)`,
      );
    }
  }
  log('');

  const sentSeconds = (tested.stats.sent * UPLINK_VAD_FRAME_MS) / 1000;
  const baselineSeconds = (baseline.stats.sent * UPLINK_VAD_FRAME_MS) / 1000;
  const addedSeconds = sentSeconds - baselineSeconds;
  const ratio = baselineSeconds === 0 ? 0 : addedSeconds / baselineSeconds;
  log(
    `cost: baseline sent=${baseline.stats.sent} (${baselineSeconds.toFixed(1)} s), ` +
      `P=${testedPrerollMs} sent=${tested.stats.sent} (${sentSeconds.toFixed(1)} s); ` +
      `+${addedSeconds.toFixed(1)} s = +${(ratio * 100).toFixed(1)}%`,
  );
  if (tested !== baseline && ratio > MAX_COST_RATIO) {
    throw new Error(`AC5(b) violated: the pre-roll added ${(ratio * 100).toFixed(1)}% of the sent seconds, over ${MAX_COST_RATIO * 100}%`);
  }
  if (tested === baseline) {
    log('(P=0: the tested arm IS the baseline — AC5(b) onset/cost checks do not apply to this run)');
  }
  log(`voice-uplink-vad-preroll-replay: done (exit 0)`);
}

main().catch((error: unknown) => {
  process.stderr.write(`voice-uplink-vad-preroll-replay: FAILED — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
