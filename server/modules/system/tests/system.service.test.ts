import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSystemUpdateService, readBuildInfo } from '../system.service.js';

// Each case needs a real filesystem tree; a fresh temp root keeps the record location
// (`<appRoot>/dist-server/build-info.json`) unambiguous and leaves the repository untouched.
function withTempAppRoot(run: (appRoot: string) => void): void {
  const appRoot = mkdtempSync(path.join(tmpdir(), 'read-build-info-'));
  try {
    run(appRoot);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}

type SystemUpdateDependencies = Parameters<typeof createSystemUpdateService>[0];

function createDependencies(
  overrides: Partial<SystemUpdateDependencies> = {},
): SystemUpdateDependencies {
  return {
    appRoot: '/app/cloudcli',
    homeDirectory: '/home/cloudcli',
    installMode: 'git',
    isPlatform: false,
    environment: { TEST_ENVIRONMENT: 'true' },
    runShellCommand: async () => ({ exitCode: 0, output: 'updated', errorOutput: '' }),
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('git installations update from the application root', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: 'git update complete', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.updateSystem();

  assert.deepEqual(calls, [[
    'git checkout main && git pull && npm install',
    '/app/cloudcli',
    dependencies.environment,
  ]]);
  assert.deepEqual(result, {
    success: true,
    output: 'git update complete',
    message: 'Update completed. Please restart the server to apply changes.',
  });
});

test('global npm installations update from the user home directory', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: '', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  const result = await service.updateSystem();

  assert.deepEqual(calls, [[
    'npm install -g @yalehwang/cloudcli@latest',
    '/home/cloudcli',
    dependencies.environment,
  ]]);
  assert.equal(result.output, 'Update completed successfully');
});

test('platform installations use the platform workflow regardless of install mode', async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    installMode: 'npm',
    isPlatform: true,
    runShellCommand: async (command, workingDirectory, environment) => {
      calls.push([command, workingDirectory, environment]);
      return { exitCode: 0, output: 'platform update complete', errorOutput: '' };
    },
  });
  const service = createSystemUpdateService(dependencies);

  await service.updateSystem();

  assert.deepEqual(calls, [[
    'npm run update:platform',
    '/app/cloudcli',
    dependencies.environment,
  ]]);
});

test('failed update commands retain stdout and stderr for the existing API contract', async () => {
  const service = createSystemUpdateService(createDependencies({
    runShellCommand: async () => ({
      exitCode: 1,
      output: 'installing',
      errorOutput: 'npm failed',
    }),
  }));

  assert.deepEqual(await service.updateSystem(), {
    success: false,
    error: 'Update command failed',
    output: 'installing',
    errorOutput: 'npm failed',
  });
});

test('process startup errors retain their message for the existing API contract', async () => {
  const service = createSystemUpdateService(createDependencies({
    runShellCommand: async () => {
      throw new Error('spawn sh failed');
    },
  }));

  assert.deepEqual(await service.updateSystem(), {
    success: false,
    error: 'spawn sh failed',
  });
});

test('readBuildInfo reads the record scripts/write-build-info.mjs writes under dist-server', () => {
  withTempAppRoot((appRoot) => {
    const record = { gitSha: 'a'.repeat(40), builtAt: '2026-10-11T00:00:00.000Z' };
    mkdirSync(path.join(appRoot, 'dist-server'), { recursive: true });
    writeFileSync(path.join(appRoot, 'dist-server', 'build-info.json'), JSON.stringify(record));

    assert.deepEqual(readBuildInfo(appRoot), record);
  });
});

test('readBuildInfo reports nulls when no build record exists (a tsx dev instance never writes one)', () => {
  withTempAppRoot((appRoot) => {
    assert.deepEqual(readBuildInfo(appRoot), { gitSha: null, builtAt: null });
  });
});

test('readBuildInfo reports nulls for a malformed build record instead of throwing', () => {
  withTempAppRoot((appRoot) => {
    mkdirSync(path.join(appRoot, 'dist-server'), { recursive: true });
    writeFileSync(path.join(appRoot, 'dist-server', 'build-info.json'), '{ not json');

    assert.deepEqual(readBuildInfo(appRoot), { gitSha: null, builtAt: null });
  });
});
