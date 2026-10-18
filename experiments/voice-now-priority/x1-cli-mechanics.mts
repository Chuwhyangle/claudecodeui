/**
 * X1 — `priority` 消息在 CLI 里的机制（风险点 1–3）。haiku，临时目录，SDK 流式输入（与常驻宿主同形）。
 *
 * 每条推入的 user 帧带自己的 `uuid`；记录流上的**每一种** message type/subtype（thinking_tokens 除外）、
 * 每个 uuid 的 `command_lifecycle`、`result` 的个数与时刻，以及 Claude 第一次提到该帧标记词的时刻（= 实际读到）。
 *
 * 情形：
 *   a  空闲时一条 now
 *   b  前台短步中途一条 now
 *   c  前台长工具（~30 s）中途一条 now
 *   d  前台短步中途连发 3 条 now
 *   e  Claude 写最终回答（无工具）时一条 now
 *   f1 = b 但用 next；f2 = c 但用 next（核对 driver 注释里「next 永不落地」）
 *
 *   npx tsx experiments/voice-now-priority/x1-cli-mechanics.mts [--cases a,b,c,d,e,f1,f2] [--reps 3] [--parallel 6]
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const CASES = arg('cases', 'a,b,c,d,e,f1,f2').split(',');
const REPS = Number(arg('reps', '3'));
const PARALLEL = Number(arg('parallel', '6'));

type Push = { uuid: string; marker: string; priority: string | null; at: number };

const runCase = async (name: string, rep: number) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `x1-${name}-`));
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const events: Array<Record<string, unknown>> = [];
  const pushes: Push[] = [];
  const queue: Array<Record<string, unknown>> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const push = (text: string, priority: string | null, marker = '') => {
    const uuid = randomUUID();
    queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid, ...(priority ? { priority } : {}) });
    pushes.push({ uuid, marker, priority, at: at() });
    events.push({ t: at(), ev: 'PUSH', uuid, priority, marker });
    wake?.();
    return uuid;
  };
  async function* input() { while (!closed) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>((r) => (wake = r)); wake = null; } }

  const step = (n: number) => `echo step${n} >> ${dir}/fg.txt; for i in 1 2; do sleep 1.5; done`;
  const loop = `for i in $(seq 1 15); do echo $i >> ${dir}/long.txt; sleep 2; done; echo end >> ${dir}/long.txt`;
  const stepsPrompt = ['Mechanics test. Run these 8 Bash commands in the FOREGROUND, one tool call each, strictly sequentially, no explanations:', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n}. ${step(n)}`), 'If a new message from the user arrives while you work, do what it says and then continue with the remaining steps.'].join('\n');
  const longPrompt = `Mechanics test. Run this ONE Bash command in the FOREGROUND (not in the background) and wait for it, then reply DONE: ${loop}\nIf a new message from the user arrives, do what it says.`;
  const pri = name === 'f1' || name === 'f2' ? 'next' : 'now';

  let first: string;
  if (name === 'a') first = 'Reply with the single word READY.';
  else if (name === 'c' || name === 'f2') first = longPrompt;
  else if (name === 'e') first = 'Write a 350-word essay about ocean tides. Use no tools. If a new message from the user arrives, do what it says.';
  else first = stepsPrompt;
  push(first, null, '');

  const q = query({ prompt: input(), options: { cwd: dir, model: 'haiku', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [] } as never });
  const schedule = (ms: number, fn: () => void) => setTimeout(fn, ms);
  let triggered = false;
  let results = 0;
  const seenMarker = new Map<string, number>();
  const textSeen = (txt: string) => { for (const p of pushes) if (p.marker && !seenMarker.has(p.marker) && txt.includes(p.marker)) seenMarker.set(p.marker, at()); };

  const consume = (async () => {
    for await (const m of q as AsyncIterable<Record<string, any>>) {
      const type = String(m.type);
      const subtype = m.subtype ? String(m.subtype) : '';
      if (subtype === 'thinking_tokens' || type === 'stream_event') continue;
      const rec: Record<string, unknown> = { t: at(), type, subtype };
      if (m.command_uuid) { rec.command_uuid = m.command_uuid; rec.state = m.state; }
      if (m.uuid && type === 'user') rec.uuid = m.uuid;
      if (type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use') {
            rec.tool = String(b.input?.command ?? '').slice(0, 40);
            const cmd = String(b.input?.command ?? '');
            if (!triggered) {
              if ((name === 'b' || name === 'f1') && /step2/.test(cmd)) { triggered = true; schedule(1500, () => push('NEW MESSAGE: also run: echo INJ_X1 >> ' + dir + '/inj.txt  — and say the word KIWI.', pri, 'KIWI')); }
              if (name === 'd' && /step2/.test(cmd)) { triggered = true; schedule(1500, () => { push('Say the word ALPHA.', 'now', 'ALPHA'); push('Say the word BRAVO.', 'now', 'BRAVO'); push('Say the word CHARLIE.', 'now', 'CHARLIE'); }); }
              if ((name === 'c' || name === 'f2') && /long\.txt/.test(cmd)) { triggered = true; schedule(5000, () => push('NEW MESSAGE: say the word KIWI.', pri, 'KIWI')); }
            }
          }
          if (b.type === 'text') { rec.text = String(b.text).slice(0, 80); textSeen(String(b.text)); }
        }
      }
      if (type === 'result') { results += 1; rec.n = results; if (typeof m.result === 'string') textSeen(m.result); }
      events.push(rec);
      if (name === 'a' && type === 'result' && results === 1 && !triggered) { triggered = true; schedule(1500, () => push('Now reply with the single word KIWI.', 'now', 'KIWI')); }
      if (name === 'e' && type === 'system' && subtype === 'init' && !triggered) { triggered = true; schedule(4000, () => push('NEW MESSAGE: end your essay with the word KIWI.', 'now', 'KIWI')); }
    }
  })();
  await new Promise((r) => setTimeout(r, name === 'c' || name === 'f2' ? 75_000 : 60_000));
  closed = true; wake?.();
  await q.interrupt().catch(() => {});
  await Promise.race([consume, new Promise((r) => setTimeout(r, 5_000))]);

  const life = events.filter((e) => e.command_uuid);
  const summary = pushes.filter((p) => p.marker).map((p) => ({
    marker: p.marker,
    priority: p.priority,
    pushedAt: p.at,
    lifecycle: life.filter((e) => e.command_uuid === p.uuid).map((e) => `${e.state}@${e.t}`),
    readAt: seenMarker.get(p.marker) ?? null,
  }));
  const firstLife = life.filter((e) => e.command_uuid === pushes[0]!.uuid).map((e) => `${e.state}@${e.t}`);
  const types = [...new Set(events.map((e) => `${e.type}${e.subtype ? '/' + e.subtype : ''}`))];
  return { name, rep, results, resultTimes: events.filter((e) => e.type === 'result').map((e) => e.t), firstPromptLifecycle: firstLife, pushes: summary, types, events };
};

const jobs: Array<() => Promise<any>> = [];
for (let r = 0; r < REPS; r++) for (const c of CASES) jobs.push(() => runCase(c, r));
const out: any[] = [];
let k = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => { while (k < jobs.length) { const j = jobs[k++]!; const res = await j().catch((e) => ({ error: String(e) })); out.push(res); console.log(JSON.stringify({ name: res.name, rep: res.rep, results: res.results, firstLife: res.firstPromptLifecycle, pushes: res.pushes, err: res.error })); } }));
const file = path.join(HERE, 'traces', `x1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log('trace', file);
process.exit(0);
