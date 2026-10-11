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
const USAGE = 'usage: node scripts/check-deploy-freshness.mjs [--url <health-base-url>] [--ref <git-ref>]';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses `--url`/`--ref` (space- or `=`-separated). `--help` prints usage and exits 0.
 * @param {string[]} argv
 * @returns {{ url: string, ref: string }}
 */
function parseArgs(argv) {
  const options = { url: DEFAULT_URL, ref: DEFAULT_REF };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
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
      console.error(`UNREACHABLE：${healthUrl} 返回 HTTP ${response.status}`);
      process.exit(2);
    }
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`UNREACHABLE：无法读取 ${healthUrl}（${message}）`);
    process.exit(2);
  }

  const buildSha = readBuildSha(payload);
  if (buildSha === null) {
    console.log('UNKNOWN（该实例可能是 tsx 开发模式，或构建早于本检测工具存在）');
    process.exit(2);
  }

  const refResult = git(['rev-parse', options.ref]);
  if (refResult.error || refResult.status !== 0) {
    console.error(`ERROR：git rev-parse ${options.ref} 失败：${refResult.stderr.trim() || refResult.status}`);
    process.exit(2);
  }
  const refSha = refResult.stdout.trim();

  if (buildSha === refSha) {
    console.log(`FRESH（buildSha ${buildSha} == ${options.ref}）`);
    process.exit(0);
  }

  const ancestor = git(['merge-base', '--is-ancestor', buildSha, options.ref]);
  if (ancestor.error || (ancestor.status !== 0 && ancestor.status !== 1)) {
    console.error(
      `ERROR：git merge-base --is-ancestor ${buildSha} ${options.ref} 失败：${ancestor.stderr.trim() || ancestor.status}`,
    );
    process.exit(2);
  }

  if (ancestor.status === 0) {
    const count = git(['rev-list', '--count', `${buildSha}..${options.ref}`]);
    if (count.error || count.status !== 0) {
      console.error(`ERROR：git rev-list --count 失败：${count.stderr.trim() || count.status}`);
      process.exit(2);
    }
    console.log(`STALE，落后 ${count.stdout.trim()} 个提交（${buildSha} → ${options.ref}）`);
    process.exit(1);
  }

  console.log(`DIVERGED（构建自 ${buildSha}，不是 ${options.ref} 的祖先）`);
  process.exit(1);
}

await main();
