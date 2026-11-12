import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * Owner of one short-lived `codex app-server` child and of the process group it
 * leads.
 *
 * WHY THIS EXISTS. `codex app-server` is not one process. On the packaged CLI it
 * is a Node launcher that execs the native binary, and that binary starts its
 * own children — notably a `git ls-remote` chain for plugin sync — that outlive
 * the direct child by up to a second after a bare `child.kill()`. Anything that
 * tears down the child's `CODEX_HOME` immediately afterwards (the edit/rewind
 * criteria do exactly that) races those descendants and hits `ENOTEMPTY` on the
 * final `rmdir`. Stopping the whole group and waiting for it to empty before
 * returning removes the writer instead of retrying the removal.
 *
 * Consumers: `codex-app-server.client.ts` (the only production caller) and
 * `server/modules/providers/tests/codex-app-server-process.test.ts`.
 */

/** How long the group gets between SIGTERM and SIGKILL. */
const DEFAULT_GRACE_MS = 750;

/** How long the group gets after SIGKILL before `stop()` gives up waiting. */
const DEFAULT_KILL_MS = 750;

/** Poll interval while waiting for the group to empty. */
const POLL_INTERVAL_MS = 10;

export type CodexAppServerProcessOptions = {
  /** Full environment for the child; the caller merges its launch overrides. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** SIGTERM grace before escalation; defaults to `DEFAULT_GRACE_MS`. */
  graceMs?: number;
  /** Post-SIGKILL wait; defaults to `DEFAULT_KILL_MS`. */
  killMs?: number;
};

export type CodexAppServerStopResult = {
  /** No member of the group was left when `stop()` returned. */
  groupEmpty: boolean;
  /** The SIGTERM grace expired, so SIGKILL was sent. */
  escalated: boolean;
  /**
   * False when the platform has no POSIX process groups (Windows) or the spawn
   * produced no pid; the fallback then signals the direct child only.
   */
  groupStop: boolean;
};

/** The standard descriptor shape the client reads: stdin, stdout and stderr all piped. */
export type CodexAppServerChild = ChildProcessByStdio<Writable, Readable, Readable>;

export type CodexAppServerProcess = {
  readonly pid: number | undefined;
  readonly child: CodexAppServerChild;
  /** True while any process in the group still answers signal 0. */
  isGroupAlive(): boolean;
  /**
   * Stops the whole group and resolves once it is empty or the bounded wait
   * elapsed. Idempotent: concurrent and repeated calls share one result.
   */
  stop(): Promise<CodexAppServerStopResult>;
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Starts `codex app-server` as the leader of its own process group.
 *
 * `launcher` is the resolved `@openai/codex/bin/codex.js`; the child is started
 * through `process.execPath` with the same arguments the client has always
 * used, so the launch shape and env/cwd semantics stay intact. `detached: true`
 * is what makes the child a group leader on POSIX, which is what lets `stop()`
 * reach the CLI's descendants. Called by `withAppServer()` in
 * `codex-app-server.client.ts`.
 */
export function startCodexAppServerProcess(
  launcher: string,
  args: readonly string[],
  options: CodexAppServerProcessOptions = {},
): CodexAppServerProcess {
  const child = spawn(process.execPath, [launcher, ...args], {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A group of its own: stopping the leader signals every descendant too.
    detached: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });

  const pid = typeof child.pid === 'number' ? child.pid : undefined;
  const groupStop = pid !== undefined && process.platform !== 'win32';
  let stopped: Promise<CodexAppServerStopResult> | null = null;

  // Signal 0 probes existence without delivering anything. ESRCH is the only
  // answer that means "nothing left"; EPERM would mean the group exists.
  const isGroupAlive = (): boolean => {
    if (pid === undefined) {
      return false;
    }
    if (!groupStop) {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (groupStop && pid !== undefined) {
      try {
        process.kill(-pid, signal);
      } catch {
        // The group went away between the probe and the signal.
      }
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  // Bounded polling: a fixed poll interval capped by the remaining budget, so
  // the loop can never outlive its deadline even if a process refuses to die.
  const waitForGroupEmpty = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, budgetMs);
    while (isGroupAlive()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await wait(Math.min(POLL_INTERVAL_MS, remaining));
    }
    return true;
  };

  const stop = (): Promise<CodexAppServerStopResult> => {
    stopped ??= (async (): Promise<CodexAppServerStopResult> => {
      if (!isGroupAlive()) {
        return { groupEmpty: true, escalated: false, groupStop };
      }
      signalGroup('SIGTERM');
      if (await waitForGroupEmpty(options.graceMs ?? DEFAULT_GRACE_MS)) {
        return { groupEmpty: true, escalated: false, groupStop };
      }
      signalGroup('SIGKILL');
      const groupEmpty = await waitForGroupEmpty(options.killMs ?? DEFAULT_KILL_MS);
      return { groupEmpty, escalated: true, groupStop };
    })();
    return stopped;
  };

  return { pid, child, isGroupAlive, stop };
}
