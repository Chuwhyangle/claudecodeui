import fs from 'node:fs';
import path from 'node:path';

type SystemUpdateCommandResult = {
  exitCode: number | null;
  output: string;
  errorOutput: string;
};

type SystemUpdateDependencies = {
  appRoot: string;
  homeDirectory: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  environment: NodeJS.ProcessEnv;
  runShellCommand(
    command: string,
    workingDirectory: string,
    environment: NodeJS.ProcessEnv,
    onOutput: (output: string) => void,
    onErrorOutput: (errorOutput: string) => void,
  ): Promise<SystemUpdateCommandResult>;
  logInfo(message: string, detail?: string): void;
  logError(message: string, detail?: string): void;
};

/**
 * Creates the update workflow used by the system module and its focused tests.
 * Runtime-specific process spawning stays behind the injected command adapter.
 */
export function createSystemUpdateService(dependencies: SystemUpdateDependencies) {
  return {
    /** Selects and executes the correct update workflow for this installation. */
    async updateSystem() {
      const updateCommand = dependencies.isPlatform
        ? 'npm run update:platform'
        : dependencies.installMode === 'git'
          ? 'git checkout main && git pull && npm install'
          : 'npm install -g @yalehwang/cloudcli@latest';
      const workingDirectory = dependencies.isPlatform || dependencies.installMode === 'git'
        ? dependencies.appRoot
        : dependencies.homeDirectory;

      dependencies.logInfo('Starting system update from directory:', workingDirectory);

      try {
        const result = await dependencies.runShellCommand(
          updateCommand,
          workingDirectory,
          dependencies.environment,
          (output) => dependencies.logInfo('Update output:', output),
          (errorOutput) => dependencies.logError('Update error:', errorOutput),
        );

        if (result.exitCode === 0) {
          return {
            success: true as const,
            output: result.output || 'Update completed successfully',
            message: 'Update completed. Please restart the server to apply changes.',
          };
        }

        return {
          success: false as const,
          error: 'Update command failed',
          output: result.output,
          errorOutput: result.errorOutput,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logError('Update process error:', message);
        return {
          success: false as const,
          error: message,
        };
      }
    },
  };
}

/**
 * Reads the build record (`dist-server/build-info.json`) that `scripts/write-build-info.mjs`
 * writes during `npm run build:server`. Consumed by the server entrypoint's `/health` route
 * (server/index.ts), which captures it once at startup so a long-lived process keeps reporting
 * the commit it was built from, and by this module's focused tests.
 *
 * A missing, unreadable, or malformed record is an expected state, not a startup error: a `tsx`
 * development instance never produces the file, and an installation built before this record
 * existed has none either. Both resolve to `{ gitSha: null, builtAt: null }` rather than throwing,
 * so `/health` can report `buildSha: null` and a caller can distinguish "not built here" from
 * "built from a known commit".
 */
export function readBuildInfo(appRoot: string): { gitSha: string | null; builtAt: string | null } {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(appRoot, 'dist-server', 'build-info.json'), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) {
      return { gitSha: null, builtAt: null };
    }
    const record = parsed as { gitSha?: unknown; builtAt?: unknown };
    return {
      gitSha: typeof record.gitSha === 'string' ? record.gitSha : null,
      builtAt: typeof record.builtAt === 'string' ? record.builtAt : null,
    };
  } catch {
    return { gitSha: null, builtAt: null };
  }
}
