/**
 * X0 — 用与 CloudCLI 常驻会话一致的启动参数（resident-launch.mts）复验机制类结论。haiku，临时目录。
 *   e1b       后台 Bash + 后台 Agent（Agent 自己前台跑循环）+ 前台循环；8 s 后 SDK interrupt()：后台 Agent 会不会被停
 *   b-now / b-next   前台 8 个短步，第 2 步时推一条
 *   c-now / c-next   前台一条 ~30 s 长命令，5 s 后推一条
 *   d-now            前台短步中途连推 3 条
 * 读：turn 数（system/init）、result 数、Claude 读到推入消息的时刻、后台进度文件。
 *
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-now-priority/x0-resident-mechanics.mts [--reps 2] [--parallel 4]
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { residentOptions } from './resident-launch.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const REPS = Number(arg('reps', '2'));
const PARALLEL = Number(arg('parallel', '4'));
const CASES = arg('cases', 'e1b,b-now,b-next,c-now,c-next,d-now').split(',');

const run = async (name: string, rep: number) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `x0-${name}-`));
  const t0 = Date.now(); const at = () => Date.now() - t0;
  const lines = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8').trim().split('\n').length : 0);
  const ev: any[] = [];
  const queue: any[] = []; let wake: (() => void) | null = null; let closed = false;
  const push = (text: string, pri: string | null, marker: string) => { queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(pri ? { priority: pri } : {}) }); ev.push({ t: at(), ev: 'PUSH', pri, marker }); wake?.(); };
  async function* input() { while (!closed) { if (queue.length) { yield queue.shift(); continue; } await new Promise<void>((r) => (wake = r)); wake = null; } }
  const step = (n: number) => `echo step${n} >> ${dir}/fg.txt; for i in 1 2; do sleep 1.5; done`;
  const loop = (f: string, n: number) => `for i in $(seq 1 ${n}); do echo $i >> ${dir}/${f}; sleep 2; done; echo end >> ${dir}/${f}`;
  const pri = name.endsWith('next') ? 'next' : name === 'e1b' ? null : 'now';
  const prompt = name === 'e1b'
    ? ['Mechanics test. Do exactly these three tool calls, in order, and nothing else:', `1. Bash with run_in_background: true, command: ${loop('bash.txt', 15)}`, `2. Agent (subagent_type general-purpose, description "progress loop") with run_in_background: true, prompt: "Run this Bash command in the FOREGROUND (do NOT set run_in_background) and wait for it: ${loop('agent.txt', 15)} — then reply with the single word done."`, `3. Bash in the FOREGROUND (no run_in_background): ${loop('fg.txt', 40)}`, 'Do not check on the background tasks. Do not explain.'].join('\n')
    : name.startsWith('c')
      ? `Mechanics test. Run this ONE Bash command in the FOREGROUND (not in the background) and wait for it, then reply DONE: ${loop('long.txt', 15)}\nIf a new message from the user arrives, do what it says.`
      : ['Mechanics test. Run these 8 Bash commands in the FOREGROUND, one tool call each, strictly sequentially, no explanations:', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}. ${step(n)}`), 'If a new message from the user arrives while you work, do what it says and then continue with the remaining steps.'].join('\n');
  push(prompt, null, '');
  const q = query({ prompt: input() as never, options: residentOptions({ cwd: dir, model: 'haiku' }) as never });
  let triggered = false; let results = 0; let inits = 0;
  const read = new Map<string, number>();
  const seen = (t: string) => { for (const m of ['KIWI', 'W0', 'W1', 'W2']) if (!read.has(m) && t.includes(m)) read.set(m, at()); };
  const consume = (async () => {
    try {
      for await (const m of q as AsyncIterable<any>) {
        if (m.type === 'system' && m.subtype === 'init') inits += 1;
        if (m.type === 'system' && m.subtype === 'task_notification') ev.push({ t: at(), ev: 'TASK', status: m.status, summary: String(m.summary ?? '').slice(0, 30) });
        if (m.type === 'result') { results += 1; ev.push({ t: at(), ev: 'RESULT', subtype: m.subtype }); if (typeof m.result === 'string') seen(m.result); }
        if (m.type === 'assistant' && !m.parent_tool_use_id) for (const b of m.message?.content ?? []) {
          if (b.type === 'text') seen(b.text);
          if (b.type === 'tool_use') {
            const c = String(b.input?.command ?? '');
            seen(c);
            if (triggered) continue;
            if (name === 'e1b' && /fg\.txt/.test(c) && !b.input?.run_in_background) { triggered = true; setTimeout(async () => { ev.push({ t: at(), ev: 'INTERRUPT', agent: lines('agent.txt'), bash: lines('bash.txt') }); await (q as any).interrupt().catch(() => {}); }, 8000); }
            if ((name === 'b-now' || name === 'b-next') && /step2/.test(c)) { triggered = true; setTimeout(() => push('NEW MESSAGE: say the word KIWI.', pri, 'KIWI'), 1500); }
            if (name === 'd-now' && /step2/.test(c)) { triggered = true; setTimeout(() => { for (const w of ['W0', 'W1', 'W2']) push(`Say the word ${w}.`, 'now', w); }, 1500); }
            if (name.startsWith('c') && /long\.txt/.test(c)) { triggered = true; setTimeout(() => push('NEW MESSAGE: say the word KIWI.', pri, 'KIWI'), 5000); }
          }
        }
      }
    } catch (e) { ev.push({ t: at(), ev: 'ERROR', e: String(e).slice(0, 200) }); }
  })();
  await new Promise((r) => setTimeout(r, name === 'e1b' ? 75_000 : name.startsWith('c') ? 75_000 : 60_000));
  closed = true; wake?.();
  await (q as any).interrupt().catch(() => {});
  await Promise.race([consume, new Promise((r) => setTimeout(r, 5000))]);
  const pushes = ev.filter((e) => e.ev === 'PUSH' && e.marker);
  return { name, rep, inits, results, readAfterPush: pushes.map((p) => `${p.marker}:${read.has(p.marker) ? ((read.get(p.marker)! - p.t) / 1000).toFixed(1) + 's' : 'NEVER'}`), agentLines: lines('agent.txt'), bashLines: lines('bash.txt'), tasks: ev.filter((e) => e.ev === 'TASK').map((e) => `${e.status}:${e.summary}`), interrupt: ev.find((e) => e.ev === 'INTERRUPT') ?? null, errors: ev.filter((e) => e.ev === 'ERROR') };
};
const jobs: Array<() => Promise<any>> = [];
for (let r = 0; r < REPS; r++) for (const c of CASES) jobs.push(() => run(c, r));
const out: any[] = []; let k = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => { while (k < jobs.length) { const j = jobs[k++]!; const r = await j().catch((e) => ({ error: String(e) })); out.push(r); console.log(JSON.stringify(r)); } }));
writeFileSync(path.join(HERE, 'traces', `x0-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 1));
process.exit(0);
