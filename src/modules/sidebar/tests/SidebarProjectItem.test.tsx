import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, test, vi } from 'vitest';

import type { Project, QuayDriverState, QuayFleetTaskCounts } from '@/shared/types';
import type { SidebarProjectItemProps } from '@/modules/sidebar/SidebarProjectItem';

/**
 * The project row's actions, readings and geometry contract.
 *
 * The REAL row and the REAL shared fleet store run; only the fleet transport is replaced.
 * The fleet registry id — not the Cloudpit project id — is the address the board action must
 * carry, and a project the fleet does not register must not draw that action at all.
 *
 * WHY THE VISIBILITY READINGS ARE CLASS TOKENS, NOT INLINE STYLE VALUES. The ⋯ trigger is
 * painted by the stylesheet (`opacity-0` plus `group-hover`/`group-focus-within`/open arms).
 * jsdom applies no Tailwind stylesheet, so the one computed reading it can honour here is the
 * plain `opacity-0`/`opacity-100` utility pair, which this file registers itself — that reading
 * discriminates idle from open. Hover and focus-within are pseudo-class arms jsdom cannot put
 * an element into; their class tokens are asserted here, and the REAL computed-opacity readings
 * for hover and keyboard focus live in `e2e/sidebar-project-row-uniform-height.spec.ts`, which
 * runs a browser that applies the stylesheet.
 */

const apiMock = vi.hoisted(() => ({ quayFleetSummary: vi.fn() }));
/** The server's boot-time cockpit switch; the off arm proves both row actions disappear. */
const featuresMock = vi.hoisted(() => ({ cockpitEnabled: true }));
const compactState = vi.hoisted(() => ({ compact: false }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: { ...(actual.api as Record<string, unknown>), quayFleetSummary: apiMock.quayFleetSummary },
  };
});

vi.mock('@/shared/hooks/useServerFeatures', () => ({
  useServerFeatures: () => ({ status: 'loaded' as const, cockpitEnabled: featuresMock.cockpitEnabled }),
}));

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => compactState.compact,
}));

const ZERO_TASKS: QuayFleetTaskCounts = { total: 0, todo: 0, ready: 0, needsHuman: 0, done: 0 };

const fleetEntry = (
  projectId: string,
  {
    fleetProjectId = null,
    driver = 'idle' as QuayDriverState,
    tasks = {} as Partial<QuayFleetTaskCounts>,
  }: {
    fleetProjectId?: string | null;
    driver?: QuayDriverState;
    tasks?: Partial<QuayFleetTaskCounts>;
  } = {},
) => ({
  projectId,
  ...(fleetProjectId === null ? {} : { fleetProjectId }),
  projectPath: `/work/${projectId}`,
  driver: { state: driver },
  tasks: { ...ZERO_TASKS, ...tasks },
  cached: false,
  error: null,
});

const summaryWith = (projects: ReturnType<typeof fleetEntry>[]) => ({
  projects,
  fleet: { available: true, reason: null, state: 'ok' },
  generatedAt: '2026-10-24T00:00:00.000Z',
  ttlPerProjectMs: 120_000,
  cached: false,
});

const serveFleet = (projects: ReturnType<typeof fleetEntry>[]) => {
  apiMock.quayFleetSummary.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => summaryWith(projects),
  }));
};

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;

function makeProject(projectId: string, overrides: Partial<Project> = {}): Project {
  return {
    projectId,
    displayName: projectId,
    fullPath: `/tmp/${projectId}`,
    hasQuayConfig: true,
    sessions: [],
    ...overrides,
  } as unknown as Project;
}

const rowProps = (project: Project) => ({
  project,
  selectedProject: null,
  selectedSession: null,
  isExpanded: false,
  isDeleting: false,
  isStarred: false,
  isEditing: false,
  renameDraft: '',
  sessions: [],
  initialSessionsLoaded: true,
  isLoadingMoreSessions: false,
  currentTime: new Date('2026-10-24T00:00:00.000Z'),
  sessionRenameId: null,
  sessionRenameDraft: '',
  tasksEnabled: false,
  mcpServerStatus: null,
  onRenameDraftChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  activeSessions: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  onNewSession: noop,
  isShowingHiddenSessions: false,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  showPathOnName: false,
  t,
});

const renderRow = async (
  project: Project,
  overrides: Partial<SidebarProjectItemProps> = {},
  options: { locationProbe?: boolean } = {},
) => {
  const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');
  return render(
    <MemoryRouter>
      <SidebarProjectItem
        {...({ ...rowProps(project), ...overrides } as unknown as SidebarProjectItemProps)}
      />
      {options.locationProbe ? <LocationProbe /> : null}
    </MemoryRouter>,
  );
};

/** Where the routed arm of the menu sent the app. MemoryRouter keeps this out of window.location. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

/** The three control slots a project row is allowed to keep: star, ⋯ trigger, expand indicator. */
const IN_ROW_CONTROLS = [
  '[data-testid="project-star-toggle"]',
  '[data-testid="project-actions-menu"] button[aria-haspopup="menu"]',
  '[data-testid="project-expand-indicator"]',
].join(', ');

const controlNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll(IN_ROW_CONTROLS)).map((control) =>
    control.getAttribute('data-testid')
    ?? control.closest('[data-testid="project-actions-menu"]')?.getAttribute('data-testid')
    ?? control.tagName.toLowerCase(),
  );

const menuTrigger = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('[data-testid="project-actions-menu"] button[aria-haspopup="menu"]');

/** Opens the ⋯ menu and returns it; the menu itself is portalled to document.body. */
const openMenu = async (container: HTMLElement): Promise<HTMLElement> => {
  const trigger = menuTrigger(container);
  assert.notEqual(trigger, null, 'the project row must render the ⋯ trigger');
  fireEvent.click(trigger!);
  return waitFor(() => {
    const menu = screen.queryByRole('menu');
    assert.notEqual(menu, null, 'clicking the ⋯ trigger must open the menu');
    return menu!;
  });
};

/** The menu's items, in render order, by the locale key each label is built from (the test `t` is identity). */
const menuItemLabels = (menu: HTMLElement): string[] =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => (item.textContent ?? '').trim(),
  );

const clickMenuItem = (menu: HTMLElement, label: string) => {
  fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
};

/** The row's text column: exactly two block lines (name line, readings line) in display mode. */
const textLines = (container: HTMLElement): HTMLElement[] => {
  const column = container.querySelector<HTMLElement>('[data-testid="project-row-text"]');
  assert.notEqual(column, null, 'the desktop row must render its text column');
  return Array.from(column!.children) as HTMLElement[];
};

let stylesheet: HTMLStyleElement | null = null;

beforeAll(() => {
  // The only utilities this file can read back from jsdom: the plain opacity pair. Registering
  // them makes the idle/open readings real rather than "jsdom always says 1".
  stylesheet = document.createElement('style');
  stylesheet.textContent = '.opacity-0 { opacity: 0; } .opacity-100 { opacity: 1; }';
  document.head.appendChild(stylesheet);
});

afterAll(() => {
  stylesheet?.remove();
  stylesheet = null;
});

beforeEach(() => {
  compactState.compact = false;
  featuresMock.cockpitEnabled = true;
  apiMock.quayFleetSummary.mockReset();
  serveFleet([
    fleetEntry('registered', { fleetProjectId: 'claudecodeui' }),
    fleetEntry('plain'),
  ]);
  // The fleet reading is module-level in the shared store; a cold import per case keeps it so.
  vi.resetModules();
});

vi.setConfig({ testTimeout: 20_000 });

test('a registered project reaches its cockpit board through the ⋯ menu, addressed by the fleet id', async () => {
  const { container } = await renderRow(makeProject('registered'), {}, { locationProbe: true });

  // The board action is not inline any more; it lives in the one menu the row owns.
  assert.ok(container.querySelector('[data-testid="cockpit-project-link"]') === null);
  const menu = await openMenu(container);
  clickMenuItem(menu, 'common:cockpit.openProject');

  await waitFor(() =>
    assert.equal(
      screen.getByTestId('location').textContent,
      '/cockpit?view=board&project=claudecodeui',
    ),
  );
  // The Cloudpit id is not an address: it must never appear in the menu's route.
  assert.doesNotMatch(screen.getByTestId('location').textContent ?? '', /project=registered/);
});

test('a project the fleet does not register has no cockpit action', async () => {
  const { container } = await renderRow(makeProject('plain'));

  // The fleet read still happens (the store covers the whole fleet); the row simply has no
  // addressable board for this project, so neither cockpit item is offered.
  await waitFor(() => assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1));
  const menu = await openMenu(container);
  const labels = menuItemLabels(menu);
  assert.deepEqual(
    labels,
    ['tooltips.renameProject', 'tooltips.deleteProject'],
    `an unregistered project's menu must hold only rename/delete; read ${JSON.stringify(labels)}`,
  );
  assert.ok(!labels.includes('common:cockpit.openProject'));
});

test('the compact row keeps three control slots and moves every project action into ⋯', async () => {
  compactState.compact = true;
  const { container } = await renderRow(makeProject('registered'), { onEditSessionFilter: noop });

  await waitFor(() =>
    assert.notEqual(container.querySelector('[data-testid="project-actions-menu"]'), null),
  );

  const controls = container.querySelectorAll(IN_ROW_CONTROLS);
  const names = controlNames(container);
  assert.equal(
    controls.length,
    3,
    `the compact row must keep exactly three control slots (star, ⋯, expand); read ${controls.length}: ${names.join(', ')}`,
  );
  assert.equal(
    container.querySelectorAll('[data-testid="sidebar-project-card"] button').length,
    2,
    'only the favorite star and the ⋯ trigger may be buttons in the row; the expand slot is status-only',
  );
  // The two cockpit entry points that used to sit inline are gone from the row.
  assert.equal(
    container.querySelector('[data-testid="cockpit-project-link"]'),
    null,
    'the board link must not stay inline on the compact row',
  );
  assert.equal(
    container.querySelector('[data-testid="cockpit-project-watch-toggle"]'),
    null,
    'the watch pin must not stay inline on the compact row',
  );

  const menu = await openMenu(container);
  const labels = menuItemLabels(menu);
  const EXPECTED = [
    'tooltips.renameProject',
    'sessionFilter.menuItem',
    'common:cockpit.openProject',
    'common:cockpit.observationPin',
    'tooltips.deleteProject',
  ];
  assert.deepEqual(
    labels,
    EXPECTED,
    `menu items must read ${JSON.stringify(EXPECTED)}; read ${JSON.stringify(labels)}`,
  );

  // Delete is the destructive action and sits after a separator, not among the ordinary items.
  const deleteItem = within(menu).getByRole('menuitem', { name: 'tooltips.deleteProject' });
  const divider = deleteItem.previousElementSibling;
  assert.equal(
    divider?.className.includes('bg-border'),
    true,
    `delete must sit after a divider; its preceding sibling is ${divider?.outerHTML ?? 'nothing'}`,
  );
});

test('with the cockpit switched off the menu offers neither cockpit item', async () => {
  compactState.compact = true;
  featuresMock.cockpitEnabled = false;
  const { container } = await renderRow(makeProject('registered'), { onEditSessionFilter: noop });

  const menu = await openMenu(container);
  const labels = menuItemLabels(menu);
  assert.deepEqual(
    labels,
    ['tooltips.renameProject', 'sessionFilter.menuItem', 'tooltips.deleteProject'],
    `a cockpit-off menu must hold only rename/filter/delete; read ${JSON.stringify(labels)}`,
  );
});

test('without a session-filter editor the menu omits that item', async () => {
  compactState.compact = true;
  const { container } = await renderRow(makeProject('registered'));

  const menu = await openMenu(container);
  const labels = menuItemLabels(menu);
  assert.deepEqual(
    labels,
    [
      'tooltips.renameProject',
      'common:cockpit.openProject',
      'common:cockpit.observationPin',
      'tooltips.deleteProject',
    ],
    `an absent onEditSessionFilter must drop the filter item; read ${JSON.stringify(labels)}`,
  );
});

test('menu items call their ports and never expand the row', async () => {
  compactState.compact = true;
  const project = makeProject('registered');
  const onStartEditingProject = vi.fn();
  const onDeleteProject = vi.fn();
  const onToggleProject = vi.fn();
  const onEditSessionFilter = vi.fn();
  const { container } = await renderRow(
    project,
    { onStartEditingProject, onDeleteProject, onToggleProject, onEditSessionFilter },
    { locationProbe: true },
  );

  // Opening the menu is itself a row-cluster interaction: it must not expand the project.
  const menu = await openMenu(container);
  assert.equal(onToggleProject.mock.calls.length, 0, 'the ⋯ trigger must not expand the row');

  clickMenuItem(menu, 'tooltips.renameProject');
  await waitFor(() => assert.equal(onStartEditingProject.mock.calls.length, 1));
  assert.deepEqual(onStartEditingProject.mock.calls[0], [project], 'rename receives the row project');

  const deleteMenu = await openMenu(container);
  clickMenuItem(deleteMenu, 'tooltips.deleteProject');
  await waitFor(() => assert.equal(onDeleteProject.mock.calls.length, 1));
  assert.deepEqual(onDeleteProject.mock.calls[0], [project], 'delete receives the row project');

  const cockpitMenu = await openMenu(container);
  clickMenuItem(cockpitMenu, 'common:cockpit.openProject');
  await waitFor(() =>
    assert.equal(
      screen.getByTestId('location').textContent,
      '/cockpit?view=board&project=claudecodeui',
    ),
  );

  assert.equal(
    onToggleProject.mock.calls.length,
    0,
    `no menu item or trigger may expand the row; onToggleProject was called ${onToggleProject.mock.calls.length} times`,
  );
});

test('with the cockpit switched off the row draws neither the pin nor the board link', async () => {
  featuresMock.cockpitEnabled = false;
  const { container } = await renderRow(makeProject('registered'));

  // The fleet read still runs (the task-count badge is not a cockpit surface); the two entry
  // points into the cockpit are absent inline in both layouts.
  await waitFor(() => assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1));
  assert.ok(container.querySelector('[data-testid="cockpit-project-link"]') === null);
  assert.ok(container.querySelector('[data-testid="cockpit-project-watch-toggle"]') === null);
  const menu = await openMenu(container);
  assert.ok(!menuItemLabels(menu).includes('common:cockpit.openProject'));
  assert.ok(!menuItemLabels(menu).includes('common:cockpit.observationPin'));

  compactState.compact = true;
  const compact = await renderRow(makeProject('registered'));
  assert.ok(compact.container.querySelector('[data-testid="cockpit-project-link"]') === null);
  assert.ok(compact.container.querySelector('[data-testid="cockpit-project-watch-toggle"]') === null);
});

// ---------------------------------------------------------------------------------------------
// Desktop row: two lines, no path noise, three control slots, one menu with two entry points.
// ---------------------------------------------------------------------------------------------

test('the desktop row is exactly two text lines and never prints the full path', async () => {
  const project = makeProject('registered');
  const { container } = await renderRow(project);

  const lines = textLines(container);
  assert.equal(
    lines.length,
    2,
    `the desktop row must be exactly two block lines (name, readings); read ${lines.length}`,
  );

  const row = container.querySelector('[data-testid="sidebar-project-row"]') as HTMLElement;
  const rowText = row.textContent ?? '';
  assert.ok(
    !rowText.includes(project.fullPath),
    `the row must not print the full path (${project.fullPath}); read "${rowText}"`,
  );
  assert.ok(
    !rowText.includes('...') && !rowText.includes(' - '),
    `the row must carry neither a truncated-path form ('...tail') nor a ' - path' tail; read "${rowText}"`,
  );

  // The path is still discoverable: it is the name node's tooltip, and search still matches it.
  const name = row.querySelector('[data-testid="project-row-name"]');
  assert.notEqual(name, null, 'the name node must exist');
  assert.equal(
    name!.getAttribute('title'),
    project.fullPath,
    'the name node keeps the full path in its title',
  );
});

test('the disambiguation prop puts the path on the first line and still keeps two lines', async () => {
  const project = makeProject('registered');
  const { container } = await renderRow(project, { showPathOnName: true });

  const lines = textLines(container);
  assert.equal(
    lines.length,
    2,
    `showing the path must not add a third block line; read ${lines.length}`,
  );

  const [nameLine, readingLine] = lines;
  assert.equal(
    nameLine.children.length,
    2,
    `the first line must hold the name and the path; read ${nameLine.children.length} children`,
  );
  assert.ok(
    (nameLine.textContent ?? '').includes(project.fullPath),
    `the first line must name the full path; read "${nameLine.textContent}"`,
  );
  assert.ok(
    !(readingLine.textContent ?? '').includes(project.fullPath),
    `the readings line must stay path-free; read "${readingLine.textContent}"`,
  );
});

test('the desktop row keeps exactly three control slots and none of the old inline actions', async () => {
  const { container } = await renderRow(makeProject('registered'), { onEditSessionFilter: noop });

  const row = container.querySelector('[data-testid="sidebar-project-row"]') as HTMLElement;
  const controls = row.querySelectorAll(IN_ROW_CONTROLS);
  const names = controlNames(row);
  assert.equal(
    controls.length,
    3,
    `the desktop row must keep exactly three control slots (star, ⋯, expand); read ${controls.length}: ${names.join(', ')}`,
  );
  assert.equal(
    row.querySelectorAll('button').length,
    1,
    'the ⋯ trigger must be the row\'s only button; the star and the expand slot are not buttons',
  );

  const stale = [
    '.lucide-list-filter',
    '.lucide-pen-line',
    '.lucide-trash-2',
    '[data-testid="cockpit-project-link"]',
    '[data-testid="cockpit-project-watch-toggle"]',
  ].filter((selector) => row.querySelector(selector) !== null);
  assert.deepEqual(
    stale,
    [],
    `the old inline filter/rename/delete/cockpit controls must not stay in the desktop row; found ${stale.join(', ')}`,
  );
});

test('the desktop menu carries the same items, in the same order, as the compact menu', async () => {
  const { container } = await renderRow(makeProject('registered'), { onEditSessionFilter: noop });

  const menu = await openMenu(container);
  const labels = menuItemLabels(menu);
  const EXPECTED = [
    'tooltips.renameProject',
    'sessionFilter.menuItem',
    'common:cockpit.openProject',
    'common:cockpit.observationPin',
    'tooltips.deleteProject',
  ];
  assert.deepEqual(
    labels,
    EXPECTED,
    `the desktop menu must read ${JSON.stringify(EXPECTED)}; read ${JSON.stringify(labels)}`,
  );
});

test('the ⋯ trigger is quiet at idle and painted on hover, focus-within, and while open', async () => {
  const { container } = await renderRow(makeProject('registered'));
  const trigger = menuTrigger(container);
  assert.notEqual(trigger, null, 'the desktop row must render the ⋯ trigger');

  // Idle: the utility the browser applies is `opacity-0`; the other two arms wait for a
  // pseudo-class jsdom cannot enter (asserted as the class tokens that carry them).
  const idleTokens = Array.from(trigger!.classList);
  assert.ok(idleTokens.includes('opacity-0'), `idle trigger must carry opacity-0; read ${idleTokens.join(' ')}`);
  assert.ok(
    idleTokens.includes('group-hover:opacity-100'),
    `the hover arm must be present; read ${idleTokens.join(' ')}`,
  );
  assert.ok(
    idleTokens.includes('group-focus-within:opacity-100'),
    `the keyboard-focus arm must be present; read ${idleTokens.join(' ')}`,
  );
  assert.equal(
    getComputedStyle(trigger!).opacity,
    '0',
    `the idle trigger must be painted at opacity 0; read ${getComputedStyle(trigger!).opacity}`,
  );
  assert.equal(trigger!.getAttribute('aria-expanded'), 'false');

  const menu = await openMenu(container);
  assert.ok(menu, 'the menu must open');
  assert.equal(trigger!.getAttribute('aria-expanded'), 'true', 'the open trigger must report aria-expanded');
  assert.ok(
    Array.from(trigger!.classList).includes('opacity-100'),
    `the open trigger must be painted at opacity 1; read ${Array.from(trigger!.classList).join(' ')}`,
  );
  assert.equal(
    getComputedStyle(trigger!).opacity,
    '1',
    `the open trigger must compute to opacity 1; read ${getComputedStyle(trigger!).opacity}`,
  );
});

test('right-clicking the desktop row opens the same menu and prevents the browser menu', async () => {
  const onToggleProject = vi.fn();
  const { container } = await renderRow(makeProject('registered'), { onToggleProject });
  const row = container.querySelector('[data-testid="sidebar-project-row"]') as HTMLElement;

  // fireEvent returns false exactly when the handler called preventDefault.
  const notPrevented = fireEvent.contextMenu(row);
  assert.equal(notPrevented, false, 'the desktop row must preventDefault on contextmenu');

  const menu = await waitFor(() => {
    const found = screen.queryByRole('menu');
    assert.notEqual(found, null, 'right-clicking the row must open the project menu');
    return found!;
  });
  const labels = menuItemLabels(menu);
  assert.ok(
    labels.includes('tooltips.renameProject') && labels.includes('tooltips.deleteProject'),
    `the right-click menu must be the project action menu; read ${JSON.stringify(labels)}`,
  );
  assert.equal(onToggleProject.mock.calls.length, 0, 'the right-click must not expand the row');
});

test('clicking the desktop ⋯ trigger or one of its menu items never expands the row', async () => {
  const onToggleProject = vi.fn();
  const onStartEditingProject = vi.fn();
  const { container } = await renderRow(makeProject('registered'), {
    onToggleProject,
    onStartEditingProject,
    onEditSessionFilter: noop,
  });

  // Opening the menu is itself a row-cluster interaction: it must not expand the project.
  const menu = await openMenu(container);
  assert.equal(onToggleProject.mock.calls.length, 0, 'the ⋯ trigger must not expand the row');

  // Selecting an item runs its port and closes the menu; neither may expand the row.
  clickMenuItem(menu, 'tooltips.renameProject');
  assert.equal(onStartEditingProject.mock.calls.length, 1);
  // `assert.ok` rather than `assert.equal(el, null)`: a failing `assert.equal` on a DOM node
  // serializes the whole element into its message and takes the worker down with it.
  await waitFor(() => assert.ok(screen.queryByRole('menu') === null, 'selecting rename must close the menu'));

  // Closing through the trigger is the other half of the same interaction.
  await openMenu(container);
  fireEvent.click(menuTrigger(container)!);
  await waitFor(() => assert.ok(screen.queryByRole('menu') === null, 'the trigger must close an open menu'));

  assert.equal(
    onToggleProject.mock.calls.length,
    0,
    `the trigger and its items must never expand the row; onToggleProject ran ${onToggleProject.mock.calls.length} times`,
  );
});

// ---------------------------------------------------------------------------------------------
// Quay driver indicator: only the states that ask for attention are drawn.
// ---------------------------------------------------------------------------------------------

const quayIndicator = (container: HTMLElement): HTMLElement | null =>
  container.querySelector('[data-quay-indicator]');

test('an idle driver, an unconfigured project, and an unlisted project draw no quay indicator', async () => {
  // Idle: a positive control (the non-zero badge) proves the fleet reading landed, so the absent
  // icon is a decision about the reading rather than "the read had not answered yet".
  serveFleet([fleetEntry('registered', { fleetProjectId: 'claudecodeui', driver: 'idle', tasks: { total: 1, todo: 1 } })]);
  const idle = await renderRow(makeProject('registered'));
  await waitFor(() => assert.notEqual(idle.container.querySelector('[data-project-task-counts]'), null));
  assert.ok(quayIndicator(idle.container) === null, 'an idle driver must not paint the quay indicator');
  idle.unmount();

  // Configured project, but the fleet does not list it: no reading, so no icon.
  vi.resetModules();
  serveFleet([fleetEntry('some-other-project', { driver: 'running', tasks: { total: 1, todo: 1 } })]);
  const callsBeforeUnlisted = apiMock.quayFleetSummary.mock.calls.length;
  const unlisted = await renderRow(makeProject('registered'));
  await waitFor(() =>
    assert.equal(apiMock.quayFleetSummary.mock.calls.length > callsBeforeUnlisted, true),
  );
  assert.ok(quayIndicator(unlisted.container) === null, 'a project absent from the summary has no reading');
  unlisted.unmount();

  // Not quay-configured, even though the fleet lists a running driver: the indicator is a
  // quay-project surface, so it stays absent.
  vi.resetModules();
  serveFleet([fleetEntry('registered', { driver: 'running', tasks: { total: 1, todo: 1 } })]);
  const callsBeforeUnconfigured = apiMock.quayFleetSummary.mock.calls.length;
  const unconfigured = await renderRow(makeProject('registered', { hasQuayConfig: false }));
  await waitFor(() =>
    assert.equal(apiMock.quayFleetSummary.mock.calls.length > callsBeforeUnconfigured, true),
  );
  assert.equal(
    quayIndicator(unconfigured.container),
    null,
    'a project without .quay/config.yml must not paint the quay indicator',
  );
});

for (const state of ['running', 'stale', 'unavailable'] as const) {
  test(`a ${state} driver paints exactly one indicator carrying that state`, async () => {
    serveFleet([fleetEntry('registered', { fleetProjectId: 'claudecodeui', driver: state, tasks: { total: 1, todo: 1 } })]);
    const { container } = await renderRow(makeProject('registered'));

    await waitFor(() => assert.equal(quayIndicator(container)?.getAttribute('data-quay-indicator'), state));
    assert.equal(container.querySelectorAll('[data-quay-indicator]').length, 1);
  });
}

test('the row reads the driver state from the fleet summary, not the constant null it used to pass', async () => {
  // First rendering: idle → no icon.
  serveFleet([fleetEntry('registered', { fleetProjectId: 'claudecodeui', driver: 'idle', tasks: { total: 1, todo: 1 } })]);
  const first = await renderRow(makeProject('registered'));
  // The badge proves the first reading landed; the icon is absent because the reading says idle.
  await waitFor(() => assert.notEqual(first.container.querySelector('[data-project-task-counts]'), null));
  assert.ok(quayIndicator(first.container) === null, 'idle must draw nothing');
  first.unmount();

  // Second rendering of the SAME project, with the reading flipped to running: the icon appears.
  vi.resetModules();
  serveFleet([fleetEntry('registered', { fleetProjectId: 'claudecodeui', driver: 'running', tasks: { total: 1, todo: 1 } })]);
  const second = await renderRow(makeProject('registered'));
  await waitFor(() => assert.notEqual(quayIndicator(second.container), null));
  assert.equal(
    quayIndicator(second.container)?.getAttribute('data-quay-indicator'),
    'running',
    'the icon must follow the fleet reading, not a hard-coded idle',
  );
});

/**
 * A collapsed project row has nothing to pin: `position: sticky` earns its keep when an expanded
 * row's session list scrolls under the header, and a collapsed row has no sessions under it.
 * Chrome promotes every sticky row that could overlap into a compositor layer, so with hundreds
 * of collapsed projects the class is a per-frame cost with no product behaviour behind it.
 *
 * Both surfaces are asserted independently. The outer wrapper (`SidebarProjectItem.tsx:250`) and
 * the desktop row button (`:438`) carried the trio separately, so a fix on only one of them would
 * leave the layer promotion in place for the other.
 */
const STICKY_TOKENS = ['sticky', 'top-0', 'z-10'] as const;

const stickySurfaces = (container: HTMLElement): HTMLElement[] => {
  const row = container.querySelector<HTMLElement>('[data-testid="sidebar-project-row"]');
  assert.notEqual(row, null, 'the desktop row must render');
  assert.notEqual(row!.parentElement, null, 'the row button must sit inside its header wrapper');
  return [row!.parentElement as HTMLElement, row!];
};

/** How many of the row's two surfaces carry ANY sticky token (`0` or `2`). */
const stickySurfaceCount = (container: HTMLElement): number =>
  stickySurfaces(container).filter((surface) =>
    STICKY_TOKENS.some((token) => surface.classList.contains(token)),
  ).length;

test('the sticky header exists only on the expanded project; a collapsed row stays in flow', async () => {
  const collapsed = await renderRow(makeProject('collapsed'), { isExpanded: false });
  const collapsedSurfaces = stickySurfaces(collapsed.container);
  const collapsedSticky = stickySurfaceCount(collapsed.container);
  collapsed.unmount();

  const expanded = await renderRow(makeProject('expanded'), { isExpanded: true });
  const expandedSurfaces = stickySurfaces(expanded.container);
  // One reading per ROW: the expanded row counts only if BOTH of its surfaces keep the trio.
  const expandedSticky = expandedSurfaces.every((surface) =>
    STICKY_TOKENS.every((token) => surface.classList.contains(token)),
  )
    ? 1
    : 0;
  expanded.unmount();

  console.log(`collapsedSticky=${collapsedSticky} expandedSticky=${expandedSticky}`);

  assert.equal(
    collapsedSticky,
    0,
    'a collapsed row must not be sticky — neither the wrapper nor the row button may carry the trio',
  );
  assert.equal(
    expandedSticky,
    1,
    'the expanded row must keep its sticky header on both the wrapper and the row button',
  );

  for (const surface of collapsedSurfaces) {
    for (const token of STICKY_TOKENS) {
      assert.equal(
        surface.classList.contains(token),
        false,
        `collapsed surface must not carry ${token}`,
      );
    }
  }
  for (const surface of expandedSurfaces) {
    for (const token of STICKY_TOKENS) {
      assert.equal(
        surface.classList.contains(token),
        true,
        `expanded surface must carry ${token}`,
      );
    }
  }
});
