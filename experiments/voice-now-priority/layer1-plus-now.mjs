/**
 * 离线推算（不调模型）：第 1 层（前台只做调度）+ priority now/next，在已有 43 条连接的忙时语音上会怎样。
 *
 * 模型：原 turn ≤ 20 s ⇒ 不变（用原工具边界）。原 turn > 20 s ⇒ 第 1 层把前台缩成
 *   「派发前思考 D 秒 → Agent(run_in_background) 立即返回（一个工具边界）→ 一句确认 ~3 s → turn 结束」。
 *   忙时语音在偏移 o 到达：o < D ⇒ 在派发这个工具边界读到（等 D−o）；D ≤ o < D+3 ⇒ 确认完读到；
 *   o ≥ D+3 ⇒ 前台已空闲 ⇒ 立即新 turn（加现有 1 s 合并窗）。
 * D 取 E2 读数：opus 实测 21–37 s；另给 5 s / 10 s 两档表示「派发前思考被压短」后的情况。
 * 未建模：后台完成时 CLI 自开的简报 turn（又一段前台忙）；Claude 对后台状态的判断。
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

const sends = [];
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  const J = parse(path.join(LOG_DIR, f));
  if (J[0]?.kind !== 'connection') continue;
  const jp = lookup.get(J[0].sessionId)?.jsonl_path;
  if (!jp || !existsSync(jp)) continue;
  const T = parse(jp).filter((e) => (e.type === 'user' || e.type === 'assistant') && e.timestamp && !e.isSidechain);
  const P = T.map((e, i) => (e.type === 'user' && !isTR(e) && !e.isMeta ? i : -1)).filter((i) => i >= 0);
  const turns = P.map((pi, k) => ({ start: Date.parse(T[pi].timestamp), end: Date.parse(T[(P[k + 1] ?? T.length) - 1].timestamp) }));
  const TR = T.filter(isTR).map((e) => Date.parse(e.timestamp));
  for (const e of J) {
    if (!/^<< function_call session_send /.test(e.line ?? '')) continue;
    const t = Date.parse(e.at);
    const turn = turns.find((x) => x.start <= t && t <= x.end);
    if (!turn) continue;
    const b = TR.find((x) => x > t && x <= turn.end);
    sends.push({ o: t - turn.start, len: turn.end - turn.start, wNow: (b ?? turn.end) - t });
  }
}
const pct = (a, k) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * k))]; };
const f = (ms) => (ms / 1000).toFixed(1);
const short = sends.filter((s) => s.len <= 20_000);
console.log(`busy sends ${sends.length}; in turns ≤20 s: ${short.length}, in turns >20 s: ${sends.length - short.length}`);
console.log(`now only (no layer 1):        p50 ${f(pct(sends.map((s) => s.wNow), .5))} p90 ${f(pct(sends.map((s) => s.wNow), .9))} max ${f(Math.max(...sends.map((s) => s.wNow)))}`);
for (const D of [5_000, 10_000, 21_000, 37_000]) {
  let idle = 0;
  const w = sends.map((s) => {
    if (s.len <= 20_000) return s.wNow;
    if (s.o < D) return D - s.o;
    if (s.o < D + 3_000) return D + 3_000 - s.o;
    idle += 1;
    return 1_000;
  });
  console.log(`layer1 D=${String(D / 1000).padStart(2)}s + now: p50 ${f(pct(w, .5))} p90 ${f(pct(w, .9))} max ${f(Math.max(...w))}  | arrive after foreground already idle: ${idle}/${sends.length - short.length}`);
}
