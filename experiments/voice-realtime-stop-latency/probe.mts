#!/usr/bin/env tsx
/**
 * 实验 B / C（真实上游 qwen3.8-omni-flash-realtime，小规模、并发、有花费上限）。
 *
 * B「尾音判停」：一句话 = 出货门控对实测录音真正送出的那一段（含 pre-roll 与 420 ms head-kept），之后
 *   按臂追加尾音再停传，看上游 speech_stopped 是否在停传后 W 秒内出现、上游自报 audio_end_ms 在哪。
 *   臂：tail+0（出货）/ tail+100 / tail+200（追加录音里紧随其后、本被门控丢掉的真实底噪帧）/ zero+600（追加 600 ms 数字零）。
 * C「被拒之后」：带一个 session_send 工具。第一句→等 function_call→按臂发 output→再依次送后续几句（每句后
 *   补足尾音保证判停），数每句是否得到 response / function_call。
 *   臂：ok（output 立即发，等回执后再说下一句）/ race（先把下一句送出去、见 speech_started 后才发 output）。
 *
 * 用法：set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-stop-latency/probe.mts --exp B|C --a-json /tmp/stoplat-A-164c.json \
 *     --wav <capture.wav> --runs 3,8,12,15 [--arms ...] [--reps 1] [--cap 0.25] [--out dir] [--concurrency 6]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import { DASHSCOPE_REALTIME_ENDPOINT, estimateRealtimeCostCny } from '../../server/modules/voice-realtime/index.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const EXP = opt('--exp', 'B');
const A_PATH = opt('--a-json', '/tmp/stoplat-A-164c.json');
const A = JSON.parse(readFileSync(opt('--a-json', '/tmp/stoplat-A-164c.json'), 'utf8')) as { rows: { idx: number; startMs: number; endMs: number }[] };
const WAV = opt('--wav', '');
const RUNS = opt('--runs', '3,8,12,15').split(',').map(Number);
const REPS = Number(opt('--reps', '1'));
const CAP = Number(opt('--cap', '0.25'));
const CONC = Number(opt('--concurrency', '6'));
const OUT = opt('--out', `/tmp/stoplat-${EXP}-${Date.now()}`);
const ARMS = opt('--arms', EXP === 'B' ? 'tail+0,tail+100,tail+200,zero+600' : EXP === 'D' ? 'gate,gap=0,gap=150,gap=300,gap=600,gap=1200' : 'ok,race').split(',');
const WAIT_MS = Number(opt('--wait', '8000'));
const MODEL = 'qwen3.8-omni-flash-realtime';
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) throw new Error('DASHSCOPE_API_KEY unset');
mkdirSync(OUT, { recursive: true });

function readPcm(file: string): Buffer {
  const buf = readFileSync(file); let o = 12;
  while (o + 8 <= buf.length) { const id = buf.toString('ascii', o, o + 4); const size = buf.readUInt32LE(o + 4); if (id === 'data') return buf.subarray(o + 8, o + 8 + size); o += 8 + size + (size % 2); }
  throw new Error('no data');
}
const PCM = readPcm(WAV);
const BPMS = 32; // 16 kHz * 2 B / 1000
const slice = (fromMs: number, toMs: number): Buffer => PCM.subarray(Math.round(fromMs) * BPMS, Math.round(toMs) * BPMS);
const runOf = (i: number) => { const r = A.rows.find((x) => x.idx === i); if (!r) throw new Error(`run ${i}`); return r; };

let spent = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { t: number; type: string; [k: string]: unknown };
class Conn {
  ws: WebSocket; t0 = Date.now(); events: Ev[] = []; sentAudioMs = 0; bufSamples: [number, number][] = [];
  waiters: { pred: (e: Ev) => boolean; res: (e: Ev | null) => void }[] = [];
  constructor(public label: string) {
    this.ws = new WebSocket(`${DASHSCOPE_REALTIME_ENDPOINT}?model=${MODEL}`, { headers: { Authorization: `Bearer ${KEY}` } });
    this.ws.on('message', (raw) => {
      const o = JSON.parse(raw.toString()); const t = Date.now() - this.t0;
      const keep: Ev = { t, type: o.type };
      for (const k of ['audio_start_ms', 'audio_end_ms', 'item_id', 'transcript', 'name', 'arguments', 'call_id']) if (o[k] !== undefined) keep[k] = o[k];
      if (o.error) keep.error = o.error.message;
      if (o.item) { keep.itemType = o.item.type; if (o.item.call_id) keep.call_id = o.item.call_id; }
      if (o.type === 'response.done') { const c = estimateRealtimeCostCny(o.response?.usage); spent += c; keep.cost = c; keep.status = o.response?.status; }
      if (o.type === 'response.function_call_arguments.done') { keep.call_id = o.call_id; keep.arguments = o.arguments; }
      if (o.type === 'response.text.delta' || o.type === 'response.audio_transcript.delta' || o.type.endsWith('.delta')) return;
      this.events.push(keep);
      for (const w of [...this.waiters]) if (w.pred(keep)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(keep); }
    });
    setInterval(() => { if (this.ws.readyState === 1) this.bufSamples.push([Date.now() - this.t0, this.ws.bufferedAmount]); }, 200).unref();
  }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); }); }
  send(o: unknown): void { this.ws.send(JSON.stringify(o)); this.events.push({ t: Date.now() - this.t0, type: `>> ${(o as { type: string }).type}` }); }
  wait(pred: (e: Ev) => boolean, ms: number): Promise<Ev | null> {
    const hit = this.events.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((res) => { const w = { pred, res }; this.waiters.push(w); setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); res(null); } }, ms); });
  }
  /** 实时节奏推音频（20 ms 一帧）。 */
  async stream(pcm: Buffer, mark: string): Promise<void> {
    this.events.push({ t: Date.now() - this.t0, type: `## ${mark} begin`, audioAxisMs: this.sentAudioMs });
    const start = Date.now();
    for (let o = 0, k = 0; o < pcm.length; o += 640, k++) {
      this.send({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + 640).toString('base64') });
      this.events.pop(); // 不逐帧记 >>
      this.sentAudioMs += Math.min(640, pcm.length - o) / BPMS;
      const due = start + (k + 1) * 20 - Date.now(); if (due > 0) await sleep(due);
    }
    this.events.push({ t: Date.now() - this.t0, type: `## ${mark} end`, audioAxisMs: this.sentAudioMs });
  }
  close(): void { try { this.ws.close(); } catch { /* */ } }
  dump(extra: Record<string, unknown>): Record<string, unknown> {
    const rec = { label: this.label, ...extra, events: this.events, maxBuffered: Math.max(0, ...this.bufSamples.map((b) => b[1])) };
    writeFileSync(path.join(OUT, `${this.label}.json`), JSON.stringify(rec, null, 1)); return rec;
  }
}

const TOOL = { type: 'function', name: 'session_send', description: 'Send the user\'s words verbatim to the coding session.', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } };
async function session(c: Conn, withTool: boolean): Promise<void> {
  await c.open();
  c.send({ type: 'session.update', session: {
    modalities: ['text'], input_audio_format: 'pcm16', output_audio_format: 'pcm24', voice: 'Tina',
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 },
    instructions: withTool ? 'You are a pen. For EVERY user utterance call session_send with the user\'s words verbatim. Never answer in text.' : 'Reply with the single word OK.',
    ...(withTool ? { tools: [TOOL], tool_choice: 'auto' } : {}),
  } });
  await c.wait((e) => e.type === 'session.updated', 5000);
}

async function expB(run: number, arm: string, rep: number): Promise<Record<string, unknown>> {
  const c = new Conn(`B-${path.basename(A_PATH, '.json')}-r${run}-${arm}-${rep}`); const r = runOf(run);
  await session(c, false);
  const [kind, extraS] = arm.split('+'); const extra = Number(extraS);
  const body = slice(r.startMs, r.endMs);
  const tail = kind === 'zero' ? Buffer.alloc(extra * BPMS) : slice(r.endMs, r.endMs + extra);
  await c.stream(Buffer.concat([body, tail]), 'utt');
  const stopSent = Date.now() - c.t0; const axis = c.sentAudioMs;
  // 只算尾音触发的那一次（段内多句的中间判停不算）：停传前 300 ms 之后才到的 stop。
  const stop = await c.wait((e) => e.type === 'input_audio_buffer.speech_stopped' && e.t >= stopSent - 300, WAIT_MS);
  const anyStart = c.events.some((e) => e.type === 'input_audio_buffer.speech_started');
  await c.wait((e) => e.type === 'response.done', stop ? 6000 : 10);
  c.close();
  return c.dump({ exp: 'B', run, arm, rep, anyStart, sentAxisMs: axis, stopSentWallMs: stopSent,
    stopped: stop !== null, stopWallAfterLastFrameMs: stop ? stop.t - stopSent : null, stopAudioEndMs: stop?.audio_end_ms ?? null });
}

/** 一句 + 足够判停的尾音（录音里紧随其后的 600 ms 真实底噪）。 */
const utter = (run: number): Buffer => { const r = runOf(run); return slice(r.startMs, r.endMs + 600); };
async function expC(runs: number[], arm: string, rep: number): Promise<Record<string, unknown>> {
  const c = new Conn(`C-${arm}-${rep}`); await session(c, true);
  const perUtt: { run: number; started: boolean; stopped: boolean; transcript: unknown; responses: number; calls: unknown[] }[] = [];
  const mark = () => c.events.length;
  const collect = (run: number, from: number) => {
    const ev = c.events.slice(from);
    perUtt.push({ run, started: ev.some((e) => e.type === 'input_audio_buffer.speech_started'), stopped: ev.some((e) => e.type === 'input_audio_buffer.speech_stopped'),
      transcript: ev.find((e) => e.type === 'conversation.item.input_audio_transcription.completed')?.transcript ?? null,
      responses: ev.filter((e) => e.type === 'response.created').length,
      calls: ev.filter((e) => e.type === 'response.function_call_arguments.done').map((e) => e.arguments) });
  };
  // 第一句
  let m = mark();
  await c.stream(utter(runs[0]!), `u0 run${runs[0]}`);
  const call = await c.wait((e) => e.type === 'response.function_call_arguments.done', 15000);
  await c.wait((e) => e.type === 'response.done', 5000);
  const output = (id: string) => { c.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: '{"delivered":true}' } }); c.send({ type: 'response.create' }); };
  if (arm === 'ok') {
    if (call) output(call.call_id as string);
    await c.wait((e) => e.type === 'response.done' && e.t > (call?.t ?? 0) + 1, 8000);
    collect(runs[0]!, m);
    for (const run of runs.slice(1)) { m = mark(); await c.stream(utter(run), `run${run}`); await c.wait((e) => e.type === 'response.done' && e.t > c.events[m]!.t, 8000); await sleep(1500); collect(run, m); }
  } else {
    collect(runs[0]!, m);
    // 第二句先开口；见到 speech_started 再发 output（回合已被新输入取代）
    m = mark();
    const p = c.stream(utter(runs[1]!), `run${runs[1]} (race)`);
    await c.wait((e) => e.type === 'input_audio_buffer.speech_started' && e.t > (call?.t ?? 0), 8000);
    if (call) output(call.call_id as string);
    await p; await c.wait((e) => e.type === 'response.done' && e.t > c.events[m]!.t, 8000); await sleep(1500); collect(runs[1]!, m);
    for (const run of runs.slice(2)) { m = mark(); await c.stream(utter(run), `run${run}`); await c.wait((e) => e.type === 'response.done' && e.t > c.events[m]!.t, 8000); await sleep(1500); collect(run, m); }
  }
  await sleep(1500); c.close();
  return c.dump({ exp: 'C', arm, rep, runs, gotFirstCall: call !== null, perUtt,
    rejected: c.events.filter((e) => typeof e.error === 'string' && /Unknown function call id/.test(e.error as string)).length,
    resumeRefused: c.events.filter((e) => typeof e.error === 'string' && /Cannot create response/.test(e.error as string)).length });
}

/**
 * D「判停后多快开口会吞掉上一句」：A 句 + 600 ms 数字零（保证判停）；见到 A 的 speech_stopped 后等 G ms 再送 B 句。
 * 臂 gap=G；另有 gate 臂：A 只带出货门控的 420 ms 尾音，停传 2 s（门控丢帧），再送 B（含其 pre-roll）。
 * 读数：A 是否得到 response / function_call，及 A 的 stop → B 的 speech_started 实测间隔。
 */
async function expD(runA: number, runB: number, arm: string, rep: number): Promise<Record<string, unknown>> {
  const c = new Conn(`D-${arm}-${rep}`); await session(c, true);
  const rA = runOf(runA); const rB = runOf(runB);
  if (arm.startsWith('z=')) {
    // 一条连续流：A + Z ms 数字零 + B（去掉 200 ms pre-roll）+ 600 ms 零
    const z = Number(arm.slice(2));
    await c.stream(Buffer.concat([slice(rA.startMs, rA.endMs), Buffer.alloc(z * BPMS), slice(rB.startMs + 200, rB.endMs), Buffer.alloc(600 * BPMS)]), 'A+B');
    c.events.push({ t: Date.now() - c.t0, type: '## B end' });
  } else if (arm === 'gate') {
    await c.stream(slice(rA.startMs, rA.endMs), 'A'); await sleep(2000);
  } else {
    await c.stream(Buffer.concat([slice(rA.startMs, rA.endMs), Buffer.alloc(600 * BPMS)]), 'A');
    const st = await c.wait((e) => e.type === 'input_audio_buffer.speech_stopped', 5000);
    if (!st) { c.close(); return c.dump({ exp: 'D', arm, rep, error: 'A never stopped' }); }
    const g = Number(arm.split('=')[1]); const due = st.t + g - (Date.now() - c.t0); if (due > 0) await sleep(due);
  }
  if (!arm.startsWith('z=')) await c.stream(Buffer.concat([slice(rB.startMs, rB.endMs), Buffer.alloc(600 * BPMS)]), 'B');
  const bEnd = c.events.find((x) => x.type === '## B end')!.t;
  await c.wait((e) => e.type === 'response.done' && e.t > bEnd, 8000);
  await sleep(2500); c.close();
  const ev = c.events;
  const stops = ev.filter((e) => e.type === 'input_audio_buffer.speech_stopped');
  const starts = ev.filter((e) => e.type === 'input_audio_buffer.speech_started');
  const stopA = stops[0]; const startB = starts.find((e) => stopA && e.t >= stopA.t);
  const rcAfterA = ev.filter((e) => e.type === 'response.created' && stopA && e.t >= stopA.t && (!startB || e.t < startB.t)).length;
  const calls = ev.filter((e) => e.type === 'response.function_call_arguments.done').map((e) => e.arguments);
  const tx = ev.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed').map((e) => e.transcript);
  return c.dump({ exp: 'D', arm, rep, gapStopToStartMs: stopA && startB ? startB.t - stopA.t : null, responseBeforeNextStart: rcAfterA, transcripts: tx, calls,
    aRelayed: calls.some((x) => typeof x === 'string' && /查/.test(x)) });
}

const jobs: (() => Promise<Record<string, unknown>>)[] = [];
for (let rep = 0; rep < REPS; rep++) {
  if (EXP === 'B') for (const run of RUNS) for (const arm of ARMS) jobs.push(() => expB(run, arm, rep));
  else if (EXP === 'D') for (const arm of ARMS) jobs.push(() => expD(RUNS[0]!, RUNS[1]!, arm, rep));
  else for (const arm of ARMS) jobs.push(() => expC(RUNS, arm, rep));
}
const results: Record<string, unknown>[] = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, async () => {
  while (next < jobs.length) {
    if (spent >= CAP) { console.log(`cap reached ¥${spent.toFixed(4)}; skipping`); return; }
    const j = jobs[next++]!;
    try { const r = await j(); const { events: _e, ...brief } = r; results.push(brief); console.log(JSON.stringify(brief)); }
    catch (e) { console.log('job failed', String(e)); }
  }
}));
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ spentCny: spent, results }, null, 1));
console.log(`spent ¥${spent.toFixed(4)} out=${OUT}`);
process.exit(0);
