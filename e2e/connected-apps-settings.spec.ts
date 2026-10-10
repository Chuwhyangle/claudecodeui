import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir), for
// the MCP gateway's OAuth surface: the settings page's "Connected Apps" and "OAuth Clients (Advanced)" sections.
//
// The criterion drives the page the way a user does and reads back what the browser really rendered and what the
// running server really answered. Nothing is stubbed: the manual client is created through the form, the two
// revocations are driven through the list rows, and the only out-of-band calls are real HTTP requests to `/mcp`
// (which prove a grant's token is accepted while live and rejected once revoked or its client is disabled) and to
// the DCR endpoint that registers this run's preset clients.
//
// WHY THIS SPEC SEEDS THE STORE DIRECTLY. `/mcp`'s OAuth authentication (AC-263), the discovery documents
// (AC-262), `/oauth/register` (AC-264) and the settings routes (AC-265) are all mounted by `server/index.ts`; the
// authorization-code endpoints (`/oauth/authorize`, `/oauth/token`) are NOT — their production mount belongs to
// AC-268 and has not landed, so there is no HTTP path from this process to a consent grant and an access token.
// The preset therefore writes the store rows the running server reads — a client registered through the REAL DCR
// endpoint, plus the grant and token rows the store itself would have written — and every reading the criterion
// makes is the server's own: the grant list, the revocation cascade and the client-disable cascade are all
// executed by the real service over those rows. No request is stubbed anywhere.
//
// The startup path is bounded in the same two levers its sibling specs use (`e2e/access-tokens-settings.spec.ts`):
// a client warm-up before any page exists, and a bounded navigation guard. Neither guard decides anything for the
// case — a navigation that cannot land ends the run with the page's own evidence.

/** Namespaced i18n keys leak into the UI as literals like "settings.connectedApps.title" when a translation is missing. */
const UNTRANSLATED_KEY = /\b(?:mainTabs|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;
/** The RFC 8707 audience every preset token is bound to; `/mcp` rejects a token whose stored audience differs. */
const MCP_RESOURCE_PATH = '/mcp';
/** The scope the preset grants carry; the read baseline every consent grants. */
const READ_SCOPE = 'cloudcli:read';
/** The MCP protocol revision the probe's `initialize` announces; the SDK's gateway answers it. */
const PROTOCOL_VERSION = '2025-06-18';

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
 * exists, so a healthy first document is served from that cache in well under a second (measured quiet on this host:
 * the whole guard, hop plus landing, lands in ~2.2s). 5s is many times a healthy hop, and short enough that a
 * document which is not coming is abandoned while there is still budget to re-ask for it.
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

/** SHA-256 hex, the only form a token or secret reaches the store; the spec hashes what it seeds exactly as the store does. */
const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** What one preset client/grant/token triple the store now holds; the spec keeps the plaintext token for its `/mcp` readings. */
type PresetGrant = {
  clientId: string;
  clientName: string;
  grantId: number;
  accessToken: string;
};

/** One client the DCR endpoint really registered for this run. */
type RegisteredClient = { clientId: string; clientName: string };

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('connected apps and OAuth clients in settings', () => {
  let page: Page;
  /** The DCR-registered client whose grant leg (b) revokes. */
  let revokedClient: RegisteredClient;
  /** The DCR-registered client leg (d) disables. */
  let disabledClient: RegisteredClient;
  /** The preset grant+token leg (b) revokes; its token must stop authenticating. */
  let revokedPreset: PresetGrant;
  /** The preset grant+token leg (d) disables through its client; its token must stop authenticating. */
  let disabledPreset: PresetGrant;
  /** The audience `/mcp` binds every OAuth token to, read back from the server's own discovery document. */
  let mcpAudience: string;

  const startupEvidence = {
    consoleErrors: [] as string[],
    failedRequests: [] as string[],
  };

  const serverBase = () => `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}`;
  const settingsButton = () => page.getByRole('button', { name: 'Settings', exact: true }).first();
  const apiTokensTab = () => page.getByRole('button', { name: 'API & Tokens', exact: true });
  const connectedAppsHeading = () => page.getByRole('heading', { name: 'Connected Apps' });
  const oauthClientsHeading = () => page.getByRole('heading', { name: 'OAuth Clients (Advanced)' });
  const grantRow = (grantId: number) => page.locator(`[data-testid="connected-app-row"][data-grant-id="${grantId}"]`);
  const clientRow = (clientId: string) => page.locator(`[data-testid="oauth-client-row"][data-client-id="${clientId}"]`);

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

  /** Opens Settings → API & Tokens and waits for both OAuth section headings, so the page's own sections are on screen. */
  const openConnectedAppsTab = async (): Promise<void> => {
    await settingsButton().click();
    await expect(apiTokensTab()).toBeVisible({ timeout: 15_000 });
    await apiTokensTab().click();
    await expect(connectedAppsHeading()).toBeVisible({ timeout: 15_000 });
    await expect(oauthClientsHeading()).toBeVisible({ timeout: 15_000 });
  };

  /** One real `/mcp` exchange carrying `token`; the auth middleware decides before the transport sees the body. */
  const callMcp = (token: string): Promise<Response> =>
    fetch(`${serverBase()}${MCP_RESOURCE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'connected-apps-e2e', version: '1.0.0' } },
      }),
    });

  /**
   * Registers a client through the REAL DCR endpoint the server mounts (`MCP_DCR=open`), so the preset's client is
   * a genuine registration — `createdVia` really is `dcr` and the redirect host really is the one declared here.
   */
  const registerDcrClient = async (clientName: string, port: number): Promise<RegisteredClient> => {
    const response = await fetch(`${serverBase()}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [`http://127.0.0.1:${port}/callback`],
        token_endpoint_auth_method: 'none',
      }),
    });
    const body = await response.json() as { client_id?: string };
    if (response.status !== 201 || !body.client_id) {
      throw new Error(`DCR registration of ${clientName} answered ${response.status}: ${JSON.stringify(body)}`);
    }
    console.log(`(preset) DCR registered "${clientName}" -> ${body.client_id} (HTTP ${response.status})`);
    return { clientId: body.client_id, clientName };
  };

  /**
   * Seeded here rather than through the authorization-code endpoints, which AC-268 mounts and this tree does not
   * have yet (see the file header). The rows are exactly the ones the store writes — the same hash, the same JSON
   * shapes, the same audience — so every reading below is the server's own decision over them.
   */
  const seedPresetGrant = (
    database: Database.Database,
    userId: number,
    client: RegisteredClient,
    audience: string,
  ): PresetGrant => {
    const createdAt = new Date().toISOString();
    const grantId = Number(
      database.prepare(
        'INSERT INTO oauth_grants (user_id, client_id, scopes, resource, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, client.clientId, JSON.stringify([READ_SCOPE]), audience, createdAt).lastInsertRowid,
    );

    const accessToken = `cca_${crypto.randomBytes(32).toString('hex')}`;
    database.prepare(
      `INSERT INTO access_tokens
         (user_id, kind, token_hash, token_prefix, name, grant_id, scopes, resource, expires_at, created_at)
       VALUES (?, 'oauth_access', ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      sha256Hex(accessToken),
      accessToken.slice(0, 8),
      grantId,
      JSON.stringify([READ_SCOPE]),
      audience,
      new Date(Date.now() + 3_600_000).toISOString(),
      createdAt,
    );

    console.log(`(preset) grant ${grantId} for "${client.clientName}" carries a live ${accessToken.slice(0, 8)}… token`);
    return { clientId: client.clientId, clientName: client.clientName, grantId, accessToken };
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) {
      throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
    }
    const serverPort = Number(process.env.QUAY_E2E_SERVER_PORT);
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    // Both revocations confirm through `window.confirm`; accept it so the DELETE/PATCH really run.
    page.on('dialog', (dialog) => { void dialog.accept(); });
    page.on('console', (message) => {
      if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // First run on a fresh database: create the single account, then finish onboarding. Tolerant of an existing
    // account so the spec also runs against a database another spec in the same invocation signed into.
    await navigateBounded(FIRST_LANDING, 'first-load');
    if (await page.locator('#username').count()) {
      await page.locator('#username').fill('e2euser');
      await page.locator('input[type=password]').nth(0).fill('e2epassword');
      await page.locator('input[type=password]').nth(1).fill('e2epassword');
      await page.getByRole('button', { name: 'Create Account' }).click();
      await page.getByPlaceholder('John Doe').fill('E2E User');
      await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Complete Setup' }).click();
    }
    await expect(settingsButton()).toBeVisible({ timeout: 30_000 });

    // The audience is the server's own advertised resource, not a literal this spec restates.
    const protectedResource = await fetch(`${serverBase()}/.well-known/oauth-protected-resource/mcp`);
    const protectedResourceBody = await protectedResource.json() as { resource?: string };
    if (!protectedResourceBody.resource) {
      throw new Error(
        `the server did not publish a protected-resource document (HTTP ${protectedResource.status}); `
        + 'playwright.config.ts must inject the MCP/OAuth environment for this selection',
      );
    }
    mcpAudience = protectedResourceBody.resource;
    console.log(`(preset) /mcp audience read from the server's discovery document: ${mcpAudience}`);

    revokedClient = await registerDcrClient('Preset Revoke App', serverPort);
    disabledClient = await registerDcrClient('Preset Disable App', serverPort);

    // The store rows are written through the SAME database file the running server reads, so nothing is cached
    // between the write and the server's answer. `busy_timeout` tolerates the server's own concurrent writes.
    const databasePath = path.join(process.env.QUAY_E2E_DATA_DIR ?? '', 'auth.db');
    if (!fs.existsSync(databasePath)) {
      throw new Error(`this run's database is not where playwright.config.ts put it: ${databasePath}`);
    }
    const database = new Database(databasePath);
    database.pragma('busy_timeout = 10000');
    // The owner is the account this run just created; a fresh data dir has exactly one.
    const owner = database.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
    if (!owner) {
      throw new Error('no user row exists yet, so a preset grant would have no owner');
    }
    revokedPreset = seedPresetGrant(database, owner.id, revokedClient, `${mcpAudience}`);
    disabledPreset = seedPresetGrant(database, owner.id, disabledClient, `${mcpAudience}`);
    database.close();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('lists preset connected apps, revokes one so its live token is refused, creates a manual client whose secret never survives a reload, and disables a client whose token is then refused', async () => {
    // (a) The preset grants are listed with the client name, the callback host and the scope.
    await openConnectedAppsTab();
    await expect(grantRow(revokedPreset.grantId)).toHaveCount(1, { timeout: 15_000 });
    await expect(grantRow(disabledPreset.grantId)).toHaveCount(1);
    const listedRowText = await grantRow(revokedPreset.grantId).innerText();
    console.log(
      `(a) connected-app rows = ${await page.getByTestId('connected-app-row').count()}; `
      + `row for grant ${revokedPreset.grantId} reads ${JSON.stringify(listedRowText)}`,
    );
    expect(listedRowText).toContain(revokedClient.clientName);
    expect(listedRowText).toContain('127.0.0.1');
    expect(listedRowText).toContain(READ_SCOPE);

    // (e) The two OAuth rows this seed wrote have a NULL `name`, so the PAT list used to render them as
    // "Unnamed token". They are now out of that list entirely and live in the advanced, read-only section below
    // it — collapsed by default, so a troubleshooting list never buries the user's own tokens.
    const patRows = page.getByTestId('access-token-row');
    const oauthToggle = page.getByTestId('oauth-tokens-toggle');
    const oauthContent = page.getByTestId('oauth-tokens-content');
    await expect(oauthToggle).toBeVisible({ timeout: 15_000 });
    await expect(oauthToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(oauthContent).toHaveAttribute('data-state', 'closed');
    const patRowCount = await patRows.count();
    const pageText = await page.locator('body').innerText();
    console.log(
      `(e) PAT rows = ${patRowCount}; the advanced OAuth section is collapsed `
      + `(aria-expanded=${await oauthToggle.getAttribute('aria-expanded')}, data-state=${await oauthContent.getAttribute('data-state')}); `
      + `page text contains "Unnamed token" = ${pageText.includes('Unnamed token')}`,
    );
    // The seeded OAuth tokens are in neither the PAT list nor the "Unnamed token" label that list used to show.
    expect(patRowCount).toBe(0);
    expect(pageText).not.toContain('Unnamed token');
    // DoD evidence: the PAT list empty while two OAuth tokens exist, with the advanced section still collapsed.
    // The settings pane scrolls independently of the document, so bring the section into view; a fullPage shot
    // expands only the document, leaving the pane at its current scroll.
    await oauthToggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/gap-settings-access-tokens-dod-oauth-collapsed.png' });

    // Expanded, the section shows the same two rows, each named by its grant's client — the identity the PAT
    // list could never give them — and neither carries a Revoke control (revocation is the grant's, above).
    await oauthToggle.click();
    await expect(oauthToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(oauthContent).toHaveAttribute('data-state', 'open');
    const oauthRows = page.getByTestId('oauth-token-row');
    await expect(oauthRows).toHaveCount(2, { timeout: 15_000 });
    const oauthRowText = (await oauthRows.allInnerTexts()).join('\n');
    console.log(`(e) expanded: ${await oauthRows.count()} OAuth token rows -> ${JSON.stringify(oauthRowText)}`);
    expect(oauthRowText).toContain(revokedClient.clientName);
    expect(oauthRowText).toContain(disabledClient.clientName);
    expect(await oauthRows.first().getByRole('button', { name: 'Revoke' }).count()).toBe(0);
    // DoD evidence: the expanded read-only section, each OAuth token named by its grant's client.
    await oauthRows.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/gap-settings-access-tokens-dod-oauth-expanded.png' });
    await oauthToggle.click();
    await expect(oauthContent).toHaveAttribute('data-state', 'closed');

    // (b) Positive control first: the preset token really authenticates against `/mcp`.
    const beforeRevoke = await callMcp(revokedPreset.accessToken);
    await beforeRevoke.text();
    const rowsBeforeRevoke = await page.getByTestId('connected-app-row').count();

    await grantRow(revokedPreset.grantId).getByRole('button', { name: 'Revoke' }).click();
    await expect(grantRow(revokedPreset.grantId)).toHaveCount(0, { timeout: 15_000 });
    const rowsAfterRevoke = await page.getByTestId('connected-app-row').count();

    const afterRevoke = await callMcp(revokedPreset.accessToken);
    await afterRevoke.text();
    console.log(
      `(b) /mcp with the preset token -> ${beforeRevoke.status} before revoke, ${afterRevoke.status} after; `
      + `connected-app rows ${rowsBeforeRevoke} -> ${rowsAfterRevoke}`,
    );
    expect(beforeRevoke.status).toBe(200);
    expect(afterRevoke.status).toBe(401);

    // The row is gone from the SERVER's list, not merely from local state: a fresh document re-reads it.
    await navigateBounded(APP_SHELL_LANDING, 'replay');
    await openConnectedAppsTab();
    await expect(grantRow(revokedPreset.grantId)).toHaveCount(0, { timeout: 15_000 });
    await expect(grantRow(disabledPreset.grantId)).toHaveCount(1);
    console.log(
      `(b) after reload: rows for the revoked grant = ${await grantRow(revokedPreset.grantId).count()}, `
      + `for the untouched grant = ${await grantRow(disabledPreset.grantId).count()}`,
    );

    // (c) A manual client created through the form: 201, a one-time secret, and nothing left after a reload.
    const manualClientName = `Manual App ${Date.now()}`;
    await page.getByRole('button', { name: 'New Client', exact: true }).click();
    await page.getByTestId('oauth-client-name-input').fill(manualClientName);
    await page.getByTestId('oauth-client-redirect-input').fill('http://127.0.0.1:5173/cb');
    const [createResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/oauth/clients')),
      page.getByTestId('oauth-client-create-submit').click(),
    ]);
    const createBody = await createResponse.json() as { client_id: string; client_secret: string };
    const secret = (await page.getByTestId('new-oauth-client-secret').innerText()).trim();
    const manualClientId = createBody.client_id;
    console.log(
      `(c) POST /api/oauth/clients -> ${createResponse.status()}; client_id=${manualClientId}; `
      + `the alert shows the same secret as the response = ${secret === createBody.client_secret}`,
    );
    expect(createResponse.status()).toBe(201);
    expect(secret).toBe(createBody.client_secret);
    expect(secret.length).toBeGreaterThan(0);

    await navigateBounded(APP_SHELL_LANDING, 'replay');
    await openConnectedAppsTab();
    const clientRowText = await clientRow(manualClientId).innerText();
    const documentContent = await page.content();
    const documentText = await page.locator('body').innerText();
    const storageDump = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    const contentHits = documentContent.split(secret).length - 1;
    const textHits = documentText.split(secret).length - 1;
    const localHits = storageDump.local.split(secret).length - 1;
    const sessionHits = storageDump.session.split(secret).length - 1;
    console.log(
      `(c) after reload: secret hits in content=${contentHits}, body.innerText=${textHits}, `
      + `localStorage=${localHits}, sessionStorage=${sessionHits}; `
      + `the client's row reads ${JSON.stringify(clientRowText)}`,
    );
    expect(contentHits).toBe(0);
    expect(textHits).toBe(0);
    expect(localHits).toBe(0);
    expect(sessionHits).toBe(0);
    expect(clientRowText).toContain(manualClientName);
    expect(clientRowText).toContain('127.0.0.1');
    expect(clientRowText).not.toContain(secret);

    // (d) Disabling a client really rejects its grant's token on the next `/mcp` call.
    const beforeDisable = await callMcp(disabledPreset.accessToken);
    await beforeDisable.text();
    await clientRow(disabledClient.clientId).getByRole('button', { name: 'Disable' }).click();
    await expect(clientRow(disabledClient.clientId)).toContainText('Disabled', { timeout: 15_000 });
    const afterDisable = await callMcp(disabledPreset.accessToken);
    await afterDisable.text();
    console.log(
      `(d) /mcp with the client's grant token -> ${beforeDisable.status} before disabling, ${afterDisable.status} after; `
      + `the client's row reads ${JSON.stringify(await clientRow(disabledClient.clientId).innerText())}`,
    );
    expect(beforeDisable.status).toBe(200);
    expect(afterDisable.status).toBe(401);

    // No untranslated i18n literal anywhere on the page — both new sections included.
    const finalText = await page.locator('body').innerText();
    expect(finalText).not.toMatch(UNTRANSLATED_KEY);
  });
});
