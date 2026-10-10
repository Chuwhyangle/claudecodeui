import { expect, test } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// This criterion drives the Settings → "API & Tokens" page the way a user does and reads back what the browser
// really rendered and what the running server really answered. Nothing is stubbed: the token is created through
// the form, revoked through the list row, and the only out-of-band calls are the two real HTTP requests to
// `/api/oauth/token-info` that prove the token is accepted while live and rejected once revoked.
//
// The startup path is bounded in the same two levers its sibling specs use (`e2e/session-filter.spec.ts`,
// `e2e/model-library.spec.ts`): a client warm-up before any page exists, and a bounded navigation guard. Neither
// guard decides anything for the case — a navigation that cannot land ends the run with the page's own evidence.

/** A personal access token is `ccp_` plus 32 random bytes rendered as 64 hex digits. */
const PLAINTEXT_PATTERN = /^ccp_[0-9a-f]{64}$/;
/** Namespaced i18n keys leak into the UI as literals like "settings.accessTokens.title" when a translation is missing. */
const UNTRANSLATED_KEY = /\b(?:mainTabs|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;
/** The old API-key entry point's button text (`apiKeys.newButton`), which must no longer render anywhere. */
const RETIRED_BUTTON_TEXT = 'New API Key';
/** The old API-key documentation link target, which must no longer be rendered on the page. */
const RETIRED_DOCS_PATH = 'api-docs.html';

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;
/** How long this run's client is given to answer its app entry before the startup path gives up on it. */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/**
 * How long the landing of the first navigation is given *in total*, before the guard starts replaying.
 *
 * This is one budget for the whole first landing, not one per locator: `FIRST_LANDING.present` probes the account
 * form and the app shell and the two probes share it (see below), so a landing that spends all of it on the first
 * locator cannot ask for a second helping.
 */
const STARTUP_PROBE_MS = 5_000;
/** How long each bounded replay's landing is given; shorter than the first, because a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/**
 * How long one navigation's own single request is given — the first hop and every replay hop alike.
 *
 * Tightened from 8s because this bound is what the deadline has to fit *around*: a first hop allowed to spend 8s
 * of the old 14s deadline left 6s for its landing probe — and `FIRST_LANDING` probes two locators, which each took
 * a full budget, so the landing alone could spend 12s and overrun the deadline before the replay the guard exists
 * to make ever began. The warm-up above has already committed this run's pre-bundle over plain HTTP before any page
 * exists, so a healthy first document is served from that cache in a couple of seconds (measured quiet on this host:
 * the first hop navigates in ~2.5s, and its landing probe lands ~0.2s later). 5s clears a healthy hop with room to
 * spare, and is short enough that a document which is not coming is abandoned while there is still budget to
 * re-ask for it.
 */
const NAVIGATION_PROBE_MS = 5_000;
/**
 * The sum the startup path may spend proving a navigation landed, replays included.
 *
 * A deadline rather than a replay count, because it is the *sum* that has to stay inside the criterion's own wall
 * clock. The deadline is the one bound the replay budget is spent out of, so it has to clear the *worst case* — a
 * first hop that spends its entire bound and whose landing probe does too (including `FIRST_LANDING`'s second
 * locator, which shares the first landing's budget rather than getting a second one) — with a full replay hop and
 * its landing probe still left over. Spelled out, because this sum is the whole of why the guard can replay at all:
 *
 *   first hop        NAVIGATION_PROBE_MS      = 5_000
 * + first landing    STARTUP_PROBE_MS         = 5_000
 * + replay hop       NAVIGATION_PROBE_MS      = 5_000
 * + replay landing   STARTUP_RELOAD_PROBE_MS  = 3_000
 *   ──────────────────────────────────────────────────
 *   worst case                                = 18_000  ≤  STARTUP_PROBE_DEADLINE_MS = 20_000
 *
 * so even the slowest first hop leaves a complete replay inside the deadline. That is the gap this task closes: at
 * the old deadline (14_000) an 8s first hop left 6s, `FIRST_LANDING`'s two probes spent 12s, the
 * `Date.now() >= deadline` throw fired on the first iteration, and `else { page.reload(…) }` was dead code — the
 * guard died in the startup form on an otherwise-green tree whenever a transient browser network flap
 * (`net::ERR_NETWORK_CHANGED` on the document/entry requests) made the first landing miss.
 */
const STARTUP_PROBE_DEADLINE_MS = 20_000;
/** How long the first-run wizard is given to reach the app shell, a mid-run reload and its replay included. */
const ONBOARDING_DEADLINE_MS = 20_000;
/** How long one probe of the wizard's current step — or one click that step owns — is given before the walk re-reads the page. */
const ONBOARDING_STEP_PROBE_MS = 2_000;
/** How long a shell sighted mid-wizard is given to prove it is the real one before a wizard step returns to replace it. */
const ONBOARDING_SHELL_SETTLE_MS = 10_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the shell, the app entry and one
 * optimized dependency, all requested before any page of this run exists. A 200 on the dependency url only comes
 * once the optimizer has committed the bundle, so the page below does not race a re-optimization that would serve
 * it a superseded url. Every step is bounded; a client that accepts the connection and never answers fails here.
 */
const warmClientStartup = async (clientUrl: string): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs());
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `the client did not answer ${url} inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      console.log(`[e2e] client warm-up: pre-bundle committed in ${Date.now() - startedAt}ms`);
      return Date.now() - startedAt;
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this run's dependency pre-bundle never committed, so the criterion cannot drive a document that stays: `
    + lastAnswer,
  );
};

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/** What a guarded navigation is expected to land on — and how the guard names it when it never lands. */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

// Under playwright.config.ts's SINGLE_SPEC_CEILING_MS (55s) on purpose: a case that hangs must time out legibly
// here rather than be killed by the watchdog, which reports the kill as `Channel closed` and names no assertion.
test.describe.configure({ mode: 'serial', timeout: 50_000 });

test.describe('personal access tokens in settings', () => {
  let page: Page;
  const startupEvidence = {
    consoleErrors: [] as string[],
    failedRequests: [] as string[],
  };

  const settingsButton = () => page.getByRole('button', { name: 'Settings', exact: true }).first();
  const apiTokensTab = () => page.getByRole('button', { name: 'API & Tokens', exact: true });
  const tokensHeading = () => page.getByRole('heading', { name: 'Personal Access Tokens' });
  const tokenRow = (name: string) => page.getByTestId('access-token-row').filter({ hasText: name });

  /** Unreadable evidence is still evidence: what the page said when a startup landing never arrived. */
  const readStartupEvidence = async (): Promise<string> => {
    const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
    const errors = startupEvidence.consoleErrors.slice(0, 5);
    const failed = startupEvidence.failedRequests.slice(0, 5);
    return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
      + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
      + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
  };

  /**
   * The one place this spec navigates: navigate, probe the landing with a short budget, and on a missed landing
   * replay the navigation (a fresh document, which recovers from module requests interrupted once) until the
   * deadline. A probe that cannot land ends the run here with a cause rather than letting the case wait out its
   * own budget on a blank page.
   */
  const navigateBounded = async (landing: StartupLanding, kind: 'first-load' | 'replay'): Promise<void> => {
    const startedAt = Date.now();
    const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
    const budgetMs = () => Math.max(1, deadline - Date.now());
    let navigationFailure: string | null = null;
    for (let attempt = 1; ; attempt += 1) {
      // Which hop this is, named before it is taken: the first-load `goto` or a replay `reload`. Both are logged
      // below, so a run's own output records every navigation attempt it made — hop 1, then each `page.reload` by
      // number — rather than only the attempt that happened to land. A replay claimed by reading the constants is
      // not the same as a replay observed in the log, and this is the log the criterion is read from.
      const isFirstHop = attempt === 1 && kind === 'first-load';
      const hopKind = isFirstHop ? 'page.goto' : 'page.reload';
      const hopTimeout = Math.min(NAVIGATION_PROBE_MS, budgetMs());
      const hopStartedAt = Date.now();
      console.log(`[e2e] startup: hop ${attempt} (${hopKind} /) begins with ${hopTimeout}ms of navigation budget`);
      try {
        if (isFirstHop) {
          await page.goto('/', { timeout: hopTimeout });
        } else {
          await page.reload({ timeout: hopTimeout });
        }
        navigationFailure = null;
        console.log(`[e2e] startup: hop ${attempt} (${hopKind}) navigated in ${Date.now() - hopStartedAt}ms`);
      } catch (error) {
        navigationFailure = error instanceof Error ? error.message : String(error);
        console.log(
          `[e2e] startup: hop ${attempt} (${hopKind}) did not finish navigating in ${hopTimeout}ms: ${navigationFailure}`,
        );
      }
      const landingBudget = Math.min(attempt === 1 ? STARTUP_PROBE_MS : STARTUP_RELOAD_PROBE_MS, budgetMs());
      if (await landing.present(landingBudget)) {
        console.log(
          `[e2e] startup: ${landing.label()} landed after ${Date.now() - startedAt}ms (attempt ${attempt}, ${hopKind})`,
        );
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${landing.label()} never rendered, so this run's client never came up to a document that stays`
          + `${navigationFailure === null ? '' : ` (the navigation itself failed: ${navigationFailure})`}`
          + `: ${await readStartupEvidence()}`,
        );
      }
    }
  };

  /** What the first navigation must land on: the fresh database's account form or the app shell, whichever this run has. */
  const FIRST_LANDING: StartupLanding = {
    label: () => 'the account form or the app shell',
    // The two probes share the one budget they are handed rather than each getting it in full. `present` is called
    // with a single landing budget, and a landing that spends it all on the account form must not be handed a second
    // one, or `present` could take twice what the guard reserved for it and overrun the deadline before its replay.
    present: async (budgetMs) => {
      const landingDeadline = Date.now() + budgetMs;
      const remaining = () => Math.max(1, landingDeadline - Date.now());
      return (await appears(page.locator('#username'), remaining()))
        || (await appears(settingsButton(), remaining()));
    },
  };

  /**
   * What every later navigation must land on: the app shell's Settings button. The shell's first paint renders it
   * before any of this spec's own data, so a landing here proves the document mounted — the property the guard is
   * about — and not that a particular read happened to arrive.
   */
  const APP_SHELL_LANDING: StartupLanding = {
    label: () => 'the app shell (Settings button)',
    present: (budgetMs) => appears(settingsButton(), budgetMs),
  };

  /** Opens Settings → API & Tokens, so the token section's own heading is on screen. */
  const openAccessTokensTab = async (): Promise<void> => {
    await settingsButton().click();
    await expect(apiTokensTab()).toBeVisible({ timeout: 15_000 });
    await apiTokensTab().click();
    await expect(tokensHeading()).toBeVisible({ timeout: 15_000 });
  };

  /**
   * Walks the first-run wizard to the app shell, state-driven and bounded.
   *
   * The walk this replaces was two hard-wired clicks — `Next`, then `Complete Setup` — with no deadline of their
   * own. A client reload mid-run (Vite answers a re-optimization by pushing a full reload) remounts the app and
   * resets the wizard to its first step, so `Complete Setup` no longer exists; Playwright's `click` then
   * auto-waited for it until playwright.config.ts's watchdog killed the browser at 55s, and the red landed as
   * `Channel closed` instead of on any of the case's own (a)–(e) assertions.
   *
   * So this walk never commits to a step it saw once: each turn re-reads the page and drives whichever step is
   * actually on screen — the account form while it is up, then the git step (filling only a field the wizard left
   * blank, so a value the run already committed is never overwritten), then the final step. Every probe and every
   * click is bounded by the remaining budget; a click that loses its document to a reload is a turn that simply
   * re-reads; and the app shell ends the walk. When the budget is spent the walk ends the run *here*, by name,
   * with the page's own evidence — before the watchdog, where a reader can see which step never advanced.
   *
   * The app shell is not by itself proof the walk is over. `AuthContext` initialises `hasCompletedOnboarding` to
   * `true`, and `register` commits the session before it awaits `/api/user/onboarding-status`, so a freshly created
   * account shows the real shell for exactly as long as that one read takes before the wizard replaces it. A walk
   * that trusted the first sighting returned on that transient, and the case then failed on the wizard underneath.
   * Only a shell with no wizard ever in front of it (a database already onboarded) or one that follows this walk's
   * own `Complete Setup` is the real thing; any other sighting is that transient, and the walk waits it out.
   */
  const completeOnboardingBounded = async (deadlineMs: number): Promise<void> => {
    const startedAt = Date.now();
    const deadline = startedAt + deadlineMs;
    const budgetMs = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()));

    const accountForm = {
      username: page.locator('#username'),
      passwords: page.locator('input[type=password]'),
      createAccount: page.getByRole('button', { name: 'Create Account', exact: true }),
    };
    const gitStep = {
      name: page.locator('#gitName'),
      email: page.locator('#gitEmail'),
      // The git step's own forward control; the final step renders `Complete Setup` and no `Next`.
      next: page.getByRole('button', { name: 'Next', exact: true }),
    };
    const agentStep = {
      complete: page.getByRole('button', { name: 'Complete Setup', exact: true }),
    };

    /** Names the step in the walk's log and in a red, once per step rather than once per turn. */
    let currentStep = 'no step of the wizard was on screen';
    /** Whether any wizard step has been on screen yet: no means the database was already onboarded. */
    let sawWizardStep = false;
    /** Whether this walk itself committed the wizard's last step; only then is a following shell the real exit. */
    let completedWizard = false;
    const noteStep = (step: string) => {
      sawWizardStep = true;
      if (step !== currentStep) {
        currentStep = step;
        console.log(`[e2e] onboarding: on ${step} after ${Date.now() - startedAt}ms`);
      }
    };
    const clickWithin = async (click: () => Promise<void>): Promise<void> => {
      try {
        await click();
      } catch {
        // The document was replaced under the click (a reload); the next turn re-reads whatever is current.
      }
    };

    for (;;) {
      if (Date.now() >= deadline) break;

      // The app shell is the exit — once it is known to be the real one. See the note above the walk: a fresh
      // account shows this shell transiently until `/api/user/onboarding-status` answers, and returning on it
      // would land the case on the wizard that replaces it.
      if (await appears(settingsButton(), budgetMs(ONBOARDING_STEP_PROBE_MS))) {
        if (!sawWizardStep || completedWizard) {
          console.log(`[e2e] onboarding: the app shell is up after ${Date.now() - startedAt}ms`);
          return;
        }
        // Mid-wizard: this is either that transient, or the shell anyway because the status read resolved true
        // (or failed open). Wait for the wizard it is about to be replaced by; a bounded settle with the shell
        // still up settles it the other way.
        const wizardArrived = await accountForm.createAccount
          .or(gitStep.name)
          .or(agentStep.complete)
          .first()
          .waitFor({ state: 'visible', timeout: budgetMs(ONBOARDING_SHELL_SETTLE_MS) })
          .then(() => true, () => false);
        if (wizardArrived) {
          console.log('[e2e] onboarding: the shell was the transient the auth context renders before its status read; the wizard is back');
          continue;
        }
        if (await settingsButton().isVisible().catch(() => false)) {
          console.log(`[e2e] onboarding: the app shell held for ${ONBOARDING_SHELL_SETTLE_MS}ms after the wizard, so it is the real exit after ${Date.now() - startedAt}ms`);
          return;
        }
        continue;
      }

      if (await accountForm.createAccount.isVisible().catch(() => false)) {
        noteStep('the account setup form');
        await clickWithin(async () => {
          await accountForm.username.fill('e2euser', { timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
          await accountForm.passwords.nth(0).fill('e2epassword', { timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
          await accountForm.passwords.nth(1).fill('e2epassword', { timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
          await accountForm.createAccount.click({ timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
        });
        continue;
      }

      if (await gitStep.name.isVisible().catch(() => false)) {
        noteStep('the Git Configuration step');
        await clickWithin(async () => {
          // A reload re-reads the server's saved config, so only a genuinely empty field is filled here.
          if (!(await gitStep.name.inputValue())) {
            await gitStep.name.fill('E2E User', { timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
          }
          if (!(await gitStep.email.inputValue())) {
            await gitStep.email.fill('e2e@example.com', { timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
          }
          await gitStep.next.click({ timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) });
        });
        continue;
      }

      if (await agentStep.complete.isVisible().catch(() => false)) {
        noteStep('the Agent Connections step');
        // Recorded before the click: its POST is what commits onboarding, and a reload can take the document
        // before the click returns. Either the shell that follows is real, or the step is re-driven next turn.
        completedWizard = true;
        await clickWithin(() => agentStep.complete.click({ timeout: budgetMs(ONBOARDING_STEP_PROBE_MS) }));
        continue;
      }

      // No step is on screen yet: the document is still mounting, or a reload is mid-flight. One bounded re-read,
      // rather than a spin — the deadline above is what ends a wizard that never comes back.
      await appears(settingsButton(), budgetMs(ONBOARDING_STEP_PROBE_MS));
    }

    throw new Error(
      `the first-run onboarding wizard never reached the app shell within its ${deadlineMs}ms budget, so the `
      + `criterion cannot open Settings; the last step on screen was ${currentStep} — a client reload mid-run `
      + `restarts the wizard and this walk is written to re-read and continue it: ${await readStartupEvidence()}`,
    );
  };

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) {
      throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
    }
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    // The revoke flow confirms through `window.confirm`; accept it so the DELETE really runs.
    page.on('dialog', (dialog) => { void dialog.accept(); });
    page.on('console', (message) => {
      if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // First run on a fresh database: create the single account, then finish onboarding, and tolerate a database
    // another spec in the same invocation already signed into (the walk exits at the app shell without touching
    // the wizard). Every step is bounded and state-driven, so a reload that resets the wizard costs a re-read
    // rather than a wait that outlives the run.
    await navigateBounded(FIRST_LANDING, 'first-load');
    await completeOnboardingBounded(ONBOARDING_DEADLINE_MS);
    await expect(settingsButton()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('creates a token once, hides its plaintext after reload, offers exactly 7/30/90, and revocation really rejects it', async () => {
    const serverBase = `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}`;
    /** The real HTTP self-check a client makes with the token itself as the credential. */
    const tokenInfo = (token: string) =>
      fetch(`${serverBase}/api/oauth/token-info`, { headers: { authorization: `Bearer ${token}` } });

    await openAccessTokensTab();

    // (c) The lifetime dropdown offers exactly 7/30/90 and defaults to 30.
    await page.getByRole('button', { name: 'New Token', exact: true }).click();
    const expiry = page.getByTestId('access-token-expiry');
    await expect(expiry).toBeVisible();
    const optionValues = await expiry.evaluate((node) =>
      Array.from((node as HTMLSelectElement).options).map((option) => option.value));
    const defaultExpiry = await expiry.inputValue();
    console.log(`(c) option values = ${JSON.stringify(optionValues)}; default = ${defaultExpiry}`);
    expect([...optionValues].sort()).toEqual(['30', '7', '90']);
    expect(defaultExpiry).toBe('30');

    // (f) The form opens with a dated default name — prefilled, still editable, and still required: clearing it
    // and submitting asks the server for nothing and creates no row, so an unnamed PAT can never be minted.
    const nameInput = page.getByPlaceholder('Token name (e.g., My MCP client)');
    const prefilledName = await nameInput.inputValue();
    console.log(`(f) the create form's default name = ${JSON.stringify(prefilledName)}`);
    expect(prefilledName).toMatch(/^MCP token · \d{4}-\d{2}-\d{2}$/);
    // DoD evidence: the create form as it opens, carrying its dated default name. The
    // settings pane is its own scroll container, so scroll the field into view first —
    // a bare screenshot captures the pane's current (top) scroll position.
    await nameInput.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/gap-settings-access-tokens-dod-form-default-name.png' });

    const rowsBeforeEmptySubmit = await page.getByTestId('access-token-row').count();
    let createPosts = 0;
    const countCreatePosts = (request: Request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/settings/access-tokens')) createPosts += 1;
    };
    page.on('request', countCreatePosts);
    await nameInput.fill('');
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    await page.waitForTimeout(500);
    page.off('request', countCreatePosts);
    const rowsAfterEmptySubmit = await page.getByTestId('access-token-row').count();
    console.log(`(f) after clearing the name and submitting: POSTs to /access-tokens = ${createPosts}, rows ${rowsBeforeEmptySubmit} -> ${rowsAfterEmptySubmit}`);
    expect(createPosts).toBe(0);
    expect(rowsAfterEmptySubmit).toBe(rowsBeforeEmptySubmit);
    await expect(nameInput).toBeVisible();

    // (a) Create through the form and capture the one-time plaintext the response carries.
    const tokenName = `e2e-token-${Date.now()}`;
    await nameInput.fill(tokenName);
    await expiry.selectOption('30');
    const [createResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/settings/access-tokens')),
      page.getByRole('button', { name: 'Create token', exact: true }).click(),
    ]);
    const plaintext = (await page.getByTestId('new-access-token-plaintext').innerText()).trim();
    console.log(`(a) POST /api/settings/access-tokens -> ${createResponse.status()}; plaintext matches ccp_<64 hex> = ${PLAINTEXT_PATTERN.test(plaintext)}`);
    expect(createResponse.status()).toBe(201);
    expect(plaintext).toMatch(PLAINTEXT_PATTERN);
    const prefix = plaintext.slice(0, 8);
    expect(prefix).toHaveLength(8);
    await expect(tokenRow(tokenName)).toHaveCount(1);
    const tokenId = await tokenRow(tokenName).getAttribute('data-token-id');
    expect(tokenId).toBeTruthy();

    // (d) While live, the token really authenticates against the running server.
    const liveResponse = await tokenInfo(plaintext);
    const liveBody = await liveResponse.json() as { userId: number; scopes: string[]; expiresAt: string };
    console.log(`(d) token-info with the live token -> ${liveResponse.status}; userId=${liveBody.userId} scopes=${JSON.stringify(liveBody.scopes)} expiresAt=${liveBody.expiresAt}`);
    expect(liveResponse.status).toBe(200);
    expect(typeof liveBody.userId).toBe('number');
    expect(Array.isArray(liveBody.scopes)).toBe(true);
    expect(typeof liveBody.expiresAt).toBe('string');

    // (b) A reload drops the one-time plaintext from the document entirely, leaving prefix and name.
    await navigateBounded(APP_SHELL_LANDING, 'replay');
    await openAccessTokensTab();
    const reloadedRow = tokenRow(tokenName);
    await expect(reloadedRow).toHaveCount(1);
    await expect(reloadedRow).toContainText(prefix);
    await expect(reloadedRow).toContainText(tokenName);
    const documentContent = await page.content();
    const documentText = await page.locator('body').innerText();
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    const documentHits = documentContent.split(plaintext).length - 1;
    const textHits = documentText.split(plaintext).length - 1;
    console.log(`(b) after reload: plaintext hits in content = ${documentHits}, in body.innerText = ${textHits}, in localStorage = ${storageDump.local.includes(plaintext)}, in sessionStorage = ${storageDump.session.includes(plaintext)}; row shows prefix "${prefix}" and name "${tokenName}"`);
    expect(documentHits).toBe(0);
    expect(textHits).toBe(0);
    expect(storageDump.local.includes(plaintext)).toBe(false);
    expect(storageDump.session.includes(plaintext)).toBe(false);

    // (d) Revoke through the row, confirm, and prove the server now rejects the same token.
    await reloadedRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(tokenRow(tokenName)).toContainText('Revoked', { timeout: 15_000 });

    await navigateBounded(APP_SHELL_LANDING, 'replay');
    await openAccessTokensTab();
    const revokedRow = tokenRow(tokenName);
    await expect(revokedRow).toHaveCount(1);
    await expect(revokedRow).toContainText('Revoked');
    const revokedResponse = await tokenInfo(plaintext);
    console.log(`(d) after revoke: id=${tokenId} row still present and marked Revoked; token-info -> ${revokedResponse.status}`);
    expect(revokedResponse.status).toBe(401);

    // (e) The retired API-key entry point is gone: no old button text, no docs link, no anchor to it.
    const finalText = await page.locator('body').innerText();
    const docsAnchors = await page.locator('a[href*="api-docs.html"]').count();
    console.log(`(e) body.innerText contains "${RETIRED_BUTTON_TEXT}" = ${finalText.includes(RETIRED_BUTTON_TEXT)}; contains "${RETIRED_DOCS_PATH}" = ${finalText.includes(RETIRED_DOCS_PATH)}; anchors to it = ${docsAnchors}`);
    expect(finalText).not.toContain(RETIRED_BUTTON_TEXT);
    expect(finalText).not.toContain(RETIRED_DOCS_PATH);
    expect(docsAnchors).toBe(0);

    // (g) The PAT list carries no "Unnamed token" row. The label can only come from a nameless row — an OAuth row,
    // whose `name` is NULL — and the PAT list no longer selects any; the one PAT on this page has a real name.
    const unnamedRows = await page.getByTestId('access-token-row').filter({ hasText: 'Unnamed token' }).count();
    console.log(`(g) "Unnamed token" rows in the PAT list = ${unnamedRows}`);
    expect(unnamedRows).toBe(0);
    // DoD evidence: the PAT list itself, with the user's own named token and no "Unnamed token" row.
    // The settings pane scrolls independently of the document, so bring the row into view and
    // capture the viewport — a fullPage shot only expands the document, not the pane's scroll.
    await page.getByTestId('access-token-row').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/gap-settings-access-tokens-dod-pat-list.png' });

    // No untranslated i18n literal anywhere on the page — the settings tab included.
    expect(finalText).not.toMatch(UNTRANSLATED_KEY);
  });
});
