import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import { awaitClientMounted, warmClientStartup, type RequestFailure } from './support/client-startup-warmup';

/**
 * The architecture tab's standalone page, in a real browser.
 *
 * WHY THIS FILE EXISTS. The standalone route is a second DOCUMENT, so every
 * claim about it is a claim about two live pages sharing one browser context:
 *
 *  · the page renders no workspace shell and its drawing host IS the viewport;
 *  · a pin made in the standalone page reaches the workspace tab's Adjusted
 *    count through localStorage + the `storage` event, within a second;
 *  · "Put in chat input" in the standalone page lands in the workspace tab's
 *    composer and switches it to Chat;
 *  · with no workspace tab answering, the same action copies to the clipboard;
 *  · a `?entity=` link opens on that entity, selected and centred.
 *
 * THE FIXTURE is the same small three-entity `.archguard` tree the sibling
 * architecture criteria use. The session's own user text names the seeds, which
 * is what the server's extractor resolves into the neighbourhood.
 *
 * THE CONTROL ARM removes `BroadcastChannel` from the standalone page. The same
 * action must then leave the workspace composer EMPTY while still putting the
 * text on the clipboard — a reading that only stays green because the message
 * actually travelled, not because the click did nothing.
 */

const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

// One case carries every leg of the criterion (open, two-page sync, send, the
// control arm, the clipboard fallback and the deep link) so the fixture boots
// once. Several legs are deliberately slow (the 1.5 s ack timeout occurs twice
// and the control arm waits 2 s), so the 60 s per-case default is not the right
// budget; the file's own SPEC_BUDGET_MS entry is the run ceiling.
test.describe.configure({ timeout: 180_000 });

const VIEWPORT_PC = { width: 1440, height: 765 };

const USERNAME = 'architecture-standalone-e2e';
const PASSWORD = 'architecture-standalone-e2e-pass';
const WORKSPACE_DIR = 'architecture-standalone-workspace';

const SEED_NAME = 'Alpha';
const SEED_ID = 'src/alpha/alpha.ts.Alpha';
const SECOND_ID = 'src/alpha/beta.ts.Beta';
const THIRD_ID = 'src/beta/gamma.ts.Gamma';

/** The DoD's screenshots land here (git-ignored). */
const SHOTS_DIR = path.resolve(process.cwd(), 'tmp', 'architecture-standalone');

const SEL = {
  panel: '[data-architecture-panel]',
  graphRoot: '[data-architecture-plantuml-graph]',
  host: '[data-architecture-plantuml]',
  node: '.uml-node[data-entity-id]',
  openInNewTab: '[data-architecture-open-in-new-tab]',
  back: '[data-architecture-standalone-back]',
  inspectorPin: '[data-architecture-inspector-pin]',
  inspectorPut: '[data-architecture-inspector-put-in-chat]',
  curationToggle: '[data-architecture-curation-manager-toggle]',
  curationRestorePins: '[data-architecture-curation-restore-group="pins"]',
  composer: 'textarea[data-slot="prompt-input-textarea"]',
  chatTab: '[data-workspace-tab="chat"][aria-current="true"]',
} as const;

/* ── the fixture ─────────────────────────────────────────────────────────────────────────── */

type FixtureEntity = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly kind: 'class' | 'interface';
  readonly parents: readonly string[];
};

const ENTITIES: readonly FixtureEntity[] = [
  { id: SEED_ID, name: 'Alpha', file: 'src/alpha/alpha.ts', kind: 'class', parents: [] },
  { id: SECOND_ID, name: 'Beta', file: 'src/alpha/beta.ts', kind: 'class', parents: [SEED_ID] },
  { id: THIRD_ID, name: 'Gamma', file: 'src/beta/gamma.ts', kind: 'interface', parents: [SECOND_ID] },
];

const SCOPE_KEY = 'scope-src';
const ARCH_JSON_HASH = 'b7c1f0d4b8e29365f0d4b8e29365a7c1f0d4b8e29365a7c1f0d4b8e29365a7c2';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFixture(workspaceDir: string): void {
  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  for (const entity of ENTITIES) {
    (fileToIds[entity.file] ??= []).push(entity.id);
    (nameToIds[entity.name] ??= []).push(entity.id);
    idToFile[entity.id] = entity.file;
    idToName[entity.id] = entity.name;
    dependencies[entity.id] ??= [];
    dependents[entity.id] ??= [];
  }
  for (const entity of ENTITIES) {
    for (const parent of entity.parents) {
      dependencies[parent].push(entity.id);
      dependents[entity.id].push(parent);
    }
  }

  writeJson(path.join(workspaceDir, '.archguard', 'query', 'manifest.json'), {
    version: '1.0',
    generatedAt,
    globalScopeKey: SCOPE_KEY,
    scopes: [{ key: SCOPE_KEY, label: 'src (typescript)', language: 'typescript', sources: [srcDir] }],
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch-index.json'), {
    version: '1.0',
    language: 'typescript',
    archJsonHash: ARCH_JSON_HASH,
    generatedAt,
    fileToIds,
    nameToIds,
    idToFile,
    idToName,
    dependencies,
    dependents,
  });
  writeJson(path.join(workspaceDir, '.archguard', 'query', SCOPE_KEY, 'arch.json'), {
    version: '1.0',
    language: 'typescript',
    entities: ENTITIES.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.kind,
      isAbstract: false,
      members: entity.kind === 'interface'
        ? [{ name: 'id', type: 'property', visibility: 'public', fieldType: 'string' }]
        : [
          { name: 'constructor', type: 'constructor', visibility: 'public', parameters: [] },
          { name: 'run', type: 'method', visibility: 'public', parameters: [], returnType: 'void' },
        ],
    })),
  });
}

/* ── the server's own faces ──────────────────────────────────────────────────────────────── */

async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', {
      headers: { Authorization: `Bearer ${registered.token}` },
    });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(
      `could not create or sign in as ${USERNAME}: register ${register.status()} ${JSON.stringify(registered)}, `
        + `login ${login.status()} ${JSON.stringify(loggedIn)}`,
    );
  }
  return loggedIn.token;
}

async function armScenario(api: APIRequestContext, projectPath: string): Promise<string> {
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: {
      title: 'Architecture standalone page',
      userText: `Please review \`${SEED_NAME}\` and \`Beta\` before the refactor.`,
    },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [SEED_NAME] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return sessionId;
}

async function readProject(
  api: APIRequestContext,
  workspace: string,
): Promise<{ projectId: string; displayName: string }> {
  const response = await api.get('/api/projects');
  const body = await response.json().catch(() => null);
  const projects: unknown = Array.isArray(body) ? body : (body as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) throw new Error(`/api/projects returned ${JSON.stringify(body).slice(0, 300)}`);
  const project = projects.find((candidate: { path?: string; fullPath?: string }) =>
    candidate.path === workspace || candidate.fullPath === workspace);
  if (project === undefined) throw new Error(`no project row for ${workspace}`);
  return {
    projectId: String((project as { projectId: string }).projectId),
    displayName: String((project as { displayName: string }).displayName),
  };
}

/* ── page setup ─────────────────────────────────────────────────────────────────────────── */

type StartupEvidence = {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: RequestFailure[];
  warmup: null;
};

const startupEvidence: StartupEvidence = {
  pageErrors: [],
  consoleErrors: [],
  requestFailures: [],
  warmup: null,
};

let warmClientPromise: Promise<unknown> | null = null;

function attachEvidence(page: Page): void {
  page.on('pageerror', (error) => startupEvidence.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request_) => {
    startupEvidence.requestFailures.push({
      url: request_.url(),
      failureText: request_.failure()?.errorText ?? 'no error text',
    });
  });
}

async function openContext(browser: Browser, baseURL: string, token: string): Promise<BrowserContext> {
  const dataDir = process.env.QUAY_E2E_DATA_DIR;
  if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR');
  warmClientPromise ??= warmClientStartup(baseURL, dataDir);

  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT_PC,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(
    ({ authKey, authToken }: { authKey: string; authToken: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', 'en');
    },
    { authKey: 'auth-token', authToken: token },
  );
  return context;
}

async function newEvidencePage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  attachEvidence(page);
  return page;
}

const ARCHITECTURE_TAB_LANDING = '[role="tab"][data-workspace-tab="architecture"]';

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await page.waitForTimeout(ms);
}

async function enterArchitecture(page: Page): Promise<void> {
  const tab = page.locator(ARCHITECTURE_TAB_LANDING);
  await expect(tab, 'the fixture project offers the architecture tab').toBeVisible({ timeout: 30_000 });
  await tab.first().click();
  await expect(page.locator(`[data-workspace-view="architecture"] ${SEL.panel}`)).toBeVisible({ timeout: 30_000 });
  await waitForDiagram(page);
}

async function waitForDiagram(page: Page): Promise<void> {
  await page.waitForFunction(
    ({ root, host, node }) => {
      const graphRoot = document.querySelector(root);
      const hostElement = document.querySelector(host);
      return Number(graphRoot?.getAttribute('data-architecture-visible-nodes') ?? '0') > 0
        && (hostElement?.querySelectorAll(node).length ?? 0) > 0;
    },
    { root: SEL.graphRoot, host: SEL.host, node: SEL.node },
    { timeout: 40_000 },
  );
  await settle(page, 500);
}

function entityBox(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator(`.uml-node[data-entity-id$=".${name}"]`).first();
}

/** Save a screenshot only when the caller asked for them; the readings are the evidence. */
async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

/* ── the readings ──────────────────────────────────────────────────────────────────────── */

type StandaloneGeometry = {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly host: { width: number; height: number } | null;
  readonly workspaceTabs: number;
  readonly appShells: number;
  readonly backEntry: number;
};

async function readStandaloneGeometry(page: Page): Promise<StandaloneGeometry> {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel.host);
    const rect = host?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      host: rect === undefined ? null : { width: rect.width, height: rect.height },
      workspaceTabs: document.querySelectorAll('[data-workspace-tab]').length,
      appShells: document.querySelectorAll('[data-app-shell]').length,
      backEntry: document.querySelectorAll(sel.back).length,
    };
  }, SEL);
}

async function readComposer(page: Page): Promise<string> {
  return page.locator(SEL.composer).inputValue();
}

async function clearComposer(page: Page): Promise<void> {
  const composer = page.locator(SEL.composer);
  if ((await composer.count()) === 0) return;
  await composer.fill('');
  await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe('');
}

/** Restore any pin this run made, through the same manager a reader would use. */
async function restorePins(page: Page): Promise<void> {
  const toggle = page.locator(SEL.curationToggle);
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute('data-architecture-curation-count')) === '0') return;
  await toggle.first().click();
  const restore = page.locator(SEL.curationRestorePins);
  if ((await restore.count()) > 0) await restore.first().click();
  await expect.poll(
    () => toggle.getAttribute('data-architecture-curation-count'),
    { timeout: 10_000 },
  ).toBe('0');
}

/* ── the run ───────────────────────────────────────────────────────────────────────────── */

let baseURL = '';
let token = '';
let sessionId = '';
let workspace = '';

test.beforeAll(async () => {
  baseURL = test.info().project.use.baseURL ?? '';
  if (baseURL === '') throw new Error('playwright.config.ts must give this project a baseURL');
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error(
      'playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection '
        + '(the spec is listed in DEBUG_AGENT_SPEC_FILES)',
    );
  }
  workspace = path.join(fixtureHome, WORKSPACE_DIR);
  writeFixture(workspace);

  const bootstrap = await request.newContext({ baseURL });
  token = await createAccount(bootstrap);
  await bootstrap.dispose();

  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  sessionId = await armScenario(api, workspace);
  await readProject(api, workspace);
  await api.dispose();

  console.log(`[architecture-standalone] session=${sessionId} workspace=${workspace}`);
});

test('two pages share state, send to chat, and fall back to the clipboard', async ({ browser }) => {
  const context = await openContext(browser, baseURL, token);
  try {
    // 1. The main workspace page, on the architecture tab.
    const main = await newEvidencePage(context);
    await main.goto(`/session/${sessionId}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await awaitClientMounted(main, ARCHITECTURE_TAB_LANDING, 25_000, startupEvidence);
    await enterArchitecture(main);
    await entityBox(main, SEED_NAME).click();
    await shot(main, '01-main-architecture');

    // 2. "Open in new tab" — the real button, the real route.
    const [standalone] = await Promise.all([
      context.waitForEvent('page'),
      main.locator(SEL.openInNewTab).first().click(),
    ]);
    attachEvidence(standalone);
    await standalone.waitForLoadState('domcontentloaded');
    await awaitClientMounted(standalone, SEL.panel, 25_000, startupEvidence);
    await waitForDiagram(standalone);

    const openedUrl = new URL(standalone.url());
    console.log(`[architecture-standalone] opened=${openedUrl.pathname}${openedUrl.search}`);
    expect(openedUrl.pathname).toBe(`/session/${sessionId}/architecture`);
    expect(openedUrl.searchParams.get('view')).toBe('class');
    expect(openedUrl.searchParams.get('scope')).not.toBeNull();
    expect(openedUrl.searchParams.get('detail')).not.toBeNull();

    // The drawing host IS the viewport, and no workspace shell is mounted.
    const geometry = await readStandaloneGeometry(standalone);
    console.log(`[architecture-standalone] geometry=${JSON.stringify(geometry)}`);
    expect(geometry.host, 'the standalone drawing host must have a box').not.toBeNull();
    expect(Math.abs((geometry.host as { width: number }).width - geometry.innerWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs((geometry.host as { height: number }).height - geometry.innerHeight)).toBeLessThanOrEqual(1);
    expect(geometry.workspaceTabs).toBe(0);
    expect(geometry.appShells).toBe(0);
    expect(geometry.backEntry).toBe(1);
    await shot(standalone, '02-standalone-page');

    // 3. Pin in the standalone page; the workspace tab's Adjusted count follows.
    const entityId = await entityBox(standalone, SEED_NAME).getAttribute('data-entity-id');
    expect(entityId, 'the fixture entity must carry an id').not.toBeNull();
    await entityBox(standalone, SEED_NAME).click({ timeout: 15_000 });
    await standalone.locator(SEL.inspectorPin).first().click({ timeout: 15_000 });
    await expect.poll(
      () => main.locator(SEL.curationToggle).getAttribute('data-architecture-curation-count'),
      { timeout: 1000 },
    ).toBe('1');
    await shot(main, '03-main-adjusted-count');

    // 4. Send the selection to the workspace chat.
    await standalone.locator(SEL.inspectorPut).first().click();
    await expect(main.locator(SEL.chatTab), 'the workspace switches to Chat').toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => readComposer(main), { timeout: 15_000 }).toContain('Alpha');
    const composed = await readComposer(main);
    console.log(`[architecture-standalone] composed=${JSON.stringify(composed.slice(0, 300))}`);
    await shot(main, '04-main-chat-composer');

    // 5. Restore the reader's state: empty the draft and undo the pin.
    await clearComposer(main);
    await enterArchitecture(main);
    await restorePins(main);

    // The control arm reads the workspace composer, so the workspace tab has to
    // be showing it.
    await main.locator('[role="tab"][data-workspace-tab="chat"]').first().click();
    await expect(main.locator(SEL.composer)).toBeVisible({ timeout: 15_000 });

    // 6. Control arm: remove BroadcastChannel from a standalone page. The SAME
    //    action must leave the workspace composer empty while still copying.
    const control = await newEvidencePage(context);
    await control.addInitScript(() => {
      delete (window as unknown as { BroadcastChannel?: unknown }).BroadcastChannel;
    });
    await control.goto(`/session/${sessionId}/architecture`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await awaitClientMounted(control, SEL.panel, 25_000, startupEvidence);
    await waitForDiagram(control);
    await control.evaluate(() => navigator.clipboard.writeText('control-arm-sentinel'));
    await entityBox(control, SEED_NAME).click();
    await control.locator(SEL.inspectorPut).first().click();
    await control.waitForTimeout(2_000);

    const controlClipboard = await control.evaluate(() => navigator.clipboard.readText());
    const composerAfterControl = await readComposer(main);
    console.log(`[architecture-standalone] control composer=${JSON.stringify(composerAfterControl)} clipboard=${JSON.stringify(controlClipboard.slice(0, 200))}`);
    expect(composerAfterControl, 'without the channel the composer must stay empty (the reading goes red)').toBe('');
    expect(controlClipboard, 'the action still ran: the fallback copied the text').toContain('Alpha');
    await shot(control, '05-control-no-broadcast');
    await control.close();

    // 7. Close the workspace tab and repeat: the clipboard is the only receiver.
    await main.close();
    await standalone.bringToFront();
    await standalone.locator(SEL.inspectorPut).first().click();
    await expect.poll(
      () => standalone.evaluate(() => navigator.clipboard.readText()),
      { timeout: 6_000 },
    ).toContain('Alpha');
    const fallbackClipboard = await standalone.evaluate(() => navigator.clipboard.readText());
    console.log(`[architecture-standalone] fallback clipboard=${JSON.stringify(fallbackClipboard.slice(0, 200))}`);
    await shot(standalone, '06-clipboard-fallback');

    // 8. The `?entity=` deep link opens with that entity selected and centred.
    const deepLink = await newEvidencePage(context);
    await deepLink.goto(
      `/session/${sessionId}/architecture?entity=${encodeURIComponent(entityId as string)}&mode=neighbourhood`,
      { waitUntil: 'domcontentloaded', timeout: 20_000 },
    );
    await awaitClientMounted(deepLink, SEL.panel, 25_000, startupEvidence);
    await waitForDiagram(deepLink);
    await deepLink.waitForFunction(
      (id) => document.querySelector(`[data-architecture-focus-target="${id}"]`) !== null,
      entityId,
      { timeout: 15_000 },
    );
    await expect(deepLink.locator('[data-architecture-inspector-put-in-chat]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await shot(deepLink, '07-deep-link-entity');
    await deepLink.close();

    const elapsed = Date.now() - RUN_STARTED_AT;
    console.log(`[architecture-standalone] elapsed=${elapsed}ms`);
  } finally {
    await context.close();
  }
});
