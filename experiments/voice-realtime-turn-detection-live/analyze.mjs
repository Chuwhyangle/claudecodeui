/**
 * 把一条 run trace 读成对照表，并把「这个人真实的句中停顿有多长」从 capture 的 timeline 里算出来。
 *
 * 停顿分布是**无假设**读数：它直接来自上游自己的 `speech_started` / `speech_stopped` 偏移，不依赖
 * 任何「窗口 = 停顿」的模型。各臂的 commits 是实测值，两者并列给读者自己对照——不把模型当读数。
 *
 *   node experiments/voice-realtime-turn-detection-live/analyze.mjs [traces/run-*.json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const CAPTURE_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-capture');

const file = process.argv[2] ?? path.join(HERE, 'traces', readdirSync(path.join(HERE, 'traces')).filter((f) => f.endsWith('.json')).sort().at(-1));
const trace = JSON.parse(readFileSync(file, 'utf8'));

/** The endpoint's own judgment timeline, in the capture's clock — the pause distribution's source. */
const pauseStats = (prefix) => {
  const name = readdirSync(CAPTURE_DIR).find((f) => f.startsWith(prefix) && f.endsWith('.timeline.jsonl'));
  const lines = readFileSync(path.join(CAPTURE_DIR, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const events = lines.filter((e) => e.kind !== 'origin').sort((a, b) => a.offsetMs - b.offsetMs);
  const gaps = [];
  let lastStop = null;
  for (const e of events) {
    if (e.kind === 'speech_stopped') lastStop = e.offsetMs;
    else if (e.kind === 'speech_started' && lastStop !== null) {
      gaps.push(e.offsetMs - lastStop);
      lastStop = null;
    }
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (k) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * k))];
  return { segments: events.filter((e) => e.kind === 'speech_started').length, gaps: sorted, min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted.at(-1) };
};

const p = pauseStats(trace.capture);
const live = trace.liveBaseline;
console.log(`trace       ${path.relative(process.cwd(), file)}`);
console.log(`audio       capture ${trace.capture}, window ${trace.window.startMs}-${trace.window.endMs} ms, 16 kHz mono`);
console.log(`live pause  ${p.segments} segments, gaps(ms) ${p.gaps.join(', ')}  → p50 ${p.p50} · p90 ${p.p90} · max ${p.max}`);
console.log(`spend       ¥${trace.spendCny} of ¥${trace.budgetCny} · guard=${trace.guardTriggered}\n`);

const rows = [];
const byArm = new Map();
for (const r of trace.results) {
  if (r.error !== undefined || r.skipped !== undefined) continue;
  if (!byArm.has(r.arm)) byArm.set(r.arm, []);
  byArm.get(r.arm).push(r);
}
rows.push({
  arm: `LIVE@${live.silenceMs}`,
  note: '现场（本会话 journal/capture，未回放）',
  commits: live.commits,
  responses: live.responses,
  cancelled: live.cancelled,
  texts: '-',
  chars: 222,
  empty: 0,
  sends: 3,
  latency: '-',
  inTok: 11668,
  spend: live.spendCny,
});
// The comparator must not close over the loop's own `reps` binding, which is still in its TDZ when the
// iterable expression is evaluated — so it reads the entry's second element directly.
const bySilence = [...byArm.entries()].sort((a, b) => a[1][0].silenceMs - b[1][0].silenceMs);
for (const [arm, reps] of bySilence) {
  const num = (k) => reps.map((r) => r[k]).filter((v) => typeof v === 'number');
  const stat = (k) => {
    const v = num(k);
    return v.length === 0 ? '-' : v.length === 1 ? String(v[0]) : `${Math.min(...v)}–${Math.max(...v)}`;
  };
  const lat = reps.flatMap((r) => r.sendLatencies ?? []).sort((a, b) => a - b);
  rows.push({
    arm: `${arm} (a=${reps[0].gateAFrames}f)`,
    note: `reps=${reps.length}`,
    commits: stat('commits'),
    responses: stat('responses'),
    cancelled: stat('cancelled'),
    texts: stat('textReplies'),
    chars: stat('joinedChars'),
    empty: stat('emptyTranscriptions'),
    sends: stat('sendCalls'),
    latency: lat.length === 0 ? '-' : `${lat[0]}/${lat[Math.floor(lat.length / 2)]}/${lat.at(-1)}`,
    inTok: stat('inputTokens'),
    spend: reps.reduce((s, r) => s + (r.spendCny ?? 0), 0).toFixed(6),
  });
}
const cols = ['arm', 'commits', 'responses', 'cancelled', 'texts', 'chars', 'empty', 'sends', 'latency', 'inTok', 'spend'];
const width = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
const w = Object.fromEntries(cols.map((k) => [k, width(k)]));
console.log(cols.map((k) => k.padEnd(w[k])).join(' | '));
console.log(cols.map((k) => '-'.repeat(w[k])).join('-+-'));
for (const r of rows) console.log(cols.map((k) => String(r[k]).padEnd(w[k])).join(' | '));
console.log('\nlatency = speech_stopped → session_send (min/p50/max ms); inTok = Σ input tokens over billed responses');
