/**
 * X1r — 原始 CLI 流（stdin/stdout stream-json，无 SDK 过滤）上的 `command_lifecycle`：风险点 1。
 * SDK `query()` 会滤掉该 subtype（docs/proposals/claude-resident-sessions-experiments.md），所以只能走 raw。
 *
 * 情形（与 X1 同形，haiku）：b-now / b-next（短步中途一条）、d-now / d-next（短步中途连发 3 条）。
 * 读：每个推入 uuid 的 lifecycle 序列（queued/started/completed…）、result 个数、system/init 个数。
 *
 *   npx tsx experiments/voice-now-priority/x1r-raw-lifecycle.mts [--reps 2]
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const REPS = Number(arg('reps', '2'));

const run = (name: string, priority: 'now' | 'next', count: number, rep: number) => new Promise<any>((resolve) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `x1r-${name}-`));
  const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--dangerously-skip-permissions', '--setting-sources', ''], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const pushes: Array<{ uuid: string; label: string; at: number }> = [];
  const life: Array<{ uuid: string; state: string; t: number }> = [];
  const types: Record<string, number> = {};
  let results = 0; let inits = 0; let triggered = false;
  const send = (text: string, label: string, pri?: string) => {
    const uuid = randomUUID();
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid, ...(pri ? { priority: pri } : {}) }) + '\n');
    pushes.push({ uuid, label, at: at() });
  };
  const step = (n: number) => `echo step${n} >> ${dir}/fg.txt; for i in 1 2; do sleep 1.5; done`;
  send(['Mechanics test. Run these 8 Bash commands in the FOREGROUND, one tool call each, strictly sequentially, no explanations:', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}. ${step(n)}`), 'If a new message from the user arrives while you work, do what it says and then continue with the remaining steps.'].join('\n'), 'first');
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let m: any; try { m = JSON.parse(line); } catch { return; }
    const key = `${m.type}${m.subtype ? '/' + m.subtype : ''}`;
    types[key] = (types[key] ?? 0) + 1;
    if ((m.type === 'command_lifecycle' || m.subtype === 'command_lifecycle') && m.command_uuid) life.push({ uuid: m.command_uuid, state: m.state, t: at() });
    if (m.type === 'result') results += 1;
    if (m.type === 'system' && m.subtype === 'init') inits += 1;
    if (!triggered && m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use' && /step2/.test(String(b.input?.command))) {
      triggered = true;
      setTimeout(() => { for (let i = 0; i < count; i++) send(`Say the word W${i}.`, `W${i}`, priority); }, 1500);
    }
  });
  setTimeout(() => {
    child.stdin.end(); child.kill('SIGTERM');
    const per = pushes.map((p) => ({ label: p.label, pushedAt: p.at, lifecycle: life.filter((l) => l.uuid === p.uuid).map((l) => `${l.state}@${(l.t / 1000).toFixed(1)}`) }));
    const foreign = life.filter((l) => !pushes.some((p) => p.uuid === l.uuid)).map((l) => `${l.uuid.slice(0, 6)}:${l.state}`);
    resolve({ name, priority, count, rep, results, inits, per, foreign, types });
  }, 60_000);
});

const jobs = [];
for (let r = 0; r < REPS; r++) for (const [n, p, c] of [['b', 'now', 1], ['b', 'next', 1], ['d', 'now', 3], ['d', 'next', 3]] as const) jobs.push(run(`${n}-${p}`, p, c, r));
const out = await Promise.all(jobs);
for (const o of out) console.log(JSON.stringify({ case: o.name, rep: o.rep, results: o.results, inits: o.inits, per: o.per, foreign: o.foreign }));
console.log('stream types seen:', JSON.stringify(out[0].types));
writeFileSync(path.join(HERE, 'traces', `x1r-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 1));
process.exit(0);
