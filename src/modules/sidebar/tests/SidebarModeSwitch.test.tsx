import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

/**
 * The sidebar's 「会话 / 驾驶舱」 switch and its attention badge.
 *
 * The REAL store (`useFleetTaskCounts`/`useFleetAttention`), the real header, the real
 * collapsed rail and the real component run; only the fleet transport is replaced. Every
 * case re-imports the modules after `vi.resetModules()` because the store is module-level:
 * without that reset one case's fleet reading would leak into the next.
 */

const apiMock = vi.hoisted(() => ({ quayFleetSummary: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: { ...(actual.api as Record<string, unknown>), quayFleetSummary: apiMock.quayFleetSummary },
  };
});

// The star badge fetches GitHub on mount; the switch cases do not care about it.
vi.mock('@/modules/sidebar/GitHubStarBadge', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));

const project = (
  projectId: string,
  fleetProjectId: string | null,
  needsHuman: number,
) => ({
  projectId,
  ...(fleetProjectId === null ? {} : { fleetProjectId }),
  projectPath: `/work/${projectId}`,
  driver: { state: 'idle' as const },
  tasks: { total: needsHuman, todo: 0, ready: 0, needsHuman, done: 0 },
  cached: false,
  error: null,
});

/** Three needs-human items across two registered projects: the badge's AC fixture. */
const fleetSummary = (needsHuman: number, state: 'ok' | 'missing' = 'ok', reason: string | null = null) => ({
  projects: [
    project('p1', 'claudecodeui', needsHuman),
    project('p2', 'quay-fleet', 0),
    project('p3', null, 7),
  ],
  fleet: { available: state === 'ok', reason, state },
  generatedAt: '2026-10-24T00:00:00.000Z',
  ttlPerProjectMs: 120_000,
  cached: false,
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const headerProps = (selectedProjectId: string | null, t: TFunction) => ({
  isPWA: false,
  isMobile: false,
  isLoading: false,
  projectsCount: 3,
  runningSessionsCount: 0,
  archivedSessionsCount: 0,
  isArchivedSessionsLoading: false,
  searchFilter: '',
  onSearchFilterChange: () => {},
  onClearSearchFilter: () => {},
  searchMode: 'projects' as const,
  onSearchModeChange: () => {},
  onRefresh: () => {},
  isRefreshing: false,
  onCreateProject: () => {},
  onCollapseSidebar: () => {},
  onShowSettings: () => {},
  selectedProjectId,
  onGoHome: () => {},
  t,
});

async function loadModules() {
  const { i18n } = await import('@/modules/i18n');
  await i18n.changeLanguage('en');
  // Sequential, not Promise.all: the sidebar and cockpit barrels reference each other (the
  // switch lives here, the path grammar there), and vitest's module runner deadlocks when two
  // installments of that cycle are imported concurrently.
  const { default: SidebarHeader } = await import('@/modules/sidebar/SidebarHeader');
  const { default: SidebarCollapsed } = await import('@/modules/sidebar/SidebarCollapsed');
  const { default: SidebarModeSwitch } = await import('@/modules/sidebar/SidebarModeSwitch');
  return { i18n, t: i18n.t.bind(i18n) as unknown as TFunction, SidebarHeader, SidebarCollapsed, SidebarModeSwitch };
}

beforeEach(() => {
  apiMock.quayFleetSummary.mockReset();
  apiMock.quayFleetSummary.mockImplementation(async () => okResponse(fleetSummary(3)));
  vi.resetModules();
});

// The first case pays the fresh-transform cost of importing the whole sidebar graph; the
// default 5s budget is for behaviour, not for module installation.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.useRealTimers();
});

describe('AC1: one two-segment control, in every sidebar layout', () => {
  test('sits before the settings button, uses basename-aware hrefs and marks the active segment', async () => {
    const { i18n, t, SidebarHeader } = await loadModules();

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter basename="/ccui" initialEntries={['/ccui']}>
          <SidebarHeader {...headerProps('p1', t)} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    const desktop = container.querySelector('.md\\:block') as HTMLElement;
    assert.ok(desktop, 'the desktop header must be in the DOM');

    // The switch is the first control in the header's right-hand cluster, immediately before
    // settings — not an appended extra after the other actions.
    const ordered = Array.from(
      desktop.querySelectorAll(
        '[data-testid="sidebar-mode-switch"], button[aria-label="actions.settings"]',
      ),
    );
    assert.equal(ordered.length, 2, 'the desktop header draws exactly one switch and one settings button');
    assert.equal(ordered[0]?.getAttribute('data-testid'), 'sidebar-mode-switch');
    assert.equal(ordered[1]?.getAttribute('aria-label'), 'actions.settings');

    const sessions = desktop.querySelector('[data-mode-switch-link="sessions"]') as HTMLAnchorElement;
    const cockpit = desktop.querySelector('[data-mode-switch-link="cockpit"]') as HTMLAnchorElement;
    assert.ok(sessions, 'the sessions segment must be a real link');
    assert.ok(cockpit, 'the cockpit segment must be a real link');

    // Both hrefs carry the deployment basename the router was mounted under.
    assert.equal(sessions.getAttribute('href'), '/ccui');
    assert.ok(
      cockpit.getAttribute('href')?.startsWith('/ccui/cockpit'),
      `cockpit href must start with /ccui/cockpit, got ${cockpit.getAttribute('href')}`,
    );
    // ...and the selected, REGISTERED project turns the cockpit link into its board, addressed
    // by the fleet registry id (never the CloudCLI project id). The fleet reading arrives after
    // the first render, so the link settles once the store publishes it.
    await waitFor(() =>
      assert.match(cockpit.getAttribute('href') ?? '', /project=claudecodeui/),
    );
    assert.match(cockpit.getAttribute('href') ?? '', /view=board/);
    assert.doesNotMatch(cockpit.getAttribute('href') ?? '', /project=p1/);

    // Exactly the current mode's segment is announced as the current page.
    assert.equal(sessions.getAttribute('aria-current'), 'page');
    assert.equal(cockpit.hasAttribute('aria-current'), false);
  });

  test('an unregistered project falls back to the fleet view instead of inventing a board', async () => {
    const { i18n, t, SidebarHeader } = await loadModules();

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter basename="/ccui" initialEntries={['/ccui']}>
          <SidebarHeader {...headerProps('p3', t)} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    const cockpit = container.querySelector(
      '.md\\:block [data-mode-switch-link="cockpit"]',
    ) as HTMLAnchorElement;
    assert.ok(cockpit);
    assert.equal(cockpit.getAttribute('href'), '/ccui/cockpit?view=fleet');
  });

  test('the collapsed rail and the mobile drawer both render the control', async () => {
    const { i18n, t, SidebarHeader, SidebarCollapsed } = await loadModules();

    const header = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter basename="/ccui" initialEntries={['/ccui']}>
          <SidebarHeader {...headerProps(null, t)} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    // Two switches in one header: the desktop block and the md:hidden mobile drawer.
    assert.equal(header.container.querySelectorAll('[data-testid="sidebar-mode-switch"]').length, 2);
    assert.ok(header.container.querySelector('.md\\:hidden [data-testid="sidebar-mode-switch"]'));
    header.unmount();

    const collapsed = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter basename="/ccui" initialEntries={['/ccui']}>
          <SidebarCollapsed
            onExpand={() => {}}
            onShowSettings={() => {}}
            updateAvailable={false}
            restartRequired={false}
            onShowVersionModal={() => {}}
            t={t}
          />
        </MemoryRouter>
      </I18nextProvider>,
    );
    const railSwitch = collapsed.container.querySelector('[data-testid="sidebar-mode-switch"]');
    assert.ok(railSwitch, 'the collapsed rail must draw the switch');
    assert.equal(railSwitch.getAttribute('data-layout'), 'column');
  });
});

describe('AC2: the needs-human attention badge', () => {
  test('shows the fleet-wide total and names it for assistive technology', async () => {
    const { i18n, t, SidebarHeader } = await loadModules();

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter basename="/ccui" initialEntries={['/ccui']}>
          <SidebarHeader {...headerProps(null, t)} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await waitFor(() => assert.notEqual(container.querySelector('[data-testid="cockpit-attention-badge"]'), null));
    const badges = Array.from(container.querySelectorAll('[data-testid="cockpit-attention-badge"]'));
    for (const badge of badges) {
      assert.equal(badge.textContent, '3', 'the badge prints the summed needs-human count');
      assert.equal(
        badge.getAttribute('aria-label'),
        i18n.t('cockpit.attentionBadge', { n: 3 }),
        'the accessible name carries the unit, not just the digit',
      );
    }

    // No locator problem: nothing warns.
    assert.equal(container.querySelector('[data-testid="cockpit-attention-dot"]'), null);
  });

  test('draws no number when nothing needs a person', async () => {
    apiMock.quayFleetSummary.mockImplementation(async () => okResponse(fleetSummary(0)));
    const { i18n, t, SidebarModeSwitch } = await loadModules();

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SidebarModeSwitch mode="sessions" t={t} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await waitFor(() => assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1));
    assert.equal(container.querySelector('[data-testid="cockpit-attention-badge"]'), null);
  });

  test('a fleet whose locator is missing draws a grey dot whose tooltip states the reason', async () => {
    apiMock.quayFleetSummary.mockImplementation(async () =>
      okResponse(fleetSummary(0, 'missing', 'quay-fleet was not found')),
    );
    const { i18n, t, SidebarModeSwitch } = await loadModules();

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SidebarModeSwitch mode="sessions" t={t} />
        </MemoryRouter>
      </I18nextProvider>,
    );

    await waitFor(() => assert.notEqual(container.querySelector('[data-testid="cockpit-attention-dot"]'), null));
    const dot = container.querySelector('[data-testid="cockpit-attention-dot"]') as HTMLElement;
    assert.equal(
      dot.getAttribute('title'),
      i18n.t('cockpit.attentionUnavailable', { reason: 'quay-fleet was not found' }),
    );
    assert.match(dot.getAttribute('title') ?? '', /quay-fleet was not found/);
  });

  test('a hidden page polls nothing; becoming visible reads immediately and resumes the cadence', async () => {
    vi.useFakeTimers();
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

    try {
      const { i18n, t, SidebarModeSwitch } = await loadModules();
      render(
        <I18nextProvider i18n={i18n}>
          <SidebarModeSwitch mode="sessions" t={t} />
        </I18nextProvider>,
      );

      // Hidden at mount: not even the initial read happens.
      assert.equal(apiMock.quayFleetSummary.mock.calls.length, 0);
      await act(async () => {
        vi.advanceTimersByTime(180_000);
      });
      assert.equal(
        apiMock.quayFleetSummary.mock.calls.length,
        0,
        'three polling intervals passed but a hidden page must issue no request',
      );

      hidden = false;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1, 'returning to the tab reads once');

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      assert.equal(apiMock.quayFleetSummary.mock.calls.length, 2, 'the 60-second cadence resumes');
    } finally {
      if (hiddenDescriptor === undefined) {
        delete (document as unknown as { hidden?: boolean }).hidden;
      } else {
        Object.defineProperty(document, 'hidden', hiddenDescriptor);
      }
    }
  });
});
