#!/usr/bin/env node
// Replays out/events.jsonl (from collect.mjs) through the PREREG pipeline, attaches related
// sessions, scores against outcome-derived labels, and writes notifications + metrics.
//
//   node replay.mjs [--out out/] [--projects-dir ~/.claude/projects] [--no-sessions]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, stage1, stage2, stage3, stage4, naiveNotifications, groundTruth, score, classifyExecutor } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = opt('out', path.join(HERE, 'out'));
const PROJECTS_DIR = opt('projects-dir', path.join(os.homedir(), '.claude', 'projects'));

const ctx = JSON.parse(fs.readFileSync(path.join(OUT, 'context.json'), 'utf8'));
const raw = fs.readFileSync(path.join(OUT, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const NOW = Date.parse(ctx.window.now);

// statusAt from the git status history, falling back to the current file status.
const transitions = new Map();
for (const e of raw) if (e.source === 'git:tasks') {
  const k = `${e.project}|${e.entity.slice(5)}`;
  (transitions.get(k) ?? transitions.set(k, []).get(k)).push(e);
}
const statusAt = (project, taskId, ms) => {
  const k = `${project}|${taskId}`;
  const list = transitions.get(k);
  if (!list) return ctx.currentStatus[k] ?? null;
  let st = list[0].attrs.from ?? null;
  for (const e of list) if (Date.parse(e.ts) <= ms) st = e.attrs.to;
  return st;
};
const RELEASE_RULE = opt('release-rule', 'strict');
const context = {
  windowStartMs: Date.parse(ctx.window.since),
  releaseTasks: new Set(RELEASE_RULE === 'keyword' ? ctx.releaseTasksKeyword : ctx.releaseTasks),
  downstream: new Map(Object.entries(ctx.downstream)),
  statusAt,
};

const s1 = stage1(raw);
const s2 = stage2(s1.events, NOW);
const s3 = stage3(s2.events);

// D1: label first, because stage 4 needs to know which failure-streak hits belong to a task that
// later landed (a cost signal) as opposed to one that never did (a real miss).
const labels = groundTruth(raw, NOW, DEFAULTS);
const costTasks = new Set([...labels].filter(([, l]) => l.label === 'GT$').map(([k]) => k));
context.costTasks = costTasks;

const graded = stage4(s3.events, NOW, context, DEFAULTS);
const alerts = graded.filter((e) => e.level === 'Notify' || e.level === 'Escalate');
const naive = naiveNotifications(raw);

// Before/after contrast: regrade the SAME window under the pre-rework rules (D1/D2/backlog off).
const labelsBefore = groundTruth(raw, NOW, { ...DEFAULTS, d1: false });
const gradedBefore = stage4(s3.events, NOW, { ...context, costTasks: new Set() }, { ...DEFAULTS, d1: false, d2: false, backlogSummary: false });
const alertsBefore = gradedBefore.filter((e) => e.level === 'Notify' || e.level === 'Escalate');

// ---- related sessions: worker sessions by session_id, plus any session that names the task ----
const sessionIdsByTask = new Map();
const workerSessionIds = new Set();
for (const e of raw) if (e.kind === 'outcome' && e.attrs.sessionId) {
  workerSessionIds.add(e.attrs.sessionId);
  const k = `${e.project}|${e.entity.slice(5)}`;
  (sessionIdsByTask.get(k) ?? sessionIdsByTask.set(k, new Set()).get(k)).add(e.attrs.sessionId);
}
const sessionGaps = [];
const mentions = new Map(); // '<project>|<task>' -> [{file, kind}]
const parkActors = new Map(); // taskId -> {session, title, ts} — who issued a needs-human write
const projectOfDir = (dir) => {
  let best = null;
  for (const p of ctx.projects) {
    const base = `-data-home-yale-work-${p}`;
    if ((dir === base || dir.startsWith(`${base}-`)) && (!best || base.length > best.base.length)) best = { p, base };
  }
  return best?.p ?? null;
};
if (!argv.includes('--no-sessions') && fs.existsSync(PROJECTS_DIR)) {
  const alertTasks = [...new Set(alerts.filter((a) => a.entity.startsWith('task:')).map((a) => a.entity.slice(5)))];
  const files = [];
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const p = projectOfDir(dir);
    if (!p) continue;
    const full = path.join(PROJECTS_DIR, dir);
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(full, f);
      if (fs.statSync(fp).mtimeMs >= Date.parse(ctx.window.since)) files.push({ fp, p, dir });
    }
  }
  // Executor attribution (G1): the park commit subject says WHAT parked it (mechanical vs task_write);
  // the transcript that issued the write says WHO. Only in-window sessions are scanned — a pre-window
  // park's issuer is genuinely unavailable, and it is reported as such rather than guessed at.
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f.fp, 'utf8'); } catch { continue; }
    if (!txt.includes('needs-human')) continue; // cheap prune before the JSON walk
    let title = null;
    const sess = path.basename(f.fp, '.jsonl');
    for (const line of txt.split('\n')) {
      if (!line || (!line.includes('needs-human') && !line.includes('custom-title'))) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type === 'custom-title' && r.customTitle) { title = r.customTitle; continue; }
      const c = r.message?.content;
      if (!Array.isArray(c) || !r.timestamp) continue;
      for (const b of c) {
        if (b?.type !== 'tool_use') continue;
        const inp = b.input ?? {};
        let id = null;
        if (/task_write|task-write|task write/.test(b.name ?? '') && typeof inp.id === 'string')
          id = (JSON.stringify(inp).includes('needs-human') || inp.status === 'needs-human') ? inp.id : null;
        else if (b.name === 'Bash') {
          const m = /quay\s+task\s+(?:edit|write)\s+([A-Za-z0-9_.-]+)/.exec(String(inp.command ?? ''));
          if (m && String(inp.command).includes('needs-human')) id = m[1];
        }
        if (id) parkActors.set(id, { session: sess, title, ts: r.timestamp });
      }
    }
  }
  if (alertTasks.length && files.length) {
    const pat = path.join(OUT, 'alert-task-ids.txt');
    fs.writeFileSync(pat, alertTasks.join('\n') + '\n');
    const listFile = path.join(OUT, 'session-files.txt');
    fs.writeFileSync(listFile, files.map((f) => f.fp).join('\0'));
    const text = execFileSync('bash', ['-c', `xargs -0 grep -oHFw -f "$1" < "$2" | sort -u`, '_', pat, listFile], {
      encoding: 'utf8', maxBuffer: 64 << 20,
    });
    const byPath = new Map(files.map((f) => [f.fp, f]));
    for (const line of text.split('\n').filter(Boolean)) {
      const i = line.lastIndexOf(':');
      const fp = line.slice(0, i);
      const task = line.slice(i + 1);
      const f = byPath.get(fp);
      if (!f) continue;
      const sid = path.basename(fp, '.jsonl');
      const kind = workerSessionIds.has(sid) ? 'worker' : f.dir.includes('worktrees') ? 'worktree-other' : 'main-dir';
      const k = `${f.p}|${task}`;
      (mentions.get(k) ?? mentions.set(k, []).get(k)).push({ session: sid, dir: f.dir, kind });
    }
  }
  // A worker session is "linked" when its transcript file exists under the project family.
  const alertKeys = new Set(alerts.map((a) => `${a.project}|${a.entity.slice(5)}`));
  const transcriptOf = new Map(files.map((f) => [path.basename(f.fp, '.jsonl'), f]));
  for (const [k, ids] of sessionIdsByTask) if (alertKeys.has(k)) for (const sid of ids) {
    if (!transcriptOf.has(sid)) sessionGaps.push({ task: k, session: sid, note: 'worker session_id has no transcript modified in the window under the project family' });
  }
}

const sortTs = (a, b) => Date.parse(a.ts) - Date.parse(b.ts);
alerts.sort(sortTs);
const notifications = alerts.map((a) => {
  const task = a.entity.startsWith('task:') ? a.entity.slice(5) : null;
  const k = `${a.project}|${task}`;
  const sess = mentions.get(k) ?? [];
  return {
    ts: a.ts,
    level: a.level,
    rule: a.rule,
    project: a.project,
    entity: a.entity,
    attrs: a.attrs,
    evidence: a.evidence,
    gt: labels.get(k)?.label ?? null,
    sessions: {
      worker: [...(sessionIdsByTask.get(k) ?? [])],
      mainDir: sess.filter((s) => s.kind === 'main-dir').map((s) => s.session),
      otherWorktrees: sess.filter((s) => s.kind === 'worktree-other').length,
    },
  };
});

// needs-human episodes: enter (either source) paired with the git exit, with cause and duration.
const episodes = [];
const openEp = new Map();
for (const e of s3.events) {
  const k = `${e.project}|${e.entity.slice(5)}`;
  if (e.kind === 'needs-human-enter') openEp.set(k, {
    task: k,
    enteredTs: e.ts,
    via: e.source,
    cause: e.attrs.cause ?? null,
    executor: e.attrs.executor ?? classifyExecutor(e.attrs.subject),
    parkSubject: e.attrs.subject ?? null,
    parkSha: e.evidence?.sha ?? null,
  });
  if (e.kind === 'needs-human-exit' && openEp.has(k)) {
    const ep = openEp.get(k);
    openEp.delete(k);
    episodes.push({ ...ep, exitedTs: e.ts, exitTo: e.attrs.to, exitSubject: e.attrs.subject ?? null, hours: +((Date.parse(e.ts) - Date.parse(ep.enteredTs)) / 3600e3).toFixed(2) });
  }
}
for (const ep of openEp.values()) episodes.push({ ...ep, exitedTs: null, hours: +((NOW - Date.parse(ep.enteredTs)) / 3600e3).toFixed(2), openAtEnd: true });

// Executor coverage (G1): the executor is fully determined by the park commit subject; the actor is a
// weaker, session-derived refinement. A task_write whose issuing session is not in the window stays
// `cli-unattributed` — we record the gap instead of inventing a human.
for (const ep of episodes) {
  const tid = ep.task.slice(ep.task.indexOf('|') + 1);
  const a = parkActors.get(tid);
  if (ep.executor === 'mechanical') ep.actor = 'driver';
  else if (ep.executor === 'task_write' && a) {
    ep.actor = /-(?:task|fix)-worker$/.test(a.title ?? '') ? 'worker-session' : 'session-other';
    ep.actorEvidence = { session: a.session, title: a.title, ts: a.ts };
  } else if (ep.executor === 'task_write') ep.actor = 'cli-unattributed';
  else ep.actor = 'none';
}
const g1 = {
  episodes: episodes.length,
  executor: episodes.reduce((m, e) => ((m[e.executor] = (m[e.executor] ?? 0) + 1), m), {}),
  actor: episodes.reduce((m, e) => ((m[e.actor] = (m[e.actor] ?? 0) + 1), m), {}),
  unknown: episodes.filter((e) => e.executor === 'unknown').length,
  identified: episodes.filter((e) => e.executor !== 'unknown').length,
};
// Lead time: how far ahead of the needs-human park the first alert for that task fired.
const leads = [];
for (const ep of episodes) {
  const first = alerts.find((a) => `${a.project}|${a.entity.slice(5)}` === ep.task && a.kind !== 'needs-human-enter');
  if (first && Date.parse(first.ts) < Date.parse(ep.enteredTs)) leads.push({ task: ep.task, rule: first.rule, leadHours: +((Date.parse(ep.enteredTs) - Date.parse(first.ts)) / 3600e3).toFixed(2) });
}
fs.writeFileSync(path.join(OUT, 'needs-human-episodes.json'), JSON.stringify({ episodes, leads }, null, 1));

const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const sc = score(alerts, labels);
const scNaive = score(naive, labels);
const scBefore = score(alertsBefore, labelsBefore);

// D3 calibration set — the human "该不该打扰" marks on the parent task's Resolution, verbatim.
// [n, bucket, project, task, expected rule under the reworked rules]
const D3 = [
  [1, '打扰', 'claudecodeui', 'gap-voice-false-forms-gates-repeated-fix-orphaned-never-merged', 'cost-signal'],
  [2, '打扰', 'claudecodeui', 'gap-mcp-session-send-reports-pending-interaction-it-queued-behind', 'cost-signal'],
  [3, '打扰', 'quay', 'gap-routine-semantic-dedup-scan-parse-args-handrolled-variants', 'cost-signal'],
  [4, '打扰', 'claudecodeui', 'gap-debug-agent-simulates-permission-popup-for-mcp-e2e', 'cost-signal'],
  [5, 'Record', 'claudecodeui', 'gap-ac120-upload-input-locator-ambiguous', 'failure-unrecovered'],
  [6, 'Record', 'quay', 'gap-ownership-replay-benchmark-redesign-two-stage', 'failure-unrecovered'],
  [7, 'Record', 'quay-fleet', 'gap-pwa-ac077-antishadow-control-splice-exact', null],
  [8, 'Record', 'quay', 'gap-retire-needs-human-cause-enumeration', null],
  [9, 'Record', 'claudecodeui', 'gap-server-phase-concurrency-clamp', null],
  [10, 'Record', 'quay-fleet', 'gap-ac014-duplicate-sessionkey-from-resume', null],
  [11, 'Record', 'quay-fleet', 'gap-ac009-criterion-transient-cli-unavailable', null],
  [12, '打扰', 'claudecodeui', 'gap-voice-realtime-microphone-human-smoke-test', 'needs-human-expired'],
  [13, '打扰', 'claudecodeui', 'gap-quay-tab-loop-pulse-gantt-integration', 'needs-human-expired'],
  [14, '打扰', 'claudecodeui', 'gap-quay-tab-loop-pulse-gantt-integration', 'cross-project-upstream-landed'],
];
const backlogEv = graded.find((g) => g.kind === 'needs-human-backlog');
const calibration = D3.map(([n, bucket, project, task, rule]) => {
  const key = `${project}|task:${task}`;
  const cand = alerts.filter((a) => `${a.project}|${a.entity}` === key);
  const hit = rule ? cand.find((a) => a.rule === rule) : null;
  const rec = graded.find((g) => `${g.project}|${g.entity}` === key && g.level === 'Record');
  const landing = hit ? `${hit.level}:${hit.rule}`
    : cand.length ? `${cand[0].level}:${cand[0].rule}`
    : backlogEv?.attrs.tasks.includes(`${project}|${task}`) ? 'Record:pre-window-backlog'
    : rec ? `Record:${rec.rule}` : 'none';
  return { n, bucket, project, task, expectRule: rule, landing, pass: bucket !== '打扰' || !!hit };
});
const rulerFailures = calibration.filter((c) => !c.pass);
// The outcome label counts every needs-human entry as GT+, so the transitions D2/③ deliberately demote
// (mechanical parks, pre-window legacy parks) show up as "misses" that are actually policy, not gaps.
const winStart = Date.parse(ctx.window.since);
const backlogTasks = new Set(backlogEv?.attrs.tasks ?? []);
const fnBreakdown = { byDesignMechanicalD2: [], byDesignPreWindowRule3: [], other: [] };
for (const kk of sc.fn) {
  const ep = episodes.find((e) => e.task === kk);
  if (backlogTasks.has(kk)) fnBreakdown.byDesignPreWindowRule3.push(kk);
  else if (ep && ep.executor === 'mechanical' && Date.parse(ep.enteredTs) >= winStart) fnBreakdown.byDesignMechanicalD2.push(kk);
  else fnBreakdown.other.push(kk);
}
const contrast = {
  before: { alerts: alertsBefore.length, levels: count(gradedBefore, (e) => e.level), precision: scBefore.precision, fp: scBefore.fp.length, fn: scBefore.fn.length },
  after: { alerts: alerts.length, levels: count(graded, (e) => e.level), precision: sc.precision, fp: sc.fp.length, fn: sc.fn.length, fnBreakdown },
};
const result = {
  window: ctx.window,
  releaseRule: RELEASE_RULE,
  thresholds: DEFAULTS,
  projects: ctx.projects,
  coverage: ctx.coverage,
  raw: { total: raw.length, byKind: count(raw, (e) => e.kind), byProject: count(raw, (e) => e.project) },
  stage1: s1.stats,
  stage2: { ...s2.stats, openChainsAtEnd: s2.openChains.length },
  stage3: s3.stats,
  levels: count(graded, (e) => e.level),
  rules: count(graded, (e) => `${e.level}:${e.rule}`),
  notificationsByProject: count(notifications, (n) => `${n.project}:${n.level}`),
  naive: { notifications: naive.length, byKind: count(naive, (e) => e.kind) },
  compression: { rawToAlerts: alerts.length ? +(raw.length / alerts.length).toFixed(1) : null, naiveToAlerts: alerts.length ? +(naive.length / alerts.length).toFixed(1) : null },
  labels: count([...labels.values()], (l) => l.label),
  score: { prototype: sc, naive: scNaive },
  costSignals: alerts.filter((a) => a.rule === 'cost-signal').map((a) => `${a.project}|${a.entity.slice(5)}`),
  g1,
  contrast,
  calibration: { rows: calibration, rulerFailures },
  sessions: { alertTasksWithMentions: [...mentions.keys()].length, workerSessionGaps: sessionGaps.length },
};
fs.writeFileSync(path.join(OUT, 'notifications.jsonl'), notifications.map((n) => JSON.stringify(n)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'graded.jsonl'), graded.map((n) => JSON.stringify(n)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'labels.json'), JSON.stringify(Object.fromEntries(labels), null, 1));
fs.writeFileSync(path.join(OUT, 'session-gaps.json'), JSON.stringify(sessionGaps, null, 1));
fs.writeFileSync(path.join(OUT, 'RESULT.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, coverage: undefined, score: { prototype: { ...sc, tp: sc.tp.length, fp: sc.fp, fn: sc.fn, late: sc.late, unlabeled: sc.unlabeled.length }, naive: { ...scNaive, tp: scNaive.tp.length, fp: scNaive.fp.length, fn: scNaive.fn, late: scNaive.late.length, unlabeled: scNaive.unlabeled.length } } }, null, 1));

// Ruler + contrast on stderr, so the stdout stays a clean JSON document. A lost 打扰 row is a red.
console.error('D3 校准标尺（打扰 7 / Record 7）:');
for (const c of calibration)
  console.error(`  ${String(c.n).padStart(2)} ${c.bucket.padEnd(6)} ${c.project.padEnd(12)} ${c.task.slice(0, 48).padEnd(48)} expect=${String(c.expectRule).padEnd(28)} -> ${c.landing}${c.pass ? '' : '   ✗ LOST'}`);
console.error(`cost-signal notifications (${result.costSignals.length}): ${result.costSignals.join(', ')}`);
console.error(`G1 executor=${JSON.stringify(g1.executor)} actor=${JSON.stringify(g1.actor)} unknown=${g1.unknown} identified=${g1.identified}/${g1.episodes}`);
console.error(`before -> after: alerts ${contrast.before.alerts}->${contrast.after.alerts} | precision ${contrast.before.precision?.toFixed(3)}->${contrast.after.precision?.toFixed(3)} | fp ${contrast.before.fp}->${contrast.after.fp} | fn ${contrast.before.fn}->${contrast.after.fn}`);
if (rulerFailures.length) {
  console.error(`RULER FAIL: ${rulerFailures.length} 打扰 row(s) lost: ${rulerFailures.map((c) => `#${c.n}(${c.task})`).join(', ')}`);
  process.exitCode = 1;
}
