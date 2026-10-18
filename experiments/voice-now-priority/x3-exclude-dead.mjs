/** 限额致死的运行在读数里必须剔除：它们只跑出「You've hit your session limit」，不构成行为读数。
 *  无效集（读者逐条核实 + x3-integrity2 扫描）：57279cc1 A/B rep1、99df08d8@01:26:18 A–D rep1、af12cbaf A–D rep1。
 *  另有 3 次在**投递全部完成之后**才死（b33412ea E-1、b5d01c21 E-1、d4c9bfc4 C-1）——保留但标注。 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
const A = '/data/home/yale/work/claudecodeui/experiments/voice-now-priority/traces/analysis-74of80/summary.json';
const DEAD = new Set(['57279cc1@10-11T15:42:32|A|1','57279cc1@10-11T15:42:32|B|1',
  '99df08d8@10-12T01:26:18|A|1','99df08d8@10-12T01:26:18|B|1','99df08d8@10-12T01:26:18|C|1','99df08d8@10-12T01:26:18|D|1',
  'af12cbaf@10-14T09:52:44|A|1','af12cbaf@10-14T09:52:44|B|1','af12cbaf@10-14T09:52:44|C|1','af12cbaf@10-14T09:52:44|D|1']);
const TRUNC = new Set(['b33412ea@10-14T17:09:44|E|1','b5d01c21@10-13T15:59:28|E|1','d4c9bfc4@10-14T01:36:53|C|1']);
const all = JSON.parse(readFileSync(A,'utf8'));
const kept = all.filter(r=>!DEAD.has(`${r.epId}|${r.arm}|${r.rep}`));
console.log(`runs: 全部 ${all.length} → 剔除限额致死 ${all.length-kept.length} → 有效 ${kept.length}`);
const pct=(a,k)=>{const s=a.filter(x=>x!==null&&Number.isFinite(x)).sort((x,y)=>x-y);return s.length?s[Math.min(s.length-1,Math.floor(s.length*k))]:NaN;};
const f=(ms)=>Number.isFinite(ms)?(ms/1000).toFixed(1):'-';
console.log('\n[剔除后] 臂 | runs | 投递 p50/p90 | 首个反应 p50/p90 | 到达即空闲 | 前台忙占比 p50 | 派后台 run | 首次派发 D p50');
for (const arm of ['A','B','C','D','E']) {
  const g = kept.filter(r=>r.arm===arm); if(!g.length) continue;
  const lat=g.flatMap(r=>r.lat), react=g.flatMap(r=>r.react);
  const pcs=g.reduce((a,r)=>a+r.pieces,0);
  console.log(`${arm} | ${g.length} | ${f(pct(lat,.5))}/${f(pct(lat,.9))} | ${f(pct(react,.5))}/${f(pct(react,.9))} | ${g.reduce((a,r)=>a+r.idleArrivals,0)}/${pcs} | ${pct(g.map(r=>r.busyFrac),.5).toFixed(2)} | ${g.filter(r=>r.bg>0).length}/${g.length} | ${f(pct(g.map(r=>r.firstBgS),.5))}`);
}
console.log('\n[未剔除，对照] 臂 | runs | 投递 p90 | 首个反应 p90');
for (const arm of ['A','B','C','D','E']) { const g=all.filter(r=>r.arm===arm);
  console.log(`${arm} | ${g.length} | ${f(pct(g.flatMap(r=>r.lat),.9))} | ${f(pct(g.flatMap(r=>r.react),.9))}`); }
console.log('\n标注为「投递完成后才死」的 3 次：', [...TRUNC].join(' , '));
