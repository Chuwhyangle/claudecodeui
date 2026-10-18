/**
 * X3 — Claude 被插话时的行为（风险点 4）。在原会话的原位置**分叉**，回放真实忙时语音（原文、原时间偏移）。
 *
 * 每次运行：一次性 git worktree（checkout 到该 turn 开始前的 develop 提交，node_modules 符号链接到主仓）；
 * 把原 Claude transcript 复制进该 worktree 的 project 目录，`resume + resumeSessionAt(prompt 的父消息) + forkSession`；
 * 重发开启该 turn 的原 prompt，再按臂把语音段推进去。haiku（人 2026-10-15：实验一律最便宜模型）。
 *
 * 启动参数：`resident-launch.mts`——生产的 `buildResidentSdkOptions`，偏离逐条写在那个文件里。
 *
 * 臂（人 2026-10-15 批准）：
 *   A  第 1 层 hook 关 + 现状投递：忙时各段缓冲，当前 turn 的 result 到达后合成一条投递（新 turn）。
 *   B  第 1 层 hook 开 + 现状投递。
 *   C  hook 开 + 忙时缓冲：停说满 2 s（上游 speech 事件）且距最后一段 ≥0.8 s 才冲洗，20 s 封顶，包含式去重；以 `now` 投递。
 *   D  同 C，以 `next` 投递。
 *   E  D + hook 多一条碎片规则（`VOICE_MODE_RULES_VARIANT=fragments`）：没说完的话只简短应一声、等后续（人 2026-10-15 加入）。
 *   所有臂：空闲时 1 s 合并后投递（现状）。
 *   所有臂：空段与截断 JSON 段丢弃（它们当时没被投递）；30 s 内逐字重复的段丢弃（近似既有重复守卫）。
 *
 * 沙箱（PreToolUse）：worktree 外的写入、网络、测试/构建、:3001、kill/systemctl/quay、git push/commit 等一律拦截。
 *
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-now-priority/x3-replay.mts --episodes <conn@time,...> --arms A,B,C,D --reps 2 --parallel 5 [--model haiku|sonnet] [--models A=haiku,B=sonnet]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { residentOptions } from './resident-launch.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const HOME = os.homedir();
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]! : d; };
const ARMS = arg('arms', 'A,B,C,D').split(',');
const MODEL = arg('model', 'haiku');
/** Per-arm model override, e.g. `A=sonnet,B=sonnet` (X1' gate: B/C/D move to sonnet if haiku does not dispatch). */
const MODEL_BY_ARM = Object.fromEntries(arg('models', '').split(',').filter(Boolean).map((kv) => kv.split('=')));
const HOOK = path.join(HERE, '..', 'voice-foreground-background', 'hook', 'voice-mode-context.mjs');
const hookOn = (arm: string) => arm !== 'A';
const priorityFor = (arm: string) => (arm === 'C' ? 'now' : arm === 'D' || arm === 'E' ? 'next' : 'later');
const merges = (arm: string) => arm === 'C' || arm === 'D' || arm === 'E';
const REPS = Number(arg('reps', '2'));
const PARALLEL = Number(arg('parallel', '6'));
const WANT = arg('episodes', '').split(',').filter(Boolean);
const CAP_MS = Number(arg('cap', '480000'));
/** First repeat index, so a re-run of missing repeats is numbered after the ones already on disk. */
const REP_OFFSET = Number(arg('rep-offset', '0'));
const LABELS = JSON.parse(readFileSync(path.join(HERE, 'x3-labels.json'), 'utf8')) as Array<{ id: string; pieces: Array<{ text: string; label: string }> }>;
const CANDS = JSON.parse(readFileSync(path.join(HERE, 'traces', 'x3-candidates.json'), 'utf8')) as any[];

const norm = (s: string) => s.replace(/[\s，。！？、,.!?"“”…]/g, '');
const deliverable = (t: string) => t.trim() !== '' && !t.trim().startsWith('{');
const encodeProject = (p: string) => p.replace(/[/.]/g, '-');

const guard = (wt: string) => async (input: any) => {
  const name = String(input.tool_name);
  const ti = input.tool_input ?? {};
  const block = (why: string) => ({ decision: 'block', reason: `experiment sandbox: ${why} is disabled here. Continue without it.` });
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const fp = String(ti.file_path ?? ti.notebook_path ?? '');
    if (!path.resolve(wt, fp).startsWith(wt + path.sep)) return block('writing outside the workspace');
  }
  // Plugin MCP tools: reads pass; anything that writes the real task store, drives the browser at the
  // live server, or deletes files is refused (the worktree shares the real git repository).
  if (/^mcp__plugin_quay_quay__(task_write|task_delete|task_add_label|lifecycle_|goal_write|goal_gate|adr_write|meta_write|instrument|init|action_run|gate_run)/.test(name)) return block('writing the task store');
  if (/^mcp__(plugin_[a-z-]+_)?playwright__/.test(name)) return block('browser automation');
  if (/^mcp__plugin_meta-cc_meta-cc__cleanup_temp_files/.test(name)) return block('deleting files');
  if (name === 'Bash') {
    const c = String(ti.command ?? '');
    if (/git\s+(push|commit|reset|rebase|merge|stash|checkout\s+-|worktree)|\bcurl\b|\bwget\b|:3001|\bsystemctl\b|\bpkill\b|\bkillall\b|\bkill\s|\bquay\b|start-drivers|npm\s+(run\s+)?(test|build|dev|start|install)|\bnpx\s+(vitest|playwright|tsc)|\bvitest\b|\bplaywright\b|node\s+--test|scripts\/test|\btsc\b/.test(c)) return block('this command (tests/network/server/git-write)');
    const writes = /(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null)(?!&)|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s|\btee\s|\btouch\s|\bmkdir\s/.test(c);
    if (writes && /\/data\/home\/yale\/(work\/claudecodeui|\.claude|\.cloudcli)|~\/\.(claude|cloudcli)/.test(c)) return block('writing outside the workspace');
  }
  return {};
};

const runOne = async (ep: any, labels: any, arm: string, rep: number) => {
  const runId = `${ep.conn}-${arm}-${rep}-${Date.now().toString(36)}`;
  const wt = path.join(os.tmpdir(), 'x3wt', runId);
  const commit = execFileSync('git', ['-C', REPO, 'rev-list', '-1', `--before=${ep.turnStart}`, 'develop']).toString().trim();
  mkdirSync(path.dirname(wt), { recursive: true });
  execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', '--quiet', wt, commit]);
  symlinkSync(path.join(REPO, 'node_modules'), path.join(wt, 'node_modules'));
  const projDir = path.join(HOME, '.claude', 'projects', encodeProject(wt));
  mkdirSync(projDir, { recursive: true });
  const fork = Boolean(ep.promptParentUuid);
  if (fork) copyFileSync(ep.jsonlPath, path.join(projDir, `${ep.claudeSession}.jsonl`));

  // pieces after filtering (deliverable + 30 s exact-dup suppression), with the original offsets
  const pieces: Array<{ offsetMs: number; text: string; label: string }> = [];
  const lastSeen = new Map<string, number>();
  let li = 0;
  for (const p of ep.pieces) {
    if (p.tool !== 'session_send' || !deliverable(p.text)) continue;
    const label = labels.pieces[li++]?.label ?? '?';
    const n = norm(p.text);
    if (lastSeen.has(n) && p.offsetMs - lastSeen.get(n)! < 30_000) continue;
    lastSeen.set(n, p.offsetMs);
    pieces.push({ offsetMs: p.offsetMs, text: p.text, label });
  }
  const speech = (ep.speech ?? []) as Array<{ offsetMs: number; k: string }>;

  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const ev: any[] = [];
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let busy = false;
  const push = (text: string, priority: string | null, kind: string, parts: string[]) => {
    queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', ...(priority ? { priority } : {}) });
    ev.push({ t: at(), ev: 'DELIVER', kind, priority, text, parts });
    busy = true;
    wake?.();
  };
  async function* input() { while (!closed) { if (queue.length) { yield queue.shift(); continue; } await new Promise<void>((r) => (wake = r)); wake = null; } }

  push(ep.promptFull, null, 'prompt', []);
  const q = query({
    prompt: input() as never,
    options: residentOptions({
      cwd: wt,
      model: MODEL_BY_ARM[arm] ?? MODEL,
      ...(fork ? { fork: { sessionId: ep.claudeSession, atUuid: ep.promptParentUuid } } : {}),
      hooks: { PreToolUse: [{ hooks: [guard(wt)] }] },
      ...(hookOn(arm) ? { settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${HOOK}` }] }] } }, env: { VOICE_MODE_HOOK_FORCE: '1', ...(arm === 'E' ? { VOICE_MODE_RULES_VARIANT: 'fragments' } : {}) } } : {}),
    }) as never,
  });

  // arm delivery machinery
  let buf: Array<{ text: string; label: string; offsetMs: number }> = [];
  let idleTimer: NodeJS.Timeout | null = null;
  const dedupe = (parts: string[]) => { const out: string[] = []; for (const p of parts) { const n = norm(p); const i = out.findIndex((q2) => norm(q2).includes(n) || n.includes(norm(q2))); if (i >= 0) { if (n.length > norm(out[i]!).length) out[i] = p; } else out.push(p); } return out; };
  const flush = (why: string) => {
    if (!buf.length) return;
    const parts = merges(arm) ? dedupe(buf.map((b) => b.text)) : buf.map((b) => b.text);
    const pri = !busy ? null : priorityFor(arm);
    push(parts.join(''), pri, why, buf.map((b) => `${b.label}:${b.text}`));
    buf = [];
  };
  const quietDue = () => {
    const lastPiece = buf.at(-1)!.offsetMs;
    const stops = speech.filter((s) => s.k === 'stop' && s.offsetMs <= at());
    const starts = speech.filter((s) => s.k === 'start' && s.offsetMs <= at());
    const lastStop = stops.at(-1)?.offsetMs ?? lastPiece;
    const talking = (starts.at(-1)?.offsetMs ?? -1) > lastStop;
    return { due: Math.max(lastPiece + 800, lastStop + 2000), talking, capDue: buf[0]!.offsetMs + 20_000 };
  };
  const tick = setInterval(() => {
    if (!buf.length) return;
    if (merges(arm) && busy) {
      const { due, talking, capDue } = quietDue();
      if ((!talking && at() >= due) || at() >= capDue) flush('quiet');
    }
  }, 100);
  const timers = pieces.map((p) => setTimeout(() => {
    ev.push({ t: at(), ev: 'PIECE', label: p.label, text: p.text });
    if (!busy) { // idle: today's 1 s coalesce, every arm
      buf.push(p);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => flush('idle'), 1000);
      return;
    }
    buf.push(p); // every arm buffers while busy: A/B release at the turn's end, C/D on the quiet window
  }, p.offsetMs));

  let lastActivity = Date.now();
  const lastPieceAt = pieces.length ? pieces.at(-1)!.offsetMs : 0;
  const consume = (async () => {
    try {
      for await (const m of q as AsyncIterable<any>) {
        lastActivity = Date.now();
        if (m.type === 'system' && m.subtype === 'init') ev.push({ t: at(), ev: 'TURN' });
        if (m.type === 'assistant' && !m.parent_tool_use_id) for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use') ev.push({ t: at(), ev: 'TOOL', name: b.name, input: String(b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? b.input?.prompt ?? '').slice(0, 160), bg: b.input?.run_in_background === true });
          if (b.type === 'text' && b.text.trim()) ev.push({ t: at(), ev: 'TEXT', text: b.text });
        }
        if (m.type === 'user' && !m.parent_tool_use_id) for (const b of m.message?.content ?? []) if (b.type === 'tool_result' && /experiment sandbox/.test(JSON.stringify(b.content))) ev.push({ t: at(), ev: 'BLOCKED' });
        if (m.type === 'result') {
          ev.push({ t: at(), ev: 'RESULT', subtype: m.subtype });
          busy = false;
          flush('turn-end'); // A/B's release point; C/D's leftover
        }
      }
    } catch (e) { ev.push({ t: at(), ev: 'ERROR', e: String(e).slice(0, 200) }); }
  })();
  // end: all pieces delivered and 25 s with no stream activity, or the cap
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const done = at() > lastPieceAt + 3000 && !buf.length && !busy && Date.now() - lastActivity > 25_000;
      if (done || at() > Math.min(CAP_MS, Math.max(ep.turnMs, lastPieceAt) + 240_000)) { clearInterval(iv); resolve(); }
    }, 1000);
  });
  clearInterval(tick); timers.forEach(clearTimeout); if (idleTimer) clearTimeout(idleTimer);
  closed = true; wake?.();
  await (q as any).interrupt?.().catch(() => {});
  await Promise.race([consume, new Promise((r) => setTimeout(r, 5000))]);
  let diff = '';
  try { diff = execFileSync('git', ['-C', wt, 'diff', '--stat'], { maxBuffer: 1 << 20 }).toString(); } catch { /* none */ }
  try { execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt]); } catch { rmSync(wt, { recursive: true, force: true }); }
  rmSync(projDir, { recursive: true, force: true });
  return { episode: ep.id, arm, rep, model: MODEL_BY_ARM[arm] ?? MODEL, hook: hookOn(arm), commit, fork, pieces, diffStat: diff, wallMs: at(), capped: at() >= Math.min(CAP_MS, Math.max(ep.turnMs, lastPieceAt) + 240_000), events: ev };
};

// Match on the id prefix given. A minute-precision prefix can match SEVERAL turns of one connection
// (2026-10-15: d4c9bfc4/af12cbaf/a175e6cd/99df08d8 had extra turns in the same minute), so callers
// pass second-precision ids (`conn@MM-DDTHH:MM:SS`).
const eps = CANDS.filter((c) => WANT.some((w) => (w.includes('@') ? c.id.startsWith(w) : c.id.startsWith(w) && c.id === CANDS.find((x) => x.id.startsWith(w))!.id)));
const jobs: Array<() => Promise<any>> = [];
for (let r = REP_OFFSET; r < REP_OFFSET + REPS; r++) for (const ep of eps) for (const arm of ARMS) {
  const labels = LABELS.find((l) => ep.id.startsWith(l.id)) ?? { pieces: [] };
  jobs.push(() => runOne(ep, labels, arm, r));
}
const outDir = path.join(HERE, 'traces', `x3-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });
let k = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (k < jobs.length) {
    const j = jobs[k++]!;
    const res = await j().catch((e) => ({ error: String(e).slice(0, 300) }));
    const name = res.error ? `error-${Date.now()}` : `${res.episode.replace(/[@:]/g, '_')}-${res.arm}-${res.rep}`;
    writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(res, null, 1));
    console.log(new Date().toISOString().slice(11, 19), name, res.error ?? `wall ${Math.round(res.wallMs / 1000)}s turns ${res.events.filter((e: any) => e.ev === 'TURN').length} delivers ${res.events.filter((e: any) => e.ev === 'DELIVER').length} blocked ${res.events.filter((e: any) => e.ev === 'BLOCKED').length} bg ${res.events.filter((e: any) => e.ev === 'TOOL' && (e.bg || e.name === 'Agent')).length}${res.capped ? ' CAPPED' : ''}`);
  }
}));
console.log('out', outDir);
process.exit(0);
