import assert from 'node:assert/strict';

import { act, fireEvent, render, within } from '@testing-library/react';
import i18next from 'i18next';
import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';
import enCommon from '@/modules/i18n/locales/en/common.json';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';

/**
 * The mobile header used to stack "menu + title" over a horizontally scrolling
 * `role="tablist"` (94px at 390×844), and its responsive classes moved at `sm`
 * (640px) while `useDeviceSettings` called anything under 768px mobile — so
 * 640–767px had a mobile menu button beside a desktop tab bar. These cases pin
 * the two halves of the fix: below 768px there is no tablist at all, only a
 * single trigger that opens the workspace picker dialog and must keep every
 * enabled plugin reachable, and above it the tablist and its keyboard behaviour
 * are unchanged.
 *
 * The dialog cases assert through `document.activeElement` and the rendered entry
 * list rather than through props, because focus return and "no workspace
 * disappeared" are exactly what a collapse of the tab bar can silently break.
 */

const { PLUGINS, ENABLED_PLUGIN_COUNT } = vi.hoisted(() => {
  const makePlugin = (index: number, enabled: boolean) => ({
    name: `probe-${index}`,
    displayName: `Probe Workspace ${index}`,
    version: '1.0.0',
    description: `probe plugin ${index}`,
    author: 'probe',
    icon: 'icon.svg',
    type: 'module' as const,
    slot: 'tab' as const,
    entry: 'index.js',
    server: null,
    permissions: [],
    enabled,
    serverRunning: false,
    dirName: `probe-${index}`,
    repoUrl: null,
  });

  return {
    PLUGINS: [
      ...Array.from({ length: 12 }, (_, i) => makePlugin(i + 1, true)),
      // Disabled plugins are the reverse control: the list must filter, not merely render.
      ...Array.from({ length: 2 }, (_, i) => makePlugin(13 + i, false)),
    ],
    ENABLED_PLUGIN_COUNT: 12,
  };
});

// The pulse trigger polls the lanes endpoint whenever the Quay tab is offered. These cases are
// about layout (and about the trigger's own visibility gate), so the network hop answers an
// empty, successful reading; the mocks are spies so the gate case can count calls.
const apiMock = vi.hoisted(() => ({ quayLanes: vi.fn(), quaySessionMentions: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: apiMock }));

beforeEach(() => {
  apiMock.quayLanes.mockReset();
  apiMock.quaySessionMentions.mockReset();
  apiMock.quayLanes.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, gantt: null, ganttUnavailable: 'lanes-read-failed', generatedAt: '' }),
  });
  apiMock.quaySessionMentions.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessionId: 's', projectId: 'p', tasks: [], goals: [], generatedAt: '' }),
  });
});

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({
    plugins: PLUGINS,
    loading: false,
    pluginsError: null,
    refreshPlugins: async () => {},
    installPlugin: async () => ({ success: true }),
    uninstallPlugin: async () => ({ success: true }),
    updatePlugin: async () => ({ success: true }),
    togglePlugin: async () => ({ success: true, error: null }),
  }),
  // The real icon fetches a per-plugin SVG; the cases below are about which
  // workspaces are listed, so the icon renders nothing.
  PluginIcon: () => null,
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// jsdom ships no ResizeObserver, and the desktop tab strip observes its own
// overflow to decide whether the scroll gradients and arrows are shown.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom also ships no scrollIntoView, and the header scrolls its active tab into view from a
// requestAnimationFrame — which lands after the awaited assertions in the gate case.
Element.prototype.scrollIntoView = () => {};

const BUILT_IN_NAMES = ['Chat', 'Shell', 'Files', 'Source Control'];
const CONDITIONAL_NAMES = ['Browser', 'Tasks'];
const ENABLED_PLUGIN_NAMES = Array.from({ length: ENABLED_PLUGIN_COUNT }, (_, i) => `Probe Workspace ${i + 1}`);
const DISABLED_PLUGIN_NAMES = ['Probe Workspace 13', 'Probe Workspace 14'];

const PROJECT: Project = {
  projectId: 'mobile-layout-probe',
  displayName: '移动端布局探针项目名称',
  fullPath: '/home/odoo/workspace/mobile-layout-probe',
};

type HarnessProps = {
  isMobile: boolean;
  shouldShowTasksTab?: boolean;
  shouldShowQuayTab?: boolean;
  shouldShowBrowserTab?: boolean;
  onSetActiveTab?: (update: SetStateAction<AppTab>) => void;
};

/**
 * Mounts the real header with a live active tab, so the keyboard case and the
 * dialog-selection case both exercise the header's own wiring rather than a
 * stubbed setter that would let a broken selection path still look correct.
 */
function HeaderHarness({
  isMobile,
  shouldShowTasksTab = false,
  shouldShowQuayTab = false,
  shouldShowBrowserTab = false,
  onSetActiveTab,
}: HarnessProps) {
  const [activeTab, setActiveTab] = useState<AppTab>('chat');

  const handleSetActiveTab = useCallback<Dispatch<SetStateAction<AppTab>>>((update) => {
    onSetActiveTab?.(update);
    setActiveTab(update);
  }, [onSetActiveTab]);

  return (
    <WorkspaceHeader
      activeTab={activeTab}
      setActiveTab={handleSetActiveTab}
      selectedProject={PROJECT}
      selectedSession={null}
      shouldShowTasksTab={shouldShowTasksTab}
      shouldShowQuayTab={shouldShowQuayTab}
      shouldShowBrowserTab={shouldShowBrowserTab}
      isMobile={isMobile}
      onMenuClick={() => {}}
    />
  );
}

/** The name a screen reader computes for a plain element: aria-label wins, otherwise its text. */
const accessibleName = (element: Element): string =>
  element.getAttribute('aria-label') ?? (element.textContent ?? '').trim();

/** Every button's accessible name in document order — printed in failures so a wrong list is readable. */
const buttonNames = (): string[] => Array.from(document.querySelectorAll('button')).map(accessibleName);

const focusedName = (): string => {
  const active = document.activeElement;
  return active ? `${active.tagName.toLowerCase()} "${accessibleName(active)}"` : '<no activeElement>';
};

// The Quay pulse trigger also announces `aria-haspopup="dialog"`, so the workspace selector is
// identified by its own contract (`data-workspace-tab`) rather than by that attribute alone.
const collapsedTrigger = (): HTMLElement | null =>
  document.querySelector('[data-workspace-tab][aria-haspopup="dialog"]');

const workspaceDialog = (): HTMLElement | null => document.querySelector('[role="dialog"]');

const openWorkspaceDialog = (): { trigger: HTMLElement; panel: HTMLElement } => {
  const trigger = collapsedTrigger();
  assert.ok(trigger, `the mobile header must expose a collapsed trigger; button names were ${JSON.stringify(buttonNames())}`);
  fireEvent.click(trigger);

  const panel = workspaceDialog();
  assert.ok(panel, `clicking the trigger must open the workspace dialog; button names were ${JSON.stringify(buttonNames())}`);
  return { trigger, panel };
};

/** The overlay the Dialog primitive draws behind its panel; clicking it has to close the dialog. */
const dialogOverlay = (panel: HTMLElement): HTMLElement => {
  const overlay = panel.parentElement?.firstElementChild;
  assert.ok(overlay, 'the dialog panel must sit in a wrapper whose first child is the overlay');
  return overlay as HTMLElement;
};

test('desktop keeps the full tablist and renders no collapsed trigger', () => {
  const { getAllByRole } = render(
    <HeaderHarness isMobile={false} shouldShowTasksTab shouldShowBrowserTab />,
  );

  const tabNames = getAllByRole('tab').map(accessibleName);
  const expectedNames = [...BUILT_IN_NAMES, ...CONDITIONAL_NAMES, ...ENABLED_PLUGIN_NAMES];

  assert.deepEqual(
    tabNames,
    expectedNames,
    `desktop must list every built-in, conditional and enabled plugin tab; got ${JSON.stringify(tabNames)}`,
  );
  assert.equal(
    collapsedTrigger(),
    null,
    `desktop must not render the mobile collapsed trigger; button names were ${JSON.stringify(buttonNames())}`,
  );

  // Reverse control: the filter drops disabled plugins instead of listing everything.
  for (const name of DISABLED_PLUGIN_NAMES) {
    assert.ok(
      !tabNames.includes(name),
      `a disabled plugin must not get a tab: "${name}" appeared among ${JSON.stringify(tabNames)}`,
    );
  }
});

test('mobile drops the tablist for a single trigger that reports the active workspace and toggles aria-expanded', () => {
  const { queryAllByRole } = render(
    <HeaderHarness isMobile shouldShowTasksTab shouldShowBrowserTab />,
  );

  assert.equal(
    queryAllByRole('tab').length,
    0,
    `mobile must not render the tablist; button names were ${JSON.stringify(buttonNames())}`,
  );

  const triggers = document.querySelectorAll('[aria-haspopup="dialog"]');
  assert.equal(
    triggers.length,
    1,
    `mobile must render exactly one collapsed trigger; button names were ${JSON.stringify(buttonNames())}`,
  );

  const trigger = triggers[0] as HTMLElement;
  // The label is now carried entirely by `aria-label`: the pulse strip beside the trigger needs
  // the room the visible text used to take, so the button renders icon + chevron only.
  assert.equal(
    (trigger.textContent ?? '').trim(),
    '',
    `the collapsed trigger must show no visible text; it still rendered "${trigger.textContent}"`,
  );
  assert.ok(
    accessibleName(trigger).includes('Chat'),
    `the trigger must name the active workspace; its name was "${accessibleName(trigger)}"`,
  );
  assert.equal(
    trigger.getAttribute('aria-expanded'),
    'false',
    `a closed trigger must report aria-expanded="false"; button names were ${JSON.stringify(buttonNames())}`,
  );

  fireEvent.click(trigger);

  assert.ok(workspaceDialog(), `clicking the trigger must open the dialog; button names were ${JSON.stringify(buttonNames())}`);
  assert.equal(
    trigger.getAttribute('aria-expanded'),
    'true',
    `an open trigger must report aria-expanded="true"; button names were ${JSON.stringify(buttonNames())}`,
  );

  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'closing the dialog must flip aria-expanded back');
  assert.equal(workspaceDialog(), null, 'Escape must close the dialog');
});

test('the mobile dialog lists every built-in, conditional and enabled plugin workspace', () => {
  const { getByRole } = render(
    <HeaderHarness isMobile shouldShowTasksTab shouldShowBrowserTab />,
  );

  const { panel } = openWorkspaceDialog();

  assert.ok(
    getByRole('dialog', { name: 'Workspace views' }),
    'the dialog must be titled from tabs.views so a screen reader announces what opened',
  );

  const entryNames = Array.from(panel.querySelectorAll('button')).map(accessibleName);
  const expectedNames = [...BUILT_IN_NAMES, ...CONDITIONAL_NAMES, ...ENABLED_PLUGIN_NAMES];

  assert.deepEqual(
    entryNames,
    expectedNames,
    `the dialog must list every workspace view, plugins included; got ${JSON.stringify(entryNames)}`,
  );

  for (const name of DISABLED_PLUGIN_NAMES) {
    assert.ok(
      !entryNames.includes(name),
      `a disabled plugin must not appear in the dialog: "${name}" appeared among ${JSON.stringify(entryNames)}`,
    );
  }
});

test('choosing a workspace calls setActiveTab once with its id, closes the dialog and returns focus to the trigger', () => {
  const setActiveTab = vi.fn();
  render(<HeaderHarness isMobile shouldShowTasksTab shouldShowBrowserTab onSetActiveTab={setActiveTab} />);

  const { trigger, panel } = openWorkspaceDialog();
  fireEvent.click(within(panel).getByRole('button', { name: 'Files' }));

  const calls = setActiveTab.mock.calls;
  assert.equal(
    calls.length,
    1,
    `selecting one workspace must call setActiveTab exactly once; got ${calls.length} calls ${JSON.stringify(calls)}`,
  );
  assert.equal(calls[0][0], 'files', `setActiveTab must receive the chosen workspace id; got ${JSON.stringify(calls[0])}`);

  assert.equal(
    workspaceDialog(),
    null,
    `choosing a workspace must close the dialog; button names were ${JSON.stringify(buttonNames())}`,
  );
  assert.equal(
    document.activeElement,
    trigger,
    `focus must return to the trigger after choosing; focus was on ${focusedName()}`,
  );
});

test('Escape closes the workspace dialog and returns focus to the trigger', () => {
  render(<HeaderHarness isMobile />);

  const { trigger } = openWorkspaceDialog();
  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(workspaceDialog(), null, 'Escape must close the dialog');
  assert.equal(
    document.activeElement,
    trigger,
    `focus must return to the trigger after Escape; focus was on ${focusedName()}`,
  );
});

test('clicking the overlay closes the workspace dialog and returns focus to the trigger', () => {
  render(<HeaderHarness isMobile />);

  const { trigger, panel } = openWorkspaceDialog();
  fireEvent.click(dialogOverlay(panel));

  assert.equal(workspaceDialog(), null, 'clicking the overlay must close the dialog');
  assert.equal(
    document.activeElement,
    trigger,
    `focus must return to the trigger after an overlay click; focus was on ${focusedName()}`,
  );
});

test('desktop keyboard: End moves focus and selection to the last tab, Home returns to the first', () => {
  const { getAllByRole } = render(
    <HeaderHarness isMobile={false} shouldShowTasksTab shouldShowBrowserTab />,
  );

  const tabs = getAllByRole('tab');
  const firstTab = tabs[0];
  const lastTab = tabs[tabs.length - 1];

  firstTab.focus();
  fireEvent.keyDown(firstTab, { key: 'End' });

  assert.equal(
    document.activeElement,
    lastTab,
    `End must move focus to the last tab; focus was on ${focusedName()}`,
  );
  assert.equal(
    lastTab.getAttribute('aria-selected'),
    'true',
    `End must select the last tab; aria-selected values were ${JSON.stringify(tabs.map((tab) => tab.getAttribute('aria-selected')))}`,
  );

  fireEvent.keyDown(lastTab, { key: 'Home' });

  assert.equal(
    document.activeElement,
    firstTab,
    `Home must move focus back to the first tab; focus was on ${focusedName()}`,
  );
  assert.equal(
    firstTab.getAttribute('aria-selected'),
    'true',
    `Home must select the first tab; aria-selected values were ${JSON.stringify(tabs.map((tab) => tab.getAttribute('aria-selected')))}`,
  );
});

// The Quay workspace view is offered from `tabs.quay`. When that key is missing, react-i18next
// renders the key verbatim, which is how the tab shipped showing the literal `tabs.quay`. This
// reads the tab's accessible name (its `aria-label`, which mirrors its visible text) and pins it
// to a real label from the translation table.
test('the Quay tab is labelled from tabs.quay, never the bare literal "tabs.quay"', () => {
  render(
    <WorkspaceTabs
      activeTab="quay"
      setActiveTab={() => {}}
      shouldShowTasksTab={false}
      shouldShowQuayTab
      shouldShowBrowserTab={false}
    />,
  );

  const quayTab = document.querySelector('[data-workspace-tab="quay"]');
  assert.ok(
    quayTab,
    `the Quay tab must render when shouldShowQuayTab is set; tabs rendered were ${JSON.stringify(
      Array.from(document.querySelectorAll('[data-workspace-tab]')).map((el) => el.getAttribute('data-workspace-tab')),
    )}`,
  );

  const label = accessibleName(quayTab);
  // The English bundle must not itself hold the raw key, or the two assertions below would both
  // pass over a tab that still shows the defect.
  assert.notEqual(enCommon.tabs.quay, 'tabs.quay', 'the en bundle must carry a real label for tabs.quay');
  assert.notEqual(
    label,
    'tabs.quay',
    `the Quay tab must not show the raw key; its name was ${JSON.stringify(label)}`,
  );
  assert.equal(
    label,
    enCommon.tabs.quay,
    `the Quay tab must be labelled from tabs.quay; its name was ${JSON.stringify(label)}`,
  );
});

// The header is the only surface that mounts the pulse trigger, so its visibility gate is read
// here: no Quay tab ⇒ no trigger AND no lanes request; a Quay tab ⇒ the trigger at both layouts.
test('shouldShowQuayTab gates the pulse trigger and its lanes read', async () => {
  const noQuay = render(<HeaderHarness isMobile={false} />);
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(
    noQuay.container.querySelector('[data-testid="quay-pulse-trigger"]'),
    null,
    'a project without the Quay tab must not render the pulse trigger',
  );
  assert.equal(apiMock.quayLanes.mock.calls.length, 0, 'a project without the Quay tab must not read lanes');
  noQuay.unmount();

  const desktop = render(<HeaderHarness isMobile={false} shouldShowQuayTab />);
  await act(async () => {
    await Promise.resolve();
  });
  assert.ok(desktop.container.querySelector('[data-testid="quay-pulse-trigger"]'), 'desktop quay trigger');
  assert.ok(apiMock.quayLanes.mock.calls.length > 0, 'the desktop trigger polls lanes');
  desktop.unmount();

  const mobile = render(<HeaderHarness isMobile shouldShowQuayTab />);
  await act(async () => {
    await Promise.resolve();
  });
  assert.ok(mobile.container.querySelector('[data-testid="quay-pulse-trigger"]'), 'mobile quay trigger');
});

// With a quay project the mobile row carries TWO dialog-opening controls: the pulse trigger and
// the workspace picker. The picker lost its visible text to make room for the pulse strip, so
// its accessible name and its tab contract are the only things identifying it now.
test('a quay project adds the pulse trigger beside a text-free workspace picker on mobile', () => {
  render(<HeaderHarness isMobile shouldShowQuayTab />);

  const pulse = document.querySelector('[data-testid="quay-pulse-trigger"]');
  assert.ok(pulse, `the quay project must render its pulse trigger; button names were ${JSON.stringify(buttonNames())}`);

  const picker = collapsedTrigger();
  assert.ok(picker, `the workspace picker must still render; button names were ${JSON.stringify(buttonNames())}`);
  assert.equal((picker.textContent ?? '').trim(), '', 'the picker renders icon + chevron, no text');
  assert.ok(
    accessibleName(picker).includes('Chat'),
    `the picker must name the active view; its name was "${accessibleName(picker)}"`,
  );
  assert.equal(picker.getAttribute('data-workspace-tab'), 'chat');
  assert.equal(picker.getAttribute('aria-current'), 'true');
  assert.equal(picker.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(picker.getAttribute('aria-expanded'), 'false');

  fireEvent.click(picker);
  assert.ok(workspaceDialog(), 'the text-free picker must still open the workspace dialog');
  fireEvent.click(within(workspaceDialog() as HTMLElement).getByRole('button', { name: 'Files' }));
  assert.equal(document.querySelector('[aria-current="true"]')?.getAttribute('data-workspace-tab'), 'files');
});
