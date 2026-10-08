import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * The shipped English wording, read off the disk rather than restated here.
 *
 * The switch this spec names is the app's own copy, so a spec that carried its own would keep passing after
 * the locale file changed while the words a user meets did not.
 */
type ChatLocale = {
  resident: { toggle: string };
};

const enChat = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
) as ChatLocale;

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The subject is the ENTER key path through the composer, read the way a user meets it: a real project from
// the run's own seeded HOME, a real session row allocated by the send the key produced, and the lifecycle
// mode read back from the server the session was addressed to. Nothing here rebuilds the mode client-side —
// `GET /api/session-hosts` is the same projection a restart uses to find a resident session whose process it
// dropped, so the `resident` this spec prints is the server's own stored preference and not the switch's
// local state. The host half is read from the same endpoint's `hosts` array, so "a resident host really
// exists for this session" is the process table's answer, not an inference from the switch.
//
// The switch POSITION is the whole of the intent. The consent gate that used to stand between the switch and
// the send — and the disclosure tick that armed it — was retired by the 2026-09-29 product change
// (`gap-resident-toggle-relocate-drop-consent-gate`), and its locale key is gone from every `chat.json`. So
// this file drives the switch and nothing else; there is no separate tick state left for it to set.
//
// The two cases are the pair the reading needs. (a) is the load-bearing one: with the switch on, Enter must
// record the resident intent through the composer's submit entry, so the server stores the session resident
// and a resident host process holds it. (b) is the positive control: with the switch off, the same key must
// send and land `per-run` — without it the `resident` reading above would have no resolution, since it would
// score the same for every session. `e2e/resident-enable-consent.spec.ts` (AC-171) presses the SEND BUTTON;
// that spec cannot see this defect, because the Enter path used to reach the send directly and skip the
// intent the switch was showing. Reading the key is this file's whole job.

const COMPOSER = '[data-slot="prompt-input-textarea"]';
/** The disclosure component's own slot — the marker its module declares. */
const NOTICE = '[data-slot="resident-consent-notice"]';
const AUTH_TOKEN_KEY = 'auth-token';
/**
 * The first-paint mirror of the account's preferences, the same key the app writes.
 *
 * `src/shared/userSettings.ts` reads it synchronously so the first render already knows the stored provider;
 * the server's copy is authoritative and is what the legs below write. Priming the mirror removes the one
 * frame in which the composer would be drawing the default provider's capability while the hydrate was in
 * flight.
 */
const PREFERENCES_MIRROR_KEY = 'user-preferences';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The one provider this spec works under: the capability matrix lists `resident` for it. */
const RESIDENT_PROVIDER = 'claude';

/** Absolute path of the workspace playwright.config.ts seeded for its composer specs. */
let workspace = '';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * The client's own base URL, as this run published it.
 *
 * `use.baseURL` in `playwright.config.ts` is built from this same `QUAY_E2E_CLIENT_PORT`, so the shared
 * context addresses exactly the client the built-in `page` fixture would have. It is read here because
 * `browser.newContext()` — unlike the built-in context fixture, which threads `use.baseURL` through
 * `_combinedContextOptions` — does not inherit `use.baseURL`, and a relative `page.goto('/')` needs it.
 */
const clientBaseURL = (): string => {
  const port = process.env.QUAY_E2E_CLIENT_PORT;
  if (!port) {
    throw new Error('QUAY_E2E_CLIENT_PORT is unset — playwright.config.ts must publish the run\'s client port');
  }
  return `http://127.0.0.1:${port}`;
};

/**
 * How long this run's client is given to answer before the first navigation is attempted.
 *
 * The bound sits inside the criterion's own ceilings — `playwright.config.ts` kills a single-spec run at 55s
 * and the gate at 60s — so a client that never boots fails naming its own URL and the last answer it gave,
 * rather than being killed from outside with nothing to read. A healthy run pays this only once, on the first
 * poll, because the client is already up by the time the spec runs.
 */
const CLIENT_READY_MS = 20_000;

/**
 * Waits, bounded, until this run's client actually answers.
 *
 * The first navigation pays for the client's whole cold boot, and a loaded host can meet the window in which
 * Vite has torn its dev server down to re-optimise dependencies (`[BABEL] ... deoptimised ... react-scan.js`
 * is the note the failing run printed) and not yet brought it back: the navigation then lands on Chromium's own
 * `chrome-error://chromewebdata/` page, and a spec that only waited for a sign-in control would spend its whole
 * budget reading an error page. Polling the client's own root — the URL `playwright.config.ts` was told to
 * serve — tells "the client is not up yet" (a connection refusal or a non-2xx answer, retried here) apart from
 * "the client is up and the app is slow" (the visibility waits below). Throws naming the URL and the last thing
 * it saw, so a client that really never boots is a red that says so rather than a bare `<empty body>`.
 */
const waitForClient = async (budgetMs = CLIENT_READY_MS): Promise<void> => {
  const url = `${clientBaseURL()}/`;
  const deadline = Date.now() + budgetMs;
  let lastFailure = 'no attempt completed';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the client at ${url} never answered within ${budgetMs}ms (last: ${lastFailure})`);
};

/**
 * Signs in once for the whole file, on the file's one shared page.
 *
 * The cases are `serial`, so they reuse the context and page `beforeAll` builds (see the `test` extension
 * below) rather than each drawing its own: onboarding runs once here and the captured session is replayed by
 * `restoreSession`. Before the first navigation the client's own root is polled to readiness (`waitForClient`),
 * and a navigation that lands on Chromium's error page is told apart from a merely slow one — see the loop.
 * Same helper as `e2e/resident-enable-consent.spec.ts`.
 */
const ensureSignedIn = async (page: Page) => {
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  const arrived = createAccount.or(settings).or(page.locator('#username')).first();

  // The client's own boot is what the first navigation pays for; wait for it to answer before navigating, so a
  // dependency-re-optimisation window is waited out here rather than landed on as an error page below.
  await waitForClient();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/').catch(() => undefined);
    // An error page is not "the app is slow": the client never answered that navigation, so waiting the full
    // visibility budget on it only burns the run's clock. Tell it apart and retry at once instead.
    if (page.url().startsWith('chrome-error://')) {
      lastError = new Error(`the navigation landed on ${page.url()} — the client did not answer it`);
      await page.waitForTimeout(500);
      continue;
    }
    try {
      await expect(arrived).toBeVisible({ timeout: 15_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1_000);
    }
  }
  if (lastError !== null) {
    const body = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `the app never reached a sign-in, onboarding or signed-in screen at ${page.url()}: `
        + `${body.replace(/\s+/g, ' ').trim().slice(0, 400) || '<empty body>'}`,
    );
  }

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

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';

/**
 * The one browser context this whole file draws in.
 *
 * The run-level cost this file used to pay three times over is the client's cold load: `bootstrapAuth` built a
 * context of its own and each of the two cases came with its own test-scoped `context`/`page`, so every one
 * re-fetched and re-executed the client's whole module graph. The cases are `serial` and there is only one
 * worker, so one context created in `beforeAll` and closed in `afterAll` serves both; the client's cold load
 * then happens exactly once, in `beforeAll`, and the cases below reuse a warm context. Same shape as
 * `e2e/resident-enable-consent.spec.ts` (AC-171, commit 0f554342).
 */
let sharedContext: BrowserContext | undefined;
/** The single page drawn inside `sharedContext` — the `page` every case is handed (see the `test` extension below). */
let sharedPage: Page | undefined;

const bootstrapAuth = async (page: Page) => {
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the legs cannot authenticate');
  }
};

/**
 * The file's `test`, with the built-in `page` fixture overridden to hand every case `sharedPage`.
 *
 * The default `page` fixture builds a fresh context per test, which is the run-level cost this file is here to
 * remove; `beforeAll` builds the one context, so this override only forwards it. Keeping the fixture name means
 * every case body below is unchanged — they still take `{ page, request }` — and a case that somehow runs before
 * `beforeAll` has built the page fails naming that, rather than silently drawing a second cold context.
 */
const test = base.extend<{ page: Page }>({
  page: async ({}, use) => {
    if (!sharedPage) {
      throw new Error('the file-shared page was never created — test.beforeAll must run before any case draws');
    }
    await use(sharedPage);
  },
});

/** Puts the captured session into the context the test's own options already built, mirroring the provider. */
const restoreSession = async (page: Page, provider?: string) => {
  await page.addInitScript(([key, token, mirrorKey, mirrorValue]) => {
    try {
      window.localStorage.setItem(key, token);
      if (mirrorValue) {
        window.localStorage.setItem(mirrorKey!, JSON.stringify({ selectedProvider: mirrorValue }));
      }
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken, provider ? PREFERENCES_MIRROR_KEY : null, provider ?? null] as const);
};

/** Writes the account's selected provider through the app's own preference API, and reads it back. */
const setSelectedProvider = async (request: APIRequestContext, provider: string) => {
  const written = await request.patch('/api/user/preferences', {
    headers: auth(authToken),
    data: { selectedProvider: provider },
  });
  expect(written.ok(), `PATCH /api/user/preferences answered ${written.status()}`).toBe(true);

  const readBack = await request.get('/api/user/preferences', { headers: auth(authToken) });
  const body = (await readBack.json()) as { preferences?: { selectedProvider?: string } };
  expect(
    body.preferences?.selectedProvider,
    'the stored provider must be the one just written — otherwise the leg below would read the default',
  ).toBe(provider);
};

/** One host as `GET /api/session-hosts` projects it: enough to say which session a resident process holds. */
type HostRow = { mode: string; state: string; bindings: { appSessionId: string }[] };
/** One session's stored mode, as the same endpoint projects it off the session rows. */
type SessionRow = { appSessionId: string; lifecycleMode: string };

/** The whole listing: both halves of the one endpoint, read together so they cannot disagree. */
const sessionHosts = async (request: APIRequestContext): Promise<{ hosts: HostRow[]; sessions: SessionRow[] }> => {
  const response = await request.get('/api/session-hosts', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as { data?: { hosts?: HostRow[]; sessions?: SessionRow[] } };
  return { hosts: body.data?.hosts ?? [], sessions: body.data?.sessions ?? [] };
};

/** Every stored lifecycle mode, keyed by session id. */
const sessionModes = async (request: APIRequestContext): Promise<Map<string, string>> => {
  const { sessions } = await sessionHosts(request);
  return new Map(sessions.map((row) => [row.appSessionId, row.lifecycleMode]));
};

const modeOf = async (request: APIRequestContext, sessionId: string) =>
  (await sessionModes(request)).get(sessionId);

/** True while some live host holds `sessionId` under the given mode. */
const hostHolds = async (request: APIRequestContext, sessionId: string, mode: string): Promise<boolean> => {
  const { hosts } = await sessionHosts(request);
  return hosts.some(
    (host) => host.mode === mode
      && host.state !== 'closed'
      && host.bindings.some((binding) => binding.appSessionId === sessionId),
  );
};

/**
 * Reads one session's mode until it is `expected`, and returns whatever it last read.
 *
 * The write this waits for travels the app's own path — the composer's send allocates the session, then asks
 * the server to keep it running — so the two are not adjacent in time. Returning the last reading rather
 * than asserting inside the loop lets the caller print what it actually saw, which is the difference between
 * a red that names the value and one that names an expectation.
 */
const waitForMode = async (
  request: APIRequestContext,
  sessionId: string,
  expected: string,
  budgetMs = 20_000,
): Promise<string> => {
  const deadline = Date.now() + budgetMs;
  let last = await modeOf(request, sessionId);
  while (last !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await modeOf(request, sessionId);
  }
  return last ?? 'undefined';
};

/** Reads the host table until a `mode` host holds `sessionId`, and reports what it last saw. */
const waitForHost = async (
  request: APIRequestContext,
  sessionId: string,
  mode: string,
  budgetMs = 20_000,
): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  let last = await hostHolds(request, sessionId, mode);
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await hostHolds(request, sessionId, mode);
  }
  return last;
};

const composer = (page: Page) => page.locator(COMPOSER);

/**
 * The seeded project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; the card's accessible name
 * sits on a heading rather than on the clickable element. Both are targeted so the spec says "open this
 * project" rather than naming markup. Same helper as `e2e/resident-enable-consent.spec.ts`.
 */
const projectRow = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }))
    .first();

/**
 * How long the sidebar is given to draw the seeded project before the composer is opened.
 *
 * The row appears only once the client has booted and answered its own project listing, and a loaded host
 * pushes that past the fixed five seconds the click here used to carry: the click then timed out, the
 * failure was swallowed, and the retry loop behind it spent what was left of the case on a row that was
 * never on screen. This budget is chosen under the criterion's own ceilings — the gate kills the run at
 * 60s and the config's watchdog at 55s — so a slow sidebar is waited out rather than given up on.
 */
const PROJECT_ROW_READY_MS = 20_000;

/**
 * Opens a composer bound to the seeded project, through the app's own "New Session" entry point.
 *
 * The composer only renders once a project is selected, and this run seeds more than one project, so the
 * selection is made the way a user makes it. The project row is a toggle, so a click landing mid-render can
 * leave it collapsed; the loop retries. Same helper as `e2e/resident-enable-consent.spec.ts`.
 */
const openComposer = async (page: Page) => {
  const textarea = composer(page);
  const row = projectRow(page);
  const newSession = page.getByRole('button', { name: 'New Session' }).first();

  // Wait for the row to be on screen, then click it with no fixed sub-deadline of its own: the case's own
  // budget is the bound, so a row that is merely late is waited for instead of being abandoned after 5s.
  await expect(row).toBeVisible({ timeout: PROJECT_ROW_READY_MS }).catch(() => undefined);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;

    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }

    if (!(await newSession.isVisible().catch(() => false))) {
      await row.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
};

/** The switch, on the new-session empty state — its only home — once the capability matrix has answered. */
const residentToggle = (page: Page) => page.getByRole('switch', { name: enChat.resident.toggle });

/**
 * Opens a new-session composer and, when asked, flips the resident switch on.
 *
 * The two legs differ only in this prefix, so it lives in one place: the switch OFF is the positive
 * control's state, the switch ON is the one whose Enter send must land resident. The switch lives on
 * the new-session empty state's model card (the composer no longer draws one), and `openComposer`
 * lands on that screen, so the page-wide locator finds it there. Nothing is ticked afterwards — the
 * switch position is the whole of the intent, so there is no separate tick to set.
 */
const openResidentComposer = async (page: Page, { switchOn }: { switchOn: boolean }) => {
  await page.goto('/');
  await openComposer(page);

  if (!switchOn) return;

  const toggle = residentToggle(page);
  await expect(
    toggle,
    `${RESIDENT_PROVIDER} lists resident in its capability matrix, so the new-session screen must offer the switch`,
  ).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  await expect(page.locator(NOTICE), 'opening the switch must disclose the mode in place').toBeVisible();
};

test.describe.configure({ mode: 'serial' });
// Each of the two cases gets an explicit budget of its own. It sits above the two `waitFor*` budgets (20s each)
// so it never pre-empts a legitimate wait, and below both the criterion's 60s gate and the config's 55s run
// watchdog so a case that outruns either fails while naming itself rather than being killed from outside — the
// default per-case budget is the 60s the gate also uses, which no case can ever reach before being killed.
test.describe.configure({ timeout: 45_000 });

test.beforeAll(async ({ browser }) => {
  // Onboarding is the expensive part of a fresh database and only happens once for the file — and it now happens
  // in the file's one shared context, so the client's cold load (the module graph Vite transforms on first
  // request, the browser's empty cache) is paid here exactly once instead of once per case plus once in a
  // bootstrap context of its own. Both cases below reuse this context and page.
  test.setTimeout(120_000);
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'mobile-send-key-workspace');
  sharedContext = await browser.newContext({ baseURL: clientBaseURL() });
  sharedPage = await sharedContext.newPage();
  await bootstrapAuth(sharedPage);
});

test.afterAll(async () => {
  // The one context this file opened; Playwright owns the browser, this file owns its context.
  await sharedContext?.close();
});

test('AC-180 (a): Enter with the resident switch on allocates a resident session, and a resident host holds it', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  await openResidentComposer(page, { switchOn: true });

  const textarea = composer(page);
  await textarea.fill('enter key resident probe');
  await textarea.press('Enter');

  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`created.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'resident');
  console.log(`session.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'the session an Enter send addressed with the switch on must read back as resident from the server — the '
      + 'key reached the send without recording the resident intent the switch was showing',
  ).toBe('resident');

  const heldByResidentHost = await waitForHost(request, createdSessionId, 'resident');
  const { hosts } = await sessionHosts(request);
  console.log(`host.resident.bindsSession=${heldByResidentHost}`);
  console.log(`hosts=${JSON.stringify(hosts.map((host) => ({ mode: host.mode, state: host.state, sessions: host.bindings.map((b) => b.appSessionId) })))}`);
  expect(
    heldByResidentHost,
    'a session stored resident must have a resident host holding it — the mode is the stored wish, the host is '
      + 'the process that is really there',
  ).toBe(true);
});

test('AC-180 (b) control: Enter with the resident switch off still sends, and lands per-run', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  // No switch interaction at all: this is the shape every non-resident send has always had.
  await openResidentComposer(page, { switchOn: false });

  const textarea = composer(page);
  await textarea.fill('enter key per-run control');
  await textarea.press('Enter');

  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`control.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'per-run');
  console.log(`control.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'a session created with the switch off must read per-run — otherwise the resident reading above has no '
      + 'resolution and would score the same for every session',
  ).toBe('per-run');
});
