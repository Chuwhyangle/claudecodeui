import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The landing overview in a real browser, at both viewports it is specified for.
 *
 * P3's criterion is deliberately a pair of readings rather than one: the same
 * three panels must be reached through two different containers (SPEC §12 —
 * every frontend stage passes at 1280 and 390, and only the layout differs). A
 * jsdom test can assert the branch a prop selects; only a browser can say that a
 * 390px window really takes the compact arm and that the pulse bar is laid out.
 *
 * Nothing is stubbed. The app signs in against the run's own server, the landing
 * is the real no-project-selected state, and the panels are read by the same
 * data attributes the unit test asserts on.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** The overview root, and the three attributes the two arms are read by. */
const OVERVIEW = '[data-landing-overview]';
const PANELS = '[data-landing-panel]';
const PAGES = '[data-landing-page]';
const PULSE = '[data-landing-pulse]';
const PAGES_CONTAINER = '[data-landing-pages]';

/**
 * Signs in once for the file.
 *
 * `test.use({ viewport, isMobile, hasTouch })` is per-describe, so each arm gets
 * its own browser context and the default page starts unauthenticated. The
 * token is captured once and replayed into each arm's context, so onboarding
 * cost is paid once rather than per leg.
 */
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
    await expect(settings).toBeVisible({ timeout: 30_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 30_000 });
  }
};

let authToken = '';

const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the legs cannot authenticate');
  }
};

/** Puts the captured session into the arm's own context before the app boots. */
const restoreSession = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/**
 * Opens the landing.
 *
 * The run seeds several project workspaces, so no project is auto-selected and
 * the no-selection state — the one this overview replaces — is what renders.
 */
const openLanding = async (page: Page) => {
  await restoreSession(page);
  await page.goto('/');
  await expect(page.locator(OVERVIEW)).toBeVisible({ timeout: 30_000 });
};

// One sign-in for the whole file: the two arms differ only in the viewport they
// use, and onboarding against the run's own server is the expensive part.
test.beforeAll(async ({ browser }) => {
  await bootstrapAuth(browser);
});

test.describe('landing overview at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('draws the three panels side by side and no pulse bar', async ({ page }) => {
    await openLanding(page);

    await expect(page.locator(OVERVIEW)).toHaveAttribute('data-landing-overview', 'desktop');
    await expect(page.locator(PANELS)).toHaveCount(3);
    await expect(page.locator(PULSE)).toHaveCount(0);
    await expect(page.locator(PAGES)).toHaveCount(0);

    for (const panel of ['running', 'ended', 'tasks']) {
      await expect(page.locator(`[data-landing-panel="${panel}"]`)).toBeVisible();
    }
  });
});

test.describe('landing overview at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('draws the pulse bar and three switchable pages', async ({ page }) => {
    await openLanding(page);

    await expect(page.locator(OVERVIEW)).toHaveAttribute('data-landing-overview', 'mobile');
    await expect(page.locator(PULSE)).toBeVisible();
    await expect(page.locator(PAGES)).toHaveCount(3);

    for (const panel of ['running', 'ended', 'tasks']) {
      await expect(page.locator(`[data-landing-page="${panel}"] [data-landing-panel="${panel}"]`)).toHaveCount(1);
    }

    const pages = page.locator(PAGES_CONTAINER);
    await expect(pages).toHaveAttribute('data-active-page', 'running');

    await page.locator('[data-landing-tab="tasks"]').click();
    await expect(pages).toHaveAttribute('data-active-page', 'tasks');
    await expect(page.locator('[data-landing-tab="tasks"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-landing-tab="running"]')).toHaveAttribute('aria-selected', 'false');
  });
});
