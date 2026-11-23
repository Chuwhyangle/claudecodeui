import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDesktopAlertChannel,
  isDesktopAlertEnabled,
} from '@/modules/notifications/services/desktop-alert.service.js';

/**
 * A stand-in child process: records what was written to stdin and lets a test
 * settle it, without depending on a real shell or on timing.
 */
function fakeSpawnRecorder(): {
  spawnImpl: typeof spawn;
  calls: Array<{ command: string; stdin: string; settle: (code: number | null) => void }>;
} {
  const calls: Array<{ command: string; stdin: string; settle: (code: number | null) => void }> = [];

  const spawnImpl = ((command: string) => {
    const listeners: Record<string, Array<(arg: unknown) => void>> = {};
    const emit = (event: string, arg: unknown): void => {
      for (const listener of listeners[event] ?? []) {
        listener(arg);
      }
    };
    const record = {
      command,
      stdin: '',
      settle: (code: number | null) => emit('close', code),
    };
    calls.push(record);

    const child = {
      stderr: {
        on: (event: string, listener: (chunk: Buffer) => void) => {
          if (event === 'data') {
            (listeners.data ??= []).push(listener as (arg: unknown) => void);
          }
          return child.stderr;
        },
      },
      on: (event: string, listener: (arg: unknown) => void) => {
        (listeners[event] ??= []).push(listener);
        return child;
      },
      stdin: {
        on: () => child.stdin,
        end: (chunk: string) => {
          record.stdin = chunk;
        },
      },
    };
    return child;
  }) as unknown as typeof spawn;

  return { spawnImpl, calls };
}

test('an unset, blank or empty command reads as a disabled channel and spawns nothing', () => {
  const recorder = fakeSpawnRecorder();

  const unset = createDesktopAlertChannel({ env: {}, spawnImpl: recorder.spawnImpl });
  assert.equal(unset.isEnabled(), false);
  assert.equal(unset.send({ title: 't', body: 'b' }), false);

  const blank = createDesktopAlertChannel({
    env: { CLOUDPIT_DESKTOP_NOTIFY_CMD: '   ' },
    spawnImpl: recorder.spawnImpl,
  });
  assert.equal(blank.isEnabled(), false);
  assert.equal(blank.send({ title: 't', body: 'b' }), false);

  assert.equal(recorder.calls.length, 0, 'a disabled channel must never spawn');
});

test('the canonical command wins and the legacy spelling still works', () => {
  const canonical = createDesktopAlertChannel({
    env: { CLOUDPIT_DESKTOP_NOTIFY_CMD: 'new-cmd', CLOUDCLI_DESKTOP_NOTIFY_CMD: 'old-cmd' },
  });
  assert.equal(canonical.isEnabled(), true);

  const legacyOnly = createDesktopAlertChannel({ env: { CLOUDCLI_DESKTOP_NOTIFY_CMD: 'old-cmd' } });
  assert.equal(legacyOnly.isEnabled(), true, 'an existing deployment keeps alerting after the rename');

  // The process-wide channel is off inside a `node --test` child even when the
  // command is exported: a test run must not raise toasts on the workstation that
  // exported it. Asserted only where the runner really set its marker, so this
  // file stays runnable by hand.
  if (process.env.NODE_TEST_CONTEXT) {
    const previous = process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD;
    process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD = 'some-notify-command';
    try {
      assert.equal(isDesktopAlertEnabled(), false);
    } finally {
      if (previous === undefined) delete process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD;
      else process.env.CLOUDPIT_DESKTOP_NOTIFY_CMD = previous;
    }
  }
});

test('one alert is written to the command as a single JSON object on stdin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-alert-'));
  const outPath = path.join(directory, 'alert.json');

  try {
    const channel = createDesktopAlertChannel({ env: { CLOUDPIT_DESKTOP_NOTIFY_CMD: `cat > ${outPath}` } });
    assert.equal(
      channel.send({ sessionId: 'session-42', title: 'Cloudpit · 会话标题', body: '等待你的回话' }),
      true,
    );

    const deadline = Date.now() + 3000;
    let received = '';
    while (Date.now() < deadline) {
      try {
        received = await readFile(outPath, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    assert.deepEqual(JSON.parse(received), {
      sessionId: 'session-42',
      title: 'Cloudpit · 会话标题',
      body: '等待你的回话',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('alerts closer together than the throttle window are coalesced, and the window reopens on the clock', () => {
  const recorder = fakeSpawnRecorder();
  let clock = 1_000;
  const channel = createDesktopAlertChannel({
    env: { CLOUDPIT_DESKTOP_NOTIFY_CMD: 'notify' },
    spawnImpl: recorder.spawnImpl,
    now: () => clock,
  });

  assert.equal(channel.send({ sessionId: 'a', title: 't', body: 'b' }), true);
  clock += 2_999;
  assert.equal(
    channel.send({ sessionId: 'b', title: 't', body: 'b' }),
    false,
    'inside the window the second alert must not spawn (no double chime)',
  );
  assert.equal(recorder.calls.length, 1);

  clock += 1;
  assert.equal(channel.send({ sessionId: 'c', title: 't', body: 'b' }), true);
  assert.equal(recorder.calls.length, 2);
  // The payload always carries `sessionId` in a stable shape, empty when absent.
  assert.equal(JSON.parse(recorder.calls[1].stdin).sessionId, 'c');
});

test('a failing command is reported with its exit code and never thrown at the caller', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    const recorder = fakeSpawnRecorder();
    const channel = createDesktopAlertChannel({
      env: { CLOUDPIT_DESKTOP_NOTIFY_CMD: 'notify' },
      spawnImpl: recorder.spawnImpl,
    });

    assert.doesNotThrow(() => {
      channel.send({ sessionId: 'session-42', title: 't', body: 'b' });
    });
    recorder.calls[0].settle(7);

    assert.ok(
      warnings.some((line) => line.includes('session-42') && line.includes('exit code 7')),
      `expected a warning naming the session and exit code, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});
