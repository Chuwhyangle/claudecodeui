#!/usr/bin/env node
/**
 * The controls for `scripts/asr-extraction-parity-check.mjs` (AC-130's criterion).
 *
 * A criterion that reads four byte-identical groups off the shipped code is only worth what its
 * controls are worth, so each of the four fake shapes the task names gets a case of its own:
 *
 *   AC2  a baseline that is not pre-extraction   — the recorded commit no longer carries the inline
 *                                                  inbound field write, or is not an ancestor of
 *                                                  HEAD, or is unreadable
 *   AC3  the inbound form field renamed          — `audio` -> `file`, in the shipping source
 *   AC4  the seam made as tolerant as the proxy  — `parseTranscriptionResponse` returns the raw
 *                                                  body instead of throwing
 *   AC5  a reader that is missing, or that
 *        prints nothing and exits 0
 *
 * Every mutation case is a PAIR of assertions, in this order: the same command must exit 0 on the
 * same tree before the mutation, and must exit non-zero after it. The first half is what makes the
 * second half mean anything — without it, "it went red" could just as well be "this tree never ran
 * at all", which is a fake shape this repository has already paid for once. Each case also asserts
 * the mutation hit exactly one site: a substitution that matched nothing would otherwise leave the
 * tree green while the case reported "red after mutation".
 *
 * The mutations are applied to a temporary git worktree, never to this checkout, and the probe is
 * pointed at it with `--root` — the flag exists so that a control can drive a tree that is not the
 * one it lives in.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PROBE = join(HERE, 'asr-extraction-parity-check.mjs');

const READ_CLIENT_REL = join('experiments', 'voice-asr-parity', 'read-client.ts');
const READ_SERVER_REL = join('experiments', 'voice-asr-parity', 'read-server.ts');
const API_REL = join('src', 'shared', 'api.ts');
const BASELINE_REL = join('scripts', '__fixtures__', 'asr-extraction-parity-baseline.json');

/** The four groups, in the order the criterion prints them. */
const GROUPS = ['inbound', 'direct-outbound', 'proxy-outbound', 'response-tolerance'];

/**
 * The inline inbound field write AC-130's fake shape (1) renames.
 *
 * IT IS A FRAGMENT OF A LINE, NOT A WHOLE ONE, and it is written at more than one site today: the
 * client appends the audio field on each branch it can take. The two cases that mutate it (AC2b,
 * AC3) therefore rewrite EVERY occurrence and assert nothing of it survives, rather than assuming a
 * single site — the assumption the criterion's own baseline still holds for the pre-extraction
 * commit, but which the shipping tree outgrew.
 */
const INLINE_INBOUND = "append('audio'";

/** The seam AC-130's fake shape (2) makes tolerant. */
const SEAM_ANCHOR = 'export async function parseTranscriptionResponse';

/** Directories a shipping-source grep walks, and the ones it must never descend into. */
const SHIPPING_DIRS = ['src', 'shared', 'server'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', 'coverage', '.git']);

/**
 * @param {string} tree
 * @param {string[]} args
 * @returns {string}
 */
function git(tree, args) {
  return String(execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8' }));
}

/**
 * A temporary git worktree at HEAD, with this checkout's `node_modules` linked in (the readers load
 * the shipped module graph, so the tree they are driven in has to be able to resolve it).
 *
 * A worktree rather than a copy so the mutation is applied to a real checkout of the repository,
 * and under the OS temp directory rather than inside this checkout so a crashed case cannot leave
 * untracked files behind in the tree that gets merged.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string} the worktree path
 */
function makeTree(t) {
  const parent = mkdtempSync(join(tmpdir(), 'parity-ctrl-'));
  const tree = join(parent, 'tree');
  git(ROOT, ['worktree', 'add', '--detach', tree, 'HEAD']);
  symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'), 'dir');
  t.after(() => {
    try {
      git(ROOT, ['worktree', 'remove', '--force', tree]);
    } catch {
      // The case may already have removed it; the directory removal below is the backstop.
    }
    rmSync(parent, { recursive: true, force: true });
  });
  return tree;
}

/**
 * `node scripts/asr-extraction-parity-check.mjs --root <tree> <extra>`, with no `--root` when the
 * tree is this checkout — so the AC1 case runs the criterion command exactly as written.
 *
 * @param {string | null} tree
 * @param {string[]} [extra]
 * @returns {{ status: number | null, stdout: string, stderr: string, text: string }}
 */
function runProbe(tree, extra = []) {
  const args = tree === null ? [PROBE, ...extra] : [PROBE, '--root', tree, ...extra];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return { status: result.status, stdout, stderr, text: `${stdout}${stderr}` };
}

/**
 * The first half of every mutation case: the unmutated tree must pass, or the second half proves
 * nothing.
 *
 * @param {string} tree
 * @param {string} label
 * @returns {void}
 */
function assertGreenBeforeMutation(tree, label) {
  const run = runProbe(tree);
  assert.equal(run.status, 0, `${label}: the unmutated tree must exit 0 first\n${run.text}`);
  assert.match(run.stdout, /^verdict PASS$/m, `${label}: the unmutated tree must say PASS\n${run.text}`);
}

/** @param {string} haystack @param {string} needle @returns {number} */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * @param {string} dir
 * @param {(file: string) => void} visit
 * @returns {void}
 */
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, visit);
    } else if (entry.isFile()) {
      visit(path);
    }
  }
}

/**
 * The shipping files that contain `needle`, as paths relative to `tree`.
 *
 * AC3 resolves the substitution site this way rather than by a hard-coded path: the extraction this
 * baseline guards is the very change that will move the inline write, and a pinned path would keep
 * "mutating" a file that no longer carries it — a mutation that hits nothing looks exactly like one
 * that works, which is why the caller asserts the hit count.
 *
 * @param {string} tree
 * @param {string} needle
 * @returns {string[]}
 */
function grepShipping(tree, needle) {
  /** @type {string[]} */
  const hits = [];
  for (const dir of SHIPPING_DIRS) {
    const base = join(tree, dir);
    if (!existsSync(base)) continue;
    walk(base, (file) => {
      if (readFileSync(file, 'utf8').includes(needle)) hits.push(relative(tree, file));
    });
  }
  return hits.sort();
}

/**
 * Points the recorded baseline at another commit, and reports whether that changed anything.
 *
 * @param {string} tree
 * @param {string} sha
 * @returns {number} 1 when the field really was rewritten, 0 when it already held that value
 */
function setRecordedFromCommit(tree, sha) {
  const path = join(tree, BASELINE_REL);
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  const before = baseline.provenance.recordedFromCommit;
  baseline.provenance.recordedFromCommit = sha;
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  return before === sha ? 0 : 1;
}

test('AC1 the criterion itself: four groups equal to the baseline, verdict PASS', () => {
  for (let runNumber = 1; runNumber <= 2; runNumber += 1) {
    const run = runProbe(null);
    assert.equal(run.status, 0, `AC1 run ${runNumber}: ${run.text}`);

    assert.match(run.stdout, /^pre-extraction ok recordedFromCommit=[0-9a-f]{40}$/m, run.text);
    for (const group of GROUPS) {
      assert.match(
        run.stdout,
        new RegExp(`^group ${group} equal sha256=[0-9a-f]{64}$`, 'm'),
        `AC1 run ${runNumber}: group ${group}\n${run.text}`,
      );
    }
    assert.match(run.stdout, /^baseline sha256=[0-9a-f]{64}$/m, run.text);
    assert.match(run.stdout, /^baseline recordedFromCommit=[0-9a-f]{40}$/m, run.text);
    assert.match(run.stdout, /^observed sha256=([0-9a-f]{64})$/m, run.text);
    assert.match(run.stdout, /^verdict PASS$/m, run.text);
  }

  // Two runs rather than one: the multipart boundary is regenerated per serialization, so a
  // criterion whose normalization had a hole would print a different reading on the second run and
  // the baseline could never hold. This is the one place that is asserted rather than reasoned about.
  const first = runProbe(null);
  const second = runProbe(null);
  const observed = /^observed sha256=([0-9a-f]{64})$/m.exec(first.stdout)?.[1];
  assert.ok(observed, `AC1: no observed sha256 line\n${first.text}`);
  assert.equal(
    observed,
    /^observed sha256=([0-9a-f]{64})$/m.exec(second.stdout)?.[1],
    `AC1: two runs of the same tree disagree — the normalization is not deterministic`,
  );
});

test('AC2a a baseline naming an unreadable commit must go red', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC2a');

  assert.equal(setRecordedFromCommit(tree, '0'.repeat(40)), 1, 'AC2a: the mutation must hit the field');

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC2a: an unreadable recordedFromCommit must be red\n${run.text}`);
  assert.match(run.stdout, /baseline-not-pre-extraction/, run.text);
  assert.doesNotMatch(run.stdout, /^pre-extraction ok/m, run.text);
});

test('AC2b a baseline recorded after the extraction must go red', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC2b');

  // The post-extraction shape: a commit whose `src/shared/api.ts` no longer carries the inline
  // inbound field write. The working copy is restored afterwards so the four readings stay
  // identical and the *only* thing this case moves is the provenance claim.
  const path = join(tree, API_REL);
  const source = readFileSync(path, 'utf8');
  // EVERY SITE, NOT ONE. The client now writes the inbound field on each branch it can take — the
  // routed proxy hop, the plain proxy hop, and the raw-capture hop — so "the commit no longer carries
  // the inline inbound field write" means none of them does. Removing only the first would leave the
  // commit still carrying the write, the provenance arm would still accept it, and this case would
  // report a green it did not earn. The pair of counts is the guard the old exact-one assertion was:
  // something must be there to rewrite, and nothing may survive.
  const occurrences = countOccurrences(source, INLINE_INBOUND);
  assert.ok(occurrences >= 1, 'AC2b: the extraction must move at least one inline inbound write');
  const postExtractionSource = source.split(INLINE_INBOUND).join("append('audioForProxy'");
  assert.equal(
    countOccurrences(postExtractionSource, INLINE_INBOUND),
    0,
    'AC2b: every inline inbound write must be gone from the post-extraction shape',
  );
  writeFileSync(path, postExtractionSource);
  git(tree, ['add', API_REL]);
  git(tree, [
    '-c', 'user.name=parity-control',
    '-c', 'user.email=parity-control@invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'post-extraction (parity control)',
  ]);
  const postExtraction = git(tree, ['rev-parse', 'HEAD']).trim();
  writeFileSync(path, source);

  assert.equal(setRecordedFromCommit(tree, postExtraction), 1, 'AC2b: the mutation must hit the field');

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC2b: a post-extraction recordedFromCommit must be red\n${run.text}`);
  assert.match(run.stdout, /baseline-not-pre-extraction/, run.text);
  assert.match(run.stdout, /^group inbound equal/m, `AC2b: the readings must stay untouched\n${run.text}`);
});

test('AC2c a recordedFromCommit that is not an ancestor of HEAD must go red', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC2c');

  // A commit that still carries the inline write but sits on a divergent line: it is reachable by
  // sha and readable, so only the ancestry arm can reject it.
  const original = git(tree, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(tree, 'PARITY-CONTROL-NOTE.txt'), 'control\n');
  git(tree, ['add', 'PARITY-CONTROL-NOTE.txt']);
  git(tree, [
    '-c', 'user.name=parity-control',
    '-c', 'user.email=parity-control@invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'divergent line (parity control)',
  ]);
  const divergent = git(tree, ['rev-parse', 'HEAD']).trim();
  // Back to the original commit; the divergent one stays readable by sha, which is what makes this
  // case about ancestry rather than about readability.
  git(tree, ['reset', '--hard', original]);

  assert.match(git(tree, ['show', `${divergent}:${API_REL}`]), /append\('audio'/, 'AC2c: the divergent commit must still carry the inline write');
  assert.equal(setRecordedFromCommit(tree, divergent), 1, 'AC2c: the mutation must hit the field');

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC2c: a non-ancestor recordedFromCommit must be red\n${run.text}`);
  assert.match(run.stdout, /baseline-not-pre-extraction/, run.text);
});

test('AC3 the inbound form field renamed must turn the inbound group red', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC3');

  const hits = grepShipping(tree, INLINE_INBOUND);
  assert.equal(
    hits.length,
    1,
    `AC3: expected exactly one shipping file with the inline inbound write, saw ${hits.length}: ${hits.join(', ')}`,
  );

  const path = join(tree, hits[0]);
  const source = readFileSync(path, 'utf8');
  // EVERY SITE, NOT ONE, for the same reason as AC2b: the field is written on each branch the client
  // can take, and "the inbound form field is renamed" renames it wherever it is written, exactly as a
  // rename would. The `inbound` reading is taken on the branch the reader drives (no base URL, so the
  // plain proxy hop), and that branch's write is among these — so the rename really does move the
  // reading. Doing all of them rather than only the driven one is also what keeps this case honest if
  // the reader's route ever changes. The pair of counts is the guard the old exact-one assertion was.
  const occurrences = countOccurrences(source, INLINE_INBOUND);
  assert.ok(occurrences >= 1, 'AC3: the substitution must hit at least one site');
  const renamed = source.split(INLINE_INBOUND).join("append('file'");
  assert.equal(countOccurrences(renamed, INLINE_INBOUND), 0, 'AC3: every inline inbound write must be renamed');
  writeFileSync(path, renamed);

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC3: renaming the inbound field must be red\n${run.text}`);
  assert.match(run.stdout, /^group inbound differ/m, run.text);
  assert.match(run.stdout, /reading-differs: inbound/, run.text);
  // Targeted: the other three groups are the same code path's neighbours and must not move, or the
  // case would be proving "something changed" rather than "the inbound hop is covered".
  for (const group of ['direct-outbound', 'proxy-outbound', 'response-tolerance']) {
    assert.match(run.stdout, new RegExp(`^group ${group} equal`, 'm'), `AC3: ${group} must not move\n${run.text}`);
  }
});

test('AC4 the seam made as tolerant as the proxy must turn response-tolerance red', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC4');

  const path = join(tree, API_REL);
  const source = readFileSync(path, 'utf8');
  assert.equal(countOccurrences(source, SEAM_ANCHOR), 1, 'AC4: the seam must be declared exactly once');

  const start = source.indexOf(SEAM_ANCHOR);
  const close = source.slice(start).indexOf('\n}\n');
  assert.ok(close > 0, 'AC4: could not find the seam body');
  const tolerant = [
    'export async function parseTranscriptionResponse(response: Response): Promise<string> {',
    '  const body = await response.text();',
    '  try {',
    '    const data = JSON.parse(body) as { text?: unknown } | null;',
    "    return String(data?.text || '');",
    '  } catch {',
    '    return body;',
    '  }',
    '}',
    '',
  ].join('\n');
  writeFileSync(path, source.slice(0, start) + tolerant + source.slice(start + close + 3));

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC4: a tolerant seam must be red\n${run.text}`);
  assert.match(run.stdout, /^group response-tolerance differ/m, run.text);
  assert.match(run.stdout, /reading-differs: response-tolerance/, run.text);
  for (const group of ['inbound', 'direct-outbound', 'proxy-outbound']) {
    assert.match(run.stdout, new RegExp(`^group ${group} equal`, 'm'), `AC4: ${group} must not move\n${run.text}`);
  }
});

test('AC5a a missing reader must go red, not silently green', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC5a');

  const path = join(tree, READ_CLIENT_REL);
  assert.ok(existsSync(path), 'AC5a: the reader this case deletes must exist');
  rmSync(path);
  assert.equal(existsSync(path), false, 'AC5a: the deletion must hit exactly one file');

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC5a: a deleted reader must be red\n${run.text}`);
  assert.match(run.stdout, /reader-missing/, run.text);
});

test('AC5b a reader that prints nothing and exits 0 must go red', (t) => {
  const tree = makeTree(t);
  assertGreenBeforeMutation(tree, 'AC5b');

  const stub = `process.stdout.write('ASR-PARITY-READING ' + JSON.stringify({ fixture: null, readings: [] }) + '\\n');\n`;
  let replaced = 0;
  for (const rel of [READ_CLIENT_REL, READ_SERVER_REL]) {
    const path = join(tree, rel);
    if (!existsSync(path)) continue;
    writeFileSync(path, stub);
    replaced += 1;
  }
  assert.equal(replaced, 2, 'AC5b: both readers must be replaced, or the other one still reports readings');

  const run = runProbe(tree);
  assert.notEqual(run.status, 0, `AC5b: an empty reading set must be red\n${run.text}`);
  assert.match(run.stdout, /no readings/, run.text);
});

test('AC6 the criterion drives shipping symbols, and the readers spell no recogniser path', (t) => {
  const tree = makeTree(t);
  const run = runProbe(tree, ['--explain-sites']);
  assert.equal(run.status, 0, `AC6: --explain-sites must exit 0\n${run.text}`);

  for (const group of GROUPS) {
    assert.match(
      run.stdout,
      new RegExp(`^site ${group}[^\\n]*in-shipping-tree$`, 'm'),
      `AC6: no in-tree site line for ${group}\n${run.text}`,
    );
  }
  assert.doesNotMatch(run.stdout, /OUTSIDE-SHIPPING-TREE/, run.text);
  assert.match(run.stdout, /^fixture synthetic name=clip\.webm mimeType=audio\/webm bytes=\d+ sha256=[0-9a-f]{64}$/m, run.text);

  // The independent reading AC6 asks for: the readers reach the recogniser through the shipped URL
  // builders, so the literal path appears nowhere under `experiments/voice-asr-parity/` — a reader
  // that spelled it itself would be a second implementation of the hop.
  for (const rel of [READ_CLIENT_REL, READ_SERVER_REL]) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    assert.equal(
      countOccurrences(source, 'audio/transcriptions'),
      0,
      `AC6: ${rel} spells the recogniser path itself`,
    );
  }
});
