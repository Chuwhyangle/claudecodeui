import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import enChat from '@/modules/i18n/locales/en/chat.json';
import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import RunningView from '@/modules/sidebar/RunningView';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import WebSocketContext from '@/shared/context/WebSocketContext';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import type {
  ActivityConnection,
  Project,
  ServerEvent,
  SessionHostsSnapshot,
  SessionWithProvider,
} from '@/shared/types';

/**
 * The Running view's phase/tool/elapsed reading.
 *
 * A running row used to draw nothing but the session's name: the activity
 * snapshot already said what the turn was doing, but the sidebar had no path to
 * it. These cases drive the real `SessionProtectionProvider` through an
 * in-memory socket — exactly the frames production receives — and read the
 * row's own contract: `data-activity-phase`, `data-activity-tool`,
 * `data-activity-elapsed`, and the label drawn from the same reduction the chat
 * dock uses (`activityPhaseLabelKey`). The three legs are (a) a session with a
 * phase, (b) the resident-idle group with none, and (c) a `tool` phase whose
 * name the server never supplied.
 */

const START = Date.parse('2026-01-01T00:00:00.000Z');
const RUNNING_SESSION = 'running-1';
const RESIDENT_SESSION = 'resident-1';

/** The one frame that names a session's turn reading and when it was taken. */
const snapshotFrame = (
  sessionId: string,
  phase: string,
  toolName: string | null,
  asOf: number,
): ServerEvent => ({
  kind: 'activity.snapshot',
  sessionId,
  bootId: 'boot-1',
  rev: 1,
  asOf,
  turn: { phase, toolName, startedAt: null },
  tasks: [],
  schedules: [],
});

/**
 * The two REST readings the provider and the host store make, held in a
 * hoisted bag because `vi.mock`'s factory is evaluated before module-level
 * constants would exist.
 */
const apiState = vi.hoisted(() => ({
  runningSessions: [] as Array<{ sessionId: string; startedAt: number }>,
  hosts: { hosts: [], sessions: [] } as unknown,
}));

/**
 * Which sidebar layout the row renders. The hook is a media query in
 * production; here it is a switch so both layouts can be exercised without a
 * viewport (the acceptance criterion names both branches explicitly).
 */
const layoutState = vi.hoisted(() => ({ compact: false }));

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => layoutState.compact,
}));

/** A resident process held open between turns, bound to one idle session. */
const HOSTS: SessionHostsSnapshot = {
  hosts: [{
    hostId: 'host-1',
    provider: 'claude',
    mode: 'resident',
    state: 'idle',
    pid: 4242,
    startedAt: START,
    closeReason: null,
    closeDetail: null,
    bindings: [{
      appSessionId: RESIDENT_SESSION,
      providerSessionId: 'provider-1',
      state: 'idle',
      leases: [],
      lastActivityAt: START,
      peerName: null,
    }],
  }],
  sessions: [],
};

// The row's menu reads both capability sets; stubbing them keeps the row's
// render free of requests this criterion does not exercise.
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set<string>(),
  useResidentProviders: () => new Set<string>(),
}));

// The row's "copy provider session id" action fetches only when its menu opens;
// stubbing it keeps the row's render synchronous and network-free.
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({
    copyState: 'idle',
    copyLabel: 'Copy session ID',
    setOptionsOpen: () => {},
    handleCopyAction: () => {},
    isCopyPending: false,
    CopyStateIcon: () => null,
  }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => Promise.resolve({
      ok: true,
      json: async () => ({ data: { sessions: apiState.runningSessions } }),
    }),
    sessionHosts: {
      list: () => Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: apiState.hosts }),
      }),
    },
  },
  readApiJson: (response: { json: () => Promise<unknown> }) => response.json(),
}));

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  defaultNS: 'sidebar',
  resources: { en: { sidebar: enSidebar, chat: enChat } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof RunningView>['t'];

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project',
  fullPath: '/tmp/project-1',
  sessions: [
    { id: RUNNING_SESSION, summary: 'A running session', lastActivity: '2026-01-01T00:00:00.000Z' },
    { id: RESIDENT_SESSION, summary: 'A resident session', lastActivity: '2026-01-01T00:00:00.000Z' },
  ],
} as unknown as Project;

const SESSION = {
  id: RUNNING_SESSION,
  summary: 'A running session',
  lastActivity: '2026-01-01T00:00:00.000Z',
  __provider: 'claude',
} as unknown as SessionWithProvider;

/** An in-memory socket: every frame the page hears is pushed through it. */
const makeConnection = () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const sent: unknown[] = [];
  const connection = {
    ws: null,
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isConnected: true,
    sendMessage: (message: unknown) => {
      sent.push(message);
    },
  } satisfies ActivityConnection & {
    ws: null;
    sendMessage: (message: unknown) => void;
  };
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, sent, push };
};

const renderView = async () => {
  const harness = makeConnection();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <WebSocketContext.Provider value={harness.connection}>
        <SessionProtectionProvider>
          <RunningView projects={[PROJECT]} searchQuery="" t={t} />
        </SessionProtectionProvider>
      </WebSocketContext.Provider>
    </I18nextProvider>,
  );
  return { ...view, ...harness };
};

const rowFor = (container: HTMLElement, sessionId: string): HTMLElement => {
  const row = container.querySelector<HTMLElement>(`[data-running-session="${sessionId}"]`);
  assert.ok(row, `expected a row for ${sessionId}`);
  return row;
};

/**
 * One project session row, in whichever sidebar layout `layoutState.compact`
 * names. The activity entry comes from the real provider, as it does in the
 * Running view's cases, so both layouts read the same source.
 */
const renderItem = () => {
  const harness = makeConnection();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <WebSocketContext.Provider value={harness.connection}>
        <SessionProtectionProvider>
          <SidebarSessionItem
            project={PROJECT}
            session={SESSION}
            selectedSession={null}
            isProcessing
            needsAttention={false}
            currentTime={new Date(START)}
            isEditing={false}
            renameDraft=""
            onRenameDraftChange={() => {}}
            onStartEditingSession={() => {}}
            onCancelEditingSession={() => {}}
            onSaveEditingSession={() => {}}
            onProjectSelect={() => {}}
            onSessionSelect={() => {}}
            onDeleteSession={() => {}}
            t={t}
          />
        </SessionProtectionProvider>
      </WebSocketContext.Provider>
    </I18nextProvider>,
  );
  return { ...view, ...harness };
};

beforeEach(() => {
  apiState.runningSessions = [];
  apiState.hosts = HOSTS;
  layoutState.compact = false;
});

test('a running row publishes the activity snapshot phase, tool and elapsed', async () => {
  apiState.runningSessions = [{ sessionId: RUNNING_SESSION, startedAt: START }];
  const { container, sent, push } = await renderView();

  await waitFor(() => rowFor(container, RUNNING_SESSION));
  // The sidebar must ask for the feed: the snapshot that names a phase for a
  // session nobody has opened arrives only after `activity.subscribe`.
  assert.deepEqual(sent, [{ type: 'activity.subscribe', sessionId: RUNNING_SESSION }]);

  push(snapshotFrame(RUNNING_SESSION, 'thinking', null, START + 5_000));

  await waitFor(() => {
    assert.equal(rowFor(container, RUNNING_SESSION).getAttribute('data-activity-phase'), 'thinking');
  });
  const row = rowFor(container, RUNNING_SESSION);
  assert.equal(row.getAttribute('data-activity-phase'), 'thinking');
  assert.equal(row.hasAttribute('data-activity-tool'), false, 'no tool name outside the tool phase');
  const elapsed = Number(row.getAttribute('data-activity-elapsed'));
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0, 'the row publishes the turn age in ms');
  assert.match(row.textContent ?? '', /Thinking/);

  push(snapshotFrame(RUNNING_SESSION, 'tool', 'Bash', START + 6_000));

  await waitFor(() => {
    assert.equal(rowFor(container, RUNNING_SESSION).getAttribute('data-activity-tool'), 'Bash');
  });
  const toolRow = rowFor(container, RUNNING_SESSION);
  assert.equal(toolRow.getAttribute('data-activity-phase'), 'tool');
  assert.equal(toolRow.getAttribute('data-activity-tool'), 'Bash');
  assert.match(toolRow.textContent ?? '', /Running Bash/);
});

test('a resident-idle row renders idle and publishes no phase', async () => {
  const { container } = await renderView();

  await waitFor(() => rowFor(container, RESIDENT_SESSION));
  const row = rowFor(container, RESIDENT_SESSION);
  assert.equal(row.hasAttribute('data-activity-phase'), false);
  assert.equal(row.hasAttribute('data-activity-tool'), false);
  assert.equal(row.hasAttribute('data-activity-elapsed'), false);
  assert.match(row.textContent ?? '', /Idle/);
});

test('a tool phase with no name falls back to the generic tool word', async () => {
  apiState.runningSessions = [{ sessionId: RUNNING_SESSION, startedAt: START }];
  const { container, push } = await renderView();

  await waitFor(() => rowFor(container, RUNNING_SESSION));
  push(snapshotFrame(RUNNING_SESSION, 'tool', null, START + 1_000));

  await waitFor(() => {
    assert.equal(rowFor(container, RUNNING_SESSION).getAttribute('data-activity-phase'), 'tool');
  });
  const row = rowFor(container, RUNNING_SESSION);
  assert.equal(row.getAttribute('data-activity-tool'), '');
  assert.match(row.textContent ?? '', /Running a tool/);
});

// AC4: the project row's two layouts are separate render branches — a tappable
// card for the touch sidebar and a dense button row for desktop. Both have to
// carry the same reading, so both are exercised rather than inferred from the
// one the default viewport happens to take.
for (const compact of [true, false]) {
  test(`the ${compact ? 'compact' : 'desktop'} session row renders phase, tool and elapsed`, async () => {
    layoutState.compact = compact;
    apiState.runningSessions = [{ sessionId: RUNNING_SESSION, startedAt: START }];
    const { container, push } = await renderItem();

    // Prove the branch under test actually rendered: only the desktop layout
    // wraps the name in a session link; the compact card handles the tap.
    const rowLink = container.querySelector(`a[href="/session/${RUNNING_SESSION}"]`);
    assert.equal(rowLink !== null, !compact, `expected the ${compact ? 'compact' : 'desktop'} branch`);

    push(snapshotFrame(RUNNING_SESSION, 'tool', 'Bash', START + 1_000));

    await waitFor(() => {
      const row = container.querySelector<HTMLElement>('[data-activity-phase]');
      assert.ok(row, 'expected the row to publish its phase');
      assert.equal(row.getAttribute('data-activity-phase'), 'tool');
    });

    const row = container.querySelector<HTMLElement>('[data-activity-phase]');
    assert.ok(row);
    assert.equal(row.getAttribute('data-activity-phase'), 'tool');
    assert.equal(row.getAttribute('data-activity-tool'), 'Bash');
    assert.ok(Number.isFinite(Number(row.getAttribute('data-activity-elapsed'))));
    assert.match(row.textContent ?? '', /Running Bash/);
  });
}
