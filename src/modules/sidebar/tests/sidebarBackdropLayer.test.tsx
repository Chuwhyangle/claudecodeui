import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { test, vi } from 'vitest';

import enSidebar from '@/modules/i18n/locales/en/sidebar.json';

/**
 * The sidebar's frosted pane is a layer of its own, it is empty, and the blur is
 * only worn while nothing is running.
 *
 * A `backdrop-filter` is re-evaluated whenever the framebuffer under it changes.
 * The sidebar's running-session rows carry a spinner for as long as a turn runs,
 * so while the filter sat on the panel root the GPU process re-blurred the whole
 * pane every frame — measured at ~30% of one core on a single running session.
 * Moving the filter to an empty layer is not enough on its own (the spinner is
 * painted above it and still changes the frame); the filter also has to be off
 * while a turn is live. This test reads that shape directly, in both states.
 *
 * `parentElement === panel` is part of the invariant, not incidental: wrapping
 * the content inside the layer would put every animated row back inside the
 * filter and reintroduce the cost while still satisfying "a layer exists".
 *
 * The children are stubbed because they are not what this file measures; the
 * shell — the panel element, its classes and the layer — is the subject.
 */

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => null }));

const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  defaultNS: 'sidebar',
  resources: { en: { sidebar: enSidebar } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof SidebarContent>['t'];

const PANEL_ID = 'sidebar-panel';
const ANIMATED_CLASSES = '.animate-spin, .animate-pulse, .animate-shimmer, .animate-bounce';
const noop = () => {};

/** Every prop SidebarContent requires; `runningSessionsCount` is the state this file flips. */
const sidebarProps = (runningSessionsCount: number): React.ComponentProps<typeof SidebarContent> => ({
  isPWA: false,
  isMobile: false,
  isLoading: false,
  projects: [],
  runningSessionsCount,
  archivedProjects: [],
  archivedSessions: [],
  archivedSessionsCount: 0,
  isArchivedSessionsLoading: false,
  recentConversations: [],
  recentConversationsTotal: 0,
  recentConversationsHasMore: false,
  isRecentConversationsLoading: false,
  isLoadingMoreRecentConversations: false,
  recentConversationsError: false,
  searchFilter: '',
  onSearchFilterChange: noop,
  onClearSearchFilter: noop,
  searchMode: 'projects',
  onSearchModeChange: noop,
  conversationResults: null,
  isSearching: false,
  searchProgress: null,
  onRestoreArchivedProject: noop,
  onLoadMoreRecentConversations: noop,
  onRetryRecentConversations: noop,
  onArchivedSessionClick: noop,
  onRestoreArchivedSession: noop,
  onDeleteArchivedSession: noop,
  onConversationResultClick: noop,
  onRefresh: noop,
  isRefreshing: false,
  onCreateProject: noop,
  onCollapseSidebar: noop,
  onGoHome: noop,
  updateAvailable: false,
  restartRequired: false,
  releaseInfo: null,
  latestVersion: null,
  currentVersion: '1.0.0',
  onShowVersionModal: noop,
  onShowSettings: noop,
  projectListProps: { currentTime: new Date(), activeRename: null } as never,
  t,
});

type Reading = {
  layerCount: number;
  layerIsDirectChild: boolean;
  layerHasBlur: boolean;
  blurLayerChildren: number;
  blurAnimatedDescendants: number;
  backdropBlurOnRoot: boolean;
  otherBackdropContainers: number;
  rootIsolates: boolean;
};

/** Renders the shell and reads the five facts this criterion pins, without asserting any of them. */
const readSidebar = (runningSessionsCount: number): Reading => {
  const view = render(React.createElement(SidebarContent, sidebarProps(runningSessionsCount)));
  const panel = view.container.querySelector<HTMLElement>(`#${PANEL_ID}`);
  assert.ok(panel, `SidebarContent must render the #${PANEL_ID} panel`);

  const layers = panel.querySelectorAll<HTMLElement>('[data-sidebar-backdrop]');
  const layer = layers[0] ?? null;
  const otherBackdropContainers = [...panel.querySelectorAll<HTMLElement>('[class*="backdrop-blur"]')]
    .filter((element) => element !== layer);
  const rootClass = panel.getAttribute('class') ?? '';

  return {
    layerCount: layers.length,
    layerIsDirectChild: layer?.parentElement === panel,
    layerHasBlur: (layer?.getAttribute('class') ?? '').includes('backdrop-blur'),
    blurLayerChildren: layer?.childElementCount ?? -1,
    blurAnimatedDescendants: layer?.querySelectorAll(ANIMATED_CLASSES).length ?? -1,
    backdropBlurOnRoot: rootClass.includes('backdrop-blur'),
    otherBackdropContainers: otherBackdropContainers.length,
    rootIsolates: rootClass.split(/\s+/).includes('isolate'),
  };
};

const assertShell = (reading: Reading, what: string): void => {
  assert.equal(reading.layerCount, 1, `${what}: exactly one backdrop layer must exist`);
  assert.equal(reading.layerIsDirectChild, true, `${what}: the layer must be a sibling of the content, not its wrapper`);
  assert.equal(reading.blurLayerChildren, 0, `${what}: the blur layer must hold no children`);
  assert.equal(reading.blurAnimatedDescendants, 0, `${what}: no animation may live inside the blur layer`);
  assert.equal(reading.backdropBlurOnRoot, false, `${what}: the panel root must not carry backdrop-blur`);
  assert.equal(reading.otherBackdropContainers, 0, `${what}: no other backdrop-filter container may wrap the content`);
  assert.equal(reading.rootIsolates, true, `${what}: the root must isolate so the negative-z layer stays behind the content`);
};

test('with a turn running the layer exists but wears no blur', () => {
  const running = readSidebar(1);
  console.log(
    `runningBlur=${running.layerHasBlur} blurLayerChildren=${running.blurLayerChildren} blurAnimatedDescendants=${running.blurAnimatedDescendants} backdropBlurOnRoot=${running.backdropBlurOnRoot}`,
  );
  assertShell(running, 'running');
  assert.equal(running.layerHasBlur, false, 'a live turn must not pay for a backdrop blur');
});

test('with nothing running the same empty layer wears the blur', () => {
  const idle = readSidebar(0);
  console.log(
    `idleBlur=${idle.layerHasBlur} blurLayerChildren=${idle.blurLayerChildren} blurAnimatedDescendants=${idle.blurAnimatedDescendants} backdropBlurOnRoot=${idle.backdropBlurOnRoot}`,
  );
  assertShell(idle, 'idle');
  assert.equal(idle.layerHasBlur, true, 'the frosted pane must still be drawn at rest');
});
