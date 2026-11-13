#!/usr/bin/env node
/**
 * Bounded retention for the e2e data directories — the reclaimer the selector deliberately did not
 * contain.
 *
 * THE DEFECT THIS EXISTS FOR. Every e2e run creates one throwaway directory under a shared parent
 * (`$HOME/.cache/quay-e2e-tmp`, or whichever candidate `scripts/e2e-data-dir-selection.mjs` picks)
 * and nothing ever removes it. Measured on this host on 2026-09-28, `~/.cache/quay-e2e-tmp` held
 * 1794 directories / 103 GB, every one of them created within the previous 24 hours — a pure
 * accumulation rate of roughly 100 GB/day with no reclaimer anywhere on the run path. The pool is a
 * *user quota*, not a filesystem size: `df` still reported 3.3 TB free on `/data` while four
 * different writes failed with `EDQUOT` (`errno -122`) — Playwright's transform-cache `open`, a
 * `copyfile` of the auth database, an `mkdtemp` of the next run's directory, and even the `.lock`
 * file `task_write` needs to record the damage. The last one is what makes this a criterion defect
 * rather than an inconvenience: the failure lands *before* the run starts, so a criterion that is
 * green in every respect is reported red by an exhausted quota, with the failure text naming a
 * scratch path none of its assertions mention.
 *
 * WHY IT IS A SEPARATE MODULE. `scripts/e2e-data-dir-selection.mjs` says, in its own header, that
 * recycling what an earlier run left behind "is deliberately not this module's job (a run that
 * cannot start is the condition worth failing on; housekeeping is a separate concern)". That
 * sentence is a correct statement about *that* module — choosing where a run goes is not the same
 * decision as how long it stays — and it is the reason this file exists rather than an edit there.
 * The "separate concern" it names is this one. The selector's selection semantics, its 15 cases and
 * its refusal text are untouched.
 *
 * WHAT IS DECIDED HERE, AND WHAT IS NOT. `selectReclaimableDirs` is the whole decision: given
 * directory entries, a TTL and an exclusion set, which of them may be reclaimed. It touches nothing
 * — no filesystem, no clock, no log — so every branch is an input a test can hand in rather than an
 * environment it has to stand up. `reclaimDataDirs` is the thin sweep around it: read the parent,
 * apply the decision, remove what it selects, and report what happened. It never throws and never
 * ends a process; the caller owns both, and the run-path caller in particular must not be able to
 * die of its housekeeping.
 *
 * THE SAFETY BOUNDARIES, EACH ONE A READING RATHER THAN A PROMISE:
 *
 *   · TTL-bounded, and the bound is overridable. Only entries whose mtime is older than the TTL are
 *     ever selected, the default TTL is 6 hours — far longer than any run — and
 *     `QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS` overrides it for an operator draining a backlog.
 *   · Fail-closed on an unreadable TTL. `0`, a non-number and a negative value all mean "the bound
 *     could not be established", and an unknown bound reclaims NOTHING rather than everything.
 *   · Name-bounded. Only entries matching the run-directory prefix are candidates. This is not
 *     theoretical: this host's `~/.cache/quay-e2e-tmp` also holds `node-compile-cache` and
 *     `playwright-transform-cache-1004`, other tools' caches sitting in the same parent. They are
 *     never candidates, whatever their age.
 *   · Owner-bounded. Only directories owned by the invoking user are read into the candidate set,
 *     so another account's run directory under a shared parent is not this run's to delete.
 *   · Excluded-by-name. The directory this run is using is never reclaimed, even when it is older
 *     than the TTL — which is the shape a worker getting a re-evaluation would otherwise produce.
 *   · Budget-bounded on the run path. A sweep that removes a real backlog is not fast (measured here:
 *     ~38k files/s, ~89 ms for a 3371-file/63 MiB directory), so the run-path caller caps the work
 *     per run. The cap is a reading (`budgetMs`), the report says whether it was hit, and the manual
 *     entry is unbounded by default because it is not on a run's critical path.
 *
 * WHY A BUDGET RATHER THAN "DELETE EVERYTHING OLD". Deleting the whole backlog inside
 * `playwright.config.ts` would put minutes of synchronous `unlink` in front of every run — long
 * enough to cross the config's own boot ceiling, which is the same class of defect this task exists
 * to end, arriving from the other side. The accumulation rate is one directory per run and the
 * reclaim rate is bounded by the budget but far larger than that, so a partial sweep per run drains
 * the pool instead of merely failing to grow it.
 */

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
// No `node:os` import: the home and os-tmpdir defaults belong to `dataDirCandidates`, which already
// resolves them itself (`scripts/e2e-data-dir-selection.mjs`). This module only forwards the caller's
// override, so importing the same two functions here would be two names for nothing — which is
// exactly what lint reported before this line was deleted.
import { basename, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR_ENV, dataDirCandidates, readWritableHeadroom } from './e2e-data-dir-selection.mjs';

/**
 * Raises or lowers the retention TTL, in hours.
 *
 * A sibling of the selector's `QUAY_E2E_DATA_DIR_MIN_FREE_MB` in both naming and intent: the number
 * that decides this behaviour is a reading an operator can change, not a constant buried here. The
 * pair is how a backlog that has already grown is drained without editing code —
 * `QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS=1 npm run e2e:reclaim` reclaims everything older than an
 * hour instead of the default six.
 */
export const RETENTION_TTL_HOURS_ENV = 'QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS';

/**
 * How long an abandoned run directory is kept when nothing says otherwise.
 *
 * Six hours, and deliberately not lower: every value below this is a value some real run could
 * still be using. The longest leg in this checkout is bounded at 35 s and the goal gate kills a
 * criterion at 60 s, so six hours is ~360x the longest run this repository can produce — the point
 * where "old enough to be abandoned" stops being a guess about timing. It is also short enough to
 * be useful: at the measured ~100 GB/day of accumulation, a 6-hour window caps the pool at ~25 GB
 * *if nothing reclaims it*, which is a size the quota tolerates while the sweep catches up.
 */
export const DEFAULT_RETENTION_TTL_HOURS = 6;

/**
 * How long a *finished* run directory is kept, in milliseconds.
 *
 * Fifteen minutes. A run that wrote `test-results/.last-run.json` is over in every sense Playwright
 * has: the file is the runner's own record that it reached its end. Once nothing is using the
 * directory, the only reason to keep it longer is to read a failure afterwards — and a failing run's
 * directory is the one an operator wants, so the window is not zero.
 */
export const COMPLETED_MIN_AGE_MS = 15 * 60_000;

/**
 * How long a directory *without* `.last-run.json` is kept, in milliseconds.
 *
 * Sixty minutes. This is the class that actually filled the pool: a run killed before Playwright's
 * `onEnd` (host reboot, driver kill, OOM) leaves its trace chunks behind and never writes the
 * `.last-run.json` that the completed class has. Measured on this host on 2026-11-13: 104 such
 * directories held 84.7 GB of an 82 GB pool, against 6 completed directories holding 0.4 GB.
 *
 * The number is not round: the largest criterion in `goals/` is `timeoutMs: 600000` (10 minutes),
 * and this is six times that. No playwright invocation on this repository can still be inside its
 * own gate at 60 minutes, so "no `.last-run.json` and older than an hour" is a dead run rather than a
 * live one. The old 6 h TTL was six times *this* and was the size assumption that produced the
 * backlog.
 */
export const INTERRUPTED_MIN_AGE_MS = 60 * 60_000;

/**
 * Per-class overrides, in minutes. Both are printed on the report line, like the legacy TTL.
 *
 * Separate variables rather than one because the two classes are different risks: shortening the
 * completed window costs a post-mortem window, shortening the interrupted window can delete a run
 * that is still working.
 */
export const COMPLETED_TTL_MINUTES_ENV = 'QUAY_E2E_DATA_DIR_COMPLETED_TTL_MINUTES';
export const INTERRUPTED_TTL_MINUTES_ENV = 'QUAY_E2E_DATA_DIR_INTERRUPTED_TTL_MINUTES';

/**
 * Where Playwright leaves the marker that says a run reached its end.
 *
 * `test-results/<sandbox>/.last-run.json` is written by the runner when it finishes; an interrupted
 * run has no such file. The path is relative to the run directory, and it is the *only* signal used
 * to tell the two classes apart — mtime alone cannot, because both are just directories.
 */
export const LAST_RUN_RELATIVE_PATH = 'test-results/.last-run.json';

/** Milliseconds in one minute, for the per-class environment overrides. */
const MS_PER_MINUTE = 60_000;

/**
 * The prefix a run directory carries.
 *
 * Written here rather than imported from the selector, which spells the same prefix inline at its
 * `mkdtemp` call site: importing a private constant would mean widening the selector's surface for
 * this module's benefit, and the two spellings are held together by a test that reads the selector's
 * own creation through this prefix — a drift between them would leave every run directory
 * unreclaimable, which no case here could miss.
 */
export const RUN_DIR_PREFIX = 'quay-e2e-';

/**
 * How much of a run's own budget the owner-path sweep may spend by default, in milliseconds.
 *
 * Two seconds is ~3% of the 60 s a criterion is allowed and ~5% of this config's own 40 s boot
 * ceiling, and at the measured ~89 ms for a 3371-file directory it reclaims on the order of twenty
 * directories per run — against a creation rate of one directory per run. The bound exists because
 * the alternative is unbounded synchronous deletion in front of browser launch; it is a reading, not
 * a fixed count, so a slower or faster host changes the number of directories drained rather than
 * the delay a run pays.
 */
export const DEFAULT_RECLAIM_BUDGET_MS = 2_000;

/** Milliseconds in one hour, spelled once so the TTL arithmetic has a single home. */
const MS_PER_HOUR = 3_600_000;

/**
 * One directory under the parent being swept.
 *
 * `uid` is optional because it is a property of the *real* reader: an injected reader in a test
 * answers about names and ages, and the ownership filter treats a missing uid as owned (the caller
 * has already decided those entries are in scope).
 *
 * @typedef {object} RetentionEntry
 * @property {string} name The directory's own name under the parent, never a path.
 * @property {number} mtimeMs Its modification time, in epoch milliseconds.
 * @property {number} [uid] Its owner, when the reader could read one.
 * @property {boolean} [completed] True when the run wrote its `.last-run.json`; false/absent means it was interrupted.
 */

/**
 * The two halves of a retention decision.
 *
 * Both are returned, not just the reclaimable half: the pair is what lets a caller (and a case)
 * assert that a directory was *considered and kept* rather than never looked at
 * ([[anti-fake-variant-passes-means-criterion-hole]]).
 *
 * @typedef {object} RetentionSelection
 * @property {RetentionEntry[]} reclaimable The entries that may be removed.
 * @property {RetentionEntry[]} kept The entries that may not, for whatever reason.
 */

/**
 * What one sweep did.
 *
 * @typedef {object} RetentionReport
 * @property {string} parent The directory that was swept.
 * @property {number | null} ttlMs The legacy single TTL reading, or null when it could not be established.
 * @property {number | null} completedTtlMs The TTL applied to finished run directories.
 * @property {number | null} interruptedTtlMs The TTL applied to directories with no `.last-run.json`.
 * @property {boolean} dryRun True when nothing was removed.
 * @property {number} scanned Entries the parent held, before any filter.
 * @property {number} foreign Entries kept because they belong to another user.
 * @property {number} completed Entries the reader classified as finished runs.
 * @property {number} interrupted Entries the reader classified as interrupted runs.
 * @property {number} reclaimable Entries the decision selected.
 * @property {number} reclaimed Entries actually removed.
 * @property {number | null} bytesReclaimed Bytes removed, when a measurer was supplied.
 * @property {boolean} stoppedEarly True when the budget was crossed with entries still selected.
 * @property {boolean} budgetReached The same reading under the name the quota arm reports.
 * @property {number} elapsedMs Wall-clock the sweep spent, as the injected clock saw it.
 * @property {string[]} reclaimedNames The names actually removed, in the order they were removed.
 * @property {string[]} errors One line per thing that could not be read or removed.
 * @property {string} summary The whole report as one `[e2e]` line.
 */

/**
 * The retention TTL for this sweep, in milliseconds, from `RETENTION_TTL_HOURS_ENV` when it holds a
 * positive number.
 *
 * `null` means the bound could not be established, and it is deliberately not the default: a caller
 * who set a TTL and got six hours instead would be told the sweep was bounded when it was not, and
 * the only way to notice would be to read the printed number back. The selector refuses to start a
 * run in the same situation; here the fail-closed side is "keep everything", because the thing being
 * decided is a deletion.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
export const retentionTtlMsFromEnv = (env = process.env) => {
  const raw = env[RETENTION_TTL_HOURS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_TTL_HOURS * MS_PER_HOUR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * MS_PER_HOUR);
};

/**
 * One per-class TTL from an environment value in minutes; `null` means the bound was unreadable.
 *
 * Same fail-closed side as the legacy hours reader: a present-but-unreadable override is not
 * silently replaced by the default, because that would report a bound nobody asked for.
 *
 * @param {string | undefined} raw
 * @param {number} fallbackMs
 * @returns {number | null}
 */
const ttlMsFromMinutes = (raw, fallbackMs) => {
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * MS_PER_MINUTE);
};

/**
 * The completed-run TTL for a sweep, in milliseconds.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
export const completedTtlMsFromEnv = (env = process.env) => ttlMsFromMinutes(env[COMPLETED_TTL_MINUTES_ENV], COMPLETED_MIN_AGE_MS);

/**
 * The interrupted-run TTL for a sweep, in milliseconds.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
export const interruptedTtlMsFromEnv = (env = process.env) => ttlMsFromMinutes(env[INTERRUPTED_TTL_MINUTES_ENV], INTERRUPTED_MIN_AGE_MS);

/**
 * The two per-class TTLs one sweep will apply, honouring every override in precedence order.
 *
 * Precedence: an explicit option, then the legacy `ttlMs` option (the existing run-path call site
 * passes it and both classes must keep behaving as that caller asked), then the per-class
 * environment variable, then the legacy hours variable, then the class default. Every branch that
 * yields `null` means "the bound could not be established" and keeps entries, exactly as before.
 *
 * @param {{ ttlMs?: number | null, completedTtlMs?: number | null, interruptedTtlMs?: number | null }} options
 * @param {Record<string, string | undefined>} env
 * @returns {{ completedTtlMs: number | null, interruptedTtlMs: number | null }}
 */
const resolveClassTtls = (options, env) => {
  const legacyEnvRaw = env[RETENTION_TTL_HOURS_ENV];
  const legacyEnv = legacyEnvRaw !== undefined && legacyEnvRaw.trim() !== ''
    ? retentionTtlMsFromEnv(env)
    : undefined;
  /** @type {(explicit: number | null | undefined, envRaw: string | undefined, envReader: (env: Record<string, string | undefined>) => number | null, fallback: number) => number | null} */
  const pick = (explicit, envRaw, envReader, fallback) => {
    if (explicit !== undefined) return explicit;
    if (options.ttlMs !== undefined) return options.ttlMs;
    if (envRaw !== undefined && envRaw.trim() !== '') return envReader(env);
    if (legacyEnv !== undefined) return legacyEnv;
    return fallback;
  };
  return {
    completedTtlMs: pick(options.completedTtlMs, env[COMPLETED_TTL_MINUTES_ENV], completedTtlMsFromEnv, COMPLETED_MIN_AGE_MS),
    interruptedTtlMs: pick(options.interruptedTtlMs, env[INTERRUPTED_TTL_MINUTES_ENV], interruptedTtlMsFromEnv, INTERRUPTED_MIN_AGE_MS),
  };
};

/**
 * Which of `entries` may be reclaimed — the whole decision, as a pure function.
 *
 * Four things keep an entry:
 *
 *   · a TTL that could not be established (`null`, a non-number, or a value `<= 0`). An unknown bound
 *     is not a licence to delete: this is the fail-closed side, and it is the *only* behaviour for
 *     `0`, which a reader could otherwise mistake for "older than now".
 *   · a name that does not start with the run-directory prefix. Other tools cache in the same parent.
 *   · a name in the exclusion set. The set is compared as *names*, so a caller may hand in either
 *     the bare name or any path ending in it (`basename` is applied to values containing a
 *     separator); the entry this run is using is the one that must survive an over-age sweep.
 *   · an mtime newer than the cutoff. The comparison is strict (`>`), so an entry exactly at the
 *     cutoff is reclaimable — the bound is "older than the TTL", and an entry whose age is exactly
 *     the TTL is not younger than it.
 *
 * @param {{
 *   entries: RetentionEntry[],
 *   ttlMs: number | null,
 *   completedTtlMs?: number | null,
 *   interruptedTtlMs?: number | null,
 *   prefix?: string,
 *   exclude?: string[],
 *   now?: number,
 * }} options
 * @returns {RetentionSelection}
 */
export const selectReclaimableDirs = ({
  entries,
  ttlMs,
  completedTtlMs,
  interruptedTtlMs,
  prefix = RUN_DIR_PREFIX,
  exclude = [],
  now = Date.now(),
}) => {
  /** @type {Set<string>} */
  const excluded = new Set();
  for (const value of exclude) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    excluded.add(value.includes('/') ? basename(value) : value);
  }

  // A per-class TTL when the caller supplied one, else the single TTL the older call sites pass.
  // `null`/absent class TTLs deliberately fall back to `ttlMs`, so the existing controls (which know
  // only one bound) keep their exact semantics.
  const completedBound = completedTtlMs !== undefined ? completedTtlMs : ttlMs;
  const interruptedBound = interruptedTtlMs !== undefined ? interruptedTtlMs : ttlMs;
  /** @type {(value: number | null | undefined) => boolean} */
  const bounded = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

  /** @type {RetentionEntry[]} */
  const reclaimable = [];
  /** @type {RetentionEntry[]} */
  const kept = [];
  for (const entry of entries) {
    if (!bounded(completedBound) && !bounded(interruptedBound)) { kept.push(entry); continue; }
    if (typeof entry.name !== 'string' || !entry.name.startsWith(prefix)) { kept.push(entry); continue; }
    if (excluded.has(entry.name)) { kept.push(entry); continue; }
    // The class is the whole point of the split: a finished run is safe to reclaim far sooner than
    // one that was killed, because a killed run's directory may still belong to a live invocation.
    const bound = entry.completed === true ? completedBound : interruptedBound;
    if (!bounded(bound)) { kept.push(entry); continue; }
    const cutoff = now - /** @type {number} */ (bound);
    if (entry.mtimeMs > cutoff) { kept.push(entry); continue; }
    reclaimable.push(entry);
  }
  return { reclaimable, kept };
};

/**
 * The bytes a directory holds, summed over its files, without following symlinks.
 *
 * Best-effort by design: a file that disappears between the listing and the stat contributes
 * nothing rather than failing the measurement, because this number is a report and not a decision.
 * Symlinks are neither counted nor followed — the run directory is throwaway data, and a link into
 * something that is not throwaway must not make this walk read it.
 *
 * @param {string} target
 * @returns {number}
 */
export const dirSizeBytes = (target) => {
  let total = 0;
  /** @type {string[]} */
  const stack = [target];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    /** @type {import('node:fs').Dirent[]} */
    let dirents;
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const child = join(current, dirent.name);
      if (dirent.isDirectory()) { stack.push(child); continue; }
      if (!dirent.isFile()) continue;
      try {
        total += statSync(child).size;
      } catch {
        // Gone between the listing and the stat: it contributes no bytes and nothing else.
      }
    }
  }
  return total;
};

/**
 * The directories directly under `parent`, with the age and owner the decision needs.
 *
 * Only real directories, and only their own metadata: a symlink is skipped rather than resolved, so
 * a name in this listing always denotes a directory inside `parent` rather than somewhere else that
 * happens to be linked from it. A child that cannot be stat'ed is skipped for the same reason — the
 * sweep is not allowed to die of one unreadable entry.
 *
 * @param {string} parent
 * @returns {RetentionEntry[]}
 */
const readEntriesFrom = (parent) => {
  /** @type {RetentionEntry[]} */
  const entries = [];
  for (const dirent of readdirSync(parent, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    try {
      const stats = statSync(join(parent, dirent.name));
      // The runner's own end-of-run marker, not a guess from mtime: a directory with it is finished
      // and safe to reclaim on the short TTL; one without it may be a run that is still working.
      const completed = existsSync(join(parent, dirent.name, LAST_RUN_RELATIVE_PATH));
      entries.push({ name: dirent.name, mtimeMs: stats.mtimeMs, uid: stats.uid, completed });
    } catch {
      // Unreadable: not a candidate this sweep can reason about, and not a reason to stop.
    }
  }
  return entries;
};

/**
 * `error.message` for anything throwable, so a caught non-Error does not print as `undefined`.
 *
 * @param {unknown} error
 * @returns {string}
 */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The whole report as one `[e2e]` line, with `null` fields spelled as words rather than as `null`.
 *
 * One line, because this is the reading an operator checks the sweep against — the same shape the
 * selector's `data-dir=… free-bytes=…` line has, and for the same reason: it has to be parseable
 * and quotable without the reader having to reconstruct it from several outputs.
 *
 * @param {RetentionReport} report
 * @returns {string}
 */
const describeRetention = (report) => [
  `[e2e] retention: parent=${report.parent}`,
  `ttl-ms=${report.ttlMs === null ? 'none' : String(report.ttlMs)}`,
  `completed-ttl-ms=${report.completedTtlMs === null ? 'none' : String(report.completedTtlMs)}`,
  `interrupted-ttl-ms=${report.interruptedTtlMs === null ? 'none' : String(report.interruptedTtlMs)}`,
  `scanned=${report.scanned}`,
  `reclaimable=${report.reclaimable}`,
  `reclaimed=${report.reclaimed}`,
  `bytes-reclaimed=${report.bytesReclaimed === null ? 'n/a' : String(report.bytesReclaimed)}`,
  `remaining=${report.reclaimable - report.reclaimed}`,
  `elapsed-ms=${report.elapsedMs}`,
  `completed=${report.completed}`,
  `interrupted=${report.interrupted}`,
  ...(report.foreign > 0 ? [`foreign-kept=${report.foreign}`] : []),
  ...(report.dryRun ? ['dry-run=true'] : []),
  ...(report.stoppedEarly ? ['stopped-early=true', 'budget-reached=true'] : []),
  ...(report.errors.length > 0 ? [`errors=${report.errors.length}`] : []),
].join(' ');

/**
 * Sweeps one parent directory: reads it, applies the decision, removes what it selects.
 *
 * Never throws and never ends a process. Every failure — an unreadable parent, a child that cannot be
 * removed — becomes a line in `errors` and the sweep continues, because the alternative is a run
 * dying of its own housekeeping, which is the shape of the defect this file exists for arriving from
 * the other side. A parent that does not exist is not an error at all: it is a parent with nothing
 * in it, which is the common case for a host whose runs have never used that candidate.
 *
 * The clock is injected (`now`) and read twice per removal, so a case can cross the budget without
 * waiting for it. `measureBytes` is optional and defaults to *no* measurement: walking a directory to
 * learn its size costs about as much as removing it, which is a price the run path must not pay for a
 * number only the manual entry reports.
 *
 * @param {{
 *   parent?: string,
 *   env?: Record<string, string | undefined>,
 *   ttlMs?: number | null,
 *   prefix?: string,
 *   exclude?: string[],
 *   budgetMs?: number,
 *   dryRun?: boolean,
 *   ownerUid?: number | null,
 *   now?: () => number,
 *   readEntries?: (parent: string) => RetentionEntry[],
 *   remove?: (target: string) => void,
 *   measureBytes?: (target: string) => number,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {RetentionReport}
 */
export const reclaimDataDirs = (options = {}) => {
  const parent = typeof options.parent === 'string' ? options.parent : '';
  const dryRun = options.dryRun === true;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const readEntries = options.readEntries ?? readEntriesFrom;
  const remove = options.remove ?? ((target) => { rmSync(target, { recursive: true, force: true }); });
  const measureBytes = options.measureBytes;

  /**
   * The invoking user, or null when the platform has no such notion (`process.getuid` is absent on
   * Windows). Null means "ownership is not a filter here" rather than "no entry is owned", so the
   * sweep still works where the question cannot be asked.
   */
  /** @type {number | null} */
  let ownerUid;
  if (options.ownerUid !== undefined) {
    ownerUid = options.ownerUid;
  } else {
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null;
  }

  /** @type {RetentionReport} */
  const report = {
    parent,
    ttlMs: null,
    completedTtlMs: null,
    interruptedTtlMs: null,
    dryRun,
    scanned: 0,
    foreign: 0,
    completed: 0,
    interrupted: 0,
    reclaimable: 0,
    reclaimed: 0,
    bytesReclaimed: measureBytes === undefined ? null : 0,
    stoppedEarly: false,
    budgetReached: false,
    elapsedMs: 0,
    reclaimedNames: [],
    errors: [],
    summary: '',
  };

  const startedAt = now();
  try {
    const env = options.env ?? process.env;
    report.ttlMs = options.ttlMs !== undefined
      ? options.ttlMs
      : retentionTtlMsFromEnv(env);
    const classTtls = resolveClassTtls(options, env);
    report.completedTtlMs = classTtls.completedTtlMs;
    report.interruptedTtlMs = classTtls.interruptedTtlMs;
    const budgetMs = options.budgetMs ?? DEFAULT_RECLAIM_BUDGET_MS;

    /** @type {RetentionEntry[]} */
    let entries;
    try {
      entries = readEntries(parent);
    } catch (error) {
      // A parent that is not there is empty, not broken: on this host two of the three candidates
      // exist, and a host that has never run an e2e has none. Any other failure is recorded and the
      // sweep stops here rather than guessing what the parent holds.
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code !== 'ENOENT') {
        report.errors.push(`${parent}: could not be read (${errorMessage(error)}) — nothing is reclaimed here`);
        log(`[e2e] retention: ${report.errors[0]}`);
      }
      report.elapsedMs = now() - startedAt;
      report.summary = describeRetention(report);
      return report;
    }

    const owned = entries.filter((entry) => ownerUid === null || entry.uid === undefined || entry.uid === ownerUid);
    report.scanned = entries.length;
    report.foreign = entries.length - owned.length;
    report.completed = owned.filter((entry) => entry.completed === true).length;
    report.interrupted = owned.length - report.completed;

    const { reclaimable } = selectReclaimableDirs({
      entries: owned,
      ttlMs: report.ttlMs,
      completedTtlMs: report.completedTtlMs,
      interruptedTtlMs: report.interruptedTtlMs,
      prefix: options.prefix ?? RUN_DIR_PREFIX,
      exclude: options.exclude ?? [],
      now: now(),
    });
    report.reclaimable = reclaimable.length;
    // Oldest first, so a sweep that cannot finish spends its budget on the bytes most likely to be
    // dead. The listing order is whatever the filesystem hands back; it is not a policy.
    reclaimable.sort((left, right) => left.mtimeMs - right.mtimeMs);

    for (const entry of reclaimable) {
      if (now() - startedAt > budgetMs) {
        report.stoppedEarly = true;
        report.budgetReached = true;
        break;
      }
      const target = join(parent, entry.name);
      if (measureBytes !== undefined) {
        try {
          report.bytesReclaimed = (report.bytesReclaimed ?? 0) + measureBytes(target);
        } catch {
          // A directory whose size cannot be read is still a directory that can be removed; the
          // report's byte count is the only thing lost.
        }
      }
      if (dryRun) continue;
      try {
        remove(target);
        report.reclaimed += 1;
        report.reclaimedNames.push(entry.name);
      } catch (error) {
        report.errors.push(`${entry.name}: could not be removed (${errorMessage(error)}) — leaving it in place`);
      }
    }
  } catch (error) {
    // The outer net. Nothing above is expected to throw, and the one thing that must hold whatever
    // happens is that a caller's run cannot end here: this function is called from Playwright's own
    // config evaluation, where a throw is a run that never starts.
    report.errors.push(`${parent}: the sweep itself failed (${errorMessage(error)}) — nothing further was reclaimed`);
  }

  report.elapsedMs = now() - startedAt;
  report.summary = describeRetention(report);
  log(report.summary);
  for (const error of report.errors) log(`[e2e] retention: ${error}`);
  return report;
};

/**
 * What one headroom-driven sweep did.
 *
 * @typedef {object} HeadroomReport
 * @property {string} parent The directory that was swept.
 * @property {number} floorBytes The headroom the sweep was trying to reach.
 * @property {number | null} headroomBefore The reading at the start, or null when it was unavailable.
 * @property {number | null} headroomAfter The last reading taken, or null when it was unavailable.
 * @property {number} scanned Entries the parent held, before any filter.
 * @property {number} eligible Entries the age rule selected, oldest first.
 * @property {number} reclaimed Entries actually removed.
 * @property {number | null} bytesReclaimed Bytes removed, when a measurer was supplied.
 * @property {boolean} budgetReached True when the budget was crossed with eligible entries left.
 * @property {boolean} exhausted True when every eligible entry was removed and the floor was still not met.
 * @property {boolean} floorMet True when the headroom reading reached the floor (or was already there).
 * @property {boolean} dryRun True when nothing was removed.
 * @property {number} elapsedMs Wall-clock the sweep spent, as the injected clock saw it.
 * @property {string[]} reclaimedNames The names actually removed, oldest first.
 * @property {string[]} errors One line per thing that could not be read or removed.
 * @property {string} summary The whole report as one `[e2e]` line.
 */

/**
 * Reclaims age-eligible run directories oldest-first until the writable headroom reaches `floorBytes`.
 *
 * This is the arm the 2026-11-13 defect needed. The pool was 82 GB, 98.6% of it interrupted runs,
 * while the free-space floor was satisfied by `statfs` on a quota-exhausted filesystem — so no
 * existing sweep ever ran with a reason to continue past the first few directories, and the run that
 * needed room started anyway. The decision now reads the *writable headroom* (the caller passes a
 * reader; in the run path it is the selector's quota-first reading) and keeps going, oldest first,
 * while that reading is below the floor.
 *
 * The age rule is never relaxed. An entry without `.last-run.json` younger than the interrupted TTL
 * may be a run that is still working, and deleting it would be a worse defect than a full quota; the
 * arm can therefore end `exhausted` with headroom still short, and the caller refuses the run at
 * that point rather than guessing. The budget is the other bound: on the run path it is the same
 * few-second slice every sweep gets, reported as `budgetReached` so the next run knows a backlog is
 * still there. The manual entry passes `Infinity`.
 *
 * A healthy headroom does not stop the age sweep: age-eligible entries are removed either way (that
 * is how the pool stops growing), but nothing outside the age rule is ever touched. That asymmetry
 * is the whole "healthy reading ⇒ no extra deletion" control.
 *
 * @param {{
 *   parent?: string,
 *   floorBytes?: number,
 *   env?: Record<string, string | undefined>,
 *   ttlMs?: number | null,
 *   completedTtlMs?: number | null,
 *   interruptedTtlMs?: number | null,
 *   headroomBytes?: () => number | null,
 *   prefix?: string,
 *   exclude?: string[],
 *   budgetMs?: number,
 *   dryRun?: boolean,
 *   ownerUid?: number | null,
 *   now?: () => number,
 *   readEntries?: (parent: string) => RetentionEntry[],
 *   remove?: (target: string) => void,
 *   measureBytes?: (target: string) => number,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {HeadroomReport}
 */
export const reclaimForHeadroom = (options = {}) => {
  const parent = typeof options.parent === 'string' ? options.parent : '';
  const floorBytes = typeof options.floorBytes === 'number' && Number.isFinite(options.floorBytes) && options.floorBytes > 0
    ? options.floorBytes
    : 0;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const readEntries = options.readEntries ?? readEntriesFrom;
  const remove = options.remove ?? ((target) => { rmSync(target, { recursive: true, force: true }); });
  const measureBytes = options.measureBytes;
  const dryRun = options.dryRun === true;
  const budgetMs = options.budgetMs ?? DEFAULT_RECLAIM_BUDGET_MS;
  /** A reader that throws or is absent is the same reading as one that answers null: unavailable. */
  const readHeadroom = () => {
    if (options.headroomBytes === undefined) return null;
    try {
      const value = options.headroomBytes();
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  /** @type {number | null} */
  let ownerUid;
  if (options.ownerUid !== undefined) {
    ownerUid = options.ownerUid;
  } else {
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null;
  }

  /** @type {HeadroomReport} */
  const report = {
    parent,
    floorBytes,
    headroomBefore: null,
    headroomAfter: null,
    scanned: 0,
    eligible: 0,
    reclaimed: 0,
    bytesReclaimed: measureBytes === undefined ? null : 0,
    budgetReached: false,
    exhausted: false,
    floorMet: false,
    dryRun,
    elapsedMs: 0,
    reclaimedNames: [],
    errors: [],
    summary: '',
  };

  const startedAt = now();
  try {
    const env = options.env ?? process.env;
    const classTtls = resolveClassTtls(options, env);

    /** @type {RetentionEntry[]} */
    let entries;
    try {
      entries = readEntries(parent);
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code !== 'ENOENT') {
        report.errors.push(`${parent}: could not be read (${errorMessage(error)}) — nothing is reclaimed here`);
      }
      report.elapsedMs = now() - startedAt;
      report.summary = describeHeadroom(report);
      log(report.summary);
      return report;
    }

    const owned = entries.filter((entry) => ownerUid === null || entry.uid === undefined || entry.uid === ownerUid);
    report.scanned = entries.length;
    const { reclaimable } = selectReclaimableDirs({
      entries: owned,
      ttlMs: options.ttlMs === undefined ? null : options.ttlMs,
      completedTtlMs: classTtls.completedTtlMs,
      interruptedTtlMs: classTtls.interruptedTtlMs,
      prefix: options.prefix ?? RUN_DIR_PREFIX,
      exclude: options.exclude ?? [],
      now: now(),
    });
    reclaimable.sort((left, right) => left.mtimeMs - right.mtimeMs);
    report.eligible = reclaimable.length;
    report.headroomBefore = readHeadroom();
    // Only a *short* reading makes "stop once the floor is met" meaningful; a healthy one still gets
    // the ordinary age sweep, which is what keeps the pool from growing.
    const short = report.headroomBefore !== null
      ? report.headroomBefore < floorBytes
      : false;
    report.floorMet = report.headroomBefore !== null && report.headroomBefore >= floorBytes;
    report.headroomAfter = report.headroomBefore;

    for (let index = 0; index < reclaimable.length; index += 1) {
      const entry = reclaimable[index];
      if (now() - startedAt > budgetMs) {
        report.budgetReached = true;
        break;
      }
      const target = join(parent, entry.name);
      if (measureBytes !== undefined) {
        try {
          report.bytesReclaimed = (report.bytesReclaimed ?? 0) + measureBytes(target);
        } catch {
          // The byte count is a report; it is not the decision.
        }
      }
      if (!dryRun) {
        try {
          remove(target);
          report.reclaimed += 1;
          report.reclaimedNames.push(entry.name);
        } catch (error) {
          report.errors.push(`${entry.name}: could not be removed (${errorMessage(error)}) — leaving it in place`);
        }
      }
      report.headroomAfter = readHeadroom();
      if (short && report.headroomAfter !== null && report.headroomAfter >= floorBytes) {
        report.floorMet = true;
        break;
      }
    }

    // Exhausted means every eligible entry was offered and the floor is still not met — the only
    // condition under which the caller may refuse for lack of room. A budget stop is not exhaustion.
    report.exhausted = !report.floorMet
      && !report.budgetReached
      && report.reclaimed === reclaimable.length
      && (report.headroomAfter === null || report.headroomAfter < floorBytes);
  } catch (error) {
    report.errors.push(`${parent}: the headroom sweep itself failed (${errorMessage(error)}) — nothing further was reclaimed`);
  }

  report.elapsedMs = now() - startedAt;
  report.summary = describeHeadroom(report);
  log(report.summary);
  for (const error of report.errors) log(`[e2e] retention-headroom: ${error}`);
  return report;
};

/**
 * The whole headroom report as one `[e2e]` line.
 *
 * @param {HeadroomReport} report
 * @returns {string}
 */
const describeHeadroom = (report) => [
  `[e2e] retention-headroom: parent=${report.parent}`,
  `floor-bytes=${report.floorBytes}`,
  `headroom-before=${report.headroomBefore === null ? 'n/a' : String(report.headroomBefore)}`,
  `headroom-after=${report.headroomAfter === null ? 'n/a' : String(report.headroomAfter)}`,
  `scanned=${report.scanned}`,
  `eligible=${report.eligible}`,
  `reclaimed=${report.reclaimed}`,
  `bytes-reclaimed=${report.bytesReclaimed === null ? 'n/a' : String(report.bytesReclaimed)}`,
  `floor-met=${report.floorMet}`,
  ...(report.budgetReached ? ['budget-reached=true'] : []),
  ...(report.exhausted ? ['exhausted=true'] : []),
  ...(report.dryRun ? ['dry-run=true'] : []),
  ...(report.errors.length > 0 ? [`errors=${report.errors.length}`] : []),
].join(' ');

/**
 * The parent directories a sweep with no explicit target considers.
 *
 * The selector's own candidate list, unchanged and undeduplicated-once-more: those are exactly the
 * directories a run may create a data directory inside, so those are the directories that accumulate
 * one. Existing directories only — sweeping a parent that is not there would be a listing that
 * cannot succeed — and the list is the selector's, so a host that changes where runs go does not
 * leave this module sweeping the old place.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, osTmpdir?: string }} [options]
 * @returns {string[]}
 */
export const defaultRetentionParents = (options = {}) => {
  const env = options.env ?? process.env;
  /** @type {string[]} */
  const existing = [];
  for (const candidate of dataDirCandidates({ env, home: options.home, osTmpdir: options.osTmpdir })) {
    try {
      if (statSync(candidate).isDirectory()) existing.push(candidate);
    } catch {
      // Not there: nothing has accumulated in it, and nothing can be listed out of it.
    }
  }
  return existing;
};

/** Usage line, printed by `--help` and by an argument this entry does not understand. */
const USAGE = [
  'usage: node scripts/e2e-data-dir-retention.mjs [--parent <dir>]... [--dry-run] [--budget-ms <n>]',
  '       [--until-headroom-mb <n>] [--quiet]',
  '',
  `Reclaims e2e run directories past their class TTL (completed ${COMPLETED_MIN_AGE_MS / MS_PER_MINUTE}m,`
    + ` interrupted ${INTERRUPTED_MIN_AGE_MS / MS_PER_MINUTE}m; override with ${COMPLETED_TTL_MINUTES_ENV} /`
    + ` ${INTERRUPTED_TTL_MINUTES_ENV}, or all of them with ${RETENTION_TTL_HOURS_ENV}).`,
  'With no --parent, every existing data-directory candidate is swept.',
  '--until-headroom-mb is the emergency arm: keep reclaiming age-eligible directories, oldest first,',
  'until the writable headroom (xfs quota when readable, statfs otherwise) reaches that many MiB.',
  'It is off by default, ignores --budget-ms unless one is given, and never relaxes the age rule.',
  'Exit status is always 0: housekeeping must not be able to fail a run.',
].join('\n');

/**
 * The manual entry — `npm run e2e:reclaim`.
 *
 * Unbounded in time by default, because this is the operator's drain and not a step in front of a
 * browser launch; `--budget-ms` bounds it for a caller that cares. `QUAY_E2E_DATA_DIR` is excluded
 * exactly as the run path excludes the directory it created, so a sweep started beside a live run
 * does not reclaim that run's data.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, log?: (line: string) => void }} [options]
 * @returns {number}
 */
export const runRetentionCli = (argv, options = {}) => {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.log(line));
  /** @type {string[]} */
  const parents = [];
  let dryRun = false;
  let quiet = false;
  let budgetMs = Number.POSITIVE_INFINITY;
  /** @type {number | null} */
  let untilHeadroomBytes = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--until-headroom-mb') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) untilHeadroomBytes = Math.round(value) * 1024 * 1024;
      index += 1;
      continue;
    }
    if (arg === '--parent') {
      const value = argv[index + 1];
      if (typeof value === 'string' && value.trim() !== '') parents.push(resolvePath(value));
      index += 1;
      continue;
    }
    if (arg === '--budget-ms') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value >= 0) budgetMs = value;
      index += 1;
      continue;
    }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--quiet') { quiet = true; continue; }
    if (arg === '--help' || arg === '-h') { log(USAGE); return 0; }
    // An unrecognised argument is named rather than ignored: a typo'd `--parents` would otherwise
    // sweep the default list, which is exactly the quiet widening an operator must not get.
    log(`${USAGE}\nunknown argument: ${arg}`);
    return 0;
  }

  /** The declared data directory, if any: the one directory this sweep must not touch. */
  const declared = env[DATA_DIR_ENV];
  const exclude = typeof declared === 'string' && declared.trim() !== '' ? [declared] : [];
  const targets = parents.length > 0 ? parents : defaultRetentionParents({ env });

  let reclaimed = 0;
  let bytesReclaimed = 0;
  let swept = 0;
  for (const parent of targets) {
    // The emergency arm replaces the ordinary sweep for this parent rather than running after it:
    // one pass over the parent, oldest first, with the floor as the reason to continue. It applies
    // the same age rule, so it can leave under-age directories behind and still report exhausted.
    const report = untilHeadroomBytes !== null
      ? reclaimForHeadroom({
          parent,
          env,
          floorBytes: untilHeadroomBytes,
          exclude,
          dryRun,
          budgetMs,
          headroomBytes: () => readWritableHeadroom(parent).availableBytes,
          measureBytes: dirSizeBytes,
          log: quiet ? () => {} : log,
        })
      : reclaimDataDirs({
          parent,
          env,
          exclude,
          dryRun,
          budgetMs,
          // The manual entry pays for the byte reading the run path declines: it is the number an
          // operator quotes after a drain, and it is the only place that number is worth a second walk.
          measureBytes: dirSizeBytes,
          log: quiet ? () => {} : log,
        });
    swept += 1;
    reclaimed += report.reclaimed;
    bytesReclaimed += report.bytesReclaimed ?? 0;
  }
  log(
    `[e2e] retention: total parents=${swept} reclaimed=${reclaimed} bytes-reclaimed=${bytesReclaimed}`
      + (untilHeadroomBytes !== null ? ` until-headroom-bytes=${untilHeadroomBytes}` : '')
      + (dryRun ? ' dry-run=true' : ''),
  );
  return 0;
};

/**
 * Whether this file is the process's entry point.
 *
 * Both sides go through `realpath` because a task worktree reaches this file through paths that may
 * themselves be links, and an entry that silently did nothing would make `npm run e2e:reclaim` exit
 * 0 without sweeping — a green that cannot go red. Imported (as `playwright.config.ts` does),
 * `process.argv[1]` names the importer and this is false.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // `process.exitCode` rather than `process.exit`: a sweep still writing its report to a pipe must
  // not have the write truncated by an immediate exit, and the status is the same either way.
  process.exitCode = runRetentionCli(process.argv.slice(2));
}
