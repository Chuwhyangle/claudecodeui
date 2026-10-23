import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { afterEach } from 'node:test';

import { createCockpitModule } from '@/modules/cockpit/index.js';
import type { CockpitFocusable, CockpitHub, CockpitSendTarget } from '@/modules/cockpit/index.js';
import { handleChatConnection } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * The cockpit hub's criterion: two devices of ONE user share one state through the REAL chat
 * websocket gateway, the input pack is built from the display's report rather than the input
 * device's, a confirmed send happens exactly once, and another user's connection sees none of
 * it.
 *
 * The gateway is driven the way production drives it — `handleChatConnection` with fake
 * sockets — and the hub is the one the composition root would build, with its two seams
 * injected. Nothing here reaches into the hub's internals.
 */

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRecord[];
  send(data: string): void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as AnyRecord);
  };
  return socket;
}

const openSockets: FakeSocket[] = [];

/** One authenticated browser, connected to the real gateway with the cockpit hub mounted. */
function connect(userId: number, hub: CockpitHub): {
  socket: FakeSocket;
  sendFrame: (frame: AnyRecord) => Promise<void>;
} {
  const socket = createFakeSocket();
  openSockets.push(socket);

  handleChatConnection(socket as never, { user: { id: userId } } as never, {
    runtime: {
      hasRuntime: () => true,
      run: async () => undefined,
      abort: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    },
    cockpitHub: hub,
  } as never);

  const handleMessage = socket.listeners('message')[0] as unknown as (
    rawMessage: unknown,
  ) => Promise<void>;

  return {
    socket,
    sendFrame: (frame) => handleMessage(JSON.stringify(frame)),
  };
}

/** Every `cockpit.state` frame one socket received, oldest first. */
function stateFrames(socket: FakeSocket): AnyRecord[] {
  return socket.frames.filter((frame) => frame.kind === 'cockpit.state');
}

/** The newest `cockpit.state` payload. */
function lastState(socket: FakeSocket): AnyRecord {
  const frames = stateFrames(socket);
  assert.ok(frames.length > 0, 'the socket received no cockpit state');
  return frames[frames.length - 1].state as AnyRecord;
}

function focusable(uri: string, row: number): CockpitFocusable {
  return {
    uri,
    label: row === 1 ? '①' : '②',
    display: { status: 'ready', color: 'green', ordinal: row, pos: { row, column: 1 } },
  };
}

const DISPLAY_SET: CockpitFocusable[] = [
  focusable('quay://claudecodeui/board', 1),
  focusable('quay://quay-fleet/board', 2),
];
const INPUT_SET: CockpitFocusable[] = [
  focusable('quay://phone-only/board', 1),
];

const TARGET: CockpitSendTarget = {
  sessionId: 'session-1',
  projectId: 'p1',
  projectName: 'claudecodeui',
  sessionTitle: null,
  source: 'pinned',
  fleetUnavailableReason: null,
};

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    socket.emit('close');
  }
});

test('two devices of one user share state; the input pack comes from the display; confirm sends once', async () => {
  const sends: Array<{ userId: string; message: { sessionId: string; content: string } }> = [];
  const hub = createCockpitModule({
    resolveTarget: async () => ({ target: TARGET, reason: null }),
    send: (userId, message) => {
      sends.push({ userId, message });
    },
  });

  const display = connect(1, hub);
  const input = connect(1, hub);
  const otherUser = connect(2, hub);

  await display.sendFrame({ type: 'cockpit.hello', role: 'display', deviceId: 'device-display', deviceName: 'desktop' });
  await input.sendFrame({ type: 'cockpit.hello', role: 'input', deviceId: 'device-input', deviceName: 'phone' });
  await otherUser.sendFrame({ type: 'cockpit.hello', role: 'display', deviceId: 'device-other', deviceName: 'other' });

  // The display reports what it is showing. This is the ONLY set the hub may build a pack from.
  await display.sendFrame({
    type: 'cockpit.event',
    event: { type: 'visible', viewUri: 'quay://claudecodeui/board', focusables: DISPLAY_SET },
  });
  const afterVisible = stateFrames(display.socket).length;

  // The input device reports a DIFFERENT set. It is an input-only connection: the hub drops it.
  await input.sendFrame({
    type: 'cockpit.event',
    event: { type: 'visible', viewUri: 'quay://phone-only/board', focusables: INPUT_SET },
  });
  assert.equal(stateFrames(display.socket).length, afterVisible, 'an input-only connection must not report visibility');

  const revBeforeMove = lastState(display.socket).rev as number;
  const otherBefore = stateFrames(otherUser.socket).length;

  // AC: input sends `move`, the display receives the state with rev + 1.
  await input.sendFrame({ type: 'cockpit.event', event: { type: 'move', direction: 'down' } });
  const moved = lastState(display.socket);
  assert.equal(moved.rev, revBeforeMove + 1, 'the move must broadcast exactly one new revision');
  assert.equal(moved.focusUri, 'quay://quay-fleet/board', 'the move snapped over the display’s grid');
  assert.deepEqual(
    stateFrames(display.socket).at(-1)?.state,
    stateFrames(input.socket).at(-1)?.state,
    'both devices of the user must hold the same state',
  );

  // AC: an unmatched utterance carries the DISPLAY's visible set, never the input's.
  await input.sendFrame({ type: 'cockpit.event', event: { type: 'utterance', text: '把第二个记下来' } });
  const pending = lastState(display.socket).pendingSend as AnyRecord;
  assert.deepEqual(
    pending.visible,
    DISPLAY_SET,
    'the pending pack must be built from the display’s visible set',
  );
  assert.equal((pending.target as AnyRecord).sessionId, TARGET.sessionId);

  // AC: confirm sends exactly once; a duplicate confirm sends nothing more.
  await input.sendFrame({ type: 'cockpit.event', event: { type: 'confirm' } });
  assert.equal(sends.length, 1, 'one confirm must send exactly once');
  assert.equal(sends[0]?.userId, '1');
  assert.equal(sends[0]?.message.sessionId, TARGET.sessionId);
  assert.ok(sends[0]?.message.content.startsWith('把第二个记下来'), sends[0]?.message.content);

  await input.sendFrame({ type: 'cockpit.event', event: { type: 'confirm' } });
  assert.equal(sends.length, 1, 'a duplicate confirm must not send again');
  assert.equal(lastState(display.socket).pendingSend, null, 'the confirmation is closed after sending');

  // AC: another user's connection receives none of this user's state changes.
  assert.equal(
    stateFrames(otherUser.socket).length,
    otherBefore,
    'another user must receive no cockpit state from this user’s events',
  );
});

test('a display may not act and an input may not report; unknown users are refused', async () => {
  const hub = createCockpitModule();
  const display = connect(1, hub);
  const unauthenticated = connect(1, hub);

  await display.sendFrame({ type: 'cockpit.hello', role: 'display', deviceId: 'device-display' });
  const before = stateFrames(display.socket).length;
  await display.sendFrame({ type: 'cockpit.event', event: { type: 'move', direction: 'down' } });
  assert.equal(stateFrames(display.socket).length, before, 'a display-only connection must not act');

  // A connection that never announced itself cannot drive the hub.
  await unauthenticated.sendFrame({ type: 'cockpit.event', event: { type: 'move', direction: 'up' } });
  assert.equal(hub.getState(1)?.rev, 0, 'an unannounced connection must not move the state');
});
