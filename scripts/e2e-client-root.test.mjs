#!/usr/bin/env node
/**
 * The controls for `scripts/e2e-client-root.mjs` — the run-scoped client tree the e2e client
 * `webServer` serves.
 *
 * WHY THESE CASES EXIST. The defect behind the module is a criterion that runs in the main checkout
 * while fan-in lands commits into it: Vite, started with `cwd` at that checkout, reloads the page
 * mid-case and the case fails for a reason none of its assertions can name (AC-345). The module's
 * whole claim is "the tree Vite serves is a snapshot, so an in-place write to the checkout cannot
 * reach it", and a test that only checked "a directory was created" would pass for the hardlink
 * implementation this module deliberately does NOT use. So the central reading here is an inode
 * comparison: source and snapshot are different files, and a write to one leaves the other's bytes
 * untouched.
 *
 * The cleanup cases are not decoration either. A snapshot that survives a red run is litter that
 * accumulates at the run rate under the parent it was copied into, and a cleanup that only covers
 * the green path is exactly the shape that leaves it behind on the nights it matters. The three
 * child-process cases therefore walk the three real outcomes — exit 0, exit 1, uncaught throw — and
 * read the directory back from the filesystem afterwards.
 *
 * EVERY CASE WORKS ON A FIXTURE, never on the checkout: the tree is a table of files this file
 * writes and removes, so the cases do not depend on the repository's own contents and never touch
 * them.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLIENT_ROOT_CONTROL_VALUE,
  CLIENT_ROOT_ENV,
  CLIENT_SOURCE_DIRECTORIES,
  createClientSnapshot,
  removeClientSnapshot,
  resolveClientRoot,
  snapshotPrefix,
} from './e2e-client-root.mjs';

const MODULE_URL = new URL('./e2e-client-root.mjs', import.meta.url).href;

/** A checkout-shaped fixture: client files, plus the root entries that must NOT be copied. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac345-client-root-src-'));
  const write = (relative, contents) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  };
  write('src/shared/api.ts', 'export const api = "source";\n');
  write('src/main.tsx', 'import "./index.css";\n');
  write('shared/networkHosts.js', 'export const getConnectableHost = (host) => host;\n');
  write('public/logo.txt', 'logo\n');
  write('index.html', '<div id="root"></div>\n');
  write('package.json', '{"name":"fixture","version":"1.2.3"}\n');
  write('vite.config.js', 'export default {};\n');
  write('postcss.config.js', 'export default {};\n');
  write('tailwind.config.js', 'export default {};\n');
  write('tsconfig.json', '{}\n');
  write('.env', 'VITE_FIXTURE=1\n');
  // Present at a real checkout root, and deliberately outside the client tree.
  write('server/index.ts', 'export const server = true;\n');
  write('server.log', 'a run log that must not be copied\n');
  write('dist/bundle.js', 'built output\n');
  write('.git/HEAD', 'ref: refs/heads/develop\n');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'vite'), '#!/bin/sh\n');
  return root;
}

/** Removes a fixture and any snapshot left beside it, whatever the case did. */
function cleanFixture(root) {
  for (const entry of fs.readdirSync(path.dirname(root))) {
    if (entry.startsWith(snapshotPrefix(root))) {
      fs.rmSync(path.join(path.dirname(root), entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/** Every snapshot directory currently beside `sourceRoot`. */
function snapshotsBeside(sourceRoot) {
  const prefix = snapshotPrefix(sourceRoot);
  return fs.readdirSync(path.dirname(sourceRoot)).filter((entry) => entry.startsWith(prefix));
}

test('a snapshot is a real copy: an in-place write to the checkout never reaches it', () => {
  const source = makeFixture();
  const snapshot = createClientSnapshot({ sourceRoot: source });
  try {
    const sourceFile = path.join(source, 'src', 'shared', 'api.ts');
    const snapshotFile = path.join(snapshot.root, 'src', 'shared', 'api.ts');

    // The reading the hardlink implementation would fail: a hardlink shares the inode (nlink 2) and
    // any write shows up on both sides. A real copy is a different file with one link.
    assert.equal(fs.statSync(sourceFile).nlink, 1, 'source file is not shared with another path');
    assert.notEqual(fs.statSync(sourceFile).ino, fs.statSync(snapshotFile).ino, 'snapshot file must be a different inode');

    fs.appendFileSync(sourceFile, '// in-place write after the run started\n');
    fs.writeFileSync(path.join(source, 'src', 'late-added.ts'), 'export const late = true;\n');

    assert.equal(fs.readFileSync(snapshotFile, 'utf8'), 'export const api = "source";\n', 'in-place write reached the snapshot');
    assert.equal(fs.existsSync(path.join(snapshot.root, 'src', 'late-added.ts')), false, 'a later source file appeared in the snapshot');
  } finally {
    snapshot.cleanup();
    cleanFixture(source);
  }
});

test('a snapshot carries the client tree and only the client tree', () => {
  const source = makeFixture();
  const snapshot = createClientSnapshot({ sourceRoot: source });
  try {
    for (const directory of CLIENT_SOURCE_DIRECTORIES) {
      assert.equal(fs.statSync(path.join(snapshot.root, directory)).isDirectory(), true, `${directory}/ is missing`);
    }
    for (const file of ['index.html', 'package.json', 'vite.config.js', 'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', '.env']) {
      assert.equal(fs.existsSync(path.join(snapshot.root, file)), true, `root file ${file} is missing`);
    }
    // `node_modules` is the install, shared as a link rather than copied.
    assert.equal(fs.lstatSync(path.join(snapshot.root, 'node_modules')).isSymbolicLink(), true, 'node_modules must be a symlink');
    assert.equal(fs.realpathSync(path.join(snapshot.root, 'node_modules')), fs.realpathSync(path.join(source, 'node_modules')));

    for (const excluded of ['server', 'dist', '.git', 'server.log']) {
      assert.equal(fs.existsSync(path.join(snapshot.root, excluded)), false, `${excluded} must not be copied`);
    }
    assert.notEqual(fs.realpathSync(snapshot.root), fs.realpathSync(source), 'snapshot must be its own directory');
  } finally {
    snapshot.cleanup();
    cleanFixture(source);
  }
});

test('cleanup removes the snapshot and refuses any directory not named as one', () => {
  const source = makeFixture();
  const snapshot = createClientSnapshot({ sourceRoot: source });
  try {
    assert.equal(removeClientSnapshot(snapshot.root), true);
    assert.equal(fs.existsSync(snapshot.root), false);
    assert.equal(removeClientSnapshot(snapshot.root), false, 'a second removal is a no-op, not a throw');

    // The guard: the control arm resolves the client root to the checkout, and this function must
    // never be able to delete it.
    assert.equal(removeClientSnapshot(source), false);
    assert.equal(fs.existsSync(source), true, 'the source checkout was deleted by cleanup');
  } finally {
    cleanFixture(source);
  }
});

test('resolveClientRoot publishes, reuses in a worker, and cleans up on exit', () => {
  const source = makeFixture();
  const handlers = new Map();
  const lifecycle = { once: (event, handler) => handlers.set(event, handler) };
  const env = {};
  const logged = [];

  const root = resolveClientRoot({
    configDir: source,
    env,
    log: (line) => logged.push(line),
    lifecycle,
    kill: () => assert.fail('no signal was raised'),
  });
  try {
    assert.equal(env[CLIENT_ROOT_ENV], root);
    assert.notEqual(root, source);
    assert.equal(fs.existsSync(path.join(root, 'src', 'shared', 'api.ts')), true);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`^\\[e2e\\] client-root=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} config-root=`));
    for (const event of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
      assert.equal(typeof handlers.get(event), 'function', `${event} cleanup listener is not registered`);
    }

    // A worker re-evaluates the config with the path already published: same root, no second copy,
    // no second announcement.
    const workerRoot = resolveClientRoot({ configDir: source, env, log: (line) => logged.push(line), lifecycle });
    assert.equal(workerRoot, root);
    assert.equal(logged.length, 1, 'a worker must not announce a second client root');
    assert.equal(snapshotsBeside(source).length, 1, 'a worker must not create a second snapshot');

    handlers.get('exit')();
    assert.equal(fs.existsSync(root), false, 'the exit listener left the snapshot behind');
  } finally {
    cleanFixture(source);
  }
});

test('a signal cleans the snapshot up before re-raising', () => {
  const source = makeFixture();
  const handlers = new Map();
  const raised = [];
  const root = resolveClientRoot({
    configDir: source,
    env: {},
    log: () => {},
    lifecycle: { once: (event, handler) => handlers.set(event, handler) },
    kill: (signal) => raised.push(signal),
  });
  try {
    handlers.get('SIGTERM')();
    assert.deepEqual(raised, ['SIGTERM']);
    assert.equal(fs.existsSync(root), false, 'the signal listener left the snapshot behind');
    // The `exit` listener that follows is idempotent: cleanup already ran.
    handlers.get('exit')();
    assert.equal(fs.existsSync(root), false);
  } finally {
    cleanFixture(source);
  }
});

test('the control arm degrades to the checkout itself and creates no snapshot', () => {
  const source = makeFixture();
  const env = { [CLIENT_ROOT_ENV]: CLIENT_ROOT_CONTROL_VALUE };
  const logged = [];
  try {
    const root = resolveClientRoot({ configDir: source, env, log: (line) => logged.push(line) });
    assert.equal(root, source);
    assert.equal(env[CLIENT_ROOT_ENV], CLIENT_ROOT_CONTROL_VALUE, 'the control value must stay readable to nested evaluations');
    assert.equal(snapshotsBeside(source).length, 0, 'the control arm must not create a snapshot');
    assert.match(logged[0], /degraded=control$/);
  } finally {
    cleanFixture(source);
  }
});

for (const outcome of ['green', 'red', 'throw']) {
  test(`cleanup covers the ${outcome} path (real child process)`, () => {
    const source = makeFixture();
    const script = `
      const run = async () => {
        const mod = await import(process.env.AC345_MODULE_URL);
        const root = mod.resolveClientRoot({ configDir: process.env.AC345_CONFIG_DIR });
        process.stdout.write('ROOT=' + root + '\\n');
        if (process.env.AC345_OUTCOME === 'red') process.exit(1);
        if (process.env.AC345_OUTCOME === 'throw') throw new Error('ac345 simulated case failure');
      };
      run();
    `;
    const env = { ...process.env, AC345_MODULE_URL: MODULE_URL, AC345_CONFIG_DIR: source, AC345_OUTCOME: outcome };
    delete env[CLIENT_ROOT_ENV];
    try {
      const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
      const expectedCode = outcome === 'green' ? 0 : 1;
      assert.equal(result.status, expectedCode, `${outcome} child exited ${result.status}: ${result.stderr}`);

      const announced = result.stdout.match(/^\[e2e\] client-root=(.+?) config-root=/m);
      assert.ok(announced, `the ${outcome} child did not announce its client root: ${result.stdout}`);
      const root = announced[1];
      assert.equal(path.basename(root).includes('-clientroot-'), true);
      assert.equal(fs.existsSync(root), false, `the ${outcome} child left its snapshot behind`);
      assert.equal(snapshotsBeside(source).length, 0);
    } finally {
      cleanFixture(source);
    }
  });
}
