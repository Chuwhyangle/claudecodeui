/**
 * The Live Voice marker: written when a voice connection opens, removed on every way it ends, swept at start-up.
 * (task `gap-live-voice-dispatch-hook-production-wiring`, AC4 + AC6).
 *
 * WHY THE MARKER EXISTS AT ALL. The dispatch hook (`UserPromptSubmit`, registered by the resident launch)
 * injects its rules ONLY for a session that is in Live Voice at that moment, and it runs in the CLI's own
 * process — so it is told by a file at `~/.cloudcli/voice-active/<session id>`. That makes the file's
 * presence the whole gate, and it makes every path that ends a connection a path that has to remove it:
 *
 *   (a) a connection is established        ⇒ the marker is there, so the session's next prompt is told;
 *   (b) a normal teardown removes it       ⇒ the session stops being told;
 *   (c) an abnormal close removes it too   ⇒ a crash-shaped exit cannot leave the session armed forever.
 *
 * (c) is the load-bearing leg. A teardown is not the only exit — `createTransport()` can throw before a
 * single socket handler exists, and the socket `close` handler has its own early return while an uplink
 * VAD exit is mid-flight — so the removal is attached to the exits, not only to the teardown.
 *
 * A fresh `$HOME` IS THE SANDBOX. Both the marker helper and the shipped hook compute the path from
 * `os.homedir()`, read at call time, so each case moves `$HOME` to a directory it owns and puts it back.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig=server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-voice-active-marker.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeToolExecutor } from '../index.js';
import {
  clearStaleVoiceActiveMarkers,
  handleVoiceRealtimeConnection,
  voiceActiveMarkerDirectory,
  voiceActiveMarkerPath,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/** The session the connection is bound to, and therefore the marker's file name. */
const SESSION = 'voice-active-marker-session';

/** The minimal `ws.WebSocket` surface the proxy uses, driven over an EventEmitter. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** The whitelisted executor the proxy is handed; nothing in this criterion sends through it. */
function inertExecutor(): RealtimeToolExecutor {
  return { session_send: async () => ({ ok: true }) };
}

type Wired = { socket: FakeBrowserSocket; transport: FakeTransport };

/**
 * Runs one connection against seams this criterion owns.
 *
 * `createTransport` is injected rather than built: the case that matters for (c) is the one where it
 * THROWS, which is how a connection dies before any socket handler exists.
 */
function wire(options: { createTransport?: () => never } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const seams: VoiceRealtimeProxySeams = {
    createTransport: options.createTransport ?? (() => transport),
    createExecutor: () => inertExecutor(),
    instructions: 'test instructions',
    log: () => undefined,
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    SESSION,
    seams,
  );
  return { socket, transport };
}

/** Brings the connection all the way up: the handshake, the upstream open, and the state frame. */
async function open(wired: Wired): Promise<void> {
  wired.socket.receive({ type: 'hello', protocol: 'segmented-v1' });
  await waitFor(() => wired.transport.openCalls >= 1);
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** Ends it the normal way — the browser's own close frame — and waits for the teardown to reach the upstream. */
async function closeNormally(wired: Wired): Promise<void> {
  wired.socket.receive({ type: 'close' });
  await waitFor(() => wired.transport.closeCalls >= 1);
  wired.socket.close();
}

/**
 * Runs `body` with `$HOME` pointed at a directory this case owns, then restores it and removes the tree.
 *
 * `os.homedir()` is read per call, so nothing has to be reloaded — and nothing outside the temp tree can
 * be touched by a marker written or swept in here.
 */
async function withOwnHome(body: () => Promise<void> | void): Promise<void> {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), 'voice-active-marker-'));
  process.env.HOME = home;
  try {
    await body();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('(a) a Live Voice connection creates this session\'s marker', async () => {
  await withOwnHome(async () => {
    const wired = wire();

    // The marker is written as the connection is handled — before the upstream is even open — so a
    // session cannot submit a prompt into the gap between "voice connected" and "upstream open".
    assert.ok(
      existsSync(voiceActiveMarkerPath(SESSION)),
      'the marker exists the moment the voice connection is handled',
    );
    assert.ok(
      readdirSync(voiceActiveMarkerDirectory()).includes(SESSION),
      'the marker is filed under the bound session id',
    );

    await open(wired);
    assert.ok(existsSync(voiceActiveMarkerPath(SESSION)), 'and it is still there once the upstream is open');

    await closeNormally(wired);
  });
});

test('(b) a normal teardown removes the marker', async () => {
  await withOwnHome(async () => {
    const wired = wire();
    await open(wired);
    assert.ok(existsSync(voiceActiveMarkerPath(SESSION)), 'precondition: the connection armed the session');

    wired.socket.receive({ type: 'close' });
    await waitFor(() => wired.transport.closeCalls >= 1);

    assert.ok(
      !existsSync(voiceActiveMarkerPath(SESSION)),
      'the browser\'s close frame tears the connection down and the session stops being armed',
    );
    wired.socket.close();
  });
});

test('(c) an abnormal close that never reaches a teardown removes the marker', async () => {
  await withOwnHome(async () => {
    // A transport that cannot be constructed: `createTransport()` throws before the bridge exists and
    // before ANY socket handler is registered, so the connection dies without a teardown — the shape a
    // missing upstream credential has. (The other such exit is the socket `close` handler's
    // uplink-VAD-exit early return; the removal sits on the handler itself, so it is covered by the
    // same call rather than by a second path.)
    const wired = wire({
      createTransport: () => {
        throw new Error('no upstream credential');
      },
    });

    // The connection is over, and it never reached a teardown: the upstream was never opened and the
    // bridge was never closed through `teardown()`.
    assert.equal(wired.transport.openCalls, 0, 'the upstream was never opened');
    assert.equal(wired.transport.closeCalls, 0, 'no teardown ran — this is the abnormal exit');
    assert.equal(wired.socket.readyState, WS.CLOSED, 'the handler closed the dead socket');

    assert.ok(
      !existsSync(voiceActiveMarkerPath(SESSION)),
      'an abnormal close leaves no marker behind for the dispatch hook to keep reading',
    );
  });
});

test('AC6: start-up sweeps a stale marker left by a relay that never tore down', async () => {
  await withOwnHome(async () => {
    // A marker that survives a crash: written as if a connection had armed the session, with no
    // connection left in this process to remove it.
    mkdirSync(voiceActiveMarkerDirectory(), { recursive: true });
    writeFileSync(voiceActiveMarkerPath('session-from-a-dead-relay'), '');
    writeFileSync(voiceActiveMarkerPath(SESSION), '');
    assert.equal(readdirSync(voiceActiveMarkerDirectory()).length, 2, 'precondition: two stale markers');

    const swept = clearStaleVoiceActiveMarkers();

    assert.equal(swept, 2, 'the sweep reports what it removed');
    const remaining = existsSync(voiceActiveMarkerDirectory()) ? readdirSync(voiceActiveMarkerDirectory()) : [];
    assert.deepEqual([...remaining], [], 'the marker directory is empty after the start-up sweep');
  });
});
