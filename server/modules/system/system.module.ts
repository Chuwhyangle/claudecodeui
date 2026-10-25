import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';
import type { Router } from 'express';

import {
  createDeployReadinessService,
  verifyPendingDeploy,
  type DeployBuildFingerprint,
  type DeployCommandResult,
  type DeployGitReading,
  type DeployPersistedState,
} from './deploy-readiness.service.js';
import { createSystemRouter } from './system.routes.js';
import { createSystemUpdateService } from './system.service.js';

type SystemModuleOptions = {
  appRoot: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  /** The running process's build fingerprint, captured once at boot by `server/index.ts`. */
  runningBuildInfo: DeployBuildFingerprint;
  /** The listening port the boot verifier probes (loopback). Read lazily: the entrypoint
   * resolves it after this module is constructed. */
  serverPort(): number;
  /** The fleet handshake state, injected by the composition root's quay service. */
  readFleetState: () => Promise<string | null>;
};

function runShellCommand(
  command: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  onOutput: (output: string) => void,
  onErrorOutput: (errorOutput: string) => void,
): Promise<{ exitCode: number | null; output: string; errorOutput: string }> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn('sh', ['-c', command], {
      cwd: workingDirectory,
      env: environment,
    });
    let output = '';
    let errorOutput = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      onOutput(text);
    });
    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      errorOutput += text;
      onErrorOutput(text);
    });
    childProcess.once('error', reject);
    childProcess.once('close', (exitCode) => {
      resolve({ exitCode, output, errorOutput });
    });
  });
}

/**
 * Runs one command to completion and collects its two output streams. The deployment action
 * needs the whole transcript (the failure reading keeps its tail), so this buffers rather than
 * streams — unlike the interactive update path above.
 */
function runBuffered(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<DeployCommandResult> {
  return new Promise((resolve) => {
    const childProcess = spawn(command, args, options);
    let output = '';
    let errorOutput = '';
    childProcess.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    childProcess.stderr?.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });
    childProcess.once('error', (error) => {
      resolve({ exitCode: null, output, errorOutput: `${errorOutput}${error.message}` });
    });
    childProcess.once('close', (exitCode) => {
      resolve({ exitCode, output, errorOutput });
    });
  });
}

/**
 * The production git reading. Merge commits are skipped: they carry no reviewable change of
 * their own, and listing every `Merge develop` would bury the commits that actually need a
 * build. One `git log --name-only` call answers the whole range.
 */
function createGitReading(appRoot: string): DeployGitReading {
  const git = (args: string[]): string | null => {
    const result = spawnSync('git', args, { cwd: appRoot, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      return null;
    }
    return String(result.stdout ?? '');
  };

  return {
    headSha: () => {
      const stdout = git(['rev-parse', 'HEAD']);
      const sha = stdout?.trim() ?? '';
      return sha === '' ? null : sha;
    },
    commitsBetween: (fromSha, toSha) => {
      const stdout = git([
        'log',
        '--no-merges',
        '--name-only',
        '--format=__COMMIT__%H%x09%s',
        `${fromSha}..${toSha}`,
      ]);
      if (stdout === null) {
        return [];
      }

      const commits: { sha: string; subject: string; paths: string[] }[] = [];
      let current: { sha: string; subject: string; paths: string[] } | null = null;
      for (const line of stdout.split('\n')) {
        if (line.startsWith('__COMMIT__')) {
          const [sha = '', subject = ''] = line.slice('__COMMIT__'.length).split('\t');
          current = { sha, subject, paths: [] };
          commits.push(current);
          continue;
        }
        if (line.trim() !== '' && current !== null) {
          current.paths.push(line.trim());
        }
      }
      return commits;
    },
  };
}

/** Reads/writes the deploy state file that carries the target sha across the restart. */
function createStateStore(filePath: string) {
  return {
    read(): DeployPersistedState | null {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) {
          return null;
        }
        const record = parsed as Partial<DeployPersistedState>;
        if (typeof record.targetSha !== 'string' || record.targetSha === '') {
          return null;
        }
        return record as DeployPersistedState;
      } catch {
        return null;
      }
    },
    write(state: DeployPersistedState): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}

/**
 * Builds the authenticated system router for the server entrypoint using the
 * installation details it already resolves for health and startup metadata.
 *
 * Returns the module's three faces: the router (mounted under `/api/system`), the boot verifier
 * (`verifyPendingDeploy`), which the entrypoint runs after `listen` so a deploy's target sha can
 * be checked against the process that just came up, and the deploy reading
 * (`readDeployReadiness`), which the composition root bridges into the notice registry.
 */
export function createSystemModule(options: SystemModuleOptions) {
  const homeDirectory = os.homedir();
  const systemUpdateService = createSystemUpdateService({
    ...options,
    homeDirectory,
    environment: process.env,
    runShellCommand,
    logInfo: (message, detail) => console.log(message, detail ?? ''),
    logError: (message, detail) => console.error(message, detail ?? ''),
  });

  const statePath = process.env.QUAY_DEPLOY_STATE_FILE
    ?? path.join(homeDirectory, '.ccui-restart', 'deploy-state.json');
  const stateStore = createStateStore(statePath);
  const buildUnitId = `cui-build-${Date.now()}-${process.pid}`;

  /**
   * The build runs in its own transient unit so it is not a child of the server's cgroup: the
   * restart at the end of the action stops that cgroup, and a build inside it would be killed
   * half-way. Without a usable user manager (an npm-tarball install on a host without systemd)
   * it falls back to an ordinary child, which still works — the cgroup hazard only exists where
   * the restart is a systemctl stop.
   */
  const runBuild = async (): Promise<DeployCommandResult> => {
    const buildCommand = process.env.QUAY_DEPLOY_BUILD_COMMAND ?? 'npm run build';
    const hasSystemdRun = spawnSync('sh', ['-lc', 'command -v systemd-run'], {
      encoding: 'utf8',
    }).status === 0;
    const environment = { ...process.env, PATH: process.env.PATH ?? '' };
    const home = process.env.HOME;

    if (hasSystemdRun) {
      return runBuffered(
        'systemd-run',
        [
          '--user',
          '--quiet',
          '--collect',
          '--wait',
          '--pipe',
          `--unit=${buildUnitId}`,
          `--working-directory=${options.appRoot}`,
          `--setenv=PATH=${environment.PATH}`,
          ...(home === undefined ? [] : [`--setenv=HOME=${home}`]),
          'bash',
          '-lc',
          buildCommand,
        ],
        { cwd: options.appRoot, env: environment },
      );
    }

    return runBuffered('bash', ['-lc', buildCommand], {
      cwd: options.appRoot,
      env: environment,
    });
  };

  // The restart script is a test seam: an isolated verification instance points this at a stub
  // so exercising 「构建并重启」 in a browser cannot stop the host's real :3001 service.
  const restartScript = process.env.QUAY_RESTART_SCRIPT
    ?? path.join(options.appRoot, 'scripts', 'restart-server-detached.sh');

  const deployService = createDeployReadinessService({
    appRoot: options.appRoot,
    runningBuildInfo: options.runningBuildInfo,
    git: createGitReading(options.appRoot),
    readState: stateStore.read,
    writeState: stateStore.write,
    runBuild,
    // `--delay 5` gives the action's response time to leave before the detached restarter
    // stops the unit the browser is currently talking to.
    runRestartScript: (args) =>
      runBuffered('bash', [restartScript, ...args], {
        cwd: options.appRoot,
        env: process.env,
      }),
    now: () => Date.now(),
    logInfo: (message) => console.log(message),
    logError: (message) => console.error(message),
  });

  let verificationStarted = false;

  return {
    router: createSystemRouter(systemUpdateService, deployService),
    /**
     * The deploy reading, exposed so the composition root can bridge it into the notice
     * registry's deploy provider. Nothing inside this module reads it through this seam — the
     * `/api/system/deploy-readiness` route keeps calling the service directly — so this is the
     * one-way arrow the notice model requires (the notice module never imports system, N8).
     */
    readDeployReadiness: deployService.readReadiness,
    /**
     * Runs once, after `listen`. Reads the state file the deploy action wrote and records the
     * verification in the same file, so the reading after this boot answers 「重启成功了吗」
     * without a person asking it.
     */
    async verifyPendingDeploy() {
      if (verificationStarted) {
        return null;
      }
      verificationStarted = true;
      const baseUrl = `http://127.0.0.1:${options.serverPort()}`;
      const probeRoute = async (name: 'root' | 'cockpit'): Promise<number | null> => {
        const route = name === 'root' ? '/' : '/cockpit';
        try {
          const response = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
          return response.status;
        } catch {
          return null;
        }
      };
      return verifyPendingDeploy({
        runningSha: options.runningBuildInfo.gitSha,
        readState: stateStore.read,
        writeState: stateStore.write,
        probeRoute,
        readFleetState: async () => {
          try {
            return await options.readFleetState();
          } catch {
            return null;
          }
        },
        now: () => Date.now(),
        logInfo: (message) => console.log(message),
      });
    },
  };
}

export type { SystemModuleOptions };
