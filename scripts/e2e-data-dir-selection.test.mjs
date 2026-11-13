#!/usr/bin/env node
/**
 * The controls for `scripts/e2e-data-dir-selection.mjs` — the module `playwright.config.ts` asks where
 * its data directory goes.
 *
 * WHY THESE CASES EXIST. The defect this module fixes was invisible: a run that did not fit on the
 * root filesystem failed *inside* a case as `ENOSPC` / `net::ERR_INSUFFICIENT_RESOURCES`, which reads
 * as the case's subject being broken. Each case below is therefore aimed at one half of what has to
 * hold for the failure to be legible instead:
 *
 *   AC3(a) a candidate with room is chosen          — and the choice's own three numbers are printed
 *   AC3(b) no candidate with room ⇒ a refusal       — never a fallback to the same full filesystem
 *   AC3    an unreadable candidate is skipped       — and is not silently read as "zero bytes free"
 *   AC3    the floor is the environment's, not a constant — raised, it refuses a candidate that fits
 *   AC3    the floor is never silently defaulted    — a floor that cannot be read is itself a refusal
 *   AC3(b) the refusal really ends the process      — read as a child's exit code, not as a call log
 *   AC3    `QUAY_E2E_DATA_DIR` is honoured verbatim — a worker must not re-decide a run already under way
 *
 * THE READINGS, NOT THE PROMISES. Nothing here asserts that a message "says" a refusal happened. The
 * process-level case runs the real default failure path in a child process and reads its exit status
 * and its two streams; the printing case reads the tokens a run leaves for an outside `df`; and the
 * "skipped" cases assert that the short candidate was *consulted* and recorded, so "skipped" cannot
 * be satisfied by a module that never looked at it ([[anti-fake-variant-passes-means-criterion-hole]]
 * in the inverse: a green case has to be unreachable without the behaviour).
 *
 * THE FILESYSTEM READING IS INJECTED in every case but the last, so that "no candidate has room" is
 * an input rather than an environment: the criterion this backs (AC3) has to be falsifiable without
 * root and without standing up a small filesystem, and that property belongs to the tests too.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DATA_DIR_ENV,
  DEFAULT_MIN_FREE_MB,
  MIN_FREE_MB_ENV,
  dataDirCandidates,
  fsAvailableBytes,
  resolveE2eDataDir,
  selectDataDir,
} from './e2e-data-dir-selection.mjs';

const MIB = 1024 * 1024;
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./e2e-data-dir-selection.mjs', import.meta.url))).href;

/**
 * A filesystem reader built from a table, which records every candidate it was asked about.
 *
 * The record matters as much as the answer: "the short candidate was skipped" is only a reading if
 * something shows it was reached, and a module that ignored its candidate list entirely would
 * otherwise satisfy every "was not chosen" assertion here.
 *
 * @param {Record<string, number | null>} bytesByPath
 * @returns {{ availableBytes: (target: string) => number | null, asked: string[] }}
 */
const readerFrom = (bytesByPath) => {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    availableBytes: (target) => {
      asked.push(target);
      return Object.prototype.hasOwnProperty.call(bytesByPath, target) ? bytesByPath[target] : null;
    },
  };
};

/**
 * A `fail` that records the message and throws, so a case can assert on the refusal text without
 * ending the test process. Its inferred return type is `never` (the body is a single `throw`), which
 * is what the module's parameter type requires.
 *
 * @returns {{ failed: string[], fail: (message: string) => never }}
 */
const recorder = () => {
  /** @type {string[]} */
  const failed = [];
  return {
    failed,
    fail: (message) => {
      failed.push(message);
      throw new Error(message);
    },
  };
};

/**
 * Run `body`, and return the message the injected `fail` was called with — failing if it was not.
 *
 * The injected `fail` throws, so the module's refusal path is read through a caught exception rather
 * than through a returned value: that is the same shape the real `fail` has (it does not return), and
 * a case that let the throw escape would report the module's message as an unhandled error instead of
 * checking it. The `assert.fail` after the call is what stops "no refusal happened" from passing as
 * "the refusal was fine".
 *
 * @param {(fail: (message: string) => never) => void} body
 * @returns {string}
 */
const refusalOf = (body) => {
  const { failed, fail } = recorder();
  try {
    body(fail);
  } catch (error) {
    assert.equal(failed.length, 1, 'the refusal path must call `fail` exactly once');
    assert.equal(/** @type {Error} */ (error).message, failed[0]);
    return failed[0];
  }
  return assert.fail('the refusal path did not call `fail`, so nothing refused');
};

/**
 * A real directory to stand in for a candidate, with a real filesystem behind it.
 *
 * A candidate only has to *name* a path for the injected readers, but the cases that create a
 * directory under the accepted candidate need one that exists, and reading `statfs` off a genuine
 * path is what the last case is for.
 */
const makeScratchRoot = () => mkdtempSync(join(tmpdir(), 'e2e-data-dir-selection-test-'));

test('AC3(a) the first candidate with room is chosen, and every candidate before it is recorded as short', () => {
  const { availableBytes, asked } = readerFrom({ '/candidate/one': 10 * MIB, '/candidate/two': 400 * MIB });
  const selection = selectDataDir({ candidates: ['/candidate/one', '/candidate/two'], minFreeBytes: 100 * MIB, availableBytes });

  assert.equal(selection.ok, true);
  assert.equal(selection.parent, '/candidate/two');
  assert.equal(selection.availableBytes, 400 * MIB);
  assert.equal(selection.minFreeBytes, 100 * MIB);
  // The short candidate was consulted and its reading kept — this is the half that stops "skipped"
  // from being satisfied by "never looked at".
  assert.deepEqual(asked, ['/candidate/one', '/candidate/two']);
  assert.deepEqual(selection.readings, [
    { path: '/candidate/one', availableBytes: 10 * MIB, ok: false },
    { path: '/candidate/two', availableBytes: 400 * MIB, ok: true },
  ]);
});

test('AC3(a) the reading is a floor, not a preference: a candidate exactly at the floor is accepted', () => {
  const { availableBytes } = readerFrom({ '/exactly': 100 * MIB });
  const selection = selectDataDir({ candidates: ['/exactly'], minFreeBytes: 100 * MIB, availableBytes });
  assert.equal(selection.ok, true, 'a filesystem holding exactly the floor holds enough');
  assert.equal(selection.parent, '/exactly');
});

test('AC3(b) no candidate with room ⇒ a refusal naming the floor and each candidate’s own shortfall', () => {
  const { availableBytes, asked } = readerFrom({ '/small/a': 300 * MIB, '/small/b': 900 * MIB });
  const selection = selectDataDir({ candidates: ['/small/a', '/small/b'], minFreeBytes: 1024 * MIB, availableBytes });

  assert.equal(selection.ok, false);
  assert.deepEqual(asked, ['/small/a', '/small/b'], 'a refusal considers every candidate, not the first');
  assert.equal(selection.minFreeBytes, 1024 * MIB);
  assert.equal(selection.readings.length, 2);
  assert.ok(selection.readings.every((reading) => reading.ok === false));
  // The gap is named per candidate, with the arithmetic done: a reader asking "was one of them close,
  // or is every filesystem on this machine small" gets both halves from this line.
  assert.match(selection.reason, /insufficient free space/);
  assert.match(selection.reason, /no candidate filesystem holds the required 1073741824 bytes/);
  assert.match(selection.reason, /\/small\/a: 314572800 bytes available, shortfall 759169024 bytes/);
  assert.match(selection.reason, /\/small\/b: 943718400 bytes available, shortfall 130023424 bytes/);
});

test('AC3 an unreadable candidate is skipped, and the refusal says so instead of printing a zero', () => {
  const { availableBytes } = readerFrom({ '/readable': 2048 * MIB, '/unreadable': null });
  const skipped = selectDataDir({ candidates: ['/unreadable', '/readable'], minFreeBytes: 1024 * MIB, availableBytes });
  assert.equal(skipped.ok, true, 'a candidate that cannot be read is not a candidate that has room');
  assert.equal(skipped.parent, '/readable');
  assert.equal(skipped.readings[0].availableBytes, null, 'the unreadable candidate keeps its null reading');

  const onlyUnreadable = selectDataDir({ candidates: ['/unreadable'], minFreeBytes: 1024 * MIB, availableBytes: () => null });
  assert.equal(onlyUnreadable.ok, false);
  assert.match(onlyUnreadable.reason, /\/unreadable: filesystem could not be read/);
  assert.doesNotMatch(onlyUnreadable.reason, /\/unreadable: 0 bytes/, 'an unreadable filesystem is not an empty one');
});

test('AC3 a reader that throws is the same reading as one that answers null — the candidate is skipped', () => {
  const { availableBytes } = readerFrom({ '/readable': 2048 * MIB });
  const selection = selectDataDir({
    candidates: ['/throws', '/readable'],
    minFreeBytes: 1024 * MIB,
    availableBytes: (target) => {
      if (target === '/throws') throw new Error('EACCES');
      return availableBytes(target);
    },
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.parent, '/readable');
  assert.equal(selection.readings[0].availableBytes, null);
});

test('AC3(b) the floor is the environment’s: a candidate that fits the default is refused by a raised one', () => {
  const { availableBytes, asked } = readerFrom({ '/roomy': 2048 * MIB });

  const accepted = selectDataDir({ candidates: ['/roomy'], minFreeBytes: DEFAULT_MIN_FREE_MB * MIB, availableBytes });
  assert.equal(accepted.ok, true, 'the default floor must leave a 2 GiB filesystem usable');

  const refused = selectDataDir({ candidates: ['/roomy'], minFreeBytes: 4096 * MIB, availableBytes });
  assert.equal(refused.ok, false, 'the same candidate, one input later, must be refused');
  assert.equal(asked.length, 2, 'both readings consulted the same candidate');
});

test('AC3 the default floor sits between the reading that was not enough and the one that was', () => {
  // The number is derived, not round: this host's root filesystem measured 362-499 MiB free (not
  // enough) and its data volume 3.6 TiB (plenty). The bounds below are what makes the default a
  // reading of those two rather than a value that happens to work here — a floor under 256 MiB would
  // have accepted the full filesystem, and one over 8 GiB would refuse disks that are merely small.
  assert.ok(DEFAULT_MIN_FREE_MB >= 256, `default floor ${DEFAULT_MIN_FREE_MB} MiB would accept a filesystem this host measured as too small`);
  assert.ok(DEFAULT_MIN_FREE_MB <= 8192, `default floor ${DEFAULT_MIN_FREE_MB} MiB would refuse a perfectly usable small disk`);
  const { availableBytes } = readerFrom({ '/full-root': 499 * MIB, '/data-volume': 3_600_000 * MIB });
  const floor = DEFAULT_MIN_FREE_MB * MIB;
  assert.equal(selectDataDir({ candidates: ['/full-root'], minFreeBytes: floor, availableBytes }).ok, false);
  assert.equal(selectDataDir({ candidates: ['/data-volume'], minFreeBytes: floor, availableBytes }).ok, true);
});

test('AC3 the floor that cannot be read is a refusal, never a silent fall back to the default', () => {
  for (const unreadable of ['abc', '0', '-1', 'NaN']) {
    const message = refusalOf((fail) => {
      resolveE2eDataDir({ env: { [MIN_FREE_MB_ENV]: unreadable }, fail });
    });
    assert.match(message, /insufficient free space|free-space floor could not be established/);
    assert.match(message, new RegExp(`${MIN_FREE_MB_ENV}="${unreadable}"`), 'the refusal names the value it could not read');
  }
});

test('AC3(b) a refusal uses the environment’s floor and names the candidates it read', () => {
  const message = refusalOf((fail) => {
    resolveE2eDataDir({
      env: { [MIN_FREE_MB_ENV]: '10000000' },
      home: '/home/someone',
      osTmpdir: '/tmp',
      availableBytes: () => 1024,
      fail,
    });
  });
  assert.match(message, /insufficient free space/);
  assert.match(message, /candidate \/home\/someone\/\.cache\/quay-e2e-tmp: 1024 bytes available/);
  assert.match(message, /candidate \/tmp: 1024 bytes available/);
});

test('AC3(a) an accepted choice prints the data directory, its filesystem’s bytes, and the floor', () => {
  const root = makeScratchRoot();
  try {
    /** @type {string[]} */
    const lines = [];
    // The parent the module actually created the run's directory under, recorded rather than inferred
    // from `dataDir`: a path that happens to be right could also be reached by not choosing at all.
    let chosenParent = '';
    const resolved = resolveE2eDataDir({
      env: { QUAY_E2E_DATA_DIR_MIN_FREE_MB: '1' },
      home: root,
      osTmpdir: root,
      availableBytes: () => 4 * 1024 * MIB,
      makeTempDir: (parent) => {
        chosenParent = parent;
        return join(parent, 'quay-e2e-fixed');
      },
      log: (line) => lines.push(line),
    });

    const accepted = join(root, '.cache', 'quay-e2e-tmp');
    assert.equal(chosenParent, accepted, 'the first candidate with room is the one used');
    assert.equal(resolved.dataDir, join(accepted, 'quay-e2e-fixed'));
    assert.equal(resolved.explicit, false);
    assert.equal(resolved.availableBytes, 4 * 1024 * MIB);
    assert.equal(resolved.minFreeBytes, 1 * MIB);
    assert.equal(lines.length, 1, 'the three numbers are one line, so a reader can parse them');
    // Read back as tokens rather than as a sentence: this is the line an outside `df` is checked against.
    assert.match(lines[0], /^\[e2e\] data-dir=\S+ free-bytes=4294967296 min-free-bytes=1048576 \(candidate \S+\)$/);
    assert.ok(lines[0].includes(`data-dir=${resolved.dataDir}`), 'the printed directory is the one the run will use');
    assert.ok(lines[0].includes(`(candidate ${accepted})`), 'the printed line names the candidate it chose');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC3 the candidate order is TMPDIR, the home cache, then the historical tmpdir — without duplicates', () => {
  assert.deepEqual(
    dataDirCandidates({ env: { TMPDIR: '/scratch' }, home: '/home/someone', osTmpdir: '/tmp' }),
    ['/scratch', '/home/someone/.cache/quay-e2e-tmp', '/tmp'],
  );
  // `os.tmpdir()` reads TMPDIR, so an un-deduplicated list would report the same shortfall twice for
  // this shape — which is the one the driver's own environment produces when TMPDIR is set.
  assert.deepEqual(
    dataDirCandidates({ env: { TMPDIR: '/tmp' }, home: '/home/someone', osTmpdir: '/tmp' }),
    ['/tmp', '/home/someone/.cache/quay-e2e-tmp'],
  );
  assert.deepEqual(
    dataDirCandidates({ env: {}, home: '/home/someone', osTmpdir: '/tmp' }),
    ['/home/someone/.cache/quay-e2e-tmp', '/tmp'],
  );
  assert.deepEqual(
    dataDirCandidates({ env: { TMPDIR: '   ' }, home: '/home/someone', osTmpdir: '/tmp' }),
    ['/home/someone/.cache/quay-e2e-tmp', '/tmp'],
    'a blank TMPDIR is not a location',
  );
});

test('AC3(b) the real threshold is `>=`: a candidate one byte short of the floor is refused', () => {
  const floor = 1024 * MIB;
  const { availableBytes } = readerFrom({ '/one-short': floor - 1, '/exact': floor });
  assert.equal(selectDataDir({ candidates: ['/one-short'], minFreeBytes: floor, availableBytes }).ok, false);
  assert.equal(selectDataDir({ candidates: ['/exact'], minFreeBytes: floor, availableBytes }).ok, true);
});

test('AC3(b) an explicit data directory is honoured verbatim, with an unraisable floor present', () => {
  /** @type {string[]} */
  const lines = [];
  const resolved = resolveE2eDataDir({
    env: { [DATA_DIR_ENV]: '/explicitly/named', [MIN_FREE_MB_ENV]: '10000000' },
    home: '/home/someone',
    osTmpdir: '/tmp',
    // A reader that would refuse everything: if the floor were applied to the explicit value, this
    // case could not reach the return below. That is what makes this case a control and not a
    // restatement of the default.
    availableBytes: () => 1024,
    log: (line) => lines.push(line),
    fail: (message) => {
      throw new Error(`must not refuse an explicit data directory: ${message}`);
    },
  });
  assert.equal(resolved.dataDir, '/explicitly/named');
  assert.equal(resolved.explicit, true, 'a worker re-evaluating the config is not the owner');
  assert.deepEqual(lines, [], 'the owner already printed the run’s numbers; a worker must not print a second set');
});

test('AC3(b) the refusal ends the process non-zero — read as a child’s exit status, not as a call log', () => {
  const root = makeScratchRoot();
  try {
    // The child drives the module's own default failure path: no injected `fail`, so the reading is
    // the real `writeSync(2, …)` plus `process.exit(1)` that AC3(b)'s command depends on. The reader
    // answers 32 GiB, so the only thing that decides which arm refuses is the floor.
    /**
     * @param {string} floor
     * @returns {import('node:child_process').SpawnSyncReturns<string>}
     */
    const run = (floor) => spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(MODULE_URL)}).then(({ resolveE2eDataDir }) => {
  const resolved = resolveE2eDataDir({
    env: { QUAY_E2E_DATA_DIR_MIN_FREE_MB: ${JSON.stringify(floor)} },
    home: ${JSON.stringify(root)},
    osTmpdir: ${JSON.stringify(root)},
    availableBytes: () => 34359738368,
  });
  process.stdout.write('REACHED-AFTER-CHOOSING ' + resolved.dataDir + '\\n');
});`,
      ],
      { encoding: 'utf8' },
    );

    const refused = run('1000000');
    assert.notEqual(refused.status, 0, 'an unraisable floor must end the process non-zero');
    assert.match(refused.stderr, /insufficient free space/);
    assert.match(refused.stderr, /required \d+ bytes/);
    assert.ok(!refused.stdout.includes('REACHED-AFTER-CHOOSING'), 'nothing after the refusal may run');

    // The positive control, with the same child and the same reader: only the floor moved. Without
    // it, "it exited non-zero" would be satisfied by a child that never ran at all.
    const accepted = run('1024');
    assert.equal(accepted.status, 0, `a satisfiable floor must not end the process: ${accepted.stderr}`);
    assert.ok(accepted.stdout.includes('REACHED-AFTER-CHOOSING'), 'the accepted path must be reached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A reading that a case has just asserted is a number of bytes.
 *
 * `fsAvailableBytes` answers `null` for a filesystem it cannot reach, so every case that wants the
 * number has to narrow first; doing it here keeps the assertion and the narrowing in one place
 * instead of a cast at each call site.
 *
 * @param {number | null} value
 * @returns {number}
 */
const asBytes = (value) => {
  assert.equal(typeof value, 'number', `expected a byte reading, got ${String(value)}`);
  return /** @type {number} */ (value);
};

/**
 * Whether two live readings of one filesystem agree, to within the tolerance a busy host needs.
 *
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
const near = (left, right) => Math.abs(left - right) / right < 0.01;

test('AC3 the real filesystem reader answers its filesystem’s bytes, and walks up to find them', () => {
  const root = makeScratchRoot();
  try {
    const direct = asBytes(fsAvailableBytes(root));
    assert.ok(direct > 0, 'a directory that exists on a writable filesystem has room');

    // A candidate the module may be about to create: the answer is its filesystem's, found by walking
    // up to the nearest existing ancestor.
    //
    // Compared with a tolerance and not exactly, because these are two LIVE readings of a volume other
    // runs on this host are writing to: the same path can legitimately answer differently a
    // millisecond later, so an exact comparison would be a race rather than a control. A walk that
    // landed on a different filesystem — or on nothing — could not stay within 1%.
    const walked = asBytes(fsAvailableBytes(join(root, 'not', 'created', 'yet')));
    assert.ok(near(walked, direct), `${walked} and ${direct} are the same filesystem`);

    // The walk terminates at the filesystem root instead of looping: above `/` there is nothing left
    // to statfs, and the root of a mount always answers, so an absolute path never comes back null.
    assert.ok(near(asBytes(fsAvailableBytes('/definitely/not/here')), asBytes(fsAvailableBytes('/'))), 'an unreachable path resolves to /');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Appended by gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim. The import above is
// untouched (its lines are pinned by the task's no-deleted-lines control); these names arrive in a
// second statement so the quota-headroom controls can be added without editing a line.
import {
  HEADROOM_SOURCE_QUOTA,
  HEADROOM_SOURCE_STATFS,
  parseMountTable,
  mountFor,
  parseXfsQuotaHeadroom,
  readWritableHeadroom,
} from './e2e-data-dir-selection.mjs';

test('AC1 quota-headroom-below-floor: the refusal names the headroom, the floor and the shortfall in bytes', () => {
  // The real defect's shape: 0.49 GiB of quota headroom against a 1 GiB floor. `statfs` says 1739 GiB
  // on the same filesystem, so a case that only ever moved a statfs number could not reach this.
  const headroomBytes = 515852 * 1024;
  const floorBytes = 1024 * MIB;
  const message = refusalOf((fail) => {
    resolveE2eDataDir({
      env: { [MIN_FREE_MB_ENV]: '1024' },
      home: '/home/someone',
      osTmpdir: '/tmp',
      read: () => ({ availableBytes: headroomBytes, source: HEADROOM_SOURCE_QUOTA }),
      fail,
    });
  });
  assert.match(message, /required 1073741824 bytes/, 'the floor is named in the header, in bytes');
  assert.match(
    message,
    new RegExp(`candidate /home/someone/\\.cache/quay-e2e-tmp: ${headroomBytes} bytes available, shortfall ${floorBytes - headroomBytes} bytes`),
    'the headroom and the gap are both named, with the arithmetic done',
  );
  assert.match(message, /headroom-source=xfs-quota/, 'the reading the refusal was made against is named');
});

test('AC1 quota-headroom-above-floor: a quota reading over the floor is accepted and its source is printed', () => {
  const root = makeScratchRoot();
  try {
    /** @type {string[]} */
    const lines = [];
    const acceptedBytes = 2 * 1024 * MIB;
    const resolved = resolveE2eDataDir({
      env: { [MIN_FREE_MB_ENV]: '1024' },
      home: root,
      osTmpdir: root,
      // The same filesystem `statfs` would over-report: only the quota reading is below the floor.
      read: () => ({ availableBytes: acceptedBytes, source: HEADROOM_SOURCE_QUOTA }),
      makeTempDir: (parent) => join(parent, 'quay-e2e-fixed'),
      log: (line) => lines.push(line),
    });
    assert.equal(resolved.explicit, false);
    assert.equal(resolved.availableBytes, acceptedBytes);
    assert.equal(resolved.source, HEADROOM_SOURCE_QUOTA);
    // The `[e2e]` line has to say which number bounded the run, not just what the number was.
    assert.ok(
      lines.some((line) => line.includes(`headroom-source=${HEADROOM_SOURCE_QUOTA}`) && line.includes(`free-bytes=${acceptedBytes}`)),
      `expected a headroom-source line naming the quota reading, got: ${lines.join(' | ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 quota-reading-unavailable-falls-back: statfs answers, and the [e2e] line says so', () => {
  const root = makeScratchRoot();
  try {
    /** @type {string[]} */
    const lines = [];
    const fallbackBytes = 3 * 1024 * MIB;
    const resolved = resolveE2eDataDir({
      env: { [MIN_FREE_MB_ENV]: '1024' },
      home: root,
      osTmpdir: root,
      // No quota ledger for this filesystem: the reading must fall back rather than refuse or accept
      // a zero it never measured.
      read: (target) => readWritableHeadroom(target, {
        readQuotaHeadroom: () => null,
        statfsAvailable: () => fallbackBytes,
      }),
      makeTempDir: (parent) => join(parent, 'quay-e2e-fixed'),
      log: (line) => lines.push(line),
    });
    assert.equal(resolved.availableBytes, fallbackBytes);
    assert.equal(resolved.source, HEADROOM_SOURCE_STATFS);
    assert.ok(
      lines.some((line) => line.includes(`headroom-source=${HEADROOM_SOURCE_STATFS}`)),
      `the fallback has to be visible on the [e2e] line, got: ${lines.join(' | ')}`,
    );
    // A filesystem that could not be read at all has no source to name — it must not be reported as
    // a statfs reading of zero.
    const unreadable = readWritableHeadroom('/nowhere', {
      readQuotaHeadroom: () => null,
      statfsAvailable: () => null,
    });
    assert.deepEqual(unreadable, { availableBytes: null, source: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 the XFS ledger is read as hard-limit minus blocks, and an absent limit is unavailable, not zero', () => {
  // The real shape measured on this host on 2026-11-13; trailing `[6 days]` grace makes the mount
  // point the fourth-of-five fields, which is why it is matched rather than counted.
  const ledger = [
    'Disk quotas for User yale (1004)',
    'Filesystem              Blocks      Quota      Limit  Warn/Time      Mounted on',
    '/dev/vdb             523772148  471859200  524288000   00  [6 days] /data',
    '',
  ].join('\n');
  assert.equal(parseXfsQuotaHeadroom(ledger, { mountPath: '/data' }), (524288000 - 523772148) * 1024);
  assert.equal(parseXfsQuotaHeadroom(ledger, { mountPath: '/elsewhere' }), null, 'another filesystem is not this one');
  assert.equal(parseXfsQuotaHeadroom('/dev/vdb 100 50 0 00 /data\n', { mountPath: '/data' }), null, 'no hard limit is not zero headroom');
  // The mount table side: the longest matching mount point wins and a path boundary is respected.
  const mounts = parseMountTable('/dev/vdb /data xfs rw 0 0\n/dev/vdb /data/home xfs rw 0 0\n/dev/vda2 / ext4 rw 0 0\n');
  assert.equal(mountFor('/data/home/yale/.cache', mounts)?.path, '/data/home');
  assert.equal(mountFor('/dataset', mounts)?.path, '/');
});

test('AC4 a short candidate is swept and re-read before the decision; a healthy one is not swept at all', () => {
  /** @type {string[]} */
  const order = [];
  /** @type {Record<string, number>} */
  const readings = { '/short': 100 * MIB, '/roomy': 2048 * MIB };
  const selection = selectDataDir({
    candidates: ['/short'],
    minFreeBytes: 1024 * MIB,
    read: (target) => {
      order.push(`read:${target}`);
      return { availableBytes: readings[target], source: HEADROOM_SOURCE_QUOTA };
    },
    reclaim: (target) => {
      order.push(`reclaim:${target}`);
      // The sweep frees room; the very next reading is what the decision is made on.
      readings[target] = 2048 * MIB;
    },
  });
  assert.deepEqual(order, ['read:/short', 'reclaim:/short', 'read:/short'], 'sweep, re-read, then decide');
  assert.equal(selection.ok, true);
  assert.equal(selection.reclaimed, true);
  assert.equal(selection.availableBytes, 2048 * MIB);

  // A candidate that already has room must not pay for a scan of a parent nothing will be written
  // into. Without this half, "the callback ran" would be satisfied by a sweep of every candidate.
  order.length = 0;
  const healthy = selectDataDir({
    candidates: ['/roomy'],
    minFreeBytes: 1024 * MIB,
    read: (target) => {
      order.push(`read:${target}`);
      return { availableBytes: readings[target], source: HEADROOM_SOURCE_QUOTA };
    },
    reclaim: (target) => { order.push(`reclaim:${target}`); },
  });
  assert.deepEqual(order, ['read:/roomy']);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.reclaimed, false);

  // A sweep that does not free enough leaves the candidate short: it is refused, and the refusal
  // names the reading taken *after* the sweep.
  order.length = 0;
  const stillShort = selectDataDir({
    candidates: ['/short'],
    minFreeBytes: 1024 * MIB,
    read: () => ({ availableBytes: 100 * MIB, source: HEADROOM_SOURCE_QUOTA }),
    reclaim: () => {},
  });
  assert.equal(stillShort.ok, false);
  assert.match(stillShort.reason, /candidate \/short: 104857600 bytes available, shortfall 968884224 bytes/);
});
