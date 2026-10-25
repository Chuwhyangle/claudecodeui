import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The cockpit stage's reading hierarchy, measured in a real browser.
 *
 * WHAT THIS FILE IS THE READING OF. The cockpit is a wall: 「只有需要你的东西才动 / 所见即可说」.
 * Three things follow from that and none of them can be read from a jsdom test, because Tailwind's
 * classes only become numbers once a real engine applies the stylesheet:
 *
 *   1. the ordinal label (①, ②) is a spoken handle and a pointer target, so it must be drawn at
 *      least at body size — not as dim decorative small print — and at WCAG AA contrast (≥ 4.5:1)
 *      against the tile it sits on;
 *   2. an in-flight tile is named by task id and title, never by its raw `quay://` address;
 *   3. a tile that needs a person carries the one emphasis colour in the fleet view.
 *
 * THE CONTROL ARM. Asserting "the label is readable" is only meaningful if the same reading can
 * fail. The second case forces exactly the defect the proposal names (small light-grey type) onto
 * the same element and re-runs `readabilityViolations` against the same reading function; it must
 * report the label as unreadable. Without that arm a reading function that always returned `[]`
 * would pass this file.
 *
 * THE FIXTURE. Both quay reads are stubbed at the HTTP boundary with a deterministic fleet
 * (`p1` needs a person, `p2` does not; `p1`'s driver is running, `p2`'s is stale) so the reading
 * is about the stage's rendering, not about whichever projects happen to live on this host. The
 * page, the hooks, the focus contract and the stage all run for real.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** Where the DoD's before/after screenshots land; `tmp/` is git-ignored. */
const SHOT_DIR = path.join(process.cwd(), 'tmp');
const FLEET_SHOT = path.join(SHOT_DIR, 'cockpit-visual-fleet.png');
const BOARD_SHOT = path.join(SHOT_DIR, 'cockpit-visual-board.png');
const DISABLED_HOME_SHOT = path.join(SHOT_DIR, 'cockpit-disabled-home.png');
const DISABLED_DEEPLINK_SHOT = path.join(SHOT_DIR, 'cockpit-disabled-deeplink.png');

/** The WCAG AA floor for normal-size text. */
const AA_CONTRAST = 4.5;

/** One project needs a person and one does not, so the emphasis marker has a true negative. */
const FLEET = {
  projects: [
    {
      projectId: 'p1',
      projectPath: '/work/claudecodeui',
      driver: { state: 'running' },
      tasks: { total: 4, todo: 1, ready: 2, needsHuman: 2, done: 1 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p2',
      projectPath: '/work/quay-fleet',
      driver: { state: 'stale' },
      tasks: { total: 2, todo: 1, ready: 1, needsHuman: 0, done: 0 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-23T00:00:00.000Z',
  ttlPerProjectMs: 30000,
  cached: false,
};

/** One in-flight task whose title is resolvable, so the rail can draw a subtitle. */
const SNAPSHOT = {
  projectId: 'p1',
  projectPath: '/work/claudecodeui',
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

/** The signed-in token, captured once by `bootstrapAuth` (the onboarding flow is one-time per run). */
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

/** Puts the captured session into the page the test fixture already built. */
const authenticate = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/** Answers both quay reads with the fixture, so the tile set and its counts are deterministic. */
const stubQuay = async (page: Page) => {
  await page.route('**/api/quay/fleet-summary', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLEET) }),
  );
  await page.route('**/api/quay/*/snapshot*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAPSHOT) }),
  );
};

/**
 * What the browser says about the ordinal label and the body text beside it.
 *
 * The label's own background is transparent, so the background is resolved by walking to the
 * first opaque ancestor — the tile itself. Reading the tile's class list instead would make this a
 * test of a class name rather than of what is painted.
 */
type StyledReading = {
  labelFontPx: number;
  bodyFontPx: number;
  foreground: string;
  background: string;
};

const readLabelAndBody = (): StyledReading | null => {
  const tile = document.querySelector('[data-testid="cockpit-fleet-tile"]');
  const label = document.querySelector('[data-testid="cockpit-fleet-tile-label"]');
  const body = document.querySelector('[data-testid="cockpit-fleet-tile-name"]');
  if (!(tile instanceof HTMLElement) || !(label instanceof HTMLElement) || !(body instanceof HTMLElement)) {
    return null;
  }
  let background = '';
  for (let node: HTMLElement | null = label; node !== null; node = node.parentElement) {
    const candidate = getComputedStyle(node).backgroundColor;
    const transparent = candidate === 'transparent' || /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(candidate);
    if (!transparent) {
      background = candidate;
      break;
    }
  }
  return {
    labelFontPx: Number.parseFloat(getComputedStyle(label).fontSize),
    bodyFontPx: Number.parseFloat(getComputedStyle(body).fontSize),
    foreground: getComputedStyle(label).color,
    background: background || getComputedStyle(tile).backgroundColor,
  };
};

/** Parses the `rgb(r, g, b)` / `rgba(...)` serialization a real engine returns. */
const parseRgb = (value: string): [number, number, number] => {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (match === null) {
    throw new Error(`unreadable colour serialization: ${value}`);
  }
  const [r, g, b] = (match[1] ?? '')
    .split(/[,\s/]+/)
    .filter((part) => part !== '')
    .slice(0, 3)
    .map(Number);
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`unreadable colour serialization: ${value}`);
  }
  return [r, g, b];
};

/** WCAG 2.x relative luminance of one sRGB channel, 0…1. */
const linearChannel = (value: number): number => {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);

const contrastRatio = (foreground: string, background: string): number => {
  const a = relativeLuminance(parseRgb(foreground));
  const b = relativeLuminance(parseRgb(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/**
 * The judgement, kept as data so both arms read it.
 *
 * The main arm requires this to be empty; the control arm requires it to name the defect the
 * second arm injected. A function that returned `[]` unconditionally passes the first and fails
 * the second.
 */
const readabilityViolations = (reading: StyledReading): string[] => {
  const violations: string[] = [];
  if (!(reading.labelFontPx >= reading.bodyFontPx)) {
    violations.push(
      `ordinal label is ${reading.labelFontPx}px, smaller than the body text at ${reading.bodyFontPx}px`,
    );
  }
  const ratio = contrastRatio(reading.foreground, reading.background);
  if (!(ratio >= AA_CONTRAST)) {
    violations.push(
      `ordinal label contrast is ${ratio.toFixed(2)}:1 (${reading.foreground} on ${reading.background}), below the ${AA_CONTRAST}:1 WCAG AA floor`,
    );
  }
  return violations;
};

const readTile = async (page: Page): Promise<StyledReading> => {
  const reading = await page.evaluate(readLabelAndBody);
  expect(reading, 'the fleet tile, its ordinal label and its name are all on the page').not.toBeNull();
  return reading as StyledReading;
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await bootstrapAuth(browser);
});

/**
 * The released default, read on the real app: the server answered `enabled: true` (this run
 * opts in so the other cases can render the stage), so this case overrides the ONE reading the
 * client branches on. That makes the control arm the product's fail-closed answer to a server
 * that says off, without booting a second server for one assertion.
 */
test('with the cockpit switched off the switch is absent and both deep links return to the workspace', async ({ page }) => {
  await authenticate(page);
  await page.route('**/api/settings/features', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cockpit: { enabled: false } }),
    }),
  );
  await stubQuay(page);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-mode-switch')).toHaveCount(0);
  await expect(page.getByTestId('cockpit-attention-badge')).toHaveCount(0);
  await page.screenshot({ path: DISABLED_HOME_SHOT, fullPage: true });

  // A bookmarked or previously scanned address must not render a stage the server gated.
  await page.goto('/cockpit');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('cockpit-page')).toHaveCount(0);
  await page.screenshot({ path: DISABLED_DEEPLINK_SHOT, fullPage: true });

  await page.goto('/cockpit/remote');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('cockpit-remote')).toHaveCount(0);
});

test('the ordinal label is at least body size and meets WCAG AA contrast', async ({ page }) => {
  await authenticate(page);
  await stubQuay(page);
  await page.goto('/cockpit');

  // Evidence FIRST, both views, before any assertion about them: a red run still leaves the
  // frames it was judging. Each view is waited for before its shot, so the images are the stage
  // rather than the app's start-up splash. The DoD's before/after comparison reads these files.
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const tiles = page.getByTestId('cockpit-fleet-tile');
  await expect(tiles).toHaveCount(2);
  await page.screenshot({ path: FLEET_SHOT, fullPage: true });

  await page.goto('/cockpit?view=board&project=p1');
  await expect(page.getByTestId('cockpit-board-rail')).toBeVisible();
  await page.screenshot({ path: BOARD_SHOT, fullPage: true });

  // The in-flight rail names tasks by id and title; the raw address stays in the status bar.
  await expect(page.getByTestId('cockpit-board-object')).toContainText('task-a');
  await expect(page.getByTestId('cockpit-board-object')).toContainText('Make the in-flight tile readable');
  await expect(page.getByTestId('cockpit-board-object')).not.toContainText('quay://');

  await page.goto('/cockpit');
  await expect(tiles).toHaveCount(2);

  const reading = await readTile(page);
  expect(readabilityViolations(reading)).toEqual([]);

  // The one emphasis colour belongs to the tile that needs a person, not to the other one.
  await expect(tiles.nth(0)).toHaveAttribute('data-needs-human', 'true');
  await expect(tiles.nth(1)).not.toHaveAttribute('data-needs-human', 'true');
});

test('control arm: forcing the label to small light type reds the same reading', async ({ page }) => {
  await authenticate(page);
  await stubQuay(page);
  await page.goto('/cockpit');
  await expect(page.getByTestId('cockpit-fleet-tiles')).toBeVisible();

  // Resolve the tile's own background, then paint the label with it: contrast 1:1 by construction,
  // whatever theme the run is in. The size is the second half of the same injected defect. Written
  // as inline `!important` declarations onto the element itself — a stylesheet rule of the same
  // weight is what the app's own classes compete with, and the point here is to force the reading,
  // not to re-litigate the cascade.
  const background = (await readTile(page)).background;
  await page.evaluate((color) => {
    const label = document.querySelector('[data-testid="cockpit-fleet-tile-label"]');
    if (!(label instanceof HTMLElement)) {
      throw new Error('the ordinal label is not on the page, so the control arm cannot inject into it');
    }
    label.style.setProperty('font-size', '9px', 'important');
    label.style.setProperty('color', color, 'important');
  }, background);

  // `src/index.css` gives every `span` a 200 ms `color` transition (for theme switching), so a
  // read taken immediately after the injection sees the colour it is transitioning FROM. Poll for
  // the injected colour to be the computed one instead of sleeping a guessed 200 ms.
  await expect
    .poll(async () => (await readTile(page)).foreground, { message: 'the injected colour reaches the label' })
    .toBe(background);

  const control = await readTile(page);
  const violations = readabilityViolations(control);

  expect(violations.length, JSON.stringify(control)).toBeGreaterThan(0);
  expect(violations.join(' | ')).toContain('9px');
  expect(violations.join(' | ')).toMatch(/contrast is 1\.00:1/);
});
