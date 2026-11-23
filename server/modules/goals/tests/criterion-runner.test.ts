import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CRITERION_TIMEOUT_MS_DEFAULT,
  OUTPUT_EXCERPT_MAX_BYTES,
  runCriterion,
} from '@/modules/goals/criterion-runner.service.js';

/** stdout is deterministic, so the digest must match across runs. */
test('a successful command is a pass with a stable digest', async () => {
  const first = await runCriterion({ command: 'echo hello-criterion', cwd: process.cwd() });
  assert.equal(first.exitCode, 0);
  assert.equal(first.timedOut, false);
  assert.equal(first.verdict, 'pass');
  assert.equal(first.output, 'hello-criterion\n');
  assert.match(first.outputDigest, /^[0-9a-f]{64}$/);

  const second = await runCriterion({ command: 'echo hello-criterion', cwd: process.cwd() });
  assert.equal(second.outputDigest, first.outputDigest);
});

test('a non-zero exit is a fail and keeps stderr in the output', async () => {
  const reading = await runCriterion({
    command: 'echo boom >&2; exit 3',
    cwd: process.cwd(),
  });
  assert.equal(reading.exitCode, 3);
  assert.equal(reading.timedOut, false);
  assert.equal(reading.verdict, 'fail');
  assert.match(reading.output, /boom/);
});

test('a timeout kills the process group and reports timedOut', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'criterion-timeout-'));
  const pidFile = path.join(scratch, 'child.pid');

  try {
    const startedAt = Date.now();
    const reading = await runCriterion({
      // The background child is the point: a plain `sleep` may be exec'd
      // directly by the shell, but this one proves the whole group is killed.
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(reading.timedOut, true);
    assert.equal(reading.verdict, 'fail');
    assert.notEqual(reading.exitCode, 0);
    assert.ok(elapsedMs < 10_000, `timeout should not wait for the command: ${elapsedMs}ms`);

    const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    // The killed process must be gone (ESRCH). Give the scheduler a moment to
    // reap it before declaring failure.
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `grandchild ${grandchildPid} survived the process-group kill`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('output is truncated to its tail', async () => {
  const headMarker = 'HEAD-MARKER';
  const tailMarker = 'TAIL-MARKER';
  const fillerBytes = OUTPUT_EXCERPT_MAX_BYTES + 10_000;

  const reading = await runCriterion({
    command: `node -e "process.stdout.write('${headMarker}' + 'a'.repeat(${fillerBytes}) + '${tailMarker}')"`,
    cwd: process.cwd(),
  });

  assert.equal(reading.verdict, 'pass');
  assert.ok(
    Buffer.byteLength(reading.output, 'utf8') <= OUTPUT_EXCERPT_MAX_BYTES,
    `output should be capped at ${OUTPUT_EXCERPT_MAX_BYTES} bytes`,
  );
  assert.ok(reading.output.endsWith(tailMarker), 'the tail must survive truncation');
  assert.ok(!reading.output.includes(headMarker), 'the head must be dropped');
});

test('an empty or whitespace-only command fails without spawning', async () => {
  for (const command of ['', '   \n\t ']) {
    const reading = await runCriterion({ command, cwd: process.cwd() });
    assert.equal(reading.exitCode, null);
    assert.equal(reading.timedOut, false);
    assert.equal(reading.output, 'criterion is empty');
    assert.equal(reading.verdict, 'fail');
    assert.match(reading.outputDigest, /^[0-9a-f]{64}$/);
  }

  const first = await runCriterion({ command: '', cwd: process.cwd() });
  const second = await runCriterion({ command: '  ', cwd: process.cwd() });
  assert.equal(first.outputDigest, second.outputDigest);
});

test('a spawn failure is a fail reading, never a rejection', async () => {
  const reading = await runCriterion({
    command: 'echo should-not-run',
    cwd: path.join(os.tmpdir(), 'criterion-cwd-that-does-not-exist'),
  });
  assert.equal(reading.exitCode, null);
  assert.equal(reading.timedOut, false);
  assert.equal(reading.verdict, 'fail');
  assert.match(reading.output, /failed to run criterion/);
});

test('the default timeout is two minutes', () => {
  assert.equal(CRITERION_TIMEOUT_MS_DEFAULT, 120_000);
});
