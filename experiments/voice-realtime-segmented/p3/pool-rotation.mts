/**
 * P3 — the upstream SESSION POOL on the LIVE endpoint: a warm standby, an idle rotation, and the
 * segment that straddles the switch.
 *
 * THE QUESTION the DoD asks, and that nothing in this repository can answer: put a real person's
 * sentence through the shipping pool, wait past the idle threshold, put a second one through — do
 * BOTH reach the session they were bound to, does the pool rotate exactly once in between, and how
 * long does that switch cost?
 *
 * WHY THE SHIPPING POOL AND NOT A RE-ENACTMENT. `createUpstreamPool` is what a deployment runs
 * (`server/index.ts` wires it under `VOICE_REALTIME_IDLE_ROTATE_MS`). A probe that drove two
 * sessions itself would be measuring the probe: the interesting readings — WHEN the pool considers
 * the connection idle, WHICH session the next frame lands on, and the trigger→flip latency it
 * reports — only exist inside the pool. So every session here is opened BY the pool, through its
 * `createSession` seam, and the probe only drives the public `RealtimeBridge` surface the proxy
 * drives.
 *
 * WHY A REAL SOCKET RATHER THAN A STAND-IN. Same reason as P0: `session.updated` warm-up, the
 * manual-commit path and the response to a real utterance are properties of the service. The
 * stand-in used by the criterion test can show the pool's own bookkeeping; only this can show that
 * the session it switches to actually ANSWERS.
 *
 * WHY IT IS CHEAP. Two utterances and no tool loop: the budget guard below prices every
 * `response.done` on the tick it arrives with the shipping estimator and closes every socket on the
 * first crossing, so "≤ ¥0.02" is enforced rather than promised. Rotations are free — a session
 * that creates no response costs nothing (P0/S2 measured the establishment itself at ¥0).
 *
 *     set -a; . ./.env.test; set +a
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p3/pool-rotation.mts
 *
 * Writes `experiments/voice-realtime-segmented/p3/RESULT.json` (the DoD's evidence) and prints the
 * same object. Exits non-zero when a verdict the DoD names did not hold, so the run cannot be
 * mistaken for a confirmation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import {
  connect,
  createDashscopeTransport,
  createUpstreamPool,
  estimateRealtimeCostCny,
  type DashscopeSocket,
  type DashscopeSocketFactory,
  type RealtimeBridge,
  type RealtimeBridgeHooks,
  type RealtimeToolExecutor,
  type UpstreamPoolRotation,
  VOICE_REALTIME_INSTRUCTIONS,
} from '../../../server/modules/voice-realtime/index.js';

import {
  SESSION_SEND_TOOL,
  createRun,
  elideAudio,
  readApiKey,
  scrubSecrets,
  sessionBody,
  sha256Hex,
  sleep,
  summarizeExchange,
  waitUntil,
  type P0Run,
  type ProbeEvent,
} from '../p0/probe-lib.mts';

const P3_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(P3_DIR, '../../..');
/** The same real utterance P0/S1 uses — a Chinese sentence at 16 kHz PCM16 in a canonical WAV. */
const AUDIO_REL = 'experiments/voice-trim/fixtures/zh-d01-o85.wav';
/** The DoD's budget. Two utterances and no tool loop spend well under it. */
const BUDGET_CNY = 0.02;
/**
 * The idle threshold, SHRUNK for the run: the SPEC's deployment default is 90 s and waiting it out
 * twice would make the DoD a lunch break. What is being verified is that the pool rotates ONCE per
 * idle period and how long the switch costs — neither depends on the threshold's value.
 */
const IDLE_ROTATE_MS = 3_000;
const CHUNK_MS = 100;
const SAMPLE_RATE = 16_000;
const BYTES_PER_FRAME = ((SAMPLE_RATE * CHUNK_MS) / 1000) * 2;
/**
 * How long one utterance's answer may take before the run calls it a timeout.
 *
 * Deliberately generous: a 12 s clip is answered in a few seconds on an idle endpoint, but the
 * endpoint is shared, and a run once saw the SECOND utterance still transcribing 45 s in. The
 * window is a wall-clock courtesy, not part of any reading — the cost of waiting longer is a
 * slower confirmation run, while the cost of waiting too little is a false "not delivered".
 */
const ANSWER_WINDOW_MS = 90_000;
/** How long to wait for the pool to rotate, once the first utterance has settled. */
const ROTATE_WINDOW_MS = IDLE_ROTATE_MS + 20_000;

/** The WAV's PCM payload, header stripped, with the identity the result records. */
function readPcm(rel: string): { bytes: Buffer; sha256: string; seconds: number } {
  const wav = readFileSync(path.join(REPO_ROOT, rel));
  const bytes = wav.subarray(44);
  return { bytes, seconds: Number((bytes.length / 2 / SAMPLE_RATE).toFixed(3)), sha256: sha256Hex(wav) };
}

/** The P0a-S2 session-open baseline, read from the result rather than hardcoded. */
function baselineBoundMs(): { source: string; maxMs: number; boundMs: number } {
  const file = path.join(REPO_ROOT, 'experiments/voice-realtime-segmented/p0/RESULT.json');
  const record = JSON.parse(readFileSync(file, 'utf8')) as {
    stages?: Array<{ stage?: string; notes?: string }>;
  };
  const s2 = record.stages?.find((stage) => stage.stage === 'S2');
  const max = /max=(\d+)ms/.exec(s2?.notes ?? '');
  if (max === null) {
    throw new Error(`no max=<n>ms reading in ${file} (S2 notes: ${s2?.notes ?? '<missing>'})`);
  }
  const maxMs = Number(max[1]);
  return {
    source: 'experiments/voice-realtime-segmented/p0/RESULT.json#S2.notes',
    maxMs,
    boundMs: Math.round(maxMs * 1.5),
  };
}

/** One session the pool opened, as the probe observed it from the transport's own frame tap. */
type SessionTap = {
  ordinal: number;
  events: ProbeEvent[];
  responses: Array<{ id: string | null; atMs: number; status: string | null; usage: unknown; spendCny: number }>;
  errors: Array<{ atMs: number; wire: Record<string, unknown> }>;
  functionCalls: Array<{ name: string | null; arguments: string | null; atMs: number }>;
  sessionId: string | null;
  updatedMs: number | null;
  closedByGuard: boolean;
  readonly appendsSent: number;
  readonly appendsAt: number[];
  readonly spendCny: number;
  closeForGuard(): void;
};

type Rig = {
  run: P0Run;
  taps: SessionTap[];
  logs: string[];
  rotations: UpstreamPoolRotation[];
  pool: ReturnType<typeof createUpstreamPool>;
};

/**
 * Builds the pool the way `server/index.ts` does — one real socket per session — and taps every
 * frame of every session so the result can say WHICH session each utterance reached.
 */
async function buildRig(apiKey: string): Promise<Rig> {
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey });
  const taps: SessionTap[] = [];
  const logs: string[] = [];

  const createSession = (hooks: RealtimeBridgeHooks): RealtimeBridge => {
    const ordinal = taps.length + 1;
    const events: ProbeEvent[] = [];
    const appendsAt: number[] = [];
    let spendCny = 0;
    let openedSocket: DashscopeSocket | null = null;
    let closedByGuard = false;

    const tap: SessionTap = {
      ordinal,
      events,
      responses: [],
      errors: [],
      functionCalls: [],
      sessionId: null,
      updatedMs: null,
      get closedByGuard() {
        return closedByGuard;
      },
      get appendsSent() {
        return appendsAt.length;
      },
      appendsAt,
      get spendCny() {
        return Number(spendCny.toFixed(6));
      },
      closeForGuard(): void {
        if (closedByGuard) return;
        closedByGuard = true;
        try {
          openedSocket?.close();
        } catch {
          // A socket that is already gone is exactly the state this closer wants.
        }
      },
    };
    taps.push(tap);

    const observer = (observation: { direction: 'sent' | 'received'; atMs: number; wire: unknown }): void => {
      const wire = (observation.wire ?? {}) as Record<string, unknown>;
      events.push({ direction: observation.direction, atMs: observation.atMs, sinceOpenMs: 0, wire });
      if (observation.direction === 'sent' && wire.type === 'input_audio_buffer.append') {
        appendsAt.push(observation.atMs);
      }
      if (observation.direction !== 'received') {
        return;
      }
      if (wire.type === 'session.updated' && tap.updatedMs === null) {
        tap.updatedMs = Date.now();
      }
      const session = wire.session as Record<string, unknown> | undefined;
      if (typeof session?.id === 'string') {
        tap.sessionId = session.id;
      }
      if (wire.type === 'error') {
        tap.errors.push({ atMs: observation.atMs, wire });
      }
      // The relay's own delivery: the model calling `session_send` with what it heard. Kept as its
      // own reading because "the sentence reached the bound session" IS this frame.
      if (wire.type === 'response.function_call_arguments.done') {
        tap.functionCalls.push({
          name: typeof wire.name === 'string' ? wire.name : null,
          arguments: typeof wire.arguments === 'string' ? wire.arguments : null,
          atMs: observation.atMs,
        });
      }
      if (wire.type === 'response.done') {
        const response = (wire.response ?? {}) as Record<string, unknown>;
        const raw = estimateRealtimeCostCny(response.usage ?? null);
        const cost = Number.isFinite(raw) ? raw : 0;
        spendCny += cost;
        tap.responses.push({
          id: typeof response.id === 'string' ? response.id : null,
          atMs: observation.atMs,
          status: typeof response.status === 'string' ? response.status : null,
          usage: response.usage ?? null,
          spendCny: Number(cost.toFixed(6)),
        });
        run.guard.observeUsage(response.usage ?? null);
      }
    };

    const socketFactory: DashscopeSocketFactory = (url, headers) => {
      const ws = new WebSocket(url, { headers });
      const socket: DashscopeSocket = {
        send: (data: string) => ws.send(data),
        close: (code?: number, reason?: string) => ws.close(code, reason),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      ws.on('open', () => socket.onopen?.({}));
      ws.on('message', (data) => socket.onmessage?.({ data: data.toString() }));
      ws.on('error', (error) => socket.onerror?.(error));
      ws.on('close', (code, reason) => socket.onclose?.({ code, reason: String(reason) }));
      openedSocket = socket;
      return socket;
    };

    const transport = createDashscopeTransport({
      apiKey,
      // The model/voice pair P0 proved out. `voice` is NOT optional here: left unset the endpoint
      // falls back to `Chelsie`, which this model REJECTS — and it rejects it only at
      // `response.create`, after `session.update` has been accepted, so the session looks healthy
      // and every utterance dies with `<400> Voice 'Chelsie' is not supported.`
      model: 'qwen3.8-omni-flash-realtime',
      voice: 'Tina',
      sessionDefaults: sessionBody(),
      socketFactory,
      observer,
      // A session that never opens has to SAY why: without this the trace for a failed standby is
      // empty, and "the spare never warmed" is indistinguishable from "the spare was never dialled".
      onError: (error) => {
        tap.errors.push({ atMs: Date.now(), wire: { type: 'transport.error', ...error } });
      },
    });

    const executor: RealtimeToolExecutor = { session_send: () => ({ queued: true }) };

    // The guard's closer is the SOCKET, not the bridge: on the crossing the connection has to go
    // down on that tick, before anything else can be sent (P0's rule, unchanged).
    run.register(tap.closeForGuard);

    return connect(transport, [SESSION_SEND_TOOL], executor, {
      maxConnectAttempts: 1,
      hooks,
      segment: { commitMode: 'manual' },
    });
  };

  const pool = createUpstreamPool({
    createSession,
    idleRotateMs: IDLE_ROTATE_MS,
    log: (line) => {
      logs.push(line);
    },
  });

  return { run, taps, logs, rotations: [...pool.rotations], pool };
}

/** Appends one PCM buffer as the browser's relay would: `CHUNK_MS` frames, in order. */
function sendSegment(pool: ReturnType<typeof createUpstreamPool>, seq: number, pcm: Buffer): number {
  pool.startSegment(seq);
  let frames = 0;
  for (let offset = 0; offset < pcm.length; offset += BYTES_PER_FRAME) {
    const chunk = pcm.subarray(offset, Math.min(offset + BYTES_PER_FRAME, pcm.length));
    pool.sendSegmentAudio(seq, chunk.toString('base64'));
    frames += 1;
  }
  pool.endSegment(seq);
  return frames;
}

async function main(): Promise<void> {
  const apiKey = readApiKey();
  const ranAt = new Date().toISOString();
  const audio = readPcm(AUDIO_REL);
  const bound = baselineBoundMs();
  const rig = await buildRig(apiKey);
  const { pool, run } = rig;

  await pool.whenConnected();
  // The session body (voice, formats, modalities) travels with the FIRST `session.update`, which is
  // this one — for the active session AND the standby, whose own `session.updated` is what "warm"
  // means. The probe never sends audio to the standby; the pool is what decides that.
  pool.sendSessionUpdate(VOICE_REALTIME_INSTRUCTIONS);

  // ── utterance 1, on the session the pool opened first ──────────────────────────────────────────
  const firstSession = rig.taps[0];
  const firstFrames = sendSegment(pool, 1, audio.bytes);
  const firstAnswered = await waitUntil(
    () => (firstSession?.responses.length ?? 0) > 0 || (firstSession?.errors.length ?? 0) > 0,
    ANSWER_WINDOW_MS,
  );
  const activeBeforeRotation = rig.taps.find((tap) => tap.ordinal === pool.activeOrdinal)?.ordinal ?? null;

  // ── wait the idle threshold out, so the pool rotates while nothing is in flight ────────────────
  const rotationsBefore = rig.rotations.length;
  const rotated = await waitUntil(() => pool.rotations.length > rotationsBefore, ROTATE_WINDOW_MS);
  rig.rotations = [...pool.rotations];
  const rotation = rig.rotations[0] ?? null;
  const rotationLogAt = rig.logs.length;
  const activeAfterRotation = pool.activeOrdinal;
  const standbyAppendsAtRotation = rotation === null ? null : (rig.taps[1]?.appendsSent ?? null);

  // ── utterance 2, after the switch: it must land on the NEW session and be answered there ───────
  const secondSession = rig.taps.find((tap) => tap.ordinal === activeAfterRotation) ?? null;
  const secondBefore = secondSession?.responses.length ?? 0;
  const secondFrames = sendSegment(pool, 2, audio.bytes);
  const secondAnswered = await waitUntil(
    () => (secondSession?.responses.length ?? 0) > secondBefore || (secondSession?.errors.length ?? 0) > 0,
    ANSWER_WINDOW_MS,
  );
  await sleep(300);

  // The pool refills its spare OFF the hot path, right after the flip. Wait (bounded) for that
  // refill so the result shows the whole cycle — rotate AND replace — rather than a pool that
  // rotated once and stopped. Waiting costs nothing: a session that creates no response is free.
  const standbyAfterRotation = pool.standbyOrdinal;
  const refillWarmed = await waitUntil(() => {
    const tap = rig.taps.find((candidate) => candidate.ordinal === standbyAfterRotation);
    return tap !== undefined && tap.updatedMs !== null;
  }, 15_000);

  // ── the rulings ───────────────────────────────────────────────────────────────────────────────
  const firstResponse = firstSession?.responses[0] ?? null;
  const secondResponse = secondSession?.responses[0] ?? null;
  const rotateLines = rig.logs.filter((line) => line.includes('rotate from='));
  const verdicts = {
    /** ① the first utterance was answered on the session the pool started with. */
    firstUtteranceDeliveredToOriginalSession:
      firstAnswered && firstResponse !== null && firstSession?.ordinal === 1,
    /** ② exactly one rotation happened, and it is the pool's own record of it. */
    rotatedOnce: rotated && rig.rotations.length === 1,
    /** ③ the switch cost no more than the P0a-S2 session-open maximum × 1.5. */
    switchWithinBaseline: rotation !== null && rotation.switchMs <= bound.boundMs,
    /** ④ exactly one `rotate` line — the log the SPEC asks for. */
    oneRotateLogLine: rotateLines.length === 1,
    /** ⑤ the standby carried no audio while it was a standby. */
    standbySilentBeforeRotation: standbyAppendsAtRotation === 0,
    /** ⑥ the second utterance was answered on the session that took over. */
    secondUtteranceDeliveredToNewSession:
      secondAnswered &&
      secondResponse !== null &&
      secondSession !== null &&
      secondSession.ordinal === rotation?.to,
    /** ⑦ the pool put a fresh warm standby behind the new active session. */
    standbyRefilledAfterRotation: refillWarmed,
    guardHeld: !run.guardTriggered,
  };

  const payload = {
    schema: 'voice-realtime-p3-result/1',
    generatedBy: 'experiments/voice-realtime-segmented/p3/pool-rotation.mts',
    stage: 'P3',
    stageTitle: '上游会话池：热备、空闲轮换与跨切换的段',
    question: '真实上游上，空闲超阈值后是否恰好轮换一次、切换耗时是否在基线内、切换前后的两句话是否都送达各自绑定的会话？',
    ranAt,
    budgetCny: BUDGET_CNY,
    spendCny: run.spendCny,
    guardTriggered: run.guardTriggered,
    guardClosedSessions: run.guardClosedSessions,
    idleRotateMs: IDLE_ROTATE_MS,
    baseline: bound,
    audio: { file: AUDIO_REL, sha256: audio.sha256, durationSeconds: audio.seconds, chunkMs: CHUNK_MS },
    verdicts,
    rotated,
    rotations: rig.rotations,
    rotateLogLines: rotateLines,
    log: rig.logs,
    utterances: [
      {
        seq: 1,
        frames: firstFrames,
        boundSessionOrdinal: 1,
        answeredOnOrdinal: firstResponse === null ? null : (firstSession?.ordinal ?? null),
        answered: firstAnswered,
        response: firstResponse,
        errors: firstSession?.errors ?? [],
      },
      {
        seq: 2,
        frames: secondFrames,
        boundSessionOrdinal: activeAfterRotation,
        answeredOnOrdinal: secondResponse === null ? null : (secondSession?.ordinal ?? null),
        answered: secondAnswered,
        response: secondResponse,
        errors: secondSession?.errors ?? [],
      },
    ],
    switchReadings: {
      activeBeforeRotation,
      activeAfterRotation,
      rotationLogAtLine: rotationLogAt,
      standbyAppendsBeforeRotation: standbyAppendsAtRotation,
      standbyAfterRotation,
      standbyRefilledAfterRotation: refillWarmed,
    },
    sessions: rig.taps.map((tap) => ({
      ordinal: tap.ordinal,
      sessionId: tap.sessionId,
      updatedMs: tap.updatedMs,
      appendsSent: tap.appendsSent,
      responses: tap.responses,
      errors: tap.errors,
      functionCalls: tap.functionCalls,
      spendCny: tap.spendCny,
      exchange: summarizeExchange(tap.events),
      events: elideAudio(tap.events),
    })),
  };

  const { text } = scrubSecrets(JSON.stringify(payload, null, 2), apiKey);
  const out = `${text}\n`;
  mkdirSync(P3_DIR, { recursive: true });
  writeFileSync(path.join(P3_DIR, 'RESULT.json'), out, 'utf8');

  await pool.close();
  console.log(out);

  const failed = Object.entries(verdicts)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  if (failed.length > 0) {
    console.error(`p3 pool-rotation: ${failed.join(', ')} did NOT hold`);
    process.exit(1);
  }
}

await main();
