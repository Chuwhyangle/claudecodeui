/**
 * 碎片检查该由 realtime 模型做吗？—— A/B 一段探针（2026-10-15）。
 *
 * WHY. X3' 回放实验（`experiments/voice-now-priority/REPORT.md`）把「忙时语音被切成碎片逐条转发」量出来了：
 * 片段 `164c3087@10-14T15:16:43` 里，模型对同一段话**各调了 9 次 `session_send`**（8 段半句 + 1 段完整），
 * 而中继把它们**逐字合并成 1 条**投递给 Claude（journal `kind=session_send` 那条记录就是拼接结果）。
 * ⇒ 碎片问题在**模型→中继**这一层；中继侧的合并已经是对的（逐字、不丢字）。
 *
 * 于是问题变成：**能不能让 realtime 模型自己判"这句说完了没有"，从而不再逐段调用？**
 * 现行 instructions 里已经有「join the fragments of one sentence」，但同一段文本里还有一句绝对的
 * 「There is no case in which you call no function: …」。在"每段转写各触发一次"的流程里，要 join 就必须
 * 对前几段**不调用**——被这句话禁止。本探针只改这一处：把绝对句收窄成"碎片不是已经说出口的话，先攒着，
 * 想清楚了再一次发出；不确定就立刻发"。
 *
 * WHAT VARIES (ONE variable). 只有 `instructions`：`cur` = 出货文本逐字（`VOICE_REALTIME_INSTRUCTIONS`）；
 * `scoped` = 出货文本 + 上面那一处收窄。音频 / 窗口 / 上游 `server_vad` 400 ms / tools / executor /
 * `respondToToolOutputs` 全部**逐字节相同**，所以臂间差异只能来自那句措辞。
 *
 * WHAT IS READ. 模型侧 `session_send` 调用数（症状本身）、转写片段对**现场已交付三条**的覆盖率（漏句读数）、
 * `speech_stopped → session_send` 延迟（"攒着"的代价）、空转写、花费。
 *
 * THE CONTROL IS FREE. 同音频、同窗口、出货 400 ms 的**现场读数**在盘上：`7c01be7e` 的 journal 记着
 * 3 条交付文本、15 次上游 turn；`experiments/voice-realtime-turn-detection-live` 的 s400 臂（今天）记着
 * commits=15、sendCalls=6/9。`cur` 臂要能落在这个区间里，否则本次回放不可信。
 *
 * PROVENANCE. 本文件派生自 `experiments/voice-realtime-turn-detection-live/run.mts`（同一套回放机制、
 * 同一段 capture、同一个窗口），**只改了臂的维度**（断句窗口 → instructions）。断句窗口那一支的读数
 * 已经在那支实验的 traces 里（s400…s1200：commits 15→1、sendCalls 6–9→1），本次不再重复跑。
 *
 * Run (from the repo root, on a machine with egress and a live key):
 *
 *     set -a; . ./.env.test; set +a
 *     PROBE_BUDGET_CNY=0.2 npx tsx --tsconfig=server/tsconfig.json \
 *       experiments/voice-realtime-fragment-hold-probe/run.mts --arms cur,scoped --reps 2
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

type Arm = 'cur' | 'scoped';

/** The shipped upstream window, PINNED: this probe varies the instructions, not the segmentation. */
const SHIPPED_SILENCE_MS = 400;

/**
 * The ONE variable. `cur` is the shipped text verbatim (imported, not retyped), so it is byte-identical
 * to production; `scoped` differs only in the sentences that forbid ever declining to call.
 */
const SCOPED_TAIL = [
  'A fragment of a sentence the person is still in the middle of is not yet something they said: hold',
  'it instead of calling the function for it, and call `session_send` once when they have finished the',
  'thought, with the whole thing joined in their own words. Holding is not deciding what to pass on —',
  'every word still goes, in one stroke instead of eight — so this is the ONE case in which you call',
  'the function later rather than at once. If it is not clear whether they have finished, do not wait:',
  'send what you have. Apart from this one case, the only choice you make is HOW it is delivered, never whether.',
].join(' ');
const ABSOLUTE_CLAUSE =
  'There is no case in which you call no function: deciding that something does not need to be passed on is never your call. The only choice you make is HOW it is delivered, never whether.';
if (!VOICE_REALTIME_INSTRUCTIONS.includes(ABSOLUTE_CLAUSE)) {
  throw new Error('the shipped instructions no longer contain the absolute clause this probe narrows — re-read them before running');
}
const ARM_INSTRUCTIONS: Record<Arm, string> = {
  cur: VOICE_REALTIME_INSTRUCTIONS,
  scoped: VOICE_REALTIME_INSTRUCTIONS.replace(ABSOLUTE_CLAUSE, SCOPED_TAIL),
};

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
  const silenceMs = SHIPPED_SILENCE_MS;
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  // The `a` window FOLLOWS the arm, exactly as `voice-realtime-ws-proxy.service.ts` derives it in
  // production — see the file header on why that is the shipped coupling, not a second variable.
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: silenceMs });
  const SHIPPED_INTERRUPT = VOICE_REALTIME_TOOLS.find((t) => t.name === 'session_interrupt')!;

  let session: P0Session | null = null;
  session = await openSession({
    run,
    label: `${arm}-${rep}`,
    instructions: ARM_INSTRUCTIONS[arm],
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
  const arms = arg('arms', 'cur,scoped').split(',').filter((a) => a !== '') as Arm[];
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
