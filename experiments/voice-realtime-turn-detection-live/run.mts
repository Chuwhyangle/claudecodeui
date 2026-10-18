/**
 * 断句窗口在**本会话真实音频**上的对照：`silence_duration_ms` 4 档，同一段 mic 音频，真上游。
 *
 * WHY. 人 yale 2026-10-15 的现场抱怨是「Live Voice 还是断句太快，半句话就被发出去一次 response」。
 * 这一场（连接 `7c01be7e`，会话 `3c308639`）的 journal 把抱怨量到了毫秒：44.45 s 的连续说话被上游切成
 * **15 个 turn**，产生 11 次 response、其中 5 次被 `turn_detected` 取消。而 `turn_detection` 的
 * `silence_duration_ms` 出货值是 **400 ms**（平台自己的文档默认是 800），此前只在**一段 15.7 s 的
 * 合成片段**上比过（`experiments/voice-realtime-turn-detection/RESULT.json`），当时的结论写明了复验
 * 条件：「≥3 connections per arm, ≥2 clips」。本脚本就是拿**第二段语料——一段真实的、当场被抱怨的
 * 44 秒**，在**出货形状**上复验这一条。
 *
 * WHAT IS FIXED AND WHAT VARIES. 每条臂只动一个变量：`turn_detection.silence_duration_ms`（以及它
 * 派生出的上行门控尾部窗 `a`，见下）。instructions / tools / `respondToToolOutputs` / voice / 音频
 * 全部是出货形状并且**臂间逐字节相同**——所以臂间差异只能来自断句窗口。
 *
 * WHY THE GATE'S WINDOW MOVES WITH THE ARM (and why that is not a second variable). 生产链路上，
 * silero 上行门控的头部保留窗 `a` 是**从 `silence_duration_ms` 派生**的
 * （`uplinkHeadKeepFrames` = `silence + 200 ms` 再取整到帧）。所以「把断句窗口调到 800」在生产里
 * 必然同时把 `a` 抬到 1000 ms——这正是被抱怨的那条链路的真实形态，探针里必须**同样耦合**，否则
 * 测到的是一条不存在的配置。
 *
 * WHY THE RELAXED `session_send` DESCRIPTOR. 出货 descriptor 把 `session` 声明为 REQUIRED，而出货
 * instructions 明确告诉模型「The session is fixed by the connection; never name one」；探针用的
 * transport 会在转发前校验参数形状，于是**出货那一对会把模型真正发出的调用扣住**——那样就测不到
 * 覆盖率和交付延迟。所以像 `voice-realtime-closing-turn/run.mts` 的 S 臂一样，这里广播 instructions
 * 自己描述的那个形状（`{ message }`）。工具名不变，trace 按名字读。
 *
 * WHAT IS READ (per arm). commits（症状本身）/ 被切碎后的转写序列 / 空转写 / response 数 / 花费 /
 * `speech_stopped` → 模型交出 `session_send` 的延迟（这就是「更长的窗口要付的代价」）/ 对**现场那三条
 * 已交付文本**的片段覆盖率（丢词读数）。
 *
 * THE CONTROL IS FREE. 本场**生产 400 ms 的现场读数**已经在盘上：连接 `7c01be7e` 的
 * `…timeline.jsonl` 记着上游自己的 15 次 `speech_started`/`speech_stopped`/`committed` 及其偏移
 * （0.733 s → 44.453 s），journal 记着 11 次 response 与 ¥0.0256 的总花费。`s400` 这条臂要能把它
 * **复现**出来，否则本次回放本身不可信——这是本实验的自检项。
 *
 * Run (from the repo root, on a machine with egress and a live key):
 *
 *     set -a; . ./.env.test; set +a
 *     PROBE_BUDGET_CNY=0.5 npx tsx --tsconfig server/tsconfig.json \
 *       experiments/voice-realtime-turn-detection-live/run.mts --arms s400,s800 --reps 1
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const BUDGET_CNY = Number(process.env.PROBE_BUDGET_CNY ?? 0.5);
/** How long the socket stays open after the last audio frame, so the final turn can close and be answered. */
const DRAIN_MS = 12_000;
const UPLINK_VAD_WEIGHTS =
  process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ?? path.join(HOME, 'work/voice-vad-engines/silero/silero_vad.onnx');

/** The connection whose mic audio this experiment replays — the session yale complained from. */
const CAPTURE = '7c01be7e';
/**
 * The window, in the capture's own clock. 0 → 48 s covers every speech segment (the endpoint's own
 * timeline puts the first at 0.733 s and the last at 44.453 s) plus ~3.5 s of the REAL trailing
 * silence the room actually had — not digital padding, because the 2026-10-14 measurement showed zero
 * padding closes a turn far worse than real silence (`UPLINK_VAD_TAIL_MARGIN_MS`).
 */
const WINDOW = { startMs: 0, endMs: 48_000 };

/**
 * The THREE messages the live session actually delivered (journal `kind=session_send`), verbatim.
 *
 * It is the relay model's REPAIRED text, not a human transcript, so fragment coverage against it is a
 * DIRECTIONAL reading and is reported as one: a fragment the repair rewrote can look "uncovered" to a
 * raw upstream transcript. The live arm's own coverage is computed by the same rule, so the comparison
 * between arms stays like-for-like.
 */
const LIVE_DELIVERED = [
  '因此，Live Voice 使用过程当中啊，我发现还是会有这么一个问题。在这个会话中，我们马上也会碰到。',
  '就是现在的 Live Voice 还是会比较快地去断句，去发这些消息，发 response。就是现在的 Live Voice 还是会比较快的去断句，去发这些消息，发 response。但实际上就像现在这个会话一样，可能前后的间隔并不是那么大。呃，当然。这里面会有矛盾，我们希望。要尽可能敏感。',
  '当然这里面会有个矛盾，我们希望它尽可能的敏感，尽可能的灵敏，然后更快的有输出。但另外一方面，我们又不希望它过快的把消息发出去。请进一步的量化的进行分析，然后来实验找出可能的更好的方案。',
];
void LIVE_DELIVERED;
/**
 * What production's own 400 ms window did on this exact audio — the free control (see the file header).
 * `commits` / `speechStopped` come from the capture's `timeline.jsonl`; the rest from the journal.
 */
const LIVE_BASELINE = { silenceMs: 400, speechStopped: 15, commits: 15, responses: 11, cancelled: 5, spendCny: 0.025593 };

type Arm = 's400' | 's600' | 's800' | 's1000' | 's1200';

/** The one variable each arm sets: the upstream silence window, and the gate window it derives. */
const ARM_SILENCE_MS: Record<Arm, number> = { s400: 400, s600: 600, s800: 800, s1000: 1_000, s1200: 1_200 };

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

const capturePath = (prefix: string, ext: string, dir = CAPTURE_DIR): string => {
  const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(ext));
  if (name === undefined) throw new Error(`no ${ext} for ${prefix} in ${dir}`);
  return path.join(dir, name);
};

/** The WAV's PCM payload, refusing anything that is not the 16 kHz mono the endpoint is fed. */
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

/** The reference fragments coverage is scored against: the delivered text, split at punctuation. */
const REFERENCE_FRAGMENTS = LIVE_DELIVERED.join('')
  .split(/[…，。！？、,.!?]/)
  .filter((piece) => piece.trim() !== '');

const runOne = async (
  run: ReturnType<typeof createRun>,
  arm: Arm,
  rep: number,
): Promise<Record<string, unknown>> => {
  const silenceMs = ARM_SILENCE_MS[arm];
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  // The `a` window FOLLOWS the arm, exactly as `voice-realtime-ws-proxy.service.ts` derives it in
  // production — see the file header on why that is the shipped coupling, not a second variable.
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: silenceMs });
  const SHIPPED_INTERRUPT = VOICE_REALTIME_TOOLS.find((t) => t.name === 'session_interrupt')!;

  let session: P0Session | null = null;
  session = await openSession({
    run,
    label: `${arm}-${rep}`,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    sessionDefaults: sessionBody({
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: silenceMs },
    }),
    // The relaxed descriptor + the shipped `session_interrupt`, i.e. the shipped tool SET with the
    // shape the instructions describe (see the file header).
    tools: [SESSION_SEND_TOOL, SHIPPED_INTERRUPT] as never,
    respondToToolOutputs: true,
    executor: {
      session_send: () => ({
        accepted: true,
        instruction:
          'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
      }),
      session_interrupt: (args: Record<string, unknown>) => ({
        aborted: true,
        message: args.message,
        runId: 'replay-run',
        triggerSeq: null,
        queuedStillPending: 0,
      }),
    },
  });
  const s = session;

  const pcm = wavPcm(capturePath(CAPTURE, '.wav'));
  const span = pcm.subarray(Math.floor(WINDOW.startMs * 32), Math.floor(WINDOW.endMs * 32));
  const frames: string[] = [];
  for (let off = 0; off + 640 <= span.length; off += 640) frames.push(span.subarray(off, off + 640).toString('base64'));

  const t0 = Date.now();
  const timeline: Array<Record<string, unknown>> = [];
  const seenCalls = new Set<string>();
  let cursor = 0;
  let lastSpeechStoppedAt: number | null = null;
  /** `speech_stopped` → the `session_send` that carried it: the cost the longer window pays. */
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
        try {
          message = (JSON.parse(String(item.arguments)) as { message?: unknown }).message;
        } catch {
          // a truncated call keeps its raw text — that is the reading
        }
        if (item.name === 'session_send' && lastSpeechStoppedAt !== null) {
          sendLatencies.push(at - lastSpeechStoppedAt);
          lastSpeechStoppedAt = null;
        }
        timeline.push({ at, kind: 'CALL', tool: item.name, message });
      } else if (type === 'response.text.done') {
        timeline.push({ at, kind: 'TEXT', text: wire.text });
      } else if (type === 'response.done') {
        const r = (wire.response ?? {}) as { status?: string; status_details?: unknown };
        timeline.push({ at, kind: 'DONE', status: r.status, details: r.status_details ?? null });
      } else if (type === 'error') {
        timeline.push({ at, kind: 'ERROR', error: JSON.stringify(wire.error ?? wire).slice(0, 300) });
      }
    }
    cursor = s.events.length;
  };

  let driftMs = 0;
  let abortedAt: string | null = null;
  try {
    for (let i = 0; i < frames.length; i++) {
      const decision = await gate.observe(frames[i]!);
      for (const f of decision.frames) s.sendAudioBase64(f);
      if (decision.closeTurn) s.sendRaw({ type: 'input_audio_buffer.commit' });
      absorb();
      const wait = t0 + (i + 1) * 20 - Date.now();
      if (wait > 0) await sleep(wait);
      else driftMs = Math.max(driftMs, -wait);
    }
    const drainUntil = Date.now() + DRAIN_MS;
    while (Date.now() < drainUntil) {
      absorb();
      await sleep(50);
    }
  } catch (error) {
    // A cut run is still a reading up to the cut — the guard may close the socket mid-stream.
    abortedAt = `${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(error)}`;
  }
  absorb();
  await gate.close().catch(() => undefined);
  await s.close().catch(() => undefined);

  const asr = timeline.filter((e) => e.kind === 'ASR').map((e) => String(e.text ?? ''));
  const joined = asr.join('');
  const covered = REFERENCE_FRAGMENTS.filter((fragment) => joined.includes(fragment));
  const responses = s.responses.map(
    (r) =>
      (r.usage ?? {}) as {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { audio_tokens?: number; text_tokens?: number };
      },
  );
  return {
    arm,
    silenceMs,
    rep,
    gateAFrames: gate.aFrames,
    sessionId: s.sessionId,
    spendCny: Number(s.spendCny.toFixed(6)),
    speechStarted: timeline.filter((e) => e.kind === 'STOP').length,
    commits: timeline.filter((e) => e.kind === 'COMMIT').length,
    responses: responses.length,
    cancelled: timeline.filter((e) => e.kind === 'DONE' && e.status === 'cancelled').length,
    textReplies: timeline.filter((e) => e.kind === 'TEXT').length,
    transcripts: asr,
    emptyTranscriptions: asr.filter((t) => t.trim() === '').length,
    joinedChars: joined.length,
    fragmentsCovered: covered.length,
    fragmentsTotal: REFERENCE_FRAGMENTS.length,
    sendCalls: timeline.filter((e) => e.kind === 'CALL' && e.tool === 'session_send').length,
    sendLatencies,
    inputTokens: responses.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0),
    outputTokens: responses.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0),
    inputs: responses.map((u) => [
      u.input_tokens_details?.text_tokens ?? 0,
      u.input_tokens_details?.audio_tokens ?? 0,
      u.output_tokens ?? 0,
    ]),
    abortedAt,
    driftMs,
    errors: s.errors.map((e) => JSON.stringify(e.wire).slice(0, 200)),
    timeline,
  };
};

const main = async (): Promise<void> => {
  const arms = arg('arms', 's400,s800').split(',').filter((a) => a !== '') as Arm[];
  const reps = Number(arg('reps', '1'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · capture ${CAPTURE} · window ${WINDOW.startMs}-${WINDOW.endMs}ms · arms ${arms.join(',')} · reps ${reps}`);
  const results: Array<Record<string, unknown>> = [];
  // SEQUENTIAL, unlike the closing-turn harness's parallel fan-out: the budget guard is a RUN-WIDE
  // accumulator, and four sockets opened at once would cross it together with no reading of what the
  // first arm alone cost.
  for (let rep = 0; rep < reps; rep++) {
    for (const arm of arms) {
      if (run.guardTriggered) {
        results.push({ arm, rep, skipped: 'budget guard already tripped' });
        continue;
      }
      const record = await runOne(run, arm, rep).catch((error: unknown) => ({ arm, rep, error: String(error) }));
      results.push(record);
      const r = record as { commits?: number; spendCny?: number };
      console.log(
        `  ${arm} rep${rep}: commits=${r.commits ?? '?'} spend=¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} guard=${run.guardTriggered}`,
      );
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const file = path.join(HERE, 'traces', `run-${stamp}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        capture: CAPTURE,
        window: WINDOW,
        budgetCny: BUDGET_CNY,
        spendCny: Number(run.spendCny.toFixed(6)),
        guardTriggered: run.guardTriggered,
        liveBaseline: LIVE_BASELINE,
        referenceFragments: REFERENCE_FRAGMENTS,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`spend ¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} · guard=${run.guardTriggered}`);
  console.log(`trace: ${file}`);
  process.exit(0);
};

void main();
