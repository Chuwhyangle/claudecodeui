/**
 * 「多长算长操作」的依据：最近几次 Live Voice 使用里，**语音投递触发的前台 turn** 实际有多长、时间花在哪些工具上。
 *
 * 源：每条 voice journal 的 `kind=session_send`（交付给 CLI 的原文） → app DB 的 `sessions.jsonl_path`
 * → Claude transcript。按原文在 transcript 里找到那条 user 消息，turn = 该消息 → 下一条真人/语音 user 消息
 * 之前的最后一个条目。工具时长 = tool_use 所在 assistant 条目 → 对应 tool_result 条目的时间差。
 *
 *   node experiments/voice-foreground-background/analyze-turns.mjs
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

// app session → voice deliveries
const deliveries = new Map();
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  const lines = readFileSync(path.join(LOG_DIR, f), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const head = lines[0];
  if (head?.kind !== 'connection') continue;
  for (const e of lines) {
    if (e.kind === 'session_send' && e.outcome === 'delivered' && typeof e.message === 'string') {
      if (!deliveries.has(head.sessionId)) deliveries.set(head.sessionId, []);
      deliveries.get(head.sessionId).push({ at: Date.parse(e.at), message: e.message });
    }
  }
}

const userText = (entry) => {
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
};
const isToolResult = (entry) => Array.isArray(entry.message?.content) && entry.message.content.some((b) => b.type === 'tool_result');

const turns = [];
const tools = [];
for (const [appSession, sends] of deliveries) {
  const row = lookup.get(appSession);
  if (!row?.jsonl_path || !existsSync(row.jsonl_path)) continue;
  const entries = readFileSync(row.jsonl_path, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && (e.type === 'user' || e.type === 'assistant') && e.timestamp && !e.isSidechain);
  // indexes of "real" user prompts (not tool results, not meta)
  const prompts = entries.map((e, i) => (e.type === 'user' && !isToolResult(e) && !e.isMeta ? i : -1)).filter((i) => i >= 0);
  for (const send of sends) {
    const needle = send.message.slice(0, 24);
    const pi = prompts.find((i) => userText(entries[i]).includes(needle) && Math.abs(Date.parse(entries[i].timestamp) - send.at) < 15 * 60_000);
    if (pi === undefined) continue;
    const next = prompts.find((i) => i > pi) ?? entries.length;
    const span = entries.slice(pi, next);
    const start = Date.parse(entries[pi].timestamp);
    const end = Date.parse(span.at(-1).timestamp);
    const uses = new Map();
    let bg = 0;
    let toolMs = 0;
    for (const e of span) {
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) if (b.type === 'tool_use') {
          uses.set(b.id, { name: b.name, at: Date.parse(e.timestamp), bg: b.input?.run_in_background === true });
          if (b.input?.run_in_background === true) bg += 1;
        }
      }
      if (isToolResult(e)) for (const b of e.message.content) if (b.type === 'tool_result' && uses.has(b.tool_use_id)) {
        const u = uses.get(b.tool_use_id);
        const ms = Date.parse(e.timestamp) - u.at;
        toolMs += ms;
        tools.push({ name: u.name, ms, bg: u.bg });
      }
    }
    turns.push({ appSession: appSession.slice(0, 8), at: new Date(start).toISOString(), ms: end - start, toolCalls: uses.size, bgCalls: bg, toolMs, message: send.message.slice(0, 60) });
  }
}

const pct = (arr, k) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : null; };
const ms = turns.map((t) => t.ms);
console.log(`voice-started foreground turns matched: ${turns.length} (sessions ${new Set(turns.map((t) => t.appSession)).size})`);
console.log(`turn length s: p25 ${(pct(ms, .25) / 1e3).toFixed(1)} · p50 ${(pct(ms, .5) / 1e3).toFixed(1)} · p75 ${(pct(ms, .75) / 1e3).toFixed(1)} · p90 ${(pct(ms, .9) / 1e3).toFixed(1)} · max ${(Math.max(...ms) / 1e3).toFixed(1)}`);
for (const cut of [10, 15, 20, 30, 60, 120]) console.log(`  turns > ${cut}s: ${ms.filter((m) => m > cut * 1e3).length}/${ms.length}  (share of total foreground time: ${(ms.filter((m) => m > cut * 1e3).reduce((a, b) => a + b, 0) / ms.reduce((a, b) => a + b, 0) * 100).toFixed(0)}%)`);
console.log(`turns that used run_in_background at all: ${turns.filter((t) => t.bgCalls > 0).length}/${turns.length}`);
const byTool = new Map();
for (const t of tools) { if (!byTool.has(t.name)) byTool.set(t.name, []); byTool.get(t.name).push(t.ms); }
console.log('\nper-tool duration (tool_use → tool_result), seconds:');
for (const [name, arr] of [...byTool].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))) {
  const total = arr.reduce((a, b) => a + b, 0);
  console.log(`  ${name.padEnd(22)} n=${String(arr.length).padStart(4)} p50 ${(pct(arr, .5) / 1e3).toFixed(1).padStart(6)} p90 ${(pct(arr, .9) / 1e3).toFixed(1).padStart(6)} max ${(Math.max(...arr) / 1e3).toFixed(1).padStart(6)} total ${(total / 1e3).toFixed(0).padStart(5)}s  >15s: ${arr.filter((m) => m > 15e3).length}`);
}
const allTool = tools.map((t) => t.ms);
for (const cut of [5, 10, 15, 20, 30, 60]) console.log(`  tool calls > ${cut}s: ${allTool.filter((m) => m > cut * 1e3).length}/${allTool.length}, carrying ${(allTool.filter((m) => m > cut * 1e3).reduce((a, b) => a + b, 0) / allTool.reduce((a, b) => a + b, 0) * 100).toFixed(0)}% of tool time`);
console.log('\nlongest turns:');
for (const t of [...turns].sort((a, b) => b.ms - a.ms).slice(0, 8)) console.log(`  ${(t.ms / 1e3).toFixed(0).padStart(5)}s ${t.appSession} tools=${t.toolCalls} bg=${t.bgCalls} toolTime=${(t.toolMs / 1e3).toFixed(0)}s  ${JSON.stringify(t.message)}`);
writeFileSync(path.join(HERE, 'traces', 'turns.json'), JSON.stringify({ turns, tools }, null, 1));
