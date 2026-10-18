/**
 * 「延迟」一栏：从中继输出那段话（function_call 时刻）到 Claude Code 能对它作出反应，按话的类型统计。
 * 离线推算，不调模型：用 10 个片段**原 transcript** 的工具边界与 turn 结束时刻。
 *
 *   now / next：冲洗时刻之后的下一个 tool_result（无边界 ⇒ 本 turn 结束）= Claude 读到的时刻（X1：两者落点相同）。
 *   N2 合并：冲洗时刻 = max(最后一段 + 0.8 s, 最后一次 speech_stopped + 2 s)，20 s 封顶；N0 = 立即。
 *   next 的「最迟」：若 Claude 把回答/处理留到本轮做完，就是本 turn 结束时刻（上界）。
 *   现状 L：本 turn 结束 + 下一 turn 开始（近似为 turn 结束；实际还要加 hold 释放与 later 出队）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const C = JSON.parse(readFileSync(path.join(HERE, 'traces', 'x3-candidates.json'), 'utf8'));
const L = JSON.parse(readFileSync(path.join(HERE, 'x3-labels.json'), 'utf8'));
const isTR = (e) => Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result');
const cat = (label) => {
  const b = label.replace(/-(frag|fix|repeat|superseded)$/, '');
  return { REMARK: '评论/旁白/噪声', NOISE: '评论/旁白/噪声', ADD: '补充/新观察', ASK: '关于当前工作的问题', NEXT: '下一件事的预告', REDIRECT: '改道', DUP: '重复' }[b] ?? b;
};
const rows = [];
for (const l of L) {
  const e = C.find((c) => c.id.startsWith(l.id));
  const T = readFileSync(e.jsonlPath, 'utf8').trim().split('\n').map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter((x) => x && !x.isSidechain && x.timestamp);
  const start = Date.parse(e.turnStart);
  const end = start + e.turnMs;
  const boundaries = T.filter(isTR).map((x) => Date.parse(x.timestamp) - start).filter((t) => t > 0 && t <= e.turnMs).sort((a, b) => a - b);
  const land = (t) => boundaries.find((b) => b > t) ?? e.turnMs;
  const pieces = e.pieces.filter((p) => p.tool === 'session_send' && p.text.trim() !== '' && !p.text.trim().startsWith('{')).map((p, i) => ({ ...p, label: l.pieces[i].label }));
  // N2 groups from the real speech events
  const stops = (e.speech ?? []).filter((s) => s.k === 'stop').map((s) => s.offsetMs);
  const starts = (e.speech ?? []).filter((s) => s.k === 'start').map((s) => s.offsetMs);
  // A group closes when the next piece arrives after the quiet deadline, or when the group would
  // pass the 20 s cap. The flush time is never earlier than the group's own last piece.
  const flushAt = (g) => {
    const last = g.at(-1).offsetMs;
    let due = last + 800;
    const ls = stops.filter((s) => s <= last + 3000).at(-1);
    if (ls !== undefined) due = Math.max(due, ls + 2000);
    return Math.max(last, Math.min(due, g[0].offsetMs + 20_000));
  };
  let group = [];
  const groups = [];
  for (const p of pieces) {
    if (group.length && (p.offsetMs > flushAt(group) || p.offsetMs > group[0].offsetMs + 20_000)) { groups.push(group); group = []; }
    group.push(p);
  }
  if (group.length) groups.push(group);
  for (const g of groups) {
    const f = flushAt(g);
    for (const p of g) rows.push({ ep: l.id, cat: cat(p.label), label: p.label, text: p.text, n0: land(p.offsetMs) - p.offsetMs, n2: land(f) - p.offsetMs, turnEnd: e.turnMs - p.offsetMs });
  }
}
const pct = (a, k) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * k))]; };
const f = (ms) => (ms / 1000).toFixed(1);
const order = ['评论/旁白/噪声', '补充/新观察', '关于当前工作的问题', '下一件事的预告', '改道', '重复'];
console.log('类型 | 段数 | N0 逐段：读到 p50 / 最大 | N2 合并：读到 p50 / 最大 | next 最迟（本轮结束）p50 / 最大 | 现状 L（≥ 本轮结束）p50 / 最大');
for (const c of order) {
  const r = rows.filter((x) => x.cat === c);
  if (!r.length) continue;
  console.log(`${c} | ${r.length} | ${f(pct(r.map((x) => x.n0), .5))} / ${f(Math.max(...r.map((x) => x.n0)))} | ${f(pct(r.map((x) => x.n2), .5))} / ${f(Math.max(...r.map((x) => x.n2)))} | ${f(pct(r.map((x) => x.turnEnd), .5))} / ${f(Math.max(...r.map((x) => x.turnEnd)))} | ${f(pct(r.map((x) => x.turnEnd), .5))} / ${f(Math.max(...r.map((x) => x.turnEnd)))}`);
}
console.log('\n逐段（N2 读到 / 本轮结束），单位秒：');
for (const r of rows) console.log(`  ${r.ep.slice(0, 8)} ${r.cat.padEnd(10)} N0 ${f(r.n0).padStart(6)}  N2 ${f(r.n2).padStart(6)}  轮末 ${f(r.turnEnd).padStart(6)}  ${JSON.stringify(r.text).slice(0, 40)}`);
