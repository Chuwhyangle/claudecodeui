import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuayFleetSummary, QuaySnapshot } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import CockpitPage, { COCKPIT_HEADER_CONTROL_SIZE_CLASS } from '@/modules/cockpit/CockpitPage';
import { formatCockpitView, parseCockpitView } from '@/modules/cockpit/cockpitView';
import type { CockpitView } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit stage in a real router, wired to a FAKE HUB connection.
 *
 * WHY A FAKE HUB. Focus, view and the confirmation card are no longer page state: the page
 * sends events to the cockpit hub and renders what it is broadcast back. So the test's double
 * is the transport plus the hub's transitions, exactly the seam production fills with the
 * websocket. `hubMock.sent` is the fake connection's frame log — a direction key must appear
 * there as a `move` event, which is what proves the page did not move focus locally.
 *
 * Only the network hop (`@/shared/api`) is otherwise stubbed; the page, the fleet projection,
 * quay's in-flight contract and `useQuayStatus` all run for real.
 */

type HubFrame = Record<string, unknown>;

/** The subset of the hub's state this fake needs; it is the real shape the page renders. */
type FakeView = { type: 'fleet' } | { type: 'board'; project: string };
type FakeFocusable = {
  uri: string;
  label: string;
  display: { status: string; color: string; ordinal: number; pos: { row: number; column: number } };
};
type FakePending = {
  text: string;
  visible: FakeFocusable[];
  viewUri: string | null;
  focusUri: string | null;
  target: Record<string, unknown> | null;
  reason: string | null;
};
type FakeState = {
  rev: number;
  view: FakeView;
  viewStack: FakeView[];
  focusUri: string | null;
  tray: string[];
  history: string[];
  visible: { viewUri: string | null; focusables: FakeFocusable[]; projects: Array<Record<string, unknown>> };
  pendingSend: FakePending | null;
  lastEventSource: Record<string, unknown> | null;
};

const hubMock = vi.hoisted(() => {
  /** The state a page draws before the server has said anything. */
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
  let echo = true;
  const listeners = new Set<(event: unknown) => void>();
  const sent: HubFrame[] = [];
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const emit = () => {
    const snapshot = clone(state);
    for (const listener of [...listeners]) {
      listener({ kind: 'cockpit.state', state: snapshot });
    }
  };

  const ordered = (objects: FakeFocusable[]) =>
    [...objects].sort(
      (left, right) =>
        left.display.pos.row - right.display.pos.row ||
        left.display.pos.column - right.display.pos.column,
    );

  const setView = (view: FakeView) => {
    const unchanged =
      view.type === state.view.type &&
      (view.type === 'fleet' ||
        (state.view.type === 'board' && state.view.project === view.project));
    if (unchanged) return;
    state.viewStack.push(state.view);
    state.view = view;
    state.visible = { viewUri: null, focusables: [], projects: state.visible.projects };
    state.focusUri = null;
  };

  const back = () => {
    const previous = state.viewStack.pop() as { type: string } | undefined;
    const next = previous ?? (state.view.type === 'board' ? { type: 'fleet' } : null);
    if (next === null) return;
    state.view = next as typeof state.view;
    state.visible = { viewUri: null, focusables: [], projects: state.visible.projects };
    state.focusUri = null;
  };

  /** The hub's transitions, implemented here as the test double of the server-side reducer. */
  const apply = (event: Record<string, unknown>) => {
    state.rev += 1;
    // A report is not an action: the status bar echoes the last device that ACTED.
    if (event.type !== 'visible') {
      state.lastEventSource = (event.source as Record<string, unknown> | undefined) ?? null;
    }
    const focusables = state.visible.focusables;

    switch (event.type) {
      case 'visible': {
        state.visible = {
          viewUri: (event.viewUri as string | null) ?? null,
          focusables: clone((event.focusables as FakeFocusable[] | undefined) ?? []),
          projects: clone((event.projects as Array<Record<string, unknown>> | undefined) ?? []),
        };
        const next = state.visible.focusables;
        if (state.focusUri === null || !next.some((object) => object.uri === state.focusUri)) {
          state.focusUri = ordered(next)[0]?.uri ?? null;
        }
        return;
      }
      case 'move': {
        const set = ordered(focusables);
        if (set.length === 0) return;
        const current = set.find((object) => object.uri === state.focusUri) ?? set[0];
        const { row, column } = current.display.pos;
        const direction = event.direction as 'up' | 'down' | 'left' | 'right';
        // The two axes of the reported grid, mirroring the server reducer: left/right stay in
        // the row, up/down take the adjacent row's nearest column.
        const nearestIn = (candidates: FakeFocusable[]) => {
          let best: FakeFocusable | undefined;
          for (const candidate of candidates) {
            if (best === undefined) {
              best = candidate;
              continue;
            }
            const distance = Math.abs(candidate.display.pos.column - column);
            const bestDistance = Math.abs(best.display.pos.column - column);
            if (
              distance < bestDistance ||
              (distance === bestDistance && candidate.display.pos.column < best.display.pos.column)
            ) {
              best = candidate;
            }
          }
          return best;
        };
        let next: FakeFocusable | undefined;
        if (direction === 'down' || direction === 'up') {
          const rows = set
            .map((object) => object.display.pos.row)
            .filter((candidateRow) => (direction === 'down' ? candidateRow > row : candidateRow < row));
          if (rows.length === 0) return;
          const targetRow =
            direction === 'down' ? Math.min(...rows) : Math.max(...rows);
          next = nearestIn(set.filter((object) => object.display.pos.row === targetRow));
        } else {
          const candidates = set.filter((object) =>
            direction === 'right'
              ? object.display.pos.row === row && object.display.pos.column > column
              : object.display.pos.row === row && object.display.pos.column < column,
          );
          next =
            direction === 'right'
              ? candidates.sort((a, b) => a.display.pos.column - b.display.pos.column)[0]
              : candidates.sort((a, b) => b.display.pos.column - a.display.pos.column)[0];
        }
        if (next !== undefined) state.focusUri = next.uri;
        return;
      }
      case 'focus':
        if (focusables.some((object) => object.uri === event.uri)) state.focusUri = event.uri as string;
        return;
      case 'zoom':
        if (event.direction === 'in') {
          const match = /^quay:\/\/([^/]+)\/board/.exec(state.focusUri ?? '');
          if (match !== null) setView({ type: 'board', project: match[1] });
        } else {
          back();
        }
        return;
      case 'back':
        back();
        return;
      case 'setView':
        setView(event.view as { type: 'fleet' } | { type: 'board'; project: string });
        return;
      case 'utterance': {
        const text = String(event.text ?? '').trim();
        if (/返回/.test(text)) {
          back();
          return;
        }
        if (/全部项目/.test(text)) {
          setView({ type: 'fleet' });
          return;
        }
        const named = /(?:看|打开|显示)\s*([a-zA-Z0-9_-]+)/.exec(text);
        if (named !== null) {
          const hit = focusables.some((object) =>
            object.uri.toLowerCase().startsWith(`quay://${named[1].toLowerCase()}/`),
          );
          if (hit) {
            setView({ type: 'board', project: named[1] });
            return;
          }
        }
        state.pendingSend = {
          text,
          visible: clone(focusables),
          viewUri: state.visible.viewUri,
          focusUri: state.focusUri,
          target: null,
          reason: state.focusUri === null ? 'no-focus' : 'no-session',
        };
        return;
      }
      case 'confirm':
      case 'cancel':
        state.pendingSend = null;
        return;
      case 'pinTarget':
        if (state.pendingSend?.target != null) {
          state.pendingSend.target.source = 'pinned';
        }
        return;
      case 'pin':
        if (state.focusUri !== null && !state.tray.includes(state.focusUri)) {
          state.tray.push(state.focusUri);
        }
        return;
      case 'unpin':
        state.tray = state.tray.filter((uri) => uri !== event.uri);
        return;
      default:
        return;
    }
  };

  const socket = {
    ws: null as unknown,
    isConnected: true,
    sendMessage(frame: HubFrame) {
      sent.push(clone(frame));
      if (!echo) return;
      if (frame.type === 'cockpit.event') apply(frame.event as Record<string, unknown>);
      emit();
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
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
      echo = true;
    },
    setEcho(value: boolean) {
      echo = value;
    },
    /** Pushes a state as if the hub had broadcast it; independent of `echo`. */
    pushState(next: FakeState) {
      state = clone(next);
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
  // The observation wall reads its own route through `authenticatedFetch`; these cases are about
  // the fleet/board stage, so an empty wall is the honest fixture.
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
      // The project segment every address carries is the FLEET registry id, never this id.
      fleetProjectId: 'claudecodeui',
      projectPath: '/work/claudecodeui',
      driver: { state: 'running' },
      tasks: { total: 4, todo: 1, ready: 2, needsHuman: 1, done: 0 },
      // The tile's pulse reading: one running task and one live obstruction with a dependent.
      pulse: {
        generatedAt: '2026-10-23T00:00:00.000Z',
        inFlight: [
          {
            taskId: 'task-live',
            phase: 'implementing',
            startedAt: '2026-10-22T23:00:00.000Z',
            lastHeartbeat: '2026-10-22T23:59:00.000Z',
            workerPid: 7,
          },
        ],
        gantt: null,
        tests: { current: null, recentRounds: [] },
        fanIn: { recent: [] },
        blockers: [
          {
            taskId: 'task-blocked',
            since: '2026-10-22T20:00:00.000Z',
            signature: 'AC 未全勾 :: checked #/#',
            occurrences: 1,
            dependents: ['task-waiter'],
          },
        ],
      },
      cached: false,
      error: null,
    },
    {
      projectId: 'p2',
      fleetProjectId: 'quay-fleet',
      projectPath: '/work/quay-fleet',
      driver: { state: 'stale' },
      tasks: { total: 2, todo: 1, ready: 0, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p3',
      // Not registered with quay-fleet: no address can be minted for it.
      fleetProjectId: null,
      projectPath: '/work/cantus',
      driver: { state: 'idle' },
      tasks: { total: 1, todo: 1, ready: 0, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-23T00:00:00.000Z',
  ttlPerProjectMs: 30000,
  cached: false,
};

/**
 * A fleet whose waiting project sits SECOND in roster order. `FLEET` already has claudecodeui
 * needing a person; swapping the two counts makes "waiting first" a re-order rather than a
 * no-op, so a view that ignored `?attention=1` could not pass by luck.
 */
const FLEET_ATTENTION: QuayFleetSummary = {
  ...FLEET,
  projects: FLEET.projects.map((project) => ({
    ...project,
    tasks: {
      ...project.tasks,
      needsHuman:
        project.fleetProjectId === 'quay-fleet' ? 1 : project.fleetProjectId === 'claudecodeui' ? 0 : 0,
    },
  })),
};

/**
 * AC2's fixture: a five-tile fleet whose unregistered projects sit INSIDE the grid, not at its
 * end. At the `xl` breakpoint the grid draws three columns, so the visual cells are:
 *
 *   (1,1) claudecodeui   (1,2) meta-cc [placeholder]   (1,3) quay-fleet
 *   (2,1) archguard      (2,2) plantuml-js [placeholder]
 *
 * The placeholders declare no object but still occupy their cell; the reported `pos` must be
 * the cell each TILE is drawn in, not a re-count of the three declared objects.
 */
const FLEET_WITH_HOLES: QuayFleetSummary = {
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
      projectId: 'p4',
      fleetProjectId: null,
      projectPath: '/work/meta-cc',
      driver: { state: 'idle' },
      tasks: { total: 1, todo: 1, ready: 0, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p2',
      fleetProjectId: 'quay-fleet',
      projectPath: '/work/quay-fleet',
      driver: { state: 'stale' },
      tasks: { total: 1, todo: 0, ready: 0, needsHuman: 1, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p5',
      fleetProjectId: 'archguard',
      projectPath: '/work/archguard',
      driver: { state: 'running' },
      tasks: { total: 1, todo: 1, ready: 0, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p6',
      fleetProjectId: null,
      projectPath: '/work/plantuml-js',
      driver: { state: 'idle' },
      tasks: { total: 1, todo: 1, ready: 0, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-23T00:00:00.000Z',
  ttlPerProjectMs: 30000,
  cached: false,
};

/**
 * The strip's openability fixture: one project that can be opened, one whose root is not in the
 * quay-fleet registry, and one that IS registered but whose driver did not answer. The last two
 * are the two different refusal causes the strip must name — a registry action and a runtime one.
 */
const FLEET_OPENABILITY: QuayFleetSummary = {
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
      projectId: 'p3',
      // Not registered with quay-fleet: no address can be minted for it.
      fleetProjectId: null,
      projectPath: '/work/cantus',
      driver: { state: 'idle' },
      tasks: { total: 1, todo: 1, ready: 0, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p7',
      // Registered (it has a fleet handle) but its driver did not answer.
      fleetProjectId: 'quay-dogfood-goal030',
      projectPath: '/work/quay-dogfood-goal030',
      driver: { state: 'unavailable' },
      tasks: { total: 2, todo: 1, ready: 0, needsHuman: 1, done: 0 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-23T00:00:00.000Z',
  ttlPerProjectMs: 30000,
  cached: false,
};

const SNAPSHOT: QuaySnapshot = {
  projectId: 'p1',
  projectPath: '/work/claudecodeui',
  fleetProjectId: 'claudecodeui',
  generatedAt: '2026-10-23T00:00:00.000Z',
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: '2026-10-22T23:59:00.000Z' },
  tasks: {
    total: 2,
    byStatus: { ready: 1, 'needs-human': 1 },
    ready: 1,
    needsHuman: 1,
    done: 0,
    recent: [
      { id: 'task-a', title: 'Make the in-flight tile readable', status: 'ready', updatedAt: null },
    ],
  },
  goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
  adrs: { total: 0, recent: [] },
  configIssues: { total: 0, errors: 0 },
  tests: { current: null, recentRounds: [] },
  fanIn: { recent: [] },
  inFlight: [
    {
      taskId: 'task-a',
      phase: 'implementing',
      startedAt: '2026-10-22T23:00:00.000Z',
      lastHeartbeat: '2026-10-22T23:59:00.000Z',
      workerPid: 1234,
    },
  ],
  dashboardUrl: null,
  warnings: [],
};

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** Reports the router location so a case can assert the URL the view description produced. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-search={location.search} />;
}

function renderCockpit(initialPath = '/cockpit?view=fleet') {
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
const focusUri = () =>
  screen.getByTestId('cockpit-page').getAttribute('data-cockpit-focus-uri');

/** The focusable declaration a rendered view publishes, parsed from its own attribute. */
function declaredFocusables(container: HTMLElement): Array<{
  uri: string;
  label: string;
  display: { status: string; color: string; ordinal: number; pos: { row: number; column: number } };
}> {
  const holder = container.matches('[data-cockpit-focusables]')
    ? container
    : container.querySelector('[data-cockpit-focusables]');
  expect(holder).not.toBeNull();
  return JSON.parse(holder?.getAttribute('data-cockpit-focusables') ?? '[]') as Array<{
    uri: string;
    label: string;
    display: { status: string; color: string; ordinal: number; pos: { row: number; column: number } };
  }>;
}

/** The hub's frames of one type; a case reads what the page SENT rather than what it drew. */
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

describe('fleet view contract', () => {
  it('declares every REGISTERED project as quay://<fleetProjectId>/board with its ordinal label', async () => {
    renderCockpit();

    const tiles = await screen.findByTestId('cockpit-fleet-tiles');
    const declared = declaredFocusables(tiles);

    expect(declared.map((object) => object.uri)).toEqual([
      'quay://claudecodeui/board',
      'quay://quay-fleet/board',
    ]);
    expect(declared.map((object) => object.label)).toEqual(['①', '②']);
    expect(
      screen
        .getAllByTestId('cockpit-fleet-tile')
        .map((tile) => tile.getAttribute('data-quay-uri')),
    ).toEqual(['quay://claudecodeui/board', 'quay://quay-fleet/board', null]);
  });

  it('AC2: a project the fleet does not register is drawn but cannot be focused or addressed', async () => {
    renderCockpit();

    const tiles = await screen.findAllByTestId('cockpit-fleet-tile');
    expect(tiles).toHaveLength(3);

    // The unregistered tile still reports its reading — losing the address must not lose the
    // counts — but it declares no URI, no ordinal and no button role.
    const unregistered = tiles[2] as HTMLElement;
    expect(unregistered.getAttribute('data-fleet-registered')).toBe('false');
    expect(unregistered.hasAttribute('data-quay-uri')).toBe(false);
    expect(unregistered.hasAttribute('data-quay-label')).toBe(false);
    expect(unregistered.getAttribute('role')).toBeNull();
    expect(unregistered.getAttribute('tabIndex')).toBeNull();
    expect(unregistered.textContent).toContain('cantus');

    // It is absent from the declared set, so no direction key can reach it.
    const holders = document.querySelectorAll('[data-cockpit-focusables]');
    const declared = JSON.parse(
      holders[holders.length - 1]?.getAttribute('data-cockpit-focusables') ?? '[]',
    ) as { uri: string }[];
    expect(declared.map((object) => object.uri)).not.toContain('quay://p3/board');
    expect(declared.map((object) => object.uri)).not.toContain('quay://cantus/board');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(focusUri()).toBe('quay://quay-fleet/board');
  });

  it('AC2: reports each tile’s real grid cell, counting non-focusable placeholders', async () => {
    // The stage draws three columns from 1280px up; jsdom's default viewport is 1024px (two).
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    apiMock.quayFleetSummary.mockResolvedValue(okResponse(FLEET_WITH_HOLES));

    try {
      renderCockpit();
      const tiles = await screen.findAllByTestId('cockpit-fleet-tile');
      expect(tiles).toHaveLength(5);

      const declared = declaredFocusables(screen.getByTestId('cockpit-fleet-tiles'));
      // Labels stay in READING order among the declared objects: the second spoken object is
      // quay-fleet even though its cell is (1,3), because a placeholder sits between them.
      expect(declared.map((object) => object.label)).toEqual(['①', '②', '③']);
      expect(declared.map((object) => object.uri)).toEqual([
        'quay://claudecodeui/board',
        'quay://quay-fleet/board',
        'quay://archguard/board',
      ]);
      // ...but `pos` is the cell the TILE is drawn in, placeholders included. Re-numbering the
      // three declared objects from 1 would report (1,1) (1,2) (1,3) and make ↓ from the first
      // tile a no-op instead of landing on archguard.
      expect(declared.map((object) => object.display.pos)).toEqual([
        { row: 1, column: 1 },
        { row: 1, column: 3 },
        { row: 2, column: 1 },
      ]);

      // The tiles publish the same cells; the two unregistered tiles declare no object at all.
      const tilePositions = tiles.map((tile) => {
        const display = tile.getAttribute('data-quay-display');
        return display === null
          ? null
          : (JSON.parse(display) as { pos: { row: number; column: number } }).pos;
      });
      expect(tilePositions).toEqual([
        { row: 1, column: 1 },
        null,
        { row: 1, column: 3 },
        { row: 2, column: 1 },
        null,
      ]);

      // The reducer reads these cells: ↓ from the first tile belongs on the tile below it.
      await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      await waitFor(() => expect(focusUri()).toBe('quay://archguard/board'));
    } finally {
      if (widthDescriptor === undefined) {
        delete (window as unknown as { innerWidth?: number }).innerWidth;
      } else {
        Object.defineProperty(window, 'innerWidth', widthDescriptor);
      }
    }
  });

  it('moves focus by direction key on the reported grid and clamps at both ends', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    // Focus starts on the first declared object (the contract's own spatial order, as the hub
    // normalized the display's report).
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    // Two registered tiles in a two-column grid (jsdom's 1024px viewport) share one row, so
    // the horizontal axis moves between them and the vertical axis has nowhere to go.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(focusUri()).toBe('quay://quay-fleet/board');

    // Past the last declared object the focus stays put instead of wrapping or leaving the set
    // (the third project is unregistered and declares nothing to land on).
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(focusUri()).toBe('quay://quay-fleet/board');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(focusUri()).toBe('quay://claudecodeui/board');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(focusUri()).toBe('quay://claudecodeui/board');
  });
});

describe('unopenable project feedback', () => {
  beforeEach(() => {
    apiMock.quayFleetSummary.mockResolvedValue(okResponse(FLEET_OPENABILITY));
  });

  const stripItems = async () => {
    await screen.findByTestId('cockpit-project-strip');
    return screen.findAllByTestId('cockpit-project-strip-item');
  };
  const stripItem = (items: HTMLElement[], name: string): HTMLElement => {
    const found = items.find((item) => item.textContent?.includes(name));
    expect(found, `the strip draws ${name}`).toBeDefined();
    return found as HTMLElement;
  };

  it('AC1: only openable projects are enabled in the strip; the others name their cause', async () => {
    renderCockpit();
    const items = await stripItems();
    expect(items).toHaveLength(3);

    // Registered + driver running: untouched, same path tooltip as before this task.
    const openable = stripItem(items, 'claudecodeui');
    expect(openable.getAttribute('aria-disabled')).toBeNull();
    expect(openable.getAttribute('data-project-openable')).toBe('true');
    expect(openable.getAttribute('title')).toBe('/work/claudecodeui');

    // Not in the quay-fleet registry: disabled, and the title says so.
    const unregistered = stripItem(items, 'cantus');
    expect(unregistered.getAttribute('aria-disabled')).toBe('true');
    expect(unregistered.getAttribute('data-project-openable')).toBe('false');
    expect(unregistered.getAttribute('title')).toContain(
      i18n.t('cockpit.projectNotRegistered'),
    );

    // Registered but driver unavailable: disabled, with the RUNTIME cause, not the registry one.
    const noDriver = stripItem(items, 'quay-dogfood-goal030');
    expect(noDriver.getAttribute('aria-disabled')).toBe('true');
    expect(noDriver.getAttribute('data-project-openable')).toBe('false');
    expect(noDriver.getAttribute('title')).toContain(
      i18n.t('cockpit.projectDriverUnavailable'),
    );
  });

  it('AC2: clicking an unregistered project keeps the view and focus, and refuses out loud', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));
    const before = locationSearch();

    const items = await stripItems();
    fireEvent.click(stripItem(items, 'cantus'));

    const echo = await screen.findByTestId('cockpit-echo');
    expect(echo.getAttribute('data-echo-kind')).toBe('refused');
    // The echo carries all three parts: what failed, why, and the next step.
    expect(screen.getByTestId('cockpit-echo-text').textContent).toContain(
      i18n.t('cockpit.projectOpenRefused', { name: 'cantus' }),
    );
    expect(screen.getByTestId('cockpit-echo-reason').textContent).toContain(
      i18n.t('cockpit.projectNotRegistered'),
    );
    expect(screen.getByTestId('cockpit-echo-next').textContent).toContain(
      i18n.t('cockpit.projectUnregisteredNext'),
    );

    // The refusal is a no-op on the stage: same URL, same focus.
    expect(locationSearch()).toBe(before);
    expect(focusUri()).toBe('quay://claudecodeui/board');
  });

  it('AC2: clicking a registered project still opens its board', async () => {
    renderCockpit();
    const items = await stripItems();

    fireEvent.click(stripItem(items, 'claudecodeui'));

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=claudecodeui'));
    await screen.findByTestId('cockpit-board');
  });

  it('AC3: the fleet explains that ordinals cover registered projects, and an unnumbered digit is refused', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    // The visible copy line, not just a tooltip: the rule applies to the whole grid.
    expect(screen.getByTestId('cockpit-fleet-ordinal-note').textContent).toContain(
      i18n.t('cockpit.ordinalsRegisteredOnly'),
    );

    // ① and ② are minted for the two registered projects (the second is the driver-disabled
    // one); 3 has no declared ordinal, so it names an unnumbered project. That is a refusal,
    // not silence.
    fireEvent.keyDown(window, { key: '3' });

    const echo = await screen.findByTestId('cockpit-echo');
    expect(echo.getAttribute('data-echo-kind')).toBe('refused');
    expect(screen.getByTestId('cockpit-echo-text').textContent).toContain(
      i18n.t('cockpit.ordinalUnavailable', { n: '3' }),
    );
    expect(screen.getByTestId('cockpit-echo-reason').textContent).toContain(
      i18n.t('cockpit.ordinalsRegisteredOnly'),
    );
    expect(screen.getByTestId('cockpit-echo-next').textContent).toContain(
      i18n.t('cockpit.ordinalUnavailableNext'),
    );
  });

  it('AC3: a numbered digit still focuses the declared object it names', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    fireEvent.keyDown(window, { key: '2' });

    // ② is the driver-disabled but REGISTERED project: the ordinal model is the registry's,
    // not the strip's openability gate.
    await waitFor(() => expect(focusUri()).toBe('quay://quay-dogfood-goal030/board'));
    expect(screen.queryByTestId('cockpit-echo')).toBeNull();
  });
});

describe('hub-authored state', () => {
  it('sends direction keys to the hub as move events instead of moving focus locally', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    // Seed the hub's state directly (the display's own report may be suppressed by `echo`).
    hubMock.pushState({
      rev: 3,
      view: { type: 'fleet' },
      viewStack: [],
      focusUri: 'quay://claudecodeui/board',
      tray: [],
      history: [],
      visible: {
        viewUri: 'quay://fleet/board',
        focusables: [
          {
            uri: 'quay://claudecodeui/board',
            label: '①',
            display: { status: 'running', color: 'green', ordinal: 1, pos: { row: 1, column: 1 } },
          },
          {
            uri: 'quay://quay-fleet/board',
            label: '②',
            display: { status: 'stale', color: 'amber', ordinal: 2, pos: { row: 2, column: 1 } },
          },
        ],
        projects: [],
      },
      pendingSend: null,
      lastEventSource: null,
    });
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    // With the hub's echo OFF, focus can only move if the page kept its own state — which is
    // exactly the second implementation this task removed.
    hubMock.setEcho(false);
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(sentEvents('move')).toHaveLength(1);
    expect(sentEvents('move')[0]?.direction).toBe('down');
    expect(focusUri()).toBe('quay://claudecodeui/board');
  });

  it('renders the focused object and the view the hub broadcast, not the URL', async () => {
    // `?debug=1`: the device echo is a machine handle, so it lives behind the debug switch now.
    renderCockpit('/cockpit?view=fleet&debug=1');
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    hubMock.pushState({
      rev: 7,
      view: { type: 'board', project: 'claudecodeui' },
      viewStack: [{ type: 'fleet' }],
      focusUri: 'quay://claudecodeui/task/task-a',
      tray: [],
      history: [],
      visible: { viewUri: 'quay://claudecodeui/board', focusables: [], projects: [] },
      pendingSend: null,
      lastEventSource: { deviceId: 'device-phone', deviceName: 'phone', role: 'input' },
    });

    // The URL follows the hub's view (the fleet segment `claudecodeui` is project p1), and the
    // debug switch survives the navigation.
    await waitFor(() =>
      expect(locationSearch()).toBe('?view=board&project=claudecodeui&debug=1'),
    );
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/task/task-a'));
    expect(screen.getByTestId('cockpit-event-source').textContent).toContain('phone');
  });
});

describe('visual attention', () => {
  it('marks only the tiles that need a person, and hides the always-on driver badge', async () => {
    renderCockpit();

    const tiles = await screen.findAllByTestId('cockpit-fleet-tile');
    expect(tiles).toHaveLength(3);
    // p1 reports one task needing a person; p2 reports none. The marker is the tile's own
    // data attribute, so the emphasis is addressable without reading CSS.
    expect(tiles[0]?.getAttribute('data-needs-human')).toBe('true');
    expect(tiles[1]?.hasAttribute('data-needs-human')).toBe(false);

    // A running driver draws no badge — it is the normal state, and a badge on every tile says
    // nothing. The stale driver (p2) is the abnormal reading and is the one that gets a badge.
    expect(within(tiles[0] as HTMLElement).queryByTestId('cockpit-fleet-tile-driver')).toBeNull();
    expect(
      within(tiles[1] as HTMLElement).getByTestId('cockpit-fleet-tile-driver').getAttribute('data-driver-state'),
    ).toBe('stale');
  });
});

describe('cockpit header mode switch', () => {
  it('AC2: renders exactly one accessible mode switch, so a reader is not told twice', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    // An accessible instance is one no aria-hidden ancestor removes from the accessibility
    // tree; Testing Library's role query already skips those, and the explicit filter keeps
    // this assertion honest if the query semantics change.
    const cockpitLinks = screen.getAllByRole('link', { name: i18n.t('cockpit.modeCockpit') });
    const accessible = cockpitLinks.filter(
      (link) => link.getAttribute('aria-hidden') !== 'true' && link.closest('[aria-hidden="true"]') === null,
    );
    expect(accessible).toHaveLength(1);
    expect(accessible[0]?.getAttribute('data-mode-switch-link')).toBe('cockpit');
    // …and the DOM itself carries one instance on this page: a selector cannot mis-hit either.
    expect(document.querySelectorAll('a[data-mode-switch-link="cockpit"]')).toHaveLength(1);
  });

  it('AC2: clicking the attention badge opens the fleet with the waiting projects first', async () => {
    apiMock.quayFleetSummary.mockResolvedValue(okResponse(FLEET_ATTENTION));
    renderCockpit('/cockpit?view=wall');

    const badge = await screen.findByTestId('cockpit-attention-badge');
    expect(badge.textContent).toBe('1');
    fireEvent.click(badge);

    await waitFor(() => expect(locationSearch()).toBe('?view=fleet&attention=1'));
    const tiles = await screen.findAllByTestId('cockpit-fleet-tile');
    // Render order, read from the DOM: quay-fleet (the waiting project) leads, even though the
    // roster reports claudecodeui first.
    const names = tiles.map(
      (tile) => within(tile).getByTestId('cockpit-fleet-tile-name').textContent,
    );
    expect(names[0]).toBe('quay-fleet');
    expect(names.indexOf('claudecodeui')).toBeGreaterThan(0);
    // The focus contract follows the same order, so → lands on the second DRAWN tile.
    await waitFor(() => expect(focusUri()).toBe('quay://quay-fleet/board'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));
  });

  it('AC3: the phone-remote toggle shares the icon button size and is hidden below md', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    const remote = screen.getByTestId('cockpit-remote-toggle');
    const cockpitSegment = screen
      .getByTestId('sidebar-mode-switch')
      .querySelector('[data-mode-switch-link="cockpit"]') as HTMLElement;

    // The same class, not a measured box: jsdom applies no CSS, so a height reading would be
    // noise. Each token of the shared constant must be on BOTH controls.
    const sharedTokens = COCKPIT_HEADER_CONTROL_SIZE_CLASS.split(/\s+/).filter(Boolean);
    expect(sharedTokens.length).toBeGreaterThan(0);
    for (const token of sharedTokens) {
      expect(remote.classList.contains(token), `remote toggle is missing ${token}`).toBe(true);
      expect(cockpitSegment.classList.contains(token), `mode switch is missing ${token}`).toBe(true);
    }

    // Hidden by default, shown from md: the phone cannot usefully scan its own screen.
    expect(remote.classList.contains('hidden')).toBe(true);
    expect(Array.from(remote.classList).some((token) => token.startsWith('md:'))).toBe(true);
  });

  it('draws the same switch as the sidebar, with the cockpit segment current', async () => {
    window.sessionStorage.clear();
    renderCockpit();

    const modeSwitch = await screen.findByTestId('sidebar-mode-switch');
    expect(modeSwitch.getAttribute('data-sidebar-mode')).toBe('cockpit');

    const cockpitSegment = modeSwitch.querySelector(
      '[data-mode-switch-link="cockpit"]',
    ) as HTMLAnchorElement;
    const sessionsSegment = modeSwitch.querySelector(
      '[data-mode-switch-link="sessions"]',
    ) as HTMLAnchorElement;
    expect(cockpitSegment.getAttribute('aria-current')).toBe('page');
    expect(sessionsSegment.hasAttribute('aria-current')).toBe(false);
  });

  it('leads back to the remembered session route, and home when nothing was recorded', async () => {
    window.sessionStorage.clear();
    renderCockpit();

    const withNoRecord = await screen.findByTestId('sidebar-mode-switch');
    expect(
      withNoRecord.querySelector('[data-mode-switch-link="sessions"]')?.getAttribute('href'),
    ).toBe('/');

    cleanup();
    window.sessionStorage.setItem('cockpit.returnPath', '/session/abc?tab=chat');
    renderCockpit();

    const withRecord = await screen.findByTestId('sidebar-mode-switch');
    expect(
      withRecord.querySelector('[data-mode-switch-link="sessions"]')?.getAttribute('href'),
    ).toBe('/session/abc?tab=chat');

    window.sessionStorage.clear();
  });
});

describe('view changes and history', () => {
  it('Enter on a project opens its board, and Backspace returns to the wall', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'Enter' });

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=quay-fleet'));
    await screen.findByTestId('cockpit-board');
    expect(apiMock.quaySnapshot.mock.calls[0]?.[0]).toBe('p2');

    fireEvent.keyDown(window, { key: 'Backspace' });

    await waitFor(() => expect(locationSearch()).toBe('?view=wall'));
    await screen.findByTestId('cockpit-wall');
  });

  it('round-trips the view description through the URL', () => {
    const views: CockpitView[] = [
      { type: 'wall' },
      { type: 'fleet' },
      { type: 'board', project: 'p1' },
      { type: 'board', project: 'p 1/x' },
    ];

    for (const view of views) {
      expect(parseCockpitView(formatCockpitView(view))).toEqual(view);
    }
    // A malformed URL still lands on a usable stage rather than throwing or blanking.
    expect(parseCockpitView('?view=board')).toEqual({ type: 'wall' });
    expect(parseCockpitView('')).toEqual({ type: 'wall' });
  });
});

describe('board view contract', () => {
  it('declares in-flight tasks as quay://<fleetProjectId>/task/<id>', async () => {
    renderCockpit('/cockpit?view=board&project=p1');

    const board = await screen.findByTestId('cockpit-board');
    await waitFor(() => {
      expect(declaredFocusables(board).map((object) => object.uri)).toEqual([
        'quay://claudecodeui/task/task-a',
      ]);
    });
  });

  it('names an in-flight tile by task id and title, never by its raw URI', async () => {
    renderCockpit('/cockpit?view=board&project=p1');

    await screen.findByTestId('cockpit-board-rail');
    const obj = await screen.findByTestId('cockpit-board-object');

    // The URI is the status bar's reading, not the tile's headline: a truncated
    // `quay://…/task/…` is neither readable nor speakable.
    expect(obj.textContent).not.toContain('quay://');
    expect(obj.textContent).toContain('task-a');
    expect(obj.textContent).toContain('Make the in-flight tile readable');

    // …and the address still reaches the status bar, where focus is named.
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/task/task-a'));
  });

  it('shows an error state (not a blank stage) when the snapshot fails, and focus stays in the view', async () => {
    apiMock.quaySnapshot.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    renderCockpit('/cockpit?view=board&project=p1&debug=1');

    const error = await screen.findByTestId('quay-panel-error');
    expect(error.textContent).toContain('HTTP 500');

    // No object is declared, so focus is absent rather than pointing at a vanished task; the
    // status bar still names the board the stage is showing.
    expect(focusUri()).toBeNull();
    expect(screen.getByTestId('cockpit-view-uri').textContent).toContain('quay://claudecodeui/board');

    // A direction key over an empty contract is a no-op: focus cannot leave the page.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(focusUri()).toBeNull();
  });
});

describe('AC3: keyboard ownership, fleet availability and the send preview', () => {
  it('loads with the STAGE focused, so the first → moves focus instead of landing in the input', async () => {
    const { container } = renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    const stage = screen.getByTestId('cockpit-stage');
    const textarea = container.querySelector('[data-slot="prompt-input-textarea"]');
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(stage);
    expect(document.activeElement).not.toBe(textarea);

    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));
    // THE FIRST PRESS NOW MOVES. With the textarea focused this key never reached the stage.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(focusUri()).toBe('quay://quay-fleet/board');
  });

  it('states a missing fleet CLI once, and no tile claims 「unregistered」 in that reading', async () => {
    apiMock.quayFleetSummary.mockResolvedValue(
      okResponse({
        ...FLEET,
        // The server could not run quay-fleet: every id is null for the SAME reason.
        fleet: { available: false, reason: 'quay-fleet was not found: quay-fleet' },
        projects: FLEET.projects.map((project) => ({ ...project, fleetProjectId: null })),
      }),
    );

    renderCockpit();

    const notice = await screen.findByTestId('cockpit-fleet-cli-missing');
    expect(notice.textContent).toContain('QUAY_FLEET_BIN');
    expect(notice.textContent).toContain('quay-fleet was not found');
    // One line, not one label per tile.
    expect(screen.queryAllByTestId('cockpit-fleet-tile-unregistered')).toHaveLength(0);
  });

  it('names the destination conversation by its title and states the target source', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    const sessionId = 'c5a57036-de6c-4f0a-9d3e-123456789abc';
    hubMock.pushState({
      rev: 5,
      view: { type: 'fleet' },
      viewStack: [],
      focusUri: 'quay://claudecodeui/board',
      tray: [],
      history: [],
      visible: {
        viewUri: null,
        focusables: [
          {
            uri: 'quay://claudecodeui/board',
            label: '①',
            display: { status: 'running', color: 'green', ordinal: 1, pos: { row: 1, column: 1 } },
          },
        ],
        projects: [],
      },
      pendingSend: {
        text: '看看这个',
        visible: [],
        viewUri: null,
        focusUri: 'quay://claudecodeui/board',
        target: {
          sessionId,
          projectId: 'p1',
          projectName: 'claudecodeui',
          sessionTitle: 'Fix the cockpit',
          source: 'pinned',
          fleetUnavailableReason: null,
        },
        reason: null,
      },
      lastEventSource: null,
    });

    const preview = await screen.findByTestId('cockpit-send-preview');
    expect(preview.textContent).toContain('Fix the cockpit');
    expect(preview.textContent).not.toContain(sessionId);
    const source = within(preview).getByTestId('cockpit-send-source');
    expect(source.textContent).toBe(i18n.t('cockpit.sendTargetPinned'));
  });

  it('shows 「unnamed conversation」 plus a SHORT id when the session has no title', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    const sessionId = 'c5a57036-de6c-4f0a-9d3e-123456789abc';
    hubMock.pushState({
      rev: 5,
      view: { type: 'fleet' },
      viewStack: [],
      focusUri: 'quay://claudecodeui/board',
      tray: [],
      history: [],
      visible: {
        viewUri: null,
        focusables: [],
        projects: [],
      },
      pendingSend: {
        text: '看看这个',
        visible: [],
        viewUri: null,
        focusUri: 'quay://claudecodeui/board',
        target: {
          sessionId,
          projectId: 'p1',
          projectName: 'claudecodeui',
          sessionTitle: null,
          source: 'recent',
          fleetUnavailableReason: null,
        },
        reason: null,
      },
      lastEventSource: null,
    });

    const preview = await screen.findByTestId('cockpit-send-preview');
    expect(preview.textContent).toContain(i18n.t('cockpit.unnamedSession', { id: 'c5a57036' }));
    // The full identifier is a storage handle, not a name.
    expect(preview.textContent).not.toContain(sessionId);
    expect(within(preview).getByTestId('cockpit-send-source').textContent).toBe(
      i18n.t('cockpit.sendTargetRecent'),
    );
  });
});

describe('cockpit input', () => {
  it('is assembled from the chat module’s PromptInput components', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    const form = screen.getByTestId('cockpit-input');
    expect(form.getAttribute('data-slot')).toBe('prompt-input');
    expect(form.querySelector('[data-slot="prompt-input-textarea"]')).not.toBeNull();
    expect(form.querySelector('[data-slot="prompt-input-footer"]')).not.toBeNull();
    expect(form.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('owns the arrow keys while focused, and submits a project request from the input', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    const textarea = screen
      .getByTestId('cockpit-input')
      .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
    textarea.focus();

    // The stage must not move focus while the input has it.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(focusUri()).toBe('quay://claudecodeui/board');
    expect(sentEvents('move')).toHaveLength(0);

    fireEvent.change(textarea, { target: { value: '看 claudecodeui' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=claudecodeui'));
    expect(sentEvents('utterance')[0]?.text).toBe('看 claudecodeui');

    // The intent → first-frame latency is recorded for the scenario runner.
    await waitFor(() => {
      const timings = JSON.parse(
        screen.getByTestId('cockpit-page').getAttribute('data-cockpit-timings') ?? '[]',
      ) as Array<{ source: string; ms: number }>;
      expect(timings.some((timing) => timing.source === 'intent' && timing.ms >= 0)).toBe(true);
    });
  });

  it('states an unmatched phrase instead of guessing', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    const textarea = screen
      .getByTestId('cockpit-input')
      .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '今天天气不错' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const unmatched = await screen.findByTestId('cockpit-intent-unmatched');
    expect(unmatched.textContent).toContain('今天天气不错');
    // No guess — and therefore no navigation: the stage stays on the fleet it was showing.
    expect(locationSearch()).toBe('?view=fleet');
  });
});

/**
 * AC1 — the echo must not resize the stage, and the fleet footer must name the focused tile.
 *
 * The regression this pins: the echo banner used to be an in-flow row inside the footer, so every
 * submit grew the footer by a banner's height and shrank the stage (clipping its last line). The
 * assertion is deliberately class-based, not pixel-based: the banner carries the overlay marker
 * plus `absolute`, the footer is its positioned ancestor, and the stage's own class string is
 * identical before and after the echo appears.
 */
describe('AC1: echo overlay and the fleet focus footer', () => {
  it('draws the echo as an anchored overlay so the stage keeps its own box, and names the focused tile', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/board'));

    // The focused tile is readable in the footer: its ordinal AND its project, never 「none」.
    const focusedTile = screen
      .getAllByTestId('cockpit-fleet-tile')[0] as HTMLElement;
    const tileLabel = within(focusedTile).getByTestId('cockpit-fleet-tile-label').textContent ?? '';
    const tileName = within(focusedTile).getByTestId('cockpit-fleet-tile-name').textContent ?? '';
    expect(tileLabel).not.toBe('');
    expect(tileName).not.toBe('');
    const focusLine = screen.getByTestId('cockpit-focus').textContent ?? '';
    expect(focusLine).toContain(tileLabel);
    expect(focusLine).toContain(tileName);
    expect(focusLine).not.toContain('none');

    const stageBefore = screen.getByTestId('cockpit-stage').className;

    // Submit a phrase the hub cannot place: that is the shortest path to a refused echo.
    const textarea = screen
      .getByTestId('cockpit-input')
      .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '今天天气不错' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const echo = await screen.findByTestId('cockpit-echo');
    const echoClasses = echo.className.split(/\s+/);
    expect(echoClasses).toContain('cockpit-echo-overlay');
    expect(echoClasses).toContain('absolute');
    // The footer is the overlay's positioned ancestor, and the stage's box is unchanged.
    expect(screen.getByTestId('cockpit-status').className.split(/\s+/)).toContain('relative');
    expect(screen.getByTestId('cockpit-stage').className).toBe(stageBefore);
  });

  it('names the ringed (needs-you) fleet tile when the hub has reported no focus', async () => {
    renderCockpit();

    const tiles = await screen.findAllByTestId('cockpit-fleet-tile');
    expect(tiles[0]?.getAttribute('data-needs-human')).toBe('true');

    // A display that has not (yet) reported a focusable set reads Focus: none. The footer must
    // still reflect the tile a person sees ringed, instead of stopping at 「none」.
    hubMock.pushState({ ...hubMock.getState(), focusUri: null });
    const attention = await screen.findByTestId('cockpit-fleet-attention');
    expect(attention.textContent).toContain('claudecodeui');
  });
});

/**
 * AC2 — every in-flight chip is the same layout.
 *
 * The regression: the chip's width followed its longest line, so tasks with a subtitle drew
 * 600–900px bars and tasks without one stayed small pills. The test carries FOUR chips (two
 * without a title reading, two with long titles) and compares the literal `className` sets: one
 * shared layout. The focus ring is a data-attribute variant, so it cannot split the set.
 */
describe('AC2: unified in-flight chips', () => {
  it('renders four in-flight chips with one class set, wrapping long ids instead of nowrapping them', async () => {
    const longIds = [
      'gap-reply-suggestions-model-chip-fill-in-the-blank',
      'gap-reply-suggestions-compact-footer-is-too-narrow',
    ];
    const inFlightSnapshot: QuaySnapshot = {
      ...SNAPSHOT,
      tasks: {
        ...SNAPSHOT.tasks!,
        recent: [
          { id: longIds[0]!, title: 'Model chip fill-in', status: 'ready', updatedAt: null },
          { id: longIds[1]!, title: 'Compact footer is too narrow', status: 'ready', updatedAt: null },
        ],
      },
      inFlight: [
        { taskId: 'short-a', phase: 'implementing', startedAt: '2026-10-22T23:00:00.000Z', lastHeartbeat: '2026-10-22T23:59:00.000Z', workerPid: 1 },
        { taskId: 'short-b', phase: 'implementing', startedAt: '2026-10-22T23:00:00.000Z', lastHeartbeat: '2026-10-22T23:59:00.000Z', workerPid: 2 },
        { taskId: longIds[0]!, phase: 'fan-in', startedAt: '2026-10-22T23:00:00.000Z', lastHeartbeat: '2026-10-22T23:59:00.000Z', workerPid: 3 },
        { taskId: longIds[1]!, phase: 'awaiting-land', startedAt: '2026-10-22T23:00:00.000Z', lastHeartbeat: '2026-10-22T23:59:00.000Z', workerPid: 4 },
      ],
    };
    apiMock.quaySnapshot.mockResolvedValue(okResponse(inFlightSnapshot));

    renderCockpit('/cockpit?view=board&project=p1');

    const chips = await screen.findAllByTestId('cockpit-board-object');
    expect(chips).toHaveLength(4);
    expect(new Set(chips.map((chip) => chip.className)).size).toBe(1);

    const titleSpans = screen.getAllByTestId('cockpit-board-object-title');
    expect(titleSpans).toHaveLength(4);
    for (const span of titleSpans) {
      const tokens = (span.className ?? '').split(/\s+/);
      expect(tokens).toContain('break-words');
      expect(tokens).not.toContain('truncate');
      expect(tokens).not.toContain('whitespace-nowrap');
      // The full id stays in the DOM and in the tooltip: wrapping is visual, never a rewrite.
      expect(span.textContent).toBe(span.getAttribute('title'));
    }
    expect(titleSpans.map((span) => span.textContent)).toEqual(
      expect.arrayContaining(['short-a', 'short-b', longIds[0], longIds[1]]),
    );
    // No middle-ellipsis logic: the long id is carried in full by the node.
    expect(titleSpans.map((span) => span.textContent)).toContain(longIds[0]);
  });
});

/**
 * AC3 — the board's two long lists stay read on first look.
 *
 * Goals: drafts draw before achieved, and an achieved goal draws no full-width progress bar
 * (it has nothing left to complete). Recent tasks: a long id keeps the full value in `title`
 * and truncates at the TAIL (CSS `truncate`), never by rewriting the string around an ellipsis.
 */
describe('AC3: stage-goals ordering and tail-truncated task ids', () => {
  it('puts drafts before achieved, drops achieved bars, and keeps long recent-task ids in full', async () => {
    const longId = 'gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence';
    const achieved = Array.from({ length: 5 }, (_, index) => ({
      id: `GOAL-${100 + index}`,
      title: `Achieved goal ${index}`,
      status: 'achieved',
      updatedAt: '2026-10-22T00:00:00.000Z',
    }));
    const drafts = [
      { id: 'GOAL-201', title: 'Draft goal one', status: 'draft', updatedAt: '2026-10-21T00:00:00.000Z' },
      { id: 'GOAL-202', title: 'Draft goal two', status: 'draft', updatedAt: '2026-10-20T00:00:00.000Z' },
    ];
    const goalsSnapshot: QuaySnapshot = {
      ...SNAPSHOT,
      tasks: {
        ...SNAPSHOT.tasks!,
        recent: [{ id: longId, title: 'A task with a long id', status: 'ready', updatedAt: null }],
      },
      goals: {
        total: 7,
        achieved: 5,
        // Deliberately ranked achieved-first, the way an updatedAt sort returns them.
        breakdown: { byStatus: { achieved: 5, draft: 2 }, recent: [...achieved, ...drafts] },
      },
    };
    apiMock.quaySnapshot.mockResolvedValue(okResponse(goalsSnapshot));

    renderCockpit('/cockpit?view=board&project=p1');

    const rows = await screen.findAllByTestId('quay-panel-stage-goals-row');
    expect(rows).toHaveLength(7);
    const statuses = rows.map((row) => (row.textContent ?? '').toLowerCase());
    expect(statuses.slice(0, 2).every((text) => text.includes('draft'))).toBe(true);
    expect(statuses.slice(2).every((text) => text.includes('achieved'))).toBe(true);

    // Achieved rows carry no full-width bar node; drafts still do.
    for (const row of rows) {
      const isAchieved = (row.textContent ?? '').toLowerCase().includes('achieved');
      expect(row.querySelector('[data-testid="quay-panel-stage-goals-bar"]') === null).toBe(isAchieved);
    }

    // Recent tasks: the long id truncates at the tail and stays reachable in full.
    const taskRow = screen.getByTestId('quay-panel-recent-tasks-row');
    const idSpan = taskRow.querySelector('span') as HTMLElement;
    expect(idSpan.getAttribute('title')).toBe(longId);
    expect((idSpan.className ?? '').split(/\s+/)).toContain('truncate');
    expect(idSpan.textContent).toBe(longId);
    expect(idSpan.textContent).not.toContain('…');
  });
});

/**
 * AC3 — the phone narrow layout's CLASS contract.
 *
 * jsdom applies no stylesheet, so these are class-set assertions rather than box measurements
 * (the same discipline the header-size case above already uses): the strip scrolls with snap and
 * a right-edge fade, every strip item carries the 44×44 phone floor, and the three controls the
 * task names (Refresh, the mic, Run) carry the same floor. The `md:` resets are asserted too, so
 * the desktop layout the task must not change keeps its own boxes.
 */
describe('AC3: phone narrow layout classes', () => {
  it('gives the project strip scroll-snap and a right-edge fade, and every item a 44×44 floor', async () => {
    renderCockpit();

    const strip = await screen.findByTestId('cockpit-project-strip');
    const stripTokens = (strip.className ?? '').split(/\s+/).filter(Boolean);
    expect(stripTokens).toContain('snap-x');
    // The mask is the other half of the scroll affordance: the container fades its own right
    // edge on a phone, and the overlay element is the addressable reading of that fade.
    expect(stripTokens.some((token) => token.startsWith('[mask-image:'))).toBe(true);
    expect(stripTokens).toContain('md:[mask-image:none]');
    expect(screen.getByTestId('cockpit-project-strip-fade')).toBeTruthy();

    const items = await screen.findAllByTestId('cockpit-project-strip-item');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const tokens = (item.className ?? '').split(/\s+/).filter(Boolean);
      expect(tokens).toContain('min-h-[44px]');
      expect(tokens).toContain('min-w-[44px]');
      expect(tokens).toContain('snap-start');
      // The phone scrolls the whole item in and out; it never ellipsizes the project name.
      expect(tokens).not.toContain('truncate');
      // …while the desktop column keeps its original 44px-free, tail-truncated rows.
      expect(tokens).toContain('md:min-h-0');
      expect(tokens).toContain('md:truncate');
    }
  });

  it('gives Refresh, the voice input and Run the same 44px phone floor', async () => {
    renderCockpit('/cockpit?view=board&project=p1');

    const refresh = await screen.findByTestId('quay-panel-refresh');
    const voice = screen.getByTestId('voice-input-button');
    const submit = screen
      .getByTestId('cockpit-input')
      .querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).not.toBeNull();

    for (const [name, control] of [
      ['Refresh', refresh],
      ['voice input', voice],
      ['Run', submit],
    ] as const) {
      const tokens = (control.className ?? '').split(/\s+/).filter(Boolean);
      expect(tokens, `${name} carries the phone touch floor`).toContain('min-h-[44px]');
      expect(tokens, `${name} carries the phone touch floor`).toContain('min-w-[44px]');
      expect(tokens, `${name} restores the desktop box`).toContain('md:min-h-0');
      expect(tokens, `${name} restores the desktop box`).toContain('md:min-w-0');
    }
  });
});

/**
 * The pulse strip in the cockpit: one per project tile (the 「全部项目」 view), and the same
 * component at the top of a board's Quay panel. The two surfaces must address the TASK a mark
 * names, with the fleet registry id as the project segment — the board's rail already declares
 * those tasks, so activating a mark there moves focus to the declared object.
 */
describe('pulse strip', () => {
  it('draws a strip at the foot of every tile that reported a pulse reading', async () => {
    renderCockpit('/cockpit?view=fleet');

    const strips = await screen.findAllByTestId('cockpit-fleet-tile-pulse');
    // Only p1 carries a reading in the fixture; the others must not invent an empty (idle) one.
    expect(strips).toHaveLength(1);

    const tile = screen.getAllByTestId('cockpit-fleet-tile')[0];
    expect(within(tile).getByTestId('cockpit-fleet-pulse-p1')).toBeTruthy();
    expect(within(tile).getByTestId('cockpit-fleet-pulse-p1-inflight-line')).toBeTruthy();
    // The blocked segment's end label is the impact reading: one task is waiting.
    expect(within(tile).getByTestId('cockpit-fleet-pulse-p1-blocker-impact').textContent).toContain('⛔ 1');
  });

  it('a fleet tile mark asks to focus the task URI it names, not the tile’s board', async () => {
    renderCockpit('/cockpit?view=fleet');

    const line = await screen.findByTestId('cockpit-fleet-pulse-p1-inflight-line');
    const before = sentEvents('focus').length;
    fireEvent.click(line);

    const focuses = sentEvents('focus').slice(before);
    expect(focuses.map((event) => event.uri)).toEqual(['quay://claudecodeui/task/task-live']);
  });

  it('clicking a mark on the board’s strip focuses that task (its declared address)', async () => {
    // Two in-flight tasks: the rail focuses the first on load, so clicking the second's pulse
    // line is observable as a focus CHANGE rather than a no-op that already held.
    const twoTasks: QuaySnapshot = {
      ...SNAPSHOT,
      inFlight: [
        ...(SNAPSHOT.inFlight ?? []),
        {
          taskId: 'task-b',
          phase: 'fan-in',
          startedAt: '2026-10-22T22:00:00.000Z',
          lastHeartbeat: '2026-10-22T23:58:00.000Z',
          workerPid: 4321,
        },
      ],
    };
    apiMock.quaySnapshot.mockResolvedValue(okResponse(twoTasks));

    renderCockpit('/cockpit?view=board&project=p1');

    await screen.findByTestId('cockpit-board-rail');
    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/task/task-a'));

    const lines = await screen.findAllByTestId('quay-panel-pulse-strip-inflight-line');
    const second = lines.find((line) => line.getAttribute('data-phase') === 'fan-in');
    expect(second).toBeTruthy();
    fireEvent.click(second!);

    await waitFor(() => expect(focusUri()).toBe('quay://claudecodeui/task/task-b'));
  });
});
