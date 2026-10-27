import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isDesktopAlertEnabled,
  sendAwaitingReplyDesktopAlert,
} from '../services/desktop-alert.service.js';

/** Runs `body` with the notify command set to `command`, restoring whatever was there before. */
async function withNotifyCommand(command: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD;
  process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD = command;

  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD;
    } else {
      process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD = previous;
    }
  }
}

/** Polls until `path` exists, so the test waits on the child instead of a fixed sleep. */
async function waitForFile(filePath: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`timed out waiting for ${filePath}`);
}

test('a blank command reads as a disabled channel and spawns nothing', async () => {
  await withNotifyCommand('   ', async () => {
    assert.equal(isDesktopAlertEnabled(), false);
    // Would throw ENOENT if the service tried to spawn ''.
    sendAwaitingReplyDesktopAlert({ sessionId: 's1', title: 't', body: 'b' });
  });

  delete process.env.CLOUDCLI_DESKTOP_NOTIFY_CMD;
  assert.equal(isDesktopAlertEnabled(), false);
});

test('the alert reaches the command as one JSON object on stdin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'desktop-alert-'));
  const outPath = path.join(directory, 'alert.json');

  try {
    await withNotifyCommand(`cat > ${outPath}`, async () => {
      assert.equal(isDesktopAlertEnabled(), true);
      sendAwaitingReplyDesktopAlert({
        sessionId: 'session-42',
        title: 'CloudCLI · 会话标题',
        body: '等待你的回话',
      });

      const received = await waitForFile(outPath);
      assert.deepEqual(JSON.parse(received), {
        sessionId: 'session-42',
        title: 'CloudCLI · 会话标题',
        body: '等待你的回话',
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a command that fails is reported but never thrown at the caller', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    await withNotifyCommand('exit 7', async () => {
      assert.doesNotThrow(() => {
        sendAwaitingReplyDesktopAlert({ sessionId: 'session-42', title: 't', body: 'b' });
      });

      const deadline = Date.now() + 3000;
      while (!warnings.some((line) => line.includes('exit code 7')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      assert.ok(
        warnings.some((line) => line.includes('session-42') && line.includes('exit code 7')),
        `expected a warning naming the session and exit code, got: ${JSON.stringify(warnings)}`,
      );
    });
  } finally {
    console.warn = originalWarn;
  }
});
