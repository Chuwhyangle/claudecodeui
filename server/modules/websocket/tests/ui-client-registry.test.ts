import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { afterEach } from 'node:test';

import { handleChatConnection, listUiClients } from '@/modules/websocket/index.js';
import { UI_CLIENT_ID_MAX_LENGTH, UI_CLIENT_NAME_MAX_LENGTH } from '@/modules/websocket/services/ui/ui-client-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * The UI client registry's criterion: which devices the server believes are
 * connected, how a device's tabs are grouped, and what a client is allowed to
 * put in the registry.
 *
 * Every reading is taken through the same door production uses — the real
 * `ui.hello` frame driven through the real `handleChatConnection`, read back
 * through the module barrel's `listUiClients()`. Nothing here reaches into the
 * registry's internals.
 *
 * The process-wide registry is the one under test (that is the instance the MCP
 * tools read), so every case closes the sockets it opened; node:test gives this
 * file a process of its own, which is what keeps "gone after close" from being
 * polluted by a sibling file's devices.
 */

const DEVICE_A = 'device-a-0000';
const DEVICE_B = 'device-b-0000';

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

/** Connects one fake browser and hands back the two things a case drives. */
function connect(): {
  socket: FakeSocket;
  sendFrame: (frame: AnyRecord) => Promise<void>;
  close: () => void;
} {
  const socket = createFakeSocket();
  openSockets.push(socket);

  // A bare `{ runtime }`, exactly like the many existing gateway harnesses: no
  // control seam, no UI-client seam, so this drives production's own instances.
  handleChatConnection(socket as never, { user: { id: 1 } } as never, {
    runtime: {
      hasRuntime: () => true,
      run: async () => undefined,
      abort: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    },
  } as never);

  const handleMessage = socket.listeners('message')[0] as unknown as (
    rawMessage: unknown,
  ) => Promise<void>;

  return {
    socket,
    sendFrame: (frame) => handleMessage(JSON.stringify(frame)),
    close: () => socket.emit('close'),
  };
}

/** The device rows `listUiClients()` currently reports, summarised for assertions. */
function deviceSummaries(): Array<{ deviceId: string; deviceName: string; tabIds: string[] }> {
  return listUiClients().map((device) => ({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    tabIds: device.tabs.map((tab) => tab.tabId),
  }));
}

afterEach(() => {
  // Closing is also the deregistration under test, so a leaked socket would show
  // up as a device in the next case's first reading.
  for (const socket of openSockets) {
    socket.emit('close');
  }
  openSockets.length = 0;
  connectedClients.clear();
});

// ------------------------------------------------------- register and forget --

test('a ui.hello puts the device in the listing, and the connection closing takes it out', async () => {
  const { sendFrame, close } = connect();

  assert.deepEqual(deviceSummaries(), [], 'nothing is registered before an announcement');

  await sendFrame({
    type: 'ui.hello',
    deviceId: DEVICE_A,
    tabId: 'tab-1',
    deviceName: 'Chrome · Linux',
  });

  const listed = listUiClients();
  assert.equal(listed.length, 1, 'the announcing device must be listed');
  assert.equal(listed[0].deviceId, DEVICE_A);
  assert.equal(listed[0].deviceName, 'Chrome · Linux');
  assert.deepEqual(listed[0].tabs.map((tab) => tab.tabId), ['tab-1']);
  assert.equal(typeof listed[0].tabs[0].connectedAt, 'number', 'a tab carries when it was announced');

  close();
  assert.deepEqual(deviceSummaries(), [], 'identity does not outlive the connection that announced it');
});

test('two connections of one device are one device with two tabs, and tabs leave one at a time', async () => {
  // The device's name is read from its most recently connected tab, so the two
  // announcements have to be ordered in time rather than left to the clock's
  // resolution.
  const realNow = Date.now;
  let clock = 1_000;
  Date.now = () => clock++;

  try {
    const firstTab = connect();
    await firstTab.sendFrame({
      type: 'ui.hello',
      deviceId: DEVICE_A,
      tabId: 'tab-1',
      deviceName: 'Chrome · Linux',
    });

    const secondTab = connect();
    await secondTab.sendFrame({
      type: 'ui.hello',
      deviceId: DEVICE_A,
      tabId: 'tab-2',
      deviceName: 'Renamed by the new tab',
    });
  } finally {
    Date.now = realNow;
  }

  // A second device, to prove the grouping is by deviceId and not "everything".
  const otherDevice = connect();
  await otherDevice.sendFrame({
    type: 'ui.hello',
    deviceId: DEVICE_B,
    tabId: 'tab-9',
    deviceName: 'Firefox · macOS',
  });

  assert.deepEqual(deviceSummaries(), [
    { deviceId: DEVICE_A, deviceName: 'Renamed by the new tab', tabIds: ['tab-1', 'tab-2'] },
    { deviceId: DEVICE_B, deviceName: 'Firefox · macOS', tabIds: ['tab-9'] },
  ]);

  // The newest tab names the device (it is the one a rename would have come
  // from); the older tab's own name is still its own.
  const deviceA = listUiClients()[0];
  assert.deepEqual(
    deviceA.tabs.map((tab) => tab.deviceName),
    ['Chrome · Linux', 'Renamed by the new tab'],
  );

  // Closing one tab leaves the device, with one tab fewer; closing the rest
  // removes it.
  openSockets[0].emit('close');
  assert.deepEqual(deviceSummaries(), [
    { deviceId: DEVICE_A, deviceName: 'Renamed by the new tab', tabIds: ['tab-2'] },
    { deviceId: DEVICE_B, deviceName: 'Firefox · macOS', tabIds: ['tab-9'] },
  ]);
});

test('a repeated ui.hello on one connection is still one tab, not a second', async () => {
  const { sendFrame } = connect();

  await sendFrame({ type: 'ui.hello', deviceId: DEVICE_A, tabId: 'tab-1', deviceName: 'Before' });
  await sendFrame({ type: 'ui.hello', deviceId: DEVICE_A, tabId: 'tab-1', deviceName: 'After' });

  const listed = listUiClients();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tabs.length, 1, 'a re-announcement on the same connection is the same tab');
  assert.equal(listed[0].deviceName, 'After', 'the newest announcement is the one that names it');
});

// ------------------------------------------------------------ what is refused --

test('an unusable ui.hello is dropped, and the connection stays usable', async () => {
  const { socket, sendFrame } = connect();

  const unusable: Array<[string, AnyRecord]> = [
    ['deviceId missing', { type: 'ui.hello', tabId: 'tab-1', deviceName: 'Chrome · Linux' }],
    ['tabId missing', { type: 'ui.hello', deviceId: DEVICE_A, deviceName: 'Chrome · Linux' }],
    ['deviceId not a string', { type: 'ui.hello', deviceId: 42, tabId: 'tab-1', deviceName: 'x' }],
    ['deviceId empty', { type: 'ui.hello', deviceId: '   ', tabId: 'tab-1', deviceName: 'x' }],
    [
      'deviceId past its bound',
      {
        type: 'ui.hello',
        deviceId: 'd'.repeat(UI_CLIENT_ID_MAX_LENGTH + 1),
        tabId: 'tab-1',
        deviceName: 'x',
      },
    ],
    [
      'tabId past its bound',
      {
        type: 'ui.hello',
        deviceId: DEVICE_A,
        tabId: 't'.repeat(UI_CLIENT_ID_MAX_LENGTH + 1),
        deviceName: 'x',
      },
    ],
  ];

  for (const [label, frame] of unusable) {
    await sendFrame(frame);
    assert.deepEqual(deviceSummaries(), [], `${label}: must not register a device`);
    assert.equal(socket.readyState, 1, `${label}: must not close the connection`);
    assert.deepEqual(socket.frames, [], `${label}: must not answer a dropped announcement`);
  }

  // The same connection still identifies itself once a usable frame arrives —
  // which is what "the frame is dropped, the connection is not" means.
  await sendFrame({
    type: 'ui.hello',
    deviceId: DEVICE_A,
    tabId: 'tab-1',
    deviceName: 'Chrome · Linux',
  });
  assert.deepEqual(deviceSummaries(), [
    { deviceId: DEVICE_A, deviceName: 'Chrome · Linux', tabIds: ['tab-1'] },
  ]);
});

test('an over-long device name is truncated rather than dropping the announcement', async () => {
  const { sendFrame } = connect();

  await sendFrame({
    type: 'ui.hello',
    deviceId: DEVICE_A,
    tabId: 'tab-1',
    deviceName: 'n'.repeat(UI_CLIENT_NAME_MAX_LENGTH + 40),
  });

  const listed = listUiClients();
  assert.equal(listed.length, 1, 'a name is a display detail, not a reason to refuse the device');
  assert.equal(listed[0].deviceName.length, UI_CLIENT_NAME_MAX_LENGTH);
});
