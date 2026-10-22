// @ts-nocheck -- subprocess records are narrowed at the Plugins composition boundary.
import path from 'path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { scanPlugins, getPluginsConfig, getPluginDir } from './plugin-registry.service.js';

/**
 * The process-wide lifecycle of plugin server subprocesses.
 *
 * Owns the two mutable maps that used to sit at module top level: the servers
 * that are up (`runningPlugins`) and the start operations in flight
 * (`startingPlugins`). Keeping them as private fields with named operations is
 * what makes the lifecycle explicit — a server is recorded only once it reports
 * ready, concurrent starts of the same plugin coalesce on one in-flight
 * promise, and the exit handler that ends the process drops both entries.
 *
 * Consumers (`plugins.module.ts` adapters, the server entrypoint, and the
 * WebSocket proxy) reach the state only through the exported functions below,
 * so the maps cannot be mutated behind the lifecycle's back.
 */
class PluginProcessManager {
  // Map<pluginName, { process, port }>
  private runningPlugins = new Map();
  // Map<pluginName, Promise<port>> — in-flight start operations
  private startingPlugins = new Map();

  /**
   * Start a plugin's server subprocess.
   * The plugin's server entry must print a JSON line with { ready: true, port: <number> }
   * to stdout within 10 seconds.
   */
  start(name, pluginDir, serverEntry) {
    if (this.runningPlugins.has(name)) {
      return Promise.resolve(this.runningPlugins.get(name).port);
    }

    // Coalesce concurrent starts for the same plugin
    if (this.startingPlugins.has(name)) {
      return this.startingPlugins.get(name);
    }

    const startPromise = new Promise((resolve, reject) => {

      const serverPath = path.join(pluginDir, serverEntry);

      const pluginProcess = spawn('node', [serverPath], {
        cwd: pluginDir,
        env: buildPluginEnv(name),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      let stdout = '';

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          pluginProcess.kill();
          reject(new Error('Plugin server did not report ready within 10 seconds'));
        }
      }, 10000);

      pluginProcess.stdout.on('data', (data) => {
        if (resolved) return;
        stdout += data.toString();

        // Look for the JSON ready line
        const lines = stdout.split('\n');
        for (const line of lines) {
          try {
            const msg = JSON.parse(line.trim());
            if (msg.ready && typeof msg.port === 'number') {
              clearTimeout(timeout);
              resolved = true;
              this.runningPlugins.set(name, { process: pluginProcess, port: msg.port });

              pluginProcess.on('exit', () => {
                this.runningPlugins.delete(name);
              });

              console.log(`[Plugins] Server started for "${name}" on port ${msg.port}`);
              resolve(msg.port);
            }
          } catch {
            // Not JSON yet, keep buffering
          }
        }
      });

      pluginProcess.stderr.on('data', (data) => {
        console.warn(`[Plugin:${name}] ${data.toString().trim()}`);
      });

      pluginProcess.on('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to start plugin server: ${err.message}`));
        }
      });

      pluginProcess.on('exit', (code) => {
        clearTimeout(timeout);
        this.runningPlugins.delete(name);
        if (!resolved) {
          resolved = true;
          reject(new Error(`Plugin server exited with code ${code} before reporting ready`));
        }
      });
    }).finally(() => {
      this.startingPlugins.delete(name);
    });

    this.startingPlugins.set(name, startPromise);
    return startPromise;
  }

  /**
   * Stop a plugin's server subprocess.
   * Returns a Promise that resolves when the process has fully exited.
   */
  stop(name) {
    const entry = this.runningPlugins.get(name);
    if (!entry) return Promise.resolve();

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(forceKillTimer);
        this.runningPlugins.delete(name);
        resolve();
      };

      entry.process.once('exit', cleanup);

      entry.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      const forceKillTimer = setTimeout(() => {
        if (this.runningPlugins.has(name)) {
          entry.process.kill('SIGKILL');
          cleanup();
        }
      }, 5000);

      console.log(`[Plugins] Server stopped for "${name}"`);
    });
  }

  /**
   * Get the port a running plugin server is listening on.
   */
  getPort(name) {
    return this.runningPlugins.get(name)?.port ?? null;
  }

  /**
   * Check if a plugin's server is running.
   */
  isRunning(name) {
    return this.runningPlugins.has(name);
  }

  /**
   * Stop all running plugin servers (called on host shutdown).
   */
  stopAll() {
    const stops = [];
    for (const [name] of this.runningPlugins) {
      stops.push(this.stop(name));
    }
    return Promise.all(stops);
  }
}

/** The process's single plugin server manager — subprocess state is process-local. */
const pluginProcessManager = new PluginProcessManager();

/**
 * Build the environment handed to a plugin server subprocess.
 *
 * Intentionally minimal: only non-secret essentials, never the host's full
 * environment. On Windows a handful of system variables are required for any
 * child to bootstrap (Node itself, and any Python or CLI a plugin shells out
 * to). Without APPDATA a `pip install --user` tool cannot locate its
 * site-packages and fails to import; SystemRoot, PATHEXT and TEMP are needed to
 * resolve system DLLs, executable extensions and a temp directory. None of
 * these carry secrets, so the ones that are set get passed straight through.
 */
function buildPluginEnv(name) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PLUGIN_NAME: name,
  };

  if (process.platform === 'win32') {
    const WINDOWS_ESSENTIALS = [
      'SystemRoot', 'windir', 'SystemDrive',
      'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TEMP', 'TMP', 'PATHEXT',
    ];
    for (const key of WINDOWS_ESSENTIALS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }

  return env;
}

/**
 * Start a plugin's server subprocess.
 *
 * Used by the server entrypoint (enabled-plugin boot) and by the
 * `plugins.module.ts` service adapters (enable action); it delegates to
 * `pluginProcessManager`, so the start semantics are the manager's, unchanged.
 */
export function startPluginServer(name, pluginDir, serverEntry) {
  return pluginProcessManager.start(name, pluginDir, serverEntry);
}

/**
 * Stop a plugin's server subprocess.
 *
 * Used by the `plugins.module.ts` service adapters (disable/uninstall actions);
 * delegates to `pluginProcessManager`.
 */
export function stopPluginServer(name) {
  return pluginProcessManager.stop(name);
}

/**
 * Get the port a running plugin server is listening on.
 *
 * Used by WebSocket setup in the server entrypoint to proxy plugin connections,
 * and by the `plugins.module.ts` service adapters; delegates to
 * `pluginProcessManager`.
 */
export function getPluginPort(name) {
  return pluginProcessManager.getPort(name);
}

/**
 * Check if a plugin's server is running.
 *
 * Used by the `plugins.module.ts` service adapters; delegates to
 * `pluginProcessManager`.
 */
export function isPluginRunning(name) {
  return pluginProcessManager.isRunning(name);
}

/**
 * Stop all running plugin servers (called on host shutdown).
 *
 * Used by the server entrypoint's shutdown path; delegates to
 * `pluginProcessManager`.
 */
export function stopAllPlugins() {
  return pluginProcessManager.stopAll();
}

/**
 * Start servers for all enabled plugins that have a server entry.
 * Called once on host server boot.
 */
export async function startEnabledPluginServers() {
  const plugins = scanPlugins();
  const config = getPluginsConfig();

  for (const plugin of plugins) {
    if (!plugin.server) continue;
    if (config[plugin.name]?.enabled === false) continue;

    const pluginDir = getPluginDir(plugin.name);
    if (!pluginDir) continue;

    try {
      await pluginProcessManager.start(plugin.name, pluginDir, plugin.server);
    } catch (err) {
      console.error(`[Plugins] Failed to start server for "${plugin.name}":`, err.message);
    }
  }
}
