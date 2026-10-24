/**
 * Criterion for `scripts/isolated-instance.sh`.
 *
 * WHAT THIS FILE IS THE READING OF. The script exists because a copied live database plus the
 * default-on resident-restore pass relaunched one `claude --resume` per live session (16 of them
 * on 2026-10-24). Three claims have to be true, and each one is read here rather than asserted
 * about the script's source:
 *
 *   1. the settings file the server is pointed at says `residentRestore.enabled: false`;
 *   2. if the server log still reports `started>0`, `start` exits non-zero AND has already torn
 *      the instance down (the duplicate processes are not left running);
 *   3. `stop` addresses only `claudecodeui-session-<this server pid>-*` scopes — a stub
 *      `systemctl` records every invocation, and a foreign pid's scope must never be stopped.
 *
 * The product is not booted. A stub server answers `/health` and the auth routes, and a stub
 * `systemctl` answers `list-units` with one scope owned by THIS instance's pid plus one scope
 * owned by a foreign pid. That is enough: the mechanism under test is the script's isolation and
 * its pid-scoped teardown, not the server's own behaviour (pinned by the server's criterion).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'isolated-instance.sh');

/** A fixture's paths plus the environment both script invocations share. */
/** @typedef {{ dir: string, stateDir: string, sourceDb: string, systemctlLog: string, env: NodeJS.ProcessEnv }} Fixture */

/** The stub server: answers health + auth, and prints the restore line the script must read. */
const STUB_SERVER_SOURCE = [
  "import http from 'node:http';",
  '',
  'const port = Number(process.env.SERVER_PORT);',
  "const restoreStarted = Number(process.env.STUB_RESTORE_STARTED ?? '0');",
  'if (restoreStarted > 0) {',
  '  console.log(`[resident-restore] considered=${restoreStarted} started=${restoreStarted} failed=0 skipped=0 budgetExhausted=false`);',
  '} else {',
  "  console.log('[INFO] resident restore disabled by server settings');",
  '}',
  '',
  'const server = http.createServer((request, response) => {',
  "  if (request.url === '/health') {",
  "    response.writeHead(200, { 'content-type': 'application/json' });",
  "    response.end('{\"status\":\"ok\"}');",
  '    return;',
  '  }',
  "  if (request.url === '/api/auth/login' || request.url === '/api/auth/register') {",
  '    request.resume();',
  '    request.on(\'end\', () => {',
  "      response.writeHead(200, { 'content-type': 'application/json' });",
  "      response.end('{\"token\":\"stub-token\"}');",
  '    });',
  '    return;',
  '  }',
  '  response.writeHead(404);',
  '  response.end();',
  '});',
  "server.listen(port, '127.0.0.1');",
  "process.on('SIGTERM', () => { server.close(() => process.exit(0)); });",
  '',
].join('\n');

/**
 * The stub `systemctl`.
 *
 * `list-units` answers from the state dir: one scope embeds the pid in `server.pid` (this
 * instance's own) and one embeds a foreign pid, so a stop that ignores the pid filter is
 * observable. Stopping the own scope creates a marker, so the post-stop listing is empty and the
 * script's residual check can pass.
 */
const STUB_SYSTEMCTL_SOURCE = [
  '#!/usr/bin/env bash',
  'set -u',
  'printf \'%s\\n\' "$*" >> "$STUB_SYSTEMCTL_LOG"',
  'STATE_DIR="${STUB_STATE_DIR:?}"',
  'if [[ " $* " == *" list-units "* ]]; then',
  '  pid=""',
  '  [[ -f "$STATE_DIR/server.pid" ]] && pid="$(cat "$STATE_DIR/server.pid")"',
  '  if [[ -n "$pid" && ! -f "$STATE_DIR/stub-scope-stopped" ]]; then',
  "    printf 'claudecodeui-session-%s-stub.scope loaded active running test scope\\n' \"$pid\"",
  '  fi',
  "  printf 'claudecodeui-session-999999-other.scope loaded active running foreign scope\\n'",
  '  exit 0',
  'fi',
  'if [[ "${1:-}" == "--user" && "${2:-}" == "stop" ]]; then',
  '  unit="${3:-}"',
  '  if [[ "$unit" == claudecodeui-session-*-stub.scope ]]; then',
  '    touch "$STATE_DIR/stub-scope-stopped"',
  '  fi',
  'fi',
  'exit 0',
  '',
].join('\n');

/** Writes the stub server, the stub systemctl, and a one-user auth.db inside a fresh temp dir. */
/** @param {{ restoreStarted?: number }} [options] @returns {Fixture} */
function makeFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-instance-criterion-'));
  const stateDir = path.join(dir, 'state');
  const stubServer = path.join(dir, 'stub-server.mjs');
  const stubSystemctl = path.join(dir, 'stub-systemctl.sh');
  const systemctlLog = path.join(dir, 'systemctl.log');
  const sourceDb = path.join(dir, 'source-auth.db');

  fs.writeFileSync(stubServer, STUB_SERVER_SOURCE, 'utf8');
  fs.writeFileSync(stubSystemctl, STUB_SYSTEMCTL_SOURCE, 'utf8');
  fs.chmodSync(stubSystemctl, 0o755);

  const db = new Database(sourceDb);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('liveuser', '$2b$10$not-a-real-hash');
  db.close();

  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    ISOLATED_INSTANCE_STATE_DIR: stateDir,
    ISOLATED_INSTANCE_SERVER_ENTRY: stubServer,
    ISOLATED_INSTANCE_SOURCE_DB: sourceDb,
    ISOLATED_INSTANCE_START_TIMEOUT_MS: '15000',
    ISOLATED_INSTANCE_LOG_SETTLE_MS: '150',
    NODE_BIN: process.execPath,
    SYSTEMCTL_BIN: stubSystemctl,
    STUB_STATE_DIR: stateDir,
    STUB_SYSTEMCTL_LOG: systemctlLog,
    ...(options.restoreStarted === undefined
      ? {}
      : { STUB_RESTORE_STARTED: String(options.restoreStarted) }),
  };

  return { dir, stateDir, sourceDb, systemctlLog, env };
}

/** Runs one script subcommand and parses nothing — the caller reads stdout/stderr. */
/** @param {Fixture} fixture @param {string[]} args */
function runScript(fixture, args) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** Reads the JSON line the script prints on stdout. */
/** @param {string} stdout */
function parseSummary(stdout) {
  const line = stdout.trim().split('\n').filter((entry) => entry.startsWith('{')).pop();
  assert.ok(line, `the script must print a JSON summary on stdout; got: ${stdout}`);
  return JSON.parse(line);
}

/** True when a pid is alive (EPERM still means a process exists). */
/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

test('start forces resident restore off and stop addresses only this instance\'s scopes', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const started = runScript(fixture, ['start']);
  assert.equal(started.status, 0, `start must succeed\nstdout=${started.stdout}\nstderr=${started.stderr}`);
  const summary = parseSummary(started.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.resident_restore_started, 0);
  assert.match(String(summary.base_url), /^http:\/\/127\.0\.0\.1:\d+$/);

  const settingsFile = String(summary.settings_file);
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.residentRestore.enabled, false, 'the generated settings file must force restore off');
  assert.equal(fs.readFileSync(String(summary.token_file), 'utf8'), 'stub-token');
  assert.equal(pidAlive(Number(summary.pid)), true, 'the instance server must be running after start');

  const stopped = runScript(fixture, ['stop']);
  assert.equal(stopped.status, 0, `stop must succeed\nstdout=${stopped.stdout}\nstderr=${stopped.stderr}`);
  const stopSummary = parseSummary(stopped.stdout);
  assert.equal(stopSummary.ok, true);
  assert.equal(stopSummary.residual_scopes, '');
  assert.equal(stopSummary.port_still_serving, false);
  assert.equal(pidAlive(Number(summary.pid)), false, 'stop must terminate the server it started');

  const calls = fs.readFileSync(fixture.systemctlLog, 'utf8');
  assert.match(calls, new RegExp(`--user stop claudecodeui-session-${summary.pid}-stub\\.scope`));
  assert.doesNotMatch(calls, /999999-other/);
});

test('a restore pass that started sessions fails the start and leaves nothing running', (t) => {
  const fixture = makeFixture({ restoreStarted: 2 });
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const started = runScript(fixture, ['start']);
  assert.notEqual(started.status, 0, 'start must exit non-zero when resident restore started sessions');
  assert.match(started.stderr, /resident restore STARTED 2 session/);

  // The teardown ran: the pid file is gone, the scope was stopped, and the port is not serving.
  assert.equal(fs.existsSync(path.join(fixture.stateDir, 'server.pid')), false);
  const calls = fs.readFileSync(fixture.systemctlLog, 'utf8');
  assert.match(calls, /--user stop claudecodeui-session-\d+-stub\.scope/);
  assert.doesNotMatch(calls, /999999-other/);

  const portFile = path.join(fixture.stateDir, 'server.port');
  const port = fs.readFileSync(portFile, 'utf8');
  const health = spawnSync('curl', ['-m', '1', '-fsS', `http://127.0.0.1:${port}/health`], { encoding: 'utf8' });
  assert.notEqual(health.status, 0, 'the failed start must not leave its server serving');

  // The isolation file was written before boot, so it is still there to explain what was tried.
  const settings = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'server.settings.json'), 'utf8'));
  assert.equal(settings.residentRestore.enabled, false);
});
