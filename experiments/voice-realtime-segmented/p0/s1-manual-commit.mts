/**
 * S1 — does the MANUAL audio path work on the live endpoint?
 *
 * THE QUESTION. `docs/proposals/voice-realtime-segmented-relay-SPEC.md` "提交方式（需 P0 验证）" wants
 * CloudCLI to own the segmentation: turn the upstream's own VAD OFF (`session.update` with
 * `turn_detection: null`) and, at the end of a segment, send `input_audio_buffer.commit` followed by
 * `response.create`. `turn_detection: null` has only ever been exercised on TEXT turns in this repo
 * (`experiments/voice-realtime-prompt/prompt-probe.mts`); whether an AUDIO buffer can be committed by
 * hand has never been tested. If it cannot, P1 falls back to "server VAD + real silence between
 * segments".
 *
 * WHAT IS SENT. Two attempts on the same connection shape, both through the shipping transport:
 *
 *   single-commit   one 12-second utterance appended in 100 ms chunks, then ONE commit + response.
 *   two-segment     the same audio split in half, appended as two segments with a commit + response
 *                   after each — the shape P1 would use per segment, on ONE session.
 *
 * WHAT IS READ. The transport's own frame observer, both directions, in arrival order. The verdict
 * is NOT written by hand: `scripts/voice-realtime-p0-record-check.mjs` re-derives it from this trace
 * (see `deriveS1`) and reds if `RESULT.json` disagrees.
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx experiments/voice-realtime-segmented/p0/s1-manual-commit.mts
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
const BUDGET_CNY = 0.01;
const CHUNK_MS = 100;
const SAMPLE_RATE = 16_000;
const BYTES_PER_FRAME = (SAMPLE_RATE * CHUNK_MS) / 1000 * 2;
/** How long one commit→response may take before the attempt is called inconclusive. */
const RESPONSE_WINDOW_MS = 45_000;

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

type Attempt = {
  label: string;
  segments: number;
  sessionId: string | null;
  sessionCreatedMs: number | null;
  sessionUpdatedMs: number | null;
  commitsSent: number;
  responseCreatesSent: number;
  responses: P0Session['responses'];
  errors: P0Session['errors'];
  functionCalls: P0Session['functionCalls'];
  spendCny: number;
  /** Errors as the frames recorded them, so the criterion can recount them. */
  errorFrames: number;
  exchange: ReturnType<typeof summarizeExchange>;
  events: ProbeEvent[];
  /** True when nothing at all came back inside the window. */
  timedOut: boolean;
};

/**
 * One attempt: `turn_detection: null`, `chunks` audio segments, a commit + response after each.
 * Every segment's outcome is read off the frames, never assumed.
 */
async function runAttempt(
  run: ReturnType<typeof createRun>,
  label: string,
  segments: Buffer[],
  instructions: string,
): Promise<Attempt> {
  const events: ProbeEvent[] = [];
  const session = await openSession({
    run,
    label,
    instructions,
    tools: [SESSION_SEND_TOOL],
    sessionDefaults: sessionBody({ turn_detection: null }),
    executor: { session_send: (args) => ({ queued: true, message: args.message ?? null }) },
    // A tool result must not re-read the whole session: the relay has nothing to say about it.
    respondToToolOutputs: false,
    onEvent: (event) => events.push(event),
  });

  const sessionUpdated = await session.waitFor(() => session.updatedMs !== null, 15_000);
  let commitsSent = 0;
  let responseCreatesSent = 0;
  let timedOut = false;

  if (sessionUpdated) {
    for (const segment of segments) {
      const before = session.responses.length;
      appendPcm(session, segment);
      await sleep(200);
      session.sendRaw({ type: 'input_audio_buffer.commit' });
      commitsSent += 1;
      await sleep(150);
      session.sendRaw({ type: 'response.create' });
      responseCreatesSent += 1;
      // Either a response, or a recorded error, is an answer; silence is not.
      const answered = await session.waitFor(
        () => session.responses.length > before || session.errors.length > 0,
        RESPONSE_WINDOW_MS,
      );
      if (!answered) timedOut = true;
      await sleep(400);
    }
  }

  const attempt: Attempt = {
    label,
    segments: segments.length,
    sessionId: session.sessionId,
    sessionCreatedMs: session.createdMs,
    sessionUpdatedMs: session.updatedMs,
    commitsSent,
    responseCreatesSent,
    responses: session.responses,
    errors: session.errors,
    functionCalls: session.functionCalls,
    spendCny: session.spendCny,
    errorFrames: countSessionErrors(events, session.errors),
    exchange: summarizeExchange(session.events),
    events: elideAudio(events),
    timedOut: timedOut && session.responses.length === 0,
  };
  await session.close();
  return attempt;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const audio = readPcm(AUDIO_REL);
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });
  const instructions = VOICE_REALTIME_INSTRUCTIONS;

  const half = Math.floor(audio.bytes.length / 2);
  const attempts: Attempt[] = [];
  attempts.push(await runAttempt(run, 'single-commit', [audio.bytes], instructions));
  if (!run.guardTriggered) {
    attempts.push(
      await runAttempt(run, 'two-segment', [audio.bytes.subarray(0, half), audio.bytes.subarray(half)], instructions),
    );
  }

  const commitsSent = attempts.reduce((sum, attempt) => sum + attempt.commitsSent, 0);
  // The first error's own words go into the trace, because AC3 accepts "a recorded error and its
  // text" in place of a forward — and a trace that recorded an error without its text would satisfy
  // neither half of that.
  const firstError = attempts.flatMap((attempt) => attempt.errors)[0] ?? null;

  // Derived, never declared: the reader in the criterion re-derives it from the same fields.
  const evidence = {
    manualSessionBodySent: attempts.some((attempt) =>
      attempt.events.some(
        (event) =>
          event.direction === 'sent' &&
          event.wire.type === 'session.update' &&
          (event.wire.session as Record<string, unknown> | undefined)?.turn_detection === null,
      ),
    ),
    commitsSent,
    responseCreatesSent: attempts.reduce((sum, attempt) => sum + attempt.responseCreatesSent, 0),
    responsesCompleted: attempts.reduce((sum, attempt) => sum + attempt.responses.length, 0),
    sessionSendCalls: attempts.reduce((sum, attempt) => sum + sessionSendFrames(attempt.events).length, 0),
    errorFrames: attempts.reduce((sum, attempt) => sum + attempt.errorFrames, 0),
  };

  const trace = {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S1',
    stageTitle: '手动音频提交（turn_detection: null + input_audio_buffer.commit + response.create）',
    question:
      'CloudCLI 切分后，上游能否关闭自己的 VAD，由我们在段尾手动 commit 音频并触发响应？',
    ranAt,
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    model: attempts[0] ? 'qwen3.8-omni-flash-realtime' : null,
    instructionsChars: instructions.length,
    tool: SESSION_SEND_TOOL.name,
    audio: {
      file: AUDIO_REL,
      sha256: audio.sha256,
      durationSeconds: audio.seconds,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      chunkMs: CHUNK_MS,
    },
    attempts: attempts.map((attempt) => ({
      label: attempt.label,
      segments: attempt.segments,
      sessionId: attempt.sessionId,
      sessionCreatedMs: attempt.sessionCreatedMs,
      sessionUpdatedMs: attempt.sessionUpdatedMs,
      commitsSent: attempt.commitsSent,
      responseCreatesSent: attempt.responseCreatesSent,
      responses: attempt.responses,
      errors: attempt.errors,
      functionCalls: attempt.functionCalls,
      spendCny: attempt.spendCny,
      errorFrames: attempt.errorFrames,
      timedOut: attempt.timedOut,
      exchange: attempt.exchange,
      events: attempt.events,
    })),
    /** The first error's own words, or `null`. AC3 accepts an error in place of a forward — with it. */
    firstError,
    evidence,
    // The SAME rule `deriveS1` in scripts/voice-realtime-p0-record-check.mjs applies to this trace.
    // Written here so the file is readable on its own; the criterion re-derives it and reds when the
    // two disagree, which is what makes it a reading rather than a claim.
    verdict:
      evidence.errorFrames > 0 && evidence.sessionSendCalls === 0
        ? 'unsupported'
        : evidence.sessionSendCalls > 0 && evidence.manualSessionBodySent && evidence.commitsSent > 0
          ? 'supported'
          : 'inconclusive',
    spendCny: run.spendCny,
    budgetCny: BUDGET_CNY,
    guardTriggered: run.guardTriggered,
    notes: '',
  };

  trace.notes =
    `commits=${evidence.commitsSent} responses=${evidence.responsesCompleted} ` +
    `session_send calls=${evidence.sessionSendCalls} error frames=${evidence.errorFrames}`;

  const written = writeTrace('s1-manual-commit.json', trace, apiKey);
  console.log(`S1 verdict=${trace.verdict} spend=¥${run.spendCny.toFixed(6)} guard=${run.guardTriggered}`);
  console.log(`  ${trace.notes}`);
  console.log(`  ${written.file} (${written.bytes} bytes, scrubbed=${written.scrubbed})`);
  process.exit(0);
}

main().catch((error) => {
  console.error('S1 probe failed:', error);
  process.exit(1);
});
