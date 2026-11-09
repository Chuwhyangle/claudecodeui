import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createQuayEntrypointResolver,
  type QuayEntrypointFileSystem,
} from '../read/quay-entrypoint-resolver.js';

/**
 * The resolver's criteria. Every file read goes through the injected seam below, so the cases
 * describe a machine (Claude plugin cache, settings files, legacy project link) without touching
 * this host's real home directory — the same reason the resolver exists: the installed plugin
 * version and the project's link state are properties of the machine, not of the code.
 */

const HOME = path.join(path.sep, 'home', 'tester');
const PROJECT = path.join(path.sep, 'workspace', 'project');
const OTHER_PROJECT = path.join(path.sep, 'workspace', 'other');

const SETTINGS_PATH = path.join(HOME, '.config', 'claudecodeui', 'server.settings.json');
const INSTALLED_PLUGINS_PATH = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
const USER_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const PROJECT_SETTINGS_PATH = path.join(PROJECT, '.claude', 'settings.json');
const PROJECT_LOCAL_SETTINGS_PATH = path.join(PROJECT, '.claude', 'settings.local.json');
const PLUGIN_CACHE = path.join(HOME, '.claude', 'plugins', 'cache');
const LEGACY_PLUGIN_PATH = path.join(PROJECT, '.quay', 'plugin');

type FakeFile = { kind: 'file'; content: string; mtimeMs: number };
type FakeDirectory = { kind: 'dir'; mtimeMs: number };
type FakeLink = { kind: 'link'; target: string };
type FakeNode = FakeFile | FakeDirectory | FakeLink;

function file(content: string, mtimeMs = 1): FakeFile {
  return { kind: 'file', content, mtimeMs };
}

function directory(mtimeMs = 1): FakeDirectory {
  return { kind: 'dir', mtimeMs };
}

function link(target: string): FakeLink {
  return { kind: 'link', target };
}

/** The install root a plugin version lives at under the Claude cache. */
function pluginRoot(version: string): string {
  return path.join(PLUGIN_CACHE, 'quay', 'quay', version);
}

/** Registers a complete plugin install (directory, `bin/quay`, `VERSION`) in the fake tree. */
function addPluginInstall(nodes: Map<string, FakeNode>, version: string): string {
  const root = pluginRoot(version);
  nodes.set(root, directory());
  nodes.set(path.join(root, 'bin'), directory());
  nodes.set(path.join(root, 'bin', 'quay'), file('#!/bin/sh\n', 100));
  nodes.set(path.join(root, 'VERSION'), file(`${version}\n`, 100));
  return root;
}

/** One `quay@quay` record in `installed_plugins.json`. */
function pluginRecord(
  scope: 'user' | 'project' | 'local',
  installPath: string,
  version: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { scope, installPath, version, lastUpdated: '2026-01-01T00:00:00.000Z', ...extra };
}

/** The `installed_plugins.json` document carrying the given records. */
function installedPlugins(records: Record<string, unknown>[], mtimeMs = 1): FakeFile {
  return file(JSON.stringify({ version: 2, plugins: { 'quay@quay': records } }), mtimeMs);
}

/** A settings file carrying one boolean under `enabledPlugins`. */
function enabledPlugins(value: boolean, mtimeMs = 1): FakeFile {
  return file(JSON.stringify({ enabledPlugins: { 'quay@quay': value } }), mtimeMs);
}

/**
 * An in-memory filesystem with real symlink semantics: a symlink component is followed, a link
 * whose target is absent reads as dangling (stat/realpath `null`), and every `readText` is
 * recorded so the cache criterion can count reads. It reads the caller's live map, so a test can
 * model a plugin upgrade by replacing a node's mtime — the same mutation a real install performs.
 */
function createFakeFileSystem(nodes: Map<string, FakeNode>): {
  fileSystem: QuayEntrypointFileSystem;
  readTextCalls: string[];
} {
  const readTextCalls: string[] = [];

  /**
   * The canonical path with every symlink COMPONENT followed. Missing intermediate directories
   * are treated as ordinary directories (the fake tree only records entries a criterion cares
   * about); a missing final component still reads as absent through `nodes.get`.
   */
  const resolvePath = (input: string, depth = 0): string | null => {
    if (depth > 20) {
      return null;
    }
    const segments = path.resolve(input).split(path.sep).filter(Boolean);
    let current: string = path.sep;
    for (let index = 0; index < segments.length; index += 1) {
      const next = path.join(current, segments[index] as string);
      const node = nodes.get(next);
      if (node !== undefined && node.kind === 'link') {
        const target = path.isAbsolute(node.target)
          ? node.target
          : path.resolve(path.dirname(next), node.target);
        const rest = segments.slice(index + 1);
        return resolvePath(rest.length > 0 ? path.join(target, ...rest) : target, depth + 1);
      }
      current = next;
    }
    return current;
  };

  const fileSystem: QuayEntrypointFileSystem = {
    readText(filePath) {
      readTextCalls.push(path.resolve(filePath));
      const resolved = resolvePath(filePath);
      const node = resolved === null ? undefined : nodes.get(resolved);
      return node !== undefined && node.kind === 'file' ? node.content : null;
    },
    stat(filePath) {
      const resolved = resolvePath(filePath);
      const node = resolved === null ? undefined : nodes.get(resolved);
      if (node === undefined) {
        return null;
      }
      if (node.kind === 'file') {
        return { isFile: true, isDirectory: false, mtimeMs: node.mtimeMs, size: node.content.length };
      }
      if (node.kind === 'dir') {
        return { isFile: false, isDirectory: true, mtimeMs: node.mtimeMs, size: 0 };
      }
      return null;
    },
    realpath(filePath) {
      const resolved = resolvePath(filePath);
      return resolved !== null && nodes.has(resolved) ? resolved : null;
    },
    readlink(filePath) {
      const node = nodes.get(path.resolve(filePath));
      return node !== undefined && node.kind === 'link' ? node.target : null;
    },
  };

  return { fileSystem, readTextCalls };
}

function createResolver(nodes: Map<string, FakeNode>): ReturnType<typeof createQuayEntrypointResolver> {
  const { fileSystem } = createFakeFileSystem(nodes);
  return createQuayEntrypointResolver({
    fileSystem,
    homeDir: HOME,
    settingsPath: SETTINGS_PATH,
  });
}

test('AC1: the SERVER override wins over every plugin record', () => {
  const nodes = new Map<string, FakeNode>();
  const localInstall = addPluginInstall(nodes, '0.22.0');
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    pluginRecord('local', localInstall, '0.22.0', { projectPath: PROJECT }),
  ]));
  nodes.set(SETTINGS_PATH, file(JSON.stringify({
    quay: { entrypoints: { [PROJECT]: path.join(path.sep, 'opt', 'pinned', 'bin', 'quay') } },
  })));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'override');
  assert.equal(resolution.path, path.join(path.sep, 'opt', 'pinned', 'bin', 'quay'));
});

test('AC1: local records outrank project records, which outrank user records', () => {
  const nodes = new Map<string, FakeNode>();
  const userInstall = addPluginInstall(nodes, '0.19.0');
  const projectInstall = addPluginInstall(nodes, '0.20.0');
  const localInstall = addPluginInstall(nodes, '0.22.0');
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    // Deliberately written user-first: the resolver must order by scope, not by file order.
    pluginRecord('user', userInstall, '0.19.0'),
    pluginRecord('project', projectInstall, '0.20.0', { projectPath: PROJECT }),
    pluginRecord('local', localInstall, '0.22.0', { projectPath: PROJECT }),
  ]));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'local');
  assert.equal(resolution.version, '0.22.0');
  assert.equal(resolution.path, path.join(localInstall, 'bin', 'quay'));
});

test('AC1: project/local records whose projectPath is another root are ignored', () => {
  const nodes = new Map<string, FakeNode>();
  const otherInstall = addPluginInstall(nodes, '0.20.0');
  const userInstall = addPluginInstall(nodes, '0.22.0');
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    pluginRecord('project', otherInstall, '0.20.0', { projectPath: OTHER_PROJECT }),
    pluginRecord('local', otherInstall, '0.20.0', { projectPath: OTHER_PROJECT }),
    pluginRecord('user', userInstall, '0.22.0'),
  ]));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'user');
  assert.equal(resolution.path, path.join(userInstall, 'bin', 'quay'));
});

test('AC1: a scope with enabledPlugins[quay@quay] false is skipped', () => {
  const nodes = new Map<string, FakeNode>();
  const localInstall = addPluginInstall(nodes, '0.22.0');
  const userInstall = addPluginInstall(nodes, '0.19.0');
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    pluginRecord('local', localInstall, '0.22.0', { projectPath: PROJECT }),
    pluginRecord('user', userInstall, '0.19.0'),
  ]));
  nodes.set(USER_SETTINGS_PATH, enabledPlugins(true));
  nodes.set(PROJECT_LOCAL_SETTINGS_PATH, enabledPlugins(false));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'user');
  assert.equal(resolution.path, path.join(userInstall, 'bin', 'quay'));
});

test('AC2: a higher-priority record whose installPath is gone degrades to the next scope with a warning', () => {
  const nodes = new Map<string, FakeNode>();
  const userInstall = addPluginInstall(nodes, '0.22.0');
  const removedProjectInstall = pluginRoot('0.99.0');
  // The directory is deliberately absent from the fake tree: a cleaned-up version.
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    pluginRecord('project', removedProjectInstall, '0.99.0', { projectPath: PROJECT }),
    pluginRecord('user', userInstall, '0.22.0'),
  ]));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'user');
  assert.equal(resolution.path, path.join(userInstall, 'bin', 'quay'));
  assert.notEqual(resolution.source, 'path');
  assert.ok(resolution.warning !== null);
  assert.match(resolution.warning, /no longer exists/);
  assert.ok(resolution.warning.includes(removedProjectInstall));
});

test('AC3: a legacy link into the Claude cache is ignored and resolution falls through to PATH', () => {
  const nodes = new Map<string, FakeNode>();
  // The cache install exists, but the project points at it through the retired link mechanism.
  const cachedInstall = addPluginInstall(nodes, '0.22.0');
  nodes.set(path.join(PROJECT, '.quay'), directory());
  nodes.set(LEGACY_PLUGIN_PATH, link(cachedInstall));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'path');
  assert.equal(resolution.path, 'quay');
});

test('AC3: a dangling legacy link into the Claude cache is ignored as well', () => {
  const nodes = new Map<string, FakeNode>();
  nodes.set(path.join(PROJECT, '.quay'), directory());
  nodes.set(LEGACY_PLUGIN_PATH, link(pluginRoot('0.99.0')));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'path');
  assert.equal(resolution.path, 'quay');
});

test('AC3: a legacy pin outside the plugin cache is adopted as legacy-pin', () => {
  const nodes = new Map<string, FakeNode>();
  const devCheckout = path.join(path.sep, 'work', 'quay', 'plugin');
  nodes.set(path.join(PROJECT, '.quay'), directory());
  nodes.set(devCheckout, directory());
  nodes.set(path.join(devCheckout, 'bin'), directory());
  nodes.set(path.join(devCheckout, 'bin', 'quay'), file('#!/bin/sh\n'));
  nodes.set(path.join(devCheckout, 'VERSION'), file('0.23.0-dev\n'));
  nodes.set(LEGACY_PLUGIN_PATH, link(devCheckout));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'legacy-pin');
  assert.equal(resolution.path, path.join(LEGACY_PLUGIN_PATH, 'bin', 'quay'));
  assert.equal(resolution.version, '0.23.0-dev');
});

test('AC3: a real (non-link) legacy plugin directory outside the cache is still a legacy pin', () => {
  const nodes = new Map<string, FakeNode>();
  nodes.set(LEGACY_PLUGIN_PATH, directory());
  nodes.set(path.join(LEGACY_PLUGIN_PATH, 'bin'), directory());
  nodes.set(path.join(LEGACY_PLUGIN_PATH, 'bin', 'quay'), file('#!/bin/sh\n'));
  nodes.set(path.join(LEGACY_PLUGIN_PATH, 'VERSION'), file('0.22.0\n'));

  const resolution = createResolver(nodes).resolve(PROJECT);

  assert.equal(resolution.source, 'legacy-pin');
  assert.equal(resolution.path, path.join(LEGACY_PLUGIN_PATH, 'bin', 'quay'));
});

test('AC4: repeated resolutions read installed_plugins.json once; a changed mtime re-reads it', () => {
  const nodes = new Map<string, FakeNode>();
  const oldInstall = addPluginInstall(nodes, '0.19.0');
  const newInstall = addPluginInstall(nodes, '0.22.0');
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    pluginRecord('user', oldInstall, '0.19.0'),
  ], 1));

  const { fileSystem, readTextCalls } = createFakeFileSystem(nodes);
  const resolver = createQuayEntrypointResolver({
    fileSystem,
    homeDir: HOME,
    settingsPath: SETTINGS_PATH,
  });

  const countInstalledReads = (): number =>
    readTextCalls.filter((filePath) => filePath === path.resolve(INSTALLED_PLUGINS_PATH)).length;

  const first = resolver.resolve(PROJECT);
  const second = resolver.resolve(PROJECT);

  assert.equal(first.version, '0.19.0');
  assert.deepEqual(second, first);
  assert.equal(countInstalledReads(), 1, 'a repeated resolution must not re-read installed_plugins.json');

  // A plugin upgrade rewrites installed_plugins.json (new mtime+size); the same resolver instance
  // must notice on the next call and re-read it.
  nodes.set(INSTALLED_PLUGINS_PATH, installedPlugins([
    pluginRecord('user', newInstall, '0.22.0'),
  ], 2));

  const upgraded = resolver.resolve(PROJECT);

  assert.equal(upgraded.path, path.join(newInstall, 'bin', 'quay'));
  assert.equal(upgraded.version, '0.22.0');
  assert.equal(countInstalledReads(), 2);
});
