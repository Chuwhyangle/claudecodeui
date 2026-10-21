/**
 * The CLIENT root one e2e run serves, and the snapshot that makes it that run's own.
 *
 * WHY THIS MODULE EXISTS. `playwright.config.ts` starts Vite as a `webServer`, and until this module
 * the entry declared no `cwd` — so Playwright started Vite in `CONFIG_DIR`, the checkout the config
 * file lives in. Everything else about a run was already isolated (its data directory, its ports, its
 * dependency cache, the server's env-free shadow); the client's SOURCE TREE was not. That matters
 * because a criterion does not run in a private copy of the repository: the goal gate evaluates it in
 * the main checkout, and fan-in's `ff` step lands commits into that same checkout *while the gate is
 * running*. A landing that writes `src/` then reaches Vite's watcher mid-case; for a module with no
 * `import.meta.hot.accept` (e.g. `src/shared/api.ts`) the update bubbles to the entry and the page
 * FULLY RELOADS. A case that was a few assertions in loses its page and fails for a reason none of
 * its own assertions can name (recorded on AC-345: case 6, "the client must report the malformed call
 * as recoverable", 41.0s, Vite `ws proxy error: write EPIPE` in the same second).
 *
 * WHAT THIS DOES. At config evaluation — before Playwright spawns either webServer — the run copies
 * the tree Vite needs into a run-scoped directory and points the client `webServer.cwd` at it. The
 * copy is a REAL copy, never `cp -al`: a hardlink would share the inode with the checkout, so fan-in's
 * in-place write would change the bytes Vite reads exactly as before. `node_modules` is the one
 * symlink (the install is shared and never written), the same shape `envFreeServerRoot` uses for the
 * server.
 *
 * WHAT IS COPIED. The directories the client graph reaches (`src`, `shared` behind the `@shared`
 * alias, `public`) and the root config files Vite itself reads (`index.html`, `package.json`,
 * `vite.config.*`, `postcss.config.*`, `tailwind.config.*`, `tsconfig*.json`, `.env*`). A root entry
 * outside that declaration is deliberately not copied: the checkout root also holds run logs, build
 * output and the whole server tree, and none of them is part of what the browser is served.
 *
 * LIFECYCLE. The runner evaluates the config first and is the process that starts the servers;
 * workers re-evaluate it. The owner publishes the snapshot path through `QUAY_E2E_CLIENT_ROOT` and
 * the workers reuse it (first-writer-wins, the pattern the run's other cross-process paths use). The
 * owner removes the snapshot on `exit` — green, red and an uncaught exception all reach that event —
 * and on SIGINT/SIGTERM/SIGHUP it cleans up and re-raises the signal, so the run still dies by the
 * signal instead of being turned into a clean exit. `QUAY_E2E_CLIENT_ROOT=off` is the CONTROL arm:
 * it degrades the client root back to the checkout, which is how the isolation can be shown to be the
 * reason a probe run stays green (`removeClientSnapshot` also refuses any path that is not named as a
 * snapshot, so the control arm can never delete the checkout it degraded to).
 *
 * @module scripts/e2e-client-root
 */

import fs from 'node:fs';
import path from 'node:path';

/** Published to workers so they address the owner's snapshot instead of building a second one. */
export const CLIENT_ROOT_ENV = 'QUAY_E2E_CLIENT_ROOT';
/** The control-arm value: serve the checkout itself, exactly as the pre-isolation config did. */
export const CLIENT_ROOT_CONTROL_VALUE = 'off';
/** Directories under the checkout root that belong to the client graph. */
export const CLIENT_SOURCE_DIRECTORIES = Object.freeze(['src', 'shared', 'public']);
/**
 * Root files Vite or the client reads. Everything else at the checkout root (logs, `dist/`, the
 * server tree) is not part of what the browser is served and is deliberately left out of the copy.
 */
const ROOT_FILE_PATTERNS = Object.freeze([
  /^index\.html$/,
  /^package\.json$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
  /^tailwind\.config\.[cm]?[jt]s$/,
  /^tsconfig(?:\..+)?\.json$/,
  /^\.env(?:\..+)?$/,
]);
/** Never copied: the install is symlinked, and `.git` is not client source. */
const SKIP_ROOT_ENTRIES = new Set(['node_modules', '.git']);
/** Basename marker every snapshot carries; the cleanup guard keys on it. */
const SNAPSHOT_MARKER = '-clientroot-';
/** Signals that would otherwise skip the `exit` event entirely. */
const CLEANUP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * The `mkdtemp` prefix for a snapshot of `sourceRoot`.
 *
 * The basename travels into the prefix so a leftover directory in the parent still says WHICH
 * checkout it was copied from, and the marker is what `removeClientSnapshot` checks before deleting.
 * @param {string} sourceRoot
 * @returns {string}
 */
export function snapshotPrefix(sourceRoot) {
  return `.${path.basename(sourceRoot)}${SNAPSHOT_MARKER}`;
}

/**
 * True for a root entry whose name is part of the client tree declaration above.
 * @param {string} name
 * @returns {boolean}
 */
function isClientRootFile(name) {
  return ROOT_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Removes one snapshot directory, and refuses to remove anything that is not named as one.
 *
 * The guard is load-bearing rather than defensive: the control arm resolves the client root to the
 * checkout itself, and a cleanup path that trusted its argument would delete the whole checkout at
 * the end of exactly the run that was meant to prove isolation was off.
 * @param {string} root
 * @returns {boolean} whether a directory was removed
 */
export function removeClientSnapshot(root) {
  if (typeof root !== 'string' || root.length === 0) return false;
  if (!path.basename(root).includes(SNAPSHOT_MARKER)) return false;
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return false;
  }
  // A symlink whose name carries the marker is not a snapshot we created: `mkdtemp` makes a real
  // directory, so a link here is something else wearing the name.
  if (!stat.isDirectory()) return false;
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

/**
 * Copies the client tree out of `sourceRoot` into a fresh directory beside it.
 *
 * Beside it, not under `os.tmpdir()`: the copy is ~11 MB and the checkout's parent is the same
 * filesystem the checkout already lives on, so the copy never crosses a device or the shared root
 * filesystem a busy fleet fills. A failure during the copy removes the partial directory before it
 * is rethrown — a half-copied tree served by Vite would fail in ways that name none of this.
 * @param {{ sourceRoot: string, parent?: string }} options
 * @returns {{ root: string, cleanup: () => boolean }}
 */
export function createClientSnapshot({ sourceRoot, parent = path.dirname(sourceRoot) }) {
  const root = fs.mkdtempSync(path.join(parent, snapshotPrefix(sourceRoot)));
  const cleanup = () => removeClientSnapshot(root);
  try {
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (SKIP_ROOT_ENTRIES.has(entry.name)) continue;
      const source = path.join(sourceRoot, entry.name);
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (!CLIENT_SOURCE_DIRECTORIES.includes(entry.name)) continue;
        fs.cpSync(source, target, { recursive: true });
      } else if (entry.isFile() && isClientRootFile(entry.name)) {
        fs.copyFileSync(source, target);
      } else if (entry.isSymbolicLink() && isClientRootFile(entry.name)) {
        fs.symlinkSync(fs.readlinkSync(source), target);
      }
    }
    // The install is shared and read-only for the run; a symlink keeps the copy at source size and
    // is the same construction the server's env-free shadow uses.
    const modules = path.join(sourceRoot, 'node_modules');
    if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(root, 'node_modules'));
  } catch (error) {
    cleanup();
    throw error;
  }
  return { root, cleanup };
}

/**
 * Resolves this run's client root, publishing it to workers and registering its cleanup.
 *
 * Returns the owner's snapshot on the first evaluation, the published path on every worker
 * re-evaluation (`createSnapshot` is not even called there), and the checkout under the control arm.
 * @param {{
 *   configDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 *   lifecycle?: Pick<NodeJS.Process, 'once'> & { kill?: (signal: string) => void },
 *   createSnapshot?: (options: { sourceRoot: string }) => { root: string, cleanup: () => boolean },
 *   kill?: (signal: string) => void,
 * }} options
 * @returns {string}
 */
export function resolveClientRoot({
  configDir,
  env = process.env,
  log = (line) => console.log(line),
  lifecycle = process,
  createSnapshot = createClientSnapshot,
  kill = (signal) => process.kill(process.pid, signal),
}) {
  const published = env[CLIENT_ROOT_ENV];
  if (published === CLIENT_ROOT_CONTROL_VALUE) {
    // The control arm prints the degradation as well as the path, so a reader can tell "isolation was
    // switched off" apart from "isolation was on and produced the checkout's own path".
    log(`[e2e] client-root=${configDir} config-root=${configDir} degraded=control`);
    return configDir;
  }
  if (published !== undefined && published.length > 0) return published;

  const snapshot = createSnapshot({ sourceRoot: configDir });
  env[CLIENT_ROOT_ENV] = snapshot.root;
  log(`[e2e] client-root=${snapshot.root} config-root=${configDir}`);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      snapshot.cleanup();
    } catch {
      // The run is over; a leftover snapshot is inert, and a cleanup that threw here would replace
      // the run's own exit status with its housekeeping's.
    }
  };
  lifecycle.once('exit', cleanup);
  for (const signal of CLEANUP_SIGNALS) {
    lifecycle.once(signal, () => {
      cleanup();
      // `once` has already removed this listener, so re-raising reaches the default disposition (or
      // whatever else was listening) instead of this handler again.
      kill(signal);
    });
  }
  return snapshot.root;
}
