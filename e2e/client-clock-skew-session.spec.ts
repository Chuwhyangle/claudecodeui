import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The client-clock rule against a REAL browser, a REAL server and a REAL JWT.
 *
 * `src/modules/auth/tests/clientClockCannotExpireSession.test.tsx` proves the rule against a stubbed
 * transport: a page whose clock reads a stored token's `exp` as past must still hand that token over,
 * and only the server's refusal may end the session. That file can only speak about the code path it
 * stubs. Whether the rule holds when the token is a credential the real server really issued, when the
 * page clock is really eight days ahead of the machine's, and when the refusal is really the server's
 * own signature check — that is a question only a browser driving the shipped app against the shipped
 * server can answer, and it is what this spec answers.
 *
 * Two legs, one per direction:
 *
 *   (1) a page whose clock is pushed a full eight days forward — well past the seven-day life of the
 *       token the server issues — signs in, then RELOADS. The old client read that token, called it
 *       expired against its own clock, deleted it and announced the session gone, so this reload
 *       landed on the login page. The app must instead stay on the signed-in shell with the credential
 *       it stored, and the socket it opens for that credential must really connect. This same leg's
 *       sign-in is the one whose page clock the server reports (see below): the run is the
 *       clock-shifted one.
 *   (2) a credential the real server rejects ⇒ the login page and the shipped session-expired
 *       sentence, i.e. the positive control that the 401 arm did not go dead.
 *
 * The account is a one-off created against this run's throwaway database, and the credential both legs
 * replay is the answer to a real `POST /api/auth/login` — never a token minted here. The one refused
 * credential is well-formed and signed by something that is not the run's `jwt_secret`, which is
 * exactly what makes the server's own check answer 401.
 *
 * The diagnostic half is the other reason this leg is a real browser and not a stub: the client
 * reports its clock on the login, and the SERVER writes the reading to its `[AuthReq]` line. That line
 * is read back out of the server's own stdout (teed to a file for this selection by the config), so
 * the `skew=` in Notes is the server's measurement of this browser, not the spec restating a number it
 * chose.
 */

/**
 * The shipped English sentence the login page renders for a lapsed session, read off the disk rather
 * than restated here: a spec that hard-coded the wording would keep passing after the locale file
 * changed, and this assertion is about the string a user actually reads.
 */
const enAuth = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/auth.json'), 'utf8'),
) as { errors: { sessionExpired: string } };

const SESSION_EXPIRED_TEXT = enAuth.errors.sessionExpired;
const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'clientclockuser';
const PASSWORD = 'clientclockpassword';

/**
 * How far the page clock is pushed forward: eight days, past the seven-day life of the token the
 * server issues (`expiresIn: '7d'` in `auth.middleware.ts`). The token therefore stays valid to the
 * server while a page reading its own clock calls it long expired — the exact disagreement this task
 * is about. Read as a constant here because the server's lifetime is not exported; the assertion that
 * the sign-in nevertheless survives is what proves the shift was large enough to matter.
 */
const CLOCK_SHIFT_MS = 8 * 24 * 60 * 60 * 1000;

/** The file the server's stdout is teed to, set for this selection by the config. */
const SERVER_LOG = process.env.QUAY_E2E_CLIENT_CLOCK_SERVER_LOG ?? '';

const SIGNED_IN_SCREENSHOT = path.resolve(process.cwd(), 'artifacts', 'client-clock-skew-signed-in.png');
const BANNER_SCREENSHOT = path.resolve(process.cwd(), 'artifacts', 'client-clock-skew-forged-token-banner.png');

/**
 * Both legs share one throwaway database and the `beforeAll` that creates the account, so they run
 * serially; the 45s per-case budget below is the only bound worth declaring, because the file's own
 * watchdog is what caps the run as a whole.
 */
test.describe.configure({ mode: 'serial', timeout: 45_000 });

/** A well-formed JWT whose signature the real server refuses; the positive control for the 401 arm. */
let forgedToken = '';

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A structurally valid session token the client will happily send and the server will reject.
 *
 * The `exp` claim is live, so nothing about the token asks the client to drop it locally — the client's
 * own lapse check is deliberately NOT the thing under test here. The signature is not the run's
 * `jwt_secret` and cannot be, which is what makes the server answer 401 with `X-Auth-Error`.
 */
const forgedSessionToken = (): string => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ iat: nowSeconds, exp: nowSeconds + 3600, sub: 'forged-session' }),
    base64url('not-the-signature-this-server-issued'),
  ].join('.');
};

/** The signed-in shell's own marker: the settings control only the authenticated app renders. */
const signedInMarker = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true }).first();
/** The login form's own field — present on every auth screen that asks for credentials. */
const loginField = (page: Page) => page.locator('#username');

/** Runs a `page.evaluate` read of the stored token and returns what the page really holds. */
const storedToken = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY);

/** Everything the server has teed so far, or '' when the file is not there yet. */
const readServerLog = (): string => {
  try {
    return fs.readFileSync(SERVER_LOG, 'utf8');
  } catch {
    return '';
  }
};

/** The server's own `POST /api/auth/login` line, once it has been written. */
const loginRequestLine = (): string | undefined =>
  readServerLog()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes('[AuthReq] POST /api/auth/login '));

/**
 * Creates the account once, for the whole file, through the app's own screens against the real server.
 *
 * The first navigation is also the warm-up: Vite transforms the app's module graph here, so the later
 * loads the legs make are served from its cache rather than paying it again. No session is kept — the
 * legs sign in for themselves, so that the only `POST /api/auth/login` this run writes is the
 * clock-shifted one leg 1 makes.
 */
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(40_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  await page.goto('/');

  const createAccount = page.getByRole('button', { name: 'Create Account' });
  await expect(createAccount.or(loginField(page)).first()).toBeVisible({ timeout: 20_000 });
  if (await createAccount.count()) {
    await loginField(page).fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E Client Clock User');
    await page.getByPlaceholder('john@example.com').fill('client-clock@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  }

  forgedToken = forgedSessionToken();
  await context.close();
});

/**
 * Leg 1 — the fault this task is about, plus the reading the server makes of this browser's clock.
 *
 * The page's clock is pushed eight days forward before the app is ever loaded, so every `Date.now()`
 * the shipped client reads — at sign-in, at the reload, on the server's own report — is the shifted
 * one. The sign-in succeeds (the login carries no credential to pre-judge) and, crucially, its body
 * carries the client's clock to the server, which writes the `skew=` this run's Notes quote.
 *
 * Then the reload: the stored token is read back out of `localStorage` and must be byte-for-byte the
 * one the sign-in left there, and the socket the app opens for it must really connect — the app
 * announces itself (`ui.hello`) on the socket the server accepted, which is a connection that only
 * exists if the shifted clock did not stop the credential from being handed over.
 *
 * The refresh endpoint is answered as a 502 for this leg. It is not the subject: with the clock eight
 * days ahead the app's own refresh schedule is already due, so a live refresh would rotate the token
 * within a tick and `auth-token` could not be read back unchanged at all. Answering it 502 (a
 * transient the client is explicitly built to survive) removes that rotation so the reading is about
 * the client's clock judgement, and doubles as its own small proof: the skewed clock does not sign the
 * user out even when the scheduled refresh fails.
 */
test('a page clock eight days ahead keeps the session across a reload — and reports its skew', async ({ page }) => {
  await page.route('**/api/auth/refresh', (route) => route.fulfill({ status: 502, body: 'bad gateway' }));

  // Every reading below is taken on the shifted clock; set before the app is loaded at all.
  await page.clock.setFixedTime(new Date(Date.now() + CLOCK_SHIFT_MS));

  await page.goto('/');
  await expect(loginField(page)).toBeVisible({ timeout: 20_000 });
  await loginField(page).fill(USERNAME);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });

  // The reading the server makes of this browser: its own `[AuthReq]` line for the login just made.
  await expect.poll(() => loginRequestLine() ?? '', { timeout: 15_000 }).toContain('skew=');
  const reportedLogin = loginRequestLine();
  expect(reportedLogin, 'the server must have written its login line').toBeTruthy();
  const skew = Number(/ skew=(-?\d+)$/.exec(reportedLogin ?? '')?.[1]);
  expect(Number.isFinite(skew), `the line must carry a numeric skew: ${reportedLogin}`).toBe(true);
  expect(Math.abs(skew), `the client clock is eight days ahead, so the skew must not read as zero: ${reportedLogin}`)
    .toBeGreaterThan(60_000);
  // Verbatim, for Notes: the server's own measurement of this browser.
  console.log(`[client-clock] server login line: ${reportedLogin}`);

  const tokenBeforeReload = await storedToken(page);
  expect(tokenBeforeReload, 'the sign-in must have stored a credential to replay').toBeTruthy();

  // Only sockets opened AFTER the reload are of interest: the pre-reload socket is expected to close.
  const sockets: { url: string; closed: boolean; hello: boolean }[] = [];
  page.on('websocket', (socket) => {
    const record = { url: socket.url(), closed: false, hello: false };
    sockets.push(record);
    socket.on('framesent', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.includes('ui.hello')) {
        record.hello = true;
      }
    });
    socket.on('close', () => {
      record.closed = true;
    });
  });
  sockets.length = 0;

  await page.reload();

  // The AC's three readings, and the reason the leg exists: the old client landed on the login form.
  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  expect(await storedToken(page)).toBe(tokenBeforeReload);

  // A really connected socket: the app announced itself on it, and it is still open.
  await expect.poll(() => sockets.filter((socket) => socket.hello).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const liveSocket = sockets.find((socket) => socket.hello);
  expect(liveSocket?.url).toContain(`token=${encodeURIComponent(tokenBeforeReload ?? '')}`);
  expect(liveSocket?.closed, 'the socket the app opened for this credential must stay connected').toBe(false);

  await page.screenshot({ path: SIGNED_IN_SCREENSHOT });
});

/**
 * Leg 2 — the positive control.
 *
 * Same app, same server, same shape of credential, except the signature is one the server did not
 * issue: the server verifies it, refuses it with 401 and `X-Auth-Error`, and the app must fall all the
 * way through to the login page with the shipped sentence. This is what keeps leg 1 from being
 * satisfied by an app that never lapses a session at all.
 */
test('a credential the server rejects falls through to the login page with the banner', async ({ page }) => {
  await page.addInitScript(([key, token]) => {
    window.localStorage.setItem(key, token);
  }, [AUTH_TOKEN_KEY, forgedToken] as const);

  // No route: the 401 is the real server's own answer to a real signature check.
  await page.goto('/');

  // The banner lives on the login form, so waiting for the shipped sentence also proves the app fell
  // through to the login page rather than holding the gate.
  await expect(loginField(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible({ timeout: 10_000 });
  // The rejected credential is gone from the client, exactly as it was before this change.
  await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe(null);

  await page.screenshot({ path: BANNER_SCREENSHOT });
});
