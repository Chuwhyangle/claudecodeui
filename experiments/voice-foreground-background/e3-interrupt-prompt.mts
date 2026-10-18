/**
 * E3 — 让 realtime 中继模型**更多地输出打断**：同一批真实回放窗口上，出货 prompt vs「忙时偏向打断」prompt。
 *
 * WHY. 第 3 层的前提（E1c 实测）：若打断的实现是 `priority:'now'` 注入而不是 SDK `interrupt()`，它只在下一个
 * 工具边界插话、不杀后台 Agent，所以打断变便宜，中继可以更积极地用它。本实验只回答中继侧的问题：换 prompt 后，
 * 打断次数、误判（把不需要反应的话当打断）、真停是否仍被识别、是否出现碎片驱动的连打（thrash）、有无丢句。
 *
 * 骨架逐字取自 `experiments/voice-realtime-closing-turn/run.mts`（真实 capture 实时回放、出货 silero 上行门控、
 * 原 journal 的 `status injected` 时间线重放进 instructions），只换臂。
 *
 * ARMS:
 *   K    出货 instructions、出货工具、server_vad 0.5/400。
 *   I    K 的 instructions 里「ONE exception」那一段换成「会话忙（phase=running 或 queued）时，凡与正在做的工作有关的话都用 session_interrupt」。
 *        （首版只写了 running，W4 smoke 里真停落在 phase=queued 被发成 send——queued 是最常见的忙相位，208/327。）
 *   I8   I + silence_duration_ms 800（检验更长的断句窗口能否压住碎片驱动的连打）。
 *   I2   出货段落逐字保留，在其后**追加**忙时规则（I 改写了原段落，丢了 W4 的真停）。
 *
 *   PROBE_BUDGET_CNY=0.4 npx tsx --tsconfig server/tsconfig.json \
 *     experiments/voice-foreground-background/e3-interrupt-prompt.mts --windows W1,W2,W3,W4 --arms K,I,I8 --reps 1
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
  sessionBody,
  sleep,
  type P0Session,
} from '../voice-realtime-segmented/p0/probe-lib.mts';
import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';
import {
  VOICE_REALTIME_STATUS_HEADER,
  VOICE_REALTIME_STATUS_STALENESS_RULE,
} from '../../server/modules/voice-realtime/voice-realtime-settings.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CAPTURE_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-capture');
const LOG_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-log');
const BUDGET_CNY = Number(process.env.PROBE_BUDGET_CNY ?? 0.25);
const DRAIN_MS = 9_000;
const UPLINK_VAD_WEIGHTS =
  process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ?? path.join(HOME, 'work/voice-vad-engines/silero/silero_vad.onnx');

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

/** Windows in the ORIGINAL session's clock (ms since the capture's origin). Each holds a live stop. */
const WINDOWS: Record<string, { capture: string; startMs: number; endMs: number; note: string }> = {
  W1: { capture: '86559798', startMs: 0, endMs: 75_000, note: '"停下它" at ~67.7 s while running' },
  W2: { capture: 'a175e6cd', startMs: 20_000, endMs: 82_000, note: 'stop at ~51–52 s; "停下来以后就没有再去调…" at ~78 s is NOT a stop' },
  W3: { capture: '73f2622b', startMs: 78_000, endMs: 135_000, note: '"好了，你可以中断前面这个操作" at ~127 s' },
  W4: { capture: '71e53da5', startMs: 80_000, endMs: 120_000, note: '"OK，现在可以终止它了" at ~104 s' },
  // LONG windows: the earlier regression of a bare N0 showed up over whole sessions, not in a minute.
  L1: { capture: '86559798', startMs: 0, endMs: 260_000, note: 'stop at ~68 s; ~10 units, several said while running' },
  L2: { capture: 'a175e6cd', startMs: 0, endMs: 200_000, note: 'stop at ~52 s; "停下来以后…" NOT a stop; multi-fragment units' },
};

type Arm = 'K' | 'I' | 'I8' | 'I2';

const EXC_START = 'The ONE exception is a stop, or a request to correct the direction of what is running:';
const EXC_END = 'however ordinary their words sounded.';
if (!VOICE_REALTIME_INSTRUCTIONS.includes(EXC_START) || !VOICE_REALTIME_INSTRUCTIONS.includes(EXC_END)) {
  throw new Error('the shipped prompt no longer contains the exception paragraph arm I replaces — re-derive I');
}
/**
 * Arm I's exception paragraph. Same tools, same `message`/`intent` contract, same closing "OK"; only WHEN to
 * interrupt changes: from "only a stop or a change of direction" to "while running, anything that bears on the work".
 */
const INTERRUPT_MORE =
  'The ONE exception is how you deliver while the session is BUSY (the status line says phase=running or phase=queued — anything but idle): ' +
  'then call `session_interrupt` instead of `session_send` for anything the user says that bears on the work — a new instruction, ' +
  'an added requirement, a correction, a change of direction, a question about what it is doing, or a stop. Interrupting is cheap: ' +
  'it only makes Claude Code pause its current step and read the new words at once; work it has running in the background keeps ' +
  'running, and Claude Code itself decides what to keep. While busy, use `session_send` only for words that need no reaction now ' +
  '(an acknowledgement, a remark, thinking aloud). When the session is idle, always use `session_send`. ' +
  'For `session_interrupt`, put their words in `message` — kept exactly as you would for `session_send`, and always present — and ' +
  'the reason you read it that way in `intent`. Then reply with the single word OK and say nothing else.';
const I_INSTRUCTIONS =
  VOICE_REALTIME_INSTRUCTIONS.slice(0, VOICE_REALTIME_INSTRUCTIONS.indexOf(EXC_START)) +
  INTERRUPT_MORE +
  VOICE_REALTIME_INSTRUCTIONS.slice(VOICE_REALTIME_INSTRUCTIONS.indexOf(EXC_END) + EXC_END.length);

/**
 * Arm I2: the shipped paragraph kept VERBATIM (its stop-detection wording is what K's 3/3 stops rest on — arm I,
 * which rewrote it, lost the W4 stop), with the busy-time rule ADDED after it rather than replacing it.
 */
const BUSY_ADDENDUM =
  ' In addition, while the session is BUSY (the status line says phase=running or phase=queued — anything but idle), also use ' +
  '`session_interrupt` instead of `session_send` for a new instruction, an added requirement, or a question about the work that is ' +
  'running: interrupting is cheap, it only makes Claude Code read the new words at its next step, and work it runs in the background ' +
  'keeps running. While busy, `session_send` is for words that need no reaction now (an acknowledgement, a remark, thinking aloud).';
const I2_INSTRUCTIONS = VOICE_REALTIME_INSTRUCTIONS.replace(EXC_END, EXC_END + BUSY_ADDENDUM);

const SHIPPED_RESULT = {
  accepted: true,
  instruction:
    'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
};

const armSpec = (arm: Arm) => ({
  instructions: arm === 'K' ? VOICE_REALTIME_INSTRUCTIONS : arm === 'I2' ? I2_INSTRUCTIONS : I_INSTRUCTIONS,
  tools: VOICE_REALTIME_TOOLS,
  resume: true,
  sendResult: SHIPPED_RESULT,
  assistantOk: false,
  silenceMs: arm === 'I8' ? 800 : 400,
});

const capturePath = (prefix: string, ext: string, dir = CAPTURE_DIR): string => {
  const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(ext));
  if (name === undefined) throw new Error(`no ${ext} for ${prefix} in ${dir}`);
  return path.join(dir, name);
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

type StatusPoint = { offsetMs: number; seq: number; phase: string; items: number; bytes: number };
const statusTimeline = (prefix: string): StatusPoint[] => {
  const timeline = readFileSync(capturePath(prefix, '.timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const origin = Date.parse(timeline.find((e: { kind: string }) => e.kind === 'origin').at);
  const points: StatusPoint[] = [];
  for (const line of readFileSync(capturePath(prefix, '.jsonl', LOG_DIR), 'utf8').trim().split('\n')) {
    const rec = JSON.parse(line) as { at: string; line?: string };
    const m = /^status injected seq=(\d+) phase=(\S+) queued=(\d+)\/(\d+)B/.exec(rec.line ?? '');
    if (m) points.push({ offsetMs: Date.parse(rec.at) - origin, seq: Number(m[1]), phase: m[2]!, items: Number(m[3]), bytes: Number(m[4]) });
  }
  return points;
};

const runOne = async (
  run: ReturnType<typeof createRun>,
  windowName: string,
  arm: Arm,
  rep: number,
): Promise<Record<string, unknown>> => {
  const w = WINDOWS[windowName]!;
  const spec = armSpec(arm);
  const points = statusTimeline(w.capture);
  let status: StatusPoint | null = null;
  let runStartedAt = 0;
  for (const p of points) if (p.offsetMs <= w.startMs) status = p;
  if (status?.phase === 'running') runStartedAt = Date.now();
  const compose = (): string => {
    if (status === null) return spec.instructions;
    const now = Date.now();
    const line =
      `[exec] phase=${status.phase} run=${status.phase === 'idle' ? '-' : 'replay-run'} statusSeq=${status.seq} ` +
      `elapsed=${runStartedAt === 0 ? 0 : Math.round((now - runStartedAt) / 1000)}s ` +
      `queued=${status.items}/${status.bytes}B pending=- at=${now - 1000} ageMs=1000`;
    return `${spec.instructions}\n\n${VOICE_REALTIME_STATUS_HEADER}\n${VOICE_REALTIME_STATUS_STALENESS_RULE}\n${line}`;
  };

  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: spec.silenceMs });
  let session: P0Session | null = null;
  const insertedOk: string[] = [];
  session = await openSession({
    run,
    label: `${windowName}-${arm}-${rep}`,
    instructions: compose(),
    sessionDefaults: sessionBody({ turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: spec.silenceMs } }),
    tools: spec.tools as never,
    respondToToolOutputs: spec.resume,
    executor: {
      session_send: () => spec.sendResult,
      session_interrupt: (args: Record<string, unknown>) => ({
        aborted: true,
        message: args.message,
        runId: 'replay-run',
        triggerSeq: null,
        queuedStillPending: 0,
      }),
    },
    onEvent: (event) => {
      // N2: close the tool turn with an assistant item, on the tick the tool result left the socket.
      if (!spec.assistantOk || event.direction !== 'sent' || session === null) return;
      const item = (event.wire as { type?: string; item?: { type?: string; call_id?: string } }).item;
      if (event.wire.type !== 'conversation.item.create' || item?.type !== 'function_call_output') return;
      insertedOk.push(String(item.call_id ?? ''));
      session.sendRaw({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      });
    },
  });
  const s = session;

  const pcm = wavPcm(capturePath(w.capture, '.wav'));
  const span = pcm.subarray(Math.floor(w.startMs * 32), Math.floor(w.endMs * 32));
  const frames: string[] = [];
  for (let off = 0; off + 640 <= span.length; off += 640) frames.push(span.subarray(off, off + 640).toString('base64'));

  const t0 = Date.now();
  const timeline: Array<Record<string, unknown>> = [];
  const seenCalls = new Set<string>();
  let lastSentResponseCreate = -1;
  let cursor = 0;
  const absorb = (): void => {
    for (const event of s.events.slice(cursor)) {
      const wire = event.wire as Record<string, unknown>;
      const type = String(wire.type ?? '');
      const at = event.atMs - t0;
      if (event.direction === 'sent') {
        if (type === 'response.create') lastSentResponseCreate = at;
        continue;
      }
      if (type === 'input_audio_buffer.speech_started') gate.noteUpstreamTurn(true);
      if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') gate.noteUpstreamTurn(false);
      if (type === 'conversation.item.input_audio_transcription.completed') {
        timeline.push({ at, kind: 'ASR', text: String(wire.transcript ?? '') });
      } else if (type === 'response.created') {
        // A response the relay asked for (the closing turn) vs one the endpoint's own VAD started.
        const resumed = lastSentResponseCreate >= 0 && at - lastSentResponseCreate < 3_000;
        lastSentResponseCreate = -1;
        timeline.push({ at, kind: 'RESP', trigger: resumed ? 'closing' : 'vad' });
      } else if (type === 'response.function_call_arguments.done' || (type === 'response.output_item.done' && (wire.item as { type?: string })?.type === 'function_call')) {
        const item = (type === 'response.output_item.done' ? wire.item : wire) as { call_id?: string; name?: string; arguments?: string };
        const id = String(item.call_id ?? '');
        if (id === '' || seenCalls.has(id)) continue;
        seenCalls.add(id);
        let message: unknown = item.arguments;
        let intent: unknown;
        try {
          const parsed = JSON.parse(String(item.arguments)) as { message?: unknown; intent?: unknown };
          message = parsed.message;
          intent = parsed.intent;
        } catch {
          // a truncated call keeps its raw text — that is the reading
        }
        timeline.push({ at, kind: 'CALL', tool: item.name, message, intent });
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

  let nextPoint = points.findIndex((p) => p.offsetMs > w.startMs);
  if (nextPoint < 0) nextPoint = points.length;
  let driftMs = 0;
  let abortedAt: string | null = null;
  try {
  for (let i = 0; i < frames.length; i++) {
    const offsetMs = w.startMs + i * 20;
    while (nextPoint < points.length && points[nextPoint]!.offsetMs <= offsetMs) {
      const p = points[nextPoint]!;
      if (p.phase === 'running' && status?.phase !== 'running') runStartedAt = Date.now();
      status = p;
      timeline.push({ at: Date.now() - t0, kind: 'STATUS', phase: p.phase, queued: p.items });
      s.setInstructions(compose());
      nextPoint += 1;
    }
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
    // The L1 pair was lost exactly here: the budget guard closed the socket, the next frame threw,
    // and the whole record went with it. A cut run is still a reading up to the cut.
    abortedAt = `${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(error)}`;
  }
  absorb();
  await gate.close().catch(() => undefined);
  await s.close().catch(() => undefined);

  // A cancelled response reports `usage: null` — W2/N1's first record was lost to exactly that.
  const responses = s.responses.map((r) => (r.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { audio_tokens?: number; text_tokens?: number } });
  return {
    window: windowName,
    arm,
    rep,
    note: w.note,
    spendCny: s.spendCny,
    responses: responses.length,
    usage: responses.map((u) => [u.input_tokens_details?.text_tokens ?? 0, u.input_tokens_details?.audio_tokens ?? 0, u.output_tokens ?? 0]),
    insertedOk: insertedOk.length,
    abortedAt,
    driftMs,
    errors: s.errors.map((e) => JSON.stringify(e.wire).slice(0, 200)),
    timeline,
  };
};

const main = async (): Promise<void> => {
  const windows = arg('windows', 'W1,W2,W3,W4').split(',');
  const arms = arg('arms', 'K,I,I8').split(',') as Arm[];
  const reps = Number(arg('reps', '1'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · windows ${windows.join(',')} · arms ${arms.join(',')} · reps ${reps}`);
  const jobs: Array<Promise<Record<string, unknown>>> = [];
  for (const wn of windows) for (const arm of arms) for (let rep = 0; rep < reps; rep++) jobs.push(runOne(run, wn, arm, rep));
  const settled = await Promise.allSettled(jobs);
  const results = settled.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason) }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const file = path.join(HERE, 'traces', `run-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), budgetCny: BUDGET_CNY, spendCny: Number(run.spendCny.toFixed(6)), guardTriggered: run.guardTriggered, results }, null, 2)}\n`);
  console.log(`spend ¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} · guard=${run.guardTriggered}`);
  console.log(`trace: ${file}`);
  process.exit(0);
};

void main();
