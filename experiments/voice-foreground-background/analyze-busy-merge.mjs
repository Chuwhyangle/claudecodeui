/**
 * 离线模拟（不调任何模型）：忙时合并窗口 + `priority:'now'` 投递，在已有 43 条连接上会怎样。
 *
 * 输入与 `analyze-now-priority.mjs` 相同：voice journal 的中继调用时刻 + 上游 VAD 事件；Claude transcript 的 turn 与
 * 工具边界。规则：
 *   - 空闲：照现状（1 s 合并窗）后立即开新 turn。
 *   - 忙：中继调用进缓冲；当「距最后一次 speech_stopped ≥ Q 且此刻没有人在说话、且距最后一次中继调用 ≥ G」时冲洗，
 *     冲洗内容以 now 投递 ⇒ 落在冲洗时刻之后的下一个工具边界（无边界 ⇒ turn 结束后）。
 *   - 缓冲内去重：后一段包含前一段（或相反）只留长的。
 *   - session_interrupt：立即冲洗缓冲并照旧硬中断（不在本模拟的时延统计里）。
 * 臂：Q=0（逐段 now）以及 Q ∈ {1.5, 2, 3, 4, 6} s；G 固定 0.8 s（中继调用本身晚于 speech_stopped 约 0.3–1.5 s）。
 *
 *   node experiments/voice-foreground-background/analyze-busy-merge.mjs
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
const isToolResult = (e) => Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result');
const norm = (s) => s.replace(/[\s，。！？、,.!?"“”…]/g, '');

const conns = [];
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  const J = parse(path.join(LOG_DIR, f));
  if (J[0]?.kind !== 'connection') continue;
  const jp = lookup.get(J[0].sessionId)?.jsonl_path;
  if (!jp || !existsSync(jp)) continue;
  const T = parse(jp).filter((e) => (e.type === 'user' || e.type === 'assistant') && e.timestamp && !e.isSidechain);
  const prompts = T.map((e, i) => (e.type === 'user' && !isToolResult(e) && !e.isMeta ? i : -1)).filter((i) => i >= 0);
  const turns = prompts.map((pi, k) => ({ start: Date.parse(T[pi].timestamp), end: Date.parse(T[(prompts[k + 1] ?? T.length) - 1].timestamp) }));
  const toolResults = T.filter(isToolResult).map((e) => Date.parse(e.timestamp));
  const ev = [];
  for (const e of J) {
    const L = e.line ?? '';
    const at = Date.parse(e.at);
    if (/<< input_audio_buffer\.speech_started/.test(L)) ev.push({ at, k: 'start' });
    else if (/<< input_audio_buffer\.speech_stopped/.test(L)) ev.push({ at, k: 'stop' });
    else {
      const m = /^<< function_call (session_send|session_interrupt) (.*)$/.exec(L);
      if (m) { let msg = ''; try { msg = String(JSON.parse(m[2]).message ?? ''); } catch { msg = m[2]; } ev.push({ at, k: m[1] === 'session_send' ? 'send' : 'int', msg }); }
    }
  }
  if (ev.some((x) => x.k === 'send')) conns.push({ id: f.slice(0, 8), turns, toolResults, ev });
}

const busyAt = (c, t) => c.turns.find((x) => x.start <= t && t <= x.end) ?? null;
const landAt = (c, t) => { const turn = busyAt(c, t); if (!turn) return { at: t, kind: 'new-turn' }; const b = c.toolResults.find((x) => x > t && x <= turn.end); return b !== undefined ? { at: b, kind: 'mid-turn' } : { at: turn.end, kind: 'after-turn' }; };
const dedupe = (parts) => { const out = []; for (const p of parts) { const n = norm(p); if (n === '') continue; const i = out.findIndex((q) => norm(q).includes(n) || n.includes(norm(q))); if (i >= 0) { if (n.length > norm(out[i]).length) out[i] = p; } else out.push(p); } return out; };

const simulate = (Qms, Gms = 800) => {
  const deliveries = [];
  for (const c of conns) {
    let buf = []; let firstAt = 0; let lastSend = 0; let lastStop = 0; let talking = false;
    const flush = (t, why) => { if (!buf.length) return; const parts = dedupe(buf.map((b) => b.msg)); const land = landAt(c, t); deliveries.push({ conn: c.id, pieces: buf.length, kept: parts.length, text: parts.join(''), firstWait: land.at - firstAt, lastWait: land.at - lastSend, flushDelay: t - lastSend, land: land.kind, why, fragmentAlone: buf.length === 1 && norm(buf[0].msg).length < 6 }); buf = []; };
    const evs = [...c.ev].sort((a, b) => a.at - b.at);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      // before handling e, check whether the buffer would have flushed in the gap
      if (buf.length) {
        const due = Math.max(lastSend + Gms, lastStop + Qms);
        if (!talking && due <= e.at) flush(due, 'quiet');
      }
      if (e.k === 'start') talking = true;
      else if (e.k === 'stop') { talking = false; lastStop = e.at; }
      else if (e.k === 'int') flush(e.at, 'interrupt');
      else if (e.k === 'send') {
        const busy = busyAt(c, e.at) !== null;
        if (!busy && !buf.length) { // idle path: today's 1 s coalesce, then a new turn
          const land = landAt(c, e.at + 1000);
          deliveries.push({ conn: c.id, pieces: 1, kept: 1, text: e.msg, firstWait: land.at - e.at, lastWait: land.at - e.at, flushDelay: 1000, land: land.kind, why: 'idle', idle: true, fragmentAlone: norm(e.msg).length < 6 });
          continue;
        }
        if (Qms === 0) { const land = landAt(c, e.at); deliveries.push({ conn: c.id, pieces: 1, kept: 1, text: e.msg, firstWait: land.at - e.at, lastWait: land.at - e.at, flushDelay: 0, land: land.kind, why: 'per-piece', fragmentAlone: norm(e.msg).length < 6 }); continue; }
        if (!buf.length) firstAt = e.at;
        buf.push(e); lastSend = e.at;
      }
    }
    if (buf.length) flush(Math.max(lastSend + Gms, lastStop + Qms), 'end');
  }
  return deliveries;
};

const pct = (a, k) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : NaN; };
const s = (ms) => (ms / 1000).toFixed(1);
console.log('Q      | busy deliveries | pieces→msgs | lone fragments | dup pieces dropped | flush delay p50 | land wait from LAST piece p50/p90 | from FIRST piece p50/p90 | mid-turn');
for (const Q of [0, 1500, 2000, 3000, 4000, 6000]) {
  const d = simulate(Q).filter((x) => !x.idle);
  const pieces = d.reduce((a, x) => a + x.pieces, 0);
  const dropped = d.reduce((a, x) => a + (x.pieces - x.kept), 0);
  console.log(`${(Q / 1000).toFixed(1).padStart(4)}s  | ${String(d.length).padStart(15)} | ${String(pieces).padStart(4)}→${String(d.length).padEnd(6)} | ${String(d.filter((x) => x.fragmentAlone).length).padStart(14)} | ${String(dropped).padStart(18)} | ${s(pct(d.map((x) => x.flushDelay), .5)).padStart(15)} | ${s(pct(d.map((x) => x.lastWait), .5)).padStart(5)} / ${s(pct(d.map((x) => x.lastWait), .9)).padStart(5)}${''.padEnd(22)} | ${s(pct(d.map((x) => x.firstWait), .5)).padStart(5)} / ${s(pct(d.map((x) => x.firstWait), .9)).padStart(5)}${''.padEnd(9)} | ${d.filter((x) => x.land === 'mid-turn').length}`);
}
const d3 = simulate(3000).filter((x) => !x.idle && x.pieces > 1);
console.log('\nQ=3s examples of merged busy deliveries:');
for (const x of d3.slice(0, 10)) console.log(`  ${x.conn} ${x.pieces}→${x.kept} pieces  flush+${s(x.flushDelay)}s  ${JSON.stringify(x.text).slice(0, 110)}`);
