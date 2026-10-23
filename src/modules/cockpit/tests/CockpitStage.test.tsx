import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuayFleetSummary, QuaySnapshot } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import CockpitPage from '@/modules/cockpit/CockpitPage';
import { formatCockpitView, parseCockpitView } from '@/modules/cockpit/cockpitView';
import type { CockpitView } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit stage in a real router: what it declares, how focus moves, how Enter/Backspace
 * change the view, and how the URL and the view description round-trip.
 *
 * Only the network hop is stubbed (`@/shared/api`); the page, the focus hook, the fleet
 * projection, quay's in-flight contract and `useQuayStatus` all run for real.
 */

const apiMock = vi.hoisted(() => ({
  quayFleetSummary: vi.fn(),
  quaySnapshot: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: apiMock }));

const FLEET: QuayFleetSummary = {
  projects: [
    {
      projectId: 'p1',
      // The project segment every address carries is the FLEET registry id, never this id.
      fleetProjectId: 'claudecodeui',
      projectPath: '/work/claudecodeui',
      driver: { state: 'running' },
      tasks: { total: 4, todo: 1, ready: 2, needsHuman: 1, done: 0 },
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

function renderCockpit(initialPath = '/cockpit') {
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
const focusUri = () => screen.getByTestId('cockpit-focus').getAttribute('data-cockpit-focus');

/** The focusable declaration a rendered view publishes, parsed from its own attribute. */
function declaredFocusables(container: HTMLElement): Array<{ uri: string; label: string }> {
  const holder = container.matches('[data-cockpit-focusables]')
    ? container
    : container.querySelector('[data-cockpit-focusables]');
  expect(holder).not.toBeNull();
  return JSON.parse(holder?.getAttribute('data-cockpit-focusables') ?? '[]') as Array<{
    uri: string;
    label: string;
  }>;
}

beforeEach(() => {
  apiMock.quayFleetSummary.mockReset();
  apiMock.quaySnapshot.mockReset();
  apiMock.quayFleetSummary.mockResolvedValue(okResponse(FLEET));
  apiMock.quaySnapshot.mockResolvedValue(okResponse(SNAPSHOT));
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

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(focusUri()).toBe('quay://quay-fleet/board');
  });

  it('moves focus by direction key in spatial order and clamps at both ends', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    // Focus starts on the first declared object (the contract's own spatial order).
    expect(focusUri()).toBe('quay://claudecodeui/board');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(focusUri()).toBe('quay://quay-fleet/board');

    // Past the last declared object the focus stays put instead of wrapping or leaving the set
    // (the third project is unregistered and declares nothing to land on).
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(focusUri()).toBe('quay://quay-fleet/board');

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(focusUri()).toBe('quay://claudecodeui/board');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(focusUri()).toBe('quay://claudecodeui/board');
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

describe('view changes and history', () => {
  it('Enter on a project opens its board, and Backspace returns to the fleet', async () => {
    renderCockpit();
    await screen.findByTestId('cockpit-fleet-tiles');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=p2'));
    await screen.findByTestId('cockpit-board');
    expect(apiMock.quaySnapshot.mock.calls[0]?.[0]).toBe('p2');

    fireEvent.keyDown(window, { key: 'Backspace' });

    await waitFor(() => expect(locationSearch()).toBe('?view=fleet'));
    await screen.findByTestId('cockpit-fleet-tiles');
  });

  it('round-trips the view description through the URL', () => {
    const views: CockpitView[] = [
      { type: 'fleet' },
      { type: 'board', project: 'p1' },
      { type: 'board', project: 'p 1/x' },
    ];

    for (const view of views) {
      expect(parseCockpitView(formatCockpitView(view))).toEqual(view);
    }
    // A malformed URL still lands on a usable stage rather than throwing or blanking.
    expect(parseCockpitView('?view=board')).toEqual({ type: 'fleet' });
    expect(parseCockpitView('')).toEqual({ type: 'fleet' });
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

    renderCockpit('/cockpit?view=board&project=p1');

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

    const textarea = screen
      .getByTestId('cockpit-input')
      .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
    textarea.focus();

    // The stage must not move focus while the input has it.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(focusUri()).toBe('quay://claudecodeui/board');

    fireEvent.change(textarea, { target: { value: '看 claudecodeui' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(locationSearch()).toBe('?view=board&project=p1'));

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

    const textarea = screen
      .getByTestId('cockpit-input')
      .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '今天天气不错' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const unmatched = await screen.findByTestId('cockpit-intent-unmatched');
    expect(unmatched.textContent).toContain('今天天气不错');
    // No guess — and therefore no navigation: the stage stays on the fleet it was showing.
    expect(locationSearch()).toBe('');
  });
});
