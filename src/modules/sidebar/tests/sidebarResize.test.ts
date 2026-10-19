import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import enSidebar from '@/modules/i18n/locales/en/sidebar.json';

/**
 * The sidebar splitter: the width it opens at, the width a drag and the keyboard
 * leave it at, when that width reaches storage, and which devices are offered a
 * splitter at all.
 *
 * SidebarContent is the real component under test rather than the hook plus a
 * stand-in, because the decision that matters most here — whether a separator
 * exists — is made by SidebarContent's own `{canResize && <SidebarResizeHandle/>}`
 * and by nothing inside the hook. Its children are stubbed for the same reason
 * the filter editor's tests stub them: they are not what this file measures.
 */

// jsdom implements no PointerEvent at all, so `fireEvent.pointerDown` would fall
// back to a plain Event and deliver `clientX: null` — every drag reading below
// would then be a reading of a drag that never moved. A PointerEvent really is a
// MouseEvent plus a pointerId, so a MouseEvent subclass with that name is the
// shape the browser has, not an invention of this file. (The hook's
// `setPointerCapture?.()` stays a no-op; jsdom has no capture to fail.)
class PointerEventShim extends MouseEvent {}
(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => null }));

const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');
const { useSidebarResize } = await import('@/modules/sidebar/hooks/useSidebarResize');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  defaultNS: 'sidebar',
  resources: { en: { sidebar: enSidebar } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof SidebarContent>['t'];

/** The docked panel SidebarContent renders, and the id the splitter names as the thing it sizes. */
const PANEL_ID = 'sidebar-panel';
/** The width the sidebar has always opened at, which every absolute reading below is stated against. */
const DEFAULT_WIDTH_PX = 288;
/** The floor and the policy ceiling; the ceiling is lowered on a window too narrow to give away half of. */
const MIN_WIDTH_PX = 220;
const MAX_WIDTH_PX = 480;

/** The query the task gates on, both halves required — the same string useSendOnEnter uses. */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/**
 * The widest the sidebar may be at this viewport.
 *
 * Derived from `window.innerWidth` rather than written down as 480, so the
 * reading is of the policy the hook applies to the window it is in — a ceiling
 * that stopped following the window would move this number and the hook's own
 * together only if the hook really is reading the window.
 */
const todayMaxWidth = (): number =>
  Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, Math.round(window.innerWidth * 0.5)));

//----------------- the media-query double ------------

/**
 * Whether the double reports a finger as the only pointer.
 *
 * Held in a module variable because the hook caches one shared MediaQueryList
 * for the life of the module — the same trade useCompactSidebar makes so a
 * hundred rows cost one listener. A per-test `window.matchMedia` replacement
 * would therefore be read by the first test and ignored by every one after it;
 * flipping the value the shared list answers with is what actually moves the
 * device under the component.
 */
let touchOnlyMatches = false;
const changeListeners = new Set<() => void>();

/**
 * Replaces jsdom's matchMedia — and vitest.setup.ts's always-false stub, which
 * can only ever express the keyboard leg — with one that branches on the query
 * and reports the touch-only feature from `touchOnlyMatches`.
 */
window.matchMedia = ((query: string) => ({
  get matches() {
    return query === TOUCH_ONLY_QUERY ? touchOnlyMatches : false;
  },
  media: query,
  onchange: null,
  addEventListener: (type: string, listener: () => void) => {
    if (type === 'change') changeListeners.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    if (type === 'change') changeListeners.delete(listener);
  },
  addListener: (listener: () => void) => changeListeners.add(listener),
  removeListener: (listener: () => void) => changeListeners.delete(listener),
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

/** Hands the page a different device, the way unplugging a mouse does: the query answer changes and its listeners fire. */
const setTouchOnlyPointer = (matches: boolean) => {
  touchOnlyMatches = matches;
  act(() => {
    for (const listener of [...changeListeners]) listener();
  });
};

//----------------- the harness ------------

const noop = () => {};

/** Every prop SidebarContent requires; only `isMobile` and the width policy are what this file reads. */
const sidebarProps = (isMobile: boolean): React.ComponentProps<typeof SidebarContent> => ({
  isPWA: false,
  isMobile,
  isLoading: false,
  projects: [],
  runningSessionsCount: 0,
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

const renderSidebar = (isMobile = false) => {
  const view = render(React.createElement(SidebarContent, sidebarProps(isMobile)));
  const panel = view.container.querySelector<HTMLElement>(`#${PANEL_ID}`);
  assert.ok(panel, `SidebarContent must render the #${PANEL_ID} panel`);
  const separator = () => view.container.querySelector<HTMLElement>('[role="separator"]');
  return { view, panel, separator };
};

/** The width the panel is actually laid out at, read off the one property the drag and the state both write. */
const readWidth = (panel: HTMLElement): number => {
  const inline = panel.style.width;
  return inline === '' ? Number.NaN : Number.parseFloat(inline);
};

/** Asserts a width and, on failure, prints what the panel actually reads rather than only what was wanted. */
const assertWidth = (panel: HTMLElement, expected: number, what: string) => {
  assert.equal(
    readWidth(panel),
    expected,
    `${what}: the panel's inline width reads ${panel.style.width === '' ? '(none)' : panel.style.width}, expected ${expected}px`,
  );
};

/** The width the hook decides this device may resize, read on its own so it cannot be inferred from the markup alone. */
const readCanResize = (isMobile: boolean): boolean => {
  const { result, unmount } = renderHook(() => useSidebarResize({ isMobile }));
  const { canResize } = result.current;
  unmount();
  return canResize;
};

beforeEach(() => {
  localStorage.clear();
  changeListeners.clear();
  touchOnlyMatches = false;
});

//----------------- where the width comes from ------------

test('with nothing stored the panel opens at the shipped 288px', () => {
  const { panel, separator } = renderSidebar();

  assertWidth(panel, DEFAULT_WIDTH_PX, 'an install that has never been dragged must look exactly as it did before');
  assert.ok(separator(), 'a pointer device at a desktop width must be offered the splitter');
});

test('a stored width is clamped to the day\'s bounds', () => {
  localStorage.setItem('sidebarWidth', '9999');
  const tooWide = renderSidebar();
  const ceiling = todayMaxWidth();

  assertWidth(
    tooWide.panel,
    ceiling,
    `9999 must land on today's ceiling of ${ceiling}px at an innerWidth of ${window.innerWidth}`,
  );

  localStorage.clear();
  localStorage.setItem('sidebarWidth', '10');
  const tooNarrow = renderSidebar();

  assertWidth(tooNarrow.panel, MIN_WIDTH_PX, '10 must land on the floor rather than collapsing the panel');
});

test('a corrupted stored width falls back to the default instead of a number that looks like a choice', () => {
  // `Number.parseInt` answers 0 for '0x10' and NaN for 'abc'. The 0 is the
  // dangerous one: it clamps to the 220px floor, which is indistinguishable
  // from a sidebar the user deliberately narrowed.
  for (const corrupted of ['abc', '0x10']) {
    localStorage.clear();
    localStorage.setItem('sidebarWidth', corrupted);
    const { panel } = renderSidebar();

    assertWidth(panel, DEFAULT_WIDTH_PX, `a stored value of ${JSON.stringify(corrupted)} must be ignored, not clamped`);
  }
});

//----------------- where the keyboard puts it ------------

test('the arrow keys step the splitter by 16px and 64px from where it stands', () => {
  localStorage.setItem('sidebarWidth', '400');
  const { panel, separator } = renderSidebar();
  const handle = separator();
  assert.ok(handle, 'the keyboard leg needs the splitter to exist');

  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  assertWidth(panel, 384, 'ArrowLeft must step 16px down from 400');

  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  assertWidth(panel, 400, 'ArrowRight must step 16px back up from 384');

  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
  assertWidth(panel, 336, 'Shift+ArrowLeft must take the coarse 64px step down from 400');

  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
  assertWidth(panel, 400, 'Shift+ArrowRight must take the coarse 64px step back up from 336');
});

test('Home and End go to the floor and to today\'s ceiling', () => {
  localStorage.setItem('sidebarWidth', '400');
  const { panel, separator } = renderSidebar();
  const handle = separator();
  assert.ok(handle, 'the keyboard leg needs the splitter to exist');

  fireEvent.keyDown(handle, { key: 'Home' });
  assertWidth(panel, MIN_WIDTH_PX, 'Home must go to the floor');

  fireEvent.keyDown(handle, { key: 'End' });
  const ceiling = todayMaxWidth();
  assertWidth(panel, ceiling, `End must go to today's ceiling of ${ceiling}px at an innerWidth of ${window.innerWidth}`);
});

test('a double click on the splitter resets the width to the default', () => {
  localStorage.setItem('sidebarWidth', '400');
  const { panel, separator } = renderSidebar();
  const handle = separator();
  assert.ok(handle, 'the reset leg needs the splitter to exist');

  fireEvent.doubleClick(handle);
  assertWidth(panel, DEFAULT_WIDTH_PX, 'a double click must hand the panel back its shipped width');
});

//----------------- when it reaches storage ------------

test('a drag moves the panel live and writes storage exactly once, on release', () => {
  const { panel, separator } = renderSidebar();
  const handle = separator();
  assert.ok(handle, 'the drag leg needs the splitter to exist');
  // Installed after the render: the initial read is a getItem, and a spy taken
  // before it would count writes this case is not making.
  const setItem = vi.spyOn(Storage.prototype, 'setItem');

  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 300 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
  assertWidth(panel, 328, 'the panel must follow the pointer during the drag, not on release');

  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420 });
  assertWidth(panel, 408, 'a second sample must follow the pointer too');

  const writesDuringDrag = setItem.mock.calls.length;
  assert.equal(
    writesDuringDrag,
    0,
    `middle of the drag: storage was written ${writesDuringDrag} time(s) (${JSON.stringify(setItem.mock.calls)}) — a write per pointermove re-renders the whole project list`,
  );

  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 420 });
  const writes = setItem.mock.calls.map(([key, value]) => [String(key), String(value)]);
  assert.equal(
    writes.length,
    1,
    `releasing the pointer must write storage exactly once; it wrote ${writes.length} time(s): ${JSON.stringify(writes)}`,
  );
  assert.deepEqual(writes, [['sidebarWidth', '408']], 'the committed width must be the width the pointer was released at');
  assertWidth(panel, 408, 'the release must leave the panel on the value already on screen');
});

//----------------- which devices get a splitter ------------

test('a pointer device is offered a splitter that reports and names what it sizes', () => {
  setTouchOnlyPointer(false);
  const canResize = readCanResize(false);
  const { panel, separator } = renderSidebar();
  const handle = separator();

  assert.equal(
    canResize,
    true,
    `(pointer: coarse) and (hover: none) reads ${touchOnlyMatches} here, so a keyboard device must be allowed to resize`,
  );
  assert.ok(handle, `no [role="separator"] was rendered although canResize reads ${canResize}`);

  const aria = handle.getAttribute('aria-valuenow');
  const label = handle.getAttribute('aria-label');
  assert.equal(aria, String(readWidth(panel)), `aria-valuenow (${aria}) must be the width the panel is drawn at (${readWidth(panel)})`);
  assert.equal(handle.getAttribute('aria-valuemin'), String(MIN_WIDTH_PX), 'the splitter must announce its floor');
  assert.equal(
    handle.getAttribute('aria-valuemax'),
    String(todayMaxWidth()),
    `the splitter must announce today's ceiling of ${todayMaxWidth()}px`,
  );
  assert.equal(handle.getAttribute('aria-orientation'), 'vertical', 'a sidebar splitter is a vertical separator');
  assert.equal(handle.getAttribute('aria-controls'), PANEL_ID, 'the splitter must name the panel it sizes');
  assert.equal(label, enSidebar.resizeHandle.label, `the splitter must be named by the shipped string, not ${JSON.stringify(label)}`);
});

test('a touch-only pointer device is offered none, and keeps the width it is stored at', () => {
  localStorage.setItem('sidebarWidth', '384');
  setTouchOnlyPointer(true);
  const canResize = readCanResize(false);
  const { panel, separator } = renderSidebar();

  assert.equal(
    canResize,
    false,
    `(pointer: coarse) and (hover: none) reads ${touchOnlyMatches} here, so canResize must be false and reads ${canResize}`,
  );
  assert.equal(
    separator(),
    null,
    `a touch-only device must render no [role="separator"]; canResize is ${canResize} and the stored width is ${panel.style.width}`,
  );
  // Not being able to resize is not the same as having no width: a wide touch
  // device still docks the panel at the width it was left at.
  assertWidth(panel, 384, 'a device with no splitter must still open at the stored width');

  // The same reading, after the device changes under a mounted panel: the
  // subscription is live, not a single read taken at mount.
  setTouchOnlyPointer(false);
  assert.ok(separator(), 'handing the page a pointer must produce the splitter without a reload');
  assertWidth(panel, 384, 'and must leave the stored width exactly where it was');
});

test('the mobile drawer gets neither a splitter nor a pinned width', () => {
  const canResize = readCanResize(true);
  const { panel, separator } = renderSidebar(true);

  assert.equal(
    canResize,
    false,
    `the drawer sizes itself, so canResize must be false on a mobile layout and reads ${canResize}`,
  );
  assert.equal(
    separator(),
    null,
    `the drawer must render no [role="separator"]; canResize is ${canResize} and the inline width is ${panel.style.width === '' ? '(none)' : panel.style.width}`,
  );
  assert.equal(
    panel.style.width,
    '',
    `the drawer must pin no inline width at all, or it stops being 85vw; it reads ${JSON.stringify(panel.style.width)}`,
  );
});
