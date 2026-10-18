// Step 0 of the window-revision experiment: how often does a session_send arrive INSIDE an open
// coalescing window / busy hold with no new heard words since the previous call?  Read-only, no cloud.
//   npx tsx experiments/voice-realtime-window-revision/census.mts <frozen-journal-dir> [--json]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) throw new Error(`usage: census.mts <journal-dir>; got ${String(dir)}`);
const asJson = process.argv.includes('--json');
// fix 9b5861370 (silent closing turn) committed 2026-10-16 00:59:46+08, server restarted 01:00:40+08.
const FIX_AT = Date.parse('2026-10-15T17:00:00Z');

const norm = (t: string) => t.replace(/[\s\p{P}\p{S}]+/gu, '');
const isSub = (n: string, h: string) => { let i = 0; for (const c of h) { if (c === n[i]) i++; if (i === n.length) return true; } return n.length === 0; };
const lcs = (a: string, b: string) => {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = t; } }
  return dp[b.length];
};
type Rel = 'identical/contained' | 'elision' | 'extension' | 'rewrite' | 'different';
const classify = (next: string, prev: string): Rel => {
  const n = norm(next), p = norm(prev);
  if (n === p || p.includes(n)) return 'identical/contained';
  if (isSub(n, p)) return 'elision';
  if (isSub(p, n)) return 'extension';
  return lcs(n, p) / Math.max(1, n.length) >= 0.6 ? 'rewrite' : 'different';
};

type Ev = { conn: string; era: 'before' | 'after'; at: string; rel: Rel; sameResponse: boolean; outcome: string; prev: string; next: string };
const events: Ev[] = [];
const tally = { connections: 0, continuous: 0, windows: 0, multiPieceWindows: 0, pieces: 0, callsInWindowWithNewHeard: 0 };
const eraTally = { before: { conn: 0 }, after: { conn: 0 } } as Record<'before' | 'after', { conn: number }>;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
  const recs = readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, any>>;
  tally.connections++;
  const head = recs.find((r) => r.kind === 'connection');
  if (head?.mode !== 'continuous') continue;
  tally.continuous++;
  const era: 'before' | 'after' = Date.parse(head.at) >= FIX_AT ? 'after' : 'before';
  eraTally[era].conn++;
  let open = false, pieces: string[] = [], heard = 0, callsInResp = 0, prependNext = '';
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const s: string = r.kind === 'log' && typeof r.line === 'string' ? r.line : '';
    if (s.startsWith('<< input_audio_buffer.committed') || s.startsWith('<< transcription.completed') || s.startsWith('<< conversation.item.input_audio_transcription.completed')) heard++;
    if (s.startsWith('<< response.created')) callsInResp = 0;
    const left = s.match(/session_send left \d+ heard sentence\(s\) out; delivered verbatim in front of it: (.*)$/);
    if (left) prependNext = left[1];
    if (/^queued: opening a \d+ ms coalescing window/.test(s) || s.startsWith('queued: holding while the session is busy')) { if (!open) { open = true; tally.windows++; } }
    if (/^coalesced \d+ relayed piece/.test(s) || /released: delivering the ONE merged message/.test(s)) {
      if (pieces.length > 1) tally.multiPieceWindows++;
      open = false; pieces = [];
    }
    const m = s.match(/^<< function_call session_send (\{.*\})$/);
    if (!m) continue;
    let msg = ''; try { msg = String(JSON.parse(m[1]).message ?? ''); } catch { /* truncated */ }
    callsInResp++;
    const out = recs.slice(i, i + 60).find((x) => x.kind === 'session_send');
    const outcome = String(out?.outcome ?? 'unknown');
    if (open && pieces.length > 0) {
      tally.pieces++;
      if (heard === 0) {
        events.push({ conn: file.slice(0, 8), era, at: String(r.at).slice(5, 19), rel: classify(msg, pieces.join(' ')), sameResponse: callsInResp >= 2, outcome, prev: pieces.join(' ').slice(0, 70), next: msg.slice(0, 70) });
      } else tally.callsInWindowWithNewHeard++;
    }
    // this call's own text (+ any span-guard prefix) joins the open window's pending text
    pieces.push(prependNext ? `${prependNext} ${msg}` : msg); prependNext = '';
    heard = 0;
  }
}

const by = (era: string, rel: string) => events.filter((e) => e.era === era && e.rel === rel).length;
const rels: Rel[] = ['identical/contained', 'elision', 'extension', 'rewrite', 'different'];
if (asJson) { console.log(JSON.stringify({ tally, eraTally, events }, null, 1)); process.exit(0); }
console.log('corpus:', dir);
console.log(JSON.stringify(tally), JSON.stringify(eraTally));
console.log('\nIN-WINDOW calls with ZERO new heard words since the previous call (event E):', events.length);
console.log('relation'.padEnd(22), 'before'.padStart(7), 'after'.padStart(7));
for (const rel of rels) console.log(rel.padEnd(22), String(by('before', rel)).padStart(7), String(by('after', rel)).padStart(7));
const inScope = events.filter((e) => e.rel === 'elision' || e.rel === 'rewrite');
console.log('\nSTOP-RULE count (elision + rewrite, i.e. wording differs):', inScope.length, '(threshold 5)');
console.log('same-response parallel calls:', events.filter((e) => e.sameResponse).length);
console.log('\nevents:');
for (const e of events) console.log(`${e.conn} ${e.at} ${e.era.padEnd(6)} ${e.rel.padEnd(19)} ${e.outcome.padEnd(13)} resp2=${e.sameResponse ? 'Y' : 'n'}\n    prev=${JSON.stringify(e.prev)}\n    next=${JSON.stringify(e.next)}`);
