#!/usr/bin/env tsx
/**
 * 判据检查：控制段（prod 里正常闭段）replay「语音 + 2000ms 尾音 → commit」，
 * 记录 speech_stopped 与 committed 的先后顺序。判据「committed 无 speech_stopped」只有在
 * 失败段才成立；控制段应 speech_stopped 先于 committed（→ upstreamTalking=false，不发 response.create）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { DASHSCOPE_REALTIME_ENDPOINT, estimateRealtimeCostCny } from '../../server/modules/voice-realtime/index.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const WAV = opt('--wav', '/data/home/yale/.cloudcli/voice-realtime-capture/e2b96f7b-031a-425f-8518-1c68f3895ab4.wav');
const CONC = Number(opt('--concurrency', '3'));
const CAP = Number(opt('--cap', '0.15'));
const OUT = opt('--out', `/tmp/disc-${Date.now()}`);
const MODEL = 'qwen3.8-omni-flash-realtime';
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) throw new Error('DASHSCOPE_API_KEY unset');

// speechStart 已含 -200 preroll；commit = speechEnd + 2000ms trailing
const SEGMENTS: Record<string, { speechStart: number; commit: number }> = {
  'ctrl1': { speechStart: 16600, commit: 23000 },
  'ctrl3': { speechStart: 277000, commit: 284000 },
  'ctrl5': { speechStart: 342500, commit: 347000 },
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
      for (const k of ['transcript', 'name', 'arguments', 'call_id']) if (o[k] !== undefined) keep[k] = o[k];
      if (o.error) keep.error = o.error.message;
      if (o.item) { keep.itemType = o.item.type; if (o.item.call_id) keep.call_id = o.item.call_id; }
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
  async stream(pcm: Buffer): Promise<void> {
    const start = Date.now();
    for (let o = 0, k = 0; o < pcm.length; o += 640, k++) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + 640).toString('base64') }));
      const due = start + (k + 1) * 20 - Date.now(); if (due > 0) await sleep(due);
    }
  }
  close(): void { try { this.ws.close(); } catch { /* */ } }
}

async function session(c: Conn): Promise<void> {
  await c.open();
  c.send({ type: 'session.update', session: {
    modalities: ['text'], input_audio_format: 'pcm16', output_audio_format: 'pcm24', voice: 'Tina',
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },
    instructions: 'Reply with the single word OK.',
  } });
  await c.wait((e) => e.type === 'session.updated', 5000);
}

async function runOne(segId: string): Promise<Record<string, unknown>> {
  const seg = SEGMENTS[segId]!;
  const c = new Conn(segId);
  await session(c);
  await c.stream(slice(seg.speechStart, seg.commit));
  c.send({ type: 'input_audio_buffer.commit' });
  const commitSent = Date.now() - c.t0;
  const stop = await c.wait((e) => e.type === 'input_audio_buffer.speech_stopped', 12000);
  const committed = c.events.find((e) => e.type === 'input_audio_buffer.committed') ?? null;
  await c.wait((e) => e.type === 'response.done', stop ? 6000 : 10);
  c.close();
  const stopBeforeCommitted = stop !== null && committed !== null && stop.t < committed.t;
  return {
    segId, stopSeen: stop !== null, stopWallMs: stop?.t ?? null,
    committedSeen: committed !== null, committedWallMs: committed?.t ?? null,
    stopBeforeCommitted, responseCreated: c.events.some((e) => e.type === 'response.created'),
    transcription: c.events.find((e) => e.type === 'conversation.item.input_audio_transcription.completed')?.transcript ?? null,
  };
}

const jobs = Object.keys(SEGMENTS).map((s) => () => runOne(s));
const results: Record<string, unknown>[] = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, async () => {
  while (next < jobs.length) {
    if (spent >= CAP) { console.log('cap'); return; }
    const j = jobs[next++]!;
    try { const r = await j(); results.push(r); console.log(JSON.stringify(r)); } catch (e) { console.log('fail', String(e)); }
  }
}));
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ spentCny: spent, results }, null, 1));
console.log(`spent ¥${spent.toFixed(4)} out=${OUT}`);
process.exit(0);
