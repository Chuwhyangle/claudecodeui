/**
 * Where an e2e run's webServer stderr goes, and the shell redirect that puts it there.
 *
 * WHY THIS MODULE EXISTS. The goal gate records a failed criterion's reason from the run's STDERR
 * (plugin `goal-driver`'s `withFailureOutput`: `errText ? boundedExcerpt(errText, 'stderr', budget,
 * true) : outText ? …`, head of stderr, budget ~500 chars). Playwright's list reporter writes the
 * names and assertions of failing CASES to STDOUT, but forwards every webServer child's stderr to the
 * RUNNER's stderr (`screen.stderr.write(chunk)`). On this checkout the server is chatty at boot —
 * `No .env file found or error reading it: ENOENT`, the `DEP0190` deprecation warning, and Vite's
 * `ws proxy error: write EPIPE` once a page closes — and a green run measured 13 895 bytes of it
 * (2026-10-21). So every gate failure read back only that startup noise and
 * `[truncated, N chars of stderr omitted]`, never the failing case: AC-323 accumulated eight
 * "fixes" that were each a guess, because the red could not be attributed.
 *
 * WHAT THIS DOES. The webServer `command` strings are wrapped so the shell redirects their stderr
 * into a file under the run's own data directory. The file is created by the shell before the
 * command runs, so it exists even when the server writes nothing. Diagnostics are not discarded:
 * they land in `<dataDir>/server.stderr.log` and `<dataDir>/vite.stderr.log`, next to the rest of
 * the run's artifacts (the data directory is announced on stdout as `[e2e] data-dir=<D>`).
 *
 * The raw-capture and client-clock selections are deliberately NOT wrapped: their commands already
 * carry `2>&1 | tee <file>`, which forwards the child's whole output to the runner's stdout, and the
 * spec reads that stream. Those branches are byte-for-byte unchanged.
 *
 * @module scripts/e2e-web-server-stderr
 */

import path from 'node:path';

/** Basename of the server webServer's stderr log. */
export const SERVER_STDERR_LOG_NAME = 'server.stderr.log';
/** Basename of the Vite webServer's stderr log. */
export const VITE_STDERR_LOG_NAME = 'vite.stderr.log';

/**
 * The stderr log paths for one run, both inside the run's own throwaway data directory.
 *
 * Absolute paths derived from `dataDir`, not relative ones: the shell runs the command with the
 * webServer entry's own `cwd` (the env-free server root / the run's client snapshot), so a relative
 * redirect target would land wherever that cwd happens to be instead of in the run's artifacts.
 * @param {string} dataDir the run's data directory (announced on stdout as `[e2e] data-dir=<D>`)
 * @returns {{ server: string, vite: string }}
 */
export function webServerStderrLogs(dataDir) {
  return {
    server: path.join(dataDir, SERVER_STDERR_LOG_NAME),
    vite: path.join(dataDir, VITE_STDERR_LOG_NAME),
  };
}

/**
 * `command` with its stderr redirected into `logPath`, for a shell-run webServer command.
 *
 * The command is kept VERBATIM and the redirect is appended — nothing is parsed, re-quoted or
 * reordered, so a command carrying its own pipes, `&&`, quoting or flags keeps running exactly as it
 * did. The path is JSON-quoted so a directory containing spaces (the data-directory selector can
 * hand back one) still arrives as a single shell word; the quotes are shell quotes, which is what
 * `JSON.stringify` produces for a plain POSIX path.
 *
 * `>` rather than `>>`: the target is a file inside a directory this run created, so truncation is
 * the intended first write (and a rerun reusing a data directory should not append two runs' bytes
 * into one reading).
 * @param {string} command the webServer command, verbatim
 * @param {string} logPath absolute path of the log the child's stderr is diverted to
 * @returns {string}
 */
export function withStderrLog(command, logPath) {
  return `${command} 2> ${JSON.stringify(logPath)}`;
}
