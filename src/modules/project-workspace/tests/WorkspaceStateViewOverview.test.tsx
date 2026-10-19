import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import enChat from '@/modules/i18n/locales/en/chat.json';
import enCommon from '@/modules/i18n/locales/en/common.json';
import WebSocketContext from '@/shared/context/WebSocketContext';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import type { ActivityConnection, Project, ServerEvent } from '@/shared/types';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';

/**
 * The landing overview's three panels, in both layouts.
 *
 * The running reading is driven through the real `SessionProtectionProvider`
 * (the same in-memory socket P1's sidebar criterion uses), so the panel draws
 * whatever the app's own activity fold actually produced rather than a fixture
 * the component cannot see. The ended reading is driven through frames carrying
 * the delivery projection the server already sends. The task/goal reading is the
 * `fleet-summary` contract, answered here by the API double.
 *
 * Both arms render the SAME component and the same panels; what differs is the
 * container. The compact arm therefore reads the pulse bar and the three pages,
 * while the desktop arm reads three side-by-side sections — and both are proven
 * to carry the data attributes the Playwright matrix asserts on.
 */

const START = Date.parse('2026-01-01T00:00:00.000Z');

const PROJECT_ALPHA: Project = {
  projectId: 'project-alpha',
  displayName: 'Alpha',
  fullPath: '/tmp/alpha',
  sessions: [
    { id: 'session-alpha', summary: 'Alpha work', lastActivity: '2026-01-01T00:00:00.000Z' },
  ],
} as unknown as Project;

const PROJECT_BETA: Project = {
  projectId: 'project-beta',
  displayName: 'Beta',
  fullPath: '/tmp/beta',
  sessions: [
    { id: 'session-beta', summary: 'Beta work', lastActivity: '2026-01-01T00:00:00.000Z' },
  ],
} as unknown as Project;

/**
 * The two REST readings the provider and the fleet hook make, in a hoisted bag
 * because `vi.mock`'s factory is evaluated before module constants exist.
 */
const apiState = vi.hoisted(() => ({
  runningSessions: [] as Array<{ sessionId: string; startedAt: number }>,
  fleetProjects: [] as unknown[],
  fleetOk: true,
}));

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => Promise.resolve({
      ok: true,
      json: async () => ({ data: { sessions: apiState.runningSessions } }),
    }),
    quayFleetSummary: () => Promise.resolve({
      ok: apiState.fleetOk,
      json: async () => ({ projects: apiState.fleetProjects }),
    }),
  },
  readApiJson: (response: { json: () => Promise<unknown> }) => response.json(),
}));

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  defaultNS: 'common',
  resources: { en: { common: enCommon, chat: enChat } },
  interpolation: { escapeValue: false },
});

/** An in-memory socket: every frame the page hears is pushed through it. */
const makeConnection = () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connection = {
    ws: null,
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isConnected: true,
    sendMessage: () => {},
  } satisfies ActivityConnection & { ws: null; sendMessage: () => void };
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, push };
};

const renderView = async (isMobile: boolean) => {
  const harness = makeConnection();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <WebSocketContext.Provider value={harness.connection}>
        <SessionProtectionProvider>
          <WorkspaceStateView
            mode="empty"
            isMobile={isMobile}
            onMenuClick={() => {}}
            projects={[PROJECT_ALPHA, PROJECT_BETA]}
          />
        </SessionProtectionProvider>
      </WebSocketContext.Provider>
    </I18nextProvider>,
  );
  return { ...view, ...harness };
};

/** One activity frame carrying a turn phase, exactly the shape the server sends. */
const phaseFrame = (sessionId: string, phase: string, toolName: string | null): ServerEvent => ({
  kind: 'activity.snapshot',
  sessionId,
  bootId: 'boot-1',
  rev: 1,
  asOf: START,
  turn: { phase, toolName, startedAt: START },
  tasks: [],
  schedules: [],
  deliveries: [],
});

/** One activity frame carrying a terminal delivery, as the snapshot re-sends it. */
const terminalFrame = (
  sessionId: string,
  deliveryId: string,
  state: 'completed' | 'cancelled',
  reason: string | null,
  endedAt: number,
): ServerEvent => ({
  kind: 'activity.upsert',
  sessionId,
  bootId: 'boot-1',
  rev: 2,
  asOf: endedAt,
  turn: { phase: 'idle', toolName: null, startedAt: null },
  tasks: [],
  schedules: [],
  deliveries: [{
    deliveryId,
    state,
    reason,
    source: 'user',
    priority: null,
    enqueuedAt: START,
    startedAt: START,
    endedAt,
    turnId: 'turn-1',
    text: null,
  }],
});

beforeEach(() => {
  apiState.runningSessions = [];
  apiState.fleetOk = true;
  apiState.fleetProjects = [{
    projectId: 'project-alpha',
    projectPath: '/tmp/alpha',
    driver: { state: 'idle', alive: true },
    tasks: { total: 9, todo: 2, ready: 3, needsHuman: 1, done: 3 },
    goals: { total: 5, active: 2, achieved: 2 },
  }];
});

test('desktop: three side-by-side panels aggregate running sessions across projects', async () => {
  apiState.runningSessions = [
    { sessionId: 'session-alpha', startedAt: START },
    { sessionId: 'session-beta', startedAt: START + 1_000 },
  ];
  const { container, push } = await renderView(false);

  await waitFor(() => {
    assert.ok(container.querySelector('[data-landing-running-entry="session-alpha"]'));
    assert.ok(container.querySelector('[data-landing-running-entry="session-beta"]'));
  });

  assert.equal(container.querySelector('[data-landing-overview="desktop"]') !== null, true);
  assert.equal(container.querySelectorAll('[data-landing-panel]').length, 3);
  assert.equal(container.querySelector('[data-landing-pulse]'), null, 'the desktop arm has no pulse bar');

  push(phaseFrame('session-alpha', 'tool', 'Bash'));
  push(phaseFrame('session-beta', 'thinking', null));

  await waitFor(() => {
    const alpha = container.querySelector<HTMLElement>('[data-landing-running-entry="session-alpha"]');
    assert.ok(alpha);
    assert.equal(alpha.getAttribute('data-activity-phase'), 'tool');
    assert.equal(alpha.getAttribute('data-activity-tool'), 'Bash');
    assert.ok(Number.isFinite(Number(alpha.getAttribute('data-activity-elapsed'))));
  });

  // Cross-project aggregation: each entry sits under its own project heading,
  // so the panel is a fleet reading rather than a session list with no owner.
  const alphaGroup = container.querySelector('[data-landing-running-project="project-alpha"]');
  const betaGroup = container.querySelector('[data-landing-running-project="project-beta"]');
  assert.ok(alphaGroup, 'Alpha group');
  assert.ok(betaGroup, 'Beta group');
  assert.match(alphaGroup.textContent ?? '', /Alpha/);
  assert.match(betaGroup.textContent ?? '', /Beta/);
  assert.match(alphaGroup.textContent ?? '', /Alpha work/);
  assert.match(betaGroup.textContent ?? '', /Beta work/);
});

test('desktop: recently ended entries carry distinguishable terminal states', async () => {
  const { container, push } = await renderView(false);

  push(terminalFrame('session-alpha', 'delivery-1', 'completed', null, START + 2_000));
  push(terminalFrame('session-beta', 'delivery-2', 'cancelled', 'owed-terminal-missing', START + 3_000));

  await waitFor(() => {
    assert.ok(container.querySelector('[data-landing-ended-entry="session-alpha"]'));
    assert.ok(container.querySelector('[data-landing-ended-entry="session-beta"]'));
  });

  const ended = container.querySelector<HTMLElement>('[data-landing-panel="ended"]');
  assert.ok(ended);
  assert.equal(ended.getAttribute('data-landing-panel-count'), '2');

  const alpha = container.querySelector<HTMLElement>('[data-landing-ended-entry="session-alpha"]');
  const beta = container.querySelector<HTMLElement>('[data-landing-ended-entry="session-beta"]');
  assert.ok(alpha);
  assert.ok(beta);
  assert.equal(alpha.getAttribute('data-terminal-state'), 'success');
  assert.equal(beta.getAttribute('data-terminal-state'), 'timeout');
  assert.notEqual(alpha.getAttribute('data-terminal-state'), beta.getAttribute('data-terminal-state'));
  assert.match(alpha.textContent ?? '', /Success/);
  assert.match(beta.textContent ?? '', /Timed out/);
});

test('desktop: the task/goal panel draws the fleet-summary counts per project', async () => {
  const { container } = await renderView(false);

  await waitFor(() => {
    assert.ok(container.querySelector('[data-fleet-project="project-alpha"]'));
  });

  const row = container.querySelector<HTMLElement>('[data-fleet-project="project-alpha"]');
  assert.ok(row);
  assert.equal(row.getAttribute('data-task-total'), '9');
  assert.equal(row.getAttribute('data-task-ready'), '3');
  assert.equal(row.getAttribute('data-task-needs-human'), '1');
  assert.equal(row.getAttribute('data-task-done'), '3');
  assert.equal(row.getAttribute('data-goal-active'), '2');
  assert.equal(row.getAttribute('data-goal-achieved'), '2');
  assert.match(row.textContent ?? '', /Alpha/);
});

test('desktop: an unavailable fleet summary states so without inventing counts', async () => {
  apiState.fleetOk = false;
  const { container } = await renderView(false);

  await waitFor(() => {
    const panel = container.querySelector('[data-landing-panel="tasks"]');
    assert.ok(panel);
    assert.match(panel.textContent ?? '', /unavailable/i);
  });
  assert.equal(container.querySelector('[data-fleet-project]'), null);
});

test('compact: the pulse bar and three swipeable pages carry the same panels', async () => {
  apiState.runningSessions = [{ sessionId: 'session-alpha', startedAt: START }];
  const { container, push } = await renderView(true);

  assert.equal(container.querySelector('[data-landing-overview="mobile"]') !== null, true);
  assert.ok(container.querySelector('[data-landing-pulse]'), 'the compact arm draws the pulse bar');
  assert.equal(container.querySelectorAll('[data-landing-page]').length, 3);
  assert.deepEqual(
    [...container.querySelectorAll('[data-landing-page]')].map((page) => page.getAttribute('data-landing-page')),
    ['running', 'ended', 'tasks'],
  );

  const pages = container.querySelector<HTMLElement>('[data-landing-pages]');
  assert.ok(pages);
  assert.equal(pages.getAttribute('data-active-page'), 'running');

  // A tab press changes which page the reading names, and the pages stay the
  // same three sections — the layout switch does not fork the content.
  fireEvent.click(container.querySelector('[data-landing-tab="ended"]') as HTMLElement);
  await waitFor(() => assert.equal(pages.getAttribute('data-active-page'), 'ended'));
  assert.equal(
    container.querySelector('[data-landing-tab="ended"]')?.getAttribute('aria-selected'),
    'true',
  );

  fireEvent.click(container.querySelector('[data-landing-tab="tasks"]') as HTMLElement);
  await waitFor(() => assert.equal(pages.getAttribute('data-active-page'), 'tasks'));

  push(terminalFrame('session-beta', 'delivery-9', 'cancelled', 'interrupt', START + 5_000));
  await waitFor(() => {
    const row = container.querySelector<HTMLElement>('[data-landing-ended-entry="session-beta"]');
    assert.ok(row);
    assert.equal(row.getAttribute('data-terminal-state'), 'interrupted');
  });
});

test('the loading arm keeps the spinner and draws no panels', async () => {
  const harness = makeConnection();
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <WebSocketContext.Provider value={harness.connection}>
        <SessionProtectionProvider>
          <WorkspaceStateView mode="loading" isMobile={false} onMenuClick={() => {}} projects={[]} />
        </SessionProtectionProvider>
      </WebSocketContext.Provider>
    </I18nextProvider>,
  );

  await waitFor(() => assert.match(container.textContent ?? '', /Loading CloudCLI/));
  assert.equal(container.querySelector('[data-landing-overview]'), null);
  assert.equal(container.querySelectorAll('[data-landing-panel]').length, 0);
});
