/**
 * The `ui_clients_list` criterion (gap-mcp-ui-clients-list).
 *
 * The tool answers "which browsers are online right now, and how is each one
 * set up" by reading the device roster and broadcasting one `ui.state_request`
 * to collect each device's status — so every leg below drives the REAL round
 * trip (`createUiStateRequestService`) over fake browser connections and reads
 * the REAL tool (`buildUiClientsList`). Nothing between the broadcast and the
 * listing is stubbed: the frames a fake browser records are the frames the
 * service wrote, and the answers it sends back are routed through the service's
 * own `handleResponse`, the same entry the chat gateway's dispatch calls.
 *
 * Legs:
 *   (1) the listing carries each device's identity, its tabs (id + connectedAt),
 *       and its visibility / focus / navigation policy, ordered by newest focus;
 *       a device whose tabs all stayed silent is `unresponsive` with null status
 *       and the call returns at the ~1.5s window; nobody connected is
 *       `devices: []`;
 *   (2) two devices sharing a default name get DIFFERENT short suffixes, and the
 *       suffix a given `deviceId` gets is the SAME across two calls, so a name
 *       read in one listing still addresses the device in the next;
 *   (3) the projection is identity + status only: a response carrying a message
 *       body, a user selection, a session id or panel content pushes none of
 *       them into the listing, at any level.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnyRecord, RealtimeClientConnection, UiClientDevice, UiVisibleContextReport } from '@/shared/types.js';
import { createUiStateRequestService } from '@/modules/websocket/index.js';

import { buildUiClientsList, type McpUiClientsListDeps } from '../mcp-ui-clients-list.js';

/** `WebSocket.OPEN`, the readyState the round trip writes to. */
const WS_OPEN = 1;

/** A complete, valid report; each browser overrides only the fields its leg cares about. */
const baseReport = (overrides: Partial<UiVisibleContextReport> = {}): UiVisibleContextReport => ({
  navigationPolicy: 'ask',
  visibility: 'visible',
  hasFocus: true,
  lastFocusedAt: 1_000,
  panel: 'chat',
  selectedProject: 'project-one',
  selectedSession: 'session-one',
  visibleMessages: { first: 'm-1', last: 'm-3' },
  pendingApprovals: 0,
  queuedMessages: 0,
  currentDiff: null,
  currentTask: null,
  selectedText: null,
  ...overrides,
});

/** One fake browser tab: the connection the server writes to, and what it answers with. */
type FakeTab = {
  /** The identity the registry announced for this tab. */
  identity: { deviceId: string; tabId: string; deviceName: string };
  /** When this tab's identity reached the server, ordering a device's tabs. */
  connectedAt: number;
  /** The live connection; `readyState` is mutable so a closed socket can be modelled. */
  connection: RealtimeClientConnection;
  /** Every frame the server wrote to this tab, in order. */
  frames: AnyRecord[];
  /** The last `ui.state_request`'s id, or null when none arrived. */
  lastRequestId: string | null;
  /** Extra keys merged into this tab's answer — the leak probe of leg (3). */
  extra: AnyRecord;
  /** False makes this tab silent: it records the request but never answers. */
  responsive: boolean;
};

/** The harness: the fake browsers plus the two seams the tool is built from. */
type Rig = {
  tabs: FakeTab[];
  deps: McpUiClientsListDeps;
};

/** One fake tab with a live connection object, not yet wired to a service. */
function makeTab(overrides: Partial<FakeTab> & { identity: FakeTab['identity'] }): FakeTab {
  return {
    connectedAt: 1,
    frames: [],
    lastRequestId: null,
    extra: {},
    responsive: true,
    connection: { readyState: WS_OPEN, send: () => undefined },
    ...overrides,
  };
}

/** The report a tab answers with; a per-tab slot so one leg can vary one field. */
const reportForTab = new WeakMap<FakeTab, UiVisibleContextReport>();
const makeTabReport = (tab: FakeTab): UiVisibleContextReport => reportForTab.get(tab) ?? baseReport();

/** Sets the report one fake tab answers with. */
function withReport(tab: FakeTab, report: UiVisibleContextReport): FakeTab {
  reportForTab.set(tab, report);
  return tab;
}

/**
 * Builds a rig over the real round-trip service.
 *
 * The `send` seam records the frame on the tab and, for a responsive tab, answers
 * it on a microtask — the same asynchronous shape a real browser has, so "collect
 * concurrently" is exercised rather than "collect synchronously". The answer is
 * routed back through the service's own `handleResponse`, so the whitelist and
 * the request-id matching this criterion reads are the production ones.
 */
function createRig(tabs: FakeTab[]): Rig {
  const service = createUiStateRequestService({
    listTargets: (deviceId) =>
      tabs
        .filter((tab) => deviceId === undefined || tab.identity.deviceId === deviceId)
        .map((tab) => ({ connection: tab.connection, ...tab.identity, connectedAt: tab.connectedAt })),
    send: (connection, frame) => {
      const tab = tabs.find((candidate) => candidate.connection === connection);
      if (!tab) {
        return;
      }
      const request = frame as AnyRecord;
      tab.frames.push(request);
      tab.lastRequestId = typeof request.requestId === 'string' ? request.requestId : null;
      if (!tab.responsive || request.type !== 'ui.state_request' || tab.lastRequestId === null) {
        return;
      }
      const requestId = tab.lastRequestId;
      queueMicrotask(() => {
        service.handleResponse(connection, {
          type: 'ui.state_response',
          requestId,
          ...tab.identity,
          ...makeTabReport(tab),
          ...tab.extra,
        });
      });
    },
  });

  return {
    tabs,
    deps: {
      // The roster, built from the tabs the way the real registry builds it:
      // devices keyed by id, tabs oldest connection first.
      listUiClients: (): UiClientDevice[] => {
        const byDevice = new Map<string, UiClientDevice>();
        for (const tab of tabs) {
          let device = byDevice.get(tab.identity.deviceId);
          if (!device) {
            device = { deviceId: tab.identity.deviceId, deviceName: tab.identity.deviceName, tabs: [] };
            byDevice.set(tab.identity.deviceId, device);
          }
          device.tabs.push({
            tabId: tab.identity.tabId,
            deviceName: tab.identity.deviceName,
            connectedAt: tab.connectedAt,
          });
        }
        for (const device of byDevice.values()) {
          device.tabs.sort((left, right) => left.connectedAt - right.connectedAt);
        }
        return [...byDevice.values()];
      },
      requestUiState: (options) => service.requestUiState(options),
    },
  };
}

// --------------------------- leg (1): the listing ---------------------------

test('(1) the listing carries identity, tabs, visibility and policy, newest focus first', async () => {
  // Alpha has two tabs that report different policies and focus moments; Beta one.
  const alphaOne = withReport(
    makeTab({ identity: { deviceId: 'dev-alpha', tabId: 'alpha-1', deviceName: 'Alpha' }, connectedAt: 10 }),
    baseReport({ lastFocusedAt: 100, navigationPolicy: 'ask', visibility: 'hidden', hasFocus: false }),
  );
  const alphaTwo = withReport(
    makeTab({ identity: { deviceId: 'dev-alpha', tabId: 'alpha-2', deviceName: 'Alpha' }, connectedAt: 20 }),
    baseReport({ lastFocusedAt: 300, navigationPolicy: 'auto', visibility: 'visible', hasFocus: true }),
  );
  const betaOne = withReport(
    makeTab({ identity: { deviceId: 'dev-beta', tabId: 'beta-1', deviceName: 'Beta' }, connectedAt: 30 }),
    baseReport({ lastFocusedAt: 900, navigationPolicy: 'ask', visibility: 'visible', hasFocus: true }),
  );
  const rig = createRig([alphaOne, alphaTwo, betaOne]);

  const payload = await buildUiClientsList(rig.deps);

  assert.deepEqual(
    payload.devices.map((device) => device.deviceId),
    ['dev-beta', 'dev-alpha'],
    'devices must be ordered most recently focused first',
  );

  const beta = payload.devices[0];
  assert.ok(beta, 'the beta device must be present');
  assert.equal(beta.deviceName, 'Beta');
  assert.equal(beta.lastFocusedAt, 900);
  assert.deepEqual(beta.tabs, [{ tabId: 'beta-1', connectedAt: 30 }], 'a tab is reported by id and connectedAt only');
  assert.equal(beta.visibility, 'visible');
  assert.equal(beta.hasFocus, true);
  assert.equal(beta.navigationPolicy, 'ask');
  assert.equal(beta.unresponsive, false);

  const alpha = payload.devices[1];
  assert.ok(alpha, 'the alpha device must be present');
  assert.equal(alpha.lastFocusedAt, 300, 'a device reports its newest tab focus moment');
  assert.deepEqual(
    alpha.tabs,
    [
      { tabId: 'alpha-1', connectedAt: 10 },
      { tabId: 'alpha-2', connectedAt: 20 },
    ],
    'a device lists every tab, oldest connection first',
  );
  // The representative tab is the most recently focused ANSWERING one, so Alpha's
  // status is alpha-2's, not alpha-1's.
  assert.equal(alpha.navigationPolicy, 'auto', 'the device status comes from its newest-focus tab');
  assert.equal(alpha.visibility, 'visible');
  assert.equal(alpha.hasFocus, true);
  assert.equal(alpha.unresponsive, false);
});

test('(1) no connected device is an empty listing, and it returns at once', async () => {
  const rig = createRig([]);

  const startedAt = Date.now();
  const payload = await buildUiClientsList(rig.deps);
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(payload.devices, [], 'no browsers is an empty reading, not an error');
  assert.ok(elapsed < 250, `an empty roster must not wait for a window nobody can answer, saw ${elapsed}ms`);
});

test('(1) a device whose tabs all stayed silent is unresponsive, and the listing returns at the ~1.5s window', async () => {
  const awake = withReport(
    makeTab({ identity: { deviceId: 'dev-awake', tabId: 'awake-1', deviceName: 'Awake' }, connectedAt: 10 }),
    baseReport({ lastFocusedAt: 500 }),
  );
  const asleep = withReport(
    makeTab({ identity: { deviceId: 'dev-asleep', tabId: 'asleep-1', deviceName: 'Asleep' }, connectedAt: 20, responsive: false }),
    baseReport(),
  );
  const rig = createRig([awake, asleep]);

  const startedAt = Date.now();
  const payload = await buildUiClientsList(rig.deps);
  const elapsed = Date.now() - startedAt;

  // The 1.5s window is the point: the call cannot resolve on the awake answer
  // alone, because the silent device might still answer inside the window.
  assert.ok(elapsed >= 1_300, `the call must wait out the default window, saw ${elapsed}ms`);
  assert.ok(elapsed < 2_500, `the call must not wait far past the window, saw ${elapsed}ms`);

  const byDevice = new Map(payload.devices.map((device) => [device.deviceId, device]));
  const silent = byDevice.get('dev-asleep');
  assert.ok(silent, 'a silent device must still be listed');
  assert.equal(silent.unresponsive, true, 'a device none of whose tabs answered must be flagged unresponsive');
  assert.equal(silent.visibility, null, 'an unresponsive device carries no status fields');
  assert.equal(silent.hasFocus, null);
  assert.equal(silent.navigationPolicy, null);
  assert.equal(silent.lastFocusedAt, null);
  assert.deepEqual(silent.tabs, [{ tabId: 'asleep-1', connectedAt: 20 }], 'its tabs are still reported by identity');

  const answered = byDevice.get('dev-awake');
  assert.equal(answered?.unresponsive, false, 'the answering device must be unaffected by the silent one');
  assert.equal(answered?.lastFocusedAt, 500);
});

// --------------------------- leg (2): duplicate names ---------------------------

test('(2) two devices sharing a name get different stable suffixes; a unique name is untouched', async () => {
  const chromeA = withReport(
    makeTab({ identity: { deviceId: 'aaaa1111-0000', tabId: 'a-1', deviceName: 'Chrome' }, connectedAt: 10 }),
    baseReport({ lastFocusedAt: 100 }),
  );
  const chromeB = withReport(
    makeTab({ identity: { deviceId: 'bbbb2222-0000', tabId: 'b-1', deviceName: 'Chrome' }, connectedAt: 20 }),
    baseReport({ lastFocusedAt: 200 }),
  );
  const safari = withReport(
    makeTab({ identity: { deviceId: 'cccc', tabId: 'c-1', deviceName: 'Safari' }, connectedAt: 30 }),
    baseReport({ lastFocusedAt: 300 }),
  );
  const rig = createRig([chromeA, chromeB, safari]);

  const namesOf = (payload: Awaited<ReturnType<typeof buildUiClientsList>>): Map<string, string> =>
    new Map(payload.devices.map((device) => [device.deviceId, device.deviceName]));

  const first = namesOf(await buildUiClientsList(rig.deps));
  const second = namesOf(await buildUiClientsList(rig.deps));

  // Both Chromes carry a suffix taken from their own id, and the two differ.
  assert.match(first.get('aaaa1111-0000') ?? '', /^Chrome \(aaaa\)$/, 'the first Chrome carries its id prefix');
  assert.match(first.get('bbbb2222-0000') ?? '', /^Chrome \(bbbb\)$/, 'the second Chrome carries its id prefix');
  assert.notEqual(
    first.get('aaaa1111-0000'),
    first.get('bbbb2222-0000'),
    'two devices sharing a name must be told apart by their suffixes',
  );
  // A device with a name of its own is left exactly as the browser announced it.
  assert.equal(first.get('cccc'), 'Safari', 'a unique name must not be suffixed');

  // The suffix is a function of the device's id, so a second listing reads the same names.
  assert.deepEqual([...second.entries()].sort(), [...first.entries()].sort(), 'a device must read the same name across calls');
});

// --------------------------- leg (3): identity + status only ---------------------------

test('(3) a response carrying a message body, a selection and session content leaks none of it', async () => {
  const tab = withReport(
    makeTab({ identity: { deviceId: 'dev-leak', tabId: 'leak-1', deviceName: 'Leaky Browser' }, connectedAt: 10 }),
    baseReport({
      navigationPolicy: 'accept',
      visibility: 'hidden',
      hasFocus: false,
      panel: 'panel-secret',
      selectedProject: 'project-secret',
      selectedSession: 'session-secret',
      visibleMessages: { first: 'm-10', last: 'm-12' },
      pendingApprovals: 3,
      queuedMessages: 2,
    }),
  );
  tab.extra = {
    messageBody: 'the secret the user typed into the composer',
    selectedText: 'a passage the user highlighted',
    panelContent: '<div>whatever the panel renders</div>',
    transcript: [{ text: 'a whole message' }],
  };
  const rig = createRig([tab]);

  const payload = await buildUiClientsList(rig.deps);
  const device = payload.devices[0];
  assert.ok(device, 'the device must be listed');

  // Nothing about WHAT the browser is showing survives, at any level: a device
  // row is identity (id, name, tabs) plus status, and a tab is id + connectedAt.
  const sessionContent = [
    'messageBody',
    'selectedText',
    'panelContent',
    'transcript',
    'panel',
    'selectedProject',
    'selectedSession',
    'visibleMessages',
    'pendingApprovals',
    'queuedMessages',
  ];
  for (const forbidden of sessionContent) {
    assert.equal(forbidden in device, false, `the device must not carry "${forbidden}"`);
  }
  const tabRow = device.tabs[0];
  assert.ok(tabRow, 'the tab must be listed');
  assert.deepEqual(Object.keys(tabRow).sort(), ['connectedAt', 'tabId'], 'a tab row is an id and a connection time, nothing else');

  const serialized = JSON.stringify(payload);
  for (const secret of [
    'the secret the user typed',
    'a passage the user highlighted',
    'whatever the panel renders',
    'a whole message',
    'panel-secret',
    'project-secret',
    'session-secret',
    'm-10',
  ]) {
    assert.equal(serialized.includes(secret), false, `the listing must not contain ${JSON.stringify(secret)}`);
  }

  // The identity and status — everything the caller legitimately asked for — do come through.
  assert.equal(device.deviceId, 'dev-leak');
  assert.equal(device.deviceName, 'Leaky Browser');
  assert.equal(device.navigationPolicy, 'accept');
  assert.equal(device.visibility, 'hidden');
  assert.equal(device.hasFocus, false);
  assert.equal(device.unresponsive, false);
});
