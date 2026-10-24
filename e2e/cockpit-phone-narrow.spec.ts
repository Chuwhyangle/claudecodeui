import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The cockpit's phone narrow layout (390×844), measured in a real browser.
 *
 * WHY A BROWSER AND NOT JSDOM. Every criterion in this file is geometry: a header's height, the
 * document's scroll width, a control's 44×44 touch box, a chip's right edge, the dock's share of
 * the viewport, whether the last tile can be scrolled out from under the dock, whether a horizontal
 * strip overflows and fades at its right edge. Tailwind classes are only numbers once an engine
 * applies the stylesheet, so each reading below runs through `page.evaluate` and returns DATA —
 * never an assertion — which is also what lets a control arm re-read the same defects.
 *
 * THE FIXTURE. Every quay read is stubbed at the HTTP boundary: a ten-project fleet (enough that
 * the strip outruns 390px and the tile grid outruns the stage), an empty observation wall, a fresh
 * deployment reading (so the deploy strip has nothing to say), and a board snapshot whose in-flight
 * ids are long enough to wrap. The page, the hooks, the focus contract and the stage run for real.
 *
 * THE CONTROL ARM. 「The strip fades at its right edge and snaps whole chips」 is only meaningful if
 * the same reading can say it does not. The control arm removes the fade, turns scroll-snap off and
 * forces every strip item to 30px, then re-runs `readStrip`: `maskPresent` must be false, the snap
 * type must no longer be `x`, and the touch floor must report violations.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

const SHOT_DIR = path.join(process.cwd(), 'tmp');
const PHONE_FLEET_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-fleet.png');
const PHONE_DOCK_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-dock-typing.png');
const PHONE_BOARD_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-board.png');
const PHONE_STRIP_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-strip.png');
const PHONE_STRIP_CONTROL_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-strip-control.png');
const PC_FLEET_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-pc-fleet.png');
const PC_BOARD_SHOT = path.join(SHOT_DIR, 'cockpit-phone-narrow-pc-board.png');

const PHONE = { width: 390, height: 844 };
const PC = { width: 1440, height: 900 };

/** The floors, restated inside each `page.evaluate` (that function is serialized alone). */
const TOUCH_FLOOR_PX = 44;
const HEADER_MAX_PX = 64;
/** The dock may spend at most this share of the phone viewport. */
const DOCK_MAX_SHARE = 0.2;

const NOW = Date.now();

/**
 * Ten projects: the two registered-and-readable ones plus enough siblings that (a) the horizontal
 * project strip outruns 390px and (b) the one-column tile grid is taller than the phone stage.
 * None carries a pulse reading — the pulse strip's own controls are not part of this task's write
 * surface, and the narrow-layout criteria are about the cockpit's chrome.
 */
const project = (index: number, name: string, fleetProjectId: string | null) => ({
  projectId: `p${index}`,
  fleetProjectId,
  projectPath: `/work/${name}`,
  driver: { state: index % 3 === 0 ? 'stale' : 'running' },
  tasks: { total: 3, todo: 1, ready: 1, needsHuman: 0, done: 1 },
  pulse: null,
  cached: false,
  error: null,
});

const FLEET = {
  projects: [
    project(1, 'claudecodeui', 'claudecodeui'),
    project(2, 'quay-fleet', 'quay-fleet'),
    project(3, 'plantuml-js', 'plantuml-js'),
    project(4, 'archguard', 'archguard'),
    project(5, 'meta-cc', 'meta-cc'),
    project(6, 'cantus', 'cantus'),
    project(7, 'quay-dogfood-goal030', 'quay-dogfood-goal030'),
    project(8, 'voice-lab', 'voice-lab'),
    project(9, 'arch-lab', 'arch-lab'),
    project(10, 'cockpit-lab', 'cockpit-lab'),
  ],
  generatedAt: new Date(NOW).toISOString(),
  ttlPerProjectMs: 30000,
  cached: false,
};

/** A fresh deployment: the phone strip has nothing to say and adds no row to the chrome. */
const DEPLOY_FRESH = {
  status: 'fresh',
  runningSha: 'abc1234',
  builtSha: 'abc1234',
  clientBuiltSha: 'abc1234',
  headSha: 'abc1234',
  pendingCommits: [],
  lastDeploy: null,
  failure: null,
  checkedAt: new Date(NOW).toISOString(),
};

/** Long ids on purpose: the dark half of the in-flight chip measurement. */
const LONG_TASK_ID = 'gap-cockpit-phone-narrow-viewport-layout-in-flight-identifier-that-must-wrap';
const LONG_TITLE =
  'The in-flight chip keeps its right edge inside the phone viewport even when the task id and title are long';

const SNAPSHOT = {
  projectId: 'p1',
  projectPath: '/work/claudecodeui',
  fleetProjectId: 'claudecodeui',
  generatedAt: new Date(NOW).toISOString(),
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: new Date(NOW - 60_000).toISOString() },
  tasks: {
    total: 3,
    byStatus: { ready: 1, 'needs-human': 1 },
    ready: 1,
    needsHuman: 1,
    done: 1,
    recent: [{ id: LONG_TASK_ID, title: LONG_TITLE, status: 'ready', updatedAt: null }],
  },
  goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
  adrs: { total: 0, recent: [] },
  configIssues: { total: 0, errors: 0 },
  tests: { current: null, recentRounds: [] },
  fanIn: { recent: [] },
  inFlight: [
    {
      taskId: LONG_TASK_ID,
      phase: 'implementing',
      startedAt: new Date(NOW - 3_600_000).toISOString(),
      lastHeartbeat: new Date(NOW - 60_000).toISOString(),
      workerPid: 1234,
    },
    {
      taskId: 'gap-second-in-flight-task-with-a-longish-identifier',
      phase: 'fan-in',
      startedAt: new Date(NOW - 1_800_000).toISOString(),
      lastHeartbeat: new Date(NOW - 30_000).toISOString(),
      workerPid: 4321,
    },
  ],
  dashboardUrl: null,
  warnings: [],
};

let authToken = '';

const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
  if (await createAccount.count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the cockpit cannot authenticate');
  }
};

const authenticate = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/** Every quay read the cockpit consults, deterministic and independent of this host. */
const stubCockpit = async (page: Page) => {
  await page.route('**/api/quay/fleet-summary', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLEET) }),
  );
  await page.route('**/api/observation/wall', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [], collapsedCount: 0, producers: [], self: null }),
    }),
  );
  await page.route('**/api/system/deploy-readiness', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEPLOY_FRESH) }),
  );
  await page.route('**/api/quay/*/snapshot*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAPSHOT) }),
  );
};

type TouchViolation = string;

type PhoneReading = {
  viewportWidth: number;
  scrollWidth: number;
  horizontalOverflow: boolean;
  headerHeight: number;
  dockHeight: number;
  dockShare: number;
  touchViolations: TouchViolation[];
  lastTile: { scrollable: boolean; fullyVisible: boolean; overlaps: boolean };
};

/**
 * AC1's one reading of the phone cockpit. Returns data, not assertions, so the same numbers can
 * be attached to the failure message and a control arm could re-read them.
 */
const readPhone = (): PhoneReading => {
  // `page.evaluate` serializes this function alone: the module's floors are restated here.
  const minTargetPx = 44;

  const touchViolations: TouchViolation[] = [];
  const describe = (element: Element): string =>
    element.getAttribute('data-testid') ??
    element.getAttribute('aria-label') ??
    (element.textContent ?? '').trim().slice(0, 24) ??
    element.tagName.toLowerCase();
  // "Visible" is the painted box: a `hidden` control, or one inside a `display:none` ancestor,
  // has no box and is not a touch target anyone can miss.
  const isVisible = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>('button, a, input, textarea, select, [role="button"]'),
  )) {
    if (!isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < minTargetPx - 0.5 || rect.height < minTargetPx - 0.5) {
      touchViolations.push(
        `${describe(element)} is ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}, below ${minTargetPx}×${minTargetPx}`,
      );
    }
  }

  const header = document.querySelector<HTMLElement>('[data-testid="cockpit-header"]');
  const headerHeight = header === null ? Number.POSITIVE_INFINITY : header.getBoundingClientRect().height;
  const dock = document.querySelector<HTMLElement>('[data-testid="cockpit-status"]');
  const dockHeight = dock === null ? Number.POSITIVE_INFINITY : dock.getBoundingClientRect().height;

  // The stage's own scrolling region: the last tile must be able to leave the dock's way.
  const scroller = document.querySelector<HTMLElement>('[data-testid="cockpit-fleet-scroll"]');
  const tiles = scroller === null ? [] : Array.from(scroller.querySelectorAll<HTMLElement>('[data-testid="cockpit-fleet-tile"]'));
  const last = tiles[tiles.length - 1];
  let lastTile = { scrollable: false, fullyVisible: false, overlaps: false };
  if (scroller !== null && last !== undefined && dock !== null) {
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 1;
    scroller.scrollTop = scroller.scrollHeight;
    const lastRect = last.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    lastTile = {
      scrollable,
      fullyVisible: lastRect.bottom <= dockRect.top + 1 && lastRect.top >= scrollerRect.top - 1,
      overlaps: lastRect.bottom > dockRect.top + 1,
    };
  }

  return {
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    headerHeight,
    dockHeight,
    dockShare: dockHeight / window.innerHeight,
    touchViolations,
    lastTile,
  };
};

type ChipReading = {
  viewportWidth: number;
  scrollWidth: number;
  chips: Array<{ label: string; right: number; left: number }>;
  escaping: string[];
};

/** AC1's other half: every in-flight chip lives inside the phone viewport, wrapping not overflowing. */
const readChips = (): ChipReading => {
  const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="cockpit-board-object"]'));
  const readings = chips.map((chip) => {
    const rect = chip.getBoundingClientRect();
    return {
      label: (chip.textContent ?? '').trim().slice(0, 40),
      right: rect.right,
      left: rect.left,
    };
  });
  return {
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chips: readings,
    escaping: readings
      .filter((chip) => chip.right > window.innerWidth + 1 || chip.left < -1)
      .map((chip) => `${chip.label} spans ${chip.left.toFixed(1)}..${chip.right.toFixed(1)}`),
  };
};

type StripReading = {
  overflow: boolean;
  maskPresent: boolean;
  maskVisible: boolean;
  snapType: string;
  unreachableItems: string[];
  truncatedNames: string[];
  touchViolations: string[];
};

/**
 * AC2's one reading of the project strip.
 *
 * 「A project name is not cut by the container edge」 is read as: each item can be brought WHOLE
 * into the strip (scroll it to its snap position and its visible width equals its own width) and
 * no item ellipsizes its name. A reading that always returned empty arrays would pass the main
 * arm; the control arm (fade removed, snap off, items forced to 30px) must red this same function.
 */
const readStrip = (): StripReading => {
  const minTargetPx = 44;
  const strip = document.querySelector<HTMLElement>('[data-testid="cockpit-project-strip"]');
  if (strip === null) throw new Error('the project strip is not on the page');
  const overflow = strip.scrollWidth > strip.clientWidth + 1;
  const mask = document.querySelector<HTMLElement>('[data-testid="cockpit-project-strip-fade"]');
  const maskStyle = mask === null ? null : getComputedStyle(mask);
  const maskVisible =
    mask !== null && maskStyle !== null && maskStyle.display !== 'none' && mask.getBoundingClientRect().width > 0;
  const snapType = getComputedStyle(strip).scrollSnapType;
  const items = Array.from(
    strip.querySelectorAll<HTMLElement>('[data-testid="cockpit-project-strip-item"]'),
  );
  const unreachableItems: string[] = [];
  const truncatedNames: string[] = [];
  const touchViolations: string[] = [];
  const savedLeft = strip.scrollLeft;
  for (const item of items) {
    const label = (item.textContent ?? '').trim().slice(0, 24);
    // Bring the item to its own snap position; then "visible width == whole item width" is the
    // literal reading of what the person can land on.
    item.scrollIntoView({ inline: 'start', block: 'nearest' });
    const stripRect = strip.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const visible =
      Math.min(itemRect.right, stripRect.right) - Math.max(itemRect.left, stripRect.left);
    if (visible < itemRect.width - 0.5) {
      unreachableItems.push(`${label} shows ${visible.toFixed(1)}px of ${itemRect.width.toFixed(1)}px`);
    }
    if (item.scrollWidth > item.clientWidth + 1) truncatedNames.push(label);
    if (itemRect.width < minTargetPx - 0.5 || itemRect.height < minTargetPx - 0.5) {
      touchViolations.push(
        `${label} is ${itemRect.width.toFixed(1)}×${itemRect.height.toFixed(1)}, below ${minTargetPx}×${minTargetPx}`,
      );
    }
  }
  strip.scrollLeft = savedLeft;
  return {
    overflow,
    maskPresent: mask !== null,
    maskVisible,
    snapType,
    unreachableItems,
    truncatedNames,
    touchViolations,
  };
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await bootstrapAuth(browser);
});

test('phone 390×844: one-line header, 44×44 targets, a dock inside 20% and a reachable last tile', async ({
  page,
}) => {
  await authenticate(page);
  await stubCockpit(page);
  await page.setViewportSize(PHONE);
  await page.goto('/cockpit?view=fleet');

  await expect(page.getByTestId('cockpit-fleet-tile').first()).toBeVisible();
  await expect(page.getByTestId('cockpit-fleet-tile')).toHaveCount(FLEET.projects.length);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: PHONE_FLEET_SHOT, fullPage: true });

  const reading = await page.evaluate(readPhone);
  expect(reading.viewportWidth).toBe(PHONE.width);
  expect(reading.headerHeight, JSON.stringify(reading)).toBeLessThanOrEqual(HEADER_MAX_PX);
  expect(reading.horizontalOverflow, JSON.stringify(reading)).toBe(false);
  expect(reading.scrollWidth).toBeLessThanOrEqual(reading.viewportWidth + 1);
  expect(reading.touchViolations, JSON.stringify(reading.touchViolations)).toEqual([]);
  expect(reading.dockShare, JSON.stringify(reading)).toBeLessThanOrEqual(DOCK_MAX_SHARE);
  expect(reading.lastTile.scrollable, JSON.stringify(reading.lastTile)).toBe(true);
  expect(reading.lastTile.fullyVisible, JSON.stringify(reading.lastTile)).toBe(true);
  expect(reading.lastTile.overlaps, JSON.stringify(reading.lastTile)).toBe(false);

  // The dock's own shape: one line of input, then the mic and Run — no push-to-talk essay.
  await page.getByTestId('cockpit-input').locator('textarea').fill('看 claudecodeui 的在途任务');
  await page.screenshot({ path: PHONE_DOCK_SHOT, fullPage: true });
  const dockAfterTyping = await page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('[data-testid="cockpit-status"]');
    return dock === null ? Number.POSITIVE_INFINITY : dock.getBoundingClientRect().height / window.innerHeight;
  });
  expect(dockAfterTyping, 'typing must not grow the dock past its share').toBeLessThanOrEqual(
    DOCK_MAX_SHARE,
  );
});

test('phone board: every in-flight chip keeps its right edge inside the viewport', async ({ page }) => {
  await authenticate(page);
  await stubCockpit(page);
  await page.setViewportSize(PHONE);
  await page.goto('/cockpit?view=board&project=claudecodeui');

  const chips = page.getByTestId('cockpit-board-object');
  await expect(chips.first()).toBeVisible();
  await expect(chips).toHaveCount(SNAPSHOT.inFlight.length);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: PHONE_BOARD_SHOT, fullPage: true });

  const reading = await page.evaluate(readChips);
  expect(reading.chips).toHaveLength(SNAPSHOT.inFlight.length);
  expect(reading.escaping, JSON.stringify(reading)).toEqual([]);
  expect(reading.scrollWidth).toBeLessThanOrEqual(reading.viewportWidth + 1);

  // The board's own phone control: Refresh is a real touch target, and the long id is not
  // rewritten to fit (the chip wraps; the tooltip still carries the whole value).
  const refresh = await page.getByTestId('quay-panel-refresh').boundingBox();
  expect(refresh).not.toBeNull();
  expect(refresh!.width).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - 0.5);
  expect(refresh!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - 0.5);
  await expect(page.getByTestId('cockpit-board-object-title').first()).toHaveAttribute(
    'title',
    LONG_TASK_ID,
  );
});

test('phone project strip: overflowing row with a right-edge fade and snap, no half-cut name', async ({
  page,
}) => {
  await authenticate(page);
  await stubCockpit(page);
  await page.setViewportSize(PHONE);
  await page.goto('/cockpit?view=fleet');
  await expect(page.getByTestId('cockpit-project-strip-item').first()).toBeVisible();

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: PHONE_STRIP_SHOT, fullPage: true });

  const reading = await page.evaluate(readStrip);
  // The precondition the fade is FOR: the row really does outrun the phone.
  expect(reading.overflow, JSON.stringify(reading)).toBe(true);
  expect(reading.maskPresent, JSON.stringify(reading)).toBe(true);
  expect(reading.maskVisible, JSON.stringify(reading)).toBe(true);
  expect(reading.snapType.startsWith('x'), JSON.stringify(reading)).toBe(true);
  expect(reading.unreachableItems, JSON.stringify(reading)).toEqual([]);
  expect(reading.truncatedNames, JSON.stringify(reading)).toEqual([]);
  expect(reading.touchViolations, JSON.stringify(reading)).toEqual([]);
});

test('control arm: removing the fade and snap, and forcing 30px items, reds the same strip reading', async ({
  page,
}) => {
  await authenticate(page);
  await stubCockpit(page);
  await page.setViewportSize(PHONE);
  await page.goto('/cockpit?view=fleet');
  await expect(page.getByTestId('cockpit-project-strip-item').first()).toBeVisible();

  const before = await page.evaluate(readStrip);
  expect(before.maskPresent).toBe(true);
  expect(before.snapType.startsWith('x')).toBe(true);
  expect(before.touchViolations).toEqual([]);

  // The defect the proposal names, injected as the three removals a regression would make.
  await page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[data-testid="cockpit-project-strip"]');
    if (strip === null) throw new Error('the project strip is not on the page');
    strip.style.setProperty('scroll-snap-type', 'none', 'important');
    document.querySelector('[data-testid="cockpit-project-strip-fade"]')?.remove();
    for (const item of Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cockpit-project-strip-item"]'),
    )) {
      // The original defect was a 30px-high row. A `min-height` alone cannot shrink a flex
      // item: `align-items: stretch` on the strip gives every item the line's cross size (the
      // 44px nav buttons set it). The control arm therefore pins the box itself, the way the
      // pre-fix layout did, so the reading has something real to reject.
      item.style.setProperty('height', '30px', 'important');
      item.style.setProperty('min-height', '30px', 'important');
      item.style.setProperty('width', '30px', 'important');
      item.style.setProperty('min-width', '30px', 'important');
      item.style.setProperty('align-self', 'flex-start', 'important');
    }
  });
  await page.screenshot({ path: PHONE_STRIP_CONTROL_SHOT, fullPage: true });

  const after = await page.evaluate(readStrip);
  expect(after.maskPresent, JSON.stringify(after)).toBe(false);
  expect(after.snapType.startsWith('x'), JSON.stringify(after)).toBe(false);
  expect(after.touchViolations.length, JSON.stringify(after)).toBeGreaterThan(0);
});

test('PC 1440×900 regression: the desktop column, dock and board are unchanged in kind', async ({ page }) => {
  await authenticate(page);
  await stubCockpit(page);
  await page.setViewportSize(PC);
  await page.goto('/cockpit?view=fleet');
  await expect(page.getByTestId('cockpit-fleet-tile').first()).toBeVisible();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: PC_FLEET_SHOT, fullPage: true });

  const desktop = await page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[data-testid="cockpit-project-strip"]');
    const fade = document.querySelector<HTMLElement>('[data-testid="cockpit-project-strip-fade"]');
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cockpit-project-strip-item"]'),
    );
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      fadeDisplay: fade === null ? 'missing' : getComputedStyle(fade).display,
      snapType: strip === null ? 'missing' : getComputedStyle(strip).scrollSnapType,
      // The 12rem column: items stay narrow, so the strip is a column rather than a row.
      widestItem: Math.max(...items.map((item) => item.getBoundingClientRect().width)),
    };
  });
  expect(desktop.overflow).toBe(false);
  expect(desktop.fadeDisplay).toBe('none');
  expect(desktop.snapType).not.toContain('x');
  expect(desktop.widestItem).toBeLessThanOrEqual(168); // 12rem = 192px column, minus padding

  await page.goto('/cockpit?view=board&project=claudecodeui');
  await expect(page.getByTestId('cockpit-board-object').first()).toBeVisible();
  await page.screenshot({ path: PC_BOARD_SHOT, fullPage: true });
  const boardOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(boardOverflow).toBe(false);
});
