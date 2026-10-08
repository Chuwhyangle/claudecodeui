import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * The shipped English wording, read off the disk rather than restated here.
 *
 * Every sentence this spec asserts on is the app's own copy, so a spec that carried its own strings would
 * keep passing after the locale file changed — and the whole point of the assertions below is that the words
 * the user is shown are the words the app ships. Same reading as `e2e/mobile-composer-send-key.spec.ts`.
 */
type ChatLocale = {
  resident: { toggle: string; notice: { title: string; bypass: string; trustBoundary: string } };
  input: { send: string };
  providerSelection: { clickToChange: string };
};

const enChat = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
) as ChatLocale;

/** The menu's own words, which live in the sidebar namespace rather than chat's. */
const enSidebar = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/sidebar.json'), 'utf8'),
) as { sessionMenu: { convertToResident: string } };

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The subject is where the resident switch lives and what the disclosure in front of it is allowed to do. It
// is read the way a user meets it: a real project from the run's own seeded HOME, the real new-session screen,
// a real session row in the real sidebar, and the lifecycle mode read back from the server the send was
// addressed to. Nothing here rebuilds the mode client-side — `GET /api/session-hosts` is the same projection
// a restart uses to find a resident session whose process it dropped, so the `resident` this spec prints is
// the server's own stored preference and not the switch's local state.
//
// Two things this file is deliberately about, because they are what the redesign turns on:
//
//   * the switch is on the screen *before* the first turn (under the new-session model card) and
//     nowhere else — a session that already has a transcript draws no switch in its composer, and is
//     converted from the session menu instead;
//   * the disclosure is a read-only hint. Nothing about it may sit between the user and the switch or
//     the conversion: flipping the switch is the whole of the intent, and the send that follows is
//     resident. That is what the falsifying variant recorded in the task attacks, and the `aria-checked`
//     readings below are the assertions it reds on.
//
// There is no seam in this file: the capability matrix, the mode before and after a conversion, and the mode of
// a session nobody asked to keep running all come from the real server, and the two reads that could not be
// stated against it are called out where they would have gone.

const COMPOSER = '[data-slot="prompt-input-textarea"]';
/** The composer's send button, named by the shipped label rather than by a hard-coded word. */
const SEND_BUTTON = `button[aria-label="${enChat.input.send}"]`;
/** The hint's trigger — the `ⓘ` on each of the three surfaces that offer the mode. */
const HINT = '[data-slot="resident-consent-notice"]';
/**
 * The hint's own text.
 *
 * Read page-wide rather than scoped to its trigger, because the tooltip portals its content to
 * `document.body` — it is not a descendant of anything the trigger's own container could name. Only one hint
 * is open at a time (the others are hover-driven and the pointer is over exactly one), so the count is
 * asserted rather than assumed.
 */
const HINT_CONTENT = '[data-slot="resident-hint-content"]';
/** The resident switch itself — the new-session empty state's, its only home. */
const SWITCH = '[data-resident-enable="true"]';
/** Every message row the transcript has mounted. */
const MESSAGE = '[data-message-style]';
/** Any checkbox at all. */
const CHECKBOX = 'input[type=checkbox]';
/**
 * The surfaces that could carry the retired gate: the transcript pane, the composer, and the session menu.
 *
 * The criterion's "no checkbox appears" cannot be read page-wide, and the reason is not this task's to fix:
 * `ProjectWorkspaceShell` mounts the Quick Settings drawer on every screen, and the drawer's three checkboxes
 * (Show raw parameters / Show thinking / Send by Ctrl+Enter) are slid off-screen with it but stay in the DOM,
 * so an absolute page-wide count is ≥3 everywhere. The reading below is therefore taken on the surfaces the
 * gate used to live on, plus a before/after count that catches a checkbox the switch would have *added*.
 */
const RESIDENT_SURFACES = '.chat-messages-pane input[type=checkbox], [data-slot="prompt-input"] input[type=checkbox]';
const AUTH_TOKEN_KEY = 'auth-token';
/**
 * The first-paint mirror of the account's preferences.
 *
 * `src/shared/userSettings.ts` reads this blob synchronously so the very first render already knows the
 * stored provider; the server's copy is authoritative and is what the legs below change. Priming the mirror
 * is not a stub — it is the same key the app writes — it only removes the one frame in which the composer
 * would still be drawing the default provider while the hydrate was in flight.
 */
const PREFERENCES_MIRROR_KEY = 'user-preferences';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The provider the account starts on, and the one every leg but the matrix leg works under. */
const RESIDENT_PROVIDER = 'claude';

/** Absolute path of the workspace playwright.config.ts seeded for its own composer spec. */
let workspace = '';
/**
 * A seeded Claude transcript, indexed at boot like a developer's own `~/.claude/projects`.
 *
 * The sidebar row this spec converts has to be a session the app really discovered, so it comes from the run's
 * fixture rather than from an API call: an API-created session writes a row but no transcript, and the sidebar
 * lists what the synchronizer indexed — and the legs that read the composer's own switch need a session that
 * really has messages in it.
 */
const SEEDED_SESSION_ID = 'e2e-mobile-send-key';
const SEEDED_SESSION_NAME = 'mobile-send-key';

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';

/**
 * The one browser context this whole file draws in.
 *
 * The run-level cost this file used to pay four times over is the client's cold load: each case came with its
 * own test-scoped `context`/`page`, so every case paid for a context with no HTTP cache and re-fetched the
 * client's whole module graph, and the onboarding walk in `beforeAll` paid for it once more. The cases are
 * `serial` and there is only one worker, so one context created in `beforeAll` and closed in `afterAll` serves
 * all four; the client's cold load then happens exactly once, in `beforeAll`, and the cases below reuse it.
 */
let sharedContext: BrowserContext | undefined;
/** The single page drawn inside `sharedContext` — the `page` every case is handed (see the `test` extension below). */
let sharedPage: Page | undefined;

/**
 * The empty state's disclosed copy, kept for the comparison the transcript leg takes.
 *
 * A module-level value rather than an annotation: `test.info()` is per-test, so a value recorded in the first
 * case is invisible to the second — and the comparison across the switch's two homes is exactly what AC2 asks
 * for. Written only by the case that reads it; a red before that case leaves it empty and the comparison on
 * the other side fails loudly rather than silently passing on ''.
 */
let emptyStateHintCopy = '';

/** Collapses the runs of whitespace `innerText` inserts between block elements, on both sides of a compare. */
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Signs in once for the whole file.
 *
 * Every case gets its own browser context, so the default `page` fixture starts unauthenticated. Re-running
 * onboarding per case would cost more than the whole budget, so the session is captured here and replayed into
 * each context by `restoreSession`. Same helper as `e2e/mobile-composer-send-key.spec.ts`, except for the wait
 * below: the first navigation of a run is the one that pays for the client's module graph, and the template's
 * five seconds is short enough that a loaded host loses that race and reports "element not found" — a red that
 * names nothing the reader can act on. The wait is retried and bounded, and the diagnosis is printed.
 */
const ensureSignedIn = async (page: Page) => {
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  const arrived = createAccount.or(settings).or(page.locator('#username')).first();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/').catch(() => undefined);
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

const bootstrapAuth = async (page: Page) => {
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the legs cannot authenticate');
  }
};

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

/**
 * Puts the captured session into the context the test's own options already built, and — for the legs that
 * need a provider other than the default — primes the preference mirror so the first paint agrees with it.
 */
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

/** The capability matrix as the backend answers it, parsed exactly the way the app's own hook parses it. */
const providerCapabilities = async (request: APIRequestContext) => {
  const response = await request.get('/api/providers/capabilities', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/providers/capabilities answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as {
    data?: { providers?: { provider: string; lifecycleModes?: string[] }[] };
  };
  return body.data?.providers ?? [];
};

/** Every session's stored lifecycle mode, as `GET /api/session-hosts` projects it off the session rows. */
const sessionModes = async (request: APIRequestContext): Promise<Map<string, string>> => {
  const response = await request.get('/api/session-hosts', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as {
    data?: { sessions?: { appSessionId: string; lifecycleMode: string }[] };
  };
  return new Map((body.data?.sessions ?? []).map((row) => [row.appSessionId, row.lifecycleMode]));
};

const modeOf = async (request: APIRequestContext, sessionId: string) =>
  (await sessionModes(request)).get(sessionId);

/**
 * Reads one session's mode until it is `expected`, and returns whatever it last read.
 *
 * The write this waits for travels the app's own path — the composer's send allocates the session, then asks
 * the server to keep it running — so the two are not adjacent in time. Returning the last reading rather than
 * asserting inside the loop lets the caller print what it actually saw, which is the difference between a red
 * that names the value and one that names an expectation.
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

const composer = (page: Page) => page.locator(COMPOSER);

/** The switch as this screen draws it: the composer's, the empty state's, or the menu's. */
const switches = (page: Page, scope?: string) =>
  page.locator(scope ? `${scope} ${SWITCH}` : SWITCH);

/** The hint's trigger, scoped to the surface being read. */
const hintTrigger = (page: Page, scope?: string) =>
  page.locator(scope ? `${scope} ${HINT}` : HINT);

/** The composer's send button, mid-flight state included: `disabled` is one of the readings this spec takes. */
const submitDisabled = (page: Page) =>
  page.locator(SEND_BUTTON).evaluate((element) => (element as HTMLButtonElement).disabled);

/**
 * The seeded project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; the card's accessible name
 * sits on a heading rather than on the clickable element. Both are targeted so the spec says "open this
 * project" rather than naming markup. Same helper as `e2e/mobile-composer-send-key.spec.ts`.
 */
const projectRow = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }))
    .first();

/** One seeded session's own row in the sidebar. */
const sessionLink = (page: Page, name: string) =>
  page.locator('a[href^="/session/"]').filter({ hasText: name });

/**
 * Puts a composer bound to the seeded project on screen.
 *
 * The composer only renders once a project is selected, and the app auto-selects only when the run seeded
 * exactly one project — this run seeds one per spec, so the selection is made the way a user makes it. Same
 * retry loop as `e2e/mobile-composer-send-key.spec.ts`, for the same reason: the project row is a toggle, and
 * a click landing mid-render leaves it collapsed.
 */
/**
 * How long the sidebar is given to draw the seeded project before anything is clicked.
 *
 * The row appears only once the client has booted and answered its own project listing, and a loaded host
 * pushes that past the fixed five seconds the clicks below used to carry: the click then timed out, the
 * failure was swallowed, and the retry loop spent what was left of the case on a row that was never on
 * screen — the "element not found" red the driver recorded names nothing the reader can act on. This budget
 * is chosen under the criterion's own ceilings — the gate kills the run at 60s and the config's watchdog at
 * 55s — so a slow sidebar is waited out rather than given up on. Same value and reason as
 * `e2e/resident-enter-send.spec.ts`.
 */
const PROJECT_ROW_READY_MS = 20_000;

/**
 * How long one click's own consequence is given before the loop below re-reads and retries.
 *
 * Every click in `openComposer` is a toggle, so the state the *next* step needs is the read that says the click
 * landed — waiting for it is both faster and more honest than a fixed `waitForTimeout`. The old fixed 500ms was
 * paid on every healthy run (the state is usually on screen within a few hundred ms) and was still a guess under
 * load. Bounded well under the case's own 45s budget, and small enough that all five attempts plus the final 15s
 * assertion stay inside it, so a click that genuinely did nothing still fails naming this case rather than being
 * killed from outside by the run watchdog.
 */
const COMPOSER_STEP_READY_MS = 2_000;

const openComposer = async (page: Page) => {
  const textarea = composer(page);
  const row = projectRow(page);
  const newSession = page.getByRole('button', { name: 'New Session' }).first();

  // Wait for the row to be on screen, then click it with no fixed sub-deadline of its own: the case's own
  // budget is the bound, so a row that is merely late is waited for instead of being abandoned after five.
  await expect(row).toBeVisible({ timeout: PROJECT_ROW_READY_MS }).catch(() => undefined);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;

    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        // Opening the phone-width sidebar is what reveals the project list, so the New Session control is the
        // read that follows; wait for it rather than sleeping a fixed 400ms after the click.
        await newSession.waitFor({ state: 'visible', timeout: COMPOSER_STEP_READY_MS }).catch(() => undefined);
      }
    }

    if (!(await newSession.isVisible().catch(() => false))) {
      // Selecting the project reveals its session list and the New Session control with it.
      await row.click().catch(() => undefined);
      await newSession.waitFor({ state: 'visible', timeout: COMPOSER_STEP_READY_MS }).catch(() => undefined);
    }
    if (await newSession.isVisible().catch(() => false)) {
      // New Session is the click that draws the composer; the composer is the read that follows it.
      await newSession.click().catch(() => undefined);
      await textarea.waitFor({ state: 'visible', timeout: COMPOSER_STEP_READY_MS }).catch(() => undefined);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
};

/**
 * The new-session screen: the model card the switch was relocated under.
 *
 * `openComposer` only guarantees a composer; this case is about a session that does not exist yet, so the
 * app's own "New Session" entry point is pressed when the card is not already what is on screen.
 */
const openNewSession = async (page: Page) => {
  const card = page.getByText(enChat.providerSelection.clickToChange);
  await openComposer(page);
  if (!(await card.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'New Session' }).first().click().catch(() => undefined);
  }
  await expect(
    card,
    'the new-session model card is what the switch was relocated under',
  ).toBeVisible({ timeout: 15_000 });
};

/**
 * Re-confirms the resident switch is still on, and turns it back on if a mid-run remount has reset it.
 *
 * The switch's position is React state on the `ChatInterface` ancestor (`residentEnabled`), and an HMR update
 * that remounts `App.tsx` — a live edit anywhere on the module graph does this — clears that state to `false`
 * while the click that set it has already happened. A send taken in that window consults the reset intent and
 * lands per-run, which is indistinguishable from a real regression in the reading the send is checked against
 * (the driver's `quay-e2e-VTYHJM` trace carried six `[vite] hot updated: /src/App.tsx` and no `lifecycle-mode`
 * request for exactly this reason). So the last state read before the send is re-taken here: if a remount
 * cleared the intent, the switch is set again, bounded, so the send that follows is addressed to the session
 * the user actually asked to keep running rather than to the one a re-render left behind.
 *
 * Read on the switch's own home — the new-session empty state — and only for a provider the matrix lists
 * resident, which is where every caller below stands. The bounded poll is both the read and the retry: each
 * pass that finds the switch off presses it again, so no single remount can leave the send per-run.
 */
const armResidentSwitch = async (page: Page, timeoutMs = PROJECT_ROW_READY_MS) => {
  const toggle = switches(page).first();
  await expect(
    toggle,
    'the new-session screen must still carry the switch when the send is about to be taken',
  ).toBeVisible({ timeout: timeoutMs });
  await expect
    .poll(
      async () => {
        if ((await toggle.getAttribute('aria-checked')) === 'true') return 'true';
        // A remount cleared the intent; press the switch again and let the next pass read the result.
        await toggle.click({ timeout: timeoutMs }).catch(() => undefined);
        return toggle.getAttribute('aria-checked');
      },
      {
        timeout: timeoutMs,
        message: 'a mid-run HMR remount must not leave the switch off between the click and the send',
      },
    )
    .toBe('true');
  console.log('resident.armed.aria-checked=true');
};

/** Expands the seeded project's session list, retrying the toggle the way the sidebar's own spec does. */
const openWorkspace = async (page: Page) => {
  const first = sessionLink(page, SEEDED_SESSION_NAME);
  const row = projectRow(page);
  // Same readiness wait as `openComposer`: a collapsed-list click must not be taken before the row is drawn.
  await expect(row).toBeVisible({ timeout: PROJECT_ROW_READY_MS }).catch(() => undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await first.isVisible().catch(() => false)) return;
    await row.click().catch(() => undefined);
    try {
      await expect(first).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(first).toBeVisible({ timeout: 15_000 });
};

/** Opens the seeded session itself, so the pane draws a transcript rather than the new-session card. */
const openSeededSession = async (page: Page) => {
  await openWorkspace(page);
  await sessionLink(page, SEEDED_SESSION_NAME).first().click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
};

/** Opens one session row's options menu and waits for its items. */
const openSessionMenu = async (page: Page) => {
  await page.getByRole('button', { name: `Session options for ${SEEDED_SESSION_NAME}` }).click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
};

/**
 * Opens the hint at `scope` and returns the copy it discloses, having first proved it was closed.
 *
 * Two readings, and both are the point: a disclosure that was always in the DOM would satisfy a copy
 * assertion while the user saw nothing, and one that never opens would leave the copy unreadable. So the
 * closed state is asserted first, then the open one, then the text. Returns the normalized copy so the caller
 * can compare it against the same reading taken on another surface — the entry points are required to say the
 * same words, and that is a property of the shipped keys rather than of any one screen.
 */
const openHint = async (page: Page, scope?: string): Promise<string> => {
  const content = page.locator(HINT_CONTENT);
  expect(
    await content.count(),
    'the disclosure must start collapsed: a hint that is always on screen is not the read-only tooltip it is meant to be',
  ).toBe(0);
  console.log('hint.visible=false');

  await hintTrigger(page, scope).first().hover();
  await expect(content, 'hovering the hint must disclose the two facts it stands for').toHaveCount(1, { timeout: 5_000 });
  expect(await content.isVisible(), 'the disclosed text must be on screen once it has been asked for').toBe(true);
  console.log('hint.visible=true');

  const copy = normalize(await content.innerText());
  console.log(`hint.copy=${copy}`);
  expect(
    copy,
    'the hint must state what the mode does: the process runs with bypassPermissions between turns',
  ).toContain(normalize(enChat.resident.notice.bypass));
  expect(
    copy,
    'the hint must state the trust boundary: the process belongs to this Unix user, so anything else '
      + 'running as that user can reach it',
  ).toContain(normalize(enChat.resident.notice.trustBoundary));
  return copy;
};

/** Whether a locator's box lies wholly inside the viewport — the reading "same screen" is taken from. */
const inViewport = (
  box: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number } | null,
) =>
  box !== null
  && viewport !== null
  && box.x >= 0
  && box.y >= 0
  && box.x + box.width <= viewport.width
  && box.y + box.height <= viewport.height;

test.describe.configure({ mode: 'serial' });
// Each of the four cases gets an explicit budget of its own. It sits above the 20s `waitForMode` budget and the
// 15s readiness waits so it never pre-empts a legitimate wait, and below both the criterion's 60s gate and the
// config's 55s run watchdog so a case that outruns either fails while naming itself rather than being killed
// from outside — the default per-case budget is the 60s the gate also uses, which no case can reach before the
// watchdog fires. The onboarding hook below keeps its own, larger budget: it is not a case. Same shape as
// `e2e/resident-enter-send.spec.ts`.
test.describe.configure({ timeout: 45_000 });

test.beforeAll(async ({ browser }) => {
  // Onboarding is the expensive part of a fresh database and only happens once for the file — and it now happens
  // in the file's one shared context, so the client's cold load (the module graph Vite transforms on first
  // request, the browser's empty cache) is paid here exactly once instead of once per case. Every case below
  // reuses this context and page.
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

test('the new-session screen carries the switch under the model card, and sending with it on lands resident', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  // No reload here, unlike the three cases below: `beforeAll` has already paid for the file's one cold load and
  // the page it left is exactly the state this case needs — signed in, on the client root, with the default
  // provider (`claude`, `src/shared/selectedProvider.ts`) that this case writes above, and the resident switch
  // (React state) untouched at its default off. The three later cases must reload because the case above them
  // left that switch on.
  await openNewSession(page);

  // ── AC2: the model card and the switch, on one screen, before the first turn ─────────────────────────
  const viewport = page.viewportSize();
  expect(
    viewport?.width ?? 0,
    'this leg is read at a viewport the criterion requires (≥780px)',
  ).toBeGreaterThanOrEqual(780);

  const card = page.getByText(enChat.providerSelection.clickToChange);
  const onScreen = switches(page);
  await expect(
    onScreen,
    `${RESIDENT_PROVIDER} lists resident in its capability matrix, so the new-session screen must offer the switch — `
      + 'and exactly one of it: the composer no longer draws a copy of its own',
  ).toHaveCount(1, { timeout: 15_000 });
  const toggle = onScreen.first();
  expect(
    await toggle.getAttribute('aria-label'),
    'the switch must be named by the shipped copy, not by a hard-coded word in this spec',
  ).toBe(enChat.resident.toggle);
  console.log('toggle.present=true');

  const cardBox = await card.boundingBox();
  const switchBox = await toggle.boundingBox();
  const cardOnScreen = inViewport(cardBox, viewport);
  const switchOnScreen = inViewport(switchBox, viewport);
  console.log(
    `viewport=${viewport?.width}x${viewport?.height} card.inViewport=${cardOnScreen} switch.inViewport=${switchOnScreen}`,
  );
  expect(cardOnScreen, 'the model card must be on screen with the switch, not scrolled past it').toBe(true);
  expect(switchOnScreen, 'the switch must be on screen with the model card, not below the fold').toBe(true);
  expect(
    switchBox!.y,
    'the switch must sit *below* the card it was relocated under, not above it or over it',
  ).toBeGreaterThan(cardBox!.y + cardBox!.height - 1);
  expect(await toggle.getAttribute('aria-checked'), 'the switch starts off').toBe('false');

  // ── the disclosure is a hint, and it says the two things it has to say ───────────────────────────────
  expect(
    await page.locator(HINT).count(),
    'this screen must carry one switch and one hint; the composer draws neither any more',
  ).toBe(1);
  emptyStateHintCopy = await openHint(page);

  // ── AC2's second half, first reading: what is on screen *before* the switch is turned on ─────────────
  const checkboxesBefore = await page.locator(CHECKBOX).count();
  const onSurfacesBefore = await page.locator(RESIDENT_SURFACES).count();

  // ── AC5's carrier: pressing the switch really takes effect ───────────────────────────────────────────
  //
  // This is the assertion the falsifying variant recorded in the task reds on: wrap the hint so its container
  // swallows the click on its way to the switch, and the switch stays off while looking pressed. The
  // aria-checked reading below is what tells "the press was delivered" from "a press was attempted", and the
  // send that follows is the end-to-end consequence of the same fact.
  await toggle.click();
  expect(
    await toggle.getAttribute('aria-checked'),
    'pressing the switch must actually turn it on — a hint that intercepted the click would leave it off',
  ).toBe('true');

  // ── AC2's second half, second reading: turning the switch on adds none ───────────────────────────────
  const checkboxesAfter = await page.locator(CHECKBOX).count();
  const onSurfacesAfter = await page.locator(RESIDENT_SURFACES).count();
  console.log(`checkbox.page.count=${checkboxesBefore}->${checkboxesAfter} (the rest are the global Quick Settings drawer's)`);
  console.log(`checkbox.resident-surface.count=${onSurfacesBefore}->${onSurfacesAfter}`);
  expect(
    onSurfacesAfter,
    'the retired gate drew the only checkbox on the transcript and composer surfaces; with the switch on there must be none',
  ).toBe(0);
  expect(
    checkboxesAfter,
    'turning the switch on must not add a checkbox — that is what the retired gate did, and it is the one thing this reading can see page-wide',
  ).toBe(checkboxesBefore);

  // ── AC1: the switch being on is the whole of the intent — nothing else stands between it and the send ─
  //
  // The composer is given something to send first: an empty composer's send button is disabled for a reason of
  // its own — there is nothing to submit — and a reading taken over it could not tell a gate from that.
  await composer(page).fill('resident hint is read-only');
  const gateBefore = await submitDisabled(page);
  console.log(`gate.before=${gateBefore}`);
  expect(
    gateBefore,
    'with the switch on, the composer must be immediately sendable: there is no acknowledgement step left to take',
  ).toBe(false);

  // The send is taken only after the switch has been re-confirmed as still on: a remount between the press
  // above and this click would otherwise reset the intent and land the session per-run through no fault of
  // the app under test. This is the last state read before the send, so it is the one the send acts on.
  await armResidentSwitch(page);
  await page.locator(SEND_BUTTON).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`created.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'resident');
  console.log(`session.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'the session a switch-on send is addressed to must read back as resident from the server',
  ).toBe('resident');

  // POSITIVE CONTROL for the mode reading: the same field, read the same way, for a session nobody asked to
  // keep running. Without it, a projection that answered `resident` for every row would score the same.
  const control = await request.post('/api/providers/sessions', {
    headers: auth(authToken),
    data: { provider: RESIDENT_PROVIDER, projectPath: workspace, initialMessage: 'per-run control' },
  });
  expect(control.ok(), `POST /api/providers/sessions answered ${control.status()}`).toBe(true);
  const controlSessionId = ((await control.json()) as { data?: { sessionId?: string } }).data?.sessionId as string;
  const controlMode = await modeOf(request, controlSessionId);
  console.log(`control.session.lifecycle_mode=${controlMode}`);
  expect(
    controlMode,
    'a session created without the switch must read per-run — otherwise lifecycle_mode has no resolution',
  ).toBe('per-run');
});

/**
 * The silent-conversion regression: the switch's intent is a statement about the *new-session card*
 * only, and must never reach a send addressed to a session that already exists.
 *
 * The window this reads is the one the switch's never-reset position used to open. The empty-state
 * switch is turned on and a first message is sent, creating a brand-new session A that must land
 * resident. Then, *in the same app instance* — the sidebar navigates in-app, so `ChatInterface` is
 * not remounted and its `residentEnabled` state would still be `true` under the old code — an
 * existing per-run session B is opened and a message is sent into it. B must read back per-run.
 *
 * Under the retired shape (`if (residentIntent && targetSessionId)`, intent never cleared, and every
 * composer submit re-recording the switch position) this same send converts B, and the `per-run`
 * assertion below is where the red lands. Both readings come from `GET /api/session-hosts`.
 */
test('a switch-on send to a new session does not convert an existing per-run session on the next send', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  await page.goto('/');
  await openNewSession(page);

  // ── A: the empty-state switch on, then send — the new session lands resident ─────────────────────────
  const toggle = switches(page).first();
  await expect(toggle, 'the new-session card must carry the switch').toBeVisible({ timeout: 15_000 });
  await toggle.click();
  expect(await toggle.getAttribute('aria-checked'), 'the switch must be on before the send').toBe('true');

  await composer(page).fill('resident first turn');
  // Re-confirm the switch immediately before the send, so a remount between the press and here cannot make
  // session A land per-run and turn this leg's `resident` reading into a false red.
  await armResidentSwitch(page);
  await page.locator(SEND_BUTTON).click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const sessionA = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`new.sessionId=${sessionA}`);

  const modeA = await waitForMode(request, sessionA, 'resident');
  console.log(`new.session.lifecycle_mode=${modeA}`);
  expect(
    modeA,
    'a switch-on send to a brand-new session must read back resident — the load-bearing half of this leg',
  ).toBe('resident');

  // ── B: an existing per-run session, opened in-app — a send into it must not convert it ───────────────
  const modeBBefore = await modeOf(request, SEEDED_SESSION_ID);
  console.log(`B.lifecycle_mode.before=${modeBBefore}`);
  expect(
    modeBBefore,
    `the control session must start per-run; the server read ${modeBBefore}`,
  ).toBe('per-run');

  await openWorkspace(page);
  await sessionLink(page, SEEDED_SESSION_NAME).first().click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.locator(MESSAGE).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  await composer(page).fill('a message into the old per-run session');
  await page.locator(SEND_BUTTON).click();
  // Let the send path run past the point at which the retired shape issued the conversion, then read B.
  await page.waitForTimeout(2_000);

  const modeBAfter = await modeOf(request, SEEDED_SESSION_ID);
  console.log(`B.lifecycle_mode=${modeBAfter}`);
  expect(
    modeBAfter,
    'a message sent into an existing per-run session must leave it per-run — the switch is a statement '
      + 'about the new-session card, and a send that already has a session to address must not read it',
  ).toBe('per-run');
});

test('a session with messages draws no switch in its composer, and one menu click converts it', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);

  await restoreSession(page, RESIDENT_PROVIDER);
  await page.goto('/');
  await openSeededSession(page);

  // ── the composer is not a place a session is converted ───────────────────────────────────────────────
  //
  // Read on a session that really has a transcript: an empty one takes the new-session branch, where the
  // switch legitimately lives, and a reading there would not be about the composer at all.
  await expect
    .poll(() => page.locator(MESSAGE).count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  const messages = await page.locator(MESSAGE).count();
  console.log(`messages.count=${messages} (n>=1)`);
  expect(
    messages,
    'this case must be read on a session with a transcript, not on the new-session screen',
  ).toBeGreaterThanOrEqual(1);

  const inComposer = switches(page, '.chat-composer-shell');
  console.log(`composer.switch.count=${await inComposer.count()}`);
  expect(
    await inComposer.count(),
    'a session that already has a transcript draws no switch in its composer: the switch belongs to the '
      + 'new-session card, and this session is converted from the menu below',
  ).toBe(0);

  const onSurfaces = await page.locator(RESIDENT_SURFACES).count();
  console.log(`checkbox.resident-surface.count=${onSurfaces}`);
  expect(onSurfaces, 'the composer side must draw no checkbox either').toBe(0);

  // ── AC4: the menu converts on one click, after the hint has been read ────────────────────────────────
  const modeBefore = await modeOf(request, SEEDED_SESSION_ID);
  expect(modeBefore, `the seeded session must start per-run; the server read ${modeBefore}`).toBe('per-run');

  await openSessionMenu(page);
  const convert = page.getByRole('menuitem', { name: enSidebar.sessionMenu.convertToResident });
  await expect(
    convert,
    `${RESIDENT_PROVIDER} can run resident, so the session menu must offer the conversion`,
  ).toBeVisible();
  console.log('menu.item=present');

  // The item is usable with nothing done to it. This is the reading that stands where the retired gate used to:
  // the old menu carried a checkbox the conversion sat disabled behind, so "offered, and enabled the moment the
  // menu is opened" is exactly the state the removal was for. It is read before the hint below is touched, so a
  // hint that had taken the click or a step that had to be ticked first would show up here.
  //
  // The mid-turn behaviour (`disabled` while the session has a live run) is deliberately not read here, and not
  // only because no fixture can put a session in the server's in-flight registry for the length of an assertion:
  // the running set is cleared by the subscribe ack the app itself processes on opening the session, so a seam on
  // `GET /api/providers/sessions/running` is re-cleared before it can be read. That behaviour is covered where it
  // can be stated directly — `src/modules/sidebar/tests/recentConversationRowActions.test.tsx` asserts the row
  // hands `isProcessing: true` down, and SessionOptions turns that into the item's `disabled`.
  const enabledOnOpen = await convert.isEnabled();
  console.log(`menu.convertEnabledOnOpen=${enabledOnOpen}`);
  expect(
    enabledOnOpen,
    'the conversion must be one click from here — offered, and enabled, with nothing ticked and nothing confirmed',
  ).toBe(true);

  // The hint explains the mode and gates nothing. It is read the same way as the other two homes, from the
  // menu's own header, and the conversion below runs with it open and with nothing ticked — the removal of the
  // gate is what makes that possible at all.
  const menuCopy = await openHint(page, '[role="menu"]');
  expect(
    menuCopy,
    'the menu\'s hint is the same hint: the three entry points read the same chat keys, and a menu that drifted '
      + 'to its own wording would be a second disclosure nobody compares',
  ).toBe(emptyStateHintCopy);

  // The menu is portaled to `document.body`, so it is outside `RESIDENT_SURFACES`; the third carrier of the
  // retired gate is read where it used to be drawn.
  const menuCheckboxes = await page.locator(`[role="menu"] ${CHECKBOX}`).count();
  console.log(`checkbox.menu.count=${menuCheckboxes}`);
  expect(
    menuCheckboxes,
    'the menu used to carry the conversion\'s checkbox; with the gate retired there must be none',
  ).toBe(0);

  // ── one click, and the server has it ─────────────────────────────────────────────────────────────────
  // The item is still enabled after the hint has been read and dismissed — nothing the hint did changed what the
  // conversion requires — so the click below is the click the user would make.
  expect(await convert.isEnabled(), 'reading the hint must not have disabled the conversion').toBe(true);
  await convert.click();
  const converted = await waitForMode(request, SEEDED_SESSION_ID, 'resident');
  console.log(`modeBefore=${modeBefore} modeAfter=${converted}`);
  expect(
    converted,
    'choosing the conversion must be the whole of it — no tick, no confirm step between the click and the server',
  ).toBe('resident');
});

test('the switch is the capability matrix\'s answer rather than a provider id', async ({ page, request }) => {
  const rows = await providerCapabilities(request);
  const resident = rows.filter((row) => row.lifecycleModes?.includes('resident')).map((row) => row.provider);
  const nonResident = rows.filter((row) => !row.lifecycleModes?.includes('resident')).map((row) => row.provider);
  console.log(`capability.residentProviders=${resident.join(',')}`);
  console.log(`capability.nonResidentProviders=${nonResident.join(',')}`);
  expect(resident, 'the matrix must name a resident provider, or the positive legs above prove nothing').not.toHaveLength(0);
  expect(nonResident, 'the matrix must name a non-resident provider, or this case has nothing to read').not.toHaveLength(0);

  const other = nonResident[0];
  await setSelectedProvider(request, other);

  // The reading below is an absence, and an absence is only worth something if the answer it is the absence of
  // has really arrived: the composer on screen is the one the matrix has already answered for.
  const capabilitiesAnswered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/providers/capabilities',
  );
  await restoreSession(page, other);
  await page.goto('/');
  await openNewSession(page);
  expect((await capabilitiesAnswered).ok(), 'the capability request the composer makes must have succeeded').toBe(true);

  // Read on the new-session screen — the switch's only home — for a provider the matrix does not list.
  const present = await switches(page).count();
  console.log(`toggle.present=${present > 0}`);
  expect(
    present,
    `${other} does not list resident in lifecycleModes (${JSON.stringify(
      rows.find((row) => row.provider === other)?.lifecycleModes,
    )}), so the switch may not be drawn`,
  ).toBe(0);
});
