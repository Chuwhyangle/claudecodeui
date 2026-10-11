#!/usr/bin/env node
// Records which commit the server build was compiled from, so a running instance can be asked
// (via its /health route) whether the deployment is behind a git ref. This is a BUILD-TIME script,
// the last step of package.json's `build:server`; it is never part of the served process.
//
// Where the record goes matters. The build stages into `dist-server.next` and `postbuild:server`
// (scripts/promote-dist-server.mjs) promotes it into the live `dist-server`. So when the staging
// directory is present — i.e. during a real build — the record is written INTO the staging tree so
// promotion carries it to `dist-server/build-info.json`. Writing straight to the live `dist-server`
// here would be silently erased by that same promotion (the old tree is renamed away and removed).
// A standalone run with no staging directory writes to `dist-server/build-info.json` directly.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolves the current commit. Returns null when git is unavailable or fails (e.g. an
 * npm-tarball install with no `.git`): a missing sha must not fail the build, and /health then
 * reports `buildSha: null`, which scripts/check-deploy-freshness.mjs reads as UNKNOWN.
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

const stagingDir = path.join(APP_ROOT, 'dist-server.next');
const outputDir = fs.existsSync(stagingDir) ? stagingDir : path.join(APP_ROOT, 'dist-server');
const outputPath = path.join(outputDir, 'build-info.json');

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  outputPath,
  `${JSON.stringify({ gitSha: readHeadSha(), builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`write-build-info: wrote ${path.relative(APP_ROOT, outputPath)}`);
