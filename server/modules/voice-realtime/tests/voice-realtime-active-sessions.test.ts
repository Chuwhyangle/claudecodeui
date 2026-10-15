/**
 * The Live Voice connection registry: set when a connection opens, cleared on every way it ends
 * (task `gap-live-voice-dispatch-hook-in-process-callback-with-relay-state` AC4).
 *
 * WHY THE REGISTRY EXISTS AT ALL. The dispatch hook (`UserPromptSubmit`, registered by the resident
 * launch) injects its rules ONLY for a session that is in Live Voice at that moment. It used to ask a
 * FILE at `~/.cloudcli/voice-active/<session id>` because it ran in the CLI's own process; it is now an
 * in-process callback, so the relay and the hook share one address space and the fact is a `Set` here.
 * That makes every path that ends a connection a path that has to clear the session:
 *
 *   (a) a connection is established        ⇒ the session is active, so its next prompt is told;
 *   (b) a normal teardown clears it        ⇒ the session stops being told;
 *   (c) an abnormal close clears it too    ⇒ a crash-shaped exit cannot leave the session armed forever.
 *
 * (c) is the load-bearing leg. A teardown is not the only exit — `createTransport()` can throw before a
 * single socket handler exists, and the socket `close` handler has its own early return while an uplink
 * VAD exit is mid-flight — so the clear is attached to the exits, not only to the teardown.
 *
 * NO SANDBOX IS NEEDED, WHICH IS THE POINT. The file gate needed a `$HOME` a case owned so a marker
 * written by one case could not be read by another. The registry is per-process and the cases below
 * clear the session they use, so there is no path to a neighbouring test's state and no directory to
 * clean up.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig=server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-active-sessions.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeToolExecutor } from '../index.js';
import { clearVoiceSessionActive, isVoiceSessionActive, markVoiceSessionActive } from '../voice-realtime-active.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/** The session the connection is bound to, and therefore the registry key. */
const SESSION = 'active-sessions-session';

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

test('(a) a Live Voice connection marks this session active', async () => {
  clearVoiceSessionActive(SESSION);

  const wired = wire();

  // The session is marked as the connection is handled — before the upstream is even open — so a
  // prompt submitted into the gap between "voice connected" and "upstream open" is still told.
  assert.equal(isVoiceSessionActive(SESSION), true, 'the session is active the moment the connection is handled');

  await open(wired);
  assert.equal(isVoiceSessionActive(SESSION), true, 'and it is still active once the upstream is open');

  wired.socket.receive({ type: 'close' });
  await waitFor(() => wired.transport.closeCalls >= 1);
  wired.socket.close();
});

test('(b) a normal teardown clears the session', async () => {
  clearVoiceSessionActive(SESSION);

  const wired = wire();
  await open(wired);
  assert.equal(isVoiceSessionActive(SESSION), true, 'precondition: the connection armed the session');

  wired.socket.receive({ type: 'close' });
  await waitFor(() => wired.transport.closeCalls >= 1);

  assert.equal(
    isVoiceSessionActive(SESSION),
    false,
    'the browser\'s close frame tears the connection down and the session stops being armed',
  );
  wired.socket.close();
});

test('(c) an abnormal close that never reaches a teardown clears the session', async () => {
  clearVoiceSessionActive(SESSION);

  // A transport that cannot be constructed: `createTransport()` throws before the bridge exists and
  // before ANY socket handler is registered, so the connection dies without a teardown — the shape a
  // missing upstream credential has. (The other such exit is the socket `close` handler's
  // uplink-VAD-exit early return; the clear sits on the handler itself, so it is covered by the same
  // call rather than by a second path.)
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

  assert.equal(
    isVoiceSessionActive(SESSION),
    false,
    'an abnormal close leaves the session unmarked, so the dispatch hook stops injecting',
  );
});

test('the registry is per session, and the empty id is never active', () => {
  markVoiceSessionActive('session-one');
  clearVoiceSessionActive('session-two');
  try {
    assert.equal(isVoiceSessionActive('session-one'), true, 'the marked session reads active');
    assert.equal(isVoiceSessionActive('session-two'), false, 'a neighbouring session does not');
    assert.equal(isVoiceSessionActive(''), false, 'an unbound session is never active');
  } finally {
    clearVoiceSessionActive('session-one');
  }

  // Clearing is idempotent and safe for a session that was never marked — the relay's exits race by
  // construction, so two of them routinely clear the same session.
  clearVoiceSessionActive('session-one');
  assert.equal(isVoiceSessionActive('session-one'), false, 'a second clear is a no-op, not a throw');
});
