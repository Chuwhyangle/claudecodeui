#!/usr/bin/env node
// Replays out/events.jsonl (from collect.mjs) through the PREREG pipeline, attaches related
// sessions, scores against outcome-derived labels, and writes notifications + metrics.
//
//   node replay.mjs [--out out/] [--projects-dir ~/.claude/projects] [--no-sessions]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, stage1, stage2, stage3, stage4, naiveNotifications, groundTruth, score } from './lib.mjs';

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
const graded = stage4(s3.events, NOW, context);

const alerts = graded.filter((e) => e.level === 'Notify' || e.level === 'Escalate');
const naive = naiveNotifications(raw);
const labels = groundTruth(raw, NOW);

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
  if (e.kind === 'needs-human-enter') openEp.set(k, { task: k, enteredTs: e.ts, via: e.source, cause: e.attrs.cause ?? null });
  if (e.kind === 'needs-human-exit' && openEp.has(k)) {
    const ep = openEp.get(k);
    openEp.delete(k);
    episodes.push({ ...ep, exitedTs: e.ts, exitTo: e.attrs.to, exitSubject: e.attrs.subject ?? null, hours: +((Date.parse(e.ts) - Date.parse(ep.enteredTs)) / 3600e3).toFixed(2) });
  }
}
for (const ep of openEp.values()) episodes.push({ ...ep, exitedTs: null, hours: +((NOW - Date.parse(ep.enteredTs)) / 3600e3).toFixed(2), openAtEnd: true });
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
  sessions: { alertTasksWithMentions: [...mentions.keys()].length, workerSessionGaps: sessionGaps.length },
};
fs.writeFileSync(path.join(OUT, 'notifications.jsonl'), notifications.map((n) => JSON.stringify(n)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'graded.jsonl'), graded.map((n) => JSON.stringify(n)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'labels.json'), JSON.stringify(Object.fromEntries(labels), null, 1));
fs.writeFileSync(path.join(OUT, 'session-gaps.json'), JSON.stringify(sessionGaps, null, 1));
fs.writeFileSync(path.join(OUT, 'RESULT.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, coverage: undefined, score: { prototype: { ...sc, tp: sc.tp.length, fp: sc.fp, fn: sc.fn, late: sc.late, unlabeled: sc.unlabeled.length }, naive: { ...scNaive, tp: scNaive.tp.length, fp: scNaive.fp.length, fn: scNaive.fn, late: scNaive.late.length, unlabeled: scNaive.unlabeled.length } } }, null, 1));
