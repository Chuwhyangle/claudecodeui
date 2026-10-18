/**
 * E1 — 前台被打断时，后台 Bash / 后台 Agent 会不会一起死？
 *
 * WHY. 第 2 层设计（「打断只停前台，后台交给 Claude」）的地基是：常驻模式的打断 = SDK 的
 * `Query.interrupt()`（`claude-host-driver.provider.ts` `stopResidentTurn`），而它对**同一进程里
 * 已在跑的后台任务**做什么，代码里读不出来——那是 CLI 自己的行为。本脚本用与常驻宿主相同的形状
 * （流式输入 `AsyncIterable` + 不结束的输入流 + `interrupt()`）实测。
 *
 * 形状：一个临时目录作 cwd；让 Claude 依次 (1) 后台 Bash `sleep 30` 后写 bash.txt，(2) 后台 Agent
 * `sleep 30` 后写 agent.txt，(3) 前台 Bash `sleep 120`。看到 (3) 开跑后 3 s 调 `interrupt()`，
 * 输入流保持打开，再等 70 s，读两个文件是否出现、以及 SDK 流上来了什么（task 通知、新 turn）。
 * 之后再发一条「用户打断后的新话」，看 Claude 是否知道后台还在跑（第 2 层要的是它自己判断）。
 *
 *   npx tsx experiments/voice-foreground-background/e1-interrupt-survival.mts [--model haiku]
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const MODEL = arg('model', 'haiku');
const dir = mkdtempSync(path.join(os.tmpdir(), 'e1-bg-'));
const t0 = Date.now();
const log: Array<Record<string, unknown>> = [];
const at = () => +((Date.now() - t0) / 1000).toFixed(1);
const note = (e: Record<string, unknown>) => { log.push({ t: at(), ...e }); console.log(at(), JSON.stringify(e).slice(0, 220)); };

// A never-ending input stream, like the resident host's: messages are pushed, the stream never closes.
const queue: Array<Record<string, unknown>> = [];
let wake: (() => void) | null = null;
let closed = false;
const push = (text: string) => { queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); wake?.(); };
async function* input() { while (!closed) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>((r) => (wake = r)); wake = null; } }

// E1b (`--variant b`): the subagent does its work in ITS OWN FOREGROUND (a progress loop it must not
// background), and the main foreground is a progress loop too — so the interrupt lands while all three
// are genuinely running, and the three progress files say which ones kept going.
const loop = (file: string, n: number) => `for i in $(seq 1 ${n}); do echo $i >> ${dir}/${file}; sleep 2; done; echo end >> ${dir}/${file}`;
const VARIANT = arg('variant', 'a');
const FIRST = VARIANT === 'b'
  ? [
      'This is a mechanics test. Do exactly these three tool calls, in order, and nothing else:',
      `1. Bash with run_in_background: true, command: ${loop('bash.txt', 15)}`,
      `2. Agent (subagent_type general-purpose, description "progress loop") with run_in_background: true, prompt: "Run this Bash command in the FOREGROUND (do NOT set run_in_background) and wait for it: ${loop('agent.txt', 15)} — then reply with the single word done."`,
      `3. Bash in the FOREGROUND (no run_in_background): ${loop('fg.txt', 40)}`,
      'Do not check on the background tasks. Do not explain.',
    ].join('\n')
  : [
      'This is a mechanics test. Do exactly these three tool calls, in order, and nothing else:',
      `1. Bash with run_in_background: true, command: sleep 30 && echo bash-done > ${dir}/bash.txt`,
      `2. Agent (subagent_type general-purpose) with run_in_background: true, prompt: "Run the Bash command: sleep 30 && echo agent-done > ${dir}/agent.txt — then reply with the single word done."`,
      '3. Bash in the FOREGROUND (no run_in_background): sleep 120',
      'Do not check on the background tasks. Do not explain.',
    ].join('\n');

push(FIRST);
const q = query({ prompt: input(), options: { cwd: dir, model: MODEL, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [] } as never });

let interrupted = false;
let phase2Sent = false;
let costUsd = 0;
const timers: NodeJS.Timeout[] = [];
const lines = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8').trim().split('\n').length : 0);
const files = () => ({ bash: existsSync(path.join(dir, 'bash.txt')), agent: existsSync(path.join(dir, 'agent.txt')), lines: { bash: lines('bash.txt'), agent: lines('agent.txt'), fg: lines('fg.txt') } });

const consume = (async () => {
  for await (const m of q as AsyncIterable<Record<string, any>>) {
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use') {
          note({ ev: 'tool_use', name: b.name, bg: b.input?.run_in_background ?? false, cmd: String(b.input?.command ?? b.input?.description ?? '').slice(0, 60), sidechain: m.parent_tool_use_id ?? null });
          if (!interrupted && b.name === 'Bash' && !b.input?.run_in_background && /sleep 120|fg\.txt/.test(String(b.input?.command)) && m.parent_tool_use_id == null) {
            timers.push(setTimeout(async () => {
              interrupted = true;
              note({ ev: 'INTERRUPT', files: files() });
              await q.interrupt().catch((e: unknown) => note({ ev: 'interrupt-error', e: String(e) }));
              note({ ev: 'interrupt-returned' });
              // phase 2: the new words after the stop, after the background work would have finished
              timers.push(setTimeout(() => {
                phase2Sent = true;
                note({ ev: 'PHASE2', files: files() });
                push('[the user interrupted you] New instruction: in one short sentence, tell me which background tasks you started earlier are still running or have finished, and whether you would keep or stop them. Use no tools.');
              }, 45_000));
            }, VARIANT === 'b' ? 8_000 : 3_000));
          }
        } else if (b.type === 'text' && b.text?.trim()) note({ ev: 'text', text: b.text.slice(0, 200), sidechain: m.parent_tool_use_id ?? null });
      }
    } else if (m.type === 'result') {
      costUsd += m.total_cost_usd ?? 0;
      note({ ev: 'result', subtype: m.subtype, isError: m.is_error, files: files(), costUsd: m.total_cost_usd });
      if (phase2Sent) { closed = true; wake?.(); }
    } else if (m.type === 'system') {
      note({ ev: 'system', subtype: m.subtype, status: m.status ?? m.task_status ?? undefined, task: m.task_id ?? undefined, summary: String(m.summary ?? m.description ?? '').slice(0, 80) || undefined });
    } else if (m.type === 'user') {
      for (const b of m.message?.content ?? []) if (b.type === 'tool_result') note({ ev: 'tool_result', id: String(b.tool_use_id).slice(-6), sidechain: m.parent_tool_use_id ?? null, text: JSON.stringify(b.content).slice(0, 120) });
    }
  }
})();

const hardStop = setTimeout(() => { note({ ev: 'HARD-TIMEOUT', files: files() }); closed = true; wake?.(); q.interrupt().catch(() => {}); }, 240_000);
await Promise.race([consume, new Promise((r) => setTimeout(r, 250_000))]);
clearTimeout(hardStop);
for (const t of timers) clearTimeout(t);
const final = files();
note({ ev: 'FINAL', files: final, bashText: final.bash ? readFileSync(path.join(dir, 'bash.txt'), 'utf8').trim() : null, agentText: final.agent ? readFileSync(path.join(dir, 'agent.txt'), 'utf8').trim() : null });
mkdirSync(path.join(HERE, 'traces'), { recursive: true });
writeFileSync(path.join(HERE, 'traces', `e1${VARIANT}-${MODEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ model: MODEL, dir, costUsd, log }, null, 1));
console.log(`costUsd ${costUsd.toFixed(4)}  dir ${dir}`);
process.exit(0);
