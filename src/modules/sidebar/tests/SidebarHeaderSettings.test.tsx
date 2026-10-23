import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { TFunction } from 'i18next';

import SidebarHeader from '@/modules/sidebar/SidebarHeader';

// The badge fetches GitHub stars on mount; the settings cases do not care about
// it, so it renders nothing here rather than a live request.
vi.mock('@/modules/sidebar/GitHubStarBadge', () => ({
  default: () => null,
}));

/** The header's copy is not under test; a key-echoing `t` keeps the fixture small. */
const t = ((key: string) => key) as unknown as TFunction;

const baseProps = () => ({
  isPWA: false,
  isMobile: false,
  isLoading: false,
  projectsCount: 3,
  runningSessionsCount: 1,
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
  onGoHome: () => {},
  t,
});

test('the desktop and mobile headers each expose one settings icon that opens settings once', () => {
  const onShowSettings = vi.fn();
  const { container } = render(<SidebarHeader {...baseProps()} onShowSettings={onShowSettings} />);

  // The two headers are both in the DOM; the md: prefixed classes select which
  // one a viewport draws. Assert one settings button inside each.
  const desktopSettings = container.querySelector(
    '.md\\:block button[aria-label="actions.settings"]',
  );
  const mobileSettings = container.querySelector(
    '.md\\:hidden button[aria-label="actions.settings"]',
  );
  assert.ok(desktopSettings, 'the desktop header must draw a settings icon button');
  assert.ok(mobileSettings, 'the mobile header must draw a settings icon button');

  fireEvent.click(desktopSettings);
  assert.equal(onShowSettings.mock.calls.length, 1, 'desktop settings must call onShowSettings once');

  fireEvent.click(mobileSettings);
  assert.equal(onShowSettings.mock.calls.length, 2, 'mobile settings must call onShowSettings once');
});
