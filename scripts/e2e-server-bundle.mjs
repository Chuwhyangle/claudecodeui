/**
 * The pre-built server the e2e `webServer` launches, instead of `tsx` on `server/index.ts`.
 *
 * WHY. A criterion's ceiling is on the whole `npx playwright test` invocation, so the test runner's
 * boot is inside the wall clock it measures. Measured on this checkout on 2026-10-21 (128 cores,
 * load1 45): `node_modules/.bin/tsx --tsconfig server/tsconfig.json server/index.ts` reached
 * `/health` in 7.1s (4.9s on a quieter host), and `tsx` pays that per module it transforms.
 * Starting the same server from an esbuild bundle of the same graph reached `/health` in 751ms on
 * the same host at the same moment — the bundle is one file for Node to parse instead of a
 * transform of every module in the graph. Under the burst AC-194 was red in, the pre-test boot
 * (the interval before Playwright prints `Running 1 test`) was ~21.5s of the criterion's 43.9s, and
 * the server's boot is the largest CPU block in it. This module removes that block.
 *
 * FRESHNESS. The bundle is named after a content hash of the sources it is built from: every
 * non-test `.ts`/`.tsx`/`.js`/`.mjs`/`.json` file under `server/` and `shared/`, plus the esbuild
 * version and this Node's major version. A source edit therefore names a *different* file, so a
 * stale bundle cannot be executed — there is no mtime window and no rebuild-if-newer rule to get
 * wrong. A key that already has a bundle is a cache hit (no esbuild spawn); anything else is built
 * once per checkout. Measured: hashing 358 files / 5.9 MB takes ~9ms; one esbuild build takes
 * ~60ms. Both are far below the ~2.9s (quiet) / ~7s (loaded) tsx boot they replace.
 *
 * SERVER-ROOT RESOLUTION. `server/load-env.ts` and `server/index.ts` resolve the application root
 * by walking up from `import.meta.url` to the nearest directory named `server`, and a bundle
 * written anywhere else makes that walk fail (`Could not resolve server root`) or, worse, resolve
 * a different root. The bundle is therefore published at
 * `<serverRoot>/server/node_modules/.cache/quay-e2e-build/server-index.<key>.mjs` — below the
 * anchor the walk looks for, so it resolves to exactly the `<serverRoot>` the source entry point
 * resolved to. The other `import.meta.url` consumers in the shipping server (`findApplicationRoot`
 * / `getModuleDirectory` callers, `createRequire`) are relative to that same anchor and keep working.
 *
 * WHY UNDER `node_modules/.cache`. The bundle is COMPILED SOURCE: it contains every identifier the
 * source graph contains. Criteria that read the live `server/` tree with a syntax tree — AC-393's
 * `supersedeRunning` ratchet and AC-392's single-flag-reader check — walk non-test `.mjs` files on
 * disk, so a bundle published directly under `server/` counts every symbol twice and turns those
 * criteria red on the artifact rather than on the code (observed: ratchet `3 -> 5`). Both those
 * scanners prune `node_modules/`, and the source-hash walk above does too, so a cache directory
 * under it is invisible to every reader while keeping the `server` anchor above the module.
 *
 * RUNTIME FILE READS. `voice-realtime-ws-proxy.service.ts` reads `./omission-fill-params.json`
 * beside its own module at evaluation, which in a bundle is the bundle's directory; the build
 * copies that file beside the bundle so the shipping parameter block still loads. (The
 * browser-use service resolves its MCP entry from its own module directory too, but no e2e
 * selection starts browser-use; the bundle is an e2e-only launch path and does not replace the
 * shipping `tsx`/`dist-server` launches.)
 *
 * ATOMIC PUBLISH. Several e2e lanes can evaluate this module at the same moment. Each builds into
 * a private temp file and renames it into place, so a bundle path that exists is always a complete
 * bundle and two builders of the same key simply publish identical bytes.
 *
 * @module scripts/e2e-server-bundle
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Directory (under `<serverRoot>/server/node_modules/.cache/`) the bundles are published into;
 * git-ignored, and pruned by the `server/`-tree syntax scanners — see the module comment.
 */
const CACHE_DIRECTORY = path.join('server', 'node_modules', '.cache', 'quay-e2e-build');
/** Base name of every published bundle; the content key is the suffix. */
const BUNDLE_BASENAME = 'server-index';
/** Source extensions that can reach the bundle. Everything else is irrelevant to its contents. */
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mjs|json)$/;
/** Runtime file the bundle must carry beside itself; see the module comment. */
const SHIPPED_RUNTIME_FILE = path.join('server', 'modules', 'voice-realtime', 'omission-fill-params.json');

/**
 * True for files that are not part of the shipping server: tests and test fixtures only.
 * @param {string} relativePath
 * @returns {boolean}
 */
function isTestSource(relativePath) {
  return relativePath.split(path.sep).includes('tests') || relativePath.includes('.test.');
}

/**
 * Every source file whose contents can change the bundle, as sorted workspace-relative paths.
 *
 * The walk skips `node_modules` (packages are external in the bundle), the build directory
 * (its own output), and tests (nothing in the shipping graph imports them). A change to any file
 * that is *not* in this set cannot change what esbuild emits for `server/index.ts`.
 * @param {string} serverRoot
 * @returns {string[]}
 */
function collectSourceFiles(serverRoot) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(serverRoot, absolute);
      if (entry.isDirectory()) {
        // `node_modules` holds the published cache (see CACHE_DIRECTORY) as well as packages.
        if (entry.name === 'node_modules') continue;
        if (isTestSource(relative)) continue;
        walk(absolute);
      } else if (SOURCE_EXTENSION.test(entry.name) && !isTestSource(relative)) {
        files.push(relative);
      }
    }
  };
  for (const root of ['server', 'shared']) {
    const absolute = path.join(serverRoot, root);
    if (fs.existsSync(absolute)) walk(absolute);
  }
  return files.sort();
}

/**
 * The esbuild version the bundle is built with, read without spawning it (a stat-sized read).
 * @param {string} serverRoot
 * @returns {string}
 */
function esbuildVersion(serverRoot) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(serverRoot, 'node_modules', 'esbuild', 'package.json'), 'utf8'));
    return typeof metadata.version === 'string' ? metadata.version : 'unknown';
  } catch {
    return 'missing';
  }
}

/**
 * The cache key for this checkout's sources.
 *
 * Content, not mtime: `git checkout` / `git stash` can restore a file with an old timestamp, and a
 * mtime-keyed cache would then execute the pre-edit bundle. The esbuild version and the Node major
 * are part of the key because they change what "building these sources" produces.
 * @param {string} serverRoot
 * @param {string[]} sources
 * @returns {string}
 */
function bundleKey(serverRoot, sources) {
  const hash = createHash('sha256');
  hash.update(`esbuild ${esbuildVersion(serverRoot)}\nnode ${process.versions.node.split('.')[0]}\n`);
  for (const relative of sources) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(serverRoot, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Publishes a file at `target` through a private temp file, so readers never see a partial file.
 * @param {string} target
 * @param {(temp: string) => void} writeTemp
 * @returns {void}
 */
function publishAtomically(target, writeTemp) {
  const temp = path.join(path.dirname(target), `.tmp-${process.pid}-${path.basename(target)}`);
  try {
    writeTemp(temp);
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* the temp file is inert; never mask the real failure */
    }
    throw error;
  }
}

/**
 * Builds (or reuses) the server bundle and returns the path the `webServer` should launch.
 *
 * `serverRoot` is both the source tree and the directory the bundle must live under, because the
 * shipping root resolution anchors on the nearest `server` directory above the module. Callers pass
 * the same root they give the webServer's `cwd`, which for the voice selections is the env-free
 * shadow copy — writing the bundle there keeps `.env` out of the process exactly as `tsx` did.
 *
 * Throws when esbuild is unavailable or the build fails: silently falling back to `tsx` would make
 * a criterion's reading depend on an unannounced code path, which is the one failure shape this
 * lever must not have.
 * @param {string} serverRoot
 * @returns {string}
 */
export function prepareServerBundle(serverRoot) {
  const buildDirectory = path.join(serverRoot, CACHE_DIRECTORY);
  const esbuildBinary = path.join(serverRoot, 'node_modules', '.bin', 'esbuild');
  if (!fs.existsSync(esbuildBinary)) {
    throw new Error(
      `e2e server bundle: esbuild is not installed at ${esbuildBinary}; the e2e webServer needs it to pre-build the server (npm install --include=dev)`,
    );
  }

  const sources = collectSourceFiles(serverRoot);
  const key = bundleKey(serverRoot, sources);
  const bundlePath = path.join(buildDirectory, `${BUNDLE_BASENAME}.${key}.mjs`);

  fs.mkdirSync(buildDirectory, { recursive: true });

  // The parameter file is one of the hashed sources, so a hit of the current key needs no refresh;
  // a new key can legitimately carry a different parameter block, and the reader opens this file
  // by name rather than by key. Compare contents instead of assuming either case.
  const runtimeFile = path.join(buildDirectory, path.basename(SHIPPED_RUNTIME_FILE));
  const runtimeSource = path.join(serverRoot, SHIPPED_RUNTIME_FILE);
  if (fs.existsSync(runtimeSource)) {
    const source = fs.readFileSync(runtimeSource);
    let current = null;
    try {
      current = fs.readFileSync(runtimeFile);
    } catch {
      /* not published yet */
    }
    if (current === null || !current.equals(source)) {
      publishAtomically(runtimeFile, (temp) => fs.writeFileSync(temp, source));
    }
  }

  if (fs.existsSync(bundlePath)) return bundlePath;

  const nodeMajor = process.versions.node.split('.')[0];
  publishAtomically(bundlePath, (temp) => {
    try {
      execFileSync(
        esbuildBinary,
        [
          'server/index.ts',
          '--bundle',
          '--platform=node',
          '--format=esm',
          // Packages stay external: the bundle only removes this checkout's per-module transforms;
          // Node still resolves dependencies from `node_modules` exactly as it did for the source.
          '--packages=external',
          '--tsconfig=server/tsconfig.json',
          `--target=node${nodeMajor}`,
          `--outfile=${temp}`,
          '--log-level=warning',
        ],
        { cwd: serverRoot, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
      );
    } catch (error) {
      const stderr = /** @type {{ stderr?: string | Buffer }} */ (error).stderr;
      const detail = stderr ? String(stderr).trim() : '';
      throw new Error(`e2e server bundle: esbuild failed to build server/index.ts${detail ? `:\n${detail}` : ''}`);
    }
  });

  // Bundles from superseded keys are dead weight (2.4 MB each) and can never be selected again.
  // An hour of grace keeps a lane that is still starting from a slightly older key intact.
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const entry of fs.readdirSync(buildDirectory)) {
    if (!entry.startsWith(`${BUNDLE_BASENAME}.`) || entry === path.basename(bundlePath)) continue;
    const absolute = path.join(buildDirectory, entry);
    try {
      if (fs.statSync(absolute).mtimeMs < cutoff) fs.rmSync(absolute, { force: true });
    } catch {
      /* another lane may be pruning; a leftover bundle is inert */
    }
  }

  return bundlePath;
}
