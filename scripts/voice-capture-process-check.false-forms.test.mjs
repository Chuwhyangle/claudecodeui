#!/usr/bin/env node
/**
 * The controls for `scripts/voice-capture-process-check.mjs` (AC-148's criterion; AC5 of
 * `gap-voice-capture-real-process`).
 *
 * The criterion reports that a REAL server process, started from a real `server/index.ts` under a
 * real `VOICE_CAPTURE`, writes a start-up line and a capture row to its stdout. A criterion that
 * says so and nothing more is worth exactly as much as the fakes it can tell apart from that
 * outcome — and the fake this one exists to catch is named in the task's DoD: "the capture only
 * holds inside a unit test's injected port and was never wired into the real service's assembly".
 * A tree in which the seam is never handed to `createVoiceService` boots perfectly and transcribes
 * perfectly; only the capture-row reading notices.
 *
 * So each case here is a PAIR, in this order:
 *
 *   1. the criterion runs against an unmutated throwaway tree and must exit 0;
 *   2. the SAME tree, with ONE textual change in `server/modules/voice/voice.module.ts`, runs again
 *      and must exit 1 — with the change of exactly one named reading, and with the other case's
 *      reading still green.
 *
 * The first half is what makes the second mean anything: without it, "it went red" could just as
 * well be "this tree never ran". The second half is read off the criterion's own printed readings
 * and its own `check.failure:` lines, not off the exit code alone, which is why each case asserts
 * three things about the mutant: its status is 1 (not 2, which the criterion reserves for "the
 * measurement could not be made"), the named reading is wrong, and the reading the OTHER case
 * reds is still right. Two mutations that both took the whole criterion down would satisfy
 * "red" and fail this.
 *
 * WHAT THE TWO MUTATIONS ARE, AND WHY THEY ARE SHAPED THIS WAY.
 *
 *   `assembly-not-wired` deletes the one place that hands the capture port to the service —
 *   `capture: createVoiceCapture({ ... }),`, whose argument object the audio tier later grew (AC-145
 *   added the `audio` sink), so the anchor below is the whole multi-line property. The port is
 *   optional, so the service still transcribes and the start-up line is still printed; only
 *   `capture.lines` moves, 1 → 0.
 *
 *   `startup-line-missing` deletes the one call that announces the mode. It is NOT a bare
 *   deletion: `voiceCapture` is read again eight lines later, so removing the statement outright
 *   makes the module throw at load, the child never prints `CloudCLI Server - Ready`, and the
 *   criterion exits 2 with no readings at all — a red that names nothing, which is the failure
 *   shape this AC is written against. The mutation therefore deletes the announcing call and
 *   inlines the single field the rest of the file reads, which is the smallest single-site change
 *   that removes the announcement and nothing else. `startup.text.count` moves, 1 → 0; the capture
 *   row is still recorded.
 *
 * WHERE THE MUTATIONS ARE APPLIED. Never to this checkout. Each case builds its own tree by
 * HARD-LINKING the repo (`cp -al`, the mechanism AC5 names — the criterion boots a real server out
 * of it, and 1 700 hard links cost milliseconds where a byte copy costs a second), points the
 * criterion at it with `--root`, and removes it when the case ends. The one file a case mutates is
 * REPLACED rather than written in place: under `cp -al` that path shares its inode with the
 * checkout's file, so an in-place write would edit the checkout through the link. `mutate` asserts
 * the checkout's copy is byte-identical after the substitution, which is the reading that says the
 * hard link was not written through.
 *
 * `.git` IS REMOVED FROM THE COPY, and that is a safety measure rather than tidiness. In a worktree
 * `.git` is not a directory but an 88-byte pointer file holding the absolute path of the real git
 * directory; hard-linked into the copy it is a live wire into this checkout's git state, so any git
 * command run from the copy would write into the real worktree's administrative files. In the
 * PRIMARY checkout `.git` is a plain directory, so the removal must say `recursive: true`: a
 * `force`-only `rmSync` on a directory throws `ERR_FS_EISDIR`, which is exactly how this control was
 * red in the primary checkout (and it then leaked the copy). The criterion needs no git — it boots a
 * server, mints a token and makes one HTTP request — so the wire is cut, in either shape.
 *
 * ONE READING IS TAKEN OUT OF THE PICTURE. `DATABASE_PATH` is deleted from the criterion's
 * environment for the two MUTATION cases above, so its `real-db-untouched` reading is trivially
 * true and the mutant's red is attributable to the named reading and nothing else. That reading is
 * about a file this control does not own — the deployer's live database, which this repository's own
 * running server writes to — and a case that reds because the operator's traffic happened to land
 * inside its window would be reporting on the host rather than on its mutation. The criterion
 * measures it, under the real inherited value, on its own runs.
 *
 * THE ATTRIBUTION CASES OWN A DATABASE ON PURPOSE. The two cases below (`real-db attribution` and
 * its negative control) point `DATABASE_PATH` at a database THIS control creates and HOLDS OPEN for
 * the whole run — the deployer's server, reproduced as a foreign holder that is not in the
 * criterion's process tree. That is the whole discriminator: the reading must be false only when
 * the criterion's OWN tree holds the file, so a foreign holder that writes once and then goes quiet
 * (the shape that used to red the criterion) has to stay green, and a child that inherits the
 * criterion's own `DATABASE_PATH` has to red with evidence naming the handle, not the clock.
 *
 * THE CHECKOUT IS READ BEFORE AND AFTER. AC5 asks that the worktree's `git status --porcelain` be
 * empty once the copies are gone. Every case asserts the invariant that makes that meaningful — no
 * TRACKED file in the checkout was modified, and no entry anywhere in the status names a file this
 * control can reach — and the full status is printed before and after so a reader can see it.
 *
 * The tracked half is the assertion rather than literal emptiness because the rest of this suite
 * writes into the tree while the tests run: measured here, a sibling script test creates and removes
 * `scripts/.probe-mutant-<random>/` about 55 s into a `npm run test:scripts` run. The copy is the
 * only thing this control can write to, and a write through a hard link lands on a TRACKED file —
 * so tracked-modification is exactly the harm, and a control that reds on another test's scratch
 * directory would be measuring the suite rather than itself.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * Where throwaway copies and controlled databases are built — BESIDE the checkout, never under
 * `os.tmpdir()`.
 *
 * `cp -al` needs hard links, hard links need one filesystem, and this host measures `/tmp` on
 * `/dev/vda2` while the checkout is on `/dev/vdb`, so a copy root under `/tmp` fails with
 * `Invalid cross-device link` on every entry. A sibling of the checkout is on the checkout's own
 * filesystem by construction — the same lesson the criterion's own `HARDENED_ROOT_PREFIX` carries.
 */
const SCRATCH_ROOT = dirname(REPO_ROOT);

const CRITERION_REL = join('scripts', 'voice-capture-process-check.mjs');
const MODULE_REL = join('server', 'modules', 'voice', 'voice.module.ts');

/** The criterion's own wall-clock budget is 45 s; this is the outer bound on one invocation. */
const CRITERION_TIMEOUT_MS = 120_000;

/**
 * How many times a run that exits 2 is re-attempted before a case gives up.
 *
 * `2` is the criterion's own "the measurement could not be made" — a port taken between the
 * reservation and the bind, say. That is not a verdict about the tree, so it is not read as one;
 * a run that reaches this bound fails the case with the criterion's own stderr in the message.
 */
const COULD_NOT_MEASURE_RETRIES = 2;

/** A prefix unique to this process, so a concurrent run in another worktree is not read as litter. */
const COPY_PREFIX = `voice-capture-false-forms-${process.pid}-`;

/** A prefix unique to this process for the controlled databases the attribution cases own. */
const CONTROLLED_DB_PREFIX = `voice-capture-real-db-${process.pid}-`;

/**
 * How long an attribution case waits for the criterion to spawn its first child before giving up.
 *
 * The child is the signal that the write can land inside the criterion's before/after window: it
 * appears only after the criterion has read the inherited database's `mtimeMs` once, and the second
 * read is still two real server boots away. A wall-clock delay would be a guess (a loaded host makes
 * the first boot take seconds); a child appearing is the criterion's own progress, read from
 * `/proc`, and it is already the thing an ownership scan watches.
 */
const CHILD_SIGNAL_TIMEOUT_MS = 30_000;

/** How often the wait above re-reads the criterion's children. */
const CHILD_SIGNAL_POLL_MS = 20;

/**
 * The one line the criterion uses to give a child the run's own database.
 *
 * The negative control deletes it, so the child then inherits whatever `DATABASE_PATH` the
 * criterion itself was started with — the leak AC-148 exists to exclude.
 */
const CRITERION_DB_ANCHOR = '  childEnv.DATABASE_PATH = options.databasePath;\n';

/**
 * AC-148's own readings, read off the criterion's stdout for the attribution cases.
 *
 * This is the invariant an attribution change must not disturb: whatever the real-database reading
 * is decided by, these eleven readings still have to come out exactly as AC-148 names them.
 */
const AC148_READINGS = {
  'startup.text.count': '1',
  'startup.text.line': 'voice.capture mode=text',
  'capture.lines': '1',
  'upstream.exact': 'true',
  'double.requests': '1',
  'double.path': '/audio/transcriptions',
  'http.status': '200',
  'unset.captureLines': '0',
  'unset.startup.line': 'voice.capture mode=off',
  'unset.double.requests': '1',
  'check.failures': '0',
};

/** The statement that resolves the mode AND announces it — the only announcement in the process. */
const ANNOUNCING_CALL =
  'const voiceCapture = announceVoiceCapture(process.env.VOICE_CAPTURE, voiceLog);';

/** What replaces it: the same resolution with the announcement gone, and nothing else changed. */
const NON_ANNOUNCING_MODE =
  "const voiceCapture = { mode: process.env.VOICE_CAPTURE === 'text' ? 'text' : 'off' };";

/**
 * The one place the capture port is handed to the service, identified by its HEAD.
 *
 * WHY NOT THE WHOLE VALUE. This anchor used to spell the property's entire multi-line body, and it
 * went stale as that body grew — the audio tier (AC-145) added an `audio` sink, and the salt/raw
 * tiers then added `instanceSalt` and `raw`, each with its own comment. A whole-value anchor matches
 * nothing once the interior changes, and a mutation that matches nothing leaves the tree green while
 * the case reports "red after mutation". So the property is found by the line that opens it and cut
 * to the line that closes it at the same indent, which deletes the property whatever its interior
 * holds — the drift that broke this case cannot recur.
 */
const CAPTURE_INJECTION_HEAD = '  capture: createVoiceCapture({';

/** The line that closes the property, at the property's own indent. */
const CAPTURE_INJECTION_TAIL = '\n  }),\n';

/**
 * Deletes the capture-injection property from the module's assembly.
 *
 * The count assertion is the same one `substituteOnce` makes, restated for a span whose length is
 * not known ahead of time: a head that matched nothing, or more than once, is reported here rather
 * than surfacing later as a tree that was never mutated.
 *
 * @param {string} source
 * @returns {string}
 */
function deleteCaptureInjection(source) {
  const sites = source.split(CAPTURE_INJECTION_HEAD).length - 1;
  assert.equal(
    sites,
    1,
    `delete the capture injection: the property occurs ${sites} times in ${MODULE_REL}, expected exactly 1 — ` +
      'the shipped assembly changed shape under this control',
  );
  const head = source.indexOf(CAPTURE_INJECTION_HEAD);
  const tail = source.indexOf(CAPTURE_INJECTION_TAIL, head);
  assert.ok(
    tail > head,
    `delete the capture injection: the property's closing line was not found in ${MODULE_REL}`,
  );
  return source.slice(0, head) + source.slice(tail + CAPTURE_INJECTION_TAIL.length);
}

/**
 * @typedef {object} Mutation
 * @property {string} name            printed as `mutation=<name>`
 * @property {string} reds            the reading this mutation must turn wrong
 * @property {string} keeps           the reading the other case reds, which must stay right
 * @property {string} redsValue       what `reds` must read after the mutation
 * @property {string} keepsValue      what `keeps` must read after the mutation
 * @property {(source: string) => string} apply
 */

/** @type {Mutation[]} */
const MUTATIONS = [
  {
    name: 'assembly-not-wired',
    reds: 'capture.lines',
    keeps: 'startup.text.count',
    redsValue: '0',
    keepsValue: '1',
    apply: (source) => deleteCaptureInjection(source),
  },
  {
    name: 'startup-line-missing',
    reds: 'startup.text.count',
    keeps: 'capture.lines',
    redsValue: '0',
    keepsValue: '1',
    apply: (source) => substituteOnce(source, ANNOUNCING_CALL, NON_ANNOUNCING_MODE, 'delete the announcement'),
  },
];

/**
 * Applies a one-site substitution, asserting the site count first.
 *
 * The count is not decoration: a mutation that matched nothing would leave the tree green while
 * the case reported "red after mutation", and a mutation that matched twice would be two changes
 * wearing one name. Both are read here rather than discovered as a confusing red later.
 *
 * @param {string} source
 * @param {string} needle
 * @param {string} replacement
 * @param {string} what
 * @returns {string}
 */
function substituteOnce(source, needle, replacement, what) {
  const sites = source.split(needle).length - 1;
  assert.equal(
    sites,
    1,
    `${what}: the mutation site occurs ${sites} times in ${MODULE_REL}, expected exactly 1 — ` +
      'the shipped assembly changed shape under this control',
  );
  return source.split(needle).join(replacement);
}

/**
 * The checkout's porcelain status.
 *
 * `trackedOnly` drops the untracked entries, which is what a case uses: see the header — the suite
 * itself creates scratch directories in the tree while these tests run.
 *
 * @param {boolean} [trackedOnly]
 * @returns {string} the status, trimmed — '' when there is nothing to report.
 */
function gitStatus(trackedOnly = false) {
  const args = ['-C', REPO_ROOT, 'status', '--porcelain'];
  if (trackedOnly) args.push('--untracked-files=no');
  const result = spawnSync('git', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `git status failed in ${REPO_ROOT}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The status entries a write from this control would have produced: a modified assembly, or anything
 * under a copy this control made. Empty is the reading.
 *
 * @param {string} status
 * @returns {string[]}
 */
function attributableEntries(status) {
  return status
    .split('\n')
    .filter((line) => line.includes(MODULE_REL) || line.includes(COPY_PREFIX));
}

/**
 * Hard-links the checkout into a throwaway tree and cuts the `.git` wire. See the header.
 *
 * `recursive: true` is the whole point: in the primary checkout `.git` is a directory, and
 * `rmSync` without it throws `ERR_FS_EISDIR` before the case has run (leaking the copy). In a
 * worktree `.git` is a pointer file, which the same call removes just as well.
 *
 * @returns {string} the copy's root
 */
function buildCopy() {
  const copyRoot = mkdtempSync(join(SCRATCH_ROOT, COPY_PREFIX));
  const copied = spawnSync('cp', ['-al', `${REPO_ROOT}/.`, copyRoot], { encoding: 'utf8' });
  assert.equal(copied.status, 0, `cp -al ${REPO_ROOT} failed: ${copied.stderr}`);
  rmSync(join(copyRoot, '.git'), { force: true, recursive: true });
  return copyRoot;
}

/**
 * Rewrites the assembly in the copy, replacing the file rather than editing it.
 *
 * @param {string} copyRoot
 * @param {Mutation} mutation
 */
function mutate(copyRoot, mutation) {
  const target = join(copyRoot, MODULE_REL);
  const pristine = readFileSync(target, 'utf8');
  const mutated = mutation.apply(pristine);
  assert.notEqual(mutated, pristine, `${mutation.name}: the mutation changed nothing`);

  // Replace, never edit in place: `cp -al` gave this path the checkout file's inode.
  rmSync(target);
  writeFileSync(target, mutated);

  assert.equal(
    readFileSync(join(REPO_ROOT, MODULE_REL), 'utf8'),
    pristine,
    `${mutation.name}: the mutation reached the checkout through the hard link`,
  );
}

/**
 * The environment every criterion invocation is given.
 *
 * `DATABASE_PATH` is DELETED, not set: the inherited database is not this control's to measure, and
 * leaving it in would let the deployer's traffic decide whether a mutation looks red. The
 * attribution cases below set it explicitly, to a database this control owns.
 *
 * @returns {Record<string, string>}
 */
function baseEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.FORCE_COLOR = '0';
  delete env.DATABASE_PATH;
  // Node treats a set NO_COLOR beside FORCE_COLOR as a contradiction and warns on every start;
  // FORCE_COLOR=0 is the instruction that has to win here, so the other one is removed.
  delete env.NO_COLOR;
  // The runner sets this for processes it starts; the criterion drives real servers of its own.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Runs the criterion against a copy, re-attempting only the "could not measure" exit.
 *
 * @param {string} copyRoot
 * @returns {{ status: number | null, stdout: string, stderr: string, attempts: number }}
 */
function runCriterion(copyRoot) {
  const env = baseEnv();

  let attempts = 0;
  /** @type {import('node:child_process').SpawnSyncReturns<string> | undefined} */
  let result;
  for (;;) {
    attempts += 1;
    result = spawnSync(process.execPath, [join(copyRoot, CRITERION_REL), '--root', copyRoot], {
      cwd: copyRoot,
      env,
      encoding: 'utf8',
      timeout: CRITERION_TIMEOUT_MS,
    });
    if (result.status !== 2 || attempts > COULD_NOT_MEASURE_RETRIES) break;
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    attempts,
  };
}

/**
 * @param {string} stdout
 * @returns {Map<string, string>} every `key=value` line the criterion printed
 */
function readReadings(stdout) {
  const readings = new Map();
  for (const line of stdout.split('\n')) {
    // Keys start lowercase but may carry uppercase inside (`unset.captureLines`), so the tail of the
    // pattern is case-insensitive — AC-148 names readings whose second segment is capitalised.
    const match = /^([a-z][a-zA-Z0-9.-]*)=(.*)$/.exec(line);
    if (match) readings.set(match[1], match[2]);
  }
  return readings;
}

/** @param {string} stdout @returns {string[]} the reasons, with the criterion's prefix stripped. */
function readFailures(stdout) {
  const prefix = 'check.failure: ';
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** @param {string} failure @param {string} key @returns {boolean} */
function namesReading(failure, key) {
  return failure.startsWith(`${key} `) || failure.startsWith(`${key}=`);
}

/** Read once, at load, so each case can compare against how the run found the checkout. */
const REPO_TRACKED_STATUS_AT_START = gitStatus(true);

for (const mutation of MUTATIONS) {
  test(`AC5 ${mutation.name}: green before the mutation, red on ${mutation.reds} after`, async () => {
    const copyRoot = buildCopy();
    try {
      const base = runCriterion(copyRoot);
      assert.equal(
        base.status,
        0,
        `${mutation.name}: the UNMUTATED copy exited ${base.status} (attempts=${base.attempts}) — ` +
          `without this half the mutant's red would prove nothing\nstdout:\n${base.stdout}\nstderr:\n${base.stderr}`,
      );

      mutate(copyRoot, mutation);
      const mutant = runCriterion(copyRoot);
      const readings = readReadings(mutant.stdout);
      const failures = readFailures(mutant.stdout);

      assert.equal(
        mutant.status,
        1,
        `${mutation.name}: the mutated copy exited ${mutant.status} (attempts=${mutant.attempts}), expected 1 — ` +
          `2 is the criterion's own "could not measure" and proves nothing about the mutation\n` +
          `stdout:\n${mutant.stdout}\nstderr:\n${mutant.stderr}`,
      );
      assert.equal(
        readings.get(mutation.reds),
        mutation.redsValue,
        `${mutation.name}: ${mutation.reds} reads ${String(readings.get(mutation.reds))}, expected ${mutation.redsValue}`,
      );
      assert.equal(
        readings.get(mutation.keeps),
        mutation.keepsValue,
        `${mutation.name}: ${mutation.keeps} reads ${String(readings.get(mutation.keeps))}, expected ` +
          `${mutation.keepsValue} — the two mutations must not mask each other`,
      );
      assert.ok(
        failures.some((failure) => namesReading(failure, mutation.reds)),
        `${mutation.name}: no check.failure names ${mutation.reds}; the criterion red for some other reason: ` +
          `${JSON.stringify(failures)}`,
      );
      assert.ok(
        !failures.some((failure) => namesReading(failure, mutation.keeps)),
        `${mutation.name}: ${mutation.keeps} was reported as wrong too, so the red is not attributable: ` +
          `${JSON.stringify(failures)}`,
      );

      process.stdout.write(
        `mutation=${mutation.name} baseExit=${base.status} mutantRed=${mutant.status === 1} ` +
          `whichReading=${mutation.reds}\n`,
      );
    } finally {
      rmSync(copyRoot, { recursive: true, force: true });
    }

    assert.equal(existsSync(copyRoot), false, `${mutation.name}: the throwaway copy survived the case`);
    assert.equal(
      gitStatus(true),
      REPO_TRACKED_STATUS_AT_START,
      `${mutation.name}: a tracked file in the checkout changed — the mutation was written through the hard link`,
    );
  });
}

// ---------------------------------------------------------------------------
// The real-database reading's attribution (gap-voice-capture-real-db-timing-attribution)
//
// `real-db-untouched` used to be decided by WHEN the file moved: a file that moved during the run
// and then held still was charged to the criterion. On a host where the deployer's live server
// holds that database, an external write followed by a quiet spell has exactly that shape, so a
// foreign writer reds the criterion ~cross-days. The reading is now decided by WHO held the file:
// the handles this process's own tree is seen holding (`/proc`), which a foreign holder is not in.
// These two cases pin both directions.
// ---------------------------------------------------------------------------

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Direct children of a pid, read from `/proc` (the same signal the criterion's scan uses).
 *
 * @param {number} pid
 * @returns {number[]}
 */
function procChildren(pid) {
  /** @type {number[]} */
  const children = [];
  /** @type {string[]} */
  let tasks;
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const tid of tasks) {
    try {
      const text = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
      if (text === '') continue;
      for (const token of text.split(/\s+/)) children.push(Number(token));
    } catch {
      // The task exited between the readdir and the read; it has no children to report.
    }
  }
  return children;
}

/**
 * A REAL SQLite database this control OWNS and holds open for a whole criterion run.
 *
 * Held open on purpose: the deployer's server is a foreign process with the database open, so the
 * control has to reproduce a foreign holder that is NOT in the criterion's tree. A scan that
 * charged any holder to the criterion would flag this one; a scan that reads only the criterion's
 * own tree (the fix) does not.
 *
 * A valid database, not a touched text file: the negative control makes the criterion's own child
 * inherit this path, so the child has to be able to OPEN it as SQLite (the property under test is
 * that it should not be there at all — a crash on a malformed file would hide that behind a
 * boot failure). The foreign write is a real INSERT through the held connection, which keeps the
 * file well-formed while still moving its `mtime`.
 *
 * @returns {{ dir: string, dbPath: string, holder: Database.Database }}
 */
function makeControlledDb() {
  const dir = mkdtempSync(join(SCRATCH_ROOT, CONTROLLED_DB_PREFIX));
  const dbPath = join(dir, 'auth.db');
  const holder = new Database(dbPath);
  holder.exec('CREATE TABLE external_writer (note TEXT)');
  return { dir, dbPath, holder };
}

/**
 * Records one foreign write to a controlled database through its held connection.
 *
 * @param {Database.Database} holder
 * @param {string} note
 */
function foreignWrite(holder, note) {
  holder.prepare('INSERT INTO external_writer (note) VALUES (?)').run(note);
}

/**
 * Runs the criterion against a copy with `DATABASE_PATH` pointed at `dbPath`, invoking `onChild`
 * once the run has demonstrably begun (its first child appeared) — before the criterion's final
 * `mtimeMs` read, so a write from `onChild` lands inside the window.
 *
 * @param {string} copyRoot
 * @param {string} dbPath
 * @param {() => void} onChild
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, sawChild: boolean, attempts: number }>}
 */
async function runCriterionWithDb(copyRoot, dbPath, onChild) {
  /** @type {{ status: number | null, stdout: string, stderr: string, sawChild: boolean, attempts: number } | null} */
  let last = null;
  for (let attempt = 1; attempt <= COULD_NOT_MEASURE_RETRIES + 1; attempt += 1) {
    const env = baseEnv();
    env.DATABASE_PATH = dbPath;
    const child = spawn(process.execPath, [join(copyRoot, CRITERION_REL), '--root', copyRoot], {
      cwd: copyRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(/** @type {Buffer} */ (chunk)));
    child.stderr?.on('data', (chunk) => err.push(/** @type {Buffer} */ (chunk)));
    const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));

    const criterionPid = child.pid;
    let sawChild = false;
    const deadline = Date.now() + CHILD_SIGNAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (criterionPid !== undefined && procChildren(criterionPid).length > 0) {
        sawChild = true;
        break;
      }
      if (child.exitCode !== null) break;
      await sleepMs(CHILD_SIGNAL_POLL_MS);
    }
    // Only after the run has begun; a write before the criterion's first read would not move the
    // window at all, and the caller's own assertion on `real-db-churn` would report that miss.
    if (sawChild) onChild();

    const status = await done;
    last = {
      status,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      sawChild,
      attempts: attempt,
    };
    if (status !== 2 || attempt > COULD_NOT_MEASURE_RETRIES) return last;
  }
  if (last === null) throw new Error('the criterion was never run');
  return last;
}

/**
 * Deletes the line that hands the child the run's own database, so the child inherits the
 * criterion's `DATABASE_PATH`. Replaces the file rather than writing in place — `cp -al` gave it
 * the checkout's inode.
 *
 * @param {string} copyRoot
 */
function mutateCriterionToInheritRealDb(copyRoot) {
  const target = join(copyRoot, CRITERION_REL);
  const pristine = readFileSync(target, 'utf8');
  const sites = pristine.split(CRITERION_DB_ANCHOR).length - 1;
  assert.equal(
    sites,
    1,
    `child-inherits-real-db: the anchor occurs ${sites} times in ${CRITERION_REL}, expected exactly 1 — ` +
      'the criterion changed shape under this control',
  );
  const mutated = pristine.split(CRITERION_DB_ANCHOR).join('');
  assert.notEqual(mutated, pristine, 'child-inherits-real-db: the mutation changed nothing');

  rmSync(target);
  writeFileSync(target, mutated);

  assert.equal(
    readFileSync(join(REPO_ROOT, CRITERION_REL), 'utf8'),
    pristine,
    'child-inherits-real-db: the mutation reached the checkout through the hard link',
  );
}

test('AC-148 real-db attribution: a foreign one-shot writer is not charged to the criterion', async () => {
  const { dir, dbPath, holder } = makeControlledDb();
  const copyRoot = buildCopy();
  try {
    let wrote = false;
    const result = await runCriterionWithDb(copyRoot, dbPath, () => {
      foreignWrite(holder, 'external-write');
      wrote = true;
    });
    const readings = readReadings(result.stdout);
    const failures = readFailures(result.stdout);

    assert.equal(
      result.status,
      0,
      `the criterion exited ${result.status} (attempts=${result.attempts}) on a foreign one-shot write — ` +
        'the timing attribution is still red on the operator\'s traffic\n' +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(wrote, true, 'the foreign writer never fired');
    assert.equal(readings.get('real-db'), dbPath, `real-db reads ${String(readings.get('real-db'))}, expected ${dbPath}`);
    assert.equal(
      readings.get('real-db-churn'),
      'external',
      'the foreign write did not land inside the criterion\'s window (churn is not external)',
    );
    assert.equal(readings.get('real-db-untouched'), 'true', 'a foreign holder was charged to the criterion');
    assert.equal(readings.get('real-db-opened-by-tree'), 'false', 'the criterion opened a database it does not own');
    assert.deepEqual(failures, [], `the criterion failed for some other reason: ${JSON.stringify(failures)}`);
    for (const [key, value] of Object.entries(AC148_READINGS)) {
      assert.equal(readings.get(key), value, `${key} reads ${String(readings.get(key))}, expected ${value}`);
    }
  } finally {
    holder.close();
    rmSync(copyRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-148 negative control: a child that inherits the real database reds on OWNERSHIP, not timing', async () => {
  const { dir, dbPath, holder } = makeControlledDb();
  const copyRoot = buildCopy();
  try {
    const base = await runCriterionWithDb(copyRoot, dbPath, () => foreignWrite(holder, 'external-write-before'));
    assert.equal(
      base.status,
      0,
      `child-inherits-real-db: the UNMUTATED copy exited ${base.status} (attempts=${base.attempts}) — without ` +
        `this half the mutant's red would prove nothing\nstdout:\n${base.stdout}\nstderr:\n${base.stderr}`,
    );

    mutateCriterionToInheritRealDb(copyRoot);
    const mutant = await runCriterionWithDb(copyRoot, dbPath, () => foreignWrite(holder, 'external-write-after'));
    const readings = readReadings(mutant.stdout);
    const failures = readFailures(mutant.stdout);

    assert.equal(
      mutant.status,
      1,
      `child-inherits-real-db: the mutated copy exited ${mutant.status} (attempts=${mutant.attempts}), expected 1\n` +
        `stdout:\n${mutant.stdout}\nstderr:\n${mutant.stderr}`,
    );
    assert.equal(
      readings.get('real-db-opened-by-tree'),
      'true',
      'the criterion did not see its own child holding the inherited database',
    );
    assert.ok(
      String(readings.get('real-db-openers')).includes(dbPath),
      `real-db-openers does not name the inherited database: ${String(readings.get('real-db-openers'))}`,
    );
    const ownership = failures.find((failure) => namesReading(failure, 'real-db-untouched'));
    assert.ok(ownership, `no check.failure names real-db-untouched: ${JSON.stringify(failures)}`);
    assert.ok(
      ownership.includes('process tree was holding'),
      `the red is not ownership evidence: ${ownership}`,
    );
    assert.ok(
      !ownership.includes('held still') && !ownership.includes('changed while this ran'),
      `the red is still timing inference, not ownership: ${ownership}`,
    );

    process.stdout.write(
      `mutation=child-inherits-real-db baseExit=${base.status} mutantRed=${mutant.status === 1} ` +
        'whichReading=real-db-untouched\n',
    );
  } finally {
    holder.close();
    rmSync(copyRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC5 the controls leave the checkout exactly as they found it', () => {
  const trackedNow = gitStatus(true);
  const statusNow = gitStatus();
  process.stdout.write(
    `repo-tracked-status=${trackedNow.replace(/\n/g, ' | ') || '<clean>'}\n` +
      `repo-status=${statusNow.replace(/\n/g, ' | ') || '<clean>'}\n`,
  );

  assert.equal(trackedNow, REPO_TRACKED_STATUS_AT_START, 'these controls modified a tracked file in the checkout');
  assert.deepEqual(
    attributableEntries(statusNow),
    [],
    'the checkout reports an entry this control could have produced',
  );

  const leftovers = readdirSync(SCRATCH_ROOT).filter(
    (name) => name.startsWith(COPY_PREFIX) || name.startsWith(CONTROLLED_DB_PREFIX),
  );
  assert.deepEqual(leftovers, [], 'a throwaway copy or controlled database survived the run');
});
