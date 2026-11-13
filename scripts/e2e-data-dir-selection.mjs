#!/usr/bin/env node
/**
 * Where an e2e run puts the throwaway directory it persists into, and when it refuses to pick one.
 *
 * THE DEFECT THIS EXISTS FOR. `playwright.config.ts` used to take its data directory from
 * `fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'))` unconditionally. `os.tmpdir()` reads `TMPDIR`,
 * and the driver's own environment does not set it — so on this host every run landed in `/tmp`, on
 * the root filesystem, whatever its remaining space happened to be. A run needs roughly 106 MiB
 * (vite cache, traces, audio, the sqlite auth database) and the root filesystem here has been
 * observed at 362 MiB free, so the run either fit or did not. When it did not, the failure surfaced
 * *inside* a test case as `ENOSPC: no space left on device, write` or
 * `net::ERR_INSUFFICIENT_RESOURCES` — reported against the thing the case was measuring, which is an
 * application defect as far as a reader of that line can tell. The ledger for AC-122 on 2026-09-25
 * is exactly that shape: `fail` at 08:23:20Z (`ENOSPC`), three consecutive `pass` at 08:24:51Z /
 * 08:27:57Z / 08:31:05Z, then `fail` again at 08:35:00Z (`ERR_INSUFFICIENT_RESOURCES`), with none of
 * the three failures reaching an assertion of the criterion.
 *
 * WHAT IS READ, AND WHEN. The choice is made *at the moment it is made*, from the filesystem in
 * front of it, and a candidate is usable only if it can really hold the run. "Really hold" is the
 * user's remaining *writable* headroom, not the filesystem's size: on this host `/data` is XFS with
 * `usrquota`, and `statfs` reported 1739 GiB `bavail` while `xfs_quota` showed 0.49 GiB left under
 * the hard limit — a run then wrote into an exhausted quota (`EDQUOT`, errno -122) and a green
 * criterion was reported red by a truncated trace. So the reading is quota-first
 * (`xfs_quota -c 'quota -u <uid>' <mount>`, non-root readable here) and falls back to `statfs(2)`
 * only when no quota answer exists, naming which reading it used on the `[e2e]` line. The floor is a
 * reading too, not a constant buried in here — `QUAY_E2E_DATA_DIR_MIN_FREE_MB` overrides it, which
 * is what makes "no candidate is big enough" reachable without root and without standing up a small
 * filesystem.
 *
 * WHAT IS NOT DONE. No candidate that fails the floor is ever silently accepted, and "nothing
 * qualifies" is not a fallback to `os.tmpdir()`: it ends the run before it starts, naming the
 * shortfall per candidate. Recycling the directories an earlier run left behind is deliberately not
 * this module's job (a run that cannot start is the condition worth failing on; housekeeping is a
 * separate concern), and neither is choosing a location by host: the invariant is "this filesystem
 * has room", not "the data lives under /data".
 *
 * The three numbers a run prints about its own choice — the selected data directory, that
 * filesystem's available bytes, and the floor applied — are on one `[e2e]` line, and the reading
 * that answered for them is named on the line beside it, so an outside reader can check the run
 * against `df` or `xfs_quota` instead of taking its word for it.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statfsSync, writeSync } from 'node:fs';
import { homedir as osHomedir, tmpdir as osTmpdirPath } from 'node:os';
import { dirname, join } from 'node:path';

/** Names the data directory outright, bypassing selection. Its presence also marks a re-evaluating worker rather than the run's owner. */
export const DATA_DIR_ENV = 'QUAY_E2E_DATA_DIR';

/**
 * Raises or lowers the free-space floor, in MiB.
 *
 * Deliberately a superstring of `DATA_DIR_ENV` rather than a name of its own family: it is the floor
 * *for this run's data directory*, and the address of that concept is the data directory's own name.
 * The two are never told apart by substring, only by exact key, so the containment is not a hazard
 * here — reading the value out of an environment object cannot confuse the two.
 */
export const MIN_FREE_MB_ENV = 'QUAY_E2E_DATA_DIR_MIN_FREE_MB';

/**
 * The floor used when `MIN_FREE_MB_ENV` is unset: 1 GiB.
 *
 * Derived from what a run really writes rather than picked for roundness. A full run measures ~106
 * MiB of data directory, and the run shares the volume with the checkout's `node_modules`, the
 * browser download and whatever else is on it, so the floor is ~10x the observed need. That places
 * it on the right side of both readings this host actually produced: the root filesystem's 362-499
 * MiB is *not* enough, and the 4 TB volume is. A tighter floor would accept a filesystem that a
 * single concurrent run could still fill; a looser one would refuse machines whose only sin is
 * being small.
 */
export const DEFAULT_MIN_FREE_MB = 1024;

/** Bytes in one MiB, spelled once so the floor's arithmetic has a single home. */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * The two readings `readWritableHeadroom` can answer with.
 *
 * Printed on the `[e2e]` line rather than kept private: a reader checking the run against `df`/`xfs_quota`
 * has to know *which* number the run was bounded by. `xfs-quota` is the user's own remaining hard-limit
 * headroom; `statfs` is the filesystem's `bavail`, the fallback that is blind to a quota.
 */
export const HEADROOM_SOURCE_QUOTA = 'xfs-quota';
export const HEADROOM_SOURCE_STATFS = 'statfs';

/**
 * Where the kernel lists the mount table, and the bound on asking `xfs_quota` a question.
 *
 * `/proc/self/mounts` is read rather than `df`, because the answer needs the *mount point* of the
 * candidate (that is the argument `xfs_quota` takes) and no subprocess is needed to get it. The
 * timeout exists so a wedged quota tool cannot stall config evaluation: a reading that does not
 * arrive withholds the quota answer, it does not hold the run.
 */
export const MOUNT_TABLE_PATH = '/proc/self/mounts';
export const QUOTA_READ_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} CandidateReading
 * @property {string} path The candidate as considered.
 * @property {number | null} availableBytes Bytes available on that candidate's filesystem, or null when it could not be read.
 * @property {boolean} ok Whether that candidate cleared the floor.
 * @property {string} [source] Which reading answered — see `HEADROOM_SOURCE_QUOTA` / `HEADROOM_SOURCE_STATFS`.
 */

/**
 * @typedef {object} SelectionAccepted
 * @property {true} ok
 * @property {string} parent The candidate that was accepted, as the parent to create the run's directory under.
 * @property {number} availableBytes Bytes available on the accepted filesystem.
 * @property {number} minFreeBytes The floor the choice was made against.
 * @property {string | null} source Which reading answered for the accepted candidate.
 * @property {boolean} reclaimed True when the accepted candidate was swept and re-read before being accepted.
 * @property {CandidateReading[]} readings Every candidate considered, in order, up to and including the accepted one.
 */

/**
 * @typedef {object} SelectionRefused
 * @property {false} ok
 * @property {string} reason The refusal, already worded for a human reading a red run.
 * @property {number} minFreeBytes The floor the choice was made against.
 * @property {CandidateReading[]} readings Every candidate considered, each with the bytes it had.
 */

/**
 * Available bytes on the filesystem holding `target`, or null when none could be read.
 *
 * Walks up to the nearest existing ancestor rather than requiring `target` to exist: the candidate
 * list names directories this module may be about to create (`$HOME/.cache/quay-e2e-tmp`), and
 * creating a directory in order to ask whether its filesystem has room would make the reading
 * depend on the choice it is meant to inform. `statfs` is per-filesystem, so the answer is the same
 * for the candidate and for any ancestor on the same mount.
 *
 * @param {string} target
 * @returns {number | null}
 */
export const fsAvailableBytes = (target) => {
  let probe = target;
  for (;;) {
    try {
      const stats = statfsSync(probe);
      return stats.bavail * stats.bsize;
    } catch {
      const parent = dirname(probe);
      // `dirname('/')` is `'/'`: the filesystem root is as far up as this can go, and nothing above
      // it will statfs any better.
      if (parent === probe) return null;
      probe = parent;
    }
  }
};

/**
 * One line of the kernel mount table, as far as this module needs it.
 *
 * @typedef {object} MountReading
 * @property {string} path The mount point, unescaped.
 * @property {string} fstype The filesystem type from the third column.
 */

/**
 * The escape sequences `/proc/self/mounts` uses inside a field.
 *
 * Mount points may contain spaces and tabs, which the kernel writes as `\040` and `\011` rather than
 * quoting the field. A path compared without undoing them would never equal the real mount point.
 */
/** @type {[RegExp, string][]} */
const MOUNT_ESCAPES = [
  [/\\040/g, ' '],
  [/\\011/g, '\t'],
  [/\\012/g, '\n'],
  [/\\134/g, '\\'],
];

/**
 * Parses `/proc/self/mounts` into the readings `mountFor` needs.
 *
 * Sixth field of a mount table line is the mount point, third is the filesystem type. Blank lines are
 * skipped rather than treated as malformed: the procfs file ends with one.
 *
 * @param {string} text
 * @returns {MountReading[]}
 */
export const parseMountTable = (text) => {
  /** @type {MountReading[]} */
  const readings = [];
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split(' ');
    if (fields.length < 3) continue;
    let mountPath = fields[1];
    for (const [pattern, replacement] of MOUNT_ESCAPES) mountPath = mountPath.replace(pattern, replacement);
    readings.push({ path: mountPath, fstype: fields[2] });
  }
  return readings;
};

/**
 * The mount a path lives on: the longest mount point that is a path-prefix of `target`.
 *
 * Longest and not first, because mounts nest — `/data` and `/data/home` can both exist, and the
 * inner one is the filesystem a quota answer would belong to. The comparison is on a path boundary,
 * so `/dataset` is not inside `/data`.
 *
 * @param {string} target
 * @param {MountReading[]} mounts
 * @returns {MountReading | null}
 */
export const mountFor = (target, mounts) => {
  /** @type {MountReading | null} */
  let best = null;
  for (const mount of mounts) {
    const inside = mount.path === '/' || target === mount.path || target.startsWith(`${mount.path}/`);
    if (!inside) continue;
    if (best === null || mount.path.length > best.path.length) best = mount;
  }
  return best;
};

/**
 * The headroom, in bytes, from one `xfs_quota -c 'quota -u <uid>' <mount>` output.
 *
 * The ledger's first three numeric columns are blocks used, soft quota and hard limit, in 1 KiB
 * blocks; the headroom reported is hard-limit minus used, which is the number a write is actually
 * refused against (`EDQUOT`, errno -122). A filesystem that reports no hard limit (`Limit` 0), no
 * numbers at all, or single quotes that do not parse is *not* a zero headroom — it is an unavailable
 * reading, and `null` says so rather than letting the caller read it as "full".
 *
 * The mount point is matched by suffix rather than by column position: the tail of the line is
 * `Warn/Time` followed by the mount point, and the time column itself is omitted or written as
 * `[6 days]`, so the fixed columns do not line up across hosts.
 *
 * @param {string} output
 * @param {{ mountPath?: string }} [options]
 * @returns {number | null}
 */
export const parseXfsQuotaHeadroom = (output, options = {}) => {
  const wanted = options.mountPath;
  for (const rawLine of String(output).split('\n')) {
    // Used, soft quota, hard limit, then the variable-width `Warn/Time` and mount point.
    const match = rawLine.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const tail = match[4].trimEnd();
    const mountedOn = tail.includes(']')
      ? tail.slice(tail.lastIndexOf(']') + 1).trim()
      : tail.replace(/^\S+\s*/, '').trim();
    if (wanted !== undefined && mountedOn !== wanted) continue;
    const blocks = Number(match[1]);
    const limit = Number(match[3]);
    if (!Number.isFinite(blocks) || !Number.isFinite(limit) || limit <= 0) continue;
    // Blocks are KiB units in every `xfs_quota` report; the floor at zero is because a user can be
    // *over* the hard limit (the ledger counts allocated blocks, not a clamped allowance).
    return Math.max(0, (limit - blocks) * 1024);
  }
  return null;
};

/**
 * The invoking user's remaining hard-quota headroom on `target`'s filesystem, or null.
 *
 * The defect this closes: `statfs` reported 1739 GiB `bavail` on `/data` while the user's XFS quota
 * had 0.49 GiB left, so a 1 GiB floor never fired and a run started writing into an exhausted
 * quota. This reading is the one that can see that. It is only meaningful on XFS with `usrquota`
 * enabled and a readable ledger; every other shape — a non-XFS mount, `xfs_quota` absent, a uid the
 * platform does not have, a ledger with no limit — answers null, and the caller falls back openly.
 *
 * @param {string} target
 * @param {{
 *   uid?: number | null,
 *   mountTable?: MountReading[],
 *   readMounts?: () => string,
 *   execFile?: (file: string, args: string[], options: object) => string | Buffer,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {number | null}
 */
export const readQuotaHeadroom = (target, options = {}) => {
  const uid = options.uid !== undefined
    ? options.uid
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (uid === null) return null;

  /** @type {MountReading[]} */
  let mounts;
  if (options.mountTable !== undefined) {
    mounts = options.mountTable;
  } else {
    try {
      const readMounts = options.readMounts ?? (() => String(readFileSync(MOUNT_TABLE_PATH, 'utf8')));
      mounts = parseMountTable(readMounts());
    } catch {
      return null;
    }
  }

  const mount = mountFor(target, mounts);
  if (mount === null) return null;

  const exec = options.execFile ?? ((file, args, execOptions) => execFileSync(file, args, /** @type {any} */ (execOptions)));
  /** @type {string} */
  let output;
  try {
    output = String(exec(
      'xfs_quota',
      ['-c', `quota -u ${uid}`, mount.path],
      { encoding: 'utf8', timeout: options.timeoutMs ?? QUOTA_READ_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    ));
  } catch {
    // Not installed, not permitted, not XFS: all the same reading for this decision.
    return null;
  }
  return parseXfsQuotaHeadroom(output, { mountPath: mount.path });
};

/**
 * The writable headroom for `target`, quota-first and statfs-fallback, with its source named.
 *
 * @param {string} target
 * @param {{
 *   readQuotaHeadroom?: (target: string) => number | null,
 *   statfsAvailable?: (target: string) => number | null,
 * } & Parameters<typeof readQuotaHeadroom>[1]} [options]
 * @returns {{ availableBytes: number | null, source: string | null }}
 */
export const readWritableHeadroom = (target, options = {}) => {
  /** @type {number | null} */
  let quota = null;
  try {
    quota = options.readQuotaHeadroom !== undefined
      ? options.readQuotaHeadroom(target)
      : readQuotaHeadroom(target, options);
  } catch {
    quota = null;
  }
  if (quota !== null) return { availableBytes: quota, source: HEADROOM_SOURCE_QUOTA };

  const statfsAvailable = options.statfsAvailable ?? fsAvailableBytes;
  /** @type {number | null} */
  let statfsBytes = null;
  try {
    statfsBytes = statfsAvailable(target);
  } catch {
    statfsBytes = null;
  }
  return { availableBytes: statfsBytes, source: statfsBytes === null ? null : HEADROOM_SOURCE_STATFS };
};

/**
 * The directories a run may put its data directory under, most specific first.
 *
 * `TMPDIR` comes first because a caller who set it has said where scratch space is; the cache
 * directory under `$HOME` comes second because it is the only candidate on a volume that is not the
 * system one; `os.tmpdir()` comes last so that the historical location is still reachable — and so
 * that a host whose `/tmp` is genuinely roomy behaves as it always did.
 *
 * Duplicates are dropped rather than deduplicated by hand at the call site: `os.tmpdir()` reads
 * `TMPDIR`, so a run with `TMPDIR` set would otherwise consider the same directory twice and report
 * the same shortfall twice.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, osTmpdir?: string }} [options]
 * @returns {string[]}
 */
export const dataDirCandidates = (options = {}) => {
  const env = options.env ?? process.env;
  const home = options.home ?? osHomedir();
  const legacy = options.osTmpdir ?? osTmpdirPath();
  /** @type {string[]} */
  const candidates = [];
  for (const candidate of [env.TMPDIR, join(home, '.cache', 'quay-e2e-tmp'), legacy]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    if (candidates.includes(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates;
};

/**
 * The refusal text: the floor, then one line per candidate saying what that candidate actually had.
 *
 * Per candidate and not aggregated, because the actionable question a reader has is "was one of
 * them close, or is every candidate on this machine small" — a single total would answer neither.
 * A candidate whose bytes could not be read says so instead of printing a zero, since a zero would
 * be indistinguishable from a genuinely full filesystem.
 *
 * @param {number} minFreeBytes
 * @param {CandidateReading[]} readings
 * @returns {string}
 */
const describeShortfall = (minFreeBytes, readings) => {
  const lines = readings.map((reading) => {
    const source = reading.source === undefined ? '' : ` (headroom-source=${reading.source})`;
    if (reading.availableBytes === null) {
      return `[e2e]   candidate ${reading.path}: filesystem could not be read, so it cannot be shown to hold ${minFreeBytes} bytes${source}`;
    }
    return `[e2e]   candidate ${reading.path}: ${reading.availableBytes} bytes available, shortfall ${minFreeBytes - reading.availableBytes} bytes${source}`;
  });
  return [
    `[e2e] refusing to start the run: insufficient free space for the e2e data directory — no candidate filesystem holds the required ${minFreeBytes} bytes.`,
    ...lines,
    '[e2e] the run is ending here, before any server or test starts, rather than failing later as an ENOSPC inside a case that is measuring something else.',
  ].join('\n');
};

/**
 * Picks the first candidate whose filesystem holds `minFreeBytes`, or reports why none does.
 *
 * The filesystem reading is injected (`availableBytes`) so that every branch of this decision is
 * reachable from a test without a small filesystem: a case can hand in a reader that answers with
 * numbers, and "no candidate qualifies" is then an input rather than an environment.
 *
 * @param {{
 *   candidates: string[],
 *   minFreeBytes: number,
 *   availableBytes?: (target: string) => number | null,
 *   read?: (target: string) => { availableBytes: number | null, source?: string | null } | null | undefined,
 *   reclaim?: (target: string) => void,
 * }} options
 * @returns {SelectionAccepted | SelectionRefused}
 */
export const selectDataDir = ({ candidates, minFreeBytes, availableBytes = fsAvailableBytes, read, reclaim }) => {
  /** @type {(target: string) => { availableBytes: number | null, source: string | null }} */
  const readOne = read === undefined
    ? (target) => {
        /** @type {number | null} */
        let bytes = null;
        try {
          bytes = availableBytes(target);
        } catch {
          // An injected reader that throws is a candidate whose filesystem could not be read, which
          // is the same reading `fsAvailableBytes` gives for a path no `statfs` reaches.
          bytes = null;
        }
        return { availableBytes: bytes, source: null };
      }
    : (target) => {
        /** @type {{ availableBytes: number | null, source?: string | null } | null | undefined} */
        let reading;
        try {
          reading = read(target);
        } catch {
          reading = null;
        }
        return {
          availableBytes: reading === null || reading === undefined ? null : (reading.availableBytes ?? null),
          source: reading === null || reading === undefined ? null : (reading.source ?? null),
        };
      };

  /** @type {CandidateReading[]} */
  const readings = [];
  for (const candidate of candidates) {
    let { availableBytes: available, source } = readOne(candidate);
    let reclaimed = false;
    // The quota arm: a candidate that is short gets one sweep and one *re-read*, and the decision is
    // made on the re-reading. This is the "sweep, re-read, then decide" order — without the second
    // read the sweep would have happened after the refusal, which is the state the 2026-11-13 defect
    // was found in. A reclaim callback that throws is housekeeping failing, not a reason to fail the
    // selection; the re-read simply reports the same shortfall and the candidate is refused.
    if (reclaim !== undefined && available !== null && available < minFreeBytes) {
      try {
        reclaim(candidate);
      } catch {
        // Ignored on purpose; see above.
      }
      ({ availableBytes: available, source } = readOne(candidate));
      reclaimed = true;
    }
    /** @type {CandidateReading} */
    const reading = { path: candidate, availableBytes: available, ok: false };
    if (source !== null) reading.source = source;
    // Tested on `available` itself rather than on a separate `ok` boolean: TypeScript narrows a
    // local across its own guard and not across a boolean derived from it, so the `availableBytes`
    // the accepted result carries is provably a number here.
    if (available !== null && available >= minFreeBytes) {
      reading.ok = true;
      readings.push(reading);
      return { ok: true, parent: candidate, availableBytes: available, minFreeBytes, source, reclaimed, readings };
    }
    readings.push(reading);
  }
  return { ok: false, reason: describeShortfall(minFreeBytes, readings), minFreeBytes, readings };
};

/**
 * The floor for this run, in bytes, from `MIN_FREE_MB_ENV` when it holds a positive number.
 *
 * A value that is present but unreadable is refused rather than defaulted: a caller who asked for a
 * floor and got `DEFAULT_MIN_FREE_MB` instead would be told the run was bounded when it was not, and
 * the only way to notice would be to read the printed number back. `null` means the floor could not
 * be established.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number | null}
 */
export const minFreeBytesFromEnv = (env) => {
  const raw = env[MIN_FREE_MB_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_FREE_MB * BYTES_PER_MIB;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed) * BYTES_PER_MIB;
};

/**
 * Where this run's data directory goes, printing the three numbers it was chosen by.
 *
 * `QUAY_E2E_DATA_DIR` short-circuits everything: a worker re-evaluating this config inherits the
 * directory the owner already picked, and re-deciding there would either move the run's data
 * mid-flight or refuse a run that is already under way. So an explicit value is honoured verbatim —
 * no floor is applied to it and nothing is printed — and the returned `explicit` flag is what tells
 * the caller it is not the owner.
 *
 * `fail` is injected rather than called directly so that this decision can be driven in a test. Its
 * default is the only place in this module that ends a process, and it writes synchronously: on a
 * pipe, `console.error` hands the line off asynchronously, so a message followed by an immediate
 * exit is a message that can be lost — and the refusal text is the whole product of the path.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   osTmpdir?: string,
 *   availableBytes?: (target: string) => number | null,
 *   read?: (target: string) => { availableBytes: number | null, source?: string | null } | null | undefined,
 *   reclaim?: (target: string) => void,
 *   makeTempDir?: (parent: string) => string,
 *   log?: (line: string) => void,
 *   fail?: (message: string) => never,
 * }} [options]
 * @returns {{ dataDir: string, explicit: boolean, availableBytes: number | null, minFreeBytes: number | null, source: string | null, reclaimed: boolean }}
 */
export const resolveE2eDataDir = (options = {}) => {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.log(line));
  // Typed as `never` rather than left to inference: a block-bodied arrow whose last statement is
  // `process.exit(1)` still infers `void`, and a `void` here would stop the caller's control-flow
  // analysis from knowing that nothing after a refusal runs — the refusal path would then read as
  // "maybe we carry on and use a half-decided candidate".
  /** @type {(message: string) => never} */
  const fail = options.fail ?? ((message) => {
    writeSync(2, `${message}\n`);
    process.exit(1);
  });
  const makeTempDir = options.makeTempDir ?? ((parent) => mkdtempSync(join(parent, 'quay-e2e-')));

  const declared = env[DATA_DIR_ENV];
  if (typeof declared === 'string' && declared.trim() !== '') {
    return { dataDir: declared, explicit: true, availableBytes: null, minFreeBytes: null, source: null, reclaimed: false };
  }

  const minFreeBytes = minFreeBytesFromEnv(env);
  if (minFreeBytes === null) {
    fail(
      `[e2e] refusing to start the run: ${MIN_FREE_MB_ENV}="${String(env[MIN_FREE_MB_ENV])}" is not a positive number of MiB, `
        + 'so the free-space floor could not be established. Refusing rather than silently applying the default, '
        + 'because the run would otherwise be bounded by a number nobody asked for.',
    );
  }

  // Injected `availableBytes` is the test seam the existing controls use; when neither it nor a
  // `read` is supplied, the real quota-first reading answers. The wrapper keeps one code path for
  // both without making the injected readers silently lose to the default.
  const read = options.read
    ?? (options.availableBytes !== undefined
      ? (target) => ({ availableBytes: /** @type {(target: string) => number | null} */ (options.availableBytes)(target), source: null })
      : readWritableHeadroom);

  const selection = selectDataDir({
    candidates: dataDirCandidates({ env, home: options.home, osTmpdir: options.osTmpdir }),
    minFreeBytes,
    read,
    reclaim: options.reclaim,
  });
  if (!selection.ok) fail(selection.reason);

  // Only now, for the accepted candidate alone: a directory is created when it is about to be used,
  // not while it is still being weighed.
  mkdirSync(selection.parent, { recursive: true });
  const dataDir = makeTempDir(selection.parent);
  log(
    `[e2e] data-dir=${dataDir} free-bytes=${selection.availableBytes} min-free-bytes=${selection.minFreeBytes}`
      + ` (candidate ${selection.parent})`,
  );
  // A second line, and only when the reading has a source to name: the line above is a pinned,
  // parseable token sequence, so the provenance of `free-bytes` is stated beside it rather than
  // spliced into it. An injected reader (`availableBytes`) has no source and prints nothing, which
  // keeps the controls that assert "exactly one line" honest.
  if (selection.source !== null) {
    log(
      `[e2e] headroom-source=${selection.source} free-bytes=${selection.availableBytes}`
        + ` min-free-bytes=${selection.minFreeBytes} (candidate ${selection.parent})`,
    );
  }
  return {
    dataDir,
    explicit: false,
    availableBytes: selection.availableBytes,
    minFreeBytes: selection.minFreeBytes,
    source: selection.source,
    reclaimed: selection.reclaimed,
  };
};
