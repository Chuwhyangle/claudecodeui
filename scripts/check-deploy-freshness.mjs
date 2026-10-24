#!/usr/bin/env node
// One-shot, MANUAL freshness check: asks a running server's /health which commit it was built from
// and compares that against a local git ref. It is a DETECTOR ONLY — it never rebuilds, restarts,
// schedules, or mutates anything, and it is not part of any scheduler. Run it by hand after a
// deployment to learn whether the running build is current.
//
// The gap this closes: nothing re-builds or restarts the service when new commits land on develop,
// so a hand-run `npm run build && restart` silently goes stale. /health now carries buildSha/builtAt
// (server/index.ts), and this tool turns that reading into a verdict.
//
// Exit codes:
//   0  FRESH     — the running build is exactly <ref>.
//   1  STALE     — an answer was read and it is behind <ref> by N commits.
//      DIVERGED  — an answer was read and it is not an ancestor of <ref> (e.g. built from main).
//   2  UNKNOWN   — the instance reports no buildSha (tsx dev mode, or built before this existed).
//      UNREACHABLE / ERROR — no comparable reading could be produced.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:3001';
const DEFAULT_REF = 'HEAD';
const USAGE = 'usage: node scripts/check-deploy-freshness.mjs [--url <health-base-url>] [--ref <git-ref>] [--json]';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses `--url`/`--ref` (space- or `=`-separated) and the `--json` switch. `--help` prints
 * usage and exits 0.
 *
 * `--json` is the machine face the observation layer's project-truth producer reads: the same
 * verdicts and the same exit codes, with one JSON document on stdout instead of the human line.
 * Consumers that do not pass the flag keep the byte-identical text output.
 *
 * @param {string[]} argv
 * @returns {{ url: string, ref: string, json: boolean }}
 */
function parseArgs(argv) {
  const options = { url: DEFAULT_URL, ref: DEFAULT_REF, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    let key;
    let value;
    if (arg === '--url' || arg === '--ref') {
      key = arg.slice(2);
      const next = argv.at(i + 1);
      if (next === undefined) {
        throw new Error(`missing value for ${arg}\n${USAGE}`);
      }
      value = next;
      i += 1;
    } else if (arg.startsWith('--url=') || arg.startsWith('--ref=')) {
      const equals = arg.indexOf('=');
      key = arg.slice(2, equals);
      value = arg.slice(equals + 1);
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
    if (key === 'url') {
      options.url = value;
    } else {
      options.ref = value;
    }
  }
  return options;
}

/**
 * Runs git in the repository root and normalizes stdout/stderr to strings.
 * @param {string[]} args
 * @returns {{ error: Error | undefined, status: number | null, stdout: string, stderr: string }}
 */
function git(args) {
  const result = spawnSync('git', args, { cwd: APP_ROOT, encoding: 'utf8' });
  return {
    error: result.error,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/**
 * Emits one verdict in the requested shape and exits with the detector's documented code.
 *
 * In JSON mode the machine document always lands on stdout and any human error text stays on
 * stderr, so the two channels never mix. In text mode the previous output is unchanged.
 *
 * @param {{ json: boolean, url: string, ref: string }} options
 * @param {{ verdict: string, human: string, stream?: 'stdout' | 'stderr', details?: Record<string, unknown>, exitCode: number }} result
 * @returns {never} It always exits the process, so a caller's narrowing continues after the call.
 */
function finish(options, result) {
  const { verdict, human, stream = 'stdout', details = {}, exitCode } = result;
  if (options.json) {
    console.log(JSON.stringify({ verdict, url: options.url, ref: options.ref, ...details }));
    if (stream === 'stderr') console.error(human);
  } else if (stream === 'stderr') {
    console.error(human);
  } else {
    console.log(human);
  }
  process.exit(exitCode);
}

/**
 * Reads `buildSha` off a /health payload, returning null when absent or not a string.
 * @param {unknown} payload
 * @returns {string | null}
 */
function readBuildSha(payload) {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const value = /** @type {{ buildSha?: unknown }} */ (payload).buildSha;
  return typeof value === 'string' ? value : null;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const healthUrl = `${options.url.replace(/\/+$/, '')}/health`;

  let payload;
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      finish(options, {
        verdict: 'unreachable',
        human: `UNREACHABLE：${healthUrl} 返回 HTTP ${response.status}`,
        stream: 'stderr',
        details: { reason: `HTTP ${response.status}` },
        exitCode: 2,
      });
    }
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish(options, {
      verdict: 'unreachable',
      human: `UNREACHABLE：无法读取 ${healthUrl}（${message}）`,
      stream: 'stderr',
      details: { reason: message },
      exitCode: 2,
    });
  }

  const buildSha = readBuildSha(payload);
  if (buildSha === null) {
    finish(options, {
      verdict: 'unknown',
      human: 'UNKNOWN（该实例可能是 tsx 开发模式，或构建早于本检测工具存在）',
      details: { reason: '该实例没有 buildSha（tsx 开发模式，或构建早于本检测工具存在）' },
      exitCode: 2,
    });
  }

  const refResult = git(['rev-parse', options.ref]);
  if (refResult.error || refResult.status !== 0) {
    finish(options, {
      verdict: 'error',
      human: `ERROR：git rev-parse ${options.ref} 失败：${refResult.stderr.trim() || refResult.status}`,
      stream: 'stderr',
      details: { reason: `git rev-parse ${options.ref} 失败：${refResult.stderr.trim() || refResult.status}` },
      exitCode: 2,
    });
  }
  const refSha = refResult.stdout.trim();

  if (buildSha === refSha) {
    finish(options, {
      verdict: 'fresh',
      human: `FRESH（buildSha ${buildSha} == ${options.ref}）`,
      details: { buildSha, refSha },
      exitCode: 0,
    });
  }

  const ancestor = git(['merge-base', '--is-ancestor', buildSha, options.ref]);
  if (ancestor.error || (ancestor.status !== 0 && ancestor.status !== 1)) {
    const reason = `git merge-base --is-ancestor ${buildSha} ${options.ref} 失败：${ancestor.stderr.trim() || ancestor.status}`;
    finish(options, { verdict: 'error', human: `ERROR：${reason}`, stream: 'stderr', details: { reason }, exitCode: 2 });
  }

  if (ancestor.status === 0) {
    const count = git(['rev-list', '--count', `${buildSha}..${options.ref}`]);
    if (count.error || count.status !== 0) {
      const reason = `git rev-list --count 失败：${count.stderr.trim() || count.status}`;
      finish(options, { verdict: 'error', human: `ERROR：${reason}`, stream: 'stderr', details: { reason }, exitCode: 2 });
    }
    const behindBy = Number.parseInt(count.stdout.trim(), 10);
    finish(options, {
      verdict: 'stale',
      human: `STALE，落后 ${count.stdout.trim()} 个提交（${buildSha} → ${options.ref}）`,
      details: { buildSha, refSha, behindBy: Number.isInteger(behindBy) ? behindBy : 0 },
      exitCode: 1,
    });
  }

  finish(options, {
    verdict: 'diverged',
    human: `DIVERGED（构建自 ${buildSha}，不是 ${options.ref} 的祖先）`,
    details: { buildSha, refSha },
    exitCode: 1,
  });
}

await main();
