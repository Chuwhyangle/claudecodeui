#!/usr/bin/env tsx
/**
 * 实验 A（离线、零花费）：上行门控送出的尾音够不够上游 server_vad 判停。
 *
 * 用出货门控（createUplinkVadGate + silero）逐帧重放一条实测连接的浏览器录音，按「送出段」切开，
 * 对每段读出：段尾连续送出的低能量帧时长（上游判停要 ≥500 ms 真实静音，见
 * docs/operations/voice-realtime-silence-tail-suppression-probe.md 边界扫描），以及该连接 timeline 里
 * 上游实际的 speech_stopped 落在「段尾之内」还是「下一段开头之后」。
 *
 * 用法（仓库根）：
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-stop-latency/gate-replay.mts <capture-base> [--silence-ms 400] [--json out.json]
 *   <capture-base> = ~/.cloudcli/voice-realtime-capture/<connectionId>（读 .wav 与 .timeline.jsonl）
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { createUplinkVadClassifier, UPLINK_VAD_FRAME_BYTES } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { UPLINK_VAD_FRAME_MS, createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

const args = process.argv.slice(2);
const base = args[0];
if (!base) throw new Error('usage: gate-replay.mts <capture-base> [--silence-ms N] [--json out]');
const opt = (k: string, d: string): string => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const silenceMs = Number(opt('--silence-ms', '400'));
const jsonOut = opt('--json', '');
const weightsPath = process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH;
if (!weightsPath) throw new Error('VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH unset');

function readPcm(file: string): Buffer {
  const buf = readFileSync(file);
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4); const size = buf.readUInt32LE(o + 4);
    if (id === 'data') return buf.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}
const pcm = readPcm(`${base}.wav`);
const nFrames = Math.floor(pcm.length / UPLINK_VAD_FRAME_BYTES);
const dbfs = (f: Buffer): number => {
  let s = 0; const n = f.length / 2;
  for (let i = 0; i < n; i++) { const v = f.readInt16LE(i * 2) / 32768; s += v * v; }
  return s === 0 ? -120 : 10 * Math.log10(s / n);
};

const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath });
if (classifier.status === 'unavailable') throw new Error(`silero unavailable: ${classifier.reason}`);
const gate = createUplinkVadGate({ classifier, silenceDurationMs: silenceMs });

const frames: string[] = []; const level: number[] = [];
for (let i = 0; i < nFrames; i++) {
  const f = pcm.subarray(i * UPLINK_VAD_FRAME_BYTES, (i + 1) * UPLINK_VAD_FRAME_BYTES);
  frames.push(f.toString('base64')); level.push(dbfs(f));
}
// payload → 候选 index 队列；送出顺序是浏览器顺序，所以取「大于上一次送出 index 的最小候选」。
const byKey = new Map<string, number[]>();
frames.forEach((k, i) => { const q = byKey.get(k); if (q) q.push(i); else byKey.set(k, [i]); });
const sent = new Uint8Array(nFrames);
let last = -1;
const take = (k: string): void => {
  const q = byKey.get(k)!;
  while (q.length && q[0]! <= last) q.shift();
  const i = q.shift()!; sent[i] = 1; last = i;
};
for (let i = 0; i < nFrames; i++) for (const k of (await gate.observe(frames[i]!)).frames) take(k);
for (const k of (await gate.flush()).frames) take(k);
await gate.close();

// 送出段
type Run = { start: number; end: number };
const runs: Run[] = [];
for (let i = 0; i < nFrames; i++) {
  if (!sent[i]) continue;
  if (runs.length && runs.at(-1)!.end === i - 1) runs.at(-1)!.end = i; else runs.push({ start: i, end: i });
}
const ms = (i: number): number => i * UPLINK_VAD_FRAME_MS;
const quietTail = (r: Run, thr: number): number => { let n = 0; for (let i = r.end; i >= r.start && level[i]! < thr; i--) n++; return n * UPLINK_VAD_FRAME_MS; };
const quietHead = (r: Run, thr: number): number => { let n = 0; for (let i = r.start; i <= r.end && level[i]! < thr; i++) n++; return n * UPLINK_VAD_FRAME_MS; };

const timeline = readFileSync(`${base}.timeline.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const stops = timeline.filter((e) => e.kind === 'speech_stopped').map((e) => e.offsetMs as number);
const starts = timeline.filter((e) => e.kind === 'speech_started').map((e) => e.offsetMs as number);

// 上游音频轴 = 送出帧依次拼接。把每个 stop 的墙钟 offset 归到「它发生时最近送出的那一段」。
const rows = runs.map((r, idx) => {
  const next = runs[idx + 1];
  const endMs = ms(r.end + 1); const nextStartMs = next ? ms(next.start) : Infinity;
  const stopInTail = stops.filter((s) => s >= ms(r.start) && s < nextStartMs);
  return {
    idx, startMs: ms(r.start), endMs, durMs: endMs - ms(r.start), gapToNextMs: next ? nextStartMs - endMs : null,
    tailQuiet45: quietTail(r, -45), tailQuiet55: quietTail(r, -55),
    nextHeadQuiet45: next ? quietHead(next, -45) : null,
    stopsInRun: stopInTail.map((s) => s - endMs),
  };
});
// 每个上游 stop 的归类：tail（段尾到下一段开始之间）/ onset（下一段开始后 ≤600ms 内）/ other
const classified = stops.map((s) => {
  const r = rows.find((x) => s >= x.startMs && s < (x.gapToNextMs === null ? Infinity : x.endMs + x.gapToNextMs));
  if (!r) return { s, kind: 'before-any' };
  const nextStart = r.gapToNextMs === null ? Infinity : r.endMs + r.gapToNextMs;
  const nextStartedAfter = starts.find((t) => t > s);
  return {
    s, run: r.idx, kind: s < r.endMs ? 'inside-run' : 'after-run-end',
    afterRunEndMs: s - r.endMs, untilNextRunMs: nextStart - s,
    nextUpstreamStartGapMs: nextStartedAfter === undefined ? null : nextStartedAfter - s,
  };
});
const summary = {
  frames: nFrames, sent: sent.reduce((a, b) => a + b, 0), runs: runs.length, upstreamStops: stops.length,
  aFrames: gate.aFrames, preRollFrames: gate.preRollFrames,
};
console.log(JSON.stringify(summary));
console.log('run  start(s)  dur(ms) gapNext(ms) tailQuiet<-45 tailQuiet<-55 nextHeadQuiet<-45  stops(ms after run end)');
for (const r of rows) console.log([r.idx, (r.startMs / 1000).toFixed(2), r.durMs, r.gapToNextMs, r.tailQuiet45, r.tailQuiet55, r.nextHeadQuiet45, JSON.stringify(r.stopsInRun)].join('\t'));
console.log('upstream stops: s(ms)  run  afterRunEnd  untilNextRun  nextUpstreamStartGap');
for (const c of classified) console.log(JSON.stringify(c));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, rows, classified }, null, 2));
