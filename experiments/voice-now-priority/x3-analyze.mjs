/**
 * X3' 读数：机械指标（每臂汇总）+ 每次回放的紧凑时间线（供逐条语义判读）。
 *
 * 机械指标（时间都从「这一段语音被中继输出」= PIECE 事件算起）：
 *   投递：PIECE → 含它的 DELIVER。
 *   首个反应：DELIVER 之后 Claude 的第一条可见输出（TEXT 或 TOOL，主线程）。这是「读到并开始处理」的代理读数：
 *     它也可能只是原任务的下一步，所以只作参考，语义判读以时间线为准。
 *   前台忙占比：Σ(每个 DELIVER → 其后第一个 RESULT) / 墙钟。
 *   到达即空闲：PIECE 时前台不忙的比例（以 DELIVER kind=idle 计）。
 *   派后台：主线程里 run_in_background 的 Agent/Bash 次数；第一次派发距 prompt 的秒数（D）。
 *
 *   node experiments/voice-now-priority/x3-analyze.mjs <traces/x3-…dir>
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
const dir = dirs[0];
// The 10 intended episodes: for each label set, the ONE candidate whose deliverable pieces are exactly the
// labelled texts. A minute-precision filter once replayed other turns of the same connections (2026-10-15);
// those runs are kept on disk but excluded here.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const LABELS = JSON.parse(readFileSync(path.join(HERE, 'x3-labels.json'), 'utf8'));
const CANDS = JSON.parse(readFileSync(path.join(HERE, 'traces', 'x3-candidates.json'), 'utf8'));
const INTENDED = new Set(LABELS.map((l) => CANDS.find((c) => {
  const del = c.pieces.filter((p) => p.tool === 'session_send' && p.text.trim() !== '' && !p.text.trim().startsWith('{')).map((p) => p.text);
  return c.id.startsWith(l.id) && del.length === l.pieces.length && del.every((t, i) => t === l.pieces[i].text);
})?.id).filter(Boolean));
const all = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json') && f !== 'summary.json').map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')))).filter((r) => !r.error);
const runs = all.filter((r) => INTENDED.has(r.episode));
console.log(`intended episodes ${INTENDED.size}; runs on disk ${all.length}, of which intended ${runs.length} (excluded ${all.length - runs.length} unintended)`);
const pct = (a, k) => { const s = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : NaN; };
const f = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '-');

const per = [];
for (const r of runs) {
  const E = r.events;
  const pieces = E.filter((e) => e.ev === 'PIECE');
  const delivers = E.filter((e) => e.ev === 'DELIVER');
  const deliverOf = (p) => delivers.find((d) => d.t >= p.t && (d.parts ?? []).some((x) => x.endsWith(`:${p.text}`)));
  const lat = [];
  const react = [];
  let idleArrivals = 0;
  for (const p of pieces) {
    const d = deliverOf(p);
    if (!d) { lat.push(null); react.push(null); continue; }
    if (d.kind === 'idle') idleArrivals += 1;
    lat.push(d.t - p.t);
    const first = E.find((e) => e.t > d.t && (e.ev === 'TEXT' || e.ev === 'TOOL'));
    react.push(first ? first.t - p.t : null);
  }
  let busy = 0;
  for (const d of delivers) { const res = E.find((e) => e.ev === 'RESULT' && e.t >= d.t); busy += (res ? res.t : r.wallMs) - d.t; }
  // Fragment handling: a delivery whose parts are ALL mid-sentence pieces (label ends in -frag). Between it
  // and the next delivery, did Claude act (any tool, or a substantive answer > 120 chars) or wait (short ack)?
  let fragDelivers = 0;
  let fragActed = 0;
  for (let i = 0; i < delivers.length; i++) {
    const d = delivers[i];
    const parts = d.parts ?? [];
    if (!parts.length || !parts.every((x) => /^[A-Z]+-frag:/.test(x))) continue;
    fragDelivers += 1;
    const until = delivers[i + 1]?.t ?? Infinity;
    const span = E.filter((e) => e.t > d.t && e.t < until);
    const acted = span.some((e) => e.ev === 'TOOL') || span.some((e) => e.ev === 'TEXT' && String(e.text).length > 120);
    if (acted) fragActed += 1;
  }
  const bgTools = E.filter((e) => e.ev === 'TOOL' && e.bg);
  const firstBg = bgTools[0]?.t ?? null;
  per.push({ ep: r.episode.slice(0, 8), epId: r.episode, arm: r.arm, rep: r.rep, model: r.model, pieces: pieces.length, undelivered: lat.filter((x) => x === null).length, lat, react, idleArrivals, busyFrac: Math.min(1, busy / r.wallMs), bg: bgTools.length, firstBgS: firstBg, fragDelivers, fragActed, turns: E.filter((e) => e.ev === 'TURN').length, blocked: E.filter((e) => e.ev === 'BLOCKED').length, capped: r.capped, wallMs: r.wallMs });
}

console.log(`runs ${runs.length}  (${[...new Set(runs.map((r) => r.model))].join(',')})`);
console.log('arm | runs | 投递 p50/p90 | 首个反应 p50/p90 | 到达即空闲 | 前台忙占比 p50 | 派后台的次数 | 派后台的 run | 首次派发 D p50 | 碎片单独投递 / 其中被据此行动 | 未投递段 | CAPPED');
for (const arm of ['A', 'B', 'C', 'D', 'E']) {
  const g = per.filter((x) => x.arm === arm);
  if (!g.length) continue;
  const lat = g.flatMap((x) => x.lat), react = g.flatMap((x) => x.react);
  const pcs = g.reduce((a, x) => a + x.pieces, 0);
  console.log(`${arm} | ${g.length} | ${f(pct(lat, .5))}/${f(pct(lat, .9))} | ${f(pct(react, .5))}/${f(pct(react, .9))} | ${g.reduce((a, x) => a + x.idleArrivals, 0)}/${pcs} | ${pct(g.map((x) => x.busyFrac), .5).toFixed(2)} | ${g.reduce((a, x) => a + x.bg, 0)} | ${g.filter((x) => x.bg > 0).length}/${g.length} | ${f(pct(g.map((x) => x.firstBgS), .5))} | ${g.reduce((a, x) => a + x.fragDelivers, 0)} / ${g.reduce((a, x) => a + x.fragActed, 0)} | ${g.reduce((a, x) => a + x.undelivered, 0)} | ${g.filter((x) => x.capped).length}`);
}
console.log('\nper episode × arm: 投递 p50 (s) / 派后台 run 数');
const eps = [...new Set(per.map((x) => x.ep))];
for (const ep of eps) console.log(`  ${ep}  ` + ['A', 'B', 'C', 'D', 'E'].map((a) => { const g = per.filter((x) => x.ep === ep && x.arm === a); return `${a}:${f(pct(g.flatMap((x) => x.lat), .5))}/${g.filter((x) => x.bg > 0).length}`; }).join('  '));

// digests for reading
const out = path.join(dir, 'digests');
mkdirSync(out, { recursive: true });
for (const r of runs) {
  const lines = [`# ${r.episode} arm ${r.arm} rep ${r.rep} model ${r.model} hook ${r.hook} wall ${f(r.wallMs)}s${r.capped ? ' CAPPED' : ''}`];
  for (const e of r.events) {
    const t = f(e.t).padStart(6);
    if (e.ev === 'PIECE') lines.push(`${t}  · voice [${e.label}] ${e.text}`);
    else if (e.ev === 'DELIVER') lines.push(`${t}  >> DELIVER ${e.kind}${e.priority ? ' ' + e.priority : ''}: ${String(e.text).slice(0, 160).replace(/\n/g, ' ')}`);
    else if (e.ev === 'TOOL') lines.push(`${t}     tool ${e.name}${e.bg ? ' [BG]' : ''}: ${String(e.input).slice(0, 110).replace(/\n/g, ' ')}`);
    else if (e.ev === 'TEXT') lines.push(`${t}     text: ${String(e.text).slice(0, 300).replace(/\n/g, ' ')}`);
    else if (e.ev === 'RESULT') lines.push(`${t}  -- result ${e.subtype}`);
    else if (e.ev === 'TURN') lines.push(`${t}  == turn`);
    else if (e.ev === 'BLOCKED') lines.push(`${t}     (blocked by sandbox)`);
    else if (e.ev === 'ERROR') lines.push(`${t}  !! ${e.e}`);
  }
  writeFileSync(path.join(out, `${r.episode.replace(/[@:]/g, '_')}-${r.arm}-${r.rep}.txt`), lines.join('\n') + '\n');
}
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(per, null, 1));
console.log(`\ndigests: ${out}`);
