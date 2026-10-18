/**
 * X4'''：碎片判定的四条臂 × 三段音频 × 6 次（2026-10-15）。
 *
 * 计划与判据：本目录 `PLAN.md`（两个上限：¥0.5 / 10 min）。读数口径与上一支探针的教训：
 * 调用必须拆成【有效投递 / 原始JSON(被取消截断) / 空】三栏，**只有第一栏算投递**。
 *
 * 臂（每次只动一个变量）：
 *   s400       出货形状：ship 指令 + server_vad 400 ms（对照；自检项 = 7c01be7e 上复现现场 15 turn / 3 交付）
 *   s800       同 s400，窗口 400→800（C'：探针里唯一单调效应）
 *   verdict    s400 + `session_send` 加【必填】`part: continues|completes`，指令要求**每一段转写都调用**；
 *              中继侧按 `continues` 攒、`completes` 时**逐字**（不插字）合并投递（探针里的结构性路线）
 *   verdict800 verdict + 窗口 800（叠加：若窗口已够，这一臂能省掉整个代码改动）
 *
 * 窗口：三段各取 24 s（而不是 48 s）——同预算下把重复从 2 次买到 6 次，见 PLAN.md §2。
 *
 * Run:
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-fragment-hold-probe/frag2.mts \
 *     --arms s400,s800,verdict,verdict800 --reps 6 --parallel 6
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  SESSION_SEND_TOOL,
  createRun,
  openSession,
  readApiKey,
  sleep,
  sessionBody,
  type P0Session,
} from '../voice-realtime-segmented/p0/probe-lib.mts';
import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CAPTURE_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-capture');
const BUDGET_CNY = Number(process.env.PROBE_BUDGET_CNY ?? 0.4);
const DRAIN_MS = 12_000;
/** 停止派新 job 的墙钟（留出在飞的 6 个跑完的余量；总墙钟硬上限 = 10 min）。 */
const SCHEDULE_UNTIL_MS = Number(process.env.PROBE_SCHEDULE_MS ?? 510_000);
const UPLINK_VAD_WEIGHTS =
  process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ?? path.join(HOME, 'work/voice-vad-engines/silero/silero_vad.onnx');

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

/** 三段：指令代次 2341、有音频、碎片比高（PLAN.md §1）。窗口由 capture 的 speech_stopped 偏移选（24 s 内 stop 最多）。 */
const SEGMENTS = [
  /** 整句窗（2026-10-15 修正）：窗口末端 = 窗内最后一个 speech_stopped + 3 s，即**含句尾与尾随静音**——
   *  这是 800 ms 臂的释放点能落在窗内的前提（固定 24 s 切片会把释放点切在外面，读数退化成 0）。
   *  `7c01be7e` 故意用与 `../voice-realtime-turn-detection-live` 相同的 0–48 s，好与该实验盘上的 48 s 读数对照。 */
  { id: '7c01be7e', startMs: 0, endMs: 48_000, stops: 15, trailingMs: 3_547, sessionStops: 15, sessionDeliveries: 3 },
  { id: 'a175e6cd', startMs: 70_518, endMs: 102_835, stops: 8, trailingMs: 3_000, sessionStops: 28, sessionDeliveries: 8 },
  { id: '86559798', startMs: 218_738, endMs: 257_257, stops: 6, trailingMs: 3_000, sessionStops: 21, sessionDeliveries: 11 },
] as const;

type Arm = 's400' | 's800' | 'verdict' | 'verdict800';
const ARM_SILENCE_MS: Record<Arm, number> = { s400: 400, s800: 800, verdict: 400, verdict800: 800 };
const isVerdict = (arm: Arm): boolean => arm === 'verdict' || arm === 'verdict800';

/** 结构性臂的指令 = 出货文本 + 一段"每段都要调用并给 part"的要求（只加这一处）。 */
const VERDICT_RULES = [
  'Call `session_send` for EVERY transcription you receive, without exception, with two arguments:',
  '`message` — what the person said, in their own words, joined if the piece continues an unfinished',
  'thought; and `part` — `continues` while they are still in the middle of that thought, `completes`',
  'when the thought is finished. A fragment of a sentence still being spoken takes `part: continues`;',
  'the piece that ends the thought takes `part: completes`. Never omit a call, and never guess at',
  'words you did not hear.',
].join(' ');
const VERDICT_INSTRUCTIONS = `${VOICE_REALTIME_INSTRUCTIONS} ${VERDICT_RULES}`;

/** `session_send` 的结构性形态：`message` 之外多一个**必填**的 `part`。 */
const SESSION_SEND_WITH_PART = {
  name: 'session_send',
  description: 'Send a message to the Claude Code session, marking whether the thought continues.',
  inputSchema: { message: z.string(), part: z.enum(['continues', 'completes']) },
} as unknown as typeof SESSION_SEND_TOOL;

/** 封顶：攒够 4 段或首段起 3 s ⇒ 强制投递（生产里由中继执行；这里记录它是否会被触发）。 */
const HOLD_CAP_PIECES = 4;
const HOLD_CAP_MS = 3_000;

const capturePath = (prefix: string, ext: string): string => {
  const name = readdirSync(CAPTURE_DIR).find((f) => f.startsWith(prefix) && f.endsWith(ext));
  if (name === undefined) throw new Error(`no ${ext} for ${prefix}`);
  return path.join(CAPTURE_DIR, name);
};

const wavPcm = (file: string): Buffer => {
  const buf = readFileSync(file);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && (buf.readUInt32LE(offset + 12) !== 16_000 || buf.readUInt16LE(offset + 10) !== 1)) {
      throw new Error(`${file} is not 16 kHz mono`);
    }
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
};

const runOne = async (
  run: ReturnType<typeof createRun>,
  seg: (typeof SEGMENTS)[number],
  arm: Arm,
  rep: number,
): Promise<Record<string, unknown>> => {
  const silenceMs = ARM_SILENCE_MS[arm];
  const verdict = isVerdict(arm);
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: silenceMs });
  const SHIPPED_INTERRUPT = VOICE_REALTIME_TOOLS.find((t) => t.name === 'session_interrupt')!;

  // 结构性臂的中继侧合并（逐字、不插字、带封顶）——生产里这段属于 `pendingParts`。
  const heldPieces: string[] = [];
  let heldSince: number | null = null;
  const deliveries: string[] = [];
  const forcedDeliveries: string[] = [];
  const partLedger: Array<{ at: number; part: string; chars: number }> = [];

  let session: P0Session | null = null;
  session = await openSession({
    run,
    label: `${seg.id}-${arm}-${rep}`,
    instructions: verdict ? VERDICT_INSTRUCTIONS : VOICE_REALTIME_INSTRUCTIONS,
    sessionDefaults: sessionBody({
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: silenceMs },
    }),
    tools: (verdict ? [SESSION_SEND_WITH_PART, SHIPPED_INTERRUPT] : [SESSION_SEND_TOOL, SHIPPED_INTERRUPT]) as never,
    respondToToolOutputs: true,
    executor: {
      session_send: (args: Record<string, unknown>) => {
        if (!verdict) {
          return {
            accepted: true,
            instruction:
              'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
          };
        }
        const message = String(args.message ?? '');
        const part = String(args.part ?? '');
        partLedger.push({ at: Date.now(), part, chars: message.length });
        const empty = message.trim() === '';
        if (empty) {
          return { accepted: true, instruction: 'That piece carried no words. Do not call again for it. Reply with the single word OK.' };
        }
        if (part === 'continues') {
          if (heldPieces.length === 0) heldSince = Date.now();
          heldPieces.push(message);
          const tooMany = heldPieces.length >= HOLD_CAP_PIECES;
          const tooLong = heldSince !== null && Date.now() - heldSince >= HOLD_CAP_MS;
          if (tooMany || tooLong) {
            const merged = heldPieces.join('');
            deliveries.push(merged);
            forcedDeliveries.push(tooMany ? 'pieces-cap' : 'time-cap');
            heldPieces.length = 0;
            heldSince = null;
            return {
              accepted: true,
              instruction:
                'The whole message was accepted and will reach the session (your hold hit its limit, so it goes now). Reply with the single word OK.',
            };
          }
          return { accepted: true, instruction: 'Held. Do not call again for this piece. Reply with the single word OK.' };
        }
        const merged = [...heldPieces, message].join('');
        deliveries.push(merged);
        heldPieces.length = 0;
        heldSince = null;
        return {
          accepted: true,
          instruction:
            'The whole message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
        };
      },
      session_interrupt: (args: Record<string, unknown>) => ({
        aborted: true,
        message: args.message,
        runId: 'replay-run',
        triggerSeq: null,
        queuedStillPending: 0,
      }),
    } as never,
  });
  const s = session;

  const pcm = wavPcm(capturePath(seg.id, '.wav'));
  const span = pcm.subarray(Math.floor((seg.startMs / 1000) * 32_000), Math.floor((seg.endMs / 1000) * 32_000));
  const frames: string[] = [];
  for (let off = 0; off + 640 <= span.length; off += 640) frames.push(span.subarray(off, off + 640).toString('base64'));

  const t0 = Date.now();
  const timeline: Array<Record<string, unknown>> = [];
  const seenCalls = new Set<string>();
  let cursor = 0;
  let lastSpeechStoppedAt: number | null = null;
  const sendLatencies: number[] = [];

  const absorb = (): void => {
    for (const event of s.events.slice(cursor)) {
      const wire = event.wire as Record<string, unknown>;
      const type = String(wire.type ?? '');
      const at = event.atMs - t0;
      if (event.direction === 'sent') continue;
      if (type === 'input_audio_buffer.speech_started') gate.noteUpstreamTurn(true);
      if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') {
        gate.noteUpstreamTurn(false);
        if (type === 'input_audio_buffer.speech_stopped') {
          lastSpeechStoppedAt = at;
          timeline.push({ at, kind: 'STOP' });
        } else {
          timeline.push({ at, kind: 'COMMIT' });
        }
      }
      if (type === 'conversation.item.input_audio_transcription.completed') {
        timeline.push({ at, kind: 'ASR', text: String(wire.transcript ?? '') });
      } else if (type === 'response.created') {
        timeline.push({ at, kind: 'RESP' });
      } else if (
        type === 'response.function_call_arguments.done' ||
        (type === 'response.output_item.done' && (wire.item as { type?: string })?.type === 'function_call')
      ) {
        const item = (type === 'response.output_item.done' ? wire.item : wire) as {
          call_id?: string;
          name?: string;
          arguments?: string;
        };
        const id = String(item.call_id ?? '');
        if (id === '' || seenCalls.has(id)) continue;
        seenCalls.add(id);
        let message: unknown = item.arguments;
        let part: unknown = null;
        try {
          const parsed = JSON.parse(String(item.arguments)) as { message?: unknown; part?: unknown };
          message = parsed.message;
          part = parsed.part ?? null;
        } catch {
          // truncated call keeps its raw text — that is the reading
        }
        if (item.name === 'session_send' && lastSpeechStoppedAt !== null) {
          sendLatencies.push(at - lastSpeechStoppedAt);
          lastSpeechStoppedAt = null;
        }
        timeline.push({ at, kind: 'CALL', tool: item.name, message, part });
      } else if (type === 'response.text.done') {
        timeline.push({ at, kind: 'TEXT', text: wire.text });
      } else if (type === 'response.done') {
        const r = (wire.response ?? {}) as { status?: string };
        timeline.push({ at, kind: 'DONE', status: r.status });
      } else if (type === 'error') {
        timeline.push({ at, kind: 'ERROR', error: JSON.stringify(wire.error ?? wire).slice(0, 300) });
      }
    }
    cursor = s.events.length;
  };

  let abortedAt: string | null = null;
  try {
    for (let i = 0; i < frames.length; i++) {
      const decision = await gate.observe(frames[i]!);
      for (const f of decision.frames) s.sendAudioBase64(f);
      if (decision.closeTurn) s.sendRaw({ type: 'input_audio_buffer.commit' });
      absorb();
      const wait = t0 + (i + 1) * 20 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const drainUntil = Date.now() + DRAIN_MS;
    while (Date.now() < drainUntil) {
      absorb();
      await sleep(50);
    }
  } catch (error) {
    abortedAt = `${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(error)}`;
  }
  absorb();
  await gate.close().catch(() => undefined);
  await s.close().catch(() => undefined);

  // ── 三栏读数（探针的教训：调用数会把噪声读成信号） ────────────────────────────────
  const calls = timeline.filter((e) => e.kind === 'CALL' && e.tool === 'session_send');
  const rawCalls = calls.filter((c) => typeof c.message === 'string' && String(c.message).trimStart().startsWith('{"message"'));
  const emptyCalls = calls.filter((c) => typeof c.message !== 'string' || String(c.message).trim() === '');
  const emptyButVerdict = calls.filter((c) => typeof c.message !== 'string' && typeof c.part === 'string');
  const effective = calls.filter((c) => c.message !== undefined && String(c.message).trim() !== '' && !rawCalls.includes(c));
  const asr = timeline.filter((e) => e.kind === 'ASR').map((e) => String(e.text ?? ''));
  const verdictCalls = calls.filter((c) => typeof c.part === 'string' && (c.part === 'continues' || c.part === 'completes'));
  const stops = timeline.filter((e) => e.kind === 'STOP').length;

  return {
    segment: seg.id,
    arm,
    rep,
    silenceMs,
    verdict,
    sessionId: s.sessionId,
    spendCny: Number(s.spendCny.toFixed(6)),
    wallMs: Date.now() - t0,
    upstreamStops: stops,
    commits: timeline.filter((e) => e.kind === 'COMMIT').length,
    responses: timeline.filter((e) => e.kind === 'RESP').length,
    cancelled: timeline.filter((e) => e.kind === 'DONE' && e.status === 'cancelled').length,
    textReplies: timeline.filter((e) => e.kind === 'TEXT').length,
    callsTotal: calls.length,
    callsRaw: rawCalls.length,
    callsEmpty: emptyCalls.length,
    callsEffective: effective.length,
    /** 有效投递 ÷ 上游 turn：这就是"碎片比"（越低越好；出货形态在 7c01be7e 上约 0.4）。 */
    effectivePerStop: stops > 0 ? Number((effective.length / stops).toFixed(3)) : null,
    /** C' 的兑现读数：**最后一个上游 speech_stopped → 最后一次有效投递**的间隔（"攒到句尾"要付多久）。 */
    lastStopToRelayMs: ((): number | null => {
      const lastStop = timeline.filter((e) => e.kind === 'STOP').at(-1);
      const lastRelay = effective.at(-1);
      if (lastStop === undefined || lastRelay === undefined) return null;
      return Number(lastRelay.at) - Number(lastStop.at);
    })(),
    /** 最后一段非空转写 → 投递：内容被听到之后多久出去。 */
    lastAsrToRelayMs: ((): number | null => {
      const lastAsr = timeline.filter((e) => e.kind === 'ASR' && String(e.text ?? '').trim() !== '').at(-1);
      const lastRelay = effective.at(-1);
      if (lastAsr === undefined || lastRelay === undefined) return null;
      return Number(lastRelay.at) - Number(lastAsr.at);
    })(),
    deliveries: deliveries.length,
    deliveriesForced: forcedDeliveries.length,
    forcedReasons: forcedDeliveries,
    partFillRate: calls.length > 0 ? Number(((verdictCalls.length + emptyButVerdict.length) / calls.length).toFixed(3)) : null,
    completes: verdictCalls.filter((c) => c.part === 'completes').length,
    continues: verdictCalls.filter((c) => c.part === 'continues').length,
    mergedChars: deliveries.map((d) => d.length),
    /** 逐字保真的可机械读法：交付文本必须**包含**它那几段的原文（拼接无插字）。中继自己拼的，所以按构造为真——
     *  真正的风险在下面这一栏。 */
    deliveryCharsTotal: deliveries.reduce((a, d) => a + d.length, 0),
    /** ⚠️ 憋死读数：运行结束时**还攒在手里、没等到 `completes`** 的段数（结构性路线最危险的失效形态）。 */
    strandedPieces: heldPieces.length,
    strandedChars: heldPieces.join('').length,
    sendLatencies,
    transcripts: asr,
    emptyTranscriptions: asr.filter((t) => t.trim() === '').length,
    joinedChars: asr.join('').length,
    abortedAt,
    errors: s.errors.map((e) => JSON.stringify(e.wire).slice(0, 200)),
    timeline,
  };
};

const main = async (): Promise<void> => {
  const arms = arg('arms', 's400,s800,verdict,verdict800').split(',').filter((a) => a !== '') as Arm[];
  const reps = Number(arg('reps', '6'));
  const parallel = Math.min(6, Number(arg('parallel', '6')));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  const started = Date.now();
  console.log(
    `budget ¥${BUDGET_CNY} · segments ${SEGMENTS.map((s) => s.id).join(',')} · arms ${arms.join(',')} · reps ${reps} · parallel ${parallel} · schedule ${SCHEDULE_UNTIL_MS / 1000}s`,
  );

  const jobs: Array<{ seg: (typeof SEGMENTS)[number]; arm: Arm; rep: number }> = [];
  for (let rep = 0; rep < reps; rep++) for (const arm of arms) for (const seg of SEGMENTS) jobs.push({ seg, arm, rep });

  const results: Array<Record<string, unknown>> = [];
  let next = 0;
  let stopped = '';
  const worker = async (): Promise<void> => {
    for (;;) {
      if (run.guardTriggered) { stopped ||= 'budget guard tripped'; return; }
      if (Date.now() - started > SCHEDULE_UNTIL_MS) { stopped ||= `schedule cutoff ${SCHEDULE_UNTIL_MS / 1000}s`; return; }
      const job = jobs[next++];
      if (job === undefined) return;
      const record = await runOne(run, job.seg, job.arm, job.rep).catch((error: unknown) => ({
        segment: job.seg.id, arm: job.arm, rep: job.rep, error: String(error).slice(0, 300),
      }));
      results.push(record);
      const r = record as { upstreamStops?: number; callsEffective?: number; deliveries?: number; spendCny?: number; wallMs?: number };
      console.log(
        `[${((Date.now() - started) / 1000).toFixed(0)}s] ${job.seg.id} ${job.arm} r${job.rep}: stops=${r.upstreamStops ?? '?'} 有效=${r.callsEffective ?? '?'} 交付=${r.deliveries ?? '?'} ¥${run.spendCny.toFixed(4)}/${BUDGET_CNY}${run.guardTriggered ? ' GUARD' : ''}`,
      );
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const file = path.join(HERE, 'traces', `frag2-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        ranAt: stamp,
        budgetCny: BUDGET_CNY,
        scheduleUntilMs: SCHEDULE_UNTIL_MS,
        segments: SEGMENTS,
        arms,
        reps,
        parallel,
        stopped,
        spendCny: Number(run.spendCny.toFixed(6)),
        guardTriggered: run.guardTriggered,
        wallMs: Date.now() - started,
        completed: results.filter((r) => !('error' in r)).length,
        failed: results.filter((r) => 'error' in r).length,
        results,
      },
      null,
      1,
    ),
  );
  console.log(`done: ${results.filter((r) => !('error' in r)).length}/${jobs.length} 次 · ¥${run.spendCny.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s ${stopped ? `· stopped: ${stopped}` : ''}`);
  console.log(`trace: ${file}`);
  process.exit(0);
};

void main();
