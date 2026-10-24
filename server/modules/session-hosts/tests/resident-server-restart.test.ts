/**
 * AC-166: the server boundary, measured on a real server process.
 *
 * Every other criterion in this module drives the host layer in-process. This
 * one drives the thing an operator actually runs — `tsx server/index.ts` as a
 * child process, with its own temporary database, its own home, and a real
 * Claude CLI behind it — and then stops it two ways:
 *
 *  1. `SIGTERM`, which is the graceful path: the server's shutdown closes every
 *     host with `server-shutdown` and stops the scopes it owns, so the resident
 *     process must be gone and the reason must be on the record.
 *  2. `SIGKILL`, which is the path the graceful one cannot cover: nothing of the
 *     server runs, so whatever it left behind is orphaned, and the only thing
 *     that can reap it is the next server's start-up sweep.
 *
 * Then it restarts and reads what a client would read: the session is still
 * stored as resident, the listing says it is not running and why, and the next
 * `chat.send` opens a *new* process rather than reusing the dead one's pid.
 *
 * ## Why the group kill spares the session
 *
 * The AC says to signal the service's process group, and this criterion does —
 * with one member excepted, the resident session's own subtree. That exception
 * is measured, not stylistic: `systemd-run --user --scope` `exec`s the target in
 * the same PID, and neither the SDK nor the scope hook passes `detached`, so the
 * CLI inherits the server's process group (`ps -o pid,pgid` on a live session
 * shows one pgid for the whole tree). A literal group kill therefore reaps the
 * session along with the server, which makes the thing this leg exists to
 * measure — the next boot's sweep — unreachable: the transient scope is
 * collected the moment its last process dies, so there would be nothing left to
 * sweep and the reading would be vacuously clean. Sparing the session is what
 * makes the residue real, and the residue is the subject.
 *
 * Only the session is spared: the wrapper chain (`npm exec` → `sh` → `tsx` →
 * the server) is killed outright, so the server never runs its shutdown and the
 * leg really is the hard-kill path.
 *
 * ## What would make this criterion lie
 *
 * A green run that never reached the mock endpoint, a "gone" reading taken from
 * a host record instead of `/proc`, or a budget guard that could not fail. Each
 * is closed by a positive control: the mock counts the requests it answers, the
 * pid readings come from `/proc/<pid>/stat`, "alive before the term" is printed
 * before the signal, the budget threshold is asserted on both sides, and the
 * per-run control session proves the reason field is not filled for every row.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import WebSocket from 'ws';

import { stopResidentScopes } from '@/modules/providers/index.js';
import { RESIDENT_NOT_RUNNING_REASON } from '@/modules/session-hosts/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SERVER_ENTRY = 'server/index.ts';
const PROVIDER = 'claude';

/** A model entry, not a built-in name: only a custom entry's env reaches the spawn. */
const MODEL_ID = 'resident-restart-model';
const MODEL_SECRET = 'resident-restart-model-secret';
/** The host Anthropic key. It must survive in no request the mock receives. */
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

/** How long the server is given to answer `/health` after being spawned. */
const BOOT_TIMEOUT_MS = 25_000;
/**
 * How long one `chat.send` is given to reach its terminal frame — and, at the
 * three `waitForResidentPid` call sites, how long a real resident `claude` host
 * is given to (re)spawn and register.
 *
 * ## Why it carries load headroom
 *
 * That wait shelters a real Claude process launching under whatever load the
 * host is carrying, and that load is not this repo's to control. It is not
 * hypothetical either: on 2026-10-04 the same criterion, in the same worktree,
 * with other real-server criteria running concurrently, took 38_900ms for a
 * single re-spawn against 8_700ms standalone — a 4.5x oversubscription
 * inflation, one re-spawn alone past the old 30_000ms wait, and the red landed
 * at `waitForResidentPid` ("Timed out after 30000ms…") on leg 5's third spawn.
 *
 * The response is headroom, not a bet that the load will not recur: the wait
 * must exceed `MEASURED_LANE_ROUND_MS x ROUND_LOAD_MARGIN`, and that relation is
 * asserted (AC1b) rather than commented, so shrinking it back reds a named case.
 */
const ROUND_TIMEOUT_MS = 60_000;
/**
 * The worst wall time one resident-host (re)spawn wait was measured at on this
 * host under concurrent lane load, in ms (2026-10-04: in-lane 38_900 vs
 * standalone 8_700. Re-measured 2026-10-05 against the same three heavy
 * siblings — standalone 10_262ms, concurrent 10_106ms — i.e. the inflation is
 * transient and not reproducible to order, which is exactly why the fix is
 * headroom rather than a change to the trigger source.)
 */
const MEASURED_LANE_ROUND_MS = 38_900;
/**
 * The load margin a single per-round wait must carry over `MEASURED_LANE_ROUND_MS`.
 * The trigger (a real `claude` re-spawn delayed by lane load) is outside this
 * repo's control, so the load-invariant response is headroom over the measured
 * worst case; AC1b asserts it.
 */
const ROUND_LOAD_MARGIN = 1.5;
/** How long a process is given to leave after a signal. */
const GONE_TIMEOUT_MS = 20_000;
/** How long the scope listing is given to become empty after a sweep. */
const SCOPE_TIMEOUT_MS = 15_000;

/**
 * The process-level budget, in milliseconds. See `guard` — and see AC7 for why it
 * is a function.
 *
 * Its value is the arithmetic the AC1 test asserts: the three `boot()` calls at
 * their `BOOT_TIMEOUT_MS` deadline (3 x 25_000 = 75_000), plus one round
 * (60_000 — the load-headroom value AC1b pins), one gone-wait (20_000) and one
 * scope-wait (15_000) — a floor of 170_000ms — plus headroom for module load,
 * the mock endpoint, HTTP round trips and the sweep retries.
 *
 * It used to be a bare 60_000, which the three boots alone (75_000) already
 * exceeded: on 2026-10-02 a run whose servers had each reached
 * `CloudCLI Server - Ready` was killed at the 60s boundary with `exit=3` because
 * the budget, not the boot, was too small — and a process-level kill names no
 * `node:test` case, which is why that red could not be attributed.
 *
 * Deliberately NOT written as a function of the deadline constants: a budget that
 * equals its own derivation could never fail AC1, and AC1 is the invariant that
 * stops this regressing. Keeping the budget an independent value is what lets the
 * AC1 assertion catch a deadline outgrowing it.
 */
const BUDGET_MS = 240_000;
/** The wall clock starts at import, so `elapsed` covers module load as well as the legs. */
const STARTED_AT = Date.now();

/**
 * The exit code a run at `elapsedMs` owes against `budgetMs`.
 *
 * A pure function so the threshold is falsifiable in both directions instead of
 * being a `setTimeout` nobody can test: over budget answers 3, at or under it
 * answers 0. Both returns are asserted and printed below, which is what makes
 * "the guard is load-bearing" a reading rather than a claim.
 */
export function guard({ elapsedMs, budgetMs }: { elapsedMs: number; budgetMs: number }): number {
  return elapsedMs > budgetMs ? 3 : 0;
}

const budgetTimer = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget-ms=${BUDGET_MS} elapsed-ms=${elapsed} exit=3 — the server boundary did not finish ` +
      'inside its process budget (a process-level kill, not a node:test case failure).',
  );
  process.exit(guard({ elapsedMs: elapsed, budgetMs: BUDGET_MS }));
}, BUDGET_MS);
// Unref'd so the guard cannot itself hold the process open once the legs finish.
budgetTimer.unref();

// ------------------------------------------------------- budget invariant (AC1/AC2)

/**
 * AC1 — the load-bearing invariant: the process budget must not be smaller than
 * the sum of the step deadlines it shelters.
 *
 * The three `boot()` calls below each wait up to `BOOT_TIMEOUT_MS`; on top of
 * those run one round, one gone-wait and one scope-wait, each at its own
 * deadline. Summed, that is 170_000ms. A `BUDGET_MS` below that kills a run whose
 * legs merely approached (but did not exceed) their per-step deadlines — a
 * slowdown mis-read as a hang, with `process.exit(3)` naming no case.
 *
 * The relation is asserted, not commented: hardcoding the budget back to 60_000,
 * or growing any deadline past the budget, reds this named case.
 */
test('AC1: the process budget is not smaller than the sum of its step deadlines', () => {
  const floorMs = 3 * BOOT_TIMEOUT_MS + ROUND_TIMEOUT_MS + GONE_TIMEOUT_MS + SCOPE_TIMEOUT_MS;
  assert.ok(
    BUDGET_MS >= floorMs,
    `BUDGET_MS (${BUDGET_MS}ms) is below the sum of its step deadlines (${floorMs}ms): a ` +
      'load-slowed-but-successful boot sequence would be killed by the process guard (exit 3) ' +
      'instead of running to completion, and node:test would name no failing case',
  );
});

/**
 * AC1b — the per-leg load margin: the wait that shelters one resident (re)spawn
 * must clear the worst figure measured under lane load *with margin*, not sit at
 * or under it.
 *
 * AC1 bounds the *sum* of the step deadlines under the process budget; it says
 * nothing about whether any single deadline is large enough to survive the load
 * the host is under. That is the gap the 2026-10-04 red fell through: the floor
 * was satisfied, yet one re-spawn past 30_000ms red at `waitForResidentPid`
 * (`:776`), because `ROUND_TIMEOUT_MS` — the tightest leg, shared by all three
 * boots — carried no margin over the lane-load figure at all.
 *
 * Hardcoding `ROUND_TIMEOUT_MS` back to a value below
 * `MEASURED_LANE_ROUND_MS x ROUND_LOAD_MARGIN` reds this named case: the margin
 * is a reading, not a comment.
 */
test('AC1b: the per-round wait carries the measured lane-load margin', () => {
  const requiredMs = MEASURED_LANE_ROUND_MS * ROUND_LOAD_MARGIN;
  assert.ok(
    ROUND_TIMEOUT_MS >= requiredMs,
    `ROUND_TIMEOUT_MS (${ROUND_TIMEOUT_MS}ms) is below the measured lane-load requirement ` +
      `(${MEASURED_LANE_ROUND_MS}ms x ${ROUND_LOAD_MARGIN} = ${requiredMs}ms): a resident ` +
      '(re)spawn slowed by concurrent lane load would time out at `waitForResidentPid` even ' +
      'though it was still going to succeed — the load red this margin exists to absorb.',
  );
});

/**
 * AC2 — the positive control for AC1: the budget must actually shelter the worst
 * case AC1 sums, not merely outnumber it.
 *
 * The same three-boot ceiling is fed to `guard` as an elapsed time — the way a
 * real run that burned every deadline would arrive there. It must answer 0
 * (finish), while a run genuinely past the budget must still answer 3, so a
 * change that grows and shrinks every constant together cannot satisfy AC1 by
 * moving both sides of the inequality.
 */
test('AC2: a run at every step deadline still finishes inside the budget (guard answers 0)', () => {
  const worstCaseMs = 3 * BOOT_TIMEOUT_MS + ROUND_TIMEOUT_MS + GONE_TIMEOUT_MS + SCOPE_TIMEOUT_MS;
  assert.equal(
    guard({ elapsedMs: worstCaseMs, budgetMs: BUDGET_MS }),
    0,
    `a run that burned every step deadline (${worstCaseMs}ms) was still killed at ${BUDGET_MS}ms`,
  );
  assert.equal(
    guard({ elapsedMs: BUDGET_MS + 1, budgetMs: BUDGET_MS }),
    3,
    'the guard no longer answers 3 for a run that is genuinely over budget',
  );
});

// ---------------------------------------------------------------- mock endpoint

type Received = {
  url: string;
  body: string;
  authorization: string | undefined;
};

type MockAnthropic = {
  received: Received[];
  baseUrl: string;
  /** Requests answered with a streaming `/v1/messages` reply. */
  turns(): number;
  /**
   * Holds every `/v1/messages` reply instead of answering it.
   *
   * This is what keeps a resident CLI *in flight*: a process waiting on a
   * response that will not arrive is a process that has work in hand and has not
   * yet reached the end of its turn — which is the only state in which one can
   * outlive its server. The alternative, a session sitting idle between turns,
   * ends the moment its stdin closes, so killing the server there would leave no
   * orphan to find and the sweep below would have nothing to prove.
   */
  hold(): void;
  /** Answers everything held so far, and stops holding. */
  release(): void;
  /** How many replies are being withheld right now. */
  heldCount(): number;
  close(): Promise<void>;
};

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Minimal valid streaming `/v1/messages` reply: one text block, then `end_turn`. */
function messageStream(): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * An Anthropic-compatible endpoint that records what it was sent.
 *
 * The recording is what turns "the turn completed" into "the turn completed
 * against *this* endpoint": a `chat.send` that never reached here would still
 * produce a terminal frame if something else answered, and the count is what
 * makes that impossible.
 */
async function startMockAnthropic(): Promise<MockAnthropic> {
  const received: Received[] = [];
  const held: Array<() => void> = [];
  let holding = false;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      received.push({
        url,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization,
      });

      if (url.split('?')[0] !== '/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }

      const answer = () => {
        // The client this reply was held for is often dead by the time it is
        // released — the sweep kills it — and answering a destroyed socket
        // throws inside this server's own callback.
        if (response.writableEnded || response.destroyed) {
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(messageStream());
      };

      if (holding) {
        held.push(answer);
        return;
      }
      answer();
    });
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;

  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    turns: () => received.filter((request) => request.url.split('?')[0] === '/v1/messages').length,
    hold: () => { holding = true; },
    release: () => {
      holding = false;
      for (const answer of held.splice(0)) {
        answer();
      }
    },
    heldCount: () => held.length,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// ------------------------------------------------------------------ process table

type ProcessRow = { pid: number; pgid: number; ppid: number; args: string };

/** The process table, as `/proc` and `ps` report it for this host. */
function processTable(): ProcessRow[] {
  const result = spawnSync('ps', ['-eo', 'pid=,pgid=,ppid=,args='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      ppid: Number(match[3]),
      args: match[4],
    });
  }
  return rows;
}

/**
 * The state character from `/proc/<pid>/stat`, or null when there is no such pid.
 *
 * A zombie is not alive: it exists in the table only because nobody reaped it,
 * and a `Z` would let "the process ended" pass while the CLI was still a corpse.
 * Reading the state rather than mere existence is what keeps a "gone" reading
 * honest.
 */
function processState(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return stat.slice(close + 2, close + 3);
  } catch {
    return null;
  }
}

/** True while `pid` is a live, non-zombie process. */
function isAlive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }
  const state = processState(pid);
  return state !== null && state !== 'Z';
}

/** Every descendant of `root`, root included. */
function subtree(root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of processTable()) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }

  const found = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
    }
  }
  return found;
}

type SignalReport = { killed: number[]; spared: number[] };

/**
 * Kills the service's process group, sparing `spare`'s subtree.
 *
 * See the file docstring for why the session is spared. Everything else in the
 * group — the `npm exec` leader, the `sh`/`tsx` wrappers, the server itself — is
 * signalled, so this really is the hard-kill path and the server's shutdown
 * never runs. `SIGKILL` is what the leg is named for; the signal is a parameter
 * because the graceful leg sends `SIGTERM` through the same helper and must be
 * sparing for the same measured reason.
 */
function signalServiceGroup(leaderPid: number, spare: number | null, signal: NodeJS.Signals): SignalReport {
  const spared = spare === null ? new Set<number>() : subtree(spare);
  const killed: number[] = [];

  const members = processTable().filter((row) => row.pgid === leaderPid);
  for (const row of members) {
    if (spared.has(row.pid)) {
      continue;
    }
    try {
      process.kill(row.pid, signal);
      killed.push(row.pid);
    } catch {
      // Exited between the table read and the signal.
    }
  }

  return { killed, spared: [...spared] };
}

/** Polls a predicate until it holds, and says what it was waiting for when it gives up. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

// --------------------------------------------------------------------- the server

type ServerReading = {
  /** The `detached` spawn's pid: the process *group* leader, not the server itself. */
  leaderPid: number;
  port: number;
  logPath: string;
  /** The real server pid, from the marker the product writes into its own home. */
  serverPid(): number | null;
  logText(): string;
  /** `/proc/<leader>/environ`, the proof that the child got the environment it was handed. */
  environment(): string;
  stop(signal: NodeJS.Signals, spare: number | null): SignalReport;
};

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Boots a real server: `tsx server/index.ts`, in its own process group, with its
 * output on a file descriptor.
 *
 * The group is what makes the kill legs possible at all — `tsx` runs the server
 * as a grandchild, so `child.kill()` would only reap a wrapper. The log goes to
 * a file rather than a pipe because a pipe nobody drains fills and blocks the
 * server that is being measured.
 */
async function bootServer(input: { tempRoot: string }): Promise<ServerReading> {
  const port = await freePort();
  const logPath = path.join(input.tempRoot, `server-${port}.log`);
  const logFd = fs.openSync(logPath, 'a');

  // The ambient shell exports a database path, a host, and a port for its own
  // reasons; every one of them is dropped here so the child can only see the
  // values this criterion hands it. The database path in particular is not
  // overridable by `HOME`, so a child that inherited it would write the
  // operator's real database.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'DATABASE_PATH',
    'HOST',
    'SERVER_PORT',
    'JWT_SECRET',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_RESIDENT_BUDGET_MS',
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    DATABASE_PATH: path.join(input.tempRoot, 'auth.db'),
    HOME: path.join(input.tempRoot, 'home'),
    CLAUDE_CONFIG_DIR: path.join(input.tempRoot, 'claude-config'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    // A dead endpoint: the model entry is the only route to the mock, so a turn
    // that reaches the mock is proof the entry was consulted.
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: HOST_SENTINEL,
  });

  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  const leaderPid = child.pid;
  assert.ok(leaderPid !== undefined, 'the server child has no pid; the boot never happened');

  const markerPath = path.join(input.tempRoot, 'home', '.cloudcli', 'local-server.json');
  const reading: ServerReading = {
    leaderPid,
    port,
    logPath,
    serverPid: () => {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { pid?: number };
        return typeof marker.pid === 'number' ? marker.pid : null;
      } catch {
        return null;
      }
    },
    logText: () => {
      try {
        return fs.readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
    environment: () => {
      try {
        return fs.readFileSync(`/proc/${leaderPid}/environ`, 'utf8').split('\0').join('\n');
      } catch {
        return '';
      }
    },
    stop: (signal, spare) => signalServiceGroup(leaderPid, spare, signal),
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The server on port ${port} never answered /health within ${BOOT_TIMEOUT_MS}ms.\n` +
          `--- ${logPath} ---\n${reading.logText().slice(-4000)}`,
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }

  return reading;
}

// ------------------------------------------------------------------------ HTTP

type ApiAnswer = { status: number; body: Record<string, unknown> };

async function api(
  port: number,
  token: string,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<ApiAnswer> {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: (parsed ?? {}) as Record<string, unknown> };
}

/** Unwraps the standard `{ success, data }` envelope, failing loudly when it is absent. */
function dataOf(answer: ApiAnswer, label: string): Record<string, unknown> {
  assert.ok(
    answer.status >= 200 && answer.status < 300,
    `${label} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
  );
  const data = answer.body.data;
  assert.ok(data !== null && typeof data === 'object', `${label} answered no data envelope`);
  return data as Record<string, unknown>;
}

/**
 * Mints a revocable observation token against the criterion's own database.
 *
 * `GET /api/session-hosts` sits behind `authenticateToken`, and the token has to
 * be signed with the secret of the database the server is using — which is a
 * temporary one, so this is the only way to get a credential for it. The tool
 * refuses when `JWT_SECRET` is reachable from the environment, which is why the
 * boot environment drops it and so does this call.
 */
async function mintToken(databasePath: string, outPath: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JWT_SECRET;

  const result = spawnSync(
    'node',
    ['scripts/mint-token.mjs', 'mint', '--db', databasePath, '--out', outPath],
    { cwd: REPO_ROOT, env, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `mint-token refused: ${result.stderr || result.stdout || '(no output)'}`,
  );

  return fs.readFileSync(outPath, 'utf8').trim();
}

// ------------------------------------------------------------------- chat socket

type ChatSocket = {
  socket: WebSocket;
  /** Everything the server has sent, in order. */
  frames: Array<Record<string, unknown>>;
  close(): void;
};

async function connectChat(port: number, token: string): Promise<ChatSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const frames: Array<Record<string, unknown>> = [];

  socket.on('message', (raw: Buffer) => {
    try {
      frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    } catch {
      // A frame this criterion cannot read is not a frame it can act on.
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (error: Error) => reject(error));
  });

  return {
    socket,
    frames,
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

function completesOf(chat: ChatSocket): Array<Record<string, unknown>> {
  return chat.frames.filter((frame) => frame.kind === 'complete');
}

/**
 * Sends one turn over the real websocket and waits for its terminal frame.
 *
 * The frame the run ends on is `kind === 'complete'`; `error` frames are turned
 * into a failure with their text, because a turn that errored never reached the
 * assertion and saying so is more useful than a timeout.
 */
async function sendTurn(
  chat: ChatSocket,
  sessionId: string,
  content: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  const before = completesOf(chat).length;
  const framesBefore = chat.frames.length;

  chat.socket.send(JSON.stringify({
    type: 'chat.send',
    sessionId,
    content,
    options: { cwd, model: MODEL_ID, permissionMode: 'default' },
  }));

  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const completes = completesOf(chat);
    if (completes.length > before) {
      return completes[completes.length - 1];
    }
    const errors = chat.frames.slice(framesBefore).filter((frame) => frame.kind === 'error');
    if (errors.length > 0) {
      throw new Error(`The turn "${content}" failed: ${JSON.stringify(errors[0])}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }

  throw new Error(`Timed out after ${ROUND_TIMEOUT_MS}ms waiting for the turn "${content}" to complete.`);
}

// ------------------------------------------------------------------- host reading

type HostView = {
  hostId: string;
  provider: string;
  mode: string;
  state: string;
  pid: number | null;
  closeReason: string | null;
  bindings: Array<{ appSessionId: string }>;
};

type SessionState = {
  appSessionId: string;
  lifecycleMode: string;
  running: boolean;
  reason: string | null;
};

type HostListing = { hosts: HostView[]; sessions: SessionState[] };

async function readHosts(port: number, token: string): Promise<HostListing> {
  const data = dataOf(await api(port, token, 'GET', '/api/session-hosts'), 'GET /api/session-hosts');
  const hosts = data.hosts as HostView[] | undefined;
  // The session half is the surface this task adds; a listing without it is a
  // failure of the criterion's own subject, not a shape to work around.
  assert.ok(Array.isArray(hosts), 'the listing has no hosts array');
  assert.ok(Array.isArray(data.sessions), 'the listing has no sessions array');
  return { hosts, sessions: data.sessions as SessionState[] };
}

/** The live resident host serving one session, or null. */
function residentHostOf(listing: HostListing, sessionId: string): HostView | null {
  return (
    listing.hosts.find(
      (host) =>
        host.state !== 'closed' &&
        host.mode === 'resident' &&
        host.bindings.some((binding) => binding.appSessionId === sessionId),
    ) ?? null
  );
}

function sessionStateOf(listing: HostListing, sessionId: string): SessionState | null {
  return listing.sessions.find((session) => session.appSessionId === sessionId) ?? null;
}

/** Polls the listing until a live resident host with a pid serves the session. */
async function waitForResidentPid(
  port: number,
  token: string,
  sessionId: string,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listing = await readHosts(port, token);
    const host = residentHostOf(listing, sessionId);
    if (host && typeof host.pid === 'number' && isAlive(host.pid)) {
      return host.pid;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
}

// ------------------------------------------------------------------- scope reading

type ScopeReading = {
  available: boolean;
  units(): string[];
  raw(pattern: string): string;
};

/**
 * The scope surface, as an operator would read it.
 *
 * `available: false` is the honest degradation: a host with no systemd user
 * manager never scopes its sessions, so there is nothing to sweep and the leg
 * says so instead of passing on an empty list it could not have filled.
 */
function readScopes(): ScopeReading {
  const listing = () =>
    spawnSync('systemctl', ['--user', 'list-units', 'claudecodeui-session-*', '--no-legend', '--plain'], {
      encoding: 'utf8',
    });

  const first = listing();
  const available = !first.error && first.status === 0;

  return {
    available,
    units: () => {
      if (!available) {
        return [];
      }
      return (listing().stdout ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((unit) => unit.startsWith('claudecodeui-session-') && unit.endsWith('.scope'));
    },
    raw: (pattern: string) => {
      const result = spawnSync('systemctl', ['--user', 'list-units', pattern, '--no-legend', '--plain'], {
        encoding: 'utf8',
      });
      return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    },
  };
}

/** The `swept` reading from one boot's log: the count, or 0 when the line is absent. */
function sweptFrom(log: string): number {
  const match = /Swept (\d+) orphaned Claude session scope\(s\)/.exec(log);
  return match ? Number(match[1]) : 0;
}

/** Every `shutdown-close` line one server's log carries. */
function shutdownCloseLines(log: string): Array<{ pid: number | null; reason: string }> {
  const lines: Array<{ pid: number | null; reason: string }> = [];
  for (const line of log.split('\n')) {
    if (!line.includes('shutdown-close')) {
      continue;
    }
    const pid = /pid=(\d+|none)/.exec(line)?.[1] ?? 'none';
    const reason = /closeReason=(\S+)/.exec(line)?.[1] ?? '';
    lines.push({ pid: pid === 'none' ? null : Number(pid), reason });
  }
  return lines;
}

// -------------------------------------------------------------------------- test

test('a stopped or killed server leaves no resident process behind, and the next boot says so', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'resident-server-restart-'));
  const scopes = readScopes();
  const mock = await startMockAnthropic();
  const booted: ServerReading[] = [];
  // The real pid of every server this run booted. The marker file is shared across the boots, so
  // `serverPid()` only ever names the latest one; a pid is captured at each boot instead. It is
  // what owns the session scopes, and the only thing the cleanup below may stop.
  const ownerPids = new Set<number>();
  const chats: ChatSocket[] = [];

  // The Claude CLI keeps its onboarding state next to the home directory rather
  // than inside the config dir, so a bare temporary home would drop it into the
  // first-run wizard and hang there. Copying the operator's state costs a
  // read-only 90 KB and makes the CLI start the way it does for a real user.
  await fsp.mkdir(path.join(tempRoot, 'home'), { recursive: true });
  await fsp.mkdir(path.join(tempRoot, 'claude-config'), { recursive: true });
  // The shipped restore default is ON, and this criterion measures the start-up sweep and the
  // "stored resident, not running" reading after a restart. A boot that restored the resident
  // rows would start a host for each of them and change what leg 4 observes, so the temporary
  // HOME carries an explicit opt-out. The pass itself is measured by the sibling
  // resident-restore.service criterion.
  await fsp.mkdir(path.join(tempRoot, 'home', '.config', 'claudecodeui'), { recursive: true });
  await fsp.writeFile(
    path.join(tempRoot, 'home', '.config', 'claudecodeui', 'server.settings.json'),
    JSON.stringify({ residentRestore: { enabled: false } }),
  );
  try {
    await fsp.copyFile(path.join(os.homedir(), '.claude.json'), path.join(tempRoot, 'home', '.claude.json'));
  } catch {
    // No onboarding state on this host; the CLI starts fresh, which is what the
    // sibling resident criterion does too.
  }

  const boot = async (): Promise<ServerReading> => {
    const server = await bootServer({ tempRoot });
    booted.push(server);
    const ownerPid = server.serverPid();
    if (ownerPid !== null) {
      ownerPids.add(ownerPid);
    }
    return server;
  };

  try {
    const databasePath = path.join(tempRoot, 'auth.db');

    // ---- leg 0: one server, one resident session and one per-run control ----
    const first = await boot();
    console.log(`server-boot pid=${first.leaderPid} port=${first.port} log=${first.logPath}`);
    assert.notEqual(first.port, 3001, 'the boot inherited the ambient port instead of a probed one');

    const environment = first.environment();
    const databaseLine = environment.split('\n').find((line) => line.startsWith('DATABASE_PATH=')) ?? '';
    const hostLine = environment.split('\n').find((line) => line.startsWith('HOST=')) ?? '';
    console.log(`server-environ ${databaseLine} | ${hostLine}`);
    assert.equal(databaseLine, `DATABASE_PATH=${databasePath}`, '/proc/<pid>/environ does not carry the temp database');
    assert.equal(hostLine, 'HOST=127.0.0.1', '/proc/<pid>/environ does not carry the pinned host');

    const tokenPath = path.join(tempRoot, 'token');
    const token = await mintToken(databasePath, tokenPath);

    const model = await api(first.port, token, 'POST', `/api/providers/${PROVIDER}/models`, {
      id: MODEL_ID,
      model: MODEL_ID,
      config: {
        env: [
          { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: mock.baseUrl },
          { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
          { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
        ],
      },
    });
    assert.ok(model.status === 201 || model.status === 200, `model entry was refused: ${JSON.stringify(model.body)}`);

    const createSession = async (port: number, sessionToken: string, label: string): Promise<string> => {
      const created = dataOf(
        await api(port, sessionToken, 'POST', '/api/providers/sessions', {
          provider: PROVIDER,
          projectPath: tempRoot,
          initialMessage: '',
        }),
        `create ${label} session`,
      );
      const sessionId = created.sessionId as string;
      assert.ok(typeof sessionId === 'string' && sessionId.length > 0, `no session id for ${label}`);
      return sessionId;
    };

    const storeResidentMode = async (port: number, sessionToken: string, sessionId: string): Promise<void> => {
      dataOf(
        await api(port, sessionToken, 'PUT', `/api/providers/${PROVIDER}/sessions/${sessionId}/lifecycle-mode`, {
          mode: 'resident',
        }),
        'store the resident mode',
      );
    };

    // Two sessions on this process, because the legs ask different questions of
    // the same listing: the one the graceful stop drops (and whose re-run after
    // the restart proves a new pid), and a per-run control that must read
    // `reason: null` in the same response — without which "the reason is
    // non-empty" would be a statement about a field that is never empty.
    //
    // The session the hard kill orphans is *not* created here: it is created on
    // the second process, after that process has booted. A row created before a
    // boot has a null `provider_session_id` at boot time, and the boot migration
    // that backfills that column for legacy rows (`addProviderSessionIdMapping`)
    // fills it with the app session id — which the runtime then hands to the CLI
    // as `--resume <app id>`, a conversation that does not exist, so the CLI
    // exits before it makes a single request. A row created after the boot keeps
    // its null, the runtime asks for no resume, and the turn is really in flight.
    const residentSession = await createSession(first.port, token, 'resident');
    const perRunSession = await createSession(first.port, token, 'per-run');

    await storeResidentMode(first.port, token, residentSession);

    const chat = await connectChat(first.port, token);
    chats.push(chat);

    await sendTurn(chat, residentSession, 'restart round one', tempRoot);
    const firstPid = await waitForResidentPid(
      first.port,
      token,
      residentSession,
      ROUND_TIMEOUT_MS,
      'the first resident host to appear with a pid',
    );

    // The turn reached the endpoint this criterion started, with the model
    // entry's credential and not the ambient host key. Without this the round
    // above would only prove that *some* model answered.
    assert.ok(mock.turns() > 0, 'no request ever reached the mock endpoint');
    // Every credential the endpoint saw is the model entry's; the ambient host
    // key is nowhere, in either header or body.
    const secrets = new Set(mock.received.map((request) => request.authorization).filter(Boolean));
    assert.deepEqual(
      [...secrets],
      [`Bearer ${MODEL_SECRET}`],
      `the mock saw credentials that are not the model entry's: ${[...secrets]}`,
    );
    assert.equal(
      mock.received.some(
        (request) => request.body.includes(HOST_SENTINEL) || (request.authorization ?? '').includes(HOST_SENTINEL),
      ),
      false,
      'the ambient host key leaked into a model request',
    );
    chat.close();

    // ---- leg 1: SIGTERM is the graceful path ----
    const aliveBefore = isAlive(firstPid);
    console.log(`sigterm-precondition resident-pid=${firstPid} alive-before=${aliveBefore}`);
    assert.equal(aliveBefore, true, 'the resident process was already gone before the signal');

    const termAt = Date.now();
    const termReport = first.stop('SIGTERM', firstPid);
    console.log(`sigterm-killed killed=${termReport.killed.length} spared=${termReport.spared.length}`);

    await waitFor(() => !isAlive(firstPid), GONE_TIMEOUT_MS, `pid ${firstPid} to leave after SIGTERM`);
    const goneAfterMs = Date.now() - termAt;

    const closeLine = shutdownCloseLines(first.logText()).find((line) => line.pid === firstPid);
    assert.ok(
      closeLine !== undefined,
      `the shutdown recorded no close for pid ${firstPid}; the log says:\n` +
        shutdownCloseLines(first.logText()).map((line) => JSON.stringify(line)).join('\n'),
    );
    console.log(
      `sigterm resident-pid=${firstPid} alive-before=true gone-after-ms=${goneAfterMs} closeReason=${closeLine.reason}`,
    );
    assert.equal(closeLine.reason, 'server-shutdown', 'the close reason the shutdown recorded is not the stop reason');

    // ---- leg 2: SIGKILL is the path no shutdown can cover ----
    //
    // The turn is deliberately left in flight. A resident CLI sitting idle
    // between turns ends by itself the moment the server holding the write end
    // of its stdin dies — measured on this host at about 600ms, long before any
    // next boot could sweep it — so a kill there orphans nothing and the sweep
    // would have nothing to prove. A CLI blocked on a model response is a
    // different process: it has work in hand and does not reach the end of its
    // turn, which is exactly the residue a real operator gets when a server is
    // killed mid-turn and exactly what nothing else collects.
    //
    // ## Why the reap reading is "a boot reaped it", not "this boot only"
    //
    // The sweep is HOST-WIDE by design: any server that boots reaps every scope whose owner pid is
    // gone, not only its own predecessor's. So another server booting between this run's kill and
    // this run's own next boot (another lane's real-server suite, another real-server test in the
    // same suite) reaps the orphan first, and this boot then honestly reads `swept=0` — measured by
    // running a sweeper alongside this file, which reproduces the signature every time. That is not
    // a miss; it is the sweep doing exactly what it is specified to do. The reading this leg exists
    // for is therefore "after this run's next boot, the orphan the kill left no longer exists,
    // because a boot's start-up sweep reaped it" — and the sweep line says which boot did it (this
    // one when `swept>=1`, a concurrent lane's when `swept=0`, the orphan already gone). An earlier
    // revision demanded `swept>=1` from this boot alone and retried up to three times; under the
    // fan-in's lane concurrency every attempt lost the race and the file redded non-owning deltas
    // round after round. A build whose sweep reaps nothing never clears the held in-flight orphan,
    // so it still reds below on the first boot; the positive control that the kill left residue at
    // all is the `sigkill survivor=true` reading taken the instant after the signal.
    const second = await boot();
    const secondToken = await mintToken(databasePath, path.join(tempRoot, 'token-2'));
    const secondChat = await connectChat(second.port, secondToken);
    chats.push(secondChat);

    // A resident session this process has never seen, created after its boot —
    // see the note beside the two sessions above for why the ordering matters.
    const orphanableSession = await createSession(second.port, secondToken, 'resident, to be orphaned');
    await storeResidentMode(second.port, secondToken, orphanableSession);

    mock.hold();
    secondChat.socket.send(JSON.stringify({
      type: 'chat.send',
      sessionId: orphanableSession,
      content: 'restart round two, held open',
      options: { cwd: tempRoot, model: MODEL_ID, permissionMode: 'default' },
    }));

    const secondPid = await waitForResidentPid(
      second.port,
      secondToken,
      orphanableSession,
      ROUND_TIMEOUT_MS,
      'the second resident host to appear with a pid',
    );
    // The turn has to be *in hand* before the kill, or the process is only
    // holding a queue it could drain and this leg orphans nothing. The wait is
    // on the request the CLI made, which is the one fact that says it is
    // blocked on the model rather than finished: a resident process that has
    // ended its turn is a process a graceful path could still collect.
    try {
      await waitFor(() => mock.heldCount() > 0, ROUND_TIMEOUT_MS, 'the in-flight turn to reach the mock endpoint');
    } catch (error) {
      // The two readings that say *why* nothing arrived: what the endpoint saw,
      // and what the host layer thinks it has. Both are cheap here and nobody
      // reading a bare timeout can reconstruct them.
      const seen = mock.received.map((request) => request.url).join(', ');
      const listing = await readHosts(second.port, secondToken).catch(() => null);
      console.error(
        `in-flight turn never reached the endpoint; it saw [${seen}]; hosts=${JSON.stringify(listing?.hosts ?? null)}\n` +
          `server log:\n${second.logText().slice(-4000)}`,
      );
      throw error;
    }
    assert.equal(isAlive(secondPid), true, 'the in-flight resident process was not in the process table');
    console.log(
      `sigkill-in-flight resident-pid=${secondPid} held-replies=${mock.heldCount()} alive=true`,
    );
    assert.notEqual(secondPid, firstPid, 'the restarted server reused the dead process');

    const killedServerPid = second.serverPid();
    assert.ok(killedServerPid !== null, 'the restarted server wrote no local-server marker');

    const killReport = second.stop('SIGKILL', secondPid);
    const survivor = isAlive(secondPid);
    console.log(
      `sigkill survivor=${survivor} killed=${killReport.killed.length} spared=${killReport.spared.length} ` +
        `server-pid=${killedServerPid} resident-pid=${secondPid}`,
    );
    assert.equal(survivor, true, 'the in-flight resident process did not survive the kill, so nothing was orphaned');

    // ---- leg 3: a boot's start-up sweep reaps what the kill left behind ----
    const third = await boot();
    const thirdToken = await mintToken(databasePath, path.join(tempRoot, 'token-3'));
    const swept = sweptFrom(third.logText());
    const aliveAtNextBoot = isAlive(secondPid);
    console.log(`sigkill-residue pid=${secondPid} alive-at-next-boot=${aliveAtNextBoot} swept=${swept}`);

    // The orphan is a held in-flight CLI whose owning server was SIGKILLed. The sweep stops its
    // scope — SIGTERM, then SIGKILL and reset-failed — and that takes a moment to settle, so the
    // reap is polled rather than read once. A boot that reaped the unit leaves the process gone; a
    // build whose sweep reaps nothing leaves it standing, which is the red below.
    const reapDeadline = Date.now() + GONE_TIMEOUT_MS;
    while (isAlive(secondPid) && Date.now() < reapDeadline) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    const aliveAfterSweep = isAlive(secondPid);
    console.log(`sigkill-reaped pid=${secondPid} alive-after-sweep=${aliveAfterSweep}`);
    if (!aliveAfterSweep) {
      // Which boot reaped it: this one (its sweep line named the unit) or a concurrent lane's,
      // whose host-wide sweep raced ahead of this boot and left it nothing to reap.
      console.log(
        swept >= 1
          ? `sigkill-residue-reaper this-boot swept=${swept}`
          : "sigkill-residue-reaper concurrent-boot (swept=0: a concurrent boot's host-wide sweep raced ahead)",
      );
    }
    assert.equal(
      aliveAfterSweep,
      false,
      `the boot following the kill left the held in-flight orphan ${secondPid} standing ` +
        `(swept=${swept}, alive-at-next-boot=${aliveAtNextBoot}): no boot's start-up sweep reaped the ` +
        'SIGKILL residue — a build whose sweep reaps nothing leaves it there',
    );

    if (scopes.available) {
      const pattern = `claudecodeui-session-${killedServerPid}-*`;
      await waitFor(() => scopes.raw(pattern) === '', SCOPE_TIMEOUT_MS, `scope units matching ${pattern} to clear`);
      console.log(`scopes pattern=${pattern} output=${JSON.stringify(scopes.raw(pattern))}`);
      assert.equal(scopes.units().some((unit) => unit.includes(`-${killedServerPid}-`)), false);
    } else {
      console.log('systemd=false');
    }

    // The held turn belongs to a process that no longer exists; releasing it
    // lets the socket close instead of being held open by this criterion.
    mock.release();
    secondChat.close();

    // ---- leg 4: after the restart the session is still resident, and not running ----
    //
    // The opt-out in the temporary HOME is what keeps this reading honest: a boot that ran the
    // restore pass would log its summary line and start hosts, so "not running" would be an
    // accident of timing rather than a reading of the stored state.
    assert.equal(
      third.logText().includes('[resident-restore]'),
      false,
      'the restarted server ran the resident restore pass despite the test HOME opting out',
    );
    const listing = await readHosts(third.port, thirdToken);
    const residentState = sessionStateOf(listing, residentSession);
    const orphanState = sessionStateOf(listing, orphanableSession);
    const controlState = sessionStateOf(listing, perRunSession);
    assert.ok(residentState !== null, 'the resident session is missing from the listing after the restart');
    assert.ok(orphanState !== null, 'the orphaned session is missing from the listing after the restart');
    assert.ok(controlState !== null, 'the per-run control session is missing from the listing');

    for (const [label, state] of [
      ['stopped', residentState],
      ['killed', orphanState],
    ] as const) {
      console.log(
        `sessions ${label} lifecycle_mode=${state.lifecycleMode} running=${state.running} ` +
          `reason=${JSON.stringify(state.reason)}`,
      );
      assert.equal(state.lifecycleMode, 'resident', `the ${label} session lost its stored mode across the restart`);
      assert.equal(state.running, false, `the restarted server reports a live host for the ${label} session`);
      assert.equal(state.reason, RESIDENT_NOT_RUNNING_REASON, `the ${label} session carries the wrong reason`);
      assert.ok((state.reason ?? '').length > 0, `the reason field is empty for the ${label} session`);
    }
    console.log(
      `sessions control lifecycle_mode=${controlState.lifecycleMode} running=${controlState.running} ` +
        `reason=${JSON.stringify(controlState.reason)}`,
    );
    console.log(`sessions reason-source=${JSON.stringify(RESIDENT_NOT_RUNNING_REASON)}`);
    assert.equal(controlState.reason, null, 'the reason field is filled for a per-run session too, so it says nothing');

    // ---- leg 5: the next send opens a new process, not the dead one ----
    const thirdChat = await connectChat(third.port, thirdToken);
    chats.push(thirdChat);

    await sendTurn(thirdChat, residentSession, 'restart round three', tempRoot);
    const thirdPid = await waitForResidentPid(
      third.port,
      thirdToken,
      residentSession,
      ROUND_TIMEOUT_MS,
      'the resident host to come back after the restart',
    );
    const running = residentHostOf(await readHosts(third.port, thirdToken), residentSession);
    console.log(
      `restart old-pid=${firstPid} new-pid=${thirdPid} distinct=${thirdPid !== firstPid} ` +
        `alive=${isAlive(thirdPid)} running=${running !== null}`,
    );
    assert.notEqual(thirdPid, firstPid, 'the restarted send reused the dead pid');
    assert.equal(isAlive(thirdPid), true, 'the new resident process is not in the process table');
    assert.notEqual(running, null, 'the host snapshot did not come back for the session');

    // ---- the budget reading, with the threshold asserted on both sides ----
    const elapsedMs = Date.now() - STARTED_AT;
    const overBudget = guard({ elapsedMs: BUDGET_MS + 1, budgetMs: BUDGET_MS });
    const underBudget = guard({ elapsedMs: 0, budgetMs: BUDGET_MS });
    console.log(`guard({elapsedMs:${BUDGET_MS + 1},budgetMs:${BUDGET_MS}})=${overBudget}`);
    console.log(`guard({elapsedMs:0,budgetMs:${BUDGET_MS}})=${underBudget}`);
    assert.equal(overBudget, 3, 'the budget guard does not answer 3 when it is over budget');
    assert.equal(underBudget, 0, 'the budget guard does not answer 0 when it is under budget');

    console.log(`budget-ms=${BUDGET_MS} elapsed-ms=${elapsedMs}`);
    console.log(`elapsed-ms=${elapsedMs}`);
    assert.ok(elapsedMs < BUDGET_MS, `the run took ${elapsedMs}ms, past its ${BUDGET_MS}ms budget`);
  } finally {
    for (const chat of chats) {
      chat.close();
    }
    for (const server of booted) {
      if (isAlive(server.leaderPid)) {
        server.stop('SIGKILL', null);
      }
    }
    // Anything the criterion started that is still alive is stopped by the scopes that own it —
    // and if scopes are unavailable, by pid. Only scopes owned by a server this run booted: the
    // listing is host-wide, and stopping every `claudecodeui-session-*` unit on it also stopped the
    // sessions of the operator's own running server.
    for (const server of booted) {
      const ownerPid = server.serverPid();
      if (ownerPid !== null) {
        ownerPids.add(ownerPid);
      }
    }
    for (const ownerPid of ownerPids) {
      stopResidentScopes(ownerPid);
    }
    await mock.close();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
