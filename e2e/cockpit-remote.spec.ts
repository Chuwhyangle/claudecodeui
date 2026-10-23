import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * The phone remote drives the desktop stage — in two real browsers against the real websocket
 * hub.
 *
 * WHAT THIS FILE IS THE READING OF. The cockpit splits one state between two devices: the
 * desktop shows the stage, the phone sends events. Both connect as the SAME signed-in user, so
 * the hub is the only thing that can make them agree. A jsdom test can prove the remote sends
 * `{type:'move'}`; it cannot prove that a phone's key press lands on a desktop page, because
 * the hub, the websocket gateway, the display's visible-set report and the desktop's
 * hub→view translation are all absent from jsdom.
 *
 * THE CONTROL ARM. "The desktop changed" is only meaningful if the same actions can leave it
 * unchanged. A second user's remote presses the same controls and submits the same phrase; its
 * own hub answers (its card appears) while the first user's desktop does not move. Without that
 * arm a desktop stuck on one reading, or a remote whose events never leave the browser, would
 * both pass.
 *
 * THE FIXTURE. Both quay reads are stubbed at the HTTP boundary with a deterministic two-project
 * fleet. The route stubs run in the browser; the hub's own target lookup runs on the server and
 * is deliberately not exercised here (AC3 names focus and view, not the confirmation) — the
 * confirmation-card contract is `CockpitRemote.test.tsx`'s.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** Where the DoD's screenshots land; `tmp/` is git-ignored. */
const SHOT_DIR = path.join(process.cwd(), 'tmp');
const DESKTOP_SHOT = path.join(SHOT_DIR, 'cockpit-remote-desktop.png');
const PHONE_SHOT = path.join(SHOT_DIR, 'cockpit-remote-phone.png');
const DESKTOP_PREVIEW_SHOT = path.join(SHOT_DIR, 'cockpit-remote-desktop-preview.png');
const PHONE_PREVIEW_SHOT = path.join(SHOT_DIR, 'cockpit-remote-phone-preview.png');

/** Two registered projects: `move down` has somewhere to go and 「看 alpha」 names a board. */
const FLEET = {
  projects: [
    {
      projectId: 'p1',
      fleetProjectId: 'alpha',
      projectPath: '/work/alpha',
      driver: { state: 'running' },
      tasks: { total: 3, todo: 1, ready: 1, needsHuman: 1, done: 0 },
      cached: false,
      error: null,
    },
    {
      projectId: 'p2',
      fleetProjectId: 'beta',
      projectPath: '/work/beta',
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

/** The board the 「看 alpha」 leg opens; one in-flight task keeps the board non-empty. */
const SNAPSHOT = {
  projectId: 'p1',
  projectPath: '/work/alpha',
  fleetProjectId: 'alpha',
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
      { id: 'task-a', title: 'Make the board readable', status: 'ready', updatedAt: null },
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

/** Puts a captured session into a context's pages before any navigation. */
const authenticate = async (context: BrowserContext, token: string) => {
  await context.addInitScript(([key, value]) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, token] as const);
};

/** Answers both quay reads with the fixture, so the stage's objects are deterministic. */
const stubQuay = async (page: Page) => {
  await page.route('**/api/quay/fleet-summary', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLEET) }),
  );
  await page.route('**/api/quay/*/snapshot*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAPSHOT) }),
  );
};

/**
 * The conversation a phrase about `alpha` would go to.
 *
 * This is what makes the confirmation card real rather than theoretical: the hub resolves an
 * unmatched phrase through the fleet registry, then the browser's last-opened pointer, then the
 * session row — all on the server. Both rows are seeded into this run's throwaway database; the
 * project path matches the stubbed fleet reading, so the hub's own guard (a pointer to another
 * project's session is not this project's target) sees a matching one. Confirming afterwards
 * sends into a session that does not exist on disk, which the send path refuses and logs — no
 * agent turn is ever started.
 */
const seedTargetSession = (): void => {
  const dbDir = process.env.QUAY_E2E_DATA_DIR;
  if (dbDir === undefined) throw new Error('QUAY_E2E_DATA_DIR is not set; the e2e database path is unknown');
  const db = new Database(path.join(dbDir, 'auth.db'));
  try {
    // `sessions.project_path` is a foreign key into the project registry.
    db.prepare(
      'INSERT OR REPLACE INTO projects (project_id, project_path) VALUES (?, ?)',
    ).run('p1', '/work/alpha');
    db.prepare(
      'INSERT OR REPLACE INTO sessions (session_id, provider, project_path) VALUES (?, ?, ?)',
    ).run('fixture-session', 'claude', '/work/alpha');
    db.prepare(
      'INSERT OR REPLACE INTO ui_last_opened (session_id, opened_at) VALUES (?, ?)',
    ).run('fixture-session', Date.now());
  } finally {
    db.close();
  }
};

/**
 * A second, genuinely different user. Registration refuses a second account (single-user
 * system), so the credential comes from `scripts/mint-token.mjs`: it inserts its own subject
 * row and signs a token with the running server's own secret, which is exactly "another user
 * logged in" without touching the operator's account.
 *
 * A freshly minted subject has not finished onboarding, and the app's route guard sends such a
 * user to the setup wizard. The flag is set through the app's own endpoint rather than by
 * writing the database, so the second user is a normal, fully set-up account.
 */
const mintSecondUserToken = async (): Promise<string> => {
  const dbDir = process.env.QUAY_E2E_DATA_DIR;
  if (dbDir === undefined) throw new Error('QUAY_E2E_DATA_DIR is not set; the e2e database path is unknown');
  const clientPort = process.env.QUAY_E2E_CLIENT_PORT;
  if (clientPort === undefined) throw new Error('QUAY_E2E_CLIENT_PORT is not set; the app cannot be reached');
  const out = path.join(dbDir, 'observer-token.txt');
  execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts', 'mint-token.mjs'),
      'mint',
      '--db',
      path.join(dbDir, 'auth.db'),
      '--out',
      out,
    ],
    { stdio: 'pipe' },
  );
  const token = fs.readFileSync(out, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${clientPort}/api/user/complete-onboarding`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`could not complete the second user's onboarding: HTTP ${response.status}`);
  }
  return token;
};

const openDesktop = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  await stubQuay(page);
  await page.goto('/cockpit');
  await expect(page.getByTestId('cockpit-page')).toBeVisible();
  return page;
};

const openRemote = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  await page.goto('/cockpit/remote');
  await expect(page.getByTestId('cockpit-remote')).toHaveAttribute('data-cockpit-connected', 'true', {
    timeout: 15_000,
  });
  return page;
};

/** The desktop's focused object address, once the display has reported its visible set. */
const waitForDesktopFocus = async (page: Page): Promise<string> => {
  const focus = page.getByTestId('cockpit-focus');
  await expect(focus).toHaveAttribute('data-cockpit-focus', /quay:\/\//, { timeout: 15_000 });
  return (await focus.getAttribute('data-cockpit-focus')) ?? '';
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await bootstrapAuth(browser);
});

test('the phone remote moves the desktop focus, then a spoken 「看 <project>」 opens the board', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  seedTargetSession();

  // The same signed-in user on both ends: one hub, two roles.
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await authenticate(desktopContext, authToken);
  await authenticate(phoneContext, authToken);

  const desktop = await openDesktop(desktopContext);
  const phone = await openRemote(phoneContext);

  // The stage must actually be showing two addressable project tiles before the phone speaks.
  await expect(desktop.getByTestId('cockpit-fleet-tile')).toHaveCount(2, { timeout: 15_000 });
  expect(await waitForDesktopFocus(desktop)).toBe('quay://alpha/board');

  // 1. The direction pad moves the desktop's focus. The remote's own echo agrees.
  await phone.getByTestId('cockpit-remote-move-down').click();
  await expect(desktop.getByTestId('cockpit-focus')).toHaveAttribute(
    'data-cockpit-focus',
    'quay://beta/board',
    { timeout: 10_000 },
  );
  await expect(phone.getByTestId('cockpit-remote-focus-label')).toContainText('②');

  await phone.screenshot({ path: PHONE_SHOT });
  await desktop.screenshot({ path: DESKTOP_SHOT });

  // 2. A phrase typed on the phone becomes a view change on the desktop. 「看 alpha」 matches the
  //    fleet registry id the stage's board addresses carry.
  const input = phone.getByTestId('cockpit-remote-input').locator('[data-slot="prompt-input-textarea"]');
  await input.fill('看 alpha');
  await input.press('Enter');

  await expect(desktop.getByTestId('cockpit-page')).toHaveAttribute('data-cockpit-view', 'board', {
    timeout: 15_000,
  });
  await expect(desktop).toHaveURL(/view=board/);
  await expect(desktop).toHaveURL(/project=p1/);
  // The phone's echo follows the same broadcast: the desktop's new view, not a local guess.
  await expect(phone.getByTestId('cockpit-remote-focus-label')).toContainText('①', {
    timeout: 15_000,
  });

  await phone.screenshot({ path: PHONE_SHOT });
  await desktop.screenshot({ path: DESKTOP_SHOT });

  // 3. A phrase that is not a view command is addressed to what the stage has focused: it
  //    becomes a confirmation card ON THE PHONE that spoke, with the destination the hub
  //    resolved from the display's visible set. Nothing is sent until the person confirms.
  await input.fill('把这条任务改短一点');
  await input.press('Enter');
  await expect(phone.getByTestId('cockpit-remote-pending')).toBeVisible({ timeout: 15_000 });
  await expect(phone.getByTestId('cockpit-remote-preview-line')).toContainText('把这条任务改短一点');
  await expect(phone.getByTestId('cockpit-remote-preview-line')).toContainText('alpha');
  await expect(phone.getByTestId('cockpit-remote-preview-line')).toContainText('fixture-session');
  // The stage shows the same card, built from the display's own set.
  await expect(desktop.getByTestId('cockpit-send-preview')).toBeVisible({ timeout: 10_000 });

  // Let the button's enable transition settle before the screenshot: a shot taken the instant
  // the card arrives catches it mid-fade and looks disabled.
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: PHONE_PREVIEW_SHOT });
  await desktop.screenshot({ path: DESKTOP_PREVIEW_SHOT });

  // The confirmation is the phone's act: it must be live while the card is open, and pressing
  // it closes the card on BOTH ends.
  await expect(phone.getByTestId('cockpit-remote-confirm')).toBeEnabled();

  await phone.getByTestId('cockpit-remote-confirm').click();
  await expect(phone.getByTestId('cockpit-remote-pending')).toHaveCount(0, { timeout: 15_000 });
  await expect(desktop.getByTestId('cockpit-send-preview')).toHaveCount(0, { timeout: 15_000 });

  await desktopContext.close();
  await phoneContext.close();
});

test('control arm: another user\'s remote drives its own hub and leaves this desktop alone', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await authenticate(ownerContext, authToken);
  const desktop = await openDesktop(ownerContext);

  // The hub is per user and outlives the first case, so this stage may still be showing the
  // board the main arm opened — the stage renders whichever view the hub holds. Wait for the
  // hub's own focus reading, which exists in either view, rather than for fleet tiles.
  await waitForDesktopFocus(desktop);

  // The hub is per user and outlives the first case, so this stage may still be showing the
  // board the main arm opened. What the control arm reads is that it does not MOVE from here.
  const page = desktop.getByTestId('cockpit-page');
  const readRev = async (): Promise<string> => (await page.getAttribute('data-cockpit-hub-rev')) ?? '';
  const waitForSettledRev = async (): Promise<string> => {
    let previous = '';
    let stableReads = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await readRev();
      stableReads = current === previous ? stableReads + 1 : 1;
      previous = current;
      // Three identical readings 150 ms apart: the display's report and the hub's broadcast
      // have both landed, so a later "unchanged" reading is about the other user, not a
      // still-arriving frame of our own.
      if (stableReads >= 3) return current;
      await desktop.waitForTimeout(150);
    }
    throw new Error('the desktop hub revision never settled');
  };
  const revBefore = await waitForSettledRev();
  const focusSettled = (await desktop.getByTestId('cockpit-focus').getAttribute('data-cockpit-focus')) ?? '';
  const viewBefore = await page.getAttribute('data-cockpit-view');

  // A different user's phone, with a token signed for its own subject row.
  const strangerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await authenticate(strangerContext, await mintSecondUserToken());
  const stranger = await openRemote(strangerContext);

  // The stranger's events DO reach a hub: its own card appears with the honest "no focus here"
  // answer. (The remote never reports visibility, so this user's hub has no focusable objects.)
  await stranger.getByTestId('cockpit-remote-move-down').click();
  const input = stranger.getByTestId('cockpit-remote-input').locator('[data-slot="prompt-input-textarea"]');
  await input.fill('看 alpha');
  await input.press('Enter');
  await expect(stranger.getByTestId('cockpit-remote-no-target')).toBeVisible({ timeout: 10_000 });
  await expect(stranger.getByTestId('cockpit-remote-no-target')).toContainText('看 alpha');

  // …while the first user's desktop is untouched: no focus change, no revision change, no view
  // change.
  await desktop.waitForTimeout(1000);
  expect(await desktop.getByTestId('cockpit-focus').getAttribute('data-cockpit-focus')).toBe(focusSettled);
  expect(await readRev()).toBe(revBefore);
  expect(await page.getAttribute('data-cockpit-view')).toBe(viewBefore);

  await strangerContext.close();
  await ownerContext.close();
});
