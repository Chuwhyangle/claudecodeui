import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import test from 'node:test';

import { WebSocket } from 'ws';

import { handleShellConnection } from '@/modules/websocket/services/ui/shell-websocket.service.js';

type Spawn = { command: string; env: Record<string, string | undefined> };

/** Stands in for the compilation of a configured model entry. */
const MODEL_SPEC = {
  env: { QUAY_MODEL_KEY: 'model-value', ANTHROPIC_BASE_URL: 'http://gw.local' },
  unsetEnv: [],
  argv: ['--model', 'opus 4'],
  contextWindow: 200000,
  warnings: [],
};

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (d: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.send = () => undefined;
  return socket;
}

function createFakePty() {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write() {},
    resize() {},
    kill() {},
  };
}

function launch(hasSession: boolean, platform: 'linux' | 'win32'): Spawn {
  const spawned: Spawn[] = [];
  const originalPlatform = os.platform;
  os.platform = (() => platform) as typeof os.platform;
  try {
    const socket = createFakeSocket();
    handleShellConnection(socket as never, {
      resolveProviderSessionId: (sessionId: string) => sessionId,
      resolveModelLaunchSpec: () => MODEL_SPEC,
      spawnPty: ((_shell: string, args: string | string[], options: { env: Record<string, string> }) => {
        spawned.push({ command: Array.isArray(args) ? args[args.length - 1] : args, env: options.env });
        return createFakePty() as never;
      }) as never,
    });
    socket.emit(
      'message',
      JSON.stringify({
        type: 'init',
        projectPath: process.cwd(),
        sessionId: `resume-spec-${platform}-${hasSession}-${Date.now()}`,
        hasSession,
        provider: 'claude',
      }),
    );
  } finally {
    os.platform = originalPlatform;
  }
  assert.equal(spawned.length, 1);
  return spawned[0];
}

/** Model-owned env keys only; the rest of the pty env is process-wide. */
function modelEnv(spawn: Spawn) {
  return Object.fromEntries(Object.keys(MODEL_SPEC.env).map((key) => [key, spawn.env[key]]));
}

for (const platform of ['linux', 'win32'] as const) {
  test(`resume launch reuses the first-launch model argv and env (${platform})`, () => {
    const first = launch(false, platform);
    const resumed = launch(true, platform);
    const quotedArgv = "'--model' 'opus 4'";

    assert.ok(first.command.includes(quotedArgv), first.command);
    // Resume attempt and its `|| claude` fallback both carry the argv.
    assert.equal(resumed.command.split(quotedArgv).length - 1, 2, resumed.command);
    assert.deepStrictEqual(modelEnv(resumed), modelEnv(first));
    assert.deepStrictEqual(modelEnv(first), MODEL_SPEC.env);
  });
}
