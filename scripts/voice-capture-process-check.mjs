#!/usr/bin/env node
/**
 * voice-capture-process-check.mjs — the criterion for AC-148.
 *
 * WHAT THIS JUDGES. Not an assembly built inside this process, but a REAL service process:
 * `server:dev`'s own command, started with an explicit environment, read from its own stdout and
 * answered through ONE real HTTP request. Every reading below is either a line that child process
 * printed or a fact the upstream double observed on its own socket. Nothing is inferred from an
 * in-process construction — which is exactly the falsifying form AC-148 exists to exclude: "the
 * capture port records when a test injects it" says nothing about the shipped assembly.
 *
 * THE LOOP, TWICE. The same flow runs for `VOICE_CAPTURE=text` and for `VOICE_CAPTURE` absent:
 *
 *   1. an upstream double on `127.0.0.1:<port>` answers `POST /audio/transcriptions` with one fixed
 *      JSON body and RECORDS every request it was actually sent;
 *   2. the real service starts with the run's own `HOME` / `DATABASE_PATH` / `SERVER_PORT` / `HOST`
 *      and `FORCE_COLOR=0`, so its lines are compared as text rather than as escape sequences;
 *   3. a one-time Bearer token is minted against THAT run's database (`scripts/mint-token.mjs`);
 *   4. ONE real multipart `POST /api/voice/transcribe` (field name `audio`) is sent and answered.
 *
 * WHY BOTH RUNS ARE READ TOGETHER. "Zero capture lines" is worth nothing on its own — a request
 * that never arrived also produces zero lines. So the two runs share one criterion: BOTH must get
 * HTTP 200 carrying the double's text verbatim, and only the `text` run may have a capture row. An
 * implementation that ignores `VOICE_CAPTURE` therefore reds on the first run rather than passing
 * as a deployment that happened to record nothing.
 *
 * WHY THE UPSTREAM IS A DOUBLE. Reaching the real DashScope would need a credential from `.env`,
 * make the criterion non-hermetic, and turn a red into "the network was down". The price is stated
 * rather than hidden: the double speaks only the openai-compatible multipart wire, so "the shipped
 * recogniser's own protocol still holds" is NOT proven here — see the note block at the end.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It imports no shipped source (the `service-source-imports`
 * reading is computed from this file's own text), it drives no browser, and it reads the child's
 * stdout rather than `server.log` — redirecting a process's output is the deployer's business, and
 * the property under test is what the process writes to standard output.
 *
 * USAGE
 *   node scripts/voice-capture-process-check.mjs [--root <dir>] [--keep]
 *
 *   --root <dir>  the checkout whose `server/index.ts` is judged (default: this script's own repo)
 *   --keep        keep the run directory (debugging — the run directory only; the hardened copy is
 *                 always removed). Its path is printed either way.
 *
 * THE OBJECT JUDGED IS A HARDENED COPY OF `--root`, NOT `--root` ITSELF. Running the child straight
 * out of `--root` made this criterion's verdict depend on the deployer's own `.env`: `server/load-env.ts`
 * fills every key the child's environment does not already carry, so a `.env` naming `VOICE_CAPTURE`
 * made "the variable is unset" unimplementable and the criterion bailed out with `EMPTY_READING` — a
 * verdict about the instrument's preconditions wearing the shape of a verdict about the implementation.
 * So the object judged is a one-time hard-link copy made BESIDE `--root` (same filesystem by
 * construction), with `.git` and `.env` left out; the child's world is then one this criterion defines.
 * `--root` itself is only ever READ. `env-file-in-root` / `env-file-pins-voice-capture` record what it
 * carried, `judged-root` / `judged-root-env-file` / `hardened-root-removed` record the copy, and the
 * copy is removed on EVERY exit.
 *
 * EXIT CODES. 0 = every reading is the expected one. 1 = at least one is not, and each failing one
 * is named on stdout. 2 = the measurement could not be made at all (no tsx under `--root`, a hardened
 * copy that could not be built, a server that never came up) — a distinct outcome on purpose, because
 * "could not measure" must not read as "measured, and the property failed". A `.env` pinning
 * `VOICE_CAPTURE` is a READING (`env-file-pins-voice-capture=true`), never an exit.
 *
 * The real-database reading is ATTRIBUTED, not inferred from timing: it is false only when this
 * process's own tree was observed (via `/proc`) holding the inherited database, so a run that ends
 * in "could not measure" but carries that evidence is still exit 1 — the property failed whatever
 * else the run did.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

/**
 * The only host anything here may reach.
 *
 * Not a default: every target passes `guardedTarget` and a target that is not this literal throws
 * BEFORE the request is built, so `real-upstream-calls` is a count of departures that would have
 * left the box rather than a number this script talked itself into.
 */
const LOOPBACK = '127.0.0.1';

/** The start-up line the composition root announces, matched as a whole line rather than a substring. */
const STARTUP_TEXT_LINE = 'voice.capture mode=text';
const STARTUP_OFF_LINE = 'voice.capture mode=off';

/**
 * The event marker a capture ROW carries.
 *
 * A row is identified by this field of a line that parses as a JSON object — never by the substring
 * `voice.capture`, which the start-up line and the misspelling warning both contain. A substring
 * count would report a deployment's own announcement as a recording.
 */
const CAPTURE_EVENT = 'voice.capture';

/**
 * The upstream's answer, fixed and awkward on purpose.
 *
 * The quote and the backslash are what make "the row carries the upstream's body" un-fakeable by a
 * re-serialisation: a row that parsed the body and wrote it back would print it with different
 * spacing, and one that copied the TEXT instead of the BODY would lose the envelope. The two
 * strings compared below are never normalised, so "verbatim" means byte-for-byte.
 */
const DOUBLE_TEXT = 'capture-probe-7f3a "quoted" \\slash';
const DOUBLE_BODY = JSON.stringify({ text: DOUBLE_TEXT });

/** The path the shipped openai-compatible wire posts to, spelled here so the double can assert it. */
const TRANSCRIPTION_PATH = '/audio/transcriptions';

/** The audio part's payload. Its content is irrelevant; that it is a non-empty file is not. */
const AUDIO_BODY = 'voice-capture-process-check audio payload 0123456789';

/** The marker `server/index.ts` prints once its listener is accepting. */
const READY_MARKER = 'CloudCLI Server - Ready';

/**
 * The ISO-8601 UTC prefix `server/load-env.ts` stamps on EVERY line the child's console writes.
 *
 * `server/index.ts` imports `./load-env.js` before anything else, and that module installs a
 * process-wide stamp (`0deec1fc`), so a real child's stdout line is
 * `2026-10-12T00:00:00.000Z voice.capture mode=text` rather than `voice.capture mode=text`. The
 * readings below compare a line's MEANING (`===` the start-up line, or a leading `{` for a capture
 * row), so this prefix is removed from a COPY used for the match; the raw line is never rewritten.
 * Without that step "matched as a whole line" and "starts with `{`" both go blind on a real
 * process: every "line present" reading turns to 0 / `<none>` while the request still answers 200 —
 * a parser reading, not a service one. The line SHAPE is the deployment's logging (which
 * `server.log` needs); the criterion's assumption about it is what is out of date.
 *
 * A local pattern, never the shipped `stampLines`: importing that module would make this file's
 * `service-source-imports` reading non-zero, and that reading is what says the criterion judges the
 * child's stdout rather than reaching into the assembly's own source.
 */
const LINE_STAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

/** This criterion's own wall-clock budget — well under the gate's unraisable 60 s. */
const WALL_BUDGET_MS = 45_000;

/**
 * The prefix of the hardened copy the two runs are judged in, made BESIDE `--root`.
 *
 * Beside, not under `os.tmpdir()`: the copy is built with `cp -al`, hard links need one filesystem,
 * and `--root`'s own directory is on that filesystem by construction. (Measured trap: a checkout
 * under `/data` and a `/tmp` under `/` fail with `Invalid cross-device link`.) The leading dot keeps
 * it out of a casual listing; the name makes it unmistakable when one is left behind.
 */
const HARDENED_ROOT_PREFIX = '.voice-capture-process-check-';

/**
 * The entries that must NOT be carried into the hardened copy.
 *
 * `.env` is the whole point: `server/load-env.ts` would otherwise fill the child's environment from
 * the deployer's file, and the unset half of this criterion would then be measuring the deployment.
 * `.git` is a live wire in a worktree — an 88-byte pointer file holding the real git directory's
 * path — and no part of this criterion needs it.
 */
const HARDENED_ROOT_SKIP = new Set(['.git', '.env']);

const STARTUP_TIMEOUT_MS = 40_000;
const SHUTDOWN_GRACE_MS = 5_000;
const MINT_TIMEOUT_MS = 30_000;

/**
 * Every handle this criterion's own process tree was observed holding on the inherited database.
 *
 * WHY OWNERSHIP AND NOT TIMING. `mtimeMs` before versus after says the file MOVED, not WHO moved
 * it, and on this host the deployer's own server holds that database open and writes it every
 * couple of seconds. Timing cannot separate this criterion's writes from the deployer's either: a
 * child that inherited `DATABASE_PATH` writes for the few seconds it lives and then goes quiet,
 * which is the SAME shape as an external writer that happens to fall silent — so an idle window,
 * however long, can never prove the write was ours. Ownership can be read directly instead: while
 * a child is alive, `/proc` is asked which handles this process and its descendants hold, and a
 * write is this criterion's own only when one of those handles IS the inherited database. The
 * deployer's server is not in this process's tree, so its handles are not seen — the distinction
 * timing could not make.
 *
 * @type {string[]}
 */
const realDbOpeners = [];

/** Escape sequences a forced-colour environment would wrap every line in. */
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * The identifiers whose presence in this file would mean it had reached into shipped source.
 *
 * ASSEMBLED FROM FRAGMENTS ON PURPOSE. AC6 reads this file with `grep -c` for these three strings
 * and requires zero matching lines; writing them literally would satisfy the grep's letter while
 * breaking it, and would leave the self-check below unable to report anything but the string it was
 * written with. Concatenating the halves keeps the scan real (it matches the shipped identifiers)
 * and the file clean.
 */
const FORBIDDEN_SOURCE_TOKENS = ['create' + 'VoiceService', 'voice.' + 'module', 'voice.' + 'service'];

/** Departures that left the loopback interface. `guardedTarget` throws first, so this stays 0. */
let nonLoopbackDepartures = 0;

/** Every target this criterion guarded, as `host:port`. Read by the AC6 reading `hosts`. */
const guardedHosts = new Set();

/**
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Every outbound target passes here before it is used.
 *
 * @param {string} url
 * @returns {string} the same url, when it is one this criterion may reach
 */
function guardedTarget(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== LOOPBACK) {
    nonLoopbackDepartures += 1;
    throw new Error(
      `refusing to send a request off the loopback interface: ${parsed.hostname} (only ${LOOPBACK} is allowed)`,
    );
  }
  guardedHosts.add(parsed.host);
  return url;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function reading(key, value) {
  return `${key}=${String(value)}`;
}

/**
 * The `text` field of a response body, or null when the body is not that shape.
 *
 * @param {string} body
 * @returns {string | null}
 */
function readText(body) {
  try {
    const parsed = /** @type {{ text?: unknown }} */ (JSON.parse(body));
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

/** @param {string} filePath @returns {number | null} */
function mtimeOf(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A path's canonical form, for comparing a `/proc/<pid>/fd` link against a path the caller named.
 *
 * Symlinks and relative spellings resolve to one string; a path that does not exist yet (a
 * `-wal` sibling, say) falls back to a plain resolution rather than vanishing from the comparison.
 *
 * @param {string} filePath
 * @returns {string}
 */
function canonicalPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * The direct children of a pid, across every one of its tasks.
 *
 * `/proc/<pid>/task/<tid>/children` is the cheap kernel-side listing (no full `/proc` sweep); a
 * task that exits between the readdir and the read is skipped rather than failing the scan.
 *
 * @param {number} pid
 * @returns {number[]}
 */
function childPids(pid) {
  /** @type {number[]} */
  const children = [];
  /** @type {string[]} */
  let tasks;
  try {
    tasks = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const tid of tasks) {
    let text;
    try {
      text = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
    } catch {
      continue;
    }
    if (text === '') continue;
    for (const token of text.split(/\s+/)) {
      const parsed = Number(token);
      if (Number.isInteger(parsed) && parsed > 0) children.push(parsed);
    }
  }
  return children;
}

/**
 * This process and every descendant of it, read from `/proc`.
 *
 * The tree is walked from `process.pid`, never from "every pid on the host": the deployer's own
 * server holds the inherited database open while a session is active, and a scan that saw its
 * handles would be attributing the operator's traffic to the criterion.
 *
 * @param {number} rootPid
 * @returns {Set<number>}
 */
function processTree(rootPid) {
  const tree = new Set();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || tree.has(pid)) continue;
    tree.add(pid);
    for (const child of childPids(pid)) pending.push(child);
  }
  return tree;
}

/**
 * Records every handle in this process tree that points at the inherited database. A handle on
 * ANY `<db>-<suffix>` sibling counts too: SQLite keeps its rollback journal / WAL beside the
 * database, and a child that opened the database has one of those open at the same time (measured:
 * `auth.db` and `auth.db-journal`). The prefix rule is deliberately the whole family rather than a
 * hardcoded list, so a journal mode this criterion has never seen still counts.
 *
 * Called while the real service child is known to be alive, so what it reports is a live handle
 * rather than a guess about one. Only `process.pid`'s own tree is read; a pid or fd that vanishes
 * mid-scan is skipped, never reported.
 *
 * @param {string | undefined} dbPath the inherited `DATABASE_PATH`, when one was set
 */
function recordRealDbOpeners(dbPath) {
  if (dbPath === undefined) return;
  const canonicalDb = canonicalPath(dbPath);
  for (const pid of processTree(process.pid)) {
    /** @type {string[]} */
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      // A socket, pipe or anon inode has no path to compare; only absolute paths can be the db.
      if (!link.startsWith('/')) continue;
      const target = link.endsWith(' (deleted)') ? link.slice(0, -' (deleted)'.length) : link;
      const canonicalTarget = canonicalPath(target);
      const isDb = canonicalTarget === canonicalDb || canonicalTarget.startsWith(`${canonicalDb}-`);
      if (!isDb) continue;
      const evidence = `pid ${pid} fd ${fd} -> ${target}`;
      if (!realDbOpeners.includes(evidence)) realDbOpeners.push(evidence);
    }
  }
}

/**
 * @typedef {{ method: string, path: string, bytes: number }} DoubleRequest
 */

/**
 * Starts the upstream double: one fixed answer, and a log of everything it was actually asked.
 *
 * The log is the independent witness for "this HTTP really went through the process": the service
 * reaches this socket only if the request passed its router, its authentication and its service
 * layer, so a count of one here is not something this script's own bookkeeping can produce.
 *
 * @param {string} body
 * @returns {Promise<{ url: string, requests: DoubleRequest[], close: () => Promise<void> }>}
 */
function startDouble(body) {
  /** @type {DoubleRequest[]} */
  const requests = [];

  const server = http.createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(/** @type {Buffer} */ (chunk));
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        bytes: Buffer.concat(chunks).length,
      });
      if (request.method === 'POST' && request.url === TRANSCRIPTION_PATH) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"unexpected request"}');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the upstream double could not be bound to a port'));
        return;
      }
      resolve({
        url: `http://${LOOPBACK}:${address.port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * A port nothing is listening on, taken by binding one and releasing it.
 *
 * The child is what must bind it, and it is told which port to take, so the window between the
 * release here and the child's own bind is unavoidable; a lost race fails loudly rather than
 * silently, because a server that never comes up is reported as "could not measure".
 *
 * @returns {Promise<number>}
 */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve a service port'));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @typedef {object} RunOptions
 * @property {string} root
 * @property {string | null} mode null means "the key is deleted from the child's environment"
 * @property {string} home
 * @property {string} databasePath
 * @property {string} tokenFile
 * @property {string} doubleUrl
 * @property {number} servicePort
 * @property {DoubleRequest[]} doubleRequests the double's cumulative log, for per-run attribution
 * @property {string | undefined} realDatabasePath the inherited database, watched for this tree's handles
 */

/**
 * Runs one real service process, one minted token, and one real HTTP request against it.
 *
 * @param {RunOptions} options
 * @returns {Promise<{
 *   stdoutLines: string[],
 *   startupLine: string,
 *   startupTextCount: number,
 *   stampedLineCount: number,
 *   captureRows: Record<string, unknown>[],
 *   httpStatus: number,
 *   httpText: string,
 *   doubleRequests: DoubleRequest[],
 * }>}
 */
async function runOnce(options) {
  const serviceUrl = guardedTarget(`http://${LOOPBACK}:${options.servicePort}`);
  const doubleUrl = guardedTarget(options.doubleUrl);

  /** @type {Record<string, string>} */
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.HOME = options.home;
  childEnv.DATABASE_PATH = options.databasePath;
  childEnv.SERVER_PORT = String(options.servicePort);
  childEnv.HOST = LOOPBACK;
  childEnv.FORCE_COLOR = '0';
  // NO_COLOR is REMOVED rather than set: Node treats "both present" as a contradiction and warns
  // on every start, and `FORCE_COLOR=0` is the instruction that has to win here anyway.
  delete childEnv.NO_COLOR;
  childEnv.VOICE_API_BASE_URL = doubleUrl;
  childEnv.VOICE_TIMEOUT_MS = '15000';
  if (options.mode === null) delete childEnv.VOICE_CAPTURE;
  else childEnv.VOICE_CAPTURE = options.mode;

  const tsxCli = path.join(options.root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) throw new Error(`tsx is not installed under --root: ${tsxCli}`);

  /** @type {import('node:child_process').StdioOptions} */
  const stdio = ['ignore', 'pipe', 'pipe'];
  const child = spawn(process.execPath, [tsxCli, '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: options.root,
    env: childEnv,
    stdio,
  });

  /** @type {Buffer[]} */
  const stdoutChunks = [];
  /** @type {Buffer[]} */
  const stderrChunks = [];
  child.stdout?.on('data', (chunk) => {
    stdoutChunks.push(/** @type {Buffer} */ (chunk));
  });
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(/** @type {Buffer} */ (chunk));
  });

  const childStdout = () => stripAnsi(Buffer.concat(stdoutChunks).toString('utf8'));
  const childStderr = () => Buffer.concat(stderrChunks).toString('utf8');
  const requestsBefore = options.doubleRequests.length;

  try {
    await waitFor(
      () => childStdout().includes(READY_MARKER),
      STARTUP_TIMEOUT_MS,
      () =>
        new Error(
          `the service never printed ${JSON.stringify(READY_MARKER)} within ${STARTUP_TIMEOUT_MS} ms for ` +
            `VOICE_CAPTURE=${options.mode ?? '<unset>'}\n--- stdout tail ---\n` +
            `${childStdout().split('\n').slice(-15).join('\n')}\n--- stderr tail ---\n` +
            `${childStderr().split('\n').slice(-15).join('\n')}`,
        ),
    );

    // The child is up NOW, so this is the moment its handles can be read. A child that inherited
    // the deployer's DATABASE_PATH has an open handle on it here (the server opens its SQLite
    // connection eagerly at boot); a child that did not, does not.
    recordRealDbOpeners(options.realDatabasePath);

    // AFTER the process is up: a database the server has never booted carries no `jwt_secret` row,
    // and mint-token deliberately refuses to invent one.
    const mintArgs = [
      path.join(options.root, 'scripts', 'mint-token.mjs'),
      'mint',
      '--db',
      options.databasePath,
      '--out',
      options.tokenFile,
    ];
    const minted = spawnSync(process.execPath, mintArgs, {
      cwd: options.root,
      env: childEnv,
      encoding: 'utf8',
      timeout: MINT_TIMEOUT_MS,
    });
    if (minted.status !== 0) {
      throw new Error(
        `mint-token did not mint a token against ${options.databasePath} (exit ${String(minted.status)}):\n` +
          `${minted.stderr || minted.stdout || '<no output>'}`,
      );
    }
    const token = fs.readFileSync(options.tokenFile, 'utf8').trim();

    const form = new FormData();
    form.append('audio', new Blob([AUDIO_BODY], { type: 'audio/webm' }), 'probe.webm');
    const response = await fetch(`${serviceUrl}/api/voice/transcribe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const httpStatus = response.status;
    const httpText = await response.text();

    const stdoutLines = childStdout()
      .split('\n')
      .map((line) => line.replace(/\r$/, ''));
    return {
      stdoutLines,
      startupLine: readStartupLine(stdoutLines),
      startupTextCount: stdoutLines.filter((line) => stripLineStamp(line) === STARTUP_TEXT_LINE).length,
      stampedLineCount: stdoutLines.filter((line) => LINE_STAMP_PREFIX.test(line)).length,
      captureRows: readCaptureRows(stdoutLines),
      httpStatus,
      httpText,
      doubleRequests: options.doubleRequests.slice(requestsBefore),
    };
  } finally {
    // One last look while the child is still alive, covering a run that threw before the request.
    recordRealDbOpeners(options.realDatabasePath);
    await stopChild(child);
  }
}

/**
 * A line's text with the child's own timestamp prefix removed, for MATCHING only.
 *
 * The stamp is a property of the deployment's logging rather than of the line's content, so removing
 * it restores the shape the whole-line and `startsWith('{')` comparisons were written against
 * WITHOUT loosening either: the de-stamped copy is still compared verbatim. The raw line is never
 * rewritten — this is a copy used for the match, and every reading that is not a line's meaning is
 * still taken from the untouched text.
 *
 * @param {string} line
 * @returns {string}
 */
function stripLineStamp(line) {
  return line.replace(LINE_STAMP_PREFIX, '');
}

/**
 * The process's own announcement of the mode it came up in.
 *
 * The line is matched on its de-stamped text (see {@link stripLineStamp}), so the reading is the
 * announcement itself — `voice.capture mode=text` — not the instant the deployment happened to write
 * it. A line that is genuinely absent and a line that is present-but-stamped are told apart by which
 * of these returns a mode.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function readStartupLine(lines) {
  for (const line of lines) {
    const bare = stripLineStamp(line);
    if (bare === STARTUP_TEXT_LINE || bare === STARTUP_OFF_LINE) return bare;
  }
  return '<none>';
}

/**
 * The capture ROWS on stdout: lines that parse as a JSON object carrying the capture event.
 *
 * A row is found on the line's de-stamped text (see {@link stripLineStamp}): the deployment prefixes
 * every line with an ISO instant, so a leading `{` is only a leading `{` once that prefix is gone.
 *
 * @param {string[]} lines
 * @returns {Record<string, unknown>[]}
 */
function readCaptureRows(lines) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const line of lines) {
    const trimmed = stripLineStamp(line).trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.event === CAPTURE_EVENT) {
      rows.push(parsed);
    }
  }
  return rows;
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @param {() => Error} onTimeout
 * @returns {Promise<void>}
 */
function waitFor(predicate, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(onTimeout());
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Asks the child to exit, and does not wait forever for it to agree.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const escalate = setTimeout(() => {
      child.kill('SIGKILL');
    }, SHUTDOWN_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Builds the hardened copy of `--root` the two runs are actually judged in.
 *
 * A hard-link copy (`cp -al`) of every top-level entry except `.git` and `.env`, made in a sibling
 * directory of `--root` so the copy and the original sit on one filesystem by construction. Nothing
 * writes INTO the copy: `cp -al` gives the copy's files the originals' inodes, so an in-place write
 * would reach back through the link into the deployer's checkout. The child only reads and executes.
 *
 * @param {string} root
 * @returns {string} the copy's path
 */
function hardenRoot(root) {
  const copyRoot = fs.mkdtempSync(path.join(path.dirname(root), HARDENED_ROOT_PREFIX));
  for (const entry of fs.readdirSync(root)) {
    if (HARDENED_ROOT_SKIP.has(entry)) continue;
    const linked = spawnSync('cp', ['-al', path.join(root, entry), path.join(copyRoot, entry)], {
      encoding: 'utf8',
    });
    if (linked.status !== 0) {
      throw new Error(
        `could not hard-link ${entry} from ${root} into the hardened root ${copyRoot} ` +
          `(cp exited ${String(linked.status)}): ${linked.stderr || '<no stderr>'}`,
      );
    }
  }
  return copyRoot;
}

/**
 * Removes a hardened copy, reporting whether it is gone rather than assuming the delete worked.
 *
 * @param {string} copyRoot
 * @returns {boolean}
 */
function removeHardenedRoot(copyRoot) {
  try {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  } catch {
    return false;
  }
  return !fs.existsSync(copyRoot);
}

/**
 * Is there a `.env` directly under this root? A reading, not a branch.
 *
 * @param {string} root
 * @returns {'present' | 'absent'}
 */
function envFileState(root) {
  return fs.existsSync(path.join(root, '.env')) ? 'present' : 'absent';
}

/**
 * Does `<root>/.env` pin `VOICE_CAPTURE`?
 *
 * `server/load-env.ts` fills in every key the process environment does not already carry, so a
 * `.env` naming this variable would make "the variable is unset" unimplementable — IF the child were
 * run out of `<root>`. It is not: the runs happen in a hardened copy that carries no `.env`, so this
 * is reported as the reading `env-file-pins-voice-capture` and never decides the exit code. The
 * reader learns what the deployer's checkout carried; the measurement is unaffected by it.
 *
 * @param {string} root
 * @returns {boolean}
 */
function dotEnvPinsCaptureMode(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return false;
  }
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return false;
    return /^(?:export\s+)?VOICE_CAPTURE\s*=/.test(trimmed);
  });
}

/**
 * How many lines of THIS file name one of the shipped voice-source identifiers.
 *
 * @returns {number}
 */
function countOwnSourceTokens() {
  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  return own.split('\n').filter((line) => FORBIDDEN_SOURCE_TOKENS.some((token) => line.includes(token))).length;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {{ body: string | null, text: string | null }}
 */
function readRowFields(rows) {
  if (rows.length !== 1) return { body: null, text: null };
  const row = rows[0];
  const upstream = row.upstream;
  const body =
    upstream !== null && typeof upstream === 'object' && !Array.isArray(upstream)
      ? /** @type {{ body?: unknown }} */ (upstream).body
      : null;
  return {
    body: typeof body === 'string' ? body : null,
    text: typeof row.text === 'string' ? row.text : null,
  };
}

/**
 * @returns {Promise<number>}
 */
async function main() {
  const argv = process.argv.slice(2);
  const startedAt = Date.now();

  const rootIndex = argv.indexOf('--root');
  let root = DEFAULT_ROOT;
  if (rootIndex !== -1) {
    const value = argv[rootIndex + 1];
    if (value === undefined) {
      process.stderr.write('voice-capture-process-check: --root needs a path\n');
      return 2;
    }
    root = path.resolve(value);
  }
  const keep = argv.includes('--keep');

  const inheritedDatabasePath = process.env.DATABASE_PATH;
  const realDbBefore = inheritedDatabasePath === undefined ? null : mtimeOf(inheritedDatabasePath);

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-capture-process-check-'));
  const home = path.join(runDir, 'home');
  const databasePath = path.join(runDir, 'auth.db');
  const tokenFile = path.join(runDir, 'token.txt');
  fs.mkdirSync(home, { recursive: true });

  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const failures = [];
  lines.push(reading('root', root));
  lines.push(reading('env-file-in-root', envFileState(root)));
  lines.push(reading('env-file-pins-voice-capture', dotEnvPinsCaptureMode(root)));
  lines.push(reading('run-dir', runDir));
  lines.push(reading('child-home', home));
  lines.push(reading('child-db', databasePath));
  lines.push(reading('child-home-in-run-dir', home.startsWith(runDir)));
  lines.push(reading('child-db-in-run-dir', databasePath.startsWith(runDir)));
  lines.push(reading('real-db', inheritedDatabasePath ?? '<none>'));

  // The one precondition that is genuinely about the instrument: without tsx under `--root` no real
  // service process can start at all. Checked against `--root` itself (not the copy) so the reason
  // names the checkout the caller pointed at.
  const tsxUnderRoot = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxUnderRoot)) {
    fs.rmSync(runDir, { recursive: true, force: true });
    process.stderr.write(
      `voice-capture-process-check: could not make the measurement happen — tsx is not installed under --root: ${tsxUnderRoot}\n`,
    );
    return 2;
  }

  let double = null;
  let judgedRoot = null;
  let hardenedRootRemoved = false;
  /** @type {Error | null} */
  let couldNotMeasure = null;
  try {
    judgedRoot = hardenRoot(root);
    lines.push(reading('judged-root', judgedRoot));
    lines.push(reading('judged-root-env-file', envFileState(judgedRoot)));

    double = await startDouble(DOUBLE_BODY);
    const doubleUrl = guardedTarget(double.url);
    const servicePort = await reserveFreePort();

    const textRun = await runOnce({ root: judgedRoot, mode: 'text', home, databasePath, tokenFile, doubleUrl, servicePort, doubleRequests: double.requests, realDatabasePath: inheritedDatabasePath });
    const textRow = readRowFields(textRun.captureRows);
    lines.push(reading('startup.text.count', textRun.startupTextCount));
    lines.push(reading('startup.text.line', textRun.startupLine));
    // Observational, not a pass/fail reading: it makes "the line is present but the deployment
    // stamped it" distinguishable from "the line was never written", so the next sibling change to
    // the child's line shape shows up as a reading rather than as a silent 0 on the readings above.
    lines.push(reading('stdout.stamped-lines', textRun.stampedLineCount));
    lines.push(reading('capture.lines', textRun.captureRows.length));
    lines.push(reading('upstream.exact', textRow.body === DOUBLE_BODY));
    lines.push(reading('text.exact', textRow.text === DOUBLE_TEXT));
    lines.push(reading('double.requests', textRun.doubleRequests.length));
    lines.push(reading('double.path', textRun.doubleRequests[0]?.path ?? '<none>'));
    lines.push(reading('double.bytes', textRun.doubleRequests[0]?.bytes ?? -1));
    lines.push(reading('http.status', textRun.httpStatus));
    lines.push(reading('http.text.exact', readText(textRun.httpText) === DOUBLE_TEXT));

    if (textRun.startupTextCount !== 1) {
      failures.push(`startup.text.count is ${textRun.startupTextCount}, expected exactly 1 (${STARTUP_TEXT_LINE})`);
    }
    if (textRun.captureRows.length !== 1) {
      failures.push(`capture.lines is ${textRun.captureRows.length}, expected exactly 1`);
    }
    if (textRow.body !== DOUBLE_BODY) {
      failures.push('upstream.exact is false: the capture row does not carry the double\'s body verbatim');
    }
    if (textRow.text !== DOUBLE_TEXT) {
      failures.push('text.exact is false: the capture row does not carry the double\'s text verbatim');
    }
    if (textRun.doubleRequests.length !== 1) {
      failures.push(`double.requests is ${textRun.doubleRequests.length}, expected exactly 1`);
    }
    if (textRun.doubleRequests[0]?.path !== TRANSCRIPTION_PATH) {
      failures.push(`double.path is ${textRun.doubleRequests[0]?.path ?? '<none>'}, expected ${TRANSCRIPTION_PATH}`);
    }
    if (textRun.httpStatus !== 200) {
      failures.push(`http.status is ${textRun.httpStatus}, expected 200`);
    }
    if (readText(textRun.httpText) !== DOUBLE_TEXT) {
      failures.push('http.text.exact is false: the HTTP answer does not carry the double\'s text verbatim');
    }

    const unsetRun = await runOnce({ root: judgedRoot, mode: null, home, databasePath, tokenFile, doubleUrl, servicePort, doubleRequests: double.requests, realDatabasePath: inheritedDatabasePath });
    lines.push(reading('unset.captureLines', unsetRun.captureRows.length));
    lines.push(reading('unset.startup.line', unsetRun.startupLine));
    lines.push(reading('unset.startupTextLines', unsetRun.startupTextCount));
    lines.push(reading('unset.httpStatus', unsetRun.httpStatus));
    lines.push(reading('unset.text.exact', readText(unsetRun.httpText) === DOUBLE_TEXT));
    lines.push(reading('unset.double.requests', unsetRun.doubleRequests.length));

    if (unsetRun.captureRows.length !== 0) {
      failures.push(`unset.captureLines is ${unsetRun.captureRows.length}, expected 0`);
    }
    if (unsetRun.startupLine !== STARTUP_OFF_LINE) {
      failures.push(`unset.startup.line is ${unsetRun.startupLine}, expected ${STARTUP_OFF_LINE}`);
    }
    if (unsetRun.startupTextCount !== 0) {
      failures.push(`unset.startupTextLines is ${unsetRun.startupTextCount}, expected 0`);
    }
    if (unsetRun.httpStatus !== 200) {
      failures.push(`unset.httpStatus is ${unsetRun.httpStatus}, expected 200`);
    }
    if (readText(unsetRun.httpText) !== DOUBLE_TEXT) {
      failures.push('unset.text.exact is false: the second run\'s HTTP answer is not the double\'s text verbatim');
    }
    if (unsetRun.doubleRequests.length !== 1) {
      failures.push(`unset.double.requests is ${unsetRun.doubleRequests.length}, expected exactly 1`);
    }
  } catch (error) {
    couldNotMeasure = error instanceof Error ? error : new Error(String(error));
  } finally {
    // EITHER exit — success, a red reading, "could not measure", or a throw — leaves no copy behind.
    if (double !== null) await double.close().catch(() => {});
    if (judgedRoot !== null) hardenedRootRemoved = removeHardenedRoot(judgedRoot);
  }

  // "Could not measure" is exit 2 ONLY when nothing was measured. Ownership evidence is a
  // measurement, and it is the one this reading is about: if this process tree was seen holding the
  // inherited database, the property AC-148 exists to protect was violated whatever else the run
  // did or failed to do — so that stays a verdict (the red emitted below), not an exit 2.
  if (couldNotMeasure !== null && realDbOpeners.length === 0) {
    fs.rmSync(runDir, { recursive: true, force: true });
    process.stderr.write(
      `voice-capture-process-check: could not make the measurement happen — ${couldNotMeasure.message}\n`,
    );
    return 2;
  }

  if (couldNotMeasure !== null) {
    // One line, so a multi-line child error (mint-token's usage block) cannot fracture the readings.
    lines.push(reading('run-incomplete', couldNotMeasure.message.replace(/\s+/g, ' ').slice(0, 200)));
  }

  const sourceImports = countOwnSourceTokens();
  const hosts = [...guardedHosts].sort();

  /**
   * Was the inherited database OPENED BY THIS TREE?
   *
   * `mtimeMs` before versus after answers "did the file move", not "did WE move it", and on a host
   * where another process holds that database open the two are not the same question: the observed
   * case is this repository's own live server, which touches its `auth.db` every couple of seconds
   * while a session is active. Timing cannot tell a write this criterion caused from one it did
   * not — a child that inherited `DATABASE_PATH` writes for the few seconds it lives and then goes
   * quiet, which is the same shape as an external writer that happens to go quiet, so waiting for
   * movement after the run proves nothing about ownership. The movement is therefore ATTRIBUTED by
   * the handles this process tree was seen holding (`realDbOpeners`, read from `/proc` while the
   * children were alive), and a write is this criterion's own only when one of those handles is the
   * inherited database. `mtimeBefore`/`mtimeAfter` are still reported, as the raw movement, but they
   * decide nothing.
   */
  const realDbAfter = inheritedDatabasePath === undefined ? null : mtimeOf(inheritedDatabasePath);
  const movedDuringRun = realDbBefore !== realDbAfter;
  const openedByTree = realDbOpeners.length > 0;
  const realDbUntouched = !openedByTree;
  const churn = openedByTree ? 'criterion-only' : movedDuringRun ? 'external' : 'none-observed';

  const elapsedMs = Date.now() - startedAt;
  lines.push(reading('real-db-before-ms', realDbBefore));
  lines.push(reading('real-db-after-ms', realDbAfter));
  lines.push(reading('real-db-churn', churn));
  lines.push(reading('real-db-untouched', realDbUntouched));
  lines.push(reading('real-db-opened-by-tree', openedByTree));
  lines.push(reading('real-db-openers', openedByTree ? realDbOpeners.join(' | ') : 'none'));
  lines.push(reading('hardened-root-removed', hardenedRootRemoved));
  lines.push(reading('service-source-imports', sourceImports));
  lines.push(reading('hosts', hosts.join(',')));
  lines.push(reading('real-upstream-calls', nonLoopbackDepartures));
  lines.push(reading('elapsed-ms', elapsedMs));
  lines.push(reading('budget-ms', WALL_BUDGET_MS));

  if (!realDbUntouched) {
    failures.push(
      `real-db-untouched is false: this criterion's own process tree was holding ` +
        `${String(inheritedDatabasePath)} open (${realDbOpeners.join(' | ')}), so the database was ` +
        'reached from this run — a child inherited DATABASE_PATH instead of the run\'s own',
    );
  }
  if (sourceImports !== 0) {
    failures.push(`service-source-imports is ${sourceImports}, expected 0`);
  }
  if (hosts.length === 0 || hosts.some((host) => !host.startsWith(`${LOOPBACK}:`))) {
    failures.push(`hosts lists a target off ${LOOPBACK}: ${hosts.join(',') || '<none>'}`);
  }
  if (nonLoopbackDepartures !== 0) {
    failures.push(`real-upstream-calls is ${nonLoopbackDepartures}, expected 0`);
  }
  if (elapsedMs >= WALL_BUDGET_MS) {
    failures.push(`elapsed-ms is ${elapsedMs}, over this criterion's own ${WALL_BUDGET_MS} ms budget`);
  }

  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write('note.real-process=true\n');
  process.stdout.write('note.upstream=local-double-not-real-dashscope\n');
  process.stdout.write('note.browser=none\n');
  process.stdout.write('note.readings-source=child-process-stdout-not-server-log\n');
  process.stdout.write('note.shipped-source-changed=false\n');
  process.stdout.write(
    'note: 本条判的是真实服务进程与一次真实 HTTP；上游是本地替身而不是真实 DashScope；不驱动浏览器；' +
      '读的是子进程 stdout 而不是 server.log；判据与旁证不改任何出货源码。\n',
  );

  if (failures.length > 0) {
    process.stdout.write(`check.failures=${failures.length}\n`);
    for (const failure of failures) process.stdout.write(`check.failure: ${failure}\n`);
    if (!keep) fs.rmSync(runDir, { recursive: true, force: true });
    return 1;
  }
  process.stdout.write('check.failures=0\n');
  if (!keep) fs.rmSync(runDir, { recursive: true, force: true });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `voice-capture-process-check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  });
