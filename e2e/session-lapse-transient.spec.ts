import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';

/**
 * The session-lapse policy against a REAL browser, a REAL server and a REAL JWT.
 *
 * `src/modules/auth/tests/sessionLapsePolicy.test.tsx` proves the rule against a stubbed
 * transport: only a server-side rejection may lapse the session, and a gateway 5xx, an
 * interception page or a dropped connection must leave the stored token and the signed-in
 * session alone. That file can only speak about the code path it stubs. Whether the rule holds
 * when the token is a credential the server really issued, the 502 is really what a gateway in
 * front of a restarting origin answers, and the 401 is really a signature the server refuses —
 * that is a question only a browser driving the shipped app against the shipped server can
 * answer, and it is what this spec answers.
 *
 * Two legs, one per direction:
 *
 *   (1) a live session plus a 502 on `GET /api/auth/user` ⇒ the app is NOT on the login form,
 *       the self-check keeps re-issuing the SAME read, and the stored token is untouched;
 *       once the fault is lifted the reload lands back on the signed-in shell.
 *   (2) a credential the real server rejects ⇒ the login page and the shipped session-expired
 *       sentence, i.e. the positive control that the 401 arm did not go dead.
 *
 * The account is a one-off created against this run's throwaway database, and the token the
 * legs replay is the one the real server hands back for a real credential check — never a
 * token minted here. Nothing about the failure is stubbed: the 502 is fulfilled at the network
 * boundary the browser would otherwise have crossed, and the 401 comes from the server's own
 * signature check.
 */

/**
 * The shipped English sentence the login page renders for a lapsed session, read off the disk
 * rather than restated here: a spec that hard-coded the wording would keep passing after the
 * locale file changed, and this assertion is about the string a user actually reads.
 */
const enAuth = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/auth.json'), 'utf8'),
) as { errors: { sessionExpired: string } };

const SESSION_EXPIRED_TEXT = enAuth.errors.sessionExpired;
const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'sessionlapseuser';
const PASSWORD = 'sessionlapsepassword';
/** The one authenticated read the startup self-check makes, and the blind spot this task closes. */
const USER_ENDPOINT = '**/api/auth/user';
const SIGNED_IN_SCREENSHOT = path.resolve(process.cwd(), 'artifacts', 'session-lapse-transient-recovered-signed-in.png');
const BANNER_SCREENSHOT = path.resolve(process.cwd(), 'artifacts', 'session-lapse-transient-forged-token-banner.png');

/**
 * The per-case budget both legs run under — declared here, then handed to `test.describe.configure`
 * below, so the waits leg 1 derives from it cannot silently outgrow the budget the case is really
 * given. The value is unchanged from the literal that stood in that call.
 */
const CASE_BUDGET_MS = 45_000;

/**
 * How long leg 1's own boot step may spend getting the app on screen: the largest slice of the case
 * budget, because it is the only term here whose cost the criterion does not choose.
 *
 * The partition is the case's own arithmetic — `CASE_BUDGET_MS` (45_000) minus the recovery leg's
 * own `signedInMarker` wait (20_000, further down) minus the read-count window
 * (`READ_COUNT_BUDGET_MS`, 5_000) leaves 20_000 for the boot. The boot gets that share because a
 * cold app is served as a Vite ES-module graph — 547 requests in the failing run measured for this
 * task — and that is the one term that grows with host load. Against this file's own measured
 * healthy leg (3.5s end to end, whole file 16.8s, 2026-10-12) it is roughly six whole legs.
 */
const APP_START_BUDGET_MS = 20_000;

/**
 * How long ONE load of `/` is given to reach `load` and then render, before the boot step loads the
 * document again — see `loadApp`, which treats a load that produced no render as an attempt rather
 * than as the answer.
 *
 * Sized against the healthy load, not against the budget: the file's whole measured leg 1 costs
 * 3.5s, so 8_000 is several times a whole leg — long enough that a merely slow boot is never
 * interrupted mid-flight, short enough that a load whose module graph died (the failure this task
 * was filed against) is retried with most of `APP_START_BUDGET_MS` still in hand.
 */
const APP_START_ATTEMPT_MS = 8_000;

/**
 * How long the startup self-check is given to reach three reads, counted from the moment the app is
 * on screen: the small slice of the case budget, and small on purpose.
 *
 * With the boot step in front of it this window no longer has to cover a cold start at all. The
 * reads it counts are issued by a mount effect of an app that has already rendered, and the gap
 * between the second and the third is the retry that `AUTH_STATUS_RETRY_BASE_MS` in
 * `src/modules/auth/context/AuthContext.tsx` sets (500ms, doubling) — so the count settles about a
 * second after the app is up, and 5_000 is several times that. The fixed 15_000 that stood here
 * before had to cover the boot as well, and that is exactly what made the criterion a race.
 */
const READ_COUNT_BUDGET_MS = 5_000;

/**
 * The app's own readiness signal: a render committed into the document's `#root`.
 *
 * `index.html` ships `<div id="root"></div>` with nothing inside it, so a child of that element
 * exists only once `main.tsx` has been fetched, evaluated and mounted — which is the precondition
 * of every read leg 1 counts, because the self-check that issues them is a mount effect of that
 * tree. `page.goto('/')` resolving is NOT that moment: it waits for `load`, and a Vite-served
 * module graph does not have to be finished (or even alive) for `load` to fire.
 *
 * The failing artifact this task was filed against is that state read off the run itself: its frame
 * snapshot at the predicate's deadline is `<div id="root"></div>`, empty, while its console carries
 * one `Failed to load resource: net::ERR_NETWORK_CHANGED` per module URL — 118 of the graph's
 * requests — so `main.tsx` never executed and no read could ever have arrived.
 */
const APP_ROOT_RENDERED = '#root > *';

/**
 * Both legs replay a session captured once in `beforeAll`.
 *
 * Serial rather than parallel: the legs share one throwaway database and the `beforeAll` that
 * creates the account, and the file is small enough that the per-case budget declared above is the
 * only bound worth declaring — the run's own watchdog is what caps the file as a whole.
 */
test.describe.configure({ mode: 'serial', timeout: CASE_BUDGET_MS });

/** The real JWT the server issued for a real credential check — the credential both legs replay. */
let authToken = '';
/** A well-formed JWT whose signature the real server refuses; the positive control for the 401 arm. */
let forgedToken = '';

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A structurally valid session token the client will happily send and the server will reject.
 *
 * The `exp` claim is live, so `getStoredAuthToken()` hands it to the request instead of dropping
 * it locally — the client's own lapse check is deliberately NOT the thing under test here. The
 * signature is not the run's `jwt_secret` and cannot be, which is exactly what makes the server
 * answer 401 with `X-Auth-Error`: the shape a session whose credential the server no longer
 * honours really arrives in.
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

/**
 * Whether `locator` showed up within `timeoutMs`, as a boolean rather than as a thrown timeout.
 *
 * `attached` and not `visible`: the reading is "React committed a tree into the document", and
 * whether the first element of that tree is on screen is a styling question this step has no
 * business asking. `appears` therefore answers the boot step's one question — did this load render
 * anything at all — without ever committing the case to a wait it cannot leave.
 */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'attached', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/**
 * Loads `/` and stays at it until the app is on screen, bounded by the case budget — and reports how
 * many loads of the document that took.
 *
 * ONE `goto` IS NOT A GUARANTEE THAT THE APP WILL EVER RENDER, and treating it as one is the defect
 * this step exists for. `page.goto('/')` waits for `load`; the app itself is a Vite-served ES-module
 * graph that the browser is still fetching, transforming and evaluating at that moment, and a load
 * whose graph did not survive leaves a document with an empty `#root` that nothing will ever fill.
 * The failing run this task was filed against is exactly that: 118 of the graph's requests were
 * aborted with `net::ERR_NETWORK_CHANGED` about 420ms into the load, `main.tsx` never ran, and the
 * predicate below spent its whole fixed 15s counting reads from an app that had not started —
 * reporting `Received: 0`, which reads as a policy failure and was in fact a load failure. So a load
 * that produced no render is an ATTEMPT: the document is loaded again, and again, until the app is
 * on screen or `APP_START_BUDGET_MS` is gone.
 *
 * THE RELOAD IS ALSO THE RIGHT RECOVERY FOR A MERELY SLOW BOOT, which is why the attempt window can
 * be short. The expensive half of a cold load is Vite's own transform of the module graph, and that
 * half is NOT lost when an attempt is discarded: the modules the attempt did fetch are already
 * transformed and cached by the dev server, so the next load pays the browser round trip and Vite's
 * revalidation rather than the transform again.
 *
 * The failure is thrown HERE, naming what the step saw — how many loads it made, that `#root` never
 * received a child, how many reads the app never reached — so that a red distinguishes "the app
 * never started" from "the app started and the session policy lapsed", which the bare
 * `Received: 0` of a counter predicate could not.
 *
 * A load that throws is not special-cased: the navigation can lose the same race its module graph
 * loses, and a page that is mid-parse when `load` times out can still render during the attempt's
 * own window — so every attempt, thrown or not, ends in the same render check, and only a window
 * that saw no render at all is discarded. That is what keeps the count below honest: a discarded
 * load is one that issued no read, so `userReads` can never be raised by a reload.
 */
const loadApp = async (page: Page, reads: () => number): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + APP_START_BUDGET_MS;
  let loads = 0;
  for (;;) {
    loads += 1;
    // Navigation and render share the attempt's window, so one attempt is bounded by one number.
    const attemptDeadline = Math.min(Date.now() + APP_START_ATTEMPT_MS, deadline);
    const remaining = () => Math.max(1, attemptDeadline - Date.now());
    const description = loads === 1 ? `load 1 of "/"` : `reload ${loads - 1}`;
    try {
      if (loads === 1) {
        await page.goto('/', { timeout: remaining() });
      } else {
        await page.reload({ timeout: remaining() });
      }
    } catch (error) {
      console.log(`[e2e] ${description} did not complete: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (await appears(page.locator(APP_ROOT_RENDERED).first(), remaining())) {
      console.log(
        `[e2e] the app rendered into #root after ${Date.now() - startedAt}ms over ${loads} load(s) of "/" `
        + `(${reads()} ${USER_ENDPOINT} read(s) so far)`,
      );
      return loads;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the app never rendered into #root within ${APP_START_BUDGET_MS}ms and ${loads} load(s) of "/", so the `
        + `startup self-check that issues the user reads never ran: ${reads()} ${USER_ENDPOINT} read(s) seen. `
        + `This is an app that never STARTED, not a session policy that lapsed.`,
      );
    }
    console.log(`[e2e] no render into #root after ${description}; loading "/" again`);
  }
};

/**
 * Signs in once, for the whole file, through the app's own screens against the real server.
 *
 * The account is created here if this run's database is empty (a fresh run always is), the
 * onboarding wizard is finished the way a person finishes it, and then the session is dropped
 * and re-established through the LOGIN form — so the token the legs replay is the answer to a
 * real `POST /api/auth/login`, not a registration the setup flow left behind.
 */
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(40_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // The first navigation is also the warm-up: Vite transforms the app's module graph here, so
  // the three later loads the legs make are served from its cache rather than paying it again.
  await page.goto('/');

  const createAccount = page.getByRole('button', { name: 'Create Account' });
  await expect(createAccount.or(loginField(page)).first()).toBeVisible({ timeout: 20_000 });
  if (await createAccount.count()) {
    await loginField(page).fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E Session User');
    await page.getByPlaceholder('john@example.com').fill('session-lapse@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  }

  // Drop whatever session the setup flow left and sign in again through the login form. The
  // reload is what makes the drop real: it resets the provider's in-memory session, so the form
  // the next screen shows is the login screen and the token it earns comes from `/api/auth/login`.
  await page.evaluate((key) => window.localStorage.removeItem(key), AUTH_TOKEN_KEY);
  await page.goto('/');
  await expect(loginField(page)).toBeVisible({ timeout: 20_000 });
  await loginField(page).fill(USERNAME);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });

  authToken = (await storedToken(page)) ?? '';
  if (!authToken) {
    throw new Error('the real login completed but left no auth-token in localStorage — the legs cannot replay it');
  }
  forgedToken = forgedSessionToken();

  await context.close();
});

/**
 * Leg 1 — the fault this task is about.
 *
 * The app is reloaded with a genuinely valid session and every `GET /api/auth/user` fulfilled
 * as a 502, which is what a tunnel in front of a restarting origin answers for roughly ten
 * seconds. The two readings are the AC's own: no login form, and the token still in
 * `localStorage`.
 *
 * The readings are taken only after the app is ON SCREEN and the self-check has been seen to RETRY,
 * which together are what make them a measurement rather than a race with the first paint. The first
 * half of that is `loadApp`: a load that rendered nothing is an attempt rather than an answer, and
 * it is why this leg no longer spends a fixed window counting reads an app that never started could
 * not have made. The second half is the floor of three below. Counting alone does not establish the
 * retry, because the client runs in React's development StrictMode and its mount effect is
 * double-invoked: two reads arrive even from a self-check that lapses the session on the first
 * failure and never tries again. So the floor is three — the first count that can only be reached by
 * a self-check that took the failure, kept the stored token, and issued the SAME read again. (A
 * lapsed session never gets there: it clears the token on the first 502, and a cleared token is
 * never sent again.)
 *
 * Then the fault is lifted and the page reloaded, which is the DoD's third clause: the same
 * stored token still authenticates, so the run ends on the signed-in shell.
 */
test('a gateway 502 on the user read does not sign the user out', async ({ page }) => {
  await page.addInitScript(([key, token]) => {
    window.localStorage.setItem(key, token);
  }, [AUTH_TOKEN_KEY, authToken] as const);

  let userReads = 0;
  await page.route(USER_ENDPOINT, (route) => {
    userReads += 1;
    return route.fulfill({ status: 502, body: 'bad gateway' });
  });

  // The reads this leg counts cannot exist before the app is on screen, so the app is brought up
  // first and the counting starts only once it is: `loadApp` is what loads `/` here, because one
  // load of the document is one attempt at it and not a guarantee — see it for the load this
  // criterion was reading as a session-policy failure.
  await loadApp(page, () => userReads);

  // StrictMode's double-invoke supplies the first two; only a genuine retry reaches three.
  await expect.poll(() => userReads, {
    message: `the app was on screen, but the startup self-check made only this many ${USER_ENDPOINT} reads`,
    timeout: READ_COUNT_BUDGET_MS,
  }).toBeGreaterThanOrEqual(3);

  // The AC's two readings, taken while the fault is still in force.
  await expect(loginField(page)).toHaveCount(0);
  expect(await storedToken(page)).toBe(authToken);

  // Lift the fault. The next reload is the recovery the self-check's backoff exists for.
  await page.unroute(USER_ENDPOINT);
  await page.reload();
  await expect(signedInMarker(page)).toBeVisible({ timeout: 20_000 });
  expect(await storedToken(page)).toBe(authToken);
  await page.screenshot({ path: SIGNED_IN_SCREENSHOT });
});

/**
 * Leg 2 — the positive control.
 *
 * Same app, same server, same shape of credential, except the signature is one the server did
 * not issue: the server verifies it, refuses it with 401 and `X-Auth-Error`, and the app must
 * fall all the way through to the login page with the shipped sentence. This is what keeps leg
 * 1 from being satisfied by an app that never lapses a session at all.
 */
test('a credential the server rejects falls through to the login page with the banner', async ({ page }) => {
  await page.addInitScript(([key, token]) => {
    window.localStorage.setItem(key, token);
  }, [AUTH_TOKEN_KEY, forgedToken] as const);

  // No route: the 401 is the real server's own answer to a real signature check.
  await page.goto('/');

  // The banner lives on the login form, so waiting for the shipped sentence also proves the app
  // fell through to the login page rather than holding the gate.
  await expect(loginField(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(SESSION_EXPIRED_TEXT).first()).toBeVisible({ timeout: 10_000 });
  // The rejected credential is gone from the client, exactly as it was before this change.
  await expect.poll(() => storedToken(page), { timeout: 10_000 }).toBe(null);

  await page.screenshot({ path: BANNER_SCREENSHOT });
});
