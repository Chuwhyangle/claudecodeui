// Pure replay pipeline for the Live Monitor 48h experiment (rules fixed in PREREG.md).
// Every function takes normalized events and returns new arrays; nothing here reads disk.
//
// Normalized event: { ts, project, source, entity, kind, attrs, evidence }
//   ts       ISO string
//   entity   'task:<id>' | 'driver:<kind>'
//   kind     'heartbeat' | 'status' | 'outcome' | 'suite' | 'ff-escalation' | 'promote'

export const DEFAULTS = {
  debounceRounds: 2,
  debounceMs: 120_000,
  dupWindowMs: 60_000,
  recoverMs: 6 * 3600_000,
  expireMs: 24 * 3600_000,
  streakFailures: 3,
  haltEscalateMs: 30 * 60_000,
};

const FAILURE_STATES = new Set(['exited-not-landed', 'failed', 'killed', 'spawn-failed']);

const t = (e) => Date.parse(e.ts);
const byTs = (a, b) => t(a) - t(b) || String(a.evidence?.line ?? '').localeCompare(String(b.evidence?.line ?? ''));
const iso = (ms) => new Date(ms).toISOString();

export function isLanded(e) {
  return (
    (e.kind === 'outcome' && (e.attrs.fanIn === 'landed' || (e.attrs.finalState === 'completed' && !e.attrs.fanIn))) ||
    (e.kind === 'status' && e.attrs.to === 'done')
  );
}

export function isAttemptFailure(e) {
  return e.kind === 'outcome' && FAILURE_STATES.has(e.attrs.finalState) && e.attrs.fanIn !== 'landed';
}

/** The part of a heartbeat that can carry meaning; counters and timestamps are dropped. */
export function heartbeatProjection(e) {
  const a = e.attrs;
  return JSON.stringify([!!a.halted, !!a.hasError, a.stopClass ?? null]);
}

/**
 * Stage 1 — mechanical dedup + debounce.
 * Heartbeats collapse to projection changes that persist >= debounceRounds rounds AND >= debounceMs;
 * shorter excursions are counted as flaps. Other events drop exact repeats inside dupWindowMs.
 */
export function stage1(events, opts = DEFAULTS) {
  const out = [];
  const stats = { heartbeatIn: 0, heartbeatSame: 0, flaps: 0, heartbeatChanges: 0, duplicates: 0 };
  const streams = new Map();
  const rest = [];
  for (const e of [...events].sort(byTs)) {
    if (e.kind === 'heartbeat') {
      // `needs_human` on a round is "parked this round", not a standing set: split it out as
      // per-task signals and let the semantic stage drop the echoes of later rounds.
      for (const id of e.attrs.needsHuman ?? []) rest.push({ ...e, entity: `task:${id}`, kind: 'nh-signal', attrs: { via: e.source } });
      const k = `${e.project}|${e.source}`;
      if (!streams.has(k)) streams.set(k, []);
      streams.get(k).push(e);
    } else rest.push(e);
  }

  for (const stream of streams.values()) {
    stats.heartbeatIn += stream.length;
    // Run-length encode the projection, then accept a run only if it is long enough.
    const runs = [];
    for (const e of stream) {
      const p = heartbeatProjection(e);
      const last = runs[runs.length - 1];
      if (last && last.p === p) {
        last.n += 1;
        last.end = e;
        stats.heartbeatSame += 1;
      } else runs.push({ p, n: 1, start: e, end: e });
    }
    let accepted = null;
    runs.forEach((run, i) => {
      const nextStart = runs[i + 1]?.start;
      const durMs = (nextStart ? t(nextStart) : t(run.end)) - t(run.start);
      const settled = run.n >= opts.debounceRounds && durMs >= opts.debounceMs;
      const isLastRun = i === runs.length - 1;
      if (accepted === null) {
        accepted = run; // baseline state at the window start, not a change
        out.push({ ...run.start, kind: 'heartbeat-baseline', attrs: { ...run.start.attrs } });
        return;
      }
      if (run.p === accepted.p) return;
      if (!settled && !isLastRun) {
        stats.flaps += 1;
        return;
      }
      const prev = JSON.parse(accepted.p);
      const cur = JSON.parse(run.p);
      stats.heartbeatChanges += 1;
      out.push({
        ...run.start,
        kind: 'heartbeat-change',
        attrs: {
          halted: cur[0],
          hasError: cur[1],
          stopClass: cur[2],
          prevStopClass: prev[2],
          rounds: run.n,
          settled,
        },
      });
      accepted = run;
    });
  }

  const lastSeen = new Map();
  for (const e of rest) {
    const key = `${e.project}|${e.source}|${e.entity}|${e.kind}|${JSON.stringify(e.attrs)}`;
    const prev = lastSeen.get(key);
    lastSeen.set(key, t(e));
    if (prev !== undefined && t(e) - prev <= opts.dupWindowMs) {
      stats.duplicates += 1;
      continue;
    }
    out.push(e);
  }
  return { events: out.sort(byTs), stats };
}

/**
 * Stage 2 — failure/recovery merge. Per task, attempt failures open a chain; a landing inside
 * recoverMs closes it as one `recovered` event. Suite reds form a separate chain closed by green.
 * Emits synthetic `failure-stale` (chain open past recoverMs) and `failure-streak` (>= N failures).
 */
export function stage2(events, nowMs, opts = DEFAULTS) {
  const out = [];
  const stats = { failures: 0, recovered: 0, mergedFailures: 0, stale: 0, streaks: 0, suiteRed: 0, redToGreen: 0 };
  const chains = new Map(); // project|task -> {first, n, evidence[]}
  const suites = new Map();
  const closeChain = (key, e, landedLate) => {
    const c = chains.get(key);
    chains.delete(key);
    if (landedLate) return;
    stats.recovered += 1;
    stats.mergedFailures += c.n;
    out.push({ ...e, kind: 'recovered', attrs: { failures: c.n, sinceTs: c.first.ts, failureEvidence: c.evidence } });
  };
  const flushStale = (untilMs) => {
    for (const [key, c] of chains) {
      const due = t(c.first) + opts.recoverMs;
      if (!c.staleEmitted && due <= untilMs) {
        c.staleEmitted = true;
        stats.stale += 1;
        out.push({ ...c.first, ts: iso(due), kind: 'failure-stale', attrs: { failures: c.n, sinceTs: c.first.ts, failureEvidence: c.evidence } });
      }
    }
  };

  for (const e of [...events].sort(byTs)) {
    flushStale(t(e));
    const key = `${e.project}|${e.entity}`;
    if (isAttemptFailure(e)) {
      stats.failures += 1;
      const c = chains.get(key) ?? { first: e, n: 0, evidence: [] };
      c.n += 1;
      c.evidence.push(e.evidence);
      chains.set(key, c);
      if (c.n === opts.streakFailures) {
        stats.streaks += 1;
        out.push({ ...e, kind: 'failure-streak', attrs: { failures: c.n, sinceTs: c.first.ts, failureEvidence: [...c.evidence] } });
      }
      out.push({ ...e, kind: 'attempt-failure' });
      continue;
    }
    if (isLanded(e) && chains.has(key)) {
      const c = chains.get(key);
      const late = t(e) - t(c.first) > opts.recoverMs;
      closeChain(key, e, late);
      if (late) out.push({ ...e, kind: 'recovered-late', attrs: { ...e.attrs, failures: c.n, sinceTs: c.first.ts } });
    }
    if (e.kind === 'suite') {
      const taskKey = `${e.project}|task:${e.attrs.taskId}`;
      if (e.attrs.state === 'red') {
        stats.suiteRed += 1;
        if (!suites.has(taskKey)) suites.set(taskKey, { first: e, n: 0 });
        suites.get(taskKey).n += 1;
        out.push({ ...e, kind: 'suite-red' });
        continue;
      }
      if (e.attrs.state === 'green' && suites.has(taskKey)) {
        const s = suites.get(taskKey);
        suites.delete(taskKey);
        stats.redToGreen += 1;
        out.push({ ...e, kind: 'red-to-green', attrs: { ...e.attrs, reds: s.n, sinceTs: s.first.ts } });
        continue;
      }
    }
    out.push(e);
  }
  flushStale(nowMs);
  return { events: out.sort(byTs), stats, openChains: [...chains.entries()].map(([k, c]) => ({ key: k, failures: c.n, sinceTs: c.first.ts })) };
}

/**
 * Stage 3 — semantic delta. Keeps a per-entity semantic state and lets an event through only if
 * it changes that state. needs-human may arrive from either the git status history or a driver
 * heartbeat; whichever lands first sets it, the echo from the other source is suppressed.
 */
export function stage3(events) {
  const state = new Map();
  const out = [];
  const stats = { in: events.length, passed: 0, suppressed: 0, suppressedByKind: {} };
  const get = (k) => state.get(k) ?? (state.set(k, {}), state.get(k));
  const pass = (e, change) => {
    stats.passed += 1;
    out.push({ ...e, change });
  };
  const drop = (e) => {
    stats.suppressed += 1;
    stats.suppressedByKind[e.kind] = (stats.suppressedByKind[e.kind] ?? 0) + 1;
  };

  for (const e of events) {
    switch (e.kind) {
      case 'heartbeat-baseline': {
        const d = get(`${e.project}|${e.entity}`);
        d.halted = !!e.attrs.halted;
        d.hasError = !!e.attrs.hasError;
        drop(e);
        break;
      }
      case 'nh-signal': {
        const s = get(`${e.project}|${e.entity}`);
        if (s.needsHuman || s.status === 'done' || s.status === 'superseded') drop(e);
        else {
          s.needsHuman = true;
          pass({ ...e, kind: 'needs-human-enter', attrs: { via: e.attrs.via, cause: 'driver-heartbeat' } }, 'needsHuman:+');
        }
        break;
      }
      case 'heartbeat-change': {
        // Only health is semantic; stop_reason class flips (pool-empty <-> filtered-empty) are not.
        const d = get(`${e.project}|${e.entity}`);
        if (d.halted !== e.attrs.halted || d.hasError !== e.attrs.hasError) {
          d.halted = e.attrs.halted;
          d.hasError = e.attrs.hasError;
          pass({ ...e, kind: 'driver-health' }, `halted=${e.attrs.halted},error=${e.attrs.hasError}`);
        } else drop(e);
        break;
      }
      case 'status': {
        const s = get(`${e.project}|${e.entity}`);
        if (s.status === e.attrs.to) {
          drop(e);
          break;
        }
        s.status = e.attrs.to;
        if (e.attrs.to === 'needs-human') {
          if (s.needsHuman) drop(e); // already reflected by the heartbeat source
          else {
            s.needsHuman = true;
            pass({ ...e, kind: 'needs-human-enter', attrs: { ...e.attrs, cause: e.attrs.cause } }, 'needsHuman:+');
          }
          break;
        }
        // Any move off needs-human closes the episode — including a heartbeat-only park that the
        // task store never recorded and that later landed as done.
        if (s.needsHuman) {
          s.needsHuman = false;
          pass({ ...e, kind: 'needs-human-exit', attrs: { ...e.attrs, implicit: e.attrs.from !== 'needs-human' } }, 'needsHuman:-');
          if (e.attrs.from === 'needs-human') break;
        }
        if (e.attrs.from === 'needs-human') drop(e);
        else pass(e, `status:${e.attrs.to}`);
        break;
      }
      case 'promote': {
        // Same transition is also in the git history; only pass if git hasn't set it yet.
        const s = get(`${e.project}|${e.entity}`);
        if (s.status === e.attrs.to) drop(e);
        else {
          s.status = e.attrs.to;
          pass(e, `status:${e.attrs.to}`);
        }
        break;
      }
      case 'attempt-failure':
      case 'suite-red': {
        const s = get(`${e.project}|${e.entity}`);
        const field = e.kind === 'suite-red' ? 'suite' : 'chain';
        const want = e.kind === 'suite-red' ? 'red' : 'open';
        if (s[field] === want) drop(e);
        else {
          s[field] = want;
          pass(e, `${field}:${want}`);
        }
        break;
      }
      case 'recovered':
      case 'recovered-late':
        get(`${e.project}|${e.entity}`).chain = 'closed';
        pass(e, 'chain:closed');
        break;
      case 'red-to-green':
        get(`${e.project}|task:${e.attrs.taskId}`).suite = 'green';
        pass(e, 'suite:green');
        break;
      case 'outcome':
        if (isLanded(e)) pass(e, 'landed');
        else drop(e);
        break;
      case 'suite':
      case 'ff-escalation':
        drop(e);
        break;
      default:
        pass(e, e.kind); // synthetic timers (failure-stale/-streak) are already state changes
    }
  }
  return { events: out, stats };
}

/**
 * Stage 4 — grading. Adds timer-driven escalations (needs-human expiry, halted drivers), then
 * assigns Ignore/Record/Notify/Escalate. `context` carries per-task text features:
 *   context.releaseTasks: Set('<project>|<taskId>')
 *   context.downstream:   Map('<project>|<taskId>' -> [{project, taskId}])  (who references me)
 *   context.statusAt(project, taskId, ms) -> status string | null
 */
export function stage4(events, nowMs, context, opts = DEFAULTS) {
  const graded = [];
  const nhOpen = new Map();
  const haltOpen = new Map();
  const timers = [];

  for (const e of events) {
    const k = `${e.project}|${e.entity}`;
    if (e.kind === 'needs-human-enter') nhOpen.set(k, e);
    if (e.kind === 'needs-human-exit') {
      const open = nhOpen.get(k);
      if (open && t(e) - t(open) >= opts.expireMs) {
        timers.push({ ...open, ts: iso(t(open) + opts.expireMs), kind: 'needs-human-expired', attrs: { enteredTs: open.ts, exitedTs: e.ts } });
      }
      nhOpen.delete(k);
    }
    if (e.kind === 'driver-health') {
      if (e.attrs.halted || e.attrs.hasError) haltOpen.set(k, e);
      else {
        const open = haltOpen.get(k);
        if (open && t(e) - t(open) >= opts.haltEscalateMs) timers.push({ ...open, ts: iso(t(open) + opts.haltEscalateMs), kind: 'driver-stuck', attrs: { since: open.ts, until: e.ts } });
        haltOpen.delete(k);
      }
    }
  }
  for (const open of nhOpen.values()) {
    // A park that had already expired before the replay window opens fires at the window start.
    const due = Math.max(t(open) + opts.expireMs, context.windowStartMs ?? -Infinity);
    if (t(open) + opts.expireMs <= nowMs) timers.push({ ...open, ts: iso(due), kind: 'needs-human-expired', attrs: { enteredTs: open.ts, exitedTs: null, expiredBeforeWindow: due > t(open) + opts.expireMs } });
  }
  for (const open of haltOpen.values()) {
    if (t(open) + opts.haltEscalateMs <= nowMs) timers.push({ ...open, ts: iso(t(open) + opts.haltEscalateMs), kind: 'driver-stuck', attrs: { since: open.ts, until: null } });
  }

  const wokenPairs = new Set();
  for (const e of [...events, ...timers].sort(byTs)) {
    const taskId = e.entity.startsWith('task:') ? e.entity.slice(5) : null;
    const tk = `${e.project}|${taskId}`;
    const release = taskId && context.releaseTasks?.has(tk);
    let level = 'Ignore';
    let rule = 'no-rule';
    switch (e.kind) {
      case 'needs-human-enter':
        if (e.attrs.seeded) {
          level = 'Record'; // parked before the window; it was someone's Notify then, the expiry speaks now
          rule = 'pre-window-park';
        } else {
          level = 'Notify';
          rule = release ? 'release-dependency-parked' : 'human-decision';
        }
        break;
      case 'needs-human-expired':
        level = 'Escalate';
        rule = 'needs-human-expired';
        break;
      case 'failure-streak':
        level = 'Escalate';
        rule = 'failure-streak';
        break;
      case 'driver-stuck':
        level = 'Escalate';
        rule = 'driver-stuck';
        break;
      case 'failure-stale':
        level = 'Notify';
        rule = release ? 'release-dependency-stalled' : 'failure-unrecovered';
        break;
      case 'recovered':
      case 'recovered-late':
      case 'red-to-green':
      case 'landed':
      case 'needs-human-exit':
      case 'driver-health':
        level = 'Record';
        rule = e.kind;
        break;
      case 'status':
        if (e.attrs.to === 'done') {
          level = 'Record';
          rule = 'done';
        } else {
          level = 'Ignore';
          rule = `status:${e.attrs.from}->${e.attrs.to}`;
        }
        break;
      case 'outcome':
        level = 'Record';
        rule = 'landed';
        break;
      case 'promote':
        rule = 'mechanical-promote';
        break;
      case 'attempt-failure':
      case 'suite-red':
        rule = `${e.kind}-pending-recovery`; // decided later by stage 2 timers
        break;
    }
    graded.push({ ...e, level, rule });

    // Cross-project: a landing upstream wakes downstream tasks that are still open.
    if (taskId && (e.kind === 'landed' || (e.kind === 'status' && e.attrs.to === 'done') || (e.kind === 'outcome' && isLanded(e)))) {
      for (const d of context.downstream?.get(tk) ?? []) {
        const pair = `${tk}->${d.project}|${d.taskId}`;
        const st = context.statusAt?.(d.project, d.taskId, t(e));
        if (!wokenPairs.has(pair) && st && st !== 'done' && st !== 'superseded') {
          wokenPairs.add(pair);
          graded.push({
            ...e,
            project: d.project,
            entity: `task:${d.taskId}`,
            kind: 'upstream-landed',
            attrs: { upstream: `${e.project}/${taskId}`, downstreamStatus: st },
            level: 'Notify',
            rule: 'cross-project-upstream-landed',
          });
        }
      }
    }
  }
  return graded;
}

/** The comparison baseline: one notification per raw failure / red / needs-human event. */
export function naiveNotifications(rawEvents) {
  const out = [];
  for (const e of rawEvents) {
    if (isAttemptFailure(e)) out.push(e);
    else if (e.kind === 'suite' && e.attrs.state === 'red') out.push({ ...e, entity: `task:${e.attrs.taskId}` });
    else if (e.kind === 'status' && e.attrs.to === 'needs-human') out.push(e);
    else if (e.kind === 'heartbeat') {
      for (const id of e.attrs.needsHuman ?? []) out.push({ ...e, entity: `task:${id}`, kind: 'needs-human-heartbeat' });
      if (e.attrs.halted || e.attrs.hasError) out.push(e);
    }
  }
  return out;
}

/**
 * Outcome-derived labels (PREREG §评分). Returns Map('<project>|<taskId>' -> {label, reason, onsetTs, exitTs}).
 */
export function groundTruth(rawEvents, nowMs, opts = DEFAULTS) {
  const per = new Map();
  const g = (k) => per.get(k) ?? (per.set(k, { failures: 0, landed: false, nh: false, lastAttempt: null, firstFailure: null, nhEnter: null, nhExit: null }), per.get(k));
  for (const e of [...rawEvents].sort(byTs)) {
    if (!e.entity?.startsWith('task:')) {
      if (e.kind === 'heartbeat') for (const id of e.attrs.needsHuman ?? []) {
        const s = g(`${e.project}|${id}`);
        s.nh = true;
        s.nhEnter ??= e.ts;
      }
      continue;
    }
    const s = g(`${e.project}|${e.entity.slice(5)}`);
    if (isAttemptFailure(e)) {
      s.failures += 1;
      s.firstFailure ??= e.ts;
      s.lastAttempt = e.ts;
    }
    if (e.kind === 'outcome') s.lastAttempt = e.ts;
    if (isLanded(e)) s.landed = true;
    if (e.kind === 'status' && e.attrs.to === 'needs-human') {
      s.nh = true;
      s.nhEnter ??= e.ts;
    }
    if (e.kind === 'status' && e.attrs.from === 'needs-human') s.nhExit = e.ts;
  }
  const labels = new Map();
  for (const [k, s] of per) {
    if (s.nh) labels.set(k, { label: 'GT+', reason: 'entered needs-human', onsetTs: s.nhEnter, exitTs: s.nhExit });
    else if (s.failures > 0 && !s.landed && nowMs - Date.parse(s.lastAttempt) >= opts.recoverMs)
      labels.set(k, { label: 'GT+', reason: `stuck: ${s.failures} failures, no landing, no attempt in ${opts.recoverMs / 3600e3}h`, onsetTs: s.firstFailure, exitTs: null });
    else if (s.failures > 0 && s.landed) labels.set(k, { label: 'GT-', reason: `self-healed after ${s.failures} failures`, onsetTs: s.firstFailure, exitTs: null });
    else if (s.failures > 0) labels.set(k, { label: 'GT?', reason: 'failures, not landed, last attempt < recover window before now', onsetTs: s.firstFailure, exitTs: null });
  }
  return labels;
}

/** Precision / recall / latency of a notification list against the outcome labels. */
export function score(notifications, labels) {
  const firstByTask = new Map();
  for (const n of notifications) {
    if (!n.entity?.startsWith('task:')) continue;
    const k = `${n.project}|${n.entity.slice(5)}`;
    if (!firstByTask.has(k) || Date.parse(n.ts) < Date.parse(firstByTask.get(k).ts)) firstByTask.set(k, n);
  }
  const tp = [], fp = [], fn = [], late = [], unlabeled = [];
  const latencies = [];
  for (const [k, n] of firstByTask) {
    const l = labels.get(k);
    if (!l || l.label === 'GT?') unlabeled.push(k);
    else if (l.label === 'GT-') fp.push(k);
    else {
      if (l.exitTs && Date.parse(n.ts) > Date.parse(l.exitTs)) late.push(k);
      else tp.push(k);
      latencies.push((Date.parse(n.ts) - Date.parse(l.onsetTs)) / 60e3);
    }
  }
  for (const [k, l] of labels) if (l.label === 'GT+' && !firstByTask.has(k)) fn.push(k);
  const pos = tp.length + fp.length;
  const gtPos = [...labels.values()].filter((l) => l.label === 'GT+').length;
  latencies.sort((a, b) => a - b);
  return {
    notifiedTasks: firstByTask.size,
    tp, fp, fn, late, unlabeled,
    precision: pos ? tp.length / pos : null,
    recall: gtPos ? tp.length / gtPos : null,
    medianLatencyMin: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
  };
}
