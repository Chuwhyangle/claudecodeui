#!/usr/bin/env tsx
/**
 * 实验 F 的补臂：response.create（状态驱动恢复）动作验证。
 *
 * 协议：带 session_send 工具 → stream 语音（贴语音末尾，无尾音）→ input_audio_buffer.commit
 *   → 等 committed → 确认无 speech_stopped（判据状态）→ 发 response.create
 *   → 测：是否 response.created、是否 session_send(function_call) 且携带句子、是否有重复/冲突错误。
 *
 * 用法：
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-feed-through-probe/response-create-arm.mts \
 *     --wav /data/home/yale/.cloudcli/voice-realtime-capture/e2b96f7b-031a-425f-8518-1c68f3895ab4.wav \
 *     --segments B-fail,C-fail --concurrency 2 --cap 0.15 --out /tmp/rc-arm
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import { DASHSCOPE_REALTIME_ENDPOINT, estimateRealtimeCostCny } from '../../server/modules/voice-realtime/index.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const WAV = opt('--wav', '/data/home/yale/.cloudcli/voice-realtime-capture/e2b96f7b-031a-425f-8518-1c68f3895ab4.wav');
const SEG_NAMES = opt('--segments', 'B-fail,C-fail').split(',');
const CONC = Number(opt('--concurrency', '2'));
const CAP = Number(opt('--cap', '0.15'));
const OUT = opt('--out', `/tmp/rc-arm-${Date.now()}`);
const PREROLL_MS = 200;

const MODEL = 'qwen3.8-omni-flash-realtime';
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) throw new Error('DASHSCOPE_API_KEY unset');

const SEGMENTS: Record<string, { speechStart: number; commit: number }> = {
  'B-fail': { speechStart: 225300, commit: 231000 },
  'C-fail': { speechStart: 302800, commit: 315000 },
};
mkdirSync(OUT, { recursive: true });

function readPcm(file: string): Buffer {
  const buf = readFileSync(file); let o = 12;
  while (o + 8 <= buf.length) { const id = buf.toString('ascii', o, o + 4); const size = buf.readUInt32LE(o + 4); if (id === 'data') return buf.subarray(o + 8, o + 8 + size); o += 8 + size + (size % 2); }
  throw new Error('no data chunk');
}
const PCM = readPcm(WAV);
const BPMS = 32;
const slice = (a: number, b: number): Buffer => PCM.subarray(Math.max(0, Math.round(a)) * BPMS, Math.min(PCM.length / BPMS, Math.round(b)) * BPMS);

let spent = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { t: number; type: string; [k: string]: unknown };
class Conn {
  ws: WebSocket; t0 = Date.now(); events: Ev[] = [];
  waiters: { pred: (e: Ev) => boolean; res: (e: Ev | null) => void }[] = [];
  constructor(public label: string) {
    this.ws = new WebSocket(`${DASHSCOPE_REALTIME_ENDPOINT}?model=${MODEL}`, { headers: { Authorization: `Bearer ${KEY}` } });
    this.ws.on('message', (raw) => {
      const o = JSON.parse(raw.toString()); const t = Date.now() - this.t0;
      const keep: Ev = { t, type: o.type };
      for (const k of ['item_id', 'transcript', 'name', 'arguments', 'call_id']) if (o[k] !== undefined) keep[k] = o[k];
      if (o.error) keep.error = o.error.message;
      if (o.item) { keep.itemType = o.item.type; if (o.item.call_id) keep.call_id = o.item.call_id; if (o.item.name) keep.name = o.item.name; if (o.item.arguments) keep.arguments = o.item.arguments; }
      if (o.type === 'response.done') { const c = estimateRealtimeCostCny(o.response?.usage); spent += c; keep.cost = c; keep.status = o.response?.status; }
      if (o.type.endsWith('.delta')) return;
      this.events.push(keep);
      for (const w of [...this.waiters]) if (w.pred(keep)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(keep); }
    });
  }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); }); }
  send(o: unknown): void { this.ws.send(JSON.stringify(o)); this.events.push({ t: Date.now() - this.t0, type: `>> ${(o as { type: string }).type}` }); }
  wait(pred: (e: Ev) => boolean, ms: number): Promise<Ev | null> {
    const hit = this.events.find(pred); if (hit) return Promise.resolve(hit);
    return new Promise((res) => { const w = { pred, res }; this.waiters.push(w); setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); res(null); } }, ms); });
  }
  async stream(pcm: Buffer, mark: string): Promise<void> {
    const start = Date.now();
    for (let o = 0, k = 0; o < pcm.length; o += 640, k++) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + 640).toString('base64') }));
      const due = start + (k + 1) * 20 - Date.now(); if (due > 0) await sleep(due);
    }
    this.events.push({ t: Date.now() - this.t0, type: `## ${mark} end` });
  }
  close(): void { try { this.ws.close(); } catch { /* */ } }
}

const TOOL = { type: 'function', name: 'session_send', description: "Send the user's words verbatim to the coding session.", parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } };
async function session(c: Conn): Promise<void> {
  await c.open();
  c.send({ type: 'session.update', session: {
    modalities: ['text'], input_audio_format: 'pcm16', output_audio_format: 'pcm24', voice: 'Tina',
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },
    instructions: 'You are a pen. For EVERY user utterance call session_send with the user\'s words verbatim. Never answer in text.',
    tools: [TOOL], tool_choice: 'auto',
  } });
  await c.wait((e) => e.type === 'session.updated', 5000);
}

async function runOne(segId: string): Promise<Record<string, unknown>> {
  const seg = SEGMENTS[segId]!;
  const c = new Conn(`${segId}-rc`);
  await session(c);
  await c.stream(slice(seg.speechStart - PREROLL_MS, seg.commit), 'speech');
  c.send({ type: 'input_audio_buffer.commit' });
  const commitSent = Date.now() - c.t0;
  const committed = await c.wait((e) => e.type === 'input_audio_buffer.committed', 12000);
  const stopBefore = c.events.find((e) => e.type === 'input_audio_buffer.speech_stopped') ?? null;
  c.send({ type: 'response.create' });
  const call = await c.wait((e) => e.type === 'response.function_call_arguments.done' || (e.type === 'conversation.item.created' && e.name === 'session_send'), 10000);
  await c.wait((e) => e.type === 'response.done', 8000);
  c.close();
  const ev = c.events;
  const creates = ev.filter((e) => e.type === 'response.created').length;
  const errors = ev.filter((e) => typeof e.error === 'string').map((e) => e.error);
  const brief = {
    segId, committedSeen: committed !== null, committedWallMs: committed?.t ?? null,
    stopBeforeCreate: stopBefore !== null, stopWallMs: stopBefore?.t ?? null,
    responseCreatedCount: creates,
    sessionSendArgs: call ? (call.arguments as string) : null,
    responseDone: ev.some((e) => e.type === 'response.done'),
    errors,
    transcription: ev.find((e) => e.type === 'conversation.item.input_audio_transcription.completed')?.transcript ?? null,
  };
  writeFileSync(path.join(OUT, `${segId}-rc.json`), JSON.stringify({ ...brief, events: ev }, null, 1));
  return brief;
}

const jobs = SEG_NAMES.map((s) => () => runOne(s));
const results: Record<string, unknown>[] = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, async () => {
  while (next < jobs.length) {
    if (spent >= CAP) { console.log(`cap reached ¥${spent.toFixed(4)}; skipping`); return; }
    const j = jobs[next++]!;
    try { const r = await j(); results.push(r); console.log(JSON.stringify(r)); }
    catch (e) { console.log('job failed', String(e)); }
  }
}));
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ spentCny: spent, results }, null, 1));
console.log(`spent ¥${spent.toFixed(4)} out=${OUT}`);
process.exit(0);
