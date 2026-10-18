/**
 * Stage 2-A: can prompt/context alone make the relay model relay EVERY user item?
 *
 * Six windows from four captures, four arms, three reps:
 *   K   shipped instructions, endpoint decides responses (create_response: true).
 *   K1  shipped instructions, create_response: false + explicit response.create per committed item —
 *       the "force the model to be asked" arm (isolates "asked but omitted" from "never asked").
 *   E1  K + per-item obligation clause.
 *   E2  E1 + a PENDING USER ITEMS list injected after each final transcription.
 *
 * Reading per arm: the model's own session_send messages vs the endpoint's finals — is every final
 * covered? (>=4 chars: 4-gram recall >= 0.5; <4 chars: substring). No text is added/rewritten.
 *
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-relay-coverage-obligation/run.mts --windows P1,C1,P2,P3,P4,C2 --arms K,K1,E1,E2 --reps 3
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
const CAPTURE_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-capture');
const UPLINK_VAD_WEIGHTS = '/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx';
const BUDGET_CNY = 0.45;
const DRAIN_MS = 9_000;
const CONCURRENCY = 16;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

// ── windows (offsets ms from each capture origin) ───────────────────────────────────────────────
const WINDOWS: Record<string, { capture: string; startMs: number; endMs: number }> = {
  P1: { capture: '0256124a', startMs: 1740, endMs: 10130 },
  C1: { capture: '0256124a', startMs: 15562, endMs: 25883 },
  P2: { capture: 'aa8388a1', startMs: 57387, endMs: 67734 },
  P3: { capture: '0256124a', startMs: 307238, endMs: 322812 },
  P4: { capture: '3d2d3b2c', startMs: 216518, endMs: 233854 },
  C2: { capture: '19906b68', startMs: 1078, endMs: 10856 },
};

const OBLIGATION =
  'EVERY user item that has arrived since your last `session_send` MUST appear in this message, in order. ' +
  'You may merge several items into one sentence and fix recognition slips, but you may not omit any item. ' +
  'If you are unsure whether an item belongs, keep it verbatim. When several items are pending, the message must contain all of them.';

type Arm = 'K' | 'K1' | 'E1' | 'E2';

const armSpec = (arm: Arm): { base: string; createResponse: boolean; injectPending: boolean } => {
  const base = arm === 'K' || arm === 'K1' ? VOICE_REALTIME_INSTRUCTIONS : `${VOICE_REALTIME_INSTRUCTIONS} ${OBLIGATION}`;
  return { base, createResponse: arm !== 'K1', injectPending: arm === 'E2' };
};

// ── scoring ────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/[\s，。！？、,.!?"“”'’：:；;（）()\-]/g, '');
const ngrams = (s: string, n = 4): Set<string> => {
  const c = s.replace(/\s/g, '');
  const out = new Set<string>();
  for (let i = 0; i + n <= c.length; i += 1) out.add(c.slice(i, i + n));
  return out;
};
const coveredBy = (item: string, msg: string): boolean => {
  const a = norm(item);
  const b = norm(msg);
  if (a === '') return true;
  if (a.length < 4) return b.includes(a) || a.includes(b);
  const A = ngrams(item);
  const B = ngrams(msg);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / A.size >= 0.5;
};

// ── capture ────────────────────────────────────────────────────────────────────────────────────
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

const SHIPPED_RESULT = {
  accepted: true,
  instruction: 'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
};

// ── one run ─────────────────────────────────────────────────────────────────────────────────────
const runOne = async (
  run: ReturnType<typeof createRun>,
  windowName: string,
  arm: Arm,
  rep: number,
): Promise<Record<string, unknown>> => {
  const w = WINDOWS[windowName]!;
  const spec = armSpec(arm);
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: 800 });

  const finals: string[] = [];
  const calls: string[] = [];
  const pending: string[] = [];
  let responseCreated = 0;
  let textReplies = 0;

  let session: P0Session | null = null;
  const onEvent = (event: ProbeEvent): void => {
    if (event.direction !== 'received') return;
    const wire = event.wire as Record<string, unknown>;
    const type = String(wire.type ?? '');
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(wire.transcript ?? '').trim();
      if (text !== '') {
        finals.push(text);
        if (spec.injectPending) pending.push(text);
      }
    } else if (type === 'input_audio_buffer.committed' && arm === 'K1' && session !== null) {
      // The "force ask" arm: no endpoint auto-response, one explicit create per committed item.
      session.sendRaw({ type: 'response.create' });
    } else if (type === 'response.function_call_arguments.done' && wire.name === 'session_send') {
      let message = '';
      try { message = String(JSON.parse(String(wire.arguments ?? '{}')).message ?? ''); } catch { /* keep raw */ }
      if (message !== '') {
        calls.push(message);
        pending.length = 0;
      }
    } else if (type === 'response.created') {
      responseCreated += 1;
    } else if (type === 'response.text.done') {
      textReplies += 1;
    }
  };

  session = await openSession({
    run,
    label: `${windowName}-${arm}-${rep}`,
    instructions: spec.base,
    sessionDefaults: sessionBody({
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800, create_response: spec.createResponse },
    }),
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

  const pcm = wavPcm(capturePath(w.capture, '.wav'));
  const span = pcm.subarray(Math.floor(w.startMs * 32), Math.floor(w.endMs * 32));
  const frames: string[] = [];
  for (let off = 0; off + 640 <= span.length; off += 640) frames.push(span.subarray(off, off + 640).toString('base64'));

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
  while (Date.now() < drainUntil) {
    injectPending();
    await sleep(50);
  }

  await gate.close().catch(() => undefined);
  await session.close().catch(() => undefined);

  const union = calls.join(' ');
  const missing = finals.filter((t) => !coveredBy(t, union));
  return {
    window: windowName,
    arm,
    rep,
    spendCny: session.spendCny,
    responseCreated,
    textReplies,
    finals,
    calls,
    missing,
    errors: session.errors.map((e) => String((e.wire as Record<string, unknown>).error ?? JSON.stringify(e.wire).slice(0, 120))),
  };
};

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  const windows = arg('windows', 'P1,C1,P2,P3,P4,C2').split(',').filter(Boolean);
  const arms = arg('arms', 'K,K1,E1,E2').split(',').filter(Boolean) as Arm[];
  const reps = Number(arg('reps', '3'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · windows ${windows.join(',')} · arms ${arms.join(',')} · reps ${reps}`);

  const jobs: Array<() => Promise<Record<string, unknown>>> = [];
  for (const wn of windows) for (const arm of arms) for (let rep = 0; rep < reps; rep += 1) jobs.push(() => runOne(run, wn, arm, rep));

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
    console.log(`\n=== ${x.window} ${x.arm}#${x.rep}  resp=${x.responseCreated} text=${x.textReplies}  missing=${(x.missing as string[]).length}`);
    console.log(`  finals: ${JSON.stringify(x.finals)}`);
    console.log(`  calls : ${JSON.stringify(x.calls)}`);
    console.log(`  missing: ${JSON.stringify(x.missing)}  spend=¥${x.spendCny}`);
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
