#!/usr/bin/env tsx
/**
 * 实验 F「feed-through 恢复」：forced commit 之后补真实尾音，能否勾出端点的 speech_stopped。
 *
 * 背景（2026-10-17 live voice 第四次测试，journal e2b96f7b）：uplink VAD 扣静音 → 2s 后 forced
 * commit → 端点 committed+transcription 但无 speech_stopped → 无 response → 句子挂到下一句。
 * 假说：commit 之后继续补「真实尾音」能让端点 server_vad 自己 fire。
 *
 * 协议（每次 run）：
 *   session.update(server_vad 800ms) → stream [speechStart−200, commit] 前置音频 →
 *   input_audio_buffer.commit → stream [commit, commit+feed] 补料 → 观察 12s 是否 speech_stopped → 关。
 *
 * 臂 feed ∈ {0, 2000, 4000, 6000} ms。feed=0 = 今天 prod 行为（commit 后丢弃）。
 *
 * 用法：
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-feed-through-probe/probe.mts \
 *     --wav /data/home/yale/.cloudcli/voice-realtime-capture/e2b96f7b-031a-425f-8518-1c68f3895ab4.wav \
 *     --segments B-fail,C-fail,ctrl1-close,ctrl6-close --arms 0,2000,4000,6000 \
 *     --concurrency 4 --cap 0.45 --wait 12000 --out /tmp/feedthrough-probe
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import { DASHSCOPE_REALTIME_ENDPOINT, estimateRealtimeCostCny } from '../../server/modules/voice-realtime/index.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };

const WAV = opt('--wav', '/data/home/yale/.cloudcli/voice-realtime-capture/e2b96f7b-031a-425f-8518-1c68f3895ab4.wav');
const ARMS = opt('--arms', '0,2000,4000,6000').split(',').map(Number);
const SEG_NAMES = opt('--segments', 'B-fail,C-fail,ctrl1-close,ctrl6-close').split(',');
const CONC = Number(opt('--concurrency', '4'));
const CAP = Number(opt('--cap', '0.45'));
const WAIT_MS = Number(opt('--wait', '12000'));
const OUT = opt('--out', `/tmp/feedthrough-probe-${Date.now()}`);
const PREROLL_MS = 200;

const MODEL = 'qwen3.8-omni-flash-realtime';
const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) throw new Error('DASHSCOPE_API_KEY unset');

// 偏移（ms，SENSEVOICE token 时间戳定位，非 timeline——timeline 偏移有 VAD 迟滞 + 采集漂移，不可用）。
// commit 紧贴语音末尾（speechEnd，无尾部静音）：保证端点「committed 无 speech_stopped」，再补真静音测恢复。
const SEGMENTS: Record<string, { speechStart: number; commit: number; label: string }> = {
  'B-fail': { speechStart: 225300, commit: 231000, label: '那个会话中…（prod committed 无 speech_stopped）' },
  'C-fail': { speechStart: 302800, commit: 315000, label: '就从前面…（prod committed 无 speech_stopped）' },
};

mkdirSync(OUT, { recursive: true });

function readPcm(file: string): Buffer {
  const buf = readFileSync(file); let o = 12;
  while (o + 8 <= buf.length) { const id = buf.toString('ascii', o, o + 4); const size = buf.readUInt32LE(o + 4); if (id === 'data') return buf.subarray(o + 8, o + 8 + size); o += 8 + size + (size % 2); }
  throw new Error('no data chunk');
}
const PCM = readPcm(WAV);
const BPMS = 32; // 16 kHz * 2 B / 1000
const slice = (fromMs: number, toMs: number): Buffer =>
  PCM.subarray(Math.max(0, Math.round(fromMs)) * BPMS, Math.min(PCM.length / BPMS, Math.round(toMs)) * BPMS);

let spent = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { t: number; type: string; [k: string]: unknown };
class Conn {
  ws: WebSocket; t0 = Date.now(); events: Ev[] = []; sentAudioMs = 0;
  waiters: { pred: (e: Ev) => boolean; res: (e: Ev | null) => void }[] = [];
  constructor(public label: string) {
    this.ws = new WebSocket(`${DASHSCOPE_REALTIME_ENDPOINT}?model=${MODEL}`, { headers: { Authorization: `Bearer ${KEY}` } });
    this.ws.on('message', (raw) => {
      const o = JSON.parse(raw.toString()); const t = Date.now() - this.t0;
      const keep: Ev = { t, type: o.type };
      for (const k of ['item_id', 'transcript', 'name', 'arguments', 'call_id']) if (o[k] !== undefined) keep[k] = o[k];
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
  async stream(pcm: Buffer, mark: string): Promise<void> {
    const start = Date.now();
    for (let o = 0, k = 0; o < pcm.length; o += 640, k++) {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + 640).toString('base64') }));
      this.sentAudioMs += Math.min(640, pcm.length - o) / BPMS;
      const due = start + (k + 1) * 20 - Date.now(); if (due > 0) await sleep(due);
    }
    this.events.push({ t: Date.now() - this.t0, type: `## ${mark} end`, audioAxisMs: this.sentAudioMs });
  }
  close(): void { try { this.ws.close(); } catch { /* */ } }
  dump(extra: Record<string, unknown>): Record<string, unknown> {
    const rec = { label: this.label, ...extra, events: this.events };
    writeFileSync(path.join(OUT, `${this.label}.json`), JSON.stringify(rec, null, 1)); return rec;
  }
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

async function runOne(segId: string, feed: number): Promise<Record<string, unknown>> {
  const seg = SEGMENTS[segId]!;
  const c = new Conn(`${segId}-feed${feed}`);
  await session(c);
  const pre = slice(seg.speechStart - PREROLL_MS, seg.commit);
  await c.stream(pre, 'pre');
  c.send({ type: 'input_audio_buffer.commit' });
  const commitSent = Date.now() - c.t0;
  if (feed > 0) await c.stream(slice(seg.commit, seg.commit + feed), `feed${feed}`);
  const feedEnd = Date.now() - c.t0;
  const stop = await c.wait((e) => e.type === 'input_audio_buffer.speech_stopped', WAIT_MS);
  await c.wait((e) => e.type === 'response.done', stop ? 6000 : 10);
  c.close();
  const ev = c.events;
  const stopped = stop !== null;
  const stoppedBeforeCommit = stopped && stop!.t < commitSent - 300;
  const responseCreated = ev.some((e) => e.type === 'response.created');
  const committedSeen = ev.some((e) => e.type === 'input_audio_buffer.committed');
  const transcription = ev.find((e) => e.type === 'conversation.item.input_audio_transcription.completed')?.transcript ?? null;
  const brief = c.dump({ segId, feed, commitSentWallMs: commitSent, feedEndWallMs: feedEnd, stopped,
    stopWallMs: stop?.t ?? null, stopAfterCommitMs: stop ? stop.t - commitSent : null, stoppedBeforeCommit,
    responseCreated, committedSeen, transcription, sentAudioMs: c.sentAudioMs });
  const { events: _e, ...b } = brief;
  return b;
}

const jobs: (() => Promise<Record<string, unknown>>)[] = [];
for (const segId of SEG_NAMES) for (const feed of ARMS) jobs.push(() => runOne(segId, feed));

const results: Record<string, unknown>[] = [];
let next = 0;
const tWall0 = Date.now();
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, async () => {
  while (next < jobs.length) {
    if (spent >= CAP) { console.log(`cap reached ¥${spent.toFixed(4)}; skipping`); return; }
    const j = jobs[next++]!;
    try { const r = await j(); results.push(r); console.log(JSON.stringify(r)); }
    catch (e) { console.log('job failed', String(e)); }
  }
}));
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ spentCny: spent, wallSec: (Date.now() - tWall0) / 1000, results }, null, 1));
console.log(`spent ¥${spent.toFixed(4)} wallSec=${((Date.now() - tWall0) / 1000).toFixed(1)} out=${OUT}`);
process.exit(0);
