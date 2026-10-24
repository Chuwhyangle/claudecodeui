import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuayFleetSummary, QuaySnapshot } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import CockpitPage from '@/modules/cockpit/CockpitPage';

/**
 * WHOSE VIEW WINS WHEN THE PAGE OPENS.
 *
 * The cockpit's view is owned by the server-side hub so that two displays agree, but the URL is
 * also an address a person can be sent to (`?view=board&project=quay-fleet` from a sidebar mode
 * switch, a project row's 「在驾驶舱中查看」, or a pasted link). The two rules must not be confused:
 *
 *   - a URL that SPELLS a view is a deliberate navigation: it wins, and the hub is told so the
 *     other displays follow;
 *   - a BARE `/cockpit` (or a reconnection) adopts the view the hub holds — that is where the
 *     cross-device "another display drove it" semantics live.
 *
 * The hub double below is the transport plus the hub's `setView` transition; `held` is the state
 * a real server would broadcast on connect, `sent` is the frame log a case reads to prove what
 * the page asked the hub to do.
 */

type HubFrame = Record<string, unknown>;

type FakeView = { type: 'fleet' } | { type: 'board'; project: string };
type FakeFocusable = {
  uri: string;
  label: string;
  display: { status: string; color: string; ordinal: number; pos: { row: number; column: number } };
};
type FakeState = {
  rev: number;
  view: FakeView;
  viewStack: FakeView[];
  focusUri: string | null;
  tray: string[];
  history: string[];
  visible: {
    viewUri: string | null;
    focusables: FakeFocusable[];
    projects: Array<Record<string, unknown>>;
  };
  pendingSend: null;
  lastEventSource: Record<string, unknown> | null;
};

const hubMock = vi.hoisted(() => {
  const initialState = (): FakeState => ({
    rev: 0,
    view: { type: 'fleet' },
    viewStack: [],
    focusUri: null,
    tray: [],
    history: [],
    visible: { viewUri: null, focusables: [], projects: [] },
    pendingSend: null,
    lastEventSource: null,
  });

  let state: FakeState = initialState();
  const listeners = new Set<(event: unknown) => void>();
  const sent: HubFrame[] = [];
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const emit = () => {
    const snapshot = clone(state);
    for (const listener of [...listeners]) {
      listener({ kind: 'cockpit.state', state: snapshot });
    }
  };

  /** The hub's one transition this suite needs: `setView`. Reports only refresh `visible`. */
  const apply = (event: Record<string, unknown>) => {
    state.rev += 1;
    if (event.type !== 'visible') {
      state.lastEventSource = (event.source as Record<string, unknown> | undefined) ?? null;
    }
    if (event.type === 'setView') {
      const view = clone(event.view) as FakeView;
      const unchanged =
        view.type === state.view.type &&
        (view.type === 'fleet' ||
          (state.view.type === 'board' && state.view.project === view.project));
      if (!unchanged) {
        state.viewStack.push(state.view);
        state.view = view;
        state.visible = { viewUri: null, focusables: [], projects: state.visible.projects };
        state.focusUri = null;
      }
      return;
    }
    if (event.type === 'visible') {
      state.visible = {
        viewUri: (event.viewUri as string | null) ?? null,
        focusables: clone((event.focusables as FakeFocusable[] | undefined) ?? []),
        projects: clone((event.projects as Array<Record<string, unknown>> | undefined) ?? []),
      };
    }
  };

  const socket = {
    isConnected: true,
    sendMessage(frame: HubFrame) {
      sent.push(clone(frame));
      if (frame.type === 'cockpit.event') apply(frame.event as Record<string, unknown>);
      emit();
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      // A real hub answers the connection with its held state; doing it here is what makes a
      // "the hub already had board A before this page loaded" fixture deterministic.
      listener({ kind: 'cockpit.state', state: clone(state) });
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    socket,
    sent,
    reset() {
      state = initialState();
      sent.length = 0;
      listeners.clear();
      socket.isConnected = true;
    },
    /** The view the hub already held when this page connects. */
    holdView(view: FakeView, rev = 5) {
      state = { ...initialState(), rev, view: clone(view) };
    },
    /** A state the hub broadcasts later (another display drove it). */
    pushState(next: FakeState) {
      state = clone(next);
      emit();
    },
    /** Re-renders subscribers with the currently held state (used to observe a connection edge). */
    emitCurrent() {
      emit();
    },
    getState() {
      return clone(state);
    },
  };
});

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocketOptional: () => hubMock.socket,
  useWebSocket: () => hubMock.socket,
}));

const apiMock = vi.hoisted(() => ({
  quayFleetSummary: vi.fn(),
  quaySnapshot: vi.fn(),
  observationFetch: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: apiMock,
  authenticatedFetch: apiMock.observationFetch,
}));

const FLEET: QuayFleetSummary = {
  projects: [
    {
      projectId: 'p1',
      fleetProjectId: 'claudecodeui',
      projectPath: '/work/claudecodeui',
      driver: { state: 'running' },
      tasks: { total: 1, todo: 0, ready: 1, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p2',
      fleetProjectId: 'quay-fleet',
      projectPath: '/work/quay-fleet',
      driver: { state: 'idle' },
      tasks: { total: 1, todo: 0, ready: 1, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-24T00:00:00.000Z',
  ttlPerProjectMs: 30000,
  cached: false,
};

const SNAPSHOT: QuaySnapshot = {
  projectId: 'p2',
  projectPath: '/work/quay-fleet',
  fleetProjectId: 'quay-fleet',
  generatedAt: '2026-10-24T00:00:00.000Z',
  cached: false,
  driver: { state: 'idle', alive: true, running: false, lastRecordAt: null },
  tasks: {
    total: 0,
    byStatus: { ready: 0 },
    ready: 0,
    needsHuman: 0,
    done: 0,
    recent: [],
  },
  goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
  adrs: { total: 0, recent: [] },
  configIssues: { total: 0, errors: 0 },
  tests: { current: null, recentRounds: [] },
  fanIn: { recent: [] },
  inFlight: [],
  dashboardUrl: null,
  warnings: [],
};

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** Reports the router location so a case can assert the URL the view description produced. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-search={location.search} />;
}

function renderCockpit(initialPath: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[initialPath]}>
        <CockpitPage />
        <LocationProbe />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

const locationSearch = () => screen.getByTestId('location').getAttribute('data-search') ?? '';
const renderedView = () =>
  screen.getByTestId('cockpit-page').getAttribute('data-cockpit-view') ?? '';
const viewLabel = () => screen.getByTestId('cockpit-view-label').textContent ?? '';
/** The hub's frames of one type — what the page ASKED the hub to do, not what it drew. */
function sentEvents(type?: string): Array<Record<string, unknown>> {
  return hubMock.sent
    .filter((frame) => frame.type === 'cockpit.event')
    .map((frame) => frame.event as Record<string, unknown>)
    .filter((event) => type === undefined || event.type === type);
}

beforeEach(() => {
  hubMock.reset();
  apiMock.quayFleetSummary.mockReset();
  apiMock.quaySnapshot.mockReset();
  apiMock.observationFetch.mockReset();
  apiMock.quayFleetSummary.mockResolvedValue(okResponse(FLEET));
  apiMock.quaySnapshot.mockResolvedValue(okResponse(SNAPSHOT));
  apiMock.observationFetch.mockResolvedValue(
    okResponse({ entries: [], collapsedCount: 0, producers: [], self: null }),
  );
});

describe('AC1: an explicit deep link beats the hub’s stale view', () => {
  it('keeps the linked board B, renders it, and tells the hub once', async () => {
    // The hub still holds board A from another display — the reported bug.
    hubMock.holdView({ type: 'board', project: 'claudecodeui' }, 5);
    renderCockpit('/cockpit?view=board&project=quay-fleet');

    // The hub is told where the person actually navigated, once.
    await waitFor(() => expect(sentEvents('setView')).toHaveLength(1));
    expect(sentEvents('setView')[0]?.view).toEqual({ type: 'board', project: 'quay-fleet' });

    // The stale board A frame must not rewrite the URL, and the page renders B.
    await waitFor(() => expect(renderedView()).toBe('board'));
    expect(locationSearch()).toBe('?view=board&project=quay-fleet');
    expect(viewLabel()).toContain('quay-fleet');
    // No second correction later either: the mirror effect acknowledged the hub, it did not
    // fight it back and forth.
    expect(sentEvents('setView')).toHaveLength(1);
  });
});

describe('AC2: a bare URL and an explicit fleet link', () => {
  it('adopts the hub’s board A for a bare /cockpit, aligning the URL without a setView', async () => {
    hubMock.holdView({ type: 'board', project: 'claudecodeui' }, 5);
    renderCockpit('/cockpit');

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=claudecodeui'));
    expect(renderedView()).toBe('board');
    expect(viewLabel()).toContain('claudecodeui');
    // Adoption is a READ of the hub, never a write back to it.
    expect(sentEvents('setView')).toHaveLength(0);
  });

  it('keeps an explicit ?view=fleet and moves the hub there', async () => {
    hubMock.holdView({ type: 'board', project: 'claudecodeui' }, 5);
    renderCockpit('/cockpit?view=fleet');

    await waitFor(() => expect(sentEvents('setView')).toHaveLength(1));
    expect(sentEvents('setView')[0]?.view).toEqual({ type: 'fleet' });
    await waitFor(() => expect(renderedView()).toBe('fleet'));
    expect(locationSearch()).toBe('?view=fleet');
  });
});

describe('AC3: the hub still drives a mounted page, and reconnection adopts it', () => {
  it('mirrors a view another display pushed after mount', async () => {
    hubMock.holdView({ type: 'fleet' }, 4);
    renderCockpit('/cockpit');

    // The project strip appears only once the roster is loaded — the same moment the entry
    // direction is settled, so the push below is a genuinely post-mount event.
    await screen.findAllByTestId('cockpit-project-strip-item');

    hubMock.pushState({
      rev: 9,
      view: { type: 'board', project: 'quay-fleet' },
      viewStack: [{ type: 'fleet' }],
      focusUri: null,
      tray: [],
      history: [],
      visible: { viewUri: 'quay://quay-fleet/board', focusables: [], projects: [] },
      pendingSend: null,
      lastEventSource: { deviceId: 'device-phone', deviceName: 'phone', role: 'input' },
    });

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=quay-fleet'));
    expect(renderedView()).toBe('board');
    expect(viewLabel()).toContain('quay-fleet');
  });

  it('adopts the hub view after a reconnection, even on a bare URL', async () => {
    // The page lands on a bare /cockpit while the hub holds the fleet: nothing to mirror yet.
    hubMock.holdView({ type: 'fleet' }, 4);
    renderCockpit('/cockpit');
    // Wait for the roster AND the entry decision it settles.
    await screen.findAllByTestId('cockpit-project-strip-item');

    // The transport drops. Another display drives the hub to board A while this page cannot
    // hear anything; both facts arrive together when the socket comes back.
    hubMock.socket.isConnected = false;
    hubMock.emitCurrent();
    await waitFor(() =>
      expect(screen.getByTestId('cockpit-page').getAttribute('data-cockpit-hub-connected')).toBe(
        'false',
      ),
    );

    hubMock.holdView({ type: 'board', project: 'claudecodeui' }, 8);
    hubMock.socket.isConnected = true;
    hubMock.emitCurrent();

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-page').getAttribute('data-cockpit-hub-connected')).toBe(
        'true',
      ),
    );

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=claudecodeui'));
    expect(renderedView()).toBe('board');
    expect(viewLabel()).toContain('claudecodeui');
  });
});
