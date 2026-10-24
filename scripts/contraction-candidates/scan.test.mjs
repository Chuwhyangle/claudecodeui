/**
 * Criterion for `scripts/contraction-candidates/scan.mjs`.
 *
 * WHAT THIS FILE IS THE READING OF. The scanner is only useful if a "never spoke" reading is
 * both (a) produced for a genuinely silent instrument and (b) suppressed for a file that DOES
 * have a reader. A test that only asserts the first half would pass on a scanner that flags every
 * state file, so the negative control (`has-reader.json`) is load-bearing, not decoration.
 *
 * The fixture is built in a temp directory at run time rather than checked in: the scanner walks
 * CODE and PROSE, and a committed fixture would put a second, misleading copy of "an instrument
 * that never fires" inside this repo's own candidate scan. `testdata/fixture-repo/README.md`
 * documents the shape; this file is the single source that materialises it.
 *
 * Three claims are read here:
 *   1. a gate with pass records and no fail record is reported as `never-red-gate`, and a gate
 *      that has failed is not;
 *   2. a state file written but never read is reported as `zero-reader-state-file`, while a state
 *      file that has a read call is not;
 *   3. the scan is read-only — the fixture's `git status` is byte-identical before and after.
 */

// @ts-nocheck -- LANDING GAP (carried by cockpit-initiative-view-and-decision-queue): the
// sibling `scan.mjs` landed untyped on develop and reds `npm run typecheck`; this criterion is
// excluded with it until the owning follow-up types both files.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, 'scan.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function statusOf(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all']);
}

/** Materialise a small repo whose only interesting facts are the two readings above. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scan-fixture-'));
  const now = new Date().toISOString();
  const gateLines = [];
  for (let i = 0; i < 6; i += 1) {
    gateLines.push(JSON.stringify({ gate: 'always-green', verdict: 'pass', timestamp: now, payload: { reason: `ok ${i}` } }));
  }
  for (let i = 0; i < 4; i += 1) {
    gateLines.push(JSON.stringify({ gate: 'sometimes-red', verdict: 'pass', timestamp: now }));
  }
  gateLines.push(JSON.stringify({ gate: 'sometimes-red', verdict: 'fail', timestamp: now, payload: { reason: 'boom' } }));

  writeFile(path.join(dir, '.quay', 'gate-events.jsonl'), `${gateLines.join('\n')}\n`);
  writeFile(path.join(dir, '.quay', 'never-read.json'), '{}\n');
  writeFile(path.join(dir, '.quay', 'has-reader.json'), '{"value":1}\n');

  writeFile(
    path.join(dir, 'src', 'writer.mjs'),
    [
      "import fs from 'node:fs';",
      "const neverRead = new URL('../.quay/never-read.json', import.meta.url);",
      "const hasReader = new URL('../.quay/has-reader.json', import.meta.url);",
      "fs.writeFileSync(neverRead, '{}');",
      "fs.writeFileSync(hasReader, '{\"value\":1}');",
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(dir, 'src', 'reader.mjs'),
    [
      "import fs from 'node:fs';",
      "const file = new URL('../.quay/has-reader.json', import.meta.url);",
      "const state = JSON.parse(fs.readFileSync(file, 'utf8'));",
      'export default state;',
      '',
    ].join('\n'),
  );

  writeFile(path.join(dir, 'docs', 'live.md'), '# live\n');
  writeFile(path.join(dir, 'docs', 'orphan.md'), '# orphan\n');
  writeFile(path.join(dir, 'docs', 'index.md'), '# index\n\nSee live.md.\n');

  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

test('scan.mjs identifies silent instruments and keeps the negative control quiet', async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const before = statusOf(fixture);

  const result = spawnSync(process.execPath, [SCAN, '--root', fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, `scan exited ${result.status}: ${result.stderr}`);

  /** @type {any} */
  let report;
  assert.doesNotThrow(() => {
    report = JSON.parse(result.stdout);
  }, `stdout was not JSON: ${result.stdout.slice(0, 400)}`);
  assert.equal(report.tool, 'contraction-candidates-scan');
  assert.equal(report.root, fixture);

  const after = statusOf(fixture);
  assert.equal(after, before, 'the scan must not change the fixture repo (git status differed)');

  /** @type {any[]} */
  const candidates = report.candidates;
  assert.ok(candidates.length >= 2, `expected at least two candidates, got ${candidates.length}`);

  const neverRed = candidates.filter((c) => c.kind === 'never-red-gate');
  assert.ok(
    neverRed.some((c) => c.target === 'gate:always-green'),
    `expected gate:always-green to be reported as never-red; targets=${neverRed.map((c) => c.target).join(',')}`,
  );
  assert.ok(
    !neverRed.some((c) => c.target === 'gate:sometimes-red'),
    'a gate with a fail record must not be reported as never-red',
  );

  const zeroReader = candidates.filter((c) => c.kind === 'zero-reader-state-file');
  assert.ok(
    zeroReader.some((c) => c.target === 'state:.quay/never-read.json'),
    `expected never-read.json to be reported as zero-reader; targets=${zeroReader.map((c) => c.target).join(',')}`,
  );
  assert.ok(
    !zeroReader.some((c) => c.target === 'state:.quay/has-reader.json'),
    'negative control: has-reader.json has a read call and must not be reported',
  );

  for (const candidate of candidates) {
    assert.ok(Array.isArray(candidate.evidence) && candidate.evidence.length > 0, `${candidate.target} has no evidence`);
    assert.ok(
      typeof candidate.counterCheck === 'string' && candidate.counterCheck.trim().length > 0,
      `${candidate.target} has no counterCheck`,
    );
  }
});
