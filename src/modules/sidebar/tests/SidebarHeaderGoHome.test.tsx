import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { TFunction } from 'i18next';

import SidebarHeader from '@/modules/sidebar/SidebarHeader';

// The badge fetches GitHub stars on mount; the home-navigation cases do not care
// about it, so it renders nothing here rather than a live request.
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
  awaitingReplyCount: 0,
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
  t,
});

test('the wordmark is a home link and clicking it clears the selection', () => {
  const onGoHome = vi.fn();
  const { container } = render(<SidebarHeader {...baseProps()} onGoHome={onGoHome} />);

  // The desktop and mobile headers both draw the wordmark; each is a home link.
  const links = container.querySelectorAll('[data-sidebar-go-home]');
  assert.equal(links.length, 2, 'desktop and mobile wordmarks must both be home links');

  fireEvent.click(links[0]);
  fireEvent.click(links[1]);
  assert.equal(onGoHome.mock.calls.length, 2);
});

test('the mobile drawer exposes a labelled overview entry that also goes home', () => {
  const onGoHome = vi.fn();
  const { container } = render(<SidebarHeader {...baseProps()} onGoHome={onGoHome} />);

  const entry = container.querySelector('[data-sidebar-overview-entry]');
  assert.ok(entry, 'the mobile drawer must carry an overview entry');

  fireEvent.click(entry);
  assert.equal(onGoHome.mock.calls.length, 1);
});

test('the wordmark renders the Cloudpit logo, not the old MessageSquare mark', () => {
  const { container } = render(<SidebarHeader {...baseProps()} onGoHome={() => {}} />);

  const logos = container.querySelectorAll('img[src="/logo.svg"]');
  assert.ok(logos.length >= 1, 'the sidebar header must render the Cloudpit logo');

  for (const logo of Array.from(logos)) {
    assert.equal(logo.getAttribute('alt'), 'Cloudpit', 'the logo alt text must name the product');
  }

  // Scope the old-mark check to the logo block: the header still legitimately uses
  // MessageSquare lucide icons for the search-mode tabs.
  const logoBlock = logos[0].closest('div');
  assert.ok(logoBlock, 'the logo must sit in a container');
  assert.ok(
    !logoBlock.querySelector('svg'),
    'the logo block must render the image, not the old inline chat-bubble mark',
  );
});
