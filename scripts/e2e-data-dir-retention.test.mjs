#!/usr/bin/env node
/**
 * The controls for `scripts/e2e-data-dir-retention.mjs` — the reclaimer that keeps the e2e data
 * directories from eating the user's quota.
 *
 * WHY THESE CASES EXIST. The module deletes things, and every way it could delete the wrong thing is
 * a way the defect it closes comes back in a worse form. Each case below is therefore aimed at one
 * half of what has to hold:
 *
 *   AC1 keeps-entry-younger-than-ttl        — an entry inside the TTL is considered and kept
 *   AC1 selects-entry-older-than-ttl        — the same entry one TTL later is selected
 *   AC1 never-selects-non-run-dir-name      — another tool's cache in the same parent is never a candidate
 *   AC1 never-selects-the-excluded-current-dir — the run's own directory survives being over-age
 *   AC1 invalid-ttl-selects-nothing         — an unreadable bound reclaims nothing, never everything
 *   AC1 missing-parent-is-empty-not-throwing — housekeeping cannot fail a run
 *   AC4 the side effects, on a real fixture  — what survives, asserted on the disk rather than on a plan
 *
 * THE READINGS, NOT THE PROMISES. Nothing here asserts that the module "would" keep something: the
 * pure cases read the two halves of the decision (selected *and* kept) so that "not selected" cannot
 * be satisfied by "never considered", and the fixture case reads the filesystem after the sweep so
 * that "survives" means the directory is still there. The TTL's own value is read back and bounded
 * rather than restated, and the prefix this module reclaims by is checked against the name the
 * selector *actually creates*, because a drift between those two spellings would leave every run
 * directory unreclaimable while every case here still passed.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_RECLAIM_BUDGET_MS,
  DEFAULT_RETENTION_TTL_HOURS,
  RETENTION_TTL_HOURS_ENV,
  RUN_DIR_PREFIX,
  defaultRetentionParents,
  dirSizeBytes,
  reclaimDataDirs,
  retentionTtlMsFromEnv,
  runRetentionCli,
  selectReclaimableDirs,
} from './e2e-data-dir-retention.mjs';
import { resolveE2eDataDir } from './e2e-data-dir-selection.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * A fixed clock, so "thirty days old" is arithmetic rather than a wait.
 *
 * The pure cases pass it as `now`, which is what makes an age assertion a reading of the module's
 * own arithmetic instead of a race with the machine's clock.
 */
const NOW = 1_700_000_000_000;

/**
 * An entry `ageMs` old, as the parent reader would report it.
 *
 * @param {string} name
 * @param {number} ageMs
 * @returns {{ name: string, mtimeMs: number }}
 */
const entry = (name, ageMs) => ({ name, mtimeMs: NOW - ageMs });

/**
 * A real, empty directory to stand in for the parents a run accumulates under.
 *
 * @returns {string}
 */
const makeScratchRoot = () => mkdtempSync(join(tmpdir(), 'e2e-data-dir-retention-test-'));

/**
 * Backdates a path by `ageMs`, so a fixture directory can be thirty days old without being waited for.
 *
 * @param {string} target
 * @param {number} ageMs
 */
const backdate = (target, ageMs) => {
  const when = new Date(Date.now() - ageMs);
  utimesSync(target, when, when);
};

test('AC1 keeps-entry-younger-than-ttl', () => {
  const young = `${RUN_DIR_PREFIX}today`;
  const { reclaimable, kept } = selectReclaimableDirs({
    entries: [entry(young, HOUR_MS), entry(`${RUN_DIR_PREFIX}ancient`, 30 * DAY_MS)],
    ttlMs: 6 * HOUR_MS,
    now: NOW,
  });
  // Both halves are read: the young entry is in `kept`, which is what stops "reclaimable is empty
  // of it" from being satisfied by a decision that never looked at it.
  assert.deepEqual(reclaimable.map((candidate) => candidate.name), [`${RUN_DIR_PREFIX}ancient`]);
  assert.deepEqual(kept.map((candidate) => candidate.name), [young]);
});

test('AC1 selects-entry-older-than-ttl', () => {
  const { reclaimable, kept } = selectReclaimableDirs({
    entries: [entry(`${RUN_DIR_PREFIX}one-ms-past`, 6 * HOUR_MS + 1), entry(`${RUN_DIR_PREFIX}exactly-at`, 6 * HOUR_MS)],
    ttlMs: 6 * HOUR_MS,
    now: NOW,
  });
  // The boundary is `>`: an entry whose age is exactly the TTL is not *younger* than it. Both sides
  // are asserted, so moving the comparison either way is caught here rather than in production.
  assert.deepEqual(
    reclaimable.map((candidate) => candidate.name),
    [`${RUN_DIR_PREFIX}one-ms-past`, `${RUN_DIR_PREFIX}exactly-at`],
  );
  assert.deepEqual(kept, []);
});

test('AC1 never-selects-non-run-dir-name', () => {
  // The names here are the ones this host really keeps beside the run directories under
  // `~/.cache/quay-e2e-tmp`; a reclaimer that swept by age alone would delete them.
  const { reclaimable, kept } = selectReclaimableDirs({
    entries: [
      entry('node-compile-cache', 30 * DAY_MS),
      entry('playwright-transform-cache-1004', 30 * DAY_MS),
      entry('ac122-tmp', 30 * DAY_MS),
      entry(`${RUN_DIR_PREFIX}x4EhGt`, 30 * DAY_MS),
    ],
    ttlMs: 6 * HOUR_MS,
    now: NOW,
  });
  assert.deepEqual(reclaimable.map((candidate) => candidate.name), [`${RUN_DIR_PREFIX}x4EhGt`]);
  assert.equal(kept.length, 3, 'a name that is not a run directory is never a candidate');
  // The prefix is a prefix, not a substring: a name that merely contains it is not one of ours.
  const near = selectReclaimableDirs({ entries: [entry('my-quay-e2e-copy', 30 * DAY_MS)], ttlMs: 6 * HOUR_MS, now: NOW });
  assert.deepEqual(near.reclaimable, []);
});

test('AC1 never-selects-the-excluded-current-dir', () => {
  const current = `${RUN_DIR_PREFIX}current`;
  const byName = selectReclaimableDirs({
    entries: [entry(current, 30 * DAY_MS)],
    ttlMs: 6 * HOUR_MS,
    exclude: [current],
    now: NOW,
  });
  assert.deepEqual(byName.reclaimable, [], 'an excluded directory survives being far past the TTL');
  assert.deepEqual(byName.kept.map((candidate) => candidate.name), [current]);

  // A path and a bare name are the same exclusion: the run path knows its directory as an absolute
  // path and the entries are names, so a comparison that only understood one of the two would apply
  // no exclusion at all while looking like it did.
  const byPath = selectReclaimableDirs({
    entries: [entry(current, 30 * DAY_MS), entry(`${RUN_DIR_PREFIX}other`, 30 * DAY_MS)],
    ttlMs: 6 * HOUR_MS,
    exclude: [join('/home/someone/.cache/quay-e2e-tmp', current), ''],
    now: NOW,
  });
  assert.deepEqual(byPath.reclaimable.map((candidate) => candidate.name), [`${RUN_DIR_PREFIX}other`]);
});

test('AC1 invalid-ttl-selects-nothing', () => {
  const entries = [entry(`${RUN_DIR_PREFIX}ancient`, 30 * DAY_MS), entry(`${RUN_DIR_PREFIX}today`, HOUR_MS)];
  // `null` is the module's own "the bound could not be established"; the rest are what an operator
  // can actually hand in through the environment. `Infinity` is in the list because `Number()`
  // parses it and `Number.isFinite` is what refuses it.
  for (const ttlMs of [null, 0, -1, -6 * HOUR_MS, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { reclaimable, kept } = selectReclaimableDirs({ entries, ttlMs, now: NOW });
    assert.deepEqual(reclaimable, [], `ttlMs=${String(ttlMs)} must reclaim nothing (fail-closed on the keep side)`);
    assert.equal(kept.length, 2, `ttlMs=${String(ttlMs)} must keep every entry, not merely skip the removal`);
  }
});

test('AC1 missing-parent-is-empty-not-throwing', () => {
  const root = makeScratchRoot();
  try {
    const report = reclaimDataDirs({ parent: join(root, 'no-such-parent'), ttlMs: 6 * HOUR_MS });
    assert.equal(report.scanned, 0);
    assert.equal(report.reclaimable, 0);
    assert.equal(report.reclaimed, 0);
    assert.deepEqual(report.errors, [], 'a parent that is not there is empty, not broken');
    assert.match(report.summary, /scanned=0 reclaimable=0 reclaimed=0/);

    // A parent that exists but cannot be listed is recorded rather than thrown: the same call site
    // runs inside Playwright's config evaluation, where a throw is a run that never starts.
    const asFile = join(root, 'not-a-directory');
    writeFileSync(asFile, 'not a directory\n');
    const broken = reclaimDataDirs({ parent: asFile, ttlMs: 6 * HOUR_MS });
    assert.equal(broken.reclaimed, 0);
    assert.equal(broken.errors.length, 1, 'the failure is reported on the report, not as an exception');
    assert.match(broken.errors[0], /could not be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 the TTL is a reading: six hours by default, and the environment can move it either way', () => {
  assert.equal(retentionTtlMsFromEnv({}), DEFAULT_RETENTION_TTL_HOURS * HOUR_MS);
  assert.equal(retentionTtlMsFromEnv({ [RETENTION_TTL_HOURS_ENV]: '  ' }), DEFAULT_RETENTION_TTL_HOURS * HOUR_MS);
  assert.equal(retentionTtlMsFromEnv({ [RETENTION_TTL_HOURS_ENV]: '1' }), HOUR_MS);
  assert.equal(retentionTtlMsFromEnv({ [RETENTION_TTL_HOURS_ENV]: '0.05' }), 3 * 60_000);
  // Unreadable, not defaulted: a caller who asked for a bound and got the default would be told the
  // sweep was bounded when it was not.
  for (const raw of ['0', '-1', 'abc', 'NaN', 'Infinity']) {
    assert.equal(retentionTtlMsFromEnv({ [RETENTION_TTL_HOURS_ENV]: raw }), null, `${raw} is not a bound`);
  }
  // Bounded below by the longest run this repository can produce: the goal gate kills a criterion at
  // 60 s, and this must be far enough above that no live run is ever inside the window.
  assert.ok(
    DEFAULT_RETENTION_TTL_HOURS >= 6,
    `a ${DEFAULT_RETENTION_TTL_HOURS}h default is not safely longer than any run`,
  );
});

test('AC1 the prefix reclaimed by is the prefix the selector actually creates', () => {
  const root = makeScratchRoot();
  try {
    // No `makeTempDir`: the real `mkdtempSync(join(parent, 'quay-e2e-'))` runs, and the name it
    // produces is the one this module's prefix has to match. Restating the string here would agree
    // with the module whatever the selector did.
    const resolved = resolveE2eDataDir({
      env: { QUAY_E2E_DATA_DIR_MIN_FREE_MB: '1' },
      home: root,
      osTmpdir: root,
      availableBytes: () => 4096 * 1024 * 1024,
      log: () => {},
    });
    const created = resolved.dataDir.slice(resolved.dataDir.lastIndexOf('/') + 1);
    assert.ok(
      created.startsWith(RUN_DIR_PREFIX),
      `the selector creates "${created}", which the ${RUN_DIR_PREFIX} prefix would never reclaim`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 another user’s directory is never reclaimed, and one unreadable entry does not stop the sweep', () => {
  const root = makeScratchRoot();
  try {
    /** @type {string[]} */
    const removed = [];
    const report = reclaimDataDirs({
      parent: root,
      ttlMs: 6 * HOUR_MS,
      ownerUid: 1004,
      readEntries: () => [
        { name: `${RUN_DIR_PREFIX}mine`, mtimeMs: Date.now() - 30 * DAY_MS, uid: 1004 },
        { name: `${RUN_DIR_PREFIX}theirs`, mtimeMs: Date.now() - 30 * DAY_MS, uid: 4242 },
        // No uid: an injected reader that cannot answer the ownership question. Treated as in scope,
        // because the caller has already decided these entries are the ones to weigh.
        { name: `${RUN_DIR_PREFIX}unknown`, mtimeMs: Date.now() - 30 * DAY_MS },
      ],
      remove: (target) => { removed.push(target); },
      now: Date.now,
    });
    assert.deepEqual(removed.map((target) => target.slice(target.lastIndexOf('/') + 1)).sort(), [
      `${RUN_DIR_PREFIX}mine`,
      `${RUN_DIR_PREFIX}unknown`,
    ]);
    assert.equal(report.foreign, 1);
    assert.equal(report.scanned, 3);
    assert.match(report.summary, /foreign-kept=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 the run-path sweep is budget-bounded, and says so when it stops early', () => {
  const root = makeScratchRoot();
  try {
    /** @type {string[]} */
    const removed = [];
    // A clock that advances 40 ms per reading: the budget is consulted once per entry, so the third
    // entry is where a 100 ms budget is crossed. Injected rather than waited for, so the case costs
    // nothing and asserts the exact stopping point. It starts from the real clock because the ages
    // the entries carry are real epoch milliseconds — a counter would sit so far in the past that
    // every entry would read as younger than the TTL.
    let clock = Date.now();
    const report = reclaimDataDirs({
      parent: root,
      ttlMs: 6 * HOUR_MS,
      budgetMs: 100,
      readEntries: () => Array.from({ length: 10 }, (_, index) => ({
        name: `${RUN_DIR_PREFIX}${index}`,
        mtimeMs: Date.now() - 30 * DAY_MS,
      })),
      remove: (target) => { removed.push(target); },
      now: () => { clock += 40; return clock; },
    });
    assert.equal(report.reclaimable, 10);
    assert.equal(report.stoppedEarly, true, 'a sweep that stopped with work left must say so');
    assert.equal(report.reclaimed, removed.length);
    assert.ok(report.reclaimed < 10, 'the whole point of the bound is that it is reached before the end');
    assert.ok(report.reclaimed >= 1, 'the bound must not stop the sweep before it has done anything');
    assert.match(report.summary, /stopped-early=true/);
    assert.match(report.summary, /remaining=[1-9]/);
    // The bound is a delay, not a count: the default is a duration in milliseconds.
    assert.ok(DEFAULT_RECLAIM_BUDGET_MS > 0 && DEFAULT_RECLAIM_BUDGET_MS <= 10_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 a removal that fails is recorded and the sweep carries on — housekeeping never ends a run', () => {
  const root = makeScratchRoot();
  try {
    /** @type {string[]} */
    const attempted = [];
    const report = reclaimDataDirs({
      parent: root,
      ttlMs: 6 * HOUR_MS,
      readEntries: () => ['a', 'b', 'c'].map((suffix) => ({
        name: `${RUN_DIR_PREFIX}${suffix}`,
        mtimeMs: Date.now() - 30 * DAY_MS,
      })),
      remove: (target) => {
        attempted.push(target);
        if (target.endsWith(`${RUN_DIR_PREFIX}b`)) throw new Error('EBUSY: directory is in use');
      },
      now: Date.now,
    });
    assert.deepEqual(attempted.length, 3, 'one failure must not abandon the entries after it');
    assert.equal(report.reclaimed, 2);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /could not be removed \(EBUSY/);
    assert.match(report.errors[0], /leaving it in place/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC4 old-run-dir-removed, fresh-dir-survives, non-run-dir-name-survives, excluded-dir-survives', () => {
  const root = makeScratchRoot();
  const exclusionParent = makeScratchRoot();
  try {
    const oldDir = join(root, `${RUN_DIR_PREFIX}OLD`);
    const freshDir = join(root, `${RUN_DIR_PREFIX}FRESH`);
    const foreignDir = join(root, 'notours');
    mkdirSync(oldDir);
    mkdirSync(freshDir);
    mkdirSync(foreignDir);
    // A real file, so the byte reading is measured off the disk rather than asserted against a zero.
    writeFileSync(join(oldDir, 'auth.db'), 'x'.repeat(4096));
    backdate(oldDir, 30 * DAY_MS);
    backdate(foreignDir, 30 * DAY_MS);
    // `quay-e2e-FRESH` is the exclusion set, as the run path passes the directory it is using. It is
    // young as well, so its survival is doubly expected here — the load-bearing half of that rule
    // (over-age *and* excluded) is AC1's `never-selects-the-excluded-current-dir`.
    const report = reclaimDataDirs({
      parent: root,
      ttlMs: 6 * HOUR_MS,
      exclude: [freshDir],
      measureBytes: dirSizeBytes,
      now: Date.now,
    });

    const oldRunDirRemoved = !existsSync(oldDir);
    const freshDirSurvives = existsSync(freshDir);
    const nonRunDirNameSurvives = existsSync(foreignDir);
    const excludedDirSurvives = existsSync(freshDir) && !report.reclaimedNames.includes(`${RUN_DIR_PREFIX}FRESH`);
    console.log(
      `[e2e] retention-fixture: old-run-dir-removed=${oldRunDirRemoved} fresh-dir-survives=${freshDirSurvives}`
        + ` non-run-dir-name-survives=${nonRunDirNameSurvives} excluded-dir-survives=${excludedDirSurvives}`,
    );

    assert.equal(oldRunDirRemoved, true, 'an over-age run directory is the thing this module exists to remove');
    assert.equal(freshDirSurvives, true);
    assert.equal(nonRunDirNameSurvives, true, 'this is not "empty the parent"');
    assert.equal(excludedDirSurvives, true);
    assert.equal(report.reclaimed, 1, 'exactly the one over-age run directory is removed');
    assert.deepEqual(report.reclaimedNames, [`${RUN_DIR_PREFIX}OLD`]);
    assert.ok((report.bytesReclaimed ?? 0) >= 4096, `the byte reading must see the file it removed, got ${String(report.bytesReclaimed)}`);

    // The load-bearing half, on its own fixture: an over-age directory in the exclusion set survives
    // a sweep that would otherwise have taken it. Without this, `excluded-dir-survives` above is
    // satisfied by the directory merely being young.
    const excludedOld = join(exclusionParent, `${RUN_DIR_PREFIX}CURRENT`);
    mkdirSync(excludedOld);
    backdate(excludedOld, 30 * DAY_MS);
    const excludedReport = reclaimDataDirs({
      parent: exclusionParent,
      ttlMs: 6 * HOUR_MS,
      exclude: [excludedOld],
      now: Date.now,
    });
    assert.equal(existsSync(excludedOld), true, 'the directory this run is using must survive its own sweep');
    assert.equal(excludedReport.reclaimable, 0);
    assert.equal(excludedReport.scanned, 1, 'it was considered, not skipped by never being read');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(exclusionParent, { recursive: true, force: true });
  }
});

test('AC2/AC4 the manual entry sweeps the parents it is given, reports them, and exits 0', () => {
  const root = makeScratchRoot();
  try {
    const oldDir = join(root, `${RUN_DIR_PREFIX}OLD`);
    const freshDir = join(root, `${RUN_DIR_PREFIX}FRESH`);
    mkdirSync(oldDir);
    mkdirSync(freshDir);
    writeFileSync(join(oldDir, 'auth.db'), 'y'.repeat(2048));
    backdate(oldDir, 30 * DAY_MS);

    /** @type {string[]} */
    const lines = [];
    const code = runRetentionCli(['--parent', root], { env: { [RETENTION_TTL_HOURS_ENV]: '6' }, log: (line) => lines.push(line) });

    assert.equal(code, 0, 'housekeeping must not be able to fail a caller');
    const joined = lines.join('\n');
    assert.ok(joined.includes(`parent=${root}`), 'the summary names the parent it swept');
    assert.match(joined, /ttl-ms=21600000/);
    assert.match(joined, /reclaimable=1 reclaimed=1/);
    assert.match(joined, /bytes-reclaimed=2048/);
    assert.match(joined, /\[e2e\] retention: total parents=1 reclaimed=1 bytes-reclaimed=2048/);
    assert.equal(existsSync(oldDir), false);
    assert.equal(existsSync(freshDir), true);

    // `--dry-run` is the same decision read without the removal: the counts are a projection and the
    // disk is untouched, which is what makes it usable for reading the default TTL against a backlog.
    const dryDir = join(root, `${RUN_DIR_PREFIX}DRY`);
    mkdirSync(dryDir);
    backdate(dryDir, 30 * DAY_MS);
    lines.length = 0;
    const dryCode = runRetentionCli(['--parent', root, '--dry-run'], { env: {}, log: (line) => lines.push(line) });
    assert.equal(dryCode, 0);
    assert.match(lines.join('\n'), /reclaimable=1 reclaimed=0 .*dry-run=true/);
    assert.equal(existsSync(dryDir), true, 'a dry run must remove nothing');

    // An unreadable TTL reclaims nothing and says which value it could not read, rather than
    // applying the default to a caller who asked for something else.
    lines.length = 0;
    runRetentionCli(['--parent', root], { env: { [RETENTION_TTL_HOURS_ENV]: '0' }, log: (line) => lines.push(line) });
    assert.match(lines.join('\n'), /ttl-ms=none/);
    assert.match(lines.join('\n'), /reclaimable=0/);
    assert.equal(existsSync(dryDir), true);

    // A typo'd flag is named rather than ignored: sweeping the default list instead would be a
    // silently widened sweep.
    lines.length = 0;
    const typo = runRetentionCli(['--parents', root], { env: {}, log: (line) => lines.push(line) });
    assert.equal(typo, 0);
    assert.match(lines.join('\n'), /unknown argument: --parents/);
    assert.equal(existsSync(dryDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2/AC5 the default parents are the selector’s candidates, existing ones only', () => {
  const root = makeScratchRoot();
  try {
    const cache = join(root, '.cache', 'quay-e2e-tmp');
    mkdirSync(cache, { recursive: true });
    // The cache candidate exists and `osTmpdir` (also `root`) exists; a third candidate that does not
    // exist must be dropped rather than listed into.
    const withTmpdir = defaultRetentionParents({ env: { TMPDIR: join(root, 'absent') }, home: root, osTmpdir: root });
    assert.deepEqual(withTmpdir, [cache, root], 'a candidate that is not there has nothing to reclaim');
    assert.deepEqual(defaultRetentionParents({ env: {}, home: root, osTmpdir: root }), [cache, root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Appended by gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim. The imports above
// are pinned (no-deleted-lines control), so the new names arrive in a second statement.
import {
  COMPLETED_MIN_AGE_MS,
  INTERRUPTED_MIN_AGE_MS,
  COMPLETED_TTL_MINUTES_ENV,
  INTERRUPTED_TTL_MINUTES_ENV,
  completedTtlMsFromEnv,
  interruptedTtlMsFromEnv,
  reclaimForHeadroom,
} from './e2e-data-dir-retention.mjs';

const MINUTE_MS = 60_000;

test('AC3 completed runs are reclaimable after 15 minutes, interrupted ones only after 60', () => {
  const entries = [
    { name: `${RUN_DIR_PREFIX}completed-at`, mtimeMs: NOW - COMPLETED_MIN_AGE_MS, completed: true },
    { name: `${RUN_DIR_PREFIX}completed-young`, mtimeMs: NOW - 5 * MINUTE_MS, completed: true },
    { name: `${RUN_DIR_PREFIX}interrupted-at`, mtimeMs: NOW - INTERRUPTED_MIN_AGE_MS, completed: false },
    { name: `${RUN_DIR_PREFIX}interrupted-young`, mtimeMs: NOW - 20 * MINUTE_MS, completed: false },
  ];
  const { reclaimable, kept } = selectReclaimableDirs({
    entries,
    ttlMs: null,
    completedTtlMs: COMPLETED_MIN_AGE_MS,
    interruptedTtlMs: INTERRUPTED_MIN_AGE_MS,
    now: NOW,
  });
  // The boundary is strict (`>`): exactly at the class TTL is already reclaimable.
  assert.deepEqual(
    reclaimable.map((candidate) => candidate.name),
    [`${RUN_DIR_PREFIX}completed-at`, `${RUN_DIR_PREFIX}interrupted-at`],
  );
  assert.deepEqual(
    kept.map((candidate) => candidate.name),
    [`${RUN_DIR_PREFIX}completed-young`, `${RUN_DIR_PREFIX}interrupted-young`],
  );
  // The interrupted bound's derivation, asserted rather than restated: six times the largest
  // criterion timeout (600_000 ms) is the smallest value that cannot still contain a live run.
  assert.ok(
    INTERRUPTED_MIN_AGE_MS >= 6 * 600_000,
    `interrupted TTL ${INTERRUPTED_MIN_AGE_MS} ms is not safely above the longest criterion`,
  );
  assert.ok(COMPLETED_MIN_AGE_MS < INTERRUPTED_MIN_AGE_MS, 'a finished run must be reclaimable sooner than a possibly-live one');
});

test('AC3 the current run is excluded from both classes, even when far past either TTL', () => {
  const current = `${RUN_DIR_PREFIX}CURRENT`;
  for (const completed of [true, false]) {
    const { reclaimable, kept } = selectReclaimableDirs({
      entries: [{ name: current, mtimeMs: NOW - 30 * DAY_MS, completed }],
      ttlMs: null,
      completedTtlMs: COMPLETED_MIN_AGE_MS,
      interruptedTtlMs: INTERRUPTED_MIN_AGE_MS,
      exclude: [current],
      now: NOW,
    });
    assert.deepEqual(reclaimable, [], `completed=${completed} must not let the exclusion through`);
    assert.deepEqual(kept.map((candidate) => candidate.name), [current], 'it was considered and kept');
  }
});

test('AC3 both class TTLs are readings the environment can move, and an unreadable one reclaims nothing', () => {
  assert.equal(completedTtlMsFromEnv({}), COMPLETED_MIN_AGE_MS);
  assert.equal(interruptedTtlMsFromEnv({}), INTERRUPTED_MIN_AGE_MS);
  assert.equal(completedTtlMsFromEnv({ [COMPLETED_TTL_MINUTES_ENV]: '1' }), MINUTE_MS);
  assert.equal(interruptedTtlMsFromEnv({ [INTERRUPTED_TTL_MINUTES_ENV]: '2' }), 2 * MINUTE_MS);
  for (const raw of ['0', '-1', 'abc', 'NaN', 'Infinity']) {
    assert.equal(completedTtlMsFromEnv({ [COMPLETED_TTL_MINUTES_ENV]: raw }), null, `completed ${raw} is not a bound`);
    assert.equal(interruptedTtlMsFromEnv({ [INTERRUPTED_TTL_MINUTES_ENV]: raw }), null, `interrupted ${raw} is not a bound`);
  }

  // The real reader's classification on real directories: an interrupted 20-minute-old directory is
  // kept, while a *completed* directory of the same age is reclaimable. Without the `.last-run.json`
  // marker this split cannot be reached, which is why the fixture writes one.
  const root = makeScratchRoot();
  try {
    const completedOld = join(root, `${RUN_DIR_PREFIX}COMPLETED`);
    const interruptedYoung = join(root, `${RUN_DIR_PREFIX}INTERRUPTED-YOUNG`);
    const interruptedOld = join(root, `${RUN_DIR_PREFIX}INTERRUPTED-OLD`);
    for (const dir of [completedOld, interruptedYoung, interruptedOld]) mkdirSync(dir);
    mkdirSync(join(completedOld, 'test-results'));
    writeFileSync(join(completedOld, 'test-results', '.last-run.json'), '{"status":"passed"}');
    backdate(completedOld, 20 * MINUTE_MS);
    backdate(interruptedYoung, 20 * MINUTE_MS);
    backdate(interruptedOld, 61 * MINUTE_MS);
    const report = reclaimDataDirs({ parent: root, env: {}, now: Date.now });
    assert.deepEqual(
      report.reclaimedNames.sort(),
      [`${RUN_DIR_PREFIX}COMPLETED`, `${RUN_DIR_PREFIX}INTERRUPTED-OLD`].sort(),
      'a finished 20-minute-old run is reclaimable; an interrupted one of the same age is not',
    );
    assert.equal(existsSync(interruptedYoung), true, 'the possibly-live run directory survives');
    assert.equal(report.completed, 1);
    assert.equal(report.interrupted, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC4 a below-floor headroom reclaims oldest-first until the floor is reached', () => {
  const MIB = 1024 * 1024;
  let headroom = 1 * 1024 * MIB;
  /** @type {string[]} */
  const removed = [];
  const report = reclaimForHeadroom({
    parent: '/fixture/parent',
    floorBytes: 3 * 1024 * MIB,
    completedTtlMs: COMPLETED_MIN_AGE_MS,
    interruptedTtlMs: INTERRUPTED_MIN_AGE_MS,
    budgetMs: Number.POSITIVE_INFINITY,
    // Five interrupted entries, all past the 60-minute class TTL, deliberately listed newest-first so
    // "oldest first" is the module's ordering rather than the reader's.
    readEntries: () => [
      { name: `${RUN_DIR_PREFIX}age-70`, mtimeMs: Date.now() - 70 * MINUTE_MS },
      { name: `${RUN_DIR_PREFIX}age-150`, mtimeMs: Date.now() - 150 * MINUTE_MS },
      { name: `${RUN_DIR_PREFIX}age-90`, mtimeMs: Date.now() - 90 * MINUTE_MS },
      { name: `${RUN_DIR_PREFIX}age-120`, mtimeMs: Date.now() - 120 * MINUTE_MS },
      { name: `${RUN_DIR_PREFIX}age-10`, mtimeMs: Date.now() - 10 * MINUTE_MS },
    ],
    headroomBytes: () => headroom,
    remove: (target) => {
      removed.push(target.slice(target.lastIndexOf('/') + 1));
      headroom += 1024 * MIB; // one GiB freed per directory, so the floor is reached after two
    },
    now: Date.now,
  });
  assert.deepEqual(removed, [`${RUN_DIR_PREFIX}age-150`, `${RUN_DIR_PREFIX}age-120`], 'oldest first, stopping at the floor');
  assert.equal(report.headroomBefore, 1 * 1024 * MIB);
  assert.equal(report.headroomAfter, 3 * 1024 * MIB);
  assert.equal(report.floorMet, true);
  assert.equal(report.exhausted, false);
  assert.equal(report.budgetReached, false);
  assert.equal(report.eligible, 4, 'the 10-minute-old interrupted directory is not eligible at all');
  // The reading that makes the arm falsifiable: with the candidates exhausted and the floor unmet,
  // the report says so instead of silently accepting the shortfall.
  headroom = 0;
  const exhausted = reclaimForHeadroom({
    parent: '/fixture/parent',
    floorBytes: 3 * 1024 * MIB,
    completedTtlMs: COMPLETED_MIN_AGE_MS,
    interruptedTtlMs: INTERRUPTED_MIN_AGE_MS,
    budgetMs: Number.POSITIVE_INFINITY,
    readEntries: () => [{ name: `${RUN_DIR_PREFIX}only`, mtimeMs: Date.now() - 90 * MINUTE_MS }],
    headroomBytes: () => headroom,
    remove: () => {},
    now: Date.now,
  });
  assert.equal(exhausted.reclaimed, 1);
  assert.equal(exhausted.floorMet, false);
  assert.equal(exhausted.exhausted, true);
  assert.match(exhausted.summary, /exhausted=true/);
});

test('AC4 the run-path budget still bounds the sweep and reports budgetReached', () => {
  /** @type {string[]} */
  const removed = [];
  let clock = Date.now();
  const report = reclaimForHeadroom({
    parent: '/fixture/parent',
    floorBytes: 1024 * 1024 * 1024,
    completedTtlMs: COMPLETED_MIN_AGE_MS,
    interruptedTtlMs: INTERRUPTED_MIN_AGE_MS,
    budgetMs: 100,
    readEntries: () => Array.from({ length: 10 }, (_, index) => ({
      name: `${RUN_DIR_PREFIX}${index}`,
      mtimeMs: Date.now() - (90 + index) * MINUTE_MS,
    })),
    // A headroom that never improves keeps the sweep going until the budget stops it.
    headroomBytes: () => 0,
    remove: (target) => { removed.push(target); },
    now: () => { clock += 40; return clock; },
  });
  assert.equal(report.budgetReached, true, 'a sweep stopped by its budget must say so');
  assert.equal(report.exhausted, false, 'a budget stop is not candidate exhaustion');
  assert.ok(report.reclaimed < 10, 'the budget is reached before the end');
  assert.ok(report.reclaimed >= 1, 'the budget must not stop the sweep before it has done anything');
  assert.match(report.summary, /budget-reached=true/);
});

test('AC4 a healthy headroom does not delete beyond the age rule', () => {
  /** @type {string[]} */
  const removed = [];
  const report = reclaimForHeadroom({
    parent: '/fixture/parent',
    floorBytes: 1024 * 1024 * 1024,
    completedTtlMs: COMPLETED_MIN_AGE_MS,
    interruptedTtlMs: INTERRUPTED_MIN_AGE_MS,
    budgetMs: Number.POSITIVE_INFINITY,
    readEntries: () => [
      { name: `${RUN_DIR_PREFIX}old-interrupted`, mtimeMs: Date.now() - 90 * MINUTE_MS },
      { name: `${RUN_DIR_PREFIX}young-interrupted`, mtimeMs: Date.now() - 10 * MINUTE_MS },
    ],
    // Ten GiB free against a one GiB floor: healthy, so nothing outside the age rule may be touched.
    headroomBytes: () => 10 * 1024 * 1024 * 1024,
    remove: (target) => { removed.push(target.slice(target.lastIndexOf('/') + 1)); },
    now: Date.now,
  });
  assert.deepEqual(removed, [`${RUN_DIR_PREFIX}old-interrupted`], 'the ordinary age sweep still runs');
  assert.equal(report.floorMet, true, 'the reading was healthy from the start');
  assert.equal(report.exhausted, false);
  assert.ok(!removed.includes(`${RUN_DIR_PREFIX}young-interrupted`), 'a possibly-live run is never traded for headroom');
});
