/**
 * Precision probe: omission + self-duplication WITHOUT ASR noise.
 *
 * Feeds are built from TTS fixtures with KNOWN scripts (paired.json), trimmed to their spoken span
 * and concatenated with 1000 ms silence gaps, so the endpoint's VAD splits them into 2-3 items.
 * Scoring is against the KNOWN reference text (code-identifier anchors the model cannot paraphrase),
 * never against the endpoint's own transcription — which the earlier rounds showed is unreliable.
 *
 * Arms (model-only, real DashScope, no settle producer):
 *   K   shipped VOICE_REALTIME_INSTRUCTIONS.
 *   E1  K + per-item obligation clause.
 *   E2  E1 + PENDING USER ITEMS list injected after each final transcription (ASR-based, as production).
 *
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-relay-known-text/run.mts --arms K,E1,E2 --reps 3
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRun, openSession, readApiKey, sleep, sessionBody, type P0Session, type ProbeEvent } from '../voice-realtime-segmented/p0/probe-lib.mts';
import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const REPO = path.resolve(HERE, '../..');
const FIXTURES = path.join(REPO, 'experiments/voice-provider-paired-quality/fixtures');
const PAIRED = path.join(FIXTURES, 'paired.json');
const UPLINK_VAD_WEIGHTS = '/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx';
const BUDGET_CNY = 0.4;
const DRAIN_MS = 9_000;
const CONCURRENCY = 12;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

// ── known-text spans: clips + reference + the verbatim-preserved anchor per item ─────────────────
type Clip = { file: string; reference: string; anchor: string };
const CLIPS: Record<string, Clip> = {
  d01: { file: 'd01-o65.wav', reference: '把 server 里的 voice.service.ts 的超时改成三十秒', anchor: 'voice.service.ts' },
  d03: { file: 'd03-o65.wav', reference: '看一下 useVoiceInput 这个 hook 是怎么处理 recording 的', anchor: 'usevoiceinput' },
  d04: { file: 'd04-o65.wav', reference: '不要动 voice.service.ts，只改 voice.module.ts', anchor: 'voice.module.ts' },
  d08: { file: 'd08-o65.wav', reference: '把默认模型换成 whisper large，啊不，是 whisper turbo', anchor: 'whisper' },
};

type Span = { id: string; clips: string[] };
const SPANS: Span[] = [
  { id: 'S1', clips: ['d01', 'd03'] },
  { id: 'S2', clips: ['d04', 'd08'] },
  { id: 'S3', clips: ['d01', 'd03', 'd08'] },
];

const OBLIGATION =
  'EVERY user item that has arrived since your last `session_send` MUST appear in this message, in order. ' +
  'You may merge several items into one sentence and fix recognition slips, but you may not omit any item. ' +
  'If you are unsure whether an item belongs, keep it verbatim. When several items are pending, the message must contain all of them.';

type Arm = 'K' | 'E1' | 'E2';
const armSpec = (arm: Arm): { base: string; injectPending: boolean } => ({
  base: arm === 'K' ? VOICE_REALTIME_INSTRUCTIONS : `${VOICE_REALTIME_INSTRUCTIONS} ${OBLIGATION}`,
  injectPending: arm === 'E2',
});

// ── scoring against known text ──────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/[\s，。！？、,.!?"“”'’：:；;（）()\-]/g, '');
const ngrams = (s: string, n = 4): Set<string> => {
  const c = s.replace(/\s/g, '');
  const out = new Set<string>();
  for (let i = 0; i + n <= c.length; i += 1) out.add(c.slice(i, i + n));
  return out;
};
const recall = (ref: string, msg: string): number => {
  const a = ngrams(ref);
  if (a.size === 0) return norm(ref) === '' ? 1 : 0;
  const b = ngrams(msg);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / a.size;
};

// ── audio: read + trim + concatenate ────────────────────────────────────────────────────────────
const FRAME_BYTES = 640; // 20 ms @ 16 kHz mono PCM16

function readWavPcm16(file: string): { pcm: Buffer; sampleRate: number; channels: number } {
  const buf = readFileSync(file);
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
    }
    if (id === 'data') return { pcm: buf.subarray(off + 8, off + 8 + size), sampleRate, channels };
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function frameRms(frame: Buffer): number {
  let sum = 0;
  for (let s = 0; s < 320; s += 1) {
    const v = frame.readInt16LE(s * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / 320);
}

function trimSpeech(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / FRAME_BYTES);
  const rms: number[] = [];
  for (let i = 0; i < n; i += 1) rms.push(frameRms(pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)));
  const THR = 300;
  const GAP_KEEP_FRAMES = 10; // 200 ms of silence kept between words; longer gaps compressed
  const out: Buffer[] = [];
  let gap = 0;
  let started = false;
  for (let i = 0; i < n; i += 1) {
    const frame = pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
    if (rms[i]! >= THR) {
      out.push(frame);
      started = true;
      gap = 0;
    } else if (started && gap < GAP_KEEP_FRAMES) {
      out.push(frame);
      gap += 1;
    }
    // else: leading silence, or a long internal gap past the kept window — dropped.
  }
  return Buffer.concat(out);
}

const GAP_MS = Number(arg('gap', '1000'));

function buildSpanFeed(span: Span): Buffer {
  const lead = Buffer.alloc(600 * 16);
  const gap = Buffer.alloc(Math.round((GAP_MS / 1000) * 16_000) * 2);
  const tail = Buffer.alloc(1200 * 16);
  const parts: Buffer[] = [lead];
  for (const id of span.clips) {
    const clip = CLIPS[id]!;
    const { pcm, sampleRate, channels } = readWavPcm16(path.join(FIXTURES, clip.file));
    if (sampleRate !== 16_000) throw new Error(`${clip.file} is ${sampleRate} Hz`);
    if (channels !== 1) throw new Error(`${clip.file} is ${channels}-channel`);
    parts.push(trimSpeech(pcm), gap);
  }
  parts.push(tail);
  return Buffer.concat(parts);
}

// ── one run ─────────────────────────────────────────────────────────────────────────────────────
const SHIPPED_RESULT = {
  accepted: true,
  instruction: 'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
};

const runOne = async (
  run: ReturnType<typeof createRun>,
  span: Span,
  arm: Arm,
  rep: number,
): Promise<Record<string, unknown>> => {
  const spec = armSpec(arm);
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: 800 });

  const finals: Array<{ t: number; text: string }> = [];
  const calls: Array<{ t: number; message: string }> = [];
  const pending: Array<{ t: number; text: string }> = [];
  const doneStatuses: string[] = [];
  let responseCreated = 0;
  let session: P0Session | null = null;

  const onEvent = (event: ProbeEvent): void => {
    if (event.direction !== 'received') return;
    const wire = event.wire as Record<string, unknown>;
    const type = String(wire.type ?? '');
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(wire.transcript ?? '').trim();
      if (text !== '') {
        finals.push({ t: event.atMs, text });
        if (spec.injectPending) pending.push({ t: event.atMs, text });
      }
    } else if (type === 'response.function_call_arguments.done' && wire.name === 'session_send') {
      let message = '';
      try { message = String(JSON.parse(String(wire.arguments ?? '{}')).message ?? ''); } catch { /* raw */ }
      if (message !== '') { calls.push({ t: event.atMs, message }); pending.length = 0; }
    } else if (type === 'response.created') {
      responseCreated += 1;
    } else if (type === 'response.done') {
      const resp = (wire.response ?? {}) as { status?: string };
      doneStatuses.push(String(resp.status ?? '?'));
    }
  };

  session = await openSession({
    run,
    label: `${span.id}-${arm}-${rep}`,
    instructions: spec.base,
    sessionDefaults: sessionBody({ turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 } }),
    tools: VOICE_REALTIME_TOOLS as never,
    respondToToolOutputs: true,
    executor: {
      session_send: () => SHIPPED_RESULT,
      session_interrupt: (args: Record<string, unknown>) => ({
        aborted: true, message: args.message, runId: 'replay-run', triggerSeq: null, queuedStillPending: 0,
      }),
    },
    onEvent,
  });

  const feed = buildSpanFeed(span);
  const frames: string[] = [];
  for (let off = 0; off + FRAME_BYTES <= feed.length; off += FRAME_BYTES) frames.push(feed.subarray(off, off + FRAME_BYTES).toString('base64'));

  const t0 = Date.now();
  let injectCursor = 0;
  const injectPending = (): void => {
    if (!spec.injectPending || session === null || pending.length === 0) return;
    if (injectCursor === pending.length) return;
    injectCursor = pending.length;
    const list = pending.map((t, i) => `${i + 1}) ${t}`).join('\n');
    session.setInstructions(`${spec.base}\n\nPENDING USER ITEMS (not yet relayed, in order):\n${list}`);
  };

  for (let i = 0; i < frames.length; i += 1) {
    const decision = await gate.observe(frames[i]!);
    for (const f of decision.frames) session.sendAudioBase64(f);
    if (decision.closeTurn) session.sendRaw({ type: 'input_audio_buffer.commit' });
    injectPending();
    const wait = t0 + (i + 1) * 20 - Date.now();
    if (wait > 0) await sleep(wait);
  }
  const drainUntil = Date.now() + DRAIN_MS;
  while (Date.now() < drainUntil) { injectPending(); await sleep(50); }

  await gate.close().catch(() => undefined);
  await session.close().catch(() => undefined);

  // model-only coverage: reword-tolerant (4-gram recall >= 0.5), NOT identifier-fidelity. The delivery-level
  // lost/dup counts are computed by the settle simulator over these recorded finals + calls.
  const union = calls.map((c) => c.message).join(' ');
  const items = span.clips.map((id) => ({ id, ...CLIPS[id]! }));
  const perItem = items.map((c) => ({ clip: c.id, covered: recall(c.reference, union) >= 0.5 }));
  const omitted = perItem.filter((p) => !p.covered).map((p) => p.clip);

  return {
    span: span.id,
    arm,
    rep,
    gapMs: GAP_MS,
    spendCny: session.spendCny,
    responseCreated,
    doneStatuses,
    finals,
    calls,
    perItem,
    omitted,
    errors: session.errors.map((e) => String((e.wire as Record<string, unknown>).error ?? JSON.stringify(e.wire).slice(0, 120))),
  };
};

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  const arms = arg('arms', 'K,E1,E2').split(',').filter(Boolean) as Arm[];
  const reps = Number(arg('reps', '3'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} (fresh) · spans S1,S2,S3 · arms ${arms.join(',')} · reps ${reps}`);

  const jobs: Array<() => Promise<Record<string, unknown>>> = [];
  for (const span of SPANS) for (const arm of arms) for (let rep = 0; rep < reps; rep += 1) jobs.push(() => runOne(run, span, arm, rep));

  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY).map((f) => f());
    const settled = await Promise.allSettled(batch);
    results.push(...settled.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason) })));
    console.log(`progress ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length} · spend ¥${run.spendCny.toFixed(4)}`);
  }

  for (const r of results) {
    if ('error' in r) { console.log(`ERROR ${r.error}`); continue; }
    const x = r as Record<string, unknown>;
    console.log(`\n=== ${x.span} ${x.arm}#${x.rep}  gap=${x.gapMs}  resp=${x.responseCreated} done=${JSON.stringify(x.doneStatuses)}  omitted=${JSON.stringify(x.omitted)}`);
    console.log(`  finals: ${JSON.stringify(x.finals)}`);
    console.log(`  calls : ${JSON.stringify(x.calls)}  spend=¥${x.spendCny}`);
  }

  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(HERE, 'traces', `run-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), budgetCny: BUDGET_CNY, spendCny: Number(run.spendCny.toFixed(6)), guardTriggered: run.guardTriggered, results }, null, 2)}\n`);
  console.log(`\nspend ¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} · guard=${run.guardTriggered}`);
  console.log(`trace: ${file}`);
  process.exit(0);
};

void main();
