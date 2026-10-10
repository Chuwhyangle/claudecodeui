/**
 * S4 — the semantic endpoint: does this model accept a semantic `turn_detection.type`, and if the
 * control plane cannot tell us, does PROMPT-LEVEL WAITING hold an unfinished fragment instead?
 *
 * THE QUESTION. `docs/proposals/voice-realtime-segmented-relay-SPEC.md` D7 / "语义端点" wants the
 * relay to wait when the user has obviously not finished ("把 server 里的 voice.ts 的") instead of
 * hard-cutting on silence. The SPEC names two routes and P0 must find which one exists:
 *
 *   1. server-side semantic VAD — `session.update` with `turn_detection.type` set to a semantic
 *      value (e.g. `semantic_vad`), accepted by the model as-is.
 *   2. prompt-level waiting — the model declines to call `session_send` for a fragment that is
 *      obviously unfinished, and forwards the WHOLE thought once the continuation arrives.
 *
 * WHY A BOGUS CONTROL IS PART OF THE EVIDENCE RATHER THAN A NICETY. Measured on 2026-10-10: the
 * endpoint echoes back `semantic_vad` AND echoes back `bogus_vad_type`, with the same normalized
 * field set. The echo is a pass-through, so "accepted" is NOT proof that semantic VAD is
 * implemented. This probe sends the bogus value too and records BOTH echoes: the trace carries the
 * reason its own route-1 reading is weak, instead of leaving a later reader to assume the echo
 * meant something. `echoDiscriminates` is derived from the pair — semantic accepted AND bogus not.
 *
 * WHAT IS SENT. Two control-plane sessions (no responses: no audio is ever sent, so they cost
 * nothing), then `REPETITIONS` prompt-wait runs. A run commits the first half of `zh-d01` and lets
 * the model answer it. THE RUN IS ADAPTIVE, and the reason is the budget: the ONE reading that
 * decides route 2 is what the FIRST response window carried. If the model forwarded the unfinished
 * fragment there (0 → 1 `session_send` calls), the hold did not happen and the run is over — a
 * second response would only re-measure a settled fact. Only when it HELD (0 calls) does the second
 * half follow, and then the run records whether the whole thought is forwarded exactly once.
 *
 * WHAT IS READ, per run, from the frames with the same call_id-deduplicated reader the criterion
 * uses — never from a hand-written flag: the calls the first window carried, and, when it held, the
 * calls the continuation carried.
 *
 * Verdict, derived from the trace by `scripts/voice-realtime-p0-record-check.mjs`:
 *   supported     route 1 is discriminating, OR every run held and then forwarded exactly once
 *   unsupported   no run held (every unfinished fragment was forwarded immediately)
 *   inconclusive  some runs held and some did not (an unreliable hold is not a mechanism), or none ran
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s4-semantic-endpoint.mts
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s4-semantic-endpoint.mts --reps=1
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { VOICE_REALTIME_INSTRUCTIONS } from '../../../server/modules/voice-realtime/index.js';

import {
  REPO_ROOT,
  SESSION_SEND_TOOL,
  countSessionErrors,
  createRun,
  elideAudio,
  openSession,
  readApiKey,
  sessionBody,
  sessionSendFrames,
  sha256Hex,
  sleep,
  summarizeExchange,
  writeTrace,
  type P0Session,
  type ProbeEvent,
} from './probe-lib.mts';

const AUDIO_REL = 'experiments/voice-trim/fixtures/zh-d01-o85.wav';
/**
 * The stage budget. Sized from the measured per-response cost (¥0.00112 for a finished-audio-free
 * text turn, ¥0.00137 for one carrying both audio halves) plus room for either run to hold and
 * spend its second response.
 */
const BUDGET_CNY = 0.0045;
/** How many prompt-wait runs. The hold is a behaviour under a prompt, so one run cannot measure it. */
const DEFAULT_REPETITIONS = 2;
/** One response window. The endpoint answers a text turn in well under a second; this is the watchdog. */
const RESPONSE_WINDOW_MS = 45_000;
const CHUNK_MS = 100;
const SAMPLE_RATE = 16_000;
const BYTES_PER_FRAME = ((SAMPLE_RATE * CHUNK_MS) / 1000) * 2;

/** The semantic value route 1 asks for. */
const SEMANTIC_TYPE = 'semantic_vad';
/**
 * The control. A nonsense value that no implementation could honour — sent so the trace shows
 * whether the echo means anything. Measured 2026-10-10: this one is echoed back too.
 */
const BOGUS_TYPE = 'bogus_vad_type';

/**
 * The prompt-level waiting rule, appended to the shipping relay instructions.
 *
 * WHY SO EXPLICIT ABOUT THE MARKER WORDS. A vague "wait if it sounds unfinished" was measured to be
 * ignored; naming the trailing function words the model must treat as "still speaking" is what makes
 * the hold observable at all. The rule is part of the measurement, so it is recorded verbatim.
 */
const HOLD_RULE =
  ' Call `session_send` ONLY when the user has finished a complete thought. If the user\'s turn stops' +
  ' mid-phrase — it ends with 的/把/和/那个/一下/里/上, or is a bare noun with no verb — the user is' +
  ' STILL SPEAKING: you MUST call nothing, stay silent, and wait. Then forward the whole thought' +
  ' exactly once, when it is complete.';

/** The WAV's PCM payload, with its 44-byte canonical header stripped. */
function readPcm(rel: string): { bytes: Buffer; sha256: string; seconds: number } {
  const wav = readFileSync(path.join(REPO_ROOT, rel));
  const bytes = wav.subarray(44);
  return { bytes, sha256: sha256Hex(wav), seconds: Number((bytes.length / 2 / SAMPLE_RATE).toFixed(3)) };
}

/** Appends one PCM buffer to the session in `CHUNK_MS` frames, the way the browser would. */
function appendPcm(session: P0Session, pcm: Buffer): number {
  let frames = 0;
  for (let offset = 0; offset < pcm.length; offset += BYTES_PER_FRAME) {
    const chunk = pcm.subarray(offset, Math.min(offset + BYTES_PER_FRAME, pcm.length));
    session.sendAudioBase64(chunk.toString('base64'));
    frames += 1;
  }
  return frames;
}

/**
 * The `session.turn_detection` the endpoint echoed back on a session, or `null` when it said nothing.
 * Read off the received frames, so the recorded echo is the endpoint's own bytes.
 */
function echoedTurnDetection(session: P0Session): Record<string, unknown> | null {
  let echo: Record<string, unknown> | null = null;
  for (const event of session.events) {
    if (event.direction !== 'received' || event.wire.type !== 'session.updated') continue;
    const wireSession = event.wire.session as Record<string, unknown> | undefined;
    const turnDetection = wireSession?.turn_detection;
    if (typeof turnDetection === 'object' && turnDetection !== null) {
      echo = turnDetection as Record<string, unknown>;
    }
  }
  return echo;
}

/** One prompt-wait run: what the first window carried, and (only if it held) what the second did. */
type WaitRun = {
  label: string;
  sessionId: string | null;
  responses: number;
  /** The `session_send` calls the FIRST response window carried. 0 means the model HELD. */
  callsAfterFragment1: number;
  held: boolean;
  /** The continuation was only sent when the run held; `null` means "not applicable". */
  continuationSent: boolean;
  callsAfterContinuation: number | null;
  forwardedOnceAfterContinuation: boolean | null;
  forwardedMessage: string | null;
  timedOut: boolean;
  errors: P0Session['errors'];
  errorFrames: number;
  spendCny: number;
  exchange: ReturnType<typeof summarizeExchange>;
  events: ProbeEvent[];
};

/** Sends one fragment of audio and lets the model answer it; returns what the window carried. */
async function sendFragmentAndAnswer(session: P0Session, events: ProbeEvent[], pcm: Buffer): Promise<{ calls: number; timedOut: boolean }> {
  const before = session.responses.length;
  appendPcm(session, pcm);
  await sleep(200);
  session.sendRaw({ type: 'input_audio_buffer.commit' });
  await sleep(150);
  session.sendRaw({ type: 'response.create' });
  const answered = await session.waitFor(
    () => session.responses.length > before || session.errors.length > 0,
    RESPONSE_WINDOW_MS,
  );
  await sleep(400);
  return { calls: sessionSendFrames(events).length, timedOut: !answered };
}

/**
 * One prompt-wait run. The first half is committed and answered; the reading is how many
 * `session_send` calls that window carried. `0` is a hold, and only then does the second half
 * follow — the adaptive shape that keeps a run that did not hold at a single response.
 */
async function runWait(
  run: ReturnType<typeof createRun>,
  label: string,
  instructions: string,
  halves: Buffer[],
): Promise<WaitRun> {
  const events: ProbeEvent[] = [];
  const session = await openSession({
    run,
    label,
    instructions,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody({ turn_detection: null }),
    executor: { session_send: (args) => ({ queued: true, message: args.message ?? null }) },
    respondToToolOutputs: false,
    onEvent: (event) => events.push(event),
  });

  const warm = await session.waitFor(() => session.updatedMs !== null, 20_000);
  let callsAfterFragment1 = 0;
  let continuationSent = false;
  let callsAfterContinuation: number | null = null;
  let forwardedMessage: string | null = null;
  let timedOut = !warm;

  if (warm) {
    const first = await sendFragmentAndAnswer(session, events, halves[0] as Buffer);
    callsAfterFragment1 = first.calls;
    timedOut = first.timedOut;
    if (first.calls === 0 && halves.length > 1) {
      continuationSent = true;
      const second = await sendFragmentAndAnswer(session, events, halves[1] as Buffer);
      callsAfterContinuation = second.calls;
      timedOut = timedOut || second.timedOut;
      const calls = sessionSendFrames(events);
      forwardedMessage = calls.length === 0 ? null : (calls[calls.length - 1] as { message: string | null }).message;
    }
  }

  const record: WaitRun = {
    label,
    sessionId: session.sessionId,
    responses: session.responses.length,
    callsAfterFragment1,
    held: callsAfterFragment1 === 0,
    continuationSent,
    callsAfterContinuation,
    forwardedOnceAfterContinuation: callsAfterContinuation === null ? null : callsAfterContinuation === 1,
    forwardedMessage,
    timedOut,
    errors: session.errors,
    errorFrames: countSessionErrors(events, session.errors),
    spendCny: session.spendCny,
    exchange: summarizeExchange(session.events),
    events: elideAudio(events),
  };
  await session.close();
  return record;
}

/** One control-plane probe: open a session with a `turn_detection.type`, record the echo. */
async function probeVadType(
  run: ReturnType<typeof createRun>,
  label: string,
  type: string,
): Promise<{
  label: string;
  type: string;
  sessionId: string | null;
  updated: boolean;
  echo: Record<string, unknown> | null;
  errors: P0Session['errors'];
  spendCny: number;
  events: ProbeEvent[];
}> {
  const events: ProbeEvent[] = [];
  const session = await openSession({
    run,
    label,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody({ turn_detection: { type } }),
    executor: { session_send: (args) => ({ queued: true, message: args.message ?? null }) },
    respondToToolOutputs: false,
    onEvent: (event) => events.push(event),
  });
  const updated = await session.waitFor(() => session.updatedMs !== null, 20_000);
  await sleep(200);
  const record = {
    label,
    type,
    sessionId: session.sessionId,
    updated,
    echo: echoedTurnDetection(session),
    errors: session.errors,
    spendCny: session.spendCny,
    events: elideAudio(events),
  };
  await session.close();
  return record;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const repsArg = process.argv.find((arg) => arg.startsWith('--reps='));
  const repetitions = repsArg ? Number(repsArg.split('=')[1]) : DEFAULT_REPETITIONS;

  const audio = readPcm(AUDIO_REL);
  const half = Math.floor(audio.bytes.length / 2);
  const halves = [audio.bytes.subarray(0, half), audio.bytes.subarray(half)];
  const instructions = VOICE_REALTIME_INSTRUCTIONS + HOLD_RULE;
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });

  // ── route 1: the control plane, which costs no responses (no audio is ever sent) ──────────────
  const semantic = await probeVadType(run, 's4-vad-semantic', SEMANTIC_TYPE);
  const bogus = !run.guardTriggered ? await probeVadType(run, 's4-vad-bogus', BOGUS_TYPE) : null;

  // ── route 2: prompt-level waiting ────────────────────────────────────────────────────────────
  const waits: WaitRun[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    if (run.guardTriggered) break;
    waits.push(await runWait(run, `s4-wait-r${repetition}`, instructions, halves));
  }

  const semanticAccepted = semantic.echo?.type === SEMANTIC_TYPE;
  const bogusAccepted = bogus?.echo?.type === BOGUS_TYPE;
  const heldCount = waits.filter((wait) => wait.held).length;
  const forwardedOnceCount = waits.filter((wait) => wait.forwardedOnceAfterContinuation === true).length;

  // Derived, never declared: the criterion re-derives these from the same frames.
  const evidence = {
    semanticAccepted,
    bogusAccepted,
    echoDiscriminates: semanticAccepted && !bogusAccepted,
    promptWaitRepetitions: waits.length,
    promptWaitHeld: heldCount,
    promptWaitForwardedImmediately: waits.filter((wait) => !wait.held).length,
    promptWaitForwardedOnceAfterContinuation: forwardedOnceCount,
    responsesTotal: waits.reduce((sum, wait) => sum + wait.responses, 0),
    errorFrames:
      semantic.errors.length +
      (bogus?.errors.length ?? 0) +
      waits.reduce((sum, wait) => sum + wait.errorFrames, 0),
  };

  const verdict =
    evidence.echoDiscriminates || (waits.length > 0 && heldCount === waits.length && forwardedOnceCount === waits.length)
      ? 'supported'
      : waits.length === 0
        ? 'inconclusive'
        : heldCount === 0
          ? 'unsupported'
          : 'inconclusive';

  const trace = {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S4',
    stageTitle: '语义端点（turn_detection 语义取值是否被接受 / 提示词层面的等待是否可靠）',
    question:
      'turn_detection.type 取语义类取值时，该模型是「接受」还是「拒绝」？若控制面读数不可信，提示词层面的等待能否可靠地保住未说完的片段？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: 'qwen3.8-omni-flash-realtime',
    instructionsChars: instructions.length,
    holdRule: HOLD_RULE,
    tool: SESSION_SEND_TOOL.name,
    audio: {
      file: AUDIO_REL,
      sha256: audio.sha256,
      durationSeconds: audio.seconds,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      chunkMs: CHUNK_MS,
      halves: halves.map((bytes) => Number((bytes.length / 2 / SAMPLE_RATE).toFixed(3))),
    },
    control: { semantic, bogus },
    waits,
    evidence,
    verdict,
    spendCny: run.spendCny,
    budgetCny: BUDGET_CNY,
    guardTriggered: run.guardTriggered,
    notes: '',
  };

  trace.notes =
    `semantic_vad echoed=${semanticAccepted} bogus(${BOGUS_TYPE}) echoed=${bogusAccepted} ` +
    `echoDiscriminates=${evidence.echoDiscriminates} | ` +
    `wait runs=${waits.length}: held=${evidence.promptWaitHeld} forwardedImmediately=${evidence.promptWaitForwardedImmediately} ` +
    `forwardedOnceAfterContinuation=${evidence.promptWaitForwardedOnceAfterContinuation} | ` +
    `spend=¥${run.spendCny.toFixed(6)}`;

  const written = writeTrace('s4-semantic-endpoint.json', trace, apiKey);
  console.log(`S4 verdict=${verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  console.log(`  ${trace.notes}`);
  console.log(`  ${written.file} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  process.exit(0);
}

main().catch((error) => {
  console.error('S4 probe failed:', error);
  process.exit(1);
});
