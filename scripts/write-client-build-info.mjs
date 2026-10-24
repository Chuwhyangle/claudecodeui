#!/usr/bin/env node
// Records which commit the BROWSER bundle was built from, so the deployment reading can tell
// whether `dist/` is current independently of the server build. This is a BUILD-TIME script,
// the last step of package.json's `build:client`; it is never part of the served process.
//
// Why a second fingerprint: `/health` reports the server's `dist-server/build-info.json`, which
// says nothing about the client bundle. Without its own record, a server rebuilt alone looks
// fresh while the browser is served a stale `dist/`. The format is deliberately identical to
// `scripts/write-build-info.mjs` (`{ gitSha, builtAt }`), so both readings are read by the same
// parser (`readBuildFingerprint`).
//
// Vite empties `dist/` on every build, so this must run after `vite build`, which is exactly
// where `build:client` invokes it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolves the current commit. Returns null when git is unavailable or fails (an npm-tarball
 * install has no `.git`): a missing sha must not fail the build, and the deployment reading
 * treats a null fingerprint as "not measured".
 * @returns {string | null}
 */
function readHeadSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return null;
  }
  const sha = String(result.stdout ?? '').trim();
  return sha === '' ? null : sha;
}

/**
 * Writes `build-info.json` into `<root>/dist`. Exported so the criterion can write into a temp
 * directory and compare the record's shape with the server's, without running vite.
 *
 * @param {{ root?: string, gitSha?: string | null, builtAt?: string }} [options]
 * @returns {{ path: string, record: { gitSha: string | null, builtAt: string } }}
 */
export function writeClientBuildInfo(options = {}) {
  const root = options.root ?? APP_ROOT;
  const record = {
    gitSha: options.gitSha === undefined ? readHeadSha() : options.gitSha,
    builtAt: options.builtAt ?? new Date().toISOString(),
  };
  const outputDir = path.join(root, 'dist');
  const outputPath = path.join(outputDir, 'build-info.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  return { path: outputPath, record };
}

// Only run as a CLI; an import from a test must not write into the repository.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { path: outputPath } = writeClientBuildInfo();
  console.log(`write-client-build-info: wrote ${path.relative(APP_ROOT, outputPath)}`);
}
