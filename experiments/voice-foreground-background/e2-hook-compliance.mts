/**
 * E2 — 注入 voice 规则（UserPromptSubmit hook）后，Claude Code 在**真实语音指令**上会不会第一步就派后台？
 *
 * 语料：`analyze-turns.mjs` 找出的真实语音投递（原文取自 voice journal 的 `session_send`），选当时前台
 * turn 很长的若干条 + 很短的若干条。每条 × 两臂（hook 关 / 开），生产模型，cwd = 本仓库。
 *
 * 安全：只读工具（Read/Grep/Glob）放行；其余一切工具（含 Agent、Bash、Edit）由 PreToolUse 回调**记录后拦下**，
 * 所以不会派出任何真 Agent、不跑命令、不改文件。读数 = 第一个非只读动作（后台派发 / 前台 Agent / 前台命令或改动
 * / 不用工具直接答）以及在它之前前台已花的秒数。
 *
 * 局限：语音指令原本在长对话中间，这里是冷启动单条；拦截会让模型在第一次决策后偏离，所以只读第一次决策。
 *
 *   npx tsx experiments/voice-foreground-background/e2-hook-compliance.mts [--model haiku] [--arms off,on,fast] [--parallel 4]
 *
 * 模型默认 haiku（人 2026-10-15：实验一律用最便宜的模型）。首轮误用 opus 跑过一次，trace 保留作对照。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const MODEL = arg('model', 'haiku');
const PARALLEL = Number(arg('parallel', '4'));
const HOOK = path.join(HERE, 'hook', 'voice-mode-context.mjs');
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch']);

// corpus: full delivered text from the journals, turn length from analyze-turns' trace
const { turns } = JSON.parse(readFileSync(path.join(HERE, 'traces', 'turns.json'), 'utf8')) as { turns: Array<{ appSession: string; ms: number; message: string }> };
const LOG_DIR = path.join(os.homedir(), '.cloudcli', 'voice-realtime-log');
const full = new Map<string, string>();
for (const f of readdirSync(LOG_DIR).filter((n) => n.endsWith('.jsonl'))) {
  for (const l of readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
    try { const e = JSON.parse(l); if (e.kind === 'session_send' && typeof e.message === 'string') full.set(e.message.slice(0, 60), e.message); } catch { /* skip */ }
  }
}
const seen = new Set<string>();
const pool = turns.filter((t) => t.appSession !== '3c308639' && t.message.length >= 8 && !seen.has(t.message) && seen.add(t.message));
const long = pool.filter((t) => t.ms > 60_000).sort((a, b) => b.ms - a.ms).slice(0, Number(arg('long', '7')));
const short = pool.filter((t) => t.ms < 10_000).slice(0, Number(arg('short', '4')));
const corpus = [...long, ...short].map((t) => ({ origMs: t.ms, kind: t.ms > 60_000 ? 'long' : 'short', text: full.get(t.message) ?? t.message }));

type Decision = { kind: 'background' | 'fg-agent' | 'fg-action' | 'answer' | 'none'; tool?: string; detail?: string; atS: number; readsBefore: number };

type ArmName = 'off' | 'on' | 'fast';
const ARMS = arg('arms', 'off,on,fast').split(',') as ArmName[];
const runOne = async (text: string, arm: ArmName): Promise<Decision & { hookSeen: boolean }> => {
  const t0 = Date.now();
  let reads = 0;
  let decision: Decision | null = null;
  let hookSeen = false;
  const ac = new AbortController();
  const q = query({
    prompt: text,
    options: {
      cwd: REPO,
      model: MODEL,
      abortController: ac,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: 8,
      env: { ...process.env, VOICE_MODE_HOOK_FORCE: arm === 'off' ? '0' : '1', VOICE_MODE_RULES_VARIANT: arm === 'fast' ? 'fast' : '' },
      settings: arm !== 'off' ? { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${HOOK}` }] }] } } : {},
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            const name = String(input.tool_name);
            if (READ_ONLY.has(name)) { reads += 1; return {}; }
            if (decision === null) {
              const bg = input.tool_input?.run_in_background === true;
              decision = {
                kind: bg ? 'background' : name === 'Agent' ? 'fg-agent' : 'fg-action',
                tool: name,
                detail: String(input.tool_input?.description ?? input.tool_input?.command ?? input.tool_input?.file_path ?? '').slice(0, 80),
                atS: +((Date.now() - t0) / 1000).toFixed(1),
                readsBefore: reads,
              };
              setTimeout(() => ac.abort(), 50);
            }
            return { decision: 'block', reason: 'experiment: tool recorded, not executed' };
          }],
        }],
      },
    } as never,
  });
  try {
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === 'system' && m.subtype === 'hook_response' && /UserPromptSubmit/.test(JSON.stringify(m))) hookSeen = true;
      if (m.type === 'user' && typeof m.message?.content === 'string' && m.message.content.includes('[Live Voice 模式]')) hookSeen = true;
      if (m.type === 'result' && decision === null) {
        decision = { kind: 'answer', atS: +((Date.now() - t0) / 1000).toFixed(1), readsBefore: reads, detail: String(m.result ?? '').slice(0, 80) };
      }
      if (Date.now() - t0 > 180_000) { ac.abort(); break; }
    }
  } catch { /* abort after the decision is the normal end */ }
  return { ...(decision ?? { kind: 'none', atS: +((Date.now() - t0) / 1000).toFixed(1), readsBefore: reads }), hookSeen };
};

const jobs: Array<() => Promise<Record<string, unknown>>> = [];
for (const [i, c] of corpus.entries()) for (const arm of ARMS) {
  jobs.push(async () => { const r = await runOne(c.text, arm); const row = { i, arm, kind: c.kind, origS: Math.round(c.origMs / 1000), ...r, text: c.text.slice(0, 50) }; console.log(JSON.stringify(row)); return row; });
}
const results: Array<Record<string, unknown>> = [];
let next = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => { while (next < jobs.length) { const j = jobs[next++]!; results.push(await j().catch((e) => ({ error: String(e) }))); } }));
mkdirSync(path.join(HERE, 'traces'), { recursive: true });
const file = path.join(HERE, 'traces', `e2-${MODEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ model: MODEL, corpus, results }, null, 1));
console.log(`trace ${file}`);
process.exit(0);
