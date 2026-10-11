#!/usr/bin/env node
// Reads the REAL Quay carriers + task git history of every CloudCLI Quay project and writes
// normalized events for the replay window. Read-only: never writes into a project's .quay/ or tasks/.
//
//   node collect.mjs [--work ~/work] [--hours 48] [--now ISO] [--out out/]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const WORK = args.work ?? path.join(os.homedir(), 'work');
const HOURS = Number(args.hours ?? 48);
const NOW = args.now ? Date.parse(args.now) : Date.now();
const SINCE = NOW - HOURS * 3600_000;
const OUT = args.out ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
const EXCLUDE = /^(\..*|quay\.bak|quay-ci-repro|quay-dogfood-.*|voice-capture-false-forms-.*)$/;
const inWindow = (ts) => {
  const ms = Date.parse(ts);
  return ms >= SINCE && ms <= NOW;
};

/** Tail-read a JSONL carrier just far enough back to cover the window; evidence = byte offset. */
function readJsonlWindow(file, tsOf) {
  if (!fs.existsSync(file)) return { rows: [], status: 'missing' };
  const size = fs.statSync(file).size;
  let tail = Math.min(size, 4 << 20);
  for (;;) {
    const start = size - tail;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(tail);
    fs.readSync(fd, buf, 0, tail, start);
    fs.closeSync(fd);
    let offset = start;
    const rows = [];
    let firstTs = null;
    let skipPartial = start > 0;
    for (const line of buf.toString('utf8').split('\n')) {
      const lineOffset = offset;
      offset += Buffer.byteLength(line) + 1;
      if (skipPartial) {
        skipPartial = false;
        continue;
      }
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = tsOf(rec);
      if (!ts) continue;
      firstTs ??= ts;
      if (inWindow(ts)) rows.push({ rec, ts, byte: lineOffset });
    }
    if (tail >= size || (firstTs && Date.parse(firstTs) < SINCE)) return { rows, status: 'ok', bytesRead: tail };
    tail = Math.min(size, tail * 2);
  }
}

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });

/** Every `status:` change under tasks/ on develop inside the window, oldest first. */
function statusHistory(repo) {
  let text;
  try {
    text = git(repo, 'log', 'develop', `--since=${new Date(SINCE).toISOString()}`, '--reverse', '--no-merges',
      '--format=@@C %H %cI %s', '-p', '--unified=0', '--', 'tasks/');
  } catch {
    return [];
  }
  const out = [];
  let commit = null;
  let file = null;
  let from = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@C ')) {
      const [, sha, ts, ...subj] = line.split(' ');
      commit = { sha, ts, subject: subj.join(' ') };
    } else if (line.startsWith('+++ ')) {
      const m = line.match(/tasks\/([^/]+)\.md$/);
      file = m ? m[1] : null;
      from = null;
    } else if (file && /^-status:\s/.test(line)) from = line.replace(/^-status:\s*/, '').split(/\s/)[0];
    else if (file && /^\+status:\s/.test(line) && commit && inWindow(commit.ts)) {
      const to = line.replace(/^\+status:\s*/, '').split(/\s/)[0];
      if (to !== from) out.push({ taskId: file, from, to, ...commit });
    }
  }
  return out;
}

function parkCause(subject) {
  if (/归因不出/.test(subject)) return 'mechanical: unattributable stop';
  if (/重试上限/.test(subject)) return 'mechanical: retry cap';
  if (/task_write/.test(subject)) return 'authored: task_write (worker or session parked it)';
  return subject.slice(0, 80);
}

const RELEASE_RE = /（待外部）|npm publish|\bpublish(ed|ing)?\b|发布|GitHub Release|release pipeline/i;

const projects = fs
  .readdirSync(WORK)
  .filter((d) => !EXCLUDE.test(d) && fs.existsSync(path.join(WORK, d, '.quay', 'config.yml')));

const events = [];
const coverage = {};
const taskText = {}; // project -> {id -> text}
for (const project of projects) {
  const root = path.join(WORK, project);
  const q = path.join(root, '.quay');
  const cov = (coverage[project] = {});
  const push = (e) => events.push({ project, ...e });

  for (const [source, kind] of [['worker-round', 'driver:worker'], ['promotion-round', 'driver:promotion']]) {
    const file = path.join(q, `${source}.jsonl`);
    const { rows, status } = readJsonlWindow(file, (r) => r.ts);
    cov[source] = { status, rows: rows.length };
    for (const { rec, ts, byte } of rows) {
      push({
        ts, source, entity: kind, kind: 'heartbeat',
        attrs: {
          // A park the driver failed to commit (committed:false) never happened in the store.
          needsHuman: (Array.isArray(rec.needs_human) ? rec.needs_human.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean) : [])
            .filter((id) => !(rec.needs_human_committed ?? []).some((c) => c?.id === id && c.committed === false)),
          uncommittedParks: (rec.needs_human_committed ?? []).filter((c) => c?.committed === false).map((c) => c.id),
          halted: rec.halted === true,
          hasError: rec.error != null,
          stopClass: rec.action === 'stop' ? String(rec.stop_reason ?? '').split(/[\s:(]/)[0] || 'stop' : rec.action ?? null,
        },
        evidence: { file, byte },
      });
    }
  }

  {
    const file = path.join(q, 'worker-outcome.jsonl');
    const { rows, status } = readJsonlWindow(file, (r) => r.ts);
    cov['worker-outcome'] = { status, rows: rows.length };
    for (const { rec, ts, byte } of rows) {
      push({
        ts, source: 'worker-outcome', entity: `task:${rec.task}`, kind: 'outcome',
        attrs: {
          finalState: rec.final_state,
          fanIn: rec.mechanical_fan_in?.outcome ?? null,
          failureReason: rec.failure_reason ? String(rec.failure_reason).slice(0, 160) : null,
          sessionId: rec.session_id ?? null,
          startedAt: rec.started_at ?? null,
        },
        evidence: { file, byte },
      });
    }
  }

  {
    const file = path.join(q, 'verification-round.jsonl');
    const { rows, status } = readJsonlWindow(file, (r) => r.startedAt);
    cov['verification-round'] = { status, rows: rows.length };
    for (const { rec, ts, byte } of rows) {
      if (!rec.taskId) continue;
      const end = rec.durationMs ? new Date(Date.parse(ts) + rec.durationMs).toISOString() : ts;
      push({
        ts: end, source: 'verification-round', entity: `task:${rec.taskId}`, kind: 'suite',
        attrs: { state: rec.state, taskId: rec.taskId, fail: rec.fail ?? null, reason: rec.reason ?? null, round: rec.round },
        evidence: { file, byte },
      });
    }
  }

  {
    const file = path.join(q, 'fan-in-ff-escalations.jsonl');
    const { rows, status } = readJsonlWindow(file, (r) => r.ts);
    cov['fan-in-ff-escalations'] = { status, rows: rows.length, events: [...new Set(rows.map((r) => r.rec.event))] };
    for (const { rec, ts, byte } of rows)
      push({ ts, source: 'fan-in-ff-escalations', entity: `task:${rec.taskId}`, kind: 'ff-escalation', attrs: { event: rec.event }, evidence: { file, byte } });
  }

  {
    const file = path.join(q, 'task-status-events.jsonl');
    const { rows, status } = readJsonlWindow(file, (r) => r.ts);
    cov['task-status-events'] = { status, rows: rows.length };
    for (const { rec, ts, byte } of rows)
      push({ ts, source: 'task-status-events', entity: `task:${rec.taskId}`, kind: rec.kind === 'promote' ? 'promote' : 'status', attrs: { from: rec.from, to: rec.to }, evidence: { file, byte } });
  }

  const hist = statusHistory(root);
  cov['git-status-history'] = { status: 'ok', rows: hist.length };
  for (const h of hist)
    push({
      ts: new Date(h.ts).toISOString(), source: 'git:tasks', entity: `task:${h.taskId}`, kind: 'status',
      attrs: { from: h.from, to: h.to, subject: h.subject.slice(0, 120), cause: h.to === 'needs-human' ? parkCause(h.subject) : undefined },
      evidence: { repo: root, sha: h.sha },
    });

  // Seed: tasks already parked in needs-human when the window opens, with their real park time.
  try {
    const rev = git(root, 'rev-list', '-1', `--before=${new Date(SINCE).toISOString()}`, 'develop').trim();
    const parked = rev ? git(root, 'grep', '-l', '^status: needs-human', rev, '--', 'tasks/').split('\n').filter(Boolean) : [];
    cov['pre-window-needs-human'] = { status: 'ok', rows: parked.length, rev };
    for (const line of parked) {
      const file = line.slice(rev.length + 1);
      const taskId = path.basename(file, '.md');
      // Keep the REAL park commit subject: it is what classifies the executor (mechanical vs task_write),
      // including for tasks that were already parked before the window opened.
      const meta = git(root, 'log', '-1', '--format=%H%x1f%cI%x1f%s', '-G^status: needs-human', rev, '--', file).trim().split('\x1f');
      const [sha, ts, ...sj] = meta;
      const subject = sj.join('\x1f');
      push({
        ts: new Date(ts ?? SINCE).toISOString(), source: 'git:tasks', entity: `task:${taskId}`, kind: 'status',
        attrs: { from: null, to: 'needs-human', subject: subject.slice(0, 120), cause: parkCause(subject), seeded: true },
        evidence: { repo: root, sha: sha ?? rev },
      });
    }
  } catch (err) {
    cov['pre-window-needs-human'] = { status: `error: ${String(err.message).slice(0, 80)}`, rows: 0 };
  }

  // Task text pinned to develop as of `now`, so a rerun reads the same text the window ended on.
  taskText[project] = {};
  try {
    const rev = git(root, 'rev-list', '-1', `--before=${new Date(NOW).toISOString()}`, 'develop').trim();
    cov['task-text'] = { status: 'ok', rev };
    const names = git(root, 'ls-tree', '--name-only', rev, 'tasks/').split('\n').filter((n) => n.endsWith('.md'));
    const blob = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input: names.map((n) => `${rev}:${n}`).join('\n') + '\n', maxBuffer: 512 << 20 });
    let off = 0;
    for (const n of names) {
      const nl = blob.indexOf(10, off);
      const size = Number(blob.subarray(off, nl).toString().split(' ')[2]);
      taskText[project][path.basename(n, '.md')] = blob.subarray(nl + 1, nl + 1 + size).toString('utf8');
      off = nl + 1 + size + 1;
    }
  } catch (err) {
    cov['task-text'] = { status: `error: ${String(err.message).slice(0, 80)}` };
  }
}

// Release-dependency and cross-project features come from current task text (a known gap:
// the text at event time may differ; see RESULT.md).
const PUBLISH_RE = /npm publish|\bpublish(ed|ing)?\b|发布|GitHub Release|release pipeline/i;
const BLOCKING_RE = /解除条件|（待外部）|阻塞|等待|blocked|waiting on|gated on/i;
const releaseTasks = [];
const releaseTasksKeyword = [];
const idOwners = new Map();
for (const [p, tasks] of Object.entries(taskText)) for (const id of Object.keys(tasks)) idOwners.set(id, [...(idOwners.get(id) ?? []), p]);
const downstream = {};
for (const [p, tasks] of Object.entries(taskText)) {
  for (const [id, text] of Object.entries(tasks)) {
    if (/^status:\s*(ready|needs-human|todo)/m.test(text)) {
      if (RELEASE_RE.test(text)) releaseTasksKeyword.push(`${p}|${id}`);
      // Post-hoc v2 (see RESULT.md): the release word must sit on a line that states a blocking condition.
      // `（待外部）` alone means "waits on someone outside the worker" (often a human ruling), not a release.
      if (text.split('\n').some((l) => PUBLISH_RE.test(l) && BLOCKING_RE.test(l))) releaseTasks.push(`${p}|${id}`);
    }
    for (const m of new Set(text.match(/\bgap-[a-z0-9][a-z0-9-]{8,}/g) ?? [])) {
      const owners = idOwners.get(m) ?? [];
      if (owners.length !== 1 || owners[0] === p) continue; // unknown, ambiguous or same-project
      (downstream[`${owners[0]}|${m}`] ??= []).push({ project: p, taskId: id });
    }
  }
}
const currentStatus = {};
for (const [p, tasks] of Object.entries(taskText))
  for (const [id, text] of Object.entries(tasks)) currentStatus[`${p}|${id}`] = text.match(/^status:\s*(\S+)/m)?.[1] ?? null;

fs.mkdirSync(OUT, { recursive: true });
events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
fs.writeFileSync(path.join(OUT, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
fs.writeFileSync(
  path.join(OUT, 'context.json'),
  JSON.stringify({ window: { since: new Date(SINCE).toISOString(), now: new Date(NOW).toISOString(), hours: HOURS }, projects, coverage, releaseTasks, releaseTasksKeyword, downstream, currentStatus }, null, 1),
);
console.log(JSON.stringify({ projects, events: events.length, coverage }, null, 1));
