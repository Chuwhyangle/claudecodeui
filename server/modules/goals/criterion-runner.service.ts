import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { CriterionReading } from '@/shared/types.js';

// --------------------------- Criterion runner ------------

/**
 * How long one criterion may run before its process group is killed.
 *
 * A criterion that hangs would otherwise stall the whole goal loop; 120s is
 * generous for a unit-test / single-file check and short enough that a stuck
 * command shows up as a red reading within one round.
 */
export const CRITERION_TIMEOUT_MS_DEFAULT = 120_000;

/**
 * How many bytes of the tail of stdout+stderr one reading keeps.
 *
 * The tail is what explains a failure (assertion output, stack trace, the
 * exit summary), so truncation keeps the END and drops the START. 64 KiB is
 * enough for a full failing test summary while keeping every evidence row
 * cheap to store and to show in the UI.
 */
export const OUTPUT_EXCERPT_MAX_BYTES = 64 * 1024;

/** The reading recorded when an AC has no runnable command (fail-closed). */
const EMPTY_COMMAND_OUTPUT = 'criterion is empty';

/**
 * How long to wait for the child to be reaped after the process-group SIGKILL
 * before settling the reading anyway. A child stuck in uninterruptible I/O can
 * outlive the signal; the round must not hang on it.
 */
const KILL_GRACE_MS = 2_000;

/**
 * What one criterion invocation needs: the shell command, the directory it runs
 * in (the goal worktree, so it sees the agent's latest edits), and an optional
 * timeout override.
 */
export type RunCriterionOptions = {
  command: string;
  cwd: string;
  timeoutMs?: number;
};

/**
 * sha256 of the (already truncated) output, hex encoded. The no-progress check
 * compares this across rounds, so it must be a pure function of `output`.
 */
function digestOf(output: string): string {
  return createHash('sha256').update(output, 'utf8').digest('hex');
}

/** Builds a fail reading; used for the empty-command and spawn-error paths. */
function failReading(output: string): CriterionReading {
  return {
    exitCode: null,
    timedOut: false,
    output,
    outputDigest: digestOf(output),
    verdict: 'fail',
  };
}

/**
 * Runs one AC's `criterion` command and reports what happened.
 *
 * Consumers: `goal-driver.service.ts` (every active AC, every round) and the
 * activation path's red-first check, both of which need one `CriterionReading`
 * per AC and must never see a rejected promise — a criterion that cannot even
 * spawn is a red reading, not a crashed loop.
 *
 * Behaviour guarantees:
 * - An empty or whitespace-only command never spawns; it is a fail reading.
 * - The command runs as `/bin/sh -c <command>` in `cwd`, with stdout and
 *   stderr captured into one stream (interleaved by arrival).
 * - On timeout the whole process GROUP is SIGKILLed, so a criterion like
 *   `npm test` does not leave its children behind.
 * - Only the last `OUTPUT_EXCERPT_MAX_BYTES` of output is kept; the digest is
 *   computed from that truncated text.
 * - The promise never rejects.
 */
export function runCriterion(options: RunCriterionOptions): Promise<CriterionReading> {
  const command = options.command.trim();
  if (!command) {
    return Promise.resolve(failReading(EMPTY_COMMAND_OUTPUT));
  }

  const timeoutMs = options.timeoutMs ?? CRITERION_TIMEOUT_MS_DEFAULT;

  return new Promise<CriterionReading>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killGraceTimer: NodeJS.Timeout | null = null;

    // The tail of everything the child wrote so far, already capped at
    // OUTPUT_EXCERPT_MAX_BYTES. Bounded from the first chunk on: an unbounded
    // `yes`-style criterion cannot grow this buffer without limit.
    let outputTail: Buffer = Buffer.alloc(0);

    const appendToTail = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      outputTail =
        outputTail.length === 0 ? bytes : Buffer.concat([outputTail, bytes]);
      if (outputTail.length > OUTPUT_EXCERPT_MAX_BYTES) {
        outputTail = outputTail.subarray(outputTail.length - OUTPUT_EXCERPT_MAX_BYTES);
      }
    };

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      timeoutTimer = null;
      killGraceTimer = null;
    };

    const finish = (exitCode: number | null, extraOutput?: string): void => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (extraOutput) appendToTail(`\n${extraOutput}`);

      // The byte-level truncation above can split a multi-byte character at
      // the very start of the kept tail; that only affects the excerpt a
      // person reads, and both the digest and the verdict stay deterministic
      // because they are computed from this exact string.
      const output = outputTail.toString('utf8');
      resolve({
        exitCode,
        timedOut,
        output,
        outputDigest: digestOf(output),
        verdict: exitCode === 0 && !timedOut ? 'pass' : 'fail',
      });
    };

    // `detached: true` puts the child in its own process group so the timeout
    // path can kill the whole group (shell + everything it started).
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killProcessGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          // Windows has no process-group kill via a negative pid; kill the
          // direct child and let the OS reap its descendants.
          child.kill('SIGKILL');
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // The child already exited between the timeout firing and this call.
        try {
          child.kill('SIGKILL');
        } catch {
          // Nothing left to kill.
        }
      }
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
      // Safety net: if the child cannot be reaped (e.g. stuck in
      // uninterruptible I/O) the reading still settles instead of hanging.
      killGraceTimer = setTimeout(() => {
        finish(null, 'criterion killed after timeout');
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on('data', appendToTail);
    child.stderr?.on('data', appendToTail);

    // Spawn failures (missing cwd, ENOENT, ...) arrive here, after which no
    // 'close' event follows — the reading must still settle as a fail.
    child.on('error', (error) => {
      finish(null, `failed to run criterion: ${error.message}`);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}
