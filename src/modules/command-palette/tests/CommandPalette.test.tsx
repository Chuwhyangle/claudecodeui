import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { COCKPIT_PATH } from '@/modules/cockpit';
import CommandPalette from '@/modules/command-palette/CommandPalette';

/**
 * The command palette's cockpit commands.
 *
 * The whole palette renders; every data source and the theme store are stubbed at their
 * hook seams. What is under test is the command list itself — including that the existing
 * actions are still there — and the two destinations: in-app navigation, and a new window
 * carrying the router's href.
 */

vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({
  useSessionsSource: () => [],
}));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({
  useSessionMessageSearch: () => [],
}));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({ useFilesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({ useBranchesSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({
  useGitActions: () => ({
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    checkout: vi.fn(),
  }),
}));
const featuresMock = vi.hoisted(() => ({ cockpitEnabled: true }));
vi.mock('@/shared/hooks/useServerFeatures', () => ({
  useServerFeatures: () => ({ status: 'loaded' as const, cockpitEnabled: featuresMock.cockpitEnabled }),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: vi.fn() }),
}));

// jsdom ships neither API that cmdk's list subscribes to on mount.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

/** Reports the router location, so a command's destination is asserted from the URL. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-pathname={location.pathname} />;
}

function renderPalette() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <CommandPalette
          selectedProject={null}
          onStartNewChat={() => {}}
          onOpenSettings={() => {}}
          onShowTab={() => {}}
        />
        <LocationProbe />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

/** Ctrl+K is the palette's own opener; using it keeps the test off internal state. */
async function openPalette() {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  await waitFor(() =>
    expect(screen.queryByPlaceholderText(i18n.t('commandPalette.searchAnything'))).not.toBeNull(),
  );
}

beforeEach(async () => {
  featuresMock.cockpitEnabled = true;
  await i18n.changeLanguage('en');
});

test('the palette command path stays pinned to the cockpit module’s own route', () => {
  // The palette spells its path as a local literal to avoid a command-palette ⇄ cockpit barrel
  // cycle; this pin is what keeps the literal from drifting away from the cockpit's route.
  expect(COCKPIT_PATH).toBe('/cockpit');
});

test('lists 「打开驾驶舱」 and 「在新窗口打开驾驶舱」 without dropping the existing actions', async () => {
  renderPalette();
  await openPalette();

  expect(screen.getByText(i18n.t('cockpit.openCockpit'))).not.toBeNull();
  expect(screen.getByText(i18n.t('cockpit.openCockpitNewWindow'))).not.toBeNull();
  // The pre-existing actions are untouched: adding the cockpit commands must not replace them.
  expect(screen.getByText(i18n.t('commandPalette.openSettings'))).not.toBeNull();
  expect(screen.getByText(i18n.t('commandPalette.toggleTheme'))).not.toBeNull();
  expect(screen.getByText(i18n.t('commandPalette.startNewChat'))).not.toBeNull();
});

test('「打开驾驶舱」 routes this window to the cockpit', async () => {
  renderPalette();
  await openPalette();

  fireEvent.click(screen.getByText(i18n.t('cockpit.openCockpit')));

  await waitFor(() =>
    expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe('/cockpit'),
  );
});

test('「在新窗口打开驾驶舱」 opens the basename-aware cockpit URL in another window', async () => {
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  try {
    renderPalette();
    await openPalette();

    fireEvent.click(screen.getByText(i18n.t('cockpit.openCockpitNewWindow')));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[0]).toBe('/cockpit');
    expect(openSpy.mock.calls[0]?.[1]).toBe('_blank');
    // The current window did NOT navigate away from the session list.
    expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe('/');
  } finally {
    openSpy.mockRestore();
  }
});

test('with the cockpit switched off the palette lists no cockpit command', async () => {
  featuresMock.cockpitEnabled = false;
  renderPalette();
  await openPalette();

  expect(screen.queryByText(i18n.t('cockpit.openCockpit'))).toBeNull();
  expect(screen.queryByText(i18n.t('cockpit.openCockpitNewWindow'))).toBeNull();
  // The rest of the action list is untouched.
  expect(screen.getByText(i18n.t('commandPalette.openSettings'))).not.toBeNull();
  expect(screen.getByText(i18n.t('commandPalette.startNewChat'))).not.toBeNull();
});
