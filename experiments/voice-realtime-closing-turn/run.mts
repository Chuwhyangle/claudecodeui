/**
 * The closing "OK" turn, and a slimmer `session_send` schema — replayed through the production shape.
 *
 * WHY. On the four reconciled production connections (¥0.3217), 46% of the spend is the response the
 * transport synthesizes after every tool result: the model answers "OK" (195 times) or "No response
 * requested." (37 times), nobody sees it, and it re-reads the whole context to do so. Turning it off
 * alone was tried twice and regressed both times — live (server/index.ts, the `respondToToolOutputs`
 * comment: 3 of 5 instructions heard and never relayed) and on replay
 * (experiments/voice-realtime-relay-mode-replay, arm AN: 6 text replies, 4 units lost). In BOTH, the
 * tool result still said "Reply with the single word OK". The model was told to reply and then given no
 * turn in which to do it; the next utterance's response was the first place it could, and it spent it
 * on the owed reply instead of the relay. Changing the instruction AND the closing turn together has not
 * been tried. Neither has closing the turn for free, with an assistant item instead of a response.
 *
 * ARMS (one variable each against K):
 *   K    production: shipped prompt, shipped tools, closing response, shipped result ("Reply … OK").
 *   N0   K without the closing response (the shape that regressed) — the control for N1/N2.
 *   N1   N0 + the "reply OK" requests removed: the tool result says nothing more is needed, and the
 *        prompt's "Then reply with the single word OK" after an interrupt becomes "Then say nothing more."
 *   N2   N0 + the relay itself appends `{role: assistant, text: "OK"}` after each tool result — the same
 *        conversation shape as K, without paying for a response to produce it.
 *   S    K with the slim `session_send` descriptor (the gateway's generic description and the unused
 *        `waitSeconds` / `correlationId` / `session` fields removed). `session_interrupt` unchanged.
 *
 * SHAPE. Real captures replayed in real time at 16 kHz / 20 ms through the production silero uplink
 * gate; the endpoint's own `server_vad` (0.5 / 400) decides the turns; the original journal's
 * `status injected` timeline is replayed into the instructions so the model sees "Claude is running"
 * when it originally did. Each window holds a live interrupt the person actually made.
 *
 *   PROBE_BUDGET_CNY=0.25 npx tsx --tsconfig server/tsconfig.json \
 *     experiments/voice-realtime-closing-turn/run.mts --windows W1,W2 --arms K,N0,N1,N2,S --reps 1
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS, voiceRealtimeInstructionsFor } from '../../server/modules/voice-realtime/index.js';
import { acceptedResultTail } from '../../server/modules/voice-realtime/voice-realtime-closing-turn.js';
import {
  VOICE_REALTIME_STATUS_HEADER,
  VOICE_REALTIME_STATUS_STALENESS_RULE,
} from '../../server/modules/voice-realtime/voice-realtime-settings.js';
import { DEFAULT_TURN_DETECTION } from '../../server/modules/voice-realtime/voice-realtime-turn-detection.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

import { evaluate, type GateVerdict, type RunRecord } from './gate.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CAPTURE_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-capture');
/**
 * A FROZEN copy of the captures this experiment replays. The live capture store is capped (64 MiB) and
 * trims OLDEST FIRST, so the files yesterday's windows used were already gone by the time they were
 * needed again; anything a run depends on is copied here (0700, outside the repo) before it can be evicted.
 * Layout: `capture/<id>.wav|.timeline.jsonl`, `log/<id>.jsonl`.
 */
const CORPUS_DIR = process.env.CLOSING_TURN_CORPUS_DIR ?? path.join(HOME, '.cloudcli', 'voice-realtime-closing-turn-corpus');
const LOG_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-log');
const BUDGET_CNY = Number(process.env.PROBE_BUDGET_CNY ?? 0.25);
const DRAIN_MS = 9_000;
const UPLINK_VAD_WEIGHTS =
  process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ?? path.join(HOME, 'work/voice-vad-engines/silero/silero_vad.onnx');

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
};

/**
 * Windows in the ORIGINAL session's clock (ms since the capture's origin).
 * W1–W4 and L1/L2 are the 2026-10-14 captures: their audio was EVICTED from the live store before this run
 * and is kept here only because `traces/` names them. P1, M1, M2, S_A, S_B are what the staged plan uses.
 */
const WINDOWS: Record<string, { capture: string; startMs: number; endMs: number; note: string }> = {
  W1: { capture: '86559798', startMs: 0, endMs: 75_000, note: '"停下它" at ~67.7 s while running' },
  W2: { capture: 'a175e6cd', startMs: 20_000, endMs: 82_000, note: 'stop at ~51–52 s; "停下来以后就没有再去调…" at ~78 s is NOT a stop' },
  W3: { capture: '73f2622b', startMs: 78_000, endMs: 135_000, note: '"好了，你可以中断前面这个操作" at ~127 s' },
  W4: { capture: '71e53da5', startMs: 80_000, endMs: 120_000, note: '"OK，现在可以终止它了" at ~104 s' },
  // LONG windows: the earlier regression of a bare N0 showed up over whole sessions, not in a minute.
  L1: { capture: '86559798', startMs: 0, endMs: 260_000, note: 'stop at ~68 s; ~10 units, several said while running' },
  L2: { capture: 'a175e6cd', startMs: 0, endMs: 200_000, note: 'stop at ~52 s; "停下来以后…" NOT a stop; multi-fragment units' },
  // WHOLE sessions of 2026-10-15 23:00–00:02, at the shipped 800 ms. S_B is the one where a spoken stop
  // arrived 16.8 s late and was delivered twice (bc6b9335e fixed the relay side).
  S_A: { capture: 'a61de04b', startMs: 0, endMs: 400_000, note: 'whole session 312 s, 15 responses live; stop at 110.8 s, next sentence at 155 s' },
  S_B: { capture: '259b51e0', startMs: 0, endMs: 400_000, note: 'whole session 172 s, 13 responses live; the late stop at 134.7 s' },
  // The MINIMAL N0 failure position (stop, then the very next sentence 10 s later) and two shapes without a stop.
  P1: { capture: '402fad85', startMs: 0, endMs: 100_000, note: '63 s: stop at 11.4 s, then "找到 quay 这个项目最活跃的会话" at 22–27 s' },
  M1: { capture: '8fe60310', startMs: 0, endMs: 400_000, note: '172 s dense chain: 9 sends, corrections of its own earlier sentences, queue talk' },
  M2: { capture: '7c01be7e', startMs: 0, endMs: 400_000, note: '170 s multi-fragment: 13 ASR finals feeding 3 sends' },
};

type Arm = 'K' | 'N0' | 'N1' | 'N2' | 'S' | 'NS' | 'A';

const SHIPPED_RESULT = {
  accepted: true,
  instruction:
    'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
};
const NO_REPLY_RESULT = {
  accepted: true,
  instruction:
    'The message was accepted and will reach the session. Do not call session_send again for it. Nothing more is needed from you: say nothing and wait for the user to speak again.',
};
const OK_SENTENCE = 'Then reply with the single word OK and say nothing else.';
if (!VOICE_REALTIME_INSTRUCTIONS.includes(OK_SENTENCE)) {
  throw new Error('the shipped prompt no longer contains the "reply OK" sentence N1 replaces — re-derive N1');
}
const N1_INSTRUCTIONS = VOICE_REALTIME_INSTRUCTIONS.replace(OK_SENTENCE, 'Then say nothing more.');
const ANNOUNCE_INSTRUCTIONS = voiceRealtimeInstructionsFor('announce');
const ANNOUNCE_RESULT = {
  accepted: true,
  instruction: `The message was accepted and will reach the session. Do not call session_send again for it. ${acceptedResultTail('announce')}`,
};
const SHIPPED_INTERRUPT = VOICE_REALTIME_TOOLS.find((t) => t.name === 'session_interrupt')!;

const armSpec = (arm: Arm) => ({
  instructions: arm === 'N1' || arm === 'NS' ? N1_INSTRUCTIONS : arm === 'A' ? ANNOUNCE_INSTRUCTIONS : VOICE_REALTIME_INSTRUCTIONS,
  tools: arm === 'S' || arm === 'NS' ? [SESSION_SEND_TOOL, SHIPPED_INTERRUPT] : VOICE_REALTIME_TOOLS,
  resume: arm === 'K' || arm === 'S' || arm === 'A',
  sendResult: arm === 'N1' || arm === 'NS' ? NO_REPLY_RESULT : arm === 'A' ? ANNOUNCE_RESULT : SHIPPED_RESULT,
  assistantOk: arm === 'N2',
});

const capturePath = (prefix: string, ext: string, dir = CAPTURE_DIR): string => {
  const frozen = path.join(CORPUS_DIR, dir === LOG_DIR ? 'log' : 'capture');
  for (const where of [frozen, dir]) {
    let names: string[] = [];
    try {
      names = readdirSync(where);
    } catch {
      continue;
    }
    // `.jsonl` also ends `.timeline.jsonl`: a journal is the one that is NOT a timeline.
    const name = names.find((f) => f.startsWith(prefix) && f.endsWith(ext) && (ext !== '.jsonl' || !f.endsWith('.timeline.jsonl')));
    if (name !== undefined) return path.join(where, name);
  }
  throw new Error(`no ${ext} for ${prefix} in ${CORPUS_DIR} or ${dir} (evicted from the live store?)`);
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
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms });
  let session: P0Session | null = null;
  const insertedOk: string[] = [];
  session = await openSession({
    run,
    label: `${windowName}-${arm}-${rep}`,
    instructions: compose(),
    // THE SHIPPED turn detection, not a literal: this file hard-coded 400 ms after production moved to 800
    // (488eb408f, 2026-10-15 21:05) and every reading taken in between was another system's.
    sessionDefaults: sessionBody({ turn_detection: { ...DEFAULT_TURN_DETECTION } }),
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

type StageSpec = { n: 1 | 2 | 3; budgetCny: number; windows: string[]; arms: Arm[]; note: string };
/** Caps sum to ¥0.45 of the ¥0.5 experiment budget; the remaining ¥0.05 is the rerun reserve. */
const STAGES: StageSpec[] = [
  { n: 1, budgetCny: 0.07, windows: ['P1'], arms: ['K', 'N1'], note: 'smoke: a stop, then the very next sentence' },
  { n: 2, budgetCny: 0.19, windows: ['M1', 'M2'], arms: ['K', 'N1'], note: 'mid: a dense chain and a multi-fragment run, no stop' },
  { n: 3, budgetCny: 0.19, windows: ['S_A', 'S_B'], arms: ['K', 'NS'], note: 'whole sessions, the candidate to ship' },
];

/** What the capture itself cost live (sum of its journal's `response` entries) — K on the same audio is near it. */
const liveCostCny = (prefix: string): number | null => {
  try {
    let sum = 0;
    for (const line of readFileSync(capturePath(prefix, '.jsonl', LOG_DIR), 'utf8').split('\n')) {
      if (line.includes('"kind":"response"')) sum += (JSON.parse(line) as { costCny?: number }).costCny ?? 0;
    }
    return sum;
  } catch {
    return null;
  }
};

const windowSeconds = (name: string): number => {
  const w = WINDOWS[name]!;
  const pcm = wavPcm(capturePath(w.capture, '.wav'));
  return (Math.min(w.endMs, Math.floor(pcm.length / 32)) - w.startMs) / 1000;
};

/** Everything the live run would touch, minus the upstream: windows, timelines, transforms, caps. */
const dryCheck = (): void => {
  console.log('── dry check (no upstream connection, no spend) ──');
  let problems = 0;
  const bad = (m: string): void => {
    problems += 1;
    console.log(`  ✘ ${m}`);
  };
  console.log(`turn detection (shipped default): ${JSON.stringify(DEFAULT_TURN_DETECTION)}`);
  const newest = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(LOG_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of newest.slice(0, 12)) {
    const m = /session\.update voice=\S+ tools=\d+ turn_detection=(\S+) threshold=(\S+) silence=(\d+)ms/.exec(readFileSync(file, 'utf8'));
    if (m === null) continue;
    const live = { type: m[1], threshold: Number(m[2]), silence_duration_ms: Number(m[3]) };
    console.log(`  live journal ${path.basename(file).slice(0, 8)}: ${JSON.stringify(live)}`);
    if (JSON.stringify(live) !== JSON.stringify(DEFAULT_TURN_DETECTION)) bad('the live journal is not at the shipped default — the probe shape would drift');
    break;
  }
  if (N1_INSTRUCTIONS === VOICE_REALTIME_INSTRUCTIONS) bad('N1 instructions are unchanged');
  if (/single word OK/.test(NO_REPLY_RESULT.instruction) || !/single word OK/.test(SHIPPED_RESULT.instruction)) bad('N1/K tool-result texts are wrong');
  console.log(`  N1 instructions ${N1_INSTRUCTIONS.length} chars (K ${VOICE_REALTIME_INSTRUCTIONS.length}); "reply OK" survives in N1: ${/single word OK/.test(N1_INSTRUCTIONS)}`);
  try {
    readApiKey();
    console.log('  api key: present');
  } catch (error) {
    bad(`api key: ${String(error).slice(0, 80)}`);
  }
  console.log(`  uplink-vad weights: ${statSync(UPLINK_VAD_WEIGHTS).size} bytes`);

  let estTotal = 0;
  const stageEnd: number[] = [];
  for (const stage of STAGES) {
    let longest = 0;
    let est = 0;
    console.log(`stage ${stage.n} (${stage.note}) cap ¥${stage.budgetCny.toFixed(2)}`);
    for (const wn of stage.windows) {
      const w = WINDOWS[wn];
      if (w === undefined) {
        bad(`window ${wn} is not defined`);
        continue;
      }
      let seconds = 0;
      let points = 0;
      try {
        seconds = windowSeconds(wn);
        points = statusTimeline(w.capture).length;
      } catch (error) {
        bad(`${wn}: ${String(error).slice(0, 100)}`);
        continue;
      }
      // K ≈ what the capture cost live (a per-second guess was 2–3× off: most of a session is gated away);
      // N1 ≈ 0.55×K, NS ≈ 0.5×K (2026-10-15: 0.48–0.63).
      const k = liveCostCny(w.capture) ?? 0.0005 * seconds;
      const cost = stage.arms.reduce((sum, arm) => sum + (arm === 'K' ? k : arm === 'N1' ? 0.55 * k : 0.5 * k), 0);
      est += cost;
      longest = Math.max(longest, seconds + DRAIN_MS / 1000 + 2);
      console.log(`  ${wn.padEnd(3)} ${w.capture} ${seconds.toFixed(1).padStart(6)} s · ${stage.arms.length} arms · ${points} status points · est ¥${cost.toFixed(3)}`);
    }
    console.log(`  → ${stage.windows.length * stage.arms.length} concurrent runs · est ¥${est.toFixed(3)} (cap ¥${stage.budgetCny.toFixed(2)}) · wall ≈ ${longest.toFixed(0)} s`);
    if (est > stage.budgetCny) bad(`stage ${stage.n} estimate exceeds its cap`);
    estTotal += est;
    stageEnd.push(longest);
  }
  const wall = stageEnd[0]! + Math.max(stageEnd[1]!, stageEnd[2]!);
  console.log(`plan: stage 1, then stages 2+3 concurrently → wall ≈ ${wall.toFixed(0)} s (${(wall / 60).toFixed(1)} min) · est ¥${estTotal.toFixed(3)} · caps ¥${STAGES.reduce((a, s2) => a + s2.budgetCny, 0).toFixed(2)} of ¥0.50`);
  if (wall > 600) bad('estimated wall clock exceeds 10 minutes');
  console.log(problems === 0 ? 'DRY CHECK OK' : `DRY CHECK: ${problems} problem(s)`);
  process.exit(problems === 0 ? 0 : 1);
};

const runStage = async (stage: StageSpec): Promise<{ stage: StageSpec; run: ReturnType<typeof createRun>; results: Array<Record<string, unknown>> }> => {
  const run = createRun({ budgetCny: stage.budgetCny, apiKey: readApiKey() });
  const jobs: Array<Promise<Record<string, unknown>>> = [];
  for (const wn of stage.windows) for (const arm of stage.arms) jobs.push(runOne(run, wn, arm, 0));
  const settled = await Promise.allSettled(jobs);
  const results = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { window: stage.windows[Math.floor(i / stage.arms.length)], arm: stage.arms[i % stage.arms.length], error: String(r.reason) },
  );
  return { stage, run, results };
};

const gateStage = (results: Array<Record<string, unknown>>): GateVerdict[] => {
  const records = results as unknown as RunRecord[];
  const out: GateVerdict[] = [];
  for (const window of [...new Set(records.map((r) => r.window))]) {
    const k = records.find((r) => r.window === window && r.arm === 'K');
    for (const r of records.filter((x) => x.window === window && x.arm !== 'K')) {
      out.push(
        k === undefined || k.error !== undefined
          ? { window, arm: r.arm, verdict: 'FAIL', lostUnits: [], textRepliesCandidate: 0, textRepliesK: 0, interruptsK: 0, interruptsCandidate: 0, costRatio: null, reasons: ['no usable K record'] }
          : evaluate(k, r),
      );
    }
  }
  return out;
};

const printGate = (stage: StageSpec, verdicts: GateVerdict[]): void => {
  for (const v of verdicts) {
    console.log(
      `  stage ${stage.n} ${v.window}/${v.arm}: ${v.verdict} · lost ${v.lostUnits.length} · stops ${v.interruptsCandidate}/${v.interruptsK}` +
        ` · text ${v.textRepliesCandidate}/${v.textRepliesK} · cost ${v.costRatio === null ? '-' : `${(v.costRatio * 100).toFixed(0)}% of K`}`,
    );
    for (const reason of v.reasons) console.log(`      · ${reason}`);
  }
};

const writeTrace = (payload: Record<string, unknown>): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const file = path.join(HERE, 'traces', `run-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
};

/** Stage 1, then — only on PASS — stages 2 and 3 concurrently. */
const staged = async (): Promise<void> => {
  const t0 = Date.now();
  const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`;
  const all: Array<Record<string, unknown>> = [];
  let spend = 0;
  const verdicts: GateVerdict[] = [];

  console.log(`[${stamp()}] stage 1 · ${STAGES[0]!.windows} × ${STAGES[0]!.arms}`);
  const s1 = await runStage(STAGES[0]!);
  all.push(...s1.results.map((r) => ({ stage: 1, ...r })));
  spend += s1.run.spendCny;
  const v1 = gateStage(s1.results);
  verdicts.push(...v1);
  console.log(`[${stamp()}] stage 1 done · spend ¥${s1.run.spendCny.toFixed(4)} · guard=${s1.run.guardTriggered}`);
  printGate(STAGES[0]!, v1);

  let proceed = v1.length > 0 && v1.every((v) => v.verdict === 'PASS') && !s1.run.guardTriggered;
  if (!proceed) {
    console.log(`[${stamp()}] gate 1 is not PASS — stages 2 and 3 are NOT started`);
  } else {
    console.log(`[${stamp()}] gate 1 PASS — starting stage 2 (${STAGES[1]!.windows.length * 2} runs) and stage 3 (${STAGES[2]!.windows.length * 2} runs) concurrently`);
    const [s2, s3] = await Promise.all([runStage(STAGES[1]!), runStage(STAGES[2]!)]);
    for (const s of [s2, s3]) {
      all.push(...s.results.map((r) => ({ stage: s.stage.n, ...r })));
      spend += s.run.spendCny;
      const v = gateStage(s.results);
      verdicts.push(...v);
      console.log(`[${stamp()}] stage ${s.stage.n} done · spend ¥${s.run.spendCny.toFixed(4)} · guard=${s.run.guardTriggered}`);
      printGate(s.stage, v);
      if (s.run.guardTriggered) proceed = false;
    }
  }
  const drifts = all.map((r) => Number(r.driftMs ?? 0));
  const file = writeTrace({
    ranAt: new Date().toISOString(),
    plan: 'staged',
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    spendCny: Number(spend.toFixed(6)),
    maxDriftMs: Math.max(0, ...drifts),
    verdicts,
    results: all,
  });
  const allPass = verdicts.length > 0 && verdicts.every((v) => v.verdict === 'PASS');
  console.log(`[${stamp()}] total spend ¥${spend.toFixed(6)} of ¥0.50 · max drift ${Math.max(0, ...drifts)} ms · ${allPass ? 'ALL PASS' : 'NOT ALL PASS — read the timelines'}`);
  console.log(`trace: ${file}`);
  process.exit(allPass ? 0 : 3);
};

const main = async (): Promise<void> => {
  if (process.argv.includes('--dry')) return dryCheck();
  if (arg('plan', 'manual') === 'staged') return staged();
  const windows = arg('windows', 'W1,W2').split(',');
  const arms = arg('arms', 'K,N0,N1,N2,S').split(',') as Arm[];
  const reps = Number(arg('reps', '1'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · windows ${windows.join(',')} · arms ${arms.join(',')} · reps ${reps}`);
  const jobs: Array<Promise<Record<string, unknown>>> = [];
  for (const wn of windows) for (const arm of arms) for (let rep = 0; rep < reps; rep++) jobs.push(runOne(run, wn, arm, rep));
  const settled = await Promise.allSettled(jobs);
  const results = settled.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason) }));
  const file = writeTrace({ ranAt: new Date().toISOString(), budgetCny: BUDGET_CNY, spendCny: Number(run.spendCny.toFixed(6)), guardTriggered: run.guardTriggered, results });
  console.log(`spend ¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} · guard=${run.guardTriggered}`);
  console.log(`trace: ${file}`);
  process.exit(0);
};

void main();
