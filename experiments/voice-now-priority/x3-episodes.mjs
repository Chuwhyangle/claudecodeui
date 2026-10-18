/**
 * X3 素材：把忙时的中继调用按「落在哪个 Claude turn」分组 ⇒ 候选片段。
 * 每个片段：连接、Claude 会话、开启该 turn 的 prompt（uuid、时刻、原文）、该 turn 时长与工具数、
 * 以及 turn 内每一段语音（相对 turn 开始的偏移、原文、send/interrupt）。
 *
 *   node experiments/voice-now-priority/x3-episodes.mjs  ⇒ traces/x3-candidates.json
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
const lookup = db.prepare('select jsonl_path, provider_session_id from sessions where session_id = ?');
const parse = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const isToolResult = (e) => Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result');
const text = (e) => (typeof e.message?.content === 'string' ? e.message.content : Array.isArray(e.message?.content) ? e.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

const episodes = [];
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  const J = parse(path.join(LOG_DIR, f));
  if (J[0]?.kind !== 'connection') continue;
  const row = lookup.get(J[0].sessionId);
  if (!row?.jsonl_path || !existsSync(row.jsonl_path)) continue;
  const all = parse(row.jsonl_path);
  const T = all.filter((e) => (e.type === 'user' || e.type === 'assistant') && e.timestamp && !e.isSidechain);
  const prompts = T.map((e, i) => (e.type === 'user' && !isToolResult(e) && !e.isMeta ? i : -1)).filter((i) => i >= 0);
  const turns = prompts.map((pi, k) => {
    const next = prompts[k + 1] ?? T.length;
    const span = T.slice(pi, next);
    return { pi, start: Date.parse(T[pi].timestamp), end: Date.parse(T[next - 1].timestamp), uuid: T[pi].uuid, parentUuid: T[pi].parentUuid, prompt: text(T[pi]), tools: span.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((b) => b.type === 'tool_use')).length };
  });
  const speech = J.map((e) => { const L = e.line ?? ''; const k = /<< input_audio_buffer\.speech_started/.test(L) ? 'start' : /<< input_audio_buffer\.speech_stopped/.test(L) ? 'stop' : null; return k ? { at: Date.parse(e.at), k } : null; }).filter(Boolean);
  const byTurn = new Map();
  for (const e of J) {
    const m = /^<< function_call (session_send|session_interrupt) (.*)$/.exec(e.line ?? '');
    if (!m) continue;
    const t = Date.parse(e.at);
    const turn = turns.find((x) => x.start <= t && t <= x.end);
    if (!turn) continue;
    let msg = ''; try { msg = String(JSON.parse(m[2]).message ?? ''); } catch { msg = m[2]; }
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push({ offsetMs: t - turn.start, tool: m[1], text: msg });
  }
  for (const [turn, pieces] of byTurn) {
    episodes.push({
      id: `${f.slice(0, 8)}@${new Date(turn.start).toISOString().slice(5, 19)}`,
      conn: f.slice(0, 8), appSession: J[0].sessionId, claudeSession: row.provider_session_id, jsonlPath: row.jsonl_path,
      turnStart: new Date(turn.start).toISOString(), turnMs: turn.end - turn.start, tools: turn.tools,
      promptUuid: turn.uuid, promptParentUuid: turn.parentUuid, prompt: turn.prompt.slice(0, 300), promptFull: turn.prompt, pieces,
      speech: speech.filter((x) => x.at >= turn.start - 5_000 && x.at <= turn.end + 30_000).map((x) => ({ offsetMs: x.at - turn.start, k: x.k })),
    });
  }
}
episodes.sort((a, b) => b.pieces.length - a.pieces.length);
writeFileSync(path.join(HERE, 'traces', 'x3-candidates.json'), JSON.stringify(episodes, null, 1));
console.log('episodes', episodes.length, 'with >=2 pieces', episodes.filter((e) => e.pieces.length >= 2).length);
for (const e of episodes.slice(0, 22)) {
  console.log(`\n## ${e.id} turn ${(e.turnMs / 1000).toFixed(0)}s tools=${e.tools} pieces=${e.pieces.length}  PROMPT: ${JSON.stringify(e.prompt.slice(0, 90))}`);
  for (const p of e.pieces) console.log(`   +${(p.offsetMs / 1000).toFixed(1).padStart(6)}s ${p.tool === 'session_interrupt' ? 'INT ' : '    '}${JSON.stringify(p.text).slice(0, 110)}`);
}
