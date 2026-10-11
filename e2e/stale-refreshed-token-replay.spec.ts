import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * A replayed `X-Refreshed-Token` against a REAL browser, a REAL server and REAL JWTs.
 *
 * `src/modules/auth/tests/staleRefreshedTokenCannotDowngradeSession.test.tsx` proves the rule against a
 * stubbed transport: only a strictly newer, well-formed renewal may replace the stored token. That file
 * can speak only about the code path it stubs. Whether the rule holds when the credential is a real JWT
 * the shipped server really issued, when the response is delivered to the page the way a browser cache
 * would deliver it, and when the server's own response headers are the ones a cache decides on — that is
 * a question only a browser driving the shipped app against the shipped server can answer.
 *
 * Three legs:
 *
 *   (1) a response carrying an OLDER `X-Refreshed-Token` is delivered to the page — exactly what a cache
 *       replay looks like — and the stored token must be byte-for-byte unchanged and the session must stay
 *       signed in. The old client wrote the replayed token over the fresh one unconditionally, which is
 *       the reported "every refresh logs you out" defect.
 *   (2) a response carrying a NEWER `X-Refreshed-Token` must still be adopted and announced — the positive
 *       control that keeps ordinary renewal working, so leg (1) is not satisfied by refusing everything.
 *   (3) the server's own `/api/*` response carries `Cache-Control: no-store`, and the browser really treats
 *       it as uncacheable: an `only-if-cached` read of an endpoint that was just fetched misses.
 *
 * Both replayed tokens are REAL JWTs the shipped server issued to this run's account — the older from a
 * `POST /api/auth/login`, the newer from a `POST /api/auth/refresh` of the older, taken a beat later so
 * their `iat` claims order them strictly. Nothing here mints a token itself. Legs (1) and (2) replay the
 * headers through `page.route`, which is the browser's own cache stand-in: it hands the page exactly what
 * a cache would have handed it, without needing to arrange a real cache entry first.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const REFRESHED_EVENT = 'auth-token-refreshed';
const USERNAME = 'stale-refresh-user';
const PASSWORD = 'stale-refresh-password';

const REPLAY_SCREENSHOT = path.resolve(process.cwd(), 'artifacts', 'stale-refresh-replay-old-header.png');
const ADOPT_SCREENSHOT = path.resolve(process.cwd(), 'artifacts', 'stale-refresh-adopt-new-header.png');

/** Both legs share the account the `beforeAll` creates, so they run one after another. */
test.describe.configure({ mode: 'serial', timeout: 45_000 });

let olderToken = '';
let newerToken = '';

/** The `iat` claim, in seconds, of a token this run's server issued. */
const issuedAtSeconds = (token: string): number => {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { iat: number };
  return payload.iat;
};

/** The signed-in shell's own marker: the settings control only the authenticated app renders. */
const signedInMarker = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true }).first();
const loginField = (page: Page) => page.locator('#username');

/** Reads the stored token back out of the page. */
const storedToken = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY);

/**
 * Records every `auth-token-refreshed` announcement the page dispatches, so leg (2) can prove the
 * renewal reached the session listeners rather than only the storage.
 */
const observeRefreshedTokens = (page: Page) =>
  page.addInitScript((eventName: string) => {
    const scope = window as unknown as { __refreshedTokens?: string[] };
    scope.__refreshedTokens = [];
    window.addEventListener(eventName, (event) => {
      scope.__refreshedTokens?.push((event as CustomEvent<string>).detail);
    });
  }, REFRESHED_EVENT);

const announcedTokens = (page: Page) =>
  page.evaluate(() => (window as unknown as { __refreshedTokens?: string[] }).__refreshedTokens ?? []);

/**
 * Delivers every `/api/*` response to the page with `token` as its `X-Refreshed-Token` header, which is
 * what a browser cache that stored an older response would replay. The real response is fetched first, so
 * the body and status the app receives are the server's own. Returns a counter of how many responses were
 * delivered this way, so a leg can prove the app really received a replayed header.
 */
const replayRefreshedToken = async (page: Page, token: string): Promise<{ delivered: number }> => {
  const counter = { delivered: 0 };
  await page.route('**/api/**', async (route) => {
    const response = await route.fetch();
    counter.delivered += 1;
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'x-refreshed-token': token },
    });
  });
  return counter;
};

/** Seeds the page's storage before any app code runs. */
const seedStoredToken = (page: Page, token: string) =>
  page.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [AUTH_TOKEN_KEY, token] as const);

/**
 * Creates the account once, through the app's own screens, and then takes two real tokens from the
 * server: a `login` and a `refresh` of it, a beat apart so their `iat` claims are strictly ordered.
 */
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(40_000);
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/');

  const createAccount = page.getByRole('button', { name: 'Create Account' });
  await expect(createAccount.or(loginField(page)).first()).toBeVisible({ timeout: 20_000 });
  if (await createAccount.count()) {
    await loginField(page).fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E Stale Refresh User');
    await page.getByPlaceholder('john@example.com').fill('stale-refresh@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  }

  const login = await context.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  expect(login.ok(), `login must succeed: ${login.status()} ${await login.text()}`).toBe(true);
  olderToken = ((await login.json()) as { token: string }).token;

  // A real second token, strictly newer: JWT `iat` is whole seconds, so wait past the boundary.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const refresh = await context.request.post('/api/auth/refresh', {
    headers: { Authorization: `Bearer ${olderToken}` },
  });
  expect(refresh.ok(), `refresh must succeed: ${refresh.status()} ${await refresh.text()}`).toBe(true);
  newerToken = ((await refresh.json()) as { token: string }).token;

  expect(issuedAtSeconds(newerToken)).toBeGreaterThan(issuedAtSeconds(olderToken));

  await context.close();
});

/**
 * Leg 1 — an OLDER replayed renewal must not downgrade the session.
 *
 * The page is seeded with the newer of the two real tokens and every `/api/*` response it receives is
 * given the OLDER one as its `X-Refreshed-Token`, which is the shape a cache replay has. The stored token
 * must come out of the load byte-for-byte unchanged and the session must stay signed in.
 */
test('an older replayed X-Refreshed-Token leaves the session untouched', async ({ page }) => {
  await seedStoredToken(page, newerToken);
  const replayed = await replayRefreshedToken(page, olderToken);

  await page.goto('/');

  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  expect(await storedToken(page)).toBe(newerToken);

  // The app really did receive replayed responses: at least one `/api` call was answered with the older
  // header, so the unchanged token above is a decision the client made, not a request that never happened.
  expect(replayed.delivered).toBeGreaterThan(0);

  await page.screenshot({ path: REPLAY_SCREENSHOT });
});

/**
 * Leg 2 — the positive control: a NEWER replayed renewal is adopted and announced.
 *
 * Same page, same replay mechanism, except the header carries the newer of the two real tokens. This is
 * ordinary renewal working, and it keeps leg (1) from being met by a client that simply refuses every
 * renewal.
 */
test('a newer replayed X-Refreshed-Token is adopted and announced', async ({ page }) => {
  await seedStoredToken(page, olderToken);
  await observeRefreshedTokens(page);
  await replayRefreshedToken(page, newerToken);

  await page.goto('/');

  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe(newerToken);
  await expect.poll(() => announcedTokens(page), { timeout: 10_000 }).toContain(newerToken);

  await page.screenshot({ path: ADOPT_SCREENSHOT });
});

/**
 * Leg 3 — the server half, read from a real browser.
 *
 * The shipped server must answer `/api/*` with `Cache-Control: no-store`; and the browser must really act
 * on it — an `only-if-cached` read of an endpoint that was just fetched has no cache entry to answer from
 * and fails, which is the reading that says the response cannot be replayed at all. Recorded verbatim.
 */
test('a real /api response is uncacheable in the browser', async ({ page }) => {
  await seedStoredToken(page, newerToken);
  await page.goto('/');
  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });

  const reading = await page.evaluate(async (key) => {
    const token = window.localStorage.getItem(key);
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    // A plain authenticated GET first, giving a cache the chance to store the response if it were cacheable.
    const live = await fetch('/api/projects', { headers });
    const liveHeaders = {
      status: live.status,
      cacheControl: live.headers.get('cache-control'),
      vary: live.headers.get('vary'),
    };
    // Then the cache-only read: it must miss, because nothing may have been stored.
    let onlyIfCached: { served: boolean; status?: number; error?: string };
    try {
      const cached = await fetch('/api/projects', { cache: 'only-if-cached', mode: 'same-origin', headers });
      onlyIfCached = { served: true, status: cached.status };
    } catch (error) {
      onlyIfCached = { served: false, error: String(error) };
    }
    return { liveHeaders, onlyIfCached };
  }, AUTH_TOKEN_KEY);

  // Verbatim, for Notes.
  console.log(`[stale-refresh] live headers: ${JSON.stringify(reading.liveHeaders)}`);
  console.log(`[stale-refresh] only-if-cached: ${JSON.stringify(reading.onlyIfCached)}`);

  expect(reading.liveHeaders.status).toBe(200);
  expect(reading.liveHeaders.cacheControl).toBe('no-store');
  expect(String(reading.liveHeaders.vary ?? '').toLowerCase()).toContain('authorization');
  expect(reading.onlyIfCached.served, 'the browser must not have a cached /api response to answer from').toBe(false);
});
