/**
 * The `ui_visible_context` criterion (gap-mcp-ui-visible-context).
 *
 * The tool answers "what is the user looking at, in which window, right now" by
 * broadcasting one `ui.state_request` and collecting the `ui.state_response`
 * answers — so every leg below drives the REAL round trip
 * (`createUiStateRequestService`) over fake browser connections and reads the REAL
 * tool (`buildUiVisibleContext`). Nothing between the broadcast and the payload is
 * stubbed: the frames a fake browser records are the frames the service wrote, and
 * the answers it sends back are routed through the service's own `handleResponse`,
 * which is the same entry the chat gateway's dispatch calls.
 *
 * Legs:
 *   (1) one broadcast carrying one `requestId` reaches every addressed tab, the
 *       answers are collected concurrently, and the devices come back ordered by
 *       newest focus; naming a `client` asks only that device;
 *   (2) a silent tab is reported `unresponsive` without holding up the others and
 *       without failing the call; nobody connected is `devices: []` and answers at
 *       once; a late or mis-addressed answer is dropped; an ambiguous or empty
 *       `client` is refused with the candidates / the query;
 *   (3) the projection is a whitelist: a frame that carries a message body, a user
 *       selection and panel content can push none of them into the payload, while
 *       the identifiers and the navigation policy still come through.
 *   (4) gap-ui-visible-context-extended-fields: the extended readings come through
 *       with LIVE values — the active Git sub-view with the two expanded paths, and
 *       the focused TaskMaster task's id and title — and a diff body the transport
 *       tried to ship inside `currentDiff` is dropped, so the payload carries ids
 *       and paths only;
 *   (5) the companion `ui_selected_text` tool: a token WITHOUT `cloudcli:selection`
 *       reads exactly `'withheld'` for a tab that HAS a selection while a tab with
 *       none still reads `null` (the three-state distinction), and a token WITH the
 *       scope reads the reading's live text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnyRecord, RealtimeClientConnection, UiClientDevice, UiVisibleContextReport } from '@/shared/types.js';
import { createUiStateRequestService } from '@/modules/websocket/index.js';

import { MCP_ERROR_CODES, McpToolError } from '../mcp-error-envelope.js';
import {
  buildUiSelectedText,
  buildUiVisibleContext,
  SELECTION_SCOPE,
  type McpUiVisibleContextDeps,
} from '../mcp-ui-visible-context.js';

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
  /** When this tab's identity reached the server, ordering a device's name. */
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
  deps: McpUiVisibleContextDeps;
  /** Hands one answer in as if the browser had sent it; returns whether the service accepted it. */
  answerWith: (tab: FakeTab, frame: AnyRecord) => boolean;
  /** The answer frame a tab would send for the request it just received. */
  answerFrame: (tab: FakeTab, overrides?: AnyRecord) => AnyRecord;
};

/** Builds one fake tab with a live connection object, not yet wired to a service. */
function makeTab(overrides: Partial<FakeTab> & { identity: FakeTab['identity'] }): FakeTab {
  const frames: AnyRecord[] = [];
  const tab: FakeTab = {
    connectedAt: 1,
    frames,
    lastRequestId: null,
    extra: {},
    responsive: true,
    connection: { readyState: WS_OPEN, send: () => undefined },
    ...overrides,
  };
  return tab;
}

/**
 * Builds a rig over the real round-trip service.
 *
 * The `send` seam records the frame on the tab and, for a responsive tab, answers
 * it on a microtask — the same asynchronous shape a real browser has, so "collect
 * concurrently" is exercised rather than "collect synchronously". The answer is
 * routed back through the service's `handleResponse`, so the whitelist and the
 * request-id matching the criterion reads are the production ones.
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
        return [...byDevice.values()];
      },
      requestUiState: (options) => service.requestUiState(options),
    },
    answerWith: (tab, frame) => service.handleResponse(tab.connection, frame),
    answerFrame: (tab, overrides = {}) => ({
      type: 'ui.state_response',
      requestId: tab.lastRequestId,
      ...tab.identity,
      ...makeTabReport(tab),
      ...overrides,
    }),
  };
}

/** The report a tab answers with; a per-tab closure so one leg can vary one field. */
const reportForTab = new WeakMap<FakeTab, UiVisibleContextReport>();
const makeTabReport = (tab: FakeTab): UiVisibleContextReport =>
  reportForTab.get(tab) ?? baseReport();

/** Sets the report one fake tab answers with. */
function withReport(tab: FakeTab, report: UiVisibleContextReport): FakeTab {
  reportForTab.set(tab, report);
  return tab;
}

// --------------------------- leg (1): the broadcast and the collection ---------------------------

test('(1) one ui.state_request reaches every addressed tab and all answers are collected, ordered by focus', async () => {
  // Two tabs of one device and one tab of another; focus times make the device
  // order (beta newest) and the within-device tab order unambiguous.
  const alphaOne = withReport(makeTab({ identity: { deviceId: 'dev-alpha', tabId: 'alpha-1', deviceName: 'Alpha' }, connectedAt: 10 }), baseReport({ lastFocusedAt: 100, selectedSession: 'alpha-1-open' }));
  const alphaTwo = withReport(makeTab({ identity: { deviceId: 'dev-alpha', tabId: 'alpha-2', deviceName: 'Alpha' }, connectedAt: 20 }), baseReport({ lastFocusedAt: 300, selectedSession: 'alpha-2-open' }));
  const betaOne = withReport(makeTab({ identity: { deviceId: 'dev-beta', tabId: 'beta-1', deviceName: 'Beta' }, connectedAt: 30 }), baseReport({ lastFocusedAt: 900, selectedSession: 'beta-open' }));
  const rig = createRig([alphaOne, alphaTwo, betaOne]);

  const payload = await buildUiVisibleContext(rig.deps, {});

  // One broadcast per tab, all carrying the SAME non-empty requestId.
  const requestIds = rig.tabs.map((tab) => {
    assert.equal(tab.frames.length, 1, `${tab.identity.tabId} must be asked exactly once`);
    assert.equal(tab.frames[0].type, 'ui.state_request', 'the frame must be the request the browser answers');
    assert.equal(typeof tab.frames[0].requestId, 'string');
    assert.notEqual(tab.frames[0].requestId, '', 'the requestId must be non-empty');
    return tab.frames[0].requestId as string;
  });
  assert.equal(new Set(requestIds).size, 1, 'all tabs of one call must be asked under one requestId');

  // Every answer was collected (the call resolved on the microtask answers, well
  // before the 1.5s window), grouped by device, newest focus first.
  assert.deepEqual(
    payload.devices.map((device) => device.deviceId),
    ['dev-beta', 'dev-alpha'],
    'devices must be ordered most recently focused first',
  );
  const alpha = payload.devices[1];
  assert.ok(alpha, 'the alpha device must be present');
  assert.deepEqual(
    alpha.tabs.map((tab) => tab.tabId),
    ['alpha-2', 'alpha-1'],
    'a device’s tabs must be ordered most recently focused first',
  );
  assert.deepEqual(
    alpha.tabs.map((tab) => tab.unresponsive),
    [false, false],
    'both alpha tabs answered',
  );
  // The per-tab report came through: the answered session is the one each tab reported.
  const byTab = new Map(payload.devices.flatMap((device) => device.tabs.map((tab) => [tab.tabId, tab])));
  assert.equal(byTab.get('alpha-1')?.selectedSession, 'alpha-1-open');
  assert.equal(byTab.get('alpha-2')?.selectedSession, 'alpha-2-open');
  assert.equal(byTab.get('beta-1')?.selectedSession, 'beta-open');
});

test('(1) naming a client asks only that device — the others are never written to', async () => {
  const alpha = withReport(makeTab({ identity: { deviceId: 'dev-alpha', tabId: 'alpha-1', deviceName: 'Studio Mac' }, connectedAt: 10 }), baseReport({ lastFocusedAt: 100 }));
  const beta = withReport(makeTab({ identity: { deviceId: 'dev-beta', tabId: 'beta-1', deviceName: 'Office PC' }, connectedAt: 20 }), baseReport({ lastFocusedAt: 200 }));
  const rig = createRig([alpha, beta]);

  const payload = await buildUiVisibleContext(rig.deps, { client: 'Office PC' });

  assert.deepEqual(payload.devices.map((device) => device.deviceId), ['dev-beta']);
  assert.equal(alpha.frames.length, 0, 'a device the caller did not name must receive nothing');
  assert.equal(beta.frames.length, 1, 'the named device must be asked once');
});

// --------------------------- leg (2): silence, emptiness, lateness, refusal ---------------------------

test('(2) a silent tab is unresponsive while the others answer, and the call returns at the window', async () => {
  const awake = withReport(makeTab({ identity: { deviceId: 'dev-awake', tabId: 'awake-1', deviceName: 'Awake' }, connectedAt: 10 }), baseReport({ lastFocusedAt: 500 }));
  const asleep = withReport(makeTab({ identity: { deviceId: 'dev-asleep', tabId: 'asleep-1', deviceName: 'Asleep' }, connectedAt: 20, responsive: false }), baseReport());
  const rig = createRig([awake, asleep]);

  const startedAt = Date.now();
  const payload = await buildUiVisibleContext(rig.deps, {});
  const elapsed = Date.now() - startedAt;

  // The 1.5s window is the point: the call cannot resolve on the awake answer
  // alone, because the silent tab might still answer inside the window.
  assert.ok(elapsed >= 1_300, `the call must wait out the default window, saw ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `the call must not wait far past the window, saw ${elapsed}ms`);

  const byTab = new Map(payload.devices.flatMap((device) => device.tabs.map((tab) => [tab.tabId, tab])));
  const silentTab = byTab.get('asleep-1');
  assert.ok(silentTab, 'the silent tab must still be reported');
  assert.equal(silentTab.unresponsive, true, 'a tab that did not answer must be flagged unresponsive');
  assert.equal(silentTab.selectedSession, null, 'an unresponsive tab carries no report fields');
  assert.equal(silentTab.visibility, null);
  assert.equal(silentTab.lastFocusedAt, null);

  const answeredTab = byTab.get('awake-1');
  assert.equal(answeredTab?.unresponsive, false, 'the answering tab must be unaffected by the silent one');
  assert.equal(answeredTab?.lastFocusedAt, 500);
});

test('(2) nobody connected is devices: [] and returns at once, not after the window', async () => {
  const rig = createRig([]);

  const startedAt = Date.now();
  const payload = await buildUiVisibleContext(rig.deps, {});
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(payload.devices, [], 'no browsers is an empty reading, not an error');
  assert.ok(elapsed < 250, `an empty reading must not wait for a window nobody can answer, saw ${elapsed}ms`);
});

test('(2) late and mis-addressed answers are dropped', async () => {
  const responsive = withReport(makeTab({ identity: { deviceId: 'dev-a', tabId: 'a-1', deviceName: 'A' }, connectedAt: 10 }), baseReport({ lastFocusedAt: 100 }));
  const silent = withReport(makeTab({ identity: { deviceId: 'dev-b', tabId: 'b-1', deviceName: 'B' }, connectedAt: 20, responsive: false }), baseReport());
  const rig = createRig([responsive, silent]);

  const payload = await buildUiVisibleContext(rig.deps, {});
  const usedRequestId = responsive.lastRequestId;
  assert.ok(typeof usedRequestId === 'string' && usedRequestId.length > 0, 'the call must have minted a requestId');

  // A mis-addressed id while nothing is pending, and the real id after the call
  // has already settled: both are dropped, so neither can widen a result a caller
  // already holds.
  assert.equal(rig.answerWith(silent, { type: 'ui.state_response', requestId: 'not-a-live-id', ...silent.identity, ...baseReport() }), false, 'an unknown requestId must be dropped');
  assert.equal(rig.answerWith(silent, { ...rig.answerFrame(silent, { requestId: usedRequestId }) }), false, 'an answer after the call settled must be dropped');
  // And a frame that is not a response at all is refused outright.
  assert.equal(rig.answerWith(silent, { type: 'ui.state_request', requestId: usedRequestId }), false);

  // The mute tab is still unresponsive in the payload it already produced — the
  // late answer must not have been folded in.
  const silentTab = payload.devices.flatMap((device) => device.tabs).find((tab) => tab.tabId === 'b-1');
  assert.equal(silentTab?.unresponsive, true);
});

test('(2) an ambiguous client is refused with the candidates, an empty one with the query', async () => {
  const one = withReport(makeTab({ identity: { deviceId: 'dev-1', tabId: 't-1', deviceName: 'Meeting Room' }, connectedAt: 10 }), baseReport());
  const two = withReport(makeTab({ identity: { deviceId: 'dev-2', tabId: 't-2', deviceName: 'Meeting Room Two' }, connectedAt: 20 }), baseReport());
  const rig = createRig([one, two]);

  await assert.rejects(
    () => buildUiVisibleContext(rig.deps, { client: 'meeting room' }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError, 'an ambiguous client must be a tool error');
      assert.equal(error.code, MCP_ERROR_CODES.TARGET_AMBIGUOUS.code, 'several hits reuse the one ambiguity code');
      const details = (error.details ?? {}) as unknown as AnyRecord;
      const candidates = (details.candidates ?? []) as AnyRecord[];
      assert.equal(candidates.length, 2, 'the refusal must list every candidate');
      assert.deepEqual(
        candidates.map((candidate) => candidate.id).sort(),
        ['dev-1', 'dev-2'],
        'the candidates must name the devices that matched',
      );
      return true;
    },
  );
  assert.equal(one.frames.length, 0, 'an ambiguous reference must not fall back to asking everyone');
  assert.equal(two.frames.length, 0);

  await assert.rejects(
    () => buildUiVisibleContext(rig.deps, { client: 'does-not-exist' }),
    (error: unknown) => {
      assert.ok(error instanceof McpToolError, 'an unmatched client must be a tool error');
      // No second not-found literal: the wrapper's own INVALID_ARGUMENT carries the query.
      assert.equal(error.code, MCP_ERROR_CODES.INVALID_ARGUMENT.code);
      assert.match(error.message, /does-not-exist/, 'the refusal must carry the query that matched nothing');
      const details = (error.details ?? {}) as unknown as AnyRecord;
      assert.deepEqual(details.candidates, [], 'there are no candidates to list');
      return true;
    },
  );
});

// --------------------------- leg (3): the whitelist ---------------------------

test('(3) a response carrying a message body, a selection and panel content leaks none of them', async () => {
  const tab = withReport(
    makeTab({ identity: { deviceId: 'dev-leak', tabId: 'leak-1', deviceName: 'Leaky Browser' }, connectedAt: 10 }),
    baseReport({
      navigationPolicy: 'accept',
      visibility: 'hidden',
      hasFocus: false,
      selectedSession: 'session-open',
      visibleMessages: { first: 'm-10', last: 'm-12' },
    }),
  );
  tab.extra = {
    messageBody: 'the secret the user typed into the composer',
    selectedText: 'a passage the user highlighted',
    panelContent: '<div>whatever the panel renders</div>',
    transcript: [{ text: 'a whole message' }],
  };
  const rig = createRig([tab]);

  const payload = await buildUiVisibleContext(rig.deps, {});
  const device = payload.devices[0];
  assert.ok(device, 'the device must be reported');
  const reported = device.tabs[0];
  assert.ok(reported, 'the tab must be reported');

  // Nothing outside the report shape survives, at any level of the returned tree.
  for (const forbidden of ['messageBody', 'selectedText', 'panelContent', 'transcript']) {
    assert.equal(forbidden in reported, false, `the tab must not carry "${forbidden}"`);
    assert.equal(forbidden in device, false, `the device must not carry "${forbidden}"`);
  }
  const serialized = JSON.stringify(payload);
  for (const secret of ['the secret the user typed', 'a passage the user highlighted', 'whatever the panel renders', 'a whole message']) {
    assert.equal(serialized.includes(secret), false, `the payload must not contain ${JSON.stringify(secret)}`);
  }

  // The identifiers and the policy — everything the caller legitimately asked for — do come through.
  assert.equal(device.deviceId, 'dev-leak');
  assert.equal(device.deviceName, 'Leaky Browser');
  assert.equal(reported.deviceName, 'Leaky Browser');
  assert.equal(reported.navigationPolicy, 'accept');
  assert.equal(reported.visibility, 'hidden');
  assert.equal(reported.hasFocus, false);
  assert.deepEqual(reported.visibleMessages, { first: 'm-10', last: 'm-12' });
});

// --------------------------- leg (4): the extended readings ---------------------------

test('(4) the payload carries the live currentDiff and currentTask readings and no diff body', async () => {
  const tab = withReport(
    makeTab({ identity: { deviceId: 'dev-work', tabId: 'work-1', deviceName: 'Workbench' }, connectedAt: 10 }),
    baseReport({ panel: 'git' }),
  );
  // The frame's OWN currentDiff, as a browser that had a diff body to hand would
  // send it: the two expanded paths in `files`, plus a hunk the contract forbids.
  // `extra` wins over the base report, so this is the shape the projection reads.
  tab.extra = {
    currentDiff: {
      view: 'changes',
      files: ['src/a.ts', 'src/b.ts'],
      commits: [],
      body: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old line\n+new line',
    },
    currentTask: { source: 'taskmaster', id: '42', title: 'Ship the reading' },
  };
  const rig = createRig([tab]);

  const payload = await buildUiVisibleContext(rig.deps, {});
  const device = payload.devices[0];
  assert.ok(device, 'the device must be reported');
  const reported = device.tabs[0];
  assert.ok(reported, 'the tab must be reported');

  // LIVE values, not merely type-correct: the exact view, the two expanded paths
  // in order, and the exact focused task identity.
  assert.deepEqual(reported.currentDiff, { view: 'changes', files: ['src/a.ts', 'src/b.ts'], commits: [] });
  assert.deepEqual(reported.currentTask, { source: 'taskmaster', id: '42', title: 'Ship the reading' });

  // IDs and PATHS only: the hunk the frame carried is not in the reading, and no
  // part of it reaches any level of the returned tree.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['body', '@@', 'diff --git', '-old line']) {
    assert.equal(serialized.includes(forbidden), false, `the payload must carry no diff body (found ${JSON.stringify(forbidden)})`);
  }
});

test('(4) with no expanded file the reading is an empty lists object, distinct from null; a non-git panel is null', async () => {
  const onGitNoExpansion = withReport(
    makeTab({ identity: { deviceId: 'dev-git', tabId: 'git-1', deviceName: 'Git' }, connectedAt: 10 }),
    baseReport({ panel: 'git', currentDiff: { view: 'history', files: [], commits: [] } }),
  );
  const onChat = withReport(
    makeTab({ identity: { deviceId: 'dev-chat', tabId: 'chat-1', deviceName: 'Chat' }, connectedAt: 20 }),
    baseReport({ panel: 'chat', currentDiff: null }),
  );
  const rig = createRig([onGitNoExpansion, onChat]);

  const payload = await buildUiVisibleContext(rig.deps, {});
  const byTab = new Map(payload.devices.flatMap((device) => device.tabs.map((tab) => [tab.tabId, tab])));

  // The Git panel with nothing expanded is a real reading with empty lists — NOT
  // null, which would say "the Git panel is not the active panel".
  assert.deepEqual(byTab.get('git-1')?.currentDiff, { view: 'history', files: [], commits: [] });
  // The chat panel reports no diff at all.
  assert.equal(byTab.get('chat-1')?.currentDiff, null);
});

// --------------------------- leg (5): the scoped selection companion ---------------------------

test('(5) ui_selected_text withholds the text without cloudcli:selection and delivers it with the scope', async () => {
  const selected = withReport(
    makeTab({ identity: { deviceId: 'dev-read', tabId: 'read-1', deviceName: 'Reader' }, connectedAt: 10 }),
    baseReport({
      lastFocusedAt: 2_000,
      selectedText: { text: 'the passage the user highlighted', truncated: false, region: 'transcript' },
    }),
  );
  // A second tab of the SAME device with no selection, so `withheld` and `null` are
  // read side by side — the whole point of the third sentinel.
  const quiet = withReport(
    makeTab({ identity: { deviceId: 'dev-read', tabId: 'read-2', deviceName: 'Reader' }, connectedAt: 20 }),
    baseReport({ lastFocusedAt: 1_000 }),
  );
  const rig = createRig([selected, quiet]);

  const withoutScope = await buildUiSelectedText(rig.deps, {}, ['cloudcli:read']);
  const byTabWithout = new Map(withoutScope.devices.flatMap((device) => device.tabs.map((tab) => [tab.tabId, tab])));
  assert.equal(
    byTabWithout.get('read-1')?.selectedText,
    'withheld',
    'a token without cloudcli:selection must read the withheld marker, not the text',
  );
  assert.equal(byTabWithout.get('read-2')?.selectedText, null, 'a tab with no selection reads null even without the scope');

  const withScope = await buildUiSelectedText(rig.deps, {}, ['cloudcli:read', SELECTION_SCOPE]);
  const byTabWith = new Map(withScope.devices.flatMap((device) => device.tabs.map((tab) => [tab.tabId, tab])));
  assert.deepEqual(
    byTabWith.get('read-1')?.selectedText,
    { text: 'the passage the user highlighted', truncated: false, region: 'transcript' },
    'a token with the scope must read the live selection text',
  );

  // The companion carries the selection and nothing from `ui_visible_context`'s
  // extended readings — the two tools stay disjoint.
  assert.equal('currentDiff' in (byTabWith.get('read-1') ?? {}), false, 'ui_selected_text must not carry currentDiff');
  assert.equal('currentTask' in (byTabWith.get('read-1') ?? {}), false, 'ui_selected_text must not carry currentTask');
});
