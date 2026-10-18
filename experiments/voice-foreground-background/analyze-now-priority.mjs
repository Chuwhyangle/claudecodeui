/**
 * 语义分析（不跑实验）：若中继的每个 `session_send` 都**立即**以 `priority:'now'` 投给 CLI（无 busy hold、无合并窗、
 * 不进 `later` 队列），在已有的 Live Voice 会话上，每句话会落在哪里？
 *
 * 规则（来自 E1c + 2026-10-14 探针）：会话空闲 ⇒ 立即开新 turn；忙 ⇒ 在**下一个工具边界**（下一个 tool_result）注入当前
 * turn；若当前正有工具在跑，要等它返回；若到 turn 结束都没有工具边界 ⇒ turn 结束后成为下一 turn。
 * 对照：transcript 里这句话**实际**作为 prompt 出现的时刻（现状：hold + 合并 + later）。
 *
 *   node experiments/voice-foreground-background/analyze-now-priority.mjs
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-log');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const db = new Database(path.join(HOME, '.cloudcli', 'auth.db'), { readonly: true });
const lookup = db.prepare('select jsonl_path from sessions where session_id = ?');

const parse = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const isToolResult = (e) => Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result');
const text = (e) => (typeof e.message?.content === 'string' ? e.message.content : Array.isArray(e.message?.content) ? e.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
const norm = (s) => s.replace(/[\s，。！？、,.!?"“”]/g, '');

const rows = [];
const perConn = [];
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  const J = parse(path.join(LOG_DIR, f));
  if (J[0]?.kind !== 'connection') continue;
  const jp = lookup.get(J[0].sessionId)?.jsonl_path;
  if (!jp || !existsSync(jp)) continue;
  const T = parse(jp).filter((e) => (e.type === 'user' || e.type === 'assistant') && e.timestamp && !e.isSidechain);
  const prompts = T.map((e, i) => (e.type === 'user' && !isToolResult(e) && !e.isMeta ? i : -1)).filter((i) => i >= 0);
  // turns: [start, end]
  const turns = prompts.map((pi, k) => { const next = prompts[k + 1] ?? T.length; return { start: Date.parse(T[pi].timestamp), end: Date.parse(T[next - 1].timestamp), pi, next }; });
  const toolResults = T.filter(isToolResult).map((e) => Date.parse(e.timestamp));
  const calls = [];
  for (const e of J) {
    const m = /^<< function_call (session_send|session_interrupt) (.*)$/.exec(e.line ?? '');
    if (!m) continue;
    let msg = '';
    try { msg = JSON.parse(m[2]).message ?? ''; } catch { msg = m[2]; }
    calls.push({ at: Date.parse(e.at), tool: m[1], msg: String(msg) });
  }
  if (!calls.length) continue;
  let prevSendAt = null;
  let prevMsg = '';
  for (const c of calls) {
    const turn = turns.find((t) => t.start <= c.at && c.at <= t.end);
    let state = 'idle';
    let nowLand = c.at; // idle: immediately a new turn
    let landKind = 'new-turn';
    if (turn) {
      state = 'busy';
      const boundary = toolResults.find((tr) => tr > c.at && tr <= turn.end);
      if (boundary !== undefined) { nowLand = boundary; landKind = 'mid-turn'; } else { nowLand = turn.end; landKind = 'after-turn'; }
    }
    // actual: first prompt after c.at whose text contains this message (merged sends contain it)
    const needle = norm(c.msg).slice(0, 10);
    const actualIdx = needle.length >= 4 ? prompts.find((pi) => Date.parse(T[pi].timestamp) >= c.at - 2_000 && norm(text(T[pi])).includes(needle)) : undefined;
    const actual = actualIdx === undefined ? null : Date.parse(T[actualIdx].timestamp);
    const gapPrev = prevSendAt === null ? null : c.at - prevSendAt;
    const dup = prevMsg !== '' && norm(c.msg) !== '' && (norm(prevMsg).includes(norm(c.msg)) || norm(c.msg).includes(norm(prevMsg))) && gapPrev !== null && gapPrev < 30_000;
    rows.push({ conn: f.slice(0, 8), tool: c.tool, state, landKind, nowWaitMs: nowLand - c.at, actualWaitMs: actual === null ? null : actual - c.at, gapPrevMs: gapPrev, dup, chars: c.msg.length, msg: c.msg.slice(0, 40) });
    prevSendAt = c.at;
    prevMsg = c.msg;
  }
  perConn.push(f.slice(0, 8));
}

const pct = (a, k) => { const s = a.filter((x) => x !== null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : null; };
const sec = (ms) => (ms === null ? '-' : (ms / 1000).toFixed(1));
const sends = rows.filter((r) => r.tool === 'session_send');
console.log(`connections ${perConn.length}, relay calls ${rows.length} (send ${sends.length}, interrupt ${rows.length - sends.length})`);
for (const st of ['idle', 'busy']) {
  const g = sends.filter((r) => r.state === st);
  console.log(`\n[${st}] sends ${g.length}`);
  if (st === 'busy') for (const k of ['mid-turn', 'after-turn']) console.log(`   lands ${k}: ${g.filter((r) => r.landKind === k).length}`);
  console.log(`   now-priority wait  p50 ${sec(pct(g.map((r) => r.nowWaitMs), .5))}s p90 ${sec(pct(g.map((r) => r.nowWaitMs), .9))}s max ${sec(pct(g.map((r) => r.nowWaitMs), 1))}s`);
  console.log(`   actual (today) wait p50 ${sec(pct(g.map((r) => r.actualWaitMs), .5))}s p90 ${sec(pct(g.map((r) => r.actualWaitMs), .9))}s max ${sec(pct(g.map((r) => r.actualWaitMs), 1))}s  (matched ${g.filter((r) => r.actualWaitMs !== null).length})`);
}
const gaps = sends.map((r) => r.gapPrevMs).filter((x) => x !== null);
console.log(`\nspacing between consecutive relay calls: <3s ${gaps.filter((g) => g < 3000).length}, <8s ${gaps.filter((g) => g < 8000).length} of ${gaps.length}`);
console.log(`likely duplicate/overlapping re-sends (<30s, text contains previous): ${sends.filter((r) => r.dup).length}`);
console.log(`short pieces (<8 chars): ${sends.filter((r) => r.chars < 8).length}  e.g. ${sends.filter((r) => r.chars < 8).slice(0, 8).map((r) => JSON.stringify(r.msg)).join(' ')}`);
const busyRuns = []; // bursts: consecutive busy sends in the same turn
writeFileSync(path.join(HERE, 'traces', 'now-priority-semantic.json'), JSON.stringify(rows, null, 1));
