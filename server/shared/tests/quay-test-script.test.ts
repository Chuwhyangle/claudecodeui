import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function runScript(args: string[]) {
  return spawnSync('bash', ['scripts/test.sh', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, QUAY_TEST_DRY: '1' },
  });
}

// Runs scripts/test.sh for real (no QUAY_TEST_DRY) with extra env — the dispatch-order and
// static-stage test seams. QUAY_TEST_STOP_AFTER=order stops after collection and =stages after
// the two static stages, so neither seam executes a test file.
function runSuite(args: string[], env: Record<string, string> = {}, timeoutMs = 120_000) {
  return spawnSync('bash', ['scripts/test.sh', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
}

// The exact list scripts/test.sh collects on the full path. Spelled the same way test.sh spells
// it, because AC3/AC4 compare the `order` seam against it byte-for-byte.
function collectedServerFiles(): string {
  const r = spawnSync(
    'bash',
    ['-c', "find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort"],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `collection pipeline failed: ${r.stderr}`);
  return r.stdout;
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// The stderr lines the dispatch block emits — the ones AC3 pins, one per run.
function dispatchLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('test.sh: server dispatch '));
}

// Index of a stage's `__PERFILE__` row in stdout, or -1.
function perFileIndex(stdout: string, label: string): number {
  return stdout.split('\n').findIndex((line) => line.startsWith('__PERFILE__ ') && line.includes(` ${label} passed=`));
}

function endMs(stdout: string, label: string): number {
  const line = stdout.split('\n').find((l) => l.startsWith('__PERFILE__ ') && l.includes(` ${label} passed=`));
  assert.ok(line, `no __PERFILE__ row for ${label}`);
  const m = /end_ms=(\d+)/.exec(line);
  assert.ok(m, `no end_ms on the ${label} row: ${line}`);
  return Number(m[1]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The Scenario Runner's browser arm — the label the e2e lane records under and the spec its
// default command runs. Spelled the way test.sh spells it, because the pins below compare rows.
const E2E_SPEC = 'e2e/session-lifecycle-scenario.spec.ts';

// Writes a stub `npm` on its own PATH dir. test.sh drives `npm run typecheck` / `npm run lint`
// through it, so the stub can decide, structurally, whether the two stages overlap.
function writeNpmStub(dir: string, body: string): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const npm = path.join(bin, 'npm');
  writeFileSync(npm, body, { mode: 0o755 });
  return bin;
}

test('value-taking quay flags are consumed together with their values', () => {
  const result = runScript([
    '--buckets', 'x', '--root', '.', '--state-dir', '.quay', '--runner', 'inner',
    '--log-file', '/tmp/l', '--run-id', 'r', '--test-concurrency=2', '--unknown-flag',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /concurrency=2, files=0/);
  assert.doesNotMatch(result.stderr, /Could not find/);
});

test('a positional test file that does not exist is an error, not a skip', () => {
  const result = runScript(['nonexistent.test.ts']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /test file not found/);
});

test('an existing positional test file is accepted', () => {
  const result = runScript(['server/shared/tests/quay-test-script.test.ts']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /files=1/);
});

test('quay scoped-gate flags: --for-task consumes the task id instead of treating it as a file', () => {
  const result = runScript(['--for-task', 'gap-quay-tests-page-perfile-wrapper', '--allow-thin']);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /test file not found/);
});

test('--static-checks-doc exits 0 without running tests', () => {
  assert.equal(runScript(['--static-checks-doc']).status, 0);
});

test('AC7: the committed duration baseline is valid data, covers the suite, and documents its source', () => {
  const baseline = path.join(REPO_ROOT, 'scripts/suite-duration-baseline.tsv');
  assert.ok(existsSync(baseline), 'scripts/suite-duration-baseline.tsv must exist');
  const lines = readFileSync(baseline, 'utf8').split('\n');
  const header = lines.filter((l) => l.startsWith('#')).join('\n');
  const body = lines.filter((l) => l.trim() !== '' && !l.startsWith('#'));
  assert.ok(body.length > 0, 'the baseline must carry data lines');
  for (const line of body) {
    assert.match(line, /^[0-9]+\tserver\/\S+\.test\.(ts|js)$/, `baseline line must be <ms>TAB<server test path>: ${line}`);
  }

  const collected = collectedServerFiles().split('\n').filter(Boolean);
  const known = new Set(body.map((l) => l.slice(l.indexOf('\t') + 1)));
  const covered = collected.filter((f) => known.has(f)).length;
  assert.ok(covered >= collected.length * 0.9, `baseline covers ${covered}/${collected.length} collected files (< 90%)`);

  const top8 = [...body].sort((a, b) => Number(b.split('\t')[0]) - Number(a.split('\t')[0])).slice(0, 8);
  assert.ok(
    top8.some((l) => l.includes('voice-error-classification.false-forms.test.ts')),
    'the slowest file must be among the top 8 by duration',
  );

  assert.match(header, /verification-round\.jsonl/, 'the header must name the ledger the data came from');
  assert.match(header, /node -e/, 'the header must carry a re-runnable regeneration command');
  assert.match(header, /round[: ]+[0-9]+/i, 'the header must name the source round number');
});

test('AC2: a valid baseline dispatches known files longest-first, keeps the rest alphabetical, and drops missing paths', () => {
  const dir = tempDir('quay-ac2-');
  try {
    const fixture = path.join(dir, 'baseline.tsv');
    const slow = 'server/shared/tests/quay-test-script.test.ts';
    const mid = 'server/modules/providers/tests/model-gateway-end-to-end.test.ts';
    const fast = 'server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts';
    const gone = 'server/does/not/exist.test.ts';
    writeFileSync(fixture, [`9000\t${slow}`, `7000\t${mid}`, `5000\t${fast}`, `1234\t${gone}`].join('\n') + '\n');

    const r = runSuite([], { QUAY_TEST_STOP_AFTER: 'order', QUAY_SUITE_DURATION_BASELINE: fixture });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.split('\n').filter(Boolean);
    assert.deepEqual(out.slice(0, 3), [slow, mid, fast], 'the first 3 lines must be the listed files by descending duration');

    const rest = collectedServerFiles().split('\n').filter((f) => f && f !== slow && f !== mid && f !== fast);
    assert.deepEqual(out.slice(3), rest, 'baseline-unlisted files must follow in alphabetical order');
    assert.ok(!out.includes(gone), 'a listed path that does not exist must not appear');

    const lines = dispatchLines(r.stderr);
    assert.equal(lines.length, 1, 'exactly one dispatch line on stderr');
    // the tree collects 404 server test files (a moving target, so the pin is re-measured, never
    // derived); re-measured 2026-10-23 after quay-uri-project-segment-is-fleet-registry-id added
    // server/modules/quay/tests/quay-fleet-project-id.test.ts (403 + 1 = 404). Before that,
    // re-measured 2026-10-23 after quay-wall-uri-dereference-with-snapshot-fallback added
    // server/modules/quay/tests/quay-uri-resolve.test.ts (402 + 1 = 403). Before that, re-measured
    // 2026-10-23 after gap-providers-websocket-cycle-port-break added
    // server/modules/providers/tests/providers-websocket-cycle.test.ts (401 + 1 = 402). Before
    // that, re-measured 2026-10-22 after gap-voice-realtime-ws-proxy-trunk-steps added
    // server/modules/voice-realtime/tests/voice-realtime-trunk-steps.test.ts (400 + 1 = 401). Before
    // that, re-measured 2026-10-22 after gap-projects-services-cycle-port-break added
    // server/modules/projects/tests/projects-session-fetch-cycle.test.ts (399 + 1 = 400). Before
    // that, re-measured 2026-10-22 after gap-voice-provider-cycle-port-break added
    // server/modules/voice/tests/voice-provider-cycle.test.ts (398 + 1 = 399). Before that,
    // re-measured 2026-10-22 after gap-voice-realtime-ws-proxy-frame-extension-point
    // added server/modules/voice-realtime/tests/voice-realtime-frame-registry.test.ts
    // (397 + 1 = 398). Before that, re-measured 2026-10-22 after
    // gap-claude-host-driver-lifecycle-extension-point
    // added server/modules/providers/tests/claude-resident-lifecycle-outcome-registry.test.ts
    // (396 + 1 = 397). Before that, gap-claude-host-driver-extension-point added
    // server/modules/providers/tests/claude-resident-outcome-registry.test.ts (395 + 1 = 396).
    // Before that, re-measured 2026-10-21 after architecture-graph-cache added
    // server/modules/architecture/tests/cache-invalidation.test.ts (391 + 1 = 392), then
    // gap-architecture-seed-extraction-from-transcript added
    // server/modules/architecture/tests/seed-extraction.test.ts (392 + 1 = 393), then
    // gap-architecture-graph-generator-seeded-subgraph added
    // server/modules/architecture/tests/generator.test.ts (393 + 1 = 394).
    // Before that, re-measured 2026-10-21 after gap-files-tab-unfiltered-decouple-index added
    // server/modules/file-tree/tests/file-tree-search-index.test.ts (390 + 1 = 391).
    // Before that, re-measured 2026-10-21 after voice-speaker-model-provisioning added
    // server/modules/voice-realtime/tests/voice-realtime-speaker-model.test.ts (389 + 1 = 390).
    // Before that, re-measured 2026-10-21 after voice-speaker-tracker-shadow added
    // server/modules/voice-realtime/tests/voice-realtime-speaker-tracker.test.ts (388 + 1 = 389).
    // Before that, re-measured 2026-10-21 after file-tree-lazy-directory-listing added
    // server/modules/file-tree/tests/file-tree-lazy-listing.test.ts (387 + 1 = 388).
    // Before that file-tree-git-backed-file-index added
    // server/modules/file-tree/tests/file-tree-index.test.ts (386 + 1 = 387).
    // Before that, re-measured 2026-10-20 after gap-server-root-browser-use-cycle-relocate-mcp-entry
    // added server/modules/cli/tests/browser-use-mcp-entry.test.ts (385 + 1 = 386).
    // Before that gap-server-provider-websocket-init-cycle-ports added
    // server/shared/tests/server-composition-startup.test.ts (384 + 1 = 385).
    // Before that gap-shared-bounded-approval-ledger-and-directory-bytes
    // added server/shared/tests/bounded-approval-ledger.test.ts (383 + 1 = 384).
    // Before that gap-claude-transcript-parsing-dedupe added
    // server/modules/providers/tests/claude-transcript-format.test.ts (382 + 1 = 383).
    // Before that gap-voice-run-end-summary-side-model added
    // server/modules/voice-realtime/tests/voice-realtime-summary.test.ts (381 + 1 = 382).
    // Before that, voice-realtime-tts-local added
    // server/modules/voice-realtime/tests/voice-realtime-tts-local.test.ts (380 + 1 = 381).
    // Before that, voice-realtime-model-reply-narrator added
    // server/modules/voice-realtime/tests/voice-realtime-model-reply-narrator.test.ts (379 + 1 = 380).
    // Before that, gap-narrator-announce-phrase-cache added
    // server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts and
    // server/modules/voice-realtime/tests/voice-realtime-announce-phrases.test.ts (377 + 2 = 379).
    // Before that, gap-narrator-tts-stream-first-frame added
    // server/modules/voice-realtime/tests/voice-realtime-tts-stream.test.ts (376 + 1 = 377).
    // Before that, gap-narrator-local-gate-no-interrupt added
    // server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts (375 + 1 = 376).
    // Before that, gap-omission-fill-pure-module-and-parity added
    // server/modules/voice-realtime/tests/voice-realtime-omission-fill.test.ts (363 + 1 = 364).
    // Re-measured 2026-10-17 after eighteen tasks each added one criterion file — the
    // five above (gap-ac377 claude-resident-cold-head-merge.test.ts, gap-ac378
    // claude-resident-ledger-invariants.test.ts, gap-ac379 claude-resident-cli-contract.test.ts,
    // gap-ac381 claude-resident-unattended-after-turns.test.ts and gap-ac380
    // claude-resident-interrupt-ledger.test.ts), gap-ac382-run-is-turn-resident-init-minted-run
    // (chat-run-turn-semantics.test.ts), gap-ac383-delivery-activity-snapshot-channel
    // (activity-deliveries-snapshot.test.ts), gap-ac384-processing-single-writer
    // (processing-single-writer.test.ts), gap-ac385-send-deliveryid-runid-compat-window
    // (mcp-session-send-delivery.test.ts), gap-ac386-run-get-dual-id-delivery-wait
    // (mcp-run-get-delivery.test.ts), gap-ac393-resident-legacy-path-ratchet
    // (resident-legacy-path-ratchet.test.ts), gap-ac395-ledger-transitions-extraction
    // (claude-resident-ledger-transitions.test.ts), gap-ac390-resident-reconcile-observability
    // (claude-resident-reconcile.test.ts), gap-ac392-resident-run-is-turn-single-reader
    // (resident-run-is-turn-single-reader.test.ts), gap-ac394-server-import-cycle-budget
    // (server-import-cycle-budget.test.ts), gap-ac391-resident-semantics-doc-anchors
    // (resident-semantics-doc-anchors.test.ts), gap-ac396-ledger-leaf-module
    // (server/modules/resident-ledger/tests/resident-ledger-leaf-module.test.ts) and
    // gap-ac397-composition-root-wiring (server/shared/tests/composition-root-wiring.test.ts).
    // The same day gap-live-voice-stream-delivery-not-command removed ONE: the settle producer
    // replaced the fragment heuristic, so voice-realtime-partial-relay-fragments.test.ts went with
    // it (364 - 1 = 363). Then gap-omission-fill-pure-module-and-parity put one back
    // (363 + 1 = 364), and gap-omission-fill-wire-into-ws-proxy put one more
    // (364 + 1 = 365). Then gap-omission-fill-params-owned-by-server added the AC-402 source test
    // (365 + 1 = 366). Then gap-voice-realtime-silent-closing-orphans-tool-resume-overflow added
    // server/modules/voice-realtime/tests/voice-realtime-tool-resume-always-sent.test.ts
    // (366 + 1 = 367). Then two independent tasks each added one criterion file:
    // voice-output-tts-cosyvoice added the AC-405 TTS criterion
    // server/modules/voice-realtime/tests/voice-realtime-tts.test.ts (367 + 1 = 368) and
    // voice-output-backchannel added its AC-407 criterion
    // server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts (368 + 1 = 369).
    // Then voice-output-narrator-interrupt added its AC-406 criterion
    // server/modules/voice-realtime/tests/voice-realtime-narrator-interrupt.test.ts (369 + 1 = 370).
    // Then voice-output-run-end-summary added its AC-404 criterion
    // server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts (370 + 1 = 371).
    // Then the announce-wiring commit f18c966ee added its narrator criterion
    // server/modules/voice-realtime/tests/voice-realtime-announce-narrator.test.ts (371 + 1 = 372).
    // Then fleet-overview-p2-project-task-counts-fleet-summary added its criterion
    // server/modules/quay/tests/quay-fleet-summary.test.ts (372 + 1 = 373).
    // Then fleet-overview-p3-landing-overview-session-terminal added its criterion
    // server/modules/resident-ledger/tests/terminal-state.test.ts (373 + 1 = 374).
    // Then gap-voice-realtime-per-user-key added its criterion
    // server/modules/voice-realtime/tests/voice-realtime-api-key-resolution.test.ts (374 + 1 = 375).
    // Then gap-narrator-local-gate-no-interrupt added its criterion
    // server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts (375 + 1 = 376).
    // Then the four GOAL-049 architecture criteria (seed extraction, generator, cache, and
    // architecture-graph-endpoint's route criterion) brought the collection to 395 files.
    // Then gap-claude-host-driver-extension-point added its criterion
    // server/modules/providers/tests/claude-resident-outcome-registry.test.ts (395 + 1 = 396).
    // Then cockpit-hub-cross-device-state added its two criteria
    // server/modules/cockpit/tests/cockpit-reducer.test.ts and cockpit-hub.test.ts
    // (404 + 2 = 406 collected server test files).
    // Then gap-resident-restore-after-restart added its criterion
    // server/modules/session-hosts/tests/resident-restore.service.test.ts (406 + 1 = 407).
    // Then quay-fleet-cli-locator-and-handshake added its locator criterion
    // server/modules/quay/tests/quay-fleet-locator.test.ts (407 + 1 = 408).
    // Re-measured 2026-10-24 after gap-reply-suggestions-backend-llm-service added four
    // criteria under server/modules/reply-suggestions/tests/ — reply-suggestions-settings,
    // reply-suggestions-client, reply-suggestions-service and reply-suggestions-routes
    // (408 + 4 = 412 collected server test files).
    // This fixture names 3 known files, so 412 - 3 = 409.
    assert.match(lines[0], /^test\.sh: server dispatch order=longest-first source=.* known=3 unknown=409$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3: a broken baseline fails open to alphabetical order byte-for-byte, and says why on stderr', (t) => {
  const dir = tempDir('quay-ac3-');
  try {
    const expected = collectedServerFiles();
    const cases: Array<{ name: string; file: string; lines?: string }> = [
      { name: 'missing', file: path.join(dir, 'missing.tsv') },
      { name: 'empty', file: path.join(dir, 'empty.tsv'), lines: '' },
      { name: 'unparseable (non-numeric duration)', file: path.join(dir, 'badnum.tsv'), lines: 'abc\tserver/x.test.ts\n' },
      { name: 'unparseable (missing path)', file: path.join(dir, 'nopath.tsv'), lines: '123\n' },
    ];
    for (const c of cases) {
      if (c.lines !== undefined) writeFileSync(c.file, c.lines);
      const r = runSuite([], { QUAY_TEST_STOP_AFTER: 'order', QUAY_SUITE_DURATION_BASELINE: c.file });
      assert.equal(r.status, 0, `${c.name}: ${r.stderr}`);
      assert.equal(r.stdout, expected, `${c.name}: stdout must stay byte-for-byte alphabetical`);
      const lines = dispatchLines(r.stderr);
      assert.equal(lines.length, 1, `${c.name}: exactly one dispatch line`);
      assert.match(lines[0], /^test\.sh: server dispatch order=alphabetical reason=.+$/, c.name);
    }

    // ④ unreadable. Mode bits cannot defeat a root runner, so probe before trusting the case.
    const unreadable = path.join(dir, 'unreadable.tsv');
    writeFileSync(unreadable, `9000\tserver/shared/tests/quay-test-script.test.ts\n`);
    chmodSync(unreadable, 0o000);
    const probe = spawnSync('bash', ['-c', 'test -r "$1"', '_', unreadable], { encoding: 'utf8' });
    if (probe.status === 0) {
      t.diagnostic('running as root: mode 000 is still readable, so the unreadable-baseline case is skipped here');
    } else {
      const r = runSuite([], { QUAY_TEST_STOP_AFTER: 'order', QUAY_SUITE_DURATION_BASELINE: unreadable });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, expected, 'unreadable: stdout must stay byte-for-byte alphabetical');
      const lines = dispatchLines(r.stderr);
      assert.equal(lines.length, 1, 'unreadable: exactly one dispatch line');
      assert.match(lines[0], /^test\.sh: server dispatch order=alphabetical reason=/, 'unreadable');
    }

    // A VALID baseline announces longest-first with its source path and its known/unknown counts.
    const valid = path.join(dir, 'valid.tsv');
    writeFileSync(valid, `9000\tserver/shared/tests/quay-test-script.test.ts\n`);
    const rv = runSuite([], { QUAY_TEST_STOP_AFTER: 'order', QUAY_SUITE_DURATION_BASELINE: valid });
    assert.equal(rv.status, 0, rv.stderr);
    const vl = dispatchLines(rv.stderr);
    assert.equal(vl.length, 1, 'valid: exactly one dispatch line');
    // same collection as AC2 — 412 files on this tree — but this fixture names ONE known file,
    // so 412 - 1 = 411 (AC2 reads 409 because its fixture names 3)
    assert.match(vl[0], /^test\.sh: server dispatch order=longest-first source=.* known=1 unknown=411$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC4: reordering neither loses nor duplicates a file, and positional files keep their given order', () => {
  const dir = tempDir('quay-ac4-');
  try {
    const fixture = path.join(dir, 'baseline.tsv');
    writeFileSync(
      fixture,
      `9000\tserver/shared/tests/quay-test-script.test.ts\n500\tserver/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts\n`,
    );
    const expected = collectedServerFiles().split('\n').filter(Boolean);
    const r = runSuite([], { QUAY_TEST_STOP_AFTER: 'order', QUAY_SUITE_DURATION_BASELINE: fixture });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.split('\n').filter(Boolean);
    assert.equal(out.length, expected.length, 'no file lost or duplicated');
    assert.deepEqual([...out].sort(), [...expected].sort(), 'the file set must be unchanged');

    // Positional: a reverse-alphabetical given order must be printed verbatim, never reordered.
    const first = 'server/shared/tests/quay-test-script.test.ts';
    const second = 'server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts';
    assert.ok(first > second, 'the fixture must give the alphabetically LATER file first');
    const rp = runSuite([first, second], { QUAY_TEST_STOP_AFTER: 'order' });
    assert.equal(rp.status, 0, rp.stderr);
    assert.deepEqual(rp.stdout.split('\n').filter(Boolean), [first, second]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC5: typecheck and lint overlap — each stub npm sees the other stage start', () => {
  const dir = tempDir('quay-ac5-');
  try {
    const mark = path.join(dir, 'marks');
    mkdirSync(mark, { recursive: true });
    const bin = writeNpmStub(
      dir,
      `#!/usr/bin/env bash
[ "$1" = "run" ] || exit 0
sub="$2"
touch "$QUAY_TEST_NPM_MARK/$sub.started"
other=typecheck; [ "$sub" = "typecheck" ] && other=lint
i=0
while [ "$i" -lt 100 ]; do
  [ -e "$QUAY_TEST_NPM_MARK/$other.started" ] && exit 0
  sleep 0.1; i=$((i + 1))
done
exit 7
`,
    );
    const r = runSuite([], {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      QUAY_TEST_NPM_MARK: mark,
      QUAY_TEST_STOP_AFTER: 'stages',
    });
    assert.equal(r.status, 0, `stub exits 7 unless both stages ran at once; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC6: a red typecheck still fails the run, and typecheck is reported before lint regardless of finish order', () => {
  const dir = tempDir('quay-ac6-');
  try {
    const mark = path.join(dir, 'marks');
    mkdirSync(mark, { recursive: true });
    const bin = writeNpmStub(
      dir,
      `#!/usr/bin/env bash
[ "$1" = "run" ] || exit 0
sub="$2"
touch "$QUAY_TEST_NPM_MARK/$sub.started"
if [ "$sub" = "typecheck" ]; then sleep 1.2; exit 1; fi
exit 0
`,
    );
    const r = runSuite([], {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      QUAY_TEST_NPM_MARK: mark,
      QUAY_TEST_STOP_AFTER: 'stages',
    });
    assert.notEqual(r.status, 0, `a red stage must make the run red; stdout:\n${r.stdout}`);
    assert.match(r.stdout, /__PERFILE__ duration_ms=\d+ typecheck passed=false end_ms=\d+/);
    assert.match(r.stdout, /__PERFILE_KIND__ file=typecheck kind=assert/);
    assert.match(r.stdout, /__PERFILE__ duration_ms=\d+ lint passed=true end_ms=\d+/);

    const ty = perFileIndex(r.stdout, 'typecheck');
    const li = perFileIndex(r.stdout, 'lint');
    assert.ok(ty >= 0 && li >= 0 && ty < li, `typecheck's row must precede lint's (positions ${ty}, ${li})`);
    assert.ok(endMs(r.stdout, 'lint') < endMs(r.stdout, 'typecheck'), 'the stub makes lint finish first, so the order above is fixed, not incidental');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── e2e lane: the Scenario Runner browser arm as a merge-gate lane ────────────────────────────
// (gap-regression-gate-fan-in-lane-for-e2e-arm). The lane runs after the client phase on the
// full-collection path, records the spec under its own repo-relative path, and is scoped out of a
// positional invocation. QUAY_TEST_STOP_AFTER=e2e runs ONLY the lane, so these three pins cost one
// stub command each; QUAY_TEST_E2E_CMD replaces the lane's command so the pin does not need
// Chromium installed — a browser requirement here would couple this server-side file to a
// browser, for no gain (the arm's own browser reading is the spec's job, not this pin's).

test('e2e-lane AC1: the full path runs the Scenario Runner browser arm as a counting lane', () => {
  // The default command IS the arm: the pin below would be vacuous if the seam were the only way
  // to reach the lane, or if the default pointed at something other than that one spec.
  const sh = readFileSync(path.join(REPO_ROOT, 'scripts/test.sh'), 'utf8');
  assert.match(sh, /E2E_SPEC="e2e\/session-lifecycle-scenario\.spec\.ts"/, 'the lane must name the Scenario Runner spec as its default target');
  assert.match(sh, /E2E_CMD="\$\{QUAY_TEST_E2E_CMD:-node_modules\/\.bin\/playwright test \$E2E_SPEC\}"/, 'the default command must be playwright over that spec (the seam only overrides it)');

  const r = runSuite([], { QUAY_TEST_STOP_AFTER: 'e2e', QUAY_TEST_E2E_CMD: 'true' });
  assert.equal(r.status, 0, `a green arm must be a green run; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`^__PERFILE__ duration_ms=\\d+ ${escapeRe(E2E_SPEC)} passed=true end_ms=\\d+$`, 'm'));
  // Counting it is the difference between a lane and a log: the arm is one unit of the report.
  assert.match(r.stdout, /# tests 1\n# pass 1\n# fail 0/);
});

test('e2e-lane AC2: a failed browser arm is a red unit — the run exits non-zero with its own `not ok` row', () => {
  const r = runSuite([], { QUAY_TEST_STOP_AFTER: 'e2e', QUAY_TEST_E2E_CMD: 'exit 1' });
  assert.notEqual(r.status, 0, `a red arm must red the run; stdout:\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`__PERFILE__ duration_ms=\\d+ ${escapeRe(E2E_SPEC)} passed=false end_ms=\\d+`));
  // A normal non-zero exit is a real defect (assert), not the "cut off" infra shape — so the red
  // line is attributable to the arm rather than filed as a host flake.
  assert.match(r.stdout, new RegExp(`__PERFILE_KIND__ file=${escapeRe(E2E_SPEC)} kind=assert`));
  assert.match(r.stdout, new RegExp(`^not ok - ${escapeRe(E2E_SPEC)}: `, 'm'));
  assert.match(r.stdout, /# tests 1\n# pass 0\n# fail 1/);
});

test('e2e-lane false form: the lane block, not the command, is what blocks — a scoped run cannot see it', () => {
  // Same red command as AC2, on a path where the lane does not run (a positional file is a task's
  // own subset, and the e2e seam leaves the heavy phases off so nothing is executed here). Green:
  // the reading AC2 depends on is produced by the lane's own block, so deleting that block removes
  // the block — which is exactly the gap this task closed.
  const r = runSuite(['server/shared/tests/quay-test-script.test.ts'], {
    QUAY_TEST_STOP_AFTER: 'e2e',
    QUAY_TEST_E2E_CMD: 'exit 1',
  });
  assert.equal(r.status, 0, `scoped out, the red arm must not reach the report; stdout:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, new RegExp(escapeRe(E2E_SPEC)), 'the lane must not run on the scoped path');
});
