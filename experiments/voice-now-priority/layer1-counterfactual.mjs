/**
 * 离线推算（不调模型）：第 1 层（前台只做调度）+ next/now 投递，在已有忙时语音上会怎样。
 *
 * 对每段忙时语音（中继输出时刻 t），在原 transcript 上判定它在 next/now 下要等多久、为什么等：
 *   tool   — t 时刻有工具在跑，要等它返回；
 *   model  — t 时刻没有工具在跑，要等 Claude 想完/写完、发出下一个工具调用并返回（或本轮结束）。
 * 反事实（第 1 层，假设写在 README 里）：
 *   - 原 turn > 20 s ⇒ 第 1 层会把它派到后台：前台在 D 秒内想完并派出（E2 opus 实测 21–37 s，取 D=30），
 *     派出这一步本身就是工具边界；之后前台只剩一句确认（取 5 s）⇒ 35 s 后前台空闲。
 *       t < D       ⇒ 等到 D（派出前的思考没有工具边界）
 *       D ≤ t < 35  ⇒ 等到 35
 *       t ≥ 35      ⇒ 前台空闲 ⇒ 1 s 合并后立即开新 turn
 *   - 原 turn ≤ 20 s ⇒ 不派；其中 > 10 s 的单条命令改为后台 Bash ⇒ 该工具立即返回（边界提前）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.cloudcli', 'voice-realtime-log');
const db = new Database(path.join(HOME, '.cloudcli', 'auth.db'), { readonly: true });
const lookup = db.prepare('select jsonl_path from sessions where session_id = ?');
const parse = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const isTR = (e) => Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result');
const D = 30_000, IDLE_AFTER = 35_000;

const rows = [];
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  const J = parse(path.join(LOG_DIR, f));
  if (J[0]?.kind !== 'connection') continue;
  const jp = lookup.get(J[0].sessionId)?.jsonl_path;
  if (!jp || !existsSync(jp)) continue;
  const T = parse(jp).filter((e) => (e.type === 'user' || e.type === 'assistant') && e.timestamp && !e.isSidechain);
  const prompts = T.map((e, i) => (e.type === 'user' && !isTR(e) && !e.isMeta ? i : -1)).filter((i) => i >= 0);
  const turns = prompts.map((pi, k) => { const nx = prompts[k + 1] ?? T.length; return { start: Date.parse(T[pi].timestamp), end: Date.parse(T[nx - 1].timestamp), span: T.slice(pi, nx) }; });
  for (const e of J) {
    const m = /^<< function_call session_send (.*)$/.exec(e.line ?? '');
    if (!m) continue;
    const t = Date.parse(e.at);
    const turn = turns.find((x) => x.start <= t && t <= x.end);
    if (!turn) continue;
    // tool calls of this turn with their windows
    const uses = new Map();
    const tools = [];
    for (const x of turn.span) {
      if (x.type === 'assistant') for (const b of x.message?.content ?? []) if (b.type === 'tool_use') uses.set(b.id, { at: Date.parse(x.timestamp), name: b.name, bg: b.input?.run_in_background === true });
      if (isTR(x)) for (const b of x.message.content) if (b.type === 'tool_result' && uses.has(b.tool_use_id)) { const u = uses.get(b.tool_use_id); tools.push({ ...u, end: Date.parse(x.timestamp) }); }
    }
    const inFlight = tools.find((k) => k.at <= t && t < k.end);
    const boundary = tools.map((k) => k.end).filter((x) => x > t).sort((a, b) => a - b)[0] ?? turn.end;
    const wait = boundary - t;
    const reason = inFlight ? 'tool' : 'model';
    const off = t - turn.start;
    const turnMs = turn.end - turn.start;
    // counterfactual
    let cf;
    if (turnMs > 20_000) cf = off < D ? D - off : off < IDLE_AFTER ? IDLE_AFTER - off : 1_000;
    else if (inFlight && inFlight.end - inFlight.at > 10_000) cf = Math.max(0, inFlight.at + 1_000 - t);
    else cf = wait;
    rows.push({ wait, reason, toolMs: inFlight ? inFlight.end - inFlight.at : 0, toolName: inFlight?.name, off, turnMs, cf: Math.max(cf, 0) });
  }
}
const pct = (a, k) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * k))]; };
const s = (ms) => (ms / 1000).toFixed(1);
console.log(`busy voice pieces: ${rows.length}`);
for (const r of ['tool', 'model']) {
  const g = rows.filter((x) => x.reason === r);
  console.log(`  waiting on ${r.padEnd(5)}: ${String(g.length).padStart(3)}  wait p50 ${s(pct(g.map((x) => x.wait), .5))} p90 ${s(pct(g.map((x) => x.wait), .9))} max ${s(Math.max(...g.map((x) => x.wait)))}  (>10 s: ${g.filter((x) => x.wait > 10e3).length})`);
}
const longTool = rows.filter((x) => x.reason === 'tool' && x.wait > 10e3);
const names = {}; for (const x of longTool) names[x.toolName] = (names[x.toolName] ?? 0) + 1;
console.log(`  long-tool waits by tool: ${JSON.stringify(names)}`);
console.log(`\nnext/now alone:          wait p50 ${s(pct(rows.map((x) => x.wait), .5))}  p90 ${s(pct(rows.map((x) => x.wait), .9))}  max ${s(Math.max(...rows.map((x) => x.wait)))}  >30 s: ${rows.filter((x) => x.wait > 30e3).length}`);
console.log(`layer 1 + next/now (est): wait p50 ${s(pct(rows.map((x) => x.cf), .5))}  p90 ${s(pct(rows.map((x) => x.cf), .9))}  max ${s(Math.max(...rows.map((x) => x.cf)))}  >30 s: ${rows.filter((x) => x.cf > 30e3).length}`);
const inLong = rows.filter((x) => x.turnMs > 20_000);
console.log(`\npieces in turns >20 s (would be dispatched): ${inLong.length}/${rows.length}; of them said in the first 30 s (would wait for the pre-dispatch thinking): ${inLong.filter((x) => x.off < D).length}; said after 35 s (foreground idle): ${inLong.filter((x) => x.off >= IDLE_AFTER).length}`);
