/**
 * E1c — 不发 interrupt，改发一条 `priority` 消息，能否在**前台只做短步**时软改道、且不误杀后台 Agent？
 *
 * WHY. E1/E1b 实测：SDK `interrupt()`（= 常驻宿主的 `stopResidentTurn`）会**连带停掉正在跑的后台 Agent**
 * （3/3），后台 Bash 存活（4/4）。所以第 2 层「打断只停前台」不能用 interrupt 实现。2026-10-14 的探针证实
 * `priority:'now'` 不会抢占**正在跑的**工具；它没量的是第 1 层造出来的形态——前台全是**短步**。若 now 消息在
 * 下一个工具边界被注入（同一 turn 内改道），它就是不杀任何东西的软打断。
 *
 * 形状：后台 Agent 跑 30 s 的进度循环（自己前台跑）；主前台依次做 8 个 ~3 s 的短步 Bash（写 fg.txt）。
 * 第 2 步开跑后 2 s 推一条新指令（`--priority now|next|later`），读：Claude 何时看到（turn 内 / turn 后）、
 * 前台还做了几步、后台 Agent 是否跑完。
 *
 *   npx tsx experiments/voice-foreground-background/e1c-now-priority-redirect.mts --priority now
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const MODEL = arg('model', 'haiku');
const PRIORITY = arg('priority', 'now');
const dir = mkdtempSync(path.join(os.tmpdir(), 'e1c-'));
const t0 = Date.now();
const log: Array<Record<string, unknown>> = [];
const at = () => +((Date.now() - t0) / 1000).toFixed(1);
const lines = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8').trim().split('\n').length : 0);
const snap = () => ({ agent: lines('agent.txt'), fg: lines('fg.txt') });
const note = (e: Record<string, unknown>) => { log.push({ t: at(), ...e }); console.log(at(), JSON.stringify(e).slice(0, 220)); };

const queue: Array<Record<string, unknown>> = [];
let wake: (() => void) | null = null;
let closed = false;
const push = (text: string, priority?: string) => { queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', ...(priority ? { priority } : {}) }); wake?.(); };
async function* input() { while (!closed) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>((r) => (wake = r)); wake = null; } }

const step = (n: number) => `echo step${n} >> ${dir}/fg.txt; for i in 1 2; do sleep 1.5; done`;
push([
  'This is a mechanics test. Do exactly this, nothing else, no explanations:',
  `A. Agent (subagent_type general-purpose, description "progress loop") with run_in_background: true, prompt: "Run this Bash command in the FOREGROUND (do NOT set run_in_background) and wait for it: for i in $(seq 1 15); do echo $i >> ${dir}/agent.txt; sleep 2; done; echo end >> ${dir}/agent.txt — then reply with the single word done."`,
  'B. Then run these 8 Bash commands in the FOREGROUND, one tool call each, strictly sequentially:',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `   ${n}. ${step(n)}`),
  'If a new instruction from the user arrives while you work, follow the new instruction instead of continuing.',
].join('\n'));

const q = query({ prompt: input(), options: { cwd: dir, model: MODEL, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [] } as never });
let pushedAt: number | null = null;
let results = 0;
const consume = (async () => {
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === 'assistant' && m.parent_tool_use_id == null) {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use') {
          note({ ev: 'tool_use', name: b.name, cmd: String(b.input?.command ?? b.input?.description ?? '').slice(0, 50), snap: snap() });
          if (pushedAt === null && /step2/.test(String(b.input?.command))) {
            setTimeout(() => { pushedAt = Date.now(); note({ ev: 'PUSH', priority: PRIORITY, snap: snap() }); push('NEW INSTRUCTION FROM THE USER: stop doing the remaining step commands. Reply with the single word REDIRECTED and use no tools.', PRIORITY); }, 2_000);
          }
        } else if (b.type === 'text' && b.text?.trim()) note({ ev: 'text', text: b.text.slice(0, 120), sincePushS: pushedAt ? +((Date.now() - pushedAt) / 1000).toFixed(1) : null, snap: snap() });
      }
    } else if (m.type === 'user' && m.parent_tool_use_id == null && !Array.isArray(m.message?.content)) {
      note({ ev: 'user-echo', text: String(m.message?.content).slice(0, 60) });
    } else if (m.type === 'result') {
      results += 1;
      note({ ev: 'result', n: results, subtype: m.subtype, snap: snap() });
    } else if (m.type === 'system' && /task_notification/.test(m.subtype)) {
      note({ ev: 'task', status: m.status, summary: String(m.summary ?? '').slice(0, 40), snap: snap() });
    }
  }
})();
// end: give the agent time to finish (≈32 s) and the redirect time to land
await new Promise((r) => setTimeout(r, 75_000));
closed = true; wake?.();
await q.interrupt().catch(() => {});
await Promise.race([consume, new Promise((r) => setTimeout(r, 5_000))]);
note({ ev: 'FINAL', snap: snap(), agentEnded: existsSync(path.join(dir, 'agent.txt')) && readFileSync(path.join(dir, 'agent.txt'), 'utf8').includes('end') });
mkdirSync(path.join(HERE, 'traces'), { recursive: true });
writeFileSync(path.join(HERE, 'traces', `e1c-${PRIORITY}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ model: MODEL, priority: PRIORITY, dir, log }, null, 1));
process.exit(0);
